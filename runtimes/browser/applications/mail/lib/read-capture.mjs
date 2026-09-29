import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {receiptTimeNanos} from './receipt-time.mjs';

// Small originals can travel as one bounded byte payload. Larger originals
// continue through the browser download path and are written to staging as a
// file, so attachments never require an in-memory whole-message buffer.
export const CAPTURE_LIMITS = Object.freeze({ inlineBytes: 8 << 20, parts: 20, partBytes: 25 << 20, totalBytes: 100 << 20, bodyBytes: 2 << 20, manifestBytes: 1 << 20 });
const scopePattern = /^[a-f0-9]{64}$/u;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function error(code) { return Object.assign(new Error(code), { code }); }
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const datePathPattern = /^\d{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])$/u;

// The date directory must resolve identically on every replay of the same
// message, so it comes from the immutable EML Date header once the bytes have
// landed in staging. List-row text is relative on some providers ("today
// 14:32") and cannot be parsed reliably; capture time is the last resort and is
// sampled once per attempt so the path stays stable within that attempt.
function receivedDate(headerISO, displayText, capturedAtISO) {
  for (const [source, value] of [["eml_date", headerISO], ["list_row", displayText], ["captured_at", capturedAtISO]]) {
    const time = Date.parse(typeof value === "string" ? value : "");
    if (!Number.isFinite(time)) continue;
    const date = new Date(time);
    const parts = [String(date.getUTCFullYear()).padStart(4, "0"), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")];
    const datePath = parts.join("/");
    if (!datePathPattern.test(datePath)) continue;
    return { parts, date_path: datePath, received_at: date.toISOString(), received_source: source };
  }
  throw error("email_capture_invalid");
}

// Every non-date segment is an exact equality against a value the caller already
// holds, so the date prefix widens the layout without widening the tamper surface.
function captureDatePath(manifestPath, ownerScope, identity, captureID) {
  const parts = String(manifestPath ?? "").split("/");
  if (parts.length !== 10 || parts[0] !== "email" || parts[4] !== ownerScope || parts[5] !== identity.mailbox_id ||
      parts[6] !== identity.mail_id || parts[7] !== "source" || parts[8] !== captureID || parts[9] !== "capture.json") return null;
  const datePath = parts.slice(1, 4).join("/");
  return datePathPattern.test(datePath) ? datePath : null;
}

export function validateCaptureInput(input, provider) {
  const keys = ["schema_version", "operation", "invocation_id", "provider", "account", "owner_scope"];
  if (input?.operation === 'capture') keys.push('target');
  if (input?.operation === 'discover' && Object.hasOwn(input, 'discovery')) keys.push('discovery');
  if (input?.operation === 'collect_page') keys.push('discovery');
  if (input?.operation === 'enumerate_thread') keys.push('thread', 'continuation', 'limit');
  if (input?.operation === 'mark_read') keys.push('target', 'committed_capture');
  if (!input || typeof input !== "object" || Object.keys(input).length !== keys.length ||
      keys.some(key => !Object.hasOwn(input, key)) || input.schema_version !== 1 || !['read','discover','capture','enumerate_thread','mark_read','collect_page'].includes(input.operation) ||
      input.provider !== provider || input.account !== "default" || typeof input.owner_scope !== "string" || !scopePattern.test(input.owner_scope) ||
      typeof input.invocation_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.invocation_id)) throw error("invalid_request");
  if (input.operation === 'collect_page' && input.discovery?.limit > 50) throw error('invalid_request');
  if (input.operation === 'collect_page' && (!['time_range','change_cursor'].includes(input.discovery?.provider_mode) || input.discovery.continuation !== '')) throw error('invalid_request');
  if (['capture','mark_read'].includes(input.operation)) validateMailTarget(input.target);
  if (Object.hasOwn(input,'discovery')) {
    const d = input.discovery;
    if (!d || ['account_address','continuation','lane','limit'].some(key=>!Object.hasOwn(d,key)) ||
        Object.keys(d).some(key=>!['account_address','continuation','interval_end','interval_start','lane','limit','provider_mode','retry_targets','skip_provider_message_ids'].includes(key)) ||
        ['interval_start','interval_end'].some(key=>Object.hasOwn(d,key) && typeof d[key]!=='string') ||
        d.lane !== 'recent_inbound' || !validContinuation(d.continuation) || !validBatchLimit(d.limit)) throw error('invalid_request');
    if (d.provider_mode !== undefined && !['change_cursor','time_range'].includes(d.provider_mode)) throw error('invalid_request');
    if (d.retry_targets !== undefined && (!Array.isArray(d.retry_targets) || d.retry_targets.length > 50)) throw error('invalid_request');
    for (const target of d.retry_targets ?? []) validateMailTarget(target);
    if (d.skip_provider_message_ids !== undefined && (!Array.isArray(d.skip_provider_message_ids) || d.skip_provider_message_ids.length > 100 || new Set(d.skip_provider_message_ids).size !== d.skip_provider_message_ids.length)) throw error('invalid_request');
    for (const id of d.skip_provider_message_ids ?? []) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/u.test(id) || (d.retry_targets ?? []).some(target=>target.provider_message_id===id)) throw error('invalid_request');
    }
    validateMailTarget({account_address:d.account_address,provider_message_id:'check',provider_selection_id:'check'});
    const start = receiptTimeNanos(d.interval_start), end = receiptTimeNanos(d.interval_end);
    if (start===null || end===null || start===receiptTimeNanos('0001-01-01T00:00:00Z') || start >= end) throw error('invalid_request');
  }
  if (input.operation === 'enumerate_thread') {
    const target = input.thread;
    if (!target || Object.keys(target).sort().join(',') !== 'account_address,folder,provider_selection_id,provider_thread_id' ||
        !validContinuation(input.continuation) || !validBatchLimit(input.limit)) throw error('invalid_request');
    validateMailTarget({...target,provider_message_id:target.provider_selection_id});
  }
  if (input.operation === 'mark_read') {
    const receipt = input.committed_capture;
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'attachments_count,capture_id,mail_id,mailbox_id,manifest_path,manifest_sha256,read_state' ||
        typeof receipt.manifest_sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(receipt.manifest_sha256) ||
        !/^cap_[a-f0-9]{32}$/u.test(receipt.capture_id) || !Number.isInteger(receipt.attachments_count) || receipt.attachments_count < 0 || receipt.attachments_count > CAPTURE_LIMITS.parts ||
        !['read','unread','unknown'].includes(receipt.read_state)) throw error('invalid_request');
    const identity = accountIdentity(provider,input.target);
    if (receipt.mailbox_id !== identity.mailbox_id || receipt.mail_id !== identity.mail_id ||
        !captureDatePath(receipt.manifest_path, input.owner_scope, identity, receipt.capture_id)) throw error('invalid_request');
  }
}

