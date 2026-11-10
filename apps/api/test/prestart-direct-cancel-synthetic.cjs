// Explicitly registered disposable PostgreSQL only; no provider calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Pool}=require('pg');
assert.equal(process.env.PRESTART_DIRECT_SYNTH_OPT_IN,'1');
const port=Number(process.env.PRESTART_DIRECT_SYNTH_PORT);
assert(Number.isInteger(port)&&port>1024&&port<65536);
assert(/^[1-9]\d*$/.test(process.env.PRESTART_DIRECT_SYNTH_OID||''));
assert(/^[1-9]\d*$/.test(process.env.PRESTART_DIRECT_SYNTH_SYSTEM_ID||''));
const pool=new Pool({host:'127.0.0.1',port,database:'zzsh_synth_refund_schema',user:'postgres',max:3,statement_timeout:10000});
const fixture=fs.readFileSync(path.join(__dirname,'fixtures/prestart-direct-cancel-synthetic.sql'),'utf8');
const settlement=require('../dist/src/order/settlement-record.js'),originalLock=settlement.lockSettlement;
const {cancelPrestartTermination}=require('../dist/src/order/prestart-termination.js');
const actors={RENTER:{realm:'user',userId:'synth_renter',sessionId:'synth_session_renter'},
 OWNER:{realm:'user',userId:'synth_owner',sessionId:'synth_session_owner'}};
const request={orderId:'synth_order',expectedOrderRevision:'1',requestId:'synth_cancel_req'};
const reason={RENTER:'RENTER_WRONG_ACCOUNT',OWNER:'OWNER_UNAVAILABLE'};
async function context(c,a){await c.query("SELECT set_config('zzsh.actor_type','user',true),set_config('zzsh.actor_id',$1,true),set_config('zzsh.session_id',$2,true),set_config('zzsh.request_id',$3,true)",[a.userId,a.sessionId,request.requestId]);}
async function seed(c){await c.query('BEGIN');await c.query(fixture);}
async function main(){
 const check=await pool.connect();
 try {
  const r=(await check.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,
   (pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(r,{db:'zzsh_synth_refund_schema',role:'postgres',oid:process.env.PRESTART_DIRECT_SYNTH_OID,
   marker:'zzsh:synthetic:refund-schema-v1',system_id:process.env.PRESTART_DIRECT_SYNTH_SYSTEM_ID});
 } finally {check.release();}
 // This probe exercises the real command/financial triggers; login and the full settlement lock wrapper are separate tests.
 settlement.lockSettlement=async(c,id,a)=>{
  const order=(await c.query('SELECT renter_user_id,owner_user_id FROM zzsh_order.rental_order WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!order||![order.renter_user_id,order.owner_user_id].includes(a.userId))throw Error('synthetic actor denied');
  return order;
 };
 try {
  for(const party of ['RENTER','OWNER']){
   const c=await pool.connect();
   try{await seed(c);await context(c,actors[party]);
    const result=await cancelPrestartTermination(c,actors[party],{...request,reasonCode:reason[party]});
    assert.equal(result.body.request.state,'APPROVED');assert.equal(result.body.request.liabilityRecognized,true);
    assert.equal(result.body.request.fullRefundCents,party==='RENTER'?'10000':null);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const row=(await c.query(`SELECT o.status,t.requested_by_party,d.acting_party,d.reason_code,
      (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=t.liability_event_id) AS lines
     FROM zzsh_order.rental_order o JOIN zzsh_order.prestart_termination t ON t.order_id=o.id
     JOIN zzsh_order.prestart_termination_decision d ON d.termination_id=t.id WHERE o.id='synth_order'`)).rows[0];
    assert.deepEqual(row,{status:'CANCELLED',requested_by_party:party,acting_party:party,reason_code:reason[party],lines:2});
   }finally{await c.query('ROLLBACK');c.release();}
  }
  const wrong=await pool.connect();
  try{await seed(wrong);const actor={...actors.RENTER,sessionId:actors.OWNER.sessionId};await context(wrong,actor);
   await assert.rejects(cancelPrestartTermination(wrong,actor,{...request,reasonCode:reason.RENTER}),e=>e.code==='23514');
  }finally{await wrong.query('ROLLBACK');wrong.release();}
  const a=await pool.connect(),b=await pool.connect(),observer=await pool.connect();
  try{
   await seed(a);await a.query('COMMIT');await a.query('BEGIN');await context(a,actors.RENTER);
   await cancelPrestartTermination(a,actors.RENTER,{...request,reasonCode:reason.RENTER});
   await b.query('BEGIN');
   const pidA=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const pidB=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const waiting=b.query(`INSERT INTO zzsh_order.rental_opening_ack(opening_id,party,user_id,version_no,source)
    VALUES('synth_opening','RENTER','synth_renter',1,'PARTY')`).then(()=>null,e=>e);
   let blocked=false;
   for(let i=0;i<100&&!blocked;i++){
    blocked=(await observer.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
     WHERE pid=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))) AS waiting`,[pidB,pidA])).rows[0].waiting;
    if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));
   }
   assert.equal(blocked,true,'opening must wait on the real cancellation order lock');
   await a.query('COMMIT');const failure=await waiting;assert.equal(failure?.code,'40001');
   await b.query('ROLLBACK');
   const result=(await observer.query(`SELECT status,
    (SELECT count(*)::int FROM zzsh_order.prestart_termination WHERE order_id='synth_order' AND state='APPROVED') AS cancellations,
    (SELECT count(*)::int FROM zzsh_order.rental_opening_ack WHERE opening_id='synth_opening') AS acks
    FROM zzsh_order.rental_order WHERE id='synth_order'`)).rows[0];
   assert.deepEqual(result,{status:'CANCELLED',cancellations:1,acks:0});
  }finally{await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});a.release();b.release();observer.release();}
  console.log('PASS: real cancellation command, PostgreSQL guards for both parties, foreign session and concurrent opening');
 }finally{settlement.lockSettlement=originalLock;await pool.end();}
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
