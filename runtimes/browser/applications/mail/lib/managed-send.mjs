import crypto from 'node:crypto';
import {managedSendDOM} from './managed-send-dom.mjs';
import {openSendJournal} from './send-journal.mjs';
import {collectUnread} from '../read.mjs';
import {providerAccountDOM,READ_PROVIDERS} from './provider-account.mjs';

export const managedSendError=code=>Object.assign(new Error(code),{code});
const fail=managedSendError;
const exact=(v,required,optional=[])=>v&&typeof v==='object'&&!Array.isArray(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>[...required,...optional].includes(k));
export const isManagedSend=input=>input&&(['mode','account_address','reply_target'].some(k=>Object.hasOwn(input,k))||input.message&&['to','cc'].some(k=>Object.hasOwn(input.message,k)));
export function validateManagedSend(input,provider){
 if(!exact(input,['schema_version','operation','invocation_id','provider','account','message','account_address'],['mode','reply_target'])||input.schema_version!==1||input.operation!=='send'||input.provider!==provider||input.account!=='default'||!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.invocation_id||''))throw fail('email_send_invalid_input');
 const address=v=>typeof v==='string'&&v.length<=320&&/^[^\s<>@\x00-\x1f]+@[^\s<>@\x00-\x1f]+\.[^\s<>@\x00-\x1f]+$/u.test(v);
 const mode=input.mode??'compose',m=input.message;
 if(!address(input.account_address)||!['compose','reply','reply_all','reconcile'].includes(mode)||!exact(m,['to','body'],['cc','subject'])||!Array.isArray(m.to)||!m.to.length||m.to.length>100||!Array.isArray(m.cc??[])||(m.cc??[]).length>100||m.to.length+(m.cc??[]).length>100||[...m.to,...m.cc??[]].some(v=>!address(v)))throw fail('email_send_invalid_input');
 const normalize=v=>{const i=v.lastIndexOf('@');return v.slice(0,i)+'@'+v.slice(i+1).toLowerCase()};
 const recipients=[...m.to,...m.cc??[]].map(normalize);if(new Set(recipients).size!==recipients.length)throw fail('email_send_invalid_input');
 if(!exact(m.body,['format','content'])||m.body.format!=='text'||typeof m.body.content!=='string'||!m.body.content.trim()||m.body.content.includes('\0')||Buffer.byteLength(m.body.content)>204800||typeof(m.subject??'')!=='string'||/[\r\n\0]/u.test(m.subject??'')||[...m.subject??''].length>998)throw fail('email_send_invalid_input');
 if(mode==='compose'&&input.reply_target!==undefined)throw fail('email_send_invalid_input');
 if(mode!=='compose'&&mode!=='reconcile'||mode==='reconcile'&&input.reply_target){
 const t=input.reply_target;
 if(!exact(t,['account_address','provider_message_id','provider_selection_id','folder','subject'],['provider_thread_id'])||normalize(t.account_address)!==normalize(input.account_address)||['provider_message_id','provider_selection_id'].some(k=>typeof t[k]!=='string'||!/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/u.test(t[k]))||!['inbox','sent','all'].includes(t.folder)&&!/^qq:[1-9][0-9]{3,9}$/u.test(t.folder)||typeof t.subject!=='string'||t.subject.length>4000)throw fail('email_send_invalid_input');
 }
 return {...input,account_address:normalize(input.account_address),mode,message:{to:[...m.to],cc:[...m.cc??[]],subject:m.subject??'',body:{format:'text',content:m.body.content}},recipientDigest:`sha256:${crypto.createHash('sha256').update(JSON.stringify({to:m.to,cc:m.cc??[]})).digest('hex')}`};
}

async function sendAccountHash(tab,provider){
 const evidence=await tab.inspect(`async()=>{if(!${JSON.stringify(READ_PROVIDERS[provider].origins)}.includes(location.origin))return {error:'email_provider_origin_invalid'};let observed;const deadline=Date.now()+5000;do{observed=(${providerAccountDOM.toString()})(${JSON.stringify(provider)});if(observed?.account_address)break;await new Promise(r=>setTimeout(r,100))}while(Date.now()<deadline);if(!observed?.account_address)return {url:location.href,account_hash:null};const a=observed.account_address,i=a.lastIndexOf('@'),value=a.slice(0,i)+'@'+a.slice(i+1).toLowerCase();return {url:location.href,account_hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('')};}`);
 if(evidence?.result?.url!==evidence?.origin||!READ_PROVIDERS[provider].origins.includes(new URL(evidence.origin).origin))throw fail('email_provider_origin_invalid');
 return evidence.result.account_hash;
}
export async function verifySendAccount(tab,provider,expected){
 let accountHash=await sendAccountHash(tab,provider);
 if(!accountHash&&provider==='outlook'){
  await tab.click('#O365_MainLink_MePhoto, #O365_MeFlexPane_ButtonID, [data-testid="mectrl_headerPicture"]');
  accountHash=await sendAccountHash(tab,provider);await tab.press('Escape');
 }
 if(!accountHash||accountHash!==digest(canonicalAddress(expected)))throw fail('email_account_identity_mismatch');
}

