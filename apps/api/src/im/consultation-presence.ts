/**
 * 客服在线状态：presence 视图、心跳、会话占用与连接租约（claim/release/refresh）。
 */

import {
  ADMIN_PERMISSION,
  hasPermission,
  loadEffectiveAdminAccess,
  type EffectiveAdminAccess,
} from "../auth/admin-authorization";
import {
  assertAdminContextInTransaction,
  type AdminContext,
} from "../auth/auth-security";
import {
  recordAudit,
  SecurityApiError,
  setAuditContext,
  withTransaction,
} from "../auth/security-core";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
} from "./identity-lifecycle";
import { readSupportToday } from "./support-management";
import { convergeSupportPresenceForAdmin } from "./support-presence-convergence";
import { isPresenceDispatchable } from "./support-presence-policy";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  CONNECTION_ID_PATTERN,
  type ConsultationRouteOptions,
  type PresenceRow,
  type SupportAvailability,
  type SupportConnectionState,
  type SupportPresence,
  type SupportPresenceHeartbeat,
  type SupportPresenceReason,
  conflict,
  invalid,
  iso,
  numberValue,
  ownsPresenceConnection,
} from "./consultation-internals";
import { autoAssignWaitingConsultations } from "./consultation-rounds";

export const PRESENCE_SELECT = `SELECT "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
    "last_connected_at" AS "lastConnectedAt", "last_confirmed_at" AS "lastConfirmedAt",
    "disconnected_since" AS "disconnectedSince", "dispatch_paused" AS "dispatchPaused",
    "state_revision" AS "stateRevision", "connection_id" AS "connectionId", "connection_expires_at" AS "connectionExpiresAt", "active_load" AS "activeLoad", "version", "auth_session_id" AS "authSessionId"
  FROM "zzsh_iam"."im_support_presence" WHERE "app_id" = $1 AND "admin_user_id" = $2`;

export function defaultPresence(adminUserId: string): Omit<SupportPresence, "today"> {
  return {
    adminUserId,
    availability: "OFF_DUTY",
    connectionState: "DISCONNECTED",
    lastConnectedAt: null,
    lastConfirmedAt: null,
    disconnectedSince: null,
    dispatchPaused: false,
    dispatchable: false,
    reason: null,
    stateRevision: 0,
    activeLoad: 0,
    version: 0,
    ownedByAnotherSession: false,
    unbound: false,
  };
}

export function presenceReason(
  row: PresenceRow,
  currentSessionId: string,
  hasOwnedSession: boolean,
  dispatchable: boolean,
  dispatchEligible: boolean,
): SupportPresenceReason | null {
  if (row.authSessionId !== null && row.authSessionId !== currentSessionId) return "TAKEN_OVER";
  if (row.authSessionId === null) return row.availability === "AVAILABLE" ? "NOT_OWNER" : null;
  if (!dispatchEligible) return "FORBIDDEN";
  if (row.availability !== "AVAILABLE") return "ENDED";
  if (!hasOwnedSession) return "ENDED";
  if (row.dispatchPaused) return "PAUSED_DISPATCH";
  if (row.connectionState === "KICKED" || row.connectionState === "AUTH_FAILED") return "CONNECTION_TERMINAL";
  if (!dispatchable) return "PAUSED_DISPATCH";
  if (row.disconnectedSince !== null || row.connectionState !== "CONNECTED") return "GRACE";
  return null;
}

export function presenceView(
  row: PresenceRow,
  currentSessionId: string,
  hasOwnedSession: boolean,
  dispatchEligible: boolean,
): Omit<SupportPresence, "today"> {
  const dispatchable = dispatchEligible && hasOwnedSession && isPresenceDispatchable({
    availability: row.availability,
    connectionState: row.connectionState,
    lastConfirmedAt: row.lastConfirmedAt,
    disconnectedSince: row.disconnectedSince,
    dispatchPaused: row.dispatchPaused,
    hasOwnedSession,
  });
  return {
    adminUserId: row.adminUserId,
    availability: row.availability,
    connectionState: row.connectionState,
    lastConnectedAt: iso(row.lastConnectedAt),
    lastConfirmedAt: iso(row.lastConfirmedAt),
    disconnectedSince: iso(row.disconnectedSince),
    dispatchPaused: row.dispatchPaused,
    dispatchable,
    reason: presenceReason(row, currentSessionId, hasOwnedSession, dispatchable, dispatchEligible),
    stateRevision: numberValue(row.stateRevision),
    activeLoad: row.activeLoad,
    version: numberValue(row.version),
    ownedByAnotherSession: row.authSessionId !== null && row.authSessionId !== currentSessionId,
    unbound: row.authSessionId === null,
  };
}