const validBatchLimit = value => Number.isInteger(value) && value >= 1 && value <= 100;
const validContinuation = value => typeof value === 'string' && (value === '' || /^(?:[a-f0-9]{64}:[1-9][0-9]{0,3}|(?:q1|n1):[A-Za-z0-9_-]{1,1000})$/u.test(value));

export function validateMailTarget(target) {
  if (!target || Array.isArray(target) || Object.keys(target).some(key => !['account_address','provider_message_id','provider_selection_id','provider_thread_id','provider_native_id','received_at','folder','recovery_capture'].includes(key)) ||
      typeof target.account_address !== 'string' || target.account_address.length > 320 ||
      /[\x00-\x20\x7f]/u.test(target.account_address) ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(target.account_address) ||
      [target.provider_message_id,target.provider_selection_id,...(target.provider_thread_id === undefined ? [] : [target.provider_thread_id]),...(target.provider_native_id === undefined ? [] : [target.provider_native_id])].some(id=>typeof id!=='string'||!/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/u.test(id)) ||
      target.folder !== undefined && !['inbox','sent','all'].includes(target.folder) && !/^qq:[1-9][0-9]{3,9}$/u.test(target.folder) && !/^outlook:[A-Za-z0-9_+=:.\/~\-]{1,1024}$/u.test(target.folder) ||
      target.received_at !== undefined && (typeof target.received_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u.test(target.received_at) || !Number.isFinite(Date.parse(target.received_at)))) throw error('invalid_request');
  if(target.recovery_capture){
    const v=target.recovery_capture;
    if(typeof v.manifest_json!=='string' || Buffer.byteLength(v.manifest_json)>64<<10 || !v.manifest_json || v.purged_at || v.purge_reason ||
        `sha256:${hash(v.manifest_json)}`!==v.manifest_sha256 || !/^sha256:[a-f0-9]{64}$/u.test(v.original_sha256) || !/^cap_[a-f0-9]{32}$/u.test(v.id))throw error('invalid_request');
  }
}

async function directory(parent, name) {
  if (!/^[a-zA-Z0-9_.-]+$/u.test(name) || name === "." || name === "..") throw error("email_capture_invalid");
  const target = path.join(parent, name);
  await fs.mkdir(target, { mode: 0o700 }).catch(cause => { if (cause.code !== "EEXIST") throw cause; });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw error("email_capture_invalid");
  return target;
}

async function descend(parent, ...names) {
  let target = parent;
  for (const name of names) target = await directory(target, name);
  return target;
}

async function syncDirectory(target) {
  const handle = await fs.open(target, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(target, bytes) {
  const handle = await fs.open(target, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(target));
}

// Staging is not visible source and is deliberately not made durable one file
// at a time. The recovery journal and its directory are the batch durability
// barriers; an interruption before that barrier may leave only disposable
// staging bytes.
async function writeStaging(target, bytes) {
  const handle = await fs.open(target, "wx", 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

async function replaceJSON(target, value) {
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await writeExclusive(temporary, json(value));
    await fs.rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally { await fs.rm(temporary, { force: true }); }
}

async function readJSON(target) {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1 << 20) throw error("email_capture_invalid");
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (cause) { if (cause.code === "ENOENT") return null; throw cause; }
}

function accountIdentity(provider, message) {
  const account = message.account_address;
  const id = message.provider_message_id;
  if (typeof account !== "string" || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(account) || account.length > 320 ||
      typeof id !== "string" || !id || Buffer.byteLength(id) > 1024 || /[\r\n\0]/u.test(id)) throw error("email_capture_invalid");
  const mailboxID = `mb_${hash(`${provider}\0${account.toLowerCase()}`).slice(0, 32)}`;
  return { account_address: account, provider_message_id: id, mailbox_id: mailboxID, mail_id: `mail_${hash(`${mailboxID}\0${id}`).slice(0, 32)}` };
}

function selectionIdentity(message) {
  const id = message.provider_selection_id ?? message.provider_message_id;
  const account = message.account_address;
  if (typeof account !== "string" || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(account) || account.length > 320 ||
      typeof id !== "string" || !id || Buffer.byteLength(id) > 2048 || /[\r\n\0]/u.test(id)) throw error("email_capture_invalid");
  return { account_address: account.toLowerCase(), provider_selection_id: id, ...(message.folder ? {folder:message.folder} : {}) };
}

function safeName(name) {
  const cleaned = String(name ?? "attachment").normalize("NFC").replace(/[/\\\x00-\x1f\x7f]/gu, "_").replace(/^\.+/u, "_");
  let result = "", bytes = 0;
  for (const character of cleaned) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 200) break;
    result += character;
    bytes += size;
  }
  return result || "attachment";
}

function boundedText(value, maxBytes, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > maxBytes) throw error("email_capture_limit");
  return value;
}

async function fileRef(root, absolute) {
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(absolute) !== path.resolve(absolute)) throw error("email_capture_invalid");
  const bytes = await fs.readFile(absolute);
  return { path: path.relative(root, absolute).split(path.sep).join("/"), bytes: bytes.length, sha256: `sha256:${hash(bytes)}` };
}

const headerProbeBytes = 64 << 10;

function probeHeaders(raw) {
  const text = raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/u);
  if (end < 0 || end > headerProbeBytes) throw error("email_capture_invalid");
  const headers = new Map();
  let name = "";
  for (const line of text.slice(0, end).split(/\r?\n/u)) {
    if (/^[ \t]/u.test(line) && name) {
      headers.set(name, `${headers.get(name)} ${line.trim()}`);
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) throw error("email_capture_invalid");
    name = line.slice(0, separator).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(separator + 1).trim());
  }
  if (!headers.get("from")) throw error("email_capture_invalid");
  const date = headers.get("date") ?? null;
  // A legal folded field may start with an empty first line. Unfolding adds
  // boundary whitespace; normalize the parsed value, never the original bytes.
  const messageID = headers.get("message-id")?.trim() || null;
  if (messageID && (!/^<[^<>\r\n]{1,998}>$/u.test(messageID))) throw error("email_capture_invalid");
  return { date, message_id: messageID, subject: headers.get("subject") ?? "", header_bytes: end };
}

