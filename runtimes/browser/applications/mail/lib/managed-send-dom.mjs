// This function is serialized into the owned provider tab. It uses only DOM
// controls/state; no private mailbox APIs, network calls or content instructions.
export function managedSendDOM(provider,phase,expected={}){
 const visible=n=>n?.isConnected&&n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0&&getComputedStyle(n).visibility!=='hidden';
 const all=(s,root=document)=>[...root.querySelectorAll(s)].filter(visible);
 const text=n=>(n?.innerText??n?.textContent??'').trim();
 const label=n=>n.getAttribute('aria-label')||n.getAttribute('data-tooltip')||text(n);
 const bodySelector=provider==='qq_mail'?'.mail-compose-page .mail-content-editor-inner[contenteditable="true"],.mail-compose-page [contenteditable="true"][aria-label="Enter content"],.mail-compose-page [contenteditable="true"][aria-label="输入正文"]':provider==='gmail'?'[role="textbox"][contenteditable="true"]':'[contenteditable="true"][aria-label="Message body"],[contenteditable="true"][aria-label="Email body"],[contenteditable="true"][aria-label="邮件正文"],[contenteditable="true"][aria-label="消息正文"]';
 const bodies=all(bodySelector);
 const controls=(root=document)=>all('button,[role="button"],[role="menuitem"],[data-a11y="button"],.xmail-ui-btn,a',root);
 const exactControl=(re,root=document)=>controls(root).filter(n=>re.test(label(n)));
 const error=code=>({error:code});
 const mark=(n,name)=>n.setAttribute('data-sc-mail-control',name);
 const action=(n,result)=>{for(const old of document.querySelectorAll('[data-sc-mail-action]'))old.removeAttribute('data-sc-mail-action');n.setAttribute('data-sc-mail-action','prepare');return {...result,action_selector:'[data-sc-mail-action="prepare"]'}};
 if(phase==='open'){
  if(bodies.length)return error('email_existing_draft');
  let buttons;
  if(expected.mode==='compose'){
   buttons=provider==='qq_mail'?all('.frame-sidebar-compose-btn[data-a11y="button"]'):provider==='gmail'?all('[role="button"][gh="cm"]'):exactControl(/^(New mail|New message|新邮件|新建邮件)$/u);
  }else{
   let root;
   if(provider==='gmail')root=all('.adn[data-legacy-message-id]').find(n=>n.getAttribute('data-legacy-message-id')===expected.provider_message_id);
   if(provider==='qq_mail')root=all('.mail-list-page-toolbar')[0];
   if(provider==='outlook')root=all('#focused')[0]||all('[role="main"]')[0];
   if(!root)return error('email_reply_target_unverified');
   buttons=exactControl(expected.mode==='reply_all'?/^(Reply all|Reply All|回复全部|全部回复|全部答复)$/u:/^(Reply|回复|答复)$/u,root);
   if(buttons.length===0&&provider==='gmail'&&expected.mode==='reply_all'){
    const more=all('button[aria-label="More message options"]',root);
    if(more.length===1){return action(more[0],{menu_opened:true});}
   }
  }
  if(buttons?.length!==1)return error('email_reply_control_unavailable');
  globalThis.__sparkclawManagedMail={provider,mode:expected.mode,target:expected.provider_message_id??'',selection:expected.provider_selection_id??'',individual:expected.individual_message_proven===true,single:expected.single_message_proven===true,evidenceKey:expected.evidence_key,sourceRoot:provider==='gmail'?all('.adn[data-legacy-message-id]').find(n=>n.getAttribute('data-legacy-message-id')===expected.provider_message_id):null};
  const st=globalThis.__sparkclawManagedMail;st.priorDrafts=[...document.querySelectorAll('input[name="draft"]')].map(n=>n.value).filter(Boolean);st.sourceNativeId=st.sourceRoot?.getAttribute('data-message-id')?.replace(/^#/u,'');return action(buttons[0],{opened:true});
 }
 if(phase==='reply_menu'){
  if(bodies.length)return error('email_existing_draft');
  const buttons=all('[role="menuitem"]').filter(n=>/^(Reply all|Reply All|回复全部|全部回复|全部答复)$/u.test(text(n)));
  if(buttons.length!==1)return error('email_reply_control_unavailable');
  globalThis.__sparkclawManagedMail={provider,mode:expected.mode,target:expected.provider_message_id,selection:expected.provider_selection_id,sourceRoot:all('.adn[data-legacy-message-id]').find(n=>n.getAttribute('data-legacy-message-id')===expected.provider_message_id)};
  const st=globalThis.__sparkclawManagedMail;st.priorDrafts=[...document.querySelectorAll('input[name="draft"]')].map(n=>n.value).filter(Boolean);st.sourceNativeId=st.sourceRoot?.getAttribute('data-message-id')?.replace(/^#/u,'');return action(buttons[0],{opened:true});
 }
 const state=globalThis.__sparkclawManagedMail;
 if(phase==='discard'){
  if(!state?.ownershipChecked||!state.root?.isConnected||state.sendAttempted)return {discarded:false};
  const current=state.root.querySelector('input[name="draft"]')?.value;
  if(provider==='gmail'&&state.ownDraftId&&state.ownDraftId!==current)return {discarded:false};
  const buttons=controls(state.root).filter(n=>/^(Discard draft|Discard|放弃|丢弃|舍弃)(?:$|[ \u202a])/u.test(label(n)));
  if(buttons.length!==1)return {discarded:false};
  state.discardDialogs=new Set(all('[role="dialog"],[role="alertdialog"]'));state.discardStarted=true;
  return action(buttons[0],{discard_started:true});
 }
 if(phase==='discard_confirm'){
  if(provider!=='outlook'||!state?.discardStarted||!state.ownershipChecked||state.sendAttempted||!visible(state.root))return {confirmed:false};
  const dialogs=all('[role="dialog"],[role="alertdialog"]').filter(n=>!state.discardDialogs?.has(n));
  if(dialogs.length!==1)return {confirmed:false};
  const buttons=all('button',dialogs[0]);const ok=buttons.filter(n=>text(n)==='确定'),cancel=buttons.filter(n=>text(n)==='取消');
  if(buttons.length!==2||ok.length!==1||cancel.length!==1)return {confirmed:false};
  return action(ok[0],{confirmed:true});
 }
 if(phase==='discard_status')return {discarded:!!state?.discardStarted&&!!state.ownershipChecked&&!visible(state.root)};
 if(phase==='edit_subject'){
  if(provider!=='gmail'||!state?.root?.isConnected)return error('email_draft_fields_unverified');
  const buttons=all('.HQ [role="button"]',state.root);
  if(buttons.length!==1)return error('email_draft_fields_unverified');
  return action(buttons[0],{menu_opened:true});
 }
 if(phase==='subject_menu'){
  const buttons=all('[role="menuitem"]').filter(n=>/^(Edit subject|修改主题|编辑主题)$/u.test(text(n)));
  if(provider!=='gmail'||buttons.length!==1)return error('email_draft_fields_unverified');
  return action(buttons[0],{opened:true});
 }
 if(phase==='editor'){
  if(!state||state.provider!==provider||bodies.length!==1)return error('email_reply_editor_unverified');
  const body=bodies[0];let root=provider==='qq_mail'?body.closest('.mail-compose-page'):provider==='gmail'?body.closest('form')||body.closest('.M9')||body.closest('.gA'):body.closest('[data-app-section="MailCompose"]');
  // Find the smallest actual ancestor with one body and a native Send control.
  if(!root){for(let n=body.parentElement;n&&n!==document.body;n=n.parentElement){if(all(bodySelector,n).length!==1)break;if(exactControl(/^(Send|发送)(?:$|[ \u202a(（])/u,n).length===1){root=n;break}}}
  if(!root)return error('email_reply_editor_unverified');
  if(!state.ownershipChecked){
   if(provider==='gmail'){const id=root.querySelector('input[name="draft"]')?.value;if(id&&state.priorDrafts?.includes(id))return error('email_existing_draft');state.ownDraftId=id??null;}
   if(provider==='qq_mail'){const key=Object.keys(root).find(k=>/^__react(?:Fiber|InternalInstance)\$/u.test(k));const props=key?root[key]?.return?.memoizedProps?.value:null;if(!props||props.isResumeMail===true||props.isEdited===true)return error('email_existing_draft');state.ownDraftId=props.draftMailId??null;}
   state.ownershipChecked=true;
  }
  state.root=root;state.body=body;

  if(state.mode!=='compose'){
   let linked=false;
   if(provider==='gmail'){
    const source=state.sourceRoot;
    linked=!!source?.isConnected&&(source.contains(body)||source.parentElement?.contains(body));
    // Native hidden reply marker provides an independent target check when present.
    const refs=[...root.querySelectorAll('input[type="hidden"][name="rm"]')];
    linked=refs.length===1&&!!state.sourceNativeId&&refs[0].value.replace(/^#/u,'')===state.sourceNativeId;
   }else if(provider==='qq_mail'){
    for(let n=root;n&&!linked;n=n.parentElement){for(const k of Object.keys(n).filter(k=>/^__react(?:Fiber|InternalInstance)\$/u.test(k))){const nativeProps=n[k]?.return?.memoizedProps;const props=nativeProps?.value??nativeProps;for(const name of ['replyMail','originMail','sourceMail','referenceMail']){const m=props?.[name];if(m&&String(m.id)===state.target)linked=true}if(props?.replyMailId===state.target||props?.originMailId===state.target)linked=true}if(n===document.body)break}
   }else{
    const source=all('[role="option"][data-convid][aria-selected="true"]');
    const target=decodeURIComponent(location.pathname.split('/id/')[1]??'');
    const records=globalThis[state.evidenceKey]?.records;const proved=records?.filter(r=>r.provider_selection_id===state.selection&&(state.single&&r.provider_message_id===state.target||state.individual&&r.inventory_complete&&r.members?.some(m=>m.provider_message_id===state.target&&!m.draft)));const item=document.getElementById(state.target);
    linked=proved?.length===1&&source.length===1&&source[0].getAttribute('data-convid')===state.selection&&target===state.selection&&!!body.closest('#focused')&&(!state.individual||!!item&&all('[role="checkbox"][aria-checked="true"]',item).length===1);
   }
   if(!linked)return error('email_reply_editor_unverified');
  }
  state.root=root;state.body=body;mark(body,'body');
  const subject=all('input[name="subjectbox"],input[aria-label="Subject"],input[aria-label="主题"],input[aria-label="Add a subject"],input[aria-label="添加主题"]',root);
  if(subject.length>1||state.mode==='compose'&&subject.length!==1)return error('email_draft_fields_unverified');
  if(subject[0])mark(subject[0],'subject');
  let to=all('[name="to"] input[role="combobox"],input[name="to"],textarea[name="to"],input[aria-label="To"],input[aria-label="收件人"],[contenteditable="true"][aria-label="To"],[contenteditable="true"][aria-label="收件人"],[role="combobox"][aria-label="To"],[role="combobox"][aria-label="收件人"]',root);
  let cc=all('[name="cc"] input[role="combobox"],input[name="cc"],textarea[name="cc"],input[aria-label="Cc"],input[aria-label="抄送"],[contenteditable="true"][aria-label="Cc"],[contenteditable="true"][aria-label="抄送"]',root);
  if(provider==='qq_mail'){
   const field=name=>all('.receiver-editor-wrap',root).filter(n=>(name==='to'?/^(To|收件人)$/u:/^(Cc|抄送)$/u).test(text(n.querySelector('.name-text')))).flatMap(n=>all('input.cmp-account-input',n));
   to=field('to');cc=field('cc');
   if(to.length!==1){const toggle=all('.receiver-btns .xmail-ui-btn',root).filter(n=>/^(Cc|抄送)$/u.test(text(n)));if(toggle.length===1)return action(toggle[0],{retry:true});}
  }
  if(to.length!==1){if(provider==='qq_mail'){const wraps=all('.receiver-editor-wrap',root);if(wraps.length===1){return action(wraps[0],{retry:true})}}if(provider==='gmail'){const collapsed=all('.aoD.hl',root);if(collapsed.length===1){return action(collapsed[0],{retry:true})}}const recipients=exactControl(/^(Recipients|收件人|To|To recipients|更改收件人)$/u,root);if(recipients.length===1){return action(recipients[0],{retry:true})}return error('email_recipient_editor_unverified')}
  mark(to[0],'to');if(cc.length===1)mark(cc[0],'cc');
  if(expected.needs_cc&&cc.length!==1){const toggle=all('*',root).filter(n=>!n.children.length&&/^(Cc|抄送)$/u.test(text(n)));if(toggle.length!==1)return error('email_cc_unavailable');return action(toggle[0],{retry:true})}
  const send=provider==='qq_mail'?all('.mail-compose-header .xmail-ui-btn',root).filter(n=>/^(Send|发送)$/u.test(text(n))):exactControl(/^(Send|发送)(?:$|[ \u202a(（])/u,root);
  if(send.length!==1)return error('email_send_control_unverified');
  send[0].setAttribute('data-sc-managed-send','true');state.send=send[0];
  return {ready:true,has_subject:subject.length===1,has_cc:cc.length===1,subject:subject[0]?.value??root.querySelector('input[type="hidden"][name="subject"]')?.value};
 }
 if(phase==='readback'){
  if(!state?.root?.isConnected||!state.body?.isConnected||!state.send?.isConnected)return error('email_draft_fields_unverified');
  const addresses=field=>{
   if(provider==='qq_mail'){const host=state.root;const key=Object.keys(host).find(k=>/^__react(?:Fiber|InternalInstance)\$/u.test(k));const current=key?host[key]?.return?.memoizedProps?.value:null;if(current&&Array.isArray(current[field])){const input=host.querySelector(`[data-sc-mail-control="${field}"]`);return {values:current[field].map(n=>n.email??''),pending:input?.value??''}}}

   const gmailBox=provider==='gmail'?state.root.querySelector(`[name="${field}"]`):null;
   const input=state.root.querySelector(`[data-sc-mail-control="${field}"]`)||gmailBox?.querySelector('input[role="combobox"],textarea');if(!input&&!gmailBox)return {values:[],pending:''};
   const box=gmailBox||(provider==='qq_mail'?input.closest('.receiver-editor'):provider==='gmail'?input.closest('tr')||input.parentElement:input);
   const chipSelector=provider==='qq_mail'?'.xmail-cmp-account':provider==='gmail'?(box.querySelector('[role="option"][data-hovercard-id]')?'[role="option"][data-hovercard-id]':'[email]'):'[draggable="true"][aria-label]';const chips=[...box.querySelectorAll(chipSelector)];
   const values=chips.map(n=>n.getAttribute('email')||n.getAttribute('data-hovercard-id')||n.getAttribute('data-email')||n.getAttribute('data-address')||n.getAttribute('title')||n.getAttribute('aria-label')||text(n));
   const parsed=values.map(v=>String(v).match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u)?.[0]??'');
   const copy=input?.cloneNode(true);copy?.querySelectorAll('[draggable="true"][aria-label]').forEach(n=>n.remove());
   return {values:parsed,pending:input?.value??text(copy).replace(/[\u200b\ufeff]/gu,'')};
  };
  if(provider==='qq_mail'){const key=Object.keys(state.root).find(k=>/^__react(?:Fiber|InternalInstance)\$/u.test(k));const props=key?state.root[key]?.return?.memoizedProps?.value:null;if(!props||['bcc','scc'].some(k=>!Array.isArray(props[k])||props[k].length)||state.mode!=='compose'&&props.replyMailId!==state.target)return error('email_draft_fields_unverified');}
  if(provider==='gmail'&&state.mode!=='compose'){const refs=[...state.root.querySelectorAll('input[name="rm"]')];if(refs.length!==1||!state.sourceNativeId||refs[0].value.replace(/^#/u,'')!==state.sourceNativeId)return error('email_reply_editor_unverified');}
  const to=addresses('to'),cc=addresses('cc'),bcc=all('input[name="bcc"],textarea[name="bcc"],[aria-label="Bcc"],[aria-label="密送"]',state.root);
  if(to.pending.trim()||cc.pending.trim()||[...to.values,...cc.values].some(v=>!v)||bcc.some(n=>(n.value||text(n)).trim()))return error('email_recipient_verification_failed');
  const subject=state.root.querySelector('[data-sc-mail-control="subject"]')||state.root.querySelector('input[type="hidden"][name="subject"]');
  const body=state.body.innerText??state.body.textContent;
  return {to:to.values,cc:cc.values,subject:subject?.value??null,body:body.replace(/\r\n?/gu,'\n'),send_ready:visible(state.send)&&!state.send.disabled&&state.send.getAttribute('aria-disabled')!=='true',linked:state.mode==='compose'||!!state.target};
 }
 return error('email_send_precondition_failed');
}
