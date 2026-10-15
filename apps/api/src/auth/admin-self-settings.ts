import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";
import { API_V1_ERROR_CODES, ensureApiV1RequestId } from "../contracts/api-v1";
import { assertAdminContextInTransaction, readAdminContext, type AdminContext, type AuthSecurityNodeRequest, type AuthSecurityNodeResponse, type AuthSecurityOptions } from "./auth-security";
import { SecurityApiError } from "./security-core";
import { withDirectoryReadTransaction } from "./user-directory-read";

// R0 shares existing authentication/read transactions; no settings writer or new schema is mounted.
const USER_AGENT_MAX_LENGTH = 512;

const ACTIVITY_DEFAULT_LIMIT = 20;

const ACTIVITY_MAX_LIMIT = 50;

const ACTIVITY_REASON_MAX_LENGTH = 256;

export const SELF_ACTIVITY_ACTOR_ACTIONS = [
  "admin.password.changed",
  "admin.password.change",
  "admin.pin.set",
  "admin.pin.change",
  "admin.pin.locked",
  "admin.pin.unlock",
  "admin.backup_codes.generated",
  "admin.backup_codes.generate",
  "admin.self.sessions.revoked",
  "admin.enrollment.activated",
  "admin.recovery.requested",
  "admin.recovery.completed",
] as const;

export const SELF_ACTIVITY_TARGET_ACTIONS = [
  "admin.frozen",
  "admin.unfrozen",
  "admin.session.force_logged_out",
  "admin.account.updated",
  "admin.permission.assigned",
  "admin.game_scope.assigned",
  "admin.account.created",
  "admin.bootstrap.created",
  "admin.enrollment.activated",
  "admin.recovery.completed",
] as const;

export const SELF_ACTIVITY_RECOVERY_TARGET_ACTIONS = [
  "admin.recovery.issued",
  "admin.recovery.disaster.issued",
] as const;

export const SELF_ACTIVITY_READABLE_ACTIONS = [
  ...new Set<string>([
    ...SELF_ACTIVITY_ACTOR_ACTIONS,
    ...SELF_ACTIVITY_TARGET_ACTIONS,
    ...SELF_ACTIVITY_RECOVERY_TARGET_ACTIONS,
  ]),
];

// R1 已装配本人改密与备份码 writer（含带 key 拒绝回执审计）：admin.password.changed/.change 与
// admin.backup_codes.generated/.generate 都有实际写入点，与可读历史动作分开记录。
// 本人其他设备注销仍未实现；sign_in/sign_out 继续不在本投影内。
const UNMOUNTED_ACTIVITY_ACTIONS = ["admin.self.sessions.revoked"];
// Readable historical actions do not imply that every held writer is mounted.
export const SELF_ACTIVITY_RECORDED_ACTIONS = SELF_ACTIVITY_READABLE_ACTIONS.filter(action => !UNMOUNTED_ACTIVITY_ACTIONS.includes(action));
export const SELF_ACTIVITY_NOT_RECORDED = ["sign_in", "sign_out", ...UNMOUNTED_ACTIVITY_ACTIONS];

const ACTIVITY_CATEGORY: Record<string, string> = {
  "admin.password.changed": "credential",
  "admin.password.change": "credential",
  "admin.pin.set": "pin",
  "admin.pin.change": "pin",
  "admin.pin.locked": "pin",
  "admin.pin.unlock": "pin",
  "admin.backup_codes.generated": "backup_codes",
  "admin.backup_codes.generate": "backup_codes",
  "admin.self.sessions.revoked": "session",
  "admin.session.force_logged_out": "session",
  "admin.enrollment.activated": "account",
  "admin.bootstrap.created": "account",
  "admin.account.created": "account",
  "admin.account.updated": "account",
  "admin.permission.assigned": "account",
  "admin.game_scope.assigned": "account",
  "admin.frozen": "account",
  "admin.unfrozen": "account",
  "admin.recovery.requested": "recovery",
  "admin.recovery.issued": "recovery",
  "admin.recovery.completed": "recovery",
  "admin.recovery.disaster.issued": "recovery",
};

const GATE_REASONS = new Map<string, string>([
  ["Authentication required", "authentication_required"],
  ["Account unavailable", "account_unavailable"],
  ["Additional verification required", "additional_verification_required"],
  ["Account locked", "session_locked"],
]);

function reject(status: number, code: (typeof API_V1_ERROR_CODES)[keyof typeof API_V1_ERROR_CODES], message: string, reason: string): never {
  throw Object.assign(new SecurityApiError(status, code, message), { reason });
}

const SELF_SETTINGS_PREFIX = "/api/v1/admin/self";

