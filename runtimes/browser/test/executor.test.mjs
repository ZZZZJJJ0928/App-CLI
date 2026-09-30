import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {SignedFileAuthorization} from '../src/authorization.mjs';
import {Ledger} from '../src/ledger.mjs';
import {Executor} from '../src/executor.mjs';
import {decode, digest, intentDigest} from '../src/protocol.mjs';
import {exchange} from '../src/socket.mjs';
import {ProductClient} from '../src/product-client.mjs';
import {assemble, binding} from './fixture-assembly.mjs';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const repository = path.resolve(runtime, '../..');
const python = process.env.APP_CLI_TEST_PYTHON ?? path.join(repository, '.venv/bin/python');
const operations = ['invoke', 'lookup', 'status', 'cancel', 'resume', 'renew', 'events', 'reconcile'];
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cli-runtime-'));
  fs.chmodSync(directory, 0o700);
  const config = {state_directory: directory, grants_directory: path.join(directory, 'grants'),
    issuer_key_file: path.join(directory, 'issuer'), node: process.execPath, runtime_directory: runtime,
    assembly_module: fileURLToPath(new URL('./fixture-assembly.mjs', import.meta.url)), socket: path.join(directory, 'executor.sock')};
  const bindingPath = path.join(directory, 'binding.json');
  fs.writeFileSync(bindingPath, JSON.stringify(binding), {mode: 0o600});
  config.bindings = [{path: bindingPath, digest: digest(binding)}];
  fs.writeFileSync(config.issuer_key_file, randomBytes(32), {mode: 0o600});
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config), {mode: 0o600});
  const authorization = new SignedFileAuthorization(config.grants_directory, config.issuer_key_file);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return {directory, config, authorization, configFile: path.join(directory, 'config.json')};
}
function invoke(f, {key = 'request-one', command = 'increment', args = {}, duration = 60000, owner = 'fixture-owner'} = {}) {
  const request = {protocol_version: '2.0', operation: 'invoke', app: 'local-fixture', command, request_key: key,
    arguments: args, ...(command === 'watch' ? {} : {deadline_ms: Date.now() + 120000})};
  const grant = {principal: 'fixture-principal', owner, app: request.app, command, request_key: key,
    intent_digest: intentDigest(request), side_effect: command === 'watch' ? 'read_only' : 'local_mutation', operations,
    access_expires_ms: Date.now() + 600000, execution_expires_ms: Date.now() + duration,
    max_deadline_ms: request.deadline_ms ?? null, task_id: null, revision: 1};
  const resource = {binding_digest: digest(binding)};
  request.authorization_ref = f.authorization.issue(grant, resource);
  return {request, grant, resource};
}
const control = (request, operation, task, extra = {}) => ({protocol_version: '2.0', app: request.app, command: request.command,
  authorization_ref: request.authorization_ref, operation, ...(operation === 'lookup' ? {request_key: request.request_key} : {task_id: task}), ...extra});
