import assert from 'node:assert/strict';
import test from 'node:test';
import * as auth from '../src/auth/auth-security';
import * as policyStore from '../src/finance/distribution-policy-store';
import { validateDistributionPolicy } from '../src/finance/distribution-policy';
import { initializeNewDistributionRegistration } from '../src/finance/distribution-registration';
import { handleDistributionPolicyAdmin } from '../src/finance/distribution-policy-routes';
import { createHash } from 'node:crypto';
import * as authorization from '../src/auth/admin-authorization';
import * as supplyRoutes from '../src/supply/supply-routes';
import * as scopes from '../src/auth/admin-scope';
import * as earningRead from '../src/finance/distribution-earning-read';
import * as legacyFinance from '../src/finance/legacy-duty-finance-store';
import { canonicalize } from '../src/supply/content-hash';
import { freezePaymentDistributionBasis, readOriginalPaymentDistributionBasis } from '../src/finance/distribution-payment-basis';
import { parseDistributionPolicyChange, prepareDistributionPolicyChange, initialDistributionPolicyConfig, type DistributionPolicyUpdate, type DistributionPolicyInitial } from '../src/finance/distribution-policy-change';
import { assertDistributionApprovalAccess, createDistributionPolicyApprovalExecutor, validateDistributionPolicySubmission } from '../src/finance/distribution-policy-approval';
import { readAdminDistributionOrder, readAdminDistributionRelations } from '../src/finance/admin-distribution-read';
import { projectMyDistributionTerms, projectMyDistributionTermsV2 } from '../src/finance/invitation-store';
import * as invitationStore from '../src/finance/invitation-store';
import * as userIdentity from '../src/auth/user-identity';
import { createPaymentDistributionStore } from '../src/finance/distribution-payment-store';

const flat = { schema:'distribution-policy.v2',scope:'LOCAL_CONTROLLED',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary','custom'],minimumAccrualCents:'1',settlementDelayDays:1,rateMode:'UNIFORM',renterPercent:'3',ownerPercent:'2' };
const legacy = { schema:'distribution-policy.v1',scope:'LOCAL_CONTROLLED',enabled:false,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary','custom'],minimumAccrualCents:'1',settlementDelayDays:1,levels:[{code:'BASE',rank:1,default:true,renterPercent:'3',ownerPercent:'2',upgrade:null}] };

test('new uniform policy has explicit two rates and no grade fallback; old version stays exact',()=>{
 const result=validateDistributionPolicy(flat);
 assert.equal(result.schema,'distribution-policy.v2');
 assert.deepEqual(result.levels,[]);
 assert.deepEqual(validateDistributionPolicy(legacy),legacy);
 assert.throws(()=>validateDistributionPolicy({...flat,renterPercent:undefined}));
 assert.throws(()=>validateDistributionPolicy({...flat,renterPercent:'99',ownerPercent:'2'}));
 assert.throws(()=>validateDistributionPolicy({...flat,levels:legacy.levels}));
});

test('disabled uniform policy still initializes real registration qualification, not INELIGIBLE',async()=>{
 const record=policyStore as unknown as Record<string,unknown>,original=record.readRegistrationDistributionPolicyInTransaction;
 record.readRegistrationDistributionPolicyInTransaction=async()=>({knowledge:'KNOWN',policy:{versionId:'policy_1',config:validateDistributionPolicy({...flat,enabled:false})}});
 const calls:Array<{sql:string;values:unknown[]}> = [];
 const client={query:async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});
  if(sql.includes("AS complete,to_regclass"))return{rows:[{complete:true,protected_proof:true}]};
  if(sql.includes('SELECT user_id FROM zzsh_order.distribution_participant'))return{rows:[]};
  if(sql.includes('inserted_in_transaction'))return{rows:[{id:'user_new',suspended:false,account_status:'ACTIVE',inserted_in_transaction:true}]};
  if(sql.includes('RETURNING id'))return{rows:[{id:'code_new'}],rowCount:1};
  return{rows:[],rowCount:1};
 }};
 try{const result=await initializeNewDistributionRegistration(client as any,{userId:'user_new',requestId:'request_1'});assert.equal(result.eligibility,'ELIGIBLE');const insert=calls.find(c=>c.sql.startsWith('INSERT INTO zzsh_order.distribution_participant'));assert.equal(insert?.values[1],'ELIGIBLE');}
 finally{record.readRegistrationDistributionPolicyInTransaction=original;}
});

