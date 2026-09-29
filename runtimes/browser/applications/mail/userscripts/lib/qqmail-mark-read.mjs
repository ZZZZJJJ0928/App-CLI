// QQ's current client owns the mutation transport behind its message-row
// action. Trigger only the exact observed row, then independently re-read the
// same qualified list page and accept the effect only when that exact message
// is reported with unread=0.
export async function markQQMailRead({provider_message_id,row,binding,fetch:originalFetch}) {
  if (row?.provider_message_id !== provider_message_id || row.unread !== true ||
      !(binding instanceof URL) || binding.origin !== location.origin || binding.pathname !== '/list/maillist' ||
      binding.searchParams.get('func') !== '1' || !binding.searchParams.get('sid') || typeof originalFetch !== 'function') return null;
  const matches=[...document.querySelectorAll('.mail-list-page-item[data-mailid]')].filter(node=>
    node?.getAttribute?.('data-mailid')===provider_message_id && node.isConnected!==false && node.getClientRects?.().length>0);
  if(matches.length!==1||typeof matches[0].click!=='function')return null;
  matches[0].click();
  for(let attempt=0;attempt<20;attempt++){
    await new Promise(resolve=>setTimeout(resolve,250));
    let response,value;
    try{
      response=await originalFetch.call(window,binding.href,{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
      if(!response.ok||response.url&&new URL(response.url).origin!==location.origin)return {provider_message_id,read_state:'unknown'};
      const text=await response.text();
      if(text.length>10<<20)return {provider_message_id,read_state:'unknown'};
      value=JSON.parse(text);
    }catch{return {provider_message_id,read_state:'unknown'};}
    const parsed=parseQQMailList(value);
    const confirmed=parsed?.rows?.find(candidate=>candidate.provider_message_id===provider_message_id);
    if(confirmed?.unread===false)return {provider_message_id,read_state:'read'};
  }
  return {provider_message_id,read_state:'unknown'};
}
