import { divideToScale, multiplyDecimal, parseNonNegativeDecimal } from "../src/supply/decimal";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compatRule } from "./pricing-compat-fixture";
import { CUSTOMER_TIERS, parseDeltaPriceLines, validateDeltaHaffRule, type CustomerTier, type RentalPricingSelection } from "../src/supply/delta-rental";
import { computeDepositRecommendation, type FundingPolicy } from "../src/supply/funding-policy";
import type { QuoteInput } from "../src/supply/pricing";
import { createCatalogEntry, updateCatalogEntry } from "../src/supply/catalog";
import { updatePriceDraft } from "../src/supply/rules";
import { DELTA_LEGACY_RESOURCES } from "../src/supply/legacy-observation";
import { readResourceIncomePreview } from "../src/supply/publishing";

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

// Pure writer models only: these fixture IDs and price amounts are not an installed catalog.
const TURTLE_FIXTURE = { id: "fixture_item_turtle45", gameId: "fixture_game_delta", code: "df_billable_turtle_backpack_45", unit: "PIECE", quantityScale: 0 };
function resourceWriterClient(item = TURTLE_FIXTURE) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith("SELECT *") && sql.includes('"price_version"')) return { rows: [{ id: "fixture_price", game_id: item.gameId, status: "DRAFT", revision: "1", mode: "SPREAD", haff_rule: compatRule() }], rowCount: 1 };
    if (sql.startsWith("SELECT *") && sql.includes('"billable_item"')) return { rows: [{ ...item, game_id: item.gameId, quantity_scale: item.quantityScale }], rowCount: 1 };
    if (sql.includes('FROM "zzsh_supply"."billable_item"') && sql.includes("ANY($1::text[])")) return { rows: [item], rowCount: 1 };
    if (sql.includes('FROM "zzsh_supply"."game"')) return { rows: [{ id: item.gameId, catalogRevision: "1" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }} as never;
  return { calls, client };
}

test("current insurance renames through its existing identity without changing frozen history or DAY units", async () => {
  const item = { ...TURTLE_FIXTURE, id: "fixture_existing_insurance", code: "df_billable_top_insure_card", unit: "DAY" };
  const f = resourceWriterClient(item);
  await updateCatalogEntry(f.client, "fixture_admin", true, "items", item.id, { name: "九格保险体验卡" });
  const update = f.calls.find(c => c.sql.includes('UPDATE "zzsh_supply"."billable_item"'))!;
  assert.equal(update.values[0], "九格保险体验卡"); assert.equal(update.values[8], item.id);
  assert.equal(update.values[1], null); assert.equal(update.values[5], null);
  assert(!update.sql.includes('"code" ='));
  assert(f.calls.every(c => !/listing_version|rental_order|legacy_|price_line/.test(c.sql)), "a current display-name edit never rewrites stored order/listing prices or names");
  for (const quantity of ["7", "0"]) {
    const input = compatInput("47", { rentalMode: "ordinary" });
    const quote = quoteOf(computeQuote({ ...input, lines: [...input.lines, { itemId: item.id, customerTier: "STANDARD", quantity, unit: "DAY", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "5", ownerUnitAmount: "3" }] }));
    const line = quote.lines.find(l => l.itemId === item.id)!;
    assert.equal(line.quantity, quantity); assert.equal(line.unit, "DAY"); assert.equal(line.buyerAmount.amount, quantity === "7" ? "35.00" : "0.00");
  }
  for (const unit of ["PIECE", "ROUND"]) await assert.rejects(() => createCatalogEntry(resourceWriterClient(item).client, "fixture_admin", true, "items", item.gameId, { code: item.code, name: "九格保险体验卡", unit, quantityScale: 0 }));
});

