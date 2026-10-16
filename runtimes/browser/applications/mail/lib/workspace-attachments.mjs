import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ATTACHMENT_COUNT = 5;
export const ATTACHMENT_MENU_WAIT_MS = 15000;
export const ATTACHMENT_BYTES = 10 << 20;
const fail = code => Object.assign(new Error(code), {code});
const invalid = () => fail('email_attachment_invalid');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function validateAttachments(value, mode) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ATTACHMENT_COUNT) throw invalid();
  let total = 0;
  const paths = new Set();
  return value.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'name,path,sha256,size_bytes' ||
        typeof item.name !== 'string' || !item.name || Buffer.byteLength(item.name) > 255 ||
        /[\\/:\x00-\x1f\x7f]/u.test(item.name) || item.name.startsWith('.') ||
        (item.path && paths.has(item.path)) || !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 0 ||
        !/^sha256:[a-f0-9]{64}$/u.test(item.sha256) || typeof item.path !== 'string') throw invalid();
    const components = item.path.split('/');
    if (!(mode === 'reconcile' && item.path === '') &&
        (components.length !== 3 || !/^\.sparkclaw-mail-send-[a-f0-9]{32}$/u.test(components[0]) ||
        !/^[a-f0-9]{2}$/u.test(components[1]) || components[2] !== item.name)) throw invalid();
    total += item.size_bytes;
    if (total > ATTACHMENT_BYTES) throw fail('email_attachment_limit');
    if (item.path) paths.add(item.path);
    return {...item};
  });
}

export function attachmentMessageFingerprint(message) {
  if (!message.attachments?.length) {
    const {attachments, ...legacy} = message;
    return legacy;
  }
  return {...message, attachments: message.attachments.map(({name, size_bytes, sha256}) => ({name, size_bytes, sha256}))};
}

// The Gateway publishes an owner-private, frozen copy only after validating
// the user's workspace reference. Never let an application argument select an
// arbitrary host file, even when the browser and Gateway share the workspace.
export async function verifyWorkspaceAttachments(workspace, values) {
  const attachments = validateAttachments(values, 'compose');
  if (!attachments.length) return [];
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) ||
      await fs.realpath(workspace) !== path.resolve(workspace)) throw invalid();
  const verified = [];
  for (const item of attachments) {
    let directory = workspace;
    for (const segment of item.path.split('/').slice(0, -1)) {
      directory = path.join(directory, segment);
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() ||
          (info.mode & 0o077) || await fs.realpath(directory) !== directory) throw invalid();
    }
    const filename = path.join(directory, item.name);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) ||
          before.size !== item.size_bytes || before.nlink !== 1) throw invalid();
      const bytes = Buffer.alloc(item.size_bytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const next = await handle.read(bytes, count, bytes.length - count, count);
        if (!next.bytesRead) break;
        count += next.bytesRead;
      }
      const after = await handle.stat(), current = await fs.lstat(filename);
      if (count !== item.size_bytes || 'sha256:' + digest(bytes.subarray(0, count)) !== item.sha256 ||
          before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink() ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          await fs.realpath(filename) !== filename) throw fail('email_attachment_changed');
      verified.push({name:item.name, bytes:bytes.subarray(0,count)});
    } finally { await handle.close(); }
  }
  return verified;
}

