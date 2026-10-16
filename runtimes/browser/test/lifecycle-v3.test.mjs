import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {SignedFileAuthorization} from '../src/authorization.mjs';
import {Ledger} from '../src/ledger.mjs';
import {Executor} from '../src/executor.mjs';
import {MemoryAnchor} from '../src/anchor.mjs';
import {occurrenceIdentity, operationIdentity, parseIdentity, scheduleIdentity} from '../src/identity.mjs';
import {digest, intentDigest, OPERATIONS} from '../src/protocol.mjs';
import {ProductClient} from '../src/product-client.mjs';
import {assemble, binding, provider} from './fixture-assembly.mjs';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const python = path.join(path.resolve(runtime, '../..'), '.venv/bin/python');
const operations = OPERATIONS.filter(operation => operation !== 'epoch');
const nonce = name => createHash('sha256').update(name).digest('hex').slice(0, 32);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cli-v3-'));
  fs.chmodSync(directory, 0o700);
  const config = {state_directory: directory, grants_directory: path.join(directory, 'grants'),
    issuer_key_file: path.join(directory, 'issuer'), node: process.execPath, runtime_directory: runtime,
    assembly_module: fileURLToPath(new URL('./fixture-assembly.mjs', import.meta.url)), socket: path.join(directory, 'executor.sock'),
    bindings: []};
  fs.writeFileSync(config.issuer_key_file, randomBytes(32), {mode: 0o600});
  const authorization = new SignedFileAuthorization(config.grants_directory, config.issuer_key_file);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  provider.deliveries.length = 0; provider.hooks = {};
  return {directory, config, authorization};
}
const DEADLINE = Date.now() + 600000;
function issue(f, {request_key, command = 'send', args = {}, owner = 'fixture-owner', generation = 1, deadline = true} = {}) {
  // A fixed deadline keeps the intent of a re-derived identity identical.
  const request = {protocol_version: '3.0', operation: 'prepare', app: 'local-fixture', command, request_key, arguments: args,
    ...(deadline ? {deadline_ms: DEADLINE} : {})};
  const grant = {principal: 'fixture-principal', owner, app: request.app, command, request_key,
    intent_digest: intentDigest(request), side_effect: {watch: 'read_only', send: 'remote_mutation'}[command] ?? 'local_mutation',
    operations: [...operations, 'epoch'], access_expires_ms: Date.now() + 90 * 86400000, execution_expires_ms: Date.now() + 60000,
    max_deadline_ms: request.deadline_ms ?? null, task_id: null, revision: 1, authorization_generation: generation};
  const resource = {binding_digest: digest(binding)};
  request.authorization_ref = f.authorization.issue(grant, resource);
  return {request, grant, resource};
}
const control = (request, operation, task, extra = {}) => ({protocol_version: '3.0', app: request.app, command: request.command,
  authorization_ref: request.authorization_ref, operation, ...(operation === 'lookup' ? {request_key: request.request_key} : {task_id: task}), ...extra});
const epochRequest = (request, action, extra = {}) => ({protocol_version: '3.0', app: request.app, command: request.command,
  authorization_ref: request.authorization_ref, operation: 'epoch', action, ...extra});
async function until(action, predicate, timeout = 6000) {
  const stop = Date.now() + timeout;
  do {const value = await action(); if (predicate(value)) return value; await delay(20);} while (Date.now() < stop);
  throw new Error('condition timed out');
}
async function open(f, {anchor = new MemoryAnchor(), clock = Date.now, policy, storage} = {}) {
  const ledger = new Ledger(f.directory, {clock, policy});
  const assembly = await assemble({config: f.config});
  const executor = new Executor({...assembly, ledger, authorization: f.authorization, anchor, clock, rotationIntervalMs: 0,
    gcIntervalMs: 0, storage});
  await executor.start();
  return {ledger, executor, anchor};
}
async function admit(executor, request) {
  const prepared = await executor.control(request);
  assert.equal(prepared.task.status, 'prepared');
  return executor.control(control(request, 'invoke', prepared.task.id));
}
// Simulate a process crash: stop using the database without any transition.
function crash(runtimeState) {
  clearInterval(runtimeState.executor.rotation);
  runtimeState.executor.closing = true;
  runtimeState.ledger.db.close();
}
const hang = () => new Promise(() => {});

