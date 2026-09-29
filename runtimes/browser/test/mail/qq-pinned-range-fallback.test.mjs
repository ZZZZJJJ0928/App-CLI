import assert from 'node:assert/strict';
import test from 'node:test';
import {collectUnread} from '../../applications/mail/read.mjs';

const account='test@example.com';

function fixture(rangeID) {
  const requests=[];
  const tab={async runReadCode(code) {
    if(code.includes('"method":"snapshot"'))return {provider:'qq_mail',account_address:account,rows:[],unsupported_rows:0,scan_complete:false};
    if(!code.includes('"method":"listPage"'))throw new Error('unexpected network call');
    const range=code.includes('"provider_mode":"time_range"');
    requests.push(range?'range':'folder');
    if(!range)throw Object.assign(new Error('folder list unavailable'),{code:'email_network_list_unqualified'});
    return {provider:'qq_mail',account_address:account,page:0,scope:'inbound_received',folder_scope_id:'search_inbound_v1',
      rows:[{provider_message_id:rangeID,provider_selection_id:rangeID,provider_thread_id:rangeID,folder:'inbox',received_at:new Date().toISOString()}],
      unsupported_rows:0,has_next:false};
  }};
  return {tab,requests};
}

function options() {
  return {account_address:account,pinned_message_id:'target-1',pinned_selection_id:'target-1',folder:'inbox',
    capture_required:false,onSelected:async()=>{}};
}

test('QQ pinned capture uses the bounded range only after folder-list failure and exact stable-ID match',async()=>{
  const {tab,requests}=fixture('target-1');
  const selected=await collectUnread(tab,'qq_mail',options());
  assert.equal(selected.provider_message_id,'target-1');
  assert.deepEqual(requests,['folder','range']);
});

test('QQ pinned range fallback rejects another stable ID',async()=>{
  const {tab,requests}=fixture('different-2');
  await assert.rejects(collectUnread(tab,'qq_mail',options()),{code:'email_network_list_unqualified'});
  assert.deepEqual(requests,['folder','range']);
});

test('Gmail pinned capture resolves a discovered stable ID from the native list page',async()=>{
  const requests=[];
  const tab={async runReadCode(code){
    if(code.includes('"method":"snapshot"')){
      requests.push('snapshot');
      return {provider:'gmail',account_address:account,rows:[],unsupported_rows:0,scan_complete:false};
    }
    if(code.includes('"method":"listPage"')){
      requests.push('listPage');
      return {provider:'gmail',account_address:account,page:0,scope:'inbound_received',
        rows:[{provider_message_id:'target-1',provider_thread_id:'thread-1',folder:'inbox',received_at:new Date().toISOString()}],
        unsupported_rows:0,has_next:false};
    }
    throw new Error('unexpected network call');
  }};
  const selected=await collectUnread(tab,'gmail',{...options(),pinned_selection_id:'thread-1'});
  assert.equal(selected.provider_message_id,'target-1');
  assert.equal(selected.provider_selection_id,'thread-1');
  assert.deepEqual(requests,['snapshot','listPage']);
});

test('Outlook pinned capture queries the native folder page after an empty startup snapshot',async()=>{
  const requests=[];
  const tab={async runReadCode(code){
    if(code.includes('"method":"snapshot"')){
      requests.push('snapshot');
      return {provider:'outlook',account_address:account,rows:[],unsupported_rows:0,scan_complete:false};
    }
    if(code.includes('"method":"listPage"')){
      requests.push('listPage');
      return {provider:'outlook',account_address:account,page:0,scope:'inbound_received',
        rows:[{provider_message_id:'target-1',provider_thread_id:'thread-1',folder:'inbox',received_at:new Date().toISOString()}],
        unsupported_rows:0,has_next:false};
    }
    throw new Error('unexpected network call');
  }};
  const selected=await collectUnread(tab,'outlook',{...options(),pinned_selection_id:'thread-1'});
  assert.equal(selected.provider_message_id,'target-1');
  assert.equal(selected.provider_selection_id,'thread-1');
  assert.deepEqual(requests,['snapshot','listPage']);
});

test('Outlook pinned capture rechecks an immutable ID in a receipt-time native search',async()=>{
  const requests=[];
  const tab={async runReadCode(code){
    if(code.includes('"method":"snapshot"')){
      requests.push('snapshot');
      return {provider:'outlook',account_address:account,rows:[],unsupported_rows:0,scan_complete:false};
    }
    if(code.includes('const armed=await page.evaluate')){
      requests.push('range');
      return {provider:'outlook',account_address:account,page:0,scope:'inbound_received',
        rows:[{provider_message_id:'immutable-1',provider_thread_id:'thread-1',folder:'inbox',received_at:'2026-09-24T07:35:00Z'}],
        unsupported_rows:0,has_next:false};
    }
    throw new Error('unexpected network call');
  }};
  const selected=await collectUnread(tab,'outlook',{...options(),pinned_message_id:'immutable-1',pinned_selection_id:'thread-1',pinned_received_at:'2026-09-24T07:35:00Z'});
  assert.equal(selected.provider_message_id,'immutable-1');
  assert.deepEqual(requests,['snapshot','range']);
});
