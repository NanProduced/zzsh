import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { prepareLegacyGrowthBackfill, runLegacyGrowthBackfill, recoverLegacyGrowthBackfill, writePreparedLegacyGrowth, LegacyGrowthConflictError, LegacyGrowthOutcomeError, type LegacyCoverageResult } from "../src/auth/membership-growth-legacy";
import { readGrowthSourceCompleteness } from "../src/auth/membership-growth-integration";
import { closeLegacyGrowthCoverage, type LegacyGrowthProjection } from "../src/order/legacy-growth-consumption";
import { canonicalize } from "../src/supply/content-hash";
import type { SettledContributionFact } from "../src/auth/membership-growth";

// FIXTURE ONLY: synthetic ids/amounts; no real rows, no DB.
const U = "user_fixture_a", PKG = "a".repeat(64), S1 = "legacy_mysql_restore:la_order:101", S2 = "legacy_mysql_restore:la_order:102";
const games = { [S1]: "game-a", [S2]: "game-b" };
const fact = (settlementId: string, component: SettledContributionFact["component"], amount: string, effectiveAt = "2026-01-02T03:04:05.123456Z", extra: Partial<SettledContributionFact> = {}): SettledContributionFact =>
  ({ userId: U, settlementId, settlementVersion: "legacy-cutoff:" + "b".repeat(64), component, effectiveAt, recordedAt: "2026-09-13T13:31:22.000001Z", amountCents: amount, status: "SETTLED", revision: 1, ...extra });
const cov = (facts: SettledContributionFact[], state: LegacyCoverageResult["state"] = "COMPLETE", reason: string | null = null): LegacyCoverageResult =>
  ({ subjectUserId: U, state, reason, facts, outOfScopeFacts: [], missingSourceKeys: [], unknown: [] });

type Row = { digest: string; effectiveAt: string; amount: string };
function fakeDb(opts: { failCommit?: boolean; failInsertAt?: number } = {}) {
  const table = new Map<string, Row>(); let pending = new Map<string, Row>(); let inserts = 0; const log: string[] = [];
  const client = {
    async query(sql: string, p: unknown[] = []) {
      log.push(sql.trim().split(/\s+/)[0]!);
      if (sql.startsWith("BEGIN")) { pending = new Map(); return { rows: [], rowCount: 0 }; }
      if (sql === "COMMIT") { if (opts.failCommit) { for (const [k, v] of pending) table.set(k, v); throw new Error("connection lost during COMMIT"); } for (const [k, v] of pending) table.set(k, v); pending = new Map(); return { rows: [], rowCount: 0 }; }
      if (sql === "ROLLBACK") { pending = new Map(); return { rows: [], rowCount: 0 }; }
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
  return { table, client: client as any, pool: { async connect() { return client; } } as any, log };
}
const ok = (p: ReturnType<typeof prepareLegacyGrowthBackfill>) => { assert.equal(p.ok, true, JSON.stringify(p)); return p as Extract<typeof p, { ok: true }>; };

test("COMPLETE coverage writes each component once, keeps 6-digit microseconds, original replay is idempotent", async () => {
  const db = fakeDb();
  const p = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1000"), fact(S1, "MATERIAL_CONSUMPTION", "250"), fact(S2, "RENTAL_SETTLEMENT", "0")]), gameIdBySettlementId: games, packageDigest: PKG }));
  assert.equal(p.rows.length, 3);
  const first = await runLegacyGrowthBackfill(db.pool, p);
  assert.deepEqual([first.inserted, first.replayed], [3, 0]);
  assert.ok([...db.table.values()].every((r) => r.effectiveAt === "2026-01-02T03:04:05.123456Z"));
  assert.equal([...db.table.values()].map((r) => BigInt(r.amount)).reduce((a, b) => a + b, 0n), 1250n);
  const again = await runLegacyGrowthBackfill(db.pool, ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1000"), fact(S1, "MATERIAL_CONSUMPTION", "250"), fact(S2, "RENTAL_SETTLEMENT", "0")]), gameIdBySettlementId: games, packageDigest: "c".repeat(64) })));
  assert.deepEqual([again.inserted, again.replayed], [0, 3], "a later receipt replays the same source rows");
});

test("fingerprint binds package and rows; microsecond change is a different digest", () => {
  const a = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1000")]), gameIdBySettlementId: games, packageDigest: PKG }));
  const b = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1000", "2026-01-02T03:04:05.123457Z")]), gameIdBySettlementId: games, packageDigest: PKG }));
  const c = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1000")]), gameIdBySettlementId: games, packageDigest: "d".repeat(64) }));
  assert.notEqual(a.rows[0]!.sourceDigest, b.rows[0]!.sourceDigest);
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.equal(a.rows[0]!.sourceDigest, c.rows[0]!.sourceDigest);
});

test("pending/conflict coverage: SOURCE_CONFLICT and unadmitted receipt write nothing; SOURCE_FACTS_PENDING writes known facts but stays pending", () => {
  assert.deepEqual(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1")], "SOURCE_CONFLICT", "SOURCE_COVERAGE_CONFLICT"), gameIdBySettlementId: games, packageDigest: PKG }).ok, false);
  for (const reason of ["FULL_SOURCE_RECEIPT_MISSING", "SOURCE_COVERAGE_NOT_ADMITTED"]) assert.equal(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1")], "BACKFILL_PENDING", reason), gameIdBySettlementId: games, packageDigest: PKG }).ok, false);
  const p = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1")], "BACKFILL_PENDING", "SOURCE_FACTS_PENDING"), gameIdBySettlementId: games, packageDigest: PKG }));
  assert.equal(p.coverageState, "BACKFILL_PENDING");
});

test("rejects non-legacy source, missing game binding, foreign subject, non-SETTLED, and non-growth components (no deposit/commission backfill)", () => {
  const r = (f: SettledContributionFact, g: Record<string, string> = games) => prepareLegacyGrowthBackfill({ coverage: cov([f]), gameIdBySettlementId: g, packageDigest: PKG });
  assert.equal((r(fact("native:settlement:1", "RENTAL_SETTLEMENT", "1")) as any).reason, "FACT_NOT_LEGACY_SOURCE");
  assert.equal((r(fact(S1, "RENTAL_SETTLEMENT", "1"), {}) as any).reason, "GAME_BINDING_MISSING");
  assert.equal((r({ ...fact(S1, "RENTAL_SETTLEMENT", "1"), userId: "other" }) as any).code, "SOURCE_CONFLICT");
  assert.equal((r({ ...fact(S1, "RENTAL_SETTLEMENT", "1"), status: "PENDING" } as any) as any).reason, "FACT_NOT_SETTLED");
  for (const component of ["DEPOSIT", "COMMISSION", "BALANCE"]) assert.equal(r(fact(S1, component as any, "1")).ok, false);
  assert.equal(prepareLegacyGrowthBackfill({ coverage: cov([]), gameIdBySettlementId: games, packageDigest: "nope" }).ok, false);
});

test("duplicates: identical facts collapse, divergent same revision is SOURCE_CONFLICT", () => {
  const same = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "5"), fact(S1, "RENTAL_SETTLEMENT", "5")]), gameIdBySettlementId: games, packageDigest: PKG }));
  assert.equal(same.rows.length, 1);
  const div = prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "5"), fact(S1, "RENTAL_SETTLEMENT", "6")]), gameIdBySettlementId: games, packageDigest: PKG });
  assert.deepEqual([div.ok, (div as any).reason], [false, "DUPLICATE_REVISION_DIVERGES"]);
});

