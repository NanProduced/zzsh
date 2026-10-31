import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Pool, PoolClient } from "pg";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const BUSINESS_SCHEMAS = ["zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin", "zzsh_supply", "zzsh_content", "zzsh_order"] as const;

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error("runtime database user must be a safe identifier");
  return `"${value}"`;
}

export const BUSINESS_MIGRATIONS_FOLDER = resolve(__dirname, "../../../migrations/business");
export const BUSINESS_MIGRATION_CONFIG = {
  migrationsFolder: BUSINESS_MIGRATIONS_FOLDER,
  migrationsSchema: "zzsh_business_meta",
  migrationsTable: "migrations",
} as const;

/** Schema migrations have already committed; this outcome describes the separate ACL transaction only. */
export class BusinessMigrationAclError extends Error {
  constructor(
    readonly outcome: "ACL_NOT_COMMITTED" | "ACL_COMMIT_UNKNOWN",
    readonly rollbackAcknowledged: boolean,
    readonly cause: unknown,
    readonly rollbackError?: unknown,
  ) {
    super(outcome === "ACL_COMMIT_UNKNOWN"
      ? "Business schema migrations committed; runtime ACL COMMIT outcome is UNKNOWN; inspect privileges before retrying"
      : "Business schema migrations committed; runtime ACL transaction was not committed");
    this.name = "BusinessMigrationAclError";
  }
}

export class BusinessMigrationHistoryError extends Error {
  constructor(readonly reason: "INVALID_LOCAL_CHAIN" | "HISTORY_UNAVAILABLE" | "NOT_EXACT_PREFIX", readonly index?: number) {
    super(`Business migration preflight rejected: ${reason}${index === undefined ? "" : ` at index ${index}`}`);
    this.name = "BusinessMigrationHistoryError";
  }
}

/** Drizzle checks only the newest timestamp; a divergent journal needs reviewed adoption. */
export async function assertBusinessMigrationPrefix(pool: Pick<Pool, "query">, migrationsFolder = BUSINESS_MIGRATIONS_FOLDER): Promise<void> {
  const local = readMigrationFiles({ migrationsFolder });
  if (!local.length || local.some((m, i) => !Number.isSafeInteger(m.folderMillis) || m.folderMillis <= 0 ||
    i > 0 && m.folderMillis <= local[i - 1]!.folderMillis)) throw new BusinessMigrationHistoryError("INVALID_LOCAL_CHAIN");
  const present = (await pool.query("SELECT to_regclass('zzsh_business_meta.migrations') IS NOT NULL AS present")).rows[0]?.present;
  if (typeof present !== "boolean") throw new BusinessMigrationHistoryError("HISTORY_UNAVAILABLE");
  if (!present) return;
  const history = (await pool.query<{ hash: string; createdAt: string }>(
    'SELECT hash,created_at::text AS "createdAt" FROM zzsh_business_meta.migrations ORDER BY id',
  )).rows;
  if (history.length > local.length) throw new BusinessMigrationHistoryError("NOT_EXACT_PREFIX", local.length);
  for (const [index, row] of history.entries()) {
    if (row.hash !== local[index]!.hash || row.createdAt !== String(local[index]!.folderMillis)) {
      throw new BusinessMigrationHistoryError("NOT_EXACT_PREFIX", index);
    }
  }
}

export async function runBusinessMigrations(pool: Pool, options: { runtimeUser: string; migrationsFolder?: string }): Promise<void> {
  await assertBusinessMigrationPrefix(pool, options.migrationsFolder);
  await migrate(drizzle(pool), { ...BUSINESS_MIGRATION_CONFIG, ...(options.migrationsFolder ? { migrationsFolder: options.migrationsFolder } : {}) });
  // Drizzle owns its migration transaction; all subsequent broad and narrow grants share this client.
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch (error) { throw new BusinessMigrationAclError("ACL_NOT_COMMITTED", false, error); }
  let commitSent = false;
  let broken = false;
  try {
    await client.query("BEGIN");
    await applyRuntimePrivileges(client, options.runtimeUser);
    commitSent = true;
    await client.query("COMMIT");
  } catch (error) {
    if (commitSent) { broken = true; throw new BusinessMigrationAclError("ACL_COMMIT_UNKNOWN", false, error); }
    let rolledBack = false;
    let rollbackError: unknown;
    try { await client.query("ROLLBACK"); rolledBack = true; }
    catch (failure) { broken = true; rollbackError = failure; }
    throw new BusinessMigrationAclError("ACL_NOT_COMMITTED", rolledBack, error, rollbackError);
  } finally {
    client.release(broken ? true : undefined);
  }
}

