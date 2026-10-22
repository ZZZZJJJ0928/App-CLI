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
  return {browser, counters, calls};
}

test('same-account ready template cannot survive a changed owned document nonce', async t => {
  let sends = 0;
  t.mock.method(ProviderScriptRegistry.prototype, 'prepare', async function () {
    this.entries = new Map([['fixture', {provider: 'qq_mail', operation: 'send', validate() {},
      async handler() {sends++; return {status: 'sent'};}}]]);
  });
  const handlers = await mailHandlers();
  const f = pageFixture({reused: true, documentNonce: 'replaced-document'});
  await assert.rejects(handlers['qq_mail.send'].run(input, {browser: f.browser,
    resource: {document_nonce: 'authorized-document'}, beforeEffect() {assert.fail('must not release dispatch');}}),
  {code: 'BROWSER_PAGE_STALE'});
  assert.equal(sends, 0);
  assert.equal(f.counters.reset, 0, 'stale document must not be relabeled through resetRound');
  assert.equal(f.counters.ready, 0);
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
