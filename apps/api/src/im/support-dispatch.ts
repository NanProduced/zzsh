import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { orderDispatchLockKey } from "../order/payment-confirmation";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "./identity-lifecycle";
import {
  SUPPORT_LOST_SECONDS,
  supportDispatchablePresenceSql,
  supportStrictOnlinePresenceSql,
} from "./support-presence-policy";

export type SupportCandidate = {
  adminUserId: string;
  adminName: string;
  accountId: string;
  allGames: boolean;
  gameIds: string[];
  complaint: boolean;
  connectionState?: string;
  lastConfirmedAt?: string | null;
  disconnectedSince?: string | null;
};

/**
 * 每客服同时占用的接待上限默认值。
 * ponytail: 同一意图曾由 im_support_presence.capacity 表达（0032_yunxin_consultation.sql:7，DEFAULT 3，
 * CHECK 1..100），该列在 0037_oim_support_dispatch.sql:2 被删除；服务端改由配置承接，默认沿用 3，
 * 不为凑数放大容量。配置未接线时（auth-runtime.ts 尚未传参）用本默认值，满载即排队。
 */
export const SUPPORT_CONCURRENCY_DEFAULT = 3;
export const SUPPORT_CONCURRENCY_MAX = 100;

export function resolveSupportConcurrencyLimit(value?: number | null): number {
  if (value === undefined || value === null) return SUPPORT_CONCURRENCY_DEFAULT;
  if (!Number.isSafeInteger(value) || value < 1 || value > SUPPORT_CONCURRENCY_MAX) {
    throw new Error("Invalid support concurrency limit");
  }
  return value;
}

/** 满载排队与无人接待是两件事：前者有客服只是都满，后者根本没有合格在线客服。 */
export type SupportQueueReason = "NO_ONLINE_STAFF" | "ALL_AT_CAPACITY";
export type SupportReserveOutcome =
  | { candidate: SupportCandidate; reason: null }
  | { candidate: null; reason: SupportQueueReason };
/** Transaction-local lock coverage, carried explicitly to every candidate read. */
export type LockedSupportRoster = Readonly<{ client: PoolClient; appId: string; ids: readonly string[];
  scopes: readonly { admin_user_id: string; game_id: string }[];
  scopeModes: readonly { admin_user_id: string; mode: string }[] }>;

export async function lockDispatchGate(client: PoolClient, appId: string): Promise<void> {
  await client.query(`SET LOCAL lock_timeout = '750ms'`);
  await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [orderDispatchLockKey(appId)]);
}

/** Shared by assignment AND consultation close/transfer/recovery before object locks.
 * ponytail: lock the App's staff set in short transactions; narrow batches if its size becomes material.
 * NOWAIT aborts the entire attempt (never skips a staff member). It also prevents
 * cycles with IAM's actor -> role -> target ordering, without rewriting IAM.
 */
export async function lockSupportMutation(client: PoolClient, appId: string, userIds: string[] = [], adminIds: string[] = []): Promise<LockedSupportRoster> {
  await lockDispatchGate(client, appId);
  if (userIds.length) await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, [userIds]);
  const ids = (await client.query<{ id: string }>(`SELECT admin_user_id AS id FROM zzsh_iam.im_support_presence WHERE app_id=$1
    UNION SELECT unnest($2::text[])`, [appId, adminIds])).rows.map((r) => r.id);
  const security = await client.query<{ admin_user_id: string; mode: string }>(`SELECT admin_user_id, game_scope_mode AS mode FROM zzsh_iam.admin_security WHERE admin_user_id=ANY($1::text[]) ORDER BY admin_user_id FOR SHARE NOWAIT`, [ids]);
  // IAM profile/freeze writes and assignment FKs share these subject rows.
  await client.query(`SELECT id FROM zzsh_auth_admin."user" WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE NOWAIT`, [ids]);
  await client.query(`SELECT r.id FROM zzsh_iam.admin_role r WHERE EXISTS
    (SELECT 1 FROM zzsh_iam.admin_user_role ur WHERE ur.role_id=r.id AND ur.admin_user_id=ANY($1::text[]))
    ORDER BY r.id FOR SHARE NOWAIT`, [ids]);
  const presence = await client.query<{ admin_user_id: string }>(`SELECT admin_user_id FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=ANY($2::text[])
    ORDER BY admin_user_id FOR UPDATE NOWAIT`, [appId, ids]);
  const mappings = await client.query<{ platform_subject_id: string }>(`SELECT id,platform_subject_id FROM zzsh_iam.im_identity_mapping WHERE provider='yunxin' AND app_id=$1 AND realm='admin' AND identity_kind='ADMIN' AND platform_subject_id=ANY($2::text[])
    ORDER BY id FOR SHARE NOWAIT`, [appId, ids]);
  const scopes = await client.query<{ admin_user_id: string; game_id: string }>(`SELECT admin_user_id,game_id FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=ANY($1::text[])
    ORDER BY admin_user_id,game_id FOR SHARE NOWAIT`, [ids]);
  const secured = new Set(security.rows.map((r) => r.admin_user_id));
  const mapped = new Set(mappings.rows.map((r) => r.platform_subject_id));
  return { client, appId, ids: presence.rows.map((r) => r.admin_user_id).filter((id) => secured.has(id) && mapped.has(id)), scopes: scopes.rows, scopeModes: security.rows };
}

