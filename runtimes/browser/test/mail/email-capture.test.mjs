import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureMail as captureUnread, markCapturedRead, validateCaptureInput } from "../../applications/mail/lib/read-capture.mjs";

const digest = bytes => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const input = () => ({ schema_version: 1, operation: "read", invocation_id: "capture-test", provider: "gmail", account: "default", owner_scope: "a".repeat(64) });

test('specified capture persists target before browser entry and rejects invocation target replacement',async t=>{
 const f=await fixture(t,{message:{original:{selector:'original'}}});
 const target={account_address:f.message.account_address,provider_message_id:f.message.provider_message_id,provider_selection_id:f.message.provider_message_id};
 const request={...input(),operation:'capture',target};
 const runtime={...f.runtime,withReadTab:async callback=>{
  const journals=await fs.readdir(path.join(f.root,'email',input().owner_scope,'invocations'));
  const journal=JSON.parse(await fs.readFile(path.join(f.root,'email',input().owner_scope,'invocations',journals[0])));
  assert.equal(journal.identity.provider_message_id,target.provider_message_id);
  return f.runtime.withReadTab(callback);
 }};
 const first=await captureUnread(request,runtime,'gmail',f.adapter);
 assert.equal(first.status,'collected');
 await captureUnread(request,{...runtime,withReadTab:()=>assert.fail('completed capture reopened browser')},'gmail',f.adapter);
 await assert.rejects(captureUnread({...request,target:{...target,provider_message_id:'other'}},runtime,'gmail',f.adapter),{code:'email_capture_invalid'});
});

test('background capture defers explicit read until a separately verified committed receipt, and confirms once',async t=>{
 const f=await fixture(t,{message:{original:{selector:'original'}}});
 const target={account_address:f.message.account_address,provider_message_id:f.message.provider_message_id,provider_selection_id:f.message.provider_message_id};
 const captured=await captureUnread({...input(),operation:'capture',target},f.runtime,'gmail',{...f.adapter,markAfterCapture:false});
 assert.equal(f.events.includes('mark'),false);
 assert.equal(captured.capture.read_state,'unread');
 const request={...input(),operation:'mark_read',invocation_id:'independent-read',target,committed_capture:captured.capture};
 const result=await markCapturedRead(request,f.runtime,'gmail',f.adapter);
 assert.equal(result.read_state,'read');
 assert.equal(f.events.filter(event=>event==='mark').length,1);
 await markCapturedRead(request,{...f.runtime,withReadTab:()=>assert.fail('confirmed read reopened browser')},'gmail',f.adapter);
 const changed={...request,committed_capture:{...captured.capture,manifest_sha256:`sha256:${'0'.repeat(64)}`}};
 await assert.rejects(markCapturedRead(changed,{...f.runtime,withReadTab:()=>assert.fail('corrupt source reached browser')},'gmail',f.adapter),{code:'email_capture_invalid'});
});

test('capture does not perform a second full MIME/body parse before publication',async t=>{
 const f=await fixture(t,{message:{original:{selector:'original'},verify_body_text:true,body_text:'A different reply'}});
 const result=await f.run();const manifest=await manifestFor(f,result);
 assert.equal(result.status,'collected');
 assert.equal(manifest.files.some(file=>file.path.endsWith('body.txt')),false);
 assert.equal(f.events.includes('mark'),true);
});

test('capture preserves folded original bytes for the one asynchronous parser',async t=>{
 const original=Buffer.from(eml.toString().replace('Synthetic body.','Synthetic body.\r\n\r\nOlder folded quotation.'));
 const f=await fixture(t,{message:{original:{selector:'original'},verify_body_text:true,body_text:'Synthetic\uE113 body.'},
 download:async(_selector,target)=>fs.writeFile(target,original,{flag:'wx',mode:0o600})});
 const result=await f.run();const manifest=await manifestFor(f,result);
 assert.equal(result.status,'collected');
 assert.equal(manifest.files.length,1);
 assert.equal((await fs.readFile(path.join(f.root,manifest.files[0].path),'utf8')).includes('Older folded quotation.'),true);
});