export async function presenceHasOwnedSession(client: PoolClient, appId: string, adminUserId: string, sessionId: string): Promise<boolean> {
  return Boolean((await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM "zzsh_auth_admin"."session" a
        WHERE a."id" = $1 AND a."userId" = $2 AND a."locked" = false AND a."expiresAt" > clock_timestamp()
     ) AS "present"`,
    [sessionId, adminUserId],
  )).rows[0]?.present);
}

export function hasPresencePermission(access: EffectiveAdminAccess | null): boolean {
  return hasPermission(access, ADMIN_PERMISSION.imSupportPresence);
}

export async function presenceIdentityReady(client: PoolClient, appId: string, adminUserId: string): Promise<boolean> {
  const row = (await client.query<{ accountId: string; identityMarker: string }>(
    `SELECT "account_id" AS "accountId", "identity_marker" AS "identityMarker"
       FROM "zzsh_iam"."im_identity_mapping"
      WHERE "provider" = 'yunxin' AND "app_id" = $1 AND "realm" = 'admin' AND "identity_kind" = 'ADMIN'
        AND "platform_subject_id" = $2 AND "status" = 'READY'`,
    [appId, adminUserId],
  )).rows[0];
  if (!row) return false;
  const key = { provider: "yunxin" as const, appId, realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: adminUserId };
  return row.accountId === deriveYunxinAccountId(key) && row.identityMarker === buildYunxinIdentityMarker(key);
}

export function canDispatchPresence(access: EffectiveAdminAccess | null, identityReady: boolean): boolean {
  return access?.status === "ACTIVE"
    && identityReady
    && hasPermission(access, ADMIN_PERMISSION.imSupportRead)
    && hasPermission(access, ADMIN_PERMISSION.imSupportAccept);
}

export async function serverTime(client: PoolClient): Promise<string> {
  return (await client.query<{ serverTime: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "serverTime"`,
  )).rows[0]!.serverTime;
}

export async function readOwnPresence(options: ConsultationRouteOptions, context: AdminContext): Promise<SupportPresence> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    await convergeSupportPresenceForAdmin(client, options.appId, context.userId);
    const row = (await client.query<PresenceRow>(PRESENCE_SELECT, [options.appId, context.userId])).rows[0];
    const today = await readSupportToday(client, options.appId, context.userId);
    if (!row) return { ...defaultPresence(context.userId), today };
    const hasOwnedSession = await presenceHasOwnedSession(client, options.appId, context.userId, context.sessionId)
      && await hasOpenPresenceSession(client, options.appId, context.userId);
    const dispatchEligible = canDispatchPresence(access, await presenceIdentityReady(client, options.appId, context.userId));
    return { ...presenceView(row, context.sessionId, hasOwnedSession, dispatchEligible), today };
  });
}

