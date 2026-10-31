import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { REGRESSION_DATABASE, REGRESSION_MARKER, REGRESSION_RUNTIME_USER, assertNotProtectedTarget } from "../src/config/test-resource";
import { withTransaction } from "../src/auth/security-core";
import { createPostgresUserAuthThrottle, signInSubjects, ThrottleDependencyError, throttleDigest, USER_THROTTLE_PROPOSAL } from "../src/auth/user-auth-throttle";
import { acquireSharedResourceLock, assertFreshRegressionRun } from "./database-test-support";

const KEY = "p".repeat(40), PHONE = "+8613800138111", IP = "198.51.100.40";
function maintenancePassword(): string {
  if (process.env.DB_PASSWORD?.trim()) return process.env.DB_PASSWORD.trim();
  const file = process.env.DB_PASSWORD_FILE?.trim();
  if (!file) throw new Error("DB_PASSWORD or DB_PASSWORD_FILE is required for maintenance");
  return readFileSync(resolve(process.cwd(), file), "utf8").trim();
}

test("registered regression resource runs throttle concurrency, rollback, ACL and bounded sweep", async () => {
  // All admission checks precede credential reads and connections.
  assert.equal(process.env.USER_AUTH_THROTTLE_PG, "1");
  const expectedOid = process.env.ZZSH_REGRESSION_DB_OID?.trim() ?? "";
  assert.match(expectedOid, /^[0-9]+$/);
  assert.ok(process.env.ZZSH_REGRESSION_RUN?.trim());
  assertNotProtectedTarget(REGRESSION_DATABASE);
  assert.equal(process.env.DB_USER ?? "zzsh", "zzsh");
  const host = process.env.DB_HOST ?? "127.0.0.1", port = Number(process.env.DB_PORT ?? 55432);
  assert.equal(host, "127.0.0.1"); assert.equal(port, 55432);
  const connection = { host, port, user: "zzsh", password: maintenancePassword(), connectionTimeoutMillis: 3000, statement_timeout: 3000, options: "-c lock_timeout=500ms" };
  const maintenance = new Pool({ ...connection, database: "postgres", max: 1, application_name: "user-auth-throttle-lock" });
  const pool = new Pool({ ...connection, database: REGRESSION_DATABASE, max: 4, application_name: "user-auth-throttle-pg" });
  let lock: PoolClient | undefined, primary: unknown, attempted = false;
  let owned: { event: string | null; proof: string | null } | undefined;
  const relations = async () => (await pool.query<{ event: string | null; proof: string | null; eventOwner: string | null; proofOwner: string | null }>(
    `SELECT to_regclass('zzsh_iam.user_auth_throttle_event')::oid::text AS event,
      to_regclass('zzsh_iam.user_auth_captcha_used')::oid::text AS proof,
      (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('zzsh_iam.user_auth_throttle_event')) AS "eventOwner",
      (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('zzsh_iam.user_auth_captcha_used')) AS "proofOwner"`,
  )).rows[0]!;
  const rollback = async (work: (client: PoolClient) => Promise<void>) => {
    const client = await pool.connect(); let failure: unknown, broken = false;
    try { await client.query("BEGIN"); await work(client); }
    catch (error) { failure = error; }
    finally { try { await client.query("ROLLBACK"); } catch (error) { broken = true; failure = failure ? new AggregateError([failure, error], "operation and rollback failed") : error; } client.release(broken ? true : undefined); }
    if (failure) throw failure;
  };
  try {
    lock = await acquireSharedResourceLock(maintenance, "user-auth-throttle");
    // The max=1 maintenance pool is already checked out by the lock.
    const identity = (await lock.query<{ marker: string | null; databaseOid: string; role: string }>(
      `SELECT shobj_description(oid,'pg_database') AS marker,oid::text AS "databaseOid",current_user AS role FROM pg_database WHERE datname=$1`, [REGRESSION_DATABASE],
    )).rows[0];
    assert.equal(identity?.databaseOid, expectedOid); assert.equal(identity?.marker, REGRESSION_MARKER); assert.equal(identity?.role, "zzsh");
    await assertFreshRegressionRun(pool);
    const before = await relations(); assert.equal(before.event, null); assert.equal(before.proof, null);
    attempted = true;
    await withTransaction(pool, async client => {
      await client.query(readFileSync(resolve(process.cwd(), "migrations/candidates/user_auth_throttle.sql"), "utf8"));
      owned = (await client.query<{ event: string; proof: string }>(`SELECT to_regclass('zzsh_iam.user_auth_throttle_event')::oid::text AS event,to_regclass('zzsh_iam.user_auth_captcha_used')::oid::text AS proof`)).rows[0];
      assert.ok(owned?.event && owned.proof);
    });
    const storeOptions = { hmacKey: KEY, mode: "candidate" as const,
      policy: { ...USER_THROTTLE_PROPOSAL, pairMax: 3, ipMax: 100, accountCaptchaAfter: 100, smsPhonePerDay: 1, captchaCost: 1 } };
    const store = createPostgresUserAuthThrottle(pool, { ...storeOptions, audit: async (client, event) => {
      await client.query(`INSERT INTO zzsh_iam.user_auth_throttle_event(realm,purpose,subject,kind,ticket) VALUES('user','base',$1,'unknown',$2)`, [event.subject, "ab".repeat(16)]);
    } });
    const second = createPostgresUserAuthThrottle(pool, storeOptions), subjects = signInSubjects(KEY, PHONE, IP);
    const admitted = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? second : store).admitSignIn(subjects, undefined)));
    assert.equal(admitted.filter(row => row.decision === "allow").length, 3);
    assert.equal(admitted.filter(row => row.decision === "limited").length, 5);
    await rollback(async client => { assert.equal((await store.holdSmsPhone(client, PHONE)).decision, "allow"); });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zzsh_iam.user_auth_throttle_event WHERE purpose='sms-phone'")).rows[0].n, 0);
    assert.equal((await store.holdSmsPhone(null, PHONE)).decision, "allow");
    let rejection: Parameters<typeof store.recordRejection>[0] | undefined;
    await rollback(async client => { const denied = await store.holdSmsPhone(client, PHONE); assert.equal(denied.decision, "limited"); rejection = denied.rejection; });
    assert.ok(rejection);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zzsh_iam.user_auth_throttle_event WHERE kind='unknown'")).rows[0].n, 0);
    await store.recordRejection(rejection);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zzsh_iam.user_auth_throttle_event WHERE kind='unknown'")).rows[0].n, 1);
    await pool.query(`INSERT INTO zzsh_iam.user_auth_throttle_event(realm,purpose,subject,kind,ticket,occurred_at,expires_at)
      SELECT 'user','base',$1,'failure',md5(random()::text),clock_timestamp()-interval '25 hours',clock_timestamp()-interval '1 hour' FROM generate_series(1,5)`, [throttleDigest(KEY, "user", "base-ip", "old")]);
    assert.deepEqual(await store.sweepExpired(2), { events: 2, proofs: 0 });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zzsh_iam.user_auth_throttle_event WHERE occurred_at<=clock_timestamp()-interval '25 hours'")).rows[0].n, 3);
    await rollback(async client => { await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["user-auth-throttle-sweep"]); assert.deepEqual(await store.sweepExpired(10), { events: 0, proofs: 0 }); });
    // Effective role ACL checks. This is not a proof of an independent runtime-password login.
    let deniedCode = "";
    await rollback(async client => { await client.query("SET LOCAL ROLE " + REGRESSION_RUNTIME_USER); try {
      await client.query(`INSERT INTO zzsh_iam.user_auth_throttle_event(realm,purpose,subject,kind,ticket) VALUES('user','base',$1,'failure',$2)`, ["c".repeat(64), "ef".repeat(16)]);
    } catch (error) { deniedCode = (error as { code?: string }).code ?? ""; } });
    assert.equal(deniedCode, "42501");
    await rollback(async client => {
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON zzsh_iam.user_auth_throttle_event TO ${REGRESSION_RUNTIME_USER};
        GRANT USAGE,SELECT ON SEQUENCE zzsh_iam.user_auth_throttle_event_id_seq TO ${REGRESSION_RUNTIME_USER};
        GRANT SELECT,INSERT,DELETE ON zzsh_iam.user_auth_captcha_used TO ${REGRESSION_RUNTIME_USER}`);
      await client.query("SET LOCAL ROLE " + REGRESSION_RUNTIME_USER);
      assert.equal((await client.query("SELECT current_user AS role")).rows[0].role, REGRESSION_RUNTIME_USER);
      await client.query(`INSERT INTO zzsh_iam.user_auth_throttle_event(realm,purpose,subject,kind,ticket) VALUES('user','base',$1,'failure',$2)`, ["c".repeat(64), "ef".repeat(16)]);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM zzsh_iam.user_auth_throttle_event WHERE subject=$1", ["c".repeat(64)])).rows[0].n, 1);
      await client.query("UPDATE zzsh_iam.user_auth_throttle_event SET kind='unknown' WHERE subject=$1", ["c".repeat(64)]);
      await client.query("DELETE FROM zzsh_iam.user_auth_throttle_event WHERE subject=$1", ["c".repeat(64)]);
      await client.query("INSERT INTO zzsh_iam.user_auth_captcha_used(realm,signature,expires_at) VALUES('user','synthetic-runtime-proof',clock_timestamp()+interval '5 min')");
      await client.query("SELECT signature FROM zzsh_iam.user_auth_captcha_used WHERE signature='synthetic-runtime-proof'");
      await client.query("DELETE FROM zzsh_iam.user_auth_captcha_used WHERE signature='synthetic-runtime-proof'");
    });
    const publicGrants = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class r,aclexplode(r.relacl) a WHERE r.oid=ANY(ARRAY['zzsh_iam.user_auth_throttle_event'::regclass,'zzsh_iam.user_auth_captcha_used'::regclass]) AND a.grantee=0`);
    assert.equal(publicGrants.rows[0]?.n ?? 0, 0);
  } catch (error) { primary = error; }
  finally {
    const failures: unknown[] = [];
    if (attempted) try {
      const current = await relations();
      if (current.event || current.proof) {
        if (!owned || current.event !== owned.event || current.proof !== owned.proof || current.eventOwner !== "zzsh" || current.proofOwner !== "zzsh") throw new Error("THROTTLE_SETUP_UNKNOWN_OR_OWNERSHIP_CHANGED_KEEP");
        await pool.query("DROP TABLE zzsh_iam.user_auth_captcha_used,zzsh_iam.user_auth_throttle_event");
        const gone = await relations(); assert.equal(gone.event, null); assert.equal(gone.proof, null);
        await assert.rejects(createPostgresUserAuthThrottle(pool, { hmacKey: KEY, mode: "base" }).admitBase(IP, {path:"/sign-in/identifier",max:3,windowSeconds:10}), (error: unknown) => error instanceof ThrottleDependencyError);
      }
    } catch (error) { failures.push(error); }
    try { await pool.end(); } catch (error) { failures.push(error); }
    if (lock) { try { assert.equal((await lock.query("SELECT pg_advisory_unlock($1::bigint) AS ok", [806006])).rows[0]?.ok, true); } catch (error) { failures.push(error); } finally { try { lock.release(); } catch (error) { failures.push(error); } } }
    try { await maintenance.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(primary ? [primary, ...failures] : failures, "User throttle verification or cleanup was not confirmed");
  }
  if (primary) throw primary;
});
