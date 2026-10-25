import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {getAdminReadOrder,projectAdminReadOrder,queryAdminReadOrders,orderReadRelation,orderReadKeyRelation} from "../src/order/admin-order-read";
import {LEGACY_ORDER_STATUS_SQL} from "../src/order/legacy-order-read";
const viewer={adminId:"test-reader",isBoss:false,internalQuote:false,authorizationKey:"a".repeat(64)};
test('participant restriction combines with origin-bound page keys before either source expands',()=>{
 for(const ready of [false,true]){
  const restrict={nativeIds:'$4',legacyIds:'$5',participantUserId:'$1'};
  for(const relation of [orderReadRelation(ready,true,restrict),orderReadKeyRelation(ready,restrict)]){
   assert.match(relation,/WHERE o\.id=ANY\(\$4::text\[\]\) AND \(o\.owner_user_id=\$1 OR o\.renter_user_id=\$1\)/);
   assert.match(relation,/WHERE l\.id=ANY\(\$5::text\[\]\) AND \(l\.owner_user_id=\$1 OR l\.renter_user_id=\$1\)/);
   assert.ok(relation.includes(LEGACY_ORDER_STATUS_SQL));
   assert.doesNotMatch(relation,/\bDISTINCT\b/,'a self-associated row remains one row; no second participant UNION');
  }
 }
});
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
function orderClient(options:{keys?:Key[];total?:string;records?:Array<{origin:string;id:string;record:Record<string,any>}>;ready?:boolean;channelReady?:boolean;paymentSnapshot?:Record<string,unknown>;paymentReadyError?:Error;paymentReadError?:Error;progressRows?:Record<string,any>[];progressError?:Error;directoryRows?:Record<string,any>[]}={}){
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
  if(sql.includes("zzsh_order.rental_opening")){
   if(options.progressError)throw options.progressError;
   return {rows:options.progressRows??[]};
  }
  if(sql.includes('"phoneNumber" AS phone'))return {rows:options.directoryRows??[]};
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
 assert.deepEqual(detail.paymentSummary,{contractVersion:"admin-order-payment-summary.v1",integration:"NOT_INTEGRATED",productionPaymentCapability:false,dataOrigin:"UNKNOWN",
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
  for(const {sql} of statements){assert.match(sql.trimStart(),/^(SELECT|WITH|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/);assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR UPDATE|pg_advisory)\b/i);}
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
  order:{...paymentSnapshot.order,paid_confirmation_id:"controlled-confirmation"},
  confirmation:{id:"controlled-confirmation",order_id:native.id,source:"CONTROLLED",disposition:"APPLIED",reason_code:null,amount_cents:"12345",currency:"CNY",accepted_at:native.created_at}}});
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


test("原生实付仅来自原APPLIED付款；金额权限、原ID、币种与来源逐项守卫",()=>{
 const payment={id:'payment_1',order_id:native.id,source:'CONTROLLED',disposition:'APPLIED',amount_cents:'15908',currency:'CNY'};
 const row={...native,paid_confirmation_id:payment.id,native_payment_record:payment};
 const paid=projectAdminReadOrder('NATIVE',row,{...viewer,financeReadable:true});
 assert.equal(paid.payment.recordedAmount.amount,'159.08');assert.equal(paid.payment.recordedAmount.currency,'CNY');
 assert.equal(paid.source.origin,'NATIVE');assert.equal(paid.payment.state,'RECORDED_PAID');
 assert.equal('native_payment_record' in paid,false);
 for(const financeReadable of [undefined,false])assert.equal(projectAdminReadOrder('NATIVE',row,{...viewer,financeReadable}).payment.recordedAmount,null);
 for(const change of [{id:'other'},{order_id:'other'},{source:'JOINPAY_CANDIDATE'},{source:'UNKNOWN'},{disposition:'REVIEW_REQUIRED'},
  {currency:'USD'},{amount_cents:'-1'},{amount_cents:'1.5'},{amount_cents:15908},{amount_cents:'01'},{amount_cents:'9'.repeat(26)}])
  assert.equal(projectAdminReadOrder('NATIVE',{...row,native_payment_record:{...payment,...change}},{...viewer,financeReadable:true}).payment.recordedAmount,null);
 for(const status of ['PENDING_PAYMENT','CANCELLED'])assert.equal(projectAdminReadOrder('NATIVE',{...row,status},{...viewer,financeReadable:true}).payment.recordedAmount,null);
 assert.equal(projectAdminReadOrder('NATIVE',{...row,native_payment_record:null},{...viewer,financeReadable:true}).payment.recordedAmount,null);
 assert.equal(projectAdminReadOrder('NATIVE',{...row,currency:'USD'},{...viewer,financeReadable:true}).payment.recordedAmount,null);
});

