import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { REGRESSION_DATABASE, REGRESSION_MARKER, REGRESSION_RUNTIME_USER, assertNotProtectedTarget } from "../src/config/test-resource";
import { assertIdentitySubjectCapacity, identitySubjectDigest, recordLegacyIdentitySubject, recordVerifiedIdentitySubject } from "../src/auth/identity-subject";
import { withTransaction } from "../src/auth/security-core";
import { acquireSharedResourceLock, assertFreshRegressionRun } from "./database-test-support";

test("identity subject: actual PG concurrency, frozen capacity, cancellation, rebind and grandfathered legacy", async t => {
  assert.equal(process.env.USER_IDENTITY_SUBJECT_PG, "1");
  assertNotProtectedTarget(REGRESSION_DATABASE);
  const expectedOid = process.env.ZZSH_REGRESSION_DB_OID;
  assert.match(expectedOid ?? "", /^[0-9]+$/); assert.ok(process.env.ZZSH_REGRESSION_RUN);
  assert.equal(process.env.DB_HOST ?? "127.0.0.1", "127.0.0.1"); assert.equal(Number(process.env.DB_PORT ?? 55432), 55432);
  assert.equal(process.env.DB_USER ?? "zzsh", "zzsh");
  const password = process.env.DB_PASSWORD?.trim() ?? readFileSync(resolve(process.cwd(), process.env.DB_PASSWORD_FILE ?? ""), "utf8").trim();
  assert.ok(password);
  const connect = { host: "127.0.0.1", port: 55432, user: "zzsh", password, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, options: "-c lock_timeout=5000ms" };
  const maintenance = new Pool({ ...connect, database: "postgres", max: 1, application_name: "identity-subject-lock" });
  const pool = new Pool({ ...connect, database: REGRESSION_DATABASE, max: 3, application_name: "identity-subject-pg" });
  const prefix = `identity_probe_${randomUUID().replaceAll("-", "")}`;
  const ids = Array.from({ length: 8 }, (_, i) => `${prefix}_${i}`);
  const evidenceDirectory = resolve(process.cwd(), "../../tmp/core-preview/a");
  const key = Buffer.alloc(32, 19), document = "99000019900101123X", nextDocument = "99000019900101124X", legacyDocument = "99000019900101125X";
  let lock: PoolClient | undefined, primary: unknown, seeded = false;
  const claim = (userId: string, number: string) => withTransaction(pool, async client => {
    await client.query(`SET LOCAL ROLE ${REGRESSION_RUNTIME_USER}`);
    await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [userId]);
    const digest = await assertIdentitySubjectCapacity(client, userId, number, key, true);
    await recordVerifiedIdentitySubject(client, userId, digest, "NATIVE_VERIFICATION");
  });
  try {
    lock = await acquireSharedResourceLock(maintenance, "identity-subject");
    const resource = (await lock.query(`SELECT oid::text AS oid,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [REGRESSION_DATABASE])).rows[0];
    assert.equal(resource?.oid, expectedOid); assert.equal(resource?.marker, REGRESSION_MARKER);
    await assertFreshRegressionRun(pool);
    assert.equal((await pool.query(`SELECT to_regclass('zzsh_iam.user_identity_subject') IS NOT NULL AS ready`)).rows[0]?.ready, true);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_auth_user."user" WHERE id=ANY($1::text[])`, [ids])).rows[0]?.n, 0);
    mkdirSync(evidenceDirectory,{recursive:true});
    writeFileSync(resolve(evidenceDirectory,`${prefix}.prepared.json`),JSON.stringify({database:REGRESSION_DATABASE,oid:expectedOid,nonce:process.env.ZZSH_REGRESSION_RUN,ids},null,2),{flag:"wx"});
    await withTransaction(pool, async client => {
      for (let i = 0; i < ids.length; i++) {
        await client.query(`INSERT INTO zzsh_auth_user."user"(id,name,email,"emailVerified","createdAt","updatedAt",suspended)
          VALUES($1,'SYNTHETIC identity verification',$2,false,clock_timestamp(),clock_timestamp(),false)`, [ids[i], `${ids[i]}@example.invalid`]);
        await client.query(`INSERT INTO zzsh_iam.user_identity_state(user_id,account_status,identity_status,age_status,provider,version,updated_at)
          VALUES($1,'ACTIVE','VERIFIED','ADULT',$2,1,clock_timestamp())`, [ids[i], i < 4 ? "fake" : "legacy_mysql_restore"]);
      }
    });
    seeded = true;
    const results = await Promise.allSettled(ids.slice(0,3).map(id => claim(id, document)));
    const admitted = ids.slice(0,3).filter((_, i) => results[i]!.status === "fulfilled");
    const denied = ids.slice(0,3).find((_, i) => results[i]!.status === "rejected")!;
    assert.equal(admitted.length, 2); assert.ok(denied);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(failure.reason.code, "IDENTITY_ACCOUNT_LIMIT");
    await claim(admitted[0]!, document);
    await pool.query(`UPDATE zzsh_iam.user_identity_state SET account_status='FROZEN',version=version+1 WHERE user_id=$1`, [admitted[0]]);
    await assert.rejects(claim(ids[3]!, document), (error: unknown) => (error as { code?: string }).code === "IDENTITY_ACCOUNT_LIMIT");
    await pool.query(`UPDATE zzsh_iam.user_identity_state SET account_status='CANCELLED',version=version+1 WHERE user_id=$1`, [admitted[0]]);
    await claim(ids[3]!, document);
    // A stale display row cannot keep occupying the old document after a new authoritative binding.
    await pool.query(`INSERT INTO zzsh_iam.user_identity_display_source(user_id,real_name,id_card_no) VALUES($1,'SYNTHETIC', $2)`, [admitted[1], document]);
    await claim(admitted[1]!, nextDocument);
    await claim(denied, document);
    const old = identitySubjectDigest(document,key);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.user_identity_subject b JOIN zzsh_iam.user_identity_state s ON s.user_id=b.user_id
      WHERE b.subject_digest=$1 AND s.account_status<>'CANCELLED'`, [old])).rows[0]?.n, 2);
    await withTransaction(pool, async client => {
      for (const id of ids.slice(4,7)) {
        await client.query(`INSERT INTO zzsh_iam.user_identity_display_source(user_id,real_name,id_card_no) VALUES($1,'SYNTHETIC', $2)`, [id,legacyDocument]);
        await recordLegacyIdentitySubject(client,id,legacyDocument,key);
      }
    });
    await claim(ids[4]!,legacyDocument);
    await assert.rejects(claim(ids[7]!,legacyDocument), (error: unknown) => (error as { code?: string }).code === "IDENTITY_ACCOUNT_LIMIT");
    const publicGrants = (await pool.query(`SELECT count(*)::int AS n FROM pg_class c,aclexplode(c.relacl) a
      WHERE c.oid='zzsh_iam.user_identity_subject'::regclass AND a.grantee=0`)).rows[0]?.n;
    assert.equal(publicGrants ?? 0, 0);
  } catch (error) { primary = error; }
  finally {
    const cleanupErrors: unknown[] = [];
    if (seeded) try {
      await withTransaction(pool, async client => {
        await client.query(`DELETE FROM zzsh_iam.user_identity_subject WHERE user_id=ANY($1::text[])`, [ids]);
        await client.query(`DELETE FROM zzsh_iam.user_identity_display_source WHERE user_id=ANY($1::text[])`, [ids]);
        await client.query(`UPDATE zzsh_iam.user_identity_state SET account_status='CANCELLED',version=version+1,updated_at=clock_timestamp()
          WHERE user_id=ANY($1::text[]) AND account_status<>'CANCELLED'`, [ids]);
        await client.query(`UPDATE zzsh_auth_user."user" SET suspended=true WHERE id=ANY($1::text[])`, [ids]);
      });
      const retired=(await pool.query(`SELECT count(*)::int AS n,count(*) FILTER(WHERE u.suspended AND s.account_status='CANCELLED')::int AS retired
        FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id WHERE u.id=ANY($1::text[])`,[ids])).rows[0];
      assert.equal(retired?.n,8);assert.equal(retired?.retired,8);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.user_identity_subject WHERE user_id=ANY($1::text[])`,[ids])).rows[0]?.n,0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.user_identity_display_source WHERE user_id=ANY($1::text[])`,[ids])).rows[0]?.n,0);
      const disposition={status:"RETAINED_SYNTHETIC_NOT_ZERO",ids,retainedIdentities:8,reason:"Immutable original INSERT proof and audit remain until the registered regression reset"};
      writeFileSync(resolve(evidenceDirectory,`${prefix}.retired.json`),JSON.stringify(disposition,null,2),{flag:"wx"});
      t.diagnostic("RETAINED_SYNTHETIC_NOT_ZERO: 8 cancelled/suspended fixtures, no active identity subjects; immutable proofs and audit retained");
    } catch (error) { cleanupErrors.push(error); }
    try { await pool.end(); } catch (error) { cleanupErrors.push(error); }
    if (lock) {
      try { assert.equal((await lock.query(`SELECT pg_advisory_unlock($1::bigint) AS ok`,[806006])).rows[0]?.ok,true); }
      catch (error) { cleanupErrors.push(error); }
      finally { lock.release(); }
    }
    try { await maintenance.end(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(primary ? [primary,...cleanupErrors] : cleanupErrors,"Identity subject verification or cleanup was not confirmed");
  }
  if (primary) throw primary;
});
