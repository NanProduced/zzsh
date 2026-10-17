import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { computeContentHash, normalizeContentPayload } from "../src/supply/content-hash";
import { computeQuote } from "../src/supply/pricing";
import { evaluatePublication, listingDetail, readPublicListing, type ListingVersion, type PublishingAccount, type SupplyGateReader } from "../src/supply/publishing";
import { lookupPublicListing } from "../src/supply/public-listing-lookup";
import { handleFavorites } from "../src/supply/favorites";
import { handlePublishingRoute } from "../src/supply/publishing-routes";
import { listV2 } from "../src/supply/listing-filter-routes";
import * as filterConfig from "../src/supply/listing-filter-config";
import * as legacyRead from "../src/supply/legacy-listing-read";

function nativeFixture(id = "account-a", game = "game-a") {
  const priced = computeQuote({ priceVersionId: "price-a", mode: "PERCENT", commissionRate: "0.2", roundingPolicy: "HALF_UP_CENT_V1",
    haffRule: { schema: "haff-ratio-v1", baseBySafeBox: { "box-a": "40" }, vitalityDeltaByLevel: { 6: "0" }, bearDeltaByLevel: { 6: "0" }, dailyDeltaByTermOption: { daily: "0" }, options: { standard: { delta: "0", enabled: true } } },
    lines: [{ itemId: "haff-a", quantity: "1000000", pricingKind: "HAFF_RATIO" }],
    conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily", pricingOptionCode: "standard" },
    termOption: { code: "daily", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" } });
  assert(priced.quotable); priced.quote.ownerTotal.amount = "123456.78";
  const payload = normalizeContentPayload({ schemaVersion: 1, accountId: id, gameId: game,
    declaration: { title: "中文公开标题", description: null, attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6 },
      termOptionCode: "daily", pricingOptionCode: "standard", inventory: [{ itemId: "haff-a", quantity: "1000000" }], skins: [], entitlements: [],
      mediaBindings: [{ assetId: "media-a", purpose: "ACCOUNT_DISPLAY", byteHash: "a".repeat(64), position: 0 }] },
    ruleRefs: { releaseId: "release-a", priceVersionId: "price-a", termVersionId: "term-a", agreementVersionId: "agreement-a", agreementDigest: "d".repeat(64) },
    quoteValues: priced.quote });
  const account: PublishingAccount = { id, owner_user_id: "owner-a", game_id: game, current_version_id: "version-a",
    owner_paused: false, staff_restricted: false, restriction_reason: null, lifecycle: "ACTIVE", legacy_hold: "NONE", revision: "1", display_no: "0000123" };
  const version: ListingVersion = { id: "version-a", account_id: account.id, sequence: "1", origin: "NATIVE", review_state: "PUBLISHED",
    schema_version: 1, title: payload.declaration.title, description: null, attributes: payload.declaration.attributes,
    term_option_code: "daily", pricing_option_code: "standard", rule_release_id: "release-a", content_hash: computeContentHash(payload), payload,
    presentation: { items: [], skins: [], entitlements: [] }, revision: "1", submitted_at: null };
  const facts = { occupancy: "FREE", occupancyKind: null as "PENDING_PAYMENT" | "RENTED" | "OCCUPIED" | null, suspended: false, accountStatus: "ACTIVE", accepted: true, mediaReady: true, failure: false,
    draft: null as ListingVersion | null };
  const queries: string[] = [];
  const publication = () => ({ id: "publication-a", version_id: version.id, account_id: account.id, owner_user_id: account.owner_user_id,
    game_id: account.game_id, rule_release_id: version.rule_release_id, content_hash: version.content_hash, source: "OWNER_DIRECT", published_at: new Date("2026-10-01T00:00:00Z") });
  const client = { query: async (sql: string, args: unknown[] = []) => {
    queries.push(sql);
    if (facts.failure) throw new Error("READ_FAILURE_FIXTURE");
    let rows: unknown[] = [];
    if (sql.includes('SELECT u.suspended')) rows = [{ suspended: facts.suspended, account_status: facts.accountStatus, identity_status: "VERIFIED", age_status: "ADULT" }];
    else if (sql.includes('game_service_operation')) rows = [{ id: "service-a", gameId: game, gameCode: "delta", gameEnabled: true, enabled: true, revision: "1" }];
    else if (sql.includes('SELECT enabled,current_release_id')) rows = [{ enabled: true, current_release_id: "release-a", catalog_revision: "1" }];
    else if (sql.includes('funding_policy AS policy')) rows = [{ policy: null }];
    else if (sql.includes('rule_acceptance')) rows = facts.accepted ? [{}] : [];
    else if (sql.includes('SELECT a.* FROM zzsh_supply.listing_media')) rows = [{ id: "media-a", account_id: account.id, game_id: account.game_id, owner_user_id: account.owner_user_id,
      ownership_kind: "USER_SUPPLY", purpose: "ACCOUNT_DISPLAY", content_hash: "a".repeat(64), review_state: "APPROVED", access_class: "PUBLIC_DISPLAY", technical_state: facts.mediaReady ? "READY" : "FAILED", public_storage_key: "public-a" }];
    else if (sql.includes('m.asset_id AS "assetId"')) rows = [{ assetId: "media-a", position: 0, purpose: "ACCOUNT_DISPLAY", byteHash: "a".repeat(64), reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY", publicStorageKey: "public-a", technicalState: facts.mediaReady ? "READY" : "FAILED", ownerUserId: account.owner_user_id, category: "SHOWCASE" }];
    else if (sql.includes('SELECT item_id AS "itemId"')) rows = [{ itemId: "haff-a", quantity: "1000000" }];
    else if (sql.includes('SELECT * FROM zzsh_supply.rental_account')) rows = args[0] === id ? [account] : [];
    else if (sql.includes('SELECT * FROM zzsh_supply.listing_version')) rows = [facts.draft?.id === args[0] ? facts.draft : version];
    else if (sql.includes('SELECT v.* FROM zzsh_supply.listing_version')) rows = account.owner_user_id === "owner-a" ? [version] : [];
    else if (sql.includes('SELECT 1 FROM zzsh_supply.listing_publication')) rows = [{}];
    else if (sql.includes('zzsh_supply.listing_publication')) rows = args[0] === facts.draft?.id || account.owner_user_id !== "owner-a" ? [] : [publication()];
    else if (sql.includes('term_option')) rows = [{ code: "daily", name: "每日", dailyConsumption: "10000000" }];
    else if (sql.includes('SELECT id, code, name FROM zzsh_supply.game')) rows = [{ id: game, code: "delta", name: "三角洲行动" }];
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;
  const gate: SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: facts.occupancy as "FREE" | "OCCUPIED" | "UNKNOWN", reference: "policy:fixture",
    ...(facts.occupancyKind ? { occupancyKind: facts.occupancyKind } : {}) });
  return { account, version, facts, queries, client, gate };
}

test("public free control keeps the current object and public money projection", async () => {
  const f = nativeFixture(), result = await readPublicListing(f.client, f.account, f.gate);
  assert.equal(result.id, f.account.id); assert.equal(result.displayNo, "0000123");
  assert(!JSON.stringify(result).includes("123456.78")); assert(!Object.hasOwn(result, "owner_user_id"));
});
test("pending and paid occupancy labels come from authoritative gate detail, with no order identifiers", async () => {
  for (const kind of ["PENDING_PAYMENT", "RENTED"] as const) {
    const f = nativeFixture(); f.facts.occupancy = "OCCUPIED"; f.facts.occupancyKind = kind;
    const result = await readPublicListing(f.client, f.account, f.gate);
    assert.equal((result.availability as any).state, kind); assert.equal(result.canCreateOrder, false);
    assert(!JSON.stringify(result).includes("renter_user_id")); assert(!Object.hasOwn(result, "orderId"));
  }
});
test("unknown occupancy remains readable as unknown, but trade/list gates never treat it as free", async () => {
  const f = nativeFixture(); f.facts.occupancy = "UNKNOWN";
  const detail = await readPublicListing(f.client, f.account, f.gate); assert.equal((detail.availability as any).state, "UNKNOWN"); assert.equal(detail.canCreateOrder, false);
  assert((await evaluatePublication(f.client, f.account, f.version, f.gate)).includes("OCCUPANCY_UNKNOWN"));
  await assert.rejects(readPublicListing(f.client, f.account, f.gate, undefined, false, "RENTABLE"), (e: any) => e.status === 404);
});
test("ordinary pause/occupancy do not weaken the existing write qualification", async () => {
  for (const kind of ["pause", "occupancy"] as const) {
    const f = nativeFixture(); if (kind === "pause") f.account.owner_paused = true; else f.facts.occupancy = "OCCUPIED";
    const blockers = await evaluatePublication(f.client, f.account, f.version, f.gate);
    assert(blockers.includes(kind === "pause" ? "OWNER_PAUSED" : "OCCUPIED"));
    await assert.rejects(readPublicListing(f.client, f.account, f.gate, undefined, false, "RENTABLE"), (e: any) => e.status === 404);
  }
});
test("a newer draft never leaks and only the last real public version remains viewable", async () => {
  const f = nativeFixture(); f.facts.draft = { ...f.version, id: "draft-a", review_state: "DRAFT", title: "PRIVATE_UNREVIEWED_TITLE" };
  f.account.current_version_id = "draft-a";
  const detail = await readPublicListing(f.client, f.account, f.gate);
  assert.equal(detail.versionId, "version-a"); assert.equal(detail.canCreateOrder, false); assert.equal((detail.availability as any).state, "OFFLINE");
  assert(!JSON.stringify(detail).includes("PRIVATE_UNREVIEWED_TITLE"));
});
test("privacy/subject, acceptance and immutable hash guards still reject", async () => {
  for (const kind of ["owner", "acceptance", "hash"] as const) {
    const f = nativeFixture(); if (kind === "owner") f.account.owner_user_id = "new-unapproved-owner";
    if (kind === "acceptance") f.facts.accepted = false;
    if (kind === "hash") f.version.content_hash = "0".repeat(64);
    await assert.rejects(readPublicListing(f.client, f.account, f.gate), (e: any) => e.status === 404);
  }
});
test("missing or revoked images do not invent media, and still block rentability", async () => {
  const f = nativeFixture(); f.facts.mediaReady = false;
  const detail = await readPublicListing(f.client, f.account, f.gate);
  assert.deepEqual(detail.media, []); assert.equal(detail.canCreateOrder, false);
  await assert.rejects(readPublicListing(f.client, f.account, f.gate, undefined, false, "RENTABLE"), (e: any) => e.status === 404);
});
test("owner media readability follows the shared public view even while new rental is paused", async () => {
  const f = nativeFixture(); f.account.owner_paused = true;
  const detail = await listingDetail(f.client, f.account, "owner", f.gate);
  assert.equal(detail.available, false);
  assert.equal((detail.version as any).declaration.mediaBindings[0].publiclyReadable, true);
  f.account.staff_restricted = true;
  assert.equal(((await listingDetail(f.client, f.account, "owner", f.gate)).version as any).declaration.mediaBindings[0].publiclyReadable, false);
});
test("real read errors are not converted to a successful unavailable DTO", async () => {
  const f = nativeFixture(); f.facts.failure = true; await assert.rejects(readPublicListing(f.client, f.account, f.gate), /READ_FAILURE_FIXTURE/);
});
test("exact number lookup fails closed on raw multi-target aliases before public projection", async () => {
  const one = nativeFixture(), two = nativeFixture("account-b", "game-b"); one.facts.occupancy = "OCCUPIED";
  let active = one;
  const client = { query: async (sql: string, args: any[] = []) => {
    if (sql.includes("SELECT DISTINCT a.id")) { const matches = [one, two].filter(f => !args[1] || args[1] === f.account.game_id).map(f => ({ id: f.account.id })); return { rows: matches, rowCount: matches.length }; }
    if (sql.includes("SELECT * FROM zzsh_supply.rental_account")) active = args[0] === two.account.id ? two : one;
    return active.client.query(sql, args);
  } } as unknown as PoolClient;
  await assert.rejects(lookupPublicListing(client, { number: "0000123", gameId: null }, one.gate), (e: any) => e.status === 409);
  const result = await lookupPublicListing(client, { number: "0000123", gameId: "game-a" }, one.gate);
  assert.equal(result.id, one.account.id); assert.equal(result.canCreateOrder, false);
  two.account.staff_restricted = true;
  await assert.rejects(lookupPublicListing(client, { number: "0000123", gameId: null }, one.gate), (e: any) => e.status === 409 && !JSON.stringify(e).includes("account-"));
  one.account.staff_restricted = true;
  await assert.rejects(lookupPublicListing(client, { number: "0000123", gameId: "game-a" }, one.gate), (e: any) => e.status === 404);
  two.account.game_id = "game-a";
  await assert.rejects(lookupPublicListing(client, { number: "0000123", gameId: "game-a" }, one.gate), (e: any) => e.status === 409);
});
function responseCapture() {
  const result: { status: number; body: any } = { status: 0, body: null };
  const response = { status(value: number) { result.status = value; return this; }, setHeader() { return this; }, json(body: unknown) { result.body = body; return this; } };
  return { result, response };
}
test("existing favorite stays recognizable through another party occupancy, release and ordinary pause; withdrawal hides fields", async () => {
  const f = nativeFixture(); let actor: string | null = "reader-a";
  const client = { query: async (sql: string, args: any[] = []) => {
    if (sql.startsWith('SELECT u."suspended"')) return { rows: [{ suspended: false, accountStatus: "ACTIVE" }], rowCount: 1 };
    if (sql.includes('FROM zzsh_supply.favorite WHERE user_id')) return { rows: args[0] === "reader-a" ? [{ account_id: f.account.id, savedAt: "2026-10-01T00:00:00.000000Z" }] : [], rowCount: args[0] === "reader-a" ? 1 : 0 };
    return f.client.query(sql, args);
  }, release() {} };
  const options = { pool: { query: client.query, connect: async () => client }, supplyGateReader: f.gate,
    userAuth: { api: { getSession: async () => actor ? { user: { id: actor }, session: { id: "session-fixture" } } : null } } };
  async function read() { const capture = responseCapture(); await handleFavorites({ method: "GET", headers: {} } as never, capture.response as never, options as never, "req_fixture", "/me/favorites", new URLSearchParams()); return capture.result.body; }
  assert.equal((await read()).items[0].listing.canCreateOrder, true);
  for (const kind of ["PENDING_PAYMENT", "RENTED"] as const) {
    f.facts.occupancy = "OCCUPIED"; f.facts.occupancyKind = kind;
    const row = (await read()).items[0]; assert.equal(row.accountId, f.account.id); assert.equal(row.state, "AVAILABLE");
    assert.equal(row.listing.displayNo, "0000123"); assert.equal(row.listing.canCreateOrder, false); assert.equal(row.listing.availability.state, kind);
  }
  f.facts.occupancy = "FREE"; f.facts.occupancyKind = null;
  assert.equal((await read()).items[0].listing.canCreateOrder, true);
  f.account.owner_paused = true; assert.equal((await read()).items[0].listing.availability.state, "OFFLINE");
  f.account.staff_restricted = true; f.account.restriction_reason = "PRIVATE_RESTRICTION_REASON";
  const hidden = (await read()).items[0]; assert.equal(hidden.state, "UNAVAILABLE"); assert.equal(hidden.accountId, f.account.id); assert.equal(hidden.listing, null);
  assert(!JSON.stringify(hidden).includes("PRIVATE_RESTRICTION_REASON")); assert(!JSON.stringify(hidden).includes("0000123"));
  actor = "other-reader"; assert.deepEqual((await read()).items, []); actor = null;
  await assert.rejects(read(), (e: any) => e.status === 401);
});
test("lookup route is matched before the generic listing-id branch and stays anonymous public only", async () => {
  const f = nativeFixture(); f.facts.occupancy = "OCCUPIED";
  const client = { query: async (sql: string, args: any[] = []) => sql.includes("SELECT DISTINCT a.id") ? { rows: [{ id: f.account.id }], rowCount: 1 } : f.client.query(sql, args), release() {} };
  const capture = responseCapture();
  await handlePublishingRoute({ method: "GET", headers: {} } as never, capture.response as never,
    { pool: { connect: async () => client }, supplyGateReader: f.gate } as never, "req_lookup", "/listings/lookup", new URLSearchParams("number=0000123&gameId=game-a"), false);
  assert.equal(capture.result.status, 200); assert.equal(capture.result.body.id, f.account.id); assert.equal(capture.result.body.canCreateOrder, false);
});
test("default v2 keeps old-platform status=3 rows visible as read-only and separates cursor scope", async t => {
  const f = nativeFixture(); const queries: string[] = [];
  const client = { query: async (sql: string, args: any[] = []) => {
    queries.push(sql);
    if (sql.startsWith("WITH candidates AS")) return { rows: [{ id: f.account.id, version_id: f.version.id, key: "2026-10-01T00:00:00.000000Z" }], rowCount: 1 };
    if (sql.includes("FROM native UNION ALL SELECT * FROM legacy")) return { rows: [
      { id: "legacy-1", version_id: "legacy-version", key: "2026-09-13T00:00:00.000000Z", source: "legacy" },
      { id: f.account.id, version_id: f.version.id, key: "2026-10-01T00:00:00.000000Z", source: "native" }], rowCount: 2 };
    return f.client.query(sql, args);
  }, release() {} };
  let legacyOnly = false, mixed = false;
  t.mock.method(filterConfig, "readListingState", async () => ({ legacyReadOnly: legacyOnly, mixed, config: { sorts: [{ key: "latest", label: "最新发布" }] }, filterRevision: "1", catalogRevision: "1", ruleReleaseId: legacyOnly ? null : "release-a" }) as never);
  t.mock.method(filterConfig, "validateListingQuery", async () => {});
  let legacyCalls = 0, legacyRevisions: unknown = null;
  t.mock.method(legacyRead, "listLegacyReadListings", async (_client: unknown, _q: unknown, _key: unknown, revisions: unknown) => {
    legacyCalls++; legacyRevisions = revisions;
    return { queryVersion: 2, items: [{ id: "legacy-1", source: "LEGACY_READ_ONLY", canCreateOrder: false, quote: null }], nextCursor: null, sort: "latest", direction: "DESC", sortLabel: "更新时间", filterRevision: "1", catalogRevision: "1", ruleReleaseId: null, scannedCount: 1, scanBudget: 200, scanBudgetReached: false, limit: 20 };
  });
  t.mock.method(legacyRead, "mixedListingBinding", () => ({ queryVersion: 2, gameId: "game-a", queryHash: "x", sort: "latest", direction: "DESC", coreItemId: null, filterRevision: "1", catalogRevision: "1", ruleReleaseId: "release-a" }));
  t.mock.method(legacyRead, "readLegacyListing", async () => ({ id: "legacy-1", source: "LEGACY_READ_ONLY", canCreateOrder: false, quote: null }));
  const options = { pool: { connect: async () => client }, supplyGateReader: f.gate, listingCursorKey: { keyId: "fixture", secret: "x".repeat(32) }, legacyPublicAdmission: { schema: "legacy-public-admission-v2", records: [] } };
  const pageOf = () => listV2({ url: "/listings?queryVersion=2&gameId=game-a" } as never, options as never, new URLSearchParams("queryVersion=2&gameId=game-a"));
  try {
    const page = await pageOf();
    assert.equal(page.items.length, 1); assert.equal((page.items[0] as any).canCreateOrder, true); assert(!queries.some(q => q.includes("UNION ALL SELECT * FROM legacy")));
    f.facts.occupancy = "OCCUPIED"; assert.deepEqual((await pageOf()).items, []);
    f.facts.occupancy = "FREE"; mixed = true; const beforeMixed = queries.length;
    const mixedPage = await pageOf();
    assert.equal(mixedPage.items.length, 2);
    assert.equal((mixedPage.items[0] as any).source, "LEGACY_READ_ONLY"); assert.equal((mixedPage.items[0] as any).canCreateOrder, false);
    assert.equal((mixedPage.items[1] as any).canCreateOrder, true);
    assert(queries.slice(beforeMixed).some(q => q.includes("UNION ALL SELECT * FROM legacy")));
    mixed = false; legacyOnly = true; const beforeLegacy = queries.length;
    const legacyPage = await pageOf();
    assert.equal(legacyCalls, 1); assert.deepEqual(legacyRevisions, { filterRevision: "1", catalogRevision: "1", sortLabel: "更新时间" });
    assert.equal(legacyPage.items.length, 1); assert.equal((legacyPage.items[0] as any).source, "LEGACY_READ_ONLY"); assert.equal((legacyPage.items[0] as any).canCreateOrder, false);
    assert(!queries.slice(beforeLegacy).some(q => q.startsWith("WITH candidates AS")));
  } finally { t.mock.restoreAll(); }
});
test("only occupied stays publicly readable and cannot create another order", async () => {
  const f = nativeFixture(); f.facts.occupancy = "OCCUPIED";
  const result = await readPublicListing(f.client, f.account, f.gate);
  assert.equal(result.canCreateOrder, false); assert.equal((result.availability as { state: string }).state, "OCCUPIED");
});
test("only ordinary pause keeps the approved public detail marked offline", async () => {
  const f = nativeFixture(); f.account.owner_paused = true;
  const result = await readPublicListing(f.client, f.account, f.gate);
  assert.equal(result.canCreateOrder, false); assert.equal((result.availability as { state: string }).state, "OFFLINE");
});
test("restricted, suspended and archived still hide the public object", async () => {
  for (const kind of ["restriction", "suspended", "archived"] as const) {
    const f = nativeFixture(); if (kind === "restriction") f.account.staff_restricted = true;
    if (kind === "suspended") f.facts.suspended = true; if (kind === "archived") f.account.lifecycle = "ARCHIVED";
    await assert.rejects(readPublicListing(f.client, f.account, f.gate), (error: any) => error.status === 404);
  }
});
