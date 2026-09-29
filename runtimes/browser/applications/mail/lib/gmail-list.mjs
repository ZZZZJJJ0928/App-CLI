// Observed Gmail /sync/u/<account>/i/bv response contract. Unknown shapes
// supply no evidence. Only message identity/read labels leave the page.
export function parseGmailList(value, includeThreads = false) {
  const batches = value?.[19];
  if (!Array.isArray(batches)) return [];
  const result = [];
  for (const batch of batches) {
    if (!Array.isArray(batch?.[1])) continue;
    for (const container of batch[1]) {
      const thread = container?.[0];
      if (!Array.isArray(thread) || !/^(?:thread-f:\d+|thread-a:r-?\d+)$/u.test(thread[3]) || !Array.isArray(thread[4])) continue;
      const messages = thread[4];
      if ((!includeThreads && messages.length !== 1) || messages.length < 1 || messages.length > 1000) continue;
      const members=[];
      for (const message of messages) {
      const id = message?.[55], labels = message?.[10];
      if (!/^(?:msg-f:\d+|msg-a:r-?\d+)$/u.test(message?.[0]) || !/^[a-f0-9]{1,32}$/u.test(id) ||
          !Array.isArray(labels) || !labels.every(label => typeof label === 'string')) continue;
      if (thread[3].startsWith('thread-f:')) {
        if (!message[0].startsWith('msg-f:') || BigInt(`0x${id}`).toString() !== message[0].slice(6) || !includeThreads && thread[3].slice(9) !== message[0].slice(6)) continue;
      } else if (!message[0].startsWith('msg-a:')) continue;
      members.push({ provider_message_id: id, provider_thread_id: thread[3],
        unread: labels.includes('^u'), inbox: labels.includes('^i'), draft: labels.includes('^r'),
        ...(includeThreads ? {sent:labels.includes('^f'),observed_message_count:messages.length,
          // Observed internal receipt timestamp: the pinned original's Received
          // trace agrees at the second, and RFC Date is independently earlier.
          ...(Number.isSafeInteger(message[6]) && message[6]>=946684800000 && message[6]<=Date.now()+300000 ? {received_at:new Date(message[6]).toISOString()} : {})} : {}) });
      }
      if(members.length===messages.length && new Set(members.map(member=>member.provider_message_id)).size===members.length) result.push(...members);
    }
  }
  return result;
}

// Received-only network scans must not discard inbound siblings merely because
// a sent reply in the same native thread uses Gmail's alternate msg-a identity.
// Each admitted inbound member still passes the original identity/receipt parser.
export function parseGmailReceivedList(value) {
  const rows=[];
  for(const batch of value?.[19]??[])for(const container of batch?.[1]??[]) {
    const thread=container?.[0];
    if(!Array.isArray(thread?.[4]))continue;
    for(const message of thread[4]) {
      const labels=message?.[10];
      if(Array.isArray(labels)&&labels.every(label=>typeof label==='string')&&(labels.includes('^r')||labels.includes('^f')))continue;
      const individual=[...thread];individual[4]=[message];
      const source=[];source[19]=[[null,[[individual]]]];
      for(const row of parseGmailList(source,true))rows.push({...row,native_message_id:message[0]});
    }
  }
  return rows;
}
