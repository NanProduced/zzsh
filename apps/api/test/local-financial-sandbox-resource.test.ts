import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalFinancialSandbox, verifyDailyRestoreProof, localFinancialSandboxRegistration, assertLocalFinancialSandboxAssembly,
  assertLocalFinancialSandboxResource, assertSandboxOriginalResource, ensureLocalSandboxOrderAdmission } from "../src/finance/local-financial-sandbox-resource";
import { sandboxConfig, sandboxResource, sandboxOrigins, restoreDocument, digest, sandboxFixture, sandboxClient } from "./local-financial-sandbox-fixture";
import type { AppConfig } from "../src/config/config";
import type { PoolClient } from "pg";

const proof = () => { const bytes = Buffer.from(JSON.stringify(restoreDocument)); return verifyDailyRestoreProof(bytes, digest(bytes)); };
test("sandbox accepts only pinned successful restore proof and exact dev/fake/loopback registration", () => {
  const scope = sandboxFixture(); assert(Object.isFrozen(scope)); assertLocalFinancialSandboxAssembly(scope, sandboxOrigins);
  const bytes = Buffer.from(JSON.stringify(restoreDocument)); assert.throws(() => verifyDailyRestoreProof(bytes, "b".repeat(64)));
  for (const changed of [{ status: "UNKNOWN" }, { sourceWrites: 1 }, { globalRoleChanges: 1 }, { cleanup: { allAcknowledged: false } },
    { comparison: { equal: true, expectedSha256: "a".repeat(64), actualSha256: "b".repeat(64) } },
    { source: { ...restoreDocument.source, marker: "other" } }, { target: { ...restoreDocument.target, oid: "1141209" } }]) {
    const value = Buffer.from(JSON.stringify({ ...restoreDocument, ...changed }));
    if ((changed as any).target) assert.throws(() => createLocalFinancialSandbox({ config: sandboxConfig, resource: sandboxResource, origins: sandboxOrigins, restoreProof: verifyDailyRestoreProof(value, digest(value)), reference: "test", approvedByAdminId: "boss" }));
    else assert.throws(() => verifyDailyRestoreProof(value, digest(value)));
  }
  for (const changed of [{ profile: "production" }, { profile: "test" }, { provider: "real" }, { host: "localhost" }]) assert.throws(() => createLocalFinancialSandbox({ config: { ...sandboxConfig, ...changed } as AppConfig, resource: sandboxResource, origins: sandboxOrigins, restoreProof: proof(), reference: "test", approvedByAdminId: "boss" }));
  for (const changed of [{ name: "zzsh_test_regression" }, { user: "daily_m" }, { host: "10.0.0.1" }, { port: 5432 }, { targetProfile: "production" }]) assert.throws(() => createLocalFinancialSandbox({ config: { ...sandboxConfig, database: { ...sandboxConfig.database, ...changed } } as AppConfig, resource: sandboxResource, origins: sandboxOrigins, restoreProof: proof(), reference: "test", approvedByAdminId: "boss" }));
  for (const changed of [{ resourceOid: 2220718 }, { runtimeRoleOid: 101 }, { migrationRoleOid: 103 }, { marker: "other" }]) assert.throws(() => createLocalFinancialSandbox({ config: sandboxConfig, resource: { ...sandboxResource, ...changed }, origins: sandboxOrigins, restoreProof: proof(), reference: "test", approvedByAdminId: "boss" }));
  for (const changed of [{ secureCookies: true }, { userOrigin: "https://127.0.0.1:4220" }, { adminOrigin: "http://localhost:4221" }, { apiOrigin: "http://127.0.0.1:4223" }]) assert.throws(() => createLocalFinancialSandbox({ config: sandboxConfig, resource: sandboxResource, origins: { ...sandboxOrigins, ...changed }, restoreProof: proof(), reference: "test", approvedByAdminId: "boss" }));
  for (const fake of [{ ...scope }, Object.create(scope)]) assert.throws(() => localFinancialSandboxRegistration(fake));
});

