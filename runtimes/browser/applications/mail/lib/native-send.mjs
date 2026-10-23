// Provider-independent network-native send. A provider module (see
// native-send-config.mjs) supplies the template, scope, recovery page and
// rejection codes; the page implements nativeSendPreflight/Dispatch/Lookup.
//
// Two page calls on the normal path: preflight (no message content, returns a
// one-use ticket) and dispatch (content travels once, through the Browser
// Controller's guarded code request, never in an argument list). The dispatch
// release and the `dispatching` journal entry precede the request, so any
// failure before them proves nothing was sent. Only the provider's response
// decides the result: success needs its own success flag and identifiers,
// listed codes are provider_rejected, everything else is pending confirmation
// with one bounded Sent lookup. There is no DOM fallback and never a resend.
import {nativeSendProvider} from './native-send-config.mjs';
import {PROVIDER_REJECTION_REASONS} from './send-recovery.mjs';

const fail = code => Object.assign(new Error(code), {code});
const unavailable = reason => Object.assign(new Error('email_native_send_unavailable'), {code: 'email_native_send_unavailable', reason});
const id = value => typeof value === 'string' && /^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/u.test(value);
const reasonCode = value => typeof value === 'string' && /^[a-z_0-9]{1,80}$/u.test(value) ? value : undefined;
// The guarded request carries at most 512 KiB of argument JSON.
const ARGUMENT_LIMIT = 480 << 10;
const PAGE_CALL_MS = 30000;

const reader = method => `async (page, request) => page.evaluate(async request => {
  const reader = window.SparkClawMailReader;
  if (reader?.provider !== request.provider || reader.version !== '0.2.0' || typeof reader.${method} !== 'function') return {outcome: 'refused_before_request', reason: 'reader_unavailable'};
  try { return await reader.${method}(request.value); }
  catch (error) { return {outcome: 'unknown', reason: 'reader_' + String(error?.code || 'error').slice(0, 64)}; }
}, request)`;
// A cold page waits inside this call, bounded to 5 s, for the Reader and the
// signed-in account. A reused page must still hold the admitted document.
export const NATIVE_PREFLIGHT_CODE = `async (page, request) => page.evaluate(async request => {
  if (request.reused && window.__sparkclawMailDocument !== request.nonce) return {ready: false, reason: 'document_changed'};
  const deadline = Date.now() + 5000;
  for (;;) {
    const reader = window.SparkClawMailReader;
    if (reader?.provider === request.provider && reader.version === '0.2.0' && typeof reader.nativeSendPreflight === 'function') {
      try {
        if (!request.reused) window.__sparkclawMailDocument = request.nonce;
        return await reader.nativeSendPreflight({account_address: request.account_address});
      } catch (error) {
        const code = String(error?.code || 'reader_error').slice(0, 64);
        if (code !== 'email_account_identity_unavailable' || Date.now() >= deadline) return {ready: false, error: code};
      }
    } else if (Date.now() >= deadline) return {ready: false, reason: 'reader_unavailable'};
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}, request)`;
export const NATIVE_DISPATCH_CODE = reader('nativeSendDispatch');
export const NATIVE_LOOKUP_CODE = reader('nativeSendLookup');

const nativeMessage = request => ({account_address: request.account_address, to: request.message.to, cc: [], subject: request.message.subject,
  text: request.message.body.content});

export function nativeSendPlan(provider, request, release) {
  const plan = nativeSendProvider(provider, release);
  return plan && plan.inScope(request) && Buffer.byteLength(JSON.stringify(nativeMessage(request))) <= ARGUMENT_LIMIT ? plan : null;
}

const evidenceEnabled = () => process.env.APP_CLI_MAIL_SEND_EVIDENCE === '1' || process.env.APP_CLI_MAIL_LEARNING_EVIDENCE === '1';
function evidence(value) {
  if (evidenceEnabled()) process.stderr.write(JSON.stringify({event: 'mail_native_send', ...value}) + '\n');
}
const timingsOf = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key, item]) =>
  ['request_ms', 'lookup_ms'].includes(key) && Number.isSafeInteger(item) && item >= 0 && item <= 60000));
function driftOf(value) {
  const out = {};
  if (typeof value?.manifest_version === 'string' && /^[A-Za-z0-9._\-]{1,64}$/u.test(value.manifest_version)) out.manifest_version = value.manifest_version;
  if (typeof value?.home_web === 'string' && /^home-web\.[0-9a-f]{8,32}\.js$/u.test(value.home_web)) out.home_web = value.home_web;
  if (['cookie', 'url'].includes(value?.sid_source)) out.sid_source = value.sid_source;
  if (value?.sid_disagree === true) out.sid_disagree = true;
  return out;
}

async function call(tab, code, request) {
  try { return await tab.runCodeRequest(code, request, PAGE_CALL_MS); }
  catch { return null; }
}

async function preflight(tab, plan, request, runtime, reused) {
  const value = await call(tab, NATIVE_PREFLIGHT_CODE, {provider: plan.provider, account_address: request.account_address,
    nonce: runtime.documentNonce ?? null, reused});
  if (value?.ready === true && value.provider === plan.provider && value.account_address === request.account_address.toLowerCase() &&
      value.template_version === plan.template_version && typeof value.token === 'string' && /^[0-9]{1,15}:[a-z0-9]{1,32}$/u.test(value.token)) return {ticket: value};
  if (['email_login_required', 'email_account_identity_mismatch', 'email_account_identity_unavailable'].includes(value?.error)) return {error: value.error};
  return {reason: reasonCode(value?.reason) ?? (value ? 'preflight_invalid' : 'controller')};
}