/** Exact same post-migration ACL path; a reviewed rollback harness may own its transaction. */
export async function applyRuntimePrivileges(pool: Pick<Pool, "query">, runtimeRole: string): Promise<void> {
  const runtimeUser = quoteIdentifier(runtimeRole);
  for (const schema of BUSINESS_SCHEMAS) {
    const schemaIdentifier = quoteIdentifier(schema);
    await pool.query(`GRANT USAGE ON SCHEMA ${schemaIdentifier} TO ${runtimeUser}`);
  }
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "zzsh_auth_user", "zzsh_auth_admin" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."audit_event" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON TABLE "zzsh_iam"."user_risk_flag" TO ${runtimeUser};
    REVOKE ALL ON TABLE "zzsh_iam"."user_note" FROM ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON TABLE "zzsh_iam"."user_note" TO ${runtimeUser};
    REVOKE ALL ON TABLE "zzsh_iam"."user_registration_fact" FROM ${runtimeUser};
    GRANT SELECT ON TABLE "zzsh_iam"."user_registration_fact" TO ${runtimeUser};
    REVOKE ALL ON TABLE "zzsh_iam"."user_identity_display_source" FROM ${runtimeUser};
    GRANT SELECT ON TABLE "zzsh_iam"."user_identity_display_source" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "zzsh_iam"."admin_security" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "zzsh_iam"."admin_recovery_request" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON TABLE "zzsh_iam"."admin_security_notification_outbox" TO ${runtimeUser};
    GRANT SELECT ON TABLE "zzsh_iam"."admin_recovery_notification_target" TO ${runtimeUser};
    GRANT SELECT ON TABLE "zzsh_iam"."admin_permission" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON TABLE "zzsh_iam"."admin_role" TO ${runtimeUser};
    GRANT SELECT, INSERT, DELETE ON TABLE "zzsh_iam"."admin_role_permission" TO ${runtimeUser};
    GRANT SELECT, INSERT, DELETE ON TABLE "zzsh_iam"."admin_user_role" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "zzsh_iam"."admin_user_permission" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON TABLE "zzsh_iam"."approval_template" TO ${runtimeUser};
    GRANT SELECT, INSERT, DELETE ON TABLE "zzsh_iam"."approval_template_candidate" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."approval_request" TO ${runtimeUser};
    GRANT UPDATE ("status", "status_reason", "decided_at", "decided_by", "decision_reason", "superseded_by_request_id") ON TABLE "zzsh_iam"."approval_request" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."approval_request_candidate" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."approval_decision" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."approval_execution" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON TABLE "zzsh_iam"."user_identity_state" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."im_identity_mapping" TO ${runtimeUser};
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."im_identity_mapping" FROM ${runtimeUser};
    GRANT UPDATE ("status", "version", "attempt_count", "attempt_lease_until", "attempt_lease_token_hash", "next_retry_at", "last_failure_class", "last_failure_provider_code", "updated_at") ON TABLE "zzsh_iam"."im_identity_mapping" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."im_support_presence" TO ${runtimeUser};
    REVOKE DELETE, TRUNCATE ON TABLE "zzsh_iam"."im_support_presence" FROM ${runtimeUser};
    REVOKE UPDATE ON TABLE "zzsh_iam"."im_support_presence" FROM ${runtimeUser};
    GRANT UPDATE ("availability", "connection_state", "last_connected_at", "active_load", "version", "updated_at", "last_order_assigned_at", "last_consultation_assigned_at") ON TABLE "zzsh_iam"."im_support_presence" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."im_consultation" TO ${runtimeUser};
    REVOKE DELETE, TRUNCATE ON TABLE "zzsh_iam"."im_consultation" FROM ${runtimeUser};
    REVOKE UPDATE ON TABLE "zzsh_iam"."im_consultation" FROM ${runtimeUser};
    GRANT UPDATE ("state", "peer_account_id", "assigned_admin_id", "version", "last_message_at", "updated_at", "message_scope_id", "message_scope_state", "message_scope_version") ON TABLE "zzsh_iam"."im_consultation" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."im_consultation_scope_operation" TO ${runtimeUser};
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."im_consultation_scope_operation" FROM ${runtimeUser};
    GRANT UPDATE ("state", "provider_team_id", "attempt_count", "next_retry_at", "lease_until", "lease_token_hash", "last_failure_class", "last_failure_detail", "updated_at") ON TABLE "zzsh_iam"."im_consultation_scope_operation" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."im_consultation_event" TO ${runtimeUser};
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."im_consultation_event" FROM ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON TABLE "zzsh_iam"."admin_workspace_layout" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "zzsh_supply" TO ${runtimeUser};
    REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA "zzsh_supply" FROM ${runtimeUser};
    -- ADM-SCOPE-1: the account-level scope writer replaces selected games, so it
    -- needs DELETE on the scope table only; every other supply table stays append/update only.
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "zzsh_supply"."admin_supply_scope" TO ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "zzsh_content" TO ${runtimeUser};
    REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA "zzsh_content" FROM ${runtimeUser};
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "zzsh_order" TO ${runtimeUser};
    REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA "zzsh_order" FROM ${runtimeUser};
    REVOKE UPDATE ON TABLE zzsh_order.payment_confirmation, zzsh_order.im_order_group FROM ${runtimeUser};
    GRANT UPDATE (provision_state,assigned_admin_id,assigned_at,version,wait_reason) ON zzsh_order.im_order_group TO ${runtimeUser};
    GRANT UPDATE (team_state,system_identity_id,team_name,members_limit,team_id,team_ready_at,team_failure,team_retry_at) ON zzsh_order.im_order_group TO ${runtimeUser};
    REVOKE UPDATE ON zzsh_order.im_order_member,zzsh_order.im_order_operation FROM ${runtimeUser};
    GRANT UPDATE (state,joined_at) ON zzsh_order.im_order_member TO ${runtimeUser};
    GRANT UPDATE (state,version,attempt_count,next_retry_at,lease_until,lease_token_hash,sent_at,candidate_team_id,failure_class,updated_at) ON zzsh_order.im_order_operation TO ${runtimeUser};
    GRANT DELETE ON TABLE "zzsh_supply"."price_line", "zzsh_supply"."term_option" TO ${runtimeUser};
    GRANT DELETE ON TABLE zzsh_supply.favorite TO ${runtimeUser};
    REVOKE UPDATE ON TABLE zzsh_supply.favorite FROM ${runtimeUser};
    GRANT DELETE ON TABLE zzsh_supply.inventory_line,zzsh_supply.listing_skin,zzsh_supply.listing_entitlement,zzsh_supply.listing_media TO ${runtimeUser};
    REVOKE UPDATE,DELETE,TRUNCATE ON TABLE zzsh_supply.rule_acceptance,zzsh_supply.review_decision,zzsh_supply.duplicate_hint,zzsh_supply.legacy_supply_map FROM ${runtimeUser};
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_supply"."rule_release" FROM ${runtimeUser};
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."audit_event" FROM ${runtimeUser};
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."admin_permission" FROM ${runtimeUser};
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."approval_request_candidate", "zzsh_iam"."approval_decision", "zzsh_iam"."approval_execution" FROM ${runtimeUser};
    REVOKE DELETE, TRUNCATE ON TABLE "zzsh_iam"."user_identity_state" FROM ${runtimeUser};
  `);
  await configureSkinIdentityPrivileges(pool, runtimeRole);
  const fundingValidators = [
    "zzsh_supply.valid_funding_policy_legacy_v1(jsonb)",
    "zzsh_supply.valid_funding_policy_draft(jsonb)",
  ];
  const fundingFunctions = (await pool.query("SELECT name,to_regprocedure(name) IS NOT NULL AS present FROM unnest($1::text[]) AS f(name)", [fundingValidators])).rows;
  if (fundingFunctions.length !== 2 || fundingFunctions.some(row => typeof row.present !== "boolean")) throw new Error("Funding validator inventory is incomplete");
  if (fundingFunctions.some(row => row.present)) {
    if (fundingFunctions.some(row => !row.present)) throw new Error("Funding validator schema is incomplete; runtime privileges not finalized");
    await pool.query(`GRANT EXECUTE ON FUNCTION zzsh_supply.valid_funding_policy_legacy_v1(jsonb),
      zzsh_supply.valid_funding_policy_draft(jsonb), zzsh_supply.valid_funding_policy(jsonb) TO ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.full_payout_terms_version') AS relation`)).rows[0]?.relation) {
    await pool.query(`REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON zzsh_supply.full_payout_terms_version FROM ${runtimeUser};
      GRANT INSERT(id,game_id,policy_ref,policy_version,disclosure_version,title,body,digest,created_by_admin_id) ON zzsh_supply.full_payout_terms_version TO ${runtimeUser};
      GRANT UPDATE(title,body,disclosure_version,digest,status,revision,updated_at,sealed_by_admin_id,sealed_at) ON zzsh_supply.full_payout_terms_version TO ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_content.legal_document_version') AS relation`)).rows[0]?.relation) {
    await resetRuntimeTablePrivileges(pool, "zzsh_content.legal_document_version", "PUBLIC", { select: false });
    await resetRuntimeTablePrivileges(pool, "zzsh_content.legal_document_version", runtimeUser);
    await pool.query(`GRANT INSERT(id,doc_type,title,body,digest,effective_at,created_by_admin_id) ON zzsh_content.legal_document_version TO ${runtimeUser};
      GRANT UPDATE(title,body,digest,status,revision,effective_at,updated_at,sealed_by_admin_id,sealed_at) ON zzsh_content.legal_document_version TO ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_content.document_acceptance') AS relation`)).rows[0]?.relation) {
    await resetRuntimeTablePrivileges(pool, "zzsh_content.document_acceptance", "PUBLIC", { select: false });
    await resetRuntimeTablePrivileges(pool, "zzsh_content.document_acceptance", runtimeUser);
    await pool.query(`GRANT INSERT(id,user_id,document_type,document_version_id,document_digest,subject_type,subject_id,source,request_id) ON zzsh_content.document_acceptance TO ${runtimeUser}`);
  }
  await pool.query(`GRANT USAGE, SELECT ON SEQUENCE "zzsh_iam"."admin_login_number_seq" TO ${runtimeUser}`);
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.listing_filter_config') AS relation`)).rows[0]?.relation) {
    await pool.query(`GRANT SELECT,INSERT ON zzsh_supply.listing_filter_config TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_supply.listing_filter_config FROM ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.legacy_listing_read_snapshot') AS relation`)).rows[0]?.relation) {
    await pool.query(`GRANT SELECT,INSERT ON zzsh_supply.legacy_listing_read_snapshot TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_supply.legacy_listing_read_snapshot FROM ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.legacy_listing_display_snapshot') AS relation`)).rows[0]?.relation) {
    await pool.query(`REVOKE ALL ON zzsh_supply.legacy_listing_display_snapshot FROM PUBLIC; GRANT SELECT,INSERT ON zzsh_supply.legacy_listing_display_snapshot TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON zzsh_supply.legacy_listing_display_snapshot FROM ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.legacy_skin_holding') AS relation`)).rows[0]?.relation) {
    await pool.query(`REVOKE ALL ON zzsh_supply.legacy_skin_holding FROM PUBLIC; GRANT SELECT,INSERT ON zzsh_supply.legacy_skin_holding TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON zzsh_supply.legacy_skin_holding FROM ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_order.legacy_order_read_snapshot') AS relation`)).rows[0]?.relation) {
    await pool.query(`GRANT SELECT,INSERT ON zzsh_order.legacy_order_read_snapshot TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_order.legacy_order_read_snapshot FROM ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.listing_publication') AS relation`)).rows[0]?.relation) {
    await pool.query(`REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_supply.listing_publication FROM ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.account_guarantee_proof') AS relation`)).rows[0]?.relation) {
    await pool.query(`GRANT SELECT,INSERT ON zzsh_supply.account_guarantee_proof TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_supply.account_guarantee_proof FROM ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_iam.user_rental_membership') AS relation`)).rows[0]?.relation) {
    await pool.query(`GRANT SELECT,INSERT ON zzsh_iam.user_rental_membership TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_iam.user_rental_membership FROM ${runtimeUser}; GRANT UPDATE (tier,version,source_ref,updated_by_admin_id) ON zzsh_iam.user_rental_membership TO ${runtimeUser}`);
  }
  // OIM-4B facts arrive with 0043; the runtime role writes the first-response pointer
  // and appends delivery/approval evidence with status-only updates.
  if ((await pool.query(`SELECT to_regclass('zzsh_order.im_order_event') AS relation`)).rows[0]?.relation) {
    await pool.query(`GRANT UPDATE (first_response_event_id,first_response_at,first_response_state) ON zzsh_order.im_order_group TO ${runtimeUser};
      GRANT SELECT, INSERT, UPDATE ON TABLE zzsh_order.im_order_event TO ${runtimeUser};
      REVOKE DELETE, TRUNCATE ON TABLE zzsh_order.im_order_event FROM ${runtimeUser};
      REVOKE UPDATE ON TABLE zzsh_order.im_order_event FROM ${runtimeUser};
      GRANT UPDATE (status) ON TABLE zzsh_order.im_order_event TO ${runtimeUser};`);
  }
  const hasEscalationColumns=(await pool.query(`SELECT count(*)=5 AS ready FROM pg_attribute
    WHERE attrelid=to_regclass('zzsh_order.im_order_group') AND attname=ANY($1::text[]) AND NOT attisdropped`,
    [["responsible_admin_id","remind_due_at","next_add_due_at","add_round","escalation_state"]])).rows[0]?.ready;
  if(hasEscalationColumns)await pool.query(`GRANT UPDATE (responsible_admin_id,remind_due_at,next_add_due_at,add_round,escalation_state)
    ON zzsh_order.im_order_group TO ${runtimeUser}`);
  await pool.query(`GRANT USAGE, SELECT ON SEQUENCE "zzsh_order"."display_no_seq" TO ${runtimeUser}`);
  if ((await pool.query(`SELECT to_regprocedure('zzsh_supply.next_dated_account_display_no()') AS allocator`)).rows[0]?.allocator) {
    await pool.query(`REVOKE ALL ON TABLE zzsh_supply.account_display_no_counter FROM ${runtimeUser};
      REVOKE ALL (business_date,last_value) ON TABLE zzsh_supply.account_display_no_counter FROM ${runtimeUser};
      GRANT EXECUTE ON FUNCTION zzsh_supply.next_dated_account_display_no() TO ${runtimeUser};
      REVOKE ALL ON FUNCTION zzsh_supply.next_account_display_no() FROM ${runtimeUser};
      REVOKE ALL ON SEQUENCE zzsh_supply.account_display_no_seq FROM ${runtimeUser}`);
  } else if ((await pool.query(`SELECT to_regprocedure('zzsh_supply.next_account_display_no()') AS allocator`)).rows[0]?.allocator) {
    await pool.query(`GRANT USAGE, SELECT ON SEQUENCE zzsh_supply.account_display_no_seq TO ${runtimeUser}; GRANT EXECUTE ON FUNCTION zzsh_supply.next_account_display_no() TO ${runtimeUser}`);
  }
  const throttleTables = (await pool.query(`SELECT to_regclass('zzsh_iam.admin_auth_failure') AS failures,
    to_regclass('zzsh_iam.admin_auth_lockout') AS locks, to_regclass('zzsh_iam.admin_auth_captcha_used') AS proofs`)).rows[0];
  if (throttleTables && Object.values(throttleTables).some(Boolean)) {
    if (!throttleTables.failures || !throttleTables.locks || !throttleTables.proofs) throw new Error("Admin throttle schema is incomplete");
    await pool.query(`GRANT SELECT, INSERT, DELETE ON TABLE zzsh_iam.admin_auth_failure TO ${runtimeUser};
      GRANT USAGE ON SEQUENCE zzsh_iam.admin_auth_failure_id_seq TO ${runtimeUser};
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE zzsh_iam.admin_auth_lockout TO ${runtimeUser};
      GRANT SELECT, INSERT, DELETE ON TABLE zzsh_iam.admin_auth_captcha_used TO ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regprocedure('zzsh_iam.purge_admin_audit_events(integer,text,text,text,boolean)') AS fn`)).rows[0]?.fn) {
    // 0120：运行时角色无 audit_event DELETE，只能经 Boss 复核的清理函数删除 admin.*/auth.* 历史审计。
    await pool.query(`GRANT EXECUTE ON FUNCTION zzsh_iam.purge_admin_audit_events(integer,text,text,text,boolean) TO ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_order.rental_opening') AS relation`)).rows[0]?.relation) {
    await pool.query(`REVOKE UPDATE, DELETE, TRUNCATE ON zzsh_order.rental_opening, zzsh_order.rental_opening_ack, zzsh_order.settlement_version, zzsh_order.settlement_decision FROM ${runtimeUser};
      GRANT UPDATE (status, confirmed_at) ON zzsh_order.rental_opening TO ${runtimeUser};
      GRANT UPDATE (superseded_at) ON zzsh_order.settlement_version TO ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_order.settlement_intake') AS relation`)).rows[0]?.relation) {
    await pool.query(`REVOKE UPDATE, DELETE, TRUNCATE ON zzsh_order.settlement_intake FROM ${runtimeUser};
      GRANT UPDATE (status, classified_at, superseded_at, settlement_version_id) ON zzsh_order.settlement_intake TO ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_order.settlement_posting') AS relation`)).rows[0]?.relation) {
    await pool.query(`REVOKE UPDATE, DELETE, TRUNCATE ON zzsh_order.settlement_posting, zzsh_order.settlement_ledger_entry FROM ${runtimeUser};
      GRANT SELECT, INSERT ON zzsh_order.settlement_posting, zzsh_order.settlement_ledger_entry TO ${runtimeUser}`);
  }
  for (const schema of ["zzsh_auth_user", "zzsh_auth_admin"] as const) {
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeUser}`);
  }
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_iam" GRANT SELECT, INSERT ON TABLES TO ${runtimeUser}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_supply" GRANT SELECT, INSERT, UPDATE ON TABLES TO ${runtimeUser}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_content" GRANT SELECT, INSERT, UPDATE ON TABLES TO ${runtimeUser}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_order" GRANT SELECT, INSERT, UPDATE ON TABLES TO ${runtimeUser}`);
  if ((await pool.query(`SELECT to_regclass('zzsh_order.finance_opening_basis') AS relation`)).rows[0]?.relation) {
    await pool.query(`
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE zzsh_order.finance_opening_basis, zzsh_order.finance_covered_event,
        zzsh_order.finance_economic_root, zzsh_order.finance_event, zzsh_order.wallet_coverage, zzsh_order.wallet_revision,
        zzsh_order.finance_observation_admission, zzsh_order.personal_finance_observation, zzsh_iam.personal_finance_read_scope FROM ${runtimeUser};
      GRANT SELECT ON TABLE zzsh_order.finance_opening_basis, zzsh_order.finance_covered_event, zzsh_order.finance_economic_root,
        zzsh_order.finance_event, zzsh_order.wallet_coverage, zzsh_order.wallet_revision, zzsh_order.finance_observation_admission,
        zzsh_order.personal_finance_observation, zzsh_iam.personal_finance_read_scope TO ${runtimeUser};`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_order.withdrawal_intent') AS relation`)).rows[0]?.relation) {
    await pool.query(`
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE zzsh_order.withdrawal_admission, zzsh_order.withdrawal_destination,
        zzsh_order.withdrawal_intent, zzsh_order.withdrawal_provider_fact, zzsh_order.controlled_payout_operation FROM ${runtimeUser};
      GRANT SELECT ON TABLE zzsh_order.withdrawal_admission, zzsh_order.withdrawal_destination, zzsh_order.withdrawal_intent,
        zzsh_order.withdrawal_provider_fact, zzsh_order.controlled_payout_operation TO ${runtimeUser};
      GRANT INSERT(id,user_id,admission_id,destination_id,destination_revision,mode,policy_version,input_digest,gross_cents,net_cents,fee_cents,
        expected_ledger_revision,accepted_at,payout_key,economic_root_id,state,operation_version,funds_disposition) ON zzsh_order.withdrawal_intent TO ${runtimeUser};
      GRANT UPDATE(state,operation_version,funds_disposition,terminal,conflict_digest,lease_token_hash,lease_until,last_provider_fact_id) ON zzsh_order.withdrawal_intent TO ${runtimeUser};
      GRANT INSERT(id,intent_id,payout_key,mode,result_key,evidence_canonical,evidence_digest,producer_lease_hash) ON zzsh_order.withdrawal_provider_fact TO ${runtimeUser};
      GRANT INSERT(id,intent_id,payout_key,mode,scenario,final_evidence_canonical,final_evidence_digest,original_lease_hash) ON zzsh_order.controlled_payout_operation TO ${runtimeUser};
      GRANT INSERT(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest) ON zzsh_order.finance_economic_root TO ${runtimeUser};
      GRANT INSERT(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) ON zzsh_order.finance_event TO ${runtimeUser};`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_order.controlled_payout_notice') AS relation`)).rows[0]?.relation) {
    await pool.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON zzsh_order.controlled_payout_notice FROM ${runtimeUser}; GRANT SELECT ON zzsh_order.controlled_payout_notice TO ${runtimeUser};`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_order.distribution_policy_version') AS relation`)).rows[0]?.relation) {
    await pool.query(`
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON zzsh_order.distribution_policy_version, zzsh_order.distribution_policy_head,
        zzsh_order.distribution_participant, zzsh_order.distribution_invite_code, zzsh_order.invitation_relation FROM ${runtimeUser};
      GRANT SELECT ON zzsh_order.distribution_policy_version, zzsh_order.distribution_policy_head,
        zzsh_order.distribution_participant, zzsh_order.distribution_invite_code, zzsh_order.invitation_relation TO ${runtimeUser};
      GRANT INSERT(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id)
        ON zzsh_order.distribution_policy_version TO ${runtimeUser};
      GRANT INSERT(scope,revision,current_version_id), UPDATE(revision,current_version_id)
        ON zzsh_order.distribution_policy_head TO ${runtimeUser};
      GRANT INSERT(user_id,eligibility,commission_frozen,level_code,policy_version_id,revision,inviter_knowledge,leader_knowledge,invitees_knowledge,source_type,source_ref,source_digest)
        ON zzsh_order.distribution_participant TO ${runtimeUser};
      GRANT UPDATE(leader_knowledge,revision) ON zzsh_order.distribution_participant TO ${runtimeUser};
      GRANT INSERT(id,user_id,display_code,source_type,source_system,source_entity,source_id,source_digest)
        ON zzsh_order.distribution_invite_code TO ${runtimeUser};
      GRANT INSERT(id,type,child_user_id,parent_user_id,policy_version_id,source_type,source_ref,source_digest)
        ON zzsh_order.invitation_relation TO ${runtimeUser};`);
  }

  const nativeOrigin=(await pool.query("SELECT to_regclass('zzsh_order.native_user_insert_proof') IS NOT NULL AS proof,to_regprocedure('zzsh_order.initialize_native_wallet_origin(text,text,text,text)') IS NOT NULL AS initializer")).rows[0];
  if((nativeOrigin?.proof===true)!==(nativeOrigin?.initializer===true))throw new Error('Native wallet origin schema is incomplete');
  if(nativeOrigin?.proof===true)await pool.query(`REVOKE ALL ON TABLE zzsh_order.native_user_insert_proof FROM ${runtimeUser};
    GRANT SELECT ON TABLE zzsh_order.native_user_insert_proof TO ${runtimeUser};
    GRANT EXECUTE ON FUNCTION zzsh_order.initialize_native_wallet_origin(text,text,text,text) TO ${runtimeUser};`);
  // Admission rows are provisioning facts: the runtime never reads or writes them directly.
  const nativeAdmission=(await pool.query("SELECT to_regclass('zzsh_order.native_origin_resource_admission') IS NOT NULL AS present")).rows[0];
  if(nativeAdmission?.present===true)await pool.query(`REVOKE ALL ON TABLE zzsh_order.native_origin_resource_admission FROM ${runtimeUser};`);
  await configureAdminSecurityCommandPrivileges(pool, runtimeRole);
  await configureMembershipGrowthPrivileges(pool, runtimeRole);
  await configureLegacyGrowthCoveragePrivileges(pool, runtimeRole);
  // The marker is present only after the separately approved uniform-policy schema installation.
  if ((await pool.query("SELECT to_regprocedure('zzsh_order.distribution_policy_contract_version()') IS NOT NULL AS present")).rows[0]?.present === true)
    await pool.query(`GRANT EXECUTE ON FUNCTION zzsh_order.distribution_policy_contract_version() TO ${runtimeUser};`);
  await configureDistributionFinancialPrivileges(pool, runtimeRole);
  await configureCreditGuaranteePrivileges(pool, runtimeRole);
  await configureContinuityFinancePrivileges(pool, runtimeRole);
  await configureChannelRefundPrivileges(pool, runtimeRole);
  await configureJoinpayFinancialPrivileges(pool, runtimeRole);
}

