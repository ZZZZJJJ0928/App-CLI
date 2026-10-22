// Serialized into the QQ Reader. An explicitly armed, independently confirmed
// DOM compose teaches a page-private replay. A response messageid must be
// independently joined to a matching Sent row before a send can be completed.
//
// Reuse: a template lives only in this page's memory, for TEMPLATE_TTL_MS after
// the DOM proof or the last proven replay. It is retired by expiry, an account
// change, page reload/disposal, a failed pre-dispatch Sent read (the session no
// longer reads) and every replay that is not proven sent (including a provider
// rejection). Learning windows, including mark-read's, do not retire it.
//
// Dispatch needs a ticket from prepare(): the Sent baseline is read before the
// caller claims the dispatch, so a failed read means nothing was sent.
export function installQQSendPrototype({account, fetch, readText, responseShape}) {
  const TEMPLATE_TTL_MS = 15 * 60 * 1000, TICKET_TTL_MS = 5 * 60 * 1000;
  // QQ listed a replayed send 4.2 s after accepting it. Poll on a time bound,
  // returning on the first match; only absence after 12 s is unknown. The whole
  // dispatch stays below the host's 30 s page-call budget.
  const SENT_FIRST_DELAY_MS = 1000, SENT_POLL_MS = 750, SENT_LIMIT_MS = 12000, DISPATCH_LIMIT_MS = 28000;
  const fields = 'calendar content from func is_resume is_text is_urgent language mailid need_receipt r save_to_send separated_copy sid subject time_zone time_zone_dst to'.split(' ').sort();
  let tokens = 0, active = true, arm = null, candidate = null, template = null, prepared = null, seen = 0, pending = null, expiry = null, reason = 'unlearned', generation = 0;
  const clear = () => { generation++; arm = candidate = template = prepared = null; clearTimeout(expiry); expiry = null; };
  const fail = code => { throw Object.assign(new Error(code), {code}); };
  const address = value => typeof value === 'string' && value.length <= 320 && /^[^\s<>@,;"\x00-\x1f]+@[^\s<>@,;"\x00-\x1f]+\.[^\s<>@,;"\x00-\x1f]+$/u.test(value);
  function checked(expected) {
    if (!active) fail('email_network_capability_unavailable');
    try { return account(expected); } catch (error) { clear(); throw error; }
  }
  function recipient(value) {
    const match = /^(?:"[^"<>\r\n]*"\s*<([^<>]+)>|([^<>;,]+))([;,]?)$/.exec(value);
    const email = match?.[1] || match?.[2];
    return address(email) ? {email, named: Boolean(match[1]), tail: match[3]} : null;
  }
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/.test(value);
  function sentResponse(text) {
    if (typeof text !== 'string' || text.length > 1 << 20) return null;
    try {
      const value = JSON.parse(text);
      return value?.head?.ret === 0 && id(value.body?.messageid) ? value.body.messageid : null;
    } catch { return null; }
  }
  function observe({session, method, url, headers, body, status, responseURL, responseText}) {
    if (!active || !arm || session !== arm || performance.now() > arm.until) return;
    let u; try { u = new URL(url, location.href); } catch { return; }
    if (u.origin !== location.origin || u.pathname !== '/send/sendmail') return;
    if (typeof body !== 'string' || body.length > 1 << 20) return;
    const form = new URLSearchParams(body);
    // The same endpoint handles autosave (func=2). Only an actual send can
    // count toward the single observed dispatch in this learning window.
    if (form.get('func') !== '1') return;
    candidate = template = null; reason = 'request_shape';
    if (++seen !== 1 || method?.toUpperCase() !== 'POST' || status !== 200 || responseURL !== u.href ||
        u.username || u.password || u.hash || typeof body !== 'string' || body.length > 1 << 20) return;
    if ([...form.keys()].sort().join(',') !== fields.join(',') || [...u.searchParams.keys()].some(key => !['sid','func','r'].includes(key))) return;
    // Unknown flags, extra fields (including bcc/attachments/reply metadata),
    // resumed drafts and non-default send modes cannot enter this prototype.
    if (['is_resume','is_urgent','need_receipt','separated_copy','is_text'].some(key => form.get(key) !== 'false') ||
        form.get('save_to_send') !== 'true' || form.get('calendar') !== '' || !form.get('sid')) return;
    let owner; try { owner = checked(); } catch { return; }
    const from = recipient(form.get('from')), to = recipient(form.get('to'));
    if (!from || from.email.toLowerCase() !== owner || !to) return;
    if (u.searchParams.has('sid') && u.searchParams.get('sid') !== form.get('sid')) return;
    const copied = {};
    try {
      const entries = typeof Headers !== 'undefined' && headers instanceof Headers ? [...headers] : Array.isArray(headers) ? headers : Object.entries(headers || {});
      for (const [key, value] of entries) {
        const name = key.toLowerCase();
        if (!['content-type','accept','x-requested-with'].includes(name) || typeof value !== 'string' || value.length > 256 || /[\r\n]/.test(value)) return;
        copied[name] = value;
      }
    } catch { return; }
    if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(copied['content-type'] || '')) return;
    const messageid = sentResponse(responseText);
    if (!messageid) { reason = 'response_identifier'; return; }
    candidate = {url: u.href, headers: copied, form, owner, to, subject: form.get('subject'), messageid, until: arm.until};
    reason = 'awaiting_confirmation';
  }
  async function sentList(value, signal) {
    checked(value.owner);
    const url = new URL('/list/maillist', location.origin);
    const body = new URLSearchParams({sid:value.form.get('sid'),r:String(Math.random()),language:value.form.get('language'),
      func:'1',dir:'3',dirid:'3',sort_type:'1',sort_direction:'1',page_now:'0',page_size:'50',enable_topmail:'true'});
    const response = await fetch(url.href, {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8'},
      body:body.toString(),credentials:'same-origin',redirect:'error',cache:'no-store',signal});
    if (response.status !== 200 || response.url !== url.href) fail('email_network_sent_unqualified');
    const text = await readText(response);
    checked(value.owner);
    const parsed = JSON.parse(text);
    if (parsed?.head?.ret !== 0 || !Array.isArray(parsed.body?.list) || parsed.body.list.length > 50 ||
        !Number.isInteger(parsed.body.total_num) || parsed.body.total_num < parsed.body.list.length) fail('email_network_sent_unqualified');
    return parsed.body.list;
  }
  function matchSent(rows, messageid, owner, to, subject) {
    const found = rows.filter(row => row?.messageid === messageid);
    if (found.length !== 1) return null;
    const row = found[0], senders = row.senders?.item, receivers = row.receivers?.item;
    return row.dirid === 3 && id(row.emailid) && rows.filter(item => item?.emailid === row.emailid).length === 1 && row.subject === subject &&
      Array.isArray(senders) && senders.length === 1 && senders[0]?.email?.toLowerCase() === owner &&
      Array.isArray(receivers) && receivers.length === 1 && receivers[0]?.email === to[0] ? row.emailid : null;
  }
  async function confirm({account_address, to, subject, provider_message_id} = {}) {
    const owner = checked(account_address), value = candidate, epoch = generation;
    candidate = null; arm = null;
    if (!value || seen !== 1 || value.until < performance.now() || value.owner !== owner || !Array.isArray(to) || to.length !== 1 ||
        to[0] !== value.to.email || subject !== value.subject || !id(provider_message_id)) return false;
    try {
      const rows = await sentList(value, AbortSignal.timeout(10000));
      if (!active || generation !== epoch || matchSent(rows, value.messageid, owner, to, subject) !== provider_message_id || value.until < performance.now()) {
        reason = 'sent_confirmation'; return false;
      }
    } catch { reason = 'sent_confirmation'; return false; }
    // Keep only template/session fields. Prior recipients, subject, content and
    // draft identity are discarded, even while the page remains alive.
    for (const key of ['to','subject','content','mailid']) value.form.set(key, '');
    value.to = {named: value.to.named, tail: value.to.tail}; delete value.subject; delete value.messageid;
    value.until = performance.now() + TEMPLATE_TTL_MS;
    // The learning window's timer must not retire a confirmed template.
    clearTimeout(expiry); expiry = null;
    template = value; reason = 'ready';
    return true;
  }
  function ready({account_address} = {}) {
    const owner = checked(account_address);
    if (template && template.owner !== owner) { template = null; reason = 'account_changed'; }
    if (template && template.until < performance.now()) { template = null; reason = 'template_expired'; }
    return {provider: 'qq_mail', account_address: owner, ready: Boolean(template), reason: template ? 'ready' : reason};
  }
  const validMessage = ({to, cc = [], subject, text} = {}) => Array.isArray(to) && to.length === 1 && address(to[0]) && Array.isArray(cc) && !cc.length &&
    typeof subject === 'string' && subject.trim() && [...subject].length <= 998 && !/[\r\n\0]/.test(subject) &&
    typeof text === 'string' && text.trim() && !text.includes('\0') && new TextEncoder().encode(text).length <= 204800;
  const messageKey = ({to, subject, text}) => JSON.stringify([to, subject, text]);
  // Sent rows that already exist cannot certify a new send. Reading them is
  // also the session check, and it runs before the caller claims a dispatch:
  // any refusal here is "not sent" and leaves the DOM flow available.
  const baselineOf = rows => ({messageids: new Set(rows.map(row => row?.messageid).filter(Boolean)), emailids: new Set(rows.map(row => row?.emailid).filter(Boolean))});
  async function prepare({account_address, ...message} = {}) {
    const owner = checked(account_address);
    prepared = null;
    const refused = why => ({provider: 'qq_mail', account_address: owner, ready: false, dispatched: false, reason: why});
    if (!validMessage(message)) return refused('invalid_request');
    if (!ready({account_address}).ready) return refused(reason);
    const value = template;
    try {
      const rows = await sentList(value, AbortSignal.timeout(10000));
      if (!active || template !== value) return refused('template_changed');
      const token = `${++tokens}:${Math.random().toString(36).slice(2) || '0'}`;
      prepared = {token, owner, value, message: messageKey(message), baseline: baselineOf(rows), until: performance.now() + TICKET_TTL_MS};
      return {provider: 'qq_mail', account_address: owner, ready: true, token};
    } catch {
      // The session that would carry the send cannot read; never dispatch on it.
      if (template === value) { template = null; reason = 'sent_baseline'; }
      return refused('sent_baseline');
    }
  }
  async function send({account_address, token, ...message} = {}) {
    const owner = checked(account_address), ticket = prepared;
    // Only the ticket of the latest prepare() for this exact message can
    // dispatch. Its template is not re-timed here: prepare() already proved it,
    // and an expiry during the caller's release must not turn into unknown.
    if (!ticket || typeof token !== 'string' || ticket.token !== token || ticket.owner !== owner || ticket.value !== template ||
        ticket.until < performance.now()) fail('email_network_template_unlearned');
    if (!validMessage(message) || ticket.message !== messageKey(message)) fail('invalid_request');
    const {to, subject, text} = message, value = template, baseline = ticket.baseline;
    clear(); // consumed before any asynchronous dispatch
    const form = new URLSearchParams(value.form);
    form.set('to', (value.to.named ? `"${to[0]}"<${to[0]}>` : to[0]) + value.to.tail);
    form.set('subject', subject);
    const escape = line => line.replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
    form.set('content', text.split(/\r?\n/).map(line => `<div>${line ? escape(line) : '<br>'}</div>`).join(''));
    form.set('r', String(Math.random()));
    const url = new URL(value.url); if (url.searchParams.has('r')) url.searchParams.set('r', form.get('r'));
    const controller = new AbortController(); pending = controller;
    const timer = setTimeout(() => controller.abort(), DISPATCH_LIMIT_MS);
    const result = {provider:'qq_mail', account_address:owner, outcome:'unknown'};
    const timings = {}; let phase = 'send_response';
    try {
      const dispatchAt = performance.now();
      const reply = await fetch(url.href, {method:'POST', headers:value.headers, body:form.toString(), credentials:'same-origin', redirect:'error', signal:controller.signal});
      const response = await readText(reply);
      timings.request_ms = Math.round(performance.now() - dispatchAt);
      checked(account_address);
      const messageid = reply.status === 200 && reply.url === url.href && sentResponse(response);
      if (!messageid || baseline.messageids.has(messageid)) return {...result,reason:'response_identifier',response_shape:responseShape(response),timings};
      phase = 'sent_confirmation'; const verifyAt = performance.now();
      for (let wait = SENT_FIRST_DELAY_MS; ;) {
        await new Promise(resolve => setTimeout(resolve, wait));
        const rows = await sentList(value, controller.signal);
        const provider_message_id = matchSent(rows, messageid, owner, to, subject);
        if (provider_message_id && !baseline.emailids.has(provider_message_id)) {
          timings.sent_verify_ms = Math.round(performance.now() - verifyAt);
          // This replay proved the template again; renew it for this page only.
          let renewed = false, same = false;
          try { same = checked(account_address) === owner; } catch {}
          if (active && same && !template) {
            value.until = performance.now() + TEMPLATE_TTL_MS; template = value; reason = 'ready'; renewed = true;
          }
          return {...result,outcome:'sent',provider_message_id,response_message_id:messageid,template_ready:renewed,
            proof:{source:'qq_sent_list_v1',provider_message_id,response_message_id:messageid,folder:'sent',fresh:true},timings};
        }
        // The last read lands exactly on the limit.
        const left = SENT_LIMIT_MS - (performance.now() - verifyAt);
        if (left <= 0) break;
        wait = Math.min(SENT_POLL_MS, left);
      }
      timings.sent_verify_ms = Math.round(performance.now() - verifyAt);
      return {...result,reason:phase,timings};
    } catch { return {...result, reason:phase,timings}; }
    finally { clearTimeout(timer); pending = null; }
  }
  return {observe, confirm, ready, prepare, send,
    // A learning window (send or mark-read) resets only learning state. A
    // confirmed template and its preflight ticket keep their own lifetimes; a
    // template is replaced only by a newly observed and confirmed DOM send.
    arm(session) {
      generation++; arm = session; candidate = null; seen = 0; clearTimeout(expiry); expiry = null;
      if(session)expiry = setTimeout(() => { if (arm === session) { arm = candidate = null; } }, Math.max(0, session.until - performance.now()));
    },
    dispose() { active = false; clear(); pending?.abort(); }
  };
}