test("正式JOINPAY原实付在新收款关闭后仍可读，但权限和原绑定不放宽",()=>{
 const payment={id:'payment_joinpay',order_id:native.id,source:'JOINPAY',disposition:'APPLIED',amount_cents:'15908',currency:'CNY'};
 const row={...native,paid_confirmation_id:payment.id,native_payment_record:payment};
 assert.equal(projectAdminReadOrder('NATIVE',row,{...viewer,financeReadable:true}).payment.recordedAmount.amount,'159.08');
 assert.equal(projectAdminReadOrder('NATIVE',row,{...viewer,financeReadable:false}).payment.recordedAmount,null);
 for(const change of [{id:'other'},{order_id:'other'},{currency:'USD'},{disposition:'REVIEW_REQUIRED'},{source:'UNKNOWN'}])
  assert.equal(projectAdminReadOrder('NATIVE',{...row,native_payment_record:{...payment,...change}},{...viewer,financeReadable:true}).payment.recordedAmount,null);
});

test("实付合法0与大金额保持精确；缺原付款不回填订单应付",()=>{
 for(const [amount,expected]of [['0','0.00'],['9007199254740993123456','90071992547409931234.56']]){
  const p={id:'payment_1',order_id:native.id,source:'CONTROLLED',disposition:'APPLIED',amount_cents:amount,currency:'CNY'};
  assert.equal(projectAdminReadOrder('NATIVE',{...native,paid_confirmation_id:p.id,native_payment_record:p},{...viewer,financeReadable:true}).payment.recordedAmount.amount,expected);
 }
 assert.equal(projectAdminReadOrder('NATIVE',native,{...viewer,financeReadable:true}).payment.recordedAmount,null);
});

test("原生付款记录只在已选页面记录投影中按主键读取；不扩张筛选或旧单关联",()=>{
 const full=orderReadRelation(true),keys=orderReadKeyRelation(true),summary=orderReadRelation(true,true);
 assert.match(full,/p.id=o.paid_confirmation_id AND p.order_id=o.id AND p.disposition='APPLIED'/);
 assert.match(full,/'amount_cents',p.amount_cents::text/);assert.doesNotMatch(keys,/native_payment_record|payment_confirmation/);
 assert.doesNotMatch(summary,/native_payment_record|payment_confirmation/);
});


const prepaymentMoney=(amount:string)=>({currency:'CNY',unit:'yuan',amount,scale:2});
function prepaymentNative():Record<string,any>{
 const line=(itemId:string,pricingKind:string,unit:string,buyer:string,owner:string,quantity='1',unitQuantity='1')=>({itemId,pricingKind,unit,quantity,unitQuantity,
  buyerAmount:prepaymentMoney(buyer),ownerAmount:prepaymentMoney(owner),buyerUnitAmount:{...prepaymentMoney(buyer),scale:8},ownerUnitAmount:{...prepaymentMoney(owner),scale:8},platformAmount:prepaymentMoney('0.00')});
 return {...native,status:'PENDING_PAYMENT',rental_amount_cents:'10000',deposit_amount_cents:'500',quote_snapshot:{...native.quote_snapshot,priceVersionId:'original-price-only',
  lines:[line('frozen-haff','HAFF_RATIO','HAFF_BASE','99.00','50.00','100000000','1000000'),line('frozen-item','FIXED_UNIT','PIECE','1.00','0.50'),line('frozen-zero-day','FIXED_UNIT','DAY','0.00','0.00','0')],
  resourceTotal:prepaymentMoney('100.00'),tenantDeposit:prepaymentMoney('5.00'),ownerTotal:prepaymentMoney('50.50'),platformFullProfit:prepaymentMoney('49.50')}};
}
const unknownPrepayment=(basis:string)=>({basis,completeness:'UNKNOWN',haffRental:null,materialsPrepay:null});

