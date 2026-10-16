import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prepareLegacyGrowthBackfill, runLegacyGrowthBackfill, recoverLegacyGrowthBackfill, writePreparedLegacyGrowth, assessLegacyCoverageRecord, verifyLegacyCoverageRecord,
  LegacyGrowthConflictError, LegacyGrowthOutcomeError, type LegacyCoverageRecord, type LegacyCoveragePort, type LegacyGrowthSourcePackage, type LegacyCorrectionSource,
} from "../src/auth/membership-growth-legacy";
import { projectLegacyGrowthConsumption, type LegacyGrowthConsumptionInput, type LegacyGrowthCoverageReceipt } from "../src/order/legacy-growth-consumption";
import { canonicalize } from "../src/supply/content-hash";
import { sha256Hex as sha } from "../src/supply/supply-util";
import { legacyBinding } from "./legacy-continuation-fixture";

// FIXTURE ONLY: synthetic la_order rows built through the REAL T projection (peer-b recipe). No DB, no real rows.
const proof = (x: unknown) => { const canonical = canonicalize(x); return { canonical, digest: sha(canonical) }; };
const SUBJECT = legacyBinding.renterUserId, CUTOFF = "2026-10-18T00:00:00.000000Z", IN_RANGE = "2026-10-01T01:02:03.000000Z";
const key = (id: string) => `legacy_mysql_restore:la_order:${id}`;
type Src = { input: LegacyGrowthConsumptionInput; componentDigest: string };
function order(id: string, completedAt = IN_RANGE, recordedAt = "2026-10-17T02:00:00.000000Z"): Src {
  const raw = { id, user_id: "11", sale_user_id: "22", accounts_id: "33", order_status: "4", pay_is: "1", pay_money: "100.00", return_order_money: "87.00", confirm_time: String(Date.parse(completedAt) / 1000) };
  const parent = sha(canonicalize(raw)), sourceRecord = proof({ ...raw, detain_money: "5.00" });
  const components = proof({ schema: "legacy-consumption-components.v1", parentSourceDigest: parent, basisDigest: sourceRecord.digest, legacyOrderId: id, oldRuleEvidenceRef: "SYNTHETIC_ORIGINAL_COMPONENTS", rentalCents: "1000", materialCents: "200", minimumBillingCents: "100", minimumAgreementRef: "SYNTHETIC_AGREEMENT" });
  const binding = { ...legacyBinding, id: "legacy_order_" + sha(JSON.stringify(["legacy_mysql_restore", "la_order", id])).slice(0, 40), legacyId: id, sourceDigest: parent, sourceOrderStatus: 4, completedAt } as any;
  return { input: { binding, subjectUserId: SUBJECT, recordedAt, origin: { kind: "LEGACY_COMPLETED", parentSourceSnapshot: raw, sourceRecord, components } } as any, componentDigest: components.digest };
}
function correctionFor(src: Src, corrected = "800", recordedAt = "2026-10-17T03:00:00.000000Z"): LegacyCorrectionSource {
  const p = projectLegacyGrowthConsumption(src.input, new Set([src.componentDigest]));
  const base = p.facts[0]!, baseSourceKey = `${base.component}:${base.settlementId}`;
  return { baseSourceKey, proof: proof({ schema: "legacy-growth-correction.v1", originalSourceKey: baseSourceKey, userId: SUBJECT, originalEffectiveAt: base.effectiveAt, previousAmountCents: base.amountCents, correctedAmountCents: corrected, classification: "EFFECTIVE_PRICE_CORRECTION", alreadyReflectedInGrossReturn: false, sourceSystem: "legacy_mysql_restore", sourceEntity: "fixture_price_correction", sourceId: "93", recordedAt, revision: 2 }) };
}
function receiptFor(expected: string[], refs: string[]): LegacyGrowthCoverageReceipt {
  return { subjectUserId: SUBJECT, cutoff: CUTOFF, fromExclusive: null, sourceExtractSha256: "b".repeat(64), sourceSetSha256: sha(canonicalize({ subjectUserId: SUBJECT, cutoff: CUTOFF, fromExclusive: null, expectedSourceKeys: [...expected].sort() })), expectedSourceKeys: expected, refundReviewEvidenceRefs: refs };
}
function pkg(o: { expected: string[]; srcs: Src[]; corrections?: LegacyCorrectionSource[]; refs?: string[]; admitCorrections?: string[]; pkgDigest?: string; receipt?: LegacyGrowthCoverageReceipt }): LegacyGrowthSourcePackage {
  const corrections = o.corrections ?? [];
  const receipt = o.receipt ?? receiptFor(o.expected, o.refs ?? (corrections.length ? corrections.map((c) => "SYNTHETIC_ADMITTED_CORRECTION:" + c.proof.digest) : ["SYNTHETIC_REFUND_REVIEW_NONE"]));
  return { receipt, inputs: o.srcs.map((s) => s.input), corrections, admitted: { receiptDigests: [sha(canonicalize(receipt))], componentDigests: o.srcs.map((s) => s.componentDigest), correctionDigests: o.admitCorrections ?? corrections.map((c) => c.proof.digest) }, gameIdBySettlementId: Object.fromEntries(o.expected.map((k) => [k, "game-fixture"])), packageDigest: o.pkgDigest ?? "a".repeat(64) };
}

