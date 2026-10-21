// The page owns QQ's mutation transport. A click is only an attempt: each
// confirmation independently reselects the exact receipt-time target through
// native search, without inheriting a UI unread filter or page offset.
export async function markQQMailRead({provider_message_id, readTarget, checkAccount, confirmOnly = false}) {
  const result=read_state=>({provider_message_id,read_state});
  if(typeof readTarget!=='function'||typeof checkAccount!=='function')return result('unknown');
  const signal=AbortSignal.timeout(8000);
  let row;
  try { row=await readTarget(signal); } catch { return result('unknown'); }
  if(row?.unread===false)return result('read');
  if(row?.unread!==true||signal.aborted)return result('unknown');
  if(!confirmOnly) {
    const matches=[...document.querySelectorAll('.mail-list-page-item[data-mailid]')].filter(node=>
      node?.getAttribute?.('data-mailid')===provider_message_id && node.isConnected!==false && node.getClientRects?.().length>0);
    if(matches.length!==1||typeof matches[0].click!=='function')return result('unknown');
    checkAccount();
    // Never repeat this action. Failure or an absent confirmation is unknown;
    // recovery is limited to the independent read-only observations below.
    matches[0].click();
  }
  for(let attempt=0;attempt<3&&!signal.aborted;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
    if(signal.aborted)break;
    try { row=await readTarget(signal); } catch { return result('unknown'); }
    if(row?.unread===false)return result('read');
  }
  return result('unknown');
}
