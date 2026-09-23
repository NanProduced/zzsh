import { computeQuote } from "../src/supply/pricing";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compatRule } from "./pricing-compat-fixture";

test("PC1 explicit v2 declaration/quote binding and old consumer rejection", () => {
  const make=(b:string, mode:"custom"|"fast"="custom")=>{
    const selection={rentalMode:mode,ownerRatioB:b};
    const result=computeQuote({priceVersionId:"pc1",mode:"SPREAD",customerTier:"STANDARD",roundingPolicy:"HALF_UP_CENT_V1",haffRule:compatRule(),lines:[{itemId:"haff",quantity:"100000000",pricingKind:"HAFF_RATIO",customerTier:"STANDARD"}],conditions:{safeBoxCode:"box-a",vitLevel:6,bearLevel:6,termOptionCode:"daily-10m",rentalPricing:selection},termOption:{code:"daily-10m",dailyConsumption:"10000000",durationRounding:"CEIL_DAY"}});
    assert.ok(result.quotable);
    const p=payload({schemaVersion:2,quoteValues:result.quote as unknown as Record<string,unknown>});
    p.declaration.attributes={...p.declaration.attributes,rentalPricing:selection};p.declaration.pricingOptionCode="";
    return p;
  };
  const p=make("46");
  assert.notEqual(computeContentHash(p),computeContentHash(make("45")));
  assert.notEqual(computeContentHash(p),computeContentHash(make("53","fast")));
  assert.throws(()=>normalizeContentPayload({...p,schemaVersion:1}));
  const mismatch=structuredClone(p);mismatch.declaration.attributes.rentalPricing={rentalMode:"fast",ownerRatioB:"53"};
  assert.throws(()=>normalizeContentPayload(mismatch));
});

import {
  canonicalizeContentPayload,
  computeContentHash,
  ContentHashError,
  normalizeDeclaration,
  normalizeContentPayload,
  normalizeTime,
  withoutContentHash,
  type ContentPayloadInput,
} from "../src/supply/content-hash";

function quoteValues(amount = "150.00"): Record<string, unknown> {
  const result = computeQuote({ priceVersionId: "price_1", mode: "PERCENT", commissionRate: "0.2", roundingPolicy: "HALF_UP_CENT_V1", haffRule: {schema:"haff-ratio-v1",baseBySafeBox:{a:"40"},vitalityDeltaByLevel:{6:"0"},bearDeltaByLevel:{6:"0"},dailyDeltaByTermOption:{d:"0"},options:{s:{delta:"0",enabled:true}}}, lines:[{itemId:"item-a",quantity:"60000000",pricingKind:"HAFF_RATIO"},{itemId:"item-b",quantity:"2",pricingKind:"FIXED_UNIT",unitQuantity:"1",buyerUnitAmount:"1"}],conditions:{safeBoxCode:"a",vitLevel:6,bearLevel:6,termOptionCode:"d",pricingOptionCode:"s"},termOption:{code:"d",dailyConsumption:"10000000",durationRounding:"CEIL_DAY"}});
  if (!result.quotable) throw new Error("Invalid fixture");
  result.quote.lines[0]!.buyerAmount.amount = amount;
  return result.quote as unknown as Record<string, unknown>;
}

function payload(overrides: Partial<ContentPayloadInput> = {}): ContentPayloadInput {
  return {
    schemaVersion: 1,
    accountId: "account_A",
    gameId: "game_delta",
    declaration: {
      title: "三角洲高配号",
      description: "合成测试声明",
      attributes: { vitLevel: 6, bearLevel: 6 },
      inventory: [
        { itemId: "item-b", quantity: "2" },
        { itemId: "item-a", quantity: "60000000" },
      ],
      skins: ["skin-b", "skin-a"],
      entitlements: [
        { entitlementId: "ent-b", value: null, expiresAt: null, expiryKnowledge: "KNOWN" },
        { entitlementId: "ent-a", value: null, expiresAt: "2026-10-01T00:00:00Z", expiryKnowledge: "KNOWN" },
      ],
      termOptionCode: "daily-10m",
      pricingOptionCode: "standard",
      mediaBindings: [
        { assetId: "asset-b", byteHash: "b".repeat(64), purpose: "ACCOUNT_EVIDENCE", position: 2 },
        { assetId: "asset-a", byteHash: "a".repeat(64), purpose: "ACCOUNT_EVIDENCE", position: 1 },
      ],
    },
    ruleRefs: {
      releaseId: "release_1",
      priceVersionId: "price_1",
      termVersionId: "term_1",
      agreementVersionId: "agreement_1",
      agreementDigest: "d".repeat(64),
    },
    quoteValues: quoteValues(),
    ...overrides,
  };
}

