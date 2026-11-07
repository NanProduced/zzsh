// Isolated synthetic PostgreSQL only; fixtures use replica mode, every mutation rolls back.
const assert=require('node:assert/strict'),fs=require('node:fs'),{createHash}=require('node:crypto'),{Pool}=require('pg');
const Module=require('node:module'),load=Module._load;Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return load.call(this,name,...args)};
assert.equal(process.env.NATIVE_REVIEW_SYNTH_OPT_IN,'1');
const concurrent=process.env.NATIVE_REVIEW_SYNTH_CONCURRENCY==='1';
const database=concurrent?'zzsh_native_review_concurrency':'zzsh_test_order_settlement_closure';
const marker=concurrent?'zzsh:native-review-concurrency:v1':'zzsh:synthetic-settlement-test:v1';
const pool=new Pool({host:'127.0.0.1',port:5432,database,user:'postgres',max:3,statement_timeout:15000});
const sha=s=>createHash('sha256').update(s).digest('hex'),h='a'.repeat(64),canonical='{}';
const admissionText=JSON.stringify({kind:'FORMAL_NATIVE_REFUND_SERVER_REVIEW',reference:'synthetic-admission',database,
 runtimeUser:'zzsh_native_review_synth',merchantIdentityId:'merchant-a',merchantNo:'12345',acceptedProfiles:[{operation:'SUBMIT',profileId:'synthetic-profile',profileSha256:h,keyVersionRef:'synthetic-keyref'}]});
