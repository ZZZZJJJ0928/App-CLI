// Additive delivery metadata never changes the capture/account identity.
export function accountAddressMetadata(value = {}) {
  if(value===null)return {};
  const address=item=>typeof item==='string'&&item.length<=320&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item)&&item===item.toLowerCase();
  const result={};
  const fail=()=>{throw Object.assign(new Error('email_account_address_unqualified'),{code:'email_account_address_unqualified'});};
  if(Object.hasOwn(value,'delivery_address')!==Object.hasOwn(value,'account_aliases'))fail();
  if(Object.hasOwn(value,'account_aliases')) {
    const aliases=value.account_aliases;
    if(!Array.isArray(aliases)||aliases.length<1||aliases.length>100||aliases.some(item=>!address(item))||new Set(aliases).size!==aliases.length)fail();
    result.account_aliases=[...aliases];
  }
  if(Object.hasOwn(value,'delivery_address')) {
    if(!address(value.delivery_address)||!result.account_aliases?.includes(value.delivery_address))fail();
    result.delivery_address=value.delivery_address;
  }
  return result;
}
