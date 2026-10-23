import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {installReader} from '../../applications/mail/userscripts/lib/reader-core.mjs';
import {gmailOriginalURL} from '../../applications/mail/userscripts/lib/gmail-download.mjs';
import {parseGmailList,parseGmailReceivedList,parseGmailSentList} from '../../applications/mail/lib/gmail-list.mjs';
import {collectUnread} from '../../applications/mail/read.mjs';

const owner='owner@example.test';
const target={account_address:owner,provider_message_id:'abc',provider_selection_id:'thread-f:2748',folder:'sent'};
const interval={account_address:owner,interval_start:'2026-09-10T00:00:00Z',interval_end:'2026-09-11T00:00:00Z'};
const original=Buffer.from('From: owner@example.test\r\nTo: fixture@example.test\r\nSubject: fixture\r\n\r\nExact original.\r\n');
function response(labels=['^f']) {
  const message=[];message[0]='msg-f:2748';message[6]=Date.parse(interval.interval_start);message[10]=labels;message[55]='abc';
  const thread=[];thread[3]=target.provider_selection_id;thread[4]=[message];
  const value=[];value[0]=0;value[3]=0;value[19]=[[null,[[thread]]]];return value;
}
function fixture({value=response(),switchAccount=false,noReply=false}={}) {
  let time=Date.now();const requests=[],queries=[],calls=[];
  class Clock extends Date {static now(){return time;}}
  class XHR {open(){}send(){}addEventListener(_name,callback){this.callback=callback;}}
  const context=vm.createContext({URL,URLSearchParams,Map,Date:Clock,JSON,Object,Number,Error,TextDecoder,Uint8Array,Response,Blob,AbortSignal,AbortController,structuredClone,performance,
    setTimeout(fn,ms){time+=ms;fn();},clearTimeout(){},btoa:value=>Buffer.from(value,'binary').toString('base64'),XMLHttpRequest:XHR,
    MutationObserver:class{observe(){}disconnect(){}},location:{origin:'https://mail.google.com',href:'https://mail.google.com/mail/u/0/'},
    document:{addEventListener(){},removeEventListener(){},body:{append(){}},createElement:()=>({remove(){}})},
    fetch:async(url,init)=>{requests.push({url:String(url),init});return new Response(original);},account:owner,
    parseGmailList,parseGmailReceivedList,parseGmailSentList,gmailOriginalURL,
    search(query){queries.push(query);if(switchAccount)context.account='other@example.test';if(!noReply)deliver(value,query);},
  });
  // gmailOriginalURL reads the page realm's location, as it does in the built asset.
  vm.runInContext(`window=globalThis;window.top=window;gmailOriginalURL=${gmailOriginalURL.toString()};(${installReader.toString()})({provider:'gmail',origins:['https://mail.google.com'],account:()=>account,listURL:u=>/^\\/sync\\/u\\/\\d+\\/i\\/bv$/.test(u.pathname),parse:parseGmailReceivedList,parseSent:parseGmailSentList,search,download:gmailOriginalURL});`,context);
  function deliver(value,query='in:sent') {
    const body=[[],null,[]];body[0][3]=query;body[0][15]=[];
    const xhr=new XHR();xhr.open('POST','https://mail.google.com/sync/u/0/i/bv');xhr.send(JSON.stringify(body));xhr.status=200;xhr.responseText=JSON.stringify(value);xhr.callback();
  }
  const tab={runReadCode:async code=>{calls.push(code);return vm.runInContext('('+code+')',context)({evaluate:(fn,args)=>fn(args)});}};
  return {reader:context.SparkClawMailReader,context,requests,queries,calls,tab,deliver};
}

test('Sent parser preserves native identity without adding Sent or drafts to received scans',()=>{
  const value=response();assert.equal(parseGmailReceivedList(value).length,0);
  const row=parseGmailSentList(value)[0];assert.equal(row.native_message_id,'msg-f:2748');assert.equal(row.folder,'sent');
  assert.equal(row.provider_thread_id,target.provider_selection_id);
  for(const labels of [['^i'],['^f','^r'],['^f',null]])assert.equal(parseGmailSentList(response(labels)).length,0);
  value[19][0][1][0][0][4].push(value[19][0][1][0][0][4][0]);assert.deepEqual(parseGmailSentList(value),[]);
  const wrong=response();wrong[19][0][1][0][0][4][0][0]='msg-f:2749';assert.deepEqual(parseGmailSentList(wrong),[]);
  const mixed=response(),copy=structuredClone(mixed[19][0][1][0]);copy[0][4][0][10]=['^i'];mixed[19][0][1].push(copy);
  assert.deepEqual(parseGmailSentList(mixed),[],'an inbound duplicate cannot silently qualify a Sent ID');
});