type Row = { digest: string };
function fakeDb(opts: { failCommit?: boolean; failInsertAt?: number; failPersist?: boolean } = {}) {
  const table = new Map<string, Row>(), byFp = new Map<string, LegacyCoverageRecord>(), byKey = new Map<string, LegacyCoverageRecord>();
  let pRows = new Map<string, Row>(), pRec: LegacyCoverageRecord[] = []; let inserts = 0;
  const flush = () => { for (const [k, v] of pRows) table.set(k, v); for (const r of pRec) { byFp.set(`${r.subjectUserId}|${r.fingerprint}`, r); byKey.set(`${r.subjectUserId}|${r.executionKey}`, r); } pRows = new Map(); pRec = []; };
  const client: any = {
    async query(sql: string, p: unknown[] = []) {
      if (sql.startsWith("BEGIN")) { pRows = new Map(); pRec = []; return { rows: [], rowCount: 0 }; }
      if (sql === "COMMIT") { flush(); if (opts.failCommit) throw new Error("connection lost during COMMIT"); return { rows: [], rowCount: 0 }; }
      if (sql === "ROLLBACK") { pRows = new Map(); pRec = []; return { rows: [], rowCount: 0 }; }
      if (sql.includes("INSERT INTO zzsh_iam.membership_growth_contribution")) {
        inserts += 1; if (opts.failInsertAt === inserts) throw new Error("statement failed");
        const k = `${p[1]}|${p[3]}|${p[7]}`; if (table.has(k) || pRows.has(k)) return { rows: [], rowCount: 0 };
        pRows.set(k, { digest: p[16] as string }); return { rows: [{ id: p[0] }], rowCount: 1 };
      }
      if (sql.includes("SELECT source_digest")) { const k = `${p[0]}|${p[1]}|${p[2]}`; const r = pRows.get(k) ?? table.get(k); return { rows: r ? [{ sourceDigest: r.digest }] : [], rowCount: r ? 1 : 0 }; }
      throw new Error("unexpected sql " + sql);
    },
    release() {},
  };
  const find = (m: Map<string, LegacyCoverageRecord>, k: string, f: (r: LegacyCoverageRecord) => string) => pRec.find((r) => `${r.subjectUserId}|${f(r)}` === k) ?? m.get(k) ?? null;
  const port: LegacyCoveragePort = {
    async persist(_c, record) {
      if (opts.failPersist) throw new Error("coverage insert failed");
      // unique (subject, fingerprint) and (subject, execution_key); receipt_digest NOT unique
      const prior = find(byFp, `${record.subjectUserId}|${record.fingerprint}`, (r) => r.fingerprint) ?? find(byKey, `${record.subjectUserId}|${record.executionKey}`, (r) => String(r.executionKey));
      if (prior) return prior; pRec.push(record); return record;
    },
    async readByFingerprint(_c, s, fp) { return find(byFp, `${s}|${fp}`, (r) => r.fingerprint); },
    async readByExecutionKey(_c, s, k) { return find(byKey, `${s}|${k}`, (r) => String(r.executionKey)); },
  };
  return { table, byFp, byKey, client, port, pool: { async connect() { return client; } } as any };
}
type P = ReturnType<typeof prepareLegacyGrowthBackfill>;
const ok = (p: P) => { assert.equal(p.ok, true, JSON.stringify(p)); return p as Extract<P, { ok: true }>; };
const rejected = (p: P, re: RegExp) => { assert.equal(p.ok, false, "must be rejected before any write"); assert.match((p as any).reason, re); };
const A = order("7"), B2 = order("8");