test("turtle catalog keeps PIECE scale0 and retired insurance cannot become the new resource", async () => {
  const f = resourceWriterClient();
  await createCatalogEntry(f.client, "fixture_admin", true, "items", TURTLE_FIXTURE.gameId, { code: TURTLE_FIXTURE.code, name: "45格乌龟包", unit: "PIECE", quantityScale: 0 });
  const insert = f.calls.find(c => c.sql.includes('INSERT INTO "zzsh_supply"."billable_item"'))!;
  assert.equal(insert.values[2], TURTLE_FIXTURE.code); assert.equal(insert.values[4], "PIECE"); assert.equal(insert.values[5], 0);
  for (const patch of [{ unit: "DAY" }, { unit: "ROUND" }, { quantityScale: 1 }, { quantityScale: 0.5 }]) {
    await assert.rejects(() => createCatalogEntry(resourceWriterClient().client, "fixture_admin", true, "items", TURTLE_FIXTURE.gameId, { code: TURTLE_FIXTURE.code, name: "45格乌龟包", unit: "PIECE", quantityScale: 0, ...patch }));
  }
  for (const code of ["top_insure_card_piece", "df_billable_top_insure_card_piece"]) await assert.rejects(() => createCatalogEntry(resourceWriterClient().client, "fixture_admin", true, "items", TURTLE_FIXTURE.gameId, { code, name: "九格保险体验卡", unit: "PIECE", quantityScale: 0 }));
  assert(!DELTA_LEGACY_RESOURCES.some(([, codes]) => (codes as readonly string[]).includes(TURTLE_FIXTURE.code)), "new inventory is never backfilled as a legacy zero");
});

test("turtle price writer uses stored scale and unit plus FIXED_UNIT unitQuantity1", async () => {
  const lines = CUSTOMER_TIERS.map(customerTier => ({ itemId: TURTLE_FIXTURE.id, customerTier, pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "10.00", ownerUnitAmount: "6.00" }));
  const f = resourceWriterClient();
  await updatePriceDraft(f.client, "fixture_admin", true, "fixture_price", { expectedRevision: "1", lines });
  const inserted = f.calls.filter(c => c.sql.includes('INSERT INTO "zzsh_supply"."price_line"'));
  assert.equal(inserted.length, 4); assert.deepEqual(inserted.map(c => c.values[7]), [...CUSTOMER_TIERS]);
  for (const row of inserted) assert.deepEqual(row.values.slice(2, 7), [TURTLE_FIXTURE.id, "FIXED_UNIT", "1", "10.00", "6.00"]);
  for (const patch of [{ unit: "DAY" }, { quantityScale: 1 }, { quantityScale: undefined }]) {
    const bad = resourceWriterClient({ ...TURTLE_FIXTURE, ...patch } as typeof TURTLE_FIXTURE);
    await assert.rejects(() => updatePriceDraft(bad.client, "fixture_admin", true, "fixture_price", { expectedRevision: "1", lines }));
    assert(!bad.calls.some(c => c.sql.startsWith("DELETE") || c.sql.includes('INSERT INTO "zzsh_supply"."price_line"')));
  }
  for (const unitQuantity of ["45", "2"]) await assert.rejects(() => updatePriceDraft(resourceWriterClient().client, "fixture_admin", true, "fixture_price", { expectedRevision: "1", lines: lines.map(l => ({ ...l, unitQuantity })) }));
});

test("turtle quantity2 quotes buyer20 owner12 in all four tiers; invalid/missing facts never become zero", () => {
  for (const tier of CUSTOMER_TIERS) {
    const input = compatInput("47", { rentalMode: "ordinary" }, tier);
    const turtle = { itemId: TURTLE_FIXTURE.id, customerTier: tier, quantity: "2", unit: "PIECE" as const, pricingKind: "FIXED_UNIT" as const, unitQuantity: "1", buyerUnitAmount: "10.00", ownerUnitAmount: "6.00" };
    const quoted = quoteOf(computeQuote({ ...input, lines: [...input.lines, turtle] }));
    const line = quoted.lines.find(l => l.itemId === TURTLE_FIXTURE.id)!;
    assert.equal(line.buyerAmount.amount, "20.00"); assert.equal(line.ownerAmount.amount, "12.00"); assert.equal(line.unitQuantity, "1"); assert.equal(line.unit, "PIECE");
    const publicQuote = projectQuote(quoted, "public");
    assert.equal(publicQuote.ownerTotal, undefined); assert.equal(publicQuote.platformFullProfit, undefined);
    assert.equal((publicQuote.lines.find(l => l.itemId === TURTLE_FIXTURE.id) as { ownerAmount?: unknown }).ownerAmount, undefined);
    for (const quantity of [undefined, null, "-1", "1.5", "1e3"]) assert.equal(computeQuote({ ...input, lines: [...input.lines, { ...turtle, quantity: quantity as string }] }).quotable, false);
    for (const patch of [{ customerTier: undefined }, { buyerUnitAmount: undefined }, { ownerUnitAmount: undefined }]) assert.equal(computeQuote({ ...input, lines: [...input.lines, { ...turtle, ...patch }] }).quotable, false);
    const zero = quoteOf(computeQuote({ ...input, lines: [...input.lines, { ...turtle, quantity: "0" }] })).lines.find(l => l.itemId === TURTLE_FIXTURE.id)!;
    assert.equal(zero.quantity, "0"); assert.equal(zero.buyerAmount.amount, "0.00");
    const frozen = structuredClone(quoted);
    quoteOf(computeQuote({ ...input, priceVersionId: "fixture_later_price", lines: [...input.lines, { ...turtle, buyerUnitAmount: "11.00", ownerUnitAmount: "7.00" }] }));
    assert.deepEqual(quoted, frozen, "a later price cannot rewrite the frozen old quote");
  }
});

