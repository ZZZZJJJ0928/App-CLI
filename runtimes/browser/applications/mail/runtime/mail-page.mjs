import crypto from 'node:crypto';
import {ControllerError} from './errors.mjs';
const clientContractError = () => new ControllerError('browser_extension_unavailable','Browser host returned invalid output');
const clientUnavailableError = () => new ControllerError('browser_extension_unavailable','Browser host unavailable');
const pageStale = () => new ControllerError('browser_page_stale','Task page is stale');
const TRANSIENT_EVALUATION_ATTEMPTS = 4;
const TRANSIENT_EVALUATION_DELAY_MS = 250;
const METHODS = ['currentURL','count','attribute','value','text','lines','readMany','visible','enabled','evaluate','click','runReadCode','download','fill','focus','press','waitFor','waitMilliseconds','navigate','prepareBackgroundPage'];
export class MailPage {
  constructor(browser, registration, context) {
    this.browser=browser; this.registration=registration; this.signal=context.signal;
    this.beforeEffect=context.beforeEffect;
    this.mailDocumentNonce=context.resource.document_nonce;
    this.emailWorkspaceRoot=context.resource.workspace_root;
    for (const method of METHODS) this[method]=async (...args)=>{
      try {return await browser.call(method,...args.map(value=>value===undefined?null:value));}
      catch (error) {
        const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
        if (code === 'application_download_limit') throw Object.assign(new Error('Email download limit'), {code:'email_download_limit'});
        if (code === 'application_download_unavailable') throw Object.assign(new Error('Email download unavailable'), {code:'email_capture_unavailable'});
        if (code === 'application_login_required') throw Object.assign(new Error('Email login required'), {code:'email_login_required'});
        if (code === 'application_origin_invalid') throw Object.assign(new Error('Email origin invalid'), {code:'email_provider_origin_invalid'});
        if (code) error.code = code;
        throw error;
      }
    };
  }
  qqTask() {
    return {onTab: async commands => {
      if (this.registration.operation==='probe' && commands.length && commands.every(command =>
        command[0] === 'get' && ['url', 'text'].includes(command[1]) || command[0] === 'is' && command[1] === 'visible')) return this.browser.call('probeReads',commands);
      const results=[];
      for(const command of commands) results.push({success:true,result:await this.act(command)});
      return results;
    }};
  }
  async act(command) {
    if(command?.[0]==='click' && (command[1]===this.registration.effectSelector || this.registration.effectSelectors?.includes(command[1]))) this.beforeEffect();
    return this.browser.call('act',command);
  }
  outlookTab() { return {inspect:expression=>this.browser.call('inspect',expression),readMany:commands=>this.readMany(commands),act:command=>this.act(command)}; }
  gmailTab() {
    return {open:async()=>{},closeOwnedTab:async()=>{},dispose:async()=>{},inspect:expression=>this.browser.call('inspect',expression),
      readMany:(...args)=>this.readMany(...args),getUrl:(...args)=>this.currentURL(...args),
      getCount:(...args)=>this.count(...args),getAttribute:(...args)=>this.attribute(...args),
      getValue:(...args)=>this.value(...args),getText:(...args)=>this.text(...args),
      waitFor:(...args)=>this.waitFor(...args),click:(...args)=>this.click(...args),fill:(...args)=>this.fill(...args),
      press:(...args)=>this.press(...args),waitMilliseconds:(...args)=>this.waitMilliseconds(...args),
      focus:(...args)=>this.focus(...args),isVisible:(...args)=>this.visible(...args),isEnabled:(...args)=>this.enabled(...args)};
  }
  async prepareMailRound(account, reused = false) {
    const resetCode = `async page=>page.evaluate(async options=>{
      if(options.reused&&window.__sparkclawMailDocument!==options.nonce)return {stale:true};
      const deadline=Date.now()+5000;
      for(;;){
        const reader=window.SparkClawMailReader;
        if(!reader&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));continue;}
        if(reader?.provider!==options.provider||reader.version!=='0.2.0'||typeof reader.resetRound!=='function')return {stale:true};
        try{
          const result=reader.resetRound({account_address:options.account});
          window.__sparkclawMailDocument=options.nonce;
          return result;
        }catch(error){
          if(error.code==='email_account_identity_unavailable'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));continue;}
          return {error:error.code||'email_network_read_failed'};
        }
      }
    },${JSON.stringify({provider:this.registration.provider,account,nonce:this.mailDocumentNonce,reused})})`;
    let result;
    for (let attempt = 0; attempt < TRANSIENT_EVALUATION_ATTEMPTS; attempt += 1) {
      try {
        result = await this.runReadCode(resetCode);
        break;
      } catch (error) {
        // QQ Mail can replace its initial document while the userscript is
        // becoming ready. resetRound is local-only and runs before any
        // provider query, so retry only this preparation step after proving
        // that the owned task still has an allowed, signed-in provider URL.
        if (!isContextDestroyed(error) || attempt === TRANSIENT_EVALUATION_ATTEMPTS - 1) throw error;
        await abortableDelay(TRANSIENT_EVALUATION_DELAY_MS, this.signal);
        if (this.registration.signedOutURL?.(await this.currentURL())) throw Object.assign(new Error('email_login_required'), {code:'email_login_required'});
      }
    }
    if (result?.stale) throw pageStale('task_page_missing');
    if (result?.error) throw Object.assign(new Error(result.error),{code:result.error});
    if(result?.provider!==this.registration.provider||result?.account_address!==account.toLowerCase()) throw clientContractError();
  }

