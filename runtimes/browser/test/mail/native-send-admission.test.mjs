import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mailHandlers} from '../../applications/mail/handlers.mjs';
import {ProviderScriptRegistry} from '../../applications/mail/runtime/provider-scripts.mjs';

const account = 'owner@example.invalid';
const input = {account_address: account, message: {to: ['recipient@example.invalid'], subject: 'fixture',
  body: {content: 'private message'}}};

function pageFixture({reused, documentNonce, failClear = false}) {
  const calls = [], counters = {reset: 0, ready: 0, clear: 0};
  const window = {__sparkclawMailDocument: documentNonce, SparkClawMailReader: {
    provider: 'qq_mail', version: '0.2.0',
    resetRound(request) {counters.reset++; assert.equal(request.account_address, account); return {provider: 'qq_mail', account_address: account};},
    sendNativeReady() {counters.ready++; return {provider: 'qq_mail', account_address: account, ready: true};},
  }};
  const sandbox = vm.createContext({window, document: {querySelectorAll: () => []}, Date, setTimeout});
  const browser = {reused, async call(method, ...args) {
    calls.push(method);
    if (method === 'runReadCode') return vm.runInContext(`(${args[0]})`, sandbox)({evaluate: (fn, value) => fn(value)});
    if (method === 'setSecrets' && Object.keys(args[0]).length === 0) {
      counters.clear++;
      if (failClear) throw Object.assign(new Error('private slots failed to clear'), {code: 'browser_extension_unavailable'});
    }
  }};
  return {browser, counters, calls, window};
}

test('a reloaded send page loses its template and sends as a cold page', async t => {
  let sends = 0;
  t.mock.method(ProviderScriptRegistry.prototype, 'prepare', async function () {
    this.entries = new Map([['fixture', {provider: 'qq_mail', operation: 'send', loginURL: 'https://wx.mail.qq.com/', validate() {},
      async handler() {sends++; return {status: 'not_sent'};}}]]);
  });
  const handlers = await mailHandlers();
  const f = pageFixture({reused: true, documentNonce: 'replaced-document'});
  const result = await handlers['qq_mail.send'].run(input, {browser: f.browser,
    resource: {document_nonce: 'authorized-document'}, beforeEffect() {assert.fail('must not release dispatch');}});
  assert.equal(result.data.status, 'not_sent');
  assert.equal(sends, 1, 'the managed DOM flow runs on a freshly navigated page');
  assert.ok(f.calls.indexOf('navigate') > f.calls.indexOf('runReadCode'), 'navigation follows the stale document check');
  assert.equal(f.counters.reset, 0, 'stale document must not be relabeled through resetRound');
  assert.equal(f.counters.ready, 0);
});

test('a reused send page with a different account still waits for confirmation', async t => {
  t.mock.method(ProviderScriptRegistry.prototype, 'prepare', async function () {
    this.entries = new Map([['fixture', {provider: 'qq_mail', operation: 'send', loginURL: 'https://wx.mail.qq.com/', validate() {},
      async handler() {assert.fail('must not run');}}]]);
  });
  const handlers = await mailHandlers();
  const f = pageFixture({reused: true, documentNonce: 'authorized-document'});
  f.window.SparkClawMailReader.resetRound = () => {throw Object.assign(new Error('mismatch'), {code: 'email_account_identity_mismatch'});};
  const result = await handlers['qq_mail.send'].run(input, {browser: f.browser,
    resource: {document_nonce: 'authorized-document'}, beforeEffect() {assert.fail('must not release dispatch');}});
  assert.equal(result.status, 'waiting_confirmation');
  assert.ok(!f.calls.includes('navigate'));
});

test('private-slot clearing failure preserves a proved send and forbids page retention', async t => {
  const previous = process.env.APP_CLI_MAIL_NATIVE_SEND;
  process.env.APP_CLI_MAIL_NATIVE_SEND = 'qq_mail';
  t.after(() => {if (previous === undefined) delete process.env.APP_CLI_MAIL_NATIVE_SEND; else process.env.APP_CLI_MAIL_NATIVE_SEND = previous;});
  let sends = 0;
  const receipt = {status: 'sent', provider: 'qq_mail', provider_message_id: 'proved-sent-message'};
  t.mock.method(ProviderScriptRegistry.prototype, 'prepare', async function () {
    this.entries = new Map([['fixture', {provider: 'qq_mail', operation: 'send', loginURL: 'https://wx.mail.qq.com/',
      validate() {}, async handler() {sends++; return receipt;}}]]);
  });
  const handlers = await mailHandlers(), f = pageFixture({reused: false, failClear: true});
  const result = await handlers['qq_mail.send'].run(input,
    {browser: f.browser, resource: {document_nonce: 'authorized-document'}, beforeEffect() {}});
  assert.equal(sends, 1); assert.equal(result.data, receipt);
  assert.equal(result.retain, false);
  assert.equal(f.counters.reset, 1); assert.equal(f.counters.ready, 1); assert.equal(f.counters.clear, 1);
  assert.equal(f.calls.at(-1), 'setSecrets');
});
