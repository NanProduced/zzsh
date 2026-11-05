import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteLegacyHaff } from "../src/supply/legacy-listed-pricing";
import { readLegacyListedSource } from "../src/supply/legacy-listed-source";
import { canonicalize, computeContentHash, normalizeContentPayload } from "../src/supply/content-hash";
import { sha256Hex } from "../src/supply/supply-util";
import { legacyPayload } from "./legacy-listed-fixture";
import { computeLegacyListedQuote } from "../src/supply/pricing";
import { applyTotalDiscountToQuote } from "../src/auth/membership-total-discount";
import { computeSettlement, SETTLEMENT_ROUNDING_POLICY } from "../src/order/settlement";
import { legacyListedSourceRatio } from "../src/supply/legacy-listed-quote";
import { projectDeltaQuote } from "../src/supply/pricing";
import { projectTenantPriceQuote, publishedBaseRenterHaffRatioWanPerYuan } from "../src/supply/tenant-price-projection";
import { readLegacyListedPolicy } from "../src/supply/legacy-listed-policy";
import { orderHaffRatio } from "../src/order/admin-order-read";

test("legacy standard quotes retain source ratios and round the entire Haff price to whole yuan", () => {
  assert.deepEqual(quoteLegacyHaff({ haffMillions: "394", ownerRatio: "54", spread: "12", recordedOwnerYuan: "730.00" }),
    { ownerCents: "73000", renterCents: "93800", buyerRatio: "42" });
  assert.deepEqual(quoteLegacyHaff({ haffMillions: "150", ownerRatio: "43", spread: "6", recordedOwnerYuan: "349.00" }),
    { ownerCents: "34900", renterCents: "40500", buyerRatio: "37" });
  assert.deepEqual(quoteLegacyHaff({ haffMillions: "1", ownerRatio: "40", spread: "0", recordedOwnerYuan: "3.00" }),
    { ownerCents: "300", renterCents: "300", buyerRatio: "40" });
});

test("legacy pricing rejects contradictory owner facts and invalid ratios", () => {
  const input = { haffMillions: "394", ownerRatio: "54", spread: "12", recordedOwnerYuan: "730.00" };
  assert.throws(() => quoteLegacyHaff({ ...input, recordedOwnerYuan: "729.63" }), /LEGACY_OWNER_PRICE_MISMATCH/);
  assert.throws(() => quoteLegacyHaff({ ...input, spread: "54" }), /LEGACY_BUYER_RATIO_INVALID/);
  assert.throws(() => quoteLegacyHaff({ ...input, ownerRatio: "54.0" }), /LEGACY_PRICE_INPUT_INVALID/);
});

test("only an exact source-bound, previously listed account supplies legacy quote facts", () => {
  const row = { id: "42", status: "3", is_delete: "0", ratio_type: "fast", is_full_payout: "1", haff: "394", base_bot: "54", price_per: "730.00", price_tenant: "838.00", price_vip: "912.00", deposit_amount: "650.00", rental_days: "40", privateSourceField: "fixture" };
  const canonical = canonicalize(row), source = { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: "42", sourceDigest: sha256Hex(canonical) };
  assert.deepEqual(readLegacyListedSource(canonical, source), { haffMillions: "394", ownerRatio: "54", recordedOwnerYuan: "730.00", recordedTenantYuan: "838.00", recordedVipYuan: "912.00", depositYuan: "650.00", rentalDays: "40", rentalMode: "fast", fullPayoutSelected: true });
  assert.throws(() => readLegacyListedSource(canonicalize({ ...row, base_bot: "55" }), source), /LEGACY_LISTED_SOURCE_INVALID/);
  assert.throws(() => readLegacyListedSource(canonical, { ...source, sourceSystem: "native" }), /LEGACY_LISTED_SOURCE_INVALID/);
  const unpublished = canonicalize({ ...row, status: "0" });
  assert.throws(() => readLegacyListedSource(unpublished, { ...source, sourceDigest: sha256Hex(unpublished) }), /LEGACY_LISTED_SOURCE_INVALID/);
  const malformedPayout = canonicalize({ ...row, is_full_payout: 1 });
  assert.throws(() => readLegacyListedSource(malformedPayout, { ...source, sourceDigest: sha256Hex(malformedPayout) }), /LEGACY_LISTED_SOURCE_INVALID/);
});