test('capture requires an exact bounded target and discovery rejects model parameters',()=>{
 const target={account_address:'owner@example.test',provider_message_id:'a',provider_selection_id:'a'};
 validateCaptureInput({...input(),operation:'capture',target},'gmail');
 for(const bad of [{...input(),operation:'capture'},{...input(),operation:'capture',target:{...target,query:'anything'}},{...input(),operation:'discover',query:'anything'}]) assert.throws(()=>validateCaptureInput(bad,'gmail'),{code:'invalid_request'});
});
const eml = Buffer.from([
  "From: Alice <alice@example.test>", "To: Owner <owner@example.test>", "Subject: Fixture",
  "Message-ID: <fixture@example.test>", "Date: Mon, 7 Sep 2026 10:00:00 +0800",
  "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="capture-boundary"', "",
  "--capture-boundary", "Content-Type: text/plain; charset=utf-8", "", "Synthetic body.",
  "--capture-boundary", "Content-Type: application/octet-stream", "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="fixture.txt"', "", "YXR0YWNobWVudCBieXRlcw==",
  "--capture-boundary--", "",
].join("\r\n"));

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sparkclaw-email-capture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [], downloads = [];
  const message = {
    account_address: "owner@example.test", provider_message_id: "provider-message-1",
    subject: "Fixture", sender: "alice@example.test", body_text: "Synthetic DOM body.",
    body_html: "<p>Synthetic DOM body.</p>", inventory_complete: true, original: { selector: "original" },
    attachments: [], read_state: "unread", ...options.message,
  };
  const tab = { download: async (selector, target, limit) => {
    events.push("download"); downloads.push({ selector, target, limit });
    if (options.download) return options.download(selector, target, limit);
    const bytes = selector === "original" ? eml : Buffer.from("DOM attachment bytes");
    assert.ok(bytes.length <= limit);
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  } };
  const adapter = {
    markAfterCapture: true,
    collectUnread: async (_tab, provider, selection) => {
      events.push("select");
      assert.equal(provider, "gmail");
      if (options.empty) return { status: "empty" };
      if (options.collect) return options.collect(message, selection);
      await selection.onSelected(message);
      const journals = await fs.readdir(path.join(root, "email", input().owner_scope, "invocations"));
      const journal = JSON.parse(await fs.readFile(path.join(root, "email", input().owner_scope, "invocations", journals[0]), "utf8"));
      assert.equal(journal.identity.provider_message_id, message.provider_message_id);
      events.push("open");
      return message;
    },
    markRead: async () => {
      events.push("mark");
      const manifests = await filesUnder(root);
      const manifestPath = manifests.find(file => path.basename(file) === "capture.json");
      assert.ok(manifestPath, "manifest must exist before marking read");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      assert.equal(manifest.status, "collected");
      await verifyFiles(root, manifest);
      const state = JSON.parse(await fs.readFile(path.join(path.dirname(manifestPath), "read-state.json"), "utf8"));
      assert.equal(state.state, "pending", "durable effect intent must precede marking");
      return "read";
    },
  };
  const runtime = { emailWorkspaceRoot: root, withReadTab: callback => { events.push("tab"); return callback(tab); } };
  return { root, message, events, downloads, adapter, runtime, run: () => captureUnread(input(), runtime, "gmail", adapter) };
}

async function filesUnder(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(file));
    else result.push(file);
  }
  return result;
}

async function verifyFiles(root, manifest) {
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(root, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(digest(bytes), file.sha256);
  }
}

async function manifestFor(f, result) {
  const bytes = await fs.readFile(path.join(f.root, result.capture.manifest_path));
  assert.equal(digest(bytes), result.capture.manifest_sha256);
  return JSON.parse(bytes);
}

test("capture preserves only the original EML before asynchronous MIME parsing", async t => {
  const f = await fixture(t, { message: { original: { selector: "original" } } });
  const result = await f.run();
  assert.equal(result.status, "collected");
  assert.equal(result.capture.attachments_count, 0);
  assert.equal(result.capture.read_state, "read");
  const manifest = await manifestFor(f, result);
  assert.equal(manifest.stage, "script_capture");
  assert.equal(manifest.acquisition, "rfc822");
  assert.equal(manifest.metadata.message_id, "<fixture@example.test>");
  await verifyFiles(f.root, manifest);
  const original = manifest.files.find(file => file.path.endsWith("/message.eml"));
  assert.deepEqual(await fs.readFile(path.join(f.root, original.path)), eml);
  assert.deepEqual(manifest.attachments, []);
  assert.equal(manifest.files.length, 1);
  assert.deepEqual(f.events, ["tab", "select", "open", "download", "mark"]);
});

