import {createHash} from 'node:crypto';
import {canonicalize,normalizeTime} from '../supply/content-hash';
import {conflict,invalid} from '../supply/supply-util';
import {allocateFrozenReferralPair,referralPercent,validateDistributionPolicy,type DistributionPolicyConfig,type ReferralRatio} from './distribution-policy';
import type {RentalReferralRole} from './distribution-mechanism';

export type PaymentReferralParticipant={userId:string;active:boolean|null;eligibility:'ELIGIBLE'|'INELIGIBLE'|'UNKNOWN';commissionFrozen:boolean|null;levelCode:string|null};
export type PaymentReferralRelation={knowledge:'KNOWN_NONE'|'KNOWN_PARENT'|'UNKNOWN';id:string|null;childUserId:string;parentUserId:string|null;sourceDigest:string|null};
export type PaymentReferralFacts={role:RentalReferralRole;partyUserId:string;relation:PaymentReferralRelation;beneficiary:PaymentReferralParticipant|null};
export type FrozenReferralStatus='ELIGIBLE'|'SKIPPED_DISABLED'|'SKIPPED_FAST'|'SKIPPED_MODE'|'SKIPPED_NO_PARENT'|'SKIPPED_INELIGIBLE'|'SKIPPED_BELOW_MIN'|'UNKNOWN_POLICY'|'UNKNOWN_MODE'|'UNKNOWN_RELATION'|'UNKNOWN_PARTICIPANT'|'UNKNOWN_LEVEL'|'UNKNOWN_ESTIMATE'|'UNKNOWN_ESTIMATE_CONSERVATION';
export type FrozenReferralRole={role:RentalReferralRole;partyUserId:string;status:FrozenReferralStatus;beneficiaryUserId:string|null;relationId:string|null;relationDigest:string|null;levelCode:string|null;percent:string|null;ratio:ReferralRatio|null;estimatedCents:string|null};
export type PaymentDistributionBasis={schema:'payment-distribution-basis.v1';orderId:string;gameId:string;currency:'CNY';confirmationId:string;acceptedAt:string;paymentDigest:string;admissionId:string;admissionRevision:string;policyVersion:string|null;policyDigest:string|null;policyConfig:DistributionPolicyConfig|null;accountMode:string|null;estimateBaseCents:string|null;estimateDigest:string|null;roles:FrozenReferralRole[];digest:string};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),id=(v:string)=>{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v))throw invalid('Original payment basis identifier required');return v;},digest=(v:string)=>{if(!/^[0-9a-f]{64}$/.test(v))throw invalid('Original source digest required');return v;};