/** Optional schema (ADM-SECURITY-BACKEND-1): command identity rows never need UPDATE/DELETE;
 *  backup-code generation is one row per admin whose UPSERT needs three specific columns only. */
export async function configureAdminSecurityCommandPrivileges(pool: Pick<Pool, "query">, runtimeRole: string): Promise<void> {
  const role = quoteIdentifier(runtimeRole);
  const tables = ["zzsh_iam.admin_security_command", "zzsh_iam.admin_backup_code_generation"];
  const found = (await pool.query("SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)", [tables])).rows;
  if (found.length !== tables.length) throw new Error("Security command schema inventory is incomplete");
  if (found.every(row => row.present === false)) return;
  if (found.some(row => row.present !== true)) throw new Error("Security command schema is partially deployed");
  await pool.query(`
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."admin_security_command" FROM ${role};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."admin_security_command" TO ${role};
    REVOKE DELETE, TRUNCATE ON TABLE "zzsh_iam"."admin_backup_code_generation" FROM ${role};
    REVOKE UPDATE ON TABLE "zzsh_iam"."admin_backup_code_generation" FROM ${role};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."admin_backup_code_generation" TO ${role};
    GRANT UPDATE ("generation", "generation_id", "generated_at") ON TABLE "zzsh_iam"."admin_backup_code_generation" TO ${role};
  `);
}

