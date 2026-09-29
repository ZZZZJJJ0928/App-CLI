import {OUTLOOK_SENT_BASELINE_EXPRESSION,OUTLOOK_SEND_VERIFICATION_EXPRESSION} from '../../applications/mail/lib/outlook-send-proof.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import vm from 'node:vm';
import {QQMAIL_SENT_BASELINE_EXPRESSION,QQMAIL_SENT_VERIFICATION_EXPRESSION} from '../../applications/mail/lib/qqmail-send-proof.mjs';
import {managedSendDOM} from '../../applications/mail/lib/managed-send-dom.mjs';
import test from 'node:test';
import {openSendJournal} from '../../applications/mail/lib/send-journal.mjs';
import {validateManagedSend,sendManagedMail} from '../../applications/mail/lib/managed-send.mjs';
const raw=()=>({schema_version:1,operation:'send',provider:'gmail',account:'default',account_address:'Owner@example.invalid',invocation_id:'fixture-send',mode:'compose',message:{to:['recipient@example.invalid'],cc:['copy@example.invalid'],subject:'Fixture',body:{format:'text',content:'Synthetic fixture'}}});
const request=()=>validateManagedSend(raw(),'gmail');
async function root(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'managed-send-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('managed contract normalizes optional cc and enforces combined limits, body bytes and reply proof',()=>{
 const v=raw();delete v.message.cc;assert.deepEqual(validateManagedSend(v,'gmail').message.cc,[]);
 v.message.to=Array.from({length:100},(_,i)=>`a${i}@example.invalid`);v.message.cc=['extra@example.invalid'];assert.throws(()=>validateManagedSend(v,'gmail'),{code:'email_send_invalid_input'});
 const b=raw();b.message.body.content='a'.repeat(204800);validateManagedSend(b,'gmail');b.message.body.content+='a';assert.throws(()=>validateManagedSend(b,'gmail'));
 const r=raw();r.mode='reply';assert.throws(()=>validateManagedSend(r,'gmail'));
});
test('durable journal survives lost response and reconciliation never opens a tab or sends',async t=>{
 const dir=await root(t);const r=request();const j=await openSendJournal(dir,r);assert.equal(await j.write('dispatching'),true);
 let tabs=0;const runtime={emailWorkspaceRoot:dir,withSendTab:()=>{tabs++;throw Error('must not open');}};
 assert.equal((await sendManagedMail(raw(),'gmail',runtime)).status,'unknown');
 assert.equal((await sendManagedMail({...raw(),mode:'reconcile'},'gmail',runtime)).status,'unknown');assert.equal(tabs,0);
 const receipt={schema_version:1,status:'sent',provider:'gmail',recipient_digest:r.recipientDigest};await j.write('sent',receipt);
 assert.deepEqual(await sendManagedMail({...raw(),mode:'reconcile'},'gmail',runtime),receipt);assert.equal(tabs,0);
 const changed=raw();changed.message.body.content+='Changed';await assert.rejects(sendManagedMail(changed,'gmail',runtime),{code:'email_send_journal_conflict'});
});
test('same invocation cannot be changed from reply into reply-all',async t=>{
 const dir=await root(t);const r={...request(),mode:'reply',reply_target:{provider_message_id:'a'}};
 const j=await openSendJournal(dir,r);await j.write('dispatching');
 await assert.rejects(openSendJournal(dir,{...r,mode:'reply_all'}),{code:'email_send_journal_conflict'});
 assert.equal((await openSendJournal(dir,{...r,mode:'reconcile'})).saved.mode,'reply');
});
test('parallel processes get exactly one durable dispatch claim',async t=>{
 const dir=await root(t);const moduleURL=new URL('../../applications/mail/lib/send-journal.mjs',import.meta.url).href;
 const source=`import {openSendJournal} from ${JSON.stringify(moduleURL)};const j=await openSendJournal(${JSON.stringify(dir)},${JSON.stringify(request())});process.stdout.write(String(await j.write('dispatching')));`;
 const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',source]);let out='';p.stdout.on('data',v=>out+=v);p.on('error',reject);p.on('exit',code=>code?reject(Error('child failed')):resolve(out));});
 const outcomes=await Promise.all(Array.from({length:8},run));assert.equal(outcomes.filter(v=>v==='true').length,1);assert.equal(outcomes.filter(v=>v==='false').length,7);
});
test('account mismatch fails before creating draft or invoking Send',async t=>{
 const dir=await root(t);let clicks=0;const runtime={emailWorkspaceRoot:dir,withSendTab:fn=>fn({runReadCode:async()=>{},inspect:async()=>({origin:'https://mail.google.com/mail/u/0/',result:{url:'https://mail.google.com/mail/u/0/',account_address:'other@example.invalid'}}),click:async()=>{clicks++;}})};
 await assert.rejects(sendManagedMail(raw(),'gmail',runtime),{code:'email_account_identity_mismatch'});assert.equal(clicks,0);
});

