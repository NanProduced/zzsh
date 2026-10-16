import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";

import { ConfigurationError, loadConfig } from "../config/config";
import { createBusinessPool } from "../database/business";
import { assertCreditInitializationWindowOpen, withReadOnlyTransaction, type CreditInitializationExecution, type CreditInitializationResource } from "../credit/credit-initialization";
import {
  LEGACY_GROWTH_MAINTENANCE_OPERATION, prepareLegacyGrowthMaintenanceInput, legacyGrowthMaintenanceFingerprint,
  previewLegacyGrowthMaintenance, applyLegacyGrowthMaintenance, readLegacyGrowthMaintenanceReceipt,
  type LegacyGrowthMaintenanceInput,
} from "./membership-growth-legacy-maintenance";
import { createLegacyGrowthCoveragePort } from "./membership-growth-legacy-store";
import type { LegacyCoveragePort } from "./membership-growth-legacy";

/**
 * RUNNER_DRAFT: two-file maintenance CLI only; no npm or HTTP entry is registered.
 * The business file contains source facts and reason, never executionKey/window/packageDigest.
 * Approval binds the actual business bytes, execution key, current actor/window and resource.
 * resource.runtimeRole names current_user for this window; an approved maintenance owner
 * does not grant membership writes to the ordinary application runtime. The business
 * guard checks current Boss/session/resource on every mode and the H3 relation owner
 * on APPLY; the server's non-owner runtime identity guard is deliberately not used here.
 */
export type LegacyGrowthMaintenanceMode = "PREVIEW" | "APPLY" | "RECOVER_READ";
export type LegacyGrowthMaintenanceApproval = {
  schema: "legacy-growth-maintenance-approval-v1"; status: "APPROVED";
  approvalRef: string; attempt: number; mode: LegacyGrowthMaintenanceMode;
  businessPackageSha256: string; executionKey: string;
  actor: { adminId: string; sessionId: string };
  windowStartUtc: string; windowEndUtc: string; resource: CreditInitializationResource;
};
export type LegacyGrowthMaintenanceRun = { mode: LegacyGrowthMaintenanceMode; input: LegacyGrowthMaintenanceInput };
const HEX = /^[a-f0-9]{64}$/, REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/, KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError(`${label} must be an object`);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) throw new ConfigurationError(`${label} has missing or unknown fields`);
  return value as Record<string, unknown>;
}
function json(bytes: Buffer, label: string): unknown {
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) throw new ConfigurationError(`${label} must use UTF-8`);
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new ConfigurationError(`${label} must be valid JSON`); }
}
function text(value: unknown, max = 255): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function utc(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)) throw new ConfigurationError("execution window must use UTC instants");
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new ConfigurationError("execution window must use valid UTC instants");
  return n;
}
function assertConfiguredResource(run: LegacyGrowthMaintenanceRun, configured: { databaseName: string; databaseUser: string }): void {
  const resource = run.input.execution.resource;
  if (configured.databaseName !== resource.databaseName || configured.databaseUser !== resource.runtimeRole) throw new ConfigurationError("configured database/role is not the approved resource; nothing was connected");
}

