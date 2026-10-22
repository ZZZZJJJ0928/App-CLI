import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installReader} from '../../applications/mail/userscripts/lib/reader-core.mjs';
import {installQQSendPrototype} from '../../applications/mail/userscripts/lib/qq-send-prototype.mjs';
import {sendManagedMail,prepareNativeSend,validateManagedSend} from '../../applications/mail/lib/managed-send.mjs';
import {openSendJournal} from '../../applications/mail/lib/send-journal.mjs';

const owner='owner@example.test';
const initial={account_address:owner,to:['old@example.test'],subject:'Old subject',provider_message_id:'old-sent-id'};
const message={account_address:owner,to:['new@example.test'],cc:[],subject:'New subject',text:'Text <&>\nSecond line'};
function form(overrides={}) {
  return new URLSearchParams({calendar:'',content:'private-original-content',from:owner,func:'1',is_resume:'false',is_text:'false',is_urgent:'false',language:'en',mailid:'private-draft',need_receipt:'false',r:'0.123',save_to_send:'true',separated_copy:'false',sid:'private-session',subject:initial.subject,time_zone:'8',time_zone_dst:'0',to:'"Old"<old@example.test>;',...overrides}).toString();
}
function fixture(t) {
  const f={calls:[],reads:[],now:0};
  class XHR {
    open(){} setRequestHeader(){} send(){}
    addEventListener(name,fn){if(name==='load')this.loaded=fn;}
  }
  // Poll delays (<= 1 s) advance the page clock instantly; longer timers
  // (learning windows, dispatch budget) stay real and are cleared by the code.
  const pageTimeout=(fn,ms,...args)=>{if(ms>0&&ms<=1000){f.now+=ms;return setTimeout(fn,0,...args);}return setTimeout(fn,ms,...args);};
  const context=vm.createContext({URL,URLSearchParams,Headers,Map,Date,JSON,Object,Number,Error,TextDecoder,TextEncoder,Uint8Array,Response,Blob,AbortSignal,AbortController,setTimeout:pageTimeout,clearTimeout,structuredClone,
    performance:{now:()=>f.now},XMLHttpRequest:XHR,location:{origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index'},
    document:{addEventListener(){},removeEventListener(){}},account:owner,
    fetch:async(url,options)=>{
      const list=new URL(url).pathname==='/list/maillist';
      if(list)f.reads.push({url,options,at:f.now});else{f.calls.push({url,options,at:f.now});f.sentAt=f.now;}
      if(!list&&f.throw||list&&(f.readThrow||f.readThrowAfterSend&&f.calls.length))throw new Error('private error');
      const row=(id,mid,to,subject)=>({emailid:id,messageid:mid,dirid:3,subject,senders:{item:[{email:owner}]},receivers:{item:[{email:to}]}});
      // Each accepted send gets its own identifiers; the first keeps the plain names.
      const suffix=index=>index?`-${index}`:'';
      const rows=[row('old-sent-id','old-response-id',initial.to[0],initial.subject)];
      if(!f.missing)f.calls.forEach((call,index)=>{if(f.now-call.at>=(f.sentDelay??0))rows.push({...row('new-sent-id'+suffix(index),'new-response-id'+suffix(index),message.to[0],message.subject),...f.rowChange});});
      if(f.beforeNew&&!f.calls.length)rows.push(row('new-sent-id','new-response-id',message.to[0],message.subject));
      if(f.pauseRead)await f.pauseRead;
      if(f.duplicate)rows.push(rows.at(-1));
      const reply=f.response??JSON.stringify({head:{ret:0},body:{messageid:'new-response-id'+suffix(f.calls.length-1)}});
      const response=new Response(list?JSON.stringify({head:{ret:0},body:{list:rows,total_num:rows.length}}):reply,{status:list?f.readStatus??200:f.status??200});
      Object.defineProperty(response,'url',{value:f.redirect||url});return response;
    }});
  vm.runInContext(`window=globalThis;top=window;(${installReader.toString()})({provider:'qq_mail',origins:[location.origin],account:()=>account,listURL:()=>false,parse:()=>[],installNativeSend:${installQQSendPrototype.toString()}});`,context);
  f.reader=context.SparkClawMailReader;f.context=context;
  f.learn=(body=form(),{capture=true,status=200,url='https://wx.mail.qq.com/send/sendmail',headers={'content-type':'application/x-www-form-urlencoded; charset=UTF-8'}}={})=>{
    f.reader.armLearning({kind:'send',capture_send_template:capture});
    const x=new XHR();x.open('POST',url);for(const [k,v] of Object.entries(headers))x.setRequestHeader(k,v);x.send(body);x.status=status;x.responseText='{"head":{"ret":0},"body":{"messageid":"old-response-id"}}';x.loaded();return x;
  };
  f.confirm=()=>f.reader.confirmSendTemplate(initial);
  // A dispatch needs the ticket of a preflight that read the Sent baseline.
  f.prepare=(value=message)=>f.reader.prepareNativeSend(value);
  f.send=async(value=message)=>{const ticket=await f.prepare(value);assert.equal(ticket.ready,true,ticket.reason);return f.reader.sendNative({...value,token:ticket.token});};
  f.tab={runReadCode:code=>vm.runInContext(`(${code})({evaluate:(fn,arg)=>fn(arg)})`,context)};
  t.after(()=>f.reader.dispose());return f;
}

test('serialized QQ prototype needs explicit arm and independent DOM confirmation; no content is exposed',async t=>{
  const f=fixture(t);
  f.learn(form(),{capture:false});assert.equal(await f.confirm(),false);
  assert.equal(f.reader.sendNativeReady(initial).ready,false);
  f.learn();assert.equal(f.reader.sendNativeReady(initial).ready,false);
  assert.equal(await f.confirm(),true);assert.equal(f.reader.sendNativeReady(initial).ready,true);
  assert.equal(f.calls.length,0);
  assert.ok(!JSON.stringify(f.reader.diagnostics()).includes('private-'));
  const ticket=await f.prepare();assert.equal(ticket.ready,true);assert.equal(f.calls.length,0);
  const result=await f.reader.sendNative({...message,token:ticket.token});
  assert.equal(result.outcome,'sent');assert.equal(result.provider_message_id,'new-sent-id');assert.equal(result.response_message_id,'new-response-id');
  assert.equal(f.reads.length,3,'confirmation, preflight baseline and one Sent poll');
  assert.equal(f.calls.length,1);
  const call=f.calls[0],body=new URLSearchParams(call.options.body);
  assert.equal(new URL(call.url).pathname,'/send/sendmail');
  assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.redirect,'error');
  assert.equal(body.get('to'),'"new@example.test"<new@example.test>;');assert.equal(body.get('mailid'),'');
  assert.equal(body.get('subject'),message.subject);assert.equal(body.get('content'),'<div>Text &lt;&amp;&gt;</div><div>Second line</div>');
  assert.ok(!call.options.body.includes('private-draft'));assert.ok(!call.options.body.includes('private-original-content'));
  assert.ok(!JSON.stringify(result).includes('private-result'));
  // The proven replay renews the template; its ticket is single-use.
  assert.equal(result.template_ready,true);assert.equal(f.reader.sendNativeReady(initial).ready,true);
  await assert.rejects(f.reader.sendNative({...message,token:ticket.token}),{code:'email_network_template_unlearned'});assert.equal(f.calls.length,1);
});

