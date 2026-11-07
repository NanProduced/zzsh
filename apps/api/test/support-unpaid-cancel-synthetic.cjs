// Dedicated synthetic database only. Authentication is stubbed; SQL locks, constraints and audit are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { Pool } = require('pg');
const load = Module._load;
Module._load = function(name, ...args) { if (name === 'sharp') return function() { throw Error('unused synthetic media'); }; return load.call(this, name, ...args); };
assert.equal(process.env.SUPPORT_UNPAID_SYNTH_OPT_IN, '1');
assert.match(process.env.SUPPORT_UNPAID_SYNTH_OID ?? '', /^[1-9]\d*$/);
assert.match(process.env.SUPPORT_UNPAID_SYNTH_SYSTEM_ID ?? '', /^[1-9]\d*$/);
const pool = new Pool({ host: '127.0.0.1', port: 5432, database: 'zzsh_support_unpaid_synth', user: 'postgres', max: 4, statement_timeout: 15000 });
const directory = require('../dist/src/auth/admin-directory.js');
const sessions = require('../dist/src/auth/admin-auth-session.js');
const access = require('../dist/src/order/manual-close.js');
directory.lockActor = async () => ({});
sessions.assertAdminCommandAuthorizedInTransaction = async () => ({});
access.assertSupportOrderAccess = async () => {};
const { supportCancelUnpaidOrder } = require('../dist/src/order/support-unpaid-cancel.js');
const actor = { userId: 'synthetic-admin', sessionId: 'synthetic-session' };
const input = orderId => ({ orderId, expectedOrderRevision: '1', reason: 'Synthetic support reason', requestId: 'synthetic-request' });

(async () => {
 const c = await pool.connect();
 try {
  const identity = (await c.query(`SELECT current_database() AS db,current_user AS role,inet_server_addr()::text AS host,d.oid::text AS oid,
    shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity, { db:'zzsh_support_unpaid_synth', role:'postgres', host:'127.0.0.1/32', oid:process.env.SUPPORT_UNPAID_SYNTH_OID,
    marker:'zzsh:support-unpaid-synthetic:v1', system_id:process.env.SUPPORT_UNPAID_SYNTH_SYSTEM_ID });
  await c.query(fs.readFileSync('migrations/business/0166_support_cancel_unpaid.sql', 'utf8'));
  await c.query('BEGIN');
  await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES
    ('synthetic-renter','Renter','renter@invalid.example',now(),now()),('synthetic-owner','Owner','owner@invalid.example',now(),now());
    INSERT INTO zzsh_supply.game(id,code,name) VALUES('synthetic-game','synthetic_game','Synthetic');
    INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES
      ('synthetic-account-a','synthetic-owner','synthetic-game'),('synthetic-account-b','synthetic-owner','synthetic-game');
    INSERT INTO zzsh_order.rental_order(id,display_no,account_id,listing_version_id,owner_user_id,renter_user_id,game_id,
      rule_release_id,content_hash,term_option_code,status,rental_amount_cents,deposit_amount_cents,currency,term_seconds,quote_snapshot,title,hold_until)
    VALUES ('synthetic-order-a','SYNTH_A','synthetic-account-a','synthetic-version','synthetic-owner','synthetic-renter','synthetic-game',
      'synthetic-release',repeat('a',64),'synthetic','PENDING_PAYMENT',100,0,'CNY',3600,'{}','Synthetic',now()+interval '1 hour'),
      ('synthetic-order-b','SYNTH_B','synthetic-account-b','synthetic-version','synthetic-owner','synthetic-renter','synthetic-game',
      'synthetic-release',repeat('a',64),'synthetic','PENDING_PAYMENT',100,0,'CNY',3600,'{}','Synthetic',now()+interval '1 hour')`);
  await c.query("SET LOCAL session_replication_role='origin'");
  await c.query('COMMIT');
  await c.query('BEGIN');
  const success = await supportCancelUnpaidOrder(c, actor, input('synthetic-order-a'));
  assert.equal(success.status, 200);
  await c.query('COMMIT');
  const saved=(await c.query(`SELECT status,cancel_reason,revision::text FROM zzsh_order.rental_order WHERE id='synthetic-order-a'`)).rows[0];
  assert.deepEqual(saved,{status:'CANCELLED',cancel_reason:'SUPPORT_UNPAID',revision:'2'});
  const audit=(await c.query(`SELECT actor_id,reason,details->>'channelClosed' AS channel_closed FROM zzsh_iam.audit_event
    WHERE action='order.support_cancel_unpaid' AND object_id='synthetic-order-a'`)).rows[0];
  assert.deepEqual(audit,{actor_id:actor.userId,reason:'Synthetic support reason',channel_closed:'false'});

  const a = await pool.connect(), b = await pool.connect();
  try {
   await a.query('BEGIN'); await b.query('BEGIN');
   await a.query(`SELECT id FROM zzsh_order.rental_order WHERE id='synthetic-order-b' FOR UPDATE`);
   const pending = supportCancelUnpaidOrder(b, actor, input('synthetic-order-b'));
   // The connection is busy in pending, so use the pool's backend inventory to identify its real lock wait.
   let waited = false;
   for (let i=0;i<100;i++) {
    const rows=(await c.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
      AND $1=ANY(pg_blocking_pids(pid))`, [(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid])).rows;
    if(rows.length){waited=true;break;} await new Promise(resolve=>setTimeout(resolve,20));
   }
   assert.equal(waited,true,'cancellation must really wait on the order row');
   await a.query("SET LOCAL session_replication_role='replica'");
   await a.query(`INSERT INTO zzsh_order.payment_request(id,order_id,channel,merchant_identity_id,config_profile_id,protocol_version,key_version_ref,
     platform_order_no,channel_order_no,amount_cents,currency,wire_amount_yuan,method,evidence_level,idempotency_scope_key,idempotency_key,request_fingerprint)
     VALUES('payreq_'||repeat('a',32),'synthetic-order-b','JOINPAY','synthetic-merchant','synthetic-profile','2.6','synthetic-key',
      'SYNTH_B','SYNTH_B',100,'CNY','1.00','WEIXIN_NATIVE','JOINPAY_CANDIDATE','synthetic','synthetic-key',repeat('b',64))`);
   await a.query("SET LOCAL session_replication_role='origin'"); await a.query('COMMIT');
   const blocked = await pending;
   assert.equal(blocked.status,409); assert.equal(blocked.body.reason,'PAYMENT_REVIEW_REQUIRED');
   await b.query('COMMIT');
   const current=(await c.query(`SELECT status,revision::text FROM zzsh_order.rental_order WHERE id='synthetic-order-b'`)).rows[0];
   assert.deepEqual(current,{status:'PENDING_PAYMENT',revision:'1'});
   assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.support_cancel_unpaid' AND object_id='synthetic-order-b'`)).rows[0].n,0);
  } finally { await a.query('ROLLBACK').catch(()=>{}); await b.query('ROLLBACK').catch(()=>{}); a.release(); b.release(); }
  console.log('synthetic PostgreSQL support cancellation and lock race: PASS');
 } finally { await c.query('ROLLBACK').catch(()=>{}); c.release(); await pool.end(); }
})().catch(error => { console.error(error); process.exitCode=1; });
