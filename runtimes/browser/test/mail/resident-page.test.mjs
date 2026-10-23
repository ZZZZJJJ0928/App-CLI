import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mailHandlers} from '../../applications/mail/handlers.mjs';
import {ProviderScriptRegistry} from '../../applications/mail/runtime/provider-scripts.mjs';
import {MailboxClient} from '../../applications/mail/client.mjs';

const account = 'owner@example.invalid', scope = 'a'.repeat(64);
function mailbox() {
  const value = Object.create(MailboxClient.prototype);
  value.config = {owner_id: 'owner', profile_id: 'profile', workspace_root: '/fixture', host_runtime_root: '/host'};
  value.sharedPages = true; value.watches = new Map();
  value.describe = (provider, operation) => ({binding: {manifest: {id: `mail-${provider}`}},
    command: operation === 'observe' ? 'watch' : operation,
    spec: {script_id: operation, revision: 1}, manifest: {side_effect: ['send', 'mark_read'].includes(operation) ? 'remote_mutation' : 'read_only'}});
  value.requestKey = async (app, command, task) => task;
  value.client = {authorize: async request => ({request, resource: request.resource})};
  return value;
}
function request(operation, input = {}, extra = {}) {
  return {provider: 'gmail', operation, input: {owner_scope: scope, ...input}, taskID: `task-${operation}`,
    credentialGeneration: 1, token: 'fixture-token', scriptID: operation, revision: 1, ...extra};
}
test('receive operations share only the exact account, scope, credentials and binding pool', async () => {
  const m = mailbox();
  const watch = await m.admission(request('observe', {account_address: account}));
  for (const [operation, input] of [['collect_page', {discovery: {account_address: account}}],
    ['discover', {discovery: {account_address: account}}], ['capture', {target: {account_address: account}}],
    ['enumerate_thread', {thread: {account_address: account}}]]) {
    const result = await m.admission(request(operation, input));
    assert.equal(result.resource.pool_key, watch.resource.pool_key, operation);
    for (const changed of [request(operation, {...input, owner_scope: 'b'.repeat(64)}),
      request(operation, input, {credentialGeneration: 2}), request(operation, {...input, account_address: 'other@example.invalid'})]) {
      assert.notEqual((await m.admission(changed)).resource.pool_key, watch.resource.pool_key);
    }
  }
  for (const operation of ['send', 'mark_read']) {
    const first = await m.admission(request(operation, {account_address: account}));
    const next = await m.admission(request(operation, {account_address: account}, {taskID: `next-${operation}`}));
    assert.notEqual(first.resource.pool_key, watch.resource.pool_key);
    assert.notEqual(first.resource.pool_key, next.resource.pool_key);
  }
});
test('probe can reuse only a live watch with matching current credentials', async () => {
  const m = mailbox(), watch = await m.admission(request('observe', {account_address: account}));
  m.watches.set('gmail', {task: {status: 'running'}, admission: watch});
  const probe = request('probe', {}, {input: {}});
  const bound = await m.admission(probe);
  assert.equal(bound.resource.pool_key, watch.resource.pool_key);
  assert.equal(bound.resource.account_address, account);
  assert.deepEqual(bound.request.arguments, {}); // Public probe input is unchanged.
  for (const changed of [{credentialGeneration: 2}, {token: 'rotated-token'}]) {
    assert.notEqual((await m.admission({...probe, ...changed})).resource.pool_key, watch.resource.pool_key);
  }
  m.watches.get('gmail').task.status = 'failed';
  assert.notEqual((await m.admission(probe)).resource.pool_key, watch.resource.pool_key);
  m.watches.clear();
  assert.notEqual((await m.admission(probe)).resource.pool_key, watch.resource.pool_key);
  m.sharedPages = false;
  assert.notEqual((await m.admission(request('capture', {target: {account_address: account}}))).resource.pool_key, watch.resource.pool_key);
});

test('explicit Sent reads have separate task pages and never borrow a watch account', async () => {
  const m=mailbox(),watch=await m.admission(request('observe',{account_address:account}));
  m.watches.set('gmail',{task:{status:'running'},admission:watch});
  const sent_match={folder:'sent',subject:'fixture',recipient:'recipient@example.invalid',
    interval_start:'2026-09-10T00:00:00Z',interval_end:'2026-09-11T00:00:00Z'};
  const first=await m.admission(request('read',{account_address:account,sent_match}));
  const second=await m.admission(request('read',{account_address:account,sent_match},{taskID:'next-sent'}));
  assert.notEqual(first.resource.pool_key,watch.resource.pool_key);
  assert.notEqual(first.resource.pool_key,second.resource.pool_key);
  const unbound=await m.admission(request('read',{sent_match}));
  assert.equal(unbound.resource.account_address,'');
  assert.equal(unbound.request.arguments.account_address,undefined);
  assert.notEqual(unbound.resource.pool_key,watch.resource.pool_key);
});

