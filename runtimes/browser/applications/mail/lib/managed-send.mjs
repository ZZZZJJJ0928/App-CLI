import {validateAttachments,uploadManagedAttachments,verifyManagedAttachments} from './workspace-attachments.mjs';
import {OUTLOOK_SENT_BASELINE_EXPRESSION,OUTLOOK_SEND_VERIFICATION_EXPRESSION} from './outlook-send-proof.mjs';
import crypto from 'node:crypto';
import {QQMAIL_SENT_FOLDER_SELECTOR,QQMAIL_SENT_BASELINE_EXPRESSION,QQMAIL_SENT_VERIFICATION_EXPRESSION} from './qqmail-send-proof.mjs';
import {managedSendDOM} from './managed-send-dom.mjs';
import {openSendJournal} from './send-journal.mjs';
import {reportLearnedRequests} from './network-reader.mjs';
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
 if(!address(input.account_address)||!['compose','reply','reply_all','reconcile'].includes(mode)||!exact(m,['to','body'],['cc','subject','attachments'])||!Array.isArray(m.to)||!m.to.length||m.to.length>100||!Array.isArray(m.cc??[])||(m.cc??[]).length>100||m.to.length+(m.cc??[]).length>100||[...m.to,...m.cc??[]].some(v=>!address(v)))throw fail('email_send_invalid_input');
 const normalize=v=>{const i=v.lastIndexOf('@');return v.slice(0,i)+'@'+v.slice(i+1).toLowerCase()};
 const recipients=[...m.to,...m.cc??[]].map(normalize);if(new Set(recipients).size!==recipients.length)throw fail('email_send_invalid_input');
 if(!exact(m.body,['format','content'])||m.body.format!=='text'||typeof m.body.content!=='string'||!m.body.content.trim()||m.body.content.includes('\0')||Buffer.byteLength(m.body.content)>204800||typeof(m.subject??'')!=='string'||/[\r\n\0]/u.test(m.subject??'')||[...m.subject??''].length>998)throw fail('email_send_invalid_input');
 if(mode==='compose'&&input.reply_target!==undefined)throw fail('email_send_invalid_input');
 if(mode!=='compose'&&mode!=='reconcile'||mode==='reconcile'&&input.reply_target){
 const t=input.reply_target;
 if(!exact(t,['account_address','provider_message_id','provider_selection_id','folder','subject'],['provider_thread_id'])||normalize(t.account_address)!==normalize(input.account_address)||['provider_message_id','provider_selection_id'].some(k=>typeof t[k]!=='string'||!/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/u.test(t[k]))||!['inbox','sent','all'].includes(t.folder)&&!/^qq:[1-9][0-9]{3,9}$/u.test(t.folder)||typeof t.subject!=='string'||t.subject.length>4000)throw fail('email_send_invalid_input');
 }
 const attachments=validateAttachments(m.attachments,mode);
 return {...input,account_address:normalize(input.account_address),mode,message:{to:[...m.to],cc:[...m.cc??[]],subject:m.subject??'',body:{format:'text',content:m.body.content},...(attachments.length?{attachments}:{})},recipientDigest:`sha256:${crypto.createHash('sha256').update(JSON.stringify({to:m.to,cc:m.cc??[]})).digest('hex')}`};
}

