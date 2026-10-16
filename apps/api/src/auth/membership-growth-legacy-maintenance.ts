import type { PoolClient } from "pg";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import {
  authorizeCreditInitializationExecution, assertCreditInitializationWindowOpen,
  type CreditInitializationExecution,
} from "../credit/credit-initialization";
import { canonicalize } from "../supply/content-hash";
import { invalid, sha256Hex, withIdempotency } from "../supply/supply-util";
import { recordAudit, setAuditContext, SecurityApiError } from "./security-core";
import {
  prepareLegacyGrowthBackfill, writePreparedLegacyGrowth, recoverLegacyGrowthBackfill, verifyLegacyCoverageRecord,
  type LegacyCoveragePort, type LegacyCoverageRecord, type LegacyGrowthSourcePackage,
} from "./membership-growth-legacy";

export const LEGACY_GROWTH_MAINTENANCE_OPERATION = "membership.growth.legacy.backfill";
export type LegacyGrowthMaintenanceExecution = CreditInitializationExecution;
export type LegacyGrowthMaintenanceContext = {
  executionKey: string;
  execution: LegacyGrowthMaintenanceExecution;
  requestId: string;
};
export type LegacyGrowthMaintenancePackage = {
  schema: "legacy-growth-maintenance-package-v1";
  reason: string;
  source: Omit<LegacyGrowthSourcePackage, "packageDigest">;
};
export type LegacyGrowthMaintenanceInput = LegacyGrowthMaintenanceContext & {
  readonly businessPackageBytes: string;
  readonly businessPackageSha256: string;
  readonly subjectUserId: string;
  readonly reason: string;
  readonly businessFingerprint: string;
};
export type LegacyGrowthMaintenanceReceipt = {
  schema: "legacy-growth-maintenance-receipt-v1";
  operation: typeof LEGACY_GROWTH_MAINTENANCE_OPERATION;
  executionKey: string;
  subjectUserId: string;
  businessFingerprint: string;
  businessPackageSha256: string;
  coverageFingerprint: string;
  coverageExecutionKey: string;
  sourceReceiptDigest: string;
  coverageState: "COMPLETE" | "BACKFILL_PENDING";
  inserted: number;
  replayed: number;
  execution: { approvalRef: string; attempt: number };
};
export type LegacyGrowthMaintenanceRecovery =
  | { state: "FOUND"; receipt: LegacyGrowthMaintenanceReceipt }
  | { state: "NOT_FOUND" }
  | { state: "FINGERPRINT_MISMATCH" }
  | { state: "UNKNOWN"; code: string };

