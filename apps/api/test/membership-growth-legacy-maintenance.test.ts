import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { canonicalize } from "../src/supply/content-hash";
import { sha256Hex } from "../src/supply/supply-util";
import { withReadOnlyTransaction } from "../src/credit/credit-initialization";
import { prepareLegacyGrowthBackfill, type LegacyCoveragePort, type LegacyCoverageRecord } from "../src/auth/membership-growth-legacy";
import {
  LEGACY_GROWTH_MAINTENANCE_OPERATION, prepareLegacyGrowthMaintenanceInput, legacyGrowthMaintenanceFingerprint,
  previewLegacyGrowthMaintenance, applyLegacyGrowthMaintenance, readLegacyGrowthMaintenanceReceipt,
  type LegacyGrowthMaintenanceContext, type LegacyGrowthMaintenanceInput, type LegacyGrowthMaintenancePackage,
} from "../src/auth/membership-growth-legacy-maintenance";
import type { LegacyGrowthConsumptionInput, LegacyGrowthCoverageReceipt } from "../src/order/legacy-growth-consumption";
import { legacyBinding } from "./legacy-continuation-fixture";

// Synthetic original T sources only. These clients exercise real functions; they are not PG/ACL/lock evidence.
const SUBJECT = legacyBinding.renterUserId;
const CUTOFF = "2026-10-18T00:00:00.000000Z";
const proof = (value: unknown) => { const canonical = canonicalize(value); return { canonical, digest: sha256Hex(canonical) }; };
function order(id: string): { input: LegacyGrowthConsumptionInput; componentDigest: string } {
  const completedAt = "2026-10-01T01:02:03.000000Z", raw = { id, user_id: "11", sale_user_id: "22", accounts_id: "33", order_status: "4", pay_is: "1", pay_money: "100.00", return_order_money: "87.00", confirm_time: String(Date.parse(completedAt) / 1000) };
  const parent = sha256Hex(canonicalize(raw)), sourceRecord = proof({ ...raw, detain_money: "5.00" });
  const components = proof({ schema: "legacy-consumption-components.v1", parentSourceDigest: parent, basisDigest: sourceRecord.digest, legacyOrderId: id, oldRuleEvidenceRef: "SYNTHETIC_ORIGINAL_COMPONENTS", rentalCents: "1000", materialCents: "200", minimumBillingCents: "100", minimumAgreementRef: "SYNTHETIC_AGREEMENT" });
  const input: LegacyGrowthConsumptionInput = { binding: { ...legacyBinding, id: "legacy_order_" + sha256Hex(JSON.stringify(["legacy_mysql_restore", "la_order", id])).slice(0, 40), legacyId: id, sourceDigest: parent, sourceOrderStatus: 4, completedAt }, subjectUserId: SUBJECT, recordedAt: "2026-10-17T02:00:00.000000Z", origin: { kind: "LEGACY_COMPLETED", parentSourceSnapshot: raw, sourceRecord, components } };
  return { input, componentDigest: components.digest };
}
function business(ids = ["7"], expected = ids): LegacyGrowthMaintenancePackage {
  const sources = ids.map(order), expectedSourceKeys = expected.map((id) => `legacy_mysql_restore:la_order:${id}`);
  const receipt: LegacyGrowthCoverageReceipt = { subjectUserId: SUBJECT, cutoff: CUTOFF, fromExclusive: null, sourceExtractSha256: "b".repeat(64), sourceSetSha256: sha256Hex(canonicalize({ subjectUserId: SUBJECT, cutoff: CUTOFF, fromExclusive: null, expectedSourceKeys: [...expectedSourceKeys].sort() })), expectedSourceKeys, refundReviewEvidenceRefs: ["SYNTHETIC_COMPLETE_REFUND_REVIEW"] };
  return { schema: "legacy-growth-maintenance-package-v1", reason: "Synthetic admitted historical consumption", source: { receipt, inputs: sources.map((s) => s.input), corrections: [], admitted: { receiptDigests: [sha256Hex(canonicalize(receipt))], componentDigests: sources.map((s) => s.componentDigest), correctionDigests: [] }, gameIdBySettlementId: Object.fromEntries(expectedSourceKeys.map((key) => [key, legacyBinding.gameId])) } };
}
const context = (executionKey = "growth-execution-0001"): LegacyGrowthMaintenanceContext => ({ executionKey, requestId: "synthetic-request", execution: { actorAdminId: "boss-fixture", actorSessionId: "session-fixture", approvalRef: "approval-fixture", attempt: 1, approvalDigest: "c".repeat(64), windowStartUtc: "2026-10-17T00:00:00.000Z", windowEndUtc: "2026-10-18T00:00:00.000Z", resource: { databaseName: "synthetic_growth", databaseOid: "123", owner: "database_owner", runtimeRole: "maintenance_writer", markerKey: "synthetic-marker", markerTarget: "synthetic-growth", markerVersion: 1 } } });
function input(value = business(), key = "growth-execution-0001"): LegacyGrowthMaintenanceInput {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  return prepareLegacyGrowthMaintenanceInput(bytes, sha256Hex(bytes), context(key));
}
type Idempotency = { requestFingerprint: string; responseStatus: number; responseBody: unknown; publishRequired: boolean };
type State = { contributions: Map<string, string>; coverage: Map<string, LegacyCoverageRecord>; idempotency: Map<string, Idempotency>; audits: number };
const blank = (): State => ({ contributions: new Map(), coverage: new Map(), idempotency: new Map(), audits: 0 });
const copy = (s: State): State => ({ contributions: new Map(s.contributions), coverage: new Map([...s.coverage].map(([k, v]) => [k, structuredClone(v)])), idempotency: new Map([...s.idempotency].map(([k, v]) => [k, structuredClone(v)])), audits: s.audits });
function fixture(options: { failAudit?: boolean; failCoverage?: boolean; failContributionAt?: number; failCommit?: boolean } = {}) {
  let committed = blank(), pending: State | null = null, readOnly = false, inserts = 0;
  const sqlLog: string[] = [], portLog: string[] = [];
  const auth = { status: "ACTIVE", isBoss: true, suspended: false, locked: false, twoFactorEnabled: true, expired: false, dbNow: "2026-10-17T12:00:00.123456Z", tableOwner: "maintenance_writer", tableMissing: false };
  const resource = { ...context().execution.resource }, state = () => pending ?? committed;
  let competingCoverageKey: string | null = null;
  const rawClient = {
    async query(sql: string, p: readonly unknown[] = []) {
      sqlLog.push(sql);
      if (sql.startsWith("BEGIN")) { pending = copy(committed); readOnly = sql.includes("READ ONLY"); return { rows: [], rowCount: 0 }; }
      if (sql === "ROLLBACK") { pending = null; readOnly = false; return { rows: [], rowCount: 0 }; }
      if (sql === "COMMIT") { if (pending) committed = pending; pending = null; readOnly = false; if (options.failCommit) throw new Error("SYNTHETIC_COMMIT_RESPONSE_LOST"); return { rows: [], rowCount: 0 }; }
      if (readOnly && (/^\s*(INSERT|UPDATE|DELETE)/.test(sql) || /FOR UPDATE/.test(sql))) throw new Error("SYNTHETIC_READ_ONLY_WRITE");
      if (sql.includes('FROM "zzsh_iam"."admin_security"')) return { rows: [{ status: auth.status, isBoss: auth.isBoss, passwordChangeRequired: false }], rowCount: 1 };
      if (sql.includes('FROM "zzsh_auth_admin"."session"')) return { rows: auth.expired && sql.includes('>clock_timestamp()') ? [] : [{ locked: auth.locked, suspended: auth.suspended, twoFactorEnabled: auth.twoFactorEnabled, pinHash: null, pinFailures: 0, expiresAt: auth.expired ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" }], rowCount: 1 };
      if (sql.includes("WITH role_permissions")) return { rows: [], rowCount: 0 };
      if (sql.includes("credit-init-window")) return { rows: [{ dbNow: auth.dbNow }], rowCount: 1 };
      if (sql.includes("credit-init-resource")) return { rows: [{ ...resource }], rowCount: 1 };
      if (sql.includes("set_config('zzsh.actor_type'")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("legacy-growth-maintenance-owner")) return { rows: auth.tableMissing ? [] : [{ currentRole: resource.runtimeRole, tableOwner: auth.tableOwner }], rowCount: auth.tableMissing ? 0 : 1 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("idempotency_record") && /^\s*SELECT/.test(sql)) { const row = state().idempotency.get(JSON.stringify([p[0], p[1]])); return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 }; }
      if (sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"')) { const key = JSON.stringify([p[0], p[1]]); assert(!state().idempotency.has(key)); state().idempotency.set(key, { requestFingerprint: String(p[2]), responseStatus: Number(p[3]), responseBody: JSON.parse(String(p[4])) as unknown, publishRequired: p[5] === true }); return { rows: [], rowCount: 1 }; }
      if (sql.includes("INSERT INTO zzsh_iam.membership_growth_contribution")) {
        if (++inserts === options.failContributionAt) throw new Error("SYNTHETIC_CONTRIBUTION_FAILURE");
        const key = JSON.stringify([p[1], p[3], Number(p[7])]); if (state().contributions.has(key)) return { rows: [], rowCount: 0 };
        state().contributions.set(key, String(p[16])); return { rows: [{ id: p[0] }], rowCount: 1 };
      }
      if (sql.includes("SELECT source_digest")) { const digest = state().contributions.get(JSON.stringify([p[0], p[1], Number(p[2])])); return { rows: digest ? [{ sourceDigest: digest }] : [], rowCount: digest ? 1 : 0 }; }
      if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (options.failAudit) throw new Error("SYNTHETIC_AUDIT_FAILURE"); state().audits++; return { rows: [], rowCount: 1 }; }
      throw new Error("UNEXPECTED_SYNTHETIC_SQL: " + sql.slice(0, 60));
    },
    release() {},
  };
  const client = rawClient as unknown as PoolClient;
  const port: LegacyCoveragePort = {
    async readByFingerprint(c, s, fp) { assert.equal(c, client); portLog.push("read-fingerprint"); return structuredClone(state().coverage.get(s + "|" + fp) ?? null); },
    async readByExecutionKey(c, s, key) { assert.equal(c, client); portLog.push("read-key"); return structuredClone([...state().coverage.values()].find((r) => r.subjectUserId === s && r.executionKey === key) ?? null); },
    async persist(c, record) {
      assert.equal(c, client); portLog.push("persist"); if (options.failCoverage) throw new Error("SYNTHETIC_COVERAGE_FAILURE");
      const old = state().coverage.get(record.subjectUserId + "|" + record.fingerprint) ?? [...state().coverage.values()].find((r) => r.subjectUserId === record.subjectUserId && r.executionKey === record.executionKey); if (old) return structuredClone(old);
      const stored = { ...structuredClone(record), executionKey: competingCoverageKey ?? record.executionKey }; state().coverage.set(stored.subjectUserId + "|" + stored.fingerprint, stored); return structuredClone(stored);
    },
  };
  async function write<T>(action: () => Promise<T>): Promise<T> { await client.query("BEGIN"); try { const value = await action(); await client.query("COMMIT"); return value; } catch (error) { if (pending) await client.query("ROLLBACK"); throw error; } }
  const pool = { async connect() { return client; } } as unknown as Parameters<typeof withReadOnlyTransaction>[0];
  return { client, port, auth, resource, sqlLog, portLog, write, read: <T>(action: () => Promise<T>) => withReadOnlyTransaction(pool, action), committed: () => committed, setCompetingKey: (key: string) => { competingCoverageKey = key; } };
}

test("factory binds original bytes and strict envelope/source/admitted shape; it never consumes caller prepared/coverage/true", () => {
  const valid = business(), text = JSON.stringify(valid), i = prepareLegacyGrowthMaintenanceInput(Buffer.from(text), sha256Hex(text), context());
  assert.equal(i.businessPackageSha256, sha256Hex(text)); assert.equal(i.reason, valid.reason); assert.equal(legacyGrowthMaintenanceFingerprint(i), i.businessFingerprint);
  assert.throws(() => prepareLegacyGrowthMaintenanceInput(text, "0".repeat(64), context()));
  assert.throws(() => prepareLegacyGrowthMaintenanceInput(Buffer.from([0xff]), "f".repeat(64), context()));
  for (const bad of [{ ...valid, prepared: true }, { ...valid, source: { ...valid.source, packageDigest: "a".repeat(64) } }, { ...valid, source: { ...valid.source, coverage: { state: "COMPLETE" } } }, { ...valid, source: { ...valid.source, admitted: { ...valid.source.admitted, approved: true } } }]) { const bytes = JSON.stringify(bad); assert.throws(() => prepareLegacyGrowthMaintenanceInput(bytes, sha256Hex(bytes), context())); }
  assert.throws(() => legacyGrowthMaintenanceFingerprint({ ...i, reason: "external override" }));
});

test("business fingerprint excludes execution key/window/approval/session/request clock, and includes original package/reason", () => {
  const i = input(), changedContext = { ...context("growth-other-key-0002"), requestId: "other-request", execution: { ...context().execution, actorSessionId: "other-session", approvalRef: "other-approval", attempt: 2, approvalDigest: "d".repeat(64), windowStartUtc: "2026-10-19T00:00:00.000Z", windowEndUtc: "2026-10-20T00:00:00.000Z" } };
  const other = prepareLegacyGrowthMaintenanceInput(i.businessPackageBytes, i.businessPackageSha256, changedContext); assert.equal(other.businessFingerprint, i.businessFingerprint);
  assert.notEqual(input({ ...business(), reason: "Another original package reason" }).businessFingerprint, i.businessFingerprint);
});

test("READ preview derives original T facts without receipt/audit/write/owner privilege or FOR UPDATE", async () => {
  const db = fixture(); db.auth.tableOwner = "another_role";
  const p = await db.read(() => previewLegacyGrowthMaintenance(db.client, input(), db.port));
  assert.equal(p.contributionCount, 3); assert.equal(p.coverageState, "COMPLETE"); assert.equal(p.existingCoverageExecutionKey, null);
  assert.equal(db.committed().idempotency.size, 0); assert.equal(db.committed().audits, 0);
  assert(!db.sqlLog.some((s) => /FOR UPDATE|legacy-growth-maintenance-owner|^\s*INSERT/.test(s)));
});

test("K1 writes same-client contribution/coverage/audit/idempotency; same-key replay returns exact original response in new window", async () => {
  const db = fixture(), i = input(); const first = await db.write(() => applyLegacyGrowthMaintenance(db.client, i, db.port));
  assert.equal(first.replayed, false); assert.equal(first.receipt.inserted, 3); assert.equal(first.receipt.replayed, 0); assert.equal(first.receipt.coverageExecutionKey, i.executionKey);
  assert(db.sqlLog.some((s) => s.includes("set_config('zzsh.actor_type'")), "fresh writes bind actor/session/request on that client");
  assert.equal(db.committed().contributions.size, 3); assert.equal(db.committed().coverage.size, 1); assert.equal(db.committed().idempotency.size, 1); assert.equal(db.committed().audits, 1);
  const calls = db.portLog.length, fresh = prepareLegacyGrowthMaintenanceInput(i.businessPackageBytes, i.businessPackageSha256, { ...context(), execution: { ...context().execution, approvalRef: "another-window", attempt: 2 } });
  const replay = await db.write(() => applyLegacyGrowthMaintenance(db.client, fresh, db.port));
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt); assert.equal(db.portLog.length, calls); assert.equal(db.committed().audits, 1);
  const firstReceiptRead = db.sqlLog.findIndex((s) => s.includes("idempotency_record")); const firstAuth = db.sqlLog.findIndex((s) => s.includes('FROM "zzsh_iam"."admin_security"')); assert(firstAuth >= 0 && firstAuth < firstReceiptRead);
  const recovered = await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, fresh, db.port)); assert.equal(recovered.state, "FOUND"); if (recovered.state === "FOUND") assert.deepEqual(recovered.receipt, first.receipt);
});

