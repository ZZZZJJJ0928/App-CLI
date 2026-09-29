import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {installReader} from '../../applications/mail/userscripts/lib/reader-core.mjs';
import {installOutlookRangeTransport} from '../../applications/mail/userscripts/lib/outlook-range.mjs';
import {installOutlookOriginalResolver} from '../../applications/mail/userscripts/lib/outlook-original.mjs';
import {markQQMailRead} from '../../applications/mail/userscripts/lib/qqmail-mark-read.mjs';
import {parseQQMailList} from '../../applications/mail/lib/qqmail-list.mjs';

function fixture() {
  const nodes=[],listeners={};
  class XHR {
    open() {} send() {}
    addEventListener(_name, callback) {this.callback=callback;}
    deliver(url, value) {this.open('GET',url);this.send();this.status=200;this.responseText=JSON.stringify(value);this.callback();}
  }
  const context=vm.createContext({URL,URLSearchParams,Map,Date,JSON,Object,Number,Error,TextDecoder,Uint8Array,Response,Blob,AbortSignal,AbortController,setTimeout,clearTimeout,structuredClone,performance,
    btoa:value=>Buffer.from(value,'binary').toString('base64'),
    XMLHttpRequest:XHR,MutationObserver:class {observe(){} disconnect(){}},
    location:{origin:'https://mail.google.com',href:'https://mail.google.com/mail/u/0/'},
    document:{addEventListener(name,callback){listeners[name]=callback;},removeEventListener(){},body:{append(node){nodes.push(node);}},createElement:()=>({remove(){}})},
    requests:[],fetch:async url=>{context.requests.push(url);const response=new Response(context.originalBytes??'From: sender@example.test\r\nMessage-ID: <fixture@example.test>\r\n\r\nSynthetic original.',{headers:context.responseHeaders});if(context.responseURL)Object.defineProperty(response,'url',{value:context.responseURL});return response;},open(){},nodes,account:'owner@example.test',
  });
  vm.runInContext('window=globalThis;window.top=window;',context);
  vm.runInContext(`(${installReader.toString()})({provider:'gmail',origins:['https://mail.google.com'],account:()=>account,listURL:u=>u.pathname==='/list',parse:value=>value.rows,download:({id})=>new URL('/download?id='+encodeURIComponent(id),location.origin)});`,context);
  return {context,reader:context.SparkClawMailReader,deliver:rows=>new XHR().deliver('https://mail.google.com/list?sid=private-session-fixture',{rows}),nodes,XHR,listeners};
}
const interval={account_address:'owner@example.test',interval_start:'2026-09-10T00:00:00Z',interval_end:'2026-09-11T00:00:00Z'};
const row=(id,extra={})=>({provider_message_id:id,received_at:'2026-09-10T00:00:00Z',draft:false,sent:false,...extra});

test('round reset discards originals and source rows without network and cannot change owner',async()=>{
  const f=fixture();f.deliver([row('a')]);
  await f.reader.prepareOriginal({account_address:interval.account_address,provider_message_id:'a'});
  const blob=f.nodes.at(-1).href,requests=f.context.requests.length;
  assert.equal(f.reader.resetRound(interval).account_address,interval.account_address);
  assert.equal(f.reader.diagnostics().records,0);
  assert.equal(f.reader.diagnostics().original.state,'unlearned');
  assert.equal(f.context.requests.length,requests);
  await assert.rejects(fetch(blob));
  await assert.rejects(f.reader.prepareOriginal({account_address:interval.account_address,provider_message_id:'a'}),{code:'email_network_target_unobserved'});
  assert.throws(()=>f.reader.resetRound({account_address:'other@example.test'}),{code:'email_account_identity_mismatch'});
  f.reader.dispose();assert.throws(()=>f.reader.resetRound(interval),{code:'email_network_list_unqualified'});
});

test('observer account check does not mutate an active Reader round',()=>{
  const f=fixture();f.deliver([row('a')]);
  const before=f.reader.diagnostics().records;
  assert.equal(f.reader.checkAccount({account_address:interval.account_address}),true);
  assert.equal(f.reader.diagnostics().records,before);
  f.context.account='other@example.test';
  assert.throws(()=>f.reader.checkAccount({account_address:interval.account_address}),{code:'email_account_identity_mismatch'});
  assert.equal(f.reader.diagnostics().records,before);
});

test('round reset rejects in-flight original preparation and becomes available after completion',async()=>{
  const f=fixture();f.deliver([row('a')]);
  const pending=f.reader.prepareOriginal({account_address:interval.account_address,provider_message_id:'a'});
  assert.throws(()=>f.reader.resetRound(interval),{code:'email_network_list_unqualified'});
  await pending;assert.doesNotThrow(()=>f.reader.resetRound(interval));
});

test('Gmail sequential rounds reuse only transport template and issue one fresh interval request',async()=>{
  const f=fixture();f.context.nativeQueries=[];
  vm.runInContext(`(${installReader.toString()})({provider:'gmail',origins:['https://mail.google.com'],account:()=>account,listURL:u=>u.pathname==='/list',parse:()=>[],search:query=>{
    nativeQueries.push(query);
    const body=[[],null,[]];body[0][3]=query;body[0][15]=[];
    const xhr=new XMLHttpRequest();xhr.open('POST','https://mail.google.com/list');xhr.send(JSON.stringify(body));
    const value=[];value[0]=0;value[3]=0;value[19]=[[null,null,null,null]];
    xhr.status=200;xhr.responseText=JSON.stringify(value);xhr.callback();
    originalBytes=JSON.stringify(value);
  }});`,f.context);
  const reader=f.context.SparkClawMailReader;
  await reader.listPage(interval);
  const next={...interval,interval_start:interval.interval_end,interval_end:'2026-09-12T00:00:00Z'};
  await assert.rejects(reader.listPage(next),{code:'email_network_list_unqualified'});
  reader.resetRound(interval);
  assert.equal((await reader.listPage(next)).rows.length,0);
  assert.equal(f.context.nativeQueries.length,1);assert.equal(f.context.requests.length,1);
  reader.resetRound(interval);
  await reader.listPage(next);
  assert.equal(f.context.requests.length,2,'same interval in a new round must not reuse a response');
  reader.dispose();
});

