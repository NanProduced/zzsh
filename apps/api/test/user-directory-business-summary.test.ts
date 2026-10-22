import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { readUserDirectoryBusinessSummaries } from "../src/auth/user-directory-business-summary";
import { growthContributionSourceDigest, readMembershipGrowth, readMembershipGrowthBatch } from "../src/auth/membership-growth-integration";
import { prepareLegacyGrowthBackfill, type LegacyCoverageRecord } from "../src/auth/membership-growth-legacy";
import { readLegacyGrowthCoverageAssessment, readLegacyGrowthCoverageAssessments, type LegacyGrowthStoredContribution } from "../src/auth/membership-growth-legacy-store";
import { canonicalize } from "../src/supply/content-hash";
import { sha256Hex } from "../src/supply/supply-util";
import { NORMAL_GROWTH_TIERS } from "../src/auth/membership-growth";
import { legacyBinding } from "./legacy-continuation-fixture";

const at = "2026-10-19T04:00:00.000000Z";
const viewer = { adminId: "staff", isBoss: false, membershipSummaryRead: true, creditRead: true };
type Subject = { userId: string; sourceRef: string | null; migrated: boolean; normalTier: string | null; effectiveTier: string | null; blackGoldState: string | null; lastTierDropAt: string | null };
const subject = (userId: string, migrated = false): Subject => ({ userId, sourceRef: migrated ? "legacy:fixture" : "registration:v1", migrated, normalTier: null, effectiveTier: null, blackGoldState: null, lastTierDropAt: null });
const entitlement = (userId: string, status = "ACTIVE", endsAt = "2026-10-20T00:00:00.000000Z") => ({ userId, id: `${userId}:${status}`, kind: "FRIEND", scopeKey: "game-a", startsAt: "2026-10-18T00:00:00.000000Z", endsAt, status, depositWaived: true });

function fixture(subjects: Subject[], options: {
  entitlements?: ReturnType<typeof entitlement>[];
  credits?: { userId: string; score: number | null; revision: string | null; inScope: boolean; notInitialized?: boolean }[];
  records?: LegacyCoverageRecord[];
  contributions?: LegacyGrowthStoredContribution[];
  sources?: { settlementVersionId: string; versionNo: number; versionHash: string; userId: string; gameId: string; inputSnapshot: Record<string, unknown> }[];
  legacySources?: { userId: string; sourceKey: string; commandId: string | null; revision: string | null }[];
  fail?: { match: string; error: Error };
  policy?: { id: string; version: string; policyPayload: Record<string, unknown>; haffRule: unknown };
} = {}) {
  const queries: { sql: string; args: unknown[] }[] = [];
  const records = (options.records ?? []).map(record => {
    const canonical = canonicalize(record);
    return { userId: record.subjectUserId, canonical, digest: sha256Hex(canonical) };
  });
  const client = { async query(sql: string, args: unknown[] = []) {
    queries.push({ sql, args });
    assert.match(sql, /^\s*SELECT\b/i);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE)\b/i);
    if (options.fail && sql.includes(options.fail.match)) throw options.fail.error;
    const id = args[0] as string;
    const current = subjects.find(row => row.userId === id);
    if (sql.includes("directory-growth-subjects")) return { rows: subjects };
    if (sql.includes("directory-growth-contributions")) return { rows: options.contributions ?? [] };
    if (sql.includes("directory-growth-sources")) return { rows: options.sources ?? [] };
    if (sql.includes("directory-growth-policy") || sql.includes("FROM zzsh_iam.membership_growth_policy pol")) return { rows: options.policy ? [options.policy] : [] };
    if (sql.includes("directory-growth-entitlements")) return { rows: options.entitlements ?? [] };
    if (sql.includes("directory-credit-summaries")) return { rows: (options.credits ?? subjects.map(row => ({ userId: row.userId, score: 80, revision: "3", inScope: true, notInitialized:false }))).map(row=>({...row,notInitialized:row.notInitialized??(row.score===null&&row.revision===null)})) };
    if (sql.includes("legacy-growth-schema")) return { rows: [{ coverage: true, sources: true }] };
    if (sql.includes("legacy-growth-batch-versions")) return { rows: records };
    if (sql.includes("legacy-growth-versions")) return { rows: records.filter(row => row.userId === id) };
    if (sql.includes("legacy-growth-batch-live-sources")) return { rows: options.legacySources ?? [] };
    if (sql.includes("legacy-growth-live-sources")) return { rows: (options.legacySources ?? []).filter(row => row.userId === id) };
    if (sql.startsWith('SELECT id FROM zzsh_auth_user."user"')) return { rows: current ? [{ id }] : [] };
    if (sql.includes("FROM zzsh_iam.membership_growth_contribution")) return { rows: (options.contributions ?? []).filter(row => row.userId === id) };
    if (sql.includes("JOIN zzsh_order.settlement_posting p")) return { rows: (options.sources ?? []).filter(row => row.userId === id) };
    if (sql.includes('SELECT source_ref AS "sourceRef"')) return { rows: current ? [{ sourceRef: current.sourceRef }] : [] };
    if (sql.includes("FROM zzsh_iam.membership_growth_state WHERE")) return { rows: current?.normalTier ? [current] : [] };
    if (sql.includes("SELECT EXISTS(SELECT 1 FROM zzsh_iam.audit_event")) return { rows: [{ migrated: current?.migrated ?? false }] };
    if (sql.includes("FROM zzsh_iam.membership_entitlement WHERE")) return { rows: (options.entitlements ?? []).filter(row => row.userId === id) };
    throw new Error(`Unexpected read: ${sql}`);
  } } as unknown as PoolClient;
  return { client, queries };
}

