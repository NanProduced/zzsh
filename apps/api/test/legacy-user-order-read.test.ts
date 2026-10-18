import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { getUserLegacyOrder, listUserLegacyOrders, parseLegacyUserOrderQuery, projectUserLegacyOrder } from "../src/order/legacy-user-order-read";
import { legacyOrderReadState } from "../src/order/legacy-order-read";

// OFFLINE_FIXTURE_ONLY. No source transactions are manufactured for missing branches.
const row = {
  id:"legacy_order_a", displayNo:"20260510185051049378", sourceOrderStatus:5, sourcePayStatus:1,
  ownerUserId:"owner", renterUserId:"renter", gameId:"game", title:null,
  accountId:"account", accountDisplayNo:"OLD-ACCOUNT", accountReadable:false,
  createdAt:null, paidAt:null, cancelledAt:null, completedAt:null,
  dueCents:"6600", paidCents:"6600", depositCents:"0", goodsYuan:"60.00", itemsYuan:"6.00", refundYuan:null,
  source_snapshot:{phone:"private",password:"private"},evidence_ref:"private",owner_phone:"private",
};
test("user historical projection preserves paid cancellation, unknown refund and removes private facts",()=>{
  const result=projectUserLegacyOrder(row,"renter");
  assert.equal(result.status,"CANCELLED");assert.equal(result.party,"renter");assert.equal(result.payment.state,"RECORDED_PAID");
  assert.equal(result.payment.recordedAmount!.amount,"66.00");assert.equal(result.paidAt,null);assert.equal(result.amounts.rental!.amount,"66.00");
  assert.equal(result.legacyAmounts.refund,null);assert.equal(result.legacyAmounts.refundChannelState,"UNKNOWN");
  assert.equal(result.account.id,null);assert.equal(result.account.displayNo,null);assert.equal(result.account.readable,false);
  assert.equal(result.readOnly,true);assert.equal(result.paymentOpen,false);assert.equal(result.cancelOpen,false);assert.equal(result.continuationCount,0);assert.deepEqual(result.actions,[]);
  for(const key of ["ownerUserId","renterUserId","source_snapshot","evidence_ref","owner_phone","quote","accountId"])assert.equal(Object.hasOwn(result,key),false);
  assert.ok(!JSON.stringify(result).includes("private"));
});
test("shared normalization covers completed, in-flight, unpaid and unknown without granting actions",()=>{
  for(const [status,pay,expected] of [[4,1,"COMPLETED"],[3,1,"PAID"],[8,1,"PAID"],[9,1,"PAID"],[1,0,"PENDING_PAYMENT"],[9,0,"UNKNOWN"],[77,9,"UNKNOWN"]] as const){
    assert.equal(legacyOrderReadState(status,pay).status,expected);
    const result=projectUserLegacyOrder({...row,sourceOrderStatus:status,sourcePayStatus:pay},"renter");
    assert.equal(result.status,expected);assert.deepEqual(result.actions,[]);assert.equal(result.cancelOpen,false);assert.equal(result.paymentOpen,false);
    if(pay!==1)assert.equal(result.payment.recordedAmount,null);
  }
  const refunded=projectUserLegacyOrder({...row,refundYuan:"12.34"},"renter");assert.equal(refunded.legacyAmounts.refund!.amount,"12.34");assert.equal(refunded.legacyAmounts.refundChannelState,"UNKNOWN");
});
test("owner account navigation follows the separate read authorization and nonparties get 404",()=>{
  const result=projectUserLegacyOrder({...row,accountReadable:true},"owner");assert.equal(result.party,"owner");assert.equal(result.account.id,"account");
  assert.throws(()=>projectUserLegacyOrder(row,"stranger"),(e:unknown)=>(e as {status:number}).status===404);
  const unknown=projectUserLegacyOrder({...row,goodsYuan:null,dueCents:null,depositCents:null,sourcePayStatus:9},"owner");assert.equal(unknown.amounts.rental,null);assert.equal(unknown.amounts.totalDue,null);assert.equal(unknown.amounts.deposit,null);assert.equal(unknown.payment.state,"UNKNOWN");
  const exact=projectUserLegacyOrder({...row,dueCents:"999999999999999999999"},"owner");assert.equal(exact.amounts.totalDue!.amount,"9999999999999999999.99");
});
test("list input is bounded and never accepts a caller-selected user",()=>{
  assert.deepEqual(parseLegacyUserOrderQuery(new URLSearchParams()),{party:"renter",page:1,pageSize:20});
  assert.deepEqual(parseLegacyUserOrderQuery(new URLSearchParams("party=owner&page=2&pageSize=3&status=UNKNOWN&accountId=account")),{party:"owner",page:2,pageSize:3,status:"UNKNOWN",accountId:"account"});
  for(const q of ["userId=owner","party=admin","page=0","page=-1","page=1e3","page=1&page=2","pageSize=101","status=bad","accountId=a/b","cursor=old"]){
    assert.throws(()=>parseLegacyUserOrderQuery(new URLSearchParams(q)),(e:unknown)=>(e as {status:number}).status===400,q);
  }
});
test("single list statement filters by authenticated subject before count, stable null-last sort and page",async()=>{
  let sql="",values:unknown[]=[];
  const client={query:async(s:string,v:unknown[])=>{sql=s;values=v;return {rows:[{total:"2",items:[row]}]};}} as unknown as PoolClient;
  const result=await listUserLegacyOrders(client,"renter",{party:"renter",page:2,pageSize:1,status:"CANCELLED"});
  assert.deepEqual(values,["renter","CANCELLED",null,1,1]);assert.match(sql,/l\.renter_user_id=\$1/);assert.match(sql,/ORDER BY "createdAt" DESC NULLS LAST,id DESC/);assert.match(sql,/count\(\*\).*FROM filtered/);
  assert.equal(result.total,2);assert.equal(result.page,2);assert.equal(result.items[0]!.party,"renter");
  assert.ok(!sql.includes('to_jsonb(l)'));assert.ok(!sql.includes('username'));
  assert.ok(sql.includes('a.display_no AS "accountDisplayNo"'));assert.ok(!sql.includes('l.legacy_account_no'));
});
test("detail lookup binds both party columns and absence fails closed",async()=>{
  let sql="",values:unknown[]=[];
  const client={query:async(s:string,v:unknown[])=>{sql=s;values=v;return {rows:[]};}} as unknown as PoolClient;
  await assert.rejects(()=>getUserLegacyOrder(client,"renter","legacy_order_other"),(e:unknown)=>(e as {status:number}).status===404);
  assert.deepEqual(values,["renter","legacy_order_other"]);assert.match(sql,/l\.owner_user_id=\$1 OR l\.renter_user_id=\$1/);
});

