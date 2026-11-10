import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { listUnifiedUserOrders, parseUnifiedOrderQuery } from "../src/order/unified-user-order-read";
import { projectUserLegacyOrder } from "../src/order/legacy-user-order-read";

const record = { id:"same-id",displayNo:"ORDER-1",sourceOrderStatus:4,sourcePayStatus:1,ownerUserId:"owner",renterUserId:"renter",gameId:"g",title:null,accountId:"a",accountDisplayNo:null,accountReadable:false,createdAt:null,paidAt:null,cancelledAt:null,completedAt:null,dueCents:"6600",paidCents:"6600",depositCents:"0",goodsYuan:"60.00",itemsYuan:"6.00",refundYuan:null };
test("unified query validates subject-independent bounded filters",()=>{
 for(const query of ["userId=owner","party=x","limit=0","limit=101","limit=1e2","party=owner&party=renter","status=bad","accountId=a/b","cursor=","orderNo=","orderNo=%20x","createdFrom=2026-02-30","createdFrom=2026-11-03&createdTo=2026-11-02","stage=OTHER"]){
  assert.throws(()=>parseUnifiedOrderQuery(new URLSearchParams(query)),Error,query);
 }
 assert.deepEqual(parseUnifiedOrderQuery(new URLSearchParams()),{party:"renter",limit:20});
assert.deepEqual(parseUnifiedOrderQuery(new URLSearchParams("view=IN_PROGRESS")),{party:"renter",limit:20,view:"IN_PROGRESS"});
assert.throws(()=>parseUnifiedOrderQuery(new URLSearchParams("status=PAID&view=IN_PROGRESS")),Error);
assert.throws(()=>parseUnifiedOrderQuery(new URLSearchParams("view=OTHER")),Error);

 assert.deepEqual(parseUnifiedOrderQuery(new URLSearchParams("party=owner&orderNo=%E6%97%A7_%25%E5%8D%95&createdFrom=2026-09-01&createdTo=2026-11-03&stage=UNKNOWN")),{party:"owner",limit:20,orderNo:"旧_%单",createdFrom:"2026-09-01",createdTo:"2026-11-03",stage:"UNKNOWN"});
});
test("unified keyset binds subject, filters and source while retaining nullable dates",async()=>{
 let sql="",params:unknown[]=[];
 const row={origin:"LEGACY",id:"same-id",createdAt:null,record};
 const client={query:async(s:string,p:unknown[])=>{if(s.includes("visible_orders")){sql=s;params=p;}return {rows:[row,row]};}} as unknown as PoolClient;
 const result=await listUnifiedUserOrders(client,"renter",{party:"renter",limit:1});
 assert.equal(result.subjectId,"renter");
 assert.equal(result.items.length,1);assert.equal(result.items[0]!.readOnly,true);
 assert.equal((result.items[0]!.source as {origin:string}).origin,"LEGACY");
 assert.equal("ownerUserId" in result.items[0]!,false);
 assert.match(sql,/UNION ALL/);assert.match(sql,/o.renter_user_id\}=|o.renter_user_id=\$1/);
 assert.match(sql,/l.renter_user_id=\$1/);assert.match(sql,/NULLS LAST/);assert.match(sql,/x.origin COLLATE "C"/);
 const cursor=result.nextCursor!;
 await listUnifiedUserOrders(client,"renter",{party:"renter",limit:1,cursor});
 assert.deepEqual(params.slice(3),[true,null,"LEGACY","same-id",2,null,null,null,null]);
 for(const input of [{user:"stranger",party:"renter" as const},{user:"renter",party:"owner" as const}]){
  await assert.rejects(()=>listUnifiedUserOrders(client,input.user,{party:input.party,limit:1,cursor}),e=>(e as {status:number}).status===409);
 }
 await assert.rejects(()=>listUnifiedUserOrders(client,"renter",{party:"renter",limit:1,status:"PAID",cursor}),e=>(e as {status:number}).status===409);
 await assert.rejects(()=>listUnifiedUserOrders(client,"renter",{party:"renter",limit:1,orderNo:"ORDER-1",cursor}),e=>(e as {status:number}).status===409);
});

