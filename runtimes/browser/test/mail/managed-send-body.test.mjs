import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {managedSendDOM} from '../../applications/mail/lib/managed-send-dom.mjs';
import {verifyManagedDraft} from '../../applications/mail/lib/managed-send.mjs';

const text = value => ({nodeType:3,textContent:value});
const element = (tagName, childNodes=[], attributes=[]) => ({nodeType:1,tagName,childNodes,attributes});
const line = value => element('DIV', value === '' ? [element('BR')] : [text(value)]);
const visible = extra => ({isConnected:true,getBoundingClientRect:()=>({width:100,height:30}),getAttribute:()=>null,...extra});
function environment(nodes, rendered='rendered fallback') {
  const body=visible({childNodes:nodes,innerText:rendered});
  const root=visible({querySelector:selector=>selector.includes('subject')?{value:'Synthetic subject'}:null,querySelectorAll:()=>[]});
  return {document:{querySelectorAll:()=>[]},getComputedStyle:node=>({visibility:'visible',display:'block',...node.style}),__sparkclawManagedMail:{root,body,send:visible({}),mode:'compose'},crypto:crypto.webcrypto,TextEncoder,Uint8Array};
}
const readBody = (nodes, rendered) => vm.runInNewContext(`(${managedSendDOM.toString()})('gmail','readback',{})`, environment(nodes,rendered)).body;

test('native Chromium line structure preserves empty lines, edges and every text byte',()=>{
  for(const [name,nodes,expected] of [
    ['one break',[text('first'),line('second')],'first\nsecond'],
    ['empty line',[text('first'),line(''),line('second')],'first\n\nsecond'],
    ['leading break',[line(''),line('first')],'\nfirst'],
    ['leading empty lines',[line(''),line(''),line('first')],'\n\nfirst'],
    ['trailing break',[text('first'),line('')],'first\n'],
    ['trailing empty lines',[text('first'),line(''),line('')],'first\n\n'],
    ['three paragraphs',[text('一段'),line(''),line('二段'),line(''),line('三段'),line('')],'一段\n\n二段\n\n三段\n'],
    ['spaces remain bytes',[text('  α 😀 '),line('\u00a0中文\t ')],'  α 😀 \n\u00a0中文\t '],
    ['split text nodes',[text('first'),text(' line'),element('DIV',[text('second'),text(' line')])],'first line\nsecond line'],
  ]) assert.equal(readBody(nodes),expected,name);
});

test('unrecognized or decorated editor markup keeps the rendered-text path',()=>{
  for(const nodes of [
    [],[text('literal')],[element('P',[text('paragraph')])],
    [text('first'),element('DIV',[element('BR')],[{name:'hidden'}])],
    [text('first'),element('DIV',[element('BR',[],[{name:'style'}])])],
    [text('first'),element('DIV',[element('SPAN',[text('nested')])])],
    [text('first'),element('DIV',[])],
    [text('first'),line('second'),text('tail')],
    [text('first'),element('DIV',[element('BR'),element('BR')])],
    [text('first'),{...line('second'),style:{display:'inline'}}],
    [text('first'),{...line('second'),style:{visibility:'hidden'}}],
  ]) assert.equal(readBody(nodes,'exact rendered fallback'),'exact rendered fallback');
});

test('strict draft verification accepts exact line structure but rejects lost, extra or changed body bytes',async t=>{
  const writes=[];
  t.mock.method(process.stderr,'write',chunk=>{writes.push(String(chunk));return true;});
  const request={account_address:'owner@example.invalid',message:{to:[],cc:[],subject:'Synthetic subject',body:{format:'text',content:'第一段\n\n第二段\n'}}};
  const correct=[text('第一段'),line(''),line('第二段'),line('')];
  for(const [name,nodes,expectedResult] of [
    ['exact',correct,true],
    ['missing blank line',[text('第一段'),line('第二段'),line('')],false],
    ['extra blank line',[text('第一段'),line(''),line(''),line('第二段'),line('')],false],
    ['missing trailing newline',[text('第一段'),line(''),line('第二段')],false],
    ['changed content',[text('第一段'),line(''),line('已改变'),line('')],false],
    ['nonbreaking space remains different',[text('第一段'),line(''),line('第二段\u00a0'),line('')],false],
  ]) {
    const context=environment(nodes);
    const tab={inspect:async code=>code.includes('function providerAccountDOM(')?{origin:'https://mail.google.com/mail/u/0/',result:{url:'https://mail.google.com/mail/u/0/',account_hash:crypto.createHash('sha256').update(request.account_address).digest('hex')}}:{result:await vm.runInNewContext(`(${code})()`,context)}};
    if(expectedResult)await verifyManagedDraft(tab,'gmail',request);
    else await assert.rejects(verifyManagedDraft(tab,'gmail',request),{code:'email_draft_fields_unverified'},name);
  }
  assert.equal(writes.length,5);
  for(const output of writes){
    const diagnostic=JSON.parse(output);
    assert.deepEqual(diagnostic.fields,['body']);
    assert.equal(diagnostic.event,'mail_draft_validation_failed');
    assert.equal(diagnostic.body_length_expected,request.message.body.content.length);
    assert.equal(Number.isSafeInteger(diagnostic.body_length_actual),true);
    assert.match(diagnostic.body_hash_expected,/^[a-f0-9]{64}$/u);
    assert.match(diagnostic.body_hash_actual,/^[a-f0-9]{64}$/u);
    assert.equal(output.includes('第一段'),false);
    assert.equal(output.includes(request.account_address),false);
  }
});
