import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {getAdminReadOrder,projectAdminReadOrder,queryAdminReadOrders,orderReadRelation,orderReadKeyRelation} from "../src/order/admin-order-read";
import {LEGACY_ORDER_STATUS_SQL} from "../src/order/legacy-order-read";
const viewer={adminId:"test-reader",isBoss:false,internalQuote:false,authorizationKey:"a".repeat(64)};
test('current-order summaries keep source/status joins and skip full volatile JSON records',()=>{
 for(const ready of [false,true]){
  const full=orderReadRelation(ready),summary=orderReadRelation(ready,true);
  assert.match(full,/to_jsonb\(o\).*jsonb_build_object/s);assert.match(full,/AS record/);
  assert.doesNotMatch(summary,/to_jsonb|jsonb_build_object|clock_timestamp|AS record/);
  assert(summary.includes(LEGACY_ORDER_STATUS_SQL));
  assert.equal(summary.slice(summary.indexOf('FROM zzsh_order.rental_order'),summary.indexOf('UNION ALL')),full.slice(full.indexOf('FROM zzsh_order.rental_order'),full.indexOf('UNION ALL')));
  assert.equal(summary.slice(summary.indexOf('FROM zzsh_order.legacy_order_read_snapshot')),full.slice(full.indexOf('FROM zzsh_order.legacy_order_read_snapshot')));
 }
});
test('the narrow key relation keeps every filter column and drops only the record projection',()=>{
 for(const ready of [false,true]){
  const keys=orderReadKeyRelation(ready),full=orderReadRelation(ready),summary=orderReadRelation(ready,true);
  assert.doesNotMatch(keys,/to_jsonb|jsonb_build_object|clock_timestamp|AS record/);
  for(const column of ['account_no','renter_no','owner_no','owner_name','renter_name','owner_username','renter_username','origin'])
   assert(keys.includes(column),`the key relation must keep ${column}`);
  // Same rows, same joins: only the record projection differs.
  assert.equal(keys.slice(keys.indexOf('FROM zzsh_order.rental_account'),keys.indexOf('UNION ALL')),full.slice(full.indexOf('FROM zzsh_order.rental_account'),full.indexOf('UNION ALL')));
  assert.equal(keys.slice(keys.indexOf('FROM zzsh_order.legacy_order_read_snapshot')),full.slice(full.indexOf('FROM zzsh_order.legacy_order_read_snapshot')));
  assert.equal(summary.slice(summary.indexOf('FROM zzsh_order.rental_account'),summary.indexOf('UNION ALL')),keys.slice(keys.indexOf('FROM zzsh_order.rental_account'),keys.indexOf('UNION ALL')));
 }
});
const record={id:"legacy-1",original_order_no:"OLD-1",source_order_status:5,source_pay_status:1,due_amount_cents:"6600",recorded_paid_amount_cents:"6600",deposit_amount_cents:"0",source_snapshot:{goods_money:"36.00",expend_pay_money:"0.00",return_order_money:null},source_created_at:null,source_paid_at:null,source_cancelled_at:null,source_completed_at:null,owner_name:"Owner",renter_name:"Renter",owner_user_id:"owner",renter_user_id:"renter",account_id:"account",game_id:"game",legacy_account_no:"A1"};
const amount={currency:"CNY",unit:"yuan",amount:"90071992547409931234.56",scale:2},zero={...amount,amount:"0.00"};
const native={id:"native-1",display_no:"NEW-1",account_id:"account",account_no:"A1",listing_version_id:"version",owner_user_id:"owner",renter_user_id:"renter",owner_name:"Owner",renter_name:"Renter",game_id:"game",rule_release_id:"native-release",content_hash:"a".repeat(64),term_option_code:"day",status:"COMPLETED",rental_amount_cents:"9007199254740993123456",deposit_amount_cents:"0",currency:"CNY",term_seconds:"86400",title:"Native order",hold_until:"2026-09-30T00:00:00.000000Z",paid_at:null,created_at:"2026-09-29T00:00:00.000000Z",revision:"1",quote_snapshot:{schemaVersion:1,currency:"CNY",lines:[],resourceTotal:amount,tenantDeposit:zero,ownerTotal:amount,platformFullProfit:zero,termSeconds:"86400",expiryDisclosures:[],unitAmountsInformational:true}};
const paymentRequest={id:"request-1",order_id:native.id,channel:"JOINPAY",state:"UNKNOWN",method:"ALIPAY_NATIVE",amount_cents:"12345",currency:"CNY",
 merchant_identity_id:"merchant-1",channel_order_no:"NEW_1",config_profile_id:"profile-1",protocol_version:"2.6",key_version_ref:"key-1",evidence_level:"SYNTHETIC_PROTOCOL",created_at:native.created_at,updated_at:native.created_at};
