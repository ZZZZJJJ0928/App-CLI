// QQ's own /list/maillist response separates receipt time (totime) from
// sender time (fromtime). Only bounded metadata leaves the owned task page.
export function parseQQMailList(value) {
  if(value?.head?.ret!==0 || !Number.isInteger(value.head.time) || !Array.isArray(value.body?.list) || !Number.isInteger(value.body.total_num) || value.body.total_num<0)return null;
  const rows=[];
  for(const item of value.body.list.slice(0,2000)){
    if(typeof item?.emailid!=='string' || !/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/u.test(item.emailid) || !Number.isInteger(item.dirid) || item.dirid<1 ||
      !Number.isInteger(item.totime) || item.totime<946684800 || item.totime>value.head.time+300 || item.unread!==undefined && item.unread!==0 && item.unread!==1)continue;
    rows.push({provider_message_id:item.emailid,provider_selection_id:item.emailid,provider_thread_id:item.emailid,
      folder:item.dirid===1?'inbox':item.dirid===3?'sent':`qq:${item.dirid}`,unread:item.unread===1,
      received_at:new Date(item.totime*1000).toISOString()});
  }
  return {rows,total_count:value.body.total_num,unsupported_rows:value.body.list.length-rows.length};
}
