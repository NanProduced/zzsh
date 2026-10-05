import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSupervisionQuery, encodeSupervisionCursor, decodeSupervisionCursor, supervisionFacts, listSupervision } from "../src/supply/admin-supervision-read";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { listingDetail, publicationBlockers, type PublishingAccount, type SupplyGateReader } from "../src/supply/publishing";
import { parseMediaReviewBinding, assertMediaReviewBinding } from "../src/supply/media";

const publishing = require("../src/supply/publishing");
const fixtureAccount: PublishingAccount = { id: "fixture-account", owner_user_id: "fixture-owner", game_id: "fixture-game", current_version_id: null, owner_paused: false, staff_restricted: false, restriction_reason: null, legacy_hold: "NONE", lifecycle: "ACTIVE", revision: "1", display_no: null };
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
        const prefix = `WITH fixture_accounts(id,owner_user_id,game_id,current_version_id,created_at,staff_restricted,owner_paused) AS (VALUES
          ('a','u-a','game-1','v-a','2026-10-03T00:00:03Z'::timestamptz,true,false),
          ('b','u-b','game-1','v-b','2026-10-03T00:00:02Z'::timestamptz,false,false),
          ('c','u-c','game-2','v-c','2026-10-03T00:00:01Z'::timestamptz,true,false)),
          fixture_users(id,name) AS (VALUES ('u-a','阿洛甲'),('u-b','阿洛乙'),('u-c',$5::text)),
          fixture_games(id,name) AS (VALUES ('game-1','一'),('game-2','二')),
          fixture_versions(id,sequence,title,review_state,created_at) AS (VALUES ('v-a',1,'甲','DRAFT',null::timestamptz),('v-b',1,'乙','DRAFT',null::timestamptz),('v-c',1,'丙','DRAFT',null::timestamptz)),
          fixture_scope(admin_user_id,game_id) AS (VALUES ('fixture-admin','game-1')) `;
        for (const [q, expected] of [["阿洛甲", ["a"]], ["阿洛", ["a", "b"]], ["no-match", []], ["%", ["c"]], ["_", ["c"]], ["\\", ["c"]], ["%_\\", ["c"]]] as const) {
            await t.test("SQL nickname " + JSON.stringify(q), async () => {
                const built = await captureListQuery(new URLSearchParams({ queryKind: "nickname", q }));
                assert.equal(built.values.length, 4);
                const sql = built.sql.replaceAll("zzsh_supply.rental_account", "fixture_accounts").replaceAll('zzsh_auth_user."user"', "fixture_users").replaceAll("zzsh_supply.game", "fixture_games").replaceAll("zzsh_supply.listing_version", "fixture_versions").replaceAll("zzsh_supply.admin_supply_scope", "fixture_scope");
                assert.deepEqual((await c.query(prefix + sql, [...built.values, "百分%_\\用户"])).rows.map(r => r.id), expected);
            });
        }
        await t.test("SQL nickname combined game/restriction and real data query", async () => {
            const built = await captureListQuery(new URLSearchParams({ queryKind: "nickname", q: "阿洛", gameId: "game-1", view: "restricted" }));
            const sql = built.sql.replaceAll("zzsh_supply.rental_account", "fixture_accounts").replaceAll('zzsh_auth_user."user"', "fixture_users").replaceAll("zzsh_supply.game", "fixture_games").replaceAll("zzsh_supply.listing_version", "fixture_versions").replaceAll("zzsh_supply.admin_supply_scope", "fixture_scope");
            const combinedPrefix = prefix.replace("$5::text", "$6::text");
            assert.deepEqual((await c.query(combinedPrefix + sql, [...built.values, "百分%_\\用户"])).rows.map(r => r.id), ["a"]);
            const rows = (await c.query(built.sql, built.values)).rows;
            assert.ok(Array.isArray(rows));
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
