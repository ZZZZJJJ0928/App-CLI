import { prepareNetworkOriginal, networkListPage, networkSnapshot, networkMarkRead } from './lib/network-reader.mjs';
import crypto from 'node:crypto';
import { capturePage, captureMail, markCapturedRead, validateCaptureInput, validateMailTarget } from "./lib/read-capture.mjs";

import { READ_PROVIDERS } from './lib/provider-account.mjs';
function fail(code = "email_page_contract_changed") { return Object.assign(new Error(code), { code }); }

// Select a message from the managed network reader. The historical export
// name is retained for callers, but unpinned reads require an explicit
// received-time interval and never filter by unread state.
export async function collectUnread(tab, provider, options = {}) {
  if (!READ_PROVIDERS[provider] || typeof options.onSelected !== 'function') throw fail("invalid_request");
  // Mail reads are deliberately network-only. The installed provider reader
  // is the sole owner of URLs, request templates, parsing and identity checks.
  // If it cannot qualify a list, the caller receives a stable capability error
  // instead of silently switching to DOM navigation or menu actions.
  const networkAccount = options.account_address || options.discovery_options?.account_address;
  const pinned = options.pinned_message_id || options.pinned_selection_id;
  const networkInterval = options.discovery_options?.interval_start && options.discovery_options?.interval_end
    ? options.discovery_options
    : options.pinned_message_id || options.pinned_selection_id
      ? {account_address:networkAccount, interval_start:'2000-01-01T00:00:00Z', interval_end:new Date().toISOString()}
      : null;
  if (!networkInterval?.account_address || !networkInterval.interval_start || !networkInterval.interval_end) throw fail('email_network_interval_required');
  const combinedRange = options.discovery_options?.provider_mode === 'time_range' && provider !== 'outlook';
  const snapshot = combinedRange ? null : await networkSnapshot(tab, provider, networkInterval, {required:true});
  if (options.discovery_options) {
    if (options.discovery_options.lane !== 'recent_inbound') throw fail('email_network_interval_required');
    const page = await networkListPage(tab, provider, {...options.discovery_options, limit:options.discovery_options.limit ?? 100}, snapshot);
    if (!page) throw fail('email_network_capability_unavailable');
    if (options.inventory) return page.listed;
    if (options.discovery) return page.discovery;
    return collectNetworkListed(tab, provider, options, page.listed);
  }
  if (provider === 'outlook' && pinned && options.pinned_received_at) {
    // Outlook's native search qualifies an immutable message ID, whereas its
    // ordinary folder list exposes a movable ItemId. Search around the
    // discovered receipt time and require that exact immutable ID again.
    const received = Date.parse(options.pinned_received_at);
    if (!Number.isFinite(received)) throw fail('invalid_request');
    const page = await networkListPage(tab, provider, {
      account_address:networkAccount, lane:'recent_inbound', provider_mode:'time_range', limit:50,
      interval_start:new Date(received-1000).toISOString(), interval_end:new Date(received+1000).toISOString(),
    }, null);
    if (!page) throw fail('email_network_capability_unavailable');
    return collectNetworkListed(tab, provider, options, page.listed);
  }
  if ((provider === 'qq_mail' || provider === 'gmail' || provider === 'outlook') && pinned) {
    const pageOptions = {
      ...networkInterval, lane:'recent_inbound', limit:100, continuation:'', folder:options.folder ?? 'inbox',
    };
    const hasTarget = page => page.listed.rows?.some(row =>
      (!options.pinned_message_id || row.provider_message_id === options.pinned_message_id || row.members?.some(member => member.provider_message_id === options.pinned_message_id)) &&
      (!options.pinned_selection_id || row.provider_selection_id === options.pinned_selection_id || row.provider_thread_id === options.pinned_selection_id));
    let page;
    try {
      page = await networkListPage(tab, provider, pageOptions, snapshot);
    } catch (error) {
      if (provider !== 'qq_mail' || error?.code !== 'email_network_list_unqualified') throw error;
      // The current QQ range search can still qualify a recently discovered
      // target when the native folder listing changes shape. Its bounded first
      // page is sufficient only when that exact stable ID is present.
      const range = await networkListPage(tab, provider, {...pageOptions, provider_mode:'time_range'}, null);
      if (!range || !hasTarget(range)) throw error;
      page = range;
    }
    // A new task page can observe a newer first page than discovery did. Keep
    // the target bound to network identities while walking bounded pages.
    for (let attempt = 0; page && page.discovery.coverage.continuation && attempt < 128; attempt += 1) {
      if (hasTarget(page)) break;
      page = await networkListPage(tab, provider, {
        ...pageOptions, continuation:page.discovery.coverage.continuation,
      }, page.listed);
    }
    if (!page) throw fail('email_network_capability_unavailable');
    return options.inventory ? page.listed : collectNetworkListed(tab, provider, options, page.listed);
  }
  if (options.inventory) return snapshot;
  if (options.discovery) throw fail('email_network_interval_required');
  return collectNetworkListed(tab, provider, options, snapshot);
}

