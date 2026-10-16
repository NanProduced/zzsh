import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { prepareLegacyGrowthBackfill, runLegacyGrowthBackfill, recoverLegacyGrowthBackfill, writePreparedLegacyGrowth, assessLegacyCoverageRecord, LegacyGrowthConflictError, LegacyGrowthOutcomeError, type LegacyCoverageResult, type LegacyCoverageRecord, type LegacyCoveragePort } from "../src/auth/membership-growth-legacy";
import { readGrowthSourceCompleteness } from "../src/auth/membership-growth-integration";
import { closeLegacyGrowthCoverage, type LegacyGrowthProjection, type LegacyGrowthCoverageReceipt } from "../src/order/legacy-growth-consumption";
import { canonicalize } from "../src/supply/content-hash";
import type { SettledContributionFact } from "../src/auth/membership-growth";

// FIXTURE ONLY: synthetic ids/amounts; no real rows, no DB.
const U = "user_fixture_a", PKG = "a".repeat(64), S1 = "legacy_mysql_restore:la_order:101", S2 = "legacy_mysql_restore:la_order:102";
const CUTOFF = "2026-09-13T13:31:22.000000Z";
const games = { [S1]: "game-a", [S2]: "game-b" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fact = (settlementId: string, component: SettledContributionFact["component"], amount: string, effectiveAt = "2026-01-02T03:04:05.123456Z", extra: Partial<SettledContributionFact> = {}): SettledContributionFact =>
  ({ userId: U, settlementId, settlementVersion: "legacy-cutoff:" + "b".repeat(64), component, effectiveAt, recordedAt: "2026-09-13T13:31:22.000001Z", amountCents: amount, status: "SETTLED", revision: 1, ...extra });
const receiptFor = (expected: string[], refs = ["fixture-refund-review"]): LegacyGrowthCoverageReceipt =>
  ({ subjectUserId: U, cutoff: CUTOFF, fromExclusive: null, sourceExtractSha256: "f".repeat(64), sourceSetSha256: sha(canonicalize({ subjectUserId: U, cutoff: CUTOFF, fromExclusive: null, expectedSourceKeys: [...expected].sort() })), expectedSourceKeys: expected, refundReviewEvidenceRefs: refs });
const cov = (facts: SettledContributionFact[], expected = [S1, S2], state: LegacyCoverageResult["state"] = "COMPLETE", reason: string | null = null, extra: Partial<LegacyCoverageResult> = {}): LegacyCoverageResult =>
  ({ subjectUserId: U, state, reason, facts, outOfScopeFacts: [], missingSourceKeys: [], unknown: [], scope: { cutoff: CUTOFF, fromExclusive: null }, expectedSourceKeys: expected, ...extra });
const prep = (facts: SettledContributionFact[], o: { expected?: string[]; state?: LegacyCoverageResult["state"]; reason?: string | null; pkg?: string; receipt?: LegacyGrowthCoverageReceipt | null; extra?: Partial<LegacyCoverageResult>; g?: Record<string, string> } = {}) => {
  const expected = o.expected ?? [S1, S2];
  return prepareLegacyGrowthBackfill({ coverage: cov(facts, expected, o.state ?? "COMPLETE", o.reason ?? null, o.extra ?? {}), gameIdBySettlementId: o.g ?? games, packageDigest: o.pkg ?? PKG, receipt: o.receipt === undefined ? receiptFor(expected) : o.receipt });
};

type Row = { digest: string; effectiveAt: string; amount: string };
function fakeDb(opts: { failCommit?: boolean; failInsertAt?: number; failPersist?: boolean } = {}) {
  const table = new Map<string, Row>(), records = new Map<string, LegacyCoverageRecord>();
  let pending = new Map<string, Row>(), pendingRec = new Map<string, LegacyCoverageRecord>(); let inserts = 0; const log: string[] = [];
  const flush = () => { for (const [k, v] of pending) table.set(k, v); for (const [k, v] of pendingRec) records.set(k, v); pending = new Map(); pendingRec = new Map(); };
  const client: any = {
    async query(sql: string, p: unknown[] = []) {
      log.push(sql.trim().split(/\s+/)[0]!);
      if (sql.startsWith("BEGIN")) { pending = new Map(); pendingRec = new Map(); return { rows: [], rowCount: 0 }; }
      if (sql === "COMMIT") { flush(); if (opts.failCommit) throw new Error("connection lost during COMMIT"); return { rows: [], rowCount: 0 }; }
      if (sql === "ROLLBACK") { pending = new Map(); pendingRec = new Map(); return { rows: [], rowCount: 0 }; }
      if (sql.includes("INSERT INTO zzsh_iam.membership_growth_contribution")) {
        inserts += 1; if (opts.failInsertAt === inserts) throw new Error("statement failed");
        const k = `${p[1]}|${p[3]}|${p[7]}`; if (table.has(k) || pending.has(k)) return { rows: [], rowCount: 0 };
        pending.set(k, { digest: p[16] as string, effectiveAt: p[8] as string, amount: p[10] as string }); return { rows: [{ id: p[0] }], rowCount: 1 };
      }
      if (sql.includes("SELECT source_digest")) { const k = `${p[0]}|${p[1]}|${p[2]}`; const r = pending.get(k) ?? table.get(k); return { rows: r ? [{ sourceDigest: r.digest }] : [], rowCount: r ? 1 : 0 }; }
      throw new Error("unexpected sql " + sql);
    },
    release() {},
  };
  const port: LegacyCoveragePort = {
    async persist(_c, record) { if (opts.failPersist) throw new Error("coverage insert failed"); const k = `${record.subjectUserId}|${record.receiptDigest}`; const prior = pendingRec.get(k) ?? records.get(k); if (prior) return prior; pendingRec.set(k, record); return record; },
    async read(_c, s, d) { return pendingRec.get(`${s}|${d}`) ?? records.get(`${s}|${d}`) ?? null; },
  };
  return { table, records, client, port, pool: { async connect() { return client; } } as any, log };
}
const ok = (p: ReturnType<typeof prepareLegacyGrowthBackfill>) => { assert.equal(p.ok, true, JSON.stringify(p)); return p as Extract<typeof p, { ok: true }>; };
const reason = (p: ReturnType<typeof prepareLegacyGrowthBackfill>) => (p.ok ? null : p.reason);

test("COMPLETE: contributions + coverage record in one transaction; 6-digit microseconds; original key+body replays from the stored record", async () => {
  const db = fakeDb();
  const facts = [fact(S1, "RENTAL_SETTLEMENT", "1000"), fact(S1, "MATERIAL_CONSUMPTION", "250"), fact(S2, "RENTAL_SETTLEMENT", "0")];
  const p = ok(prep(facts));
  const first = await runLegacyGrowthBackfill(db.pool, p, db.port);
  assert.deepEqual([first.inserted, first.replayed, first.coverage], [3, 0, "INSERTED"]);
  assert.ok([...db.table.values()].every((r) => r.effectiveAt === "2026-01-02T03:04:05.123456Z"));
  assert.equal([...db.table.values()].map((r) => BigInt(r.amount)).reduce((a, b) => a + b, 0n), 1250n);
  const rec = [...db.records.values()][0]!;
  assert.deepEqual([rec.receiptDigest, rec.sourceExtractSha256, rec.refundReviewEvidenceRefs, rec.factKeys.length], [sha(canonicalize(receiptFor([S1, S2]))), "f".repeat(64), ["fixture-refund-review"], 3]);
  const again = await runLegacyGrowthBackfill(db.pool, ok(prep(facts)), db.port);
  assert.deepEqual([again.inserted, again.coverage], [0, "REPLAYED"]);
  assert.equal(db.log.filter((s) => s === "INSERT").length, 3, "replay did not re-run inserts");
});

test("stable fingerprint binds package, receipt, coverage state and fact set; microsecond change differs", () => {
  const a = ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000")]));
  assert.equal(a.fingerprint, ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000")])).fingerprint);
  assert.notEqual(a.fingerprint, ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000", "2026-01-02T03:04:05.123457Z")])).fingerprint);
  assert.notEqual(a.fingerprint, ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000")], { pkg: "d".repeat(64) })).fingerprint);
  assert.notEqual(a.fingerprint, ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000")], { receipt: receiptFor([S1, S2], ["other-review"]) })).fingerprint);
  assert.notEqual(a.fingerprint, ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000")], { state: "BACKFILL_PENDING", reason: "SOURCE_FACTS_PENDING", extra: { missingSourceKeys: [S2] } })).fingerprint);
});

test("legal zero source: COMPLETE with empty expected set writes 0 facts but persists a recoverable receipt", async () => {
  const db = fakeDb();
  const p = ok(prep([], { expected: [] }));
  assert.equal(p.rows.length, 0);
  const r = await runLegacyGrowthBackfill(db.pool, p, db.port);
  assert.deepEqual([r.inserted, r.coverage, db.records.size], [0, "INSERTED", 1]);
  assert.equal((await recoverLegacyGrowthBackfill(db.client, p, db.port)).status, "FOUND");
  assert.equal((await recoverLegacyGrowthBackfill(fakeDb().client, p, fakeDb().port)).status, "NOT_FOUND");
});

test("missing/invalid receipt, receipt-coverage mismatch, conflict and COMPLETE-with-gaps write nothing", () => {
  assert.equal(reason(prep([fact(S1, "RENTAL_SETTLEMENT", "1")], { receipt: null })), "RECEIPT_MISSING");
  for (const r of ["FULL_SOURCE_RECEIPT_MISSING", "SOURCE_COVERAGE_NOT_ADMITTED"]) assert.equal(prep([fact(S1, "RENTAL_SETTLEMENT", "1")], { state: "BACKFILL_PENDING", reason: r }).ok, false);
  assert.equal(reason(prep([fact(S1, "RENTAL_SETTLEMENT", "1")], { state: "SOURCE_CONFLICT", reason: "SOURCE_COVERAGE_CONFLICT" })), "SOURCE_COVERAGE_CONFLICT");
  assert.equal(reason(prep([fact(S1, "RENTAL_SETTLEMENT", "1")], { receipt: receiptFor([S1]) })), "RECEIPT_COVERAGE_MISMATCH");
  assert.equal(reason(prep([fact(S1, "RENTAL_SETTLEMENT", "1")], { receipt: { ...receiptFor([S1, S2]), cutoff: "2026-09-14T00:00:00.000000Z" } })), "RECEIPT_COVERAGE_MISMATCH");
  assert.equal(reason(prep([fact(S1, "RENTAL_SETTLEMENT", "1")], { receipt: receiptFor([S1, S2], []) })), "RECEIPT_COVERAGE_MISMATCH");
  assert.equal(reason(prep([fact(S1, "RENTAL_SETTLEMENT", "1")], { extra: { missingSourceKeys: [S2] } })), "COMPLETE_WITH_GAPS");
});

test("partial facts: SOURCE_FACTS_PENDING persists known facts with a BACKFILL_PENDING record; reader stays pending", async () => {
  const db = fakeDb();
  const p = ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1")], { state: "BACKFILL_PENDING", reason: "SOURCE_FACTS_PENDING", extra: { missingSourceKeys: [S2] } }));
  await runLegacyGrowthBackfill(db.pool, p, db.port);
  const rec = [...db.records.values()][0]!;
  assert.deepEqual([rec.coverageState, rec.missingSourceKeys], ["BACKFILL_PENDING", [S2]]);
  const rows = p.rows.map((r) => ({ sourceKey: r.contribution.sourceKey, revision: r.contribution.revision, sourceDigest: r.sourceDigest, status: "SETTLED" }));
  assert.equal(assessLegacyCoverageRecord(rec, rows).state, "BACKFILL_PENDING");
});

test("rejects non-legacy source, missing game binding, foreign subject, non-SETTLED, non-growth components", () => {
  assert.equal(reason(prep([fact("native:settlement:1", "RENTAL_SETTLEMENT", "1")])), "FACT_NOT_LEGACY_SOURCE");
  assert.equal(reason(prep([fact(S1, "RENTAL_SETTLEMENT", "1")], { g: {} })), "GAME_BINDING_MISSING");
  assert.equal(reason(prep([{ ...fact(S1, "RENTAL_SETTLEMENT", "1"), userId: "other" }])), "FACT_SUBJECT_MISMATCH");
  assert.equal(reason(prep([{ ...fact(S1, "RENTAL_SETTLEMENT", "1"), status: "PENDING" } as any])), "FACT_NOT_SETTLED");
  for (const c of ["DEPOSIT", "COMMISSION", "BALANCE"]) assert.equal(prep([fact(S1, c as any, "1")]).ok, false);
  assert.equal(prep([], { pkg: "nope" }).ok, false);
});

test("duplicates collapse when identical, divergent same revision is SOURCE_CONFLICT", () => {
  assert.equal(ok(prep([fact(S1, "RENTAL_SETTLEMENT", "5"), fact(S1, "RENTAL_SETTLEMENT", "5")])).rows.length, 1);
  assert.equal(reason(prep([fact(S1, "RENTAL_SETTLEMENT", "5"), fact(S1, "RENTAL_SETTLEMENT", "6")])), "DUPLICATE_REVISION_DIVERGES");
});

test("refund correction REPLACE keeps original effectiveAt, links correctionOf, enters fact set", async () => {
  const corr = fact("legacy_refund:la_refund:9", "REFUND_CORRECTION", "800", "2026-01-02T03:04:05.123456Z", { revision: 2, previousAmountCents: "1000", correctionOf: `RENTAL_SETTLEMENT:${S1}`, correctionMode: "REPLACE" });
  const p = ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000"), corr]));
  const c = p.rows.map((r) => r.contribution).find((x) => x.revision === 2)!;
  assert.deepEqual([c.sourceKey, c.effectiveAt], [`RENTAL_SETTLEMENT:${S1}`, "2026-01-02T03:04:05.123456Z"]);
  assert.equal(p.record.factKeys.length, 2);
  const db = fakeDb(); assert.equal((await runLegacyGrowthBackfill(db.pool, p, db.port)).inserted, 2);
});

test("same receipt with changed body is rejected before any insert; divergent existing row rolls back", async () => {
  const db = fakeDb();
  await runLegacyGrowthBackfill(db.pool, ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000")])), db.port);
  const n = db.log.filter((s) => s === "INSERT").length;
  await assert.rejects(() => runLegacyGrowthBackfill(db.pool, ok(prep([fact(S1, "RENTAL_SETTLEMENT", "999")])), db.port), (e) => e instanceof LegacyGrowthConflictError);
  assert.equal(db.log.filter((s) => s === "INSERT").length, n);
  const other = fakeDb();
  await runLegacyGrowthBackfill(other.pool, ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000")], { pkg: "e".repeat(64), receipt: receiptFor([S1, S2], ["r2"]) })), other.port);
  await assert.rejects(() => runLegacyGrowthBackfill(other.pool, ok(prep([fact(S2, "RENTAL_SETTLEMENT", "7"), fact(S1, "RENTAL_SETTLEMENT", "999")])), other.port), (e) => e instanceof LegacyGrowthConflictError);
  assert.equal(other.table.size, 1); assert.equal(other.records.size, 1); assert.equal(other.log.at(-1), "ROLLBACK");
});

test("failure mid-write (contribution or coverage) is NOT_COMMITTED with no success record; COMMIT failure is COMMIT_UNKNOWN keeping fingerprint/receipt", async () => {
  const p = ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000"), fact(S2, "RENTAL_SETTLEMENT", "3")]));
  for (const o of [{ failInsertAt: 2 }, { failPersist: true }]) {
    const db = fakeDb(o);
    await assert.rejects(() => runLegacyGrowthBackfill(db.pool, p, db.port), (e: any) => e instanceof LegacyGrowthOutcomeError && e.outcome === "NOT_COMMITTED" && e.rollbackAcknowledged);
    assert.deepEqual([db.table.size, db.records.size], [0, 0]);
    assert.equal((await recoverLegacyGrowthBackfill(db.client, p, db.port)).status, "NOT_FOUND");
  }
  const cu = fakeDb({ failCommit: true });
  await assert.rejects(() => runLegacyGrowthBackfill(cu.pool, p, cu.port), (e: any) => e instanceof LegacyGrowthOutcomeError && e.outcome === "COMMIT_UNKNOWN" && e.fingerprint === p.fingerprint && e.receiptDigest === p.record.receiptDigest);
  assert.deepEqual(await recoverLegacyGrowthBackfill(cu.client, p, cu.port), { status: "FOUND", found: 2, missing: 0, mismatched: 0 });
});

test("recovery: pre-existing matching rows without the original record are NOT_FOUND, never FOUND", async () => {
  const p = ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000")]));
  const db = fakeDb();
  await db.client.query("BEGIN");
  await writePreparedLegacyGrowth(db.client, ok(prep([fact(S1, "RENTAL_SETTLEMENT", "1000")], { pkg: "9".repeat(64), receipt: receiptFor([S1, S2], ["older"]) })), db.port);
  await db.client.query("COMMIT");
  const r = await recoverLegacyGrowthBackfill(db.client, p, db.port);
  assert.deepEqual([r.status, r.found], ["NOT_FOUND", 1]);
});

test("end-to-end with T closeLegacyGrowthCoverage: out-of-cutoff facts not written; receipt bound", () => {
  const proj = (sk: string, facts: SettledContributionFact[]): LegacyGrowthProjection => ({ sourceKey: sk, orderId: "o" + sk.slice(-3), knowledge: "KNOWN", reason: null, facts, evidence: { parentSourceDigest: "e".repeat(64), basisDigest: null, basisRef: null, componentDigest: null }, observedResourceChargeCents: null });
  const receipt = receiptFor([S1, S2]);
  const closed = closeLegacyGrowthCoverage(U, [proj(S1, [fact(S1, "RENTAL_SETTLEMENT", "10")]), proj(S2, [fact(S2, "RENTAL_SETTLEMENT", "20", "2026-09-13T13:31:22.000001Z")])], receipt, new Set([sha(canonicalize(receipt))]));
  assert.equal(closed.state, "COMPLETE");
  const p = ok(prepareLegacyGrowthBackfill({ coverage: closed as LegacyCoverageResult, gameIdBySettlementId: games, packageDigest: PKG, receipt }));
  assert.deepEqual([p.rows.length, p.skippedOutOfScope, p.record.receiptDigest], [1, 1, sha(canonicalize(receipt))]);
});

test("reader seam: record valid+complete -> COMPLETE for migrated subject; missing/tampered/extra/missing rows stay pending or conflict", async () => {
  const p = ok(prep([fact(S1, "RENTAL_SETTLEMENT", "10")]));
  const rows = p.rows.map((r) => ({ sourceKey: r.contribution.sourceKey, revision: r.contribution.revision, sourceDigest: r.sourceDigest, status: "SETTLED" }));
  assert.equal(assessLegacyCoverageRecord(p.record, rows).state, "COMPLETE");
  assert.equal(assessLegacyCoverageRecord(null, rows).state, "BACKFILL_PENDING");
  assert.equal(assessLegacyCoverageRecord({ ...p.record, receiptCanonical: p.record.receiptCanonical.replace(CUTOFF, "2026-09-14T00:00:00.000000Z") }, rows).state, "SOURCE_CONFLICT");
  assert.equal(assessLegacyCoverageRecord(p.record, []).state, "BACKFILL_PENDING");
  assert.equal(assessLegacyCoverageRecord(p.record, [...rows, { sourceKey: "RENTAL_SETTLEMENT:" + S2, revision: 1, sourceDigest: "1".repeat(64), status: "SETTLED" }]).state, "SOURCE_CONFLICT");
  const row = { sourceKey: rows[0]!.sourceKey, status: "SETTLED", eligible: true, userId: U, settlementVersion: "v", sourceType: "RENTAL_SETTLEMENT", sourceId: S1, amountCents: "10", revision: 1, effectiveAt: "2026-01-02T03:04:05.123456Z", recordedAt: "2026-01-02T03:04:05.123456Z", gameId: "game-a", sourceDigest: rows[0]!.sourceDigest } as any;
  const mk = (migrated: boolean) => ({ async query(sql: string) { if (sql.includes("settlement_posting")) return { rows: [], rowCount: 0 }; return { rows: [{ migrated }], rowCount: 1 }; } }) as any;
  assert.equal((await readGrowthSourceCompleteness(mk(true), U, [row], null, assessLegacyCoverageRecord(p.record, rows))).state, "COMPLETE");
  const pend = await readGrowthSourceCompleteness(mk(true), U, [row], null, assessLegacyCoverageRecord(null, rows));
  assert.deepEqual([pend.state, pend.reasons!.includes("LEGACY_COVERAGE_RECEIPT_MISSING")], ["BACKFILL_PENDING", true]);
  const legacyDefault = await readGrowthSourceCompleteness(mk(true), U, [row], null);
  assert.deepEqual([legacyDefault.state, legacyDefault.reasons!.includes("LEGACY_COVERAGE_RECEIPT_NOT_PERSISTED")], ["BACKFILL_PENDING", true]);
  assert.equal((await readGrowthSourceCompleteness(mk(false), U, [row], "registration:v1")).state, "SOURCE_CONFLICT");
});