test("denied capabilities and empty pages do not probe business tables", async () => {
  const f = fixture([subject("u")]);
  assert.deepEqual((await readUserDirectoryBusinessSummaries(f.client, { adminId: "staff", isBoss: false }, ["u"], at)).get("u"), {
    membershipSummary: { state: "denied", permission: "membership.growth.read.summary" }, creditSummary: { state: "denied", permission: "credit.read" },
  });
  assert.equal((await readUserDirectoryBusinessSummaries(f.client, viewer, [], at)).size, 0);
  assert.equal(f.queries.length, 0);
});

test("one user and fifty users share six reads, and known zero growth is independent of an absent policy", async () => {
  for (const count of [1, 50]) {
    const subjects = Array.from({ length: count }, (_, index) => subject(`u${index}`)), f = fixture(subjects);
    const result = await readUserDirectoryBusinessSummaries(f.client, viewer, subjects.map(row => row.userId), at);
    assert.equal(result.size, count); assert.equal(f.queries.length, 6);
    const summary = result.get("u0")!;
    assert.equal(summary.membershipSummary.state, "ready");
    if (summary.membershipSummary.state === "ready") {
      assert.equal(summary.membershipSummary.growth.knowledge, "KNOWN");
      assert.equal(summary.membershipSummary.growth.normalTier, "STANDARD");
      assert.equal(summary.membershipSummary.growth.benefitsState, "NOT_CONFIGURED");
    }
    assert.deepEqual(summary.creditSummary, { state: "ready", knowledge: "KNOWN", score: 80, revision: "3" });
    assert.match(f.queries.find(query => query.sql.includes("directory-credit-summaries"))!.sql, /game_scope_mode.*ALL_GAMES/);
  }
});

