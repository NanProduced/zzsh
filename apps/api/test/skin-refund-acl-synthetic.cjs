// Synthetic database only. The role, 0159 DDL and ACL changes are rolled back together.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const {Pool}=require('pg');
assert.equal(process.env.SKIN_ACL_SYNTH_OPT_IN,'1');
assert.match(process.env.SKIN_ACL_SYNTH_OID??'',/^[1-9]\d*$/);
assert.match(process.env.SKIN_ACL_SYNTH_SYSTEM_ID??'',/^[1-9]\d*$/);
assert.match(process.env.SKIN_ACL_0159_SHA256??'',/^[a-f0-9]{64}$/);
const migration=fs.readFileSync('/proof/0159.sql');
assert.equal(createHash('sha256').update(migration).digest('hex'),process.env.SKIN_ACL_0159_SHA256);
const {configureSkinIdentityPrivileges,configureSettlementRefundPolicyPrivileges}=require('../dist/src/database/business-migrations.js');
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_test_order_settlement_closure',user:'postgres',max:1,statement_timeout:15000});
(async()=>{
 const c=await pool.connect();
 try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,inet_server_addr()::text AS host,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_test_order_settlement_closure',role:'postgres',host:'127.0.0.1/32',oid:process.env.SKIN_ACL_SYNTH_OID,
   marker:'zzsh:synthetic-settlement-test:v1',system_id:process.env.SKIN_ACL_SYNTH_SYSTEM_ID});
  await c.query('BEGIN');
  assert.equal((await c.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_synth_acl_check') AS present")).rows[0].present,false);
  await c.query('CREATE ROLE zzsh_synth_acl_check NOLOGIN');
  await configureSkinIdentityPrivileges(c,'zzsh_synth_acl_check');
  assert.equal((await c.query("SELECT has_column_privilege('zzsh_synth_acl_check','zzsh_supply.skin','category_id','UPDATE') AS allowed")).rows[0].allowed,true);
  await c.query('SAVEPOINT partial');
  await c.query('ALTER TABLE zzsh_supply.skin DROP COLUMN category_id');
  await assert.rejects(configureSkinIdentityPrivileges(c,'zzsh_synth_acl_check'),/Skin category schema is incomplete/);
  await c.query('ROLLBACK TO SAVEPOINT partial');
  await c.query(migration.toString('utf8'));
  await configureSkinIdentityPrivileges(c,'zzsh_synth_acl_check');
  await configureSettlementRefundPolicyPrivileges(c,'zzsh_synth_acl_check');
  const grants=(await c.query(`SELECT to_regclass('zzsh_supply.skin_category') IS NULL AS retired,
   has_column_privilege('zzsh_synth_acl_check','zzsh_supply.skin','name','UPDATE') AS skin_update,
   has_column_privilege('zzsh_synth_acl_check','zzsh_supply.skin','code','UPDATE') AS code_update,
   has_table_privilege('zzsh_synth_acl_check','zzsh_order.settlement_refund_policy','SELECT') AS policy_read,
   has_column_privilege('zzsh_synth_acl_check','zzsh_order.settlement_refund_policy','normal_days','UPDATE') AS policy_update,
   has_table_privilege('zzsh_synth_acl_check','zzsh_order.settlement_refund_policy','INSERT') AS policy_insert`)).rows[0];
  assert.deepEqual(grants,{retired:true,skin_update:true,code_update:false,policy_read:true,policy_update:true,policy_insert:false});
  console.log('synthetic PostgreSQL skin retirement and refund policy ACL: PASS');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
