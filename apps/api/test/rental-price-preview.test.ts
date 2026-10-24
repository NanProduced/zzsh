import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthSecurityOptions } from "../src/auth/auth-security";
import { SecurityApiError } from "../src/auth/security-core";
import { computeDeltaQuote, type QuoteInput } from "../src/supply/pricing";
import { normalizeContentPayload, computeContentHash } from "../src/supply/content-hash";
import { createProductionConfirmationFundingReader, createProductionSupplyGateReader } from "../src/supply/funding-authority";
import { composeSupplyGateWithOrderOccupancy } from "../src/order/order";
import { readPublicListing, listingDetail, type ListingVersion, type PublishingAccount } from "../src/supply/publishing";
import { quoteToGrowthOfferPlan, tenantDepositAfterBenefit, type OfferBinding } from "../src/auth/membership-growth";
import { applyTotalDiscountToQuote } from "../src/auth/membership-total-discount";
import { rebuildPersonalConfirmation, issuePersonalConfirmation, type PersonalConfirmationOptions } from "../src/order/personal-confirmation";
import { mountPersonalConfirmations } from "../src/order/confirmation-routes";
import { RENTAL_PRICE_PREVIEW_PATHS, handleRentalPricePreview, rentalPricePreviewInput } from "../src/order/rental-price-preview";
import { compatRule } from "./pricing-compat-fixture";
import { fundingPolicyFixture } from "./funding-authority-fixtures";