test("small network original uses inline bytes without invoking a browser download", async t => {
  const f = await fixture(t, { message: { original: {
    selector: "original", bytes: eml.length, inline_bytes: eml.length, inline_base64: eml.toString("base64"),
  } } });
  const result = await f.run();
  assert.equal(result.status, "collected");
  assert.equal(f.downloads.length, 0);
  assert.deepEqual(f.events, ["tab", "select", "open", "mark"]);
  const manifest = await manifestFor(f, result);
  const original = manifest.files.find(file => file.path.endsWith("/message.eml"));
  assert.deepEqual(await fs.readFile(path.join(f.root, original.path)), eml);
});

test("capture rejects a source without a network original", async t => {
  const f = await fixture(t);
  f.message.original = undefined;
  await assert.rejects(f.run(), { code: "email_network_original_unqualified" });
});

test("receipt replay verifies durable files without selecting or marking another mail", async t => {
  const f = await fixture(t);
  const result = await f.run();
  const events = [...f.events];
  f.message.provider_message_id = "different-message";
  assert.deepEqual(await f.run(), result);
  assert.deepEqual(f.events, events);
});

test("failed acquisition keeps the invocation pinned when retried", async t => {
  let attempts = 0;
  const f = await fixture(t, { collect: async (message, selection) => {
    assert.equal(selection.pinned_message_id, attempts === 0 ? undefined : message.provider_message_id);
    await selection.onSelected(message);
    if (attempts++ === 0) throw new Error("synthetic page failure");
    return message;
  } });
  await assert.rejects(f.run(), /synthetic page failure/);
  assert.equal(f.events.includes("mark"), false);
  assert.equal((await f.run()).status, "collected");
});

test("provisional selection survives opening failure before the actual message ID is available", async t => {
  let attempts = 0;
  const selectionID = "conversation-locator";
  const f = await fixture(t, { collect: async (message, selection) => {
    assert.equal(selection.pinned_selection_id, attempts === 0 ? undefined : selectionID);
    assert.equal(selection.pinned_message_id, undefined);
    await selection.onSelected({ account_address: message.account_address, provider_selection_id: selectionID });
    if (attempts++ === 0) throw new Error("synthetic opening failure");
    await selection.onSelected({ ...message, provider_selection_id: selectionID });
    return message;
  } });
  await assert.rejects(f.run(), /synthetic opening failure/);
  assert.equal((await f.run()).status, "collected");
});

test("a pinned selection cannot switch accounts or list locators before identity resolution", async t => {
  const f = await fixture(t, { collect: async (message, selection) => {
    await selection.onSelected({ account_address: message.account_address, provider_selection_id: "first" });
    await assert.rejects(selection.onSelected({ account_address: "other@example.test", provider_selection_id: "first" }), { code: "email_capture_invalid" });
    await selection.onSelected({ ...message, provider_selection_id: "second" });
    return message;
  } });
  await assert.rejects(f.run(), { code: "email_capture_invalid" });
  assert.equal(f.events.includes("mark"), false);
});

test("uncertain mark-read retries the pinned mail without replacing durable source", async t => {
  const f = await fixture(t, { message: { original: { selector: "original" } } });
  const markRead = f.adapter.markRead;
  f.adapter.markRead = async () => { throw new Error("synthetic mark timeout"); };
  const first = await f.run();
  assert.equal(first.capture.read_state, "unknown");
  f.adapter.markRead = markRead;
  const second = await f.run();
  assert.equal(second.capture.read_state, "read");
  assert.equal(second.capture.manifest_sha256, first.capture.manifest_sha256);
  assert.equal(f.downloads.length, 1);
});

test("lost receipt after durable read confirmation does not repeat the effect", async t => {
  const f = await fixture(t);
  const first = await f.run();
  const journalPath = (await filesUnder(f.root)).find(file => file.includes(`${path.sep}invocations${path.sep}`));
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  journal.receipt = null;
  await fs.writeFile(journalPath, JSON.stringify(journal));
  const events=[...f.events];
  f.adapter.markRead = async () => assert.fail('already confirmed');
  assert.deepEqual(await f.run(), first);
  assert.deepEqual(f.events,events,'durable confirmation recovery must not reopen mail');
  assert.equal(f.events.filter(event => event === 'mark').length, 1);
});

