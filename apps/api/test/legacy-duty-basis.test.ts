import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {canonicalize} from "../src/supply/content-hash";
import {sha256Hex} from "../src/supply/supply-util";
import {legacyOwnerUserId} from "../src/supply/legacy-user-migration";
import {planLegacyContinuation} from "../src/order/legacy-continuation-calc";
import {deriveLegacyFacts,initialLegacyFacts,type LegacyDutyRow,type LegacyHeadRow} from "../src/order/legacy-continuation-model";
import {readLegacyDutyBasis} from "../src/order/legacy-duty-basis";
import {importLegacyCompletedCommission,type LegacyCompletedCommissionImport} from "../src/order/legacy-continuation-evidence";
import {legacyBinding,legacyEvidence,legacySource} from "./legacy-continuation-fixture";
const e:typeof import("../src/order/legacy-continuation-evidence")=require("../src/order/legacy-continuation-evidence");
const who={realm:"admin" as const,userId:"fixture_admin",sessionId:"fixture_session",requestId:"req_fixture"};
test("162 basis replays the exact confirm plan per original commission; does not treat imported amount or total pool as final",async t=>{
 const original={id:"90",beneficiaryId:"44",ratio:"20.00",level:"2",status:"1",storedEarnings:"999.00"};
 const canonical=canonicalize({id:"90",order_id:"7",user_id:"44",ratio:"20.00",level:"2",status:"1",earnings:"999.00"}),proof={sourceRecordId:"90",canonical,digest:sha256Hex(canonical),evidenceRef:"FIXTURE_RAW_COMMISSION"};
 const facts=initialLegacyFacts(legacySource({orderStatus:"8",saleEarnings:"10.00",returnOrderMoney:"87.00",commissions:[original]}),[proof]),before=legacyEvidence(facts),command={kind:"confirm" as const,caller:{role:"owner" as const,legacyUserId:"22"}},plan=planLegacyContinuation(facts.evidence,command);assert(plan.ok);
 const after={...legacyEvidence(deriveLegacyFacts(facts,plan,command,before.id,"version_confirm")),id:"result_confirm",sourceKind:"DERIVED" as const,evidenceVersion:"2"};
 const head:LegacyHeadRow={id:"version_confirm",orderId:legacyBinding.id,revision:"1",inputEvidenceId:before.id,resultEvidenceId:after.id,stage:4,isSettle:0,command:"CONFIRM",amounts:after.facts.amounts};
 let fingerprint=plan.fingerprint;
 t.mock.method(e,"readLegacyContinuationBinding",async()=>legacyBinding);t.mock.method(e,"readLegacyContinuationHead",async()=>head);t.mock.method(e,"readLegacyContinuationEvidence",async()=>after);
 const client={query:async(sql:string)=>({rows:sql.includes("plan_fingerprint")?[{...head,actor:{realm:"user",userId:legacyBinding.ownerUserId},planFingerprint:fingerprint,commissionRevisions:plan.commissionRevisions,createdAt:"2026-10-16T01:02:03.123456Z"}]:sql.includes("id=ANY")?[before,after]:[]})} as unknown as PoolClient;
 const duty:LegacyDutyRow={id:"fixture_duty",orderId:legacyBinding.id,continuationVersionId:null,kind:"COMMISSION",sourceRecordId:"90",counterpartyUserId:legacyOwnerUserId("legacy_mysql_restore","la_user","44"),amountCents:"60",currency:"CNY",status:"MATURED",source:"LEGACY_IMPORT",sourceStatus:"1",level:"2",ratio:"20.00000000",maturityAt:"2026-10-23T01:02:03.123456Z",revision:"3",settledBy:null,settledRefType:null,settledRefId:null,settledRefDigest:null};
 const basis=await readLegacyDutyBasis(client,legacyBinding.id,duty);if(basis.state!=="KNOWN")assert.fail(basis.reason);assert.equal(basis.amountCents,"60");assert.equal(basis.sourceRecordDigest,proof.digest);assert.notEqual(basis.sourceRecordDigest,legacyBinding.sourceDigest);assert.equal(basis.sourceTimeKind,"CONFIRMED_AT");assert.equal(basis.basisFactsDigest,after.factsDigest);
 assert.equal((await readLegacyDutyBasis(client,legacyBinding.id,{...duty,amountCents:"99900"})).state,"UNKNOWN");assert.equal((await readLegacyDutyBasis(client,legacyBinding.id,{...duty,maturityAt:"2026-10-30T01:02:03.123456Z"})).state,"UNKNOWN");
 const refund:LegacyDutyRow={...duty,kind:"RENTER_REFUND",source:"CONTINUATION",sourceRecordId:head.id,continuationVersionId:head.id,counterpartyUserId:legacyBinding.renterUserId,amountCents:"8200",maturityAt:null};
 const net=await readLegacyDutyBasis(client,legacyBinding.id,refund);assert.equal(net.state,"KNOWN");if(net.state==="KNOWN")assert.equal(net.currentNetRefundCents,"8200");
 fingerprint="0".repeat(64);await assert.rejects(()=>readLegacyDutyBasis(client,legacyBinding.id,duty),/FINAL_COMMAND_EVIDENCE_MISMATCH/);
});
test("current effective net drift refuses refund even when disposition is AVAILABLE and original confirm could still match",async t=>{
 const facts=initialLegacyFacts(legacySource({orderStatus:"4",isSettle:"0",returnOrderMoney:"87.00",saleEarnings:"10.00",detainMoney:"6.00"}));facts.amounts.refundNet="82.00";facts.derivedFromCommandVersionId="later_release";
 const current={...legacyEvidence(facts),id:"later_result",sourceKind:"DERIVED" as const,evidenceVersion:"3"};
 t.mock.method(e,"readLegacyContinuationBinding",async()=>legacyBinding);t.mock.method(e,"readLegacyContinuationEvidence",async()=>current);t.mock.method(e,"readLegacyContinuationHead",async()=>({id:"later_release",orderId:legacyBinding.id,revision:"2",inputEvidenceId:"earlier",resultEvidenceId:current.id,stage:4,isSettle:0,command:"RELEASE",amounts:facts.amounts}));
 const duty:LegacyDutyRow={id:"refund",orderId:legacyBinding.id,continuationVersionId:"confirm",kind:"RENTER_REFUND",sourceRecordId:"confirm",counterpartyUserId:legacyBinding.renterUserId,amountCents:"8200",currency:"CNY",status:"PENDING",source:"CONTINUATION",sourceStatus:null,level:null,ratio:null,maturityAt:null,revision:"1",settledBy:null,settledRefType:null,settledRefId:null,settledRefDigest:null};
 const result=await readLegacyDutyBasis({query:async()=>{throw new Error("must refuse before original command query");}} as unknown as PoolClient,legacyBinding.id,duty);assert.deepEqual(result,{state:"UNKNOWN",reason:"CURRENT_REFUND_AMOUNT_MISMATCH"});
});
function completedInput(kind:"COMPLETED_AT"|"MATURES_AT"):LegacyCompletedCommissionImport {
 const commission={id:"91",beneficiaryId:"44",ratio:"20.00",level:"2",status:"1",storedEarnings:"10.00"},canonical=canonicalize({id:"91",order_id:"7",user_id:"44",ratio:"20.00",level:"2",status:"1",earnings:"10.00"}),sourceRecord={sourceRecordId:"91",canonical,digest:sha256Hex(canonical),evidenceRef:"FIXTURE_ORIGINAL_COMMISSION"},cutoff="2026-10-16T00:00:00.000000Z",at=kind==="COMPLETED_AT"?"2026-10-01T01:02:03.123456Z":"2026-10-08T01:02:03.123456Z";
 const finalAmountEvidenceCanonical=canonicalize({parentSourceDigest:legacyBinding.sourceDigest,sourceRecordDigest:sourceRecord.digest,beneficiaryLegacyId:"44",amountCents:"1000",cutoff});const timeEvidenceCanonical=canonicalize({parentSourceDigest:legacyBinding.sourceDigest,sourceRecordDigest:sourceRecord.digest,kind,at,sourceValue:at,sourceUnit:"RFC3339_UTC",cutoff});
 return {orderId:legacyBinding.id,sourceDigest:legacyBinding.sourceDigest,commission,sourceRecord,cutoff,sourceTimeValue:at,sourceTimeUnit:"RFC3339_UTC",evidenceRef:"FIXTURE_REVIEWED_208",finalAmountEvidenceCanonical,finalAmountEvidenceDigest:sha256Hex(finalAmountEvidenceCanonical),timeEvidenceCanonical,time:{kind,at,evidenceDigest:sha256Hex(timeEvidenceCanonical)}};
}
test("208 independent admission preserves mature point and original raw row without account baseBot or continuation head",async t=>{
 const auth:typeof import("../src/auth/auth-security")=require("../src/auth/auth-security"),access:typeof import("../src/auth/admin-authorization")=require("../src/auth/admin-authorization");
 t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:true,passwordChangeRequired:false,permissions:new Set(["order.read","supply.catalog.manage"])}));
 for(const kind of ["COMPLETED_AT","MATURES_AT"] as const){const calls:Array<{sql:string;v:unknown[]}>=[],client={query:async(sql:string,v:unknown[]=[])=>{calls.push({sql,v});return sql.includes('FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1')?{rows:[{...legacyBinding,sourceOrderStatus:4,completedAt:"2026-10-01T01:02:03.123456Z"}],rowCount:1}:sql.includes("SELECT 1 FROM zzsh_iam.user_identity_state")?{rows:[{}],rowCount:1}:{rows:[],rowCount:0};}} as unknown as PoolClient;const result=await importLegacyCompletedCommission(client,who,completedInput(kind));assert("body" in result);assert.equal((result.body as {maturityAt:string}).maturityAt,"2026-10-08T01:02:03.123456Z");assert(calls.some(q=>q.sql.includes("INSERT INTO zzsh_order.legacy_order_duty_admission")));assert(!calls.some(q=>/base_bot|legacy_continuation_evidence|legacy_continuation_version.*INSERT/.test(q.sql)));const insert=calls.find(q=>q.sql.includes("INSERT INTO zzsh_order.legacy_order_duty("));assert(insert);assert.equal(insert.v[7],"2026-10-08T01:02:03.123456Z");}
 const bad=completedInput("COMPLETED_AT");bad.time.at="2026-10-02T01:02:03.123456Z";await assert.rejects(()=>importLegacyCompletedCommission({query:async()=>({rows:[{...legacyBinding,sourceOrderStatus:4,completedAt:"2026-10-01T01:02:03.123456Z"}],rowCount:1})} as unknown as PoolClient,who,bad),/ISOLATED_MATURITY_EVIDENCE_MISSING/);
});
