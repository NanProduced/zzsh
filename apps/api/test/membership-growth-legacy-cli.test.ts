import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import * as configuration from "../src/config/config";
import * as database from "../src/database/business";
import * as maintenance from "../src/auth/membership-growth-legacy-maintenance";
import {
  readLegacyGrowthMaintenanceRun, runLegacyGrowthMaintenanceApply, executeLegacyGrowthMaintenanceRun,
  describeLegacyGrowthMaintenanceFailure, LegacyGrowthMaintenanceOutcomeError, main,
  type LegacyGrowthMaintenanceMode,
} from "../src/auth/membership-growth-legacy-cli";
import { canonicalize } from "../src/supply/content-hash";
import type { LegacyCoveragePort } from "../src/auth/membership-growth-legacy";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const RESOURCE = { databaseName: "zzsh_test_growth_cli", databaseOid: "40000", owner: "fixture_owner", runtimeRole: "fixture_owner", markerKey: "zzsh_business", markerTarget: "fixture", markerVersion: 1 };
const NOW = Date.parse("2026-10-20T01:00:00Z"), KEY = "legacy-growth:synthetic-cli-0001";
function businessPackage() {
  const receipt = { subjectUserId: "synthetic-subject", cutoff: "2026-10-18T00:00:00.000000Z", fromExclusive: null, sourceExtractSha256: "b".repeat(64), sourceSetSha256: digest(canonicalize({ subjectUserId: "synthetic-subject", cutoff: "2026-10-18T00:00:00.000000Z", fromExclusive: null, expectedSourceKeys: [] })), expectedSourceKeys: [], refundReviewEvidenceRefs: ["SYNTHETIC_REFUND_REVIEW_NONE"] };
  return { schema: "legacy-growth-maintenance-package-v1", reason: "Synthetic CLI approved zero-source closure", source: { receipt, inputs: [], corrections: [], admitted: { receiptDigests: [digest(canonicalize(receipt))], componentDigests: [], correctionDigests: [] }, gameIdBySettlementId: {} } };
}
function fixture(options: { mode?: LegacyGrowthMaintenanceMode; approval?: Record<string, unknown>; business?: unknown; env?: NodeJS.ProcessEnv } = {}) {
  const mode = options.mode ?? "APPLY", bytes = Buffer.from(JSON.stringify(options.business ?? businessPackage())), packageSha = digest(bytes);
  const approval = { schema: "legacy-growth-maintenance-approval-v1", status: "APPROVED", approvalRef: "ROOT-SYNTHETIC-GROWTH-001", attempt: 1, mode, businessPackageSha256: packageSha, executionKey: KEY, actor: { adminId: "synthetic-boss", sessionId: "synthetic-session" }, windowStartUtc: "2026-10-20T00:00:00Z", windowEndUtc: "2026-10-20T04:00:00Z", resource: RESOURCE, ...options.approval };
  const approvalBytes = Buffer.from(JSON.stringify(approval)), files: Record<string, Buffer> = { "business.json": bytes, "approval.json": approvalBytes };
  const env = { LEGACY_GROWTH_ENABLED: "true", LEGACY_GROWTH_PACKAGE_FILE: "business.json", LEGACY_GROWTH_PACKAGE_SHA256: packageSha, LEGACY_GROWTH_APPROVAL_FILE: "approval.json", LEGACY_GROWTH_APPROVAL_SHA256: digest(approvalBytes), LEGACY_GROWTH_MODE: mode, ...options.env };
  const read = (file: string) => { assert(files[file]); return files[file]!; };
  const run = () => readLegacyGrowthMaintenanceRun(env, read, NOW, { databaseName: RESOURCE.databaseName, databaseUser: RESOURCE.runtimeRole });
  return { bytes, packageSha, approval, env, read, run };
}
const COMMENT_RESOURCE = { databaseName: "zzsh_test_growth_cli", databaseOid: "40000", owner: "fixture_owner", runtimeRole: "fixture_owner", bindingKind: "DATABASE_COMMENT", databaseComment: "synthetic:growth-cli:v1" } as const;

