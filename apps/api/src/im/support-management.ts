import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  ADMIN_PERMISSION,
  hasPermission,
  loadEffectiveAdminAccess,
  type EffectiveAdminAccess,
} from "../auth/admin-authorization";
import { assertAdminContextInTransaction, type AdminContext } from "../auth/auth-security";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "./identity-lifecycle";
import type { SupportAvailability, SupportConnectionState } from "./consultation";

export const SUPPORT_HANDOVER_NOTE_MAX = 200;
export const SUPPORT_HANDOVER_DEFAULT_LIMIT = 20;
export const SUPPORT_HANDOVER_MAX_LIMIT = 50;
export const SUPPORT_AUDIT_DEFAULT_LIMIT = 20;
export const SUPPORT_AUDIT_MAX_LIMIT = 50;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUDIT_KINDS = new Set(["CONSULTATION", "ORDER_GROUP"]);

/** 北京时间自然日窗口；dateParam 是 SQL 参数占位符（$2 或 $3）。 */
function dayBounds(dateParam: string): string {
  const date = `COALESCE(${dateParam}::date, (now() AT TIME ZONE 'Asia/Shanghai')::date)`;
  return `
  SELECT (${date}::timestamp AT TIME ZONE 'Asia/Shanghai') AS day_start,
         ((${date}::timestamp + interval '1 day') AT TIME ZONE 'Asia/Shanghai') AS day_end`;
}

export type SupportDayCounts = { seconds: number; sessions: number; users: number };

export type SupportOverviewRow = {
  adminUserId: string;
  name: string;
  availability: SupportAvailability;
  connectionState: SupportConnectionState;
  activeLoad: number;
  todaySeconds: number;
  todaySessions: number;
  todayUsers: number;
  currentOrderGroups: number;
};

export type SupportRatingOverview = {
  count: number;
  average: number | null;
  /** index 0 = 1 分 … index 4 = 5 分。 */
  distribution: [number, number, number, number, number];
  agents: { adminUserId: string; name: string; count: number; average: number }[];
};

export type SupportOverview = {
  onDuty: SupportOverviewRow[];
  totals: { onDutyCount: number; waitingConsultations: number; todaySessions: number; todayUsers: number };
  trend: { date: string; sessions: number; users: number }[];
  hourly: { hour: number; sessions: number }[];
  ratings: SupportRatingOverview;
};

export type SupportHandoverView = {
  id: string;
  objectType: "CONSULTATION" | "ORDER_GROUP";
  objectId: string;
  from: { id: string; name: string };
  to: { id: string; name: string };
  note: string | null;
  createdAt: string;
  object:
    | { kind: "CONSULTATION"; id: string; type: string | null; user: { id: string; name: string } | null }
    | { kind: "ORDER_GROUP"; id: string; displayNo: string | null };
};

export type SupportAuditItem =
  | {
    kind: "CONSULTATION";
    id: string;
    type: string;
    state: string;
    user: { id: string; name: string };
    assignedAdmin: { id: string; name: string } | null;
    lastMessageAt: string | null;
    updatedAt: string;
    conversationId: string | null;
  }
  | {
    kind: "ORDER_GROUP";
    id: string;
    displayNo: string | null;
    title: string | null;
    status: string;
    teamState: string;
    gameName: string | null;
    firstResponseAt: string | null;
    remindDueAt: string | null;
    addRound: number;
    escalationState: string;
    conversationId: string | null;
  };

export type SupportAuditPage = { items: SupportAuditItem[]; nextCursor: string | null };

function invalid(message = "Request validation failed"): SecurityApiError {
  return new SecurityApiError(400, "INVALID_ARGUMENT", message);
}

function integer(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) throw new Error("IM support metric is invalid");
  return parsed;
}

/** 评分均值保留一位小数；无评分事实返回 null，不伪造 0 分。 */
function nullableAverage(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error("IM support rating average is invalid");
  return Math.round(parsed * 10) / 10;
}

export function parseSupportDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid("Date is invalid");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid("Date is invalid");
  return value;
}

export function parseHandoverNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid("Handover note is invalid");
  const note = value.trim();
  if (!note) return null;
  if (note.length > SUPPORT_HANDOVER_NOTE_MAX || /[\u0000-\u001F\u007F]/.test(note)) throw invalid("Handover note is invalid");
  return note;
}

