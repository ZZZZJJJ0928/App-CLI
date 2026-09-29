import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {installOutlookRangeTransport} from '../../applications/mail/userscripts/lib/outlook-range.mjs';

const owner='owner@example.test';
const interval={account_address:owner,interval_start:'2026-09-11T00:00:00.123456789Z',interval_end:'2026-09-12T00:00:00.987654321Z',page:0,provider_mode:'time_range'};
const endpoint='https://outlook.live.com/searchservice/api/v2/query';
const plain=value=>JSON.parse(JSON.stringify(value));
const message=(id='item-1',extra={})=>({Type:'Message',Source:{ItemId:{Id:id},ImmutableId:id,ConversationId:{Id:'thread-1'},ParentFolderId:{Id:'inbox-id'},DateTimeReceived:'2026-09-11T10:00:00Z',IsDraft:false,IsRead:false,...extra}});
const result=(rows=[],extra={})=>({EntitySets:[{EntityType:'Message',IsPartial:false,Properties:{HasParseException:false},ResultSets:[{Total:rows.length,MoreResultsAvailable:false,Results:rows,...extra}]}]});

function response(value,{url=endpoint,status=200}={}) {
  const r=new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  Object.defineProperty(r,'url',{value:url});
  Object.defineProperty(r,'clone',{value:()=>response(value,{url,status})});
  return r;
}

function fixture(t) {
  const f={currentAccount:owner,inbox:{qualified:true,account:owner,folders:[{id:'inbox-id',inbox:true},{id:'archive-id',inbox:false}]},requests:[],received:[]};
  const context=vm.createContext({URL,Date,JSON,Object,Number,Error,Map,Set,Uint8Array,TextEncoder,TextDecoder,AbortController,structuredClone,crypto:webcrypto,setTimeout,clearTimeout,
    location:{origin:'https://outlook.live.com',href:'https://outlook.live.com/mail/0/'},
    dependencies:{account(expected){if(expected!==f.currentAccount)throw Object.assign(new Error('email_account_mismatch'),{code:'email_account_mismatch'});return f.currentAccount;},getInbox:()=>f.inbox,receiveRows:rows=>f.received.push(plain(rows))},
  });
  f.transport=vm.runInContext(`(${installOutlookRangeTransport.toString()})(dependencies)`,context);
  f.next=async(...args)=>{f.requests.push(args);return response(Object.hasOwn(f,'value')?f.value:result());};
  f.nativeArgs=query=>[endpoint,{method:'POST',headers:{'X-Fixture':'page-only'},body:JSON.stringify({EntityRequests:[{EntityType:'Conversation',ContentSources:['Exchange'],Query:{QueryString:query},From:99,Size:200,Filter:{Term:{FolderId:'wrong-folder'}},RefiningQueries:['old-filter'],EnableTopResults:true,TopResultsCount:3}],QueryAlterationOptions:{EnableSuggestion:true,EnableAlteration:true,OtherOption:'preserved'}})}];
  f.start=(value,request=interval)=>{f.value=value;const arm=f.transport.arm(request);return f.transport.fetchSearch(f.nativeArgs(arm.query),f.next);};
  t.after(()=>f.transport.dispose());
  return f;
}

test('Outlook range keeps exact UTC bounds with AND and rewrites one native request to Message/FolderId scope',async t=>{
  const f=fixture(t),armed=f.transport.arm(interval);
  assert.equal(armed.query,`received>=${interval.interval_start} AND received<${interval.interval_end}`);
  const original=f.nativeArgs(armed.query),originalBody=original[1].body;
  f.value=result([message(),message('archived',{ParentFolderId:{Id:'archive-id'},IsRead:true})]);
  await f.transport.fetchSearch(original,f.next);
  const page=await f.transport.listPage(interval);
  assert.equal(f.requests.length,1);
  const [,options]=f.requests[0],body=JSON.parse(options.body),entity=body.EntityRequests[0];
  assert.equal(entity.Query.QueryString,armed.query);
  assert.equal(entity.EntityType,'Message');assert.equal(entity.From,0);assert.equal(entity.Size,50);
  assert.deepEqual(entity.Filter,{Or:[{Term:{FolderId:'inbox-id'}},{Term:{FolderId:'archive-id'}}]});
  assert.deepEqual(entity.Sort,[{Field:'Time',SortDirection:'Desc'}]);
  assert.equal(entity.RefiningQueries,null);assert.equal(entity.EnableTopResults,false);assert.equal(entity.TopResultsCount,0);
  assert.deepEqual(body.QueryAlterationOptions,{EnableSuggestion:false,EnableAlteration:false,OtherOption:'preserved'});
  assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers['X-Fixture'],'page-only');assert.equal(original[1].body,originalBody);
  assert.equal(page.provider,'outlook');assert.equal(page.account_address,owner);assert.equal(page.scope,'inbound_received');
  assert.equal(page.has_next,false);assert.equal(page.unsupported_rows,0);assert.match(page.folder_scope_id,/^[a-f0-9]{64}$/);
  assert.deepEqual(plain(page.rows).map(r=>[r.provider_message_id,r.folder,r.unread]),[['item/1','inbox',true],['archived','outlook:archive-id',false]]);
  assert.deepEqual(f.received,[plain(page.rows)]);
});

