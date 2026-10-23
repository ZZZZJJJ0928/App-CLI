import {validateAttachments,uploadManagedAttachments,verifyManagedAttachments} from './workspace-attachments.mjs';
import {OUTLOOK_SENT_BASELINE_EXPRESSION,OUTLOOK_SEND_VERIFICATION_EXPRESSION} from './outlook-send-proof.mjs';
import crypto from 'node:crypto';
import {QQMAIL_SENT_FOLDER_SELECTOR,QQMAIL_SENT_BASELINE_EXPRESSION,QQMAIL_SENT_VERIFICATION_EXPRESSION} from './qqmail-send-proof.mjs';
import {managedSendDOM} from './managed-send-dom.mjs';
import {nativeSendPlan,sendNativeMail} from './native-send.mjs';
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

// One page turn per read, without an in-page wait: the host's eval budget
// also covers process start and the post-eval network settle (up to 6 s
// while a freshly navigated mailbox is still loading), so waiting inside it
// turned a not-yet-hydrated identity into browser_script_timeout.
async function sendAccountHash(tab,provider){
 const evidence=await tab.inspect(`async()=>{if(!${JSON.stringify(READ_PROVIDERS[provider].origins)}.includes(location.origin))return {error:'email_provider_origin_invalid'};let observed;const reader=window.SparkClawMailReader;if(reader){if(reader.provider!==${JSON.stringify(provider)}||reader.version!=='0.2.0')return {url:location.href,account_hash:null,final:true};try{observed=reader.snapshot({interval_start:"1970-01-01T00:00:00Z",interval_end:"1970-01-01T00:00:01Z"});}catch(error){if(error.code!=='email_account_identity_unavailable')return {url:location.href,account_hash:null,final:true};}}else{observed=(${providerAccountDOM.toString()})(${JSON.stringify(provider)});}if(!observed?.account_address)return {url:location.href,account_hash:null};const value=observed.account_address.toLowerCase();return {url:location.href,account_hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('')};}`);
 if(evidence?.result?.url!==evidence?.origin||!READ_PROVIDERS[provider].origins.includes(new URL(evidence.origin).origin))throw fail('email_provider_origin_invalid');
 return evidence.result;
}
export const SEND_ACCOUNT_READS=12;
const SEND_ACCOUNT_WAIT_MS=12000;
// Each read is a separate host call (about one second each), so hydration is
// awaited between calls rather than inside one bounded evaluation.
async function awaitSendAccountHash(tab,provider){
 const deadline=Date.now()+SEND_ACCOUNT_WAIT_MS;
 for(let read=1;;read++){
  const observed=await sendAccountHash(tab,provider);
  if(observed.account_hash||observed.final||read>=SEND_ACCOUNT_READS||Date.now()>=deadline)return observed.account_hash;
 }
}
export async function verifySendAccount(tab,provider,expected){
 let accountHash=await awaitSendAccountHash(tab,provider);
 if(!accountHash&&provider==='outlook'){
  await tab.click('#O365_MainLink_MePhoto, #O365_MeFlexPane_ButtonID, [data-testid="mectrl_headerPicture"]');
  try{accountHash=await awaitSendAccountHash(tab,provider);}finally{await tab.press('Escape');}
 }
 // Account bindings use the Reader's case-insensitive provider identity. An
 // Outlook login alias in the account menu is not necessarily its mailbox.
 if(!accountHash||accountHash!==digest(expected.toLowerCase()))throw fail('email_account_identity_mismatch');
}

