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

import { managedProfileImagePath } from "../profile/profile-avatar";

export const SUPPORT_HANDOVER_NOTE_MAX = 200;
export const SUPPORT_HANDOVER_DEFAULT_LIMIT = 20;
export const SUPPORT_HANDOVER_MAX_LIMIT = 50;
export const SUPPORT_AUDIT_DEFAULT_LIMIT = 20;
export const SUPPORT_AUDIT_MAX_LIMIT = 50;

/** 咨询首响 SLA 默认阈值（秒）：与订单群首响提醒的口径一致（order-team.ts 的 interval '2 minutes'）。 */
export const SUPPORT_FIRST_RESPONSE_DEFAULT_SECONDS = 120;
export const SUPPORT_FIRST_RESPONSE_MIN_SECONDS = 30;
export const SUPPORT_FIRST_RESPONSE_MAX_SECONDS = 86_400;

/**
 * 首响事实的动作名。im_consultation 没有 first_response 列（0120 只加了 first_user_message_at），
 * im_consultation_event 的类型又被 0032 的 CHECK 锁死；事实先落在 append-only 的 audit_event，
 * 写入在 consultation.ts::recordSupportFirstResponse，读取只允许走 readConsultationFirstResponse。
 * 将来若补上正列，只改这两个函数，不在各读模型里散写 join。
 */
export const SUPPORT_FIRST_RESPONSE_ACTION = "im.consultation.first_response";
export const SUPPORT_FIRST_RESPONSE_REMINDER_ACTION = "im.consultation.first_response.reminder";

export function resolveFirstResponseSeconds(value?: number | null): number {
  if (value === undefined || value === null) return SUPPORT_FIRST_RESPONSE_DEFAULT_SECONDS;
  if (!Number.isSafeInteger(value) || value < SUPPORT_FIRST_RESPONSE_MIN_SECONDS || value > SUPPORT_FIRST_RESPONSE_MAX_SECONDS) {
    throw new Error("Invalid first response SLA seconds");
  }
  return value;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUDIT_KINDS = new Set(["CONSULTATION", "ORDER_GROUP"]);

/** 北京时间自然日窗口；dateParam 是 SQL 参数占位符（$2 或 $3）。 */
function dayBounds(dateParam: string, endDateParam = dateParam): string {
  const date = `COALESCE(${dateParam}::date, (now() AT TIME ZONE 'Asia/Shanghai')::date)`;
  const endDate = `COALESCE(${endDateParam}::date, ${date})`;
  return `
  SELECT (${date}::timestamp AT TIME ZONE 'Asia/Shanghai') AS day_start,
         ((${endDate}::timestamp + interval '1 day') AT TIME ZONE 'Asia/Shanghai') AS day_end`;
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
  /** 业务不设接待硬上限；保留 null 表示“无上限”，仅 totalLoad 作统计。 */
  capacityLimit: number | null;
  /** 当前占用 = 咨询接待数 + 在租订单群数（只展示，不拦截）。 */
  totalLoad: number;
  atCapacity: boolean;
};

/** 首响事实的单一读结果：answeredAt 为空表示本轮尚无人工首响。 */
export type SupportFirstResponseFact = { answeredAt: string | null; answeredByAdminId: string | null };

export type SupportQueueReasonView = "NO_ONLINE_STAFF" | "ALL_AT_CAPACITY" | "CAPACITY_AVAILABLE";

/**
 * 排队可见性：满载排队不能表现成“没人接待”。reason 只在有排队时才给：
 * withFreeSlot > 0 说明还有空位，正在分配（IM 建群/订单优先），不是满载。
 */
export type SupportQueueView = {
  queued: number;
  /** Waiting rounds split by the permission cohort each one actually needs. */
  serviceQueued: number;
  complaintQueued: number;
  serviceEligible: number;
  complaintEligible: number;
  oldestQueuedAt: string | null;
  oldestWaitSeconds: number | null;
  onDuty: number;
  withFreeSlot: number;
  atCapacity: number;
  capacityLimit: number | null;
  reason: SupportQueueReasonView | null;
};

export type SupportQualityView = {
  /** sampleCount 是样本数（分母），null 均值 = 无样本，不是 0。 */
  firstResponse: {
    slaSeconds: number;
    askedCount: number;
    averageSeconds: number | null;
    sampleCount: number;
    breached: number;
    pending: number;
    overdue: number;
  };
  resolution: { averageSeconds: number | null; sampleCount: number };
};

export type SupportRatingOverview = {
  count: number;
  average: number | null;
  /** index 0 = 1 分 … index 4 = 5 分。 */
  distribution: [number, number, number, number, number];
  agents: { adminUserId: string; name: string; count: number; average: number }[];
};

export type SupportOverview = {
  reportDate?: string;
  serverNow?: string;
  period: SupportReportPeriod;
  /** 满载排队事实：与“没人接待”区分。 */
  queue: SupportQueueView;
  quality: SupportQualityView;
  onDuty: SupportOverviewRow[];
  totals: {
    onDutyCount: number; waitingConsultations: number; todaySessions: number; todayUsers: number;
    transfersToday: number; handoversToday: number;
  };
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
    user: { id: string; name: string; avatar?: string | null };
    assignedAdmin: { id: string; name: string } | null;
    lastMessageAt: string | null;
    updatedAt: string;
    conversationId: string | null;
    firstUserMessageAt?: string | null;
    userUnreadCount?: number;
    adminUnreadCount?: number;
    historyState?: "AVAILABLE" | "NOT_ESTABLISHED" | "LEGACY_UNAVAILABLE" | "RECOVERING";
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) throw invalid("Date is invalid");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid("Date is invalid");
  return value;
}