test("growth v2 parser is explicit, preserves original business bytes and supports all approved modes", () => {
  for (const mode of ["PREVIEW", "APPLY", "RECOVER_READ"] as const) {
    const one = fixture({ mode }), two = fixture({ mode, approval: { schema: "legacy-growth-maintenance-approval-v2", resource: COMMENT_RESOURCE } });
    const a = one.run(), b = two.run();
    assert.equal(b.mode, mode); assert.equal(b.input.businessPackageBytes, a.input.businessPackageBytes); assert.equal(b.input.executionKey, a.input.executionKey);
    assert.equal(b.input.businessFingerprint, a.input.businessFingerprint); assert.notEqual(b.input.execution.approvalDigest, a.input.execution.approvalDigest);
  }
});

test("growth parser rejects unknown/mixed resource versions and falsey COMMENT kinds before configuration/pool", async t => {
  const invalid = [{ schema: "legacy-growth-maintenance-approval-v1", resource: COMMENT_RESOURCE }, { schema: "legacy-growth-maintenance-approval-v3", resource: COMMENT_RESOURCE }, { schema: "legacy-growth-maintenance-approval-v2", resource: RESOURCE }, ...[undefined, false, 0, "", "TEST_METADATA"].map(bindingKind => ({ schema: "legacy-growth-maintenance-approval-v2", resource: { ...COMMENT_RESOURCE, bindingKind } })), { schema: "legacy-growth-maintenance-approval-v2", resource: { ...COMMENT_RESOURCE, markerKey: "extra" } }, { schema: "legacy-growth-maintenance-approval-v2", resource: { ...COMMENT_RESOURCE, databaseComment: "" } }, { schema: "legacy-growth-maintenance-approval-v2", resource: { ...COMMENT_RESOURCE, databaseOid: "0" } }];
  const config = t.mock.method(configuration, "loadConfig", () => { throw Error("SHOULD_NOT_CONFIGURE"); });
  const pool = t.mock.method(database, "createBusinessPool", () => { throw Error("SHOULD_NOT_CONNECT"); });
  for (const approval of invalid) {
    const f = fixture({ mode: "PREVIEW", approval }); assert.throws(f.run);
    await assert.rejects(() => main(f.env, f.read, NOW));
  }
  assert.equal(config.mock.callCount(), 0); assert.equal(pool.mock.callCount(), 0);
});
const port = {} as LegacyCoveragePort;
function resultFor(input: maintenance.LegacyGrowthMaintenanceInput): Awaited<ReturnType<typeof maintenance.applyLegacyGrowthMaintenance>> {
  return { replayed: false, receipt: { schema: "legacy-growth-maintenance-receipt-v1", operation: maintenance.LEGACY_GROWTH_MAINTENANCE_OPERATION, executionKey: input.executionKey, subjectUserId: input.subjectUserId, businessFingerprint: input.businessFingerprint, businessPackageSha256: input.businessPackageSha256, coverageFingerprint: "c".repeat(64), coverageExecutionKey: input.executionKey, sourceReceiptDigest: "d".repeat(64), coverageState: "COMPLETE", inserted: 0, replayed: 0, execution: { approvalRef: input.execution.approvalRef, attempt: input.execution.attempt } } };
}
function fakeDb(options: { commitError?: Error; rollbackError?: Error; expired?: boolean } = {}) {
  const queries: string[] = [], releases: Array<boolean | undefined> = []; let connects = 0;
  const client = { async query(sql: string) {
    const id = sql.includes("credit-init-window") ? "WINDOW" : sql; queries.push(id);
    if (id === "WINDOW") return { rows: [{ dbNow: options.expired ? "2026-10-20T04:00:00.000000Z" : "2026-10-20T01:00:00.000000Z" }], rowCount: 1 };
    if (sql === "COMMIT" && options.commitError) throw options.commitError;
    if (sql === "ROLLBACK" && options.rollbackError) throw options.rollbackError;
    return { rows: [], rowCount: 0 };
  }, release(discard?: boolean) { releases.push(discard); } } as unknown as PoolClient;
  const pool = { async connect() { connects++; return client; } } as unknown as Pool;
  return { pool, client, queries, releases, connects: () => connects };
}