const paymentSnapshot={
 order:{id:native.id,display_no:native.display_no,status:native.status,paid_at:null,hold_expired:false,created_at:native.created_at},request:paymentRequest,confirmation:null,
 observations:[{id:"observation-1",request_id:paymentRequest.id,channel:"JOINPAY",merchant_identity_id:paymentRequest.merchant_identity_id,channel_order_no:paymentRequest.channel_order_no,
  config_profile_id:paymentRequest.config_profile_id,protocol_version:paymentRequest.protocol_version,key_version_ref:paymentRequest.key_version_ref,operation:"ASYNC_NOTIFY",source:"PROVIDER_INBOUND",evidence_level:"SYNTHETIC_PROTOCOL",
  event:"E4",result:"CHANNEL_SIGNED_SYNTHETIC",reason:null,channel_status:"SUCCEEDED",channel_trx_no:"transaction-1",provider_paid_at_raw:null,raw_sha256:"b".repeat(64),observed_at:native.created_at,stale:false,late:false,conflict:false}],
 conflicts:[],conflicts_truncated:false,latest_observed_at:native.created_at,
};
type Key={origin:string;id:string};
type Statement={sql:string;values:unknown[]};
/** The admin list reads its keys first and their records second; the harness
 *  answers both statements and records what was asked. */
