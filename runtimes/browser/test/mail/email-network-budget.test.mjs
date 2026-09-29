import assert from 'node:assert/strict';
import test from 'node:test';
import {networkListPage} from '../../applications/mail/lib/network-reader.mjs';

const options={account_address:'owner@example.test',lane:'recent_inbound',interval_start:'2026-09-15T00:00:00Z',interval_end:'2026-09-16T00:00:00Z',limit:50,provider_mode:'time_range'};
const member=(index,size=1800)=>({provider_message_id:`message-${index}`,provider_thread_id:`thread-${index}-${'x'.repeat(size)}`,received_at:'2026-09-15T12:00:00Z',folder:'inbox'});
function fixture(provider,rows,hasNext=false){
  let calls=0;
  return {get calls(){return calls;},tab:{runReadCode:async()=>{calls++;return {provider,account_address:options.account_address,page:0,rows,has_next:hasNext,unsupported_rows:0,scope:'inbound_received'};}}};
}

for(const provider of ['gmail','qq_mail','outlook']){
  test(`${provider}: local candidate wire budget throws operational error, never returns provider gap`,async()=>{
    const f=fixture(provider,Array.from({length:20},(_,i)=>member(i)));
    await assert.rejects(networkListPage(f.tab,provider,options,{}),{code:'email_batch_limit'});
    assert.equal(f.calls,1,'must not paginate or retry to work around a local limit');
  });
  test(`${provider}: provider continuation remains distinct from local budget failure`,async()=>{
    const f=fixture(provider,[member(0,10)],true);
    const result=await networkListPage(f.tab,provider,options,{});
    assert.equal(result.discovery.coverage.reason,'network_page_continues');
    assert.equal(result.discovery.coverage.scan_complete,false);
    assert.ok(result.discovery.coverage.continuation);
    assert.equal(f.calls,1);
  });
}

test('candidate budget counts UTF-8 bytes, not JavaScript character length',async()=>{
  const rows=Array.from({length:10},(_,i)=>({...member(i,0),provider_thread_id:`thread-${i}-${'界'.repeat(800)}`}));
  const f=fixture('gmail',rows);
  await assert.rejects(networkListPage(f.tab,'gmail',options,{}),{code:'email_batch_limit'});
  assert.equal(f.calls,1);
});
