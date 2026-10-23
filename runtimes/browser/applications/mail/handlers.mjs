import {setTimeout as delay} from 'node:timers/promises';
import {MailPage, createProviderRuntime} from './runtime/mail-page.mjs';
import {ProviderScriptRegistry} from './runtime/provider-scripts.mjs';
import {isManagedSend, nativeSendFor} from './lib/managed-send.mjs';
import {createNotSentReceipt, createProviderRejectedReceipt, legacyNotSentReceipt, validateNotSentBinding} from './lib/send-recovery.mjs';
import {removeSendJournal} from './lib/send-journal.mjs';
import {isReceiveRead, mailAccount} from './page-policy.mjs';
import {validCandidateTargets} from './runtime/mail-notification-rules.mjs';
import {CONTROLLER_ERROR_CODES} from './runtime/errors.mjs';

const DIAGNOSTIC_CODES=new Set([...Object.keys(CONTROLLER_ERROR_CODES),
  'HOST_STALE','HOST_LEASE_EXPIRED','HOST_LEASE_INVALID','HOST_UNAVAILABLE','HOST_TIMEOUT','HOST_RESOURCE_BUSY',
  'HOST_ARTIFACT_INVALID','AUTHORIZATION_EXPIRED','CANCEL_REQUESTED','EXECUTOR_STOPPING','EFFECT_DENIED',
  'ENOENT','EACCES','EPERM','ENOSPC','EIO','EMFILE','ENFILE',
  'email_account_identity_mismatch','email_account_identity_unavailable','email_login_required','email_provider_origin_invalid',
  'email_network_capability_unavailable','email_network_read_failed','email_network_template_unlearned','email_network_template_stale',
  'email_network_list_unqualified','email_network_original_unqualified','email_capture_invalid','email_capture_limit',
  'email_capture_unavailable','email_download_limit','email_local_io','email_batch_limit','email_source_conflict','email_source_recovery_pending'].flatMap(code=>[code,code.toLowerCase(),code.toUpperCase()]));
const DIAGNOSTIC_REASONS=new Set(['process_exit_context_destroyed','process_exit_page_closed','process_exit_syntax',
  'process_exit_invalid_arguments','process_exit_target_missing','process_exit_target_ambiguous','process_exit_download_timeout',
  'process_exit_action_timeout','output_overflow','task_page_missing','application_cleanup_fenced']);
const DIAGNOSTIC_METHODS=new Set(['navigate','prepareBackgroundPage','runReadCode','currentURL','inspect','readMany','download',
  'click','fill','focus','press','waitFor','waitMilliseconds','evaluate','runCodeRequest','count','attribute','value','text','lines','visible','enabled','run-code','tab-close']);
function captureFailureDiagnostic(provider,phase,error,milliseconds){
 try{
  const name=['Error','TypeError','ReferenceError','SyntaxError','RangeError','URIError','EvalError','AggregateError','AbortError','TimeoutError','ControllerError','RuntimeError'].includes(error?.name)?error.name:'unavailable';
  const code=DIAGNOSTIC_CODES.has(error?.code)?error.code:'unavailable';
  const reason=error?.diagnosticReason??error?.reason,method=error?.mailHostMethod??error?.diagnosticCommand;
  const record={event:'mail_capture_phase_failed',provider,operation:'collect_page',phase,exception_name:name,exception_code:code,
   ...(DIAGNOSTIC_REASONS.has(reason)?{host_reason:reason}:{}),...(DIAGNOSTIC_METHODS.has(method)?{host_method:method}:{}),milliseconds};
  process.stderr.write(JSON.stringify(record)+'\n');
 }catch{/* Diagnostics cannot change the original failure or uncertainty. */}
}

export async function mailHandlers() {
  const registry = new ProviderScriptRegistry(); await registry.prepare();
  const handlers = {};
  for (const entry of registry.entries.values()) {
    const name = entry.operation === 'observe' ? 'watch' : entry.operation;
    handlers[`${entry.provider}.${name}`] = name === 'watch' ? {run: (input, context) => watch(entry, input, context)} : {
      run: (input, context) => execute(entry, input, context),
      ...(['send', 'read', 'capture', 'collect_page'].includes(name) ? {reconcile: (input, context) => execute(entry, input, context, true)} : {}),
      // Captured mail is business data owned by the product; only the send
      // journal is runtime evidence reclaimed with its ledger row.
      ...(name === 'send' ? {reclaim: (input, context) => removeSendJournal(context.resource.workspace_root, {...input, provider: entry.provider})} : {}),
    };
  }
  return handlers;
}

