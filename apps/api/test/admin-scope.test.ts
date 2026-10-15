import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  ADMIN_GAME_SCOPE_MODE,
  assertGameScopeDelegable,
  assertGameScopeUsable,
  effectiveGameScopeChange,
  gameScopeSignature,
  gameScopeSql,
  isAllGamesScope,
  parseAdminGameScopeInput,
  publicGameScope,
  readAdminGameScope,
  scopeAllowsGame,
  scopeIsEmpty,
  writeAdminGameScope,
  type AdminGameScope,
} from "../src/auth/admin-scope";
import { listJoinedOrderTeams } from "../src/im/order-team-access";
import { getAdminReadOrder } from "../src/order/admin-order-read";
import { listAdminMediaReviews } from "../src/supply/media";

const allGames: AdminGameScope = { mode: ADMIN_GAME_SCOPE_MODE.ALL_GAMES, gameIds: [] };
const selectedDelta: AdminGameScope = { mode: ADMIN_GAME_SCOPE_MODE.SELECTED_GAMES, gameIds: ["delta"] };
const selectedEmpty: AdminGameScope = { mode: ADMIN_GAME_SCOPE_MODE.SELECTED_GAMES, gameIds: [] };

/** Stateful fake for the account mode + selected rows; not PostgreSQL evidence. */
class ScopeStore {
  mode: "ALL_GAMES" | "SELECTED_GAMES" = "SELECTED_GAMES";
  constructor(readonly rows: Set<string> = new Set()) {}
  async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.startsWith('SELECT s."game_scope_mode"')) return { rows: [{ mode: this.mode, gameIds: [...this.rows].sort() }], rowCount: 1 };
    if (sql.startsWith('UPDATE "zzsh_iam"."admin_security" SET "game_scope_mode"')) { this.mode = String(values[1]) as ScopeStore["mode"]; return { rows: [], rowCount: 1 }; }
    if (sql.startsWith('DELETE FROM "zzsh_supply"."admin_supply_scope"')) { this.rows.clear(); return { rows: [], rowCount: 0 }; }
    if (sql.startsWith('INSERT INTO "zzsh_supply"."admin_supply_scope"')) { this.rows.add(String(values[1])); return { rows: [], rowCount: 1 }; }
    throw new Error(`Unexpected scope store query: ${sql}`);
  }
}

/** Admin context fake for collection entries; records the business SQL it answered. */
class ScopeCollectionClient {
  isBoss = false;
  mode: "ALL_GAMES" | "SELECTED_GAMES" = "SELECTED_GAMES";
  gameIds: string[] = [];
  listRows: unknown[] = [];
  bindingRows: unknown[] = [];
  listSql = "";
  bindingSql = "";
  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes('"zzsh_auth_admin"."session"')) return { rows: [{ locked: false, twoFactorEnabled: true }], rowCount: 1 };
    if (sql.startsWith('SELECT "status", "is_boss"')) return { rows: [{ status: "ACTIVE", isBoss: this.isBoss, passwordChangeRequired: false }], rowCount: 1 };
    if (sql.includes("WITH role_permissions")) return { rows: [{ permissionCode: "im.support.read" }], rowCount: 1 };
    if (sql.startsWith('SELECT s."game_scope_mode"')) return { rows: [{ mode: this.mode, gameIds: this.gameIds }], rowCount: 1 };
    if (sql.startsWith('SELECT o."assetId", o."objectType", o."current"')) {
      this.bindingSql = sql;
      return { rows: this.bindingRows, rowCount: this.bindingRows.length };
    }
    if (sql.includes("FROM zzsh_order.im_order_member mm") || sql.includes('FROM "zzsh_supply"."media_asset" a')) {
      this.listSql = sql;
      return { rows: this.listRows, rowCount: this.listRows.length };
    }
    throw new Error(`Unexpected collection query: ${sql}`);
  }
}

const collectionActor = { realm: "admin" as const, userId: "admin-fixture", sessionId: "session-fixture" };

test("all_games follows every game; selected_games is explicit; Boss bypasses", () => {
  assert.equal(scopeAllowsGame(allGames, false, "any-new-game"), true);
  assert.equal(scopeAllowsGame(selectedDelta, false, "delta"), true);
  assert.equal(scopeAllowsGame(selectedDelta, false, "other"), false);
  assert.equal(scopeAllowsGame(selectedEmpty, false, "delta"), false);
  assert.equal(scopeAllowsGame(selectedEmpty, true, "delta"), true, "Boss always sees all games");
  assert.equal(scopeIsEmpty(selectedEmpty, false), true);
  assert.equal(scopeIsEmpty(allGames, false), false);
  assert.equal(isAllGamesScope(allGames), true);
});

