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

test('body diagnostics identify fixed fallback branches without changing text or copying attribute values',()=>{
 for(const [reason,nodes,extra] of [
  ['no_block_lines',[],{}],
  ['root_node_type',[{nodeType:8,textContent:'private comment'}],{top_other_node:1}],
  ['root_element',[element('P',[text('private text')])],{top_p:1}],
  ['root_element',[element('SPAN',[text('private text')])],{top_span:1}],
  ['trailing_text',[text('first'),line('second'),text('private tail')],{top_text:2,top_div:1}],
  ['block_attributes',[text('first'),element('DIV',[text('second')],[{name:'title',value:'private account@example.invalid'}])],{attributed_divs:1,div_attributes:1}],
  ['block_display',[text('first'),{...line('second'),style:{display:'inline'}}],{block_display:'other',block_visibility:'visible'}],
  ['block_visibility',[text('first'),{...line('second'),style:{visibility:'hidden'}}],{block_display:'block',block_visibility:'hidden'}],
  ['placeholder_attributes',[text('first'),element('DIV',[element('BR',[],[{name:'title',value:'private URL'}])])],{br_attributes:1}],
  ['line_markup',[text('first'),element('DIV',[element('SPAN',[text('private text')])])],{}],
 ]){
  const result=vm.runInNewContext(`(${managedSendDOM.toString()})('gmail','readback',{})`,environment(nodes,'unchanged rendered text'));
  assert.equal(result.body,'unchanged rendered text');assert.equal(result.body_diagnostic.mode,'rendered');assert.equal(result.body_diagnostic.reason,reason);
  for(const [key,value]of Object.entries(extra))assert.equal(result.body_diagnostic[key],value);
  assert.doesNotMatch(JSON.stringify(result.body_diagnostic),/private|account|title|URL|unchanged/);
 }
 const nodes=[text('first'),line(''),line('last'),line('')],context=environment(nodes);
 // Marking the root control does not decorate its child line nodes.
 context.__sparkclawManagedMail.body.attributes=[{name:'data-sc-mail-control',value:'body'}];
 const result=vm.runInNewContext(`(${managedSendDOM.toString()})('gmail','readback',{})`,context);
 assert.equal(result.body,'first\n\nlast\n');assert.equal(result.body_diagnostic.mode,'native_lines');assert.equal(result.body_diagnostic.empty_lines,2);
 const large=vm.runInNewContext(`(${managedSendDOM.toString()})('gmail','readback',{})`,environment(Array.from({length:1001},()=>line('text'))));
 assert.equal(large.body_diagnostic.top_nodes,1000);assert.equal(large.body_diagnostic.top_div,1000);assert.equal(large.body_diagnostic.block_lines,1000);
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
    assert.equal(diagnostic.body_readback.mode,'native_lines');
    assert.equal(output.includes('第一段'),false);
    assert.equal(output.includes(request.account_address),false);
  }
});

test('strict body mismatch logs only bounded diagnostic fields and survives diagnostic output failure',async t=>{
 const writes=[];t.mock.method(process.stderr,'write',chunk=>{writes.push(String(chunk));return true;});
 const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),request={account_address:'owner@example.invalid',message:{to:[],cc:[],subject:'subject',body:{format:'text',content:'expected'}}};
 const tab={inspect:async()=>({result:{to_hash:hash('[]'),cc_hash:hash('[]'),subject_hash:hash('subject'),body_hash:hash('different'),body_length:9,send_ready:true,linked:true,
  body_diagnostic:{mode:'private',reason:'private account@example.invalid',top_nodes:1001,top_text:-1,div_attributes:'private attribute',block_display:'private display',block_visibility:'private visibility',body:'private body',url:'https://example.invalid',br_attributes:1}}})};
 await assert.rejects(verifyManagedDraft(tab,'gmail',request),{code:'email_draft_fields_unverified'});
 assert.deepEqual(JSON.parse(writes[0]).body_readback,{mode:'unavailable',reason:'unavailable',block_display:'unavailable',block_visibility:'unavailable',br_attributes:1});
 assert.doesNotMatch(writes[0],/private|example\.invalid|https/);
 t.mock.method(process.stderr,'write',()=>{throw Error('stderr failed');});
 await assert.rejects(verifyManagedDraft(tab,'gmail',request),{code:'email_draft_fields_unverified'});
});