// Runs inside runtime.withSendTab for a request admitted by nativeSendPlan.
export async function sendNativeMail({tab, plan, request, runtime, journal, timing, unknown}) {
  if (typeof tab.runCodeRequest !== 'function') throw unavailable('code_request_unavailable');
  if (typeof runtime.releaseDispatch !== 'function' || typeof runtime.reserveDispatch !== 'function') throw fail('email_send_configuration_error');
  timing.path = 'native';
  let checked = await preflight(tab, plan, request, runtime, runtime.reusedPage === true), recovered = false;
  // Page, script or template unavailable: one explicit recovery, still before
  // any dispatch release. Nothing falls back to a DOM send.
  if (checked.reason) {
    recovered = true;
    let navigated = true;
    try { await tab.navigate(plan.page_url); } catch { navigated = false; }
    checked = navigated ? await preflight(tab, plan, request, runtime, false) : {reason: 'navigation_failed'};
  }
  if (!checked.ticket) {
    evidence({provider: plan.provider, outcome: 'not_sent', dispatched: false, template_version: plan.template_version, recovered,
      reason: checked.error ?? checked.reason});
    if (checked.error) throw fail(checked.error);
    throw unavailable(checked.reason);
  }
  const ticket = checked.ticket, drift = driftOf(ticket.drift);
  runtime.reserveDispatch(); await runtime.releaseDispatch();
  if (!await journal.write('dispatching')) return {receipt: unknown};
  timing.attempted = true;
  const dispatchedAt = Date.parse(journal.saved.updated_at);
  const value = await call(tab, NATIVE_DISPATCH_CODE, {provider: plan.provider,
    value: {...nativeMessage(request), token: ticket.token}}) ?? {outcome: 'unknown', reason: 'controller'};
  const timings = timingsOf(value.timings);
  const base = {schema_version: 1, provider: plan.provider, recipient_digest: request.recipientDigest};
  const record = {template_version: plan.template_version, ...(Object.keys(drift).length ? {drift} : {})};
  if (value.outcome === 'sent' && value.provider === plan.provider && value.template_version === plan.template_version && id(value.mailid) && id(value.messageid)) {
    const receipt = {...base, status: 'sent', ...(plan.receipt_provider_message_id ? {provider_message_id: value.mailid} : {})};
    if (!await journal.write('sent', receipt, {proof: {source: plan.template_version, mailid: value.mailid, messageid: value.messageid}, timings, ...record})) throw fail('send_outcome_unknown');
    timing.confirmed = true; timing.native = timings;
    evidence({provider: plan.provider, outcome: 'sent', dispatched: true, template_version: plan.template_version, recovered});
    return {receipt};
  }
  const code = value.outcome === 'provider_code' && Number.isSafeInteger(value.provider_code) ? value.provider_code : undefined;
  const category = code === undefined ? undefined : plan.rejections.get(code);
  if (category) {
    const reason = PROVIDER_REJECTION_REASONS[category];
    const receipt = runtime.providerRejectedReceipt?.(request, {reason, provider_code: code});
    if (receipt && await journal.write('not_sent', receipt, {timings, ...record})) {
      timing.confirmed = true; timing.native = timings;
      evidence({provider: plan.provider, outcome: 'not_sent', dispatched: true, template_version: plan.template_version, recovered, provider_code: code,
        ...(plan.driftCodes.includes(code) ? {reason: 'template_drift'} : {})});
      return {receipt};
    }
  }
  // Pending confirmation: one separate bounded Sent lookup, never a resend.
  const messageid = id(value.messageid) ? value.messageid : undefined;
  const found = Number.isSafeInteger(dispatchedAt) ? await call(tab, NATIVE_LOOKUP_CODE, {provider: plan.provider, value: {account_address: request.account_address,
    to: request.message.to, subject: request.message.subject, ...(messageid ? {messageid} : {}), dispatched_at_ms: dispatchedAt}}) : null;
  Object.assign(timings, timingsOf(found?.timings));
  const proof = found?.proof;
  if (found?.outcome === 'sent' && id(found.provider_message_id) && proof?.source && proof.provider_message_id === found.provider_message_id &&
      proof.folder === 'sent' && proof.fresh === true && (messageid ? proof.response_message_id === messageid : proof.response_message_id === undefined)) {
    const receipt = {...base, status: 'sent', provider_message_id: found.provider_message_id};
    if (!await journal.write('sent', receipt, {proof: {source: proof.source, provider_message_id: found.provider_message_id,
      ...(messageid ? {response_message_id: messageid} : {}), folder: 'sent', fresh: true}, timings, ...record})) throw fail('send_outcome_unknown');
    timing.confirmed = true; timing.native = timings;
    evidence({provider: plan.provider, outcome: 'sent', dispatched: true, template_version: plan.template_version, recovered, reason: reasonCode(value.reason) ?? 'pending', lookup: 'found'});
    return {receipt};
  }
  timing.native = timings;
  evidence({provider: plan.provider, outcome: 'unknown', dispatched: true, template_version: plan.template_version, recovered,
    reason: reasonCode(value.reason) ?? (code !== undefined ? 'provider_code' : 'unknown'), ...(code !== undefined ? {provider_code: code} : {}),
    lookup: reasonCode(found?.reason) ?? 'unavailable'});
  throw fail('send_outcome_unknown');
}