const HEX = /^[a-f0-9]{64}$/;
const EXEC_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: unknown, keys: readonly string[], name: string): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw invalid(`${name} has an invalid shape`);
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function validateContext(context: LegacyGrowthMaintenanceContext): void {
  if (!context || typeof context.executionKey !== "string" || !EXEC_KEY.test(context.executionKey) || typeof context.requestId !== "string" || !context.requestId.trim()) throw invalid("executionKey and requestId are required");
  const e = context.execution;
  if (!e || typeof e.actorAdminId !== "string" || !e.actorAdminId.trim() || typeof e.actorSessionId !== "string" || !e.actorSessionId.trim() || typeof e.approvalRef !== "string" || !REF.test(e.approvalRef) || !Number.isInteger(e.attempt) || e.attempt < 1 || typeof e.approvalDigest !== "string" || !HEX.test(e.approvalDigest)) throw invalid("Execution approval binding is required");
  if (!UTC.test(e.windowStartUtc ?? "") || !UTC.test(e.windowEndUtc ?? "") || !Number.isFinite(Date.parse(e.windowStartUtc)) || !Number.isFinite(Date.parse(e.windowEndUtc)) || Date.parse(e.windowEndUtc) <= Date.parse(e.windowStartUtc)) throw invalid("Execution window is invalid");
  const r = e.resource;
  if (!r || ![r.databaseName, r.databaseOid, r.owner, r.runtimeRole, r.markerKey, r.markerTarget].every((v) => typeof v === "string" && v.trim()) || !Number.isInteger(r.markerVersion)) throw invalid("Execution resource binding is incomplete");
}
function parsePackage(bytes: string | Buffer, approvedSha256: string): { text: string; sha256: string; value: LegacyGrowthMaintenancePackage } {
  const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  if (!Buffer.isBuffer(raw) || !HEX.test(approvedSha256)) throw invalid("Approved business package SHA is required");
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) throw invalid("Business package must be UTF-8");
  if (sha256Hex(text) !== approvedSha256) throw invalid("Approved business package SHA does not match the original bytes");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid("Business package must be JSON"); }
  exact(value, ["schema", "reason", "source"], "Business package");
  if (value.schema !== "legacy-growth-maintenance-package-v1" || typeof value.reason !== "string" || !value.reason.trim()) throw invalid("Business package schema and reason are required");
  exact(value.source, ["receipt", "inputs", "corrections", "admitted", "gameIdBySettlementId"], "Business source");
  const s = value.source;
  exact(s.admitted, ["receiptDigests", "componentDigests", "correctionDigests"], "Source admission");
  for (const v of Object.values(s.admitted)) if (!strings(v) || v.some((item) => !HEX.test(item)) || new Set(v).size !== v.length) throw invalid("Source admission digest sets are invalid");
  exact(s.receipt, ["subjectUserId", "cutoff", "fromExclusive", "sourceExtractSha256", "sourceSetSha256", "expectedSourceKeys", "refundReviewEvidenceRefs"], "Source receipt");
  const r = s.receipt;
  if (typeof r.subjectUserId !== "string" || !ID.test(r.subjectUserId) || typeof r.cutoff !== "string" || !(r.fromExclusive === null || typeof r.fromExclusive === "string") || typeof r.sourceExtractSha256 !== "string" || !HEX.test(r.sourceExtractSha256) || typeof r.sourceSetSha256 !== "string" || !HEX.test(r.sourceSetSha256) || !strings(r.expectedSourceKeys) || !strings(r.refundReviewEvidenceRefs)) throw invalid("Source receipt fields are invalid");
  if (!Array.isArray(s.inputs) || s.inputs.some((v) => !object(v) || !object(v.binding) || !object(v.origin) || typeof v.subjectUserId !== "string" || typeof v.recordedAt !== "string")) throw invalid("Original T source inputs are required");
  if (!Array.isArray(s.corrections) || s.corrections.some((v) => !object(v) || typeof v.baseSourceKey !== "string" || !object(v.proof) || typeof v.proof.canonical !== "string" || typeof v.proof.digest !== "string" || !HEX.test(v.proof.digest))) throw invalid("Original correction proofs are required");
  if (!object(s.gameIdBySettlementId) || Object.values(s.gameIdBySettlementId).some((v) => typeof v !== "string" || !ID.test(v))) throw invalid("Source game bindings are invalid");
  return { text, sha256: approvedSha256, value: value as unknown as LegacyGrowthMaintenancePackage };
}
function businessFingerprint(value: LegacyGrowthMaintenancePackage, packageSha256: string): string {
  return sha256Hex(canonicalize({ operation: LEGACY_GROWTH_MAINTENANCE_OPERATION, schema: "legacy-growth-maintenance-intent-v1", subjectUserId: value.source.receipt.subjectUserId, businessPackageSha256: packageSha256, reason: value.reason }));
}

