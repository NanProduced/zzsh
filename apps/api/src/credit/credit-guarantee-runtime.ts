import type { Pool } from "pg";
import { businessFeatureEnabled, ConfigurationError } from "../config/config";
import { readEcsTestDemoRegistration, type DemoFinanceResource } from "../finance/ecs-test-demo-resource";

export const CREDIT_TABLES = [
  "zzsh_credit.user_credit_state", "zzsh_credit.credit_event", "zzsh_credit.credit_recovery_request",
  "zzsh_order.owner_guarantee_requirement", "zzsh_order.owner_guarantee_payment",
  "zzsh_order.owner_guarantee_refund", "zzsh_order.owner_guarantee_reconciliation",
] as const;

/** Command/registration/funding capability; pure reads do not depend on this switch. */
export function readCreditGuaranteeEnabled(env: NodeJS.ProcessEnv): boolean {
  return businessFeatureEnabled(env, "CREDIT_GUARANTEE_ENABLED");
}

/** Formal reads always require the reviewed schema and SELECT privileges. */
export async function preflightCreditGuarantee(pool: Pick<Pool, "query">, demo?: DemoFinanceResource): Promise<void> {
  try {
    const inventory = await pool.query<{name:string;present:boolean;readable:boolean}>(
      `SELECT name,to_regclass(name) IS NOT NULL AS present,
        COALESCE(has_table_privilege(current_user,to_regclass(name),'SELECT'),false) AS readable
       FROM unnest($1::text[]) AS t(name)`, [CREDIT_TABLES]);
    if (inventory.rows.length !== CREDIT_TABLES.length || inventory.rows.some(row => !row.present || !row.readable)) throw new Error("credit tables unavailable");
    const contract = await pool.query<{version:number;schemaCreate:boolean}>(
      `SELECT zzsh_credit.runtime_contract_version() AS version,
        has_schema_privilege(current_user,'zzsh_credit','CREATE') AS "schemaCreate"`);
    if (contract.rows[0]?.version !== 1 || contract.rows[0].schemaCreate) throw new Error("credit contract/role mismatch");
    // A copied demo database cannot turn synthetic receipts into real guarantee coverage.
    const digest = demo ? readEcsTestDemoRegistration(demo).digest : null;
    const scope = await pool.query<{ mismatch: boolean; waiverReady: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM zzsh_order.owner_guarantee_payment WHERE original_receipt->>'source'='ECS_DEMO_GUARANTEE'
        AND ($1::text IS NULL OR original_receipt->>'registrationDigest' IS DISTINCT FROM $1)
      UNION ALL SELECT 1 FROM zzsh_order.owner_guarantee_refund WHERE original_receipt->>'source'='ECS_DEMO_GUARANTEE'
        AND ($1::text IS NULL OR original_receipt->>'registrationDigest' IS DISTINCT FROM $1)
    ) AS mismatch,
      (SELECT count(*)=2 FROM pg_attribute a WHERE a.attrelid=to_regclass('zzsh_supply.listing_publication')
        AND a.attnum>0 AND NOT a.attisdropped AND a.attname IN ('credit_guarantee_waived','credit_guarantee_waived_revision')
        AND has_column_privilege(current_user,a.attrelid,a.attname,'SELECT') AND has_column_privilege(current_user,a.attrelid,a.attname,'INSERT'))
      AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('zzsh_supply.listing_publication')
        AND c.conname='listing_publication_credit_guarantee_waiver_shape' AND c.convalidated
        AND position('credit_guarantee_waived' IN pg_get_constraintdef(c.oid))>0
        AND position('credit_guarantee_waived_revision' IN pg_get_constraintdef(c.oid))>0) AS "waiverReady"`, [digest]);
    if (scope.rows[0]?.mismatch !== false || scope.rows[0]?.waiverReady !== true) throw new Error("guarantee publication or demo evidence is unavailable");
  } catch {
    throw new ConfigurationError("Credit/guarantee reads require reviewed schema or runtime privileges");
  }
}
