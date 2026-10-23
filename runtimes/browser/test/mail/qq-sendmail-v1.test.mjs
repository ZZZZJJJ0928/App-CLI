import assert from 'node:assert/strict';
import test from 'node:test';
import {qqPlainTextHTML, qqSendmailSid, qqTimeZone} from '../../applications/mail/userscripts/lib/qq-sendmail-v1.mjs';
import {QQ_NATIVE_SEND} from '../../applications/mail/lib/qq-native-send.mjs';
import {qqPage, owner, recipient} from './native-send-fixture.mjs';

const NBSP = '\u00a0', EN = '\u2002';
const plain = value => JSON.parse(JSON.stringify(value));
const message = {account_address: owner, to: [recipient], cc: [], subject: 'Subject', text: 'Hello'};

test('qq_sendmail_v1 body follows XmailEditor gu() and text-node serialization', () => {
  for (const [text, html] of [
    ['Hello', '<div>Hello</div>'],
    [' lead', `<div>&nbsp;lead</div>`],
    ['trail ', `<div>trail&nbsp;</div>`],
    ['a  b', `<div>a &nbsp;b</div>`],
    ['a   b', `<div>a &nbsp; b</div>`],
    ['a    b', `<div>a &nbsp; &nbsp;b</div>`],
    ['  x', `<div>&nbsp; x</div>`],
    ['\tx', `<div>${EN.repeat(6)}x</div>`],
    ['ab\tc', `<div>ab${EN.repeat(4)}c</div>`],
    ['abcdef\tg', `<div>abcdef${EN.repeat(6)}g</div>`],
    ['x\r', '<div>x</div>'],
    ['<a> & "b" \'c\'', `<div>&lt;a&gt; &amp; "b" 'c'</div>`],
    ['one\n\ntwo', '<div>one</div><div><br></div><div>two</div>'],
    ['one\r\ntwo\n', '<div>one</div><div>two</div><div><br></div>'],
    ['', '<div><br></div>'],
    [' ', '<div>&nbsp;</div>'],
  ]) assert.equal(qqPlainTextHTML(text), html, JSON.stringify(text));
  assert.equal(qqPlainTextHTML(`x${NBSP}y`), '<div>x&nbsp;y</div>', 'a literal no-break space serializes as innerHTML does');
});

test('qq_sendmail_v1 time zones use QQ formulas, including a DST zone', () => {
  const zone = (january, now) => class {
    constructor(...args) { this.args = args; }
    getTimezoneOffset() { return this.args.length ? january : now; }
  };
  assert.deepEqual(qqTimeZone(zone(-480, -480)), {time_zone: '28800', time_zone_dst: '0'});
  assert.deepEqual(qqTimeZone(zone(0, 0)), {time_zone: '0', time_zone_dst: '0'});
  assert.deepEqual(qqTimeZone(zone(300, 240)), {time_zone: '-18000', time_zone_dst: '3600'}, 'US Eastern in summer');
  assert.deepEqual(qqTimeZone(zone(-60, -120)), {time_zone: '3600', time_zone_dst: '3600'}, 'central Europe in summer');
  assert.deepEqual(qqTimeZone(zone(-570, -630)), {time_zone: '34200', time_zone_dst: '3600'}, 'Adelaide half-hour zone');
});