/** Byte integrity is not approval. Only the approved two-file CLI may supply the independent SHA/admission authority. */
export function prepareLegacyGrowthMaintenanceInput(bytes: string | Buffer, approvedBusinessSha256: string, context: LegacyGrowthMaintenanceContext): LegacyGrowthMaintenanceInput {
  validateContext(context);
  const p = parsePackage(bytes, approvedBusinessSha256);
  return { ...context, businessPackageBytes: p.text, businessPackageSha256: p.sha256, subjectUserId: p.value.source.receipt.subjectUserId, reason: p.value.reason, businessFingerprint: businessFingerprint(p.value, p.sha256) };
}
function validated(input: LegacyGrowthMaintenanceInput): LegacyGrowthMaintenancePackage {
  validateContext(input);
  const p = parsePackage(input.businessPackageBytes, input.businessPackageSha256);
  if (input.subjectUserId !== p.value.source.receipt.subjectUserId || input.reason !== p.value.reason || input.businessFingerprint !== businessFingerprint(p.value, p.sha256)) throw invalid("Maintenance input does not match its original business bytes");
  return p.value;
}
/** Stable across new windows/sessions/request IDs and execution keys; the idempotency scope binds the current actor. */
export function legacyGrowthMaintenanceFingerprint(input: LegacyGrowthMaintenanceInput): string { return businessFingerprint(validated(input), input.businessPackageSha256); }
function sourcePackage(input: LegacyGrowthMaintenanceInput, value: LegacyGrowthMaintenancePackage): LegacyGrowthSourcePackage { return { ...value.source, packageDigest: input.businessPackageSha256 }; }
function project(input: LegacyGrowthMaintenanceInput, value: LegacyGrowthMaintenancePackage) {
  const prepared = prepareLegacyGrowthBackfill(sourcePackage(input, value));
  if (!prepared.ok) throw new SecurityApiError(prepared.code === "SOURCE_CONFLICT" ? 409 : 400, prepared.code === "SOURCE_CONFLICT" ? API_V1_ERROR_CODES.CONFLICT : API_V1_ERROR_CODES.INVALID_ARGUMENT, prepared.reason);
  return prepared;
}
async function authorize(client: PoolClient, input: LegacyGrowthMaintenanceInput, mode: "WRITE" | "READ"): Promise<void> {
  await authorizeCreditInitializationExecution(client, input.execution, mode);
  if (mode === "WRITE") {
    const identity = (await client.query<{ currentRole: string; tableOwner: string }>(
      `SELECT current_user AS "currentRole", pg_get_userbyid(c.relowner) AS "tableOwner" FROM pg_class c WHERE c.oid=to_regclass('zzsh_iam.membership_growth_legacy_coverage') /* legacy-growth-maintenance-owner */`,
    )).rows[0];
    if (!identity) unavailable();
    if (identity.currentRole !== identity.tableOwner) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Growth maintenance APPLY requires the approved coverage table owner client");
  }
}
function scope(input: LegacyGrowthMaintenanceInput): string { return JSON.stringify(["admin", input.execution.actorAdminId, LEGACY_GROWTH_MAINTENANCE_OPERATION, null]); }
function validRecord(record: LegacyCoverageRecord | null, subject: string, fingerprint: string): record is LegacyCoverageRecord {
  if (!record || record.subjectUserId !== subject || record.fingerprint !== fingerprint || !record.executionKey || !EXEC_KEY.test(record.executionKey)) return false;
  try { return verifyLegacyCoverageRecord(record); } catch { return false; }
}
function receiptValid(value: unknown, input: LegacyGrowthMaintenanceInput): value is LegacyGrowthMaintenanceReceipt {
  if (!object(value) || !object(value.execution)) return false;
  return value.schema === "legacy-growth-maintenance-receipt-v1" && value.operation === LEGACY_GROWTH_MAINTENANCE_OPERATION && value.executionKey === input.executionKey && value.subjectUserId === input.subjectUserId
    && value.businessFingerprint === input.businessFingerprint && value.businessPackageSha256 === input.businessPackageSha256 && typeof value.coverageFingerprint === "string" && HEX.test(value.coverageFingerprint)
    && typeof value.coverageExecutionKey === "string" && EXEC_KEY.test(value.coverageExecutionKey) && typeof value.sourceReceiptDigest === "string" && HEX.test(value.sourceReceiptDigest)
    && (value.coverageState === "COMPLETE" || value.coverageState === "BACKFILL_PENDING") && Number.isSafeInteger(value.inserted) && Number(value.inserted) >= 0 && Number.isSafeInteger(value.replayed) && Number(value.replayed) >= 0
    && typeof value.execution.approvalRef === "string" && REF.test(value.execution.approvalRef) && Number.isInteger(value.execution.attempt) && Number(value.execution.attempt) > 0;
}
function unavailable(): never { throw new SecurityApiError(503, API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE, "Stored legacy growth coverage cannot be verified"); }

/** Caller provides its READ ONLY transaction (the existing withReadOnlyTransaction helper); no receipt or audit is written. */
export async function previewLegacyGrowthMaintenance(client: PoolClient, input: LegacyGrowthMaintenanceInput, port: LegacyCoveragePort) {
  const value = validated(input);
  await authorize(client, input, "READ");
  const prepared = project(input, value), existing = await port.readByFingerprint(client, prepared.subjectUserId, prepared.fingerprint);
  if (existing && !validRecord(existing, prepared.subjectUserId, prepared.fingerprint)) unavailable();
  return { businessFingerprint: input.businessFingerprint, subjectUserId: input.subjectUserId, businessPackageSha256: input.businessPackageSha256, coverageFingerprint: prepared.fingerprint, sourceReceiptDigest: prepared.record.receiptDigest, coverageState: prepared.coverageState, contributionCount: prepared.rows.length, existingCoverageExecutionKey: existing?.executionKey ?? null };
}

