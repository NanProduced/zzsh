// Isolated PostgreSQL only; final-duty resolver is stubbed, imported-source reads and duplicate SQL are real.
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return originalLoad.call(this,name,...args)};
assert.equal(process.env.LEGACY_REVIEW_SOURCE_SYNTH_OPT_IN,'1');
assert.match(process.env.LEGACY_REVIEW_SOURCE_SYNTH_OID??'',/^[1-9]\d*$/);
assert.match(process.env.LEGACY_REVIEW_SOURCE_SYNTH_SYSTEM_ID??'',/^[1-9]\d*$/);
const f=require('../dist/test/legacy-continuation-fixture.js');
const model=require('../dist/src/order/legacy-continuation-model.js');
const dutyResolver=require('../dist/src/order/legacy-duty-basis.js');
const b=f.legacyBinding,head={id:'synthetic-confirm',orderId:b.id,revision:'1',stage:4,isSettle:0};
const duty={id:'synthetic-duty',orderId:b.id,continuationVersionId:head.id,kind:'RENTER_REFUND',sourceRecordId:head.id,
 counterpartyUserId:b.renterUserId,amountCents:'5000',currency:'CNY',status:'PENDING',source:'CONTINUATION',revision:'1',settledBy:null,
 settledRefType:null,settledRefId:null,settledRefDigest:null};
dutyResolver.readLegacyDutyBasis=async()=>({state:'KNOWN',dutyId:duty.id,orderId:b.id,kind:'RENTER_REFUND',beneficiaryUserId:b.renterUserId,
 amountCents:duty.amountCents,currency:'CNY',parentSourceDigest:b.sourceDigest,effectiveHeadId:head.id,effectiveHeadRevision:head.revision,
 continuationVersionId:head.id,fundsDisposition:'AVAILABLE',currentNetRefundCents:duty.amountCents,effectiveFactsDigest:'d'.repeat(64)});
