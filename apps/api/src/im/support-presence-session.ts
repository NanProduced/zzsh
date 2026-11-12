import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";

export type SupportPresenceEndReason = "LOGOUT" | "REVOKED";

/**
 * Locking an auth session pauses new dispatch but keeps reception ownership and
 * the open interval. Only the presence owned by this auth session is touched; a
 * newer takeover keeps its own ownership and interval.
 */
export async function markSupportPresenceLockedForSession(
  client: PoolClient,
  adminUserId: string,
  authSessionId: string,
): Promise<{ presence: boolean }> {
  const result = await client.query(
    `UPDATE "zzsh_iam"."im_support_presence"
        SET "connection_state" = 'DISCONNECTED',
            "disconnected_since" = COALESCE("disconnected_since", clock_timestamp()),
            "dispatch_paused" = true,
            "version" = "version" + 1,
            "state_revision" = "state_revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "admin_user_id" = $1 AND "auth_session_id" = $2 AND "availability" = 'AVAILABLE'`,
    [adminUserId, authSessionId],
  );
  return { presence: (result.rowCount ?? 0) > 0 };
}

/**
 * Unlocking must invalidate a heartbeat that was issued before the unlock, while
 * leaving dispatch paused until the page reconnects. The next GET returns the new
 * revision; only a post-unlock CONNECTED heartbeat may resume dispatch.
 */
export async function markSupportPresenceUnlockedForSession(
  client: PoolClient,
  adminUserId: string,
  authSessionId: string,
): Promise<{ presence: boolean }> {
  const result = await client.query(
    `UPDATE "zzsh_iam"."im_support_presence"
        SET "state_revision" = "state_revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "admin_user_id" = $1 AND "auth_session_id" = $2 AND "availability" = 'AVAILABLE'`,
    [adminUserId, authSessionId],
  );
  return { presence: (result.rowCount ?? 0) > 0 };
}

async function endPresenceRows(
  client: PoolClient,
  ownedSql: string,
  ownedParams: unknown[],
  reason: SupportPresenceEndReason,
  endedAt: Date | null,
): Promise<{ presence: boolean; sessions: number }> {
  const result = await client.query<{ presence: string | number; sessions: string | number }>(
    `WITH owned AS (
       ${ownedSql}
       FOR UPDATE
     ), updated AS (
       UPDATE "zzsh_iam"."im_support_presence" p
          SET "availability" = 'OFF_DUTY',
              "connection_state" = 'DISCONNECTED',
              "auth_session_id" = NULL,
              "connection_id" = NULL,
              "connection_expires_at" = NULL,
              "dispatch_paused" = false,
              "disconnected_since" = NULL,
              "version" = p."version" + 1,
              "state_revision" = p."state_revision" + 1,
              "updated_at" = clock_timestamp()
         FROM owned
        WHERE p."app_id" = owned."app_id" AND p."admin_user_id" = owned."admin_user_id"
        RETURNING p."admin_user_id"
     ), closed AS (
       UPDATE "zzsh_iam"."im_support_presence_session" s
          SET "ended_at" = GREATEST(COALESCE($${ownedParams.length + 2}::timestamptz, clock_timestamp()), s."started_at"),
              "end_reason" = $${ownedParams.length + 1}
         FROM owned
        WHERE s."app_id" = owned."app_id" AND s."admin_user_id" = owned."admin_user_id"
          AND s."ended_at" IS NULL
        RETURNING s."id"
     )
     SELECT (SELECT count(*) FROM updated) AS "presence",
            (SELECT count(*) FROM closed) AS "sessions"`,
    [...ownedParams, reason, endedAt],
  );
  const row = result.rows[0];
  return { presence: Number(row?.presence ?? 0) > 0, sessions: Number(row?.sessions ?? 0) };
}

/** Explicit sign-out of the auth session that currently owns reception. */
export async function endSupportPresenceForAuthSession(
  client: PoolClient,
  authSessionId: string,
  reason: SupportPresenceEndReason,
  endedAt: Date | null = null,
): Promise<{ presence: boolean; sessions: number }> {
  return endPresenceRows(
    client,
    `SELECT p."app_id", p."admin_user_id"
       FROM "zzsh_iam"."im_support_presence" p
      WHERE p."auth_session_id" = $1`,
    [authSessionId],
    reason,
    endedAt,
  );
}

/** Every session for this administrator is being revoked/disabled. */
export async function endSupportPresenceForAdmin(
  client: PoolClient,
  adminUserId: string,
  reason: SupportPresenceEndReason,
  endedAt: Date | null = null,
): Promise<{ presence: boolean; sessions: number }> {
  return endPresenceRows(
    client,
    `SELECT p."app_id", p."admin_user_id"
       FROM "zzsh_iam"."im_support_presence" p
      WHERE p."admin_user_id" = $1`,
    [adminUserId],
    reason,
    endedAt,
  );
}

/**
 * A role/grant change can remove read or accept while presence is still AVAILABLE.
 * End reception at the server processing time instead of waiting for the 30-minute
 * lost sweep. The caller must hold the affected admin's role/grant locks.
 */
export async function reconcileSupportPresenceForAdmin(
  client: PoolClient,
  adminUserId: string,
): Promise<{ ended: boolean }> {
  const access = await loadEffectiveAdminAccess(client, adminUserId);
  const allowed = access?.status === "ACTIVE"
    && hasPermission(access, ADMIN_PERMISSION.imSupportRead)
    && hasPermission(access, ADMIN_PERMISSION.imSupportAccept)
    && hasPermission(access, ADMIN_PERMISSION.imSupportPresence);
  if (allowed) return { ended: false };
  const result = await endSupportPresenceForAdmin(client, adminUserId, "REVOKED");
  return { ended: result.presence || result.sessions > 0 };
}