const asOf = "2026-10-25T00:10:00.123456Z", refresh = "2026-10-25T00:10:30.123456Z", origin = "http://localhost:3100";
const input = { accountId: "account-preview", versionId: "version-preview", releaseId: "release-preview" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const forbiddenBusiness = /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b|\bFOR\s+(UPDATE|SHARE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)\b|\bpg_(?:try_)?advisory(?:_xact)?_lock\b/i;

function fixture() {
  const state = { userId: "renter-preview", sessionId: "session-preview", authenticated: true, active: true, adult: true, sessionValid: true,
    occupancy: "FREE", gameEnabled: true, resourceEnabled: true, resourceUnit: "HAFF_BASE", resourceMissing: false,
    policyAvailable: true, termsAvailable: true, accepted: true, mediaReady: true, published: true,
    legacyTier: "STANDARD", legacyKnown: true, creditRows: true, readOnly: true, growth: "known", friend: false, partial: false, effectiveTier: "GOLD" as "GOLD" | "SILVER",
    depositBenefit: null as null | { fullWaiver: boolean; allowanceCents: string } };
  const policy = fundingPolicyFixture("NOT_REQUIRED"), rule = compatRule("52");
  const quoteInput: QuoteInput = { priceVersionId: "price-preview", mode: "SPREAD", roundingPolicy: "HALF_UP_CENT_V1", customerTier: "STANDARD", haffRule: rule,
    conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", rentalPricing: { rentalMode: "ordinary" } },
    lines: [{ itemId: "haff-preview", quantity: "1000000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", customerTier: "STANDARD" },
      { itemId: "ammo-preview", quantity: "60", unit: "ROUND", pricingKind: "FIXED_UNIT", unitQuantity: "60", buyerUnitAmount: "3", ownerUnitAmount: "2", customerTier: "STANDARD" }],
    termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" } };
  const calculated = computeDeltaQuote(quoteInput); assert(calculated.quotable, calculated.quotable ? "" : calculated.reasonCodes.join(","));
  const payload = normalizeContentPayload({ schemaVersion: 2, accountId: input.accountId, gameId: "game-preview",
    declaration: { title: "", description: "Synthetic account", attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6, dive_level: 0, character_level: 60,
      grading_code: "4", grading_division: 1, login_method_code: "login_qq_qr", service_window_start_minute: 0, service_window_end_minute: 1440, service_window_timezone: "Asia/Shanghai", service_window_cross_midnight: false,
      rentalPricing: { rentalMode: "ordinary" }, owner_deposit_declaration: { schema: "owner-deposit-declaration-v1", amountCents: "30000", declarationVersion: "1" },
      full_payout_declaration: { schema: "full-payout-declaration-v1", selected: false }, media_categories: { "media-preview": "SHOWCASE" } },
      inventory: [{ itemId: "haff-preview", quantity: "1000000" }, { itemId: "ammo-preview", quantity: "60" }], skins: [], entitlements: [],
      termOptionCode: "daily-10m", pricingOptionCode: "", mediaBindings: [{ assetId: "media-preview", purpose: "ACCOUNT_DISPLAY", byteHash: "a".repeat(64), position: 0 }] },
    ruleRefs: { releaseId: input.releaseId, priceVersionId: "price-preview", termVersionId: "term-preview", agreementVersionId: "agreement-preview", agreementDigest: "d".repeat(64), catalogRevision: "1" }, quoteValues: calculated.quote });
  const account: PublishingAccount = { id: input.accountId, owner_user_id: "owner-preview", game_id: "game-preview", current_version_id: input.versionId,
    owner_paused: false, staff_restricted: false, restriction_reason: null, lifecycle: "ACTIVE", legacy_hold: "NONE", revision: "1", display_no: "ZZ20261025000001" };
  const version: ListingVersion = { id: input.versionId, account_id: account.id, sequence: "1", origin: "NATIVE", review_state: "PUBLISHED", schema_version: 2,
    title: "", description: "Synthetic account", attributes: payload.declaration.attributes, term_option_code: "daily-10m", pricing_option_code: "", rule_release_id: input.releaseId,
    payload, content_hash: computeContentHash(payload), presentation: { items: [], skins: [], entitlements: [] }, revision: "1", submitted_at: null };
  const statements: string[] = [], forbiddenAttempts: string[] = []; let connections = 0, releases = 0, authStateReads = 0, authCalls = 0;
  const publication = () => ({ id: "publication-preview", version_id: version.id, account_id: account.id, owner_user_id: account.owner_user_id, game_id: account.game_id,
    rule_release_id: version.rule_release_id, content_hash: version.content_hash, source: "OWNER_DIRECT", published_at: new Date("2026-10-24T00:00:00Z") });
  async function query(sql: string, values: unknown[] = []) {
    statements.push(sql); if (forbiddenBusiness.test(sql)) { forbiddenAttempts.push(sql); if (state.readOnly) throw Error("FORBIDDEN_BUSINESS_ATTEMPT"); }
    let rows: unknown[] = [];
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql) || sql.includes("set_config('statement_timeout'")) rows = [];
    else if (sql.includes('AS "asOfUtc"')) rows = [{ asOfUtc: asOf, refreshAfterUtc: refresh }];
    else if (sql.includes("SELECT owner_user_id AS")) rows = [{ ownerUserId: account.owner_user_id, gameId: account.game_id }];
    else if (sql.includes("WHERE u.id = ANY")) rows = [{ id: state.userId, suspended: !state.active, accountStatus: state.active ? "ACTIVE" : "DEACTIVATED", identityStatus: state.adult ? "VERIFIED" : "UNKNOWN", ageStatus: state.adult ? "ADULT" : "UNKNOWN" }, { id: account.owner_user_id, suspended: false, accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT" }];
    else if (sql.includes('SELECT 1 FROM zzsh_auth_user."session"')) rows = state.sessionValid ? [{}] : [];
    else if (sql.startsWith('SELECT id FROM zzsh_auth_user."user"')) rows = [{ id: state.userId }, { id: account.owner_user_id }];
    else if (sql.includes("SELECT current_release_id,enabled")) rows = [{ current_release_id: input.releaseId, enabled: state.gameEnabled }];
    else if (sql.includes("SELECT * FROM zzsh_supply.rental_account")) rows = values[0] === account.id ? [account] : [];
    else if (sql.includes("SELECT * FROM zzsh_supply.listing_version")) rows = values[0] === version.id && (values[1] === undefined || values[1] === account.id) ? [version] : [];
    else if (sql.includes("FROM zzsh_supply.listing_publication")) {
      const p = publication(); const match = values.length === 1 ? values[0] === account.id : values[0] === version.id && values[1] === account.id && values[2] === account.owner_user_id
        && (values.length === 6 ? values[3] === account.game_id && values[4] === version.rule_release_id && values[5] === version.content_hash : values[3] === version.rule_release_id && values[4] === version.content_hash);
      rows = state.published && match ? [p] : [];
    }
    else if (sql.includes("SELECT u.suspended")) rows = [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }];
    else if (sql.includes("game_service_operation")) rows = [{ id: "service-preview", gameId: account.game_id, gameCode: "delta", gameEnabled: true, enabled: true, revision: "1" }];
    else if (sql.includes("SELECT id,code,name,enabled,current_release_id")) rows = [{ id: account.game_id, code: "delta", name: "Synthetic game", enabled: state.gameEnabled, current_release_id: input.releaseId, catalog_revision: "1" }];
    else if (sql.includes("funding_policy AS policy") || sql.includes('funding_policy AS policy,p.status')) rows = state.policyAvailable ? [{ priceVersionId: "price-preview", policy, status: "SEALED", policyStatus: "SEALED", priceStatus: "SEALED", gameId: account.game_id, releaseId: input.releaseId,
      versionId: version.id, currentVersionId: account.current_version_id, ownerUserId: account.owner_user_id, accountId: account.id, contentHash: version.content_hash, payload: version.payload, publicationSource: "OWNER_DIRECT" }] : [];
    else if (sql.includes("account_guarantee_proof")) rows = [];
    else if (sql.includes('SELECT a.id AS "accountId"') && sql.includes("funding_policy AS policy")) rows = [{ accountId: account.id, ownerUserId: account.owner_user_id, gameId: account.game_id, currentVersionId: account.current_version_id, versionId: version.id, priceVersionId: "price-preview", releaseId: input.releaseId, policy, policyStatus: "SEALED", priceStatus: "SEALED", payload: version.payload }];
    else if (sql.includes("zzsh_credit.user_credit_state")) rows = state.creditRows ? [{ score: 100, revision: "1" }] : [];
    else if (sql.includes("owner_guarantee_requirement")) rows = [];
    else if (sql.includes(" AS state,") && sql.includes("legacy_inflight_register")) rows = [{ state: state.occupancy, kind: state.occupancy === "OCCUPIED" ? "PENDING_PAYMENT" : null }];
    else if (sql.includes("FROM zzsh_supply.rule_acceptance")) rows = state.accepted ? [{}] : [];
    else if (sql.includes("SELECT a.* FROM zzsh_supply.listing_media")) rows = [{ id: "media-preview", account_id: account.id, game_id: account.game_id, owner_user_id: account.owner_user_id, ownership_kind: "USER_SUPPLY", purpose: "ACCOUNT_DISPLAY", content_hash: "a".repeat(64), review_state: "APPROVED", access_class: "PUBLIC_DISPLAY", technical_state: state.mediaReady ? "READY" : "FAILED", public_storage_key: "synthetic-not-a-real-storage-key" }];
    else if (sql.includes("current-trade-resources")) rows = state.resourceMissing ? [] : (values[1] as string[]).map(id => ({ id, code: id === "haff-preview" ? "haff" : "level6_bullet", unit: id === "haff-preview" ? state.resourceUnit : "ROUND", enabled: state.resourceEnabled }));
    else if (sql.includes("SELECT p.id,p.status,p.mode")) rows = [{ id: "price-preview", status: "SEALED", mode: "SPREAD", haff_rule: rule, commission_rate: null, rounding_policy: "HALF_UP_CENT_V1", term_version_id: "term-preview" }];
    else if (sql.includes("FROM zzsh_supply.price_line")) rows = [{ item_id: "haff-preview", pricing_kind: "HAFF_RATIO", unit_quantity: null, buyer_unit_amount: null, owner_unit_amount: null }, { item_id: "ammo-preview", pricing_kind: "FIXED_UNIT", unit_quantity: "60", buyer_unit_amount: "3", owner_unit_amount: "2" }];
    else if (sql.includes("FROM zzsh_supply.term_option") || sql.includes("JOIN zzsh_supply.term_option")) rows = [{ ...quoteInput.termOption, name: "Synthetic daily" }];
    else if (sql.includes("user_rental_membership")) rows = state.legacyKnown ? [{ tier: state.legacyTier, version: "3", sourceRef: "synthetic-private-membership-reference", updatedBy: "staff-fixture" }] : [];
    else if (sql.includes("full_payout_terms_version")) rows = state.termsAvailable ? [{ id: "terms-preview", policy_ref: policy.fullPayoutPolicyRef, policy_version: policy.fullPayoutPolicyVersion, disclosure_version: policy.disclosureVersion, title: "Synthetic public terms", body: "Synthetic public compensation disclosure", digest: hash("Synthetic public compensation disclosure"), status: "SEALED" }] : [];
    else if (sql.includes(" AS now")) rows = [{ now: "1792887000" }];
    else if (sql.includes(" AS at")) rows = [{ at: asOf }];
    else throw Error("UNHANDLED_PREVIEW_SQL: " + sql.slice(0, 170));
    return { rows, rowCount: rows.length };
  }
  const client = { query, release() { releases++; } } as unknown as PoolClient;
  const pool = { async connect() { connections++; return client; }, async query(sql: string) { authStateReads++; assert(sql.includes('u."suspended"'), "only the existing auth-state read may use pool.query"); return { rows: state.active ? [{ suspended: false, accountStatus: "ACTIVE" }] : [] }; } } as unknown as Pool;
  const security = { pool, userOrigin: origin, userAuth: { api: { async getSession() { authCalls++; return state.authenticated ? { user: { id: state.userId }, session: { id: state.sessionId } } : null; } } } } as unknown as AuthSecurityOptions;
  const gate = composeSupplyGateWithOrderOccupancy(createProductionSupplyGateReader());
  const options: PersonalConfirmationOptions = { gate, fundingReader: createProductionConfirmationFundingReader(), membershipGrowthReader: async (_db, request) => {
    assert.equal(request.asOfUtc, asOf, "the offer reader must receive the exact PG clock, not a JS fallback");
    if (state.growth === "unknown") return { knowledge: "UNKNOWN", reason: "SYNTHETIC_UNKNOWN" };
    const binding: OfferBinding = { userId: request.userId, ownerUserId: request.ownerUserId, accountId: request.accountId, listingVersionId: request.listingVersionId, ruleReleaseId: request.ruleReleaseId, quantityDigest: request.quantityDigest };
    let basis = request.baseQuote;
    if (state.depositBenefit) {
      const depositCents = tenantDepositAfterBenefit(request.quoteInput.deposits?.tenantDepositCents ?? null, state.depositBenefit.fullWaiver, state.depositBenefit.allowanceCents); assert.notEqual(depositCents, null);
      const priced = computeDeltaQuote({ ...request.quoteInput, deposits: { ...request.quoteInput.deposits, tenantDepositCents: depositCents! } }); assert(priced.quotable); basis = priced.quote;
    }
    const selected = applyTotalDiscountToQuote(basis, "0.95"); assert(selected);
    const growth = state.depositBenefit ? selected.quote : { ...selected.quote, tenantDeposit: { currency: "CNY" as const, unit: "yuan" as const, amount: state.partial ? "200.00" : "0.00", scale: 2 as const } };
    const candidates = [{ quote: growth, plan: quoteToGrowthOfferPlan(growth, { source: "GROWTH", benefitVersion: "1", binding }) }];
    if (state.friend) { const priced = applyTotalDiscountToQuote(request.baseQuote, "0.9"); assert(priced); const friend = { ...priced.quote, tenantDeposit: { currency: "CNY" as const, unit: "yuan" as const, amount: "100.00", scale: 2 as const } };
      candidates.push({ quote: friend, plan: quoteToGrowthOfferPlan(friend, { source: "FRIEND", benefitVersion: "1", entitlementId: "friend-preview", validUntil: "2026-10-26T00:10:00.123456Z", binding }) }); }
    return { knowledge: "KNOWN", effectiveTier: state.effectiveTier, policyTier: state.effectiveTier, policyVersion: "1", asOfUtc: asOf, candidates, entitlementIds: state.friend ? ["friend-preview"] : [] };
  } };
  function response() { return { statusCode: 0, headers: {} as Record<string, string>, body: null as any, headersSent: false,
    setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; return this; }, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; this.headersSent = true; return this; } }; }
  async function call(path: typeof RENTAL_PRICE_PREVIEW_PATHS[number] = RENTAL_PRICE_PREVIEW_PATHS[0], queryText = new URLSearchParams(input).toString(), extra: Record<string, unknown> = {}) {
    const result = response(); const request = { method: "GET", originalUrl: path + "?" + queryText, url: path + "?" + queryText, headers: { origin, cookie: "synthetic-session-cookie", "x-request-id": "price-preview-fixture" }, ...extra };
    await handleRentalPricePreview(request as never, result as never, security, options, path); return result;
  }
  return { state, account, version, policy, quoteInput, options, security, client, pool, call, response, statements, forbiddenAttempts,
    metrics: () => ({ connections, releases, authStateReads, authCalls }), refreshHash() { version.content_hash = computeContentHash(version.payload!); },
    setPricing(selection: NonNullable<QuoteInput["conditions"]["rentalPricing"]>) {
      quoteInput.conditions.rentalPricing = selection; const priced = computeDeltaQuote(quoteInput); assert(priced.quotable);
      version.payload = normalizeContentPayload({ ...version.payload!, declaration: { ...version.payload!.declaration, attributes: { ...version.attributes, rentalPricing: selection } }, quoteValues: priced.quote });
      version.attributes = version.payload.declaration.attributes; version.content_hash = computeContentHash(version.payload);
    } };
}

