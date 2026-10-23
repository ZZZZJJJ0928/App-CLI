import {requireCondition} from '../../../src/protocol.mjs';

// Release .15 QQ binding: this exact script wraps every error after dispatch as
// SEND_OUTCOME_UNKNOWN. This compatibility rule is not a generic error mapping.
export const QQ15 = 'e4375abe5b06a033a818ed6a3659d88067c26c7727bbf45848f231274ab5ae97';
const digest = /^[a-f0-9]{64}$/u;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const failures = new Set(['EMAIL_ATTACHMENT_UPLOAD_UNVERIFIED','EMAIL_ATTACHMENT_UPLOAD_FAILED','EMAIL_ATTACHMENT_UNVERIFIED']);

export function createNotSentReceipt(request, context, error, kind) {
  const reason = typeof error === 'string' ? error.toUpperCase() : '';
  const evidence = context.executionEvidence;
  // Only the live, pre-dispatch catch may attest this failure. A historical
  // terminal error (or missing journal) does not establish the dispatch phase.
  const supported = failures.has(reason) || kind === 'pre_dispatch_failure' && ['BROWSER_EXTENSION_UNAVAILABLE','EMAIL_ATTACHMENT_CONTROL_UNAVAILABLE','EMAIL_DRAFT_FIELDS_UNVERIFIED'].includes(reason);
  if (!supported || !evidence || !id.test(evidence.task_id) ||
      !['intent_digest','resource_digest','binding_digest'].every(key => digest.test(evidence[key])) ||
      !Number.isSafeInteger(evidence.ledger_epoch) || evidence.ledger_epoch < 1) return null;
  return {schema_version:1,provider:request.provider,status:'not_sent',recipient_digest:request.recipientDigest,
    not_sent:{schema_version:1,kind,invocation_id:request.invocation_id,...evidence,reason}};
}

// A released dispatch that the provider explicitly rejected with one of its
// listed codes (provider module `rejections`). Bound to the original task.
export const PROVIDER_REJECTION_REASONS = Object.freeze({login:'PROVIDER_LOGIN_REJECTED',parameter:'PROVIDER_PARAMETER_REJECTED',temporary:'PROVIDER_TEMPORARILY_REJECTED'});
export const PROVIDER_REJECTED_REASONS = Object.freeze(Object.values(PROVIDER_REJECTION_REASONS));
export function createProviderRejectedReceipt(request, context, {reason, provider_code} = {}) {
  const evidence = context.executionEvidence;
  if (!PROVIDER_REJECTED_REASONS.includes(reason) || !Number.isSafeInteger(provider_code) || !evidence || !id.test(evidence.task_id) ||
      !['intent_digest','resource_digest','binding_digest'].every(key => digest.test(evidence[key])) ||
      !Number.isSafeInteger(evidence.ledger_epoch) || evidence.ledger_epoch < 1) return null;
  return {schema_version:1,provider:request.provider,status:'not_sent',recipient_digest:request.recipientDigest,
    not_sent:{schema_version:1,kind:'provider_rejected',invocation_id:request.invocation_id,task_id:evidence.task_id,
      intent_digest:evidence.intent_digest,resource_digest:evidence.resource_digest,binding_digest:evidence.binding_digest,
      ledger_epoch:evidence.ledger_epoch,reason,provider_code}};
}

export function legacyNotSentReceipt(request, context) {
  const previous = context.reconciliation;
  if (request.provider !== 'qq_mail' || context.executionEvidence?.binding_digest !== QQ15 ||
      previous?.status !== 'uncertain' || previous.effect !== 1 || previous.reason !== 'EMAIL_ATTACHMENT_UPLOAD_UNVERIFIED') return null;
  return createNotSentReceipt(request,context,previous.reason,'legacy_15_pre_dispatch_failure');
}

export function validateNotSentBinding(result, input, context) {
  if (result?.status !== 'not_sent') return;
  const proof = result.not_sent, expected = context.executionEvidence;
  requireCondition(proof && expected && proof.invocation_id === input.invocation_id &&
    ['task_id','intent_digest','resource_digest','binding_digest'].every(key => proof[key] === expected[key]) &&
    Number.isSafeInteger(proof.ledger_epoch) && proof.ledger_epoch > 0 && proof.ledger_epoch <= expected.ledger_epoch,
    'SEND_OUTCOME_UNKNOWN');
}