test('Outlook duplicate matching native searches share exactly one HTTP request and independent responses',async t=>{
  const f=fixture(t),{query}=f.transport.arm(interval),args=f.nativeArgs(query);
  let release;
  const ready=new Promise(resolve=>{release=resolve;});
  const next=async(...args)=>{f.requests.push(args);await ready;return response(result([message()]));};
  const first=f.transport.fetchSearch(args,next),second=f.transport.fetchSearch(args,next);
  assert.equal(f.requests.length,1);release();
  const [a,b]=await Promise.all([first,second]);
  assert.notEqual(a,b);assert.deepEqual(await a.json(),await b.json());
  assert.equal((await f.transport.listPage(interval)).rows.length,1);assert.equal(f.requests.length,1);
});

test('Outlook complete empty range does not fabricate a row or issue a warm-up list',async t=>{
  const f=fixture(t),value=result();delete value.EntitySets[0].ResultSets[0].Results;
  await f.start(value);
  const page=await f.transport.listPage(interval);
  assert.equal(page.rows.length,0);assert.equal(page.unsupported_rows,0);assert.equal(page.has_next,false);
  assert.equal(f.requests.length,1);assert.deepEqual(f.received,[[]]);
});

test('Outlook overflow preserves the first 50 results and has_next without fetching another page',async t=>{
  const f=fixture(t),rows=Array.from({length:50},(_,i)=>message(`item-${i}`));
  await f.start(result(rows,{Total:73,MoreResultsAvailable:true}));
  const page=await f.transport.listPage(interval);
  assert.equal(page.rows.length,50);assert.equal(page.has_next,true);assert.equal(page.unsupported_rows,0);
  assert.equal(f.requests.length,1);
});

test('Outlook partial or inconsistent result metadata is rejected rather than marked complete',async t=>{
  const cases={
    partial:value=>{value.EntitySets[0].IsPartial=true;},
    parse_exception:value=>{value.EntitySets[0].Properties.HasParseException=true;},
    wrong_entity:value=>{value.EntitySets[0].EntityType='Conversation';},
    count_mismatch:value=>{value.EntitySets[0].ResultSets[0].Total=2;},
    count_less_than_rows:value=>{value.EntitySets[0].ResultSets[0].Total=0;},
    missing_more_flag:value=>{delete value.EntitySets[0].ResultSets[0].MoreResultsAvailable;},
    second_result_set:value=>{value.EntitySets[0].ResultSets.push(value.EntitySets[0].ResultSets[0]);},
  };
  for(const [name,change] of Object.entries(cases))await t.test(name,async t=>{
    const f=fixture(t),value=result([message()]);change(value);await f.start(value);
    await assert.rejects(f.transport.listPage(interval),{code:'email_network_list_unqualified'});
    assert.equal(f.received.length,0);assert.equal(f.requests.length,1);
  });
});

test('Outlook outside-folder, invalid-time and duplicate rows remain visible as unsupported coverage',async t=>{
  const f=fixture(t);
  await f.start(result([message('valid'),message('foreign',{ParentFolderId:{Id:'other-account-folder'}}),message('old',{DateTimeReceived:'2026-09-10T23:59:59Z'}),message('upper',{DateTimeReceived:interval.interval_end}),message('valid'),message('draft',{IsDraft:true})]));
  const page=await f.transport.listPage(interval);
  assert.deepEqual(plain(page.rows).map(r=>r.provider_message_id),['valid']);
  assert.equal(page.unsupported_rows,4);assert.equal(page.has_next,false);assert.equal(f.requests.length,1);
});

