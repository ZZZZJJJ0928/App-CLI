// Calls the actually installed userscript; it never injects replacement source.
// Provider adapters own URLs, request templates, parsing and account checks.
const NETWORK_READER_VERSION = '0.2.0';

function networkError(code, diagnosticStage) {
  return Object.assign(new Error(code), { code }, /^(?:qq_(?:source|request|json|head|total|lock|list|complete))$/u.test(diagnosticStage) ? { diagnosticStage } : {});
}

async function callReader(tab, provider, method, request, { required = false } = {}) {
  if (typeof tab.runReadCode !== 'function') {
    if (required) throw networkError('email_network_capability_unavailable');
    return null;
  }
  const value = await tab.runReadCode(`async page=>page.evaluate(async ({provider,method,request})=>{
    const deadline=Date.now()+5000;
    const initializeRange=method==='listPage'&&request?.provider_mode==='time_range';
    for(;;){
      const reader=window.SparkClawMailReader;
      if(!reader&&(method==='snapshot'||initializeRange)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));continue;}
      if(reader?.provider!==provider||reader.version!==${JSON.stringify(NETWORK_READER_VERSION)}||typeof reader[method]!=='function')return null;
      try{
        if(initializeRange){
          // Local readiness and the one native list request share a browser
          // round trip. Retry only the local pre-request identity check.
          try{reader.snapshot(request);}catch(error){
            if(error.code==='email_account_identity_unavailable'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));continue;}
            throw error;
          }
        }
        return await reader[method](request??{});
      }catch(error){
        // Initial page hydration may precede the account header. Waiting for
        // local identity is not another list request, and has no fixed delay.
        if(method==='snapshot'&&error.code==='email_account_identity_unavailable'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));continue;}
        let diagnostic_stage;
        try {diagnostic_stage=reader.diagnostics?.().list?.stage;} catch {}
        return {error:error.code||'email_network_read_failed',diagnostic_stage};
      }
    }
  },${JSON.stringify({provider,method,request})})`);
  if (value?.error) throw networkError(value.error, value.diagnostic_stage);
  if (value === null && required) {
    throw networkError('email_network_capability_unavailable');
  }
  return value;
}

export async function networkSnapshot(tab, provider, options, { required = false } = {}) {
  const value = await callReader(tab, provider, 'snapshot', options, { required });
  if (value === null) return null;
  if (value.provider !== provider || options.account_address && value.account_address !== options.account_address.toLowerCase() ||
      !Array.isArray(value.rows) || !Number.isInteger(value.unsupported_rows) || value.unsupported_rows < 0 ||
      value.scan_complete !== false) throw networkError('email_network_list_unqualified');
  return { ...value, network_reader: true };
}

export async function networkMarkRead(tab, provider, target) {
  const value = await callReader(tab, provider, 'markRead', target, { required: true });
  if (!value || value.provider !== provider || value.account_address !== target.account_address.toLowerCase() ||
      value.provider_message_id !== target.provider_message_id || !['read', 'unknown'].includes(value.read_state)) {
    throw networkError('email_network_mark_read_unqualified');
  }
  return value.read_state;
}

export async function prepareNetworkOriginal(tab, provider, target, {retained = false} = {}) {
  const value = await callReader(tab, provider, retained ? 'prepareRetainedOriginal' : 'prepareOriginal', target, { required: true });
  if (!value || value.provider_message_id !== target.provider_message_id ||
      value.account_address !== target.account_address.toLowerCase() ||
      typeof value.selector !== 'string' || value.selector !== '#sparkclaw-mail-original' ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 110 << 20) {
    throw networkError('email_network_original_unqualified');
  }
  if (Object.hasOwn(value, 'inline_base64')) {
    if (!Number.isSafeInteger(value.inline_bytes) || value.inline_bytes < 0 || value.inline_bytes > 1 << 20 ||
        value.inline_bytes !== value.bytes || typeof value.inline_base64 !== 'string' ||
        value.inline_base64.length > 1_400_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.inline_base64) ||
        Buffer.byteLength(value.inline_base64, 'ascii') !== value.inline_base64.length ||
        Math.floor(value.inline_base64.length * 3 / 4) - (value.inline_base64.endsWith('==') ? 2 : value.inline_base64.endsWith('=') ? 1 : 0) !== value.bytes) {
      throw networkError('email_network_original_unqualified');
    }
  }
  return value;
}