export function parseHandoverLimit(value: string | null | undefined): number {
  if (value === undefined || value === null) return SUPPORT_HANDOVER_DEFAULT_LIMIT;
  if (!/^[1-9]\d?$/.test(value)) throw invalid("Limit is invalid");
  const limit = Number(value);
  if (limit > SUPPORT_HANDOVER_MAX_LIMIT) throw invalid("Limit is invalid");
  return limit;
}

function parseAuditLimit(value: string | null | undefined): number {
  if (value === undefined || value === null) return SUPPORT_AUDIT_DEFAULT_LIMIT;
  if (!/^[1-9]\d?$/.test(value)) throw invalid("Limit is invalid");
  const limit = Number(value);
  if (limit > SUPPORT_AUDIT_MAX_LIMIT) throw invalid("Limit is invalid");
  return limit;
}

export function encodeSupportAuditCursor(sortAt: string, kind: "CONSULTATION" | "ORDER_GROUP", id: string): string {
  return Buffer.from(JSON.stringify([sortAt, kind, id])).toString("base64url");
}

export function decodeSupportAuditCursor(value: string): { sortAt: string; kind: "CONSULTATION" | "ORDER_GROUP"; id: string } {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid("Cursor is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid("Cursor is invalid");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || typeof parsed[2] !== "string") {
    throw invalid("Cursor is invalid");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/.test(parsed[0]) || !AUDIT_KINDS.has(parsed[1]) || !ID_PATTERN.test(parsed[2])) throw invalid("Cursor is invalid");
  const date = new Date(`${parsed[0].slice(0, 19)}.000Z`);
  if (parsed[0].startsWith("0000") || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== parsed[0].slice(0, 19)
    || encodeSupportAuditCursor(parsed[0], parsed[1] as "CONSULTATION" | "ORDER_GROUP", parsed[2]) !== value) throw invalid("Cursor is invalid");
  return { sortAt: parsed[0], kind: parsed[1] as "CONSULTATION" | "ORDER_GROUP", id: parsed[2] };
}

export function requireSupportManagementRead(access: EffectiveAdminAccess | null): void {
  if (!hasPermission(access, ADMIN_PERMISSION.imSupportManagementRead)) {
    throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
  }
}

export function requireSupportAuditTakeover(access: EffectiveAdminAccess | null): void {
  requireSupportManagementRead(access);
  if (!hasPermission(access, ADMIN_PERMISSION.imSupportAuditTakeover)) {
    throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
  }
}

function supportTodaySql(dateParam: string): string {
  return `
  WITH bounds AS (${dayBounds(dateParam)}),
  seconds AS (
    SELECT FLOOR(COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (
             LEAST(COALESCE(s."ended_at", clock_timestamp()), b.day_end) - GREATEST(s."started_at", b.day_start)
           )), 0)), 0))::bigint AS value
      FROM "zzsh_iam"."im_support_presence_session" s CROSS JOIN bounds b
     WHERE s."app_id" = $1 AND s."admin_user_id" = $2
       AND s."started_at" < b.day_end AND COALESCE(s."ended_at", b.day_end) > b.day_start
  ),
  touched AS (
    SELECT e."consultation_id"
      FROM "zzsh_iam"."im_consultation_event" e
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
      CROSS JOIN bounds b
     WHERE e."event_type" IN ('ASSIGNED', 'CLAIMED', 'TRANSFERRED')
       AND (e."to_admin_id" = $2 OR e."actor_id" = $2)
       AND e."created_at" >= b.day_start AND e."created_at" < b.day_end
    UNION
    SELECT e."consultation_id"
      FROM "zzsh_iam"."im_consultation_event" e
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
      CROSS JOIN bounds b
     WHERE e."event_type" = 'CLOSED' AND e."actor_type" = 'admin' AND e."actor_id" = $2
       AND e."created_at" >= b.day_start AND e."created_at" < b.day_end
  ),
  counts AS (
    SELECT COUNT(*)::int AS sessions, COUNT(DISTINCT c."user_id")::int AS users
      FROM touched t JOIN "zzsh_iam"."im_consultation" c ON c."id" = t."consultation_id" AND c."app_id" = $1
  )
  SELECT COALESCE((SELECT value FROM seconds), 0) AS "seconds", counts.sessions, counts.users FROM counts`;
}

/**
 * 指定客服在指定北京时间自然日（默认今天）的接线秒数与咨询接待量。
 * 接线区间与当天窗口求交集；STALE 区间已在关闭时以最后心跳截断。
 */
