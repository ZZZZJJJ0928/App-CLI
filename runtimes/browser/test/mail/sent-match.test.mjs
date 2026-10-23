import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {sentMatchQuery} from '../../applications/mail/lib/sent-match.mjs';
import {validateCaptureInput} from '../../applications/mail/lib/read-capture.mjs';
import {inputSchema} from '../../applications/mail/input-schema.mjs';
import {compileSchema} from '../../src/protocol.mjs';
import {installReader} from '../../applications/mail/userscripts/lib/reader-core.mjs';
import {gmailOriginalURL} from '../../applications/mail/userscripts/lib/gmail-download.mjs';
import {parseGmailList,parseGmailReceivedList,parseGmailSentList} from '../../applications/mail/lib/gmail-list.mjs';
import {readGmail,collectUnread} from '../../applications/mail/read.mjs';

const owner='owner@example.test';
const match={folder:'sent',subject:'[验收] 常规汇报 - (三): 进度',recipient:'recipient+fixture@example.test',
  interval_start:'2026-09-10T00:00:00Z',interval_end:'2026-09-11T00:00:00Z'};
const input={schema_version:1,operation:'read',provider:'gmail',account:'default',owner_scope:'a'.repeat(64),
  invocation_id:'sent-match-fixture',account_address:owner,sent_match:match};
const original=Buffer.from('From: owner@example.test\r\nTo: recipient+fixture@example.test\r\nSubject: synthetic original\r\nDate: Thu, 10 Sep 2026 12:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nExact synthetic RFC822.\r\n');
const sha=value=>createHash('sha256').update(value).digest('hex');
function response(labels=['^f']) {
  const message=[];message[0]='msg-f:2748';message[6]=Date.parse(match.interval_start);message[10]=labels;message[55]='abc';
  const thread=[];thread[3]='thread-f:2748';thread[4]=[message];
  const value=[];value[0]=0;value[3]=0;value[19]=[[null,[[thread]]]];return value;
}
function fixture({value=response(),mode,transport='xhr'}={}) {
  let time=Date.now(),staleComplete,resolveStaleFetch;const requests=[],queries=[];
  class Clock extends Date {static now(){return time;}}
  class XHR {open(){}send(){}addEventListener(_name,callback){this.callback=callback;}}
  const context=vm.createContext({URL,URLSearchParams,Map,Date:Clock,JSON,Object,Number,Error,TextEncoder,TextDecoder,Uint8Array,Response,Blob,AbortSignal,AbortController,structuredClone,performance,
    setTimeout(fn,ms){time+=ms;fn();},clearTimeout(){},btoa:value=>Buffer.from(value,'binary').toString('base64'),XMLHttpRequest:XHR,
    MutationObserver:class{observe(){}disconnect(){}},location:{origin:'https://mail.google.com',href:'https://mail.google.com/mail/u/0/'},
    document:{addEventListener(){},removeEventListener(){},body:{append(){}},createElement:()=>({remove(){}})},
    fetch:async(url,init)=>{
      if(String(url).includes('/sync/')) {
        const reply=new Response(JSON.stringify(value));Object.defineProperty(reply,'url',{value:String(url)});
        if(mode==='stale_same_query')return new Promise(resolve=>{resolveStaleFetch=()=>resolve(reply);});
        return reply;
      }
      requests.push({url:String(url),init});return new Response(original);
    },account:owner,
    parseGmailList,parseGmailReceivedList,parseGmailSentList,sentMatchQuery,gmailOriginalURL,
    search(query){
      queries.push(query);
      if(mode==='stale_same_query'){staleComplete();return;}
      if(mode==='account_switch')context.account='other@example.test';
      if(mode==='disposed'){context.SparkClawMailReader.dispose();return;}
      if(mode!=='no_reply')deliver(value,mode==='wrong_query'?'in:sent':query);
    },
  });
  vm.runInContext(`window=globalThis;window.top=window;gmailOriginalURL=${gmailOriginalURL.toString()};(${installReader.toString()})({provider:'gmail',origins:['https://mail.google.com'],account:()=>account,listURL:u=>/^\\/sync\\/u\\/\\d+\\/i\\/bv$/.test(u.pathname),parse:parseGmailReceivedList,parseSent:parseGmailSentList,sentMatchQuery,search,download:gmailOriginalURL});`,context);
  function deliver(value,query) {
    const body=[[],null,[]];body[0][3]=query;body[0][15]=[];
    body[0][9]=mode==='continuation_reply'?1:0;body[0][15][13]=['continuation_reply','cursor_reply'].includes(mode)?'opaque-continuation':null;
    if(transport==='fetch') {
      void context.fetch('https://mail.google.com/sync/u/0/i/bv',{method:'POST',body:JSON.stringify(body)});
      return ()=>resolveStaleFetch();
    }
    const xhr=new XHR();xhr.open('POST','https://mail.google.com/sync/u/0/i/bv');xhr.send(JSON.stringify(body));xhr.status=200;xhr.responseText=JSON.stringify(value);if(mode==='stale_same_query'&&!staleComplete)return ()=>xhr.callback();xhr.callback();
  }
  if(mode==='stale_same_query')staleComplete=deliver(value,sentMatchQuery(match));
  const tab={runReadCode:async code=>vm.runInContext('('+code+')',context)({evaluate:(fn,args)=>fn(args)})};
  return {reader:context.SparkClawMailReader,context,requests,queries,tab,deliver};
}

