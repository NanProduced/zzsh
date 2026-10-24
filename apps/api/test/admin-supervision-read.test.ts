import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSupervisionQuery, encodeSupervisionCursor, decodeSupervisionCursor, supervisionFacts, listSupervision, readSupervision } from "../src/supply/admin-supervision-read";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { listingDetail, publicationBlockers, type PublishingAccount, type SupplyGateReader } from "../src/supply/publishing";
import { parseMediaReviewBinding, assertMediaReviewBinding } from "../src/supply/media";
import { fundingPolicyFixture } from "./funding-authority-fixtures";

const publishing = require("../src/supply/publishing");
const fixtureAccount: PublishingAccount = { id: "fixture-account", owner_user_id: "fixture-owner", game_id: "fixture-game", current_version_id: null, owner_paused: false, staff_restricted: false, restriction_reason: null, legacy_hold: "NONE", lifecycle: "ACTIVE", revision: "1", display_no: null };
/** The page reads its accounts, current versions and publication probe in one
 *  batch, so the harness answers the batch reads instead of one read per row. */
function batchAccounts(ids: readonly string[], versionId: (id: string) => string | null = (id) => `version-${id}`): Map<string, PublishingAccount> {
    return new Map(ids.map(id => [id, { ...fixtureAccount, id, owner_user_id: id === "a-1" ? "u-1" : "u-2", current_version_id: versionId(id), revision: "3" }]));
}
function batchVersionRows(ids: readonly string[]) {
    return ids.map(id => ({ id, account_id: id.replace(/^version-/, ""), sequence: "1", origin: "NATIVE", review_state: "DRAFT", title: "标题", description: null, attributes: {}, term_option_code: "", pricing_option_code: "", rule_release_id: null, content_hash: null, payload: null, presentation: {}, revision: "1", submitted_at: null, schema_version: 1 }));
}
const fixtureClient = { query: async (sql: string) => {
    assert.match(sql, /^\s*SELECT/, "occupancy projection remains read-only");
    return { rows: sql.includes('"game_service_operation"') ? [{ id: "fixture-service", gameCode: "delta", gameEnabled: true, enabled: true }] : [] };
} } as never;

const queryViewer = { adminId: "fixture-admin", sessionId: "fixture-session", access: { status: "ACTIVE" as const, isBoss: true, passwordChangeRequired: false, permissions: new Set(["order.read"]) }, scope: [], contextKey: "fixture-context" };
const queryKey = { keyId: "fixture", secret: "fixture-only-private-cursor-key-000001" };
async function captureListQuery(params: URLSearchParams) {
    let captured: { sql: string; values: unknown[] } | undefined;
    await listSupervision({ query: async (sql: string, values: unknown[]) => {
        if (sql.startsWith("SELECT a.id,")) captured = { sql, values };
        return { rows: [] };
    } } as never, queryViewer, parseSupervisionQuery(params), async () => { throw Error("empty page has no gate reads"); }, queryKey);
    assert.ok(captured);
    return captured;
}
test("every location branch allocates only referenced SQL parameters", async () => {
    for (const kind of ["account", "legacy", "owner", "nickname", "order"]) {
        const { sql, values } = await captureListQuery(new URLSearchParams({ queryKind: kind, q: "fixture", gameId: "game-1", view: "restricted" }));
        const positions = new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
        assert.deepEqual([...positions].sort((a, b) => a - b), values.map((_, i) => i + 1));
    }
});

