import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Pool, type PoolClient } from "pg";

import { REGRESSION_DATABASE, REGRESSION_MARKER, REGRESSION_RUNTIME_USER, assertNotProtectedTarget } from "../src/config/test-resource";
import { createPostgresUserAuthThrottle, signInSubjects, ThrottleDependencyError, throttleDigest, USER_THROTTLE_PROPOSAL } from "../src/auth/user-auth-throttle";
import { acquireSharedResourceLock, assertFreshRegressionRun } from "./database-test-support";

const KEY = "p".repeat(40);
const PHONE = "+8613800138111";
const IP = "198.51.100.40";

function maintenancePassword(): string {
  if (process.env.DB_PASSWORD?.trim()) return process.env.DB_PASSWORD.trim();
  const file = process.env.DB_PASSWORD_FILE?.trim();
  if (!file) throw new Error("DB_PASSWORD or DB_PASSWORD_FILE is required for the maintenance connection");
  return readFileSync(resolve(process.cwd(), file), "utf8").trim();
}

test("registered regression resource runs throttle concurrency, rollback, ACL and bounded sweep", async () => {
  assert.equal(process.env.USER_AUTH_THROTTLE_PG, "1");
  const expectedOid = process.env.ZZSH_REGRESSION_DB_OID?.trim() ?? "";
  assert.match(expectedOid, /^[0-9]+$/);
  assertNotProtectedTarget(REGRESSION_DATABASE);
  const host = process.env.DB_HOST ?? "127.0.0.1";
  const port = Number(process.env.DB_PORT ?? 55432);
  assert.equal(host, "127.0.0.1");
  assert.equal(port, 55432);
  const connection = { host, port, user: process.env.DB_USER ?? "zzsh", password: maintenancePassword(), connectionTimeoutMillis: 3_000 };
  const maintenance = new Pool({ ...connection, database: "postgres", max: 1, application_name: "user-auth-throttle-lock" });
  const pool = new Pool({ ...connection, database: REGRESSION_DATABASE, max: 4, application_name: "user-auth-throttle-pg" });
  let lock: PoolClient | undefined;
  let created = false;
  try {
    lock = await acquireSharedResourceLock(maintenance, "user-auth-throttle");
    const identity = (await maintenance.query<{ marker: string | null; databaseOid: string }>(
      "SELECT shobj_description(oid, 'pg_database') AS marker, oid::text AS \"databaseOid\" FROM pg_database WHERE datname = $1",
      [REGRESSION_DATABASE],
    )).rows[0];
    assert.equal(identity?.databaseOid, expectedOid);
    assert.equal(identity?.marker, REGRESSION_MARKER);
    await assertFreshRegressionRun(pool);
    const present = await pool.query<{ event: string | null; proof: string | null }>("SELECT to_regclass('zzsh_iam.user_auth_throttle_event') AS event, to_regclass('zzsh_iam.user_auth_captcha_used') AS proof");
    assert.equal(present.rows[0]?.event, null);
    assert.equal(present.rows[0]?.proof, null);
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/candidates/user_auth_throttle.sql"), "utf8"));
    created = true;

    const store = createPostgresUserAuthThrottle(pool, {
      hmacKey: KEY,
      mode: "candidate",
      policy: { ...USER_THROTTLE_PROPOSAL, pairMax: 3, ipMax: 100, accountCaptchaAfter: 100, smsPhonePerDay: 1, captchaCost: 1 },
      audit: async (client, event) => {
        await client.query(
          `INSERT INTO zzsh_iam.user_auth_throttle_event (realm, purpose, subject, kind, ticket) VALUES ('user', 'base', $1, 'unknown', $2)`,
          [event.subject, "ab".repeat(16)],
        );
      },
    });
    const subjects = signInSubjects(KEY, PHONE, IP);
    const admitted = await Promise.all(Array.from({ length: 8 }, () => store.admitSignIn(subjects, undefined)));
    assert.equal(admitted.filter((result) => result.decision === "allow").length, 3);
    assert.equal(admitted.filter((result) => result.decision === "limited").length, 5);

    const business = await pool.connect();
    try {
      await business.query("BEGIN");
      const allowed = await store.holdSmsPhone(business, PHONE);
      assert.equal(allowed.decision, "allow");
      await business.query("ROLLBACK");
    } finally { business.release(); }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zzsh_iam.user_auth_throttle_event WHERE purpose = 'sms-phone'")).rows[0].n, 0);
    assert.equal((await store.holdSmsPhone(null, PHONE)).decision, "allow");
    const deniedClient = await pool.connect();
    let rejection: { action: string; purpose: string; subject: string; outcome: string } | undefined;
    try {
      await deniedClient.query("BEGIN");
      const denied = await store.holdSmsPhone(deniedClient, PHONE);
      assert.equal(denied.decision, "limited");
      rejection = denied.rejection;
      await deniedClient.query("ROLLBACK");
    } finally { deniedClient.release(); }
    assert.ok(rejection);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zzsh_iam.user_auth_throttle_event WHERE kind = 'unknown'")).rows[0].n, 0);
    await store.recordRejection(rejection);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zzsh_iam.user_auth_throttle_event WHERE kind = 'unknown'")).rows[0].n, 1);

    await pool.query("INSERT INTO zzsh_iam.user_auth_throttle_event (realm, purpose, subject, kind, ticket, occurred_at) SELECT 'user', 'base', $1, 'failure', md5(random()::text), clock_timestamp() - interval '25 hours' FROM generate_series(1, 5)", [throttleDigest(KEY, "user", "base-ip", "old")]);
    assert.deepEqual(await store.sweepExpired(2), { events: 2, proofs: 0 });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zzsh_iam.user_auth_throttle_event WHERE occurred_at <= clock_timestamp() - interval '25 hours'")).rows[0].n, 3);
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["user-auth-throttle-sweep"]);
    assert.deepEqual(await store.sweepExpired(10), { events: 0, proofs: 0 });
    await holder.query("ROLLBACK");
    holder.release();

    const acl = await pool.connect();
    let deniedCode = "";
    try {
      await acl.query("BEGIN");
      await acl.query("SET LOCAL ROLE " + REGRESSION_RUNTIME_USER);
      try { await acl.query("INSERT INTO zzsh_iam.user_auth_throttle_event (realm, purpose, subject, kind, ticket) VALUES ('user', 'base', $1, 'failure', $2)", ["c".repeat(64), "ef".repeat(16)]); }
      catch (error) { deniedCode = (error as { code?: string }).code ?? ""; }
      await acl.query("ROLLBACK");
    } finally { acl.release(); }
    assert.equal(deniedCode, "42501");
    const publicGrants = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class AS relation, aclexplode(relation.relacl) AS acl
        WHERE relation.oid = 'zzsh_iam.user_auth_throttle_event'::regclass AND acl.grantee = 0`,
    );
    assert.equal(publicGrants.rows[0]?.n ?? 0, 0);

    await pool.query("DROP TABLE zzsh_iam.user_auth_captcha_used, zzsh_iam.user_auth_throttle_event");
    created = false;
    await assert.rejects(() => store.admitSignIn(subjects, undefined), (error: unknown) => error instanceof ThrottleDependencyError);
  } finally {
    if (created) await pool.query("DROP TABLE IF EXISTS zzsh_iam.user_auth_captcha_used, zzsh_iam.user_auth_throttle_event").catch(() => undefined);
    lock?.release();
    await pool.end();
    await maintenance.end();
  }
});