test("refund correction REPLACE keeps original effectiveAt and links correctionOf", async () => {
  const corr = fact("legacy_refund:la_refund:9", "REFUND_CORRECTION", "800", "2026-01-02T03:04:05.123456Z", { revision: 2, previousAmountCents: "1000", correctionOf: `RENTAL_SETTLEMENT:${S1}`, correctionMode: "REPLACE" });
  const p = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1000"), corr]), gameIdBySettlementId: games, packageDigest: PKG }));
  const c = p.rows.map((r) => r.contribution).find((x) => x.revision === 2)!;
  assert.equal(c.sourceKey, `RENTAL_SETTLEMENT:${S1}`);
  assert.equal(c.effectiveAt, "2026-01-02T03:04:05.123456Z");
  const db = fakeDb(); const res = await runLegacyGrowthBackfill(db.pool, p); assert.equal(res.inserted, 2);
});

test("existing divergent row -> conflict, rolled back, nothing committed", async () => {
  const db = fakeDb();
  await runLegacyGrowthBackfill(db.pool, ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1000")]), gameIdBySettlementId: games, packageDigest: PKG })));
  const changed = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S2, "RENTAL_SETTLEMENT", "7"), fact(S1, "RENTAL_SETTLEMENT", "999")]), gameIdBySettlementId: games, packageDigest: PKG }));
  await assert.rejects(() => runLegacyGrowthBackfill(db.pool, changed), (e) => e instanceof LegacyGrowthConflictError);
  assert.equal(db.table.size, 1, "S2 row from the failed attempt is not durable");
  assert.equal(db.log.at(-1), "ROLLBACK");
});

