import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {canonicalize} from "../src/supply/content-hash";
import {sha256Hex} from "../src/supply/supply-util";
import {importLegacyHistoricalLiability,type LegacyHistoricalLiabilityInput} from "../src/order/legacy-liability-intake";
import {legacyBinding} from "./legacy-continuation-fixture";
const actor={realm:"admin" as const,userId:"admin_fixture",sessionId:"session_fixture",requestId:"req_fixture"};
const e:typeof import("../src/order/legacy-continuation-evidence")=require("../src/order/legacy-continuation-evidence");
function arrange(t:import("node:test").TestContext,classification:LegacyHistoricalLiabilityInput["classification"]){
 const auth:typeof import("../src/auth/auth-security")=require("../src/auth/auth-security"),access:typeof import("../src/auth/admin-authorization")=require("../src/auth/admin-authorization");
 t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:true,passwordChangeRequired:false,permissions:new Set(["supply.catalog.manage","order.read"])}));
 const stage=classification==="REFUND_RECORD_EXISTS"?5:4,state=classification==="DETAINED"?"2":classification==="POSTED_CONFISCATION"?"3":"0",source={id:"7",order_status:String(stage),pay_is:"1",is_settle:state,return_order_money:"87.00",deposit_amount:"57.00"},parentSourceDigest=sha256Hex(canonicalize(source));
 t.mock.method(e,"readLegacyContinuationBinding",async()=>({...legacyBinding,sourceOrderStatus:stage,sourceDigest:parentSourceDigest}));t.mock.method(e,"lockLegacyContinuationOrder",async()=>({head:null,duties:[]}));
 const calls:Array<{sql:string;v:unknown[]}>=[],client={query:async(sql:string,v:unknown[]=[])=>{calls.push({sql,v});return {rows:sql.includes("source_snapshot AS source")?[{source,deposit:"5700"}]:[],rowCount:0};}} as unknown as PoolClient;
 const canonical=canonicalize({...source,detain_money:"5.00"}),input:LegacyHistoricalLiabilityInput={orderId:legacyBinding.id,parentSourceDigest,classification,evidenceRef:"FIXTURE_FROZEN_SOURCE",settlementRecord:{canonical,digest:sha256Hex(canonical)}};
 if(classification==="REFUND_RECORD_EXISTS"){const c=canonicalize({id:"92",order_id:"7",status:"SOURCE_UNKNOWN"});input.refundRecord={canonical:c,digest:sha256Hex(c)};}
 return {calls,client,input};
}
test("18 history and one held source retain exact net duties while six legacy handled and 61 refund records keep distinct responsibility",async t=>{
 for(const classification of ["COMPLETED_UNREFUNDED","DETAINED","POSTED_CONFISCATION","REFUND_RECORD_EXISTS"] as const){
  const p=arrange(t,classification);await importLegacyHistoricalLiability(p.client,actor,p.input);const duty=p.calls.find(c=>c.sql.includes("INSERT INTO zzsh_order.legacy_order_duty("));
  if(classification==="COMPLETED_UNREFUNDED"||classification==="DETAINED"){assert(duty);assert.equal(duty.v[2],"RENTER_REFUND");assert.equal(duty.v[5],"8200");assert.equal(duty.v[6],"PENDING");assert.equal(duty.v[7],classification);assert.equal(duty.v[9],null);}
  else if(classification==="POSTED_CONFISCATION"){assert(duty);assert.equal(duty.v[2],"DEPOSIT_COMPENSATION");assert.equal(duty.v[5],"5700");assert.equal(duty.v[6],"SETTLED");assert.equal(duty.v[9],"LEGACY_RECORDS");assert(!duty.sql.includes("settled_ref"));}
  else assert.equal(duty,undefined);
  const audit=p.calls.find(c=>c.sql.includes('"zzsh_iam"."audit_event"'));assert(audit);assert.equal(JSON.parse(String(audit.v[10])).channelState,"UNKNOWN");assert(!p.calls.some(c=>/settlement_ledger_entry|finance_event|rental_order\s*\(/.test(c.sql)));t.mock.restoreAll();
 }
});
test("missing detain column is not an implicit zero and drift from frozen selected parent fields is refused",async t=>{
 const p=arrange(t,"COMPLETED_UNREFUNDED");const raw=JSON.parse(p.input.settlementRecord.canonical);delete raw.detain_money;let canonical=canonicalize(raw);p.input.settlementRecord={canonical,digest:sha256Hex(canonical)};
 await assert.rejects(()=>importLegacyHistoricalLiability(p.client,actor,p.input),/LIABILITY_SOURCE_EVIDENCE_MISMATCH/);raw.detain_money="5.00";raw.return_order_money="88.00";canonical=canonicalize(raw);p.input.settlementRecord={canonical,digest:sha256Hex(canonical)};await assert.rejects(()=>importLegacyHistoricalLiability(p.client,actor,p.input),/LIABILITY_SOURCE_EVIDENCE_MISMATCH/);assert(!p.calls.some(q=>q.sql.includes("INSERT INTO zzsh_order.legacy_order_duty(")));
});
