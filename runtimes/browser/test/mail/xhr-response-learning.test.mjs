import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installReader} from '../../applications/mail/userscripts/lib/reader-core.mjs';
import {installQQSendPrototype} from '../../applications/mail/userscripts/lib/qq-send-prototype.mjs';

const account = 'owner@example.test', recipient = 'recipient@example.test';
const messageid = 'private-response-identifier', emailid = 'private-sent-identifier';
const responseValue = () => ({head: {ret: 0}, body: {messageid}});
const confirmation = {account_address: account, to: [recipient], subject: 'private subject', provider_message_id: emailid};

function fixture(t) {
  const calls = [];
  class XHR {
    open() {} send() {} setRequestHeader() {}
    addEventListener(name, callback) {if (name === 'load') this.loaded = callback;}
  }
  const context = vm.createContext({URL, URLSearchParams, Headers, Response, Blob, AbortController, AbortSignal,
    TextDecoder, TextEncoder, Uint8Array, performance, setTimeout, clearTimeout, structuredClone,
    XMLHttpRequest: XHR, location: {origin: 'https://wx.mail.qq.com', href: 'https://wx.mail.qq.com/home/index'},
    document: {addEventListener() {}, removeEventListener() {}},
    fetch: async (url, options) => {
      calls.push({url, options}); assert.equal(new URL(url).pathname, '/list/maillist');
      const response = new Response(JSON.stringify({head: {ret: 0}, body: {total_num: 1, list: [{
        emailid, messageid, dirid: 3, subject: confirmation.subject,
        senders: {item: [{email: account}]}, receivers: {item: [{email: recipient}]},
      }]}}));
      Object.defineProperty(response, 'url', {value: url}); return response;
    }});
  vm.runInContext(`window=globalThis;top=window;(${installReader.toString()})({provider:'qq_mail',origins:[location.origin],
    account:()=>${JSON.stringify(account)},listURL:()=>false,parse:()=>[],installNativeSend:${installQQSendPrototype.toString()}});`, context);
  const reader = context.SparkClawMailReader;
  t.after(() => reader.dispose());
  const arm = () => reader.armLearning({kind: 'send', capture_send_template: true});
  const request = (type, value) => {
    const xhr = new XHR(); xhr.open('POST', 'https://wx.mail.qq.com/send/sendmail');
    xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded; charset=UTF-8');
    xhr.responseType = type;
    if (type === 'json') {
      xhr.response = value;
      Object.defineProperty(xhr, 'responseText', {get() {assert.fail('responseText is invalid for JSON XHR');}});
    } else xhr.responseText = value;
    xhr.send(new URLSearchParams({calendar: '', content: 'private content', from: account, func: '1',
      is_resume: 'false', is_text: 'false', is_urgent: 'false', language: 'en', mailid: 'private draft',
      need_receipt: 'false', r: '0.1', save_to_send: 'true', separated_copy: 'false', sid: 'private session',
      subject: confirmation.subject, time_zone: '8', time_zone_dst: '0', to: recipient}).toString());
    xhr.status = 200; xhr.responseURL = 'https://wx.mail.qq.com/send/sendmail'; return xhr;
  };
  return {reader, calls, arm, request};
}

for (const type of ['', 'text', 'json']) test(`XHR ${type || 'default text'} shares bounded response evidence with QQ template confirmation`, async t => {
  const f = fixture(t); f.arm();
  const value = Object.freeze({head: Object.freeze({ret: 0}), body: Object.freeze({messageid})});
  const xhr = f.request(type, type === 'json' ? value : JSON.stringify(value));
  assert.doesNotThrow(() => xhr.loaded());
  const entries = JSON.parse(JSON.stringify(f.reader.diagnostics().learning));
  assert.equal(entries.length, 1); assert.equal(entries[0].provider_code, 0);
  assert.equal(entries[0].response_shape.format, 'json');
  assert.equal(entries[0].response_shape.shape.body.messageid, 'string:64');
  assert.equal(JSON.stringify(entries).includes('private'), false);
  assert.equal(await f.reader.confirmSendTemplate(confirmation), true);
  assert.equal(f.reader.sendNativeReady(confirmation).ready, true);
  assert.equal(f.calls.length, 1, 'confirmation performs one independent Sent read and never sends');
  if (type === 'json') assert.equal(xhr.response, value, 'the site retains the identical untouched response object');
});

for (const [label, type, value, format] of [
  ['malformed text', 'text', '{"head":', 'text'],
  ['failed JSON parse', 'json', null, 'empty'],
  ['unsupported binary', 'arraybuffer', new ArrayBuffer(8), 'empty'],
]) test(`XHR ${label} does not certify a send`, async t => {
  const f = fixture(t); f.arm(); const xhr = f.request(type, value);
  assert.doesNotThrow(() => xhr.loaded());
  assert.equal(f.reader.diagnostics().learning[0].response_shape.format, format);
  assert.equal(await f.reader.confirmSendTemplate(confirmation), false); assert.equal(f.calls.length, 0);
});

test('XHR JSON observation does not execute accessors, toJSON hooks or accept cyclic data', async t => {
  let callbacks = 0;
  for (const value of [Object.defineProperty(responseValue(), 'secret', {enumerable: true, get() {callbacks++; return 'private';}}),
    {...responseValue(), toJSON() {callbacks++; return responseValue();}}, (() => {const value = responseValue(); value.self = value; return value;})()]) {
    const f = fixture(t); f.arm();
    assert.doesNotThrow(() => f.request('json', value).loaded());
    assert.equal(f.reader.diagnostics().learning[0].response_shape.format, 'empty');
    assert.equal(await f.reader.confirmSendTemplate(confirmation), false); assert.equal(f.calls.length, 0);
  }
  assert.equal(callbacks, 0);
});

for (const [label, type, value] of [
  ['text bytes', 'text', ' '.repeat((1 << 20) + 1)],
  ['JSON string', 'json', {...responseValue(), extra: 'x'.repeat(1 << 20)}],
  ['JSON escaped string', 'json', {...responseValue(), extra: '\0'.repeat(200000)}],
  ['JSON UTF-8 bytes', 'json', {...responseValue(), extra: '文'.repeat(400000)}],
  ['JSON array width', 'json', {...responseValue(), extra: Array(4097).fill(0)}],
  ['JSON depth', 'json', {...responseValue(), extra: Array.from({length: 40}).reduce(value => ({data: value}), null)}],
]) test(`XHR ${label} exceeding the response budget cannot teach a template`, async t => {
  const f = fixture(t); f.arm(); assert.doesNotThrow(() => f.request(type, value).loaded());
  assert.equal(f.reader.diagnostics().learning[0].response_shape.format, 'too_large');
  assert.equal(await f.reader.confirmSendTemplate(confirmation), false); assert.equal(f.calls.length, 0);
});

test('old JSON XHR replies are not inspected or inserted into a new learning window', async t => {
  const f = fixture(t); f.arm(); const old = f.request('json', responseValue());
  let reads = 0;
  Object.defineProperty(old, 'response', {get() {reads++; return responseValue();}});
  f.arm(); assert.doesNotThrow(() => old.loaded());
  assert.equal(reads, 0);
  assert.equal(f.reader.diagnostics().learning.length, 0);
  assert.equal(await f.reader.confirmSendTemplate(confirmation), false); assert.equal(f.calls.length, 0);
});
