// Consumer OWA's own EML URL builder handles MSA aliases, PUID routing and
// session-token refresh. Never derive an attachment routing key from an email
// address, and never export the URL/token outside this page-private transport.
//
// OWA renumbers webpack chunks (and may renumber modules or minified export
// names) on every web-client release, so nothing here names a chunk, module
// or minified export. The page's own lazy declaration, found by its readable
// name, supplies the chunk list; each native function is then recognized by
// literal strings in its own source. Every capability must match exactly
// once; otherwise the page contract changed and the resolver fails closed
// with `missing` naming the capability.
export function installOutlookOriginalResolver({account,getInbox}) {
  let loading=null,resolved=null,runtime=null,active=true,stage='idle',missing=null;
  const fail=()=>{throw Object.assign(new Error('email_network_original_unqualified'),{code:'email_network_original_unqualified'});};
  const absent=name=>{missing=name;fail();};
  const source=value=>{try{return Function.prototype.toString.call(value);}catch{return '';}};
  // The native lazy group that downloads message files. Its readable export
  // names survive minification because callers access them by property.
  const declarationName='DownloadFileTokenHeader',builderName='getDownloadMessageUrlForLazyLoading';
  const capabilities={
    // The selected-account variant asserts a different precondition (and is
    // feature-gated), so only the plain global settings getter qualifies.
    mailbox:{text:['Global settings account lacks MailboxInfo'],exclude:['No account is selected as the global settings account'],arity:0},
    configuration:{text:['AccountScopeUserSettingsMissing']},
    authorize:{text:['Token is required but was not found in URL or token cache.','tokenHeader']},
    isExpired:{text:['downloadToken','userIdentity'],arity:1,uses:'Skipping token expiration check'},
    refresh:{text:['Skipping refreshDownloadToken']},
  };
  function nativeRuntime() {
    const chunks=window.webpackChunkOwa;
    if(runtime?.chunks===chunks)return runtime.require;
    runtime=null;
    if(!Array.isArray(chunks))fail();
    let nativeRequire;
    chunks.push([['sparkclaw_original_'+crypto.randomUUID()],{},require=>{nativeRequire=require;}]);
    if(typeof nativeRequire!=='function'||typeof nativeRequire.e!=='function'||!nativeRequire.m||typeof nativeRequire.m!=='object')fail();
    runtime={chunks,require:nativeRequire};
    return nativeRequire;
  }
  function factorySources(require) {
    return Object.keys(require.m).map(id=>[id,source(require.m[id])]);
  }
  // `new X(()=>Promise.all([n.e(1),n.e(2)]).then(n.bind(n,3)),{name:"…"})`:
  // only the chunk and entry numbers between the arrow and the name are read.
  function lazyDeclaration(sources) {
    const marker='{name:"'+declarationName+'"',found=[];
    for(const [,text] of sources) {
      for(let at=text.indexOf(marker);at>=0;at=text.indexOf(marker,at+1)) {
        const head=text.slice(Math.max(0,at-1000),at),start=head.lastIndexOf('()=>');
        const body=start<0?'':head.slice(start);
        if(!body||/[;{}]/.test(body))continue;
        const entries=[...body.matchAll(/\.bind\([\w$]+,(\d+)\)/g)].map(match=>Number(match[1]));
        if(entries.length!==1)continue;
        found.push({entry:entries[0],chunks:[...body.matchAll(/\.e\((\d+)\)/g)].map(match=>Number(match[1]))});
      }
    }
    if(!found.length||found.some(value=>value.entry!==found[0].entry))absent('declaration');
    return {entry:found[0].entry,chunks:[...new Set(found.flatMap(value=>value.chunks))]};
  }
  function locate(require,sources,name,{text,exclude=[],arity,uses}) {
    const references=[];
    if(uses) {
      const ids=sources.filter(([,value])=>value.includes(uses)).map(([id])=>id);
      if(ids.length!==1)absent(name);
      references.push('('+ids[0]+')');
    }
    const hits=[],factories=[];
    for(const [id,value] of sources) {
      if(!text.every(part=>value.includes(part))||!references.every(part=>value.includes(part)))continue;
      let exports;
      try{exports=require(/^\d+$/.test(id)?Number(id):id);}catch{continue;}
      if(!exports||typeof exports!=='object'&&typeof exports!=='function')continue;
      for(const key of Object.keys(exports)) {
        let candidate;
        try{candidate=exports[key];}catch{continue;}
        if(typeof candidate!=='function'||arity!==undefined&&candidate.length!==arity||hits.includes(candidate))continue;
        const own=source(candidate);
        if(text.every(part=>own.includes(part))&&!exclude.some(part=>own.includes(part))){hits.push(candidate);factories.push([id,require.m[id]]);}
      }
    }
    if(hits.length!==1)absent(name);
    return {value:hits[0],factories};
  }
  async function discover() {
    stage='runtime';missing=null;
    const require=nativeRuntime(),chunks=runtime.chunks;
    stage='declaration';
    const declaration=lazyDeclaration(factorySources(require));
    // Loading code has no mailbox mutation and is needed only for actual downloads.
    stage='chunks';await Promise.all(declaration.chunks.map(id=>require.e(id)));
    if(!active)fail();
    stage='modules';
    const sources=factorySources(require);
    let namespace;
    try{namespace=require(declaration.entry);}catch{absent('build');}
    const build=namespace?.[builderName];
    if(typeof build!=='function')absent('build');
    const found={},factories=[[String(declaration.entry),require.m[declaration.entry]]];
    for(const [name,spec] of Object.entries(capabilities)){const hit=locate(require,sources,name,spec);found[name]=hit.value;factories.push(...hit.factories);}
    return {...found,build,chunks,require,factories};
  }
  // Discovery is cached for this page. A replaced webpack runtime or module
  // factory (a new web-client version) invalidates it; failures are retried.
  async function nativeModules() {
    if(resolved&&(window.webpackChunkOwa!==resolved.chunks||resolved.factories.some(([id,factory])=>resolved.require.m[id]!==factory))){resolved=null;loading=null;}
    if(!loading) {
      const attempt=loading=discover().then(value=>{if(loading===attempt)resolved=value;return value;},error=>{if(loading===attempt)loading=null;throw error;});
    }
    return loading;
  }
  async function prepare({account_address,provider_message_id}) {
    const owner=account(account_address),inbox=getInbox();
    if(!active||location.origin!=='https://outlook.live.com'||!inbox?.qualified||inbox.account!==owner||!/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/.test(provider_message_id||''))fail();
    let timer;
    try{
      const {build,mailbox,configuration}=await Promise.race([nativeModules(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('email_network_original_unqualified'),{code:'email_network_original_unqualified'})),20000);})]);
      const info=mailbox();
      stage='mailbox';
      if(!active||info?.type!=='UserMailbox')fail();
      // Resolve this exact native mailbox's configuration, not just the DOM
      // label: global settings and a selected shared mailbox can differ.
      if(String(configuration(info)?.SessionSettings?.UserEmailAddress||'').toLowerCase()!==owner)fail();
      account(owner);
      stage='url';
      const value=build(provider_message_id,'EML',info);
      if(typeof value!=='string')fail();
      const url=new URL(value);
      if(url.origin!=='https://attachment.outlook.live.net'||url.username||url.password||url.hash||
        !/^\/owa\/[^/]+\/service\.svc\/s\/DownloadMessage$/.test(url.pathname)||
        url.searchParams.get('id')!==provider_message_id||url.searchParams.get('outputFormat')!=='0'||!url.searchParams.get('token'))fail();
      account(owner);stage='ready';return url;
    }catch{fail();}finally{clearTimeout(timer);}
  }
  async function prepareRequest(target) {
    const owner=account(target.account_address);
    let timer,expired=false;
    const check=({mailbox,configuration},info)=>{
      if(!active||expired||location.origin!=='https://outlook.live.com'||info?.type!=='UserMailbox'||
        mailbox()!==info||String(configuration(info)?.SessionSettings?.UserEmailAddress||'').toLowerCase()!==owner)fail();
      account(owner);
    };
    try {
      return await Promise.race([(async()=>{
        let url=await prepare(target);
        const modules=await nativeModules(),info=modules.mailbox(),{authorize,isExpired,refresh}=modules;
        check(modules,info);
        // Entra-backed consumer mailboxes use native header authorization; their
        // obsolete query token is not refreshed by the site's legacy timer.
        // Legacy mailboxes still use the site's own expiry/refresh policy.
        stage='authorization';
        if(isExpired(info)) {
          await refresh(info);check(modules,info);
          if(isExpired(info))fail();
          url=await prepare(target);check(modules,info);
        }
        const authorized=await authorize(url.href,info);
        check(modules,info);
        const expected=new URL(url);expected.searchParams.delete('token');
        if(typeof authorized?.url!=='string'||new URL(authorized.url).href!==expected.href)fail();
        const header=authorized.tokenHeader;
        if(!['Authorization','X-Token'].includes(header?.name)||typeof header.value!=='string'||
          !header.value||header.value.length>32768||/[\r\n\0]/.test(header.value))fail();
        stage='authorized';
        return {url:expected,headers:{[header.name]:header.value}};
      })(),new Promise((_,reject)=>{timer=setTimeout(()=>{
        expired=true;reject(Object.assign(new Error('email_network_original_unqualified'),{code:'email_network_original_unqualified'}));
      },20000);})]);
    }catch{fail();}finally{clearTimeout(timer);}
  }
  return {prepare,prepareRequest,diagnostics:()=>({stage,...(missing?{missing}:{})}),dispose(){active=false;loading=null;resolved=null;stage='disposed';}};
}
