import test from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { handlePublishingRoute } from "../src/supply/publishing-routes";
import { parseOwnerIncomePreviewInput, type OwnerIncomePreviewInput, type OwnerIncomePreview } from "../src/supply/owner-income-preview";
import { computeDeltaQuote, type QuoteInput } from "../src/supply/pricing";
import type { SupplyRuntimeOptions } from "../src/supply/supply-routes";
import type { IncomePreviewItem, IncomePreviewRelease } from "../src/supply/publishing";
import { compatRule } from "./pricing-compat-fixture";
import { fundingPolicyFixture } from "./funding-authority-fixtures";

const origin = "http://preview.invalid", path = "/games/fixture_game/owner-income-preview";
const forbiddenSql = /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b|\bFOR\s+(UPDATE|SHARE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)\b|pg_(?:try_)?advisory(?:_xact)?_lock/i;

test("Master: preview enum fields reject arrays instead of coercing them to valid strings", () => {
  for (const value of [["ordinary"], ["custom"], ["fast"]]) {
    const input = body(); input.attributes.rentalPricing = { rentalMode: value } as never;
    assert.throws(() => parseOwnerIncomePreviewInput(input), (error: any) => error.status === 400);
  }
  for (const value of [["KNOWN"], ["UNKNOWN"]]) {
    const input = body(); input.entitlements = [{ entitlementId: "timed", value: true, expiresAt: null, expiryKnowledge: value }] as never;
    assert.throws(() => parseOwnerIncomePreviewInput(input), (error: any) => error.status === 400);
  }
});

