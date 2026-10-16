import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { creditInitializationFingerprint, previewCreditInitialization, type CreditInitializationInput } from "../src/credit/credit-initialization";
import { buildCreditInitializationBatches, creditPackageBytes, nextCreditBatchAction, type CreditPreviewRow } from "../src/credit/credit-initialization-batches";

// FIXTURE ONLY: synthetic user ids, not a real cohort.
const rows = (n: number, category: CreditPreviewRow["category"] = "ACTIVE", extra: Partial<CreditPreviewRow> = {}, p = "u") => Array.from({ length: n }, (_, i) => ({ userId: `${p}${String(i).padStart(5, "0")}`, category, hasCreditState: false, hasInitializedEvent: false, ...extra }));

test("ACTIVE without profile is split into sorted <=500 packages; others retained, totals balance with denominator", () => {
  const input = [...rows(1001), ...rows(3, "ACTIVE", { hasCreditState: true }, "e"), ...rows(2, "RESTRICTED", {}, "r"), ...rows(1, "CANCELLED", {}, "c"), ...rows(4, "DEACTIVATED", {}, "d"), ...rows(5, "UNKNOWN", {}, "k"), ...rows(1, "ACTIVE", { hasInitializedEvent: true }, "v")];
  const plan = buildCreditInitializationBatches(input, { batchKeyPrefix: "w1-fixture", reason: "Fixture initial credit 100", denominator: input.length });
  assert.deepEqual(plan.batches.map((b) => b.package.userIds.length), [500, 500, 1]);
  assert.equal(plan.batches[0]!.package.batchKey, "credit-init:w1-fixture-0001");
  const r = plan.reconciliation;
  assert.deepEqual([r.batched, r.existingProfile, r.restricted, r.cancelled, r.deactivated, r.unknown, r.eventWithoutState, r.notObserved, r.balanced], [1001, 3, 2, 1, 4, 5, 1, 0, true]);
  const all = plan.batches.flatMap((b) => b.package.userIds); assert.equal(new Set(all).size, all.length);
});

test("package bytes are the CLI shape and sha binds them; approval template is never APPROVED", () => {
  const plan = buildCreditInitializationBatches(rows(2), { batchKeyPrefix: "w1-fixture", reason: "Fixture initial credit 100", denominator: 2 });
  const b = plan.batches[0]!;
  assert.deepEqual(Object.keys(JSON.parse(b.bytes)), ["schema", "batchKey", "userIds", "approvedCategory", "reason"]);
  assert.equal(b.sha256, createHash("sha256").update(creditPackageBytes(b.package)).digest("hex"));
  assert.equal(b.approvalTemplate.status, "DRAFT_NOT_APPROVED");
  assert.equal(b.approvalTemplate.businessPackageSha256, b.sha256);
});

test("unknown denominator or unobserved rows never balance; duplicates and bad sizes reject", () => {
  assert.equal(buildCreditInitializationBatches(rows(3), { batchKeyPrefix: "w1-fixture", reason: "Fixture initial credit 100", denominator: null }).reconciliation.balanced, false);
  assert.equal(buildCreditInitializationBatches(rows(3), { batchKeyPrefix: "w1-fixture", reason: "Fixture initial credit 100", denominator: 4 }).reconciliation.notObserved, 1);
  assert.throws(() => buildCreditInitializationBatches([...rows(1), ...rows(1)], { batchKeyPrefix: "w1-fixture", reason: "Fixture initial credit 100", denominator: 2 }), /DUPLICATE/);
  assert.throws(() => buildCreditInitializationBatches(rows(1), { batchKeyPrefix: "w1-fixture", reason: "Fixture initial credit 100", denominator: 1, maxBatch: 501 }), /BATCH_SIZE/);
});

test("batch recovery actions: COMMIT_UNKNOWN must be read before any retry", () => {
  assert.equal(nextCreditBatchAction("COMMIT_UNKNOWN", null), "RECOVER_READ");
  assert.equal(nextCreditBatchAction("COMMIT_UNKNOWN", "FOUND"), "DONE");
  assert.equal(nextCreditBatchAction("COMMIT_UNKNOWN", "NOT_FOUND"), "RETRY_SAME_PACKAGE_NEW_WINDOW");
  assert.equal(nextCreditBatchAction("COMMIT_UNKNOWN", "FINGERPRINT_MISMATCH"), "STOP_ESCALATE");
  assert.equal(nextCreditBatchAction("REJECTED_DRIFT", null), "REPREVIEW_NEW_PACKAGE");
  assert.equal(nextCreditBatchAction("REPLAYED", null), "DONE");
});

// B-R1-01 regression: generated packages go through the REAL runner input validation, not just a JSON shape check.
const execution = { actorAdminId: "admin-fixture", actorSessionId: "session-fixture", approvalRef: "approval-fixture", attempt: 1, approvalDigest: "c".repeat(64), windowStartUtc: "2026-10-16T00:00:00.000Z", windowEndUtc: "2026-10-16T01:00:00.000Z",
  resource: { databaseName: "db", databaseOid: "1", owner: "o", runtimeRole: "r", markerKey: "k", markerTarget: "t", markerVersion: 1 } };
const runnerInput = (pkg: { batchKey: string; userIds: string[]; reason: string }, sha256: string): CreditInitializationInput =>
  ({ batchKey: pkg.batchKey, userIds: pkg.userIds, approvedCategory: "ACTIVE", reason: pkg.reason, intentDigest: sha256, execution, requestId: "req-fixture" });

test("B-R1-01: every generated package passes the existing fingerprint validation and reaches preview authorization", async () => {
  const plan = buildCreditInitializationBatches(rows(1001), { batchKeyPrefix: "w1-fixture", reason: "Fixture initial credit 100", denominator: 1001 });
  for (const b of plan.batches) {
    assert.match(creditInitializationFingerprint(runnerInput(b.package, b.sha256)), /^[0-9a-f]{64}$/);
    let queries = 0;
    const client = { async query() { queries += 1; throw new Error("STOP_AFTER_VALIDATION"); } } as never;
    await assert.rejects(() => previewCreditInitialization(client, runnerInput(b.package, b.sha256)), (e: any) => !/batchKey/.test(String(e?.message)));
    assert.ok(queries > 0, "validation passed and preview proceeded to the DB authorization step");
  }
  const prefixes = ["ab", "x".repeat(92), "bad:colon", "-lead"];
  for (const p of prefixes) assert.throws(() => buildCreditInitializationBatches(rows(1), { batchKeyPrefix: p, reason: "Fixture initial credit 100", denominator: 1 }), /PACKAGE_INPUT_INVALID/);
  const longest = buildCreditInitializationBatches(rows(1), { batchKeyPrefix: "x".repeat(91), reason: "Fixture initial credit 100", denominator: 1 }).batches[0]!;
  assert.match(creditInitializationFingerprint(runnerInput(longest.package, longest.sha256)), /^[0-9a-f]{64}$/);
});

test("B-R1-01 control: the old generated key shape is rejected by the real runner before any query", async () => {
  let queries = 0;
  const client = { async query() { queries += 1; return { rows: [] }; } } as never;
  const old = { batchKey: "credit-init-w1-0001", userIds: ["u00000"], reason: "Fixture initial credit 100" };
  assert.throws(() => creditInitializationFingerprint(runnerInput(old, "d".repeat(64))), /batchKey must match credit-init:/);
  await assert.rejects(() => previewCreditInitialization(client, runnerInput(old, "d".repeat(64))), /batchKey must match credit-init:/);
  assert.equal(queries, 0);
});