test('identity formats are strict and never reinterpret legacy keys', () => {
  const id = operationIdentity({generation: 2, epoch: 7}, nonce('a'));
  assert.deepEqual(parseIdentity(id), {kind: 'operation', generation: 2, epoch: 7, nonce: nonce('a')});
  const schedule = scheduleIdentity({generation: 2, epoch: 7}, nonce('s'));
  const occurrence = occurrenceIdentity(schedule, 3, 1700000000000);
  assert.equal(parseIdentity(occurrence).schedule_id, schedule);
  assert.equal(parseIdentity('5f3a-legacy-key').kind, 'legacy');
  for (const bad of ['op3.01.1.' + nonce('x'), 'op3.1.1.' + nonce('x').toUpperCase(), 'op3.1.1.abc', 'op4.1.1.x']) {
    assert.throws(() => parseIdentity(bad), {code: 'REQUEST_EPOCH_INVALID'});
  }
});

test('epochs drain, seal on product confirmation and retire absent identities with reasons', async t => {
  const f = fixture(t), state = await open(f); t.after(() => state.ledger.close());
  const {executor} = state;
  const first = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('first')), command: 'increment'});
  const done = await admit(executor, first.request);
  await until(() => executor.control(control(first.request, 'status', done.task.id)), value => value.task.status === 'completed');
  const queued = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('queued')), command: 'increment'});
  const lost = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('lost')), command: 'increment'});
  assert.equal((await executor.control(control(lost.request, 'lookup'))).outcome, 'not_admitted');
  let status = await executor.control(epochRequest(first.request, 'rotate'));
  assert.deepEqual([status.epoch_state.open_epoch, status.epoch_state.draining_epoch], [2, 1]);
  // A send queued offline in the draining epoch is still admitted unchanged.
  assert.equal((await executor.control(queued.request)).task.status, 'prepared');
  await assert.rejects(executor.control(issue(f, {request_key: operationIdentity({generation: 1, epoch: 3}, nonce('future'))}).request),
    {code: 'REQUEST_EPOCH_INVALID'});
  status = await executor.control(epochRequest(first.request, 'seal', {epoch: 1, drained_digest: digest({drained: 1})}));
  assert.deepEqual([status.epoch_state.sealed_through, status.epoch_state.draining_epoch], [1, null]);
  const retired = await executor.control(control(lost.request, 'lookup'));
  assert.deepEqual([retired.outcome, retired.reason], ['retired', 'drained']);
  await assert.rejects(executor.control(lost.request), {code: 'OPERATION_RETIRED'});
  // Existing tasks keep their original identity after sealing.
  assert.equal((await executor.control(control(first.request, 'lookup'))).task.id, done.task.id);
  assert.equal((await executor.control(first.request)).task.id, done.task.id);
  const legacy = issue(f, {request_key: 'legacy-key-never-admitted', command: 'increment'});
  assert.deepEqual(await executor.control(control(legacy.request, 'lookup')).then(value => [value.outcome, value.reason]), ['retired', 'legacy']);
  await executor.close();
});

test('a draining epoch is force-sealed after the offline window', async t => {
  const f = fixture(t); let now = Date.now();
  const state = await open(f, {clock: () => now, policy: {maxOpenEpochMs: 1000, maxOfflineMs: 5000}});
  t.after(() => state.ledger.close());
  assert.equal(state.ledger.rotate().open_epoch, 1);
  now += 1000; assert.deepEqual([state.ledger.rotate().open_epoch, state.ledger.epochState().draining_epoch], [2, 1]);
  now += 4000; assert.equal(state.ledger.rotate().sealed_through, 0);
  now += 1000; assert.equal(state.ledger.rotate().sealed_through, 1);
  assert.equal(state.ledger.sealReason(1), 'forced');
  const late = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('late'))});
  const outcome = await state.executor.control(control(late.request, 'lookup'));
  assert.deepEqual([outcome.outcome, outcome.reason], ['retired', 'forced']);
  await state.executor.close();
});

test('scheduled occurrences derive one identity and are fenced without tombstones', async t => {
  const f = fixture(t), state = await open(f); t.after(() => state.ledger.close());
  const {executor} = state;
  const schedule = scheduleIdentity({generation: 1, epoch: 1}, nonce('schedule'));
  const occurrence = time => issue(f, {request_key: occurrenceIdentity(schedule, 1, time), command: 'increment'});
  const anchorRequest = occurrence(1000).request;
  await assert.rejects(executor.control(anchorRequest), {code: 'SCHEDULE_UNREGISTERED'});
  const registered = await executor.control(epochRequest(anchorRequest, 'register_schedule', {schedule_id: schedule, revision: 1}));
  assert.equal(registered.schedule.fired_through, -1);
  const first = await admit(executor, anchorRequest);
  // Restoring an old product database re-derives the same identity.
  assert.equal((await executor.control(occurrence(1000).request)).task.id, first.task.id);
  await assert.rejects(executor.control(occurrence(500).request), {code: 'OPERATION_RETIRED'});
  assert.equal((await executor.control(occurrence(2000).request)).task.status, 'prepared');
  await executor.control(epochRequest(anchorRequest, 'delete_schedule', {schedule_id: schedule}));
  await assert.rejects(executor.control(occurrence(3000).request), {code: 'OPERATION_RETIRED'});
  await executor.close();
});

