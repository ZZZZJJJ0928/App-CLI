import assert from 'node:assert/strict';
import test from 'node:test';
import {gmailOriginalURL} from '../../applications/mail/userscripts/lib/gmail-download.mjs';

test('Gmail native original binds account and canonical message without legacy ik or HTML overview',t=>{
 const previous=globalThis.location;globalThis.location={origin:'https://mail.google.com'};
 t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});
 const binding={id:'a',row:{native_message_id:'msg-f:10'},request:{url:new URL('https://mail.google.com/sync/u/2/i/bv?hl=en')}};
 const url=gmailOriginalURL(binding);
 assert.equal(url.origin,'https://mail.google.com');assert.equal(url.pathname,'/mail/u/2/');
 assert.equal(url.searchParams.get('view'),'att');assert.equal(url.searchParams.get('attid'),'0');assert.equal(url.searchParams.get('th'),'a');
 assert.equal(url.searchParams.get('disp'),'comp');assert.equal(url.searchParams.get('safe'),'1');assert.equal(url.searchParams.has('zw'),true);
 assert.equal(url.searchParams.has('ik'),false);assert.equal(url.searchParams.has('permmsgid'),false);
 assert.equal(gmailOriginalURL({...binding,request:{url:new URL('https://foreign.example/sync/u/2/i/bv')}}),null);
 assert.equal(gmailOriginalURL({...binding,request:{url:new URL('https://mail.google.com/wrong')}}),null);
 assert.equal(gmailOriginalURL({...binding,id:'thread-f:10'}),null);
 assert.equal(gmailOriginalURL({...binding,row:{}}),null);
});
