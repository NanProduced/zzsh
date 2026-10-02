import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {getAdminReadOrder,projectAdminReadOrder,queryAdminReadOrders} from "../src/order/admin-order-read";
const viewer={adminId:"test-reader",isBoss:false,internalQuote:false,authorizationKey:"a".repeat(64)};
const record={id:"legacy-1",original_order_no:"OLD-1",source_order_status:5,source_pay_status:1,due_amount_cents:"6600",recorded_paid_amount_cents:"6600",deposit_amount_cents:"0",source_snapshot:{goods_money:"36.00",expend_pay_money:"0.00",return_order_money:null},source_created_at:null,source_paid_at:null,source_cancelled_at:null,source_completed_at:null,owner_name:"Owner",renter_name:"Renter",owner_user_id:"owner",renter_user_id:"renter",account_id:"account",game_id:"game",legacy_account_no:"A1"};
const amount={currency:"CNY",unit:"yuan",amount:"90071992547409931234.56",scale:2},zero={...amount,amount:"0.00"};
const native={id:"native-1",display_no:"NEW-1",account_id:"account",account_no:"A1",listing_version_id:"version",owner_user_id:"owner",renter_user_id:"renter",owner_name:"Owner",renter_name:"Renter",game_id:"game",rule_release_id:"native-release",content_hash:"a".repeat(64),term_option_code:"day",status:"COMPLETED",rental_amount_cents:"9007199254740993123456",deposit_amount_cents:"0",currency:"CNY",term_seconds:"86400",title:"Native order",hold_until:"2026-09-30T00:00:00.000000Z",paid_at:null,created_at:"2026-09-29T00:00:00.000000Z",revision:"1",quote_snapshot:{schemaVersion:1,currency:"CNY",lines:[],resourceTotal:amount,tenantDeposit:zero,ownerTotal:amount,platformFullProfit:zero,termSeconds:"86400",expiryDisclosures:[],unitAmountsInformational:true}};
test("legacy cancellation, payment and missing time remain separate facts",()=>{
 const paid=projectAdminReadOrder("LEGACY",record,viewer);assert.equal(paid.status,"CANCELLED");assert.equal(paid.payment.state,"RECORDED_PAID");assert.equal(paid.payment.recordedAt,null);assert.equal(paid.payment.recordedAmount.amount,"66.00");assert.equal(paid.amounts.deposit.amount,"0.00");assert.equal(paid.legacyAmounts.refund,null);assert.equal(paid.legacyAmounts.refundChannelState,"UNKNOWN");
 const unpaid=projectAdminReadOrder("LEGACY",{...record,source_pay_status:0},viewer);assert.equal(unpaid.payment.state,"RECORDED_UNPAID");assert.equal(unpaid.payment.recordedAmount,null);
 const unknown=projectAdminReadOrder("LEGACY",{...record,source_pay_status:9},viewer);assert.equal(unknown.payment.state,"UNKNOWN");assert.equal(unknown.payment.recordedAmount,null);
 const completed=projectAdminReadOrder("LEGACY",{...record,source_order_status:4},viewer);assert.equal(completed.status,"COMPLETED");assert.equal(completed.payment.state,"RECORDED_PAID");assert.equal(completed.paidAt,null);
});
test("numbered pagination filters both sources before count and page; restore scope is bound",async()=>{
 let sql="",args:unknown[]=[];const client={query:async(s:string,p:unknown[])=>{sql=s;args=p;return {rows:[{total:"1",items:[{origin:"LEGACY",record}]}]};}} as unknown as PoolClient;
 const result=await queryAdminReadOrders(client,viewer,{page:2,pageSize:3,qKind:"party",qValue:"%name_"});assert.equal(result.total,1);assert.equal(result.items[0]!.status,"CANCELLED");assert.ok(sql.includes("UNION ALL"));assert.ok(sql.includes("filtered AS"));assert.ok(sql.includes("admin_supply_scope"));assert.ok(sql.includes("NULLS LAST"));assert.ok(args.includes("%\\%name\\_%"));assert.equal(args.at(-1),3);
 await assert.rejects(()=>queryAdminReadOrders(client,viewer,{page:1,pageSize:3,restoreKey:"b".repeat(64)}),(e:any)=>e.status===409);
});
test("native and legacy rows share projection without mixing rule origin or losing native cents/privacy",async()=>{
 const client={query:async()=>({rows:[{total:"2",items:[{origin:"NATIVE",record:native},{origin:"LEGACY",record}]}]})} as unknown as PoolClient;
 const result=await queryAdminReadOrders(client,viewer,{page:1,pageSize:3});assert.equal(result.items.length,2);const first=result.items[0]!,old=result.items[1]!;
 assert.equal(first.source.ruleOrigin,"NATIVE_ORDER");assert.equal(first.releaseId,"native-release");assert.equal(first.amounts.totalDue.amount,"90071992547409931234.56");assert.equal(first.payment.state,"RECORDED_PAID");assert.equal(first.payment.recordedAt,null);assert.equal(first.quote.platformFullProfit,undefined);
 assert.equal(old.source.ruleOrigin,"LEGACY_ORDER");assert.equal(old.releaseId,null);assert.equal(old.payment.state,"RECORDED_PAID");assert.equal(old.status,"CANCELLED");
});
for(const [state,round] of [["EXHAUSTED",3],["VERIFY_REQUIRED",2],["RUNNING",1],["STOPPED",2],["NOT_STARTED",0]] as const){
 test(`native ${state} support facts survive combined list and detail`,async()=>{
  const firstResponseAt=state==="STOPPED"?"2026-09-30T00:03:00.123456+00:00":null;
  const remindDueAt=state==="RUNNING"?"2026-09-30T00:05:00.654321+00:00":null;
  const ready={...native,status:"PAID",dispatch_state:"ASSIGNED",team_state:"READY",first_response_at:firstResponseAt,remind_due_at:remindDueAt,add_round:round,escalation_state:state};
  const statements:string[]=[];
  const client={query:async(sql:string)=>{statements.push(sql);return {rows:sql.includes("filtered AS")?[{total:"2",items:[{origin:"NATIVE",record:ready},{origin:"LEGACY",record}]}]:[{origin:"NATIVE",record:ready}]};}} as unknown as PoolClient;
  const list=await queryAdminReadOrders(client,viewer,{page:1,pageSize:3}),detail=await getAdminReadOrder(client,viewer,native.id);
  const expected={firstResponseAt,remindDueAt,addRound:round,state,needsManualReview:state==="EXHAUSTED"||state==="VERIFY_REQUIRED",noEligibleStaff:state==="EXHAUSTED"};
  assert.deepEqual(list.items[0]!.supportEscalation,expected);assert.deepEqual(detail.order,list.items[0]);
  assert.equal(list.items[0]!.quote.platformFullProfit,undefined);assert.equal(list.items[1]!.supportEscalation,undefined);
  for(const sql of statements)for(const field of ["first_response_at","remind_due_at","add_round","escalation_state"])assert.ok(sql.includes(`to_jsonb(g)->>'${field}'`),`Missing group field ${field}`);
 });
}
test("native absent or unready group does not expose support escalation",()=>{
 for(const teamState of [null,"NOT_STARTED"]){
  const row=projectAdminReadOrder("NATIVE",{...native,team_state:teamState,first_response_at:null,remind_due_at:null,add_round:0,escalation_state:"NOT_STARTED"},viewer);
  assert.equal(Object.hasOwn(row,"supportEscalation"),false);
 }
});