export function readLegacyGrowthMaintenanceRun(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Buffer = p => readFileSync(p),
  nowMs = Date.now(),
  configured?: { databaseName: string; databaseUser: string },
): LegacyGrowthMaintenanceRun {
  if (env.LEGACY_GROWTH_ENABLED?.trim() !== "true") throw new ConfigurationError("LEGACY_GROWTH_ENABLED=true is required");
  const packageFile = env.LEGACY_GROWTH_PACKAGE_FILE?.trim(), packageSha = env.LEGACY_GROWTH_PACKAGE_SHA256?.trim().toLowerCase();
  const approvalFile = env.LEGACY_GROWTH_APPROVAL_FILE?.trim(), approvalSha = env.LEGACY_GROWTH_APPROVAL_SHA256?.trim().toLowerCase();
  if (!packageFile || !approvalFile || !HEX.test(packageSha ?? "") || !HEX.test(approvalSha ?? "")) throw new ConfigurationError("LEGACY_GROWTH package and approval files with sha256 digests are required");
  let businessBytes: Buffer, approvalBytes: Buffer;
  try { businessBytes = read(packageFile); approvalBytes = read(approvalFile); } catch { throw new ConfigurationError("unable to read the business package or approval"); }
  if (hash(businessBytes) !== packageSha) throw new ConfigurationError("business package digest does not match the signed digest");
  if (hash(approvalBytes) !== approvalSha) throw new ConfigurationError("execution approval digest does not match the signed digest");
  const business = exactKeys(json(businessBytes, "business package"), ["schema", "reason", "source"], "business package");
  exactKeys(business.source, ["receipt", "inputs", "corrections", "admitted", "gameIdBySettlementId"], "business source");
  if (business.schema !== "legacy-growth-maintenance-package-v1" || !text(business.reason, 2000)) throw new ConfigurationError("business package must be legacy-growth-maintenance-package-v1 with a reason");
  const approval = exactKeys(json(approvalBytes, "execution approval"), ["schema", "status", "approvalRef", "attempt", "mode", "businessPackageSha256", "executionKey", "actor", "windowStartUtc", "windowEndUtc", "resource"], "execution approval") as unknown as LegacyGrowthMaintenanceApproval;
  exactKeys(approval.actor, ["adminId", "sessionId"], "approval.actor");
  exactKeys(approval.resource, ["databaseName", "databaseOid", "owner", "runtimeRole", "markerKey", "markerTarget", "markerVersion"], "approval.resource");
  if (approval.schema !== "legacy-growth-maintenance-approval-v1" || approval.status !== "APPROVED") throw new ConfigurationError("execution approval must be an APPROVED legacy-growth-maintenance-approval-v1");
  if (approval.businessPackageSha256 !== packageSha) throw new ConfigurationError("execution approval does not approve this business package");
  if (!REF.test(approval.approvalRef ?? "") || !Number.isSafeInteger(approval.attempt) || approval.attempt < 1 || !KEY.test(approval.executionKey ?? "") || !text(approval.actor.adminId) || !text(approval.actor.sessionId)) throw new ConfigurationError("approval actor, reference, attempt and execution key are invalid");
  const r = approval.resource;
  if (![r.databaseName, r.owner, r.runtimeRole].every(v => typeof v === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(v)) || typeof r.databaseOid !== "string" || !/^[1-9]\d{0,9}$/.test(r.databaseOid) || BigInt(r.databaseOid) > 4294967295n || !text(r.markerKey) || !text(r.markerTarget) || !Number.isSafeInteger(r.markerVersion) || r.markerVersion < 1) throw new ConfigurationError("approval resource binding is invalid");
  const mode = (env.LEGACY_GROWTH_MODE?.trim() || "PREVIEW") as LegacyGrowthMaintenanceMode;
  if (!["PREVIEW", "APPLY", "RECOVER_READ"].includes(mode) || approval.mode !== mode) throw new ConfigurationError("LEGACY_GROWTH_MODE must equal the approved mode");
  const start = utc(approval.windowStartUtc), end = utc(approval.windowEndUtc);
  if (end <= start || end - start > MAX_WINDOW_MS) throw new ConfigurationError("execution window must be an interval of at most 24h");
  if (!Number.isFinite(nowMs) || nowMs < start || nowMs >= end) throw new ConfigurationError("execution window is not open; nothing was connected");
  const execution: CreditInitializationExecution = { actorAdminId: approval.actor.adminId, actorSessionId: approval.actor.sessionId, approvalRef: approval.approvalRef, attempt: approval.attempt, approvalDigest: approvalSha!, windowStartUtc: approval.windowStartUtc, windowEndUtc: approval.windowEndUtc, resource: approval.resource };
  const run = { mode, input: prepareLegacyGrowthMaintenanceInput(businessBytes, packageSha!, { executionKey: approval.executionKey, execution, requestId: `req_legacy_growth_${randomUUID().replaceAll("-", "")}` }) };
  if (configured) assertConfiguredResource(run, configured);
  return run;
}

export type LegacyGrowthMaintenancePreserved = {
  operation: typeof LEGACY_GROWTH_MAINTENANCE_OPERATION; executionKey: string; businessFingerprint: string;
  coverageFingerprint: string | null; sourceReceiptDigest: string | null; businessPackageSha256: string;
  actorAdminId: string; approvalRef: string; attempt: number;
};
export class LegacyGrowthMaintenanceOutcomeError extends Error {
  constructor(readonly outcome: "NOT_COMMITTED" | "COMMIT_UNKNOWN", readonly preserved: LegacyGrowthMaintenancePreserved, readonly rollbackAcknowledged: boolean, readonly cause: unknown, readonly rollbackError?: unknown) {
    super(`LEGACY_GROWTH_MAINTENANCE_${outcome}`); this.name = "LegacyGrowthMaintenanceOutcomeError";
  }
}