function assertReadTrace(f: ReturnType<typeof fixture>) {
  assert.deepEqual(f.forbiddenAttempts, [], "record attempted forbidden statements before a caught error can hide them");
  assert(f.statements.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"));
  assert.equal(f.metrics().connections, f.metrics().releases);
}
function assertTenantWhitelist(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) { assert.doesNotMatch(key, /owner|cost|profit|pricingInputs|sourceRef|publisherBail|confirmationToken|confirmationId|orderId|keys/i); assertTenantWhitelist(child); }
}

test("existing confirmation parent registers both exact preview aliases", () => {
  const f = fixture(), mounted: string[] = [], app = { getHttpAdapter: () => ({ getInstance: () => ({ use: (path: string) => { mounted.push(path); } }) }) };
  mountPersonalConfirmations(app as never, f.security, f.options);
  for (const path of RENTAL_PRICE_PREVIEW_PATHS) assert(mounted.includes(path));
});

test("three preview references are required and unique; extra identity, amounts, tier and consent are rejected", () => {
  assert.deepEqual(rentalPricePreviewInput(new URLSearchParams(input)), input);
  for (const text of ["", "accountId=a&versionId=v", new URLSearchParams(input) + "&accountId=other", ...["userId", "tier", "amount", "discount", "fullPayoutTermsAcceptance", "purpose"].map(key => new URLSearchParams(input) + "&" + key + "=value")]) assert.throws(() => rentalPricePreviewInput(new URLSearchParams(text)), (error: unknown) => (error as { status?: number }).status === 400);
});