test('typed query preserves ordinary subject literals and exact interval bounds',()=>{
  const query=sentMatchQuery(match);
  assert.equal(query,`in:sent to:"${match.recipient}" subject:"${match.subject}" after:1788998399 before:1789084800`);
  assert.equal(decodeURIComponent(encodeURIComponent(query)),query);
  assert.ok(sentMatchQuery({...match,subject:'  subject: (in:inbox) [中文] - A & B  '}).includes('subject:"  subject: (in:inbox) [中文] - A & B  "'));
  assert.doesNotThrow(()=>sentMatchQuery({...match,subject:'中'.repeat(170)}));
  assert.throws(()=>sentMatchQuery({...match,subject:'中'.repeat(171)}),{code:'invalid_request'});
  for(const change of [{subject:''},{subject:'bad" in:inbox'},{subject:'bad\\escape'},{subject:'bad\nline'},
    {subject:'bad\tline'},{subject:'bad\u007fline'},{recipient:'a@example.test in:anywhere'},
    {recipient:'Name <a@example.test>'},{recipient:'a..b@example.test'},{recipient:'.a@example.test'},
    {recipient:'a.@example.test'},{recipient:'a'.repeat(65)+'@example.test'},
    {interval_start:'2026-02-30T00:00:00Z'},{interval_start:'2026-09-10T00:00:00.000Z'},
    {interval_start:'2026-09-10T00:00:00+00:00'},{interval_end:match.interval_start},
    {interval_end:'2026-09-11T00:00:01Z'},{folder:'inbox'},{query:'in:anywhere'}]) {
    assert.throws(()=>sentMatchQuery({...match,...change}),{code:'invalid_request'});
  }
});

test('private read input requires both runtime account and closed selector; legacy input remains exact',()=>{
  const validate=compileSchema(inputSchema('gmail','read'));
  assert.equal(validate(input),true);assert.doesNotThrow(()=>validateCaptureInput(input,'gmail'));
  const legacy={...input};delete legacy.sent_match;delete legacy.account_address;
  assert.equal(validate(legacy),true);assert.doesNotThrow(()=>validateCaptureInput(legacy,'gmail'));
  for(const invalid of [{...input,account_address:undefined},{...input,sent_match:undefined},
    {...input,sent_match:{...match,account_address:owner}},{...input,target:{}}])assert.equal(validate(invalid),false);
  assert.equal(compileSchema(inputSchema('outlook','read'))({...input,provider:'outlook'}),false);
  assert.throws(()=>validateCaptureInput({...input,provider:'outlook'},'outlook'),{code:'email_network_capability_unavailable'});
});

test('one owned callback observes one terminal Sent member and writes exact original plus selector manifest',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mail-sent-match-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const f=fixture();t.after(()=>f.reader.dispose());let callbacks=0;
  const runtime={emailWorkspaceRoot:root,withReadTab:async callback=>{callbacks++;return callback(f.tab);}};
  const receipt=await readGmail(input,runtime);
  assert.equal(receipt.status,'collected');assert.equal(callbacks,1);assert.deepEqual(f.queries,[sentMatchQuery(match)]);
  assert.equal(f.requests.length,1);assert.equal(new URL(f.requests[0].url).searchParams.get('th'),'abc');
  const manifest=JSON.parse(await fs.readFile(path.join(root,receipt.capture.manifest_path)));
  assert.deepEqual(manifest.sent_match,match);assert.equal(manifest.folder,'sent');assert.equal(manifest.provider,'gmail');
  assert.equal(manifest.invocation_id,input.invocation_id);assert.equal(manifest.account_address,owner);
  assert.equal(manifest.provider_message_id,'abc');assert.equal(manifest.provider_selection_id,'thread-f:2748');assert.equal(manifest.provider_native_id,'msg-f:2748');
  const ref=manifest.files.find(file=>file.path.endsWith('message.eml'));
  assert.ok(ref);assert.equal(ref.sha256,'sha256:'+sha(original));
  assert.deepEqual(await fs.readFile(path.join(root,ref.path)),original);
  assert.deepEqual(await readGmail(structuredClone(input),runtime),receipt);
  assert.equal(callbacks,1,'durable replay does not issue a second query or download');
  for(const changed of [{...input,sent_match:{...match,subject:'another subject'}},
    {...input,account_address:'other@example.test'},Object.fromEntries(Object.entries(input).filter(([key])=>!['sent_match','account_address'].includes(key)))]) {
    await assert.rejects(readGmail(changed,runtime),{code:'email_capture_invalid'});
  }
  assert.equal(f.reader.snapshot({account_address:owner,interval_start:match.interval_start,interval_end:match.interval_end}).rows.length,0);
  const journalDirectory=path.join(root,'email',input.owner_scope,'invocations');
  const journalFile=path.join(journalDirectory,(await fs.readdir(journalDirectory))[0]);
  const journal=JSON.parse(await fs.readFile(journalFile));journal.receipt=null;
  await fs.writeFile(journalFile,JSON.stringify(journal));
  manifest.sent_match.subject='different recovery selector';
  await fs.writeFile(path.join(root,receipt.capture.manifest_path),JSON.stringify(manifest));
  await assert.rejects(readGmail(input,runtime),{code:'email_capture_invalid'});
  assert.equal(callbacks,1,'crash recovery cannot adopt an original under a different selector');
});