test('Outlook requires a qualified matching account and rejects account changes during a request',async t=>{
  await t.test('arm account mismatch',t=>{
    const f=fixture(t);
    assert.throws(()=>f.transport.arm({...interval,account_address:'other@example.test'}),{code:'email_account_mismatch'});
    assert.equal(f.requests.length,0);
  });
  await t.test('folder scope account mismatch',t=>{
    const f=fixture(t);f.inbox.account='other@example.test';
    assert.throws(()=>f.transport.arm(interval),{code:'email_network_list_unqualified'});
  });
  await t.test('account switches while response is in flight',async t=>{
    const f=fixture(t),{query}=f.transport.arm(interval);
    const next=async(...args)=>{f.requests.push(args);f.currentAccount='other@example.test';return response(result([message()]));};
    await assert.rejects(f.transport.fetchSearch(f.nativeArgs(query),next),{code:'email_account_mismatch'});
    assert.equal(f.received.length,0);
  });
});

test('Outlook rejects malformed intervals and untrusted folder terms before issuing HTTP',async t=>{
  for(const changes of [{page:1},{provider_mode:'head_page'},{interval_start:interval.interval_end},{interval_end:'2026-09-12 OR subject:test'},{interval_end:'2026-09-12T00:00:00+24:00'}]){
    const f=fixture(t);assert.throws(()=>f.transport.arm({...interval,...changes}),{code:'invalid_request'});assert.equal(f.requests.length,0);
  }
  const f=fixture(t);f.inbox.folders=[{id:'inbox OR other',inbox:true}];
  assert.throws(()=>f.transport.arm(interval),{code:'email_network_list_unqualified'});
});

test('Outlook does not hijack an unrelated native search',async t=>{
  const f=fixture(t);f.transport.arm(interval);
  const args=f.nativeArgs('subject:owner-search');await f.transport.fetchSearch(args,f.next);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0][1].body,args[1].body);assert.equal(f.received.length,0);
});

test('Outlook dispose aborts pending ownership, rejects waiting consumer and cannot be rearmed',async t=>{
  const f=fixture(t),{query}=f.transport.arm(interval);
  const pending=f.transport.listPage(interval);
  f.transport.dispose();
  await assert.rejects(pending,{code:'email_network_read_failed'});
  assert.throws(()=>f.transport.arm(interval),{code:'email_network_list_unqualified'});
  f.transport.dispose();
  const args=f.nativeArgs(query);await f.transport.fetchSearch(args,f.next);
  assert.equal(f.requests[0][1].body,args[1].body);assert.equal(f.received.length,0);
});

test('Outlook dispose aborts the already-issued fetch instead of allowing a late result to publish rows',async t=>{
  const f=fixture(t),{query}=f.transport.arm(interval);
  let signal;
  const next=(_url,options)=>new Promise((_resolve,reject)=>{
    signal=options.signal;
    signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
  });
  const fetchPending=f.transport.fetchSearch(f.nativeArgs(query),next),listPending=f.transport.listPage(interval);
  f.transport.dispose();
  assert.equal(signal.aborted,true);
  await assert.rejects(fetchPending,{name:'AbortError'});
  await assert.rejects(listPending,{code:'email_network_read_failed'});
  assert.equal(f.received.length,0);
});

test('Outlook a changed folder scope cannot consume a result armed for the previous folder set',async t=>{
  const f=fixture(t);await f.start(result([message()]));
  f.inbox.folders=[{id:'different-inbox',inbox:true}];
  await assert.rejects(f.transport.listPage(interval),{code:'email_network_list_unqualified'});
  assert.equal(f.received.length,0);
});

test('Outlook nanosecond intervals distinguish every boundary within the same millisecond',async t=>{
  const f=fixture(t),request={...interval,interval_start:'2026-09-11T10:00:00.123456700Z',interval_end:'2026-09-11T10:00:00.123456800Z'};
  const rows=[['before','123456699'],['lower','123456700'],['inside','123456799'],['upper','123456800'],['after','123456801']].map(([id,fraction])=>message(id,{DateTimeReceived:`2026-09-11T10:00:00.${fraction}Z`}));
  await f.start(result(rows),request);
  const page=await f.transport.listPage(request);
  assert.deepEqual(plain(page.rows).map(r=>r.provider_message_id),['lower','inside']);
  assert.equal(page.unsupported_rows,3);assert.equal(f.requests.length,1);
  assert.equal(JSON.parse(f.requests[0][1].body).EntityRequests[0].Query.QueryString,'received>=2026-09-11T10:00:00.1234567Z AND received<2026-09-11T10:00:00.1234568Z');
});

