import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { ConfigurationError, loadConfig } from "../config/config";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../database/business";
import {
  CreditInitializationOutcomeError,
  previewCreditInitialization,
  readCreditInitializationReceipt,
  runCreditInitializationBatch,
  withReadOnlyTransaction,
  isCreditInitializationResource,
  type CreditInitializationInput,
  type CreditInitializationTestMetadataResource,
  type CreditInitializationCommentResource,
} from "./credit-initialization";

/**
 * RUNNER_DRAFT. Maintenance runner for one credit initialization batch; not an npm script and not an HTTP route.
 *
 * Two separately signed inputs:
 *  - business package (stable intent): batchKey, userIds, approvedCategory=ACTIVE, reason. Its sha256 is the
 *    intentDigest inside the idempotency fingerprint, so a recovery window reuses the same key and body.
 *  - execution approval (per window): approvalRef, attempt, mode, actor admin + session, UTC window, exact resource
 *    (database name/OID/owner/runtime role/marker) and the business package sha256 it approves.
 * Everything that can be checked offline is checked before connecting: digests, strict shapes (unknown fields are
 * rejected, so an attached "expired"/"not approved" field cannot be ignored), status=APPROVED, mode, local clock
 * inside the window, and the configured database name/role equal to the approved resource. Inside the transaction
 * the actor/session/Boss, DB clock window and live resource are rechecked (see authorizeCreditInitializationExecution).
 */
export type CreditInitializationPackage = { schema: "credit-init-package-v1"; batchKey: string; userIds: string[]; approvedCategory: "ACTIVE"; reason: string };
export type CreditInitializationApproval = {
  status: "APPROVED";
  approvalRef: string;
  attempt: number;
  mode: CreditInitializationMode;
  businessPackageSha256: string;
  actor: { adminId: string; sessionId: string };
  windowStartUtc: string;
  windowEndUtc: string;
} & ({ schema: "credit-init-approval-v1"; resource: CreditInitializationTestMetadataResource }
  | { schema: "credit-init-approval-v2"; resource: CreditInitializationCommentResource });
export type CreditInitializationMode = "PREVIEW" | "APPLY" | "RECOVER_READ";

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