test("legal COMPLETE from original T sources, with an admitted in-snapshot refund correction; record self-verifies", async () => {
  const c = correctionFor(A);
  const p = ok(prepareLegacyGrowthBackfill(pkg({ expected: [key("7"), key("8")], srcs: [A, B2], corrections: [c] })));
  assert.equal(p.coverageState, "COMPLETE");
  assert.ok(p.rows.some((r) => r.contribution.amountCents === "800" && r.contribution.revision === 2));
  assert.equal(verifyLegacyCoverageRecord(p.record), true);
  const db = fakeDb(); const r = await runLegacyGrowthBackfill(db.pool, p, db.port, "exec-complete-0001");
  assert.equal(r.coverage, "INSERTED"); assert.equal(db.table.size, p.rows.length); assert.equal(db.byFp.size, 1);
});

test("B-GROWTH-01: deleted / foreign / out-of-range / changed-refund inputs never reach COMPLETE and are rejected before any write", () => {
  // deleted source: the receipt expects 7 and 8, the package drops 8 -> only a PENDING version, never COMPLETE
  const del = ok(prepareLegacyGrowthBackfill(pkg({ expected: [key("7"), key("8")], srcs: [A] })));
  assert.equal(del.coverageState, "BACKFILL_PENDING"); assert.deepEqual(del.record.missingSourceKeys, [key("8")]);
  // deleted component admission -> T marks UNKNOWN -> PENDING, never COMPLETE
  const noComp = pkg({ expected: [key("7")], srcs: [A] }); noComp.admitted.componentDigests = [];
  const nc = prepareLegacyGrowthBackfill(noComp); assert.ok(!nc.ok || nc.coverageState !== "COMPLETE");
  // foreign order not in the frozen receipt
  rejected(prepareLegacyGrowthBackfill(pkg({ expected: [key("7")], srcs: [A, order("9")] })), /SOURCE_COVERAGE_CONFLICT/);
  // foreign subject
  const foreign = order("10"); (foreign.input as any).subjectUserId = "someone_else";
  rejected(prepareLegacyGrowthBackfill(pkg({ expected: [key("7"), key("10")], srcs: [A, foreign] })), /FACT_SUBJECT_MISMATCH/);
  // post-cutoff fact
  rejected(prepareLegacyGrowthBackfill(pkg({ expected: [key("11")], srcs: [order("11", "2026-10-19T00:00:00.000000Z", "2026-10-20T00:00:00.000000Z")] })), /FACT_OUTSIDE_SOURCE_RANGE/);
  // refund: keep the original digest but change the amount
  const c = correctionFor(A), tampered = { ...c, proof: { canonical: c.proof.canonical.replace('"correctedAmountCents":"800"', '"correctedAmountCents":"999999"'), digest: c.proof.digest } };
  assert.notEqual(tampered.proof.canonical, c.proof.canonical);
  rejected(prepareLegacyGrowthBackfill(pkg({ expected: [key("7")], srcs: [A], corrections: [tampered], refs: ["SYNTHETIC_ADMITTED_CORRECTION:" + c.proof.digest] })), /./);
  // refund: a fresh proof for the changed amount is not in the receipt's refund lineage
  const other = correctionFor(A, "999999");
  rejected(prepareLegacyGrowthBackfill(pkg({ expected: [key("7")], srcs: [A], corrections: [other], refs: ["SYNTHETIC_ADMITTED_CORRECTION:" + c.proof.digest], admitCorrections: [other.proof.digest] })), /CORRECTION_NOT_IN_RECEIPT_LINEAGE/);
  // refund recorded after the snapshot cutoff (retroactive effectiveAt does not make it old-snapshot)
  const late = correctionFor(A, "800", "2026-10-19T00:00:00.000000Z");
  rejected(prepareLegacyGrowthBackfill(pkg({ expected: [key("7")], srcs: [A], corrections: [late] })), /CORRECTION_AFTER_SOURCE_CUTOFF/);
  // duplicate input and non-admitted receipt
  rejected(prepareLegacyGrowthBackfill(pkg({ expected: [key("7")], srcs: [A, A] })), /DUPLICATE_SOURCE_INPUT|SOURCE_COVERAGE_CONFLICT/);
  const na = pkg({ expected: [key("7")], srcs: [A] }); na.admitted.receiptDigests = ["0".repeat(64)];
  rejected(prepareLegacyGrowthBackfill(na), /SOURCE_COVERAGE_NOT_ADMITTED/);
  rejected(prepareLegacyGrowthBackfill({ ...pkg({ expected: [key("7")], srcs: [A] }), receipt: null as any }), /RECEIPT_MISSING/);
});