test('Gmail missing template uses one native bounded query and no replay fetch',async()=>{
  const f=fixture();
  f.context.nativeQueries=[];
  vm.runInContext(`(${installReader.toString()})({provider:'gmail',origins:['https://mail.google.com'],account:()=>account,listURL:u=>u.pathname==='/list',parse:()=>[],search:query=>{
    nativeQueries.push(query);
    const body=[[],null,[]];body[0][3]=query;body[0][15]=[];
    const xhr=new XMLHttpRequest();xhr.open('POST','https://mail.google.com/list');xhr.send(JSON.stringify(body));
    const value=[];value[0]=0;value[3]=0;value[19]=[[null,null,null,null]];
    xhr.status=200;xhr.responseText=JSON.stringify(value);xhr.callback();
  }});`,f.context);
  const result=await f.context.SparkClawMailReader.listPage(interval);
  assert.equal(result.has_next,false);assert.equal(result.rows.length,0);
  assert.equal(f.context.nativeQueries.length,1);
  assert.match(f.context.nativeQueries[0],/after:\d+ before:\d+$/);
  assert.equal(f.context.requests.length,0);
  assert.equal(f.context.SparkClawMailReader.diagnostics().list.stage,'complete');
});

test('managed reader admits receipt interval ties regardless of unread and de-duplicates observations',()=>{
  const f=fixture();
  f.deliver([row('read',{unread:false}),row('unread',{unread:true}),row('old',{received_at:'2026-09-09T23:59:59Z'}),row('next',{received_at:interval.interval_end}),row('draft',{draft:true}),row('sent',{sent:true}),row('unknown',{received_at:null}),row('group',{grouped:true})]);
  f.deliver([row('read',{unread:false})]);
  const result=f.reader.snapshot(interval);
  assert.deepEqual(Array.from(result.rows,r=>r.provider_message_id),['read','unread']);
  assert.equal(result.unsupported_rows,2);assert.equal(result.scan_complete,false);
  assert.ok(!JSON.stringify(result).includes('private-session-fixture'));
});

test('network originals require an observed target and the provider network download definition',async()=>{
  const f=fixture(),target={account_address:interval.account_address,provider_message_id:'a'};
  f.deliver([row('a',{native_message_id:'msg-f:10'}),row('b',{native_message_id:'msg-f:11'})]);
  const result=await f.reader.prepareOriginal(target);
  assert.equal(result.selector,'#sparkclaw-mail-original');
  assert.equal(result.bytes,Buffer.byteLength('From: sender@example.test\r\nMessage-ID: <fixture@example.test>\r\n\r\nSynthetic original.'));
  assert.equal(Buffer.from(result.inline_base64,'base64').toString(), 'From: sender@example.test\r\nMessage-ID: <fixture@example.test>\r\n\r\nSynthetic original.');
  const url=new URL(f.context.requests.at(-1));
  assert.match(f.nodes.at(-1).href,/^blob:/);
  assert.equal(url.searchParams.get('id'),'a');
  assert.equal(await (await fetch(f.nodes.at(-1).href)).text(),'From: sender@example.test\r\nMessage-ID: <fixture@example.test>\r\n\r\nSynthetic original.');
  await assert.rejects(f.reader.prepareOriginal({...target,provider_message_id:'never-observed'}),{code:'email_network_target_unobserved'});
  f.deliver([row('Cgroup',{grouped:true})]);await assert.rejects(f.reader.prepareOriginal({...target,provider_message_id:'Cgroup'}),{code:'email_network_target_unobserved'});
  assert.equal(typeof f.reader.observeNativeOriginalURL,'undefined');
  assert.equal(typeof f.reader.armOriginal,'undefined');
  assert.equal(typeof f.reader.confirmOriginal,'undefined');
});

test('retained Gmail identity reads an old original without observing a list row again',async()=>{
  const f=fixture();
  const target={account_address:interval.account_address,provider_message_id:'a',provider_selection_id:'thread-f:10',provider_native_id:'msg-f:10',folder:'inbox'};
  const result=await f.reader.prepareRetainedOriginal(target);
  assert.equal(result.provider_message_id,'a');
  assert.equal(f.context.requests.length,1);
  assert.equal(new URL(f.context.requests[0]).pathname,'/download');
  assert.equal(f.reader.snapshot(interval).rows.length,0);
  await assert.rejects(f.reader.prepareRetainedOriginal({...target,provider_native_id:'msg-f:11'}),{code:'email_network_target_unobserved'});
  await assert.rejects(f.reader.prepareRetainedOriginal({...target,account_address:'other@example.test'}),{code:'email_account_identity_mismatch'});
  assert.equal(f.context.requests.length,1);
});

test('network originals preserve binary bytes and reject an HTML login response',async()=>{
  const f=fixture(),target={account_address:interval.account_address,provider_message_id:'a'};
  f.deliver([row('a')]);
  f.context.originalBytes=Buffer.concat([Buffer.from('From: sender@example.test\r\n\r\n'),Buffer.from([0,127,128,255])]);
  await f.reader.prepareOriginal(target);
  assert.deepEqual(Buffer.from(await(await fetch(f.nodes.at(-1).href)).arrayBuffer()),f.context.originalBytes);
  f.context.originalBytes='<html>Please sign in</html>';
  await assert.rejects(f.reader.prepareOriginal(target),{code:'email_network_original_unqualified'});
  await assert.rejects(f.reader.prepareOriginal(target),{code:'email_network_original_unqualified'});
});

test('HTML original overview containing embedded RFC headers is a provider operational failure',async()=>{
  const f=fixture(),target={account_address:interval.account_address,provider_message_id:'a'};
  f.deliver([row('a')]);
  f.context.originalBytes='<html><head><title>Original message</title></head><body><pre>\nFrom: sender@example.test\r\nMessage-ID: <fixture@example.test>\r\n\r\nSynthetic original.</pre></body></html>';
  await assert.rejects(f.reader.prepareOriginal(target),{code:'email_network_original_unqualified'});
  assert.equal(f.nodes.length,0);
  assert.equal(f.reader.diagnostics().original.state,'invalid_headers');
  assert.equal(f.reader.diagnostics().original.response.bytes,Buffer.byteLength(f.context.originalBytes));
  assert.equal(JSON.stringify(f.reader.diagnostics()).includes('sender@example.test'),false);
});