test('Outlook JSON null, primitive and array responses fail with the stable unqualified code',async t=>{
  for(const value of [null,42,'error',[]])await t.test(JSON.stringify(value),async t=>{
    const f=fixture(t);await f.start(value);
    await assert.rejects(f.transport.listPage(interval),{code:'email_network_list_unqualified'});
    assert.equal(f.received.length,0);assert.equal(f.requests.length,1);
  });
});

test('Outlook +08:00 boundaries normalize to equivalent UTC without losing nanoseconds',async t=>{
  const f=fixture(t),request={...interval,interval_start:'2026-09-11T18:00:00.123456700+08:00',interval_end:'2026-09-11T18:00:00.123456800+08:00'};
  await f.start(result([message('lower',{DateTimeReceived:'2026-09-11T10:00:00.123456700Z'}),message('inside',{DateTimeReceived:'2026-09-11T18:00:00.123456799+08:00'}),message('upper',{DateTimeReceived:'2026-09-11T05:00:00.123456800-05:00'})]),request);
  const page=await f.transport.listPage({...request,interval_start:'2026-09-11T10:00:00.1234567Z',interval_end:'2026-09-11T10:00:00.1234568+00:00'});
  assert.deepEqual(plain(page.rows).map(r=>r.provider_message_id),['lower','inside']);assert.equal(page.unsupported_rows,1);
  assert.equal(JSON.parse(f.requests[0][1].body).EntityRequests[0].Query.QueryString,'received>=2026-09-11T10:00:00.1234567Z AND received<2026-09-11T10:00:00.1234568Z');
});

test('Outlook provider identity stays immutable when moving mail changes its ordinary ItemId',async t=>{
  const pages=[];
  for(const [itemID,folder] of [['old-folder-item','inbox-id'],['moved-folder-item','archive-id']]){
    const f=fixture(t);await f.start(result([message(itemID,{ImmutableId:'A_immutable-ID=',ParentFolderId:{Id:folder}})]));
    pages.push(await f.transport.listPage(interval));assert.equal(f.requests.length,1);
  }
  assert.deepEqual(pages.map(page=>page.rows[0].provider_message_id),['A+immutable/ID=','A+immutable/ID=']);
  assert.notEqual(pages[0].rows[0].folder,pages[1].rows[0].folder);
});

test('Outlook missing or malformed ImmutableId is unsupported and never falls back to movable ItemId',async t=>{
  const f=fixture(t),rows=[undefined,null,'',42,{},'invalid immutable id'].map((ImmutableId,i)=>message(`valid-item-${i}`,{ImmutableId}));
  await f.start(result(rows));const page=await f.transport.listPage(interval);
  assert.equal(page.rows.length,0);assert.equal(page.unsupported_rows,rows.length);assert.deepEqual(f.received,[[]]);
});

test('Outlook URL-safe ImmutableId is canonicalized using the native underscore/plus and hyphen/slash mapping',async t=>{
  const f=fixture(t);await f.start(result([message('unrelated-movable-id',{ImmutableId:'Aa_b-c_d-=='})]));
  const page=await f.transport.listPage(interval);
  assert.equal(page.unsupported_rows,0);assert.equal(page.rows[0].provider_message_id,'Aa+b/c+d/==');
  assert.equal(page.rows[0].provider_selection_id,'thread-1');
});

test('Outlook explicit round reset rearms changed and identical ranges without old response reuse',async t=>{
  const f=fixture(t);
  for(const request of [interval,{...interval,interval_end:'2026-09-13T00:00:00Z'},interval,interval]){
    f.transport.resetRound();
    await f.start(result([message()]),request);
    assert.equal((await f.transport.listPage(request)).rows.length,1);
  }
  assert.equal(f.requests.length,4);assert.equal(f.received.length,4);
});

test('Outlook reset fences a late response even when its fetch ignores cancellation',async t=>{
  const f=fixture(t),{query}=f.transport.arm(interval);let release;
  const next=()=>new Promise(resolve=>{release=()=>resolve(response(result([message('stale')])));});
  const pending=f.transport.fetchSearch(f.nativeArgs(query),next);
  f.transport.resetRound();
  await f.start(result([message('fresh')]));
  release();await assert.rejects(pending,{code:'email_network_read_failed'});
  assert.deepEqual(plain((await f.transport.listPage(interval)).rows).map(row=>row.provider_message_id),['fresh']);
  assert.equal(f.received.length,1);
});
