import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeltaQuote, computeLegacyListedQuote, type QuoteInput } from "../src/supply/pricing";
import { computeContentHash } from "../src/supply/content-hash";
import { legacyPayload } from "./legacy-listed-fixture";
import { compatRule } from "./pricing-compat-fixture";
import type { PoolClient } from "pg";
import { readEffectivePricingMode } from "../src/supply/pricing-policy-schedule";

test("new-listing mode requires a matching sealed policy and never guesses missing prices",async()=>{
  const {compatibility,...base}=compatRule();
  const row={id:"mode",generation:"1",effectiveAt:"2026-11-01T00:00:00.000000Z",pricingModel:"FIXED_FEE",priceScheduleId:"schedule",priceVersionId:"price",priceMode:"PERCENT",priceStatus:"SEALED",roundingPolicy:"HALF_UP_CENT_V1",rates:{ordinary:"0.10",custom:"0.08",fast:"0.12"},haffRule:{...base,schema:"haff-ratio-v3",fixedModes:compatibility!.modes}};
  const client=(value:unknown)=>({query:async()=>({rows:value?[value]:[]})}) as unknown as PoolClient;
  assert.equal(await readEffectivePricingMode(client(null),"game","2026-11-02T00:00:00Z"),null);
  assert.equal((await readEffectivePricingMode(client(row),"game","2026-11-02T00:00:00Z"))?.pricingModel,"FIXED_FEE");
  for(const changed of [{...row,priceScheduleId:null},{...row,priceStatus:"DRAFT"},{...row,roundingPolicy:"UNKNOWN"},{...row,rates:{ordinary:"0.1"}},{...row,priceMode:"SPREAD"}])
    await assert.rejects(readEffectivePricingMode(client(changed),"game","2026-11-02T00:00:00Z"));
});

test("new standard quotes use six for ordinary and custom, while fast remains twelve", () => {
  const oldRule=compatRule("52"), newRule=structuredClone(oldRule);
  newRule.compatibility!.ordinary.spreadDelta="6";
  for(const [rentalMode,ownerRatioB,oldBuyer,newBuyer,owner] of [
    ["ordinary",undefined,"44","46","52"], ["custom","50","42","44","50"], ["fast","64","52","52","64"],
  ] as const) {
    const input:QuoteInput={priceVersionId:"synthetic-price",mode:"SPREAD",roundingPolicy:"HALF_UP_CENT_V1",customerTier:"STANDARD",haffRule:oldRule,
      conditions:{safeBoxCode:"box-a",vitLevel:6,bearLevel:6,termOptionCode:"daily-10m",rentalPricing:{rentalMode,...(ownerRatioB?{ownerRatioB}:{})}},
      lines:[{itemId:"haff",quantity:"150000000",unit:"HAFF_BASE",pricingKind:"HAFF_RATIO",customerTier:"STANDARD"},
        {itemId:"item",quantity:"60",unit:"ROUND",pricingKind:"FIXED_UNIT",unitQuantity:"60",buyerUnitAmount:"10",ownerUnitAmount:"4",customerTier:"STANDARD"}],
      termOption:{code:"daily-10m",dailyConsumption:"10000000",durationRounding:"CEIL_DAY"}};
    const before=computeDeltaQuote(input),after=computeDeltaQuote({...input,haffRule:newRule});
    assert(before.quotable);assert(after.quotable);
    assert.equal(before.quote.pricingInputs.denominators?.buyer,oldBuyer);
    assert.equal(after.quote.pricingInputs.denominators?.buyer,newBuyer);
    assert.equal(after.quote.pricingInputs.denominators?.owner,owner);
    assert.equal(after.quote.ownerTotal.amount,before.quote.ownerTotal.amount);
    assert.deepEqual(after.quote.lines[1],before.quote.lines[1]);
  }
});

test("frozen legacy quote totals and content hash stay independent of a later policy", () => {
  const payload=legacyPayload(), provenance=payload.legacyQuote!, hash=computeContentHash(payload);
  const input={provenance,priceVersionId:"legacy-price",ruleReleaseId:"legacy-release",tenantDepositCents:"20000",publisherBailRequirementCents:"0",expiryDisclosures:[],
    lines:[{itemId:"haff",quantity:"150000000",unit:"HAFF_BASE" as const,pricingKind:"HAFF_RATIO" as const,customerTier:"STANDARD" as const}]};
  const before=computeLegacyListedQuote(input),newRule=compatRule("52");newRule.compatibility!.ordinary.spreadDelta="6";
  const native=computeDeltaQuote({priceVersionId:"new-price",mode:"SPREAD",roundingPolicy:"HALF_UP_CENT_V1",customerTier:"STANDARD",haffRule:newRule,
    conditions:{safeBoxCode:"box-a",vitLevel:6,bearLevel:6,termOptionCode:"daily-10m",rentalPricing:{rentalMode:"ordinary"}},
    lines:[{itemId:"haff",quantity:"150000000",unit:"HAFF_BASE",pricingKind:"HAFF_RATIO",customerTier:"STANDARD"}],
    termOption:{code:"daily-10m",dailyConsumption:"10000000",durationRounding:"CEIL_DAY"}});
  assert(native.quotable);assert.equal(native.quote.pricingInputs.denominators?.buyer,"46");
  const after=computeLegacyListedQuote(input);
  assert.equal(after.lines[0]!.ownerAmount.amount,"349.00");assert.equal(after.lines[0]!.buyerAmount.amount,"405.00");
  assert.deepEqual(after,before);assert.equal(computeContentHash(payload),hash);
});
