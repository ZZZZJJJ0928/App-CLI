// Bundled into the three managed userscripts. No credentials or raw provider
// payloads are exposed by the public API; the Gateway owns durable checkpoints.
export function installReader(config) {
  'use strict';
  if (window.top !== window || !config.origins.includes(location.origin)) return;
  window.SparkClawMailReader?.dispose();
  const originalFetch = window.fetch, originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send, originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const records = new Map(), pageTokens = new Map();
  let listRequest = null, networkQuery = null, inbox = null, transport = null, objectURL = null, originalAbort = null;
  let originalBytes = null, originalMessageID = '';
  let originalState = 'unlearned', responseOrigin = '';
  let originalResponse = null;
  // QQ rejects bursts of otherwise valid /read/readmail requests with its
  // -20003 abuse-control envelope. Space completed original requests across
  // Reader rounds; resetting source buffers must not reset this pacing.
  let qqOriginalReadyAt = 0;
  let listStage = 'idle';
  let nativeQueryReply = null;
  let active = true, account = '', binding = null, anchor = null;
  let pendingOperations = 0;
  const idPattern = /^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/;
  const failure = code => { throw Object.assign(new Error(code), {code}); };
  async function inRound(operation, request) {
    if (!active) failure('email_network_capability_unavailable');
    pendingOperations++;
    try { return await operation(request); } finally { pendingOperations--; }
  }
  // Only the Controller's idle mailbox lease may reset a round. Keep learned
  // transport/session templates, but never retain source bytes or query results
  // across polls. This performs no network request and does not retry failures.
  function resetRound({account_address} = {}) {
    if (!active || pendingOperations || originalAbort) failure('email_network_list_unqualified');
    checkedAccount(account_address);
    if(config.provider==='outlook' && typeof transport?.resetRound!=='function') failure('email_network_capability_unavailable');
    transport?.resetRound?.();
    records.clear(); pageTokens.clear(); networkQuery=null; nativeQueryReply=null;
    anchor?.remove(); anchor=null;
    if(objectURL)URL.revokeObjectURL(objectURL);
    objectURL=null; originalBytes=null; originalMessageID='';
    originalState='unlearned'; responseOrigin=''; originalResponse=null; listStage='idle';
    return {provider:config.provider,account_address:account};
  }
  // Gateway checkpoints carry micro/nanoseconds; Date.parse alone truncates
  // those bounds and can falsely certify a missed endpoint millisecond.
  function instantNanos(value) {
    const match=typeof value==='string'&&/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    if(!match)return null;
    const seconds=Date.parse(match[1]+match[3]);
    const offset=match[3]==='Z'?0:(match[3][0]==='-'?-1:1)*(Number(match[3].slice(1,3))*60+Number(match[3].slice(4,6)));
    if(!Number.isFinite(seconds)||new Date(seconds+offset*60000).toISOString().slice(0,19)!==match[1])return null;
    return BigInt(seconds)*1000000n+BigInt((match[2]||'').padEnd(9,'0'));
  }
  const inlineOriginalLimit = 1 << 20;
  const base64 = bytes => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };
  function checkedAccount(expected) {
    const current = config.account();
    if (!current) failure('email_account_identity_unavailable');
    if (account && account !== current.toLowerCase()) {
      records.clear(); pageTokens.clear(); binding = null; listRequest = null; networkQuery = null; nativeQueryReply = null; inbox = null; transport?.dispose();
      failure('email_account_identity_mismatch');
    }
    account = current.toLowerCase();
    if (expected && expected.toLowerCase() !== account) failure('email_account_identity_mismatch');
    return account;
  }
  function observe(url, text, requestQuery) {
    if (!active || typeof text !== 'string' || text.length > 10 << 20) return;
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin || !config.listURL(u)) return;
      const value = JSON.parse(text);
      if(config.provider==='gmail' && typeof requestQuery==='string') nativeQueryReply={query:requestQuery,value};
      if(config.provider==='outlook' && u.pathname.endsWith('/startupdata.ashx')) {
        const owner=value.owaUserConfig?.SessionSettings?.UserEmailAddress, id=value.findConversation?.Body?.FolderId?.Id;
        if(typeof owner==='string' && typeof id==='string')inbox=config.parseFolders?.(value)||{account:owner.toLowerCase(),id,qualified:false};
      }
      const rows = config.parse(value);
      if (!rows) return;
      checkedAccount();
      for (const row of rows) {
        if (row && row.provider_selection_id === undefined) row.provider_selection_id = row.provider_thread_id || row.provider_message_id;
        if (!idPattern.test(row.provider_message_id || '')) continue;
        records.set(row.provider_message_id, row);
      }
      while (records.size > 2000) records.delete(records.keys().next().value);
      if (config.provider === 'qq_mail' && u.searchParams.get('func') === '1' && u.searchParams.get('sid')) binding = u;
    } catch { /* Unqualified responses never become admitted source evidence. */ }
  }
  function rememberListRequest(request, body) {
    try {
      const url = new URL(request.url, location.href);
      if (url.origin !== location.origin || !config.listURL(url)) return;
      listRequest = {method: request.method, url, headers: {...(request.headers || {})}, ...(body === undefined ? {} : {body})};
    } catch {}
  }
  function qqListSource() {
    const source = listRequest || binding;
    if (source) return new URL(source.url || source, location.href);
    // The current QQ client can restore /home/index from its own cache without
    // issuing /list/maillist again. Its signed-in route still carries the same
    // first-party session id required by /list/search, so construct only the
    // fixed list binding instead of depending on an incidental resource entry.
    try {
      const current = new URL(location.href);
      const sid = current.origin===location.origin && current.pathname==='/home/index'
        ? current.searchParams.get('sid') : '';
      if(sid && sid.length<=4096) {
        const url=new URL('/list/maillist',location.origin);
        url.searchParams.set('func','1');url.searchParams.set('sid',sid);
        return url;
      }
    } catch {}
    // QQ can load its first list before the userscript's fetch/XHR hooks run.
    const resources = performance.getEntriesByType('resource');
    for (let index = resources.length - 1; index >= 0; index--) {
      try {
        const url = new URL(resources[index].name);
        if (url.origin === location.origin && url.pathname === '/list/maillist' &&
            url.searchParams.get('func') === '1' && url.searchParams.get('sid')) return url;
      } catch {}
    }
    return null;
  }
  const open = function(method, url, ...args) {
    this.__sparkclawMailURL = url;
    this.__sparkclawMailRequest = {method, url, headers:{}};
    return originalOpen.call(this, method, url, ...args);
  };
  const setHeader = function(key, value) {
    if (this.__sparkclawMailRequest) this.__sparkclawMailRequest.headers[key.toLowerCase()] = value;
    return originalSetHeader.call(this,key,value);
  };
  const send = function(...args) {
    try {
      const request = this.__sparkclawMailRequest;
      const body = args[0] === undefined ? undefined : JSON.parse(args[0]);
      if (request) {
        const previous = listRequest?.body?.[0]?.[3];
        rememberListRequest(request, body);
        if (previous && body?.[0]?.[3] !== previous) pageTokens.clear();
      }
    } catch {}
    const url = this.__sparkclawMailURL;
    let requestQuery;
    try { requestQuery=JSON.parse(args[0])?.[0]?.[3]; } catch {}
    this.addEventListener('load', () => {
      if (this.status === 200 && (!this.responseType || this.responseType === 'text')) observe(url, this.responseText, requestQuery);
    }, {once:true});
    return originalSend.apply(this, args);
  };
  const fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const u = new URL(response.url);
      if (u.origin === location.origin && config.listURL(u)) {
        if (!listRequest) rememberListRequest({method:String(args[1]?.method || 'GET').toUpperCase(), url:u, headers:args[1]?.headers || {}}, args[1]?.body ? JSON.parse(args[1].body) : undefined);
      }
      if (active && response.ok && u.origin === location.origin && config.listURL(u) && Number(response.headers.get('content-length')) <= 10 << 20) {
        void (async () => {
          const copy = response.clone(), reader = copy.body.getReader(), chunks = []; let size = 0;
          try {
            for (;;) { const {done,value} = await reader.read(); if (done) break;
              size += value.length; if (size > 10 << 20) { void reader.cancel(); return; } chunks.push(value); }
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            let requestQuery;try{requestQuery=JSON.parse(args[1]?.body)?.[0]?.[3];}catch{}
            observe(response.url, new TextDecoder().decode(bytes),requestQuery);
          } finally { reader.releaseLock(); }
        })().catch(()=>{});
      }
    } catch {}
    return response;
  };
  XMLHttpRequest.prototype.open = open; XMLHttpRequest.prototype.send = send; XMLHttpRequest.prototype.setRequestHeader = setHeader;
  window.fetch = fetch;
  function snapshot({account_address, interval_start, interval_end} = {}) {
    checkedAccount(account_address);
    const start = instantNanos(interval_start), end = instantNanos(interval_end);
    if (start===null || end===null || start >= end) failure('invalid_request');
    let unsupported = 0;
    const rows = [];
    for (const row of records.values()) {
      if (row.draft || row.sent) continue;
      if (row.grouped) { unsupported++; continue; }
      const received = instantNanos(row.received_at);
      if (received===null) { unsupported++; continue; }
      if (received >= start && received < end) rows.push({...row});
    }
    return {provider:config.provider, account_address:account, rows, unsupported_rows:unsupported,
      scan_complete:false, reason:'folder_scope_and_pagination_unqualified'};
  }
  async function prepareRetainedOriginal(target = {}) {
    const {account_address,provider_message_id,provider_selection_id,provider_native_id,folder}=target;
    checkedAccount(account_address);
    if(!idPattern.test(provider_message_id||'')||!idPattern.test(provider_selection_id||'')||folder==='sent')failure('invalid_request');
    // These IDs came from a previous qualified list and were retained by the
    // Gateway. Reuse the exact original endpoint without searching the inbox.
    const row={provider_message_id,provider_selection_id,native_message_id:provider_native_id,folder,draft:false,sent:false};
    if(config.provider==='gmail') {
      if(!/^(?:msg-f:\d+|msg-a:r-?\d+)$/u.test(provider_native_id||''))failure('email_network_target_unobserved');
      if(provider_native_id.startsWith('msg-f:')&&(!/^[a-f0-9]{1,32}$/u.test(provider_message_id)||BigInt(`0x${provider_message_id}`).toString()!==provider_native_id.slice(6)))failure('email_network_target_unobserved');
    }
    if(config.provider==='qq_mail') {
      if(/^(?:C|@)/u.test(provider_message_id))failure('email_network_target_unobserved');
      binding=qqListSource();
      if(!binding)failure('email_network_original_unqualified');
    }
    return prepareOriginal(target,row);
  }
  async function prepareOriginal({account_address, provider_message_id} = {}, retainedRow = null) {
    checkedAccount(account_address);
    if (!idPattern.test(provider_message_id || '')) failure('invalid_request');
    const row = retainedRow || records.get(provider_message_id);
    if (!row || row.draft || row.grouped) failure('email_network_target_unobserved');
    let url = await config.download?.({id:provider_message_id, row, binding, request:listRequest});
    if (!url && config.provider==='outlook' && transport?.prepareOriginal) url = await transport.prepareOriginal({account_address:account,provider_message_id});
    if (!url) failure('email_network_original_unqualified');
    try {
      url = new URL(url, location.href);
      if (url.protocol !== 'https:' || url.username || url.password ||
          (url.origin !== location.origin && !(config.provider === 'gmail' && url.origin === 'https://mail-attachment.googleusercontent.com') &&
            !(config.provider === 'outlook' && url.origin === 'https://attachment.outlook.live.net'))) failure('email_network_original_unqualified');
    } catch (error) { failure(error.code || 'email_network_original_unqualified'); }
    if(originalAbort)failure('email_network_original_unqualified');
    originalState='fetching';originalResponse=null;originalAbort=new AbortController();
    const originalSignal=AbortSignal.any([originalAbort.signal,AbortSignal.timeout(20000)]);
    let requested=false;
    return (async()=>{
      try {
        if(config.provider==='qq_mail') {
          const delay=qqOriginalReadyAt-performance.now();
          if(delay>0) {
            originalState='pacing';
            await new Promise((resolve,reject)=>{
              const aborted=()=>{clearTimeout(timer);originalSignal.removeEventListener('abort',aborted);reject(originalSignal.reason);};
              const timer=setTimeout(()=>{originalSignal.removeEventListener('abort',aborted);resolve();},delay);
              originalSignal.addEventListener('abort',aborted,{once:true});
              if(originalSignal.aborted)aborted();
            });
          }
          checkedAccount(account_address);
        }
        originalSignal.throwIfAborted();
        if(!active)failure('email_network_original_unqualified');
        originalState='fetching';requested=true;
        const response=await originalFetch.call(window,url.href,{credentials:url.origin===location.origin?'same-origin':'omit',redirect:config.provider==='gmail'?'follow':'error',cache:'no-store',signal:originalSignal});
        originalState='http_'+response.status;responseOrigin=response.url?new URL(response.url).origin:'';
        const mediaType=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
        originalResponse={status:response.status,type:['message/rfc822','text/plain','text/html','application/json','application/octet-stream'].includes(mediaType)?mediaType:'other',bytes:0};
        if(response.url&&responseOrigin!==url.origin&&!(config.provider==='gmail'&&responseOrigin==='https://mail-attachment.googleusercontent.com'))failure('email_network_original_unqualified');if(!response.ok)failure('email_network_original_unqualified');
        const reader=response.body.getReader(),chunks=[];let length=0;
        try {
          for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>110<<20){void reader.cancel();failure('email_capture_limit');}chunks.push(value);}
        }finally{reader.releaseLock();}
        checkedAccount(account_address);
        if(!active)failure('email_network_original_unqualified');
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        originalResponse.bytes=length;
        const header=new TextDecoder().decode(bytes.subarray(0,Math.min(bytes.length,65536)));
        const headerEnd=header.search(/\r?\n\r?\n/);
        const headerBlock=headerEnd<0?'':header.slice(0,headerEnd);
        let precedingField=false;
        const validHeaders=headerBlock.split(/\r?\n/).every(line=>{
          if(/^[ \t]/.test(line))return precedingField;
          precedingField=/^[!-9;-~]+:/.test(line);
          return precedingField;
        });
        // A provider's HTML "show original" page may embed From: and a blank
        // line much later. It is an adapter response error, not a bad email and
        // must never consume a mail-specific retry allowance.
        if(headerEnd<0||!validHeaders||!/^From:/im.test(headerBlock)) {
          originalState='invalid_headers';
          // Retain only bounded numeric provider status, never response text,
          // headers, request URLs or mailbox identities in diagnostics.
          if(config.provider==='qq_mail' && length<=65536) {
            try {const code=JSON.parse(header)?.head?.ret;if(Number.isSafeInteger(code)&&Math.abs(code)<=1000000)originalResponse.provider_code=code;} catch {}
            if(mediaType==='application/json' && originalResponse.provider_code===-20003) {
              originalState='provider_rejected';
              failure('email_network_read_failed');
            }
          }
          failure('email_network_original_unqualified');
        }
        anchor?.remove();if(objectURL)URL.revokeObjectURL(objectURL);
        originalBytes = bytes;
        originalMessageID = provider_message_id;
        objectURL=URL.createObjectURL(new Blob([bytes],{type:'message/rfc822'}));
        anchor=document.createElement('a');anchor.id='sparkclaw-mail-original';anchor.href=objectURL;
        anchor.download='message.eml';anchor.textContent='SparkClaw EML';anchor.hidden=true;document.body.append(anchor);
        originalState='ready';
        const result={selector:'#sparkclaw-mail-original',account_address:account,provider_message_id,bytes:bytes.length};
        if(bytes.length<=inlineOriginalLimit) { result.inline_bytes=bytes.length; result.inline_base64=base64(bytes); }
        return result;
      }catch(error){
        if(['email_account_identity_mismatch','email_account_identity_unavailable','email_capture_limit','email_network_read_failed'].includes(error.code))throw error;
        if(originalState==='fetching')originalState='fetch_failed';failure('email_network_original_unqualified');
      }finally{
        if(config.provider==='qq_mail' && requested)qqOriginalReadyAt=performance.now()+1000;
        originalAbort=null;
      }
    })();
  }

  async function listPage({account_address,interval_start,interval_end,page=0,folder='inbox',provider_mode}) {
    checkedAccount(account_address);
    if(config.provider==='outlook' && transport?.listPage)return transport.listPage({account_address,interval_start,interval_end,page,folder,provider_mode});
    if (config.provider === 'qq_mail') {
      listStage='qq_source';
      const start=instantNanos(interval_start), end=instantNanos(interval_end);
      if (start===null||end===null||start>=end||!Number.isInteger(page)||page<0||page>128) failure('invalid_request');
      const deadline=Date.now()+5000;
      let url=qqListSource();
      while(!url && Date.now()<deadline) {
        await new Promise(resolve=>setTimeout(resolve,100));
        url=qqListSource();
      }
      if (!url || url.origin!==location.origin || url.pathname!=='/list/maillist' || url.searchParams.get('func') !== '1' || !url.searchParams.get('sid')) failure('email_network_list_unqualified');
      if(provider_mode==='time_range') {
        if(page!==0)failure('email_incremental_unqualified');
        // QQ's current public web client uses /list/search with epoch-second
        // after/before parameters. No mailbox-head pagination participates.
        const search=new URL('/list/search',location.origin);
        search.searchParams.set('sid',url.searchParams.get('sid'));
        const body=new URLSearchParams({page_now:'0',page_size:'50',after:String(start/1000000000n-1n),before:String((end+999999999n)/1000000000n),sort_type:'1',sort_direction:'1'});
        listStage='qq_request';
        const response=await originalFetch.call(window,search.href,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(20000)});
        if([401,403].includes(response.status))failure('email_login_required');if(!response.ok)failure('email_network_read_failed');
        const reader=response.body.getReader(),chunks=[];let length=0;
        try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>10<<20){void reader.cancel();failure('email_capture_limit');}chunks.push(value);}}finally{reader.releaseLock();}
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        listStage='qq_json';
        let value;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{failure('email_network_list_unqualified');}
        checkedAccount(account_address);
        listStage='qq_head';if(value?.head?.ret!==0)failure('email_network_list_unqualified');
        listStage='qq_total';if(!Number.isInteger(value.body?.total_num)||value.body.total_num<0)failure('email_network_list_unqualified');
        listStage='qq_lock';if(!Number.isInteger(value.body.lock_num)||value.body.lock_num<0)failure('email_network_list_unqualified');
        if(value.body.total_num===0&&value.body.list===undefined)value.body.list=[];
        listStage='qq_list';if(!Array.isArray(value.body.list)||value.body.list.length>50)failure('email_network_list_unqualified');
        const parsed=config.parse(value),rows=[];
        let unsupported=value.body.list.length-parsed.length+value.body.lock_num;
        for(const row of parsed){
          if(row.grouped){unsupported++;continue;}
          if(row.folder!=='inbox'&&!/^qq:[1-9][0-9]{3,9}$/.test(row.folder))continue;
          const at=instantNanos(row.received_at);if(at===null){unsupported++;continue;}
          if(at>=start&&at<end){records.set(row.provider_message_id,row);rows.push(row);}
        }
        binding=url;
        listStage='qq_complete';
        return {provider:config.provider,account_address:account,rows,unsupported_rows:unsupported,has_next:value.body.total_num>value.body.list.length,page:0,scope:'inbound_received',folder_scope_id:'search_inbound_v1'};
      }
      const dir=folder==='inbox'?1:/^qq:[1-9][0-9]{3,9}$/u.test(folder)?Number(folder.slice(3)):folder==='sent'?3:null;
      if (!Number.isInteger(dir)||dir<1) failure('email_network_list_unqualified');
      url.searchParams.set('func','1');url.searchParams.set('dir',String(dir));url.searchParams.set('dirid',String(dir));url.searchParams.set('page_now',String(page));url.searchParams.set('page_size','50');
      const response=await originalFetch.call(window,url.href,{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
      if([401,403].includes(response.status))failure('email_login_required');if(!response.ok)failure('email_network_read_failed');
      let value;try{value=await response.json();}catch{failure('email_network_list_unqualified');}
      checkedAccount(account_address);
      if(value?.head?.ret!==0||!Array.isArray(value.body?.list)||!Number.isInteger(value.body.total_num)||value.body.total_num<0)failure('email_network_list_unqualified');
      binding=url;
      const rows=config.parse(value).filter(row=>row.folder===(folder==='inbox'?'inbox':folder));
      const received=rows.filter(row=>{const at=instantNanos(row.received_at);return at!==null&&at>=start&&at<end;});
      const unsupportedRows=Math.max(0,value.body.list.length-rows.length);
      const receiptTimes=rows.map(row=>instantNanos(row.received_at));
      const receiptOrdered=receiptTimes.length>0 && receiptTimes.every((at,index)=>at!==null&&(index===0||receiptTimes[index-1]>=at));
      // QQ's native inbox page is ordered by `totime` descending. Once a fully
      // qualified page crosses the requested lower bound, every later page is
      // older and scanning the rest of mailbox history would add no evidence.
      // Any invalid row or ordering violation keeps pagination fail-closed.
      const boundaryReached=unsupportedRows===0&&receiptOrdered&&receiptTimes.at(-1)<start;
      const hasNext=!boundaryReached&&(page+1)*50<value.body.total_num;
      for(const row of rows)records.set(row.provider_message_id,row);
      return {provider:config.provider,account_address:account,rows:received,unsupported_rows:unsupportedRows,has_next:hasNext,next_page:hasNext?page+1:undefined,page,scope:'inbound_received',folder_scope_id:String(dir)};
    }
    if (config.provider !== 'gmail') failure('email_network_list_unqualified');
    listStage = 'template';
    const start=instantNanos(interval_start),end=instantNanos(interval_end);
    if (start===null||end===null||start>=end||!Number.isInteger(page)||page<0||page>10000) failure('invalid_request');
    const query=`-in:trash -in:spam -in:drafts after:${start/1000000000n-1n} before:${(end+999999999n)/1000000000n}`;
    if (networkQuery && networkQuery !== query) failure('email_network_list_unqualified');
    networkQuery = query;
    let value;
    const usableTemplate=String(listRequest?.method).toUpperCase()==='POST' && Array.isArray(listRequest?.body?.[0]) && typeof listRequest.body[0][3]==='string' && Array.isArray(listRequest.body[2]) && Array.isArray(listRequest.body[0][15]);
    if(!usableTemplate && page===0 && typeof config.search==='function') {
      listStage='native_query';
      config.search(query);
      const deadline=Date.now()+20000;
      while(active && nativeQueryReply?.query!==query && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
      if(!active||nativeQueryReply?.query!==query)failure('email_network_list_unqualified');
      value=nativeQueryReply.value;
    } else {
    if (!listRequest) failure('email_network_list_unqualified');
    if (String(listRequest.method).toUpperCase() !== 'POST' || listRequest.url.origin !== location.origin ||
        !Array.isArray(listRequest.body?.[0]) || typeof listRequest.body[0][3] !== 'string' || !Array.isArray(listRequest.body?.[2])) failure('email_network_list_unqualified');
    const body=structuredClone(listRequest.body);
    listStage = 'request_shape';
    // The observed XHR is only a transport template. Bind the replay to the
    // requested receipt interval instead of trusting whatever search happened
    // to be open when the userscript was installed.
    body[0][3]=query;
    if(page>0 && !pageTokens.has(page))failure('email_network_list_unqualified');
    if(!Array.isArray(body[0][15]))failure('email_network_list_unqualified');
    body[0][15][13]=page===0?null:pageTokens.get(page);
    body[0][9]=page; body[0][7]=2000; body[2][0]=0; // Observed native pagination and full-response request.
    const response=await originalFetch.call(window,listRequest.url.href,{method:'POST',credentials:'same-origin',redirect:'error',headers:listRequest.headers,body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    listStage = 'response';
    if ([401,403].includes(response.status)) failure('email_login_required');
    if (!response.ok) failure('email_network_read_failed');
    const reader=response.body.getReader(),chunks=[];let length=0;
    try {
      for (;;) {const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>10<<20){void reader.cancel();failure('email_capture_limit');}chunks.push(value);}
    } finally {reader.releaseLock();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{failure('email_network_list_unqualified');}
    }
    checkedAccount(account_address);
    listStage = 'response_shape';
    if (!Array.isArray(value) || value?.[0] !== 0 || !Array.isArray(value?.[19]) || ![0,1].includes(value[3])) failure('email_network_list_unqualified');
    if(value[3]===1) {
      const token=value?.[13]?.[8];
      if(typeof token!=='string'||!token||token.length>8192||token!==value?.[13]?.[9])failure('email_network_list_unqualified');
      pageTokens.set(page+1,token);
    }
    const rows=config.parse(value), received=[];let unsupported=0;
    listStage = 'members';
    let rawCount=0;
    for(const batch of value[19]) {
      // Gmail's terminal empty batch is a four-field network envelope with a
      // null thread list. The network contract is the complete evidence source.
      if(value[3]===0&&value[19].length===1&&Array.isArray(batch)&&batch.length===4&&batch[1]===null) continue;
      if(!Array.isArray(batch?.[1]))failure('email_network_list_unqualified');
      for(const container of batch[1]) {
        if(!Array.isArray(container?.[0]?.[4]) || !container[0][4].length)failure('email_network_list_unqualified');
        rawCount+=container[0][4].filter(message=>{const labels=message?.[10];return !(Array.isArray(labels)&&labels.every(label=>typeof label==='string')&&(labels.includes('^r')||labels.includes('^f')));}).length;
      }
    }
    unsupported+=Math.max(0,rawCount-rows.length);
    for(const row of rows) {
      records.set(row.provider_message_id,row);
      if(row.draft||row.sent)continue;
      const at=instantNanos(row.received_at);
      if(at===null){unsupported++;continue;}
      if(at>=start&&at<end)received.push({...row});
    }
    while(records.size>2000)records.delete(records.keys().next().value);
    listStage = 'complete';
    return {provider:config.provider,account_address:account,rows:received,unsupported_rows:unsupported,has_next:value[3]===1,page};
  }
  async function markRead({account_address,provider_message_id} = {}) {
    checkedAccount(account_address);
    if (!idPattern.test(provider_message_id || '') || !records.has(provider_message_id)) failure('email_network_target_unobserved');
    const row=records.get(provider_message_id);
    if (row.unread === false) return {provider:config.provider,account_address:account,provider_message_id,read_state:'read'};
    const result=await config.markRead?.({account_address:account,provider_message_id,row,binding,request:listRequest,fetch:originalFetch});
    if (!result || result.provider_message_id !== provider_message_id || !['read','unknown'].includes(result.read_state)) failure('email_network_mark_read_unqualified');
    checkedAccount(account_address);
    if(result.read_state==='read')row.unread=false;
    return {provider:config.provider,account_address:account,provider_message_id,read_state:result.read_state};
  }
  function dispose() {
    nativeQueryReply=null;
    active = false;originalAbort?.abort();if(objectURL)URL.revokeObjectURL(objectURL);objectURL=null;originalBytes=null;originalMessageID=''; records.clear(); pageTokens.clear(); networkQuery = null; binding = null; listRequest = null; inbox = null; transport?.dispose(); anchor?.remove();
    if (XMLHttpRequest.prototype.open === open) XMLHttpRequest.prototype.open = originalOpen;
    if (XMLHttpRequest.prototype.send === send) XMLHttpRequest.prototype.send = originalSend;
    if (XMLHttpRequest.prototype.setRequestHeader === setHeader) XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
    if (window.fetch === fetch) window.fetch = originalFetch;
    delete window.SparkClawMailReader;
  }
  transport=config.installTransport?.({account:checkedAccount,getInbox:()=>inbox,receiveStartup(value){inbox=config.parseFolders?.(value)||null;},receiveRows(rows){
    checkedAccount();for(const row of rows){if(row && row.provider_selection_id===undefined)row.provider_selection_id=row.provider_thread_id||row.provider_message_id;if(idPattern.test(row.provider_message_id||''))records.set(row.provider_message_id,row);}
    while(records.size>2000)records.delete(records.keys().next().value);
  }});
  Object.defineProperty(window, 'SparkClawMailReader', {configurable:true, value:Object.freeze({
    armRangeSearch(request){checkedAccount(request.account_address);if(!transport?.armRangeSearch)failure('email_network_list_unqualified');return transport.armRangeSearch(request);},
    version:'0.2.0', provider:config.provider, checkAccount({account_address}) {
      const current=config.account()?.toLowerCase();
      if(!current)failure('email_account_identity_unavailable');
      if(account && account!==current || account_address?.toLowerCase()!==current)failure('email_account_identity_mismatch');
      return true;
    }, diagnostics:()=>({original:{state:originalState,responseOrigin,response:originalResponse?{...originalResponse}:null},list:{stage:listStage,template:Boolean(listRequest),body:Array.isArray(listRequest?.body),paging:Array.isArray(listRequest?.body?.[0]?.[15])},inbox:Boolean(inbox),records:records.size,transport:transport?.diagnostics?.()}), snapshot, resetRound,
    listPage:request=>inRound(listPage,request), prepareOriginal:request=>inRound(prepareOriginal,request), prepareRetainedOriginal:request=>inRound(prepareRetainedOriginal,request), markRead, dispose,
    verifyTarget({account_address,provider_message_id,provider_selection_id,folder}) {
      checkedAccount(account_address);
      const row=records.get(provider_message_id);
      return Boolean(row && !row.draft && !row.sent && row.provider_selection_id===provider_selection_id && (!folder||folder==='all'||row.folder===folder) && Number.isFinite(Date.parse(row.received_at)));
    },
  })});
}
