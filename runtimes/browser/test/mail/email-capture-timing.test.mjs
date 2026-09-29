import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {capturePage} from '../../applications/mail/lib/read-capture.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-timing-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const target={account_address:'private@example.test',provider_message_id:'private-id',provider_selection_id:'private-id',folder:'inbox'};
 const bytes=Buffer.from('From: sender@example.test\r\nDate: Tue, 15 Sep 2026 00:00:00 +0000\r\n\r\nprivate body');
 const records=[];let calls=0;
 const input={schema_version:1,operation:'collect_page',provider:'gmail',account:'default',owner_scope:'a'.repeat(64),invocation_id:`email_changes_${'1'.repeat(64)}_r1`,discovery:{account_address:target.account_address,continuation:'',lane:'recent_inbound',limit:50,provider_mode:'time_range',interval_start:'2026-09-15T00:00:00Z',interval_end:'2026-09-16T00:00:00Z'}};
 const runtime={emailWorkspaceRoot:root,withReadTab:callback=>callback({}),captureTimingDiagnostic:record=>records.push(record)};
 const adapter={discover:async()=>({discovery:{account_address:target.account_address,candidates:[target],status:'listed'},listed:{}}),collect:async(_tab,_provider,options)=>{calls++;await options.onSelected(target);return {...target,original:{selector:'original',inline_base64:bytes.toString('base64'),inline_bytes:bytes.length,bytes:bytes.length}};}};
 return {root,input,runtime,adapter,records,bytes,calls:()=>calls,run:()=>capturePage(input,runtime,'gmail',adapter)};
}

test('capture timing separates browser preparation, transfer, hash and durable publication without private data',async t=>{
 const f=await fixture(t),result=await f.run();assert.equal(result.captures.length,1);
 const [record]=f.records;
 assert.deepEqual(Object.keys(record).sort(),['counts','milliseconds','operation','provider']);
 for(const stage of ['discover','existing_capture','prepare_original','original_transfer_write','original_inspect_hash','journal_durability','publish','total'])assert.ok(Number.isFinite(record.milliseconds[stage])&&record.milliseconds[stage]>=0);
 assert.deepEqual(record.counts,{originals_acquired:1,original_bytes:f.bytes.length,reused:0,failures:0});
 for(const secret of [f.root,'private@example.test','private-id','private body'])assert.equal(JSON.stringify(record).includes(secret),false);
 await f.run();assert.equal(f.calls(),1);assert.equal(f.records[1].counts.reused,1);assert.equal(f.records[1].milliseconds.prepare_original,undefined);
});

test('cross-round existing source reuse does not recreate staging directories',async t=>{
 const f=await fixture(t),first=await f.run();
 const staging=path.join(f.root,'email',f.input.owner_scope,'staging');
 await fs.rm(staging,{recursive:true});
 f.input.invocation_id=`email_changes_${'2'.repeat(64)}_r1`;
 const second=await f.run();assert.equal(f.calls(),1);
 assert.equal(second.captures[0].result.capture.manifest_sha256,first.captures[0].result.capture.manifest_sha256);
 await assert.rejects(fs.stat(staging),{code:'ENOENT'});
 assert.equal(f.records[1].counts.reused,1);
});

test('capture timing callback sync throws and async rejects cannot change successful result',async t=>{
 for(const callback of [()=>{throw new Error('private');},async()=>{throw new Error('private');}]){
  const f=await fixture(t);f.runtime.captureTimingDiagnostic=callback;
  assert.equal((await f.run()).captures.length,1);
  await new Promise(resolve=>setImmediate(resolve));
 }
});

test('failed discovery still records its entered stage and total without error text',async t=>{
 const f=await fixture(t);f.adapter.discover=async()=>{throw new Error('private discovery');};
 await assert.rejects(f.run(),/private discovery/);
 assert.ok(f.records[0].milliseconds.discover>=0);assert.ok(f.records[0].milliseconds.total>=0);
 assert.equal(f.records[0].milliseconds.prepare_original,undefined);
 assert.equal(JSON.stringify(f.records).includes('private discovery'),false);
});

test('provider download rejection neither publishes an original nor becomes a mail-specific failure',async t=>{
 const f=await fixture(t);let attempts=0;
 f.adapter.collect=async()=>{attempts++;throw Object.assign(new Error('private provider response'),{code:'email_network_read_failed'});};
 const result=await f.run();
 assert.equal(attempts,1);
 assert.equal(result.status,'partial');assert.deepEqual(result.captures,[]);
 assert.equal(result.failures.length,1);
 assert.equal(result.failures[0].error_code,'email_network_read_failed');
 assert.equal(result.failures[0].failure_scope,'provider_operational');
 assert.equal(result.failures[0].qualified,false);
 assert.equal(f.records[0].counts.failures,1);assert.equal(f.records[0].counts.originals_acquired,0);
 assert.equal(JSON.stringify(result).includes('private provider response'),false);
});

test('opt-in phase evidence exposes bounded stage intervals without private values',async t=>{
 const f=await fixture(t);f.runtime.capturePhaseEvidence=true;
 await f.run();
 const [record]=f.records;
 assert.match(record.round_alias,/^[a-f0-9]{16}$/u);
 for(const stage of ['discover','prepare_original','original_transfer_write']){
  assert.equal(record.intervals[stage].length,1);
  const {began_at,ended_at}=record.intervals[stage][0];
  assert.ok(Date.parse(began_at)<=Date.parse(ended_at));
 }
 for(const secret of [f.root,'private@example.test','private-id','private body'])assert.equal(JSON.stringify(record).includes(secret),false);
});
