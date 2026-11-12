// P1a internal documentation library under real PostgreSQL: schema, triggers,
// constraints, the save merge window (injected clock), trash lifecycle, version
// restore, title search, image references and server-side permission negatives.
// Uses the shared regression resource group; never creates a private database.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";

import { loadConfig, type AppConfig } from "../src/config/config";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { assertNotProtectedTarget, REGRESSION_ALLOW_NEW_RESOURCE, REGRESSION_DATABASE, REGRESSION_MARKER, REGRESSION_MIGRATION_USER, REGRESSION_RESOURCE_LOCK_KEY, REGRESSION_ROLE_PREFIX, REGRESSION_RUNTIME_USER, regressionOidBinding } from "../src/config/test-resource";
import { admitTestDatabase, assertFreshRegressionRun } from "./database-test-support";
import { ADMIN_PERMISSION } from "../src/auth/admin-authorization";
import { SecurityApiError } from "../src/auth/security-core";
import { API_V1_ERROR_CODES } from "../src/contracts/api-v1";
import type { WriteActor } from "../src/supply/supply-routes";
import {
  authorizeDocs, createNode, deleteNode, listTrashForActor, listTree, listVersions, moveNode, readNodeDetail,
  renameNode, restoreBatch, restoreVersion, saveContent, searchNodes, signableImages, imageReferenced,
  createImageRecord, newDocId, DOC_MERGE_WINDOW_MS,
} from "../src/docs/docs-store";

const DATABASE = REGRESSION_DATABASE;
const LOCK_KEY = REGRESSION_RESOURCE_LOCK_KEY;
const BUSINESS_SCHEMAS = ["zzsh_business_meta", "zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin", "zzsh_supply", "zzsh_content", "zzsh_docs"] as const;

function quotedIdentifier(value: string, label: string): string {
  assert.ok(/^[a-z][a-z0-9_]{0,62}$/.test(value), `${label} is not a safe identifier`);
  return `"${value}"`;
}
function quotedLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

type Resources = { maintenance: AppConfig; migration: AppConfig; runtime: AppConfig; databaseName: string; migrationUser: string; runtimeUser: string; migrationPassword: string; runtimePassword: string };

function makeResources(): Resources {
  const databaseName = DATABASE;
  assertNotProtectedTarget(databaseName);
  const migrationUser = REGRESSION_MIGRATION_USER;
  const runtimeUser = REGRESSION_RUNTIME_USER;
  assert.ok(migrationUser.startsWith(REGRESSION_ROLE_PREFIX) && runtimeUser.startsWith(REGRESSION_ROLE_PREFIX));
  const baseEnv = { ...process.env, APP_PROFILE: "test", PROVIDER_MODE: "fake", DB_TARGET: "local-compose", DB_NAME: databaseName };
  const maintenance = loadConfig(baseEnv);
  const migrationPassword = process.env.DOCS_TEST_MIGRATION_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtimePassword = process.env.DOCS_TEST_RUNTIME_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtime = loadConfig({ ...baseEnv, DB_USER: runtimeUser, DB_PASSWORD: runtimePassword, DB_PASSWORD_FILE: undefined });
  const migration = loadConfig({
    ...baseEnv, APP_PROFILE: "migration", DB_USER: undefined, DB_PASSWORD: undefined, DB_PASSWORD_FILE: undefined,
    MIGRATION_TARGET_PROFILE: "test", MIGRATION_TARGET_DB_NAME: databaseName, MIGRATION_DB_USER: migrationUser,
    MIGRATION_DB_PASSWORD: migrationPassword, MIGRATION_DB_PASSWORD_FILE: undefined, MIGRATION_RUNTIME_USER: runtimeUser,
  });
  return { maintenance, migration, runtime, databaseName, migrationUser, runtimeUser, migrationPassword, runtimePassword };
}

function poolFor(config: AppConfig, database: string, applicationName: string, max: number): Pool {
  return new Pool({ host: config.database.host, port: config.database.port, database, user: config.database.user, password: config.database.password, application_name: applicationName, connectionTimeoutMillis: 2_000, max });
}

async function resourceGuard(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{ databaseName: string }>('SELECT current_database() AS "databaseName"');
    assert.equal(identity.rows[0]?.databaseName, "postgres");
    assert.equal((await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired, true, "regression resource is already in use");
    return client;
  } catch (error) { client.release(true); throw error; }
}