test("resource preview keeps dynamic turtle stock unknown/zero distinct and rejects out-of-range direct API inventory", async () => {
  const expected = { catalogRevision: "1", releaseId: "fixture_release" };
  const item = { itemId: TURTLE_FIXTURE.id, code: TURTLE_FIXTURE.code, name: "45格乌龟包", unit: "PIECE", enabled: true, pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "10.00", ownerUnitAmount: "6.00" };
  const previewClient = (priced = true) => ({ query: async (sql: string) => ({ rows: sql.includes("FROM zzsh_supply.game")
    ? [{ releaseId: expected.releaseId, catalogRevision: expected.catalogRevision, priceVersionId: "fixture_price", generation: "1", mode: "SPREAD", roundingPolicy: "HALF_UP_CENT_V1" }]
    : [{ ...item, ...(priced ? {} : { ownerUnitAmount: null }) }] }) }) as never;
  const known = await readResourceIncomePreview(previewClient(), TURTLE_FIXTURE.gameId, [{ itemId: item.itemId, quantity: "2" }], expected);
  assert.equal(known.available, true); assert(known.lines);
  assert.equal(known.lines[0]!.code, TURTLE_FIXTURE.code); assert.equal(known.lines[0]!.ownerAmount!.amount, "12.00");
  for (const inventory of [[], [{ itemId: item.itemId, quantity: null }]]) {
    const unknown = await readResourceIncomePreview(previewClient(), TURTLE_FIXTURE.gameId, inventory, expected);
    assert(unknown.available); assert(unknown.lines); assert.equal(unknown.lines[0]!.quantity, null); assert.equal(unknown.lines[0]!.ownerAmount, null); assert.equal(unknown.ownerTotal, null);
  }
  const zero = await readResourceIncomePreview(previewClient(), TURTLE_FIXTURE.gameId, [{ itemId: item.itemId, quantity: "0" }], expected);
  assert(zero.available); assert(zero.lines); assert.equal(zero.lines[0]!.quantity, "0"); assert.equal(zero.ownerTotal!.amount, "0.00");
  const unpriced = await readResourceIncomePreview(previewClient(false), TURTLE_FIXTURE.gameId, [{ itemId: item.itemId, quantity: "2" }], expected);
  assert(unpriced.available); assert.deepEqual(unpriced.unpricedItemIds, [item.itemId]); assert.equal(unpriced.ownerTotal, null);
  for (const quantity of [undefined, "-1", "0.5", "9".repeat(25)]) {
    let reads = 0;
    await assert.rejects(() => readResourceIncomePreview({ query: async () => { reads++; throw Error("must reject before SQL"); } } as never, TURTLE_FIXTURE.gameId, [{ itemId: item.itemId, quantity }], expected));
    assert.equal(reads, 0);
  }
  await assert.rejects(() => readResourceIncomePreview(previewClient(), TURTLE_FIXTURE.gameId, [{ itemId: "fixture_unknown_resource", quantity: "2" }], expected));
});

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
    assert.equal(publicQ.ownerHaffRatio,undefined);
    assert.equal(projectQuote(q,"owner").ownerHaffRatio,"47");
    assert.equal(projectQuote(projectQuote(q,"admin"),"owner").ownerHaffRatio,"47");
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

