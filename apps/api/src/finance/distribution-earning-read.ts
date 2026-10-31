import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {withTransaction,SecurityApiError} from '../auth/security-core';
import {assertUserContextInTransaction,type UserContext} from '../auth/user-identity';
import {invalid,notFound} from '../supply/supply-util';
import {canonicalize} from '../supply/content-hash';
import type {ListingCursorKey} from '../supply/listing-cursor';
import {exactCents,sourceYuanToCents,encodeFinanceCursor,decodeFinanceCursor,OPENING_OBSERVATION_JOIN,prepareHistoricalObservation,parseFinanceProjectionVersion} from './personal-finance-read';
import {hasProvedNativeHistoryAbsence,readObservationCoverage} from './personal-finance-coverage';
import {readLegacyCommissionFinance,readLegacyCommissionFinanceVersion,readLegacyCommissionResponsibility,readLegacyCommissionResponsibilityVersion,type LegacyCommissionFinance,type LegacyCommissionResponsibility} from './legacy-duty-finance-store';
import {readOriginalPaymentDistributionBasis,type PaymentDistributionBasis} from './distribution-payment-basis';
import {distributionPolicyRates,referralPercent,validateDistributionPolicy} from './distribution-policy';
import {prepareAccrualFromFrozenPayment} from './distribution-accrual';

