import type { Pool } from "pg";
import { ConfigurationError } from "../config/config";

export const CREDIT_TABLES = [
  "zzsh_credit.user_credit_state", "zzsh_credit.credit_event", "zzsh_credit.credit_recovery_request",
  "zzsh_order.owner_guarantee_requirement", "zzsh_order.owner_guarantee_payment",
  "zzsh_order.owner_guarantee_refund", "zzsh_order.owner_guarantee_reconciliation",
] as const;

/** A deployment switch, independent of fake/real payment providers. */
export function readCreditGuaranteeEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.CREDIT_GUARANTEE_ENABLED ?? "false";
  if (value !== "true" && value !== "false") throw new ConfigurationError("CREDIT_GUARANTEE_ENABLED must be true or false");
  return value === "true";
}

/** No credit metadata/table query at all when the capability is not deployed. */
export async function preflightCreditGuarantee(pool: Pick<Pool, "query">, enabled: boolean): Promise<void> {
  if (!enabled) return;
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
  } catch {
    throw new ConfigurationError("Credit/guarantee enabled but reviewed schema or runtime privileges are unavailable");
  }
}
