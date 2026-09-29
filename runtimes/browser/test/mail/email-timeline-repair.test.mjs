import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import {capturePage} from '../../applications/mail/lib/read-capture.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'timeline-repair-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const target={account_address:'owner@example.test',provider_message_id:'mail1',provider_selection_id:'mail1',folder:'inbox'};
 let bytes=Buffer.from('From: sender@example.test\r\nDate: Tue, 15 Sep 2026 00:00:00 +0000\r\nMessage-ID: <one@example.test>\r\n\r\nOriginal body\r\n'), calls=0, round=0;
 const input={schema_version:1,operation:'collect_page',provider:'gmail',account:'default',owner_scope:'a'.repeat(64),invocation_id:'',discovery:{account_address:target.account_address,continuation:'',lane:'recent_inbound',limit:50,provider_mode:'time_range',interval_start:'2026-09-15T00:00:00Z',interval_end:'2026-09-16T00:00:00Z',retry_targets:[]}};
 const adapter={discover:async()=>({discovery:{account_address:target.account_address,candidates:[target],status:'collected'},listed:{}}),collect:async(_tab,_provider,options)=>{calls++;await options.onSelected(target);return {...target,original:{selector:'original',inline_base64:bytes.toString('base64'),inline_bytes:bytes.length,bytes:bytes.length}};}};
 const runtime={emailWorkspaceRoot:root,withReadTab:callback=>callback({})};
 return {root,input,run:()=>capturePage({...input,invocation_id:`email_changes_${String(++round).padStart(64,'0')}_r1`},runtime,'gmail',adapter),calls:()=>calls,change:()=>{bytes=Buffer.from(bytes.toString().replace('Original body','Changed body!'));}};
}

for(const damage of ['missing','tampered'])test(`timeline isolates ${damage} original and restores exact manifest on next round`,async t=>{
 const f=await fixture(t),first=await f.run(),ref=first.captures[0].result.capture;
 const manifestPath=path.join(f.root,ref.manifest_path),raw=await fs.readFile(manifestPath),original=path.join(path.dirname(manifestPath),'message.eml');
 if(damage==='missing')await fs.unlink(original);else await fs.writeFile(original,'bad bytes');
 const failed=await f.run();assert.equal(failed.captures.length,0);assert.equal(failed.failures[0].failure_scope,'local_operational');assert.equal(failed.failures[0].qualified,false);assert.equal(f.calls(),1);
 const repaired=await f.run();assert.equal(repaired.captures.length,1);assert.equal(f.calls(),2);assert.deepEqual(await fs.readFile(manifestPath),raw);assert.equal(repaired.captures[0].result.capture.manifest_sha256,ref.manifest_sha256);
 await f.run();assert.equal(f.calls(),2);
 const quarantine=path.join(f.root,'email',f.input.owner_scope,'quarantine',ref.mailbox_id,ref.mail_id);
 assert.equal((await fs.readdir(quarantine)).length,1);
});

test('different reread bytes remain a local conflict, preserving quarantined first manifest',async t=>{
 const f=await fixture(t),first=await f.run(),ref=first.captures[0].result.capture;
 await fs.unlink(path.join(f.root,path.dirname(ref.manifest_path),'message.eml'));
 await f.run();f.change();const result=await f.run();
 assert.equal(result.captures.length,0);assert.equal(result.failures[0].error_code,'email_source_conflict');assert.equal(result.failures[0].failure_scope,'local_operational');assert.equal(result.failures[0].qualified,false);
 const parent=path.join(f.root,'email',f.input.owner_scope,'quarantine',ref.mailbox_id,ref.mail_id);
 const [entry]=await fs.readdir(parent),retained=await fs.readdir(path.join(parent,entry));
 assert.ok(retained.includes('source'));assert.ok(retained.some(name=>name.startsWith('candidate_')));
});

test('foreign index cannot move another valid source or fetch a replacement',async t=>{
 const f=await fixture(t),first=await f.run(),ref=first.captures[0].result.capture;
 const index=path.join(f.root,'email',f.input.owner_scope,'index',ref.mailbox_id,ref.mail_id,`${ref.capture_id}.json`);
 const pointer=JSON.parse(await fs.readFile(index));pointer.manifest_path=pointer.manifest_path.replace(f.input.owner_scope,'b'.repeat(64));await fs.writeFile(index,JSON.stringify(pointer));
 const result=await f.run();assert.equal(result.captures.length,0);assert.equal(result.failures[0].error_code,'email_source_recovery_pending');assert.equal(f.calls(),1);assert.ok(await fs.stat(path.join(f.root,ref.manifest_path)));
});

test('Store descriptor repairs missing manifest and index while preserving their original hash',async t=>{
 const f=await fixture(t),first=await f.run(),ref=first.captures[0].result.capture;
 const manifestPath=path.join(f.root,ref.manifest_path),raw=await fs.readFile(manifestPath,'utf8'),manifest=JSON.parse(raw);
 const descriptor={id:ref.capture_id,manifest_json:raw,manifest_path:ref.manifest_path,manifest_sha256:ref.manifest_sha256,original_path:manifest.files[0].path,original_sha256:manifest.files[0].sha256};
 f.input.discovery.retry_targets=[{...first.captures[0].target,recovery_capture:descriptor}];
 await fs.unlink(manifestPath);
 await fs.unlink(path.join(f.root,'email',f.input.owner_scope,'index',ref.mailbox_id,ref.mail_id,`${ref.capture_id}.json`));
 const recovered=await f.run();assert.equal(recovered.captures.length,1);assert.equal(f.calls(),2);assert.equal(await fs.readFile(manifestPath,'utf8'),raw);
 assert.equal(recovered.captures[0].result.capture.manifest_sha256,ref.manifest_sha256);
});

test('Store hash rejects a forged local repair marker before provider reread',async t=>{
 const f=await fixture(t),first=await f.run(),ref=first.captures[0].result.capture;
 const manifestPath=path.join(f.root,ref.manifest_path),raw=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(raw);
 await fs.unlink(path.join(path.dirname(manifestPath),'message.eml'));await f.run();
 const index=path.join(f.root,'email',f.input.owner_scope,'index',ref.mailbox_id,ref.mail_id,`${ref.capture_id}.json.recovery.json`),marker=JSON.parse(await fs.readFile(index));
 marker.manifest_base64=Buffer.from(raw+' ').toString('base64');marker.manifest_sha256='sha256:'+crypto.createHash('sha256').update(raw+' ').digest('hex');await fs.writeFile(index,JSON.stringify(marker));
 f.input.discovery.retry_targets=[{...first.captures[0].target,recovery_capture:{id:ref.capture_id,manifest_json:raw,manifest_path:ref.manifest_path,manifest_sha256:ref.manifest_sha256,original_path:m.files[0].path,original_sha256:m.files[0].sha256}}];
 const result=await f.run();assert.equal(result.captures.length,0);assert.equal(result.failures[0].error_code,'email_source_recovery_pending');assert.equal(f.calls(),1);
});
