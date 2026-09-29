import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { capturePage, pageCaptureInvocation, validateCaptureInput } from '../../applications/mail/lib/read-capture.mjs';
import { READ_PROVIDERS } from '../../applications/mail/lib/provider-account.mjs';

const request = () => ({schema_version:1,operation:'collect_page',provider:'gmail',account:'default',owner_scope:'a'.repeat(64),invocation_id:`email_changes_${'a'.repeat(64)}_r1`,
  discovery:{provider_mode:'time_range',account_address:'owner@example.test',lane:'recent_inbound',continuation:'',limit:50,interval_start:'2026-09-08T00:00:00Z',interval_end:'2026-09-09T00:00:00Z'}});
const target = id => ({account_address:'owner@example.test',provider_message_id:id,provider_selection_id:id,provider_thread_id:id,folder:'inbox'});
const eml = Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Fixture\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody\r\n');

test('timeline sources use one journal and replay without another list or download',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'email-timeline-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input=request();input.discovery.provider_mode='time_range';
  input.invocation_id=`email_changes_${'a'.repeat(64)}_r1`;
  let lists=0,downloads=0;
  const tab={download:async(_selector,destination)=>{downloads++;await fs.writeFile(destination,eml,{flag:'wx',mode:0o600});}};
  const runtime={emailWorkspaceRoot:root,withReadTab:callback=>callback(tab)};
  const adapter={
    discover:async()=>{lists++;return {listed:{},discovery:{schema_version:1,provider:'gmail',account_address:'owner@example.test',status:'listed',candidates:[target('a'),target('b')],coverage:{scope:'inbound_received',lane:'recent_inbound',scan_complete:true,boundary_qualified:true,scanned_rows:2,unsupported_rows:0,limited:false},observed_at:new Date().toISOString()}};},
    collect:async(_tab,_provider,options)=>{const message={...target(options.pinned_message_id),original:{selector:'original'},read_state:'unread'};await options.onSelected(message);return message;}
  };
  const first=await capturePage(input,runtime,'gmail',adapter);
  assert.equal(first.captures.length,2);
  const owner=path.join(root,'email',input.owner_scope);
  assert.equal((await fs.readdir(path.join(owner,'batches'))).length,1);
  await assert.rejects(fs.stat(path.join(owner,'pages')),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(owner,'invocations')),{code:'ENOENT'});
  const replay=await capturePage(input,runtime,'gmail',adapter);
  assert.deepEqual(replay,first);
  assert.equal(lists,1);assert.equal(downloads,2);
  // A different interval can overlap a server's timestamp boundary. It must
  // not create or download another original for either previously seen ID.
  const later={...input,invocation_id:`email_changes_${'b'.repeat(64)}_r2`};
  const overlap=await capturePage(later,runtime,'gmail',adapter);
  const immutable=entries=>entries.map(({target,result})=>({target,capture:{...result.capture,read_state:undefined}}));
  assert.deepEqual(immutable(overlap.captures),immutable(first.captures));
  assert.ok(overlap.captures.every(entry=>entry.result.capture.read_state==='unknown'));
  assert.equal(lists,2);assert.equal(downloads,2);
});

test('empty timeline poll writes no recovery journal',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'email-timeline-empty-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input=request();input.discovery.provider_mode='time_range';
  const result=await capturePage(input,{emailWorkspaceRoot:root,withReadTab:callback=>callback({})},'gmail',{
    discover:async()=>({listed:{},discovery:{account_address:'owner@example.test',status:'empty',candidates:[],coverage:{scan_complete:true}}})
  });
  assert.equal(result.status,'empty');
  assert.deepEqual(await fs.readdir(path.join(root,'email',input.owner_scope,'batches')),[]);
});