test('QQ rejected originals retain only bounded response metadata and clear it at the round boundary',async()=>{
  const f=fixture();f.reader.dispose();
  f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index?sid=private'};
  vm.runInContext(`(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list',parse:value=>value.rows,download:()=>new URL('/original',location.origin)});`,f.context);
  const reader=f.context.SparkClawMailReader;
  const target={account_address:interval.account_address,provider_message_id:'a',provider_selection_id:'a',folder:'inbox'};
  f.context.originalBytes=JSON.stringify({head:{ret:-77},body:{message:'private response',sid:'secret'}});
  await assert.rejects(reader.prepareRetainedOriginal(target),{code:'email_network_original_unqualified'});
  const diagnostic=JSON.parse(JSON.stringify(reader.diagnostics().original));
  assert.equal(diagnostic.state,'invalid_headers');
  assert.deepEqual(diagnostic.response,{status:200,type:'text/plain',bytes:Buffer.byteLength(f.context.originalBytes),provider_code:-77});
  assert.equal(JSON.stringify(diagnostic).includes('private'),false);
  assert.equal(JSON.stringify(diagnostic).includes('secret'),false);
  assert.equal(f.nodes.length,0);
  reader.resetRound(interval);
  assert.equal(reader.diagnostics().original.response,null);
  f.context.originalBytes=JSON.stringify({head:{ret:'private-code'}});
  await assert.rejects(reader.prepareRetainedOriginal(target),{code:'email_network_original_unqualified'});
  assert.equal(Object.hasOwn(reader.diagnostics().original.response,'provider_code'),false);
});

function qqOriginalFixture() {
  const f=fixture();f.reader.dispose();
  f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index?sid=private'};
  vm.runInContext(`(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list',parse:value=>value.rows,download:()=>new URL('/original',location.origin)});`,f.context);
  return {...f,reader:f.context.SparkClawMailReader,target:{account_address:interval.account_address,provider_message_id:'a',provider_selection_id:'a',folder:'inbox'}};
}

test('QQ original requests remain paced across successful round resets',async()=>{
  const f=qqOriginalFixture();
  await f.reader.prepareRetainedOriginal(f.target);
  f.reader.resetRound(interval);
  let release,delay;
  f.context.setTimeout=(callback,ms)=>{release=callback;delay=ms;return 1;};
  f.context.clearTimeout=()=>{};
  const pending=f.reader.prepareRetainedOriginal(f.target);
  await new Promise(setImmediate);
  assert.equal(f.reader.diagnostics().original.state,'pacing');
  assert.equal(f.context.requests.length,1);
  assert.ok(delay>0&&delay<=1000);
  assert.throws(()=>f.reader.resetRound(interval),{code:'email_network_list_unqualified'});
  release();
  const result=await pending;
  assert.equal(f.context.requests.length,2);
  assert.equal(result.provider_message_id,'a');
  f.reader.dispose();
});

test('QQ pacing cancels on disposal and rechecks account before another request',async()=>{
  for(const action of ['dispose','change_account']) {
    const f=qqOriginalFixture();
    await f.reader.prepareRetainedOriginal(f.target);
    f.reader.resetRound(interval);
    let release;
    f.context.setTimeout=callback=>{release=callback;return 1;};
    f.context.clearTimeout=()=>{};
    const pending=f.reader.prepareRetainedOriginal(f.target);
    await new Promise(setImmediate);
    assert.equal(f.context.requests.length,1);
    if(action==='dispose')f.reader.dispose();
    else {f.context.account='other@example.test';release();}
    await assert.rejects(pending,{code:action==='dispose'?'email_network_original_unqualified':'email_account_identity_mismatch'});
    assert.equal(f.context.requests.length,1);
    f.reader.dispose();
  }
});

test('QQ abuse-control response is a provider failure, with no automatic retry or original publication',async()=>{
  const f=qqOriginalFixture();
  f.context.originalBytes=JSON.stringify({head:{ret:-20003,cgi:'xmreadlogicsvr/readmail',msg:'',stack:'Block by spam',show_err_msg:false}});
  f.context.responseHeaders={'content-type':'application/json; charset=utf-8'};
  await assert.rejects(f.reader.prepareRetainedOriginal(f.target),{code:'email_network_read_failed'});
  assert.equal(f.context.requests.length,1);
  assert.equal(f.nodes.length,0);
  assert.equal(f.reader.diagnostics().original.state,'provider_rejected');
  assert.equal(f.reader.diagnostics().original.response.provider_code,-20003);
  assert.equal(JSON.stringify(f.reader.diagnostics()).includes('Block by spam'),false);
  f.reader.dispose();
});

test('large network originals keep the controlled download fallback instead of embedding bytes',async()=>{
  const f=fixture(),target={account_address:interval.account_address,provider_message_id:'a'};
  f.deliver([row('a')]);
  f.context.originalBytes=Buffer.concat([Buffer.from('From: sender@example.test\r\n\r\n'),Buffer.alloc((1<<20)+1,65)]);
  const result=await f.reader.prepareOriginal(target);
  assert.equal(result.bytes,f.context.originalBytes.length);
  assert.equal(Object.hasOwn(result,'inline_base64'),false);
  assert.equal(Object.hasOwn(result,'inline_bytes'),false);
});

test('Gmail originals allow the observed attachment redirect and reject other final origins',async()=>{
  const f=fixture(),target={account_address:interval.account_address,provider_message_id:'a'};
  f.deliver([row('a')]);
  f.context.responseURL='https://mail-attachment.googleusercontent.com/attachment/';
  assert.equal((await f.reader.prepareOriginal(target)).selector,'#sparkclaw-mail-original');
  f.context.responseURL='https://unknown.example.test/attachment/';
  await assert.rejects(f.reader.prepareOriginal(target),{code:'email_network_original_unqualified'});
});

test('native URL observation and template acknowledgement are unavailable',()=>{
  const f=fixture();
  assert.equal(typeof f.reader.observeNativeOriginalURL,'undefined');
  assert.equal(typeof f.reader.armOriginal,'undefined');
  assert.equal(typeof f.reader.confirmOriginal,'undefined');
});

test('mark-read fails closed without a provider network mutation',async()=>{
  const f=fixture(),target={account_address:interval.account_address,provider_message_id:'a'};
  f.deliver([row('a',{unread:true})]);
  await assert.rejects(f.reader.markRead(target),{code:'email_network_mark_read_unqualified'});
});