export async function readSupportToday(
  client: PoolClient,
  appId: string,
  adminUserId: string,
  date: string | null = null,
): Promise<SupportDayCounts> {
  const row = (await client.query<{ seconds: string | number; sessions: string | number; users: string | number }>(
    supportTodaySql("$3"), [appId, adminUserId, date],
  )).rows[0];
  return { seconds: integer(row?.seconds), sessions: integer(row?.sessions), users: integer(row?.users) };
}

export async function recordSupportHandover(
  client: PoolClient,
  input: {
    appId: string;
    objectType: "CONSULTATION" | "ORDER_GROUP";
    objectId: string;
    fromAdminId: string;
    toAdminId: string;
    note: string | null;
  },
): Promise<void> {
  if (input.fromAdminId === input.toAdminId) throw new Error("Handover staff must differ");
  await client.query(
    `INSERT INTO "zzsh_iam"."im_support_handover"
      ("id", "app_id", "object_type", "object_id", "from_admin_id", "to_admin_id", "note")
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      `im_handover_${randomUUID().replaceAll("-", "")}`,
      input.appId,
      input.objectType,
      input.objectId,
      input.fromAdminId,
      input.toAdminId,
      input.note,
    ],
  );
}

/** 远端转交完成时回填到 TRANSFERRED 事件；note 为空返回 null。 */
export async function readLatestHandoverNote(
  client: PoolClient,
  appId: string,
  objectType: "CONSULTATION" | "ORDER_GROUP",
  objectId: string,
  fromAdminId: string,
  toAdminId: string,
): Promise<string | null> {
  const row = (await client.query<{ note: string | null }>(
    `SELECT "note" FROM "zzsh_iam"."im_support_handover"
      WHERE "app_id" = $1 AND "object_type" = $2 AND "object_id" = $3
        AND "from_admin_id" = $4 AND "to_admin_id" = $5
      ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
    [appId, objectType, objectId, fromAdminId, toAdminId],
  )).rows[0];
  return row?.note ?? null;
}

const SUPPORT_OVERVIEW_ON_DUTY_SQL = `
  WITH bounds AS (${dayBounds("$2")}),
  day_sessions AS (
    SELECT s."admin_user_id", s."started_at", s."ended_at"
      FROM "zzsh_iam"."im_support_presence_session" s CROSS JOIN bounds b
     WHERE s."app_id" = $1 AND s."started_at" < b.day_end AND COALESCE(s."ended_at", b.day_end) > b.day_start
  ),
  presence_rows AS (
    SELECT p."admin_user_id", p."availability", p."connection_state", p."active_load",
           COALESCE(NULLIF(btrim(u."name"), ''), u."username", p."admin_user_id") AS "name"
      FROM "zzsh_iam"."im_support_presence" p
      JOIN "zzsh_auth_admin"."user" u ON u."id" = p."admin_user_id"
     WHERE p."app_id" = $1 AND p."availability" <> 'OFF_DUTY'
    UNION ALL
    SELECT DISTINCT s."admin_user_id", 'OFF_DUTY', 'DISCONNECTED', 0,
           COALESCE(NULLIF(btrim(u."name"), ''), u."username", s."admin_user_id")
      FROM day_sessions s
      JOIN "zzsh_auth_admin"."user" u ON u."id" = s."admin_user_id"
     WHERE NOT EXISTS (
       SELECT 1 FROM "zzsh_iam"."im_support_presence" p
        WHERE p."app_id" = $1 AND p."admin_user_id" = s."admin_user_id" AND p."availability" <> 'OFF_DUTY'
     )
  ),
  session_seconds AS (
    SELECT s."admin_user_id",
           FLOOR(COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (
             LEAST(COALESCE(s."ended_at", clock_timestamp()), b.day_end) - GREATEST(s."started_at", b.day_start)
           )), 0)), 0))::bigint AS "seconds"
      FROM day_sessions s CROSS JOIN bounds b
     GROUP BY s."admin_user_id"
  ),
  touch AS (
    SELECT e."consultation_id", v."admin_user_id"
      FROM "zzsh_iam"."im_consultation_event" e
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
      CROSS JOIN bounds b
      CROSS JOIN LATERAL (VALUES (e."to_admin_id"), (e."actor_id")) v("admin_user_id")
     WHERE e."event_type" IN ('ASSIGNED', 'CLAIMED', 'TRANSFERRED')
       AND e."created_at" >= b.day_start AND e."created_at" < b.day_end
    UNION
    SELECT e."consultation_id", e."actor_id"
      FROM "zzsh_iam"."im_consultation_event" e
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
      CROSS JOIN bounds b
     WHERE e."event_type" = 'CLOSED' AND e."actor_type" = 'admin'
       AND e."created_at" >= b.day_start AND e."created_at" < b.day_end
  ),
  consult_counts AS (
    SELECT t."admin_user_id", COUNT(DISTINCT t."consultation_id")::int AS "sessions",
           COUNT(DISTINCT c."user_id")::int AS "users"
      FROM touch t
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = t."consultation_id" AND c."app_id" = $1
     WHERE t."admin_user_id" IS NOT NULL
     GROUP BY t."admin_user_id"
  ),
  order_counts AS (
    SELECT x."admin_user_id", COUNT(*)::int AS "groups"
      FROM (
        SELECT COALESCE(g."responsible_admin_id", g."assigned_admin_id") AS "admin_user_id"
          FROM "zzsh_order"."im_order_group" g
          JOIN "zzsh_order"."rental_order" o ON o."id" = g."order_id"
         WHERE g."app_id" = $1 AND o."status" = 'PAID'
      ) x
     WHERE x."admin_user_id" IS NOT NULL
     GROUP BY x."admin_user_id"
  )
  SELECT p."admin_user_id" AS "adminUserId", p."name", p."availability",
         p."connection_state" AS "connectionState", p."active_load" AS "activeLoad",
         COALESCE(ss."seconds", 0) AS "todaySeconds",
         COALESCE(cc."sessions", 0) AS "todaySessions",
         COALESCE(cc."users", 0) AS "todayUsers",
         COALESCE(oc."groups", 0) AS "currentOrderGroups"
    FROM presence_rows p
    LEFT JOIN session_seconds ss ON ss."admin_user_id" = p."admin_user_id"
    LEFT JOIN consult_counts cc ON cc."admin_user_id" = p."admin_user_id"
    LEFT JOIN order_counts oc ON oc."admin_user_id" = p."admin_user_id"
   ORDER BY p."admin_user_id"`;

