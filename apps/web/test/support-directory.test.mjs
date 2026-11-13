import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readSupportOrders} from '../src/lib/support-directory.ts';
import {computeSupportUnread,getSupportUnreadSnapshot,publishSupportUnread,readDirectoryPreferences,resetSupportUnread,subscribeSupportUnread,supportUnreadAriaLabel,supportUnreadBadge} from '../src/components/support/support-unread.ts';
async function readAll(request) {
 let result;
 for await (const page of readSupportOrders(request,new AbortController().signal)) result=page;
 assert.equal(result.complete,true);
 return result.items;
}
test('both roles and later pages participate; unpaid orders alone are not conversations',async()=>{
 const paths=[];
 const rows=await readAll(async path=>{paths.push(path);if(path.includes('legacy-im-groups'))return path.includes('party=renter')?{items:[{id:'legacy',origin:'LEGACY',status:'PENDING_PAYMENT',fulfillmentAssignment:{state:'ASSIGNED',teamState:'READY'}}],nextCursor:null}:{items:[],nextCursor:null};return path.includes('party=owner')?{items:[{id:'owned',fulfillmentAssignment:{state:'WAITING'}}],nextCursor:null}:path.includes('cursor=next')?{items:[{id:'rented',fulfillmentAssignment:{state:'ASSIGNED'}}],nextCursor:null}:{items:[{id:'unpaid'}],nextCursor:'next'};});
 assert.deepEqual(rows.map(x=>x.id).sort(),['legacy','owned','rented']);assert.equal(paths.length,5);assert.equal(rows.find(x=>x.id==='owned').party,'owner');
});

test('a long native history does not starve either legacy group directory',async()=>{
 const paths=[],scan=readSupportOrders(async path=>{paths.push(path);return{items:[],nextCursor:path.includes('party=renter')&&!path.includes('legacy-im-groups')?'more':null};},new AbortController().signal);
 for(let i=0;i<4;i++)await scan.next();
 assert(paths.some(p=>p.includes('legacy-im-groups')&&p.includes('party=renter')));
 assert(paths.some(p=>p.includes('legacy-im-groups')&&p.includes('party=owner')));
});
test('partial failure and invalid pagination cannot prove an empty directory',async()=>{
 await assert.rejects(readAll(async path=>{if(path.includes('party=owner'))throw Error('403');return{items:[],nextCursor:null};}),/403/);
 await assert.rejects(readAll(async()=>({items:[],nextCursor:'same'})),/分页未完成/);
 await assert.rejects(readAll(async()=>({items:[]})),/格式无效/);
 await assert.rejects(readAll(async path=>{if(path.includes('legacy-im-groups'))throw Error('legacy failed');return{items:[],nextCursor:null};}),/legacy failed/);
});

// 入口未读：窗口关着时用户只能靠常驻入口知道有新消息，所以计数规则必须自己站得住——
// 只认服务端事实、免打扰不计、草稿/未付款不是会话、没有条数就退回圆点。
test('entry unread sums server counts, skips muted threads and never counts unpaid drafts',()=>{
 const summary=computeSupportUnread(
  [{id:'round-1',threadId:'thread-1',hasUnread:true,userUnreadCount:2},
   {id:'round-2',threadId:'thread-2',hasUnread:true,userUnreadCount:0},
   {id:'round-3',threadId:'thread-3',hasUnread:false,userUnreadCount:0},
   {id:'round-4',threadId:'thread-4',hasUnread:true,userUnreadCount:7}],
  [{id:'order-1',status:'PAID',unreadCount:3},
   {id:'order-2',status:'DRAFT',unreadCount:5},
   {id:'order-3',status:'PENDING_PAYMENT',unreadCount:5},
   {id:'order-4',status:'COMPLETED',unreadCount:1}],
  {'consultation:thread-4':{pinned:false,muted:true}},
  1000);
 assert.equal(summary.total,6,'2 条客服 + 3 + 1 条订单群');
 assert.equal(summary.consultations,2);
 assert.equal(summary.orders,4);
 assert.equal(summary.unknownThreads,1,'有未读但没有条数的线程只算“未知”，不能补成 0');
 assert.equal(summary.unreadThreads,4);
 assert.equal(summary.at,1000);
 assert.equal(computeSupportUnread([],[],{}).total,0);
});

test('entry badge caps at 99 and degrades to a dot when the server cannot count',()=>{
 assert.deepEqual(supportUnreadBadge(computeSupportUnread([{id:'a',hasUnread:true,userUnreadCount:150}],[])),{text:'99+',counted:true});
 assert.deepEqual(supportUnreadBadge(computeSupportUnread([{id:'a',hasUnread:true}],[])),{text:'',counted:false});
 assert.equal(supportUnreadBadge(computeSupportUnread([],[])),null);
 assert.equal(supportUnreadBadge(null),null);
 assert.equal(supportUnreadAriaLabel('联系客服',null),'联系客服');
 assert.equal(supportUnreadAriaLabel('联系客服',computeSupportUnread([{id:'a',hasUnread:true,userUnreadCount:3}],[])),'联系客服，3 条未读消息');
 assert.equal(supportUnreadAriaLabel('联系客服',computeSupportUnread([{id:'a',hasUnread:true}],[])),'联系客服，有新消息');
});

