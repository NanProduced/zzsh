import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { computeContentHash, normalizeContentPayload } from "../src/supply/content-hash";
import { computeQuote } from "../src/supply/pricing";
import {
  listingCandidatePage,
  readPublicListing,
  type ListingVersion,
  type PublishingAccount,
  type SupplyGateReader,
} from "../src/supply/publishing";
import { listV2 } from "../src/supply/listing-filter-routes";
import { handleFavorites } from "../src/supply/favorites";
import * as filterConfig from "../src/supply/listing-filter-config";
import * as legacyRead from "../src/supply/legacy-listing-read";

const GAME = "game-a";
const CURSOR_KEY = { keyId: "fixture", secret: "x".repeat(32) };

type Facts = {
  occupancy: "FREE" | "OCCUPIED" | "UNKNOWN";
  occupancyKind: "PENDING_PAYMENT" | "RENTED" | "OCCUPIED" | null;
  suspended: boolean;
  accepted: boolean;
  mediaReady: boolean;
  paused: boolean;
  restricted: boolean;
  lifecycle: string;
};

/** One native published account per id, sharing one game and two owners so the
 *  per-request memo has something real to memoize. */
function accountFixture(id: string, owner: string, facts: Partial<Facts> = {}) {
  const state: Facts = {
    occupancy: "FREE", occupancyKind: null, suspended: false, accepted: true,
    mediaReady: true, paused: false, restricted: false, lifecycle: "ACTIVE", ...facts,
  };
  const priced = computeQuote({ priceVersionId: "price-a", mode: "PERCENT", commissionRate: "0.2", roundingPolicy: "HALF_UP_CENT_V1",
    haffRule: { schema: "haff-ratio-v1", baseBySafeBox: { "box-a": "40" }, vitalityDeltaByLevel: { 6: "0" }, bearDeltaByLevel: { 6: "0" }, dailyDeltaByTermOption: { daily: "0" }, options: { standard: { delta: "0", enabled: true } } },
    lines: [{ itemId: "haff-a", quantity: "1000000", pricingKind: "HAFF_RATIO" }],
    conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily", pricingOptionCode: "standard" },
    termOption: { code: "daily", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" } });
  assert(priced.quotable); priced.quote.ownerTotal.amount = "123456.78";
  const payload = normalizeContentPayload({ schemaVersion: 1, accountId: id, gameId: GAME,
    declaration: { title: `标题-${id}`, description: null, attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6 },
      termOptionCode: "daily", pricingOptionCode: "standard", inventory: [{ itemId: "haff-a", quantity: "1000000" }], skins: [], entitlements: [],
      mediaBindings: [{ assetId: `media-${id}`, purpose: "ACCOUNT_DISPLAY", byteHash: "a".repeat(64), position: 0 }] },
    ruleRefs: { releaseId: "release-a", priceVersionId: "price-a", termVersionId: "term-a", agreementVersionId: "agreement-a", agreementDigest: "d".repeat(64) },
    quoteValues: priced.quote });
  const account: PublishingAccount = { id, owner_user_id: owner, game_id: GAME, current_version_id: `version-${id}`,
    owner_paused: state.paused, staff_restricted: state.restricted, restriction_reason: state.restricted ? "PRIVATE_RESTRICTION_REASON" : null,
    lifecycle: state.lifecycle, legacy_hold: "NONE", revision: "1", display_no: `AC00000000${id}` };
  const version: ListingVersion = { id: `version-${id}`, account_id: id, sequence: "1", origin: "NATIVE", review_state: "PUBLISHED",
    schema_version: 1, title: payload.declaration.title, description: null, attributes: payload.declaration.attributes,
    term_option_code: "daily", pricing_option_code: "standard", rule_release_id: "release-a", content_hash: computeContentHash(payload), payload,
    presentation: { items: [], skins: [], entitlements: [] }, revision: "1", submitted_at: null };
  const publication = () => ({ id: `publication-${id}`, version_id: version.id, account_id: id, owner_user_id: owner,
    game_id: GAME, rule_release_id: version.rule_release_id, content_hash: version.content_hash, source: "OWNER_DIRECT", published_at: new Date("2026-10-01T00:00:00Z") });
  return { id, owner, state, account, version, publication };
}

type Fixture = ReturnType<typeof accountFixture>;

function clientFor(fixtures: Fixture[], favorites?: (userId: string) => Array<{ account_id: string; savedAt: string }>) {
  const queries: string[] = [], windows: string[][] = [];
  const byAccount = new Map(fixtures.map((f) => [f.account.id, f]));
  const accounts = fixtures.map((f) => f.account), versions = fixtures.map((f) => f.version);
  const media = fixtures.map((f) => ({ id: `media-${f.id}`, account_id: f.id, game_id: GAME, owner_user_id: f.owner,
    ownership_kind: "USER_SUPPLY", purpose: "ACCOUNT_DISPLAY", content_hash: "a".repeat(64), review_state: "APPROVED",
    access_class: "PUBLIC_DISPLAY", technical_state: f.state.mediaReady ? "READY" : "FAILED", public_storage_key: `public-${f.id}` }));
  const client = { query: async (sql: string, args: unknown[] = []) => {
    queries.push(sql);
    const pick = <T extends { id: string }>(pool: T[]) => (Array.isArray(args[0]) ? pool.filter((row) => (args[0] as string[]).includes(row.id)) : pool.filter((row) => row.id === args[0]));
    let rows: unknown[] = [];
    if (sql.includes("FROM zzsh_supply.rental_account WHERE id = ANY")) { windows.push(args[0] as string[]); rows = pick(accounts); }
    else if (sql.includes('u."suspended"')) rows = [{ suspended: false, accountStatus: "ACTIVE" }];
    else if (sql === "SELECT * FROM zzsh_supply.rental_account WHERE id=$1") rows = pick(accounts);
    else if (sql.includes("FROM zzsh_supply.listing_version WHERE id = ANY")) rows = pick(versions);
    else if (sql.includes("SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2")) rows = versions.filter((v) => v.id === args[0] && v.account_id === args[1]);
    else if (sql.includes("SELECT DISTINCT account_id FROM zzsh_supply.listing_publication")) rows = pick(accounts).map((a) => ({ account_id: a.id }));
    else if (sql.includes("SELECT 1 FROM zzsh_supply.listing_publication")) rows = pick(accounts).length ? [{}] : [];
    else if (sql.includes("zzsh_supply.listing_publication")) rows = pick(versions).map((v) => byAccount.get(v.account_id)!.publication());
    else if (sql.includes('SELECT u.suspended')) { const f = fixtures.find((x) => x.owner === args[0])!; rows = [{ suspended: f.state.suspended, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }]; }
    else if (sql.includes("game_service_operation")) rows = [{ id: "service-a", gameId: GAME, gameCode: "delta", gameEnabled: true, enabled: true, revision: "1" }];
    else if (sql.includes("FROM zzsh_supply.game WHERE id=")) rows = [{ id: GAME, code: "delta", name: "三角洲行动", enabled: true, current_release_id: "release-a", catalog_revision: "1" }];
    else if (sql.includes("funding_policy AS policy")) rows = [{ policy: null }];
    else if (sql.includes("rule_acceptance")) rows = pick(accounts).some((a) => byAccount.get(a.id)!.state.accepted) ? [{}] : [];
    else if (sql.includes("SELECT a.* FROM zzsh_supply.listing_media")) rows = media.filter((m) => pick(versions).some((v) => `media-${v.account_id}` === m.id));
    else if (sql.includes("term_option")) rows = [{ code: "daily", name: "每日", dailyConsumption: "10000000" }];
    else if (sql.includes("FROM zzsh_supply.favorite")) rows = favorites ? [...favorites(String(args[0]))].sort((left, right) => right.savedAt.localeCompare(left.savedAt) || right.account_id.localeCompare(left.account_id)) : [];
    return { rows, rowCount: rows.length };
  }, release() {} } as unknown as PoolClient;
  const gate: SupplyGateReader = async (_client, account) => {
    const f = byAccount.get(account.id)!;
    return { publisherBail: "NOT_REQUIRED", occupancy: f.state.occupancy, reference: "policy:fixture", ...(f.state.occupancyKind ? { occupancyKind: f.state.occupancyKind } : {}) };
  };
  return { client, gate, queries, windows };
}

const countOf = (queries: string[], needle: string) => queries.filter((sql) => sql.includes(needle)).length;

function candidateRows(fixtures: Fixture[]) {
  return fixtures.map((f, index) => ({ id: f.account.id, version_id: f.version.id, key: `2026-10-0${index + 1}T00:00:00.000000Z` }));
}

async function marketPage(t: { mock: { method: (object: object, key: string, value: unknown) => () => void } }, fixtures: Fixture[], search: URLSearchParams, mode: "native" | "mixed" = "native") {
  const rows = mode === "native"
    ? candidateRows(fixtures)
    : [{ id: "legacy-1", version_id: "legacy-version", key: "2026-10-09T00:00:00.000000Z", source: "legacy" },
       ...candidateRows(fixtures).map((row, index) => ({ ...row, key: `2026-10-0${8 - index}T00:00:00.000000Z`, source: "native" }))];
  const { client, gate, queries, windows } = clientFor(fixtures);
  const real = client.query;
  (client as unknown as { query: PoolClient["query"] }).query = (async (sql: string, args: unknown[] = []) =>
    sql.startsWith(mode === "native" ? "WITH candidates AS" : "WITH native AS") ? { rows, rowCount: rows.length } : real(sql, args)) as never;
  const options = { pool: { connect: async () => client }, supplyGateReader: gate, listingCursorKey: CURSOR_KEY,
    legacyPublicAdmission: { schema: "legacy-public-admission-v2", records: [] } };
  const undo = [
    t.mock.method(filterConfig, "readListingState", async () => ({ legacyReadOnly: false, mixed: mode === "mixed", config: { sorts: [{ key: "latest", label: "最新发布" }] },
      filterRevision: "1", catalogRevision: "1", ruleReleaseId: "release-a" })),
    t.mock.method(filterConfig, "validateListingQuery", async () => {}),
    t.mock.method(legacyRead, "mixedListingBinding", () => ({ queryVersion: 2, gameId: GAME, queryHash: "x", sort: "latest", direction: "DESC", coreItemId: null, filterRevision: "1", catalogRevision: "1", ruleReleaseId: "release-a" })),
    t.mock.method(legacyRead, "readLegacyListing", async () => ({ id: "legacy-1", source: "LEGACY_READ_ONLY", canCreateOrder: false, quote: null })),
  ];
  try {
    const page = await listV2({ url: "/listings?" + search } as never, options as never, search);
    return { page, queries, windows };
  } finally { for (const restore of undo) restore(); }
}

test("a native market page reads each shared dimension once, not once per candidate", async t => {
  const fixtures = ["a", "b", "c", "d", "e"].map((id, index) => accountFixture(id, index % 2 ? "owner-1" : "owner-0"));
  const { page, queries } = await marketPage(t, fixtures, new URLSearchParams("queryVersion=2&gameId=game-a&limit=5"));
  assert.equal(page.items.length, 5);
  assert.equal(page.scannedCount, 5); assert.equal(page.scanBudget, 200); assert.equal(page.scanBudgetReached, false);
  // Set-based selection: one round trip per dimension for the whole window.
  assert.equal(countOf(queries, "FROM zzsh_supply.rental_account WHERE id = ANY"), 1, "accounts are read once per window");
  assert.equal(countOf(queries, "FROM zzsh_supply.listing_version WHERE id = ANY"), 1, "current versions are read once per window");
  assert.equal(countOf(queries, "SELECT * FROM zzsh_supply.rental_account WHERE id=$1"), 0, "no per-candidate account read");
  assert.equal(countOf(queries, "SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2"), 0, "no per-candidate version read");
  // Request-invariant dimensions are memoized for the whole page.
  assert.equal(countOf(queries, "FROM zzsh_supply.game WHERE id="), 1, "one game row per page");
  assert.equal(countOf(queries, "game_service_operation"), 1, "one rental service row per page");
  assert.equal(countOf(queries, "funding_policy AS policy"), 1, "one release policy per page");
  // The two reads of one candidate's media collapsed into one.
  assert.equal(countOf(queries, "SELECT a.* FROM zzsh_supply.listing_media"), 5, "one media read per candidate, not two");
});

test("batched page projection is the same DTO the single reader returns for each account", async t => {
  const fixtures = ["a", "b", "c"].map((id, index) => accountFixture(id, index % 2 ? "owner-1" : "owner-0"));
  const { client, gate } = clientFor(fixtures);
  const single: Record<string, unknown> = {};
  for (const f of fixtures) single[f.account.id] = await readPublicListing(client, f.account, gate, undefined, false, "DETAIL");
  const page = listingCandidatePage(client);
  await page.load(fixtures.map((f) => f.account.id), true);
  for (const f of fixtures) {
    assert.deepEqual(
      await readPublicListing(client, page.account(f.account.id)!, gate, undefined, false, "DETAIL", undefined, {
        version: page.version(f.account.id), hasPublication: page.hasPublication(f.account.id), shared: page.shared,
      }),
      single[f.account.id],
      `candidate ${f.account.id} keeps its exact public DTO`,
    );
  }
});

test("a small limit never loads rows it will not project", async t => {
  const fixtures = ["a", "b", "c", "d", "e"].map((id) => accountFixture(id, "owner-0"));
  const { page, windows } = await marketPage(t, fixtures, new URLSearchParams("queryVersion=2&gameId=game-a&limit=1"));
  assert.equal(page.items.length, 1); assert.equal(page.scannedCount, 1);
  assert.deepEqual(windows, [[fixtures[0]!.account.id]], "limit=1 reads exactly the one row it projects");
});

test("rejected candidates move the window forward and still fill the page in order", async t => {
  const fixtures = ["a", "b", "c", "d", "e"].map((id, index) => accountFixture(id, "owner-0", index < 2 ? { occupancy: "OCCUPIED", occupancyKind: "RENTED" } : {}));
  const { page, queries } = await marketPage(t, fixtures, new URLSearchParams("queryVersion=2&gameId=game-a&limit=2"));
  assert.deepEqual(page.items.map((item) => (item as { id: string }).id), ["c", "d"]);
  assert.equal(page.scannedCount, 4, "scanBudget still counts every candidate the page looked at");
  assert.equal(countOf(queries, "FROM zzsh_supply.rental_account WHERE id = ANY"), 2, "two windows for four candidates, not four reads");
  assert.notEqual(page.nextCursor, null, "hasMore stays exact, not an approximation");
  const allBusy = ["a", "b", "c", "d", "e"].map((id) => accountFixture(id, "owner-0", { occupancy: "OCCUPIED", occupancyKind: "PENDING_PAYMENT" }));
  const empty = await marketPage(t, allBusy, new URLSearchParams("queryVersion=2&gameId=game-a&limit=2"));
  assert.deepEqual(empty.page.items, []); assert.equal(empty.page.scannedCount, 5); assert.equal(empty.page.scanBudgetReached, false);
  const noHits = await marketPage(t, [], new URLSearchParams("queryVersion=2&gameId=game-a&limit=2"));
  assert.deepEqual(noHits.page.items, []); assert.equal(noHits.page.scannedCount, 0); assert.equal(noHits.page.nextCursor, null);
});

test("only fully rentable candidates reach a RENTABLE market page", async t => {
  const variants: Array<[Partial<Facts>, string]> = [
    [{ occupancy: "OCCUPIED", occupancyKind: "PENDING_PAYMENT" }, "PENDING_PAYMENT"],
    [{ occupancy: "OCCUPIED", occupancyKind: "RENTED" }, "RENTED"],
    [{ occupancy: "UNKNOWN" }, "UNKNOWN"],
    [{ paused: true }, "OFFLINE"],
    [{ restricted: true }, "UNAVAILABLE"],
    [{ suspended: true }, "UNAVAILABLE"],
    [{ lifecycle: "ARCHIVED" }, "UNAVAILABLE"],
    [{ accepted: false }, "UNAVAILABLE"],
    [{ mediaReady: false }, "UNAVAILABLE"],
  ];
  for (const [facts, label] of variants) {
    const fixtures = [accountFixture("a", "owner-0", facts), accountFixture("b", "owner-0", facts)];
    const { page } = await marketPage(t, fixtures, new URLSearchParams("queryVersion=2&gameId=game-a&limit=2"));
    assert.deepEqual(page.items, [], `${label} never reaches a rentable market card`);
    assert.equal(page.scannedCount, 2, `${label} still consumes the scan budget`);
  }
  const free = [accountFixture("a", "owner-0"), accountFixture("b", "owner-0")];
  const { page } = await marketPage(t, free, new URLSearchParams("queryVersion=2&gameId=game-a&limit=2"));
  assert.equal(page.items.length, 2);
  for (const item of page.items as Array<{ availability: { state: string }; canCreateOrder: boolean }>) {
    assert.equal(item.availability.state, "RENTABLE"); assert.equal(item.canCreateOrder, true);
  }
});

test("batched detail reads keep the same occupancy, pause and restriction labels as the single reader", async t => {
  const variants: Array<[Partial<Facts>, string, boolean]> = [
    [{ occupancy: "OCCUPIED", occupancyKind: "PENDING_PAYMENT" }, "PENDING_PAYMENT", false],
    [{ occupancy: "OCCUPIED", occupancyKind: "RENTED" }, "RENTED", false],
    [{ occupancy: "UNKNOWN" }, "UNKNOWN", false],
    [{ paused: true }, "OFFLINE", false],
    [{}, "RENTABLE", true],
  ];
  for (const [facts, state, rentable] of variants) {
    const fixtures = [accountFixture("a", "owner-0", facts), accountFixture("b", "owner-0", facts)];
    const { client, gate } = clientFor(fixtures);
    const page = listingCandidatePage(client);
    await page.load(fixtures.map((f) => f.account.id), true);
    for (const f of fixtures) {
      const expected = await readPublicListing(client, f.account, gate, undefined, false, "DETAIL");
      const batched = await readPublicListing(client, page.account(f.account.id)!, gate, undefined, false, "DETAIL", undefined, {
        version: page.version(f.account.id), hasPublication: page.hasPublication(f.account.id), shared: page.shared,
      });
      assert.deepEqual(batched, expected, JSON.stringify(facts));
      assert.equal((batched.availability as { state: string }).state, state, JSON.stringify(facts));
      assert.equal(batched.canCreateOrder, rentable, JSON.stringify(facts));
    }
  }
});

test("mixed pages keep both sources, their order and the legacy read contract", async t => {
  const fixtures = [accountFixture("a", "owner-0"), accountFixture("b", "owner-0")];
  const { page } = await marketPage(t, fixtures, new URLSearchParams("queryVersion=2&gameId=game-a&limit=3"), "mixed");
  assert.equal(page.items.length, 3);
  assert.equal(page.scannedCount, 3);
  const legacy = page.items[0] as { id: string; source: string; canCreateOrder: boolean; quote: unknown };
  assert.equal(legacy.id, "legacy-1"); assert.equal(legacy.source, "LEGACY_READ_ONLY");
  assert.equal(legacy.canCreateOrder, false); assert.equal(legacy.quote, null);
  assert.deepEqual((page.items[1] as { id: string }).id, "a");
  assert.deepEqual((page.items[2] as { id: string }).id, "b");
  assert.notEqual((page.items[1] as { canCreateOrder: boolean }).canCreateOrder, legacy.canCreateOrder);
});

function responseCapture() {
  const result: { status: number; body: any } = { status: 0, body: null };
  const response = { status(value: number) { result.status = value; return this; }, setHeader() { return this; }, json(body: unknown) { result.body = body; return this; } };
  return { result, response };
}

test("favorites read the private set once per page and hide objects that lost public eligibility", async t => {
  const fixtures = ["a", "b", "c"].map((id, index) => accountFixture(id, "owner-0", index === 1 ? { restricted: true } : {}));
  const favorites = fixtures.map((f, index) => ({ account_id: f.account.id, savedAt: `2026-10-0${index + 1}T00:00:00.000000Z` }));
  const { client, gate, queries } = clientFor(fixtures, (userId) => (userId === "reader-a" ? favorites : []));
  const options = { pool: { query: client.query, connect: async () => client }, supplyGateReader: gate,
    userAuth: { api: { getSession: async () => ({ user: { id: "reader-a" }, session: { id: "session-fixture" } }) } } };
  const capture = responseCapture();
  await handleFavorites({ method: "GET", headers: {} } as never, capture.response as never, options as never, "req_fixture", "/me/favorites", new URLSearchParams());
  const items = capture.result.body.items;
  assert.deepEqual(items.map((row: { accountId: string }) => row.accountId), ["c", "b", "a"], "saved order is preserved");
  assert.equal(countOf(queries, "FROM zzsh_supply.rental_account WHERE id = ANY"), 1, "one account read for the whole favorites page");
  assert.equal(countOf(queries, "SELECT DISTINCT account_id FROM zzsh_supply.listing_publication"), 1, "one publication probe for the whole page");
  assert.equal(countOf(queries, "SELECT 1 FROM zzsh_supply.listing_publication"), 0, "no per-row publication probe");
  const hidden = items.find((row: { accountId: string }) => row.accountId === "b");
  assert.equal(hidden.state, "UNAVAILABLE"); assert.equal(hidden.listing, null);
  assert(!JSON.stringify(hidden).includes("PRIVATE_RESTRICTION_REASON"));
  assert(!JSON.stringify(hidden).includes(String(fixtures[1]!.account.display_no)));
  for (const id of ["a", "c"]) {
    const row = items.find((entry: { accountId: string }) => entry.accountId === id);
    assert.equal(row.state, "AVAILABLE");
    const expected = await readPublicListing(client, fixtures.find((f) => f.account.id === id)!.account, gate, undefined, false, "DETAIL");
    assert.deepEqual(row.listing, expected, `favorite ${id} keeps its exact public DTO`);
  }
  (options.userAuth.api.getSession as unknown as () => Promise<null>) = (async () => null) as never;
  await assert.rejects(handleFavorites({ method: "GET", headers: {} } as never, responseCapture().response as never, options as never, "req_fixture", "/me/favorites", new URLSearchParams()), (error: { status?: number }) => error.status === 401);
  const other = responseCapture();
  (options.userAuth.api.getSession as unknown as () => Promise<{ user: { id: string }; session: { id: string } }>) = (async () => ({ user: { id: "reader-b" }, session: { id: "session-b" } })) as never;
  await handleFavorites({ method: "GET", headers: {} } as never, other.response as never, options as never, "req_fixture", "/me/favorites", new URLSearchParams());
  assert.deepEqual(other.result.body.items, [], "another reader never sees this set");
});
