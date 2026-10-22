import test from 'node:test';
import assert from 'node:assert/strict';
import {MailboxClient} from '../../applications/mail/client.mjs';
import {mailHandlers} from '../../applications/mail/handlers.mjs';
import {ProviderScriptRegistry} from '../../applications/mail/runtime/provider-scripts.mjs';
import {MailPage} from '../../applications/mail/runtime/mail-page.mjs';

const account = 'owner@example.invalid';
test('QQ sends share only a same-account credential-bound mutation pool', async () => {
  const client = Object.create(MailboxClient.prototype);
  client.config = {owner_id: 'owner', profile_id: 'profile', workspace_root: '/workspace', host_runtime_root: '/host'};
  client.sharedPages = true; client.watches = new Map();
  client.describe = (provider, operation) => ({binding: {manifest: {id: provider}}, command: operation,
    spec: {script_id: operation, revision: 1}, manifest: {side_effect: 'remote_mutation'}});
  client.requestKey = async (_app, _command, task) => task;
  client.client = {authorize: async request => request};
  const request = {provider: 'qq_mail', operation: 'send', input: {account_address: account},
    taskID: 'first', credentialGeneration: 1, token: 'fixture', scriptID: 'send', revision: 1};
  const pool = async change => (await client.admission({...request, ...change})).resource.pool_key;
  const first = await pool({});
  assert.equal(await pool({taskID: 'second'}), first);
  for (const change of [{credentialGeneration: 2}, {input: {account_address: 'other@example.invalid'}},
    {input: {account_address: account, owner_scope: 'different'}}, {operation: 'mark_read', scriptID: 'mark_read'},
    {operation: 'read', scriptID: 'read'}, {provider: 'gmail'}]) assert.notEqual(await pool(change), first);
});

test('parking a QQ send clears private message slots and requires an account-bound ready template', async () => {
  const calls = [];
  const page = new MailPage({call: async (method, ...args) => {
    calls.push([method, args]);
    if (method === 'runReadCode') return {provider: 'qq_mail', account_address: account, ready: true};
  }}, {operation: 'send', provider: 'qq_mail'}, {resource: {document_nonce: 'fresh-document'}});
  assert.equal(await page.parkSendTemplate(account), true);
  assert.deepEqual(calls.at(-1), ['setSecrets', [{}]]);
  assert.deepEqual(page.sendSecrets, {});
});

for (const status of ['sent', 'unknown']) for (const canPark of [true, false]) {
  test(`only proved QQ sends can retain a ready page (${status}/${canPark})`, async t => {
    const previous = process.env.APP_CLI_MAIL_NATIVE_SEND;
    process.env.APP_CLI_MAIL_NATIVE_SEND = 'qq_mail';
    t.after(() => {if (previous === undefined) delete process.env.APP_CLI_MAIL_NATIVE_SEND; else process.env.APP_CLI_MAIL_NATIVE_SEND = previous;});
    let parks = 0;
    t.mock.method(ProviderScriptRegistry.prototype, 'prepare', async function () {
      this.entries = new Map([['fixture', {provider: 'qq_mail', operation: 'send', loginURL: 'https://wx.mail.qq.com/',
        validate() {}, async handler() {return {status};}}]]);
    });
    t.mock.method(MailPage.prototype, 'parkSendTemplate', async () => {parks++; if (!canPark) throw new Error('cleanup failure'); return true;});
    const handlers = await mailHandlers();
    const result = await handlers['qq_mail.send'].run({account_address: account, message: {to: [], body: {content: 'fixture'}}},
      {browser: {reused: false, async call() {}}, resource: {}, beforeEffect() {}});
    if (status === 'sent') {
      assert.equal(result.data.status, 'sent'); assert.equal(result.retain, canPark); assert.equal(parks, 1);
    } else { assert.equal(result.status, 'uncertain'); assert.equal(parks, 0); }
  });
}

test('reused send page cannot dispatch after document or account drift', async t => {
  t.mock.method(ProviderScriptRegistry.prototype, 'prepare', async function () {
    this.entries = new Map([['fixture', {provider: 'qq_mail', operation: 'send', validate() {},
      async handler() {assert.fail('must not dispatch');}}]]);
  });
  const handlers = await mailHandlers();
  const result = await handlers['qq_mail.send'].run({account_address: account, message: {to: [], body: {content: 'fixture'}}},
    {browser: {reused: true, async call(method) {if (method === 'runReadCode') return {error: 'email_account_identity_mismatch'};}},
      resource: {}, beforeEffect() {assert.fail('must not release');}});
  assert.equal(result.status, 'waiting_confirmation');
});
