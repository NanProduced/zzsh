import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { canonicalize } from "../src/supply/content-hash";
import { sha256Hex as sha } from "../src/supply/supply-util";
import { deriveLegacyFacts, initialLegacyFacts } from "../src/order/legacy-continuation-model";
import { planLegacyContinuation } from "../src/order/legacy-continuation-calc";
import { legacyBinding, legacyEvidence, legacyQuantities, legacySource } from "./legacy-continuation-fixture";
import { prepareLegacyConfirmGrowth, recordLegacyConfirmGrowth, type LegacyConfirmGrowthInput, type LegacyGrowthLiveSource } from "../src/auth/membership-growth-legacy-live";
import { prepareLegacyGrowthBackfill, type LegacyCoverageRecord } from "../src/auth/membership-growth-legacy";
import { readLegacyGrowthCoverageAssessment, readLegacyGrowthCoverageAssessments, type LegacyGrowthStoredContribution } from "../src/auth/membership-growth-legacy-store";
import { readMembershipGrowth, growthContributionSourceDigest } from "../src/auth/membership-growth-integration";
import { legacyGrowthVersionHash } from "../src/auth/membership-growth-legacy";

const subject = legacyBinding.renterUserId, cutoff = "2026-10-18T00:00:00.000000Z", confirmedAt = "2026-10-19T02:03:04.123456Z", asOf = "2026-10-20T03:00:00.000000Z";
function confirmation(quantities = legacyQuantities("1.00")): LegacyConfirmGrowthInput {
  const original = initialLegacyFacts(legacySource());
  const propose = { kind: "propose" as const, caller: { role: "renter" as const, legacyUserId: "11" }, quantities };
  const proposal = planLegacyContinuation(original.evidence, propose); assert(proposal.ok);
  const input = { ...legacyEvidence(deriveLegacyFacts(original, proposal, propose, "original", "proposal-version")), id: "proposal-result", sourceKind: "DERIVED" as const, evidenceVersion: "2" };
  const command = { kind: "confirm" as const, caller: { role: "owner" as const, legacyUserId: "22" } };
  const plan = planLegacyContinuation(input.facts.evidence, command); assert(plan.ok);
  const result = { ...legacyEvidence(deriveLegacyFacts(input.facts, plan, command, input.id, "runtime-confirm-2")), id: "confirm-result", sourceKind: "DERIVED" as const, evidenceVersion: "3" };
  return { binding: legacyBinding, subjectUserId: subject, recordedAt: confirmedAt, origin: { kind: "CONTINUATION_CONFIRM", input, result,
    command: { id: "runtime-confirm-2", revision: "2", createdAt: confirmedAt, inputEvidenceId: input.id, resultEvidenceId: result.id, planFingerprint: plan.fingerprint,
      actor: { realm: "user", userId: legacyBinding.ownerUserId, sessionId: "synthetic-confirm-session", requestId: "synthetic-confirm-request" } } } };
}
function importedConfirmation(quantities = legacyQuantities("10.00")): LegacyConfirmGrowthInput {
  const input = legacyEvidence(initialLegacyFacts(legacySource({ orderStatus: "8", quantities, saleEarnings: "13.00", returnOrderMoney: "87.00" })));
  const command = { kind: "confirm" as const, caller: { role: "owner" as const, legacyUserId: "22" } }, plan = planLegacyContinuation(input.facts.evidence, command); assert(plan.ok);
  const result = { ...legacyEvidence(deriveLegacyFacts(input.facts, plan, command, input.id, "runtime-import-confirm")), id: "import-confirm-result", sourceKind: "DERIVED" as const, evidenceVersion: "2" };
  return { binding: legacyBinding, subjectUserId: subject, recordedAt: confirmedAt, origin: { kind: "CONTINUATION_CONFIRM", input, result,
    command: { id: "runtime-import-confirm", revision: "1", createdAt: confirmedAt, inputEvidenceId: input.id, resultEvidenceId: result.id, planFingerprint: plan.fingerprint,
      actor: { realm: "user", userId: legacyBinding.ownerUserId, sessionId: "synthetic-import-session", requestId: "synthetic-import-request" } } } };
}
function historicalBase(): LegacyCoverageRecord {
  const receipt = { subjectUserId: subject, cutoff, fromExclusive: null, sourceExtractSha256: "a".repeat(64), sourceSetSha256: sha(canonicalize({ subjectUserId: subject, cutoff, fromExclusive: null, expectedSourceKeys: [] })), expectedSourceKeys: [], refundReviewEvidenceRefs: ["SYNTHETIC_HISTORICAL_REVIEW"] };
  const prepared = prepareLegacyGrowthBackfill({ receipt, inputs: [], corrections: [], admitted: { receiptDigests: [sha(canonicalize(receipt))], componentDigests: [], correctionDigests: [] }, gameIdBySettlementId: {}, packageDigest: "b".repeat(64) });
  assert(prepared.ok); return { ...prepared.record, executionKey: "synthetic-base-execution" };
}
function liveSource(input = confirmation()): LegacyGrowthLiveSource {
  return { sourceKey: "legacy_mysql_restore:la_order:" + input.binding.legacyId, commandId: input.origin.command.id, revision: input.origin.command.revision, createdAt: input.origin.command.createdAt, growthInput: input };
}
function fixture(options: { base?: boolean; failAt?: number } = {}) {
  const rows = new Map<string, LegacyGrowthStoredContribution>(), calls: string[] = [], sources: LegacyGrowthLiveSource[] = [];
  const records = options.base === false ? [] : [historicalBase()];
  let inserts = 0;
  const client = { async query(sql: string, args: unknown[] = []) {
    calls.push(sql);
    if (sql.startsWith("INSERT INTO zzsh_iam.membership_growth_contribution")) {
      inserts++; if (inserts === options.failAt) throw Error("SYNTHETIC_CONTRIBUTION_FAILURE");
      const key = args[3] + "\0" + args[7];
      if (rows.has(key)) return { rows: [], rowCount: 0 };
      rows.set(key, { userId: args[1], gameId: args[2], sourceKey: args[3], sourceType: args[4], sourceId: args[5], settlementVersion: args[6], revision: args[7], effectiveAt: args[8], recordedAt: args[9], amountCents: args[10], previousAmountCents: args[11] ?? undefined, correctionOf: args[12] ?? undefined, correctionMode: args[13] ?? undefined, status: args[14], eligible: args[15], sourceDigest: args[16] } as LegacyGrowthStoredContribution);
      return { rows: [{ id: args[0] }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT source_digest AS "sourceDigest"')) { const row = rows.get(args[1] + "\0" + args[2]); return { rows: row ? [{ sourceDigest: row.sourceDigest }] : [], rowCount: row ? 1 : 0 }; }
    if (sql.includes("legacy-growth-schema")) return { rows: [{ coverage: true, sources: true }] };
    if (sql.includes("legacy-growth-batch-versions") || sql.includes("legacy-growth-versions")) return { rows: records.filter(record => record.cutoff <= String(args[1])).sort((a, b) => b.cutoff.localeCompare(a.cutoff)).map(record => { const canonical = canonicalize(record); return { userId: subject, canonical, digest: sha(canonical) }; }) };
    if (sql.includes("legacy-growth-batch-live-sources") || sql.includes("legacy-growth-live-sources")) return { rows: sources.map(source => ({ ...source, userId: subject })) };
    if (sql.includes("FROM zzsh_iam.membership_growth_contribution")) return { rows: [...rows.values()] };
    if (sql.includes('SELECT id FROM zzsh_auth_user."user"')) return { rows: [{ id: subject }] };
    if (sql.includes("FROM zzsh_iam.audit_event")) return { rows: [{ migrated: true }] };
    return { rows: [], rowCount: 0 };
  } } as unknown as PoolClient;
  return { client, rows, calls, sources, records, async transaction<T>(action: () => Promise<T>) { const saved = new Map(rows); try { return await action(); } catch (error) { rows.clear(); for (const [key, row] of saved) rows.set(key, row); throw error; } } };
}

test("formal version 2 carries two exact components and stable replay keys without rewriting historical coverage", async () => {
  const input = confirmation(), prepared = prepareLegacyConfirmGrowth(input); assert(prepared.ok);
  const db = fixture(), old = canonicalize(db.records);
  assert.deepEqual(await recordLegacyConfirmGrowth(db.client, input), { inserted: 2, replayed: 0 });
  assert.deepEqual(await recordLegacyConfirmGrowth(db.client, structuredClone(input)), { inserted: 0, replayed: 2 });
  assert.equal(db.rows.size, 2);
  assert.deepEqual([...db.rows.values()].map(row => [row.sourceType, row.amountCents]).sort(), [["MATERIAL_CONSUMPTION", "0"], ["RENTAL_SETTLEMENT", "1300"]]);
  assert([...db.rows.values()].every(row => row.revision === 2 && row.settlementVersion === "runtime-confirm-2" && row.effectiveAt === confirmedAt && row.recordedAt === confirmedAt));
  assert.equal(canonicalize(db.records), old);
  assert(!db.calls.some(sql => /INSERT INTO zzsh_iam.membership_growth_legacy_coverage|^(BEGIN|COMMIT)/.test(sql)));
});

test("a priced material consumption keeps its independent exact component beside rental", async () => {
  const input = confirmation({ ...legacyQuantities("1.00"), coffee: "1.00" }), prepared = prepareLegacyConfirmGrowth(input); assert(prepared.ok);
  const material = prepared.rows.find(row => row.contribution.sourceType === "MATERIAL_CONSUMPTION")!;
  const rental = prepared.rows.find(row => row.contribution.sourceType === "RENTAL_SETTLEMENT")!;
  assert.equal(material.contribution.amountCents, "800"); assert(BigInt(rental.contribution.amountCents) > 0n);
  assert.notEqual(material.contribution.sourceKey, rental.contribution.sourceKey);
  assert.equal(material.contribution.settlementVersion, rental.contribution.settlementVersion);
});

test("imported pending confirmation proves zero only from seven explicit zero usages; missing or nonzero usage remains unproven", () => {
  const zero = prepareLegacyConfirmGrowth(importedConfirmation()); assert(zero.ok);
  assert.equal(zero.rows.find(row => row.contribution.sourceType === "MATERIAL_CONSUMPTION")!.contribution.amountCents, "0");
  for (const coffee of [null, "1.00"]) {
    const rejected = prepareLegacyConfirmGrowth(importedConfirmation({ ...legacyQuantities("10.00"), coffee }));
    assert.equal(rejected.ok, false); if (rejected.ok) assert.fail(); assert.equal(rejected.reason, "ITEM_COMPONENT_NOT_FROZEN");
  }
});

test("a completed historical base stays KNOWN after a separately verified CONFIRM increment, single and batch readers agree", async () => {
  const db = fixture(), input = confirmation();
  assert.equal((await readMembershipGrowth(db.client, subject, asOf))?.growth.knowledge, "KNOWN");
  db.sources.push(liveSource(input));
  assert.equal((await readLegacyGrowthCoverageAssessment(db.client, subject, [], asOf)).state, "BACKFILL_PENDING");
  await recordLegacyConfirmGrowth(db.client, input);
  const rows = [...db.rows.values()];
  const single = await readLegacyGrowthCoverageAssessment(db.client, subject, rows, asOf);
  const batch = await readLegacyGrowthCoverageAssessments(db.client, new Map([[subject, rows]]), asOf);
  assert.equal(single.state, "COMPLETE"); assert.deepEqual(batch.get(subject), single);
  const current = await readMembershipGrowth(db.client, subject, asOf);
  assert.equal(current?.growth.knowledge, "KNOWN"); assert.equal(current?.growth.rollingPoints, "13"); assert.equal(current?.growth.lifetimePoints, "13");
  assert.equal(db.records[0]!.cutoff, cutoff); assert.equal(db.records[0]!.fromExclusive, null);
});

test("an unknown historical base is not an extra CONFIRM gate and does not become known from the new contribution", async () => {
  const db = fixture({ base: false }), input = confirmation(); db.sources.push(liveSource(input));
  assert.equal((await recordLegacyConfirmGrowth(db.client, input)).inserted, 2);
  const current = await readMembershipGrowth(db.client, subject, asOf);
  assert.equal(current?.growth.knowledge, "UNKNOWN"); assert.equal(current?.growth.sourceState, "BACKFILL_PENDING");
});

test("missing or forged components and unproven sealed result never promote a known historical base", async () => {
  const db = fixture(), input = confirmation(); db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
  const rows = [...db.rows.values()];
  assert.deepEqual((await readLegacyGrowthCoverageAssessment(db.client, subject, rows.slice(1), asOf)).reasons, ["LEGACY_CONFIRM_FACTS_NOT_INGESTED"]);
  const changed = structuredClone(rows); changed[0]!.amountCents = "99999";
  changed[0]!.sourceDigest = growthContributionSourceDigest(legacyGrowthVersionHash(changed[0]!.sourceId, changed[0]!.settlementVersion), changed[0]!.gameId, changed[0]!);
  assert.equal((await readLegacyGrowthCoverageAssessment(db.client, subject, changed, asOf)).state, "SOURCE_CONFLICT");
  db.sources[0]!.growthInput!.origin.result.facts.amounts.expendOrder = "999.00";
  assert.deepEqual((await readLegacyGrowthCoverageAssessment(db.client, subject, rows, asOf)).reasons, ["LEGACY_CONFIRM_SOURCE_UNPROVEN"]);
});

test("a contribution whose formal source predates the base cannot self-extend its original accepted receipt", async () => {
  const db = fixture(), input = confirmation(); input.recordedAt = input.origin.command.createdAt = "2026-10-17T02:03:04.123456Z";
  db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
  assert.equal((await readLegacyGrowthCoverageAssessment(db.client, subject, [...db.rows.values()], asOf)).state, "BACKFILL_PENDING");
});

test("unrelated later revisions and unadmitted corrections remain UNKNOWN even beside a valid formal increment", async () => {
  const db = fixture(), input = confirmation(); db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
  const rows = [...db.rows.values()], extra = { ...rows[0]!, revision: 3, amountCents: "0", previousAmountCents: rows[0]!.amountCents, correctionOf: rows[0]!.sourceKey, correctionMode: "REPLACE" as const };
  extra.sourceDigest = growthContributionSourceDigest(legacyGrowthVersionHash(extra.sourceId, extra.settlementVersion), extra.gameId, extra);
  assert.deepEqual((await readLegacyGrowthCoverageAssessment(db.client, subject, [...rows, extra], asOf)).reasons, ["LEGACY_INCREMENTS_UNVERIFIED"]);
});

function zeroCorrectionExtension(fromExclusive: string | null = cutoff, correctedAmountCents = "0", packageDigest = "e".repeat(64)) {
  const input = confirmation(), sourceKey = "legacy_mysql_restore:la_order:" + legacyBinding.legacyId;
  const value = { schema: "legacy-growth-correction.v1", originalSourceKey: "RENTAL_SETTLEMENT:" + sourceKey, userId: subject, originalEffectiveAt: confirmedAt,
    previousAmountCents: "1300", correctedAmountCents, classification: "EFFECTIVE_PRICE_CORRECTION", alreadyReflectedInGrossReturn: false,
    sourceSystem: "legacy_mysql_restore", sourceEntity: "la_refund_record", sourceId: "synthetic-correction-1", recordedAt: asOf, revision: 3 };
  const canonical = canonicalize(value), correction = { baseSourceKey: value.originalSourceKey, proof: { canonical, digest: sha(canonical) } };
  const receipt = { subjectUserId: subject, cutoff: "2026-10-21T00:00:00.000000Z", fromExclusive, sourceExtractSha256: "d".repeat(64),
    sourceSetSha256: sha(canonicalize({ subjectUserId: subject, cutoff: "2026-10-21T00:00:00.000000Z", fromExclusive, expectedSourceKeys: [sourceKey] })), expectedSourceKeys: [sourceKey], refundReviewEvidenceRefs: ["SYNTHETIC_HISTORICAL_REVIEW", correction.proof.digest] };
  const prepared = prepareLegacyGrowthBackfill({ receipt, inputs: [input], corrections: [correction], admitted: { receiptDigests: [sha(canonicalize(receipt))], componentDigests: [], correctionDigests: [correction.proof.digest] }, gameIdBySettlementId: { [sourceKey]: legacyBinding.gameId }, packageDigest });
  assert(prepared.ok); return prepared;
}

test("an admitted immutable correction window extends the base and REPLACE-to-zero removes only the original consumption", async () => {
  const db = fixture(), input = confirmation(); db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
  const originalBase = canonicalize(db.records[0]), extension = zeroCorrectionExtension();
  for (const row of extension.rows) db.rows.set(row.contribution.sourceKey + "\0" + row.contribution.revision, { ...row.contribution, gameId: row.gameId, sourceDigest: row.sourceDigest });
  db.records.push({ ...extension.record, executionKey: "synthetic-correction-window" });
  const current = await readMembershipGrowth(db.client, subject, "2026-10-22T00:00:00.000000Z");
  assert.equal(current?.growth.knowledge, "KNOWN"); assert.equal(current?.growth.rollingPoints, "0"); assert.equal(current?.growth.lifetimePoints, "0");
  assert.equal(canonicalize(db.records[0]), originalBase); assert.equal(db.rows.size, 3, "the original rental/material rows are retained beside the corrective revision");
});

test("a later admitted correction window with an unproved gap does not manufacture continuous source coverage", async () => {
  const db = fixture(), input = confirmation(); db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
  const extension = zeroCorrectionExtension("2026-10-18T01:00:00.000000Z");
  for (const row of extension.rows) db.rows.set(row.contribution.sourceKey + "\0" + row.contribution.revision, { ...row.contribution, gameId: row.gameId, sourceDigest: row.sourceDigest });
  db.records.push({ ...extension.record, executionKey: "synthetic-unverified-gap" });
  const current = await readMembershipGrowth(db.client, subject, "2026-10-22T00:00:00.000000Z"); assert.equal(current?.growth.knowledge, "UNKNOWN");
});

test("overlapping COMPLETE windows and equal-cutoff replay versions verify every fact without replacing the base", async () => {
  const db = fixture(), input = confirmation(); db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
  const old = canonicalize(db.records[0]), overlap = zeroCorrectionExtension("2026-10-17T00:00:00.000000Z"), sibling = zeroCorrectionExtension(cutoff, "0", "f".repeat(64));
  for (const row of overlap.rows) db.rows.set(row.contribution.sourceKey + "\0" + row.contribution.revision, { ...row.contribution, gameId: row.gameId, sourceDigest: row.sourceDigest });
  db.records.push({ ...overlap.record, executionKey: "synthetic-overlap-window" }, { ...sibling.record, executionKey: "synthetic-same-cutoff" });
  const result = await readLegacyGrowthCoverageAssessment(db.client, subject, [...db.rows.values()], "2026-10-22T00:00:00.000000Z");
  assert.equal(result.state, "COMPLETE"); assert.equal(canonicalize(db.records[0]), old);
});

test("the newest complete full base can include a correction without treating its accepted rows as a conflict with an older base", async () => {
  const db = fixture(), input = confirmation(); db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
  const latest = zeroCorrectionExtension(null), old = canonicalize(db.records[0]);
  for (const row of latest.rows) db.rows.set(row.contribution.sourceKey + "\0" + row.contribution.revision, { ...row.contribution, gameId: row.gameId, sourceDigest: row.sourceDigest });
  db.records.push({ ...latest.record, executionKey: "synthetic-new-full-base" });
  assert.equal((await readLegacyGrowthCoverageAssessment(db.client, subject, [...db.rows.values()], "2026-10-22T00:00:00.000000Z")).state, "COMPLETE");
  assert.equal(canonicalize(db.records[0]), old);
});

test("conflicting equal-cutoff correction receipts cannot bless a different same-revision amount", async () => {
  const db = fixture(), input = confirmation(); db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
  const one = zeroCorrectionExtension(), fork = zeroCorrectionExtension(cutoff, "100", "f".repeat(64));
  for (const row of one.rows) db.rows.set(row.contribution.sourceKey + "\0" + row.contribution.revision, { ...row.contribution, gameId: row.gameId, sourceDigest: row.sourceDigest });
  db.records.push({ ...one.record, executionKey: "synthetic-correction-one" }, { ...fork.record, executionKey: "synthetic-correction-fork" });
  assert.notEqual((await readLegacyGrowthCoverageAssessment(db.client, subject, [...db.rows.values()], "2026-10-22T00:00:00.000000Z")).state, "COMPLETE");
});

test("multiple partial windows never compose a COMPLETE source receipt", async () => {
  const db = fixture(), input = confirmation(); db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
  const complete = zeroCorrectionExtension(), receipt = JSON.parse(complete.record.receiptCanonical);
  for (const packageDigest of ["d".repeat(64), "f".repeat(64)]) {
    const partial = prepareLegacyGrowthBackfill({ receipt, inputs: [], corrections: [], admitted: { receiptDigests: [sha(canonicalize(receipt))], componentDigests: [], correctionDigests: [] }, gameIdBySettlementId: {}, packageDigest }); assert(partial.ok);
    assert.equal(partial.coverageState, "BACKFILL_PENDING"); db.records.push({ ...partial.record, executionKey: "synthetic-partial-" + packageDigest.slice(0, 8) });
  }
  assert.equal((await readLegacyGrowthCoverageAssessment(db.client, subject, [...db.rows.values()], "2026-10-22T00:00:00.000000Z")).state, "BACKFILL_PENDING");
});

test("a later-ending COMPLETE window can bridge an earlier-ending window regardless of receipt read order", async () => {
  const closure = (fromExclusive: string | null, until: string, letter: string) => {
    const receipt = { subjectUserId: subject, cutoff: until, fromExclusive, sourceExtractSha256: letter.repeat(64),
      sourceSetSha256: sha(canonicalize({ subjectUserId: subject, cutoff: until, fromExclusive, expectedSourceKeys: [] })), expectedSourceKeys: [], refundReviewEvidenceRefs: ["SYNTHETIC_HISTORICAL_REVIEW"] };
    const prepared = prepareLegacyGrowthBackfill({ receipt, inputs: [], corrections: [], admitted: { receiptDigests: [sha(canonicalize(receipt))], componentDigests: [], correctionDigests: [] }, gameIdBySettlementId: {}, packageDigest: letter.repeat(64) });
    assert(prepared.ok); assert.equal(prepared.coverageState, "COMPLETE"); return { ...prepared.record, executionKey: "synthetic-bridge-" + letter };
  };
  const base = closure(null, "2026-10-01T00:00:00.000000Z", "a");
  const a = closure("2026-10-05T00:00:00.000000Z", "2026-10-10T00:00:00.000000Z", "b");
  const b = closure("2026-10-01T00:00:00.000000Z", "2026-10-12T00:00:00.000000Z", "c");
  for (const records of [[base, a, b], [b, a, base], [a, base, b]]) {
    const db = fixture(); db.records.splice(0, db.records.length, ...records);
    assert.equal((await readLegacyGrowthCoverageAssessment(db.client, subject, [], asOf)).state, "COMPLETE");
  }
  const missingBridge = fixture(); missingBridge.records.splice(0, missingBridge.records.length, base, a);
  assert.equal((await readLegacyGrowthCoverageAssessment(missingBridge.client, subject, [], asOf)).state, "BACKFILL_PENDING", "a genuinely unreachable COMPLETE window remains a gap");
});

test("the formal effective instant participates once in the 90-day window and lifetime; frozen quote bytes are untouched", async () => {
  const db = fixture(), input = confirmation(); db.sources.push(liveSource(input));
  const existingQuote = { schema: "personal-quote-v4", membershipGrowth: { effectiveTier: "STANDARD", rollingPoints: "0" }, orderAmountCents: "12345" }, frozen = canonicalize(existingQuote);
  await recordLegacyConfirmGrowth(db.client, input);
  const inside = await readMembershipGrowth(db.client, subject, asOf); assert.equal(inside?.growth.rollingPoints, "13");
  const outside = await readMembershipGrowth(db.client, subject, "2027-01-18T00:00:00.000000Z");
  assert.equal(outside?.growth.rollingPoints, "0"); assert.equal(outside?.growth.lifetimePoints, "13");
  assert.equal(canonicalize(existingQuote), frozen); assert(!db.calls.some(sql => /UPDATE.*(?:rental_order|confirmation|quote_snapshot)/i.test(sql)));
});

test("unprovable amounts refuse before contribution writes and a mid-write failure rolls back on the caller transaction", async () => {
  const input = confirmation(), invalid = structuredClone(input); invalid.origin.result.facts.amounts.expendOrder = null;
  const untouched = fixture(); await assert.rejects(recordLegacyConfirmGrowth(untouched.client, invalid), /LEGACY_CONFIRM_GROWTH_UNPROVEN/); assert.equal(untouched.rows.size, 0);
  const failed = fixture({ failAt: 2 });
  await assert.rejects(failed.transaction(() => recordLegacyConfirmGrowth(failed.client, input)), /SYNTHETIC_CONTRIBUTION_FAILURE/);
  assert.equal(failed.rows.size, 0, "offline transaction model preserves rollback; real PG remains a separate required check");
});

test("concurrent unique inserts replay exactly and a different same-revision body conflicts rather than overwriting", async () => {
  const db = fixture(), input = confirmation();
  const replies = await Promise.all([recordLegacyConfirmGrowth(db.client, input), recordLegacyConfirmGrowth(db.client, structuredClone(input))]);
  assert.equal(replies.reduce((sum, value) => sum + value.inserted, 0), 2); assert.equal(db.rows.size, 2);
  const first = [...db.rows.values()][0]!; first.sourceDigest = "f".repeat(64);
  await assert.rejects(recordLegacyConfirmGrowth(db.client, input), /LEGACY_GROWTH_REVISION_CONFLICT/);
});


test("each sealed material quantity must be an explicit valid zero; no missing or coerced value proves consumption", () => {
  const keys = ["barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"] as const;
  for (const key of keys) {
    for (const value of [undefined, null, "1.00", "0.000", "00", "-0", " 0", "0e0", 0]) {
      const quantities = { ...legacyQuantities("10.00"), [key]: value } as unknown as ReturnType<typeof legacyQuantities>;
      const projected = prepareLegacyConfirmGrowth(importedConfirmation(quantities));
      assert.equal(projected.ok, false, key + ":" + String(value));
    }
  }
  for (const value of ["0", "0.0", "0.00"]) {
    const quantities = { ...legacyQuantities("10.00"), ...Object.fromEntries(keys.map(key => [key, value])) };
    const projected = prepareLegacyConfirmGrowth(importedConfirmation(quantities));
    assert(projected.ok); assert.equal(projected.rows.length, 2);
    assert.equal(projected.rows.find(row => row.contribution.sourceType === "MATERIAL_CONSUMPTION")!.contribution.amountCents, "0");
  }
});

test("formal source identity and game bindings cannot be replaced by a valid self-hash", async () => {
  const mutations: Array<[string, (source: LegacyGrowthLiveSource) => void]> = [
    ["subject", source => { source.growthInput!.subjectUserId = legacyBinding.ownerUserId; }],
    ["source key", source => { source.sourceKey = "legacy_mysql_restore:la_order:8"; }],
    ["command", source => { source.commandId = "another-confirm"; }],
    ["revision", source => { source.revision = "3"; }],
    ["createdAt", source => { source.createdAt = "2026-10-19T02:03:04.123457Z"; }],
    ["game", source => { source.growthInput!.binding.gameId = "another-game"; }],
  ];
  for (const [name, mutate] of mutations) {
    const db = fixture(), input = confirmation(); await recordLegacyConfirmGrowth(db.client, input);
    const source = liveSource(input); mutate(source); db.sources.push(source);
    const rows = [...db.rows.values()];
    const single = await readLegacyGrowthCoverageAssessment(db.client, subject, rows, asOf);
    const batch = await readLegacyGrowthCoverageAssessments(db.client, new Map([[subject, rows]]), asOf);
    assert.notEqual(single.state, "COMPLETE", name); assert.deepEqual(batch.get(subject), single, name);
  }
});

test("a formal confirmation at the historical cutoff requires receipt coverage, the following microsecond can be an increment", async () => {
  for (const [at, expected] of [[cutoff, "BACKFILL_PENDING"], ["2026-10-18T00:00:00.000001Z", "COMPLETE"]]) {
    const db = fixture(), input = confirmation(); input.recordedAt = input.origin.command.createdAt = at!;
    db.sources.push(liveSource(input)); await recordLegacyConfirmGrowth(db.client, input);
    assert.equal((await readLegacyGrowthCoverageAssessment(db.client, subject, [...db.rows.values()], asOf)).state, expected);
  }
});

test("all covered window facts must be present and later unadmitted facts never inherit VERIFIED", async () => {
  const db = fixture(), input = confirmation(), extension = zeroCorrectionExtension();
  db.sources.push(liveSource(input)); db.records.push({ ...extension.record, executionKey: "synthetic-window-complete" });
  const rows = extension.rows.map(row => ({ ...row.contribution, gameId: row.gameId, sourceDigest: row.sourceDigest }));
  for (let i = 0; i < rows.length; i++) {
    const partial = rows.filter((_, index) => index !== i);
    assert.notEqual((await readLegacyGrowthCoverageAssessment(db.client, subject, partial, "2026-10-22T00:00:00.000000Z")).state, "COMPLETE");
  }
  assert.equal((await readLegacyGrowthCoverageAssessment(db.client, subject, rows, "2026-10-22T00:00:00.000000Z")).state, "COMPLETE");
});