test("v2 COMMENT approval preserves COMMIT_UNKNOWN and the original recovery identity", async t => {
  const run = fixture({ approval: { schema: "legacy-growth-maintenance-approval-v2", resource: COMMENT_RESOURCE } }).run();
  const db = fakeDb({ commitError: new Error("SYNTHETIC_COMMIT_LOST") });
  t.mock.method(maintenance, "applyLegacyGrowthMaintenance", async (_client: PoolClient, input: maintenance.LegacyGrowthMaintenanceInput) => resultFor(input));
  await assert.rejects(() => runLegacyGrowthMaintenanceApply(db.pool, run.input, port), error => {
    assert(error instanceof LegacyGrowthMaintenanceOutcomeError); assert.equal(error.outcome, "COMMIT_UNKNOWN"); assert.equal(error.rollbackAcknowledged, false);
    assert.equal(error.preserved.executionKey, KEY); assert.equal(error.preserved.businessFingerprint, run.input.businessFingerprint); assert.equal(error.preserved.businessPackageSha256, run.input.businessPackageSha256);
    return true;
  });
  assert.deepEqual(db.queries, ["BEGIN", "WINDOW", "COMMIT"]); assert.deepEqual(db.releases, [true]);
});

test("two independently signed files bind actual bytes; renewal/recovery retain the business fingerprint", () => {
  const original = fixture(), run = original.run();
  assert.equal(run.input.businessPackageSha256, original.packageSha); assert.equal(run.input.executionKey, KEY);
  assert.equal(JSON.parse(run.input.businessPackageBytes).source.packageDigest, undefined);
  const recovered = fixture({ mode: "RECOVER_READ", approval: { approvalRef: "ROOT-SYNTHETIC-GROWTH-002", attempt: 2 } }).run();
  assert.equal(run.input.businessPackageBytes, recovered.input.businessPackageBytes);
  assert.equal(run.input.businessFingerprint, recovered.input.businessFingerprint);
  assert.equal(maintenance.legacyGrowthMaintenanceFingerprint(recovered.input), run.input.businessFingerprint);
  assert.notEqual(run.input.execution.approvalDigest, recovered.input.execution.approvalDigest);
  const altered = businessPackage(); altered.reason = "Different approved source intent";
  assert.notEqual(fixture({ business: altered }).run().input.businessFingerprint, run.input.businessFingerprint);
});

test("strict package/approval shapes, hashes, modes, actor and resource fail offline", () => {
  const extraSource = businessPackage(); Object.assign(extraSource.source, { packageDigest: "a".repeat(64) });
  const cases = [
    fixture({ business: { ...businessPackage(), executionKey: KEY } }), fixture({ business: extraSource }),
    fixture({ approval: { expired: true } }), fixture({ approval: { actor: { adminId: "boss", sessionId: "session", active: true } } }),
    fixture({ approval: { resource: { ...RESOURCE, denied: true } } }), fixture({ approval: { status: "DRAFT" } }),
    fixture({ approval: { businessPackageSha256: "0".repeat(64) } }), fixture({ approval: { mode: "PREVIEW" } }),
    fixture({ env: { LEGACY_GROWTH_MODE: "WRITE" } }), fixture({ env: { LEGACY_GROWTH_ENABLED: "false" } }),
    fixture({ env: { LEGACY_GROWTH_PACKAGE_SHA256: "0".repeat(64) } }), fixture({ env: { LEGACY_GROWTH_APPROVAL_SHA256: "0".repeat(64) } }),
    fixture({ approval: { resource: { ...RESOURCE, databaseOid: "not-an-oid" } } }), fixture({ approval: { actor: { adminId: "", sessionId: "session" } } }),
    fixture({ approval: { executionKey: "bad" } }), fixture({ approval: { attempt: 0 } }),
  ];
  for (const f of cases) assert.throws(f.run);
});