// Outlook's reply acts on the conversation opened by its own route. Join the
// requested item to that conversation through the Reader's startup inventory
// and require it to be the conversation's only, local, non-draft message.
export const outlookReplyRoute=target=>'https://outlook.live.com/mail/0/inbox/id/'+encodeURIComponent(target.provider_selection_id);
const OUTLOOK_REPLY_PROOF_READS=5;
async function openOutlookReplyTarget(tab,request){
 const target=request.reply_target;
 if(target.folder!=='inbox'||typeof tab.runReadCode!=='function')throw fail('email_reply_target_unverified');
 const proofRequest={account_address:request.account_address,provider_message_id:target.provider_message_id,provider_selection_id:target.provider_selection_id};
 let proof;
 for(let read=1;read<=OUTLOOK_REPLY_PROOF_READS;read++){
  proof=await tab.runReadCode(`async page=>page.evaluate(request=>{const r=window.SparkClawMailReader;if(r?.provider!=='outlook'||r.version!=='0.2.0'||typeof r.replyTarget!=='function')return null;try{return r.replyTarget(request)}catch(error){return {error:String(error?.code||'email_network_read_failed').slice(0,64)}}},${JSON.stringify(proofRequest)})`);
  if(!['inventory_unobserved','conversation_unobserved'].includes(proof?.reason))break;
 }
 if(proof?.error==='email_account_identity_mismatch')throw fail('email_account_identity_mismatch');
 if(proof?.provider!=='outlook'||proof.account_address!==request.account_address.toLowerCase()||proof.provider_message_id!==target.provider_message_id||proof.provider_selection_id!==target.provider_selection_id||proof.single!==true){
  process.stderr.write(JSON.stringify({event:'mail_reply_target_unverified',provider:'outlook',reason:/^[a-z_]{1,64}$/.test(proof?.reason??proof?.error??'')?proof.reason??proof.error:'unavailable'})+'\n');
  throw fail('email_reply_target_unverified');
 }
 return {account_address:request.account_address,folder:'inbox',provider_message_id:target.provider_message_id,provider_selection_id:target.provider_selection_id,single_message_proven:true};
}
export async function openNativeReplyTarget(tab,provider,request){
 const target=request.reply_target;
 if(provider==='outlook')return openOutlookReplyTarget(tab,request);
 // Reuse individual-message selection proofs and account checks from capture,
 // but never export/download or create a new message as a reply fallback.
 const message=await collectUnread(tab,provider,{account_address:request.account_address,folder:target.folder,pinned_message_id:target.provider_message_id,pinned_selection_id:target.provider_selection_id,capture_required:false,onSelected:async selected=>{if(selected.members?.some(member=>member.draft))throw fail('email_existing_draft')}});
 if(message.provider_message_id!==target.provider_message_id||message.provider_selection_id!==target.provider_selection_id)throw fail('email_reply_target_unverified');
 return message;
}

