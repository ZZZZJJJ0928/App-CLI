import path from 'node:path';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {privateDirectory} from './authorization.mjs';
import {encode, requireCondition} from './protocol.mjs';

// Caller must hold the owner's OS process lock for this database's lifetime.
export class Ledger {
  constructor(directory, {eventRetention = 1000, maxTasks = 10000, maxBytes = 512 * 1024 * 1024} = {}) {
    privateDirectory(directory);
    this.retention = eventRetention; this.maxTasks = maxTasks; this.maxBytes = maxBytes;
    requireCondition(Number.isSafeInteger(maxTasks) && maxTasks > 0 && Number.isSafeInteger(maxBytes) && maxBytes > 0, 'CONFIGURATION_INVALID');
    requireCondition(Number.isSafeInteger(eventRetention) && eventRetention >= 1 && eventRetention <= 10000);
    const file = path.join(directory, 'ledger.sqlite');
    const marker = path.join(directory, 'authority.json');
    this.marker = marker; this.directory = directory;
    const previous = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker)) : null;
    requireCondition(!previous || previous.schema_version === 1 && fs.existsSync(file), 'LEDGER_RECOVERY_REQUIRED');
    if (fs.existsSync(file)) requireCondition(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'CONFIGURATION_INVALID');
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    try {
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('epoch',0);
      INSERT OR IGNORE INTO metadata VALUES ('commit_sequence',0);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL,
        request_key TEXT NOT NULL, intent TEXT NOT NULL, app TEXT NOT NULL, command TEXT NOT NULL,
        request TEXT NOT NULL, grant_ref TEXT NOT NULL, resource_digest TEXT NOT NULL,
        grant_revision INTEGER NOT NULL, expires INTEGER NOT NULL, side_effect TEXT NOT NULL,
        status TEXT NOT NULL, reason TEXT, data TEXT, effect INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL,
        UNIQUE(principal,owner,request_key));
      CREATE TABLE IF NOT EXISTS events (task TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task,sequence));`);
    const version = this.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    requireCondition(!version || version.value === 1, 'LEDGER_VERSION_UNSUPPORTED');
    this.db.exec("INSERT OR IGNORE INTO metadata VALUES ('schema_version',1)");
    this.transaction(() => {
      const current = this.db.prepare("SELECT value FROM metadata WHERE key='epoch'").get().value;
      const sequence = this.db.prepare("SELECT value FROM metadata WHERE key='commit_sequence'").get().value;
      requireCondition(!previous || current >= previous.epoch && sequence >= (previous.commit_sequence ?? 0), 'LEDGER_RECOVERY_REQUIRED');
      this.db.exec("UPDATE metadata SET value=value+1 WHERE key='epoch'");
      this.epoch = this.db.prepare("SELECT value FROM metadata WHERE key='epoch'").get().value;
      requireCondition(Number.isSafeInteger(this.epoch), 'EXECUTION_EPOCH_EXHAUSTED');
      for (const row of this.db.prepare("SELECT * FROM tasks WHERE status IN ('pending','running')").all()) {
        this.update(row.id, {status: row.effect ? 'uncertain' : 'blocked', reason: 'EXECUTOR_RESTARTED'});
        this.event(row.id, 'gap', {reason: 'executor_restarted'});
      }
    });
    } catch (error) {this.db.close(); throw error;}
  }
  persistAuthority() {
    const temporary = this.marker + '.tmp';
    const sequence = this.db.prepare("SELECT value FROM metadata WHERE key='commit_sequence'").get().value;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {fs.writeFileSync(fd, JSON.stringify({schema_version: 1, epoch: this.epoch, commit_sequence: sequence})); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(temporary, this.marker);
    const dirfd = fs.openSync(this.directory, 'r'); try {fs.fsyncSync(dirfd);} finally {fs.closeSync(dirfd);}
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = fn();
      this.db.exec("UPDATE metadata SET value=value+1 WHERE key='commit_sequence'");
      this.db.exec('COMMIT'); committed = true;
      // Publish the independent high-water mark before acknowledging admission
      // or returning from beforeEffect. A same-epoch stale backup must not run.
      this.persistAuthority(); return result;
    } catch (error) {if (!committed) this.db.exec('ROLLBACK'); throw error; }
  }
  find(grant) {
    return this.db.prepare('SELECT * FROM tasks WHERE principal=? AND owner=? AND request_key=?')
      .get(grant.principal, grant.owner, grant.request_key);
  }
  get(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
  admit(request, grant, intent, resourceDigest) {
    return this.transaction(() => {
      const previous = this.find(grant);
      if (previous) {
        requireCondition(previous.intent === intent && previous.resource_digest === resourceDigest, 'REQUEST_KEY_CONFLICT');
        return {row: previous, fresh: false};
      }
      // Refuse new work at capacity without ever evicting idempotency records.
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
      const pages = this.db.prepare('PRAGMA page_count').get().page_count;
      const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
      requireCondition(count < this.maxTasks && pages * pageSize + Buffer.byteLength(JSON.stringify(request)) < this.maxBytes, 'LEDGER_CAPACITY_EXCEEDED');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO tasks(id,principal,owner,request_key,intent,app,command,request,grant_ref,
        resource_digest,grant_revision,expires,side_effect,status,epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`)
        .run(id, grant.principal, grant.owner, grant.request_key, intent, request.app, request.command,
          JSON.stringify(request), request.authorization_ref, resourceDigest, grant.revision,
          grant.execution_expires_ms, grant.side_effect, this.epoch);
      this.event(id, 'admitted', {});
      return {row: this.get(id), fresh: true};
    });
  }
  update(id, fields) {
    const allowed = new Set(['status', 'reason', 'data', 'effect', 'grant_ref', 'grant_revision', 'expires', 'epoch']);
    requireCondition(Object.keys(fields).length > 0 && Object.keys(fields).every(key => allowed.has(key)));
    this.db.prepare(`UPDATE tasks SET ${Object.keys(fields).map(key => `${key}=?`).join(',')} WHERE id=?`)
      .run(...Object.values(fields), id);
  }
  event(id, type, payload) {
    const body = encode(payload, 2048).toString();
    requireCondition(/^[a-z][a-z0-9_.-]{0,63}$/u.test(type));
    this.db.prepare('UPDATE tasks SET sequence=sequence+1 WHERE id=?').run(id);
    const {sequence} = this.get(id);
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id, sequence, type, body);
    this.db.prepare('DELETE FROM events WHERE task=? AND sequence<=?').run(id, sequence - this.retention);
  }
  events(row, cursor, limit = 100) {
    const earliest = this.db.prepare('SELECT MIN(sequence) AS first FROM events WHERE task=?').get(row.id).first;
    const events = this.db.prepare('SELECT sequence,type,payload FROM events WHERE task=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(row.id, cursor, limit).map(event => ({...event, payload: JSON.parse(event.payload)}));
    return {events, cursor: events.at(-1)?.sequence ?? cursor,
      gap: cursor > row.sequence || (earliest !== null && cursor < earliest - 1)};
  }
  close() { this.db.close(); }
}