test("statement failure before COMMIT is NOT_COMMITTED; COMMIT failure is COMMIT_UNKNOWN and recovery reads FOUND / NOT_FOUND / mismatch", async () => {
  const p = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1000"), fact(S2, "RENTAL_SETTLEMENT", "3")]), gameIdBySettlementId: games, packageDigest: PKG }));
  const nc = fakeDb({ failInsertAt: 2 });
  await assert.rejects(() => runLegacyGrowthBackfill(nc.pool, p), (e: any) => e instanceof LegacyGrowthOutcomeError && e.outcome === "NOT_COMMITTED" && e.rollbackAcknowledged);
  assert.equal((await recoverLegacyGrowthBackfill(nc.client, p)).status, "NOT_FOUND");
  const cu = fakeDb({ failCommit: true });
  await assert.rejects(() => runLegacyGrowthBackfill(cu.pool, p), (e: any) => e instanceof LegacyGrowthOutcomeError && e.outcome === "COMMIT_UNKNOWN" && e.fingerprint === p.fingerprint);
  assert.deepEqual(await recoverLegacyGrowthBackfill(cu.client, p), { status: "FOUND", found: 2, missing: 0, mismatched: 0 });
  const other = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1001")]), gameIdBySettlementId: games, packageDigest: PKG }));
  assert.equal((await recoverLegacyGrowthBackfill(cu.client, other)).status, "FINGERPRINT_MISMATCH");
});

test("concurrent identical runs: one inserts, the other replays (ON CONFLICT serialization)", async () => {
  const db = fakeDb();
  const p = ok(prepareLegacyGrowthBackfill({ coverage: cov([fact(S1, "RENTAL_SETTLEMENT", "1000")]), gameIdBySettlementId: games, packageDigest: PKG }));
  await db.client.query("BEGIN"); const a = await writePreparedLegacyGrowth(db.client, p); const b = await writePreparedLegacyGrowth(db.client, p);
  assert.deepEqual([a.inserted, b.replayed], [1, 1]);
});

test("end-to-end with T closeLegacyGrowthCoverage: out-of-cutoff facts are not written", () => {
  const cutoff = "2026-09-13T13:31:22.000000Z";
  const proj = (sk: string, facts: SettledContributionFact[]): LegacyGrowthProjection => ({ sourceKey: sk, orderId: "o" + sk.slice(-3), knowledge: "KNOWN", reason: null, facts, evidence: { parentSourceDigest: "e".repeat(64), basisDigest: null, basisRef: null, componentDigest: null }, observedResourceChargeCents: null });
  const expected = [S1, S2];
  const receipt = { subjectUserId: U, cutoff, fromExclusive: null, sourceExtractSha256: "f".repeat(64), sourceSetSha256: createHash("sha256").update(canonicalize({ subjectUserId: U, cutoff, fromExclusive: null, expectedSourceKeys: [...expected].sort() })).digest("hex"), expectedSourceKeys: expected, refundReviewEvidenceRefs: ["fixture-review"] };
  const closed = closeLegacyGrowthCoverage(U, [proj(S1, [fact(S1, "RENTAL_SETTLEMENT", "10")]), proj(S2, [fact(S2, "RENTAL_SETTLEMENT", "20", "2026-09-13T13:31:22.000001Z")])], receipt, new Set([createHash("sha256").update(canonicalize(receipt)).digest("hex")]));
  assert.equal(closed.state, "COMPLETE");
  const p = ok(prepareLegacyGrowthBackfill({ coverage: closed as LegacyCoverageResult, gameIdBySettlementId: games, packageDigest: PKG }));
  assert.deepEqual([p.rows.length, p.skippedOutOfScope], [1, 1]);
});

test("reader: legacy rows keep migrated subject BACKFILL_PENDING (never COMPLETE); on non-migrated subject they are SOURCE_CONFLICT; unknown is not 0", async () => {
  const row = { sourceKey: `RENTAL_SETTLEMENT:${S1}`, status: "SETTLED", eligible: true, userId: U, settlementVersion: "v", sourceType: "RENTAL_SETTLEMENT", sourceId: S1, amountCents: "10", revision: 1, effectiveAt: "2026-01-02T03:04:05.123456Z", recordedAt: "2026-01-02T03:04:05.123456Z", gameId: "game-a", sourceDigest: "x".repeat(64) } as any;
  const mk = (migrated: boolean) => ({ async query(sql: string) { if (sql.includes("settlement_posting")) return { rows: [], rowCount: 0 }; return { rows: [{ migrated }], rowCount: 1 }; } }) as any;
  const m = await readGrowthSourceCompleteness(mk(true), U, [row], null);
  assert.equal(m.state, "BACKFILL_PENDING"); assert.ok(m.reasons!.includes("LEGACY_COVERAGE_RECEIPT_NOT_PERSISTED"));
  assert.equal((await readGrowthSourceCompleteness(mk(false), U, [row], "registration:v1")).state, "SOURCE_CONFLICT");
  assert.equal((await readGrowthSourceCompleteness(mk(true), U, [], null)).state, "BACKFILL_PENDING");
});
