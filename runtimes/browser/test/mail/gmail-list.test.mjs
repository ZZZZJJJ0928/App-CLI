import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGmailList } from '../../applications/mail/lib/gmail-list.mjs';

function response({ messages = 1, labels = ['^i', '^u'], id = 'abc', decimal = '2748' } = {}) {
  const message = [];
  message[0] = `msg-f:${decimal}`; message[10] = labels; message[55] = id;
  const thread = [];
  thread[3] = 'thread-f:2748'; thread[4] = Array.from({length:messages},()=>message);
  const result = []; result[19] = [[null, [[thread]]]];
  return result;
}

test('observed Gmail list projects message labels only for an unambiguous singleton', () => {
  assert.deepEqual(parseGmailList(response()), [{provider_message_id:'abc',provider_thread_id:'thread-f:2748',unread:true,inbox:true,draft:false}]);
  assert.equal(parseGmailList(response({labels:['^i']}))[0].unread,false);
  assert.equal(parseGmailList(response({labels:['^u','^r']}))[0].draft,true);
  for(const value of [null, [], response({messages:2}),response({id:'different'}),response({decimal:'2749'}),response({labels:null})]) {
    assert.deepEqual(parseGmailList(value),[]);
  }
});

test('Gmail self-sent singleton uses observed legacy ID with thread-a/msg-a identity and rejects mixed families',()=>{
 const value=response(),thread=value[19][0][1][0][0];
 thread[3]='thread-a:r-123';thread[4][0][0]='msg-a:r-456';
 assert.equal(parseGmailList(value)[0].provider_message_id,'abc');
 assert.equal(parseGmailList(value)[0].provider_thread_id,'thread-a:r-123');
 thread[4].push([...thread[4][0]]);assert.deepEqual(parseGmailList(value),[]);
 thread[4].pop();thread[4][0][0]='msg-f:2748';assert.deepEqual(parseGmailList(value),[]);
});

test('Gmail thread inventory retains each proved message, Sent and draft evidence without promoting the thread ID',()=>{
 const value=response(),thread=value[19][0][1][0][0];
 const reply=[];reply[0]='msg-f:2749';reply[10]=['^f'];reply[55]='abd';
 const draft=[];draft[0]='msg-f:2750';draft[10]=['^r'];draft[55]='abe';
 thread[4].push(reply,draft);
 const members=parseGmailList(value,true);
 assert.equal(members.length,3);assert.equal(members[1].provider_message_id,'abd');
 assert.equal(members[1].provider_thread_id,'thread-f:2748');assert.equal(members[1].sent,true);
 assert.equal(members[2].draft,true);assert.deepEqual(parseGmailList(value),[]);
 thread[4].push(reply);assert.deepEqual(parseGmailList(value,true),[]);
});

test('Gmail receipt evidence uses the observed internal timestamp, independently of read and sender date',()=>{
 const value=response({labels:['^all']});const message=value[19][0][1][0][0][4][0];
 message[6]=1784159036460;message[17]=1784159036899;message[30]=1784159036899;
 const member=parseGmailList(value,true)[0];assert.equal(member.received_at,'2026-07-15T23:43:56.460Z');assert.equal(member.unread,false);
 message[6]='1784159036460';assert.equal(parseGmailList(value,true)[0].received_at,undefined);
 message[6]=Date.now()+600000;assert.equal(parseGmailList(value,true)[0].received_at,undefined);
});
