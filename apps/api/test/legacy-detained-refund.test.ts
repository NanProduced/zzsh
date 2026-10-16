import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {canonicalize} from "../src/supply/content-hash";
import {fingerprintRequest,sha256Hex,withIdempotency} from "../src/supply/supply-util";
import {initialLegacyFacts,legacyEconomicDutyId,type LegacyDutyRow,type LegacyHeadRow,type LegacyEvidenceRow} from "../src/order/legacy-continuation-model";
import {importLegacyHistoricalLiability,type LegacyHistoricalLiabilityInput} from "../src/order/legacy-liability-intake";
import {applyLegacyContinuationCommand,parseLegacyMutation} from "../src/order/legacy-continuation-command";
import {readLegacyDutyBasis} from "../src/order/legacy-duty-basis";
import {planLegacyContinuation} from "../src/order/legacy-continuation-calc";
import {legacyBinding,legacyEvidence,legacyQuantities,legacySource} from "./legacy-continuation-fixture";
const e:typeof import("../src/order/legacy-continuation-evidence")=require("../src/order/legacy-continuation-evidence"),auth:typeof import("../src/auth/auth-security")=require("../src/auth/auth-security"),access:typeof import("../src/auth/admin-authorization")=require("../src/auth/admin-authorization");
const actor={realm:"admin" as const,userId:"fixture_admin",sessionId:"fixture_session",requestId:"req_fixture"};
function arrange(t:TestContext,gross:string|null="87.00",detain:string|null="5.00"){
 const source=legacySource({orderStatus:"4",isSettle:"2",quantities:legacyQuantities("10.00"),saleEarnings:"13.00",returnOrderMoney:gross,detainMoney:detain}),snapshot={id:"7",order_status:"4",pay_is:"1",is_settle:"2",return_order_money:gross,deposit_amount:"57.00"},sourceDigest=sha256Hex(canonicalize(snapshot)),binding={...legacyBinding,sourceOrderStatus:4,sourceDigest,completedAt:"2026-10-01T00:00:00.123456Z"};
 const state:{head:LegacyHeadRow|null;row:LegacyEvidenceRow;duties:LegacyDutyRow[]}={head:null,row:{...legacyEvidence(initialLegacyFacts(source)),sourceDigest},duties:[]},receipts=new Map<string,{requestFingerprint:string;responseStatus:number;responseBody:unknown;publishRequired:boolean}>(),audits:Array<{id:string;action:string;details:Record<string,unknown>}>=[],calls:Array<{sql:string;v:unknown[]}>=[];
 t.mock.method(e,"readLegacyContinuationBinding",async()=>binding);t.mock.method(e,"readLegacyContinuationHead",async()=>state.head);t.mock.method(e,"readLegacyContinuationEvidence",async()=>state.row);t.mock.method(e,"readLegacyContinuationUserIds",async()=>[binding.ownerUserId,binding.renterUserId].sort());t.mock.method(e,"lockLegacyContinuationOrder",async()=>({head:state.head,duties:state.duties}));t.mock.method(e,"authorizeLegacyContinuation",async()=>({canOperate:true,canReadCommission:true}));
 t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:true,passwordChangeRequired:false,permissions:new Set(["supply.catalog.manage","order.read","order.legacy.continue"])}));
 const client={query:async(sql:string,v:unknown[]=[])=>{
  calls.push({sql,v});
  if(sql.includes('"request_fingerprint" AS')){const receipt=receipts.get(String(v[0])+"/"+String(v[1]));return {rows:receipt?[receipt]:[],rowCount:receipt?1:0};}
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"'))receipts.set(String(v[0])+"/"+String(v[1]),{requestFingerprint:String(v[2]),responseStatus:Number(v[3]),responseBody:JSON.parse(String(v[4])),publishRequired:v[5]===true});
  if(sql.includes("source_snapshot AS source"))return {rows:[{source:snapshot,deposit:"5700"}],rowCount:1};
  if(sql.includes("SELECT id,amount_cents::text AS amount,status")){const duty=state.duties.find(d=>d.kind===v[1]&&d.sourceRecordId===v[2]);return {rows:duty?[{id:duty.id,amount:duty.amountCents,status:duty.status}]:[],rowCount:duty?1:0};}
  if(sql.startsWith("INSERT INTO zzsh_order.legacy_order_duty("))state.duties.push({id:String(v[0]),orderId:String(v[1]),continuationVersionId:null,kind:v[2] as LegacyDutyRow["kind"],sourceRecordId:String(v[3]),counterpartyUserId:String(v[4]),amountCents:String(v[5]),currency:"CNY",status:v[6] as LegacyDutyRow["status"],source:"LEGACY_IMPORT",sourceStatus:String(v[7]),settledBy:v[9] as LegacyDutyRow["settledBy"],settledRefType:null,settledRefId:null,settledRefDigest:null,level:null,ratio:null,maturityAt:null,revision:"1"});
  if(sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"'))audits.push({id:String(v[0]),action:String(v[4]),details:JSON.parse(String(v[10]))});
  if(sql.includes("SELECT a.id,a.details")){const audit=audits.find(a=>a.action==="order.legacy.liability.import"&&a.details.dutyId===v[1]&&a.details.classification===v[2]);return {rows:audit?[{...audit,sourceSnapshot:snapshot}]:[],rowCount:audit?1:0};}
  if(sql.includes("interval '7 days'"))return {rows:[{at:"2026-10-16T02:03:04.123456Z",maturityAt:"2026-10-23T02:03:04.123456Z"}],rowCount:1};
  if(sql.startsWith("INSERT INTO zzsh_order.legacy_continuation_version"))state.head={id:String(v[0]),orderId:String(v[1]),revision:String(v[2]),command:String(v[3]),inputEvidenceId:String(v[5]),resultEvidenceId:String(v[6]),stage:Number(v[7]),isSettle:Number(v[8]),amounts:JSON.parse(String(v[10]))};
  if(sql.startsWith("INSERT INTO zzsh_order.legacy_continuation_evidence"))state.row={id:String(v[0]),orderId:String(v[1]),evidenceVersion:String(v[2]),sourceKind:"DERIVED",sourceDigest:String(v[5]),facts:JSON.parse(String(v[9])),factsCanonical:String(v[10]),factsDigest:String(v[11])};
  return {rows:[],rowCount:sql.startsWith("UPDATE zzsh_order.legacy_continuation_version")?1:0};
 }} as unknown as PoolClient;
 const canonical=canonicalize({...snapshot,detain_money:detain}),input:LegacyHistoricalLiabilityInput={orderId:binding.id,parentSourceDigest:sourceDigest,classification:"DETAINED",evidenceRef:"FIXTURE_DETAINED_SOURCE",settlementRecord:{canonical,digest:sha256Hex(canonical)}};
 const release=()=>{const plan=planLegacyContinuation(state.row.facts.evidence,{kind:"release",caller:{role:"admin",legacyUserId:""}});assert(plan.ok);return parseLegacyMutation("release",{expectedRevision:state.head?.revision??null,inputEvidenceId:state.row.id,planFingerprint:plan.fingerprint});};
 return {binding,state,calls,client,input,release,audits};
}
test("DETAINED retains exactly one original net-refund duty while HELD; release and original-key replay preserve it for current basis",async t=>{
 const p=arrange(t),imported=await importLegacyHistoricalLiability(p.client,actor,p.input),expected=legacyEconomicDutyId(p.binding.id,"RENTER_REFUND","7");assert.equal((imported.body as {dutyId:string}).dutyId,expected);assert.equal(p.state.duties.length,1);const duty=p.state.duties[0]!;assert.equal(duty.amountCents,"8200");assert.equal(duty.sourceStatus,"DETAINED");assert.equal(duty.status,"PENDING");assert.equal(duty.settledBy,null);
 const held=await readLegacyDutyBasis(p.client,p.binding.id,duty);assert.equal(held.state,"KNOWN");if(held.state!=="KNOWN")assert.fail();assert.equal(held.fundsDisposition,"HELD");assert.equal(held.currentNetRefundCents,"8200");
 const input=p.release(),operation="order.legacy.continuation.release",run=()=>withIdempotency(p.client,{realm:"admin",principalId:actor.userId,operation,resourceId:p.binding.id},"ORIGINAL_RELEASE_KEY",fingerprintRequest(operation,p.binding.id,input),async()=>{},()=>applyLegacyContinuationCommand(p.client,actor,p.binding.id,input,async()=>"NONE"));
 assert.equal((await run()).replayed,false);assert.equal((await run()).replayed,true);await importLegacyHistoricalLiability(p.client,{...actor,userId:"fixture_other_maintenance"},p.input);
 assert.equal(p.state.duties.length,1);assert.equal(p.calls.filter(q=>q.sql.startsWith("INSERT INTO zzsh_order.legacy_order_duty(")).length,1);assert.equal(p.state.row.facts.evidence.source.detainMoney,"5.00");assert.equal(p.state.row.facts.evidence.source.returnOrderMoney,"87.00");assert.equal(p.state.row.facts.evidence.source.isSettle,"0");
 const available=await readLegacyDutyBasis(p.client,p.binding.id,duty);assert.equal(available.state,"KNOWN");if(available.state!=="KNOWN")assert.fail();assert.equal(available.fundsDisposition,"AVAILABLE");assert.equal(available.amountCents,"8200");assert.equal(available.currentNetRefundCents,"8200");assert.equal(available.sourceRecordEntity,"la_order");assert.equal(available.basisEvidenceId,p.audits.find(a=>a.action==="order.legacy.liability.import")!.id);assert.equal(available.effectiveHeadId,p.state.head!.id);assert.equal(duty.status,"PENDING");
 assert(!p.calls.some(q=>/finance_event|ledger_entry|INSERT INTO zzsh_order.rental_order/.test(q.sql)));
});
test("a proven zero detained net stays a pending zero duty, never an invented settlement or extra retained-money refund",async t=>{
 const p=arrange(t,"5.00","5.00");await importLegacyHistoricalLiability(p.client,actor,p.input);assert.equal(p.state.duties.length,1);const duty=p.state.duties[0]!;assert.equal(duty.amountCents,"0");await applyLegacyContinuationCommand(p.client,actor,p.binding.id,p.release(),async()=>"NONE");const result=await readLegacyDutyBasis(p.client,p.binding.id,duty);assert.equal(result.state,"KNOWN");if(result.state!=="KNOWN")assert.fail();assert.equal(result.currentNetRefundCents,"0");assert.equal(result.fundsDisposition,"AVAILABLE");assert.equal(duty.status,"PENDING");assert.equal(duty.settledRefType,null);assert.equal(p.state.row.facts.evidence.source.detainMoney,"5.00");
});
test("a reviewed detained-source import after release uses the same original economic key and current available result",async t=>{
 const p=arrange(t);await applyLegacyContinuationCommand(p.client,actor,p.binding.id,p.release(),async()=>"NONE");assert.equal(p.state.duties.length,0);
 await importLegacyHistoricalLiability(p.client,actor,p.input);await importLegacyHistoricalLiability(p.client,actor,p.input);assert.equal(p.state.duties.length,1);assert.equal(p.state.duties[0]!.id,legacyEconomicDutyId(p.binding.id,"RENTER_REFUND","7"));
 const basis=await readLegacyDutyBasis(p.client,p.binding.id,p.state.duties[0]!);assert.equal(basis.state,"KNOWN");if(basis.state!=="KNOWN")assert.fail();assert.equal(basis.fundsDisposition,"AVAILABLE");assert.equal(basis.currentNetRefundCents,"8200");assert.equal(p.state.row.facts.evidence.source.detainMoney,"5.00");
});
test("detained net missing, negative or with conflicting source/beneficiary cannot become a payable basis",async t=>{
 for(const [gross,detain,code] of [[null,"5.00","REFUND_AMOUNT_UNPROVEN"],["4.00","5.00","REFUND_NET_NEGATIVE"]] as const){const p=arrange(t,gross,detain);await assert.rejects(()=>importLegacyHistoricalLiability(p.client,actor,p.input),new RegExp(code));assert.equal(p.state.duties.length,0);t.mock.restoreAll();}
 const p=arrange(t);await importLegacyHistoricalLiability(p.client,actor,p.input);const duty=p.state.duties[0]!;assert.equal((await readLegacyDutyBasis(p.client,p.binding.id,{...duty,counterpartyUserId:null})).state,"UNKNOWN");assert.equal((await readLegacyDutyBasis(p.client,p.binding.id,{...duty,amountCents:"8700"})).state,"UNKNOWN");
 const fact=p.audits.find(a=>a.action==="order.legacy.liability.import")!;fact.details.settlementRecord={canonical:"{}",digest:"a".repeat(64)};assert.equal((await readLegacyDutyBasis(p.client,p.binding.id,duty)).state,"UNKNOWN");
});