const SUPPORT_OVERVIEW_TOTALS_SQL = `
  WITH bounds AS (${dayBounds("$2")}),
  touched AS (
    SELECT e."consultation_id"
      FROM "zzsh_iam"."im_consultation_event" e
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
      CROSS JOIN bounds b
     WHERE e."event_type" IN ('ASSIGNED', 'CLAIMED', 'TRANSFERRED')
       AND e."created_at" >= b.day_start AND e."created_at" < b.day_end
    UNION
    SELECT e."consultation_id"
      FROM "zzsh_iam"."im_consultation_event" e
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
      CROSS JOIN bounds b
     WHERE e."event_type" = 'CLOSED' AND e."actor_type" = 'admin'
       AND e."created_at" >= b.day_start AND e."created_at" < b.day_end
  )
  SELECT
    (SELECT COUNT(*)::int FROM "zzsh_iam"."im_support_presence" p
      WHERE p."app_id" = $1 AND p."availability" = 'AVAILABLE' AND p."connection_state" = 'CONNECTED') AS "onDutyCount",
    (SELECT COUNT(*)::int FROM "zzsh_iam"."im_consultation" c
      WHERE c."app_id" = $1 AND c."state" = 'WAITING') AS "waitingConsultations",
    (SELECT COUNT(DISTINCT t."consultation_id")::int FROM touched t) AS "todaySessions",
    (SELECT COUNT(DISTINCT c."user_id")::int FROM touched t
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = t."consultation_id" AND c."app_id" = $1) AS "todayUsers"`;

const SUPPORT_OVERVIEW_TREND_SQL = `
  WITH days AS (
    SELECT generate_series(
      (COALESCE($2::date, (now() AT TIME ZONE 'Asia/Shanghai')::date) - 6)::timestamp,
      COALESCE($2::date, (now() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp,
      interval '1 day'
    )::date AS day
  )
  SELECT to_char(d.day, 'YYYY-MM-DD') AS "date",
         COUNT(DISTINCT c."id")::int AS "sessions",
         COUNT(DISTINCT c."user_id")::int AS "users"
    FROM days d
    LEFT JOIN "zzsh_iam"."im_consultation_event" e
      ON e."created_at" >= (d.day::timestamp AT TIME ZONE 'Asia/Shanghai')
     AND e."created_at" < ((d.day::timestamp + interval '1 day') AT TIME ZONE 'Asia/Shanghai')
     AND e."event_type" IN ('ASSIGNED', 'CLAIMED', 'TRANSFERRED', 'CLOSED')
     AND (e."event_type" <> 'CLOSED' OR e."actor_type" = 'admin')
    LEFT JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
   GROUP BY d.day
   ORDER BY d.day`;