async function ensureDatabase(pool: Pool, resources: Resources): Promise<void> {
  const existing = await pool.query<{ owner: string; allowConnections: boolean; isTemplate: boolean; databaseOid: string | null; comment: string | null }>(
    "SELECT pg_get_userbyid(d.datdba) AS owner, d.datallowconn AS \"allowConnections\", d.datistemplate AS \"isTemplate\", d.oid::text AS \"databaseOid\", shobj_description(d.oid, 'pg_database') AS comment FROM pg_database d WHERE d.datname = $1", [resources.databaseName],
  );
  const admission = admitTestDatabase({
    exists: existing.rows.length > 0, owner: existing.rows[0]?.owner, marker: existing.rows[0]?.comment,
    allowConnections: existing.rows[0]?.allowConnections, isTemplate: existing.rows[0]?.isTemplate,
    expectedOwner: resources.maintenance.database.user, expectedMarker: REGRESSION_MARKER,
    databaseOid: existing.rows[0]?.databaseOid, expectedOid: regressionOidBinding(),
    reuseOnly: true, requireOidOnReuse: true, databaseName: resources.databaseName, allowFlag: REGRESSION_ALLOW_NEW_RESOURCE,
  });
  assert.equal(admission, "REUSE", "the docs suite reuses the freshly reset regression database");
}

async function ensureRole(pool: Pool, roleName: string, password: string, marker: string): Promise<void> {
  const current = await pool.query<{ comment: string | null }>("SELECT shobj_description(r.oid, 'pg_authid') AS comment FROM pg_roles r WHERE r.rolname = $1", [roleName]);
  const role = quotedIdentifier(roleName, "test role");
  if (current.rows.length > 0) {
    assert.equal(current.rows[0]?.comment, marker, `${roleName} marker mismatch`);
    await pool.query("ALTER ROLE " + role + " PASSWORD " + quotedLiteral(password));
    return;
  }
  await pool.query("CREATE ROLE " + role + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD " + quotedLiteral(password));
  await pool.query("COMMENT ON ROLE " + role + " IS " + quotedLiteral(marker));
}

async function prepareOwnership(pool: Pool, resources: Resources): Promise<void> {
  const migrationRole = quotedIdentifier(resources.migrationUser, "migration user");
  for (const schemaName of BUSINESS_SCHEMAS) {
    const schema = quotedIdentifier(schemaName, "business schema");
    const ownerResult = await pool.query<{ owner: string }>("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1", [schemaName]);
    if (ownerResult.rows.length === 0) await pool.query("CREATE SCHEMA " + schema);
    const owner = ownerResult.rows.length === 0 ? resources.maintenance.database.user : ownerResult.rows[0]!.owner;
    if (owner !== resources.migrationUser) await pool.query("ALTER SCHEMA " + schema + " OWNER TO " + migrationRole);
  }
  const relations = await pool.query<{ schemaName: string; relationName: string; kind: string; owner: string }>(
    "SELECT n.nspname AS \"schemaName\", c.relname AS \"relationName\", c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p','S')", [BUSINESS_SCHEMAS],
  );
  for (const row of relations.rows) {
    if (row.owner !== resources.migrationUser) {
      const relation = quotedIdentifier(row.schemaName, "business schema") + "." + quotedIdentifier(row.relationName, "relation");
      await pool.query((row.kind === "S" ? "ALTER SEQUENCE " : "ALTER TABLE ") + relation + " OWNER TO " + migrationRole);
    }
  }
}

async function insertAdmin(pool: Pool, id: string, username: string, isBoss: boolean, roleIds: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO "zzsh_auth_admin"."user" ("id", "name", "email", "emailVerified", "username", "displayUsername", "twoFactorEnabled", "suspended", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, $2, $2, true, false, now(), now())`, [id, username, `${username}@docs.test`],
  );
  await pool.query(`INSERT INTO "zzsh_iam"."admin_security" ("admin_user_id", "status", "is_boss") VALUES ($1, 'ACTIVE', $2)`, [id, isBoss]);
  for (const roleId of roleIds) {
    await pool.query(`INSERT INTO "zzsh_iam"."admin_user_role" ("admin_user_id", "role_id") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, roleId]);
  }
}

