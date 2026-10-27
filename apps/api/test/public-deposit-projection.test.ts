import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { computeQuote } from "../src/supply/pricing";
import { computeContentHash, normalizeContentPayload } from "../src/supply/content-hash";
import { listingDetail, publicDepositProjection, type ListingVersion, type PublishingAccount } from "../src/supply/publishing";

const money = (amount: string) => ({ currency: "CNY", unit: "yuan", amount, scale: 2 });
const declared = (amountCents: unknown = "30000") => ({ schema: "owner-deposit-declaration-v1", amountCents, declarationVersion: "1" });
const quote = (amount = "761.97") => ({ currency: "CNY", tenantDeposit: null, resourceTotal: money(amount), lines: [{ buyerAmount: money(amount) }] });

test("only strict sealed declarations produce a deposit, including known zero and exact extreme cents", () => {
  assert.deepEqual(publicDepositProjection(quote(), declared()), { tenantDeposit: money("300.00"), tenantPayableTotal: money("1061.97") });
  assert.deepEqual(publicDepositProjection(quote("0.10"), declared("20")), { tenantDeposit: money("0.20"), tenantPayableTotal: money("0.30") });
  assert.deepEqual(publicDepositProjection(quote("1146.11"), declared("0")), { tenantDeposit: money("0.00"), tenantPayableTotal: money("1146.11") });
  assert.deepEqual(publicDepositProjection(quote("9999999999999999999999.99"), declared("999999999999999999999999")), {
    tenantDeposit: money("9999999999999999999999.99"), tenantPayableTotal: money("19999999999999999999999.98"),
  });
  for (const value of [undefined, null, {}, [], { ...declared(), schema: "legacy" }, { schema: "owner-deposit-declaration-v1", amountCents: "30000" },
    ...["-1", "-0", "1.5", "1e3", "+1", "01", "NaN", "Infinity", "", "9".repeat(25), 30000].map(amount => declared(amount)),
    { ...declared(), privateEvidence: "must-not-pass" }]) assert.equal(publicDepositProjection(quote(), value), null, JSON.stringify(value));
});

test("existing non-null frozen deposits and foreign quote currencies are never overwritten", () => {
  for (const tenantDeposit of [money("17.00"), money("0.00")]) {
    const source = { ...quote(), tenantDeposit }, before = JSON.stringify(source);
    assert.equal(publicDepositProjection(source, declared("30000")), null);
    assert.equal(JSON.stringify(source), before);
  }
  assert.equal(publicDepositProjection({ ...quote(), currency: "USD" }, declared()), null);
  for (const value of [null, undefined, [], {}, { ...quote(), tenantDeposit: undefined }]) assert.equal(publicDepositProjection(value, declared()), null);
});

test("unknown or invalid resource money keeps the known deposit and does not invent a total", () => {
  for (const resourceTotal of [undefined, null, {}, { amount: "1.00" }, { ...money("1.00"), currency: "USD" }, { ...money("1.00"), unit: "cent" },
    { ...money("1.00"), scale: 8 }, money("-1.00"), money("1e3"), money("0.001"), money("NaN")]) {
    assert.deepEqual(publicDepositProjection({ ...quote(), resourceTotal }, declared()), { tenantDeposit: money("300.00"), tenantPayableTotal: null });
  }
});

test("missing line detail retains the authoritative total while known conflicting lines suppress only the payable total", () => {
  for (const lines of [undefined, null, [], [{}], [{ buyerAmount: money("1.00") }, {}]]) {
    assert.equal(publicDepositProjection({ ...quote("10.00"), lines }, declared())?.tenantPayableTotal?.amount, "310.00");
  }
  for (const lines of [[{ buyerAmount: money("9.00") }], [{ buyerAmount: money("11.00") }], [{ buyerAmount: money("11.00") }, {}],
    [{ buyerAmount: { ...money("10.00"), unit: "cent" } }], [{ buyerAmount: { ...money("10.00"), currency: "USD" } }]]) {
    assert.deepEqual(publicDepositProjection({ ...quote("10.00"), lines }, declared()), { tenantDeposit: money("300.00"), tenantPayableTotal: null });
  }
});