function secrets(input) {
  const message = input.message;
  return {...Object.fromEntries([...message.to ?? [], ...message.cc ?? []].map((value, index) => [`EMAIL_RECIPIENT_${index}`, value])),
    ...(message.recipient ? {SPARKCLAW_EMAIL_RECIPIENT: message.recipient} : {}),
    SPARKCLAW_EMAIL_SUBJECT: message.subject ?? '', SPARKCLAW_EMAIL_BODY: message.body.content};
}

async function prepare(entry, input, context, native) {
  const page = new MailPage(context.browser, entry, context);
  // A native send keeps its content out of the private slots: it travels only
  // with the dispatch call. Its preflight checks the document and account.
  if (entry.operation === 'send' && !native) {
    page.sendSecrets = secrets(input);
    await context.browser.call('setSecrets', page.sendSecrets);
  }
  if (!context.browser.reused) await page.navigate(entry.loginURL);
  if (native) return page;
  const account = mailAccount(input) || context.resource.account_address;
  if (entry.operation !== 'probe' || account) await page.prepareBackgroundPage();
  if (isReceiveRead(entry.operation) && account) await page.prepareMailRound(account, context.browser.reused);
  return page;
}

async function execute(entry, original, context, reconcile = false) {
  const input = structuredClone(original);
  entry.validate(input);
  if (reconcile && entry.operation === 'send') {
    // The migrated send journal supplies evidence; it never resends a dispatch
    // marked uncertain. Legacy sends lack sufficient evidence for reconciliation.
    if (!isManagedSend(input)) return {status: 'uncertain', reason: 'SEND_OUTCOME_UNKNOWN'};
    input.mode = 'reconcile';
    const result = await entry.handler(input, {emailWorkspaceRoot: context.resource.workspace_root, originalMode: original.mode,
      reconcileNotSentReceipt: request => legacyNotSentReceipt(request, context)});
    validateNotSentBinding(result, input, context);
    return result.status === 'unknown' ? {status: 'uncertain', reason: 'SEND_OUTCOME_UNKNOWN'} : {data: result};
  }
  let phase='prepare',phaseStarted=performance.now();const milliseconds={};
  const measurePhase=()=>{milliseconds[phase]=Math.min(86_400_000,Math.max(0,Math.round(performance.now()-phaseStarted)));};
  const enterPhase=next=>{measurePhase();phase=next;phaseStarted=performance.now();};
  try {
    const native = entry.operation === 'send' ? nativeSendFor(entry.provider, input) : null;
    const page = await prepare(entry, input, context, native);
    const remoteSelector = selector => selector === entry.effectSelector || entry.effectSelectors?.includes(selector);
    const originalClick = page.click;
    page.click = async (...args) => {if (remoteSelector(args[0])) await context.beforeEffect(); return originalClick(...args);};
    // Mark-read releases its dispatch just before the native request, inside
    // markCapturedRead, after the target has been reselected.
    if (!reconcile && ["read", "capture", "collect_page"].includes(entry.operation)) await context.beforeEffect();
    const runtime = createProviderRuntime(page, entry);
    if (entry.operation === 'send') {
      runtime.notSentReceipt = (request, reason) => createNotSentReceipt(request, context, reason, 'pre_dispatch_failure');
      runtime.providerRejectedReceipt = (request, rejection) => createProviderRejectedReceipt(request, context, rejection);
    }
    enterPhase('handler');
    const result = await entry.handler(input, runtime);
    if (result?.status === 'unknown') return {status: 'uncertain', reason: 'SEND_OUTCOME_UNKNOWN'};
    // Per-message capture/coverage failures describe the result, not ownership
    // of the shared page. A successful guarded reset below proves reusability
    // and keeps the independent watch alive even when the round is partial.
    const account = mailAccount(input) || context.resource.account_address;
    let retain = isReceiveRead(entry.operation) && !input.sent_match && Boolean(account) &&
      ['ready', 'collected', 'empty', 'partial', 'listed', 'complete_for_observation'].includes(result?.status);
    if (retain) {
      enterPhase('park');
      await page.parkMailRound(account);
    }
    // A native send page stays parked after a decided result. A login
    // rejection invalidates it so the next send starts cold.
    let invalidate = isReceiveRead(entry.operation) && !retain;
    if (native) {
      const loginRejected = result?.status === 'not_sent' && result.not_sent?.kind === 'provider_rejected' && result.not_sent.reason === 'PROVIDER_LOGIN_REJECTED';
      retain = result?.status === 'sent' || result?.status === 'not_sent' && result.not_sent?.kind === 'provider_rejected' && !loginRejected;
      invalidate = loginRejected;
    }
    return {data: result, retain, invalidate};
  } catch (error) {
    if(entry.operation==='collect_page'){measurePhase();captureFailureDiagnostic(entry.provider,phase,error,milliseconds);}
    const reason = typeof error.code === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(error.code) ? error.code.toUpperCase() : 'PROVIDER_SCRIPT_FAILED';
    if (/LOGIN_REQUIRED|ACCOUNT_IDENTITY/u.test(reason)) return {status: 'waiting_confirmation', reason, invalidate: isReceiveRead(entry.operation)};
    if (reason === 'SEND_OUTCOME_UNKNOWN') return {status: 'uncertain', reason};
    throw Object.assign(new Error(reason), {code: reason});
  }
}