export async function openNativeReplyTarget(tab,provider,request){
 const target=request.reply_target;
 // Reuse individual-message selection proofs and account checks from capture,
 // but never export/download or create a new message as a reply fallback.
 const message=await collectUnread(tab,provider,{account_address:request.account_address,folder:target.folder,pinned_message_id:target.provider_message_id,pinned_selection_id:target.provider_selection_id,capture_required:false,onSelected:async selected=>{if(selected.members?.some(member=>member.draft))throw fail('email_existing_draft')}});
 if(message.provider_message_id!==target.provider_message_id||message.provider_selection_id!==target.provider_selection_id)throw fail('email_reply_target_unverified');
 return message;
}

const CONTROL=name=>`[data-sc-mail-control="${name}"]`;
export const MANAGED_SEND_SELECTOR='[data-sc-managed-send="true"]';
async function native(tab,provider,phase,expected={}){
 // The CLI intentionally redacts message secrets in returned DOM text. Compare
 // browser-computed digests instead of trying to unmask or export that text.
 const r=await tab.inspect(`async()=>{const value=(${managedSendDOM.toString()})(${JSON.stringify(provider)},${JSON.stringify(phase)},${JSON.stringify(expected)});if(!value||value.error)return value;const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');const addr=v=>{const i=v.lastIndexOf('@');return v.slice(0,i)+'@'+v.slice(i+1).toLowerCase()};if(${JSON.stringify(phase)}==='readback'){return {to_count:value.to.length,cc_count:value.cc.length,to_hash:await hash(JSON.stringify(value.to.map(addr).sort())),cc_hash:await hash(JSON.stringify(value.cc.map(addr).sort())),subject_hash:await hash(value.subject??''),body_hash:await hash(value.body),send_ready:value.send_ready,linked:value.linked};}if(value.subject!==undefined){value.subject_hash=await hash(value.subject);delete value.subject;}return value;}`);
 if(r?.result?.error)throw fail(r.result.error);
 if(!r?.result)throw fail('email_send_precondition_failed');if(r.result.action_selector)await tab.click(r.result.action_selector);return r.result;
}
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonicalAddress=value=>{const i=value.lastIndexOf('@');return value.slice(0,i)+'@'+value.slice(i+1).toLowerCase()};
const addressDigest=values=>digest(JSON.stringify(values.map(canonicalAddress).sort()));
export async function prepareManagedDraft(tab,provider,request){
 await verifySendAccount(tab,provider,request.account_address);
 let target;
 if(request.mode!=='compose')target=await openNativeReplyTarget(tab,provider,request);
 const expected={mode:request.mode,needs_cc:request.message.cc.length>0,provider_message_id:target?.provider_message_id,provider_selection_id:target?.provider_selection_id,individual_message_proven:target?.individual_message_proven===true,single_message_proven:target?.single_message_proven===true,evidence_key:target?.evidence_key};
 let opened=await native(tab,provider,'open',expected);
 if(opened.menu_opened)opened=await native(tab,provider,'reply_menu',expected);
 if(!opened.opened)throw fail('email_reply_editor_unverified');
 let editor;
 for(let attempt=0;attempt<8;attempt++){
  try{editor=await native(tab,provider,'editor',expected);if(editor.ready)break;}catch(e){if(!['email_reply_editor_unverified','email_recipient_editor_unverified'].includes(e.code)||attempt===7)throw e}
  await tab.inspect('async()=>{await new Promise(r=>setTimeout(r,200));return {waited:true}}');
 }
 if(!editor?.ready)throw fail('email_reply_editor_unverified');
 if(!editor.has_subject&&editor.subject_hash!==digest(request.message.subject)){
  await native(tab,provider,'edit_subject');await native(tab,provider,'subject_menu');
  for(let i=0;i<8;i++){await tab.inspect('async()=>{await new Promise(r=>setTimeout(r,200));return {waited:true}}');editor=await native(tab,provider,'editor',expected);if(editor.ready&&editor.has_subject)break;}
  if(!editor.ready||!editor.has_subject)throw fail('email_draft_fields_unverified');
 }
 // Clear native reply defaults through native input keys, never remove DOM
 // chips directly (which would leave provider state and UI inconsistent).
 for(const field of ['to','cc']){
  if(field==='cc'&&!editor.has_cc){if(request.message.cc.length)throw fail('email_cc_unavailable');continue}
  await tab.focus(CONTROL(field));
  await tab.press('ControlOrMeta+A');await tab.press('Backspace');
  for(let i=0;i<100;i++){
   const current=await native(tab,provider,'readback');
   if(current[field+'_count']===0)break;
   await tab.press('Backspace');await tab.press('Backspace');
   if(i===99)throw fail('email_recipient_verification_failed');
  }
  for(const address of request.message[field]){
   // React providers can replace recipient inputs when the last default chip
   // is removed. Re-prove and mark the current native controls before fill.
   editor=await native(tab,provider,'editor',expected);
   if(!editor.ready)throw fail('email_recipient_editor_unverified');
   await tab.fill(CONTROL(field),address);await tab.press('Enter');
  }
 }
 editor=await native(tab,provider,'editor',expected);
 if(!editor.ready)throw fail('email_draft_fields_unverified');
 if(editor.has_subject)await tab.fill(CONTROL('subject'),request.message.subject);
 await tab.fill(CONTROL('body'),request.message.body.content);
 const readback=await native(tab,provider,'readback');
 if(readback.to_hash!==addressDigest(request.message.to)||readback.cc_hash!==addressDigest(request.message.cc)||readback.subject_hash!==digest(request.message.subject)||readback.body_hash!==digest(request.message.body.content.replace(/\r\n?/gu,'\n'))||!readback.send_ready||!readback.linked)throw fail('email_draft_fields_unverified');
 await verifySendAccount(tab,provider,request.account_address);
 return {target};
}

