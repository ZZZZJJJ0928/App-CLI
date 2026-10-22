import {setTimeout as delay} from 'node:timers/promises';
import {MailPage, createProviderRuntime} from './runtime/mail-page.mjs';
import {ProviderScriptRegistry} from './runtime/provider-scripts.mjs';
import {isManagedSend} from './lib/managed-send.mjs';
import {createNotSentReceipt, legacyNotSentReceipt, validateNotSentBinding} from './lib/send-recovery.mjs';
import {removeSendJournal} from './lib/send-journal.mjs';
import {isReceiveRead, mailAccount} from './page-policy.mjs';
import {validCandidateTargets} from './runtime/mail-notification-rules.mjs';

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

async function prepare(entry, input, context) {
  const page = new MailPage(context.browser, entry, context);
  if (entry.operation === 'send') {
    page.sendSecrets = secrets(input);
    await context.browser.call('setSecrets', page.sendSecrets);
  }
  if (!context.browser.reused) await page.navigate(entry.loginURL);
  const account = mailAccount(input) || context.resource.account_address;
  if (entry.operation !== 'probe' || account) await page.prepareBackgroundPage();
  if (isReceiveRead(entry.operation) && account) await page.prepareMailRound(account, context.browser.reused);
  if (entry.provider === 'qq_mail' && entry.operation === 'send' && context.browser.reused) {
    try { await page.prepareMailRound(account, true); }
    catch (error) {
      // A reloaded or replaced document lost its page-memory template, and its
      // Reader is never relabeled. Nothing was dispatched: send as a cold page.
      if (error.code !== 'browser_page_stale') throw error;
      await page.navigate(entry.loginURL);
    }
  }
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
  try {
    const page = await prepare(entry, input, context);
    const remoteSelector = selector => selector === entry.effectSelector || entry.effectSelectors?.includes(selector);
    const originalClick = page.click;
    page.click = async (...args) => {if (remoteSelector(args[0])) await context.beforeEffect(); return originalClick(...args);};
    // Mark-read releases its dispatch just before the native request, inside
    // markCapturedRead, after the target has been reselected.
    if (!reconcile && ["read", "capture", "collect_page"].includes(entry.operation)) await context.beforeEffect();
    const runtime = createProviderRuntime(page, entry);
    if (entry.operation === 'send') runtime.notSentReceipt = (request, reason) => createNotSentReceipt(request, context, reason, 'pre_dispatch_failure');
    const result = await entry.handler(input, runtime);
    if (result?.status === 'unknown') return {status: 'uncertain', reason: 'SEND_OUTCOME_UNKNOWN'};
    // Per-message capture/coverage failures describe the result, not ownership
    // of the shared page. A successful guarded reset below proves reusability
    // and keeps the independent watch alive even when the round is partial.
    const account = mailAccount(input) || context.resource.account_address;
    let retain = isReceiveRead(entry.operation) && Boolean(account) &&
      ['ready', 'collected', 'empty', 'partial', 'listed', 'complete_for_observation'].includes(result?.status);
    if (retain) {
      await page.parkMailRound(account);
    }
    if (entry.provider === 'qq_mail' && entry.operation === 'send' && result?.status === 'sent' &&
        process.env.APP_CLI_MAIL_NATIVE_SEND === 'qq_mail') {
      // This is after the durable sent receipt. Failure to park only closes the
      // page; it must not discard a proved send or invite another dispatch.
      try { retain = await page.parkSendTemplate(account); } catch { retain = false; }
    }
    return {data: result, retain, invalidate: isReceiveRead(entry.operation) && !retain};
  } catch (error) {
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