export async function updatePresenceConnection(
  client: PoolClient,
  appId: string,
  context: AdminContext,
  connectionState: SupportConnectionState,
  connectionId: string,
): Promise<{ row: PresenceRow | null; hasOwnedSession: boolean }> {
  const confirmed = connectionState === "CONNECTED";
  const row = (await client.query<PresenceRow>(
    `UPDATE "zzsh_iam"."im_support_presence"
        SET "connection_state" = $4,
            "last_connected_at" = CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE "last_connected_at" END,
            "last_confirmed_at" = CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE "last_confirmed_at" END,
            "disconnected_since" = CASE WHEN $4 = 'CONNECTED' THEN NULL ELSE COALESCE("disconnected_since", clock_timestamp()) END,
            "dispatch_paused" = CASE WHEN $4 = 'CONNECTED' THEN false ELSE "dispatch_paused" END,
            "connection_expires_at" = clock_timestamp() + interval '120 seconds',
            "state_revision" = "state_revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "auth_session_id" = $3
        AND "connection_id" = $5 AND "availability" = 'AVAILABLE'
      RETURNING "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
                "last_connected_at" AS "lastConnectedAt", "last_confirmed_at" AS "lastConfirmedAt",
                "disconnected_since" AS "disconnectedSince", "dispatch_paused" AS "dispatchPaused",
                "state_revision" AS "stateRevision", "connection_id" AS "connectionId", "connection_expires_at" AS "connectionExpiresAt", "active_load" AS "activeLoad", "version", "auth_session_id" AS "authSessionId"`,
    [appId, context.userId, context.sessionId, connectionState, connectionId],
  )).rows[0] ?? null;
  if (confirmed && row) {
    await client.query(
      `UPDATE "zzsh_iam"."im_support_presence_session"
          SET "last_heartbeat_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "ended_at" IS NULL`,
      [appId, context.userId],
    );
  }
  const hasOwnedSession = await presenceHasOwnedSession(client, appId, context.userId, context.sessionId)
    && Boolean((await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM "zzsh_iam"."im_support_presence_session"
          WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "ended_at" IS NULL
       ) AS "present"`,
      [appId, context.userId],
    )).rows[0]?.present);
  return { row, hasOwnedSession };
}

export function heartbeatSnapshot(row: PresenceRow | undefined): Pick<SupportPresenceHeartbeat, "disconnectedSince" | "dispatchPaused" | "stateRevision"> {
  return {
    disconnectedSince: iso(row?.disconnectedSince ?? null),
    dispatchPaused: row?.dispatchPaused ?? false,
    stateRevision: numberValue(row?.stateRevision ?? 1),
  };
}

/** One heartbeat for every connection state; only CONNECTED advances trusted liveness. */
export async function heartbeatOwnPresence(
  options: ConsultationRouteOptions,
  context: AdminContext,
  connectionState: SupportConnectionState,
  stateRevision: number,
  connectionId: string,
): Promise<SupportPresenceHeartbeat> {
  if (!Number.isSafeInteger(stateRevision) || stateRevision < 1) throw invalid("Presence state revision is invalid");
  if (typeof connectionId !== "string" || !CONNECTION_ID_PATTERN.test(connectionId)) throw invalid("Connection id is invalid");
  return withTransaction(options.pool, async (client) => {
    // Session -> presence is the single lock order for heartbeat, lock/unlock and
    // explicit presence writes. Revalidate the session after acquiring the row.
    const session = (await client.query<{ locked: boolean; expired: boolean }>(
      `SELECT "locked", "expiresAt" <= clock_timestamp() AS expired
         FROM "zzsh_auth_admin"."session"
        WHERE "id" = $1 AND "userId" = $2
        FOR UPDATE`,
      [context.sessionId, context.userId],
    )).rows[0];
    const now = await serverTime(client);
    if (!session || session.expired) {
      await convergeSupportPresenceForAdmin(client, options.appId, context.userId);
      const row = (await client.query<PresenceRow>(PRESENCE_SELECT, [options.appId, context.userId])).rows[0];
      return { ok: false, dispatchable: false, reason: "SESSION_INVALID", ...heartbeatSnapshot(row), serverTime: now };
    }
    if (session.locked) {
      const row = (await client.query<PresenceRow>(PRESENCE_SELECT, [options.appId, context.userId])).rows[0];
      return { ok: false, dispatchable: false, reason: "LOCKED", ...heartbeatSnapshot(row), serverTime: now };
    }
    await convergeSupportPresenceForAdmin(client, options.appId, context.userId);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    const current = (await client.query<PresenceRow>(`${PRESENCE_SELECT} FOR UPDATE`, [options.appId, context.userId])).rows[0];
    if (!hasPresencePermission(access)) {
      return { ok: false, dispatchable: false, reason: "FORBIDDEN", ...heartbeatSnapshot(current), serverTime: now };
    }
    if (!current) {
      return { ok: false, dispatchable: false, reason: "NOT_OWNER", disconnectedSince: null, dispatchPaused: false, stateRevision: 1, serverTime: now };
    }
    if (current.authSessionId !== context.sessionId) {
      return {
        ok: false,
        dispatchable: false,
        reason: current.availability === "AVAILABLE" ? "OTHER_WINDOW" : "NOT_OWNER",
        ...heartbeatSnapshot(current),
        serverTime: now,
      };
    }
    if (!ownsPresenceConnection(current, context.sessionId, connectionId)) {
      return {
        ok: false,
        dispatchable: false,
        reason: "STALE_CONNECTION",
        ...heartbeatSnapshot(current),
        serverTime: now,
      };
    }
    if (numberValue(current.stateRevision) !== stateRevision) {
      return { ok: false, dispatchable: false, reason: "STALE_STATE", ...heartbeatSnapshot(current), serverTime: now };
    }
    if (current.availability !== "AVAILABLE") {
      return { ok: false, dispatchable: false, reason: "ENDED", ...heartbeatSnapshot(current), serverTime: now };
    }
    const updated = await updatePresenceConnection(client, options.appId, context, connectionState, connectionId);
    const row = updated.row!;
    const dispatchEligible = canDispatchPresence(access, await presenceIdentityReady(client, options.appId, context.userId));
    const dispatchable = dispatchEligible && isPresenceDispatchable({
      availability: row.availability,
      connectionState: row.connectionState,
      lastConfirmedAt: row.lastConfirmedAt,
      disconnectedSince: row.disconnectedSince,
      dispatchPaused: row.dispatchPaused,
      hasOwnedSession: updated.hasOwnedSession,
    });
    const today = await readSupportToday(client, options.appId, context.userId);
    return {
      ok: updated.hasOwnedSession,
      dispatchable,
      reason: presenceReason(row, context.sessionId, updated.hasOwnedSession, dispatchable, dispatchEligible),
      disconnectedSince: iso(row.disconnectedSince),
      dispatchPaused: row.dispatchPaused,
      stateRevision: numberValue(row.stateRevision),
      today,
      serverTime: now,
    };
  });
}

/** Locked-page liveness only extends trusted time; it never resumes dispatch by itself. */
export async function heartbeatLockedOwnPresence(
  options: ConsultationRouteOptions,
  context: AdminContext,
): Promise<{ ok: boolean; serverTime: string }> {
  if (!context.sessionLocked) throw conflict("Session is not locked");
  return withTransaction(options.pool, async (client) => {
    const session = (await client.query<{ locked: boolean; expired: boolean }>(
      `SELECT "locked", "expiresAt" <= clock_timestamp() AS expired
         FROM "zzsh_auth_admin"."session"
        WHERE "id" = $1 AND "userId" = $2
        FOR UPDATE`,
      [context.sessionId, context.userId],
    )).rows[0];
    const now = await serverTime(client);
    if (!session || session.expired || !session.locked) return { ok: false, serverTime: now };
    const converged = await convergeSupportPresenceForAdmin(client, options.appId, context.userId);
    if (converged.ended) return { ok: false, serverTime: now };
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPresencePermission(access)) return { ok: false, serverTime: now };
    const updated = await client.query(
      `UPDATE "zzsh_iam"."im_support_presence"
          SET "last_confirmed_at" = clock_timestamp(),
              "connection_state" = 'DISCONNECTED',
              "disconnected_since" = COALESCE("disconnected_since", clock_timestamp()),
              "dispatch_paused" = true,
              "connection_expires_at" = clock_timestamp() + interval '120 seconds',
              "state_revision" = "state_revision" + 1,
              "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "auth_session_id" = $3
          AND "availability" = 'AVAILABLE'`,
      [options.appId, context.userId, context.sessionId],
    );
    if ((updated.rowCount ?? 0) > 0) {
      await client.query(
        `UPDATE "zzsh_iam"."im_support_presence_session"
            SET "last_heartbeat_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "ended_at" IS NULL`,
        [options.appId, context.userId],
      );
    }
    return { ok: (updated.rowCount ?? 0) > 0, serverTime: now };
  });
}

