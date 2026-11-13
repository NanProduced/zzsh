import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NORMAL_GROWTH_TIERS,entitlementPricingSummary,isTotalDiscountContract,isUnifiedTotalDiscountContract,validateBenefitPolicy,validateEntitlementCandidate,type GrowthBenefitPolicy,type RentalMode} from '../src/auth/membership-growth';
import {normalizeUnifiedMembershipPolicy,projectUnifiedMembershipPricing,type UnifiedMembershipPricingInput} from '../src/auth/membership-unified-pricing';

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
test('ALL entitlement needs real enabled modes, validates every frozen range and preserves legacy candidate rules',()=>{
 const p=normalize(),before=JSON.stringify(p);assert.equal(validateEntitlementCandidate(candidate,'UNKNOWN',p).valid,false);assert.equal(validateEntitlementCandidate(candidate,'UNKNOWN',p,{enabledModes:[]}).valid,false);assert.equal(validateEntitlementCandidate(candidate,'UNKNOWN',p,{enabledModes:modes}).valid,true);assert.equal(JSON.stringify(p),before);
 const {scope:_scope,...common}=candidate.pricing,old={...candidate,pricing:{...common,mode:'ordinary' as const}};assert.equal(validateEntitlementCandidate(old,'UNKNOWN',p).valid,true);
 for(const field of ['minPayableRatio','priceVersionId','costBasisRef']){const split=structuredClone(p);(split.entitlementRanges!.FRIEND.byMode.custom as any)[field]=field==='minPayableRatio'?'0.85':'different-binding';const result=validateEntitlementCandidate(candidate,'UNKNOWN',split,{enabledModes:modes});assert.equal(result.valid,false);assert(result.errors.includes('LEGACY_MODE_VALUES_DIFFER'));}
 for(const pricing of [{...candidate.pricing,mode:'ordinary' as const},{...candidate.pricing,payableRatio:'0.79'},{...candidate.pricing,costBasisRef:'forged-cost'}])assert.equal(validateEntitlementCandidate({...candidate,pricing:pricing as never},'UNKNOWN',p,{enabledModes:modes}).valid,false);
});
