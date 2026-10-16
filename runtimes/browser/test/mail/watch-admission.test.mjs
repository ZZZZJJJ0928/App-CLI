import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

const runtime = new URL('../../', import.meta.url);
const python = process.env.APP_CLI_RECOVERY_PYTHON;
const {Executor} = await import(new URL('src/executor.mjs', runtime));
const {Ledger} = await import(new URL('src/ledger.mjs', runtime));
const {serve} = await import(new URL('src/socket.mjs', runtime));
const {MailboxClient} = await import(new URL('applications/mail/client.mjs', runtime));
const {digest} = await import(new URL('src/protocol.mjs', runtime));
const {mailHandlers} = await import(new URL('applications/mail/handlers.mjs', runtime));
const {MailPage} = await import(new URL('applications/mail/runtime/mail-page.mjs', runtime));

for (const [name, override] of Object.entries({
  active: {execution_expires_ms: Date.now() + 300000},
  missing_expiry: {execution_expires_ms: undefined},
  remote_write: {side_effect: 'remote_write'},
  another_command: {command: 'send'},
  another_app: {app: 'foreign-app'},
  finite_command: {max_deadline_ms: Date.now() + 300000},
  bound_task: {task_id: 'known-task'},
})) test(`unresolved watch cannot replace ${name} authority`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-w-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const saved = {identity: 'previous-binding', sessionKey: 'original-session'};
  const filename = path.join(root, 'watch-' + digest({owner: 'fixture-owner', provider: 'outlook'}) + '.json');
  fs.writeFileSync(filename, JSON.stringify(saved));
  const mailbox = Object.create(MailboxClient.prototype), calls = [];
  mailbox.config = {owner_id: 'fixture-owner'}; mailbox.watches = new Map();
  mailbox.describe = () => ({binding: {manifest: {id: 'mail-outlook'}}, command: 'watch', spec: {renewable: true}, manifest: {side_effect: 'read_only'}});
  mailbox.client = {index: root,
    restore() {return {request: {app: 'mail-outlook', command: 'watch'}, grant: {app: 'mail-outlook', command: 'watch',
      side_effect: 'read_only', task_id: null, max_deadline_ms: null, execution_expires_ms: Date.now() - 1000, ...override}};},
    async control() {calls.push('lookup'); return {kind: 'lookup', outcome: 'unresolved'};},
    async invoke() {assert.fail('must not invoke a replacement');},
  };
  await assert.rejects(mailbox.startWatch({provider: 'outlook', token: 'fixture', credentialGeneration: 1,
    input: {account_address: 'owner@example.test', owner_scope: 'scope'}}), {code: 'ADMISSION_UNRESOLVED'});
  assert.deepEqual(calls, ['lookup']); assert.deepEqual(JSON.parse(fs.readFileSync(filename)), saved);
});

