import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {installOutlookOriginalResolver} from '../../applications/mail/userscripts/lib/outlook-original.mjs';

const owner='owner@example.test';
const target={account_address:owner,provider_message_id:'item-A/B+=~'};
const code='email_network_original_unqualified';
const nativeURL=(id,token='synthetic-private-token')=>`https://attachment.outlook.live.net/owa/MSA%3Aobserved-alias/service.svc/s/DownloadMessage?id=${encodeURIComponent(id)}&outputFormat=0&token=${token}`;

function fixture(t) {
  const f={currentAccount:owner,inbox:{qualified:true,account:owner},info:{type:'UserMailbox',userIdentity:'observed-logon-alias@example.test',mailboxSmtpAddress:owner},configuration:{SessionSettings:{UserEmailAddress:owner}},configurationCalls:[],chunks:[],modules:[],builds:[],fetches:0,registrations:0};
  f.url=id=>nativeURL(id);
  const require=id=>{
    f.modules.push(id);
    if(id===643446)return f.invalidBuilder?{}:{V(...args){f.builds.push(args);return f.url(...args);}};
    if(id===129387)return f.invalidMailbox?{}:{A:()=>f.info};
    if(id===859741)return f.invalidConfiguration?{}:{C(info){f.configurationCalls.push(info);return f.configuration;}};
    throw new Error('unexpected native module');
  };
  require.e=async id=>{f.chunks.push(id);if(f.loadError)throw f.loadError;await f.loadGate;};
  const webpack=[];
  webpack.push=entry=>{f.registrations++;assert.deepEqual(Object.keys(entry[1]),[]);entry[2](require);return 1;};
  const context=vm.createContext({URL,crypto:webcrypto,setTimeout,clearTimeout,location:{origin:'https://outlook.live.com'},webpackChunkOwa:webpack,
    fetch:()=>{f.fetches++;throw new Error('resolver must not download by itself');},
    dependencies:{account(expected){if(expected!==f.currentAccount)throw Object.assign(new Error('email_account_mismatch'),{code:'email_account_mismatch'});return f.currentAccount;},getInbox:()=>f.inbox},
  });
  vm.runInContext('window=globalThis;',context);
  f.context=context;
  f.resolver=vm.runInContext(`(${installOutlookOriginalResolver.toString()})(dependencies)`,context);
  t.after(()=>f.resolver.dispose());
  return f;
}

test('Outlook original resolver invokes native EML builder with actual native mailboxInfo and exact item ID',async t=>{
  const f=fixture(t),url=await f.resolver.prepare(target);
  assert.equal(url.origin,'https://attachment.outlook.live.net');assert.equal(url.searchParams.get('id'),target.provider_message_id);
  assert.equal(url.searchParams.get('outputFormat'),'0');assert.ok(url.searchParams.get('token'));
  assert.deepEqual(f.chunks,[21804,63436,73413,46866,32314,54709]);assert.deepEqual(f.modules,[643446,129387,859741]);
  assert.equal(f.registrations,1);assert.equal(f.builds.length,1);assert.equal(f.builds[0][0],target.provider_message_id);assert.equal(f.builds[0][1],'EML');assert.equal(f.builds[0][2],f.info);
  assert.deepEqual(f.configurationCalls,[f.info]);
  assert.equal(f.fetches,0);
});

test('Outlook lazy modules load only once for concurrent and subsequent originals; URLs are rebuilt each time',async t=>{
  const f=fixture(t);let release;f.loadGate=new Promise(resolve=>{release=resolve;});
  const a=f.resolver.prepare(target),b=f.resolver.prepare({...target,provider_message_id:'second'});
  assert.equal(f.chunks.length,6);assert.equal(f.builds.length,0);release();
  const [one,two]=await Promise.all([a,b]);assert.notEqual(one.searchParams.get('id'),two.searchParams.get('id'));
  f.url=id=>nativeURL(id,'refreshed-native-token');
  const again=await f.resolver.prepare(target);assert.equal(again.searchParams.get('token'),'refreshed-native-token');
  assert.equal(f.chunks.length,6);assert.equal(f.registrations,1);assert.equal(f.builds.length,3);assert.equal(f.fetches,0);
});

test('Outlook resolver rejects missing qualification, wrong scope and malformed IDs before loading code',async t=>{
  for(const [name,change] of Object.entries({unqualified:f=>{f.inbox.qualified=false;},wrong_startup_account:f=>{f.inbox.account='other@example.test';},wrong_origin:f=>{f.context.location.origin='https://outlook.office.com';},missing_startup:f=>{f.inbox=null;}}))await t.test(name,async t=>{
    const f=fixture(t);change(f);await assert.rejects(f.resolver.prepare(target),{code});assert.equal(f.chunks.length,0);assert.equal(f.builds.length,0);
  });
  for(const id of ['', 'item?token=unexpected', 'contains space', 'a'.repeat(1025)]){
    const f=fixture(t);await assert.rejects(f.resolver.prepare({...target,provider_message_id:id}),{code});assert.equal(f.chunks.length,0);
  }
});