// Opt-in against an existing registered local database; no schema, fixture or data writes.
test("nickname branch executes actual PostgreSQL SQL for literal LIKE characters, candidates and combined filters", { skip: !process.env.ADMIN_READ_PG_CREDENTIALS }, async t => {
    const cred = JSON.parse(readFileSync(process.env.ADMIN_READ_PG_CREDENTIALS!, "utf8"));
    assert.equal(cred.host, "127.0.0.1"); assert.equal(cred.port, 55432);
    assert.ok(["zzsh_test_order_admin_order_read", "zzsh_test_supply_migration_baseline"].includes(cred.database));
    const pool = new Pool({ host: cred.host, port: cred.port, database: cred.database, user: cred.runtime.role, password: cred.runtime.password, max: 1 });
    const c = await pool.connect();
    try {
        await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await c.query("SET LOCAL statement_timeout='10s'");
        const identity = (await c.query("SELECT oid,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0];
        assert.equal(identity.oid, cred.database === "zzsh_test_order_admin_order_read" ? 836794 : 793252);
        assert.match(identity.marker, /^zzsh:/);
        const prefix = `WITH fixture_accounts(id,owner_user_id,game_id,current_version_id,created_at,updated_at,display_no,revision,staff_restricted,owner_paused) AS (VALUES
          ('a','u-a','game-1','v-a','2026-10-03T00:00:03Z'::timestamptz,'2026-10-04T00:00:03Z'::timestamptz,'NO-A',7::bigint,true,false),
          ('b','u-b','game-1','v-b','2026-10-03T00:00:02Z'::timestamptz,null::timestamptz,null,3::bigint,false,false),
          ('c','u-c','game-2','v-c','2026-10-03T00:00:01Z'::timestamptz,'2026-10-03T00:00:01Z'::timestamptz,'NO-C',1::bigint,true,false)),
          fixture_users(id,name) AS (VALUES ('u-a','阿洛甲'),('u-b','阿洛乙'),('u-c',$5::text)),
          fixture_games(id,name) AS (VALUES ('game-1','一'),('game-2','二')),
          fixture_versions(id,sequence,title,review_state,created_at,rule_release_id,payload) AS (VALUES
            ('v-a',1,'甲','DRAFT',null::timestamptz,'release-a','{"ruleRefs":{"priceVersionId":"price-a"}}'::jsonb),
            ('v-b',1,'乙','DRAFT',null::timestamptz,null::text,null::jsonb),
            ('v-c',1,'丙','DRAFT',null::timestamptz,'release-c',null::jsonb)),
          fixture_admin_scope(admin_user_id,game_scope_mode) AS (VALUES ('fixture-admin','SELECTED_GAMES')),
          fixture_scope(admin_user_id,game_id) AS (VALUES ('fixture-admin','game-1')) `;
        for (const [q, expected] of [["阿洛甲", ["a"]], ["阿洛", ["a", "b"]], ["no-match", []], ["%", ["c"]], ["_", ["c"]], ["\\", ["c"]], ["%_\\", ["c"]]] as const) {
            await t.test("SQL nickname " + JSON.stringify(q), async () => {
                const built = await captureListQuery(new URLSearchParams({ queryKind: "nickname", q }));
                assert.equal(built.values.length, 4);
                const sql = built.sql.replaceAll("zzsh_supply.rental_account", "fixture_accounts").replaceAll('zzsh_auth_user."user"', "fixture_users").replaceAll("zzsh_supply.game", "fixture_games").replaceAll("zzsh_supply.listing_version", "fixture_versions").replaceAll("zzsh_supply.admin_supply_scope", "fixture_scope").replaceAll('"zzsh_iam"."admin_security"', "fixture_admin_scope");
                assert.deepEqual((await c.query(prefix + sql, [...built.values, "百分%_\\用户"])).rows.map(r => r.id), expected);
            });
        }
        await t.test("SQL nickname combined game/restriction and real data query", async () => {
            const built = await captureListQuery(new URLSearchParams({ queryKind: "nickname", q: "阿洛", gameId: "game-1", view: "restricted" }));
            const sql = built.sql.replaceAll("zzsh_supply.rental_account", "fixture_accounts").replaceAll('zzsh_auth_user."user"', "fixture_users").replaceAll("zzsh_supply.game", "fixture_games").replaceAll("zzsh_supply.listing_version", "fixture_versions").replaceAll("zzsh_supply.admin_supply_scope", "fixture_scope").replaceAll('"zzsh_iam"."admin_security"', "fixture_admin_scope");
            const combinedPrefix = prefix.replace("$5::text", "$6::text");
            assert.deepEqual((await c.query(combinedPrefix + sql, [...built.values, "百分%_\\用户"])).rows.map(r => r.id), ["a"]);
            // The unsubstituted query runs against the real schema only once the
            // registered resource carries 0068_admin_game_scope; before that the
            // fixture substitution above is the executed evidence.
            const modeReady = (await c.query(`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='zzsh_iam.admin_security'::regclass AND attname='game_scope_mode' AND NOT attisdropped) AS "ready"`)).rows[0].ready;
            if (modeReady) {
                const rows = (await c.query(built.sql, built.values)).rows;
                assert.ok(Array.isArray(rows));
            } else {
                assert.ok(built.sql.includes('"game_scope_mode"'));
            }
        });
    } finally { await c.query("ROLLBACK"); c.release(); await pool.end(); }
});

test("missing current version leaves occupancy UNKNOWN without querying the gate", async t => {
    t.mock.method(publishing, "readPublicListing", async () => { throw Object.assign(new Error("fixture unavailable"), { status: 404 }); });
    let gateCalls = 0;
    const gate: SupplyGateReader = async () => { gateCalls++; return { occupancy: "OCCUPIED", publisherBail: "NOT_REQUIRED", reference: "fixture" }; };
    const detail = await listingDetail(fixtureClient, fixtureAccount, "admin", gate);
    const facts = await supervisionFacts(fixtureClient, fixtureAccount, detail, gate);
    assert.equal(detail.version, null);
    assert.equal(gateCalls, 0);
    assert.equal(facts.occupancy, "UNKNOWN");
    assert.equal(facts.newOrders, false);
    assert.deepEqual(facts.reasons, ["CURRENT_VERSION_MISSING"]);
    assert.equal(facts.historicalRead, null);
});
for (const occupancy of ["FREE", "OCCUPIED", "UNKNOWN"] as const) {
    test("current version preserves authoritative gate occupancy " + occupancy, async t => {
        t.mock.method(publishing, "readPublicListing", async () => { throw Object.assign(new Error("fixture unavailable"), { status: 404 }); });
        const account = { ...fixtureAccount, current_version_id: "fixture-version" };
        let gateCalls = 0;
        const gate: SupplyGateReader = async () => { gateCalls++; return { occupancy, publisherBail: "NOT_REQUIRED", reference: "fixture" }; };
        const blockers = await publicationBlockers(fixtureClient, account, { origin: "NATIVE", rule_release_id: null, attributes: {} } as never, gate);
        const facts = await supervisionFacts(fixtureClient, account, { version: { id: "fixture-version" }, blockers }, gate);
        assert.equal(gateCalls, 1);
        assert.equal(facts.occupancy, occupancy);
        assert.equal(blockers.includes("OCCUPIED"), occupancy === "OCCUPIED");
        assert.equal(blockers.includes("OCCUPANCY_UNKNOWN"), occupancy === "UNKNOWN");
    });
}
test("supervision query preserves distinct business clues and rejects unsafe/ambiguous input", () => {
    assert.equal(parseSupervisionQuery(new URLSearchParams("queryVersion=3&queryKind=nickname&q=阿洛&limit=5")).q, "阿洛");
    for (const query of ["q=13800138000", "view=risk", "state=PUBLISHED", "limit=51", "limit=5&limit=10", "queryKind=phone", "gameId=../x"])
        assert.throws(() => parseSupervisionQuery(new URLSearchParams(query)));
    assert.equal(parseSupervisionQuery(new URLSearchParams("queryKind=legacy&q=OLD-42")).queryKind, "legacy");
});
test("private cursor refuses the old ID cursor and a changed identity, scope or filter", () => {
    const key = { keyId: "fixture", secret: "fixture-only-private-cursor-key-000001" }, position = { at: "2026-10-03T00:00:00.000000Z", id: "account_fixture" };
    const cursor = encodeSupervisionCursor(position, "actor-session-permissions-scope-and-query", key);
    assert.deepEqual(decodeSupervisionCursor(cursor, "actor-session-permissions-scope-and-query", key), position);
    for (const token of ["account_old_cursor", cursor + "a", cursor])
        assert.throws(() => decodeSupervisionCursor(token, "other-context", key), (error: any) => error.status === 409);
    assert.throws(() => encodeSupervisionCursor(position, "binding", undefined), (error: any) => error.status === 503);
});
test("account image guard checks locked account, listing, owner, asset revision and byte hash", () => {
    const binding = parseMediaReviewBinding({ accountId: "account-fixture", accountRevision: "7", versionId: "version-fixture", assetRevision: "2", byteHash: "a".repeat(64) })!;
    const asset = { accountId: "account-fixture", ownerUserId: "owner-fixture", purpose: "ACCOUNT_DISPLAY", ownershipKind: "USER_SUPPLY", revision: "2", contentHash: "a".repeat(64) };
    const account = { revision: "7", current_version_id: "version-fixture", owner_user_id: "owner-fixture" };
    assert.doesNotThrow(() => assertMediaReviewBinding(asset, account, binding));
    for (const patch of [{ revision: "8" }, { current_version_id: "version-next" }, { owner_user_id: "owner-other" }])
        assert.throws(() => assertMediaReviewBinding(asset, { ...account, ...patch }, binding), (error: any) => error.status === 409);
    for (const patch of [{ revision: "3" }, { contentHash: "b".repeat(64) }])
        assert.throws(() => assertMediaReviewBinding({ ...asset, ...patch }, account, binding), (error: any) => error.status === 409);
    assert.throws(() => assertMediaReviewBinding({ ...asset, purpose: "ACCOUNT_EVIDENCE" }, account, binding), (error: any) => error.status === 404);
    for (const patch of [{ accountRevision: 7 }, { byteHash: "bad" }, { visibility: "PUBLIC_DISPLAY" }])
        assert.throws(() => parseMediaReviewBinding({ ...binding, ...patch }));
});
const historicalSnapshot = { schema: "legacy-listing-read-v1", resourceNo: "SOURCE-1", haffRentYuan: "1.00", goodsYuan: "2.00", depositYuan: "0.00", termDays: "1", dailyHaffBase: "10000000" };
test("historical projection stays off public visibility for an empty row and a saved row", async t => {
    t.mock.method(publishing, "readPublicListing", async () => { throw Object.assign(new Error("hidden"), { status: 404 }); });
    t.mock.method(publishing, "listingDetail", async () => ({ version: null }));
    let historicalRows: unknown[] = [];
    let historicalQueries = 0;
    const client = { query: async (sql: string, values?: unknown[]) => {
        assert.match(sql, /^\s*SELECT/);
        if (sql.includes("source_status::int")) { historicalQueries++; return { rows: historicalRows }; }
        if (sql.startsWith("SELECT a.id,")) return { rows: [{ id: fixtureAccount.id, sortAt: "2026-10-03T00:00:00.000000Z" }] };
        if (sql.includes("FROM zzsh_supply.rental_account WHERE id = ANY")) return { rows: [...batchAccounts((values?.[0] ?? []) as string[], () => null).values()] };
        return { rows: [] };
    } };
    const gate = async () => { throw new Error("no gate"); };
    const absent = await supervisionFacts(client as never, fixtureAccount, { version: null }, gate);
    assert.equal(absent.historicalRead, null);
    assert.equal(absent.publicVisible, false);
    assert.equal(historicalQueries, 1);
    historicalRows = [{ account_id: fixtureAccount.id, source_status: 3, legacy_id: "1", owner_user_id: "fixture-owner", snapshot: historicalSnapshot }];
    const candidate = await supervisionFacts(client as never, fixtureAccount, { version: null }, gate);
    assert.equal(candidate.publicVisible, false);
    assert.equal(candidate.historicalRead?.sourceStatus, 3);
    assert.equal(candidate.historicalRead?.sourceStatusPublicCandidate, true);
    assert.equal("publicRead" in (candidate.historicalRead ?? {}), false);
    historicalRows = [{ account_id: fixtureAccount.id, source_status: 4, legacy_id: "1", owner_user_id: "fixture-owner", snapshot: historicalSnapshot }];
    historicalQueries = 0;
    const page = await listSupervision(client as never, queryViewer, parseSupervisionQuery(new URLSearchParams()), gate, queryKey);
    assert.equal(historicalQueries, 1);
    assert.equal(page.items.length, 1);
    const listed = page.items[0] as { facts: { publicVisible: boolean; historicalRead: { sourceStatus: number; sourceStatusPublicCandidate: boolean } | null } };
    assert.equal(listed.facts.publicVisible, false);
    assert.equal(listed.facts.historicalRead?.sourceStatus, 4);
    assert.equal(listed.facts.historicalRead?.sourceStatusPublicCandidate, false);
    assert.equal("publicRead" in (listed.facts.historicalRead ?? {}), false);
});
test("account route lets the owner read history and stops another user first", async t => {
    const routes = require("../src/supply/publishing-routes");
    const userIdentity = require("../src/auth/user-identity");
    const security = require("../src/auth/security-core");
    const account = { ...fixtureAccount, id: "acc-1", owner_user_id: "owner-1", current_version_id: null };
    const historicalSql: string[] = [];
    const client = { query: async (sql: string) => {
        if (sql.includes("source_status::int")) {
            historicalSql.push(sql);
            return { rows: [{ source_status: 4, legacy_id: "1", owner_user_id: "owner-1", snapshot: historicalSnapshot }] };
        }
        return { rows: [], rowCount: 0 };
    } };
    let userId = "other-user";
    t.mock.method(userIdentity, "readUserContext", async () => ({ userId, sessionId: "session-1" }));
    t.mock.method(userIdentity, "assertUserContextInTransaction", async () => {});
    t.mock.method(publishing, "lockPublishingAccount", async () => account);
    t.mock.method(security, "withTransaction", async (_pool: unknown, callback: (value: typeof client) => Promise<unknown>) => callback(client));
    const options = { pool: {}, userAuth: { api: {} }, mediaStorage: {}, adminOrigin: "http://admin.example", userOrigin: "http://user.example" } as never;
    const response = () => {
        const target: { body?: unknown; headersSent: boolean; status: (code: number) => unknown; setHeader: () => unknown; json: (body: unknown) => unknown } = {
            headersSent: false,
            status() { return target; },
            setHeader() { return target; },
            json(body: unknown) { target.body = body; return target; },
        };
        return target;
    };
    const request = { method: "GET", headers: {} } as never;
    await assert.rejects(() => routes.handlePublishingRoute(request, response(), options, "req-other", "/accounts/acc-1", new URLSearchParams(), false), (error: { status?: number }) => error.status === 404);
    assert.equal(historicalSql.length, 0);
    userId = "owner-1";
    const ownerResponse = response();
    await routes.handlePublishingRoute(request, ownerResponse, options, "req-owner", "/accounts/acc-1", new URLSearchParams(), false);
    assert.equal(historicalSql.length, 1);
    const saved = (ownerResponse.body as { historicalRead?: { sourceStatus?: number; sourceStatusPublicCandidate?: boolean } }).historicalRead;
    assert.equal(saved?.sourceStatus, 4);
    assert.equal(saved?.sourceStatusPublicCandidate, false);
    assert.equal("publicRead" in (saved ?? {}), false);
});

/* ---------- API A：列表最小受权摘要 ---------- */

const summaryRow = { id: "a-1", accountId: "a-1", displayNo: "A-1", ownerId: "u-1", revision: "3", sortAt: "2026-10-03T00:00:00.000000Z", accountCreatedAt: "2026-01-02T03:04:05.000000Z", accountUpdatedAt: null, versionId: "v-1", sequence: "2", title: "100M 不包赔账号", reviewState: "PUBLISHED", versionCreatedAt: "2026-02-02T02:02:02.000000Z", ruleReleaseId: "release-1", priceVersionId: "price-1", ownerName: "阿洛", gameName: "三角洲" };
const yuan = (amount: string) => ({ currency: "CNY" as const, unit: "yuan" as const, amount, scale: 2 as const });
function summaryVersion(id: string) {
    const unit = (amount: string) => ({ currency: "CNY" as const, unit: "yuan" as const, amount, scale: 8 as const });
    const line = (itemId: string, quantity: string, itemUnit: "HAFF_BASE" | "ROUND", buyer: string) => ({ itemId, quantity, unit: itemUnit, unitQuantity: "1", pricingKind: "FIXED_UNIT" as const, buyerUnitAmount: unit(buyer), ownerUnitAmount: unit("0.10000000"), buyerAmount: yuan(buyer), ownerAmount: yuan("1.00"), platformAmount: yuan("0.10") });
    return { id, account_id: id.replace(/^version-/, ""), sequence: "2", origin: "NATIVE", review_state: "PUBLISHED", title: "100M", description: null, attributes: {}, term_option_code: "daily", pricing_option_code: "standard", rule_release_id: "release-1", content_hash: "hash-1", schema_version: 1, revision: "1", submitted_at: null, presentation: {}, payload: { schemaVersion: 1, accountId: id.replace(/^version-/, ""), gameId: "fixture-game", declaration: { title: "100M", description: null, attributes: {}, inventory: [{ itemId: "haff-unit-1", quantity: "12500000" }, { itemId: "bullets", quantity: "120" }], skins: [], entitlements: [], termOptionCode: "daily", pricingOptionCode: "standard", mediaBindings: [] }, ruleRefs: { releaseId: "release-1", priceVersionId: "price-1", termVersionId: "term", agreementVersionId: "ag", agreementDigest: "d".repeat(64), catalogRevision: "9" }, quoteValues: { schemaVersion: 1, currency: "CNY", priceVersionId: "price-1", ruleReleaseId: "release-1", mode: "SPREAD", lines: [line("haff-unit-1", "12500000", "HAFF_BASE", "200.00"), line("bullets", "120", "ROUND", "12.77")], resourceTotal: yuan("212.77"), ownerTotal: yuan("190.00"), platformFullProfit: yuan("22.77"), tenantDeposit: yuan("50.00"), publisherBailRequirement: yuan("300.00"), termSeconds: "86400", expiryDisclosures: [], unitAmountsInformational: true, roundingPolicy: "HALF_UP_CENT_V1", pricingInputs: { haffRatioSchema: null } } } };
}
function summaryHarness(viewerPermissions: string[], options: { policy?: unknown | null; proof?: unknown | null; users?: boolean } = {}) {
    const sql: string[] = [], ownerRequests: unknown[][] = [];
    const client = { query: async (text: string, values?: unknown[]) => {
        sql.push(text);
        if (text.startsWith("SELECT a.id,")) return { rows: [summaryRow, { ...summaryRow, id: "a-2", accountId: "a-2", ownerId: "u-2" }] };
        if (text.includes("FROM zzsh_supply.rental_account WHERE id = ANY")) return { rows: [...batchAccounts((values?.[0] ?? []) as string[]).values()] };
        if (text.includes("FROM zzsh_supply.listing_version WHERE id = ANY")) return { rows: ((values?.[0] ?? []) as string[]).map(summaryVersion) };
        if (text.includes("FROM zzsh_supply.game WHERE id=$1")) return { rows: [{ id: "fixture-game", code: "delta", name: "三角洲", enabled: true, current_release_id: "release-1", catalog_revision: "9" }] };
        if (text.includes("game_service_operation")) return { rows: [{ id: "svc", gameId: "fixture-game", gameCode: "delta", gameEnabled: true, enabled: true, serviceCode: "ACCOUNT_RENTAL", revision: "1" }] };
        if (text.includes("u.suspended")) return { rows: [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }] };
        if (text.includes("p.funding_policy AS policy,p.status AS status")) {
            if (options.policy === undefined) return { rows: [] };
            return { rows: [{ accountId: "a-1", status: "SEALED", policy: options.policy }] };
        }
        if (text.includes("account_guarantee_proof")) return { rows: options.proof === undefined ? [] : [options.proof] };
        if (text.includes('FROM zzsh_auth_user."user" WHERE id=ANY')) {
            if (!options.users) throw Error("owner summary must not be read without user.directory.read");
            ownerRequests.push(values ?? []);
            return { rows: [{ id: "u-1", name: "阿洛", image: "https://cdn.example/avatar.png", phone: "13800138000" }, { id: "u-2", name: "阿洛乙", image: null, phone: null }] };
        }
        return { rows: [], rowCount: 0 };
    }, } as never;
    const viewer = { ...queryViewer, access: { ...queryViewer.access, permissions: new Set(viewerPermissions) } };
    return { sql, client, viewer, ownerRequests };
}

test("list summary reports only authoritative facts and keeps every missing fact unprovided", async t => {
    t.mock.method(publishing, "readPublicListing", async () => { throw Object.assign(new Error("fixture 404"), { status: 404 }); });
    const { sql, client, viewer } = summaryHarness(["supply.review.read"]);
    const page = await listSupervision(client, viewer, parseSupervisionQuery(new URLSearchParams("queryVersion=3&limit=5")), async () => ({ publisherBail: "UNKNOWN", occupancy: "FREE", reference: null }), queryKey);
    assert.equal(page.items.length, 2);
    const item = page.items[0] as Record<string, any>;
    assert.equal(item.summary.haff.itemId, "haff-unit-1", "haff line comes from the catalog unit, not a fixed itemId");
    assert.equal(item.summary.haff.quantity, "12500000");
    assert.equal(item.summary.quote.resourceTotal.amount, "212.77", "amounts keep the interface decimal string");
    assert.ok(!JSON.stringify(item.summary).includes("212.8"), "no rounding of frozen amounts");
    assert.equal(item.summary.fullPayout, "NOT_DECLARED", "a title containing 包赔 never becomes a payout decision");
    assert.equal(item.summary.baseDeposit, null);
    assert.equal(item.summary.guarantee.requirement, null);
    assert.equal(item.summary.guarantee.requirementSource, "UNAVAILABLE", "missing policy is not 不要求");
    assert.equal(item.summary.guarantee.eligibility, "UNCONFIRMED", "gate blocker code is the only eligibility source");
    assert.equal(item.summary.guarantee.recordedProof, null);
    assert.equal(item.summary.timing.accountCreatedAt, summaryRow.accountCreatedAt);
    assert.equal(item.summary.timing.accountUpdatedAt, null, "absent update time stays absent, never the sort time");
    assert.equal(item.summary.timing.versionCreatedAt, summaryRow.versionCreatedAt);
    assert.equal(item.ownerLink.state, "DENIED");
    assert.equal("ownerSummary" in item, false, "no owner contact projection without directory read");
    assert.equal(item.summary.quote.ownerTotal, null, "internal owner amount stays outside a public quote viewer");
    assert.equal(item.summary.refs.priceVersionId, "price-1");
    // 页级补读只跑一次，不随行数增长。
    assert.equal(sql.filter(s => s.includes("account_guarantee_proof")).length, 1);
    assert.equal(sql.filter(s => s.includes("p.funding_policy AS policy,p.status AS status")).length, 1);
    assert.equal(sql.filter(s => s.includes("agreement_version") || s.includes("review_decision")).length, 0, "list does not load agreement or review history");
    assert.equal(sql.filter(s => s.includes("FROM zzsh_supply.game WHERE id=$1")).length, 1, "the page shares one game read");
});

test("list summary gates internal amounts and owner contact projection behind their own permissions", async t => {
    t.mock.method(publishing, "readPublicListing", async () => ({ source: "NATIVE_PUBLICATION" }));
    const internal = summaryHarness(["supply.review.read", "supply.quote.internal.read", "user.directory.read"], {
        policy: fundingPolicyFixture("FIXED_CENTS"),
        proof: { accountId: "a-1", id: "proof-1", versionNo: "2", ownerUserId: "u-1", priceVersionId: "price-1", policyVersion: "1", status: "SATISFIED", requiredCents: "30000", coveredCents: "30000", validUntil: "2026-12-01T00:00:00.000000Z", valid: true },
        users: true,
    });
    const fixedPolicyGate = async () => ({ publisherBail: "SATISFIED" as const, occupancy: "FREE" as const, reference: "proof-1" });
    const page = await listSupervision(internal.client, internal.viewer, parseSupervisionQuery(new URLSearchParams("queryVersion=3&limit=5")), fixedPolicyGate, queryKey);
    const first = page.items[0] as Record<string, any>, second = page.items[1] as Record<string, any>;
    assert.equal(first.summary.quote.ownerTotal.amount, "190.00", "internal quote read exposes the frozen owner amount only to that permission");
    assert.equal(first.summary.guarantee.requirement.mode, "FIXED_CENTS");
    assert.equal(first.summary.guarantee.requirement.requiredCents, "3000");
    assert.equal(first.summary.guarantee.requirementSource, "FIXED_FUNDING_POLICY", "without a credit snapshot the fixed policy is still authoritative, and says so");
    assert.equal(first.summary.guarantee.recordedProof.status, "SATISFIED", "recorded proof stays a recorded fact");
    assert.equal(first.ownerLink.state, "READY");
    assert.equal(first.ownerSummary.maskedPhone, "138****8000", "only the existing masked projection leaves the server");
    assert.equal(second.ownerSummary.maskedPhone, null);
    assert.deepEqual(internal.ownerRequests, [[['u-1','u-2']]], "the shared user reader is one batch for visible owners");
    assert.deepEqual(Object.keys(first.ownerSummary).sort(), ['image','maskedPhone','name']);
    assert.equal(second.summary.guarantee.requirement, null, "no policy row means 未提供, not 0");
    assert.equal(second.summary.guarantee.requirementSource, "UNAVAILABLE");
});

test("R1 the guarantee requirement follows the enabled mechanism, never the stale fixed policy", async t => {
    t.mock.method(publishing, "readPublicListing", async () => ({ source: "NATIVE_PUBLICATION" }));
    const waiver = fundingPolicyFixture("NOT_REQUIRED"), fixed = fundingPolicyFixture("FIXED_CENTS");
    const fixedPolicyGate: SupplyGateReader = async () => ({ publisherBail: "SATISFIED", occupancy: "FREE", reference: "proof-1" });
    const noGateAnswer: SupplyGateReader = async () => ({ publisherBail: "UNKNOWN", occupancy: "UNKNOWN", reference: null });
    const creditGate = (status: "SATISFIED" | "NOT_REQUIRED" | "REQUIRED_UNCOVERED" | "UNKNOWN", requiredCents: string | null): SupplyGateReader => async () => ({
        publisherBail: status === "NOT_REQUIRED" ? "NOT_REQUIRED" : status === "SATISFIED" ? "SATISFIED" : "PENDING",
        occupancy: "FREE",
        reference: "credit:price-1:1",
        creditGuarantee: { status, accountId: "a-1", ownerUserId: "u-1", gameId: "fixture-game", listingVersionId: "v-1", priceVersionId: "price-1", releaseId: "release-1", creditRevision: "4", coverageRevision: null, requiredCents, reference: "credit:price-1:1" },
    });
    const cases: [string, unknown, SupplyGateReader, { requirement: { mode: "FIXED_CENTS" | "NOT_REQUIRED"; requiredCents: string } | null; requirementSource: string }][] = [
        ["fixed policy still authoritative when no credit mechanism answers", fixed, fixedPolicyGate, { requirement: { mode: "FIXED_CENTS", requiredCents: "3000" }, requirementSource: "FIXED_FUNDING_POLICY" }],
        ["credit requires payment while the legacy policy says NOT_REQUIRED", waiver, creditGate("REQUIRED_UNCOVERED", "500"), { requirement: { mode: "FIXED_CENTS", requiredCents: "500" }, requirementSource: "CREDIT_GUARANTEE" }],
        ["credit waives it outright", fixed, creditGate("NOT_REQUIRED", "0"), { requirement: { mode: "NOT_REQUIRED", requiredCents: "0" }, requirementSource: "CREDIT_GUARANTEE" }],
        ["credit context unknown fails closed instead of the old policy", waiver, creditGate("UNKNOWN", null), { requirement: null, requirementSource: "UNAVAILABLE" }],
        ["no authoritative gate answer fails closed", waiver, noGateAnswer, { requirement: null, requirementSource: "UNAVAILABLE" }],
    ];
    for (const [label, policy, gate, expected] of cases) {
        await t.test(label, async () => {
            const harness = summaryHarness(["supply.review.read"], { policy });
            const page = await listSupervision(harness.client, harness.viewer, parseSupervisionQuery(new URLSearchParams("queryVersion=3&limit=5")), gate, queryKey);
            const guarantee = (page.items[0] as Record<string, any>).summary.guarantee;
            assert.deepEqual({ requirement: guarantee.requirement, requirementSource: guarantee.requirementSource }, expected);
        });
    }
    // 要求与资格是两条独立轴：信用机制给出 500 分要求时，资格仍按 gate 阻塞码单独判定。
    const strict = summaryHarness(["supply.review.read"], { policy: waiver, proof: { accountId: "a-1", id: "proof-9", versionNo: "1", ownerUserId: "u-1", priceVersionId: "price-1", policyVersion: "1", status: "NOT_REQUIRED", requiredCents: "0", coveredCents: "0", validUntil: null, valid: true } });
    const strictPage = await listSupervision(strict.client, strict.viewer, parseSupervisionQuery(new URLSearchParams("queryVersion=3&limit=5")), creditGate("REQUIRED_UNCOVERED", "500"), queryKey);
    const axes = (strictPage.items[0] as Record<string, any>).summary.guarantee;
    assert.equal(axes.requirement.requiredCents, "500");
    assert.equal(axes.eligibility, "UNCONFIRMED", "the amount comes from the credit snapshot while eligibility stays its own gate fact");
    assert.equal(axes.recordedProof.status, "NOT_REQUIRED", "a historical waiver proof record is reported as recorded material, not as today's requirement");
});

test("admin supervision keeps the old businessNo while public projections drop it", async t => {
    t.mock.method(publishing, "readPublicListing", async () => { throw Object.assign(new Error("hidden"), { status: 404 }); });
    const client = { query: async (sql: string) => {
        assert.match(sql, /^\s*SELECT/);
        if (sql.includes("legacy_supply_map")) return { rows: [{ sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", sourceId: "34418", businessNo: "OLD-42" }] };
        return { rows: [] };
    } };
    const gate: SupplyGateReader = async () => ({ occupancy: "FREE", publisherBail: "NOT_REQUIRED", reference: "fixture" });
    const facts = await supervisionFacts(client as never, fixtureAccount, { version: null }, gate);
    assert.deepEqual(facts.legacyNumbers, ["OLD-42"]);
});

test("admin supervision source SQL still reads the old resourceNo as businessNo (claim review r2)", async t => {
    t.mock.method(publishing, "readPublicListing", async () => { throw Object.assign(new Error("hidden"), { status: 404 }); });
    const seen: string[] = [];
    const client = { query: async (sql: string) => {
        seen.push(sql);
        if (sql.includes("legacy_supply_map") && /h\.snapshot->>'resourceNo' AS "businessNo"/.test(sql)) return { rows: [{ sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", sourceId: "34418", businessNo: "OLD-42" }] };
        return { rows: [] };
    } };
    const gate: SupplyGateReader = async () => ({ occupancy: "FREE", publisherBail: "NOT_REQUIRED", reference: "fixture" });
    const facts = await supervisionFacts(client as never, fixtureAccount, { version: null }, gate);
    assert.ok(seen.some(sql => /h\.snapshot->>'resourceNo' AS "businessNo"/.test(sql)), "admin source query keeps the old number");
    assert.deepEqual(facts.legacyNumbers, ["OLD-42"]);
});

/* ---------- 公共投影与页级批读 ---------- */

const detailAccount: PublishingAccount = { ...fixtureAccount, id: "account-1", owner_user_id: "owner-1", current_version_id: "version-1" };
const detailVersion = { schema_version: 1, id: "version-1", account_id: "account-1", sequence: "1", origin: "NATIVE", review_state: "PUBLISHED", title: "标题", description: null, attributes: {}, term_option_code: "", pricing_option_code: "", rule_release_id: null, content_hash: "a".repeat(64), payload: null, presentation: {}, revision: "1", submitted_at: null };
/** A client that answers the real detail reads; the game service row is the one
 *  the readiness check cannot answer without. */
function detailClient(onQuery?: (sql: string) => void) {
    return { query: async (sql: string) => {
        onQuery?.(sql);
        if (sql.includes("FROM zzsh_supply.listing_version WHERE id=$1")) return { rows: [detailVersion] };
        if (sql.includes('"game_service_operation"')) return { rows: [{ id: "fixture-service", gameCode: "delta", gameEnabled: true, enabled: true }] };
        return { rows: [] };
    } } as never;
}

test("the request-scoped public projection reads one account once", async () => {
    let versionReads = 0;
    const client = detailClient(sql => { if (sql.includes("FROM zzsh_supply.listing_version WHERE id=$1")) versionReads++; });
    const memo = publishing.publicListingMemo(client, async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: null }));
    assert.equal(await memo.read(detailAccount), null, "a version without an effective publication has no public listing");
    assert.equal(await memo.read(detailAccount), null);
    assert.equal(versionReads, 1, "the second request for the same account is served by the request's projection");
});

test("the admin detail and the supervision facts share one public projection", async () => {
    let versionReads = 0;
    const client = detailClient(sql => { if (sql.includes("FROM zzsh_supply.listing_version WHERE id=$1")) versionReads++; });
    const memo = publishing.publicListingMemo(client, async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: null }));
    const prefetch = { hasPublication: true, publicListing: (account: PublishingAccount) => memo.read(account) };
    const detail = await listingDetail(client, detailAccount, "admin", async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: null }), "admin", detailAccount, false, "RENTABLE", prefetch as never);
    assert.equal((detail.version as { id?: string } | null)?.id, "version-1");
    assert.equal(versionReads, 2, "the admin detail and its public projection read the version once each");
    await assert.rejects(() => publishing.readPublicListing(client, detailAccount, async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: null }), undefined, false, "DETAIL", undefined, prefetch as never), (error: { status?: number }) => error.status === 404);
    assert.equal(versionReads, 2, "the facts path reuses the request's projection");
});