async function inspectOriginal(absolute) {
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 110 << 20) throw error("email_capture_invalid");
  const handle = await fs.open(absolute, "r");
  const digest = crypto.createHash("sha256");
  const chunks = [];
  let offset = 0;
  try {
    while (offset < stat.size) {
      const buffer = Buffer.allocUnsafe(Math.min(256 << 10, stat.size - offset));
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (offset < headerProbeBytes) chunks.push(chunk.subarray(0, Math.min(chunk.length, headerProbeBytes - offset)));
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  if (offset !== stat.size) throw error("email_capture_invalid");
  return { bytes: stat.size, sha256: `sha256:${digest.digest("hex")}`, metadata: probeHeaders(Buffer.concat(chunks)) };
}

async function verifyReceipt(root, receipt) {
  const ref = receipt.capture;
  if (!ref || typeof ref.manifest_path !== "string" || ref.manifest_path.split("/").some(part => !part || part === "." || part === "..")) throw error("email_capture_invalid");
  const manifestPath = path.resolve(root, ref.manifest_path);
  if (!manifestPath.startsWith(`${root}${path.sep}`)) throw error("email_capture_invalid");
  const manifestRef = await fileRef(root, manifestPath);
  if (manifestRef.sha256 !== ref.manifest_sha256) throw error("email_capture_invalid");
  const manifest = await readJSON(manifestPath);
  for (const file of manifest.files) {
    const absolute = path.resolve(root, file.path);
    if (!absolute.startsWith(`${path.dirname(manifestPath)}${path.sep}`)) throw error("email_capture_invalid");
    const observed = await fileRef(root, absolute);
    if (observed.sha256 !== file.sha256 || observed.bytes !== file.bytes) throw error("email_capture_invalid");
  }
  return receipt;
}

// The committed capture lives under a date directory derived from the message
// bytes, so a replay cannot reconstruct its path. This date-independent pointer,
// written before the rename, is what lets an interrupted capture be adopted
// instead of downloaded again.
const captureIndexFile = (ownerRoot, identity, captureID) =>
  path.join(ownerRoot, 'index', identity.mailbox_id, identity.mail_id, `${captureID}.json`);

const captureIndexDir = (ownerRoot, identity) => descend(ownerRoot, 'index', identity.mailbox_id, identity.mail_id);

async function existingCapture(root, ownerRoot, input, provider, identity, captureID, ownerScope) {
  const pointer=await readJSON(captureIndexFile(ownerRoot,identity,captureID));
  if(!pointer)return null;
  if(pointer.schema_version!==1 || pointer.capture_id!==captureID || pointer.mailbox_id!==identity.mailbox_id ||
      pointer.mail_id!==identity.mail_id ||
      captureDatePath(pointer.manifest_path,ownerScope,identity,captureID)!==pointer.date_path)throw error('email_capture_invalid');
  const manifestPath=path.resolve(root,pointer.manifest_path);
  if(!manifestPath.startsWith(`${root}${path.sep}`))throw error('email_capture_invalid');
  const finalDir=path.dirname(manifestPath);
  const manifest=await readJSON(manifestPath);
  // The pointer is durable before the rename, so a missing manifest is the
  // pre-rename crash window and simply means "not captured yet".
  if(!manifest)return null;
  if(manifest.schema_version!==1 || manifest.stage!=='script_capture' || manifest.provider!==provider ||
      manifest.invocation_id!==input.invocation_id || manifest.mailbox_id!==identity.mailbox_id ||
      manifest.mail_id!==identity.mail_id || manifest.capture_id!==captureID || manifest.date_path!==pointer.date_path ||
      !['collected','partial'].includes(manifest.status) || !Array.isArray(manifest.attachments) ||
      !Array.isArray(manifest.files) || !manifest.files.length)throw error('email_capture_invalid');
  const receipt=receiptFor(provider,manifest,await fileRef(root,manifestPath),'unknown');
  await verifyReceipt(root,receipt);
  const state=await readJSON(path.join(finalDir,'read-state.json'));
  if(state?.schema_version===1 && state.state==='confirmed' && state.observed==='read')receipt.capture.read_state='read';
  return {manifest,receipt,finalDir};
}

export async function captureMail(input, runtime, provider, adapter) {
  validateCaptureInput(input, provider);
  if (!['read','capture'].includes(input.operation)) throw error('invalid_request');
  const root = runtime.emailWorkspaceRoot;
  if (typeof root !== "string" || !path.isAbsolute(root)) throw error("email_capture_unavailable");
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== path.resolve(root)) throw error("email_capture_invalid");
  const emailRoot = await directory(root, "email");
  const ownerRoot = await directory(emailRoot, input.owner_scope);
  const invocations = await directory(ownerRoot, "invocations");
  const invocationHash = hash(`${provider}\0${input.invocation_id}`);
  const journalPath = path.join(invocations, `${invocationHash}.json`);
  let journal = await readJSON(journalPath);
  // A receipt recorded under a previous directory layout still passes its own
  // hash check, because those files are untouched on disk — but the Gateway can
  // never accept its path again. Replaying it would fail the capture forever
  // without ever recapturing, so drop it and let this invocation collect again.
  if (journal?.receipt?.capture && !captureDatePath(journal.receipt.capture.manifest_path, input.owner_scope,
      {mailbox_id: journal.receipt.capture.mailbox_id, mail_id: journal.receipt.capture.mail_id}, journal.receipt.capture.capture_id)) {
    journal.receipt = null;
    await replaceJSON(journalPath, journal);
  }
  if (input.target) {
    const identity = accountIdentity(provider, input.target), selection = selectionIdentity(input.target);
    if (journal && (journal.identity?.mail_id !== identity.mail_id || journal.identity?.mailbox_id !== identity.mailbox_id)) throw error('email_capture_invalid');
    if (journal && (journal.selection?.provider_selection_id !== selection.provider_selection_id || (journal.selection?.folder ?? 'inbox') !== (selection.folder ?? 'inbox'))) {
      if (!adapter.allowCapturedRelocation) throw error('email_capture_invalid');
      // Only the trusted page collector can rebind a locator, and only after
      // proving that the immutable source belongs to this exact account/message.
      const captureID = `cap_${invocationHash.slice(0,32)}`;
      const recovered = await existingCapture(root,ownerRoot,input,provider,identity,captureID,input.owner_scope);
      if (!recovered) throw error('email_capture_invalid');
      if (journal.receipt) await verifyReceipt(root,journal.receipt);
      journal.selection = selection;
      journal.receipt = recovered.receipt;
      await replaceJSON(journalPath,journal);
    }
    if (!journal) {
      journal = {schema_version:1,provider,invocation_id:input.invocation_id,identity,selection,receipt:null};
      await replaceJSON(journalPath,journal);
    }
  }
  if(journal?.identity && !journal.receipt) {
    const identity=accountIdentity(provider,journal.identity);
    const captureID=`cap_${invocationHash.slice(0,32)}`;
    const recovered=await existingCapture(root,ownerRoot,input,provider,identity,captureID,input.owner_scope);
    if(recovered){journal.receipt=recovered.receipt;await replaceJSON(journalPath,journal);}
  }
  if (journal?.receipt) {
    if (journal.receipt.status === "empty") return journal.receipt;
    await verifyReceipt(root, journal.receipt);
    if (input.operation === 'capture' && !adapter.markAfterCapture || journal.receipt.status === "partial" || journal.receipt.capture.read_state === "read") return journal.receipt;
  }
  const onSelected = async message => {
    const selection = selectionIdentity(message);
    if (journal?.selection && (selection.account_address !== journal.selection.account_address || selection.provider_selection_id !== journal.selection.provider_selection_id)) throw error("email_capture_invalid");
    const identity = message.provider_message_id === undefined ? journal?.identity ?? null : accountIdentity(provider, message);
    if (journal?.identity && (identity.mail_id !== journal.identity.mail_id || identity.mailbox_id !== journal.identity.mailbox_id)) throw error("email_capture_invalid");
    journal = { schema_version: 1, provider, invocation_id: input.invocation_id, selection, identity, receipt: journal?.receipt ?? null };
    await replaceJSON(journalPath, journal);
  };
  return runtime.withReadTab(async tab => {
    let message = await adapter.collectUnread(tab, provider, { account_address:journal?.identity?.account_address, folder:journal?.selection?.folder, pinned_message_id: journal?.identity?.provider_message_id, pinned_selection_id: journal?.selection?.provider_selection_id, pinned_received_at:input.target?.received_at, capture_required: !journal?.receipt, onSelected });
    if (message.status === "empty") {
      if (journal?.identity || journal?.selection) throw error("email_capture_invalid");
      const receipt = { schema_version: 1, status: "empty", provider, capture: null };
      await replaceJSON(journalPath, { schema_version: 1, provider, invocation_id: input.invocation_id, receipt });
      return receipt;
    }
    if (!journal?.identity) throw error("email_capture_invalid");
    const identity = accountIdentity(provider, message);
    if (identity.mail_id !== journal.identity.mail_id) throw error("email_capture_invalid");
    const captureID = `cap_${invocationHash.slice(0, 32)}`;
    const existing = await existingCapture(root,ownerRoot,input,provider,identity,captureID,input.owner_scope);
    if (existing) {
      const {receipt,manifest,finalDir}=existing;
      receipt.capture.read_state = adapter.markAfterCapture === true
        ? await recordReadState(finalDir, manifest.status === "collected", message, () => adapter.markRead(tab, provider, message))
        : observedReadState(message);
      journal.receipt = receipt;
      await replaceJSON(journalPath, journal);
      return verifyReceipt(root, receipt);
    }
    // Staging lives outside the date tree because the date is only known after
    // the bytes are parsed. It stays on the same filesystem, so the commit is
    // still a single atomic rename, and the date tree only ever holds captures
    // that completed.
    const stagingParent = await descend(ownerRoot, "staging", identity.mailbox_id, identity.mail_id);
    // Account execution is serialized by the Controller. Recover only this
    // invocation's unfinished staging tree; never sweep another invocation.
    const stagingName = `attempt_${invocationHash}`;
    await fs.rm(path.join(stagingParent, stagingName), { recursive: true, force: true });
    const staging = await directory(stagingParent, stagingName);
    try {
      const captured = await collectFiles(tab, staging, message);
      const capturedAt = new Date().toISOString();
      const received = receivedDate(captured.metadata.date, message.received_at ?? message.receipt_time, capturedAt);
      const sources = await descend(emailRoot, ...received.parts, input.owner_scope, identity.mailbox_id, identity.mail_id, "source");
      const finalDir = path.join(sources, captureID);
      const manifest = {
        schema_version: 1, stage: "script_capture", provider, ...identity, capture_id: captureID,
        invocation_id: input.invocation_id, captured_at: capturedAt, acquisition: captured.mode,
        date_path: received.date_path, received_at: received.received_at, received_source: received.received_source,
        received_display_text: boundedText(typeof message.received_at === "string" ? message.received_at : null, 512, true),
        status: captured.complete ? "collected" : "partial", metadata: captured.metadata,
        attachments: captured.attachments, files: [], coverage: captured.coverage,
      };
      for (const staged of captured.files) {
        manifest.files.push({...staged, path: path.relative(root, path.join(finalDir, staged.path)).split(path.sep).join("/")});
      }
      const manifestRelative = path.relative(root, path.join(finalDir, "capture.json")).split(path.sep).join("/");
      if (captureDatePath(manifestRelative, input.owner_scope, identity, captureID) !== received.date_path) throw error("email_capture_invalid");
      const manifestBytes = json(manifest);
      if (manifestBytes.length > CAPTURE_LIMITS.manifestBytes) throw error("email_capture_limit");
      await writeStaging(path.join(staging, "capture.json"), manifestBytes);
      // The pointer is durable before the rename so an interrupted commit is
      // recoverable from either side: no manifest yet means "recapture", a
      // manifest present means "adopt without downloading again".
      await replaceJSON(path.join(await captureIndexDir(ownerRoot, identity), `${captureID}.json`),
        { schema_version: 1, capture_id: captureID, mailbox_id: identity.mailbox_id, mail_id: identity.mail_id, date_path: received.date_path, manifest_path: manifestRelative });
      await fs.rename(staging, finalDir);
      await syncDirectory(sources);
      // Background intake publishes through Store before a separate mark_read
      // job. Explicit human reading retains its existing read confirmation.
      const readState = adapter.markAfterCapture === true
        ? await recordReadState(finalDir, captured.complete, message, () => adapter.markRead(tab, provider, message))
        : observedReadState(message);
      const receipt = receiptFor(provider, manifest, {path:manifestRelative,bytes:manifestBytes.length,sha256:`sha256:${hash(manifestBytes)}`}, readState);
      journal.receipt = receipt;
      await replaceJSON(journalPath, journal);
      return receipt;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
      await syncDirectory(stagingParent);
    }
  });
}