test('dispatch requires a preflight ticket for the same message',async t=>{
  const f=fixture(t);f.learn();await f.confirm();
  await assert.rejects(f.reader.sendNative(message),{code:'email_network_template_unlearned'});
  await assert.rejects(f.reader.sendNative({...message,token:'1:forged'}),{code:'email_network_template_unlearned'});
  const ticket=await f.prepare();
  await assert.rejects(f.reader.sendNative({...message,subject:'Other subject',token:ticket.token}),{code:'invalid_request'});
  const newer=await f.prepare();
  await assert.rejects(f.reader.sendNative({...message,token:ticket.token}),{code:'email_network_template_unlearned'});
  assert.equal(f.calls.length,0);
  assert.equal((await f.reader.sendNative({...message,token:newer.token})).outcome,'sent');assert.equal(f.calls.length,1);
});

for(const [label,body,options] of [
 ['bcc',form({bcc:'hidden@example.test'})],['attachment',form({attach:'old-attachment'})],['reply',form({replyid:'previous'})],
 ['resumed draft',form({is_resume:'true'})],['calendar',form({calendar:'old-calendar'})],['receipt',form({need_receipt:'true'})],
 ['sender',form({from:'other@example.test'})],['recipient shape',form({to:'old@example.test,hidden@example.test'})],
 ['duplicate field',form()+'&to=hidden%40example.test'],['JSON content type',form(),{headers:{'content-type':'application/json'}}],
 ['authorization header',form(),{headers:{'content-type':'application/x-www-form-urlencoded',authorization:'private'}}],
 ['HTTP error',form(),{status:401}],['external origin',form(),{url:'https://other.example.test/send/sendmail'}],
 ['URL draft id',form(),{url:'https://wx.mail.qq.com/send/sendmail?mailid=previous'}],
])test(`QQ prototype refuses ${label} before replay`,async t=>{
 const f=fixture(t);f.learn(body,options);assert.equal(await f.confirm(),false);assert.equal(f.reader.sendNativeReady(initial).ready,false);assert.equal(f.calls.length,0);
});

