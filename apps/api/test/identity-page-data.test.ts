import assert from "node:assert/strict";
import { test } from "node:test";
import { creditPageData, growthPageData, listPageData, pageError, knownCents } from "../src/auth/page-data-state";
import { legacyRatioText, mapLegacyDistributionLevel, mapLegacyIdentityFacets } from "../src/auth/legacy-identity-facets";

// FIXTURE ONLY.
test("credit page: missing profile is PENDING_SOURCE not 100; conflicts FAIL", () => {
  assert.deepEqual(creditPageData({ creditState: "NOT_INITIALIZED", credit: null }), { state: "PENDING_SOURCE", reason: "CREDIT_NOT_INITIALIZED", value: null });
  assert.equal(creditPageData({ creditState: "INITIALIZED", credit: { score: 100 } }).state, "READY");
  assert.equal(creditPageData({ creditState: "INITIALIZED", credit: null }).state, "FAILED");
  assert.equal(creditPageData({ creditState: "NOT_INITIALIZED", credit: { score: 100 } }).state, "FAILED");
});
test("growth page: only COMPLETE is READY; pending keeps value flagged; conflict/unknown FAIL", () => {
  assert.equal(growthPageData({ growth: { sourceState: "COMPLETE" } }).state, "READY");
  assert.deepEqual([growthPageData({ growth: { sourceState: "BACKFILL_PENDING" } }).state, growthPageData({ growth: { sourceState: "BACKFILL_PENDING" } }).reason], ["PENDING_SOURCE", "BACKFILL_PENDING"]);
  assert.equal(growthPageData({ growth: { sourceState: "SOURCE_CONFLICT" } }).value, null);
  assert.equal(growthPageData({ growth: {} }).state, "FAILED");
  assert.equal(growthPageData(null).state, "PENDING_SOURCE");
});
test("lists, errors and amounts: empty is legal only with complete coverage; 401/403 UNAUTHORIZED; unknown stays null", () => {
  assert.equal(listPageData([], "COMPLETE").state, "LEGAL_EMPTY");
  assert.equal(listPageData([], "UNKNOWN").state, "PENDING_SOURCE");
  assert.equal(listPageData(null, "COMPLETE").state, "FAILED");
  assert.equal(pageError(403).state, "UNAUTHORIZED"); assert.equal(pageError(503).state, "FAILED"); assert.equal(pageError(404).state, "FAILED");
  assert.equal(knownCents(null), null); assert.equal(knownCents(""), null); assert.equal(knownCents("0"), "0"); assert.equal(knownCents("1.5"), null);
});
test("FLOAT ratios keep exact source text; missing is SOURCE_PENDING; junk rejected", () => {
  assert.deepEqual(legacyRatioText("0.1"), { sourceText: "0.1", sourceType: "FLOAT UNSIGNED" });
  assert.equal((legacyRatioText("1e-05") as any).sourceText, "1e-05");
  assert.equal((legacyRatioText(null) as any).status, "SOURCE_PENDING");
  assert.throws(() => legacyRatioText(0.1), /RATIO/); assert.throws(() => legacyRatioText("-1"), /RATIO/);
  const l = mapLegacyDistributionLevel({ legacy_level_id: "3", name: "L3", self_ratio_source_text: "0", first_ratio_source_text: "0.05", second_ratio_source_text: null, is_delete: "0" });
  assert.equal((l.firstRatio as any).sourceText, "0.05");
});
test("identity facets are independent; risk never suspends; isolated never mapped; courtesy needs grant; no asset/permission grant", () => {
  const f = mapLegacyIdentityFacets({ impact: "RISK_11", mappedUserId: "u1", legacyManualTier: "3", distribution: { levelId: "2", isDistribution: "1", isFreeze: "1" }, currentConsumptionTier: null, activeCourtesies: [] });
  assert.deepEqual([f.restrictions.accountSuspended, f.restrictions.newOrderOrWithdrawal, f.manualTier.status, f.consumptionTier.status, f.distribution.commissionFrozen], [false, "OWNER_DECISION_REQUIRED", "HISTORICAL_ONLY", "UNKNOWN", true]);
  assert.equal(mapLegacyIdentityFacets({ impact: "NONE", mappedUserId: "u2", legacyManualTier: null, distribution: null, currentConsumptionTier: "SILVER", activeCourtesies: [] }).distribution.eligibility, "UNKNOWN");
  assert.throws(() => mapLegacyIdentityFacets({ impact: "ISOLATED_54", mappedUserId: "u3", legacyManualTier: null, distribution: null, currentConsumptionTier: null, activeCourtesies: [] }), /ISOLATED/);
  assert.throws(() => mapLegacyIdentityFacets({ impact: "NONE", mappedUserId: "u4", legacyManualTier: null, distribution: null, currentConsumptionTier: null, activeCourtesies: [{ id: "c", grantRef: "", endsAt: "x" }] }), /COURTESY/);
  const r = mapLegacyIdentityFacets({ impact: "RETAINED_46", mappedUserId: "u5", legacyManualTier: null, distribution: null, currentConsumptionTier: null, activeCourtesies: [] });
  assert.deepEqual(r.grants, { assets: false, permissions: false });
});