test('prepayment: 原冻结买家行已折后分列，原金额与财务裁剪及输入均不变',()=>{
 const original=prepaymentNative(),saved=JSON.stringify(original);
 for(const financeReadable of [undefined,false,true])for(const internalQuote of [false,true]){
  const row=projectAdminReadOrder('NATIVE',original,{...viewer,financeReadable,internalQuote});
  assert.deepEqual(row.prepaymentBreakdown,{basis:'NATIVE_FROZEN_ORDER_QUOTE',completeness:'COMPLETE',haffRental:prepaymentMoney('99.00'),materialsPrepay:prepaymentMoney('1.00')});
  assert.deepEqual(row.amounts,{rental:prepaymentMoney('100.00'),deposit:prepaymentMoney('5.00'),totalDue:prepaymentMoney('105.00'),currency:'CNY'});
  assert.equal(row.payment.recordedAmount,null);assert.equal(row.quote.platformFullProfit===undefined,!internalQuote);
  assert.deepEqual(Object.keys(row.prepaymentBreakdown).sort(),['basis','completeness','haffRental','materialsPrepay']);
  assert.doesNotMatch(JSON.stringify(row.prepaymentBreakdown),/owner|platform|sourceRef|priceVersionId/);
 }
 assert.equal(JSON.stringify(original),saved,'reading the split never rewrites the frozen quote');
});

test('prepayment: 原生币种精度行身份与闭合异常只使新增拆分未知',()=>{
 const changes:Array<(row:Record<string,any>)=>void>=[
  r=>{r.currency='USD';},r=>{r.quote_snapshot.currency='USD';},
  r=>{r.quote_snapshot.lines[0].buyerAmount.currency='USD';},r=>{r.quote_snapshot.lines[0].buyerAmount.scale=8;},
  r=>{r.quote_snapshot.lines[0].buyerAmount.unit='cent';},r=>{r.quote_snapshot.lines[0].buyerAmount.amount='99.0';},
  r=>{r.quote_snapshot.lines[0].buyerAmount.amount=99.00;},r=>{r.quote_snapshot.lines[0].buyerAmount.amount='9.9e1';},
  r=>{r.quote_snapshot.lines[0].buyerAmount=null;},r=>{r.quote_snapshot.lines[1].pricingKind='UNRECOGNIZED';},
  r=>{r.quote_snapshot.lines[0].unit='PIECE';},r=>{r.quote_snapshot.lines[1].unit='HAFF_BASE';},
  r=>{r.quote_snapshot.lines[1].pricingKind='HAFF_RATIO';r.quote_snapshot.lines[1].unit='HAFF_BASE';},
  r=>{r.quote_snapshot.lines[1].itemId='frozen-haff';},r=>{r.quote_snapshot.lines[0].itemId='';},
  r=>{r.quote_snapshot.lines[0].buyerAmount.amount='98.99';},r=>{r.rental_amount_cents='10001';},
  r=>{r.quote_snapshot.tenantDeposit=prepaymentMoney('4.99');},r=>{r.quote_snapshot.tenantDeposit=null;},
  r=>{r.quote_snapshot.resourceTotal={...prepaymentMoney('100.00'),scale:8};},
 ];
 for(const change of changes){const input=prepaymentNative();change(input);const row=projectAdminReadOrder('NATIVE',input,viewer);assert.deepEqual(row.prepaymentBreakdown,unknownPrepayment('NATIVE_FROZEN_ORDER_QUOTE'));assert.equal(row.id,input.id);}
 assert.deepEqual(projectAdminReadOrder('NATIVE',native,viewer).prepaymentBreakdown,unknownPrepayment('NATIVE_FROZEN_ORDER_QUOTE'),'old empty-line snapshots keep their existing total without inventing a haff amount');
});

test('prepayment: 原生一分与超Number安全整数金额沿BigInt精确相加',()=>{
 const input=prepaymentNative();input.rental_amount_cents='9007199254740993123456';input.deposit_amount_cents='0';
 input.quote_snapshot.resourceTotal=prepaymentMoney('90071992547409931234.56');input.quote_snapshot.tenantDeposit=prepaymentMoney('0.00');
 input.quote_snapshot.lines[0].buyerAmount=prepaymentMoney('90071992547409931234.55');input.quote_snapshot.lines[1].buyerAmount=prepaymentMoney('0.01');
 const row=projectAdminReadOrder('NATIVE',input,viewer);
 assert.deepEqual(row.prepaymentBreakdown,{basis:'NATIVE_FROZEN_ORDER_QUOTE',completeness:'COMPLETE',haffRental:prepaymentMoney('90071992547409931234.55'),materialsPrepay:prepaymentMoney('0.01')});
 assert.equal(row.amounts.totalDue.amount,'90071992547409931234.56');
});