// Compatibility export for older callers; it has no unread-selection behavior.
export async function markCapturedRead(input, runtime, provider, adapter) {
  validateCaptureInput(input,provider);
  if (input.operation !== 'mark_read') throw error('invalid_request');
  const root = runtime.emailWorkspaceRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root) || await fs.realpath(root) !== root) throw error('email_capture_invalid');
  const receipt = {schema_version:1,provider,status:'collected',capture:input.committed_capture};
  await verifyReceipt(root,receipt);
  const manifestPath = path.resolve(root,input.committed_capture.manifest_path);
  const manifest = await readJSON(manifestPath);
  const identity = accountIdentity(provider,input.target);
  if (manifest.status !== 'collected' || manifest.provider !== provider || manifest.mail_id !== identity.mail_id ||
      manifest.mailbox_id !== identity.mailbox_id || manifest.provider_message_id !== input.target.provider_message_id ||
      manifest.account_address.toLowerCase() !== input.target.account_address.toLowerCase()) throw error('email_capture_invalid');
  const finalDir = path.dirname(manifestPath);
  const prior = await readJSON(path.join(finalDir,'read-state.json'));
  let readState = 'read';
  if (prior?.state !== 'confirmed' || prior.observed !== 'read') {
    readState = await runtime.withReadTab(async tab => {
      const message = await adapter.collectUnread(tab,provider,{account_address:input.target.account_address,
        pinned_message_id:input.target.provider_message_id,pinned_selection_id:input.target.provider_selection_id,
        folder:input.target.folder,capture_required:false,onSelected:async selected => {
          if (accountIdentity(provider,selected).mail_id !== identity.mail_id) throw error('email_capture_invalid');
        }});
      return recordReadState(finalDir,true,message,()=>adapter.markRead(tab,provider,message));
    });
  }
  return {schema_version:1,provider,target:input.target,read_state:readState,observed_at:new Date().toISOString()};
}