test('QQ confirmation binds the observed recipient and subject and rejects multiple send requests',async t=>{
 const f=fixture(t);f.learn();assert.equal(await f.reader.confirmSendTemplate({...initial,subject:'different'}),false);
 f.learn();assert.equal(await f.reader.confirmSendTemplate({...initial,to:['different@example.test']}),false);
 const x=f.learn();x.loaded();assert.equal(await f.confirm(),false);assert.equal(f.calls.length,0);
});

test('QQ template lasts 15 minutes, renews only on a proven replay, and expires after idle',async t=>{
 const f=fixture(t);f.learn();await f.confirm();
 f.now+=30001;assert.equal(f.reader.sendNativeReady(initial).ready,true,'outlives the 30 s learning window');
 f.now+=14*60*1000;assert.equal(f.reader.sendNativeReady(initial).ready,true);
 assert.equal((await f.send()).outcome,'sent');
 // Renewed from the proof: another 15 minutes from now.
 f.now+=14*60*1000;assert.equal(f.reader.sendNativeReady(initial).ready,true);
 f.now+=60*1000+1;const expired=f.reader.sendNativeReady(initial);
 assert.equal(expired.ready,false);assert.equal(expired.reason,'template_expired');
 const ticket=await f.prepare();assert.equal(ticket.ready,false);assert.equal(ticket.dispatched,false);assert.equal(ticket.reason,'template_expired');
 assert.equal(f.calls.length,1);
});

test('a template expiring after its preflight still dispatches the prepared send once',async t=>{
 const f=fixture(t);f.learn();await f.confirm();
 f.now+=15*60*1000-1;const ticket=await f.prepare();assert.equal(ticket.ready,true);
 f.now+=2;// the caller's dispatch release took this long
 assert.equal((await f.reader.sendNative({...message,token:ticket.token})).outcome,'sent');assert.equal(f.calls.length,1);
});

test('QQ template invalidates on identity change and never survives disposal',async t=>{
 const f=fixture(t);f.learn();await f.confirm();f.context.account='other@example.test';assert.throws(()=>f.reader.sendNativeReady(initial),{code:'email_account_identity_mismatch'});
 f.context.account=owner;assert.throws(()=>f.reader.sendNativeReady(initial),{code:'email_network_capability_unavailable'});
 await assert.rejects(f.reader.prepareNativeSend(message),{code:'email_network_capability_unavailable'});
 f.reader.dispose();await assert.rejects(f.reader.sendNative(message),{code:'email_network_capability_unavailable'});assert.equal(f.calls.length,0);
});

test('an account change between preflight and dispatch sends nothing',async t=>{
 const f=fixture(t);f.learn();await f.confirm();const ticket=await f.prepare();
 f.context.account='other@example.test';
 await assert.rejects(f.reader.sendNative({...message,token:ticket.token}),{code:'email_account_identity_mismatch'});assert.equal(f.calls.length,0);
});