export async function discardManagedDraft(tab,provider){
 const started=await native(tab,provider,'discard');
 if(!started.discard_started)return {discarded:started.discarded===true};
 await native(tab,provider,'discard_confirm');
 const result=await tab.inspect(`async()=>{const deadline=Date.now()+3000;do{const state=(${managedSendDOM.toString()})(${JSON.stringify(provider)},"discard_status",{});if(state.discarded)return state;await new Promise(r=>setTimeout(r,100))}while(Date.now()<deadline);return {discarded:false}}`);
 return {discarded:result?.result?.discarded===true};
}

function sentDOM(provider,arm=false){
 const visible=n=>n?.getBoundingClientRect().width>0&&n?.getBoundingClientRect().height>0;
 const text=n=>(n?.innerText??n?.textContent??'').trim();
 const editors=[...document.querySelectorAll('[data-sc-mail-control="body"]')].filter(visible);
 const nodes=[...document.querySelectorAll('.bAq,[role="status"],[role="alert"],.xmail-ui-toast')].filter(visible);
 if(arm){globalThis.__sparkclawSendNotices=nodes.map(n=>({node:n,text:text(n)}));return {armed:true}}
 const notices=nodes.filter(n=>!(globalThis.__sparkclawSendNotices??[]).some(before=>before.node===n&&before.text===text(n))).map(text);
 const confirmed=!editors.length&&notices.some(v=>/^(Message sent|邮件已发送|已发送|发送成功|Sent)(?:$|[ .。])/u.test(v));
 return {confirmed};
}
export async function sendManagedMail(raw,provider,runtime){
 const request=validateManagedSend(raw,provider);
 if(!request.message.subject.trim())throw fail('email_send_invalid_input');
 const journal=await openSendJournal(runtime.emailWorkspaceRoot,request);
 const unknown={schema_version:1,status:'unknown',provider,recipient_digest:request.recipientDigest};
 if(journal.saved?.stage==='sent')return journal.saved.receipt;
 if(request.mode==='reconcile'||journal.saved?.stage==='dispatching')return unknown;
 if(typeof runtime.withSendTab!=='function')throw fail('email_send_configuration_error');
 let attempted=false;
 try{return await runtime.withSendTab(async tab=>{
  await tab.runReadCode(`async page=>{await page.goto(${JSON.stringify(READ_PROVIDERS[provider].url)});return true}`);
  if(runtime.prepareSendPage)await runtime.prepareSendPage();
  let claimed;
  try{await prepareManagedDraft(tab,provider,request);await tab.inspect(`()=>(${sentDOM.toString()})(${JSON.stringify(provider)},true)`);claimed=await journal.write('dispatching');}catch(error){try{await discardManagedDraft(tab,provider)}catch{}throw error}
  if(!claimed){try{await discardManagedDraft(tab,provider)}catch{}return unknown;}
  attempted=true;
  await tab.inspect('()=>{if(globalThis.__sparkclawManagedMail)globalThis.__sparkclawManagedMail.sendAttempted=true;return {marked:true}}');
  await tab.click(MANAGED_SEND_SELECTOR);
  let proof;
  for(let i=0;i<12;i++){
   proof=(await tab.inspect(`async()=>{await new Promise(r=>setTimeout(r,250));return (${sentDOM.toString()})(${JSON.stringify(provider)})}`)).result;
   if(proof?.confirmed)break;
  }
  if(!proof?.confirmed)throw fail('send_outcome_unknown');
  const result={schema_version:1,status:'sent',provider,recipient_digest:request.recipientDigest};
  await journal.write('sent',result);return result;
 });}catch(error){if(attempted)throw fail('send_outcome_unknown');throw error}
}