test('QQ mark-read triggers only the exact visible row and confirms unread=0 from a fresh list response',async()=>{
  const f=fixture();f.reader.dispose();
  f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index'};
  f.context.performance={now:()=>performance.now(),getEntriesByType:()=>[{name:'https://wx.mail.qq.com/list/maillist?func=1&sid=private-qq-session&dirid=1'}]};
  let clicked=false,requests=0;
  const raw=()=>({head:{ret:0,time:Math.floor(Date.now()/1000)},body:{total_num:1,list:[{emailid:'qq-message',dirid:1,totime:Math.floor(Date.now()/1000)-1,unread:clicked?0:1}]}});
  f.context.document.querySelectorAll=()=>[{isConnected:true,getAttribute:name=>name==='data-mailid'?'qq-message':null,getClientRects:()=>[{}],click:()=>{clicked=true;}}];
  f.context.fetch=async()=>{requests++;return new Response(JSON.stringify(raw()),{status:200});};
  vm.runInContext(`const parseQQMailList=${parseQQMailList.toString()};const markQQMailRead=${markQQMailRead.toString()};(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list/maillist',parse:value=>(parseQQMailList(value)?.rows??[]).map(row=>({...row,draft:false,sent:false,grouped:false})),markRead:markQQMailRead});`,f.context);
  const reader=f.context.SparkClawMailReader;
  await reader.listPage({...interval,page:0,folder:'inbox'});
  const result=await reader.markRead({account_address:interval.account_address,provider_message_id:'qq-message'});
  assert.equal(clicked,true);assert.equal(result.read_state,'read');assert.equal(requests,2);
  assert.equal((await reader.markRead({account_address:interval.account_address,provider_message_id:'qq-message'})).read_state,'read');
  assert.equal(requests,2,'confirmed records must not repeat the provider effect');
});

test('account changes fail closed and disposal restores only owned network hooks',()=>{
  const f=fixture();f.deliver([row('a')]);f.reader.snapshot(interval);
  f.context.account='other@example.test';
  assert.throws(()=>f.reader.snapshot(interval),{code:'email_account_identity_mismatch'});
  const newerHook=()=>{};f.context.fetch=newerHook;
  f.reader.dispose();assert.equal(f.context.fetch,newerHook);assert.equal(f.context.SparkClawMailReader,undefined);
});

test('QQ replays an observed same-origin list resource when its initial request predates the hooks',async()=>{
  const f=fixture();f.reader.dispose();
  f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index'};
  f.context.performance={now:()=>performance.now(),getEntriesByType:()=>[
    {name:'https://wx.mail.qq.com/list/maillist?func=1&sid=private-qq-session&dirid=1'},
    {name:'https://wx.mail.qq.com/list/maillist?func=1'},
    {name:'https://wx.mail.qq.com/list/maillist?func=2&sid=wrong-operation'},
    {name:'https://foreign.example.test/list/maillist?func=1&sid=foreign-session'},
  ]};
  const requests=[];
  f.context.fetch=async(url,options)=>{
    requests.push({url,options});
    return new Response(new URL(url).pathname==='/list/maillist'
      ? JSON.stringify({head:{ret:0},body:{list:[row('qq-message',{folder:'inbox',provider_selection_id:'qq-message',provider_thread_id:'qq-message'})],total_num:1}})
      : 'From: sender@example.test\r\n\r\nSynthetic original.');
  };
  vm.runInContext(`(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list/maillist',parse:value=>value.body.list,download:({id,binding})=>{const u=new URL('/read/readmail',location.origin);u.searchParams.set('mailid',id);u.searchParams.set('sid',binding.searchParams.get('sid'));return u;}});`,f.context);
  const result=await f.context.SparkClawMailReader.listPage({...interval,page:0,folder:'inbox'});
  assert.equal(result.rows.length,1);assert.equal(result.has_next,false);
  const listURL=new URL(requests[0].url);
  assert.equal(listURL.origin,f.context.location.origin);assert.equal(listURL.searchParams.get('sid'),'private-qq-session');
  assert.equal(listURL.searchParams.get('page_now'),'0');assert.equal(requests[0].options.method,'GET');
  assert.ok(!JSON.stringify(result).includes('private-qq-session'));
  await f.context.SparkClawMailReader.prepareOriginal({account_address:interval.account_address,provider_message_id:'qq-message'});
  assert.equal(new URL(requests[1].url).searchParams.get('sid'),'private-qq-session');
  f.context.SparkClawMailReader.dispose();
});

test('QQ restores its fixed list binding from the signed-in home route',async()=>{
  const f=fixture();f.reader.dispose();
  f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index?sid=private-home-session'};
  f.context.performance={now:()=>performance.now(),getEntriesByType:()=>[]};
  const requests=[];
  f.context.fetch=async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({head:{ret:0},body:{total_num:0,lock_num:0}}));};
  vm.runInContext(`(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list/maillist',parse:value=>value.body.list??[]});`,f.context);
  const result=await f.context.SparkClawMailReader.listPage({...interval,provider_mode:'time_range'});
  assert.equal(result.rows.length,0);assert.equal(requests.length,1);
  const requestURL=new URL(requests[0].url);
  assert.equal(requestURL.pathname,'/list/search');assert.equal(requestURL.searchParams.get('sid'),'private-home-session');
  assert.equal(f.context.SparkClawMailReader.diagnostics().list.stage,'qq_complete');
});

test('QQ stops native pagination after an ordered qualified page crosses the lower bound',async()=>{
  const f=fixture();f.reader.dispose();
  f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index'};
  f.context.performance={now:()=>performance.now(),getEntriesByType:()=>[{name:'https://wx.mail.qq.com/list/maillist?func=1&sid=private-qq-session&dirid=1'}]};
  let rows=Array.from({length:50},(_,index)=>row(`old-${index}`,{folder:'inbox',provider_selection_id:`old-${index}`,provider_thread_id:`old-${index}`,
    received_at:new Date(Date.parse(interval.interval_start)-index*1000-1000).toISOString()}));
  f.context.fetch=async()=>new Response(JSON.stringify({head:{ret:0},body:{list:rows,total_num:5000}}));
  vm.runInContext(`(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list/maillist',parse:value=>value.body.list,download:()=>null});`,f.context);
  const terminal=await f.context.SparkClawMailReader.listPage({...interval,page:0,folder:'inbox'});
  assert.equal(terminal.rows.length,0);assert.equal(terminal.has_next,false);
  rows=[rows[1],rows[0],...rows.slice(2)];
  const unqualified=await f.context.SparkClawMailReader.listPage({...interval,page:0,folder:'inbox'});
  assert.equal(unqualified.has_next,true,'an ordering violation must not certify the boundary');
  f.context.SparkClawMailReader.dispose();
});

