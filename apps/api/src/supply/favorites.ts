import type { SupplyRuntimeOptions } from "./supply-routes";
import { normalizeTime } from "./content-hash";
import {
  readUserContext,
  assertUserContextInTransaction,
} from "../auth/user-identity";
import {
  recordAudit,
  setAuditContext,
  withTransaction,
} from "../auth/security-core";
import { validateIdempotencyKey } from "../contracts/api-v1";
import {
  listingDetail,
  readPublishingAccount,
  unknownSupplyGate,
  withPublicListingSnapshot,
} from "./publishing";
import {
  bodyOf,
  ensureOnlyFields,
  fingerprintRequest,
  forbidden,
  headerValue,
  invalid,
  notFound,
  sendJson,
  withIdempotency,
  type SupplyNodeRequest,
  type SupplyNodeResponse,
} from "./supply-util";

export async function handleFavorites(
  request: SupplyNodeRequest,
  response: SupplyNodeResponse,
  options: SupplyRuntimeOptions,
  requestId: string,
  path: string,
  query: URLSearchParams,
): Promise<boolean> {
  const method = (request.method ?? "GET").toUpperCase(),
    match = /^\/favorites\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(path);
  if (
    !(method === "GET" && path === "/me/favorites") &&
    !(method === "PUT" && match)
  )
    return false;
  if (
    method === "PUT" &&
    ![options.userOrigin, options.apiOrigin].includes(
      headerValue(request.headers.origin) ?? "",
    )
  )
    throw forbidden();
  const actor = await readUserContext(request, options),
    gate = options.supplyGateReader ?? unknownSupplyGate;
  if (method === "GET") {
    const limit = Number(query.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw invalid("Limit is invalid");
    let cursor: { at: string; id: string } | null = null;
    if (query.has("cursor")) {
      try {
        const raw = query.get("cursor")!;
        if (raw.length > 1024) throw Error();
        const c = JSON.parse(Buffer.from(raw, "base64url").toString());
        if (
          c.user !== actor.userId ||
          typeof c.id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(c.id) ||
          typeof c.at !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(c.at) ||
          normalizeTime(c.at) !== c.at
        )
          throw Error();
        cursor = c;
      } catch {
        throw invalid("Cursor is invalid");
      }
    }
    const result = await withPublicListingSnapshot(
      options.pool,
      async (client) => {
        const found = (
          await client.query<{ account_id: string; savedAt: string }>(
            `SELECT account_id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "savedAt" FROM zzsh_supply.favorite WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,account_id)<($2::timestamptz,$3::text)) ORDER BY created_at DESC,account_id DESC LIMIT $4`,
            [actor.userId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
          )
        ).rows;
        const hasMore = found.length > limit,
          rows = found.slice(0, limit),
          items = [];
        for (const row of rows) {
          let listing: Record<string, unknown> | null = null;
          try {
            listing = await listingDetail(
              client,
              await readPublishingAccount(client, row.account_id),
              "public",
              gate,
            );
          } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
          }
          items.push({
            accountId: row.account_id,
            savedAt: row.savedAt,
            state: listing ? "AVAILABLE" : "UNAVAILABLE",
            message: listing ? null : "该供给暂不可用，收藏已保留",
            listing,
          });
        }
        const last = rows.at(-1);
        return {
          items,
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  JSON.stringify({
                    user: actor.userId,
                    at: last.savedAt,
                    id: last.account_id,
                  }),
                ).toString("base64url")
              : null,
        };
      },
    );
    sendJson(response, 200, result, requestId);
    return true;
  }
  const accountId = match![1]!,
    body = bodyOf(request);
  ensureOnlyFields(body, ["saved"]);
  if (typeof body.saved !== "boolean") throw invalid("Saved must be boolean");
  const saved = body.saved,
    operation = "supply.favorite.set";
  // Complete this independent read before acquiring the write client. A listing may
  // subsequently become unavailable; favorites store only its stable ID, never this detail.
  let visible = false;
  if (saved) {
    try {
      await withPublicListingSnapshot(options.pool, async (reader) =>
        listingDetail(
          reader,
          await readPublishingAccount(reader, accountId),
          "public",
          gate,
        ),
      );
      visible = true;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(
      client,
      "user",
      actor.userId,
      actor.sessionId,
      requestId,
    );
    return withIdempotency(
      client,
      {
        realm: "user",
        principalId: actor.userId,
        operation,
        resourceId: accountId,
      },
      validateIdempotencyKey(headerValue(request.headers["idempotency-key"])),
      fingerprintRequest(operation, accountId, body),
      async () => {
        await assertUserContextInTransaction(client, actor);
      },
      async () => {
        const before = Boolean(
          (
            await client.query(
              `SELECT 1 FROM zzsh_supply.favorite WHERE user_id=$1 AND account_id=$2`,
              [actor.userId, accountId],
            )
          ).rowCount,
        );
        if (saved && !before) {
          if (!visible) throw notFound();
          await client.query(
            `INSERT INTO zzsh_supply.favorite(user_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
            [actor.userId, accountId],
          );
        } else if (!saved)
          await client.query(
            `DELETE FROM zzsh_supply.favorite WHERE user_id=$1 AND account_id=$2`,
            [actor.userId, accountId],
          );
        await recordAudit(client, {
          actorType: "user",
          actorId: actor.userId,
          sessionId: actor.sessionId,
          action: operation,
          objectType: "favorite",
          objectId: accountId,
          outcome: "SUCCESS",
          reason: saved ? "收藏供给" : "取消收藏",
          requestId,
          details: {
            before: { saved: before },
            after: { saved },
            result: before === saved ? "UNCHANGED" : "APPLIED",
          },
        });
        return { status: 200, body: { accountId, saved } };
      },
    );
  });
  sendJson(response, result.status, result.body, requestId);
  return true;
}
