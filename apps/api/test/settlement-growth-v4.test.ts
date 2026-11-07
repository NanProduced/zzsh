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