test('paused policy still records both legitimate relation types and never rewrites existing registration',async()=>{
 const p=policyStore as any,i=invitationStore as any,oldRead=p.readRegistrationDistributionPolicyInTransaction,oldParent=i.readDistributionParentInTransaction;
 p.readRegistrationDistributionPolicyInTransaction=async()=>({knowledge:'KNOWN',policy:{versionId:'paused_policy',config:validateDistributionPolicy({...flat,enabled:false})}});
 i.readDistributionParentInTransaction=async()=>({parent:{eligibility:'ELIGIBLE'},ownerActive:true,graphComplete:true});
 const calls:Array<{sql:string;values:any[]}> = [];
 const c:any={query:async(sql:string,values:any[]=[])=>{calls.push({sql,values});if(sql.includes('AS complete,to_regclass'))return{rows:[{complete:true,protected_proof:true}]};if(sql.includes('SELECT user_id FROM zzsh_order.distribution_participant'))return{rows:[]};if(sql.includes('inserted_in_transaction'))return{rows:[{id:'user_new',suspended:false,account_status:'ACTIVE',inserted_in_transaction:true}]};if(sql.includes('SELECT * FROM zzsh_order.distribution_invite_code'))return{rows:[{id:'code_1',user_id:'parent_1'}]};if(sql.includes('RETURNING id'))return{rows:[{id:'code_new'}],rowCount:1};return{rows:[],rowCount:1};}};
 try{await initializeNewDistributionRegistration(c,{userId:'user_new',inviteCode:'CODE1',requestId:'req_1'});const inserts=calls.filter(x=>x.sql.startsWith('INSERT INTO zzsh_order.invitation_relation'));assert(inserts.some(x=>x.sql.includes("'INVITER'")));assert(inserts.some(x=>x.sql.includes("'DISTRIBUTION_LEADER'")));assert(inserts.every(x=>x.values.includes('parent_1')));
 const existing:any={query:async(sql:string)=>({rows:sql.includes('AS complete,to_regclass')?[{complete:true,protected_proof:true}]:sql.includes('SELECT user_id FROM')?[{user_id:'user_new'}]:[]})};await assert.rejects(()=>initializeNewDistributionRegistration(existing,{userId:'user_new',requestId:'req_2'}),/original registration receipt/);
 }finally{p.readRegistrationDistributionPolicyInTransaction=oldRead;i.readDistributionParentInTransaction=oldParent;}
});

test('HTTP policy PUT cannot bypass approved execution even with an authenticated admin',async()=>{
 const a=auth as unknown as Record<string,unknown>,p=policyStore as unknown as Record<string,unknown>,oldAuth=a.readAdminContext,oldPut=p.configureDistributionPolicy;
 let writes=0;a.readAdminContext=async()=>({userId:'admin_1',sessionId:'session_1'});p.configureDistributionPolicy=async()=>{writes++;return{status:200,body:{ok:true}};};
 const response:any={statusCode:0,status(code:number){this.statusCode=code;return this;},setHeader(){return this;},json(body:unknown){this.body=body;return this;}};
 try{await handleDistributionPolicyAdmin({method:'PUT',url:'/api/v1/admin/distribution/policy',headers:{origin:'http://127.0.0.1:4221','idempotency-key':'key_1'},body:{}} as any,response,{pool:{} as any,adminOrigin:'http://127.0.0.1:4221',apiOrigin:'http://127.0.0.1:4222'} as any);assert.equal(response.statusCode,403);assert.equal(writes,0);}
 finally{a.readAdminContext=oldAuth;p.configureDistributionPolicy=oldPut;}
});

const hash=(v:unknown)=>createHash('sha256').update(canonicalize(v)).digest('hex');
const legacyConfig=validateDistributionPolicy(legacy),head={versionId:'policy_1',revision:'4',digest:hash(legacyConfig),config:legacyConfig};
const change=()=>parseDistributionPolicyChange({schema:'distribution-policy-change.v1',expectedPolicyId:head.versionId,expectedRevision:head.revision,expectedPolicyDigest:head.digest,changes:{renterPercent:'3',ownerPercent:'2',enabled:false},reason:'调整全站方案'}) as DistributionPolicyUpdate;

test('approved changes pin exact policy id/revision/digest and cannot alter other economics',()=>{
 const plan=change(),prepared=prepareDistributionPolicyChange(head,plan);
 assert.equal(prepared.schema,'distribution-policy.v2');assert.equal(prepared.enabled,false);assert.equal(prepared.minimumAccrualCents,legacyConfig.minimumAccrualCents);assert.equal(prepared.settlementDelayDays,legacyConfig.settlementDelayDays);assert.deepEqual(prepared.accountModes,legacyConfig.accountModes);
 for(const field of ['expectedPolicyId','expectedRevision','expectedPolicyDigest'] as const)assert.throws(()=>prepareDistributionPolicyChange(head,{...plan,[field]:field==='expectedRevision'?'5':'different'}),/baseline changed/);
 assert.throws(()=>prepareDistributionPolicyChange(head,{...plan,changes:{enabled:true}}),/both explicit rates/);
 assert.throws(()=>parseDistributionPolicyChange({...plan,changes:{enabled:true,minimumAccrualCents:'0'}}));
 assert.throws(()=>parseDistributionPolicyChange({...plan,changes:{enabled:'false'}}));
 assert.throws(()=>parseDistributionPolicyChange({...plan,changes:{renterPercent:'1e2',ownerPercent:'0'}}));
});