test('QQ timeline sends a server-side range once and fences locked results',async()=>{
  const f=fixture();f.reader.dispose();
  f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index'};
  f.context.performance={now:()=>performance.now(),getEntriesByType:()=>[{name:'https://wx.mail.qq.com/list/maillist?func=1&sid=private-qq-session'}]};
  const requests=[];let locked=0;
  f.context.fetch=async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({head:{ret:0},body:{total_num:2,lock_num:locked,list:[row('in',{folder:'inbox'}),row('sent',{folder:'sent'})]}}));};
  vm.runInContext(`(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list/maillist',parse:value=>value.body.list});`,f.context);
  const reader=f.context.SparkClawMailReader;
  const result=await reader.listPage({...interval,provider_mode:'time_range'});
  assert.equal(requests.length,1);assert.equal(new URL(requests[0].url).pathname,'/list/search');
  assert.equal(requests[0].init.method,'POST');
  assert.equal(requests[0].init.body.get('after'),String(Date.parse(interval.interval_start)/1000-1));
  assert.equal(requests[0].init.body.get('before'),String(Date.parse(interval.interval_end)/1000));
  assert.deepEqual(Array.from(result.rows,r=>r.provider_message_id),['in']);assert.equal(result.has_next,false);
  locked=1;assert.equal((await reader.listPage({...interval,provider_mode:'time_range'})).unsupported_rows,1);
  await assert.rejects(reader.listPage({...interval,provider_mode:'time_range',page:1}),{code:'email_incremental_unqualified'});
});

test('QQ refuses a non-list operation even when it carries a session id',async()=>{
  const f=fixture();f.reader.dispose();
  f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index'};
  f.context.performance={now:()=>performance.now(),getEntriesByType:()=>[
    {name:'https://wx.mail.qq.com/list/maillist?func=2&sid=private-qq-session&dirid=1'},
  ]};
  vm.runInContext(`(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list/maillist',parse:value=>value.body.list,download:()=>null});`,f.context);
  const request=new f.XHR();request.open('GET','https://wx.mail.qq.com/list/maillist?func=2&sid=private-qq-session&dirid=1');request.send();
  await assert.rejects(f.context.SparkClawMailReader.listPage({...interval,page:0,folder:'inbox'}),{code:'email_network_list_unqualified'});
  f.context.SparkClawMailReader.dispose();
});

test('QQ true empty search omits list, while a rejected future interval is not certified empty',async()=>{
  const f=fixture();f.reader.dispose();
  f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index'};
  f.context.performance={now:()=>performance.now(),getEntriesByType:()=>[{name:'https://wx.mail.qq.com/list/maillist?func=1&sid=private-qq-session'}]};
  let rejected=false;
  f.context.fetch=async()=>new Response(JSON.stringify(rejected?{head:{ret:-5002},body:{}}:{head:{ret:0},body:{total_num:0,lock_num:0,search_ts:1,is_lock:0}}));
  vm.runInContext(`(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list/maillist',parse:value=>value.body.list});`,f.context);
  const result=await f.context.SparkClawMailReader.listPage({...interval,provider_mode:'time_range'});
  assert.equal(result.rows.length,0);assert.equal(result.unsupported_rows,0);assert.equal(result.has_next,false);
  rejected=true;await assert.rejects(f.context.SparkClawMailReader.listPage({...interval,provider_mode:'time_range'}),{code:'email_network_list_unqualified'});
});

for(const provider of ['qq_mail','gmail'])test(`${provider} preserves nanosecond bounds around millisecond receipts, including empty sub-millisecond ranges`,async()=>{
  const f=fixture();f.reader.dispose();
  f.context.rangeRows=[row('at-ms',{folder:'inbox',received_at:'2026-09-10T00:00:00.123Z'})];
  if(provider==='qq_mail'){
    f.context.location={origin:'https://wx.mail.qq.com',href:'https://wx.mail.qq.com/home/index'};
    f.context.performance={now:()=>performance.now(),getEntriesByType:()=>[{name:'https://wx.mail.qq.com/list/maillist?func=1&sid=private-qq-session'}]};
    f.context.fetch=async()=>new Response(JSON.stringify({head:{ret:0},body:{total_num:1,lock_num:0,list:f.context.rangeRows}}));
    vm.runInContext(`(${installReader.toString()})({provider:'qq_mail',origins:['https://wx.mail.qq.com'],account:()=>account,listURL:u=>u.pathname==='/list/maillist',parse:value=>value.body.list});`,f.context);
  }else{
    f.context.structuredClone=structuredClone;
    f.context.fetch=async()=>{const value=[];value[0]=0;value[3]=0;value[19]=[[null,null,null,null]];return new Response(JSON.stringify(value));};
    vm.runInContext(`(${installReader.toString()})({provider:'gmail',origins:['https://mail.google.com'],account:()=>account,listURL:u=>u.pathname==='/list',parse:()=>rangeRows,search:query=>{
      const body=[[],null,[]];body[0][3]=query;body[0][15]=[];
      const xhr=new XMLHttpRequest();xhr.open('POST','https://mail.google.com/list');xhr.send(JSON.stringify(body));
      const value=[];value[0]=0;value[3]=0;value[19]=[[null,null,null,null]];
      xhr.status=200;xhr.responseText=JSON.stringify(value);xhr.callback();
    }});`,f.context);
  }
  const cases=[['122999999','123000001',1],['123000001','123999999',0],['122999998','122999999',0],['123','123000001',1],['122','123',0]];
  for(const [start,end,count]of cases){
    // All cases share the same second-wide server envelope. Only the exact
    // local nanosecond bounds change; cached observations follow those bounds.
    const options={...interval,provider_mode:'time_range',interval_start:`2026-09-10T00:00:00.${start}Z`,interval_end:`2026-09-10T00:00:00.${end}Z`};
    const result=await f.context.SparkClawMailReader.listPage(options);
    assert.equal(result.rows.length,count);assert.equal(result.has_next,false);
    assert.equal(f.context.SparkClawMailReader.snapshot(options).rows.length,count);
  }
  const offset={...interval,provider_mode:'time_range',interval_start:'2026-09-10T08:00:00.122999999+08:00',interval_end:'2026-09-10T00:00:00.123000001Z'};
  assert.equal((await f.context.SparkClawMailReader.listPage(offset)).rows.length,1);
  assert.equal(f.context.SparkClawMailReader.snapshot(offset).rows.length,1);
  await assert.rejects(f.context.SparkClawMailReader.listPage({...offset,interval_start:'2026-02-30T00:00:00Z'}),{code:'invalid_request'});
});

