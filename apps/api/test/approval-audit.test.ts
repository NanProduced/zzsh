import { strict as assert } from "node:assert";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";

import { Pool, type PoolClient } from "pg";

import { createApp } from "../src/app";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { loadConfig, type AppConfig } from "../src/config/config";

const DEFAULT_DATABASE = "zzsh_test_m2_approval_audit";
const RESOURCE_MARKER = "zzsh:m2-approval-audit-test:v1";
const LOCK_KEY = "805003";
const USER_ORIGIN = "http://127.0.0.1:3100";
const ADMIN_ORIGIN = "http://127.0.0.1:3101";
const API_ORIGIN = "http://127.0.0.1:3102";
const BUSINESS_SCHEMAS = ["zzsh_business_meta", "zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin"] as const;

type CookieJar = {
  values: Map<string, string>;
  update: (response: Response) => void;
  header: () => string;
};

type Resources = {
  maintenance: AppConfig;
  migration: AppConfig;
  runtime: AppConfig;
  databaseName: string;
  migrationUser: string;
  runtimeUser: string;
  migrationPassword: string;
  runtimePassword: string;
};

type Staff = {
  id: string;
  username: string;
  jar: CookieJar;
  password: string;
  secret: string;
};

const APPROVE = "approval.request.approve";
const ADD_APPROVER = "approval.request.add_approver";
const EXECUTE = "approval.request.execute";
const GENERIC_AUDIT = "admin.audit.read";

function cookieJar(): CookieJar {
  const values = new Map<string, string>();
  return {
    values,
    update(response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair, ...attributes] = raw.split(";");
        if (!pair) continue;
        const separator = pair.indexOf("=");
        if (separator < 1) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (attributes.some((attribute) => attribute.trim().toLowerCase() === "max-age=0")) values.delete(name);
        else values.set(name, value);
      }
    },
    header: () => [...values.entries()].map(([name, value]) => name + "=" + value).join("; "),
  };
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error(label + " is not a safe identifier");
  return value;
}

function quotedIdentifier(value: string, label: string): string {
  return "\"" + safeIdentifier(value, label) + "\"";
}

function quotedLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function roleMarker(databaseName: string, role: "migration" | "runtime"): string {
  return RESOURCE_MARKER + ":" + databaseName + ":" + role;
}

function makeResources(): Resources {
  const databaseName = process.env.M2_APPROVAL_AUDIT_TEST_DB_NAME?.trim() || DEFAULT_DATABASE;
  assert.notEqual(databaseName, "zzsh_dev");
  const migrationUser = safeIdentifier(process.env.M2_APPROVAL_AUDIT_TEST_MIGRATION_USER?.trim() || "zzsh_m2_approval_migration", "migration user");
  const runtimeUser = safeIdentifier(process.env.M2_APPROVAL_AUDIT_TEST_RUNTIME_USER?.trim() || "zzsh_m2_approval_runtime", "runtime user");
  assert.notEqual(migrationUser, runtimeUser);
  if (!migrationUser.startsWith("zzsh_m2_") || !runtimeUser.startsWith("zzsh_m2_")) throw new Error("approval audit test roles must use the isolated zzsh_m2_ prefix");
  const maintenanceUser = process.env.M2_APPROVAL_AUDIT_TEST_MAINTENANCE_USER ?? process.env.DB_USER;
  const baseEnv = {
    ...process.env,
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_NAME: databaseName,
    ...(maintenanceUser ? { DB_USER: maintenanceUser } : {}),
  };
  const maintenance = loadConfig(baseEnv);
  const migrationPassword = process.env.M2_APPROVAL_AUDIT_TEST_MIGRATION_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtimePassword = process.env.M2_APPROVAL_AUDIT_TEST_RUNTIME_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtime = loadConfig({ ...baseEnv, DB_USER: runtimeUser, DB_PASSWORD: runtimePassword, DB_PASSWORD_FILE: undefined });
  const migration = loadConfig({
    ...baseEnv,
    APP_PROFILE: "migration",
    DB_USER: undefined,
    DB_PASSWORD: undefined,
    DB_PASSWORD_FILE: undefined,
    MIGRATION_TARGET_PROFILE: "test",
    MIGRATION_TARGET_DB_NAME: databaseName,
    MIGRATION_DB_USER: migrationUser,
    MIGRATION_DB_PASSWORD: migrationPassword,
    MIGRATION_DB_PASSWORD_FILE: undefined,
    MIGRATION_RUNTIME_USER: runtimeUser,
  });
  return { maintenance, migration, runtime, databaseName, migrationUser, runtimeUser, migrationPassword, runtimePassword };
}

function poolFor(config: AppConfig, database: string, applicationName: string, max: number): Pool {
  return new Pool({
    host: config.database.host,
    port: config.database.port,
    database,
    user: config.database.user,
    password: config.database.password,
    application_name: applicationName,
    connectionTimeoutMillis: 2_000,
    max,
  });
}

