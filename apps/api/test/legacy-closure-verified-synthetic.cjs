// Uses the registered synthetic database only; all seeded data and writes roll back.
const assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{Pool}=require('pg');
assert.equal(process.env.LEGACY_COMPLETION_SYNTH_OPT_IN,'1');
const fixture=require('../dist/test/legacy-continuation-fixture'),model=require('../dist/src/order/legacy-continuation-model');
const calc=require('../dist/src/order/legacy-continuation-calc'),evidence=require('../dist/src/order/legacy-continuation-evidence');
const command=require('../dist/src/order/legacy-continuation-command'),basisStore=require('../dist/src/order/legacy-settlement-basis');
const finance=require('../dist/src/order/legacy-finance-duty'),{setAuditContext}=require('../dist/src/auth/security-core');
const {readLegacyDutyFinalization}=require('../dist/src/finance/legacy-duty-finance-store');
const {canonicalize}=require('../dist/src/supply/content-hash');
const {prepareLegacyGrowthBackfill}=require('../dist/src/auth/membership-growth-legacy');
const {createLegacyGrowthCoveragePort}=require('../dist/src/auth/membership-growth-legacy-store');
const {readMembershipGrowth}=require('../dist/src/auth/membership-growth-integration');
const pool=new Pool({host:'127.0.0.1',port:55439,database:'zzsh_synth_prod_refund_r3',user:'postgres',max:1});
const importedPending=process.env.LEGACY_CLOSURE_SYNTH_IMPORTED_PENDING==='1';
const b={...fixture.legacyBinding,sourceOrderStatus:importedPending?8:3},empty=createHash('sha256').update('').digest('hex');
const admin={realm:'admin',userId:'synthetic-closure-staff',sessionId:'synthetic-closure-session',requestId:'synthetic-closure-admin'};
const user=(legacyId,userId,requestId)=>({realm:'user',userId,sessionId:'synthetic-session-'+legacyId,requestId});
(async()=>{
 const client=await pool.connect();
 try {
  const identity=(await client.query(`SELECT (pg_control_system()).system_identifier::text AS system_id,d.oid::text AS oid,
   shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{system_id:process.env.LEGACY_COMPLETION_SYNTH_SYSTEM_ID,oid:process.env.LEGACY_COMPLETION_SYNTH_OID,marker:'zzsh:synthetic:production-refund-v1'});
  await client.query('BEGIN');await client.query("SET LOCAL session_replication_role='replica'");
  for(const [id,legacyId,digest] of [[b.ownerUserId,b.legacyOwnerId,b.ownerSourceDigest],[b.renterUserId,b.legacyRenterId,b.renterSourceDigest]]){
   await client.query('INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,now(),now())',[id,legacyId+'@example.invalid']);
   await client.query(`INSERT INTO zzsh_auth_user.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',now(),now())`,['synthetic-session-'+legacyId,id,'synthetic-token-'+legacyId]);
   await client.query(`INSERT INTO zzsh_iam.user_identity_state(user_id,provider,provider_reference) VALUES($1,'legacy_mysql_restore',$2)`,[id,'la_user:'+legacyId]);
   await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,action,object_type,object_id,outcome,occurred_at,details) VALUES($1,'system','user.legacy_owner.migrated','user',$2,'SUCCESS',now(),$3::jsonb)`,['synthetic-identity-'+legacyId,id,JSON.stringify({sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',legacyId,sourceDigest:digest})]);
   await client.query(`INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES($1,0,0)`,[id]);
  }
  await client.query('INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[admin.userId,'synthetic-staff@example.invalid']);
  await client.query(`INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at) VALUES($1,'ACTIVE',true,now())`,[admin.userId]);
  await client.query(`INSERT INTO zzsh_auth_admin.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,'synthetic-token',clock_timestamp()+interval '1 hour',now(),now())`,[admin.sessionId,admin.userId]);
  await client.query(`INSERT INTO zzsh_supply.game(id,code,name) VALUES($1,'synthetic','synthetic')`,[b.gameId]);
  await client.query(`INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES($1,$2,$3)`,[b.accountId,b.ownerUserId,b.gameId]);
  await client.query(`INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,
   account_id,game_id,owner_user_id,renter_user_id,legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_owner_id,owner_source_digest,
   legacy_renter_id,renter_source_digest,source_order_status,source_pay_status,recorded_paid_amount_cents,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id)
   VALUES($1,'legacy_mysql_restore','la_order',$2,$3,'synthetic','SYNTHETIC_ORDER',$4,$5,$6,$7,$8,'la_rental_accounts',$3,$9,$10,$11,$12,$14,1,10000,'{"is_delete":"0"}',1,$3,$13)`,
   [b.id,b.legacyId,b.sourceDigest,b.accountId,b.gameId,b.ownerUserId,b.renterUserId,b.legacyAccountId,b.legacyOwnerId,b.ownerSourceDigest,b.legacyRenterId,b.renterSourceDigest,admin.userId,b.sourceOrderStatus]);
  const early=process.env.LEGACY_CLOSURE_SYNTH_EARLY==='1',payout=process.env.LEGACY_CLOSURE_SYNTH_PAYOUT==='1';assert(!payout||early);
  const v=early?fixture.legacyVerifiedEarlyProposal('8',payout):fixture.legacyVerifiedProposal();
  const original=importedPending?fixture.legacyEvidence(model.initialLegacyFacts({...v.original.facts.evidence.source,orderStatus:'8',quantities:v.quantities,saleEarnings:'13.00',returnOrderMoney:'87.00'})):v.original;
  original.id='fixture_evidence';
  await client.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,source_as_of,evidence_ref,source_digest,
   parameter_digest,admission,reasons,facts,facts_canonical,facts_digest) VALUES($1,$2,1,'SOURCE_IMPORT',now(),'synthetic',$3,$4,$5,'[]'::jsonb,$6::jsonb,$7,$8)`,
   [original.id,b.id,b.sourceDigest,original.facts.evidence.parameterDigest,original.facts.evidence.admission,JSON.stringify(original.facts),original.factsCanonical,original.factsDigest]);
  for(const [id,legacyId,digest,prefix] of [[b.ownerUserId,b.legacyOwnerId,b.ownerSourceDigest,'owner'],[b.renterUserId,b.legacyRenterId,b.renterSourceDigest,'renter']]){
   await client.query(`INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,available_cents,source_cutoff,covered_count,covered_set_digest)
    VALUES($1,$2,'LEGACY_OPENING','legacy_mysql_restore','la_user',$3,$4,$4,0,'2026-11-01T00:00:00Z',0,$5)`,['synthetic-'+prefix+'-basis',id,legacyId,digest,empty]);
   await client.query(`INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id) VALUES($1,'RECONCILED_OPENING',$2,$3)`,[id,'synthetic-'+prefix+'-basis','synthetic-'+prefix+'-opening']);
   await client.query(`INSERT INTO zzsh_order.personal_finance_observation_coverage(id,user_id,source_system,legacy_user_id,source_kind,source_entity,source_cutoff,input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,source_canonical)
    VALUES($1,$2,'legacy_mysql_restore',$3,'HISTORICAL_EARNINGS_LOG','la_log_earnings','2026-11-01T00:00:00Z',$4,$4,0,0,0,$5,$5,$5,$4,'{}')`,['synthetic-'+prefix+'-history',id,legacyId,digest,empty]);
  }
  const cutoff='2026-10-18T00:00:00.000000Z',hash=value=>createHash('sha256').update(value).digest('hex');
  const receipt={subjectUserId:b.renterUserId,cutoff,fromExclusive:null,sourceExtractSha256:'a'.repeat(64),
   sourceSetSha256:hash(canonicalize({subjectUserId:b.renterUserId,cutoff,fromExclusive:null,expectedSourceKeys:[]})),
   expectedSourceKeys:[],refundReviewEvidenceRefs:['SYNTHETIC_HISTORICAL_REVIEW']};
  const prepared=prepareLegacyGrowthBackfill({receipt,inputs:[],corrections:[],admitted:{receiptDigests:[hash(canonicalize(receipt))],componentDigests:[],correctionDigests:[]},gameIdBySettlementId:{},packageDigest:'b'.repeat(64)});
  assert.equal(prepared.ok,true);
  await createLegacyGrowthCoveragePort().persist(client,{...prepared.record,executionKey:'synthetic-base-execution'});
  await client.query("SET LOCAL session_replication_role='origin'");await client.query('SET LOCAL ROLE zzsh_synth_runtime');
  await setAuditContext(client,'admin',admin.userId,admin.sessionId,admin.requestId);
  const authority=await finance.authorizeLegacyFinanceDuty(client,admin,b.id,'OWNER_CREDIT');
  let locked=await evidence.lockLegacyContinuationOrder(client,b.id),sourceRow=original;
  if(importedPending){
   const owner=user(b.legacyOwnerId,b.ownerUserId,'synthetic-old-proposal');await setAuditContext(client,'user',owner.userId,owner.sessionId,owner.requestId);
   const caller={role:'owner',legacyUserId:b.legacyOwnerId},confirm=calc.planLegacyContinuation(sourceRow.facts.evidence,{kind:'confirm',caller});assert(confirm.ok);
   await assert.rejects(command.applyLegacyContinuationCommand(client,owner,b.id,command.parseLegacyMutation('confirm',{
    expectedRevision:null,inputEvidenceId:sourceRow.id,planFingerprint:confirm.fingerprint})),/LEGACY_PROPOSAL_RECONFIRM_REQUIRED/);
   const reject=calc.planLegacyContinuation(sourceRow.facts.evidence,{kind:'reject',caller});assert(reject.ok);
   const rejected=await command.applyLegacyContinuationCommand(client,owner,b.id,command.parseLegacyMutation('reject',{
    expectedRevision:null,inputEvidenceId:sourceRow.id,planFingerprint:reject.fingerprint}));
   assert.equal(rejected.body.stage,'3');
   locked=await evidence.lockLegacyContinuationOrder(client,b.id);sourceRow=await evidence.readLegacyContinuationEvidence(client,b.id,locked.head);
   assert.equal((await client.query(`SELECT count(*)::int AS n FROM zzsh_order.legacy_continuation_evidence WHERE id=$1`,[original.id])).rows[0].n,1);
   await setAuditContext(client,'admin',admin.userId,admin.sessionId,admin.requestId);
  }
  const input={expectedRevision:locked.head?.revision??null,inputEvidenceId:sourceRow.id,expectedBasisId:null,
   openingHaffM:v.basis.openingHaffM,baseBot:v.basis.baseBot,ownerPrices:v.basis.ownerPrices,openingItems:v.basis.openingItems,
   fullPayout:v.basis.fullPayout,partiesVerified:true,reason:'已与双方核实原始资料'};
  const verified=await basisStore.recordLegacySettlementBasis(client,admin,authority.binding,sourceRow,locked.head,input);
  assert.equal(verified.body.state,'VERIFIED');
  const renter=user(b.legacyRenterId,b.renterUserId,'synthetic-renter-propose');await setAuditContext(client,'user',renter.userId,renter.sessionId,renter.requestId);
  const saved=await basisStore.readLegacySettlementBasis(client,b,sourceRow,locked.head),plan=calc.planVerifiedLegacySettlement(sourceRow.facts.evidence,
   {kind:'propose',caller:{role:'renter',legacyUserId:b.legacyRenterId},quantities:v.quantities,endReason:early?'TENANT_VOLUNTARY_EARLY':'NORMAL',settlementBasis:saved},saved);
  const expectedBasis=basisStore.projectLegacySettlementBasis(saved);
  const initialView=await evidence.readLegacyContinuation(client,renter,b.id);
  assert.deepEqual(initialView.continuation.settlementBasis,expectedBasis);
  assert.equal('ownerPrices' in initialView.continuation.settlementBasis,false);
  assert.equal(plan.ok,true);
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  const proposed=await command.applyLegacyContinuationCommand(client,renter,b.id,command.parseLegacyMutation('propose',{
   expectedRevision:locked.head?.revision??null,inputEvidenceId:sourceRow.id,planFingerprint:plan.fingerprint,quantities:v.quantities,endReason:early?'TENANT_VOLUNTARY_EARLY':'NORMAL'}));
  assert.equal(proposed.body.stage,'8');
  const head=await evidence.readLegacyContinuationHead(client,b.id),row=await evidence.readLegacyContinuationEvidence(client,b.id,head);
  const owner=user(b.legacyOwnerId,b.ownerUserId,'synthetic-owner-confirm');await setAuditContext(client,'user',owner.userId,owner.sessionId,owner.requestId);
  const proposalView=await evidence.readLegacyContinuation(client,owner,b.id);
  assert.deepEqual(proposalView.continuation.settlementBasis,expectedBasis);
  const confirmPlan=calc.planLegacyContinuation(model.readSealedLegacyFacts(row).evidence,{kind:'confirm',caller:{role:'owner',legacyUserId:b.legacyOwnerId}});
  assert.equal(confirmPlan.ok,true);
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  let confirmed=await command.applyLegacyContinuationCommand(client,owner,b.id,command.parseLegacyMutation('confirm',{
   expectedRevision:head.revision,inputEvidenceId:row.id,planFingerprint:confirmPlan.fingerprint}),readLegacyDutyFinalization,undefined,finance.postLegacyOwnerCreditOnConfirmation);
  if(early){
   assert.equal(confirmed.body.reviewPending,true);assert.equal(confirmed.body.stage,'8');
   assert.equal((await evidence.readLegacyContinuationDuties(client,b.id)).length,0);
   const userView=await evidence.readLegacyContinuation(client,owner,b.id,readLegacyDutyFinalization);
   assert(userView.continuation.reasons.includes('EARLY_REVIEW_PENDING'));
   assert(!userView.continuation.capabilities.includes('confirm'));
   await setAuditContext(client,'admin',admin.userId,admin.sessionId,admin.requestId);
   const staffAuthority=await finance.authorizeLegacyFinanceDuty(client,admin,b.id,'OWNER_CREDIT');
   const staffPlan=calc.planLegacyContinuation(model.readSealedLegacyFacts(row).evidence,{kind:'confirm',caller:{role:'admin',legacyUserId:''}});
   assert.equal(staffPlan.ok,true);await client.query('SET CONSTRAINTS ALL DEFERRED');
   confirmed=await command.applyLegacyContinuationCommand(client,admin,b.id,command.parseLegacyMutation('confirm',{
    expectedRevision:head.revision,inputEvidenceId:row.id,planFingerprint:staffPlan.fingerprint,reason:'已与双方核实提前结算'}),readLegacyDutyFinalization,staffAuthority,finance.postLegacyOwnerCreditOnConfirmation);
  }
  assert.equal(confirmed.body.stage,'4');
  await setAuditContext(client,'user',owner.userId,owner.sessionId,owner.requestId);
  const completedView=await evidence.readLegacyContinuation(client,owner,b.id);
  assert.deepEqual(completedView.continuation.settlementBasis,expectedBasis);
  const duties=await evidence.readLegacyContinuationDuties(client,b.id);
  assert.equal(duties.find(d=>d.kind==='RENTER_REFUND').amountCents,payout?'3047':early?'3775':'8200');
  assert.equal(duties.find(d=>d.kind==='OWNER_CREDIT').amountCents,early?'5500':'1300');
  assert.equal(duties.find(d=>d.kind==='OWNER_CREDIT').status,'SETTLED');
  const ownerCredits=(await client.query(`SELECT credit_cents::text AS cents FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code='OWNER_AVAILABLE'`,[b.ownerUserId])).rows;
  assert.deepEqual(ownerCredits,[{cents:early?'5500':'1300'}]);
  const growth=(await client.query(`SELECT source_type,amount_cents::text AS cents FROM zzsh_iam.membership_growth_contribution WHERE user_id=$1 ORDER BY source_type`,[b.renterUserId])).rows;
  assert.deepEqual(growth,early?[{source_type:'MATERIAL_CONSUMPTION',cents:'0'},{source_type:'MINIMUM_BILLING',cents:'225'},{source_type:'RENTAL_SETTLEMENT',cents:'6000'}]
   :[{source_type:'MATERIAL_CONSUMPTION',cents:'0'},{source_type:'RENTAL_SETTLEMENT',cents:'1300'}]);
  const growthView=await readMembershipGrowth(client,b.renterUserId,new Date(Date.now()+1000).toISOString());
  assert.equal(growthView?.growth.knowledge,'KNOWN');
  assert.equal(growthView.growth.lifetimePoints,early?'62':'13');
  const timing=(await client.query(`SELECT refund_wait_days AS days FROM zzsh_order.legacy_continuation_version WHERE id=$1`,[confirmed.body.versionId])).rows[0];
  assert.deepEqual(timing,{days:early?7:0});
  await setAuditContext(client,'admin',admin.userId,admin.sessionId,admin.requestId);
  const profiles=require('../dist/src/order/joinpay-refund-profile'),refundStore=require('../dist/src/order/channel-refund-store');
  const profileText=JSON.stringify({kind:'JOINPAY_REFUND_PROFILE_V1',operation:'SUBMIT',purpose:'MERCHANT_REFUND',database:'zzsh_synth_prod_refund_r3',runtimeUser:'zzsh_synth_runtime',merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
  const admissionText=JSON.stringify({kind:'FORMAL_NATIVE_REFUND_SERVER_REVIEW',reference:'synthetic-admission',database:'zzsh_synth_prod_refund_r3',runtimeUser:'zzsh_synth_runtime',merchantIdentityId:'synthetic-merchant',merchantNo:'12345',acceptedProfiles:[{operation:'SUBMIT',profileId:'synthetic-profile',profileSha256:hash(profileText),keyVersionRef:'synthetic-key-ref'},{operation:'QUERY'},{operation:'NOTIFY'}]});
  profiles.assertFormalRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',reference:'synthetic-admission',sha256:hash(admissionText),canonical:admissionText});
  profiles.describeRefundProfile=()=>({merchantIdentityId:'synthetic-merchant',merchantNo:'12345',profileId:'synthetic-profile',profileSha256:hash(profileText),keyVersionRef:'synthetic-key-ref',notifyUrl:'https://fixture.invalid/refund',fundsAccount:'SETTLED'});
  profiles.readRefundProfileEvidence=()=>profileText;profiles.assertRefundStart=()=>{};profiles.assertRefundBinding=()=>{};refundStore.assertRefundResource=async()=> '1';
  const refundDuty=duties.find(d=>d.kind==='RENTER_REFUND'),finalHead=await evidence.readLegacyContinuationHead(client,b.id);
  const refundInput={orderId:b.id,dutyId:refundDuty.id,expectedDutyRevision:refundDuty.revision,expectedHeadRevision:finalHead.revision,
   paymentOrderNo:'FIXTURE_P7',confirmedMerchantNo:'12345',paidCents:'10000',previouslyRefundedCents:'0',priorAppliedToDutyCents:'0',noUnresolvedRefunds:true,evidenceRef:'已核对合成付款及退款记录'};
  const createCase=()=>require('../dist/src/order/legacy-refund-case-command').createLegacyRefundCase(client,admin,refundInput,{admission:{},profile:{}});
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  if(early) {
   await assert.rejects(createCase,/REFUND_NOT_DUE/);
   assert.equal((await client.query(`SELECT count(*)::int AS n FROM zzsh_order.legacy_refund_case WHERE duty_id=$1`,[refundDuty.id])).rows[0].n,0);
  } else {
   const made=await createCase();assert.equal(made.body.channelResultAtCreation,'NOT_SUBMITTED');assert.equal(made.body.amountCents,'8200');
   assert.equal((await client.query(`SELECT state FROM zzsh_order.legacy_refund_intent WHERE id=$1`,[made.body.intentId])).rows[0].state,'READY');
  }
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  console.log(`PASS synthetic PostgreSQL: verified original facts, ${early?'early review and refund wait':'normal confirmation and prepared refund'}`);
 } finally {await client.query('ROLLBACK');client.release();await pool.end();}
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;pool.end().catch(()=>{});});
