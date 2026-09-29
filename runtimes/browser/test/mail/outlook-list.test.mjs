import assert from 'node:assert/strict';
import test from 'node:test';
import {parseOutlookList} from '../../applications/mail/lib/outlook-list.mjs';

const singleton=()=>({ConversationId:{Id:'conversation'},ItemIds:[{Id:'item'}],GlobalItemIds:[{Id:'item'}],MessageCount:1,GlobalMessageCount:1,UnreadCount:1,GlobalUnreadCount:1});
test('Outlook list separates a global singleton ItemId from its conversation identity',()=>{
  assert.deepEqual(parseOutlookList({Body:{Conversations:[singleton()]}}),[{provider_selection_id:'conversation',provider_message_id:'item',unread:true}]);
  assert.equal(parseOutlookList({Conversations:[{...singleton(),UnreadCount:0,GlobalUnreadCount:0}]})[0].unread,false);
});
test('mixed, multiple and partially loaded Outlook conversations invalidate earlier singleton proof',()=>{
  for(const changes of [{GlobalMessageCount:2},{MessageCount:2},{GlobalUnreadCount:2},{ItemIds:[{Id:'item'},{Id:'other'}]},{GlobalItemIds:[{Id:'other'}]},{ItemIds:[]},{ConversationId:{Id:'item'}},{UnreadCount:null}]) {
    const row=parseOutlookList({Conversations:[{...singleton(),...changes}]})[0];
    assert.equal(row.provider_message_id,null);
    assert.equal(row.unread,null);
  }
  for(const unknown of [null,{},[],{Conversations:[{}]}])assert.deepEqual(parseOutlookList(unknown),[]);
});

test('Outlook inventories proved global ItemIds, distinguishes local members and drafts, and keeps singleton capture gate',()=>{
 const conversation={...singleton(),MessageCount:2,GlobalMessageCount:4,ItemIds:[{Id:'inbound-1'},{Id:'inbound-2'}],
  GlobalItemIds:[{Id:'inbound-1'},{Id:'sent-1'},{Id:'inbound-2'},{Id:'draft-1'}],DraftItemIds:[{Id:'draft-1'}],
  LastDeliveryTime:'2026-09-08T07:13:50Z'};
 const row=parseOutlookList({Conversations:[conversation]},true)[0];
 assert.equal(row.provider_message_id,null);
 assert.equal(row.inventory_complete,true);
 assert.deepEqual(row.members,[
  {provider_message_id:'inbound-1',local:true,draft:false},{provider_message_id:'sent-1',local:false,draft:false},
  {provider_message_id:'inbound-2',local:true,draft:false},{provider_message_id:'draft-1',local:false,draft:true}]);
 assert.equal(row.last_delivery_time,conversation.LastDeliveryTime);
 for(const bad of [{...conversation,GlobalMessageCount:5},{...conversation,DraftItemIds:undefined},
  {...conversation,GlobalItemIds:[{Id:'inbound-1'},{Id:'inbound-1'},{Id:'inbound-2'},{Id:'draft-1'}]},
  {...conversation,DraftItemIds:[{Id:'unknown'}]}]) assert.equal(parseOutlookList({Conversations:[bad]},true)[0].inventory_complete,undefined);
});