test("receipt-backed zero-source closure is COMPLETE with no rows", async () => {
  const p = ok(prepareLegacyGrowthBackfill(pkg({ expected: [], srcs: [] })));
  assert.equal(p.coverageState, "COMPLETE"); assert.equal(p.rows.length, 0);
  const db = fakeDb(); await runLegacyGrowthBackfill(db.pool, p, db.port, "exec-zero-0001");
  assert.equal((await recoverLegacyGrowthBackfill(db.client, p, db.port, "exec-zero-0001")).status, "FOUND");
  assert.equal((await recoverLegacyGrowthBackfill(db.client, p, db.port, "exec-zero-other")).status, "NOT_FOUND");
});

test("B-GROWTH-02: same-source partial -> new key + new package COMPLETE; old partial unchanged; same key replay / changed body conflict", async () => {
  const db = fakeDb(), expected = [key("7"), key("8")];
  const partial = ok(prepareLegacyGrowthBackfill(pkg({ expected, srcs: [A], pkgDigest: "1".repeat(64) })));
  const complete = ok(prepareLegacyGrowthBackfill(pkg({ expected, srcs: [A, B2], pkgDigest: "2".repeat(64) })));
  assert.equal(partial.record.receiptDigest, complete.record.receiptDigest, "same source receipt");
  assert.notEqual(partial.fingerprint, complete.fingerprint);
  await runLegacyGrowthBackfill(db.pool, partial, db.port, "exec-partial-0001");
  const snapshot = JSON.stringify(db.byKey.get(`${SUBJECT}|exec-partial-0001`));
  const r = await runLegacyGrowthBackfill(db.pool, complete, db.port, "exec-complete-0002");
  assert.equal(r.coverage, "INSERTED"); assert.ok(r.replayed > 0, "partial rows replayed, not rewritten");
  assert.equal(JSON.stringify(db.byKey.get(`${SUBJECT}|exec-partial-0001`)), snapshot);
  assert.equal(db.byFp.size, 2);
  const again = await runLegacyGrowthBackfill(db.pool, complete, db.port, "exec-complete-0002");
  assert.equal(again.coverage, "REPLAYED"); assert.equal(again.fingerprint, complete.fingerprint);
  await assert.rejects(() => runLegacyGrowthBackfill(db.pool, partial, db.port, "exec-complete-0002"), LegacyGrowthConflictError);
  assert.equal((await recoverLegacyGrowthBackfill(db.client, partial, db.port, "exec-partial-0001")).status, "FOUND");
  assert.equal((await recoverLegacyGrowthBackfill(db.client, complete, db.port, "exec-complete-0002")).status, "FOUND");
  assert.equal((await recoverLegacyGrowthBackfill(db.client, complete, db.port, "exec-partial-0001")).status, "FINGERPRINT_MISMATCH");
});