test("Master: an unselected disabled required item does not block the active form, but explicit selection is rejected", async () => {
  const f = fixture();
  f.items.push({ ...f.items[1]!, itemId: "disabled-item", code: "disabled-resource", enabled: false, required: true });
  const result = await f.run();
  assert.equal(result.statusCode, 200); assert.equal(result.body.state, "READY");
  const expected = computeDeltaQuote(f.formalInput(body())); assert(expected.quotable);
  assert.deepEqual(result.body.totalExpectedIncome, expected.quote.ownerTotal);
  const selected = body(); selected.inventory.push({ itemId: "disabled-item", quantity: "0" });
  assert.equal((await f.run(selected)).statusCode, 400);
});
function body(): OwnerIncomePreviewInput {
  return { releaseId: "fixture_release", catalogRevision: "1", attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6, rentalPricing: { rentalMode: "ordinary" } }, termOptionCode: "daily-10m",
    inventory: [{ itemId: "haff", quantity: "100000000" }, { itemId: "ammo", quantity: "120" }, { itemId: "card", quantity: "3" }], entitlements: [] };
}
function fixture() {
  const state = { userId: "fixture_owner", authenticated: true, active: true, sessionValid: true, gameEnabled: true, accountOwner: "fixture_owner", accountGame: "fixture_game", accountExists: true, ruleExists: true, policyExists: true, sdkFailure: false, failSql: "" };
  const release: IncomePreviewRelease = { releaseId: "fixture_release", generation: "1", priceVersionId: "fixture_price", termVersionId: "fixture_term", catalogRevision: "1", priceStatus: "SEALED", mode: "SPREAD", commissionRate: null, roundingPolicy: "HALF_UP_CENT_V1", haffRule: compatRule("47") };
  const items: IncomePreviewItem[] = [
    { itemId: "haff", code: "haff", name: "哈夫币", unit: "HAFF_BASE", enabled: true, required: true, pricingKind: "HAFF_RATIO", unitQuantity: null, buyerUnitAmount: null, ownerUnitAmount: null },
    { itemId: "ammo", code: "level6_round", name: "六级子弹", unit: "ROUND", enabled: true, required: false, pricingKind: "FIXED_UNIT", unitQuantity: "60", buyerUnitAmount: "8", ownerUnitAmount: "4" },
    { itemId: "card", code: "df_billable_top_insure_card", name: "九格保险体验卡", unit: "DAY", enabled: true, required: false, pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "5", ownerUnitAmount: "3" },
  ];
  const entitlements = [{ entitlementId: "timed", valueKind: "FLAG", expiryKind: "TIMED", enabled: true }, { entitlementId: "permanent", valueKind: "LEVEL", expiryKind: "PERMANENT", enabled: true }];
  const term: QuoteInput["termOption"] = { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" };
  const queries: string[] = [], values: unknown[][] = [];
  let authCalls = 0, connections = 0, releases = 0, poolReads = 0;
  const client = { async query(sql: string, params: unknown[] = []) {
    queries.push(sql); values.push(params); assert(!forbiddenSql.test(sql), "business preview attempted a write or row lock");
    if (state.failSql && sql.includes(state.failSql)) throw Object.assign(Error("PRIVATE_DRIVER_DETAIL_MUST_NOT_LEAK"), { code: "ECONNRESET" });
    let rows: unknown[];
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql) || sql.includes("set_config('statement_timeout'")) rows = [];
    else if (sql.includes('AS "evaluatedAt"')) rows = [{ evaluatedAt: "2026-10-25T00:00:00.000Z" }];
    else if (sql.includes('SELECT "suspended"')) rows = [{ suspended: !state.active }];
    else if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) rows = [{ accountStatus: state.active ? "ACTIVE" : "DEACTIVATED" }];
    else if (sql.includes('FROM "zzsh_auth_user"."session"')) rows = state.sessionValid ? [{}] : [];
    else if (sql.includes('game_service_operation')) rows = [{ id: "fixture_service", gameId: "fixture_game", gameCode: "delta", gameEnabled: state.gameEnabled, enabled: state.gameEnabled, revision: "1", serviceCode: "ACCOUNT_RENTAL" }];
    else if (sql.includes('SELECT * FROM zzsh_supply.rental_account')) rows = state.accountExists ? [{ owner_user_id: state.accountOwner, game_id: state.accountGame }] : [];
    else if (sql.includes('commission_rate')) rows = state.ruleExists ? [release] : [];
    else if (sql.includes('FROM zzsh_supply.billable_item')) rows = sql.includes("i.unit<>'HAFF_BASE'") ? items.filter(row => row.unit !== "HAFF_BASE") : items;
    else if (sql.includes('FROM zzsh_supply.term_option')) rows = params[1] === term.code ? [term] : [];
    else if (sql.includes('FROM zzsh_supply.entitlement')) rows = entitlements.filter(row => (params[1] as string[]).includes(row.entitlementId));
    else if (sql.includes('funding_policy AS policy')) rows = state.policyExists ? [{ policy: fundingPolicyFixture("NOT_REQUIRED") }] : [];
    else throw Error("UNEXPECTED_PREVIEW_SQL");
    return { rows, rowCount: rows.length };
  }, release() { releases++; } } as unknown as PoolClient;
  const pool = { async connect() { connections++; return client; }, async query(sql: string) { poolReads++; assert(sql.includes('u."suspended"'), "only SDK identity-state precheck uses pool.query"); return { rows: state.active ? [{ suspended: false, accountStatus: "ACTIVE" }] : [], rowCount: state.active ? 1 : 0 }; } } as unknown as Pool;
  const options = { pool, userOrigin: origin, apiOrigin: "http://api.invalid", userAuth: { api: { async getSession() { authCalls++; if (state.sdkFailure) throw Error("SDK_LIFECYCLE_FAILURE"); return state.authenticated ? { user: { id: state.userId }, session: { id: "fixture_session" } } : null; } } } } as unknown as SupplyRuntimeOptions;
  async function run(input: unknown = body(), patch: Record<string, unknown> = {}, query = new URLSearchParams(), routePath = path) {
    const response = { statusCode: 0, headersSent: false, headers: {} as Record<string, string>, body: null as any,
      setHeader(key: string, value: string | string[]) { this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value; return this; }, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.body = value; this.headersSent = true; } };
    const request = { method: "POST", headers: { cookie: "fixture-synthetic-cookie", origin, "content-type": "application/json" }, rawBody: Buffer.from(JSON.stringify(input)), body: input, ...patch };
    assert(await handlePublishingRoute(request, response, options, "fixture_request", routePath, query, false));
    return response;
  }
  function formalInput(input: OwnerIncomePreviewInput): QuoteInput {
    return { priceVersionId: release.priceVersionId, customerTier: "STANDARD", mode: release.mode, roundingPolicy: release.roundingPolicy, haffRule: release.haffRule, ...(release.commissionRate === null ? {} : { commissionRate: release.commissionRate }),
      conditions: { safeBoxCode: input.attributes.safe_box_code!, vitLevel: input.attributes.vit_level!, bearLevel: input.attributes.bear_level!, termOptionCode: input.termOptionCode!, pricingOptionCode: input.pricingOptionCode ?? undefined, rentalPricing: input.attributes.rentalPricing ?? undefined }, termOption: term,
      lines: input.inventory.filter(row => row.quantity !== null).map(row => { const item = items.find(i => i.itemId === row.itemId)!; return { itemId: item.itemId, quantity: row.quantity!, unit: item.unit, pricingKind: item.pricingKind!, customerTier: "STANDARD", ...(item.unitQuantity === null ? {} : { unitQuantity: item.unitQuantity }), ...(item.buyerUnitAmount === null ? {} : { buyerUnitAmount: item.buyerUnitAmount }), ...(item.ownerUnitAmount === null ? {} : { ownerUnitAmount: item.ownerUnitAmount }) }; }) };
  }
  return { state, release, items, entitlements, term, queries, values, run, formalInput, counts: () => ({ authCalls, connections, releases, poolReads }) };
}