const states=['ALL','PENDING','SETTLED','REVOKED','RECOVERY_REQUIRED','EXPIRED'] as const;
export type EarningsQuery={state:typeof states[number];limit:number;cursor:string|null;projectionVersion?:2;calculationVersion?:2};
export function parseEarningsQuery(q:URLSearchParams):EarningsQuery{
 for(const k of q.keys())if(!['state','limit','cursor','projectionVersion'].includes(k)||q.getAll(k).length!==1)throw invalid('Unsupported earnings query');
 const state=q.get('state')??'ALL',limit=q.get('limit')??'20';
 if(!states.includes(state as EarningsQuery['state'])||!/^[1-9]\d?$/.test(limit)||Number(limit)>50)throw invalid('Invalid earnings query');
 return{state:state as EarningsQuery['state'],limit:Number(limit),cursor:q.get('cursor'),...(parseFinanceProjectionVersion(q)===2?{projectionVersion:2 as const}:{})};
}
export function parseEarningsDetailQuery(q:URLSearchParams):EarningsQuery{for(const k of q.keys())if(!['projectionVersion','calculationVersion'].includes(k)||q.getAll(k).length!==1)throw invalid('Unsupported earning detail query');const calculation=q.get('calculationVersion');if(calculation!==null&&calculation!=='2')throw invalid('Unsupported earning calculation version');const base=new URLSearchParams(q);base.delete('calculationVersion');return{...parseEarningsQuery(base),...(calculation==='2'?{calculationVersion:2 as const}:{})};}
export function decodeEarningDetailId(raw:string){let id:string;try{id=decodeURIComponent(raw);}catch{throw notFound();}if(!/^(native|history):[A-Za-z0-9_-]{1,180}$/.test(id))throw notFound();return id;}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const unavailable=()=>new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Original earning evidence is inconsistent');
export type EarningCalculation={knowledge:'NOT_RECORDED'|'UNKNOWN';reason:string}|{
 knowledge:'KNOWN';policyVersion:string;beneficiaryLevelCode:string|null;rateMode?:'UNIFORM';percent:string;basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE';
 baseDisclosure:'INTERNAL_SETTLEMENT_ONLY';rounding:'HALF_UP_CENT';cap:'COMBINED_ROLES_NOT_ABOVE_BASE';scope:'LOCAL_CONTROLLED'|'NATIVE';orderNumber:string|null;
};
function verifiedFrozenCalculation(f:Record<string,any>){
 if(hash(f.canonical_seed)!==f.seed_digest||f.basis_digest!==f.payment_basis_digest)throw unavailable();
 const seed=JSON.parse(f.canonical_seed),basis={...JSON.parse(f.canonical_basis),digest:f.payment_basis_digest} as PaymentDistributionBasis;
 readOriginalPaymentDistributionBasis(basis,{orderId:f.order_id,confirmationId:f.payment_confirmation_id,paymentDigest:basis.paymentDigest});
 if(seed.id!==f.id||seed.beneficiaryUserId!==f.beneficiary_user_id||seed.role!==f.beneficiary_role||seed.amountCents!==exactCents(f.amount_cents)
  ||seed.source?.id!==f.order_id||seed.source?.digest!==f.posting_digest||seed.policyVersion!==basis.policyVersion||seed.policyDigest!==basis.policyDigest
  ||!basis.policyVersion||!basis.policyConfig||hash(canonicalize(basis.policyConfig))!==basis.policyDigest)throw unavailable();
 const policy=validateDistributionPolicy(basis.policyConfig as unknown as Record<string,unknown>);
 const roles=basis.roles.filter(r=>r.role===f.beneficiary_role&&r.beneficiaryUserId===f.beneficiary_user_id);
 if(roles.length!==1)throw unavailable();const role=roles[0]!;
 const rates=distributionPolicyRates(policy,role.levelCode),level=policy.schema==='distribution-policy.v2'?{code:null}:policy.levels.find(l=>l.code===role.levelCode),percent=referralPercent(role.percent);
 if(role.status!=='ELIGIBLE'||!level||!rates||role.levelCode!==rates.levelCode||!role.ratio||canonicalize(role.ratio)!==canonicalize(percent.ratio)||seed.relationDigest!==role.relationDigest
  ||referralPercent(role.role==='RENTER_REFERRAL'?rates.renterPercent:rates.ownerPercent).percent!==percent.percent)throw unavailable();
 return{seed,basis,level,percent,policy,policyVersion:basis.policyVersion,...(policy.schema==='distribution-policy.v2'?{rateMode:'UNIFORM' as const}:{})};
}
/** Only the beneficiary's frozen terms; the private posting/base and other parties never leave this reader. */
export async function readEarningCalculation(c:PoolClient,actor:UserContext,row:Record<string,any>,installed:boolean,calculationVersion:1|2=1):Promise<EarningCalculation>{
 if(row.origin==='LEGACY_MYSQL')return{knowledge:'NOT_RECORDED',reason:'HISTORICAL_CALCULATION_NOT_RECORDED'};
 if(!installed)return{knowledge:'UNKNOWN',reason:'ORIGINAL_BASIS_UNAVAILABLE'};
 const f=(await c.query(`SELECT e.id,e.order_id,e.payment_confirmation_id,e.beneficiary_user_id,e.beneficiary_role,e.amount_cents::text,
  e.canonical_seed,e.seed_digest,e.basis_digest,e.posting_digest,b.canonical_basis,b.basis_digest AS payment_basis_digest,
  CASE WHEN o.renter_user_id=$1 OR o.owner_user_id=$1 THEN o.display_no ELSE NULL END AS order_number
  FROM zzsh_order.rental_referral_earning e
  LEFT JOIN zzsh_order.payment_distribution_basis b ON b.order_id=e.order_id AND b.payment_confirmation_id=e.payment_confirmation_id
  LEFT JOIN zzsh_order.rental_order o ON o.id=e.order_id
  WHERE e.beneficiary_user_id=$1 AND e.id=$2`,[actor.userId,row.id.slice('native:'.length)])).rows[0];
 if(!f?.canonical_basis)return{knowledge:'UNKNOWN',reason:'ORIGINAL_BASIS_UNAVAILABLE'};
 try{
  if(f.beneficiary_user_id!==actor.userId||`native:${f.id}`!==row.id||f.order_id!==row.order_id||f.beneficiary_role!==row.role||exactCents(f.amount_cents)!==exactCents(row.source_amount)
   )throw unavailable();
  const {policyVersion,level,percent,rateMode,policy}=verifiedFrozenCalculation(f);
  if(rateMode==='UNIFORM'&&calculationVersion!==2)return{knowledge:'UNKNOWN',reason:'UNIFORM_CALCULATION_REQUIRES_VERSION_2'};
  return{knowledge:'KNOWN',policyVersion,beneficiaryLevelCode:level.code,...(rateMode?{rateMode}:{}),percent:percent.percent,
   basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',
   cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:policy.scope,orderNumber:typeof f.order_number==='string'&&f.order_number.length<=80?f.order_number:null};
 }catch{return{knowledge:'UNKNOWN',reason:'FROZEN_CALCULATION_NOT_VERIFIED'};}
}
export type AdminEarningCalculation={knowledge:'KNOWN'|'UNKNOWN';policyVersion:string|null;levelCode:string|null;percent:string|null;baseCents:string|null;formula:string|null;rateMode?:'UNIFORM';reasonCodes:string[]};
export type AdminEarningEventAction={knowledge:'KNOWN'|'UNKNOWN';action:'ACCRUE'|'SETTLE'|'REVOKE'|'RECOVER'|null;reasonCodes:string[]};
const unknownCalculation=(reason:string):AdminEarningCalculation=>({knowledge:'UNKNOWN',policyVersion:null,levelCode:null,percent:null,baseCents:null,formula:null,reasonCodes:[reason]});
function readKeys(ids:string[]){
 if(ids.length>20000||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(id)))throw invalid('Bounded original finance keys required');
 return[...new Set(ids)];
}
/** The caller supplies only already-authorized page roots and the current transaction client. */
export async function readAdminEarningCalculations(c:PoolClient,earningRootIds:string[]):Promise<Map<string,AdminEarningCalculation>>{
 const ids=readKeys(earningRootIds),result=new Map(ids.map(id=>[id,unknownCalculation('ORIGINAL_BASIS_UNAVAILABLE')]));if(!ids.length)return result;
 const rows=(await c.query(`SELECT e.id,e.order_id,e.payment_confirmation_id,e.posting_id,e.economic_key,e.beneficiary_user_id,e.beneficiary_role,e.amount_cents::text,
  e.canonical_seed,e.seed_digest,e.basis_digest,e.posting_digest,b.canonical_basis,b.basis_digest AS payment_basis_digest,
  CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'order_id',p.order_id,'payment_confirmation_id',p.payment_confirmation_id,
   'version_hash',p.version_hash,'early',p.early,'manual_reason',p.manual_reason,'captured_cents',p.captured_cents::text,'owner_net_cents',p.owner_net_cents::text,
   'renter_refund_cents',p.renter_refund_cents::text,'platform_contribution_cents',p.platform_contribution_cents::text,'compensation_fee_cents',p.compensation_fee_cents::text,
   'posted_at',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) END AS posting
  FROM zzsh_order.rental_referral_earning e
  LEFT JOIN zzsh_order.payment_distribution_basis b ON b.order_id=e.order_id AND b.payment_confirmation_id=e.payment_confirmation_id
  LEFT JOIN zzsh_order.settlement_posting p ON p.id=e.posting_id AND p.order_id=e.order_id AND p.payment_confirmation_id=e.payment_confirmation_id
  WHERE e.id=ANY($1::text[])`,[ids])).rows;
 const seen=new Set<string>();
 for(const f of rows){
  if(!result.has(f.id))continue;
  if(seen.has(f.id)){result.set(f.id,unknownCalculation('AMBIGUOUS_ORIGINAL_BASIS'));continue;}seen.add(f.id);
  if(!f.canonical_basis||!f.posting)continue;
  try{
   const {seed,basis,level,percent,rateMode}=verifiedFrozenCalculation(f),p=f.posting;
   if(p.id!==f.posting_id||p.order_id!==f.order_id||p.payment_confirmation_id!==f.payment_confirmation_id||hash(canonicalize(p))!==f.posting_digest
    ||typeof p.early!=='boolean'||p.manual_reason!==null&&typeof p.manual_reason!=='string')throw unavailable();
   const allocation=prepareAccrualFromFrozenPayment(basis,{origin:'NATIVE',orderId:f.order_id,confirmationId:f.payment_confirmation_id,postingId:p.id,
    postingDigest:f.posting_digest,postedAt:p.posted_at,classification:p.early?'EARLY':'NORMAL',calculationMode:p.manual_reason===null?'SYSTEM':'MANUAL',
    capturedCents:p.captured_cents,ownerNetCents:p.owner_net_cents,renterRefundCents:p.renter_refund_cents,platformContributionCents:p.platform_contribution_cents,compensationFeeCents:p.compensation_fee_cents});
   if(allocation.knowledge!=='KNOWN'||seed.baseDigest!==allocation.digest)throw unavailable();
   const items=allocation.items.filter(item=>item.beneficiaryUserId===f.beneficiary_user_id&&item.role===f.beneficiary_role);
   if(items.length!==1)throw unavailable();const item=items[0]!;
   if(item.amountCents!==exactCents(f.amount_cents)||item.economicKey!==f.economic_key||seed.economicKey!==item.economicKey||seed.dueAt!==item.dueAt)throw unavailable();
   result.set(f.id,{knowledge:'KNOWN',policyVersion:basis.policyVersion,levelCode:level.code,...(rateMode?{rateMode}:{}),percent:percent.percent,baseCents:allocation.baseCents,
    formula:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',reasonCodes:[]});
  }catch{result.set(f.id,unknownCalculation('FROZEN_CALCULATION_NOT_VERIFIED'));}
 }
 return result;
}
/** RECOVER and REVOKE share the ledger kind; only the original transition distinguishes them. */
export async function readAdminEarningEventActions(c:PoolClient,eventIds:string[]):Promise<Map<string,AdminEarningEventAction>>{
 const ids=readKeys(eventIds),result=new Map<string,AdminEarningEventAction>(ids.map(id=>[id,{knowledge:'UNKNOWN',action:null,reasonCodes:['ORIGINAL_TRANSITION_UNAVAILABLE']}]));if(!ids.length)return result;
 const rows=(await c.query(`SELECT t.finance_event_id AS event_id,t.earning_id,t.action,t.expected_version::text,t.result_version::text,t.source_digest,
  e.economic_root_id,e.kind,e.subject_user_id,r.beneficiary_user_id
  FROM zzsh_order.rental_referral_transition t LEFT JOIN zzsh_order.finance_event e ON e.id=t.finance_event_id
  LEFT JOIN zzsh_order.rental_referral_earning r ON r.id=t.earning_id WHERE t.finance_event_id=ANY($1::text[])`,[ids])).rows;
 const seen=new Set<string>(),kinds:Record<string,string>={ACCRUE:'EARNING_PENDING',SETTLE:'EARNING_SETTLED',REVOKE:'EARNING_REVOKED',RECOVER:'EARNING_REVOKED'};
 for(const row of rows){
  if(!result.has(row.event_id))continue;
  const duplicate=seen.has(row.event_id);seen.add(row.event_id);
  if(duplicate||!Object.hasOwn(kinds,row.action)||row.kind!==kinds[row.action]||row.economic_root_id!==row.earning_id
   ||!row.beneficiary_user_id||row.subject_user_id!==row.beneficiary_user_id||!/^[0-9a-f]{64}$/.test(row.source_digest)
   ||!/^(0|[1-9]\d{0,18})$/.test(row.expected_version)||!/^[1-9]\d{0,18}$/.test(row.result_version)
   ||BigInt(row.result_version)!==BigInt(row.expected_version)+1n||(row.action==='ACCRUE')!==(row.expected_version==='0')){
   result.set(row.event_id,{knowledge:'UNKNOWN',action:null,reasonCodes:[duplicate?'AMBIGUOUS_ORIGINAL_TRANSITION':'ORIGINAL_TRANSITION_NOT_VERIFIED']});continue;
  }
  result.set(row.event_id,{knowledge:'KNOWN',action:row.action,reasonCodes:[]});
 }
 return result;
}
/** History is an observation, never a fresh ledger credit or a channel-paid claim. */
export function earningProjection(row:Record<string,any>,currentFinance?:LegacyCommissionFinance,projectionVersion:1|2=1,currentResponsibility?:LegacyCommissionResponsibility){
 const legacy=row.origin==='LEGACY_MYSQL';if(!legacy&&row.origin!=='NATIVE')throw unavailable();
 if(legacy){
  try{
   const snapshot=JSON.parse(row.source_canonical),p=prepareHistoricalObservation(snapshot,{userId:row.user_id,legacyUserId:row.legacy_user_id,sourceSystem:row.source_system,basisId:null});
   if(p.sourceKind!=='HISTORICAL_DISTRIBUTION'||p.sourceEntity!==row.source_entity||p.sourceId!==row.source_id||p.sourceDigest!==row.source_digest||p.sourceCanonical!==row.source_canonical
    ||canonicalize(row.snapshot)!==p.sourceCanonical||snapshot.amount!==row.source_amount||String(snapshot.orderId)!==row.order_id||row.state!==({1:'PENDING',2:'SETTLED',3:'EXPIRED'} as Record<number,string>)[snapshot.sourceStatus]
    ||row.role!==({1:'TASK_REFERRAL',2:'RENTER_REFERRAL',3:'OWNER_REFERRAL'} as Record<number,string>)[snapshot.level]
    ||new Date(row.occurred_at).getTime()!==Date.parse(p.sourceEventAt))throw unavailable();
  }catch{throw unavailable();}
 }
 let amount:string;try{amount=legacy?sourceYuanToCents(row.source_amount):exactCents(row.source_amount);}catch{throw unavailable();}
 if(BigInt(amount)<0n||!states.includes(row.state)||row.state==='ALL')throw unavailable();
 if(legacy&&!['PENDING','SETTLED','EXPIRED'].includes(row.state)||!legacy&&row.state==='EXPIRED')throw unavailable();
 const debt=row.recovery_required_cents===null?null:exactCents(row.recovery_required_cents);
 if(legacy&&debt!==null||!legacy&&(!['RENTER_REFERRAL','OWNER_REFERRAL'].includes(row.role)||typeof row.due_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.due_at)||!/^\d+$/.test(String(row.version))||BigInt(row.version)<1n))throw unavailable();
 if(!legacy&&(row.state==='RECOVERY_REQUIRED'?(row.funds_disposition!=='SETTLED'||debt!==amount||BigInt(amount)<=0n):debt!==null))throw unavailable();
 if(!legacy&&row.state!=='RECOVERY_REQUIRED'&&row.funds_disposition!==row.state)throw unavailable();
 return{id:row.id,origin:row.origin,state:row.state,role:row.role??'UNKNOWN',amount:{currency:'CNY',unit:'cent',amountCents:amount},
  occurredAt:row.occurred_at,dueAt:legacy?null:row.due_at,dueAtKnowledge:legacy?'UNKNOWN':'KNOWN',
  fundsDisposition:legacy?'HISTORICAL_STATUS_ONLY':row.funds_disposition,recoveryRequiredCents:debt,
  includedInOpening:legacy?row.included===true:false,version:legacy?null:String(row.version),
  accountingEffect:legacy?'OBSERVATION_ONLY_NO_NEW_CREDIT':'EXISTING_LEDGER_EVENT',
  businessReference:{type:legacy?'LEGACY_UNRESOLVED':'RENTAL_ORDER',id:row.order_id??null},channelArrivalKnowledge:'UNKNOWN',...(projectionVersion===2?{currentFinance:legacy?currentFinance??{knowledge:'UNKNOWN' as const,reason:'LEGACY_FINANCE_NOT_ADMITTED_OR_NOT_FINALIZED'}:null,currentResponsibility:legacy?currentResponsibility??{knowledge:'UNKNOWN' as const,reason:'LEGACY_RESPONSIBILITY_NOT_ADMITTED'}:null}:{})};
}
function sourceSql(native:boolean){
 const history=`SELECT 'history:'||o.id AS id,'LEGACY_MYSQL'::text AS origin,
  CASE o.snapshot->>'sourceStatus' WHEN '1' THEN 'PENDING' WHEN '2' THEN 'SETTLED' WHEN '3' THEN 'EXPIRED' ELSE 'UNKNOWN' END AS state,
  CASE o.snapshot->>'level' WHEN '1' THEN 'TASK_REFERRAL' WHEN '2' THEN 'RENTER_REFERRAL' WHEN '3' THEN 'OWNER_REFERRAL' ELSE 'UNKNOWN' END AS role,
  o.snapshot->>'amount' AS source_amount,o.source_event_at AS occurred_at,NULL::timestamptz AS due_at,
  'HISTORICAL_STATUS_ONLY'::text AS funds_disposition,NULL::text AS recovery_required_cents,COALESCE(oa.included_in_opening,o.included_in_opening) AS included,
  '0'::text AS version,o.snapshot->>'orderId' AS order_id,o.source_digest,o.imported_at,
  o.user_id,o.legacy_user_id,o.source_system,o.source_entity,o.source_id,o.source_canonical,o.snapshot
  FROM zzsh_order.personal_finance_observation o ${OPENING_OBSERVATION_JOIN} WHERE o.user_id=$1 AND o.source_kind='HISTORICAL_DISTRIBUTION' AND o.source_entity='la_distribution_order'`;
 const current=`SELECT 'native:'||e.id,'NATIVE',e.state,e.beneficiary_role,e.amount_cents::text,e.created_at,e.due_at,
  e.funds_disposition,e.recovery_required_cents::text,false,e.version::text,e.order_id,e.seed_digest,e.created_at,
  NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::jsonb
  FROM zzsh_order.rental_referral_earning e WHERE e.beneficiary_user_id=$1`;
 return`WITH earnings AS (${history}${native?' UNION ALL '+current:''}) `;
}
/** Candidate self read seam; route mounting requires the separately reviewed source package. */
type EarningReadContext={contractVersion:string;projectionVersion?:2;subjectId:string;snapshotVersion:string;asOf:string};
type EarningReadDetail=EarningReadContext&{item:ReturnType<typeof earningProjection>&{calculation?:EarningCalculation}};
type EarningReadPage=EarningReadContext&{state:EarningsQuery['state'];knowledge:string;count:string|null;mappedRecordCount:string;reason:string|null;totalAmountKnowledge:string;items:ReturnType<typeof earningProjection>[];nextCursor:string|null; amountsByOrigin?:{scope:string;native:{knowledge:string;amountCents:string|null};historical:{knowledge:string;amountCents:string|null};mappedHistoricalAmountCents:string}};
export function readMyDistributionEarnings(pool:Pool,actor:UserContext,q:EarningsQuery,key:ListingCursorKey|undefined,detailId:string):Promise<EarningReadDetail>;
export function readMyDistributionEarnings(pool:Pool,actor:UserContext,q:EarningsQuery,key:ListingCursorKey|undefined,detailId?:undefined):Promise<EarningReadPage>;
export function readMyDistributionEarnings(pool:Pool,actor:UserContext,q:EarningsQuery,key:ListingCursorKey|undefined,detailId?:string):Promise<EarningReadPage|EarningReadDetail>;
export async function readMyDistributionEarnings(pool:Pool,actor:UserContext,q:EarningsQuery,key:ListingCursorKey|undefined,detailId?:string):Promise<EarningReadPage|EarningReadDetail>{
 const projectionVersion=q.projectionVersion??1;if(![1,2].includes(projectionVersion))throw invalid('Unsupported earnings projection version');
 if(detailId!==undefined&&!/^(native|history):[A-Za-z0-9_-]{1,180}$/.test(detailId))throw notFound();
 return withTransaction(pool,async c=>{
  if(projectionVersion===2)await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await assertUserContextInTransaction(c,actor);
  const installed=(await c.query("SELECT to_regclass('zzsh_order.personal_finance_observation') IS NOT NULL AS history,to_regclass('zzsh_order.rental_referral_earning') IS NOT NULL AS native,to_regclass('zzsh_order.wallet_coverage') IS NOT NULL AND to_regclass('zzsh_order.finance_opening_basis') IS NOT NULL AND to_regclass('zzsh_order.native_user_insert_proof') IS NOT NULL AS native_origin,to_regclass('zzsh_order.legacy_duty_finance_fact') IS NOT NULL AND to_regclass('zzsh_order.legacy_order_duty') IS NOT NULL AS legacy_finance,to_regclass('zzsh_order.payment_distribution_basis') IS NOT NULL AS earning_basis")).rows[0];
  if(!installed?.history)throw unavailable();const sql=sourceSql(installed.native===true);
  const coverage=(await c.query('SELECT origin FROM zzsh_order.wallet_coverage WHERE user_id=$1',[actor.userId])).rows[0];
  const nativeEmpty=installed.native_origin===true&&coverage?.origin==='NATIVE_GENESIS'?await hasProvedNativeHistoryAbsence(c,actor.userId,'HISTORICAL_DISTRIBUTION'):false;
  const historyCoverage=nativeEmpty?null:await readObservationCoverage(c,actor.userId,'HISTORICAL_DISTRIBUTION');
  const complete=installed.native===true&&(nativeEmpty||historyCoverage?.knowledge==='KNOWN');
  const aggregate=(await c.query(sql+`SELECT count(*)::text AS count,md5(COALESCE(string_agg(id||':'||version||':'||source_digest,',' ORDER BY id),'')) AS digest${projectionVersion===2?`,
   COALESCE(sum(source_amount::numeric) FILTER(WHERE origin='NATIVE'),0)::numeric(24,0)::text AS native_amount_cents,
   COALESCE(sum(source_amount::numeric*100) FILTER(WHERE origin='LEGACY_MYSQL'),0)::numeric(24,0)::text AS historical_amount_cents`:''}
   FROM earnings WHERE ($2='ALL' OR state=$2)`,[actor.userId,q.state])).rows[0];
  const nativeAmount=projectionVersion===2?exactCents(aggregate.native_amount_cents):'0',historicalAmount=projectionVersion===2?exactCents(aggregate.historical_amount_cents):'0';
  if(BigInt(nativeAmount)<0n||BigInt(historicalAmount)<0n)throw unavailable();
  const legacyFinanceVersion=projectionVersion===2&&installed.legacy_finance===true?await readLegacyCommissionFinanceVersion(c,actor.userId):'NOT_ADMITTED';
  const legacyResponsibilityVersion=projectionVersion===2&&installed.legacy_finance===true?await readLegacyCommissionResponsibilityVersion(c,actor.userId):'NOT_ADMITTED';
  const snapshotVersion='distribution-earnings.v1:'+hash(canonicalize([aggregate.count,aggregate.digest,installed.native,coverage?.origin??null,historyCoverage?.version??null,...(projectionVersion===2?['projection2',nativeAmount,historicalAmount,legacyFinanceVersion,legacyResponsibilityVersion]:[])]));
  const binding={userId:actor.userId,sessionHash:hash(actor.sessionId),snapshotVersion,bucket:'DISTRIBUTION_EARNINGS:'+q.state};
  const after=q.cursor?decodeFinanceCursor(q.cursor,binding,key):null;
  const asOf=after?.asOf??(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
  const projection=`SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
   to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_at FROM earnings`;
  if(detailId){const row=(await c.query(sql+projection+' WHERE id=$2',[actor.userId,detailId])).rows[0];if(!row)throw notFound();const finance=projectionVersion===2&&installed.legacy_finance===true&&row.origin==='LEGACY_MYSQL'?await readLegacyCommissionFinance(c,actor.userId,[row.source_id]):null;const responsibility=projectionVersion===2&&installed.legacy_finance===true&&row.origin==='LEGACY_MYSQL'?await readLegacyCommissionResponsibility(c,actor.userId,[row.source_id]):null;return{contractVersion:'distribution-earnings.read.v1',...(projectionVersion===2?{projectionVersion:2 as const}:{}),subjectId:actor.userId,snapshotVersion,asOf,item:{...earningProjection(row,finance?.get(row.source_id),projectionVersion,responsibility?.get(row.source_id)),...(projectionVersion===2?{calculation:await readEarningCalculation(c,actor,row,installed.earning_basis===true,q.calculationVersion??1)}:{})}};}
  const rows=(await c.query(sql+projection+` WHERE imported_at<=$2::timestamptz AND($3='ALL' OR state=$3)
   AND($4::timestamptz IS NULL OR (earnings.occurred_at,id COLLATE "C")<($4::timestamptz,$5 COLLATE "C"))
   ORDER BY earnings.occurred_at DESC,id COLLATE "C" DESC LIMIT $6`,[actor.userId,asOf,q.state,after?.position.at??null,after?.position.id??null,q.limit+1])).rows;
  const visible=rows.slice(0,q.limit),last=visible.at(-1);
  const finance=projectionVersion===2&&installed.legacy_finance===true?await readLegacyCommissionFinance(c,actor.userId,visible.filter(r=>r.origin==='LEGACY_MYSQL').map(r=>r.source_id)):null;
  const responsibility=projectionVersion===2&&installed.legacy_finance===true?await readLegacyCommissionResponsibility(c,actor.userId,visible.filter(r=>r.origin==='LEGACY_MYSQL').map(r=>r.source_id)):null;
  return{contractVersion:'distribution-earnings.read.v1',subjectId:actor.userId,snapshotVersion,asOf,state:q.state,
   knowledge:complete?'KNOWN':'UNKNOWN',count:complete?aggregate.count:null,mappedRecordCount:aggregate.count,
   reason:complete?null:installed.native?historyCoverage?.reason??'HISTORICAL_EARNINGS_COVERAGE_NOT_CLOSED':'NATIVE_EARNINGS_NOT_INSTALLED',
   totalAmountKnowledge:projectionVersion===2&&complete?'KNOWN':'UNKNOWN',
   ...(projectionVersion===2?{projectionVersion:2 as const,amountsByOrigin:{scope:'SOURCE_RECORDS_ONLY',native:{knowledge:installed.native===true?'KNOWN':'UNKNOWN',amountCents:installed.native===true?nativeAmount:null},
    historical:{knowledge:nativeEmpty||historyCoverage?.knowledge==='KNOWN'?'KNOWN':'UNKNOWN',amountCents:nativeEmpty||historyCoverage?.knowledge==='KNOWN'?historicalAmount:null},mappedHistoricalAmountCents:historicalAmount}}:{}),
   items:visible.map(row=>earningProjection(row,finance?.get(row.source_id),projectionVersion,responsibility?.get(row.source_id))),
   nextCursor:rows.length>q.limit&&last?encodeFinanceCursor({id:last.id,at:last.occurred_at},asOf,binding,key):null};
 });
}
