import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

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

export async function runBusinessMigrations(pool: Pool, options: { runtimeUser: string; migrationsFolder?: string }): Promise<void> {
  await migrate(drizzle(pool), { ...BUSINESS_MIGRATION_CONFIG, ...(options.migrationsFolder ? { migrationsFolder: options.migrationsFolder } : {}) });
  const runtimeUser = quoteIdentifier(options.runtimeUser);
  for (const schema of BUSINESS_SCHEMAS) {
    const schemaIdentifier = quoteIdentifier(schema);
    await pool.query(`GRANT USAGE ON SCHEMA ${schemaIdentifier} TO ${runtimeUser}`);
  }
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "zzsh_auth_user", "zzsh_auth_admin" TO ${runtimeUser};
    GRANT SELECT, INSERT ON TABLE "zzsh_iam"."audit_event" TO ${runtimeUser};
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
  await pool.query(`GRANT USAGE, SELECT ON SEQUENCE "zzsh_iam"."admin_login_number_seq" TO ${runtimeUser}`);
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.listing_filter_config') AS relation`)).rows[0]?.relation) {
    await pool.query(`GRANT SELECT,INSERT ON zzsh_supply.listing_filter_config TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_supply.listing_filter_config FROM ${runtimeUser}`);
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
  for (const schema of ["zzsh_auth_user", "zzsh_auth_admin"] as const) {
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeUser}`);
  }
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_iam" GRANT SELECT, INSERT ON TABLES TO ${runtimeUser}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_supply" GRANT SELECT, INSERT, UPDATE ON TABLES TO ${runtimeUser}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_content" GRANT SELECT, INSERT, UPDATE ON TABLES TO ${runtimeUser}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_order" GRANT SELECT, INSERT, UPDATE ON TABLES TO ${runtimeUser}`);
}
