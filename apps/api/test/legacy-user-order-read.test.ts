import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { getUserLegacyOrder, listUserLegacyOrders, parseLegacyUserOrderQuery, projectUserLegacyOrder, legacyUserOrderFrom } from "../src/order/legacy-user-order-read";
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
test("soft-deleted old records never reappear in user list/detail after migration", () => {
 for(const sourceDeletedFlag of ["1","2",""]) assert.throws(()=>projectUserLegacyOrder({...row,sourceDeletedFlag},"renter"),
  (error:unknown)=>(error as{status?:number}).status===404);
 assert.equal(projectUserLegacyOrder({...row,sourceDeletedFlag:"0"},"renter").id,row.id);
 for(const ready of [false,true]) assert.match(legacyUserOrderFrom(ready),/WHERE COALESCE\(source_snapshot->>'is_delete','0'\)='0'/);
});

test("user historical projection preserves paid cancellation, unknown refund and removes private facts",()=>{
  const result=projectUserLegacyOrder(row,"renter");
  assert.equal(result.status,"CANCELLED");assert.equal(result.party,"renter");assert.equal(result.payment.state,"RECORDED_PAID");
  assert.equal(result.payment.recordedAmount!.amount,"66.00");assert.equal(result.paidAt,null);assert.equal(result.amounts.rental!.amount,"66.00");
  assert.equal(result.legacyAmounts!.refund,null);assert.equal(result.legacyAmounts!.refundChannelState,"NOT_RECORDED_BY_SOURCE");
  assert.equal(result.legacyAmounts!.goods!.amount,"60.00");assert.equal(result.legacyAmounts!.items!.amount,"6.00");
  assert.equal(projectUserLegacyOrder(row,"owner").legacyAmounts,null,"owner role does not receive renter price splits");
  assert.equal(result.account.id,null);assert.equal(result.account.displayNo,null);assert.equal(result.account.readable,false);
  assert.equal(result.readOnly,true);assert.equal(result.paymentOpen,false);assert.equal(result.cancelOpen,false);assert.equal(result.continuationCount,0);assert.deepEqual(result.actions,[]);
  for(const key of ["ownerUserId","renterUserId","source_snapshot","evidence_ref","owner_phone","quote","accountId"])assert.equal(Object.hasOwn(result,key),false);
  assert.ok(!JSON.stringify(result).includes("private"));
});
test("sample 793+199=992 exposes renter goods and item components without inventing an owner split",()=>{
  const sample={...row,goodsYuan:"793.00",itemsYuan:"199.00",dueCents:"99200",paidCents:"99200"};
  const renter=projectUserLegacyOrder(sample,"renter");
  assert.equal(renter.legacyAmounts!.goods!.amount,"793.00");assert.equal(renter.legacyAmounts!.items!.amount,"199.00");
  assert.equal(renter.legacyAmounts!.paid!.amount,"992.00");assert.equal(renter.amounts.rental!.amount,"992.00");
  assert.equal(projectUserLegacyOrder(sample,"owner").legacyAmounts,null);
});
test("shared normalization covers completed, in-flight, unpaid and unknown without granting actions",()=>{
  for(const [status,pay,expected] of [[4,1,"COMPLETED"],[3,1,"PAID"],[8,1,"PAID"],[9,1,"PAID"],[1,0,"PENDING_PAYMENT"],[9,0,"UNKNOWN"],[77,9,"UNKNOWN"]] as const){
    assert.equal(legacyOrderReadState(status,pay).status,expected);
    const result=projectUserLegacyOrder({...row,sourceOrderStatus:status,sourcePayStatus:pay},"renter");
    assert.equal(result.status,expected);assert.deepEqual(result.actions,[]);assert.equal(result.cancelOpen,false);assert.equal(result.paymentOpen,false);
    if(pay!==1)assert.equal(result.payment.recordedAmount,null);
  }
  const refunded=projectUserLegacyOrder({...row,refundYuan:"12.34"},"renter");assert.equal(refunded.legacyAmounts!.refund!.amount,"12.34");assert.equal(refunded.legacyAmounts!.refundChannelState,"NOT_RECORDED_BY_SOURCE");
});
test("sample 20260804205138763692 keeps paid cancellation distinct from an unpaid cancellation",()=>{
  const paid=projectUserLegacyOrder({...row,displayNo:"20260804205138763692",sourceOrderStatus:5,sourcePayStatus:1},"renter");
  assert.equal(paid.status,"CANCELLED");assert.equal(paid.payment.state,"RECORDED_PAID");assert.equal(paid.payment.recordedAmount!.amount,"66.00");
  const unpaid=projectUserLegacyOrder({...row,displayNo:"20260804205138763692",sourceOrderStatus:5,sourcePayStatus:0},"renter");
  assert.equal(unpaid.status,"CANCELLED");assert.equal(unpaid.payment.state,"RECORDED_UNPAID");assert.equal(unpaid.payment.recordedAmount,null);
  assert.equal(unpaid.legacyAmounts!.paidState,"NOT_PAID");assert.equal(unpaid.legacyAmounts!.paid!.amount,"0.00");
});
test("channel evidence separates 'the source never recorded it' from 'this platform still owes a result'",()=>{
  // la_* carries transfer_time only; with no local settlement document the source simply has no receipt.
  const pure=projectUserLegacyOrder(row,"renter").legacyAmounts!;
  assert.equal(pure.refundChannelState,"NOT_RECORDED_BY_SOURCE");
  assert.equal(pure.paidState,"RECORDED");
  assert.equal(pure.paid!.amount,"66.00");
  // A continuation head in an unresolved settlement stage means this platform still owes a local result.
  const continued=projectUserLegacyOrder({...row,continuationStage:8},"renter").legacyAmounts!;
  assert.equal(continued.refundChannelState,"PENDING");
  // A finalized continuation is not an in-flight document; the source still has no receipt of its own.
  assert.equal(projectUserLegacyOrder({...row,continuationStage:4},"renter").legacyAmounts!.refundChannelState,"NOT_RECORDED_BY_SOURCE");
  // Unpaid is a source fact, not a missing value: the paid slot is an explicit zero, never null.
  for(const [status,pay] of [[1,0],[5,0],[9,0]] as const){
    const unpaid=projectUserLegacyOrder({...row,sourceOrderStatus:status,sourcePayStatus:pay},"renter");
    assert.equal(unpaid.payment.state,"RECORDED_UNPAID");
    assert.equal(unpaid.payment.recordedAmountState,"NOT_PAID");
    assert.equal(unpaid.legacyAmounts!.paidState,"NOT_PAID");
    assert.deepEqual(unpaid.legacyAmounts!.paid,{currency:"CNY",unit:"yuan",amount:"0.00",scale:2});
  }
  // A recorded payment always carries an amount or an explicit reason for its absence.
  const ownerPaid=projectUserLegacyOrder({...row,accountReadable:true},"owner");
  assert.equal(ownerPaid.payment.recordedAmountState,"NOT_VISIBLE_FOR_ROLE");
  assert.equal(projectUserLegacyOrder(row,"renter").payment.recordedAmountState,"RECORDED");
  const noAmount=projectUserLegacyOrder({...row,paidCents:null},"renter");
  assert.equal(noAmount.payment.recordedAmountState,"NOT_RETAINED");
  assert.equal(noAmount.payment.recordedAmount,null);
  assert.equal(noAmount.legacyAmounts!.paidState,"NOT_RETAINED");
  const unknown=projectUserLegacyOrder({...row,sourcePayStatus:9},"renter");
  assert.equal(unknown.payment.recordedAmountState,"UNKNOWN");
  assert.equal(unknown.legacyAmounts!.paidState,"UNKNOWN");
  assert.equal(unknown.legacyAmounts!.paid,null);
});
test("the legacy placeholder is not an account title",()=>{
  const visible=projectUserLegacyOrder({...row,accountReadable:true,title:"历史资料待核实"},"owner");
  assert.equal(visible.title,null);
  const real=projectUserLegacyOrder({...row,accountReadable:true,title:"真实当前标题"},"owner");
  assert.equal(real.title,"真实当前标题");
  const opaque=projectUserLegacyOrder({...row,accountReadable:true,title:"   "},"owner");
  assert.equal(opaque.title,null);
});
test("owner account navigation follows the separate read authorization and nonparties get 404",()=>{
  const result=projectUserLegacyOrder({...row,accountReadable:true},"owner");assert.equal(result.party,"owner");assert.equal(result.account.id,"account");
  assert.throws(()=>projectUserLegacyOrder(row,"stranger"),(e:unknown)=>(e as {status:number}).status===404);
  const unknown=projectUserLegacyOrder({...row,goodsYuan:null,dueCents:null,depositCents:null,sourcePayStatus:9},"owner");assert.equal(unknown.amounts.rental,null);assert.equal(unknown.amounts.totalDue,null);assert.equal(unknown.amounts.deposit,null);assert.equal(unknown.payment.state,"UNKNOWN");
  const exact=projectUserLegacyOrder({...row,dueCents:"999999999999999999999"},"owner");assert.equal(exact.amounts.totalDue,null);assert.equal(exact.amounts.ownerExpectedIncome,null);assert.equal(exact.legacyAmounts,null);assert.equal(exact.payment.recordedAmount,null);
});