async function watch(entry, input, context) {
  const page = new MailPage(context.browser, {...entry, operation: 'collect_page'}, context);
  if (!context.browser.reused) await page.navigate(entry.loginURL);
  await page.prepareBackgroundPage();
  await page.prepareMailRound(input.account_address, context.browser.reused);
  await context.browser.call('hookActivate');
  if (context.resource.previous_task_id) context.emit('gap', {reason: 'watch_replaced', previous_task_id: context.resource.previous_task_id});
  if (context.resource.previous_request_key) context.emit('gap', {reason: 'watch_admission_unresolved', previous_request_key: context.resource.previous_request_key});
  context.emit('watch_ready', {provider: entry.provider, resync_required: true});
  let cursor = 0, document = null, sequence = 0, lastEvent = Date.now();
  const retiredDocuments = new Set();
  for (;;) {
    context.check();
    const batch = await context.browser.call('hookEvents', cursor); cursor = batch.cursor;
    if (batch.gap) context.emit('gap', {reason: 'host_event_gap'});
    for (const event of batch.events) {
      const value = event.value;
      if (!value || typeof value.document !== 'string' || value.document.length > 64 ||
          !Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.account_ok !== 'boolean') continue;
      if (value.document !== document) {
        if (retiredDocuments.has(value.document) || value.kind !== 'document' || value.sequence !== 1) continue;
        if (document) retiredDocuments.add(document);
        if (retiredDocuments.size > 16) return {status: 'blocked', reason: 'OBSERVER_DOCUMENT_STORM'};
        document = value.document; sequence = 0; context.emit('gap', {reason: 'document_changed'});
      }
      if (value.sequence <= sequence) continue;
      if (event.dropped || (sequence && value.sequence !== sequence + 1)) context.emit('gap', {reason: 'observer_event_gap'});
      sequence = value.sequence; lastEvent = Date.now();
      if (!value.account_ok) return {status: 'waiting_confirmation', reason: 'EMAIL_ACCOUNT_IDENTITY_UNAVAILABLE'};
      if (value.kind === 'degraded') context.emit('gap', {reason: 'observer_degraded'});
      if (value.kind === 'mailbox_changed' && ['qq_inbound_envelope', 'gmail_topic_invalidation', 'outlook_delivery_change'].includes(value.reason)) {
        // Page output is untrusted: malformed candidates are dropped, never the hint.
        const targets = value.targets !== undefined && validCandidateTargets(value.targets) ? value.targets : [];
        context.emit('mailbox_changed', {provider: entry.provider, reason: value.reason, ...(targets.length ? {targets} : {})});
      }
    }
    if (Date.now() - lastEvent > 60000) return {status: 'blocked', reason: 'OBSERVER_DISCONNECTED'};
    await delay(500, undefined, {signal: context.signal});
  }
}