async function recordReadState(finalDir, complete, message, markRead) {
  let readState = "unknown";
  const statePath = path.join(finalDir, "read-state.json");
  const previous = await readJSON(statePath);
  // A crash after confirmation but before receipt publication must not repeat
  // the remote effect or overwrite the durable confirmation with pending.
  if (complete && previous?.schema_version === 1 && previous.state === "confirmed" && previous.observed === "read") return "read";
  await replaceJSON(statePath, { schema_version: 1, state: complete ? "pending" : "not_requested", at: new Date().toISOString() });
  if (complete) {
    // The remote mutation is deliberately independent from source capture.
    // A missing or changed provider request records unknown and never rolls
    // back the durable MIME source or its synchronization boundary.
    try { readState = await markRead(); } catch { readState = "unknown"; }
  } else if (["read", "unread"].includes(message.read_state)) readState = message.read_state;
  if (!["read", "unread", "unknown"].includes(readState)) readState = "unknown";
  await replaceJSON(statePath, { schema_version: 1, state: complete && readState === "read" ? "confirmed" : complete ? "unknown" : "not_requested", observed: readState, at: new Date().toISOString() });
  return readState;
}

function observedReadState(message) {
  return ["read", "unread"].includes(message.read_state) ? message.read_state : "unknown";
}

function receiptFor(provider, manifest, ref, readState) {
  return { schema_version: 1, status: manifest.status, provider, capture: {
    manifest_path: ref.path, manifest_sha256: ref.sha256,
    mailbox_id: manifest.mailbox_id, mail_id: manifest.mail_id, capture_id: manifest.capture_id,
    attachments_count: manifest.attachments.filter(part => part.status === "available").length, read_state: readState,
  } };
}

async function collectFiles(tab, staging, message, timing) {
  const files = [], attachments = [];
  const mode = "rfc822";
  if (!message.original?.selector) throw error("email_network_original_unqualified");
  const acquire = async () => {
  if (Object.hasOwn(message.original, "inline_base64")) {
    const encoded = message.original.inline_base64;
    if (typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded) ||
        !Number.isSafeInteger(message.original.inline_bytes) || message.original.inline_bytes < 0 || message.original.inline_bytes > CAPTURE_LIMITS.inlineBytes) {
      throw error("email_network_original_unqualified");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== message.original.inline_bytes || bytes.length !== message.original.bytes) throw error("email_network_original_unqualified");
    await writeStaging(path.join(staging, "message.eml"), bytes);
  } else {
    await tab.download(message.original.selector, path.join(staging, "message.eml"), 110 << 20);
  }
  };
  if(timing)await timing.measure('original_transfer_write',acquire);else await acquire();
  const inspected = timing
    ? await timing.measure('original_inspect_hash',()=>inspectOriginal(path.join(staging, 'message.eml')))
    : await inspectOriginal(path.join(staging, "message.eml"));
  if(timing){timing.counts.originals_acquired++;timing.counts.original_bytes+=inspected.bytes;}
  if (message.rfc_message_id && message.rfc_message_id !== inspected.metadata.message_id) throw error("email_capture_invalid");
  files.push({path:"message.eml",bytes:inspected.bytes,sha256:inspected.sha256});
  // Full MIME decoding, body extraction, attachment materialization and their
  // one integrity pass belong to the asynchronous Gateway parse job. Capture
  // publishes only the immutable original plus a bounded header probe.
  return { files, attachments, metadata: inspected.metadata, mode, complete: true,
    coverage: { body: "parse_pending", inventory_complete: true, attachments_complete: true, skipped_parts: 0 } };
}

export function pageCaptureInvocation(input, provider, target) {
  // Recovery-overlap pages share the same per-message source identity as the
  // durable interval and must not create a second capture artifact.
  const namespace = input.invocation_id.replace(/_(?:recent_observation|recent_inbound)$/u, '').replace(/^email_changes_[a-f0-9]{64}(?:_r\d+)?$/u,'email_timeline_v2');
  return `email_capture_${hash([namespace, provider, target.account_address.toLowerCase(), target.provider_message_id].join('\n'))}`;
}

function pageFailure(target, code) {
  const local = /^(?:EACCES|EDQUOT|ENOSPC|EROFS|email_capture_unavailable|email_source_recovery_pending|email_source_conflict|email_local_io)$/u.test(code);
  const mailSpecific = /^(?:email_pinned_message_unavailable|email_message_identity_(?:invalid|mismatch|ambiguous)|email_capture_invalid)$/u.test(code);
  return {target,error_code:code,failure_scope:local?'local_operational':mailSpecific?'mail_specific':'provider_operational',qualified:mailSpecific};
}