/** Kept separate so prefix migration and least-privilege branches can be checked offline. */
export async function configureSkinIdentityPrivileges(pool: Pick<Pool, "query">, runtimeUser: string): Promise<void> {
  const role = quoteIdentifier(runtimeUser);
  const columns = (await pool.query(`SELECT count(*)::int AS count FROM pg_attribute
    WHERE attrelid=to_regclass('zzsh_supply.skin') AND NOT attisdropped AND attname=ANY($1::text[])`,
    [["owner_kind","owner_id","firearm_id","base_name","aliases","source_namespace","naming_state"]])).rows[0]?.count;
  const owner = (await pool.query(`SELECT to_regclass('zzsh_supply.skin_owner') IS NOT NULL AS present`)).rows[0]?.present;
  const metadataCount = (await pool.query(`SELECT count(*)::int AS count FROM pg_attribute
    WHERE attrelid=to_regclass('zzsh_supply.skin') AND NOT attisdropped AND attname=ANY($1::text[])`,
    [["rarity_evidence","is_collectible","default_state","media_source"]])).rows[0]?.count;
  if (metadataCount !== 0 && metadataCount !== 4) throw new Error("Skin metadata schema is incomplete; runtime privileges not finalized");
  if (columns === 0 && !owner && metadataCount === 0) return;
  if (columns !== 7 || !owner) throw new Error("Skin identity schema is incomplete; runtime privileges not finalized");
  const metadataColumns = metadataCount === 4 ? ",rarity_evidence,is_collectible,default_state,media_source" : "";
  await pool.query(`
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON zzsh_supply.skin FROM ${role};
    GRANT SELECT ON zzsh_supply.skin TO ${role};
    GRANT INSERT (id,game_id,code,name,category_id,rarity_code,enabled,form_visible,media_id,sort_order,source_namespace,source_field,source_token,aliases${metadataColumns}) ON zzsh_supply.skin TO ${role};
    GRANT UPDATE (name,category_id,rarity_code,enabled,form_visible,media_id,sort_order,source_namespace,source_field,source_token,aliases,owner_kind,owner_id,firearm_id,base_name${metadataColumns}) ON zzsh_supply.skin TO ${role};
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON zzsh_supply.skin_owner FROM ${role};
    GRANT SELECT ON zzsh_supply.skin_owner TO ${role};
    GRANT INSERT (id,game_id,kind,code,name,enabled) ON zzsh_supply.skin_owner TO ${role};
    GRANT UPDATE (enabled,updated_at) ON zzsh_supply.skin_owner TO ${role};
  `);
}

