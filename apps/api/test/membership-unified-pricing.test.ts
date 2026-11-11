import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NORMAL_GROWTH_TIERS,entitlementPricingSummary,isTotalDiscountContract,isUnifiedTotalDiscountContract,validateBenefitPolicy,validateEntitlementCandidate,type GrowthBenefitPolicy,type RentalMode} from '../src/auth/membership-growth';
import {normalizeUnifiedMembershipPolicy,projectUnifiedMembershipPricing,type UnifiedMembershipPricingInput} from '../src/auth/membership-unified-pricing';
import {validateFixedFeeTimeline,type FixedFeeTimelineInput} from '../src/auth/fixed-fee-policy-timeline';

const modes:RentalMode[]=['ordinary','custom'],scope='ALL_ENABLED_RENTAL_MODES' as const;
const input:UnifiedMembershipPricingInput={schema:'membership-unified-pricing.v1',scope,tiers:{STANDARD:{payableRatio:'1'},SILVER:{payableRatio:'0.98'},GOLD:{payableRatio:'0.95'},PLATINUM:{payableRatio:'0.9'},DIAMOND:{payableRatio:'0.85'}},entitlementRanges:{FRIEND:{minPayableRatio:'0.8',maxPayableRatio:'1'},PRESTIGE:{minPayableRatio:'0.7',maxPayableRatio:'0.9'}}};
function original():GrowthBenefitPolicy{
 return{schema:'membership-growth-v1',version:'1',status:'DRAFT',effectiveAt:null,sourceRef:'original-source',entitlementCaps:{FRIEND:'GOLD',PRESTIGE:'DIAMOND'},tiers:Object.fromEntries(NORMAL_GROWTH_TIERS.map(tier=>[tier,{tier,tenantDeposit:tier==='DIAMOND'?'WAIVED':'ACCOUNT_BASE',...(tier==='GOLD'?{depositAllowanceCents:'20000'}:tier==='PLATINUM'?{depositAllowanceCents:'30000'}:{}),pricing:{fast:{status:'NOT_PRICED',reason:'not enabled'}},entitlementCap:{status:'NOT_PRICED',reason:'legacy cap retained'}}])) as GrowthBenefitPolicy['tiers']};
}
const normalize=(p=original(),i:unknown=input)=>normalizeUnifiedMembershipPolicy(p,i,{enabledModes:modes,priceVersionId:'price-original'});
const candidate={userId:'user_1',kind:'FRIEND' as const,scopeKey:'game:delta',startsAt:'2026-10-01T00:00:00Z',endsAt:'2026-10-20T00:00:00Z',reason:'运营礼遇',requestedBy:'admin_1',depositAllowanceCents:'20000',pricing:{status:'CONFIGURED' as const,kind:'TOTAL_DISCOUNT' as const,scope,payableRatio:'0.9',priceVersionId:'price-original',costBasisRef:'price-original'}};

