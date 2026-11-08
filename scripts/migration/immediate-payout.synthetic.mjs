// Synthetic PostgreSQL only; never points at the local R07 delivery database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

assert.equal(process.env.DEMO_PAYOUT_SYNTHETIC_ONLY,'1','SYNTHETIC_OPT_IN_REQUIRED');
const expectedSystem=process.env.DEMO_PAYOUT_SYNTHETIC_SYSTEM_ID;
assert(/^[0-9]+$/.test(expectedSystem??'')&&!['7683455772595376163','7704972584346443810','7705473419326033954'].includes(expectedSystem),'SYNTHETIC_IDENTITY_REQUIRED');
const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),require=createRequire(join(root,'apps/api/package.json')),{Client}=require('pg');
const dir=join(root,'apps/api/migrations/candidates/ecs-test-demo-finance');
const original=readFileSync(join(dir,'demo-withdrawal.sql'),'utf8'),upgrade=readFileSync(join(dir,'immediate-payout.sql'),'utf8');
const settings={host:'127.0.0.1',port:5432,user:'postgres',database:'postgres'};
const admin=new Client(settings);await admin.connect();
const system=(await admin.query('SELECT (pg_control_system()).system_identifier::text AS id')).rows[0].id;
assert.equal(system,expectedSystem,'SYNTHETIC_INSTANCE_MISMATCH');
assert.equal((await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname='zzsh_test_r07_delivery_20261108'")).rows[0].n,0,'SYNTHETIC_DATABASE_MUST_BE_NEW');
await admin.query('CREATE ROLE zzsh_payout_synthetic_owner LOGIN');
await admin.query('CREATE DATABASE zzsh_test_r07_delivery_20261108 OWNER zzsh_payout_synthetic_owner');
await admin.end();
const c=new Client({...settings,user:'zzsh_payout_synthetic_owner',database:'zzsh_test_r07_delivery_20261108'});await c.connect();
try {
  await c.query(`COMMENT ON DATABASE zzsh_test_r07_delivery_20261108 IS 'zzsh:r07-delivery-clone:v1';
    CREATE SCHEMA zzsh_order; CREATE SCHEMA zzsh_auth_user; CREATE SCHEMA zzsh_iam;
    CREATE TABLE zzsh_auth_user."user"(id text PRIMARY KEY,suspended boolean NOT NULL);
    CREATE TABLE zzsh_iam.user_identity_state(user_id text,account_status text);
    CREATE TABLE zzsh_order.ecs_test_demo_finance_registration(reference text,active boolean,registration_digest text,canonical_registration text);
    CREATE FUNCTION zzsh_order.ecs_test_demo_finance_matches(text) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='fixture-digest' $$;
    CREATE TABLE zzsh_order.withdrawal_bank_binding(id text,user_id text,revision bigint,card_mask text);
    CREATE TABLE zzsh_order.withdrawal_admission(id text,user_id text,sandbox_registration_ref text,resource_oid oid,resource_name text,
      resource_marker text,active boolean,expires_at timestamptz,admitted_at timestamptz);
    CREATE TABLE zzsh_order.withdrawal_destination(id text PRIMARY KEY,user_id text,admission_id text,mode text,kind text,scenario text,
      display_mask text,revision bigint,active boolean,sandbox_registration_ref text,bank_binding_id text,bank_binding_revision bigint,valid_until timestamptz,
      CONSTRAINT withdrawal_destination_scenario_check CHECK (scenario IN ('FAIL_UNPAID','TIMEOUT_THEN_SUCCEED')));
    CREATE TABLE zzsh_order.withdrawal_intent(id text PRIMARY KEY,user_id text,admission_id text,destination_id text,payout_key text,state text,
      lease_token_hash text,lease_until timestamptz,net_cents bigint,fee_cents bigint,mode text,sandbox_registration_ref text);
    CREATE TABLE zzsh_order.controlled_payout_operation(id text PRIMARY KEY,intent_id text UNIQUE,payout_key text UNIQUE,scenario text,
      original_lease_hash text,final_evidence_canonical text,
      CONSTRAINT controlled_payout_operation_scenario_check CHECK (scenario IN ('FAIL_UNPAID','TIMEOUT_THEN_SUCCEED')));`);
  for(const name of ['guard_controlled_operation','guard_sandbox_withdrawal_destination','guard_sandbox_withdrawal_intent']){
    const match=original.match(new RegExp(`CREATE OR REPLACE FUNCTION zzsh_order\\.${name}\\(\\)[\\s\\S]*?END \\$function\\$\\s*;`));
    assert(match,`ORIGINAL_GUARD_MISSING: ${name}`);await c.query(match[0]);
  }
  await c.query(`CREATE TRIGGER destination_guard BEFORE INSERT ON zzsh_order.withdrawal_destination FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_sandbox_withdrawal_destination();
    CREATE TRIGGER intent_guard BEFORE INSERT OR UPDATE ON zzsh_order.withdrawal_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_sandbox_withdrawal_intent();
    CREATE TRIGGER operation_guard BEFORE INSERT ON zzsh_order.controlled_payout_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_controlled_operation();`);

  await c.query('BEGIN');await c.query("COMMENT ON DATABASE zzsh_test_r07_delivery_20261108 IS 'wrong'");
  await assert.rejects(c.query(upgrade),/Exact registered test database/);await c.query('ROLLBACK');
  await c.query('BEGIN');await c.query("CREATE OR REPLACE FUNCTION zzsh_order.guard_controlled_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
  await assert.rejects(c.query(upgrade),/Unexpected payout guard/);await c.query('ROLLBACK');
  await c.query('BEGIN');await c.query(upgrade);await assert.rejects(c.query('SELECT 1/0'));await c.query('ROLLBACK');
  const before=(await c.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='withdrawal_destination_scenario_check'")).rows[0].d;
  assert(!before.includes('IMMEDIATE_SUCCESS'),'FAILED_UPGRADE_DID_NOT_ROLL_BACK');
  await c.query('BEGIN');await c.query(upgrade);await c.query('COMMIT');
  await c.query('BEGIN');await assert.rejects(c.query(upgrade),/Unexpected payout guard/);await c.query('ROLLBACK');
  const guards=(await c.query(`SELECT signature,encode(sha256(convert_to(replace(pg_get_functiondef(to_regprocedure(signature)),chr(13)||chr(10),chr(10)),'UTF8')),'hex') AS digest
    FROM unnest(ARRAY['zzsh_order.guard_controlled_operation()','zzsh_order.guard_sandbox_withdrawal_destination()',
      'zzsh_order.guard_sandbox_withdrawal_intent()']) signature`)).rows;
  assert.deepEqual(guards.map(row=>row.digest),['2a746e49329750525137238bf901240e65202fb30438fb73de0f2bca7fcf8254',
    '81e3335ebfeb2cb77ea95f5652eefe64bffa4cf6b4ae177b305d307e5193f3b2','42e8ca7dd1f2ea9a72c65d11420c5af5753ec1e78c88937a1f3d41aa7ab16d4b']);
  const runtime=readFileSync(join(root,'apps/api/src/finance/ecs-test-demo-runtime.ts'),'utf8').replaceAll('\r\n','\n');
  const start=runtime.indexOf("      AND NOT EXISTS(SELECT 1 FROM (VALUES\n        ('zzsh_order.guard_controlled_operation()'");
  const end=runtime.indexOf("\n      AND NOT COALESCE(has_table_privilege",start);
  assert(start>=0&&end>start,'PAYOUT_PREFLIGHT_QUERY_NOT_FOUND');
  const preflight='SELECT true '+runtime.slice(start,end)+' AS ready';
  assert.equal((await c.query(preflight)).rows[0].ready,true);
  await c.query('BEGIN');await c.query("CREATE OR REPLACE FUNCTION zzsh_order.guard_controlled_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
  assert.equal((await c.query(preflight)).rows[0].ready,false);await c.query('ROLLBACK');

  const oid=(await c.query('SELECT oid::text FROM pg_database WHERE datname=current_database()')).rows[0].oid;
  const registration=JSON.stringify({resource:{databaseOid:oid,marker:'zzsh:r07-delivery-clone:v1'}});
  await c.query(`INSERT INTO zzsh_auth_user."user" VALUES ('user',false);
    INSERT INTO zzsh_order.withdrawal_bank_binding VALUES ('bank','user',1,'****1234');`);
  await c.query("INSERT INTO zzsh_order.ecs_test_demo_finance_registration VALUES ('demo',true,'fixture-digest',$1)",[registration]);
  await c.query("INSERT INTO zzsh_order.withdrawal_admission VALUES ('admission','user','demo',$1,current_database(),'zzsh:r07-delivery-clone:v1',true,'infinity',clock_timestamp())",[oid]);
  const addDestination=async(id,scenario,mask='****1234')=>c.query(`INSERT INTO zzsh_order.withdrawal_destination
    SELECT $1,'user','admission','LOCAL_CONTROLLED','BANK_CARD',$2,$3,1,true,'demo','bank',1,
      ((date_trunc('day',admitted_at AT TIME ZONE 'Asia/Shanghai')+interval '1 day') AT TIME ZONE 'Asia/Shanghai')
    FROM zzsh_order.withdrawal_admission WHERE id='admission'`,[id,scenario,mask]);
  const addIntent=async(id,destination)=>c.query(`INSERT INTO zzsh_order.withdrawal_intent VALUES
    ($1,'user','admission',$2,$1||'-key','SUBMITTING','lease',clock_timestamp()+interval '1 minute',400,100,'LOCAL_CONTROLLED','demo')`,[id,destination]);
  const addOperation=async(id,intent,scenario,net=400)=>c.query(`INSERT INTO zzsh_order.controlled_payout_operation VALUES
    ($1,$2,$2||'-key',$3,'lease',$4)`,[id,intent,scenario,JSON.stringify({mode:'LOCAL_CONTROLLED',intentId:intent,payoutKey:intent+'-key',outcome:'SUCCEEDED',reference:id,netCents:String(net),feeCents:'100'})]);
  await c.query('BEGIN');
  await c.query('SAVEPOINT bad_binding');await assert.rejects(addDestination('bad','IMMEDIATE_SUCCESS','wrong'),/exact own stored masked bank binding/);await c.query('ROLLBACK TO SAVEPOINT bad_binding');
  await addDestination('old-destination','TIMEOUT_THEN_SUCCEED');await addDestination('new-destination','IMMEDIATE_SUCCESS');
  await addIntent('old-intent','old-destination');await addIntent('new-intent','new-destination');
  await c.query("SELECT set_config('zzsh.withdrawal_lease_hash','lease',true)");
  await c.query('SAVEPOINT bad_amount');await assert.rejects(addOperation('bad-operation','new-intent','IMMEDIATE_SUCCESS',401),/unadmitted controlled channel operation/);await c.query('ROLLBACK TO SAVEPOINT bad_amount');
  await addOperation('old-operation','old-intent','TIMEOUT_THEN_SUCCEED');await addOperation('new-operation','new-intent','IMMEDIATE_SUCCESS');
  await c.query('SAVEPOINT duplicate');await assert.rejects(addOperation('new-operation-2','new-intent','IMMEDIATE_SUCCESS'),error=>error.code==='23505');await c.query('ROLLBACK TO SAVEPOINT duplicate');
  assert.equal((await c.query('SELECT count(*)::int n FROM zzsh_order.controlled_payout_operation')).rows[0].n,2);
  await c.query('ROLLBACK');
  console.log(JSON.stringify({status:'PASS',scope:'synthetic PostgreSQL only',systemIdentifier:system,assertions:['wrong database marker refused','changed guard refused','transaction rollback','one upgrade only','old timeout preserved','immediate success allowed','wrong binding refused','wrong amount refused','duplicate payout refused'],notRun:['real R07','ECS','real channels']}));
} finally {await c.end();}