test('mark-read and other learning windows keep the template and its ticket',async t=>{
 const f=fixture(t);f.learn();await f.confirm();
 f.reader.armLearning({kind:'mark_read',window_ms:10000});
 assert.equal(f.reader.sendNativeReady(initial).ready,true);
 const ticket=await f.prepare();
 f.reader.armLearning({kind:'mark_read',window_ms:10000});
 f.reader.armLearning({kind:'send'});// a non-capturing DOM send window
 assert.equal((await f.reader.sendNative({...message,token:ticket.token})).outcome,'sent');
 f.reader.armLearning({kind:'mark_read',window_ms:10000});
 assert.equal(f.reader.sendNativeReady(initial).ready,true);assert.equal(f.calls.length,1);
});

test('QQ prototype consumes the template before parallel calls and transport failure',async t=>{
 const f=fixture(t);f.learn();await f.confirm();f.throw=true;const ticket=await f.prepare();
 const results=await Promise.allSettled([f.reader.sendNative({...message,token:ticket.token}),f.reader.sendNative({...message,token:ticket.token})]);
 assert.equal(results[0].value.outcome,'unknown');assert.equal(results[1].reason.code,'email_network_template_unlearned');assert.equal(f.calls.length,1);
 assert.equal(f.reader.sendNativeReady(initial).ready,false,'an unproven replay retires the template');
});

test('QQ prototype checks new message limits and never copies stale recipients or draft identity',async t=>{
 const f=fixture(t);f.learn(form({to:'old@example.test'}));await f.confirm();
 for(const change of [{to:['a@example.test','b@example.test']},{cc:['c@example.test']},{subject:'bad\nheader'},{text:'x'.repeat(204801)},{to:['bad,part@example.test']}]){
  const ticket=await f.prepare({...message,...change});assert.equal(ticket.ready,false);assert.equal(ticket.reason,'invalid_request');
 }
 assert.equal(f.calls.length,0);assert.equal(f.reads.length,1,'invalid input never reaches the network');
 await f.send();assert.match(new URLSearchParams(f.calls[0].options.body).get('content'),/Text &lt;&amp;&gt;/);
});

