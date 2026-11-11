// Isolated synthetic PG only: seed fixtures without triggers, then exercise real authorization and write guards.
const assert=require('node:assert/strict'),fs=require('node:fs'),{createHash}=require('node:crypto'),{Pool}=require('pg'),Module=require('node:module');
const load=Module._load;Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return load.call(this,name,...args)};
assert.equal(process.env.LEGACY_COMPLETION_SYNTH_OPT_IN,'1');
const fixture=require('../dist/test/legacy-continuation-fixture.js');
const model=require('../dist/src/order/legacy-continuation-model.js');
const calc=require('../dist/src/order/legacy-continuation-calc.js');
const evidence=require('../dist/src/order/legacy-continuation-evidence.js');
const command=require('../dist/src/order/legacy-continuation-command.js');
const finance=require('../dist/src/order/legacy-finance-duty.js');
const {readLegacyDutyFinalization}=require('../dist/src/finance/legacy-duty-finance-store.js');
const {setAuditContext}=require('../dist/src/auth/security-core.js');
const {applyRuntimePrivileges}=require('../dist/src/database/business-migrations.js');
const sha=s=>createHash('sha256').update(s).digest('hex'),empty=sha(''),b=fixture.legacyBinding;
const actor={realm:'admin',userId:'synthetic-completion-staff',sessionId:'synthetic-completion-session',requestId:'synthetic-completion-request'};
const concurrency=process.env.LEGACY_COMPLETION_SYNTH_CONCURRENCY==='1';
const cancellationRace=process.env.LEGACY_COMPLETION_SYNTH_CANCEL_RACE==='1';
const demoCancellation=process.env.LEGACY_COMPLETION_SYNTH_DEMO==='1';
const cancellation=process.env.LEGACY_COMPLETION_SYNTH_CANCELLATION==='1'||cancellationRace||demoCancellation;
const productionFull=process.env.LEGACY_COMPLETION_SYNTH_FULL==='1';
assert(!(concurrency&&cancellation) && !(productionFull&&(concurrency||cancellation)));
const database=demoCancellation?'zzsh_ecs_test_synth_r3':cancellationRace?'zzsh_synth_cancel_race_r3':cancellation||productionFull?'zzsh_synth_prod_refund_r3':concurrency?'zzsh_legacy_retry_concurrency':'zzsh_test_order_settlement_closure';
const marker=demoCancellation?'zzsh:ecs-test:v1':cancellationRace?'zzsh:synthetic:legacy-cancel-race:v1':cancellation||productionFull?'zzsh:synthetic:production-refund-v1':concurrency?'zzsh:legacy-retry-concurrency:v1':'zzsh:synthetic-settlement-test:v1';
const runtimeRole=demoCancellation||cancellationRace?'zzsh_synth_runtime':'zzsh_completion_synth_probe';
const pool=new Pool({host:'127.0.0.1',port:cancellation||productionFull?55439:5432,database,user:'postgres',max:3,statement_timeout:15000});
(async()=>{
 const c=await pool.connect();let workerHeld=false;try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id
   FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:database,role:'postgres',oid:process.env.LEGACY_COMPLETION_SYNTH_OID,
   marker,system_id:process.env.LEGACY_COMPLETION_SYNTH_SYSTEM_ID});
  assert.equal((await c.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zzsh_completion_synth_probe') AS present")).rows[0].present,false);
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  for(const [id,legacyId,digest] of [[b.ownerUserId,b.legacyOwnerId,b.ownerSourceDigest],[b.renterUserId,b.legacyRenterId,b.renterSourceDigest]]){
   await c.query('INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,now(),now())',[id,legacyId+'@example.invalid']);
   await c.query(`INSERT INTO zzsh_auth_user.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',now(),now())`,['user-session-'+legacyId,id,'synthetic-token-'+legacyId]);
   await c.query(`INSERT INTO zzsh_iam.user_identity_state(user_id,provider,provider_reference) VALUES($1,'legacy_mysql_restore',$2)`,[id,'la_user:'+legacyId]);
   await c.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,action,object_type,object_id,outcome,occurred_at,details)
    VALUES($1,'system','user.legacy_owner.migrated','user',$2,'SUCCESS',now(),$3::jsonb)`,['identity-'+legacyId,id,JSON.stringify({sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',legacyId,sourceDigest:digest})]);
  }
  await c.query('INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[actor.userId,'synthetic-staff@example.invalid']);
  await c.query(`INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at) VALUES($1,'ACTIVE',true,now())`,[actor.userId]);
  await c.query(`INSERT INTO zzsh_auth_admin.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,'synthetic-token',clock_timestamp()+interval '1 hour',now(),now())`,[actor.sessionId,actor.userId]);
  await c.query('INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',['synthetic-denied','synthetic-denied@example.invalid']);
  await c.query(`INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at,game_scope_mode) VALUES('synthetic-denied','ACTIVE',false,now(),'SELECTED_GAMES')`);
  await c.query(`INSERT INTO zzsh_auth_admin.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES('synthetic-denied-session','synthetic-denied','synthetic-denied-token',clock_timestamp()+interval '1 hour',now(),now())`);
  await c.query('INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',['synthetic-agent','synthetic-agent@example.invalid']);
  await c.query(`INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at) VALUES('synthetic-agent','ACTIVE',false,now())`);
  await c.query(`INSERT INTO zzsh_auth_admin.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES('synthetic-agent-session','synthetic-agent','synthetic-agent-token',clock_timestamp()+interval '1 hour',now(),now())`);
  await c.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect)
   VALUES('synthetic-agent','order.read','ALLOW'),('synthetic-agent','order.legacy.continue','ALLOW'),('synthetic-agent','order.settlement.write','ALLOW')`);
  await c.query(`INSERT INTO zzsh_supply.game(id,code,name) VALUES($1,'synthetic','synthetic')`,[b.gameId]);
  await c.query(`INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES($1,$2,$3)`,[b.accountId,b.ownerUserId,b.gameId]);
  await c.query(`INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,
   account_id,game_id,owner_user_id,renter_user_id,legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_owner_id,owner_source_digest,
   legacy_renter_id,renter_source_digest,source_order_status,source_pay_status,recorded_paid_amount_cents,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id)
   VALUES($1,'legacy_mysql_restore','la_order',$2,$3,'synthetic','SYNTHETIC_ORDER',$4,$5,$6,$7,$8,'la_rental_accounts',$3,$9,$10,$11,$12,3,1,10000,'{"is_delete":"0"}',1,$3,$13)`,
   [b.id,b.legacyId,b.sourceDigest,b.accountId,b.gameId,b.ownerUserId,b.renterUserId,b.legacyAccountId,b.legacyOwnerId,b.ownerSourceDigest,b.legacyRenterId,b.renterSourceDigest,actor.userId]);
  const commission={id:'90',beneficiaryId:b.legacyOwnerId,ratio:'20.00',level:'2',status:'1',storedEarnings:'5.00'};
  const {canonicalize}=require('../dist/src/supply/content-hash.js');
  const commissionSource=canonicalize({id:commission.id,order_id:b.legacyId,user_id:commission.beneficiaryId,ratio:commission.ratio,level:commission.level,status:commission.status,earnings:commission.storedEarnings});
  const original=fixture.legacyEvidence(model.initialLegacyFacts(fixture.legacySource({commissions:[commission],...(!cancellation?{baseBot:'10',profitDot:'2',goodsMoney:'13.00',storedCommissionMoney:'3.00'}:{})}),[{sourceRecordId:commission.id,canonical:commissionSource,digest:sha(commissionSource),evidenceRef:'synthetic-commission'}]));
  await c.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,source_as_of,evidence_ref,source_digest,
   parameter_digest,admission,reasons,facts,facts_canonical,facts_digest) VALUES($1,$2,1,'SOURCE_IMPORT',now(),'synthetic',$3,$4,$5,'[]'::jsonb,$6::jsonb,$7,$8)`,
   [original.id,b.id,b.sourceDigest,original.facts.evidence.parameterDigest,original.facts.evidence.admission,JSON.stringify(original.facts),original.factsCanonical,original.factsDigest]);
  const commissionId=model.legacyEconomicDutyId(b.id,'COMMISSION',commission.id);
  await c.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_status,level,ratio,source_digest)
   VALUES($1,$2,'COMMISSION',$3,$4,500,'CNY','PENDING','LEGACY_IMPORT','1',2,20,$5)`,[commissionId,b.id,commission.id,b.ownerUserId,b.sourceDigest]);
  await c.query(`INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,
   available_cents,source_cutoff,covered_count,covered_set_digest) VALUES('completion-basis',$1,'LEGACY_OPENING','legacy_mysql_restore','la_user',$2,$3,$3,0,'2026-11-01T00:00:00Z',0,$4)`,[b.ownerUserId,b.legacyOwnerId,b.ownerSourceDigest,empty]);
  await c.query(`INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id) VALUES($1,'RECONCILED_OPENING','completion-basis','completion-opening')`,[b.ownerUserId]);
  await c.query(`INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,
   available_cents,source_cutoff,covered_count,covered_set_digest) VALUES('completion-renter-basis',$1,'LEGACY_OPENING','legacy_mysql_restore','la_user',$2,$3,$3,0,'2026-11-01T00:00:00Z',0,$4)`,[b.renterUserId,b.legacyRenterId,b.renterSourceDigest,empty]);
  await c.query(`INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id) VALUES($1,'RECONCILED_OPENING','completion-renter-basis','completion-renter-opening')`,[b.renterUserId]);
  for(const id of [b.ownerUserId,b.renterUserId])await c.query('INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES($1,0,0)',[id]);
  await c.query(`INSERT INTO zzsh_order.personal_finance_observation_coverage(id,user_id,source_system,legacy_user_id,source_kind,source_entity,source_cutoff,
   input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,source_canonical)
   VALUES('completion-history',$1,'legacy_mysql_restore',$2,'HISTORICAL_EARNINGS_LOG','la_log_earnings','2026-11-01T00:00:00Z',$3,$3,0,0,0,$4,$4,$4,$3,'{}')`,[b.ownerUserId,b.legacyOwnerId,b.ownerSourceDigest,empty]);
  await c.query(`INSERT INTO zzsh_order.personal_finance_observation_coverage(id,user_id,source_system,legacy_user_id,source_kind,source_entity,source_cutoff,
   input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,source_canonical)
   VALUES('completion-renter-history',$1,'legacy_mysql_restore',$2,'HISTORICAL_EARNINGS_LOG','la_log_earnings','2026-11-01T00:00:00Z',$3,$3,0,0,0,$4,$4,$4,$3,'{}')`,[b.renterUserId,b.legacyRenterId,b.renterSourceDigest,empty]);
  if(cancellation){
   await c.query(`UPDATE zzsh_order.legacy_order_read_snapshot SET source_paid_at=transaction_timestamp()-interval '1 second' WHERE id=$1`,[b.id]);
   await c.query(`UPDATE zzsh_supply.game SET code='delta' WHERE id=$1`,[b.gameId]);
   await c.query(`INSERT INTO zzsh_supply.game_service_operation(id,game_id,service_code,enabled) VALUES('synthetic-rental-service',$1,'ACCOUNT_RENTAL',true)`,[b.gameId]);
   await c.query(`INSERT INTO zzsh_supply.listing_version(id,account_id,sequence,origin,review_state,title,description,attributes,term_option_code,pricing_option_code,schema_version)
     VALUES('synthetic-observation',$1,1,'LEGACY_OBSERVATION','IMPORTED_UNVERIFIED','旧资料',NULL,'{}'::jsonb,'','',1)`,[b.accountId]);
   await c.query(`INSERT INTO zzsh_supply.legacy_supply_map(source_system,source_entity,legacy_id,account_id,version_id,evidence_ref,source_digest)
     VALUES('legacy_mysql_restore','la_rental_accounts',$1,$2,'synthetic-observation','synthetic',$3)`,[b.legacyAccountId,b.accountId,b.sourceDigest]);
   await c.query(`INSERT INTO zzsh_supply.legacy_listing_read_snapshot(account_id,observation_version_id,source_system,source_entity,legacy_id,source_digest,source_status,source_updated_at,evidence_ref,snapshot,created_by_admin_id)
     VALUES($1,'synthetic-observation','legacy_mysql_restore','la_rental_accounts',$2,$3,5,now(),'synthetic','{}'::jsonb,$4)`,[b.accountId,b.legacyAccountId,b.sourceDigest,actor.userId]);
   await c.query(`UPDATE zzsh_supply.rental_account SET current_version_id='synthetic-observation',legacy_hold='UNRESOLVED' WHERE id=$1`,[b.accountId]);
  }
  await c.query("SET LOCAL session_replication_role='origin'");
  if(cancellation){
   const base=(await c.query("SELECT position('SUPPORT_CANCEL' IN pg_get_functiondef(to_regprocedure('zzsh_order.check_legacy_continuation_result()')))>0 AS ready")).rows[0].ready;
   if(!base)await c.query(fs.readFileSync('migrations/business/0191_legacy_support_cancel.sql','utf8'));
   await c.query('SET LOCAL ROLE zzsh_synth_migrator');
   await c.query(fs.readFileSync('migrations/business/0195_approval_center_link.sql','utf8'));
   await c.query(fs.readFileSync('migrations/business/0196_owner_payout_fee.sql','utf8'));
   await c.query('RESET ROLE');
  }
  else if(!productionFull) {
   await c.query(fs.readFileSync('migrations/business/0168_legacy_payment_order_number_guard.sql','utf8'));
   await c.query(fs.readFileSync('migrations/business/0169_legacy_finance_duty_runtime.sql','utf8'));
   await c.query(fs.readFileSync('migrations/business/0170_legacy_commission_confirmation_link.sql','utf8'));
   await c.query(fs.readFileSync('migrations/business/0171_legacy_refund_case.sql','utf8'));
  }
  if(!cancellationRace&&!demoCancellation)await c.query('CREATE ROLE zzsh_completion_synth_probe NOLOGIN');
  await applyRuntimePrivileges({query:(...args)=>c.query(...args)},runtimeRole);
  if(demoCancellation){
   await c.query('SET LOCAL ROLE zzsh_synth_migrator');
   await c.query(fs.readFileSync('migrations/candidates/ecs-test-demo-finance/demo-legacy-cancel.sql','utf8'));
   await c.query(fs.readFileSync('migrations/candidates/ecs-test-demo-finance/demo-legacy-cancel.sql','utf8'));
   await c.query(fs.readFileSync('migrations/candidates/ecs-test-demo-finance/grant-runtime.sql','utf8'));
   await c.query('RESET ROLE');
  }
  assert.equal((await c.query("SELECT has_function_privilege($1,'zzsh_order.create_legacy_refund_case(text)','EXECUTE') AS allowed",[runtimeRole])).rows[0].allowed,true);
  assert.equal((await c.query("SELECT has_function_privilege($1,'zzsh_order.resume_legacy_refund_review(text,text)','EXECUTE') AS allowed",[runtimeRole])).rows[0].allowed,true);
  assert.equal((await c.query("SELECT has_function_privilege($1,'zzsh_order.resolve_legacy_refund_terminal(text,text,text)','EXECUTE') AS allowed",[runtimeRole])).rows[0].allowed,true);
  assert.equal((await c.query("SELECT has_table_privilege($1,'zzsh_order.legacy_refund_terminal_resolution','INSERT') AS allowed",[runtimeRole])).rows[0].allowed,false);
  assert.equal((await c.query("SELECT has_table_privilege($1,'zzsh_order.legacy_refund_review_resolution','INSERT') AS allowed",[runtimeRole])).rows[0].allowed,false);
  assert.equal((await c.query("SELECT has_table_privilege($1,'zzsh_order.legacy_refund_case','INSERT') AS allowed",[runtimeRole])).rows[0].allowed,false);
  await c.query(`SET LOCAL ROLE ${runtimeRole}`);
  await setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
  await assert.rejects(finance.authorizeLegacyFinanceDuty(c,{...actor,userId:'synthetic-denied',sessionId:'synthetic-denied-session'},b.id,'OWNER_CREDIT'),error=>error.status===403);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_order.legacy_continuation_version WHERE order_id=$1',[b.id])).rows[0].n,0);
  if(demoCancellation){
   const ids=(await c.query(`SELECT d.datdba::int AS owner_oid,(SELECT oid::int FROM pg_roles WHERE rolname='zzsh_synth_migrator') AS migration_oid,
     (SELECT oid::int FROM pg_roles WHERE rolname='zzsh_synth_runtime') AS runtime_oid FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
   const resource={database,databaseOid:Number(identity.oid),systemIdentifier:identity.system_id,marker,owner:'zzsh_synth_owner',ownerOid:ids.owner_oid,
     migrationRole:'zzsh_synth_migrator',migrationRoleOid:ids.migration_oid,runtimeRole,runtimeRoleOid:ids.runtime_oid};
   const config={profile:'ecs-test',provider:'real',testOperationsEnabled:false,database:{target:'ecs-test',targetProfile:'ecs-test',name:database,user:runtimeRole,runtimeUser:runtimeRole,ssl:{rejectUnauthorized:true}}};
   const env={ECS_TEST_DEMO_FINANCE_ENABLED:'true',APP_PROFILE:'ecs-test',NODE_ENV:'production',JOINPAY_COLLECTION_ENABLED:'false',JOINPAY_REFUND_ENABLED:'false',JOINPAY_PAYOUT_ENABLED:'false',JOINPAY_ACCOUNTS_ENABLED:'false'};
   const origins={apiOrigin:'https://api.example.invalid',userOrigin:'https://user.example.invalid',adminOrigin:'https://admin.example.invalid',secureCookies:true};
   const demo=require('../dist/src/finance/ecs-test-demo-resource.js').createEcsTestDemoResource({config,env,origins,reference:'synth_demo',administratorId:'post_admin',sourceSnapshotSha256:'a'.repeat(64),restoreReceiptSha256:'b'.repeat(64),resource});
   await c.query('SAVEPOINT demo_complete');
   const input=command.parseLegacyMutation('support_cancel',{expectedRevision:null,inputEvidenceId:original.id,refundCents:'5000',ownerCents:'3000',reason:'双方协商取消',ownerAmountBasis:'GROSS_BEFORE_FEE_V1',originalPaymentChecked:true});
   const authority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   assert.equal((await command.applyLegacyContinuationCommand(c,actor,b.id,input,readLegacyDutyFinalization,authority,finance.postLegacyOwnerCreditOnConfirmation,'SIMULATED')).body.stage,'5');
   const adapter=require('../dist/src/order/ecs-demo-legacy-refund.js');
   assert.equal(await adapter.simulateLegacyCancellationRefund(c,actor,b.id,{}),'REQUIRES_REVIEW');
   assert.equal((await evidence.readLegacyContinuationHead(c,b.id)).stage,5);
   assert.equal((await evidence.readLegacyContinuationDuties(c,b.id)).find(d=>d.kind==='RENTER_REFUND').status,'PENDING');
   await c.query('SAVEPOINT previous_demo_refund');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,included_in_opening,snapshot)
     VALUES('synthetic-demo-prior-refund',$1,'HISTORICAL_REFUND','LEGACY_MYSQL','legacy_mysql_restore',$2,'la_refund_record','42',$3,'{}',false,$4::jsonb)`,[b.ownerUserId,b.legacyOwnerId,b.sourceDigest,JSON.stringify({associationState:'UNRESOLVED',rawSource:{canonical:JSON.stringify({order_id:b.legacyId,order_sn:'wrong-number'})}})]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   assert.equal(await adapter.simulateLegacyCancellationRefund(c,actor,b.id,demo),'REQUIRES_REVIEW');
   assert.equal((await evidence.readLegacyContinuationDuties(c,b.id)).find(d=>d.kind==='RENTER_REFUND').status,'PENDING');
   await c.query('ROLLBACK TO SAVEPOINT previous_demo_refund');
   assert.equal(await adapter.simulateLegacyCancellationRefund(c,actor,b.id,demo),'SIMULATED');
   assert.equal(await adapter.simulateLegacyCancellationRefund(c,actor,b.id,demo),'ALREADY_SIMULATED');
   const duties=await evidence.readLegacyContinuationDuties(c,b.id),refund=duties.find(d=>d.kind==='RENTER_REFUND');
   assert.equal(refund.status,'SETTLED');
   const receipt=await adapter.readDemoLegacyRefund(c,b.id,refund.id,demo);
   assert.equal(receipt.amountCents,'5000');assert.equal(receipt.state,'SIMULATED');assert.equal(receipt.bankArrival,'UNKNOWN');
   assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_order.ecs_demo_legacy_refund WHERE order_id=$1',[b.id])).rows[0].n,1);
   await c.query('ROLLBACK TO SAVEPOINT demo_complete');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   const isolated=fixture.legacyEvidence(model.initialLegacyFacts(fixture.legacySource({baseBot:null,commissions:[commission]}),[{sourceRecordId:commission.id,canonical:commissionSource,digest:sha(commissionSource),evidenceRef:'synthetic-commission'}]));
   assert.equal(isolated.facts.evidence.admission,'ISOLATED');
   await c.query(`UPDATE zzsh_order.legacy_continuation_evidence SET parameter_digest=$2,admission=$3,reasons=$4::jsonb,facts=$5::jsonb,facts_canonical=$6,facts_digest=$7 WHERE id=$1`,
    [original.id,isolated.facts.evidence.parameterDigest,isolated.facts.evidence.admission,JSON.stringify(isolated.facts.evidence.reasons),JSON.stringify(isolated.facts),isolated.factsCanonical,isolated.factsDigest]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   const isolatedAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   assert.equal((await command.applyLegacyContinuationCommand(c,actor,b.id,input,readLegacyDutyFinalization,isolatedAuthority,finance.postLegacyOwnerCreditOnConfirmation,'SIMULATED')).body.stage,'5');
   assert.equal(await adapter.simulateLegacyCancellationRefund(c,actor,b.id,demo),'SIMULATED','missing old price must not suppress an otherwise valid test refund');
   console.log('PASS: legacy cancellation uses one test refund receipt and never reports real bank arrival');
   return;
  }
  if(cancellationRace){
   await c.query('COMMIT');
   const other=await pool.connect(),observer=await pool.connect(),util=require('../dist/src/supply/supply-util.js');
   try {
    const op='order.legacy.continuation.support_cancel',key='synthetic_cancel_same_key';
    const input=command.parseLegacyMutation('support_cancel',{expectedRevision:null,inputEvidenceId:original.id,refundCents:'5000',ownerCents:'3000',reason:'双方协商取消',ownerAmountBasis:'GROSS_BEFORE_FEE_V1',originalPaymentChecked:true});
    const scope={realm:'admin',principalId:actor.userId,operation:op,resourceId:b.id},fingerprint=util.fingerprintRequest(op,b.id,input);
    const profiles=require('../dist/src/order/joinpay-refund-profile.js'),refundStore=require('../dist/src/order/channel-refund-store.js');
    const saved={assertFormalRefundProfile:profiles.assertFormalRefundProfile,describeRefundProfile:profiles.describeRefundProfile,
      readRefundProfileEvidence:profiles.readRefundProfileEvidence,assertRefundStart:profiles.assertRefundStart,assertRefundBinding:profiles.assertRefundBinding,assertRefundResource:refundStore.assertRefundResource};
    const profileText=JSON.stringify({kind:'JOINPAY_REFUND_PROFILE_V1',operation:'SUBMIT',purpose:'MERCHANT_REFUND',database,runtimeUser:runtimeRole,merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
    const admissionText=JSON.stringify({kind:'FORMAL_NATIVE_REFUND_SERVER_REVIEW',reference:'synthetic-admission',database,runtimeUser:runtimeRole,merchantIdentityId:'synthetic-merchant',merchantNo:'12345',acceptedProfiles:[{operation:'SUBMIT',profileId:'synthetic-profile',profileSha256:sha(profileText),keyVersionRef:'synthetic-key-ref'},{operation:'QUERY'},{operation:'NOTIFY'}]});
    profiles.assertFormalRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',reference:'synthetic-admission',sha256:sha(admissionText),canonical:admissionText});
    profiles.describeRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',profileSha256:sha(profileText),keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
    profiles.readRefundProfileEvidence=()=>profileText;profiles.assertRefundStart=()=>{};profiles.assertRefundBinding=()=>{};refundStore.assertRefundResource=async()=> '1';
    const prepare=async client=>{await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${runtimeRole}`);await setAuditContext(client,'admin',actor.userId,actor.sessionId,actor.requestId);};
    const execute=async(client,requestKey=key)=>{let authority;return util.withIdempotency(client,scope,requestKey,fingerprint,
      async replay=>{authority=await finance.authorizeLegacyFinanceDuty(client,actor,b.id,'OWNER_CREDIT',!!replay);},
      ()=>command.applyLegacyContinuationCommand(client,actor,b.id,input,readLegacyDutyFinalization,authority,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR'));};
    await prepare(c);const first=await execute(c);assert.equal(first.replayed,false);
    const allocator=require('../dist/src/order/legacy-support-cancel-refund.js');
    assert.equal((await allocator.allocateLegacySupportCancelRefundInTransaction(c,actor,b.id,key,fingerprint,{admission:{},profile:{}})).state,'CREATED');
    await prepare(other);const aPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,bPid=(await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const replay=execute(other).then(value=>({value}),error=>({error}));let blocked=false;
    for(let i=0;i<100&&!blocked;i++){blocked=(await observer.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',[aPid,bPid])).rows[0].blocked;if(!blocked)await new Promise(resolve=>setTimeout(resolve,25));}
    assert.equal(blocked,true,'second request must actually wait on the first transaction');
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('COMMIT');
    const second=await replay;if(second.error)throw second.error;assert.equal(second.value.replayed,true);assert.deepEqual(second.value.body,first.body);
    assert.equal((await allocator.allocateLegacySupportCancelRefundInTransaction(other,actor,b.id,key,fingerprint,{admission:{},profile:{}})).state,'ALREADY_CREATED');
    await other.query('COMMIT');
    await prepare(other);await assert.rejects(execute(other,'synthetic_cancel_other_key'),error=>error.status===409&&error.message==='CONTINUATION_REVISION_CONFLICT');await other.query('ROLLBACK');
    const counts=(await observer.query(`SELECT
      (SELECT count(*)::int FROM zzsh_order.legacy_continuation_version WHERE order_id=$1 AND command='SUPPORT_CANCEL') AS versions,
      (SELECT count(*)::int FROM zzsh_order.legacy_order_duty WHERE order_id=$1 AND kind='RENTER_REFUND') AS refunds,
      (SELECT count(*)::int FROM zzsh_order.legacy_order_duty WHERE order_id=$1 AND kind='OWNER_CREDIT') AS owners,
      (SELECT count(*)::int FROM zzsh_order.legacy_order_duty WHERE order_id=$1 AND kind='COMMISSION' AND status<>'VOID') AS live_commissions,
      (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$2 AND account_code='OWNER_AVAILABLE') AS owner_entries`,[b.id,b.ownerUserId])).rows[0];
    assert.deepEqual(counts,{versions:1,refunds:1,owners:1,live_commissions:0,owner_entries:1});
    console.log('PASS: two PostgreSQL transactions actually contended; same key replays one cancellation and one owner credit');
    assert.equal((await observer.query(`SELECT count(*)::int AS n FROM zzsh_order.legacy_refund_case WHERE order_id=$1`,[b.id])).rows[0].n,1);
    assert.equal((await observer.query(`SELECT state FROM zzsh_order.legacy_refund_intent WHERE case_id=(SELECT id FROM zzsh_order.legacy_refund_case WHERE order_id=$1)`,[b.id])).rows[0].state,'READY');
    Object.assign(profiles,{assertFormalRefundProfile:saved.assertFormalRefundProfile,describeRefundProfile:saved.describeRefundProfile,
      readRefundProfileEvidence:saved.readRefundProfileEvidence,assertRefundStart:saved.assertRefundStart,assertRefundBinding:saved.assertRefundBinding});refundStore.assertRefundResource=saved.assertRefundResource;
    console.log('PASS: cancellation and exactly one ordinary refund task commit together under concurrent same-key replay');
   } finally {await other.query('ROLLBACK').catch(()=>{});other.release();observer.release();}
   return;
  }
  if(cancellation){
   const ready=await evidence.legacySupportCancellationReady(c);
   if(!ready)console.log('synthetic cancellation readiness', (await c.query(`SELECT
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('zzsh_order.legacy_continuation_version') AND conname='legacy_continuation_version_command_check' AND pg_get_constraintdef(oid) LIKE '%SUPPORT_CANCEL%') AS command_ok,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('zzsh_order.legacy_continuation_version') AND conname='legacy_continuation_version_stage_check' AND pg_get_constraintdef(oid) LIKE '%5%') AS stage_ok,
    position('SUPPORT_CANCEL' IN pg_get_functiondef(to_regprocedure('zzsh_order.check_legacy_continuation_result()')))>0 AS result_guard_ok,
    position('SUPPORT_CANCEL' IN pg_get_functiondef(to_regprocedure('zzsh_order.guard_legacy_duty()')))>0 AS duty_guard_ok,
    has_column_privilege(current_user,to_regclass('zzsh_order.legacy_continuation_version'),'id','INSERT') AS version_insert,
    has_column_privilege(current_user,to_regclass('zzsh_order.legacy_order_duty'),'status','UPDATE') AS duty_update`)).rows[0]);
   assert.equal(ready,true);
   await c.query('SAVEPOINT missing_cancel_acl');await c.query('RESET ROLE');
   await c.query(`REVOKE UPDATE(status) ON zzsh_order.legacy_order_duty FROM ${runtimeRole}`);await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   assert.equal(await evidence.legacySupportCancellationReady(c),false,'do not expose cancellation without its duty update privilege');
   await c.query('ROLLBACK TO SAVEPOINT missing_cancel_acl');
   const publishing=require('../dist/src/supply/publishing.js');
   const accountBefore=await publishing.lockPublishingAccount(c,b.accountId);
   assert.equal(await publishing.canPrepareLegacyCancelledDraft(c,accountBefore),false);
   await c.query('SAVEPOINT cancellation_payout');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   const payoutEvidence=fixture.legacyEvidence(model.initialLegacyFacts(fixture.legacySource({isFullPayout:'1',commissions:[commission]}),
    [{sourceRecordId:commission.id,canonical:commissionSource,digest:sha(commissionSource),evidenceRef:'synthetic-commission'}]));
   await c.query(`UPDATE zzsh_order.legacy_continuation_evidence SET parameter_digest=$2,admission=$3,reasons=$4::jsonb,facts=$5::jsonb,facts_canonical=$6,facts_digest=$7 WHERE id=$1`,
    [original.id,payoutEvidence.facts.evidence.parameterDigest,payoutEvidence.facts.evidence.admission,JSON.stringify(payoutEvidence.facts.evidence.reasons),JSON.stringify(payoutEvidence.facts),payoutEvidence.factsCanonical,payoutEvidence.factsDigest]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   await setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
   const payoutInput=command.parseLegacyMutation('support_cancel',{expectedRevision:null,inputEvidenceId:original.id,refundCents:'5000',ownerCents:'2000',
    ownerAmountBasis:'GROSS_BEFORE_FEE_V1',reason:'双方协商取消',originalPaymentChecked:true});
   const payoutAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   const payoutResult=await command.applyLegacyContinuationCommand(c,actor,b.id,payoutInput,readLegacyDutyFinalization,payoutAuthority,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR');
   assert.equal(payoutResult.body.stage,'5');
   const payoutHead=await evidence.readLegacyContinuationHead(c,b.id),payoutDuties=await evidence.readLegacyContinuationDuties(c,b.id);
   assert.deepEqual([payoutHead.amounts.ownerGross,payoutHead.amounts.fullPayoutMoney,payoutHead.amounts.ownerNet,payoutHead.amounts.refundNet,payoutHead.amounts.platformContribution],
    ['20.00','1.60','18.40','50.00','31.60']);
   const payoutOwner=payoutDuties.find(d=>d.kind==='OWNER_CREDIT');assert.equal(payoutOwner.amountCents,'1840');assert.equal(payoutOwner.status,'SETTLED');
   const payoutRefund=payoutDuties.find(d=>d.kind==='RENTER_REFUND');assert.equal(payoutRefund.amountCents,'5000');
   assert.equal(payoutDuties.find(d=>d.kind==='COMMISSION').status,'VOID');
   assert.equal((await require('../dist/src/order/legacy-duty-basis.js').readLegacyDutyBasis(c,b.id,payoutOwner)).amountCents,'1840');
   assert.equal((await require('../dist/src/order/legacy-duty-basis.js').readLegacyDutyBasis(c,b.id,payoutRefund)).amountCents,'5000');
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('ROLLBACK TO SAVEPOINT cancellation_payout');
   console.log('PASS: legacy special cancellation deducts fee from owner gross and retains verifiable duties');
   await c.query('SAVEPOINT cancellation_payout_unknown');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   const unknownEvidence=fixture.legacyEvidence(model.initialLegacyFacts(fixture.legacySource({isFullPayout:null,commissions:[commission]}),
    [{sourceRecordId:commission.id,canonical:commissionSource,digest:sha(commissionSource),evidenceRef:'synthetic-commission'}]));
   await c.query(`UPDATE zzsh_order.legacy_continuation_evidence SET parameter_digest=$2,admission=$3,reasons=$4::jsonb,facts=$5::jsonb,facts_canonical=$6,facts_digest=$7 WHERE id=$1`,
    [original.id,unknownEvidence.facts.evidence.parameterDigest,unknownEvidence.facts.evidence.admission,JSON.stringify(unknownEvidence.facts.evidence.reasons),JSON.stringify(unknownEvidence.facts),unknownEvidence.factsCanonical,unknownEvidence.factsDigest]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   await setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
   const unknownAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   await assert.rejects(command.applyLegacyContinuationCommand(c,actor,b.id,payoutInput,readLegacyDutyFinalization,unknownAuthority,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR'),error=>error.message==='FULL_PAYOUT_UNKNOWN');
   assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.legacy_continuation_version WHERE order_id=$1",[b.id])).rows[0].n,0);
   const fullRefund={...payoutInput,refundCents:'10000',ownerCents:'0'};
   const fullRefundResult=await command.applyLegacyContinuationCommand(c,actor,b.id,fullRefund,readLegacyDutyFinalization,unknownAuthority,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR');
   assert.equal(fullRefundResult.body.stage,'5');
   assert.equal((await evidence.readLegacyContinuationDuties(c,b.id)).find(d=>d.kind==='RENTER_REFUND').amountCents,'10000');
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('ROLLBACK TO SAVEPOINT cancellation_payout_unknown');
   console.log('PASS: unknown legacy payout blocks positive owner allocation but permits full renter refund');
   await c.query('SAVEPOINT missing_commission');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query('DELETE FROM zzsh_order.legacy_order_duty WHERE id=$1',[commissionId]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   const missing=command.parseLegacyMutation('support_cancel',{expectedRevision:null,inputEvidenceId:original.id,refundCents:'5000',ownerCents:'3000',reason:'双方协商取消',ownerAmountBasis:'GROSS_BEFORE_FEE_V1',originalPaymentChecked:true});
   const missingAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   await assert.rejects(command.applyLegacyContinuationCommand(c,actor,b.id,missing,readLegacyDutyFinalization,missingAuthority,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR'),error=>error.message==='COMMISSION_SOURCE_UNAVAILABLE');
   await c.query('ROLLBACK TO SAVEPOINT missing_commission');
   await c.query('SAVEPOINT unresolved_refund');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   const uncertain=(orderId,orderSn)=>JSON.stringify({associationState:'UNRESOLVED',rawSource:{canonical:JSON.stringify({order_id:orderId,order_sn:orderSn})}});
   await c.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,included_in_opening,snapshot)
     VALUES('synthetic-unresolved-refund',$1,'HISTORICAL_REFUND','LEGACY_MYSQL','legacy_mysql_restore',$2,'la_refund_record','40',$3,'{}',false,$4::jsonb)`,[b.ownerUserId,b.legacyOwnerId,b.sourceDigest,uncertain(b.legacyId,'wrong-number')]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   const hasHistory=require('../dist/src/order/legacy-refund-review-source.js').hasLegacyRecordedRefunds;
   assert.equal(await hasHistory(c,b),true,'raw order ID must flag a refund under another user');
   await c.query('SAVEPOINT unresolved_action');
   const uncertainAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   const uncertainCancel=await command.applyLegacyContinuationCommand(c,actor,b.id,missing,readLegacyDutyFinalization,uncertainAuthority,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR');
   assert.equal(uncertainCancel.body.stage,'5','uncertain history must not stop cancellation');
   const uncertainDuties=await evidence.readLegacyContinuationDuties(c,b.id);
   assert.equal(uncertainDuties.find(d=>d.kind==='OWNER_CREDIT').status,'PENDING');
   assert.equal(uncertainDuties.find(d=>d.kind==='RENTER_REFUND').status,'PENDING');
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('ROLLBACK TO SAVEPOINT unresolved_action');
   await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query(`UPDATE zzsh_order.personal_finance_observation SET snapshot=$2::jsonb WHERE id=$1`,['synthetic-unresolved-refund',uncertain('999999','SYNTHETIC_ORDER')]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   assert.equal(await hasHistory(c,b),true,'raw order number must independently flag a possible refund');
   await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query(`UPDATE zzsh_order.personal_finance_observation SET snapshot=$2::jsonb WHERE id=$1`,['synthetic-unresolved-refund',uncertain('999999','OTHER_ORDER')]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   assert.equal(await hasHistory(c,b),false,'an unrelated refund must not block this order');
   await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query(`UPDATE zzsh_order.personal_finance_observation SET user_id=$2,legacy_user_id=$3,snapshot=$4::jsonb WHERE id=$1`,['synthetic-unresolved-refund',b.renterUserId,b.legacyRenterId,JSON.stringify({associationState:'UNRESOLVED',rawSource:{canonical:'invalid-json'}})]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   assert.equal(await hasHistory(c,b),true,'an unreadable unresolved refund for this renter requires review');
   await c.query('ROLLBACK TO SAVEPOINT unresolved_refund');
   await c.query('SAVEPOINT recorded_refund_cancel');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,included_in_opening,snapshot)
     VALUES('synthetic-refund-before',$1,'HISTORICAL_REFUND','LEGACY_MYSQL','legacy_mysql_restore',$2,'la_refund_record','41',$3,'{}',false,$4::jsonb)`,[b.renterUserId,b.legacyRenterId,b.sourceDigest,JSON.stringify({referenceId:b.legacyId})]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   const historyAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   const historyCancel=await command.applyLegacyContinuationCommand(c,actor,b.id,missing,readLegacyDutyFinalization,historyAuthority,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR');
   assert.equal(historyCancel.body.stage,'5');const historyDuties=await evidence.readLegacyContinuationDuties(c,b.id);
   assert.equal(historyDuties.find(d=>d.kind==='OWNER_CREDIT').status,'PENDING');
   assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='OWNER_AVAILABLE'`,[b.ownerUserId])).rows[0].n,0);
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('ROLLBACK TO SAVEPOINT recorded_refund_cancel');
   await c.query('SAVEPOINT simulated_scope');
   const u=require('../dist/src/supply/supply-util.js'),op='order.legacy.continuation.support_cancel',simKey='synthetic_cancel_scope',simFingerprint=u.fingerprintRequest(op,b.id,missing);
   const simAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   await u.withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:op,resourceId:b.id},simKey,simFingerprint,async()=>{},
    ()=>command.applyLegacyContinuationCommand(c,actor,b.id,missing,readLegacyDutyFinalization,simAuthority,finance.postLegacyOwnerCreditOnConfirmation,'SIMULATED'));
   assert.equal((await evidence.readLegacyContinuationDuties(c,b.id)).find(d=>d.kind==='OWNER_CREDIT').status,'PENDING',
    'simulated verification cannot post owner funds outside a registered demo database');
   assert.equal((await require('../dist/src/order/legacy-support-cancel-refund.js').allocateLegacySupportCancelRefund(c,actor,b.id,simKey,simFingerprint,{admission:{},profile:{}})).state,'NOT_READY',
    'simulated verification must never authorize a formal refund');
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('ROLLBACK TO SAVEPOINT simulated_scope');
   await c.query('SAVEPOINT unavailable_scope');
   const unavailableAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   await command.applyLegacyContinuationCommand(c,actor,b.id,missing,readLegacyDutyFinalization,unavailableAuthority,finance.postLegacyOwnerCreditOnConfirmation,'UNAVAILABLE');
   const unavailableOwner=(await evidence.readLegacyContinuationDuties(c,b.id)).find(d=>d.kind==='OWNER_CREDIT');assert.equal(unavailableOwner.status,'PENDING');
   await assert.rejects(finance.postLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT',{dutyId:unavailableOwner.id,expectedRevision:unavailableOwner.revision,reason:'核对旧站收益'},unavailableAuthority),
    error=>error.message==='REFUND_HISTORY_REQUIRES_OFFLINE');
   await c.query('SET CONSTRAINTS ALL DEFERRED');
   const rechecked=await finance.postLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT',{dutyId:unavailableOwner.id,expectedRevision:unavailableOwner.revision,reason:'核对旧站收益',originalPaymentChecked:true},unavailableAuthority);
   assert.equal(rechecked.body.status,'SETTLED');
   assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.legacy.owner_credit.payment_rechecked' AND object_id=$1`,[unavailableOwner.id])).rows[0].n,1);
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('ROLLBACK TO SAVEPOINT unavailable_scope');
   await c.query('SAVEPOINT owner_credit_failure');
   const failureAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   const failedCredit=async(...args)=>{await finance.postLegacyOwnerCreditOnConfirmation(...args);throw new Error('synthetic owner credit failure');};
   const deferredCancel=await command.applyLegacyContinuationCommand(c,actor,b.id,missing,readLegacyDutyFinalization,failureAuthority,failedCredit,'OPERATOR');
   assert.equal(deferredCancel.body.stage,'5','a failed optional credit must not undo cancellation');
   const deferredDuties=await evidence.readLegacyContinuationDuties(c,b.id);
   assert.equal(deferredDuties.find(d=>d.kind==='OWNER_CREDIT').status,'PENDING');
   assert.equal(deferredDuties.find(d=>d.kind==='RENTER_REFUND').status,'PENDING');
   assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='OWNER_AVAILABLE'`,[b.ownerUserId])).rows[0].n,0,'partial credit must roll back');
   assert.deepEqual((await c.query(`SELECT reason FROM zzsh_iam.audit_event WHERE action='order.legacy.owner_credit.deferred' AND details->>'versionId'=$1`,[deferredCancel.body.versionId])).rows,[{reason:'AUTO_CREDIT_FAILED'}]);
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('ROLLBACK TO SAVEPOINT owner_credit_failure');
   await c.query('SAVEPOINT cancellation_flow');
   const cancel=command.parseLegacyMutation('support_cancel',{expectedRevision:null,inputEvidenceId:original.id,refundCents:'5000',ownerCents:'3000',reason:'双方协商取消',ownerAmountBasis:'GROSS_BEFORE_FEE_V1',originalPaymentChecked:true});
   const authority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
   const util=require('../dist/src/supply/supply-util.js'),operation='order.legacy.continuation.support_cancel',cancelKey='synthetic_legacy_cancel';
   const cancelFingerprint=util.fingerprintRequest(operation,b.id,cancel);
   const cancelled=await util.withIdempotency(c,{realm:'admin',principalId:actor.userId,operation,resourceId:b.id},cancelKey,cancelFingerprint,async()=>{},
    ()=>command.applyLegacyContinuationCommand(c,actor,b.id,cancel,readLegacyDutyFinalization,authority,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR'));
   assert.equal(cancelled.body.stage,'5');await c.query('SET CONSTRAINTS ALL DEFERRED');
   const head=await evidence.readLegacyContinuationHead(c,b.id),duties=await evidence.readLegacyContinuationDuties(c,b.id);
   assert.equal(head.command,'SUPPORT_CANCEL');assert.equal(head.stage,5);assert(head.refundDueAt);
   assert.equal(duties.find(d=>d.kind==='COMMISSION').status,'VOID');
   const dashboard=require('../dist/src/finance/admin-finance-dashboard.js');
   const dashboardQuery={range:'all',basis:'settled',limit:20,source:'legacy'},viewer={adminId:actor.userId,isBoss:true,quoteRead:true};
   const trend=await dashboard.readFinanceDashboardTrend(c,dashboardQuery,viewer);
   assert.equal(trend.insights.cancelled,'1');
   assert(trend.points.every(point=>point.settlements===null),'cancellation allocation must not masquerade as a completed settlement');
   assert.equal((await dashboard.readFinanceDashboardCustomers(c,dashboardQuery,viewer)).items.length,0,'cancelled order is excluded from settled customer ranking');
   const ownerDuty=duties.find(d=>d.kind==='OWNER_CREDIT'),refundDuty=duties.find(d=>d.kind==='RENTER_REFUND');
   assert.equal(ownerDuty.amountCents,'3000');assert.equal(refundDuty.amountCents,'5000');
   const renter={realm:'user',userId:b.renterUserId,sessionId:'user-session-'+b.legacyRenterId,requestId:'synthetic-renter-read'};
   const owner={realm:'user',userId:b.ownerUserId,sessionId:'user-session-'+b.legacyOwnerId,requestId:'synthetic-owner-read'};
   await setAuditContext(c,'user',renter.userId,renter.sessionId,renter.requestId);
   const renterView=(await evidence.readLegacyContinuation(c,renter,b.id,readLegacyDutyFinalization)).continuation;
   assert.equal(renterView.stage,'5');assert.deepEqual(renterView.capabilities,[]);assert.equal(renterView.duties.find(d=>d.kind==='RENTER_REFUND').amountCents,'5000');assert(!renterView.duties.some(d=>d.kind==='OWNER_CREDIT'));
   await setAuditContext(c,'user',owner.userId,owner.sessionId,owner.requestId);
   const ownerView=(await evidence.readLegacyContinuation(c,owner,b.id,readLegacyDutyFinalization)).continuation;
   assert.equal(ownerView.stage,'5');assert.equal(ownerView.duties.find(d=>d.kind==='OWNER_CREDIT').amountCents,'3000');assert(!ownerView.duties.some(d=>d.kind==='RENTER_REFUND'));
   await c.query('SAVEPOINT was_offline');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query(`UPDATE zzsh_supply.legacy_listing_read_snapshot SET source_status=4 WHERE account_id=$1`,[b.accountId]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
   assert.equal(await publishing.canPrepareLegacyCancelledDraft(c,await publishing.lockPublishingAccount(c,b.accountId)),false,'an account offline at migration remains historical');
   await c.query('ROLLBACK TO SAVEPOINT was_offline');
   await c.query('SAVEPOINT owner_draft');
   await require('../dist/src/auth/user-identity.js').assertUserContextInTransaction(c,owner);
   const editable=await publishing.lockPublishingAccount(c,b.accountId);
   assert.equal(await publishing.canPrepareLegacyCancelledDraft(c,editable),true);
   const gate=async client=>({publisherBail:'NOT_REQUIRED',occupancy:(await require('../dist/src/order/legacy-order-occupancy.js').readAccountOccupancyFacts(client,b.accountId)).state,reference:'synthetic-gate'});
   const ownDetail=await publishing.listingDetail(c,editable,'owner',gate);assert.equal(ownDetail.canPrepareLegacyCancelledDraft,true);assert.equal(ownDetail.available,false);
   await publishing.createListingDraft(c,editable,editable.revision,gate);
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');
   const draft=(await c.query(`SELECT a.legacy_hold,v.origin,v.review_state,(SELECT count(*)::int FROM zzsh_supply.listing_publication p WHERE p.account_id=a.id) AS publications
     FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id WHERE a.id=$1`,[b.accountId])).rows[0];
   assert.deepEqual(draft,{legacy_hold:'NONE',origin:'NATIVE',review_state:'DRAFT',publications:0});
   await c.query('ROLLBACK TO SAVEPOINT owner_draft');
   await setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
   assert.equal(ownerDuty.status,'SETTLED');assert.equal(refundDuty.status,'PENDING');
   const originalRefund=await require('../dist/src/order/legacy-refund-review-source.js').readLockedLegacyRefundSource(c,b,head,refundDuty);
   assert.equal(originalRefund.dutyCents,'5000');assert.equal(originalRefund.paidCents,'10000');assert.equal(originalRefund.paymentOrderNo,'FIXTURE_P7');assert(originalRefund.refundDueAt);
   const profiles=require('../dist/src/order/joinpay-refund-profile.js'),refundStore=require('../dist/src/order/channel-refund-store.js');
   const saved={assertFormalRefundProfile:profiles.assertFormalRefundProfile,describeRefundProfile:profiles.describeRefundProfile,
    readRefundProfileEvidence:profiles.readRefundProfileEvidence,assertRefundStart:profiles.assertRefundStart,assertRefundBinding:profiles.assertRefundBinding,assertRefundResource:refundStore.assertRefundResource};
   const profileText=JSON.stringify({kind:'JOINPAY_REFUND_PROFILE_V1',operation:'SUBMIT',purpose:'MERCHANT_REFUND',database,runtimeUser:'zzsh_completion_synth_probe',merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
   const admissionText=JSON.stringify({kind:'FORMAL_NATIVE_REFUND_SERVER_REVIEW',reference:'synthetic-admission',database,runtimeUser:'zzsh_completion_synth_probe',merchantIdentityId:'synthetic-merchant',merchantNo:'12345',acceptedProfiles:[{operation:'SUBMIT',profileId:'synthetic-profile',profileSha256:sha(profileText),keyVersionRef:'synthetic-key-ref'},{operation:'QUERY'},{operation:'NOTIFY'}]});
   profiles.assertFormalRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',reference:'synthetic-admission',sha256:sha(admissionText),canonical:admissionText});
   profiles.describeRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',profileSha256:sha(profileText),keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
   profiles.readRefundProfileEvidence=()=>profileText;profiles.assertRefundStart=()=>{};profiles.assertRefundBinding=()=>{};refundStore.assertRefundResource=async()=> '1';
   try{
    const {allocateLegacySupportCancelRefund:allocate,allocateLegacySupportCancelRefundInTransaction:allocateInTransaction}=require('../dist/src/order/legacy-support-cancel-refund.js');
    assert.equal((await allocate(c,actor,b.id,'wrong_key',cancelFingerprint,{admission:{},profile:{}})).state,'NOT_READY');
    await c.query('SAVEPOINT prior_refund');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,included_in_opening,snapshot)
      VALUES('synthetic-refund',$1,'HISTORICAL_REFUND','LEGACY_MYSQL','legacy_mysql_restore',$2,'la_refund_record','42',$3,'{}',false,$4::jsonb)`,[b.renterUserId,b.legacyRenterId,b.sourceDigest,JSON.stringify({referenceId:b.legacyId})]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
    assert.equal((await allocate(c,actor,b.id,cancelKey,cancelFingerprint,{admission:{},profile:{}})).state,'HISTORY_REQUIRES_OFFLINE');
    await c.query('ROLLBACK TO SAVEPOINT prior_refund');
    profiles.assertRefundStart=()=>{throw new Error('synthetic allocation failure');};
    assert.equal((await allocateInTransaction(c,actor,b.id,cancelKey,cancelFingerprint,{admission:{},profile:{}})).state,'DEFERRED');
    assert.equal((await evidence.readLegacyContinuationHead(c,b.id)).stage,5,'allocation failure must not undo cancellation');
    assert.equal((await evidence.readLegacyContinuationDuties(c,b.id)).find(d=>d.id===refundDuty.id).status,'PENDING');
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.allocation_deferred' AND object_id=$1 AND details->>'channelResult'='NOT_SUBMITTED'`,[b.id])).rows[0].n,1);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_order.legacy_refund_case WHERE duty_id=$1`,[refundDuty.id])).rows[0].n,0);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.reviewed' AND object_id=$1`,[refundDuty.id])).rows[0].n,0,'failed allocation leaves no partial review');
    profiles.assertRefundStart=()=>{};
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const created=await allocateInTransaction(c,actor,b.id,cancelKey,cancelFingerprint,{admission:{},profile:{}});
    assert.equal(created.state,'CREATED');assert.equal((await allocate(c,actor,b.id,cancelKey,cancelFingerprint,{admission:{},profile:{}})).state,'ALREADY_CREATED');
    const item=(await c.query(`SELECT new_refund_cents::text AS amount FROM zzsh_order.legacy_refund_case WHERE duty_id=$1`,[refundDuty.id])).rows[0];assert.equal(item.amount,'5000');
    assert.equal((await c.query(`SELECT state FROM zzsh_order.legacy_refund_intent WHERE case_id=(SELECT id FROM zzsh_order.legacy_refund_case WHERE duty_id=$1)`,[refundDuty.id])).rows[0].state,'READY');
    await c.query('SAVEPOINT channel_activity');
    const originalCase=(await c.query(`SELECT x.id AS case_id,x.original_payment_order_no,i.id AS intent_id,i.refund_order_no,f.root_id
      FROM zzsh_order.legacy_refund_case x JOIN zzsh_order.legacy_refund_intent i ON i.case_id=x.id
      JOIN zzsh_order.legacy_duty_finance_fact f ON f.duty_id=x.duty_id WHERE x.duty_id=$1`,[refundDuty.id])).rows[0];
    assert(originalCase);
    await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    const wire=Buffer.from('synthetic request'),raw=Buffer.from('synthetic response');
    await c.query(`INSERT INTO zzsh_order.legacy_refund_attempt(id,intent_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,admission_sha256,request_body,request_sha256,created_at)
      VALUES('synthetic-submit',$1,'SUBMIT',1,'synthetic','synthetic-profile',$2,$3,'synthetic-key-ref',$4,$5,$6,transaction_timestamp()-interval '1 second')`,
      [originalCase.intent_id,profileText,sha(profileText),sha(admissionText),wire,sha(wire)]);
    const financeEvent='synthetic_legacy_refund_event',observation='synthetic_legacy_refund_observation',terminal='synthetic_legacy_refund_terminal',trx='synthetic_refund_transaction';
    await c.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES($1,$2,'LEGACY_REFUND_PAID',$3,0)`,[financeEvent,originalCase.root_id,b.renterUserId]);
    await c.query(`INSERT INTO zzsh_order.legacy_refund_observation(id,intent_id,operation,profile_id,profile_canonical,profile_sha256,key_version_ref,raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,evidence_level,state_before,state_after,request_id)
      VALUES($1,$2,'NOTIFY','synthetic-profile',$3,$4,'synthetic-key-ref',$5,$6,true,NULL,$7,NULL,'PENDING_TERMINAL','VALID','MATCH','MATCH','SYNTHETIC_PROTOCOL','SUBMITTING','SUBMITTING','synthetic-request')`,
      [observation,originalCase.intent_id,profileText,sha(profileText),raw,sha(raw),raw.length]);
    const terminalFacts=JSON.stringify({intentId:originalCase.intent_id,caseId:originalCase.case_id,orderId:b.id,renterUserId:b.renterUserId,
      merchantIdentityId:'synthetic-merchant',merchantNo:'12345',originalPaymentOrderNo:originalCase.original_payment_order_no,refundOrderNo:originalCase.refund_order_no,
      amountCents:'5000',currency:'CNY',terminal:'SUCCEEDED',refundTransactionNo:trx,financeEventId:financeEvent,sourceObservationId:observation});
    await c.query(`INSERT INTO zzsh_order.legacy_refund_terminal_evidence(id,intent_id,observation_id,terminal,merchant_no,refund_transaction_no,completed_at_raw,completed_at,finance_event_id,facts_canonical,facts_digest)
      VALUES($1,$2,$3,'SUCCEEDED','12345',$4,'synthetic-time',transaction_timestamp()-interval '1 second',$5,$6,$7)`,
      [terminal,originalCase.intent_id,observation,trx,financeEvent,terminalFacts,sha(terminalFacts)]);
    await c.query(`UPDATE zzsh_order.legacy_refund_intent SET state='SUCCEEDED',budget_disposition='CONSUMED',lease_version=1,lease_owner='synthetic',
      lease_until=clock_timestamp()+interval '1 minute',claim_xid=pg_current_xact_id(),terminal_evidence_id=$2,terminal_event_id=$3,
      provider_refund_trx_no=$4,completed_at=transaction_timestamp()-interval '1 second' WHERE id=$1`,[originalCase.intent_id,terminal,financeEvent,trx]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
    const activity=require('../dist/src/finance/admin-finance-activity.js'),query=activity.parseActivityQuery(new URLSearchParams('kind=REFUND&subjectUserId='+encodeURIComponent(b.ownerUserId)),false);
    const access={adminId:actor.userId,isBoss:true,orderRead:true,financeDocumentRead:true,resourceRead:true};
    const rows=await activity.readAdminChannelActivity(c,query,access),entry=rows.items.find(row=>row.id==='legacy_refund:synthetic-submit');
    assert(entry);assert.equal(entry.amountCents,'5000');assert.equal(entry.subjectRole,'OWNER');assert.equal(entry.relatedOrderId,b.id);assert.equal(entry.bankArrival,'UNKNOWN');
    const denied=await activity.readAdminChannelActivity(c,query,{...access,adminId:'synthetic-denied',isBoss:false});assert.equal(denied.items.length,0,'an unauthorized owner order must not leak through subject lookup');
    const renterRows=await activity.readAdminChannelActivity(c,{...query,subjectUserId:b.renterUserId},{...access,adminId:'synthetic-denied',isBoss:false});
    const renterEntry=renterRows.items.find(row=>row.id==='legacy_refund:synthetic-submit');assert(renterEntry);assert.equal(renterEntry.relatedOrderId,null,'unscoped staff must not receive the order ID');
    assert(!(await activity.readAdminChannelActivity(c,{...query,source:'LEGACY'},access)).items.some(row=>row.id==='legacy_refund:synthetic-submit'),'new refund submissions are not duplicated as old source observations');
    const dashboardQuery={range:'all',basis:'settled',limit:20,source:'legacy'},dashboardViewer={adminId:actor.userId,isBoss:true};
    const channels=require('../dist/src/finance/admin-finance-dashboard.js').readFinanceDashboardChannels;
    assert(!((await channels(c,dashboardQuery,dashboardViewer,['synthetic-merchant'])).items.some(row=>row.kind==='REFUND')),'synthetic observation is not real channel evidence');
    await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query(`UPDATE zzsh_order.legacy_refund_observation SET evidence_level='PROVIDER_RESPONSE' WHERE id=$1`,[observation]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
    assert.deepEqual((await channels(c,dashboardQuery,dashboardViewer,['synthetic-merchant'])).items,[{kind:'REFUND',count:'1',cents:'5000'}]);
    assert.deepEqual((await channels(c,{...dashboardQuery,source:'all'},dashboardViewer,['synthetic-merchant'])).items,[{kind:'REFUND',count:'1',cents:'5000'}],'new and old views must not double-count the same refund');
    assert.deepEqual((await channels(c,{...dashboardQuery,source:'new'},dashboardViewer,['synthetic-merchant'])).items,[],'old-order refunds respect source filter');
    assert.deepEqual((await channels(c,dashboardQuery,dashboardViewer,['other-merchant'])).items,[],'channel totals respect merchant scope');
    assert.deepEqual((await channels(c,dashboardQuery,{...dashboardViewer,adminId:'synthetic-denied',isBoss:false},['synthetic-merchant'])).items,[],'channel totals respect game scope');
    await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query(`UPDATE zzsh_order.legacy_refund_intent SET requires_review=true WHERE id=$1`,[originalCase.intent_id]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);
    assert.deepEqual((await channels(c,dashboardQuery,dashboardViewer,['synthetic-merchant'])).items,[],'conflicted refund evidence is not counted as confirmed');
    await c.query('ROLLBACK TO SAVEPOINT channel_activity');
   }finally{Object.assign(profiles,{assertFormalRefundProfile:saved.assertFormalRefundProfile,describeRefundProfile:saved.describeRefundProfile,
    readRefundProfileEvidence:saved.readRefundProfileEvidence,assertRefundStart:saved.assertRefundStart,assertRefundBinding:saved.assertRefundBinding});refundStore.assertRefundResource=saved.assertRefundResource;}
   assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='OWNER_AVAILABLE'`,[b.ownerUserId])).rows[0].n,1);
   const account=await require('../dist/src/order/legacy-order-occupancy.js').readAccountOccupancyFacts(c,b.accountId);assert.equal(account.state,'FREE');
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');
   await c.query('ROLLBACK TO SAVEPOINT cancellation_flow');
   console.log('PASS: legacy support cancellation records exact allocation, voids commission and posts owner once');
   await c.query('SAVEPOINT cancellation_isolated');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   const isolated=fixture.legacyEvidence(model.initialLegacyFacts(fixture.legacySource({baseBot:null,commissions:[commission]}),[{sourceRecordId:commission.id,canonical:commissionSource,digest:sha(commissionSource),evidenceRef:'synthetic-commission'}]));
   assert.equal(isolated.facts.evidence.admission,'ISOLATED');
   await c.query(`UPDATE zzsh_order.legacy_continuation_evidence SET parameter_digest=$2,admission=$3,reasons=$4::jsonb,facts=$5::jsonb,facts_canonical=$6,facts_digest=$7 WHERE id=$1`,
    [original.id,isolated.facts.evidence.parameterDigest,isolated.facts.evidence.admission,JSON.stringify(isolated.facts.evidence.reasons),JSON.stringify(isolated.facts),isolated.factsCanonical,isolated.factsDigest]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query(`SET LOCAL ROLE ${runtimeRole}`);await setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
   const isolatedInput=command.parseLegacyMutation('support_cancel',{expectedRevision:null,inputEvidenceId:original.id,refundCents:'5000',ownerCents:'3000',reason:'双方协商取消',ownerAmountBasis:'GROSS_BEFORE_FEE_V1',originalPaymentChecked:true});
   const isolatedAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT'),isolatedKey='synthetic_isolated_cancel',isolatedFingerprint=util.fingerprintRequest(operation,b.id,isolatedInput);
   await util.withIdempotency(c,{realm:'admin',principalId:actor.userId,operation,resourceId:b.id},isolatedKey,isolatedFingerprint,async()=>{},
    ()=>command.applyLegacyContinuationCommand(c,actor,b.id,isolatedInput,readLegacyDutyFinalization,isolatedAuthority,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR'));
   await c.query('SET CONSTRAINTS ALL DEFERRED');
   profiles.assertFormalRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',reference:'synthetic-admission',sha256:sha(admissionText),canonical:admissionText});
   profiles.describeRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',profileSha256:sha(profileText),keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
   profiles.readRefundProfileEvidence=()=>profileText;profiles.assertRefundStart=()=>{};profiles.assertRefundBinding=()=>{};refundStore.assertRefundResource=async()=> '1';
   try {assert.equal((await require('../dist/src/order/legacy-support-cancel-refund.js').allocateLegacySupportCancelRefund(c,actor,b.id,isolatedKey,isolatedFingerprint,{admission:{},profile:{}})).state,'CREATED');await c.query('SET CONSTRAINTS ALL IMMEDIATE');}
   finally{Object.assign(profiles,{assertFormalRefundProfile:saved.assertFormalRefundProfile,describeRefundProfile:saved.describeRefundProfile,readRefundProfileEvidence:saved.readRefundProfileEvidence,assertRefundStart:saved.assertRefundStart,assertRefundBinding:saved.assertRefundBinding});refundStore.assertRefundResource=saved.assertRefundResource;}
   await c.query('ROLLBACK TO SAVEPOINT cancellation_isolated');
   console.log('PASS: an incomplete historical price does not prevent a manually allocated cancellation refund');
   for (const [refundCents,ownerCents] of [['0','10000'],['10000','0'],['0','0']]) {
    await c.query('SAVEPOINT cancellation_zero');
    const zero=command.parseLegacyMutation('support_cancel',{expectedRevision:null,inputEvidenceId:original.id,refundCents,ownerCents,reason:'双方协商取消',ownerAmountBasis:'GROSS_BEFORE_FEE_V1',originalPaymentChecked:true});
    const a=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
    await command.applyLegacyContinuationCommand(c,actor,b.id,zero,readLegacyDutyFinalization,a,finance.postLegacyOwnerCreditOnConfirmation,'OPERATOR');
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const items=await evidence.readLegacyContinuationDuties(c,b.id);
    assert.equal(items.filter(d=>d.kind==='RENTER_REFUND').length,refundCents==='0'?0:1);
    assert.equal(items.filter(d=>d.kind==='OWNER_CREDIT').length,ownerCents==='0'?0:1);
    assert.equal(items.find(d=>d.kind==='COMMISSION').status,'VOID');
    await c.query('ROLLBACK TO SAVEPOINT cancellation_zero');
   }
   console.log('PASS: zero allocations do not create false pending refunds or income');
   // The new verified proposal/confirmation path is covered by legacy-closure-verified-synthetic.cjs.
   await c.query('ROLLBACK');return;
  }
  const basisStore=require('../dist/src/order/legacy-settlement-basis.js');
  const basisInput={expectedRevision:null,inputEvidenceId:original.id,expectedBasisId:null,openingHaffM:'1',baseBot:'10',ownerPrices:fixture.legacyPrices('8.00'),openingItems:fixture.legacyQuantities('1'),fullPayout:false,partiesVerified:true,reason:'已与双方核实原始资料'};
  const basisAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
  const basisHead=await evidence.lockLegacyContinuationOrder(c,b.id);
  await basisStore.recordLegacySettlementBasis(c,actor,basisAuthority.binding,original,basisHead.head,basisInput);
  const verifiedBasis=await basisStore.readLegacySettlementBasis(c,b,original,null);
  await c.query('SAVEPOINT admin_flow');
  const quantities=fixture.legacyQuantities('5.00');
  const proposed=calc.planVerifiedLegacySettlement(original.facts.evidence,{kind:'propose',caller:{role:'admin',legacyUserId:'',onBehalf:'renter'},quantities,endReason:'NORMAL',settlementBasis:verifiedBasis},verifiedBasis);assert(proposed.ok);
  const input=command.parseLegacyMutation('propose',{expectedRevision:null,inputEvidenceId:original.id,planFingerprint:proposed.fingerprint,quantities,endReason:'NORMAL',onBehalf:'renter',reason:'双方已核实消耗'});
  const proposedResult=await command.applyLegacyContinuationCommand(c,actor,b.id,input,readLegacyDutyFinalization);
  assert.equal(proposedResult.body.stage,'8');
  await c.query('SET CONSTRAINTS ALL DEFERRED');
  const head=await evidence.readLegacyContinuationHead(c,b.id),proposal=await evidence.readLegacyContinuationEvidence(c,b.id,head);
  const confirmed=calc.planLegacyContinuation(model.readSealedLegacyFacts(proposal).evidence,{kind:'confirm',caller:{role:'admin',legacyUserId:''}});assert(confirmed.ok);
  const confirmInput=command.parseLegacyMutation('confirm',{expectedRevision:head.revision,inputEvidenceId:proposal.id,planFingerprint:confirmed.fingerprint,reason:'双方已确认结算'});
  const confirmResult=await command.applyLegacyContinuationCommand(c,actor,b.id,confirmInput,readLegacyDutyFinalization);
  assert.equal(confirmResult.body.stage,'4');
  await c.query('SET CONSTRAINTS ALL DEFERRED');
  const locked=await evidence.lockLegacyContinuationOrder(c,b.id),ownerDuty=locked.duties.find(d=>d.kind==='OWNER_CREDIT');
  assert(ownerDuty && ownerDuty.status==='PENDING');
  const dutyBasis=require('../dist/src/order/legacy-duty-basis.js'),financePlan=require('../dist/src/finance/legacy-duty-finance.js');
  const fundingReader=require('../dist/src/finance/legacy-duty-funding.js');
  const basis=financePlan.legacyDutyBasisFromTrade(ownerDuty,await dutyBasis.readLegacyDutyBasis(c,b.id,ownerDuty));assert.equal(basis.knowledge,'KNOWN');
  const funding=await fundingReader.readLegacyDutyFundingProof(c,ownerDuty,basis.basis);assert.equal(funding.knowledge,'KNOWN');
  const now=(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)).rows[0].now;
  const planned=financePlan.planLegacyDutyFinalization(ownerDuty,basis.basis,funding.proof,{dutyId:ownerDuty.id,expectedRevision:ownerDuty.revision,
   expectedEvidenceDigest:basis.basis.evidenceDigest,expectedAmountCents:ownerDuty.amountCents},now);
  await c.query('SAVEPOINT wrong_confirmer');
  await setAuditContext(c,'user',b.renterUserId,'user-session-'+b.legacyRenterId,'synthetic-renter-request');
  await assert.rejects(c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3)',[planned.canonical,canonicalize(funding.proof),'模拟用户重复操作']),error=>error.code==='42501');
  await c.query('ROLLBACK TO SAVEPOINT wrong_confirmer');
  const authority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
  const posted=await finance.postLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT',{dutyId:ownerDuty.id,expectedRevision:ownerDuty.revision,reason:'核对后入账号主收益'},authority);
  assert.equal(posted.body.status,'SETTLED');assert.equal(posted.body.amountCents,ownerDuty.amountCents);
  const readback=await finance.projectLegacyFinanceDutyReceipt(c,b.id,'OWNER_CREDIT',posted.body);assert.equal(readback.reference.digest,posted.body.reference.digest);
  const replay=await finance.postLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT',{dutyId:ownerDuty.id,expectedRevision:ownerDuty.revision,reason:'核对后入账号主收益'},authority);
  assert.deepEqual(replay.body.reference,posted.body.reference);
  assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='OWNER_AVAILABLE'`,[b.ownerUserId])).rows[0].n,1);
  await c.query('ROLLBACK TO SAVEPOINT admin_flow');
  await setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
  await command.applyLegacyContinuationCommand(c,actor,b.id,input,readLegacyDutyFinalization);
  await c.query('SET CONSTRAINTS ALL DEFERRED');
  const supportHead=await evidence.readLegacyContinuationHead(c,b.id),supportEvidence=await evidence.readLegacyContinuationEvidence(c,b.id,supportHead);
  const supportPlan=calc.planLegacyContinuation(model.readSealedLegacyFacts(supportEvidence).evidence,{kind:'confirm',caller:{role:'admin',legacyUserId:''}});assert(supportPlan.ok);
  const supportInput=command.parseLegacyMutation('confirm',{expectedRevision:supportHead.revision,inputEvidenceId:supportEvidence.id,planFingerprint:supportPlan.fingerprint,reason:'双方已确认结算'});
  const supportAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'OWNER_CREDIT');
  assert.equal((await command.applyLegacyContinuationCommand(c,actor,b.id,supportInput,readLegacyDutyFinalization,supportAuthority,finance.postLegacyOwnerCreditOnConfirmation)).body.stage,'4');
  const supportDuty=(await evidence.readLegacyContinuationDuties(c,b.id)).find(d=>d.kind==='OWNER_CREDIT');assert.equal(supportDuty?.status,'SETTLED');
  assert.deepEqual((await c.query('SELECT actor_realm,actor_id FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=$1',[supportDuty.id])).rows[0],{actor_realm:'admin',actor_id:actor.userId});
  if(cancellation){await c.query('ROLLBACK');console.log('PASS: existing legacy proposal and confirmation remain available');return;}
  const refundProfile=require('../dist/src/order/joinpay-refund-profile.js'),refundStore=require('../dist/src/order/channel-refund-store.js');
  const oldProfile=refundProfile.assertFormalRefundProfile,oldDescription=refundProfile.describeRefundProfile,oldEvidence=refundProfile.readRefundProfileEvidence,oldStart=refundProfile.assertRefundStart,oldBinding=refundProfile.assertRefundBinding,oldResource=refundStore.assertRefundResource;
  const profileText=JSON.stringify({kind:'JOINPAY_REFUND_PROFILE_V1',operation:'SUBMIT',purpose:'MERCHANT_REFUND',database,runtimeUser:'zzsh_completion_synth_probe',merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
  const admissionText=JSON.stringify({kind:'FORMAL_NATIVE_REFUND_SERVER_REVIEW',reference:'synthetic-admission',database,runtimeUser:'zzsh_completion_synth_probe',merchantIdentityId:'synthetic-merchant',merchantNo:'12345',acceptedProfiles:[
   {operation:'SUBMIT',profileId:'synthetic-profile',profileSha256:sha(profileText),keyVersionRef:'synthetic-key-ref'},{operation:'QUERY'},{operation:'NOTIFY'}]});
  refundProfile.assertFormalRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',reference:'synthetic-admission',sha256:sha(admissionText),canonical:admissionText});
  refundProfile.describeRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',profileSha256:sha(profileText),keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
  refundProfile.readRefundProfileEvidence=()=>profileText;
  refundProfile.assertRefundStart=()=>{};
  refundProfile.assertRefundBinding=(_p,_op,binding)=>{assert.equal(binding.reason,'订单结算退款');};
  refundStore.assertRefundResource=async()=> '1';
  try {
   const {recordLegacyRefundReview}=require('../dist/src/order/legacy-refund-review-store.js');
   const refundHead=await evidence.readLegacyContinuationHead(c,b.id),refundDuty=(await evidence.readLegacyContinuationDuties(c,b.id)).find(d=>d.kind==='RENTER_REFUND');
   assert(refundDuty && BigInt(refundDuty.amountCents)>2000n);
   for(const applied of ['0','2000',refundDuty.amountCents]){
    await c.query('SAVEPOINT refund_case');await c.query('SET CONSTRAINTS ALL DEFERRED');
    const review=await recordLegacyRefundReview(c,actor,{orderId:b.id,dutyId:refundDuty.id,expectedDutyRevision:refundDuty.revision,expectedHeadRevision:refundHead.revision,
     paymentOrderNo:'FIXTURE_P7',confirmedMerchantNo:'12345',paidCents:'10000',previouslyRefundedCents:applied,priorAppliedToDutyCents:applied,
     noUnresolvedRefunds:true,evidenceRef:'已核对合成渠道记录'},{admission:{},profile:{}});
    const refundAuthority=await finance.authorizeLegacyFinanceDuty(c,actor,b.id,'RENTER_REFUND');
    await finance.postLegacyFinanceDuty(c,actor,b.id,'RENTER_REFUND',{dutyId:refundDuty.id,expectedRevision:refundDuty.revision,reason:'核对租客退款责任'},refundAuthority);
    const audit=(await c.query(`SELECT id,details FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.reviewed' AND object_id=$1 AND details->>'reviewId'=$2`,[refundDuty.id,review.reviewId])).rows[0];
    if(applied==='2000'){
     await c.query('SAVEPOINT forged_review');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
     const forged={...audit.details,paidCents:'9999'};delete forged.reviewDigest;forged.reviewDigest=sha(canonicalize(forged));
     await c.query('UPDATE zzsh_iam.audit_event SET details=$2::jsonb WHERE id=$1',[audit.id,JSON.stringify(forged)]);
     await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
     await assert.rejects(c.query('SELECT zzsh_order.create_legacy_refund_case($1)',[audit.id]),error=>error.code==='23514');
     await c.query('ROLLBACK TO SAVEPOINT forged_review');
    }
    const result=(await c.query('SELECT zzsh_order.create_legacy_refund_case($1) AS result',[audit.id])).rows[0].result;
    assert.equal(result.channelResult,'NOT_SUBMITTED');assert.equal(result.priorAppliedCents,applied);
    const expected=(BigInt(refundDuty.amountCents)-BigInt(applied)).toString();assert.equal(result.amountCents,expected);
    const payable=(await c.query(`SELECT COALESCE(sum(credit_cents-debit_cents),0)::text AS amount FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='RENTER_REFUND_PAYABLE'`,[b.renterUserId])).rows[0];
    assert.equal(payable.amount,expected);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_order.legacy_refund_intent WHERE case_id=$1',[result.caseId])).rows[0].n,expected==='0'?0:1);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.finance_event WHERE id=$1 AND kind='LEGACY_REFUND_HISTORY_OFFSET'",['legacy_refund_history_'+sha(result.caseId).slice(0,40)])).rows[0].n,applied==='0'?0:1);
    await c.query('SAVEPOINT duplicate_case');await assert.rejects(c.query('SELECT zzsh_order.create_legacy_refund_case($1)',[audit.id]));await c.query('ROLLBACK TO SAVEPOINT duplicate_case');
    await c.query('ROLLBACK TO SAVEPOINT refund_case');
   }
   await c.query('SAVEPOINT refund_case_command');await c.query('SET CONSTRAINTS ALL DEFERRED');
   const caseService=require('../dist/src/order/legacy-refund-case-command.js');
   const caseInput={orderId:b.id,dutyId:refundDuty.id,expectedDutyRevision:refundDuty.revision,expectedHeadRevision:refundHead.revision,
    paymentOrderNo:'FIXTURE_P7',confirmedMerchantNo:'12345',paidCents:'10000',previouslyRefundedCents:'2000',priorAppliedToDutyCents:'2000',
    noUnresolvedRefunds:true,evidenceRef:'已核对合成渠道记录'};
   await c.query('SAVEPOINT missing_refund_guard');await c.query('RESET ROLE');
   await c.query('DROP TRIGGER legacy_refund_history_entry_complete ON zzsh_order.settlement_ledger_entry');await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
   await assert.rejects(caseService.createLegacyRefundCase(c,actor,caseInput,{admission:{},profile:{}}),error=>error.status===503);
   assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.reviewed' AND object_id=$1",[refundDuty.id])).rows[0].n,0);
   await c.query('ROLLBACK TO SAVEPOINT missing_refund_guard');
   const candidateCase='legacy_refund_case_'+sha(refundDuty.id).slice(0,40),candidateRefundNo='LR'+sha(candidateCase).slice(0,28);
   for(const [kind,entity] of [['HISTORICAL_REFUND','la_refund_record'],['HISTORICAL_PAYMENT','la_pay_order']]){
    await c.query('SAVEPOINT refund_number_collision');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,
     source_entity,source_id,source_digest,source_canonical,included_in_opening,snapshot)
     VALUES('collision-refund',$1,$5,'LEGACY_MYSQL','legacy_mysql_restore',$2,$6,'987',$3,'{}',false,$4::jsonb)`,
     [b.renterUserId,b.legacyRenterId,b.renterSourceDigest,JSON.stringify({sourceNumber:candidateRefundNo}),kind,entity]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    await assert.rejects(caseService.createLegacyRefundCase(c,actor,caseInput,{admission:{},profile:{}}),error=>error.code==='23514');
    await c.query('ROLLBACK TO SAVEPOINT refund_number_collision');
   }
   const created=await caseService.createLegacyRefundCase(c,actor,caseInput,{admission:{},profile:{}});
   assert.equal(created.body.channelResultAtCreation,'NOT_SUBMITTED');assert.equal(created.body.amountCents,(BigInt(refundDuty.amountCents)-2000n).toString());
   assert.deepEqual(await caseService.readLegacyRefundCaseReceipt(c,actor,b.id,refundDuty.id,created.body.caseId),created.body);
   for(const corruption of ['merchant','ledger']){
    await c.query('SAVEPOINT corrupted_case');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    if(corruption==='merchant')await c.query("UPDATE zzsh_order.legacy_refund_case SET merchant_no='12346' WHERE id=$1",[created.body.caseId]);
    else await c.query("UPDATE zzsh_order.settlement_ledger_entry SET debit_cents=debit_cents+1 WHERE finance_event_id=$1 AND line_no=1",['legacy_refund_history_'+sha(created.body.caseId).slice(0,40)]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    await assert.rejects(caseService.readLegacyRefundCaseReceipt(c,actor,b.id,refundDuty.id,created.body.caseId));
    await c.query('ROLLBACK TO SAVEPOINT corrupted_case');
   }
   await c.query('SAVEPOINT worker_prepare');
   const oldInitial=refundProfile.assertInitialRefundAdmission,oldProduce=refundProfile.produceRefundRequest,oldOutbound=refundProfile.readRefundOutbound,oldAdmission=refundProfile.readFormalRefundAdmission;
   const oldInspect=refundProfile.inspectRefundProfile,oldTime=refundProfile.refundCompleteTimeToUtc,oldFailure=refundProfile.refundFailureMayRelease;
   const protocol=require('../dist/src/order/joinpay-refund-protocol.js'),oldPreflight=protocol.preflightJoinpayRefundResponse;
   const queryText=JSON.stringify({kind:'JOINPAY_REFUND_PROFILE_V1',operation:'QUERY',purpose:'MERCHANT_REFUND',database,runtimeUser:'zzsh_completion_synth_probe',merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-query',keyVersionRef:'synthetic-query-key',rules:{utcOffsetMinutes:480,
    failureNoExecution:{accepted:true,reference:'synthetic-evidence',sha256:'a'.repeat(64),codes:['E100']}}});
   const notifyText=JSON.stringify({kind:'JOINPAY_REFUND_PROFILE_V1',operation:'NOTIFY',purpose:'MERCHANT_REFUND',database,runtimeUser:'zzsh_completion_synth_probe',merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-notify',keyVersionRef:'synthetic-notify-key',rules:{utcOffsetMinutes:480,
    failureNoExecution:{accepted:true,reference:'synthetic-evidence',sha256:'a'.repeat(64),codes:['E100']}}});
   const knownRefundNumbers=new Set([created.body.refundOrderNo]);
   try{
    refundProfile.assertInitialRefundAdmission=()=>{};
    refundProfile.readFormalRefundAdmission=()=>({database,runtimeUser:'zzsh_completion_synth_probe',
     merchantIdentityId:'synthetic-merchant',merchantNo:'12345',reference:'synthetic-admission',sha256:sha(admissionText),historicalInitialAdmissions:[],acceptedProfiles:[{operation:'SUBMIT'}]});
    refundProfile.describeRefundProfile=p=>p?.operation==='NOTIFY'?{merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-notify',profileSha256:sha(notifyText),keyVersionRef:'synthetic-notify-key'}:
     p?.operation==='QUERY'?{merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-query',profileSha256:sha(queryText),keyVersionRef:'synthetic-query-key'}:
     {merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',profileSha256:sha(profileText),keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'};
    refundProfile.readRefundProfileEvidence=p=>p?.operation==='NOTIFY'?notifyText:p?.operation==='QUERY'?queryText:profileText;
    refundProfile.produceRefundRequest=(_profile,operation,binding)=>{assert.equal(binding.reason,'订单结算退款');return {operation,requestSha256:sha('synthetic-request')};};
    refundProfile.readRefundOutbound=()=>({body:'synthetic-request',endpoint:'https://fixture.invalid',purpose:'MERCHANT_REFUND'});
    refundProfile.refundCompleteTimeToUtc=()=> '2026-11-07T01:00:00.000Z';
    refundProfile.refundFailureMayRelease=(_profile,result)=>result.result==='CHANNEL_REPORTED_FAILED';
    protocol.preflightJoinpayRefundResponse=()=>({ok:true});
    refundProfile.inspectRefundProfile=(_profile,operation,raw,binding)=>{
     assert.equal(binding.originalPaymentOrderNo,'FIXTURE_P7');assert(knownRefundNumbers.has(binding.refundOrderNo));
     if(operation==='SUBMIT')return {signature:'MATCH',result:'APPLICATION_ACCEPTED'};
     if(String(raw)==='bad')return {signature:'MISMATCH',result:'UNVERIFIED'};
     if(String(raw)==='review')return {signature:'MATCH',result:'REVIEW_REQUIRED',reason:'BINDING_MISMATCH'};
     if(String(raw)==='processing')return {signature:'MATCH',result:'PROCESSING',channelCode:'100'};
     if(String(raw)==='failure')return {signature:'MATCH',result:'CHANNEL_REPORTED_FAILED',providerRefundTrxNo:'FIXTURE_FAILED_REFUND',channelCode:'E100'};
     return {signature:'MATCH',result:'CHANNEL_REPORTED_SUCCEEDED',providerRefundTrxNo:String(raw)==='conflict'?'FIXTURE_OTHER_REFUND':'FIXTURE_REFUND',
      completedAtRaw:'2026-11-07 09:00:00',refundWay:'ORIGINAL',channelCode:'100'};
    };
    let expireDuringObservation=false,unrelatedFailure=false;
    const proxy={query:async(sql,args)=>{
     if(sql==='BEGIN')return c.query('SAVEPOINT synthetic_refund_worker_tx');
     if(sql==='COMMIT')return c.query('RELEASE SAVEPOINT synthetic_refund_worker_tx');
     if(sql==='ROLLBACK'){await c.query('ROLLBACK TO SAVEPOINT synthetic_refund_worker_tx');return c.query('RELEASE SAVEPOINT synthetic_refund_worker_tx');}
     if(typeof sql==='string'&&sql.includes('INSERT INTO zzsh_order.legacy_refund_observation')&&expireDuringObservation){
      expireDuringObservation=false;await c.query('SELECT pg_sleep(1.3)');
      if(unrelatedFailure){unrelatedFailure=false;throw Object.assign(Error('synthetic unrelated constraint'),{code:'23514',constraint:'different_constraint'});}
     }
     return c.query(sql,args);
    },release(){}};
    let fetchCalls=0;
    const execution={pool:{connect:async()=>proxy},admission:{},legacyRefundsEnabled:true,profileFor:operation=>({operation}),keyFor:()=> 'synthetic-key',
     fetch:async()=>{fetchCalls++;return new Response('synthetic-response',{status:200});}};
    const {executeLegacyRefund,receiveLegacyRefundNotification,readLegacyRefundProgress,resolveLegacyRefundTerminal,resumeLegacyRefundReview,retryLegacyRefund}=require('../dist/src/order/legacy-refund-attempt.js');
    const {recoverLegacyJoinpayRefundBatch}=require('../dist/src/finance/joinpay-funds-recovery.js');
    const recovery={workerId:'worker',batchLimit:3,minimumIntervalSeconds:30,execution:{...execution,legacyRefundsEnabled:false}};
    assert.deepEqual(await recoverLegacyJoinpayRefundBatch(recovery),{selected:0,recorded:0,skipped:0});
    const delayed={...execution,fetch:async()=>{
     await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
     await c.query("UPDATE zzsh_order.legacy_refund_intent SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1",[created.body.intentId]);
     await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
     expireDuringObservation=true;return new Response('synthetic-response',{status:200});
    }};
    await c.query('SAVEPOINT stale_branch');
    const stale=await executeLegacyRefund(delayed,created.body.intentId,'stale-worker');
    assert.equal(stale.event,'STALE');assert.equal(stale.terminal,null);
    assert.equal((await c.query('SELECT state FROM zzsh_order.legacy_refund_intent WHERE id=$1',[created.body.intentId])).rows[0].state,'SUBMITTING');
    await c.query('ROLLBACK TO SAVEPOINT stale_branch');
    await c.query('SAVEPOINT unrelated_constraint_branch');unrelatedFailure=true;
    await assert.rejects(executeLegacyRefund(delayed,created.body.intentId,'stale-worker'),error=>error.constraint==='different_constraint');
    await c.query('ROLLBACK TO SAVEPOINT unrelated_constraint_branch');
    assert.equal((await executeLegacyRefund({...execution,legacyRefundsEnabled:false},created.body.intentId,'worker')).reason,'NEW_REFUND_DISABLED');
    assert.equal((await executeLegacyRefund(execution,created.body.intentId,'worker',{queryOnly:true})).kind,'NOT_DISPATCHED');
    await assert.rejects(executeLegacyRefund(execution,created.body.intentId,'worker',{authorize:async()=>{throw Error('unauthorized')}}));
    await c.query('SAVEPOINT native_collision');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query(`INSERT INTO zzsh_order.payment_request(id,order_id,channel,merchant_identity_id,config_profile_id,protocol_version,
     key_version_ref,platform_order_no,channel_order_no,amount_cents,currency,wire_amount_yuan,method,evidence_level,idempotency_scope_key,idempotency_key,request_fingerprint)
     VALUES('payreq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','synthetic-native-order','JOINPAY','other-merchant','profile','2.6','key','FIXTURE_P7','FIXTURE_P7',100,'CNY','1.00',
     'WEIXIN_NATIVE','JOINPAY_CANDIDATE','scope','key',$1)`,['a'.repeat(64)]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    assert.equal((await executeLegacyRefund(execution,created.body.intentId,'worker')).reason,'ORIGINAL_PAYMENT_CONFLICT');
    await c.query('ROLLBACK TO SAVEPOINT native_collision');
    assert.equal(fetchCalls,0);
    const first=await executeLegacyRefund(execution,created.body.intentId,'worker');assert.equal(first.kind,'OBSERVED');assert.equal(first.event,'PROCESSING');
    assert.equal((await executeLegacyRefund(execution,created.body.intentId,'worker')).reason,'ACTIVE_LEASE');
    await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query("UPDATE zzsh_order.legacy_refund_intent SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[created.body.intentId]);
    await c.query("UPDATE zzsh_order.legacy_refund_attempt SET created_at=clock_timestamp()-interval '31 seconds' WHERE intent_id=$1",[created.body.intentId]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    const recovered=await recoverLegacyJoinpayRefundBatch(recovery);assert.deepEqual(recovered,{selected:1,recorded:1,skipped:0});
    assert.equal(fetchCalls,2);
    assert.deepEqual((await c.query('SELECT operation FROM zzsh_order.legacy_refund_attempt WHERE intent_id=$1 ORDER BY lease_version',[created.body.intentId])).rows.map(row=>row.operation),['SUBMIT','QUERY']);
    assert.equal((await receiveLegacyRefundNotification(execution,created.body.intentId,'bad','synthetic-bad')).ack,'fail');
    await c.query('SAVEPOINT review_branch');
    assert.equal((await receiveLegacyRefundNotification(execution,created.body.intentId,'review','synthetic-review')).event,'REVIEW');
    await c.query('SAVEPOINT forbidden_review_clear');
    await assert.rejects(c.query("UPDATE zzsh_order.legacy_refund_intent SET requires_review=false,state='UNKNOWN',revision=revision+1 WHERE id=$1",[created.body.intentId]),error=>['23514','42501'].includes(error.code));
    await c.query('ROLLBACK TO SAVEPOINT forbidden_review_clear');
    const resumeActor={realm:'admin',userId:'synthetic-agent',sessionId:'synthetic-agent-session',requestId:'synthetic-resume-request'},reviewService=require('../dist/src/order/legacy-refund-review-store.js');
    const authorize=async client=>reviewService.authorizeLegacyRefundReviewAccess(client,resumeActor,b.id);
    await assert.rejects(resumeLegacyRefundReview(execution,created.body.intentId,resumeActor,resumeActor.requestId,'已核对渠道记录',authorize));
    await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query("UPDATE zzsh_order.legacy_refund_intent SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[created.body.intentId]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    await assert.rejects(resumeLegacyRefundReview(execution,created.body.intentId,{userId:'synthetic-denied',sessionId:'synthetic-denied-session'},'synthetic-denied-request','已核对渠道记录',
     async client=>reviewService.authorizeLegacyRefundReviewAccess(client,{realm:'admin',userId:'synthetic-denied',sessionId:'synthetic-denied-session',requestId:'synthetic-denied-request'},b.id)));
    await c.query('SAVEPOINT denied_permission');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query("UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id='synthetic-agent' AND permission_code='order.settlement.write'");
    await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    await assert.rejects(resumeLegacyRefundReview(execution,created.body.intentId,resumeActor,resumeActor.requestId,'已核对渠道记录',authorize));
    await assert.rejects(resumeLegacyRefundReview(execution,created.body.intentId,resumeActor,resumeActor.requestId,'已核对渠道记录',async()=>{}),error=>error.status===403);
    await c.query('ROLLBACK TO SAVEPOINT denied_permission');
    await c.query('SAVEPOINT denied_scope');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query("UPDATE zzsh_iam.admin_security SET game_scope_mode='SELECTED_GAMES' WHERE admin_user_id='synthetic-agent'");
    await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    await assert.rejects(resumeLegacyRefundReview(execution,created.body.intentId,resumeActor,resumeActor.requestId,'已核对渠道记录',authorize));
    await assert.rejects(resumeLegacyRefundReview(execution,created.body.intentId,resumeActor,resumeActor.requestId,'已核对渠道记录',async()=>{}),error=>error.status===403);
    await c.query('ROLLBACK TO SAVEPOINT denied_scope');
    await c.query('SAVEPOINT reviewed_channel_result');
    assert.equal((await receiveLegacyRefundNotification(execution,created.body.intentId,'good','synthetic-reviewed-result')).event,'REVIEW');
    await assert.rejects(resumeLegacyRefundReview(execution,created.body.intentId,resumeActor,resumeActor.requestId,'已核对渠道记录',authorize),error=>error.status===409);
    await c.query('ROLLBACK TO SAVEPOINT reviewed_channel_result');
    const resumed=await resumeLegacyRefundReview(execution,created.body.intentId,resumeActor,resumeActor.requestId,'已核对渠道记录',authorize);
    assert.equal(resumed.resumed,true);assert.equal(resumed.state,'UNKNOWN');
    assert.equal((await resumeLegacyRefundReview(execution,created.body.intentId,resumeActor,resumeActor.requestId,'已核对渠道记录',authorize)).resumed,false);
    const reviewState=(await c.query('SELECT state,requires_review,budget_disposition FROM zzsh_order.legacy_refund_intent WHERE id=$1',[created.body.intentId])).rows[0];
    assert.deepEqual(reviewState,{state:'UNKNOWN',requires_review:false,budget_disposition:'ALLOCATED'});assert.equal(fetchCalls,2);
    await c.query('ROLLBACK TO SAVEPOINT review_branch');
    await c.query('SAVEPOINT late_processing_branch');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query("UPDATE zzsh_order.legacy_refund_intent SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[created.body.intentId]);
    await c.query("UPDATE zzsh_order.legacy_refund_attempt SET created_at=clock_timestamp()-interval '1 minute' WHERE intent_id=$1",[created.body.intentId]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    {
     const transport=require('../dist/src/order/joinpay-refund-attempt.js'),oldTransport=transport.exchangeRefundRequest;
     try{
      transport.exchangeRefundRequest=async()=>{
       const notice=await receiveLegacyRefundNotification(execution,created.body.intentId,'good','late-processing-terminal');assert.equal(notice.terminal?.terminal,'SUCCEEDED');
       return {body:Buffer.from('processing'),responseComplete:true,receivedBytes:10,httpStatus:200,failure:null,evidenceLevel:'PROVIDER_RESPONSE'};
      };
      const late=await executeLegacyRefund(execution,created.body.intentId,'late-processing-worker',{queryOnly:true});
      assert.equal(late.event,'REVIEW');assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'REVIEW_REQUIRED');
      assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.finance_event WHERE kind='LEGACY_REFUND_PAID'")).rows[0].n,1);
      await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
      await c.query("UPDATE zzsh_order.legacy_refund_intent SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[created.body.intentId]);
      await c.query("UPDATE zzsh_order.legacy_refund_attempt SET created_at=clock_timestamp()-interval '1 minute' WHERE intent_id=$1",[created.body.intentId]);
      await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
      transport.exchangeRefundRequest=async()=>({body:Buffer.from('good'),responseComplete:true,receivedBytes:4,httpStatus:200,failure:null,evidenceLevel:'PROVIDER_RESPONSE'});
      const reviewer={realm:'admin',userId:'synthetic-agent',sessionId:'synthetic-agent-session',requestId:'late-processing-reviewed'};
      const reconciled=await resolveLegacyRefundTerminal(execution,created.body.intentId,reviewer,reviewer.requestId,'已核对原退款结果','late-processing-review',
       async client=>reviewService.authorizeLegacyRefundReviewAccess(client,reviewer,b.id));
      assert.equal(reconciled.event,'REVIEW_RESOLVED');assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'SUCCEEDED');
     }finally{transport.exchangeRefundRequest=oldTransport;}
    }
    await c.query('ROLLBACK TO SAVEPOINT late_processing_branch');
    await c.query('SAVEPOINT success_branch');
    const paid=await receiveLegacyRefundNotification(execution,created.body.intentId,'good','synthetic-paid');
    assert.equal(paid.terminal?.terminal,'SUCCEEDED');assert.equal(paid.ack,'success');
    assert.equal((await caseService.readLegacyRefundCaseReceipt(c,actor,b.id,refundDuty.id,created.body.caseId)).channelResultAtCreation,'NOT_SUBMITTED');
    assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'SUCCEEDED');
    assert.equal((await receiveLegacyRefundNotification(execution,created.body.intentId,'good','synthetic-replay')).ack,'success');
    await c.query('SAVEPOINT terminal_recovery_branch');
    const ambiguous=await receiveLegacyRefundNotification(execution,created.body.intentId,'review','synthetic-ambiguous');assert.equal(ambiguous.ack,'fail');
    assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'REVIEW_REQUIRED');
    await assert.rejects(resumeLegacyRefundReview(execution,created.body.intentId,actor,'synthetic-terminal-resume','已核对渠道记录',
     async client=>reviewService.authorizeLegacyRefundReviewAccess(client,{...actor,requestId:'synthetic-terminal-resume'},b.id)));
    const state=(await c.query(`SELECT state,requires_review,terminal_event_id FROM zzsh_order.legacy_refund_intent WHERE id=$1`,[created.body.intentId])).rows[0];
    assert.equal(state.state,'SUCCEEDED');assert.equal(state.requires_review,true);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1',[state.terminal_event_id])).rows[0].n,2);
    await c.query('SAVEPOINT reject_forged_terminal_clear');
    await assert.rejects(c.query('UPDATE zzsh_order.legacy_refund_intent SET requires_review=false,revision=revision+1 WHERE id=$1',[created.body.intentId]),error=>['23514','42501'].includes(error.code));
    await c.query('ROLLBACK TO SAVEPOINT reject_forged_terminal_clear');
    async function expireSyntheticRefund(){
     await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
     await c.query("UPDATE zzsh_order.legacy_refund_intent SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[created.body.intentId]);
     await c.query("UPDATE zzsh_order.legacy_refund_attempt SET created_at=clock_timestamp()-interval '1 minute' WHERE intent_id=$1",[created.body.intentId]);
     await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    }
    const resolveActor={realm:'admin',userId:'synthetic-agent',sessionId:'synthetic-agent-session',requestId:'synthetic-resolve-request'};
    const authorizeResolution=async client=>reviewService.authorizeLegacyRefundReviewAccess(client,resolveActor,b.id);
    await expireSyntheticRefund();
    await assert.rejects(resolveLegacyRefundTerminal(execution,created.body.intentId,resolveActor,resolveActor.requestId,'已核对渠道记录','resolve-denied',async()=>{throw Error('unauthorized')}));
    const synthetic=await resolveLegacyRefundTerminal(execution,created.body.intentId,resolveActor,resolveActor.requestId,'已核对渠道记录','resolve-synthetic',authorizeResolution);
    assert.notEqual(synthetic.event,'REVIEW_RESOLVED');assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'REVIEW_REQUIRED');
    const exchange=require('../dist/src/order/joinpay-refund-attempt.js'),oldExchange=exchange.exchangeRefundRequest;
    try{
     let body='processing';exchange.exchangeRefundRequest=async()=>({body:Buffer.from(body),responseComplete:true,receivedBytes:body.length,httpStatus:200,failure:null,evidenceLevel:'PROVIDER_RESPONSE'});
     await expireSyntheticRefund();
     const processing=await resolveLegacyRefundTerminal(execution,created.body.intentId,resolveActor,resolveActor.requestId,'已核对渠道记录','resolve-processing',authorizeResolution);
     assert.equal(processing.event,'REVIEW');assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'REVIEW_REQUIRED');
     body='bad';
     await expireSyntheticRefund();
     const mismatch=await resolveLegacyRefundTerminal(execution,created.body.intentId,resolveActor,resolveActor.requestId,'已核对渠道记录','resolve-mismatch',authorizeResolution);
     assert.notEqual(mismatch.event,'REVIEW_RESOLVED');assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'REVIEW_REQUIRED');
     body='good';await expireSyntheticRefund();
     const resolved=await resolveLegacyRefundTerminal(execution,created.body.intentId,resolveActor,resolveActor.requestId,'已核对渠道记录','resolve-matching',authorizeResolution);
     assert.notEqual(resolved.event,'REVIEW_RESOLVED');assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'REVIEW_REQUIRED');
     assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1',[state.terminal_event_id])).rows[0].n,2);
     assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.terminal_review_resolved' AND actor_id='synthetic-agent'")).rows[0].n,0);
    }finally{exchange.exchangeRefundRequest=oldExchange;}
    await c.query('ROLLBACK TO SAVEPOINT terminal_recovery_branch');
    // This fixture reproduces a review flag backed only by an otherwise matching, signed observation.
    await c.query(`INSERT INTO zzsh_order.legacy_refund_observation(id,intent_id,attempt_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,
      raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,channel_code,evidence_level,state_before,state_after,request_id)
     SELECT 'synthetic-matching-review',intent_id,NULL,'NOTIFY',NULL,NULL,profile_id,profile_canonical,profile_sha256,key_version_ref,
      raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,'REVIEW',schema_status,signature_status,binding_status,channel_code,evidence_level,'SUCCEEDED','SUCCEEDED','synthetic-matching-review'
     FROM zzsh_order.legacy_refund_observation WHERE id=$1`,[paid.observationId]);
    await c.query('UPDATE zzsh_order.legacy_refund_intent SET requires_review=true,revision=revision+1 WHERE id=$1',[created.body.intentId]);
    try{
     exchange.exchangeRefundRequest=async()=>({body:Buffer.from('good'),responseComplete:true,receivedBytes:4,httpStatus:200,failure:null,evidenceLevel:'PROVIDER_RESPONSE'});
     await expireSyntheticRefund();
     const matching=await resolveLegacyRefundTerminal(execution,created.body.intentId,resolveActor,resolveActor.requestId,'已核对渠道记录','resolve-matching-only',authorizeResolution);
     assert.equal(matching.event,'REVIEW_RESOLVED');assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'SUCCEEDED');
     assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.terminal_review_resolved' AND actor_id='synthetic-agent'")).rows[0].n,1);
    }finally{exchange.exchangeRefundRequest=oldExchange;}
    await c.query('ROLLBACK TO SAVEPOINT terminal_recovery_branch');
    const conflict=await receiveLegacyRefundNotification(execution,created.body.intentId,'conflict','synthetic-conflict');assert.equal(conflict.ack,'fail');
    try{
     exchange.exchangeRefundRequest=async()=>({body:Buffer.from('good'),responseComplete:true,receivedBytes:4,httpStatus:200,failure:null,evidenceLevel:'PROVIDER_RESPONSE'});
     await expireSyntheticRefund();
     const conflictingTerminal=await resolveLegacyRefundTerminal(execution,created.body.intentId,resolveActor,resolveActor.requestId,'已核对渠道记录','resolve-contradiction',authorizeResolution);
     assert.notEqual(conflictingTerminal.event,'REVIEW_RESOLVED');assert.equal((await readLegacyRefundProgress(c,execution,created.body.intentId)).state,'REVIEW_REQUIRED');
     assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1',[state.terminal_event_id])).rows[0].n,2);
    }finally{exchange.exchangeRefundRequest=oldExchange;}
    await c.query('ROLLBACK TO SAVEPOINT success_branch');
    const failed=await receiveLegacyRefundNotification(execution,created.body.intentId,'failure','synthetic-failed');
    assert.equal(failed.terminal?.terminal,'FAILED_NO_EXECUTION');assert.equal(failed.ack,'success');
    assert.equal((await receiveLegacyRefundNotification(execution,created.body.intentId,'failure','synthetic-failed-replay')).ack,'success');
    const failedState=(await c.query('SELECT state,budget_disposition,terminal_event_id FROM zzsh_order.legacy_refund_intent WHERE id=$1',[created.body.intentId])).rows[0];
    assert.equal(failedState.state,'FAILED');assert.equal(failedState.budget_disposition,'RELEASED');assert.equal(failedState.terminal_event_id,null);
    const retryActor={realm:'admin',userId:'synthetic-agent',sessionId:'synthetic-agent-session',requestId:'synthetic-retry-request'};
    const retryAuthorize=async client=>reviewService.authorizeLegacyRefundReviewAccess(client,retryActor,b.id);
    const retryInput={previouslyRefundedCents:'2000',noUnresolvedRefunds:true,reason:'已核对原付款和失败结果'};
    if(concurrency){
     await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('COMMIT');
     const racePool=new Pool({host:'127.0.0.1',port:5432,database,user:'postgres',max:2,statement_timeout:15000});
     let firstPid=0,secondPid=0,openGate,firstReady,secondReady;
     const gate=new Promise(resolve=>{openGate=resolve;}),ready=new Promise(resolve=>{firstReady=resolve;}),connected=new Promise(resolve=>{secondReady=resolve;});
     const makePool=label=>({connect:async()=>{const client=await racePool.connect();return {release:destroy=>client.release(destroy),query:async(sql,args)=>{
      if(sql==='BEGIN'){const result=await client.query(sql);await client.query('SET LOCAL ROLE zzsh_completion_synth_probe');
       const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;if(label==='first')firstPid=pid;else{secondPid=pid;secondReady();}return result;}
      if(label==='first'&&typeof sql==='string'&&sql.includes('SELECT zzsh_order.retry_legacy_refund')){firstReady();await gate;}
      return client.query(sql,args);
     }};}});
     const firstActor={...actor,requestId:'synthetic-race-first'},secondActor={...retryActor,requestId:'synthetic-race-second'};
     const invoke=who=>retryLegacyRefund({...execution,pool:makePool(who==='first'?'first':'second')},created.body.intentId,
      who==='first'?firstActor:secondActor,who==='first'?firstActor.requestId:secondActor.requestId,retryInput,
      client=>reviewService.authorizeLegacyRefundReviewAccess(client,who==='first'?firstActor:secondActor,b.id));
     let first,second;
     try{
      first=invoke('first');await Promise.race([ready,first.then(()=>{throw Error('first retry did not reach lock gate');})]);
      second=invoke('second');await connected;let waited=false;
      for(let attempt=0;attempt<100&&!waited;attempt++){
       waited=(await c.query('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS waiting',[firstPid,secondPid])).rows[0].waiting===true;
       if(!waited)await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.equal(waited,true,'second operator must wait for the first real PostgreSQL transaction');openGate();
      const values=await Promise.all([first,second]);assert.deepEqual(values.map(value=>value.created).sort(),[false,true]);
      assert.equal(values[0].intentId,values[1].intentId);assert.equal(values[0].refundOrderNo,values[1].refundOrderNo);
      const rows=(await c.query('SELECT generation,state,budget_disposition FROM zzsh_order.legacy_refund_intent WHERE case_id=$1 ORDER BY generation',[created.body.caseId])).rows;
      assert.deepEqual(rows,[{generation:1,state:'FAILED',budget_disposition:'RELEASED'},{generation:2,state:'READY',budget_disposition:'ALLOCATED'}]);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_order.legacy_refund_retry_authorization WHERE case_id=$1',[created.body.caseId])).rows[0].n,1);
      console.log('synthetic PostgreSQL concurrent retry: PASS (two authorized operators; one original-key successor)');
     }finally{openGate();await Promise.allSettled([first,second].filter(Boolean));await racePool.end();}
     return;
    }
    await assert.rejects(retryLegacyRefund({...execution,legacyRefundsEnabled:false},created.body.intentId,retryActor,retryActor.requestId,retryInput,retryAuthorize));
    await assert.rejects(retryLegacyRefund(execution,created.body.intentId,retryActor,retryActor.requestId,{...retryInput,previouslyRefundedCents:'2001'},retryAuthorize));
    await assert.rejects(retryLegacyRefund(execution,created.body.intentId,retryActor,retryActor.requestId,{...retryInput,noUnresolvedRefunds:false},retryAuthorize));
    const retry=await retryLegacyRefund(execution,created.body.intentId,retryActor,retryActor.requestId,retryInput,retryAuthorize);
    assert.equal(retry.created,true);assert.notEqual(retry.intentId,created.body.intentId);assert.notEqual(retry.refundOrderNo,created.body.refundOrderNo);
    knownRefundNumbers.add(retry.refundOrderNo);
    const retryAgain=await retryLegacyRefund(execution,created.body.intentId,retryActor,retryActor.requestId,retryInput,retryAuthorize);
    assert.equal(retryAgain.created,false);assert.equal(retryAgain.intentId,retry.intentId);
    assert.equal((await caseService.readLegacyRefundCaseReceipt(c,actor,b.id,refundDuty.id,created.body.caseId)).intentId,created.body.intentId);
    assert.equal((await caseService.readLegacyRefundCaseForStatus(c,b.id,refundDuty.id,created.body.caseId)).intentId,retry.intentId);
    const amounts=(await c.query(`SELECT generation,state,budget_disposition,amount_cents::text FROM zzsh_order.legacy_refund_intent WHERE case_id=$1 ORDER BY generation`,[created.body.caseId])).rows;
    assert.deepEqual(amounts.map(item=>[item.generation,item.state,item.budget_disposition,item.amount_cents]),[[1,'FAILED','RELEASED',created.body.amountCents],[2,'READY','ALLOCATED',created.body.amountCents]]);
    const retrySubmit=await executeLegacyRefund(execution,retry.intentId,'retry-worker');assert.equal(retrySubmit.kind,'OBSERVED');assert.equal(retrySubmit.event,'PROCESSING');
    await c.query('SAVEPOINT pending_terminal_recovery');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query(`INSERT INTO zzsh_order.legacy_refund_observation(id,intent_id,attempt_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,
      raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,channel_code,evidence_level,state_before,state_after,request_id)
     SELECT 'matching-prior-review',intent_id,NULL,'NOTIFY',NULL,NULL,profile_id,profile_canonical,profile_sha256,key_version_ref,
      raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,'REVIEW',schema_status,signature_status,binding_status,channel_code,evidence_level,'FAILED','FAILED','matching-prior-review'
     FROM zzsh_order.legacy_refund_observation WHERE id=$1`,[failed.observationId]);
    await c.query('UPDATE zzsh_order.legacy_refund_intent SET requires_review=true,revision=revision+1 WHERE id=$1',[created.body.intentId]);
    await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
    const pendingNotice=await receiveLegacyRefundNotification(execution,retry.intentId,'good','pending-retry-notice');assert.equal(pendingNotice.event,'REVIEW');
    try{
     let body='failure';exchange.exchangeRefundRequest=async()=>({body:Buffer.from(body),responseComplete:true,receivedBytes:body.length,httpStatus:200,failure:null,evidenceLevel:'PROVIDER_RESPONSE'});
     await expireSyntheticRefund();
     const priorResolved=await resolveLegacyRefundTerminal(execution,created.body.intentId,resolveActor,resolveActor.requestId,'已核对原退款','resolve-prior-match',authorizeResolution);
     assert.equal(priorResolved.event,'REVIEW_RESOLVED');
     await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
     await c.query("UPDATE zzsh_order.legacy_refund_intent SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[retry.intentId]);
     await c.query("UPDATE zzsh_order.legacy_refund_attempt SET created_at=clock_timestamp()-interval '1 minute' WHERE intent_id=$1",[retry.intentId]);
     await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
     body='good';const pendingResolved=await resolveLegacyRefundTerminal(execution,retry.intentId,resolveActor,resolveActor.requestId,'已核对后续退款','resolve-successor',authorizeResolution);
     assert.equal(pendingResolved.event,'REVIEW_RESOLVED');assert.equal(pendingResolved.terminal?.terminal,'SUCCEEDED');
     assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.finance_event WHERE kind='LEGACY_REFUND_PAID'")).rows[0].n,1);
     assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.legacy_refund_attempt WHERE intent_id=$1 AND operation='SUBMIT'",[retry.intentId])).rows[0].n,1);
    }finally{exchange.exchangeRefundRequest=oldExchange;}
    await c.query('ROLLBACK TO SAVEPOINT pending_terminal_recovery');
    const lateConflict=await receiveLegacyRefundNotification(execution,created.body.intentId,'conflict','synthetic-old-conflict');assert.equal(lateConflict.event,'REVIEW');
    assert.deepEqual((await caseService.readLegacyRefundCaseForStatus(c,b.id,refundDuty.id,created.body.caseId)).blockedBy,
     {intentId:created.body.intentId,refundOrderNo:created.body.refundOrderNo,generation:1});
    assert.equal((await readLegacyRefundProgress(c,execution,retry.intentId)).state,'REVIEW_REQUIRED');
    assert.equal((await executeLegacyRefund(execution,retry.intentId,'retry-worker-2')).reason,'PREVIOUS_ATTEMPT_REVIEW');
    const retryNotice=await receiveLegacyRefundNotification(execution,retry.intentId,'good','synthetic-retry-notice');assert.equal(retryNotice.event,'REVIEW');assert.equal(retryNotice.terminal,null);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.finance_event WHERE kind='LEGACY_REFUND_PAID'")).rows[0].n,0);
   }finally{refundProfile.assertInitialRefundAdmission=oldInitial;refundProfile.produceRefundRequest=oldProduce;refundProfile.readRefundOutbound=oldOutbound;
    refundProfile.readFormalRefundAdmission=oldAdmission;refundProfile.inspectRefundProfile=oldInspect;refundProfile.refundCompleteTimeToUtc=oldTime;
    refundProfile.refundFailureMayRelease=oldFailure;protocol.preflightJoinpayRefundResponse=oldPreflight;}
   await c.query('ROLLBACK TO SAVEPOINT worker_prepare');
   await c.query('ROLLBACK TO SAVEPOINT refund_case_command');
  }finally{refundProfile.assertFormalRefundProfile=oldProfile;refundProfile.describeRefundProfile=oldDescription;refundProfile.readRefundProfileEvidence=oldEvidence;refundProfile.assertRefundStart=oldStart;refundProfile.assertRefundBinding=oldBinding;refundStore.assertRefundResource=oldResource;}
  await c.query('ROLLBACK TO SAVEPOINT admin_flow');
  for(const classification of ['COMPLETED_UNREFUNDED','DETAINED']){
   await c.query('SAVEPOINT historical_refund_branch');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   const source={id:b.legacyId,order_sn:'SYNTHETIC_ORDER',accounts_id:b.legacyAccountId,user_id:b.legacyRenterId,sale_user_id:b.legacyOwnerId,
    order_status:'4',pay_is:'1',is_delete:'0',is_settle:classification==='DETAINED'?'2':'0',return_order_money:'50.00',detain_money:'0.00'};
   const sourceCanonical=canonicalize(source),sourceDigest=sha(sourceCanonical),dutyId=model.legacyEconomicDutyId(b.id,'RENTER_REFUND',b.legacyId);
   await c.query('DELETE FROM zzsh_order.legacy_order_duty WHERE order_id=$1',[b.id]);
   await c.query('DELETE FROM zzsh_order.legacy_continuation_evidence WHERE order_id=$1',[b.id]);
   await c.query(`UPDATE zzsh_order.legacy_order_read_snapshot SET source_order_status=4,source_completed_at=clock_timestamp()-interval '1 day',
     source_snapshot=$2::jsonb,source_digest=$3 WHERE id=$1`,[b.id,sourceCanonical,sourceDigest]);
   await c.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_status,source_digest)
    VALUES($1,$2,'RENTER_REFUND',$3,$4,5000,'CNY','PENDING','LEGACY_IMPORT',$5,$6)`,[dutyId,b.id,b.legacyId,b.renterUserId,classification,sourceDigest]);
   await c.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,action,object_type,object_id,outcome,occurred_at,details)
    VALUES('historical-liability','system','order.legacy.liability.import','rental_order',$1,'SUCCESS',clock_timestamp(),$2::jsonb)`,
    [b.id,JSON.stringify({dutyId,classification,parentSourceDigest:sourceDigest,settlementRecord:{canonical:sourceCanonical,digest:sourceDigest}})]);
   const payment={kind:'paymentObservation',sourceUserId:Number(b.legacyRenterId),sourceId:9,sourceStatus:1,channelArrival:'UNKNOWN',
    createdAt:1790000000,amount:'100.00',sourceNumber:'FIXTURE_P7',sourceOrderType:'1',referenceType:'LEGACY_ORDER',referenceId:b.legacyId,associationState:'SOURCE_VERIFIED'};
   const paymentCanonical=canonicalize(payment);
   await c.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,source_kind,source_type,source_system,legacy_user_id,
    source_entity,source_id,source_digest,source_canonical,included_in_opening,snapshot)
    VALUES('historic-payment',$1,'HISTORICAL_PAYMENT','LEGACY_MYSQL','legacy_mysql_restore',$2,'la_pay_order','9',$3,$4::text,false,$4::text::jsonb)`,
    [b.renterUserId,b.legacyRenterId,sha(paymentCanonical),paymentCanonical]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
   await setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
   refundProfile.assertFormalRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',reference:'synthetic-admission',sha256:sha(admissionText),canonical:admissionText});
   refundProfile.describeRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',profileSha256:sha(profileText),keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
   refundProfile.readRefundProfileEvidence=()=>profileText;refundProfile.assertRefundStart=()=>{};refundProfile.assertRefundBinding=()=>{};refundStore.assertRefundResource=async()=> '1';
   try{
    const service=require('../dist/src/order/legacy-refund-case-command.js');
    const request={orderId:b.id,dutyId,expectedDutyRevision:'1',expectedHeadRevision:'0',paymentOrderNo:'FIXTURE_P7',confirmedMerchantNo:'12345',
     paidCents:'10000',previouslyRefundedCents:'0',priorAppliedToDutyCents:'0',noUnresolvedRefunds:true,evidenceRef:'已核对旧站与合成渠道'};
    await assert.rejects(service.createLegacyRefundCase(c,actor,request,{admission:{},profile:{}}));
    if(classification==='DETAINED')await assert.rejects(service.createLegacyRefundCase(c,actor,{...request,historicalDueVerified:true},{admission:{},profile:{}}));
    const receipt=await service.createLegacyRefundCase(c,actor,{...request,historicalDueVerified:true,
     ...(classification==='DETAINED'?{historicalReleaseVerified:true}:{})},{admission:{},profile:{}});
    assert.equal(receipt.body.amountCents,'5000');assert.equal(receipt.body.channelResultAtCreation,'NOT_SUBMITTED');
    assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.finance_event WHERE kind='LEGACY_REFUND_PAID'")).rows[0].n,0);
    const reviewed=(await c.query(`SELECT details FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.reviewed' AND object_id=$1`,[dutyId])).rows[0].details;
    assert.equal(reviewed.historicalDueVerified,true);assert.equal(reviewed.historicalReleaseVerified===true,classification==='DETAINED');
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
   }finally{refundProfile.assertFormalRefundProfile=oldProfile;refundProfile.describeRefundProfile=oldDescription;refundProfile.readRefundProfileEvidence=oldEvidence;refundProfile.assertRefundStart=oldStart;refundProfile.assertRefundBinding=oldBinding;refundStore.assertRefundResource=oldResource;}
   await c.query('ROLLBACK TO SAVEPOINT historical_refund_branch');
  }
  const renter={realm:'user',userId:b.renterUserId,sessionId:'user-session-'+b.legacyRenterId,requestId:'synthetic-renter-request'};
  const owner={realm:'user',userId:b.ownerUserId,sessionId:'user-session-'+b.legacyOwnerId,requestId:'synthetic-owner-request'};
  async function confirmAsParties(autoCredit=true){
   await setAuditContext(c,'user',renter.userId,renter.sessionId,renter.requestId);
   const userProposal=calc.planVerifiedLegacySettlement(original.facts.evidence,{kind:'propose',caller:{role:'renter',legacyUserId:b.legacyRenterId},quantities,endReason:'NORMAL',settlementBasis:verifiedBasis},verifiedBasis);assert(userProposal.ok);
   await command.applyLegacyContinuationCommand(c,renter,b.id,command.parseLegacyMutation('propose',{
    expectedRevision:null,inputEvidenceId:original.id,planFingerprint:userProposal.fingerprint,quantities,endReason:'NORMAL'}),readLegacyDutyFinalization);
   await c.query('SET CONSTRAINTS ALL DEFERRED');
   const userHead=await evidence.readLegacyContinuationHead(c,b.id),userEvidence=await evidence.readLegacyContinuationEvidence(c,b.id,userHead);
   const userConfirm=calc.planLegacyContinuation(model.readSealedLegacyFacts(userEvidence).evidence,{kind:'confirm',caller:{role:'owner',legacyUserId:b.legacyOwnerId}});assert(userConfirm.ok);
   const userConfirmInput=command.parseLegacyMutation('confirm',{expectedRevision:userHead.revision,inputEvidenceId:userEvidence.id,planFingerprint:userConfirm.fingerprint});
   await assert.rejects(command.applyLegacyContinuationCommand(c,renter,b.id,userConfirmInput,readLegacyDutyFinalization));
   await setAuditContext(c,'user',owner.userId,owner.sessionId,owner.requestId);
   assert.equal((await command.applyLegacyContinuationCommand(c,owner,b.id,userConfirmInput,readLegacyDutyFinalization,undefined,autoCredit?finance.postLegacyOwnerCreditOnConfirmation:undefined)).body.stage,'4');
   return evidence.readLegacyContinuationDuties(c,b.id);
  }
  const userDuties=await confirmAsParties();
  assert.equal(userDuties.find(d=>d.kind==='OWNER_CREDIT')?.status,'SETTLED');
  const userFact=(await c.query(`SELECT actor_realm,actor_id FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=$1`,[userDuties.find(d=>d.kind==='OWNER_CREDIT').id])).rows[0];
  assert.deepEqual(userFact,{actor_realm:'user',actor_id:owner.userId});
  const userBalance=(await c.query(`SELECT count(*)::int AS n,sum(credit_cents-debit_cents)::text AS amount FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='OWNER_AVAILABLE'`,[b.ownerUserId])).rows[0];
  assert.deepEqual(userBalance,{n:1,amount:userDuties.find(d=>d.kind==='OWNER_CREDIT').amountCents});
  const ownerView=await evidence.readLegacyContinuation(c,owner,b.id,readLegacyDutyFinalization);
  assert.equal(ownerView.continuation.duties.find(d=>d.kind==='OWNER_CREDIT')?.financeVerified,true);
  await c.query('SAVEPOINT missing_finance_fact');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query('DELETE FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=$1',[userDuties.find(d=>d.kind==='OWNER_CREDIT').id]);
  await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
  const unknownView=await evidence.readLegacyContinuation(c,owner,b.id,readLegacyDutyFinalization);
  assert.equal(unknownView.continuation.duties.find(d=>d.kind==='OWNER_CREDIT')?.financeVerified,false);
  await c.query('ROLLBACK TO SAVEPOINT missing_finance_fact');
  await c.query('SAVEPOINT commission_due');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`UPDATE zzsh_order.legacy_continuation_version SET created_at=created_at-interval '8 days',refund_due_at=refund_due_at-interval '8 days' WHERE order_id=$1 AND command='CONFIRM'`,[b.id]);
  await c.query(`UPDATE zzsh_order.legacy_order_duty SET maturity_at=(SELECT created_at+interval '7 days' FROM zzsh_order.legacy_continuation_version WHERE order_id=$1 AND command='CONFIRM') WHERE id=$2`,[b.id,commissionId]);
  await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');await c.query('SET CONSTRAINTS ALL DEFERRED');
  assert.equal((await c.query('SELECT pg_try_advisory_lock(806007::bigint) AS locked')).rows[0].locked,true);workerHeld=true;
  const commissionDue=await finance.settleLegacyCommissionDueOn(c,b.id,commissionId);assert.equal(commissionDue.outcome,'POSTED');
  assert(BigInt(commissionDue.receipt.amountCents)>0n);
  assert.equal((await finance.settleLegacyCommissionDueOn(c,b.id,commissionId)).outcome,'ALREADY_POSTED');
  const dueFact=(await c.query('SELECT actor_realm,actor_id FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=$1',[commissionId])).rows[0];
  assert.deepEqual(dueFact,{actor_realm:'system',actor_id:'legacy-commission-due'});
  const commissionBalance=(await c.query(`SELECT count(*)::int AS n,sum(credit_cents-debit_cents)::text AS amount FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='WALLET_AVAILABLE'`,[b.ownerUserId])).rows[0];
  assert.deepEqual(commissionBalance,{n:1,amount:commissionDue.receipt.amountCents});
  const adminView=await evidence.readLegacyContinuation(c,actor,b.id,readLegacyDutyFinalization);
  assert.equal(adminView.continuation.duties.find(d=>d.id===commissionId)?.financeVerified,true);
  assert.equal((await c.query('SELECT pg_advisory_unlock(806007::bigint) AS released')).rows[0].released,true);workerHeld=false;
  await c.query('ROLLBACK TO SAVEPOINT commission_due');
  await c.query('ROLLBACK TO SAVEPOINT admin_flow');await c.query('RESET ROLE');
  await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`INSERT INTO zzsh_order.finance_covered_event(basis_id,user_id,source_kind,source_type,source_entity,source_id,beneficiary_role,source_event_at,source_digest)
   VALUES('completion-basis',$1,'LEGACY_RENTAL_OWNER_INCOME','LEGACY_MYSQL','la_order',$2,'OWNER','2026-11-01T00:00:00Z',$3)`,[b.ownerUserId,b.legacyId,b.sourceDigest]);
  await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
  const coveredDuties=await confirmAsParties(),deferred=coveredDuties.find(d=>d.kind==='OWNER_CREDIT');
  assert.equal(deferred?.status,'PENDING');
  assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=$1`,[deferred.id])).rows[0].n,0);
  assert.equal((await c.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='order.legacy.owner_credit.deferred'`,[deferred.id])).rows[0].n,1);
  await c.query('ROLLBACK TO SAVEPOINT admin_flow');
  const staleDuties=await confirmAsParties(false),stale=staleDuties.find(d=>d.kind==='OWNER_CREDIT');assert.equal(stale?.status,'PENDING');
  await c.query('SAVEPOINT stale_confirmation');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`UPDATE zzsh_order.legacy_continuation_version SET created_xid='3'::xid8 WHERE order_id=$1 AND command='CONFIRM'`,[b.id]);
  await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
  await setAuditContext(c,'user',owner.userId,owner.sessionId,owner.requestId);
  const staleAuthority=await command.authorizeLegacyMutation(c,owner,b.id);
  await assert.rejects(finance.postLegacyOwnerCreditOnConfirmation(c,owner,b.id,{dutyId:stale.id,expectedRevision:stale.revision},staleAuthority),error=>error.code==='42501');
  await c.query('ROLLBACK TO SAVEPOINT stale_confirmation');
  await c.query('ROLLBACK TO SAVEPOINT admin_flow');
  for(const stage of ['8','9']){
   await c.query('SAVEPOINT imported_proposal');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
   const imported=fixture.legacyEvidence(model.initialLegacyFacts(fixture.legacySource({orderStatus:stage,quantities,saleEarnings:'50.00',returnOrderMoney:'37.00',commissions:[commission]}),[{sourceRecordId:commission.id,canonical:commissionSource,digest:sha(commissionSource),evidenceRef:'synthetic-commission'}]));
   await c.query('UPDATE zzsh_order.legacy_order_read_snapshot SET source_order_status=$2 WHERE id=$1',[b.id,Number(stage)]);
   await c.query(`UPDATE zzsh_order.legacy_continuation_evidence SET parameter_digest=$2,admission=$3,facts=$4::jsonb,facts_canonical=$5,facts_digest=$6 WHERE id=$1`,
    [imported.id,imported.facts.evidence.parameterDigest,imported.facts.evidence.admission,JSON.stringify(imported.facts),imported.factsCanonical,imported.factsDigest]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
   const confirmer=stage==='8'?owner:renter,role=stage==='8'?'owner':'renter',legacyId=stage==='8'?b.legacyOwnerId:b.legacyRenterId;
   const plan=calc.planLegacyContinuation(imported.facts.evidence,{kind:'confirm',caller:{role,legacyUserId:legacyId}});assert(plan.ok);
   await setAuditContext(c,'user',confirmer.userId,confirmer.sessionId,confirmer.requestId);
   const input=command.parseLegacyMutation('confirm',{expectedRevision:null,inputEvidenceId:imported.id,planFingerprint:plan.fingerprint});
   await assert.rejects(command.applyLegacyContinuationCommand(c,confirmer,b.id,input,readLegacyDutyFinalization,undefined,finance.postLegacyOwnerCreditOnConfirmation),/LEGACY_PROPOSAL_RECONFIRM_REQUIRED/);
   assert.equal((await evidence.readLegacyContinuationDuties(c,b.id)).some(d=>d.kind==='OWNER_CREDIT'),false);
   const reject=calc.planLegacyContinuation(imported.facts.evidence,{kind:'reject',caller:{role,legacyUserId:legacyId}});assert(reject.ok);
   const rejected=await command.applyLegacyContinuationCommand(c,confirmer,b.id,command.parseLegacyMutation('reject',{expectedRevision:null,inputEvidenceId:imported.id,planFingerprint:reject.fingerprint}),readLegacyDutyFinalization);
   assert.equal(rejected.body.stage,'3');
   await c.query('ROLLBACK TO SAVEPOINT imported_proposal');
  }
  await c.query('SAVEPOINT completed_commission');await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`UPDATE zzsh_order.legacy_order_read_snapshot SET source_order_status=4,source_completed_at='2026-10-01T00:00:00Z',source_snapshot='{"is_delete":"0","is_settle":"0"}'::jsonb WHERE id=$1`,[b.id]);
  await c.query('DELETE FROM zzsh_order.legacy_continuation_evidence WHERE id=$1',[original.id]);
  await c.query('DELETE FROM zzsh_order.legacy_order_duty WHERE id=$1',[commissionId]);
  await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
  await setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
  const sourceRecord={sourceRecordId:commission.id,canonical:commissionSource,digest:sha(commissionSource),evidenceRef:'synthetic-commission'};
  const cutoff='2026-11-01T00:00:00.000000Z',at='2026-10-01T00:00:00.000000Z';
  const finalAmountEvidenceCanonical=canonicalize({parentSourceDigest:b.sourceDigest,sourceRecordDigest:sourceRecord.digest,beneficiaryLegacyId:commission.beneficiaryId,amountCents:'500',cutoff});
  const timeEvidenceCanonical=canonicalize({parentSourceDigest:b.sourceDigest,sourceRecordDigest:sourceRecord.digest,kind:'COMPLETED_AT',at,sourceValue:at,sourceUnit:'RFC3339_UTC',cutoff});
  await c.query('RESET ROLE');
  if(productionFull)await c.query('SET LOCAL ROLE zzsh_synth_migrator');
  const imported=await evidence.importLegacyCompletedCommission(c,actor,{orderId:b.id,sourceDigest:b.sourceDigest,commission,sourceRecord,cutoff,sourceTimeValue:at,sourceTimeUnit:'RFC3339_UTC',evidenceRef:'synthetic-completed-commission',
   finalAmountEvidenceCanonical,finalAmountEvidenceDigest:sha(finalAmountEvidenceCanonical),timeEvidenceCanonical,time:{kind:'COMPLETED_AT',at,evidenceDigest:sha(timeEvidenceCanonical)}});
  assert.equal(imported.body.admission,'IMPORTED');await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('SET CONSTRAINTS ALL DEFERRED');await c.query('SET LOCAL ROLE zzsh_completion_synth_probe');
  assert.equal((await c.query('SELECT pg_try_advisory_lock(806007::bigint) AS locked')).rows[0].locked,true);workerHeld=true;
  const completedDue=await finance.settleLegacyCommissionDueOn(c,b.id,commissionId);assert.equal(completedDue.outcome,'POSTED');assert.equal(completedDue.receipt.amountCents,'500');
  assert.equal((await finance.settleLegacyCommissionDueOn(c,b.id,commissionId)).outcome,'ALREADY_POSTED');
  assert.equal((await c.query('SELECT pg_advisory_unlock(806007::bigint) AS released')).rows[0].released,true);workerHeld=false;
  await c.query('ROLLBACK TO SAVEPOINT completed_commission');
  await c.query('ROLLBACK');
  console.log('synthetic PostgreSQL legacy confirmation, owner auto-credit and reviewed fallback: PASS');
 }finally{await c.query('ROLLBACK').catch(()=>{});if(workerHeld)await c.query('SELECT pg_advisory_unlock(806007::bigint)').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1});
