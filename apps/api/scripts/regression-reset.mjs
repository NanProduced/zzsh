// Controlled reset of the one named regression database. No FORCE, no CASCADE, no adoption: the
// database must be the one this task created (recorded OID in the private state file) or absent with
// an explicit creation flag. Every reset records the retiring OID, the new creation receipt and a new
// run nonce that the suites must present.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "pg";

const DATABASE = "zzsh_test_regression";
const MARKER = "zzsh:regression-test:v1";
const LOCK_KEY = "806006";
const MIGRATION_ROLE = "zzsh_regression_migration";
const RUNTIME_ROLE = "zzsh_regression_runtime";
const STATE_PATH = resolve(process.cwd(), ".secrets/local-postgresql/regression_test/resource.json");

function resolveSecret() {
  if (process.env.DB_PASSWORD) return process.env.DB_PASSWORD.trim();
  const file = process.env.DB_PASSWORD_FILE?.trim();
  if (!file) throw new Error("DB_PASSWORD or DB_PASSWORD_FILE is required");
  return readFileSync(resolve(process.cwd(), file), "utf8").trim();
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
const fail = (message) => { throw new Error(message); };

function verifyAuthorization() {
  // The permanent developer entry is guarded by the local server identity, the registered
  // resource name/marker/OID and the explicit creation flag below. A task shell may additionally
  // bind a time-boxed authorization file; it is never required by the ordinary reset path.
  const file = process.env.REGRESSION_TASK_AUTHORIZATION;
  const expected = process.env.REGRESSION_TASK_AUTHORIZATION_SHA256;
  if (!file) {
    if (!existsSync(STATE_PATH)) fail("the registered regression state is required");
    if ((process.env.DB_HOST ?? "127.0.0.1") !== "127.0.0.1" || Number(process.env.DB_PORT ?? 55432) !== 55432 || (process.env.DB_USER ?? "zzsh") !== "zzsh") fail("connection destination is outside the approved local server");
    return { auth: null, sha: null, maxRebuilds: null };
  }
  if (!existsSync(file)) fail("REGRESSION_TASK_AUTHORIZATION is set but missing");
  const bytes = readFileSync(file);
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) fail("an independent authorization SHA256 is required");
  if (sha(bytes) !== expected) fail("authorization SHA does not match the expected value");
  const auth = JSON.parse(bytes.toString("utf8"));
  if (auth.task !== "LOCAL-DB-TWO-RESOURCE-1" || auth.approved !== true) fail("authorization is not for this task");
  if (auth.retirement?.approved !== false) fail("authorization must not approve retirement");
  const now = Date.now(), start = Date.parse(auth.validFrom), end = Date.parse(auth.validUntil);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || now < start || now > end) fail("authorization is outside its validity window");
  if (auth.phase !== "REGRESSION_CREATE_REPAIR_VERIFY_ONLY") fail("authorization has another phase");
  if (auth.target?.host !== "127.0.0.1" || auth.target?.port !== 55432 || auth.target?.owner !== "zzsh") fail("authorization has another server identity");
  if ((process.env.DB_HOST ?? "127.0.0.1") !== "127.0.0.1" || Number(process.env.DB_PORT ?? 55432) !== 55432 || (process.env.DB_USER ?? "zzsh") !== "zzsh") fail("connection destination is outside the approved local server");
  if (!Number.isInteger(auth.limits?.maxRegressionRebuilds) || auth.limits.maxRegressionRebuilds < 1 || auth.limits.maxRegressionRebuilds > 128) fail("a bounded rebuild budget is required");
  if (auth.target?.database !== DATABASE || auth.target?.marker !== MARKER) fail("authorization targets another resource");
  if ((auth.limits?.distinctNewDatabaseNames ?? 0) !== 1) fail("authorization must allow exactly one named database");
  return { auth, sha: sha(bytes), maxRebuilds: auth.limits.maxRegressionRebuilds };
}

function resolveSecretFromFile() {
  const file = process.env.DB_PASSWORD_FILE?.trim();
  if (!file) throw new Error("DB_PASSWORD or DB_PASSWORD_FILE is required");
  return readFileSync(resolve(process.cwd(), file), "utf8").trim();
}

const admin = () => new Client({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 55432),
  database: "postgres",
  user: process.env.DB_USER ?? "zzsh",
  password: resolveSecret(),
  application_name: "zzsh-regression-reset",
  connectionTimeoutMillis: 3000,
  statement_timeout: 5000,
  lock_timeout: 500,
});

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe identifier " + value);
  return `"${value}"`;
}

