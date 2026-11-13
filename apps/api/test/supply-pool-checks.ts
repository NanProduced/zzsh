import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { TestContext } from "node:test";
import { createApp } from "../src/app";
import type { AuthRuntimeOptions } from "../src/auth/auth-runtime";

export async function runSupplyPoolChecks(o: {
  testContext: TestContext;
  pool: Pool;
  maintenance: Pool;
  auth: AuthRuntimeOptions;
  user: { header: () => string };
  boss: { header: () => string };
  bossId: string;
  accountId: string;
  gameId: string;
  bytes: Buffer;
}): Promise<void> {
  for (const max of [1, 2])
    await o.testContext.test(
      `M3-D R1: real PG application pool max=${max} never borrows while holding a transaction`,
      async () => {
        const pool = new Pool({
          ...o.pool.options,
          password: o.pool.options.password,
          max,
          connectionTimeoutMillis: 500,
          application_name: `m3d-pool-${max}`,
        });
        const proof = {
          outsideSessionQueries: 0,
          insideSessionQueries: 0,
          pids: new Set<number>(),
        };
        let hold: undefined | (() => Promise<void>),
          held = 0,
          peak = 0;
        pool.on("connect", (client) => {
          let inTransaction = false;
          proof.pids.add(
            (client as unknown as { processID: number }).processID,
          );
          const original = client.query.bind(client) as (...args: any[]) => any;
          client.query = ((...args: any[]) => {
            const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
            if (typeof sql === "string" && sql.includes('"session"')) {
              if (inTransaction) proof.insideSessionQueries++;
              else proof.outsideSessionQueries++;
            }
            if (sql === "BEGIN")
              return Promise.resolve(original(...args)).then(async (result) => {
                inTransaction = true;
                held++;
                peak = Math.max(peak, held);
                return result;
              });
            if (
              typeof sql === "string" &&
              sql.includes("set_config('zzsh.actor_type'")
            )
              return Promise.resolve(original(...args)).then(async (result) => {
                await hold?.();
                return result;
              });
            if (sql === "COMMIT" || sql === "ROLLBACK")
              return Promise.resolve(original(...args)).finally(() => {
                inTransaction = false;
                held--;
              });
            return original(...args);
          }) as typeof client.query;
        });
        assert.equal(
          (await pool.query("SELECT current_database() AS name")).rows[0].name,
          o.pool.options.database,
        );
        const app = await createApp({
          health: {
            dependencies: {
              postgres: {
                check: async () => undefined,
                close: async () => undefined,
              },
              redis: {
                check: async () => undefined,
                close: async () => undefined,
              },
            },
          },
          database: { pool },
          auth: { ...o.auth, pool },
        });
        await app.listen(0, "127.0.0.1");
        const base = await app.getUrl();
        const call = async (
          path: string,
          body: unknown,
          admin = false,
          key = "small_" + randomUUID(),
          method = body === undefined ? "GET" : "PUT",
        ) => {
          const r = await fetch(base + path, {
            method,
            signal: AbortSignal.timeout(6000),
            headers: {
              cookie: admin ? o.boss.header() : o.user.header(),
              origin: admin ? o.auth.adminOrigin : o.auth.userOrigin,
              ...(body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "idempotency-key": key,
                  }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return { status: r.status, body: await r.json() };
        };
        let release = () => {};
        try {
          assert.equal(
            (await call("/api/auth/user/get-session", undefined)).status,
            200,
            "SDK session authentication can finish before a transaction with this same small pool",
          );
          const userId = (
            await o.maintenance.query(
              "SELECT owner_user_id FROM zzsh_supply.rental_account WHERE id=$1",
              [o.accountId],
            )
          ).rows[0].owner_user_id;
          await o.maintenance.query(
            "DELETE FROM zzsh_supply.favorite WHERE user_id=$1 AND account_id=$2",
            [userId, o.accountId],
          );
          const path = "/api/v1/supply/favorites/" + o.accountId,
            key = "small_add_" + randomUUID();
          if (max === 2) {
            let arrived!: () => void;
            const atFull = new Promise<void>((r) => (arrived = r)),
              barrier = new Promise<void>((r) => (release = r));
            let count = 0;
            hold = async () => {
              if (++count === 2) arrived();
              await barrier;
            };
            const first = call(path, { saved: true }, false, key),
              second = call(
                path,
                { saved: true },
                false,
                "other_" + randomUUID(),
              );
            await Promise.race([
              atFull,
              Promise.all([first, second]).then(() => {
                throw Error("both transactions did not reach the barrier");
              }),
            ]);
            assert.equal(held, 2);
            assert.equal(pool.totalCount, 2);
            hold = undefined;
            release();
            const results = await Promise.all([first, second]);
            assert.deepEqual(
              results.map((r) => r.status),
              [200, 200],
              JSON.stringify({ peak, results: results.map((r) => r.status) }),
            );
          } else {
            const result = await call(path, { saved: true }, false, key);
            assert.equal(
              result.status,
              200,
              JSON.stringify({ held, peak, status: result.status }),
            );
          }
          const auditCount = async () =>
            Number(
              (
                await o.maintenance.query(
                  `SELECT count(*) FROM zzsh_iam.audit_event WHERE actor_id=$1 AND action='supply.favorite.set'`,
                  [userId],
                )
              ).rows[0].count,
            );
          const before = await auditCount();
          assert.equal(
            (await call(path, { saved: true }, false, key)).status,
            200,
          );
          assert.equal(await auditCount(), before);
          assert.equal((await call(path, { saved: false })).status, 200);
          assert.equal(
            (await call(path, { saved: true }, false, key)).status,
            200,
          );
          assert.equal(
            Number(
              (
                await o.maintenance.query(
                  "SELECT count(*) FROM zzsh_supply.favorite WHERE user_id=$1 AND account_id=$2",
                  [userId, o.accountId],
                )
              ).rows[0].count,
            ),
            0,
            "old receipt cannot re-add",
          );
          assert.equal(
            (
              await call(
                "/api/v1/supply/accounts",
                { gameId: o.gameId },
                false,
                undefined,
                "POST",
              )
            ).status,
            200,
          );
          const detail = await call(
            "/api/v1/supply/accounts/" + o.accountId,
            undefined,
          );
          assert.equal(detail.status, 200);
          const pause = await call(
            "/api/v1/supply/accounts/" + o.accountId + "/pause",
            { expectedRevision: detail.body.account.revision },
            false,
            undefined,
            "POST",
          );
          assert.equal(pause.status, 200);
          assert.equal(
            (
              await call(
                "/api/v1/supply/accounts/" + o.accountId + "/resume",
                { expectedRevision: pause.body.account.revision },
                false,
                undefined,
                "POST",
              )
            ).status,
            200,
          );
          const review = await call(
            "/api/bff/admin/supply/listing-reviews/" + o.accountId,
            undefined,
            true,
          );
          assert.equal(review.status, 200);
          assert.equal(
            (
              await call(
                "/api/bff/admin/supply/listing-reviews/" +
                  o.accountId +
                  "/restriction",
                {
                  expectedRevision: review.body.account.revision,
                  restricted: false,
                  reason: "小连接池联调",
                },
                true,
                undefined,
                "POST",
              )
            ).status,
            200,
          );
          assert.equal(
            (
              await call(
                "/api/bff/admin/supply/games/" + o.gameId + "/catalog",
                undefined,
                true,
              )
            ).status,
            200,
          );
          const intentKey = "small_intent_" + randomUUID(),
            intentBody = {
              gameId: o.gameId,
              purpose: "GAME_COVER",
              mime: "image/png",
              size: o.bytes.length,
            };
          const intent = await call(
            "/api/bff/admin/supply/media/upload-intents",
            intentBody,
            true,
            intentKey,
            "POST",
          );
          assert.equal(intent.status, 200);
          const uploaded = await fetch(
            base +
              "/api/bff/admin/supply/media/uploads/" +
              intent.body.intentId,
            {
              method: "PUT",
              signal: AbortSignal.timeout(6000),
              headers: {
                cookie: o.boss.header(),
                origin: o.auth.adminOrigin,
                "content-type": "image/png",
                "x-upload-token": intent.body.uploadToken,
                "idempotency-key": "small_upload_" + randomUUID(),
              },
              body: new Uint8Array(o.bytes),
            },
          );
          assert.equal(uploaded.status, 200);
          const userIntent = await call(
            "/api/v1/supply/media/upload-intents",
            {
              gameId: o.gameId,
              accountId: o.accountId,
              purpose: "ACCOUNT_EVIDENCE",
              mime: "image/png",
              size: o.bytes.length,
            },
            false,
            undefined,
            "POST",
          );
          assert.equal(userIntent.status, 200);
          const userUpload = await fetch(
            base + "/api/v1/supply/media/uploads/" + userIntent.body.intentId,
            {
              method: "PUT",
              signal: AbortSignal.timeout(6000),
              headers: {
                cookie: o.user.header(),
                origin: o.auth.userOrigin,
                "content-type": "image/png",
                "x-upload-token": userIntent.body.uploadToken,
                "idempotency-key": "small_user_upload_" + randomUUID(),
              },
              body: new Uint8Array(o.bytes),
            },
          );
          assert.equal(userUpload.status, 200);
          // Identity changes after SDK authentication but before transactional authorization.
          let reached!: () => void;
          const ready = new Promise<void>((r) => (reached = r)),
            barrier = new Promise<void>((r) => (release = r));
          hold = async () => {
            reached();
            await barrier;
          };
          const stopped = call(path, { saved: true }, false, key);
          await ready;
          await o.maintenance.query(
            'UPDATE zzsh_auth_user."user" SET suspended=true WHERE id=$1',
            [userId],
          );
          hold = undefined;
          release();
          try {
            assert.equal(
              (await stopped).status,
              401,
              "deactivation between authentication and transaction must reject cached replay",
            );
          } finally {
            await o.maintenance.query(
              'UPDATE zzsh_auth_user."user" SET suspended=false WHERE id=$1',
              [userId],
            );
          }
          const atAuthorization = async (
            action: () => Promise<{ status: number }>,
            change: () => Promise<unknown>,
          ) => {
            let signal!: () => void;
            const ready = new Promise<void>((r) => (signal = r)),
              barrier = new Promise<void>((r) => (release = r));
            hold = async () => {
              signal();
              await barrier;
            };
            const pending = action();
            try {
              await Promise.race([
                ready,
                pending.then(() => {
                  throw Error("authorization barrier not reached");
                }),
              ]);
              await change();
              hold = undefined;
              release();
              return await pending;
            } finally {
              hold = undefined;
              release();
            }
          };
          const expiry = (
            await o.maintenance.query(
              'SELECT id,"expiresAt" FROM zzsh_auth_user.session WHERE "userId"=$1',
              [userId],
            )
          ).rows;
          try {
            const expired = await atAuthorization(
              () => call(path, { saved: true }, false, key),
              () =>
                o.maintenance.query(
                  `UPDATE zzsh_auth_user.session SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "userId"=$1`,
                  [userId],
                ),
            );
            assert.equal(expired.status, 401);
          } finally {
            for (const row of expiry)
              await o.maintenance.query(
                'UPDATE zzsh_auth_user.session SET "expiresAt"=$2 WHERE id=$1',
                [row.id, row.expiresAt],
              );
          }
          try {
            const locked = await atAuthorization(
              () =>
                call(
                  "/api/bff/admin/supply/media/upload-intents",
                  intentBody,
                  true,
                  intentKey,
                  "POST",
                ),
              () =>
                o.maintenance.query(
                  'UPDATE zzsh_auth_admin.session SET locked=true WHERE "userId"=$1',
                  [o.bossId],
                ),
            );
            assert.equal(locked.status, 423);
          } finally {
            await o.maintenance.query(
              'UPDATE zzsh_auth_admin.session SET locked=false WHERE "userId"=$1',
              [o.bossId],
            );
          }
          assert.ok(proof.outsideSessionQueries > 0);
          assert.ok(proof.insideSessionQueries > 0);
          assert.ok(proof.pids.size <= max);
          console.log(
            "POOL_PROOF",
            JSON.stringify({
              max,
              peak,
              backendPids: [...proof.pids],
              sessionQueriesOutsideTransaction: proof.outsideSessionQueries,
              sessionChecksOnTransactionClient: proof.insideSessionQueries,
            }),
          );
          assert.ok(pool.totalCount <= max);
          assert.equal(pool.waitingCount, 0);
        } finally {
          hold = undefined;
          release();
          await app.close();
        }
      },
    );
}