test('explicit Sent read closes its owned page instead of parking it in the inbound pool', async t => {
  let resets=0;
  t.mock.method(ProviderScriptRegistry.prototype,'prepare',async function(){
    this.entries=new Map([['fixture',{provider:'gmail',operation:'read',validate(){},async handler(){return {status:'collected'};}}]]);
  });
  const handlers=await mailHandlers();
  const output=await handlers['gmail.read'].run({account_address:account,sent_match:{folder:'sent'}},{
    resource:{account_address:account},beforeEffect(){},browser:{reused:true,async call(method){
      if(method==='runReadCode'){resets++;return {provider:'gmail',account_address:account};}
    }},
  });
  assert.equal(output.retain,false);assert.equal(output.invalidate,true);
  assert.equal(resets,1,'only the pre-read identity reset runs; Sent has no receive-page park');
});

for (const operation of ['probe', 'discover', 'capture', 'enumerate_thread', 'collect_page']) {
  test(`${operation} reuses the receive page without navigation and resets before and after`, async t => {
    const status = {probe: 'ready', discover: 'listed', capture: 'collected', enumerate_thread: 'complete_for_observation', collect_page: 'partial'}[operation];
    const calls = [], result = {status};
    t.mock.method(ProviderScriptRegistry.prototype, 'prepare', async function () {
      this.entries = new Map([['fixture', {provider: 'gmail', operation, loginURL: 'https://mail.google.com/',
        validate() {}, async handler() {calls.push('handler'); return result;}}]]);
    });
    const handlers = await mailHandlers();
    const output = await handlers[`gmail.${operation}`].run({}, {resource: {account_address: account}, beforeEffect() {calls.push('local-effect');},
      browser: {reused: true, async call(method) {
        calls.push(method); assert.notEqual(method, 'navigate');
        if (method === 'runReadCode') return {provider: 'gmail', account_address: account};
      }}});
    assert.equal(output.retain, true); assert.equal(output.invalidate, false);
    assert.equal(calls.filter(call => call === 'runReadCode').length, 2);
    assert.ok(calls.indexOf('runReadCode') < calls.indexOf('handler'));
    assert.equal(calls.at(-1), 'runReadCode');
  });
}
test('account drift rejects a reused probe before the handler and invalidates its page', async t => {
  t.mock.method(ProviderScriptRegistry.prototype, 'prepare', async function () {
    this.entries = new Map([['fixture', {provider: 'gmail', operation: 'probe', validate() {},
      handler() {assert.fail('must not inspect a different account');}}]]);
  });
  const handlers = await mailHandlers();
  const result = await handlers['gmail.probe'].run({}, {resource: {account_address: account}, browser: {reused: true,
    async call(method) {if (method === 'runReadCode') return {error: 'email_account_identity_mismatch'};}}});
  assert.equal(result.reason, 'EMAIL_ACCOUNT_IDENTITY_MISMATCH'); assert.equal(result.invalidate, true);
});
test('generated bindings keep receive families separate from effectful tasks', async () => {
  for (const provider of ['gmail', 'outlook', 'qq-mail']) {
    const binding = JSON.parse(await fs.readFile(new URL(`../../bindings/mail-${provider}.json`, import.meta.url)));
    const shared = binding.commands.watch.host;
    for (const operation of ['probe', 'read', 'discover', 'capture', 'enumerate_thread', 'collect_page']) {
      const host = binding.commands[operation].host;
      assert.equal(host.family, shared.family); assert.equal(host.activity, 'read');
      assert.equal(host.page.readOnlyCode, true); assert.ok(host.page.hook);
    }
    const name = provider.replace('-', '_');
    for (const operation of ['send', 'mark_read']) {
      const command = binding.commands[operation], host = command.host;
      // Mutations share one per-provider lane, never the inbound page's lane
      // or another provider's (whole-profile exclusivity is not requested).
      assert.equal(command.resource, `${name}.mutation`); assert.equal(host.family, `${name}.mutation`);
      assert.notEqual(command.resource, binding.commands.collect_page.resource);
      assert.notEqual(host.family, shared.family); assert.equal(host.activity, 'mutation');
      assert.equal(host.reuse_idle_ms, name === 'qq_mail' && operation === 'send' ? 900000 : 0);
      assert.equal(host.page.hook, undefined);
    }
  }
});