type SelfProfileRow = {
  id: string;
  username: string | null;
  displayUsername: string | null;
  name: string;
  image: string | null;
  updatedAt: Date | string;
};

type ActivityRow = {
  eventId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  outcome: string;
  reason: string | null;
  requestId: string | null;
  occurredAt: Date | string;
  occurredAtExact: string;
  details: unknown;
  actorUsername: string | null;
  actorDisplayUsername: string | null;
};

function iso(value: Date | string | null): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function queryValue(request: AuthSecurityNodeRequest, name: string): string | undefined {
  const source = request.originalUrl ?? request.url ?? "";
  const index = source.indexOf("?");
  if (index < 0) return undefined;
  const value = new URLSearchParams(source.slice(index + 1)).get(name);
  return value && value.length > 0 ? value : undefined;
}

function sendJson(response: AuthSecurityNodeResponse, status: number, body: unknown, requestId: string): void {
  if (response.headersSent) return;
  response.status(status).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store").json(body);
}

function sendError(response: AuthSecurityNodeResponse, error: SecurityApiError, requestId: string): void {
  const explicit = (error as { reason?: unknown }).reason;
  const reason = typeof explicit === "string" && explicit.length > 0 ? explicit : GATE_REASONS.get(error.message);
  sendJson(
    response,
    error.status,
    { error: { code: error.code, message: error.message, requestId, ...(reason ? { reason } : {}) } },
    requestId,
  );
}

function profileView(row: SelfProfileRow): Record<string, unknown> {
  const displayUsername = row.displayUsername?.trim();
  return {
    adminUserId: row.id,
    // ZZ 编号来自 username/displayUsername（sequence 分配、不可改名），不是内部 UUID，也不自行生成。
    zzNumber: displayUsername ? displayUsername : row.username ? row.username.toUpperCase() : null,
    displayName: row.name,
    avatarUrl: row.image ?? null,
    updatedAt: iso(row.updatedAt),
  };
}

function activityActor(row: ActivityRow, selfId: string): Record<string, unknown> {
  if (row.actorType === "system" || row.actorType === "maintenance") return { kind: "system", ref: null };
  if (row.actorId === selfId && (row.actorType === "admin" || row.actorType === "admin_recovery_target")) {
    return { kind: "self", ref: null };
  }
  const ref = row.actorDisplayUsername?.trim() || (row.actorUsername ? row.actorUsername.toUpperCase() : null);
  return { kind: "other", ref };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function activityDetails(action: string, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const details = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  if (action === "admin.password.changed") {
    const count = finiteNumber(details.revokedSessionCount);
    if (count !== undefined) picked.revokedSessionCount = count;
  } else if (action === "admin.backup_codes.generated") {
    const generation = finiteNumber(details.generation);
    const codeCount = finiteNumber(details.codeCount);
    if (generation !== undefined) picked.generation = generation;
    if (codeCount !== undefined) picked.codeCount = codeCount;
  } else if (action === "admin.pin.change" || action === "admin.pin.unlock") {
    const pinFailures = finiteNumber(details.pinFailures);
    if (pinFailures !== undefined) picked.pinFailures = pinFailures;
    if (typeof details.locked === "boolean") picked.locked = details.locked;
  } else if (action === "admin.session.force_logged_out") {
    const count = finiteNumber(details.revokedSessions);
    if (count !== undefined) picked.revokedSessions = count;
  } else if (action === "admin.self.sessions.revoked") {
    if (details.scope === "one" || details.scope === "others") picked.scope = details.scope;
    const count = finiteNumber(details.revokedSessionCount);
    if (count !== undefined) picked.revokedSessionCount = count;
  }
  return picked;
}

function activityView(row: ActivityRow, selfId: string): Record<string, unknown> {
  return {
    eventId: row.eventId,
    occurredAt: iso(row.occurredAt),
    action: row.action,
    category: ACTIVITY_CATEGORY[row.action] ?? "other",
    outcome: row.outcome === "FAILURE" ? "FAILURE" : "SUCCESS",
    reason: typeof row.reason === "string" && row.reason.length > 0 ? row.reason.slice(0, ACTIVITY_REASON_MAX_LENGTH) : null,
    actor: activityActor(row, selfId),
    details: activityDetails(row.action, row.details),
    requestId: row.requestId,
  };
}

function encodeCursor(row: ActivityRow): string {
  return Buffer.from(JSON.stringify({ occurredAt: row.occurredAtExact, id: row.eventId })).toString("base64url");
}

const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function parseCursor(value: string | undefined): { occurredAt: string; id: string } | undefined {
  if (!value) return undefined;
  if (value.length > 256) reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Cursor is invalid", "cursor_invalid");
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { occurredAt?: string; id?: string };
    if (
      typeof decoded.occurredAt !== "string" || !CURSOR_TIME_PATTERN.test(decoded.occurredAt)
      || typeof decoded.id !== "string" || decoded.id.length === 0 || decoded.id.length > 128
      || /[\u0000-\u001f\u007f-\u009f]/.test(decoded.id)
    ) {
      reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Cursor is invalid", "cursor_invalid");
    }
    const parsedTime = new Date(decoded.occurredAt);
    // Date 会把 2 月 30 日归一化；只借它校验日历，排序参数仍返回原微秒文本。
    if (decoded.occurredAt.startsWith("0000-") || Number.isNaN(parsedTime.getTime())
      || parsedTime.toISOString().slice(0, 19) !== decoded.occurredAt.slice(0, 19)) {
      reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Cursor is invalid", "cursor_invalid");
    }
    return { occurredAt: decoded.occurredAt, id: decoded.id };
  } catch (error) {
    if (error instanceof SecurityApiError) throw error;
    reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Cursor is invalid", "cursor_invalid");
  }
}