test('the shared snapshot notifies only on changed facts and clears on demand',()=>{
 resetSupportUnread();
 let notified=0;
 const unsubscribe=subscribeSupportUnread(()=>{notified+=1;});
 const first=computeSupportUnread([{id:'a',hasUnread:true,userUnreadCount:1}],[],{},1);
 publishSupportUnread(first);
 assert.equal(notified,1);
 publishSupportUnread(computeSupportUnread([{id:'a',hasUnread:true,userUnreadCount:1}],[],{},2));
 assert.equal(notified,1,'同一组数字换采样时间不惊动订阅者');
 publishSupportUnread(computeSupportUnread([],[],{},3));
 assert.equal(notified,2);
 assert.equal(getSupportUnreadSnapshot().total,0,'清空是事实：没有未读就是 0，不是未知');
 resetSupportUnread();
 assert.equal(getSupportUnreadSnapshot(),null);
 assert.equal(notified,3,'清空同样是一次事实变化');
 unsubscribe();
 publishSupportUnread(first);
 assert.equal(notified,3,'退订后不再收到通知');
 resetSupportUnread();
});

test('directory preferences stay empty without a browser and never throw on junk',()=>{
 assert.deepEqual(readDirectoryPreferences('user_A:1'),{});
 assert.deepEqual(readDirectoryPreferences(''),{});
});

test('scan advances only on demand and abort stops later pages even if the request ignores cancellation',async()=>{
 const controller=new AbortController();let calls=0,release;
 const scan=readSupportOrders(async()=>{calls++;if(calls===2)await new Promise(resolve=>release=resolve);return {items:[],nextCursor:'page-'+calls};},controller.signal);
 assert.equal((await scan.next()).value.complete,false);assert.equal(calls,1);
 const pending=scan.next();assert.equal(calls,2);controller.abort();release();
 await assert.rejects(pending,{name:'AbortError'});await scan.next();assert.equal(calls,2);
});


/* --- Support Intent Rules Tests --- */

import { supportSubjectRefFromUrl, clearSupportIntent, consumeSupportIntent, parseSupportIntent, readSupportIntent, saveSupportIntent, SUPPORT_INTENT_STORAGE_KEY } from "../src/lib/support-intent.ts";

function intentStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("support intent survives login only for a short-lived same-site target", () => {
  const store = intentStorage();
  saveSupportIntent({ type: "COMPLAINT", source: "/listing/listing_1?view=detail" }, store, 1_000);
  const intent = readSupportIntent(store, 1_001);
  assert.deepEqual(intent, { type: "COMPLAINT", source: "/listing/listing_1?view=detail", createdAt: 1_000 });
  assert.deepEqual(consumeSupportIntent(store, 1_002), intent);
  assert.equal(readSupportIntent(store, 1_002), null);
});

test("a complaint entry intent survives storage so the API can choose the correct welcome", () => {
  const store = intentStorage();
  store.setItem(SUPPORT_INTENT_STORAGE_KEY, JSON.stringify({ type: "COMPLAINT", source: "/help/rental-getting-started", createdAt: 1_000 }));
  assert.deepEqual(readSupportIntent(store, 1_001), { type: "COMPLAINT", source: "/help/rental-getting-started", createdAt: 1_000 });
  assert.deepEqual(parseSupportIntent({ type: "COMPLAINT", source: "/help", createdAt: 1_000 }, 1_001), { type: "COMPLAINT", source: "/help", createdAt: 1_000 });
});

test("support intent rejects external, malformed, future, and expired values", () => {
  assert.equal(parseSupportIntent({ type: "SERVICE", source: "https://evil.invalid", createdAt: 1_000 }, 1_000), null);
  assert.equal(parseSupportIntent({ type: "UNKNOWN", source: "/support", createdAt: 1_000 }, 1_000), null);
  assert.equal(parseSupportIntent({ type: "SERVICE", source: "/support", createdAt: 31_001 }, 1_000), null);
  assert.equal(parseSupportIntent({ type: "SERVICE", source: "/support", createdAt: 1_000 }, 601_001), null);
});

test("keeps a failed recovery intent and clears only the matching completed intent", () => {
  const store = intentStorage();
  saveSupportIntent({ type: "SERVICE", source: "/support" }, store, 2_000);
  const intent = readSupportIntent(store, 2_001);
  assert.ok(intent);
  clearSupportIntent({ ...intent, createdAt: intent.createdAt + 1 }, store, 2_001);
  assert.ok(readSupportIntent(store, 2_001));
  clearSupportIntent(intent, store, 2_001);
  assert.equal(readSupportIntent(store, 2_001), null);
});

test("support entry carries the explicit order/account reference and ignores invalid context",()=>{
  assert.equal(supportSubjectRefFromUrl("https://example.test/account?view=rental-detail&orderId=order_1&accountId=ac_1"),"order:order_1");
  assert.equal(supportSubjectRefFromUrl("https://example.test/accounts/ac_1"),"account:ac_1");
  assert.equal(supportSubjectRefFromUrl("https://example.test/?listingId=listing_1"),"listing:listing_1");
  assert.equal(supportSubjectRefFromUrl("https://example.test/?orderId=bad%20id"),null);
  assert.equal(supportSubjectRefFromUrl("invalid"),null);
  const legacy=`legacy_order_${'a'.repeat(40)}`;
  assert.equal(supportSubjectRefFromUrl(`https://example.test/account?source=legacy&orderId=${legacy}`),`legacy-order:${legacy}`);
  assert.equal(supportSubjectRefFromUrl("https://example.test/account?source=legacy&orderId=legacy_order_bad"),null);
});
