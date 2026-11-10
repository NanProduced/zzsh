// Disposable PostgreSQL only; provider and allocation are substituted, queue SQL and audit are real.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
assert.equal(process.env.ORDER_QUEUE_SYNTHETIC, '1');
const pool = new Pool({ host: '127.0.0.1', port: 55439, database: 'zzsh_synth_order_closure', user: 'postgres', max: 3 });
const profile = require('../dist/src/order/joinpay-refund-profile');
const store = require('../dist/src/order/channel-refund-store');
const { SecurityApiError } = require('../dist/src/auth/security-core');
const admission = { database: 'zzsh_synth_order_closure', runtimeUser: 'postgres', merchantIdentityId: 'synthetic_merchant' };
profile.assertFormalRefundProfile = () => admission;
profile.assertRefundStart = () => {};
let calls = [];
store.createPostedNativeRefundIntent = async (client, input) => {
  calls.push(input.postingId);
  if (input.postingId === 'posting_1') throw new SecurityApiError(409, 'CONFLICT', 'Original payment refund requires review');
  await client.query('INSERT INTO zzsh_order.channel_refund_intent(posting_id) VALUES($1)', [input.postingId]);
  return { outcome: 'ALLOCATED' };
};
const { allocatePostedJoinpayRefunds } = require('../dist/src/order/joinpay-refund-attempt');

(async () => {
  const client = await pool.connect();
  try {
    const identity = (await client.query(`SELECT (pg_control_system()).system_identifier::text AS system_id,d.oid::text AS oid,
      shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert.deepEqual(identity, { system_id: process.env.ORDER_QUEUE_SYNTHETIC_SYSTEM_ID, oid: process.env.ORDER_QUEUE_SYNTHETIC_OID,
      marker: 'zzsh:synthetic:order-closure:v1' });
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA zzsh_order; CREATE SCHEMA zzsh_iam;
      CREATE TABLE zzsh_iam.audit_event(id text PRIMARY KEY,actor_type text,actor_id text,session_id text,action text,object_type text,
        object_id text,outcome text,request_id text,reason text,occurred_at timestamptz,details jsonb);
      CREATE TABLE zzsh_order.rental_order(id text PRIMARY KEY,paid_confirmation_id text,status text);
      CREATE TABLE zzsh_order.payment_confirmation(id text PRIMARY KEY,order_id text,source text,disposition text,merchant_scope_id text,currency text,amount_cents numeric);
      CREATE TABLE zzsh_order.settlement_posting(id text PRIMARY KEY,order_id text,payment_confirmation_id text,captured_cents numeric,
        renter_refund_cents numeric,currency text,refund_due_at timestamptz);
      CREATE TABLE zzsh_order.channel_refund_intent(posting_id text);
      INSERT INTO zzsh_order.rental_order VALUES ('order_1','payment_1','COMPLETED'),('order_2','payment_2','COMPLETED');
      INSERT INTO zzsh_order.payment_confirmation VALUES ('payment_1','order_1','JOINPAY','APPLIED','synthetic_merchant','CNY',10000),
        ('payment_2','order_2','JOINPAY','APPLIED','synthetic_merchant','CNY',10000);
      INSERT INTO zzsh_order.settlement_posting VALUES ('posting_1','order_1','payment_1',10000,1000,'CNY',now()),
        ('posting_2','order_2','payment_2',10000,1000,'CNY',now())`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  try {
    const execution = { pool, admission: {}, initialProfile: {} };
    assert.deepEqual(await allocatePostedJoinpayRefunds(execution, 2), { selected: 2, allocated: 1, replayed: 0, skipped: 1 });
    assert.deepEqual(calls, ['posting_1', 'posting_2']);
    const audits = (await pool.query(`SELECT object_id,reason FROM zzsh_iam.audit_event WHERE action='order.refund.allocation.deferred'`)).rows;
    assert.deepEqual(audits, [{ object_id: 'posting_1', reason: 'Original payment refund requires review' }]);
    calls = [];
    assert.deepEqual(await allocatePostedJoinpayRefunds(execution, 2), { selected: 0, allocated: 0, replayed: 0, skipped: 0 });
    assert.deepEqual(calls, []);
    console.log('PASS synthetic PostgreSQL: one deferred posting does not starve the next refund; no channel call');
  } finally { await pool.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; pool.end().catch(() => {}); });