const SUPPORT_OVERVIEW_HOURLY_SQL = `
  WITH bounds AS (${dayBounds("$2")}),
  hours AS (SELECT generate_series(0, 23) AS "hour")
  SELECT h."hour", COUNT(DISTINCT c."id")::int AS "sessions"
    FROM hours h
    LEFT JOIN bounds b ON TRUE
    LEFT JOIN "zzsh_iam"."im_consultation_event" e
      ON e."event_type" = 'CREATED'
     AND e."created_at" >= b.day_start
     AND e."created_at" < b.day_end
     AND EXTRACT(HOUR FROM e."created_at" AT TIME ZONE 'Asia/Shanghai')::int = h."hour"
    LEFT JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
   GROUP BY h."hour"
   ORDER BY h."hour"`;

const SUPPORT_OVERVIEW_RATING_SQL = `
  SELECT COUNT(*)::int AS "count", AVG("score") AS "average",
         COUNT(*) FILTER (WHERE "score" = 1)::int AS "score1",
         COUNT(*) FILTER (WHERE "score" = 2)::int AS "score2",
         COUNT(*) FILTER (WHERE "score" = 3)::int AS "score3",
         COUNT(*) FILTER (WHERE "score" = 4)::int AS "score4",
         COUNT(*) FILTER (WHERE "score" = 5)::int AS "score5"
    FROM "zzsh_iam"."im_support_round_rating"
   WHERE "app_id" = $1 AND "submitted_at" IS NOT NULL
     AND ("submitted_at" AT TIME ZONE 'Asia/Shanghai')::date = COALESCE($2::date, (now() AT TIME ZONE 'Asia/Shanghai')::date)`;

const SUPPORT_OVERVIEW_RATING_AGENTS_SQL = `
  SELECT r."assigned_admin_id" AS "adminUserId",
         COALESCE(NULLIF(btrim(au."name"), ''), au."username", r."assigned_admin_id") AS "name",
         COUNT(*)::int AS "count", AVG(r."score") AS "average"
    FROM "zzsh_iam"."im_support_round_rating" r
    LEFT JOIN "zzsh_auth_admin"."user" au ON au."id" = r."assigned_admin_id"
   WHERE r."app_id" = $1 AND r."submitted_at" IS NOT NULL
     AND (r."submitted_at" AT TIME ZONE 'Asia/Shanghai')::date = COALESCE($2::date, (now() AT TIME ZONE 'Asia/Shanghai')::date)
   GROUP BY r."assigned_admin_id",
            COALESCE(NULLIF(btrim(au."name"), ''), au."username", r."assigned_admin_id")
   ORDER BY "average" DESC, "count" DESC, "adminUserId"`;

/**
 * 运营看板只读投影：统计表、今日汇总、近 7 天咨询趋势、今日每小时新咨询。
 * 数据不足时 trend/hourly 返回空数组，不画伪造的零趋势。
 */
