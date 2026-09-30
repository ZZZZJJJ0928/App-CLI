import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {BrowserHostPort, signHostRequest} from '../src/host-port.mjs';
import {SignedFileAuthorization} from '../src/authorization.mjs';
import {digest} from '../src/protocol.mjs';

function setup(t, {idleMS = 0, invalidate = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cli-host-')); fs.chmodSync(root, 0o700);
  const key = path.join(root, 'key'); fs.writeFileSync(key, randomBytes(32), {mode: 0o600});
  const authorization = new SignedFileAuthorization(path.join(root, 'grants'), key);
  const calls = [], handles = new Set(); let now = 1000000, failClose = false, releaseCall;
  const driver = {
    async create() {const handle = {}; handles.add(handle); return handle;},
    async close(handle) {calls.push('close'); if (failClose) throw new Error('close failed'); handles.delete(handle);},
    async updateLease(handle, stamp) {handle.stamp = stamp;},
    async revokeActivity(handle, id, kind) {calls.push(`revoke:${kind}`);},
    async call(handle, method, args, {signal}) {
      calls.push(method);
      if (method === 'wait') await new Promise(resolve => {releaseCall = resolve; signal.addEventListener('abort', resolve, {once: true});});
      return args;
    },
  };
  const binding = {manifest: {id: 'browser-fixture'}, commands: {
    read: {host: {methods: ['read', 'wait'], family: 'shared', activity: 'read', reuse_idle_ms: idleMS, invalidate_on_failure: invalidate}},
    watch: {host: {methods: ['watch'], family: 'shared', activity: 'watch'}},
  }};
  const host = new BrowserHostPort({authorization, bindings: [binding], driver, stateDirectory: root, clock: () => now});
  const refs = {};
  for (const command of ['read', 'watch']) refs[command] = authorization.issue({principal: 'owner', owner: 'owner', app: 'browser-fixture',
    command, request_key: command, intent_digest: digest(command), side_effect: 'read_only',
    execution_expires_ms: now + (command === 'watch' ? 1000 : 100000), access_expires_ms: now + 200000, revision: 1},
  {binding_digest: digest(binding), profile_id: 'default', credential_generation: 1, pool_key: 'same-account'});
  let epoch = 1, generation;
  const send = (operation, command = 'read', extra = {}) => host.control(signHostRequest(authorization,
    {protocol_version: '1.0', operation, epoch, ...(generation ? {generation} : {}),
      ...(operation === 'hello' ? {bindings: [digest(binding)]} : {authorization_ref: refs[command], task_id: command}), ...extra}));
  t.after(async () => {failClose = false; releaseCall?.(); await host.close(); fs.rmSync(root, {recursive: true, force: true});});
  return {host, calls, handles, send, binding, authorization, refs, root, driver,
    setNow: value => {now = value;}, failClose: value => {failClose = value;},
    async hello(value = 1) {epoch = value; const result = await send('hello'); generation = result.generation; return result;}};
}
test('watch expiry removes only its activity and preserves an active shared read', async t => {
  const f = setup(t); await f.hello();
  const watch = await f.send('acquire', 'watch'); const read = await f.send('acquire');
  assert.equal(f.handles.size, 1); assert.equal(read.reused, true);
  f.setNow(1001001); await f.host.expire();
  assert.equal(f.handles.size, 1); assert.ok(f.calls.includes('revoke:watch')); assert.ok(!f.calls.includes('close'));
  await assert.rejects(() => f.send('call', 'watch', {lease_id: watch.lease_id, method: 'watch', arguments: []}));
  assert.deepEqual(await f.send('call', 'read', {lease_id: read.lease_id, method: 'read', arguments: ['ok']}), {result: ['ok']});
  await f.send('release', 'read', {lease_id: read.lease_id}); assert.equal(f.handles.size, 0);
});
test('foreground idle drain preserves live watch authority but closes a parked Reader', async t => {
  const f = setup(t, {idleMS: 5000}); await f.hello();
  const watch = await f.send('acquire', 'watch');
  await f.host.drainIdle();
  assert.equal(f.handles.size, 1);
  assert.deepEqual(await f.send('call', 'watch', {lease_id: watch.lease_id, method: 'watch', arguments: ['still-observing']}), {result: ['still-observing']});
  await f.send('release', 'watch', {lease_id: watch.lease_id});
  const read = await f.send('acquire');
  await f.send('release', 'read', {lease_id: read.lease_id, park: true});
  assert.equal(f.handles.size, 1);
  await f.host.drainIdle();
  assert.equal(f.handles.size, 0);
});
for (const firstCommand of ['read', 'watch']) test(`concurrent ${firstCommand} and shared peer join one creation`, async t => {
  const f = setup(t); await f.hello();
  let finish, creations = 0;
  const create = f.driver.create;
  f.driver.create = async (...args) => {
    creations++; const value = await create(...args);
    await new Promise(resolve => {finish = resolve;}); return value;
  };
  const first = f.send('acquire', firstCommand);
  await new Promise(resolve => setImmediate(resolve));
  const peer = firstCommand === 'read' ? 'watch' : 'read';
  const second = f.send('acquire', peer);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creations, 1); finish();
  const leases = await Promise.all([first, second]);
  assert.equal(leases[1].reused, true); assert.equal(f.handles.size, 1);
  await f.send('release', firstCommand, {lease_id: leases[0].lease_id});
  assert.equal(f.handles.size, 1);
  await f.send('release', peer, {lease_id: leases[1].lease_id});
  assert.equal(f.handles.size, 0);
});
test('a peer whose grant expires during shared creation receives no lease', async t => {
  const f = setup(t); await f.hello();
  let finish; const create = f.driver.create;
  f.driver.create = async (...args) => {
    const value = await create(...args); await new Promise(resolve => {finish = resolve;}); return value;
  };
  const read = f.send('acquire'); await new Promise(resolve => setImmediate(resolve));
  const watch = f.send('acquire', 'watch');
  const rejected = assert.rejects(() => watch, {code: 'HOST_STALE'});
  await new Promise(resolve => setImmediate(resolve)); f.setNow(1001001); finish();
  const lease = await read; await rejected;
  assert.equal(f.host.leases.size, 1);
  await f.send('release', 'read', {lease_id: lease.lease_id});
});
test('a rejected creation with no surviving resource does not fence an empty pool', async t => {
  const f = setup(t); await f.hello();
  const create = f.driver.create;
  f.driver.create = async () => {throw Object.assign(new Error('busy'), {code: 'BROWSER_BUSY'});};
  await assert.rejects(() => f.send('acquire'), {code: 'BROWSER_BUSY'});
  assert.equal(f.host.resources.size, 0); assert.equal(f.handles.size, 0);
  f.driver.create = create;
  const lease = await f.send('acquire');
  await f.send('release', 'read', {lease_id: lease.lease_id});
  assert.equal(f.handles.size, 0);
});
test('epoch takeover aborts old calls, rejects queued actions and stale leases', async t => {
  const f = setup(t); await f.hello(); const lease = await f.send('acquire');
  const first = f.send('call', 'read', {lease_id: lease.lease_id, method: 'wait', arguments: []});
  const queued = f.send('call', 'read', {lease_id: lease.lease_id, method: 'read', arguments: []});
  const rejected = Promise.all([assert.rejects(() => first), assert.rejects(() => queued)]);
  await new Promise(resolve => setImmediate(resolve));
  await f.hello(2); await rejected;
  assert.ok(!f.calls.includes('read')); assert.equal(f.handles.size, 0);
  await assert.rejects(() => f.send('heartbeat', 'read', {lease_id: lease.lease_id}), {code: 'HOST_LEASE_INVALID'});
});
test('cleanup failure fences reuse; unknown binding and forged RPC fail before resource creation', async t => {
  const f = setup(t); await f.hello(); const lease = await f.send('acquire');
  f.failClose(true); await assert.rejects(() => f.send('release', 'read', {lease_id: lease.lease_id}));
  await assert.rejects(() => f.send('acquire'), {code: 'HOST_RESOURCE_BUSY'});
  await assert.rejects(() => f.host.control({operation: 'acquire', mac: '0'.repeat(64)}), {code: 'HOST_AUTHORIZATION_DENIED'});
  f.failClose(false); await f.send('release', 'read', {lease_id: lease.lease_id});
  assert.equal(f.handles.size, 0);
});
test('host restart invalidates generation while retaining the epoch high-water mark', async t => {
  const f = setup(t); const hello = await f.hello(8); await f.host.close();
  const next = new BrowserHostPort({authorization: f.authorization, bindings: [f.binding], driver: f.driver, stateDirectory: f.root});
  try {
    assert.equal(next.epoch, 8); assert.notEqual(next.generation, hello.generation);
    await assert.rejects(() => next.control(signHostRequest(f.authorization, {protocol_version: '1.0', operation: 'acquire', epoch: 8,
      generation: hello.generation, authorization_ref: f.refs.read, task_id: 'read'})), {code: 'HOST_STALE'});
    await assert.rejects(() => next.control(signHostRequest(f.authorization, {protocol_version: '1.0', operation: 'hello', epoch: 7, bindings: [digest(f.binding)]})), {code: 'RELEASE_MISMATCH'});
  } finally {await next.close();}
});
test('a parked read page has no action authority and can be reused until the bounded idle expiry', async t => {
  const f = setup(t, {idleMS: 5000}); await f.hello();
  const first = await f.send('acquire');
  await f.send('release', 'read', {lease_id: first.lease_id, park: true});
  await f.send('release', 'read', {lease_id: first.lease_id, park: true});
  assert.equal(f.handles.size, 1);
  await assert.rejects(() => f.send('call', 'read', {lease_id: first.lease_id, method: 'read', arguments: []}), {code: 'HOST_LEASE_INVALID'});
  const next = await f.send('acquire'); assert.equal(next.reused, true);
  await f.send('release', 'read', {lease_id: next.lease_id, park: true});
  f.setNow(1005001); await f.host.expire(); assert.equal(f.handles.size, 0);
});
test('epoch handoff waits for an in-flight creation before admitting another resource', async t => {
  const f = setup(t); await f.hello();
  let finish;
  const original = f.driver.create;
  f.driver.create = async (...args) => {const value = await original(...args); await new Promise(resolve => {finish = resolve;}); return value;};
  const creation = f.send('acquire');
  const rejected = assert.rejects(() => creation, {code: 'HOST_STALE'});
  await new Promise(resolve => setImmediate(resolve));
  let handedOff = false;
  const handoff = f.hello(2).then(() => {handedOff = true;});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(handedOff, false);
  finish(); await handoff; await rejected; assert.equal(f.handles.size, 0);
});

test('invalidating a failed shared read closes the page exactly once and fences its watch', async t => {
  const f = setup(t, {idleMS: 5000, invalidate: true}); await f.hello();
  const watch = await f.send('acquire', 'watch'), read = await f.send('acquire');
  await f.send('release', 'read', {lease_id: read.lease_id, invalidate: true});
  assert.equal(f.calls.filter(call => call === 'close').length, 1);
  assert.equal(f.handles.size, 0);
  await assert.rejects(() => f.send('call', 'watch', {lease_id: watch.lease_id, method: 'watch', arguments: []}), {code: 'HOST_LEASE_INVALID'});
  await f.send('release', 'read', {lease_id: read.lease_id, invalidate: true});
  assert.equal(f.calls.filter(call => call === 'close').length, 1);
});