test("the supervision page reads its accounts, versions, publication probe and legacy facts once per page", async t => {
    t.mock.method(publishing, "readPublicListing", async () => ({ source: "NATIVE_PUBLICATION" }));
    const sql: string[] = [];
    const client = { query: async (text: string, values?: unknown[]) => {
        sql.push(text);
        if (text.startsWith("SELECT a.id,")) return { rows: [summaryRow, { ...summaryRow, id: "a-2", accountId: "a-2", ownerId: "u-2" }] };
        if (text.includes("FROM zzsh_supply.rental_account WHERE id = ANY")) return { rows: [...batchAccounts((values?.[0] ?? []) as string[]).values()] };
        if (text.includes("FROM zzsh_supply.listing_version WHERE id = ANY")) return { rows: ((values?.[0] ?? []) as string[]).map(summaryVersion) };
        if (text.includes("FROM zzsh_supply.listing_version WHERE id=$1")) return { rows: [{ id: "version-moved" }] };
        if (text.includes("SELECT DISTINCT account_id FROM zzsh_supply.listing_publication")) return { rows: [{ account_id: "a-1" }] };
        if (text.includes("FROM zzsh_supply.game WHERE id=$1")) return { rows: [{ id: "fixture-game", code: "delta", name: "三角洲", enabled: true, current_release_id: "release-1", catalog_revision: "9" }] };
        if (text.includes("game_service_operation")) return { rows: [{ id: "svc", gameId: "fixture-game", gameCode: "delta", gameEnabled: true, enabled: true, serviceCode: "ACCOUNT_RENTAL", revision: "1" }] };
        if (text.includes("u.suspended")) return { rows: [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }] };
        return { rows: [], rowCount: 0 };
    } } as never;
    const viewer = { ...queryViewer, access: { ...queryViewer.access, permissions: new Set(["supply.review.read"]) } };
    const page = await listSupervision(client, viewer, parseSupervisionQuery(new URLSearchParams("queryVersion=3&limit=5")), async () => ({ publisherBail: "UNKNOWN", occupancy: "FREE", reference: null }), queryKey);
    assert.equal(page.items.length, 2);
    assert.equal(sql.filter(s => s.includes("FROM zzsh_supply.rental_account WHERE id = ANY")).length, 1, "the accounts are one batch");
    assert.equal(sql.filter(s => s.includes("FROM zzsh_supply.listing_version WHERE id = ANY")).length, 1, "the current versions are one batch");
    assert.equal(sql.filter(s => s.includes("SELECT DISTINCT account_id FROM zzsh_supply.listing_publication")).length, 1, "the publication probe is one batch");
    assert.equal(sql.filter(s => s.includes("legacy_supply_map")).length, 1, "the legacy source rows are one batch");
    assert.equal(sql.filter(s => s.includes("legacy_order_read_snapshot")).length, 1, "the old account numbers are one batch");
    assert.equal(sql.filter(s => s.includes("source_status::int")).length, 1, "the historical reads are one batch");
    assert.equal(sql.filter(s => s.includes("FROM zzsh_supply.listing_version WHERE id=$1")).length, 0, "the list keeps the batched version and does not re-read a moved current");
    assert.equal(sql.filter(s => s.includes("agreement_version") || s.includes("review_decision") || s.includes("draftSkin")).length, 0, "complete detail text stays off the list");
    assert.equal(sql.filter(s => s.includes("FROM zzsh_supply.game WHERE id=$1")).length, 1, "the page shares one game read");
});