export async function readSupportOverview(
  options: { pool: Pool; appId: string },
  context: AdminContext,
  dateValue: string | null | undefined,
): Promise<SupportOverview> {
  const date = parseSupportDate(dateValue);
  return withTransaction(options.pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    requireSupportManagementRead(await loadEffectiveAdminAccess(client, context.userId));
    const onDuty = (await client.query<{
      adminUserId: string; name: string; availability: SupportAvailability; connectionState: SupportConnectionState;
      activeLoad: string | number; todaySeconds: string | number; todaySessions: string | number;
      todayUsers: string | number; currentOrderGroups: string | number;
    }>(SUPPORT_OVERVIEW_ON_DUTY_SQL, [options.appId, date])).rows.map((row) => ({
      adminUserId: row.adminUserId,
      name: row.name,
      availability: row.availability,
      connectionState: row.connectionState,
      activeLoad: integer(row.activeLoad),
      todaySeconds: integer(row.todaySeconds),
      todaySessions: integer(row.todaySessions),
      todayUsers: integer(row.todayUsers),
      currentOrderGroups: integer(row.currentOrderGroups),
    }));
    const totalsRow = (await client.query<{
      onDutyCount: string | number; waitingConsultations: string | number;
      todaySessions: string | number; todayUsers: string | number;
    }>(SUPPORT_OVERVIEW_TOTALS_SQL, [options.appId, date])).rows[0];
    const trendRows = (await client.query<{ date: string; sessions: string | number; users: string | number }>(
      SUPPORT_OVERVIEW_TREND_SQL, [options.appId, date],
    )).rows.map((row) => ({ date: row.date, sessions: integer(row.sessions), users: integer(row.users) }));
    const hourlyRows = (await client.query<{ hour: number; sessions: string | number }>(
      SUPPORT_OVERVIEW_HOURLY_SQL, [options.appId, date],
    )).rows.map((row) => ({ hour: integer(row.hour), sessions: integer(row.sessions) }));
    const ratingRow = (await client.query<{
      count: string | number; average: string | number | null;
      score1: string | number; score2: string | number; score3: string | number; score4: string | number; score5: string | number;
    }>(SUPPORT_OVERVIEW_RATING_SQL, [options.appId, date])).rows[0];
    const ratingAgents = (await client.query<{ adminUserId: string; name: string; count: string | number; average: string | number }>(
      SUPPORT_OVERVIEW_RATING_AGENTS_SQL, [options.appId, date],
    )).rows.flatMap((row) => {
      const average = nullableAverage(row.average);
      return average === null ? [] : [{ adminUserId: row.adminUserId, name: row.name, count: integer(row.count), average }];
    });
    return {
      onDuty,
      totals: {
        onDutyCount: integer(totalsRow?.onDutyCount),
        waitingConsultations: integer(totalsRow?.waitingConsultations),
        todaySessions: integer(totalsRow?.todaySessions),
        todayUsers: integer(totalsRow?.todayUsers),
      },
      // 没有任何事实时返回空数组，不用 0 伪造趋势；真实为零的日期保留。
      trend: trendRows.some((row) => row.sessions > 0 || row.users > 0) ? trendRows : [],
      hourly: hourlyRows.some((row) => row.sessions > 0) ? hourlyRows : [],
      ratings: {
        count: integer(ratingRow?.count),
        average: nullableAverage(ratingRow?.average),
        distribution: [
          integer(ratingRow?.score1),
          integer(ratingRow?.score2),
          integer(ratingRow?.score3),
          integer(ratingRow?.score4),
          integer(ratingRow?.score5),
        ],
        agents: ratingAgents,
      },
    };
  });
}

export async function listSupportHandovers(
  options: { pool: Pool; appId: string },
  context: AdminContext,
  limitValue: string | null | undefined,
): Promise<{ items: SupportHandoverView[] }> {
  const limit = parseHandoverLimit(limitValue);
  return withTransaction(options.pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    const all = hasPermission(access, ADMIN_PERMISSION.imSupportManagementRead);
    const rows = (await client.query<{
      id: string; objectType: "CONSULTATION" | "ORDER_GROUP"; objectId: string;
      fromAdminId: string; fromName: string | null; toAdminId: string; toName: string | null;
      note: string | null; createdAt: string; consultationType: string | null;
      userId: string | null; userName: string | null; userUsername: string | null; displayNo: string | null;
    }>(
      `SELECT h."id", h."object_type" AS "objectType", h."object_id" AS "objectId",
              h."from_admin_id" AS "fromAdminId", h."to_admin_id" AS "toAdminId", h."note",
              to_char(h."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
              COALESCE(NULLIF(btrim(fu."name"), ''), fu."username", h."from_admin_id") AS "fromName",
              COALESCE(NULLIF(btrim(tu."name"), ''), tu."username", h."to_admin_id") AS "toName",
              c."kind" AS "consultationType", c."user_id" AS "userId",
              COALESCE(NULLIF(btrim(cu."name"), ''), cu."username", c."user_id") AS "userName",
              cu."username" AS "userUsername", o."display_no" AS "displayNo"
         FROM "zzsh_iam"."im_support_handover" h
         LEFT JOIN "zzsh_auth_admin"."user" fu ON fu."id" = h."from_admin_id"
         LEFT JOIN "zzsh_auth_admin"."user" tu ON tu."id" = h."to_admin_id"
         LEFT JOIN "zzsh_iam"."im_consultation" c
           ON h."object_type" = 'CONSULTATION' AND c."app_id" = h."app_id" AND c."id" = h."object_id"
         LEFT JOIN "zzsh_auth_user"."user" cu ON cu."id" = c."user_id"
         LEFT JOIN "zzsh_order"."rental_order" o
           ON h."object_type" = 'ORDER_GROUP' AND o."id" = h."object_id"
        WHERE h."app_id" = $1 AND ($2::boolean OR h."from_admin_id" = $3 OR h."to_admin_id" = $3)
        ORDER BY h."created_at" DESC, h."id" DESC
        LIMIT $4`,
      [options.appId, all, context.userId, limit],
    )).rows;
    return {
      items: rows.map((row) => ({
        id: row.id,
        objectType: row.objectType,
        objectId: row.objectId,
        from: { id: row.fromAdminId, name: row.fromName || "客服" },
        to: { id: row.toAdminId, name: row.toName || "客服" },
        note: row.note,
        createdAt: row.createdAt,
        object: row.objectType === "ORDER_GROUP"
          ? { kind: "ORDER_GROUP" as const, id: row.objectId, displayNo: row.displayNo }
          : {
            kind: "CONSULTATION" as const,
            id: row.objectId,
            type: row.consultationType,
            user: row.userId ? { id: row.userId, name: row.userName || row.userUsername || "平台用户" } : null,
          },
      })),
    };
  });
}