const CONTROL=name=>`[data-sc-mail-control="${name}"]`;
export const MANAGED_SEND_SELECTOR='[data-sc-managed-send="true"]';
function editorFailure(provider,phase,check,diagnostic,attempt){
 // Page results are untrusted. Copy only fixed enums, bounded counts and true
 // booleans; never copy arbitrary error/DOM text into executor diagnostics.
 const record={event:'mail_editor_validation_failed',provider,phase,
  check:['state_missing','provider_mismatch','body_count','root_missing','target_unlinked','open_unconfirmed','editor_not_ready'].includes(check)?check:'unavailable'};
 for(const key of ['state_present','provider_matches','ownership_checked'])if(typeof diagnostic?.[key]==='boolean')record[key]=diagnostic[key];
 for(const key of ['body_candidates','body_count','compose_roots','visible_compose_roots','compose_editables','visible_compose_editables'])if(Number.isSafeInteger(diagnostic?.[key])&&diagnostic[key]>=0&&diagnostic[key]<=1000)record[key]=diagnostic[key];
 if(Number.isSafeInteger(attempt)&&attempt>=1&&attempt<=8)record.attempt=attempt;
 try{process.stderr.write(JSON.stringify(record)+'\n');}catch{/* Diagnostics cannot replace the failed guard. */}
 return fail('email_reply_editor_unverified');
}
async function native(tab,provider,phase,expected={},attempt){
 // The CLI intentionally redacts message secrets in returned DOM text. Compare
 // browser-computed digests instead of trying to unmask or export that text.
 const r=await tab.inspect(`async()=>{const value=(${managedSendDOM.toString()})(${JSON.stringify(provider)},${JSON.stringify(phase)},${JSON.stringify(expected)});if(!value||value.error)return value;const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');const addr=v=>{const i=v.lastIndexOf('@');return v.slice(0,i)+'@'+v.slice(i+1).toLowerCase()};if(${JSON.stringify(phase)}==='readback'){return {to_count:value.to.length,cc_count:value.cc.length,to_hash:await hash(JSON.stringify(value.to.map(addr).sort())),cc_hash:await hash(JSON.stringify(value.cc.map(addr).sort())),subject_hash:await hash(value.subject??''),...(value.to_display?{recipient_display_hash:await hash(value.to_display.toLowerCase())}:{}),body_hash:await hash(value.body),body_length:value.body.length,body_diagnostic:value.body_diagnostic,send_ready:value.send_ready,linked:value.linked};}if(value.subject!==undefined){value.subject_hash=await hash(value.subject);delete value.subject;}return value;}`);
 if(r?.result?.error){
  if(r.result.error==='email_reply_editor_unverified')throw editorFailure(provider,phase,r.result.check,r.result.diagnostic,attempt);
  if(['pending_to','pending_cc','unparsed_recipient','unexpected_bcc'].includes(r.result.check))process.stderr.write(JSON.stringify({event:'mail_recipient_validation_failed',provider,phase,check:r.result.check})+'\n');
  if(r.result.error==='email_draft_fields_unverified')process.stderr.write(JSON.stringify({event:'mail_draft_validation_failed',provider,phase,fields:['editor_structure']})+'\n');
  throw fail(r.result.error);
 }
 if(!r?.result)throw fail('email_send_precondition_failed');if(r.result.action_selector)await tab.click(r.result.action_selector);return r.result;
}
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonicalAddress=value=>{const i=value.lastIndexOf('@');return value.slice(0,i)+'@'+value.slice(i+1).toLowerCase()};
const addressDigest=values=>digest(JSON.stringify(values.map(canonicalAddress).sort()));
function bodyDiagnostic(value){
 const enums={mode:['native_lines','rendered'],reason:['native_lines','no_block_lines','root_node_type','root_element','trailing_text','block_attributes','block_display','block_visibility','placeholder_attributes','line_markup'],block_display:['unobserved','block','other'],block_visibility:['unobserved','visible','hidden','collapse','other']};
 const safe={};for(const [key,allowed]of Object.entries(enums))safe[key]=allowed.includes(value?.[key])?value[key]:'unavailable';
 for(const key of ['top_nodes','top_text','top_div','top_br','top_p','top_span','top_other_element','top_other_node','attributed_divs','div_attributes','br_attributes','block_lines','empty_lines'])if(Number.isSafeInteger(value?.[key])&&value[key]>=0&&value[key]<=1000)safe[key]=value[key];
 if(Array.isArray(value?.structure?.nodes)){
  const nodes=[];
  for(const node of value.structure.nodes.slice(0,32)){
   if(!Number.isSafeInteger(node?.depth)||node.depth<0||node.depth>3||!Number.isSafeInteger(node.parent)||node.parent< -1||node.parent>=nodes.length)break;
   const item={parent:node.parent,depth:node.depth};
   const kinds={tag:['text','div','br','p','span','other'],display:['block','inline','inline-block','flex','inline-flex','grid','contents','none','other'],visibility:['visible','hidden','collapse','other'],white_space:['normal','pre','pre-wrap','pre-line','break-spaces','nowrap','other']};
   for(const [key,values]of Object.entries(kinds))item[key]=values.includes(node[key])?node[key]:'other';
   for(const key of ['style','class','dir','other'])if(typeof node[key]==='boolean')item[key]=node[key];
   if(Number.isSafeInteger(node.children)&&node.children>=0&&node.children<=1000)item.children=node.children;
   nodes.push(item);
  }
  safe.structure={nodes,truncated:value.structure.truncated===true||nodes.length<value.structure.nodes.length};
 }
 return safe;
}
export async function prepareManagedDraft(tab,provider,request){
 await verifySendAccount(tab,provider,request.account_address);
 let target;
 if(request.mode!=='compose')target=await openNativeReplyTarget(tab,provider,request);
 const expected={mode:request.mode,needs_cc:request.message.cc.length>0,provider_message_id:target?.provider_message_id,provider_selection_id:target?.provider_selection_id,single_message_proven:target?.single_message_proven===true};
 let opened=await native(tab,provider,'open',expected);
 if(opened.menu_opened)opened=await native(tab,provider,'reply_menu',expected);
 if(!opened.opened)throw editorFailure(provider,'open','open_unconfirmed');
 let editor;
 for(let attempt=0;attempt<8;attempt++){
  try{editor=await native(tab,provider,'editor',expected,attempt+1);if(editor.ready)break;}catch(e){if(!['email_reply_editor_unverified','email_recipient_editor_unverified'].includes(e.code)||attempt===7)throw e}
  await tab.inspect('async()=>{await new Promise(r=>setTimeout(r,200));return {waited:true}}');
 }
 if(!editor?.ready)throw editorFailure(provider,'editor','editor_not_ready',undefined,8);
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
 const expectedBody=request.message.body.content.replace(/\r\n?/gu,'\n');
 const checks={to:readback.to_hash===addressDigest(request.message.to),cc:readback.cc_hash===addressDigest(request.message.cc),subject:readback.subject_hash===digest(request.message.subject),body:readback.body_hash===digest(expectedBody),send_ready:readback.send_ready===true,linked:readback.linked===true};
 const fields=Object.keys(checks).filter(field=>!checks[field]);
 if(fields.length){
  try{process.stderr.write(JSON.stringify({event:'mail_draft_validation_failed',provider,fields,body_length_expected:expectedBody.length,body_length_actual:Number.isSafeInteger(readback.body_length)?readback.body_length:null,body_hash_expected:digest(expectedBody),body_hash_actual:/^[a-f0-9]{64}$/u.test(readback.body_hash??'')?readback.body_hash:null,...(!checks.body?{body_readback:bodyDiagnostic(readback.body_diagnostic)}:{})})+'\n');}catch{/* Diagnostics cannot replace strict verification. */}
  throw fail('email_draft_fields_unverified');
 }
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
// QQ v1 compose sends take the network-native path (lib/native-send.mjs);
// everything outside a provider's maintained template uses the DOM flow.
export function nativeSendFor(provider,input,release){
 if(!isManagedSend(input))return null;
 try{return nativeSendPlan(provider,validateManagedSend(input,provider),release)}catch{return null}
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
 const plan=request.mode==='compose'?nativeSendPlan(provider,request,runtime.nativeSendRelease):null;
 try{return await runtime.withSendTab(async tab=>{
  if(plan){
   phase='native';
   const {receipt}=await sendNativeMail({tab,plan,request,runtime,journal,timing,unknown});
   attempted=timing.attempted===true;
   return receipt;
  }
  phase='open';
  const outlookReply=provider==='outlook'&&request.mode!=='compose'&&request.reply_target.folder==='inbox';
  await tab.runReadCode(`async page=>{await page.goto(${JSON.stringify(outlookFolderProof?'https://outlook.live.com/mail/0/sentitems':outlookReply?outlookReplyRoute(request.reply_target):READ_PROVIDERS[provider].url)});return true}`);
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
  await tab.runReadCode(`async page=>page.evaluate(()=>{try{return window.SparkClawMailReader?.armLearning?.({kind:'send',window_ms:120000})??false}catch{return false}})`).catch(()=>{});
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
  const result={schema_version:1,status:'sent',provider,recipient_digest:request.recipientDigest,...(provider==='qq_mail'&&proof.provider_message_id?{provider_message_id:proof.provider_message_id}:{})};
  await journal.write('sent',result);return result;
 });}catch(error){
  if(process.env.APP_CLI_MAIL_SEND_EVIDENCE==='1')process.stderr.write(JSON.stringify({event:'mail_send_phase_failed',provider,phase,attempted,code:/^[a-zA-Z0-9_]{1,64}$/.test(error.code??'')?error.code:'unavailable'})+'\n');
  if(attempted||timing.attempted)throw fail('send_outcome_unknown');
  // A positive, create-only failure receipt races the same dispatch claim.
  // Retain the original failure/effect; recovery remains an explicit lookup.
  if(!journal.saved&&runtime.notSentReceipt){
   const receipt=runtime.notSentReceipt(request,error.code);
   if(receipt)try{await journal.write('not_sent',receipt)}catch{}
  }
  throw error
 }finally{
  if(process.env.APP_CLI_MAIL_SEND_EVIDENCE==='1')process.stderr.write(JSON.stringify({event:'mail_send_timing',provider,path:timing.path,attempted:attempted||timing.attempted===true,confirmed:timing.confirmed,total_ms:Math.round(performance.now()-timing.started),...(timing.native??{}),...(runtime.callTimings?{calls:runtime.callTimings}:{})})+'\n');
 }
}