function exactKeys(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError(`${what} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ConfigurationError(`${what} has missing or unknown fields`);
  return value as Record<string, unknown>;
}

function digestOf(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export function readCreditInitializationRun(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Buffer = (p) => readFileSync(p),
  nowMs: number = Date.now(),
  configured?: { databaseName: string; databaseUser: string },
): { mode: CreditInitializationMode; input: CreditInitializationInput } {
  if (env.CREDIT_INIT_ENABLED?.trim() !== "true") throw new ConfigurationError("CREDIT_INIT_ENABLED=true is required");
  const packageFile = env.CREDIT_INIT_PACKAGE_FILE?.trim();
  const packageSha = env.CREDIT_INIT_PACKAGE_SHA256?.trim().toLowerCase();
  const approvalFile = env.CREDIT_INIT_APPROVAL_FILE?.trim();
  const approvalSha = env.CREDIT_INIT_APPROVAL_SHA256?.trim().toLowerCase();
  if (!packageFile || !packageSha || !approvalFile || !approvalSha) throw new ConfigurationError("CREDIT_INIT_PACKAGE_FILE/_SHA256 and CREDIT_INIT_APPROVAL_FILE/_SHA256 are required");
  const packageBytes = read(packageFile);
  if (digestOf(packageBytes) !== packageSha) throw new ConfigurationError("business package digest does not match the signed digest");
  const approvalBytes = read(approvalFile);
  if (digestOf(approvalBytes) !== approvalSha) throw new ConfigurationError("execution approval digest does not match the signed digest");
  const pkg = exactKeys(JSON.parse(packageBytes.toString("utf8")), ["schema", "batchKey", "userIds", "approvedCategory", "reason"], "business package") as unknown as CreditInitializationPackage;
  if (pkg.schema !== "credit-init-package-v1" || pkg.approvedCategory !== "ACTIVE" || !Array.isArray(pkg.userIds)) throw new ConfigurationError("business package must be credit-init-package-v1 with approvedCategory ACTIVE");
  const approval = exactKeys(JSON.parse(approvalBytes.toString("utf8")), ["schema", "status", "approvalRef", "attempt", "mode", "businessPackageSha256", "actor", "windowStartUtc", "windowEndUtc", "resource"], "execution approval") as unknown as CreditInitializationApproval;
  exactKeys(approval.actor, ["adminId", "sessionId"], "approval.actor");
  if (!["credit-init-approval-v1", "credit-init-approval-v2"].includes(approval.schema) || approval.status !== "APPROVED") throw new ConfigurationError("execution approval is not an APPROVED credit-init-approval-v1/v2");
  if (!isCreditInitializationResource(approval.resource) || (approval.schema === "credit-init-approval-v2") !== ("bindingKind" in approval.resource)) throw new ConfigurationError("approval.resource does not match the approved schema");
  if (approval.businessPackageSha256 !== packageSha) throw new ConfigurationError("execution approval does not approve this business package");
  const mode = (env.CREDIT_INIT_MODE?.trim() || "PREVIEW") as CreditInitializationMode;
  if (!["PREVIEW", "APPLY", "RECOVER_READ"].includes(mode) || approval.mode !== mode) throw new ConfigurationError("CREDIT_INIT_MODE must equal the approved mode");
  const start = Date.parse(approval.windowStartUtc);
  const end = Date.parse(approval.windowEndUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_WINDOW_MS) throw new ConfigurationError("execution window must be a valid UTC interval of at most 24h");
  if (nowMs < start || nowMs >= end) throw new ConfigurationError("execution window is not open; nothing was connected");
  if (configured && (configured.databaseName !== approval.resource.databaseName || configured.databaseUser !== approval.resource.runtimeRole)) throw new ConfigurationError("configured database/role is not the approved resource; nothing was connected");
  return {
    mode,
    input: {
      batchKey: pkg.batchKey, userIds: pkg.userIds, approvedCategory: "ACTIVE", reason: pkg.reason, intentDigest: packageSha,
      execution: { actorAdminId: approval.actor.adminId, actorSessionId: approval.actor.sessionId, approvalRef: approval.approvalRef, attempt: approval.attempt, approvalDigest: approvalSha, windowStartUtc: approval.windowStartUtc, windowEndUtc: approval.windowEndUtc, resource: approval.resource },
      requestId: `req_credit_init_${randomUUID().replaceAll("-", "")}`,
    },
  };
}

/** Operator-facing outcome text. Never claims a rollback that was not proven. */
export function describeCreditInitializationFailure(error: unknown): string {
  if (error instanceof ConfigurationError) return `Credit initialization rejected before connecting: ${error.message}`;
  if (error instanceof CreditInitializationOutcomeError) {
    if (error.outcome === "NOT_COMMITTED") return `Credit initialization NOT_COMMITTED: COMMIT was never sent${error.rollbackAcknowledged ? " (rollback acknowledged)" : " (connection discarded)"}. preserved=${JSON.stringify(error.preserved)}`;
    return `Credit initialization COMMIT_UNKNOWN: the outcome may already be committed. Do not change the key or package. Recover with CREDIT_INIT_MODE=RECOVER_READ under a newly approved window using the same business package. preserved=${JSON.stringify(error.preserved)}`;
  }
  return "Credit initialization was not executed: failed before the batch transaction started.";
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const run = readCreditInitializationRun(process.env, undefined, Date.now(), { databaseName: config.database.name, databaseUser: config.database.user });
  const pool = createBusinessPool(config);
  try {
    await assertBusinessRuntimeIdentity(pool, config);
    const result = run.mode === "APPLY"
      ? await runCreditInitializationBatch(pool, run.input)
      : run.mode === "RECOVER_READ"
        ? await withReadOnlyTransaction(pool, (client) => readCreditInitializationReceipt(client, run.input))
        : await withReadOnlyTransaction(pool, (client) => previewCreditInitialization(client, run.input));
    // Counts and ids only; no personal profile fields are read or printed.
    console.log(JSON.stringify({ mode: run.mode, batchKey: run.input.batchKey, approvalRef: run.input.execution.approvalRef, attempt: run.input.execution.attempt, result }));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(describeCreditInitializationFailure(error));
    process.exitCode = 1;
  });
}