function raw(){return {schema_version:1,operation:'send',provider:'qq_mail',account:'default',account_address:owner,invocation_id:'prototype-test',mode:'compose',message:{to:message.to,cc:[],subject:message.subject,body:{format:'text',content:message.text}}};}
function enable(t){const old=process.env.APP_CLI_MAIL_NATIVE_SEND;process.env.APP_CLI_MAIL_NATIVE_SEND='qq_mail';t.after(()=>{if(old===undefined)delete process.env.APP_CLI_MAIL_NATIVE_SEND;else process.env.APP_CLI_MAIL_NATIVE_SEND=old;});}
function stderr(t){const lines=[];const write=process.stderr.write;t.mock.method(process.stderr,'write',(value,...args)=>{if(typeof value==='string'&&value.startsWith('{"event":"mail_'))lines.push(JSON.parse(value));else return write.call(process.stderr,value,...args);return true;});return lines;}
async function journalDir(t,label){const dir=await fs.mkdtemp(path.join(os.tmpdir(),label));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
// The DOM flow begins by navigating the send page; stop there to observe the fallback.
function domFallbackTab(f){
 const seen={goto:0,dom:0};
 return {seen,tab:{runReadCode:code=>{if(code.includes('page.goto('))seen.goto++;return code.includes('SparkClawMailReader')?f.tab.runReadCode(code):true;},
  click:async()=>{seen.dom++;throw Object.assign(new Error('fixture stops the DOM flow'),{code:'email_send_precondition_failed'});},inspect:async()=>{seen.dom++;return {};}}};
}

test('native path is opt-in and excludes replies, cc, attachments and other providers',async t=>{
 const f=fixture(t),request=validateManagedSend(raw(),'qq_mail');f.learn();await f.confirm();
 const old=process.env.APP_CLI_MAIL_NATIVE_SEND;delete process.env.APP_CLI_MAIL_NATIVE_SEND;
 try{assert.equal(await prepareNativeSend(f.tab,'qq_mail',request),null);}finally{if(old!==undefined)process.env.APP_CLI_MAIL_NATIVE_SEND=old;}
 enable(t);assert.match((await prepareNativeSend(f.tab,'qq_mail',request)).token,/^[0-9]+:[a-z0-9]+$/);
 for(const change of [{mode:'reply'},{message:{...request.message,cc:['c@example.test']}},{message:{...request.message,attachments:[{}]}},{message:{...request.message,to:['a@example.test','b@example.test']}}])assert.equal(await prepareNativeSend(f.tab,'qq_mail',{...request,...change}),null);
 assert.equal(await prepareNativeSend(f.tab,'gmail',request),null);assert.equal(f.calls.length,0);
});

for(const [label,setup,reason] of [
 ['failed Sent baseline read',f=>{f.readThrow=true;},'sent_baseline'],
 ['server-rejected session read',f=>{f.readStatus=401;},'sent_baseline'],
 ['expired template',f=>{f.now+=15*60*1000+1;},'template_expired'],
 ['disposed Reader',f=>{f.reader.dispose();},'reader_unavailable'],
])test(`preflight ${label} is not sent, claims nothing and falls back to the DOM flow`,async t=>{
 enable(t);process.env.APP_CLI_MAIL_SEND_EVIDENCE='1';t.after(()=>{delete process.env.APP_CLI_MAIL_SEND_EVIDENCE;});
 const events=stderr(t);const f=fixture(t);f.learn();await f.confirm();setup(f);
 const dir=await journalDir(t,'native-preflight-');const {seen,tab}=domFallbackTab(f);let reserve=0,release=0;
 const runtime={emailWorkspaceRoot:dir,reserveDispatch(){reserve++;},releaseDispatch:async()=>{release++;},withSendTab:fn=>fn(tab),
  notSentReceipt:(request,code)=>({schema_version:1,status:'not_sent',provider:'qq_mail',recipient_digest:request.recipientDigest,reason:code})};
 await assert.rejects(sendManagedMail(raw(),'qq_mail',runtime),{code:'email_send_precondition_failed'});
 assert.equal(f.calls.length,0);assert.equal(reserve,0);assert.equal(release,0);
 assert.equal(seen.goto,1,'the DOM flow took over');assert.ok(seen.dom>0);
 const journal=await openSendJournal(dir,validateManagedSend(raw(),'qq_mail'));assert.equal(journal.saved.stage,'not_sent');
 const native=events.find(event=>event.event==='mail_native_send');
 assert.deepEqual(native,{event:'mail_native_send',provider:'qq_mail',outcome:'not_sent',dispatched:false,fallback:'dom',reason});
 assert.equal(events.find(event=>event.event==='mail_send_timing').path,'dom');
 if(reason!=='reader_unavailable')assert.equal(f.reader.sendNativeReady(initial).ready,false,'a session that cannot read retires the template');
});

for(const [label,delay,outcome] of [['4.2 s',4200,'sent'],['11 s',11000,'sent'],['exactly 12 s',12000,'sent'],['12.5 s',12500,'unknown']])
 test(`a Sent row appearing after ${label} is ${outcome}`,async t=>{
 const f=fixture(t);f.learn();await f.confirm();f.sentDelay=delay;
 const result=await f.send();assert.equal(result.outcome,outcome);assert.equal(f.calls.length,1);
 const polls=f.reads.filter(read=>read.at>=f.sentAt);
 if(outcome==='sent'){assert.ok(result.timings.sent_verify_ms>=delay&&result.timings.sent_verify_ms<delay+750,String(result.timings.sent_verify_ms));}
 else{assert.equal(result.reason,'sent_confirmation');assert.equal(result.timings.sent_verify_ms,12000);assert.equal(polls.at(-1).at-f.sentAt,12000);
  assert.equal(f.reader.sendNativeReady(initial).ready,false);}
 assert.ok(polls.every((read,index)=>!index||read.at-polls[index-1].at<=1000),'polls at most 1 s apart');
});

for(const lost of [false,true])test(`managed native dispatch persists unknown and never replays after ${lost?'lost response':'ret=0'}`,async t=>{
 enable(t);const f=fixture(t);f.learn();await f.confirm();f.throw=lost;f.missing=true;
 const dir=await journalDir(t,'native-journal-');
 let tabs=0,release=0;
 const runtime={emailWorkspaceRoot:dir,reserveDispatch(){},releaseDispatch:async()=>{release++;},withSendTab:fn=>{tabs++;return fn(f.tab);}};
 await assert.rejects(sendManagedMail(raw(),'qq_mail',runtime),{code:'send_outcome_unknown'});
 assert.equal((await sendManagedMail(raw(),'qq_mail',runtime)).status,'unknown');
 assert.equal((await sendManagedMail({...raw(),mode:'reconcile'},'qq_mail',runtime)).status,'unknown');
 assert.equal(f.calls.length,1);assert.equal(tabs,1);assert.equal(release,1);
});

for(const [label,status,response] of [['auth rejection',401,'{}'],['malformed response',200,'<html>private error</html>'],['error envelope',200,'{"head":{"ret":-20003}}']])
 test(`QQ ${label} stays unknown, retires the template and sends the next message through the DOM`,async t=>{
 enable(t);const f=fixture(t);f.learn();await f.confirm();f.status=status;f.response=response;
 const dir=await journalDir(t,'native-rejected-');let release=0;
 const runtime={emailWorkspaceRoot:dir,reserveDispatch(){},releaseDispatch:async()=>{release++;},withSendTab:fn=>fn(f.tab)};
 await assert.rejects(sendManagedMail(raw(),'qq_mail',runtime),{code:'send_outcome_unknown'});
 assert.equal(f.calls.length,1);assert.equal(release,1);assert.equal(f.reader.sendNativeReady(initial).ready,false);
 // The rejected invocation itself is never dispatched again.
 assert.equal((await sendManagedMail(raw(),'qq_mail',runtime)).status,'unknown');assert.equal(f.calls.length,1);
 // A new message cannot use the retired template; it takes the DOM flow.
 const {seen,tab}=domFallbackTab(f);
 await assert.rejects(sendManagedMail({...raw(),invocation_id:'next-message'},'qq_mail',{...runtime,withSendTab:fn=>fn(tab)}),{code:'email_send_precondition_failed'});
 assert.equal(seen.goto,1);assert.equal(f.calls.length,1);assert.equal(release,1);
});

test('managed native dispatch cannot cross a rejected authority release',async t=>{
 enable(t);const f=fixture(t);f.learn();await f.confirm();
 const dir=await journalDir(t,'native-release-');
 const runtime={emailWorkspaceRoot:dir,reserveDispatch(){},releaseDispatch:async()=>{throw Object.assign(new Error('not authorized'),{code:'AUTHORIZATION_STALE'});},withSendTab:fn=>fn(f.tab)};
 await assert.rejects(sendManagedMail(raw(),'qq_mail',runtime),{code:'AUTHORIZATION_STALE'});assert.equal(f.calls.length,0);
});

test('consecutive managed native sends reuse the renewed template',async t=>{
 enable(t);const f=fixture(t);f.learn();await f.confirm();
 const dir=await journalDir(t,'native-chain-');let release=0;
 const runtime={emailWorkspaceRoot:dir,reserveDispatch(){},releaseDispatch:async()=>{release++;},withSendTab:fn=>fn(f.tab)};
 for(let index=0;index<3;index++){
  f.now+=10*60*1000;// ten idle minutes between messages
  f.reader.armLearning({kind:'mark_read',window_ms:10000});
  assert.equal((await sendManagedMail({...raw(),invocation_id:`chain-${index}`},'qq_mail',runtime)).status,'sent');
 }
 assert.equal(f.calls.length,3);assert.equal(release,3);assert.equal(f.reader.sendNativeReady(initial).ready,true);
});

test('autosave on sendmail func=2 cannot teach or poison the actual func=1 send',async t=>{
 const f=fixture(t),x=f.learn(form({func:'2',manual_save:'false'}));
 assert.equal(f.reader.sendNativeReady(initial).ready,false);
 const body=form();x.open('POST','https://wx.mail.qq.com/send/sendmail');x.setRequestHeader('content-type','application/x-www-form-urlencoded');x.send(body);x.loaded();
 assert.equal(await f.confirm(),true);
});

test('a pending confirmation cannot repopulate a newer learning window',async t=>{
 const f=fixture(t);f.learn();let release;
 f.pauseRead=new Promise(resolve=>{release=resolve;});
 const confirming=f.confirm();
 f.reader.armLearning({kind:'send',capture_send_template:true});
 release();assert.equal(await confirming,false);assert.equal(f.reader.sendNativeReady(initial).ready,false);
});

test('oversized XHR responses cannot teach a template',async t=>{
 const f=fixture(t),x=f.learn();x.responseText=' '.repeat(1<<20)+x.responseText;x.loaded();
 assert.equal(await f.confirm(),false);
});

for(const [label,rowChange] of [
 ['folder',{dirid:1}],['subject',{subject:'other'}],['recipient',{receivers:{item:[{email:'other@example.test'}]}}],
 ['sender',{senders:{item:[{email:'other@example.test'}]}}],['response identity',{messageid:'another'}],
 ['invalid stored identity',{emailid:'not an id'}],['multiple recipients',{receivers:{item:[{email:message.to[0]},{email:'other@example.test'}]}}],
])test(`independent Sent ${label} mismatch never certifies a native send`,async t=>{
 const f=fixture(t);f.learn();assert.equal(await f.confirm(),true);f.rowChange=rowChange;
 const ticket=await f.prepare();assert.equal((await f.reader.sendNative({...message,token:ticket.token})).outcome,'unknown');assert.equal(f.calls.length,1);
 await assert.rejects(f.reader.sendNative({...message,token:ticket.token}));assert.equal((await f.prepare()).ready,false);assert.equal(f.calls.length,1);
});

for(const [label,field] of [['duplicate matches','duplicate'],['old response identity','beforeNew'],['lost Sent read','readThrowAfterSend']])
test(`${label} remains unknown after one native dispatch`,async t=>{
 const f=fixture(t);f.learn();assert.equal(await f.confirm(),true);f[field]=true;
 assert.equal((await f.send()).outcome,'unknown');assert.equal(f.calls.length,1);
});

test('failed independent baseline retires the template before any dispatch',async t=>{
 const f=fixture(t);f.learn();assert.equal(await f.confirm(),true);f.readThrow=true;
 const ticket=await f.prepare();assert.deepEqual({...ticket},{provider:'qq_mail',account_address:owner,ready:false,dispatched:false,reason:'sent_baseline'});
 assert.equal(f.calls.length,0);assert.equal(f.reader.sendNativeReady(initial).ready,false);
 await assert.rejects(f.reader.sendNative(message),{code:'email_network_template_unlearned'});assert.equal(f.calls.length,0);
});

test('qualified native proof persists both identifier namespaces and replays only its receipt',async t=>{
 enable(t);const f=fixture(t);f.learn();await f.confirm();
 const dir=await journalDir(t,'native-proven-');
 const tab={runReadCode:async code=>{const value=await f.tab.runReadCode(code);if(value?.proof)value.proof.extra='private'.repeat(10000);return value;}};
 const runtime={emailWorkspaceRoot:dir,reserveDispatch(){},releaseDispatch:async()=>{},withSendTab:fn=>fn(tab)};
 const receipt=await sendManagedMail(raw(),'qq_mail',runtime);
 assert.equal(receipt.status,'sent');assert.equal(receipt.provider_message_id,'new-sent-id');
 const journal=await openSendJournal(dir,validateManagedSend(raw(),'qq_mail'));
 assert.equal(journal.saved.evidence.proof.response_message_id,'new-response-id');
 assert.equal(journal.saved.evidence.proof.provider_message_id,'new-sent-id');
 assert.equal(journal.saved.evidence.proof.extra,undefined);
 assert.deepEqual(await sendManagedMail({...raw(),mode:'reconcile'},'qq_mail',runtime),receipt);
 assert.equal(f.calls.length,1);
});

test('an unexpected bare sent return cannot replace independent proof',async t=>{
 enable(t);const f=fixture(t);f.learn();await f.confirm();
 const dir=await journalDir(t,'native-unproven-');
 const tab={runReadCode:async code=>code.includes('return await r.sendNative(request)')?{outcome:'sent',provider:'qq_mail',account_address:owner,provider_message_id:'fake'}:f.tab.runReadCode(code)};
 await assert.rejects(sendManagedMail(raw(),'qq_mail',{emailWorkspaceRoot:dir,reserveDispatch(){},releaseDispatch:async()=>{},withSendTab:fn=>fn(tab)}),{code:'send_outcome_unknown'});
});
