import {setTimeout as delay} from 'node:timers/promises';
import {MailPage, createProviderRuntime} from './runtime/mail-page.mjs';
import {ProviderScriptRegistry} from './runtime/provider-scripts.mjs';
import {isManagedSend} from './lib/managed-send.mjs';

export async function mailHandlers() {
  const registry = new ProviderScriptRegistry(); await registry.prepare();
  const handlers = {};
  for (const entry of registry.entries.values()) {
    const name = entry.operation === 'observe' ? 'watch' : entry.operation;
    handlers[`${entry.provider}.${name}`] = name === 'watch' ? {run: (input, context) => watch(entry, input, context)} : {
      run: (input, context) => execute(entry, input, context),
      ...(['send', 'read', 'capture', 'collect_page'].includes(name) ? {reconcile: (input, context) => execute(entry, input, context, true)} : {}),
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
  if (entry.operation === 'send') await context.browser.call('setSecrets', secrets(input));
  if (!context.browser.reused) await page.navigate(entry.loginURL);
  if (entry.operation !== 'probe') await page.prepareBackgroundPage();
  if (entry.operation === 'collect_page') await page.prepareMailRound(input.discovery.account_address, context.browser.reused);
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
    const result = await entry.handler(input, {emailWorkspaceRoot: context.resource.workspace_root});
    return result.status === 'unknown' ? {status: 'uncertain', reason: 'SEND_OUTCOME_UNKNOWN'} : {data: result};
  }
  try {
    const page = await prepare(entry, input, context);
    const remoteSelector = selector => selector === entry.effectSelector || entry.effectSelectors?.includes(selector);
    const originalClick = page.click;
    page.click = async (...args) => {if (remoteSelector(args[0])) context.beforeEffect(); return originalClick(...args);};
    // Mark-read can use a provider native request rather than a button selector.
    if (entry.operation === 'mark_read') context.beforeEffect();
    if (!reconcile && ["read", "capture", "collect_page"].includes(entry.operation)) context.beforeEffect();
    const result = await entry.handler(input, createProviderRuntime(page, entry));
    if (result?.status === 'unknown') return {status: 'uncertain', reason: 'SEND_OUTCOME_UNKNOWN'};
    const retain = entry.operation === 'collect_page' && ['collected', 'empty'].includes(result?.status) && !result.failures?.length;
    if (retain) {
      await page.parkMailRound(input.discovery.account_address);
    }
    return {data: result, retain, invalidate: entry.operation === 'collect_page' && !retain};
  } catch (error) {
    const reason = typeof error.code === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(error.code) ? error.code.toUpperCase() : 'PROVIDER_SCRIPT_FAILED';
    if (/LOGIN_REQUIRED|ACCOUNT_IDENTITY/u.test(reason)) return {status: 'waiting_confirmation', reason, invalidate: entry.operation === 'collect_page'};
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
        context.emit('mailbox_changed', {provider: entry.provider, reason: value.reason});
      }
    }
    if (Date.now() - lastEvent > 60000) return {status: 'blocked', reason: 'OBSERVER_DISCONNECTED'};
    await delay(500, undefined, {signal: context.signal});
  }
}
