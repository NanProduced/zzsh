// Disposable synthetic PostgreSQL only. Provider admission is stubbed; no HTTP or real channel facts.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{Pool}=require('pg');
assert.equal(process.env.POSTSTART_REFUND_SYNTH_OPT_IN,'1');
assert(/^[1-9]\d*$/.test(process.env.POSTSTART_REFUND_SYNTH_OID||''));
assert(/^[1-9]\d*$/.test(process.env.POSTSTART_REFUND_SYNTH_SYSTEM_ID||''));
const port=Number(process.env.POSTSTART_REFUND_SYNTH_PORT);assert(Number.isInteger(port)&&port>1024&&port<65536);
const database=process.env.POSTSTART_REFUND_SYNTH_DATABASE||'zzsh_synth_refund_schema';
assert(['zzsh_synth_refund_schema','zzsh_synth_prod_refund_r2','zzsh_synth_prod_refund_r3','zzsh_ecs_test_synth_r3'].includes(database));
const marker=database==='zzsh_synth_refund_schema'?'zzsh:synthetic:refund-schema-v1':database==='zzsh_ecs_test_synth_r3'?'zzsh:ecs-test:v1':'zzsh:synthetic:production-refund-v1';
const pool=new Pool({host:'127.0.0.1',port,database,user:'postgres',max:3,statement_timeout:10000});
const profiles=require('../dist/src/order/joinpay-refund-profile.js'),store=require('../dist/src/order/channel-refund-store.js');
const original={assertFormalRefundProfile:profiles.assertFormalRefundProfile,describeRefundProfile:profiles.describeRefundProfile,
 assertRefundStart:profiles.assertRefundStart,assertRefundBinding:profiles.assertRefundBinding,assertRefundResource:store.assertRefundResource};
