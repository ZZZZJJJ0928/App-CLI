import {QQ15} from './lib/send-recovery.mjs';
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
    const hash = {type:'string',pattern:'^[a-f0-9]{64}$'}, id = {type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'};
    Object.assign(properties, {status: {enum: ['sent','not_sent']}, recipient_digest: {type: 'string', pattern: '^sha256:[a-f0-9]{64}$'},
      provider_message_id: text, provider_thread_id: text, not_sent:{type:'object',additionalProperties:false,
        properties:{schema_version:{const:1},kind:{enum:provider==='qq_mail'?['pre_dispatch_failure','legacy_15_pre_dispatch_failure']:['pre_dispatch_failure']},
          invocation_id:id,task_id:id,intent_digest:hash,resource_digest:hash,binding_digest:hash,
          ledger_epoch:{type:'integer',minimum:1},reason:{enum:['EMAIL_ATTACHMENT_UPLOAD_UNVERIFIED','EMAIL_ATTACHMENT_UPLOAD_FAILED','EMAIL_ATTACHMENT_UNVERIFIED','BROWSER_EXTENSION_UNAVAILABLE','EMAIL_ATTACHMENT_CONTROL_UNAVAILABLE','EMAIL_DRAFT_FIELDS_UNVERIFIED']}},
        required:['schema_version','kind','invocation_id','task_id','intent_digest','resource_digest','binding_digest','ledger_epoch','reason'],
        allOf:[{if:{properties:{kind:{const:'legacy_15_pre_dispatch_failure'}}},then:{properties:{binding_digest:{const:QQ15},reason:{const:'EMAIL_ATTACHMENT_UPLOAD_UNVERIFIED'}}}}]}});
    required.push('status', 'recipient_digest');
  } else if (command === 'mark_read') {
    Object.assign(properties, {target: object, read_state: {enum: ['read', 'unread', 'unknown']}, observed_at: text});
    required.push('target', 'read_state', 'observed_at');
  } else if (command === 'read' || command === 'capture') {
    Object.assign(properties, {status: {enum: ['empty', 'collected', 'partial']}, capture: {type: ['object', 'null']}});
    required.push('status', 'capture');
  } else if (command === 'discover') {
    Object.assign(properties, {status: {enum: ['listed', 'empty', 'partial']}, account_address: text,
      delivery_address:{type:'string',maxLength:320,pattern:'^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$'},
      account_aliases:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'string',maxLength:320,pattern:'^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$'}},
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
  const schema = {type: 'object', properties, required, additionalProperties: false};
  if (command === 'discover') schema.allOf = [{if:{required:['delivery_address']},then:{required:['account_aliases']}},
    {if:{required:['account_aliases']},then:{required:['delivery_address']}}];
  if (command === 'send') schema.allOf = [{if:{properties:{status:{const:'not_sent'}}},
    then:{required:['not_sent'],not:{anyOf:[{required:['provider_message_id']},{required:['provider_thread_id']}]}},
    else:{not:{required:['not_sent']}}}];
  return schema;
}