test("valid aliases read one RO business snapshot, choose the full offer and expose only renter data", async () => {
  for (const path of RENTAL_PRICE_PREVIEW_PATHS) {
    const f = fixture(); f.state.friend = true; const response = await f.call(path);
    assert.equal(response.statusCode, 200, JSON.stringify(response.body)); assertReadTrace(f);
    assert.equal(response.headers["cache-control"], "private, no-store"); assert(!response.headers["set-cookie"]);
    assert.equal(response.body.schema, "rental-price-preview.v1"); assert.equal(response.body.asOfUtc, asOf); assert.equal(response.body.refreshAfterUtc, refresh);
    assert.equal(response.body.binding.listingHash, f.version.content_hash); assert.equal(response.body.quote.baseRenterHaffRatioWanPerYuan, "44");
    assert.equal(response.body.membershipBenefits.priceSource, "FRIEND"); assert.equal(response.body.membershipBenefits.depositSource, "GROWTH");
    assert.equal(response.body.baseTenantDeposit.amount, "300.00"); assert.equal(response.body.quote.tenantDeposit.amount, "0.00");
    assert.equal(response.body.quote.tenantPayableTotal.amount, response.body.quote.resourceTotal.amount); assert.equal(response.body.quote.lines.find((line: { itemId: string }) => line.itemId === "ammo-preview").unitQuantity, "60");
    assertTenantWhitelist(response.body);
  }
});

