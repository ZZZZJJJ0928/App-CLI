import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import {providerAccountDOM} from '../../applications/mail/lib/provider-account.mjs';
import {discoverEmail} from '../../applications/mail/read.mjs';
import {verifySendAccount} from '../../applications/mail/lib/managed-send.mjs';
import {probeGmailLogin} from '../../applications/mail/gmail-login-probe.mjs';

const selector='header a[role="button"][href], [role="banner"] a[role="button"][href], #gb a[role="button"][href]';
const owner='owner@example.test';
const labels=['Google Account: Owner (owner@example.test)','Google 账号：Owner\n(owner@example.test)','Google 帳戶：Owner (owner@example.test)','Compte Google : Owner (owner@example.test)','Google-Konto: Owner (owner@example.test)','Google アカウント: Owner (owner@example.test)'];
const source=await fs.readFile(new URL('../../assets/mail/gmail-mail-reader.user.js',import.meta.url),'utf8');
function element(label=labels[0],extra={}) {
  const node={attrs:{href:'https://accounts.google.com/SignOutOptions?hl=zh-CN&service=mail','aria-label':label,...extra},
    isConnected:true,hidden:false,inert:false,parentElement:null,style:{display:'block',visibility:'visible',opacity:'1'},
    getAttribute(name){return this.attrs[name]??null;},getBoundingClientRect(){return {width:40,height:40};}};
  return node;
}
function fixture(nodes=[element()],url='https://mail.google.com/mail/u/0/#inbox') {
  const f={nodes,queries:[],requests:0};
  class XHR {open(){} send(){} setRequestHeader(){} addEventListener(){}}
  const document={querySelectorAll(value){f.queries.push(value);assert.equal(value,selector,'identity must stay inside the account trigger, never message content');return f.nodes;},
    addEventListener(){},removeEventListener(){}};
  const context=vm.createContext({URL,URLSearchParams,Map,Date,JSON,Object,Number,Error,AbortSignal,AbortController,setTimeout,clearTimeout,crypto:webcrypto,TextEncoder,
    document,location:new URL(url),getComputedStyle:n=>n.style,XMLHttpRequest:XHR,
    GLOBALS:[null,null,null,null,null,null,null,null,null,null,'untrusted-startup@example.test'],
    fetch(){f.requests++;throw new Error('identity must not fetch');}});
  vm.runInContext('window=globalThis;window.top=window;',context);
  f.context=context;
  f.direct=()=>vm.runInContext(`(${providerAccountDOM.toString()})('gmail')`,context).account_address;
  f.reader=()=>{vm.runInContext(source,context);return context.SparkClawMailReader;};
  return f;
}
const interval={interval_start:'2026-10-20T00:00:00Z',interval_end:'2026-10-21T00:00:00Z'};
for(const label of labels)test(`current Gmail account uses a trusted trigger independently of label language: ${label.split(/[:：]/)[0]}`,()=>{
  const f=fixture([element(label)]);assert.equal(f.direct(),owner);
  const reader=f.reader(),value=reader.snapshot(interval);
  assert.equal(value.account_address,owner);assert.equal(value.delivery_address,owner);
  assert.deepEqual(Array.from(value.account_aliases),[owner]);assert.equal(f.requests,0);reader.dispose();
});

test('Gmail trigger evidence is normalized, bounded, and consistent across attributes',()=>{
  const n=element('Google 账号：Owner (OWNER@example.test)',{title:'owner@example.test','data-email':owner});
  const f=fixture([n]);assert.equal(f.direct(),owner);
  n.attrs['aria-label']='Google 账号';assert.equal(f.direct(),owner);
  n.attrs.title='';assert.equal(f.direct(),owner);
  n.attrs['data-email']='';assert.equal(f.direct(),'');
});

for(const [name,change] of [
  ['missing current trigger',f=>{f.nodes=[];}],
  ['multiple visible current triggers',f=>{f.nodes.push(element('Other (other@example.test)'));}],
  ['duplicate visible triggers for same account',f=>{f.nodes.push(element());}],
  ['several accounts in one label',f=>{f.nodes[0].attrs['aria-label']='Owner owner@example.test other@example.test';}],
  ['conflicting title',f=>{f.nodes[0].attrs.title='other@example.test';}],
  ['conflicting data-email',f=>{f.nodes[0].attrs['data-email']='other@example.test';}],
  ['hidden current trigger',f=>{f.nodes[0].hidden=true;}],
  ['detached current trigger',f=>{f.nodes[0].isConnected=false;}],
  ['transparent current trigger',f=>{f.nodes[0].style.opacity='0';}],
  ['hidden ancestor',f=>{f.nodes[0].parentElement=element();f.nodes[0].parentElement.style.display='none';}],
  ['aria-hidden ancestor',f=>{f.nodes[0].parentElement=element('',{'aria-hidden':'true'});}],
  ['account chooser destination',f=>{f.nodes[0].attrs.href='https://accounts.google.com/AccountChooser';}],
  ['foreign account destination',f=>{f.nodes[0].attrs.href='https://accounts.google.com.evil.test/SignOutOptions';}],
  ['credential-bearing destination',f=>{f.nodes[0].attrs.href='https://owner@accounts.google.com/SignOutOptions';}],
  ['oversized label',f=>{f.nodes[0].attrs['aria-label']='x'.repeat(1025)+owner;}],
])test(`Gmail fails closed for ${name}, without falling back to native globals or mail data`,()=>{
  const f=fixture();change(f);assert.equal(f.direct(),'');
  const reader=f.reader();assert.throws(()=>reader.snapshot(interval),{code:'email_account_identity_unavailable'});
  assert.equal(f.requests,0);reader.dispose();
});

