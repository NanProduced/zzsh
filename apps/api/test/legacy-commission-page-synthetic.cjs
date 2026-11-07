// Dedicated disposable synthetic PG: only the selection and transaction driver use the real database.
const assert=require('node:assert/strict'),fs=require('node:fs'),{Pool}=require('pg'),Module=require('node:module');
const load=Module._load;Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return load.call(this,name,...args)};
assert.equal(process.env.LEGACY_DUE_PAGE_SYNTH_OPT_IN,'1');
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_legacy_due_synth',user:'postgres',max:1,statement_timeout:15000});
(async()=>{
 const c=await pool.connect();let held=false;try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id
   FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_legacy_due_synth',role:'postgres',oid:process.env.LEGACY_DUE_PAGE_SYNTH_OID,
   marker:'zzsh:legacy-due-synthetic:v1',system_id:process.env.LEGACY_DUE_PAGE_SYNTH_SYSTEM_ID});
  await c.query(fs.readFileSync('migrations/business/0169_legacy_finance_duty_runtime.sql','utf8'));
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  for(let i=1;i<=7;i++){
   await c.query(`INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,
    account_id,game_id,owner_user_id,renter_user_id,legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_owner_id,owner_source_digest,
    legacy_renter_id,renter_source_digest,source_order_status,source_pay_status,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id)
    VALUES($1,'legacy_mysql_restore','la_order',$2,$3,'synthetic',$4,'account','game','owner','renter','33','la_rental_accounts',$3,'22',$3,'11',$3,$5,1,'{}',1,$3,'staff')`,
    ['order_'+i,String(i),'a'.repeat(64),'SYNTHETIC_'+i,i>=6?4:[3,8,9,3,3][i-1]]);
   await c.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,continuation_version_id,kind,source_record_id,counterparty_user_id,
    amount_cents,currency,status,source,source_status,level,ratio,maturity_at,source_digest,admission_id)
    VALUES($1,$2,$3,'COMMISSION',$4,'owner',100,'CNY',$5,'LEGACY_IMPORT','1',2,20,
     clock_timestamp()+make_interval(hours=>$6::int),$7,$8)`,
    ['duty_'+i,'order_'+i,i===7?null:'version_'+i,String(i),i===2?'MATURED':'PENDING',i===5?2:i===7?-1:i-6,'a'.repeat(64),i===7?'admission_7':null]);
  }
  await c.query("SET LOCAL session_replication_role='origin'");await c.query('COMMIT');
  await c.query('SET enable_seqscan=off');
  const plan=(await c.query(`EXPLAIN SELECT id FROM zzsh_order.legacy_order_duty WHERE kind='COMMISSION'
   AND status IN('PENDING','MATURED') AND (continuation_version_id IS NOT NULL OR admission_id IS NOT NULL)
   AND maturity_at<=statement_timestamp() ORDER BY maturity_at,id COLLATE "C" LIMIT 2`)).rows.map(row=>row['QUERY PLAN']).join('\n');
  assert.match(plan,/legacy_commission_due_idx/);await c.query('RESET enable_seqscan');
  assert.equal((await c.query('SELECT pg_try_advisory_lock(806007::bigint) AS locked')).rows[0].locked,true);held=true;
  const finance=require('../dist/src/order/legacy-finance-duty.js'),actual=finance.settleLegacyCommissionDueOn,seen=[];
  finance.settleLegacyCommissionDueOn=async(_client,_order,id)=>{seen.push(id);return {outcome:id==='duty_1'?'REVIEW_REQUIRED':'POSTED'}};
  try {
   const {runLegacyCommissionDuePage}=require('../dist/src/finance/legacy-commission-due-worker.js');
   const a=await runLegacyCommissionDuePage(c,null,2);assert.deepEqual([a.scanned,a.posted,a.deferred,a.cursor.id],[2,1,1,'duty_2']);
   const b=await runLegacyCommissionDuePage(c,a.cursor,2);assert.deepEqual([b.scanned,b.posted,b.deferred,b.cursor.id],[2,2,0,'duty_4']);
   const end=await runLegacyCommissionDuePage(c,b.cursor,2);assert.equal(end.scanned,1);assert.equal(end.cursor,null);
   assert.deepEqual(seen,['duty_1','duty_2','duty_3','duty_4','duty_7']);
  }finally{finance.settleLegacyCommissionDueOn=actual;}
  console.log('synthetic PostgreSQL legacy commission pagination and transaction driver: PASS (posting stubbed)');
 }finally{await c.query('ROLLBACK').catch(()=>{});if(held)await c.query('SELECT pg_advisory_unlock(806007::bigint)').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1});