test("unknown migrated growth retains only active independent entitlements and does not initialize credit", async () => {
  const f = fixture([subject("legacy", true)], {
    entitlements: [entitlement("legacy"), entitlement("legacy", "REVOKED"), entitlement("legacy", "EXPIRED"), { ...entitlement("legacy", "EXECUTED_PENDING_START"), startsAt: "2026-10-20T00:00:00.000000Z" }, entitlement("legacy", "ACTIVE", at)],
    credits: [{ userId: "legacy", score: null, revision: null, inScope: true }],
  });
  const result = (await readUserDirectoryBusinessSummaries(f.client, viewer, ["legacy"], at)).get("legacy")!;
  assert.equal(result.membershipSummary.state, "ready");
  if (result.membershipSummary.state === "ready") {
    assert.equal(result.membershipSummary.growth.knowledge, "UNKNOWN");
    assert.equal(result.membershipSummary.growth.sourceState, "BACKFILL_PENDING");
    assert.equal(result.membershipSummary.growth.normalTier, null);
    assert.deepEqual(result.membershipSummary.entitlements, [{ id: "legacy:ACTIVE", kind: "FRIEND", scopeKey: "game-a", startsAtUtc: "2026-10-18T00:00:00.000000Z", endsAtUtc: "2026-10-20T00:00:00.000000Z", status: "ACTIVE", label: "挚友礼遇", depositWaived: true }]);
  }
  assert.deepEqual(result.creditSummary, { state: "ready", knowledge: "NOT_INITIALIZED", score: null, revision: null });
  assert.equal(f.queries.length, 9);
});

test("no-game and out-of-scope credit remain denied without exposing a stored score", async () => {
  const f = fixture([subject("u")], { credits: [{ userId: "u", score: 20, revision: "8", inScope: false }] });
  const noGames = (await readUserDirectoryBusinessSummaries(f.client, { ...viewer, membershipSummaryRead: false, businessScopeUsable: false }, ["u"], at)).get("u")!;
  assert.deepEqual(noGames.creditSummary, { state: "denied", permission: "credit.read", reason: "NO_GAME_SCOPE" }); assert.equal(f.queries.length, 0);
  const out = (await readUserDirectoryBusinessSummaries(f.client, { ...viewer, membershipSummaryRead: false }, ["u"], at)).get("u")!;
  assert.deepEqual(out.creditSummary, { state: "denied", permission: "credit.read", reason: "OUT_OF_SCOPE" }); assert.equal(f.queries.length, 1);
});

test("a missing credit state with an existing event is unavailable, while legitimate zero remains known", async () => {
  const orphan=fixture([subject("u")],{credits:[{userId:"u",score:null,revision:null,inScope:true,notInitialized:false}]});
  await assert.rejects(readUserDirectoryBusinessSummaries(orphan.client,{...viewer,membershipSummaryRead:false},["u"],at),(error:unknown)=>(error as {code:string}).code==="EVIDENCE_UNAVAILABLE");
  const zero=fixture([subject("u")],{credits:[{userId:"u",score:0,revision:"1",inScope:true,notInitialized:false}]});
  assert.deepEqual((await readUserDirectoryBusinessSummaries(zero.client,{...viewer,membershipSummaryRead:false},["u"],at)).get("u")!.creditSummary,{state:"ready",knowledge:"KNOWN",score:0,revision:"1"});
  const hidden=fixture([subject("u")],{credits:[{userId:"u",score:null,revision:null,inScope:false,notInitialized:false}]});
  assert.deepEqual((await readUserDirectoryBusinessSummaries(hidden.client,{...viewer,membershipSummaryRead:false},["u"],at)).get("u")!.creditSummary,{state:"denied",permission:"credit.read",reason:"OUT_OF_SCOPE"});
});

test("Boss credit summaries retain broad read when no game relationships exist", async () => {
  const f=fixture([subject("u")],{credits:[{userId:"u",score:85,revision:"2",inScope:true,notInitialized:false}]});
  const result=(await readUserDirectoryBusinessSummaries(f.client,{...viewer,isBoss:true,membershipSummaryRead:false,businessScopeUsable:false},["u"],at)).get("u")!;
  assert.deepEqual(result.creditSummary,{state:"ready",knowledge:"KNOWN",score:85,revision:"2"});assert.equal(f.queries.length,1);
});