async function main(){
 const c=await pool.connect();
 try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id
   FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:database,role:'postgres',oid:process.env.POSTSTART_REFUND_SYNTH_OID,
   marker,system_id:process.env.POSTSTART_REFUND_SYNTH_SYSTEM_ID});
  if(process.env.POSTSTART_REFUND_SYNTH_READBACK_ONLY==='1'){
   await c.query('BEGIN READ ONLY');
   const {readPersonalSupportCancellationRefund}=require('../dist/src/finance/personal-refund-read.js');
   assert.deepEqual(await readPersonalSupportCancellationRefund(c,'post_order','post_renter','post_payment'),
    {state:'PROCESSING',amountCents:'5000',source:'JOINPAY',bankArrival:'UNKNOWN'});
   const foreign=await readPersonalSupportCancellationRefund(c,'post_order','post_owner','post_payment');
   assert.equal(foreign.state,'UNKNOWN');assert.equal(foreign.amountCents,null);
   console.log('PASS: synthetic cancelled order refund readback and cross-user refusal');return;
  }
  const doc={kind:'FORMAL_NATIVE_REFUND_SERVER_REVIEW',reference:'synthetic_refund_admission',reviewSha256:'a'.repeat(64),
   database:identity.db,runtimeUser:identity.role,merchantIdentityId:'post_merchant',merchantNo:'123456',acceptedProfiles:[
    {operation:'SUBMIT',profileId:'synthetic_profile',profileSha256:'b'.repeat(64),keyVersionRef:'synthetic_key'},
    {operation:'QUERY'},{operation:'NOTIFY'}]};
  const canonical=JSON.stringify(doc),admission={...doc,canonical,sha256:crypto.createHash('sha256').update(canonical).digest('hex')};
  const profile={merchantNo:'123456',profileId:'synthetic_profile',profileSha256:'b'.repeat(64),keyVersionRef:'synthetic_key',notifyUrl:'https://example.invalid/notify'};
  profiles.assertFormalRefundProfile=()=>admission;profiles.describeRefundProfile=()=>profile;
  profiles.assertRefundStart=()=>{};profiles.assertRefundBinding=()=>{};store.assertRefundResource=async()=>{};
  const {createLiabilityFormalRefundIntent}=require('../dist/src/order/prestart-refund-store.js');
  const file=fs.readFileSync(path.join(__dirname,'fixtures/poststart-support-refund-synthetic.sql'),'utf8');
  const boundary=file.indexOf('WITH proof AS (');assert(boundary>0);
  const seed=file.slice(0,boundary).replace(":'refund'::numeric",'5000::numeric').replace(":'owner'::numeric",'3000::numeric');
  if(process.env.POSTSTART_REFUND_SYNTH_ROLLBACK_ONLY==='1'){
   await c.query('BEGIN');
   const existing=(await c.query(`SELECT p.refund_cents::text,p.owner_cents::text,zzsh_order.support_poststart_cancellation_complete(p.id) AS valid,
    (SELECT count(*)::int FROM zzsh_order.channel_refund_intent i WHERE i.order_id=p.order_id) AS intents
    FROM zzsh_order.support_poststart_cancellation p WHERE p.order_id='post_order'`)).rows;
   assert.deepEqual(existing,[{refund_cents:'5000',owner_cents:'3000',valid:true,intents:0}]);
   await c.query("SET LOCAL session_replication_role='replica'");
   await c.query(`UPDATE zzsh_auth_admin.session SET "expiresAt"=clock_timestamp()+interval '1 hour' WHERE id='post_admin_session' AND "userId"='post_admin'`);
   await c.query("SET LOCAL session_replication_role='origin'");
   await c.query("SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id','post_admin',true),set_config('zzsh.session_id','post_admin_session',true),set_config('zzsh.request_id','post_cancel_req',true)");
  }else await c.query(seed);
  await c.query('SET CONSTRAINTS ALL DEFERRED');
  const cancel=(await c.query("SELECT id FROM zzsh_order.support_poststart_cancellation WHERE order_id='post_order'")).rows[0];assert(cancel);
  const input={supportCancellationId:cancel.id,idempotencyKey:'synthetic_partial_refund',requestId:'synthetic_refund_request',admission:{},profile:{}};
  const created=await createLiabilityFormalRefundIntent(c,input);assert.equal(created.kind,'ALLOCATED');
  const replay=await createLiabilityFormalRefundIntent(c,{...input,admission:undefined,profile:undefined});assert.equal(replay.kind,'REPLAYED');
  assert.equal(replay.intentId,created.intentId);
  await assert.rejects(createLiabilityFormalRefundIntent(c,{...input,idempotencyKey:'different_key'}),e=>e.status===409);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const row=(await c.query(`SELECT amount_cents::text,basis_kind,state,budget_disposition,
   zzsh_order.support_cancellation_refund_liability_complete(id) AS complete FROM zzsh_order.channel_refund_intent WHERE id=$1`,[created.intentId])).rows[0];
  assert.deepEqual(row,{amount_cents:'5000',basis_kind:'SUPPORT_CANCELLATION',state:'READY',budget_disposition:'ALLOCATED',complete:true});
  const {readSupportCancellation}=require('../dist/src/order/support-cancel.js');
  const adminView=await readSupportCancellation(c,{userId:'post_admin',sessionId:'post_admin_session'},'post_order');
  assert.equal(adminView.poststartCancellation.refundState,'READY');assert.equal(adminView.poststartCancellation.refundCents,'5000');
  const summary=await require('../dist/src/finance/channel-finance-read.js').readAdminOrderRefundSummary(c,
   {orderId:'post_order',origin:'NATIVE',financeReadable:true});
  assert.equal(summary.integration,'INTEGRATED');assert.equal(summary.intents.length,1);
  assert.equal(summary.intents[0].basisKind,'SUPPORT_CANCELLATION');assert.equal(summary.intents[0].amount.cents,'5000');
  assert.equal(summary.responsibilityBudget.originalCents,'5000');assert.equal(summary.responsibilityBudget.remainingCents,'0');
  const asOf=(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
  const queue=await require('../dist/src/finance/admin-finance-obligation-queues.js').readAdminFinanceObligationQueues(c,asOf,true);
  const pending=queue.refunds.items.find(item=>item.documentRef==='ORDER:post_order');
  assert(pending);assert.equal(pending.source,'SUPPORT_CANCELLATION');assert.equal(pending.amountCents,'5000');
  await c.query('SAVEPOINT conflicted_refund_read');await c.query("SET LOCAL session_replication_role='replica'");
  const raw=Buffer.from('synthetic native refund'),profileCanonical='{}',profileSha=crypto.createHash('sha256').update(profileCanonical).digest('hex'),rawSha=crypto.createHash('sha256').update(raw).digest('hex');
  await c.query(`INSERT INTO zzsh_order.joinpay_refund_attempt(id,intent_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,admission_sha256,request_body,request_sha256,created_at)
    VALUES('post_attempt',$1,'SUBMIT',1,'post_worker','post_profile',$2,$3,'post_key',$3,$4,$5,transaction_timestamp()-interval '1 second')`,[created.intentId,profileCanonical,profileSha,raw,rawSha]);
  await c.query(`INSERT INTO zzsh_order.joinpay_refund_observation(id,intent_id,operation,profile_id,profile_canonical,profile_sha256,key_version_ref,raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,evidence_level,state_before,state_after,request_id)
    VALUES('post_observation',$1,'NOTIFY','post_profile',$2,$3,'post_key',$4,$5,true,NULL,$6,NULL,'PENDING_TERMINAL','VALID','MATCH','MATCH','PROVIDER_RESPONSE','SUBMITTING','SUBMITTING','post_request')`,[created.intentId,profileCanonical,profileSha,raw,rawSha,raw.length]);
  await c.query(`INSERT INTO zzsh_order.joinpay_refund_evidence(id,intent_id,observation_id,operation,terminal,refund_transaction_no,completed_at_raw,completed_at,facts_canonical,facts_digest)
    VALUES('post_evidence_refund',$1,'post_observation','NOTIFY','SUCCEEDED','post_refund_trx','synthetic',transaction_timestamp()-interval '1 second',$2,$3)`,[created.intentId,profileCanonical,profileSha]);
  await c.query(`UPDATE zzsh_order.channel_refund_intent i SET state='SUCCEEDED',budget_disposition='CONSUMED',requires_review=true,lease_version=1,lease_owner='post_worker',lease_until=clock_timestamp()+interval '1 minute',
    terminal_evidence_id='post_evidence_refund',terminal_root_id=p.root_id,terminal_event_id=p.event_id,provider_refund_trx_no='post_refund_trx',completed_at=transaction_timestamp()-interval '1 second'
    FROM zzsh_order.support_poststart_cancellation p WHERE i.id=$1 AND p.order_id=i.order_id`,[created.intentId]);
  await c.query("SET LOCAL session_replication_role='origin'");
  const activity=require('../dist/src/finance/admin-finance-activity.js'),read=await activity.readAdminChannelActivity(c,
    activity.parseActivityQuery(new URLSearchParams('kind=REFUND'),false),{adminId:'post_admin',isBoss:true,orderRead:true,financeDocumentRead:true,resourceRead:true});
  assert.equal(read.items.find(row=>row.id==='refund:post_attempt')?.state,'REVIEW_REQUIRED','a conflicted terminal is not presented as settled');
  const channel=require('../dist/src/finance/admin-finance-dashboard.js').readFinanceDashboardChannels,query={range:'all',basis:'settled',limit:20,source:'new'},viewer={adminId:'post_admin',isBoss:true};
  assert.deepEqual((await channel(c,query,viewer,['post_merchant'])).items,[],'a conflicted terminal is not counted as a confirmed channel refund');
  await c.query("SET LOCAL session_replication_role='replica'");await c.query(`UPDATE zzsh_order.channel_refund_intent SET requires_review=false WHERE id=$1`,[created.intentId]);
  await c.query("SET LOCAL session_replication_role='origin'");
  assert.deepEqual((await channel(c,query,viewer,['post_merchant'])).items,[{kind:'REFUND',count:'1',cents:'5000'}]);
  await c.query('ROLLBACK TO SAVEPOINT conflicted_refund_read');
  console.log('PASS: support partial refund allocation, same-key replay and duplicate budget rejection on synthetic PG');
  await c.query('ROLLBACK');
  if(process.env.POSTSTART_REFUND_SYNTH_ROLLBACK_ONLY==='1')return;
  const contextMarker=seed.indexOf("SELECT set_config('zzsh.actor_type'");assert(contextMarker>0);
  await c.query(seed.slice(0,contextMarker));await c.query('COMMIT');
  const other=await pool.connect(),observer=await pool.connect();
  try{
   const actorSql="SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id','post_admin',true),set_config('zzsh.session_id','post_admin_session',true),set_config('zzsh.request_id','post_cancel_req',true)";
   await c.query('BEGIN');await c.query(actorSql);
   await c.query("SELECT zzsh_order.cancel_order_after_start('post_order',1,5000,3000,'客服协商取消')");
   await other.query('BEGIN');await other.query(actorSql);
   const pidA=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pidB=(await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const waiting=other.query("SELECT zzsh_order.cancel_order_after_start('post_order',1,5000,3000,'客服协商取消')").then(()=>null,e=>e);
   let blocked=false;for(let n=0;n<100&&!blocked;n++){
    blocked=(await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))) AS waiting",[pidB,pidA])).rows[0].waiting;
    if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));
   }
   assert.equal(blocked,true,'a competing cancellation must wait for the original transaction');
   await c.query('COMMIT');const error=await waiting;assert.equal(error?.code,'23514');await other.query('ROLLBACK');
   const final=(await observer.query(`SELECT o.status,(SELECT count(*)::int FROM zzsh_order.support_poststart_cancellation p WHERE p.order_id=o.id) AS cases,
    (SELECT count(*)::int FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED') AS commissions
    FROM zzsh_order.rental_order o WHERE o.id='post_order'`)).rows[0];
   assert.deepEqual(final,{status:'CANCELLED',cases:1,commissions:0});
   await observer.query('BEGIN READ ONLY');
   const {readPersonalSupportCancellationRefund}=require('../dist/src/finance/personal-refund-read.js');
   const visible=await readPersonalSupportCancellationRefund(observer,'post_order','post_renter','post_payment');
   assert.deepEqual(visible,{state:'PROCESSING',amountCents:'5000',source:'JOINPAY',bankArrival:'UNKNOWN'});
   const foreign=await readPersonalSupportCancellationRefund(observer,'post_order','post_owner','post_payment');
   assert.equal(foreign.state,'UNKNOWN');assert.equal(foreign.amountCents,null);
   await observer.query('ROLLBACK');
   console.log('PASS: competing support cancellations wait on real locks and produce one case');
  }finally{await other.query('ROLLBACK').catch(()=>{});other.release();observer.release();}
 }finally{await c.query('ROLLBACK').catch(()=>{});Object.assign(profiles,{assertFormalRefundProfile:original.assertFormalRefundProfile,
  describeRefundProfile:original.describeRefundProfile,assertRefundStart:original.assertRefundStart,assertRefundBinding:original.assertRefundBinding});
  store.assertRefundResource=original.assertRefundResource;c.release();await pool.end();}
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