test('a normal send reserves, releases through the anchor and delivers once', async t => {
  const f = fixture(t), state = await open(f); t.after(() => state.ledger.close());
  const {request} = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('send'))});
  const started = await admit(state.executor, request);
  const done = await until(() => state.executor.control(control(request, 'status', started.task.id)), value => value.task.status === 'completed');
  assert.deepEqual(done.data, {sent: 1});
  assert.equal(done.attempt, 1);
  assert.deepEqual(provider.deliveries, [started.task.id]);
  assert.equal(state.anchor.state.seq, 1);
  assert.deepEqual(state.anchor.state.ring.map(entry => entry.operation_id), [request.request_key]);
  assert.equal(state.ledger.get(started.task.id).dispatch, 'sent');
  await state.executor.close();
});

for (const point of ['beforeReserve', 'beforeRelease']) test(`a crash at ${point} is provably undispatched and continues automatically`, async t => {
  const f = fixture(t), anchor = new MemoryAnchor();
  let state = await open(f, {anchor});
  const {request} = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce(point))});
  provider.hooks[point] = hang;
  const started = await admit(state.executor, request);
  await until(() => state.ledger.get(started.task.id), row => point === 'beforeReserve' ? row.status === 'running' : row.dispatch === 'reserved');
  crash(state); provider.hooks = {};
  state = await open(f, {anchor}); t.after(() => state.ledger.close());
  const row = state.ledger.get(started.task.id);
  assert.equal(row.status, 'blocked'); assert.equal(row.effect, 0);
  assert.notEqual(row.dispatch, 'released');
  await state.executor.control(control(request, 'resume', started.task.id));
  const done = await until(() => state.executor.control(control(request, 'status', started.task.id)), value => value.task.status === 'completed');
  assert.deepEqual(done.data, {sent: 1});
  assert.deepEqual(provider.deliveries, [started.task.id]);
  await state.executor.close();
});

for (const advanced of [false, true]) test(`consume_pending crash with anchor ${advanced ? 'advanced (lost response)' : 'unchanged'} is voided, never uncertain`, async t => {
  const f = fixture(t), anchor = new MemoryAnchor();
  let state = await open(f, {anchor});
  const {request} = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce(`pending-${advanced}`))});
  // Fail the CAS (optionally after the anchor advanced) and crash before retry.
  const original = anchor.advance.bind(anchor);
  anchor.advance = async body => {
    if (advanced) await original(body);
    crash(state);
    return hang();
  };
  const started = await admit(state.executor, request);
  await until(() => anchor.calls.length > 0 || anchor.state?.seq === 1 || state.ledger.db.isOpen === false, Boolean);
  await delay(50);
  anchor.advance = original;
  state = await open(f, {anchor}); t.after(() => state.ledger.close());
  const row = state.ledger.get(started.task.id);
  assert.equal(row.status, 'blocked'); assert.equal(row.dispatch, 'voided'); assert.equal(row.effect, 0);
  assert.equal(state.ledger.pendingRelease(), null);
  assert.equal(state.ledger.anchorState().seq, advanced ? 1 : 0);
  await state.executor.control(control(request, 'resume', started.task.id));
  const done = await until(() => state.executor.control(control(request, 'status', started.task.id)), value => value.task.status === 'completed');
  assert.deepEqual(done.data, {sent: 1}); assert.equal(done.attempt, 2);
  assert.deepEqual(provider.deliveries, [started.task.id]);
  assert.equal(anchor.state.seq, advanced ? 2 : 1);
  await state.executor.close();
});