function parseTime(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!CURSOR_TIME_PATTERN.test(value) || value.startsWith("0000-") || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, label + " filter is invalid", "time_filter_invalid");
  }
  return value.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction = "") => "." + fraction.padEnd(6, "0") + "Z");
}

type ActivityQuery = { limit: number; cursor?: { occurredAt: string; id: string }; action?: string; from?: string; to?: string };

function parseActivityQuery(request: AuthSecurityNodeRequest): ActivityQuery {
  const rawLimit = queryValue(request, "limit");
  const limit = rawLimit === undefined ? ACTIVITY_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT) {
    reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Limit is invalid", "limit_invalid");
  }
  const action = queryValue(request, "action");
  if (action && !SELF_ACTIVITY_READABLE_ACTIONS.includes(action)) {
    reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Action filter is invalid", "action_filter_invalid");
  }
  const from = parseTime(queryValue(request, "from"), "From");
  const to = parseTime(queryValue(request, "to"), "To");
  if (from && to && from > to) {
    reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Time range is invalid", "time_range_invalid");
  }
  return { limit, cursor: parseCursor(queryValue(request, "cursor")), action, from, to };
}

type ReadEvents = { once?: (event: string, listener: () => void) => unknown; off?: (event: string, listener: () => void) => unknown };
type ReadRequest = AuthSecurityNodeRequest & ReadEvents & { aborted?: boolean };
type ReadResponse = AuthSecurityNodeResponse & ReadEvents & { writableFinished?: boolean; destroyed?: boolean };