test("closed/non-UTC/calendar-invalid/over24h windows and configured DB/role reject before a pool is created", async t => {
  let pools = 0;
  t.mock.method(database, "createBusinessPool", () => { pools++; throw new Error("unexpected pool"); });
  t.mock.method(configuration, "loadConfig", () => ({ database: { name: "wrong_database", user: RESOURCE.runtimeRole } }) as configuration.AppConfig);
  const cases = [
    fixture({ approval: { windowEndUtc: "2026-10-20T01:00:00Z" } }),
    fixture({ approval: { windowStartUtc: "2026-10-21T00:00:00Z", windowEndUtc: "2026-10-21T04:00:00Z" } }),
    fixture({ approval: { windowEndUtc: "2026-10-22T00:00:00Z" } }),
    fixture({ approval: { windowStartUtc: "2026-02-30T00:00:00Z" } }),
    fixture({ approval: { windowStartUtc: "2026-10-20T00:00:00+00:00" } }),
    fixture({ approval: { resource: { ...RESOURCE, runtimeRole: "other_role" } } }),
    fixture({ approval: { expired: true } }), fixture({ env: { LEGACY_GROWTH_PACKAGE_SHA256: "0".repeat(64) } }), fixture(),
  ];
  for (const f of cases) await assert.rejects(() => main(f.env, f.read, NOW));
  assert.equal(pools, 0);
  const f = fixture(); assert.throws(() => readLegacyGrowthMaintenanceRun(f.env, f.read, NOW, { databaseName: RESOURCE.databaseName, databaseUser: "wrong_role" }), /nothing was connected/);
});

test("APPLY uses one client and checks DB clock immediately before COMMIT", async t => {
  const run = fixture().run(), db = fakeDb();
  t.mock.method(maintenance, "applyLegacyGrowthMaintenance", async (client: PoolClient, input: maintenance.LegacyGrowthMaintenanceInput) => { assert.equal(client, db.client); assert.equal(input, run.input); return resultFor(input); });
  const result = await runLegacyGrowthMaintenanceApply(db.pool, run.input, port);
  assert.equal(result.receipt.businessFingerprint, run.input.businessFingerprint);
  assert.deepEqual(db.queries, ["BEGIN", "WINDOW", "COMMIT"]); assert.deepEqual(db.releases, [undefined]); assert.equal(db.connects(), 1);
});

test("COMMIT error preserves both fingerprints/key/package and discards without rollback or unsafe error text", async t => {
  const run = fixture().run(), cause = new Error("RAW_SOURCE_SECRET_SQL"), db = fakeDb({ commitError: cause });
  t.mock.method(maintenance, "applyLegacyGrowthMaintenance", async (_client: PoolClient, input: maintenance.LegacyGrowthMaintenanceInput) => resultFor(input));
  await assert.rejects(() => runLegacyGrowthMaintenanceApply(db.pool, run.input, port), error => {
    assert(error instanceof LegacyGrowthMaintenanceOutcomeError); assert.equal(error.outcome, "COMMIT_UNKNOWN"); assert.equal(error.cause, cause); assert.equal(error.rollbackAcknowledged, false);
    assert.equal(error.preserved.executionKey, KEY); assert.equal(error.preserved.businessFingerprint, run.input.businessFingerprint); assert.equal(error.preserved.coverageFingerprint, "c".repeat(64)); assert.equal(error.preserved.businessPackageSha256, run.input.businessPackageSha256);
    const text = describeLegacyGrowthMaintenanceFailure(error); assert.match(text, /COMMIT_UNKNOWN/); assert.match(text, /RECOVER_READ/); assert(!text.includes("RAW_SOURCE_SECRET_SQL")); assert(!text.includes("rollback acknowledged")); return true;
  });
  assert.deepEqual(db.queries, ["BEGIN", "WINDOW", "COMMIT"]); assert.deepEqual(db.releases, [true]);
});