const {readLockedLegacyRefundSource}=require('../dist/src/order/legacy-refund-review-source.js');
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_test_order_settlement_closure',user:'postgres',max:2,statement_timeout:10000});
(async()=>{
 const c=await pool.connect();try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,inet_server_addr()::text AS host,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_test_order_settlement_closure',role:'postgres',host:'127.0.0.1/32',oid:process.env.LEGACY_REVIEW_SOURCE_SYNTH_OID,
   marker:'zzsh:synthetic-settlement-test:v1',system_id:process.env.LEGACY_REVIEW_SOURCE_SYNTH_SYSTEM_ID});
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`INSERT INTO zzsh_supply.game(id,code,name) VALUES($1,'synthetic-review','synthetic review')`,[b.gameId]);
  await c.query(`INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES($1,$2,$3)`,[b.accountId,b.ownerUserId,b.gameId]);
  const source=f.legacyEvidence(model.initialLegacyFacts(f.legacySource()));
  await c.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,source_as_of,evidence_ref,source_digest,
   parameter_digest,admission,reasons,facts,facts_canonical,facts_digest)
   VALUES($1,$2,1,'SOURCE_IMPORT',now(),'synthetic',$3,$4,$5,'[]'::jsonb,$6::jsonb,$7,$8)`,
   [source.id,b.id,b.sourceDigest,source.facts.evidence.parameterDigest,source.facts.evidence.admission,JSON.stringify(source.facts),source.factsCanonical,source.factsDigest]);
  await c.query(`INSERT INTO zzsh_order.legacy_continuation_version(id,order_id,revision,command,actor,input_evidence_id,result_evidence_id,stage,is_settle,
   is_advance_set,amounts,commission_revisions,plan_fingerprint,created_at,refund_policy_revision,refund_wait_days,refund_due_at)
   VALUES($1,$2,1,'CONFIRM','{}'::jsonb,'input','result',4,0,0,'{}'::jsonb,'[]'::jsonb,$3,'2026-11-01T00:00:00Z',1,0,'2026-11-01T00:00:00Z')`,[head.id,b.id,'a'.repeat(64)]);
  await c.query("SET LOCAL session_replication_role='origin'");
  const sourceRead=await readLockedLegacyRefundSource(c,b,head,duty);
  assert.equal(sourceRead.paymentOrderNo,'FIXTURE_P7');assert.equal(sourceRead.paidCents,'10000');assert.equal(sourceRead.dutyCents,'5000');
  await c.query('SAVEPOINT duplicate_source');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,source_as_of,evidence_ref,source_digest,
   parameter_digest,admission,reasons,facts,facts_canonical,facts_digest)
   VALUES('duplicate-source','another-order',1,'SOURCE_IMPORT',now(),'synthetic',$1,$2,$3,'[]'::jsonb,$4::jsonb,$5,$6)`,
   [b.sourceDigest,source.facts.evidence.parameterDigest,source.facts.evidence.admission,JSON.stringify(source.facts),source.factsCanonical,source.factsDigest]);
  await c.query("SET LOCAL session_replication_role='origin'");
  await assert.rejects(readLockedLegacyRefundSource(c,b,head,duty),/LEGACY_PAYMENT_SOURCE_AMBIGUOUS/);
  await c.query('ROLLBACK TO SAVEPOINT duplicate_source');
  for(const [sourceId,number,reject] of [['9','FIXTURE_P7',false],['10','FIXTURE_P7',true],['9','OTHER_NUMBER',true]]){
   await c.query('SAVEPOINT history_source');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,
    source_entity,source_id,source_digest,source_canonical,included_in_opening,snapshot)
    VALUES('history-source','synthetic-user','HISTORICAL_PAYMENT','LEGACY_MYSQL','legacy_mysql_restore','42',
      'la_pay_order',$1,$2,'{}',false,jsonb_build_object('sourceNumber',$3::text))`,[sourceId,'a'.repeat(64),number]);
   await c.query("SET LOCAL session_replication_role='origin'");
   if(reject)await assert.rejects(readLockedLegacyRefundSource(c,b,head,duty),/LEGACY_PAYMENT_SOURCE_AMBIGUOUS/);
   else assert.equal((await readLockedLegacyRefundSource(c,b,head,duty)).paymentOrderNo,'FIXTURE_P7');
   await c.query('ROLLBACK TO SAVEPOINT history_source');
  }
  const directory=require('../dist/src/auth/admin-directory.js'),sessions=require('../dist/src/auth/admin-auth-session.js');
  const authorization=require('../dist/src/auth/admin-authorization.js');
  const profile=require('../dist/src/order/joinpay-refund-profile.js'),refundStore=require('../dist/src/order/channel-refund-store.js');
  const command=require('../dist/src/order/legacy-continuation-command.js'),evidence=require('../dist/src/order/legacy-continuation-evidence.js');
  const core=require('../dist/src/auth/security-core.js');
  const actorLock='-880077001';
  directory.lockActor=async client=>{await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[actorLock]);
   return{status:'ACTIVE',isBoss:false,passwordChangeRequired:false,permissions:new Set(['order.settlement.write'])}};
  sessions.assertAdminCommandAuthorizedInTransaction=async()=>({});
  authorization.loadEffectiveAdminAccess=async()=>({status:'ACTIVE',isBoss:false,passwordChangeRequired:false,permissions:new Set(['order.settlement.write'])});
  const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex'),profileText='{"kind":"SYNTHETIC_PROFILE"}',admissionText='{"kind":"SYNTHETIC_ADMISSION"}';
  profile.assertFormalRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',reference:'synthetic-admission',sha256:hash(admissionText),canonical:admissionText});
  profile.describeRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',profileSha256:hash(profileText),keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
  profile.readRefundProfileEvidence=()=>profileText;refundStore.assertRefundResource=async()=>'1';
  evidence.readLegacyContinuationBinding=async()=>b;evidence.authorizeLegacyContinuation=async()=>({canOperate:true,canReadCommission:false});
  evidence.lockLegacyContinuationOrder=async client=>{await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[model.legacyOrderAdvisoryKey(b.id)]);return{head,duties:[duty]}};
  command.authorizeLegacyMutation=async()=>({binding:b,userIds:[],actor:{}});
  const {recordLegacyRefundReview,readLegacyRefundReview}=require('../dist/src/order/legacy-refund-review-store.js');
  const actor={realm:'admin',userId:'synthetic-staff',sessionId:'synthetic-session',requestId:'synthetic-request'};
  await core.setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
  const input={orderId:b.id,dutyId:duty.id,expectedDutyRevision:'1',expectedHeadRevision:'1',paymentOrderNo:'FIXTURE_P7',confirmedMerchantNo:'12345',
   paidCents:'10000',previouslyRefundedCents:'2000',priorAppliedToDutyCents:'2000',noUnresolvedRefunds:true,evidenceRef:'Synthetic channel check'};
  // A native admin command holds the actor first. The legacy review must not
  // hold the payment key while waiting for that actor, or both can deadlock.
  const concurrent=await pool.connect();let pendingReview,result;
  try {
   await concurrent.query('BEGIN');
   await concurrent.query('SELECT pg_advisory_xact_lock($1::bigint)',[actorLock]);
   const actorPid=(await concurrent.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const reviewPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   pendingReview=recordLegacyRefundReview(c,actor,input,{admission:{},profile:{}});
   let blocked=false;
   for(let i=0;i<50&&!blocked;i++){
    blocked=(await concurrent.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[actorPid,reviewPid])).rows[0].blocked;
    if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));
   }
   assert(blocked,'legacy review must wait for the acting administrator first');
   await concurrent.query("SET LOCAL lock_timeout='2s'");
   await refundStore.lockRefundOrderNo(concurrent,'synthetic-merchant','FIXTURE_P7');
   await concurrent.query('ROLLBACK');
   result=await pendingReview;pendingReview=null;
  }finally{
   await concurrent.query('ROLLBACK').catch(()=>{});
   if(pendingReview)await pendingReview.catch(()=>{});
   concurrent.release();
  }
  assert.equal(result.refundCents,'3000');assert.equal(result.channelResult,'NOT_SUBMITTED');
  const audit=(await c.query(`SELECT actor_id,details FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.reviewed' AND object_id=$1`,[duty.id])).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].actor_id,actor.userId);assert.equal(audit[0].details.refundCents,'3000');
  assert.equal(audit[0].details.source,'STAFF_REVIEW');assert.equal(audit[0].details.channelResult,'NOT_SUBMITTED');
  const reviewed=await readLegacyRefundReview(c,actor,b.id,duty.id,result.reviewId);
  assert.equal(reviewed.reviewDigest,result.reviewDigest);assert.equal(reviewed.refundCents,'3000');
  await assert.rejects(readLegacyRefundReview(c,actor,b.id,duty.id,'other-review'));
  const other=await pool.connect();let waiting;
  try {
   await other.query('BEGIN');const ownerPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const otherPid=(await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const {fingerprintRequest}=require('../dist/src/supply/supply-util.js');
   const nativeBasis={order_id:'synthetic-native-order',payment_confirmation_id:'synthetic-payment',renter_user_id:'synthetic-renter',
    version_hash:'e'.repeat(64),due_at:'2026-11-01T00:00:00.000Z',source:'JOINPAY',merchant_scope_id:'synthetic-merchant',
    provider_transaction_id:'synthetic-transaction',merchant_order_no:'FIXTURE_P7',paid_cents:'10000',responsibility_cents:'5000',currency:'CNY'};
   const previous={id:'synthetic-intent',payment_source:'JOINPAY',evidence_level:'JOINPAY_FORMAL',initial_admission_ref:'synthetic-admission',
    request_fingerprint:fingerprintRequest('rental.refund.intent','synthetic-posting',{amountCents:'100',reason:null}),
    refund_order_no:'SYNTHETIC_RF',state:'READY',budget_disposition:'ALLOCATED'};
   const nativeClient={query:async(sql,args)=>{
    if(sql.includes('FROM zzsh_order.settlement_posting'))return{rows:[nativeBasis]};
    if(sql.includes('pg_advisory_xact_lock'))return other.query(sql,args);
    if(sql.includes('WHERE posting_id=$1 AND idempotency_key=$2'))return{rows:[previous]};
    throw Error('Unexpected synthetic native SQL '+sql);
   }};
   waiting=refundStore.createFormalRefundIntent(nativeClient,{postingId:'synthetic-posting',renterUserId:'synthetic-renter',
    amountCents:'100',idempotencyKey:'synthetic-key',requestId:'synthetic-request'});
   let blocked=false;
   for(let i=0;i<50&&!blocked;i++){
    blocked=(await c.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[ownerPid,otherPid])).rows[0].blocked;
    if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));
   }
   assert(blocked,'native refund must wait for the legacy original payment lock');
   await c.query('ROLLBACK');const replay=await waiting;waiting=null;
   assert.equal(replay.replayed,true);assert.equal(replay.refundOrderNo,'SYNTHETIC_RF');
  }finally{await c.query('ROLLBACK').catch(()=>{});if(waiting)await waiting.catch(()=>{});await other.query('ROLLBACK').catch(()=>{});other.release();}
  console.log('synthetic PostgreSQL legacy refund source, review audit and shared original-number lock: PASS');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1});