export const SUPPORT_REPORT_MAX_DAYS = 366;
export type SupportReportPeriod = { dateFrom: string; dateTo: string; days: number; timeZone: "Asia/Shanghai"; trendFrom: string; trendTo: string };
export function parseSupportRange(fromValue: string | null | undefined, toValue?: string | null) {
  const dateFrom = parseSupportDate(fromValue), dateTo = toValue === undefined ? dateFrom : parseSupportDate(toValue);
  if (toValue !== undefined && (!dateFrom || !dateTo)) throw invalid("Date range requires both dates");
  const days = dateFrom && dateTo ? (Date.parse(dateTo) - Date.parse(dateFrom)) / 86400000 + 1 : 1;
  if (days < 1 || days > SUPPORT_REPORT_MAX_DAYS) throw invalid("Date range must contain 1–366 days");
  return { dateFrom, dateTo, explicit: toValue !== undefined };
}
async function readSupportReportClock(client: PoolClient, range: ReturnType<typeof parseSupportRange>) {
  const clock = (await client.query<{ reportDate: string; serverNow: string }>(
    `SELECT to_char(COALESCE($2::date,$1::date,(now() AT TIME ZONE 'Asia/Shanghai')::date),'YYYY-MM-DD') AS "reportDate",
      to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "serverNow"`, [range.dateFrom, range.dateTo],
  )).rows[0];
  if (!clock || !parseSupportDate(clock.reportDate) || !Number.isFinite(Date.parse(clock.serverNow))) throw new Error("Support report clock unavailable");
  const dateFrom = range.dateFrom ?? clock.reportDate, dateTo = range.dateTo ?? clock.reportDate;
  const trendFrom = range.explicit ? dateFrom : new Date(Math.max(Date.parse("0001-01-01"), Date.parse(dateTo) - 6 * 86400000)).toISOString().slice(0, 10);
  const period: SupportReportPeriod = { dateFrom, dateTo, days: (Date.parse(dateTo) - Date.parse(dateFrom)) / 86400000 + 1,
    timeZone: "Asia/Shanghai", trendFrom, trendTo: dateTo };
  return { ...clock, period };
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

export function encodeSupportAuditCursor(sortAt: string, kind: "CONSULTATION" | "ORDER_GROUP", id: string, filterScope?: string): string {
  return Buffer.from(JSON.stringify(filterScope ? [sortAt, kind, id, filterScope] : [sortAt, kind, id])).toString("base64url");
}

export function decodeSupportAuditCursor(value: string): { sortAt: string; kind: "CONSULTATION" | "ORDER_GROUP"; id: string; filterScope?: string } {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid("Cursor is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid("Cursor is invalid");
  }
  if (!Array.isArray(parsed) || ![3,4].includes(parsed.length) || (parsed.length===4 && (typeof parsed[3]!=="string" || !parsed[3])) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || typeof parsed[2] !== "string") {
    throw invalid("Cursor is invalid");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/.test(parsed[0]) || !AUDIT_KINDS.has(parsed[1]) || !ID_PATTERN.test(parsed[2])) throw invalid("Cursor is invalid");
  const date = new Date(`${parsed[0].slice(0, 19)}.000Z`);
  if (parsed[0].startsWith("0000") || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== parsed[0].slice(0, 19)
    || encodeSupportAuditCursor(parsed[0], parsed[1] as "CONSULTATION" | "ORDER_GROUP", parsed[2], parsed[3]) !== value) throw invalid("Cursor is invalid");
  return { sortAt: parsed[0], kind: parsed[1] as "CONSULTATION" | "ORDER_GROUP", id: parsed[2], ...(parsed.length===4?{filterScope:parsed[3]}:{}) };
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

function supportTodaySql(dateParam: string, endDateParam = dateParam): string {
  return `
  WITH bounds AS (${dayBounds(dateParam, endDateParam)}),
  seconds AS (
    SELECT FLOOR(COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (
             LEAST(COALESCE(s."ended_at", CASE WHEN s."last_heartbeat_at" < clock_timestamp() - interval '2 minutes' THEN s."last_heartbeat_at" ELSE clock_timestamp() END), b.day_end) - GREATEST(s."started_at", b.day_start)
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
  endDate?: string | null,
): Promise<SupportDayCounts> {
  const row = (await client.query<{ seconds: string | number; sessions: string | number; users: string | number }>(
    supportTodaySql("$3", "$4"), [appId, adminUserId, date, endDate ?? date],
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

const SUPPORT_OVERVIEW_ELIGIBLE_SQL = `
  SELECT p."admin_user_id" AS "adminUserId", m."account_id" AS "accountId", m."identity_marker" AS "identityMarker"
    FROM "zzsh_iam"."im_support_presence" p
    JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = p."admin_user_id"
    JOIN "zzsh_auth_admin"."user" u ON u."id" = p."admin_user_id"
    JOIN "zzsh_iam"."im_identity_mapping" m
      ON m."provider" = 'yunxin' AND m."app_id" = p."app_id" AND m."realm" = 'admin'
     AND m."identity_kind" = 'ADMIN' AND m."platform_subject_id" = p."admin_user_id" AND m."status" = 'READY'
   WHERE p."app_id" = $1 AND s."status" = 'ACTIVE' AND NOT u."suspended"
     AND p."availability" = 'AVAILABLE' AND p."connection_state" = 'CONNECTED'
     AND p."last_connected_at" > clock_timestamp() - interval '2 minutes'`;

const SUPPORT_OVERVIEW_ON_DUTY_SQL = `
  WITH bounds AS (${dayBounds("$2", "$3")}),
  day_sessions AS (
    SELECT s."admin_user_id", s."started_at", s."ended_at", s."last_heartbeat_at"
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
             LEAST(COALESCE(s."ended_at", CASE WHEN s."last_heartbeat_at" < clock_timestamp() - interval '2 minutes' THEN s."last_heartbeat_at" ELSE clock_timestamp() END), b.day_end) - GREATEST(s."started_at", b.day_start)
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
  ),
  roster AS (
    SELECT p.* FROM presence_rows p
    UNION ALL
    SELECT cc."admin_user_id", COALESCE(p."availability", 'OFF_DUTY'), COALESCE(p."connection_state", 'DISCONNECTED'),
           COALESCE(p."active_load", 0), COALESCE(NULLIF(btrim(u."name"), ''), u."username", cc."admin_user_id")
      FROM consult_counts cc JOIN "zzsh_auth_admin"."user" u ON u."id"=cc."admin_user_id"
      LEFT JOIN "zzsh_iam"."im_support_presence" p ON p."app_id"=$1 AND p."admin_user_id"=cc."admin_user_id"
     WHERE NOT EXISTS(SELECT 1 FROM presence_rows existing WHERE existing."admin_user_id"=cc."admin_user_id")
  )
  SELECT p."admin_user_id" AS "adminUserId", p."name", p."availability",
         p."connection_state" AS "connectionState", p."active_load" AS "activeLoad",
         p."active_load" + COALESCE(oc."groups", 0) AS "totalLoad",
         COALESCE(ss."seconds", 0) AS "todaySeconds",
         COALESCE(cc."sessions", 0) AS "todaySessions",
         COALESCE(cc."users", 0) AS "todayUsers",
         COALESCE(oc."groups", 0) AS "currentOrderGroups"
    FROM roster p
    LEFT JOIN session_seconds ss ON ss."admin_user_id" = p."admin_user_id"
    LEFT JOIN consult_counts cc ON cc."admin_user_id" = p."admin_user_id"
    LEFT JOIN order_counts oc ON oc."admin_user_id" = p."admin_user_id"
   ORDER BY p."admin_user_id"`;

const SUPPORT_OVERVIEW_TOTALS_SQL = `
  WITH bounds AS (${dayBounds("$2", "$3")}),
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
    (SELECT COUNT(*)::int FROM "zzsh_iam"."im_consultation" c
      WHERE c."app_id" = $1 AND c."state" = 'WAITING' AND c."assigned_admin_id" IS NULL
        AND c."first_user_message_at" IS NOT NULL) AS "waitingConsultations",
    (SELECT COUNT(DISTINCT t."consultation_id")::int FROM touched t) AS "todaySessions",
    (SELECT COUNT(DISTINCT c."user_id")::int FROM touched t
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = t."consultation_id" AND c."app_id" = $1) AS "todayUsers",
    (SELECT COUNT(*)::int FROM "zzsh_iam"."im_consultation_event" e
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
      CROSS JOIN bounds b
     WHERE e."event_type" = 'TRANSFERRED'
       AND e."created_at" >= b.day_start AND e."created_at" < b.day_end) AS "transfersToday",
    (SELECT COUNT(*)::int FROM "zzsh_iam"."im_support_handover" h CROSS JOIN bounds b
     WHERE h."app_id" = $1 AND h."created_at" >= b.day_start AND h."created_at" < b.day_end) AS "handoversToday"`;

const SUPPORT_OVERVIEW_TREND_SQL = `
  WITH days AS (
    SELECT generate_series(
      $2::date::timestamp,
      $3::date::timestamp,
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
  WITH bounds AS (${dayBounds("$2", "$3")}),
  hours AS (SELECT generate_series(0, 23) AS "hour")
  SELECT h."hour", COUNT(DISTINCT c."id")::int AS "sessions"
    FROM hours h
    LEFT JOIN bounds b ON TRUE
    LEFT JOIN "zzsh_iam"."im_consultation_event" e
      ON e."event_type" IN ('CREATED','REOPENED')
     AND e."created_at" >= b.day_start
     AND e."created_at" < b.day_end
     AND EXTRACT(HOUR FROM e."created_at" AT TIME ZONE 'Asia/Shanghai')::int = h."hour"
    LEFT JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
   GROUP BY h."hour"
   ORDER BY h."hour"`;

const SUPPORT_OVERVIEW_RATING_SQL = `
  WITH bounds AS (${dayBounds("$2", "$3")})
  SELECT COUNT(*)::int AS "count", AVG("score") AS "average",
         COUNT(*) FILTER (WHERE "score" = 1)::int AS "score1",
         COUNT(*) FILTER (WHERE "score" = 2)::int AS "score2",
         COUNT(*) FILTER (WHERE "score" = 3)::int AS "score3",
         COUNT(*) FILTER (WHERE "score" = 4)::int AS "score4",
         COUNT(*) FILTER (WHERE "score" = 5)::int AS "score5"
    FROM "zzsh_iam"."im_support_round_rating" CROSS JOIN bounds b
   WHERE "app_id" = $1 AND "submitted_at" IS NOT NULL
     AND "submitted_at" >= b.day_start AND "submitted_at" < b.day_end`;

const SUPPORT_OVERVIEW_RATING_AGENTS_SQL = `
  WITH bounds AS (${dayBounds("$2", "$3")})
  SELECT r."assigned_admin_id" AS "adminUserId",
         COALESCE(NULLIF(btrim(au."name"), ''), au."username", r."assigned_admin_id") AS "name",
         COUNT(*)::int AS "count", AVG(r."score") AS "average"
    FROM "zzsh_iam"."im_support_round_rating" r
    LEFT JOIN "zzsh_auth_admin"."user" au ON au."id" = r."assigned_admin_id"
    CROSS JOIN bounds b
   WHERE r."app_id" = $1 AND r."submitted_at" IS NOT NULL
     AND r."submitted_at" >= b.day_start AND r."submitted_at" < b.day_end
   GROUP BY r."assigned_admin_id",
            COALESCE(NULLIF(btrim(au."name"), ''), au."username", r."assigned_admin_id")
   ORDER BY "average" DESC, "count" DESC, "adminUserId"`;

/** 首响事实的唯一读取入口：audit_event 中的 append-only 首次人工回复证据。 */
export async function readConsultationFirstResponse(
  client: PoolClient,
  appId: string,
  roundIds: readonly string[],
): Promise<Map<string, SupportFirstResponseFact>> {
  const facts = new Map<string, SupportFirstResponseFact>();
  if (!roundIds.length) return facts;
  const rows = (await client.query<{ roundId: string; answeredAt: string | null; answeredByAdminId: string | null }>(
    `SELECT a."object_id" AS "roundId",
            to_char(min(a."occurred_at") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "answeredAt",
            (array_agg(a."actor_id" ORDER BY a."occurred_at", a."id"))[1] AS "answeredByAdminId"
       FROM "zzsh_iam"."audit_event" a
       JOIN "zzsh_iam"."im_consultation" c ON c."app_id" = $1 AND c."id" = a."object_id"
      WHERE a."action" = $2 AND a."object_type" = 'im_consultation' AND a."object_id" = ANY($3::text[])
      GROUP BY a."object_id"`,
    [appId, SUPPORT_FIRST_RESPONSE_ACTION, [...roundIds]],
  )).rows;
  for (const row of rows) facts.set(row.roundId, { answeredAt: row.answeredAt, answeredByAdminId: row.answeredByAdminId });
  return facts;
}

const SUPPORT_OVERVIEW_FIRST_RESPONSE_ROUNDS_SQL = `
  WITH bounds AS (${dayBounds("$2", "$3")})
  SELECT c."id" AS "roundId", c."state", c."first_user_message_at" AS "askedAt"
    FROM "zzsh_iam"."im_consultation" c CROSS JOIN bounds b
   WHERE c."app_id" = $1 AND c."first_user_message_at" >= b.day_start AND c."first_user_message_at" < b.day_end
   ORDER BY c."first_user_message_at", c."id"`;

const SUPPORT_OVERVIEW_RESOLUTION_SQL = `
  WITH bounds AS (${dayBounds("$2", "$3")}),
  lifecycle AS (
    SELECT e."consultation_id" AS id,
           min(e."created_at") FILTER (WHERE e."event_type" IN ('ASSIGNED', 'CLAIMED')) AS taken_at,
           max(e."created_at") FILTER (WHERE e."event_type" = 'CLOSED') AS closed_at
      FROM "zzsh_iam"."im_consultation_event" e
      JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id" AND c."app_id" = $1
     GROUP BY e."consultation_id"
  )
  SELECT count(*)::int AS "closed",
         avg(EXTRACT(EPOCH FROM (l.closed_at - l.taken_at))) AS "averageSeconds"
    FROM lifecycle l CROSS JOIN bounds b
   WHERE l.closed_at >= b.day_start AND l.closed_at < b.day_end AND l.taken_at IS NOT NULL`;

const SUPPORT_OVERVIEW_QUEUE_SQL = `
  WITH queued AS (
    SELECT count(*)::int AS "queued",
           count(*) FILTER (WHERE c."kind" <> 'COMPLAINT')::int AS "serviceQueued",
           count(*) FILTER (WHERE c."kind" = 'COMPLAINT')::int AS "complaintQueued",
           min(c."first_user_message_at") AS "oldestQueuedAt",
           EXTRACT(EPOCH FROM (clock_timestamp() - min(c."first_user_message_at"))) AS "oldestWaitSeconds"
      FROM "zzsh_iam"."im_consultation" c
     WHERE c."app_id" = $1 AND c."state" = 'WAITING' AND c."assigned_admin_id" IS NULL
       AND c."first_user_message_at" IS NOT NULL
  )
  SELECT q."queued", q."serviceQueued", q."complaintQueued",
         to_char(q."oldestQueuedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "oldestQueuedAt",
         floor(COALESCE(q."oldestWaitSeconds", 0))::int AS "oldestWaitSeconds"
    FROM queued q`;

/** 首响质量聚合：事实统一经 readConsultationFirstResponse，不在这里另写跨表 join。 */
async function readSupportFirstResponseQuality(
  client: PoolClient,
  appId: string,
  date: string | null,
  endDate: string | null,
  slaSeconds: number,
): Promise<SupportQualityView["firstResponse"]> {
  const rounds = (await client.query<{ roundId: string; state: string; askedAt: Date | string }>(
    SUPPORT_OVERVIEW_FIRST_RESPONSE_ROUNDS_SQL, [appId, date, endDate],
  )).rows;
  if (!rounds.length) return { slaSeconds, askedCount: 0, averageSeconds: null, sampleCount: 0, breached: 0, pending: 0, overdue: 0 };
  const facts = await readConsultationFirstResponse(client, appId, rounds.map((row) => row.roundId));
  const now = Date.now();
  let answered = 0, breached = 0, pending = 0, overdue = 0, totalSeconds = 0;
  for (const round of rounds) {
    const askedAt = new Date(round.askedAt).getTime();
    const fact = facts.get(round.roundId);
    if (!fact?.answeredAt) {
      if (round.state === "CLOSED") continue;
      pending += 1;
      if (now - askedAt > slaSeconds * 1000) overdue += 1;
      continue;
    }
    const seconds = Math.max(0, Math.round((new Date(fact.answeredAt).getTime() - askedAt) / 1000));
    answered += 1;
    totalSeconds += seconds;
    if (seconds > slaSeconds) breached += 1;
  }
  return {
    slaSeconds, askedCount: rounds.length, sampleCount: answered, breached, pending, overdue,
    averageSeconds: answered ? Math.round(totalSeconds / answered) : null,
  };
}

/**
 * 客服统计只读投影：期间汇总与趋势；当前队列/负载保持实时，旧单日保留7天趋势。
 * 数据不足时 trend/hourly 返回空数组，不画伪造的零趋势。
 */
export async function readSupportOverview(
  options: { pool: Pool; appId: string },
  context: AdminContext,
  dateValue: string | null | undefined,
  limits: { capacityLimit?: number | null; firstResponseSeconds?: number | null } = {},
  dateToValue?: string | null,
): Promise<SupportOverview> {
  const range = parseSupportRange(dateValue, dateToValue);
  const date = range.dateFrom, endDate = range.dateTo;
  // No hard capacity: all fresh online agents are reported as able to take work.
  const capacityLimit = null;
  const firstResponseSeconds = resolveFirstResponseSeconds(limits.firstResponseSeconds);
  return withTransaction(options.pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    requireSupportManagementRead(await loadEffectiveAdminAccess(client, context.userId));
    const clock = await readSupportReportClock(client, range);
    const onDuty = (await client.query<{
      adminUserId: string; name: string; availability: SupportAvailability; connectionState: SupportConnectionState;
      activeLoad: string | number; todaySeconds: string | number; todaySessions: string | number;
      todayUsers: string | number; currentOrderGroups: string | number; totalLoad: string | number;
    }>(SUPPORT_OVERVIEW_ON_DUTY_SQL, [options.appId, date, endDate])).rows.map((row) => ({
      adminUserId: row.adminUserId,
      name: row.name,
      availability: row.availability,
      connectionState: row.connectionState,
      activeLoad: integer(row.activeLoad),
      todaySeconds: integer(row.todaySeconds),
      todaySessions: integer(row.todaySessions),
      todayUsers: integer(row.todayUsers),
      currentOrderGroups: integer(row.currentOrderGroups),
      capacityLimit,
      totalLoad: integer(row.totalLoad),
      atCapacity: false,
    }));
    // Queue eligibility mirrors dispatch: AVAILABLE/CONNECTED/fresh presence with a
    // READY admin identity, read+accept grants, plus complaint for COMPLAINT queues.
    const eligibleRows = (await client.query<{ adminUserId: string; accountId: string; identityMarker: string }>(
      SUPPORT_OVERVIEW_ELIGIBLE_SQL, [options.appId],
    )).rows;
    const eligibleAccess = await Promise.all(eligibleRows.map((row) => loadEffectiveAdminAccess(client, row.adminUserId)));
    const eligible = eligibleRows.flatMap((row, index) => {
      const access = eligibleAccess[index] ?? null;
      const key = { provider: "yunxin" as const, appId: options.appId, realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: row.adminUserId };
      const matches = row.accountId === deriveYunxinAccountId(key) && row.identityMarker === buildYunxinIdentityMarker(key)
        && hasPermission(access, ADMIN_PERMISSION.imSupportRead)
        && hasPermission(access, ADMIN_PERMISSION.imSupportAccept);
      return matches ? [{ row, access }] : [];
    });
    const serviceEligible = eligible.length;
    const complaintEligible = eligible.filter(({ access }) => hasPermission(access, ADMIN_PERMISSION.imSupportComplaint)).length;
    const totalsRow = (await client.query<{
      waitingConsultations: string | number;
      todaySessions: string | number; todayUsers: string | number;
      transfersToday: string | number; handoversToday: string | number;
    }>(SUPPORT_OVERVIEW_TOTALS_SQL, [options.appId, date, endDate])).rows[0];
    const trendRows = (await client.query<{ date: string; sessions: string | number; users: string | number }>(
      SUPPORT_OVERVIEW_TREND_SQL, [options.appId, clock.period.trendFrom, clock.period.trendTo],
    )).rows.map((row) => ({ date: row.date, sessions: integer(row.sessions), users: integer(row.users) }));
    const hourlyRows = (await client.query<{ hour: number; sessions: string | number }>(
      SUPPORT_OVERVIEW_HOURLY_SQL, [options.appId, date, endDate],
    )).rows.map((row) => ({ hour: integer(row.hour), sessions: integer(row.sessions) }));
    const ratingRow = (await client.query<{
      count: string | number; average: string | number | null;
      score1: string | number; score2: string | number; score3: string | number; score4: string | number; score5: string | number;
    }>(SUPPORT_OVERVIEW_RATING_SQL, [options.appId, date, endDate])).rows[0];
    const ratingAgents = (await client.query<{ adminUserId: string; name: string; count: string | number; average: string | number }>(
      SUPPORT_OVERVIEW_RATING_AGENTS_SQL, [options.appId, date, endDate],
    )).rows.flatMap((row) => {
      const average = nullableAverage(row.average);
      return average === null ? [] : [{ adminUserId: row.adminUserId, name: row.name, count: integer(row.count), average }];
    });
    // 排队、首响、解决时长都是只读聚合：没有事实就返回 null/0，不伪造。
    const queueRow = (await client.query<{
      queued: string | number; serviceQueued: string | number; complaintQueued: string | number;
      oldestQueuedAt: string | null; oldestWaitSeconds: string | number;
    }>(SUPPORT_OVERVIEW_QUEUE_SQL, [options.appId])).rows[0];
    const queued = integer(queueRow?.queued);
    const serviceQueued = integer(queueRow?.serviceQueued);
    const complaintQueued = integer(queueRow?.complaintQueued);
    const eligibleForQueuedTypes = eligible.filter(({ access }) =>
      (serviceQueued > 0 && hasPermission(access, ADMIN_PERMISSION.imSupportAccept))
      || (complaintQueued > 0 && hasPermission(access, ADMIN_PERMISSION.imSupportAccept)
        && hasPermission(access, ADMIN_PERMISSION.imSupportComplaint))).length;
    const queue: SupportQueueView = {
      queued,
      serviceQueued,
      complaintQueued,
      serviceEligible,
      complaintEligible,
      oldestQueuedAt: queueRow?.oldestQueuedAt ?? null,
      oldestWaitSeconds: queued > 0 ? integer(queueRow?.oldestWaitSeconds) : null,
      onDuty: serviceEligible,
      withFreeSlot: eligibleForQueuedTypes,
      atCapacity: 0,
      capacityLimit: null,
      reason: queued === 0 ? null
        : (serviceQueued > 0 && serviceEligible === 0) || (complaintQueued > 0 && complaintEligible === 0)
          ? "NO_ONLINE_STAFF"
          : "CAPACITY_AVAILABLE",
    };
    const firstResponse = await readSupportFirstResponseQuality(client, options.appId, date, endDate, firstResponseSeconds);
    const resolutionRow = (await client.query<{ closed: string | number; averageSeconds: string | number | null }>(
      SUPPORT_OVERVIEW_RESOLUTION_SQL, [options.appId, date, endDate],
    )).rows[0];
    const quality: SupportQualityView = {
      firstResponse,
      resolution: { sampleCount: integer(resolutionRow?.closed), averageSeconds: nullableAverage(resolutionRow?.averageSeconds) },
    };
    return {
      ...clock,
      queue,
      quality,
      onDuty,
      totals: {
        onDutyCount: serviceEligible,
        waitingConsultations: integer(totalsRow?.waitingConsultations),
        todaySessions: integer(totalsRow?.todaySessions),
        todayUsers: integer(totalsRow?.todayUsers),
        transfersToday: integer(totalsRow?.transfersToday),
        handoversToday: integer(totalsRow?.handoversToday),
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
  const key = { provider: "yunxin" as const, appId, realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: adminUserId };
  if (!row) return deriveYunxinAccountId(key);
  return row.accountId === deriveYunxinAccountId(key) && row.identityMarker === buildYunxinIdentityMarker(key) ? row.accountId : null;
}

const AUDIT_CONVERSATIONS_SQL = `
  WITH items AS (
    SELECT COALESCE(c."last_message_at", c."updated_at") AS sort_at,
           'CONSULTATION'::text AS item_kind, c."id" AS item_id,
           jsonb_build_object(
             'kind', 'CONSULTATION', 'id', c."id", 'type', c."kind", 'state', c."state",
             'user', jsonb_build_object('id', c."user_id",
               'name', COALESCE(NULLIF(btrim(u."name"), ''), u."username", '平台用户'), 'avatar', u.image),
             'assignedAdmin', CASE WHEN c."assigned_admin_id" IS NULL THEN NULL ELSE jsonb_build_object(
               'id', c."assigned_admin_id",
               'name', COALESCE(NULLIF(btrim(au."name"), ''), '平台客服')) END,
             'lastMessageAt', to_char(c."last_message_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'firstUserMessageAt', to_char(c."first_user_message_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'userUnreadCount', c."user_unread_count", 'adminUnreadCount', c."admin_unread_count",
             'historyState', CASE WHEN c."message_scope_state" = 'READY' AND c."message_scope_id" IS NOT NULL THEN 'AVAILABLE'
               WHEN c."state" = 'CLOSED' THEN 'LEGACY_UNAVAILABLE'
               WHEN c."message_scope_state" IN ('PENDING','NONE') THEN 'NOT_ESTABLISHED' ELSE 'RECOVERING' END,
             'updatedAt', to_char(c."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'conversationId', CASE WHEN c."message_scope_state" = 'READY'
               AND c."message_scope_id" IS NOT NULL AND $2::text IS NOT NULL
               THEN $2 || '|2|' || c."message_scope_id" ELSE NULL END
           ) AS payload
      FROM "zzsh_iam"."im_consultation" c
      JOIN "zzsh_auth_user"."user" u ON u."id" = c."user_id"
      LEFT JOIN "zzsh_auth_admin"."user" au ON au."id" = c."assigned_admin_id"
     WHERE c."app_id" = $1 AND ($7::text IS NULL OR c."kind" = $7)
       AND ($8::text IS NULL OR c."assigned_admin_id" = $8)
    UNION ALL
    SELECT COALESCE(activity.last_message_at, g."team_ready_at", o."created_at") AS sort_at,
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
             'lastMessageAt', to_char(COALESCE(activity.last_message_at, g."team_ready_at", o."created_at") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
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
      LEFT JOIN "zzsh_order"."im_order_activity" activity ON activity."order_id" = g."order_id" AND activity."app_id" = g."app_id"
     WHERE g."app_id" = $1 AND ($7::text IS NULL OR $7::text = 'ORDER')
       AND ($8::text IS NULL OR COALESCE(g."responsible_admin_id", g."assigned_admin_id") = $8)
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
  filters: { type?: string | null; adminUserId?: string | null } = {},
): Promise<SupportAuditPage> {
  const type = filters.type ?? null, adminUserId = filters.adminUserId ?? null;
  if (type !== null && !["SERVICE", "COMPLAINT", "ORDER"].includes(type)) throw invalid("Audit type is invalid");
  if (adminUserId !== null && !ID_PATTERN.test(adminUserId)) throw invalid("Administrator identifier is invalid");
  const limit = parseAuditLimit(limitValue);
  const cursor = cursorValue === undefined || cursorValue === null ? null : decodeSupportAuditCursor(cursorValue);
  const filterScope = type || adminUserId ? JSON.stringify([options.appId,context.userId,type,adminUserId]) : undefined;
  if (cursor && cursor.filterScope !== filterScope) throw invalid("Cursor does not match audit filters");
  return withTransaction(options.pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    requireSupportManagementRead(await loadEffectiveAdminAccess(client, context.userId));
    const viewerAccountId = await auditViewerAccount(client, options.appId, context.userId);
    const rows = (await client.query<{ sortAt: string; kind: "CONSULTATION" | "ORDER_GROUP"; id: string; payload: Record<string, unknown> }>(
      AUDIT_CONVERSATIONS_SQL,
      [options.appId, viewerAccountId, cursor?.sortAt ?? null, cursor?.kind ?? null, cursor?.id ?? null, limit + 1, type, adminUserId],
    )).rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => {
        const payload=row.payload as unknown as SupportAuditItem;
        if(payload.kind==="CONSULTATION") payload.user.avatar=managedProfileImagePath(payload.user.avatar);
        return payload;
      }),
      nextCursor: hasMore && page.length > 0 ? encodeSupportAuditCursor(page[page.length - 1]!.sortAt, page[page.length - 1]!.kind, page[page.length - 1]!.id, filterScope) : null,
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

export async function readPatrolConsultationAccess(client:PoolClient,input:{appId:string;teamId:string;conversationId:string;requestId:string},actor:{userId:string;sessionId:string}):Promise<{viewerAccountId:string;peerAccountId:string}|null>{
  await assertAdminContextInTransaction(client,actor);
  const access=await loadEffectiveAdminAccess(client,actor.userId);requireSupportManagementRead(access);
  const row=(await client.query<{id:string;user_account_id:string}>(`SELECT c.id,t.user_account_id FROM zzsh_iam.im_support_thread t
    JOIN zzsh_iam.im_consultation c ON c.thread_id=t.id AND c.app_id=t.app_id
    WHERE t.app_id=$1 AND ((t.message_scope_id=$2 AND t.message_scope_state='READY')
      OR (c.message_scope_id=$2 AND c.message_scope_state='READY' AND c.state='CLOSED'))
    ORDER BY (c.state<>'CLOSED') DESC,c.created_at DESC,c.id DESC LIMIT 1`,[input.appId,input.teamId])).rows[0];
  if(!row)return null;
  const viewerAccountId=await auditViewerAccount(client,input.appId,actor.userId);
  if(!viewerAccountId||input.conversationId!==`${viewerAccountId}|2|${input.teamId}`)return null;
  await recordAudit(client,{actorType:"admin",actorId:actor.userId,sessionId:actor.sessionId,action:"im.audit.conversation_viewed",objectType:"im_consultation",objectId:row.id,outcome:"SUCCESS",requestId:input.requestId,details:{mode:"PATROL_READ",teamId:input.teamId}});
  return {viewerAccountId,peerAccountId:row.user_account_id};
}

/** Self-only statistics: no caller-supplied employee identity and no management-read grant. */
export async function readOwnSupportStatistics(options: { pool: Pool; appId: string }, context: AdminContext,
  dateValue?: string | null, dateToValue?: string | null) {
  const range = parseSupportRange(dateValue, dateToValue);
  return withTransaction(options.pool, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403,"FORBIDDEN","Permission required");
    const clock = await readSupportReportClock(client, range);
    const today = await readSupportToday(client, options.appId, context.userId, range.dateFrom, range.dateTo);
    const row = (await client.query<{ active:number; orderGroups:number; unread:number; oldestPendingAt:string|null }>(`
      SELECT (SELECT count(*)::int FROM zzsh_iam.im_consultation c WHERE c.app_id=$1 AND c.assigned_admin_id=$2 AND c.state='ACTIVE') AS active,
        (SELECT count(*)::int FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id=g.order_id
          WHERE g.app_id=$1 AND COALESCE(g.responsible_admin_id,g.assigned_admin_id)=$2 AND o.status='PAID') AS "orderGroups",
        (SELECT COALESCE(sum(c.admin_unread_count),0)::int FROM zzsh_iam.im_consultation c
          WHERE c.app_id=$1 AND c.assigned_admin_id=$2 AND c.state='ACTIVE') AS unread,
        (SELECT to_char(min(c.first_user_message_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          FROM zzsh_iam.im_consultation c WHERE c.app_id=$1 AND c.assigned_admin_id=$2 AND c.state='ACTIVE'
          AND c.admin_unread_count>0) AS "oldestPendingAt"`, [options.appId,context.userId])).rows[0];
    const rating = (await client.query<{ count:number; average:string|null; distribution:number[] }>(`
      WITH bounds AS (${dayBounds("$3", "$4")})
      SELECT count(*)::int AS count, avg(score) AS average,
        ARRAY[count(*) FILTER (WHERE score=1),count(*) FILTER (WHERE score=2),count(*) FILTER (WHERE score=3),
          count(*) FILTER (WHERE score=4),count(*) FILTER (WHERE score=5)]::int[] AS distribution
        FROM zzsh_iam.im_support_round_rating r CROSS JOIN bounds b
        WHERE r.app_id=$1 AND r.assigned_admin_id=$2 AND r.submitted_at>=b.day_start AND r.submitted_at<b.day_end`,[options.appId,context.userId,range.dateFrom,range.dateTo])).rows[0];
    if (!row || !rating) throw new Error("Support statistics are incomplete");
    const rounds = (await client.query<{ roundId:string; askedAt:Date|string }>(`
      WITH bounds AS (${dayBounds("$4", "$5")})
      SELECT c.id AS "roundId", c.first_user_message_at AS "askedAt"
        FROM zzsh_iam.im_consultation c CROSS JOIN bounds b
        WHERE c.app_id=$1 AND c.first_user_message_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_type='im_consultation' AND a.object_id=c.id
            AND a.action=$3 AND a.actor_id=$2 AND a.occurred_at>=b.day_start AND a.occurred_at<b.day_end)
      `,[options.appId,context.userId,SUPPORT_FIRST_RESPONSE_ACTION,range.dateFrom,range.dateTo])).rows;
    const facts = await readConsultationFirstResponse(client,options.appId,rounds.map(r=>r.roundId));
    const seconds = rounds.flatMap(r => {
      const fact = facts.get(r.roundId);
      return fact?.answeredAt && fact.answeredByAdminId===context.userId
        ? [Math.max(0,Math.round((new Date(fact.answeredAt).getTime()-new Date(r.askedAt).getTime())/1000))] : [];
    });
    return {
      ...clock, today,
      current:{consultations:integer(row.active),orderGroups:integer(row.orderGroups),unread:integer(row.unread),oldestPendingAt:row.oldestPendingAt},
      ratings:{count:integer(rating.count),average:nullableAverage(rating.average),distribution:rating.distribution},
      firstResponse:{sampleCount:seconds.length,averageSeconds:seconds.length?Math.round(seconds.reduce((a,b)=>a+b,0)/seconds.length):null},
    };
  });
}
