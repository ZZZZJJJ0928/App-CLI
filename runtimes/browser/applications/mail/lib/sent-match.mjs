// This function is also embedded in the installed Reader. The public selector
// contains literals, never a provider query or a message/account identity.
export function sentMatchQuery(match) {
  const fail=()=>{throw Object.assign(new Error('invalid_request'),{code:'invalid_request'});};
  const keys=['folder','subject','recipient','interval_start','interval_end'];
  if(!match||Array.isArray(match)||typeof match!=='object'||Object.keys(match).length!==keys.length||
      keys.some(key=>!Object.hasOwn(match,key))||match.folder!=='sent')fail();
  const {subject,recipient,interval_start:start,interval_end:end}=match;
  if(typeof subject!=='string'||!subject.length||new TextEncoder().encode(subject).length>512||/[\x00-\x1f\x7f"\\]/u.test(subject))fail();
  if(typeof recipient!=='string'||recipient.length>254||recipient.split('@')[0].length>64||recipient.includes('..')||
      !/^[A-Za-z0-9]+(?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(recipient))fail();
  const instant=value=>{
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value))fail();
    const parsed=Date.parse(value);
    if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==value.replace('Z','.000Z'))fail();
    return parsed;
  };
  const from=instant(start),until=instant(end);
  if(until<=from||until-from>86400000)fail();
  // Quote both literals; reject quote/backslash above instead of guessing the
  // provider's escape grammar. URI encoding belongs to config.search. Search
  // matches remain candidates: Gateway checks exact decoded RFC822 headers.
  return `in:sent to:"${recipient}" subject:"${subject}" after:${from/1000-1} before:${until/1000}`;
}