(async()=>{const c=await pool.connect();try{
 const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,
  (pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(identity,{db:database,role:'postgres',oid:process.env.NATIVE_REVIEW_SYNTH_OID,marker,system_id:process.env.NATIVE_REVIEW_SYNTH_SYSTEM_ID});
 assert.equal((await c.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_native_review_synth') AS found")).rows[0].found,false);
 await c.query('BEGIN');for(const file of ['0168_legacy_payment_order_number_guard.sql','0169_legacy_finance_duty_runtime.sql','0170_legacy_commission_confirmation_link.sql','0171_legacy_refund_case.sql'])
  await c.query(fs.readFileSync('migrations/business/'+file,'utf8'));
 const migration=fs.readFileSync('migrations/business/0172_native_refund_review_resume.sql','utf8');
 await c.query('SAVEPOINT altered_guard');
 await c.query('CREATE OR REPLACE FUNCTION zzsh_order.guard_joinpay_refund_intent() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$');
 await assert.rejects(c.query(migration),e=>e.code==='55000');await c.query('ROLLBACK TO SAVEPOINT altered_guard');
 await c.query(migration);
 await c.query('CREATE ROLE zzsh_native_review_synth NOLOGIN');
 await c.query('GRANT USAGE ON SCHEMA zzsh_order,zzsh_iam,zzsh_auth_admin,zzsh_auth_user TO zzsh_native_review_synth');
 await c.query('GRANT SELECT,UPDATE ON zzsh_order.channel_refund_intent TO zzsh_native_review_synth');
 await c.query('GRANT SELECT ON zzsh_order.joinpay_refund_attempt,zzsh_order.joinpay_refund_observation,zzsh_order.joinpay_refund_evidence,zzsh_order.finance_economic_root TO zzsh_native_review_synth');
 await c.query('GRANT SELECT,UPDATE ON zzsh_auth_user."user" TO zzsh_native_review_synth');
 await c.query('GRANT SELECT ON zzsh_order.wallet_revision TO zzsh_native_review_synth');
 await c.query('GRANT SELECT,INSERT,UPDATE ON zzsh_order.native_refund_review_resolution TO zzsh_native_review_synth');
 const {configureNativeRefundReviewPrivileges}=require('../dist/src/database/business-migrations.js');
 await configureNativeRefundReviewPrivileges({query:(...args)=>c.query(...args)},'zzsh_native_review_synth');
 assert.equal((await c.query("SELECT has_function_privilege('zzsh_native_review_synth','zzsh_order.resume_native_refund_review(text,text)','EXECUTE') AS allowed")).rows[0].allowed,true);
 assert.equal((await c.query("SELECT has_function_privilege('zzsh_native_review_synth','zzsh_order.resolve_native_refund_terminal(text,text)','EXECUTE') AS allowed")).rows[0].allowed,true);
 assert.equal((await c.query("SELECT has_table_privilege('zzsh_native_review_synth','zzsh_order.native_refund_review_resolution','INSERT') AS allowed")).rows[0].allowed,false);
 await c.query("SET LOCAL session_replication_role='replica'");
 await c.query(`INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES
  ('native-review-renter','Renter','renter@invalid.example',now(),now()),('native-review-owner','Owner','owner@invalid.example',now(),now());
  INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES
   ('native-review-admin','Admin','admin@invalid.example',true,now(),now()),('native-review-second','Second','second@invalid.example',true,now(),now()),('native-review-denied','Denied','denied@invalid.example',true,now(),now());
  INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at) VALUES
   ('native-review-admin','ACTIVE',false,now()),('native-review-second','ACTIVE',false,now()),('native-review-denied','ACTIVE',false,now());
  INSERT INTO zzsh_auth_admin."session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES
   ('native-review-session','native-review-admin','synthetic-token-1',clock_timestamp()+interval '1 hour',now(),now()),
   ('native-review-denied-session','native-review-denied','synthetic-token-2',clock_timestamp()+interval '1 hour',now(),now()),
   ('native-review-second-session','native-review-second','synthetic-token-3',clock_timestamp()+interval '1 hour',now(),now());
  INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES('native-review-admin','order.settlement.write','ALLOW'),('native-review-second','order.settlement.write','ALLOW');
  INSERT INTO zzsh_supply.game(id,code,name) VALUES('native-review-game','native_review','Synthetic');
  INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES('native-review-account','native-review-owner','native-review-game');
  INSERT INTO zzsh_order.rental_order(id,display_no,account_id,listing_version_id,owner_user_id,renter_user_id,game_id,
   rule_release_id,content_hash,term_option_code,status,rental_amount_cents,deposit_amount_cents,currency,term_seconds,quote_snapshot,title,hold_until)
  VALUES('native-review-order','SYNTH_REVIEW','native-review-account','synthetic-version','native-review-owner','native-review-renter','native-review-game',
   'synthetic-release',repeat('a',64),'synthetic','PENDING_PAYMENT',100,0,'CNY',3600,'{}','Synthetic',now()+interval '1 hour');
  INSERT INTO zzsh_order.payment_confirmation(id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,amount_cents,currency,provider_paid_at,disposition,request_id)
   VALUES('synthetic-payment','CONTROLLED','merchant-a','trx-a','order-a','native-review-order',100,'CNY',now(),'APPLIED','synthetic-request');
  INSERT INTO zzsh_order.settlement_posting(id,order_id,settlement_version_id,payment_confirmation_id,version_hash,early,captured_cents,
   system_owner_net_cents,owner_net_cents,system_renter_refund_cents,renter_refund_cents,platform_contribution_cents,compensation_fee_cents,posted_at,refund_due_at)
   VALUES('synthetic-posting','native-review-order','synthetic-settlement','synthetic-payment',repeat('a',64),false,100,0,0,100,100,0,0,now(),now());
  INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES('native-review-renter',0,0)`);
 await c.query(`INSERT INTO zzsh_order.channel_refund_intent(id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,
  merchant_identity_id,original_payment_trx_no,original_payment_order_no,responsibility_version_hash,refund_order_no,amount_cents,currency,idempotency_key,
  request_fingerprint,state,revision,lease_version,lease_owner,lease_until,due_at,evidence_level,initial_admission_ref,initial_admission_sha256,
  initial_admission_canonical,wire_merchant_no,initial_profile_id,initial_profile_sha256,initial_key_version_ref,notify_url,requires_review)
  VALUES('native-review-intent','synthetic-posting','native-review-order','synthetic-payment','native-review-renter','JOINPAY','merchant-a','trx-a','order-a',$1,$2,
   100,'CNY','synthetic-key',$1,'UNKNOWN',1,1,'old-worker',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 day','JOINPAY_FORMAL',
   'synthetic-admission',$3,$4,'12345','synthetic-profile',$1,'synthetic-keyref','https://example.invalid/refund',true)`,[h,'RF'+'a'.repeat(28),sha(admissionText),admissionText]);
 await c.query(`INSERT INTO zzsh_order.joinpay_refund_attempt(id,intent_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,admission_sha256,request_body,request_sha256)
  VALUES('native-review-submit','native-review-intent','SUBMIT',1,'old-worker','synthetic-profile',$1,$2,'synthetic-keyref',$3,$4,$5)`,[canonical,sha(canonical),h,Buffer.from('request'),sha('request')]);
 await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_native_review_synth');
 const context=async(user,session,request)=>c.query("SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id',$1,true),set_config('zzsh.session_id',$2,true),set_config('zzsh.request_id',$3,true)",[user,session,request]);
 await context('native-review-admin','native-review-session','native-review-request');
 await c.query('SAVEPOINT direct_update');await assert.rejects(c.query("UPDATE zzsh_order.channel_refund_intent SET requires_review=false,revision=revision+1 WHERE id='native-review-intent'"),e=>['23514','40001','42501'].includes(e.code));await c.query('ROLLBACK TO SAVEPOINT direct_update');
 await c.query('SAVEPOINT denied');await context('native-review-denied','native-review-denied-session','native-review-denied');
 await assert.rejects(c.query("SELECT zzsh_order.resume_native_refund_review('native-review-intent','核对原退款')"),e=>e.code==='42501');await c.query('ROLLBACK TO SAVEPOINT denied');
 await c.query('SAVEPOINT missing_reason');await assert.rejects(c.query("SELECT zzsh_order.resume_native_refund_review('native-review-intent','')"),e=>e.code==='42501');await c.query('ROLLBACK TO SAVEPOINT missing_reason');
 for(const [name,mutation,code] of [
  ['active_lease',"UPDATE zzsh_order.channel_refund_intent SET lease_until=clock_timestamp()+interval '1 minute' WHERE id='native-review-intent'",'23514'],
  ['missing_submit',"DELETE FROM zzsh_order.joinpay_refund_attempt WHERE id='native-review-submit'",'23514'],
  ['signed_review',`INSERT INTO zzsh_order.joinpay_refund_observation(id,intent_id,operation,profile_id,profile_canonical,profile_sha256,key_version_ref,
    raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,evidence_level,state_before,state_after,request_id)
   VALUES('native-review-signed','native-review-intent','NOTIFY','synthetic-profile','{}',encode(sha256(convert_to('{}','UTF8')),'hex'),'synthetic-keyref',
    convert_to('signed','UTF8'),encode(sha256(convert_to('signed','UTF8')),'hex'),true,NULL,6,NULL,'REVIEW','VALID','MATCH','MATCH','PROVIDER_RESPONSE','UNKNOWN','UNKNOWN','synthetic-observation')`,'23514'],
  ['out_of_scope',"UPDATE zzsh_iam.admin_security SET game_scope_mode='SELECTED_GAMES' WHERE admin_user_id='native-review-admin'",'42501'],
  ['denied_permission',"UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id='native-review-admin' AND permission_code='order.settlement.write'",'42501'],
  ['locked_session',"UPDATE zzsh_auth_admin.session SET locked=true WHERE id='native-review-session'",'42501'],
 ]){
  await c.query('SAVEPOINT '+name);await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");await c.query(mutation);
  await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_native_review_synth');
  await assert.rejects(c.query("SELECT zzsh_order.resume_native_refund_review('native-review-intent','核对原退款')"),e=>e.code===code);
  await c.query('ROLLBACK TO SAVEPOINT '+name);
 }
 await c.query('SAVEPOINT native_terminal_review');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
 await c.query(`INSERT INTO zzsh_order.joinpay_refund_observation(id,intent_id,operation,profile_id,profile_canonical,profile_sha256,key_version_ref,
   raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,evidence_level,state_before,state_after,request_id)
  VALUES('native-terminal-origin','native-review-intent','NOTIFY','synthetic-profile','{}',encode(sha256(convert_to('{}','UTF8')),'hex'),'synthetic-keyref',
   convert_to('failure','UTF8'),encode(sha256(convert_to('failure','UTF8')),'hex'),true,NULL,7,NULL,'PENDING_TERMINAL','VALID','MATCH','MATCH','PROVIDER_RESPONSE','UNKNOWN','UNKNOWN','terminal-origin')`);
 await c.query(`INSERT INTO zzsh_order.joinpay_refund_evidence(id,intent_id,observation_id,operation,terminal,facts_canonical,facts_digest)
  VALUES('native-terminal-proof','native-review-intent','native-terminal-origin','NOTIFY','FAILED_NO_EXECUTION','{}',encode(sha256(convert_to('{}','UTF8')),'hex'))`);
 await c.query("UPDATE zzsh_order.channel_refund_intent SET state='FAILED',budget_disposition='RELEASED',terminal_evidence_id='native-terminal-proof' WHERE id='native-review-intent'");
 await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_native_review_synth');
 await context('native-review-admin','native-review-session','native-terminal-review');
 await c.query('SAVEPOINT native_terminal_forged');
 await assert.rejects(c.query("UPDATE zzsh_order.channel_refund_intent SET requires_review=false,revision=revision+1 WHERE id='native-review-intent'"),e=>['23514','40001','42501'].includes(e.code));
 await c.query('ROLLBACK TO SAVEPOINT native_terminal_forged');
 const terminal=(await c.query("SELECT zzsh_order.resolve_native_refund_terminal('native-review-intent','已核对渠道记录') AS value")).rows[0].value;
 assert.equal(terminal.resolved,true);assert.equal(terminal.state,'FAILED');
 assert.deepEqual((await c.query("SELECT state,requires_review,budget_disposition FROM zzsh_order.channel_refund_intent WHERE id='native-review-intent'")).rows[0],
  {state:'FAILED',requires_review:false,budget_disposition:'RELEASED'});
 await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
 await c.query(`INSERT INTO zzsh_order.joinpay_refund_observation(id,intent_id,operation,profile_id,profile_canonical,profile_sha256,key_version_ref,
   raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,evidence_level,state_before,state_after,request_id)
  VALUES('native-terminal-late','native-review-intent','NOTIFY','synthetic-profile','{}',encode(sha256(convert_to('{}','UTF8')),'hex'),'synthetic-keyref',
   convert_to('late','UTF8'),encode(sha256(convert_to('late','UTF8')),'hex'),true,NULL,4,NULL,'REVIEW','VALID','MATCH','MATCH','PROVIDER_RESPONSE','FAILED','FAILED','terminal-late')`);
 await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_native_review_synth');
 await c.query("UPDATE zzsh_order.channel_refund_intent SET requires_review=true,revision=revision+1 WHERE id='native-review-intent'");
 assert.equal((await c.query("SELECT requires_review FROM zzsh_order.channel_refund_intent WHERE id='native-review-intent'")).rows[0].requires_review,true);
 await c.query('ROLLBACK TO SAVEPOINT native_terminal_review');
 if(concurrent){
  await c.query('RESET ROLE');await c.query('COMMIT');
  const a=await pool.connect(),b=await pool.connect();let waiting;
  try{
   for(const client of [a,b]){await client.query('BEGIN');await client.query('SET LOCAL ROLE zzsh_native_review_synth');}
   const audit=(client,user,session,request)=>client.query("SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id',$1,true),set_config('zzsh.session_id',$2,true),set_config('zzsh.request_id',$3,true)",[user,session,request]);
   await audit(a,'native-review-admin','native-review-session','native-review-race-1');await audit(b,'native-review-second','native-review-second-session','native-review-race-2');
   const first=(await a.query("SELECT zzsh_order.resume_native_refund_review('native-review-intent','核对原退款') AS value")).rows[0].value;
   waiting=b.query("SELECT zzsh_order.resume_native_refund_review('native-review-intent','核对原退款') AS value");
   const firstPid=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,secondPid=(await c.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[firstPid])).rows[0]?.pid;
   let observed=!!secondPid;for(let n=0;n<100&&!observed;n++){await new Promise(resolve=>setTimeout(resolve,20));observed=(await c.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))) AS waiting",[firstPid])).rows[0].waiting;}
   assert.equal(observed,true,'second operator must wait on the real original refund lock');await a.query('COMMIT');
   const second=(await waiting).rows[0].value;await b.query('COMMIT');assert.equal(first.resumed,true);assert.equal(second.resumed,false);assert.equal(first.resolutionId,second.resolutionId);
   assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.native_refund_review_resolution WHERE intent_id='native-review-intent'")).rows[0].n,1);
   console.log('synthetic PostgreSQL concurrent native refund review: PASS');
  }finally{await a.query('ROLLBACK').catch(()=>{});await Promise.allSettled([waiting].filter(Boolean));await b.query('ROLLBACK').catch(()=>{});a.release();b.release();}
  return;
 }
 await c.query('SAVEPOINT service_call');
 const refundProfile=require('../dist/src/order/joinpay-refund-profile.js'),oldAdmission=refundProfile.readFormalRefundAdmission,oldInitial=refundProfile.assertInitialRefundAdmission;
 refundProfile.readFormalRefundAdmission=()=>({database,runtimeUser:'zzsh_native_review_synth',merchantIdentityId:'merchant-a',merchantNo:'12345'});
 refundProfile.assertInitialRefundAdmission=()=>{};
 try{
  const {resumeNativeRefundReview}=require('../dist/src/order/joinpay-refund-attempt.js');
  const proxy={query:async(sql,args)=>sql==='BEGIN'?c.query('SAVEPOINT native_review_service_tx'):sql==='COMMIT'?c.query('RELEASE SAVEPOINT native_review_service_tx'):
   sql==='ROLLBACK'?c.query('ROLLBACK TO SAVEPOINT native_review_service_tx'):c.query(sql,args),release(){}};
  const result=await resumeNativeRefundReview({pool:{connect:async()=>proxy},admission:{}},'native-review-intent',
   {userId:'native-review-admin',sessionId:'native-review-session'},'native-review-service','已核对原退款',async()=>{});
  assert.equal(result.resumed,true);assert.equal(result.state,'UNKNOWN');
 }finally{refundProfile.readFormalRefundAdmission=oldAdmission;refundProfile.assertInitialRefundAdmission=oldInitial;}
 await c.query('ROLLBACK TO SAVEPOINT service_call');
 const resumed=(await c.query("SELECT zzsh_order.resume_native_refund_review('native-review-intent','已核对原退款') AS value")).rows[0].value;
 assert.equal(resumed.resumed,true);assert.equal(resumed.state,'UNKNOWN');
 const again=(await c.query("SELECT zzsh_order.resume_native_refund_review('native-review-intent','已核对原退款') AS value")).rows[0].value;
 assert.equal(again.resumed,false);assert.equal(again.resolutionId,resumed.resolutionId);
 const row=(await c.query("SELECT state,requires_review,budget_disposition,revision::text FROM zzsh_order.channel_refund_intent WHERE id='native-review-intent'")).rows[0];
 assert.deepEqual(row,{state:'UNKNOWN',requires_review:false,budget_disposition:'ALLOCATED',revision:'2'});
 await c.query('RESET ROLE');
 assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.native_refund_review_resolution WHERE intent_id='native-review-intent'")).rows[0].n,1);
 assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.native.refund.review_resumed' AND object_id='native-review-intent'")).rows[0].n,1);
 assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.joinpay_refund_attempt WHERE intent_id='native-review-intent'")).rows[0].n,1);
 console.log('synthetic PostgreSQL native refund review resumes only original query: PASS');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1});