async function sendAccountHash(tab,provider){
 const evidence=await tab.inspect(`async()=>{if(!${JSON.stringify(READ_PROVIDERS[provider].origins)}.includes(location.origin))return {error:'email_provider_origin_invalid'};let observed;const deadline=Date.now()+5000;do{const reader=window.SparkClawMailReader;if(reader){if(reader.provider!==${JSON.stringify(provider)}||reader.version!=='0.2.0')return {url:location.href,account_hash:null};try{observed=reader.snapshot({interval_start:"1970-01-01T00:00:00Z",interval_end:"1970-01-01T00:00:01Z"});}catch(error){if(error.code!=='email_account_identity_unavailable')return {url:location.href,account_hash:null};}}else{observed=(${providerAccountDOM.toString()})(${JSON.stringify(provider)});}if(observed?.account_address)break;await new Promise(r=>setTimeout(r,100))}while(Date.now()<deadline);if(!observed?.account_address)return {url:location.href,account_hash:null};const value=observed.account_address.toLowerCase();return {url:location.href,account_hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('')};}`);
 if(evidence?.result?.url!==evidence?.origin||!READ_PROVIDERS[provider].origins.includes(new URL(evidence.origin).origin))throw fail('email_provider_origin_invalid');
 return evidence.result.account_hash;
}
export async function verifySendAccount(tab,provider,expected){
 let accountHash=await sendAccountHash(tab,provider);
 if(!accountHash&&provider==='outlook'){
  await tab.click('#O365_MainLink_MePhoto, #O365_MeFlexPane_ButtonID, [data-testid="mectrl_headerPicture"]');
  accountHash=await sendAccountHash(tab,provider);await tab.press('Escape');
 }
 // Account bindings use the Reader's case-insensitive provider identity. An
 // Outlook login alias in the account menu is not necessarily its mailbox.
 if(!accountHash||accountHash!==digest(expected.toLowerCase()))throw fail('email_account_identity_mismatch');
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
 const r=await tab.inspect(`async()=>{const value=(${managedSendDOM.toString()})(${JSON.stringify(provider)},${JSON.stringify(phase)},${JSON.stringify(expected)});if(!value||value.error)return value;const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');const addr=v=>{const i=v.lastIndexOf('@');return v.slice(0,i)+'@'+v.slice(i+1).toLowerCase()};if(${JSON.stringify(phase)}==='readback'){return {to_count:value.to.length,cc_count:value.cc.length,to_hash:await hash(JSON.stringify(value.to.map(addr).sort())),cc_hash:await hash(JSON.stringify(value.cc.map(addr).sort())),subject_hash:await hash(value.subject??''),...(value.to_display?{recipient_display_hash:await hash(value.to_display.toLowerCase())}:{}),body_hash:await hash(value.body),send_ready:value.send_ready,linked:value.linked};}if(value.subject!==undefined){value.subject_hash=await hash(value.subject);delete value.subject;}return value;}`);
 if(r?.result?.error){
  if(['pending_to','pending_cc','unparsed_recipient','unexpected_bcc'].includes(r.result.check))process.stderr.write(JSON.stringify({event:'mail_recipient_validation_failed',provider,phase,check:r.result.check})+'\n');
  throw fail(r.result.error);
 }
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
 const readback=await verifyManagedDraft(tab,provider,request);
 return {target,recipientDisplayHash:readback.recipient_display_hash};
}

