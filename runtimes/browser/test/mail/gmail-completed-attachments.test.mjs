import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {attachmentDOM,verifyManagedAttachments} from '../../applications/mail/lib/workspace-attachments.mjs';

const bytes=Buffer.from('attachment bytes\n');
const expected=[{name:'proof.txt',size_bytes:bytes.length,sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex')}];
function element(tag,classes='',text='') {
 const node={tagName:tag.toUpperCase(),classes,textContent:text,isConnected:true,children:[],parentElement:null,hidden:false,disabled:false,attributes:{},
  getAttribute(name){return this.attributes[name]??null;},setAttribute(name,value){this.attributes[name]=value;},
  getBoundingClientRect(){return {width:20,height:20};},
  contains(other){return other===this||this.children.some(child=>child.contains(other));},
  append(...children){for(const child of children){if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(x=>x!==child);child.parentElement=this;this.children.push(child);}},
  querySelectorAll(selector){
   const direct=(tag,cls)=>this.children.filter(x=>x.tagName===tag&&x.classes.split(' ').includes(cls));
   if(selector===':scope > a.dO')return direct('A','dO');
   if(selector===':scope > div.vI')return direct('DIV','vI');
   if(selector===':scope > div.vJ')return direct('DIV','vJ');
   if(selector===':scope > div.vq[role="button"]')return direct('DIV','vq').filter(x=>x.getAttribute('role')==='button');
   if(selector===':scope > input')return this.children.filter(x=>x.tagName==='INPUT');
   const all=this.children.flatMap(x=>[x,...x.querySelectorAll('*')]);
   if(selector==='*')return all;
   if(selector==='.aQH .dL')return all.filter(x=>x.classes==='dL'&&x.legacy);
   if(selector==='div.dL')return all.filter(x=>x.tagName==='DIV'&&x.classes==='dL');
   if(selector==='input[type="file"]')return all.filter(x=>x.tagName==='INPUT'&&x.type==='file');
   if(selector.startsWith('.vI,.vJ'))return all.filter(x=>['vI','vJ'].includes(x.classes));
   if(selector==='button,[role="button"],a')return all.filter(x=>x.tagName==='BUTTON'||x.tagName==='A'||x.getAttribute('role')==='button');
   if(selector.startsWith('[role="progressbar"]'))return all.filter(x=>x.getAttribute('role')==='progressbar');
   if(selector.startsWith('[role="alert"]'))return all.filter(x=>x.getAttribute('role')==='alert');
   return [];
  }};
 return node;
}
async function fixture({legacy=false}={}) {
 const root=element('div'),body=element('div'),send=element('button'),input=element('input');input.type='file';input.files=[new File([bytes],'proof.txt')];
 const listeners=new Map(),document={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};input.ownerDocument=document;
 root.append(body,send,input);
 const state={provider:'gmail',ownershipChecked:true,root,body,send};
 const context=vm.createContext({document,crypto:webcrypto,globalThis:undefined,getComputedStyle:node=>({display:node.display||'block',visibility:node.visibility||'visible',opacity:node.opacity||'1'})});
 context.globalThis=context;context.__sparkclawManagedMail=state;
 const ready=()=>vm.runInContext(`(${attachmentDOM.toString()})('gmail','ready',${JSON.stringify(expected)})`,context);
 const prepared=vm.runInContext(`(${attachmentDOM.toString()})('gmail','prepare',[])`,context);assert.equal(prepared.chooser,false);
 listeners.get('change')({target:input});await state.attachmentProof;
 root.children=root.children.filter(x=>x!==input);input.isConnected=false;input.parentElement=null;
 const replacement=element('input');replacement.type='file';replacement.files=[];replacement.ownerDocument=document;root.append(replacement);
 const row=element('div','dL');row.legacy=legacy;
 const metadata=element('input'),link=element('a','dO'),name=element('div','vI','proof.txt'),size=element('div','vJ',`${bytes.length} B`),remove=element('div','vq');metadata.hidden=true;remove.attributes={role:'button','aria-label':'Remove attachment'};
 link.append(name,size);row.append(metadata,link,remove);root.append(row);
 const tab={inspect:async code=>({result:await vm.runInContext(`(${code})()`,context)})};
 return {state,root,body,send,input,replacement,row,link,name,size,remove,ready,tab};
}

test('completed Gmail card without legacy container retains the captured File proof after input replacement',async()=>{
 const f=await fixture();assert.equal(f.input.isConnected,false);assert.equal(f.replacement.files.length,0);
 assert.deepEqual(JSON.parse(JSON.stringify(f.state.attachmentVerifiedManifest)),expected);
 assert.equal(f.state.attachmentCapturedFiles.input,f.input);assert.equal(f.ready().ready,true);
 await verifyManagedAttachments(f.tab,'gmail',expected);
});
test('legacy Gmail card is counted once and remains accepted',async()=>{
 const f=await fixture({legacy:true});const result=f.ready();assert.equal(result.ready,true);assert.equal(result.count,1);
 await verifyManagedAttachments(f.tab,'gmail',expected);
});
for(const [name,change] of [
 ['different filename',f=>{f.name.textContent='other.txt';}],
 ['card inside editable body',f=>f.body.append(f.row)],
 ['hidden ancestor',f=>{const wrap=element('div');wrap.hidden=true;f.root.append(wrap);wrap.append(f.row);}],
 ['duplicate card',f=>f.root.append(element('div','dL'))],
 ['missing remove',f=>{f.row.children=f.row.children.filter(x=>x!==f.remove);}],
 ['disabled remove',f=>{f.remove.attributes['aria-disabled']='true';}],
 ['different remove action',f=>{f.remove.attributes['aria-label']='Download attachment';}],
 ['card outside composer',f=>{f.root.children=f.root.children.filter(x=>x!==f.row);f.row.parentElement=null;}],
 ['changed captured manifest',f=>{f.state.attachmentVerifiedManifest[0].sha256='sha256:'+'0'.repeat(64);}],
 ['replacement input rebound as original',f=>{f.state.attachmentInput=f.replacement;}],
 ['copied manifest substituted for captured object',f=>{f.state.attachmentVerifiedManifest=structuredClone(f.state.attachmentVerifiedManifest);}],
 ['captured composer changed',f=>{f.state.attachmentCapturedFiles.root=element('div');}],
 ['pending upload',f=>{const progress=element('div');progress.attributes.role='progressbar';f.root.append(progress);}],
 ['visible upload error',f=>{const error=element('div');error.attributes.role='alert';f.root.append(error);}],
])test(`completed Gmail card rejects ${name}`,async t=>{
 const f=await fixture();change(f);assert.notEqual(f.ready().ready,true);
 t.mock.method(process.stderr,'write',()=>true);
 await assert.rejects(verifyManagedAttachments(f.tab,'gmail',expected));
});
