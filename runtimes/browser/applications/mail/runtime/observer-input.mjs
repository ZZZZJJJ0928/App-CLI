import {invalidRequest} from './errors.mjs';
const PROVIDERS = new Set(['qq_mail', 'gmail', 'outlook']);
const REASONS = new Set(['qq_inbound_envelope', 'gmail_topic_invalidation', 'outlook_delivery_change', 'frame_limit', 'buffer_limit', 'framing', 'channel_error', 'unclassified_notification']);
const KINDS = new Set(['document', 'liveness', 'evidence', 'chunk', 'heartbeat', 'channel_open', 'channel_closed', 'degraded', 'mailbox_changed']);

export function validateMailObserverInput(provider, input) {
  if (!PROVIDERS.has(provider) || !input || Object.keys(input).sort().join(',') !== 'account_address,action,owner_scope,schema_version' ||
      !['start', 'status', 'stop'].includes(input.action) || input.schema_version !== 1 ||
      typeof input.account_address !== 'string' || input.account_address.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.account_address) || !/^[a-f0-9]{64}$/.test(input.owner_scope)) {
    throw invalidRequest();
  }
}