async function resourceGuard(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{ databaseName: string; currentUser: string; port: string }>("SELECT current_database() AS \"databaseName\", current_user AS \"currentUser\", current_setting('port') AS port");
    assert.equal(identity.rows[0]?.databaseName, "postgres");
    assert.equal(identity.rows[0]?.currentUser, pool.options.user);
    assert.equal(identity.rows[0]?.port, "5432");
    assert.equal((await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired, true, "dedicated approval audit test target is already in use");
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function ensureDatabase(pool: Pool, resources: Resources): Promise<void> {
  const existing = await pool.query<{ owner: string; allowConnections: boolean; isTemplate: boolean; comment: string | null }>(
    "SELECT pg_get_userbyid(d.datdba) AS owner, d.datallowconn AS \"allowConnections\", d.datistemplate AS \"isTemplate\", shobj_description(d.oid, 'pg_database') AS comment FROM pg_database d WHERE d.datname = $1",
    [resources.databaseName],
  );
  if (existing.rows.length === 0) {
    await pool.query("CREATE DATABASE " + quotedIdentifier(resources.databaseName, "test database") + " OWNER " + quotedIdentifier(resources.maintenance.database.user, "maintenance user"));
    await pool.query("COMMENT ON DATABASE " + quotedIdentifier(resources.databaseName, "test database") + " IS " + quotedLiteral(RESOURCE_MARKER));
    return;
  }
  assert.equal(existing.rows[0]?.owner, resources.maintenance.database.user, "dedicated test database owner changed");
  assert.equal(existing.rows[0]?.allowConnections, true);
  assert.equal(existing.rows[0]?.isTemplate, false);
  assert.equal(existing.rows[0]?.comment, RESOURCE_MARKER, "dedicated test database marker is missing or mismatched");
}

async function ensureRole(pool: Pool, roleName: string, password: string, marker: string): Promise<void> {
  const current = await pool.query<{ comment: string | null; canLogin: boolean; isSuperuser: boolean; canCreateRole: boolean; canCreateDb: boolean; canInherit: boolean; canReplicate: boolean; canBypassRls: boolean }>(
    "SELECT shobj_description(r.oid, 'pg_authid') AS comment, r.rolcanlogin AS \"canLogin\", r.rolsuper AS \"isSuperuser\", r.rolcreaterole AS \"canCreateRole\", r.rolcreatedb AS \"canCreateDb\", r.rolinherit AS \"canInherit\", r.rolreplication AS \"canReplicate\", r.rolbypassrls AS \"canBypassRls\" FROM pg_roles r WHERE r.rolname = $1",
    [roleName],
  );
  const role = quotedIdentifier(roleName, "test role");
  if (current.rows.length > 0) {
    const row = current.rows[0]!;
    assert.equal(row.comment, marker, roleName + " marker is missing or mismatched");
    assert.deepEqual(
      [row.canLogin, row.isSuperuser, row.canCreateRole, row.canCreateDb, row.canInherit, row.canReplicate, row.canBypassRls],
      [true, false, false, false, false, false, false],
      roleName + " is not a least-privilege login role",
    );
    await pool.query("ALTER ROLE " + role + " PASSWORD " + quotedLiteral(password));
    return;
  }
  await pool.query("CREATE ROLE " + role + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD " + quotedLiteral(password));
  await pool.query("COMMENT ON ROLE " + role + " IS " + quotedLiteral(marker));
}

async function grantDatabaseAccess(pool: Pool, resources: Resources): Promise<void> {
  const database = quotedIdentifier(resources.databaseName, "test database");
  await pool.query("GRANT CONNECT ON DATABASE " + database + " TO " + quotedIdentifier(resources.migrationUser, "migration user") + ", " + quotedIdentifier(resources.runtimeUser, "runtime user"));
  await pool.query("GRANT CREATE ON DATABASE " + database + " TO " + quotedIdentifier(resources.migrationUser, "migration user"));
}

async function prepareOwnership(pool: Pool, resources: Resources): Promise<void> {
  const migrationRole = quotedIdentifier(resources.migrationUser, "migration user");
  for (const schemaName of BUSINESS_SCHEMAS) {
    const schema = quotedIdentifier(schemaName, "business schema");
    const ownerResult = await pool.query<{ owner: string }>("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1", [schemaName]);
    if (ownerResult.rows.length === 0) await pool.query("CREATE SCHEMA " + schema);
    else assert.ok([resources.maintenance.database.user, resources.migrationUser].includes(ownerResult.rows[0]!.owner), "business schema owner is outside the dedicated test target");
    const owner = ownerResult.rows.length === 0 ? resources.maintenance.database.user : ownerResult.rows[0]!.owner;
    if (owner !== resources.migrationUser) await pool.query("ALTER SCHEMA " + schema + " OWNER TO " + migrationRole);
  }
  const relations = await pool.query<{ schemaName: string; relationName: string; kind: string; owner: string }>(
    "SELECT n.nspname AS \"schemaName\", c.relname AS \"relationName\", c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'S')",
    [BUSINESS_SCHEMAS],
  );
  for (const row of relations.rows) {
    assert.ok([resources.maintenance.database.user, resources.migrationUser].includes(row.owner), "business relation owner is outside the dedicated test target");
    if (row.owner !== resources.migrationUser) {
      const relation = quotedIdentifier(row.schemaName, "business schema") + "." + "\"" + row.relationName.replaceAll("\"", "\"\"") + "\"";
      await pool.query((row.kind === "S" ? "ALTER SEQUENCE " : "ALTER TABLE ") + relation + " OWNER TO " + migrationRole);
    }
  }
}

async function resetBusinessData(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE \"zzsh_iam\".\"approval_execution\", \"zzsh_iam\".\"approval_decision\", \"zzsh_iam\".\"approval_request_candidate\", \"zzsh_iam\".\"approval_request\", \"zzsh_iam\".\"approval_template_candidate\", \"zzsh_iam\".\"approval_template\", \"zzsh_iam\".\"admin_user_permission\", \"zzsh_iam\".\"admin_user_role\", \"zzsh_iam\".\"admin_role_permission\", \"zzsh_iam\".\"admin_recovery_request\", \"zzsh_iam\".\"admin_recovery_notification_target\", \"zzsh_iam\".\"admin_security_notification_outbox\", \"zzsh_auth_admin\".\"twoFactor\", \"zzsh_auth_admin\".\"verification\", \"zzsh_auth_admin\".\"session\", \"zzsh_auth_admin\".\"account\", \"zzsh_auth_admin\".\"user\", \"zzsh_auth_user\".\"twoFactor\", \"zzsh_auth_user\".\"verification\", \"zzsh_auth_user\".\"session\", \"zzsh_auth_user\".\"account\", \"zzsh_auth_user\".\"user\", \"zzsh_iam\".\"admin_security\", \"zzsh_iam\".\"audit_event\" CASCADE");
  await pool.query("DELETE FROM \"zzsh_iam\".\"admin_role\" WHERE \"code\" NOT IN ('ops', 'support')");
  await pool.query("DELETE FROM \"zzsh_iam\".\"admin_role_permission\"");
}

function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("invalid TOTP fixture");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secret: string, timestamp = Date.now()): string {
  const counter = Math.floor(timestamp / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(value % 1_000_000).padStart(6, "0");
}

async function readJson(response: Response): Promise<Record<string, any> | null> {
  const text = await response.text();
  return text ? JSON.parse(text) as Record<string, any> : null;
}

async function request(base: string, path: string, body: Record<string, unknown> | undefined, jar: CookieJar, origin: string): Promise<{ response: Response; body: Record<string, any> | null }> {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(jar.header() ? { cookie: jar.header() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jar.update(response);
  return { response, body: await readJson(response) };
}

async function activate(base: string, username: string, temporaryPassword: string): Promise<Staff> {
  const jar = cookieJar();
  assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username, password: temporaryPassword }, jar, ADMIN_ORIGIN)).response.status, 200);
  const password = randomBytes(24).toString("base64url");
  assert.equal((await request(base, "/api/auth/admin/change-password", { currentPassword: temporaryPassword, newPassword: password }, jar, ADMIN_ORIGIN)).response.status, 200);
  const enabled = await request(base, "/api/auth/admin/two-factor/enable", { password }, jar, ADMIN_ORIGIN);
  assert.equal(enabled.response.status, 200);
  const secret = new URL(enabled.body?.totpURI as string).searchParams.get("secret");
  assert.ok(secret);
  assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(secret) }, jar, ADMIN_ORIGIN)).response.status, 200);
  assert.equal((await request(base, "/api/v1/admin/security/enrollment/activate", {}, jar, ADMIN_ORIGIN)).response.status, 200);
  const session = await request(base, "/api/bff/admin/session", undefined, jar, ADMIN_ORIGIN);
  assert.equal(session.body?.authenticated, true);
  return { id: session.body?.adminUserId as string, username, jar, password, secret };
}