export async function closePresenceSessions(
  client: PoolClient,
  appId: string,
  adminUserId: string,
  reason: "PAUSED" | "OFF_DUTY" | "TAKEN_OVER",
  endedAt?: Date,
): Promise<void> {
  await client.query(
    `UPDATE "zzsh_iam"."im_support_presence_session"
        SET "ended_at" = GREATEST(COALESCE($4::timestamptz, clock_timestamp()), "started_at"), "end_reason" = $3
      WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "ended_at" IS NULL`,
    [appId, adminUserId, reason, endedAt ?? null],
  );
}

export async function openPresenceSession(client: PoolClient, appId: string, adminUserId: string): Promise<void> {
  await client.query(
    `INSERT INTO "zzsh_iam"."im_support_presence_session"
      ("id", "app_id", "admin_user_id", "metric_version")
     VALUES ($1, $2, $3, 2)
     ON CONFLICT ("app_id", "admin_user_id") WHERE "ended_at" IS NULL DO NOTHING`,
    [`im_presence_${randomUUID().replaceAll("-", "")}`, appId, adminUserId],
  );
}

export async function hasOpenPresenceSession(client: PoolClient, appId: string, adminUserId: string): Promise<boolean> {
  return Boolean((await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM "zzsh_iam"."im_support_presence_session"
        WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "ended_at" IS NULL
     ) AS "present"`,
    [appId, adminUserId],
  )).rows[0]?.present);
}

export async function updateOwnPresence(
  options: ConsultationRouteOptions,
  context: AdminContext,
  input: { availability: SupportAvailability; connectionState: SupportConnectionState; version?: number; takeover?: boolean; connectionId?: string },
  requestId: string,
): Promise<SupportPresence> {
  if (input.connectionId === undefined) throw conflict("客户端版本已更新，请刷新页面后再操作接待状态");
  if (!CONNECTION_ID_PATTERN.test(input.connectionId)) throw invalid("Connection id is invalid");
  const connectionId = input.connectionId;
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportPresence)) {
      throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    }
    // Hold the caller's session row until the presence write commits. This serializes
    // presence with /pin/lock (session -> presence) and closes the race where a
    // takeover that passed the earlier plain session check could write after lock.
    const session = await client.query<{ locked: boolean }>(
      `SELECT "locked" FROM "zzsh_auth_admin"."session"
        WHERE "id" = $1 AND "userId" = $2 AND "expiresAt" > clock_timestamp()
        FOR UPDATE`,
      [context.sessionId, context.userId],
    );
    if (!session.rows[0]) throw new SecurityApiError(401, "UNAUTHENTICATED", "Session is not available");
    if (session.rows[0].locked) throw new SecurityApiError(423, "FORBIDDEN", "Account locked");
    await convergeSupportPresenceForAdmin(client, options.appId, context.userId);
    const current = (await client.query<PresenceRow>(PRESENCE_SELECT, [options.appId, context.userId])).rows[0];
    const currentVersion = current ? numberValue(current.version) : 0;
    if (current && (input.version === undefined || input.version !== currentVersion)) {
      throw conflict("Presence version is stale");
    }
    if (!current && input.version !== undefined && input.version !== 0) {
      throw conflict("Presence version is stale");
    }
    const starting = input.availability === "AVAILABLE";
    const takeover = input.takeover === true;
    const ownsConnection = ownsPresenceConnection(current, context.sessionId, connectionId);
    if (takeover && !starting) throw conflict("Presence takeover requires an available start");
    if (starting && input.connectionState !== "CONNECTED" && !takeover) {
      throw conflict("Reception requires an active connection");
    }
    // A takeover may be requested before the new page has connected. It still
    // transfers ownership and opens the new interval; dispatch stays paused until
    // the first CONNECTED heartbeat, so the old page cannot be raced.
    if (current?.authSessionId && current.authSessionId !== context.sessionId && !takeover) {
      throw conflict("Presence is owned by another session");
    }
    // A pre-0184 row has no owner. A passive AVAILABLE sync must not turn its old
    // state back into dispatchable reception; only an explicit start may bind.
    if (current?.authSessionId === null && current.availability === "AVAILABLE" && starting && !takeover) {
      throw conflict("Presence is unbound; explicit start required");
    }
    // A session can have multiple tabs; ordinary writes require the claimed tab.
    if (!takeover && !ownsConnection) throw conflict("Presence connection belongs to another window; refresh or reconnect");
    await options.testPresenceBarrier?.(context);
    // A new owner has not connected yet, regardless of the state its request supplied.
    const connectionState: SupportConnectionState = takeover && !ownsConnection ? "CONNECTING" : input.connectionState;
    const confirmed = connectionState === "CONNECTED";
    // The caller is the current connection/reception owner. A stop keeps that
    // ownership so the same page can continue reading and restart; the WHERE
    // clause still uses the caller's session and never lets a stale window close
    // a newer owner.
    const callerSessionId = context.sessionId;
    const newOwnerSessionId = context.sessionId;
    let persisted: PresenceRow | undefined;
    if (!current) {
      const inserted = await client.query<PresenceRow>(
        `INSERT INTO "zzsh_iam"."im_support_presence"
          ("app_id", "admin_user_id", "availability", "connection_state", "last_connected_at",
           "last_confirmed_at", "disconnected_since", "dispatch_paused", "auth_session_id", "connection_id", "connection_expires_at")
         VALUES ($1,$2,$3,$4,
                 CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE NULL END,
                 CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE NULL END,
                 CASE WHEN $3 = 'AVAILABLE' AND $4 <> 'CONNECTED' THEN clock_timestamp() ELSE NULL END,
                 $3 = 'AVAILABLE' AND $4 <> 'CONNECTED', $5, $6,
                 CASE WHEN $6 IS NULL THEN NULL ELSE clock_timestamp() + interval '120 seconds' END)
         ON CONFLICT ("app_id", "admin_user_id") DO NOTHING
         RETURNING "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
                   "last_connected_at" AS "lastConnectedAt", "last_confirmed_at" AS "lastConfirmedAt",
                   "disconnected_since" AS "disconnectedSince", "dispatch_paused" AS "dispatchPaused",
                   "state_revision" AS "stateRevision", "connection_id" AS "connectionId", "connection_expires_at" AS "connectionExpiresAt", "active_load" AS "activeLoad", "version", "auth_session_id" AS "authSessionId"`,
        [options.appId, context.userId, input.availability, connectionState, newOwnerSessionId, connectionId],
      );
      persisted = inserted.rows[0];
    } else {
      const updated = await client.query<PresenceRow>(
        `UPDATE "zzsh_iam"."im_support_presence"
            SET "availability" = $3,
                "connection_state" = $4,
                "last_connected_at" = CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE "last_connected_at" END,
                "last_confirmed_at" = CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp()
                                           WHEN $8::boolean AND $3 = 'AVAILABLE' THEN NULL
                                           ELSE "last_confirmed_at" END,
                "disconnected_since" = CASE WHEN $4 = 'CONNECTED' THEN NULL
                                            WHEN $3 = 'AVAILABLE' THEN COALESCE("disconnected_since", clock_timestamp())
                                            ELSE NULL END,
                "dispatch_paused" = ($3 = 'AVAILABLE' AND $4 <> 'CONNECTED'),
                "auth_session_id" = $7,
                "connection_id" = CASE WHEN $8::boolean THEN $9 ELSE "connection_id" END,
                "connection_expires_at" = CASE WHEN $8::boolean THEN clock_timestamp() + interval '120 seconds' ELSE "connection_expires_at" END,
                "version" = "version" + 1,
                "state_revision" = "state_revision" + 1,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "version" = $5
            AND ("auth_session_id" = $6
                 OR ($8::boolean AND $3 = 'AVAILABLE')
                 OR ("auth_session_id" IS NULL AND ("availability" <> 'AVAILABLE' OR $3 <> 'AVAILABLE')))
          RETURNING "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
                    "last_connected_at" AS "lastConnectedAt", "last_confirmed_at" AS "lastConfirmedAt",
                    "disconnected_since" AS "disconnectedSince", "dispatch_paused" AS "dispatchPaused",
                    "state_revision" AS "stateRevision", "connection_id" AS "connectionId", "connection_expires_at" AS "connectionExpiresAt", "active_load" AS "activeLoad", "version", "auth_session_id" AS "authSessionId"`,
        [options.appId, context.userId, input.availability, connectionState, currentVersion, callerSessionId, newOwnerSessionId, takeover, connectionId],
      );
      persisted = updated.rows[0];
    }
    if (!persisted) throw conflict("Presence version is stale");
    if (takeover && !ownsConnection) {
      // Ownership moves at one server timestamp: close the old interval, then open
      // the new one. The old page's next heartbeat sees TAKEN_OVER and lets go.
      const takenOverAt = new Date();
      await closePresenceSessions(client, options.appId, context.userId, "TAKEN_OVER", takenOverAt);
      if (starting) await openPresenceSession(client, options.appId, context.userId);
    } else if (starting) {
      await openPresenceSession(client, options.appId, context.userId);
      if (confirmed) {
        await client.query(
          `UPDATE "zzsh_iam"."im_support_presence_session"
              SET "last_heartbeat_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "ended_at" IS NULL`,
          [options.appId, context.userId],
        );
      }
    } else {
      await closePresenceSessions(client, options.appId, context.userId, input.availability === "PAUSED" ? "PAUSED" : "OFF_DUTY");
    }
    const hasOwnedSession = starting && await hasOpenPresenceSession(client, options.appId, context.userId)
      && await presenceHasOwnedSession(client, options.appId, context.userId, context.sessionId);
    const dispatchEligible = canDispatchPresence(access, await presenceIdentityReady(client, options.appId, context.userId));
    const today = await readSupportToday(client, options.appId, context.userId);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.presence.updated",
      objectType: "im_support_presence",
      objectId: context.userId,
      outcome: "SUCCESS",
      requestId,
      details: { availability: input.availability, connectionState, appId: options.appId, takeover },
    });
    return { ...presenceView(persisted, context.sessionId, hasOwnedSession, dispatchEligible), today };
  });
  if (result.availability === "AVAILABLE" && result.dispatchable) {
    options.wakeDispatch?.();
    if (options.autoAssignConsultations) void autoAssignWaitingConsultations(options, 5).catch(() => undefined);
  }
  return result;
}