test('a crash after release is uncertain and reconciliation never resends', async t => {
  const f = fixture(t), anchor = new MemoryAnchor();
  let state = await open(f, {anchor});
  const {request} = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('released'))});
  provider.hooks.afterRelease = hang;
  const started = await admit(state.executor, request);
  await until(() => state.ledger.get(started.task.id), row => row.dispatch === 'released');
  crash(state); provider.hooks = {};
  state = await open(f, {anchor}); t.after(() => state.ledger.close());
  assert.equal(state.ledger.get(started.task.id).status, 'uncertain');
  await assert.rejects(state.executor.control(control(request, 'resume', started.task.id)), {code: 'INVALID_TASK_STATE'});
  await state.executor.control(control(request, 'reconcile', started.task.id));
  const after = await until(() => state.executor.control(control(request, 'status', started.task.id)), value => value.task.status !== 'pending' && value.task.status !== 'running');
  assert.equal(after.task.status, 'uncertain');
  assert.deepEqual(provider.deliveries, []);
  await state.executor.close();
});

test('an unreachable anchor blocks only the release and produces no uncertain send', async t => {
  const f = fixture(t), anchor = new MemoryAnchor();
  const state = await open(f, {anchor}); t.after(() => state.ledger.close());
  anchor.unavailable = true;
  const reader = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('read-during-outage')), command: 'increment'});
  const read = await admit(state.executor, reader.request);
  await until(() => state.executor.control(control(reader.request, 'status', read.task.id)), value => value.task.status === 'completed');
  const {request} = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('outage'))});
  const started = await admit(state.executor, request);
  const blocked = await until(() => state.executor.control(control(request, 'status', started.task.id)), value => value.task.status === 'blocked');
  assert.equal(blocked.reason, 'ANCHOR_UNAVAILABLE');
  assert.deepEqual(provider.deliveries, []);
  anchor.unavailable = false;
  await state.executor.control(control(request, 'resume', started.task.id));
  await until(() => state.executor.control(control(request, 'status', started.task.id)), value => value.task.status === 'completed');
  assert.deepEqual(provider.deliveries, [started.task.id]);
  await state.executor.close();
});

test('dispatch attempts are bounded', async t => {
  const f = fixture(t), state = await open(f, {policy: {maxAttempts: 1}}); t.after(() => state.ledger.close());
  const {request} = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('bounded'))});
  state.anchor.unavailable = true;
  const started = await admit(state.executor, request);
  await until(() => state.executor.control(control(request, 'status', started.task.id)), value => value.task.status === 'blocked');
  state.anchor.unavailable = false;
  await state.executor.control(control(request, 'resume', started.task.id));
  const failed = await until(() => state.executor.control(control(request, 'status', started.task.id)), value => value.task.status === 'failed');
  assert.equal(failed.reason, 'DISPATCH_ATTEMPTS_EXHAUSTED');
  assert.deepEqual(provider.deliveries, []);
  await state.executor.close();
});

test('whole-set rollback fences forward with ring classification and reissued authorization', async t => {
  const f = fixture(t), anchor = new MemoryAnchor();
  let state = await open(f, {anchor});
  const sendKey = operationIdentity({generation: 1, epoch: 1}, nonce('rolled-back-send'));
  const sent = issue(f, {request_key: sendKey});
  const quiet = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('never-released'))});
  const sentTask = (await state.executor.control(sent.request)).task.id;
  const quietTask = (await state.executor.control(quiet.request)).task.id;
  // Back up the whole state set while both sends are only prepared.
  state.ledger.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cli-backup-'));
  t.after(() => fs.rmSync(backup, {recursive: true, force: true}));
  for (const name of ['ledger.sqlite', 'authority.json']) fs.copyFileSync(path.join(f.directory, name), path.join(backup, name));
  await state.executor.control(control(sent.request, 'invoke', sentTask));
  await until(() => state.ledger.get(sentTask), row => row.status === 'completed');
  assert.deepEqual(provider.deliveries, [sentTask]);
  await state.executor.close(); state.ledger.close();
  for (const name of ['ledger.sqlite-wal', 'ledger.sqlite-shm']) fs.rmSync(path.join(f.directory, name), {force: true});
  for (const name of ['ledger.sqlite', 'authority.json']) fs.copyFileSync(path.join(backup, name), path.join(f.directory, name));
  state = await open(f, {anchor}); t.after(() => state.ledger.close());
  const recovery = state.ledger.lastRecovery();
  assert.deepEqual([recovery.mode, recovery.affected], ['ring', 1]);
  assert.equal(state.ledger.get(sentTask).status, 'uncertain');
  assert.equal(state.ledger.get(sentTask).reason, 'ROLLBACK_RELEASED');
  assert.equal(state.ledger.get(quietTask).status, 'prepared');
  const epochs = state.ledger.epochState();
  assert.deepEqual([epochs.open_epoch, epochs.sealed_through, epochs.authorization_generation], [2, 1, 2]);
  await assert.rejects(state.executor.control(control(sent.request, 'invoke', sentTask)), {code: 'AUTHORIZATION_GENERATION_STALE'});
  const fresh = issue(f, {request_key: sendKey, generation: 2});
  assert.equal((await state.executor.control(control(fresh.request, 'invoke', sentTask))).task.status, 'uncertain');
  const absent = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('after-backup')), generation: 2});
  assert.deepEqual(await state.executor.control(control(absent.request, 'lookup')).then(value => [value.outcome, value.reason]), ['retired', 'recovery']);
  assert.deepEqual(provider.deliveries, [sentTask]);
  await state.executor.close();
});