async function collectNetworkListed(tab, provider, options, listed) {
  const pinned = options.pinned_message_id || options.pinned_selection_id;
  if (!listed.rows?.length && !pinned) {
    if (listed.empty === true || listed.scan_complete === true) return {status:'empty'};
    throw fail('email_network_list_unqualified');
  }
  const folder = options.folder ?? 'inbox';
  const matches = row => pinned
    ? (!options.pinned_message_id || row.provider_message_id === options.pinned_message_id || row.members?.some(member=>member.provider_message_id===options.pinned_message_id)) &&
      (!options.pinned_selection_id || row.provider_selection_id === options.pinned_selection_id || row.provider_thread_id === options.pinned_selection_id)
    : (!row.draft && !row.sent) && (!row.folder || row.folder === folder || folder === 'all');
  let selected = listed.rows.find(matches);
  if (!selected) throw fail(pinned ? 'email_pinned_message_unavailable' : 'email_network_list_unqualified');
  if (options.pinned_message_id && selected.provider_message_id !== options.pinned_message_id) {
    const member = selected.members?.find(item => item.provider_message_id === options.pinned_message_id && !item.draft);
    if (!member) throw fail('email_pinned_message_unavailable');
    selected = {...selected, ...member, provider_selection_id:selected.provider_selection_id ?? selected.provider_thread_id,
      provider_thread_id:selected.provider_thread_id ?? member.provider_thread_id};
  }
  const account = listed.account_address?.toLowerCase();
  if (!account) throw fail('email_account_identity_unavailable');
  if (options.account_address && account !== options.account_address.toLowerCase()) throw fail('email_account_identity_mismatch');
  const message = {...selected, account_address:account, folder, provider_selection_id:selected.provider_selection_id ?? selected.provider_thread_id ?? selected.provider_message_id};
  if (message.provider_message_id === undefined) throw fail('email_message_identity_ambiguous');
  await options.onSelected(message);
  if (options.capture_required === false) return message;
  const target = {account_address:account, provider_message_id:message.provider_message_id};
  const original = await prepareNetworkOriginal(tab, provider, target);
  if (!original?.selector || original.provider_message_id !== target.provider_message_id || original.account_address !== account) throw fail('email_network_original_unqualified');
  return {...message, original, network_original:true, read_state:message.unread ? 'unread' : 'read'};
}


export async function markRead(tab, provider, message) {
  if (!message?.account_address || !message?.provider_message_id) throw fail('email_message_identity_invalid');
  return networkMarkRead(tab, provider, {
    account_address:message.account_address,
    provider_message_id:message.provider_message_id,
    provider_selection_id:message.provider_selection_id,
    folder:message.folder,
  });
}

export const readEmail = (input,runtime,provider) => captureMail(input,runtime,provider,{collectUnread,markRead,markAfterCapture:false});
export const readQQMail = (input,runtime) => readEmail(input,runtime,'qq_mail');
export const readOutlook = (input,runtime) => readEmail(input,runtime,'outlook');
export const readGmail = (input,runtime) => readEmail(input,runtime,'gmail');
export const markEmailRead = (input,runtime,provider) => markCapturedRead(input,runtime,provider,{collectUnread,markRead});