  async parkMailRound(account) {
    // Local-only reset releases original blobs/records before the page is idle.
    // Retain topology/origin/document/account guards; never refresh a mailbox.
    await this.prepareMailRound(account,true);
    this.signal = undefined;
  }

}
function isContextDestroyed(error) {
  return error &&
    error.diagnosticReason === "process_exit_context_destroyed";
}

function isExpectedTaskPageClosure(error) {
  return error &&
    error.diagnosticCommand === "tab-close" &&
    error.diagnosticReason === "process_exit_page_closed";
}

async function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) throw clientUnavailableError();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const abort = () => finish(() => reject(clientUnavailableError()));
    const finish = (callback) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer.unref?.();
  });
}


export function createProviderRuntime(client, registration) {
  return {
    timeoutMs: registration.timeoutMS,
    prepareSendPage: async () => {
      if(registration.operation!=="send")throw clientContractError();
      await client.prepareBackgroundPage();
    },
    signal: client.signal,
    withTaskTab: async (operation, callback) => {
      if (operation !== registration.operation) throw clientContractError();
      return await callback(
        registration.provider === "qq_mail" ? client.qqTask() : client.outlookTab(),
      );
    },
    createOwnedTab: async () => client.gmailTab(),
    withSendTab: async callback => {
      if(registration.operation!=="send")throw clientContractError();
      return callback({
        inspect:expression=>client.gmailTab().inspect(expression),
        click:selector=>client.click(selector),
        fill:(selector,value)=>{
          // Reply lookup uses only these fixed provider-owned folder queries;
          // message fields always go through the private secret slots.
          if(selector==='input[name="q"]'&&['in:inbox','in:sent','-in:trash -in:spam -in:drafts'].includes(value))return client.runReadCode(`async page=>{await page.locator('input[name="q"]').fill(${JSON.stringify(value)});return true}`);
          return client.fill(selector,value);
        },
        focus:selector=>client.focus(selector),
        press:key=>client.press(key),
        waitFor:selector=>client.waitFor(selector),
        // Reply lookup shares the read-side list observers. Send registrations
        // use a run-code navigation because their fixed login URL can differ
        // from the mailbox route needed to verify the reply target.
        navigate:url=>client.runReadCode(`async page=>{await page.goto(${JSON.stringify(url)});return true}`),
        readMany:commands=>client.readMany(commands),
        runReadCode:code=>client.runReadCode(code),
      });
    },
    withReadTab: async callback => {
      if (!["read", "discover", "capture", "enumerate_thread", "mark_read", "collect_page"].includes(registration.operation)) throw clientContractError();
      return await callback({
        inspect: expression => client.gmailTab().inspect(expression),
        click: selector => client.click(selector),
        fill: (selector, value) => client.runReadCode(`async page => { await page.locator(${JSON.stringify(selector)}).fill(${JSON.stringify(value)}); return true; }`),
        press: key => client.press(key),
        navigate: url => client.navigate(url),
        runReadCode: (code, timeoutMS) => client.runReadCode(code, timeoutMS),
        download: (selector, destination, maxBytes) => client.download(selector, destination, maxBytes),
      });
    },
    emailWorkspaceRoot: client.emailWorkspaceRoot,
    captureTimingDiagnostic: client.captureTimingDiagnostic,
    capturePhaseEvidence: client.capturePhaseEvidence,
  };
}
