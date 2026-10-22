import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {installReader} from '../../applications/mail/userscripts/lib/reader-core.mjs';
import {parseOutlookList} from '../../applications/mail/lib/outlook-list.mjs';
import {managedSendDOM} from '../../applications/mail/lib/managed-send-dom.mjs';
import {sendManagedMail,outlookReplyRoute} from '../../applications/mail/lib/managed-send.mjs';

const owner = 'owner@example.test';
const conversation = (id, items, {drafts = [], local = items} = {}) => ({
  ConversationId: {Id: id}, ItemIds: local.map(Id => ({Id})), GlobalItemIds: items.map(Id => ({Id})), DraftItemIds: drafts.map(Id => ({Id})),
  MessageCount: local.length, GlobalMessageCount: items.length, UnreadCount: 1, GlobalUnreadCount: 1, LastDeliveryTime: '2026-10-21T10:00:00Z',
});
const startup = conversations => ({owaUserConfig: {SessionSettings: {UserEmailAddress: owner}}, findConversation: {Body: {FolderId: {Id: 'inbox-id'}, Conversations: conversations}}});

function outlookReader() {
  let receiveStartup;
  const context = vm.createContext({URL, Map, Set, Date, JSON, Object, Number, Error, Array, structuredClone, setTimeout, clearTimeout, performance,
    XMLHttpRequest: class {open() {} send() {} setRequestHeader() {}}, fetch: async () => new Response(''),
    location: {origin: 'https://outlook.live.com', href: 'https://outlook.live.com/mail/0/inbox'}, account: owner});
  vm.runInContext('window=globalThis;window.top=window;', context);
  context.capture = value => {receiveStartup = value;};
  vm.runInContext(`const parseOutlookList=${parseOutlookList.toString()};(${installReader.toString()})({provider:'outlook',origins:['https://outlook.live.com'],account:()=>account,listURL:()=>false,parse:()=>[],
    parseConversations:value=>parseOutlookList(value,true),installTransport:({receiveStartup})=>{capture(receiveStartup);return {dispose(){},resetRound(){}};}});`, context);
  return {reader: context.SparkClawMailReader, startup: value => receiveStartup(value), context};
}

test('Outlook Reader proves a reply target only as its conversation\'s sole local non-draft message', () => {
  const {reader, startup: deliver} = outlookReader();
  const request = {account_address: owner, provider_message_id: 'item-a', provider_selection_id: 'conv-a'};
  assert.equal(reader.replyTarget(request).reason, 'inventory_unobserved');
  deliver(startup([conversation('conv-a', ['item-a']), conversation('conv-b', ['item-b', 'item-c']),
    conversation('conv-d', ['item-d'], {drafts: ['item-d']}), conversation('conv-s', ['item-s'], {local: []})]));
  assert.deepEqual({...reader.replyTarget(request)}, {provider: 'outlook', account_address: owner, ...request, single: true});
  assert.equal(reader.replyTarget({...request, provider_message_id: 'item-b', provider_selection_id: 'conv-b'}).reason, 'conversation_not_single');
  assert.equal(reader.replyTarget({...request, provider_message_id: 'item-c', provider_selection_id: 'conv-b'}).single, false);
  assert.equal(reader.replyTarget({...request, provider_message_id: 'item-d', provider_selection_id: 'conv-d'}).single, false);
  assert.equal(reader.replyTarget({...request, provider_message_id: 'item-s', provider_selection_id: 'conv-s'}).single, false);
  assert.equal(reader.replyTarget({...request, provider_message_id: 'item-b', provider_selection_id: 'conv-a'}).reason, 'conversation_not_single');
  assert.equal(reader.replyTarget({...request, provider_selection_id: 'conv-x'}).reason, 'conversation_unobserved');
  assert.throws(() => reader.replyTarget({...request, account_address: 'other@example.test'}), {code: 'email_account_identity_mismatch'});
  reader.dispose();
});

// Minimal OWA reading pane: a conversation route, an optional selected list
// row, the pane that holds the message's native Reply control, and the inline
// reply editor that opens after it is clicked.
function readingPane({route = 'conv-a', selected = [], editorOutsidePane = false} = {}) {
  const visible = {isConnected: true, getBoundingClientRect: () => ({width: 20, height: 20})};
  const attrs = values => ({attributes: {...values}, getAttribute(name) {return this.attributes[name] ?? null;}, setAttribute(name, value) {this.attributes[name] = value;}, removeAttribute(name) {delete this.attributes[name];}});
  const node = (values, extra = {}) => ({...visible, ...attrs(values), querySelectorAll: () => [], ...extra});
  const page = {opened: false};
  const pane = node({role: 'main'});
  const reply = node({'aria-label': 'Reply'}, {closest: () => pane});
  const send = node({'aria-label': 'Send'});
  const to = node({'aria-label': 'To', contenteditable: 'true'});
  const compose = node({'data-app-section': 'MailCompose'}, {querySelector: () => null, querySelectorAll: selector => selector.includes('aria-label="To"') ? [to] : selector.startsWith('button') ? [send] : []});
  const body = node({'aria-label': 'Message body', contenteditable: 'true'}, {closest: selector => selector === '[data-app-section="MailCompose"]' ? compose : null});
  pane.querySelectorAll = selector => selector.startsWith('button') ? [reply] : [];
  pane.contains = target => !editorOutsidePane && (target === body || target === compose);
  const rows = selected.map(id => node({role: 'option', 'data-convid': id, 'aria-selected': 'true'}));
  const document = {getElementById: () => null, querySelectorAll: selector => {
    if (selector.includes('contenteditable')) return page.opened ? [body] : [];
    if (selector === '[role="option"][data-convid][aria-selected="true"]') return rows;
    if (selector === '[role="main"]') return [pane];
    return [];
  }};
  const context = vm.createContext({document, location: {pathname: '/mail/0/inbox/id/' + encodeURIComponent(route)}, getComputedStyle: () => ({visibility: 'visible'})});
  const run = (phase, expected) => vm.runInContext(`(${managedSendDOM.toString()})('outlook',${JSON.stringify(phase)},${JSON.stringify(expected)})`, context);
  return {run, page, reply};
}
const expected = {mode: 'reply', needs_cc: false, provider_message_id: 'item-a', provider_selection_id: 'conv-a/+=', single_message_proven: true};

