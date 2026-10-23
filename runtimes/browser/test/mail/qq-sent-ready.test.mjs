import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {sendManagedMail,validateManagedSend} from '../../applications/mail/lib/managed-send.mjs';
import {openSendJournal} from '../../applications/mail/lib/send-journal.mjs';
import {QQMAIL_SENT_FOLDER_SELECTOR,QQMAIL_SENT_READY_CODE,QQMAIL_SENT_BASELINE_EXPRESSION} from '../../applications/mail/lib/qqmail-send-proof.mjs';

const wait=vm.runInNewContext(`(${QQMAIL_SENT_READY_CODE})`);
const input=()=>({schema_version:1,operation:'send',provider:'qq_mail',account:'default',account_address:'owner@example.test',invocation_id:'sent-ready',mode:'compose',message:{to:['recipient@example.test'],cc:['copy@example.test'],subject:'Synthetic',body:{format:'text',content:'Fixture'}}});
async function fixture(t,{ready=true,account='owner@example.test',origin='https://wx.mail.qq.com/home/index',error}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qq-sent-ready-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const calls=[],sentinel=Object.assign(Error('Stop before editor'),{code:'fixture_stop_before_draft'});
 const tab={runReadCode:async code=>{if(code!==QQMAIL_SENT_READY_CODE){calls.push('navigate');return;}calls.push('wait');if(error)throw error;return typeof ready==='function'?ready():ready;},
  click:async selector=>{assert.equal(selector,QQMAIL_SENT_FOLDER_SELECTOR);calls.push('click');},
  inspect:async code=>{if(code===QQMAIL_SENT_BASELINE_EXPRESSION){calls.push('baseline');throw sentinel;}calls.push('account');return {origin,result:{url:origin,account_hash:crypto.createHash('sha256').update(account).digest('hex')}};}};
 const runtime={emailWorkspaceRoot:dir,prepareSendPage:async()=>calls.push('prepare'),withSendTab:fn=>fn(tab),reserveDispatch:()=>assert.fail('dispatch forbidden'),releaseDispatch:()=>assert.fail('dispatch forbidden')};
 return {calls,run:()=>sendManagedMail(input(),'qq_mail',runtime),journal:()=>openSendJournal(dir,validateManagedSend(input(),'qq_mail'))};
}
test('wait uses the existing strict selector and a bounded visible state',async()=>{
 let target;
 const page={locator:selector=>{assert.equal(selector,QQMAIL_SENT_FOLDER_SELECTOR);return target={waitFor:async options=>assert.deepEqual(JSON.parse(JSON.stringify(options)),{state:'visible',timeout:5000}),count:async()=>1,isVisible:async()=>true};}};
 assert.equal(await wait(page),true);assert.ok(target);
});
test('a target that becomes hidden or ambiguous after wait is rejected',async()=>{
 for(const [count,visible]of [[0,false],[1,false],[2,true]])assert.equal(await wait({locator:()=>({waitFor:async()=>{},count:async()=>count,isVisible:async()=>visible})}),false);
});
test('delayed readiness stays on the prepared tab then clicks exactly once',async t=>{
 let resolve;const ready=new Promise(r=>resolve=r);const f=await fixture(t,{ready:()=>ready});
 const pending=assert.rejects(f.run(),{code:'fixture_stop_before_draft'});
 for(let i=0;i<100&&!f.calls.includes('wait');i++)await new Promise(r=>setTimeout(r,1));
 assert.deepEqual(f.calls,['navigate','prepare','account','wait']);
 resolve(true);await pending;assert.deepEqual(f.calls,['navigate','prepare','account','wait','click','baseline']);
 assert.equal((await f.journal()).saved,null,'no dispatch journal was claimed');
});
test('permanent absence, duplicate or hidden final state never clicks or dispatches',async t=>{
 for(const ready of [false,null,undefined,{ready:true}]){const f=await fixture(t,{ready:()=>ready});await assert.rejects(f.run(),{code:'email_send_precondition_failed'});assert.ok(!f.calls.includes('click'));assert.equal((await f.journal()).saved,null,'no dispatch journal was claimed');}
});
test('wrong provider origin or account is rejected before waiting or clicking',async t=>{
 for(const options of [{account:'other@example.test'},{origin:'https://example.invalid/'}]){const f=await fixture(t,options);await assert.rejects(f.run(),{code:options.origin?'email_provider_origin_invalid':'email_account_identity_mismatch'});assert.ok(!f.calls.includes('wait'));assert.ok(!f.calls.includes('click'));}
});
for(const code of ['browser_script_timeout','browser_page_stale','browser_cleanup_pending','host_lease_expired'])test(`${code} propagates without another wait, click or dispatch`,async t=>{
 const error=Object.assign(Error('Synthetic host rejection'),{code}),f=await fixture(t,{error});
 await assert.rejects(f.run(),value=>value===error);assert.equal(f.calls.filter(x=>x==='wait').length,1);assert.ok(!f.calls.includes('click'));
 assert.equal((await f.journal()).saved,null,'no dispatch journal was claimed');
});
