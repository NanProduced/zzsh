import { createHash } from "node:crypto";
import type { AppConfig } from "../src/config/config";
import type { PoolClient } from "pg";
import { createLocalFinancialSandbox, localFinancialSandboxRegistration, verifyDailyRestoreProof, type LocalFinancialSandbox } from "../src/finance/local-financial-sandbox-resource";

export const sandboxResource = Object.freeze({ database: "zzsh_dev_daily", resourceOid: 2400547, marker: "zzsh:local-daily:v1",
  owner: "daily_m", ownerOid: 101, migrationRole: "daily_m", migrationRoleOid: 101, runtimeRole: "daily_r", runtimeRoleOid: 102 });
export const sandboxOrigins = Object.freeze({ apiOrigin: "http://127.0.0.1:4222", userOrigin: "http://127.0.0.1:4220", adminOrigin: "http://127.0.0.1:4221", secureCookies: false });
export const sandboxConfig = { profile: "dev", provider: "fake", host: "127.0.0.1", port: 4222, testOperationsEnabled: false,
  database: { target: "local-compose", targetProfile: "dev", host: "127.0.0.1", port: 55432, name: sandboxResource.database, user: sandboxResource.runtimeRole, runtimeUser: sandboxResource.runtimeRole } } as AppConfig;
export const restoreDocument = { phase: "finalize-restored-target", status: "MAPPED_DAILY_EQUIVALENT_PENDING_ROOT_APP_ADOPTION",
  source: { name: "zzsh_test_regression", oid: "2220718", marker: "zzsh:regression-test:v1" }, target: { name: "zzsh_dev_daily", oid: "2400547", marker: "zzsh:local-daily:v1" },
  sourceWrites: 0, globalRoleChanges: 0, cleanup: { allAcknowledged: true }, maintenanceClosed: true,
  comparison: { equal: true, expectedSha256: "a".repeat(64), actualSha256: "a".repeat(64) } };
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function sandboxFixture() {
  const bytes = Buffer.from(JSON.stringify(restoreDocument)), restoreProof = verifyDailyRestoreProof(bytes, digest(bytes));
  return createLocalFinancialSandbox({ config: sandboxConfig, resource: sandboxResource, origins: sandboxOrigins, restoreProof, reference: "synthetic_daily_sandbox", approvedByAdminId: "synthetic_boss" });
}

/** Synthetic DB only: no socket, credentials, database role or business identity is created. */
export function sandboxClient(scope: LocalFinancialSandbox, options: { identity?: Record<string, unknown>; business?: Record<string, unknown>; ownership?: Record<string, unknown>; ready?: boolean } = {}) {
  const proof = localFinancialSandboxRegistration(scope), calls: { sql: string; values: unknown[] }[] = [];
  const query = async (sql: string, values: unknown[] = []): Promise<any> => {
    calls.push({ sql, values });
    if (sql.includes("local_financial_sandbox_registration') IS NOT NULL")) return { rows: [{ ready: options.ready ?? true }] };
    if (sql.includes('AS resource_oid')) return { rows: [{ resource_oid: "2400547", database: sandboxResource.database, role: sandboxResource.runtimeRole,
      marker: sandboxResource.marker, owner: sandboxResource.owner, owner_oid: "101", runtime_role_oid: "102", migration_role_oid: "101",
      rolsuper: false, rolbypassrls: false, migration_super: false, migration_bypass: false, runtime_has_membership: false, runtime_owns_business_routine: false, sandbox_xid: "110",
      canonical_registration: proof.canonical, registration_digest: proof.digest, active: true, ...options.identity }] };
    if (sql.includes('FROM zzsh_order.local_financial_sandbox_registration WHERE reference=$1 FOR SHARE')) return { rows: [{ canonical_registration: proof.canonical, registration_digest: proof.digest, active: true, sandbox_xid: "110", ...options.identity }] };
    if (sql.includes('AS "databaseName"')) return { rows: [{ databaseName: sandboxResource.database, currentUser: sandboxResource.runtimeRole, owner: sandboxResource.owner,
      isSuperuser: false, canCreateRole: false, canCreateDb: false, canReplicate: false, canBypassRls: false, canCreateDatabase: false,
      canCreateIamSchema: false, canCreateUserSchema: false, canCreateAdminSchema: false, canCreateSupplySchema: false, canCreateContentSchema: false,
      canCreateOrderSchema: false, canUpdateAudit: false, canDeleteAudit: false, canTruncateAudit: false, ...options.business }] };
    if (sql.includes('AS "ownsBusinessSchema"')) return { rows: [{ ownsBusinessSchema: false, ownsBusinessRelation: false, hasPrivilegedMembership: false, ...options.ownership }] };
    if (sql.startsWith("SELECT set_config('max_parallel_workers_per_gather'")) return {rows:[]};
    throw new Error("Unexpected sandbox fixture query");
  };
  return { client: { query } as unknown as PoolClient, query, calls };
}