function paymentInput(config:any,levelCode:string|null='OLD_GOLD'){
 return{orderId:'order_1',gameId:'game_1',currency:'CNY' as const,confirmationId:'payment_1',acceptedAt:'2026-10-26T08:00:00.000Z',paymentDigest:'a'.repeat(64),admissionId:'admission_1',admissionRevision:'1',origin:'NATIVE' as const,accountMode:'ordinary',estimate:{baseCents:'10000',sourceDigest:'b'.repeat(64)},policy:{versionId:'policy_1',digest:hash(config),config},facts:['RENTER_REFERRAL','OWNER_REFERRAL'].map((role,index)=>({role,partyUserId:'party_'+index,relation:{knowledge:'KNOWN_PARENT',id:'relation_'+index,childUserId:'party_'+index,parentUserId:'beneficiary_'+index,sourceDigest:'c'.repeat(64)},beneficiary:{userId:'beneficiary_'+index,active:true,eligibility:'ELIGIBLE',commissionFrozen:false,levelCode}}))} as any;
}
test('uniform new payment ignores historical grade while preserving qualification and existing basis',()=>{
 const config=validateDistributionPolicy(flat),basis=freezePaymentDistributionBasis(paymentInput(config));
 assert(basis.roles.every(r=>r.status==='ELIGIBLE'&&r.levelCode===null));assert.deepEqual(basis.roles.map(r=>r.percent).sort(),['2','3']);
 const old=freezePaymentDistributionBasis(paymentInput({...legacyConfig,enabled:true},'BASE'));
 assert(old.roles.every(r=>r.status==='ELIGIBLE'&&r.levelCode==='BASE'));
 assert.equal(readOriginalPaymentDistributionBasis(old,{orderId:old.orderId,confirmationId:old.confirmationId,paymentDigest:old.paymentDigest}).basis,old);
 assert.equal(readOriginalPaymentDistributionBasis(null,{orderId:'order_1',confirmationId:'payment_1',paymentDigest:'a'.repeat(64)}).knowledge,'UNKNOWN');
 const unknown=paymentInput(config);unknown.facts[0].beneficiary.eligibility='UNKNOWN';assert(freezePaymentDistributionBasis(unknown).roles.some(r=>r.status.startsWith('UNKNOWN')));
});
test('paused first payment remains SKIPPED_DISABLED after current policy reopens; fast still skips',()=>{
 const paused=freezePaymentDistributionBasis(paymentInput(validateDistributionPolicy({...flat,enabled:false})));
 assert(paused.roles.every(r=>r.status==='SKIPPED_DISABLED'&&r.percent===null));
 const reopened=freezePaymentDistributionBasis(paymentInput(validateDistributionPolicy(flat)));
 assert(reopened.roles.every(r=>r.status==='ELIGIBLE'));
 assert(paused.roles.every(r=>r.status==='SKIPPED_DISABLED'));
 const input=paymentInput(validateDistributionPolicy(flat));input.accountMode='fast';assert(freezePaymentDistributionBasis(input).roles.every(r=>r.status==='SKIPPED_FAST'));
});
test('actual original-payment store rereads the durable paused basis without current-policy lookup or backfill',async()=>{
 const payment={id:'payment_1',order_id:'order_1',source:'CONTROLLED',merchant_scope_id:'scope_1',provider_transaction_id:'trx_1',merchant_order_no:'NO_1',amount_cents:'10000',currency:'CNY',provider_paid_at:null,accepted_at:'2026-10-26T08:00:00.000000Z'};
 const input=paymentInput(validateDistributionPolicy({...flat,enabled:false}));input.paymentDigest=hash(payment);input.acceptedAt=payment.accepted_at;
 const paused=freezePaymentDistributionBasis(input),{digest,...body}=paused,calls:string[]=[];
 const client:any={query:async(sql:string)=>{calls.push(sql);if(sql.startsWith('SELECT d.oid'))return{rows:[{oid:12345,name:'zzsh_test_order_evidence_order',role:'zzsh_order_evidence_order_r',marker:'zzsh:order-reservation-test:v1'}]};if(sql.startsWith('SELECT p.id,p.order_id'))return{rows:[payment]};if(sql.startsWith('SELECT canonical_basis'))return{rows:[{canonical_basis:canonicalize(body),basis_digest:digest}]};throw Error('Original read must not read new policy or write');}};
 const store=createPaymentDistributionStore({resourceSet:'evidence_order',resourceOid:12345,approvalDigest:'a'.repeat(64),allowedOrderIds:['order_1']});
 const result=await store.readOriginal(client,'order_1','payment_1');assert.equal(result.knowledge,'KNOWN');assert.deepEqual(result.basis,paused);assert(result.basis!.roles.every(r=>r.status==='SKIPPED_DISABLED'));assert(calls.every(sql=>!sql.includes('distribution_policy_head')&&!/^(INSERT|UPDATE|DELETE)/.test(sql)));
});
test('self terms support uniform rates without assigning or requiring a synthetic grade',()=>{
 const config=validateDistributionPolicy(flat),p={eligibility:'ELIGIBLE',level_code:'OLD_GOLD',commission_frozen:false,policy_version_id:'old_policy'};
 const legacy=projectMyDistributionTerms('user_1',{knowledge:'KNOWN',policy:{versionId:'new_policy',config}},p);assert.equal(legacy.knowledge,'UNKNOWN');assert.equal(legacy.reason,'UNIFORM_TERMS_REQUIRES_PROJECTION_V2');assert.equal('rates' in legacy,false);
 const v=projectMyDistributionTermsV2('user_1',{knowledge:'KNOWN',policy:{versionId:'new_policy',config}},p);
 assert.equal(v.applicable,true);assert.equal(v.level,null);assert.equal(v.rateMode,'UNIFORM');assert.deepEqual(v.rates,{renterPercent:'3',ownerPercent:'2'});assert.equal(v.participantPolicyVersion,'old_policy');
 assert.equal(projectMyDistributionTerms('user_1',{knowledge:'KNOWN',policy:{versionId:'new_policy',config}},undefined).knowledge,'UNKNOWN');
});