test("interrupted original download cleans its staging files and retries only the pinned mail", async t => {
  let failed = false;
  const f = await fixture(t, {message:{original:{selector:'original'}},download:async(_selector,target)=>{
    await fs.writeFile(target,failed?eml:eml.subarray(0,30),{mode:0o600});
    if(!failed){failed=true;throw new Error('download interrupted');}
  }});
  await assert.rejects(f.run(),/download interrupted/);
  assert.equal((await filesUnder(f.root)).some(file=>file.includes(`${path.sep}staging${path.sep}`)),false);
  const collect=f.adapter.collectUnread;
  f.adapter.collectUnread=async(tab,provider,selection)=>{
    assert.equal(selection.pinned_message_id,f.message.provider_message_id);
    return collect(tab,provider,selection);
  };
  const second=await f.run();
  assert.equal(second.status,'collected');
  assert.equal(f.events.filter(event=>event==='mark').length,1);
});

test("publication recovery rejects a manifest for a different mail before marking", async t => {
  const f = await fixture(t);
  const result = await f.run();
  const manifest = await manifestFor(f, result);
  manifest.mail_id = `mail_${"f".repeat(32)}`;
  await fs.writeFile(path.join(f.root, result.capture.manifest_path), JSON.stringify(manifest));
  const journalPath = (await filesUnder(f.root)).find(file => file.includes(`${path.sep}invocations${path.sep}`));
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  journal.receipt = null;
  await fs.writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(f.run(), { code: "email_capture_invalid" });
  assert.equal(f.events.filter(event => event === "mark").length, 1);
});

test("replay fails closed after source bytes are modified", async t => {
  const f = await fixture(t);
  const result = await f.run();
  const manifest = await manifestFor(f, result);
  await fs.writeFile(path.join(f.root, manifest.files[0].path), "tampered");
  await assert.rejects(f.run(), { code: "email_capture_invalid" });
  assert.equal(f.events.filter(event => event === "mark").length, 1);
});

test("capture leaves long MIME attachment names to the asynchronous parser", async t => {
  const f = await fixture(t, { message: { attachments: [{ name: "\u9644".repeat(150), selector: "attachment" }] } });
  const result = await f.run();
  const manifest = await manifestFor(f, result);
  assert.equal(result.status, "collected");
  assert.deepEqual(manifest.attachments, []);
  assert.equal(manifest.files.length, 1);
  await verifyFiles(f.root, manifest);
});

test("symlink workspace root is rejected before provider access", async t => {
  const f = await fixture(t);
  const link = `${f.root}-link`;
  t.after(() => fs.rm(link, { force: true }));
  await fs.symlink(f.root, link);
  f.runtime.emailWorkspaceRoot = link;
  await assert.rejects(f.run(), { code: "email_capture_invalid" });
  assert.deepEqual(f.events, []);
});

test("receipt replay rejects a symlinked committed capture directory", async t => {
  const f = await fixture(t, { message: { attachments: [{ name: "fixture.txt", selector: "attachment" }] } });
  const result = await f.run();
  const manifest = await manifestFor(f, result);
  const captureDir = path.dirname(path.join(f.root, result.capture.manifest_path));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sparkclaw-email-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  for (const name of await fs.readdir(captureDir)) await fs.cp(path.join(captureDir,name),path.join(outside,name),{recursive:true});
  await fs.rm(captureDir, { recursive: true });
  await fs.symlink(outside, captureDir);
  await assert.rejects(f.run(), { code: "email_capture_invalid" });
  assert.equal(f.events.filter(event => event === "mark").length, 1);
});

test("failure persisting source files prevents any mark-read action", async t => {
  const f = await fixture(t, { message: { original: { selector: "original" } }, download: async (_selector, target) => {
    await fs.writeFile(target, eml, { flag: "wx", mode: 0o600 });
    await fs.mkdir(path.join(path.dirname(target), "capture.json"));
  } });
  await assert.rejects(f.run(), { code: "EEXIST" });
  assert.equal(f.events.includes("mark"), false);
  assert.equal((await filesUnder(f.root)).some(file => file.endsWith("capture.json")), false);
});

test("no unread message returns empty without a fabricated capture or mark", async t => {
  const f = await fixture(t, { empty: true });
  assert.deepEqual(await f.run(), { schema_version: 1, status: "empty", provider: "gmail", capture: null });
  assert.equal(f.events.includes("mark"), false);
  assert.equal((await filesUnder(f.root)).length, 1);
  const events = [...f.events];
  assert.equal((await f.run()).status, "empty");
  assert.deepEqual(f.events, events);
});