async function sendingFixture(t,{lost=false,wrongReadback=false,provider='gmail',sentEvidence=true,baseline={ids:[]}}={}){
 const dir=await root(t);const r={...raw(),provider};if(provider==='outlook')r.message.cc=[];let sends=0,tabs=0,discards=0;
 const url=provider==='qq_mail'?'https://wx.mail.qq.com/home/index':provider==='outlook'?'https://outlook.live.com/mail/0/sentitems':'https://mail.google.com/mail/u/0/';
 const actual={to:[],cc:[],subject:r.message.subject,body:''};
 const tab={runReadCode:async()=>{},waitFor:async()=>{},focus:async()=>{},press:async()=>{},fill:async(selector,value)=>{
  const field=/data-sc-mail-control="(\w+)"/u.exec(selector)[1];
  if(['to','cc'].includes(field))actual[field].push(value);else actual[field]=value;
 },click:async selector=>{if(selector==='[data-sc-managed-send="true"]'){sends++;if(lost)throw Error('response lost');}},inspect:async code=>{
  if(code.includes('return {waited:true}')||code.includes('return {marked:true}'))return {result:{ok:true}};
  if(code===QQMAIL_SENT_BASELINE_EXPRESSION||code===OUTLOOK_SENT_BASELINE_EXPRESSION)return {result:baseline};
  if(code.includes(QQMAIL_SENT_VERIFICATION_EXPRESSION)||code.includes(OUTLOOK_SEND_VERIFICATION_EXPRESSION))return {result:{sent_evidence:sentEvidence}};
  if(code.includes('function sentDOM('))return {result:{confirmed:true,ids:['unrelated-arrival']}};
  const phase=[...code.matchAll(/\)\("(?:gmail|qq_mail|outlook)","(\w+)",/gu)].at(-1)?.[1];
  if(phase==='discard'){discards++;return {result:{discard_started:true}};}
  if(phase==='discard_confirm')return {result:{confirmed:false}};
  if(phase==='discard_status')return {result:{discarded:true}};
  if(code.includes('function providerAccountDOM('))return {origin:url,result:{url,account_hash:crypto.createHash('sha256').update(r.account_address.toLowerCase()).digest('hex')}};
  if(phase==='open')return {result:{opened:true}};
  if(phase==='editor')return {result:{ready:true,has_subject:true,has_cc:true}};
  if(phase==='readback'){const hash=v=>crypto.createHash('sha256').update(v).digest('hex');const to=wrongReadback&&actual.to.length?['wrong@example.invalid']:actual.to;return {result:{to_count:to.length,cc_count:actual.cc.length,to_hash:hash(JSON.stringify([...to].sort())),cc_hash:hash(JSON.stringify([...actual.cc].sort())),subject_hash:hash(actual.subject),body_hash:hash(actual.body),send_ready:true,linked:true}};}
  throw Error(`unexpected fixture phase ${phase}`);
 }};
 const runtime={emailWorkspaceRoot:dir,withSendTab:fn=>{tabs++;return fn(tab)}};
 return {run:()=>sendManagedMail(r,provider,runtime),counts:()=>({sends,tabs}),discards:()=>discards};
}
test('lost Send response persists dispatch and restart never invokes a second Send',async t=>{
 const f=await sendingFixture(t,{lost:true});await assert.rejects(f.run(),{code:'send_outcome_unknown'});
 assert.deepEqual(f.counts(),{sends:1,tabs:1});assert.equal(f.discards(),0);assert.equal((await f.run()).status,'unknown');assert.deepEqual(f.counts(),{sends:1,tabs:1});
});
test('verified native result persists receipt without claiming unrelated new message IDs',async t=>{
 const f=await sendingFixture(t);const sent=await f.run();assert.equal(sent.status,'sent');assert.equal(sent.provider_message_id,undefined);
 assert.deepEqual(await f.run(),sent);assert.deepEqual(f.counts(),{sends:1,tabs:1});
});
test('recipient readback mismatch never reaches dispatch',async t=>{
 const f=await sendingFixture(t,{wrongReadback:true});await assert.rejects(f.run(),{code:'email_draft_fields_unverified'});assert.equal(f.counts().sends,0);assert.equal(f.discards(),1);
});


test('native cleanup refuses preexisting or uncertain-send editors',()=>{
 const root={isConnected:true,getBoundingClientRect:()=>({width:100,height:100})};
 const evaluate=state=>vm.runInNewContext(`(${managedSendDOM.toString()})('gmail','discard',{})`,{document:{querySelectorAll:()=>[]},__sparkclawManagedMail:state,getComputedStyle:()=>({visibility:'visible'})});
 assert.equal(evaluate({root,ownershipChecked:false}).discarded,false);
 assert.equal(evaluate({root,ownershipChecked:true,sendAttempted:true}).discarded,false);
});