export type SupportConnectionClaim = {
  ok: boolean;
  reason: "CLAIMED" | "OTHER_WINDOW" | "LOCKED" | "FORBIDDEN" | "SESSION_INVALID";
  version?: number;
  stateRevision?: number;
};

/**
 * Before any NIM login, one auth session must win the account's connection slot.
 * This is a server-side claim, not a UI convention: two browser sessions that
 * both see an empty/unbound presence race on the same row and only one logs in.
 * It never starts reception; availability and intervals are unchanged.
 */
export async function claimSupportConnection(
  options: ConsultationRouteOptions,
  context: AdminContext,
  connectionId: string,
): Promise<SupportConnectionClaim> {
  if (typeof connectionId !== "string" || !CONNECTION_ID_PATTERN.test(connectionId)) throw invalid("Connection id is invalid");
  return withTransaction(options.pool, async (client) => {
    const session = (await client.query<{ locked: boolean; expired: boolean }>(
      `SELECT "locked", "expiresAt" <= clock_timestamp() AS expired
         FROM "zzsh_auth_admin"."session"
        WHERE "id" = $1 AND "userId" = $2
        FOR UPDATE`,
      [context.sessionId, context.userId],
    )).rows[0];
    if (!session || session.expired) return { ok: false, reason: "SESSION_INVALID" };
    if (session.locked) return { ok: false, reason: "LOCKED" };
    await convergeSupportPresenceForAdmin(client, options.appId, context.userId);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) return { ok: false, reason: "FORBIDDEN" };
    let row = (await client.query<PresenceRow>(`${PRESENCE_SELECT} FOR UPDATE`, [options.appId, context.userId])).rows[0];
    if (!row) {
      const inserted = await client.query<{ version: string | number; stateRevision: string | number }>(
        `INSERT INTO "zzsh_iam"."im_support_presence"
          ("app_id", "admin_user_id", "availability", "connection_state", "auth_session_id", "connection_id", "connection_expires_at")
         VALUES ($1, $2, 'OFF_DUTY', 'CONNECTING', $3, $4, clock_timestamp() + interval '120 seconds')
         ON CONFLICT ("app_id", "admin_user_id") DO NOTHING
         RETURNING "version", "state_revision" AS "stateRevision"`,
        [options.appId, context.userId, context.sessionId, connectionId],
      );
      if (inserted.rows[0]) {
        return { ok: true, reason: "CLAIMED", version: numberValue(inserted.rows[0].version), stateRevision: numberValue(inserted.rows[0].stateRevision) };
      }
      row = (await client.query<PresenceRow>(`${PRESENCE_SELECT} FOR UPDATE`, [options.appId, context.userId])).rows[0];
    }
    if (!row) return { ok: false, reason: "OTHER_WINDOW" };
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    const sameSession = row.authSessionId === context.sessionId;
    const sameInstance = sameSession && (row.connectionId === null || row.connectionId === connectionId);
    const noOwner = row.authSessionId === null && row.connectionId === null;
    const leaseExpired = row.connectionExpiresAt === null || new Date(row.connectionExpiresAt).getTime() <= now.getTime();
    // Same tab reconnects reuse the same id. A different tab/session may only take
    // over a non-reception slot after its bounded connection lease expires.
    const canClaim = sameInstance || noOwner || (leaseExpired && (sameSession || row.availability !== "AVAILABLE"));
    if (!canClaim) {
      return { ok: false, reason: "OTHER_WINDOW", version: numberValue(row.version), stateRevision: numberValue(row.stateRevision) };
    }
    const updated = await client.query<{ version: string | number; stateRevision: string | number }>(
      `UPDATE "zzsh_iam"."im_support_presence"
          SET "auth_session_id" = $3,
              "connection_id" = $4,
              "connection_expires_at" = clock_timestamp() + interval '120 seconds',
              "connection_state" = 'CONNECTING',
              "dispatch_paused" = CASE WHEN "availability" = 'AVAILABLE' THEN true ELSE "dispatch_paused" END,
              "version" = "version" + 1,
              "state_revision" = "state_revision" + 1,
              "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "admin_user_id" = $2
          AND (
            ("auth_session_id" = $3 AND ("connection_id" IS NULL OR "connection_id" = $4))
            OR ("auth_session_id" IS NULL AND "connection_id" IS NULL)
            OR ("auth_session_id" = $3 AND ("connection_expires_at" IS NULL OR "connection_expires_at" <= clock_timestamp()))
            OR ("availability" <> 'AVAILABLE' AND ("connection_id" IS NULL OR "connection_expires_at" IS NULL OR "connection_expires_at" <= clock_timestamp()))
          )
        RETURNING "version", "state_revision" AS "stateRevision"`,
      [options.appId, context.userId, context.sessionId, connectionId],
    );
    if (!updated.rows[0]) return { ok: false, reason: "OTHER_WINDOW" };
    return { ok: true, reason: "CLAIMED", version: numberValue(updated.rows[0].version), stateRevision: numberValue(updated.rows[0].stateRevision) };
  });
}

