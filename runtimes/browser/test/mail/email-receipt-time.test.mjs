import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {receiptTimeNanos} from '../../applications/mail/lib/receipt-time.mjs';
import {capturePage,validateCaptureInput} from '../../applications/mail/lib/read-capture.mjs';

test('receipt checkpoints preserve nanoseconds and equivalent timezone offsets',()=>{
 const at=receiptTimeNanos('2026-09-16T00:00:00.123456789Z');
 assert.equal(receiptTimeNanos('2026-09-16T08:00:00.123456789+08:00'),at);
 assert.equal(receiptTimeNanos('2026-09-15T20:30:00.123456789-03:30'),at);
 assert.equal(at-receiptTimeNanos('2026-09-16T00:00:00.123456788Z'),1n);
 for(const invalid of ['2026-02-30T00:00:00Z','2026-09-16T25:00:00Z','2026-09-16T00:00:00.1234567890Z','2026-09-16T00:00:00+24:00','2026-09-16T00:00:00'])assert.equal(receiptTimeNanos(invalid),null);
});

test('timeline capture entry accepts a legal empty nanosecond interval with offset and no durability work',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'email-nanorange-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const options={account_address:'owner@example.test',lane:'recent_inbound',continuation:'',limit:50,provider_mode:'time_range',interval_start:'2026-09-16T08:00:00.123456788+08:00',interval_end:'2026-09-16T00:00:00.123456789Z'};
 const input={schema_version:1,operation:'collect_page',invocation_id:'nanorange',provider:'gmail',account:'default',owner_scope:'a'.repeat(64),discovery:options};
 validateCaptureInput(input,'gmail');let lists=0;
 const result=await capturePage(input,{emailWorkspaceRoot:root,withReadTab:fn=>fn({})},'gmail',{discover:async()=>{lists++;return {discovery:{account_address:options.account_address,status:'empty',candidates:[],coverage:{scan_complete:true}},listed:{}};},collect:()=>assert.fail('empty range downloaded a source')});
 assert.equal(lists,1);assert.equal(result.status,'empty');assert.equal(result.captures.length,0);
 assert.equal((await fs.readdir(path.join(root,'email',input.owner_scope,'batches'))).length,0);
 assert.throws(()=>validateCaptureInput({...input,discovery:{...options,interval_end:options.interval_start}},'gmail'),{code:'invalid_request'});
});