test("R6 normalized content is stable across text, numbers, UTC time, nulls and set order", () => {
  const a = payload(); a.declaration.title = "e\u0301\r\n正文";
  const b = structuredClone(a); b.declaration.title = "é\n正文";
  b.declaration.inventory = [...b.declaration.inventory].reverse(); b.declaration.inventory[0]!.quantity = "00060000000";
  b.declaration.entitlements[1]!.expiresAt = "2026-10-01T08:00:00.000000+08:00";
  b.declaration.attributes.info_source = null;
  const quote = b.quoteValues as any;
  quote.lines.reverse(); quote.pricingInputs.commissionRate = "0.20000000";
  quote.resourceTotal.amount = "152.0";
  assert.equal(computeContentHash(a), computeContentHash(b));
  assert.deepEqual(normalizeContentPayload(a), normalizeContentPayload(b));
  assert.equal(normalizeTime("2026-10-01T08:00:00.123456+08:00"), "2026-10-01T00:00:00.123456Z");
  assert.throws(() => normalizeTime("2026-10-01T00:00:00.1234567Z"), ContentHashError);
  assert.throws(() => normalizeTime("2026-02-30T00:00:00Z"), ContentHashError);
  for (const target of [b.ruleRefs, b.quoteValues, (b.quoteValues as any).pricingInputs, b.declaration.attributes]) {
    (target as any).unknown = "not allowed";
    assert.throws(() => computeContentHash(b), ContentHashError);
    delete (target as any).unknown;
  }
  b.declaration.entitlements[1]!.expiresAt = "2026-10-02T00:00:00Z";
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test("identical content with reordered collections and keys produces the same digest", () => {
  const first = computeContentHash(payload());
  assert.equal(first,"30ff67e9a64765b4eda81ecda5badd00b84ed4ea6c55e4574d5c697dc5f22923","v1 baseline cc96482 byte contract");
  const reordered = payload({
    declaration: {
      ...payload().declaration,
      inventory: [
        { itemId: "item-a", quantity: "60000000" },
        { itemId: "item-b", quantity: "2" },
      ],
      skins: ["skin-a", "skin-b"],
      entitlements: [
        { entitlementId: "ent-a", value: null, expiresAt: "2026-10-01T00:00:00Z", expiryKnowledge: "KNOWN" },
        { entitlementId: "ent-b", value: null, expiresAt: null, expiryKnowledge: "KNOWN" },
      ],
      mediaBindings: [
        { assetId: "asset-a", byteHash: "a".repeat(64), purpose: "ACCOUNT_EVIDENCE", position: 1 },
        { assetId: "asset-b", byteHash: "b".repeat(64), purpose: "ACCOUNT_EVIDENCE", position: 2 },
      ],
    },
  });
  assert.equal(computeContentHash(reordered), first);
  assert.equal(canonicalizeContentPayload(reordered), canonicalizeContentPayload(payload()));
});

test("owner full-payout declaration is strict, hash-bound, and omitted without changing legacy hashes", () => {
  const legacy = payload();
  const legacyHash = computeContentHash(legacy);
  const selected = structuredClone(legacy);
  selected.declaration.attributes.full_payout_declaration = { schema: "full-payout-declaration-v1", selected: true };
  const selectedHash = computeContentHash(selected);
  assert.notEqual(selectedHash, legacyHash);
  assert.deepEqual(normalizeContentPayload(selected).declaration.attributes.full_payout_declaration,
    { schema: "full-payout-declaration-v1", selected: true });
  const unselected = structuredClone(selected);
  (unselected.declaration.attributes.full_payout_declaration as { selected: boolean }).selected = false;
  assert.notEqual(computeContentHash(unselected), selectedHash);
  for (const declaration of [null, { schema: "unknown", selected: true }, { schema: "full-payout-declaration-v1", selected: "true" },
    { schema: "full-payout-declaration-v1", selected: true, fullPayoutFeeCents: "1" }]) {
    const invalid = structuredClone(legacy);
    (invalid.declaration.attributes as Record<string, unknown>).full_payout_declaration = declaration;
    assert.throws(() => computeContentHash(invalid), ContentHashError);
  }
  assert.equal(computeContentHash(legacy), legacyHash, "absent field keeps the v1 content hash stable");
});

test("quantity, price, media bytes and skins change the digest", () => {
  const base = computeContentHash(payload());
  const quantityChanged = computeContentHash(
    payload({
      declaration: {
        ...payload().declaration,
        inventory: payload().declaration.inventory.map((item) => (item.itemId === "item-a" ? { ...item, quantity: "50000000" } : item)),
      },
    }),
  );
  assert.notEqual(quantityChanged, base);
  const priceChanged = computeContentHash(payload({ quoteValues: quoteValues("160.00") }));
  assert.notEqual(priceChanged, base);
  const mediaChanged = computeContentHash(
    payload({
      declaration: {
        ...payload().declaration,
        mediaBindings: payload().declaration.mediaBindings.map((binding) =>
          binding.assetId === "asset-a" ? { ...binding, byteHash: "c".repeat(64) } : binding,
        ),
      },
    }),
  );
  assert.notEqual(mediaChanged, base);
  const skinChanged = computeContentHash(
    payload({ declaration: { ...payload().declaration, skins: ["skin-a", "skin-c"] } }),
  );
  assert.notEqual(skinChanged, base);
});

test("state-only changes are excluded because they are not part of the payload contract", () => {
  const normalized = normalizeDeclaration(payload().declaration);
  assert.deepEqual(Object.keys(normalized), [
    "title",
    "description",
    "attributes",
    "inventory",
    "skins",
    "entitlements",
    "termOptionCode",
    "pricingOptionCode",
    "mediaBindings",
  ]);
  const quoted = withoutContentHash({ contentHash: "ignored", value: 1 } as { contentHash?: string; value: number });
  assert.equal("contentHash" in quoted, false);
});

test("payloads containing a contentHash field or floating point numbers are rejected", () => {
  assert.throws(
    () => computeContentHash(payload({ quoteValues: { contentHash: "self-reference" } })),
    ContentHashError,
  );
  assert.throws(
    () => computeContentHash(payload({ quoteValues: { amount: 1.5 } })),
    ContentHashError,
  );
  assert.throws(
    () =>
      normalizeDeclaration({
        ...payload().declaration,
        inventory: [
          { itemId: "item-a", quantity: "1" },
          { itemId: "item-a", quantity: "2" },
        ],
      }),
    ContentHashError,
  );
});