test('Outlook reply editor is linked through the opened conversation route instead of removed DOM evidence', () => {
  const pane = readingPane({route: 'conv-a/+='});
  const opened = pane.run('open', expected);
  assert.equal(opened.opened, true);
  assert.equal(pane.reply.getAttribute('data-sc-mail-action'), 'prepare');
  pane.page.opened = true;
  assert.equal(pane.run('editor', expected).ready, true);
  const selectedSame = readingPane({route: 'conv-a/+=', selected: ['conv-a/+=']});
  assert.equal(selectedSame.run('open', expected).opened, true);
});

test('Outlook reply fails closed on another conversation, an unproved conversation or a detached editor', () => {
  for (const [name, options, value] of [
    ['other route', {route: 'conv-b'}, expected],
    ['other selected row', {route: 'conv-a/+=', selected: ['conv-b']}, expected],
    ['unproved conversation', {route: 'conv-a/+='}, {...expected, single_message_proven: false}],
  ]) assert.equal(readingPane(options).run('open', value).error, 'email_reply_target_unverified', name);
  const detached = readingPane({route: 'conv-a/+=', editorOutsidePane: true});
  assert.equal(detached.run('open', expected).opened, true);
  detached.page.opened = true;
  assert.equal(detached.run('editor', expected).error, 'email_reply_editor_unverified');
});

async function replyRun(t, proof) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outlook-reply-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const target = {account_address: owner, provider_message_id: 'item-a', provider_selection_id: 'conv-a', folder: 'inbox', subject: 'Original'};
  const request = {schema_version: 1, operation: 'send', provider: 'outlook', account: 'default', account_address: owner, invocation_id: 'reply-fixture', mode: 'reply', reply_target: target,
    message: {to: ['sender@example.test'], body: {format: 'text', content: 'Reply body'}, subject: 'RE: Original'}};
  const seen = {codes: [], phases: [], sends: 0, url: 'https://outlook.live.com/mail/0/inbox'};
  const tab = {
    runReadCode: async code => {
      seen.codes.push(code);
      const goto = /page\.goto\(("[^"]+")\)/u.exec(code);
      if (goto) {seen.url = JSON.parse(goto[1]); return true;}
      if (code.includes('replyTarget')) return proof;
      return null;
    },
    inspect: async code => {
      if (code.includes('function providerAccountDOM(')) return {origin: seen.url, result: {url: seen.url, account_hash: crypto.createHash('sha256').update(owner).digest('hex')}};
      const phase = [...code.matchAll(/\)\("outlook","(\w+)",/gu)].at(-1)?.[1];
      seen.phases.push(phase);
      if (phase === 'open') {seen.open = code; return {result: {error: 'email_reply_control_unavailable'}};}
      if (phase === 'discard') return {result: {discarded: false}};
      throw new Error(`unexpected phase ${phase}`);
    },
    click: async () => {seen.sends++;}, press: async () => {}, focus: async () => {}, fill: async () => {},
  };
  const runtime = {emailWorkspaceRoot: dir, reserveDispatch: () => 1, releaseDispatch: async () => 1, prepareSendPage: async () => {}, withSendTab: fn => fn(tab)};
  return {seen, result: sendManagedMail(request, 'outlook', runtime), target};
}

test('Outlook reply opens its conversation route and proves the target before any native reply control', async t => {
  const ok = await replyRun(t, {provider: 'outlook', account_address: owner, provider_message_id: 'item-a', provider_selection_id: 'conv-a', single: true});
  await assert.rejects(ok.result, {code: 'email_reply_control_unavailable'});
  assert.equal(ok.seen.url, outlookReplyRoute(ok.target));
  assert.match(ok.seen.open, /"single_message_proven":true/u);
  assert.equal(ok.seen.sends, 0);
  for (const proof of [
    {provider: 'outlook', account_address: owner, provider_message_id: 'item-a', provider_selection_id: 'conv-a', single: false, reason: 'conversation_not_single'},
    {provider: 'outlook', account_address: owner, provider_message_id: 'item-b', provider_selection_id: 'conv-a', single: true},
    null,
  ]) {
    const run = await replyRun(t, proof);
    await assert.rejects(run.result, {code: 'email_reply_target_unverified'});
    assert.deepEqual(run.seen.phases.filter(phase => phase !== 'discard'), []);
    assert.equal(run.seen.sends, 0);
  }
});