test("batch growth is identical to the existing subject reader for native and unknown migrated subjects", async () => {
  const subjects = [subject("native"), subject("legacy", true)], options = { entitlements: [entitlement("legacy")] };
  const batch = await readMembershipGrowthBatch(fixture(subjects, options).client, subjects.map(row => row.userId), at);
  for (const row of subjects) assert.deepEqual(batch.get(row.userId), await readMembershipGrowth(fixture(subjects, options).client, row.userId, at));
});

test("nonzero formal settlement corrections preserve stored grace, black-gold and policy in batch/single parity", async () => {
  // The same settled/source/correction vectors as membership-growth-integration.test.ts, through both readers.
  const subjects = [
    { ...subject("grace"), normalTier: "GOLD", effectiveTier: "GOLD", blackGoldState: "NOT_QUALIFIED", lastTierDropAt: "2026-10-18T00:00:00.000000Z" },
    { ...subject("black-gold"), normalTier: "STANDARD", effectiveTier: "BLACK_GOLD", blackGoldState: "QUALIFIED" },
  ];
  const sourceHash = "a".repeat(64);
  const contributions = subjects.flatMap(({ userId }) => {
    const base: LegacyGrowthStoredContribution = { userId, gameId: "game-a", sourceKey: "RENTAL_SETTLEMENT:settlement-1:haff", sourceType: "RENTAL_SETTLEMENT", sourceId: "settlement-1:haff", settlementVersion: "1", effectiveAt: "2026-10-10T00:00:00.000000Z", recordedAt: "2026-10-10T00:00:00.000000Z", amountCents: "1000000", status: "SETTLED", eligible: true, revision: 0 };
    return [base, { ...base, revision: 1, amountCents: "600000", previousAmountCents: "1000000", correctionMode: "REPLACE" as const, correctionOf: base.sourceKey, recordedAt: "2026-10-18T00:00:00.000000Z" }]
      .map(row => ({ ...row, sourceDigest: growthContributionSourceDigest(sourceHash, row.gameId, row), revision: String(row.revision) as unknown as number }));
  });
  const sources = subjects.map(({ userId }) => ({ settlementVersionId: "settlement-1", versionNo: 1, versionHash: sourceHash, userId, gameId: "game-a", inputSnapshot: { schema: "settlement-version-v2", amounts: { haffConsumedBuyer: "10000.00", itemConsumedBuyer: "0.00" } } }));
  const pricing = { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode: "ordinary", priceVersionId: "price-v1", payableRatio: "0.95", costBasisRef: "synthetic-cost" };
  const policy = { id: "policy-1", version: "1", haffRule: { schema: "haff-ratio-v1" }, policyPayload: { schema: "membership-growth-v1", status: "APPROVED", version: "policy-1", effectiveAt: "2026-01-01T00:00:00.000000Z", sourceRef: "synthetic-cost", tiers: Object.fromEntries(NORMAL_GROWTH_TIERS.map(tier => [tier, { tier, tenantDeposit: tier === "STANDARD" || tier === "SILVER" ? "ACCOUNT_BASE" : "WAIVED", pricing: { ordinary: pricing }, entitlementCap: { byMode: { ordinary: pricing } } }])), entitlementCaps: { FRIEND: "GOLD", PRESTIGE: "DIAMOND" } } };
  const options = { contributions, sources, policy, entitlements: [entitlement("grace")] };
  const batchFixture = fixture(subjects, options), batch = await readMembershipGrowthBatch(batchFixture.client, subjects.map(row => row.userId), at);
  assert.equal(batchFixture.queries.length, 5);
  for (const row of subjects) {
    const single = await readMembershipGrowth(fixture(subjects, options).client, row.userId, at);
    assert.deepEqual(batch.get(row.userId), single);
    assert.equal(single!.growth.knowledge, "KNOWN"); assert.equal(single!.growth.benefitsState, "CONFIGURED");
    assert.equal(single!.growth.rollingPoints, "6000");
    assert.deepEqual(single!.growth.contributions.map(value => value.amountCents), ["600000"]);
  }
  assert.equal(batch.get("grace")!.growth.grace!.state, "ACTIVE");
  assert.equal(batch.get("grace")!.growth.normalTier, "SILVER"); assert.equal(batch.get("grace")!.growth.effectiveTier, "GOLD");
  assert.equal(batch.get("black-gold")!.growth.effectiveTier, "BLACK_GOLD");
});