// Serialized into the owned composer. It never reads arbitrary page-selected
// files; native File objects must match the already confirmed manifest.
export function attachmentDOM(provider, phase, expected) {
  const state = globalThis.__sparkclawManagedMail;
  const visible = node => node?.isConnected && node.getBoundingClientRect().width > 0 &&
    node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden';
  const menuVisible = node => {
    if(!visible(node)||getComputedStyle(node).visibility!=='visible')return false;
    let depth=0;
    for(let parent=node;parent;parent=parent.parentElement){
      const style=getComputedStyle(parent);
      if(++depth>32||parent.hidden||parent.inert||parent.getAttribute('aria-hidden')==='true'||style.display==='none'||Number(style.opacity)<=0)return false;
    }
    // Unlike opacity/display, visibility and pointer-events may be overridden
    // by descendants. Use the target's computed values and actual hit target.
    return true;
  };
  if (!state?.ownershipChecked || state.provider !== provider || !state.root?.isConnected ||
      !state.body?.isConnected || !state.root.contains(state.body) || state.sendAttempted) return {error:'email_draft_fields_unverified'};
  // Recognize attachment-specific rows only. An unrelated title or aria-label
  // matching the filename is never proof that the provider accepted a file.
  const rowSelector = provider === 'gmail' ? '.aQH .dL' :
    provider === 'outlook' ? '[data-attachment-id]' : '.attachment-item,.attach-item';
  const visibleWithinComposer = node => {
    if(!node?.isConnected||!state.root.contains(node))return false;
    for(let current=node;current;current=current.parentElement){
      const style=getComputedStyle(current),rect=current.getBoundingClientRect();
      if(current.hidden||current.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number.parseFloat(style.opacity||'1')<=0||style.display!=='contents'&&(rect.width<=0||rect.height<=0))return false;
      if(current===state.root)return true;
    }
    return false;
  };
  const qqHiddenMirror = node => node.closest('.draft-body-attaches-float-bar-wrap,.mail-compose-attaches-float-bar') && !visibleWithinComposer(node);
  // Count every card before asserting its canonical location and success.
  // Only the known mirror with a proved hidden ancestor is excluded.
  const qqCards = provider === 'qq_mail' ? [...state.root.querySelectorAll('.mail-compose-attach-card')].filter(node=>!qqHiddenMirror(node)) : [];
  // Current Outlook cards have no data-attachment-id. Count every canonical
  // attachment container before proving its visible completed representation.
  const outlookCards = provider === 'outlook' ? [...state.root.querySelectorAll('.av-container')] : [];
  const rows = [...state.root.querySelectorAll(rowSelector)].filter(node=>visible(node)&&!(provider==='qq_mail'&&qqHiddenMirror(node))).concat(qqCards,outlookCards);
  const label = node => node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || node.textContent.trim();
  const enabled = node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const sameOutlookComposer = () => {
    const bodies = [...document.querySelectorAll('[contenteditable="true"][aria-label="Message body"],[contenteditable="true"][aria-label="Email body"],[contenteditable="true"][aria-label="邮件正文"],[contenteditable="true"][aria-label="消息正文"]')].filter(visible);
    return globalThis.__sparkclawManagedMail === state && state.ownershipChecked && !state.sendAttempted &&
      state.root.isConnected && state.body.isConnected && state.send?.isConnected &&
      state.root.contains(state.body) && state.root.contains(state.send) && bodies.length === 1 && bodies[0] === state.body;
  };
  if (phase === 'diagnostic') {
    const attrs = node => ({tag:node.tagName.toLowerCase(),classes:[...node.classList].filter(v=>/^[a-zA-Z0-9_-]{1,64}$/u.test(v)).slice(0,8),
      role:['button','menuitem','progressbar','alert'].includes(node.getAttribute('role'))?node.getAttribute('role'):null,
      visible:!!visible(node),disabled:node.disabled===true||node.getAttribute('aria-disabled')==='true',
      attachment_id:node.hasAttribute('data-attachment-id'),expected_name:expected.some(item=>[node.getAttribute('title'),node.getAttribute('aria-label'),node.textContent?.trim()].includes(item.name)),
      remove:/^(Remove attachment|Remove|Delete attachment|Delete|移除附件|删除附件|移除|删除)(?:$|[ :：])/u.test(label(node))});
    const named = [...state.root.querySelectorAll('[title],[aria-label],span,div')].slice(0,4096)
      .filter(n=>n.children.length<3&&expected.some(item=>[n.getAttribute('title'),n.getAttribute('aria-label'),n.textContent?.trim()].includes(item.name))).slice(0,5);
    const name_contexts = named.map(n=>{const ancestors=[];for(let p=n,i=0;p&&p!==state.root&&i<4;p=p.parentElement,i++)ancestors.push({node:attrs(p),children:[...p.children].slice(0,8).map(attrs)});return ancestors;});
    const shared_context=state.attachmentShared?{valid:state.attachmentContextValid?.()===true,
      expanded:state.attachmentButton?.getAttribute('aria-expanded')==='true',input_activated:!!state.attachmentActivatedInput,
      stage:state.attachmentStage||'prepared',local_action_bound:!!state.attachmentMenuAction,native_action_seen:state.attachmentNativeActionSeen===true,native_action_trusted:state.attachmentNativeActionTrusted===true,
      menus:[...document.querySelectorAll('[role="menu"]')].filter(n=>visible(n)&&!state.attachmentPriorMenus.has(n)).slice(0,3)
        .map(n=>({node:attrs(n),actions:[...n.querySelectorAll('[role="menuitem"],button')].slice(0,12).map(a=>({...attrs(a),
          local_file:/^(Browse this computer|Browse computer|浏览此计算机|浏览这台计算机|Upload from this device|从此设备上传)$/u.test(label(a))}))}))}:null;
    return {owned:true,provider,name_contexts,shared_context,body_count:provider==='outlook'?(sameOutlookComposer()?1:0):state.root.querySelectorAll('[contenteditable="true"]').length,
      known_rows:rows.length,inputs:[...state.root.querySelectorAll('input[type="file"]')].slice(0,8).map(n=>({disabled:n.disabled,directory:n.webkitdirectory,multiple:n.multiple,accept:n.accept===''?'any':n.accept==='image/*'?'image':'restricted'})),
      attachment_nodes:[...state.root.querySelectorAll('[class*="attach"],[class*="Attach"],[data-attachment-id]')].slice(0,24).map(attrs),
      controls:[...state.root.querySelectorAll('button,[role="button"],[data-a11y="button"],a')].slice(0,32).map(attrs)};
  }
  if (state.attachmentShared && phase !== 'prepare' && !state.attachmentContextValid?.()) return {error:'email_attachment_control_unavailable'};
  if (phase === 'chooser_menu') {
    if (!state.attachmentShared || !state.attachmentContextValid()) return {error:'email_attachment_control_unavailable'};
    if(state.attachmentButton.getAttribute('aria-expanded') !== 'true'){state.attachmentMenuCandidate=null;return {pending:true};}
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(n=>menuVisible(n)&&!state.attachmentPriorMenus.has(n));
    if (menus.length === 0) {state.attachmentMenuCandidate=null;return {pending:true};}
    if (menus.length !== 1) return {error:'email_attachment_control_unavailable'};
    const actions = [...menus[0].querySelectorAll('[role="menuitem"],button')].filter(n=>menuVisible(n)&&/^(Browse this computer|Browse computer|浏览此计算机|浏览这台计算机|Upload from this device|从此设备上传)$/u.test(label(n)));
    if (actions.length === 0) {state.attachmentMenuCandidate=null;return {pending:true};}
    if (actions.length !== 1) return {error:'email_attachment_control_unavailable'};
    // Outlook pre-renders a Callout that is initially non-interactive. Never
    // mark/listen until its unique owned menu and action are observable and stable.
    // Each poll re-proves the unique owned context, menu, action and hit target.
    const action=actions[0],menu=menus[0],rect=action.getBoundingClientRect();
    const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
    if(!enabled(action)||getComputedStyle(action).pointerEvents==='none'||rect.x<0||rect.y<0||rect.right>innerWidth||rect.bottom>innerHeight||
       !hit||hit!==action&&!action.contains(hit)) {state.attachmentMenuCandidate=null;return {pending:true};}
    const box=[rect.x,rect.y,rect.width,rect.height],candidate=state.attachmentMenuCandidate;
    if(!candidate||candidate.menu!==menu||candidate.action!==action||box.some((v,i)=>Math.abs(v-candidate.box[i])>0.5)){
      state.attachmentMenuCandidate={menu,action,box,since:Date.now()};return {pending:true};
    }
    if(Date.now()-candidate.since<150)return {pending:true};
    // No click has occurred yet. A later replacement is intentionally not
    // rebound/retried: the original marked node and listener remain pinned.
    state.attachmentMenu = menu; state.attachmentMenuAction = action;
    actions[0].setAttribute('data-sc-mail-local-file-action','true');
    // Bind only the file-input activation nested in this exact native menu click.
    // A different chooser event, including one from a global decoy, is insufficient.
    const activated = event => {
      if (event.target === actions[0] || actions[0].contains(event.target)) {
        state.attachmentNativeActionSeen=true;state.attachmentNativeActionTrusted=event.isTrusted;
        const activeMenus=[...document.querySelectorAll('[role="menu"]')].filter(n=>menuVisible(n)&&!state.attachmentPriorMenus.has(n));
        if (!state.attachmentContextValid() || !event.isTrusted || !menuVisible(menu) || !menuVisible(action) || !menu.contains(action) ||
            state.attachmentMenu!==menu || state.attachmentMenuAction!==action || activeMenus.length!==1 || activeMenus[0]!==menu) return;
        state.attachmentNativeActivation = true;
        setTimeout(()=>{state.attachmentNativeActivation=false;},0);
      } else if (state.attachmentNativeActivation && event.target instanceof HTMLInputElement && event.target.type === 'file') {
        if (state.attachmentActivatedInput) state.attachmentActivationAmbiguous = true;
        else state.attachmentActivatedInput = event.target;
      }
    };
    document.addEventListener('click',activated,true);
    state.attachmentActivationCleanup = () => document.removeEventListener('click',activated,true);
    return {selector:'[data-sc-mail-local-file-action="true"]'};
  }
  if (phase === 'prepare') {
    if (state.attachmentPrepared) return {error:'email_attachment_invalid'};
    if (rows.length) return {error:'email_existing_attachments'};
    const inputs = [...state.root.querySelectorAll('input[type="file"]')].filter(node => !node.disabled && !node.webkitdirectory);
    if (inputs.length > 1) return {error:'email_attachment_control_unavailable'};
    let selector, chooser = false;
    if (inputs.length === 1) {
      inputs[0].setAttribute('data-sc-mail-attachment-input', 'true');
      state.attachmentInput = inputs[0];
      selector = '[data-sc-mail-attachment-input="true"]';
    } else {
      const attach = [...state.root.querySelectorAll('button,[role="button"],a')].filter(node => visible(node) &&
        /^(Attach files|Attach file|Add attachment|附件|添加附件|添加文件|附加文件|附加)(?:$|\s*\()/u.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || node.textContent.trim()));
      if (attach.length === 0 && provider === 'outlook' && sameOutlookComposer()) {
        // Current Outlook uses a shared Ribbon instead of nesting its chooser
        // in MailCompose. Prove its active composer and native event association.
        state.body.focus();
        if (document.activeElement !== state.body) return {error:'email_attachment_control_unavailable'};
        const ribbon = [...document.querySelectorAll('button[data-automation-type="RibbonFlyoutAnchor"][aria-haspopup="true"]')]
          .filter(n=>enabled(n)&&n.closest('[data-automation-type="RibbonBottomBarContainer"]')&&/^(Attach files|Attach file|附加文件)$/u.test(label(n)));
        if (ribbon.length !== 1) return {error:'email_attachment_control_unavailable'};
        attach.push(ribbon[0]); state.attachmentShared = true;
        const root=state.root,body=state.body,send=state.send,button=ribbon[0],ribbonRoot=button.closest('[data-automation-type="RibbonBottomBarContainer"]');
        state.attachmentContextValid=()=>sameOutlookComposer()&&state.root===root&&state.body===body&&state.send===send&&
          button.isConnected&&button.closest('[data-automation-type="RibbonBottomBarContainer"]')===ribbonRoot&&enabled(button);
        state.attachmentPriorMenus=new Set([...document.querySelectorAll('[role="menu"]')].filter(menuVisible));
        state.attachmentPriorInputs=new Map([...document.querySelectorAll('input[type="file"][data-testid="local-computer-filein"]')].map(n=>[n,n.parentElement]));
      }
      if (attach.length !== 1) return {error:'email_attachment_control_unavailable'};
      attach[0].setAttribute('data-sc-mail-attachment-chooser', 'true');
      state.attachmentButton = attach[0];
      selector = '[data-sc-mail-attachment-chooser="true"]'; chooser = true;
    }
    state.attachmentPrepared = true;
    state.attachmentProof = null;
    state.attachmentVerifiedManifest = null;
    const changed = event => {
      if (event.target !== state.attachmentInput) return;
      document.removeEventListener('change', changed, true);
      const files = [...event.target.files];
      state.attachmentProof = Promise.all(files.map(async file => ({name:file.name, size_bytes:file.size,
        sha256:'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), value=>value.toString(16).padStart(2,'0')).join('')}))).then(actual=>{state.attachmentVerifiedManifest=actual;return actual;});
    };
    document.addEventListener('change', changed, true);
    state.attachmentInputValid = () => {
      const input=state.attachmentInput;
      if(!input?.isConnected||input.ownerDocument!==document||input.type!=='file'||input.disabled||input.webkitdirectory)return false;
      if(!state.attachmentShared)return state.root.contains(input);
      return state.attachmentContextValid()&&state.attachmentActivatedInput===input&&!state.attachmentActivationAmbiguous&&
        state.attachmentPriorInputs.has(input)&&state.attachmentPriorInputs.get(input)===input.parentElement&&input.accept==='';
    };
    state.attachmentCleanup = () => {document.removeEventListener('change', changed, true);state.attachmentActivationCleanup?.();};
    return {selector, chooser, shared:state.attachmentShared===true};
  }
  if (phase === 'ready') {
    if(state.attachmentShared&&!state.attachmentInputValid?.())return {error:'email_attachment_control_unavailable'};
    const root = state.root;
    if (!state.send?.isConnected || !visible(state.send) || state.send.disabled || state.send.getAttribute('aria-disabled') === 'true') return {ready:false};
    const pending = [...root.querySelectorAll('[role="progressbar"],[aria-busy="true"],.attachment-uploading,.uploading,input[type="file"][aria-invalid="true"]')].some(visible);
    if (pending) return {ready:false};
    const emptyOutlookAnnouncement = node => provider==='outlook'&&node.matches('div.screenReaderOnly[role="alert"]')&&
      !node.matches('.attachment-error,.upload-error')&&!node.hasAttribute('aria-labelledby')&&!node.hasAttribute('aria-describedby')&&node.childNodes.length===0&&!node.getAttribute('aria-label')&&!node.getAttribute('title');
    if ([...root.querySelectorAll('[role="alert"],.attachment-error,.upload-error')].some(node=>visible(node)&&!emptyOutlookAnnouncement(node))) return {error:'email_attachment_upload_failed'};
    if (rows.length !== expected.length) return {ready:false};
    const remaining = [...expected];
    for (const row of rows) {
      if(provider==='outlook'&&outlookCards.includes(row)){
        if(!visibleWithinComposer(row)||row.children.length!==1||!state.attachmentInputValid?.()||!state.root.contains(state.send)||
          JSON.stringify(state.attachmentVerifiedManifest)!==JSON.stringify(expected.map(({name,size_bytes,sha256})=>({name,size_bytes,sha256}))))return {ready:false};
        const card=row.children[0];
        if(!card.matches('div[aria-label]')||!visibleWithinComposer(card)||card.getAttribute('aria-disabled')==='true')return {ready:false};
        const titles=[...card.querySelectorAll('[title]')].filter(visibleWithinComposer);
        const names=titles.filter(node=>remaining.some(item=>node.getAttribute('title')===item.name&&node.textContent.trim()===item.name));
        if(names.length!==1)return {ready:false};
        const index=remaining.findIndex(item=>item.name===names[0].getAttribute('title')),item=remaining[index];
        const sizes=titles.filter(node=>node!==names[0]&&new RegExp('^'+item.size_bytes+' (?:字节|bytes?)$','u').test(node.getAttribute('title'))&&node.textContent.trim()===node.getAttribute('title'));
        if(sizes.length!==1||sizes[0].parentElement!==names[0].parentElement)return {ready:false};
        const size=sizes[0].getAttribute('title'),summary=card.getAttribute('aria-label').trim();
        if(summary!==item.name+' 打开 '+size&&summary!==item.name+' Open '+size)return {ready:false};
        const controls=[...card.querySelectorAll('button,[role="button"]')];
        const more=controls.filter(node=>enabled(node)&&visibleWithinComposer(node)&&/^(More actions|更多操作)$/u.test(label(node)));
        if(controls.length!==1||more.length!==1)return {ready:false};
        remaining.splice(index,1);continue;
      }
      if(provider==='qq_mail'&&qqCards.includes(row)){
        const wrap=row.closest('.mail-compose-attaches-wrap');
        if(!visibleWithinComposer(row)||!row.matches('.mail-compose-attaches-wrap .mail-compose-attaches .attach-cards > .mail-compose-attach-card')||!row.classList.contains('attach-card-success')||
          row.matches('.attach-card-uploading,.attach-card-error,.attach-card-failed')||
          !state.attachmentInputValid?.()||state.attachmentInput.closest('.mail-compose-attaches-wrap')!==wrap||
          !state.root.contains(state.send)||JSON.stringify(state.attachmentVerifiedManifest)!==JSON.stringify(expected.map(({name,size_bytes,sha256})=>({name,size_bytes,sha256}))))return {ready:false};
        const content=[...row.querySelectorAll(':scope > .attach-card-content')];
        const info=content.length===1?[...content[0].querySelectorAll(':scope > .attach-file-info')]:[];
        const names=info.length===1?[...info[0].querySelectorAll(':scope > .file-name-wrap')]:[];
        if(names.length!==1||!visibleWithinComposer(names[0]))return {ready:false};
        const index=remaining.findIndex(item=>item.name===names[0].textContent.trim());
        if(index<0)return {ready:false};
        remaining.splice(index,1);continue;
      }
      const names = [...row.querySelectorAll('.vI,.vJ,.vK,[data-attachment-name],[title],[aria-label]')]
        .filter(visible).flatMap(node => [node.getAttribute('data-attachment-name'),node.getAttribute('title'),node.getAttribute('aria-label'),node.textContent?.trim()].filter(Boolean));
      const index = remaining.findIndex(item => names.includes(item.name));
      const remove = [...row.querySelectorAll('button,[role="button"],a')].some(node => visible(node) &&
        !node.disabled && node.getAttribute('aria-disabled') !== 'true' &&
        /^(Remove attachment|Remove|Delete attachment|Delete|移除附件|删除附件|移除|删除)(?:$|[ :：])/u.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || node.textContent?.trim()));
      if (index < 0 || !remove) return {ready:false};
      remaining.splice(index, 1);
    }
    return {ready:remaining.length === 0, count:rows.length};
  }
  return {error:'email_attachment_invalid'};
}

// Use a bounded byte channel, never a pathname handoff. Closing a verified file
// descriptor and later asking the browser driver to reopen its path permits a
// symlink substitution before upload. These buffers are the approved snapshot.
export async function verifyManagedAttachments(tab, provider, attachments) {
  if (!attachments?.length) return;
  const result=(await tab.inspect(`async()=>{
    const expected=${JSON.stringify(attachments)};
    const dom=${attachmentDOM.toString()};
    const result=dom(${JSON.stringify(provider)},'ready',expected);
    if(!result.ready)return result;
    const state=globalThis.__sparkclawManagedMail,input=state.attachmentInput;
    if(input?.isConnected){
      if(!state.attachmentInputValid?.())return {error:'email_attachment_control_unavailable'};
      const files=[...input.files];
      // Providers may clear their file input after a completed upload. If it
      // still contains files, do not accept a replacement with the same label.
      if(files.length){
        const actual=await Promise.all(files.map(async file=>({name:file.name,size_bytes:file.size,
          sha256:'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')})));
        const manifest=expected.map(({name,size_bytes,sha256})=>({name,size_bytes,sha256}));
        if(JSON.stringify(actual)!==JSON.stringify(manifest))return {error:'email_attachment_changed'};
      }
    }
    return dom(${JSON.stringify(provider)},'ready',expected);
  }`))?.result;
  if(result?.ready!==true||result.count!==attachments.length)throw fail(result?.error||'email_attachment_upload_unverified');
}

export async function uploadManagedAttachments(tab, provider, workspace, attachments, beforeEffect) {
  if (!attachments?.length) return;
  const run = code => tab.runReadCode('/* app-cli:awaited-code:v1 */\n' + code);
  const files = await verifyWorkspaceAttachments(workspace, attachments);
  const expected = attachments.map(({name,size_bytes,sha256})=>({name,size_bytes,sha256}));
  if (typeof tab.setAttachmentSecrets !== 'function' || !Number.isSafeInteger(tab.attachmentSecretSlots) || tab.attachmentSecretSlots < 1) throw fail('email_send_configuration_error');
  const token = crypto.randomUUID();
  const diagnostic = async phase => {
    if(process.env.APP_CLI_MAIL_SEND_EVIDENCE!=='1')return;
    try {
      const result=(await tab.inspect(`()=>(${attachmentDOM.toString()})(${JSON.stringify(provider)},'diagnostic',${JSON.stringify(expected)})`))?.result;
      if(result?.owned===true){
        let record={event:'mail_attachment_pre_dispatch',provider,phase,structure:result};
        if(Buffer.byteLength(JSON.stringify(record))>16000)record={...record,structure:{...result,attachment_nodes:[],controls:[],truncated:true}};
        if(Buffer.byteLength(JSON.stringify(record))<=16000)process.stderr.write(JSON.stringify(record)+'\n');
      }
    } catch {}
  };
  const target = (await tab.inspect(`()=>(${attachmentDOM.toString()})(${JSON.stringify(provider)},'prepare',[])`))?.result;
  if (!target?.selector || target.error) {await diagnostic('prepare');throw fail(target?.error || 'email_attachment_control_unavailable');}
  if (typeof beforeEffect !== 'function') throw fail('email_send_configuration_error');
  beforeEffect();
  try {
    await run(`async page=>page.evaluate(({token,manifest})=>{
      const state=globalThis.__sparkclawManagedMail;
      if(!state?.ownershipChecked||!state.root?.isConnected||state.sendAttempted)throw new Error('email_draft_fields_unverified');
      state.attachmentTransfer={token,manifest,root:state.root,body:state.body,send:state.send,bytes:manifest.map(item=>new Uint8Array(item.size_bytes)),offsets:manifest.map(()=>0)};
      return true;
    },${JSON.stringify({token,manifest:expected})})`);
    const chunks=[];
    for(let index=0;index<files.length;index++)for(let offset=0;offset<files[index].bytes.length;offset+=45*1024)
      chunks.push({token,index,offset,data:files[index].bytes.subarray(offset,offset+45*1024).toString('base64')});
    const batchSize=Math.min(8,tab.attachmentSecretSlots);
    for(let batch=0;batch<chunks.length;batch+=batchSize){
      // The CLI includes source snippets in its diagnostics. Register each
      // bounded batch before executing it so binary contents stay redacted.
      await tab.setAttachmentSecrets(chunks.slice(batch,batch+batchSize).map(chunk=>chunk.data));
      for(const value of chunks.slice(batch,batch+batchSize)){
        await run(`async page=>page.evaluate(value=>{
          const state=globalThis.__sparkclawManagedMail,t=state?.attachmentTransfer;
          if(!state?.root?.isConnected||state.sendAttempted||t?.token!==value.token||t.offsets[value.index]!==value.offset)throw new Error('email_attachment_invalid');
          const part=Uint8Array.from(atob(value.data),char=>char.charCodeAt(0));
          if(part.length>46080||value.offset+part.length>t.bytes[value.index].length)throw new Error('email_attachment_limit');
          t.bytes[value.index].set(part,value.offset);t.offsets[value.index]+=part.length;
          return true;
        },${JSON.stringify(value)})`);
      }
    }
    // File/DataTransfer is the browser's native file-input data path. Construct
    // the files only after all chunks match the confirmed hash; no host file
    // path is visible to or reopened by the browser/CLI process.
    const proof = await run(`/* app-cli:owned-file-chooser:v1 */\nasync page => {
      let chooser;
      if (${JSON.stringify(target.chooser)}) {
        let selector=${JSON.stringify(target.selector)};
        const stage=async value=>page.evaluate(value=>{const s=globalThis.__sparkclawManagedMail;if(s?.attachmentShared&&!s.sendAttempted)s.attachmentStage=value;},value);
        if(${JSON.stringify(target.shared)}){
          await stage('ribbon_click');
          await page.locator(selector).click({timeout:5000});
          const menu=await page.evaluate(async()=>{
            const s=globalThis.__sparkclawManagedMail;s.attachmentStage='menu_wait';
            const deadline=Date.now()+${ATTACHMENT_MENU_WAIT_MS};
            for(;;){const result=(${attachmentDOM.toString()})(${JSON.stringify(provider)},'chooser_menu',[]);
              if(!result.pending)return result;
              if(Date.now()>=deadline)return {error:'email_attachment_control_unavailable'};
              await new Promise(resolve=>setTimeout(resolve,50));
            }
          });
          if(!menu?.selector||menu.error)return {error:menu?.error||'email_attachment_control_unavailable'};
          selector=menu.selector;
          await stage('native_action_click');
        }
        const pending=page.waitForEvent('filechooser',{timeout:5000});pending.catch(()=>{});
        await page.locator(selector).click({timeout:5000});
        await stage('chooser_wait');
        chooser=await pending;
        await stage('chooser_received');
        await page.evaluate(node=>{
          const state=globalThis.__sparkclawManagedMail;
          if(!state?.root?.isConnected||!state.root.contains(state.body)||
            (state.attachmentShared?(!state.attachmentContextValid?.()||state.attachmentActivatedInput!==node||state.attachmentActivationAmbiguous):(!state.root.contains(state.attachmentButton)||!state.root.contains(node))))throw new Error('email_draft_fields_unverified');
          state.attachmentInput=node;
          if(!state.attachmentInputValid?.())throw new Error('email_attachment_control_unavailable');
        },chooser.element());
      }
      const transferred=await page.evaluate(async token=>{
        const state=globalThis.__sparkclawManagedMail,t=state?.attachmentTransfer,input=state?.attachmentInput;
        const valid=()=>globalThis.__sparkclawManagedMail===state&&state?.ownershipChecked&&state.root?.isConnected&&!state.sendAttempted&&t?.token===token&&t.root===state.root&&t.body===state.body&&t.send===state.send&&state.root.contains(state.body)&&state.root.contains(state.send)&&state.attachmentInputValid?.()&&(t.bytes.length<2||input.multiple);
        if(!valid())throw new Error('email_attachment_control_unavailable');
        for(let i=0;i<t.bytes.length;i++){
          const hash='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',t.bytes[i])),b=>b.toString(16).padStart(2,'0')).join('');
          if(t.offsets[i]!==t.manifest[i].size_bytes||hash!==t.manifest[i].sha256)throw new Error('email_attachment_changed');
        }
        // Digests yield to the page event loop; recheck ownership immediately
        // before dispatch so moving or disabling an input cannot redirect data.
        if(!valid())throw new Error('email_attachment_control_unavailable');
        const transfer=new DataTransfer();
        for(let i=0;i<t.bytes.length;i++)transfer.items.add(new File([t.bytes[i]],t.manifest[i].name,{type:'application/octet-stream'}));
        input.files=transfer.files;
        input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
        input.dispatchEvent(new Event('change',{bubbles:true}));
        if(!state.attachmentProof)throw new Error('email_attachment_unverified');
        return await state.attachmentProof;
      },${JSON.stringify(token)});
      if(JSON.stringify(transferred)!==JSON.stringify(${JSON.stringify(expected)}))throw new Error('email_attachment_changed');
      if(chooser){
        const owned=await page.evaluate(node=>{const s=globalThis.__sparkclawManagedMail;return s?.ownershipChecked&&!s.sendAttempted&&s.root?.isConnected&&s.root.contains(s.body)&&s.root.contains(s.send)&&s.attachmentInput===node&&s.attachmentInputValid?.();},chooser.element());
        if(!owned)throw new Error('email_attachment_control_unavailable');
        // The Controller retires only this call's identical native chooser modal,
        // after ownership and transferred-byte proof have both completed.
        page[Symbol.for('sparkclaw.app-cli.owned-file-chooser.v1')]={chooser,input:chooser.element()};
      }
      return transferred;
    }`);
    if (['email_attachment_control_unavailable','email_draft_fields_unverified'].includes(proof?.error))throw fail(proof.error);
    if (JSON.stringify(proof) !== JSON.stringify(expected)) throw fail('email_attachment_changed');
    const result = await run(`async page=>page.evaluate(async expected=>{
      const deadline=Date.now()+20000;
      for(;;){
        const status=(${attachmentDOM.toString()})(${JSON.stringify(provider)},'ready',expected);
        if(status.error||status.ready)return status;
        if(Date.now()>=deadline)return {ready:false};
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    },${JSON.stringify(expected)})`);
    if (result?.ready !== true || result.count !== attachments.length) throw fail(result?.error || 'email_attachment_upload_unverified');
  } catch(error) {
    await diagnostic('upload');
    throw error;
  } finally {
    for(const file of files)file.bytes.fill(0);
    await run(`async page=>page.evaluate(token=>{
      const state=globalThis.__sparkclawManagedMail;
      if(state?.attachmentTransfer?.token===token){for(const bytes of state.attachmentTransfer.bytes)bytes.fill(0);delete state.attachmentTransfer;}
      state?.attachmentCleanup?.();return true;
    },${JSON.stringify(token)})`).catch(()=>{});
    await tab.setAttachmentSecrets([]).catch(()=>{});
  }
}