const access=(permissions:string[],boss=false)=>({status:'ACTIVE' as const,isBoss:boss,passwordChangeRequired:false,permissions:new Set(boss?authorization.ADMIN_PERMISSION_CODES:permissions)});
test('request/execution need policy manage; every decision needs Boss, not only ordinary approval',()=>{
 assertDistributionApprovalAccess(access(['personal.distribution.policy.manage']),'REQUEST');
 assert.throws(()=>assertDistributionApprovalAccess(access(['approval.request.approve']),'DECIDE'));
 assertDistributionApprovalAccess(access([],true),'DECIDE');
 assert.throws(()=>assertDistributionApprovalAccess(access(['personal.distribution.policy.read']),'EXECUTE'));
});

test('executor verifies immutable approved hash/Boss/original requester and reuses same client',async()=>{
 const a=authorization as any,s=policyStore as any,oldAccess=a.loadEffectiveAdminAccess,oldApply=s.applyApprovedDistributionPolicyInTransaction;let applied=0;
 a.loadEffectiveAdminAccess=async(_c:any,userId:string)=>access(['personal.distribution.policy.manage'],userId==='boss_1');
 const client:any={query:async()=>({rows:[{at:'2026-10-26T08:00:00.000Z'}]})};
 s.applyApprovedDistributionPolicyInTransaction=async(c:any,_actor:any,payload:any,approval:any)=>{assert.equal(c,client);assert.deepEqual(payload,change());assert.equal(approval.approvalRequestId,'approval_1');applied++;return{policy:{versionId:'policy_2'}};};
 const payload=change(),input={requestId:'approval_1',operationCode:'distribution.policy.publish',payloadVersion:1,operationPayload:payload,operationPayloadHash:hash(payload),requestedBy:'ops_1',decidedBy:'boss_1',expiresAt:'2026-10-27T08:00:00.000Z'};
 try{const execute=createDistributionPolicyApprovalExecutor({kind:'LOCAL_CONTROLLED_DISTRIBUTION'});assert.equal((await execute(client,input as any,{userId:'ops_1',sessionId:'session_1'},'req_1')).resultCode,'DISTRIBUTION_POLICY_APPLIED');assert.equal(applied,1);
  await assert.rejects(()=>execute(client,{...input,operationPayloadHash:'0'.repeat(64)} as any,{userId:'ops_1',sessionId:'session_1'},'req_2'));
  await assert.rejects(()=>execute(client,{...input,decidedBy:'ops_1'} as any,{userId:'ops_1',sessionId:'session_1'},'req_3'));
  await assert.rejects(()=>createDistributionPolicyApprovalExecutor()(client,input as any,{userId:'ops_1',sessionId:'session_1'},'req_4'));
  assert.equal(applied,1);
 }finally{a.loadEffectiveAdminAccess=oldAccess;s.applyApprovedDistributionPolicyInTransaction=oldApply;}
});

test('submission hook serializes the single in-flight policy change and uses the pinned head',async()=>{
 const s=policyStore as any,original=s.readDistributionPolicyRowInTransaction,originalReady=s.assertDistributionPolicyWriteReadyInTransaction,writeScope={kind:'LOCAL_CONTROLLED_DISTRIBUTION'};s.readDistributionPolicyRowInTransaction=async()=>({knowledge:'KNOWN',policy:head});s.assertDistributionPolicyWriteReadyInTransaction=async(client:any,binding:any)=>{assert.equal(client,c);assert.equal(binding,writeScope);};const calls:string[]=[];
 const c:any={query:async(sql:string)=>{calls.push(sql);return{rows:sql.includes('FROM zzsh_iam.approval_request')?[{id:'original_pending'}]:[]};}};
 try{await assert.rejects(()=>validateDistributionPolicySubmission(c,change(),writeScope as any),/already requires handling/);assert(calls[0]!.includes('pg_advisory_xact_lock'));assert(calls.some(s=>s.includes("'EXECUTION_FAILED'")));}finally{s.readDistributionPolicyRowInTransaction=original;s.assertDistributionPolicyWriteReadyInTransaction=originalReady;}
});

