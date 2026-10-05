import {createHash} from 'node:crypto';import {canonicalize,normalizeTime} from '../supply/content-hash';import {conflict,invalid} from '../supply/supply-util';import {exactCents} from './personal-finance-read';
import {allocateFrozenReferralPair} from './distribution-policy';import {readOriginalPaymentDistributionBasis,type PaymentDistributionBasis} from './distribution-payment-basis';import {earningEconomicKey,type RentalReferralRole} from './distribution-mechanism';
export type CompletedDistributionFacts={origin:'NATIVE'|'LEGACY_MYSQL'|'UNKNOWN';orderId:string;confirmationId:string;postingId:string;postingDigest:string;postedAt:string;classification:'NORMAL'|'EARLY'|'UNKNOWN';calculationMode:'SYSTEM'|'MANUAL'|'UNKNOWN';capturedCents:string;ownerNetCents:string;renterRefundCents:string;platformContributionCents:string;compensationFeeCents:string};
export type AccruedReferral={economicKey:string;beneficiaryUserId:string;role:RentalReferralRole;amountCents:string;dueAt:string;policyVersion:string;basisDigest:string;postingDigest:string;relationDigest:string};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),unsigned=(v:string)=>{const n=BigInt(exactCents(v));if(n<0n)throw invalid('Nonnegative final accounting amounts required');return n;};
function dueAt(at:string,days:number){const normalized=normalizeTime(at);if(!normalized||!Number.isSafeInteger(days)||days<0||days>999999)throw invalid('Original completion time and frozen delay required');const date=new Date(Date.parse(normalized)+days*86400000);if(!Number.isFinite(date.getTime())||date.getUTCFullYear()>9999)throw invalid('Frozen due time exceeds supported range');return date.toISOString().slice(0,19)+normalized.slice(19);}
/** Final amounts come from the immutable posting. Skipped payment roles never become eligible later. */
export function prepareAccrualFromFrozenPayment(basis:PaymentDistributionBasis|null,f:CompletedDistributionFacts){
 if(!basis)return{knowledge:'UNKNOWN' as const,reason:'MISSING_ORIGINAL_BASIS',baseCents:null,items:[] as AccruedReferral[]};
 readOriginalPaymentDistributionBasis(basis,{orderId:f.orderId,confirmationId:f.confirmationId,paymentDigest:basis.paymentDigest});
 if(f.origin!=='NATIVE')throw conflict('Historical or unknown-origin posting cannot create new rental earnings');
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(f.postingId)||!/^[0-9a-f]{64}$/.test(f.postingDigest))throw invalid('Original posting identity and digest required');
 const captured=unsigned(f.capturedCents),owner=unsigned(f.ownerNetCents),refund=unsigned(f.renterRefundCents),platform=unsigned(f.platformContributionCents),fee=unsigned(f.compensationFeeCents);
 if(owner+refund+platform!==captured)throw conflict('Final source posting does not conserve captured money');
 if(!['NORMAL','EARLY'].includes(f.classification)||!['SYSTEM','MANUAL'].includes(f.calculationMode)||fee>platform)return{knowledge:'UNKNOWN' as const,reason:'UNKNOWN_BASE_MAPPING',baseCents:null,items:[] as AccruedReferral[]};
 const base=(platform-fee).toString();if(!basis.policyConfig||!basis.policyVersion||basis.roles.some(r=>r.status.startsWith('UNKNOWN')))return{knowledge:'UNKNOWN' as const,reason:'ORIGINAL_PAYMENT_BASIS_NOT_CLOSED',baseCents:base,items:[] as AccruedReferral[]};
 const eligible=basis.roles.filter(r=>r.status==='ELIGIBLE'),renter=eligible.find(r=>r.role==='RENTER_REFERRAL'),ownerRole=eligible.find(r=>r.role==='OWNER_REFERRAL');
 // A final known zero remains a recorded result for a role admitted at payment; no later threshold reapplies.
 const pair=allocateFrozenReferralPair(base,renter?.ratio??null,ownerRole?.ratio??null,'0'),items:AccruedReferral[]=eligible.map(r=>{
  if(!r.beneficiaryUserId||!r.relationDigest||!r.ratio)throw conflict('Original eligible role has incomplete frozen source');
  const economicKey=earningEconomicKey({kind:'NATIVE_RENTAL_REFERRAL',type:'NATIVE',system:'zzsh',entity:'rental_order',id:basis.orderId},r.beneficiaryUserId,r.role);
  return{economicKey,beneficiaryUserId:r.beneficiaryUserId,role:r.role,amountCents:(r.role==='RENTER_REFERRAL'?pair.renterCents:pair.ownerCents)??'0',dueAt:dueAt(f.postedAt,basis.policyConfig!.settlementDelayDays),policyVersion:basis.policyVersion!,basisDigest:basis.digest,postingDigest:f.postingDigest,relationDigest:r.relationDigest};
 });
 return{knowledge:'KNOWN' as const,baseDefinition:'FINAL_POSTING_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE_V1',baseCents:base,items,digest:sha(canonicalize({orderId:basis.orderId,confirmationId:basis.confirmationId,basisDigest:basis.digest,postingId:f.postingId,postingDigest:f.postingDigest,base,items}))};
}


