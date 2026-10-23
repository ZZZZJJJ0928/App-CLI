import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {networkListPage} from '../../applications/mail/lib/network-reader.mjs';
import {mailHandlers} from '../../applications/mail/handlers.mjs';
import {ProviderScriptRegistry} from '../../applications/mail/runtime/provider-scripts.mjs';

const options={account_address:'owner@example.test',provider_mode:'time_range',lane:'recent_inbound',interval_start:'2026-10-22T00:00:00Z',interval_end:'2026-10-23T00:00:00Z',limit:50};
function fixture(provider, failure, phase='list') {
  let calls=0,lists=0,arms=0;const envelopes=[];
  const reader={provider,version:'0.2.0',snapshot(){},diagnostics(){return {list:{stage:'qq_request'}};},
    async listPage(){
      lists++;
      if(phase!=='list'&&lists===1)throw Object.assign(new Error(),{code:'email_network_template_unlearned'});
      throw failure;
    },
    armRangeSearch(){arms++;if(phase==='arm')throw failure;return {query:'fixture'};},
  };
  const context=vm.createContext({window:{SparkClawMailReader:reader},Date,setTimeout});
  const page={evaluate:async(fn,args)=>{const value=JSON.parse(JSON.stringify(await fn(args)));envelopes.push(value);return value;},locator:()=>({fill:async()=>{},press:async()=>{}})};
  const tab={runReadCode:async code=>{calls++;return vm.runInContext('('+code+')',context)(page);}};
  return {tab,envelopes,stats:()=>({calls,lists,arms})};
}

for(const provider of ['qq_mail','outlook','gmail'])for(const name of ['TimeoutError','AbortError']) {
  test(`${provider}: numeric ${name} becomes a fixed read failure without retry`,async()=>{
    const failure=new DOMException('private request URL',name),f=fixture(provider,failure);
    assert.equal(typeof failure.code,'number');
    await assert.rejects(networkListPage(f.tab,provider,options,null),error=>{
      assert.equal(error.code,'email_network_read_failed');assert.equal(error.name,name);
      assert.equal(error.message,'email_network_read_failed');
      if(provider!=='outlook')assert.equal(error.diagnosticStage,'qq_request');
      return true;
    });
    assert.deepEqual(f.stats(),{calls:1,lists:1,arms:0});
    assert.doesNotMatch(JSON.stringify(f.envelopes),/private request URL/);
  });
}

test('page failures preserve existing reader codes, including identity and Outlook relearning',async()=>{
  for(const code of ['invalid_request','email_account_identity_mismatch','email_account_identity_unavailable',
    'email_capture_limit','email_incremental_unqualified','email_login_required','email_message_identity_invalid',
    'email_network_capability_unavailable','email_network_list_unqualified','email_network_mark_read_unqualified',
    'email_network_original_unqualified','email_network_read_failed','email_network_target_unobserved',
    'email_network_template_stale','email_network_template_unlearned']) {
    const f=fixture('qq_mail',Object.assign(new Error('private response'),{code}));
    await assert.rejects(networkListPage(f.tab,'qq_mail',options,null),{code,name:'Error'});
    assert.equal(f.stats().lists,1);
  }
});

test('unknown page codes and names cannot enter returned errors or diagnostic envelopes',async()=>{
  for(const code of [23,20,0,'PRIVATE_MAILBOX_CODE','email_network_private_text',null]) {
    const f=fixture('qq_mail',Object.assign(new Error('private response'),{code,name:'PRIVATE_NAME'}));
    await assert.rejects(networkListPage(f.tab,'qq_mail',options,null),{code:'email_network_read_failed',name:'Error',message:'email_network_read_failed'});
    assert.deepEqual(f.envelopes,[{error:'email_network_read_failed',exception_name:'Error',diagnostic_stage:'qq_request'}]);
  }
  const tab={runReadCode:async()=>({error:'PRIVATE_MAILBOX_CODE',exception_name:'PRIVATE_NAME',diagnostic_stage:'PRIVATE_STAGE'})};
  await assert.rejects(networkListPage(tab,'qq_mail',options,null),error=>error.code==='email_network_read_failed'&&error.name==='Error'&&error.diagnosticStage===undefined&&!error.message.includes('PRIVATE'));
});

for(const phase of ['arm','replayed'])test(`Outlook ${phase} failure uses the same fixed boundary`,async()=>{
  const f=fixture('outlook',new DOMException('private request URL','TimeoutError'),phase);
  await assert.rejects(networkListPage(f.tab,'outlook',options,null),{code:'email_network_read_failed',name:'TimeoutError'});
  assert.deepEqual(f.stats(),{calls:1,lists:phase==='arm'?1:2,arms:1});
  assert.doesNotMatch(JSON.stringify(f.envelopes),/private request URL/);
});

test('existing collect handler logs timeout and cancellation safely with the fixed public reason',async t=>{
  const lines=[];let current,effects=0;
  t.mock.method(process.stderr,'write',line=>{lines.push(JSON.parse(String(line)));return true;});
  t.mock.method(ProviderScriptRegistry.prototype,'prepare',async function(){
    this.entries=new Map([['fixture',{provider:'qq_mail',operation:'collect_page',validate(){},
      handler:()=>networkListPage(current.tab,'qq_mail',options,null)}]]);
  });
  const handlers=await mailHandlers();
  for(const name of ['TimeoutError','AbortError']) {
    current=fixture('qq_mail',new DOMException('private request URL',name));
    await assert.rejects(handlers['qq_mail.collect_page'].run({}, {resource:{},beforeEffect(){effects++;},browser:{reused:true,async call(){}}}),{code:'EMAIL_NETWORK_READ_FAILED'});
    const event=lines.at(-1);
    assert.equal(event.phase,'handler');assert.equal(event.exception_name,name);assert.equal(event.exception_code,'email_network_read_failed');
    assert.equal(event.host_method,undefined);assert.equal(current.stats().lists,1);
  }
  assert.equal(effects,2);assert.equal(lines.length,2);
  assert.doesNotMatch(JSON.stringify(lines),/private request URL|owner@example/);
});