async function readSelfProfile(client: PoolClient, context: AdminContext): Promise<SelfProfileRow> {
  const row = (await client.query<SelfProfileRow & { suspended: boolean }>(
    'SELECT "id", "username", "displayUsername", "name", "image", "updatedAt", "suspended" FROM "zzsh_auth_admin"."user" WHERE "id" = $1',
    [context.userId],
  )).rows[0];
  if (!row || row.suspended) reject(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable", "account_unavailable");
  return row;
}

async function listSelfSessions(client: PoolClient, context: AdminContext): Promise<unknown> {
  const rows = (await client.query<{ id: string; createdAt: Date | null; expiresAt: Date; userAgent: string | null; locked: boolean }>(
    'SELECT "id", "createdAt", "expiresAt", "userAgent", "locked" FROM "zzsh_auth_admin"."session" WHERE "userId" = $1 AND "expiresAt" > clock_timestamp() ORDER BY "createdAt" DESC, "id" LIMIT 101',
    [context.userId],
  )).rows;
  if (rows.length > 100) reject(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Session list capacity exceeded", "session_list_limit_exceeded");
  return { sessions: rows.map(row => ({ id: row.id, isCurrent: row.id === context.sessionId, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt), userAgent: row.userAgent ? row.userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null, locked: row.locked === true })) };
}

async function readSelfSecurityActivity(client: PoolClient, context: AdminContext, query: ActivityQuery): Promise<unknown> {
  const values: unknown[] = [
    context.userId,
    [...SELF_ACTIVITY_ACTOR_ACTIONS],
    [...SELF_ACTIVITY_TARGET_ACTIONS],
    [...SELF_ACTIVITY_RECOVERY_TARGET_ACTIONS],
    query.limit + 1,
  ];
  const conditions = [
    `((e."actor_type" IN ('admin', 'admin_recovery_target') AND e."actor_id" = $1 AND e."action" = ANY($2::text[]))
       OR (e."object_id" = $1 AND e."action" = ANY($3::text[])
           AND e."object_type" = CASE WHEN e."action" IN ('admin.frozen', 'admin.unfrozen', 'admin.enrollment.activated') THEN 'admin_security' ELSE 'admin_user' END)
       OR (e."object_type" = 'admin_recovery_request' AND e."action" = ANY($4::text[]) AND e."details"->>'targetAdminId' = $1))`,
  ];
  if (query.action) conditions.push(`e."action" = $${values.push(query.action)}`);
  if (query.from) conditions.push(`e."occurred_at" >= $${values.push(query.from)}`);
  if (query.to) conditions.push(`e."occurred_at" <= $${values.push(query.to)}`);
  if (query.cursor) {
    values.push(query.cursor.occurredAt, query.cursor.id);
    const timeParameter = values.length - 1;
    const idParameter = values.length;
    conditions.push(`(e."occurred_at" < $${timeParameter}::timestamptz OR (e."occurred_at" = $${timeParameter}::timestamptz AND e."id" < $${idParameter}))`);
  }
  const rows = (await client.query<ActivityRow>(
    `SELECT e."id" AS "eventId", e."actor_type" AS "actorType", e."actor_id" AS "actorId", e."action", e."outcome",
            e."reason", e."request_id" AS "requestId", e."occurred_at" AS "occurredAt",
            to_char(e."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAtExact",
            e."details",
            u."username" AS "actorUsername", u."displayUsername" AS "actorDisplayUsername"
       FROM "zzsh_iam"."audit_event" e
       LEFT JOIN "zzsh_auth_admin"."user" u ON u."id" = e."actor_id" AND e."actor_type" IN ('admin', 'admin_recovery_target')
      WHERE ${conditions.join(" AND ")}
      ORDER BY e."occurred_at" DESC, e."id" DESC
      LIMIT $5`,
    values,
  )).rows;
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    events: page.map((row) => activityView(row, context.userId)),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    coverage: {
      scope: "SELF_SECURITY_ACTIVITY",
      recordedActions: SELF_ACTIVITY_RECORDED_ACTIONS,
      notRecorded: [...SELF_ACTIVITY_NOT_RECORDED],
    },
  };
}

export async function handleAdminSelfSettingsRoute(request: ReadRequest, response: ReadResponse, options: AuthSecurityOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store");
  const controller = new AbortController();
  let disconnected = request.aborted === true || response.destroyed === true;
  const abort = () => { disconnected = true; controller.abort(new SecurityApiError(499, API_V1_ERROR_CODES.INTERNAL_ERROR, "Request closed")); };
  const close = () => { if (!response.writableFinished) abort(); };
  request.once?.("aborted", abort); response.once?.("close", close);
  try {
    if (disconnected) abort();
    controller.signal.throwIfAborted();
    const origin = headerValue(request.headers.origin);
    if (origin && origin !== options.apiOrigin && origin !== options.adminOrigin) reject(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected", "origin_rejected");
    const path = (request.originalUrl ?? request.url ?? "").split("?", 1)[0] ?? "";
    if (request.method !== "GET" || !["/profile", "/sessions", "/security-activity"].some(tail => path === SELF_SETTINGS_PREFIX + tail)) {
      reject(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found", "not_found");
    }
    const activityQuery = path.endsWith("/security-activity") ? parseActivityQuery(request) : undefined;
    const context = await readAdminContext(request, options);
    const data = await withDirectoryReadTransaction(options.pool, controller.signal, async client => {
      await assertAdminContextInTransaction(client, context);
      const profile = await readSelfProfile(client, context);
      if (path.endsWith("/profile")) return profileView(profile);
      if (path.endsWith("/sessions")) return listSelfSessions(client, context);
      return readSelfSecurityActivity(client, context, activityQuery!);
    });
    controller.signal.throwIfAborted();
    sendJson(response, 200, data, requestId);
  } catch (error) {
    if (!disconnected) {
      if (error instanceof SecurityApiError) sendError(response, error, requestId);
      else sendJson(response, 500, { error: { code: API_V1_ERROR_CODES.INTERNAL_ERROR, message: "Internal server error", requestId } }, requestId);
    }
  } finally {
    request.off?.("aborted", abort); response.off?.("close", close);
  }
}

export function mountAdminSelfSettingsHandlers(app: INestApplication, options: AuthSecurityOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as { use: (path: string, middleware: (request: ReadRequest, response: ReadResponse) => Promise<void>) => void };
  expressApp.use(SELF_SETTINGS_PREFIX, (request, response) => handleAdminSelfSettingsRoute(request, response, options));
}