async function bff(base: string, path: string, body: Record<string, unknown> | undefined, actor: Staff): Promise<{ response: Response; body: Record<string, any> | null }> {
  return request(base, "/api/bff/admin" + path, body, actor.jar, ADMIN_ORIGIN);
}

async function direct(base: string, path: string, body: Record<string, unknown> | undefined, actor: Staff): Promise<{ response: Response; body: Record<string, any> | null }> {
  return request(base, "/api/v1/admin/security" + path, body, actor.jar, API_ORIGIN);
}

async function configure(base: string, actor: Staff, operation: string, trigger: string, candidates: string[]): Promise<number> {
  const result = await bff(base, "/security/approvals/templates/update", { operationCode: operation, triggerCondition: trigger, candidateUsernames: candidates }, actor);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body?.version as number;
}

async function createRequest(base: string, actor: Staff, operation: string, trigger: string, outcome: "SUCCESS" | "FAILURE", summary: string, supersedesRequestId?: string): Promise<string> {
  const result = await bff(base, "/security/approvals/requests", {
    operationCode: operation,
    triggerCondition: trigger,
    payloadVersion: 1,
    payload: { outcome },
    summary,
    ...(supersedesRequestId ? { supersedesRequestId } : {}),
  }, actor);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.ok(result.body?.requestId);
  return result.body.requestId as string;
}

async function detail(base: string, actor: Staff, requestId: string): Promise<{ response: Response; body: Record<string, any> | null }> {
  return bff(base, "/security/approvals/requests/detail?requestId=" + encodeURIComponent(requestId), undefined, actor);
}

async function decide(base: string, actor: Staff, requestId: string, decision: "APPROVE" | "REJECT", reason?: string): Promise<{ response: Response; body: Record<string, any> | null }> {
  return bff(base, "/security/approvals/requests/decision", { requestId, decision, ...(reason ? { reason } : {}) }, actor);
}

async function execute(base: string, actor: Staff, requestId: string): Promise<{ response: Response; body: Record<string, any> | null }> {
  return bff(base, "/security/approvals/requests/execute", { requestId }, actor);
}

