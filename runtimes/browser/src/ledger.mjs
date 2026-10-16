import path from 'node:path';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {privateDirectory} from './authorization.mjs';
import {parseIdentity} from './identity.mjs';
import {RING} from './anchor.mjs';
import {digest, encode, requireCondition, RuntimeError, TERMINAL} from './protocol.mjs';

export const SCHEMA_VERSION = 2;
const ZERO = '0'.repeat(64);
const HOUR = 3600_000;
export const DEFAULT_POLICY = Object.freeze({
  // Placeholders until shadow measurement derives deployed values.
  maxOpenEpochMs: 24 * HOUR, maxOfflineMs: 7 * 24 * HOUR, rotateTerminalRows: 50_000, maxAttempts: 3,
});
const TASK_COLUMNS = [
  ['generation', 'INTEGER NOT NULL DEFAULT 1'], ['request_epoch', 'INTEGER NOT NULL DEFAULT 0'],
  ['recovery_class', "TEXT NOT NULL DEFAULT 'legacy'"], ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
  ['dispatch', 'TEXT'], ['dispatch_seq', 'INTEGER'], ['token', 'TEXT'],
  ['terminal_revision', 'INTEGER NOT NULL DEFAULT 0'], ['result_digest', 'TEXT'], ['ack', 'TEXT'],
  ['resolution', 'TEXT'], ['created_ms', 'INTEGER NOT NULL DEFAULT 0'], ['finished_ms', 'INTEGER'],
];
const UPDATABLE = new Set(['status', 'reason', 'data', 'effect', 'grant_ref', 'grant_revision', 'expires', 'epoch',
  'attempt', 'dispatch', 'dispatch_seq', 'token', 'ack', 'resolution']);

export class OperationRetired extends RuntimeError {
  constructor(reason) {super('OPERATION_RETIRED'); this.reason = reason;}
}