test('prepayment: 旧单只用原goods与expend，合法零与缺源分开且不重算原due',()=>{
 for(const [parts,expected]of [
  [{goods_money:'36.00',expend_pay_money:'0.00'},{basis:'LEGACY_ORIGINAL_ORDER',completeness:'COMPLETE',haffRental:prepaymentMoney('36.00'),materialsPrepay:prepaymentMoney('0.00')}],
  [{goods_money:null,expend_pay_money:'0.00'},{basis:'LEGACY_ORIGINAL_ORDER',completeness:'PARTIAL',haffRental:null,materialsPrepay:prepaymentMoney('0.00')}],
  [{goods_money:'0.00',expend_pay_money:undefined},{basis:'LEGACY_ORIGINAL_ORDER',completeness:'PARTIAL',haffRental:prepaymentMoney('0.00'),materialsPrepay:null}],
  [{goods_money:'0.00',expend_pay_money:'0.00'},{basis:'LEGACY_ORIGINAL_ORDER',completeness:'COMPLETE',haffRental:prepaymentMoney('0.00'),materialsPrepay:prepaymentMoney('0.00')}],
  [{goods_money:undefined,expend_pay_money:null},unknownPrepayment('LEGACY_ORIGINAL_ORDER')],
 ] as const){const row=projectAdminReadOrder('LEGACY',{...record,source_snapshot:{...record.source_snapshot,...parts}},viewer);assert.deepEqual(row.prepaymentBreakdown,expected);assert.equal(row.amounts.totalDue.amount,'66.00');assert.equal(row.payment.recordedAmount.amount,'66.00','the existing historical paid projection is unchanged');}
});

test('prepayment: 旧原金额格式异常不再使整行抛错，负数不粉饰为正常预付',()=>{
 for(const value of ['broken','36.0','3.6e1',36]){
  const input={...record,source_snapshot:{...record.source_snapshot,goods_money:value}},saved=JSON.stringify(input);
  const row=projectAdminReadOrder('LEGACY',input,viewer);
  assert.deepEqual(row.prepaymentBreakdown,unknownPrepayment('LEGACY_ORIGINAL_ORDER'));assert.equal(row.amounts.rental,null);assert.equal(row.amounts.totalDue.amount,'66.00');assert.equal(JSON.stringify(input),saved);
 }
 const negative=projectAdminReadOrder('LEGACY',{...record,source_snapshot:{...record.source_snapshot,goods_money:'-0.01',expend_pay_money:'1.00'}},viewer);
 assert.deepEqual(negative.prepaymentBreakdown,unknownPrepayment('LEGACY_ORIGINAL_ORDER'));assert.equal(negative.amounts.rental.amount,'0.99','valid signed historical arithmetic remains the old formula');
});

test('prepayment: 混源同ID页与详情按各自原件拆分，不增加SQL或扩展权限',async()=>{
 const fresh=prepaymentNative(),old={...record,id:fresh.id},options={keys:[{origin:'NATIVE',id:fresh.id},{origin:'LEGACY',id:fresh.id}],total:'2',records:[{origin:'NATIVE',id:fresh.id,record:fresh},{origin:'LEGACY',id:fresh.id,record:old}]};
 const pageClient=orderClient(options),page=await queryAdminReadOrders(pageClient.client,viewer,{page:1,pageSize:20});
 assert.equal(page.items[0]!.prepaymentBreakdown.basis,'NATIVE_FROZEN_ORDER_QUOTE');assert.equal(page.items[0]!.prepaymentBreakdown.haffRental.amount,'99.00');
 assert.equal(page.items[1]!.prepaymentBreakdown.basis,'LEGACY_ORIGINAL_ORDER');assert.equal(page.items[1]!.prepaymentBreakdown.haffRental.amount,'36.00');
 assert.equal(pageClient.statements.length,6,'continuation probe, key page, record page, savepoint, progress batch and its release');
 assert.equal(pageClient.statements.filter(s=>s.sql.includes('zzsh_order.rental_opening')).length,1);
 const detailClient=orderClient({records:[options.records[0]!]}),detail=await getAdminReadOrder(detailClient.client,viewer,fresh.id);assert.deepEqual(detail.order.prepaymentBreakdown,page.items[0]!.prepaymentBreakdown);
 for(const {sql}of [...pageClient.statements,...detailClient.statements]){assert.match(sql.trimStart(),/^(SELECT|WITH|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/);assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|FOR UPDATE|pg_advisory)\b/i);}
});

