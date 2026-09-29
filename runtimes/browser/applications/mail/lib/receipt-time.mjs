// RFC3339 checkpoints must retain their fractional precision, including when
// callers supply a numeric timezone offset rather than canonical UTC.
export function receiptTimeNanos(value) {
  const match=typeof value==='string'&&/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if(!match)return null;
  const seconds=Date.parse(match[1]+match[3]);
  const offset=match[3]==='Z'?0:(match[3][0]==='-'?-1:1)*(Number(match[3].slice(1,3))*60+Number(match[3].slice(4,6)));
  if(!Number.isFinite(seconds)||new Date(seconds+offset*60000).toISOString().slice(0,19)!==match[1])return null;
  return BigInt(seconds)*1000000n+BigInt((match[2]||'').padEnd(9,'0'));
}