test("synthetic four-tier resource vectors freeze per-day/per-round/per-60 quantities without multiplying by rental days",()=>{
  for(const tier of ["STANDARD","VIP","SVIP","DISCOUNT_USER"] as const){
    const input=compatInput("47",{rentalMode:"ordinary"});
    const fixed=[
      {itemId:"new-card",unit:"PIECE" as const,quantity:"3",unitQuantity:"1",buyerUnitAmount:"5",ownerUnitAmount:"3"},
      {itemId:"frozen-day",unit:"DAY" as const,quantity:"3",unitQuantity:"1",buyerUnitAmount:"5",ownerUnitAmount:"3"},
      {itemId:"barrett",unit:"ROUND" as const,quantity:"2",unitQuantity:"1",buyerUnitAmount:"0.5",ownerUnitAmount:"0.2"},
      {itemId:"six",unit:"ROUND" as const,quantity:"120",unitQuantity:"60",buyerUnitAmount:"10",ownerUnitAmount:"4"},
    ].map(line=>({...line,customerTier:tier,pricingKind:"FIXED_UNIT" as const}));
    const result=computeQuote({...input,customerTier:tier,lines:[...input.lines.map(line=>({...line,customerTier:tier})),...fixed]});
    const quote=quoteOf(result),line=(id:string)=>quote.lines.find(line=>line.itemId===id)!;
    assert.equal(line("new-card").unit,"PIECE");assert.equal(line("frozen-day").unit,"DAY");
    assert.equal(line("new-card").buyerAmount.amount,"15.00");assert.equal(line("frozen-day").buyerAmount.amount,"15.00");
    assert.equal(line("barrett").buyerAmount.amount,"1.00");assert.equal(line("barrett").ownerAmount.amount,"0.40");
    assert.equal(line("six").buyerAmount.amount,"20.00");assert.equal(line("six").unitQuantity,"60");
    assert.equal(quote.lines.reduce((sum,line)=>sum+BigInt(line.buyerAmount.amount.replace(".","")),0n).toString(),quote.resourceTotal.amount.replace(".",""));
    assert.equal(quote.lines.reduce((sum,line)=>sum+BigInt(line.ownerAmount.amount.replace(".","")),0n).toString(),quote.ownerTotal.amount.replace(".",""));
  }
});

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


test("deposit recommendation follows policy weights, skin groups, rounding and cap", () => {
  const policy = {
    recommendation: {
      parameters: {
        safeBoxWeightsByCode: { box: "10000", empty: "0" },
        vitalityAtLeast7Cents: "5000",
        bearAtLeast7Cents: "5000",
        diveAtLeast3Cents: "5000",
        skinGroupById: { knifeA: "LEGACY_KNIFE", knifeB: "LEGACY_KNIFE", weaponA: "LEGACY_WEAPON", plain: "NONE" },
        skinWeights: {
          LEGACY_GOLD: { firstCents: "10000", subsequentCents: "5000" },
          LEGACY_AGENT: { firstCents: "10000", subsequentCents: "5000" },
          LEGACY_KNIFE: { firstCents: "20000", subsequentCents: "10000" },
          LEGACY_WEAPON: { firstCents: "15000", subsequentCents: "5000" },
        },
        rounding: { mode: "CEIL", unitCents: "5000", zeroFallbackCents: "5000" },
        upperLimitCents: "100000",
      },
    },
  } as unknown as FundingPolicy;
  const base = { accountId: "account_a", gameId: "game_a", listingVersionId: "version_a", priceVersionId: "price_a", ruleReleaseId: "release_a", safeBoxCode: "box", vitality: 7, bear: 7, dive: 3, skinIds: ["knifeA", "knifeB", "weaponA", "plain"] as string[] };
  assert.equal(computeDepositRecommendation(policy, base), "70000");
  assert.equal(computeDepositRecommendation(policy, { ...base, vitality: 6, bear: 6, dive: 2, skinIds: [] }), "10000");
  assert.equal(computeDepositRecommendation(policy, { ...base, safeBoxCode: "empty", vitality: 0, bear: 0, dive: 0, skinIds: [] }), "5000", "zero total falls back to the policy minimum unit");
  assert.equal(computeDepositRecommendation(policy, { ...base, skinIds: ["knifeA", "knifeA", "knifeA", "knifeA"] }), "75000");
  assert.throws(() => computeDepositRecommendation(policy, { ...base, safeBoxCode: "missing" }), (error: any) => error.status === 400);
  assert.throws(() => computeDepositRecommendation(policy, { ...base, vitality: null }), (error: any) => error.status === 400);
  assert.throws(() => computeDepositRecommendation(policy, { ...base, skinIds: ["unmapped"] }), (error: any) => error.status === 400);
  assert.throws(() => computeDepositRecommendation(policy, { ...base, accountId: "bad id" }), (error: any) => error.status === 400);
  const capped = { ...policy, recommendation: { parameters: { ...policy.recommendation.parameters, upperLimitCents: "60000" } } } as unknown as FundingPolicy;
  assert.equal(computeDepositRecommendation(capped, base), "60000");
});

