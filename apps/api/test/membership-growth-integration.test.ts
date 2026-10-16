import assert from "node:assert/strict";
import { test } from "node:test";
import { recordAcceptedSettlementGrowthFacts, assessGrowthSourceCompleteness, growthContributionSourceDigest, mapAcceptedSettlementToGrowthFacts, membershipGrowthPostCommitCallback, normalizeGrowthInstant, policyTierForGrowthProjection, readGrowthSourceCompleteness, readMembershipGrowth, readMembershipGrowthQuoteCandidates, resolveGrowthEffectiveTime, settlementBackfillActorAllowed } from "../src/auth/membership-growth-integration";
import { computeDeltaQuote, type QuoteInput } from "../src/supply/pricing";
import { compatRule } from "./pricing-compat-fixture";
import type { GrowthBenefitPolicy, GrowthContribution } from "../src/auth/membership-growth";
import { lockReplacementEntitlement } from "../src/auth/membership-growth-approval";
import { executeMembershipGrowthOperation } from "../src/auth/membership-growth-approval";
import { canonicalize } from "../src/supply/content-hash";
import { createHash } from "node:crypto";
import { ADMIN_PERMISSION } from "../src/auth/admin-authorization";

test("membership approval accepts ALL_GAMES and selected targets, rejects empty or unrelated scope before mutation", async () => {
  const previous = process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
  process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED = "true";
  try {
    for (const [mode, gameIds, allowed] of [["ALL_GAMES", [], true], ["SELECTED_GAMES", ["game-a"], true], ["SELECTED_GAMES", [], false], ["SELECTED_GAMES", ["game-b"], false]] as const) {
      let writes = 0;
      const client = { async query(sql: string) {
        if (sql.includes('"game_scope_mode"')) return { rows: [{ mode, gameIds }], rowCount: 1 };
        if (sql.includes('SELECT "status"')) return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false }], rowCount: 1 };
        if (sql.includes('UPDATE zzsh_iam.membership_entitlement')) { writes += 1; return { rows: [], rowCount: 1 }; }
        if (sql.includes('admin_user_permission') || sql.includes('admin_role_permission')) return { rows: [{ permissionCode: ADMIN_PERMISSION.membershipEntitlementRevoke }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      } };
      const input = { operationCode: "membership.entitlement.revoke", operationPayload: { entitlementId: "fixture-entitlement", gameId: "game-a", scopeKey: "fixture-scope", reason: "Fixture boundary" } };
      if (allowed) {
        const result = await executeMembershipGrowthOperation(client as never, input as never, { userId: "fixture-admin" } as never, "fixture-revoke");
        assert.equal(result.resultCode, "MEMBERSHIP_ENTITLEMENT_REVOKED");
        assert.equal(writes, 1);
      } else {
        await assert.rejects(() => executeMembershipGrowthOperation(client as never, input as never, { userId: "fixture-admin" } as never, "fixture-revoke"), (error: any) => error.code === "CONFLICT");
        assert.equal(writes, 0);
      }
    }
  } finally { if (previous === undefined) delete process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED; else process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED = previous; }
});

const snapshot = {
  orderId: "order-1",
  settlementVersionId: "settlement-1",
  settlementVersionNo: 1,
  versionHash: "a".repeat(64),
  supersededAt: null,
  postingId: "posting-1",
  gameId: "game-delta",
  renterUserId: "user-1",
  effectiveAtUtc: "2026-10-10T02:00:00.000Z",
  recordedAtUtc: "2026-10-10T02:01:00.000Z",
  inputSnapshot: {
    schema: "settlement-version-v2" as const,
    renterUserId: "user-1",
    ownerUserId: "owner-1",
    listingVersionId: "listing-v1",
    listingHash: "b".repeat(64),
    amounts: { haffConsumedBuyer: "8.00", itemConsumedBuyer: "2.00" },
  },
  computation: { consumed: { items: [{ itemId: "item-1", consumed: "1", remaining: "0" }] } },
};

test("accepted settlement maps mutually exclusive buyer consumption facts", () => {
  const result = mapAcceptedSettlementToGrowthFacts(snapshot);
  assert.deepEqual(result.facts.map((fact) => [fact.component, fact.amountCents, fact.effectiveAt]), [
    ["RENTAL_SETTLEMENT", "800", snapshot.effectiveAtUtc],
    ["MATERIAL_CONSUMPTION", "200", snapshot.effectiveAtUtc],
  ]);
  assert.equal(result.unmapped.some((item) => item.code === "MINIMUM_BILLING_SOURCE_MISSING"), true);
  assert.equal(result.unmapped.some((item) => item.code === "REFUND_CORRECTION_SOURCE_MISSING"), true);
});