test('a lost anchor behind released local state makes every unfinished external write uncertain', async t => {
  const f = fixture(t), anchor = new MemoryAnchor();
  let state = await open(f, {anchor});
  const done = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('released-before-loss'))});
  const pending = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('prepared-before-loss'))});
  const doneTask = (await admit(state.executor, done.request)).task.id;
  await until(() => state.ledger.get(doneTask), row => row.status === 'completed');
  const pendingTask = (await state.executor.control(pending.request)).task.id;
  await state.executor.close(); state.ledger.close();
  const replacement = new MemoryAnchor();
  state = await open(f, {anchor: replacement}); t.after(() => state.ledger.close());
  assert.equal(state.ledger.lastRecovery().mode, 'all');
  assert.equal(state.ledger.get(pendingTask).status, 'uncertain');
  assert.equal(state.ledger.get(doneTask).status, 'completed');
  assert.equal(replacement.state.generation, 2);
  assert.equal(replacement.state.seq, 1);
  await state.executor.close();
});

test('ack_result binds the exact terminal revision and durable receiver', async t => {
  const f = fixture(t), state = await open(f); t.after(() => state.ledger.close());
  const {request} = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('ack')), command: 'increment'});
  const started = await admit(state.executor, request);
  const done = await until(() => state.executor.control(control(request, 'status', started.task.id)), value => value.task.status === 'completed');
  assert.ok(done.result_digest && done.terminal_revision === 1);
  const ack = {result_digest: done.result_digest, terminal_revision: done.terminal_revision, receiver_id: 'product-store', receipt_id: 'receipt-1'};
  await assert.rejects(state.executor.control(control(request, 'ack_result', started.task.id, {...ack, result_digest: '0'.repeat(64)})), {code: 'ACK_MISMATCH'});
  assert.equal((await state.executor.control(control(request, 'ack_result', started.task.id, ack))).kind, 'ack');
  assert.equal((await state.executor.control(control(request, 'ack_result', started.task.id, ack))).kind, 'ack');
  await assert.rejects(state.executor.control(control(request, 'ack_result', started.task.id, {...ack, receipt_id: 'other'})), {code: 'ACK_MISMATCH'});
  assert.equal(JSON.parse(state.ledger.get(started.task.id).ack).receipt_id, 'receipt-1');
  await state.executor.close();
});

test('a user resolves an unknown send without any resend', async t => {
  const f = fixture(t), anchor = new MemoryAnchor();
  let state = await open(f, {anchor});
  const {request} = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('resolve'))});
  provider.hooks.afterRelease = hang;
  const started = await admit(state.executor, request);
  await until(() => state.ledger.get(started.task.id), row => row.dispatch === 'released');
  crash(state); provider.hooks = {};
  state = await open(f, {anchor}); t.after(() => state.ledger.close());
  const resolved = await state.executor.control(control(request, 'resolve', started.task.id, {resolution: 'confirmed_not_sent'}));
  assert.deepEqual([resolved.task.status, resolved.resolution], ['resolved', 'confirmed_not_sent']);
  assert.equal((await state.executor.control(control(request, 'resolve', started.task.id, {resolution: 'confirmed_not_sent'}))).task.status, 'resolved');
  await assert.rejects(state.executor.control(control(request, 'resolve', started.task.id, {resolution: 'confirmed_sent'})), {code: 'INVALID_TASK_STATE'});
  await assert.rejects(state.executor.control(control(request, 'resume', started.task.id)), {code: 'INVALID_TASK_STATE'});
  assert.equal((await state.executor.control(request)).task.status, 'resolved');
  const other = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('not-uncertain')), command: 'increment'});
  const done = await admit(state.executor, other.request);
  await assert.rejects(state.executor.control(control(other.request, 'resolve', done.task.id, {resolution: 'accept_unknown'})), {code: 'INVALID_TASK_STATE'});
  assert.deepEqual(provider.deliveries, []);
  await state.executor.close();
});