test('sid follows ee(): cookie first by uin, address bar only as fallback, disagreement is a signal', () => {
  const href = sid => `https://wx.mail.qq.com/home/index${sid ? '?sid=' + sid : ''}`;
  assert.deepEqual(qqSendmailSid({headUin: '111', cookie: 'xm_muti_sid=111%26cookieA%7C222%26cookieB', href: href('urlSid')}),
    {sid: 'cookieA', source: 'cookie', disagree: true});
  assert.deepEqual(qqSendmailSid({cookie: 'xm_muti_sid=111&cookieA|222&urlSid', href: href('urlSid')}),
    {sid: 'urlSid', source: 'cookie', disagree: false}, 'the uin is the multi-sid entry matching the address bar');
  assert.deepEqual(qqSendmailSid({cookie: 'xm_uin=333; xm_muti_sid=111&a|333&cookieC', href: href('stale')}),
    {sid: 'cookieC', source: 'cookie', disagree: true}, 'xm_uin names the account when nothing else does');
  assert.deepEqual(qqSendmailSid({cookie: 'xm_uin=444; xm_sid=single', href: href('')}), {sid: 'single', source: 'cookie', disagree: false});
  assert.deepEqual(qqSendmailSid({headUin: '555', cookie: 'xm_uin=444; xm_sid=other', href: href('urlSid')}),
    {sid: 'urlSid', source: 'url', disagree: false}, 'a sid of another uin is never used');
  assert.deepEqual(qqSendmailSid({cookie: '', href: href('urlSid')}), {sid: 'urlSid', source: 'url', disagree: false});
  assert.deepEqual(qqSendmailSid({cookie: '', href: href('')}), {sid: '', source: 'none', disagree: false});
  assert.equal(qqSendmailSid({cookie: `xm_uin=1; xm_sid=${'a'.repeat(4097)}`, href: href('')}).sid, '', 'oversized sids are refused');
  assert.equal(qqSendmailSid({cookie: 'xm_uin=1; xm_sid=bad"value', href: href('')}).sid, '');
});

test('dispatch submits exactly the maintained field set once, with QQ value rules', async t => {
  const f = qqPage(t, {timezone: [-480, -480]});
  const ticket = await f.reader.nativeSendPreflight({account_address: owner});
  assert.equal(ticket.ready, true); assert.equal(ticket.template_version, 'qq_sendmail_v1');
  assert.deepEqual(plain(ticket.drift), {manifest_version: '2.1.3', home_web: 'home-web.2a8c6bb7ea4212ee.js', sid_source: 'cookie', sid_disagree: false});
  const result = await f.reader.nativeSendDispatch({...message, text: ' Hello  <world>\n\tend', token: ticket.token});
  assert.deepEqual(plain({...result, timings: undefined}), {provider: 'qq_mail', template_version: 'qq_sendmail_v1', outcome: 'sent', mailid: 'ZC0001-mail', messageid: 'ZL0001-msg'});
  assert.equal(f.sends.length, 1);
  const [send] = f.sends;
  assert.equal(send.url, 'https://wx.mail.qq.com/send/sendmail');
  assert.deepEqual(plain({method: send.options.method, credentials: send.options.credentials, redirect: send.options.redirect, cache: send.options.cache,
    headers: send.options.headers}), {method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: {'content-type': 'application/x-www-form-urlencoded'}});
  const form = new URLSearchParams(send.options.body);
  assert.deepEqual([...form.keys()], ['func', 'mailid', 'time_zone', 'time_zone_dst', 'calendar', 'subject', 'content', 'is_text', 'is_urgent',
    'is_resume', 'need_receipt', 'from', 'save_to_send', 'separated_copy', 'to', 'language', 'r', 'sid']);
  assert.deepEqual(Object.fromEntries([...form].filter(([key]) => key !== 'r')), {func: '1', mailid: '', time_zone: '28800', time_zone_dst: '0',
    calendar: '', subject: 'Subject', content: `<div>&nbsp;Hello &nbsp;&lt;world&gt;</div><div>${EN.repeat(6)}end</div>`, is_text: 'false',
    is_urgent: 'false', is_resume: 'false', need_receipt: 'false', from: owner, save_to_send: 'true', separated_copy: 'false',
    to: recipient, language: 'zh_CN', sid: 'cookie-sid'});
  assert.match(form.get('r'), /^[0-9]{14,}$/);
  assert.equal(new URL(send.url).search, '', 'no query string');
  const again = await f.reader.nativeSendDispatch({...message, token: ticket.token});
  assert.equal(again.outcome, 'refused_before_request');
  assert.equal(f.sends.length, 1, 'a ticket is used once');
});

