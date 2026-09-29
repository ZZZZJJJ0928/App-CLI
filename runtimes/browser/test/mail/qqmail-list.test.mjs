import test from 'node:test';
import assert from 'node:assert/strict';
import {parseQQMailList} from '../../applications/mail/lib/qqmail-list.mjs';

const list=rows=>({head:{ret:0,time:1788860000},body:{list:rows,total_num:rows.length}});
test('QQ uses server receipt time and treats an absent unread bit as read',()=>{
 const result=parseQQMailList(list([{emailid:'mail~1',dirid:1,totime:1788852647,fromtime:1688852647},{emailid:'mail2',dirid:2000,totime:1788852117,unread:1}]));
 assert.equal(result.rows[0].received_at,new Date(1788852647000).toISOString());assert.equal(result.rows[0].unread,false);
 assert.equal(result.rows[1].unread,true);assert.equal(result.rows[1].folder,'qq:2000');
});
test('QQ rejects missing or invalid receipt evidence and malformed locators',()=>{
 assert.equal(parseQQMailList({head:{ret:0},body:{list:[],total_num:0}}),null);
 const result=parseQQMailList(list([{emailid:'mail',dirid:1,fromtime:1788852647},{emailid:'other',dirid:1,totime:1789999999},{emailid:'<script>',dirid:1,totime:1788852647},{emailid:'badflag',dirid:1,totime:1788852647,unread:2}]));
 assert.equal(result.rows.length,0);assert.equal(result.unsupported_rows,4);
});