async function auditViewerAccount(client: PoolClient, appId: string, adminUserId: string): Promise<string | null> {
  const row = (await client.query<{ accountId: string; identityMarker: string }>(
    `SELECT "account_id" AS "accountId", "identity_marker" AS "identityMarker"
       FROM "zzsh_iam"."im_identity_mapping"
      WHERE "provider" = 'yunxin' AND "app_id" = $1 AND "realm" = 'admin'
        AND "identity_kind" = 'ADMIN' AND "platform_subject_id" = $2 AND "status" = 'READY'`,
    [appId, adminUserId],
  )).rows[0];
  if (!row) return null;
  const key = { provider: "yunxin" as const, appId, realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: adminUserId };
  return row.accountId === deriveYunxinAccountId(key) && row.identityMarker === buildYunxinIdentityMarker(key) ? row.accountId : null;
}

const AUDIT_CONVERSATIONS_SQL = `
  WITH items AS (
    SELECT COALESCE(c."last_message_at", c."updated_at") AS sort_at,
           'CONSULTATION'::text AS item_kind, c."id" AS item_id,
           jsonb_build_object(
             'kind', 'CONSULTATION', 'id', c."id", 'type', c."kind", 'state', c."state",
             'user', jsonb_build_object('id', c."user_id",
               'name', COALESCE(NULLIF(btrim(u."name"), ''), u."username", c."user_id")),
             'assignedAdmin', CASE WHEN c."assigned_admin_id" IS NULL THEN NULL ELSE jsonb_build_object(
               'id', c."assigned_admin_id",
               'name', COALESCE(NULLIF(btrim(au."name"), ''), au."username", c."assigned_admin_id")) END,
             'lastMessageAt', to_char(c."last_message_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'updatedAt', to_char(c."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'conversationId', CASE WHEN c."state" = 'ACTIVE' AND c."message_scope_state" = 'READY'
               AND c."message_scope_id" IS NOT NULL AND $2::text IS NOT NULL
               THEN $2 || '|2|' || c."message_scope_id" ELSE NULL END
           ) AS payload
      FROM "zzsh_iam"."im_consultation" c
      JOIN "zzsh_auth_user"."user" u ON u."id" = c."user_id"
      LEFT JOIN "zzsh_auth_admin"."user" au ON au."id" = c."assigned_admin_id"
     WHERE c."app_id" = $1
    UNION ALL
    SELECT COALESCE(g."team_ready_at", o."created_at") AS sort_at,
           'ORDER_GROUP'::text AS item_kind, o."id" AS item_id,
           jsonb_build_object(
             'kind', 'ORDER_GROUP', 'id', o."id", 'displayNo', o."display_no", 'title', o."title",
             'status', o."status", 'teamState', g."team_state", 'gameName', game."name",
             'userName', '',
             'adminUserId', COALESCE(g."responsible_admin_id", g."assigned_admin_id"),
             'adminName', COALESCE((SELECT u."name" FROM "zzsh_auth_admin"."user" u
                                     WHERE u."id" = COALESCE(g."responsible_admin_id", g."assigned_admin_id")), '未分配'),
             'state', CASE WHEN o."status" IN ('COMPLETED','CANCELLED') THEN 'CLOSED'
                           WHEN g."team_state" = 'READY' THEN 'ACTIVE' ELSE 'WAITING' END,
             'lastMessageAt', NULL::text,
             'firstResponseAt', to_char((to_jsonb(g)->>'first_response_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'remindDueAt', to_char((to_jsonb(g)->>'remind_due_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'addRound', COALESCE((to_jsonb(g)->>'add_round')::int, 0),
             'escalationState', COALESCE(to_jsonb(g)->>'escalation_state', 'NOT_STARTED'),
             'conversationId', CASE WHEN g."team_state" = 'READY' AND g."team_id" IS NOT NULL AND $2::text IS NOT NULL
               THEN $2 || '|2|' || g."team_id" ELSE NULL END
           ) AS payload
      FROM "zzsh_order"."im_order_group" g
      JOIN "zzsh_order"."rental_order" o ON o."id" = g."order_id"
      JOIN "zzsh_supply"."game" game ON game."id" = o."game_id"
     WHERE g."app_id" = $1
  )
  SELECT to_char(sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sortAt",
         item_kind AS "kind", item_id AS "id", payload
    FROM items
   WHERE ($3::timestamptz IS NULL OR (sort_at, item_kind, item_id) < ($3::timestamptz, $4::text, $5::text))
   ORDER BY sort_at DESC, item_kind DESC, item_id DESC
   LIMIT $6`;