// G3-ext Part1: a disabled haff-ratio-v2 mode may omit its lane and bounds,
// while an enabled mode keeps every lane, bound and tier discount requirement.
const assertCompatRejected = (rule: unknown, message: string) =>
  assert.throws(() => validateDeltaHaffRule(rule, "SPREAD"), (error: any) => error.status === 400 && error.code === "INVALID_ARGUMENT", message);

function patchCompatModes(patch: Record<string, unknown>): ReturnType<typeof compatRule> {
  const rule = compatRule();
  Object.assign(rule.compatibility!.modes as unknown as Record<string, unknown>, patch);
  return rule;
}

function dropCompatLane(rule: ReturnType<typeof compatRule>, lane: "ordinary" | "fast"): ReturnType<typeof compatRule> {
  delete (rule.compatibility as unknown as Record<string, unknown>)[lane];
  return rule;
}

test("haff-ratio-v2 disabled fast mode may omit the fast lane and still quote", () => {
  const rule = dropCompatLane(patchCompatModes({ fast: { enabled: false } }), "fast");
  assert.equal(validateDeltaHaffRule(rule, "SPREAD").compatibility?.fast, undefined, "a disabled fast mode needs no lane");
  const ordinary = quoteOf(computeQuote({ ...compatInput("47", { rentalMode: "ordinary" }), haffRule: rule }));
  assert.equal(projectQuote(ordinary, "public").rentalMode, "ordinary");
  assert.equal(projectQuote(ordinary, "owner").ownerHaffRatio, "47");
  const custom = quoteOf(computeQuote({ ...compatInput("47", { rentalMode: "custom", ownerRatioB: "45" }), haffRule: rule }));
  assert.equal(projectQuote(custom, "public").rentalMode, "custom");
  assert.equal(projectQuote(custom, "owner").ownerHaffRatio, "45");
});

test("haff-ratio-v2 disabled modes treat partial or malformed bounds as omitted", () => {
  for (const partial of [
    { min: { base: "C", value: "-3" } },
    { max: { base: "C", value: "-1" } },
    { min: "not-a-bound" },
    { min: { base: "C", value: -3 } },
  ]) {
    const custom = patchCompatModes({ custom: { enabled: false, ...partial } });
    assert.equal(validateDeltaHaffRule(custom, "SPREAD").compatibility?.modes.custom.enabled, false);
    const fast = dropCompatLane(patchCompatModes({ fast: { enabled: false, ...partial } }), "fast");
    assert.equal(validateDeltaHaffRule(fast, "SPREAD").compatibility?.modes.fast.enabled, false);
  }
});

test("haff-ratio-v2 enabled modes still require lanes, bounds and all four discounts", () => {
  assertCompatRejected(dropCompatLane(compatRule(), "fast"), "an enabled fast mode requires its lane");
  assertCompatRejected(patchCompatModes({ fast: { enabled: true, min: { base: "C", value: "6" } } }), "an enabled fast mode requires max");
  assertCompatRejected(patchCompatModes({ custom: { enabled: true, max: { base: "C", value: "-1" } } }), "an enabled custom mode requires min");
  const missingTier = compatRule();
  missingTier.compatibility!.fast.discounts.SVIP = undefined as unknown as string;
  assertCompatRejected(missingTier, "an enabled fast mode requires all four tier discounts");
});

