import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {ModuleKind,ScriptTarget,transpileModule} from 'typescript';
import {canonicalize} from '../src/supply/content-hash';
const tree=resolve(__dirname,'../../../..'),path='apps/api/src/order/settlement-record.ts',requireHere=createRequire(resolve(__dirname,'../src/order/settlement-record.js'));
// Exercise the real private frozen-basis function without adding test-only exports to the product module.
function load(source:string){const exports:Record<string,any>={};runInNewContext(transpileModule(source+'\nexport const offlineFrozenBasis = basisOrReasons;\n',{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{exports,require:requireHere});return exports.offlineFrozenBasis as (order:any,payment:any,opening:any)=>any;}
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