test("stage search is bounded and returns a continuation even when 500 records are unclassified",async()=>{
 const rows=Array.from({length:505},(_,i)=>{const id=`legacy-${String(504-i).padStart(4,"0")}`;return {origin:"LEGACY",id,createdAt:null,record:{...record,id,sourceOrderStatus:99}};});
 const calls:unknown[][]=[];
 const client={query:async(s:string,p:unknown[]=[])=>{
  if(s.includes("visible_orders")){calls.push(p);const start=p[3]?rows.findIndex(row=>row.id===p[6])+1:0;return {rows:rows.slice(start,start+Number(p[7]))};}
  return {rows:[]};
 }} as unknown as PoolClient;
 const first=await listUnifiedUserOrders(client,"renter",{party:"renter",stage:"POSTED",limit:20});
 assert.equal(first.items.length,0);assert.equal(first.scanIncomplete,true);assert.equal(first.stageUnknownObserved,true);assert.ok(first.nextCursor);assert.equal(calls.length,5);
 const next=await listUnifiedUserOrders(client,"renter",{party:"renter",stage:"POSTED",limit:20,cursor:first.nextCursor!});
 assert.equal(next.items.length,0);assert.equal(next.nextCursor,null);assert.equal(next.stageUnknownObserved,true);
 const unknown=await listUnifiedUserOrders(client,"renter",{party:"renter",stage:"UNKNOWN",limit:2});
 assert.equal(unknown.items.length,2);assert.ok(unknown.nextCursor);
 const unknownNext=await listUnifiedUserOrders(client,"renter",{party:"renter",stage:"UNKNOWN",limit:2,cursor:unknown.nextCursor!});
 assert.equal(new Set([...unknown.items,...unknownNext.items].map(item=>item.id)).size,4);
});

test("known source stage maps by viewer; a current head takes precedence and terminal orders never match renting",()=>{
 for(const [status,payment,expected] of [[1,0,"NONE"],[2,1,"OPENING_PENDING"],[3,1,"RENTING"],[4,1,"NONE"],[5,1,"NONE"],[3,0,"UNKNOWN"]] as const){
  assert.equal(projectUserLegacyOrder({...record,sourceOrderStatus:status,sourcePayStatus:payment},"renter").stage.code,expected);
 }
 const ownerTurn={...record,sourceOrderStatus:3,continuationStage:8};
 assert.equal(projectUserLegacyOrder({...record,sourceOrderStatus:3,sourcePayStatus:0},"renter").source.statusLabel,"状态待核实");
 assert.equal(projectUserLegacyOrder(ownerTurn,"owner").stage.code,"DECISION_PENDING");
 assert.equal(projectUserLegacyOrder(ownerTurn,"renter").stage.code,"DECISION_WAITING");
 assert.equal(projectUserLegacyOrder({...ownerTurn,continuationStage:9},"renter").stage.code,"DECISION_PENDING");
 assert.equal(projectUserLegacyOrder({...ownerTurn,continuationStage:4},"owner").status,"COMPLETED");
 assert.equal(projectUserLegacyOrder({...ownerTurn,continuationStage:4},"owner").stage.code,"NONE");
 assert.equal(projectUserLegacyOrder(ownerTurn,"owner").stage.viewerActionRequired,false);
 assert.equal(projectUserLegacyOrder(ownerTurn,"owner").payment.recordedAmount,null);
 assert.equal(projectUserLegacyOrder(ownerTurn,"renter").payment.recordedAmount?.amount,"66.00");
 for(const [id,party] of [["stranger","owner"],["renter","owner"],["owner","renter"]] as const)
   assert.throws(()=>projectUserLegacyOrder(ownerTurn,id,party),e=>(e as {status:number}).status===404);
});