test('prepayment: 金额局部fail-soft不吞查询或范围异常',async()=>{
 const denied=Object.assign(new Error('synthetic query denied'),{code:'42501'}),client={query:async()=>{throw denied;}} as unknown as PoolClient;
 await assert.rejects(queryAdminReadOrders(client,viewer,{page:1,pageSize:20}),error=>error===denied);
 await assert.rejects(getAdminReadOrder(orderClient().client,viewer,'missing'),(error:any)=>error.status===404);
});

const progressRow=(overrides:Record<string,any>={})=>({id:'native-1',versionId:null,orderStatus:'PENDING_PAYMENT',asOf:'2026-10-25T00:00:00.000000Z',openingConfirmedAt:null,openingAny:false,intakeOpen:false,versionNo:null,kind:null,early:null,initiatorParty:null,versionHash:null,renterConfirmed:false,ownerConfirmed:false,renterRejected:false,ownerRejected:false,supportReviewed:false,approvalStatus:null,approvalRequestedBy:null,approvalDecidedBy:null,approvalPayloadHash:null,postedAt:null,...overrides});
async function progressOf(overrides:Record<string,any>={}){
 const {client}=orderClient({records:[{origin:'NATIVE',id:native.id,record:native}],progressRows:[progressRow(overrides)]});
 return (await getAdminReadOrder(client,viewer,native.id)).order.progress;
}
const readyFacts={versionId:'settlement-version-2',versionNo:2,kind:'SYSTEM',early:false,initiatorParty:'RENTER',versionHash:'a'.repeat(64),renterConfirmed:true,ownerConfirmed:true};

test('progress: 开租只认同单已确认opening，未付取消才是原生不适用',async()=>{
 assert.deepEqual(await progressOf(),{asOfUtc:'2026-10-25T00:00:00.000000Z',opening:{state:'NOT_STARTED',confirmedAtUtc:null},ending:{state:'NOT_STARTED',currentVersionNo:null,postedAtUtc:null}});
 assert.equal((await progressOf({openingAny:true})).opening.state,'AWAITING_CONFIRMATION');
 assert.equal((await progressOf({openingConfirmedAt:'2026-10-25T01:00:00.000000Z'})).opening.state,'CONFIRMED');
 const cancelled=await progressOf({orderStatus:'CANCELLED'});
 assert.deepEqual([cancelled.opening.state,cancelled.ending.state],['NOT_APPLICABLE','NOT_APPLICABLE']);
 const conflict=await progressOf({orderStatus:'CANCELLED',openingConfirmedAt:'2026-10-25T01:00:00.000000Z'});
 assert.equal(conflict.opening.state,'CONFIRMED','an opening row is not hidden by the order status');
 const draftConflict=await progressOf({orderStatus:'CANCELLED',openingAny:true});
 assert.equal(draftConflict.opening.state,'AWAITING_CONFIRMATION');
});

test('progress: 当前intake优先于旧费用版，posting优先于分类',async()=>{
 const pending=await progressOf({...readyFacts,intakeOpen:true});
 assert.deepEqual([pending.ending.state,pending.ending.currentVersionNo],['PENDING_CLASSIFICATION',2]);
 const posted=await progressOf({...readyFacts,intakeOpen:true,postedAt:'2026-10-25T02:00:00.000000Z'});
 assert.deepEqual([posted.ending.state,posted.ending.postedAtUtc],['POSTED','2026-10-25T02:00:00.000000Z']);
 const postedNoVersion=await progressOf({postedAt:'2026-10-25T02:00:00.000000Z'});
 assert.equal(postedNoVersion.ending.state,'POSTED');
 assert.equal(postedNoVersion.ending.currentVersionNo,null);
});

