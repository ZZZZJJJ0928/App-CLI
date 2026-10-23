import test from 'node:test';
import assert from 'node:assert/strict';
import {mailHandlers} from '../../applications/mail/handlers.mjs';
import {ProviderScriptRegistry} from '../../applications/mail/runtime/provider-scripts.mjs';
import {sendInput} from './native-send-fixture.mjs';

// Admission-time page preparation differs only by path: a native send keeps
// its content out of the private slots and prepares nothing else (its
// preflight checks document and account), the DOM flow keeps both.
function fixture(t, {reused}) {
  const calls = [];
  t.mock.method(ProviderScriptRegistry.prototype, 'prepare', async function () {
    this.entries = new Map([['fixture', {provider: 'qq_mail', operation: 'send', loginURL: 'https://wx.mail.qq.com/', validate() {},
      async handler() {calls.push('handler'); return {status: 'sent'};}}]]);
  });
  const browser = {reused, async call(method, ...args) {calls.push(method === 'setSecrets' ? `setSecrets:${Object.keys(args[0]).length}` : method);}};
  return {calls, run: async input => (await mailHandlers())['qq_mail.send'].run(input, {browser, resource: {document_nonce: 'document'}, beforeEffect() {}})};
}

for (const reused of [false, true]) test(`a native send on a ${reused ? 'reused' : 'cold'} page uses no private slots or round reset`, async t => {
  const f = fixture(t, {reused});
  const result = await f.run(sendInput());
  assert.deepEqual(f.calls, [...(reused ? [] : ['navigate']), 'handler']);
  assert.equal(result.retain, true);
});

for (const reused of [false, true]) test(`a DOM send on a ${reused ? 'reused' : 'cold'} page keeps its private slots and background page`, async t => {
  const f = fixture(t, {reused});
  const result = await f.run(sendInput({message: {cc: ['copy@example.test']}}));
  assert.deepEqual(f.calls, ['setSecrets:4', ...(reused ? [] : ['navigate']), 'prepareBackgroundPage', 'handler']);
  assert.equal(result.retain, false, 'DOM send pages are not parked');
});