test("exact runtime/owner/role OIDs, registration and least privilege are rechecked before all money work", async () => {
  const scope = sandboxFixture(), p = sandboxClient(scope); await assertLocalFinancialSandboxResource(p.client, scope);
  assert(p.calls.every(call => /^\s*SELECT/.test(call.sql))); assert.deepEqual(p.calls.find(call=>call.sql.includes('AS resource_oid'))!.values, ["synthetic_daily_sandbox", "daily_m"]);
  for (const changed of [{ resource_oid: "1141209" }, { role: "daily_m" }, { marker: "other" }, { owner_oid: "103" }, { migration_role_oid: "103" },
    { runtime_role_oid: "103" }, { rolsuper: true }, { rolbypassrls: true }, { migration_super: true }, { migration_bypass: true }, { runtime_has_membership: true }, { runtime_owns_business_routine: true },
    { canonical_registration: "{}" }, { registration_digest: "b".repeat(64) }]) await assert.rejects(assertLocalFinancialSandboxResource(sandboxClient(scope, { identity: changed }).client, scope));
  for (const ownership of [{ ownsBusinessSchema: true }, { ownsBusinessRelation: true }, { hasPrivilegedMembership: true }]) await assert.rejects(assertLocalFinancialSandboxResource(sandboxClient(scope, { ownership }).client, scope));
  await assert.rejects(assertLocalFinancialSandboxResource(sandboxClient(scope, { ready: false }).client, scope));
  await assert.rejects(assertLocalFinancialSandboxResource(sandboxClient(scope, { identity: { active: false } }).client, scope));
  await assertLocalFinancialSandboxResource(sandboxClient(scope, { identity: { active: false } }).client, scope, "READ_ORIGINAL");
  assertSandboxOriginalResource(scope, 2220718); assert.throws(() => assertSandboxOriginalResource(scope, 1141209));
});

test("canonical registration copies only known metadata and write admission holds one original transaction", async () => {
  const scope = createLocalFinancialSandbox({ config: sandboxConfig, resource: { ...sandboxResource, password: "synthetic-extra-never-persisted" } as typeof sandboxResource,
    origins: { ...sandboxOrigins, secret: "synthetic-extra-never-persisted" } as typeof sandboxOrigins, restoreProof: proof(), reference: "copy_fixture", approvedByAdminId: "boss" });
  assert(!localFinancialSandboxRegistration(scope).canonical.includes("synthetic-extra"));
  const p = sandboxClient(scope); await assertLocalFinancialSandboxResource(p.client, scope);
  assert(p.calls.some(call => call.sql.includes('FOR SHARE')));
  const read = sandboxClient(scope); await assertLocalFinancialSandboxResource(read.client, scope, 'READ_ORIGINAL');
  assert(!read.calls.some(call => call.sql.includes('FOR SHARE')));
  const outside = sandboxClient(scope), client = { query: async (sql: string, values: unknown[]) => {
    const result = await outside.query(sql, values);
    if (sql.includes('FOR SHARE')) result.rows[0].sandbox_xid = '111'; return result;
  } } as unknown as PoolClient;
  await assert.rejects(assertLocalFinancialSandboxResource(client, scope));
});

test("future-order admission is source-bound and concurrent enrollment cannot replace restored provenance", async () => {
  const scope = sandboxFixture(), base = sandboxClient(scope), registration = localFinancialSandboxRegistration(scope); let row: any, writes = 0;
  const query = async (sql: string, values: unknown[] = []): Promise<any> => {
    if (sql.startsWith("SELECT id,mode,resource_oid")) return { rows: row ? [row] : [] };
    if (sql.startsWith("SELECT a.id")) return { rows: [{ id: "original_creation" }] };
    if (sql.startsWith("INSERT INTO zzsh_order.distribution_order_admission")) { writes++; row = { id: values[0], mode: "LOCAL_CONTROLLED", resource_oid: 2400547, resource_name: "zzsh_dev_daily", resource_marker: "zzsh:local-daily:v1", approval_digest: registration.digest }; return { rows: [] }; }
    return base.query(sql, values);
  };
  const client = { query } as unknown as PoolClient;
  const original = await ensureLocalSandboxOrderAdmission(client, scope, "future_order"); assert.equal(await ensureLocalSandboxOrderAdmission(client, scope, "future_order"), original); assert.equal(writes, 1);
  row = { ...row, resource_oid: 2220718 }; await assert.rejects(ensureLocalSandboxOrderAdmission(client, scope, "future_order")); assert.equal(writes, 1);
  const missing = { query: async (sql: string, values: unknown[]) => sql.startsWith("SELECT a.id") || sql.startsWith("SELECT id,mode,resource_oid") ? { rows: [] } : base.query(sql, values) } as unknown as PoolClient;
  await assert.rejects(ensureLocalSandboxOrderAdmission(missing, scope, "restored_order"));
});
