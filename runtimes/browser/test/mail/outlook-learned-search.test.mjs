import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {networkListPage} from '../../applications/mail/lib/network-reader.mjs';

const owner='owner@example.test';
const options={account_address:owner,lane:'recent_inbound',interval_start:'2026-09-15T00:00:00Z',interval_end:'2026-09-16T00:00:00Z',limit:50,provider_mode:'time_range'};
const page={provider:'outlook',account_address:owner,page:0,rows:[],has_next:false,unsupported_rows:0,scope:'inbound_received',folder_scope_id:'a'.repeat(64)};

function fixture(replays) {
  const ui=[],calls=[];
  const reader={provider:'outlook',version:'0.2.0',
    listPage:async()=>{calls.push('listPage');const next=replays.shift();if(next)throw Object.assign(new Error(next),{code:next});return page;},
    armRangeSearch:()=>{calls.push('arm');return {query:'received>=x'};}};
  const pageHandle={evaluate:(callback,value)=>callback(value),locator:selector=>({fill:async value=>ui.push(['fill',selector,value]),press:async key=>ui.push(['press',selector,key])})};
  const tab={runReadCode:async code=>vm.runInNewContext(`(${code})`,{window:{SparkClawMailReader:reader}})(pageHandle)};
  return {tab,ui,calls};
}

test('a learned Outlook search is replayed without touching the search box',async()=>{
  const f=fixture([]);
  const result=await networkListPage(f.tab,'outlook',options,{});
  assert.equal(result.discovery.coverage.scan_complete,true);
  assert.deepEqual(f.calls,['listPage']);assert.deepEqual(f.ui,[]);
});

for(const reason of ['email_network_template_unlearned','email_network_template_stale']){
  test(`${reason} falls back to one UI-triggered native search`,async()=>{
    const f=fixture([reason]);
    await networkListPage(f.tab,'outlook',options,{});
    assert.deepEqual(f.calls,['listPage','arm','listPage']);
    assert.deepEqual(f.ui,[['fill','#topSearchInput','received>=x'],['press','#topSearchInput','Enter']]);
  });
}

test('other replay failures surface without UI interaction',async()=>{
  const f=fixture(['email_network_read_failed']);
  await assert.rejects(networkListPage(f.tab,'outlook',options,{}),{code:'email_network_read_failed'});
  assert.deepEqual(f.ui,[]);
});