test("capture input rejects old batch fields and an invalid owner scope", () => {
  assert.throws(() => validateCaptureInput({ ...input(), query: { limit: 1 } }, "gmail"), { code: "invalid_request" });
  assert.throws(() => validateCaptureInput({ ...input(), owner_scope: "../other" }, "gmail"), { code: "invalid_request" });
});

test('network original failure is terminal and does not invoke a native fallback',async t=>{
  const f=await fixture(t,{message:{original:{selector:'network'}},download:async selector=>{
    assert.equal(selector,'network');
    throw Object.assign(new Error('network unavailable'),{code:'email_network_original_unqualified'});
  }});
  await assert.rejects(f.run(),{code:'email_network_original_unqualified'});
  assert.deepEqual(f.downloads.map(x=>x.selector),['network']);
  assert.equal(f.events.filter(x=>x==='select').length,1);
});

// The fixture original carries "Date: Mon, 7 Sep 2026 10:00:00 +0800", which is
// 2026-09-07T02:00:00Z — the same UTC day, so the layout and the header agree.
const scope = () => input().owner_scope;
const ownerRoot = f => path.join(f.root, 'email', scope());
const withoutHeader = name => Buffer.from(eml.toString().split('\r\n').filter(line => !line.startsWith(`${name}:`)).join('\r\n'));
const journalFile = async f => {
  const dir = path.join(ownerRoot(f), 'invocations');
  return path.join(dir, (await fs.readdir(dir))[0]);
};
const dropReceipt = async f => {
  const file = await journalFile(f);
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  journal.receipt = null;
  await fs.writeFile(file, JSON.stringify(journal));
};

test('capture lands under the EML Date directory in UTC', async t => {
  const f = await fixture(t);
  const result = await f.run();
  const manifest = await manifestFor(f, result);
  assert.equal(manifest.date_path, '2026/09/07');
  assert.equal(manifest.received_source, 'eml_date');
  assert.equal(manifest.received_at, '2026-09-07T02:00:00.000Z');
  assert.equal(result.capture.manifest_path.startsWith(`email/2026/09/07/${scope()}/`), true);
  assert.equal(result.capture.manifest_path.split('/').length, 10);
  for (const file of manifest.files) assert.equal(file.path.startsWith(`email/2026/09/07/${scope()}/`), true);
});

test('a missing Date header falls back to the list row and preserves its display text', async t => {
  const f = await fixture(t, {
    message: { received_at: '2026-09-10T08:00:00Z' },
    download: async (_selector, target) => fs.writeFile(target, withoutHeader('Date'), { flag: 'wx', mode: 0o600 }),
  });
  const manifest = await manifestFor(f, await f.run());
  assert.equal(manifest.received_source, 'list_row');
  assert.equal(manifest.date_path, '2026/09/10');
  assert.equal(manifest.received_display_text, '2026-09-10T08:00:00Z');
});

test('an unparseable list row falls back to capture time rather than a mixed layout', async t => {
  const f = await fixture(t, {
    message: { received_at: '今天 14:32' },
    download: async (_selector, target) => fs.writeFile(target, withoutHeader('Date'), { flag: 'wx', mode: 0o600 }),
  });
  const manifest = await manifestFor(f, await f.run());
  assert.equal(manifest.received_source, 'captured_at');
  assert.equal(manifest.date_path, manifest.captured_at.slice(0, 10).replaceAll('-', '/'));
  // The unparseable text is still retained as timezone evidence.
  assert.equal(manifest.received_display_text, '今天 14:32');
});

test('a lost journal receipt adopts the committed capture through the index instead of downloading again', async t => {
  const f = await fixture(t);
  const first = await f.run();
  await dropReceipt(f);
  const second = await f.run();
  assert.equal(second.capture.manifest_path, first.capture.manifest_path);
  assert.equal(second.capture.manifest_sha256, first.capture.manifest_sha256);
  assert.equal(f.events.filter(event => event === 'download').length, 1);
});

test('a capture directory removed after commit is recaptured and its index pointer rewritten', async t => {
  const f = await fixture(t);
  const first = await f.run();
  await dropReceipt(f);
  await fs.rm(path.dirname(path.join(f.root, first.capture.manifest_path)), { recursive: true, force: true });
  const second = await f.run();
  assert.equal(second.capture.manifest_path, first.capture.manifest_path);
  assert.equal(f.events.filter(event => event === 'download').length, 2);
  const pointer = JSON.parse(await fs.readFile(path.join(ownerRoot(f), 'index',
    second.capture.mailbox_id, second.capture.mail_id, `${second.capture.capture_id}.json`), 'utf8'));
  assert.equal(pointer.manifest_path, second.capture.manifest_path);
  assert.equal(pointer.date_path, '2026/09/07');
});