test("stage-filtered pages mix both sources without same-id collision or skipped cursor rows",async()=>{
 const date="2026-11-01T00:00:00.000000Z";
 const legacy=(id:string,sourceOrderStatus:number,continuationStage?:number)=>({origin:"LEGACY",id,createdAt:date,record:{...record,id,sourceOrderStatus,continuationStage}});
 const rows=[{origin:"NATIVE",id:"same-id",createdAt:date,record:{id:"same-id",displayNo:"NEW",status:"PAID",rentalAmountCents:"6500",depositAmountCents:"5000",quoteSnapshot:{lines:[]}}},
   legacy("superseded",3,4),legacy("same-id",3),legacy("cancelled",5),legacy("active",8,3)];
 const client={query:async(s:string,p:unknown[]=[])=>{
  if(s.includes("visible_orders")){
   assert.match(s,/o\.owner_user_id=\$1/);assert.match(s,/l\.owner_user_id=\$1/);
   const offset=p[3]?rows.findIndex(row=>row.origin===p[5]&&row.id===p[6])+1:0;
   return {rows:rows.slice(offset,offset+Number(p[7]))};
  }
  if(s.includes("user-settlement-stage-batch"))return {rows:[{id:"same-id",orderStatus:"PAID",viewerParty:"OWNER",posted:false,intakeOpen:false,currentVersionNo:null,rentalStarted:true}]};
  return {rows:[]};
 }} as unknown as PoolClient;
 let cursor:string|undefined;const found:string[]=[];
 for(let page=0;page<3;page++){
  const result=await listUnifiedUserOrders(client,"owner",{party:"owner",stage:"RENTING",limit:1,cursor});
  assert.equal(result.stageUnknownObserved,undefined);
  assert.equal(result.items.length,1);
  const item=result.items[0]!;
  assert.equal((item.stage as {code:string}).code,"RENTING");
  found.push(`${(item.source as {origin:string}).origin}:${item.id}`);
  cursor=result.nextCursor??undefined;
 }
 assert.equal(cursor,undefined);
 assert.deepEqual(found,["NATIVE:same-id","LEGACY:same-id","LEGACY:active"]);
});

test("server applies subject, literal order number and Beijing date bounds before pagination",async()=>{
 let sql="",params:unknown[]=[];
 const client={query:async(s:string,p:unknown[]=[])=>{if(s.includes("visible_orders")){sql=s;params=p;}return {rows:[]};}} as unknown as PoolClient;
 const result=await listUnifiedUserOrders(client,"owner-1",{party:"owner",orderNo:"旧_%单",createdFrom:"2026-09-01",createdTo:"2026-11-03",limit:20});
 assert.equal(result.subjectId,"owner-1");assert.deepEqual(result.items,[]);
 assert.match(sql,/o.owner_user_id=\$1/);assert.match(sql,/l.owner_user_id=\$1/);
 assert.match(sql,/strpos\(lower\(o.display_no\),lower\(\$9\)\)/);assert.match(sql,/strpos\(lower\(l.original_order_no\),lower\(\$9\)\)/);
 assert.match(sql,/AT TIME ZONE 'Asia\/Shanghai'/);assert.deepEqual(params.slice(8),["旧_%单","2026-09-01","2026-11-03",null]);
});

test("owner refund summary authorizes the owner and exposes only minimal progress", async()=>{
 const {readOwnerRefundMinimalSummary}=await import("../src/finance/owner-refund-summary-read");
 const actor={userId:"owner-1",sessionId:"session-1"};
 const calls:string[]=[];
 const client={query:async(sql:string)=>{
  calls.push(sql);
  if(sql.includes('SELECT "suspended"'))return{rows:[{suspended:false}]};
  if(sql.includes('user_identity_state'))return{rows:[]};
  if(sql.includes('"session"'))return{rows:[{}],rowCount:1};
  if(sql.includes('o.owner_user_id'))return{rows:[{status:"CANCELLED",owner_user_id:"owner-1",as_of:"2026-11-06T00:00:00.000000Z"}]};
  if(sql.includes('channel_refund_intent'))return{rows:[{state:"PROCESSING",count:"1"}]};
  throw Error("unexpected query");
 }} as any;
 const result=await readOwnerRefundMinimalSummary(client,actor,{orderId:"order-1"});
 assert.equal(result.progress,"PROCESSING");assert.equal(result.openIntentCount,1);
 assert.deepEqual(Object.keys(result).sort(),["asOf","contractVersion","label","note","openIntentCount","orderId","orderStatus","progress","subjectId"].sort());
 calls.length=0;
 await assert.rejects(()=>readOwnerRefundMinimalSummary(client,{...actor,userId:"stranger"},{orderId:"order-1"}),(error:any)=>error.status===404);
 assert.equal(calls.some(sql=>sql.includes('channel_refund_intent')),false,"unauthorized actor cannot read refund facts");
});