for (const rotate of [false, true]) test(`expired refused watch recovers with original history and a gap (rotate=${rotate})`, {skip: !python}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-w-')); fs.chmodSync(root, 0o700);
  const state = path.join(root, 'state'); fs.mkdirSync(state, {mode: 0o700});
  const binding = JSON.parse(fs.readFileSync(new URL('bindings/mail-outlook.json', runtime)));
  const bindingFile = path.join(root, 'binding.json'); fs.writeFileSync(bindingFile, JSON.stringify(binding), {mode: 0o600});
  const config = {node: process.execPath, runtime_directory: new URL('.', runtime).pathname,
    owner_id: 'fixture-owner', profile_id: 'default', workspace_root: root, host_runtime_root: root,
    state_directory: state, socket: path.join(state, 'e.sock'), grants_directory: path.join(root, 'grants'),
    issuer_key_file: path.join(root, 'issuer'), assembly_module: path.join(root, 'fixture-assembly.mjs'),
    bindings: [{path: bindingFile, digest: digest(binding)}]};
  fs.writeFileSync(config.issuer_key_file, crypto.randomBytes(32), {mode: 0o600});
  const configFile = path.join(root, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config), {mode: 0o600});
  let mailbox = new MailboxClient({configFile, python});
  const ledger = new Ledger(state, {maxTasks: 1});
  t.mock.method(MailPage.prototype, 'prepareMailRound', async () => {});
  let acquisitions = 0;
  const executor = new Executor({ledger, authorization: mailbox.client.authorization, bindings: [binding],
    handlers: await mailHandlers(), host: {async acquire() {
      acquisitions++; let sequence = 0;
      return {async release() {}, async call(method) {
        if (method !== 'hookEvents') return;
        const next = () => ({document: 'fixture-document', sequence: ++sequence, account_ok: true});
        return {cursor: sequence + 2, events: sequence === 0
          ? [{value: {...next(), kind: 'document'}}, {value: {...next(), kind: 'mailbox_changed', reason: 'outlook_delivery_change'}}]
          : [{value: {...next(), kind: 'heartbeat'}}]};
      }};
    }}});
  await executor.start();
  const server = await serve(config.socket, request => executor.control(request));
  t.after(async () => {await executor.close(); await server.close(); ledger.close(); fs.rmSync(root, {recursive: true, force: true});});
  const events = [], spec = binding.commands.watch;
  let request = {provider: 'outlook', operation: 'observe', taskID: 'observer', token: 'fixture-token', credentialGeneration: 1,
    scriptID: spec.script_id, revision: spec.revision,
    input: {action: 'start', account_address: 'owner@example.test', owner_scope: 'a'.repeat(64)},
    onEvent(watch, type, reason) {events.push({type, reason, state: watch.state});}};
  const first = (await mailbox.startWatch(request)).result.watch_epoch;
  await mailbox.pollWatch('outlook'); await mailbox.stopWatch('outlook');
  const originalRow = ledger.get(first);
  assert.equal(originalRow.status, 'cancelled');
  const issue = mailbox.client.authorization.issue.bind(mailbox.client.authorization);
  let expires;
  mailbox.client.authorization.issue = (grant, resource) => {
    expires = Date.now() + 5000;
    return issue({...grant, execution_expires_ms: expires}, resource);
  };
  await assert.rejects(mailbox.startWatch(request), {code: 'LEDGER_CAPACITY_EXCEEDED'});
  const watchFile = path.join(mailbox.client.index, 'watch-' + digest({owner: config.owner_id, provider: 'outlook'}) + '.json');
  const refused = fs.readFileSync(watchFile, 'utf8'), saved = JSON.parse(refused);
  assert.equal(saved.taskID, undefined); assert.equal(saved.previousTask, first);
  const key = await mailbox.requestKey(binding.manifest.id, 'watch', saved.sessionKey, {allocate: false});
  const keyFile = mailbox.client.headFile({principal: 'product-owner', owner: config.owner_id, request_key: key});
  const originalIndex = fs.readFileSync(keyFile, 'utf8');
  ledger.maxTasks = 0;
  mailbox = new MailboxClient({configFile, python}); // Cold product restart.
  if (rotate) request = {...request, credentialGeneration: 2, token: 'rotated-fixture-token'};
  const calls = [], machine = mailbox.client.machine.bind(mailbox.client);
  mailbox.client.machine = request => {calls.push(request.operation); return machine(request);};
  await assert.rejects(mailbox.startWatch(request), {code: 'ADMISSION_UNRESOLVED'});
  assert.deepEqual(calls, ['lookup']); assert.equal(fs.readFileSync(watchFile, 'utf8'), refused);
  await delay(Math.max(0, expires - Date.now() + 20));
  // A finite short signed window makes the real public renewal path observable.
  const recoveredIssue = mailbox.client.authorization.issue.bind(mailbox.client.authorization);
  mailbox.client.authorization.issue = (grant, resource) => recoveredIssue({...grant,
    execution_expires_ms: grant.revision === 1 ? Date.now() + 30000 : grant.execution_expires_ms}, resource);
  const result = await mailbox.startWatch(request), current = mailbox.watches.get('outlook');
  assert.notEqual(result.result.watch_epoch, first);
  assert.equal(current.admission.resource.previous_request_key, key);
  assert.equal(current.admission.resource.previous_task_id, first);
  assert.equal(current.admission.resource.credential_generation, rotate ? 2 : 1);
  await mailbox.pollWatch('outlook');
  assert.equal(mailbox.watchStatus('outlook').result.status, 'watching');
  assert.ok(events.some(event => event.type === 'resync_required' && event.state === 'watching'));
  assert.ok(events.some(event => event.type === 'mailbox_changed' && event.reason === 'outlook_delivery_change'));
  const response = await mailbox.client.control(current.admission, 'events', current.task.id, {cursor: 0, limit: 100});
  assert.ok(response.events.some(event => event.type === 'gap' && event.payload.reason === 'watch_admission_unresolved' && event.payload.previous_request_key === key));
  await mailbox.pollWatch('outlook', {renew: true});
  assert.equal(ledger.get(current.task.id).grant_revision, 2);
  const reopened = new MailboxClient({configFile, python});
  assert.equal((await reopened.startWatch(request)).result.watch_epoch, current.task.id, 'known admission must keep the original task');
  assert.equal(acquisitions, 2); assert.equal(calls.filter(op => op === 'invoke').length, 1);
  assert.deepEqual(ledger.get(first), originalRow); assert.equal(fs.readFileSync(keyFile, 'utf8'), originalIndex);
  assert.equal(ledger.db.prepare('select count(*) as n from tasks').get().n, 2);
  await reopened.stopWatch('outlook');
});
