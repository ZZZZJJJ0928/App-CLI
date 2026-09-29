import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installMailObserverPage} from '../../applications/mail/runtime/mail-observer-page.mjs';
import {classifyMailNotification} from '../../applications/mail/runtime/mail-notification-rules.mjs';

function pageFixture(provider,{dormant=false}={}) {
  const events = [], sockets = [], timers = new Set();
  class Socket extends EventTarget { constructor() {super(); sockets.push(this);} }
  class XHR extends EventTarget {
    open(method, url) {this.url = url;}
    send(body) {this.sent = body; return 'native-send';}
    progress(body) {this.responseText = body; this.dispatchEvent(new Event('progress'));}
  }
  class Worker extends EventTarget {postMessage(value) {this.sent=value; return 'native-post';}}
  class Channel {constructor() {this.port1=new EventTarget();this.port2=new EventTarget();}}
  const nativeFetch=async()=>({ok:true,clone(){throw new Error('observer must not clone response');}});
  const origin = {gmail:'https://mail.google.com',qq_mail:'https://wx.mail.qq.com',outlook:'https://outlook.live.com'}[provider];
  const context = {crypto, Worker, MessageChannel:Channel, XMLHttpRequest: XHR, WebSocket: Socket, URL, TextDecoder, Event, atob,
    location:{origin,href:origin+'/'},
    setInterval(fn) {timers.add(fn); return fn;}, clearInterval(fn) {timers.delete(fn);},
    fetch: nativeFetch,
    __sparkclawMailObservation: async event => events.push(event),
    SparkClawMailReader:{provider,version:'0.2.0',checkAccount(){return true;}}};
  context.window=context;context.top=context;
  vm.runInNewContext(`(${installMailObserverPage.toString()})(${JSON.stringify({provider,origins:[origin],account:'test@example.test',evidence:true,dormant})}, ${classifyMailNotification.toString()})`,context);
  return {context,events,sockets,timers,nativeFetch,Worker,Channel};
}

test('dormant early hooks emit no pre-registration backlog and account checks do not traverse Reader rows',async()=>{
  const f=pageFixture('gmail',{dormant:true});
  let checks=0;
  f.context.SparkClawMailReader.checkAccount=()=>{checks++;return true;};
  f.context.SparkClawMailReader.snapshot=()=>{throw new Error('row traversal is forbidden');};
  const xhr=new f.context.XMLHttpRequest();
  xhr.open('POST','/punctual/multi-watch/channel');xhr.send();
  xhr.progress('3\n{}\n');
  assert.equal(f.events.length,0);
  assert.equal(f.context.__sparkclawMailObserver.activate(),true);
  assert.equal(f.context.__sparkclawMailObserver.activate(),true);
  await new Promise(setImmediate);
  assert.equal(f.events.filter(event=>event.kind==='document').length,1);
  assert.equal(f.events.filter(event=>event.kind==='mailbox_changed').length,0);
  assert.equal(checks,1);
});

test('Gmail fragmented length frames and multiple frames preserve the native XHR return', () => {
  const f=pageFixture('gmail'),xhr=new f.context.XMLHttpRequest();
  xhr.open('POST','/mail/u/0/punctual/multi-watch/channel');
  assert.equal(xhr.send('original'),'native-send');
  assert.equal(xhr.sent,'original');
  const data=JSON.stringify([[1,[1,2,7]]]),packet=`${data.length}\n${data}`;
  for(let i=1;i<=packet.length;i++)xhr.progress(packet.slice(0,i));
  xhr.progress(packet+'\n'+packet);
  assert.equal(f.events.filter(event=>event.kind==='evidence').length,2);
  assert.equal(f.events.filter(event=>event.kind==='mailbox_changed').length,0);
  assert.equal(f.events.find(event=>event.kind==='evidence').account_ok,true);
});

test('Outlook native Worker callbacks pass through unchanged and emit metadata without cloning fetch', async () => {
  const f=pageFixture('outlook');
  assert.equal(f.context.fetch,f.nativeFetch);
  assert.equal((await f.context.fetch('/owa/notificationchannel')).ok,true);
  const worker=new f.context.Worker();
  const request={argumentList:[{value:{operationName:'subscribeToRowNotifications',requestId:3}}]};
  assert.equal(worker.postMessage(request),'native-post');assert.equal(worker.sent,request);
  await new Promise(setImmediate);
  const channel=new f.context.MessageChannel();
  let forwarded;
  channel.port1.addEventListener('message',event=>{forwarded=event.data;});
  const message={type:'APPLY',argumentList:[{value:3},{value:{data:{subscribeToRowNotifications:{EventType:'RowAdded',Conversation:{ConversationId:{Id:'native-test'},LastDeliveryTime:'2026-09-24T09:00:00Z',MessageCount:1,ItemIds:[{Id:'item-test'}],ConversationTopic:'private subject'}}}}}]};
  channel.port1.dispatchEvent(new MessageEvent('message',{data:message}));
  assert.equal(forwarded,message);
  const hint=f.events.find(event=>event.kind==='mailbox_changed');
  assert.equal(hint.reason,'outlook_delivery_change');
  assert.equal(JSON.stringify(f.events).includes('private subject'),false);
  f.context.__sparkclawMailObserver.dispose();
  assert.equal(f.context.Worker,f.Worker);assert.equal(f.context.MessageChannel,f.Channel);
});

test('unbounded/malformed streams degrade and release parser buffer without affecting native XHR', () => {
  const f=pageFixture('gmail'),xhr=new f.context.XMLHttpRequest();
  xhr.open('POST','/punctual/multi-watch/channel');xhr.send();xhr.progress('9'.repeat(131073));
  assert.equal(f.events.filter(event=>event.kind==='degraded').length,1);
  xhr.progress('9'.repeat(131074));
  assert.equal(f.events.filter(event=>event.kind==='degraded').length,1);
  f.context.__sparkclawMailObserver.dispose();
  assert.equal(f.timers.size,0);
});

