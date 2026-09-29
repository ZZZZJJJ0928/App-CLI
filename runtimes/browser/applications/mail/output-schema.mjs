const object = {type: 'object'};
const text = {type: 'string', maxLength: 4096};
const list = {type: 'array', maxItems: 100, items: object};

// Public result shape follows the existing product receipts. In particular,
// mark_read is an observation receipt and has read_state, not status.
export function outputSchema(provider, command) {
  const properties = {schema_version: {const: 1}, provider: {const: provider}};
  const required = ['schema_version', 'provider'];
  if (command === 'probe') {
    Object.assign(properties, {status: {const: 'ready'}, account_hint: text}); required.push('status');
  } else if (command === 'send') {
    Object.assign(properties, {status: {const: 'sent'}, recipient_digest: {type: 'string', pattern: '^sha256:[a-f0-9]{64}$'},
      provider_message_id: text, provider_thread_id: text}); required.push('status', 'recipient_digest');
  } else if (command === 'mark_read') {
    Object.assign(properties, {target: object, read_state: {enum: ['read', 'unread', 'unknown']}, observed_at: text});
    required.push('target', 'read_state', 'observed_at');
  } else if (command === 'read' || command === 'capture') {
    Object.assign(properties, {status: {enum: ['empty', 'collected', 'partial']}, capture: {type: ['object', 'null']}});
    required.push('status', 'capture');
  } else if (command === 'discover') {
    Object.assign(properties, {status: {enum: ['listed', 'empty', 'partial']}, account_address: text,
      candidates: list, threads: list, coverage: object, observed_at: text});
    required.push('status', 'account_address', 'candidates', 'coverage', 'observed_at');
  } else if (command === 'enumerate_thread') {
    Object.assign(properties, {status: {enum: ['partial', 'complete_for_observation']}, thread: object, members: list, coverage: object, observed_at: text});
    required.push('status', 'thread', 'members', 'coverage', 'observed_at');
  } else if (command === 'collect_page') {
    Object.assign(properties, {status: {enum: ['empty', 'collected', 'partial']}, page_id: text, account_address: text,
      discovery: object, discovery_options: object, captures: list, failures: list, observed_at: text});
    required.push('status', 'page_id', 'account_address', 'discovery', 'discovery_options', 'captures', 'failures', 'observed_at');
  } else {
    Object.assign(properties, {status: {const: 'stopped'}}); required.push('status');
  }
  return {type: 'object', properties, required, additionalProperties: false};
}