test("owner sees approved prestart refund waiting for dispatch and failed refunds require help",async()=>{
 const {readOwnerRefundMinimalSummary}=await import("../src/finance/owner-refund-summary-read");
 let state:"none"|"failed"|"unknown"|"unavailable"="none";
 const client={query:async(sql:string)=>{
  if(sql.includes('SELECT "suspended"'))return{rows:[{suspended:false}]};
  if(sql.includes('user_identity_state'))return{rows:[]};
  if(sql.includes('"session"'))return{rows:[{}],rowCount:1};
  if(sql.includes('o.owner_user_id'))return{rows:[{status:"CANCELLED",cancel_reason:"PRESTART_TERMINATED",paid_confirmation_id:"payment-1",owner_user_id:"owner-1",as_of:"2026-11-06T00:00:00.000000Z"}]};
  if(sql.includes('channel_refund_intent'))return{rows:state==="none"||state==="unavailable"?[]:[{state:state==="failed"?"FAILED":"NEW_UNKNOWN_STATE",count:"1"}]};
  if(sql.includes('has_table_privilege'))return{rows:[{ready:state!=="unavailable"}]};
  if(sql.includes('prestart_liability_complete'))return{rows:[{ready:true}]};
  throw Error("unexpected query");
 }} as any;
 const actor={userId:"owner-1",sessionId:"session-1"};
 assert.equal((await readOwnerRefundMinimalSummary(client,actor,{orderId:"order-1"})).progress,"PROCESSING");
 state="failed";assert.equal((await readOwnerRefundMinimalSummary(client,actor,{orderId:"order-1"})).progress,"NEEDS_REVIEW");
 state="unknown";assert.equal((await readOwnerRefundMinimalSummary(client,actor,{orderId:"order-1"})).progress,"UNKNOWN");
 state="unavailable";assert.equal((await readOwnerRefundMinimalSummary(client,actor,{orderId:"order-1"})).progress,"UNKNOWN");
});

test("prestart owner refund lookup cannot count an unrelated refund attempt",async()=>{
 const {readOwnerRefundMinimalSummary}=await import("../src/finance/owner-refund-summary-read");
 const client={query:async(sql:string,values:unknown[])=>{
  if(sql.includes('SELECT "suspended"'))return{rows:[{suspended:false}]};
  if(sql.includes('user_identity_state'))return{rows:[]};
  if(sql.includes('"session"'))return{rows:[{}],rowCount:1};
  if(sql.includes('o.owner_user_id'))return{rows:[{status:"CANCELLED",cancel_reason:"PRESTART_TERMINATED",paid_confirmation_id:"payment-1",owner_user_id:"owner-1",as_of:"2026-11-06T00:00:00.000000Z"}]};
  if(sql.includes('channel_refund_intent')){assert.match(sql,/basis_kind='PRESTART_TERMINATION'/);assert.deepEqual(values,["order-1",true,"payment-1"]);return{rows:[]};}
  if(sql.includes('has_table_privilege'))return{rows:[{ready:true}]};
  if(sql.includes('prestart_liability_complete'))return{rows:[{ready:true}]};
  throw Error("unexpected query");
 }} as any;
 const result=await readOwnerRefundMinimalSummary(client,{userId:"owner-1",sessionId:"session-1"},{orderId:"order-1"});
 assert.equal(result.progress,"PROCESSING");
});

test("work-view predicate keeps paid or unpaid active orders and only proven unresolved native refunds", async()=>{
 let sql="",args:unknown[]=[];
 const client={query:async(s:string,v:unknown[]=[])=>{
  if(s.includes("to_regclass"))return{rows:[{ready:false}]};
  if(s.includes("WITH visible_orders")){sql=s;args=v;return{rows:[]};}
  return{rows:[]};
 }} as any;
 await listUnifiedUserOrders(client,"owner-1",{party:"owner",limit:20,view:"IN_PROGRESS"});
 assert.equal(args[11],"IN_PROGRESS");
 assert.match(sql,/o\.owner_user_id=\$1/);
 assert.match(sql,/o\.status IN \('PENDING_PAYMENT','PAID'\)/);
 assert.match(sql,/channel_refund_intent[\s\S]*i\.order_id=o\.id[\s\S]*'REVIEW_REQUIRED'/);
});