test("K2 same B fingerprint has its own exact receipt/alias, exact recovery, changed-body409; absent K3 is not K1 success", async () => {
  const db = fixture(), one = input(), two = input(business(), "growth-execution-0002");
  const a = await db.write(() => applyLegacyGrowthMaintenance(db.client, one, db.port)), b = await db.write(() => applyLegacyGrowthMaintenance(db.client, two, db.port));
  assert.equal(b.receipt.coverageFingerprint, a.receipt.coverageFingerprint); assert.equal(b.receipt.coverageExecutionKey, one.executionKey); assert.equal(b.receipt.executionKey, two.executionKey);
  assert.equal(b.receipt.inserted, 0); assert.equal(db.committed().coverage.size, 1); assert.equal(db.committed().idempotency.size, 2);
  const r = await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, two, db.port)); assert.equal(r.state, "FOUND"); if (r.state === "FOUND") assert.deepEqual(r.receipt, b.receipt);
  const changed = input({ ...business(), reason: "Changed package body" }, two.executionKey);
  await assert.rejects(() => db.write(() => applyLegacyGrowthMaintenance(db.client, changed, db.port)), (e: unknown) => typeof e === "object" && e !== null && "status" in e && e.status === 409);
  assert.equal((await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, changed, db.port))).state, "FINGERPRINT_MISMATCH");
  const foreign = business(); foreign.source.receipt.subjectUserId = "foreign-fixture-subject"; const foreignInput = input(foreign, two.executionKey);
  await assert.rejects(() => db.write(() => applyLegacyGrowthMaintenance(db.client, foreignInput, db.port)), (e: unknown) => typeof e === "object" && e !== null && "status" in e && e.status === 409);
  assert.equal((await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, foreignInput, db.port))).state, "FINGERPRINT_MISMATCH");
  const before = db.portLog.length, missing = await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, input(business(), "growth-execution-0003"), db.port)); assert.equal(missing.state, "NOT_FOUND"); assert.equal(db.portLog.length, before);
});

