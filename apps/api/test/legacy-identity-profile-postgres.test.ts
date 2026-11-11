import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import type { EffectiveAdminAccess } from "../src/auth/admin-authorization";
import { pgIdentityDisplayStore, readIdentityDisplay } from "../src/auth/identity-display";
import { identitySubjectDigest } from "../src/auth/identity-subject";
import { readLegacyIdentityForAdmin, recordLegacyIdentityProfile, recordLegacyIdentityProfiles } from "../src/auth/legacy-identity-profile";
import { readUserSensitiveProfile } from "../src/auth/user-directory-sensitive";
import { configureLegacyIdentityProfilePrivileges } from "../src/database/business-migrations";

const port = process.env.ZZSH_SYNTH_IDENTITY_PORT;
test("legacy identity actual PostgreSQL: encryption, exact replay, locks, ACL and audited disclosure", { skip: !port }, async () => {
  assert.match(port!, /^[1-9][0-9]{3,4}$/);
  assert.match(process.env.ZZSH_SYNTH_IDENTITY_SYSTEM ?? "", /^[0-9]+$/);
  const pool = new Pool({ host: "127.0.0.1", port: Number(port), database: "zzsh_synth_identity", user: "postgres", max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const admin = await pool.connect();
  let first: PoolClient | undefined, second: PoolClient | undefined;
  try {
    const identity = (await admin.query(`SELECT current_database() AS database,(pg_control_system()).system_identifier::text AS system,
      shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker`)).rows[0];
    assert.deepEqual(identity, { database: "zzsh_synth_identity", system: process.env.ZZSH_SYNTH_IDENTITY_SYSTEM, marker: "zzsh:synthetic:legacy-identity-v1" });
    assert.equal((await admin.query("SELECT to_regnamespace('zzsh_iam') IS NULL AS fresh")).rows[0]?.fresh, true);
    await admin.query(`CREATE ROLE zzsh_synth_identity_m NOLOGIN; CREATE ROLE zzsh_synth_identity_r NOLOGIN;
      CREATE SCHEMA zzsh_iam AUTHORIZATION zzsh_synth_identity_m; CREATE SCHEMA zzsh_auth_user AUTHORIZATION zzsh_synth_identity_m`);
    await admin.query("SET ROLE zzsh_synth_identity_m");
    await admin.query(`CREATE TABLE zzsh_auth_user."user"(id text PRIMARY KEY,"phoneNumber" text);
      CREATE TABLE zzsh_iam.user_identity_state(user_id text PRIMARY KEY,identity_status text NOT NULL,provider text NOT NULL,provider_reference text NOT NULL);
      CREATE TABLE zzsh_iam.user_identity_subject(user_id text PRIMARY KEY REFERENCES zzsh_iam.user_identity_state(user_id),subject_digest text NOT NULL,source text NOT NULL);
      CREATE TABLE zzsh_iam.audit_event(id text PRIMARY KEY,actor_type text,actor_id text,session_id text,action text,object_type text,object_id text,outcome text,request_id text,reason text,occurred_at timestamptz,details jsonb)`);
    await admin.query(readFileSync(resolve(__dirname, "../../migrations/business/0193_legacy_identity_profile.sql"), "utf8"));
    await admin.query("RESET ROLE");
    await configureLegacyIdentityProfilePrivileges(admin, "zzsh_synth_identity_r");
    const metadata = (await admin.query(`SELECT obj_description('zzsh_iam.user_legacy_identity_profile'::regclass) IS NOT NULL AS table_comment,
      count(*) FILTER (WHERE col_description(attrelid,attnum) IS NULL)::int AS missing_comments, count(*)::int AS columns
      FROM pg_attribute WHERE attrelid='zzsh_iam.user_legacy_identity_profile'::regclass AND attnum>0 AND NOT attisdropped`)).rows[0];
    assert.deepEqual(metadata,{table_comment:true,missing_comments:0,columns:11});
    const rights = (await admin.query(`SELECT has_table_privilege('zzsh_synth_identity_r','zzsh_iam.user_legacy_identity_profile','SELECT') AS can_read,
      has_table_privilege('zzsh_synth_identity_r','zzsh_iam.user_legacy_identity_profile','INSERT') AS can_insert,
      has_table_privilege('zzsh_synth_identity_r','zzsh_iam.user_legacy_identity_profile','UPDATE') AS can_update,
      has_table_privilege('zzsh_synth_identity_r','zzsh_iam.user_legacy_identity_profile','DELETE') AS can_delete`)).rows[0];
    assert.deepEqual(rights,{can_read:true,can_insert:false,can_update:false,can_delete:false});
    await admin.query(`GRANT USAGE ON SCHEMA zzsh_iam,zzsh_auth_user TO zzsh_synth_identity_r;
      GRANT SELECT,UPDATE(identity_status) ON zzsh_iam.user_identity_state TO zzsh_synth_identity_r;
      GRANT SELECT,UPDATE(subject_digest) ON zzsh_iam.user_identity_subject TO zzsh_synth_identity_r;
      GRANT SELECT,UPDATE("phoneNumber") ON zzsh_auth_user."user" TO zzsh_synth_identity_r;
      GRANT INSERT ON zzsh_iam.audit_event TO zzsh_synth_identity_r`);
    const profileKey = Buffer.alloc(32, 11), subjectKey = Buffer.alloc(32, 19);
    const details = { realName: "合成姓名", idCardNo: "99000019900101123X" };
    const binding = { userId: "synthetic_user", sourceRef: "la_user:12", sourceDigest: "a".repeat(64), subjectDigest: identitySubjectDigest(details.idCardNo, subjectKey) };
    await admin.query("SET ROLE zzsh_synth_identity_m");
    await admin.query(`INSERT INTO zzsh_auth_user."user" VALUES($1,NULL)`, [binding.userId]);
    await admin.query(`INSERT INTO zzsh_iam.user_identity_state VALUES($1,'VERIFIED','legacy_mysql_restore',$2)`, [binding.userId,binding.sourceRef]);
    await admin.query(`INSERT INTO zzsh_iam.user_identity_subject VALUES($1,$2,'LEGACY_IMPORT')`, [binding.userId,binding.subjectDigest]);
    await admin.query("RESET ROLE");
    first = await pool.connect(); second = await pool.connect();
    await first.query("BEGIN; SET LOCAL ROLE zzsh_synth_identity_m");
    assert.equal(await recordLegacyIdentityProfile(first,binding,details,profileKey,subjectKey), "CREATED");
    await second.query("BEGIN; SET LOCAL ROLE zzsh_synth_identity_m");
    const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const replay = recordLegacyIdentityProfile(second,binding,details,profileKey,subjectKey);
    void replay.catch(() => {});
    let blocked = false;
    for (let i=0;i<50 && !blocked;i++) {
      blocked = (await admin.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [secondPid])).rows[0]?.blocked === true;
      if (!blocked) await new Promise(resolve => setTimeout(resolve,20));
    }
    assert.equal(blocked,true,"concurrent replay must wait for the original user lock");
    await first.query("COMMIT"); assert.equal(await replay,"REPLAYED"); await second.query("COMMIT");
    const stored = (await admin.query("SELECT count(*)::int AS n,bool_and(ciphertext NOT LIKE $1 AND ciphertext NOT LIKE $2) AS encrypted FROM zzsh_iam.user_legacy_identity_profile", [`%${details.realName}%`,`%${details.idCardNo}%`])).rows[0];
    assert.deepEqual(stored,{n:1,encrypted:true});
    await first.query("BEGIN; SET LOCAL ROLE zzsh_synth_identity_m");
    await assert.rejects(recordLegacyIdentityProfile(first,binding,{...details,realName:"另一合成姓名"},profileKey,subjectKey), (e:unknown)=>(e as {status?:number}).status===503);
    await first.query("ROLLBACK");
    await second.query("BEGIN; SET LOCAL ROLE zzsh_synth_identity_r");
    const display=await readIdentityDisplay(pgIdentityDisplayStore(second),binding.userId,"VERIFIED");
    assert.equal(display.identityDisplay?.realNameMasked,"合**名");
    const access:EffectiveAdminAccess={status:"ACTIVE",isBoss:false,passwordChangeRequired:false,permissions:new Set(["user.directory.read","user.identity.sensitive.read"])};
    const revealed=await readUserSensitiveProfile(second,{adminId:"synthetic_admin",sessionId:"synthetic_session",requestId:"synthetic_request"},access,binding.userId,{profileKey,subjectKey});
    assert.equal(revealed.realName,details.realName); assert.equal(revealed.identityNumber,details.idCardNo);
    await second.query("COMMIT");
    const audit=(await admin.query("SELECT details FROM zzsh_iam.audit_event WHERE action='user.identity.sensitive.read'")).rows;
    assert.deepEqual(audit,[{details:{fields:["realName","identityNumber"]}}]);
    assert.equal(JSON.stringify(audit).includes(details.realName),false); assert.equal(JSON.stringify(audit).includes(details.idCardNo),false);
    await second.query("BEGIN; SET LOCAL ROLE zzsh_synth_identity_r");
    await assert.rejects(second.query("UPDATE zzsh_iam.user_legacy_identity_profile SET name_mask='*'"), (e:unknown)=>(e as {code?:string}).code==="42501");
    await second.query("ROLLBACK");
    await second.query("BEGIN; SET LOCAL ROLE zzsh_synth_identity_r");
    await assert.rejects(readLegacyIdentityForAdmin(second,binding.userId,Buffer.alloc(32,12),subjectKey), (e:unknown)=>(e as {status?:number}).status===503);
    await second.query("ROLLBACK");
    assert.equal(Number((await admin.query("SELECT count(*) FROM zzsh_iam.audit_event")).rows[0]!.count),1);
    const details2 = { realName: "第二合成姓名", idCardNo: "99000019900101124X" }, details3 = { realName: "第三合成姓名", idCardNo: "99000019900101125X" };
    const binding2 = { userId: "synthetic_user_2", sourceRef: "la_user:13", sourceDigest: "b".repeat(64), subjectDigest: identitySubjectDigest(details2.idCardNo,subjectKey) };
    const binding3 = { userId: "synthetic_user_3", sourceRef: "la_user:14", sourceDigest: "c".repeat(64), subjectDigest: identitySubjectDigest(details3.idCardNo,subjectKey) };
    await admin.query("SET ROLE zzsh_synth_identity_m");
    for (const item of [binding2,binding3]) {
      await admin.query(`INSERT INTO zzsh_iam.user_identity_state VALUES($1,'VERIFIED','legacy_mysql_restore',$2)`,[item.userId,item.sourceRef]);
      await admin.query(`INSERT INTO zzsh_iam.user_identity_subject VALUES($1,$2,'LEGACY_IMPORT')`,[item.userId,item.subjectDigest]);
    }
    await admin.query("RESET ROLE");
    await first.query("BEGIN; SET LOCAL ROLE zzsh_synth_identity_m");
    await assert.rejects(recordLegacyIdentityProfiles(first,[{binding:binding2,details:details2},{binding:{...binding3,sourceRef:"la_user:99"},details:details3}],profileKey,subjectKey), (e:unknown)=>(e as {status?:number}).status===503);
    await first.query("ROLLBACK");
    assert.equal(Number((await admin.query("SELECT count(*) FROM zzsh_iam.user_legacy_identity_profile")).rows[0]!.count),1);
    await first.query("BEGIN; SET LOCAL ROLE zzsh_synth_identity_m");
    assert.deepEqual(await recordLegacyIdentityProfiles(first,[{binding:binding2,details:details2},{binding:binding3,details:details3}],profileKey,subjectKey),["CREATED","CREATED"]);
    await first.query("COMMIT");
    await first.query("BEGIN; SET LOCAL ROLE zzsh_synth_identity_m");
    assert.deepEqual(await recordLegacyIdentityProfiles(first,[{binding:binding2,details:details2},{binding:binding3,details:details3}],profileKey,subjectKey),["REPLAYED","REPLAYED"]);
    await first.query("COMMIT");
  } finally {
    if (first) { await first.query("ROLLBACK").catch(() => {}); first.release(); }
    if (second) { await second.query("ROLLBACK").catch(() => {}); second.release(); }
    await admin.query("RESET ROLE").catch(() => {}); admin.release(); await pool.end();
  }
});
