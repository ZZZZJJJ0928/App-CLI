import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {installOutlookOriginalResolver} from '../../applications/mail/userscripts/lib/outlook-original.mjs';

const owner='owner@example.test';
const target={account_address:owner,provider_message_id:'item-A/B+=~'};
const code='email_network_original_unqualified';
const nativeURL=(id,token='synthetic-private-token')=>`https://attachment.outlook.live.net/owa/MSA%3Aobserved-alias/service.svc/s/DownloadMessage?id=${encodeURIComponent(id)}&outputFormat=0&token=${token}`;

// Two synthetic OWA builds. Module IDs, chunk IDs and minified export names
// all differ; only the readable lazy declaration, the lazy namespace export
// name and literal strings inside native functions are shared, as observed
// in consumer OWA mail_20261016004.05.
const legacy={
  chunks:[63436,44349,54709],
  modules:{declaration:685916,lazy:750077,entry:959748,builder:643446,mailbox:129387,selected:112548,configuration:859741,jwt:30069,isExpired:148443,tokens:497785,refresh:178447,authorize:56150},
  exports:{builder:'V',mailbox:'A',selected:'A',configuration:'C',isExpired:'y',tokens:'Y',refresh:'e',interval:'B',authorize:'NX'},
  lazy:{63436:['refresh'],44349:['isExpired'],54709:['entry','builder','authorize']},
};
const renumbered={
  chunks:[70412,18803,63436,91177],
  modules:{declaration:402211,lazy:11873,entry:288130,builder:907514,mailbox:615002,selected:33391,configuration:740186,jwt:518840,isExpired:62597,tokens:844120,refresh:390055,authorize:276604},
  exports:{builder:'Qk',mailbox:'Z',selected:'Z',configuration:'w$',isExpired:'p',tokens:'Hb',refresh:'Ht',interval:'e',authorize:'a'},
  lazy:{70412:['entry'],18803:['builder','isExpired'],63436:['refresh'],91177:['authorize']},
};

// Factory source templates in the minified shape OWA ships. `f` is the
// fixture that supplies native behavior.
function sources({modules:I,exports:X,chunks}) {
  return {
    declaration:`function(e,t,n){n.d(t,{Jp:()=>s,t_:()=>l});var r=n(${I.lazy});let a=new r.jm(()=>Promise.all([${chunks.map(id=>`n.e(${id})`).join(',')}]).then(n.bind(n,${I.entry})),{name:"DownloadFileTokenHeader"}),l=new r.tY(a,e=>e.getDownloadMessageUrlForLazyLoading),s=new r.tY(a,e=>e.getAttachmentUrlOrigin);let c=new r.jm(()=>Promise.all([n.e(21804),n.e(99999)]).then(n.bind(n,247184)),{name:"TriageActionImportExport"})}`,
    entry:`function(e,t,n){n.r(t),n.d(t,{getDownloadMessageUrlForLazyLoading:()=>y,getUrlDataDownloadToken:()=>o});var r=n(${I.tokens});function o(e){let t=(0,r.${X.tokens})(e);return t?.downloadToken}var g=n(${I.builder});function y(e,t,a){return(0,g.${X.builder})(e,t,a)}}`,
    builder:`function(e,n,t){t.d(n,{${X.builder}:()=>r});function r(e,n,t){f.builds.push([e,n,t]);return f.url(e,n,t)}}`,
    mailbox:`function(e,t,n){n.d(t,{${X.mailbox}:()=>o});function o(){let e=f.store();if(!e.mailboxInfo)throw Error("Global settings account lacks MailboxInfo");return e.mailboxInfo}}`,
    selected:`function(e,t,n){n.d(t,{${X.selected}:()=>a});function a(){f.selectedCalls++;let e=f.store();return f.assert(e,"No account is selected as the global settings account"),f.assert(e.mailboxInfo,"Global settings account lacks MailboxInfo"),e.mailboxInfo}}`,
    configuration:`function(e,t,o){o.d(t,{${X.configuration}:()=>l});let l=(e,t)=>{f.configurationCalls.push(e);let o=f.configuration;return!o&&!t&&f.report("AccountScopeUserSettingsMissing",e),o}}`,
    jwt:`function(e,n,t){t.d(n,{G:()=>o});function o(e,n){if(f.entra)return f.report("Skipping token expiration check: Entra ID token cannot be parsed as JWT"),!1;return f.expired}}`,
    // A token reader shares the expiry check's property names; arity and the
    // missing expiry-checker reference must keep it out of isExpired.
    tokens:`function(e,t,n){n.d(t,{${X.tokens}:()=>u});function u(e){let t=f.tokens(e?.userIdentity);return t?.downloadToken?t:void 0}}`,
    isExpired:`function(e,n,t){t.d(n,{${X.isExpired}:()=>i});var r=t(${I.tokens}),a=t(${I.jwt});function i(e){let n=(0,r.${X.tokens})(e?.userIdentity)?.downloadToken;return!n||(0,a.G)(n,e)}}`,
    refresh:`function(e,t,n){n.d(t,{${X.refresh}:()=>g,${X.interval}:()=>v});async function g(e){if(f.entra)return void f.report("Skipping refreshDownloadToken: Entra ID token is used","attachments");f.refreshes++;if(!f.refreshFails)f.expired=false}function v(e,t){if(f.entra)return void f.report("Skipping startIntervalForRefreshDownloadToken: Entra ID token is used","attachments");f.intervals++}}`,
    authorize:`function(e,t,a){a.d(t,{F$:()=>w,${X.authorize}:()=>h,sS:()=>u,ud:()=>c});let s="token",u="X-Token",c="Authorization",w="Bearer ";async function h(e,t,a,l){let r=await f.authorize(e,t);if(!r)throw Error("Token is required but was not found in URL or token cache.");return{url:r.url,tokenHeader:r.tokenHeader}}}`,
  };
}

