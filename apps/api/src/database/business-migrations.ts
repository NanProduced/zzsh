import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const BUSINESS_SCHEMAS = ["zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin"] as const;

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

export async function runBusinessMigrations(pool: Pool, options: { runtimeUser: string }): Promise<void> {
  await migrate(drizzle(pool), BUSINESS_MIGRATION_CONFIG);
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
    GRANT SELECT, INSERT, UPDATE ON TABLE "zzsh_iam"."admin_workspace_layout" TO ${runtimeUser};
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."audit_event" FROM ${runtimeUser};
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."admin_permission" FROM ${runtimeUser};
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"."approval_request_candidate", "zzsh_iam"."approval_decision", "zzsh_iam"."approval_execution" FROM ${runtimeUser};
    REVOKE DELETE, TRUNCATE ON TABLE "zzsh_iam"."user_identity_state" FROM ${runtimeUser};
  `);
  await pool.query(`GRANT USAGE, SELECT ON SEQUENCE "zzsh_iam"."admin_login_number_seq" TO ${runtimeUser}`);
  for (const schema of ["zzsh_auth_user", "zzsh_auth_admin"] as const) {
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeUser}`);
  }
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_iam" GRANT SELECT, INSERT ON TABLES TO ${runtimeUser}`);
}