function emptyLegacyRecord(userId: string): LegacyCoverageRecord {
  const cutoff = "2026-10-18T00:00:00.000000Z", sourceSetSha256 = sha256Hex(canonicalize({ subjectUserId: userId, cutoff, fromExclusive: null, expectedSourceKeys: [] }));
  const receipt = { subjectUserId: userId, cutoff, fromExclusive: null, sourceExtractSha256: "b".repeat(64), sourceSetSha256, expectedSourceKeys: [], refundReviewEvidenceRefs: ["SYNTHETIC_ZERO_SOURCE_REVIEW"] };
  const prepared = prepareLegacyGrowthBackfill({ receipt, inputs: [], corrections: [], admitted: { receiptDigests: [sha256Hex(canonicalize(receipt))], componentDigests: [], correctionDigests: [] }, gameIdBySettlementId: {}, packageDigest: "a".repeat(64) });
  assert(prepared.ok, prepared.ok ? undefined : JSON.stringify({ code: prepared.code, reason: prepared.reason }));
  return { ...prepared.record, executionKey: "fixture-business-summary" };
}

test("batch legacy coverage reuses canonical proof validation and matches the original reader", async () => {
  const userId = legacyBinding.renterUserId, record = emptyLegacyRecord(userId), options = { records: [record] }, subjects = [subject(userId, true)];
  const batch = await readLegacyGrowthCoverageAssessments(fixture(subjects, options).client, new Map([[userId, []]]), at);
  const single = await readLegacyGrowthCoverageAssessment(fixture(subjects, options).client, userId, [], at);
  assert.deepEqual(batch.get(userId), single); assert.equal(single.state, "COMPLETE");
  const result = await readMembershipGrowthBatch(fixture(subjects, options).client, [userId], at);
  assert.equal(result.get(userId)!.growth.knowledge, "KNOWN");
  const corrupted = { ...record, expectedSourceKeys: ["foreign-source"] };
  await assert.rejects(readLegacyGrowthCoverageAssessments(fixture(subjects, { records: [corrupted] }).client, new Map([[userId, []]]), at), (error: unknown) => (error as { code: string }).code === "EVIDENCE_UNAVAILABLE");
});