/** Server-read facts only. This freezes eligibility/ratios; it creates no money or ledger plan. */
export function freezePaymentDistributionBasis(input:{orderId:string;gameId:string;currency:'CNY';confirmationId:string;acceptedAt:string;paymentDigest:string;admissionId:string;admissionRevision:string;origin:'NATIVE'|'LEGACY_MYSQL'|'UNKNOWN';accountMode:string|null;estimate:{baseCents:string;sourceDigest:string}|null;policy:{versionId:string;digest:string;config:DistributionPolicyConfig}|null;facts:PaymentReferralFacts[]}):PaymentDistributionBasis{
 if(input.origin!=='NATIVE')throw conflict('Historical or unknown-origin payment cannot acquire a new distribution basis');
 for(const value of [input.orderId,input.gameId,input.confirmationId,input.admissionId])id(value);if(input.currency!=='CNY')throw invalid('Unsupported original payment currency');digest(input.paymentDigest);if(!/^[1-9]\d{0,18}$/.test(input.admissionRevision))throw invalid('Exact admission revision required');
 if(input.accountMode!==null&&!/^[a-z][a-z0-9_-]{0,63}$/.test(input.accountMode))throw invalid('Original account mode required');
 const acceptedAt=normalizeTime(input.acceptedAt);if(acceptedAt===null)throw invalid('Original payment acceptance time required');if(input.facts.length!==2||new Set(input.facts.map(f=>f.role)).size!==2||input.facts.some(f=>!['RENTER_REFERRAL','OWNER_REFERRAL'].includes(f.role)))throw invalid('Exactly the two rental referral roles required');
 let policy:DistributionPolicyConfig|null=null;if(input.policy){id(input.policy.versionId);digest(input.policy.digest);policy=validateDistributionPolicy(structuredClone(input.policy.config));if(sha(canonicalize(policy))!==input.policy.digest)throw conflict('Immutable policy digest changed');}
 if(input.estimate){if(!/^(0|[1-9]\d{0,23})$/.test(input.estimate.baseCents))throw invalid('Exact nonnegative source estimate required');digest(input.estimate.sourceDigest);}
 const roles:FrozenReferralRole[]=input.facts.map(f=>{
  id(f.partyUserId);const r=f.relation,b=f.beneficiary,row:FrozenReferralRole={role:f.role,partyUserId:f.partyUserId,status:'UNKNOWN_POLICY',beneficiaryUserId:b?.userId??null,relationId:r.id,relationDigest:r.sourceDigest,levelCode:b?.levelCode??null,percent:null,ratio:null,estimatedCents:null};
  if(!policy)return row;
  if(!policy.enabled)return{...row,status:'SKIPPED_DISABLED'};
  if(input.accountMode===null)return{...row,status:'UNKNOWN_MODE'};
  if(input.accountMode==='fast')return{...row,status:'SKIPPED_FAST'};
  if(!policy.accountModes.includes(input.accountMode as 'ordinary'|'custom'))return{...row,status:'SKIPPED_MODE'};
  if(r.childUserId!==f.partyUserId||r.knowledge==='UNKNOWN')return{...row,status:'UNKNOWN_RELATION'};
  if(r.knowledge==='KNOWN_NONE')return{...row,status:r.id===null&&r.parentUserId===null&&b===null?'SKIPPED_NO_PARENT':'UNKNOWN_RELATION'};
  if(r.knowledge!=='KNOWN_PARENT'||!r.id||!r.parentUserId||!r.sourceDigest||r.parentUserId===f.partyUserId)return{...row,status:'UNKNOWN_RELATION'};
  id(r.id);id(r.parentUserId);digest(r.sourceDigest);
  if(!b||b.userId!==r.parentUserId||b.active===null||b.eligibility==='UNKNOWN'||b.commissionFrozen===null)return{...row,status:'UNKNOWN_PARTICIPANT'};
  id(b.userId);if(!b.active||b.eligibility==='INELIGIBLE'||b.commissionFrozen)return{...row,status:'SKIPPED_INELIGIBLE'};
  const level=policy.levels.find(l=>l.code===b.levelCode);if(!level)return{...row,status:'UNKNOWN_LEVEL'};
  const percent=referralPercent(f.role==='RENTER_REFERRAL'?level.renterPercent:level.ownerPercent);
  return{...row,percent:percent.percent,ratio:percent.ratio,status:input.estimate?'ELIGIBLE':'UNKNOWN_ESTIMATE'};
 });
 if(policy&&input.estimate){const renter=roles.find(r=>r.role==='RENTER_REFERRAL')!,owner=roles.find(r=>r.role==='OWNER_REFERRAL')!;
  // Unknown counterpart ratios do not authorize a partial pair or an implicit subsidy.
  const uncertain=roles.some(r=>r.status.startsWith('UNKNOWN'));if(uncertain){for(const r of roles)if(r.status==='ELIGIBLE')r.status='UNKNOWN_ESTIMATE_CONSERVATION';}
  else{try{const allocation=allocateFrozenReferralPair(input.estimate.baseCents,renter.status==='ELIGIBLE'?renter.ratio:null,owner.status==='ELIGIBLE'?owner.ratio:null,policy.minimumAccrualCents);for(const r of roles)if(r.status==='ELIGIBLE'){const amount=r.role==='RENTER_REFERRAL'?allocation.renterCents:allocation.ownerCents;r.estimatedCents=amount;if(amount===null)r.status='SKIPPED_BELOW_MIN';}}
   catch(e){if((e as {status?:number}).status!==409)throw e;for(const r of roles)if(r.status==='ELIGIBLE')r.status='UNKNOWN_ESTIMATE_CONSERVATION';}}
 }
 const basis={schema:'payment-distribution-basis.v1' as const,orderId:input.orderId,gameId:input.gameId,currency:'CNY' as const,confirmationId:input.confirmationId,acceptedAt,paymentDigest:input.paymentDigest,admissionId:input.admissionId,admissionRevision:input.admissionRevision,policyVersion:input.policy?.versionId??null,policyDigest:input.policy?.digest??null,policyConfig:policy,accountMode:input.accountMode,estimateBaseCents:input.estimate?.baseCents??null,estimateDigest:input.estimate?.sourceDigest??null,roles:roles.sort((a,b)=>a.role.localeCompare(b.role))};
 return{...basis,digest:sha(canonicalize(basis))};
}

/** No APPLIED replay or changed head is allowed to invent the missed original snapshot. */
export function readOriginalPaymentDistributionBasis(existing:PaymentDistributionBasis|null,input:{orderId:string;confirmationId:string;paymentDigest:string}){
 if(!existing)return{knowledge:'UNKNOWN' as const,reason:'MISSING_ORIGINAL_BASIS',basis:null};
 if(existing.orderId!==input.orderId||existing.confirmationId!==input.confirmationId||existing.paymentDigest!==input.paymentDigest)throw conflict('Original payment binding differs');
 const {digest:stored,...body}=existing;if(sha(canonicalize(body))!==stored)throw conflict('Original payment basis digest differs');return{knowledge:'KNOWN' as const,basis:existing};
}


