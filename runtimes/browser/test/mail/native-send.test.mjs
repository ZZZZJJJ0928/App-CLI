import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {qqHost, sendInput, owner, recipient} from './native-send-fixture.mjs';
import {openSendJournal} from '../../applications/mail/lib/send-journal.mjs';
import {nativeSendFor, sendManagedMail, validateManagedSend} from '../../applications/mail/lib/managed-send.mjs';
import {nativeSendPlan} from '../../applications/mail/lib/native-send.mjs';
import {sendAdmission, NATIVE_SEND_RELEASE} from '../../applications/mail/lib/native-send-config.mjs';
import {QQ_NATIVE_SEND} from '../../applications/mail/lib/qq-native-send.mjs';
import {outputSchema} from '../../applications/mail/output-schema.mjs';
import {providerScriptContract} from '../../applications/mail/runtime/provider-scripts.mjs';

const validReceipt = new Ajv2020({strict: false}).compile(outputSchema('qq_mail', 'send'));
const content = 'Private body text';
const journal = f => openSendJournal(f.dir, validateManagedSend(sendInput(), 'qq_mail'));
const sendmail = f => f.sends.map(send => new URLSearchParams(send.options.body)).filter(form => form.get('func') === '1');
function noContentOutsideDispatch(f) {
  for (const value of [...f.codeRequests.map(request => request.code), ...f.readCodes, JSON.stringify(f.secrets)]) {
    assert.equal(value.includes(content), false); assert.equal(value.includes(recipient), false);
  }
  const carriers = f.codeRequests.filter(request => JSON.stringify(request.argument).includes(content));
  assert.ok(carriers.length <= 1, 'content travels once');
  if (carriers.length) assert.equal(carriers[0].argument.value.token !== undefined, true, 'only with the dispatch call');
}

test('a cold page sends with two page calls, no probe slots, no fixed wait and no Sent read', async t => {
  const f = await qqHost(t);
  const result = await f.run();
  assert.deepEqual(result.data, {schema_version: 1, status: 'sent', provider: 'qq_mail', recipient_digest: validateManagedSend(sendInput(), 'qq_mail').recipientDigest});
  assert.equal(validReceipt(result.data), true);
  assert.equal(result.retain, true); assert.equal(result.invalidate, false);
  assert.deepEqual(f.calls, ['navigate', 'runCodeRequest', 'runCodeRequest']);
  assert.equal(f.reads, 0); assert.equal(sendmail(f).length, 1); assert.deepEqual(f.secrets, []);
  assert.equal(f.reserve, 1); assert.equal(f.release, 1);
  assert.ok(f.codeRequests.every(request => request.timeout === 30000));
  noContentOutsideDispatch(f);
  const saved = (await journal(f)).saved;
  assert.equal(saved.stage, 'sent');
  assert.deepEqual(saved.evidence.proof, {source: 'qq_sendmail_v1', mailid: 'ZC0001-mail', messageid: 'ZL0001-msg'});
  assert.equal(saved.evidence.template_version, 'qq_sendmail_v1');
  assert.equal(JSON.stringify(saved).includes(content), false); assert.equal(JSON.stringify(saved).includes('cookie-sid'), false);
});

test('a warm page reuses its document and Reader; a reloaded page sends without any DOM teaching', async t => {
  const f = await qqHost(t);
  assert.equal((await f.run()).data.status, 'sent');
  f.browser.reused = true; f.calls.length = 0;
  assert.equal((await f.run(sendInput({invocation_id: 'second'}))).data.status, 'sent');
  assert.deepEqual(f.calls, ['runCodeRequest', 'runCodeRequest'], 'no navigation, setSecrets or round reset on a warm page');
  // The page was replaced since the last admission: one recovery navigation.
  f.reload(); f.calls.length = 0;
  assert.equal((await f.run(sendInput({invocation_id: 'third'}))).data.status, 'sent');
  assert.deepEqual(f.calls, ['runCodeRequest', 'runReadCode', 'runCodeRequest', 'runCodeRequest']);
  assert.equal(sendmail(f).length, 3); assert.equal(f.release, 3); assert.equal(f.reads, 0);
});

test('an unavailable Reader is reported after one recovery and never falls back to a DOM send', async t => {
  const f = await qqHost(t);
  f.readerMissing = true; f.reload();
  await assert.rejects(f.run(), {code: 'EMAIL_NATIVE_SEND_UNAVAILABLE'});
  assert.deepEqual(f.calls, ['navigate', 'runCodeRequest', 'runReadCode', 'runCodeRequest']);
  assert.equal(f.release, 0); assert.equal(f.sends.length, 0); assert.deepEqual(f.secrets, []);
  assert.equal((await journal(f)).saved, null, 'nothing was claimed');
});