test("legacy content hashes bind source and frozen rounded totals, and reject missing or changed evidence", () => {
  const payload = legacyPayload(), normalized = normalizeContentPayload(payload);
  assert.equal(normalized.quoteSource, "LEGACY_QUOTED");
  const hash = computeContentHash(payload);
  const changedProof = structuredClone(payload);
  changedProof.legacyQuote!.sourcePolicyDigest = "e".repeat(64);
  (changedProof.quoteValues as any).legacyQuote.sourcePolicyDigest = "e".repeat(64);
  assert.notEqual(hash, computeContentHash(changedProof));
  assert.throws(() => normalizeContentPayload({ ...payload, quoteSource: undefined }), /Legacy quote source/);
  assert.throws(() => normalizeContentPayload({ ...payload, legacyQuote: { ...payload.legacyQuote!, sourceSystem: "native" } as never }), /provenance/);
  assert.throws(() => normalizeContentPayload({ ...payload, legacyQuote: { ...payload.legacyQuote!, ownerRatio: "47" } }), /source facts/);
  assert.throws(() => normalizeContentPayload({ ...payload, legacyQuote: { ...payload.legacyQuote!, fullPayoutSelected: true } }), /source facts/);
  const changed = structuredClone(payload);
  (changed.quoteValues as any).pricingInputs.exactRatios[0].ownerNumerator = "34901";
  assert.throws(() => normalizeContentPayload(changed), /source facts/);
});

