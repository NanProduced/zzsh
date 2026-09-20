import { divideToScale, multiplyDecimal, parseNonNegativeDecimal } from "../src/supply/decimal";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compatRule } from "./pricing-compat-fixture";
import { CUSTOMER_TIERS, parseDeltaPriceLines, validateDeltaHaffRule, type CustomerTier, type RentalPricingSelection } from "../src/supply/delta-rental";
import type { QuoteInput } from "../src/supply/pricing";

test("price line parser distinguishes omitted tier from null and invalid values", () => {
  const line = {itemId:"round",pricingKind:"FIXED_UNIT",unitQuantity:"60",buyerUnitAmount:"10",ownerUnitAmount:"4"};
  assert.deepEqual(parseDeltaPriceLines([line],"SPREAD"),[line],"legacy omission stays omitted for the v2 write guard");
  for (const customerTier of CUSTOMER_TIERS) assert.equal(parseDeltaPriceLines([{...line,customerTier}],"SPREAD")[0]!.customerTier,customerTier);
  for (const customerTier of [null,0,false,{},[],["STANDARD"],"","standard","UNKNOWN"]) {
    assert.throws(()=>parseDeltaPriceLines([{...line,customerTier}],"SPREAD"),(error: any)=>error.status===400 && error.code==="INVALID_ARGUMENT");
  }
});