test("partial deposit sources take the better complete benefit without adding allowances", async () => {
  const f = fixture(); f.state.partial = true; f.state.friend = true; const result = await f.call();
  assert.equal(result.statusCode, 200, JSON.stringify(result.body)); assert.equal(result.body.quote.tenantDeposit.amount, "100.00"); assert.equal(result.body.membershipBenefits.depositSource, "FRIEND"); assert(!Object.hasOwn(result.body, "depositWaived")); assertReadTrace(f);
});

for (const row of [
  { name: "zero native base remains refused by the existing funding policy", baseCents: "0", fullWaiver: false, allowanceCents: "0", actual: "0.00", base: "0.00" },
  { name: "finite allowance 200 covers a base of 100", baseCents: "10000", fullWaiver: false, allowanceCents: "20000", actual: "0.00", base: "100.00" },
  { name: "a true full waiver", baseCents: "10000", fullWaiver: true, allowanceCents: "0", actual: "0.00", base: "100.00" },
  { name: "ordinary positive base without a deposit benefit", baseCents: "10000", fullWaiver: false, allowanceCents: "0", actual: "100.00", base: "100.00" },
]) test("preview never adds a waiver claim: " + row.name, async () => {
  const f = fixture(); f.state.depositBenefit = { fullWaiver: row.fullWaiver, allowanceCents: row.allowanceCents };
  f.version.payload!.declaration.attributes.owner_deposit_declaration = { schema: "owner-deposit-declaration-v1", amountCents: row.baseCents, declarationVersion: "1" }; f.refreshHash();
  const result = await f.call();
  if (row.baseCents === "0") {
    assert.equal(tenantDepositAfterBenefit(row.baseCents, row.fullWaiver, row.allowanceCents), "0");
    assert.equal(result.statusCode, 503, "the real native funding guard is not relaxed to manufacture a zero-base success");
    assert(!Object.hasOwn(result.body, "quote")); assert(!Object.hasOwn(result.body, "depositWaived")); assertReadTrace(f); return;
  }
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(result.body.baseTenantDeposit.amount, row.base); assert.equal(result.body.quote.tenantDeposit.amount, row.actual);
  assert.equal(result.body.membershipBenefits.depositSource, "GROWTH");
  assert(!Object.hasOwn(result.body, "depositWaived")); assert.doesNotMatch(JSON.stringify(result.body), /depositWaived|fullWaiver|allowanceCents/);
  assertTenantWhitelist(result.body); assertReadTrace(f);
});

