import {createHash} from 'node:crypto';import {canonicalize,normalizeTime} from '../supply/content-hash';import {conflict,invalid} from '../supply/supply-util';import {exactCents} from './personal-finance-read';
import {allocateFrozenReferralPair,usesLegacyRentalDistributionBase} from './distribution-policy';import {readOriginalPaymentDistributionBasis,type PaymentDistributionBasis} from './distribution-payment-basis';import {earningEconomicKey,type RentalReferralRole} from './distribution-mechanism';
import {calculateFixedFee,fixedFeeAllowsPayableRatio} from '../supply/fixed-fee';
import {divideToScale,parseNonNegativeDecimal} from '../supply/decimal';
import {payableCentsFor} from '../auth/membership-total-discount';
export type FixedFeeAccrualEvidence={orderId:string;confirmationId:string;postingId:string;postingDigest:string;settlementVersionId:string;settlementVersionHash:string;orderStatus:'COMPLETED'|'CANCELLED'|'UNKNOWN';ownerGrossCents:string;serviceFeeCents:string;distributionDiscountCents:string};
export type CompletedDistributionFacts={origin:'NATIVE'|'LEGACY_MYSQL'|'UNKNOWN';orderId:string;confirmationId:string;postingId:string;postingDigest:string;postedAt:string;classification:'NORMAL'|'EARLY'|'UNKNOWN';calculationMode:'SYSTEM'|'MANUAL'|'UNKNOWN';capturedCents:string;ownerNetCents:string;renterRefundCents:string;platformContributionCents:string;compensationFeeCents:string;settlementVersionId?:string;settlementVersionHash?:string;fixedFeeEvidence?:FixedFeeAccrualEvidence|null};
export type AccruedReferral={economicKey:string;beneficiaryUserId:string;role:RentalReferralRole;amountCents:string;dueAt:string;policyVersion:string;basisDigest:string;postingDigest:string;relationDigest:string};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),unsigned=(v:string)=>{const n=BigInt(exactCents(v));if(n<0n)throw invalid('Nonnegative final accounting amounts required');return n;};
function dueAt(at:string,days:number){const normalized=normalizeTime(at);if(!normalized||!Number.isSafeInteger(days)||days<0||days>999999)throw invalid('Original completion time and frozen delay required');const date=new Date(Date.parse(normalized)+days*86400000);if(!Number.isFinite(date.getTime())||date.getUTCFullYear()>9999)throw invalid('Frozen due time exceeds supported range');return date.toISOString().slice(0,19)+normalized.slice(19);}
function fixedFeeBase(basis:Extract<PaymentDistributionBasis,{schema:'payment-distribution-basis.v2'}>,f:CompletedDistributionFacts,owner:bigint,platform:bigint,coverage:bigint):string|null{
 const p=basis.fixedFeePricing,e=f.fixedFeeEvidence;
 if(!p||!e||e.orderStatus!=='COMPLETED'||e.orderId!==f.orderId||e.confirmationId!==f.confirmationId||e.postingId!==f.postingId||e.postingDigest!==f.postingDigest
  ||typeof f.settlementVersionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(f.settlementVersionId)||e.settlementVersionId!==f.settlementVersionId
  ||typeof f.settlementVersionHash!=='string'||!/^[0-9a-f]{64}$/.test(f.settlementVersionHash)||e.settlementVersionHash!==f.settlementVersionHash)return null;
 try{
  if(!fixedFeeAllowsPayableRatio(p.fixedFeeRate,p.payableRatio))return null;
  const gross=unsigned(e.ownerGrossCents),service=unsigned(e.serviceFeeCents),discount=unsigned(e.distributionDiscountCents);
  const expectedService=calculateFixedFee([{itemId:'order',grossCents:gross}],p.fixedFeeRate).feeCents;
  const ratio=parseNonNegativeDecimal(p.payableRatio,8,'payable ratio'),unit=10n**BigInt(ratio.scale);
  const payable=payableCentsFor(gross,p.payableRatio);if(payable===null)return null;
  const expectedDiscount=f.calculationMode==='MANUAL'
   ?divideToScale({value:gross*(unit-ratio.value),scale:ratio.scale},{value:1n,scale:0},0).value
   :gross-payable;
  if(service!==expectedService||discount!==expectedDiscount||discount>service||gross!==owner+service+coverage||platform<coverage||platform-coverage<service-discount)return null;
  return(service-discount).toString();
 }catch{return null;}
}
/** Final amounts come from the immutable posting. Skipped payment roles never become eligible later. */
export function prepareAccrualFromFrozenPayment(basis:PaymentDistributionBasis|null,f:CompletedDistributionFacts){
 if(!basis)return{knowledge:'UNKNOWN' as const,reason:'MISSING_ORIGINAL_BASIS',baseCents:null,items:[] as AccruedReferral[]};
 try{readOriginalPaymentDistributionBasis(basis,{orderId:f.orderId,confirmationId:f.confirmationId,paymentDigest:basis.paymentDigest});}
 catch(e){if(basis.schema!=='payment-distribution-basis.v2')throw e;return{knowledge:'UNKNOWN' as const,reason:'ORIGINAL_PAYMENT_BASIS_NOT_CLOSED',baseCents:null,items:[] as AccruedReferral[]};}
 if(f.origin!=='NATIVE'){if(basis.schema==='payment-distribution-basis.v2')return{knowledge:'UNKNOWN' as const,reason:'FIXED_FEE_EVIDENCE_UNAVAILABLE',baseCents:null,items:[] as AccruedReferral[]};throw conflict('Historical or unknown-origin posting cannot create new rental earnings');}
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(f.postingId)||!/^[0-9a-f]{64}$/.test(f.postingDigest)){if(basis.schema==='payment-distribution-basis.v2')return{knowledge:'UNKNOWN' as const,reason:'FIXED_FEE_EVIDENCE_UNAVAILABLE',baseCents:null,items:[] as AccruedReferral[]};throw invalid('Original posting identity and digest required');}
 let captured:bigint,owner:bigint,refund:bigint,platform:bigint,fee:bigint;
 try{captured=unsigned(f.capturedCents);owner=unsigned(f.ownerNetCents);refund=unsigned(f.renterRefundCents);platform=unsigned(f.platformContributionCents);fee=unsigned(f.compensationFeeCents);}
 catch(e){if(basis.schema!=='payment-distribution-basis.v2')throw e;return{knowledge:'UNKNOWN' as const,reason:'FIXED_FEE_EVIDENCE_UNAVAILABLE',baseCents:null,items:[] as AccruedReferral[]};}
 if(owner+refund+platform!==captured){if(basis.schema==='payment-distribution-basis.v2')return{knowledge:'UNKNOWN' as const,reason:'FIXED_FEE_EVIDENCE_UNAVAILABLE',baseCents:null,items:[] as AccruedReferral[]};throw conflict('Final source posting does not conserve captured money');}
 if(!['NORMAL','EARLY'].includes(f.classification)||!['SYSTEM','MANUAL'].includes(f.calculationMode)||fee>platform)return{knowledge:'UNKNOWN' as const,reason:'UNKNOWN_BASE_MAPPING',baseCents:null,items:[] as AccruedReferral[]};
 const fixed=basis.schema==='payment-distribution-basis.v2',legacyRental=usesLegacyRentalDistributionBase(basis.policyConfig);
 if(basis.schema!=='payment-distribution-basis.v1'&&!fixed)return{knowledge:'UNKNOWN' as const,reason:'UNKNOWN_BASIS_SCHEMA',baseCents:null,items:[] as AccruedReferral[]};
 if(fixed&&(!['ordinary','custom','fast'].includes(basis.accountMode??'')||!Array.isArray(basis.roles)||basis.roles.length!==2
  ||basis.roles.some(r=>!r||typeof r!=='object'||!['RENTER_REFERRAL','OWNER_REFERRAL'].includes(r.role)
   ||!['ELIGIBLE','SKIPPED_DISABLED','SKIPPED_FAST','SKIPPED_MODE','SKIPPED_NO_PARENT','SKIPPED_INELIGIBLE','UNKNOWN_POLICY','UNKNOWN_MODE','UNKNOWN_RELATION','UNKNOWN_PARTICIPANT','UNKNOWN_LEVEL','UNKNOWN_ESTIMATE','UNKNOWN_ESTIMATE_CONSERVATION'].includes(r.status))
  ||new Set(basis.roles.map(r=>r.role)).size!==2
  ||basis.accountMode==='fast'&&basis.roles.some(r=>r.status==='ELIGIBLE')
  ||basis.accountMode!=='fast'&&basis.roles.some(r=>r.status==='SKIPPED_FAST')))
  return{knowledge:'UNKNOWN' as const,reason:'ORIGINAL_PAYMENT_BASIS_NOT_CLOSED',baseCents:null,items:[] as AccruedReferral[]};
 const base=fixed?fixedFeeBase(basis,f,owner,platform,fee):(legacyRental?captured-owner-refund:platform-fee).toString();
 if(base===null)return{knowledge:'UNKNOWN' as const,reason:'FIXED_FEE_EVIDENCE_UNAVAILABLE',baseCents:null,items:[] as AccruedReferral[]};
 if(!basis.policyConfig||!basis.policyVersion||basis.roles.some(r=>r.status.startsWith('UNKNOWN')))return{knowledge:'UNKNOWN' as const,reason:'ORIGINAL_PAYMENT_BASIS_NOT_CLOSED',baseCents:fixed?null:base,items:[] as AccruedReferral[]};
 const eligible=basis.roles.filter(r=>r.status==='ELIGIBLE'),renter=eligible.find(r=>r.role==='RENTER_REFERRAL'),ownerRole=eligible.find(r=>r.role==='OWNER_REFERRAL');
 if(fixed&&eligible.some(r=>!r.beneficiaryUserId||!r.relationDigest||!r.ratio))return{knowledge:'UNKNOWN' as const,reason:'ORIGINAL_PAYMENT_BASIS_NOT_CLOSED',baseCents:null,items:[] as AccruedReferral[]};
 let pair:ReturnType<typeof allocateFrozenReferralPair>;
 try{
  if(fixed){
   const renterShare=allocateFrozenReferralPair(base,renter?.ratio??null,null,basis.policyConfig.minimumAccrualCents);
   const ownerShare=allocateFrozenReferralPair(base,null,ownerRole?.ratio??null,basis.policyConfig.minimumAccrualCents);
   if(BigInt(renterShare.renterCents??'0')+BigInt(ownerShare.ownerCents??'0')>BigInt(base))throw conflict('Rounded referral pair exceeds source base');
   pair={renterCents:renterShare.renterCents,ownerCents:ownerShare.ownerCents,skipped:{renter:renterShare.skipped.renter,owner:ownerShare.skipped.owner}};
  }else pair=allocateFrozenReferralPair(base,renter?.ratio??null,ownerRole?.ratio??null,'0');
 }
 catch(e){const status=(e as {status?:number}).status;if(!fixed||(status!==400&&status!==409))throw e;return{knowledge:'UNKNOWN' as const,reason:status===409?'ROUNDED_REFERRALS_EXCEED_BASE':'ORIGINAL_PAYMENT_BASIS_NOT_CLOSED',baseCents:null,items:[] as AccruedReferral[]};}
 // V1 recorded a final zero for roles admitted at payment; V2 applies the frozen minimum at completion.
 const items:AccruedReferral[]=eligible.filter(r=>!fixed||(r.role==='RENTER_REFERRAL'?pair.renterCents:pair.ownerCents)!==null).map(r=>{
  if(!r.beneficiaryUserId||!r.relationDigest||!r.ratio)throw conflict('Original eligible role has incomplete frozen source');
  const economicKey=earningEconomicKey({kind:'NATIVE_RENTAL_REFERRAL',type:'NATIVE',system:'zzsh',entity:'rental_order',id:basis.orderId},r.beneficiaryUserId,r.role);
  return{economicKey,beneficiaryUserId:r.beneficiaryUserId,role:r.role,amountCents:(r.role==='RENTER_REFERRAL'?pair.renterCents:pair.ownerCents)??'0',dueAt:dueAt(f.postedAt,basis.policyConfig!.settlementDelayDays),policyVersion:basis.policyVersion!,basisDigest:basis.digest,postingDigest:f.postingDigest,relationDigest:r.relationDigest};
 });
 return{knowledge:'KNOWN' as const,baseDefinition:fixed?'FIXED_FEE_MINUS_MEMBERSHIP_DISCOUNT_V1':legacyRental?'LEGACY_RENTAL_CAPTURE_MINUS_OWNER_AND_REFUND_V1':'FINAL_POSTING_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE_V1',baseCents:base,items,
  ...(fixed&&items.length===0?{skipReason:eligible.length?'NO_PAYABLE_COMMISSION' as const:'NO_ELIGIBLE_REFERRAL' as const}:{}),
  digest:sha(canonicalize({orderId:basis.orderId,confirmationId:basis.confirmationId,basisDigest:basis.digest,postingId:f.postingId,postingDigest:f.postingDigest,base,items}))};
}


