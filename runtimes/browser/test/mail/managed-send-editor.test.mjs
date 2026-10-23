import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {managedSendDOM} from '../../applications/mail/lib/managed-send-dom.mjs';
import {prepareManagedDraft} from '../../applications/mail/lib/managed-send.mjs';

function environment({state={provider:'qq_mail',mode:'compose'},count=1,hidden=false,root=false}={}){
 let marks=0;
 const document={body:{},querySelectorAll:()=>bodies};
 const composer={isConnected:true,__reactFiber$fixture:{return:{memoizedProps:{value:{isResumeMail:false,isEdited:false}}}},parentElement:document.body};
 const bodies=Array.from({length:count},()=>({isConnected:true,getBoundingClientRect:()=>({width:hidden?0:100,height:hidden?0:30}),closest:()=>root?composer:null,parentElement:document.body,setAttribute:()=>marks++}));
 return {context:{document,__sparkclawManagedMail:state,getComputedStyle:()=>({visibility:'visible'})},marks:()=>marks};
}
test('editor diagnostics distinguish failed guards without marking or editing a control',()=>{
 for(const [check,options,expected] of [
  ['state_missing',{state:null},{state_present:false,provider_matches:false,body_candidates:1,body_count:1,ownership_checked:false}],
  ['provider_mismatch',{state:{provider:'gmail'}},{state_present:true,provider_matches:false,body_candidates:1,body_count:1,ownership_checked:false}],
  ['body_count',{hidden:true},{state_present:true,provider_matches:true,body_candidates:1,body_count:0,ownership_checked:false}],
  ['body_count',{count:2},{state_present:true,provider_matches:true,body_candidates:2,body_count:2,ownership_checked:false}],
  ['root_missing',{provider:'gmail',state:{provider:'gmail',mode:'compose'}}, {state_present:true,provider_matches:true,body_candidates:1,body_count:1,ownership_checked:false}],
  ['target_unlinked',{root:true,state:{provider:'qq_mail',mode:'reply',target:'requested-message'}},{state_present:true,provider_matches:true,body_candidates:1,body_count:1,ownership_checked:true}],
 ]){
  const f=environment(options);
  const value=JSON.parse(JSON.stringify(vm.runInNewContext(`(${managedSendDOM.toString()})(${JSON.stringify(options.provider??'qq_mail')},'editor',{})`,f.context)));
  assert.deepEqual(value,{error:'email_reply_editor_unverified',check,diagnostic:expected});
  assert.equal(f.marks(),0);
 }
 const f=environment({count:1001});
 const value=vm.runInNewContext(`(${managedSendDOM.toString()})('qq_mail','editor',{})`,f.context);
 assert.equal(value.diagnostic.body_count,1000);assert.equal(value.diagnostic.body_candidates,1000);
});

test('editor retries retain their existing bound and log only allowed structural facts',async t=>{
 const writes=[];t.mock.method(process.stderr,'write',chunk=>{writes.push(String(chunk));return true;});
 const account='owner@example.invalid',url='https://wx.mail.qq.com/home/index';
 const request={mode:'compose',account_address:account,message:{to:['recipient@example.invalid'],cc:[],subject:'Private subject',body:{format:'text',content:'Private body'}}};
 let waits=0,editors=0,fills=0;
 const tab={inspect:async code=>{
  if(code.includes('function providerAccountDOM('))return {origin:url,result:{url,account_hash:crypto.createHash('sha256').update(account).digest('hex')}};
  if(code.includes('return {waited:true}')){waits++;return {result:{waited:true}};}
  if(code.includes(')("qq_mail","open",'))return {result:{opened:true}};
  if(code.includes(')("qq_mail","editor",')){editors++;return {result:{error:'email_reply_editor_unverified',check:'body_count',diagnostic:{state_present:true,provider_matches:true,ownership_checked:false,body_candidates:1,body_count:0,body:'Private body',account,selector:'Private selector',attempt:5000}}};}
  throw Error('Unexpected fixture phase');
 },fill:async()=>{fills++}};
 await assert.rejects(prepareManagedDraft(tab,'qq_mail',request),{code:'email_reply_editor_unverified'});
 assert.equal(editors,8);assert.equal(waits,7);assert.equal(fills,0);assert.equal(writes.length,8);
 for(const [i,line]of writes.entries())assert.deepEqual(JSON.parse(line),{event:'mail_editor_validation_failed',provider:'qq_mail',phase:'editor',check:'body_count',state_present:true,provider_matches:true,ownership_checked:false,body_candidates:1,body_count:0,attempt:i+1});
 assert.doesNotMatch(writes.join(''),/Private|example\.invalid|selector/);

 // A provider page cannot smuggle arbitrary text or unbounded counts through
 // the diagnostic envelope, or forge the attempt number from page data.
 writes.length=0;
 const inspect=tab.inspect;
 tab.inspect=async code=>code.includes(')("qq_mail","editor",')?{result:{error:'email_reply_editor_unverified',check:'Private body owner@example.invalid',diagnostic:{state_present:'Private body',provider_matches:1,ownership_checked:null,body_candidates:1001,body_count:-1,attempt:1}}}:inspect(code);
 await assert.rejects(prepareManagedDraft(tab,'qq_mail',request),{code:'email_reply_editor_unverified'});
 assert.equal(writes.length,8);
 for(const [i,line]of writes.entries())assert.deepEqual(JSON.parse(line),{event:'mail_editor_validation_failed',provider:'qq_mail',phase:'editor',check:'unavailable',attempt:i+1});
});