export async function verifyManagedDraft(tab,provider,request){
 const readback=await native(tab,provider,'readback');
 if(readback.to_hash!==addressDigest(request.message.to)||readback.cc_hash!==addressDigest(request.message.cc)||readback.subject_hash!==digest(request.message.subject)||readback.body_hash!==digest(request.message.body.content.replace(/\r\n?/gu,'\n'))||!readback.send_ready||!readback.linked)throw fail('email_draft_fields_unverified');
 await verifySendAccount(tab,provider,request.account_address);
 return readback;
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
// Native send prototype (opt-in: APP_CLI_MAIL_NATIVE_SEND=qq_mail). Only a
// plain compose without cc/attachments, on a page that already learned this
// account's own /send/sendmail request, skips the editor; otherwise the DOM
// flow runs and teaches the page. The Reader joins the actual response's
// messageid to a fresh independent Sent row before returning its emailid.
const nativePrototypeEligible=(provider,request)=>process.env.APP_CLI_MAIL_NATIVE_SEND==='qq_mail'&&provider==='qq_mail'&&request.mode==='compose'&&request.message.to.length===1&&!request.message.cc.length&&!request.message.attachments?.length&&Buffer.byteLength(JSON.stringify(request.message))<=48000;
const nativeMessage=request=>({account_address:request.account_address,to:request.message.to,cc:[],subject:request.message.subject,text:request.message.body.content});
const nativeReason=value=>typeof value==='string'&&/^[a-z_0-9]{1,80}$/.test(value)?value:undefined;
const nativeEvidence=()=>process.env.APP_CLI_MAIL_SEND_EVIDENCE==='1'||process.env.APP_CLI_MAIL_LEARNING_EVIDENCE==='1';
// Preflight, before the dispatch release and the journal claim: the page's
// template must be ready and its session must read a fresh Sent baseline.
// Anything else returns null: nothing was sent and the DOM flow continues.
export async function prepareNativeSend(tab,provider,request){
 if(!nativePrototypeEligible(provider,request)||typeof tab.runReadCode!=='function')return null;
 let value;
 try{value=await tab.runReadCode(`async page=>page.evaluate(async request=>{const r=window.SparkClawMailReader;if(r?.provider!=='qq_mail'||r.version!=='0.2.0'||typeof r.prepareNativeSend!=='function')return {ready:false,reason:'reader_unavailable'};try{return await r.prepareNativeSend(request)}catch(error){return {ready:false,reason:'reader_'+String(error?.code||'error').slice(0,64)}}},${JSON.stringify(nativeMessage(request))})`);}
 catch{value={ready:false,reason:'controller'};}
 const ready=value?.provider==='qq_mail'&&value.account_address===request.account_address.toLowerCase()&&value.ready===true&&
   typeof value.token==='string'&&/^[0-9]{1,15}:[a-z0-9]{1,32}$/.test(value.token);
 if(!ready&&nativeEvidence())process.stderr.write(JSON.stringify({event:'mail_native_send',provider,outcome:'not_sent',dispatched:false,fallback:'dom',reason:nativeReason(value?.reason)??'unavailable'})+'\n');
 return ready?{token:value.token}:null;
}
async function dispatchNativeSend(tab,provider,request,token){
 let value;
 try{value=await tab.runReadCode(`async page=>page.evaluate(async request=>{const r=window.SparkClawMailReader;if(r?.provider!=='qq_mail'||r.version!=='0.2.0'||typeof r.sendNative!=='function')return {outcome:'unknown',reason:'reader_unavailable'};try{return await r.sendNative(request)}catch(error){return {outcome:'unknown',reason:'reader_'+String(error?.code||'error').slice(0,64)}}},${JSON.stringify({...nativeMessage(request),token})})`);}
 catch{value={outcome:'unknown',reason:'controller'};}
 const id=v=>typeof v==='string'&&/^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/.test(v);
 const qualified=value?.provider==='qq_mail'&&value.account_address===request.account_address.toLowerCase()&&value.outcome==='sent'&&
   id(value.provider_message_id)&&id(value.response_message_id)&&value.proof?.source==='qq_sent_list_v1'&&
   value.proof.provider_message_id===value.provider_message_id&&value.proof.response_message_id===value.response_message_id&&
   value.proof.folder==='sent'&&value.proof.fresh===true;
 if(nativeEvidence()){
  const reason=nativeReason(value?.reason);
  process.stderr.write(JSON.stringify({event:'mail_native_send',provider,outcome:qualified?'sent':'unknown',dispatched:true,...(reason?{reason}:{}),...(qualified?{template_ready:value.template_ready===true}:{})})+'\n');
 }
 if(!qualified)return null;
 return {...value,proof:{source:'qq_sent_list_v1',provider_message_id:value.provider_message_id,response_message_id:value.response_message_id,folder:'sent',fresh:true}};
}
export async function sendManagedMail(raw,provider,runtime){
 const request=validateManagedSend(raw,provider);
 if(!request.message.subject.trim())throw fail('email_send_invalid_input');
 const journal=await openSendJournal(runtime.emailWorkspaceRoot,request,runtime.originalMode);
 const unknown={schema_version:1,status:'unknown',provider,recipient_digest:request.recipientDigest};
 if(journal.saved?.stage==='sent')return journal.saved.receipt;
 if(request.mode==='reconcile'&&journal.saved?.stage==='not_sent')return journal.saved.receipt;
 if(request.mode==='reconcile'&&!journal.saved&&runtime.reconcileNotSentReceipt){
  const receipt=runtime.reconcileNotSentReceipt(request);
  if(receipt&&await journal.write('not_sent',receipt))return receipt;
 }
 if(request.mode==='reconcile'||journal.saved)return unknown;
 if(typeof runtime.withSendTab!=='function')throw fail('email_send_configuration_error');
 let attempted=false, phase='open';
 const timing={started:performance.now(),path:'dom',confirmed:false};
 const outlookFolderProof=provider==='outlook'&&request.mode==='compose'&&request.message.to.length===1&&request.message.cc.length===0;
 try{return await runtime.withSendTab(async tab=>{
  phase='native_prepare';
  const ticket=await prepareNativeSend(tab,provider,request);
  if(ticket){
   timing.path='native';
   phase='native_dispatch';
   if(typeof runtime.releaseDispatch!=='function'||typeof runtime.reserveDispatch!=='function')throw fail('email_send_configuration_error');
   runtime.reserveDispatch();await runtime.releaseDispatch();
   if(!await journal.write('dispatching'))return unknown;
   attempted=true;
   phase='native_result';
   const value=await dispatchNativeSend(tab,provider,request,ticket.token);
   if(!value)throw fail('send_outcome_unknown');
   timing.confirmed=true;
   timing.native=Object.fromEntries(Object.entries(value.timings??{}).filter(([key,value])=>['request_ms','sent_verify_ms'].includes(key)&&Number.isSafeInteger(value)&&value>=0&&value<=60000));
   const result={schema_version:1,status:'sent',provider,recipient_digest:request.recipientDigest,provider_message_id:value.provider_message_id};
   if(!await journal.write('sent',result,{proof:value.proof,timings:timing.native}))throw fail('send_outcome_unknown');
   return result;
  }
  phase='open';
  await tab.runReadCode(`async page=>{await page.goto(${JSON.stringify(outlookFolderProof?'https://outlook.live.com/mail/0/sentitems':READ_PROVIDERS[provider].url)});return true}`);
  if(runtime.prepareSendPage)await runtime.prepareSendPage();
  let claimed, sentBaseline, prepared;
  phase='sent_baseline';
  if(provider==='qq_mail'){
   await tab.click(QQMAIL_SENT_FOLDER_SELECTOR);
   sentBaseline=(await tab.inspect(QQMAIL_SENT_BASELINE_EXPRESSION)).result;
  }else if(outlookFolderProof)sentBaseline=(await tab.inspect(OUTLOOK_SENT_BASELINE_EXPRESSION)).result;
  if(provider==='qq_mail'||outlookFolderProof){
   if(!Array.isArray(sentBaseline?.ids)||sentBaseline.ids.length>1000||sentBaseline.ids.some(id=>typeof id!=='string'||!id||id.length>1024))throw fail('email_send_precondition_failed');
  }
  phase='prepare_draft';
  try{prepared=await prepareManagedDraft(tab,provider,request);await uploadManagedAttachments(tab,provider,runtime.emailWorkspaceRoot,request.message.attachments,()=>{});await verifyManagedDraft(tab,provider,request);await verifyManagedAttachments(tab,provider,request.message.attachments);await tab.inspect(`()=>(${sentDOM.toString()})(${JSON.stringify(provider)},true)`);if(typeof runtime.releaseDispatch!=='function')throw fail('email_send_configuration_error');runtime.reserveDispatch();await runtime.releaseDispatch();claimed=await journal.write('dispatching');}catch(error){try{await discardManagedDraft(tab,provider)}catch{}throw error}
  if(!claimed){try{await discardManagedDraft(tab,provider)}catch{}return unknown;}
  attempted=true;
  await tab.inspect('()=>{if(globalThis.__sparkclawManagedMail)globalThis.__sparkclawManagedMail.sendAttempted=true;return {marked:true}}');
  // Evidence only: record the shape of the provider's own send request.
  await tab.runReadCode(`async page=>page.evaluate(()=>{try{return window.SparkClawMailReader?.armLearning?.({kind:'send',window_ms:120000,capture_send_template:${nativePrototypeEligible(provider,request)}})??false}catch{return false}})`).catch(()=>{});
  phase='send_click';await tab.click(MANAGED_SEND_SELECTOR);
  let proof;
  if(provider==='qq_mail'){
   phase='sent_page';await tab.waitFor('.mail-list-page');
   phase='sent_folder';await tab.click(QQMAIL_SENT_FOLDER_SELECTOR);
   phase='sent_evidence';
   const evidence=(await tab.inspect(`(${QQMAIL_SENT_VERIFICATION_EXPRESSION})(${JSON.stringify({ids:sentBaseline.ids,subject:digest(request.message.subject),emptySubject:false})})`)).result;
   proof={confirmed:evidence?.sent_evidence===true,provider_message_id:evidence?.provider_message_id};
  }else if(outlookFolderProof){
   const recipientHashes=[digest(request.message.to[0].toLowerCase()),prepared.recipientDisplayHash].filter(Boolean);
   const evidence=(await tab.inspect(`${OUTLOOK_SEND_VERIFICATION_EXPRESSION}(${JSON.stringify({ids:sentBaseline.ids,recipient_hashes:recipientHashes,subject:digest(request.message.subject),emptySubject:false})})`)).result;
   proof={confirmed:evidence?.sent_evidence===true};
  }else for(let i=0;i<12;i++){
   proof=(await tab.inspect(`async()=>{await new Promise(r=>setTimeout(r,250));return (${sentDOM.toString()})(${JSON.stringify(provider)})}`)).result;
   if(proof?.confirmed)break;
  }
  await reportLearnedRequests(tab,provider,'send');
  phase='confirm_result';if(!proof?.confirmed)throw fail('send_outcome_unknown');
  timing.confirmed=true;
  if(nativePrototypeEligible(provider,request)){
   const learned=await tab.runReadCode(`async page=>page.evaluate(async request=>{try{const r=window.SparkClawMailReader;await r?.confirmSendTemplate?.(request);return r?.sendNativeReady?.(request)??null}catch{return null}},${JSON.stringify({account_address:request.account_address,to:request.message.to,subject:request.message.subject,provider_message_id:proof.provider_message_id})})`).catch(()=>null);
   if(process.env.APP_CLI_MAIL_SEND_EVIDENCE==='1')process.stderr.write(JSON.stringify({event:'mail_send_template',provider,ready:learned?.ready===true,reason:/^[a-z_]{1,64}$/.test(learned?.reason??'')?learned.reason:'unavailable'})+'\n');
  }
  const result={schema_version:1,status:'sent',provider,recipient_digest:request.recipientDigest,...(provider==='qq_mail'&&proof.provider_message_id?{provider_message_id:proof.provider_message_id}:{})};
  await journal.write('sent',result);return result;
 });}catch(error){
  if(process.env.APP_CLI_MAIL_SEND_EVIDENCE==='1')process.stderr.write(JSON.stringify({event:'mail_send_phase_failed',provider,phase,attempted,code:/^[a-zA-Z0-9_]{1,64}$/.test(error.code??'')?error.code:'unavailable'})+'\n');
  if(attempted)throw fail('send_outcome_unknown');
  // A positive, create-only failure receipt races the same dispatch claim.
  // Retain the original failure/effect; recovery remains an explicit lookup.
  if(!journal.saved&&runtime.notSentReceipt){
   const receipt=runtime.notSentReceipt(request,error.code);
   if(receipt)try{await journal.write('not_sent',receipt)}catch{}
  }
  throw error
 }finally{
  if(process.env.APP_CLI_MAIL_SEND_EVIDENCE==='1')process.stderr.write(JSON.stringify({event:'mail_send_timing',provider,path:timing.path,attempted,confirmed:timing.confirmed,total_ms:Math.round(performance.now()-timing.started),...(timing.native??{}),...(runtime.callTimings?{calls:runtime.callTimings}:{})})+'\n');
 }
}