for (const [label, change, reason] of [
  ['expired ticket', f => { f.now += 60001; }, 'ticket_invalid'],
  ['replaced document', f => { f.window.__sparkclawMailDocument = 'other'; }, 'ticket_invalid'],
  ['changed account', f => { f.context.account = 'other@example.test'; }, 'account_unavailable'],
  ['missing sid', f => { f.document.cookie = ''; f.location.href = 'https://wx.mail.qq.com/home/index'; }, 'sid_missing'],
  ['wrong token', null, 'ticket_invalid'],
]) test(`a ${label} after release refuses before any request`, async t => {
  const f = qqPage(t), ticket = await f.reader.nativeSendPreflight({account_address: owner});
  change?.(f);
  const result = await f.reader.nativeSendDispatch({...message, token: change ? ticket.token : '9:forged'});
  assert.equal(result.outcome, 'refused_before_request'); assert.equal(result.reason, reason); assert.equal(f.sends.length, 0);
});

test('preflight distinguishes an unreadable account from a visible login page and checks preconditions', async t => {
  const f = qqPage(t);
  f.context.account = '';
  await assert.rejects(f.reader.nativeSendPreflight({account_address: owner}), {code: 'email_account_identity_unavailable'});
  f.login = true;
  await assert.rejects(f.reader.nativeSendPreflight({account_address: owner}), {code: 'email_login_required'});
  f.login = false; f.context.account = 'other@example.test';
  await assert.rejects(f.reader.nativeSendPreflight({account_address: owner}), {code: 'email_account_identity_mismatch'});
  for (const [setup, reason] of [[g => { g.location.pathname = '/login'; }, 'page_unavailable'], [g => { g.document.cookie = ''; g.location.href = 'https://wx.mail.qq.com/home/index'; }, 'sid_missing'],
    [g => { g.window.lang = '<script>'; }, 'language_unavailable']]) {
    const g = qqPage(t); setup(g);
    assert.deepEqual(plain(await g.reader.nativeSendPreflight({account_address: owner})), {provider: 'qq_mail', account_address: owner, ready: false, reason});
  }
  assert.equal(f.sends.length, 0);
});