test('progress: 双方、客服复核、人工批准分别使用原判定，不把缺少依据画成已就绪',async()=>{
 assert.equal((await progressOf({versionId:'settlement-version-2',versionNo:2,kind:'SYSTEM',early:false,initiatorParty:'RENTER',versionHash:'a'.repeat(64)})).ending.state,'PENDING_PARTIES');
 assert.equal((await progressOf({...readyFacts,renterRejected:true})).ending.state,'PENDING_PARTIES');
 assert.equal((await progressOf({...readyFacts,ownerConfirmed:false})).ending.state,'PENDING_PARTIES');
 assert.equal((await progressOf({...readyFacts,early:true})).ending.state,'PENDING_SUPPORT_REVIEW');
 assert.equal((await progressOf({...readyFacts,early:true,supportReviewed:true})).ending.state,'READY');
 assert.equal((await progressOf(readyFacts)).ending.state,'READY');
 const manual={...readyFacts,kind:'MANUAL_ADJUSTMENT'};
 assert.equal((await progressOf(manual)).ending.state,'PENDING_APPROVAL');
 assert.equal((await progressOf({...manual,approvalStatus:'PENDING',approvalRequestedBy:'admin-a',approvalPayloadHash:'a'.repeat(64)})).ending.state,'PENDING_APPROVAL');
 assert.equal((await progressOf({...manual,approvalStatus:'APPROVED',approvalRequestedBy:'admin-a',approvalDecidedBy:'admin-a',approvalPayloadHash:'a'.repeat(64)})).ending.state,'PENDING_APPROVAL');
 assert.equal((await progressOf({...manual,approvalStatus:'APPROVED',approvalRequestedBy:'admin-a',approvalDecidedBy:'admin-b',approvalPayloadHash:'b'.repeat(64)})).ending.state,'PENDING_APPROVAL');
 assert.equal((await progressOf({...manual,approvalStatus:'APPROVED',approvalRequestedBy:'admin-a',approvalDecidedBy:'admin-b',approvalPayloadHash:'a'.repeat(64)})).ending.state,'READY');
 assert.equal((await progressOf({...readyFacts,kind:'UNRECOGNIZED'})).ending.state,'UNKNOWN');
 assert.equal((await progressOf({versionId:'settlement-version-2',versionNo:2,kind:'SYSTEM',early:false,initiatorParty:'RENTER'})).ending.state,'UNKNOWN');
});

test('progress: 单页一次有界批读；缺失或无权关系为UNKNOWN，连接错误仍抛出',async()=>{
 const page=orderClient({keys:[{origin:'NATIVE',id:'native-1'},{origin:'NATIVE',id:'native-2'},{origin:'LEGACY',id:'legacy-1'}],total:'3',
  records:[{origin:'NATIVE',id:'native-1',record:native},{origin:'NATIVE',id:'native-2',record:{...native,id:'native-2'}},{origin:'LEGACY',id:'legacy-1',record}],
  progressRows:[progressRow(),progressRow({id:'native-2',orderStatus:'CANCELLED'})]});
 const result=await queryAdminReadOrders(page.client,viewer,{page:1,pageSize:20});
 assert.equal(result.items[0]!.progress.ending.state,'NOT_STARTED');
 assert.equal(result.items[1]!.progress.opening.state,'NOT_APPLICABLE');
 assert.equal('progress' in result.items[2]!,false,'legacy carries its source stage, not a native progress shell');
 const progressStatements=page.statements.filter(s=>s.sql.includes('zzsh_order.rental_opening'));
 assert.equal(progressStatements.length,1);
 assert.deepEqual(progressStatements[0]!.values,[['native-1','native-2']]);
 assert.match(progressStatements[0]!.sql,/transaction_timestamp\(\)/);
 assert.match(progressStatements[0]!.sql,/superseded_at IS NULL/);
 assert.doesNotMatch(progressStatements[0]!.sql,/FOR UPDATE|FOR SHARE|INSERT|UPDATE|DELETE/);
 for(const code of ['42P01','42501']){
  const unavailable=orderClient({records:[{origin:'NATIVE',id:native.id,record:native}],progressError:Object.assign(new Error(code),{code})});
  assert.deepEqual((await getAdminReadOrder(unavailable.client,viewer,native.id)).order.progress,{asOfUtc:null,opening:{state:'UNKNOWN',confirmedAtUtc:null},ending:{state:'UNKNOWN',currentVersionNo:null,postedAtUtc:null}});
 }
 const connection=Object.assign(new Error('synthetic disconnect'),{code:'ECONNRESET'}),broken=orderClient({records:[{origin:'NATIVE',id:native.id,record:native}],progressError:connection});
 await assert.rejects(()=>getAdminReadOrder(broken.client,viewer,native.id),error=>error===connection);
});

