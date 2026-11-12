import type { PoolClient } from "pg";
import { SUPPORT_LOST_SECONDS } from "./support-presence-policy";

export type SupportPresenceConvergence = {
  ended: boolean;
  reason: "LOST" | "SESSION_EXPIRED" | "REVOKED" | "NO_INTERVAL" | "NO_OWNER" | null;
};

/**
 * Per-admin lazy convergence. It uses the same lock order as lock/unlock and
 * explicit presence writes: auth session first, then presence. A heartbeat or a
 * page read can therefore converge a missed 30-minute sweep before trusting the
 * row again. It never extends an interval with the caller's current time.
 */
export async function convergeSupportPresenceForAdmin(
  client: PoolClient,
  appId: string,
  adminUserId: string,
  options: { lostSeconds?: number } = {},
): Promise<SupportPresenceConvergence> {
  const lostSeconds = options.lostSeconds ?? SUPPORT_LOST_SECONDS;
  if (!Number.isSafeInteger(lostSeconds) || lostSeconds < 1) throw new Error("Invalid lost session window");

  const presence = (await client.query<{
    availability: string;
    authSessionId: string | null;
    lastConfirmedAt: Date | null;
  }>(
    `SELECT "availability", "auth_session_id" AS "authSessionId", "last_confirmed_at" AS "lastConfirmedAt"
       FROM "zzsh_iam"."im_support_presence"
      WHERE "app_id" = $1 AND "admin_user_id" = $2
      FOR UPDATE`,
    [appId, adminUserId],
  )).rows[0];
  if (!presence) return { ended: false, reason: null };

  const interval = (await client.query<{ id: string; startedAt: Date }>(
    `SELECT "id", "started_at" AS "startedAt" FROM "zzsh_iam"."im_support_presence_session"
      WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "ended_at" IS NULL FOR UPDATE`,
    [appId, adminUserId],
  )).rows[0];

  // 0184 made auth_session_id nullable; an AVAILABLE row with an open interval
  // but no owner cannot prove that anyone is still receiving. It must require an
  // explicit start instead of becoming dispatchable after a connection claim.
  if (presence.availability === "AVAILABLE" && presence.authSessionId === null) {
    if (interval) await closeInterval(client, interval.id, trustedEnd(presence.lastConfirmedAt, interval.startedAt), "LOST");
    await clearPresence(client, appId, adminUserId);
    return { ended: true, reason: "NO_OWNER" };
  }

  // No auth-session row lock here: callers that also touch the session hold it
  // first (session -> presence); a plain read is enough to classify expiry.
  const session = presence.authSessionId
    ? (await client.query<{ expiresAt: Date }>(
        `SELECT "expiresAt" FROM "zzsh_auth_admin"."session"
          WHERE "id" = $1 AND "userId" = $2`,
        [presence.authSessionId, adminUserId],
      )).rows[0]
    : undefined;

  if (presence.authSessionId && !session) {
    if (interval) await closeInterval(client, interval.id, trustedEnd(presence.lastConfirmedAt, interval.startedAt), "REVOKED");
    await clearPresence(client, appId, adminUserId);
    return { ended: true, reason: "REVOKED" };
  }

  const clock = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  if (session && session.expiresAt.getTime() <= clock.getTime()) {
    if (interval) {
      const trusted = trustedEnd(presence.lastConfirmedAt, interval.startedAt);
      const endedAt = new Date(Math.max(interval.startedAt.getTime(), Math.min(session.expiresAt.getTime(), trusted.getTime())));
      await closeInterval(client, interval.id, endedAt, "SESSION_EXPIRED");
    }
    await clearPresence(client, appId, adminUserId);
    return { ended: true, reason: "SESSION_EXPIRED" };
  }

  if (presence.availability !== "AVAILABLE") {
    if (!interval) return { ended: false, reason: null };
    // An open interval on an off-duty row is a historical inconsistency; close it
    // at the last trusted liveness rather than pretending it continued.
    await closeInterval(client, interval.id, trustedEnd(presence.lastConfirmedAt, interval.startedAt), "LOST");
    return { ended: true, reason: "LOST" };
  }

  if (!interval) {
    await clearPresence(client, appId, adminUserId);
    return { ended: true, reason: "NO_INTERVAL" };
  }

  if ((presence.lastConfirmedAt?.getTime() ?? interval.startedAt.getTime()) <= clock.getTime() - lostSeconds * 1000) {
    await closeInterval(client, interval.id, trustedEnd(presence.lastConfirmedAt, interval.startedAt), "LOST");
    await clearPresence(client, appId, adminUserId);
    return { ended: true, reason: "LOST" };
  }

  return { ended: false, reason: null };
}

function trustedEnd(lastConfirmedAt: Date | null, startedAt: Date): Date {
  return new Date(Math.max(startedAt.getTime(), lastConfirmedAt?.getTime() ?? startedAt.getTime()));
}

async function closeInterval(client: PoolClient, id: string, endedAt: Date, reason: "LOST" | "SESSION_EXPIRED" | "REVOKED"): Promise<void> {
  await client.query(
    `UPDATE "zzsh_iam"."im_support_presence_session"
        SET "ended_at" = GREATEST($2::timestamptz, "started_at"), "end_reason" = $3
      WHERE "id" = $1 AND "ended_at" IS NULL`,
    [id, endedAt, reason],
  );
}

async function clearPresence(client: PoolClient, appId: string, adminUserId: string): Promise<void> {
  await client.query(
    `UPDATE "zzsh_iam"."im_support_presence"
        SET "availability" = 'OFF_DUTY',
            "connection_state" = 'DISCONNECTED',
            "auth_session_id" = NULL,
            "connection_id" = NULL,
            "connection_expires_at" = NULL,
            "dispatch_paused" = false,
            "disconnected_since" = NULL,
            "version" = "version" + 1,
            "state_revision" = "state_revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "admin_user_id" = $2`,
    [appId, adminUserId],
  );
}