/** Re-converge after every broad order grant, including repeated standard migrations. */
export async function configureDistributionFinancialPrivileges(pool: Pick<Pool, "query">, runtimeRole: string): Promise<void> {
  const role = quoteIdentifier(runtimeRole);
  const names = ["distribution_order_admission", "payment_distribution_basis", "controlled_payment_declaration",
    "rental_referral_earning", "rental_referral_reversal_source", "rental_referral_transition"].map(name => `zzsh_order.${name}`);
  const found = (await pool.query("SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)", [names])).rows;
  if (found.length !== names.length) throw new Error("Financial schema inventory is incomplete");
  if (found.every(row => row.present === false)) return;
  if (found.some(row => row.present !== true)) throw new Error("Financial schema is incomplete; runtime privileges not finalized");
  for (const table of names) {
    await resetRuntimeTablePrivileges(pool, table, role);
  }
  await pool.query(`
    GRANT INSERT(id,order_id,payment_confirmation_id,admission_id,admission_revision,canonical_basis,basis_digest)
      ON zzsh_order.payment_distribution_basis TO ${role};
    GRANT INSERT(id,economic_root_id,economic_key,order_id,payment_confirmation_id,posting_id,beneficiary_user_id,
      beneficiary_role,amount_cents,due_at,basis_digest,posting_digest,canonical_seed,seed_digest,state,funds_disposition,version)
      ON zzsh_order.rental_referral_earning TO ${role};
    GRANT UPDATE(state,funds_disposition,recovery_required_cents,version) ON zzsh_order.rental_referral_earning TO ${role};
    GRANT INSERT(id,earning_id,action,expected_version,result_version,finance_event_id,reversal_source_id,source_digest)
      ON zzsh_order.rental_referral_transition TO ${role};
    REVOKE ALL ON FUNCTION zzsh_order.canonical_finance_json(jsonb,integer),zzsh_order.derive_payment_referral_inputs(text),
      zzsh_order.earning_expected_lines(text),zzsh_order.guard_distribution_order_admission(),zzsh_order.guard_payment_distribution_basis(),
      zzsh_order.check_payment_distribution_basis_pair(),zzsh_order.guard_controlled_payment_declaration(),zzsh_order.guard_native_earning_root(),
      zzsh_order.guard_rental_referral_earning(),zzsh_order.guard_earning_event(),zzsh_order.guard_earning_entry(),zzsh_order.check_earning_batch(),
      zzsh_order.guard_referral_transition_source(),zzsh_order.guard_referral_reversal_declaration(),zzsh_order.check_earning_reverse_closure(),
      zzsh_order.referral_debt_read_revision(),zzsh_order.guard_withdrawal_referral_recovery() FROM ${role};
    GRANT EXECUTE ON FUNCTION zzsh_order.canonical_finance_json(jsonb,integer),zzsh_order.derive_payment_referral_inputs(text),
      zzsh_order.earning_expected_lines(text) TO ${role};
  `);
}

/** Optional schema: no-op on the old prefix; fail on partial deployment. */
export async function configureCreditGuaranteePrivileges(pool: Pick<Pool, "query">, runtimeRole: string): Promise<void> {
  const role = quoteIdentifier(runtimeRole);
  const tables = ["zzsh_credit.user_credit_state", "zzsh_credit.credit_event", "zzsh_credit.credit_recovery_request",
    "zzsh_order.owner_guarantee_requirement", "zzsh_order.owner_guarantee_payment", "zzsh_order.owner_guarantee_refund", "zzsh_order.owner_guarantee_reconciliation"];
  const found = (await pool.query("SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)", [tables])).rows;
  if (found.length !== tables.length) throw new Error("Credit schema inventory is incomplete");
  if (found.every(row => row.present === false)) return;
  if (found.some(row => row.present !== true)) throw new Error("Credit schema is partially deployed");
  await pool.query(`GRANT USAGE ON SCHEMA zzsh_credit TO ${role}; REVOKE CREATE ON SCHEMA zzsh_credit FROM ${role}`);
  for (const table of tables) {
    const columns = (await pool.query("SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum", [table])).rows;
    if (!columns.length) throw new Error("Credit table columns unavailable");
    const list = columns.map(row => quoteIdentifier(row.attname)).join(",");
    await pool.query(`REVOKE ALL ON TABLE ${table} FROM ${role};
      REVOKE SELECT (${list}), INSERT (${list}), UPDATE (${list}), REFERENCES (${list}) ON TABLE ${table} FROM ${role};
      GRANT SELECT ON TABLE ${table} TO ${role}`);
  }
  await pool.query(`
    GRANT INSERT(user_id,score,revision), UPDATE(score,revision,updated_at) ON zzsh_credit.user_credit_state TO ${role};
    GRANT INSERT(id,user_id,event_key,event_type,source_type,source_id,subject_role,delta_score,applied_delta_score,score_before,score_after,visible_reason,internal_basis,actor_admin_id,reversal_of_id,payload_hash) ON zzsh_credit.credit_event TO ${role};
    GRANT INSERT(id,user_id,request_key,request_fingerprint,reason,status,eligibility_snapshot,score_before,completed_orders), UPDATE(status,decision,decision_fingerprint,decision_reason,decided_by,event_id,decided_at) ON zzsh_credit.credit_recovery_request TO ${role};
    GRANT INSERT(id,owner_user_id,account_id,game_id,listing_version_id,price_version_id,rule_release_id,policy_version,base_cents,required_cents,score_snapshot,status), UPDATE(status,updated_at) ON zzsh_order.owner_guarantee_requirement TO ${role};
    GRANT INSERT(id,requirement_id,owner_user_id,request_key,request_fingerprint,merchant_order_no,provider,provider_request_state,amount_cents,status), UPDATE(status,provider_request_state,provider_transaction_id,observed_amount_cents,original_receipt,source_digest,finance_event_id,ledger_entry_ref,updated_at) ON zzsh_order.owner_guarantee_payment TO ${role};
    GRANT INSERT(id,requirement_id,payment_id,owner_user_id,request_key,request_fingerprint,provider,provider_request_state,amount_cents,status,release_policy_state), UPDATE(status,provider_request_state,provider_refund_id,original_receipt,source_digest,finance_event_id,ledger_entry_ref,release_policy_state,release_decision_reason,release_decision_fingerprint,release_decided_by,release_decided_at,updated_at) ON zzsh_order.owner_guarantee_refund TO ${role};
    GRANT INSERT(id,payment_id,refund_id,observed_state,observed_amount_cents,provider_reference,canonical_payload,payload_digest) ON zzsh_order.owner_guarantee_reconciliation TO ${role};
    REVOKE ALL ON FUNCTION zzsh_credit.guard_credit_state_update(),zzsh_credit.guard_credit_event_insert(),zzsh_order.guard_guarantee_root(),zzsh_order.guard_guarantee_event(),zzsh_order.guard_guarantee_entry(),zzsh_order.check_guarantee_batch() FROM ${role};
    GRANT EXECUTE ON FUNCTION zzsh_credit.runtime_contract_version() TO ${role};
  `);
}

async function resetRuntimeTablePrivileges(pool: Pick<Pool, "query">, table: string, role: string, options: { columns?: readonly string[]; select?: boolean } = {}): Promise<void> {
    const columns = options.columns ?? (await pool.query("SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum", [table])).rows.map(row => row.attname as string);
    if (!columns.length) throw new Error("Table columns are unavailable");
    const list = columns.map(quoteIdentifier).join(",");
    // Table revocation alone does not clear an old explicit column grant.
    await pool.query(`REVOKE ALL ON TABLE ${table} FROM ${role};
      REVOKE SELECT (${list}), INSERT (${list}), UPDATE (${list}), REFERENCES (${list}) ON TABLE ${table} FROM ${role};
      ${options.select === false ? "" : `GRANT SELECT ON TABLE ${table} TO ${role}`}`);
}

/** Optional membership schema; immutable policy/contribution rows never need runtime UPDATE. */
export async function configureMembershipGrowthPrivileges(pool: Pick<Pool, "query">, runtimeRole: string): Promise<void> {
  const role = quoteIdentifier(runtimeRole);
  const names = ["membership_growth_policy", "membership_growth_contribution", "membership_growth_state", "membership_entitlement"].map(name => "zzsh_iam." + name);
  const found = (await pool.query("SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)", [names])).rows;
  if (found.length !== names.length) throw new Error("Membership schema inventory is incomplete");
  if (found.every(row => row.present === false)) return;
  if (found.some(row => row.present !== true)) throw new Error("Membership schema is incomplete; runtime privileges not finalized");
  for (const table of names) await resetRuntimeTablePrivileges(pool, table, role);
  await pool.query(`
    GRANT INSERT(id,version,status,effective_at,rule_release_id,price_version_id,source_ref,policy_schema,policy_payload,payload_hash,approval_request_id,approved_by_admin_id)
      ON zzsh_iam.membership_growth_policy TO ${role};
    GRANT INSERT(id,user_id,game_id,source_key,source_type,source_id,settlement_version,revision,effective_at,recorded_at,amount_cents,previous_amount_cents,correction_of_source_key,correction_mode,state,eligible,source_digest)
      ON zzsh_iam.membership_growth_contribution TO ${role};
    GRANT INSERT(id,user_id,game_id,kind,scope_key,starts_at,ends_at,pricing_schema,pricing_payload,price_version_id,cost_basis_ref,deposit_waived,deposit_allowance_cents,approved_policy_id,approval_request_id,approved_payload_hash,status)
      ON zzsh_iam.membership_entitlement TO ${role};
    GRANT UPDATE(status,revoked_reason,replaced_by_id,updated_at) ON zzsh_iam.membership_entitlement TO ${role};
  `);
}