test("legal zero-source K1/K2 alias is recoverable, but another key without a success receipt is NOT_FOUND", async () => {
  const db = fixture(), zero = business([]), one = input(zero), two = input(zero, "growth-zero-key-0002");
  const a = await db.write(() => applyLegacyGrowthMaintenance(db.client, one, db.port)), b = await db.write(() => applyLegacyGrowthMaintenance(db.client, two, db.port));
  assert.equal(a.receipt.inserted, 0); assert.equal(b.receipt.coverageExecutionKey, one.executionKey); assert.equal(db.committed().contributions.size, 0);
  assert.equal((await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, two, db.port))).state, "FOUND");
  assert.equal((await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, input(zero, "growth-zero-key-0003"), db.port))).state, "NOT_FOUND");
});

test("same original receipt partial -> new business package COMPLETE appends coverage and preserves partial response", async () => {
  const db = fixture(), partial = input(business(["7"], ["7", "8"])), complete = input(business(["7", "8"]), "growth-complete-key-0002");
  const a = await db.write(() => applyLegacyGrowthMaintenance(db.client, partial, db.port)), b = await db.write(() => applyLegacyGrowthMaintenance(db.client, complete, db.port));
  assert.equal(a.receipt.sourceReceiptDigest, b.receipt.sourceReceiptDigest); assert.equal(a.receipt.coverageState, "BACKFILL_PENDING"); assert.equal(b.receipt.coverageState, "COMPLETE");
  assert.equal(b.receipt.inserted, 3); assert.equal(b.receipt.replayed, 3); assert.equal(db.committed().coverage.size, 2);
  const old = await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, partial, db.port)); assert.equal(old.state, "FOUND"); if (old.state === "FOUND") assert.deepEqual(old.receipt, a.receipt);
});