for (const row of [
  { name: "known dependency error", error: new SecurityApiError(503, "MEMBERSHIP_UNKNOWN", "PRIVATE_INTERNAL_SOURCE sourceRef", [{ path: "sourceRef.PRIVATE_INTERNAL_SOURCE", code: "INVALID_FIELD" }, { path: "publisherBailRequirementCents", code: "INVALID_FIELD" }]), status: 503, code: "MEMBERSHIP_UNKNOWN" },
  { name: "known internal error", error: new SecurityApiError(500, "INTERNAL_ERROR", "PRIVATE_INTERNAL_SOURCE publisherBailRequirementCents", [{ path: "sourceRef.PRIVATE_INTERNAL_SOURCE", code: "INVALID_FIELD" }]), status: 500, code: "INTERNAL_ERROR" },
  { name: "unknown error", error: new Error("PRIVATE_UNKNOWN_MESSAGE sourceRef publisherBailRequirementCents"), status: 500, code: "INTERNAL_ERROR" },
]) test("preview error envelope omits private messages and details: " + row.name, async () => {
  const f = fixture(); f.options.membershipGrowthReader = async () => { throw row.error; };
  const result = await f.call(); assert.equal(result.statusCode, row.status);
  assert.deepEqual(result.body, { error: { code: row.code, message: "Personal price is unavailable", requestId: "price-preview-fixture" } });
  assert.deepEqual(Object.keys(result.body.error).sort(), ["code", "message", "requestId"]);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|sourceRef|publisherBail|details/); assertReadTrace(f);
});

test("ordinary, custom and fast keep the published STANDARD base ratio separate from personal amounts", async () => {
  for (const [rentalMode, ownerRatioB, expected] of [["ordinary", undefined, "44"], ["custom", "50", "42"], ["fast", "64", "52"]] as const) {
    const f = fixture(); f.setPricing({ rentalMode, ...(ownerRatioB === undefined ? {} : { ownerRatioB }) }); const result = await f.call();
    assert.equal(result.statusCode, 200, JSON.stringify(result.body)); assert.equal(result.body.quote.rentalMode, rentalMode); assert.equal(result.body.quote.baseRenterHaffRatioWanPerYuan, expected); assertReadTrace(f);
  }
});

test("repeat reads do not reserve or cache another user's result", async () => {
  const f = fixture(), first = await f.call(), repeated = await f.call();
  assert.equal(first.statusCode, 200); assert.deepEqual(repeated.body, first.body); assert.equal(f.metrics().connections, 2);
  f.state.userId = "other-renter-preview"; f.state.sessionId = "other-session-preview"; f.state.effectiveTier = "SILVER";
  const changed = await f.call(); assert.equal(changed.statusCode, 200, JSON.stringify(changed.body)); assert.equal(changed.body.membershipBenefits.effectiveTier, "SILVER"); assert.equal(first.body.membershipBenefits.effectiveTier, "GOLD");
  assert.equal(f.metrics().authCalls, 3); assert.equal(f.metrics().connections, 3); assertReadTrace(f);
});

test("legacy membership still has truthful tier and published base ratio rather than selected legacy denominator", async () => {
  const f = fixture(); delete f.options.membershipGrowthReader; f.state.legacyTier = "VIP"; const result = await f.call();
  assert.equal(result.statusCode, 200, JSON.stringify(result.body)); assert.equal(result.body.customerTier, "VIP"); assert.equal(result.body.quote.baseRenterHaffRatioWanPerYuan, "44"); assert.equal(result.body.quote.tenantDeposit.amount, "0.00"); assertReadTrace(f);
});

