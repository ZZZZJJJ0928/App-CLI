import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {installOutlookEarlyBridge} from '../../applications/mail/userscripts/lib/outlook-early-bridge.mjs';

const origin='https://outlook.live.com';
const startupURL=origin+'/owa/0/startupdata.ashx';
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const startup=()=>({
  accessToken:'test-access-token-must-not-be-retained',
  owaUserConfig:{SessionSettings:{UserEmailAddress:'Owner@example.test',Canary:'canary-must-not-be-retained',Token:'session-token-must-not-be-retained'},SessionSecret:'config-secret-must-not-be-retained'},
  findFolders:{Body:{ResponseMessages:{Items:[{RootFolder:{IncludesLastItemInRange:true,TotalItemsInView:1,Folders:[{FolderId:{Id:'inbox-id'},ParentFolderId:{Id:'root-id'},DisplayName:'Inbox',FolderClass:'IPF.Note'}]}}]}}},
  findConversation:{Body:{FolderId:{Id:'inbox-id'},Conversations:[{Subject:'mail-subject-must-not-be-retained',Body:'mail-body-must-not-be-retained'}]},ResponseToken:'conversation-token-must-not-be-retained'},
  unrelated:{body:'unrelated-body-must-not-be-retained'},
});
function response(value,url=startupURL,status=200) {
  const r=new Response(JSON.stringify(value),{status});
  Object.defineProperty(r,'url',{value:url});
  Object.defineProperty(r,'clone',{value:()=>response(value,url,status)});
  return r;
}
function fixture(t,options={}) {
  const f={requests:[],workerSends:[]};
  class Worker {postMessage(...args){f.workerSends.push(args);}}
  class Port {
    listeners=new Set();
    addEventListener(name,listener){assert.equal(name,'message');this.listeners.add(listener);}
    removeEventListener(name,listener){assert.equal(name,'message');this.listeners.delete(listener);}
    emit(data){for(const listener of this.listeners)listener({data});}
  }
  class MessageChannel {constructor(){this.port1=new Port();this.port2=new Port();}}
  const fetch=async(...args)=>{f.requests.push(args);return response(f.value??startup(),f.responseURL??startupURL,f.status??200);};
  const context=vm.createContext({URL,Uint8Array,TextDecoder,structuredClone,location:{origin:options.origin??origin},Worker,MessageChannel,fetch});
  vm.runInContext('window=globalThis;window.top=window;',context);
  if(options.frame)context.top={};
  f.context=context;f.native={Worker,MessageChannel,fetch};
  f.install=()=>vm.runInContext(`(${installOutlookEarlyBridge.toString()})()`,context);
  f.bridge=f.install();
  f.consumer=()=>({startupValues:[],requestValues:[],resultValues:[],startup(value){this.startupValues.push(plain(value));},request(worker,message){this.requestValues.push({worker,message:plain(message)});},result(event,port){this.resultValues.push({event,port});}});
  t.after(()=>f.bridge?.dispose());
  return f;
}

test('Outlook early bridge retains sanitized startup evidence for a late attach without extra fetch',async t=>{
  const f=fixture(t),value=startup();f.value=value;
  const options={method:'POST',headers:{Authorization:'Bearer page-only-token'},body:'native-request'};
  const delivered=await f.context.fetch(startupURL,options);
  assert.deepEqual(await delivered.json(),value);
  await flush();
  const consumer=f.consumer();f.bridge.attach(consumer);
  assert.equal(consumer.startupValues.length,1);assert.equal(f.requests.length,1);
  assert.equal(f.requests[0][0],startupURL);assert.equal(f.requests[0][1],options);
  const retained=consumer.startupValues[0];
  assert.deepEqual(Object.keys(retained).sort(),['findConversation','findFolders','owaUserConfig']);
  assert.deepEqual(retained.owaUserConfig,{SessionSettings:{UserEmailAddress:'Owner@example.test'}});
  assert.deepEqual(retained.findConversation,{Body:{FolderId:{Id:'inbox-id'}}});
  assert.deepEqual(retained.findFolders,value.findFolders);
  assert.doesNotMatch(JSON.stringify(retained),/must-not-be-retained|page-only-token|Authorization|Canary/);
});