/** Same actual client/transaction as the CLI's audit context and COMMIT. Returned success is tentative until outer COMMIT ACK. */
export async function applyLegacyGrowthMaintenance(client: PoolClient, input: LegacyGrowthMaintenanceInput, port: LegacyCoveragePort): Promise<{ replayed: boolean; receipt: LegacyGrowthMaintenanceReceipt }> {
  const value = validated(input);
  // withIdempotency reads/locks its receipt before its callback. Authorize before that read, and recheck after waiting.
  await authorize(client, input, "WRITE");
  const result = await withIdempotency(client, { realm: "admin", principalId: input.execution.actorAdminId, operation: LEGACY_GROWTH_MAINTENANCE_OPERATION }, input.executionKey, input.businessFingerprint,
    async () => { await authorize(client, input, "WRITE"); }, async () => {
      const prepared = project(input, value);
      await setAuditContext(client, "admin", input.execution.actorAdminId, input.execution.actorSessionId, input.requestId);
      await assertCreditInitializationWindowOpen(client, input.execution);
      const written = await writePreparedLegacyGrowth(client, prepared, port, input.executionKey);
      // A concurrent unique-fingerprint winner can have another key. Read the actual persisted row, never guess from written/request.
      const stored = await port.readByFingerprint(client, prepared.subjectUserId, prepared.fingerprint);
      if (!validRecord(stored, prepared.subjectUserId, prepared.fingerprint) || stored.receiptDigest !== prepared.record.receiptDigest) unavailable();
      await assertCreditInitializationWindowOpen(client, input.execution);
      const receipt: LegacyGrowthMaintenanceReceipt = { schema: "legacy-growth-maintenance-receipt-v1", operation: LEGACY_GROWTH_MAINTENANCE_OPERATION, executionKey: input.executionKey, subjectUserId: input.subjectUserId,
        businessFingerprint: input.businessFingerprint, businessPackageSha256: input.businessPackageSha256, coverageFingerprint: stored.fingerprint, coverageExecutionKey: stored.executionKey!, sourceReceiptDigest: stored.receiptDigest,
        coverageState: stored.coverageState, inserted: written.inserted, replayed: written.replayed, execution: { approvalRef: input.execution.approvalRef, attempt: input.execution.attempt } };
      await recordAudit(client, { actorType: "admin", actorId: input.execution.actorAdminId, sessionId: input.execution.actorSessionId, action: LEGACY_GROWTH_MAINTENANCE_OPERATION, objectType: "legacy_growth_maintenance", objectId: input.subjectUserId, outcome: "SUCCESS", requestId: input.requestId, reason: input.reason,
        details: { executionKey: receipt.executionKey, businessFingerprint: receipt.businessFingerprint, businessPackageSha256: receipt.businessPackageSha256, coverageFingerprint: receipt.coverageFingerprint, coverageExecutionKey: receipt.coverageExecutionKey, sourceReceiptDigest: receipt.sourceReceiptDigest, coverageState: receipt.coverageState, inserted: receipt.inserted, replayed: receipt.replayed, approvalRef: input.execution.approvalRef, attempt: input.execution.attempt, approvalDigest: input.execution.approvalDigest, databaseName: input.execution.resource.databaseName } });
      return { status: 200, body: receipt };
    });
  await assertCreditInitializationWindowOpen(client, input.execution);
  if (!receiptValid(result.body, input)) unavailable();
  return { replayed: result.replayed, receipt: result.body };
}

/** Current authorization -> exact actor/operation/key receipt -> trusted canonical coverage key -> exact fact recovery. */
export async function readLegacyGrowthMaintenanceReceipt(client: PoolClient, input: LegacyGrowthMaintenanceInput, port: LegacyCoveragePort): Promise<LegacyGrowthMaintenanceRecovery> {
  const value = validated(input);
  await authorize(client, input, "READ");
  const original = (await client.query<{ requestFingerprint: string; responseBody: unknown }>(
    `SELECT request_fingerprint AS "requestFingerprint", response_body AS "responseBody" FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2 /* legacy-growth-maintenance-recover */`, [scope(input), input.executionKey])).rows[0];
  if (!original) return { state: "NOT_FOUND" };
  if (original.requestFingerprint !== input.businessFingerprint) return { state: "FINGERPRINT_MISMATCH" };
  if (!receiptValid(original.responseBody, input)) return { state: "UNKNOWN", code: "ORIGINAL_RECEIPT_INVALID" };
  const receipt = original.responseBody;
  const prepared = prepareLegacyGrowthBackfill(sourcePackage(input, value));
  if (!prepared.ok || prepared.fingerprint !== receipt.coverageFingerprint || prepared.record.receiptDigest !== receipt.sourceReceiptDigest) return { state: "UNKNOWN", code: "ORIGINAL_SOURCE_UNCONFIRMED" };
  const stored = await port.readByFingerprint(client, input.subjectUserId, receipt.coverageFingerprint);
  if (!validRecord(stored, input.subjectUserId, receipt.coverageFingerprint) || stored.executionKey !== receipt.coverageExecutionKey || stored.receiptDigest !== receipt.sourceReceiptDigest || stored.coverageState !== receipt.coverageState) return { state: "UNKNOWN", code: "ORIGINAL_COVERAGE_UNCONFIRMED" };
  const recovered = await recoverLegacyGrowthBackfill(client, prepared, port, receipt.coverageExecutionKey);
  if (recovered.status !== "FOUND") return { state: "UNKNOWN", code: "ORIGINAL_FACTS_UNCONFIRMED" };
  await assertCreditInitializationWindowOpen(client, input.execution);
  return { state: "FOUND", receipt };
}
