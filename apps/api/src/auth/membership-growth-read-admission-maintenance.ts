import type { PoolClient } from "pg";
import { canonicalize } from "../supply/content-hash";
import { sha256Hex } from "../supply/supply-util";
import { SecurityApiError } from "./security-core";
import { legacyGrowthMaintenanceFingerprint, LEGACY_GROWTH_MAINTENANCE_OPERATION, type LegacyGrowthMaintenanceInput, type LegacyGrowthMaintenanceReceipt } from "./membership-growth-legacy-maintenance";
import { prepareLegacyGrowthBackfill, parseVerifiedLegacyCoverageRecord } from "./membership-growth-legacy";
import { LEGACY_ZERO_READ_CONTRACT, LEGACY_ZERO_READ_TABLE, LEGACY_ZERO_RECEIPT_MATCH_SQL } from "./membership-growth-read-admission";

export type LegacyZeroReadAdmissionEntry = {
  coverageId: string; subjectUserId: string; recordDigest: string; coverageFingerprint: string; sourceReceiptDigest: string; cutoff: string;
  actorAdminId: string; scopeKey: string; executionKey: string; businessFingerprint: string; businessPackageSha256: string; approvalRef: string; approvalAttempt: number;
};
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Original verified zero source admission is unavailable");

/** Reproduce the full original planner before producing a narrow, owner-only declaration; never sign from a COMPLETE flag. */
export function prepareLegacyZeroReadAdmission(input: LegacyGrowthMaintenanceInput, receipt: LegacyGrowthMaintenanceReceipt): LegacyZeroReadAdmissionEntry {
  const fingerprint = legacyGrowthMaintenanceFingerprint(input), business = JSON.parse(input.businessPackageBytes);
  const prepared = prepareLegacyGrowthBackfill({ ...business.source, packageDigest: input.businessPackageSha256 });
  if (!prepared.ok || prepared.coverageState !== "COMPLETE" || prepared.rows.length || business.source.inputs.length || business.source.corrections.length || business.source.receipt.expectedSourceKeys.length || business.source.receipt.fromExclusive !== null) throw unavailable();
  if (receipt.schema !== "legacy-growth-maintenance-receipt-v1" || receipt.operation !== LEGACY_GROWTH_MAINTENANCE_OPERATION || receipt.subjectUserId !== input.subjectUserId || receipt.executionKey !== input.executionKey || receipt.businessFingerprint !== fingerprint || receipt.businessPackageSha256 !== input.businessPackageSha256 || receipt.coverageFingerprint !== prepared.fingerprint || receipt.sourceReceiptDigest !== prepared.record.receiptDigest || receipt.coverageState !== "COMPLETE" || receipt.inserted !== 0 || receipt.replayed !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(receipt.coverageExecutionKey) || !receipt.execution?.approvalRef || !Number.isSafeInteger(receipt.execution.attempt) || receipt.execution.attempt < 1) throw unavailable();
  const canonical = canonicalize({ ...prepared.record, executionKey: receipt.coverageExecutionKey }), recordDigest = sha256Hex(canonical);
  if (!parseVerifiedLegacyCoverageRecord(canonical, recordDigest)) throw unavailable();
  return { coverageId: "growth_coverage_" + sha256Hex(canonicalize([input.subjectUserId, prepared.fingerprint])).slice(0, 48), subjectUserId: input.subjectUserId, recordDigest, coverageFingerprint: prepared.fingerprint, sourceReceiptDigest: prepared.record.receiptDigest, cutoff: prepared.record.cutoff, actorAdminId: input.execution.actorAdminId, scopeKey: JSON.stringify(["admin", input.execution.actorAdminId, LEGACY_GROWTH_MAINTENANCE_OPERATION, null]), executionKey: input.executionKey, businessFingerprint: fingerprint, businessPackageSha256: input.businessPackageSha256, approvalRef: receipt.execution.approvalRef, approvalAttempt: receipt.execution.attempt };
}

const INPUT_COLUMNS = `"coverageId" text,"subjectUserId" text,"recordDigest" text,"coverageFingerprint" text,"sourceReceiptDigest" text,cutoff text,"actorAdminId" text,"scopeKey" text,"executionKey" text,"businessFingerprint" text,"businessPackageSha256" text,"approvalRef" text,"approvalAttempt" integer`;
const READ_COLUMNS = `coverage_id AS "coverageId",subject_user_id AS "subjectUserId",record_digest AS "recordDigest",coverage_fingerprint AS "coverageFingerprint",source_receipt_digest AS "sourceReceiptDigest",to_char(cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff,actor_admin_id AS "actorAdminId",scope_key AS "scopeKey",execution_key AS "executionKey",business_fingerprint AS "businessFingerprint",business_package_sha256 AS "businessPackageSha256",approval_ref AS "approvalRef",approval_attempt AS "approvalAttempt",admission_batch_digest AS "batchDigest"`;