test('latest-interval reread lists stable IDs without reopening completed originals',async t=>{
  const f=await fixture(t);
  await f.run();
  const already=f.events.filter(event=>event.startsWith('download:')).length;
  const discovery={...request().discovery,skip_provider_message_ids:['a','b']};
  const reread=await f.run({invocation_id:`email_changes_${'d'.repeat(64)}_r2`,discovery});
  assert.equal(reread.status,'partial');
  assert.deepEqual(reread.discovery.candidates.map(row=>row.provider_message_id),['a','b']);
  assert.deepEqual(reread.captures,[]);
  assert.equal(f.events.filter(event=>event.startsWith('download:')).length,already);
  f.targets.push(target('c'));
  const extended=await f.run({invocation_id:`email_changes_${'e'.repeat(64)}_r3`,discovery});
  assert.deepEqual(extended.captures.map(row=>row.target.provider_message_id),['c']);
  assert.deepEqual(f.events.filter(event=>event.startsWith('download:')).map(event=>event.slice(9)),['a','b','c']);
});

function networkTab(provider, url, state) {
  const calls = [], downloads = [];
  const reader = {
    provider, version:'0.2.0',
    snapshot:options=>{
      calls.push({method:'snapshot',options});
      // Production readers return qualified network data, not the current DOM URL.
      return {provider,account_address:'owner@example.test',rows:state.rows,unsupported_rows:state.unsupported_rows??0,scan_complete:false};
    },
    listPage:options=>{
      calls.push({method:'listPage',options});
      return {provider,account_address:'owner@example.test',page:options.page,rows:state.rows,unsupported_rows:state.unsupported_rows??0,has_next:false,scope:'inbound_received'};
    },
    prepareOriginal:options=>{
      calls.push({method:'prepareOriginal',options});
      return {selector:'#sparkclaw-mail-original',bytes:eml.length,account_address:'owner@example.test',provider_message_id:options.provider_message_id};
    },
    armRangeSearch:()=>({query:'fixture'}),
    markRead:()=>{assert.fail('page capture must not mark mail read');},
  };
  const tab = {
    runReadCode:async code=>vm.runInNewContext(`(${code})`,{window:{SparkClawMailReader:reader}})({evaluate:(callback,options)=>callback(options),locator:()=>({fill:async()=>{},press:async()=>{}})}),
    inspect:async()=>assert.fail('network page must not inspect DOM'),
    click:async()=>assert.fail('network page must not navigate by clicking'),
    download:async(selector,destination)=>{
      downloads.push(selector);
      await state.onDownload?.();
      await fs.writeFile(destination,eml,{flag:'wx',mode:0o600});
    },
  };
  return {tab,calls,downloads};
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'email-page-'));
  t.after(()=>fs.rm(root,{force:true,recursive:true}));
  const events = [];
  const f = {root,events,targets:[target('a'),target('b')],tabs:0,scans:0};
  const tab = {download:async (_selector,destination)=>{
    events.push(`download:${f.current}`);
    if (f.onDownload) await f.onDownload();
    await fs.writeFile(destination,f.bytes ?? eml,{flag:'wx',mode:0o600});
  }};
  f.runtime = {emailWorkspaceRoot:root,withReadTab:async callback=>{f.tabs++;return callback(tab);}};
  f.adapter = {
    discover:async sameTab=>{
      assert.equal(sameTab,tab);f.scans++;
      return {listed:{url:'https://mail.google.com/mail/u/0/#search/test'},discovery:{schema_version:1,provider:'gmail',status:'partial',account_address:'owner@example.test',
        candidates:[...f.targets],coverage:{scope:'inbound_received',lane:'recent_inbound',scan_complete:false,scanned_rows:f.targets.length,unsupported_rows:0,limited:true},observed_at:new Date().toISOString()}};
    },
    collect:async (sameTab,provider,options,_listed,recovering)=>{
      assert.equal(sameTab,tab);assert.equal(provider,'gmail');
      f.current=options.pinned_message_id;
      events.push(`open:${f.current}:${recovering}`);
      if(f.onCollect)await f.onCollect(options);
      const message={...target(f.current),subject:'Fixture',inventory_complete:true,attachments:[],body_text:'Body',read_state:'unread',original:{selector:'original'}};
      await options.onSelected(message);
      return message;
    },
    markRead:async()=>{events.push(`mark:${f.current}`);return 'read';},
    restore:async sameTab=>{assert.equal(sameTab,tab);events.push('restore');},
  };
  f.run=overrides=>capturePage({...request(),...overrides},f.runtime,'gmail',f.adapter);
  return f;
}