/** Read only after lockSupportMutation. Mapping ownership is checked, not merely its status. */
export async function readEligibleSupport(
  client: PoolClient,
  appId: string,
  locked: LockedSupportRoster,
  mode: "DISPATCHABLE" | "STRICT" = "DISPATCHABLE",
  sessionId?: string,
  connectionId?: string,
): Promise<SupportCandidate[]> {
  if (!locked || locked.client !== client || locked.appId !== appId) throw new Error("Candidate read requires this transaction's locked roster");
  const presenceSql = mode === "STRICT" ? supportStrictOnlinePresenceSql("p") : supportDispatchablePresenceSql("p");
  const rows = (await client.query<{
    adminUserId: string; adminName: string; accountId: string; identityMarker: string;
    connectionState: string; lastConfirmedAt: Date | string | null; disconnectedSince: Date | string | null;
  }>(
    `SELECT p.admin_user_id AS "adminUserId",u.name AS "adminName",m.account_id AS "accountId",m.identity_marker AS "identityMarker",
            p.connection_state AS "connectionState",p.last_confirmed_at AS "lastConfirmedAt",p.disconnected_since AS "disconnectedSince"
     FROM zzsh_iam.im_support_presence p JOIN zzsh_iam.admin_security s ON s.admin_user_id=p.admin_user_id
     JOIN zzsh_auth_admin."user" u ON u.id=p.admin_user_id
     JOIN zzsh_auth_admin."session" a ON a."id"=p.auth_session_id AND a."userId"=p.admin_user_id
       AND a.locked=false AND a."expiresAt">clock_timestamp()
     JOIN zzsh_iam.im_identity_mapping m ON m.provider='yunxin' AND m.app_id=p.app_id AND m.realm='admin'
       AND m.identity_kind='ADMIN' AND m.platform_subject_id=p.admin_user_id AND m.status='READY'
     WHERE p.app_id=$1 AND p.admin_user_id=ANY($2::text[]) AND s.status='ACTIVE' AND NOT u.suspended
       AND ($3::text IS NULL OR p.auth_session_id=$3)
       AND ($4::text IS NULL OR p.connection_id=$4)
       AND ${presenceSql}`, [appId, locked.ids, sessionId ?? null, connectionId ?? null])).rows;
  const result: SupportCandidate[] = [];
  for (const row of rows) {
    const key = { provider: "yunxin" as const, appId, realm: "admin", kind: "ADMIN" as const, platformSubjectId: row.adminUserId };
    if (row.accountId !== deriveYunxinAccountId(key) || row.identityMarker !== buildYunxinIdentityMarker(key)) continue;
    const access = await loadEffectiveAdminAccess(client, row.adminUserId);
    if (![ADMIN_PERMISSION.imSupportRead, ADMIN_PERMISSION.imSupportAccept].every((p) => hasPermission(access, p))) continue;
    const scopes = locked.scopes.filter((s) => s.admin_user_id === row.adminUserId);
    const allGames = access!.isBoss || locked.scopeModes.some((s) => s.admin_user_id === row.adminUserId && s.mode === "ALL_GAMES");
    const complaint = Boolean(access?.isBoss || hasPermission(access, ADMIN_PERMISSION.imSupportComplaint));
    result.push({
      ...row,
      allGames,
      gameIds: scopes.map((s) => s.game_id),
      complaint,
      lastConfirmedAt: row.lastConfirmedAt instanceof Date ? row.lastConfirmedAt.toISOString() : row.lastConfirmedAt,
      disconnectedSince: row.disconnectedSince instanceof Date ? row.disconnectedSince.toISOString() : row.disconnectedSince,
    });
  }
  return result;
}

/**
 * Online, eligible and (for complaints) complaint-authorized agents are candidates.
 * There is deliberately no hard workload cap; active_load remains a statistic.
 * A missing candidate is always NO_ONLINE_STAFF.
 */
