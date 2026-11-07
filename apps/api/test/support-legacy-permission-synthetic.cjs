// The preset migration and synthetic admins live only inside one rolled-back transaction.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Pool}=require('pg');
assert.equal(process.env.SUPPORT_LEGACY_SYNTH_OPT_IN,'1');
assert.match(process.env.SUPPORT_LEGACY_SYNTH_OID??'',/^[1-9]\d*$/);
assert.match(process.env.SUPPORT_LEGACY_SYNTH_SYSTEM_ID??'',/^[1-9]\d*$/);
const {loadEffectiveAdminAccess}=require('../dist/src/auth/admin-authorization.js');
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_test_order_settlement_closure',user:'postgres',max:1,statement_timeout:10000});
(async()=>{
 const c=await pool.connect();
 try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,inet_server_addr()::text AS host,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_test_order_settlement_closure',role:'postgres',host:'127.0.0.1/32',oid:process.env.SUPPORT_LEGACY_SYNTH_OID,
   marker:'zzsh:synthetic-settlement-test:v1',system_id:process.env.SUPPORT_LEGACY_SYNTH_SYSTEM_ID});
  await c.query('BEGIN');
  await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt") VALUES
   ('synthetic-support-allowed','Support','support-allowed@invalid.example',now(),now()),
   ('synthetic-support-denied','Support','support-denied@invalid.example',now(),now());
   INSERT INTO zzsh_iam.admin_security(admin_user_id,status,first_activated_at) VALUES
   ('synthetic-support-allowed','ACTIVE',now()),('synthetic-support-denied','ACTIVE',now());
   INSERT INTO zzsh_iam.admin_user_role(admin_user_id,role_id) VALUES
   ('synthetic-support-allowed','role_preset_support'),('synthetic-support-denied','role_preset_support');
   INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect)
   VALUES('synthetic-support-denied','order.legacy.continue','DENY')`);
  await c.query("SET LOCAL session_replication_role='origin'");
  const migration=fs.readFileSync('migrations/business/0167_support_legacy_continuation.sql','utf8');
  await c.query(migration);await c.query(migration);
  const allowed=await loadEffectiveAdminAccess(c,'synthetic-support-allowed'),denied=await loadEffectiveAdminAccess(c,'synthetic-support-denied');
  assert.equal(allowed.permissions.has('order.legacy.continue'),true);
  assert.equal(allowed.permissions.has('order.read'),true);
  assert.equal(denied.permissions.has('order.legacy.continue'),false);
  assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_iam.admin_role_permission WHERE role_id='role_preset_support' AND permission_code='order.legacy.continue'")).rows[0].n,1);
  console.log('synthetic PostgreSQL support legacy permission and personal DENY: PASS');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