/** The source coverage is owner-maintained; runtime only reads, including after inherited column grants. */
export async function configureLegacyGrowthCoveragePrivileges(pool: Pick<Pool, "query">, runtimeRole: string): Promise<void> {
  const name = "zzsh_iam.membership_growth_legacy_coverage", role = quoteIdentifier(runtimeRole);
  const found = (await pool.query<{ name: string; present: boolean }>("SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)", [[name]])).rows;
  if (found.length !== 1 || found[0]?.name !== name || typeof found[0].present !== "boolean") throw new Error("Legacy growth coverage inventory is incomplete");
  if (!found[0].present) return;
  await resetRuntimeTablePrivileges(pool, name, role);
  await pool.query(`REVOKE ALL ON FUNCTION zzsh_iam.guard_legacy_growth_coverage() FROM ${role}`);
}

/** New continuity tables are narrowed after all broad/default grants. Exact role comes from migration config. */
export async function configureContinuityFinancePrivileges(pool: Pick<Pool, "query">, runtimeRole: string): Promise<void> {
  const role = quoteIdentifier(runtimeRole);
  const profiles: { name: string; read: boolean; insert?: string[]; update?: string[] }[] = [
    {"name":"zzsh_order.legacy_continuation_evidence","read":true,"insert":["id","order_id","evidence_version","source_kind","derived_from_command_version_id","source_as_of","evidence_ref","source_digest","parameter_digest","admission","reasons","facts","facts_canonical","facts_digest"]},
    {"name":"zzsh_order.legacy_continuation_version","read":true,"insert":["id","order_id","revision","command","actor","input_evidence_id","result_evidence_id","stage","is_settle","is_advance_set","amounts","commission_revisions","assignments","plan_fingerprint","created_at"],"update":["superseded_at"]},
    {"name":"zzsh_order.legacy_order_duty","read":true,"insert":["id","order_id","continuation_version_id","kind","source_record_id","counterparty_user_id","amount_cents","currency","status","source","source_status","level","ratio","maturity_at","source_digest"],"update":["amount_cents","maturity_at","revision","revised_at","revised_by","revision_reason","status","decided_at","decided_by","decision_reason","decision_evidence_ref"]},
    {"name":"zzsh_order.legacy_order_duty_revision","read":true,"insert":["id","duty_id","revision","before_values","after_values","actor","source_command_version_id","reason"]},
    {"name":"zzsh_order.legacy_order_duty_admission","read":true},
    {"name":"zzsh_order.legacy_inflight_register","read":true},
    {"name":"zzsh_order.personal_finance_observation_coverage","read":true},
    {"name":"zzsh_order.finance_stored_opening_review","read":false},
    {"name":"zzsh_order.legacy_duty_finance_contract","read":false},
    {"name":"zzsh_order.legacy_duty_finance_fact","read":true},
    {"name":"zzsh_order.legacy_owner_guarantee_observation","read":true},
    {"name":"zzsh_order.legacy_owner_guarantee_coverage","read":true}
  ];
  const found = (await pool.query<{ name: string; present: boolean }>(
    "SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)", [profiles.map(p => p.name)]
  )).rows;
  if (found.length !== profiles.length || new Set(found.map(r => r.name)).size !== profiles.length
    || found.some(r => typeof r.present !== "boolean" || !profiles.some(p => p.name === r.name))) throw new Error("Continuity schema inventory is incomplete");
  const v4 = (await pool.query(`SELECT to_regprocedure('zzsh_order.assert_personal_growth_order_v4(zzsh_order.rental_order)') IS NOT NULL AS present,
    to_regprocedure('zzsh_order.legacy_opening_source_proof(text)') IS NOT NULL AS proof_present,
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.finance_stored_opening_review')
      WHERE p.oid=to_regprocedure('zzsh_order.legacy_opening_source_proof(text)') AND p.proowner=c.relowner AND p.prosecdef
       AND p.proconfig=ARRAY['search_path=pg_catalog'] AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid
        AND t.tgname='stored_opening_source_proof_guard' AND t.tgenabled='O' AND NOT t.tgisinternal)) AS proof_ready`)).rows[0];
  if (typeof v4?.present !== "boolean") throw new Error("Continuity helper inventory is incomplete");
  if(v4.proof_present===true&&v4.proof_ready!==true)throw new Error('Legacy source proof helper is partially deployed');
  if (found.every(r => !r.present) && !v4.present&&v4.proof_present!==true) return;
  const identity = (await pool.query<{ roleOid: string; superuser: boolean; ownerRights: boolean }>(`
    /* continuity runtime role ownership */
    SELECT r.oid::text AS "roleOid",r.rolsuper AS superuser,
      EXISTS(SELECT 1 FROM (
        SELECT c.relowner AS owner_id FROM pg_class c
         WHERE c.oid IN(SELECT to_regclass(name) FROM unnest($2::text[]) AS t(name))
        UNION SELECT p.proowner FROM pg_proc p
         WHERE p.oid IN(to_regprocedure('zzsh_order.assert_personal_growth_order_v4(zzsh_order.rental_order)'),to_regprocedure('zzsh_order.legacy_opening_source_proof(text)'))
      ) owners WHERE owners.owner_id=r.oid OR pg_has_role(r.oid,owners.owner_id,'MEMBER')) AS "ownerRights"
    FROM pg_roles r WHERE r.rolname=$1
  `, [runtimeRole, profiles.map(p => p.name)])).rows[0];
  if (!identity || typeof identity.roleOid !== "string" || !/^[1-9]\d*$/.test(identity.roleOid) || identity.superuser !== false || identity.ownerRights !== false) {
    throw new Error("Continuity runtime role must be a known non-owner non-superuser");
  }
  for (const profile of profiles) {
    if (!found.find(r => r.name === profile.name)?.present) continue;
    const table = profile.name.split(".").map(quoteIdentifier).join(".");
    const columns = (await pool.query<{ name: string }>(
      "SELECT attname AS name FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped ORDER BY attnum", [profile.name]
    )).rows.map(r => r.name);
    if (!columns.length || [...(profile.insert ?? []), ...(profile.update ?? [])].some(c => !columns.includes(c))) throw new Error("Continuity column inventory differs");
    const allColumns = columns.map(quoteIdentifier).join(",");
    const statements = [
      `REVOKE ALL ON TABLE ${table} FROM ${role}`,
      `REVOKE ALL (${allColumns}) ON TABLE ${table} FROM ${role}`,
      // PUBLIC grants are inherited even after the runtime role loses its direct grants.
      `REVOKE ALL ON TABLE ${table} FROM PUBLIC`,
      `REVOKE ALL (${allColumns}) ON TABLE ${table} FROM PUBLIC`,
    ];
    if (profile.read) statements.push(`GRANT SELECT ON TABLE ${table} TO ${role}`);
    if (profile.insert?.length) statements.push(`GRANT INSERT (${profile.insert.map(quoteIdentifier).join(",")}) ON TABLE ${table} TO ${role}`);
    if (profile.update?.length) statements.push(`GRANT UPDATE (${profile.update.map(quoteIdentifier).join(",")}) ON TABLE ${table} TO ${role}`);
    await pool.query(statements.join(";\n") + ";");
  }
  if (v4.present) {
    await pool.query(`GRANT EXECUTE ON FUNCTION zzsh_order.assert_personal_growth_order_v4(zzsh_order.rental_order) TO ${role}`);
  }
  if(v4.proof_present===true)await pool.query(`REVOKE ALL ON FUNCTION zzsh_order.legacy_opening_source_proof(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION zzsh_order.legacy_opening_source_proof(text) TO ${role}`);
}

