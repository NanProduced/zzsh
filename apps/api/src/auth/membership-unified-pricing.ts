import {decimalToBigInt,formatDecimalExact,parseNonNegativeDecimal} from '../supply/decimal';
import {NORMAL_GROWTH_TIERS,entitlementPricingSummary,isTotalDiscountContract,projectUniformEntitlementRange,type GrowthBenefitPolicy,type NormalGrowthTier,type RentalMode,type UnifiedEntitlementRangeProjection} from './membership-growth';

const schema='membership-unified-pricing.v1' as const,scope='ALL_ENABLED_RENTAL_MODES' as const,kinds=['FRIEND','PRESTIGE'] as const;
export type UnifiedMembershipPricingInput={schema:typeof schema;scope:typeof scope;tiers:Record<NormalGrowthTier,{payableRatio:string}>;entitlementRanges:Record<typeof kinds[number],{minPayableRatio:string;maxPayableRatio:string}>};
export type UnifiedMembershipPricingProjection={schema:typeof schema;scope:typeof scope;knowledge:'KNOWN'|'UNKNOWN';tiers:Record<NormalGrowthTier,{knowledge:'KNOWN'|'UNKNOWN';payableRatio:string|null;reasonCodes:string[]}>;entitlementRanges:Record<typeof kinds[number],UnifiedEntitlementRangeProjection>};
function enabled(modes:readonly RentalMode[]|null|undefined):modes is readonly RentalMode[]{
 return Array.isArray(modes)&&modes.length>0&&modes.length<=3&&new Set(modes).size===modes.length&&modes.every(mode=>['ordinary','custom','fast'].includes(mode));
}
function record(value:unknown,keys:readonly string[],label:string):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new TypeError(`${label} has an invalid shape`);
 return value as Record<string,unknown>;
}
function ratio(value:unknown,pending=false):string{
 if(typeof value!=='string')throw new TypeError('Payable ratios must be decimal strings');
 if(pending&&value==='')return value;
 let parsed;try{parsed=parseNonNegativeDecimal(value,8,'payableRatio');}catch{throw new TypeError('Payable ratios must use at most eight decimal places');}
 if(parsed.value<=0n||parsed.value>10n**BigInt(parsed.scale))throw new TypeError('Payable ratios must be in (0,1]');
 return formatDecimalExact(parsed);
}
const emptyRange=(reason:string):UnifiedEntitlementRangeProjection=>({knowledge:'UNKNOWN',minPayableRatio:null,maxPayableRatio:null,priceVersionId:null,costBasisRef:null,reasonCodes:[reason]});

/** Read projection only. Legacy mode values are never rewritten, guessed or merged into a wider range. */
export function projectUnifiedMembershipPricing(policy:GrowthBenefitPolicy|null|undefined,enabledModes:readonly RentalMode[]|null|undefined):UnifiedMembershipPricingProjection{
 const tiers={} as UnifiedMembershipPricingProjection['tiers'],ranges={} as UnifiedMembershipPricingProjection['entitlementRanges'];
 for(const tier of NORMAL_GROWTH_TIERS){
  const unknown=(reason:string)=>({knowledge:'UNKNOWN' as const,payableRatio:null,reasonCodes:[reason]});
  if(!policy){tiers[tier]=unknown('POLICY_UNAVAILABLE');continue;}
  if(!enabled(enabledModes)){tiers[tier]=unknown('ENABLED_MODES_UNAVAILABLE');continue;}
  const terms:{ratio:string;price:string;cost:string}[]=[];let reason:string|null=null;
  for(const mode of enabledModes){
   const value=policy?.tiers?.[tier]?.pricing?.[mode];
   if(!isTotalDiscountContract(value)){reason='LEGACY_PRICING_REQUIRES_REVIEW';break;}
   if(value.mode!==mode||Object.hasOwn(value,'scope')||entitlementPricingSummary(value).knowledge!=='KNOWN'){reason='UNIFIED_PRICE_UNAVAILABLE';break;}
   terms.push({ratio:ratio(value.payableRatio),price:value.priceVersionId,cost:value.costBasisRef});
  }
  if(reason){tiers[tier]=unknown(reason);continue;}
  if(new Set(terms.map(t=>[t.ratio,t.price,t.cost].join('\u0000'))).size!==1){tiers[tier]=unknown('LEGACY_MODE_VALUES_DIFFER');continue;}
  tiers[tier]={knowledge:'KNOWN',payableRatio:terms[0]!.ratio,reasonCodes:[]};
 }
 for(const kind of kinds)ranges[kind]=policy?projectUniformEntitlementRange(policy,kind,enabledModes):emptyRange('POLICY_UNAVAILABLE');
 return{schema,scope,knowledge:Object.values(tiers).every(t=>t.knowledge==='KNOWN')&&Object.values(ranges).every(r=>r.knowledge==='KNOWN')?'KNOWN':'UNKNOWN',tiers,entitlementRanges:ranges};
}

/** One Admin input, adapted to the existing sealed-mode storage. Quote arithmetic and approved source objects stay untouched. */
export function normalizeUnifiedMembershipPolicy(policy:GrowthBenefitPolicy,input:unknown,context:{enabledModes:readonly RentalMode[];priceVersionId:string}):GrowthBenefitPolicy{
 if(!enabled(context.enabledModes)||typeof context.priceVersionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(context.priceVersionId))throw new TypeError('Verified enabled modes and server price version are required');
 const value=record(input,['schema','scope','tiers','entitlementRanges'],'unifiedPricing');if(value.schema!==schema||value.scope!==scope)throw new TypeError('Unified pricing schema and scope are required');
 const tierInput=record(value.tiers,NORMAL_GROWTH_TIERS,'tiers'),rangeInput=record(value.entitlementRanges,kinds,'entitlementRanges');
 if(!policy||!policy.tiers)throw new TypeError('An existing policy is required');
 const result=structuredClone(policy);
 result.pricingScope=scope;
 for(const tier of NORMAL_GROWTH_TIERS){
  if(!result.tiers[tier])throw new TypeError('The existing policy must include every membership tier');
  const item=record(tierInput[tier],['payableRatio'],`tiers.${tier}`),payableRatio=ratio(item.payableRatio,true),pricing={...result.tiers[tier].pricing};
  for(const mode of context.enabledModes)pricing[mode]={status:'CONFIGURED',kind:'TOTAL_DISCOUNT',mode,priceVersionId:context.priceVersionId,costBasisRef:context.priceVersionId,payableRatio};
  result.tiers[tier].pricing=pricing;
 }
 const ranges=result.entitlementRanges??{FRIEND:{byMode:{}},PRESTIGE:{byMode:{}}};
 for(const kind of kinds){
  const item=record(rangeInput[kind],['minPayableRatio','maxPayableRatio'],`entitlementRanges.${kind}`),min=ratio(item.minPayableRatio,true),max=ratio(item.maxPayableRatio,true);
  if(min!==''&&max!==''&&decimalToBigInt(parseNonNegativeDecimal(min,8,'min'),8)>decimalToBigInt(parseNonNegativeDecimal(max,8,'max'),8))throw new TypeError('Minimum payable ratio cannot exceed maximum');
  const byMode={...ranges[kind]?.byMode};for(const mode of context.enabledModes)byMode[mode]={status:'CONFIGURED',kind:'TOTAL_DISCOUNT_RANGE',mode,priceVersionId:context.priceVersionId,costBasisRef:context.priceVersionId,minPayableRatio:min,maxPayableRatio:max};
  ranges[kind]={...ranges[kind],byMode};
 }
 result.entitlementRanges=ranges;return result;
}