test('native draft proof rejects resumed Gmail/QQ drafts and mismatched reply markers before editing',()=>{
 for(const scenario of ['gmail-saved','gmail-wrong-reply','qq-resumed']){
  let mutations=0;
  const box={isConnected:true,getBoundingClientRect:()=>({width:20,height:20}),querySelector:s=>s.includes('draft')?{value:'saved-id'}:null,querySelectorAll:s=>s.includes('[name="rm"]')?[{value:'wrong-source'}]:[]};
  const body={isConnected:true,getBoundingClientRect:()=>({width:20,height:20}),closest:s=>s==='.M9'||s==='.mail-compose-page'?box:null,setAttribute:()=>{mutations++}};
  if(scenario==='qq-resumed')box.__reactFiber$fixture={return:{memoizedProps:{value:{isResumeMail:true,isEdited:false}}}};
  const provider=scenario.startsWith('qq')?'qq_mail':'gmail';
  const state={provider,mode:scenario==='gmail-wrong-reply'?'reply':'compose',priorDrafts:scenario==='gmail-saved'?['saved-id']:[],sourceNativeId:'correct-source'};
  const result=vm.runInNewContext(`(${managedSendDOM.toString()})('${provider}','editor',{})`,{document:{querySelectorAll:s=>s.includes('contenteditable')?[body]:[]},__sparkclawManagedMail:state,getComputedStyle:()=>({visibility:'visible'})});
  assert.equal(result.error,scenario==='gmail-wrong-reply'?'email_reply_editor_unverified':'email_existing_draft',scenario);assert.equal(mutations,0,scenario);
 }
});

test('Bcc toggles are not recipients while populated native Bcc editors block sending',()=>{
 const element=extra=>({isConnected:true,getBoundingClientRect:()=>({width:20,height:20}),getAttribute:()=>null,...extra});
 const toggle=element({innerText:'Bcc',matches:()=>false});
 const bcc=element({value:'hidden@example.test',matches:()=>true});
 let controls=[toggle];
 const body=element({innerText:'body'}),send=element({});
 const root=element({querySelector:s=>s.includes('subject')?{value:'subject'}:null,querySelectorAll:s=>s.includes('bcc')?controls:[]});
 const evaluate=()=>vm.runInNewContext(`(${managedSendDOM.toString()})('outlook','readback',{})`,{document:{querySelectorAll:()=>[]},__sparkclawManagedMail:{root,body,send,mode:'compose'},getComputedStyle:()=>({visibility:'visible'})});
 assert.equal(evaluate().send_ready,true);
 controls=[toggle,bcc];assert.equal(evaluate().error,'email_recipient_verification_failed');assert.equal(evaluate().check,'unexpected_bcc');
});

test('recipient proof reads an address-bearing label and rejects contradictory chip addresses',()=>{
 let title='Display name';
 const node=extra=>({isConnected:true,getBoundingClientRect:()=>({width:20,height:20}),getAttribute:()=>null,...extra});
 const chip=node({querySelectorAll:()=>[],getAttribute:k=>k==='title'?title:k==='aria-label'?'Display name <recipient@example.test>':null,textContent:'Display name'});
 const input=node({value:'',querySelectorAll:()=>[chip],cloneNode:()=>({querySelectorAll:()=>[{remove(){}}]})});
 const root=node({querySelector:s=>s==='[data-sc-mail-control="to"]'?input:s.includes('subject')?{value:'subject'}:null,querySelectorAll:()=>[]});
 const evaluate=()=>vm.runInNewContext(`(${managedSendDOM.toString()})('outlook','readback',{})`,{document:{querySelectorAll:()=>[]},__sparkclawManagedMail:{root,body:node({innerText:'body'}),send:node({}),mode:'compose'},getComputedStyle:()=>({visibility:'visible'})});
 assert.deepEqual([...evaluate().to],['recipient@example.test']);
 title='different@example.test';assert.equal(evaluate().check,'unparsed_recipient');
});

