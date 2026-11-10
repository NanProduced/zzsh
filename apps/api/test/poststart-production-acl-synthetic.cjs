// Disposable PostgreSQL only; verifies the production path without demo tables.
const assert=require('node:assert/strict'),{Client}=require('pg');
assert.equal(process.env.POSTSTART_REFUND_SYNTH_OPT_IN,'1');
const port=Number(process.env.POSTSTART_REFUND_SYNTH_PORT);assert(Number.isInteger(port)&&port>1024&&port<65536);
assert(/^[1-9]\d*$/.test(process.env.POSTSTART_REFUND_SYNTH_OID||''));
assert(/^[1-9]\d*$/.test(process.env.POSTSTART_REFUND_SYNTH_SYSTEM_ID||''));
const c=new Client({host:'127.0.0.1',port,database:'zzsh_synth_prod_refund_r2',user:'zzsh_synth_migrator',statement_timeout:10000});
async function main(){
 await c.connect();try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id
   FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_synth_prod_refund_r2',role:'zzsh_synth_migrator',oid:process.env.POSTSTART_REFUND_SYNTH_OID,
   marker:'zzsh:synthetic:production-refund-v1',system_id:process.env.POSTSTART_REFUND_SYNTH_SYSTEM_ID});
  await c.query('BEGIN');
  await require('../dist/src/database/business-migrations.js').applyRuntimePrivileges(c,'zzsh_synth_runtime');
  const rights=(await c.query(`SELECT has_table_privilege('zzsh_synth_runtime','zzsh_order.support_poststart_cancellation','SELECT') AS readable,
   has_table_privilege('zzsh_synth_runtime','zzsh_order.support_poststart_cancellation','INSERT') AS direct_insert,
   has_function_privilege('zzsh_synth_runtime','zzsh_order.cancel_order_after_start(text,bigint,numeric,numeric,text)','EXECUTE') AS can_cancel,
   to_regclass('zzsh_order.ecs_test_demo_finance_registration') IS NULL AS no_demo`)).rows[0];
  assert.deepEqual(rights,{readable:true,direct_insert:false,can_cancel:true,no_demo:true});
  console.log('PASS: production runtime has only the controlled support-cancel executor, without demo schema');
 }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