test("M2-C approval and authorized audit query enforce the minimum workflow", async () => {
  let resources: Resources | undefined;
  let maintenancePool: Pool | undefined;
  let maintenanceDataPool: Pool | undefined;
  let migrationPool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let guard: PoolClient | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let runtimeClosedByApp = false;
  try {
    resources = makeResources();
    maintenancePool = poolFor(resources.maintenance, "postgres", "zzsh-m2-approval-maintenance", 2);
    guard = await resourceGuard(maintenancePool);
    await ensureDatabase(maintenancePool, resources);
    await ensureRole(maintenancePool, resources.migrationUser, resources.migrationPassword, roleMarker(resources.databaseName, "migration"));
    await ensureRole(maintenancePool, resources.runtimeUser, resources.runtimePassword, roleMarker(resources.databaseName, "runtime"));
    await grantDatabaseAccess(maintenancePool, resources);
    maintenanceDataPool = poolFor(resources.maintenance, resources.databaseName, "zzsh-m2-approval-owner", 2);
    await prepareOwnership(maintenanceDataPool, resources);
    migrationPool = createBusinessPool(resources.migration);
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    runtimePool = createBusinessPool(resources.runtime);
    await assertBusinessRuntimeIdentity(runtimePool, resources.runtime);
    await resetBusinessData(migrationPool);

    const bootstrapSecret = randomBytes(32).toString("hex");
    const authOptions = {
      ...loadAuthRuntimeConfig({
        AUTH_API_ORIGIN: API_ORIGIN,
        AUTH_USER_ORIGIN: USER_ORIGIN,
        AUTH_ADMIN_ORIGIN: ADMIN_ORIGIN,
        AUTH_USER_SECRET: randomBytes(32).toString("hex"),
        AUTH_ADMIN_SECRET: randomBytes(32).toString("hex"),
        AUTH_ADMIN_BOOTSTRAP_SECRET: bootstrapSecret,
      }, undefined, { testOperationsEnabled: true }),
      pool: runtimePool,
    };
    app = await createApp({
      health: {
        dependencies: {
          postgres: { check: async () => undefined, close: async () => undefined },
          redis: { check: async () => undefined, close: async () => undefined },
        },
      },
      database: { pool: runtimePool },
      auth: authOptions,
    });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();

    const bossInitialPassword = randomBytes(24).toString("base64url");
    const bootstrap = await request(base, "/api/v1/admin/security/bootstrap", { bootstrapSecret, name: "审批 Boss", password: bossInitialPassword }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(bootstrap.response.status, 200);
    const bossUsername = bootstrap.body?.username as string;
    const boss = await activate(base, bossUsername, bossInitialPassword);

    async function createStaff(name: string, permissions: string[]): Promise<Staff> {
      const created = await request(base, "/api/v1/admin/security/admins/create", { name, allowPermissions: permissions }, boss.jar, ADMIN_ORIGIN);
      assert.equal(created.response.status, 200);
      return activate(base, created.body?.username as string, created.body?.temporaryPassword as string);
    }

    const candidateOne = await createStaff("审批员一", [APPROVE, "approval.request.read", ADD_APPROVER, "approval.audit.read"]);
    const candidateTwo = await createStaff("审批员二", [APPROVE, "approval.request.read"]);
    const candidateThree = await createStaff("冻结候选人", [APPROVE, "approval.request.read"]);
    const requester = await createStaff("申请人", ["approval.request.create", "approval.request.read", EXECUTE, ADD_APPROVER]);
    const unrelated = await createStaff("无关管理员", [APPROVE, "approval.request.read", ADD_APPROVER, EXECUTE]);
    const genericReader = await createStaff("通用审计员", [GENERIC_AUDIT]);
    const accountReader = await createStaff("仅账号读取", ["admin.account.read"]);

    const templates = await bff(base, "/security/approvals/templates", undefined, boss);
    assert.equal(templates.response.status, 200);
    assert.ok(Array.isArray(templates.body?.templates));

    await configure(base, boss, "approval.test.execute", "manual", [boss.username, candidateOne.username]);
    const selfRequestId = await createRequest(base, boss, "approval.test.execute", "manual", "SUCCESS", "Boss 自审阻断");
    const selfDecision = await decide(base, boss, selfRequestId, "APPROVE");
    assert.equal(selfDecision.response.status, 403, "self approval must be rejected");
    assert.equal((await detail(base, boss, selfRequestId)).body?.status, "PENDING");

    await configure(base, boss, "approval.no.eligible", "manual", [candidateThree.username]);
    const freeze = await request(base, "/api/v1/admin/security/freeze", { targetAdminId: candidateThree.id, password: boss.password, totpCode: totpCode(boss.secret), reason: "M2-C 无资格验证" }, boss.jar, ADMIN_ORIGIN);
    assert.equal(freeze.response.status, 200);
    const noEligibleId = await createRequest(base, requester, "approval.no.eligible", "manual", "SUCCESS", "冻结后无合格审批人");
    const noEligibleDetail = await detail(base, requester, noEligibleId);
    assert.equal(noEligibleDetail.response.status, 200);
    assert.equal(noEligibleDetail.body?.status, "PENDING");
    assert.equal(noEligibleDetail.body?.candidates?.[0]?.eligible, false);
    const frozenDecision = await decide(base, candidateThree, noEligibleId, "APPROVE");
    assert.ok([401, 403].includes(frozenDecision.response.status), "frozen candidate cannot approve");
    const unfreeze = await request(base, "/api/v1/admin/security/unfreeze", { targetAdminId: candidateThree.id, password: boss.password, totpCode: totpCode(boss.secret), reason: "M2-C 无资格验证结束" }, boss.jar, ADMIN_ORIGIN);
    assert.equal(unfreeze.response.status, 200);

    await configure(base, boss, "approval.concurrent", "manual", [candidateOne.username, candidateTwo.username]);
    const concurrentId = await createRequest(base, requester, "approval.concurrent", "manual", "SUCCESS", "并发首个决定");
    const pendingForCandidate = await bff(base, "/security/approvals/requests/pending?limit=20", undefined, candidateOne);
    assert.equal(pendingForCandidate.response.status, 200);
    assert.ok(pendingForCandidate.body?.requests?.some((item: { requestId?: string }) => item.requestId === concurrentId));
    const concurrentResults = await Promise.all([
      decide(base, candidateOne, concurrentId, "APPROVE"),
      decide(base, candidateTwo, concurrentId, "REJECT", "并发拒绝不应覆盖"),
    ]);
    assert.equal(concurrentResults.filter((item) => item.response.status === 200).length, 1);
    assert.equal(concurrentResults.filter((item) => item.response.status === 409).length, 1);
    const concurrentDb = await runtimePool.query<{ status: string; decisions: string }>(
      "SELECT r.\"status\", (SELECT count(*)::text FROM \"zzsh_iam\".\"approval_decision\" d WHERE d.\"request_id\" = r.\"id\") AS decisions FROM \"zzsh_iam\".\"approval_request\" r WHERE r.\"id\" = $1",
      [concurrentId],
    );
    assert.equal(["APPROVED", "REJECTED"].includes(concurrentDb.rows[0]?.status ?? ""), true);
    assert.equal(concurrentDb.rows[0]?.decisions, "1");

    await configure(base, boss, "approval.template.change", "manual", [candidateOne.username]);
    const oldTemplateRequest = await createRequest(base, requester, "approval.template.change", "manual", "SUCCESS", "模板旧名单快照");
    const oldTemplateDetail = await detail(base, requester, oldTemplateRequest);
    assert.equal(oldTemplateDetail.body?.candidates?.[0]?.username, candidateOne.username.toLowerCase());
    const changedVersion = await configure(base, boss, "approval.template.change", "manual", [candidateTwo.username]);
    const newTemplateRequest = await createRequest(base, requester, "approval.template.change", "manual", "SUCCESS", "模板新名单快照");
    const newTemplateDetail = await detail(base, requester, newTemplateRequest);
    assert.equal(newTemplateDetail.body?.template?.version, changedVersion);
    assert.equal(newTemplateDetail.body?.candidates?.[0]?.username, candidateTwo.username.toLowerCase());
    assert.equal((await detail(base, requester, oldTemplateRequest)).body?.candidates?.[0]?.username, candidateOne.username.toLowerCase());

    await configure(base, boss, "approval.payload.change", "manual", [candidateTwo.username]);
    const payloadOld = await createRequest(base, requester, "approval.payload.change", "manual", "FAILURE", "旧载荷");
    const payloadNew = await createRequest(base, requester, "approval.payload.change", "manual", "SUCCESS", "新载荷", payloadOld);
    const payloadOldDb = await runtimePool.query<{ status: string; supersededBy: string | null }>(
      "SELECT \"status\", \"superseded_by_request_id\" AS \"supersededBy\" FROM \"zzsh_iam\".\"approval_request\" WHERE \"id\" = $1",
      [payloadOld],
    );
    assert.equal(payloadOldDb.rows[0]?.status, "CANCELLED");
    assert.equal(payloadOldDb.rows[0]?.supersededBy, payloadNew);
    assert.equal((await decide(base, candidateTwo, payloadOld, "APPROVE")).response.status, 409);
    assert.equal((await detail(base, requester, payloadNew)).body?.status, "PENDING");

    await configure(base, boss, "approval.append", "manual", [candidateOne.username]);
    const appendRequest = await createRequest(base, requester, "approval.append", "manual", "SUCCESS", "追加合法审批人");
    const appendBefore = await detail(base, requester, appendRequest);
    assert.equal(appendBefore.body?.status, "PENDING");
    assert.equal(appendBefore.body?.decision, null);
    assert.deepEqual(appendBefore.body?.candidates?.map((item: { username?: string }) => item.username), [candidateOne.username.toLowerCase()]);
    const appendAuditBefore = await runtimePool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM \"zzsh_iam\".\"audit_event\" WHERE \"object_type\" = 'approval_request' AND \"object_id\" = $1 AND \"action\" = 'approval.request.candidate_added'",
      [appendRequest],
    );
    const unrelatedOther = await bff(base, "/security/approvals/requests/add-candidate", { requestId: appendRequest, username: candidateTwo.username, reason: "无关管理员不得追加他人" }, unrelated);
    assert.equal(unrelatedOther.response.status, 403);
    const unrelatedSelf = await direct(base, "/approvals/requests/add-candidate", { requestId: appendRequest, username: unrelated.username, reason: "无关管理员不得自追加" }, unrelated);
    assert.equal(unrelatedSelf.response.status, 403);
    const candidateOneOther = await direct(base, "/approvals/requests/add-candidate", { requestId: appendRequest, username: candidateTwo.username, reason: "候选人不是流程负责人" }, candidateOne);
    assert.equal(candidateOneOther.response.status, 403);
    const appendAfterUnauthorized = await detail(base, requester, appendRequest);
    assert.equal(appendAfterUnauthorized.body?.status, "PENDING");
    assert.equal(appendAfterUnauthorized.body?.decision, null);
    assert.deepEqual(appendAfterUnauthorized.body?.candidates?.map((item: { username?: string }) => item.username), [candidateOne.username.toLowerCase()]);
    const appendAuditAfter = await runtimePool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM \"zzsh_iam\".\"audit_event\" WHERE \"object_type\" = 'approval_request' AND \"object_id\" = $1 AND \"action\" = 'approval.request.candidate_added'",
      [appendRequest],
    );
    assert.equal(appendAuditAfter.rows[0]?.count, appendAuditBefore.rows[0]?.count, "unauthorized append must not create a success audit");
    const appended = await bff(base, "/security/approvals/requests/add-candidate", { requestId: appendRequest, username: candidateTwo.username, reason: "申请人临时增加当前合格候选人" }, requester);
    assert.equal(appended.response.status, 200);
    const appendDetail = await detail(base, requester, appendRequest);
    assert.equal(appendDetail.body?.candidates?.length, 2);
    assert.ok(appendDetail.body?.candidates?.some((item: { username?: string; source?: string }) => item.username === candidateOne.username.toLowerCase() && item.source === "TEMPLATE"));
    assert.ok(appendDetail.body?.candidates?.some((item: { username?: string; source?: string }) => item.username === candidateTwo.username.toLowerCase() && item.source === "APPENDED"));

    await configure(base, boss, "approval.expired.pending", "manual", [candidateOne.username]);
    const expiredPendingId = await createRequest(base, requester, "approval.expired.pending", "manual", "SUCCESS", "无关管理员不能使待审批过期");
    await migrationPool.query("UPDATE \"zzsh_iam\".\"approval_request\" SET \"expires_at\" = clock_timestamp() - interval '1 second' WHERE \"id\" = $1", [expiredPendingId]);
    const expiredPendingAuditBefore = await runtimePool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM \"zzsh_iam\".\"audit_event\" WHERE \"object_type\" = 'approval_request' AND \"object_id\" = $1 AND \"action\" = 'approval.request.expired'",
      [expiredPendingId],
    );
    assert.equal((await direct(base, "/approvals/requests/decision", { requestId: expiredPendingId, decision: "APPROVE" }, unrelated)).response.status, 403);
    assert.equal((await execute(base, unrelated, expiredPendingId)).response.status, 403);
    assert.equal((await direct(base, "/approvals/requests/add-candidate", { requestId: expiredPendingId, username: candidateTwo.username, reason: "无关管理员不能使待审批过期" }, unrelated)).response.status, 403);
    const expiredPendingUnchanged = await runtimePool.query<{ status: string; decisions: string; candidates: string }>(
      "SELECT r.\"status\", (SELECT count(*)::text FROM \"zzsh_iam\".\"approval_decision\" d WHERE d.\"request_id\" = r.\"id\") AS decisions, (SELECT count(*)::text FROM \"zzsh_iam\".\"approval_request_candidate\" c WHERE c.\"request_id\" = r.\"id\") AS candidates FROM \"zzsh_iam\".\"approval_request\" r WHERE r.\"id\" = $1",
      [expiredPendingId],
    );
    assert.deepEqual(expiredPendingUnchanged.rows[0], { status: "PENDING", decisions: "0", candidates: "1" });
    const expiredPendingAuditAfter = await runtimePool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM \"zzsh_iam\".\"audit_event\" WHERE \"object_type\" = 'approval_request' AND \"object_id\" = $1 AND \"action\" = 'approval.request.expired'",
      [expiredPendingId],
    );
    assert.equal(expiredPendingAuditAfter.rows[0]?.count, expiredPendingAuditBefore.rows[0]?.count, "unrelated expired calls must not create an expiry audit");
    assert.equal((await direct(base, "/approvals/requests/decision", { requestId: expiredPendingId, decision: "APPROVE" }, candidateOne)).response.status, 409);
    assert.equal((await runtimePool.query<{ status: string }>("SELECT \"status\" FROM \"zzsh_iam\".\"approval_request\" WHERE \"id\" = $1", [expiredPendingId])).rows[0]?.status, "EXPIRED");

    await configure(base, boss, "approval.expired.approved", "manual", [candidateOne.username]);
    const expiredApprovedId = await createRequest(base, requester, "approval.expired.approved", "manual", "SUCCESS", "无关管理员不能使已通过过期");
    assert.equal((await decide(base, candidateOne, expiredApprovedId, "APPROVE")).response.status, 200);
    await migrationPool.query("UPDATE \"zzsh_iam\".\"approval_request\" SET \"expires_at\" = clock_timestamp() - interval '1 second' WHERE \"id\" = $1", [expiredApprovedId]);
    const expiredApprovedAuditBefore = await runtimePool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM \"zzsh_iam\".\"audit_event\" WHERE \"object_type\" = 'approval_request' AND \"object_id\" = $1 AND \"action\" = 'approval.request.expired'",
      [expiredApprovedId],
    );
    assert.equal((await decide(base, unrelated, expiredApprovedId, "REJECT", "无关管理员不能改写已通过申请")).response.status, 403);
    assert.equal((await direct(base, "/approvals/requests/execute", { requestId: expiredApprovedId }, unrelated)).response.status, 403);
    assert.equal((await bff(base, "/security/approvals/requests/add-candidate", { requestId: expiredApprovedId, username: candidateTwo.username, reason: "无关管理员不能追加已通过申请" }, unrelated)).response.status, 403);
    const expiredApprovedUnchanged = await runtimePool.query<{ status: string; executions: string; candidates: string }>(
      "SELECT r.\"status\", (SELECT count(*)::text FROM \"zzsh_iam\".\"approval_execution\" e WHERE e.\"request_id\" = r.\"id\") AS executions, (SELECT count(*)::text FROM \"zzsh_iam\".\"approval_request_candidate\" c WHERE c.\"request_id\" = r.\"id\") AS candidates FROM \"zzsh_iam\".\"approval_request\" r WHERE r.\"id\" = $1",
      [expiredApprovedId],
    );
    assert.deepEqual(expiredApprovedUnchanged.rows[0], { status: "APPROVED", executions: "0", candidates: "1" });
    const expiredApprovedAuditAfter = await runtimePool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM \"zzsh_iam\".\"audit_event\" WHERE \"object_type\" = 'approval_request' AND \"object_id\" = $1 AND \"action\" = 'approval.request.expired'",
      [expiredApprovedId],
    );
    assert.equal(expiredApprovedAuditAfter.rows[0]?.count, expiredApprovedAuditBefore.rows[0]?.count, "unrelated approved-expiry calls must not create an expiry audit");
    assert.equal((await execute(base, requester, expiredApprovedId)).response.status, 409);
    assert.equal((await runtimePool.query<{ status: string }>("SELECT \"status\" FROM \"zzsh_iam\".\"approval_request\" WHERE \"id\" = $1", [expiredApprovedId])).rows[0]?.status, "EXPIRED");

    await configure(base, boss, "approval.test.execute", "execute", [candidateOne.username]);
    const successfulExecutionId = await createRequest(base, requester, "approval.test.execute", "execute", "SUCCESS", "非资金成功执行");
    assert.equal((await decide(base, candidateOne, successfulExecutionId, "APPROVE")).response.status, 200);
    assert.equal((await execute(base, requester, successfulExecutionId)).response.status, 200);
    assert.equal((await execute(base, requester, successfulExecutionId)).response.status, 409);
    const successfulExecutionDb = await runtimePool.query<{ status: string; executions: string }>(
      "SELECT r.\"status\", (SELECT count(*)::text FROM \"zzsh_iam\".\"approval_execution\" e WHERE e.\"request_id\" = r.\"id\") AS executions FROM \"zzsh_iam\".\"approval_request\" r WHERE r.\"id\" = $1",
      [successfulExecutionId],
    );
    assert.deepEqual(successfulExecutionDb.rows[0], { status: "EXECUTED", executions: "1" });

    const failedExecutionId = await createRequest(base, requester, "approval.test.execute", "execute", "FAILURE", "非资金失败执行");
    assert.equal((await decide(base, candidateOne, failedExecutionId, "APPROVE")).response.status, 200);
    const failedExecution = await execute(base, requester, failedExecutionId);
    assert.equal(failedExecution.response.status, 200);
    assert.equal(failedExecution.body?.executionStatus, "FAILED");
    assert.equal((await execute(base, requester, failedExecutionId)).response.status, 409);
    const expiredExecutionId = await createRequest(base, requester, "approval.test.execute", "execute", "SUCCESS", "过期执行阻断");
    assert.equal((await decide(base, candidateOne, expiredExecutionId, "APPROVE")).response.status, 200);
    await migrationPool.query("UPDATE \"zzsh_iam\".\"approval_request\" SET \"expires_at\" = clock_timestamp() - interval '1 second' WHERE \"id\" = $1", [expiredExecutionId]);
    assert.equal((await execute(base, requester, expiredExecutionId)).response.status, 409);
    const expiredExecutionDb = await runtimePool.query<{ status: string; executions: string }>(
      "SELECT r.\"status\", (SELECT count(*)::text FROM \"zzsh_iam\".\"approval_execution\" e WHERE e.\"request_id\" = r.\"id\") AS executions FROM \"zzsh_iam\".\"approval_request\" r WHERE r.\"id\" = $1",
      [expiredExecutionId],
    );
    assert.deepEqual(expiredExecutionDb.rows[0], { status: "EXPIRED", executions: "0" });

    await configure(base, boss, "approval.audit.rollback", "manual", [candidateOne.username]);
    await migrationPool.query("REVOKE INSERT ON TABLE \"zzsh_iam\".\"audit_event\" FROM " + quotedIdentifier(resources.runtimeUser, "runtime user"));
    try {
      const rollbackAttempt = await bff(base, "/security/approvals/requests", { operationCode: "approval.audit.rollback", triggerCondition: "manual", payloadVersion: 1, payload: { outcome: "SUCCESS" }, summary: "审计失败回滚" }, boss);
      assert.equal(rollbackAttempt.response.status, 500, "audit insert failure must be exposed as an internal failure");
    } finally {
      await migrationPool.query("GRANT INSERT ON TABLE \"zzsh_iam\".\"audit_event\" TO " + quotedIdentifier(resources.runtimeUser, "runtime user"));
    }
    const rollbackTemplate = await runtimePool.query<{ count: string }>("SELECT count(*)::text AS count FROM \"zzsh_iam\".\"approval_template\" WHERE \"operation_code\" = 'approval.audit.rollback'");
    assert.equal(rollbackTemplate.rows[0]?.count, "1");
    const rollbackRequestCount = await runtimePool.query<{ count: string }>("SELECT count(*)::text AS count FROM \"zzsh_iam\".\"approval_request\" WHERE \"operation_code\" = 'approval.audit.rollback'");
    assert.equal(rollbackRequestCount.rows[0]?.count, "0", "request state must roll back when audit insert fails");

    await configure(base, boss, "approval.audit.scope", "manual", [candidateTwo.username]);
    const scopedRequestId = await createRequest(base, requester, "approval.audit.scope", "manual", "SUCCESS", "范围隔离申请");
    assert.equal((await detail(base, candidateOne, scopedRequestId)).response.status, 404);
    const unauthorizedAudit = await bff(base, "/security/approvals/audit/events?limit=20", undefined, requester);
    assert.equal(unauthorizedAudit.response.status, 403);
    await migrationPool.query(
      "INSERT INTO \"zzsh_iam\".\"audit_event\" (\"id\", \"actor_type\", \"actor_id\", \"action\", \"object_type\", \"object_id\", \"outcome\", \"request_id\", \"reason\", \"occurred_at\", \"details\") VALUES ($1, 'admin', $2, 'approval.audit.sensitive', 'approval_request', $3, 'SUCCESS', $4, NULL, clock_timestamp(), $5::jsonb)",
      ["audit_fixture_" + randomUUID().replaceAll("-", ""), candidateOne.id, appendRequest, "fixture_request", JSON.stringify({ password: "fixture-password", token: "fixture-token", safe: "visible" })],
    );
    const candidateAudit = await bff(base, "/security/approvals/audit/events?limit=100", undefined, candidateOne);
    assert.equal(candidateAudit.response.status, 200);
    const candidateAuditText = JSON.stringify(candidateAudit.body);
    assert.equal(candidateAuditText.includes("fixture-password"), false);
    assert.equal(candidateAuditText.includes("fixture-token"), false);
    assert.equal(candidateAuditText.includes("visible"), true);
    const bossAudit = await bff(base, "/security/approvals/audit/events?requestId=" + encodeURIComponent(appendRequest) + "&limit=100", undefined, boss);
    assert.equal(bossAudit.response.status, 200);
    assert.ok(bossAudit.body?.events?.some((item: { action?: string }) => item.action === "approval.audit.sensitive"));

    const genericSnapshot = await bff(base, "/session", undefined, genericReader);
    assert.equal(genericSnapshot.body?.permissions?.includes(GENERIC_AUDIT), true);
    const accountOnlyAudit = await bff(base, "/security/audit/events?limit=20", undefined, accountReader);
    assert.equal(accountOnlyAudit.response.status, 403, "account.read must not imply generic audit read");
    const genericFixtureId = "generic_audit_" + randomUUID().replaceAll("-", "");
    await migrationPool.query(
      "INSERT INTO \"zzsh_iam\".\"audit_event\" (\"id\", \"actor_type\", \"actor_id\", \"action\", \"object_type\", \"object_id\", \"outcome\", \"request_id\", \"reason\", \"occurred_at\", \"details\") VALUES ($1, 'admin', $2, 'admin.account.updated', 'admin_user', $3, 'SUCCESS', $4, NULL, clock_timestamp(), $5::jsonb)",
      [genericFixtureId, boss.id, genericReader.id, "generic_fixture_request", JSON.stringify({ password: "fixture-password", token: "fixture-token", safe: "visible" })],
    );
    await migrationPool.query(
      "INSERT INTO \"zzsh_iam\".\"audit_event\" (\"id\", \"actor_type\", \"actor_id\", \"action\", \"object_type\", \"object_id\", \"outcome\", \"request_id\", \"reason\", \"occurred_at\", \"details\") VALUES ($1, 'admin', $2, 'admin.account.updated', 'admin_user', $3, 'SUCCESS', $4, NULL, clock_timestamp(), '{}'::jsonb)",
      ["generic_horizontal_" + randomUUID().replaceAll("-", ""), candidateOne.id, candidateTwo.id, "generic_horizontal_request"],
    );
    const ownGenericAudit = await bff(base, "/security/audit/events?objectId=" + encodeURIComponent(genericReader.id) + "&limit=100", undefined, genericReader);
    assert.equal(ownGenericAudit.response.status, 200);
    assert.ok(ownGenericAudit.body?.events?.some((item: { eventId?: string }) => item.eventId === genericFixtureId));
    const ownGenericAuditText = JSON.stringify(ownGenericAudit.body);
    assert.equal(ownGenericAuditText.includes("fixture-password"), false);
    assert.equal(ownGenericAuditText.includes("fixture-token"), false);
    assert.equal(ownGenericAuditText.includes("visible"), true);
    const horizontalGenericAudit = await bff(base, "/security/audit/events?objectId=" + encodeURIComponent(candidateTwo.id) + "&limit=100", undefined, genericReader);
    assert.equal(horizontalGenericAudit.response.status, 200);
    assert.equal(horizontalGenericAudit.body?.events?.some((item: { eventId?: string }) => item.eventId === genericFixtureId), false);
    const invalidAuditFilter = await bff(base, "/security/audit/events?action=approval.request.created", undefined, boss);
    assert.equal(invalidAuditFilter.response.status, 400, "generic audit must not accept approval actions");
    const invalidAuditObject = await bff(base, "/security/audit/events?objectType=approval_request", undefined, boss);
    assert.equal(invalidAuditObject.response.status, 400, "generic audit must not accept approval objects");
    const firstGenericPage = await bff(base, "/security/audit/events?limit=1", undefined, boss);
    assert.equal(firstGenericPage.response.status, 200);
    assert.equal(firstGenericPage.body?.events?.length, 1);
    assert.ok(firstGenericPage.body?.nextCursor);
    const secondGenericPage = await bff(base, "/security/audit/events?limit=1&cursor=" + encodeURIComponent(firstGenericPage.body?.nextCursor as string), undefined, boss);
    assert.equal(secondGenericPage.response.status, 200);
    assert.notEqual(secondGenericPage.body?.events?.[0]?.eventId, firstGenericPage.body?.events?.[0]?.eventId);
    const deniedGeneric = await bff(base, "/security/admins/assign", { username: genericReader.username, roleIds: [], allowPermissions: [], denyPermissions: [GENERIC_AUDIT] }, boss);
    assert.equal(deniedGeneric.response.status, 200);
    assert.equal((await bff(base, "/security/audit/events?limit=20", undefined, genericReader)).response.status, 403, "personal DENY must remain effective on audit query");
    assert.equal((await bff(base, "/security/audit/events", {}, boss)).response.status, 404, "generic audit is read-only");

    await assert.rejects(
      () => runtimePool!.query("UPDATE \"zzsh_iam\".\"approval_request\" SET \"operation_code\" = 'tampered' WHERE \"id\" = $1", [appendRequest]),
      /permission denied/,
      "runtime must not edit immutable operation payload",
    );
    await assert.rejects(
      () => runtimePool!.query("UPDATE \"zzsh_iam\".\"approval_decision\" SET \"reason\" = 'tampered' WHERE \"request_id\" = $1", [successfulExecutionId]),
      /permission denied/,
      "runtime must not edit approval decisions",
    );
    await assert.rejects(
      () => runtimePool!.query("DELETE FROM \"zzsh_iam\".\"audit_event\" WHERE \"id\" = 'missing'", []),
      /permission denied/,
      "runtime must not delete audit events",
    );
  } finally {
    const cleanupErrors: unknown[] = [];
    if (app) {
      try {
        await app.close();
        runtimeClosedByApp = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (runtimePool && !runtimeClosedByApp) {
      try { await runtimePool.end(); } catch (error) { cleanupErrors.push(error); }
    }
    if (guard) {
      try {
        await guard.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
        guard.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const pool of [migrationPool, maintenanceDataPool, maintenancePool]) {
      if (!pool) continue;
      try { await pool.end(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
  }
});