async function databaseRow(client) {
  const row = (await client.query(
    `SELECT d.oid::text AS oid, pg_get_userbyid(d.datdba) AS owner, shobj_description(d.oid, 'pg_database') AS marker,
            d.datallowconn AS allow, d.datistemplate AS template
       FROM pg_database d WHERE d.datname = $1`, [DATABASE])).rows[0];
  return row ?? null;
}

async function ensureRoles(client, receipt, state) {
  for (const [role, kind] of [[MIGRATION_ROLE, "migration"], [RUNTIME_ROLE, "runtime"]]) {
    const marker = `${MARKER}:${DATABASE}:${kind}`;
    const row = (await client.query(
      `SELECT r.oid::text AS oid, shobj_description(r.oid, 'pg_authid') AS marker, r.rolcanlogin, r.rolsuper, r.rolcreatedb,
              r.rolcreaterole, r.rolinherit, r.rolreplication, r.rolbypassrls
         FROM pg_roles r WHERE r.rolname = $1`, [role])).rows[0];
    const expected = state?.roles?.[kind];
    if (!row && expected) fail(`registered role ${role} is absent; read-only recovery is required`);
    if (row && (!expected || row.oid !== expected.oid || role !== expected.name)) fail(`role ${role} is not the recorded task role`);
    if (!row) {
      await client.query(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      await client.query(`COMMENT ON ROLE ${identifier(role)} IS '${marker.replaceAll("'", "''")}'`);
      const created = (await client.query(`SELECT r.oid::text AS oid FROM pg_roles r WHERE r.rolname = $1`, [role])).rows[0];
      receipt.roles[kind] = { name: role, oid: created.oid, created: true };
      continue;
    }
    if (row.marker !== marker) fail(`role ${role} exists with a different marker; refusing to adopt it`);
    if (!(row.rolcanlogin && !row.rolsuper && !row.rolcreatedb && !row.rolcreaterole && !row.rolinherit && !row.rolreplication && !row.rolbypassrls)) {
      fail(`role ${role} has unexpected attributes`);
    }
    receipt.roles[kind] = { name: role, oid: row.oid, created: false };
  }
}

(async () => {
  const { auth, sha: authSha, maxRebuilds } = verifyAuthorization();
  const client = admin();
  await client.connect();
  const receipt = { task: auth?.task ?? "local-regression", authorizationSha256: authSha, at: new Date().toISOString(), database: DATABASE, roles: {}, history: [] };
  let locked = false, closedOid = null, dropped = false, ready = null;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired;
    if (!locked) fail("the regression resource is already in use by another process");
    const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : null;
    if (state?.pendingReset) fail("a previous reset has a pending stage; preserve it and perform read-only recovery");
    const completed = state?.rebuildCount ?? state?.history?.filter((h) => h.action === "created").length ?? 0;
    if (!Number.isInteger(completed) || completed < 0) fail("the registered rebuild counter is invalid");
    if (maxRebuilds !== null && completed >= maxRebuilds) fail("regression rebuild budget exhausted");
    if (process.env.REGRESSION_TEST_ALLOW_NEW_RESOURCE !== "1") fail("reset requires the explicit creation flag before any DROP");
    let row = await databaseRow(client);
    if (row) {
      if (!state || state.oid !== row.oid) fail("an unexpected database with the regression name exists; refusing to adopt it");
      if (row.owner !== "zzsh" || row.marker !== MARKER || row.template) fail("the registered database identity changed");
      // A just-finished suite process can take a moment to be reaped by the server. Wait
      // for its own connections to drain; never terminate or force-drop a foreign session.
      let foreign = (await client.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [DATABASE])).rows[0].n;
      for (const deadline = Date.now() + 60000; foreign !== 0 && Date.now() < deadline;) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        foreign = (await client.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [DATABASE])).rows[0].n;
      }
      if (foreign !== 0) fail(`the regression database has ${foreign} foreign session(s)`);
      mkdirSync(dirname(STATE_PATH), { recursive: true });
      writeFileSync(STATE_PATH, JSON.stringify({ ...state, rebuildCount: completed, pendingReset: { oid: row.oid, at: receipt.at, authorizationSha256: authSha } }, null, 2) + "\n");
      await ensureRoles(client, receipt, state);
      if (auth && Date.now() > Date.parse(auth.validUntil)) fail("authorization expired before DROP");
      closedOid = row.oid;
      await client.query(`ALTER DATABASE ${identifier(DATABASE)} ALLOW_CONNECTIONS = false`);
      const after = (await client.query(
        "SELECT count(*)::int AS n, coalesce(max(pid),0) AS pid FROM pg_stat_activity WHERE datname = $1", [DATABASE])).rows[0];
      if (after.n !== 0) fail("a session still holds the closed regression database");
      await client.query(`DROP DATABASE ${identifier(DATABASE)}`);
      dropped = true;
      receipt.history.push({ action: "dropped", oid: row.oid, at: new Date().toISOString() });
      receipt.retiredOid = row.oid;
      row = null;
    }
    if (!row) {
      if (process.env.REGRESSION_TEST_ALLOW_NEW_RESOURCE !== "1") fail("regression database is absent and REGRESSION_TEST_ALLOW_NEW_RESOURCE is not 1");
      if (!receipt.roles.migration) {
        mkdirSync(dirname(STATE_PATH), { recursive: true });
        writeFileSync(STATE_PATH, JSON.stringify({ ...state, rebuildCount: completed, pendingReset: { oid: null, at: receipt.at, authorizationSha256: authSha } }, null, 2) + "\n");
        await ensureRoles(client, receipt, state);
      }
      if (auth && Date.now() > Date.parse(auth.validUntil)) fail("authorization expired before CREATE");
      const nonce = sha(`${Date.now()}:${Math.random()}`).slice(0, 24);
      await client.query(`CREATE DATABASE ${identifier(DATABASE)} OWNER zzsh`);
      await client.query(`COMMENT ON DATABASE ${identifier(DATABASE)} IS '${MARKER}'`);
      await client.query(`ALTER DATABASE ${identifier(DATABASE)} SET zzsh.regression_run = '${nonce}'`);
      const created = await databaseRow(client);
      if (!created || created.owner !== "zzsh" || created.marker !== MARKER) fail("creation readback does not match the registered identity");
      receipt.created = { oid: created.oid, nonce, at: new Date().toISOString() };
      receipt.oid = created.oid;
      receipt.nonce = nonce;
      // Canonical formal install (0000) on the fresh target: several suites assume the auth/meta schema
      // exists from the shared chain and do not run it themselves. Idempotent via the journal.
      // The archive verification tool alone asks for an empty target so an old-source dump can be
      // restored without colliding with the canonical chain; the following canonical reset restores it.
      if (process.env.REGRESSION_RESET_EMPTY_TARGET !== "1") {
        const fresh = new Client({ host: process.env.DB_HOST ?? "127.0.0.1", port: Number(process.env.DB_PORT ?? 55432), database: DATABASE, user: "zzsh", password: process.env.DB_PASSWORD ?? resolveSecretFromFile(), application_name: "zzsh-regression-install" });
        await fresh.connect();
        try {
          const { runFormalMigrations } = await import("../dist/src/database/migrations.js");
          await runFormalMigrations(fresh);
        } finally { await fresh.end(); }
      }
      receipt.history.push({ action: "created", oid: created.oid, nonce, at: receipt.created.at });
      mkdirSync(dirname(STATE_PATH), { recursive: true });
      const previous = state?.history ?? [];
      writeFileSync(STATE_PATH, JSON.stringify({ database: DATABASE, marker: MARKER, oid: created.oid, nonce, roles: receipt.roles, updatedAt: receipt.at, rebuildCount: completed + 1, pendingReset: null, history: [...previous, ...receipt.history] }, null, 2) + "\n");
    } else {
      fail("unreachable");
    }
    ready = { reset: "READY", database: receipt.database, oid: receipt.oid, nonce: receipt.nonce, retiredOid: receipt.retiredOid ?? null, roles: receipt.roles, authorizationSha256: authSha };
  } catch (error) {
    if (closedOid && !dropped) {
      const current = await databaseRow(client);
      if (current?.oid === closedOid && current.owner === "zzsh" && current.marker === MARKER) {
        await client.query(`ALTER DATABASE ${identifier(DATABASE)} ALLOW_CONNECTIONS = true`);
        if ((await databaseRow(client))?.allow !== true) throw new Error("ATTENTION: regression connection admission recovery not confirmed", { cause: error });
      }
    }
    throw error;
  } finally {
    try {
      if (locked && (await client.query("SELECT pg_advisory_unlock($1::bigint) AS ok", [LOCK_KEY])).rows[0]?.ok !== true) throw new Error("regression resource unlock was not confirmed");
    } finally { await client.end(); }
  }
  console.log(JSON.stringify({ ...ready, unlockConfirmed: true, connectionClosed: true }));
})().catch((error) => { console.error(JSON.stringify({ reset: "FAILED", reason: String(error.message ?? error) })); process.exit(1); });