test('staging never appears inside the date tree', async t => {
  const f = await fixture(t, {
    download: async (selector, target) => {
      assert.ok(target.includes(`${path.sep}staging${path.sep}`), 'bytes must land in staging first');
      assert.equal(target.includes(`${path.sep}2026${path.sep}`), false, 'staging must stay outside the date tree');
      const bytes = selector === 'original' ? eml : Buffer.from('DOM attachment bytes');
      await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    },
  });
  await f.run();
  const remaining = await filesUnder(f.root);
  assert.equal(remaining.some(file => file.includes(`${path.sep}2026${path.sep}`) && file.includes(`${path.sep}staging${path.sep}`)), false);
  assert.equal(remaining.some(file => file.includes(`${path.sep}staging${path.sep}`)), false);
});

test('mark_read rejects every manifest path that is not this exact date-layout capture', () => {
  const target = { account_address: 'owner@example.test', provider_message_id: 'provider-message-1', provider_selection_id: 'provider-message-1' };
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const mailbox = `mb_${sha('gmail\0owner@example.test').slice(0, 32)}`;
  const mail = `mail_${sha(`${mailbox}\0provider-message-1`).slice(0, 32)}`;
  const capture = `cap_${'b'.repeat(32)}`;
  const receipt = {
    attachments_count: 0, capture_id: capture, mail_id: mail, mailbox_id: mailbox,
    manifest_path: `email/2026/09/07/${scope()}/${mailbox}/${mail}/source/${capture}/capture.json`,
    manifest_sha256: `sha256:${'c'.repeat(64)}`, read_state: 'read',
  };
  const request = { ...input(), operation: 'mark_read', invocation_id: 'mark-test', target, committed_capture: receipt };
  validateCaptureInput(request, 'gmail');
  const rejected = [
    `email/2026/09/07/${'d'.repeat(64)}/${mailbox}/${mail}/source/${capture}/capture.json`, // another owner
    `email/2026/09/07/${scope()}/mb_${'0'.repeat(32)}/${mail}/source/${capture}/capture.json`, // another mailbox
    `email/2026/09/07/${scope()}/${mailbox}/mail_${'0'.repeat(32)}/source/${capture}/capture.json`, // another mail
    `email/2026/13/01/${scope()}/${mailbox}/${mail}/source/${capture}/capture.json`, // impossible month
    `email/2026/09/32/${scope()}/${mailbox}/${mail}/source/${capture}/capture.json`, // impossible day
    `email/${scope()}/${mailbox}/${mail}/source/${capture}/capture.json`, // legacy flat layout
    `email/2026/09/07/${scope()}/${mailbox}/source/${capture}/capture.json`, // one segment short
    `email/2026/09/07/x/${scope()}/${mailbox}/${mail}/source/${capture}/capture.json`, // one segment long
    `email/2026/09/07/${scope()}/${mailbox}/${mail}/source/${capture}/../capture.json`, // traversal
  ];
  for (const manifest_path of rejected) {
    assert.throws(() => validateCaptureInput({ ...request, committed_capture: { ...receipt, manifest_path } }, 'gmail'),
      { code: 'invalid_request' }, manifest_path);
  }
});

test('a receipt recorded under the previous layout is discarded instead of replayed forever', async t => {
  const f = await fixture(t);
  const first = await f.run();
  // Rewrite the journal the way a pre-date-layout run left it: a receipt whose
  // files still hash correctly, but whose path the Gateway can no longer accept.
  const file = await journalFile(f);
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  const legacy = `email/${scope()}/${first.capture.mailbox_id}/${first.capture.mail_id}/source/${first.capture.capture_id}/capture.json`;
  journal.receipt = { ...first, capture: { ...first.capture, manifest_path: legacy } };
  await fs.writeFile(file, JSON.stringify(journal));

  const second = await f.run();
  // It must recapture into the current layout rather than hand back the stale path.
  assert.equal(second.capture.manifest_path.startsWith(`email/2026/09/07/${scope()}/`), true);
  assert.notEqual(second.capture.manifest_path, legacy);
  const rewritten = JSON.parse(await fs.readFile(await journalFile(f), 'utf8'));
  assert.equal(rewritten.receipt.capture.manifest_path, second.capture.manifest_path);
});