test('one business input becomes each enabled internal slot with server-owned price/cost bindings and no metadata mutation',()=>{
 const p=original(),before=JSON.stringify(p),i=structuredClone(input),result=normalize(p,i);assert.equal(JSON.stringify(p),before);assert.deepEqual(i,input);assert.notEqual(result,p);
 for(const tier of NORMAL_GROWTH_TIERS){assert.equal(result.tiers[tier].tenantDeposit,p.tiers[tier].tenantDeposit);assert.equal(result.tiers[tier].depositAllowanceCents,p.tiers[tier].depositAllowanceCents);assert.deepEqual(result.tiers[tier].pricing.fast,p.tiers[tier].pricing.fast);assert.deepEqual(result.tiers[tier].entitlementCap,p.tiers[tier].entitlementCap);
  for(const mode of modes)assert.deepEqual(result.tiers[tier].pricing[mode],{status:'CONFIGURED',kind:'TOTAL_DISCOUNT',mode,priceVersionId:'price-original',costBasisRef:'price-original',payableRatio:input.tiers[tier].payableRatio});}
 assert.equal(result.sourceRef,p.sourceRef);assert.equal(result.status,p.status);assert.equal(result.version,p.version);assert.equal(validateBenefitPolicy(result,{enabledModes:modes}).valid,true);assert.equal(validateBenefitPolicy({...result,status:'APPROVED'},{enabledModes:modes}).publishable,true);
 for(const kind of ['FRIEND','PRESTIGE'] as const)for(const mode of modes){const r=result.entitlementRanges![kind].byMode[mode]!;assert('costBasisRef'in r);assert.equal(r.costBasisRef,'price-original');assert.equal(r.mode,mode);}
});
test('empty draft text is preserved as pending; floating numbers, excess precision, invalid shapes and client costs are rejected',()=>{
 const pending=structuredClone(input);pending.tiers.GOLD.payableRatio='';pending.entitlementRanges.FRIEND.minPayableRatio='';const p=normalize(original(),pending);assert.equal((p.tiers.GOLD.pricing.ordinary as any).payableRatio,'');assert.equal(projectUnifiedMembershipPricing(p,modes).knowledge,'UNKNOWN');assert.equal(validateBenefitPolicy(p,{enabledModes:modes}).publishable,false);assert.equal(validateBenefitPolicy(p,{enabledModes:modes}).valid,true);
 for(const ratio of [0.9,null,true,'0','1.00000001','0.123456789','01.0','1e-1',' 0.9']){const i:any=structuredClone(input);i.tiers.SILVER.payableRatio=ratio;assert.throws(()=>normalize(original(),i),TypeError,String(ratio));}
 const extra:any=structuredClone(input);extra.tiers.GOLD.costBasisRef='caller-cost';assert.throws(()=>normalize(original(),extra),TypeError);
 const bad:any=structuredClone(input);bad.entitlementRanges.FRIEND={minPayableRatio:'0.95',maxPayableRatio:'0.8'};assert.throws(()=>normalize(original(),bad),TypeError);
 for(const enabledModes of [[],['unknown'],['ordinary','ordinary']])assert.throws(()=>normalizeUnifiedMembershipPolicy(original(),input,{enabledModes:enabledModes as RentalMode[],priceVersionId:'price-original'}),TypeError);
});
test('uniform legacy total slots project exact canonical values without taking a conflicting first slot or union',()=>{
 const p=normalize();(p.tiers.SILVER.pricing.custom as any).payableRatio='0.98000000';const r=projectUnifiedMembershipPricing(p,modes);assert.equal(r.knowledge,'KNOWN');assert.equal(r.tiers.SILVER.payableRatio,'0.98');assert.equal(r.entitlementRanges.FRIEND.minPayableRatio,'0.8');assert.equal(r.entitlementRanges.FRIEND.costBasisRef,'price-original');
 for(const field of ['payableRatio','priceVersionId','costBasisRef']){const copy=structuredClone(p);(copy.tiers.GOLD.pricing.custom as any)[field]=field==='payableRatio'?'0.9':'different-binding';const x=projectUnifiedMembershipPricing(copy,modes);assert.equal(x.tiers.GOLD.knowledge,'UNKNOWN');assert.equal(x.tiers.GOLD.payableRatio,null);assert(x.tiers.GOLD.reasonCodes.includes('LEGACY_MODE_VALUES_DIFFER'));}
 const split=structuredClone(p);(split.entitlementRanges!.FRIEND.byMode.custom as any).minPayableRatio='0.85';const x=projectUnifiedMembershipPricing(split,modes);assert.equal(x.entitlementRanges.FRIEND.knowledge,'UNKNOWN');assert.equal(x.entitlementRanges.FRIEND.minPayableRatio,null);assert(x.entitlementRanges.FRIEND.reasonCodes.includes('LEGACY_MODE_VALUES_DIFFER'));
 const legacy=original();assert.equal(projectUnifiedMembershipPricing(legacy,modes).knowledge,'UNKNOWN');assert.equal(projectUnifiedMembershipPricing(p,null).knowledge,'UNKNOWN');
});
test('ALL total contracts have an explicit mode-free public summary while the original single-mode summary is unchanged',()=>{
 assert.equal(isTotalDiscountContract(candidate.pricing),true);assert.equal(isUnifiedTotalDiscountContract(candidate.pricing),true);assert.equal(isTotalDiscountContract({...candidate.pricing,mode:'ordinary'}),false);assert.equal(isUnifiedTotalDiscountContract({...candidate.pricing,mode:'ordinary'}),false);assert.deepEqual(entitlementPricingSummary(candidate.pricing),{knowledge:'KNOWN',kind:'TOTAL_DISCOUNT',scope,payableRatio:'0.9'});
 const old={status:'CONFIGURED',kind:'TOTAL_DISCOUNT',mode:'ordinary',payableRatio:'0.9',priceVersionId:'price-original',costBasisRef:'price-original'};assert.deepEqual(entitlementPricingSummary(old),{knowledge:'KNOWN',kind:'TOTAL_DISCOUNT',mode:'ordinary',payableRatio:'0.9'});
 for(const pricing of [{...candidate.pricing,mode:'ordinary'},{...old,scope},{...candidate.pricing,scope:'UNKNOWN'},{...candidate.pricing,payableRatio:0.9},{...candidate.pricing,priceVersionId:42},{...candidate.pricing,costBasisRef:42}])assert.equal(entitlementPricingSummary(pricing).knowledge,'UNKNOWN');
});
test('only actual sealed enabled paths are expanded, including fast, and all three paths share exactly one business ratio',()=>{
 for(const enabledModes of [['ordinary'],['custom'],['fast'],['ordinary','custom','fast']] as RentalMode[][]){const policy=normalizeUnifiedMembershipPolicy(original(),input,{enabledModes,priceVersionId:'price-original'});assert.equal(projectUnifiedMembershipPricing(policy,enabledModes).knowledge,'KNOWN');assert.equal(validateEntitlementCandidate(candidate,'UNKNOWN',policy,{enabledModes}).valid,true);}
});
test('a previously approved policy remains spendable after its effective time, while invalid original instants still fail',()=>{
 const approved={...normalize(),status:'APPROVED' as const,effectiveAt:'2020-01-01T00:00:00Z'};
 assert.equal(validateBenefitPolicy(approved,{enabledModes:modes}).publishable,true);assert.equal(validateEntitlementCandidate(candidate,'UNKNOWN',approved,{enabledModes:modes}).valid,true);
 assert.equal(validateBenefitPolicy({...approved,effectiveAt:null},{enabledModes:modes}).publishable,true,'legacy approved null payload date keeps its existing metadata-bound compatibility');
 assert.equal(validateBenefitPolicy({...approved,effectiveAt:'2026-02-30T00:00:00Z'},{enabledModes:modes}).valid,false);
});
test('fixed-fee policy forbids member and entitlement discounts deeper than each enabled mode fee',()=>{
 const configured=structuredClone(input);
 configured.tiers.GOLD.payableRatio='0.95';configured.tiers.PLATINUM.payableRatio='0.95';configured.tiers.DIAMOND.payableRatio='0.95';
 configured.entitlementRanges.FRIEND={minPayableRatio:'0.95',maxPayableRatio:'1'};
 configured.entitlementRanges.PRESTIGE={minPayableRatio:'0.95',maxPayableRatio:'1'};
 const policy={...normalize(original(),configured),status:'APPROVED' as const};
 const rates={ordinary:'0.10',custom:'0.08',fast:'0.02'};
 const good=validateBenefitPolicy(policy,{enabledModes:modes,fixedFeeRates:rates});assert.equal(good.publishable,true,JSON.stringify(good));
 const tooLow=validateBenefitPolicy(policy,{enabledModes:modes,fixedFeeRates:{...rates,custom:'0.04'}});
 assert.equal(tooLow.publishable,false);assert(tooLow.errors.includes('tiers.GOLD.pricing.custom.discount_exceeds_fee'));assert(tooLow.errors.includes('entitlementRanges.FRIEND.byMode.custom.discount_exceeds_fee'));
 const equal=validateBenefitPolicy(policy,{enabledModes:modes,fixedFeeRates:{...rates,custom:'0.05'}});assert.equal(equal.publishable,true,JSON.stringify(equal));
 const badInput=structuredClone(configured);badInput.tiers.GOLD.payableRatio='0.90';badInput.tiers.PLATINUM.payableRatio='0.90';badInput.tiers.DIAMOND.payableRatio='0.90';
 const tooDeep=validateBenefitPolicy({...normalize(original(),badInput),status:'APPROVED'},{enabledModes:modes,fixedFeeRates:rates});assert.equal(tooDeep.publishable,false);assert(tooDeep.errors.includes('tiers.GOLD.pricing.custom.discount_exceeds_fee'));
 assert.equal(validateBenefitPolicy(policy,{enabledModes:modes,fixedFeeRates:{...rates,custom:'1'}}).publishable,false);
 assert.equal(validateBenefitPolicy(policy,{enabledModes:[],fixedFeeRates:rates}).publishable,false);
 assert.equal(validateBenefitPolicy(policy,{enabledModes:modes}).publishable,true,'legacy pricing remains unchanged');
});
test('fee changes check current and future member policies and still-active entitlements',()=>{
 const config=structuredClone(input);
 for(const tier of NORMAL_GROWTH_TIERS)config.tiers[tier].payableRatio='1';
 config.entitlementRanges.FRIEND={minPayableRatio:'1',maxPayableRatio:'1'};
 config.entitlementRanges.PRESTIGE={minPayableRatio:'1',maxPayableRatio:'1'};
 const policy={...normalize(original(),config),status:'APPROVED' as const};
 const start='2026-10-01T00:00:00.000000Z',later='2026-10-02T00:00:00.000000Z';
 const rate={ordinary:'0.10',custom:'0.08',fast:'0.12'};
 const entitlement={startsAt:start,endsAt:later,pricing:{...candidate.pricing,payableRatio:'0.95'}};
 const timeline:FixedFeeTimelineInput={from:start,fees:[{effectiveAt:start,generation:'1',rates:rate,protectedModes:modes}],benefits:[{effectiveAt:start,version:'1',policy}],entitlements:[entitlement]};
 assert.deepEqual(validateFixedFeeTimeline(timeline),{valid:true});
 const lowered={effectiveAt:later,generation:'2',rates:{...rate,custom:'0.04'},protectedModes:modes};
 assert.deepEqual(validateFixedFeeTimeline({...timeline,fees:[...timeline.fees,lowered]}),{valid:true},'an entitlement ending at the effective instant no longer overlaps');
 const stillActive={...entitlement,endsAt:'2026-10-02T00:00:00.000001Z'};
 assert.deepEqual(validateFixedFeeTimeline({...timeline,fees:[...timeline.fees,lowered],entitlements:[stillActive]}),{valid:false,reason:'ENTITLEMENT_DISCOUNT_EXCEEDS_FEE',at:later,mode:'custom'});
 const futureGift={...entitlement,startsAt:'2026-10-02T00:00:00.000001Z',endsAt:'2026-10-03T00:00:00.000000Z'};
 assert.deepEqual(validateFixedFeeTimeline({...timeline,fees:[...timeline.fees,lowered],entitlements:[futureGift]}),{valid:false,reason:'ENTITLEMENT_DISCOUNT_EXCEEDS_FEE',at:futureGift.startsAt,mode:'custom'});
 const invalidEntitlement={...entitlement,pricing:{status:'CONFIGURED',kind:'TOTAL_DISCOUNT',payableRatio:'0.95'}};
 assert.equal((validateFixedFeeTimeline({...timeline,entitlements:[invalidEntitlement]}) as any).reason,'ENTITLEMENT_PRICING_UNAVAILABLE');
 const deep=structuredClone(config);for(const tier of NORMAL_GROWTH_TIERS)deep.tiers[tier].payableRatio='0.90';
 const deepPolicy={...normalize(original(),deep),status:'APPROVED' as const};
 assert.equal((validateFixedFeeTimeline({...timeline,benefits:[...timeline.benefits,{effectiveAt:later,version:'2',policy:deepPolicy}]}) as any).reason,'BENEFIT_POLICY_INCOMPATIBLE');
 assert.deepEqual(validateFixedFeeTimeline({...timeline,benefits:[{effectiveAt:start,version:'4',policy},{effectiveAt:later,version:'3',policy:deepPolicy}]}),{valid:true},'older policy versions do not override a newer effective version');
 assert.equal((validateFixedFeeTimeline({...timeline,fees:[]}) as any).reason,'FEE_POLICY_UNAVAILABLE');
 assert.equal((validateFixedFeeTimeline({...timeline,benefits:[]}) as any).reason,'BENEFIT_POLICY_UNAVAILABLE');
 assert.equal((validateFixedFeeTimeline({...timeline,fees:[...timeline.fees,{...lowered,generation:'1'}]}) as any).reason,'TIMELINE_UNAVAILABLE');
});
test('ALL entitlement needs real enabled modes, validates every frozen range and preserves legacy candidate rules',()=>{
 const p=normalize(),before=JSON.stringify(p);assert.equal(validateEntitlementCandidate(candidate,'UNKNOWN',p).valid,false);assert.equal(validateEntitlementCandidate(candidate,'UNKNOWN',p,{enabledModes:[]}).valid,false);assert.equal(validateEntitlementCandidate(candidate,'UNKNOWN',p,{enabledModes:modes}).valid,true);assert.equal(JSON.stringify(p),before);
 const {scope:_scope,...common}=candidate.pricing,old={...candidate,pricing:{...common,mode:'ordinary' as const}};assert.equal(validateEntitlementCandidate(old,'UNKNOWN',p).valid,true);
 for(const field of ['minPayableRatio','priceVersionId','costBasisRef']){const split=structuredClone(p);(split.entitlementRanges!.FRIEND.byMode.custom as any)[field]=field==='minPayableRatio'?'0.85':'different-binding';const result=validateEntitlementCandidate(candidate,'UNKNOWN',split,{enabledModes:modes});assert.equal(result.valid,false);assert(result.errors.includes('LEGACY_MODE_VALUES_DIFFER'));}
 for(const pricing of [{...candidate.pricing,mode:'ordinary' as const},{...candidate.pricing,payableRatio:'0.79'},{...candidate.pricing,costBasisRef:'forged-cost'}])assert.equal(validateEntitlementCandidate({...candidate,pricing:pricing as never},'UNKNOWN',p,{enabledModes:modes}).valid,false);
});