for (const [label, reply, outcome, reason] of [
  ['HTTP 200 without JSON', {text: '<html>private</html>'}, 'unknown', 'response_format'],
  ['non-200 status', {status: 500, body: {head: {ret: 0}, body: {mailid: 'm', messageid: 'x'}}}, 'unknown', 'http_status'],
  ['a redirected response URL', {url: 'https://wx.mail.qq.com/other', body: {head: {ret: 0}, body: {mailid: 'm', messageid: 'x'}}}, 'unknown', 'http_status'],
  ['ret=0 without messageid', {body: {head: {ret: 0}, body: {mailid: 'm'}}}, 'unknown', 'response_identifier'],
  ['ret=0 without mailid', {body: {head: {ret: 0}, body: {messageid: 'x'}}}, 'unknown', 'response_identifier'],
  ['ret=0 with invalid identifiers', {body: {head: {ret: 0}, body: {mailid: 'a b', messageid: 'x'}}}, 'unknown', 'response_identifier'],
  ['an oversized body', {text: JSON.stringify({head: {ret: 0}, body: {mailid: 'm', messageid: 'x', pad: 'x'.repeat(1 << 20)}})}, 'unknown', 'response_format'],
  ['a network error', {throws: true}, 'unknown', 'network'],
  ['an account change after the response', {body: {head: {ret: 0}, body: {mailid: 'm', messageid: 'x'}}, after: f => { f.context.account = 'other@example.test'; }}, 'unknown', 'account_after_response'],
  ['a nonzero code', {body: {head: {ret: -20002}}}, 'provider_code', undefined],
  ['a nonzero string code', {body: {head: {ret: '-21519'}}}, 'provider_code', undefined],
]) test(`dispatch decides only from QQ's response: ${label}`, async t => {
  const f = qqPage(t, {reply});
  const ticket = await f.reader.nativeSendPreflight({account_address: owner});
  const result = await f.reader.nativeSendDispatch({...message, token: ticket.token});
  assert.equal(result.outcome, outcome); assert.equal(result.reason, reason);
  if (outcome === 'provider_code') assert.ok(Number.isSafeInteger(result.provider_code));
  assert.equal(f.sends.length, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('only the 12 listed QQ codes are explicit rejections', () => {
  assert.deepEqual([...QQ_NATIVE_SEND.rejections].sort((a, b) => a[0] - b[0]), [[-21519, 'temporary'], [-21501, 'parameter'], [-21132, 'parameter'],
    [-21101, 'parameter'], [-21021, 'login'], [-20071, 'login'], [-20062, 'login'], [-20011, 'parameter'], [-20003, 'temporary'], [-20002, 'login'],
    [-5151, 'parameter'], [-5012, 'login']]);
  for (const code of [0, -1, -20001, -5000, 1, -21520]) assert.equal(QQ_NATIVE_SEND.rejections.has(code), false);
});

test('lookup with a messageid matches exactly one fresh Sent row of the same message', async t => {
  const f = qqPage(t);
  f.rows = [f.row({emailid: 'old', messageid: 'ZL0000-old', fromtime: f.serverSeconds() - 3600}), f.row({emailid: 'new-id', messageid: 'ZL0001-msg'})];
  const result = await f.reader.nativeSendLookup({account_address: owner, to: [recipient], subject: 'Subject', messageid: 'ZL0001-msg', dispatched_at_ms: f.clock()});
  assert.equal(result.outcome, 'sent'); assert.equal(result.provider_message_id, 'new-id');
  assert.deepEqual(plain(result.proof), {source: 'qq_sent_list_v1', provider_message_id: 'new-id', response_message_id: 'ZL0001-msg', folder: 'sent', fresh: true});
  for (const change of [{subject: 'Other'}, {dirid: 1}, {receivers: {item: [{email: 'x@example.test'}]}}, {senders: {item: [{email: 'x@example.test'}]}}]) {
    const g = qqPage(t); g.rows = [g.row({messageid: 'ZL0001-msg', ...change})];
    assert.equal((await g.reader.nativeSendLookup({account_address: owner, to: [recipient], subject: 'Subject', messageid: 'ZL0001-msg', dispatched_at_ms: g.clock()})).outcome, 'unknown');
  }
});

test('lookup without a messageid is bounded by the dispatch time in server time and must be unique', async t => {
  const f = qqPage(t, {serverSkewMS: 90000});
  const dispatched = f.clock();
  // Server clock runs 90 s ahead; the bound is dispatch + 90 s - 120 s skew.
  f.rows = [f.row({emailid: 'before', fromtime: Math.floor((dispatched + 90000 - 121000) / 1000)})];
  let result = await f.reader.nativeSendLookup({account_address: owner, to: [recipient], subject: 'Subject', dispatched_at_ms: dispatched});
  assert.equal(result.outcome, 'unknown'); assert.equal(result.reason, 'not_found');
  assert.ok(f.now >= 12000 && f.now < 13000, 'polls up to 12 s');
  const g = qqPage(t, {serverSkewMS: 90000});
  g.rows = [g.row({emailid: 'fresh', fromtime: Math.floor((g.clock() + 90000 - 60000) / 1000)})];
  result = await g.reader.nativeSendLookup({account_address: owner, to: [recipient], subject: 'Subject', dispatched_at_ms: g.clock()});
  assert.equal(result.outcome, 'sent'); assert.equal(result.provider_message_id, 'fresh'); assert.equal(result.proof.response_message_id, undefined);
  const h = qqPage(t);
  h.rows = [h.row({emailid: 'a'}), h.row({emailid: 'b'})];
  result = await h.reader.nativeSendLookup({account_address: owner, to: [recipient], subject: 'Subject', dispatched_at_ms: h.clock()});
  assert.equal(result.reason, 'ambiguous'); assert.equal(h.reads, 1, 'several matches stop the lookup at once');
  assert.equal(h.sends.length + g.sends.length + f.sends.length, 0, 'a lookup never sends');
});