test('Outlook startup evidence reattaches without navigation or replaying network traffic',async t=>{
  const f=fixture(t),first=f.consumer();f.bridge.attach(first);
  await f.context.fetch(startupURL);await flush();
  assert.equal(first.startupValues.length,1);
  f.bridge.detach(first);
  const second=f.consumer();f.bridge.attach(second);
  assert.deepEqual(second.startupValues,first.startupValues);assert.equal(f.requests.length,1);
  f.bridge.detach(first); // A stale reader cannot detach the new owner.
  const worker=new f.context.Worker();worker.postMessage({argumentList:[{value:{operationName:'ItemRows'}}]});
  assert.equal(second.requestValues.length,1);assert.equal(first.requestValues.length,0);
  assert.equal(f.install(),f.bridge);assert.equal(f.requests.length,1);
});

test('Outlook early bridge observes only successful same-origin startup responses',async t=>{
  for(const options of [{url:origin+'/owa/0/other.ashx'},{url:'https://foreign.example.test/owa/0/startupdata.ashx'},{url:startupURL,status:500}])await t.test(JSON.stringify(options),async t=>{
    const f=fixture(t);f.responseURL=options.url;f.status=options.status;
    await f.context.fetch(options.url);await flush();
    const consumer=f.consumer();f.bridge.attach(consumer);
    assert.equal(consumer.startupValues.length,0);assert.equal(f.requests.length,1);
  });
});

test('Outlook early bridge delegates each native fetch once to the attached search transport',async t=>{
  const f=fixture(t),consumer=f.consumer(),calls=[];
  f.responseURL=origin+'/searchservice/api/v2/query';
  consumer.fetchSearch=async(args,next)=>{calls.push(args);return next(...args);};
  f.bridge.attach(consumer);
  await f.context.fetch(origin+'/searchservice/api/v2/query',{method:'POST',body:'native-search'});await flush();
  assert.equal(calls.length,1);assert.equal(f.requests.length,1);assert.equal(consumer.startupValues.length,0);
});

test('Outlook bridge queues bounded native operations until reader attach and forwards channel results',t=>{
  const f=fixture(t),worker=new f.context.Worker(),channel=new f.context.MessageChannel();
  worker.postMessage({argumentList:[{value:{operationName:'Unrelated'}}]});
  for(let i=0;i<45;i++)worker.postMessage({argumentList:[{value:{operationName:'ItemRows',id:i}}]});
  const consumer=f.consumer();f.bridge.attach(consumer);
  assert.equal(f.workerSends.length,46);assert.equal(consumer.requestValues.length,40);
  assert.equal(consumer.requestValues[0].message.argumentList[0].value.id,5);
  channel.port1.emit({reply:'one'});channel.port2.emit({reply:'two'});
  assert.equal(consumer.resultValues.length,2);assert.equal(f.requests.length,0);
  f.bridge.detach(consumer);channel.port1.emit({reply:'detached'});assert.equal(consumer.resultValues.length,2);
});

test('Outlook dispose restores owned hooks and removes existing port listeners without touching later hooks',async t=>{
  const f=fixture(t),channel=new f.context.MessageChannel(),consumer=f.consumer();f.bridge.attach(consumer);
  assert.equal(channel.port1.listeners.size,1);assert.notEqual(f.context.fetch,f.native.fetch);
  f.bridge.dispose();
  assert.equal(f.context.Worker,f.native.Worker);assert.equal(f.context.MessageChannel,f.native.MessageChannel);assert.equal(f.context.fetch,f.native.fetch);
  assert.equal(f.context.SparkClawOutlookEarlyBridge,undefined);assert.equal(channel.port1.listeners.size,0);assert.equal(channel.port2.listeners.size,0);
  channel.port1.emit({body:'after-dispose'});assert.equal(consumer.resultValues.length,0);
  await f.context.fetch(startupURL);await flush();assert.equal(consumer.startupValues.length,0);assert.equal(f.requests.length,1);
  const again=f.install(),replacement=()=>{};f.context.fetch=replacement;again.dispose();assert.equal(f.context.fetch,replacement);
});

test('Outlook early bridge is scoped to top-level supported Outlook origins',t=>{
  for(const options of [{origin:'https://mail.google.com'},{frame:true}]){
    const f=fixture(t,options);assert.equal(f.bridge,null);assert.equal(f.context.fetch,f.native.fetch);assert.equal(f.context.Worker,f.native.Worker);
  }
});
