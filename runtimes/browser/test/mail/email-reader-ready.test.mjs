import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {networkSnapshot, networkListPage} from '../../applications/mail/lib/network-reader.mjs';

function fixture(mode) {
  let clock=0,sleeps=0,reads=0,calls=0;
  const output={provider:'qq_mail',account_address:'owner@example.test',rows:[],unsupported_rows:0,scan_complete:false};
  const reader={provider:'qq_mail',version:mode==='stale'?'0.1.0':'0.2.0',snapshot(){
    reads++;
    if(mode==='mismatch'||mode==='loading'&&sleeps<2||mode==='unavailable')throw Object.assign(new Error(),{code:mode==='mismatch'?'email_account_identity_mismatch':'email_account_identity_unavailable'});
    return output;
  }};
  const window={};Object.defineProperty(window,'SparkClawMailReader',{get:()=>mode==='late_script'&&sleeps<2?undefined:reader});
  const context=vm.createContext({window,Date:{now:()=>clock},setTimeout(fn,ms){sleeps++;clock+=ms;fn();}});
  const tab={runReadCode:async code=>{calls++;const run=vm.runInContext('('+code+')',context);return run({evaluate:(fn,args)=>fn(args)});}};
  return {tab,stats:()=>({sleeps,reads,calls})};
}

for(const mode of ['loading','late_script'])test(`snapshot waits only for local ${mode}, with one browser call`,async()=>{
  const f=fixture(mode),out=await networkSnapshot(f.tab,'qq_mail',{account_address:'owner@example.test'},{required:true});
  assert.equal(out.account_address,'owner@example.test');assert.equal(f.stats().sleeps,2);assert.equal(f.stats().calls,1);
});
test('ready account incurs no delay, while wrong account and stale version fail immediately',async()=>{
  const ready=fixture('ready');await networkSnapshot(ready.tab,'qq_mail',{}, {required:true});assert.equal(ready.stats().sleeps,0);
  for(const [mode,code] of [['mismatch','email_account_identity_mismatch'],['stale','email_network_capability_unavailable']]){
    const f=fixture(mode);await assert.rejects(networkSnapshot(f.tab,'qq_mail',{}, {required:true}),{code});assert.equal(f.stats().sleeps,0);
  }
});
test('missing local account is bounded and remains operational rather than fabricated empty',async()=>{
  const f=fixture('unavailable');await assert.rejects(networkSnapshot(f.tab,'qq_mail',{}, {required:true}),{code:'email_account_identity_unavailable'});
  assert.equal(f.stats().sleeps,50);assert.equal(f.stats().calls,1);
});

test('timeline readiness and list share one browser command; only local pre-request readiness retries', async()=>{
  let clock=0,snapshots=0,lists=0,calls=0;
  const reader={provider:'qq_mail',version:'0.2.0',snapshot(){
    if(++snapshots<3)throw Object.assign(new Error(),{code:'email_account_identity_unavailable'});
  },async listPage(){lists++;return {provider:'qq_mail',account_address:'owner@example.test',page:0,rows:[],has_next:false,unsupported_rows:0,scope:'inbound_received',folder_scope_id:'fixture'};}};
  const context=vm.createContext({window:{SparkClawMailReader:reader},Date:{now:()=>clock},setTimeout(fn,ms){clock+=ms;fn();}});
  const tab={runReadCode:async code=>{calls++;return vm.runInContext('('+code+')',context)({evaluate:(fn,args)=>fn(args)});}};
  const options={account_address:'owner@example.test',provider_mode:'time_range',lane:'recent_inbound',interval_start:'2026-09-16T00:00:00Z',interval_end:'2026-09-16T00:01:00Z',limit:50};
  const out=await networkListPage(tab,'qq_mail',options,null);
  assert.equal(out.discovery.coverage.scan_complete,true);
  assert.deepEqual({snapshots,lists,calls},{snapshots:3,lists:1,calls:1});
  reader.listPage=async()=>{lists++;throw Object.assign(new Error(),{code:'email_account_identity_unavailable'});};
  await assert.rejects(networkListPage(tab,'qq_mail',options,null),{code:'email_account_identity_unavailable'});
  assert.equal(lists,2); // A post-request account failure must never replay the query.
});

test('timeline list failures retain only a bounded managed-reader diagnostic stage', async()=>{
  const options={account_address:'owner@example.test',provider_mode:'time_range',lane:'recent_inbound',interval_start:'2026-09-16T00:00:00Z',interval_end:'2026-09-16T00:01:00Z',limit:50};
  const staged={provider:'qq_mail',version:'0.2.0',snapshot(){},diagnostics(){return {list:{stage:'qq_lock'}};},async listPage(){throw Object.assign(new Error('private response'),{code:'email_network_list_unqualified'});}};
  const context=vm.createContext({window:{SparkClawMailReader:staged},Date,setTimeout});
  const tab={runReadCode:async code=>vm.runInContext('('+code+')',context)({evaluate:(fn,args)=>fn(args)})};
  await assert.rejects(networkListPage(tab,'qq_mail',options,null),error=>error.code==='email_network_list_unqualified'&&error.diagnosticStage==='qq_lock'&&!error.message.includes('private'));
});
