// Pure classification of native notification envelopes. A change is a hint to
// reconcile with Reader, never an acquired mail or a coverage watermark.
// No subject, address, body, credential or provider ID is returned to the host.
export function classifyMailNotification(provider, channel, value, state = new Map()) {
  const ignore = {decision: 'ignore'};
  const unknown = {decision: 'unknown'};
  if (provider === 'qq_mail' && channel === 'qq') {
    if (value?.cmd === 0) return ignore;
    if (value?.cmd !== 1 || value.scene !== 'notify' || value.encoding !== 'base64' || typeof value.content !== 'string') return unknown;
    let data;
    try { data = JSON.parse(atob(value.content)); } catch { return unknown; }
    if (data?.type === '0' && typeof data.mid === 'string' && /^[A-Za-z0-9_+=:.\/~\-]{1,1024}$/.test(data.mid)) {
      return {decision: 'change', reason: 'qq_inbound_envelope', key: data.mid};
    }
    return unknown;
  }
  if (provider === 'gmail' && channel === 'gmail') {
    if (!Array.isArray(value)) return unknown;
    // BrowserChannel acknowledgements are scalar arrays. Connection records,
    // subscription acknowledgements and topic keepalives carry no change body.
    if (value.every(item => Number.isSafeInteger(item))) return ignore;
    let change = false;
    for (const packet of value) {
      if (!Array.isArray(packet) || !Number.isSafeInteger(packet[0]) || !Array.isArray(packet[1])) return unknown;
      if (packet[1][0] === 'c' || packet[1][0] === 'noop') continue;
      const topics = packet[1]?.[0]?.[0];
      if (!Array.isArray(topics)) continue;
      for (const topic of topics) {
        if (!Array.isArray(topic) || typeof topic[0] !== 'string' || !Array.isArray(topic[1])) return unknown;
        const body = topic[1][1];
        if (body == null) continue;
        if (!Array.isArray(body) || !body.length || !body.every(batch => Array.isArray(batch))) return unknown;
        change = true;
      }
    }
    return change ? {decision: 'change', reason: 'gmail_topic_invalidation'} : ignore;
  }
  if (provider === 'outlook') {
    const signature = row => {
      const id = row?.ConversationId?.Id;
      const delivery = row?.LastDeliveryTime;
      if (typeof id !== 'string' || !id || id.length > 2048 || typeof delivery !== 'string' || !Number.isFinite(Date.parse(delivery))) return null;
      const ids = row.ItemIds;
      if (!Array.isArray(ids) || ids.length > 128 || !ids.every(item => typeof item?.Id === 'string' && item.Id.length < 512)) return null;
      const stamp = JSON.stringify([delivery, row.MessageCount, ids.map(item => item.Id).sort()]);
      return stamp.length <= 32768 ? [id, stamp] : null;
    };
    const remember = entry => {
      if (!entry) return;
      const previous = state.get(entry[0]);
      state.bytes = (state.bytes ?? 0) - (previous === undefined ? 0 : entry[0].length + previous.length);
      state.set(entry[0], entry[1]); state.bytes += entry[0].length + entry[1].length;
      while (state.size > 512 || state.bytes > 131072) {
        const key = state.keys().next().value; state.bytes -= key.length + state.get(key).length; state.delete(key);
      }
    };
    if (channel === 'outlook_rows') {
      if (!Array.isArray(value)) return unknown;
      for (const edge of value.slice(0, 512)) remember(signature(edge?.node));
      return ignore;
    }
    if (channel !== 'outlook_subscription' || value?.operation !== 'subscribeToRowNotifications') return ignore;
    const message = value.message;
    if (message?.type !== 'APPLY') return unknown;
    const row = message.argumentList?.[1]?.value?.data?.subscribeToRowNotifications;
    if (!row) return unknown;
    if (row.EventType === 'Reload' || row.EventType === 'RowDeleted') return ignore;
    if (!['RowAdded', 'RowModified'].includes(row.EventType)) return unknown;
    let entry = signature(row.Conversation);
    if (!entry && row.Item) {
      const item = row.Item;
      if (item.IsDraft === true || item.MessageToMe === false && item.MessageCcMe === false) return ignore;
      if (typeof item.ItemId?.Id === 'string' && item.ItemId.Id.length < 2048 &&
          typeof item.DateTimeReceived === 'string' && Number.isFinite(Date.parse(item.DateTimeReceived)) &&
          (item.MessageToMe === true || item.MessageCcMe === true)) {
        entry = ['item:' + item.ItemId.Id, item.DateTimeReceived];
      }
    }
    if (!entry) return unknown;
    const before = state.get(entry[0]); remember(entry);
    if (before === entry[1]) return ignore;
    if (row.EventType === 'RowModified' && before === undefined) return unknown;
    return {decision: 'change', reason: 'outlook_delivery_change'};
  }
  return unknown;
}
