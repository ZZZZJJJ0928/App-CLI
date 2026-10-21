// Login/mailbox identity can be an internal MSA routing address. Resolve the
// separate SMTP address using this exact signed-in mailbox's own From selector;
// neither observed mail headers nor a guessed transformation identify an alias.
export function installOutlookAccountIdentity() {
  let nativeRequire;
  const normalize=value=>typeof value==='string'&&value.length<=320&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)?value.toLowerCase():'';
  // OWA uses MobX observable arrays, which can fail Array.isArray. Copy only
  // bounded indexed entries; never run an arbitrary iterator from native state.
  const addresses=value=>value&&typeof value==='object'&&Number.isSafeInteger(value.length)&&value.length>=0&&value.length<=100
    ? Array.from({length:value.length},(_,index)=>value[index]) : null;
  return expected=>{
    try {
      if(location.origin!=='https://outlook.live.com'||!normalize(expected))return {};
      if(!nativeRequire) {
        if(!Array.isArray(window.webpackChunkOwa))return {};
        window.webpackChunkOwa.push([['appcli_mail_identity_'+crypto.randomUUID()],{},require=>{nativeRequire=require;}]);
      }
      if(typeof nativeRequire!=='function')return {};
      const mailbox=nativeRequire(129387)?.A,configuration=nativeRequire(859741)?.C;
      const defaultFrom=nativeRequire(107357)?.A,aliases=nativeRequire(871008)?.Ay,internal=nativeRequire(791573)?.A;
      if([mailbox,configuration,defaultFrom,aliases,internal].some(fn=>typeof fn!=='function'))return {};
      const info=mailbox(),config=configuration(info),session=config?.SessionSettings;
      const owner=normalize(expected);
      if(info?.type!=='UserMailbox'||info.isExplicitLogon||session?.IsExplicitLogon||normalize(session?.UserEmailAddress)!==owner)return {};
      const proxies=addresses(session.UserProxyAddresses);
      if(!proxies||proxies.some(value=>!normalize(value)))return {};
      const allowed=new Set([owner,...proxies.map(normalize)]);
      const nativeAliases=addresses(aliases(info,false,false,false)),from=defaultFrom(info);
      if(!nativeAliases||nativeAliases.some(value=>!normalize(value)||!allowed.has(normalize(value))||internal(value,info)!==false))return {};
      const account_aliases=[...new Set(nativeAliases.map(normalize))];
      const delivery_address=normalize(from?.EmailAddress);
      if(from?.RoutingType!=='SMTP'||from.MailboxType!=='Mailbox'||!delivery_address||!allowed.has(delivery_address)||internal(delivery_address,info)!==false||!account_aliases.includes(delivery_address))return {};
      // A mailbox switch during a native getter must not associate new aliases
      // with the old immutable account/capture namespace.
      if(mailbox()!==info||configuration(info)!==config||normalize(config.SessionSettings?.UserEmailAddress)!==owner)return {};
      return {delivery_address,account_aliases};
    } catch { return {}; } // Unqualified native versions never guess an address.
  };
}