test("saved unquoted draft stock is one page read and keeps 0, unknown and undeclared apart", async t => {
    t.mock.method(publishing, "readPublicListing", async () => ({ source: "NATIVE_PUBLICATION" }));
    const stock = new Map<string, string | null>([["version-a-9", "9000000"], ["version-a-0", "0"], ["version-a-u", null]]);
    let inventoryReads = 0;
    const ids = ["a-9", "a-0", "a-u", "a-n"];
    const client = { query: async (text: string, values?: unknown[]) => {
        if (text.startsWith("SELECT a.id,")) return { rows: ids.map(id => ({ ...summaryRow, id, accountId: id, ownerId: "u-1", versionId: `version-${id}` })) };
        if (text.includes("FROM zzsh_supply.rental_account WHERE id = ANY")) return { rows: [...batchAccounts((values?.[0] ?? []) as string[]).values()] };
        if (text.includes("FROM zzsh_supply.listing_version WHERE id = ANY")) return { rows: ((values?.[0] ?? []) as string[]).map(id => ({ ...summaryVersion(id), payload: null, content_hash: null, rule_release_id: null, review_state: "DRAFT", origin: "NATIVE" })) };
        if (text.includes("/* page-inventory */")) {
            inventoryReads++;
            const wanted = (values?.[0] ?? []) as string[];
            return { rows: wanted.flatMap(id => stock.has(id) ? [{ versionId: id, itemId: "haff-a", quantity: stock.get(id), unit: "HAFF_BASE", code: "haff", name: "哈夫币" }] : []) };
        }
        if (text.includes("FROM zzsh_supply.game WHERE id=$1")) return { rows: [{ id: "fixture-game", code: "delta", name: "三角洲", enabled: true, current_release_id: "release-1", catalog_revision: "9" }] };
        if (text.includes("game_service_operation")) return { rows: [{ id: "svc", gameId: "fixture-game", gameCode: "delta", gameEnabled: true, enabled: true, serviceCode: "ACCOUNT_RENTAL", revision: "1" }] };
        if (text.includes("u.suspended")) return { rows: [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }] };
        return { rows: [], rowCount: 0 };
    } } as never;
    const viewer = { ...queryViewer, access: { ...queryViewer.access, permissions: new Set(["supply.review.read"]) } };
    const page = await listSupervision(client, viewer, parseSupervisionQuery(new URLSearchParams("queryVersion=3&limit=5")), async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "fixture" }), queryKey);
    const haff = (id: string) => (page.items.find(item => (item as { summary?: { versionId?: string } }).summary?.versionId === id) as { summary?: { haff?: { quantity?: string | null } | null; quote?: unknown } } | undefined)?.summary;
    assert.equal(inventoryReads, 1, "unfrozen stock is one page query");
    assert.equal(haff("version-a-9")?.haff?.quantity, "9000000");
    assert.equal(haff("version-a-0")?.haff?.quantity, "0");
    assert.equal(haff("version-a-u")?.haff?.quantity, null);
    assert.equal(haff("version-a-n")?.haff ?? null, null);
    assert.equal(haff("version-a-9")?.quote, null);
});

