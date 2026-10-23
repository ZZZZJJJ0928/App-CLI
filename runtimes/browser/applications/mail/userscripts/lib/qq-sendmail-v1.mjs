// Serialized into the QQ Reader. The maintained qq_sendmail_v1 template builds
// QQ's own /send/sendmail request (home-web `sendMail`/`k(e)` and the shared
// `post()` parameters), so no request is learned from a DOM send. The runtime
// never relearns it: a QQ field change is a template update in a paired release.
//
// Three page calls form the provider-independent native send interface:
// preflight (account and preconditions, one-use ticket, no message content),
// dispatch (exactly one request, decided only by QQ's response) and lookup
// (one bounded Sent search, only when a dispatch is pending confirmation).
// Neither the sid, the body, the raw recipient nor the raw response leaves the
// page; results carry identifiers, codes and timings only.

export const QQ_SENDMAIL_TEMPLATE = 'qq_sendmail_v1';

// XmailEditor gu() ("paste as plain text"), then the text-node serialization
// of innerHTML. Each line becomes one <div>; an empty line is <div><br></div>.
export function qqPlainTextHTML(text) {
  const encode = value => value.replace(/[&<>\u00a0]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '\u00a0': '&nbsp;'}[char]));
  return String(text).split('\n').map(raw => {
    let line = raw.replace(/\r/g, '').replace(/^ /, '\u00a0').replace(/ $/, '\u00a0').replace(/ {2}/g, ' \u00a0');
    if (line.includes('\t')) {
      let out = '';
      for (const char of line) out += char === '\t' ? '\u2002'.repeat(6 - out.length % 6) : char;
      line = out;
    }
    return line ? `<div>${encode(line)}</div>` : '<div><br></div>';
  }).join('');
}