test("a superseded or unposted version is never treated as growth input", () => {
  const result = mapAcceptedSettlementToGrowthFacts({ ...snapshot, postingId: null });
  assert.deepEqual(result.facts, []);
  assert.equal(result.unmapped[0]?.code, "SNAPSHOT_INVALID");
});

test("a correction source binds to its original source key", () => {
  const result = mapAcceptedSettlementToGrowthFacts({
    ...snapshot,
    settlementVersionId: "settlement-2",
    settlementVersionNo: 2,
    sourceRefs: {
      haff: { sourceKey: "RENTAL_SETTLEMENT:settlement-1:haff", sourceId: "settlement-1:haff", revision: 1, correctionOf: "RENTAL_SETTLEMENT:settlement-1:haff", correctionMode: "INCREMENT" },
      items: { sourceKey: "MATERIAL_CONSUMPTION:settlement-1:items", sourceId: "settlement-1:items", revision: 1, correctionOf: "MATERIAL_CONSUMPTION:settlement-1:items", correctionMode: "REPLACE" },
    },
  });
  assert.equal(result.facts[0]?.component, "REFUND_CORRECTION");
  assert.equal(result.facts[0]?.correctionOf, "RENTAL_SETTLEMENT:settlement-1:haff");
  assert.equal(result.facts[0]?.correctionMode, "INCREMENT");
});

test("source completeness stays pending when one formal settlement source is not ingested", () => {
  const result = assessGrowthSourceCompleteness(
    ["RENTAL_SETTLEMENT:settlement-1:haff", "MATERIAL_CONSUMPTION:settlement-1:items"],
    [{ sourceKey: "RENTAL_SETTLEMENT:settlement-1:haff", status: "SETTLED" }],
    "FORMAL_SETTLEMENTS",
  );
  assert.equal(result.state, "BACKFILL_PENDING");
  assert.deepEqual(result.missingSourceKeys, ["MATERIAL_CONSUMPTION:settlement-1:items"]);
});

test("registered zero-consumption and an unknown source do not share the same proof", () => {
  assert.equal(assessGrowthSourceCompleteness([], [], "REGISTRATION_ZERO").state, "COMPLETE");
  assert.equal(assessGrowthSourceCompleteness([], [], "UNKNOWN").state, "BACKFILL_PENDING");
});

test("current settlement-v2 shape uses the committed posting event as explicit growth time", () => {
  const postedAt = "2026-10-09T10:00:00.000Z";
  assert.deepEqual(resolveGrowthEffectiveTime({ schema: "settlement-version-v2", amounts: { haffConsumedBuyer: "1.00", itemConsumedBuyer: "0.00" } }, postedAt), { effectiveAtUtc: "2026-10-09T10:00:00.000000Z", source: "POSTING_CONFIRMED_AT_V1" });
  assert.deepEqual(resolveGrowthEffectiveTime({ schema: "settlement-version-v2", effectiveAtUtc: "2026-10-08T10:00:00.000Z" }, postedAt), { effectiveAtUtc: "2026-10-08T10:00:00.000000Z", source: "AUTHORITATIVE_SNAPSHOT" });
  assert.throws(() => resolveGrowthEffectiveTime({ effectiveAtUtc: "invalid" }, postedAt));
});

test("PostgreSQL timestamp text normalizes offsets and microseconds at the adapter boundary", () => {
  assert.equal(normalizeGrowthInstant("2026-10-09 18:00:00.123456+08"), "2026-10-09T10:00:00.123456Z");
  assert.equal(normalizeGrowthInstant("2026-10-09T18:00:00.123456+08:00"), "2026-10-09T10:00:00.123456Z");
  assert.throws(() => normalizeGrowthInstant("2026-10-09 18:00:00 nope"));
});

test("feature-off does not create a post-commit growth callback or approval execution", async () => {
  const previous = process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
  try {
    delete process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
    assert.equal(membershipGrowthPostCommitCallback({} as never, "order-1", { realm: "user", userId: "user-1", sessionId: "session-1" }, "request-1"), undefined);
    await assert.rejects(() => executeMembershipGrowthOperation({} as never, {} as never, {} as never, "request-1"), /disabled/);
    process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED = "true";
    assert.equal(typeof membershipGrowthPostCommitCallback({} as never, "order-1", { realm: "user", userId: "user-1", sessionId: "session-1" }, "request-1"), "function");
  } finally {
    if (previous === undefined) delete process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
    else process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED = previous;
  }
});

