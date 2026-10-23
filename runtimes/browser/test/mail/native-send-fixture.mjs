// A signed-in QQ page in a VM: the real Reader with the maintained
// qq_sendmail_v1 template, a QQ server stand-in, and a page clock that the
// in-page waits (<= 1 s) advance instantly.
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installReader} from '../../applications/mail/userscripts/lib/reader-core.mjs';
import {installQQSendmailV1, qqPlainTextHTML, qqSendmailSid, qqTimeZone} from '../../applications/mail/userscripts/lib/qq-sendmail-v1.mjs';
import {mailHandlers} from '../../applications/mail/handlers.mjs';

export const owner = 'owner@example.test', recipient = 'recipient@example.test';
const START = Date.now();
const INSTALL = `window.SparkClawMailReader?.dispose();(${installReader.toString()})({provider:'qq_mail',origins:[location.origin],account:()=>account,
  listURL:()=>false,parse:()=>[],installNativeSend:${installQQSendmailV1.toString()}});`;

export function qqPage(t, {reply = {}, timezone, serverSkewMS = 0} = {}) {
  const f = {now: 0, sends: [], reads: 0, rows: [], login: false, documents: 0};
  f.clock = () => START + f.now;
  f.serverSeconds = () => Math.floor((f.clock() + serverSkewMS) / 1000);
  f.row = (change = {}) => ({emailid: 'sent-id', dirid: 3, subject: 'Subject', fromtime: f.serverSeconds(),
    senders: {item: [{email: owner}]}, receivers: {item: [{email: recipient}]}, ...change});
  class PageDate extends Date {
    constructor(...args) { super(...(args.length ? args : [f.clock()])); }
    static now() { return f.clock(); }
    getTimezoneOffset() { return timezone ? (this.getFullYear() === 2009 ? timezone[0] : timezone[1]) : super.getTimezoneOffset(); }
  }
  const pageTimeout = (fn, ms, ...args) => { if (ms > 0 && ms <= 1000) { f.now += ms; return setTimeout(fn, 0, ...args); } return setTimeout(fn, ms, ...args); };
  f.document = {cookie: 'xm_uin=111; xm_muti_sid=111%26cookie-sid', scripts: [{src: 'https://res.wx.qq.com/t/webmail/webmail/res/js/home-web.2a8c6bb7ea4212ee.js'}],
    head: {getAttribute: name => name === 'xmail_uin' ? '111' : null},
    querySelectorAll: selector => selector === '.login-page' && f.login ? [{getBoundingClientRect: () => ({width: 10, height: 10})}] : [],
    addEventListener() {}, removeEventListener() {}};
  f.location = {origin: 'https://wx.mail.qq.com', href: 'https://wx.mail.qq.com/home/index?sid=cookie-sid', pathname: '/home/index'};
  class XHR { open() {} send() {} setRequestHeader() {} addEventListener() {} }
  const respond = (text, {status = 200, url, headers} = {}) => { const response = new Response(text, {status, headers}); Object.defineProperty(response, 'url', {value: url}); return response; };
  f.context = vm.createContext({URL, URLSearchParams, Headers, Response, Blob, TextDecoder, TextEncoder, Uint8Array, AbortController, AbortSignal,
    structuredClone, crypto: globalThis.crypto, Date: PageDate, setTimeout: pageTimeout, clearTimeout, performance: {now: () => f.now},
    XMLHttpRequest: XHR, document: f.document, location: f.location, account: owner, lang: 'zh_CN', __WEB_MANIFEST__: {version: '2.1.3'},
    fetch: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/send/sendmail') {
        f.sends.push({url, options});
        if (reply.throws) throw new Error('private network failure');
        const text = reply.text ?? JSON.stringify(reply.body ?? {head: {ret: 0}, body: {mailid: 'ZC0001-mail', messageid: 'ZL0001-msg'}});
        reply.after?.(f);
        return respond(text, {status: reply.status, url: reply.url ?? url});
      }
      if (pathname === '/list/maillist') {
        f.reads++;
        if (f.listFails) throw new Error('private list failure');
        return respond(JSON.stringify({head: {ret: 0, time: f.serverSeconds()}, body: {total_num: f.rows.length, list: f.rows}}),
          {url, headers: {date: new Date(f.clock() + serverSkewMS).toUTCString()}});
      }
      throw new Error('unexpected request');
    }});
  vm.runInContext(`window=globalThis;top=window;var qqPlainTextHTML=${qqPlainTextHTML.toString()};var qqSendmailSid=${qqSendmailSid.toString()};var qqTimeZone=${qqTimeZone.toString()};`, f.context);
  f.window = f.context;
  // A navigation replaces the document: a new Reader and no admitted nonce.
  f.reload = () => { f.documents++; vm.runInContext(`delete window.__sparkclawMailDocument;${INSTALL}${f.readerMissing ? 'window.SparkClawMailReader.dispose();' : ''}`, f.context); };
  f.reload();
  Object.defineProperty(f, 'reader', {get: () => f.context.SparkClawMailReader});
  t.after(() => f.context.SparkClawMailReader?.dispose());
  return f;
}

export const sendInput = (change = {}) => ({schema_version: 1, operation: 'send', invocation_id: 'native-fixture', provider: 'qq_mail', account: 'default',
  account_address: owner, mode: 'compose', ...change,
  message: {to: [recipient], cc: [], subject: 'Subject', body: {format: 'text', content: 'Private body text'}, ...change.message}});
export const executionEvidence = {task_id: 'task-native', intent_digest: 'a'.repeat(64), resource_digest: 'b'.repeat(64), binding_digest: 'c'.repeat(64), ledger_epoch: 1};

// The production send handler on that page, through MailPage and the Host
// methods it uses. Returns every host call so tests can audit what crossed it.
export async function qqHost(t, options = {}) {
  const f = qqPage(t, options);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-send-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const handlers = await mailHandlers();
  f.calls = []; f.codeRequests = []; f.readCodes = []; f.secrets = []; f.reserve = 0; f.release = 0;
  const page = {evaluate: (fn, arg) => fn(arg), goto: async () => f.reload()};
  f.browser = {reused: options.reused ?? false, async call(method, ...args) {
    f.calls.push(method);
    if (method === 'runCodeRequest') { f.codeRequests.push({code: args[0], argument: args[1], timeout: args[2]}); return vm.runInContext(`(${args[0]})`, f.context)(page, args[1]); }
    if (method === 'runReadCode') { f.readCodes.push(args[0]); return vm.runInContext(`(${args[0]})`, f.context)(page); }
    if (method === 'navigate') return f.reload();
    if (method === 'setSecrets') { f.secrets.push(args[0]); return true; }
    if (method === 'prepareBackgroundPage') return undefined;
    throw new Error(`unexpected host call ${method}`);
  }};
  f.run = (input = sendInput(), change = {}) => handlers['qq_mail.send'].run(input, {browser: f.browser,
    resource: {document_nonce: 'document-1', workspace_root: dir, account_address: owner}, beforeEffect() {},
    reserveDispatch: () => { f.reserve++; }, releaseDispatch: async () => { f.release++; if (f.releaseFails) throw Object.assign(new Error('stale'), {code: 'AUTHORIZATION_STALE'}); },
    executionEvidence, ...change});
  f.reconcile = input => handlers['qq_mail.send'].reconcile(input, {browser: f.browser, resource: {workspace_root: dir}, executionEvidence});
  f.dir = dir;
  return f;
}
