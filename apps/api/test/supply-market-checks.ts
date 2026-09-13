import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TestContext } from "node:test";
type Jar = { header: () => string };
export async function runMarketChecks(o: {
  base: string;
  pool: Pool;
  maintenance: Pool;
  gameId: string;
  accountId: string;
  user: Jar;
  stranger: Jar;
  boss: Jar;
  userOrigin: string;
  adminOrigin: string;
  testContext: TestContext;
}): Promise<void> {
  const request = async (
    path: string,
    body?: unknown,
    jar: Jar = o.user,
    key = "m3d_" + randomUUID(),
    method = body === undefined ? "GET" : "PUT",
  ) => {
    const r = await fetch(o.base + path, {
      method,
      headers: {
        cookie: jar.header(),
        origin: path.includes("/admin/") ? o.adminOrigin : o.userOrigin,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", "idempotency-key": key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  await o.testContext.test(
    "M3-D favorites are private, idempotent, paginated and safe when unavailable",
    async () => {
      const path = "/api/v1/supply/favorites/" + o.accountId,
        key = "favorite_" + randomUUID();
      assert.equal(
        (await fetch(o.base + "/api/v1/supply/me/favorites")).status,
        401,
      );
      const first = await request(path, { saved: true }, o.user, key);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.deepEqual(first.body, { accountId: o.accountId, saved: true });
      const count = async () =>
        Number(
          (
            await o.pool.query(
              `SELECT count(*) FROM zzsh_iam.audit_event WHERE action='supply.favorite.set' AND object_id=$1`,
              [o.accountId],
            )
          ).rows[0].count,
        );
      const before = await count();
      assert.deepEqual(
        (await request(path, { saved: true }, o.user, key)).body,
        first.body,
      );
      assert.equal(await count(), before);
      assert.equal(
        (await request(path, { saved: false }, o.user, key)).status,
        409,
      );
      assert.equal(
        (await request("/api/v1/supply/me/favorites", undefined, o.stranger))
          .body.items.length,
        0,
      );
      assert.equal(
        (await request(path, { saved: true }, o.stranger, key)).status,
        200,
        "same key is isolated by principal",
      );
      assert.equal(
        (await request(path, { saved: false }, o.stranger)).status,
        200,
      );
      const mine = (await request("/api/bff/user/supply/me/favorites")).body;
      assert.equal(mine.items.length, 1);
      assert.equal(mine.items[0].state, "AVAILABLE");
      assert.equal(mine.items[0].listing.id, o.accountId);
      assert.equal(mine.items[0].listing.quote.resourceTotal.amount, "125.00");
      for (const field of [
        "owner_user_id",
        "ownerTotal",
        "platformFullProfit",
        "pricingInputs",
        "restriction_reason",
        "ACCOUNT_EVIDENCE",
      ])
        assert.equal(JSON.stringify(mine).includes(field), false, field);
      const empty = await request(
        "/api/v1/supply/accounts",
        { gameId: o.gameId },
        o.user,
        undefined,
        "POST",
      );
      assert.equal(empty.status, 200);
      assert.equal(
        (
          await request("/api/v1/supply/favorites/" + empty.body.accountId, {
            saved: true,
          })
        ).status,
        404,
        "never-public account cannot be discovered via favorites",
      );
      // Existing saved IDs can become unavailable; no cached title, price or private reason is returned.
      const userId = (
        await o.pool.query(
          "SELECT owner_user_id FROM zzsh_supply.rental_account WHERE id=$1",
          [o.accountId],
        )
      ).rows[0].owner_user_id;
      await o.maintenance.query(
        `INSERT INTO zzsh_supply.favorite(user_id,account_id,created_at) VALUES($1,$2,'2000-01-01T00:00:00.123456Z')`,
        [userId, empty.body.accountId],
      );
      const page1 = (await request("/api/v1/supply/me/favorites?limit=1")).body;
      assert.equal(page1.items.length, 1);
      assert.ok(page1.nextCursor);
      const page2 = (
        await request(
          "/api/v1/supply/me/favorites?limit=1&cursor=" +
            encodeURIComponent(page1.nextCursor),
        )
      ).body;
      assert.equal(page2.items[0].accountId, empty.body.accountId);
      assert.equal(page2.items[0].listing, null);
      assert.equal(page2.nextCursor, null);
      assert.equal(
        (
          await request(
            "/api/v1/supply/me/favorites?cursor=" +
              encodeURIComponent(page1.nextCursor),
            undefined,
            o.stranger,
          )
        ).status,
        400,
      );
      await o.maintenance.query(
        "UPDATE zzsh_supply.rental_account SET owner_paused=true,restriction_reason=$2 WHERE id=$1",
        [o.accountId, "private operational note"],
      );
      try {
        const hidden = (
          await request("/api/v1/supply/me/favorites")
        ).body.items.find((i: any) => i.accountId === o.accountId);
        assert.equal(hidden.state, "UNAVAILABLE");
        assert.equal(hidden.listing, null);
        assert.equal(
          JSON.stringify(hidden).includes("private operational note"),
          false,
        );
        assert.deepEqual(
          (await request(path, { saved: true }, o.user, key)).body,
          first.body,
        );
      } finally {
        await o.maintenance.query(
          "UPDATE zzsh_supply.rental_account SET owner_paused=false,restriction_reason=NULL WHERE id=$1",
          [o.accountId],
        );
      }
      assert.equal((await request(path, { saved: false })).status, 200);
      assert.deepEqual(
        (await request(path, { saved: true }, o.user, key)).body,
        first.body,
        "old replay remains original receipt",
      );
      assert.equal(
        (await request("/api/v1/supply/me/favorites")).body.items.some(
          (i: any) => i.accountId === o.accountId,
        ),
        false,
        "replay cannot re-add a removed favorite",
      );
      assert.equal(
        (await request(path, { saved: true, userId: "someone_else" })).status,
        400,
      );
      const concurrentKey = "parallel_favorite_" + randomUUID();
      const concurrent = await Promise.all([
        request(path, { saved: true }, o.user, concurrentKey),
        request(path, { saved: true }, o.user, concurrentKey),
      ]);
      assert.deepEqual(
        concurrent.map((r) => r.status),
        [200, 200],
      );
      assert.equal(
        Number(
          (
            await o.pool.query(
              `SELECT count(*) FROM zzsh_supply.favorite WHERE user_id=$1 AND account_id=$2`,
              [userId, o.accountId],
            )
          ).rows[0].count,
        ),
        1,
      );
      await o.maintenance.query(
        `UPDATE zzsh_auth_user."user" SET suspended=true WHERE id=$1`,
        [userId],
      );
      try {
        assert.equal(
          (await request(path, { saved: true }, o.user, concurrentKey)).status,
          401,
        );
      } finally {
        await o.maintenance.query(
          `UPDATE zzsh_auth_user."user" SET suspended=false WHERE id=$1`,
          [userId],
        );
      }
    },
  );
  await o.testContext.test(
    "M3-D publishing catalog is a complete, public-safe selector",
    async () => {
      assert.equal(
        (
          await fetch(
            o.base + "/api/v1/supply/games/" + o.gameId + "/publishing-catalog",
          )
        ).status,
        200,
      );
      const all = (await request("/api/v1/supply/games")).body;
      assert.ok(all.games.some((g: any) => g.id === o.gameId));
      const catalog = await request(
        "/api/v1/supply/games/" +
          o.gameId +
          "/publishing-catalog?q=definitely-not-a-skin",
      );
      assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
      assert.equal(catalog.body.ready, true);
      assert.ok(
        catalog.body.items.length >= 2,
        "skin search must not hide quantity fields",
      );
      assert.equal(catalog.body.skins.length, 0);
      const quoted = (
        await o.pool.query(
          `SELECT p.item_id FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id JOIN zzsh_supply.price_line p ON p.price_version_id=r.price_version_id WHERE g.id=$1`,
          [o.gameId],
        )
      ).rows.map((r) => r.item_id);
      assert.ok(catalog.body.items.every((i: any) => quoted.includes(i.id)));
      for (const field of [
        "owner_unit_amount",
        "ownerUnitAmount",
        "commission_rate",
        "haff_rule",
        "sourceNote",
        "sourceToken",
      ])
        assert.equal(
          JSON.stringify(catalog.body).includes(field),
          false,
          field,
        );
      const skin = (
        await o.pool.query(
          `SELECT id,category_id FROM zzsh_supply.skin WHERE game_id=$1 AND code='skin_m4_gold'`,
          [o.gameId],
        )
      ).rows[0];
      await request(
        "/api/bff/admin/supply/categories/" + skin.category_id,
        { formVisible: false },
        o.boss,
      );
      try {
        const hidden = (
          await request(
            "/api/v1/supply/games/" + o.gameId + "/publishing-catalog",
          )
        ).body;
        assert.equal(
          hidden.skins.some((s: any) => s.id === skin.id),
          false,
        );
      } finally {
        await request(
          "/api/bff/admin/supply/categories/" + skin.category_id,
          { formVisible: true },
          o.boss,
        );
      }
      const missing = await request(
        "/api/bff/admin/supply/games/" + o.gameId + "/items",
        {
          code: "m3d_unpriced_required",
          name: "待配置物品",
          unit: "PIECE",
          required: true,
        },
        o.boss,
        undefined,
        "POST",
      );
      assert.equal(missing.status, 200);
      const blocked = (
        await request(
          "/api/v1/supply/games/" + o.gameId + "/publishing-catalog",
        )
      ).body;
      assert.equal(blocked.ready, false);
      assert.ok(
        blocked.blockers.some(
          (b: any) =>
            b.code === "REQUIRED_ITEM_UNPRICED" && b.itemId === missing.body.id,
        ),
      );
      const options = (
        await request(
          "/api/v1/supply/games/" + o.gameId + "/publishing-options",
        )
      ).body;
      assert.ok(options.vitalityLevels.includes(6));
      assert.ok(options.bearLevels.includes(6));
      assert.ok(options.agreement.body);
      assert.equal(
        (
          await request(
            "/api/bff/admin/supply/items/" + missing.body.id,
            { enabled: false },
            o.boss,
          )
        ).status,
        200,
      );
      const draftAccount = await request(
        "/api/v1/supply/accounts",
        { gameId: o.gameId },
        o.user,
        undefined,
        "POST",
      );
      const invalid = await request(
        "/api/v1/supply/accounts/" + draftAccount.body.accountId + "/draft",
        { saved: true },
      );
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.details[0].path, "saved");
    },
  );
}
