import { test } from "node:test";
import assert from "node:assert/strict";
import { planLegacyContinuation, type AmountPlan, type LegacyCommand } from "../src/order/legacy-continuation-calc";
import { deriveLegacyFacts, initialLegacyFacts, legacyCommissionMaturity, legacyOrderAdvisoryKey, legacyPlanYuanToCents, projectLegacyContinuation, projectLegacyPartyAmounts,projectLegacyCommandReceipt,previewLegacyContinuation,readSealedLegacyFacts,type LegacyDutyRow } from "../src/order/legacy-continuation-model";
import { legacyBinding as b, legacyEvidence, legacyQuantities, legacySource } from "./legacy-continuation-fixture";

test("variable-scale yuan becomes exact integer cents with24digit bound", () => {
  for (const [yuan, cents] of [["0.01", "1"], ["9.20", "920"], ["10", "1000"], ["100.00", "10000"], ["0", "0"], ["1.00000000", "100"]]) assert.equal(legacyPlanYuanToCents(yuan!), cents);
  for (const bad of ["10.005", "1e2", "-1.00", "99999999999999999999999999.00", "", "01.00"]) assert.throws(() => legacyPlanYuanToCents(bad), /PRECISION_UNSUPPORTED/);
});
test("mapped order lock key matches0057 and refuses bare source/native IDs", () => {
  assert.match(legacyOrderAdvisoryKey(b.id), /^\d+$/);
  for (const id of ["7", "order_native", "legacy_order_1"]) assert.throws(() => legacyOrderAdvisoryKey(id));
});
test("full result survives confirm then release; release does not clear detain or add refund", () => {
  let facts = initialLegacyFacts(legacySource({ isSettle: "2" }));
  for (const [i, command] of ([{ kind: "propose", caller: { role: "renter", legacyUserId: "11" }, quantities: legacyQuantities("1.00") }, { kind: "confirm", caller: { role: "owner", legacyUserId: "22" } }, { kind: "release", caller: { role: "admin", legacyUserId: "" } }] satisfies LegacyCommand[]).entries()) {
    const plan = planLegacyContinuation(facts.evidence, command);
    assert(plan.ok);
    facts = deriveLegacyFacts(facts, plan, command, "e" + i, "v" + i);
  }
  assert.equal(facts.evidence.source.orderStatus, "4"); assert.equal(facts.evidence.source.isSettle, "0");
  assert.equal(facts.evidence.source.detainMoney, "5.00");
  assert.deepEqual([facts.amounts.ownerNet, facts.amounts.refundNet, facts.amounts.commissionPool], ["10.00", "82.00", "3.00"]);
  const extra = planLegacyContinuation(facts.evidence, { kind: "release", caller: { role: "admin", legacyUserId: "" } });
  assert.equal(extra.ok, false);
});
test("reject discards proposal monetary projection and next proposal uses derived source", () => {
  const facts = initialLegacyFacts(legacySource({ orderStatus: "8", returnOrderMoney: "87.00", saleEarnings: "10.00" }));
  const command: LegacyCommand = { kind: "reject", caller: { role: "owner", legacyUserId: "22" } }, plan = planLegacyContinuation(facts.evidence, command);
  assert(plan.ok);
  const result = deriveLegacyFacts(facts, plan, command, "source", "reject");
  assert.equal(result.evidence.source.orderStatus, "3"); assert.equal(result.amounts.saleEarnings, null);
  assert.equal(result.derivedFromEvidenceId, "source"); assert.equal(result.derivedFromCommandVersionId, "reject");
  assert(planLegacyContinuation(result.evidence, { kind: "propose", caller: { role: "renter", legacyUserId: "11" }, quantities: legacyQuantities("1") }).ok);
});
test("imported8 without head supports opposing party directly and isolates unknown facts", () => {
  const source = legacySource({ orderStatus: "8", returnOrderMoney: "87.00", saleEarnings: "10.00" });
  const row = legacyEvidence(initialLegacyFacts(source));
  const view = projectLegacyContinuation(b, { realm: "user", userId: b.ownerUserId, sessionId: "fixture", requestId: "fixture" }, row, null, []);
  assert.equal(view.revision, null); assert.deepEqual(view.capabilities, ["confirm", "reject"]);
  assert.equal(view.amounts.saleEarnings?.cents,"1000");assert.equal(Object.hasOwn(view.amounts,"returnOrderMoney"),false);
  assert.equal(planLegacyContinuation(row.facts.evidence, { kind: "confirm", caller: { role: "owner", legacyUserId: "22" } }).ok, true);
  const isolated = legacyEvidence(initialLegacyFacts({ ...source, baseBot: null }));
  const blocked = projectLegacyContinuation(b, { realm: "user", userId: b.ownerUserId, sessionId: "fixture", requestId: "fixture" }, isolated, null, []);
  assert.equal(blocked.availability, "ISOLATED"); assert.deepEqual(blocked.capabilities, []);
});

