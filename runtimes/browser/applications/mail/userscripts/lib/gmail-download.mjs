// The native "Download original" link uses attid=0. view=om is an HTML
// overview, not RFC822 bytes. Account and ID come from proved list evidence.
export function gmailOriginalURL({id,row,request}) {
  const source=request?.url,origin=globalThis.location?.origin;
  if(!row?.native_message_id||!source||source.origin!==origin||!/^[a-f0-9]{1,32}$/u.test(id))return null;
  const account=/^\/sync\/u\/(\d+)\/i\/bv$/u.exec(source.pathname)?.[1];
  if(account===undefined)return null;
  const url=new URL(`/mail/u/${account}/`,origin);
  url.searchParams.set('view','att');url.searchParams.set('th',id);url.searchParams.set('attid','0');
  url.searchParams.set('disp','comp');url.searchParams.set('safe','1');url.searchParams.set('zw','');
  return url;
}
