// Isolated PG guard test only. Seeded refund is synthetic; no HTTP or channel calls occur.
const assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{Pool}=require('pg');
assert.equal(process.env.REFUND_REVIEW_SYNTH_OPT_IN,'1');
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_test_order_settlement_closure',user:'postgres',max:1,statement_timeout:10000});
const canonical='{}',digest=createHash('sha256').update(canonical).digest('hex'),h='a'.repeat(64);
(async()=>{
 const c=await pool.connect();try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,
   (pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_test_order_settlement_closure',role:'postgres',oid:process.env.REFUND_REVIEW_SYNTH_OID,
   marker:'zzsh:synthetic-settlement-test:v1',system_id:process.env.REFUND_REVIEW_SYNTH_SYSTEM_ID});
  await c.query('BEGIN');
  await c.query('CREATE TEMP TABLE refund_guard_probe (LIKE zzsh_order.channel_refund_intent INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP');
  await c.query('CREATE TRIGGER refund_guard BEFORE UPDATE ON refund_guard_probe FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_intent()');
  await c.query(`INSERT INTO refund_guard_probe(id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,
   merchant_identity_id,original_payment_trx_no,original_payment_order_no,responsibility_version_hash,refund_order_no,amount_cents,currency,idempotency_key,
   request_fingerprint,state,revision,lease_version,lease_owner,lease_until,due_at,evidence_level,initial_admission_ref,initial_admission_sha256,
   initial_admission_canonical,wire_merchant_no,initial_profile_id,initial_profile_sha256,initial_key_version_ref,notify_url,requires_review)
   VALUES('synthetic-refund','synthetic-posting','synthetic-order','synthetic-payment','synthetic-renter','JOINPAY','merchant-a','trx-a','order-a',$1,$2,
   100,'CNY','synthetic-key',$1,'UNKNOWN',1,1,'old-worker',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 day','JOINPAY_FORMAL',
   'synthetic-admission',$3,$4,'12345','synthetic-profile',$1,'synthetic-keyref','https://example.invalid/refund',true)`,[h,'RF'+'a'.repeat(28),digest,canonical]);
  const claim=(await c.query(`UPDATE refund_guard_probe SET state=CASE WHEN state='READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END,
   lease_version=lease_version+1,lease_owner='support-query',lease_until=clock_timestamp()+interval '30 seconds',revision=revision+1
   WHERE id='synthetic-refund' RETURNING state,requires_review,budget_disposition,lease_version::text`)).rows[0];
  assert.deepEqual(claim,{state:'UNKNOWN',requires_review:true,budget_disposition:'ALLOCATED',lease_version:'2'});
  await c.query('SAVEPOINT invalid_clear');
  await assert.rejects(c.query("UPDATE refund_guard_probe SET requires_review=false,revision=revision+1 WHERE id='synthetic-refund'"),e=>['23514','40001'].includes(e.code));
  await c.query('ROLLBACK TO SAVEPOINT invalid_clear');
  await c.query('SAVEPOINT invalid_terminal');
  await assert.rejects(c.query("UPDATE refund_guard_probe SET state='SUCCEEDED',revision=revision+1 WHERE id='synthetic-refund'"),e=>['23514','40001'].includes(e.code));
  await c.query('ROLLBACK TO SAVEPOINT invalid_terminal');
  console.log('synthetic PostgreSQL review-query lease retains review and refund budget: PASS');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1});
