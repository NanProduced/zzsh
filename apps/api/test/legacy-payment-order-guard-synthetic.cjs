// Isolated synthetic PostgreSQL only. Fixture inserts bypass triggers; guard tests run as a non-owner and roll back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {Pool} = require('pg');
const Module = require('node:module');
const originalLoad=Module._load;
Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return originalLoad.call(this,name,...args)};
assert.equal(process.env.LEGACY_PAYMENT_GUARD_SYNTH_OPT_IN,'1');
const f=require('../dist/test/legacy-continuation-fixture.js');
const model=require('../dist/src/order/legacy-continuation-model.js');
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_test_order_settlement_closure',user:'postgres',max:2,statement_timeout:10000});
(async()=>{
 const c=await pool.connect();try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id
   FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_test_order_settlement_closure',role:'postgres',oid:process.env.LEGACY_PAYMENT_GUARD_SYNTH_OID,
   marker:'zzsh:synthetic-settlement-test:v1',system_id:process.env.LEGACY_PAYMENT_GUARD_SYNTH_SYSTEM_ID});
  assert.equal((await c.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_guard_synth_probe') AS present")).rows[0].present,false);
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  const source=f.legacyEvidence(model.initialLegacyFacts(f.legacySource()));
  await c.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,source_as_of,evidence_ref,source_digest,
    parameter_digest,admission,reasons,facts,facts_canonical,facts_digest)
    VALUES($1,$2,1,'SOURCE_IMPORT',now(),'synthetic',$3,$4,$5,'[]'::jsonb,$6::jsonb,$7,$8)`,
   [source.id,f.legacyBinding.id,f.legacyBinding.sourceDigest,source.facts.evidence.parameterDigest,source.facts.evidence.admission,
    JSON.stringify(source.facts),source.factsCanonical,source.factsDigest]);
  await c.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,
    source_entity,source_id,source_digest,source_canonical,included_in_opening,snapshot)
    VALUES('history-only','synthetic-user','HISTORICAL_PAYMENT','LEGACY_MYSQL','legacy_mysql_restore','42',
      'la_pay_order','42',$1,'{}',false,'{"sourceNumber":"HISTORY_ONLY"}'::jsonb)`,['a'.repeat(64)]);
  await c.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,
    source_entity,source_id,source_digest,source_canonical,included_in_opening,snapshot)
    VALUES('refund-history-only','synthetic-user','HISTORICAL_REFUND','LEGACY_MYSQL','legacy_mysql_restore','42',
      'la_refund_record','43',$1,'{}',false,'{"sourceNumber":"OLD_REFUND_NO"}'::jsonb)`,['b'.repeat(64)]);
  await c.query("SET LOCAL session_replication_role='origin'");
  await c.query(fs.readFileSync('migrations/business/0168_legacy_payment_order_number_guard.sql','utf8'));
  await c.query('CREATE ROLE zzsh_guard_synth_probe NOLOGIN');
  await c.query('GRANT USAGE ON SCHEMA zzsh_order TO zzsh_guard_synth_probe');
  await c.query('GRANT SELECT ON zzsh_order.legacy_continuation_evidence TO zzsh_guard_synth_probe');
  await c.query('GRANT SELECT ON zzsh_order.personal_finance_observation TO zzsh_guard_synth_probe');
  await c.query('GRANT INSERT ON zzsh_order.payment_request TO zzsh_guard_synth_probe');
  await c.query('CREATE TEMP TABLE payment_guard_probe(channel text,merchant_identity_id text,channel_order_no text) ON COMMIT DROP');
  await c.query('CREATE TRIGGER payment_guard BEFORE INSERT ON payment_guard_probe FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_payment_order_number()');
  await c.query('GRANT INSERT,SELECT ON payment_guard_probe TO zzsh_guard_synth_probe');
  await c.query('SET LOCAL ROLE zzsh_guard_synth_probe');
  const {assertLegacyPaymentNumberAvailable}=require('../dist/src/order/channel-payment-store.js');
  await assert.rejects(assertLegacyPaymentNumberAvailable(c,'merchant_a','HISTORY_ONLY'),error=>error.paymentReason==='ORDER_NOT_PAYABLE');
  await assert.rejects(assertLegacyPaymentNumberAvailable(c,'merchant_b','OLD_REFUND_NO'),error=>error.paymentReason==='ORDER_NOT_PAYABLE');
  await assertLegacyPaymentNumberAvailable(c,'merchant_a','APPLICATION_FRESH');
  // Different internal merchant identities must still serialize the same old payment number.
  const concurrent=await pool.connect();
  try{
   await concurrent.query('BEGIN');await concurrent.query("SET LOCAL lock_timeout='200ms'");
   const {lockRefundOrderNo}=require('../dist/src/order/payment-original-lock.js');
   await assert.rejects(lockRefundOrderNo(concurrent,'merchant_b','APPLICATION_FRESH'),error=>error.code==='55P03');
   await concurrent.query('ROLLBACK');
  }finally{await concurrent.query('ROLLBACK').catch(()=>{});concurrent.release();}
  await c.query('SAVEPOINT collision');
  await assert.rejects(c.query("INSERT INTO payment_guard_probe VALUES('JOINPAY','merchant_a','FIXTURE_P7')"),e=>e.code==='23514'&&/reserved/.test(e.message));
  await c.query('ROLLBACK TO SAVEPOINT collision');
  await c.query('SAVEPOINT real_table_collision');
  await assert.rejects(c.query(`INSERT INTO zzsh_order.payment_request(id,order_id,channel,merchant_identity_id,config_profile_id,protocol_version,
    key_version_ref,platform_order_no,channel_order_no,amount_cents,currency,wire_amount_yuan,method,evidence_level,idempotency_scope_key,idempotency_key,request_fingerprint)
    VALUES('payreq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','synthetic-order','JOINPAY','merchant_a','profile','2.6','key','FIXTURE_P7','FIXTURE_P7',100,'CNY','1.00',
    'WEIXIN_NATIVE','SYNTHETIC_PROTOCOL','scope','key',$1)`,['a'.repeat(64)]),e=>e.code==='23514'&&/reserved/.test(e.message));
  await c.query('ROLLBACK TO SAVEPOINT real_table_collision');
  await c.query('SAVEPOINT historical_collision');
  await assert.rejects(c.query("INSERT INTO payment_guard_probe VALUES('JOINPAY','merchant_a','HISTORY_ONLY')"),e=>e.code==='23514'&&/reserved/.test(e.message));
  await c.query('ROLLBACK TO SAVEPOINT historical_collision');
  await c.query('SAVEPOINT historical_refund_collision');
  await assert.rejects(c.query("INSERT INTO payment_guard_probe VALUES('JOINPAY','merchant_b','OLD_REFUND_NO')"),e=>e.code==='23514'&&/reserved/.test(e.message));
  await c.query('ROLLBACK TO SAVEPOINT historical_refund_collision');
  await c.query("INSERT INTO payment_guard_probe VALUES('JOINPAY','merchant_a','FRESH_ORDER'),('CONTROLLED','merchant_a','FIXTURE_P7')");
  assert.equal((await c.query('SELECT count(*)::int AS n FROM payment_guard_probe')).rows[0].n,2);
  await c.query('RESET ROLE');
  await c.query('SAVEPOINT missing_history_index');
  await c.query('DROP INDEX zzsh_order.legacy_payment_observation_number_idx');
  await c.query('SET LOCAL ROLE zzsh_guard_synth_probe');
  await assert.rejects(assertLegacyPaymentNumberAvailable(c,'merchant_a','APPLICATION_FRESH'),error=>error.paymentReason==='PAYMENT_CHANNEL_NOT_ENABLED');
  await c.query('RESET ROLE');await c.query('ROLLBACK TO SAVEPOINT missing_history_index');
  await c.query('SAVEPOINT missing_refund_index');await c.query('DROP INDEX zzsh_order.legacy_refund_observation_number_idx');
  await c.query('SET LOCAL ROLE zzsh_guard_synth_probe');
  await assert.rejects(assertLegacyPaymentNumberAvailable(c,'merchant_a','APPLICATION_FRESH'),error=>error.paymentReason==='PAYMENT_CHANNEL_NOT_ENABLED');
  await c.query('RESET ROLE');await c.query('ROLLBACK TO SAVEPOINT missing_refund_index');
  // One fixture row makes the old partial index cheaper; remove it only inside this rolled-back transaction to test GIN eligibility.
  await c.query('DROP INDEX zzsh_order.legacy_continuation_one_import');
  await c.query('SET LOCAL enable_seqscan=off');await c.query('SET LOCAL enable_indexscan=off');
  const plan=(await c.query(`EXPLAIN SELECT 1 FROM zzsh_order.legacy_continuation_evidence e WHERE e.source_kind='SOURCE_IMPORT'
   AND e.facts #> '{evidence,source,paidPay}' @> jsonb_build_array(jsonb_build_object('payOrderSn',$1::text))`,['FIXTURE_P7'])).rows.map(row=>row['QUERY PLAN']).join('\n');
  assert.match(plan,/legacy_continuation_paid_order_no_idx/);
  const historyPlan=(await c.query(`EXPLAIN SELECT 1 FROM zzsh_order.personal_finance_observation o
   WHERE o.source_type='LEGACY_MYSQL' AND o.source_kind='HISTORICAL_PAYMENT' AND o.source_system='legacy_mysql_restore' AND o.source_entity='la_pay_order'
    AND o.snapshot->>'sourceNumber'=$1`,['HISTORY_ONLY'])).rows.map(row=>row['QUERY PLAN']).join('\n');
  assert.match(historyPlan,/legacy_payment_observation_number_idx/);
  // One row can make the new partial index cheaper; test that the existing source-id index is also usable.
  await c.query('SAVEPOINT source_index_plan');await c.query('DROP INDEX zzsh_order.legacy_payment_observation_number_idx');
  await c.query('DROP INDEX zzsh_order.zzsh_order_personal_finance_observation_user_kind_event_id_idx');
  const sourcePlan=(await c.query(`EXPLAIN SELECT 1 FROM zzsh_order.personal_finance_observation o
   WHERE o.source_type='LEGACY_MYSQL' AND o.source_kind='HISTORICAL_PAYMENT' AND o.source_system='legacy_mysql_restore'
    AND o.source_entity='la_pay_order' AND o.source_id=$1`,['42'])).rows.map(row=>row['QUERY PLAN']).join('\n');
  assert.match(sourcePlan,/personal_finance_observation_source_type_source_system_sour_key/);
  await c.query('ROLLBACK TO SAVEPOINT source_index_plan');
  await c.query('ROLLBACK');
  const cleanup=(await c.query(`SELECT to_regclass('zzsh_order.legacy_continuation_one_import') IS NOT NULL AS original_exists,
   to_regclass('zzsh_order.legacy_continuation_paid_order_no_idx') IS NULL AS candidate_absent,
   NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_guard_synth_probe') AS role_absent`)).rows[0];
  assert.deepEqual(cleanup,{original_exists:true,candidate_absent:true,role_absent:true});
  console.log('synthetic PostgreSQL legacy payment-number guard: PASS (non-owner, transaction rolled back)');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1});