import {networkListPage} from '../../applications/mail/lib/network-reader.mjs';
const options={...interval,lane:'recent_inbound',continuation:'',limit:2};
const networkRow=id=>({...row(id),provider_thread_id:'thread-f:10',inbox:true,unread:false});

test('network batches drain individual members before advancing page and only final qualified page can complete',async()=>{
  const tab={runReadCode:async()=>({provider:'gmail',account_address:interval.account_address,page:0,rows:['a','b','c'].map(networkRow),unsupported_rows:0,has_next:true})};
  const first=await networkListPage(tab,'gmail',options,{});
  assert.deepEqual(first.discovery.candidates.map(r=>r.provider_message_id),['a','b']);
  assert.equal(first.discovery.coverage.scan_complete,false);
  const second=await networkListPage(tab,'gmail',{...options,continuation:first.discovery.coverage.continuation},{});
  assert.deepEqual(second.discovery.candidates.map(r=>r.provider_message_id),['c']);
  const cursor=second.discovery.coverage.continuation;
  tab.runReadCode=async code=>code.includes('\"page\":0')?{provider:'gmail',account_address:interval.account_address,page:0,rows:['a','b','c'].map(networkRow),unsupported_rows:0,has_next:true}:({provider:'gmail',account_address:interval.account_address,page:1,rows:[],unsupported_rows:0,has_next:false});
  const last=await networkListPage(tab,'gmail',{...options,continuation:cursor},{});
  assert.equal(last.discovery.status,'empty');
  assert.equal(last.discovery.coverage.boundary_qualified,true);
  assert.equal(last.discovery.coverage.continuation,undefined);
  await assert.rejects(networkListPage(tab,'gmail',{...options,interval_end:'2026-09-12T00:00:00Z',continuation:cursor},{}),{code:'email_cursor_invalid'});
});

test('an unqualified member fences the page instead of allowing a later page to advance the watermark',async()=>{
  const tab={runReadCode:async()=>({provider:'gmail',account_address:interval.account_address,page:0,rows:[networkRow('a')],unsupported_rows:1,has_next:true})};
  const result=await networkListPage(tab,'gmail',options,{});
  const cursor=JSON.parse(Buffer.from(result.discovery.coverage.continuation.slice(3),'base64url'));
  assert.equal(cursor.p,0);assert.equal(cursor.o,0);
  assert.equal(result.discovery.coverage.boundary_qualified,false);
  assert.equal(result.discovery.coverage.reason,'network_rows_unqualified');
});

test('Gmail HTTP paging reuses the observed query and session headers without exporting them',async()=>{
  const f=fixture();f.reader.dispose();
  f.context.structuredClone=structuredClone;f.context.AbortSignal=AbortSignal;
  f.XHR.prototype.setRequestHeader=function(){};
  let request;
  const value=[];value[0]=0;value[3]=0;
  const thread=[];thread[4]=[networkRow('a')];value[19]=[[null,[[thread]]]];
  f.context.fetch=async(url,options)=>{request={url,options};return new Response(JSON.stringify(value));};
  vm.runInContext(`(${installReader.toString()})({provider:'gmail',origins:['https://mail.google.com'],account:()=>account,listURL:u=>u.pathname==='/list',parse:value=>(value[19][0][1]??[]).map(c=>c[0][4][0])});`,f.context);
  const body=[[],null,[777]];body[0][0]=123;body[0][1]=50;body[0][9]=0;body[0][15]=[];
  body[0][3]=`-in:trash -in:spam -in:drafts after:${Math.floor(Date.parse(interval.interval_start)/1000)-1} before:${Math.ceil(Date.parse(interval.interval_end)/1000)}`;
  const xhr=new f.XHR();xhr.open('POST','https://mail.google.com/list');xhr.setRequestHeader('x-framework-xsrf-token','private-fixture');xhr.send(JSON.stringify(body));
  const result=await f.context.SparkClawMailReader.listPage({...interval,page:0});
  const sent=JSON.parse(request.options.body);
  assert.equal(sent[0][9],0);assert.equal(sent[2][0],0);assert.equal(sent[0][3],body[0][3]);
  assert.equal(request.options.headers['x-framework-xsrf-token'],'private-fixture');
  assert.equal(result.has_next,false);assert.equal(result.rows.length,1);
  assert.ok(!JSON.stringify(result).includes('private-fixture'));
  request=null;
  await assert.rejects(f.context.SparkClawMailReader.listPage({...interval,interval_end:'2026-09-12T00:00:00Z'}),{code:'email_network_list_unqualified'});
  assert.equal(request,null);
  value[19]=[[1,null,0,0]];
  const empty=await f.context.SparkClawMailReader.listPage({...interval,page:0});
  assert.equal(empty.rows.length,0);assert.equal(empty.has_next,false);
  value[19]=[[1,null,0]];
  await assert.rejects(f.context.SparkClawMailReader.listPage({...interval,page:0}),{code:'email_network_list_unqualified'});
});

import {installOutlookEarlyBridge} from '../../applications/mail/userscripts/lib/outlook-early-bridge.mjs';
import {installOutlookTransport} from '../../applications/mail/userscripts/lib/outlook-transport.mjs';
import {webcrypto} from 'node:crypto';