test("growth, legacy membership, funding and credit unknown never become STANDARD or a zero-price success", async () => {
  for (const kind of ["growth", "legacy", "funding", "credit"] as const) {
    const f = fixture(); if (kind === "growth") f.state.growth = "unknown";
    if (kind === "legacy") { delete f.options.membershipGrowthReader; f.state.legacyKnown = false; }
    if (kind === "funding") f.state.policyAvailable = false;
    if (kind === "credit") { f.state.creditRows = false; f.options.gate = composeSupplyGateWithOrderOccupancy(createProductionSupplyGateReader({ creditGuaranteeEnabled: true })); f.options.fundingReader = createProductionConfirmationFundingReader({ creditGuaranteeEnabled: true }); }
    const result = await f.call(); assert.equal(result.statusCode, 503, kind + ": " + JSON.stringify(result.body)); assert(!result.body.quote); assertReadTrace(f);
    if (kind === "credit") assert(f.statements.some(sql => sql.includes("zzsh_credit.user_credit_state")), "missing credit must reach the real non-initializing credit reader");
  }
});

test("price can disclose selected compensation without renter acceptance while original confirmation still requires it", async () => {
  const f = fixture(); (f.version.payload!.declaration.attributes as Record<string, unknown>).full_payout_declaration = { schema: "full-payout-declaration-v1", selected: true }; f.refreshHash();
  const result = await f.call(); assert.equal(result.statusCode, 200, JSON.stringify(result.body)); assert.equal(result.body.compensationDisclosure.selected, true); assert(result.body.compensationDisclosure.terms.termsDigest); assertReadTrace(f);
  f.state.readOnly = false; await assert.rejects(() => rebuildPersonalConfirmation(f.client, { userId: f.state.userId, sessionId: f.state.sessionId }, input, f.options), (error: unknown) => (error as { status?: number }).status === 409);
  assert(f.forbiddenAttempts.some(sql => sql.includes("FOR UPDATE")), "the old write path must keep ordered party/game/account locks");
  const missing = fixture(); missing.version.payload!.declaration.attributes.full_payout_declaration = { schema: "full-payout-declaration-v1", selected: true }; missing.refreshHash(); missing.state.termsAvailable = false;
  assert.equal((await missing.call()).statusCode, 503); assertReadTrace(missing);
});

test("current tuple, effective publication and immutable hash reject rather than borrowing another version", async () => {
  for (const kind of ["draft", "release", "hash", "unpublished"] as const) {
    const f = fixture(); if (kind === "draft") f.account.current_version_id = "private-draft-v3";
    if (kind === "hash") f.version.content_hash = "0".repeat(64); if (kind === "unpublished") f.state.published = false;
    const query = new URLSearchParams({ ...input, ...(kind === "release" ? { releaseId: "old-release" } : {}) }).toString();
    const result = await f.call(undefined, query); assert.equal(result.statusCode, kind === "draft" || kind === "release" ? 409 : kind === "unpublished" ? 404 : 503, kind + ": " + JSON.stringify(result.body)); assert(!result.body.quote); assertReadTrace(f);
  }
});

test("READ eligibility retains disabled, changed-unit, missing resource and migration-title refusal; native empty title works", async () => {
  for (const kind of ["disabled", "unit", "missing", "placeholder"] as const) {
    const f = fixture(); if (kind === "disabled") f.state.resourceEnabled = false; if (kind === "unit") f.state.resourceUnit = "ROUND"; if (kind === "missing") f.state.resourceMissing = true;
    if (kind === "placeholder") { f.version.title = "历史资料待核实"; f.version.payload!.declaration.title = f.version.title; f.refreshHash(); }
    const result = await f.call(); assert.notEqual(result.statusCode, 200, kind); assert(!result.body.quote); assertReadTrace(f);
  }
  const empty = fixture(); assert.equal((await empty.call()).statusCode, 200); assertReadTrace(empty);
});

test("occupancy and invalid subjects are refused with no business writes or stale payable quote", async () => {
  for (const kind of ["occupied", "own", "minor", "session"] as const) {
    const f = fixture(); if (kind === "occupied") f.state.occupancy = "OCCUPIED"; if (kind === "own") f.account.owner_user_id = f.state.userId; if (kind === "minor") f.state.adult = false; if (kind === "session") f.state.sessionValid = false;
    const result = await f.call(); assert.equal(result.statusCode, kind === "occupied" ? 409 : kind === "session" ? 401 : 403, kind + ": " + JSON.stringify(result.body)); assert(!result.body.quote); assertReadTrace(f);
  }
});