function orderClient(options:{keys?:Key[];total?:string;records?:Array<{origin:string;id:string;record:Record<string,any>}>;ready?:boolean;channelReady?:boolean;paymentSnapshot?:Record<string,unknown>;paymentReadyError?:Error;paymentReadError?:Error}={}){
 const statements:Statement[]=[];
 const client={query:async(sql:string,values:unknown[]=[])=>{
  statements.push({sql,values:[...values]});
   if(sql.includes("to_regclass('zzsh_order.payment_request')")){
    if(options.paymentReadyError)throw options.paymentReadyError;
    return {rows:[{ready:options.channelReady??false}]};
   }
   if(sql.includes("WITH scoped AS")){
    if(options.paymentReadError)throw options.paymentReadError;
    return {rows:options.paymentSnapshot?[options.paymentSnapshot]:[]};
   }
  if(sql.includes("to_regclass"))return {rows:[{ready:options.ready??false}]};
  if(sql.includes("AS keys"))return {rows:[{total:options.total??String(options.keys?.length??0),keys:options.keys??[]}]};
  if(sql.includes("SELECT x.origin,x.record"))return {rows:(options.records??[]).filter(r=>values[0]&&(values[0] as string[]).includes(r.id))};
  if(sql.includes("SELECT x.origin,x.id,x.record"))return {rows:options.records??[]};
  return {rows:[]};
 }} as unknown as PoolClient;
 return {client,statements};
}
test("legacy cancellation, payment and missing time remain separate facts",()=>{
 const paid=projectAdminReadOrder("LEGACY",record,viewer);assert.equal(paid.status,"CANCELLED");assert.equal(paid.payment.state,"RECORDED_PAID");assert.equal(paid.payment.recordedAt,null);assert.equal(paid.payment.recordedAmount.amount,"66.00");assert.equal(paid.amounts.deposit.amount,"0.00");assert.equal(paid.legacyAmounts.refund,null);assert.equal(paid.legacyAmounts.refundChannelState,"UNKNOWN");
 const unpaid=projectAdminReadOrder("LEGACY",{...record,source_pay_status:0},viewer);assert.equal(unpaid.payment.state,"RECORDED_UNPAID");assert.equal(unpaid.payment.recordedAmount,null);
 const unknown=projectAdminReadOrder("LEGACY",{...record,source_pay_status:9},viewer);assert.equal(unknown.payment.state,"UNKNOWN");assert.equal(unknown.payment.recordedAmount,null);
 const completed=projectAdminReadOrder("LEGACY",{...record,source_order_status:4},viewer);assert.equal(completed.status,"COMPLETED");assert.equal(completed.payment.state,"RECORDED_PAID");assert.equal(completed.paidAt,null);
});
test("numbered pagination filters both sources before count and page; restore scope is bound",async()=>{
 const {client,statements}=orderClient({keys:[{origin:"LEGACY",id:"legacy-1"}],total:"1",records:[{origin:"LEGACY",id:"legacy-1",record}]});
 const result=await queryAdminReadOrders(client,viewer,{page:2,pageSize:3,qKind:"party",qValue:"%name_"});
 assert.equal(result.total,1);assert.equal(result.items[0]!.status,"CANCELLED");assert.equal(result.page,2);assert.equal(result.pageSize,3);assert.equal(result.contextKey,viewer.authorizationKey);
 const keySql=statements.find(s=>s.sql.includes("AS keys"))!.sql;
 assert.ok(keySql.includes("UNION ALL"));assert.ok(keySql.includes("filtered AS"));assert.ok(keySql.includes("admin_supply_scope"));assert.ok(keySql.includes("NULLS LAST"));
 assert.ok(!keySql.includes("to_jsonb("),"the page selection must not build a record for every row");
 assert.ok(statements.some(s=>s.sql.includes("to_jsonb(o)")),"the page's own keys are read again for their record");
 const values=statements.find(s=>s.sql.includes("AS keys"))!.values;
 assert.ok(values.includes("%\\%name\\_%"));
 await assert.rejects(()=>queryAdminReadOrders(client,viewer,{page:1,pageSize:3,restoreKey:"b".repeat(64)}),(e:any)=>e.status===409);
});
test("native and legacy rows share projection without mixing rule origin or losing native cents/privacy",async()=>{
 const {client}=orderClient({keys:[{origin:"NATIVE",id:"native-1"},{origin:"LEGACY",id:"legacy-1"}],total:"2",records:[{origin:"NATIVE",id:"native-1",record:native},{origin:"LEGACY",id:"legacy-1",record}]});
 const result=await queryAdminReadOrders(client,viewer,{page:1,pageSize:3});assert.equal(result.items.length,2);const first=result.items[0]!,old=result.items[1]!;
 assert.equal(first.source.ruleOrigin,"NATIVE_ORDER");assert.equal(first.releaseId,"native-release");assert.equal(first.amounts.totalDue.amount,"90071992547409931234.56");assert.equal(first.payment.state,"RECORDED_PAID");assert.equal(first.payment.recordedAt,null);assert.equal(first.quote.platformFullProfit,undefined);
 assert.equal(old.source.ruleOrigin,"LEGACY_ORDER");assert.equal(old.releaseId,null);assert.equal(old.payment.state,"RECORDED_PAID");assert.equal(old.status,"CANCELLED");
});
test("the same id in both sources stays two orders, never one mixed record",async()=>{
 const shared={...native,id:"same-id",display_no:"NEW-SAME"};
 const legacySame={...record,id:"same-id",original_order_no:"OLD-SAME"};
 const {client,statements}=orderClient({keys:[{origin:"NATIVE",id:"same-id"},{origin:"LEGACY",id:"same-id"}],total:"2",records:[{origin:"NATIVE",id:"same-id",record:shared},{origin:"LEGACY",id:"same-id",record:legacySame}]});
 const result=await queryAdminReadOrders(client,viewer,{page:1,pageSize:10});
 assert.equal(result.items.length,2);
 assert.equal(result.items[0]!.source.origin,"NATIVE");assert.equal(result.items[0]!.displayNo,"NEW-SAME");assert.equal(result.items[0]!.releaseId,"native-release");
 assert.equal(result.items[1]!.source.origin,"LEGACY");assert.equal(result.items[1]!.displayNo,"OLD-SAME");assert.equal(result.items[1]!.releaseId,null);
 const recordValues=statements.find(s=>s.sql.includes("SELECT x.origin,x.id,x.record"))!.values;
 assert.deepEqual(recordValues.at(-2),["same-id"]);assert.deepEqual(recordValues.at(-1),["same-id"]);
});
test("an empty page answers an empty list without reading any record",async()=>{
 const {client,statements}=orderClient({keys:[],total:"0"});
 const result=await queryAdminReadOrders(client,viewer,{page:3,pageSize:20});
 assert.deepEqual(result.items,[]);assert.equal(result.total,0);assert.equal(result.page,3);assert.equal(result.pageSize,20);
 assert.equal(statements.filter(s=>s.sql.includes("SELECT x.origin,x.id,x.record")).length,0);
});
test("the page contract keeps arbitrary pages, the full total and the same order",async()=>{
 for(const [page,pageSize] of [[1,1],[2,20],[999,20]] as const){
  const {client,statements}=orderClient({keys:[{origin:"NATIVE",id:"native-1"}],total:"4821",records:[{origin:"NATIVE",id:"native-1",record:native}]});
  const result=await queryAdminReadOrders(client,viewer,{page,pageSize});
  assert.equal(result.total,4821);assert.equal(result.page,page);assert.equal(result.pageSize,pageSize);assert.equal(result.items.length,1);
  const values=statements.find(s=>s.sql.includes("AS keys"))!.values;
  assert.equal(values.at(-2),pageSize);assert.equal(values.at(-1),(page-1)*pageSize);
  assert.ok(statements.find(s=>s.sql.includes("AS keys"))!.sql.includes("NULLS LAST"));
 }
});
test("every lookup kind filters both sources with the same predicate set",async()=>{
 for(const qKind of ["order","account","party","renter","owner"] as const){
  const {client,statements}=orderClient({keys:[],total:"0"});
  await queryAdminReadOrders(client,viewer,{page:1,pageSize:20,qKind,qValue:"needle"});
  const sql=statements.find(s=>s.sql.includes("AS keys"))!.sql;
  assert.ok(sql.includes("x.game_id"),`${qKind} must stay inside the game scope`);
  if(qKind==="order")assert.ok(sql.includes("x.display_no="));
  if(qKind==="account")assert.ok(sql.includes("x.account_no=")&&sql.includes("x.account_id="));
  if(qKind==="renter")assert.ok(sql.includes("x.renter_user_id=")&&sql.includes("x.renter_name ILIKE")&&sql.includes("x.renter_username ILIKE"));
  if(qKind==="owner")assert.ok(sql.includes("x.owner_user_id=")&&sql.includes("x.owner_name ILIKE")&&sql.includes("x.owner_username ILIKE"));
  if(qKind==="party")assert.ok(sql.includes("x.renter_name ILIKE")&&sql.includes("x.owner_name ILIKE"));
 }
});
for(const [state,round] of [["EXHAUSTED",3],["VERIFY_REQUIRED",2],["RUNNING",1],["STOPPED",2],["NOT_STARTED",0]] as const){
 test(`native ${state} support facts survive combined list and detail`,async()=>{
  const firstResponseAt=state==="STOPPED"?"2026-09-30T00:03:00.123456+00:00":null;
  const remindDueAt=state==="RUNNING"?"2026-09-30T00:05:00.654321+00:00":null;
  const ready={...native,status:"PAID",dispatch_state:"ASSIGNED",team_state:"READY",first_response_at:firstResponseAt,remind_due_at:remindDueAt,add_round:round,escalation_state:state};
  const {client,statements}=orderClient({keys:[{origin:"NATIVE",id:"native-1"},{origin:"LEGACY",id:"legacy-1"}],total:"2",records:[{origin:"NATIVE",id:"native-1",record:ready},{origin:"LEGACY",id:"legacy-1",record}]});
  const list=await queryAdminReadOrders(client,viewer,{page:1,pageSize:3}),detail=await getAdminReadOrder(client,viewer,native.id);
  const expected={firstResponseAt,remindDueAt,addRound:round,state,needsManualReview:state==="EXHAUSTED"||state==="VERIFY_REQUIRED",noEligibleStaff:state==="EXHAUSTED"};
  assert.deepEqual(list.items[0]!.supportEscalation,expected);assert.deepEqual(detail.order,list.items[0]);
  assert.equal(list.items[0]!.quote.platformFullProfit,undefined);assert.equal(list.items[1]!.supportEscalation,undefined);
  // The 0074 capability probe is a separate catalog read, not an order statement.
  const recordStatements=statements.filter(s=>s.sql.includes("AS record")).map(s=>s.sql);
  assert.ok(recordStatements.length>0,"the page keys are read again for their record");
  for(const sql of recordStatements)for(const field of ["first_response_at","remind_due_at","add_round","escalation_state"])assert.ok(sql.includes(`to_jsonb(g)->>'${field}'`),`Missing group field ${field}`);
  const keyStatement=statements.find(s=>s.sql.includes("AS keys"))!.sql;
  assert.ok(!keyStatement.includes("to_jsonb(g)"),"the page selection carries no group projection");
 });
}
test("the single order read asks for its own id only and 404s when it is absent",async()=>{
 const {client,statements}=orderClient({records:[{origin:"NATIVE",id:"native-1",record:native}]});
 const found=await getAdminReadOrder(client,viewer,"native-1");
 assert.equal(found.order.id,"native-1");assert.equal(found.contextKey,viewer.authorizationKey);
 const sql=statements.find(s=>s.sql.includes("SELECT x.origin,x.record"))!.sql;
 assert.ok(sql.includes("o.id=ANY($1::text[])")&&sql.includes("l.id=ANY($1::text[])"),"the relation must be restricted to the requested id");
 assert.ok(sql.includes("admin_supply_scope"));
 const missing={query:async()=>({rows:[]})} as unknown as PoolClient;
 await assert.rejects(()=>getAdminReadOrder(missing,viewer,"order-missing"),(e:any)=>e.status===404);
});