/** Root owns the approved transaction/COMMIT and UNKNOWN recovery; this helper opens no connection or transaction. */
export async function recoverLegacyZeroReadAdmissionBatch(client: PoolClient, entries: readonly LegacyZeroReadAdmissionEntry[], batchDigest: string): Promise<{ found: number; missing: string[] }> {
  validateBatch(entries, batchDigest);
  const rows = (await client.query<LegacyZeroReadAdmissionEntry & { batchDigest: string }>(`SELECT ${READ_COLUMNS} FROM ${LEGACY_ZERO_READ_TABLE} WHERE coverage_id=ANY($1::text[])`, [entries.map(entry => entry.coverageId)])).rows;
  const expected = new Map(entries.map(entry => [entry.coverageId, entry])), found = new Set<string>();
  for (const row of rows) {
    const entry = expected.get(row.coverageId);
    if (!entry || found.has(row.coverageId) || row.batchDigest !== batchDigest || Object.entries(entry).some(([key, value]) => row[key as keyof LegacyZeroReadAdmissionEntry] !== value)) throw unavailable();
    found.add(row.coverageId);
  }
  return { found: found.size, missing: entries.filter(entry => !found.has(entry.coverageId)).map(entry => entry.coverageId) };
}

function validateBatch(entries: readonly LegacyZeroReadAdmissionEntry[], batchDigest: string): void {
  if (!/^[a-f0-9]{64}$/.test(batchDigest) || entries.length < 1 || entries.length > 500 || new Set(entries.map(entry => entry.coverageId)).size !== entries.length || new Set(entries.map(entry => entry.subjectUserId)).size !== entries.length) throw unavailable();
}

export async function insertLegacyZeroReadAdmissionBatch(client: PoolClient, entries: readonly LegacyZeroReadAdmissionEntry[], batchDigest: string): Promise<{ matched: number; inserted: number }> {
  validateBatch(entries, batchDigest);
  const identity = (await client.query<{ currentRole: string; owner: string; coverageOwner: string }>(`SELECT /* legacy-zero-read-maintenance-owner */ current_user AS "currentRole",pg_get_userbyid(a.relowner) AS owner,pg_get_userbyid(c.relowner) AS "coverageOwner" FROM pg_class a,pg_class c WHERE a.oid='${LEGACY_ZERO_READ_TABLE}'::regclass AND c.oid='zzsh_iam.membership_growth_legacy_coverage'::regclass`)).rows[0];
  if (!identity || identity.currentRole !== identity.owner || identity.currentRole !== identity.coverageOwner) throw new SecurityApiError(403, "FORBIDDEN", "Read admission requires the coverage maintenance owner");
  let match = LEGACY_ZERO_RECEIPT_MATCH_SQL.replaceAll("a.", "x.");
  for (const [column, field] of Object.entries({ business_fingerprint: "businessFingerprint", execution_key: "executionKey", subject_user_id: "subjectUserId", business_package_sha256: "businessPackageSha256", coverage_fingerprint: "coverageFingerprint", source_receipt_digest: "sourceReceiptDigest", actor_admin_id: "actorAdminId", approval_ref: "approvalRef", approval_attempt: "approvalAttempt" })) match = match.replaceAll(`x.${column}`, `x."${field}"`);
  const result = await client.query(`WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(${INPUT_COLUMNS})), matched AS (
    SELECT x.*,e.id AS "auditId",count(*) OVER(PARTITION BY x."coverageId") AS witnesses
      FROM input x JOIN zzsh_iam.membership_growth_legacy_coverage c ON c.id=x."coverageId" AND c.subject_user_id=x."subjectUserId" AND c.record_digest=x."recordDigest" AND c.fingerprint=x."coverageFingerprint" AND c.receipt_digest=x."sourceReceiptDigest" AND c.cutoff=x.cutoff::timestamptz
      JOIN zzsh_supply.idempotency_record i ON i.scope_key=x."scopeKey" AND i.key=x."executionKey"
      JOIN zzsh_iam.audit_event e ON e.object_id=x."subjectUserId" AND e.action='${LEGACY_GROWTH_MAINTENANCE_OPERATION}'
     WHERE ${match}
  ) INSERT INTO ${LEGACY_ZERO_READ_TABLE}(coverage_id,subject_user_id,record_digest,coverage_fingerprint,source_receipt_digest,cutoff,validation_contract,actor_admin_id,scope_key,execution_key,business_fingerprint,business_package_sha256,success_audit_id,approval_ref,approval_attempt,admission_batch_digest)
    SELECT "coverageId","subjectUserId","recordDigest","coverageFingerprint","sourceReceiptDigest",cutoff::timestamptz,'${LEGACY_ZERO_READ_CONTRACT}',"actorAdminId","scopeKey","executionKey","businessFingerprint","businessPackageSha256","auditId","approvalRef","approvalAttempt",$2
      FROM matched WHERE witnesses=1 ON CONFLICT(coverage_id) DO NOTHING RETURNING coverage_id`, [JSON.stringify(entries), batchDigest]);
  const checked = await recoverLegacyZeroReadAdmissionBatch(client, entries, batchDigest);
  if (checked.missing.length) throw unavailable();
  return { matched: checked.found, inserted: result.rowCount ?? 0 };
}
