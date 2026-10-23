import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {attachmentDOM,verifyManagedAttachments} from '../../applications/mail/lib/workspace-attachments.mjs';
const node=extra=>({isConnected:true,disabled:false,getBoundingClientRect:()=>({width:20,height:20}),getAttribute:()=>null,querySelectorAll:()=>[],...extra});
function environment(mode){
 const body=node(),send=node({disabled:mode==='send_unready'}),name=node({getAttribute:key=>key==='title'?(mode==='row_name'?'wrong':'private-file.txt'):null,textContent:mode==='row_name'?'wrong':'private-file.txt'}),remove=node({getAttribute:key=>key==='aria-label'?'Remove attachment':null});
 const row=node({querySelectorAll:selector=>selector.includes('.vI')?[name]:mode==='row_remove'?[]:[remove]});
 const root=node({contains:()=>true,querySelectorAll:selector=>selector==='.aQH .dL'?(mode==='row_count'?[]:[row]):selector.startsWith('[role="progressbar"]')?(mode==='upload_pending'?[node()]:[]):selector.startsWith('[role="alert"]')?(mode==='upload_alert'?[node()]:[]):[]});
 return {document:{},getComputedStyle:()=>({visibility:'visible'}),__sparkclawManagedMail:{provider:'gmail',ownershipChecked:true,root,body,send}};
}
const expected=[{name:'private-file.txt',size_bytes:10,sha256:'sha256:'+'a'.repeat(64)}];
for(const mode of ['send_unready','upload_pending','upload_alert','row_count','row_name','row_remove','ready'])test(`attachment readiness retains exact ${mode} gate and reports fixed facts`,()=>{
 const result=vm.runInNewContext(`(${attachmentDOM.toString()})('gmail','ready',${JSON.stringify(expected)})`,environment(mode));
 assert.equal(result.ready,mode==='ready');
 if(mode==='ready')assert.equal(result.count,1);
 else {assert.equal(result.check,mode);assert.equal(result.diagnostic.expected_count,1);assert.equal(result.diagnostic.known_rows,mode==='row_count'?0:1);assert.equal(result.diagnostic.send_ready,mode!=='send_unready');assert.equal(result.diagnostic.pending,mode==='upload_pending');assert.doesNotMatch(JSON.stringify(result),/private|\.txt|sha256/);}
 if(mode==='upload_alert')assert.equal(result.error,'email_attachment_upload_failed');
});

test('attachment failure always emits a small bounded record without optional detailed evidence',async t=>{
 const writes=[];t.mock.method(process.stderr,'write',chunk=>{writes.push(String(chunk));return true;});
 const result={ready:false,check:'row_count',wait_timed_out:true,diagnostic:{known_rows:0,expected_count:1,send_ready:true,pending:false,private:'private-file.txt',input_connected:'private'}};
 const tab={inspect:async()=>({result})};
 await assert.rejects(verifyManagedAttachments(tab,'gmail',expected),{code:'email_attachment_upload_unverified'});
 assert.deepEqual(JSON.parse(writes[0]),{event:'mail_attachment_validation_failed',provider:'gmail',phase:'verify',check:'row_count',ready:false,wait_timed_out:true,known_rows:0,expected_count:1,send_ready:true,pending:false});
 result.check='private-file.txt';result.diagnostic.known_rows=1001;result.diagnostic.expected_count=-1;
 await assert.rejects(verifyManagedAttachments(tab,'gmail',expected),{code:'email_attachment_upload_unverified'});
 assert.equal(JSON.parse(writes[1]).check,'unavailable');assert.equal(JSON.parse(writes[1]).known_rows,undefined);assert.equal(JSON.parse(writes[1]).expected_count,undefined);assert.doesNotMatch(writes.join(''),/private|\.txt/);
 t.mock.method(process.stderr,'write',()=>{throw Error('diagnostic failed')});
 await assert.rejects(verifyManagedAttachments(tab,'gmail',expected),{code:'email_attachment_upload_unverified'});
});