test("legacy prepaid totals use the new settlement contract for zero, half and all consumption", () => {
  const payload = legacyPayload(), p = payload.legacyQuote!;
  const quote = computeLegacyListedQuote({ provenance: p, priceVersionId: "price", ruleReleaseId: "release", tenantDepositCents: "20000", publisherBailRequirementCents: "0", expiryDisclosures: [],
    lines: [{ itemId: "haff", quantity: "150000000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", customerTier: "STANDARD" }] });
  const bound = normalizeContentPayload({ ...payload, quoteValues: quote as unknown as Record<string, unknown> });
  assert.equal(bound.quoteSource, "LEGACY_QUOTED");
  assert.equal(quote.lines[0]!.buyerAmount.amount, "405.00"); assert.equal(quote.lines[0]!.ownerAmount.amount, "349.00");
  assert.equal(publishedBaseRenterHaffRatioWanPerYuan(quote), "37");
  assert.equal(projectDeltaQuote(quote, "owner").ownerHaffRatio, "43");
  assert.equal(legacyListedSourceRatio({ ...quote, quoteSource: "OTHER" }, "buyer"), null);
  const ratio = quote.pricingInputs.exactRatios[0]!;
  for (const [remaining, buyer, owner] of [["150000000", "0.00", "0.00"], ["75000000", "202.50", "174.50"], ["0", "405.00", "349.00"]]) {
    const line = quote.lines[0]!;
    const result = computeSettlement({ orderId: "order", settlementVersionId: "set", openingVersionId: "opening", quoteDigest: "quote", paymentDigest: "payment", roundingPolicy: SETTLEMENT_ROUNDING_POLICY, feePolicyVersion: "policy", renterUserId: "renter", ownerUserId: "owner", rentalStarted: true, endReason: remaining === "0" ? "NORMAL" : "OWNER_OR_ACCOUNT_EARLY", depositAmount: "200.00", capturedAmount: "605.00", fullPayout: "NOT_SELECTED", fullPayoutPolicyRef: null,
      haff: { itemId: line.itemId, unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", openingQuantity: line.quantity, remainingQuantity: remaining!, unitQuantity: line.unitQuantity, buyerUnitAmount: line.buyerUnitAmount.amount, ownerUnitAmount: line.ownerUnitAmount.amount, prepaidBuyerAmount: line.buyerAmount.amount, prepaidOwnerAmount: line.ownerAmount.amount, exactRatio: ratio }, items: [] });
    assert.equal(result.ok, true, result.reasons.join(",")); assert.equal(result.amounts!.haffConsumedBuyer.amount, buyer); assert.equal(result.amounts!.haffConsumedOwner.amount, owner);
  }
  const discounted = applyTotalDiscountToQuote(quote, "0.95"); assert(discounted);
  assert.equal(discounted.quote.resourceTotal.amount, "384.75"); assert.equal(discounted.quote.ownerTotal.amount, "349.00");
  const memberLine=discounted.quote.lines[0]!,memberRatio=discounted.quote.pricingInputs.exactRatios[0]!;
  const halfMember=computeSettlement({orderId:"order-member",settlementVersionId:"set",openingVersionId:"opening",quoteDigest:"quote",paymentDigest:"payment",roundingPolicy:SETTLEMENT_ROUNDING_POLICY,feePolicyVersion:"policy",renterUserId:"renter",ownerUserId:"owner",rentalStarted:true,endReason:"OWNER_OR_ACCOUNT_EARLY",depositAmount:"200.00",capturedAmount:"584.75",fullPayout:"NOT_SELECTED",fullPayoutPolicyRef:null,
    haff:{itemId:memberLine.itemId,unit:"HAFF_BASE",pricingKind:"HAFF_RATIO",openingQuantity:memberLine.quantity,remainingQuantity:"75000000",unitQuantity:memberLine.unitQuantity,buyerUnitAmount:memberLine.buyerUnitAmount.amount,ownerUnitAmount:memberLine.ownerUnitAmount.amount,prepaidBuyerAmount:memberLine.buyerAmount.amount,prepaidOwnerAmount:memberLine.ownerAmount.amount,exactRatio:memberRatio},items:[]});
  assert.equal(halfMember.ok,true,halfMember.reasons.join(","));assert.equal(halfMember.amounts!.haffConsumedBuyer.amount,"192.38");assert.equal(halfMember.amounts!.haffConsumedOwner.amount,"174.50");
  assert.deepEqual(orderHaffRatio(discounted.quote),{source:"ORDER_QUOTE_SNAPSHOT",state:"KNOWN",wanPerYuan:"37",customerTier:null,referenceOnly:true});
  assert.equal(orderHaffRatio({...discounted.quote,quoteSource:"OTHER"}).state,"UNKNOWN");
  assert.equal(applyTotalDiscountToQuote(quote, "0.8"), null, "a new benefit must not cut below the owner's frozen total");
  assert.equal(applyTotalDiscountToQuote(quote, "0"), null, "free rental has no implicit platform subsidy");
});

test("legacy source ratios remain exact for public, owner and admin projections without changing frozen amounts", () => {
  const template=legacyPayload().legacyQuote!;
  for (const sample of [
    {haff:"150",owner:"43",spread:"6",renter:"37",ownerYuan:"349.00",renterYuan:"405.00",recordedTenant:"405.00",days:"15",deposit:"200.00",mode:"ordinary" as const},
    {haff:"221",owner:"47",spread:"6",renter:"41",ownerYuan:"470.00",renterYuan:"539.00",recordedTenant:"539.00",days:"23",deposit:"550.00",mode:"ordinary" as const},
    {haff:"394",owner:"54",spread:"12",renter:"42",ownerYuan:"730.00",renterYuan:"938.00",recordedTenant:"838.00",days:"40",deposit:"650.00",mode:"fast" as const},
  ]) {
    const provenance={...template,haffMillions:sample.haff,ownerRatio:sample.owner,spread:sample.spread,recordedOwnerYuan:sample.ownerYuan,recordedTenantYuan:sample.recordedTenant,rentalDays:sample.days,depositYuan:sample.deposit,rentalMode:sample.mode};
    const quote=computeLegacyListedQuote({provenance,priceVersionId:"price",ruleReleaseId:"release",tenantDepositCents:sample.deposit.replace(".",""),publisherBailRequirementCents:"0",expiryDisclosures:[],
      lines:[{itemId:"haff",quantity:(BigInt(sample.haff)*1000000n).toString(),unit:"HAFF_BASE",pricingKind:"HAFF_RATIO"}]});
    const before=canonicalize(quote);
    assert.equal(quote.lines[0]!.buyerAmount.amount,sample.renterYuan);
    assert.equal(quote.lines[0]!.ownerAmount.amount,sample.ownerYuan);
    assert.equal(quote.tenantDeposit?.amount,sample.deposit);
    assert.equal(quote.termSeconds,(BigInt(sample.days)*86400n).toString());
    assert.equal(projectTenantPriceQuote(quote,quote).baseRenterHaffRatioWanPerYuan,sample.renter);
    assert.equal(projectDeltaQuote(quote,"owner").ownerHaffRatio,sample.owner);
    assert.equal(projectDeltaQuote(quote,"admin").ownerHaffRatio,sample.owner);
    assert.equal(orderHaffRatio(quote).wanPerYuan,sample.renter);
    assert.equal(canonicalize(quote),before);
    const publicText=JSON.stringify(projectTenantPriceQuote(quote,quote));
    assert(!/ownerRatio|recordedOwnerYuan|sourceDigest|spreadDelta/.test(publicText));
  }
});

test("legacy ratio projection rejects missing, contradictory or unbound source facts", () => {
  const quote=normalizeContentPayload(legacyPayload()).quoteValues as unknown as import("../src/supply/pricing").InternalQuote;
  for (const invalid of [
    {...quote,quoteSource:"OTHER"},
    {...quote,legacyQuote:{...quote.legacyQuote!,sourceSystem:"native"}},
    {...quote,legacyQuote:{...quote.legacyQuote!,sourceDigest:""}},
    {...quote,legacyQuote:{...quote.legacyQuote!,rentalMode:"unknown"}},
    {...quote,legacyQuote:{...quote.legacyQuote!,ownerRatio:"0"}},
    {...quote,legacyQuote:{...quote.legacyQuote!,spread:"43"}},
    {...quote,pricingInputs:{...quote.pricingInputs,denominators:{owner:"43",buyer:"36"}}},
    {...quote,pricingInputs:{...quote.pricingInputs,spreadDelta:"7"}},
    {...quote,lines:[{...quote.lines[0]!,quantity:"1"}]},
    {...quote,lines:[]},
  ]) assert.equal(legacyListedSourceRatio(invalid,"buyer"),null);
});

test("legacy listing content binds fixed-resource quantities, unit prices and rounded totals", () => {
  const payload = legacyPayload(), p = payload.legacyQuote!;
  payload.declaration.inventory = [...payload.declaration.inventory, { itemId: "material", quantity: "3" }];
  const quote = computeLegacyListedQuote({ provenance: p, priceVersionId: "price", ruleReleaseId: "release", tenantDepositCents: "20000", publisherBailRequirementCents: "0", expiryDisclosures: [],
    lines: [{ itemId: "haff", quantity: "150000000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO" },
      { itemId: "material", quantity: "3", unit: "PIECE", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "5", ownerUnitAmount: "4" }] });
  payload.quoteValues = quote as unknown as Record<string, unknown>;
  assert.doesNotThrow(() => normalizeContentPayload(payload));
  const wrongQuantity = structuredClone(payload); wrongQuantity.declaration.inventory[1]!.quantity = "4";
  assert.throws(() => normalizeContentPayload(wrongQuantity), /source facts/);
  const wrongUnit = structuredClone(payload); (wrongUnit.quoteValues as any).lines.find((line: any) => line.itemId === "material").buyerUnitAmount.amount = "3.00000000";
  assert.throws(() => normalizeContentPayload(wrongUnit), /source facts/);
});

test("renter quote projections do not expose old source evidence or owner prices", () => {
  const quote = normalizeContentPayload(legacyPayload()).quoteValues as unknown as import("../src/supply/pricing").InternalQuote;
  for (const value of [projectTenantPriceQuote(quote,quote),projectDeltaQuote(quote,"public")]) {
    const text=JSON.stringify(value);
    for (const key of ["legacyQuote","sourceDigest","sourcePolicyDigest","recordedOwnerYuan","recordedTenantYuan","recordedVipYuan","ownerRatio","ownerTotal","platformFullProfit"])
      assert.equal(text.includes(key),false,key);
    assert.equal(text.includes("legacy_mysql_restore"),false);
  }
});

test("policy proof binds an independently sealed source, exact row, spread and material settings", () => {
  const settings = ["barrettBulletSale", "bulletSale", "awmSale", "armorSale", "helmetSale", "coffeeSale", "experienceCardSale"]
    .map((name,index) => ({ id: String(index + 1), type: "expendConfig", name, value: "1" }));
  const proof = { schema:"legacy-listed-policy-supplement-v1",sourceReceiptSha256:"a".repeat(64),sourceBindingSha256:"b".repeat(64),dumpSha256:"c".repeat(64),containerId:"d".repeat(64),rollbackConfirmed:true,
    identity:{database:"sg_zzsh_restore",readOnly:1,isolation:"REPEATABLE-READ",accessMode:"READ ONLY",txState:"ACTIVE"},comparison:"TEN_EXACT_ROWS_AND_CAPTURED_MATERIAL_POLICY_IDENTICAL",temporalLimit:"TWO_SPREAD_FIELDS_WERE_NOT_IN_BASE_CAPTURE",
    baseCaptureStartedAt:"2026-11-03T07:51:19Z",baseCaptureFinishedAt:"2026-11-03T07:51:36Z",startedAt:"2026-11-05T01:43:54Z",finishedAt:"2026-11-05T01:43:55Z",
    accountSourceDigests:Array.from({length:10},(_,i)=>({id:String(i+1),sha256:"e".repeat(64)})),gameRows:[{id:"1",profitDot:"6"}],settingRows:[...settings,{id:"99",type:"game",name:"profitFirstDot",value:"12"}] };
  const bundle={schema:"legacy-listed-policy-evidence-v1",supplement:proof,supplementSha256:sha256Hex(canonicalize(proof)),verifierSha256:"f".repeat(64),temporalLimit:"DUMP_AND_LATER_RESTORE_AGREE_CAPTURE_OMITTED_SPREADS_NO_PROOF_OF_INTERMEDIATE_UNCHANGED",
    dumpVerification:{schema:"zzsh.legacy-listing-dump-policy-check.v1",sourceDumpSha256:proof.dumpSha256,gameId:"1",matchCounts:{game:1,fastConfig:1},sourceCutoff:"2026-11-03T15:47:05+08:00",sourceCutoffMeaning:"OWNER_LOCAL_DUMP_EXPORT_COMPLETED_NOT_PROVEN_PRODUCTION_STOP_WRITE_CUTOFF",ordinaryProfitDot:"6",fastProfitFirstDot:"12"}};
  const authorityFor=(text:string)=>{const authorityCanonical=canonicalize({schema:"legacy-listed-policy-authority-v1",decision:"OWNER_APPROVED_MYSQL_SNAPSHOT_TEST_ONLY",scope:"LOCAL_AND_TEST_SERVER",runtimeCacheKnowledge:"UNKNOWN",productionCutover:"REVERIFY_SOURCE_RUNTIME_POLICY",sourceReceiptSha256:proof.sourceReceiptSha256,sourceBindingSha256:proof.sourceBindingSha256,dumpSha256:proof.dumpSha256,policyBundleSha256:sha256Hex(text),authorityRef:"fixture",instruction:"Synthetic decision for test"});return {authorityCanonical,authoritySha256:sha256Hex(authorityCanonical)};};
  const sealed=canonicalize(bundle), binding={proofSha256:sha256Hex(sealed),sourceReceiptSha256:proof.sourceReceiptSha256,sourceBindingSha256:proof.sourceBindingSha256,dumpSha256:proof.dumpSha256,dumpVerifierSha256:bundle.verifierSha256,sourceId:"1",sourceDigest:"e".repeat(64),legacyGameId:"1",expectedAccountCount:10,...authorityFor(sealed)};
  assert.deepEqual([readLegacyListedPolicy(sealed,binding).ordinarySpread,readLegacyListedPolicy(sealed,binding).fastSpread],["6","12"]);
  const changed=structuredClone(bundle);changed.supplement.gameRows[0]!.profitDot="7";
  assert.throws(()=>readLegacyListedPolicy(canonicalize(changed),binding),/LEGACY_POLICY_PROOF_INVALID/);
  changed.supplementSha256=sha256Hex(canonicalize(changed.supplement));const changedText=canonicalize(changed);
  assert.throws(()=>readLegacyListedPolicy(changedText,{...binding,proofSha256:sha256Hex(changedText),...authorityFor(changedText)}),/LEGACY_POLICY_PROOF_INVALID/);
  assert.throws(()=>readLegacyListedPolicy(sealed,{...binding,proofSha256:"f".repeat(64)}),/LEGACY_POLICY_PROOF_INVALID/);
  assert.throws(()=>readLegacyListedPolicy(sealed,{...binding,sourceReceiptSha256:"f".repeat(64)}),/LEGACY_POLICY_PROOF_INVALID/);
  assert.throws(()=>readLegacyListedPolicy(sealed,{...binding,sourceDigest:"f".repeat(64)}),/LEGACY_POLICY_PROOF_INVALID/);
  assert.throws(()=>readLegacyListedPolicy(sealed,{...binding,expectedAccountCount:9}),/LEGACY_POLICY_PROOF_INVALID/);
  assert.throws(()=>readLegacyListedPolicy(sealed,{...binding,authoritySha256:"0".repeat(64)}),/LEGACY_POLICY_PROOF_INVALID/);
  const duplicate=structuredClone(bundle);duplicate.supplement.settingRows.push({...settings[0]!});duplicate.supplementSha256=sha256Hex(canonicalize(duplicate.supplement));const duplicateText=canonicalize(duplicate);
  assert.throws(()=>readLegacyListedPolicy(duplicateText,{...binding,proofSha256:sha256Hex(duplicateText),...authorityFor(duplicateText)}),/LEGACY_POLICY_PROOF_INVALID/);
  const smaller=structuredClone(bundle);smaller.supplement.comparison="EXACT_LISTED_ROWS_AND_CAPTURED_MATERIAL_POLICY_IDENTICAL";
  smaller.supplement.accountSourceDigests=smaller.supplement.accountSourceDigests.slice(0,3);smaller.supplementSha256=sha256Hex(canonicalize(smaller.supplement));
  const smallerText=canonicalize(smaller);assert.equal(readLegacyListedPolicy(smallerText,{...binding,proofSha256:sha256Hex(smallerText),expectedAccountCount:3,...authorityFor(smallerText)}).ordinarySpread,"6");
  assert.throws(()=>readLegacyListedPolicy(smallerText,{...binding,proofSha256:sha256Hex(smallerText),expectedAccountCount:4,...authorityFor(smallerText)}),/LEGACY_POLICY_PROOF_INVALID/);
});
