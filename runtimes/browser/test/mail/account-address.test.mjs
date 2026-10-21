import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installOutlookAccountIdentity} from '../../applications/mail/userscripts/lib/outlook-account.mjs';
import {installReader} from '../../applications/mail/userscripts/lib/reader-core.mjs';
import {accountAddressMetadata} from '../../applications/mail/lib/account-address.mjs';
import {discoverEmail,collectEmailPage} from '../../applications/mail/read.mjs';
import {networkListPage} from '../../applications/mail/lib/network-reader.mjs';
import {outputSchema} from '../../applications/mail/output-schema.mjs';

const identity='outlook_abcd@outlook.com', delivery='owner@example.test';
const interval={account_address:identity,interval_start:'2026-10-21T00:00:00Z',interval_end:'2026-10-22T00:00:00Z',lane:'recent_inbound',limit:50,continuation:''};
function fixture() {
  const f={info:{type:'UserMailbox',mailboxSmtpAddress:identity},config:{SessionSettings:{UserEmailAddress:identity,UserProxyAddresses:[delivery,identity]}},from:{MailboxType:'Mailbox',RoutingType:'SMTP',EmailAddress:delivery},aliases:[delivery],registrations:0,fromCalls:0,missing:0};
  const require=id=>{
    if(id===f.missing)throw new Error('native version unavailable');
    return {
      129387:{A:()=>f.info},859741:{C:info=>{assert.equal(info,f.info);return f.config;}},
      107357:{A:info=>{assert.equal(info,f.info);f.fromCalls++;f.onFrom?.();return f.from;}},
      871008:{Ay:(info,...flags)=>{assert.equal(info,f.info);assert.deepEqual(flags,[false,false,false]);return f.aliases;}},
      791573:{A:value=>f.invalidFilter?undefined:value.toLowerCase()===identity||value.endsWith('@shadow.outlook.com')},
    }[id];
  };
  const webpack=[];webpack.push=entry=>{f.registrations++;assert.deepEqual(Object.keys(entry[1]),[]);entry[2](require);};
  class XHR {open(){}send(){}setRequestHeader(){}}
  const context=vm.createContext({crypto:webcrypto,URL,URLSearchParams,setTimeout,clearTimeout,XMLHttpRequest:XHR,
    location:{origin:'https://outlook.live.com',href:'https://outlook.live.com/mail/0/inbox'},webpackChunkOwa:webpack,
    fetch(){throw new Error('address resolution must not make a request');},document:{querySelector(){return null;}},
    originalFrom:'unrelated-message-sender@example.test',owner:identity,onList:()=>f.onList?.()});
  vm.runInContext('window=globalThis;window.top=window;',context);
  f.context=context;f.resolve=vm.runInContext(`(${installOutlookAccountIdentity.toString()})()`,context);
  f.reader=()=>vm.runInContext(`(${installReader.toString()})({provider:'outlook',origins:['https://outlook.live.com'],account:()=>owner,accountIdentity:${installOutlookAccountIdentity.toString()},listURL:()=>false,parse:()=>[],
    installTransport:()=>({armRangeSearch:()=>({query:'fixture'}),dispose(){},async listPage(){onList();return {provider:'outlook',account_address:owner,page:0,rows:[],unsupported_rows:0,has_next:false,scope:'inbound_received'};}})});window.SparkClawMailReader`,context);
  return f;
}
const plain=value=>JSON.parse(JSON.stringify(value));
test('Outlook separates internal account identity from native SMTP delivery and aliases without mail-header inference',()=>{
  const f=fixture(),reader=f.reader(),result=reader.snapshot(interval);
  assert.equal(result.account_address,identity);
  assert.equal(result.delivery_address,delivery);
  assert.deepEqual(plain(result.account_aliases),[delivery]);
  assert.equal(result.rows.length,0);
  assert.equal(reader.checkAccount({account_address:identity}),true);
  assert.throws(()=>reader.checkAccount({account_address:delivery}),{code:'email_account_identity_mismatch'});
  assert.equal(f.fromCalls,1);reader.dispose();
});

test('Outlook current configuration is re-read; aliases cannot survive account switches or native getter changes',()=>{
  const f=fixture();assert.equal(f.resolve(identity).delivery_address,delivery);
  f.config.SessionSettings.UserEmailAddress='other@example.test';
  assert.deepEqual(plain(f.resolve(identity)),{});
  f.config.SessionSettings.UserEmailAddress=identity;
  f.onFrom=()=>{f.info={...f.info};};
  assert.deepEqual(plain(f.resolve(identity)),{});assert.equal(f.registrations,1);
});

for(const [name,change] of [
  ['other origin',f=>{f.context.location.origin='https://untrusted.invalid';}],
  ['missing native module',f=>{f.missing=107357;}],
  ['missing webpack',f=>{delete f.context.webpackChunkOwa;}],
  ['shared mailbox',f=>{f.info.type='SharedMailbox';}],
  ['explicit logon',f=>{f.config.SessionSettings.IsExplicitLogon=true;}],
  ['cross-account default',f=>{f.from.EmailAddress='other@example.test';}],
  ['cross-account alias',f=>{f.aliases.push('other@example.test');}],
  ['internal-only identity',f=>{f.from.EmailAddress=identity;f.aliases=[identity];}],
  ['default missing from native aliases',f=>{f.aliases=[];}],
  ['non-SMTP default',f=>{f.from.RoutingType='EX';}],
  ['unqualified internal-address filter',f=>{f.invalidFilter=true;}],
  ['malformed proxy',f=>{f.config.SessionSettings.UserProxyAddresses.push('bad\r\naddress@example.test');}],
  ['unbounded proxies',f=>{f.config.SessionSettings.UserProxyAddresses=Array(101).fill(delivery);}],
])test(`Outlook omits unqualified delivery metadata: ${name}`,()=>{
  const f=fixture();change(f);assert.deepEqual(plain(f.resolve(identity)),{});
});

