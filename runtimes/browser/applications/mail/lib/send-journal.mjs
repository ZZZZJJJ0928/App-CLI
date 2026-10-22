import {attachmentMessageFingerprint} from './workspace-attachments.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const account=v=>{const i=v.lastIndexOf('@');return v.slice(0,i)+'@'+v.slice(i+1).toLowerCase()};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
export async function openSendJournal(workspace,request,originalMode){
 if(typeof workspace!=='string'||!path.isAbsolute(workspace))throw Object.assign(new Error('email_send_journal_unavailable'),{code:'email_send_journal_unavailable'});
 const directory=path.join(workspace,'email-send',hash(`${request.provider}\0${account(request.account_address)}`));
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const realRoot=await fs.realpath(workspace),realDirectory=await fs.realpath(directory);
 if(!realDirectory.startsWith(realRoot+path.sep))throw Object.assign(new Error('email_send_journal_unavailable'),{code:'email_send_journal_unavailable'});
 const file=path.join(directory,hash(request.invocation_id)+'.json');
 const fingerprint=hash(JSON.stringify(canonical({provider:request.provider,account:account(request.account_address),message:attachmentMessageFingerprint(request.message),target:request.reply_target??null})));
 let saved=null;
 try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32000)throw new Error('invalid');saved=JSON.parse(await fs.readFile(file,'utf8'));if(saved.fingerprint!==fingerprint||request.mode!=='reconcile'&&saved.mode!==request.mode)throw Object.assign(new Error('email_send_journal_conflict'),{code:'email_send_journal_conflict'});}catch(e){if(e.code!=='ENOENT')throw e;}
 return {saved,async write(stage,receipt,evidence){if(stage==='sent'&&saved?.stage!=='dispatching')return false;const next={schema_version:1,fingerprint,mode:request.mode==='reconcile'?(saved?.mode??originalMode):request.mode,stage,receipt:receipt??null,...(stage==='sent'&&evidence?{evidence}:{}),updated_at:new Date().toISOString()};const temp=file+'.'+crypto.randomUUID()+'.tmp';const f=await fs.open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(next));await f.sync();}finally{await f.close()}if(stage==='dispatching'||stage==='not_sent'){try{await fs.link(temp,file)}catch(e){if(e.code!=='EEXIST')throw e;return false}finally{await fs.unlink(temp)}}else{await fs.rename(temp,file)}const d=await fs.open(directory,'r');try{await d.sync()}finally{await d.close()}saved=next;this.saved=next;return true;}};
}
// Reclaim the journal of a send whose ledger row was reclaimed after its
// receipt retention; the product keeps the user-visible send history.
export async function removeSendJournal(workspace,request){
 if(typeof workspace!=='string'||!path.isAbsolute(workspace)||typeof request?.invocation_id!=='string'||typeof request.account_address!=='string')return false;
 const directory=path.join(workspace,'email-send',hash(`${request.provider}\0${account(request.account_address)}`));
 try{await fs.unlink(path.join(directory,hash(request.invocation_id)+'.json'));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}
}