test("no business scope is distinguishable from an empty business list", () => {
  assert.doesNotThrow(() => assertGameScopeUsable(allGames, false));
  assert.doesNotThrow(() => assertGameScopeUsable(selectedDelta, false));
  assert.doesNotThrow(() => assertGameScopeUsable(selectedEmpty, true), "Boss bypasses scope");
  assert.throws(() => assertGameScopeUsable(selectedEmpty, false), (error: { status?: number; code?: string }) => error.status === 403 && error.code === "NO_GAME_SCOPE");
});

test("scope signature invalidates cursors when the mode or assigned games change", () => {
  assert.deepEqual(gameScopeSignature(allGames), ["*"]);
  assert.deepEqual(gameScopeSignature(selectedDelta), ["delta"]);
  assert.notDeepEqual(gameScopeSignature(allGames), gameScopeSignature(selectedEmpty));
});

test("the shared SQL judgment reuses caller parameters and includes the account mode branch", () => {
  const sql = gameScopeSql("x.game_id", "$2", "$1");
  assert.ok(sql.includes(`"zzsh_iam"."admin_security"`));
  assert.ok(sql.includes(`"game_scope_mode" = 'ALL_GAMES'`));
  assert.ok(sql.includes(`"zzsh_supply"."admin_supply_scope"`));
  assert.ok(sql.includes(`"game_id" = x.game_id`));
  assert.deepEqual([...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => match[1]))].sort(), ["1", "2"]);
});

test("scope input parsing distinguishes explicit sets from reactivation", () => {
  assert.deepEqual(parseAdminGameScopeInput({ mode: "ALL_GAMES", gameIds: [] }), { ...allGames, replaceSelected: false });
  assert.deepEqual(parseAdminGameScopeInput({ mode: "SELECTED_GAMES", gameIds: ["delta"] }), { ...selectedDelta, replaceSelected: true });
  assert.deepEqual(parseAdminGameScopeInput({ mode: "SELECTED_GAMES" }), { ...selectedEmpty, replaceSelected: false }, "omitted games reactivate the stored selected set");
  assert.deepEqual(parseAdminGameScopeInput({ mode: "SELECTED_GAMES", gameIds: [] }), { ...selectedEmpty, replaceSelected: true }, "an explicit empty list is the no-scope state");
  for (const body of [
    { mode: "SOMETHING", gameIds: [] },
    { mode: "ALL_GAMES", gameIds: ["delta"] },
    { mode: "SELECTED_GAMES", gameIds: ["delta", "delta"] },
    { mode: "SELECTED_GAMES", gameIds: ["../delta"] },
    { mode: "SELECTED_GAMES", gameIds: ["delta", 1] },
  ]) assert.throws(() => parseAdminGameScopeInput(body), (error: { status?: number }) => error.status === 400);
});

test("effective scope resolves reactivation and replacement", () => {
  const before: AdminGameScope = { mode: "SELECTED_GAMES", gameIds: ["a", "b"] };
  assert.deepEqual(effectiveGameScopeChange(before, parseAdminGameScopeInput({ mode: "ALL_GAMES" })), { mode: "ALL_GAMES", gameIds: ["a", "b"] });
  assert.deepEqual(effectiveGameScopeChange(before, parseAdminGameScopeInput({ mode: "SELECTED_GAMES" })), { mode: "SELECTED_GAMES", gameIds: ["a", "b"] });
  assert.deepEqual(effectiveGameScopeChange(before, parseAdminGameScopeInput({ mode: "SELECTED_GAMES", gameIds: ["c"] })), { mode: "SELECTED_GAMES", gameIds: ["c"] });
});

test("public projection hides the stored set while ALL_GAMES is active", () => {
  assert.deepEqual(publicGameScope({ mode: "ALL_GAMES", gameIds: ["a", "b"] }), { mode: "ALL_GAMES", gameIds: [] });
  assert.deepEqual(publicGameScope({ mode: "SELECTED_GAMES", gameIds: ["a", "b"] }), { mode: "SELECTED_GAMES", gameIds: ["a", "b"] });
});