test('progress: 缺表/无权后回滚保存点，事务恢复并继续后续双方摘要',async()=>{
 for(const code of ['42P01','42501']){
  const statements:string[]=[];let aborted=false,inSavepoint=false;
  const client={query:async(sql:string,values:unknown[]=[])=>{
   statements.push(sql);
   if(sql.startsWith('SAVEPOINT')){inSavepoint=true;return{rows:[]};}
   if(sql.startsWith('ROLLBACK TO SAVEPOINT')){if(!inSavepoint)throw new Error('missing savepoint');aborted=false;return{rows:[]};}
   if(sql.startsWith('RELEASE SAVEPOINT')){inSavepoint=false;return{rows:[]};}
   if(aborted)throw Object.assign(new Error('current transaction is aborted'),{code:'25P02'});
   if(sql.includes('zzsh_order.rental_opening')){aborted=true;throw Object.assign(new Error(code),{code});}
   if(sql.includes('to_regclass'))return{rows:[{ready:false}]};
   if(sql.includes('AS keys'))return{rows:[{total:'1',keys:[{origin:'NATIVE',id:native.id}]}]};
   if(sql.includes('SELECT x.origin,x.id,x.record'))return{rows:[{origin:'NATIVE',id:native.id,record:native}]};
   if(sql.includes('"phoneNumber" AS phone'))return{rows:[{id:'owner',name:'Owner',image:null,phone:'13800138000'},{id:'renter',name:'Renter',image:null,phone:'13900139000'}]};
   return{rows:[]};
  }} as unknown as PoolClient;
  const page=await queryAdminReadOrders(client,{...viewer,permissions:new Set(['user.directory.read'])},{page:1,pageSize:20});
  assert.deepEqual(page.items[0]!.progress,{asOfUtc:null,opening:{state:'UNKNOWN',confirmedAtUtc:null},ending:{state:'UNKNOWN',currentVersionNo:null,postedAtUtc:null}});
  assert.equal(page.items[0]!.ownerSummary.name,'Owner','the directory read still runs after the transaction is recovered');
  assert.equal(page.items[0]!.renterSummary.name,'Renter');
  assert.ok(statements.some(sql=>sql.startsWith('ROLLBACK TO SAVEPOINT')));
  assert.equal(statements.filter(sql=>sql.includes('zzsh_order.rental_opening')).length,1);
  assert.equal(statements.some(sql=>sql.includes('25P02')),false);
 }
});

test('party summaries: 仅真实目录权限、整页去重一次批读，无权限不查',async()=>{
 const keys=[{origin:'NATIVE',id:'native-1'},{origin:'LEGACY',id:'legacy-1'}];
 const records=[{origin:'NATIVE',id:'native-1',record:native},{origin:'LEGACY',id:'legacy-1',record}];
 const directoryRows=[{id:'owner',name:'Owner',image:'owner.png',phone:'13800138000'},{id:'renter',name:'Renter',image:null,phone:'13900139000'}];
 const allowed=orderClient({keys,total:'2',records,progressRows:[progressRow()],directoryRows});
 const page=await queryAdminReadOrders(allowed.client,{...viewer,permissions:new Set(['user.directory.read'])},{page:1,pageSize:20});
 assert.equal(page.items[0]!.ownerSummary.maskedPhone,'138****8000');
 assert.equal(page.items[0]!.renterSummary.maskedPhone,'139****9000');
 assert.equal(page.items[1]!.ownerSummary.name,'Owner','the legacy row uses the same authorized summary read');
 assert.equal(page.items[1]!.renterSummary.name,'Renter');
 const directory=allowed.statements.filter(s=>s.sql.includes('"phoneNumber" AS phone'));
 assert.equal(directory.length,1);
 assert.deepEqual([...new Set(directory[0]!.values[0] as string[])].sort(),['owner','renter']);
 const denied=orderClient({keys,total:'2',records,progressRows:[progressRow()],directoryRows});
 const without=await queryAdminReadOrders(denied.client,viewer,{page:1,pageSize:20});
 assert.equal('ownerSummary' in without.items[0]!,false);
 assert.equal('renterSummary' in without.items[0]!,false);
 assert.equal(denied.statements.some(s=>s.sql.includes('"phoneNumber" AS phone')),false);
 const notGranted=orderClient({keys,total:'2',records,progressRows:[progressRow()],directoryRows});
 const noGrant=await queryAdminReadOrders(notGranted.client,{...viewer,permissions:new Set(['order.read'])},{page:1,pageSize:20});
 assert.equal('ownerSummary' in noGrant.items[0]!,false);
 assert.equal(notGranted.statements.some(s=>s.sql.includes('"phoneNumber" AS phone')),false);
});

