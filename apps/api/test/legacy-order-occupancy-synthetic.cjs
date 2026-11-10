// Runs only against the registered disposable PostgreSQL resource and rolls back all fixtures.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { readAccountOccupancyFacts } = require('../dist/src/order/legacy-order-occupancy');
assert.equal(process.env.ORDER_QUEUE_SYNTHETIC, '1');
const pool = new Pool({host:'127.0.0.1',port:55439,database:'zzsh_synth_order_closure',user:'postgres',max:1});
(async()=>{
 const client=await pool.connect();
 try {
  const identity=(await client.query(`SELECT (pg_control_system()).system_identifier::text AS system_id,d.oid::text AS oid,
    shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{system_id:process.env.ORDER_QUEUE_SYNTHETIC_SYSTEM_ID,oid:process.env.ORDER_QUEUE_SYNTHETIC_OID,marker:'zzsh:synthetic:order-closure:v1'});
  await client.query('BEGIN');
  await client.query(`ALTER TABLE zzsh_order.rental_order ADD COLUMN account_id text;
   CREATE TABLE zzsh_order.legacy_order_read_snapshot(id text PRIMARY KEY,account_id text,source_pay_status integer,source_order_status integer);
   CREATE TABLE zzsh_order.legacy_continuation_version(order_id text,command text,stage integer,superseded_at timestamptz);
   CREATE TABLE zzsh_order.legacy_inflight_register(account_id text,disposition text);
   INSERT INTO zzsh_order.legacy_order_read_snapshot VALUES ('ongoing','a',1,3),('cancelled','b',1,8),('old-completed','c',1,4);
   INSERT INTO zzsh_order.legacy_continuation_version VALUES ('cancelled','SUPPORT_CANCEL',5,NULL)`);
  assert.deepEqual(await readAccountOccupancyFacts(client,'a'),{state:'OCCUPIED',kind:'OCCUPIED'});
  assert.deepEqual(await readAccountOccupancyFacts(client,'b'),{state:'FREE',kind:null});
  assert.deepEqual(await readAccountOccupancyFacts(client,'c'),{state:'FREE',kind:null});
  await client.query(`INSERT INTO zzsh_order.legacy_continuation_version VALUES ('ongoing','CONFIRM',4,NULL)`);
  assert.deepEqual(await readAccountOccupancyFacts(client,'a'),{state:'FREE',kind:null,rentalCompleted:true});
  await client.query(`UPDATE zzsh_order.legacy_continuation_version SET superseded_at=clock_timestamp() WHERE order_id='ongoing';
    INSERT INTO zzsh_order.legacy_continuation_version VALUES ('ongoing','RELEASE',4,NULL)`);
  assert.deepEqual(await readAccountOccupancyFacts(client,'a'),{state:'FREE',kind:null,rentalCompleted:true});
  console.log('PASS synthetic PostgreSQL: continued completion is terminal; cancellation and old historical completion are not');
 } finally { await client.query('ROLLBACK');client.release();await pool.end(); }
})().catch(error=>{console.error(error);process.exitCode=1;pool.end().catch(()=>{});});