// Exceptional repair only: retain the exact original manifest and its digest.
// Never infer a source directory from an invalid index, or overwrite a valid
// first source. The next attempt may restore identical bytes, not a new version.
async function timelineExistingCapture(root, ownerRoot, input, provider, identity, captureID, ownerScope, descriptor) {
  const index = captureIndexFile(ownerRoot,identity,captureID);
  const recoveryPath = `${index}.recovery.json`;
  let repair = await readJSON(recoveryPath);
  if(repair){
    const prefix=`email/${ownerScope}/quarantine/${identity.mailbox_id}/${identity.mail_id}/${captureID}_`;
    if(typeof repair.quarantine!=='string' || !repair.quarantine.startsWith(prefix) || !/^[a-f0-9-]{36}$/u.test(repair.quarantine.slice(prefix.length)))throw error('email_source_recovery_pending');
    const quarantine=path.join(root,repair.quarantine);
    if(await fs.realpath(quarantine)!==quarantine)throw error('email_source_recovery_pending');
  }
  if(descriptor){
    const trusted=trustedRecoveryManifest(descriptor,provider,identity,captureID,ownerScope,input.invocation_id);
    // A local recovery marker can never replace Store's expected original hash.
    if(repair && (repair.manifest_sha256!==descriptor.manifest_sha256 || repair.manifest_base64!==trusted.raw.toString('base64') || JSON.stringify(repair.pointer)!==JSON.stringify(trusted.pointer)))throw error('email_source_recovery_pending');
    try {
      await verifyReceipt(root,receiptFor(provider,trusted.manifest,{path:descriptor.manifest_path,sha256:descriptor.manifest_sha256},'unknown'));
      await captureIndexDir(ownerRoot,identity);
      await replaceVolatileJSON(index,trusted.pointer);
      return {existing:{receipt:receiptFor(provider,trusted.manifest,{path:descriptor.manifest_path,sha256:descriptor.manifest_sha256},'unknown')}};
    } catch(cause){if(!['email_capture_invalid','ENOENT'].includes(cause.code) && !(cause instanceof SyntaxError))throw error('email_local_io');}
    if(!repair){
      const quarantine=await descend(ownerRoot,'quarantine',identity.mailbox_id,identity.mail_id,`${captureID}_${crypto.randomUUID()}`);
      repair={schema_version:1,provider,invocation_id:input.invocation_id,identity,capture_id:captureID,pointer:trusted.pointer,manifest_sha256:descriptor.manifest_sha256,manifest_base64:trusted.raw.toString('base64'),quarantine:path.relative(root,quarantine).split(path.sep).join('/'),store_bound:true};
      await captureIndexDir(ownerRoot,identity);await replaceJSON(recoveryPath,repair);
    }
    // Store binds the exact path even when both local metadata files are lost.
    const source=path.join(root,path.dirname(descriptor.manifest_path)),quarantine=path.join(root,repair.quarantine);
    try {
      if(await fs.realpath(source)!==source || await fs.realpath(quarantine)!==quarantine)throw error('email_source_recovery_pending');
      await fs.rename(source,path.join(quarantine,'source'));
    }catch(cause){if(cause.code!=='ENOENT')throw cause;}
    try {await fs.rename(index,path.join(quarantine,'index.json'));}catch(cause){if(cause.code!=='ENOENT')throw cause;}
    return {repair};
  }
  if (repair) {
    const existing=await existingCapture(root,ownerRoot,input,provider,identity,captureID,ownerScope).catch(cause=>{
      if(cause instanceof SyntaxError || ['email_capture_invalid','ENOENT'].includes(cause.code))return null;
      throw error('email_local_io');
    });
    if(existing)return {existing};
    const prefix=`email/${ownerScope}/quarantine/${identity.mailbox_id}/${identity.mail_id}/${captureID}_`;
    if(typeof repair.quarantine!=='string' || !repair.quarantine.startsWith(prefix) || !/^[a-f0-9-]{36}$/u.test(repair.quarantine.slice(prefix.length)) ||
        !captureDatePath(repair.pointer?.manifest_path,ownerScope,identity,captureID))throw error('email_source_recovery_pending');
    const source=path.join(root,path.dirname(repair.pointer.manifest_path)), quarantine=path.join(root,repair.quarantine);
    try {
      if(await fs.realpath(source)!==source || await fs.realpath(quarantine)!==quarantine)throw error('email_source_recovery_pending');
      const raw=await fs.readFile(path.join(source,'capture.json'));
      if(`sha256:${hash(raw)}`!==repair.manifest_sha256)throw error('email_source_recovery_pending');
      await fs.rename(source,path.join(quarantine,'source'));
    } catch(cause){if(cause.code!=='ENOENT')throw cause;}
    try {await fs.rename(index,path.join(quarantine,'index.json'));} catch(cause){if(cause.code!=='ENOENT')throw cause;}
    return {repair};
  }
  try {
    const existing = await existingCapture(root,ownerRoot,input,provider,identity,captureID,ownerScope);
    if (existing) return {existing};
    // A dangling pointer needs exact recovery too; do not swallow ENOTEMPTY
    // later and advertise an unrelated new receipt over the old directory.
    if (!await readJSON(index)) return {};
  } catch (cause) {
    if (!(cause instanceof SyntaxError) && !['email_capture_invalid','ENOENT'].includes(cause.code)) throw error('email_local_io');
  }
  const pointer = await readJSON(index).catch(cause=>{if(cause instanceof SyntaxError)return null;throw cause;});
  if (!pointer || pointer.capture_id!==captureID || pointer.mail_id!==identity.mail_id || pointer.mailbox_id!==identity.mailbox_id ||
      captureDatePath(pointer.manifest_path,ownerScope,identity,captureID)!==pointer.date_path) throw error('email_source_recovery_pending');
  const source = path.join(root,path.dirname(pointer.manifest_path));
  // All traversed paths must remain inside the real workspace, without links.
  if (await fs.realpath(source)!==source || await fs.realpath(path.dirname(index))!==path.dirname(index)) throw error('email_source_recovery_pending');
  const raw = await fs.readFile(path.join(source,'capture.json')).catch(cause=>{if(cause.code==='ENOENT')return null;throw cause;});
  let manifest;
  try {manifest=raw&&JSON.parse(raw);} catch {throw error('email_source_recovery_pending');}
  if (!manifest || manifest.provider!==provider || manifest.invocation_id!==input.invocation_id || manifest.mail_id!==identity.mail_id ||
      manifest.mailbox_id!==identity.mailbox_id || manifest.capture_id!==captureID || manifest.date_path!==pointer.date_path ||
      !Array.isArray(manifest.files) || manifest.files.length!==1 || manifest.files[0].path!==`${path.dirname(pointer.manifest_path)}/message.eml` ||
      !/^sha256:[a-f0-9]{64}$/u.test(manifest.files[0].sha256)) throw error('email_source_recovery_pending');
  const quarantine = await descend(ownerRoot,'quarantine',identity.mailbox_id,identity.mail_id,`${captureID}_${crypto.randomUUID()}`);
  const record={schema_version:1,provider,invocation_id:input.invocation_id,identity,capture_id:captureID,pointer,
    manifest_sha256:`sha256:${hash(raw)}`,manifest_base64:raw.toString('base64'),quarantine:path.relative(root,quarantine).split(path.sep).join('/')};
  // Persist intent before either rename, so a process interruption cannot lose
  // the exact evidence or turn this into an unguarded ordinary download.
  await replaceJSON(recoveryPath,record);
  await fs.rename(source,path.join(quarantine,'source'));
  await fs.rename(index,path.join(quarantine,'index.json'));
  await syncDirectory(quarantine);
  await syncDirectory(path.dirname(source));
  await syncDirectory(path.dirname(index));
  throw error('email_source_recovery_pending');
}