function progressRecoveryFailure(originalCode:string,phase:'rollback'|'release'){
 const original=Object.assign(new Error('synthetic original progress failure'),{code:originalCode});
 const recovery=Object.assign(new Error('synthetic recovery disconnect'),{code:'ECONNRESET'});
 const state={aborted:false,disconnected:false,savepoint:false,afterRecoveryFailure:0};
 const client={query:async(sql:string)=>{
  if(sql.startsWith('SAVEPOINT')){state.savepoint=true;return{rows:[]};}
  if(sql.startsWith('ROLLBACK TO SAVEPOINT')){if(phase==='rollback'){state.disconnected=true;throw recovery;}assert(state.savepoint);state.aborted=false;return{rows:[]};}
  if(sql.startsWith('RELEASE SAVEPOINT')){if(phase==='release'){state.disconnected=true;throw recovery;}state.savepoint=false;return{rows:[]};}
  if(state.disconnected){state.afterRecoveryFailure++;throw recovery;}
  if(state.aborted)throw Object.assign(new Error('transaction is aborted'),{code:'25P02'});
  if(sql.includes('zzsh_order.rental_opening')){state.aborted=true;throw original;}
  if(sql.includes('to_regclass'))return{rows:[{ready:false}]};
  if(sql.includes('AS keys'))return{rows:[{total:'1',keys:[{origin:'NATIVE',id:native.id}]}]};
  if(sql.includes('SELECT x.origin,x.id,x.record'))return{rows:[{origin:'NATIVE',id:native.id,record:native}]};
  return{rows:[]};
 }} as unknown as PoolClient;
 return{client,original,recovery,state};
}

test('progress: 可选关系错误只有在保存点完整恢复后降级，恢复断连立即抛出',async()=>{
 for(const code of ['42P01','42501'])for(const phase of ['rollback','release'] as const){
  const f=progressRecoveryFailure(code,phase);
  await assert.rejects(queryAdminReadOrders(f.client,viewer,{page:1,pageSize:20}),error=>error===f.recovery);
  assert.equal(f.state.disconnected,true);assert.equal(f.state.afterRecoveryFailure,0,'no later SQL after unconfirmed recovery');
 }
});

test('progress: 非可选原错误不被保存点恢复错误替换',async()=>{
 for(const code of ['ECONNRESET','57014','XX000']){
  const f=progressRecoveryFailure(code,'rollback');
  await assert.rejects(queryAdminReadOrders(f.client,viewer,{page:1,pageSize:20}),error=>error===f.original);
  assert.equal(f.state.afterRecoveryFailure,0);
 }
});

test('progress: 提前结算先完成双方决定再客服复核，人工调整仍先批准',async()=>{
 const early={...readyFacts,early:true,ownerConfirmed:false,supportReviewed:false};
 assert.equal((await progressOf(early)).ending.state,'PENDING_PARTIES');
 assert.equal((await progressOf({...early,ownerRejected:true})).ending.state,'PENDING_PARTIES');
 assert.equal((await progressOf({...early,ownerConfirmed:true})).ending.state,'PENDING_SUPPORT_REVIEW');
 assert.equal((await progressOf({...early,ownerConfirmed:true,supportReviewed:true})).ending.state,'READY');
 assert.equal((await progressOf({...early,kind:'MANUAL_ADJUSTMENT',renterConfirmed:false,approvalStatus:'PENDING',approvalRequestedBy:'admin-a',approvalPayloadHash:'a'.repeat(64)})).ending.state,'PENDING_APPROVAL');
});