function compatInput(base: string, selection: RentalPricingSelection, tier: CustomerTier = "STANDARD"): QuoteInput {
  return { priceVersionId: "pc1-fixture", mode: "SPREAD", customerTier: tier, roundingPolicy: "HALF_UP_CENT_V1", haffRule: compatRule(base),
    conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", rentalPricing: selection },
    lines: [{ itemId: "haff", pricingKind: "HAFF_RATIO", customerTier: tier, quantity: "100000000" }],
    termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" } };
}

test("PC1 reviewed 42 vectors, per-line cent rounding and legacy integer difference", () => {
  const bs = [44,45,46,47,53,60,99];
  const expected = [
    ["277.78","270.27","263.16","256.41","222.22","192.31","109.89"],
    ["263.16","256.41","250.00","243.90","212.77","185.19","107.53"],
    ["256.41","250.00","243.90","238.10","208.33","181.82","106.38"],
    ["312.50","303.03","294.12","285.71","243.90","208.33","114.94"],
    ["294.12","285.71","277.78","270.27","232.56","200.00","112.36"],
    ["277.78","270.27","263.16","256.41","222.22","192.31","109.89"],
  ];
  const owners = ["227.27","222.22","217.39","212.77","188.68","166.67","101.01"];
  const oldOwners=[227n,222n,217n,213n,189n,167n,101n];
  const oldBuyers=[[278n,270n,263n,256n,222n,192n,110n],[263n,256n,250n,244n,213n,185n,108n],[256n,250n,244n,238n,208n,182n,106n],[313n,303n,294n,286n,244n,208n,115n],[294n,286n,278n,270n,233n,200n,112n],[278n,270n,263n,256n,222n,192n,110n]];
  for (const [lane, mode] of (["ordinary", "fast"] as const).entries()) for (const [ti, tier] of (["STANDARD","VIP","SVIP"] as const).entries()) for (const [bi,b] of bs.entries()) {
    const input = compatInput(String(mode === "fast" ? b-6 : b), mode === "ordinary" ? { rentalMode: mode } : { rentalMode: mode, ownerRatioB: String(b) }, tier);
    const q = quoteOf(computeQuote(input));
    assert.equal(q.ownerTotal.amount, owners[bi]);
    assert.equal(q.resourceTotal.amount, expected[lane*3+ti]![bi]);
    const cents = (s: string) => BigInt(s.replace(".", ""));
    assert.equal(cents(q.platformFullProfit.amount), cents(q.resourceTotal.amount)-cents(q.ownerTotal.amount));
    const oldOwner = divideToScale({value:10000n,scale:0},{value:BigInt(b),scale:0},0);
    const v = [0,2,mode === "fast" ? 4 : 3][ti]!;
    const oldBuyer = divideToScale({value:10000n,scale:0},{value:BigInt(b-(mode === "fast" ? 12 : 8)+v),scale:0},0);
    assert.equal(oldOwner.value,oldOwners[bi]);
    assert.equal(oldBuyer.value,oldBuyers[lane*3+ti]![bi]);
    assert.equal(oldBuyer.value-oldOwner.value,oldBuyers[lane*3+ti]![bi]!-oldOwners[bi]!);
    assert.ok(oldBuyer.value >= oldOwner.value);
    if (b===44 && mode==="fast" && tier==="STANDARD") assert.equal(oldBuyer.value,313n);
    if (mode === "ordinary") {
      const custom = quoteOf(computeQuote(compatInput(String(b+1),{rentalMode:"custom",ownerRatioB:String(b)},tier)));
      assert.deepEqual(custom.lines,q.lines);
    }
  }
});

test("PC1 four tiers, bounds, invalid inputs, resource units and projection", () => {
  for (const tier of CUSTOMER_TIERS) {
    const input = compatInput("47",{rentalMode:"ordinary"},tier);
    input.lines = [...input.lines, {itemId:"round",pricingKind:"FIXED_UNIT",customerTier:tier,quantity:"60",unit:"ROUND",unitQuantity:"60",ownerUnitAmount:"4",buyerUnitAmount:"10"}, {itemId:"day",pricingKind:"FIXED_UNIT",customerTier:tier,quantity:"3",unit:"DAY",unitQuantity:"1",ownerUnitAmount:"3",buyerUnitAmount:"5"}];
    const q=quoteOf(computeQuote(input));
    assert.equal(q.lines.find(l=>l.itemId==="round")!.buyerAmount.amount,"10.00");
    assert.equal(q.lines.find(l=>l.itemId==="day")!.buyerAmount.amount,"15.00");
    assert.equal(q.tenantDeposit,null);
    const publicQ=projectQuote(q,"public");
    assert.equal(publicQ.pricingInputs,undefined);
    assert.equal(publicQ.ownerTotal,undefined);
    assert.equal(publicQ.rentalMode,"ordinary");
    input.lines = input.lines.map(l=>l.itemId==="day"?{...l,customerTier:undefined}:l);
    assert.equal(computeQuote(input).quotable,false,"missing tier cannot fallback");
  }
  for(const [mode,b,ok] of [["custom","44",true],["custom","46",true],["custom","43",false],["custom","47",false],["fast","53",true],["fast","99",true],["fast","52",false],["fast","100",false]] as const) assert.equal(computeQuote(compatInput("47",{rentalMode:mode,ownerRatioB:b})).quotable,ok);
  assert.equal(computeQuote(compatInput("94",{rentalMode:"fast",ownerRatioB:"99"})).quotable,false);
  assert.equal(computeQuote(compatInput("8",{rentalMode:"ordinary"})).quotable,false);
  for(const quantity of [null,undefined,"-1","1.5","1e3"]) assert.equal(computeQuote({...compatInput("47",{rentalMode:"ordinary"}),lines:[{itemId:"haff",pricingKind:"HAFF_RATIO",customerTier:"STANDARD",quantity:quantity as string}]}).quotable,false);
  const bad=compatRule(); bad.compatibility!.ordinary.discounts.VIP="9";
  assert.throws(()=>validateDeltaHaffRule(bad,"SPREAD"));
  assert.throws(()=>validateDeltaHaffRule(compatRule(),"PERCENT"));
  for(const invalidV of ["-1",undefined]) {const r=compatRule();r.compatibility!.ordinary.discounts.DISCOUNT_USER=invalidV as string;assert.throws(()=>validateDeltaHaffRule(r,"SPREAD"));}
  const disabled=compatRule();disabled.compatibility!.modes.custom.enabled=false;
  assert.equal(computeQuote({...compatInput("47",{rentalMode:"custom",ownerRatioB:"46"}),haffRule:disabled}).quotable,false);
  const empty=compatRule();empty.compatibility!.modes.custom.min!.value="1";
  assert.equal(computeQuote({...compatInput("47",{rentalMode:"custom",ownerRatioB:"46"}),haffRule:empty}).quotable,false);
  const input=compatInput("47",{rentalMode:"ordinary"});
  assert.equal(computeQuote({...input,customerTier:undefined}).quotable,false);
  assert.equal(computeQuote({...input,conditions:{...input.conditions,pricingOptionCode:"standard"}}).quotable,false);
  const fixed = [
    ["awm","60","1","ROUND","0.4","1.2"], ["six","60","60","ROUND","4","10"],
    ["helmet","1","1","PIECE","0.8","2"], ["armor","1","1","PIECE","1","3"],
    ["barrett","60","1","ROUND","0.2","0.5"], ["coffee","1","1","PIECE","2","4"],
    ["insurance","3","1","DAY","3","5"],
  ].map(([itemId,quantity,unitQuantity,unit,ownerUnitAmount,buyerUnitAmount])=>({itemId:itemId!,quantity:quantity!,unitQuantity:unitQuantity!,unit:unit as "ROUND"|"PIECE"|"DAY",ownerUnitAmount:ownerUnitAmount!,buyerUnitAmount:buyerUnitAmount!,customerTier:"STANDARD" as const,pricingKind:"FIXED_UNIT" as const}));
  const withItems=quoteOf(computeQuote({...input,lines:[...input.lines,...fixed]}));
  const cents=(s:string)=>BigInt(s.replace(".",""));
  const fixedLines=withItems.lines.filter(l=>l.pricingKind==="FIXED_UNIT");
  assert.equal(fixedLines.reduce((sum,l)=>sum+cents(l.ownerAmount.amount),0n),5280n);
  assert.equal(fixedLines.reduce((sum,l)=>sum+cents(l.buyerAmount.amount),0n),13600n);
  assert.equal(fixedLines.reduce((sum,l)=>sum+cents(l.platformAmount.amount),0n),8320n);
  assert.equal(computeQuote({...input,lines:[...input.lines,...fixed.map(l=>({...l,quantity:"0"}))]}).quotable,true);
});

import { computeQuote, projectQuote, type HaffRatioRule, type InternalQuote } from "../src/supply/pricing";

const HAFF_RULE: HaffRatioRule = {
  schema: "haff-ratio-v1",
  baseBySafeBox: { "box-a": "50", "box-b": "60" },
  vitalityDeltaByLevel: { "6": "0", "7": "-5" },
  bearDeltaByLevel: { "6": "0", "7": "-5" },
  dailyDeltaByTermOption: { "daily-10m": "0", "daily-20m": "10" },
  options: { standard: { delta: "0", enabled: true }, disabled: { delta: "5", enabled: false } },
  spreadDelta: "10",
};

test("R1 equivalent rates, rational consumption, rounding and integer cents", () => {
  const q = quoteOf(accountQuote("PERCENT", "A"));
  assert.deepEqual(q, quoteOf(accountQuote("PERCENT", "A", { commissionRate: "0.20000000" })));
  assert.equal(q.lines[0]!.ownerUnitAmount.amount, "1.60000000");
  for (const rate of ["0", "0.00000000", "0.00000001", "0.99999999"]) {
    for (const quantity of ["1", "2499", "2500", "60000000"]) {
      const quote = quoteOf(accountQuote("PERCENT", "A", { commissionRate: rate, lines: [{ itemId: "item-haff", quantity, pricingKind: "HAFF_RATIO" }] }));
      const ratio = quote.pricingInputs.exactRatios[0]!;
      const owner = divideToScale(parseNonNegativeDecimal(ratio.ownerNumerator, 24, "numerator"), parseNonNegativeDecimal(ratio.ownerDenominator, 24, "denominator"), 2).value;
      const cents = (v: string) => parseNonNegativeDecimal(v, 2, "money").value;
      assert.equal(owner, cents(quote.ownerTotal.amount));
      assert.equal(cents(quote.resourceTotal.amount), owner + cents(quote.platformFullProfit.amount));
    }
  }
  const ratio = q.pricingInputs.exactRatios[0]!;
  const consumedOwner = divideToScale(multiplyDecimal(parseNonNegativeDecimal(ratio.ownerNumerator, 24, "n"), { value: 15000000n, scale: 0 }), multiplyDecimal(parseNonNegativeDecimal(ratio.ownerDenominator, 24, "d"), { value: 60000000n, scale: 0 }), 2);
  assert.equal(consumedOwner.value, 2400n);
  for (const rate of ["1", "1.00000000", "1.1", "-0.1", "0.000000001"]) assert.equal(accountQuote("PERCENT", "A", { commissionRate: rate }).quotable, false);
  assert.equal(quoteOf(accountQuote("PERCENT", "A", { deposits: { tenantDepositCents: "120", publisherBailRequirementCents: "0" } })).tenantDeposit?.amount, "1.20");
  assert.throws(() => accountQuote("PERCENT", "A", { deposits: { tenantDepositCents: "1.20" } }));
  const fixed = quoteOf(accountQuote("PERCENT", "A", { lines: [{ itemId: "item-haff", quantity: "1", pricingKind: "HAFF_RATIO" }, { itemId: "fixed", quantity: "1", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "0.006" }] }));
  assert.equal(fixed.lines.find((l) => l.itemId === "fixed")!.ownerAmount.amount, "0.00", "round once from exact 0.0048, not rounded buyer 0.01");
});

function accountQuote(mode: "SPREAD" | "PERCENT", account: "A" | "B", overrides: Record<string, unknown> = {}) {
  const conditions =
    account === "A"
      ? { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", pricingOptionCode: "standard" }
      : { safeBoxCode: "box-b", vitLevel: 7, bearLevel: 7, termOptionCode: "daily-20m", pricingOptionCode: "standard" };
  return computeQuote({
    priceVersionId: "fixture-p1",
    mode,
    roundingPolicy: "HALF_UP_CENT_V1",
    ...(mode === "PERCENT" ? { commissionRate: "0.2" } : {}),
    haffRule: HAFF_RULE,
    lines: [{ itemId: "item-haff", quantity: "60000000", pricingKind: "HAFF_RATIO" }],
    conditions,
    termOption: {
      code: conditions.termOptionCode,
      dailyConsumption: account === "A" ? "10000000" : "20000000",
      durationRounding: "CEIL_DAY",
    },
    ...overrides,
  });
}

function quoteOf(result: ReturnType<typeof computeQuote>): InternalQuote {
  assert.equal(result.quotable, true, JSON.stringify(result));
  if (!result.quotable) throw new Error("unreachable");
  return result.quote;
}

test("haff-ratio-v1 SPREAD matches the reviewed synthetic fixture for both account conditions", () => {
  const a = quoteOf(accountQuote("SPREAD", "A"));
  assert.equal(a.lines[0]!.buyerAmount.amount, "150.00");
  assert.equal(a.lines[0]!.ownerAmount.amount, "120.00");
  assert.equal(a.lines[0]!.platformAmount.amount, "30.00");
  assert.equal(a.resourceTotal.amount, "150.00");
  assert.equal(a.ownerTotal.amount, "120.00");
  assert.equal(a.platformFullProfit.amount, "30.00");
  assert.equal(a.termSeconds, String(6 * 86400));
  assert.equal(a.pricingInputs.denominators?.owner, "50");
  assert.equal(a.pricingInputs.denominators?.buyer, "40");

  const b = quoteOf(accountQuote("SPREAD", "B"));
  assert.equal(b.lines[0]!.buyerAmount.amount, "120.00");
  assert.equal(b.lines[0]!.ownerAmount.amount, "100.00");
  assert.equal(b.lines[0]!.platformAmount.amount, "20.00");
  assert.equal(b.termSeconds, String(3 * 86400));
  assert.equal(b.pricingInputs.denominators?.owner, "60");
  assert.equal(b.pricingInputs.denominators?.buyer, "50");
});

test("haff-ratio-v1 PERCENT derives the owner amount from the buyer denominator", () => {
  const quote = quoteOf(accountQuote("PERCENT", "A"));
  assert.equal(quote.lines[0]!.buyerAmount.amount, "120.00");
  assert.equal(quote.lines[0]!.ownerAmount.amount, "96.00");
  assert.equal(quote.platformFullProfit.amount, "24.00");
  assert.equal(quote.pricingInputs.spreadDelta, null);
  assert.equal(quote.pricingInputs.commissionRate, "0.2");
});

test("missing haff conditions, disabled options and invalid denominators are rejected instead of defaulted", () => {
  const missing = computeQuote({
    priceVersionId: "p1",
    mode: "SPREAD",
    roundingPolicy: "HALF_UP_CENT_V1",
    haffRule: HAFF_RULE,
    lines: [{ itemId: "item-haff", quantity: "1000000", pricingKind: "HAFF_RATIO" }],
    conditions: { termOptionCode: "daily-10m", pricingOptionCode: "standard" },
    termOption: { code: "daily-10m", dailyConsumption: "1000000", durationRounding: "CEIL_DAY" },
  });
  assert.equal(missing.quotable, false);
  assert.ok(missing.reasonCodes.includes("RULE_INPUT_MISSING"));

  const disabled = accountQuote("SPREAD", "A");
  const disabledQuote = computeQuote({
    priceVersionId: "p1",
    mode: "SPREAD",
    roundingPolicy: "HALF_UP_CENT_V1",
    haffRule: HAFF_RULE,
    lines: [{ itemId: "item-haff", quantity: "60000000", pricingKind: "HAFF_RATIO" }],
    conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", pricingOptionCode: "disabled" },
    termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" },
  });
  assert.equal(disabled.quotable, true);
  assert.equal(disabledQuote.quotable, false);
  assert.ok(disabledQuote.reasonCodes.includes("DEPENDENCY_UNAVAILABLE"));

  const zeroDenominator = computeQuote({
    priceVersionId: "p1",
    mode: "SPREAD",
    roundingPolicy: "HALF_UP_CENT_V1",
    haffRule: { ...HAFF_RULE, spreadDelta: "50" },
    lines: [{ itemId: "item-haff", quantity: "60000000", pricingKind: "HAFF_RATIO" }],
    conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", pricingOptionCode: "standard" },
    termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" },
  });
  assert.equal(zeroDenominator.quotable, false);
  assert.ok(zeroDenominator.reasonCodes.includes("INVALID_DENOMINATOR"));

  const negativeDenominator = computeQuote({
    priceVersionId: "p1",
    mode: "SPREAD",
    roundingPolicy: "HALF_UP_CENT_V1",
    haffRule: { ...HAFF_RULE, spreadDelta: "70" },
    lines: [{ itemId: "item-haff", quantity: "60000000", pricingKind: "HAFF_RATIO" }],
    conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", pricingOptionCode: "standard" },
    termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" },
  });
  assert.equal(negativeDenominator.quotable, false);
  assert.ok(negativeDenominator.reasonCodes.includes("INVALID_DENOMINATOR"));
});

test("fixed unit lines round half-up to cents and conserve buyer minus owner", () => {
  const spread = quoteOf(
    computeQuote({
      priceVersionId: "p1",
      mode: "SPREAD",
      roundingPolicy: "HALF_UP_CENT_V1",
      haffRule: HAFF_RULE,
      lines: [
        { itemId: "item-round", quantity: "7", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "0.335", ownerUnitAmount: "0.3" },
        { itemId: "item-haff", quantity: "60000000", pricingKind: "HAFF_RATIO" },
      ],
      conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", pricingOptionCode: "standard" },
      termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" },
    }),
  );
  const fixed = spread.lines.find((line) => line.itemId === "item-round")!;
  assert.equal(fixed.buyerAmount.amount, "2.35");
  assert.equal(fixed.ownerAmount.amount, "2.10");
  assert.equal(fixed.platformAmount.amount, "0.25");

  const percent = quoteOf(
    computeQuote({
      priceVersionId: "p1",
      mode: "PERCENT",
      roundingPolicy: "HALF_UP_CENT_V1",
      commissionRate: "0.25",
      haffRule: HAFF_RULE,
      lines: [
        { itemId: "item-round", quantity: "3", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "10" },
        { itemId: "item-haff", quantity: "1000000", pricingKind: "HAFF_RATIO" },
      ],
      conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", pricingOptionCode: "standard" },
      termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" },
    }),
  );
  const fixedPercent = percent.lines.find((line) => line.itemId === "item-round")!;
  assert.equal(fixedPercent.buyerAmount.amount, "30.00");
  assert.equal(fixedPercent.ownerAmount.amount, "22.50");
  assert.equal(percent.resourceTotal.amount, "32.00");
  assert.equal(percent.ownerTotal.amount, "24.00");
  assert.equal(percent.platformFullProfit.amount, "8.00");
});

test("fixed unit lines preserve round bundles and day quantities", () => {
  const quote = quoteOf(
    accountQuote("SPREAD", "A", {
      lines: [
        { itemId: "item-haff", quantity: "60000000", pricingKind: "HAFF_RATIO" },
        { itemId: "level6-bullet", quantity: "180", unit: "ROUND", pricingKind: "FIXED_UNIT", unitQuantity: "60", buyerUnitAmount: "10", ownerUnitAmount: "4" },
        { itemId: "top-insure-card", quantity: "3", unit: "DAY", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "5", ownerUnitAmount: "3" },
      ],
    }),
  );
  const bullets = quote.lines.find((line) => line.itemId === "level6-bullet")!;
  const insurance = quote.lines.find((line) => line.itemId === "top-insure-card")!;
  assert.equal(bullets.unit, "ROUND");
  assert.equal(bullets.unitQuantity, "60");
  assert.equal(bullets.buyerAmount.amount, "30.00");
  assert.equal(insurance.unit, "DAY");
  assert.equal(insurance.buyerAmount.amount, "15.00");
});

test("unconfigured deposit policy stays null instead of pretending free amounts", () => {
  const withoutDeposits = quoteOf(accountQuote("SPREAD", "A"));
  assert.equal(withoutDeposits.tenantDeposit, null);
  assert.equal(projectQuote(withoutDeposits, "public").tenantPayableTotal, null);
  assert.equal(withoutDeposits.publisherBailRequirement, null);
  assert.equal(withoutDeposits.pricingInputs.depositPolicy, "UNCONFIGURED");

  const withDeposits = quoteOf(accountQuote("SPREAD", "A", { deposits: { tenantDepositCents: "500", publisherBailRequirementCents: "3000" } }));
  assert.equal(withDeposits.tenantDeposit?.amount, "5.00");
  assert.equal(projectQuote(withDeposits, "public").tenantPayableTotal?.amount, "155.00");
  assert.equal(withDeposits.publisherBailRequirement?.amount, "30.00");
  assert.equal(withDeposits.pricingInputs.depositPolicy, "CONFIGURED");
});

test("timed entitlements without a known expiry are refused, permanent ones disclose full-term risk", () => {
  const unknownExpiry = accountQuote("SPREAD", "A", {
    entitlements: [{ entitlementId: "ent-1", expiryKind: "TIMED" as const }],
  });
  assert.equal(unknownExpiry.quotable, false);
  assert.ok(unknownExpiry.reasonCodes.includes("EXPIRY_UNKNOWN"));

  const knownExpiry = quoteOf(
    accountQuote("SPREAD", "A", {
      entitlements: [
        { entitlementId: "ent-1", expiryKind: "TIMED" as const, expiresAt: "2026-10-01T00:00:00Z" },
        { entitlementId: "ent-2", expiryKind: "PERMANENT" as const },
      ],
    }),
  );
  assert.deepEqual(knownExpiry.expiryDisclosures, [
    { entitlementId: "ent-1", expiresAt: "2026-10-01T00:00:00.000000Z", fullTermGuaranteed: false },
    { entitlementId: "ent-2", expiresAt: null, fullTermGuaranteed: false },
  ]);
});

test("quote projections are exhaustive whitelists without internal profit or owner fields", () => {
  const quote = quoteOf(accountQuote("SPREAD", "A", { deposits: { tenantDepositCents: "500", publisherBailRequirementCents: "3000" } }));
  const publicView = JSON.stringify(projectQuote(quote, "public"));
  assert.deepEqual(projectQuote(projectQuote(quote, "admin"), "public"), projectQuote(quote, "public"), "cached projected quotes can be safely narrowed again");
  for (const forbidden of ["ownerUnitAmount", "ownerAmount", "ownerTotal", "platformAmount", "platformFullProfit", "publisherBailRequirement", "pricingInputs", "contentHash", "storage_key"]) {
    assert.equal(publicView.includes(forbidden), false, `public quote leaked ${forbidden}`);
  }
  const ownerView = JSON.stringify(projectQuote(quote, "owner"));
  for (const forbidden of ["platformAmount", "platformFullProfit", "pricingInputs"]) {
    assert.equal(ownerView.includes(forbidden), false, `owner quote leaked ${forbidden}`);
  }
  assert.ok(ownerView.includes("publisherBailRequirement"));
  const adminView = projectQuote(quote, "admin");
  assert.equal(adminView.platformFullProfit?.amount, "30.00");
  assert.equal(adminView.pricingInputs?.denominators?.owner, "50");
});