export type SupportConnectionRelease = { released: boolean };

/**
 * Page-close handoff. It always clears this connection instance so the next tab
 * can take over. An AVAILABLE row keeps its auth-session binding, reception
 * interval and timing; another session still needs explicit takeover. An
 * off-duty row also clears the session binding.
 */
export async function releaseSupportConnection(
  options: ConsultationRouteOptions,
  context: AdminContext,
  connectionId: string,
): Promise<SupportConnectionRelease> {
  if (typeof connectionId !== "string" || !CONNECTION_ID_PATTERN.test(connectionId)) throw invalid("Connection id is invalid");
  return withTransaction(options.pool, async (client) => {
    const session = (await client.query<{ locked: boolean; expired: boolean }>(
      `SELECT "locked", "expiresAt" <= clock_timestamp() AS expired
         FROM "zzsh_auth_admin"."session"
        WHERE "id" = $1 AND "userId" = $2
        FOR UPDATE`,
      [context.sessionId, context.userId],
    )).rows[0];
    if (!session || session.expired) return { released: false };
    const result = await client.query(
      `UPDATE "zzsh_iam"."im_support_presence"
          SET "auth_session_id" = CASE WHEN "availability" = 'AVAILABLE' THEN "auth_session_id" ELSE NULL END,
              "connection_id" = NULL,
              "connection_expires_at" = NULL,
              "version" = "version" + 1,
              "state_revision" = "state_revision" + 1,
              "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "admin_user_id" = $2
          AND "auth_session_id" = $3 AND "connection_id" = $4`,
      [options.appId, context.userId, context.sessionId, connectionId],
    );
    return { released: (result.rowCount ?? 0) > 0 };
  });
}

