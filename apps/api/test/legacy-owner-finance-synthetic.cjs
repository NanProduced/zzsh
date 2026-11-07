// Synthetic owner-only SQL guard test. Imported fixtures are seeded without triggers; all posting guards run normally.
const assert=require('node:assert/strict'),fs=require('node:fs'),{createHash}=require('node:crypto'),{Pool}=require('pg'),Module=require('node:module');
const load=Module._load;Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return load.call(this,name,...args)};
assert.equal(process.env.LEGACY_OWNER_SYNTH_OPT_IN,'1');
const {canonicalize}=require('../dist/src/supply/content-hash.js');
const {readLegacyDutyFundingProof}=require('../dist/src/finance/legacy-duty-funding.js');
const {planLegacyDutyFinalization}=require('../dist/src/finance/legacy-duty-finance.js');
const {setAuditContext}=require('../dist/src/auth/security-core.js');
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_test_order_settlement_closure',user:'postgres',max:2,statement_timeout:10000});
const sha=s=>createHash('sha256').update(s).digest('hex'),empty=sha(''),h='a'.repeat(64),order='legacy_order_'+'a'.repeat(40),dutyId='legacy_duty_'+'b'.repeat(40),commissionId='legacy_duty_'+'c'.repeat(40),refundId='legacy_duty_'+'d'.repeat(40);
const owner='synthetic-owner',renter='synthetic-renter',version='synthetic-confirm',result='synthetic-result',cutoff='2026-11-01T00:00:00.000Z';
(async()=>{
 const c=await pool.connect();let workerLocked=false;try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,
   (pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_test_order_settlement_closure',role:'postgres',oid:process.env.LEGACY_OWNER_SYNTH_OID,
   marker:'zzsh:synthetic-settlement-test:v1',system_id:process.env.LEGACY_OWNER_SYNTH_SYSTEM_ID});
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  for(const id of [owner,renter])await c.query('INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,now(),now())',[id,id+'@example.invalid']);
  await c.query('INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',['synthetic-staff','synthetic-staff@example.invalid']);
  await c.query(`INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at) VALUES('synthetic-staff','ACTIVE',true,now())`);
  await c.query(`INSERT INTO zzsh_auth_admin.session(id,"userId",token,"expiresAt","createdAt","updatedAt")
   VALUES('synthetic-session','synthetic-staff','synthetic-token',clock_timestamp()+interval '1 hour',now(),now())`);
  await c.query(`INSERT INTO zzsh_supply.game(id,code,name) VALUES('game','synthetic-game','synthetic game')`);
  await c.query(`INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES('account',$1,'game')`,[owner]);
  await c.query(`INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,
   account_id,game_id,owner_user_id,renter_user_id,legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_owner_id,owner_source_digest,
   legacy_renter_id,renter_source_digest,source_order_status,source_pay_status,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id)
   VALUES($1,'legacy_mysql_restore','la_order','101',$2,'synthetic','ORIGINAL101','account','game',$3,$4,'9','la_rental_accounts',$2,'22',$2,'11',$2,8,1,'{}'::jsonb,1,$2,'synthetic-staff')`,[order,h,owner,renter]);
  const commissionCanonical=canonicalize({id:'90',order_id:'101',user_id:'22',ratio:'20.00',level:'2',status:'1',earnings:'5.00'}),commissionDigest=sha(commissionCanonical);
  const facts=canonicalize({evidence:{source:{isSettle:'0',returnOrderMoney:'87.00',detainMoney:'5.00'}},amounts:{refundNet:'82.00'},commissionEvidence:[{sourceRecordId:'90',canonical:commissionCanonical,digest:commissionDigest}]}),digest=sha(facts);
  await c.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,derived_from_command_version_id,source_as_of,evidence_ref,source_digest,
   parameter_digest,admission,reasons,facts,facts_canonical,facts_digest) VALUES($1,$2,2,'DERIVED',$6,now(),'synthetic',$3,$3,'PARAMETER_COMPLETE','[]'::jsonb,$4::text::jsonb,$4::text,$5)`,[result,order,h,facts,digest,version]);
  await c.query(`INSERT INTO zzsh_order.legacy_continuation_version(id,order_id,revision,command,actor,input_evidence_id,result_evidence_id,stage,is_settle,
   is_advance_set,amounts,commission_revisions,plan_fingerprint,created_at,refund_policy_revision,refund_wait_days,refund_due_at)
   VALUES($1,$2,1,'CONFIRM','{}'::jsonb,'synthetic-before',$3,4,0,0,'{}'::jsonb,'[]'::jsonb,$4,'2026-10-01T00:00:00Z',1,0,'2026-10-01T00:00:00Z')`,[version,order,result,h]);
  await c.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,continuation_version_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_digest)
   VALUES($1,$2,$3,'OWNER_CREDIT',$3,$4,1000,'CNY','PENDING','CONTINUATION',$5)`,[dutyId,order,version,owner,h]);
  await c.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,continuation_version_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_status,level,ratio,maturity_at,source_digest,revision)
   VALUES($1,$2,$3,'COMMISSION','90',$4,500,'CNY','MATURED','LEGACY_IMPORT','1',2,20,'2026-10-08T00:00:00Z',$5,3)`,[commissionId,order,version,owner,h]);
  await c.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,continuation_version_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_digest)
   VALUES($1,$2,$3,'RENTER_REFUND',$3,$4,8200,'CNY','PENDING','CONTINUATION',$5)`,[refundId,order,version,renter,h]);
  await c.query(`INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,
   available_cents,source_cutoff,covered_count,covered_set_digest) VALUES('synthetic-basis',$1,'LEGACY_OPENING','legacy_mysql_restore','la_user','22',$2,$2,0,$3,0,$4)`,[owner,h,cutoff,empty]);
  await c.query(`INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id) VALUES($1,'RECONCILED_OPENING','synthetic-basis','synthetic-opening')`,[owner]);
  await c.query(`INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES($1,0,0)`,[owner]);
  await c.query(`INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,
   available_cents,source_cutoff,covered_count,covered_set_digest) VALUES('synthetic-renter-basis',$1,'LEGACY_OPENING','legacy_mysql_restore','la_user','11',$2,$2,0,$3,0,$4)`,[renter,h,cutoff,empty]);
  await c.query(`INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id) VALUES($1,'RECONCILED_OPENING','synthetic-renter-basis','synthetic-renter-opening')`,[renter]);
  await c.query(`INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES($1,0,0)`,[renter]);
  await c.query(`INSERT INTO zzsh_order.personal_finance_observation_coverage(id,user_id,source_system,legacy_user_id,source_kind,source_entity,source_cutoff,
   input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,source_canonical)
   VALUES('synthetic-history',$1,'legacy_mysql_restore','22','HISTORICAL_EARNINGS_LOG','la_log_earnings',$2,$3,$3,0,0,0,$4,$4,$4,$3,'{}')`,[owner,cutoff,h,empty]);
  await c.query(`INSERT INTO zzsh_order.personal_finance_observation_coverage(id,user_id,source_system,legacy_user_id,source_kind,source_entity,source_cutoff,
   input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,source_canonical)
   VALUES('synthetic-renter-history',$1,'legacy_mysql_restore','11','HISTORICAL_EARNINGS_LOG','la_log_earnings',$2,$3,$3,0,0,0,$4,$4,$4,$3,'{}')`,[renter,cutoff,h,empty]);
  await c.query(`INSERT INTO zzsh_order.legacy_duty_finance_contract(singleton,contract_version,enabled,approval_ref,approval_digest)
   VALUES(true,'legacy-duty-finance.v1',true,'runtime:legacy-finance-duty:v1',$1)`,[sha('runtime:legacy-finance-duty:v1')]);
  await c.query("SET LOCAL session_replication_role='origin'");await setAuditContext(c,'admin','synthetic-staff','synthetic-session','synthetic-request');
  const duty={id:dutyId,orderId:order,kind:'OWNER_CREDIT',sourceRecordId:version,counterpartyUserId:owner,amountCents:'1000',currency:'CNY',revision:'1',status:'PENDING',source:'CONTINUATION',sourceStatus:null,continuationVersionId:version,admissionId:null,maturityAt:null,settledBy:null,settledRefType:null,settledRefId:null,settledRefDigest:null};
  const basis={kind:'CONFIRMED_CONTINUATION',dutyId,orderId:order,dutyKind:'OWNER_CREDIT',sourceRecordId:version,subjectId:owner,amountCents:'1000',currency:'CNY',dutyRevision:'1',parentSourceDigest:h,parentSourceId:'101',sourceRecordEntity:'legacy_continuation_version',sourceRecordDigest:digest,basisFactsDigest:digest,evidenceId:result,evidenceDigest:digest,continuationVersionId:version,admissionId:null,effectiveHeadId:version,effectiveHeadRevision:'1',sourceTimeKind:'CONFIRMED_AT',sourceTime:'2026-10-01T00:00:00.000000Z',maturityAt:null,finalAmountKnown:true,netRefundKnown:true,currentNetRefundCents:null,fundsDisposition:'AVAILABLE'};
  await c.query('SAVEPOINT previously_covered');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`INSERT INTO zzsh_order.finance_covered_event(basis_id,user_id,source_kind,source_type,source_entity,source_id,beneficiary_role,source_event_at,source_digest)
   VALUES('synthetic-basis',$1,'LEGACY_RENTAL_OWNER_INCOME','LEGACY_MYSQL','la_order','101','OWNER',$2,$3)`,[owner,cutoff,h]);
  await c.query("SET LOCAL session_replication_role='origin'");
  assert.deepEqual(await readLegacyDutyFundingProof(c,duty,basis),{knowledge:'UNKNOWN',reason:'LEGACY_RESPONSIBILITY_ALREADY_IN_STORED'});
  await c.query('ROLLBACK TO SAVEPOINT previously_covered');
  const proof=await readLegacyDutyFundingProof(c,duty,basis);assert.equal(proof.knowledge,'KNOWN');
  const plan=planLegacyDutyFinalization(duty,basis,proof.proof,{dutyId,expectedRevision:'1',expectedEvidenceDigest:digest,expectedAmountCents:'1000'},'2026-11-07T00:00:00.000000Z');
  const lock=BigInt('0x'+sha(order).slice(0,15)).toString();await c.query('SELECT pg_advisory_xact_lock($1::bigint)',[lock]);
  await c.query('SAVEPOINT runtime_posting');
  await c.query(fs.readFileSync('migrations/business/0169_legacy_finance_duty_runtime.sql','utf8'));
  await c.query('CREATE ROLE zzsh_owner_runtime_probe NOLOGIN');
  const {applyRuntimePrivileges}=require('../dist/src/database/business-migrations.js');
  await applyRuntimePrivileges({query:(...args)=>c.query(...args)},'zzsh_owner_runtime_probe');
  assert.equal((await c.query("SELECT has_function_privilege('zzsh_owner_runtime_probe','zzsh_order.post_legacy_finance_duty(text,text,text)','EXECUTE') AS allowed")).rows[0].allowed,true);
  assert.equal((await c.query("SELECT has_table_privilege('zzsh_owner_runtime_probe','zzsh_order.legacy_duty_finance_fact','INSERT') AS allowed")).rows[0].allowed,false);
  const refund={...duty,id:refundId,kind:'RENTER_REFUND',counterpartyUserId:renter,amountCents:'8200'};
  const refundBasis={...basis,dutyId:refundId,dutyKind:'RENTER_REFUND',subjectId:renter,amountCents:'8200',currentNetRefundCents:'8200'};
  const refundProof=await readLegacyDutyFundingProof(c,refund,refundBasis);assert.equal(refundProof.knowledge,'KNOWN');
  const refundPlan=planLegacyDutyFinalization(refund,refundBasis,refundProof.proof,{dutyId:refundId,expectedRevision:'1',expectedEvidenceDigest:digest,expectedAmountCents:'8200'},'2026-11-07T00:00:00.000000Z');
  for(const future of [true,false]){
   await c.query('SAVEPOINT refund_liability');
   if(future){await c.query("SET LOCAL session_replication_role='replica'");await c.query("UPDATE zzsh_order.legacy_continuation_version SET refund_wait_days=100,refund_due_at=created_at+interval '100 days' WHERE id=$1",[version]);await c.query("SET LOCAL session_replication_role='origin'");}
   await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
   const posting=c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3)',[refundPlan.canonical,canonicalize(refundProof.proof),'核对租客退款责任']);
   if(future)await assert.rejects(posting,e=>e.code==='23514');else{
    await posting;await c.query('RESET ROLE');
    const liability=(await c.query("SELECT sum(credit_cents-debit_cents)::text AS amount FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='RENTER_REFUND_PAYABLE'",[renter])).rows[0];
    assert.equal(liability.amount,'8200');
    const {readAdminLegacyDutyFinances}=require('../dist/src/finance/legacy-duty-finance-store.js');
    const readback=(await readAdminLegacyDutyFinances(c,{dutyId:refundId})).get(refundId);assert.equal(readback.knowledge,'KNOWN');assert.equal(readback.amountCents,'8200');
   }
   await c.query('ROLLBACK TO SAVEPOINT refund_liability');
  }
  const commission={...duty,id:commissionId,kind:'COMMISSION',sourceRecordId:'90',amountCents:'500',status:'MATURED',source:'LEGACY_IMPORT',sourceStatus:'1',revision:'3',maturityAt:'2026-10-08T00:00:00.000000Z'};
  const commissionBasis={...basis,dutyId:commissionId,dutyKind:'COMMISSION',sourceRecordId:'90',amountCents:'500',dutyRevision:'3',sourceRecordEntity:'la_distribution_order',sourceRecordDigest:commissionDigest,maturityAt:commission.maturityAt};
  const commissionProof=await readLegacyDutyFundingProof(c,commission,commissionBasis);assert.equal(commissionProof.knowledge,'KNOWN');
  const commissionPlan=planLegacyDutyFinalization(commission,commissionBasis,commissionProof.proof,{dutyId:commissionId,expectedRevision:'3',expectedEvidenceDigest:digest,expectedAmountCents:'500'},'2026-11-07T00:00:00.000000Z');
  const workerService=require('../dist/src/order/legacy-finance-duty.js');
  await assert.rejects(workerService.settleLegacyCommissionDueOn(c,order,commissionId),e=>e.status===503);
  await c.query('SAVEPOINT worker_lock_required');
  const workerRequest='legacy-due-'+sha(commissionId).slice(0,40);
  await setAuditContext(c,'system','legacy-commission-due','system',workerRequest);await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
  await assert.rejects(c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3)',[commissionPlan.canonical,canonicalize(commissionProof.proof),'佣金到期自动入账']),e=>e.code==='42501');
  await c.query('ROLLBACK TO SAVEPOINT worker_lock_required');
  assert.equal((await c.query('SELECT pg_try_advisory_lock(806007::bigint) AS locked')).rows[0].locked,true);workerLocked=true;
  const rival=await pool.connect();try{assert.equal((await rival.query('SELECT pg_try_advisory_lock(806007::bigint) AS locked')).rows[0].locked,false);}finally{rival.release();}
  await c.query('SAVEPOINT worker_request_required');await setAuditContext(c,'system','legacy-commission-due','system','wrong-request');await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
  await assert.rejects(c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3)',[commissionPlan.canonical,canonicalize(commissionProof.proof),'佣金到期自动入账']),e=>e.code==='42501');
  await c.query('ROLLBACK TO SAVEPOINT worker_request_required');
  for(const canRead of [false,true]){
   await c.query('SAVEPOINT commission_post');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query("UPDATE zzsh_iam.admin_security SET is_boss=false WHERE admin_user_id='synthetic-staff'");
   await c.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES
    ('synthetic-staff','order.legacy.continue','ALLOW'),('synthetic-staff','order.settlement.write','ALLOW')`);
   if(canRead)await c.query("INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES('synthetic-staff','finance.document.read','ALLOW')");
   await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
   const posting=c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3)',[commissionPlan.canonical,canonicalize(commissionProof.proof),'核对佣金后入账']);
   if(!canRead)await assert.rejects(posting,e=>e.code==='42501');else{
    await posting;await c.query('RESET ROLE');
    const credited=(await c.query("SELECT sum(credit_cents-debit_cents)::text AS balance FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='WALLET_AVAILABLE'",[owner])).rows[0];
    assert.equal(credited.balance,'500');
    const {readAdminLegacyDutyFinances,readLegacyCommissionFinance,readLegacyCommissionResponsibility}=require('../dist/src/finance/legacy-duty-finance-store.js');
    const readback=(await readAdminLegacyDutyFinances(c,{dutyId:commissionId})).get(commissionId);assert.equal(readback.knowledge,'KNOWN');assert.equal(readback.amountCents,'500');
    const own=(await readLegacyCommissionFinance(c,owner,['90'])).get('90');assert.equal(own.knowledge,'KNOWN');assert.equal(own.state,'SETTLED');assert.equal(own.amountCents,'500');
    const responsibility=(await readLegacyCommissionResponsibility(c,owner,['90'])).get('90');assert.equal(responsibility.knowledge,'KNOWN');assert.equal(responsibility.state,'SETTLED');
   }
   await c.query('ROLLBACK TO SAVEPOINT commission_post');
  }
  for(const testCase of [{scope:true,deny:false,allowed:true},{scope:false,deny:false,allowed:false},{scope:true,deny:true,allowed:false}]){
   await c.query('SAVEPOINT support_case');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query("UPDATE zzsh_iam.admin_security SET is_boss=false,game_scope_mode='SELECTED_GAMES' WHERE admin_user_id='synthetic-staff'");
   await c.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect)
    VALUES('synthetic-staff','order.legacy.continue','ALLOW'),('synthetic-staff','order.settlement.write',$1)`,[testCase.deny?'DENY':'ALLOW']);
   if(testCase.scope)await c.query("INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES('synthetic-staff','game','synthetic-staff')");
   await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
   const posting=c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3)',[plan.canonical,canonicalize(proof.proof),'核对订单后入账']);
   if(testCase.allowed)await posting;else await assert.rejects(posting,e=>e.code==='42501');
   await c.query('ROLLBACK TO SAVEPOINT support_case');
  }
  await c.query('SAVEPOINT service_posting');
  const evidence=require('../dist/src/order/legacy-continuation-evidence.js'),basisReader=require('../dist/src/order/legacy-duty-basis.js');
  const originalUsers=evidence.readLegacyContinuationUserIds,originalBasis=basisReader.readLegacyDutyBasis;
  try{
   const userIds=[owner,renter].sort();evidence.readLegacyContinuationUserIds=async()=>userIds;
   basisReader.readLegacyDutyBasis=async(_client,_order,current)=>({state:'KNOWN',dutyId:current.id,orderId:order,kind:current.kind,beneficiaryUserId:owner,amountCents:current.amountCents,currency:'CNY',
    parentSourceDigest:h,parentSourceId:'101',sourceRecordEntity:'legacy_continuation_version',sourceRecordDigest:digest,basisFactsDigest:digest,effectiveFactsDigest:digest,
    continuationVersionId:version,admissionId:null,basisEvidenceId:result,revision:'1',maturityAt:null,sourceTimeKind:'CONFIRMED_AT',sourceTime:'2026-10-01T00:00:00.000000Z',
    effectiveHeadId:version,effectiveHeadRevision:'1',currentNetRefundCents:null,sourceIsSettle:'0',fundsDisposition:'AVAILABLE',
    ...(current.kind==='COMMISSION'?{revision:'3',maturityAt:'2026-10-08T00:00:00.000000Z',sourceRecordEntity:'la_distribution_order',sourceRecordDigest:commissionDigest}: {})});
   const serviceClient={query:(sql,args)=>sql.includes('SELECT id FROM zzsh_supply.rental_account WHERE')?Promise.resolve({rows:[{id:'account'}],rowCount:1}):c.query(sql,args)};
   const service=require('../dist/src/order/legacy-finance-duty.js'),actor={realm:'admin',userId:'synthetic-staff',sessionId:'synthetic-session',requestId:'synthetic-request'};
   const authority={actor,binding:{id:order,accountId:'account',ownerUserId:owner,renterUserId:renter,sourceDigest:h},userIds,financeDutyKind:'OWNER_CREDIT'};
   await c.query('SAVEPOINT due_future');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query("UPDATE zzsh_order.legacy_order_duty SET status='PENDING',revision=2,maturity_at=clock_timestamp()+interval '1 day' WHERE id=$1",[commissionId]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
   assert.equal((await service.settleLegacyCommissionDueOn(c,order,commissionId)).outcome,'NOT_DUE');
   assert.equal((await c.query('SELECT status FROM zzsh_order.legacy_order_duty WHERE id=$1',[commissionId])).rows[0].status,'PENDING');
   await c.query('ROLLBACK TO SAVEPOINT due_future');
   await c.query('SAVEPOINT due_service');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query("UPDATE zzsh_order.legacy_order_duty SET status='PENDING',revision=2 WHERE id=$1",[commissionId]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
   const due=await service.settleLegacyCommissionDueOn(c,order,commissionId);assert.equal(due.outcome,'POSTED');
   const retry=await service.settleLegacyCommissionDueOn(c,order,commissionId);assert.equal(retry.outcome,'ALREADY_POSTED');
   const autoFact=(await c.query('SELECT actor_realm,actor_id FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=$1',[commissionId])).rows[0];
   assert.deepEqual(autoFact,{actor_realm:'system',actor_id:'legacy-commission-due'});
   await c.query('ROLLBACK TO SAVEPOINT due_service');
   await c.query('SAVEPOINT due_covered');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query("UPDATE zzsh_order.legacy_order_duty SET status='PENDING',revision=2 WHERE id=$1",[commissionId]);
   await c.query(`INSERT INTO zzsh_order.finance_covered_event(basis_id,user_id,source_kind,source_type,source_entity,source_id,beneficiary_role,source_event_at,source_digest)
    VALUES('synthetic-basis',$1,'LEGACY_DISTRIBUTION_EARNING','LEGACY_MYSQL','la_distribution_order','90','RENTER_REFERRAL',$2,$3)`,[owner,cutoff,commissionDigest]);
   await c.query("SET LOCAL session_replication_role='origin'");await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
   assert.equal((await service.settleLegacyCommissionDueOn(c,order,commissionId)).outcome,'REVIEW_REQUIRED');
   assert.equal((await service.settleLegacyCommissionDueOn(c,order,commissionId)).outcome,'REVIEW_REQUIRED');
   assert.equal((await c.query("SELECT status FROM zzsh_order.legacy_order_duty WHERE id=$1",[commissionId])).rows[0].status,'MATURED');
   assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=$1",[commissionId])).rows[0].n,0);
   assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.legacy.commission.deferred' AND object_id=$1",[commissionId])).rows[0].n,1);
   await c.query('ROLLBACK TO SAVEPOINT due_covered');
   await c.query('SAVEPOINT due_page_service');await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
   const pageClient={query:async(sql,args)=>{
    if(sql==='BEGIN READ ONLY'||sql==='BEGIN')return c.query('SAVEPOINT synthetic_page_transaction');
    if(sql==='COMMIT')return c.query('RELEASE SAVEPOINT synthetic_page_transaction');
    if(sql==='ROLLBACK'){await c.query('ROLLBACK TO SAVEPOINT synthetic_page_transaction');return c.query('RELEASE SAVEPOINT synthetic_page_transaction');}
    return c.query(sql,args);
   }};
   const {runLegacyCommissionDuePage}=require('../dist/src/finance/legacy-commission-due-worker.js');
   const page=await runLegacyCommissionDuePage(pageClient,null,5);assert.equal(page.scanned,1);assert.equal(page.posted,1);assert.equal(page.deferred,0);
   assert.equal((await c.query('SELECT status FROM zzsh_order.legacy_order_duty WHERE id=$1',[commissionId])).rows[0].status,'SETTLED');
   await c.query('ROLLBACK TO SAVEPOINT due_page_service');
   await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
   const receipt=await service.postLegacyFinanceDuty(serviceClient,actor,order,'OWNER_CREDIT',{dutyId,expectedRevision:'1',reason:'核对订单后入账'},authority);
   assert.equal(receipt.body.amountCents,'1000');assert.equal(receipt.body.status,'SETTLED');
   assert.deepEqual(await service.projectLegacyFinanceDutyReceipt(serviceClient,order,'OWNER_CREDIT',receipt.body),receipt.body);
   const commissionAuthority={...authority,financeDutyKind:'COMMISSION'};
   const commissionReceipt=await service.postLegacyFinanceDuty(serviceClient,actor,order,'COMMISSION',{dutyId:commissionId,expectedRevision:'3',reason:'核对佣金后入账'},commissionAuthority);
   assert.equal(commissionReceipt.body.amountCents,'500');assert.equal(commissionReceipt.body.status,'SETTLED');
   assert.deepEqual(await service.projectLegacyFinanceDutyReceipt(serviceClient,order,'COMMISSION',commissionReceipt.body),commissionReceipt.body);
  }finally{evidence.readLegacyContinuationUserIds=originalUsers;basisReader.readLegacyDutyBasis=originalBasis;await c.query('ROLLBACK TO SAVEPOINT service_posting');}
  await c.query('SAVEPOINT unauthorized');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query("UPDATE zzsh_iam.admin_security SET is_boss=false WHERE admin_user_id='synthetic-staff'");await c.query("SET LOCAL session_replication_role='origin'");
  await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
  await assert.rejects(c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3)',[plan.canonical,canonicalize(proof.proof),'核对订单后入账']),e=>e.code==='42501');
  await c.query('ROLLBACK TO SAVEPOINT unauthorized');await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
  await c.query('SAVEPOINT missing_reason');
  await assert.rejects(c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3)',[plan.canonical,canonicalize(proof.proof),null]),e=>e.code==='23514');
  await c.query('ROLLBACK TO SAVEPOINT missing_reason');
  const posted=(await c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3) AS result',[plan.canonical,canonicalize(proof.proof),'核对订单后入账'])).rows[0].result;
  assert.equal(posted.dutyId,dutyId);assert.equal(posted.amountCents,'1000');assert.equal(posted.reference.digest,plan.factDigest);
  await c.query('RESET ROLE');
  const runtimeState=(await c.query(`SELECT (SELECT sum(credit_cents-debit_cents)::text FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='OWNER_AVAILABLE') AS balance,
   (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE action='order.legacy.owner_credit.posted' AND object_id=$2) AS audits`,[owner,dutyId])).rows[0];
  assert.deepEqual(runtimeState,{balance:'1000',audits:1});
  const {readAdminLegacyDutyFinances}=require('../dist/src/finance/legacy-duty-finance-store.js');
  const readback=(await readAdminLegacyDutyFinances(c,{dutyId})).get(dutyId);
  assert.equal(readback.knowledge,'KNOWN');assert.equal(readback.finalization,'POSTED');assert.equal(readback.amountCents,'1000');assert.equal(readback.reference.digest,plan.factDigest);
  await c.query('SAVEPOINT runtime_duplicate');await c.query('SET LOCAL ROLE zzsh_owner_runtime_probe');
  await assert.rejects(c.query('SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3)',[plan.canonical,canonicalize(proof.proof),'核对订单后入账']));
  await c.query('ROLLBACK TO SAVEPOINT runtime_duplicate');
  await c.query('ROLLBACK TO SAVEPOINT runtime_posting');
  await c.query('SET CONSTRAINTS ALL DEFERRED');
  await c.query(`INSERT INTO zzsh_order.legacy_duty_finance_fact(duty_id,order_id,root_id,event_id,subject_user_id,kind,amount_cents,currency,duty_revision,effective_head_id,effective_head_revision,parent_source_digest,source_record_digest,basis_facts_digest,effective_facts_digest,zero_finalization,ref_type,ref_id,facts_canonical,facts_digest,funding_canonical,funding_digest,approval_ref,attempt,actor_id,session_id,request_id)
   VALUES($1,$2,$3,$4,$5,'OWNER_CREDIT',1000,'CNY',1,$6,1,$7,$8,$8,$8,false,$9,$10,$11,$12,$13,$14,'synthetic-only','synthetic-attempt','synthetic-staff','synthetic-session','synthetic-request')`,
   [dutyId,order,plan.rootId,plan.eventId,owner,version,h,digest,plan.ref.type,plan.ref.id,plan.canonical,plan.factDigest,canonicalize(proof.proof),sha(canonicalize(proof.proof))]);
  await c.query(`INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,source_digest)
   VALUES($1,NULL,'LEGACY_CONTINUATION_DUTY','LEGACY_CONTINUATION','zzsh','legacy_order_duty',$2,$3,'OWNER_CREDIT',$4)`,[plan.rootId,dutyId,owner,plan.factDigest]);
  await c.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES($1,$2,'LEGACY_DUTY_SETTLED',$3,0)`,[plan.eventId,plan.rootId,owner]);
  for(const line of plan.lines)await c.query(`INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[line.id,plan.eventId,line.line,line.account,line.debit,line.credit,line.subject,JSON.stringify({legacyDutyId:dutyId,legacyOrderId:order,legacyOrderNumber:'ORIGINAL101',factsDigest:plan.factDigest})]);
  await c.query(`UPDATE zzsh_order.legacy_order_duty SET status='SETTLED',settled_by='FINANCE',settled_ref_type=$2,settled_ref_id=$3,settled_ref_digest=$4,revision=revision+1 WHERE id=$1`,[dutyId,plan.ref.type,plan.ref.id,plan.ref.digest]);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const state=(await c.query(`SELECT (SELECT sum(credit_cents-debit_cents)::text FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE')) AS balance,
   (SELECT ledger_revision::text FROM zzsh_order.wallet_revision WHERE user_id=$1) AS revision,(SELECT status FROM zzsh_order.legacy_order_duty WHERE id=$2) AS duty`,[owner,dutyId])).rows[0];
  assert.deepEqual(state,{balance:'1000',revision:'1',duty:'SETTLED'});
  await c.query('SAVEPOINT duplicate');
  await assert.rejects(c.query('INSERT INTO zzsh_order.legacy_duty_finance_fact SELECT * FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=$1',[dutyId]),
   error=>['23505','23514'].includes(error.code));
  await c.query('ROLLBACK TO SAVEPOINT duplicate');
  assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='OWNER_AVAILABLE'",[owner])).rows[0].n,1);
  console.log('synthetic PostgreSQL legacy wallet duties and duplicate-protection guards: PASS (fixtures seeded, transaction rolled back)');
 }finally{await c.query('ROLLBACK').catch(()=>{});if(workerLocked)await c.query('SELECT pg_advisory_unlock(806007::bigint)').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1});
