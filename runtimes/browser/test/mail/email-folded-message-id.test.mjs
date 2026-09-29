import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {capturePage} from '../../applications/mail/lib/read-capture.mjs';

for(const [label,value,accepted] of [
 ['empty initial line with folded ID','\r\n\t<folded@example.test>',true],
 ['multiple empty continuation lines','\r\n \r\n\t<folded@example.test>',true],
 ['unfolded ID',' <folded@example.test>',true],
 ['unbracketed ID','\r\n\tbroken@example.test',false],
 ['multiple IDs','\r\n\t<one@example.test> <two@example.test>',false],
])test(`original header probe: ${label}`,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'folded-id-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const target={account_address:'owner@example.test',provider_message_id:'one',provider_selection_id:'one',folder:'inbox'};
 const original=Buffer.from(`From: sender@example.test\r\nMessage-ID:${value}\r\nDate: Tue, 15 Sep 2026 00:00:00 +0000\r\n\r\nOriginal bytes unchanged.`);
 const input={schema_version:1,operation:'collect_page',provider:'qq_mail',account:'default',owner_scope:'a'.repeat(64),invocation_id:`email_changes_${'3'.repeat(64)}_r1`,discovery:{account_address:target.account_address,continuation:'',lane:'recent_inbound',limit:50,provider_mode:'time_range',interval_start:'2026-09-15T00:00:00Z',interval_end:'2026-09-16T00:00:00Z'}};
 const result=await capturePage(input,{emailWorkspaceRoot:root,withReadTab:fn=>fn({})},'qq_mail',{
  discover:async()=>({listed:{},discovery:{account_address:target.account_address,candidates:[target],status:'listed'}}),
  collect:async(_tab,_provider,options)=>{await options.onSelected(target);return {...target,original:{selector:'original',inline_base64:original.toString('base64'),inline_bytes:original.length,bytes:original.length}};},
 });
 if(accepted){
  assert.equal(result.failures.length,0);assert.equal(result.captures.length,1);
  const file=path.join(root,result.captures[0].result.capture.manifest_path);
  const manifest=JSON.parse(await fs.readFile(file));
  assert.equal(manifest.metadata.message_id,'<folded@example.test>');
  assert.deepEqual(await fs.readFile(path.join(path.dirname(file),'message.eml')),original);
 }else{
  assert.equal(result.captures.length,0);assert.equal(result.failures[0].error_code,'email_capture_invalid');
 }
});