test("ALL_GAMES keeps the stored selected set; an explicit selected set replaces it", async () => {
  const store = new ScopeStore(new Set(["a", "b"]));
  await writeAdminGameScope(store as never, "admin-x", parseAdminGameScopeInput({ mode: "ALL_GAMES" }), "actor");
  assert.equal(store.mode, "ALL_GAMES");
  assert.deepEqual([...store.rows].sort(), ["a", "b"], "switching to all games must not delete the historical set");
  assert.deepEqual(await readAdminGameScope(store as never, "admin-x"), { mode: "ALL_GAMES", gameIds: ["a", "b"] });
  assert.deepEqual(publicGameScope(await readAdminGameScope(store as never, "admin-x")), { mode: "ALL_GAMES", gameIds: [] });

  await writeAdminGameScope(store as never, "admin-x", parseAdminGameScopeInput({ mode: "SELECTED_GAMES" }), "actor");
  assert.deepEqual(await readAdminGameScope(store as never, "admin-x"), { mode: "SELECTED_GAMES", gameIds: ["a", "b"] }, "switching back restores A and B");

  await writeAdminGameScope(store as never, "admin-x", parseAdminGameScopeInput({ mode: "SELECTED_GAMES", gameIds: ["c"] }), "actor");
  assert.deepEqual([...store.rows], ["c"], "an explicit set replaces the stored games");
  await writeAdminGameScope(store as never, "admin-x", parseAdminGameScopeInput({ mode: "SELECTED_GAMES", gameIds: [] }), "actor");
  assert.deepEqual([...store.rows], [], "an explicit empty set is the no-scope state");
});

test("scope delegation mirrors permission delegation: no widening beyond the actor scope", () => {
  assert.doesNotThrow(() => assertGameScopeDelegable(selectedDelta, false, { mode: "SELECTED_GAMES", gameIds: ["delta"] }));
  assert.throws(() => assertGameScopeDelegable(selectedEmpty, false, selectedDelta), (error: { status?: number }) => error.status === 403);
  assert.throws(() => assertGameScopeDelegable(selectedDelta, false, { mode: "ALL_GAMES", gameIds: [] }), (error: { status?: number }) => error.status === 403);
  assert.throws(() => assertGameScopeDelegable(selectedDelta, false, { mode: "SELECTED_GAMES", gameIds: ["other"] }), (error: { status?: number }) => error.status === 403);
  assert.doesNotThrow(() => assertGameScopeDelegable(allGames, false, { mode: "ALL_GAMES", gameIds: [] }), "all_games actor may delegate all_games");
  assert.doesNotThrow(() => assertGameScopeDelegable(selectedEmpty, true, { mode: "ALL_GAMES", gameIds: [] }), "Boss delegates anything");
});

test("scope read maps the account mode and stored rows without inventing a scope", async () => {
  const allGamesExecutor = { query: async () => ({ rows: [{ mode: "ALL_GAMES", gameIds: [] }] }) } as unknown as Pool;
  assert.deepEqual(await readAdminGameScope(allGamesExecutor, "admin-a"), allGames);
  const selectedExecutor = { query: async () => ({ rows: [{ mode: "SELECTED_GAMES", gameIds: ["delta"] }] }) } as unknown as Pool;
  assert.deepEqual(await readAdminGameScope(selectedExecutor, "admin-b"), selectedDelta);
  const missingExecutor = { query: async () => ({ rows: [] }) } as unknown as Pool;
  assert.deepEqual(await readAdminGameScope(missingExecutor, "admin-missing"), selectedEmpty);
});

test("collection entries return NO_GAME_SCOPE for an explicitly empty selected scope", async () => {
  const empty = new ScopeCollectionClient();
  await assert.rejects(
    listJoinedOrderTeams(empty as unknown as PoolClient, collectionActor, null, 20),
    (error: { status?: number; code?: string }) => error.status === 403 && error.code === "NO_GAME_SCOPE",
  );
  await assert.rejects(
    listAdminMediaReviews(empty as unknown as PoolClient, { adminId: "admin-fixture", isBoss: false, state: "PENDING", ownershipKind: null, cursor: null, limit: 20 }),
    (error: { status?: number; code?: string }) => error.status === 403 && error.code === "NO_GAME_SCOPE",
  );
});