test('formal exact Sent read observes one native query, binds selection and downloads exact RFC822 bytes',async t=>{
  const f=fixture();t.after(()=>f.reader.dispose());let selected;
  const result=await collectUnread(f.tab,'gmail',{account_address:owner,folder:'sent',pinned_message_id:target.provider_message_id,pinned_selection_id:target.provider_selection_id,onSelected:async row=>{selected=row;}});
  assert.deepEqual(f.queries,['in:sent']);assert.equal(f.requests.length,1);
  const url=new URL(f.requests[0].url);assert.equal(url.pathname,'/mail/u/0/');assert.equal(url.searchParams.get('th'),'abc');assert.equal(url.searchParams.get('attid'),'0');
  assert.equal(selected.folder,'sent');assert.equal(selected.provider_selection_id,target.provider_selection_id);assert.equal(result.network_original,true);
  assert.equal(createHash('sha256').update(Buffer.from(result.original.inline_base64,'base64')).digest('hex'),createHash('sha256').update(original).digest('hex'));
  assert.equal(f.reader.snapshot(interval).rows.length,0,'Sent never joins the default received snapshot');
  await assert.rejects(f.reader.prepareOriginal({...target,provider_selection_id:'wrong-thread'}),{code:'email_network_target_unobserved'});
  await assert.rejects(f.reader.prepareRetainedOriginal(target),{code:'invalid_request'});
});

test('Sent target must be freshly observed in this round and cannot be supplied by the caller',async t=>{
  const f=fixture();t.after(()=>f.reader.dispose());
  await assert.rejects(f.reader.prepareOriginal(target),{code:'email_network_target_unobserved'});
  f.deliver(response());assert.equal((await f.reader.observeSentTarget(target)).rows.length,1);assert.equal(f.queries.length,0);
  f.reader.resetRound({account_address:owner});
  await assert.rejects(f.reader.prepareOriginal(target),{code:'email_network_target_unobserved'});
  assert.equal((await f.reader.observeSentTarget(target)).rows.length,1);assert.equal(f.queries.length,1);
});

for(const mode of ['inbound','draft','wrong_selection','missing_target','duplicate','wrong_account','no_reply'])test(`Sent capture rejects ${mode} without an original download`,async t=>{
  const value=response(mode==='inbound'?['^i']:mode==='draft'?['^f','^r']:['^f']);
  if(mode==='duplicate')value[19][0][1].push(value[19][0][1][0]);
  const f=fixture({value,switchAccount:mode==='wrong_account',noReply:mode==='no_reply'});t.after(()=>f.reader.dispose());
  const request={...target,...(mode==='wrong_selection'?{provider_selection_id:'thread-f:2749'}:mode==='missing_target'?{provider_message_id:'abd'}:{})};
  await assert.rejects(f.reader.observeSentTarget(request),{code:mode==='wrong_account'?'email_account_identity_mismatch':mode==='no_reply'?'email_network_list_unqualified':'email_network_target_unobserved'});
  assert.equal(f.requests.length,0);assert.equal(f.queries.length,1);
});

test('unsupported provider Sent does not fall through to an inbound scan',async t=>{
  const f=fixture();t.after(()=>f.reader.dispose());
  const tab={runReadCode:async code=>code.includes('"method":"snapshot"')?{provider:'outlook',account_address:owner,rows:[],unsupported_rows:0,scan_complete:false}:assert.fail('no inbound or original request')};
  await assert.rejects(collectUnread(tab,'outlook',{account_address:owner,folder:'sent',pinned_message_id:'native-item',pinned_selection_id:'native-conversation',onSelected:async()=>assert.fail('no selection')}),{code:'email_network_capability_unavailable'});
});