function sealedListing(deposit: unknown = declared()) {
  const priced = computeQuote({ priceVersionId: "price", mode: "PERCENT", commissionRate: "0.2", roundingPolicy: "HALF_UP_CENT_V1",
    haffRule: { schema: "haff-ratio-v1", baseBySafeBox: { "box-a": "40" }, vitalityDeltaByLevel: { 6: "0" }, bearDeltaByLevel: { 6: "0" }, dailyDeltaByTermOption: { daily: "0" }, options: { standard: { delta: "0", enabled: true } } },
    lines: [{ itemId: "haff", quantity: "1000000", pricingKind: "HAFF_RATIO" }], conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily", pricingOptionCode: "standard" },
    termOption: { code: "daily", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" } });
  assert(priced.quotable); priced.quote.ownerTotal.amount = "123456.78";
  const payload = normalizeContentPayload({ schemaVersion: 1, accountId: "account", gameId: "game",
    declaration: { title: "Synthetic sealed listing", description: null, attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6, ...(deposit === undefined ? {} : { owner_deposit_declaration: deposit }), info_source: "PRIVATE_ATTRIBUTION" },
      termOptionCode: "daily", pricingOptionCode: "standard", inventory: [{ itemId: "haff", quantity: "1000000" }], skins: [], entitlements: [], mediaBindings: [{ assetId: "media", purpose: "ACCOUNT_DISPLAY", byteHash: "a".repeat(64), position: 0 }] },
    ruleRefs: { releaseId: "release", priceVersionId: "price", termVersionId: "term", agreementVersionId: "agreement", agreementDigest: "d".repeat(64) }, quoteValues: priced.quote });
  const account: PublishingAccount = { id: "account", owner_user_id: "owner", game_id: "game", current_version_id: "version", owner_paused: false, staff_restricted: false, restriction_reason: null, lifecycle: "ACTIVE", legacy_hold: "NONE", revision: "1", display_no: "AC0000000001" };
  const version: ListingVersion = { id: "version", account_id: account.id, sequence: "1", origin: "NATIVE", review_state: "PUBLISHED", schema_version: 1, title: payload.declaration.title, description: null,
    attributes: { ...payload.declaration.attributes, owner_deposit_declaration: declared("99999") }, term_option_code: "daily", pricing_option_code: "standard", rule_release_id: "release", content_hash: computeContentHash(payload), payload,
    presentation: { items: [], skins: [], entitlements: [] }, revision: "1", submitted_at: null };
  const sql: string[] = [];
  const client = { query: async (text: string) => {
    sql.push(text); let rows: unknown[] = [];
    if (text.includes("SELECT * FROM zzsh_supply.listing_version")) rows = [version];
    else if (text.includes("SELECT u.suspended")) rows = [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }];
    else if (text.includes("game_service_operation")) rows = [{ id: "service", gameId: "game", gameCode: "delta", gameEnabled: true, enabled: true, revision: "1" }];
    else if (text.includes("FROM zzsh_supply.game WHERE id=")) rows = [{ id: "game", code: "delta", name: "三角洲", enabled: true, current_release_id: "release", catalog_revision: "1" }];
    else if (text.includes("funding_policy AS policy")) rows = [{ policy: null }];
    else if (text.includes("rule_acceptance")) rows = [{}];
    else if (text.includes("SELECT a.* FROM zzsh_supply.listing_media")) rows = [{ id: "media", account_id: "account", game_id: "game", owner_user_id: "owner", ownership_kind: "USER_SUPPLY", purpose: "ACCOUNT_DISPLAY", content_hash: "a".repeat(64), review_state: "APPROVED", access_class: "PUBLIC_DISPLAY", technical_state: "READY", public_storage_key: "PRIVATE_STORAGE" }];
    else if (text.includes("zzsh_supply.listing_publication")) rows = [{ id: "publication", version_id: "version", account_id: "account", owner_user_id: "owner", game_id: "game", rule_release_id: "release", content_hash: version.content_hash, source: "OWNER_DIRECT", published_at: new Date("2026-10-01T00:00:00Z") }];
    else if (text.includes("term_option")) rows = [{ code: "daily", name: "每日", dailyConsumption: "10000000" }];
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;
  return { account, version, client, sql };
}

test("public list and detail use only the same sealed declaration without changing quote, payload or hash", async () => {
  const f = sealedListing(), before = JSON.stringify(f.version.payload), hash = f.version.content_hash;
  const gate = async () => ({ publisherBail: "NOT_REQUIRED" as const, occupancy: "FREE" as const, reference: "synthetic" });
  for (const mode of ["RENTABLE", "DETAIL"] as const) {
    const result: any = await listingDetail(f.client, f.account, "public", gate, "public", f.account, false, mode);
    assert.equal(result.quote.tenantDeposit.amount, "300.00", "current v.attributes carries a different declaration and must not supply the fallback");
    assert.equal(result.quote.tenantPayableTotal.amount, "302.50");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|123456\.78|ownerTotal|publisherBailRequirement|pricingInputs/);
    assert.equal(JSON.stringify(f.version.payload), before); assert.equal(f.version.content_hash, hash); assert.equal(computeContentHash(f.version.payload!), hash);
    assert.equal(f.version.payload!.quoteValues.tenantDeposit, null);
  }
  assert.equal(f.sql.some(text => /\b(?:INSERT|UPDATE|DELETE)\b|FOR UPDATE/.test(text)), false);
});

test("a sealed listing without a deposit remains unknown even when the current version attributes declare one", async () => {
  const f = sealedListing();
  delete f.version.payload!.declaration.attributes.owner_deposit_declaration;
  f.version.content_hash = computeContentHash(f.version.payload!);
  const before = JSON.stringify(f.version.payload), hash = f.version.content_hash;
  const result: any = await listingDetail(f.client, f.account, "public", async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "synthetic" }), "public", f.account, false, "DETAIL");
  assert.equal(result.quote.tenantDeposit, null); assert.equal(result.quote.tenantPayableTotal, null);
  assert.equal(JSON.stringify(f.version.payload), before); assert.equal(f.version.content_hash, hash);
});