const VALID_DOC = { format: "plate", schemaVersion: 1, preset: "internal", value: [{ type: "p", children: [{ text: "正文" }] }] };

test("P1a internal documentation library under real PostgreSQL", async () => {
  let resources: Resources | undefined;
  let maintenancePool: Pool | undefined;
  let maintenanceDataPool: Pool | undefined;
  let migrationPool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let guard: PoolClient | undefined;
  try {
    resources = makeResources();
    maintenancePool = poolFor(resources.maintenance, "postgres", "zzsh-docs-maintenance", 2);
    guard = await resourceGuard(maintenancePool);
    await ensureDatabase(maintenancePool, resources);
    const marker = (role: string) => REGRESSION_MARKER + ":" + resources!.databaseName + ":" + role;
    await ensureRole(maintenancePool, resources.migrationUser, resources.migrationPassword, marker("migration"));
    await ensureRole(maintenancePool, resources.runtimeUser, resources.runtimePassword, marker("runtime"));
    await maintenancePool.query("GRANT CONNECT ON DATABASE " + quotedIdentifier(resources.databaseName, "db") + " TO " + quotedIdentifier(resources.migrationUser, "m") + ", " + quotedIdentifier(resources.runtimeUser, "r"));
    await maintenancePool.query("GRANT CREATE ON DATABASE " + quotedIdentifier(resources.databaseName, "db") + " TO " + quotedIdentifier(resources.migrationUser, "m"));
    maintenanceDataPool = poolFor(resources.maintenance, resources.databaseName, "zzsh-docs-owner", 2);
    await prepareOwnership(maintenanceDataPool, resources);
    migrationPool = createBusinessPool(resources.migration);
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    runtimePool = createBusinessPool(resources.runtime);
    await assertBusinessRuntimeIdentity(runtimePool, resources.runtime);
    await assertFreshRegressionRun(maintenanceDataPool);

    // Schema, triggers and the NULLS NOT DISTINCT partial unique index exist.
    const schema = await runtimePool.query<{ present: boolean; triggers: number; nullsNotDistinct: boolean }>(
      `SELECT to_regclass('zzsh_docs.doc_node') IS NOT NULL AND to_regclass('zzsh_docs.doc_version') IS NOT NULL
         AND to_regclass('zzsh_docs.doc_image') IS NOT NULL AND to_regclass('zzsh_docs.doc_version_image') IS NOT NULL AS present,
       (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass('zzsh_docs.doc_node') AND tgname = 'doc_node_guard')
         + (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass('zzsh_docs.doc_version') AND tgname = 'doc_version_update_guard') AS triggers,
       (SELECT indisnullsnotdistinct FROM pg_index WHERE indexrelid = to_regclass('zzsh_docs.doc_node_sibling_sort_key')) AS nullsNotDistinct`,
    );
    assert.equal(schema.rows[0]?.present, true);
    assert.equal(schema.rows[0]?.triggers, 2);
    assert.equal(schema.rows[0]?.nullsNotDistinct, true);

    // Permission catalog seeded and preset grants applied (0202/0203).
    const catalog = await runtimePool.query<{ code: string }>(`SELECT code FROM zzsh_iam.admin_permission WHERE code LIKE 'docs.internal.%' ORDER BY code`);
    assert.deepEqual(catalog.rows.map(row => row.code), ["docs.internal.comment", "docs.internal.manage", "docs.internal.read"]);
    const supportGrants = await runtimePool.query<{ permission_code: string }>(`SELECT permission_code FROM zzsh_iam.admin_role_permission WHERE role_id = 'role_preset_support' AND permission_code LIKE 'docs.internal.%' ORDER BY permission_code`);
    assert.deepEqual(supportGrants.rows.map(row => row.permission_code), ["docs.internal.comment", "docs.internal.read"]);
    const opsGrants = await runtimePool.query<{ permission_code: string }>(`SELECT permission_code FROM zzsh_iam.admin_role_permission WHERE role_id = 'role_preset_ops' AND permission_code LIKE 'docs.internal.%' ORDER BY permission_code`);
    assert.deepEqual(opsGrants.rows.map(row => row.permission_code), ["docs.internal.comment", "docs.internal.manage", "docs.internal.read"]);

    const bossId = "admin_docs_boss";
    const supportId = "admin_docs_support";
    const opsId = "admin_docs_ops";
    await insertAdmin(runtimePool, bossId, "docs_boss", true, []);
    await insertAdmin(runtimePool, supportId, "docs_support", false, ["role_preset_support"]);
    await insertAdmin(runtimePool, opsId, "docs_ops", false, ["role_preset_ops"]);
    const boss: WriteActor = { realm: "admin", id: bossId, sessionId: "s_boss" };
    const support: WriteActor = { realm: "admin", id: supportId, sessionId: "s_support" };
    const ops: WriteActor = { realm: "admin", id: opsId, sessionId: "s_ops" };
    const run = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => withTransactionRuntime(runtimePool!, fn);

    // Tree creation up to three levels; the fourth is refused by the trigger.
    const root = await run(client => createNode(client, boss, "req", { parentId: null, title: "根文档" }));
    const child = await run(client => createNode(client, boss, "req", { parentId: root.node.id, title: "二级" }));
    const grand = await run(client => createNode(client, boss, "req", { parentId: child.node.id, title: "三级" }));
    assert.equal(root.node.depth, 1);
    assert.equal(child.node.depth, 2);
    assert.equal(grand.node.depth, 3);
    await assert.rejects(() => run(client => createNode(client, boss, "req", { parentId: grand.node.id, title: "四级" })), (error: unknown) => error instanceof SecurityApiError && error.status === 400);

    // Duplicate sort_key under the same parent (including top-level NULL) is refused.
    const dupKey = root.node.sortKey;
    await assert.rejects(() => runtimePool!.query(`INSERT INTO zzsh_docs.doc_node (id, parent_id, sort_key, title, created_by_admin_id, updated_by_admin_id) VALUES ($1, NULL, $2, '冲突', $3, $3)`, [newDocId("doc"), dupKey, bossId]), (error: { code?: string }) => error.code === "23505");

    // Cycle refused: move root under its own grandchild.
    await assert.rejects(() => run(client => moveNode(client, boss, "req", root.node.id, root.node.revision, grand.node.id, null)), (error: unknown) => error instanceof SecurityApiError && error.status === 400);

    // Rename and move with revision optimistic locking.
    const renamed = await run(client => renameNode(client, boss, "req", child.node.id, child.node.revision, "二级改名"));
    assert.equal(renamed.node.title, "二级改名");
    await assert.rejects(() => run(client => renameNode(client, boss, "req", child.node.id, child.node.revision, "stale")), (error: unknown) => error instanceof SecurityApiError && error.status === 409 && error.code === API_V1_ERROR_CODES.VERSION_CHANGED);
    const moved = await run(client => moveNode(client, boss, "req", grand.node.id, grand.node.revision, root.node.id, null));
    assert.equal(moved.node.parentId, root.node.id);
    assert.equal(moved.node.depth, 2);

    // Save merge window with an injected clock: 20 saves, one version, save_count 20.
    const start = new Date("2026-11-11T10:00:00Z");
    let detail = await run(client => readNodeDetail(client, root.node.id));
    let lastResult;
    for (let index = 0; index < 20; index += 1) {
      const now = new Date(start.getTime() + index * 20_000); // 20s apart, all within 10 minutes
      lastResult = await run(client => saveContent(client, boss, root.node.id, detail.revision, { ...VALID_DOC, value: [{ type: "p", children: [{ text: `第${index}次` }] }] }, now));
      detail = await run(client => readNodeDetail(client, root.node.id));
    }
    assert.equal(lastResult!.merged, true);
    assert.equal(detail.version!.saveCount, 20);
    const versionCount = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM zzsh_docs.doc_version WHERE node_id = $1`, [root.node.id]);
    assert.equal(versionCount.rows[0]?.count, "2"); // CREATE + one merged EDIT

    // 11th minute opens a new version; a different author opens a new version.
    const late = await run(client => saveContent(client, boss, root.node.id, detail.revision, VALID_DOC, new Date(start.getTime() + DOC_MERGE_WINDOW_MS + 60_000)));
    assert.equal(late.merged, false);
    detail = await run(client => readNodeDetail(client, root.node.id));
    const otherAuthor = await run(client => saveContent(client, ops, root.node.id, detail.revision, VALID_DOC, new Date(start.getTime() + DOC_MERGE_WINDOW_MS + 120_000)));
    assert.equal(otherAuthor.merged, false);

    // Stale revision is 409 and writes nothing.
    detail = await run(client => readNodeDetail(client, root.node.id));
    await assert.rejects(() => run(client => saveContent(client, boss, root.node.id, "1", VALID_DOC, new Date())), (error: unknown) => error instanceof SecurityApiError && error.status === 409 && error.code === API_V1_ERROR_CODES.VERSION_CHANGED);

    // Version restore creates a RESTORE version, history unchanged, next edit is a new EDIT.
    const versions = await run(client => listVersions(client, root.node.id));
    const createVersion = versions.items.find(version => version.kind === "CREATE")!;
    const beforeRestoreCount = versions.items.length;
    const restored = await run(client => restoreVersion(client, boss, "req", root.node.id, detail.revision, createVersion.id));
    assert.equal(restored.version!.kind, "RESTORE");
    assert.equal(restored.version!.restoredFromVersionId, createVersion.id);
    const afterRestore = await run(client => listVersions(client, root.node.id));
    assert.equal(afterRestore.items.length, beforeRestoreCount + 1);
    const editAfterRestore = await run(client => saveContent(client, boss, root.node.id, restored.revision, VALID_DOC, new Date(start.getTime() + DOC_MERGE_WINDOW_MS + 180_000)));
    assert.equal(editAfterRestore.merged, false);

    // doc_version immutability trigger: a CREATE row and a non-latest EDIT row cannot be updated.
    await assert.rejects(() => runtimePool!.query(`UPDATE zzsh_docs.doc_version SET document = '{}'::jsonb WHERE id = $1`, [createVersion.id]), (error: { code?: string }) => error.code === "P0001");

    // Title-only search; q over 100 characters is rejected at the route layer (store accepts the bound query).
    const found = await run(client => searchNodes(client, boss, { q: "根文档" }));
    assert.ok(found.items.some(node => node.id === root.node.id));
    const none = await run(client => searchNodes(client, boss, { q: "不存在的标题xyz" }));
    assert.equal(none.items.length, 0);

    // Image references: a READY image referenced by a version is signable; an unreferenced one is not.
    const imageId = newDocId("dimg");
    const objectKey = `internal-docs/${root.node.id}/${imageId}.png`;
    await runtimePool.query(
      `INSERT INTO zzsh_docs.doc_image (id, uploaded_in_node_id, object_key, mime, bytes, width, height, status, uploaded_by_admin_id, upload_expires_at, completed_at)
       VALUES ($1, $2, $3, 'image/png', 100, 8, 8, 'READY', $4, now() + interval '5 minutes', now())`, [imageId, root.node.id, objectKey, bossId],
    );
    const docWithImage = { format: "plate", schemaVersion: 1, preset: "internal", value: [{ type: "img", imageId, alt: "图", children: [{ text: "" }] }] };
    detail = await run(client => readNodeDetail(client, root.node.id));
    await run(client => saveContent(client, boss, root.node.id, detail.revision, docWithImage, new Date(start.getTime() + DOC_MERGE_WINDOW_MS + 240_000)));
    const signable = await run(client => signableImages(client, root.node.id, [imageId]));
    assert.equal(signable.length, 1);
    assert.equal(await run(client => imageReferenced(client, imageId)), true);
    const orphanImage = newDocId("dimg");
    await runtimePool.query(
      `INSERT INTO zzsh_docs.doc_image (id, uploaded_in_node_id, object_key, mime, bytes, width, height, status, uploaded_by_admin_id, upload_expires_at, completed_at)
       VALUES ($1, $2, $3, 'image/png', 100, 8, 8, 'READY', $4, now() + interval '5 minutes', now())`, [orphanImage, root.node.id, `internal-docs/${root.node.id}/${orphanImage}.png`, bossId],
    );
    assert.equal((await run(client => signableImages(client, root.node.id, [orphanImage]))).length, 0);
    assert.equal(await run(client => imageReferenced(client, orphanImage)), false);
    // A PENDING image cannot be referenced by a saved document.
    const pending = await run(client => createImageRecord(client, boss, "req", root.node.id, { mime: "image/png", bytes: 100, width: 8, height: 8 }, new Date()));
    assert.equal(pending.image.status, "PENDING");
    detail = await run(client => readNodeDetail(client, root.node.id));
    await assert.rejects(() => run(client => saveContent(client, boss, root.node.id, detail.revision, { format: "plate", schemaVersion: 1, preset: "internal", value: [{ type: "img", imageId: pending.image.id, alt: "x", children: [{ text: "" }] }] }, new Date())), (error: unknown) => error instanceof SecurityApiError && error.status === 400);

    // Delete the subtree, trash listing, then restore into a new parent.
    detail = await run(client => readNodeDetail(client, child.node.id));
    const deleted = await run(client => deleteNode(client, boss, "req", child.node.id, detail.revision));
    assert.ok(deleted.deletedCount >= 1);
    assert.ok(deleted.purgeAt.getTime() > Date.now());
    await assert.rejects(() => run(client => readNodeDetail(client, child.node.id)), (error: unknown) => error instanceof SecurityApiError && error.status === 404);
    const trash = await run(client => listTrashForActor(client, boss));
    assert.ok(trash.items.some(item => item.batchId === deleted.batchId));
    const restoredBatch = await run(client => restoreBatch(client, boss, "req", deleted.batchId, root.node.id));
    assert.equal(restoredBatch.node.deletedAt, null);
    const afterRestoreDetail = await run(client => readNodeDetail(client, child.node.id));
    assert.equal(afterRestoreDetail.node.id, child.node.id);

    // Permission negatives: support reads but cannot manage; ops manages.
    await run(client => authorizeDocs(client, support, "read"));
    await run(client => authorizeDocs(client, support, "comment"));
    for (const action of ["manage"] as const) {
      await assert.rejects(() => run(client => authorizeDocs(client, support, action)), (error: unknown) => error instanceof SecurityApiError && error.status === 403);
    }
    await assert.rejects(() => run(client => createNode(client, support, "req", { parentId: null, title: "客服越权" })), (error: unknown) => error instanceof SecurityApiError && error.status === 403);
    await run(client => authorizeDocs(client, ops, "manage"));
    // A custom role without docs.internal.read is denied even for reads.
    const noReadId = "admin_docs_noread";
    await insertAdmin(runtimePool, noReadId, "docs_noread", false, []);
    await assert.rejects(() => run(client => authorizeDocs(client, { realm: "admin", id: noReadId, sessionId: "s" }, "read")), (error: unknown) => error instanceof SecurityApiError && error.status === 403);

    // Runtime privileges: DELETE on doc_* (purge) is granted; TRUNCATE is not.
    const privileges = await runtimePool.query<{ delete: boolean; truncate: boolean }>(
      `SELECT has_table_privilege(current_user, 'zzsh_docs.doc_node', 'DELETE') AS delete,
         has_table_privilege(current_user, 'zzsh_docs.doc_node', 'TRUNCATE') AS truncate`,
    );
    assert.equal(privileges.rows[0]?.delete, true);
    assert.equal(privileges.rows[0]?.truncate, false);
    // Audit events were recorded for the structural writes (not per auto-save).
    const audits = await runtimePool.query<{ action: string }>(`SELECT DISTINCT action FROM zzsh_iam.audit_event WHERE action LIKE 'DOC_%' ORDER BY action`);
    const actions = audits.rows.map(row => row.action);
    for (const expected of ["DOC_CREATED", "DOC_RENAMED", "DOC_MOVED", "DOC_DELETED", "DOC_UNDELETED", "DOC_VERSION_RESTORED"]) {
      assert.ok(actions.includes(expected), `missing audit ${expected}`);
    }
  } finally {
    if (runtimePool) await runtimePool.end().catch(() => undefined);
    if (migrationPool) await migrationPool.end().catch(() => undefined);
    if (maintenanceDataPool) await maintenanceDataPool.end().catch(() => undefined);
    if (guard) { try { await guard.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]); } catch { /* ignore */ } guard.release(); }
    if (maintenancePool) await maintenancePool.end().catch(() => undefined);
  }
});

async function withTransactionRuntime<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve primary */ }
    throw error;
  } finally {
    client.release();
  }
}