test('individual identity failure retains prior success and never downloads the wrong message',async t=>{
  const f=await fixture(t);
  f.onCollect=async options=>{if(f.current==='b')await options.onSelected({...target('other'),subject:'Fixture'});};
  const result=await f.run();
  assert.equal(result.captures.length,1);assert.equal(result.failures.length,1);
  assert.equal(result.failures[0].target.provider_message_id,'b');
  assert.equal(result.failures[0].error_code,'email_capture_invalid');
  assert.equal(f.events.includes('download:b'),false);
});

test('completed page replay verifies original files before returning or acknowledging receipts',async t=>{
  const f=await fixture(t);const result=await f.run();
  const manifestPath=path.join(f.root,result.captures[0].result.capture.manifest_path);
  const manifest=JSON.parse(await fs.readFile(manifestPath));
  await fs.writeFile(path.join(f.root,manifest.files[0].path),'corrupt');
  await assert.rejects(f.run(),{code:'email_source_conflict'});
  assert.equal(f.tabs,1);
});

test('page contract rejects oversized pages and cross-operation acknowledgements',()=>{
  validateCaptureInput(request(),'gmail');
  for(const invalid of [
    {...request(),discovery:{...request().discovery,limit:51}},
    {...request(),ack_page_id:`page_${'a'.repeat(64)}`},
    {...request(),discovery:{...request().discovery,provider_mode:undefined}},
    {...request(),discovery:{...request().discovery,continuation:'n1:abcd'}},
    {...request(),operation:'discover',ack_page_id:`page_${'a'.repeat(64)}`},
  ])assert.throws(()=>validateCaptureInput(invalid,'gmail'),{code:'invalid_request'});
});

test('page target invocation matches the Gateway cross-language identity fixture',()=>{
  assert.equal(pageCaptureInvocation({...request(),invocation_id:'email_page_job_recent_inbound'},'gmail',{...target('message'),account_address:'Owner@Example.Test'}),
    'email_capture_c3ac21b3fbf0a810eddacec1bdf30c1221425019c39edb35686a4d7b7b1ff496');
});

test('timeline ignores and preserves retired page checkpoints while retaining failed targets next round',async t=>{
  const f=await fixture(t);
  const legacy=path.join(f.root,'email',request().owner_scope,'pages');
  await fs.mkdir(legacy,{recursive:true,mode:0o700});
  const evidence=Buffer.from('retired checkpoint evidence');
  const saved=path.join(legacy,'legacy.json');await fs.writeFile(saved,evidence);
  f.onCollect=async()=>{if(f.current==='b')throw Object.assign(new Error('temporary'),{code:'email_pinned_message_unavailable'});};
  const first=await f.run();assert.equal(first.captures.length,1);assert.equal(first.failures.length,1);
  f.targets=[];f.onCollect=null;
  const second=await f.run({invocation_id:`email_changes_${'c'.repeat(64)}_r2`,discovery:{...request().discovery,retry_targets:[target('b')]}});
  assert.equal(second.captures.length,1);assert.deepEqual(second.failures,[]);
  assert.equal(f.events.filter(event=>event==='download:a').length,1);
  assert.equal(f.events.filter(event=>event==='download:b').length,1);
  assert.deepEqual(await fs.readFile(saved),evidence);
});

test('production page adapters read network originals in one tab without DOM or read effects',async t=>{
  const {collectEmailPage}=await import('../../applications/mail/read.mjs');
  for(const provider of ['qq_mail','gmail','outlook'])await t.test(provider,async t=>{
    const f=await fixture(t);
    const rows=['a','b'].map((id,index)=>({...target(id),provider_thread_id:provider==='qq_mail'?id:'thread',subject:'Fixture',unread:index===0,inbox:true,received_at:'2026-09-08T01:00:00Z'}));
    const {tab,calls,downloads}=networkTab(provider,READ_PROVIDERS[provider].url,{rows});
    let tabs=0;
    const result=await collectEmailPage({...request(),provider},{emailWorkspaceRoot:f.root,withReadTab:async callback=>{tabs++;return callback(tab);}},provider);
    assert.equal(tabs,1);assert.deepEqual(downloads,['#sparkclaw-mail-original','#sparkclaw-mail-original']);
    assert.deepEqual(result.failures,[]);
    assert.deepEqual(result.captures.map(c=>c.target.provider_message_id),['a','b']);
    assert.ok(result.captures.every(c=>['read','unread','unknown'].includes(c.result.capture.read_state)));
    assert.equal(calls.filter(call=>call.method==='snapshot').length,1);
    assert.deepEqual(calls.filter(call=>call.method==='prepareOriginal').map(call=>call.options.provider_message_id),['a','b']);
  });
});