function trustedRecoveryManifest(v,provider,identity,captureID,ownerScope,invocation){
  const raw=Buffer.from(v.manifest_json??'');let m;
  try {m=JSON.parse(raw);}catch{throw error('email_source_recovery_pending');}
  const date=captureDatePath(v.manifest_path,ownerScope,identity,captureID);
  if(raw.length>64<<10 || `sha256:${hash(raw)}`!==v.manifest_sha256 || v.id!==captureID || !date ||
      m.schema_version!==1 || m.stage!=='script_capture' || m.provider!==provider || m.invocation_id!==invocation || m.capture_id!==captureID ||
      m.mailbox_id!==identity.mailbox_id || m.mail_id!==identity.mail_id || typeof m.account_address!=='string' || m.account_address.toLowerCase()!==identity.account_address.toLowerCase() || m.provider_message_id!==identity.provider_message_id || m.date_path!==date ||
      !['collected','partial'].includes(m.status) || !Array.isArray(m.attachments) || m.attachments.length!==0 ||
      !Array.isArray(m.files) || m.files.length!==1 || !Number.isSafeInteger(m.files[0].bytes) || m.files[0].bytes<1 || m.files[0].bytes>110<<20 || m.files[0].path!==v.original_path || m.files[0].sha256!==v.original_sha256 || v.original_path!==`${path.dirname(v.manifest_path)}/message.eml`)throw error('email_source_recovery_pending');
  return {raw,manifest:m,pointer:{schema_version:1,capture_id:captureID,mailbox_id:identity.mailbox_id,mail_id:identity.mail_id,date_path:date,manifest_path:v.manifest_path}};
}

async function restoreTimelineManifest(repair, root, ownerScope, provider, identity, captureID, invocation, captured) {
  const raw=Buffer.from(repair.manifest_base64??'','base64');
  if (repair.schema_version!==1 || repair.provider!==provider || repair.invocation_id!==invocation || repair.capture_id!==captureID ||
      repair.identity?.mail_id!==identity.mail_id || repair.identity?.mailbox_id!==identity.mailbox_id ||
      !captureDatePath(repair.pointer?.manifest_path,ownerScope,identity,captureID) || `sha256:${hash(raw)}`!==repair.manifest_sha256) throw error('email_source_recovery_pending');
  const manifest=JSON.parse(raw);
  if (manifest.files.length!==1 || captured.files.length!==1 || manifest.files[0].sha256!==captured.files[0].sha256 || manifest.files[0].bytes!==captured.files[0].bytes) throw error('email_source_conflict');
  return {manifest,raw};
}

// A fixed timeline interval is the durable retry boundary. Only batch journals
// participate in capture replay; legacy page checkpoints are never accessed.
export async function capturePage(input, runtime, provider, adapter) {
  validateCaptureInput(input, provider);
  if (input.operation !== 'collect_page') throw error('invalid_request');
  return captureTimelinePage(input, runtime, provider, adapter);
}

// A timeline round stages all originals before publishing one recovery journal.
// The fixed invocation is retained by the Gateway until its Store transaction
// commits, so a lost response replays this exact batch without another download.
async function captureTimelinePage(input, runtime, provider, adapter) {
  const started=performance.now(),milliseconds={},counts={originals_acquired:0,original_bytes:0,reused:0,failures:0};
  const phaseEvidence=runtime.capturePhaseEvidence===true,intervals={};
  const timing={counts,measure:async(name,action)=>{
    const start=performance.now();
    const beganAt=phaseEvidence?new Date().toISOString():'';
    try{return await action();}finally{
      milliseconds[name]=(milliseconds[name]??0)+Math.max(0,performance.now()-start);
      if(phaseEvidence)(intervals[name]??=[]).push({began_at:beganAt,ended_at:new Date().toISOString()});
    }
  }};
  try{return await captureTimelinePageMeasured(input,runtime,provider,adapter,timing);}
  finally{
    try{
      // Local opt-in diagnostics only; no account, message, path, or error text.
      const record={provider:['gmail','qq_mail','outlook'].includes(provider)?provider:'unknown',operation:'collect_page',milliseconds:{...milliseconds,total:Math.max(0,performance.now()-started)},counts:{...counts}};
      if(phaseEvidence){record.round_alias=hash(input.invocation_id).slice(0,16);record.intervals=intervals;}
      Promise.resolve(runtime.captureTimingDiagnostic?.(record)).catch(()=>{});
    }catch{/* Observability must never affect capture or durability. */}
  }
}