test('Outlook Worker replay binds the startup Inbox, validates individual receipts and isolates its RPC callbacks',async()=>{
  const ports=[],sent=[],observed=[];
  class Port { constructor(){this.listeners=[];ports.push(this);}addEventListener(_,fn){this.listeners.push(fn);}removeEventListener(_,fn){this.listeners=this.listeners.filter(v=>v!==fn);}postMessage(value){sent.push(value);} }
  class Channel {constructor(){this.port1=new Port();this.port2=new Port();}}
  let reply={data:{itemRows:{edges:[{node:{ItemId:{Id:'message'},ConversationId:{Id:'thread'},DateTimeReceived:interval.interval_start,IsDraft:false,IsRead:true,ParentFolderId:{Id:'inbox-id'}}}],indexedOffset:1,pageInfo:{hasNextPage:false}}}};
  let propagated=false;
  class Worker {postMessage(message){
    const body=message.argumentList[0].value;
    if(body.requestId<700000000)return;
    observed.push(structuredClone(body.variables));
    queueMicrotask(()=>{const event={data:{id:'reply',type:'APPLY',path:['next'],argumentList:[{type:'RAW',value:body.requestId},{type:'RAW',value:reply}]},stopImmediatePropagation(){this.stopped=true;}};for(const listener of ports[0].listeners){listener(event);if(event.stopped)break;}});
  }}
  const context=vm.createContext({window:{Worker,MessageChannel:Channel},location:{origin:'https://outlook.live.com'},Date,Map,Error,Object,Number,URL,Uint32Array,Uint8Array,TextEncoder,crypto:webcrypto,structuredClone,setTimeout,clearTimeout,
    account:()=>interval.account_address,getInbox:()=>({id:'inbox-id',account:interval.account_address}),receiveRows:rows=>observed.push(rows),originalURL:()=>{}});
  vm.runInContext(`window.top=window;installOutlookEarlyBridge=${installOutlookEarlyBridge.toString()};installOutlookEarlyBridge();channel=new window.MessageChannel();worker=new window.Worker();`,context);
  ports[0].addEventListener('message',()=>{propagated=true;});
  const request=(operationName,folderId)=>({id:'native',type:'APPLY',path:['execute'],argumentList:[{type:'RAW',value:{operationName,requestId:1,context:{},variables:{folderId,mailboxInfo:{mailboxSmtpAddress:interval.account_address},pagingInfo:{},viewFilter:'All',focusedViewFilter:operationName==='ItemRows'?'None':'Focused',sortBy:{isDraftsFolder:true}}}}]});
  context.worker.postMessage(request('ItemRows','drafts-id'));
  context.worker.postMessage(request('ConversationRows','inbox-id'));
  context.worker.postMessage(request('ConversationRows','sent-id'));
  vm.runInContext(`installOutlookOriginalResolver=${installOutlookOriginalResolver.toString()};installOutlookRangeTransport=${installOutlookRangeTransport.toString()};transport=(${installOutlookTransport.toString()})({account,getInbox,receiveRows,originalURL});`,context);
  const result=await context.transport.listPage({...interval,page:0});
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].unread,false);assert.equal(result.has_next,false);
  assert.equal(observed[0].folderId,'inbox-id');assert.equal(observed[0].sortBy.isDraftsFolder,false);
  assert.equal(propagated,false);assert.equal(sent.at(-1).id,'reply');
  reply.data.itemRows.edges[0].node.ParentFolderId.Id='sent-id';
  const wrong=await context.transport.listPage({...interval,page:0});
  assert.equal(wrong.rows.length,0);assert.equal(wrong.unsupported_rows,1);
  context.transport.dispose();context.window.SparkClawOutlookEarlyBridge.dispose();assert.equal(context.window.Worker,Worker);assert.equal(ports[0].listeners.length,1);
});

test('a shifted previously scanned page prevents terminal watermark advancement',async()=>{
  const tab={runReadCode:async()=>({provider:'gmail',account_address:interval.account_address,page:0,rows:[networkRow('a')],unsupported_rows:0,has_next:true})};
  const first=await networkListPage(tab,'gmail',options,{});
  tab.runReadCode=async code=>code.includes('"page":0')?
    {provider:'gmail',account_address:interval.account_address,page:0,rows:[networkRow('changed')],unsupported_rows:0,has_next:true}:
    {provider:'gmail',account_address:interval.account_address,page:1,rows:[],unsupported_rows:0,has_next:false};
  const final=await networkListPage(tab,'gmail',{...options,continuation:first.discovery.coverage.continuation},{});
  assert.equal(final.discovery.coverage.scan_complete,false);
  assert.equal(final.discovery.coverage.reason,'network_page_changed');
  assert.equal(JSON.parse(Buffer.from(final.discovery.coverage.continuation.slice(3),'base64url')).p,0);
});

import {parseGmailReceivedList} from '../../applications/mail/lib/gmail-list.mjs';
test('received network inventory preserves inbound siblings of an alternate-family sent reply',()=>{
  const message=(id,native,sent=false)=>{const m=[];m[0]=native;m[55]=id;m[6]=Date.parse(interval.interval_start);m[10]=sent?['^f']:['^i'];return m;};
  const thread=[];thread[3]='thread-f:10';thread[4]=[message('a','msg-f:10'),message('b','msg-a:r11',true),message('c','msg-f:12')];
  const source=[];source[19]=[[null,[[thread]]]];
  const rows=parseGmailReceivedList(source);
  assert.deepEqual(rows.map(r=>r.provider_message_id),['a','c']);
  assert.deepEqual(rows.map(r=>r.native_message_id),['msg-f:10','msg-f:12']);
  thread[4][2][0]='msg-f:99';
  assert.deepEqual(parseGmailReceivedList(source).map(r=>r.provider_message_id),['a']);
});

test('Outlook Inbox evidence alone never certifies all received folders as complete',async()=>{
  const tab={runReadCode:async()=>({provider:'outlook',account_address:interval.account_address,page:0,rows:[{...networkRow('a'),provider_selection_id:'thread',provider_thread_id:'thread'}],unsupported_rows:0,has_next:false,scope:'inbox_loaded'})};
  const value=await networkListPage(tab,'outlook',options,{});
  assert.equal(value.discovery.status,'partial');assert.equal(value.discovery.coverage.boundary_qualified,false);
  assert.equal(value.discovery.coverage.reason,'folder_scope_and_pagination_unqualified');
  assert.equal(value.discovery.candidates[0].provider_selection_id,'thread');
  assert.equal(value.listed.rows[0].inventory_complete,false);
});