test("Origin, Authorization, GET bodies and extra query input fail before the quote transaction", async () => {
  for (const extra of [{ headers: { origin: "http://foreign.invalid" } }, { headers: { origin, authorization: "Bearer synthetic" } }, { body: { tier: "VIP" } }, { headers: { origin, "content-length": "2" }, body: {} }]) {
    const f = fixture(); const result = await f.call(undefined, undefined, extra); assert(result.statusCode === 400 || result.statusCode === 403); assert.equal(f.metrics().connections, 0);
  }
  const f = fixture(); assert.equal((await f.call(undefined, new URLSearchParams(input) + "&tier=STANDARD")).statusCode, 400); assert.equal(f.metrics().connections, 0);
});

test("public detail and the public market producer use the same published ratio as personal preview", async () => {
  const f = fixture(), detail = await readPublicListing(f.client, f.account, f.options.gate), market = await listingDetail(f.client, f.account, "public", f.options.gate, "public", f.account, false, "RENTABLE");
  for (const listing of [detail, market]) assert.equal((listing.quote as { baseRenterHaffRatioWanPerYuan: string }).baseRenterHaffRatioWanPerYuan, "44");
  const personal = await f.call(); assert.equal(personal.statusCode, 200, JSON.stringify(personal.body));
  for (const listing of [detail, market]) { assert.equal((listing.quote as { baseRenterHaffRatioWanPerYuan: string }).baseRenterHaffRatioWanPerYuan, personal.body.quote.baseRenterHaffRatioWanPerYuan); assertTenantWhitelist(listing.quote); }
  assertReadTrace(f);
});

test("original explicit confirmation still signs its transaction credential and no preview signing key is needed", async () => {
  const f = fixture(); assert.equal((await f.call()).statusCode, 200); assert.equal(f.options.key, undefined);
  f.state.readOnly = false; f.options.key = { keyId: "preview-control", secret: "synthetic-existing-confirmation-control-not-a-real-key" };
  const result = await issuePersonalConfirmation(f.client, { userId: f.state.userId, sessionId: f.state.sessionId }, input, f.options);
  assert(result.confirmationToken); assert(result.confirmationId); assert(f.forbiddenAttempts.some(sql => sql.includes("FOR UPDATE")));
});

test("installed SDK expiry cleanup stays in auth lifecycle; expired 401 never opens a quote transaction", async () => {
  const { betterAuth } = require("better-auth") as typeof import("better-auth"), { memoryAdapter } = require("better-auth/adapters/memory") as typeof import("better-auth/adapters/memory");
  const db: Record<string, any[]> & { session: any[] } = { user: [], session: [], account: [], verification: [] }, writes: string[] = [], factory = memoryAdapter(db);
  const database: typeof factory = options => new Proxy(factory(options), { get(target, key, receiver) { const value = Reflect.get(target, key, receiver); if (["create", "update", "updateMany", "delete", "deleteMany"].includes(String(key)) && typeof value === "function") return (...args: unknown[]) => { writes.push(String(key)); return Reflect.apply(value, target, args); }; return value; } });
  const auth = betterAuth({ database, secret: "synthetic-price-preview-auth-fixture-only-73a41c6d", baseURL: origin, emailAndPassword: { enabled: true }, session: { disableSessionRefresh: true, cookieCache: { enabled: false } } });
  const signup = await auth.api.signUpEmail({ body: { name: "Synthetic preview fixture", email: "preview-reader@example.invalid", password: "Synthetic-preview-password-273!" }, headers: new Headers({ origin }), asResponse: true });
  assert.equal(signup.status, 200); const cookie = signup.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); const seeded = await signup.json() as { user: { id: string } };
  const active = fixture(); active.state.userId = seeded.user.id; active.state.sessionId = db.session[0]!.id; active.security.userAuth = auth as unknown as AuthSecurityOptions["userAuth"]; writes.length = 0;
  const ok = await active.call(undefined, undefined, { headers: { origin, cookie } }); assert.equal(ok.statusCode, 200, JSON.stringify(ok.body)); assert.equal(writes.length, 0); assert(!ok.headers["set-cookie"]); assertReadTrace(active);
  db.session[0]!.expiresAt = new Date(Date.now() - 1000); const expired = fixture(); expired.security.userAuth = auth as unknown as AuthSecurityOptions["userAuth"]; writes.length = 0;
  const result = await expired.call(undefined, undefined, { headers: { origin, cookie } }); assert.equal(result.statusCode, 401); assert(writes.includes("delete"), "the actual SDK adapter cleanup is allowed, not hidden or disabled"); assert.equal(expired.metrics().connections, 0); assert.equal(expired.metrics().authStateReads, 0); assert.deepEqual(expired.statements, []);
});
