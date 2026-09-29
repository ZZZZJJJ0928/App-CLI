// The native search service supports Message entities and exact FolderId terms.
// Arm only in a Controller-owned tab, then consume its ONE native search request.
// Credentials/request headers stay in the page; no warm-up list is replayed.
export function installOutlookRangeTransport({account,getInbox,receiveRows}) {
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  const pattern=/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/;
  function timestamp(value) {
    const match=typeof value==='string'&&/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
    if(!match)return null;
    const wall=Date.parse(match[1]+'Z'),zone=match[3];
    if(!Number.isFinite(wall)||new Date(wall).toISOString().slice(0,19)!==match[1]||zone!=='Z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4))>59))return null;
    const seconds=Date.parse(match[1]+zone);
    if(!Number.isFinite(seconds))return null;
    return BigInt(seconds)*1000000n+BigInt((match[2]||'').padEnd(9,'0'));
  }
  function utc(ns) {
    let seconds=ns/1000000000n,fraction=ns%1000000000n;
    if(fraction<0){seconds--;fraction+=1000000000n;}
    const suffix=fraction.toString().padStart(9,'0').replace(/0+$/,'');
    return new Date(Number(seconds)*1000).toISOString().slice(0,19)+(suffix?'.'+suffix:'')+'Z';
  }
  let armed=null,active=true;
  function validate(request) {
    const owner=account(request.account_address),inbox=getInbox();
    const start=timestamp(request.interval_start),end=timestamp(request.interval_end);
    if(location.origin!=='https://outlook.live.com'||!inbox?.qualified||inbox.account!==owner||!inbox.folders?.length)fail('email_network_list_unqualified');
    if(start===null||end===null||start>=end||request.page!==0||request.provider_mode!=='time_range'||inbox.folders.length>100)fail('invalid_request');
    // Normalize RFC3339 offsets while preserving nanosecond boundaries.
    if(!inbox.folders.every(f=>pattern.test(f.id)))fail('email_network_list_unqualified');
    return {owner,start,end,folders:structuredClone(inbox.folders),query:`received>=${utc(start)} AND received<${utc(end)}`};
  }
  function arm(request) {
    if(!active||armed)fail('email_network_list_unqualified');
    const state=validate(request);
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    promise.catch(()=>{}); // The trusted UI trigger precedes the consumer call.
    const abort=new AbortController();
    const timer=setTimeout(()=>{abort.abort();reject(Object.assign(new Error('email_network_read_failed'),{code:'email_network_read_failed'}));},20000);
    armed={...state,request:structuredClone(request),promise,resolve,reject,abort,timer,network:null};
    return {query:state.query};
  }
  async function decode(response) {
    if(!response.ok||new URL(response.url).origin!==location.origin)fail('email_network_read_failed');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>10<<20)fail('email_network_list_unqualified');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{return JSON.parse(new TextDecoder().decode(bytes));}catch{fail('email_network_list_unqualified');}
  }
  function fetchSearch(args,next) {
    const state=armed;
    let body,url;
    try{url=new URL(typeof args[0]==='string'?args[0]:args[0]?.url,location.href);body=JSON.parse(args[1]?.body);}catch{return next(...args);}
    if(!active||!state||url.origin!==location.origin||url.pathname!=='/searchservice/api/v2/query'||body?.EntityRequests?.[0]?.Query?.QueryString!==state.query)return next(...args);
    if(state.network)return state.network.then(r=>r.clone());
    state.network=(async()=>{
      account(state.owner);
      if(args[1]?.method?.toUpperCase()!=='POST'||body.EntityRequests.length!==1||body.EntityRequests[0].ContentSources?.join(',')!=='Exchange')fail('email_network_list_unqualified');
      const entity=body.EntityRequests[0];
      entity.EntityType='Message';entity.From=0;entity.Size=50;
      entity.EnableTopResults=false;entity.TopResultsCount=0;entity.RefiningQueries=null;
      entity.Sort=[{Field:'Time',SortDirection:'Desc'}];
      entity.Filter={Or:state.folders.map(f=>({Term:{FolderId:f.id}}))};
      body.QueryAlterationOptions={...(body.QueryAlterationOptions||{}),EnableSuggestion:false,EnableAlteration:false};
      const response=await next(args[0],{...args[1],body:JSON.stringify(body),signal:state.abort.signal,redirect:'error'});
      const value=await decode(response.clone());account(state.owner);
      if(!active||armed!==state||state.abort.signal.aborted)fail('email_network_read_failed');
      state.resolve(value);clearTimeout(state.timer);return response;
    })().catch(cause=>{clearTimeout(state.timer);state.reject(cause);throw cause;});
    return state.network.then(r=>r.clone());
  }
  async function listPage(request) {
    const expected=validate(request),state=armed;
    if(!state||state.query!==expected.query||state.owner!==expected.owner||JSON.stringify(state.folders)!==JSON.stringify(expected.folders))fail('email_network_list_unqualified');
    const value=await state.promise;account(state.owner);
    if(!active||armed!==state||state.abort.signal.aborted)fail('email_network_read_failed');
    if(!value||typeof value!=='object'||Array.isArray(value))fail('email_network_list_unqualified');
    const entity=value?.EntitySets?.[0],result=entity?.ResultSets?.[0];
    if(value.EntitySets?.length!==1||entity.EntityType!=='Message'||entity.IsPartial!==false||entity.Properties?.HasParseException!==false||entity.ResultSets?.length!==1||
      !Number.isSafeInteger(result?.Total)||result.Total<0||typeof result.MoreResultsAvailable!=='boolean')fail('email_network_list_unqualified');
    const sources=result.Results??(result.Total===0?[]:null);
    if(!Array.isArray(sources)||sources.length>50||result.Total<sources.length||(!result.MoreResultsAvailable&&result.Total!==sources.length))fail('email_network_list_unqualified');
    const rows=[],ids=new Set(),folders=new Map(state.folders.map(f=>[f.id,f]));let unsupported=0;
    for(const item of sources){
      const node=item?.Source,id=typeof node?.ImmutableId==='string'?node.ImmutableId.replace(/_/g,'+').replace(/-/g,'/'):null;
      const thread=node?.ConversationId?.Id,folder=folders.get(node?.ParentFolderId?.Id),received=timestamp(node?.DateTimeReceived);
      // The native Message adapter uses this immutable EWS form. Ordinary
      // ItemId can change on a folder move and must not own a second source.
      if(item.Type!=='Message'||!pattern.test(id||'')||!pattern.test(node?.ItemId?.Id||'')||!pattern.test(thread||'')||ids.has(id)||!folder||typeof node.IsDraft!=='boolean'||typeof node.IsRead!=='boolean'||received===null||received<state.start||received>=state.end){unsupported++;continue;}
      ids.add(id);if(node.IsDraft)continue;
      rows.push({provider_message_id:id,provider_selection_id:thread,provider_thread_id:thread,received_at:node.DateTimeReceived,draft:false,unread:!node.IsRead,sent:false,inbox:folder.inbox,folder:folder.inbox?'inbox':'outlook:'+folder.id});
    }
    receiveRows(rows);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(state.folders.map(f=>f.id))));
    if(!active||armed!==state||state.abort.signal.aborted)fail('email_network_read_failed');
    return {provider:'outlook',account_address:state.owner,rows,unsupported_rows:unsupported,has_next:result.MoreResultsAvailable,page:0,scope:'inbound_received',folder_scope_id:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')};
  }
  function resetRound(){if(armed){clearTimeout(armed.timer);armed.abort.abort();armed.reject(Object.assign(new Error('email_network_read_failed'),{code:'email_network_read_failed'}));}armed=null;}
  function dispose(){active=false;resetRound();}
  return {arm,listPage,fetchSearch,resetRound,dispose};
}