test("partial rows preexisting without their original record: recovery is NOT_FOUND, then the write replays rows and stores the record", async () => {
  const db = fakeDb(), p = ok(prepareLegacyGrowthBackfill(pkg({ expected: [key("7")], srcs: [A] })));
  for (const r of p.rows) db.table.set(`${r.contribution.userId}|${r.contribution.sourceKey}|${r.contribution.revision}`, { digest: r.sourceDigest });
  assert.equal((await recoverLegacyGrowthBackfill(db.client, p, db.port, "exec-pre-0001")).status, "NOT_FOUND");
  const w = await runLegacyGrowthBackfill(db.pool, p, db.port, "exec-pre-0001");
  assert.equal(w.inserted, 0); assert.equal(w.replayed, p.rows.length);
  assert.equal((await recoverLegacyGrowthBackfill(db.client, p, db.port, "exec-pre-0001")).status, "FOUND");
});

test("mid-transaction failure leaves no success record; COMMIT_UNKNOWN recovers exactly by execution key", async () => {
  const p = ok(prepareLegacyGrowthBackfill(pkg({ expected: [key("7"), key("8")], srcs: [A, B2] })));
  for (const o of [{ failInsertAt: 2 }, { failPersist: true }]) {
    const db = fakeDb(o);
    await assert.rejects(() => runLegacyGrowthBackfill(db.pool, p, db.port, "exec-fail-0001"), (e: any) => e instanceof LegacyGrowthOutcomeError && e.outcome === "NOT_COMMITTED");
    assert.equal(db.table.size, 0); assert.equal(db.byFp.size, 0);
  }
  const db = fakeDb({ failCommit: true });
  await assert.rejects(() => runLegacyGrowthBackfill(db.pool, p, db.port, "exec-unknown-0001"), (e: any) => e instanceof LegacyGrowthOutcomeError && e.outcome === "COMMIT_UNKNOWN");
  assert.equal((await recoverLegacyGrowthBackfill(db.client, p, db.port, "exec-unknown-0001")).status, "FOUND");
  assert.notEqual((await recoverLegacyGrowthBackfill(db.client, p, db.port, "exec-unknown-9999")).status, "FOUND");
});

test("writePreparedLegacyGrowth runs on the caller's client (no own BEGIN/COMMIT) and rejects bad execution keys", async () => {
  const db = fakeDb(), p = ok(prepareLegacyGrowthBackfill(pkg({ expected: [key("7")], srcs: [A] })));
  const seen: string[] = []; const spy: any = { query: (s: string, a: unknown[]) => { seen.push(s.trim().split(/\s+/)[0]!); return db.client.query(s, a); } };
  await writePreparedLegacyGrowth(spy, p, db.port, "exec-same-client-0001");
  assert.ok(!seen.includes("BEGIN") && !seen.includes("COMMIT"));
  await assert.rejects(() => writePreparedLegacyGrowth(spy, p, db.port, "bad"), LegacyGrowthConflictError);
});

test("H3 reader: record proves only its factKeys; increments (later continuation / retroactive correction) stay unverified, tampering conflicts", () => {
  const p = ok(prepareLegacyGrowthBackfill(pkg({ expected: [key("7")], srcs: [A] })));
  const stored = p.rows.map((r) => ({ sourceKey: r.contribution.sourceKey, revision: r.contribution.revision, sourceDigest: r.sourceDigest, status: "SETTLED" }));
  assert.equal(assessLegacyCoverageRecord(p.record, stored).state, "COMPLETE");
  const inc = { sourceKey: stored[0]!.sourceKey, revision: 2, sourceDigest: "e".repeat(64), status: "SETTLED" };
  const a = assessLegacyCoverageRecord(p.record, [...stored, inc]);
  assert.equal(a.state, "BACKFILL_PENDING"); assert.deepEqual(a.reasons, ["LEGACY_INCREMENTS_UNVERIFIED"]); assert.equal(a.incrementRows.length, 1);
  assert.equal(assessLegacyCoverageRecord(p.record, [...stored, inc], "VERIFIED").state, "COMPLETE");
  assert.equal(assessLegacyCoverageRecord(p.record, [{ ...stored[0]!, sourceDigest: "d".repeat(64) }, ...stored.slice(1)]).state, "SOURCE_CONFLICT");
  assert.equal(assessLegacyCoverageRecord({ ...p.record, coverageState: "COMPLETE", missingSourceKeys: [key("99")] }, stored).state, "SOURCE_CONFLICT");
  assert.equal(assessLegacyCoverageRecord(null, stored).state, "BACKFILL_PENDING");
});