test("detail adds the undeployed payment summary beside the unchanged order and context",async()=>{
 const {client,statements}=orderClient({records:[{origin:"NATIVE",id:native.id,record:native}]});
 const detail=await getAdminReadOrder(client,viewer,native.id);
 assert.equal(detail.order.id,native.id);assert.equal(detail.order.payment.state,"RECORDED_PAID");assert.equal(detail.order.paymentSummary,undefined);
 assert.equal(detail.contextKey,viewer.authorizationKey);
 assert.deepEqual(detail.paymentSummary,{contractVersion:"admin-order-payment-summary.v1",integration:"NOT_INTEGRATED",productionPaymentCapability:false,
  originalRequest:null,latestTrustedObservation:null,acceptance:null,conflicts:null,recovery:null,settlement:"NOT_INTEGRATED",unknowns:null,updatedAt:null});
 assert.equal(statements.some(s=>s.sql.includes("WITH scoped AS")),false);
});

test("detail passes only financeReadable to the five sensitive summary paths and stays read only",async()=>{
 for(const financeReadable of [undefined,false,true]){
  const {client,statements}=orderClient({records:[{origin:"NATIVE",id:native.id,record:native}],channelReady:true,paymentSnapshot});
  const detail=await getAdminReadOrder(client,{...viewer,internalQuote:true,financeReadable},native.id),summary=detail.paymentSummary,visible=financeReadable===true;
  assert.equal(summary.originalRequest!.channelOrderNo,visible?"NEW_1":null);
  assert.deepEqual(summary.originalRequest!.amount,visible?{cents:"12345",currency:"CNY"}:null);
  assert.equal(summary.originalRequest!.merchantIdentityId,visible?"merchant-1":null);
  assert.equal(summary.originalRequest!.keyVersionRef,visible?"key-1":null);
  assert.equal(summary.latestTrustedObservation!.channelTrxNo,visible?"transaction-1":null);
  assert.equal(summary.latestTrustedObservation!.evidenceLevel,"SYNTHETIC_PROTOCOL");assert.equal(summary.productionPaymentCapability,false);
  const objectRead=statements.findIndex(s=>s.sql.includes("SELECT x.origin,x.record")),summaryRead=statements.findIndex(s=>s.sql.includes("zzsh_order.payment_request"));
  assert.ok(objectRead>=0&&summaryRead>objectRead,"the scoped object must be read before its payment summary");
  assert.ok(statements[objectRead]!.sql.includes("admin_supply_scope"));
  assert.deepEqual(statements.find(s=>s.sql.includes("WITH scoped AS"))!.values,[native.id,null]);
  for(const {sql} of statements){assert.match(sql.trimStart(),/^(SELECT|WITH)\b/);assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR UPDATE|pg_advisory)\b/i);}
 }
});