test("nonempty legacy proof stays complete while a new live source or changed fact refuses KNOWN growth", async () => {
  // Reuse the authoritative T input shape from membership-growth-legacy-store.test.ts.
  const userId = legacyBinding.renterUserId, sourceKey = "legacy_mysql_restore:la_order:7", cutoff = "2026-10-18T00:00:00.000000Z", completedAt = "2026-10-01T01:02:03.000000Z";
  const proof = (value: unknown) => { const canonical = canonicalize(value); return { canonical, digest: sha256Hex(canonical) }; };
  const raw = { id: "7", user_id: "11", sale_user_id: "22", accounts_id: "33", order_status: "4", pay_is: "1", pay_money: "100.00", return_order_money: "87.00", confirm_time: String(Date.parse(completedAt) / 1000) };
  const parentSourceDigest = sha256Hex(canonicalize(raw)), sourceRecord = proof({ ...raw, detain_money: "5.00" });
  const components = proof({ schema: "legacy-consumption-components.v1", parentSourceDigest, basisDigest: sourceRecord.digest, legacyOrderId: "7", oldRuleEvidenceRef: "SYNTHETIC_COMPONENTS", rentalCents: "1000", materialCents: "200", minimumBillingCents: "100", minimumAgreementRef: "SYNTHETIC_AGREEMENT" });
  const receipt = { subjectUserId: userId, cutoff, fromExclusive: null, sourceExtractSha256: "b".repeat(64), sourceSetSha256: sha256Hex(canonicalize({ subjectUserId: userId, cutoff, fromExclusive: null, expectedSourceKeys: [sourceKey] })), expectedSourceKeys: [sourceKey], refundReviewEvidenceRefs: ["SYNTHETIC_REVIEW"] };
  const prepared = prepareLegacyGrowthBackfill({ receipt, inputs: [{ binding: { ...legacyBinding, sourceDigest: parentSourceDigest, sourceOrderStatus: 4, completedAt }, subjectUserId: userId, recordedAt: "2026-10-17T02:00:00.000000Z", origin: { kind: "LEGACY_COMPLETED", parentSourceSnapshot: raw, sourceRecord, components } }], corrections: [], admitted: { receiptDigests: [sha256Hex(canonicalize(receipt))], componentDigests: [components.digest], correctionDigests: [] }, gameIdBySettlementId: { [sourceKey]: legacyBinding.gameId }, packageDigest: "a".repeat(64) });
  assert(prepared.ok); assert(prepared.rows.length > 0); assert.equal(prepared.coverageState, "COMPLETE");
  const record = { ...prepared.record, executionKey: "fixture-nonempty-proof" };
  const contributions = prepared.rows.map(row => ({ ...row.contribution, gameId: row.gameId, sourceDigest: row.sourceDigest }));
  const subjects = [subject(userId, true)], options = { records: [record], contributions, legacySources: [{ userId, sourceKey, commandId: null, revision: null }] };
  const original = await readMembershipGrowth(fixture(subjects, options).client, userId, at);
  const batch = await readMembershipGrowthBatch(fixture(subjects, options).client, [userId], at);
  assert.deepEqual(batch.get(userId), original); assert.equal(original!.growth.knowledge, "KNOWN"); assert.notEqual(original!.growth.lifetimePoints, "0");
  const newSource = { userId, sourceKey: "legacy_mysql_restore:la_order:8", commandId: null, revision: null };
  const drift = { ...options, legacySources: [...options.legacySources, newSource] };
  const drifted = (await readMembershipGrowthBatch(fixture(subjects, drift).client, [userId], at)).get(userId)!;
  assert.deepEqual(drifted, await readMembershipGrowth(fixture(subjects, drift).client, userId, at));
  assert.equal(drifted.growth.knowledge, "UNKNOWN"); assert.equal(drifted.growth.sourceState, "BACKFILL_PENDING");
  const changed = { ...options, contributions: contributions.map((row, index) => index === 0 ? { ...row, amountCents: "999999" } : row) };
  const conflicted = (await readMembershipGrowthBatch(fixture(subjects, changed).client, [userId], at)).get(userId)!;
  assert.deepEqual(conflicted, await readMembershipGrowth(fixture(subjects, changed).client, userId, at));
  assert.equal(conflicted.growth.knowledge, "UNKNOWN"); assert.equal(conflicted.growth.sourceState, "SOURCE_CONFLICT");
});

test("SQL cancellation and absent summary rows reject the batch rather than becoming successful UNKNOWN", async () => {
  const cancellation = Object.assign(new Error("cancelled"), { code: "57014" });
  const f = fixture([subject("u")], { fail: { match: "directory-growth-contributions", error: cancellation } });
  await assert.rejects(readUserDirectoryBusinessSummaries(f.client, viewer, ["u"], at), error => error === cancellation);
  assert.equal(f.queries.length, 2);
  await assert.rejects(readUserDirectoryBusinessSummaries(fixture([]).client, viewer, ["missing"], at), (error: unknown) => (error as { code: string }).code === "EVIDENCE_UNAVAILABLE");
});