const submissionResourceConfig:any={profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',host:'127.0.0.1',port:55432,name:'zzsh_test_order_milestone_real_1',user:'zzsh_order_milestone_real_1_r'}};
const submissionResourceReceipt={database:'zzsh_test_order_milestone_real_1',resourceOid:952624,owner:'zzsh',marker:'zzsh:order-reservation-test:v1',migrationRole:'zzsh_order_milestone_real_1_m',runtimeRole:'zzsh_order_milestone_real_1_r',ownerOid:10,migrationRoleOid:952625,runtimeRoleOid:952626};
function submissionPreparationClient(options:{marker?:boolean;version?:number}={}){
 const calls:string[]=[],original={id:head.versionId,revision:head.revision,canonical_config:canonicalize(head.config),config_digest:head.digest,created_at:'2026-10-27T00:00:00.000Z'};
 return{calls,original,query:async(sql:string)=>{calls.push(sql);if(sql.includes('current_database() AS name'))return{rows:[{name:submissionResourceReceipt.database,oid:952624,role:submissionResourceReceipt.runtimeRole,marker:submissionResourceReceipt.marker,complete:true}]};if(sql.includes('pg_get_userbyid'))return{rows:[{owner:'zzsh',ownerOid:10,roleOid:952626,rolsuper:false,rolbypassrls:false,complete:true}]};if(sql.includes('to_regprocedure'))return{rows:[{ready:options.marker!==false}]};if(sql==='SELECT zzsh_order.distribution_policy_contract_version() AS version')return{rows:[{version:options.version??2}]};if(sql.includes('FROM zzsh_order.distribution_policy_head h'))return{rows:[original]};if(sql.includes('FROM zzsh_iam.approval_request')||sql.includes('pg_advisory_xact_lock'))return{rows:[]};throw Error('Unexpected preparation query');}};
}
test('submission readiness: absent write scope refuses before policy or request SQL',async()=>{
 const c=submissionPreparationClient();await assert.rejects(()=>validateDistributionPolicySubmission(c as any,change()),(e:any)=>e.status===503);assert.equal(c.calls.length,0);
});
test('submission readiness: read-only scope cannot authorize generic approval create',async()=>{
 const c=submissionPreparationClient(),binding=policyStore.createLocalDistributionReadScope(submissionResourceConfig,submissionResourceReceipt);await assert.rejects(()=>validateDistributionPolicySubmission(c as any,change(),binding),(e:any)=>e.status===503);assert(!c.calls.some(s=>s.includes('pg_advisory_xact_lock')||s.includes('distribution_policy_head h')||s.includes('approval_request')));
});
test('submission readiness: forged opaque scope cannot authorize generic approval create',async()=>{
 const c=submissionPreparationClient();await assert.rejects(()=>validateDistributionPolicySubmission(c as any,change(),{kind:'LOCAL_CONTROLLED_DISTRIBUTION'}),(e:any)=>e.status===503);assert(!c.calls.some(s=>s.includes('pg_advisory_xact_lock')||s.includes('approval_request')));
});
test('submission readiness: missing contract refuses before request or policy head writes',async()=>{
 const c=submissionPreparationClient({marker:false}),binding=policyStore.createLocalDistributionScope(submissionResourceConfig,submissionResourceReceipt);await assert.rejects(()=>validateDistributionPolicySubmission(c as any,change(),binding),(e:any)=>e.status===503);assert(!c.calls.some(s=>s.includes('pg_advisory_xact_lock')||s.includes('distribution_policy_head h')||s.includes('approval_request')));
});
test('submission readiness: contract must be exactly version two',async()=>{
 const c=submissionPreparationClient({version:3}),binding=policyStore.createLocalDistributionScope(submissionResourceConfig,submissionResourceReceipt);await assert.rejects(()=>validateDistributionPolicySubmission(c as any,change(),binding),(e:any)=>e.status===503);assert(!c.calls.some(s=>s.includes('pg_advisory_xact_lock')||s.includes('approval_request')));
});
test('submission readiness: legal preparation validates without changing the policy head',async()=>{
 const c=submissionPreparationClient(),before=canonicalize(c.original),binding=policyStore.createLocalDistributionScope(submissionResourceConfig,submissionResourceReceipt);await validateDistributionPolicySubmission(c as any,change(),binding);assert.equal(canonicalize(c.original),before);assert(c.calls.some(s=>s.includes('pg_advisory_xact_lock')));assert(c.calls.some(s=>s.includes('FROM zzsh_iam.approval_request')));assert(c.calls.every(s=>s.startsWith('SELECT')));
});

async function withReadAccess(permissions:string[],fn:()=>Promise<void>,boss=false){
 const a=auth as any,s=supplyRoutes as any,g=scopes as any,e=earningRead as any,l=legacyFinance as any;
 const original=[a.assertAdminContextInTransaction,s.requireAdminAccess,g.readAdminGameScope,e.readAdminEarningCalculations,e.readAdminEarningEventActions,l.readAdminLegacyDutyFinances];
 a.assertAdminContextInTransaction=async()=>{};s.requireAdminAccess=async()=>access(permissions,boss);g.readAdminGameScope=async()=>({mode:'SELECTED_GAMES',gameIds:['game_1']});
 e.readAdminEarningCalculations=async()=>new Map([['earning_1',{knowledge:'KNOWN',policyVersion:'policy_1',levelCode:'BASE',percent:'3',baseCents:'10000',formula:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',reasonCodes:[]}]]);
 e.readAdminEarningEventActions=async()=>new Map([['event_1',{knowledge:'KNOWN',action:'ACCRUE',reasonCodes:[]}],['event_2',{knowledge:'KNOWN',action:'SETTLE',reasonCodes:[]}]]);
 l.readAdminLegacyDutyFinances=async()=>new Map([['duty_1',{dutyId:'duty_1',orderId:'legacy_1',kind:'COMMISSION',subjectId:'beneficiary_1',state:'SETTLED',knowledge:'KNOWN',amountCents:'0',finalization:'FINALIZED_ZERO',parentSourceId:'123',parentSourceDigest:'d'.repeat(64)}]]);
 try{await fn();}finally{[a.assertAdminContextInTransaction,s.requireAdminAccess,g.readAdminGameScope,e.readAdminEarningCalculations,e.readAdminEarningEventActions,l.readAdminLegacyDutyFinances]=original;}
}
function readClient(options:{outside?:boolean;missing?:boolean;wrongOrder?:boolean;legacy?:boolean}={}){
 const calls:Array<{sql:string;values:any[]}> = [];
 const c:any={query:async(sql:string,values:any[]=[])=>{calls.push({sql,values});
  if(sql.includes('bool_and(to_regclass'))return{rows:[{ready:!(options.missing&&String(values[0]).includes('rental_referral_earning'))}]};
  if(sql.includes('FROM zzsh_order.rental_order o WHERE')||sql.includes('FROM zzsh_order.legacy_order_read_snapshot o WHERE'))return{rows:options.outside?[]:[{id:options.legacy?'legacy_1':'order_1',number:'NO_1',source_system:'legacy_source',legacy_id:'123',source_digest:'d'.repeat(64)}]};
  if(sql.includes('FROM zzsh_order.rental_referral_earning e LEFT JOIN'))return{rows:[{id:'native:earning_1',origin:'NATIVE',earning_id:'earning_1',order_id:options.wrongOrder?'other_order':'order_1',beneficiary_user_id:'beneficiary_1',beneficiary_name:'受益人',role:'RENTER_REFERRAL',state:'SETTLED',source_amount:'300',occurred_at:'2026-10-26T08:00:00.000000Z',due_at:'2026-10-27T08:00:00.000000Z',funds_disposition:'SETTLED',recovery_required_cents:null,version:'2'}]};
  if(sql.includes('FROM zzsh_order.rental_referral_transition t LEFT JOIN'))return{rows:[{earning_id:'earning_1',event_id:'event_1',occurred_at:'2026-10-26T08:00:00.000000Z'},{earning_id:'earning_1',event_id:'event_2',occurred_at:'2026-10-27T08:00:00.000000Z'}]};
  if(sql.includes('FROM zzsh_order.personal_finance_observation'))return{rows:[]};
  throw Error('Unexpected model SQL');
 }};return{c,calls};
}
const actor={userId:'support_1',sessionId:'session_1'} as any;
test('S3D23 order reader sees this commission without finance.read but private base/profile links stay redacted',async()=>withReadAccess(['order.read'],async()=>{
 const {c,calls}=readClient(),v=await readAdminDistributionOrder(c,actor,{orderId:'order_1',origin:'NATIVE'});
 assert.equal(v.items[0]!.amountCents,'300');assert.equal(v.items[0]!.calculation.percent,'3');assert.equal(v.items[0]!.calculation.baseCents,null);assert.equal(v.items[0]!.beneficiary.userId,null);assert.equal(v.items[0]!.documentRef,null);assert.equal(v.items[0]!.events.length,2);assert.equal(v.items[0]!.channelArrival,'UNKNOWN');
 assert(calls.some(c=>c.sql.includes('game_scope_mode')&&c.values[1]==='support_1'));assert(calls.every(c=>! /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b|FOR SHARE|pg_advisory/i.test(c.sql)));
}));
test('finance field authority never substitutes exact order/game authority',async()=>{
 await withReadAccess(['finance.read'],async()=>{const {c,calls}=readClient();await assert.rejects(()=>readAdminDistributionOrder(c,actor,{orderId:'order_1',origin:'NATIVE'}));assert.equal(calls.length,0);});
 await withReadAccess(['order.read','finance.read'],async()=>{const {c}=readClient({outside:true});await assert.rejects(()=>readAdminDistributionOrder(c,actor,{orderId:'outside',origin:'NATIVE'}));});
});
test('read source missing is unavailable, source-order mismatch is rejected, zero is not silently invented',async()=>withReadAccess(['order.read'],async()=>{
 const {c}=readClient({missing:true}),v=await readAdminDistributionOrder(c,actor,{orderId:'order_1',origin:'NATIVE'});assert.equal(v.knowledge,'UNAVAILABLE');assert.equal(v.items.length,0);
 await assert.rejects(()=>readAdminDistributionOrder(readClient({wrongOrder:true}).c,actor,{orderId:'order_1',origin:'NATIVE'}),/binding differs/);
}));
test('legacy exact tuple remains separate, finalized zero is a real typed responsibility not a historical success claim',async()=>withReadAccess(['order.read','finance.read'],async()=>{
 const {c,calls}=readClient({legacy:true}),v=await readAdminDistributionOrder(c,actor,{orderId:'legacy_1',origin:'LEGACY'});
 assert.deepEqual(calls.find(c=>c.sql.includes('FROM zzsh_order.personal_finance_observation'))?.values,['legacy_source','123']);
 assert.equal(v.currentLegacyCommissions[0]!.amountCents,'0');assert.equal(v.currentLegacyCommissions[0]!.finalization,'FINALIZED_ZERO');assert(v.reasonCodes.includes('HISTORY_IS_OBSERVATION_NOT_CURRENT_COMMISSION'));
}));
test('relationship query keeps inviter and commission leader independent and requires directory authority',async()=>{
 await withReadAccess(['order.read'],async()=>{await assert.rejects(()=>readAdminDistributionRelations({query:async()=>{throw Error('must not query');}} as any,actor,'user_1'));});
 await withReadAccess(['user.directory.read','personal.distribution.policy.read'],async()=>{const c:any={query:async(sql:string)=>({rows:sql.startsWith('SELECT id FROM')?[{id:'user_1'}]:sql.includes('bool_and')?[{ready:true}]:sql.startsWith('SELECT eligibility')?[{eligibility:'ELIGIBLE',commission_frozen:false,level_code:'OLD_GOLD',inviter_knowledge:'KNOWN_PARENT',leader_knowledge:'UNKNOWN'}]:[{type:'INVITER',parent_user_id:'inviter_1',parent_name:'来源人',source_type:'NATIVE_REGISTRATION',policy_version_id:'old_policy'}]})};const v=await readAdminDistributionRelations(c,actor,'user_1');assert.equal(v.relations[0]!.knowledge,'KNOWN_PARENT');assert.equal(v.relations[1]!.knowledge,'UNKNOWN');assert.equal(v.relations[1]!.parentUserId,null);});
});

test('Boss keeps existing all-permission semantics while scoped support remains redacted',async()=>{
 await withReadAccess([],async()=>{const value=await readAdminDistributionOrder(readClient().c,actor,{orderId:'order_1',origin:'NATIVE'});assert.equal(value.items[0]!.calculation.baseCents,'10000');assert.equal(value.items[0]!.beneficiary.userId,'beneficiary_1');assert(value.items[0]!.documentRef);},true);
});

test('finance read does not by itself grant a document link, while document permission retains its own boundary',async()=>{
 await withReadAccess(['order.read','finance.read'],async()=>{const value=await readAdminDistributionOrder(readClient().c,actor,{orderId:'order_1',origin:'NATIVE'});assert.equal(value.items[0]!.calculation.baseCents,'10000');assert.equal(value.items[0]!.documentRef,null);});
 await withReadAccess(['order.read','finance.document.read'],async()=>{const value=await readAdminDistributionOrder(readClient().c,actor,{orderId:'order_1',origin:'NATIVE'});assert.equal(value.items[0]!.calculation.baseCents,null);assert.equal(value.items[0]!.documentRef,'DISTRIBUTION:earning_1');});
});


test('v1 disabled registration retains its old INELIGIBLE lifecycle before the v2 schema is installed',async()=>{
 const p=policyStore as any,oldRead=p.readRegistrationDistributionPolicyInTransaction;
 p.readRegistrationDistributionPolicyInTransaction=async()=>({knowledge:'KNOWN',policy:{versionId:'policy_legacy',config:validateDistributionPolicy(legacy)}});
 const calls:Array<{sql:string;values:any[]}>=[],c:any={query:async(sql:string,values:any[]=[])=>{calls.push({sql,values});if(sql.includes('AS complete,to_regclass'))return{rows:[{complete:true,protected_proof:true}]};if(sql.includes('SELECT user_id FROM'))return{rows:[]};if(sql.includes('inserted_in_transaction'))return{rows:[{id:'legacy_new',suspended:false,account_status:'ACTIVE',inserted_in_transaction:true}]};return{rows:sql.includes('RETURNING id')?[{id:'code'}]:[],rowCount:1};}};
 try{const value=await initializeNewDistributionRegistration(c,{userId:'legacy_new',requestId:'legacy_req'});assert.equal(value.eligibility,'INELIGIBLE');const inserted=calls.find(x=>x.sql.startsWith('INSERT INTO zzsh_order.distribution_participant'))!;assert.equal(inserted.values[1],'INELIGIBLE');assert.equal(inserted.values[2],'BASE');assert.equal(calls.some(x=>x.sql.includes('distribution_policy_contract_version')),false);}
 finally{p.readRegistrationDistributionPolicyInTransaction=oldRead;}
});

function lifecyclePool(){const calls:Array<{sql:string;values:any[]}>=[];const c:any={release(){},query:async(sql:string,values:any[]=[])=>{calls.push({sql,values});
 if(sql.includes('to_regclass'))return{rows:[{complete:true}]};
 if(sql.startsWith('SELECT * FROM zzsh_order.distribution_participant'))return{rows:[{user_id:'child',eligibility:'ELIGIBLE',commission_frozen:false,level_code:'BASE',leader_knowledge:'KNOWN_NONE',inviter_knowledge:'KNOWN_NONE',revision:'1'}]};
 if(sql.startsWith('SELECT display_code'))return{rows:[{display_code:'OWN',source_type:'NATIVE_REGISTRATION'}]};
 if(sql.startsWith('SELECT * FROM zzsh_order.distribution_invite_code'))return{rows:[{id:'code',display_code:'CODE',user_id:'parent',source_type:'NATIVE_REGISTRATION'}]};
 if(sql.startsWith('SELECT id FROM zzsh_auth_user'))return{rows:[{id:'child'},{id:'parent'}]};
 if(sql.startsWith('SELECT p.*,u.suspended'))return{rows:[{user_id:'parent',eligibility:'ELIGIBLE',commission_frozen:false,suspended:false,account_status:'ACTIVE'}]};
 if(sql.startsWith('WITH RECURSIVE chain'))return{rows:[{user_id:'parent',cyclic:false,leader_knowledge:'KNOWN_NONE',parent_user_id:null}]};
 return{rows:[],rowCount:1};}};return{pool:{connect:async()=>c} as any,calls};}

test('invitation read capability preserves disabled-v1 refusal while paused-v2 can bind',async()=>{
 const p=policyStore as any,u=userIdentity as any,oldRead=p.readInvitationPolicyInTransaction,oldAuth=u.assertUserContextInTransaction;
 u.assertUserContextInTransaction=async()=>{};
 try{for(const [config,expected]of [[validateDistributionPolicy(legacy),false],[validateDistributionPolicy({...legacy,enabled:true}),true],[validateDistributionPolicy({...flat,enabled:false}),true],[validateDistributionPolicy(flat),true]] as const){p.readInvitationPolicyInTransaction=async()=>({knowledge:'KNOWN',writeResourceAdmitted:true,policy:{versionId:'policy_model',config}});const f=lifecyclePool(),value=await invitationStore.readMyInvitations(f.pool,{userId:'child',sessionId:'session',requestId:'req'} as any);assert.equal(value.canBindLeader,expected);assert(f.calls.every(x=>!/^INSERT|^UPDATE|^DELETE/.test(x.sql)));}}
 finally{p.readInvitationPolicyInTransaction=oldRead;u.assertUserContextInTransaction=oldAuth;}
});

test('invitation write has the same version gate: v1 paused no relation write, v2 paused preserves legal binding',async()=>{
 const p=policyStore as any,u=userIdentity as any,oldRead=p.readActiveDistributionPolicyInTransaction,oldAuth=u.assertUserContextInTransaction;
 u.assertUserContextInTransaction=async()=>{};
 try{for(const [config,allowed]of [[validateDistributionPolicy(legacy),false],[validateDistributionPolicy({...flat,enabled:false}),true]] as const){p.readActiveDistributionPolicyInTransaction=async()=>({knowledge:'KNOWN',policy:{versionId:'policy_model',config}});const f=lifecyclePool(),action=()=>invitationStore.bindMyDistributionLeader(f.pool,{userId:'child',sessionId:'session',requestId:'req'} as any,{code:'CODE',policyVersion:'policy_model',expectedParticipantRevision:'1'},'stable_key');
 if(allowed){const result=await action();assert.equal((result.body as any).relation.parentUserId,'parent');assert.equal(f.calls.filter(x=>x.sql.startsWith('INSERT INTO zzsh_order.invitation_relation')).length,1);}
 else{await assert.rejects(action,(e:any)=>e.status===409);assert.equal(f.calls.some(x=>/^INSERT|^UPDATE|^DELETE/.test(x.sql)),false);}}}
 finally{p.readActiveDistributionPolicyInTransaction=oldRead;u.assertUserContextInTransaction=oldAuth;}
});


test('approved first uniform policy is explicit, scoped and cannot fake an existing head',()=>{
 const payload={schema:'distribution-policy-initialize.v1',config:{enabled:false,accountModes:['ordinary','custom'],minimumAccrualCents:'0',settlementDelayDays:7,renterPercent:'5',ownerPercent:'5'},reason:'首版明确配置'};
 const initial=parseDistributionPolicyChange(payload) as DistributionPolicyInitial;
 assert.deepEqual(initial,{...payload,reason:'首版明确配置'});
 const config=initialDistributionPolicyConfig(initial,'NATIVE');
 assert.equal(config.schema,'distribution-policy.v2');assert.equal(config.scope,'NATIVE');assert.equal(config.enabled,false);assert.deepEqual(config.levels,[]);assert.equal(config.renterPercent,'5');
 assert.equal(initialDistributionPolicyConfig(initial,'LOCAL_CONTROLLED').scope,'LOCAL_CONTROLLED');
 assert.throws(()=>initialDistributionPolicyConfig(parseDistributionPolicyChange({...payload,config:{...payload.config,renterPercent:'60',ownerPercent:'60'}}) as DistributionPolicyInitial,'NATIVE'));
 assert.throws(()=>parseDistributionPolicyChange({...payload,expectedPolicyId:'fake'}));
 assert.throws(()=>parseDistributionPolicyChange({...payload,config:{...payload.config,minimumAccrualCents:'-1'}}));
 assert.throws(()=>prepareDistributionPolicyChange(head,initial as never),/no baseline/);
});
