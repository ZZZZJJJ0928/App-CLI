import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installReader} from '../../applications/mail/userscripts/lib/reader-core.mjs';
import {markQQMailRead} from '../../applications/mail/userscripts/lib/qqmail-mark-read.mjs';
import {parseQQMailList} from '../../applications/mail/lib/qqmail-list.mjs';
import {captureMail} from '../../applications/mail/lib/read-capture.mjs';
import {markEmailRead} from '../../applications/mail/read.mjs';

const target={account_address:'owner@example.test',provider_message_id:'fixture-message',provider_selection_id:'fixture-message',
  received_at:'2026-09-10T01:02:03.000Z',folder:'inbox'};
const seconds=Date.parse(target.received_at)/1000;
const range={account_address:target.account_address,provider_mode:'time_range',page:0,
  interval_start:'2026-09-10T01:02:02.000Z',interval_end:'2026-09-10T01:02:04.000Z'};

function fixture(options={}) {
  const state={unread:true,clicks:0,requests:[],confirmCalls:0,markCalls:0,releaseCalls:0,...options};
  class XHR {open(){} send(){} setRequestHeader(){} addEventListener(){}}
  const context=vm.createContext({URL,URLSearchParams,Map,Date,JSON,Object,Number,Error,TextDecoder,Uint8Array,Response,Blob,AbortSignal,
    setTimeout:callback=>setTimeout(callback,0),clearTimeout,performance:{now:()=>performance.now(),getEntriesByType:()=>[]},
    XMLHttpRequest:XHR,MutationObserver:class {observe(){} disconnect(){}},account:target.account_address,
    location:{origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index?sid=synthetic-session'},
    document:{querySelectorAll:()=>Array.from({length:state.nodes??1},()=>({isConnected:true,getAttribute:()=>target.provider_message_id,
      getClientRects:()=>[{}],click(){state.clicks++;if(!state.suppressEffect)state.unread=false;}})),
      addEventListener(){},removeEventListener(){},body:{append(){}},createElement:()=>({remove(){}})},
    fetch:async(url,options)=>{
      const u=new URL(url);state.requests.push({path:u.pathname,params:[...u.searchParams.keys()],body:Object.fromEntries(options.body??[]),cache:options.cache});
      assert.ok(options.signal instanceof AbortSignal);
      // QQ's cached landing page need not issue a list request. Its legacy
      // list endpoint can reject the synthesized binding after a valid search.
      if(u.pathname==='/list/maillist')return new Response(JSON.stringify({head:{ret:-5002,time:seconds+60}}));
      assert.equal(u.pathname,'/list/search');assert.equal(options.method,'POST');
      assert.deepEqual([...u.searchParams.keys()],['sid']);
      const row={emailid:target.provider_message_id,dirid:1,totime:seconds,...(state.unread?{unread:1}:{})};
      const value={head:{ret:0,time:seconds+60},body:{total_num:1,lock_num:0,list:[row]}};
      const response=await state.response?.(value,state.requests.length,context);
      return response instanceof Response?response:new Response(JSON.stringify(response??value));
    },
  });
  vm.runInContext('window=globalThis;window.top=window;',context);
  vm.runInContext(`const parseQQMailList=${parseQQMailList.toString()};const markQQMailRead=${markQQMailRead.toString()};
    (${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,
      listURL:u=>u.pathname==='/list/maillist',parse:value=>(parseQQMailList(value)?.rows??[]).map(row=>({...row,draft:false,sent:false,grouped:false})),markRead:markQQMailRead});`,context);
  const reader=context.SparkClawMailReader;
  const tab={runReadCode:code=>{
    if(code.includes('"method":"confirmRead"'))state.confirmCalls++;
    if(code.includes('"method":"markRead"'))state.markCalls++;
    return vm.runInContext(`(${code})({evaluate:(fn,arg)=>fn(arg)})`,context);
  }};
  return {reader,tab,state,context};
}

test('actual Reader confirms the exact search target after one click, never replaying a rejected legacy list URL',async()=>{
  const f=fixture();await f.reader.listPage(range);
  assert.equal((await f.reader.markRead(target)).read_state,'read');
  assert.equal(f.state.clicks,1);assert.equal(f.state.requests.length,3);
  for(const request of f.state.requests) {
    assert.equal(request.path,'/list/search');assert.equal(request.cache,'no-store');
    assert.deepEqual(Object.keys(request.body).sort(),['after','before','page_now','page_size','sort_direction','sort_type']);
  }
  // Native QQ omits unread for read rows. Only a fresh, qualified response
  // carrying the exact target makes that omission meaningful.
  assert.equal((await f.reader.confirmRead(target)).read_state,'read');assert.equal(f.state.clicks,1);
});

test('cached read state cannot mask a changed unread state or trigger another write',async()=>{
  const f=fixture({unread:false});await f.reader.listPage(range);
  f.state.unread=true;f.state.suppressEffect=true;
  assert.equal((await f.reader.markRead(target)).read_state,'unknown');assert.equal(f.state.clicks,1);
  assert.equal((await f.reader.markRead(target)).read_state,'unknown');assert.equal(f.state.clicks,1);
  f.state.unread=false;
  assert.equal((await f.reader.confirmRead(target)).read_state,'read');assert.equal(f.state.clicks,1);
});

for(const fault of ['foreign-id','receipt-drift','folder-drift','duplicate','overflow','locked','bad-ret','malformed','bad-unread','foreign-origin','owner-drift']) {
  test(`fresh QQ confirmation rejects ${fault} without another mutation`,async()=>{
    const f=fixture();await f.reader.listPage(range);
    f.state.response=(value,_count,context)=>{
      const row=value.body.list[0];delete row.unread;
      if(fault==='foreign-id')row.emailid='different-message';
      if(fault==='receipt-drift')row.totime++;
      if(fault==='folder-drift')row.dirid=2000;
      if(fault==='duplicate')value.body.list.push({...row});
      if(fault==='overflow')value.body.total_num=100;
      if(fault==='locked')value.body.lock_num=1;
      if(fault==='bad-ret')value.head.ret=-5002;
      if(fault==='malformed')return new Response('{');
      if(fault==='bad-unread')row.unread=2;
      if(fault==='foreign-origin'){const response=new Response(JSON.stringify(value));Object.defineProperty(response,'url',{value:'https://foreign.example.test/list/search'});return response;}
      if(fault==='owner-drift')context.account='other@example.test';
      return value;
    };
    // A changed account is also rejected by the final independent check.
    if(fault==='owner-drift')await assert.rejects(f.reader.confirmRead(target),{code:'email_account_identity_mismatch'});
    else assert.equal((await f.reader.confirmRead(target)).read_state,'unknown');
    assert.equal(f.state.clicks,0);
  });
}

test('request identity must match the observed immutable target before any query or click',async()=>{
  for(const change of [{provider_selection_id:'other'},{received_at:'2026-09-10T01:02:04Z'},{folder:'qq:2000'}]) {
    const f=fixture();await f.reader.listPage(range);const count=f.state.requests.length;
    await assert.rejects(f.reader.markRead({...target,...change}),{code:'email_message_identity_invalid'});
    assert.equal(f.state.requests.length,count);assert.equal(f.state.clicks,0);
  }
});

test('a disposed Reader cannot click after its in-flight fresh check completes',async()=>{
  const f=fixture();await f.reader.listPage(range);
  f.state.response=value=>{f.reader.dispose();return value;};
  await assert.rejects(f.reader.markRead(target),{code:'email_network_capability_unavailable'});
  assert.equal(f.state.clicks,0);
});

test('confirmation is bounded, target DOM ambiguity stays unknown, and reset cannot interrupt confirmation',async()=>{
  for(const nodes of [0,2]) {
    const f=fixture({nodes});await f.reader.listPage(range);
    assert.equal((await f.reader.markRead(target)).read_state,'unknown');assert.equal(f.state.clicks,0);
  }
  const f=fixture({suppressEffect:true});await f.reader.listPage(range);
  let finish;f.state.response=value=>new Promise(resolve=>{finish=()=>resolve(value);});
  const pending=f.reader.confirmRead(target);
  assert.throws(()=>f.reader.resetRound({account_address:target.account_address}),{code:'email_network_list_unqualified'});
  f.state.response=undefined;finish();
  assert.equal((await pending).read_state,'unknown');
  assert.equal(f.state.requests.length,5,'one selection and four bounded read-only observations');
  assert.equal(f.state.clicks,0);
});

async function capturedFixture(t,options={}) {
  const f=fixture(options),root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'qq-read-confirmation-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input={schema_version:1,operation:'capture',provider:'qq_mail',account:'default',owner_scope:'a'.repeat(64),invocation_id:'capture-source',target};
  const source=Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Synthetic\r\nDate: Thu, 10 Sep 2026 01:02:03 +0000\r\nMessage-ID: <synthetic@example.test>\r\n\r\nSynthetic original.');
  const runtime={emailWorkspaceRoot:root,withReadTab:callback=>callback({...f.tab,download:async(_selector,destination)=>fs.writeFile(destination,source)}),
    releaseDispatch:async()=>{f.state.releaseCalls++;}};
  const captured=await captureMail(input,runtime,'qq_mail',{markAfterCapture:false,collectUnread:async(_tab,_provider,selection)=>{
    const message={...target,read_state:'unread',original:{selector:'#original'}};await selection.onSelected(message);return message;
  }});
  const request={...input,operation:'mark_read',invocation_id:'mark-once',committed_capture:captured.capture};
  const directory=path.dirname(path.join(root,captured.capture.manifest_path));
  const immutable=async()=>Promise.all(['capture.json','message.eml'].map(file=>fs.readFile(path.join(directory,file),'base64')));
  return {...f,root,runtime,request,directory,immutable};
}

test('committed capture through actual Reader confirms a write once and preserves original bytes',async t=>{
  const f=await capturedFixture(t),before=await f.immutable();
  assert.equal((await markEmailRead(f.request,f.runtime,'qq_mail')).read_state,'read');
  assert.equal(f.state.clicks,1);assert.equal(f.state.releaseCalls,1);assert.equal(f.state.markCalls,1);
  assert.deepEqual(await f.immutable(),before);
  await markEmailRead({...f.request,invocation_id:'new-invocation'},f.runtime,'qq_mail');
  assert.equal(f.state.clicks,1);assert.equal(f.state.releaseCalls,1);
});

for(const prior of ['unknown','pending'])test(`durable ${prior} from a released write only performs fresh read confirmation`,async t=>{
  const f=await capturedFixture(t,{suppressEffect:true}),before=await f.immutable();
  await fs.writeFile(path.join(f.directory,'read-state.json'),JSON.stringify({schema_version:1,state:prior,observed:'unknown'}));
  assert.equal((await markEmailRead(f.request,f.runtime,'qq_mail')).read_state,'unknown');
  assert.equal(f.state.clicks,0);assert.equal(f.state.releaseCalls,0);assert.equal(f.state.markCalls,0);assert.equal(f.state.confirmCalls,1);
  f.state.unread=false;
  assert.equal((await markEmailRead({...f.request,invocation_id:'reconcile-only'},f.runtime,'qq_mail')).read_state,'read');
  assert.equal(f.state.clicks,0);assert.equal(f.state.releaseCalls,0);assert.equal(f.state.markCalls,0);assert.equal(f.state.confirmCalls,2);
  assert.deepEqual(await f.immutable(),before);
});

test('an actual unknown attempt is never repeated by a subsequent business invocation',async t=>{
  const f=await capturedFixture(t,{suppressEffect:true}),before=await f.immutable();
  assert.equal((await markEmailRead(f.request,f.runtime,'qq_mail')).read_state,'unknown');
  assert.equal(f.state.clicks,1);assert.equal(f.state.releaseCalls,1);
  const second=await markEmailRead({...f.request,invocation_id:'next-page'},f.runtime,'qq_mail');
  assert.equal(second.read_state,'unknown');assert.equal(f.state.clicks,1);assert.equal(f.state.releaseCalls,1);
  f.state.unread=false;
  assert.equal((await markEmailRead({...f.request,invocation_id:'confirmed-later'},f.runtime,'qq_mail')).read_state,'read');
  assert.equal(f.state.clicks,1);assert.equal(f.state.releaseCalls,1);assert.deepEqual(await f.immutable(),before);
});