test("expired final permit never sends COMMIT, and rollback failure retains the original cause", async t => {
  const run = fixture().run(), db = fakeDb({ expired: true });
  t.mock.method(maintenance, "applyLegacyGrowthMaintenance", async (_client: PoolClient, input: maintenance.LegacyGrowthMaintenanceInput) => resultFor(input));
  await assert.rejects(() => runLegacyGrowthMaintenanceApply(db.pool, run.input, port), error => error instanceof LegacyGrowthMaintenanceOutcomeError && error.outcome === "NOT_COMMITTED" && error.rollbackAcknowledged);
  assert.deepEqual(db.queries, ["BEGIN", "WINDOW", "ROLLBACK"]);
  const cause = new Error("write failed"), close = new Error("rollback failed"), broken = fakeDb({ rollbackError: close });
  t.mock.method(maintenance, "applyLegacyGrowthMaintenance", async () => { throw cause; });
  await assert.rejects(() => runLegacyGrowthMaintenanceApply(broken.pool, run.input, port), error => error instanceof LegacyGrowthMaintenanceOutcomeError && error.outcome === "NOT_COMMITTED" && error.cause === cause && error.rollbackError === close && !error.rollbackAcknowledged && error.preserved.coverageFingerprint === null);
  assert.deepEqual(broken.releases, [true]); assert(!broken.queries.includes("COMMIT"));
});

test("PREVIEW and recovery use READ ONLY; an UNKNOWN recovery never calls APPLY", async t => {
  const db = fakeDb(); let writes = 0;
  t.mock.method(maintenance, "applyLegacyGrowthMaintenance", async () => { writes++; throw new Error("read path must not write"); });
  t.mock.method(maintenance, "readLegacyGrowthMaintenanceReceipt", async (client: PoolClient) => { assert.equal(client, db.client); return { state: "UNKNOWN" as const, code: "COVERAGE_UNVERIFIED" }; });
  const recovered = await executeLegacyGrowthMaintenanceRun(db.pool, fixture({ mode: "RECOVER_READ" }).run(), port);
  assert.deepEqual(recovered, { state: "UNKNOWN", code: "COVERAGE_UNVERIFIED" }); assert.equal(writes, 0); assert.deepEqual(db.queries, ["BEGIN READ ONLY", "ROLLBACK"]);
  t.mock.method(maintenance, "previewLegacyGrowthMaintenance", async (_client: PoolClient, input: maintenance.LegacyGrowthMaintenanceInput) => ({ businessFingerprint: input.businessFingerprint, subjectUserId: input.subjectUserId, businessPackageSha256: input.businessPackageSha256, coverageFingerprint: "c".repeat(64), sourceReceiptDigest: "d".repeat(64), coverageState: "COMPLETE" as const, contributionCount: 0, existingCoverageExecutionKey: null }));
  await executeLegacyGrowthMaintenanceRun(db.pool, fixture({ mode: "PREVIEW" }).run(), port);
  assert.equal(writes, 0); assert.deepEqual(db.queries.slice(-2), ["BEGIN READ ONLY", "ROLLBACK"]);
});

test("malformed private JSON and generic failures never expose source input or raw errors", () => {
  const f = fixture(), invalid = Buffer.from('{"secret":"RAW_PRIVATE_VALUE"');
  const env = { ...f.env, LEGACY_GROWTH_PACKAGE_SHA256: digest(invalid) };
  assert.throws(() => readLegacyGrowthMaintenanceRun(env, p => p === "business.json" ? invalid : f.read(p), NOW), error => { const text = describeLegacyGrowthMaintenanceFailure(error); assert(!text.includes("RAW_PRIVATE_VALUE")); return true; });
  assert(!describeLegacyGrowthMaintenanceFailure(new Error("RAW_SQL_SECRET")).includes("RAW_SQL_SECRET"));
});
