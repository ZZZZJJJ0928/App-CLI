// Observed Outlook consumer web-worker GraphQL transport. Reuse only the site's
// own read operations; credentials and RPC templates stay in the mailbox page.
import {installOutlookRangeTransport} from './outlook-range.mjs';
import {installOutlookOriginalResolver} from './outlook-original.mjs';
export function installOutlookTransport({account, getInbox, receiveRows, receiveStartup}) {
  const existing=window.SparkClawOutlookEarlyBridge;
  const bridge=existing||installOutlookEarlyBridge();
  if(!bridge)return {dispose(){}};
  const templates=new Map(),pending=new Map();
  let active=true;
  const range=installOutlookRangeTransport({account,getInbox,receiveRows});
  const originalResolver=installOutlookOriginalResolver({account,getInbox});
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  const ownerOf=info=>String(info?.mailboxSmtpAddress||info?.userIdentity||'').toLowerCase();
  function request(worker,message) {
    const value=message?.argumentList?.[0]?.value;
    if(!active||message?.type!=='APPLY'||message?.path?.length!==1||message.path[0]!=='execute')return;
    if(['ItemRows','ConversationRows'].includes(value?.operationName)) {
      const info=value.variables?.mailboxInfo;
      if(!info||!value.variables?.pagingInfo)return;
      templates.set(value.operationName+':'+value.variables.folderId,{worker,message:structuredClone(message)});
      if(value.operationName==='ItemRows')templates.set('ItemRows',{worker,message:structuredClone(message)});
    }
  }
  function result(event,port) {
    const message=event.data;
    const id=message?.argumentList?.[0]?.value,waiter=pending.get(id);
    if(!active||!waiter||message.type!=='APPLY'||!['next','complete','error'].includes(message.path?.[0]))return;
    event.stopImmediatePropagation();
    port.postMessage({type:'RAW',id:message.id,value:undefined});
    const value=message.argumentList?.[1]?.value;
    if(value?.data?.itemRows||value?.errors)waiter.resolve(value);
    if(message.path[0]==='error')waiter.reject(Object.assign(new Error('email_network_read_failed'),{code:'email_network_read_failed'}));
  }
  const consumer={request,result,fetchSearch:range.fetchSearch,startup:receiveStartup};bridge.attach(consumer);
  async function listPage({account_address,interval_start,interval_end,page=0,provider_mode}) {
    if(provider_mode==='time_range')return range.listPage({account_address,interval_start,interval_end,page,provider_mode});
    const owner=account(account_address),inbox=getInbox();
    if(location.origin!=='https://outlook.live.com'||!inbox||inbox.account!==owner)fail('email_network_list_unqualified');
    const deadline=Date.now()+5000;
    while(active&&Date.now()<deadline&&(!templates.get('ItemRows')||!templates.get('ConversationRows:'+inbox.id)))await new Promise(resolve=>setTimeout(resolve,100));
    const item=templates.get('ItemRows'),normal=templates.get('ConversationRows:'+inbox.id);
    if(!item||!normal)fail('email_network_list_unqualified');
    const start=Date.parse(interval_start),end=Date.parse(interval_end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||!Number.isInteger(page)||page<0||page>409599)fail('invalid_request');
    const folders=inbox.folders?.length?inbox.folders:[{id:inbox.id,inbox:true}],folderIndex=Math.floor(page/4096),offset=page%4096,folder=folders[folderIndex];
    if(!folder)fail('email_network_list_unqualified');
    const message=structuredClone(item.message),body=message.argumentList[0].value,source=normal.message.argumentList[0].value;
    if(ownerOf(source.variables.mailboxInfo)!==owner)fail('email_account_identity_mismatch');
    let id;do{id=700000000+crypto.getRandomValues(new Uint32Array(1))[0]%100000000;}while(pending.has(id));
    message.id=crypto.randomUUID();body.requestId=id;body.context.workerRequestId=id;body.context.forceFetch=true;body.context.queryDeduplication=false;
    body.variables.folderId=folder.id;body.variables.mailboxInfo=source.variables.mailboxInfo;
    body.variables.viewFilter=source.variables.viewFilter;if(body.variables.focusedViewFilter!=='None'||source.variables.viewFilter!=='All')fail('email_network_list_unqualified');
    body.variables.focusedViewFilter='None';
    body.variables.sortBy={...source.variables.sortBy,isDraftsFolder:false};body.variables.pagingInfo={numberOfRows:25,pageOrigin:'Beginning',offset:offset*25};
    let timer;
    const value=await new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject,operation:'list'});timer=setTimeout(()=>reject(Object.assign(new Error('email_network_read_failed'),{code:'email_network_read_failed'})),20000);
      try{item.worker.postMessage(message);}catch{reject(Object.assign(new Error('email_network_read_failed'),{code:'email_network_read_failed'}));}
    }).finally(()=>clearTimeout(timer));
    account(account_address);
    // Keep this request's acknowledger until page disposal. A cached and a fresh
    // callback can both arrive; neither is forwarded into the site's request map.
    const data=value?.data?.itemRows;
    if(value?.errors?.length||!data||!Array.isArray(data.edges)||typeof data.pageInfo?.hasNextPage!=='boolean'||data.edges.length>25||!Number.isInteger(data.indexedOffset)||data.indexedOffset<offset*25)fail('email_network_list_unqualified');
    const rows=[];let unsupported=0;
    for(const edge of data.edges) {
      const node=edge?.node,id=node?.ItemId?.Id,thread=node?.ConversationId?.Id,received=Date.parse(node?.DateTimeReceived);
      if(!/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/.test(id||'')||!/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/.test(thread||'')||typeof node.DateTimeReceived!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(node.DateTimeReceived)||typeof node.IsDraft!=='boolean'||typeof node.IsRead!=='boolean'||!Number.isFinite(received)||node.ParentFolderId?.Id!==folder.id){unsupported++;continue;}
      const row={provider_message_id:id,provider_selection_id:thread,provider_thread_id:thread,received_at:node.DateTimeReceived,draft:node.IsDraft,unread:!node.IsRead,sent:false,inbox:folder.inbox,folder:folder.inbox?'inbox':'outlook:'+folder.id};
      receiveRows([row]);
      if(!node.IsDraft&&received>=start&&received<end)rows.push(row);
    }
    const scopeBytes=new TextEncoder().encode(JSON.stringify(folders.map(folder=>folder.id)));
    const folder_scope_id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',scopeBytes)),n=>n.toString(16).padStart(2,'0')).join('');
    const more=data.pageInfo.hasNextPage||folderIndex+1<folders.length;
    if(data.pageInfo.hasNextPage&&offset===4095)fail('email_network_list_unqualified');
    return {provider:'outlook',account_address:owner,rows,unsupported_rows:unsupported,has_next:more,
      ...(more?{next_page:data.pageInfo.hasNextPage?page+1:(folderIndex+1)*4096}:{}),page,folder_scope_id,scope:inbox.qualified?'inbound_received':'inbox_loaded'};
  }
  async function prepareOriginal({account_address,provider_message_id}) {
    return originalResolver.prepare({account_address,provider_message_id});
  }
  function dispose(){active=false;range.dispose();originalResolver.dispose();bridge.detach(consumer);if(!existing)bridge.dispose();for(const waiter of pending.values())waiter.reject(Object.assign(new Error('email_network_read_failed'),{code:'email_network_read_failed'}));pending.clear();templates.clear();}

  return {listPage,armRangeSearch:range.arm,resetRound:range.resetRound,prepareOriginal,dispose,diagnostics(){return {itemTemplate:templates.has('ItemRows'),inboxTemplate:Boolean(getInbox()&&templates.has('ConversationRows:'+getInbox().id)),templateCount:templates.size,original:originalResolver.diagnostics()};}};
}
