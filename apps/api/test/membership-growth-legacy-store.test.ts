import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { canonicalize } from "../src/supply/content-hash";
import { sha256Hex as sha } from "../src/supply/supply-util";
import { prepareLegacyGrowthBackfill, type LegacyCoverageRecord } from "../src/auth/membership-growth-legacy";
import { createLegacyGrowthCoveragePort, readLegacyGrowthCoverageAssessment, type LegacyGrowthStoredContribution } from "../src/auth/membership-growth-legacy-store";
import { growthContributionSourceDigest, readMembershipGrowth } from "../src/auth/membership-growth-integration";
import { legacyGrowthVersionHash } from "../src/auth/membership-growth-legacy";
import { configureLegacyGrowthCoveragePrivileges } from "../src/database/business-migrations";
import { deriveLegacyFacts, initialLegacyFacts } from "../src/order/legacy-continuation-model";
import { planLegacyContinuation } from "../src/order/legacy-continuation-calc";
import type { LegacyGrowthConsumptionInput, LegacyGrowthCoverageReceipt } from "../src/order/legacy-growth-consumption";
import { legacyBinding, legacyEvidence, legacyQuantities, legacySource } from "./legacy-continuation-fixture";

// Actual T/B source projection with synthetic rows only; no database connection.
const subject = legacyBinding.renterUserId, cutoff = "2026-10-18T00:00:00.000000Z", asOf = "2026-10-20T00:00:00.000000Z", sourceKey = "legacy_mysql_restore:la_order:7";
const proof = (v: unknown) => { const canonical = canonicalize(v); return { canonical, digest: sha(canonical) }; };
function historical(): LegacyGrowthConsumptionInput {
  const completedAt = "2026-10-01T01:02:03.000000Z", raw = { id: "7", user_id: "11", sale_user_id: "22", accounts_id: "33", order_status: "4", pay_is: "1", pay_money: "100.00", return_order_money: "87.00", confirm_time: String(Date.parse(completedAt) / 1000) };
  const parentSourceDigest = sha(canonicalize(raw)), sourceRecord = proof({ ...raw, detain_money: "5.00" });
  const components = proof({ schema: "legacy-consumption-components.v1", parentSourceDigest, basisDigest: sourceRecord.digest, legacyOrderId: "7", oldRuleEvidenceRef: "SYNTHETIC_COMPONENTS", rentalCents: "1000", materialCents: "200", minimumBillingCents: "100", minimumAgreementRef: "SYNTHETIC_AGREEMENT" });
  return { binding: { ...legacyBinding, sourceDigest: parentSourceDigest, sourceOrderStatus: 4, completedAt }, subjectUserId: subject, recordedAt: "2026-10-17T02:00:00.000000Z", origin: { kind: "LEGACY_COMPLETED", parentSourceSnapshot: raw, sourceRecord, components } };
}
function confirmed(): LegacyGrowthConsumptionInput {
  const original = initialLegacyFacts(legacySource()), p = { kind: "propose" as const, caller: { role: "renter" as const, legacyUserId: "11" }, quantities: legacyQuantities("1.00") }, proposed = planLegacyContinuation(original.evidence, p); assert(proposed.ok);
  const before = { ...legacyEvidence(deriveLegacyFacts(original, proposed, p, "original", "proposed")), id: "proposal_result", sourceKind: "DERIVED" as const, evidenceVersion: "2" };
  const command = { kind: "confirm" as const, caller: { role: "owner" as const, legacyUserId: "22" } }, plan = planLegacyContinuation(before.facts.evidence, command); assert(plan.ok);
  const result = { ...legacyEvidence(deriveLegacyFacts(before.facts, plan, command, before.id, "confirmed")), id: "confirmed_result", sourceKind: "DERIVED" as const, evidenceVersion: "3" };
  return { binding: legacyBinding, subjectUserId: subject, recordedAt: "2026-10-16T02:00:01.000000Z", origin: { kind: "CONTINUATION_CONFIRM", input: before, result, command: { id: "confirmed", revision: "2", createdAt: "2026-10-16T02:00:00.123456Z", inputEvidenceId: before.id, resultEvidenceId: result.id, planFingerprint: plan.fingerprint, actor: { realm: "user", userId: legacyBinding.ownerUserId, sessionId: "fixture", requestId: "fixture" } } } };
}
function prepared(inputs: LegacyGrowthConsumptionInput[] = [historical()], expected = [sourceKey], packageDigest = "a".repeat(64)) {
  const receipt: LegacyGrowthCoverageReceipt = { subjectUserId: subject, cutoff, fromExclusive: null, sourceExtractSha256: "b".repeat(64), sourceSetSha256: sha(canonicalize({ subjectUserId: subject, cutoff, fromExclusive: null, expectedSourceKeys: [...expected].sort() })), expectedSourceKeys: expected, refundReviewEvidenceRefs: ["SYNTHETIC_REVIEW"] };
  const p = prepareLegacyGrowthBackfill({ receipt, inputs, corrections: [], admitted: { receiptDigests: [sha(canonicalize(receipt))], componentDigests: inputs.flatMap(i => i.origin.components ? [i.origin.components.digest] : []), correctionDigests: [] }, gameIdBySettlementId: { [sourceKey]: legacyBinding.gameId }, packageDigest }); assert(p.ok); return p;
}
const record = (p: ReturnType<typeof prepared>, key = "fixture-execution-001"): LegacyCoverageRecord => ({ ...p.record, executionKey: key });
const rows = (p: ReturnType<typeof prepared>): LegacyGrowthStoredContribution[] => p.rows.map(r => ({ ...r.contribution, gameId: r.gameId, sourceDigest: r.sourceDigest }));
type Source = { sourceKey: string; commandId: string | null; revision: string | null };
function fixture(records: LegacyCoverageRecord[], sources: Source[] = []) {
  const trace: string[] = [], stored = [...records]; let inserted = 0;
  const client: any = { async query(sql: string, args: any[] = []) {
    trace.push(sql);
    const sealed = (r: LegacyCoverageRecord) => { const canonical = canonicalize(r); return { canonical, digest: sha(canonical) }; };
    if (sql.includes("legacy-growth-schema")) return { rows: [{ coverage: true, sources: true }] };
    if (sql.includes("legacy-growth-live-sources")) return { rows: sources };
    if (sql.includes("legacy-growth-versions")) return { rows: stored.map(sealed) };
    if (sql.startsWith("INSERT INTO zzsh_iam.membership_growth_legacy_coverage")) {
      const r = JSON.parse(args[8]) as LegacyCoverageRecord;
      if (stored.some(v => v.subjectUserId === r.subjectUserId && (v.fingerprint === r.fingerprint || v.executionKey === r.executionKey))) return { rows: [], rowCount: 0 };
      stored.push(r); inserted++; return { rows: [sealed(r)], rowCount: 1 };
    }
    if (sql.includes("record_canonical AS canonical")) {
      const r = stored.find(v => v.subjectUserId === args[0] && (sql.includes("execution_key=$2") ? v.executionKey : v.fingerprint) === args[1]);
      return { rows: r ? [sealed(r)] : [] };
    }
    throw Error("UNEXPECTED_QUERY");
  } };
  return { client, trace, stored, inserted: () => inserted };
}