test("missing scoped orders and legacy same-id orders never read native payment facts",async()=>{
 const missing=orderClient();
 await assert.rejects(()=>getAdminReadOrder(missing.client,viewer,native.id),(e:any)=>e.status===404);
 assert.equal(missing.statements.some(s=>s.sql.includes("zzsh_order.payment_request")),false);
 const legacy=orderClient({records:[{origin:"LEGACY",id:native.id,record:{...record,id:native.id}}],channelReady:true,paymentSnapshot});
 const detail=await getAdminReadOrder(legacy.client,{...viewer,financeReadable:true},native.id);
 assert.equal(detail.order.source.origin,"LEGACY");assert.equal(detail.paymentSummary.integration,"NOT_INTEGRATED");
 assert.equal(legacy.statements.some(s=>s.sql.includes("zzsh_order.payment_request")),false);
});

test("payment readiness and fact read failures propagate instead of becoming NONE or NOT_INTEGRATED",async()=>{
 const acl=Object.assign(new Error("synthetic denied"),{code:"42501"}),connection=Object.assign(new Error("synthetic disconnect"),{code:"ECONNRESET"});
 for(const options of [{paymentReadyError:acl},{paymentReadError:acl},{paymentReadError:connection}]){
  const {client}=orderClient({records:[{origin:"NATIVE",id:native.id,record:native}],channelReady:true,paymentSnapshot,...options});
  const expected="paymentReadyError" in options?options.paymentReadyError:options.paymentReadError;
  await assert.rejects(()=>getAdminReadOrder(client,viewer,native.id),(e:unknown)=>e===expected);
 }
});