test("historical party permission does not expose the current private account title",()=>{
  const hidden=projectUserLegacyOrder({...row,title:"PRIVATE_CURRENT_ACCOUNT_TITLE"},"renter");
  assert.equal(hidden.title,"账号资料暂未提供");assert.ok(!JSON.stringify(hidden).includes("PRIVATE_CURRENT_ACCOUNT_TITLE"));
  const owned=projectUserLegacyOrder({...row,title:"MY_ACCOUNT_TITLE",accountReadable:true},"owner");assert.equal(owned.title,"MY_ACCOUNT_TITLE");
});
test("effective continuation stage updates the list while original source status and recorded payment remain unchanged",()=>{
 const result=projectUserLegacyOrder({...row,sourceOrderStatus:8,continuationStage:4,completedAt:"2026-10-16T00:00:00.123456Z"},"renter");assert.equal(result.status,"COMPLETED");assert.equal(result.source.originalStatus,8);assert.equal(result.payment.state,"RECORDED_PAID");assert.equal(result.completedAt,"2026-10-16T00:00:00.123456Z");assert.equal(result.legacyAmounts.refundChannelState,"UNKNOWN");
});

test("unreadable legacy accounts expose neither old nor canonical account numbers",()=>{
 for(const number of ['OLD-ACCOUNT','AC0000000001']){
  const hidden=projectUserLegacyOrder({...row,accountDisplayNo:number,title:'PRIVATE_TITLE'},'renter');
  assert.equal(hidden.account.id,null);assert.equal(hidden.account.displayNo,null);assert.equal(hidden.title,'账号资料暂未提供');
  assert(!JSON.stringify(hidden).includes(number));assert(!JSON.stringify(hidden).includes('PRIVATE_TITLE'));
 }
 const visible=projectUserLegacyOrder({...row,accountReadable:true,accountDisplayNo:'AC0000000001',title:'本人资料'},'owner');
 assert.equal(visible.account.displayNo,'AC0000000001');assert.equal(visible.title,'本人资料');
 const old=projectUserLegacyOrder({...row,accountReadable:true},'owner');assert.equal(old.account.displayNo,null);
});

test("immutable order facts fill summary inputs without current private data or inferred terms",()=>{
 const result=projectUserLegacyOrder({...row,title:"PRIVATE_CURRENT_ACCOUNT_TITLE",expendHaff:"12.50",awmBulletNum:"3",level6BulletNum:"60",level6HelmetNum:null,level6ArmorNum:"0",topInsureCardNum:"7",barrettBulletNum:"2",coffeeNum:"1",rentalDeadlineSource:"1760000000"},"renter");
 assert.deepEqual(result.orderFacts.resources,[
  {code:"df_billable_haff",quantity:"12.50",unit:null},
  {code:"df_billable_awm_bullet",quantity:"3",unit:null},
  {code:"df_billable_level6_bullet",quantity:"60",unit:null},
  {code:"df_billable_level6_armor",quantity:"0",unit:null},
  {code:"df_billable_top_insure_card",quantity:"7",unit:"DAY"},
  {code:"df_billable_barrett_bullet",quantity:"2",unit:null},
  {code:"df_billable_coffee",quantity:"1",unit:null},
 ]);
 assert.equal(result.orderFacts.rentalDeadlineAt,"2025-10-09T08:53:20.000Z");
 assert.equal(Object.hasOwn(result,"termSeconds"),false);
 assert.equal(result.title,"账号资料暂未提供");
 assert.ok(!JSON.stringify(result).includes("PRIVATE_CURRENT_ACCOUNT_TITLE"));
 assert.ok(!JSON.stringify(result).includes("OLD-ACCOUNT"));
 const empty=projectUserLegacyOrder(row,"renter");assert.deepEqual(empty.orderFacts,{resources:[],rentalDeadlineAt:null});
 assert.throws(()=>projectUserLegacyOrder({...row,level6BulletNum:"not-a-quantity"},"renter"),(e:unknown)=>(e as {status:number}).status===400);
});