for (const [label, setup, reason] of [
  ['a visible login page', f => { f.login = true; }, 'EMAIL_LOGIN_REQUIRED'],
  ['an account that cannot be determined', f => { f.context.account = ''; }, 'EMAIL_ACCOUNT_IDENTITY_UNAVAILABLE'],
  ['a different account', f => { f.context.account = 'other@example.test'; }, 'EMAIL_ACCOUNT_IDENTITY_MISMATCH'],
]) test(`${label} stops before release, with nothing sent`, async t => {
  const f = await qqHost(t); setup(f);
  const result = await f.run();
  assert.deepEqual({status: result.status, reason: result.reason}, {status: 'waiting_confirmation', reason});
  assert.equal(f.release, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.calls.filter(call => call === 'runCodeRequest').length, 1, 'no recovery navigation for login or account');
  if (reason === 'EMAIL_ACCOUNT_IDENTITY_UNAVAILABLE') assert.ok(f.now >= 5000 && f.now < 5200, 'a cold page waits at most 5 s');
});

for (const [code, category] of QQ_NATIVE_SEND.rejections) test(`QQ code ${code} is provider_rejected (${category}) and acknowledged as not_sent`, async t => {
  const f = await qqHost(t, {reply: {body: {head: {ret: code}}}});
  const result = await f.run();
  const reason = {login: 'PROVIDER_LOGIN_REJECTED', parameter: 'PROVIDER_PARAMETER_REJECTED', temporary: 'PROVIDER_TEMPORARILY_REJECTED'}[category];
  assert.equal(result.data.status, 'not_sent');
  assert.deepEqual(result.data.not_sent, {schema_version: 1, kind: 'provider_rejected', invocation_id: 'native-fixture', task_id: 'task-native',
    intent_digest: 'a'.repeat(64), resource_digest: 'b'.repeat(64), binding_digest: 'c'.repeat(64), ledger_epoch: 1, reason, provider_code: code});
  assert.equal(validReceipt(result.data), true, JSON.stringify(validReceipt.errors));
  assert.equal(result.retain, category !== 'login'); assert.equal(result.invalidate, category === 'login');
  assert.equal(f.sends.length, 1); assert.equal(f.reads, 0, 'a listed rejection needs no Sent lookup');
  const saved = (await journal(f)).saved;
  assert.equal(saved.stage, 'not_sent'); assert.deepEqual(saved.receipt, result.data);
  // Never sent again, and a reconcile returns the same proof.
  assert.equal((await f.run()).status, 'uncertain'); assert.equal(f.sends.length, 1);
  assert.deepEqual((await f.reconcile(sendInput())).data, result.data);
});

test('a provider_rejected proof cannot be forged with an unlisted code or a mismatched category', () => {
  const base = {schema_version: 1, provider: 'qq_mail', status: 'not_sent', recipient_digest: 'sha256:' + 'd'.repeat(64),
    not_sent: {schema_version: 1, kind: 'provider_rejected', invocation_id: 'i', task_id: 't', intent_digest: 'a'.repeat(64),
      resource_digest: 'b'.repeat(64), binding_digest: 'c'.repeat(64), ledger_epoch: 1, reason: 'PROVIDER_LOGIN_REJECTED', provider_code: -20002}};
  assert.equal(validReceipt(base), true);
  for (const change of [{provider_code: -1}, {provider_code: -21519}, {reason: 'EMAIL_DRAFT_FIELDS_UNVERIFIED'}, {provider_code: undefined}])
    assert.equal(validReceipt({...base, not_sent: JSON.parse(JSON.stringify({...base.not_sent, ...change}))}), false, JSON.stringify(change));
  assert.equal(validReceipt({...base, not_sent: {...base.not_sent, kind: 'pre_dispatch_failure', reason: 'EMAIL_DRAFT_FIELDS_UNVERIFIED'}}), false,
    'provider_code belongs to provider_rejected only');
  assert.equal(new Ajv2020({strict: false}).compile(outputSchema('gmail', 'send'))({...base, provider: 'gmail'}), false);
});

