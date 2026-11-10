// Two real PostgreSQL sessions prove the order lock waits; no business rows are changed.
const assert=require('node:assert/strict'),{Pool}=require('pg');
const {lockLegacyContinuationOrder}=require('../dist/src/order/legacy-continuation-evidence');
assert.equal(process.env.LEGACY_COMPLETION_SYNTH_OPT_IN,'1');
const pool=new Pool({host:'127.0.0.1',port:55439,database:'zzsh_synth_prod_refund_r3',user:'postgres',max:3});
(async()=>{
 const first=await pool.connect(),second=await pool.connect(),observer=await pool.connect();
 try {
  const identity=(await observer.query(`SELECT (pg_control_system()).system_identifier::text AS system_id,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{system_id:process.env.LEGACY_COMPLETION_SYNTH_SYSTEM_ID,oid:process.env.LEGACY_COMPLETION_SYNTH_OID,marker:'zzsh:synthetic:production-refund-v1'});
  const pidA=(await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pidB=(await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const order='legacy_order_'+'a'.repeat(40);await first.query('BEGIN');await second.query('BEGIN');
  await lockLegacyContinuationOrder(first,order);
  const waiting=lockLegacyContinuationOrder(second,order);
  let blocked=false;
  for(let n=0;n<40&&!blocked;n++){
   blocked=(await observer.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',[pidA,pidB])).rows[0].blocked;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(blocked,true,'second session must actually wait for the first transaction');
  await first.query('COMMIT');assert.deepEqual(await waiting,{head:null,duties:[]});await second.query('COMMIT');
  console.log('PASS synthetic PostgreSQL: competing legacy order writes acquire the same transaction lock');
 } finally {
  await first.query('ROLLBACK').catch(()=>{});await second.query('ROLLBACK').catch(()=>{});
  first.release();second.release();observer.release();await pool.end();
 }
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;pool.end().catch(()=>{});});
