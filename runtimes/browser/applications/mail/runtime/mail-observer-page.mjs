// Runs only in the Controller-owned top-level mailbox document. Transport data
// stays here; the binding receives bounded structural evidence and hint kinds.
export function installMailObserverPage(options, classify) {
  if (window.top !== window || !options.origins.includes(location.origin) || window.__sparkclawMailObserver) return;
  // Bound pending cross-process promises as well as network parser buffers.
  // A sequence gap is visible to the host and forces reconciliation.
  let inFlight = 0;
  const emit = value => {
    if (inFlight >= 4) return;
    try {
      inFlight++;
      void window.__sparkclawMailObservation(value).catch(() => {}).finally(() => { inFlight--; });
    } catch { inFlight--; }
  };
  const doc = crypto.randomUUID();
  let sequence = 0, active = options.dormant !== true, unknownReported = false;
  const seenHints = new Set(), classifierState = new Map();
  const classifyRecord = (channel, value) => {
    if (!active || !classify) return;
    const result = classify(options.provider, channel, value, classifierState);
    if (result.decision === 'unknown' && !unknownReported) {
      unknownReported = true; report('degraded', {reason: 'unclassified_notification'});
    }
    if (result.decision !== 'change') return;
    if (result.key && seenHints.has(result.key)) return;
    if (result.key) { seenHints.add(result.key); if (seenHints.size > 512) seenHints.delete(seenHints.values().next().value); }
    report('mailbox_changed', {reason: result.reason});
  };
  let shapeNodes = 0;
  const shape = (value, depth = 0, key = '') => {
    if (depth === 0) shapeNodes = 0;
    if (++shapeNodes > 512) return 'node_limit';
    if (depth > 18) return 'depth_limit';
    if (value === null) return null;
    if (Array.isArray(value)) return value.slice(0, 24).map(item => shape(item, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 32).map(([name, item]) => [
      /^[A-Za-z_][A-Za-z0-9_]{0,50}$/.test(name) ? name : 'dynamic_key', shape(item, depth + 1, name),
    ]));
    if (typeof value === 'number') return Number.isSafeInteger(value) && Math.abs(value) < 10000 ? value : 'number';
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (['type', 't', 'd', 'g', 'u', 'z', 'sound'].includes(key) && /^\d{1,4}$/.test(value)) return value;
      if (['noop', 'c', 'stop', 'close', 'mail_148', 'mail_149', 'gzip', 'base64', 'utf8', '^i', '^u', '^f', '^r', '^all'].includes(value)) return value;
      if (['type', 'Type', 'EventType', 'NotificationType', '__type', 'event', 'action', 'kind', 'encoding', 'scene', 'EventName'].includes(key) && /^[A-Za-z0-9_:#.-]{1,80}$/.test(value)) return value;
      if (options.provider === 'gmail' && value.length && value.length < 8192 && depth < 10) {
        try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return {json: shape(parsed, depth + 1)}; } catch {}
        try { const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/')); const parsed = JSON.parse(decoded); if (parsed && typeof parsed === 'object') return {base64_json: shape(parsed, depth + 1)}; } catch {}
        return {string_length: value.length};
      }
      return value === '' ? '' : 'string';
    }
    return typeof value;
  };
  const accountOK = () => {
    try {
      const reader = window.SparkClawMailReader;
      if (reader?.provider !== options.provider || reader.version !== '0.2.0') return false;
      if (typeof reader.checkAccount === 'function') reader.checkAccount({account_address: options.account});
      else if (!options.fastAccount) reader.snapshot({account_address: options.account, interval_start: '2000-01-01T00:00:00Z', interval_end: '2000-01-01T00:00:01Z'});
      else return false;
      return true;
    } catch { return false; }
  };
  const report = (kind, details = {}) => {
    if (!active || kind === 'evidence' && !options.evidence) return;
    emit({document: doc, sequence: ++sequence, kind, account_ok: accountOK(), ...details});
  };
  const record = (channel, raw) => {
    if (typeof raw !== 'string' || raw.length > 65536) { report('degraded', {reason: 'frame_limit'}); return; }
    let value;
    try { value = JSON.parse(raw); } catch {
      report('evidence', {channel, size: raw.length, shape: 'non_json'});
      return;
    }
    if (options.evidence) report('evidence', {channel, size: raw.length, shape: shape(value)});
    classifyRecord(channel, value);
    if (options.evidence && channel === 'qq' && typeof value.content === 'string') {
      try {
        let decoded = value.content;
        try { JSON.parse(decoded); } catch { decoded = atob(decoded); }
        report('evidence', {channel: 'qq_content', size: decoded.length, shape: shape(JSON.parse(decoded))});
      } catch { report('evidence', {channel: 'qq_content', shape: 'opaque'}); }
    }
  };
  const NativeSocket = window.WebSocket;
  const Socket = class extends NativeSocket {
    constructor(url, ...args) {
      super(url, ...args);
      let endpoint; try {endpoint = new URL(url, location.href);} catch {return;}
      if (endpoint.origin !== 'wss://wx.mail.qq.com' || endpoint.pathname !== '/socket') return;
      this.addEventListener('open', () => report('channel_open', {channel: 'qq'}));
      this.addEventListener('message', event => record('qq', event.data));
      this.addEventListener('close', () => report('channel_closed', {channel: 'qq'}));
      this.addEventListener('error', () => report('degraded', {reason: 'channel_error'}));
    }
  };
  if (options.provider === 'qq_mail') window.WebSocket = Socket;
  const parser = channel => {
    let buffer = '', failed = false;
    return chunk => {
      if (failed || !active) return;
      buffer += chunk;
      if (buffer.length > 131072) { failed = true; buffer = ''; report('degraded', {reason: 'buffer_limit'}); return; }
      if (channel === 'gmail') {
        for (let count = 0; count < 128; count++) {
          buffer = buffer.replace(/^\n/, '');
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          const header = buffer.slice(0, newline);
          if (!/^\d{1,5}$/.test(header)) { failed = true; report('degraded', {reason: 'framing'}); buffer = ''; return; }
          const size = Number(header);
          if (size > 65536) { failed = true; buffer = ''; report('degraded', {reason: 'frame_limit'}); return; }
          if (buffer.length < newline + 1 + size) return;
          record(channel, buffer.slice(newline + 1, newline + 1 + size));
          buffer = buffer.slice(newline + 1 + size);
        }

      }
    };
  };
  const channelOf = raw => {
    try {
      const url = new URL(raw, location.href);
      if (options.provider === 'gmail' && ['https://signaler-pa.clients6.google.com', location.origin].includes(url.origin) && url.pathname.endsWith('/punctual/multi-watch/channel')) return 'gmail';

    } catch {}
    return null;
  };
  const nativeOpen = XMLHttpRequest.prototype.open, nativeSend = XMLHttpRequest.prototype.send;
  const channels = new WeakMap();
  const open = function(method, url, ...args) { channels.set(this, channelOf(url)); return nativeOpen.call(this, method, url, ...args); };
  const send = function(...args) {
    const channel = channels.get(this);
    if (channel) {
      let offset = 0;
      const consume = parser(channel);
      report('channel_open', {channel});
      const progress = () => { try {
        const body = this.responseText;
        if (typeof body !== 'string' || body.length <= offset) return;
        consume(body.slice(offset)); offset = body.length;
      } catch {} };
      this.addEventListener('progress', progress);
      this.addEventListener('loadend', () => { progress(); this.removeEventListener('progress', progress); report('channel_closed', {channel}); }, {once: true});
    }
    return nativeSend.apply(this, args);
  };
  if (options.provider === 'gmail') {XMLHttpRequest.prototype.open = open; XMLHttpRequest.prototype.send = send;}
  // Qualification evidence for Outlook's worker-delivered subscriptions. Never
  // consume, acknowledge, replace or stop propagation of the site's messages.
  const NativeWorker = window.Worker, NativeChannel = window.MessageChannel;
  let ObserverWorker, ObserverChannel;
  if (options.provider === 'outlook') {
    const subscriptions = new Map();
    let workerSamples = 0;
    const sample = (channel, value) => {
      if (!active) return;
      if (!value || value.type === 'RAW' && value.value === undefined) return;
      if (value?.type === 'APPLY' && value.path?.length === 0) return;
      const id = value?.argumentList?.[0]?.value;
      const rows = value?.argumentList?.[1]?.value?.data?.conversationRows?.edges;
      if (rows) classifyRecord('outlook_rows', rows);
      if (subscriptions.has(id)) {
        const operation = subscriptions.get(id);
        classifyRecord('outlook_subscription', {operation, message: value});
        if (options.evidence) report('evidence', {channel: 'outlook_subscription', shape: {operation, message: shape(value)}});
        return;
      }
      if (options.evidence && workerSamples++ < 160) report('evidence', {channel, shape: shape(value)});
    };
    if (NativeWorker) window.Worker = ObserverWorker = class extends NativeWorker {
      constructor(...args) { super(...args); this.addEventListener('message', event => sample('outlook_worker_result', event.data)); }
      postMessage(value, ...args) {
        const operation = value?.argumentList?.[0]?.value?.operationName;
        const id = value?.argumentList?.[0]?.value?.requestId;
        if (typeof operation === 'string' && operation.startsWith('subscribeTo') &&
            (Number.isSafeInteger(id) || typeof id === 'string' && id.length < 128) && subscriptions.size < 64) subscriptions.set(id, operation);
        if (options.evidence && typeof operation === 'string' && /^[A-Za-z]{1,80}$/.test(operation)) report('evidence', {channel: 'outlook_worker_operation', shape: {operation}});
        return super.postMessage(value, ...args);
      }
    };
    if (NativeChannel) window.MessageChannel = ObserverChannel = class extends NativeChannel {
      constructor() {super(); for (const port of [this.port1, this.port2]) port.addEventListener('message', event => sample('outlook_port', event.data));}
    };
  }
  const heartbeat = setInterval(() => report('liveness'), 15000);
  Object.defineProperty(window, '__sparkclawMailObserver', {value: Object.freeze({
    activate() {
      if (active) return true;
      active = true;
      report('document');
      return true;
    },
    suspend() { active = false; },
    dispose() { active = false; clearInterval(heartbeat);
      if (window.Worker === ObserverWorker) window.Worker = NativeWorker;
      if (window.MessageChannel === ObserverChannel) window.MessageChannel = NativeChannel;
      if (window.WebSocket === Socket) window.WebSocket = NativeSocket;
      if (XMLHttpRequest.prototype.open === open) XMLHttpRequest.prototype.open = nativeOpen;
      if (XMLHttpRequest.prototype.send === send) XMLHttpRequest.prototype.send = nativeSend;
    },
  })});
  report('document');
}