function draftApprovalFixture(policy: GrowthBenefitPolicy = { ...readerPolicy(), status: "DRAFT" }) {
  const metadata = { schema: "membership-growth-draft-v1", policy, versionNo: 1, ruleReleaseId: "release-1", priceVersionId: "price-v1", sourceRef: policy.sourceRef, effectiveAtUtc: policy.effectiveAt };
  const draftHash = createHash("sha256").update(canonicalize(metadata)).digest("hex");
  const inserted: Array<unknown[]> = [];
  const client = {
    query: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM "zzsh_iam"."admin_security"')) return { rows: [{ status: "ACTIVE", isBoss: true, passwordChangeRequired: false }] };
      if (sql.includes("FROM zzsh_supply.rule_release")) return { rows: [{ releaseId: "release-1", priceVersionId: "price-v1", status: "SEALED" }] };
      if (sql.includes("FROM zzsh_iam.membership_growth_policy WHERE id=$1")) { assert.doesNotMatch(sql, /FOR UPDATE|FOR SHARE/); return { rows: [{ id: "growth_policy_draft_1", version: 1, status: "DRAFT", effectiveAt: "2026-01-01T00:00:00.000Z", ruleReleaseId: "release-1", priceVersionId: "price-v1", sourceRef: policy.sourceRef, policyPayload: policy, payloadHash: draftHash }] }; }
      if (sql.startsWith("INSERT INTO zzsh_iam.membership_growth_policy")) { inserted.push(args); return { rowCount: 1, rows: [] }; }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { input: { operationCode: "membership.benefit.policy.publish", operationPayload: { policyDraftId: "growth_policy_draft_1", policyDraftVersion: 1, policyDraftHash: draftHash, ruleReleaseId: "release-1", priceVersionId: "price-v1", sourceRef: policy.sourceRef, effectiveAtUtc: "2026-01-01T00:00:00.000Z" }, requestedBy: "admin-requester", operationPayloadHash: "b".repeat(64) }, draft: { draftHash }, inserted, client };
}

test("published policy approval executes a complete immutable draft reference, not the oversized draft body", async () => {
  const previous = process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
  process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED = "true";
  try {
    const fixture = draftApprovalFixture();
    const result = await executeMembershipGrowthOperation(fixture.client as never, fixture.input as never, { userId: "boss" } as never, "approval-request-1");
    assert.equal(result.resultCode, "MEMBERSHIP_POLICY_PUBLISHED");
    assert.equal(fixture.inserted.length, 1);
    const approved = JSON.parse(String(fixture.inserted[0]![7]));
    assert.equal(approved.status, "APPROVED");
    const expectedApprovedHash = createHash("sha256").update(canonicalize({ schema: "membership-growth-draft-v1", policy: approved, versionNo: 1, ruleReleaseId: "release-1", priceVersionId: "price-v1", sourceRef: approved.sourceRef, effectiveAtUtc: "2026-01-01T00:00:00.000Z" })).digest("hex");
    assert.equal(fixture.inserted[0]![8], expectedApprovedHash);
    assert.notEqual(fixture.inserted[0]![8], fixture.draft.draftHash);
  } finally {
    if (previous === undefined) delete process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
    else process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED = previous;
  }
});

test("draft reference rejects hash, version, release, unpublishable policy and feature-off without insert", async () => {
  const previous = process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
  process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED = "true";
  try {
    for (const patch of [
      { name: "hash", change: (input: Record<string, any>) => { input.operationPayload.policyDraftHash = "c".repeat(64); } },
      { name: "version", change: (input: Record<string, any>) => { input.operationPayload.policyDraftVersion = 2; } },
      { name: "release", change: (input: Record<string, any>) => { input.operationPayload.ruleReleaseId = "release-other"; } },
    ]) {
      const fixture = draftApprovalFixture();
      patch.change(fixture.input);
      await assert.rejects(() => executeMembershipGrowthOperation(fixture.client as never, fixture.input as never, { userId: "boss" } as never, `approval-${patch.name}`));
      assert.equal(fixture.inserted.length, 0, patch.name);
    }
    const invalidPolicy = { ...readerPolicy(), status: "DRAFT" as const, tiers: { ...readerPolicy().tiers, STANDARD: { ...readerPolicy().tiers.STANDARD, pricing: { ...readerPolicy().tiers.STANDARD.pricing, ordinary: { ...readerPolicy().tiers.STANDARD.pricing.ordinary, haff: { status: "NOT_PRICED" as const, reason: "pending" } } } } } };
    const invalid = draftApprovalFixture(invalidPolicy);
    await assert.rejects(() => executeMembershipGrowthOperation(invalid.client as never, invalid.input as never, { userId: "boss" } as never, "approval-invalid"));
    assert.equal(invalid.inserted.length, 0);
  } finally {
    if (previous === undefined) delete process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
    else process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED = previous;
  }
  const disabled = draftApprovalFixture();
  const previousDisabled = process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
  try {
    delete process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
    await assert.rejects(() => executeMembershipGrowthOperation(disabled.client as never, disabled.input as never, { userId: "boss" } as never, "approval-disabled"), /disabled/);
    assert.equal(disabled.inserted.length, 0);
  } finally {
    if (previousDisabled === undefined) delete process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
    else process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED = previousDisabled;
  }
});

test("post-commit accepts owner or renter participant but rejects a nonparticipant", () => {
  const order = { renterUserId: "renter-1", ownerUserId: "owner-1" };
  assert.equal(settlementBackfillActorAllowed({ source: "SETTLEMENT_POST_COMMIT", realm: "user", userId: "renter-1" }, order), true);
  assert.equal(settlementBackfillActorAllowed({ source: "SETTLEMENT_POST_COMMIT", realm: "user", userId: "owner-1" }, order), true);
  assert.equal(settlementBackfillActorAllowed({ source: "SETTLEMENT_POST_COMMIT", realm: "user", userId: "stranger-1" }, order), false);
  assert.equal(settlementBackfillActorAllowed({ source: "ADMIN_MAINTENANCE", realm: "admin", userId: "admin-1" }, order), false);
});

test("legal tenant-early minimum billing is a separate growth component", () => {
  const result = mapAcceptedSettlementToGrowthFacts({
    ...snapshot,
    inputSnapshot: { ...snapshot.inputSnapshot, endReason: "TENANT_VOLUNTARY_EARLY", early: true, amounts: { ...snapshot.inputSnapshot.amounts, earlyMakeup: "1.25" } },
    computation: { ok: true, early: true, amounts: { earlyMakeup: "1.25" }, consumed: snapshot.computation?.consumed },
  });
  assert.equal(result.facts.find((fact) => fact.component === "MINIMUM_BILLING")?.amountCents, "125");
  assert.equal(result.unmapped.some((item) => item.code === "MINIMUM_BILLING_SOURCE_MISSING"), false);
});

test("effective policy tier preserves grace and black-gold benefits", () => {
  assert.equal(policyTierForGrowthProjection({ effectiveTier: "GOLD", normalTier: "SILVER", grace: { state: "ACTIVE", fromTier: "GOLD", droppedAt: "2026-10-01T00:00:00.000Z", until: "2026-10-08T00:00:00.000Z", gapPoints: "1" } }), "GOLD");
  assert.equal(policyTierForGrowthProjection({ effectiveTier: "BLACK_GOLD", normalTier: "STANDARD", grace: { state: "NONE", fromTier: null, droppedAt: null, until: null, gapPoints: null } }), "DIAMOND");
});

function readerPolicy(): GrowthBenefitPolicy {
  const haff = { status: "CONFIGURED" as const, kind: "HAFF_RATIO" as const, schema: "haff-ratio-v1" as const, priceVersionId: "price-v1", costBasisRef: "cost-v1", baseBySafeBox: { "box-a": "47" }, spreadDelta: "8" };
  const material = { status: "CONFIGURED" as const, kind: "FIXED_UNIT" as const, itemId: "item", unit: "PIECE" as const, unitQuantity: "1", buyerUnitAmount: "2", ownerUnitAmount: "1", priceVersionId: "price-v1", costBasisRef: "cost-v1" };
  const contract = (mode: "ordinary" | "custom" | "fast") => ({ mode, priceVersionId: "price-v1", haff, materials: { item: material } });
  const tier = (name: "STANDARD" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND") => ({ tier: name, tenantDeposit: name === "STANDARD" || name === "SILVER" ? "ACCOUNT_BASE" as const : "WAIVED" as const, pricing: { ordinary: contract("ordinary"), custom: contract("custom"), fast: contract("fast") }, entitlementCap: contract("ordinary") });
  return { schema: "membership-growth-v1", version: "policy-v1", status: "APPROVED", effectiveAt: "2026-01-01T00:00:00.000Z", sourceRef: "cost-v1", tiers: { STANDARD: tier("STANDARD"), SILVER: tier("SILVER"), GOLD: tier("GOLD"), PLATINUM: tier("PLATINUM"), DIAMOND: tier("DIAMOND") }, entitlementCaps: { FRIEND: "GOLD", PRESTIGE: "DIAMOND" } };
}

function quoteInput(): QuoteInput {
  return { priceVersionId: "price-v1", mode: "SPREAD", roundingPolicy: "HALF_UP_CENT_V1", customerTier: "STANDARD", haffRule: compatRule(), lines: [{ itemId: "haff", quantity: "60000000", pricingKind: "HAFF_RATIO", unit: "HAFF_BASE", customerTier: "STANDARD" }], conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", rentalPricing: { rentalMode: "ordinary" } }, termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }, deposits: { tenantDepositCents: "30000", publisherBailRequirementCents: "0" } };
}

function growthReaderClient(state: { normalTier: string; effectiveTier: string; blackGoldState: string; lastTierDropAt: string | null }, contributions: GrowthContribution[], policy: GrowthBenefitPolicy, sourceAmount: string | null = "10000.00", sourceHash = "a".repeat(64), migrated = false) {
  const source = { settlementVersionId: "settlement-1", versionNo: 1, versionHash: sourceHash, userId: "user-1", gameId: "game-1", inputSnapshot: { schema: "settlement-version-v2", amounts: { ...(sourceAmount === null ? {} : { haffConsumedBuyer: sourceAmount }), itemConsumedBuyer: "0.00" } } };
  return { query: async (sql: string) => {
    if (sql.includes('SELECT id FROM zzsh_auth_user')) return { rows: [{ id: "user-1" }] };
    if (sql.includes('FROM zzsh_iam.membership_growth_contribution')) return { rows: contributions };
    if (sql.includes('FROM zzsh_iam.user_rental_membership')) return { rows: [{ sourceRef: "legacy:manual" }] };
    if (sql.includes('FROM zzsh_iam.membership_growth_state')) return { rows: [state] };
    if (sql.includes('FROM zzsh_order.rental_order')) return { rows: [source] };
    if (sql.includes("user.legacy_owner.migrated")) return { rows: [{ migrated }] };
    if (sql.includes('FROM zzsh_iam.membership_growth_policy')) return { rows: [{ id: "policy-1", version: "1", policyPayload: policy }] };
    if (sql.includes('FROM zzsh_iam.membership_entitlement')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } } as never;
}

test("growth quote reader keeps grace tier and black-gold tier in the actual candidate path", async () => {
  const now = new Date();
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  const contribution = (patch: Partial<GrowthContribution>): GrowthContribution & { gameId: string; sourceDigest: string } => { const row = { userId: "user-1", gameId: "game-1", sourceKey: "RENTAL_SETTLEMENT:settlement-1:haff", sourceType: "RENTAL_SETTLEMENT" as const, sourceId: "settlement-1:haff", settlementVersion: "1", effectiveAt: at(8), recordedAt: at(8), amountCents: "1000000", status: "SETTLED" as const, eligible: true, revision: 0, ...patch }; return { ...row, sourceDigest: growthContributionSourceDigest("a".repeat(64), "game-1", row) }; };
  const rows = [contribution({}), contribution({ revision: 1, amountCents: "400000", previousAmountCents: "1000000", correctionMode: "REPLACE", correctionOf: "RENTAL_SETTLEMENT:settlement-1:haff", recordedAt: at(1) })];
  const input = quoteInput();
  const base = computeDeltaQuote(input);
  assert.equal(base.quotable, true);
  if (!base.quotable) return;
  const common = { userId: "user-1", ownerUserId: "owner-1", accountId: "account-1", gameId: "game-1", listingVersionId: "listing-1", listingHash: "a".repeat(64), ruleReleaseId: "release-1", priceVersionId: "price-v1", quantityDigest: "quantity-1", baseQuote: base.quote, quoteInput: input };
  const completeness = await readGrowthSourceCompleteness(growthReaderClient({ normalTier: "GOLD", effectiveTier: "GOLD", blackGoldState: "NOT_QUALIFIED", lastTierDropAt: at(1) }, rows, readerPolicy()), "user-1", rows, "legacy:manual");
  assert.equal(completeness.state, "COMPLETE", JSON.stringify(completeness));
  const pgRows = rows.map(row => ({ ...row, revision: String(row.revision) as unknown as number }));
  const debugGrowth = await readMembershipGrowth(growthReaderClient({ normalTier: "GOLD", effectiveTier: "GOLD", blackGoldState: "NOT_QUALIFIED", lastTierDropAt: at(1) }, pgRows, readerPolicy()), "user-1");
  assert.equal(debugGrowth?.growth.knowledge, "KNOWN", JSON.stringify(debugGrowth));
  assert.ok(debugGrowth?.growth.normalTier, JSON.stringify(debugGrowth));
  const grace = await readMembershipGrowthQuoteCandidates(growthReaderClient({ normalTier: "GOLD", effectiveTier: "GOLD", blackGoldState: "NOT_QUALIFIED", lastTierDropAt: at(1) }, rows, readerPolicy()), common);
  assert.equal(grace.knowledge, "KNOWN", JSON.stringify(grace));
  if (grace.knowledge === "KNOWN") assert.equal(grace.candidates[0]?.plan.benefitVersion, "1");
  const blackGold = await readMembershipGrowthQuoteCandidates(growthReaderClient({ normalTier: "STANDARD", effectiveTier: "BLACK_GOLD", blackGoldState: "QUALIFIED", lastTierDropAt: null }, [contribution({ amountCents: "100" })], readerPolicy(), "1.00"), common);
  assert.equal(blackGold.knowledge, "KNOWN", JSON.stringify(blackGold));
  if (blackGold.knowledge === "KNOWN") assert.equal(blackGold.candidates[0]?.plan.source, "GROWTH");
});

test("invalid, missing, wrong-amount and wrong-version formal sources fail closed", async () => {
  const policy = readerPolicy();
  const state = { normalTier: "STANDARD", effectiveTier: "STANDARD", blackGoldState: "NOT_QUALIFIED", lastTierDropAt: null };
  const base = { userId: "user-1", gameId: "game-1", sourceKey: "RENTAL_SETTLEMENT:settlement-1:haff", sourceType: "RENTAL_SETTLEMENT" as const, sourceId: "settlement-1:haff", settlementVersion: "1", effectiveAt: "2026-10-01T00:00:00.000Z", recordedAt: "2026-10-01T00:00:00.000Z", amountCents: "1000000", status: "SETTLED" as const, eligible: true, revision: 0, sourceDigest: "digest" };
  for (const [sourceAmount, row] of [["invalid", base], [null, base], ["10000.00", { ...base, amountCents: "999999" }], ["10000.00", { ...base, settlementVersion: "2" }]] as const) {
    const result = await readGrowthSourceCompleteness(growthReaderClient(state, [row], policy, sourceAmount), "user-1", [row], "legacy:manual");
    assert.equal(result.state, "SOURCE_CONFLICT", `${String(sourceAmount)}:${row.amountCents}:${row.settlementVersion}:${JSON.stringify(result)}`);
  }
  const validRow = { ...base, sourceDigest: growthContributionSourceDigest("a".repeat(64), "game-1", base) };
  const badDigestRow = { ...validRow, sourceDigest: "wrong-digest" };
  assert.equal((await readGrowthSourceCompleteness(growthReaderClient(state, [badDigestRow], policy), "user-1", [badDigestRow], "legacy:manual")).state, "SOURCE_CONFLICT");
  assert.equal((await readGrowthSourceCompleteness(growthReaderClient(state, [validRow], policy, "10000.00", "b".repeat(64)), "user-1", [validRow], "legacy:manual")).state, "SOURCE_CONFLICT");
});

test("native settlement coverage cannot close a migrated subject's earlier unknown history", async () => {
  const state = { normalTier: "STANDARD", effectiveTier: "STANDARD", blackGoldState: "NOT_QUALIFIED", lastTierDropAt: null };
  const row = { userId: "user-1", gameId: "game-1", sourceKey: "RENTAL_SETTLEMENT:settlement-1:haff", sourceType: "RENTAL_SETTLEMENT" as const, sourceId: "settlement-1:haff", settlementVersion: "1", effectiveAt: "2026-10-01T00:00:00.000Z", recordedAt: "2026-10-01T00:00:00.000Z", amountCents: "1000000", status: "SETTLED" as const, eligible: true, revision: 0 };
  const valid = { ...row, sourceDigest: growthContributionSourceDigest("a".repeat(64), "game-1", row) };
  const client = growthReaderClient(state, [valid], readerPolicy(), "10000.00", "a".repeat(64), true);
  const result = await readGrowthSourceCompleteness(client, "user-1", [valid], "registration:v1");
  assert.equal(result.state, "BACKFILL_PENDING");assert.ok(result.reasons?.includes("MIGRATED_SOURCE_NOT_PROVED"));
  const bad = { ...valid, sourceDigest: "wrong-digest" };
  assert.equal((await readGrowthSourceCompleteness(growthReaderClient(state, [bad], readerPolicy(), "10000.00", "a".repeat(64), true), "user-1", [bad], "registration:v1")).state, "SOURCE_CONFLICT");
});

test("replacement locks and rejects a different recipient before any new row is inserted", async () => {
  const seen: string[] = [];
  const client = { query: async (sql: string) => { seen.push(sql); return { rows: [{ id: "old", userId: "user-A", gameId: "game-1", kind: "FRIEND", scopeKey: "scope-1", status: "ACTIVE" }] }; } } as never;
  const candidate = { userId: "user-B", kind: "FRIEND" as const, scopeKey: "scope-1", startsAt: "2026-10-10T00:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z", pricing: {} as never, reason: "replacement", requestedBy: "admin-1" };
  await assert.rejects(() => lockReplacementEntitlement(client, { replaceEntitlementId: "old" }, candidate, "game-1"), /same recipient/);
  assert.equal(seen.some((sql) => sql.startsWith("INSERT")), false);
});

test('immutable contribution replay verifies original digest without requesting UPDATE-backed row locks',async()=>{
 const rows=new Map<string,string>(),sqls:string[]=[];const client={query:async(sql:string,args:unknown[])=>{sqls.push(sql);assert.doesNotMatch(sql,/FOR SHARE|FOR UPDATE|^UPDATE|^DELETE/);if(sql.trimStart().startsWith('INSERT')){const key=JSON.stringify([args[1],args[3],args[7]]);if(rows.has(key))return{rowCount:0,rows:[]};rows.set(key,String(args[16]));return{rowCount:1,rows:[{id:args[0]}]};}const key=JSON.stringify(args);return{rows:rows.has(key)?[{sourceDigest:rows.get(key)}]:[]};}};
 const first=await recordAcceptedSettlementGrowthFacts(client as never,snapshot);assert.equal(first.inserted,2);
 const replay=await recordAcceptedSettlementGrowthFacts(client as never,snapshot);assert.equal(replay.inserted,0);assert.equal(replay.replayed,2);assert.equal(rows.size,2);
 await assert.rejects(recordAcceptedSettlementGrowthFacts(client as never,{...snapshot,versionHash:'c'.repeat(64)}),/Contribution revision conflict/);assert.equal(rows.size,2);
 // SQL emission/digest contract only; real UNIQUE waits, snapshot isolation and ACL need PG acceptance.
});



test("T v4 seam: one asOf, effectiveTier/policyTier metadata, microsecond entitlement bounds, ACTIVE entitlement failures are UNKNOWN", async () => {
  const { readMembershipGrowthQuoteCandidatesAt } = await import("../src/auth/membership-growth-integration");
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const asOfUtc = `${iso(now).slice(0, 23)}000Z`;
  const row = { userId: "user-1", gameId: "game-1", sourceKey: "RENTAL_SETTLEMENT:settlement-1:haff", sourceType: "RENTAL_SETTLEMENT" as const, sourceId: "settlement-1:haff", settlementVersion: "1", effectiveAt: iso(now - 86_400_000), recordedAt: iso(now - 86_400_000), amountCents: "1000000", status: "SETTLED" as const, eligible: true, revision: 0 };
  const rows = [{ ...row, sourceDigest: growthContributionSourceDigest("a".repeat(64), "game-1", row) }];
  const policy = readerPolicy();
  const priced = policy.tiers.GOLD.pricing.ordinary;
  const ent = (patch: Record<string, unknown>) => ({ id: "ent-1", kind: "FRIEND", scopeKey: "scope-1", startsAt: iso(now - 3_600_000), endsAt: iso(now + 3_600_000), status: "ACTIVE", depositWaived: false, pricingPayload: priced, ...patch });
  const client = (entitlements: unknown[], state = { normalTier: "SILVER", effectiveTier: "SILVER", blackGoldState: "NOT_QUALIFIED", lastTierDropAt: null as string | null }) => {
    const inner = growthReaderClient(state, rows, policy) as unknown as { query: (sql: string, args?: unknown[]) => Promise<unknown> };
    return { query: async (sql: string, args?: unknown[]) => sql.includes("FROM zzsh_iam.membership_entitlement") && sql.includes("pricing_payload") ? { rows: entitlements } : inner.query(sql, args) } as never;
  };
  const input = quoteInput();
  const base = computeDeltaQuote(input);
  assert.equal(base.quotable, true); if (!base.quotable) return;
  const common = { userId: "user-1", ownerUserId: "owner-1", accountId: "account-1", gameId: "game-1", listingVersionId: "listing-1", listingHash: "a".repeat(64), ruleReleaseId: "release-1", priceVersionId: "price-v1", quantityDigest: "quantity-1", baseQuote: base.quote, quoteInput: input, asOfUtc };

  const known = await readMembershipGrowthQuoteCandidatesAt(client([ent({})]), common);
  assert.equal(known.knowledge, "KNOWN", JSON.stringify(known));
  if (known.knowledge === "KNOWN") {
    assert.equal(known.asOfUtc, asOfUtc, "asOf is echoed exactly so T can reject a mismatch");
    assert.ok(known.effectiveTier && known.policyTier);
    assert.deepEqual(known.candidates.map((c) => c.plan.source), ["GROWTH", "FRIEND"]);
    assert.deepEqual(known.entitlementIds, ["ent-1"]);
  }
  // Original failure (pre-fix): an applicable ACTIVE entitlement with unusable pricing was silently skipped and KNOWN returned.
  const notPriced = await readMembershipGrowthQuoteCandidatesAt(client([ent({ pricingPayload: { status: "NOT_PRICED", reason: "x" } })]), common);
  assert.deepEqual([notPriced.knowledge, (notPriced as { reason?: string }).reason], ["UNKNOWN", "ENTITLEMENT_PRICE_UNAVAILABLE"]);
  const badKind = await readMembershipGrowthQuoteCandidatesAt(client([ent({ kind: "VIP" })]), common);
  assert.equal((badKind as { reason?: string }).reason, "ENTITLEMENT_KIND_UNKNOWN");
  // Proven expired / revoked / replaced / not started are excluded normally and do not block.
  const excluded = await readMembershipGrowthQuoteCandidatesAt(client([ent({ id: "e1", endsAt: iso(now - 1), pricingPayload: null }), ent({ id: "e2", status: "REVOKED", pricingPayload: null }), ent({ id: "e3", status: "REPLACED", pricingPayload: null }), ent({ id: "e4", status: "EXECUTED_PENDING_START", startsAt: iso(now + 60_000), pricingPayload: null })]), common);
  assert.equal(excluded.knowledge, "KNOWN", JSON.stringify(excluded));
  if (excluded.knowledge === "KNOWN") assert.deepEqual(excluded.entitlementIds, []);
  // Microsecond precision: endsAt one microsecond after asOf is still ACTIVE; endsAt == asOf is EXPIRED.
  const micro = `${asOfUtc.slice(0, 23)}001Z`;
  const activeMicro = await readMembershipGrowthQuoteCandidatesAt(client([ent({ endsAt: micro, pricingPayload: { status: "NOT_PRICED", reason: "x" } })]), common);
  assert.equal((activeMicro as { reason?: string }).reason, "ENTITLEMENT_PRICE_UNAVAILABLE", "1µs-later end is still applicable");
  const expiredExact = await readMembershipGrowthQuoteCandidatesAt(client([ent({ endsAt: asOfUtc, pricingPayload: null })]), common);
  assert.equal(expiredExact.knowledge, "KNOWN");
  // asOf contract
  for (const bad of ["2026-10-16T00:00:00Z", "2026-10-16T00:00:00.123Z", "not-a-time", "2026-10-16T00:00:00.1234567Z"]) {
    const r = await readMembershipGrowthQuoteCandidatesAt(client([]), { ...common, asOfUtc: bad });
    assert.equal((r as { reason?: string }).reason, "AS_OF_INVALID", bad);
  }
  const subMs = await readMembershipGrowthQuoteCandidatesAt(client([]), { ...common, asOfUtc: micro });
  assert.equal(subMs.knowledge, "KNOWN", "stable projection across the millisecond bounds is accepted at µs asOf");
  if (subMs.knowledge === "KNOWN") assert.equal(subMs.asOfUtc, micro);
  // Black gold keeps BLACK_GOLD as effectiveTier and DIAMOND as pricing tier.
  const bg = await readMembershipGrowthQuoteCandidatesAt(client([], { normalTier: "STANDARD", effectiveTier: "BLACK_GOLD", blackGoldState: "QUALIFIED", lastTierDropAt: null }), common);
  if (bg.knowledge === "KNOWN") assert.deepEqual([bg.effectiveTier, bg.policyTier], ["BLACK_GOLD", "DIAMOND"]);
  else assert.fail(JSON.stringify(bg));
});

test("E-R3-02 quote seam: same-millisecond future consumption is not counted at a microsecond asOf", async () => {
  const { readMembershipGrowthQuoteCandidatesAt } = await import("../src/auth/membership-growth-integration");
  const asOfUtc = "2026-10-16T08:00:00.123456Z", futureAt = "2026-10-16T08:00:00.123900Z";
  const row = { userId: "user-1", gameId: "game-1", sourceKey: "RENTAL_SETTLEMENT:settlement-1:haff", sourceType: "RENTAL_SETTLEMENT" as const, sourceId: "settlement-1:haff", settlementVersion: "1", effectiveAt: futureAt, recordedAt: futureAt, amountCents: "1000000", status: "SETTLED" as const, eligible: true, revision: 0 };
  const rows = [{ ...row, sourceDigest: growthContributionSourceDigest("a".repeat(64), "game-1", row) }];
  const state = { normalTier: "STANDARD", effectiveTier: "STANDARD", blackGoldState: "NOT_QUALIFIED", lastTierDropAt: null };
  const before = await readMembershipGrowth(growthReaderClient(state, rows, readerPolicy()), "user-1", asOfUtc);
  assert.equal(before?.growth.rollingPoints, "0");
  assert.equal(before?.growth.asOfUtc, asOfUtc);
  const atFact = await readMembershipGrowth(growthReaderClient(state, rows, readerPolicy()), "user-1", futureAt);
  assert.equal(atFact?.growth.rollingPoints, "10000");
  const input = quoteInput(); const base = computeDeltaQuote(input); assert.equal(base.quotable, true); if (!base.quotable) return;
  const result = await readMembershipGrowthQuoteCandidatesAt(growthReaderClient(state, rows, readerPolicy()), { userId: "user-1", ownerUserId: "owner-1", accountId: "account-1", gameId: "game-1", listingVersionId: "listing-1", listingHash: "a".repeat(64), ruleReleaseId: "release-1", priceVersionId: "price-v1", quantityDigest: "quantity-1", baseQuote: base.quote, quoteInput: input, asOfUtc });
  if (result.knowledge === "KNOWN") { assert.notEqual(result.effectiveTier, "GOLD"); assert.equal(result.asOfUtc, asOfUtc); }
});
