// Serialized into the QQ Reader. An explicitly armed, independently confirmed
// DOM compose may teach one page-private replay. No provider success schema is
// qualified yet: every dispatched prototype outcome remains unknown.
export function installQQSendPrototype({account, fetch, readText, responseShape}) {
  const fields = 'calendar content from func is_resume is_text is_urgent language mailid need_receipt r save_to_send separated_copy sid subject time_zone time_zone_dst to'.split(' ').sort();
  let active = true, arm = null, candidate = null, template = null, seen = 0, pending = null, expiry = null;
  const clear = () => { arm = candidate = template = null; clearTimeout(expiry); expiry = null; };
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
  function observe({session, method, url, headers, body, status, responseURL}) {
    if (!active || !arm || session !== arm || performance.now() > arm.until) return;
    let u; try { u = new URL(url, location.href); } catch { return; }
    if (u.origin !== location.origin || u.pathname !== '/send/sendmail') return;
    candidate = template = null;
    if (++seen !== 1 || method?.toUpperCase() !== 'POST' || status !== 200 || responseURL !== u.href ||
        u.username || u.password || u.hash || typeof body !== 'string' || body.length > 1 << 20) return;
    const form = new URLSearchParams(body);
    if ([...form.keys()].sort().join(',') !== fields.join(',') || [...u.searchParams.keys()].some(key => !['sid','func','r'].includes(key))) return;
    // Unknown flags, extra fields (including bcc/attachments/reply metadata),
    // resumed drafts and non-default send modes cannot enter this prototype.
    if (['is_resume','is_urgent','need_receipt','separated_copy'].some(key => form.get(key) !== '0') ||
        form.get('save_to_send') !== '1' || form.get('calendar') !== '' || !['0','1'].includes(form.get('is_text')) ||
        !form.get('sid') || !/^[A-Za-z0-9_]{1,32}$/.test(form.get('func') || '')) return;
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
    candidate = {url: u.href, headers: copied, form, owner, to, subject: form.get('subject'), until: arm.until};
  }
  function confirm({account_address, to, subject} = {}) {
    const owner = checked(account_address), value = candidate;
    candidate = null; arm = null;
    if (!value || seen !== 1 || value.until < performance.now() || value.owner !== owner || !Array.isArray(to) || to.length !== 1 ||
        to[0] !== value.to.email || subject !== value.subject) return false;
    // Keep only template/session fields. Prior recipients, subject, content and
    // draft identity are discarded, even while the page remains alive.
    for (const key of ['to','subject','content','mailid']) value.form.set(key, '');
    value.to = {named: value.to.named, tail: value.to.tail}; delete value.subject;
    template = value;
    return true;
  }
  function ready({account_address} = {}) {
    const owner = checked(account_address);
    if (template && (template.until < performance.now() || template.owner !== owner)) template = null;
    return {provider: 'qq_mail', account_address: owner, ready: Boolean(template)};
  }
  async function send({account_address, to, cc = [], subject, text} = {}) {
    const owner = checked(account_address);
    if (!ready({account_address}).ready) fail('email_network_template_unlearned');
    if (!Array.isArray(to) || to.length !== 1 || !address(to[0]) || !Array.isArray(cc) || cc.length || typeof subject !== 'string' ||
        !subject.trim() || [...subject].length > 998 || /[\r\n\0]/.test(subject) || typeof text !== 'string' || !text.trim() || text.includes('\0') || new TextEncoder().encode(text).length > 204800) fail('invalid_request');
    const value = template; clear(); // consumed before any asynchronous dispatch
    const form = new URLSearchParams(value.form);
    form.set('to', (value.to.named ? `"${to[0]}"<${to[0]}>` : to[0]) + value.to.tail);
    form.set('subject', subject);
    const escape = line => line.replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
    form.set('content', form.get('is_text') === '1' ? text : text.split(/\r?\n/).map(line => `<div>${line ? escape(line) : '<br>'}</div>`).join(''));
    form.set('r', String(Math.random()));
    const url = new URL(value.url); if (url.searchParams.has('r')) url.searchParams.set('r', form.get('r'));
    const controller = new AbortController(); pending = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    const result = {provider:'qq_mail', account_address:owner, outcome:'unknown'};
    try {
      const reply = await fetch(url.href, {method:'POST', headers:value.headers, body:form.toString(), credentials:'same-origin', redirect:'error', signal:controller.signal});
      const response = await readText(reply);
      checked(account_address);
      return {...result, reason:'response_proof_unqualified', response_shape:responseShape(response)};
    } catch { return {...result, reason:'transport_or_identity'}; }
    finally { clearTimeout(timer); pending = null; }
  }
  return {observe, confirm, ready, send,
    arm(session) { clear(); arm = session; seen = 0; if(session)expiry = setTimeout(clear, Math.max(0, session.until - performance.now())); },
    dispose() { active = false; clear(); pending?.abort(); }
  };
}
