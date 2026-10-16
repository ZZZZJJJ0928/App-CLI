import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = new URL('../../', import.meta.url);
const {collectUnread} = await import(new URL('applications/mail/read.mjs', root));
const {networkListPage} = await import(new URL('applications/mail/lib/network-reader.mjs', root));
const address='mailbox@example.test', at='2026-09-24T11:11:22Z';
const row={provider_message_id:'historical-id',provider_thread_id:'historical-id',received_at:at,folder:'inbox',unread:true};
function fixture(change={}) {
  const calls=[], originals=[];
  const reader={provider:'qq_mail',version:'0.2.0',
    snapshot:()=>({provider:'qq_mail',account_address:address,rows:[],unsupported_rows:0,scan_complete:false}),
    listPage:request=>{
      calls.push(structuredClone(request));
      if(request.provider_mode!=='time_range')throw Object.assign(new Error('folder page not qualified'),{code:'email_network_list_unqualified'});
      return {provider:'qq_mail',account_address:change.account??address,page:0,scope:'inbound_received',rows:[{...row,...change.row}],has_next:false,unsupported_rows:0};
    },
    prepareOriginal:target=>{originals.push(structuredClone(target));return {...target,selector:'#sparkclaw-mail-original',bytes:42};},
  };
  const tab={runReadCode:code=>vm.runInNewContext(`(${code})(page)`,{window:{SparkClawMailReader:reader},Date,Promise,setTimeout,page:{evaluate:(fn,arg)=>fn(arg)}})};
  return {tab,calls,originals};
}
const options={account_address:address,pinned_message_id:row.provider_message_id,pinned_selection_id:row.provider_thread_id,pinned_received_at:at,onSelected:async()=>{}};
const code=expected=>error=>error.code===expected;
test('qualified QQ discovery retains its actual receipt timestamp',async()=>{
  const f=fixture(),result=await networkListPage(f.tab,'qq_mail',{account_address:address,lane:'recent_inbound',provider_mode:'time_range',interval_start:'2026-09-24T00:00:00Z',interval_end:'2026-09-25T00:00:00Z',limit:50},null);
  assert.equal(result.discovery.candidates[0].received_at,at);
});
test('QQ history capture requalifies its exact ID in two seconds without depending on the first folder page',async()=>{
  const f=fixture(),result=await collectUnread(f.tab,'qq_mail',options);
  assert.equal(result.provider_message_id,row.provider_message_id);assert.equal(result.read_state,'unread');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].provider_mode,'time_range');
  assert.equal(f.calls[0].interval_start,'2026-09-24T11:11:21.000Z');assert.equal(f.calls[0].interval_end,'2026-09-24T11:11:23.000Z');
  assert.equal(f.originals.length,1);
});
test('QQ receipt metadata must be present and valid before it becomes a target',async()=>{
  for(const received_at of [undefined,'invalid','2026-02-30T00:00:00Z']) {
    const f=fixture({row:{received_at}});
    await assert.rejects(networkListPage(f.tab,'qq_mail',{account_address:address,lane:'recent_inbound',provider_mode:'time_range',interval_start:at,interval_end:'2026-09-25T00:00:00Z',limit:50},null),code('email_network_list_unqualified'));
    assert.equal(f.originals.length,0);
  }
});
test('QQ missing or invalid pinned receipt evidence never expands into a mailbox scan',async()=>{
  for(const pinned_received_at of [undefined,'invalid','2026-02-30T00:00:00Z']) {
    const f=fixture();await assert.rejects(collectUnread(f.tab,'qq_mail',{...options,pinned_received_at}),code('invalid_request'));
    assert.equal(f.calls.length,0);assert.equal(f.originals.length,0);
  }
});
test('QQ ID and receipt-time drift fail before any original download',async()=>{
  for(const [change,error] of [[{provider_message_id:'other-id'},'email_pinned_message_unavailable'],[{received_at:'2026-09-24T11:11:22.001Z'},'email_message_identity_invalid']]) {
    const f=fixture({row:change});await assert.rejects(collectUnread(f.tab,'qq_mail',options),code(error));assert.equal(f.originals.length,0);
  }
});
test('QQ account drift fails before original download',async()=>{
  const f=fixture({account:'other@example.test'});await assert.rejects(collectUnread(f.tab,'qq_mail',options),code('email_network_list_unqualified'));assert.equal(f.originals.length,0);
});
