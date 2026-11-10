// Explicitly registered disposable PostgreSQL only; every privilege/schema change rolls back.
const assert=require('node:assert/strict'),{Client}=require('pg');
assert.equal(process.env.PRESTART_DIRECT_SYNTH_OPT_IN,'1');
const port=Number(process.env.PRESTART_DIRECT_SYNTH_PORT);
assert(Number.isInteger(port)&&port>1024&&port<65536);
assert(/^[1-9]\d*$/.test(process.env.PRESTART_DIRECT_SYNTH_OID||''));
assert(/^[1-9]\d*$/.test(process.env.PRESTART_DIRECT_SYNTH_SYSTEM_ID||''));
const {configureJoinpayFinancialPrivileges}=require('../dist/src/database/business-migrations.js');
const {assertNativePayoutExecutionReady}=require('../dist/src/finance/native-withdrawal-store.js');
const c=new Client({host:'127.0.0.1',port,user:'postgres',database:'zzsh_synth_refund_schema',statement_timeout:10000});
async function main(){
 await c.connect();
 try{
  const i=(await c.query(`SELECT current_database() AS db,current_user AS role,oid::text,shobj_description(oid,'pg_database') AS marker,
   (pg_control_system()).system_identifier::text AS system_id FROM pg_database WHERE datname=current_database()`)).rows[0];
  assert.deepEqual(i,{db:'zzsh_synth_refund_schema',role:'postgres',oid:process.env.PRESTART_DIRECT_SYNTH_OID,
   marker:'zzsh:synthetic:refund-schema-v1',system_id:process.env.PRESTART_DIRECT_SYNTH_SYSTEM_ID});
  await c.query('BEGIN');
  await c.query('CREATE ROLE synth_payout_runtime LOGIN');
  await c.query('GRANT USAGE ON SCHEMA zzsh_order,zzsh_iam,zzsh_supply,zzsh_auth_admin,zzsh_auth_user TO synth_payout_runtime');
  await configureJoinpayFinancialPrivileges(c,'synth_payout_runtime');
  await c.query('SET LOCAL ROLE synth_payout_runtime');await assertNativePayoutExecutionReady(c);await c.query('RESET ROLE');
  await c.query('SAVEPOINT bad_constraint');
  await c.query(`ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_retired_refund_excluded;
   ALTER TABLE zzsh_order.settlement_ledger_entry ADD CONSTRAINT settlement_retired_refund_excluded CHECK(true)`);
  await c.query('SET LOCAL ROLE synth_payout_runtime');
  await assert.rejects(assertNativePayoutExecutionReady(c),/guards, constraints or narrow privileges differ/);
  await c.query('ROLLBACK TO SAVEPOINT bad_constraint');
  await c.query('SAVEPOINT bad_guard');
  const trigger=(await c.query(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
   WHERE tgrelid='zzsh_order.settlement_ledger_entry'::regclass AND tgname='finance_entry_guard'`)).rows[0].def;
  const original=" AND (NOT (new.details ? 'earningId'::text))",changed=trigger.replace(original,'');
  assert.notEqual(changed,trigger);await c.query('DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry');await c.query(changed);
  await c.query('SET LOCAL ROLE synth_payout_runtime');
  await assert.rejects(assertNativePayoutExecutionReady(c),/guards, constraints or narrow privileges differ/);
  await c.query('ROLLBACK TO SAVEPOINT bad_guard');
  await c.query('SET LOCAL ROLE synth_payout_runtime');await assertNativePayoutExecutionReady(c);
  console.log('PASS: retired-refund payout preflight accepts only the intact constraint and exact ledger guards');
 }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