test('capture commits one original and leaves extraction limits to asynchronous parsing',async t=>{
  const f=await fixture(t);
  f.targets=[target('a')];
  f.bytes=Buffer.from(['From: sender@example.test','To: owner@example.test','Subject: Fixture','MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="many"','',
    '--many','Content-Type: text/plain','','Body',
    ...Array.from({length:21},(_,i)=>['--many','Content-Type: application/octet-stream',`Content-Disposition: attachment; filename="part-${i}.txt"`,'','attachment'].join('\r\n')),
    '--many--',''].join('\r\n'));
  const first=await f.run();assert.equal(first.captures[0].result.status,'collected');assert.deepEqual(first.failures,[]);
  const replay=await f.run();assert.equal(replay.page_id,first.page_id);assert.equal(f.tabs,1);
  const next=await f.run({invocation_id:`email_changes_${'b'.repeat(64)}_r1`});assert.notEqual(next.page_id,first.page_id);
  assert.equal(f.events.filter(e=>e==='download:a').length,1);
});

test('new page can reuse verified captured mail after a folder or locator change without reopening',async t=>{
  const f=await fixture(t);f.targets=[target('a')];
  const first=await f.run();
  f.targets=[{...target('a'),folder:'all',provider_selection_id:'new-thread'}];
  const next=await f.run({invocation_id:`email_changes_${'b'.repeat(64)}_r1`});
  assert.deepEqual(next.failures,[]);
  assert.equal(next.captures[0].target.folder,'all');
  assert.equal(next.captures[0].result.capture.manifest_path,first.captures[0].result.capture.manifest_path);
  assert.equal(f.events.filter(e=>e==='download:a').length,1);
  assert.equal(f.events.filter(e=>e.startsWith('open:a')).length,1);
});


test('unsupported or evidence-unavailable zero-candidate batches remain partial',async t=>{
  for(const [reason,unsupported] of [['network_rows_unqualified',1],['network_list_unqualified',0],['new_unknown_evidence_gap',0],['',0]]) {
    const f=await fixture(t);f.targets=[];
    const discover=f.adapter.discover;
    f.adapter.discover=async tab=>{
      const result=await discover(tab);
      result.discovery.coverage.reason=reason;
      result.discovery.coverage.unsupported_rows=unsupported;
      result.discovery.coverage.scanned_rows=unsupported;
      return result;
    };
    const result=await f.run();
    assert.equal(result.status,'partial');
    assert.deepEqual(f.events,[]);
    assert.equal(result.discovery.coverage.reason,reason);
    assert.equal(result.discovery.coverage.unsupported_rows,unsupported);
  }
});

test('production Gmail page adapter preserves partial network coverage when rows are unqualified',async t=>{
  const {collectEmailPage}=await import('../../applications/mail/read.mjs');
  const f=await fixture(t);
  const {tab,calls}=networkTab('gmail',READ_PROVIDERS.gmail.url,{rows:[{...target('b'),provider_thread_id:'thread-f:10',inbox:true,received_at:'2026-09-08T01:00:00Z'}],unsupported_rows:1});
  const result=await collectEmailPage({...request(),provider:'gmail'},{emailWorkspaceRoot:f.root,withReadTab:callback=>callback(tab)},'gmail');
  assert.deepEqual(result.failures,[]);
  assert.deepEqual(result.captures.map(c=>c.target.provider_message_id),['b']);
  assert.equal(result.discovery.coverage.unsupported_rows,1);
  assert.equal(result.discovery.coverage.scan_complete,false);
  assert.equal(calls.filter(call=>call.method==='snapshot').length,1);
});
