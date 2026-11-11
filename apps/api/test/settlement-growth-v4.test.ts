import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {ModuleKind,ScriptTarget,transpileModule} from 'typescript';
import {canonicalize,normalizeContentPayload} from '../src/supply/content-hash';
import {createHash} from 'node:crypto';
import {computeDeltaQuote} from '../src/supply/pricing';
import {freezeSettlementPricing} from '../src/order/personal-confirmation';
import {compatRule} from './pricing-compat-fixture';
import {legacyPayload} from './legacy-listed-fixture';
import {applyTotalDiscountToQuote} from '../src/auth/membership-total-discount';
import {FIXED_FEE_ALGORITHM} from '../src/supply/fixed-fee';
import {computeSettlement,SETTLEMENT_ROUNDING_POLICY,type SettlementInventoryLine} from '../src/order/settlement';
const tree=execFileSync('git',['--no-optional-locks','rev-parse','--show-toplevel'],{cwd:process.cwd(),encoding:'utf8'}).trim(),path='apps/api/src/order/settlement-record.ts',requireHere=createRequire(resolve(__dirname,'../src/order/settlement-record.js'));
// Exercise the real private frozen-basis function without adding test-only exports to the product module.
function load(source:string,name='basisOrReasons'){const exports:Record<string,any>={};runInNewContext(transpileModule(source+'\nexport const offlineFrozenBasis = '+name+';\n',{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{exports,require:requireHere});return exports.offlineFrozenBasis as (...args:any[])=>any;}
const current=load(readFileSync(resolve(tree,path),'utf8')),baseline=load(execFileSync('git',['--no-optional-locks','show','b14238156b340c870812e0fba44c74eb452691f9:'+path],{cwd:tree,encoding:'utf8'}));
const money=(amount:string,scale:number)=>({currency:'CNY',unit:'yuan',amount,scale});
function fixture(schema:'personal-quote-v1'|'personal-quote-v2'|'personal-quote-v3'|'personal-quote-v4'){
 const binding={userId:'renter',ownerUserId:'owner',accountId:'account',listingVersionId:'listing',ruleReleaseId:'release',quantityDigest:'a'.repeat(64)};
 const funding:any={version:'funding-v1',sourceRef:'original-funding-source',baseDepositCents:'500',publisherBailRequirementCents:'500',fullPayoutPolicyRef:'original-payout-policy',vipWaiver:false,svipWaiver:false};
 const personal:any={schema,userId:'renter',listingHash:'b'.repeat(64),membership:{version:'old-v1',sourceRef:'frozen-old-tier',tier:'STANDARD'},guarantee:{reference:'original-guarantee',status:'SATISFIED'},ruleRefs:{releaseId:'release'},funding};
 if(schema==='personal-quote-v1'){funding.fullPayoutSelected=false;funding.fullPayoutFeeCents='0';}
 else{Object.assign(personal,{ownerUserId:'owner',accountId:'account',listingVersionId:'listing',fullPayoutDeclaration:{schema:'full-payout-declaration-v1',selected:false}});funding.fullPayoutPolicyVersion='policy-1';funding.disclosureVersion='terms-1';}
 if(schema==='personal-quote-v3')personal.membershipGrowth={schema:'membership-growth-v1',policyVersion:'1',selectedSource:'GROWTH',binding};
 if(schema==='personal-quote-v4'){
  delete personal.membership;delete funding.vipWaiver;delete funding.svipWaiver;
  personal.membershipGrowth={schema:'membership-growth-v2',policyVersion:'1',effectiveTier:'BLACK_GOLD',policyTier:'DIAMOND',selectedSource:'FRIEND',depositSource:'GROWTH',entitlementIds:['original-gift'],binding,selectedBenefitVersion:'gift-v1',selectedEntitlementId:'original-gift',selectedValidUntil:'2025-01-01T00:00:00.000Z',depositBenefitVersion:'growth-1',depositEntitlementId:null,depositValidUntil:null,pricePlanDigest:'c'.repeat(64),depositCents:'0'};
 }
 const order={renterUserId:'renter',ownerUserId:'owner',accountId:'account',listingVersionId:'listing',ruleReleaseId:'release',contentHash:'b'.repeat(64),depositCents:'0',quote:{personal,ruleReleaseId:'release',priceVersionId:'price',pricingInputs:{exactRatios:[{itemId:'haff',buyerNumerator:'1234',buyerDenominator:'100000000',ownerNumerator:'1000',ownerDenominator:'100000000'}]},lines:[{itemId:'haff',quantity:'100000000',unit:'HAFF',pricingKind:'HAFF_RATIO',unitQuantity:'1000000',buyerAmount:money('12.34',2),ownerAmount:money('10.00',2),buyerUnitAmount:money('0.12340000',8),ownerUnitAmount:money('0.10000000',8)}]}};
 return{order,payment:{id:'payment',amountCents:'1234',currency:'CNY'},opening:[{itemId:'haff',quantity:'100000000'}]};
}
test('v4 settles the frozen whole price and independent waiver without old membership or current entitlement validity',()=>{
 const f=fixture('personal-quote-v4'),result=current(f.order,f.payment,f.opening);assert(result.basis);assert.equal(result.basis.personalQuoteSchema,'personal-quote-v4');assert.equal(result.basis.captured,'12.34');assert.equal(result.basis.deposit,'0.00');assert.equal(result.basis.fundingSourceRef,'original-funding-source');assert.equal(result.basis.disclosureVersion,'terms-1');assert(!Object.hasOwn(f.order.quote.personal,'membership'));
 assert.equal(canonicalize(baseline(f.order,f.payment,f.opening).reasons),canonicalize(['FULL_PAYOUT_UNKNOWN']));
});
test('v4 requires every frozen identity/price/deposit/policy/declaration field; missing evidence never becomes a zero or legacy tier',()=>{
 const mutations=[(p:any)=>p.membership={tier:'VIP',sourceRef:'invented',version:'1'},(p:any)=>p.funding.vipWaiver=true,(p:any)=>delete p.funding.disclosureVersion,(p:any)=>delete p.fullPayoutDeclaration,(p:any)=>p.ownerUserId='other',(p:any)=>p.membershipGrowth.depositCents='1',(p:any)=>p.membershipGrowth.effectiveTier='VIP',(p:any)=>delete p.membershipGrowth.selectedBenefitVersion,(p:any)=>p.membershipGrowth.binding.userId='other',(p:any)=>p.membershipGrowth.schema='membership-growth-v1'];
 for(const change of mutations){const f=fixture('personal-quote-v4');change(f.order.quote.personal);assert.equal(canonicalize(current(f.order,f.payment,f.opening)),canonicalize({reasons:['FULL_PAYOUT_UNKNOWN']}));}
});
test('all v1/v2/v3 compatibility results and failure cases match the original common-baseline function',()=>{
 for(const schema of ['personal-quote-v1','personal-quote-v2','personal-quote-v3'] as const){
  const scenarios=[()=>{},(f:any)=>delete f.order.quote.personal.membership,(f:any)=>delete f.order.quote.personal.funding.vipWaiver,(f:any)=>f.order.quote.personal.guarantee.status='UNKNOWN',(f:any)=>f.order.quote.personal.listingHash='other',(f:any)=>f.opening[0].quantity='1'];
  for(const change of scenarios){const f=fixture(schema);change(f);assert.equal(canonicalize(current(f.order,f.payment,f.opening)),canonicalize(baseline(f.order,f.payment,f.opening)),schema);}
 }
});

test('excess pricing must match the original confirmation digest, including the membership ratio',()=>{
 const computed=computeDeltaQuote({priceVersionId:'price',mode:'SPREAD',customerTier:'STANDARD',roundingPolicy:'HALF_UP_CENT_V1',haffRule:compatRule('47'),
  conditions:{safeBoxCode:'box-a',vitLevel:6,bearLevel:6,termOptionCode:'daily-10m',rentalPricing:{rentalMode:'ordinary'}},
  termOption:{code:'daily-10m',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'},
  lines:[{itemId:'haff',customerTier:'STANDARD',quantity:'100000000',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO'}],
  deposits:{tenantDepositCents:'0',publisherBailRequirementCents:'0'}});assert(computed.quotable);
 const quote=computed.quote,personal={schema:'personal-quote-v4',userId:'renter'},settlementPricing=freezeSettlementPricing(quote,'0.9',[
  {item_id:'bullet',pricing_kind:'FIXED_UNIT',unit_quantity:'60',buyer_unit_amount:'4',owner_unit_amount:'2',item_unit:'ROUND',item_enabled:true}]);
 const confirmationDigest=createHash('sha256').update(canonicalize({...personal,quote,settlementPricing})).digest('hex');
 const order={quote:{...quote,personal,settlementPricing,confirmationDigest}};
 const read=load(readFileSync(resolve(tree,path),'utf8'),'frozenSettlementPricing');
 assert.equal(read(order).payableRatio,'0.9');
 const tampered=structuredClone(order);tampered.quote.settlementPricing.payableRatio='0.8';assert.throws(()=>read(tampered));
 const changedPrice=structuredClone(order);changedPrice.quote.settlementPricing.items[0]!.buyerUnitAmount='400';assert.throws(()=>read(changedPrice));
});

test('percent quotes freeze exact owner prices, including resources absent at opening',()=>{
 const base=computeDeltaQuote({priceVersionId:'price',mode:'PERCENT',commissionRate:'0.33333333',customerTier:'STANDARD',roundingPolicy:'HALF_UP_CENT_V1',
  haffRule:{schema:'haff-ratio-v1',baseBySafeBox:{a:'40'},vitalityDeltaByLevel:{6:'0'},bearDeltaByLevel:{6:'0'},dailyDeltaByTermOption:{d:'0'},options:{s:{delta:'0',enabled:true}}},
  conditions:{safeBoxCode:'a',vitLevel:6,bearLevel:6,termOptionCode:'d',pricingOptionCode:'s'},termOption:{code:'d',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'},
  lines:[{itemId:'haff',quantity:'100000000',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO',customerTier:'STANDARD'},
   {itemId:'kit',quantity:'3000000',unit:'PIECE',pricingKind:'FIXED_UNIT',unitQuantity:'1',buyerUnitAmount:'0.01999999',customerTier:'STANDARD'}]});
 assert(base.quotable);
 const rows=[{item_id:'kit',pricing_kind:'FIXED_UNIT' as const,unit_quantity:'1',buyer_unit_amount:'0.01999999',owner_unit_amount:null,item_unit:'PIECE',item_enabled:true},
  {item_id:'extra',pricing_kind:'FIXED_UNIT' as const,unit_quantity:'1',buyer_unit_amount:'1.23',owner_unit_amount:null,item_unit:'PIECE',item_enabled:true}];
 assert.throws(()=>freezeSettlementPricing(base.quote,'0.9',rows));
 const settlementPricing=freezeSettlementPricing(base.quote,'0.9',rows,'0.33333333');
 assert.equal(settlementPricing.schema,'settlement-pricing-v2');
 assert.equal(settlementPricing.items.find(i=>i.itemId==='kit')!.ownerUnitAmount,'0.0133333267333333');
 assert.equal(settlementPricing.items.find(i=>i.itemId==='extra')!.ownerUnitAmount,'0.8200000041');
 const selected=applyTotalDiscountToQuote(base.quote,'0.9');assert(selected);
 const quote=selected.quote,personal={schema:'personal-quote-v4',userId:'renter'};
 const confirmationDigest=createHash('sha256').update(canonicalize({...personal,quote,settlementPricing})).digest('hex');
 const read=load(readFileSync(resolve(tree,path),'utf8'),'frozenSettlementPricing');
 const order={quote:{...quote,personal,settlementPricing,confirmationDigest}};
 assert.equal(read(order).schema,'settlement-pricing-v2');
 const tampered=structuredClone(order);tampered.quote.settlementPricing.items[0]!.ownerUnitAmount='0';assert.throws(()=>read(tampered));
 const fill=load(readFileSync(resolve(tree,path),'utf8'),'withRemaining');
 const lines=fill({lines:[{itemId:'haff',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO',openingQuantity:'100',remainingQuantity:null}],settlementPricing},
  [{itemId:'haff',quantity:'100',quantityKind:'CONSUMED'},{itemId:'extra',quantity:'2',quantityKind:'CONSUMED'}]).lines;
 assert.equal(lines[1].ownerUnitAmount,'0.82');assert.equal(lines[1].baseOwnerUnitAmount,'0.8200000041');
 const actual=fixture('personal-quote-v2'),basisPersonal=actual.order.quote.personal;
 quote.ruleReleaseId='release';
 const digest=createHash('sha256').update(canonicalize({...basisPersonal,quote,settlementPricing})).digest('hex');
 (actual.order as any).quote={...quote,personal:basisPersonal,settlementPricing,confirmationDigest:digest};
 const actualBasis=current(actual.order,{id:'payment',amountCents:'5422497',currency:'CNY'},[{itemId:'haff',quantity:'100000000'},{itemId:'kit',quantity:'3000000'}]);
 assert(actualBasis.basis,JSON.stringify(actualBasis.reasons));
 assert.equal(actualBasis.basis.items[0].baseOwnerUnitAmount,'0.0133333267333333');
});

test('fixed-fee settlement pricing freezes the original price and rate in the signed order basis',()=>{
 const {compatibility,...baseRule}=compatRule('2000');
 const base=computeDeltaQuote({priceVersionId:'fixed-price',mode:'PERCENT',fixedFeeAlgorithm:FIXED_FEE_ALGORITHM,commissionRate:'0.10',customerTier:'STANDARD',roundingPolicy:'HALF_UP_CENT_V1',
  haffRule:{...baseRule,schema:'haff-ratio-v3',fixedModes:compatibility!.modes},
  conditions:{safeBoxCode:'box-a',vitLevel:6,bearLevel:6,termOptionCode:'daily-10m',rentalPricing:{rentalMode:'ordinary'}},
  termOption:{code:'daily-10m',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'},
  lines:[{itemId:'zzz_haff',quantity:'1000000',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO',customerTier:'STANDARD'},
   {itemId:'aaa_item',quantity:'1',unit:'PIECE',pricingKind:'FIXED_UNIT',unitQuantity:'1',buyerUnitAmount:'0.05',customerTier:'STANDARD'}]});
 assert(base.quotable);
 const rows=[{item_id:'aaa_item',pricing_kind:'FIXED_UNIT' as const,unit_quantity:'1',buyer_unit_amount:'0.05',owner_unit_amount:null,item_unit:'PIECE',item_enabled:true},
  {item_id:'extra',pricing_kind:'FIXED_UNIT' as const,unit_quantity:'1',buyer_unit_amount:'1.23',owner_unit_amount:null,item_unit:'PIECE',item_enabled:true}];
 const basis=freezeSettlementPricing(base.quote,'0.90',rows,'0.10');
 assert.equal(basis.schema,'settlement-pricing-v3');assert.equal(basis.fixedFeeRate,'0.1');
 assert.equal(basis.items.find(item=>item.itemId==='aaa_item')!.ownerUnitAmount,'0.05');
 assert.equal(basis.items.find(item=>item.itemId==='extra')!.buyerUnitAmount,'1.23');
 assert.throws(()=>freezeSettlementPricing(base.quote,'0.89',rows,'0.10'));
 const selected=applyTotalDiscountToQuote(base.quote,'0.90');assert(selected);
 const quote=selected.quote,personal={schema:'personal-quote-v5',userId:'renter'};
 const signed=(settlementPricing:typeof basis)=>createHash('sha256').update(canonicalize({...personal,quote,settlementPricing})).digest('hex');
 const read=load(readFileSync(resolve(tree,path),'utf8'),'frozenSettlementPricing');
 const order={quote:{...quote,personal,settlementPricing:basis,confirmationDigest:signed(basis)}};
 assert.equal(read(order).schema,'settlement-pricing-v3');
 const toLine=(line:typeof quote.lines[number]):SettlementInventoryLine=>{
  const ratio=quote.pricingInputs.exactRatios.find(item=>item.itemId===line.itemId),item=basis.items.find(entry=>entry.itemId===line.itemId);
  return {itemId:line.itemId,unit:line.unit,pricingKind:line.pricingKind,openingQuantity:line.quantity,remainingQuantity:'0',unitQuantity:line.unitQuantity,
   buyerUnitAmount:line.buyerUnitAmount.amount,ownerUnitAmount:line.ownerUnitAmount.amount,prepaidBuyerAmount:line.buyerAmount.amount,prepaidOwnerAmount:line.ownerAmount.amount,
   ...(ratio?{exactRatio:ratio,baseHaffBuyerRatio:{numerator:basis.haff.buyerNumerator,denominator:basis.haff.buyerDenominator}}:{}),
   ...(item?{baseBuyerUnitAmount:item.buyerUnitAmount,baseOwnerUnitAmount:item.ownerUnitAmount}:{})};
 };
 const haff=quote.lines.find(line=>line.pricingKind==='HAFF_RATIO')!,item=quote.lines.find(line=>line.pricingKind==='FIXED_UNIT')!;
 const settled=computeSettlement({orderId:'order',settlementVersionId:'settlement',openingVersionId:'opening',quoteDigest:'quote',paymentDigest:'payment',
  roundingPolicy:SETTLEMENT_ROUNDING_POLICY,feePolicyVersion:'payout',renterUserId:'renter',ownerUserId:'owner',rentalStarted:true,endReason:'NORMAL',
  depositAmount:'0.00',capturedAmount:'0.09',fullPayout:'NOT_SELECTED',fullPayoutPolicyRef:null,pricingMode:'FIXED_FEE_TOTAL_V1',fixedFeeRate:basis.fixedFeeRate,
  totalPayableRatio:basis.payableRatio,haff:toLine(haff),items:[toLine(item)]});
 assert.equal(settled.ok,true,settled.reasons.join(','));assert.equal(settled.amounts!.ownerNet.amount,'0.09');
 assert.equal(settled.amounts!.platformServiceFee?.amount,'0.01');assert.equal(settled.amounts!.membershipDiscount?.amount,'0.01');
 const changed=structuredClone(basis);changed.fixedFeeRate='0.2';
 assert.throws(()=>read({quote:{...quote,personal,settlementPricing:changed,confirmationDigest:signed(changed)}}));
 const changedHaff=structuredClone(basis);changedHaff.haff.buyerNumerator='999';
 assert.throws(()=>read({quote:{...quote,personal,settlementPricing:changedHaff,confirmationDigest:signed(changedHaff)}}));
 const changedUnit=structuredClone(basis);changedUnit.items.find(item=>item.itemId==='aaa_item')!.buyerUnitAmount='0.06';
 assert.throws(()=>read({quote:{...quote,personal,settlementPricing:changedUnit,confirmationDigest:signed(changedUnit)}}));
});

test('fixed-fee refunds reconcile after discounts, excess consumption and early makeup',()=>{
 const makeInput=(haffQuantity:string,ratio:string,itemPrice:string,itemQuantity:string,payableRatio:string)=>{
  const {compatibility,...baseRule}=compatRule(ratio);
  const result=computeDeltaQuote({priceVersionId:'fixed-price',mode:'PERCENT',fixedFeeAlgorithm:FIXED_FEE_ALGORITHM,commissionRate:'0.10',customerTier:'STANDARD',roundingPolicy:'HALF_UP_CENT_V1',
   haffRule:{...baseRule,schema:'haff-ratio-v3',fixedModes:compatibility!.modes},
   conditions:{safeBoxCode:'box-a',vitLevel:6,bearLevel:6,termOptionCode:'daily-10m',rentalPricing:{rentalMode:'ordinary'}},
   termOption:{code:'daily-10m',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'},
   lines:[{itemId:'haff',quantity:haffQuantity,unit:'HAFF_BASE',pricingKind:'HAFF_RATIO',customerTier:'STANDARD'},
    {itemId:'item',quantity:itemQuantity,unit:'PIECE',pricingKind:'FIXED_UNIT',unitQuantity:'1',buyerUnitAmount:itemPrice,customerTier:'STANDARD'}]});
  assert(result.quotable);
  const basis=freezeSettlementPricing(result.quote,payableRatio,[{item_id:'item',pricing_kind:'FIXED_UNIT',unit_quantity:'1',buyer_unit_amount:itemPrice,owner_unit_amount:null,item_unit:'PIECE',item_enabled:true}],'0.10');
  const selected=applyTotalDiscountToQuote(result.quote,payableRatio);assert(selected);
  const quote=selected.quote;
  const toLine=(line:typeof quote.lines[number]):SettlementInventoryLine=>{
   const exact=quote.pricingInputs.exactRatios.find(row=>row.itemId===line.itemId),item=basis.items.find(row=>row.itemId===line.itemId);
   return {itemId:line.itemId,unit:line.unit,pricingKind:line.pricingKind,openingQuantity:line.quantity,remainingQuantity:'0',unitQuantity:line.unitQuantity,
    buyerUnitAmount:line.buyerUnitAmount.amount,ownerUnitAmount:line.ownerUnitAmount.amount,prepaidBuyerAmount:line.buyerAmount.amount,prepaidOwnerAmount:line.ownerAmount.amount,
    ...(exact?{exactRatio:exact,baseHaffBuyerRatio:{numerator:basis.haff.buyerNumerator,denominator:basis.haff.buyerDenominator}}:{}),
    ...(item?{baseBuyerUnitAmount:item.buyerUnitAmount,baseOwnerUnitAmount:item.ownerUnitAmount}:{})};
  };
  return {orderId:'order',settlementVersionId:'settlement',openingVersionId:'opening',quoteDigest:'quote',paymentDigest:'payment',
   roundingPolicy:SETTLEMENT_ROUNDING_POLICY,feePolicyVersion:'payout',renterUserId:'renter',ownerUserId:'owner',rentalStarted:true,endReason:'NORMAL' as const,
   depositAmount:'0.00',capturedAmount:quote.resourceTotal.amount,fullPayout:'NOT_SELECTED' as const,fullPayoutPolicyRef:null,pricingMode:'FIXED_FEE_TOTAL_V1' as const,
   fixedFeeRate:basis.fixedFeeRate,totalPayableRatio:basis.payableRatio,haff:toLine(quote.lines.find(line=>line.pricingKind==='HAFF_RATIO')!),
   items:[toLine(quote.lines.find(line=>line.pricingKind==='FIXED_UNIT')!)]};
 };
 const input=makeInput('30000000','50','4','10','0.95');
 assert.equal(input.capturedAmount,'95.00');assert.equal(input.items[0]!.buyerUnitAmount,'4.00000000');
 const full=computeSettlement(input);assert.equal(full.ok,true,full.reasons.join(','));
 assert.equal(full.amounts!.unusedItemRefund.amount,'0.00');assert.equal(full.amounts!.unusedHaffRefund.amount,'0.00');assert.equal(full.amounts!.renterRefund.amount,'0.00');
 const partial=computeSettlement({...input,items:[{...input.items[0]!,remainingQuantity:'5'}]});assert.equal(partial.ok,true,partial.reasons.join(','));
 assert.equal(partial.amounts!.unusedItemRefund.amount,'19.00');assert.equal(partial.amounts!.unusedHaffRefund.amount,'0.00');assert.equal(partial.amounts!.renterRefund.amount,'19.00');
 const excess=computeSettlement({...input,haff:{...input.haff,remainingQuantity:null,consumedQuantity:'40000000'},items:[{...input.items[0]!,remainingQuantity:'10'}]});
 assert.equal(excess.ok,true,excess.reasons.join(','));assert.equal(excess.amounts!.unusedItemRefund.amount,'19.00');assert.equal(excess.amounts!.unusedHaffRefund.amount,'0.00');assert.equal(excess.amounts!.renterRefund.amount,'19.00');
 const early=computeSettlement({...input,endReason:'TENANT_VOLUNTARY_EARLY',haff:{...input.haff,remainingQuantity:'15000000'},items:[{...input.items[0]!,remainingQuantity:'5'}]});
 assert.equal(early.ok,true,early.reasons.join(','));assert.equal(early.amounts!.earlyMakeup.amount,'3.00');assert.equal(early.amounts!.unusedHaffRefund.amount,'25.50');assert.equal(early.amounts!.unusedItemRefund.amount,'19.00');assert.equal(early.amounts!.renterRefund.amount,'44.50');
 const small=makeInput('1200000','2000','0.05','1','0.95');
 const rounded=computeSettlement({...small,endReason:'OWNER_OR_ACCOUNT_EARLY',haff:{...small.haff,remainingQuantity:'900000'},items:[{...small.items[0]!,remainingQuantity:'1'}]});
 assert.equal(rounded.ok,true,rounded.reasons.join(','));assert.equal(rounded.amounts!.unusedHaffRefund.amount,'0.03');assert.equal(rounded.amounts!.unusedItemRefund.amount,'0.05');assert.equal(rounded.amounts!.renterRefund.amount,'0.08');
});

test('actual-consumption inputs add only item types from the frozen order price list',()=>{
 const fill=load(readFileSync(resolve(tree,path),'utf8'),'withRemaining');
 const basis={lines:[{itemId:'haff',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO',openingQuantity:'100',remainingQuantity:null}],
  settlementPricing:{items:[{itemId:'bullet',unit:'ROUND',unitQuantity:'60',buyerUnitAmount:'4',ownerUnitAmount:'2'}]}};
 const result=fill(basis,[{itemId:'haff',quantity:'110',quantityKind:'CONSUMED'},{itemId:'bullet',quantity:'60',quantityKind:'CONSUMED'}]);
 assert.equal(result.lines.length,2);assert.equal(result.lines[0].consumedQuantity,'110');
 assert.equal(result.lines[1].openingQuantity,'0');assert.equal(result.lines[1].baseBuyerUnitAmount,'4');
 assert.deepEqual(Array.from(fill(basis,[{itemId:'haff',quantity:'0'},{itemId:'unknown',quantity:'1',quantityKind:'CONSUMED'}]).reasons),['SETTLEMENT_QUANTITY_MISMATCH']);
 assert.deepEqual(Array.from(fill(basis,[{itemId:'haff',quantity:'0'},{itemId:'bullet',quantity:'1'}]).reasons),['SETTLEMENT_QUANTITY_MISMATCH']);
});

test('a new order on a migrated listing preserves its legacy full-price basis in the signed quote',()=>{
 const base=normalizeContentPayload(legacyPayload()).quoteValues as unknown as import('../src/supply/pricing').InternalQuote,selected=applyTotalDiscountToQuote(base,'0.95');assert(selected);
 const quote={...selected.quote,ruleReleaseId:'release'},personal={schema:'personal-quote-v4',userId:'renter'},settlementPricing=freezeSettlementPricing(base,'0.95',[]);
 const confirmationDigest=createHash('sha256').update(canonicalize({...personal,quote,settlementPricing})).digest('hex');
 const read=load(readFileSync(resolve(tree,path),'utf8'),'frozenSettlementPricing');
 const restored=read({quote:{...quote,personal,settlementPricing,confirmationDigest}});
 assert.equal(restored.haff.buyerNumerator,base.pricingInputs.exactRatios[0]!.buyerNumerator);assert.equal(restored.payableRatio,'0.95');
});

const archiveCompletedSupply=load(readFileSync(resolve(tree,path),'utf8'),'archiveCompletedSupply');
const transactionCore=requireHere('../auth/security-core') as typeof import('../src/auth/security-core');
const completedOrder={id:'settled-order',accountId:'once-supply',listingVersionId:'frozen-version',contentHash:'b'.repeat(64)};
const completingActor={realm:'admin',userId:'service-operator',sessionId:'normal-session'};
function archiveHarness(failure?:'CAS'|'AUDIT'){
 let state={lifecycle:'ACTIVE',revision:'7'},before={...state};const events:Array<{sql:string;values:any[]}>=[];let released=0;
 const denied=Object.assign(new Error('synthetic audit denial'),{code:'42501'});
 const client={release(){released++;},async query(sql:string,values:any[]=[]){
  events.push({sql,values});
  if(sql==='BEGIN'){before={...state};return{rows:[],rowCount:0};}
  if(sql==='COMMIT')return{rows:[],rowCount:0};
  if(sql==='ROLLBACK'){state={...before};return{rows:[],rowCount:0};}
  if(sql.startsWith('SELECT lifecycle'))return{rows:[{...state}],rowCount:1};
  if(sql.startsWith('UPDATE zzsh_supply.rental_account')){
   assert.deepEqual(Array.from(values),['once-supply',state.revision]);assert.match(sql,/lifecycle='ACTIVE' AND revision=\$2::bigint/);
   if(failure==='CAS')return{rows:[],rowCount:0};
   state={lifecycle:'ARCHIVED',revision:(BigInt(state.revision)+1n).toString()};return{rows:[{revision:state.revision}],rowCount:1};
  }
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')){if(failure==='AUDIT')throw denied;return{rows:[],rowCount:1};}
  throw new Error('unexpected offline archive query');
 }};
 return{pool:{connect:async()=>client} as any,events,state:()=>state,released:()=>released,denied};
}

test('a successfully completed rental permanently archives the original supply and audits the frozen order binding',async()=>{
 for(const reason of ['NORMAL','TENANT_VOLUNTARY_EARLY','OWNER_OR_ACCOUNT_EARLY']){
  const h=archiveHarness();
  await transactionCore.withTransaction(h.pool,client=>archiveCompletedSupply(client,completedOrder,completingActor,'original-request','original-posting','settlement-version',reason));
  assert.deepEqual(h.state(),{lifecycle:'ARCHIVED',revision:'8'});assert.equal(h.released(),1);
  const event=h.events.find(e=>e.sql.includes('audit_event'))!;assert.equal(event.values[4],'supply.account.rental_completed');assert.equal(event.values[6],'once-supply');
  const detail=JSON.parse(event.values[10]);assert.equal(detail.orderId,'settled-order');assert.equal(detail.listingVersionId,'frozen-version');assert.equal(detail.contentHash,completedOrder.contentHash);assert.equal(detail.postingId,'original-posting');assert.equal(detail.endReason,reason);
  assert.equal(h.events.at(-1)?.sql,'COMMIT');
 }
});

test('archive CAS and audit failures propagate through the existing transaction; unstarted cancellation cannot archive supply',async()=>{
 for(const failure of ['CAS','AUDIT'] as const){
  const h=archiveHarness(failure);
  await assert.rejects(transactionCore.withTransaction(h.pool,client=>archiveCompletedSupply(client,completedOrder,completingActor,'original-request','original-posting','settlement-version','NORMAL')),e=>failure==='AUDIT'?e===h.denied:(e as Error).message==='SUPPLY_STATE_CHANGED');
  assert.deepEqual(h.state(),{lifecycle:'ACTIVE',revision:'7'});assert.equal(h.events.at(-1)?.sql,'ROLLBACK');assert.equal(h.released(),1);
 }
 const h=archiveHarness();
 await assert.rejects(transactionCore.withTransaction(h.pool,client=>archiveCompletedSupply(client,completedOrder,completingActor,'original-request','original-posting','settlement-version','CANCELLED_BEFORE_START')),/SETTLEMENT_SNAPSHOT_INVALID/);
 assert.deepEqual(h.events.map(e=>e.sql),['BEGIN','ROLLBACK']);
});