test("the batch read keeps the first-read version tuple when current moves twice", async t => {
    let versionReads = 0, movedReads = 0;
    t.mock.method(publishing, "readPublicListing", async () => ({ source: "NATIVE_PUBLICATION" }));
    const client = { query: async (text: string, values?: unknown[]) => {
        if (text.startsWith("SELECT a.id,")) return { rows: [summaryRow] };
        if (text.includes("FROM zzsh_supply.rental_account WHERE id = ANY")) return { rows: [...batchAccounts((values?.[0] ?? []) as string[]).values()] };
        if (text.includes("FROM zzsh_supply.listing_version WHERE id = ANY")) { versionReads++; return { rows: ((values?.[0] ?? []) as string[]).map(summaryVersion) }; }
        if (text.includes("FROM zzsh_supply.listing_version WHERE id=$1")) { movedReads++; return { rows: [{ id: "version-moved" }] }; }
        if (text.includes("FROM zzsh_supply.game WHERE id=$1")) return { rows: [{ id: "fixture-game", code: "delta", name: "三角洲", enabled: true, current_release_id: "release-1", catalog_revision: "9" }] };
        if (text.includes("game_service_operation")) return { rows: [{ id: "svc", gameId: "fixture-game", gameCode: "delta", gameEnabled: true, enabled: true, serviceCode: "ACCOUNT_RENTAL", revision: "1" }] };
        if (text.includes("u.suspended")) return { rows: [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }] };
        return { rows: [], rowCount: 0 };
    } } as never;
    const viewer = { ...queryViewer, access: { ...queryViewer.access, permissions: new Set(["supply.review.read"]) } };
    const page = await listSupervision(client, viewer, parseSupervisionQuery(new URLSearchParams("queryVersion=3&limit=5")), async () => ({ publisherBail: "UNKNOWN", occupancy: "FREE", reference: null }), queryKey);
    assert.equal(versionReads, 1, "the current version is read once for the page");
    assert.equal(movedReads, 0, "a later current version is not substituted into the page");
    assert.equal((page.items[0] as { summary?: { haff?: { quantity?: string } } }).summary?.haff?.quantity, "12500000");
});