test('QQ keeps a unique aria-labelled recipient input when wrapper labels are absent',()=>{
 const node=extra=>({isConnected:true,getBoundingClientRect:()=>({width:20,height:20}),getAttribute:()=>null,setAttribute(){},...extra});
 const to=node({}),subject=node({value:''}),send=node({innerText:'Send'});
 const root=node({__reactFiber$fixture:{return:{memoizedProps:{value:{isResumeMail:false,isEdited:false}}}},querySelectorAll:s=>s.includes('subjectbox')?[subject]:s.startsWith('[name="to"]')?[to]:s.startsWith('.mail-compose-header')?[send]:[]});
 const body=node({closest:()=>root});
 const value=vm.runInNewContext(`(${managedSendDOM.toString()})('qq_mail','editor',{})`,{document:{querySelectorAll:()=>[body]},__sparkclawManagedMail:{provider:'qq_mail',mode:'compose'},getComputedStyle:()=>({visibility:'visible'})});
 assert.equal(value.ready,true);
});


test('QQ and Outlook managed sends require native Sent-folder evidence and never resend',async t=>{
 for(const provider of ['qq_mail','outlook']){
 const success=await sendingFixture(t,{provider});
 assert.equal((await success.run()).status,'sent');assert.equal((await success.run()).status,'sent');assert.deepEqual(success.counts(),{sends:1,tabs:1});
 const absent=await sendingFixture(t,{provider,sentEvidence:false});
 await assert.rejects(absent.run(),{code:'send_outcome_unknown'});assert.equal((await absent.run()).status,'unknown');assert.deepEqual(absent.counts(),{sends:1,tabs:1});
 const unproved=await sendingFixture(t,{provider,baseline:null});
 await assert.rejects(unproved.run(),{code:'email_send_precondition_failed'});assert.equal(unproved.counts().sends,0);
 }
});

test('Outlook nickname pills use only their own committed editor model and reject conflicts',()=>{
 const node=extra=>({isConnected:true,getBoundingClientRect:()=>({width:20,height:20}),getAttribute:()=>null,...extra});
 let label='Friendly name';
 const chip=node({querySelectorAll:()=>[],getAttribute:k=>k==='aria-label'?label:null,textContent:'Friendly name'});
 const model={recipients:[{emailAddress:{Address:'recipient@example.test',RoutingType:'SMTP'},isResolved:true}],recipientEditorViewState:{},ariaLabel:'To'};
 const input=node({value:'',getAttribute:k=>k==='aria-label'?'To':null,__reactFiber$fixture:{return:{memoizedProps:model}},querySelectorAll:()=>[chip],cloneNode:()=>({querySelectorAll:()=>[{remove(){}}]})});
 const root=node({querySelector:s=>s==='[data-sc-mail-control="to"]'?input:s.includes('subject')?{value:'subject'}:null,querySelectorAll:()=>[]});
 const evaluate=()=>vm.runInNewContext(`(${managedSendDOM.toString()})('outlook','readback',{})`,{document:{querySelectorAll:()=>[]},__sparkclawManagedMail:{root,body:node({innerText:'body'}),send:node({}),mode:'compose'},getComputedStyle:()=>({visibility:'visible'})});
 assert.deepEqual([...evaluate().to],['recipient@example.test']);
 model.recipients={0:model.recipients[0],length:1,[Symbol.toStringTag]:'Array'};
 assert.equal(Array.isArray(model.recipients),false);
 assert.deepEqual([...evaluate().to],['recipient@example.test']);
 model.ariaLabel='Cc';assert.equal(evaluate().check,'unparsed_recipient');model.ariaLabel='To';
 label='other@example.test';assert.equal(evaluate().check,'unparsed_recipient');label='Friendly name';
 model.recipients[0].isResolved=false;assert.equal(evaluate().check,'unparsed_recipient');
});


test('Outlook Sent-folder proof accepts the preverified display label but requires a new matching row',async()=>{
 const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
 const first={id:'new',isConnected:true,getBoundingClientRect:()=>({width:20,height:20}),querySelectorAll:()=>[{children:[],textContent:'Known nickname'},{children:[],textContent:'Unique subject'}]};
 const location={pathname:'/mail/0/sentitems',href:'https://outlook.live.com/mail/0/sentitems'};
 const inspect=async expected=>{let tick=0;return vm.runInNewContext(`${OUTLOOK_SEND_VERIFICATION_EXPRESSION}(${JSON.stringify(expected)})`,{document:{querySelectorAll:selector=>selector==='[role="option"][data-convid]'?[first,{id:'old'}]:[]},window:{location,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})},crypto:crypto.webcrypto,TextEncoder,Uint8Array,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),Date:{now:()=>tick+=6000}})};
 const expected={ids:['old'],recipient_hashes:[hash('recipient@example.test'),hash('known nickname')],subject:hash('Unique subject')};
 assert.equal((await inspect(expected)).sent_evidence,true);
 assert.equal((await inspect({...expected,ids:['new']})).sent_evidence,false);
 assert.equal((await inspect({...expected,subject:hash('Other subject')})).sent_evidence,false);
 assert.equal((await inspect({...expected,recipient_hashes:[hash('Other person')]})).sent_evidence,false);
});