export async function reserveSupportCandidateOutcome(client: PoolClient, appId: string, kind: "ORDER" | "SERVICE" | "COMPLAINT",
  candidates: SupportCandidate[], targetAdminId?: string, _concurrencyLimit?: number | null,
  _enforceCapacity = false, mode: "DISPATCHABLE" | "STRICT" = "DISPATCHABLE", sessionId?: string,
  connectionId?: string): Promise<SupportReserveOutcome> {
  // No hard capacity gate: the business assigns every paid order/new consultation
  // to an online eligible agent and keeps active_load as a display statistic only.
  const eligible = candidates.filter((c) => (!targetAdminId || c.adminUserId === targetAdminId)
    && (kind !== "COMPLAINT" || c.complaint));
  const field = kind === "ORDER" ? "last_order_assigned_at" : "last_consultation_assigned_at";
  const presenceSql = mode === "STRICT" ? supportStrictOnlinePresenceSql("p") : supportDispatchablePresenceSql("p");
  const selected = (await client.query<{ admin_user_id: string }>(`SELECT p."admin_user_id" FROM zzsh_iam.im_support_presence p
    WHERE p."app_id" = $1 AND p."admin_user_id" = ANY($2::text[]) AND ${presenceSql}
      AND ($3::text IS NULL OR p."auth_session_id" = $3)
      AND ($4::text IS NULL OR p."connection_id" = $4)
      AND EXISTS (SELECT 1 FROM zzsh_auth_admin."session" a
                   WHERE a."id" = p."auth_session_id" AND a."userId" = p."admin_user_id"
                     AND a.locked = false AND a."expiresAt" > clock_timestamp())
    ORDER BY p."${field}" ASC NULLS FIRST, p."admin_user_id" LIMIT 1`,
  [appId, eligible.map((c) => c.adminUserId), sessionId ?? null, connectionId ?? null])).rows[0];
  if (!selected) return { candidate: null, reason: "NO_ONLINE_STAFF" };
  await client.query(`UPDATE zzsh_iam.im_support_presence SET ${field}=clock_timestamp(),"updated_at"=clock_timestamp()
    ${kind === "ORDER" ? "" : ",active_load=active_load+1"} WHERE app_id=$1 AND admin_user_id=$2`, [appId, selected.admin_user_id]);
  return { candidate: eligible.find((c) => c.adminUserId === selected.admin_user_id)!, reason: null };
}

export async function reserveSupportCandidate(client: PoolClient, appId: string, kind: "ORDER" | "SERVICE" | "COMPLAINT",
  candidates: SupportCandidate[], targetAdminId?: string, concurrencyLimit?: number | null,
  mode: "DISPATCHABLE" | "STRICT" = "DISPATCHABLE", sessionId?: string, connectionId?: string): Promise<SupportCandidate | null> {
  return (await reserveSupportCandidateOutcome(client, appId, kind, candidates, targetAdminId, concurrencyLimit, false, mode, sessionId, connectionId)).candidate;
}

export type SupportReapOptions = {
  lostSeconds?: number;
};

/**
 * The dispatch tick's single session sweep:
 * - an expired owning auth session ends at its expiry time;
 * - a revoked/missing owning session ends at the last confirmed liveness;
 * - a 30-minute silent agent ends at the last confirmed liveness (LOST).
 * Every close re-checks the session owner so a newer takeover is never touched.
 */
