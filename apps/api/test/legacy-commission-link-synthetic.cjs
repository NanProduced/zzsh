// Isolated PG only. Fixtures bypass import triggers; confirmation-link guards and runtime ACL execute normally.
const assert=require('node:assert/strict'),fs=require('node:fs'),{Pool}=require('pg');
assert.equal(process.env.LEGACY_COMMISSION_LINK_SYNTH_OPT_IN,'1');
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_test_order_settlement_closure',user:'postgres',max:1,statement_timeout:10000});
const h='a'.repeat(64),order='legacy_order_'+'a'.repeat(40),duty='legacy_duty_'+'b'.repeat(40),maturity='2026-10-08T00:00:00.000000Z';
(async()=>{
 const c=await pool.connect();try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,
   (pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_test_order_settlement_closure',role:'postgres',oid:process.env.LEGACY_COMMISSION_LINK_SYNTH_OID,
   marker:'zzsh:synthetic-settlement-test:v1',system_id:process.env.LEGACY_COMMISSION_LINK_SYNTH_SYSTEM_ID});
  assert.equal((await c.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_commission_link_probe') AS present")).rows[0].present,false);
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES('beneficiary','beneficiary','beneficiary@example.invalid',now(),now())`);
  await c.query(`INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,
   account_id,game_id,owner_user_id,renter_user_id,legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_owner_id,owner_source_digest,
   legacy_renter_id,renter_source_digest,source_order_status,source_pay_status,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id)
   VALUES($1,'legacy_mysql_restore','la_order','101',$2,'synthetic','ORIGINAL101','account','game','owner','renter','9','la_rental_accounts',$2,'22',$2,'11',$2,3,1,'{}'::jsonb,1,$2,'staff')`,[order,h]);
  await c.query(`INSERT INTO zzsh_order.legacy_continuation_version(id,order_id,revision,command,actor,input_evidence_id,result_evidence_id,stage,is_settle,
   is_advance_set,amounts,commission_revisions,plan_fingerprint,created_at) VALUES('confirm_1',$1,1,'CONFIRM','{"realm":"admin","userId":"staff"}'::jsonb,'input','result',4,0,0,'{}'::jsonb,'[]'::jsonb,$2,'2026-10-01T00:00:00Z')`,[order,h]);
  await c.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_status,level,ratio,source_digest)
   VALUES($1,$2,'COMMISSION','90','beneficiary',300,'CNY','PENDING','LEGACY_IMPORT','1',2,20,$3)`,[duty,order,h]);
  await c.query("SET LOCAL session_replication_role='origin'");
  await c.query(fs.readFileSync('migrations/business/0170_legacy_commission_confirmation_link.sql','utf8'));
  await c.query('CREATE ROLE zzsh_commission_link_probe NOLOGIN');
  const {applyRuntimePrivileges}=require('../dist/src/database/business-migrations.js');await applyRuntimePrivileges({query:(...args)=>c.query(...args)},'zzsh_commission_link_probe');
  assert.equal((await c.query("SELECT has_column_privilege('zzsh_commission_link_probe','zzsh_order.legacy_order_duty','continuation_version_id','UPDATE') AS allowed")).rows[0].allowed,true);
  async function update(){await c.query(`UPDATE zzsh_order.legacy_order_duty SET amount_cents=500,maturity_at=$2::timestamptz,revision=revision+1,
   revised_at=clock_timestamp(),revised_by='{"realm":"admin","userId":"staff"}'::jsonb,revision_reason='CONFIRM_FINAL_AMOUNT',continuation_version_id='confirm_1'
   WHERE id=$1`,[duty,maturity]);}
  async function revision(version='confirm_1',actor={realm:'admin',userId:'staff'}){await c.query(`INSERT INTO zzsh_order.legacy_order_duty_revision(id,duty_id,revision,before_values,after_values,actor,source_command_version_id,reason)
   VALUES('revision_1',$1,2,$2::jsonb,$3::jsonb,$5::jsonb,$4,'CONFIRM_FINAL_AMOUNT')`,
   [duty,JSON.stringify({amountCents:'300',maturityAt:null}),JSON.stringify({amountCents:'500',maturityAt:maturity}),version,JSON.stringify(actor)]);}
  async function verifyConstraints(){await c.query('SET CONSTRAINTS zzsh_order.legacy_duty_revision_complete,zzsh_order.legacy_commission_confirmation_link_complete IMMEDIATE');}
  await c.query('SAVEPOINT missing_link');await c.query('SET LOCAL ROLE zzsh_commission_link_probe');
  await assert.rejects(c.query(`UPDATE zzsh_order.legacy_order_duty SET amount_cents=500,maturity_at=$2::timestamptz,revision=revision+1,
   revised_at=clock_timestamp(),revised_by='{"realm":"admin","userId":"staff"}'::jsonb,revision_reason='CONFIRM_FINAL_AMOUNT' WHERE id=$1`,[duty,maturity]),e=>e.code==='23514');
  await c.query('ROLLBACK TO SAVEPOINT missing_link');
  await c.query('SAVEPOINT no_revision');await c.query('SET LOCAL ROLE zzsh_commission_link_probe');await update();
  await assert.rejects(verifyConstraints(),e=>e.code==='23514');await c.query('ROLLBACK TO SAVEPOINT no_revision');
  await c.query('SAVEPOINT wrong_actor');await c.query('SET LOCAL ROLE zzsh_commission_link_probe');await update();await revision('confirm_1',{realm:'admin',userId:'other'});
  await assert.rejects(verifyConstraints(),e=>e.code==='23514');await c.query('ROLLBACK TO SAVEPOINT wrong_actor');
  await c.query('SAVEPOINT valid_link');await c.query('SET LOCAL ROLE zzsh_commission_link_probe');await update();await revision();await verifyConstraints();
  const row=(await c.query('SELECT continuation_version_id,amount_cents::text,status FROM zzsh_order.legacy_order_duty WHERE id=$1',[duty])).rows[0];
  assert.deepEqual(row,{continuation_version_id:'confirm_1',amount_cents:'500',status:'PENDING'});
  await c.query('SAVEPOINT relink');await assert.rejects(c.query("UPDATE zzsh_order.legacy_order_duty SET continuation_version_id='other',revision=revision+1 WHERE id=$1",[duty]),e=>e.code==='23514');
  await c.query('ROLLBACK TO SAVEPOINT relink');await c.query('ROLLBACK TO SAVEPOINT valid_link');
  await c.query('ROLLBACK');
  const cleanup=(await c.query(`SELECT to_regprocedure('zzsh_order.check_legacy_commission_confirmation_link()') IS NULL AS helper_absent,
   NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_commission_link_probe') AS role_absent`)).rows[0];
  assert.deepEqual(cleanup,{helper_absent:true,role_absent:true});
  console.log('synthetic PostgreSQL commission confirmation link, revision and runtime ACL: PASS');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1});
