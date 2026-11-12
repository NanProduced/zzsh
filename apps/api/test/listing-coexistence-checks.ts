import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TestContext } from "node:test";
import { withTransaction } from "../src/auth/security-core";
import { recordLegacyReadSnapshot } from "../src/supply/legacy-listing-read";
import { recordLegacyObservation } from "../src/supply/legacy-observation";

type Jar = { header: () => string; update?: (r: Response) => void };

export async function runListingCoexistenceChecks(o: {
  testContext: TestContext;
  base: string;
  userOrigin: string;
  adminOrigin: string;
  gameId: string;
  itemId: string;
  user: Jar;
  boss: Jar;
  bossId: string;
  pool: Pool;
  maintenance: Pool;
  publishedIds: string[];
}): Promise<void> {
  const call = async (path: string, body?: unknown, jar: Jar = o.user, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(o.base + path, {
      method,
      headers: {
        origin: path.includes("/admin/") ? o.adminOrigin : o.userOrigin,
        cookie: jar.header(),
        ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": `coex_${randomUUID()}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    jar.update?.(response);
    return { status: response.status, body: await response.json() };
  };
  const ok = async (path: string, body?: unknown, jar: Jar = o.user, method?: string) => {
    const result = await call(path, body, jar, method);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const publicRoot = `/api/v1/supply/games/${o.gameId}`;
  const adminRoot = `/api/bff/admin/supply/games/${o.gameId}`;
  const list = (query = "") => ok(`/api/v1/supply/listings?queryVersion=2&gameId=${o.gameId}${query}`);

  await o.testContext.test("migrated Delta snapshots stay historical while native listings remain visible", async () => {
    const config = {
      schemaVersion: 1,
      fields: [
        { key: "safeBoxCodes", operator: "ANY", label: "安全箱", enabled: true, order: 0, options: [
          { value: "box-a", label: "安全箱 A" },
        ] },
        { key: "vitality", operator: "MIN", label: "体力", enabled: true, order: 1, levels: [6, 7] },
      ],
      sorts: [
        { key: "latest", label: "最新发布", enabled: true, order: 0 },
        { key: "resourceTotal", label: "资源费用", enabled: true, order: 1 },
      ],
    };

    const takeoverId = o.publishedIds[0]!;
    const nativePublished = (await o.pool.query(`SELECT to_char(pub.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS p FROM zzsh_supply.listing_publication pub WHERE pub.account_id=$1 ORDER BY pub.published_at LIMIT 1`, [takeoverId])).rows[0].p as string;
    const actor = { id: o.bossId, sessionId: "coexistence-fixture", requestId: `req_${randomUUID().replaceAll("-", "")}` };
    // The public display guard binds legacy evidence to the reviewed preflight batch form.
    const source = { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", evidenceRef: "legacy-migration-preflight-20261030:la_rental_accounts:1" };

    const legacyOwnerId = (await o.pool.query<{ ownerUserId: string }>(`SELECT owner_user_id AS "ownerUserId" FROM zzsh_supply.rental_account WHERE id=$1`, [o.publishedIds[0]])).rows[0]!.ownerUserId;
    const makeLegacy = async (title: string, legacyId: string, sourceUpdatedAt: string, safeBoxCode = "box-a") => {
      // Imported rows exist before any native draft or number assignment; the public
      // number trigger is immutable, so a legacy account must start without one.
      const accountId = `account_${randomUUID().replaceAll("-", "")}`;
      await o.maintenance.query(`INSERT INTO zzsh_supply.rental_account (id,owner_user_id,game_id) VALUES ($1,$2,$3)`, [accountId, legacyOwnerId, o.gameId]);
      const sourceDigest = createHash("sha256").update(`${legacyId}:${title}`).digest("hex");
      const observationVersionId = await withTransaction(o.pool, (client) =>
        recordLegacyObservation(client, accountId, {
          ...source,
          legacyId,
          sourceDigest,
          inventory: [{ itemId: o.itemId, quantity: "60000000" }],
          declaration: {
            title,
            description: "legacy coexistence fixture",
            attributes: { safe_box_code: safeBoxCode, vit_level: 6, bear_level: 6 },
            skins: [],
            entitlements: [],
            mediaBindings: [],
            termOptionCode: "daily-10m",
            pricingOptionCode: "standard",
          },
        }, actor),
      );
      await o.maintenance.query(`UPDATE zzsh_supply.rental_account SET legacy_hold='NONE' WHERE id=$1`, [accountId]);
      await withTransaction(o.pool, (client) =>
        recordLegacyReadSnapshot(client, accountId, {
          ...source,
          observationVersionId,
          legacyId,
          sourceDigest,
          sourceStatus: 3,
          sourceDeleted: false,
          sourceUpdatedAt,
          snapshot: {
            schema: "legacy-listing-read-v1",
            resourceNo: `R-${legacyId}`,
            haffRentYuan: "120.00",
            goodsYuan: "30.00",
            depositYuan: "50.00",
            termDays: "30",
            dailyHaffBase: "2000000",
          },
        }, actor),
      );
      return { accountId, title };
    };
    const legacyA = await makeLegacy("共存旧快照甲", "coex-a", nativePublished);
    const legacyB = await makeLegacy("共存旧快照乙", "coex-b", "2026-09-20T00:00:00.000Z", "safe_box_1x2");

    // Retired Delta observations must not widen the current public filter options.
    await ok(adminRoot + "/listing-filters", { expectedRevision: "0", config, reason: "coexistence fixture" }, o.boss, "PUT");

    const metadata = await ok(publicRoot + "/listing-filters");
    assert.equal(metadata.available, true);
    assert.equal(metadata.readMode, undefined, "mixed mode is not the legacy read-only mode");
    assert.equal(metadata.ruleReleaseId, (await o.pool.query(`SELECT current_release_id AS r FROM zzsh_supply.game WHERE id=$1`, [o.gameId])).rows[0].r);

    const mixed = await list("&limit=50");
    const ids = mixed.items.map((item: any) => item.id);
    assert.equal(ids.includes(legacyA.accountId), false);
    assert.equal(ids.includes(legacyB.accountId), false);
    assert.equal(ids.filter((id: string) => id === takeoverId).length, 1, "native account appears exactly once");
    const takeoverItem = mixed.items.find((item: any) => item.id === takeoverId);
    assert.equal(takeoverItem.source, undefined, "takeover account keeps its native projection");
    assert.equal((await call(`/api/v1/supply/listings/${legacyA.accountId}`)).status, 404);
    assert.equal((await ok(`/api/v1/supply/accounts/${legacyA.accountId}`)).version.origin, "LEGACY_OBSERVATION");
    assert.equal((await ok(`/api/v1/supply/listings/${takeoverId}`)).source, undefined);

    // Non-empty mixed filters: the configured historical code locates only the
    // legacy row, the priced code locates native rows, combinations can be empty,
    // and unknown codes stay rejected.
    const filterOptions = metadata.fields.find((f: any) => f.key === "safeBoxCodes").options.map((option: any) => option.value);
    assert.equal(filterOptions.includes("safe_box_1x2"), false);
    const filtered = async (filters: unknown) => list(`&limit=50&filters=${encodeURIComponent(JSON.stringify(filters))}`);
    const historical = await call(`/api/v1/supply/listings?queryVersion=2&gameId=${o.gameId}&filters=${encodeURIComponent(JSON.stringify({ safeBoxCodes: ["safe_box_1x2"] }))}`);
    assert.equal(historical.status, 400);
    const priced = await filtered({ safeBoxCodes: ["box-a"] });
    assert.ok(priced.items.some((item: any) => item.id === takeoverId), "priced code locates native rows");
    assert.equal(priced.items.some((item: any) => item.id === legacyA.accountId), false);
    assert.equal(priced.items.some((item: any) => item.id === legacyB.accountId), false);
    const unknown = await call(`/api/v1/supply/listings?queryVersion=2&gameId=${o.gameId}&filters=${encodeURIComponent(JSON.stringify({ safeBoxCodes: ["safe_box_9x9"] }))}`);
    assert.equal(unknown.status, 400, "unknown codes stay rejected");

    const current = await ok(`/api/v1/supply/accounts/${takeoverId}`);
    for (const action of ["pause", "resume"]) assert.equal((await call(`/api/v1/supply/accounts/${takeoverId}/${action}`, { expectedRevision: current.account.revision }, o.user)).status, 404);

    // Equal sort keys across sources must page without duplicates or misses.
    // legacyA shares the takeover account's published_at (immutable snapshots
    // cannot be rewritten after insert).
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 60; page += 1) {
      const result = await list(`&sort=latest&direction=DESC&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const item of result.items) seen.push(item.id);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.equal(new Set(seen).size, seen.length, "pagination never repeats a row");
    assert.ok(seen.includes(takeoverId));
    assert.equal(seen.includes(legacyA.accountId), false);
  });

  await o.testContext.test("coexistence: release and source changes invalidate cursors and switch modes", async () => {
    const release = (await o.pool.query(`SELECT current_release_id AS r FROM zzsh_supply.game WHERE id=$1`, [o.gameId])).rows[0].r as string;
    const takeoverId = o.publishedIds[0]!;
    const firstPage = await list("&limit=1");
    assert.ok(firstPage.nextCursor);
    try {
      await o.maintenance.query(`UPDATE zzsh_supply.game SET current_release_id=NULL WHERE id=$1`, [o.gameId]);
      assert.equal((await call(`/api/v1/supply/listings?queryVersion=2&gameId=${o.gameId}&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`)).status, 409, "mixed cursor cannot cross a rule change");

      const legacyOnly = await list("&limit=50");
      assert.equal(legacyOnly.items.some((item: any) => item.source === "LEGACY_READ_ONLY"), false, "retired Delta rows remain hidden");
      assert.equal(legacyOnly.items.some((item: any) => item.id === takeoverId), false, "without a release native accounts cannot accept orders");
      // The list is legacy-only, but an approved native detail stays readable without a current
      // rule release (non-createable); it never falls back to the legacy snapshot.
      const legacyOnlyDetail = await call(`/api/v1/supply/listings/${takeoverId}`);
      assert.equal(legacyOnlyDetail.status, 200);
      assert.equal((legacyOnlyDetail.body as any).source, undefined);
      assert.equal((legacyOnlyDetail.body as any).canCreateOrder, false);
      const legacyMeta = await ok(`/api/v1/supply/games/${o.gameId}/listing-filters`);
      assert.equal(legacyMeta.readMode, "LEGACY_READ_ONLY");
      assert.equal(legacyMeta.ruleReleaseId, null);

    } finally {
      await o.maintenance.query(`UPDATE zzsh_supply.game SET current_release_id=$1 WHERE id=$2`, [release, o.gameId]);
    }
  });

  await o.testContext.test("coexistence: restriction, rule invalidation and filtered pagination stay consistent", async () => {
    const takeoverId = o.publishedIds[0]!;
    const legacyAId = (await o.pool.query(`SELECT a.id FROM zzsh_supply.legacy_listing_read_snapshot h JOIN zzsh_supply.rental_account a ON a.id=h.account_id WHERE a.game_id=$1 AND NOT EXISTS (SELECT 1 FROM zzsh_supply.listing_publication p WHERE p.account_id=a.id) ORDER BY h.created_at LIMIT 1`, [o.gameId])).rows[0].id as string;

    // Staff restriction hides the native account without falling back to legacy.
    const beforeRestriction = await ok(`/api/v1/supply/accounts/${takeoverId}`);
    await ok(`/api/bff/admin/supply/listing-reviews/${takeoverId}/restriction`, { expectedRevision: beforeRestriction.account.revision, restricted: true, reason: "coexistence restriction fixture" }, o.boss);
    const restricted = await list("&limit=50");
    assert.equal(restricted.items.some((item: any) => item.id === takeoverId), false, "restricted native account leaves the list");
    assert.equal((await call(`/api/v1/supply/listings/${takeoverId}`)).status, 404, "restricted native account must not fall back to its legacy snapshot");
    assert.equal(restricted.items.some((item: any) => item.id === legacyAId), false, "retired legacy rows stay hidden");
    const afterRestriction = await ok(`/api/v1/supply/accounts/${takeoverId}`);
    await ok(`/api/bff/admin/supply/listing-reviews/${takeoverId}/restriction`, { expectedRevision: afterRestriction.account.revision, restricted: false, reason: "coexistence restriction release" }, o.boss);

    // Rule invalidation: a native publication is bound to the release current at
    // publish time; moving the game to another release hides it without any
    // legacy fallback and invalidates the previous mixed cursor.
    const release = (await o.pool.query(`SELECT current_release_id AS r FROM zzsh_supply.game WHERE id=$1`, [o.gameId])).rows[0].r as string;
    const other = (await o.pool.query(`SELECT id FROM zzsh_supply.rule_release WHERE game_id=$1 AND id<>$2 ORDER BY generation LIMIT 1`, [o.gameId, release])).rows[0]?.id as string | undefined;
    assert.ok(other, "the game keeps at least one other release for the invalidation case");
    const cursorPage = await list("&limit=1");
    try {
      await o.maintenance.query(`UPDATE zzsh_supply.game SET current_release_id=$1 WHERE id=$2`, [other, o.gameId]);
      const invalidated = await list("&limit=50");
      assert.equal(invalidated.items.some((item: any) => item.id === takeoverId), false, "native publication bound to the old release disappears");
      // Rule invalidation keeps the approved detail readable and non-createable, never the legacy row.
      const invalidatedDetail = await call(`/api/v1/supply/listings/${takeoverId}`);
      assert.equal(invalidatedDetail.status, 200);
      assert.equal((invalidatedDetail.body as any).source, undefined, "rule-invalid native account must not fall back to its legacy snapshot");
      assert.equal((invalidatedDetail.body as any).canCreateOrder, false);
      assert.equal(invalidated.items.some((item: any) => item.id === legacyAId), false, "rule invalidation cannot revive retired legacy rows");
      if (cursorPage.nextCursor) assert.equal((await call(`/api/v1/supply/listings?queryVersion=2&gameId=${o.gameId}&limit=1&cursor=${encodeURIComponent(cursorPage.nextCursor)}`)).status, 409, "cursor bound to the old rule release is rejected");
    } finally {
      await o.maintenance.query(`UPDATE zzsh_supply.game SET current_release_id=$1 WHERE id=$2`, [release, o.gameId]);
    }

    // Filtered mixed pagination keeps the same no-duplicate guarantee.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 60; page += 1) {
      const result = await list(`&limit=1&filters=${encodeURIComponent(JSON.stringify({ safeBoxCodes: ["box-a"] }))}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const item of result.items) seen.push(item.id);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.equal(new Set(seen).size, seen.length, "filtered pagination never repeats a row");
    assert.ok(seen.includes(takeoverId));
    assert.equal(seen.includes(legacyAId), false);
  });

  await o.testContext.test("migrated favorites remain visible without restoring a retired listing", async () => {
    const legacyId = (await o.pool.query(`SELECT a.id FROM zzsh_supply.legacy_listing_read_snapshot h JOIN zzsh_supply.rental_account a ON a.id=h.account_id WHERE a.game_id=$1 AND NOT EXISTS (SELECT 1 FROM zzsh_supply.listing_publication p WHERE p.account_id=a.id) ORDER BY h.created_at LIMIT 1`, [o.gameId])).rows[0].id as string;
    const owner = (await o.pool.query(`SELECT owner_user_id AS id FROM zzsh_supply.rental_account WHERE id=$1`, [legacyId])).rows[0].id;
    await o.maintenance.query(`INSERT INTO zzsh_supply.favorite(user_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [owner, legacyId]);
    const favorites = await ok("/api/v1/supply/me/favorites");
    const favorite = favorites.items.find((item: any) => item.accountId === legacyId);
    assert.equal(favorite.state, "UNAVAILABLE");
    assert.equal(favorite.listing, null);
  });
}
