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
  await applyRuntimePrivileges(pool, options.runtimeUser);
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
  await configureSkinIdentityPrivileges(pool, runtimeRole);
  await pool.query(`GRANT USAGE, SELECT ON SEQUENCE "zzsh_iam"."admin_login_number_seq" TO ${runtimeUser}`);
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.listing_filter_config') AS relation`)).rows[0]?.relation) {
    await pool.query(`GRANT SELECT,INSERT ON zzsh_supply.listing_filter_config TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_supply.listing_filter_config FROM ${runtimeUser}`);
  }
  if ((await pool.query(`SELECT to_regclass('zzsh_supply.legacy_listing_read_snapshot') AS relation`)).rows[0]?.relation) {
    await pool.query(`GRANT SELECT,INSERT ON zzsh_supply.legacy_listing_read_snapshot TO ${runtimeUser}; REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_supply.legacy_listing_read_snapshot FROM ${runtimeUser}`);
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
  await configureDistributionFinancialPrivileges(pool, runtimeRole);
}

/** Kept separate so prefix migration and least-privilege branches can be checked offline. */
export async function configureSkinIdentityPrivileges(pool: Pick<Pool, "query">, runtimeUser: string): Promise<void> {
  const role = quoteIdentifier(runtimeUser);
  const columns = (await pool.query(`SELECT count(*)::int AS count FROM pg_attribute
    WHERE attrelid=to_regclass('zzsh_supply.skin') AND NOT attisdropped AND attname=ANY($1::text[])`,
    [["owner_kind","owner_id","firearm_id","base_name","aliases","source_namespace","naming_state"]])).rows[0]?.count;
  const owner = (await pool.query(`SELECT to_regclass('zzsh_supply.skin_owner') IS NOT NULL AS present`)).rows[0]?.present;
  if (columns === 0 && !owner) return;
  if (columns !== 7 || !owner) throw new Error("Skin identity schema is incomplete; runtime privileges not finalized");
  await pool.query(`
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON zzsh_supply.skin FROM ${role};
    GRANT SELECT ON zzsh_supply.skin TO ${role};
    GRANT INSERT (id,game_id,code,name,category_id,rarity_code,enabled,form_visible,media_id,sort_order,source_namespace,source_field,source_token,aliases) ON zzsh_supply.skin TO ${role};
    GRANT UPDATE (name,category_id,rarity_code,enabled,form_visible,media_id,sort_order,source_namespace,source_field,source_token,aliases,owner_kind,owner_id,firearm_id,base_name) ON zzsh_supply.skin TO ${role};
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
    const columns = (await pool.query("SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum", [table])).rows;
    if (!columns.length) throw new Error("Financial table columns are unavailable");
    const list = columns.map(row => quoteIdentifier(row.attname)).join(",");
    // Table revocation alone does not clear an old explicit column grant.
    await pool.query(`REVOKE ALL ON TABLE ${table} FROM ${role};
      REVOKE SELECT (${list}), INSERT (${list}), UPDATE (${list}), REFERENCES (${list}) ON TABLE ${table} FROM ${role};
      GRANT SELECT ON TABLE ${table} TO ${role}`);
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
