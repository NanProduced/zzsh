import { createHash } from "node:crypto";
import { CREDIT_INITIALIZATION_MAX_BATCH, type CreditInitializationCategory } from "./credit-initialization";

/**
 * Offline batch/package builder over a REAL read-only P01 page result. No DB access, no approval minting:
 * approval templates are DRAFT_NOT_APPROVED and are rejected by the existing CLI until /root signs them.
 */
export type CreditPreviewRow = { userId: string; category: CreditInitializationCategory; hasCreditState: boolean; hasInitializedEvent: boolean };
export type CreditBatchPackage = { schema: "credit-init-package-v1"; batchKey: string; userIds: string[]; approvedCategory: "ACTIVE"; reason: string };
export type CreditBatchArtifact = { order: number; package: CreditBatchPackage; bytes: string; sha256: string; approvalTemplate: Record<string, unknown> };
export type CreditDenominatorReconciliation = {
  denominator: number; observed: number; batched: number; existingProfile: number; restricted: number; cancelled: number; frozen: number;
  unknown: number; eventWithoutState: number; notObserved: number | null; balanced: boolean;
};
export type CreditBatchPlan = { batches: CreditBatchArtifact[]; reconciliation: CreditDenominatorReconciliation; retainedByReason: Record<string, string[]> };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function creditPackageBytes(pkg: CreditBatchPackage): string {
  return JSON.stringify({ schema: pkg.schema, batchKey: pkg.batchKey, userIds: pkg.userIds, approvedCategory: pkg.approvedCategory, reason: pkg.reason }, null, 2) + "\n";
}

export function buildCreditInitializationBatches(rows: readonly CreditPreviewRow[], opts: { batchKeyPrefix: string; reason: string; denominator: number | null; maxBatch?: number }): CreditBatchPlan {
  const max = opts.maxBatch ?? CREDIT_INITIALIZATION_MAX_BATCH;
  if (!Number.isInteger(max) || max < 1 || max > CREDIT_INITIALIZATION_MAX_BATCH) throw new Error("BATCH_SIZE_INVALID");
  // Existing runner contract: batchKey = credit-init:<8-96 of [A-Za-z0-9._-]>; prefix + "-NNNN" must fit it.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,90}$/.test(opts.batchKeyPrefix) || opts.reason.trim().length < 8) throw new Error("PACKAGE_INPUT_INVALID");
  const seen = new Set<string>();
  const retained: Record<string, string[]> = { EXISTING_PROFILE: [], RESTRICTED: [], CANCELLED: [], FROZEN: [], UNKNOWN: [], EVENT_WITHOUT_STATE: [] };
  const eligible: string[] = [];
  for (const r of rows) {
    if (!ID.test(r.userId)) throw new Error("USER_ID_INVALID");
    if (seen.has(r.userId)) throw new Error("DUPLICATE_USER_ID");
    seen.add(r.userId);
    if (r.hasCreditState) retained.EXISTING_PROFILE!.push(r.userId); // never reset
    else if (r.hasInitializedEvent) retained.EVENT_WITHOUT_STATE!.push(r.userId); // anomaly: recover, do not re-init
    else if (r.category === "ACTIVE") eligible.push(r.userId);
    else retained[r.category]!.push(r.userId);
  }
  eligible.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // B-CREDIT-01: the ordinal width follows the real batch count; the LONGEST final key must fit the runner contract
  // (credit-init:<8-96>). Reject the whole build instead of truncating or changing any key.
  const batchCount = Math.ceil(eligible.length / max);
  const width = Math.max(4, String(batchCount).length);
  if (batchCount > 0 && `${opts.batchKeyPrefix}-${String(batchCount).padStart(width, "0")}`.length > 96) throw new Error("BATCH_KEY_TOO_LONG");
  const batches: CreditBatchArtifact[] = [];
  for (let i = 0; i < eligible.length; i += max) {
    const order = batches.length + 1;
    const pkg: CreditBatchPackage = { schema: "credit-init-package-v1", batchKey: `credit-init:${opts.batchKeyPrefix}-${String(order).padStart(width, "0")}`, userIds: eligible.slice(i, i + max), approvedCategory: "ACTIVE", reason: opts.reason };
    const bytes = creditPackageBytes(pkg), sha256 = createHash("sha256").update(bytes).digest("hex");
    batches.push({ order, package: pkg, bytes, sha256, approvalTemplate: {
      schema: "credit-init-approval-v1", status: "DRAFT_NOT_APPROVED", approvalRef: null, attempt: 1, mode: "PREVIEW", businessPackageSha256: sha256,
      actor: { adminId: null, sessionId: null }, windowStartUtc: null, windowEndUtc: null,
      resource: { databaseName: null, databaseOid: null, owner: null, runtimeRole: null, markerKey: null, markerTarget: null, markerVersion: null },
    } });
  }
  const n = (k: string) => retained[k]!.length;
  const accounted = eligible.length + n("EXISTING_PROFILE") + n("RESTRICTED") + n("CANCELLED") + n("FROZEN") + n("UNKNOWN") + n("EVENT_WITHOUT_STATE");
  const notObserved = opts.denominator === null ? null : opts.denominator - rows.length;
  return {
    batches, retainedByReason: retained,
    reconciliation: { denominator: opts.denominator ?? -1, observed: rows.length, batched: eligible.length, existingProfile: n("EXISTING_PROFILE"), restricted: n("RESTRICTED"), cancelled: n("CANCELLED"), frozen: n("FROZEN"), unknown: n("UNKNOWN"), eventWithoutState: n("EVENT_WITHOUT_STATE"), notObserved,
      balanced: accounted === rows.length && notObserved === 0 },
  };
}

export type CreditBatchOutcome = "APPLIED" | "REPLAYED" | "NOT_COMMITTED" | "COMMIT_UNKNOWN" | "REJECTED_DRIFT" | "NOT_RUN";
export type CreditRecoveryRead = "FOUND" | "NOT_FOUND" | "FINGERPRINT_MISMATCH" | null;

/** Next action per batch; later batches never proceed past an unresolved COMMIT_UNKNOWN (failure isolation by order). */
export function nextCreditBatchAction(outcome: CreditBatchOutcome, recovery: CreditRecoveryRead): "DONE" | "RECOVER_READ" | "RETRY_SAME_PACKAGE_NEW_WINDOW" | "REPREVIEW_NEW_PACKAGE" | "STOP_ESCALATE" | "PENDING" {
  if (outcome === "APPLIED" || outcome === "REPLAYED") return "DONE";
  if (outcome === "NOT_RUN") return "PENDING";
  if (outcome === "NOT_COMMITTED") return "RETRY_SAME_PACKAGE_NEW_WINDOW";
  if (outcome === "REJECTED_DRIFT") return "REPREVIEW_NEW_PACKAGE";
  if (recovery === null) return "RECOVER_READ";
  if (recovery === "FOUND") return "DONE";
  if (recovery === "NOT_FOUND") return "RETRY_SAME_PACKAGE_NEW_WINDOW";
  return "STOP_ESCALATE";
}