test("persist unique-winner port seam binds the actual canonical key read after persist, not requested/writer result key", async () => {
  const db = fixture(), i = input(), source = JSON.parse(i.businessPackageBytes) as LegacyGrowthMaintenancePackage, prepared = prepareLegacyGrowthBackfill({ ...source.source, packageDigest: i.businessPackageSha256 }); assert(prepared.ok);
  for (const r of prepared.rows) db.committed().contributions.set(JSON.stringify([r.contribution.userId, r.contribution.sourceKey, r.contribution.revision]), r.sourceDigest);
  db.setCompetingKey("growth-other-winner-0009");
  const result = await db.write(() => applyLegacyGrowthMaintenance(db.client, i, db.port)); assert.equal(result.receipt.coverageExecutionKey, "growth-other-winner-0009"); assert.equal(result.receipt.inserted, 0);
  const recovered = await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, i, db.port)); assert.equal(recovered.state, "FOUND");
  // Synthetic port interleaving only. Real PG unique constraints/waits require Q's separate database window.
});

test("current frozen/revoked/suspended/locked operator blocks fresh, replay and recovery before any exact-key receipt read", async () => {
  for (const change of [(d: ReturnType<typeof fixture>) => { d.auth.status = "FROZEN"; }, (d: ReturnType<typeof fixture>) => { d.auth.isBoss = false; }, (d: ReturnType<typeof fixture>) => { d.auth.suspended = true; }, (d: ReturnType<typeof fixture>) => { d.auth.locked = true; }, (d: ReturnType<typeof fixture>) => { d.auth.expired = true; }]) {
    const db = fixture(), i = input(); await db.write(() => applyLegacyGrowthMaintenance(db.client, i, db.port)); change(db); const start = db.sqlLog.length;
    await assert.rejects(() => db.write(() => applyLegacyGrowthMaintenance(db.client, i, db.port)));
    await assert.rejects(() => db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, i, db.port)));
    assert(!db.sqlLog.slice(start).some((s) => s.includes("idempotency_record"))); assert.equal(db.committed().audits, 1);
  }
});