test("the supervision detail reads one public projection for the viewed, current and restricted versions", async () => {
    let publicProjections = 0;
    const account: PublishingAccount = { ...detailAccount, current_version_id: "version-1" };
    const oldVersion = { ...detailVersion, id: "version-old", sequence: "1" };
    const client = { query: async (sql: string, values?: unknown[]) => {
        // Only the public projection runs this join; it is the public listing's own probe.
        if (sql.includes("JOIN zzsh_supply.listing_publication p ON p.version_id=v.id")) publicProjections++;
        if (sql.startsWith("SELECT 1 FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2")) return { rows: [{ "1": 1 }], rowCount: 1 };
        if (sql.includes("FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2")) return { rows: [values?.[0] === "version-old" ? oldVersion : detailVersion] };
        if (sql.includes("FROM zzsh_supply.listing_version WHERE id=$1")) return { rows: [values?.[0] === "version-old" ? oldVersion : detailVersion] };
        if (sql.includes('"game_service_operation"')) return { rows: [{ id: "fixture-service", gameCode: "delta", gameEnabled: true, enabled: true }] };
        if (sql.includes("FROM zzsh_supply.listing_version WHERE account_id=$1 ORDER BY sequence DESC")) return { rows: [{ id: "version-1", sequence: "2" }, { id: "version-old", sequence: "1" }] };
        return { rows: [] };
    } } as never;
    const viewer = { ...queryViewer, access: { ...queryViewer.access, permissions: new Set(["supply.review.read"]) } };
    const data = await readSupervision(client, account, viewer, async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "fixture" }), "version-old");
    assert.equal(data.supervision.historical, true);
    assert.equal(data.supervision.previousVersion, null, "the last version has no previous one");
    assert.equal(publicProjections, 1, "the viewed, current and restricted versions share one public projection");
});


test("a DETAIL memo cannot satisfy a RENTABLE or strict public read", async () => {
    let memoReads = 0;
    const detailOnly = { availability: "OFFLINE", canCreateOrder: false };
    const prefetch = { version: null, hasPublication: true, publicListing: async () => { memoReads++; return detailOnly; } };
    const client = { query: async () => ({ rows: [], rowCount: 0 }) } as never;
    const gate: SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: null });
    assert.equal(await publishing.readPublicListing(client, detailAccount, gate, undefined, false, "DETAIL", undefined, prefetch), detailOnly);
    await assert.rejects(() => publishing.readPublicListing(client, detailAccount, gate, undefined, false, "RENTABLE", undefined, prefetch), (error: { status?: number }) => error.status === 404);
    await assert.rejects(() => publishing.readPublicListing(client, detailAccount, gate, undefined, true, "DETAIL", undefined, prefetch), (error: { status?: number }) => error.status === 404);
    assert.equal(memoReads, 1, "only the non-strict DETAIL read may reuse the DETAIL projection");
});