test("coverage port persists exact canonical version on caller client; same key/fingerprint reads original", async () => {
  const p = prepared(), r = record(p), f = fixture([]), port = createLegacyGrowthCoveragePort();
  assert.deepEqual(await port.persist(f.client, r), r); assert.equal(f.inserted(), 1);
  assert.deepEqual(await port.persist(f.client, r), r); assert.equal(f.inserted(), 1);
  assert.deepEqual(await port.readByExecutionKey(f.client, subject, r.executionKey!), r);
  assert.deepEqual(await port.readByFingerprint(f.client, subject, r.fingerprint), r);
  assert(f.trace.some(s => s.includes("$9::text::jsonb,$9::text")), "both bindings start from the original text; JSONB formatting must not replace canonical bytes");
  assert(!f.trace.some(s => /^(BEGIN|COMMIT|ROLLBACK)/.test(s)));
});
test("coverage conflict gives raced execution key precedence over another key's matching fingerprint", async () => {
  const old = record(prepared(), "fixture-key-001"), next = record(prepared([historical()], [sourceKey], "c".repeat(64)), "fixture-key-001");
  const alias = { ...next, executionKey: "fixture-key-other" }, f = fixture([old, alias]);
  const stored = await createLegacyGrowthCoveragePort().persist(f.client, next);
  assert.equal(stored.fingerprint, old.fingerprint); assert.notEqual(stored.fingerprint, next.fingerprint);
});
test("coverage reader rejects a changed canonical digest instead of trusting a JSON record", async () => {
  await assert.rejects(createLegacyGrowthCoveragePort().readByFingerprint({ query: async () => ({ rows: [{ canonical: canonicalize(record(prepared())), digest: "f".repeat(64) }] }) } as never, subject, prepared().fingerprint), (e: any) => e.code === "EVIDENCE_UNAVAILABLE");
});
test("coverage port rejects duplicated source metadata that no longer agrees with the original receipt", async () => {
  const changed = { ...record(prepared()), expectedSourceKeys: [] }, f = fixture([]);
  await assert.rejects(createLegacyGrowthCoveragePort().persist(f.client, changed), (e: any) => e.code === "EVIDENCE_UNAVAILABLE");
  assert.equal(f.inserted(), 0);
});
test("full base survives a later partial of the same source; stored actual amounts are rehashed", async () => {
  const full = prepared(), partial = prepared([], [sourceKey], "c".repeat(64)), f = fixture([record(partial, "fixture-later-partial"), record(full)]);
  assert.equal((await readLegacyGrowthCoverageAssessment(f.client, subject, rows(full), asOf)).state, "COMPLETE");
  const changed = rows(full); changed[0]!.amountCents = "999999";
  assert.deepEqual((await readLegacyGrowthCoverageAssessment(f.client, subject, changed, asOf)).reasons, ["LEGACY_FACT_DIGEST_MISMATCH"]);
});
test("newer known source window keeps pending even when its contributions are empty", async () => {
  const full = prepared(), partial = prepared([], [sourceKey, "legacy_mysql_restore:la_order:8"], "c".repeat(64));
  const result = await readLegacyGrowthCoverageAssessment(fixture([record(partial), record(full)]).client, subject, rows(full), asOf);
  assert.deepEqual(result.reasons, ["LEGACY_SOURCE_WINDOW_UNVERIFIED"]);
});
test("uncovered CONFIRM keeps pending even before contributions exist and after HOLD supersedes its head", async () => {
  const p = prepared(), f = fixture([record(p)], [{ sourceKey, commandId: "confirmed-after-base", revision: "2" }]);
  assert.deepEqual((await readLegacyGrowthCoverageAssessment(f.client, subject, rows(p), asOf)).reasons, ["LEGACY_CONFIRM_FACTS_NOT_INGESTED"]);
  const sql = f.trace.find(s => s.includes("legacy-growth-live-sources"))!;
  assert(sql.includes("v.command='CONFIRM'")); assert(!sql.includes("superseded_at IS NULL"));
});
test("a source projected through real T CONFIRM is complete only with both verified components", async () => {
  const p = prepared([confirmed()]), f = fixture([record(p)], [{ sourceKey, commandId: "confirmed", revision: "2" }]);
  assert.equal((await readLegacyGrowthCoverageAssessment(f.client, subject, rows(p), asOf)).state, "COMPLETE");
  assert.equal((await readLegacyGrowthCoverageAssessment(f.client, subject, rows(p).slice(1), asOf)).state, "BACKFILL_PENDING");
});
test("extra native rows stay with native verifier; unverified legacy increments stay pending with microsecond asOf", async () => {
  const p = prepared(), base = rows(p), f = fixture([record(p)]);
  const native: LegacyGrowthStoredContribution = { ...base[0]!, sourceId: "native", sourceKey: "RENTAL_SETTLEMENT:native", settlementVersion: "native-v1", sourceDigest: "d".repeat(64) };
  assert.equal((await readLegacyGrowthCoverageAssessment(f.client, subject, [...base, native], asOf)).state, "COMPLETE");
  const extra = { ...base[0]!, revision: 2, recordedAt: "2026-10-20T00:00:00.123900Z" };
  extra.sourceDigest = growthContributionSourceDigest(legacyGrowthVersionHash(extra.sourceId, extra.settlementVersion), extra.gameId, extra);
  assert.equal((await readLegacyGrowthCoverageAssessment(f.client, subject, [...base, extra], "2026-10-20T00:00:00.123456Z")).state, "COMPLETE");
  assert.deepEqual((await readLegacyGrowthCoverageAssessment(f.client, subject, [...base, extra], "2026-10-20T00:00:00.124000Z")).reasons, ["LEGACY_INCREMENTS_UNVERIFIED"]);
});
test("missing schema and missing receipt remain pending, while a broken catalog read fails", async () => {
  assert.deepEqual((await readLegacyGrowthCoverageAssessment({ query: async () => ({ rows: [{ coverage: false, sources: false }] }) } as never, subject, [], asOf)).reasons, ["LEGACY_COVERAGE_SCHEMA_NOT_INSTALLED"]);
  assert.equal((await readLegacyGrowthCoverageAssessment(fixture([]).client, subject, [], asOf)).state, "BACKFILL_PENDING");
  await assert.rejects(readLegacyGrowthCoverageAssessment({ query: async () => ({ rows: [] }) } as never, subject, [], asOf));
});
test("actual membership reader consumes persisted coverage; new source does not silently show known growth", async () => {
  const p = prepared(), storage = fixture([record(p)]), own = rows(p);
  const client: any = { async query(sql: string, args: any[] = []) {
    if (sql.includes("legacy-growth-")) return storage.client.query(sql, args);
    if (sql.includes('SELECT id FROM zzsh_auth_user."user"')) return { rows: [{ id: subject }] };
    if (sql.includes("FROM zzsh_iam.membership_growth_contribution")) return { rows: own };
    if (sql.includes("FROM zzsh_iam.audit_event")) return { rows: [{ migrated: true }] };
    return { rows: [] };
  } };
  const dto = await readMembershipGrowth(client, subject, asOf); assert.equal(dto?.growth.sourceState, "COMPLETE"); assert.equal(dto?.growth.knowledge, "KNOWN"); assert.equal(dto?.growth.rollingPoints, "13");
});
test("coverage runtime ACL clears table and all stale column grants; broken inventory fails closed", async () => {
  const statements: string[] = [];
  const client: any = { async query(sql: string, args: any[]) { statements.push(sql); if (sql.startsWith("SELECT name,to_regclass")) return { rows: [{ name: args[0][0], present: true }] }; if (sql.startsWith("SELECT attname")) return { rows: ["id", "record"].map(attname => ({ attname })) }; return { rows: [] }; } };
  await configureLegacyGrowthCoveragePrivileges(client, "fixture_runtime");
  const text = statements.join("\n"); assert.match(text, /REVOKE ALL ON TABLE zzsh_iam.membership_growth_legacy_coverage/); assert.match(text, /REVOKE SELECT \("id","record"\), INSERT/); assert.match(text, /GRANT SELECT ON TABLE/); assert(!/GRANT (INSERT|UPDATE|DELETE)/.test(text));
  await assert.rejects(configureLegacyGrowthCoveragePrivileges({ query: async () => ({ rows: [] }) } as never, "fixture_runtime"));
});
test("new chain appends one migration while the accepted 74/80 prefixes stay byte-identical", () => {
  const migrations = readMigrationFiles({ migrationsFolder: resolve("migrations/business") }); assert.equal(migrations.length, 81);
  const digest = (n: number) => sha(JSON.stringify(migrations.slice(0, n).map(m => ({ hash: m.hash, when: String(m.folderMillis) }))));
  assert.equal(digest(74), "45124baf29a7e412b1df92e19afd6150eec95302a9e8270ef961a10373dd0852");
  assert.equal(digest(80), "9eb306ec90b83e8a97b9132744048e75e4669caa7134fbf92b41cda6808f2627");
  const sql = readFileSync(resolve("migrations/business/0080_membership_growth_legacy_coverage.sql"), "utf8");
  assert.match(sql, /UNIQUE\(subject_user_id,fingerprint\).*UNIQUE\(subject_user_id,execution_key\)/s);
  assert.match(sql, /maintenance owner required/); assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE/); assert.match(sql, /BEFORE TRUNCATE/);
  assert.match(sql, /aclexplode\(c\.attacl\)/); assert.match(sql, /REVOKE ALL PRIVILEGES \(%s\)/);
});
