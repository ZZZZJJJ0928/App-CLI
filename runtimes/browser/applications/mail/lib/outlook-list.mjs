// A conversation is usable only when the provider explicitly reports exactly
// one global item. A route/conversation ID is never promoted to a message ID.
export function parseOutlookList(value, includeInventory = false) {
  const rows=[];
  let visited=0;
  const visit=(node,depth)=>{
    if(!node || typeof node!=='object' || depth>20 || ++visited>20000) return;
    if(Array.isArray(node.Conversations)) for(const item of node.Conversations.slice(0,100)) {
      const selection=item?.ConversationId?.Id, id=item?.ItemIds?.[0]?.Id;
      if(typeof selection!=='string' || !selection)continue;
      let inventory = includeInventory ? {last_delivery_time:typeof item.LastDeliveryTime==='string' && Number.isFinite(Date.parse(item.LastDeliveryTime)) ? item.LastDeliveryTime : null} : {};
      if (includeInventory && Number.isInteger(item.GlobalMessageCount) && item.GlobalMessageCount >= 1 && item.GlobalMessageCount <= 1000 &&
          Array.isArray(item.GlobalItemIds) && item.GlobalItemIds.length === item.GlobalMessageCount && Array.isArray(item.ItemIds) &&
          item.ItemIds.length === item.MessageCount && Array.isArray(item.DraftItemIds)) {
        const globalIDs = item.GlobalItemIds.map(value=>value?.Id), localIDs = item.ItemIds.map(value=>value?.Id), drafts = item.DraftItemIds.map(value=>value?.Id);
        if (globalIDs.every(value=>typeof value==='string' && /^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/u.test(value)) && new Set(globalIDs).size === globalIDs.length &&
            localIDs.every(value=>globalIDs.includes(value)) && drafts.every(value=>globalIDs.includes(value)) && new Set(drafts).size === drafts.length) {
          inventory = {members:globalIDs.map(value=>({provider_message_id:value,local:localIDs.includes(value),draft:drafts.includes(value)})),
            inventory_complete:true,global_unread_count:item.GlobalUnreadCount,
            last_delivery_time: typeof item.LastDeliveryTime==='string' && Number.isFinite(Date.parse(item.LastDeliveryTime)) ? item.LastDeliveryTime : null};
        }
      }
      if(typeof id!=='string' || !id || selection===id ||
          item.MessageCount!==1 || item.GlobalMessageCount!==1 || item.ItemIds?.length!==1 ||
          item.GlobalItemIds?.length!==1 || item.GlobalItemIds[0]?.Id!==id ||
          ![0,1].includes(item.UnreadCount) || item.GlobalUnreadCount!==item.UnreadCount) {
        rows.push({provider_selection_id:selection,provider_message_id:null,unread:null,...inventory});continue;
      }
      rows.push({provider_selection_id:selection,provider_message_id:id,unread:item.UnreadCount===1,...inventory});
    }
    for(const child of Object.values(node))if(child&&typeof child==='object')visit(child,depth+1);
  };
  visit(value,0);return rows;
}