test("a scoped collection without a matching game returns an empty page, not an error", async () => {
  const scoped = new ScopeCollectionClient();
  scoped.gameIds = ["delta"];
  const teams = await listJoinedOrderTeams(scoped as unknown as PoolClient, collectionActor, null, 20);
  assert.deepEqual(teams.items, []);
  const media = await listAdminMediaReviews(scoped as unknown as PoolClient, { adminId: "admin-fixture", isBoss: false, state: "PENDING", ownershipKind: null, cursor: null, limit: 20 });
  assert.deepEqual(media.items, []);
  assert.ok(scoped.listSql.includes("admin_supply_scope"), "non-Boss collection SQL keeps the shared scope predicate");
  assert.equal(scoped.bindingSql, "", "an empty page reads no bindings at all");
});

test("media queue projects technical facts and scope-filtered binding counts split by currency", async () => {
  const scoped = new ScopeCollectionClient();
  scoped.gameIds = ["delta"];
  scoped.listRows = [
    { id: "row-1", technicalState: "READY", technicalCheckedAt: null, revision: "4", createdAt: "2026-10-03T00:00:00.000Z" },
    { id: "row-2", technicalState: "UNKNOWN", technicalCheckedAt: null, revision: "1", createdAt: "2026-10-02T00:00:00.000Z" },
  ];
  scoped.bindingRows = [
    { assetId: "row-1", objectType: "listing_version", current: true },
    { assetId: "row-1", objectType: "listing_version", current: false },
    { assetId: "row-1", objectType: "listing_version", current: false },
    { assetId: "row-1", objectType: "firearm", current: true },
  ];
  const media = await listAdminMediaReviews(scoped as unknown as PoolClient, { adminId: "admin-fixture", isBoss: false, state: "PENDING", ownershipKind: null, cursor: null, limit: 20 });
  assert.ok(scoped.listSql.includes('"technical_state" AS "technicalState"'), "technical state comes from the stored column, not the browser");
  assert.ok(scoped.listSql.includes('"technical_checked_at" AS "technicalCheckedAt"'));
  assert.ok(scoped.listSql.includes('"revision"::text AS "revision"'));
  assert.equal(scoped.bindingSql.includes("admin_supply_scope"), true, "binding counts reuse the same game scope predicate");
  const first = media.items[0] as Record<string, unknown>;
  assert.deepEqual((first.binding as { current: Record<string, number> }).current, { listing_version: 1, firearm: 1 });
  assert.deepEqual((first.binding as { historical: Record<string, number> }).historical, { listing_version: 2 }, "current and historical version references stay distinct");
  const second = media.items[1] as Record<string, unknown>;
  assert.deepEqual(second.binding, { state: "KNOWN", current: {}, historical: {} }, "a readable page with no binding row is an explicit empty count, not a missing field");
  assert.equal(second.technicalState, "UNKNOWN");
  const boss = new ScopeCollectionClient();
  boss.isBoss = true;
  boss.listRows = [{ id: "row-1", technicalState: "UNKNOWN", technicalCheckedAt: null, revision: "1", createdAt: "2026-10-03T00:00:00.000Z" }];
  boss.bindingRows = [{ assetId: "row-1", objectType: "game", current: true }];
  const bossPage = await listAdminMediaReviews(boss as unknown as PoolClient, { adminId: "admin-fixture", isBoss: true, state: "PENDING", ownershipKind: null, cursor: null, limit: 20 });
  assert.equal(boss.bindingSql.includes("admin_supply_scope"), false, "Boss binding counts carry no extra scope predicate");
  assert.deepEqual((bossPage.items[0] as Record<string, any>).binding.current, { game: 1 });
});

test("Boss bypasses the scope predicate on collection entries", async () => {
  const boss = new ScopeCollectionClient();
  boss.isBoss = true;
  boss.gameIds = [];
  boss.listRows = [{ id: "row-1" }];
  const media = await listAdminMediaReviews(boss as unknown as PoolClient, { adminId: "admin-fixture", isBoss: true, state: "PENDING", ownershipKind: null, cursor: null, limit: 20 });
  assert.equal(media.items.length, 1);
  assert.equal(boss.listSql.includes("admin_supply_scope"), false, "Boss collection SQL carries no scope predicate");
});

test("object reads stay 404 when the scoped row is absent (out-of-scope object)", async () => {
  const missing = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  await assert.rejects(
    getAdminReadOrder(missing, { adminId: "admin-fixture", isBoss: false, internalQuote: false, authorizationKey: "fixture" }, "order-missing"),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "NOT_FOUND",
  );
});