test("mixed JoinPay requests and controlled acceptance retain the nonproduction source warning",async()=>{
 const {client}=orderClient({records:[{origin:"NATIVE",id:native.id,record:native}],channelReady:true,paymentSnapshot:{...paymentSnapshot,
  confirmation:{id:"controlled-confirmation",source:"CONTROLLED",disposition:"APPLIED",reason_code:null,amount_cents:"12345",currency:"CNY",accepted_at:native.created_at}}});
 const summary=(await getAdminReadOrder(client,{...viewer,financeReadable:true},native.id)).paymentSummary;
 assert.equal(summary.integration,"JOINPAY");assert.equal(summary.acceptance!.state,"APPLIED");assert.equal(summary.productionPaymentCapability,false);
 assert.ok(summary.unknowns!.includes("PAYMENT_SOURCE_DIFFERS_FROM_REQUEST"));assert.equal(summary.latestTrustedObservation!.evidenceLevel,"SYNTHETIC_PROTOCOL");
});
test("native absent or unready group does not expose support escalation",()=>{
 for(const teamState of [null,"NOT_STARTED"]){
  const row=projectAdminReadOrder("NATIVE",{...native,team_state:teamState,first_response_at:null,remind_due_at:null,add_round:0,escalation_state:"NOT_STARTED"},viewer);
  assert.equal(Object.hasOwn(row,"supportEscalation"),false);
 }
});
