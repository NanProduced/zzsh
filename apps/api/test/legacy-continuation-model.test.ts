import { test } from "node:test";
import assert from "node:assert/strict";
import { planLegacyContinuation, type AmountPlan, type LegacyCommand } from "../src/order/legacy-continuation-calc";
import { deriveLegacyFacts, initialLegacyFacts, legacyCommissionMaturity, legacyOrderAdvisoryKey, legacyPlanYuanToCents, projectLegacyContinuation, readSealedLegacyFacts } from "../src/order/legacy-continuation-model";
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
  assert.equal(view.amounts.returnOrderMoney?.cents, "8700");
  assert.equal(planLegacyContinuation(row.facts.evidence, { kind: "confirm", caller: { role: "owner", legacyUserId: "22" } }).ok, true);
  const isolated = legacyEvidence(initialLegacyFacts({ ...source, baseBot: null }));
  const blocked = projectLegacyContinuation(b, { realm: "user", userId: b.ownerUserId, sessionId: "fixture", requestId: "fixture" }, isolated, null, []);
  assert.equal(blocked.availability, "ISOLATED"); assert.deepEqual(blocked.capabilities, []);
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