/** One client for authorization, idempotency, contributions, coverage, audit and final window check. */
export async function runLegacyGrowthMaintenanceApply(pool: Pick<Pool, "connect">, input: LegacyGrowthMaintenanceInput, port: LegacyCoveragePort): Promise<Awaited<ReturnType<typeof applyLegacyGrowthMaintenance>>> {
  const preserved: LegacyGrowthMaintenancePreserved = { operation: LEGACY_GROWTH_MAINTENANCE_OPERATION, executionKey: input.executionKey, businessFingerprint: legacyGrowthMaintenanceFingerprint(input), coverageFingerprint: null, sourceReceiptDigest: null, businessPackageSha256: input.businessPackageSha256, actorAdminId: input.execution.actorAdminId, approvalRef: input.execution.approvalRef, attempt: input.execution.attempt };
  let client: PoolClient;
  try { client = await pool.connect(); } catch (cause) { throw new LegacyGrowthMaintenanceOutcomeError("NOT_COMMITTED", preserved, false, cause); }
  let commitSent = false, broken = false;
  try {
    await client.query("BEGIN");
    const result = await applyLegacyGrowthMaintenance(client, input, port);
    preserved.coverageFingerprint = result.receipt.coverageFingerprint; preserved.sourceReceiptDigest = result.receipt.sourceReceiptDigest;
    await assertCreditInitializationWindowOpen(client, input.execution);
    commitSent = true; await client.query("COMMIT"); return result;
  } catch (cause) {
    if (commitSent) { broken = true; throw new LegacyGrowthMaintenanceOutcomeError("COMMIT_UNKNOWN", preserved, false, cause); }
    let acknowledged = false, rollbackError: unknown;
    try { await client.query("ROLLBACK"); acknowledged = true; } catch (error) { broken = true; rollbackError = error; }
    throw new LegacyGrowthMaintenanceOutcomeError("NOT_COMMITTED", preserved, acknowledged, cause, rollbackError);
  } finally { client.release(broken ? true : undefined); }
}

export async function executeLegacyGrowthMaintenanceRun(pool: Pool, run: LegacyGrowthMaintenanceRun, port: LegacyCoveragePort) {
  if (run.mode === "APPLY") return runLegacyGrowthMaintenanceApply(pool, run.input, port);
  if (run.mode === "RECOVER_READ") return withReadOnlyTransaction(pool, client => readLegacyGrowthMaintenanceReceipt(client, run.input, port));
  return withReadOnlyTransaction(pool, client => previewLegacyGrowthMaintenance(client, run.input, port));
}

/** Never prints source bytes, SQL errors, secrets or an unproven rollback. */
export function describeLegacyGrowthMaintenanceFailure(error: unknown): string {
  if (error instanceof ConfigurationError) return `Legacy growth maintenance rejected: ${error.message}`;
  if (error instanceof LegacyGrowthMaintenanceOutcomeError) return error.outcome === "COMMIT_UNKNOWN"
    ? `Legacy growth maintenance COMMIT_UNKNOWN. Do not change the execution key or business package; use LEGACY_GROWTH_MODE=RECOVER_READ with a new approval. preserved=${JSON.stringify(error.preserved)}`
    : `Legacy growth maintenance NOT_COMMITTED: COMMIT was never sent${error.rollbackAcknowledged ? " (rollback acknowledged)" : " (no rollback acknowledgement)"}. preserved=${JSON.stringify(error.preserved)}`;
  return "Legacy growth maintenance stopped; no successful outcome is asserted.";
}

export async function main(env: NodeJS.ProcessEnv = process.env, read?: (path: string) => Buffer, nowMs = Date.now()): Promise<void> {
  const run = readLegacyGrowthMaintenanceRun(env, read, nowMs);
  const config = loadConfig(env);
  assertConfiguredResource(run, { databaseName: config.database.name, databaseUser: config.database.user });
  const pool = createBusinessPool(config);
  try {
    const result = await executeLegacyGrowthMaintenanceRun(pool, run, createLegacyGrowthCoveragePort());
    console.log(JSON.stringify({ mode: run.mode, operation: LEGACY_GROWTH_MAINTENANCE_OPERATION, executionKey: run.input.executionKey, businessFingerprint: run.input.businessFingerprint, businessPackageSha256: run.input.businessPackageSha256, approvalRef: run.input.execution.approvalRef, attempt: run.input.execution.attempt, result }));
  } finally { await pool.end(); }
}
if (require.main === module) void main().catch((error: unknown) => { console.error(describeLegacyGrowthMaintenanceFailure(error)); process.exitCode = 1; });
