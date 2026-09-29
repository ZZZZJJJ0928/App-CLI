import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyMailNotification as classify} from '../../applications/mail/runtime/mail-notification-rules.mjs';

test('QQ connection initialization is not arrival; only the decoded inbound envelope qualifies', () => {
  assert.equal(classify('qq_mail','qq',{cmd:0,content:'connection'}).decision,'ignore');
  const packet={cmd:1,scene:'notify',encoding:'base64',content:btoa(JSON.stringify({type:'0',mid:'fixture-message',t:'fixture'}))};
  assert.equal(classify('qq_mail','qq',packet).reason,'qq_inbound_envelope');
  assert.equal(classify('qq_mail','qq',{...packet,content:'invalid'}).decision,'unknown');
  assert.equal(classify('qq_mail','qq',{...packet,content:btoa(JSON.stringify({type:'0'}))}).decision,'unknown');
  assert.equal(classify('qq_mail','qq',{...packet,content:btoa(JSON.stringify({type:'1',mid:'fixture-message'}))}).decision,'unknown');
});

test('Gmail connection, subscription ACK, twenty-second topic keepalive and logical invalidation are distinct', () => {
  const records = [
    [[0,['c','fixture-session','',8,15,30000]]],
    [1,2,7],
    [[2,[[[['topic',[['fixture-version']]]]]]]],
    [[4,[[[['topic',[null,null,['fixture-version']]],['topic2',[null,null,['fixture-version']]]]]]]],
  ];
  for(const value of records)assert.equal(classify('gmail','gmail',value).decision,'ignore');
  const change=[[13,[[[['topic',[null,[[[null,'fixture-a','fixture-b','fixture-c',[],[],0,0]]]]]]]]]];
  assert.equal(classify('gmail','gmail',change).reason,'gmail_topic_invalidation');
  assert.equal(classify('gmail','gmail',{}).decision,'unknown');
  assert.equal(classify('gmail','gmail',[[1,'unqualified']]).decision,'unknown');
});


test('Outlook subscription arrivals differ from reloads, ordinary results and read flags', () => {
  const state=new Map();
  const row={ConversationId:{Id:'conversation-test'},LastDeliveryTime:'2026-09-24T09:00:00Z',MessageCount:1,ItemIds:[{Id:'message-test'}],UnreadCount:1};
  const envelope=(EventType,Conversation=row)=>({operation:'subscribeToRowNotifications',message:{type:'APPLY',argumentList:[{type:'RAW',value:3},{type:'RAW',value:{data:{subscribeToRowNotifications:{EventType,Conversation}}}}]}});
  const check=value=>classify('outlook','outlook_subscription',value,state);
  assert.equal(check(envelope('Reload',null)).decision,'ignore');
  assert.equal(check({...envelope('RowAdded'),operation:'subscribeToHierarchyNotifications'}).decision,'ignore');
  assert.equal(check(envelope('RowAdded')).decision,'change');
  assert.equal(check(envelope('RowAdded')).decision,'ignore');
  assert.equal(check(envelope('RowModified',{...row,UnreadCount:0})).decision,'ignore');
  assert.equal(check(envelope('RowModified',{...row,LastDeliveryTime:'2026-09-24T09:01:00Z',MessageCount:2,ItemIds:[...row.ItemIds,{Id:'reply-test'}]})).decision,'change');
  assert.equal(check(envelope('RowModified',{...row,ConversationId:{Id:'unseen-test'}})).decision,'unknown');
  assert.equal(check(envelope('RowDeleted')).decision,'ignore');
  assert.equal(classify('outlook','outlook_rows',[{node:row}],state).decision,'ignore');
  assert.equal(check(envelope('RowModified',row)).decision,'ignore');
});


test('Outlook single-item notification covers received mail and ignores read state, drafts and outgoing items', () => {
  const state=new Map();
  const item={ItemId:{Id:'item-test'},DateTimeReceived:'2026-09-24T09:00:00Z',MessageToMe:true,IsDraft:false,IsRead:false};
  const message=(EventType,Item)=>({operation:'subscribeToRowNotifications',message:{type:'APPLY',argumentList:[{value:42},{value:{data:{subscribeToRowNotifications:{EventType,Conversation:null,Item}}}}]}});
  const check=(event,item)=>classify('outlook','outlook_subscription',message(event,item),state);
  assert.equal(check('RowAdded',item).decision,'change');
  assert.equal(check('RowModified',{...item,IsRead:true}).decision,'ignore');
  assert.equal(check('RowAdded',{...item,ItemId:{Id:'draft-test'},IsDraft:true}).decision,'ignore');
  assert.notEqual(check('RowAdded',{...item,ItemId:{Id:'outgoing-test'},MessageToMe:false}).decision,'change');
});
