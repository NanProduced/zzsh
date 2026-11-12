import {test} from 'node:test';import {strict as assert} from 'node:assert';import {createHash} from 'node:crypto';import {canonicalize} from '../src/supply/content-hash';
import {freezePaymentDistributionBasis,type PaymentReferralFacts} from '../src/finance/distribution-payment-basis';import {validateDistributionPolicy} from '../src/finance/distribution-policy';import {prepareAccrualFromFrozenPayment,type CompletedDistributionFacts} from '../src/finance/distribution-accrual';
const h='a'.repeat(64),cfg=validateDistributionPolicy({schema:'distribution-policy.v1',scope:'LOCAL_CONTROLLED',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary','custom'],minimumAccrualCents:'1',settlementDelayDays:7,levels:[{code:'L1',rank:1,default:true,renterPercent:'5',ownerPercent:'5',upgrade:null}]}),policy={versionId:'p1',config:cfg,digest:createHash('sha256').update(canonicalize(cfg)).digest('hex')},facts:PaymentReferralFacts[]=(['RENTER_REFERRAL','OWNER_REFERRAL'] as const).map((role,n)=>({role,partyUserId:'party'+n,relation:{knowledge:'KNOWN_PARENT',id:'rel'+n,childUserId:'party'+n,parentUserId:'parent'+n,sourceDigest:(n===0?'b':'c').repeat(64)},beneficiary:{userId:'parent'+n,active:true,eligibility:'ELIGIBLE',commissionFrozen:false,levelCode:'L1'}}));
const basis=(base='10000')=>freezePaymentDistributionBasis({orderId:'o1',gameId:'delta',currency:'CNY',confirmationId:'p1',acceptedAt:'2026-10-04T03:00:00.000000Z',paymentDigest:h,admissionId:'a1',admissionRevision:'1',origin:'NATIVE',accountMode:'ordinary',estimate:{baseCents:base,sourceDigest:h},policy,facts});
const posting:CompletedDistributionFacts={origin:'NATIVE',orderId:'o1',confirmationId:'p1',postingId:'posting1',postingDigest:'d'.repeat(64),postedAt:'2026-10-04T03:12:10.123456Z',classification:'NORMAL',calculationMode:'SYSTEM',capturedCents:'10000',ownerNetCents:'4000',renterRefundCents:'1000',platformContributionCents:'5000',compensationFeeCents:'200'};
test('completed normal source uses frozen5 percent on final base4800, preserves microseconds and frozen7day due',()=>{const frozen=basis(),result=prepareAccrualFromFrozenPayment(frozen,posting);assert.equal(result.knowledge,'KNOWN');assert.equal(result.baseCents,'4800');assert.deepEqual(result.items.map(i=>[i.amountCents,i.dueAt]),[['240','2026-10-11T03:12:10.123456Z'],['240','2026-10-11T03:12:10.123456Z']]);assert.deepEqual(result.items.map(i=>[i.beneficiaryUserId,i.role,i.policyVersion,i.basisDigest,i.postingDigest,i.relationDigest]),[['parent1','OWNER_REFERRAL','p1',frozen.digest,'d'.repeat(64),'c'.repeat(64)],['parent0','RENTER_REFERRAL','p1',frozen.digest,'d'.repeat(64),'b'.repeat(64)]]);assert.deepEqual(result.items.map(i=>JSON.parse(i.economicKey)),[['NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_order','o1','parent1','OWNER_REFERRAL'],['NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_order','o1','parent0','RENTER_REFERRAL']]);assert(!('ledgerPlan'in result));});
test('old skipped below-minimum roles are not added when final base becomes larger; final zero for admitted role is recorded',()=>{assert.equal(prepareAccrualFromFrozenPayment(basis('1'),posting).items.length,0);const zero=prepareAccrualFromFrozenPayment(basis(),{...posting,compensationFeeCents:'5000'});assert.equal(zero.items.length,2);assert(zero.items.every(i=>i.amountCents==='0'));});
test('early and approved manual completion use the original frozen ratio and final immutable accounting amounts',()=>{for(const patch of [{calculationMode:'MANUAL' as const},{classification:'EARLY' as const},{calculationMode:'MANUAL' as const,classification:'EARLY' as const}]){const r=prepareAccrualFromFrozenPayment(basis(),{...posting,...patch,ownerNetCents:'3000',renterRefundCents:'2000'});assert.equal(r.knowledge,'KNOWN');assert.equal(r.baseCents,'4800');assert.deepEqual(r.items.map(i=>i.amountCents),['240','240']);}});
test('unknown classification, missing original and negative final base remain UNKNOWN rather than fabricated zero',()=>{for(const patch of [{calculationMode:'UNKNOWN' as const},{classification:'UNKNOWN' as const},{compensationFeeCents:'5001'}]){const r=prepareAccrualFromFrozenPayment(basis(),{...posting,...patch});assert.equal(r.knowledge,'UNKNOWN');assert.equal(r.reason,'UNKNOWN_BASE_MAPPING');assert.equal(r.baseCents,null);}assert.equal(prepareAccrualFromFrozenPayment(null,posting).reason,'MISSING_ORIGINAL_BASIS');});
test('legacy, foreign payment and unbalanced source cannot generate new earnings',()=>{assert.throws(()=>prepareAccrualFromFrozenPayment(basis(),{...posting,origin:'LEGACY_MYSQL'}));assert.throws(()=>prepareAccrualFromFrozenPayment(basis(),{...posting,confirmationId:'other'}));assert.throws(()=>prepareAccrualFromFrozenPayment(basis(),{...posting,ownerNetCents:'3999'}));});
test('economic root excludes mutable policy/version/posting timestamps but retains role and beneficiary',()=>{const a=prepareAccrualFromFrozenPayment(basis(),posting),b=prepareAccrualFromFrozenPayment(basis(),{...posting,postingId:'correction',postingDigest:'b'.repeat(64),postedAt:'2026-10-05T03:12:10.123456Z'});assert(a.knowledge==='KNOWN'&&b.knowledge==='KNOWN');assert.equal(a.items[0]!.economicKey,b.items[0]!.economicKey);assert.notEqual(a.digest,b.digest);assert.notEqual(a.items[0]!.economicKey,a.items[1]!.economicKey);});

// Independent HALF_UP boundary: two 50% shares of 2 cents are 1+1; of 1 cent are 1+1 and exceed the source.
test('final cumulative referral pair cannot exceed its source after per-role rounding',()=>{
 const config=structuredClone(cfg);config.levels[0]!.renterPercent='50';config.levels[0]!.ownerPercent='50';
 const frozen=freezePaymentDistributionBasis({orderId:'o1',gameId:'delta',currency:'CNY',confirmationId:'p1',acceptedAt:'2026-10-04T03:00:00.000000Z',paymentDigest:h,admissionId:'a1',admissionRevision:'1',origin:'NATIVE',accountMode:'ordinary',estimate:{baseCents:'10000',sourceDigest:h},policy:{versionId:'half',config,digest:createHash('sha256').update(canonicalize(config)).digest('hex')},facts});
 const exact=prepareAccrualFromFrozenPayment(frozen,{...posting,compensationFeeCents:'4998'});assert.deepEqual(exact.items.map(i=>i.amountCents),['1','1']);assert.equal(exact.baseCents,'2');
 assert.throws(()=>prepareAccrualFromFrozenPayment(frozen,{...posting,compensationFeeCents:'4999'}),/exceeds source base/);
});

function fixedBasis(estimate='1',rate='0.1',payableRatio='0.95',mode='ordinary',minimum='1',percent='5',ownerPercent=percent,roleFacts=facts){
 const config=structuredClone(cfg);config.minimumAccrualCents=minimum;config.levels[0]!.renterPercent=percent;config.levels[0]!.ownerPercent=ownerPercent;
 return freezePaymentDistributionBasis({orderId:'o1',gameId:'delta',currency:'CNY',confirmationId:'p1',acceptedAt:'2026-10-04T03:00:00.000000Z',paymentDigest:h,
  admissionId:'a1',admissionRevision:'1',origin:'NATIVE',accountMode:mode,estimate:{baseCents:estimate,sourceDigest:h},
  policy:{versionId:'fixed-policy',config,digest:createHash('sha256').update(canonicalize(config)).digest('hex')},facts:roleFacts,
  fixedFeePricing:{fixedFeeRate:rate,payableRatio}});
}
function fixedPosting():CompletedDistributionFacts{
 return{...posting,capturedCents:'9500',ownerNetCents:'9000',renterRefundCents:'0',platformContributionCents:'500',compensationFeeCents:'0',
  settlementVersionId:'settlement1',settlementVersionHash:'e'.repeat(64),fixedFeeEvidence:{orderId:'o1',confirmationId:'p1',postingId:'posting1',postingDigest:'d'.repeat(64),
   settlementVersionId:'settlement1',settlementVersionHash:'e'.repeat(64),orderStatus:'COMPLETED',ownerGrossCents:'10000',serviceFeeCents:'1000',distributionDiscountCents:'500'}};
}
test('fixed-fee commission excludes coverage and early makeup, and uses the frozen minimum at actual completion',()=>{
 const fixed=fixedBasis('1','0.1','0.95','ordinary','10');assert(fixed.roles.every(r=>r.status==='ELIGIBLE'&&r.estimatedCents==='0'));
 const normal=prepareAccrualFromFrozenPayment(fixed,fixedPosting());assert.equal(normal.knowledge,'KNOWN');assert.equal(normal.baseCents,'500');assert.deepEqual(normal.items.map(i=>i.amountCents),['25','25']);
 const early=fixedPosting();Object.assign(early,{classification:'EARLY',ownerNetCents:'2460',renterRefundCents:'5950',platformContributionCents:'1090',compensationFeeCents:'240'});
 Object.assign(early.fixedFeeEvidence!,{ownerGrossCents:'3000',serviceFeeCents:'300',distributionDiscountCents:'150'});
 const result=prepareAccrualFromFrozenPayment(fixedBasis(),early);assert.equal(result.knowledge,'KNOWN');assert.equal(result.baseCents,'150');assert.deepEqual(result.items.map(i=>i.amountCents),['8','8']);
 const below=fixedPosting();Object.assign(below,{capturedCents:'95',ownerNetCents:'90',platformContributionCents:'5'});
 Object.assign(below.fixedFeeEvidence!,{ownerGrossCents:'100',serviceFeeCents:'10',distributionDiscountCents:'5'});
 const skipped=prepareAccrualFromFrozenPayment(fixed,below);assert.equal(skipped.knowledge,'KNOWN');assert.deepEqual(skipped.items,[]);
 if(skipped.knowledge==='KNOWN')assert.equal(skipped.skipReason,'NO_PAYABLE_COMMISSION');
});
test('manual distribution discount rounds adjusted gross times frozen discount once without changing payment',()=>{
 const fixed=fixedBasis('100','0.1','0.9'),f=fixedPosting();Object.assign(f,{calculationMode:'MANUAL',capturedCents:'100',ownerNetCents:'4',renterRefundCents:'0',platformContributionCents:'96'});
 Object.assign(f.fixedFeeEvidence!,{ownerGrossCents:'5',serviceFeeCents:'1',distributionDiscountCents:'1'});
 const result=prepareAccrualFromFrozenPayment(fixed,f);assert.equal(result.knowledge,'KNOWN');assert.equal(result.baseCents,'0');assert.deepEqual(result.items,[]);
 f.fixedFeeEvidence!.distributionDiscountCents='0';const wrong=prepareAccrualFromFrozenPayment(fixed,f);assert.equal(wrong.knowledge,'UNKNOWN');assert.equal(wrong.baseCents,null);
});
test('fixed-fee commissions reject missing, unbound, cancelled, changed or contradictory final facts',()=>{
 const fixed=fixedBasis();
 for(const mutate of [
  (f:CompletedDistributionFacts)=>{f.fixedFeeEvidence=null;},
  (f:CompletedDistributionFacts)=>{f.fixedFeeEvidence!.orderStatus='CANCELLED';},
  (f:CompletedDistributionFacts)=>{f.fixedFeeEvidence!.postingId='other';},
  (f:CompletedDistributionFacts)=>{f.fixedFeeEvidence!.settlementVersionHash='f'.repeat(64);},
  (f:CompletedDistributionFacts)=>{f.fixedFeeEvidence!.serviceFeeCents='1001';},
  (f:CompletedDistributionFacts)=>{f.fixedFeeEvidence!.distributionDiscountCents='501';},
  (f:CompletedDistributionFacts)=>{f.fixedFeeEvidence!.ownerGrossCents='9999';},
  (f:CompletedDistributionFacts)=>{f.platformContributionCents='501';},
  (f:CompletedDistributionFacts)=>{f.origin='UNKNOWN';},
  (f:CompletedDistributionFacts)=>{f.settlementVersionId=undefined;},
 ]){const f=fixedPosting();mutate(f);const result=prepareAccrualFromFrozenPayment(fixed,f);assert.equal(result.knowledge,'UNKNOWN');assert.equal(result.baseCents,null);assert.deepEqual(result.items,[]);}
 const bad=fixedBasis('1','0.08','0.9'),result=prepareAccrualFromFrozenPayment(bad,fixedPosting());assert.equal(result.knowledge,'UNKNOWN');assert.equal(result.baseCents,null);
 const fast=prepareAccrualFromFrozenPayment(fixedBasis('1','0.1','0.95','fast'),fixedPosting());assert.equal(fast.knowledge,'KNOWN');assert.deepEqual(fast.items,[]);
 if(fast.knowledge==='KNOWN')assert.equal(fast.skipReason,'NO_ELIGIBLE_REFERRAL');
});
test('a fixed fast order cannot accrue even when its frozen roles contradict its mode',()=>{
 const forged=fixedBasis('100','0.1','0.95','fast');forged.roles[0]!.status='ELIGIBLE';
 const {digest,...body}=forged;const changed={...body,digest:createHash('sha256').update(canonicalize(body)).digest('hex')};
 const result=prepareAccrualFromFrozenPayment(changed,fixedPosting());assert.equal(result.knowledge,'UNKNOWN');assert.deepEqual(result.items,[]);
});
test('an incomplete frozen eligible role cannot be silently treated as a below-minimum zero',()=>{
 const frozen=fixedBasis('1');frozen.roles[0]!.ratio=null;
 const {digest,...body}=frozen;const changed={...body,digest:createHash('sha256').update(canonicalize(body)).digest('hex')};
 const result=prepareAccrualFromFrozenPayment(changed,fixedPosting());assert.equal(result.knowledge,'UNKNOWN');assert.deepEqual(result.items,[]);
});
test('fixed-fee roles cannot inherit the legacy estimate-time minimum skip',()=>{
 const frozen=fixedBasis('1');frozen.roles[0]!.status='SKIPPED_BELOW_MIN';
 const {digest,...body}=frozen;const changed={...body,digest:createHash('sha256').update(canonicalize(body)).digest('hex')};
 const result=prepareAccrualFromFrozenPayment(changed,fixedPosting());assert.equal(result.knowledge,'UNKNOWN');assert.deepEqual(result.items,[]);
});
test('fixed-fee rounding keeps the renter share, then applies the frozen minimum by role',()=>{
 const f=fixedPosting();Object.assign(f,{capturedCents:'1919',ownerNetCents:'1818',platformContributionCents:'101'});
 Object.assign(f.fixedFeeEvidence!,{ownerGrossCents:'2020',serviceFeeCents:'202',distributionDiscountCents:'101'});
 const sameParent=structuredClone(facts);
 sameParent[1]!.beneficiary!.userId=sameParent[0]!.beneficiary!.userId;
 sameParent[1]!.relation.parentUserId=sameParent[0]!.relation.parentUserId;
 const missing=structuredClone(sameParent);
 Object.assign(missing[1]!,{beneficiary:null,relation:{knowledge:'KNOWN_NONE',id:null,childUserId:missing[1]!.partyUserId,parentUserId:null,sourceDigest:null}});
 const reversed=(input:ReturnType<typeof fixedBasis>)=>{
  const {digest,...body}=input;
  const reordered={...body,roles:[...body.roles].reverse()};
  return {...reordered,digest:createHash('sha256').update(canonicalize(reordered)).digest('hex')};
 };
 for(const [renterPercent,ownerPercent,min,source,expected] of [
  ['50','50','50',sameParent,[['OWNER_REFERRAL','50'],['RENTER_REFERRAL','51']]],
  ['50','50','51',sameParent,[['RENTER_REFERRAL','51']]],
  ['50','50','52',sameParent,[]],
  ['25','75','1',sameParent,[['OWNER_REFERRAL','76'],['RENTER_REFERRAL','25']]],
  ['50','10','1',sameParent,[['OWNER_REFERRAL','10'],['RENTER_REFERRAL','51']]],
  ['50','50','1',missing,[['RENTER_REFERRAL','51']]],
 ] as const){
  const input=fixedBasis('1','0.1','0.95','ordinary',min,renterPercent,ownerPercent,source);
  for(const candidate of [input,reversed(input)]){
   const result=prepareAccrualFromFrozenPayment(candidate,f);
   assert.equal(result.knowledge,'KNOWN');assert.equal(result.baseCents,'101');
   assert.deepEqual(result.items.map(i=>[i.role,i.amountCents]),expected);
   assert.equal(new Set(result.items.map(i=>i.economicKey)).size,result.items.length);
   assert(result.items.every(i=>i.beneficiaryUserId==='parent0'));
  }
 }
});