test("legacy owner may read original completed net income without renter price or invented current responsibility", () => {
 const original = { ...row, sourceOrderStatus: 4, saleEarningsYuan: "80.00", fullPayoutFeeYuan: "3.00" };
 const owner = projectUserLegacyOrder(original, "owner");
 assert.equal(owner.amounts.ownerRecordedIncome?.amount,"77.00"); assert.equal(owner.ownerIncomeSource?.sourceLabel,"旧平台原单净收益记录");
 assert.equal(owner.amounts.ownerExpectedIncome,null); assert.equal(owner.amounts.totalDue,null); assert.equal(owner.payment.recordedAmount,null);
 const renter = projectUserLegacyOrder(original,"renter"); assert.equal("ownerRecordedIncome" in renter.amounts,false); assert.equal("ownerIncomeSource" in renter,false);
 for (const changed of [{sourceOrderStatus:8,continuationStage:4},{sourcePayStatus:0},{saleEarningsYuan:null},{fullPayoutFeeYuan:null},
  {saleEarningsYuan:"1.00"},{saleEarningsYuan:"bad"}]) {
  assert.equal(projectUserLegacyOrder({...original,...changed},"owner").amounts.ownerRecordedIncome,null);
 }
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
  assert.equal(hidden.title,null);assert.ok(!JSON.stringify(hidden).includes("PRIVATE_CURRENT_ACCOUNT_TITLE"));
  const owned=projectUserLegacyOrder({...row,title:"MY_ACCOUNT_TITLE",accountReadable:true},"owner");assert.equal(owned.title,"MY_ACCOUNT_TITLE");
});
test("effective continuation stage updates the list while original source status and recorded payment remain unchanged",()=>{
  const result=projectUserLegacyOrder({...row,sourceOrderStatus:8,continuationStage:4,completedAt:"2026-10-16T00:00:00.123456Z"},"renter");assert.equal(result.status,"COMPLETED");assert.equal(result.source.originalStatus,8);assert.equal(result.payment.state,"RECORDED_PAID");assert.equal(result.completedAt,"2026-10-16T00:00:00.123456Z");assert.equal(result.legacyAmounts!.refundChannelState,"NOT_RECORDED_BY_SOURCE");
});