test("owner preview ordinary/custom/fast equals the actual formal quote engine, without non-price prerequisites", async () => {
  for (const rentalPricing of [{ rentalMode: "ordinary" as const }, { rentalMode: "custom" as const, ownerRatioB: "44" }, { rentalMode: "fast" as const, ownerRatioB: "53" }]) {
    const f = fixture(), input = body(); input.attributes.rentalPricing = rentalPricing;
    const result = await f.run(input), expected = computeDeltaQuote(f.formalInput(input)); assert(expected.quotable);
    assert.equal(result.statusCode, 200); const preview = result.body as OwnerIncomePreview;
    assert.equal(preview.state, "READY"); assert.deepEqual(preview.totalExpectedIncome, expected.quote.ownerTotal);
    assert.equal(preview.ownerResourceIncome!.amount, "17.00"); assert.equal(preview.ownerHaffIncome!.amount, expected.quote.lines.find(row => row.itemId === "haff")!.ownerAmount.amount);
    assert.equal(preview.ownerHaffRatioWanPerYuan, rentalPricing.ownerRatioB ?? "47"); assert.equal(preview.termSeconds, "864000");
    assert.equal(preview.lines.find(row => row.itemId === "ammo")!.unitQuantity, "60"); assert.equal(preview.lines.find(row => row.itemId === "card")!.unit, "DAY");
    assert.equal(preview.depositState, "INCOMPLETE"); assert.equal(preview.baseTenantDeposit, null);
    assert.equal(preview.refreshAfter, "2026-10-25T00:00:30.000Z"); assert.equal(result.headers["cache-control"], "private, no-store");
    assert(f.queries.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")); assert.equal(f.queries.at(-1), "COMMIT");
    assert.deepEqual(f.counts(), { authCalls: 1, connections: 1, releases: 1, poolReads: 1 });
    assert(f.queries.every(sql => !/skin|rule_acceptance|idempotency|audit_event|listing_version|user_rental_membership|guarantee_proof/.test(sql)));
  }
});

test("missing quantities, missing Haff, missing pricing conditions and unpriced lines never fake a complete total", async () => {
  for (const change of [(x: OwnerIncomePreviewInput) => { x.attributes.safe_box_code = null; }, (x: OwnerIncomePreviewInput) => { x.inventory[1]!.quantity = null; }, (x: OwnerIncomePreviewInput) => { x.inventory = x.inventory.filter(row => row.itemId !== "haff"); }, (x: OwnerIncomePreviewInput) => { x.attributes.rentalPricing = { rentalMode: "custom" }; }]) {
    const f = fixture(), input = body(); change(input); const result = await f.run(input);
    assert.equal(result.statusCode, 200); assert.equal(result.body.state, "PARTIAL"); assert.equal(result.body.totalExpectedIncome, null); assert(result.body.missingFields.length > 0);
  }
  const f = fixture(); f.items[1]!.ownerUnitAmount = null; const result = await f.run();
  assert.equal(result.body.state, "PARTIAL"); assert.equal(result.body.totalExpectedIncome, null); assert.equal(result.body.lines.find((r: any) => r.itemId === "ammo").ownerAmount, null); assert.equal(result.body.knownResourceSubtotal.amount, "9.00");
  const blank = body(); blank.inventory = []; blank.attributes = {}; blank.termOptionCode = null; const empty = await fixture().run(blank);
  assert.equal(empty.body.state, "INCOMPLETE"); assert.equal(empty.body.totalExpectedIncome, null); assert.equal(empty.body.knownResourceSubtotal, null);
});

test("explicit zero/free price, exact 24-digit quantities and eight-digit ratios preserve decimal meaning", async () => {
  const f = fixture(), input = body(); input.inventory[1]!.quantity = "0"; f.items[2]!.buyerUnitAmount = "0"; f.items[2]!.ownerUnitAmount = "0";
  const zero = await f.run(input); assert.equal(zero.body.state, "READY"); assert.equal(zero.body.ownerResourceIncome.amount, "0.00"); assert.equal(zero.body.lines.find((r: any) => r.itemId === "ammo").quantity, "0");
  input.inventory[0]!.quantity = "999999999999999999999999"; input.attributes.rentalPricing = { rentalMode: "custom", ownerRatioB: "44.12345678" };
  const large = await f.run(input), expected = computeDeltaQuote(f.formalInput(input)); assert(expected.quotable);
  assert.equal(large.body.state, "READY"); assert.deepEqual(large.body.totalExpectedIncome, expected.quote.ownerTotal); assert.equal(large.body.ownerHaffRatioWanPerYuan, "44.12345678");
  input.inventory[0]!.quantity = "0"; const noHaff = await f.run(input); assert.equal(noHaff.body.totalExpectedIncome, null); assert.equal(noHaff.body.termSeconds, null);
});

test("entitlement values and expiry obey the current game directory, not permissive DTO unions", async () => {
  for (const entitlement of [{ entitlementId: "timed", value: true, expiresAt: null, expiryKnowledge: "UNKNOWN" as const }, { entitlementId: "permanent", value: null, expiresAt: null, expiryKnowledge: "KNOWN" as const }]) {
    const input = body(); input.entitlements = [entitlement]; const result = await fixture().run(input); assert.equal(result.body.state, "PARTIAL"); assert.equal(result.body.totalExpectedIncome, null);
  }
  const input = body(); input.entitlements = [{ entitlementId: "timed", value: false, expiresAt: "2026-11-01T00:00:00Z", expiryKnowledge: "KNOWN" }, { entitlementId: "permanent", value: 0, expiresAt: null, expiryKnowledge: "KNOWN" }];
  assert.equal((await fixture().run(input)).body.state, "READY");
  for (const [entitlementId, value] of [["timed", 1], ["permanent", "3"], ["foreign", true]] as const) {
    const bad = body(); bad.entitlements = [{ entitlementId, value, expiresAt: null, expiryKnowledge: "KNOWN" }]; assert.equal((await fixture().run(bad)).statusCode, 400);
  }
});

test("base deposit stays separate from income and full-payout selection does not accept terms", async () => {
  const input = body(); input.attributes.owner_deposit_declaration = { schema: "owner-deposit-declaration-v1", amountCents: "30000", declarationVersion: "1" }; input.attributes.full_payout_declaration = { schema: "full-payout-declaration-v1", selected: true };
  const f = fixture(), result = await f.run(input); assert.equal(result.body.state, "READY"); assert.equal(result.body.baseTenantDeposit.amount, "300.00"); assert.equal(result.body.totalExpectedIncome.amount, "229.77"); assert.equal(result.body.depositState, "KNOWN"); assert(!f.queries.some(sql => /acceptance|proof|terms_version/.test(sql)));
  f.state.policyExists = false; const unavailable = await f.run(input); assert.equal(unavailable.body.state, "READY"); assert.equal(unavailable.body.baseTenantDeposit, null); assert.equal(unavailable.body.depositState, "UNAVAILABLE");
});

test("optional account is hidden identically when absent, foreign or cross-game; new form needs no account", async () => {
  for (const patch of [{ accountExists: false }, { accountOwner: "another_owner" }, { accountGame: "another_game" }]) {
    const f = fixture(); Object.assign(f.state, patch); const result = await f.run({ ...body(), accountId: "account" }); assert.equal(result.statusCode, 404); assert.equal(result.body.error.code, "NOT_FOUND"); assert(!f.queries.some(sql => sql.includes('commission_rate'))); assert.equal(f.queries.at(-1), "ROLLBACK");
  }
  const f = fixture(); assert.equal((await f.run({ ...body(), accountId: "account" })).body.state, "READY"); assert.equal((await f.run()).body.state, "READY");
});

test("route enforces real raw JSON bytes, no extra fields or query, unique IDs and exact integer quantities before auth", async () => {
  const invalidBodies: unknown[] = [{ ...body(), userId: "other" }, { ...body(), priceVersionId: "other" }, { ...body(), attributes: { ...body().attributes, customerTier: "VIP" } }, { ...body(), inventory: Array.from({ length: 101 }, (_, n) => ({ itemId: `id_${n}`, quantity: "1" })) }, { ...body(), entitlements: Array.from({ length: 101 }, (_, n) => ({ entitlementId: `id_${n}`, value: true, expiresAt: null, expiryKnowledge: "KNOWN" })) }, { ...body(), inventory: [{ itemId: "haff", quantity: "1" }, { itemId: "haff", quantity: "2" }] }];
  for (const quantity of ["-1", "1e6", "1.5", "9".repeat(25), 2, undefined]) invalidBodies.push({ ...body(), inventory: [{ itemId: "haff", quantity }] });
  for (const input of invalidBodies) { const f = fixture(), result = await f.run(input); assert.equal(result.statusCode, 400); assert.equal(f.counts().authCalls, 0); }
  for (const rawBody of [undefined, Buffer.from(" ".repeat(65_537) + JSON.stringify(body()))]) { const f = fixture(), result = await f.run(body(), { rawBody }); assert.equal(result.statusCode, 400); assert.equal(f.counts().authCalls, 0); }
  assert.equal((await fixture().run(body(), {}, new URLSearchParams("ownerUserId=other"))).statusCode, 400);
  assert.throws(() => parseOwnerIncomePreviewInput({ ...body(), attributes: { ...body().attributes, title: "unsupported" } }));
});

test("auth, Origin, session, game and binding failures remain distinct; SDK failure is outside the business snapshot", async () => {
  const forbidden = fixture(); assert.equal((await forbidden.run(body(), { headers: { origin: "https://evil.invalid", "content-type": "application/json" } })).statusCode, 403); assert.equal(forbidden.counts().connections, 0);
  for (const patch of [{ authenticated: false }, { active: false }, { sessionValid: false }]) { const f = fixture(); Object.assign(f.state, patch); assert.equal((await f.run()).statusCode, 401); }
  const disabled = fixture(); disabled.state.gameEnabled = false; assert.equal((await disabled.run()).statusCode, 404);
  for (const patch of [{ releaseId: "stale" }, { catalogRevision: "2" }]) assert.equal((await fixture().run({ ...body(), ...patch })).statusCode, 409);
  const unavailable = fixture(); unavailable.state.ruleExists = false; assert.equal((await unavailable.run()).body.state, "UNAVAILABLE");
  const sdk = fixture(); sdk.state.sdkFailure = true; assert.equal((await sdk.run()).statusCode, 500); assert.equal(sdk.counts().connections, 0);
  const broken = fixture(); broken.state.failSql = "zzsh_supply.term_option"; const failure = await broken.run(); assert.equal(failure.statusCode, 500); assert(!JSON.stringify(failure.body).includes("PRIVATE_DRIVER_DETAIL")); assert.equal(broken.queries.at(-1), "ROLLBACK"); assert.equal(broken.counts().releases, 1); assert.equal(failure.headers["cache-control"], "private, no-store");
});

test("repeated and changed-input reads do not retain another result or emit forbidden internals", async () => {
  const f = fixture(), first = await f.run(), input = body(); input.inventory[0]!.quantity = "90000000"; f.state.userId = "second_owner";
  const second = await f.run(input); assert.notEqual(first.body.totalExpectedIncome.amount, second.body.totalExpectedIncome.amount); assert.equal(first.body.totalExpectedIncome.amount, "229.77");
  const forbiddenKeys = new Set(["buyerAmount", "buyerUnitAmount", "resourceTotal", "tenantPayableTotal", "platformAmount", "platformFullProfit", "pricingInputs", "publisherBailRequirement", "contentHash", "versionId", "confirmationToken", "acceptance", "sourceRef", "token", "key"]);
  function check(value: unknown): void { if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { assert(!forbiddenKeys.has(key), key); check(child); } }
  check(first.body); check(second.body); assert.equal(f.counts().connections, 2); assert.equal(f.counts().releases, 2); assert(f.queries.every(sql => !forbiddenSql.test(sql)));
});

test("v1 and PERCENT retain authoritative nominal ratio and actual commission-adjusted income", async () => {
  const f = fixture(), input = body(); f.release.mode = "PERCENT"; f.release.commissionRate = "0.2";
  f.release.haffRule = { schema: "haff-ratio-v1", baseBySafeBox: { "box-a": "47" }, vitalityDeltaByLevel: { "6": "0" }, bearDeltaByLevel: { "6": "0" }, dailyDeltaByTermOption: { "daily-10m": "0" }, options: { normal: { enabled: true, delta: "0" } } };
  delete input.attributes.rentalPricing; input.pricingOptionCode = "normal"; for (const item of f.items) item.ownerUnitAmount = null;
  const result = await f.run(input), expected = computeDeltaQuote(f.formalInput(input)); assert(expected.quotable); assert.equal(result.body.state, "READY"); assert.equal(result.body.ownerHaffRatioWanPerYuan, "47"); assert.deepEqual(result.body.totalExpectedIncome, expected.quote.ownerTotal);
});

test("old fixed-resource GET keeps its body contract but now uses READ-only identity and snapshot", async () => {
  const f = fixture(), query = new URLSearchParams({ inventory: JSON.stringify(body().inventory.filter(row => row.itemId !== "haff")), releaseId: "fixture_release", catalogRevision: "1" });
  const result = await f.run({}, { method: "GET" }, query, "/games/fixture_game/resource-income-preview");
  assert.equal(result.statusCode, 200); assert.equal(result.body.ownerTotal.amount, "17.00"); assert.equal(result.body.informationalOnly, true); assert.equal(result.body.schema, undefined);
  assert(f.queries.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")); assert(f.queries.every(sql => !forbiddenSql.test(sql)));
});