for(const mode of ['continuation_reply','cursor_reply','stale_same_query','partial','inbound','draft','empty','two_sent','duplicate','bad_id','bad_labels','malformed_batch','wrong_query','no_reply','account_switch','disposed']) {
  test(`bounded Sent resolution rejects ${mode} without selecting or downloading an original`,async t=>{
    const value=response(mode==='inbound'?['^i']:mode==='draft'?['^f','^r']:['^f']);
    if(mode==='partial')value[3]=1;
    if(mode==='empty')value[19]=[[null,null,null,null]];
    if(mode==='two_sent') {
      const second=structuredClone(value[19][0][1][0]);second[0][3]='thread-f:2749';second[0][4][0][0]='msg-f:2749';second[0][4][0][55]='abd';value[19][0][1].push(second);
    }
    if(mode==='duplicate')value[19][0][1].push(value[19][0][1][0]);
    if(mode==='bad_id')value[19][0][1][0][0][4][0][0]='msg-f:2749';
    if(mode==='bad_labels')value[19][0][1][0][0][4][0][10]=['^f',null];
    if(mode==='malformed_batch')value[19].push([null,'unqualified']);
    const f=fixture({value,mode});t.after(()=>f.reader.dispose());
    const code=mode==='account_switch'?'email_account_identity_mismatch':
      ['inbound','draft','empty','two_sent'].includes(mode)?'email_network_target_unobserved':'email_network_list_unqualified';
    await assert.rejects(collectUnread(f.tab,'gmail',{account_address:owner,sent_match:match,onSelected:()=>assert.fail('no selection before qualification')}),{code});
    assert.equal(f.requests.length,0);assert.equal(f.queries.length,1);
    if(mode!=='disposed'&&mode!=='account_switch')await assert.rejects(f.reader.prepareOriginal({account_address:owner,folder:'sent',provider_message_id:'abc',provider_selection_id:'thread-f:2748'}),{code:'email_network_target_unobserved'});
  });
}

test('a native thread qualifies its sole Sent member, never the first inbound sibling',async t=>{
  const value=response(),messages=value[19][0][1][0][0][4];
  const inbound=structuredClone(messages[0]);inbound[0]='msg-f:2749';inbound[55]='abd';inbound[10]=['^i'];messages.unshift(inbound);
  const f=fixture({value});t.after(()=>f.reader.dispose());
  const result=await collectUnread(f.tab,'gmail',{account_address:owner,sent_match:match,onSelected:row=>assert.equal(row.provider_message_id,'abc')});
  assert.equal(result.provider_message_id,'abc');assert.equal(f.requests.length,1);
  assert.equal(new URL(f.requests[0].url).searchParams.get('th'),'abc');
});

test('fresh terminal query ignores prior matching records and cannot reuse a watch-style snapshot',async t=>{
  const f=fixture({mode:'wrong_query'});t.after(()=>f.reader.dispose());
  f.deliver(response(),sentMatchQuery(match));
  await assert.rejects(f.reader.resolveSentMatch({account_address:owner,sent_match:match}),{code:'email_network_list_unqualified'});
  assert.equal(f.queries.length,1);assert.equal(f.requests.length,0);
});

test('unsupported Sent provider and stale pinned identity cannot fall back to inbound selection',async t=>{
  const f=fixture();t.after(()=>f.reader.dispose());
  await assert.rejects(collectUnread(f.tab,'outlook',{account_address:owner,sent_match:match,onSelected:()=>assert.fail()}),{code:'email_network_capability_unavailable'});
  assert.equal(f.queries.length,0);
  await assert.rejects(collectUnread(f.tab,'gmail',{account_address:owner,sent_match:match,pinned_message_id:'abd',onSelected:()=>assert.fail()}),{code:'email_message_identity_invalid'});
  assert.equal(f.requests.length,0);
});

for(const mode of [undefined,'continuation_reply','cursor_reply','stale_same_query']) {
  test(`fetch query request is bound to this round and first page: ${mode??'valid'}`,async t=>{
    const f=fixture({mode,transport:'fetch'});t.after(()=>f.reader.dispose());let selections=0;
    const run=()=>collectUnread(f.tab,'gmail',{account_address:owner,sent_match:match,onSelected:()=>{selections++;}});
    if(mode)await assert.rejects(run(),{code:'email_network_list_unqualified'});
    else assert.equal((await run()).provider_message_id,'abc');
    assert.equal(f.queries.length,1);assert.equal(selections,mode?0:1);assert.equal(f.requests.length,mode?0:1);
  });
}