test('a lifecycle 2.0 ledger migrates in place into the sealed legacy epoch', async t => {
  const f = fixture(t);
  const db = new DatabaseSync(path.join(f.directory, 'ledger.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO metadata VALUES ('epoch',5),('commit_sequence',9),('schema_version',1);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL, request_key TEXT NOT NULL, intent TEXT NOT NULL,
      app TEXT NOT NULL, command TEXT NOT NULL, request TEXT NOT NULL, grant_ref TEXT NOT NULL, resource_digest TEXT NOT NULL,
      grant_revision INTEGER NOT NULL, expires INTEGER NOT NULL, side_effect TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, data TEXT,
      effect INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL, UNIQUE(principal,owner,request_key));
    CREATE TABLE events (task TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task,sequence));`);
  const legacy = issue(f, {request_key: 'a'.repeat(64), command: 'increment'});
  db.prepare(`INSERT INTO tasks VALUES ('legacy-task','fixture-principal','fixture-owner',?,?,'local-fixture','increment',?,?,?,1,?,'local_mutation','completed',NULL,'{"value":1}',1,1,5)`)
    .run(legacy.grant.request_key, legacy.grant.intent_digest, JSON.stringify(legacy.request), legacy.request.authorization_ref,
      digest(legacy.resource), legacy.grant.execution_expires_ms);
  db.close();
  fs.writeFileSync(path.join(f.directory, 'authority.json'), JSON.stringify({schema_version: 1, epoch: 5, commit_sequence: 9}), {mode: 0o600});
  const state = await open(f); t.after(() => state.ledger.close());
  assert.equal(state.ledger.meta('schema_version'), 2);
  assert.equal(state.ledger.epoch, 6);
  const row = state.ledger.get('legacy-task');
  assert.deepEqual([row.request_epoch, row.recovery_class, row.status], [0, 'legacy', 'completed']);
  const found = await state.executor.control(control(legacy.request, 'lookup'));
  assert.deepEqual([found.task.id, found.data], ['legacy-task', {value: 1}]);
  const absent = issue(f, {request_key: 'b'.repeat(64), command: 'increment'});
  assert.deepEqual(await state.executor.control(control(absent.request, 'lookup')).then(value => [value.outcome, value.reason]), ['retired', 'legacy']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'authority.json'))).schema_version, 2);
  await state.executor.close();
});

test('product heads replace renewal chains with three fixed slots', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'config.json'), JSON.stringify(f.config), {mode: 0o600});
  const product = new ProductClient({configFile: path.join(f.directory, 'config.json'), python});
  product.observe({generation: 1, open_epoch: 1, draining_epoch: null, sealed_through: 0, authorization_generation: 1});
  const request_key = product.allocate();
  assert.equal(parseIdentity(request_key).epoch, 1);
  const options = {app: 'local-fixture', command: 'watch', request_key, arguments: {}, principal: 'fixture-principal',
    owner: 'fixture-owner', resource: {binding_digest: digest(binding)}, side_effect: 'read_only', renewable: true};
  let admission = product.authorize(options);
  product.machine = async value => ({kind: 'task', task: {id: 'watch-task', status: 'running'}, request: value});
  const references = [admission.request.authorization_ref];
  for (let index = 0; index < 5; index++) {
    const renewal = product.renew(admission, 'watch-task');
    await renewal.acknowledged; admission = renewal.admission; references.push(admission.request.authorization_ref);
  }
  const files = fs.readdirSync(f.config.grants_directory).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 2);
  assert.deepEqual(files.sort(), references.slice(-2).map(reference => reference + '.json').sort());
  assert.equal(admission.grant.revision, 6);
  // A lifecycle 2.0 index with a `.next` chain migrates to a head record.
  const old = issue(f, {request_key: 'legacy-chain-key', command: 'watch', deadline: false});
  const index = path.join(f.config.grants_directory, 'index');
  const first = old.request.authorization_ref;
  const second = f.authorization.issue({...old.grant, revision: 2}, old.resource);
  fs.writeFileSync(path.join(index, digest({principal: 'fixture-principal', owner: 'fixture-owner', request_key: 'legacy-chain-key'}) + '.json'),
    JSON.stringify({reference: first, request: {...old.request, protocol_version: '2.0', operation: 'invoke'}}), {mode: 0o600});
  fs.writeFileSync(path.join(index, first + '.next'), JSON.stringify({reference: second}), {mode: 0o600});
  const restored = product.restore({principal: 'fixture-principal', owner: 'fixture-owner', request_key: 'legacy-chain-key'});
  assert.equal(restored.request.authorization_ref, second);
  assert.equal(restored.grant.revision, 2);
});

test('terminal rows are reclaimed only after sealing and their delivery window', async t => {
  const f = fixture(t); let now = Date.now();
  const state = await open(f, {clock: () => now}); t.after(() => state.ledger.close());
  const {executor, ledger} = state;
  const make = name => issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce(name)), command: 'increment'});
  const read = make('reclaim-read'), acked = make('reclaim-acked');
  const send = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('reclaim-send'))});
  const ids = {};
  for (const [name, value] of Object.entries({read, acked, send})) {
    ids[name] = (await admit(executor, value.request)).task.id;
    await until(() => ledger.get(ids[name]), row => row.status === 'completed');
  }
  const done = await executor.control(control(acked.request, 'status', ids.acked));
  await executor.control(control(acked.request, 'ack_result', ids.acked, {result_digest: done.result_digest,
    terminal_revision: done.terminal_revision, receiver_id: 'product-store', receipt_id: 'r1'}));
  now += 48 * 3600_000;
  assert.equal((await executor.gc()).reclaimed, 0, 'an open epoch keeps compact deduplication rows');
  await executor.control(epochRequest(read.request, 'rotate'));
  await executor.control(epochRequest(read.request, 'seal', {epoch: 1, drained_digest: digest({e: 1})}));
  const report = await executor.gc();
  assert.equal(report.reclaimed, 2);
  assert.equal(ledger.get(ids.read), undefined); assert.equal(ledger.get(ids.acked), undefined);
  assert.equal(fs.existsSync(path.join(f.config.grants_directory, read.request.authorization_ref + '.json')), false);
  // The unacknowledged send conclusion is the sole delivery evidence.
  assert.equal(ledger.get(ids.send).status, 'completed');
  const replay = await executor.control(control(issue(f, {request_key: read.request.request_key, command: 'increment'}).request, 'lookup'));
  assert.deepEqual([replay.outcome, replay.reason], ['retired', 'drained']);
  const sent = await executor.control(control(send.request, 'status', ids.send));
  await executor.control(control(send.request, 'ack_result', ids.send, {result_digest: sent.result_digest,
    terminal_revision: sent.terminal_revision, receiver_id: 'product-store', receipt_id: 'r2'}));
  now += 29 * 24 * 3600_000; assert.equal((await executor.gc()).reclaimed, 0);
  now += 2 * 24 * 3600_000; assert.equal((await executor.gc()).reclaimed, 1);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM gc_queue').get().n, 0);
  await executor.close();
});

test('reclamation runs app cleanup hooks and resumes an interrupted queue', async t => {
  const f = fixture(t); let now = Date.now();
  const state = await open(f, {clock: () => now}); t.after(() => state.ledger.close());
  const {executor, ledger} = state;
  const spec = executor.commands.get('local-fixture\0increment'), reclaimed = [];
  let fail = true;
  spec.handler = {...spec.handler, async reclaim(args, context) {
    if (fail) {fail = false; throw new Error('transient');}
    reclaimed.push(context.resource.binding_digest);
  }};
  const value = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('hook')), command: 'increment'});
  const id = (await admit(executor, value.request)).task.id;
  await until(() => ledger.get(id), row => row.status === 'completed');
  await executor.control(epochRequest(value.request, 'rotate'));
  await executor.control(epochRequest(value.request, 'seal', {epoch: 1, drained_digest: digest({e: 1})}));
  now += 48 * 3600_000;
  assert.equal((await executor.gc()).reclaimed, 0);
  assert.equal(ledger.get(id), undefined);
  assert.equal(ledger.reclaimQueue().length, 1);
  assert.equal((await executor.gc()).reclaimed, 1);
  assert.deepEqual(reclaimed, [digest(binding)]);
  await executor.close();
});

test('a resolved unknown send is reclaimed as soon as its epoch is sealed', async t => {
  const f = fixture(t), anchor = new MemoryAnchor();
  let state = await open(f, {anchor});
  const {request} = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('resolved-gc'))});
  provider.hooks.afterRelease = hang;
  const id = (await admit(state.executor, request)).task.id;
  await until(() => state.ledger.get(id), row => row.dispatch === 'released');
  crash(state); provider.hooks = {};
  state = await open(f, {anchor}); t.after(() => state.ledger.close());
  await state.executor.control(control(request, 'resolve', id, {resolution: 'accept_unknown'}));
  await state.executor.control(epochRequest(request, 'rotate'));
  await state.executor.control(epochRequest(request, 'seal', {epoch: 1, drained_digest: digest({e: 1})}));
  assert.equal((await state.executor.gc()).reclaimed, 1);
  // The reclaimed grant is gone; a fresh access grant sees the fence.
  await assert.rejects(state.executor.control(control(request, 'lookup')), {code: 'AUTHORIZATION_UNAVAILABLE'});
  const replay = await state.executor.control(control(issue(f, {request_key: request.request_key}).request, 'lookup'));
  assert.deepEqual([replay.outcome, replay.reason], ['retired', 'drained']);
  assert.deepEqual(provider.deliveries, []);
  await state.executor.close();
});

test('storage pressure refuses new work but keeps replay, ACK and control of admitted tasks', async t => {
  const f = fixture(t), state = await open(f); t.after(() => state.ledger.close());
  const {executor, ledger} = state;
  const first = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('before-pressure')), command: 'increment'});
  const id = (await admit(executor, first.request)).task.id;
  await until(() => ledger.get(id), row => row.status === 'completed');
  executor.storage.budget = ledger.storageBytes() + 1024; executor.usageCache = null;
  const second = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('under-pressure')), command: 'increment'});
  await assert.rejects(executor.control(second.request), {code: 'STORAGE_PRESSURE'});
  assert.equal((await executor.control(control(second.request, 'lookup'))).outcome, 'not_admitted');
  assert.equal((await executor.control(first.request)).task.id, id);
  const done = await executor.control(control(first.request, 'status', id));
  assert.equal((await executor.control(control(first.request, 'ack_result', id, {result_digest: done.result_digest,
    terminal_revision: done.terminal_revision, receiver_id: 'product-store', receipt_id: 'r'}))).kind, 'ack');
  await executor.close();
});

test('event storage is bounded per task by bytes as well as count', async t => {
  const f = fixture(t), state = await open(f, {policy: {eventTaskBytes: 4096}}); t.after(() => state.ledger.close());
  const value = issue(f, {request_key: operationIdentity({generation: 1, epoch: 1}, nonce('events')), command: 'increment'});
  const id = (await state.executor.control(value.request)).task.id;
  state.ledger.transaction(() => {for (let index = 0; index < 50; index++) state.ledger.event(id, 'tick', {pad: 'x'.repeat(500)});});
  const bytes = state.ledger.db.prepare('SELECT SUM(length(payload)) AS n FROM events WHERE task=?').get(id).n;
  assert.ok(bytes <= 4096, String(bytes));
  const page = await state.executor.control(control(value.request, 'events', id, {cursor: 0}));
  assert.equal(page.gap, true);
  await state.executor.close();
});

test('product heads and aliases of reclaimed requests are pruned', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'config.json'), JSON.stringify({...f.config, owner_id: 'fixture-owner'}), {mode: 0o600});
  const product = new ProductClient({configFile: path.join(f.directory, 'config.json'), python});
  product.observe({generation: 1, open_epoch: 1, draining_epoch: null, sealed_through: 0, authorization_generation: 1});
  const keep = product.allocate(), drop = product.allocate();
  const base = {app: 'local-fixture', command: 'increment', arguments: {}, principal: 'fixture-principal', owner: 'fixture-owner',
    resource: {binding_digest: digest(binding)}, side_effect: 'local_mutation', timeout_ms: 60000};
  const kept = product.authorize({...base, request_key: keep}), dropped = product.authorize({...base, request_key: drop});
  product.observe({generation: 1, open_epoch: 2, draining_epoch: null, sealed_through: 1, authorization_generation: 1});
  assert.equal(product.prune(), 0, 'a live grant keeps its head');
  f.authorization.remove(dropped.request.authorization_ref);
  assert.equal(product.prune(), 1);
  assert.throws(() => product.restore({principal: 'fixture-principal', owner: 'fixture-owner', request_key: drop}), {code: 'ADMISSION_UNRESOLVED'});
  assert.equal(product.restore({principal: 'fixture-principal', owner: 'fixture-owner', request_key: keep}).request.authorization_ref, kept.request.authorization_ref);
});