// QQ ee(): the current uin comes from <head xmail_uin>, else the xm_muti_sid
// entry whose sid equals the address-bar sid, else cookie xm_uin. Its sid is
// read from xm_muti_sid (`uin&sid|...`), else xm_uin + xm_sid; the address bar
// is only the fallback. A disagreement is a drift signal, never a rewrite.
export function qqSendmailSid({headUin = '', cookie = '', href = ''} = {}) {
  const valid = value => typeof value === 'string' && value.length <= 4096 && /^[A-Za-z0-9_.~*+=:%\-]+$/.test(value);
  const jar = new Map();
  for (const part of String(cookie).split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    let value = part.slice(at + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    jar.set(part.slice(0, at).trim(), value);
  }
  let urlSid = '';
  try { urlSid = new URL(href).searchParams.get('sid') || ''; } catch {}
  if (!valid(urlSid)) urlSid = '';
  const multi = (jar.get('xm_muti_sid') || '').split('|').map(entry => {
    const at = entry.indexOf('&');
    return at > 0 ? [entry.slice(0, at), entry.slice(at + 1)] : null;
  }).filter(Boolean);
  const uin = (typeof headUin === 'string' && headUin) || multi.find(([, sid]) => urlSid && sid === urlSid)?.[0] || jar.get('xm_uin') || '';
  let cookieSid = '';
  if (multi.length) cookieSid = uin ? multi.find(([entry]) => entry === uin)?.[1] || '' : '';
  else if (jar.get('xm_uin') && (!uin || uin === jar.get('xm_uin'))) cookieSid = jar.get('xm_sid') || '';
  if (!valid(cookieSid)) cookieSid = '';
  const sid = cookieSid || urlSid;
  return {sid, source: cookieSid ? 'cookie' : urlSid ? 'url' : 'none', disagree: Boolean(cookieSid && urlSid && cookieSid !== urlSid)};
}

// QQ's own time zone formulas from the parameter builder.
export function qqTimeZone(DateType = Date) {
  const base = new DateType(2009, 0, 1).getTimezoneOffset() / 60 * 3600;
  const now = new DateType().getTimezoneOffset() / 60 * 3600;
  return {time_zone: String(0 - base), time_zone_dst: String(base - now)};
}

export function installQQSendmailV1({account, fetch, readText}) {
  const VERSION = 'qq_sendmail_v1', ORIGIN = 'https://wx.mail.qq.com';
  const TICKET_MS = 60000, REQUEST_MS = 25000, LOOKUP_MS = 12000, POLL_MS = 750, SKEW_MS = 120000;
  let active = true, ticket = null, tokens = 0;
  const fail = code => { throw Object.assign(new Error(code), {code}); };
  const address = value => typeof value === 'string' && value.length <= 320 && /^[^\s<>@,;"\x00-\x1f]+@[^\s<>@,;"\x00-\x1f]+\.[^\s<>@,;"\x00-\x1f]+$/u.test(value);
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/.test(value);
  const canonical = value => { const at = value.lastIndexOf('@'); return value.slice(0, at) + '@' + value.slice(at + 1).toLowerCase(); };
  const checked = expected => { if (!active) fail('email_network_capability_unavailable'); return account(expected); };
  const visible = node => { const rect = node?.getBoundingClientRect?.(); return Boolean(rect && rect.width > 0 && rect.height > 0); };
  const loginVisible = () => [...document.querySelectorAll('.login-page')].some(visible);
  const language = () => typeof window.lang === 'string' && /^[A-Za-z_\-]{1,16}$/.test(window.lang) ? window.lang : '';
  const sid = () => qqSendmailSid({headUin: document.head?.getAttribute?.('xmail_uin') || '', cookie: document.cookie, href: location.href});
  // Front-end version, only to compare QQ releases; never a gate.
  function drift(value) {
    const manifest = window.__WEB_MANIFEST__?.version;
    const script = [...document.scripts].map(node => /\/(home-web\.[0-9a-f]{8,32}\.js)(?:$|[?#])/.exec(node.src || '')?.[1]).find(Boolean);
    return {...(typeof manifest === 'string' && /^[A-Za-z0-9._\-]{1,64}$/.test(manifest) ? {manifest_version: manifest} : {}),
      ...(script ? {home_web: script} : {}), sid_source: value.source, sid_disagree: value.disagree};
  }
  const message = ({to, cc = [], subject, text} = {}) => Array.isArray(to) && to.length === 1 && address(to[0]) && Array.isArray(cc) && !cc.length &&
    typeof subject === 'string' && subject.trim() && [...subject].length <= 998 && !/[\r\n\0]/.test(subject) &&
    typeof text === 'string' && text.trim() && !text.includes('\0') && new TextEncoder().encode(text).length <= 204800;
  const document_ = () => typeof window.__sparkclawMailDocument === 'string' ? window.__sparkclawMailDocument : '';

  function preflight({account_address} = {}) {
    if (!active) fail('email_network_capability_unavailable');
    ticket = null;
    if (loginVisible()) fail('email_login_required');
    const owner = checked(account_address);
    const refused = reason => ({provider: 'qq_mail', account_address: owner, ready: false, reason});
    if (location.origin !== ORIGIN || location.pathname !== '/home/index') return refused('page_unavailable');
    const session = sid();
    if (!session.sid) return refused('sid_missing');
    if (!language()) return refused('language_unavailable');
    const token = `${++tokens}:${Math.random().toString(36).slice(2) || '0'}`;
    ticket = {token, nonce: document_(), account: owner, expires_at: performance.now() + TICKET_MS};
    return {provider: 'qq_mail', account_address: owner, ready: true, token, template_version: VERSION, drift: drift(session)};
  }

  async function dispatch({account_address, token, ...content} = {}) {
    if (!active) fail('email_network_capability_unavailable');
    const held = ticket; ticket = null; // one use, before any asynchronous step
    const result = {provider: 'qq_mail', template_version: VERSION};
    const refused = reason => ({...result, outcome: 'refused_before_request', reason});
    if (!held || typeof token !== 'string' || held.token !== token || held.expires_at < performance.now() || held.nonce !== document_()) return refused('ticket_invalid');
    let owner;
    try { owner = checked(account_address); } catch { return refused('account_unavailable'); }
    if (owner !== held.account) return refused('account_changed');
    if (!message(content)) return refused('invalid_request');
    const session = sid(), lang = language();
    if (!session.sid) return refused('sid_missing');
    if (!lang) return refused('language_unavailable');
    const zone = qqTimeZone(Date);
    const form = new URLSearchParams();
    for (const [key, value] of [['func', '1'], ['mailid', ''], ['time_zone', zone.time_zone], ['time_zone_dst', zone.time_zone_dst], ['calendar', ''],
      ['subject', content.subject], ['content', qqPlainTextHTML(content.text)], ['is_text', 'false'], ['is_urgent', 'false'], ['is_resume', 'false'],
      ['need_receipt', 'false'], ['from', owner], ['save_to_send', 'true'], ['separated_copy', 'false'], ['to', content.to[0]],
      ['language', lang], ['r', (1e13 * Math.random()).toFixed(0) + Date.now()], ['sid', session.sid]]) form.append(key, value);
    const url = ORIGIN + '/send/sendmail';
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), REQUEST_MS);
    const started = performance.now(), timings = {};
    const unknown = (reason, extra = {}) => ({...result, outcome: 'unknown', reason, ...extra, timings});
    let reply, text;
    try {
      reply = await fetch(url, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: form.toString(),
        credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal});
      text = await readText(reply);
    } catch { timings.request_ms = Math.round(performance.now() - started); return unknown(controller.signal.aborted ? 'timeout' : 'network'); }
    finally { clearTimeout(timer); }
    timings.request_ms = Math.round(performance.now() - started);
    if (reply.status !== 200 || reply.url !== url) return unknown('http_status');
    let value;
    try { if (typeof text !== 'string' || text.length > 1 << 20) throw new Error('size'); value = JSON.parse(text); } catch { return unknown('response_format'); }
    const ret = value?.head?.ret, code = typeof ret === 'number' ? ret : typeof ret === 'string' && /^-?[0-9]{1,9}$/.test(ret) ? Number(ret) : null;
    if (!Number.isSafeInteger(code)) return unknown('response_format');
    const messageid = id(value.body?.messageid) ? value.body.messageid : undefined;
    let same = false;
    try { same = checked(account_address) === held.account; } catch {}
    if (code !== 0) return {...result, outcome: 'provider_code', provider_code: code, timings};
    if (!messageid || !id(value.body?.mailid)) return unknown('response_identifier', messageid ? {messageid} : {});
    if (!same) return unknown('account_after_response', {messageid});
    return {...result, outcome: 'sent', mailid: value.body.mailid, messageid, timings};
  }

  // Pending path only: one bounded search of Sent. QQ's own response Date is
  // the clock; a row older than the dispatch (minus skew) never matches.
  async function lookup({account_address, to, subject, messageid, dispatched_at_ms} = {}) {
    if (!active) fail('email_network_capability_unavailable');
    const owner = checked(account_address), started = performance.now();
    if (!Array.isArray(to) || to.length !== 1 || !address(to[0]) || typeof subject !== 'string' || messageid !== undefined && !id(messageid) ||
        !Number.isSafeInteger(dispatched_at_ms)) fail('invalid_request');
    const recipient = canonical(to[0]);
    const pending = reason => ({provider: 'qq_mail', outcome: 'unknown', reason, timings: {lookup_ms: Math.round(performance.now() - started)}});
    let reason = 'not_found';
    for (;;) {
      try {
        const session = sid();
        if (!session.sid || !language()) { reason = 'sid_missing'; break; }
        const url = ORIGIN + '/list/maillist';
        const body = new URLSearchParams({sid: session.sid, r: String(Math.random()), language: language(), func: '1', dir: '3', dirid: '3',
          sort_type: '1', sort_direction: '1', page_now: '0', page_size: '50', enable_topmail: 'true'});
        const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'},
          body: body.toString(), credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000)});
        const received = Date.now();
        if (response.status !== 200 || response.url !== url) throw new Error('status');
        const parsed = JSON.parse(await readText(response));
        if (checked(account_address) !== owner) fail('email_account_identity_mismatch');
        const rows = parsed?.body?.list;
        if (parsed?.head?.ret !== 0 || !Array.isArray(rows) || rows.length > 50) throw new Error('list');
        const server = Date.parse(response.headers.get('date') || '');
        const offset = Number.isFinite(server) ? server - received : Number.isInteger(parsed.head.time) ? parsed.head.time * 1000 - received : null;
        const exact = row => row?.dirid === 3 && id(row.emailid) && row.subject === subject &&
          Array.isArray(row.senders?.item) && row.senders.item.length === 1 && typeof row.senders.item[0]?.email === 'string' && row.senders.item[0].email.toLowerCase() === owner &&
          Array.isArray(row.receivers?.item) && row.receivers.item.length === 1 && typeof row.receivers.item[0]?.email === 'string' && canonical(row.receivers.item[0].email) === recipient;
        let found;
        if (messageid) found = rows.filter(row => row?.messageid === messageid);
        else if (offset !== null) {
          const bound = (dispatched_at_ms + offset - SKEW_MS) / 1000;
          found = rows.filter(row => Number.isInteger(row?.fromtime) && row.fromtime >= bound && exact(row));
        } else { reason = 'server_time_unavailable'; break; }
        if (found.length > 1) { reason = 'ambiguous'; break; }
        if (found.length === 1 && exact(found[0]) && rows.filter(row => row?.emailid === found[0].emailid).length === 1) {
          return {provider: 'qq_mail', outcome: 'sent', provider_message_id: found[0].emailid,
            proof: {source: 'qq_sent_list_v1', provider_message_id: found[0].emailid, ...(messageid ? {response_message_id: messageid} : {}), folder: 'sent', fresh: true},
            timings: {lookup_ms: Math.round(performance.now() - started)}};
        }
        if (found.length === 1) { reason = 'mismatch'; break; }
        reason = 'not_found';
      } catch (error) {
        if (error?.code === 'email_account_identity_mismatch') throw error;
        reason = 'lookup_failed';
      }
      const left = LOOKUP_MS - (performance.now() - started);
      if (left <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, left)));
    }
    return pending(reason);
  }

  return {preflight, dispatch, lookup, dispose() { active = false; ticket = null; }};
}