// Caller must hold the owner's OS process lock for this database's lifetime.
export class Ledger {
  constructor(directory, {eventRetention = 1000, maxTasks = 0, maxBytes = 512 * 1024 * 1024, clock = Date.now, policy = {}} = {}) {
    privateDirectory(directory);
    this.retention = eventRetention; this.maxTasks = maxTasks; this.maxBytes = maxBytes; this.clock = clock;
    this.policy = {...DEFAULT_POLICY, ...policy}; this.recovered = false; this.anchorVerified = false;
    requireCondition(Number.isSafeInteger(maxTasks) && maxTasks >= 0 && Number.isSafeInteger(maxBytes) && maxBytes > 0, 'CONFIGURATION_INVALID');
    requireCondition(Number.isSafeInteger(eventRetention) && eventRetention >= 1 && eventRetention <= 10000);
    const file = path.join(directory, 'ledger.sqlite');
    const marker = path.join(directory, 'authority.json');
    this.marker = marker; this.directory = directory; this.file = file;
    const previous = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker)) : null;
    requireCondition(!previous || [1, SCHEMA_VERSION].includes(previous.schema_version) && fs.existsSync(file), 'LEDGER_RECOVERY_REQUIRED');
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
      requireCondition(!version || [1, SCHEMA_VERSION].includes(version.value), 'LEDGER_VERSION_UNSUPPORTED');
      this.transaction(() => {
        if (!version || version.value === 1) this.migrate(Boolean(version));
        const current = this.meta('epoch'), sequence = this.meta('commit_sequence');
        requireCondition(!previous || current >= previous.epoch && sequence >= (previous.commit_sequence ?? 0), 'LEDGER_RECOVERY_REQUIRED');
        this.db.exec("UPDATE metadata SET value=value+1 WHERE key='epoch'");
        this.epoch = this.meta('epoch');
        requireCondition(Number.isSafeInteger(this.epoch), 'EXECUTION_EPOCH_EXHAUSTED');
        for (const row of this.db.prepare("SELECT * FROM tasks WHERE status IN ('pending','running')").all()) {
          // An unreleased dispatch reservation is provably undispatched. Its
          // token is voided in recover() after the anchor has been consulted.
          const unknown = row.effect || row.dispatch === 'released';
          this.update(row.id, {status: unknown ? 'uncertain' : 'blocked', reason: 'EXECUTOR_RESTARTED'});
          this.event(row.id, 'gap', {reason: 'executor_restarted'});
        }
      });
    } catch (error) {this.db.close(); throw error;}
  }
  migrate(fromV1) {
    const columns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
    for (const [name, type] of TASK_COLUMNS) if (!columns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS epoch_seals (epoch INTEGER PRIMARY KEY, reason TEXT NOT NULL, sealed_ms INTEGER NOT NULL, drained_digest TEXT);
      CREATE TABLE IF NOT EXISTS schedule_fences (schedule_id TEXT PRIMARY KEY, creation_epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL, fired_through INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS anchor_state (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL,
        seq INTEGER NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_release (id INTEGER PRIMARY KEY CHECK (id = 1), task TEXT NOT NULL,
        operation_id TEXT NOT NULL, attempt INTEGER NOT NULL, seq INTEGER NOT NULL, previous_digest TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, mode TEXT NOT NULL,
        local_seq INTEGER NOT NULL, anchor_seq INTEGER, affected INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_epoch ON tasks(request_epoch, status);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      INSERT OR IGNORE INTO anchor_state VALUES (1, 1, 0, '${ZERO}');`);
    const now = this.clock();
    for (const [key, value] of [['generation', 1], ['open_epoch', 1], ['open_since_ms', now], ['draining_epoch', 0],
      ['draining_since_ms', 0], ['sealed_through', 0], ['schedule_floor_ms', 0], ['authorization_generation', 1],
      ['bytes_floor', 0]]) this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run(key, value);
    // Every v1 request key belongs to the sealed legacy epoch 0: existing tasks
    // remain controllable, while an absent legacy key can never be admitted.
    this.db.prepare("INSERT OR IGNORE INTO epoch_seals VALUES (0,'legacy',?,NULL)").run(now);
    if (fromV1) this.db.exec("UPDATE metadata SET value=2 WHERE key='schema_version'");
    else this.db.exec(`INSERT INTO metadata VALUES ('schema_version',${SCHEMA_VERSION})`);
  }
  meta(key) {return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;}
  setMeta(key, value) {
    requireCondition(Number.isSafeInteger(value), 'EXECUTION_EPOCH_EXHAUSTED');
    this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(value, key);
  }
  persistAuthority() {
    const temporary = this.marker + '.tmp';
    const sequence = this.meta('commit_sequence');
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {fs.writeFileSync(fd, JSON.stringify({schema_version: SCHEMA_VERSION, epoch: this.epoch, commit_sequence: sequence})); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(temporary, this.marker);
    const dirfd = fs.openSync(this.directory, 'r'); try {fs.fsyncSync(dirfd);} finally {fs.closeSync(dirfd);}
  }
  transaction(fn) {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false; this.depth = 1;
    try {
      const result = fn();
      this.db.exec("UPDATE metadata SET value=value+1 WHERE key='commit_sequence'");
      this.db.exec('COMMIT'); committed = true;
      // Publish the independent high-water mark before acknowledging admission
      // or releasing a dispatch. A same-epoch stale backup must not run.
      this.persistAuthority(); return result;
    } catch (error) {if (!committed) this.db.exec('ROLLBACK'); throw error;}
    finally {this.depth = 0;}
  }

  // ---- Request epochs -------------------------------------------------------
  epochState() {
    return {generation: this.meta('generation'), open_epoch: this.meta('open_epoch'),
      draining_epoch: this.meta('draining_epoch') || null, sealed_through: this.meta('sealed_through'),
      authorization_generation: this.meta('authorization_generation')};
  }
  sealReason(epoch) {return this.db.prepare('SELECT reason FROM epoch_seals WHERE epoch=?').get(epoch)?.reason ?? 'recovery';}
  // Admission fence for an absent identity: returns null when admissible.
  fence(key, {register = false} = {}) {
    const identity = parseIdentity(key), state = this.epochState();
    if (identity.kind === 'legacy') return {retired: 'legacy'};
    if (identity.generation < state.generation) return {retired: 'generation'};
    requireCondition(identity.generation === state.generation, 'REQUEST_EPOCH_INVALID');
    if (identity.kind === 'schedule') {
      const fence = this.db.prepare('SELECT * FROM schedule_fences WHERE schedule_id=?').get(identity.schedule_id);
      if (!fence) {
        if (identity.epoch <= state.sealed_through) return {retired: 'schedule'};
        requireCondition(false, 'SCHEDULE_UNREGISTERED');
      }
      if (fence.deleted || identity.revision < fence.revision ||
          identity.revision === fence.revision && identity.occurrence_ms <= fence.fired_through ||
          identity.occurrence_ms <= this.meta('schedule_floor_ms')) return {retired: 'schedule'};
      if (register) this.db.prepare('UPDATE schedule_fences SET revision=?, fired_through=? WHERE schedule_id=?')
        .run(identity.revision, identity.occurrence_ms, identity.schedule_id);
      return null;
    }
    if (identity.epoch <= state.sealed_through) return {retired: this.sealReason(identity.epoch)};
    requireCondition(identity.epoch === state.open_epoch || identity.epoch === state.draining_epoch, 'REQUEST_EPOCH_INVALID');
    return null;
  }
  registerSchedule(scheduleID, revision) {
    const match = /^s3\.(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})\.([0-9a-f]{32})$/u.exec(scheduleID);
    requireCondition(match && Number.isSafeInteger(revision) && revision > 0, 'INPUT_VALIDATION_FAILED');
    return this.transaction(() => {
      const state = this.epochState(), creation = Number(match[2]), existing = this.db.prepare('SELECT * FROM schedule_fences WHERE schedule_id=?').get(scheduleID);
      requireCondition(Number(match[1]) === state.generation, 'REQUEST_EPOCH_INVALID');
      if (existing) {
        requireCondition(!existing.deleted, 'OPERATION_RETIRED');
        if (revision > existing.revision) this.db.prepare('UPDATE schedule_fences SET revision=? WHERE schedule_id=?').run(revision, scheduleID);
        return this.schedule(scheduleID);
      }
      requireCondition(creation === state.open_epoch || creation === state.draining_epoch, 'OPERATION_RETIRED');
      this.db.prepare('INSERT INTO schedule_fences VALUES (?,?,?,?,0)').run(scheduleID, creation, revision, -1);
      return this.schedule(scheduleID);
    });
  }
  deleteSchedule(scheduleID) {
    return this.transaction(() => {
      this.db.prepare('UPDATE schedule_fences SET deleted=1 WHERE schedule_id=?').run(scheduleID);
      return this.schedule(scheduleID);
    });
  }
  schedule(scheduleID) {
    const row = this.db.prepare('SELECT * FROM schedule_fences WHERE schedule_id=?').get(scheduleID);
    return row && {schedule_id: row.schedule_id, revision: row.revision, fired_through: row.fired_through, deleted: Boolean(row.deleted)};
  }
  // Issuance switch: open E+1 and mark E draining. At most one epoch drains.
  rotate({force = false, forceSeal = false} = {}) {
    const due = () => {
      const state = this.epochState(), now = this.clock();
      if (state.draining_epoch) return forceSeal || now - this.meta('draining_since_ms') >= this.policy.maxOfflineMs;
      if (force || now - this.meta('open_since_ms') >= this.policy.maxOpenEpochMs) return true;
      return this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE request_epoch=? AND status IN ('completed','failed','cancelled','resolved')`)
        .get(state.open_epoch).n >= this.policy.rotateTerminalRows;
    };
    if (!due()) return this.epochState();
    return this.transaction(() => {
      if (!due()) return this.epochState();
      const state = this.epochState(), now = this.clock();
      // A draining epoch past the offline window (or under unrelievable
      // storage pressure) is sealed without product confirmation.
      if (state.draining_epoch) {this.sealEpoch(state.draining_epoch, 'forced'); return this.epochState();}
      this.setMeta('draining_epoch', state.open_epoch); this.setMeta('draining_since_ms', now);
      this.setMeta('open_epoch', state.open_epoch + 1); this.setMeta('open_since_ms', now);
      return this.epochState();
    });
  }
  sealEpoch(epoch, reason, drainedDigest = null) {
    const state = this.epochState();
    requireCondition(epoch === state.draining_epoch, 'REQUEST_EPOCH_INVALID');
    this.db.prepare('INSERT OR REPLACE INTO epoch_seals VALUES (?,?,?,?)').run(epoch, reason, this.clock(), drainedDigest);
    this.setMeta('sealed_through', epoch); this.setMeta('draining_epoch', 0); this.setMeta('draining_since_ms', 0);
  }
  // Product confirmation that no identity issued in `epoch` remains unsubmitted.
  seal(epoch, drainedDigest) {
    requireCondition(/^[0-9a-f]{64}$/u.test(drainedDigest), 'INPUT_VALIDATION_FAILED');
    return this.transaction(() => {
      if (epoch <= this.meta('sealed_through')) return this.epochState();
      this.sealEpoch(epoch, 'drained', drainedDigest); return this.epochState();
    });
  }

  // ---- Tasks ----------------------------------------------------------------
  find(grant) {
    return this.db.prepare('SELECT * FROM tasks WHERE principal=? AND owner=? AND request_key=?')
      .get(grant.principal, grant.owner, grant.request_key);
  }
  get(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
  lookup(grant) {
    const row = this.find(grant);
    if (row) return {row};
    const fence = this.fence(grant.request_key);
    return fence ? {outcome: 'retired', reason: fence.retired} : {outcome: 'not_admitted'};
  }
  prepare(request, grant, intent, resourceDigest, recoveryClass) {
    return this.transaction(() => {
      const previous = this.find(grant);
      if (previous) {
        requireCondition(previous.intent === intent && previous.resource_digest === resourceDigest, 'REQUEST_KEY_CONFLICT');
        return {row: previous, fresh: false};
      }
      const fence = this.fence(grant.request_key, {register: true});
      if (fence) throw new OperationRetired(fence.retired);
      if (this.maxTasks > 0) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
        requireCondition(count < this.maxTasks, 'LEDGER_CAPACITY_EXCEEDED');
      }
      const pages = this.db.prepare('PRAGMA page_count').get().page_count;
      const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
      requireCondition(pages * pageSize + Buffer.byteLength(JSON.stringify(request)) < this.maxBytes, 'LEDGER_CAPACITY_EXCEEDED');
      const id = randomUUID(), identity = parseIdentity(grant.request_key);
      this.db.prepare(`INSERT INTO tasks(id,principal,owner,request_key,intent,app,command,request,grant_ref,
        resource_digest,grant_revision,expires,side_effect,status,epoch,generation,request_epoch,recovery_class,created_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?)`)
        .run(id, grant.principal, grant.owner, grant.request_key, intent, request.app, request.command,
          JSON.stringify(request), request.authorization_ref, resourceDigest, grant.revision,
          grant.execution_expires_ms, grant.side_effect, this.epoch, identity.generation,
          identity.kind === 'schedule' ? this.meta('open_epoch') : identity.epoch, recoveryClass, this.clock());
      this.event(id, 'admitted', {});
      return {row: this.get(id), fresh: true};
    });
  }
  update(id, fields) {
    requireCondition(Object.keys(fields).length > 0 && Object.keys(fields).every(key => UPDATABLE.has(key)));
    const assignments = Object.keys(fields).map(key => `${key}=?`), values = Object.values(fields);
    if (fields.status && (TERMINAL.has(fields.status) || fields.status === 'uncertain')) {
      const row = this.get(id);
      const result = {status: fields.status, reason: fields.reason ?? null, data: fields.data ?? null};
      assignments.push('terminal_revision=?', 'result_digest=?', 'finished_ms=?');
      values.push(row.terminal_revision + 1, digest(result), this.clock());
    }
    this.db.prepare(`UPDATE tasks SET ${assignments.join(',')} WHERE id=?`).run(...values, id);
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
  acknowledge(id, {result_digest, terminal_revision, receiver_id, receipt_id}) {
    return this.transaction(() => {
      const row = this.get(id);
      requireCondition(row && TERMINAL.has(row.status), 'INVALID_TASK_STATE');
      requireCondition(row.result_digest === result_digest && row.terminal_revision === terminal_revision, 'ACK_MISMATCH');
      const ack = {receiver_id, receipt_id, terminal_revision, at_ms: this.clock()};
      if (row.ack) {
        const saved = JSON.parse(row.ack);
        requireCondition(saved.receiver_id === receiver_id && saved.receipt_id === receipt_id && saved.terminal_revision === terminal_revision, 'ACK_MISMATCH');
        return this.get(id);
      }
      this.update(id, {ack: JSON.stringify(ack)}); this.event(id, 'result_acknowledged', {terminal_revision});
      return this.get(id);
    });
  }
  resolve(id, {resolution, principal, evidence_digest = null}) {
    requireCondition(['confirmed_sent', 'confirmed_not_sent', 'accept_unknown'].includes(resolution), 'INPUT_VALIDATION_FAILED');
    return this.transaction(() => {
      const row = this.get(id);
      if (row.status === 'resolved') {
        requireCondition(JSON.parse(row.resolution).resolution === resolution, 'INVALID_TASK_STATE');
        return row;
      }
      requireCondition(row.status === 'uncertain', 'INVALID_TASK_STATE');
      const record = {resolution, principal, attempt: row.attempt, evidence_digest, at_ms: this.clock()};
      this.update(id, {status: 'resolved', reason: 'RESOLVED_BY_USER', resolution: JSON.stringify(record)});
      this.event(id, 'resolved', {resolution});
      return this.get(id);
    });
  }

  // ---- Dispatch release -----------------------------------------------------
  reserveDispatch(id) {
    return this.transaction(() => {
      const row = this.get(id);
      requireCondition(row.status === 'running' && row.recovery_class === 'external_write' && !row.effect &&
        row.dispatch !== 'released' && row.dispatch !== 'consume_pending', 'EFFECT_DENIED');
      if (row.dispatch === 'reserved') return {attempt: row.attempt, token: row.token};
      requireCondition(row.attempt < this.policy.maxAttempts, 'DISPATCH_ATTEMPTS_EXHAUSTED');
      const token = randomBytes(16).toString('hex');
      this.update(id, {attempt: row.attempt + 1, dispatch: 'reserved', token, dispatch_seq: null});
      this.event(id, 'dispatch_reserved', {attempt: row.attempt + 1});
      return {attempt: row.attempt + 1, token};
    });
  }
  anchorState() {return this.db.prepare('SELECT generation, seq, digest FROM anchor_state WHERE id=1').get();}
  pendingRelease() {return this.db.prepare('SELECT * FROM pending_release WHERE id=1').get() ?? null;}
  beginRelease(id, token) {
    return this.transaction(() => {
      const row = this.get(id), anchor = this.anchorState();
      requireCondition(this.anchorVerified && row.dispatch === 'reserved' && row.token === token && row.status === 'running', 'EFFECT_DENIED');
      requireCondition(!this.pendingRelease(), 'RELEASE_PENDING');
      const seq = anchor.seq + 1;
      requireCondition(Number.isSafeInteger(seq), 'EXECUTION_EPOCH_EXHAUSTED');
      const value = digest({previous: anchor.digest, operation_id: row.request_key, attempt: row.attempt,
        token: createHash('sha256').update(token).digest('hex')});
      this.db.prepare('INSERT INTO pending_release VALUES (1,?,?,?,?,?,?)').run(id, row.request_key, row.attempt, seq, anchor.digest, value);
      this.update(id, {dispatch: 'consume_pending', dispatch_seq: seq});
      return {generation: anchor.generation, previous_seq: anchor.seq, next_seq: seq, digest: value,
        operation_id: row.request_key, attempt: row.attempt};
    });
  }
  // Only after this commit may the sending worker proceed.
  completeRelease(id) {
    return this.transaction(() => {
      const pending = this.pendingRelease(), row = this.get(id);
      requireCondition(pending && pending.task === id && row.dispatch === 'consume_pending', 'EFFECT_DENIED');
      this.db.prepare('UPDATE anchor_state SET seq=?, digest=? WHERE id=1').run(pending.seq, pending.digest);
      this.db.exec('DELETE FROM pending_release WHERE id=1');
      this.update(id, {dispatch: 'released', effect: 1});
      this.event(id, 'dispatch_released', {attempt: row.attempt});
      return this.get(id);
    });
  }
  // The release was never returned to the worker: the attempt is undispatched.
  voidPending({adopt}) {
    return this.transaction(() => {
      const pending = this.pendingRelease();
      if (!pending) return null;
      if (adopt) this.db.prepare('UPDATE anchor_state SET seq=?, digest=? WHERE id=1').run(pending.seq, pending.digest);
      this.db.exec('DELETE FROM pending_release WHERE id=1');
      const row = this.get(pending.task);
      if (row?.dispatch === 'consume_pending') {
        this.update(row.id, {dispatch: 'voided', token: null});
        this.event(row.id, 'dispatch_voided', {attempt: row.attempt, consumed: Boolean(adopt)});
      }
      return pending;
    });
  }
  voidReservation(id) {
    const row = this.get(id);
    if (row?.dispatch !== 'reserved') return;
    this.update(id, {dispatch: 'voided', token: null});
    this.event(id, 'dispatch_voided', {attempt: row.attempt, consumed: false});
  }
  // Before serving: an unreleased reservation never reached the anchor and is
  // voided locally. Pending releases wait for verifyAnchor().
  recoverLocal() {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT id FROM tasks WHERE dispatch='reserved'").all()) this.voidReservation(row.id);
    });
    this.recovered = true;
    return this.epochState();
  }
  // Resolve a pending release against the independent anchor and detect
  // whole-set rollback (design section 10). Required before any release.
  async verifyAnchor(anchor) {
    const local = this.anchorState(), pending = this.pendingRelease();
    let remote = null;
    if (anchor && anchor.kind !== 'none') remote = await anchor.read();
    if (!remote && anchor && anchor.kind !== 'none' && (local.seq > 0 || local.generation > 1 || pending)) {
      // A missing anchor behind released local state is indistinguishable
      // from both sides having been rolled back to different points.
      await this.fenceForward(anchor, null);
    } else if (!remote) {
      // First use of a fresh anchor (or no anchor): seed it from local state.
      if (anchor && anchor.kind !== 'none') await anchor.reseed({generation: local.generation, seq: local.seq, digest: local.digest});
      this.voidPending({adopt: false});
    } else if (remote.generation === local.generation && remote.seq === local.seq && remote.digest === local.digest) {
      this.voidPending({adopt: false});
    } else if (pending && remote.generation === local.generation && remote.seq === pending.seq && remote.digest === pending.digest) {
      this.voidPending({adopt: true});
    } else {
      await this.fenceForward(anchor, remote);
    }
    this.anchorVerified = true;
    return this.epochState();
  }
  async fenceForward(anchor, remote, {mode} = {}) {
    const local = this.anchorState();
    const ahead = remote && remote.generation === local.generation && remote.seq > local.seq;
    const ring = ahead && remote.seq - local.seq <= RING && remote.ring.some(entry => entry.seq === local.seq + 1) &&
      remote.ring.filter(entry => entry.seq > local.seq).length === remote.seq - local.seq;
    mode ??= ring ? 'ring' : 'all';
    const released = new Set(ring ? remote.ring.filter(entry => entry.seq > local.seq).map(entry => entry.operation_id) : []);
    let affected = 0;
    this.transaction(() => {
      const state = this.epochState(), now = remote?.time_ms ?? this.clock();
      // 1. Old execution authorizations become invalid; the trusted issuer
      //    reissues them from its current revocation state.
      this.setMeta('authorization_generation', state.authorization_generation + 1);
      // 2. Seal every request epoch and open a new one.
      for (const epoch of [state.draining_epoch, state.open_epoch].filter(Boolean)) {
        this.db.prepare("INSERT OR REPLACE INTO epoch_seals VALUES (?,'recovery',?,NULL)").run(epoch, now);
      }
      this.setMeta('sealed_through', state.open_epoch); this.setMeta('draining_epoch', 0); this.setMeta('draining_since_ms', 0);
      this.setMeta('open_epoch', state.open_epoch + 1); this.setMeta('open_since_ms', now);
      this.setMeta('schedule_floor_ms', Math.max(this.meta('schedule_floor_ms'), now));
      // 3. Classify unfinished external writes.
      for (const row of this.db.prepare(`SELECT * FROM tasks WHERE recovery_class='external_write'
          AND status NOT IN ('completed','failed','cancelled','resolved')`).all()) {
        const suspect = mode === 'all' || released.has(row.request_key);
        if (!suspect && row.dispatch !== 'released') continue;
        if (row.status !== 'uncertain') {
          this.update(row.id, {status: 'uncertain', reason: mode === 'all' ? 'ROLLBACK_UNVERIFIED' : 'ROLLBACK_RELEASED',
            ...(row.dispatch === 'consume_pending' || row.dispatch === 'reserved' ? {dispatch: 'released'} : {})});
          this.event(row.id, 'gap', {reason: 'rollback_recovery'}); affected++;
        }
      }
      this.db.exec('DELETE FROM pending_release');
      this.db.prepare('INSERT INTO recoveries(at_ms,mode,local_seq,anchor_seq,affected) VALUES (?,?,?,?,?)')
        .run(now, mode, local.seq, remote?.seq ?? null, affected);
    });
    // 4. Adopt the anchor sequence or reseed it under a new anchor generation.
    if (ahead) {
      this.transaction(() => this.db.prepare('UPDATE anchor_state SET seq=?, digest=? WHERE id=1').run(remote.seq, remote.digest));
    } else if (anchor && anchor.kind !== 'none') {
      const generation = Math.max(local.generation, remote?.generation ?? 0) + 1;
      await anchor.reseed({generation, seq: local.seq, digest: local.digest});
      this.transaction(() => this.db.prepare('UPDATE anchor_state SET generation=? WHERE id=1').run(generation));
    }
    return {mode, affected};
  }
  lastRecovery() {return this.db.prepare('SELECT * FROM recoveries ORDER BY id DESC LIMIT 1').get() ?? null;}
  close() { this.db.close(); }
}