async function captureTimelinePageMeasured(input, runtime, provider, adapter, timing) {
  const root = runtime.emailWorkspaceRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root) || await fs.realpath(root) !== root) throw error('email_capture_invalid');
  const emailRoot = await directory(root, 'email');
  const ownerRoot = await directory(emailRoot, input.owner_scope);
  const batches = await directory(ownerRoot, 'batches');
  const journalPath = path.join(batches, `${hash(`${provider}\0${input.invocation_id}`)}.json`);
  const prior = await readJSON(journalPath);
  const land = async batch => {
    if (batch.schema_version !== 1 || batch.provider !== provider || batch.invocation_id !== input.invocation_id ||
        !Array.isArray(batch.entries) || batch.entries.length > 100 || !batch.result ||
        JSON.stringify(batch.result.discovery_options) !== JSON.stringify(input.discovery)) throw error('email_capture_invalid');
    for (const entry of batch.entries) {
      const identity = accountIdentity(provider, entry.target);
      const ref = entry.result?.capture;
      if (!ref || !captureDatePath(ref.manifest_path,input.owner_scope,identity,ref.capture_id)) throw error('email_capture_invalid');
      const finalDir = path.join(root,path.dirname(ref.manifest_path));
      const staging = path.join(ownerRoot,'staging',identity.mailbox_id,identity.mail_id,`attempt_${hash(`${provider}\0${pageCaptureInvocation(input,provider,entry.target)}`)}`);
      if (entry.staging !== path.relative(root,staging).split(path.sep).join('/')) throw error('email_capture_invalid');
      try { await fs.rename(staging,finalDir); }
      catch (cause) {
        if (!['ENOENT','EEXIST','ENOTEMPTY'].includes(cause.code)) throw cause;
        // Existing bytes must match this exact receipt; never publish a new
        // manifest hash over an old directory after swallowing ENOTEMPTY.
        try {await verifyReceipt(root,entry.result);} catch {throw error('email_source_conflict');}
      }
      const pointer={schema_version:1,capture_id:ref.capture_id,mailbox_id:identity.mailbox_id,mail_id:identity.mail_id,
        date_path:captureDatePath(ref.manifest_path,input.owner_scope,identity,ref.capture_id),manifest_path:ref.manifest_path};
      const pointerPath=path.join(await captureIndexDir(ownerRoot,identity),`${ref.capture_id}.json`);
      await replaceVolatileJSON(pointerPath,pointer);
    }
    return batch.result;
  };
  if (prior) {
    const result = await timing.measure('publish',()=>land(prior));
    // Full re-verification belongs only to an interrupted batch replay.
    await timing.measure('replay_verify',async()=>{for (const entry of result.captures) await verifyReceipt(root,entry.result);});
    timing.counts.reused=result.captures.length;
    return result;
  }
  return runtime.withReadTab(async tab => {
    const {discovery,listed}=await timing.measure('discover',()=>adapter.discover(tab,input.discovery));
    if (discovery.account_address !== input.discovery.account_address.toLowerCase()) throw error('email_account_identity_mismatch');
    const skipped=new Set(input.discovery.skip_provider_message_ids??[]);
    const targets=discovery.candidates.filter(target=>!skipped.has(target.provider_message_id));
    for (const target of input.discovery.retry_targets??[]) {
      const index=targets.findIndex(row=>row.provider_message_id===target.provider_message_id);
      if(index<0)targets.push(target);else if(target.recovery_capture)targets[index]=target;
    }
    if (targets.length>100) throw error('email_capture_limit');
    const captures=[],failures=[],entries=[];
    for (const target of targets) {
      if (runtime.signal?.aborted) throw error('browser_extension_unavailable');
      validateMailTarget(target);
      const identity=accountIdentity(provider,target);
      const invocation=pageCaptureInvocation(input,provider,target);
      const invocationHash=hash(`${provider}\0${invocation}`);
      const captureID=`cap_${invocationHash.slice(0,32)}`;
      try {
        const {existing:recovered,repair}=await timing.measure('existing_capture',()=>timelineExistingCapture(root,ownerRoot,{invocation_id:invocation},provider,identity,captureID,input.owner_scope,target.recovery_capture));
        if(recovered){captures.push({target,result:recovered.receipt});timing.counts.reused++;continue;}
        let selected=false;
        const message=await timing.measure('prepare_original',()=>adapter.collect(tab,provider,{account_address:identity.account_address,folder:target.folder,
          retained_target:(input.discovery.retry_targets??[]).find(row=>row.provider_message_id===target.provider_message_id),
          pinned_message_id:target.provider_message_id,pinned_selection_id:target.provider_selection_id,capture_required:true,
          onSelected:async value=>{if(accountIdentity(provider,value).mail_id!==identity.mail_id)throw error('email_capture_invalid');selected=true;}},listed));
        if (!selected || accountIdentity(provider,message).mail_id!==identity.mail_id) throw error('email_capture_invalid');
        const stagingParent=await descend(ownerRoot,'staging',identity.mailbox_id,identity.mail_id);
        const staging=path.join(stagingParent,`attempt_${invocationHash}`);
        await fs.rm(staging,{recursive:true,force:true});
        await directory(stagingParent,`attempt_${invocationHash}`);
        const captured=await collectFiles(tab,staging,message,timing);
        const capturedAt=new Date().toISOString();
        const received=receivedDate(captured.metadata.date,message.received_at??message.receipt_time,capturedAt);
        const sources=await descend(emailRoot,...received.parts,input.owner_scope,identity.mailbox_id,identity.mail_id,'source');
        let finalDir=path.join(sources,captureID);
        let manifestRelative=path.relative(root,path.join(finalDir,'capture.json')).split(path.sep).join('/');
        let manifest={schema_version:1,stage:'script_capture',provider,...identity,capture_id:captureID,invocation_id:invocation,
          captured_at:capturedAt,acquisition:captured.mode,date_path:received.date_path,received_at:received.received_at,received_source:received.received_source,
          received_display_text:boundedText(typeof message.received_at==='string'?message.received_at:null,512,true),
          status:'collected',metadata:captured.metadata,attachments:captured.attachments,coverage:captured.coverage,
          files:captured.files.map(file=>({...file,path:path.relative(root,path.join(finalDir,file.path)).split(path.sep).join('/')}))};
        let bytes=json(manifest);
        if(repair){
          let restored;
          try {restored=await restoreTimelineManifest(repair,root,input.owner_scope,provider,identity,captureID,invocation,captured);}
          catch(cause){
            if(cause.code==='email_source_conflict'){
              await writeStaging(path.join(staging,'capture.json'),bytes);
              const quarantine=path.join(root,repair.quarantine);
              await fs.rename(staging,path.join(quarantine,`candidate_${crypto.randomUUID()}`));
              await syncDirectory(quarantine);
            }
            throw cause;
          }
          manifest=restored.manifest;bytes=restored.raw;manifestRelative=repair.pointer.manifest_path;finalDir=path.join(root,path.dirname(manifestRelative));
        }
        if(bytes.length>CAPTURE_LIMITS.manifestBytes)throw error('email_capture_limit');
        await writeStaging(path.join(staging,'capture.json'),bytes);
        const result=receiptFor(provider,manifest,{path:manifestRelative,bytes:bytes.length,sha256:`sha256:${hash(bytes)}`},observedReadState(message));
        captures.push({target,result});
        entries.push({target,result,staging:path.relative(root,staging).split(path.sep).join('/')});
      } catch(cause) {
        if(runtime.signal?.aborted)throw cause;
        const code=typeof cause?.code==='string'&&/^E[A-Z]+$/u.test(cause.code)?'email_local_io':typeof cause?.code==='string'&&/^[a-z0-9_]{1,64}$/u.test(cause.code)?cause.code:'provider_script_failed';
        failures.push(pageFailure(target,code));
        timing.counts.failures++;
      }
    }
    const result={schema_version:1,provider,page_id:`page_${hash(crypto.randomUUID())}`,account_address:discovery.account_address,
      discovery,discovery_options:input.discovery,captures,failures,observed_at:new Date().toISOString(),
      status:failures.length||discovery.status==='partial'?'partial':captures.length||discovery.candidates.length?'collected':'empty'};
    if (!entries.length) return result;
    const batch={schema_version:1,provider,invocation_id:input.invocation_id,entries,result};
    const bytes=json(batch);
    if(bytes.length>1<<20)throw error('email_batch_limit');
    // Exactly one file barrier and one directory barrier before any rename.
    await timing.measure('journal_durability',async()=>{
    const temporary=`${journalPath}.tmp`;
    await fs.rm(temporary,{force:true});
    const handle=await fs.open(temporary,'wx',0o600);
    try {await handle.writeFile(bytes);await handle.sync();} finally {await handle.close();}
    await fs.rename(temporary,journalPath);
    await syncDirectory(batches);
    });
    return timing.measure('publish',()=>land(batch));
  });
}

async function replaceVolatileJSON(target,value) {
  const temporary=`${target}.${crypto.randomUUID()}.tmp`;
  try {await writeStaging(temporary,json(value));await fs.rename(temporary,target);}
  finally {await fs.rm(temporary,{force:true});}
}