/** 退款可选表在宽授权之后重新收窄；调用方保有原ACL事务，不在旧前缀创建对象。 */
export async function configureChannelRefundPrivileges(pool: Pick<Pool, "query">, runtimeRole: string): Promise<void> {
  const role = quoteIdentifier(runtimeRole);
  const names = ["zzsh_order.channel_refund_intent", "zzsh_order.channel_refund_observation"];
  const found = (await pool.query<{ name: string; present: boolean }>(
    "SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)", [names]
  )).rows;
  if (found.length !== names.length || new Set(found.map(row => row.name)).size !== names.length
    || found.some(row => !names.includes(row.name) || typeof row.present !== "boolean")) {
    throw new Error("Channel refund schema inventory is incomplete");
  }
  if (found.every(row => !row.present)) return;
  if (found.some(row => !row.present)) throw new Error("Channel refund schema is partially deployed");
  for (const table of names) await resetRuntimeTablePrivileges(pool, table, role);
  await pool.query(`
    GRANT INSERT(id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,merchant_identity_id,
      original_payment_trx_no,original_payment_order_no,responsibility_version_hash,refund_order_no,amount_cents,
      currency,idempotency_key,request_fingerprint,due_at) ON zzsh_order.channel_refund_intent TO ${role};
    GRANT UPDATE(state,revision,lease_version,lease_owner,lease_until) ON zzsh_order.channel_refund_intent TO ${role};
    GRANT INSERT(id,intent_id,event,failure_reason,lease_version,lease_owner,state_before,state_after,request_id)
      ON zzsh_order.channel_refund_observation TO ${role};
  `);
}