export async function reapSupportPresenceSessions(
  client: PoolClient,
  appId: string,
  options: SupportReapOptions = {},
): Promise<{ sessions: number; presences: number }> {
  const lostSeconds = options.lostSeconds ?? SUPPORT_LOST_SECONDS;
  if (!Number.isSafeInteger(lostSeconds) || lostSeconds < 1) throw new Error("Invalid lost session window");

  const expired = await client.query<{ sessions: string | number; presences: string | number }>(
    `WITH expired AS (
       SELECT p."app_id", p."admin_user_id", p."auth_session_id",
              GREATEST(
                COALESCE(s."started_at", a."expiresAt"),
                LEAST(a."expiresAt", COALESCE(p."last_confirmed_at", s."started_at", a."expiresAt"))
              ) AS "ended_at"
         FROM "zzsh_auth_admin"."session" a
         JOIN "zzsh_iam"."im_support_presence" p ON a."id" = p."auth_session_id" AND a."userId" = p."admin_user_id"
         LEFT JOIN "zzsh_iam"."im_support_presence_session" s
           ON s."app_id" = p."app_id" AND s."admin_user_id" = p."admin_user_id" AND s."ended_at" IS NULL
        WHERE p."app_id" = $1 AND p."availability" = 'AVAILABLE'
          AND a."expiresAt" <= clock_timestamp()
        FOR UPDATE OF a, p
     ), closed AS (
       UPDATE "zzsh_iam"."im_support_presence_session" s
          SET "ended_at" = expired."ended_at", "end_reason" = 'SESSION_EXPIRED'
         FROM expired
        WHERE s."app_id" = expired."app_id" AND s."admin_user_id" = expired."admin_user_id"
          AND s."ended_at" IS NULL
        RETURNING s."admin_user_id"
     ), cleared AS (
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
         FROM expired
        WHERE p."app_id" = expired."app_id" AND p."admin_user_id" = expired."admin_user_id"
          AND p."auth_session_id" = expired."auth_session_id"
        RETURNING p."admin_user_id"
     )
     SELECT (SELECT count(*)::int FROM closed) AS "sessions",
            (SELECT count(*)::int FROM cleared) AS "presences"`,
    [appId],
  );

  const revoked = await client.query<{ sessions: string | number; presences: string | number }>(
    `WITH orphan AS (
       SELECT p."app_id", p."admin_user_id", p."auth_session_id",
              GREATEST(COALESCE(p."last_confirmed_at", s."started_at", clock_timestamp()), s."started_at") AS "ended_at"
         FROM "zzsh_iam"."im_support_presence" p
         LEFT JOIN "zzsh_iam"."im_support_presence_session" s
           ON s."app_id" = p."app_id" AND s."admin_user_id" = p."admin_user_id" AND s."ended_at" IS NULL
        WHERE p."app_id" = $1 AND p."availability" = 'AVAILABLE'
          AND (p."auth_session_id" IS NULL OR NOT EXISTS (
            SELECT 1 FROM "zzsh_auth_admin"."session" a
             WHERE a."id" = p."auth_session_id" AND a."userId" = p."admin_user_id"
               AND a."expiresAt" > clock_timestamp()))
        FOR UPDATE OF p
     ), closed AS (
       UPDATE "zzsh_iam"."im_support_presence_session" s
          SET "ended_at" = orphan."ended_at",
              "end_reason" = CASE WHEN orphan."auth_session_id" IS NULL THEN 'LOST' ELSE 'REVOKED' END
         FROM orphan
        WHERE s."app_id" = orphan."app_id" AND s."admin_user_id" = orphan."admin_user_id"
          AND s."ended_at" IS NULL
        RETURNING s."admin_user_id"
     ), cleared AS (
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
         FROM orphan
        WHERE p."app_id" = orphan."app_id" AND p."admin_user_id" = orphan."admin_user_id"
          AND p."auth_session_id" IS NOT DISTINCT FROM orphan."auth_session_id"
        RETURNING p."admin_user_id"
     )
     SELECT (SELECT count(*)::int FROM closed) AS "sessions",
            (SELECT count(*)::int FROM cleared) AS "presences"`,
    [appId],
  );

  const lost = await client.query<{ sessions: string | number; presences: string | number }>(
    `WITH lost AS (
       SELECT s."id" AS "session_id", s."app_id", s."admin_user_id",
              GREATEST(COALESCE(p."last_confirmed_at", s."started_at"), s."started_at") AS "ended_at"
         FROM "zzsh_iam"."im_support_presence" p
         JOIN "zzsh_iam"."im_support_presence_session" s
           ON p."app_id" = s."app_id" AND p."admin_user_id" = s."admin_user_id"
        WHERE s."app_id" = $1 AND s."ended_at" IS NULL
          AND p."availability" = 'AVAILABLE'
          AND COALESCE(p."last_confirmed_at", s."started_at")
              <= clock_timestamp() - ($2::int * interval '1 second')
        FOR UPDATE OF p, s
     ), closed AS (
       UPDATE "zzsh_iam"."im_support_presence_session" s
          SET "ended_at" = lost."ended_at", "end_reason" = 'LOST'
         FROM lost
        WHERE s."id" = lost."session_id"
        RETURNING s."admin_user_id"
     ), cleared AS (
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
         FROM lost
        WHERE p."app_id" = lost."app_id" AND p."admin_user_id" = lost."admin_user_id"
          AND p."auth_session_id" IS NOT NULL
        RETURNING p."admin_user_id"
     )
     SELECT (SELECT count(*)::int FROM closed) AS "sessions",
            (SELECT count(*)::int FROM cleared) AS "presences"`,
    [appId, lostSeconds],
  );

  const total = (row: { sessions: string | number; presences: string | number } | undefined) => ({
    sessions: Number(row?.sessions ?? 0),
    presences: Number(row?.presences ?? 0),
  });
  const parts = [total(expired.rows[0]), total(revoked.rows[0]), total(lost.rows[0])];
  return {
    sessions: parts.reduce((sum, part) => sum + part.sessions, 0),
    presences: parts.reduce((sum, part) => sum + part.presences, 0),
  };
}
