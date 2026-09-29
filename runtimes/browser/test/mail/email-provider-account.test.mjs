import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {providerAccountDOM,READ_PROVIDERS} from '../../applications/mail/lib/provider-account.mjs';

function account(provider,selectors={}) {
  const document={querySelector:selector=>selectors[selector]?.[0]??null,querySelectorAll:selector=>selectors[selector]??[]};
  return vm.runInNewContext(`(${providerAccountDOM.toString()})(${JSON.stringify(provider)})`,{
    document,location:{href:READ_PROVIDERS[provider].url},getComputedStyle:()=>({display:'block',visibility:'visible'}),
  });
}
function node(text='',attrs={},children=[]) {
  return {isConnected:true,textContent:text,getAttribute:key=>attrs[key]??null,
    getBoundingClientRect:()=>({width:10,height:10}),querySelectorAll:()=>children};
}
test('shared send account evidence preserves all provider identities without mail DOM',()=>{
  assert.equal(account('gmail',{'[aria-label^="Google Account:"]':[node('',{'aria-label':'Google Account: Owner owner@example.test'})]}).account_address,'owner@example.test');
  assert.equal(account('qq_mail',{'.frame-header .profile-user-info .user-email':[node('owner@example.test')]}).account_address,'owner@example.test');
  const root=node('',{title:'owner@example.test'},[node('owner@example.test')]);
  assert.equal(account('outlook',{'[role="tree"] [role="treeitem"][aria-level="1"][data-folder-name]':[root]}).account_address,'owner@example.test');
});
test('shared account evidence never fabricates absent or ambiguous identity',()=>{
  for(const provider of Object.keys(READ_PROVIDERS))assert.equal(account(provider).account_address,'');
  assert.equal(account('qq_mail',{'.login-page':[node()]}).error,'email_login_required');
  const roots=['one@example.test','two@example.test'].map(value=>node('',{title:value},[node(value)]));
  assert.equal(account('outlook',{'[role="tree"] [role="treeitem"][aria-level="1"][data-folder-name]':roots}).account_address,'');
});