test("APPLY requires the actual coverage table owner (not database owner), and resource/window errors fail closed", async () => {
  const good = fixture(); assert.notEqual(good.resource.runtimeRole, good.resource.owner); await good.write(() => applyLegacyGrowthMaintenance(good.client, input(), good.port));
  for (const change of [(d: ReturnType<typeof fixture>) => { d.auth.tableOwner = "different_table_owner"; }, (d: ReturnType<typeof fixture>) => { d.auth.tableMissing = true; }, (d: ReturnType<typeof fixture>) => { d.resource.databaseOid = "wrong"; }, (d: ReturnType<typeof fixture>) => { d.auth.dbNow = "2026-10-18T00:00:00.000000Z"; }]) {
    const db = fixture(); change(db); await assert.rejects(() => db.write(() => applyLegacyGrowthMaintenance(db.client, input(), db.port))); assert.equal(db.committed().idempotency.size, 0); assert.equal(db.committed().contributions.size, 0);
  }
});

test("missing/changed coverage facts or malformed original receipt are UNKNOWN, never another-key FOUND/empty success", async () => {
  const db = fixture(), i = input(); await db.write(() => applyLegacyGrowthMaintenance(db.client, i, db.port));
  const first = db.committed().contributions.keys().next().value as string; const digest = db.committed().contributions.get(first)!; db.committed().contributions.delete(first);
  assert.equal((await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, i, db.port))).state, "UNKNOWN"); db.committed().contributions.set(first, digest);
  const original = [...db.committed().idempotency.values()][0]!; original.responseBody = { invalid: true };
  assert.equal((await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, i, db.port))).state, "UNKNOWN");
});