for (const [label, reply, rows, outcome] of [
  ['an unlisted code with a matching fresh Sent row', {body: {head: {ret: -1}}}, true, 'sent'],
  ['an unlisted code without a Sent row', {body: {head: {ret: -20001}}}, false, 'uncertain'],
  ['a lost response with a matching Sent row', {throws: true}, true, 'sent'],
  ['a lost response without a Sent row', {throws: true}, false, 'uncertain'],
  ['ret=0 without identifiers', {body: {head: {ret: 0}, body: {}}}, false, 'uncertain'],
  ['a non-JSON response', {text: '<html></html>'}, false, 'uncertain'],
]) test(`pending confirmation after ${label} runs one bounded lookup and never resends`, async t => {
  const f = await qqHost(t, {reply});
  if (rows) f.rows = [f.row({emailid: 'found-sent-id'})];
  const result = await f.run();
  if (outcome === 'sent') {
    assert.equal(result.data.status, 'sent'); assert.equal(result.data.provider_message_id, 'found-sent-id');
    assert.equal((await journal(f)).saved.evidence.proof.source, 'qq_sent_list_v1');
  } else {
    assert.deepEqual(result, {status: 'uncertain', reason: 'SEND_OUTCOME_UNKNOWN'});
    assert.equal((await journal(f)).saved.stage, 'dispatching');
    assert.ok(f.now <= 13000, 'the lookup is time-bounded');
  }
  assert.deepEqual(f.calls, ['navigate', 'runCodeRequest', 'runCodeRequest', 'runCodeRequest']);
  assert.ok(f.reads >= 1);
  const again = await f.run();
  assert.equal(sendmail(f).length, 1, 'never dispatched twice');
  if (outcome !== 'sent') assert.equal(again.status, 'uncertain');
});

test('a ticket invalidated after release is refused before the request and stays pending', async t => {
  const f = await qqHost(t);
  const result = await f.run(sendInput(), {releaseDispatch: async () => { f.release++; f.now += 60001; }});
  assert.equal(result.status, 'uncertain'); assert.equal(f.sends.length, 0); assert.equal(f.release, 1);
});

test('a rejected dispatch release sends nothing', async t => {
  const f = await qqHost(t); f.releaseFails = true;
  await assert.rejects(f.run(), {code: 'AUTHORIZATION_STALE'});
  assert.equal(f.sends.length, 0);
});

test('the response mailid becomes the receipt ID only behind its release switch', async t => {
  const f = await qqHost(t);
  const runtime = {emailWorkspaceRoot: f.dir, documentNonce: 'document-1', reusedPage: false, reserveDispatch() {}, releaseDispatch: async () => {},
    nativeSendRelease: {qq_mail: {enabled: true, receipt_provider_message_id: true}},
    withSendTab: callback => callback({runCodeRequest: (code, argument, timeout) => f.browser.call('runCodeRequest', code, argument, timeout),
      navigate: url => f.browser.call('runReadCode', `async page=>{await page.goto(${JSON.stringify(url)});return true}`)})};
  assert.equal((await sendManagedMail(sendInput(), 'qq_mail', runtime)).provider_message_id, 'ZC0001-mail');
  assert.equal(NATIVE_SEND_RELEASE.qq_mail.receipt_provider_message_id, false, 'off until mailid == emailid is checked live');
});

test('v1 scope: only QQ compose with one recipient, no cc and no attachments, behind the release switch', () => {
  const request = validateManagedSend(sendInput(), 'qq_mail');
  assert.ok(nativeSendFor('qq_mail', sendInput()));
  assert.equal(nativeSendPlan('qq_mail', request, {qq_mail: {enabled: false}}), null);
  for (const change of [{message: {to: [recipient, 'b@example.test']}}, {message: {cc: ['c@example.test']}},
    {mode: 'reply', reply_target: {account_address: owner, provider_message_id: 'm', provider_selection_id: 'm', folder: 'inbox', subject: 's'}}])
    assert.equal(nativeSendFor('qq_mail', sendInput(change)), null, JSON.stringify(change));
  for (const provider of ['gmail', 'outlook']) assert.equal(nativeSendFor(provider, sendInput({provider})), null);
  assert.equal(nativeSendFor('qq_mail', {provider: 'qq_mail', message: {}}), null, 'invalid input is never native');
});

test('only providers with an in-page account check declare in-page send admission', () => {
  assert.equal(sendAdmission('qq_mail'), 'in_page');
  assert.equal(sendAdmission('gmail'), undefined); assert.equal(sendAdmission('outlook'), undefined);
  const sends = providerScriptContract().scripts.filter(script => script.operation === 'send');
  assert.deepEqual(sends.map(script => [script.provider, script.send_admission]), [['gmail', undefined], ['outlook', undefined], ['qq_mail', 'in_page']]);
  assert.ok(providerScriptContract().scripts.filter(script => script.operation !== 'send').every(script => script.send_admission === undefined));
});