/** Optional collection/refund/payout/account/bank groups; verify every metadata group before changing ACL. */
export async function configureJoinpayFinancialPrivileges(pool: Pick<Pool, "query">, runtimeRole: string): Promise<void> {
  const role = quoteIdentifier(runtimeRole), words = (value = "") => value.split(" ").filter(Boolean);
  type Table = { name: string; insert: string; update?: string; metadata: string; select?: string };
  const collection: Table[] = [
    {"name":"zzsh_order.payment_request","insert":"id order_id channel merchant_identity_id config_profile_id protocol_version key_version_ref platform_order_no channel_order_no amount_cents currency wire_amount_yuan method evidence_level idempotency_scope_key idempotency_key request_fingerprint","metadata":"created_at","update":"state revision lease_version lease_owner lease_until updated_at"},
    {"name":"zzsh_order.payment_channel_observation","insert":"id request_id channel merchant_identity_id channel_order_no channel_trx_no config_profile_id protocol_version key_version_ref operation source evidence_level event result reason channel_status provider_paid_at_raw raw_sha256 raw_ref verify_outcome lease_version state_before state_after stale late conflict","metadata":"observed_at"},
    {"name":"zzsh_order.payment_channel_transaction","insert":"id channel merchant_identity_id channel_trx_no order_origin native_order_id request_id confirmation_id evidence_level","metadata":"created_at"},
    {"name":"zzsh_order.joinpay_collection_binding","insert":"request_id wire_merchant_no trade_merchant_no product_name notify_url initial_profile_sha256 evidence_mode formal_admission_ref formal_admission_sha256 formal_admission_canonical","metadata":"created_at"},
    {"name":"zzsh_order.joinpay_collection_attempt","insert":"id request_id lease_version lease_owner operation profile_id profile_canonical profile_sha256 key_version_ref evidence_mode request_body request_sha256","metadata":"created_at"},
    {"name":"zzsh_order.joinpay_collection_observation","insert":"id attempt_id request_id raw_body raw_sha256 http_status response_complete received_bytes transport_failure event result schema_outcome signature_outcome binding_outcome verified state_before state_after channel_status provider_paid_at_raw channel_trx_no","metadata":"created_at"},
    {"name":"zzsh_order.joinpay_collection_evidence","insert":"id request_id operation origin_observation_id raw_query raw_sha256 profile_id profile_sha256 profile_canonical key_version_ref initial_admission_ref initial_admission_sha256 admission_ref admission_sha256 admission_canonical event result schema_outcome signature_outcome binding_outcome channel_trx_no provider_paid_at_raw provider_paid_at","metadata":"created_at"},
    {"name":"zzsh_order.distribution_order_admission","insert":"id order_id mode resource_oid resource_name resource_marker approval_digest source_admission_ref native_creation_audit_id revision active admitted_at expires_at created_by_admin_id reason","metadata":""},
  ];
  const refund: Table[] = [
    { name: "zzsh_order.channel_refund_intent", insert: "id posting_id order_id payment_confirmation_id renter_user_id payment_source merchant_identity_id original_payment_trx_no original_payment_order_no responsibility_version_hash refund_order_no amount_cents currency idempotency_key request_fingerprint due_at evidence_level initial_admission_ref initial_admission_sha256 initial_admission_canonical wire_merchant_no initial_profile_id initial_profile_sha256 initial_key_version_ref notify_url funds_account refund_reason", update: "state revision lease_version lease_owner lease_until updated_at budget_disposition requires_review terminal_evidence_id terminal_root_id terminal_event_id provider_refund_trx_no completed_at", metadata: "created_at" },
    { name: "zzsh_order.joinpay_refund_attempt", insert: "id intent_id operation lease_version lease_owner profile_id profile_canonical profile_sha256 key_version_ref admission_sha256 request_body request_sha256", metadata: "created_xid created_at" },
    { name: "zzsh_order.joinpay_refund_observation", insert: "id intent_id attempt_id operation lease_version lease_owner profile_id profile_canonical profile_sha256 key_version_ref raw_body raw_sha256 response_complete http_status received_bytes transport_failure event schema_status signature_status binding_status evidence_level state_before state_after request_id", metadata: "created_xid created_at" },
    { name: "zzsh_order.joinpay_refund_evidence", insert: "id intent_id observation_id operation terminal refund_transaction_no completed_at_raw completed_at facts_canonical facts_digest", metadata: "created_xid created_at" },
  ];
  const payout: Table[] = [
    { name: "zzsh_order.joinpay_withdrawal_intent", insert: "id user_id payout_key request_fingerprint policy_version destination_id destination_revision gross_cents net_cents fee_cents currency expected_ledger_revision coverage_canonical coverage_sha256 coverage_version covered_set_digest merchant_identity_id user_no trade_merchant_no merchant_order_no receiver_account_no_enc receiver_name_enc target_fingerprint admission_ref admission_sha256 admission_canonical scope_ref scope_sha256 scope_canonical initial_profile_id initial_profile_sha256 initial_profile_canonical initial_key_version_ref frozen_canonical frozen_digest economic_root_id reserve_event_id", update: "state operation_version funds_disposition lease_version lease_owner lease_until requires_review terminal_evidence_id terminal_event_id platform_serial_no provider_fee_raw provider_fee_cents", metadata: "accepted_at created_xid updated_at" },
    { name: "zzsh_order.joinpay_payout_attempt", insert: "id intent_id operation lease_version lease_owner profile_id profile_canonical profile_sha256 key_version_ref scope_sha256 scope_canonical request_body request_sha256", metadata: "created_xid created_at" },
    { name: "zzsh_order.joinpay_payout_observation", insert: "id intent_id attempt_id operation lease_version lease_owner profile_id profile_canonical profile_sha256 key_version_ref raw_body raw_sha256 response_complete http_status received_bytes transport_failure event schema_status signature_status binding_status evidence_level state_before state_after request_id", metadata: "created_xid created_at" },
    { name: "zzsh_order.joinpay_payout_evidence", insert: "id intent_id observation_id operation terminal platform_serial_no provider_fee_raw provider_fee_cents facts_canonical facts_digest", metadata: "created_xid created_at" },
  ];
  const account: Table[] = [{ name: "zzsh_order.joinpay_account_observation", insert: "attempt_id merchant_identity_id operation profile_id profile_sha256 rules_sha256 key_version_ref review_ref review_sha256 request_sha256 requested_at received_at http_status response_complete received_bytes transport_failure raw_body raw_sha256 evidence_level decision schema_status signature_status binding_status reason status_code error_code amounts", metadata: "recorded_at", select: "attempt_id merchant_identity_id operation evidence_level decision reason requested_at received_at recorded_at response_complete http_status status_code error_code amounts" }];
  const bank: Table[] = [{ name: "zzsh_order.withdrawal_bank_binding", insert: "id user_id revision sealed_details card_mask holder_mask", update: "revision sealed_details card_mask holder_mask", metadata: "created_at updated_at", select: "id user_id revision sealed_details card_mask holder_mask created_at updated_at" }];
  const prestart:Table[]=[
    {name:'zzsh_order.prestart_termination',insert:'id order_id requested_by_user_id requested_by_party reason basis_digest payment_basis request_id',
      update:'state revision last_reason approved_at updated_at liability_root_id liability_event_id',metadata:'created_at approved_xid'},
    {name:'zzsh_order.prestart_termination_decision',insert:'id termination_id result_revision decision assessment reason admin_user_id session_id request_id',metadata:'created_xid created_at'},
  ];
  const optional = [...collection.slice(0,7), ...refund.slice(1), ...payout, ...account, ...bank,...prestart].map(t => t.name);
  const found = (await pool.query<{ name: string; present: boolean }>("SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name) /* joinpay financial optional tables */", [optional])).rows;
  const validInventory = (rows: typeof found, names: string[]) => rows.length === names.length && new Set(rows.map(r => r.name)).size === names.length && rows.every(r => names.includes(r.name) && typeof r.present === "boolean");
  if (!validInventory(found, optional)) throw new Error("JoinPay financial inventory is incomplete");
  const complete = (tables: Table[]) => { const rows = tables.map(t => found.find(r => r.name === t.name)!); if (rows.every(r => !r.present)) return false; if (rows.some(r => !r.present)) throw new Error("JoinPay financial group is partially deployed"); return true; };
  const hasCollection = complete(collection.slice(0,7)), hasRefund = complete(refund.slice(1)), hasPayout = complete(payout), hasAccount = complete(account), hasBank = complete(bank),hasPrestart=complete(prestart);
  if (!hasCollection && !hasRefund && !hasPayout && !hasAccount && !hasBank&&!hasPrestart) return;
  if (hasPayout && !hasRefund) throw new Error("JoinPay payout requires the complete formal refund parent");
  if(hasPrestart&&!hasRefund)throw new Error('Prestart termination requires the complete refund parent');
  if (hasCollection) {
    const parentNames = [collection[7]!.name];
    const parent = (await pool.query<{name:string;present:boolean}>("SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)", [parentNames])).rows;
    if (!validInventory(parent,parentNames) || parent[0]!.present !== true) throw new Error("JoinPay collection admission parent is incomplete");
  }
  if (hasRefund) {
    const parent = (await pool.query<{ name: string; present: boolean }>("SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)", [[refund[0]!.name]])).rows;
    if (!validInventory(parent, [refund[0]!.name]) || parent[0]!.present !== true) throw new Error("JoinPay refund intent parent is incomplete");
  }
  const tables = [...(hasCollection ? collection : []), ...(hasRefund ? refund : []), ...(hasPayout ? payout : []), ...(hasAccount ? account : []), ...(hasBank ? bank : []),...(hasPrestart?prestart:[])];
  const functions = [
    ...(hasCollection ? ["zzsh_order.joinpay_formal_request_effect(text,text)"] : []),
    ...(hasRefund ? ["zzsh_order.assert_joinpay_refund_profile(text,text,text,text,zzsh_order.channel_refund_intent)", "zzsh_order.native_refund_terminal_complete(text)"] : []),
    ...(hasPayout ? ["zzsh_order.assert_joinpay_payout_scope(text,text,text,text,text,text,zzsh_order.joinpay_withdrawal_intent)", "zzsh_order.assert_joinpay_payout_profile(text,text,text,text,zzsh_order.joinpay_withdrawal_intent)", "zzsh_order.assert_joinpay_withdrawal_admission(zzsh_order.joinpay_withdrawal_intent,boolean)", "zzsh_order.joinpay_payout_raw_data(zzsh_order.joinpay_payout_observation)", "zzsh_order.joinpay_withdrawal_expected_lines(text)", "zzsh_order.joinpay_withdrawal_complete(text)"] : []),
    ...(hasBank ? ["zzsh_order.withdrawal_bank_binding_guard()"] : []),
    ...(hasPrestart?['zzsh_order.prestart_payment_basis_valid(jsonb)','zzsh_order.prestart_liability_complete(text)',
      'zzsh_order.native_prestart_refund_liability_complete(text)','zzsh_order.native_prestart_refund_terminal_complete(text)']:[]),
  ];
  const columns = (await pool.query<{ name: string; attname: string }>(`/* joinpay financial columns */ SELECT t.name,a.attname FROM unnest($1::text[]) AS t(name)
    JOIN pg_attribute a ON a.attrelid=to_regclass(t.name) AND a.attnum>0 AND NOT a.attisdropped ORDER BY t.name,a.attnum`, [tables.map(t => t.name)])).rows;
  if (columns.some(c => !tables.some(t => t.name === c.name) || typeof c.attname !== "string")) throw new Error("JoinPay financial column inventory differs");
  const basisColumns=['basis_kind','liability_root_id','liability_event_id'];
  const basisCount=columns.filter(c=>c.name===refund[0]!.name&&basisColumns.includes(c.attname)).length;
  if(basisCount!==0&&basisCount!==3||hasPrestart&&basisCount!==3)throw new Error('Refund liability extension is partially deployed');
  if(basisCount===3){refund[0]!.insert+=' '+basisColumns.join(' ');functions.push('zzsh_order.native_abnormal_refund_liability_complete(text)','zzsh_order.native_abnormal_refund_terminal_complete(text)');}
  const identity = (await pool.query(`/* joinpay financial runtime role */ SELECT r.oid::text AS "roleOid",r.rolsuper AS superuser,r.rolbypassrls AS "bypassRls",r.rolcreaterole AS "createRole",r.rolcreatedb AS "createDb",r.rolreplication AS replication,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS "memberRights",
    EXISTS(SELECT 1 FROM (SELECT c.relowner AS owner_id FROM pg_class c WHERE c.oid IN(SELECT to_regclass(name) FROM unnest($2::text[]) AS t(name))
      UNION SELECT p.proowner FROM pg_proc p WHERE p.oid IN(SELECT to_regprocedure(name) FROM unnest($3::text[]) AS t(name))) owners
      WHERE owners.owner_id=r.oid OR pg_has_role(r.oid,owners.owner_id,'MEMBER')) AS "ownerRights" FROM pg_roles r WHERE r.rolname=$1`, [runtimeRole, tables.map(t => t.name), functions])).rows[0];
  if (!identity || typeof identity.roleOid !== "string" || !/^[1-9]\d*$/.test(identity.roleOid) || ["superuser", "bypassRls", "createRole", "createDb", "replication", "memberRights", "ownerRights"].some(k => identity[k] !== false)) throw new Error("JoinPay financial runtime role must be known, unprivileged and not an owner or member");
  const inventory = new Map<string, string[]>();
  for (const table of tables) {
    const actual = columns.filter(c => c.name === table.name).map(c => c.attname), expected = [...new Set(words(`${table.insert} ${table.update ?? ""} ${table.metadata}`))];
    if (actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some(c => !actual.includes(c))) throw new Error("JoinPay financial column inventory differs: " + table.name);
    inventory.set(table.name, actual);
  }
  if (functions.length) {
    const fn = (await pool.query<{ name: string; present: boolean }>("SELECT name,to_regprocedure(name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name) /* joinpay financial functions */", [functions])).rows;
    if (!validInventory(fn, functions) || fn.some(f => !f.present)) throw new Error("JoinPay financial function inventory is incomplete");
  }
  if (hasBank) {
    // 只接受覆盖全部行写入的 BEFORE ROW INSERT/UPDATE 守卫，拒绝禁用、限列或带条件的触发器。
    const guard = (await pool.query<{ ready: boolean }>(`/* withdrawal bank binding guard */ SELECT EXISTS (
      SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.withdrawal_bank_binding')
        AND t.tgname='withdrawal_bank_binding_guard' AND t.tgfoid=to_regprocedure('zzsh_order.withdrawal_bank_binding_guard()')
        AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=23 AND t.tgattr::text='' AND t.tgqual IS NULL
    ) AS ready`)).rows;
    if (guard.length !== 1 || guard[0]!.ready !== true) throw new Error("Withdrawal bank guard inventory is incomplete");
  }
  for (const table of tables) {
    const all = inventory.get(table.name)!, list = all.map(quoteIdentifier).join(",");
    await resetRuntimeTablePrivileges(pool, table.name, role, { columns: all, select: table.select === undefined });
    await pool.query(`REVOKE ALL ON TABLE ${table.name} FROM PUBLIC;
      REVOKE SELECT (${list}), INSERT (${list}), UPDATE (${list}), REFERENCES (${list}) ON TABLE ${table.name} FROM PUBLIC`);
    const grants = [`GRANT INSERT (${words(table.insert).map(quoteIdentifier).join(",")}) ON TABLE ${table.name} TO ${role}`];
    if (table.update) grants.push(`GRANT UPDATE (${words(table.update).map(quoteIdentifier).join(",")}) ON TABLE ${table.name} TO ${role}`);
    if (table.select) grants.push(`GRANT SELECT (${words(table.select).map(quoteIdentifier).join(",")}) ON TABLE ${table.name} TO ${role}`);
    await pool.query(grants.join(";\n") + ";");
  }
  if (functions.length) await pool.query(`REVOKE ALL ON FUNCTION ${functions.join(",")} FROM ${role}, PUBLIC; GRANT EXECUTE ON FUNCTION ${functions.join(",")} TO ${role}`);
}