test("unreadable legacy accounts expose neither old nor canonical account numbers",()=>{
 for(const number of ['OLD-ACCOUNT','AC0000000001']){
  const hidden=projectUserLegacyOrder({...row,accountDisplayNo:number,title:'PRIVATE_TITLE'},'renter');
  assert.equal(hidden.account.id,null);assert.equal(hidden.account.displayNo,null);assert.equal(hidden.title,null);
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
 assert.equal(result.title,null);
 assert.ok(!JSON.stringify(result).includes("PRIVATE_CURRENT_ACCOUNT_TITLE"));
 assert.ok(!JSON.stringify(result).includes("OLD-ACCOUNT"));
 const empty=projectUserLegacyOrder(row,"renter");assert.deepEqual(empty.orderFacts,{resources:[],rentalDeadlineAt:null});
 assert.throws(()=>projectUserLegacyOrder({...row,level6BulletNum:"not-a-quantity"},"renter"),(e:unknown)=>(e as {status:number}).status===400);
});

test("API projection feeds the shared web display with honest titles and record-labelled refunds",()=>{
  // Cross-layer chain: the real user projection is piped into the real web display functions.
  const display = createRequire(__filename)(join(process.cwd(), "../web/src/lib/order-display.ts")) as {
    orderResourceSummary(order: unknown): string | null;
    orderAccountTitle(order: unknown): string;
    orderUsesResourceSummary(order: unknown): boolean;
    orderAmountFacts(order: unknown, party: "renter" | "owner"): { main: string; caption: string; secondary: string[] };
  };
  // U5-R1-03 counterexample: owner-readable, no real current title, frozen order resources present.
  const chainRow = { ...row, accountReadable: true, title: null, expendHaff: "12.50", topInsureCardNum: "7", refundYuan: "87.00", depositCents: "5700" };
  const projection = projectUserLegacyOrder(chainRow, "owner");
  assert.equal(projection.title, null);
  assert.equal(display.orderResourceSummary(projection), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderAccountTitle(projection), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderUsesResourceSummary(projection), true);
  // U5-R1-02 counterexample: gross 87 / detain 5 / verified net 82 — only the source record exists here.
  for (const party of ["renter", "owner"] as const) {
    const facts = display.orderAmountFacts(projectUserLegacyOrder(chainRow, party), party);
    assert.deepEqual(facts.secondary, party === "renter" ? ["押金 57.00 元", "原退款金额记录 87.00 元"] : []);
    assert.ok(!facts.secondary.some((line) => /应退责任|仍欠|已到账|净/.test(line)));
  }
  assert.ok(!JSON.stringify(display.orderAmountFacts(projection, "renter")).includes("82.00"), "no net is derived from the gross record");
  // REFUND_RECORD_EXISTS: the record stays a record and the projection gains no accounting model.
  assert.equal(Object.hasOwn(projection, "duty"), false);
  assert.ok(!JSON.stringify(projection).includes("82.00"));
  // A bare title is not the new account-display contract; use authorized listingFacts.
  assert.equal(display.orderAccountTitle(projectUserLegacyOrder({ ...chainRow, title: "不应回退的裸标题" }, "owner")), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
  // Cross-subject guard: without account read authorization the current title never reaches the display.
  const hidden = projectUserLegacyOrder({ ...chainRow, title: "真实当前标题", accountReadable: false }, "renter");
  assert.equal(hidden.title, null);
  assert.ok(!JSON.stringify(hidden).includes("真实当前标题"));
  assert.equal(display.orderAccountTitle(hidden), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
  // No frozen facts at all: the display stays honestly empty instead of inventing a title.
  assert.equal(display.orderAccountTitle(projectUserLegacyOrder({ ...row, accountReadable: true, title: null }, "owner")), "租赁账号");
});