test('Gmail needs the observed response cursor as well as the native page index',async()=>{
  const f=fixture();f.reader.dispose();f.context.structuredClone=structuredClone;f.context.AbortSignal=AbortSignal;f.XHR.prototype.setRequestHeader=function(){};
  const requests=[];
  f.context.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);const value=[];value[0]=0;value[3]=body[0][9]===0?1:0;value[19]=[];
    value[13]=[];value[13][8]=value[13][9]='opaque-native-cursor-fixture';
    return new Response(JSON.stringify(value));
  };
  vm.runInContext(`(${installReader.toString()})({provider:'gmail',origins:['https://mail.google.com'],account:()=>account,listURL:u=>u.pathname==='/list',parse:()=>[]});`,f.context);
  const body=[[],null,[100]];body[0][0]=123;body[0][1]=50;body[0][7]=1000;body[0][9]=0;body[0][15]=[];
  body[0][3]=`-in:trash -in:spam -in:drafts after:${Math.floor(Date.parse(interval.interval_start)/1000)-1} before:${Math.ceil(Date.parse(interval.interval_end)/1000)}`;
  const xhr=new f.XHR();xhr.open('POST','https://mail.google.com/list');xhr.send(JSON.stringify(body));
  await assert.rejects(f.context.SparkClawMailReader.listPage({...interval,page:1}),{code:'email_network_list_unqualified'});
  await f.context.SparkClawMailReader.listPage({...interval,page:0});
  const terminal=await f.context.SparkClawMailReader.listPage({...interval,page:1});
  assert.equal(requests[1][0][9],1);assert.equal(requests[1][0][15][13],'opaque-native-cursor-fixture');
  assert.equal(requests[1][0][7],2000);assert.equal(requests[1][2][0],0);
  assert.equal(terminal.has_next,false);assert.ok(!JSON.stringify(terminal).includes('opaque-native-cursor-fixture'));
});

import {parseOutlookFolders} from '../../applications/mail/userscripts/lib/outlook-folders.mjs';
test('Outlook folder coverage requires a full hierarchy and excludes hidden folders and trash descendants',()=>{
  const folder=(id,kind,parent='root',hidden='false')=>({FolderId:{Id:id},ParentFolderId:{Id:parent},FolderClass:'IPF.Note',DisplayName:id,DistinguishedFolderId:kind,
    ExtendedProperty:[{ExtendedFieldURI:{PropertyTag:'0x10f4',PropertyType:'Boolean'},Value:hidden}]});
  const folders=[folder('inbox','inbox'),folder('archive','archive'),folder('custom',undefined,'archive'),folder('deleted','deleteditems'),folder('trash-child',undefined,'deleted'),folder('hidden',undefined,'root','true')];
  const root={Folders:folders,IncludesLastItemInRange:true,TotalItemsInView:folders.length,ParentFolder:{FolderId:{Id:'root'}}};
  const value={owaUserConfig:{SessionSettings:{UserEmailAddress:interval.account_address}},findConversation:{Body:{FolderId:{Id:'inbox'}}},findFolders:{Body:{ResponseMessages:{Items:[{RootFolder:root}]}}}};
  const parsed=parseOutlookFolders(value);
  assert.equal(parsed.qualified,true);assert.deepEqual(parsed.folders.map(f=>f.id),['inbox','archive','custom']);
  root.IncludesLastItemInRange=false;assert.equal(parseOutlookFolders(value).qualified,false);
  root.IncludesLastItemInRange=true;folders[2].ParentFolderId.Id='missing';assert.equal(parseOutlookFolders(value).qualified,false);
  folders[2].ParentFolderId.Id='archive';folders[2].ExtendedProperty=[];assert.equal(parseOutlookFolders(value).qualified,false);
});

test('Outlook original transport delegates exclusively to its native resolver even after observing ItemExport',async()=>{
  const calls=[],workerMessages=[];
  let consumer,disposed=0,detached=0,rejected=false;
  const nativeURL=new URL('https://attachment.outlook.live.net/owa/observed-route/service.svc/s/DownloadMessage?id=immutable-target&outputFormat=0&token=page-private-fixture');
  const resolver={
    async prepare(target){calls.push(structuredClone(target));if(rejected)throw Object.assign(new Error('email_network_original_unqualified'),{code:'email_network_original_unqualified'});return nativeURL;},
    diagnostics(){return {stage:'native_ready'};},
    dispose(){disposed++;}
  };
  const bridge={attach(value){consumer=value;},detach(value){assert.equal(value,consumer);detached++;}};
  const context=vm.createContext({window:{SparkClawOutlookEarlyBridge:bridge},Map,Error,URL,Date,structuredClone,setTimeout,clearTimeout,
    account:()=>interval.account_address,getInbox:()=>({id:'inbox-id',account:interval.account_address}),receiveRows:()=>{},
    installOutlookOriginalResolver:()=>resolver,
    installOutlookRangeTransport:()=>({arm(){},listPage(){},fetchSearch(){},dispose(){}})
  });
  vm.runInContext(`transport=(${installOutlookTransport.toString()})({account,getInbox,receiveRows});`,context);
  consumer.request({postMessage(value){workerMessages.push(value);}},{id:'native',type:'APPLY',path:['execute'],argumentList:[{value:{operationName:'ItemExport',requestId:1,context:{},variables:{itemId:'observed-other-item',mailboxInfo:{mailboxSmtpAddress:interval.account_address},downloadUrl:'do-not-replay'}}}]});
  const target={account_address:interval.account_address,provider_message_id:'immutable-target'};
  const url=await context.transport.prepareOriginal(target);
  assert.equal(url,nativeURL);assert.deepEqual(calls,[target]);assert.equal(workerMessages.length,0);
  assert.equal(context.transport.diagnostics().templateCount,0);assert.equal(context.transport.diagnostics().original.stage,'native_ready');
  assert.equal(Object.hasOwn(context.transport.diagnostics(),'exportRequest'),false);
  rejected=true;await assert.rejects(context.transport.prepareOriginal(target),{code:'email_network_original_unqualified'});
  assert.equal(workerMessages.length,0);assert.equal(calls.length,2);
  context.transport.dispose();assert.equal(disposed,1);assert.equal(detached,1);
});