test('Gmail ignores a hidden stale account trigger when exactly one current visible trigger remains',()=>{
  const stale=element('Stale stale@example.test');stale.style.visibility='hidden';
  const f=fixture([stale,element(labels[1])]);assert.equal(f.direct(),owner);
});

test('Gmail native send identity rejects foreign origins and non-mail routes',()=>{
  for(const url of ['https://accounts.google.com/mail/u/0/','https://mail.google.com.evil.test/mail/u/0/','https://mail.google.com/','https://user@mail.google.com/mail/u/0/']) {
    assert.equal(fixture([element()],url).direct(),'');
  }
});

test('generated Gmail Reader keeps expected-account checks and never repins after a visible account switch',()=>{
  const f=fixture([element(labels[1])]),reader=f.reader();
  assert.equal(reader.snapshot({...interval,account_address:owner}).account_address,owner);
  assert.throws(()=>reader.checkAccount({account_address:'other@example.test'}),{code:'email_account_identity_mismatch'});
  f.nodes[0].attrs['aria-label']='Google 账号：Other (other@example.test)';
  assert.throws(()=>reader.snapshot(interval),{code:'email_account_identity_mismatch'});
  assert.throws(()=>reader.resetRound({account_address:'other@example.test'}),{code:'email_account_identity_mismatch'});
  assert.equal(f.requests,0);reader.dispose();
});

test('bootstrap discover uses the generated Gmail Reader with a localized current identity and zero network effects',async()=>{
  const f=fixture([element(labels[1])]),reader=f.reader();
  const tab={runReadCode:async code=>{
    const page={evaluate:async(fn,arg)=>{f.context.readerArgument=arg;return vm.runInContext(`(${fn.toString()})(readerArgument)`,f.context);}};
    return Function('page',`return (${code})(page)`)(page);
  }};
  const result=await discoverEmail({schema_version:1,operation:'discover',provider:'gmail',account:'default',invocation_id:'gmail-localized-discovery',owner_scope:'a'.repeat(64)},
    {withReadTab:fn=>fn(tab)},'gmail');
  assert.equal(result.status,'partial');assert.equal(result.account_address,owner);assert.equal(result.delivery_address,owner);
  assert.deepEqual(Array.from(result.account_aliases),[owner]);assert.equal(f.requests,0);reader.dispose();
});

for(const managed of [false,true])test(`native send account guard uses localized Gmail identity (${managed?'Reader':'DOM fallback'}) before any draft or send action`,async()=>{
  const f=fixture([element(labels[1])]),reader=managed?f.reader():null;
  const tab={inspect:async expression=>({origin:f.context.location.href,result:await vm.runInContext(`(${expression})()`,f.context)}),
    click(){assert.fail('account identity must never click');},press(){assert.fail('account identity must never open menus');}};
  await verifySendAccount(tab,'gmail',owner);
  await assert.rejects(verifySendAccount(tab,'gmail','other@example.test'),{code:'email_account_identity_mismatch'});
  assert.equal(f.requests,0);reader?.dispose();
});

for(const label of labels.slice(0,2))test(`login probe preserves compose readiness and optional account hint: ${label.split(/[:：]/)[0]}`,async()=>{
  const f=fixture([element(label)]);let closed=0,disposed=0;
  f.context.document.querySelectorAll=value=>{
    if(value==='[aria-label^="Google Account:"]')return label.startsWith('Google Account:')?f.nodes:[];
    assert.equal(value,'[role="button"][gh="cm"]');return [element()];
  };
  const result=await probeGmailLogin({schema_version:1,operation:'probe',invocation_id:'localized-probe',provider:'gmail',account:'default'},
    {createOwnedTab:async()=>({open:async()=>{},inspect:async expression=>({origin:f.context.location.href,result:await vm.runInContext(expression,f.context)}),
      closeOwnedTab:async()=>{closed++;},dispose:async()=>{disposed++;}})});
  assert.equal(result.status,'ready');
  assert.equal(result.account_hint,label.startsWith('Google Account:')?'ow***@example.test':undefined);
  assert.equal(closed,1);assert.equal(disposed,1);assert.equal(f.requests,0);
});
