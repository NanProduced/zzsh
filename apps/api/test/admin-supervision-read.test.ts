import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSupervisionQuery, encodeSupervisionCursor, decodeSupervisionCursor, supervisionFacts } from "../src/supply/admin-supervision-read";
import { listingDetail, publicationBlockers, type PublishingAccount, type SupplyGateReader } from "../src/supply/publishing";
import { parseMediaReviewBinding, assertMediaReviewBinding } from "../src/supply/media";

const publishing = require("../src/supply/publishing");
const fixtureAccount: PublishingAccount = { id: "fixture-account", owner_user_id: "fixture-owner", game_id: "fixture-game", current_version_id: null, owner_paused: false, staff_restricted: false, restriction_reason: null, legacy_hold: "NONE", lifecycle: "ACTIVE", revision: "1", display_no: null };
const fixtureClient = { query: async (sql: string) => {
    assert.match(sql, /^\s*SELECT/, "occupancy projection remains read-only");
    return { rows: sql.includes('"game_service_operation"') ? [{ id: "fixture-service", gameCode: "delta", gameEnabled: true, enabled: true }] : [] };
} } as never;

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