test('Outlook case normalization and alias deduplication preserve native selection',()=>{
  const f=fixture();f.aliases=[delivery.toUpperCase(),delivery];f.from.EmailAddress=delivery.toUpperCase();
  assert.deepEqual(plain(f.resolve(identity)),{delivery_address:delivery,account_aliases:[delivery]});
});

test('Outlook accepts bounded native observable arrays without following their iterator',()=>{
  const f=fixture();f.config.SessionSettings.UserProxyAddresses={0:delivery,1:identity,length:2,[Symbol.iterator](){throw new Error('not used');}};
  f.aliases={0:delivery,length:1};
  assert.deepEqual(plain(f.resolve(identity)),{delivery_address:delivery,account_aliases:[delivery]});
  f.config.SessionSettings.UserProxyAddresses.length=Infinity;assert.deepEqual(plain(f.resolve(identity)),{});
});

for(const provider of ['qq_mail','gmail'])test(`${provider} exports the validated account as its delivery identity`,()=>{
  const f=fixture();f.context.location.origin=provider==='gmail'?'https://mail.google.com':'https://wx.mail.qq.com';
  const reader=vm.runInContext(`(${installReader.toString()})({provider:${JSON.stringify(provider)},origins:[location.origin],account:()=>owner,listURL:()=>false,parse:()=>[]});window.SparkClawMailReader`,f.context);
  const value=reader.snapshot(interval);assert.equal(value.delivery_address,identity);assert.deepEqual(plain(value.account_aliases),[identity]);reader.dispose();
});

function tabFor(reader){return {runReadCode:async code=>{const page={locator:()=>({fill:async()=>{},press:async()=>{}}),evaluate:async(fn,arg)=>{const previous=globalThis.window;globalThis.window={SparkClawMailReader:reader};try{return await fn(arg);}finally{globalThis.window=previous;}}};return Function('page',`return (${code})(page)`)(page);}};}
for(const ranged of [false,true])test(`discovery preserves stable identity and delivery metadata (${ranged?'range':'bootstrap'})`,async()=>{
  const f=fixture(),reader=f.reader();
  const input={schema_version:1,operation:'discover',provider:'outlook',account:'default',invocation_id:'identity-test',owner_scope:'a'.repeat(64),...(ranged?{discovery:interval}:{})};
  const result=await discoverEmail(input,{withReadTab:fn=>fn(tabFor(reader))},'outlook');
  assert.equal(result.account_address,identity);assert.equal(result.delivery_address,delivery);assert.deepEqual(plain(result.account_aliases),[delivery]);reader.dispose();
});

test('range delivery metadata is observed after the list request, never replayed from an earlier snapshot',async()=>{
  const f=fixture(),reader=f.reader(),observed=reader.snapshot(interval);
  f.onList=()=>{f.missing=107357;};
  const value=await networkListPage(tabFor(reader),'outlook',interval,observed);
  assert.equal(observed.delivery_address,delivery);
  assert.ok(!Object.hasOwn(value.discovery,'delivery_address'));reader.dispose();
});

test('production collect_page embeds observed delivery metadata only inside discovery',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mail-address-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const f=fixture(),reader=f.reader();t.after(()=>reader.dispose());
  const input={schema_version:1,operation:'collect_page',provider:'outlook',account:'default',owner_scope:'a'.repeat(64),invocation_id:`email_changes_${'c'.repeat(64)}_r1`,discovery:{...interval,provider_mode:'time_range'}};
  const value=await collectEmailPage(input,{emailWorkspaceRoot:root,withReadTab:fn=>fn(tabFor(reader))},'outlook');
  assert.equal(value.account_address,identity);assert.equal(value.discovery.account_address,identity);assert.equal(value.discovery.delivery_address,delivery);
  assert.deepEqual(plain(value.discovery.account_aliases),[delivery]);assert.ok(!Object.hasOwn(value,'delivery_address'));
});

test('discovery does not promote a missing Outlook address to its internal identity',async()=>{
  const f=fixture();f.missing=107357;const reader=f.reader();
  const result=await discoverEmail({schema_version:1,operation:'discover',provider:'outlook',account:'default',invocation_id:'identity-test',owner_scope:'a'.repeat(64)},{withReadTab:fn=>fn(tabFor(reader))},'outlook');
  assert.equal(result.account_address,identity);assert.ok(!Object.hasOwn(result,'delivery_address'));reader.dispose();
});

test('additive wire metadata validates addresses, alias membership and bounds',()=>{
  assert.deepEqual(accountAddressMetadata({}),{});assert.deepEqual(accountAddressMetadata(),{});assert.deepEqual(accountAddressMetadata(null),{});
  assert.deepEqual(accountAddressMetadata({account_aliases:[delivery]}),{account_aliases:[delivery]});
  for(const value of [{delivery_address:delivery},{delivery_address:delivery,account_aliases:[]},{account_aliases:[delivery,delivery]},{account_aliases:[delivery.toUpperCase()]},{account_aliases:Array(101).fill(delivery)},{account_aliases:['other\n@example.test']}])assert.throws(()=>accountAddressMetadata(value),{code:'email_account_address_unqualified'});
  const schema=outputSchema('outlook','discover');assert.ok(schema.properties.delivery_address);assert.ok(schema.properties.account_aliases);assert.equal(schema.additionalProperties,false);
});