export async function networkListPage(tab, provider, options, observedListed) {
  if (!['gmail','outlook','qq_mail'].includes(provider) || options?.lane !== 'recent_inbound' || typeof tab.runReadCode !== 'function') return null;
  // Explicit timeline mode uses the provider's bounded native search only.
  if (options.provider_mode && (options.provider_mode !== 'time_range' || options.continuation)) throw networkError('email_incremental_unqualified');
  const {createHash} = await import('node:crypto');
  const scope = createHash('sha256').update(JSON.stringify([provider,options.account_address.toLowerCase(),options.interval_start,options.interval_end])).digest('hex');
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let position={s:scope,p:0,o:0,d:'',h:scope};
  if(options.continuation?.startsWith('n1:')) {
    try {
      const parsed=JSON.parse(Buffer.from(options.continuation.slice(3),'base64url').toString('utf8'));
      if(Object.keys(parsed).sort().join(',')!=='d,h,o,p,s'||!/^([a-f0-9]{64})?$/.test(parsed.d)||!/^([a-f0-9]{64})$/.test(parsed.h)||parsed.s!==scope||!Number.isInteger(parsed.p)||parsed.p<0||parsed.p>(provider==='outlook'?409599:10000)||!Number.isInteger(parsed.o)||parsed.o<0||parsed.o>50000)throw new Error();
      position=parsed;
    } catch {throw Object.assign(new Error('email_cursor_invalid'),{code:'email_cursor_invalid'});}
  }
  const requestPage=async index=>{
    const request={account_address:options.account_address,interval_start:options.interval_start,interval_end:options.interval_end,page:index,folder:options.folder ?? 'inbox',...(options.provider_mode?{provider_mode:options.provider_mode}:{})};
    const value=provider==='outlook'&&options.provider_mode==='time_range'
      ?await tab.runReadCode(`async page=>{
        const request=${JSON.stringify(request)};
        const armed=await page.evaluate(request=>{
          const reader=window.SparkClawMailReader;
          if(reader?.provider!=='outlook'||reader.version!==${JSON.stringify(NETWORK_READER_VERSION)}||!reader.armRangeSearch)return {error:'email_network_capability_unavailable'};
          try{return reader.armRangeSearch(request);}catch(error){return {error:error.code||'email_network_read_failed'};}
        },request);
        if(armed.error)return armed;
        await page.locator('#topSearchInput').fill(armed.query);
        await page.locator('#topSearchInput').press('Enter');
        return page.evaluate(async request=>{
          try{return await window.SparkClawMailReader.listPage(request);}catch(error){return {error:error.code||'email_network_read_failed'};}
        },request);
      }`)
      :await callReader(tab,provider,'listPage',request,{required:true});
    if(value?.error)throw Object.assign(new Error(value.error),{code:value.error});
    if(value?.has_next && value.next_page!==undefined && (!Number.isInteger(value.next_page)||value.next_page<=index||value.next_page>409599))throw Object.assign(new Error('email_network_list_unqualified'),{code:'email_network_list_unqualified'});
    if(value && provider==='outlook' && !['inbound_received','inbox_loaded'].includes(value.scope))throw Object.assign(new Error('email_network_list_unqualified'),{code:'email_network_list_unqualified'});
    if(value && provider==='qq_mail' && value.scope!=='inbound_received')throw Object.assign(new Error('email_network_list_unqualified'),{code:'email_network_list_unqualified'});
    if(value && (value.provider!==provider||value.account_address!==options.account_address.toLowerCase()||value.page!==index||!Array.isArray(value.rows)||typeof value.has_next!=='boolean'||!Number.isInteger(value.unsupported_rows)||value.unsupported_rows<0))throw Object.assign(new Error('email_network_list_unqualified'),{code:'email_network_list_unqualified'});
    return value;
  };
  // Continuations are durable metadata, while Gmail's opaque pagination tokens
  // remain solely in the document. Rebuild that token chain after reopening.
  if(provider==='gmail')for(let index=0;index<position.p;index++)if(!await requestPage(index))return null;
  const page=await requestPage(position.p);
  if(!page)return null;
  // Read state changes during capture must not invalidate a receipt-time page.
  const fingerprint=value=>hash([value.rows.map(row=>[row.provider_message_id,row.provider_thread_id,row.received_at]),value.unsupported_rows,value.has_next,value.next_page,value.folder_scope_id]);
  const digest=fingerprint(page);
  if(position.d && position.d!==digest)position={...position,o:0,d:''};
  const candidate=member=>({account_address:page.account_address,provider_message_id:member.provider_message_id,provider_selection_id:member.provider_thread_id,provider_thread_id:member.provider_thread_id,...(member.native_message_id?{provider_native_id:member.native_message_id}:{}),...(provider==='outlook'?{received_at:member.received_at}:{}),folder:member.folder??(member.inbox?'inbox':'all')});
  const selected=[];let candidateBytes=0;
  for(const member of page.rows.slice(position.o,position.o+options.limit)){
    const bytes=Buffer.byteLength(JSON.stringify(candidate(member)));
    if(candidateBytes+bytes>40<<10){
      // Local serialization limits are operational failures, not evidence of a
      // provider interval overflow that may be converted to a terminal gap.
      if(options.provider_mode)throw networkError('email_batch_limit');
      break;
    }
    candidateBytes+=bytes;selected.push(member);
  }
  const more=position.o+selected.length<page.rows.length;
  let next=more?{...position,o:position.o+selected.length,d:digest}:page.has_next?{...position,p:page.next_page??position.p+1,o:0,d:'',h:hash([position.h,digest])}:null;
  const unsupported=page.unsupported_rows;
  if (unsupported && !more) next={...position,o:0}; // Never step past an unresolved page.
  // Offset pagination can shift when a user moves/deletes mail. Before issuing
  // a boundary certificate, re-observe the scanned prefix and verify its chain.
  let changed=false;
  if(!next && unsupported===0 && position.p>0) {
    let chain=scope;
    let index=0,steps=0;
    while(index<position.p && steps++<10000) {
      const prior=await requestPage(index);
      if(!prior || !prior.has_next){changed=true;break;}
      chain=hash([chain,fingerprint(prior)]);
      index=prior.next_page??index+1;
    }
    changed ||= index!==position.p;
    changed ||= chain!==position.h;
    if(changed)next={s:scope,p:0,o:0,d:'',h:scope};
  }
  // Outlook remains partial until its startup hierarchy proves the inbox
  // scope. QQ's observed inbox pagination is an explicit bounded scope.
  const incompleteScope=(provider==='outlook' && page.scope==='inbox_loaded');
  const complete=!next&&unsupported===0&&!incompleteScope;
  const groups=new Map();
  for(const member of page.rows){const group=groups.get(member.provider_thread_id)||[];group.push(member);groups.set(member.provider_thread_id,group);}
  const rows=[...groups].map(([thread,members])=>({provider_thread_id:thread,provider_selection_id:provider==='outlook'||provider==='gmail'?thread:members.at(-1).provider_message_id,provider_message_id:members.at(-1).provider_message_id,
    members:members.map(member=>({...member,local:true})),inventory_complete:false,network_member_proven:provider==='outlook',unread:members.some(m=>m.unread)}));
  const candidates=selected.map(candidate);
  return {listed:{...observedListed,account_address:page.account_address,rows,network_reader:true},discovery:{schema_version:1,provider,status:complete?(candidates.length?'listed':'empty'):'partial',account_address:page.account_address,candidates,threads:[],
    coverage:{scope:'inbound_received',lane:'recent_inbound',scan_complete:complete,boundary_qualified:complete,scanned_rows:page.rows.length+unsupported,unsupported_rows:unsupported,limited:!complete,
      ...(next?{continuation:'n1:'+Buffer.from(JSON.stringify(next)).toString('base64url')}:{}),...(complete?{}:{reason:unsupported?'network_rows_unqualified':changed?'network_page_changed':incompleteScope?'folder_scope_and_pagination_unqualified':'network_page_continues'})},observed_at:new Date().toISOString()}};
}