export type SupportConnectionLease = {
  ok: boolean;
  reason: "OWNED" | "STALE_CONNECTION" | "SESSION_INVALID" | "LOCKED";
  expiresAt?: string;
};

/**
 * Off-duty pages still own the exclusive connection slot. This lightweight lease
 * refresh keeps it through quiet periods; after an abnormal exit the lease expires
 * and another tab can recover without waiting for auth-session expiry.
 */
export async function refreshSupportConnection(
  options: ConsultationRouteOptions,
  context: AdminContext,
  connectionId: string,
): Promise<SupportConnectionLease> {
  if (typeof connectionId !== "string" || !CONNECTION_ID_PATTERN.test(connectionId)) throw invalid("Connection id is invalid");
  return withTransaction(options.pool, async (client) => {
    const session = (await client.query<{ locked: boolean; expired: boolean }>(
      `SELECT "locked", "expiresAt" <= clock_timestamp() AS expired
         FROM "zzsh_auth_admin"."session"
        WHERE "id" = $1 AND "userId" = $2
        FOR UPDATE`,
      [context.sessionId, context.userId],
    )).rows[0];
    if (!session || session.expired) return { ok: false, reason: "SESSION_INVALID" };
    if (session.locked) return { ok: false, reason: "LOCKED" };
    const row = (await client.query<{ expiresAt: Date }>(
      `UPDATE "zzsh_iam"."im_support_presence"
          SET "connection_expires_at" = clock_timestamp() + interval '120 seconds',
              "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "admin_user_id" = $2
          AND "auth_session_id" = $3 AND "connection_id" = $4
        RETURNING "connection_expires_at" AS "expiresAt"`,
      [options.appId, context.userId, context.sessionId, connectionId],
    )).rows[0];
    if (!row) return { ok: false, reason: "STALE_CONNECTION" };
    return { ok: true, reason: "OWNED", expiresAt: iso(row.expiresAt) ?? undefined };
  });
}
