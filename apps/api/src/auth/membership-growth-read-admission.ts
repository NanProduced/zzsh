import type { PoolClient } from "pg";
import { SecurityApiError } from "./security-core";

const OPERATION = "membership.growth.legacy.backfill";
export const LEGACY_ZERO_READ_CONTRACT = "LEGACY_NO_SOURCE_ZERO_V1";
export const LEGACY_ZERO_READ_TABLE = "zzsh_iam.membership_growth_legacy_read_admission";

// These are the persisted formal-maintenance identities, not a new way to declare growth from HTTP.
export const LEGACY_ZERO_RECEIPT_MATCH_SQL = `
  i.response_status=200 AND NOT i.publish_required
  AND i.request_fingerprint=a.business_fingerprint
  AND i.response_body->>'schema'='legacy-growth-maintenance-receipt-v1'
  AND i.response_body->>'operation'='${OPERATION}'
  AND i.response_body->>'executionKey'=a.execution_key
  AND i.response_body->>'subjectUserId'=a.subject_user_id
  AND i.response_body->>'businessFingerprint'=a.business_fingerprint
  AND i.response_body->>'businessPackageSha256'=a.business_package_sha256
  AND i.response_body->>'coverageFingerprint'=a.coverage_fingerprint
  AND i.response_body->>'coverageExecutionKey'=c.execution_key
  AND i.response_body->>'sourceReceiptDigest'=a.source_receipt_digest
  AND i.response_body->>'coverageState'='COMPLETE'
  AND jsonb_typeof(i.response_body->'inserted')='number' AND i.response_body->>'inserted'='0'
  AND jsonb_typeof(i.response_body->'replayed')='number' AND i.response_body->>'replayed'='0'
  AND i.response_body#>>'{execution,approvalRef}'=a.approval_ref
  AND jsonb_typeof(i.response_body#>'{execution,attempt}')='number'
  AND i.response_body#>>'{execution,attempt}'=a.approval_attempt::text
  AND e.actor_type='admin' AND e.actor_id=a.actor_admin_id
  AND e.action='${OPERATION}' AND e.object_type='legacy_growth_maintenance'
  AND e.object_id=a.subject_user_id AND e.outcome='SUCCESS'
  AND e.details->>'executionKey'=a.execution_key
  AND e.details->>'businessFingerprint'=a.business_fingerprint
  AND e.details->>'businessPackageSha256'=a.business_package_sha256
  AND e.details->>'coverageFingerprint'=a.coverage_fingerprint
  AND e.details->>'coverageExecutionKey'=c.execution_key
  AND e.details->>'sourceReceiptDigest'=a.source_receipt_digest
  AND e.details->>'coverageState'='COMPLETE'
  AND e.details->>'inserted'='0' AND e.details->>'replayed'='0'
  AND e.details->>'approvalRef'=a.approval_ref AND e.details->>'attempt'=a.approval_attempt::text`;

export const LEGACY_ZERO_ELIGIBLE_SQL = `WITH blocked_subjects AS MATERIALIZED (
  SELECT user_id AS subject_user_id FROM zzsh_iam.membership_growth_contribution
  UNION SELECT user_id FROM zzsh_iam.membership_growth_state
  UNION SELECT renter_user_id FROM zzsh_order.rental_order
  UNION SELECT renter_user_id FROM zzsh_order.legacy_order_read_snapshot
  UNION SELECT subject_user_id FROM zzsh_iam.membership_growth_legacy_coverage
    WHERE cutoff<=$1::timestamptz GROUP BY subject_user_id HAVING count(*)>1
)
SELECT /* legacy-growth-zero-read-admissions */ a.subject_user_id AS "userId"
  FROM ${LEGACY_ZERO_READ_TABLE} a
  JOIN zzsh_iam.membership_growth_legacy_coverage c ON c.id=a.coverage_id
 WHERE a.validation_contract='${LEGACY_ZERO_READ_CONTRACT}'
   AND c.coverage_state='COMPLETE' AND c.from_exclusive IS NULL AND c.cutoff<=$1::timestamptz
   AND CASE WHEN c.subject_user_id=a.subject_user_id AND c.record_digest=a.record_digest
     AND c.fingerprint=a.coverage_fingerprint AND c.receipt_digest=a.source_receipt_digest AND c.cutoff=a.cutoff
     THEN true ELSE false END
   AND NOT EXISTS(SELECT 1 FROM blocked_subjects b WHERE b.subject_user_id=c.subject_user_id)`;

export type LegacyZeroReadAdmission = Readonly<{ kind: typeof LEGACY_ZERO_READ_CONTRACT }>;
const admissions = new WeakMap<LegacyZeroReadAdmission, { client: PoolClient; asOf: string; ids: readonly string[]; subjects: Set<string> }>();
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Legacy zero read admission is unavailable");

/** Only the current RR client can obtain this opaque authority; a caller-supplied snapshot flag is never sufficient. */
export async function readLegacyZeroReadAdmission(client: PoolClient, asOf: string): Promise<LegacyZeroReadAdmission | null> {
  const installed = (await client.query<{ present: boolean; readOnly: string; isolation: string }>(`SELECT /* legacy-growth-zero-read-schema */ to_regclass('${LEGACY_ZERO_READ_TABLE}') IS NOT NULL AS present,current_setting('transaction_read_only') AS "readOnly",current_setting('transaction_isolation') AS isolation`)).rows[0];
  if (!installed || typeof installed.present !== "boolean") throw unavailable();
  if (!installed.present) return null;
  if (installed.readOnly !== "on" || installed.isolation !== "repeatable read" || client.getTransactionStatus?.() !== "T") throw unavailable();
  const rows = (await client.query<{ userId: string }>(LEGACY_ZERO_ELIGIBLE_SQL, [asOf])).rows;
  const ids = rows.map(row => row.userId);
  if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw unavailable();
  const admission = Object.freeze({ kind: LEGACY_ZERO_READ_CONTRACT });
  admissions.set(admission, { client, asOf, ids: Object.freeze(ids), subjects: new Set(ids) });
  return admission;
}

export function legacyZeroReadSubjectIds(admission: LegacyZeroReadAdmission | null | undefined, client: PoolClient, asOf: string): readonly string[] {
  const value = admission && admissions.get(admission);
  return value && value.client === client && value.asOf === asOf ? value.ids : [];
}

export function hasLegacyZeroReadAdmission(admission: LegacyZeroReadAdmission | null | undefined, client: PoolClient, asOf: string, userId: string): boolean {
  const value = admission && admissions.get(admission);
  return Boolean(value && value.client === client && value.asOf === asOf && value.subjects.has(userId));
}

export function closeLegacyZeroReadAdmission(admission: LegacyZeroReadAdmission | null): void { if (admission) admissions.delete(admission); }