function fixture(t,build=legacy,edit=()=>{}) {
  const f={currentAccount:owner,inbox:{qualified:true,account:owner},info:{type:'UserMailbox',userIdentity:'observed-logon-alias@example.test',mailboxSmtpAddress:owner},configuration:{SessionSettings:{UserEmailAddress:owner}},configurationCalls:[],chunks:[],modules:[],builds:[],fetches:0,registrations:0,selectedCalls:0,intervals:0,reports:[]};
  f.url=id=>nativeURL(id);
  f.expired=false;f.refreshes=0;f.authorizations=[];
  f.store=()=>({mailboxInfo:f.info});
  f.tokens=()=>({downloadToken:'synthetic-private-token'});
  f.assert=(value,message)=>{if(!value)throw new Error(message);};
  f.report=(...args)=>{f.reports.push(args);};
  f.authorize=async(url,info)=>{f.authorizations.push({url,info});const value=new URL(url);value.searchParams.delete('token');return {url:value.href,tokenHeader:{name:'Authorization',value:'Bearer page-private-native-fixture'}};};
  const text=sources(build);edit(text,build);
  const compile=source=>source&&new Function('f','return '+source)(f);
  const lazyNames=new Set(Object.values(build.lazy).flat()),table={};
  const factory=name=>[String(build.modules[name]),compile(text[name])];
  for(const name of Object.keys(text))if(!lazyNames.has(name)&&text[name]){const [id,fn]=factory(name);table[id]=fn;}
  f.table=table;
  const cache=new Map();
  const require=id=>{
    const key=String(id);
    if(cache.has(key))return cache.get(key).exports;
    if(!table[key])throw new Error('unknown native module');
    const module={exports:{}};cache.set(key,module);f.modules.push(Number(key));
    table[key].call(module.exports,module,module.exports,require);
    return module.exports;
  };
  require.m=table;
  require.d=(exports,definition)=>{for(const key in definition)Object.defineProperty(exports,key,{enumerable:true,get:definition[key]});};
  require.r=exports=>{Object.defineProperty(exports,'__esModule',{value:true});};
  require.e=async id=>{
    f.chunks.push(id);if(f.loadError)throw f.loadError;await f.loadGate;
    if(!build.lazy[id])throw Object.assign(new Error('Loading chunk '+id+' failed.'),{name:'ChunkLoadError'});
    for(const name of build.lazy[id])if(text[name]){const [key,fn]=factory(name);table[key]??=fn;}
  };
  f.require=require;
  const webpack=[];
  webpack.push=entry=>{f.registrations++;assert.deepEqual(Object.keys(entry[1]),[]);entry[2](f.nativeRequire??require);return 1;};
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

for(const [name,build] of Object.entries({legacy,renumbered}))
  test(`Outlook original resolver finds native modules by function in the ${name} build`,async t=>{
    const f=fixture(t,build),url=await f.resolver.prepare(target);
    assert.equal(url.origin,'https://attachment.outlook.live.net');assert.equal(url.searchParams.get('id'),target.provider_message_id);
    assert.equal(url.searchParams.get('outputFormat'),'0');assert.ok(url.searchParams.get('token'));
    assert.deepEqual(f.chunks,build.chunks);
    const M=build.modules;
    assert.deepEqual(new Set(f.modules),new Set([M.entry,M.tokens,M.builder,M.mailbox,M.selected,M.configuration,M.authorize,M.isExpired,M.jwt,M.refresh]));
    assert.equal(f.modules.includes(M.declaration),false);assert.equal(f.modules.includes(M.lazy),false);
    assert.equal(f.registrations,1);assert.equal(f.builds.length,1);assert.equal(f.builds[0][0],target.provider_message_id);assert.equal(f.builds[0][1],'EML');assert.equal(f.builds[0][2],f.info);
    assert.deepEqual(f.configurationCalls,[f.info]);
    // Discovery inspects but never invokes the selected-account variant or the refresh timer.
    assert.equal(f.selectedCalls,0);assert.equal(f.intervals,0);assert.equal(f.refreshes,0);
    const request=await f.resolver.prepareRequest(target);
    assert.equal(request.headers.Authorization,'Bearer page-private-native-fixture');assert.equal(f.authorizations[0].info,f.info);
    f.expired=true;await f.resolver.prepareRequest(target);assert.equal(f.refreshes,1);assert.equal(f.intervals,0);
    assert.equal(f.chunks.length,build.chunks.length);assert.equal(f.fetches,0);
  });

test('Outlook native header authorization replaces obsolete query token within the same target URL',async t=>{
  const f=fixture(t),request=await f.resolver.prepareRequest(target);
  assert.equal(request.url.searchParams.has('token'),false);
  assert.equal(request.url.searchParams.get('id'),target.provider_message_id);
  assert.equal(request.headers.Authorization,'Bearer page-private-native-fixture');
  assert.equal(f.authorizations[0].info,f.info);assert.equal(f.refreshes,0);assert.equal(f.fetches,0);
  assert.equal(f.resolver.diagnostics().stage,'authorized');
  assert.ok(!JSON.stringify(f.resolver.diagnostics()).includes('page-private'));
});

test('Outlook legacy expired token refreshes natively and failed refresh cannot issue a download',async t=>{
  const f=fixture(t);f.expired=true;
  const request=await f.resolver.prepareRequest(target);
  assert.equal(f.refreshes,1);assert.ok(request.headers.Authorization);
  f.expired=true;f.refreshFails=true;
  await assert.rejects(f.resolver.prepareRequest(target),{code});
  assert.equal(f.authorizations.length,1);assert.equal(f.fetches,0);
});

test('Outlook native authorization cannot change origin, route, message, format or inject headers',async t=>{
  const changes={host:x=>{x.url=x.url.replace('attachment.outlook.live.net','foreign.example.test');},
    id:x=>{x.url=x.url.replace('id=','id=other');},extra:x=>{x.url+='&extra=1';},
    query_token:x=>{x.url+='&token=forbidden';},name:x=>{x.tokenHeader.name='Cookie';},
    empty:x=>{x.tokenHeader.value='';},newline:x=>{x.tokenHeader.value='a\r\nb';},oversize:x=>{x.tokenHeader.value='a'.repeat(32769);}};
  for(const [name,change]of Object.entries(changes))await t.test(name,async t=>{
    const f=fixture(t),authorize=f.authorize;f.authorize=async(...args)=>{const v=await authorize(...args);change(v);return v;};
    await assert.rejects(f.resolver.prepareRequest(target),{code});assert.equal(f.fetches,0);
  });
});

test('Outlook native authorization completion rechecks account, mailbox and disposal',async t=>{
  for(const change of [f=>{f.currentAccount='other@example.test';},f=>{f.configuration.SessionSettings.UserEmailAddress='other@example.test';},f=>{f.info={...f.info};},f=>f.resolver.dispose()]){
    const f=fixture(t),authorize=f.authorize;
    f.authorize=async(...args)=>{const v=await authorize(...args);change(f);return v;};
    await assert.rejects(f.resolver.prepareRequest(target),{code});assert.equal(f.fetches,0);
  }
});

test('Outlook lazy modules load only once for concurrent and subsequent originals; URLs are rebuilt each time',async t=>{
  const f=fixture(t);let release;f.loadGate=new Promise(resolve=>{release=resolve;});
  const a=f.resolver.prepare(target),b=f.resolver.prepare({...target,provider_message_id:'second'});
  assert.equal(f.chunks.length,3);assert.equal(f.builds.length,0);release();
  const [one,two]=await Promise.all([a,b]);assert.notEqual(one.searchParams.get('id'),two.searchParams.get('id'));
  f.url=id=>nativeURL(id,'refreshed-native-token');
  const again=await f.resolver.prepare(target);assert.equal(again.searchParams.get('token'),'refreshed-native-token');
  assert.equal(f.chunks.length,3);assert.equal(f.registrations,1);assert.equal(f.builds.length,3);assert.equal(f.fetches,0);
});

test('Outlook discovery cache is dropped when the page runtime or a native factory changes',async t=>{
  await t.test('replaced factory',async t=>{
    const f=fixture(t);await f.resolver.prepare(target);
    const id=String(legacy.modules.configuration);
    f.table[id]=new Function('f','return '+String(f.table[id]))(f);
    await f.resolver.prepare(target);
    assert.equal(f.chunks.length,6);assert.equal(f.registrations,1);
  });
  await t.test('replaced runtime',async t=>{
    const f=fixture(t);await f.resolver.prepare(target);
    const webpack=[];webpack.push=entry=>{f.registrations++;entry[2](f.require);return 1;};
    f.context.webpackChunkOwa=webpack;
    await f.resolver.prepare(target);
    assert.equal(f.registrations,2);assert.equal(f.chunks.length,6);
  });
});

test('Outlook failed discovery is retried and reports which page capability is missing',async t=>{
  const f=fixture(t);f.loadError=new Error('synthetic_chunk_failure');
  await assert.rejects(f.resolver.prepare(target),{code});assert.equal(f.resolver.diagnostics().stage,'chunks');
  delete f.loadError;
  assert.equal((await f.resolver.prepare(target)).searchParams.get('id'),target.provider_message_id);
  assert.equal(f.registrations,1);assert.equal(f.resolver.diagnostics().missing,undefined);
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

test('Outlook missing native runtime or rejected lazy loading fail closed',async t=>{
  for(const [name,change] of Object.entries({
    missing_runtime:f=>{delete f.context.webpackChunkOwa;},
    non_native_array:f=>{f.context.webpackChunkOwa=[];},
    no_module_table:f=>{f.nativeRequire=Object.assign(id=>f.require(id),{e:f.require.e});},
    chunk_failure:f=>{f.loadError=new Error('synthetic_chunk_failure');},
  }))await t.test(name,async t=>{
    const f=fixture(t);change(f);await assert.rejects(f.resolver.prepare(target),{code});assert.equal(f.fetches,0);assert.equal(f.builds.length,0);
  });
});

test('Outlook page contract changes name the missing capability and never fall back',async t=>{
  const drop=name=>text=>{text[name]=text[name].replaceAll(/"[^"]*"/g,'"changed"');};
  const cases={
    declaration:text=>{text.declaration=text.declaration.replace('{name:"DownloadFileTokenHeader"}','{name:"DownloadFileTokenHeaderV2"}');},
    conflicting_declaration:(text,build)=>{text.lazy=`function(e,t,n){let a=new r.jm(()=>n.e(${build.chunks[0]}).then(n.bind(n,12345)),{name:"DownloadFileTokenHeader"})}`;},
    removed_chunk:text=>{text.declaration=text.declaration.replace(/n\.e\(54709\)/,'n.e(54710)');},
    build:text=>{text.entry=text.entry.replaceAll('getDownloadMessageUrlForLazyLoading','getDownloadMessageUrl');},
    mailbox:drop('mailbox'),
    configuration:drop('configuration'),
    authorize:drop('authorize'),
    isExpired:text=>{text.jwt=text.jwt.replace('Skipping token expiration check','Skipping JWT check');},
    refresh:drop('refresh'),
  };
  const expected={conflicting_declaration:'declaration',removed_chunk:undefined};
  for(const [name,edit] of Object.entries(cases))await t.test(name,async t=>{
    const f=fixture(t,legacy,edit);
    await assert.rejects(f.resolver.prepare(target),{code});
    assert.equal(f.resolver.diagnostics().missing,name in expected?expected[name]:name);
    assert.equal(f.builds.length,0);assert.equal(f.authorizations.length,0);assert.equal(f.fetches,0);
  });
});

test('Outlook ambiguous native functions fail closed instead of choosing one',async t=>{
  const duplicate=(name,id)=>(text,build)=>{text[name+'Copy']=text[name].replaceAll(build.exports[name]+':',build.exports[name]+'2:');build.modules[name+'Copy']=id;};
  for(const [name,edit] of Object.entries({
    authorize:duplicate('authorize',900001),
    configuration:duplicate('configuration',900002),
    mailbox:duplicate('mailbox',900003),
    isExpired:duplicate('isExpired',900004),
  }))await t.test(name,async t=>{
    const build=structuredClone(legacy),f=fixture(t,build,edit);
    await assert.rejects(f.resolver.prepare(target),{code});
    assert.equal(f.resolver.diagnostics().missing,name);assert.equal(f.builds.length,0);
  });
  await t.test('expiry check without a unique checker',async t=>{
    const build=structuredClone(legacy),f=fixture(t,build,(text,build)=>{text.jwtCopy=text.jwt;build.modules.jwtCopy=900005;});
    await assert.rejects(f.resolver.prepare(target),{code});assert.equal(f.resolver.diagnostics().missing,'isExpired');
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
