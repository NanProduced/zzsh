import assert from "node:assert/strict";
import { test } from "node:test";
import { creditPageData, growthPageData, listPageData, pageError, knownCents } from "../src/auth/page-data-state";
import { readMembershipGrowth, growthContributionSourceDigest } from "../src/auth/membership-growth-integration";
import type { GrowthContribution } from "../src/auth/membership-growth";
import { legacyRatioText, mapLegacyDistributionLevel, mapLegacyIdentityFacets } from "../src/auth/legacy-identity-facets";

// FIXTURE ONLY.
test("credit page: missing profile is PENDING_SOURCE not 100; conflicts FAIL", () => {
  assert.deepEqual(creditPageData({ creditState: "NOT_INITIALIZED", credit: null }), { state: "PENDING_SOURCE", reason: "CREDIT_NOT_INITIALIZED", value: null });
  assert.equal(creditPageData({ creditState: "INITIALIZED", credit: { score: 100 } }).state, "READY");
  assert.equal(creditPageData({ creditState: "INITIALIZED", credit: null }).state, "FAILED");
  assert.equal(creditPageData({ creditState: "NOT_INITIALIZED", credit: { score: 100 } }).state, "FAILED");
});
test("growth page: only COMPLETE is READY; pending keeps value flagged; conflict/unknown FAIL", () => {
  assert.equal(growthPageData({ growth: { sourceState: "COMPLETE", knowledge: "KNOWN" } }).state, "READY");
  assert.deepEqual([growthPageData({ growth: { sourceState: "COMPLETE", knowledge: "UNKNOWN" } }).state, growthPageData({ growth: { sourceState: "COMPLETE" } }).reason], ["PENDING_SOURCE", "PROJECTION_UNKNOWN"]);
  assert.deepEqual([growthPageData({ growth: { sourceState: "BACKFILL_PENDING" } }).state, growthPageData({ growth: { sourceState: "BACKFILL_PENDING" } }).reason], ["PENDING_SOURCE", "BACKFILL_PENDING"]);
  const conflict = { growth: { sourceState: "SOURCE_CONFLICT", knowledge: "UNKNOWN", rollingPoints: null }, entitlements: [{ id: "e1" }] };
  assert.deepEqual([growthPageData(conflict).state, growthPageData(conflict).value?.entitlements.length, (growthPageData(conflict).value?.growth as any).rollingPoints], ["FAILED", 1, null], "failure is card-scoped; existing entitlement records stay visible, unknown points stay null");
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

// B-R1-02: real reader DTO (readMembershipGrowth over a fake pg client), not a hand-written shape.
function readerClient(contributions: unknown[]) {
  const source = { settlementVersionId: "settlement-1", versionNo: 1, versionHash: "a".repeat(64), userId: "user-1", gameId: "game-1", inputSnapshot: { schema: "settlement-version-v2", amounts: { haffConsumedBuyer: "10000.00", itemConsumedBuyer: "0.00" } } };
  return { query: async (sql: string) => {
    if (sql.includes("SELECT id FROM zzsh_auth_user")) return { rows: [{ id: "user-1" }] };
    if (sql.includes("FROM zzsh_iam.membership_growth_contribution")) return { rows: contributions };
    if (sql.includes("FROM zzsh_iam.user_rental_membership")) return { rows: [{ sourceRef: "legacy:manual" }] };
    if (sql.includes("FROM zzsh_iam.membership_growth_state")) return { rows: [] };
    if (sql.includes("FROM zzsh_order.rental_order")) return { rows: [source] };
    if (sql.includes("user.legacy_owner.migrated")) return { rows: [{ migrated: false }] };
    if (sql.includes("FROM zzsh_iam.membership_growth_policy")) return { rows: [] };
    if (sql.includes("FROM zzsh_iam.membership_entitlement")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } } as never;
}
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const contribution = (patch: Partial<GrowthContribution>) => { const row = { userId: "user-1", gameId: "game-1", sourceKey: "RENTAL_SETTLEMENT:settlement-1:haff", sourceType: "RENTAL_SETTLEMENT" as const, sourceId: "settlement-1:haff", settlementVersion: "1", effectiveAt: at(8), recordedAt: at(8), amountCents: "1000000", status: "SETTLED" as const, eligible: true, revision: 0, ...patch }; return { ...row, sourceDigest: growthContributionSourceDigest("a".repeat(64), "game-1", row) }; };

test("B-R1-02 real DTO: negative net consumption is sourceState COMPLETE + knowledge UNKNOWN -> not READY, points/tier null", async () => {
  const rows = [contribution({}), contribution({ revision: 1, amountCents: "-2000000", previousAmountCents: "1000000", correctionMode: "INCREMENT", correctionOf: "RENTAL_SETTLEMENT:settlement-1:haff", recordedAt: at(1) })];
  const dto = await readMembershipGrowth(readerClient(rows), "user-1");
  assert.ok(dto);
  assert.deepEqual([dto!.growth.sourceState, dto!.growth.knowledge], ["COMPLETE", "UNKNOWN"], JSON.stringify(dto!.growth));
  const g = dto!.growth as Record<string, unknown>;
  assert.deepEqual([g.rollingPoints ?? null, g.lifetimePoints ?? null, g.normalTier ?? null, g.effectiveTier ?? null], [null, null, null, null]);
  const page = growthPageData(dto);
  assert.deepEqual([page.state, page.reason], ["PENDING_SOURCE", "PROJECTION_UNKNOWN"]);
});

test("B-R1-02 control: same real reader with a normal settled contribution is COMPLETE + KNOWN -> READY", async () => {
  const dto = await readMembershipGrowth(readerClient([contribution({})]), "user-1");
  assert.deepEqual([dto!.growth.sourceState, dto!.growth.knowledge], ["COMPLETE", "KNOWN"], JSON.stringify(dto!.growth));
  assert.equal(growthPageData(dto).state, "READY");
});