async function until(action, predicate, timeout = 6000) {
  const stop = Date.now() + timeout;
  do {const value = await action(); if (predicate(value)) return value; await delay(20);} while (Date.now() < stop);
  throw new Error('condition timed out');
}
async function local(t) {
  const f = fixture(t); const ledger = new Ledger(f.directory, {eventRetention: 3});
  const assembly = await assemble({config: f.config});
  const executor = new Executor({...assembly, ledger, authorization: f.authorization});
  t.after(async () => {await executor.close(); ledger.close();});
  return {...f, ledger, executor};
}
test('strict decoder and cross-language canonical vectors', () => {
  for (const value of ['{"a":1,"\\u0061":2}', '{"x":NaN}', '{"a":1} 0', '{"x":"\\ud800"}']) assert.throws(() => decode(value));
  const vectors = JSON.parse(fs.readFileSync(path.join(repository, 'tests/fixtures/intent-vectors.json')));
  for (const vector of vectors) assert.equal(digest(vector.value), vector.sha256);
});
test('binding updates preserve original task access without authorizing re-execution', async t => {
  const f = await local(t), {request} = invoke(f);
  const original = await f.executor.control(request);
  await until(() => f.executor.control(control(request, 'status', original.task.id)), x => x.task.status === 'completed');
  await f.executor.close();
  const updated = structuredClone(binding);
  updated.commands.increment.resource = 'changed-resource';
  const assembly = await assemble({config: f.config});
  const next = new Executor({...assembly, bindings: [updated], ledger: f.ledger, authorization: f.authorization});
  t.after(() => next.close());
  for (const operation of ['lookup','status','events','cancel']) {
    const result = await next.control(control(request, operation, original.task.id, operation === 'events' ? {cursor:0,limit:10} : {}));
    assert.equal(result.task.id, original.task.id);
  }
  for (const operation of ['invoke','resume','renew','reconcile']) {
    await assert.rejects(() => next.control(operation === 'invoke' ? request : control(request, operation, original.task.id)), {code:'RELEASE_MISMATCH'});
  }
  const foreign = invoke(f, {owner: 'foreign-owner'}).request;
  await assert.rejects(() => next.control(control(foreign, 'status', original.task.id)), {code:'TASK_ACCESS_DENIED'});
  assert.equal(fs.readdirSync(f.directory).filter(x => x.endsWith('.effect')).length, 1);
});
test('explicit journal-only reconciliation survives a binding update and never repeats the effect', async t => {
  const f = await local(t), {request} = invoke(f, {args:{wait_ms:10000}});
  const original = await f.executor.control(request);
  await until(() => f.executor.control(control(request,'status',original.task.id)), x => x.task.status==='running');
  await f.executor.close();
  assert.equal(f.ledger.get(original.task.id).status,'uncertain');
  const updated = structuredClone(binding);
  updated.commands.increment.resource='new-resource';updated.commands.increment.reconcile_requires_host=false;
  const assembly = await assemble({config:f.config});
  const next = new Executor({...assembly,bindings:[updated],ledger:f.ledger,authorization:f.authorization,
    host:{acquire(){assert.fail('journal reconciliation must not acquire a page');}}});
  t.after(() => next.close());
  await next.control(control(request,'reconcile',original.task.id));
  const result = await until(() => next.control(control(request,'status',original.task.id)), x=>x.task.status==='completed');
  assert.deepEqual(result.data,{value:1});
  await assert.rejects(() => next.control(request),{code:'RELEASE_MISMATCH'});
  assert.equal(fs.readdirSync(f.directory).filter(x=>x.endsWith('.effect')).length,1);
});
test('concurrent admission, immutable intent, foreign owner and completed replay', async t => {
  const f = await local(t); const {request} = invoke(f, {args: {wait_ms: 50}});
  const responses = await Promise.all(Array.from({length: 16}, () => f.executor.control(request)));
  assert.equal(new Set(responses.map(value => value.task.id)).size, 1);
  const id = responses[0].task.id;
  const complete = await until(() => f.executor.control(control(request, 'status', id)), x => x.task.status === 'completed');
  assert.deepEqual(complete.data, {value: 1});
  assert.equal(fs.readdirSync(f.directory).filter(x => x.endsWith('.effect')).length, 1);
  assert.equal((await f.executor.control(request)).task.id, id);
  const drift = invoke(f, {args: {wait_ms: 1}}).request;
  await assert.rejects(() => f.executor.control(drift), {code: 'REQUEST_KEY_CONFLICT'});
  const other = invoke(f, {owner: 'other-owner'}).request;
  await assert.rejects(() => f.executor.control(control(other, 'status', id)), {code: 'TASK_ACCESS_DENIED'});
  await assert.rejects(() => f.executor.control(control(request, 'resume', id)), {code: 'INVALID_TASK_STATE'});
});
test('watch expiry preserves access; renewal is idempotent; gap and cancel retain original task', async t => {
  const f = await local(t); const issued = invoke(f, {command: 'watch', duration: 400});
  const {request} = issued; const id = (await f.executor.control(request)).task.id;
  await until(() => f.executor.control(control(request, 'status', id)), x => x.task.status === 'running');
  const updated = {...issued.grant, revision: 2, execution_expires_ms: Date.now() + 700};
  const renewed = {...request, authorization_ref: f.authorization.issue(updated, issued.resource)};
  const renewal = await f.executor.control(control(renewed, 'renew', id));
  assert.equal(renewal.kind, 'task');
  assert.deepEqual(renewal.task, {id, status: 'running'});
  assert.equal('data' in renewal, false);
  await f.executor.control(control(renewed, 'renew', id));
  await assert.rejects(() => f.executor.control(control(request, 'renew', id)), {code: 'AUTHORIZATION_STALE'});
  await until(() => f.executor.control(control(request, 'status', id)), x => x.task.status === 'waiting_confirmation');
  const events = await f.executor.control(control(request, 'events', id, {cursor: 0}));
  assert.equal(events.gap, true); assert.ok(events.events.length <= 3);
  await assert.rejects(() => f.executor.control(control(request, 'resume', id)), {code: 'AUTHORIZATION_DENIED'});
  assert.equal((await f.executor.control(control(request, 'cancel', id))).kind, 'ack');
  assert.equal((await f.executor.control(control(request, 'status', id))).task.status, 'cancelled');
});
test('cancelling an in-flight effect is uncertain until evidence reconciliation', async t => {
  const f = await local(t); const {request} = invoke(f, {args: {wait_ms: 5000}});
  const id = (await f.executor.control(request)).task.id;
  await until(() => f.ledger.get(id), row => row.effect === 1);
  const ack = await f.executor.control(control(request, 'cancel', id)); assert.equal(ack.kind, 'ack');
  await until(() => f.executor.control(control(request, 'status', id)), x => x.task.status === 'uncertain');
  await f.executor.control(control(request, 'reconcile', id));
  const final = await until(() => f.executor.control(control(request, 'status', id)), x => x.task.status === 'completed');
  assert.deepEqual(final.data, {value: 1});
});
test('invalid/modified grant cannot admit or expose task data', async t => {
  const f = await local(t); const {request} = invoke(f);
  const file = path.join(f.config.grants_directory, request.authorization_ref + '.json');
  const value = JSON.parse(fs.readFileSync(file)); value.grant.owner = 'tampered'; fs.writeFileSync(file, JSON.stringify(value));
  await assert.rejects(() => f.executor.control(request), {code: 'AUTHORIZATION_INVALID'});
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
});
test('fresh reconciliation authority can inspect an effect after the original business deadline', async t => {
  const f = await local(t);
  const issued = invoke(f, {args: {wait_ms: 5000}});
  issued.request.deadline_ms = Date.now() + 150;
  issued.grant.max_deadline_ms = issued.request.deadline_ms;
  issued.grant.intent_digest = intentDigest(issued.request);
  issued.request.authorization_ref = f.authorization.issue(issued.grant, issued.resource);
  const id = (await f.executor.control(issued.request)).task.id;
  await until(() => f.executor.control(control(issued.request, 'status', id)), value => value.task.status === 'uncertain');
  const renewed = {...issued.request, authorization_ref: f.authorization.issue({...issued.grant,
    revision: 2, task_id: id, execution_expires_ms: Date.now() + 5000}, issued.resource)};
  await f.executor.control(control(renewed, 'reconcile', id));
  const final = await until(() => f.executor.control(control(renewed, 'status', id)), value => value.task.status === 'completed');
  assert.deepEqual(final.data, {value: 1});
  assert.equal(fs.readdirSync(f.directory).filter(name => name.endsWith('.effect')).length, 1);
});
test('trusted product index preserves large arguments and retries a lost renewal acknowledgement with the same grant', async t => {
  const f = fixture(t), product = new ProductClient({configFile: f.configFile, python});
  const options = {app: 'local-fixture', command: 'watch', request_key: 'large-watch',
    arguments: {body: '多行正文\n'.repeat(35000)}, principal: 'fixture-principal', owner: 'fixture-owner',
    resource: {binding_digest: digest(binding)}, side_effect: 'read_only', renewable: true};
  const original = product.authorize(options);
  assert.deepEqual(product.authorize(options).request, original.request);
  product.machine = async () => {throw Object.assign(new Error('lost'), {code: 'CONTROL_TIMEOUT'});};
  const renewal = product.renew(original, 'fixture-task');
  await assert.rejects(renewal.acknowledged, {code: 'CONTROL_TIMEOUT'});
  const restarted = new ProductClient({configFile: f.configFile, python});
  const loaded = restarted.authorize(options);
  assert.equal(loaded.request.authorization_ref, renewal.admission.request.authorization_ref);
  assert.equal(loaded.grant.revision, 2);
  assert.throws(() => restarted.authorize({...options, arguments: {body: 'changed'}}), {code: 'REQUEST_KEY_CONFLICT'});
  const repeated = product.renew(original, 'fixture-task');
  await assert.rejects(repeated.acknowledged);
  assert.equal(repeated.admission.request.authorization_ref, loaded.request.authorization_ref);
});
test('real resident service: flock exclusion, lost response, crash recovery, epoch and reconcile', async t => {
  const f = fixture(t); let child;
  const start = async () => {
    child = spawn(python, ['-m', 'app_cli.executor_service', f.configFile], {cwd: repository, stdio: 'ignore'});
    await until(async () => {try {return await exchange(f.config.socket, control(request, 'lookup'));} catch {return null;}}, value => value !== null);
  };
  const stop = async signal => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(signal); await stopped;
  };
  t.after(() => stop('SIGKILL'));
  const {request} = invoke(f, {args: {wait_ms: 10000}});
  await start();
  const second = spawnSync(python, ['-m', 'app_cli.executor_service', f.configFile], {cwd: repository, encoding: 'utf8', timeout: 3000});
  assert.notEqual(second.status, 0); assert.match(second.stderr, /already running/u);
  // Treat the invoke response as lost: only the stable key is used to recover.
  const product = new ProductClient({configFile: f.configFile, python});
  await product.machine(request);
  const found = await until(() => exchange(f.config.socket, control(request, 'lookup')), x => x.task?.status === 'running');
  const id = found.task.id;
  await until(() => fs.existsSync(path.join(f.directory, id + '.effect')), Boolean);
  await stop('SIGKILL'); await start();
  const recovered = await exchange(f.config.socket, control(request, 'status', id));
  assert.equal(recovered.task.status, 'uncertain');
  assert.equal((await exchange(f.config.socket, request)).task.id, id);
  await exchange(f.config.socket, control(request, 'reconcile', id));
  await until(() => exchange(f.config.socket, control(request, 'status', id)), x => x.task.status === 'completed');
  await stop('SIGTERM');
  const ledger = new Ledger(f.directory); assert.equal(ledger.epoch, 3); ledger.close();
});
test('public Python Registry accepts repeated resident watch renewals without changing the task', async t => {
  const f = fixture(t), product = new ProductClient({configFile: f.configFile, python});
  const admission = product.authorize({app: 'local-fixture', command: 'watch', arguments: {wait_ms: 100},
    request_key: 'registry-watch-renewal', principal: 'fixture-principal', owner: 'fixture-owner',
    resource: {binding_digest: digest(binding)}, side_effect: 'read_only', renewable: true});
  const child = spawn(python, ['-m', 'app_cli.executor_service', f.configFile], {cwd: repository, stdio: 'ignore'});
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped;
  });
  await until(async () => {try {return await exchange(f.config.socket, control(admission.request, 'lookup'));} catch {return null;}}, Boolean);
  const first = await product.invoke(admission), id = first.task.id;
  await until(() => product.control(admission, 'status', id), value => value.task.status === 'running');
  let current = admission;
  for (let revision = 2; revision <= 4; revision++) {
    const renewal = product.renew(current, id);
    const response = await renewal.acknowledged;
    assert.equal(response.kind, 'task');
    assert.deepEqual(response.task, {id, status: 'running'});
    assert.equal('data' in response, false);
    current = renewal.admission;
    assert.equal(current.grant.revision, revision);
    assert.equal((await product.control(current, 'events', id, {cursor: 0, limit: 100})).task.id, id);
  }
  assert.equal((await product.control(current, 'cancel', id)).kind, 'ack');
  await until(() => product.control(current, 'status', id), value => value.task.status === 'cancelled');
});
test('cancel queued work immediately without releasing the running lane', async t => {
  const f = await local(t);
  const spec = f.executor.commands.get('local-fixture\0increment'), run = spec.handler.run;
  let release;
  const occupied = new Promise(resolve => { release = resolve; });
  spec.handler = {...spec.handler, async run(args, context) {
    const result = await run({...args, wait_ms: 0}, context);
    if (args.wait_ms === 250) await occupied;
    return result;
  }};
  try {
  const first = invoke(f, {key: 'lane-first', args: {wait_ms: 250}}).request;
  const a = (await f.executor.control(first)).task.id;
  await until(() => f.ledger.get(a), row => row.effect === 1);
  const second = invoke(f, {key: 'lane-second'}).request;
  const b = (await f.executor.control(second)).task.id;
  assert.equal((await f.executor.control(control(second, 'cancel', b))).task.status, 'cancelled');
  const third = invoke(f, {key: 'lane-third'}).request;
  const c = (await f.executor.control(third)).task.id;
  await delay(30);
  assert.equal(f.ledger.get(a).status, 'running');
  assert.equal(f.ledger.get(c).effect, 0);
  release();
  await until(() => f.ledger.get(c), row => row.status === 'completed');
  assert.equal(f.ledger.get(b).effect, 0);
  assert.equal(f.ledger.get(b).status, 'cancelled');
  } finally { release(); }
});
test('clean service stop blocks read-only work and keeps the same task resumable', async t => {
  const f = await local(t), {request} = invoke(f, {command: 'watch'});
  const id = (await f.executor.control(request)).task.id;
  await until(() => f.ledger.get(id), row => row.status === 'running');
  await f.executor.close();
  assert.equal(f.ledger.get(id).status, 'blocked');
  assert.equal(f.ledger.get(id).reason, 'EXECUTOR_STOPPING');
});
test('an indexed key with unresolved durable admission never triggers a second invoke', async t => {
  const f = fixture(t), client = new ProductClient({configFile: f.configFile, python});
  const options = {app: 'local-fixture', command: 'increment', request_key: 'lost-admission', arguments: {},
    principal: 'fixture-principal', owner: 'fixture-owner', resource: {binding_digest: digest(binding)},
    side_effect: 'local_mutation', timeout_ms: 60000};
  client.authorize(options);
  const admission = client.authorize(options), calls = [];
  client.machine = async request => {calls.push(request.operation); return {kind: 'lookup', outcome: 'unresolved'};};
  await assert.rejects(client.invoke(admission), {code: 'ADMISSION_UNRESOLVED'});
  assert.deepEqual(calls, ['lookup']);
});
test('ledger capacity refuses new tasks while preserving completed replay and key conflict detection', t => {
  const f = fixture(t), ledger = new Ledger(f.directory, {maxTasks: 1}); t.after(() => ledger.close());
  const first = invoke(f), second = invoke(f, {key: 'second'});
  const admitted = ledger.admit(first.request, first.grant, intentDigest(first.request), digest(first.resource));
  ledger.update(admitted.row.id, {status: 'completed', data: '{"value":1}'});
  assert.throws(() => ledger.admit(second.request, second.grant, intentDigest(second.request), digest(second.resource)), {code: 'LEDGER_CAPACITY_EXCEEDED'});
  assert.equal(ledger.admit(first.request, first.grant, intentDigest(first.request), digest(first.resource)).row.id, admitted.row.id);
  assert.throws(() => ledger.admit(first.request, first.grant, 'changed', digest(first.resource)), {code: 'REQUEST_KEY_CONFLICT'});
});
test('authority marker prevents recreating a missing ledger or rolling back its epoch', t => {
  for (const damage of ['missing', 'rollback']) {
    const f = fixture(t), ledger = new Ledger(f.directory);
    if (damage === 'rollback') ledger.db.exec("UPDATE metadata SET value=0 WHERE key='epoch'");
    ledger.close();
    if (damage === 'missing') fs.unlinkSync(path.join(f.directory, 'ledger.sqlite'));
    assert.throws(() => new Ledger(f.directory), {code: 'LEDGER_RECOVERY_REQUIRED'});
  }
});
test('wire and binding schemas in the runtime are byte-identical to the published sources', () => {
  for (const name of ['lifecycle-v2', 'browser-host-v1', 'execution-binding-v1']) {
    assert.deepEqual(fs.readFileSync(path.join(runtime, 'schemas', name + '.schema.json')),
      fs.readFileSync(path.join(repository, 'schemas', name + '.schema.json')));
  }
});