test('body structure is bounded to 32 fixed nodes and four levels without text or attribute values',()=>{
 const nested=element('P',[element('SPAN',[element('DIV',[element('BR')])])],[{name:'data-private-token',value:'private-value'},{name:'dir',value:'rtl'}]);
 const context=environment([nested]);context.__sparkclawManagedMail.body.nodeType=1;context.__sparkclawManagedMail.body.tagName='DIV';context.__sparkclawManagedMail.body.attributes=[{name:'class',value:'private-class'}];
 const result=vm.runInNewContext(`(${managedSendDOM.toString()})('gmail','readback',{})`,context);
 assert.equal(result.body,'rendered fallback');assert.equal(result.body_diagnostic.structure.truncated,true);
 assert.deepEqual(JSON.parse(JSON.stringify(result.body_diagnostic.structure.nodes.map(n=>[n.tag,n.depth,n.parent]))),[['div',0,-1],['p',1,0],['span',2,1],['div',3,2]]);
 assert.equal(result.body_diagnostic.structure.nodes[0].class,true);assert.equal(result.body_diagnostic.structure.nodes[1].dir,true);assert.equal(result.body_diagnostic.structure.nodes[1].other,true);
 assert.doesNotMatch(JSON.stringify(result.body_diagnostic),/private|rtl|data-/);
 const wide=environment(Array.from({length:1001},()=>line('private text'))),r=vm.runInNewContext(`(${managedSendDOM.toString()})('gmail','readback',{})`,wide);
 assert.equal(r.body_diagnostic.structure.nodes.length,32);assert.equal(r.body_diagnostic.structure.truncated,true);
 // Diagnostic style probing cannot replace the original successful reader.
 const broken=environment([line('first')]);broken.__sparkclawManagedMail.body.nodeType=1;
 Object.defineProperty(broken.__sparkclawManagedMail.body,'attributes',{get(){throw Error('private diagnostic failure')}});
 const still=vm.runInNewContext(`(${managedSendDOM.toString()})('gmail','readback',{})`,broken);assert.equal(still.body,'first');assert.equal(still.body_diagnostic.structure,undefined);
});

test('body structure sanitization drops page-provided text and clamps malformed trees',async t=>{
 const writes=[];t.mock.method(process.stderr,'write',chunk=>{writes.push(String(chunk));return true;});
 const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),request={message:{to:[],cc:[],subject:'subject',body:{content:'expected'}}};
 const node={parent:-1,depth:0,tag:'private-tag',display:'private-style',white_space:'private-space',visibility:'private-visibility',children:1001,style:'private-attr',class:true,dir:false,other:true,text:'private-text'};
 const result={to_hash:hash('[]'),cc_hash:hash('[]'),subject_hash:hash('subject'),body_hash:hash('different'),body_length:9,send_ready:true,linked:true,body_diagnostic:{structure:{nodes:[node,{...node,parent:12}],truncated:false}}};
 await assert.rejects(verifyManagedDraft({inspect:async()=>({result})},'gmail',request),{code:'email_draft_fields_unverified'});
 const structure=JSON.parse(writes[0]).body_readback.structure;assert.equal(structure.nodes.length,1);assert.equal(structure.truncated,true);assert.equal(structure.nodes[0].tag,'other');assert.equal(structure.nodes[0].children,undefined);assert.equal(structure.nodes[0].style,undefined);assert.doesNotMatch(writes[0],/private/);
});
