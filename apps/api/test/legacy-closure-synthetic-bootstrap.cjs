// Disposable PostgreSQL only. The migration target must match the registered identity and be empty.
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const {runBusinessMigrations,assertBusinessMigrationPrefix}=require('../dist/src/database/business-migrations');
assert.equal(process.env.LEGACY_COMPLETION_SYNTH_OPT_IN,'1');
const base={host:'127.0.0.1',port:55439,database:'zzsh_synth_prod_refund_r3',max:1,statement_timeout:120000};
const admin=new Pool({...base,user:'postgres'}),migrator=new Pool({...base,user:'zzsh_synth_migrator'});
(async()=>{
 try {
  const actual=(await admin.query(`SELECT d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,
   (pg_control_system()).system_identifier::text AS system_id,pg_get_userbyid(d.datdba) AS owner,
   (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS schemas FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(actual,{oid:process.env.LEGACY_COMPLETION_SYNTH_OID,marker:'zzsh:synthetic:production-refund-v1',system_id:process.env.LEGACY_COMPLETION_SYNTH_SYSTEM_ID,owner:'zzsh_synth_migrator',schemas:0});
  await runBusinessMigrations(migrator,{runtimeUser:'zzsh_synth_runtime',initialInstall:true,initialBaseline:'release_production_0174'});
  await assertBusinessMigrationPrefix(migrator);
  console.log('PASS synthetic PostgreSQL: formal initial schema and canonical migrations through 0191');
 } finally {await Promise.all([admin.end(),migrator.end()]);}
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
