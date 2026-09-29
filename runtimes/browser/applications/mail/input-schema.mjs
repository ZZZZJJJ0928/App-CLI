const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const text = maximum => ({type: 'string', maxLength: maximum});
const id = {type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$'};
const address = {type: 'string', minLength: 3, maxLength: 320, pattern: '^[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+$'};
const providerID = {type: 'string', minLength: 1, maxLength: 1024, pattern: '^[A-Za-z0-9_+=:.~/\\-]+$'};
const hash = {type: 'string', pattern: '^sha256:[a-f0-9]{64}$'};
const scope = {type: 'string', pattern: '^[a-f0-9]{64}$'};
const body = object({format: {const: 'text'}, content: {type: 'string', minLength: 1, maxLength: 204800}});
const recovery = {type: 'object', properties: {id: {type: 'string', pattern: '^cap_[a-f0-9]{32}$'},
  manifest_json: text(65536), manifest_sha256: hash, original_sha256: hash},
  required: ['id', 'manifest_json', 'manifest_sha256', 'original_sha256']};
const target = object({account_address: address, provider_message_id: providerID, provider_selection_id: providerID,
  provider_thread_id: providerID, provider_native_id: providerID, received_at: text(40), folder: text(1032), recovery_capture: recovery},
['account_address', 'provider_message_id', 'provider_selection_id']);
const continuation = text(1100);
const limit = {type: 'integer', minimum: 1, maximum: 100};
const discovery = object({account_address: address, continuation, lane: {const: 'recent_inbound'}, limit,
  interval_start: text(40), interval_end: text(40), provider_mode: {enum: ['change_cursor', 'time_range']},
  retry_targets: {type: 'array', maxItems: 50, items: target},
  skip_provider_message_ids: {type: 'array', maxItems: 100, uniqueItems: true, items: providerID}},
['account_address', 'continuation', 'lane', 'limit', 'interval_start', 'interval_end']);

export function inputSchema(provider, operation) {
  if (operation === 'watch') return object({schema_version: {const: 1}, account_address: address, owner_scope: scope});
  const common = {schema_version: {const: 1}, operation: {const: operation}, invocation_id: id, provider: {const: provider}, account: {const: 'default'}};
  if (operation === 'probe') return object(common);
  if (operation === 'send') {
    const legacy = object({...common, message: object({recipient: address, subject: text(998), body}, ['recipient', 'body'])});
    const message = object({to: {type: 'array', minItems: 1, maxItems: 100, items: address},
      cc: {type: 'array', maxItems: 100, items: address}, subject: text(998), body}, ['to', 'body']);
    const reply = object({account_address: address, provider_message_id: providerID, provider_selection_id: providerID,
      provider_thread_id: providerID, folder: text(1032), subject: text(4000)},
    ['account_address', 'provider_message_id', 'provider_selection_id', 'folder', 'subject']);
    return {oneOf: [legacy, object({...common, message, account_address: address,
      mode: {enum: ['compose', 'reply', 'reply_all', 'reconcile']}, reply_target: reply}, [...Object.keys(common), 'message', 'account_address'])]};
  }
  const properties = {...common, owner_scope: scope};
  const required = Object.keys(properties);
  if (operation === 'capture' || operation === 'mark_read') {properties.target = target; required.push('target');}
  if (operation === 'discover' || operation === 'collect_page') properties.discovery = discovery;
  if (operation === 'collect_page') required.push('discovery');
  if (operation === 'enumerate_thread') {
    properties.thread = object({account_address: address, folder: text(1032), provider_selection_id: providerID, provider_thread_id: providerID});
    Object.assign(properties, {continuation, limit}); required.push('thread', 'continuation', 'limit');
  }
  if (operation === 'mark_read') {
    properties.committed_capture = object({attachments_count: {type: 'integer', minimum: 0, maximum: 20},
      capture_id: {type: 'string', pattern: '^cap_[a-f0-9]{32}$'}, mail_id: text(128), mailbox_id: text(128),
      manifest_path: text(1024), manifest_sha256: hash, read_state: {enum: ['read', 'unread', 'unknown']}});
    required.push('committed_capture');
  }
  return object(properties, required);
}