/**
 * 巡视列表：全部咨询（含 CLOSED）与全部订单群，不含正文。
 * 订单群复用 listJoinedOrderTeams 的投影字段，但不要求当前运营是 JOINED 成员。
 */
export async function listAuditConversations(
  options: { pool: Pool; appId: string },
  context: AdminContext,
  limitValue: string | null | undefined,
  cursorValue: string | null | undefined,
): Promise<SupportAuditPage> {
  const limit = parseAuditLimit(limitValue);
  const cursor = cursorValue === undefined || cursorValue === null ? null : decodeSupportAuditCursor(cursorValue);
  return withTransaction(options.pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    requireSupportManagementRead(await loadEffectiveAdminAccess(client, context.userId));
    const viewerAccountId = await auditViewerAccount(client, options.appId, context.userId);
    const rows = (await client.query<{ sortAt: string; kind: "CONSULTATION" | "ORDER_GROUP"; id: string; payload: Record<string, unknown> }>(
      AUDIT_CONVERSATIONS_SQL,
      [options.appId, viewerAccountId, cursor?.sortAt ?? null, cursor?.kind ?? null, cursor?.id ?? null, limit + 1],
    )).rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => row.payload as unknown as SupportAuditItem),
      nextCursor: hasMore && page.length > 0 ? encodeSupportAuditCursor(page[page.length - 1]!.sortAt, page[page.length - 1]!.kind, page[page.length - 1]!.id) : null,
    };
  });
}

export async function readPatrolOrderTeamAccess(
  client: PoolClient,
  input: { appId: string; teamId: string; conversationId: string; requestId: string },
  actor: { userId: string; sessionId: string },
): Promise<{ viewerAccountId: string; peerAccountId: string; scope: { appId: string; orderId: string; teamId: string } } | null> {
  await assertAdminContextInTransaction(client, actor);
  const access = await loadEffectiveAdminAccess(client, actor.userId);
  if (!hasPermission(access, ADMIN_PERMISSION.imSupportManagementRead)) return null;
  const group = (await client.query<{ orderId: string; teamState: string }>(
    `SELECT g."order_id" AS "orderId", g."team_state" AS "teamState"
       FROM "zzsh_order"."im_order_group" g
       JOIN "zzsh_order"."rental_order" o ON o."id" = g."order_id"
      WHERE g."app_id" = $1 AND g."team_id" = $2`,
    [input.appId, input.teamId],
  )).rows[0];
  if (!group || group.teamState !== "READY") return null;
  const viewerAccountId = await auditViewerAccount(client, input.appId, actor.userId);
  if (!viewerAccountId || input.conversationId !== `${viewerAccountId}|2|${input.teamId}`) return null;
  await recordAudit(client, {
    actorType: "admin",
    actorId: actor.userId,
    sessionId: actor.sessionId,
    action: "im.audit.conversation_viewed",
    objectType: "im_order_group",
    objectId: group.orderId,
    outcome: "SUCCESS",
    requestId: input.requestId,
    details: { mode: "PATROL_READ", teamId: input.teamId },
  });
  return {
    viewerAccountId,
    peerAccountId: input.teamId,
    scope: { appId: input.appId, orderId: group.orderId, teamId: input.teamId },
  };
}