const partyActor=(who:"owner"|"renter"|"other"|"admin")=>({realm:who==="admin"?"admin" as const:"user" as const,userId:who==="owner"?b.ownerUserId:who==="renter"?b.renterUserId:who,sessionId:"fixture",requestId:"fixture"});
const distinctAmounts={payMoney:"901.23",saleEarnings:"163.27",ownerNet:"150.21",returnOrderMoney:"517.89",refundGross:"517.89",refundNet:"506.82",fullPayoutMoney:"13.06",detainMoney:"11.07",commissionPool:"220.07",divide:"83",divide2:"71",expendOrder:"42.17",expendAccount:"37.11",depositCompensation:"23.09"};
test("legacy party amounts are whitelisted for both users, preserve self dual-party union and reject a non-party",()=>{
 const before=JSON.stringify(distinctAmounts),owner=projectLegacyPartyAmounts(b,partyActor("owner"),distinctAmounts),renter=projectLegacyPartyAmounts(b,partyActor("renter"),distinctAmounts);
 assert.equal(owner.ownerNet,"150.21");assert.equal(owner.fullPayoutMoney,"13.06");assert.equal(Object.hasOwn(owner,"payMoney"),false);assert.equal(Object.hasOwn(owner,"returnOrderMoney"),false);
 assert.equal(renter.payMoney,"901.23");assert.equal(renter.refundNet,"506.82");assert.equal(Object.hasOwn(renter,"ownerNet"),false);assert.equal(Object.hasOwn(renter,"fullPayoutMoney"),false);
 for(const view of [owner,renter])assert.equal(Object.hasOwn(view,"commissionPool"),false);
 const self=projectLegacyPartyAmounts({...b,renterUserId:b.ownerUserId},partyActor("owner"),distinctAmounts);assert.equal(self.payMoney,"901.23");assert.equal(self.ownerNet,"150.21");assert.equal(Object.hasOwn(self,"commissionPool"),false);
 assert.deepEqual(projectLegacyPartyAmounts(b,partyActor("admin"),distinctAmounts),distinctAmounts);
 assert.throws(()=>projectLegacyPartyAmounts(b,partyActor("other"),distinctAmounts),(e:unknown)=>(e as{status?:number}).status===404);assert.equal(JSON.stringify(distinctAmounts),before);
});
test("real legacy GET model keeps own amounts and duty scope without modifying sealed monetary facts",()=>{
 const facts=initialLegacyFacts(legacySource({payMoney:"901.23",saleEarnings:"163.27",returnOrderMoney:"517.89",fullPayoutMoney:"13.06",paidPay:[{id:"9",payOrderSn:"FIXTURE_P7",payMoney:"901.23"}]}));
 Object.assign(facts.amounts,distinctAmounts);const row=legacyEvidence(facts),before=JSON.stringify(row);
 const duties=[{id:"own",kind:"OWNER_CREDIT",counterpartyUserId:b.ownerUserId,amountCents:"15021"},{id:"refund",kind:"RENTER_REFUND",counterpartyUserId:b.renterUserId,amountCents:"50682"},{id:"commission",kind:"COMMISSION",counterpartyUserId:"beneficiary",amountCents:"3147"}] as unknown as LegacyDutyRow[];
 const owner=projectLegacyContinuation(b,partyActor("owner"),row,null,duties),renter=projectLegacyContinuation(b,partyActor("renter"),row,null,duties);
 assert.equal(owner.amounts.ownerNet?.cents,"15021");assert.equal(Object.hasOwn(owner.amounts,"payMoney"),false);assert.deepEqual(owner.duties.map(d=>d.id),["own"]);
 assert.equal(renter.amounts.payMoney?.cents,"90123");assert.equal(Object.hasOwn(renter.amounts,"saleEarnings"),false);assert.deepEqual(renter.duties.map(d=>d.id),["refund"]);
 assert.deepEqual(owner.quantities,facts.evidence.source.quantities);assert.equal(owner.evidenceId,row.id);
 assert.deepEqual(projectLegacyContinuation(b,partyActor("admin"),row,null,duties,false,"UNKNOWN",false).duties.map(d=>d.id),["own","refund"]);
 assert.deepEqual(projectLegacyContinuation(b,partyActor("admin"),row,null,duties,false,"UNKNOWN",true).duties.map(d=>d.id),["own","refund","commission"]);
 assert.throws(()=>projectLegacyContinuation(b,partyActor("other"),row,null,duties));assert.equal(JSON.stringify(row),before);
});
test("preview filters both actual calculated bags and keeps the original proposal fingerprint",()=>{
 const facts=initialLegacyFacts(legacySource()),quantities=legacyQuantities("1.00");
 for(const who of ["owner","renter"] as const){
  const actor=partyActor(who),out=previewLegacyContinuation(facts,b,actor,quantities);
  const full=planLegacyContinuation(facts.evidence,{kind:"propose",caller:{role:who,legacyUserId:who==="owner"?b.legacyOwnerId:b.legacyRenterId},quantities});assert(full.ok);assert.equal(out.proposalFingerprint,full.fingerprint);
  for(const amounts of [out.previewAmounts,out.proposalAmounts]){assert.equal(Object.hasOwn(amounts,who==="owner"?"payMoney":"saleEarnings"),false);assert.equal(Object.hasOwn(amounts,who==="owner"?"saleEarnings":"payMoney"),true);}
 }
});
test("receipt projection drops unknown nested source and diagnostics while preserving safe status and own fee",()=>{
 const raw={orderId:b.id,outcome:"REJECTED",revision:"7",amounts:{...distinctAmounts,ownerNet:{cents:"15021",yuan:"150.21",facts:{payMoney:"901.23"}}},source:{accountPrices:{coffee:"77.31"}},facts:{saleEarnings:"163.27"},error:{code:"CONFLICT",message:"REJECTED",requestId:"fixture",details:{payMoney:"901.23"}}},before=JSON.stringify(raw);
 const owner=projectLegacyCommandReceipt(b,partyActor("owner"),raw) as any,renter=projectLegacyCommandReceipt(b,partyActor("renter"),raw) as any;
 assert.deepEqual(owner.amounts.ownerNet,{cents:"15021",yuan:"150.21"});assert.equal(owner.amounts.fullPayoutMoney,"13.06");assert.equal(Object.hasOwn(owner,"source"),false);assert.equal(Object.hasOwn(owner,"facts"),false);assert.equal(Object.hasOwn(owner.error,"details"),false);
 assert.equal(renter.amounts.payMoney,"901.23");assert.equal(Object.hasOwn(renter.amounts,"ownerNet"),false);assert.equal(owner.outcome,"REJECTED");assert.equal(JSON.stringify(raw),before);
});
test("stored canonical evidence and full evidence metadata are verified", () => {
  const row = legacyEvidence(initialLegacyFacts(legacySource()));
  assert.equal(readSealedLegacyFacts(row), row.facts);
  assert.throws(() => readSealedLegacyFacts({ ...row, factsDigest: "0".repeat(64) }), /EVIDENCE_DIGEST_MISMATCH/);
  const changed = structuredClone(row); changed.facts.evidence.reasons = ["fabricated"];
  assert.throws(() => readSealedLegacyFacts(changed), /EVIDENCE_DIGEST_MISMATCH/);
});
test("completed commission typed time does not restart7days or lose microseconds", () => {
  const digest = "e".repeat(64);
  const completed = legacyCommissionMaturity({ kind: "COMPLETED_AT", at: "2026-09-03T00:00:00.000001Z", evidenceDigest: digest }, "2026-09-13T00:00:00Z");
  const matured = legacyCommissionMaturity({ kind: "MATURES_AT", at: "2026-09-10T00:00:00.000001Z", evidenceDigest: digest }, "2026-09-10T00:00:00.000000Z");
  assert.equal(completed.maturityAt, "2026-09-10T00:00:00.000001Z"); assert.equal(completed.maturedByCutoff, true);
  assert.equal(matured.maturityAt, completed.maturityAt); assert.equal(matured.maturedByCutoff, false);
  for (const at of ["2026-02-30T00:00:00Z", "2026-09-10", "", "2026-09-10T00:00:00+08:00"]) assert.throws(() => legacyCommissionMaturity({ kind: "COMPLETED_AT", at, evidenceDigest: digest }, "2026-09-13T00:00:00Z"));
});