export async function discoverEmail(input, runtime, provider) {
  validateCaptureInput(input, provider);
  if (input.operation !== 'discover') throw fail('invalid_request');
  return runtime.withReadTab(async tab => {
    if (!input.discovery) {
      const snapshot = await networkSnapshot(tab, provider, {interval_start:'2000-01-01T00:00:00Z', interval_end:new Date().toISOString()}, {required:true});
      if (!snapshot?.account_address) throw fail('email_account_identity_unavailable');
      return {schema_version:1,provider,status:'partial',account_address:snapshot.account_address.toLowerCase(),candidates:[],coverage:{scope:'account',scan_complete:false,scanned_rows:0,unsupported_rows:0,limited:true},observed_at:new Date().toISOString()};
    }
    const listed=await networkSnapshot(tab,provider,input.discovery,{required:true});
    const network=await networkListPage(tab,provider,input.discovery,listed);
    if (!network?.discovery) throw fail('email_network_capability_unavailable');
    return network.discovery;
  });
}

export async function enumerateThread(input,runtime,provider) {
  validateCaptureInput(input,provider);
  if (input.operation !== 'enumerate_thread') throw fail('invalid_request');
  return runtime.withReadTab(async tab => {
    const listed = await collectUnread(tab,provider,{inventory:true,account_address:input.thread.account_address,folder:input.thread.folder,
      pinned_selection_id:input.thread.provider_selection_id,onSelected:async()=>{throw fail('invalid_request');}});
    if (!listed.network_reader) throw fail('email_network_capability_unavailable');
    if (listed.account_address?.toLowerCase() !== input.thread.account_address.toLowerCase()) throw fail('email_account_identity_mismatch');
    const rows = listed.rows.filter(row=>row.provider_selection_id===input.thread.provider_selection_id || provider==='gmail' && row.provider_thread_id===input.thread.provider_selection_id);
    if (listed.network_reader) {
      const members = [];
      for (const row of rows) {
        for (const member of row.members?.length ? row.members : [row]) {
          if (!member?.provider_message_id || member.draft) continue;
          const folder=member.folder ?? (member.inbox ? 'inbox' : member.sent ? 'sent' : input.thread.folder ?? 'all');
          members.push({target:{account_address:input.thread.account_address,provider_message_id:member.provider_message_id,
            provider_selection_id:input.thread.provider_selection_id,provider_thread_id:input.thread.provider_thread_id ?? member.provider_thread_id,
            folder},direction:member.sent?'outbound':'inbound',draft:false,read_state:member.unread?'unread':'read',...(member.received_at?{received_at:member.received_at}:{})});
        }
      }
      if (!members.length) throw fail('email_network_thread_unqualified');
      const digest = crypto.createHash('sha256').update(JSON.stringify([provider,input.thread,members.map(member=>member.target.provider_message_id)])).digest('hex');
      const [prior,offsetText] = input.continuation.split(':');
      const offset = prior === digest ? Number(offsetText) || 0 : 0;
      const page = members.slice(offset,offset+input.limit), continuation = offset+page.length < members.length ? `${digest}:${offset+page.length}` : '';
      return {schema_version:1,provider,status:continuation?'partial':'complete_for_observation',thread:input.thread,members:page,
        coverage:{scope:'thread',scan_complete:!continuation,scanned_rows:members.length,unsupported_rows:0,limited:Boolean(continuation),...(continuation?{continuation}:{})},observed_at:new Date().toISOString()};
    }

  });
}


export const collectEmailPage = (input, runtime, provider) => capturePage(input, runtime, provider, {
  discover: async (tab, discoveryOptions) => {
    const listed = discoveryOptions.provider_mode === 'time_range' && provider !== 'outlook'
      ? null : await networkSnapshot(tab, provider, discoveryOptions, {required:true});
    const network = await networkListPage(tab,provider,discoveryOptions,listed);
    if (!network) throw fail('email_network_capability_unavailable');
    return network;
  },
  collect: async (tab, sameProvider, options, listed) => {
    if (options.retained_target) {
      const target=options.retained_target;
      validateMailTarget(target);
      if(target.provider_message_id!==options.pinned_message_id || target.account_address.toLowerCase()!==options.account_address.toLowerCase())throw fail('email_account_identity_mismatch');
      const original=await prepareNetworkOriginal(tab,sameProvider,target,{retained:true});
      const message={...target,original,network_original:true,read_state:'unknown'};
      await options.onSelected(message);
      return message;
    }
    if (listed.network_reader) return collectNetworkListed(tab, sameProvider, options, listed);
    throw fail('email_network_capability_unavailable');
  },
});