test('Outlook native download URL fence rejects wrong host/path/id/format and malformed values',async t=>{
  const changes={
    foreign_host:url=>{url.hostname='foreign.example.test';},
    consumer_page_origin:url=>{url.hostname='outlook.live.com';},
    insecure:url=>{url.protocol='http:';},
    credentials:url=>{url.username='user';url.password='test-password';},
    fragment:url=>{url.hash='#fragment';},
    wrong_path:url=>{url.pathname='/owa/MSA%3Aalias/service.svc/s/GetFileAttachment';},
    extra_path_component:url=>{url.pathname='/owa/alias/extra/service.svc/s/DownloadMessage';},
    wrong_id:url=>{url.searchParams.set('id','another-item');},
    msg_format:url=>{url.searchParams.set('outputFormat','1');},
    no_token:url=>{url.searchParams.delete('token');},
    empty_token:url=>{url.searchParams.set('token','');},
  };
  for(const [name,change] of Object.entries(changes))await t.test(name,async t=>{
    const f=fixture(t);f.url=id=>{const url=new URL(nativeURL(id));change(url);return String(url);};
    await assert.rejects(f.resolver.prepare(target),{code});assert.equal(f.fetches,0);
  });
  for(const value of [undefined,null,{},'/relative-download','not a URL']){
    const f=fixture(t);f.url=()=>value;await assert.rejects(f.resolver.prepare(target),{code});
  }
});

test('Outlook account changes during lazy loading or native URL construction reject the result',async t=>{
  await t.test('initial mismatch',async t=>{
    const f=fixture(t);await assert.rejects(f.resolver.prepare({...target,account_address:'other@example.test'}),{code:'email_account_mismatch'});assert.equal(f.chunks.length,0);
  });
  await t.test('changed while loading',async t=>{
    const f=fixture(t);let release;f.loadGate=new Promise(resolve=>{release=resolve;});const pending=f.resolver.prepare(target);f.currentAccount='other@example.test';release();
    await assert.rejects(pending,{code});assert.equal(f.builds.length,0);
  });
  await t.test('changed during builder',async t=>{
    const f=fixture(t);f.url=id=>{f.currentAccount='other@example.test';return nativeURL(id);};await assert.rejects(f.resolver.prepare(target),{code});
  });
  for(const info of [null,{type:'GroupMailbox'},{type:'ArchiveMailbox'}]){
    const f=fixture(t);f.info=info;await assert.rejects(f.resolver.prepare(target),{code});assert.equal(f.builds.length,0);
  }
});

test('Outlook missing native runtime, modules or rejected lazy loading fail closed',async t=>{
  for(const [name,change] of Object.entries({missing_runtime:f=>{delete f.context.webpackChunkOwa;},non_native_array:f=>{f.context.webpackChunkOwa=[];},missing_builder:f=>{f.invalidBuilder=true;},missing_mailbox:f=>{f.invalidMailbox=true;},missing_configuration:f=>{f.invalidConfiguration=true;},chunk_failure:f=>{f.loadError=new Error('synthetic_chunk_failure');}}))await t.test(name,async t=>{
    const f=fixture(t);change(f);await assert.rejects(f.resolver.prepare(target),{code});assert.equal(f.fetches,0);
  });
});

test('Outlook native global mailbox configuration must match the qualified account, not only the DOM label',async t=>{
  for(const configuration of [null,{}, {SessionSettings:{}},{SessionSettings:{UserEmailAddress:'other@example.test'}}]){
    const f=fixture(t);f.configuration=configuration;
    await assert.rejects(f.resolver.prepare(target),{code});assert.equal(f.builds.length,0);assert.deepEqual(f.configurationCalls,[f.info]);
  }
  const f=fixture(t);f.configuration.SessionSettings.UserEmailAddress=owner.toUpperCase();
  assert.equal((await f.resolver.prepare(target)).searchParams.get('id'),target.provider_message_id);
  assert.equal(f.builds[0][2],f.info); // Logon alias differs, but native configuration proves the account.
});

test('Outlook dispose prevents late lazy completion and future resolver use',async t=>{
  const f=fixture(t);let release;f.loadGate=new Promise(resolve=>{release=resolve;});
  const pending=f.resolver.prepare(target);f.resolver.dispose();release();
  await assert.rejects(pending,{code});assert.equal(f.builds.length,0);
  await assert.rejects(f.resolver.prepare(target),{code});assert.equal(f.registrations,1);
  f.resolver.dispose();assert.equal(f.fetches,0);
});
