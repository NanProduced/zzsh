import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalize } from '../src/supply/content-hash';
import { computeDeltaQuote } from '../src/supply/pricing';
import { FIXED_FEE_ALGORITHM } from '../src/supply/fixed-fee';
import { freezeSettlementPricing } from '../src/order/personal-confirmation';
import { compatRule } from './pricing-compat-fixture';
import { legacyCompensationBasis, nativeCompensationBasis, parseCompensationPayload } from '../src/finance/order-compensation-contract';

const payload={schema:'order-compensation.v1',orderId:'order_1',origin:'NATIVE',gameId:'delta',ownerUserId:'owner',sourceDigest:'a'.repeat(64),amountCents:'1234',caseRef:'工单 1001',reason:'已核对事故情况',evidenceRef:'工单证据 1001'};
test('compensation request freezes a positive exact amount and an explicit incident',()=>{
 assert.deepEqual(parseCompensationPayload(payload),payload);
 for(const change of [{amountCents:'0'},{amountCents:'1.2'},{amountCents:'-1'},{amountCents:42},{ownerUserId:'other/owner'},{sourceDigest:'x'},{reason:'  '},{caseRef:'12'},{extra:true}])assert.equal(parseCompensationPayload({...payload,...change}),null);
});
test('legacy basis cannot turn an account selection into evidence of the order selection',()=>{
 const row={id:'legacy_order_1',gameId:'delta',ownerUserId:'owner',sourceDigest:'a'.repeat(64)};
 assert.match(legacyCompensationBasis(row)!,/^[a-f0-9]{64}$/);
 assert.notEqual(legacyCompensationBasis({...row,ownerUserId:'other'}),legacyCompensationBasis(row));
 assert.equal(legacyCompensationBasis({...row,sourceDigest:'x'}),null);
});
test('native eligibility requires the exact signed quote and its order-party binding',()=>{
 const computed=computeDeltaQuote({priceVersionId:'price',mode:'SPREAD',customerTier:'STANDARD',roundingPolicy:'HALF_UP_CENT_V1',haffRule:compatRule('47'),conditions:{safeBoxCode:'box-a',vitLevel:6,bearLevel:6,termOptionCode:'daily-10m',rentalPricing:{rentalMode:'ordinary'}},termOption:{code:'daily-10m',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'},lines:[{itemId:'haff',customerTier:'STANDARD',quantity:'100000000',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO'}],deposits:{tenantDepositCents:'0',publisherBailRequirementCents:'0'}});
 assert(computed.quotable);
 const quote=computed.quote,personal={schema:'personal-quote-v4',userId:'renter',ownerUserId:'owner',accountId:'account',listingVersionId:'listing',listingHash:'a'.repeat(64),ruleRefs:{releaseId:'release'},fullPayoutDeclaration:{schema:'full-payout-declaration-v1',selected:true}},confirmationDigest=createHash('sha256').update(canonicalize({...personal,quote})).digest('hex');
 const order={id:'order_1',gameId:'delta',ownerUserId:'owner',renterUserId:'renter',accountId:'account',listingVersionId:'listing',contentHash:'a'.repeat(64),ruleReleaseId:'release',paymentId:'payment_1',paidCents:'10000',quote:{...quote,personal,listingHash:'a'.repeat(64),confirmationDigest}};
 assert.equal(nativeCompensationBasis(order)?.selected,true);
 assert.equal(nativeCompensationBasis({...order,ownerUserId:'other'}),null);
 assert.equal(nativeCompensationBasis({...order,contentHash:'b'.repeat(64)}),null);
 assert.equal(nativeCompensationBasis({...order,ruleReleaseId:'different'}),null);
 const changed=structuredClone(order);changed.quote.personal.fullPayoutDeclaration.selected=false;assert.equal(nativeCompensationBasis(changed),null);
});
test('fixed-fee compensation requires the signed pricing policy and matching frozen settlement basis',()=>{
 const {compatibility,...base}=compatRule('47');
 const computed=computeDeltaQuote({priceVersionId:'price-fixed',mode:'PERCENT',fixedFeeAlgorithm:FIXED_FEE_ALGORITHM,commissionRate:'0.10',customerTier:'STANDARD',roundingPolicy:'HALF_UP_CENT_V1',haffRule:{...base,schema:'haff-ratio-v3',fixedModes:compatibility!.modes},conditions:{safeBoxCode:'box-a',vitLevel:6,bearLevel:6,termOptionCode:'daily-10m',rentalPricing:{rentalMode:'ordinary'}},termOption:{code:'daily-10m',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'},lines:[{itemId:'haff',customerTier:'STANDARD',quantity:'100000000',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO'}],deposits:{tenantDepositCents:'0',publisherBailRequirementCents:'0'}});
 assert(computed.quotable);const quote=computed.quote;quote.ruleReleaseId='release';
 const settlementPricing=freezeSettlementPricing(quote,'1',[],'0.10');
 const personal={schema:'personal-quote-v5',userId:'renter',ownerUserId:'owner',accountId:'account',listingVersionId:'listing',listingHash:'a'.repeat(64),ruleRefs:{releaseId:'release'},fullPayoutDeclaration:{schema:'full-payout-declaration-v1',selected:true},pricingPolicy:{schema:'pricing-policy-v1',pricingModel:'FIXED_FEE',scheduleId:'schedule-1',generation:'1',effectiveAt:'2026-10-01T00:00:00Z',priceVersionId:'price-fixed'}};
 const confirmationDigest=createHash('sha256').update(canonicalize({...personal,quote,settlementPricing})).digest('hex');
 const order={id:'order_1',gameId:'delta',ownerUserId:'owner',renterUserId:'renter',accountId:'account',listingVersionId:'listing',contentHash:'a'.repeat(64),ruleReleaseId:'release',paymentId:'payment_1',paidCents:'10000',quote:{...quote,personal,settlementPricing,listingHash:'a'.repeat(64),confirmationDigest}};
 assert.equal(nativeCompensationBasis(order)?.selected,true);
 const wrongPolicy=structuredClone(order);wrongPolicy.quote.personal.pricingPolicy.priceVersionId='other';assert.equal(nativeCompensationBasis(wrongPolicy),null);
 const wrongRate=structuredClone(order);wrongRate.quote.settlementPricing.fixedFeeRate='0.2';assert.equal(nativeCompensationBasis(wrongRate),null);
 const missing=structuredClone(order);delete (missing.quote as {settlementPricing?:unknown}).settlementPricing;assert.equal(nativeCompensationBasis(missing),null);
});
