import type { PoolClient } from "pg";

export type SupportPresenceLockClear = { presence: boolean; sessions: number };

/**
 * Locking an auth session must make its support presence non-dispatchable in the
 * same transaction. Only the presence owned by this auth session is cleared; a
 * newer window/session keeps its own presence and open interval.
 *
 * The session close is driven by `updated RETURNING`, not a pre-update snapshot:
 * if another session takes ownership while this statement waits on the row lock,
 * the UPDATE re-checks the owner and returns nothing, so the new interval stays open.
 */
export async function clearSupportPresenceForSession(
  client: PoolClient,
  adminUserId: string,
  authSessionId: string,
): Promise<SupportPresenceLockClear> {
  const result = await client.query<{ presence: string | number; sessions: string | number }>(
    `WITH updated AS (
       UPDATE "zzsh_iam"."im_support_presence"
          SET "availability" = 'OFF_DUTY',
              "connection_state" = 'DISCONNECTED',
              "last_connected_at" = NULL,
              "auth_session_id" = NULL,
              "version" = "version" + 1,
              "updated_at" = clock_timestamp()
        WHERE "admin_user_id" = $1 AND "auth_session_id" = $2
        RETURNING "app_id"
     ), closed AS (
       UPDATE "zzsh_iam"."im_support_presence_session" s
          SET "ended_at" = clock_timestamp(), "end_reason" = 'FORCED'
        WHERE s."admin_user_id" = $1 AND s."ended_at" IS NULL
          AND s."app_id" IN (SELECT "app_id" FROM updated)
        RETURNING s."id"
     )
     SELECT (SELECT count(*) FROM updated) AS "presence",
            (SELECT count(*) FROM closed) AS "sessions"`,
    [adminUserId, authSessionId],
  );
  const row = result.rows[0];
  return { presence: Number(row?.presence ?? 0) > 0, sessions: Number(row?.sessions ?? 0) };
}
