// Consumer OWA's own EML URL builder handles MSA aliases, PUID routing and
// session-token refresh. Never derive an attachment routing key from an email
// address, and never export the URL/token outside this page-private transport.
export function installOutlookOriginalResolver({account,getInbox}) {
  let loading=null,active=true,stage='idle';
  const fail=()=>{throw Object.assign(new Error('email_network_original_unqualified'),{code:'email_network_original_unqualified'});};
  async function nativeModules() {
    if(!loading)loading=(async()=>{
      stage='runtime';
      let nativeRequire;
      if(!Array.isArray(window.webpackChunkOwa))fail();
      window.webpackChunkOwa.push([['sparkclaw_original_'+crypto.randomUUID()],{},require=>{nativeRequire=require;}]);
      if(typeof nativeRequire!=='function'||typeof nativeRequire.e!=='function')fail();
      // The observed native TriageActionImportExport dependency group. Loading
      // code has no mailbox mutation and is needed only for actual downloads.
      stage='modules';await Promise.all([21804,63436,73413,46866,32314,54709].map(id=>nativeRequire.e(id)));
      const build=nativeRequire(643446)?.V,mailbox=nativeRequire(129387)?.A,configuration=nativeRequire(859741)?.C;
      if(typeof build!=='function'||typeof mailbox!=='function'||typeof configuration!=='function')fail();
      return {build,mailbox,configuration};
    })();
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
  return {prepare,diagnostics:()=>({stage}),dispose(){active=false;loading=null;stage='disposed';}};
}