test("coverage database errors propagate after the current-key receipt; they never become NOT_FOUND", async () => {
  const db = fixture(), i = input(); await db.write(() => applyLegacyGrowthMaintenance(db.client, i, db.port));
  const failed: LegacyCoveragePort = { ...db.port, async readByFingerprint() { throw new Error("SYNTHETIC_DATABASE_UNAVAILABLE"); } };
  await assert.rejects(() => db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, i, failed)), /SYNTHETIC_DATABASE_UNAVAILABLE/);
});

test("contribution/coverage/audit failure rolls back all success evidence in the caller's transaction", async () => {
  for (const options of [{ failContributionAt: 2 }, { failCoverage: true }, { failAudit: true }]) { const db = fixture(options); await assert.rejects(() => db.write(() => applyLegacyGrowthMaintenance(db.client, input(), db.port))); assert.equal(db.committed().contributions.size, 0); assert.equal(db.committed().coverage.size, 0); assert.equal(db.committed().idempotency.size, 0); assert.equal(db.committed().audits, 0); }
});

test("COMMIT response loss stays caller-owned UNKNOWN and exact K2 receipt/alias recovers including legal zero", async () => {
  for (const value of [business(), business([])]) {
    const options = { failCommit: false }, db = fixture(options), one = input(value), two = input(value, "growth-unknown-key-0002"); await db.write(() => applyLegacyGrowthMaintenance(db.client, one, db.port)); options.failCommit = true;
    let commitSent = false, outcome: "COMMIT_UNKNOWN" | null = null;
    await db.client.query("BEGIN"); const result = await applyLegacyGrowthMaintenance(db.client, two, db.port);
    try { commitSent = true; await db.client.query("COMMIT"); } catch { if (commitSent) outcome = "COMMIT_UNKNOWN"; }
    assert.equal(outcome, "COMMIT_UNKNOWN"); assert.equal(result.receipt.executionKey, two.executionKey); assert.equal(result.receipt.coverageExecutionKey, one.executionKey);
    const recovered = await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, two, db.port)); assert.equal(recovered.state, "FOUND"); if (recovered.state === "FOUND") assert.deepEqual(recovered.receipt, result.receipt);
    assert(!db.sqlLog.some((s) => s.includes("FAILURE"))); // The business module owns no COMMIT or outcome-to-failure conversion.
  }
});

test("business functions own no BEGIN/COMMIT/client switch, wrong actor cannot read another scope's key", async () => {
  const db = fixture(), i = input(); await db.client.query("BEGIN"); const start = db.sqlLog.length; await applyLegacyGrowthMaintenance(db.client, i, db.port); assert(!db.sqlLog.slice(start).some((s) => /^(BEGIN|COMMIT|ROLLBACK)/.test(s))); await db.client.query("COMMIT");
  const other = prepareLegacyGrowthMaintenanceInput(i.businessPackageBytes, i.businessPackageSha256, { ...context(), execution: { ...context().execution, actorAdminId: "another-authorized-boss" } });
  assert.equal((await db.read(() => readLegacyGrowthMaintenanceReceipt(db.client, other, db.port))).state, "NOT_FOUND");
  assert.equal(LEGACY_GROWTH_MAINTENANCE_OPERATION, "membership.growth.legacy.backfill");
});