test('a stale database backup from the same execution epoch is rejected', t => {
  const f = fixture(t), ledger = new Ledger(f.directory);
  ledger.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const file = path.join(f.directory, 'ledger.sqlite'), snapshot = path.join(f.directory, 'snapshot.sqlite');
  fs.copyFileSync(file, snapshot);
  const first = invoke(f);
  ledger.admit(first.request, first.grant, intentDigest(first.request), digest(first.resource));
  const epoch = ledger.epoch; ledger.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'authority.json'))).epoch, epoch);
  fs.copyFileSync(snapshot, file);
  assert.throws(() => new Ledger(f.directory), {code: 'LEDGER_RECOVERY_REQUIRED'});
});

test('restoring original task access retains its resource after current credentials change', async t => {
  const f = fixture(t), client = new ProductClient({configFile: f.configFile, python});
  const identity = {principal: 'fixture-principal', owner: 'fixture-owner', request_key: 'credential-change'};
  const options = {...identity, app: 'local-fixture', command: 'increment', arguments: {}, side_effect: 'local_mutation',
    timeout_ms: 60000, resource: {binding_digest: digest(binding), credential_generation: 1, token: 'fixture-old-token'}};
  const first = client.authorize(options);
  assert.throws(() => client.authorize({...options, resource: {...options.resource, credential_generation: 2}}), {code: 'REQUEST_KEY_CONFLICT'});
  const restored = client.restore(identity);
  assert.equal(restored.request.authorization_ref, first.request.authorization_ref);
  assert.deepEqual(restored.resource, first.resource);
  assert.equal(restored.existing, true);
  assert.throws(() => client.restore({...identity, owner: 'foreign-owner'}), {code: 'ADMISSION_UNRESOLVED'});
});