test("haff-ratio-v2 enabled modes reject unsupported bound bases and non-decimal values", () => {
  assertCompatRejected(patchCompatModes({ custom: { enabled: true, min: { base: "D", value: "-3" }, max: { base: "C", value: "-1" } } }), "bound base must be C or ABSOLUTE");
  assertCompatRejected(patchCompatModes({ custom: { enabled: true, min: { base: "C", value: "abc" }, max: { base: "C", value: "-1" } } }), "bound value must be a signed decimal string");
  assertCompatRejected(patchCompatModes({ custom: { enabled: true, min: { base: "C", value: -3 }, max: { base: "C", value: "-1" } } }), "bound value must not be a number");
});

test("custom owner ratios outside the configured ABSOLUTE bounds stay unquotable", () => {
  const rule = patchCompatModes({ custom: { enabled: true, min: { base: "ABSOLUTE", value: "44" }, max: { base: "ABSOLUTE", value: "46" } } });
  const quotable = (ownerRatioB: string) => computeQuote({ ...compatInput("47", { rentalMode: "custom", ownerRatioB }), haffRule: rule }).quotable;
  assert.equal(quotable("44"), true);
  assert.equal(quotable("46"), true);
  assert.equal(quotable("43.99"), false);
  assert.equal(quotable("46.01"), false);
});

test("the ordinary lane and at least one enabled mode remain mandatory", () => {
  assertCompatRejected(dropCompatLane(patchCompatModes({ ordinary: { enabled: false } }), "ordinary"), "the ordinary lane is mandatory even when its mode is disabled");
  assertCompatRejected(patchCompatModes({ ordinary: { enabled: false }, custom: { enabled: false }, fast: { enabled: false } }), "at least one pricing mode must stay enabled");
});

test("haff-ratio-v1 behavior is untouched by the v2 relaxation", () => {
  const parsed = validateDeltaHaffRule(HAFF_RULE, "SPREAD");
  assert.equal(parsed.schema, "haff-ratio-v1");
  assert.equal(parsed.spreadDelta, "10");
  const withoutSpread = { ...HAFF_RULE };
  delete (withoutSpread as unknown as Record<string, unknown>).spreadDelta;
  assertCompatRejected(withoutSpread, "v1 SPREAD still requires spreadDelta");
});

test("the G3 S1 price draft haffRule (fast disabled, no fast lane) validates and quotes", () => {
  // Body copied verbatim from config-bodies.json S1-price-draft-after-g3-ext.
  const rule = {
    schema: "haff-ratio-v2",
    baseBySafeBox: { safe_box_1x2: "60", safe_box_2x2: "57", safe_box_2x3: "53", safe_box_3x3: "49" },
    vitalityDeltaByLevel: { "4": "0", "5": "0", "6": "0", "7": "-1" },
    bearDeltaByLevel: { "4": "0", "5": "0", "6": "0", "7": "-1" },
    dailyDeltaByTermOption: { legacy_daily_10m: "0", legacy_daily_20m: "2", legacy_daily_30m: "3", legacy_daily_40m: "4", legacy_daily_50m: "5" },
    compatibility: {
      ordinary: { spreadDelta: "8", discounts: { STANDARD: "0", VIP: "2", SVIP: "4", DISCOUNT_USER: "2" } },
      modes: {
        ordinary: { enabled: true },
        custom: { enabled: true, min: { base: "C", value: "-3" }, max: { base: "C", value: "-1" } },
        fast: { enabled: false },
      },
    },
  };
  assert.equal(validateDeltaHaffRule(rule, "SPREAD").schema, "haff-ratio-v2");
  const quote = computeQuote({ priceVersionId: "s1-price-draft-fixture", mode: "SPREAD", roundingPolicy: "HALF_UP_CENT_V1", customerTier: "STANDARD",
    haffRule: rule as unknown as HaffRatioRule,
    conditions: { safeBoxCode: "safe_box_3x3", vitLevel: 7, bearLevel: 7, termOptionCode: "legacy_daily_10m", rentalPricing: { rentalMode: "custom", ownerRatioB: "45" } },
    lines: [{ itemId: "haff", pricingKind: "HAFF_RATIO", customerTier: "STANDARD", quantity: "100000000" }],
    termOption: { code: "legacy_daily_10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" } });
  assert.equal(quote.quotable, true, JSON.stringify(quote));
});
