import type { Pool } from "pg";
import type { AuthSecurityNodeRequest, AuthSecurityNodeResponse, AuthSecurityOptions } from "./auth-security";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "./admin-authorization";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError, withTransaction } from "./security-core";
import { lockActor } from "./admin-directory";

type AdminContext = { userId: string; sessionId: string };
type ContextReader = (request: AuthSecurityNodeRequest, options: AuthSecurityOptions) => Promise<AdminContext>;

/** 「账号与权限审计」白名单：账号、角色、授权、会话、认证安全与敏感读取。 */
export const GENERIC_ADMIN_AUDIT_ACTIONS = [
  "admin.account.created",
  "admin.account.updated",
  "admin.permission.assigned",
  "admin.game_scope.assigned",
  "admin.role.created",
  "admin.role.updated",
  "admin.frozen",
  "admin.unfrozen",
  "admin.session.force_logged_out",
  "user.account.restored",
  "user.account.frozen",
  "user.account.unfrozen",
  "admin.bootstrap.created",
  "admin.enrollment.activated",
  "admin.password.change",
  "admin.password.changed",
  "admin.backup_codes.generated",
  "admin.login_two_factor.changed",
  "admin.security.insert",
  "admin.security.update",
  "admin.auth.failure",
  "admin.auth.lockout",
  "admin.pin.set",
  "admin.pin.change",
  "admin.pin.locked",
  "admin.pin.unlock",
  "admin.recovery.requested",
  "admin.recovery.issued",
  "admin.recovery.completed",
  "admin.recovery.disaster.issued",
  "user.identity.sensitive.read",
] as const;

/** 前端筛选可选的对象类型；legacy 别名在查询时自动并入。 */
export const GENERIC_ADMIN_AUDIT_OBJECT_TYPES = [
  "admin_user",
  "admin_security",
  "admin_role",
  "admin_session",
  "admin_auth_subject",
  "admin_recovery_request",
  "user_account",
  "user",
] as const;

/** 历史/触发器写入的对象类型别名（例如 better-auth 触发器旧版写入 auth_user）。 */
const OBJECT_TYPE_ALIASES: Record<string, string[]> = {
  admin_user: ["admin_user", "auth_user", "zzsh_auth_admin.account"],
  admin_security: ["admin_security", "zzsh_iam.admin_security"],
};

const GENERIC_ACTIONS = new Set<string>(GENERIC_ADMIN_AUDIT_ACTIONS);
const GENERIC_OBJECT_TYPES = new Set<string>(GENERIC_ADMIN_AUDIT_OBJECT_TYPES);
const GENERIC_OBJECT_TYPES_EXPANDED = [...new Set(GENERIC_ADMIN_AUDIT_OBJECT_TYPES.flatMap((type) => OBJECT_TYPE_ALIASES[type] ?? [type]))];
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[a-z][a-z0-9_:.-]{0,127}$/i;
const ACTION_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const OBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
const MAX_PAGE_SIZE = 100;
const SENSITIVE_DETAIL_KEY = /(password|token|secret|pin|otp|credential|authorization|cookie|document|id.?number|phone|raw|payload|provider.?response|chat.?body|request.?body)/i;

type AuditRow = {
  id: string;
  actorType: string;
  actorUsername: string | null;
  actorDisplayUsername: string | null;
  actorName: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  objectName: string | null;
  objectUsername: string | null;
  outcome: "SUCCESS" | "FAILURE";
  reason: string | null;
  requestId: string | null;
  occurredAt: Date | string;
  details: Record<string, unknown>;
};

function routePath(request: AuthSecurityNodeRequest): string {
  const source = request.originalUrl ?? request.url ?? "/";
  return source.split("?", 1)[0] || "/";
}

function queryValue(request: AuthSecurityNodeRequest, name: string): string | undefined {
  const source = request.originalUrl ?? request.url ?? "";
  const index = source.indexOf("?");
  if (index < 0) return undefined;
  const value = new URLSearchParams(source.slice(index + 1)).get(name);
  return value && value.length > 0 ? value : undefined;
}

function invalid(message: string): never {
  throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, message);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function sendSuccess(response: AuthSecurityNodeResponse, body: unknown, requestId: string): void {
  if (response.headersSent) return;
  response.status(200).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store").json(body);
}

export function sanitizeDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDetail);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) continue;
    result[key] = sanitizeDetail(child);
  }
  return result;
}

/** 规范化对象类型：历史别名统一成页面使用的类型。 */
export function canonicalObjectType(objectType: string): string {
  for (const [canonical, aliases] of Object.entries(OBJECT_TYPE_ALIASES)) {
    if (aliases.includes(objectType)) return canonical;
  }
  return objectType;
}

function auditView(row: AuditRow): Record<string, unknown> {
  const system = row.actorType !== "admin" || !row.actorUsername;
  return {
    eventId: row.id,
    actor: {
      type: row.actorType ?? "admin",
      username: row.actorUsername ?? "系统",
      displayUsername: row.actorDisplayUsername ?? row.actorUsername?.toUpperCase() ?? "系统",
      name: system && !row.actorName ? (row.actorType === "maintenance" ? "运维通道" : row.actorType === "user" ? "用户" : "系统") : row.actorName ?? "系统",
    },
    action: row.action,
    objectType: canonicalObjectType(row.objectType),
    rawObjectType: row.objectType,
    objectId: row.objectId,
    objectDisplay: row.objectName
      ? (row.objectUsername ? `${row.objectName}（${row.objectUsername.toUpperCase()}）` : row.objectName)
      : null,
    outcome: row.outcome,
    reason: row.reason,
    requestId: row.requestId,
    occurredAt: iso(row.occurredAt),
    details: sanitizeDetail(row.details),
  };
}

function parseCursor(value: string | undefined): [Date, string] | undefined {
  if (!value) return undefined;
  if (value.length > 256) invalid("Cursor is invalid");
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { occurredAt?: string; id?: string };
    if (typeof decoded.occurredAt !== "string" || typeof decoded.id !== "string" || decoded.id.length === 0 || decoded.id.length > 128) invalid("Cursor is invalid");
    const occurredAt = new Date(decoded.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) invalid("Cursor is invalid");
    return [occurredAt, decoded.id];
  } catch {
    invalid("Cursor is invalid");
  }
}

function parseTime(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  if (value.length > 40) invalid(`${label} filter is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) invalid(`${label} filter is invalid`);
  return parsed;
}

type CommonFilters = {
  limit: number;
  actorUsername?: string;
  objectId?: string;
  requestId?: string;
  outcome?: string;
  from?: Date;
  to?: Date;
  cursor?: [Date, string];
};

function commonFilters(request: AuthSecurityNodeRequest): CommonFilters {
  const rawLimit = queryValue(request, "limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) invalid("Limit is invalid");
  const actorUsername = queryValue(request, "actorUsername")?.trim().toLowerCase();
  if (actorUsername && !USERNAME_PATTERN.test(actorUsername)) invalid("Actor filter is invalid");
  const objectId = queryValue(request, "objectId")?.trim();
  if (objectId && !ID_PATTERN.test(objectId)) invalid("Object id is invalid");
  const requestId = queryValue(request, "requestId")?.trim();
  if (requestId && requestId.length > 128) invalid("Request id is invalid");
  const outcome = queryValue(request, "outcome");
  if (outcome && outcome !== "SUCCESS" && outcome !== "FAILURE") invalid("Outcome filter is invalid");
  const from = parseTime(queryValue(request, "from"), "From");
  const to = parseTime(queryValue(request, "to"), "To");
  if (from && to && from.getTime() > to.getTime()) invalid("Time range is invalid");
  const cursor = parseCursor(queryValue(request, "cursor"));
  return { limit, actorUsername, objectId, requestId, outcome, from, to, cursor };
}

function applyCommon(values: unknown[], conditions: string[], filters: CommonFilters): void {
  if (filters.actorUsername) conditions.push(`lower(COALESCE(u."username", '')) = $${values.push(filters.actorUsername)}`);
  if (filters.objectId) conditions.push(`e."object_id" = $${values.push(filters.objectId)}`);
  if (filters.requestId) conditions.push(`e."request_id" = $${values.push(filters.requestId)}`);
  if (filters.outcome) conditions.push(`e."outcome" = $${values.push(filters.outcome)}`);
  if (filters.from) conditions.push(`e."occurred_at" >= $${values.push(filters.from)}`);
  if (filters.to) conditions.push(`e."occurred_at" <= $${values.push(filters.to)}`);
  if (filters.cursor) {
    values.push(filters.cursor[0], filters.cursor[1]);
    const timeParameter = values.length - 1;
    const idParameter = values.length;
    conditions.push(`(e."occurred_at" < $${timeParameter} OR (e."occurred_at" = $${timeParameter} AND e."id" < $${idParameter}))`);
  }
}

async function runQuery(options: AuthSecurityOptions, values: unknown[], conditions: string[], limit: number) {
  const result = await options.pool.query<AuditRow>(
    `SELECT e."id", e."actor_type" AS "actorType", u."username" AS "actorUsername", u."displayUsername" AS "actorDisplayUsername", u."name" AS "actorName",
            e."action", e."object_type" AS "objectType", e."object_id" AS "objectId",
            COALESCE(ou."name", r."name") AS "objectName", ou."username" AS "objectUsername",
            e."outcome", e."reason", e."request_id" AS "requestId", e."occurred_at" AS "occurredAt", e."details"
       FROM "zzsh_iam"."audit_event" e
       LEFT JOIN "zzsh_auth_admin"."user" u ON u."id" = e."actor_id" AND e."actor_type" = 'admin'
       LEFT JOIN "zzsh_auth_admin"."user" ou ON ou."id" = e."object_id" AND e."object_type" IN ('admin_user', 'auth_user', 'admin_security', 'zzsh_iam.admin_security')
       LEFT JOIN "zzsh_iam"."admin_role" r ON r."id" = e."object_id" AND e."object_type" = 'admin_role'
      WHERE ${conditions.length ? conditions.join(" AND ") : "TRUE"}
      ORDER BY e."occurred_at" DESC, e."id" DESC
      LIMIT $1`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ occurredAt: iso(rows.at(-1)?.occurredAt), id: rows.at(-1)?.id })).toString("base64url")
    : null;
  return { events: rows.map(auditView), nextCursor };
}

async function auditEvents(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  readContext: ContextReader,
): Promise<void> {
  const context = await readContext(request, options);
  const access = await loadEffectiveAdminAccess(options.pool, context.userId);
  if (!access || !hasPermission(access, ADMIN_PERMISSION.auditRead)) {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
  }
  const action = queryValue(request, "action");
  if (action && !GENERIC_ACTIONS.has(action)) invalid("Action filter is invalid");
  const objectType = queryValue(request, "objectType");
  if (objectType && !GENERIC_OBJECT_TYPES.has(objectType)) invalid("Object filter is invalid");
  const filters = commonFilters(request);

  const values: unknown[] = [filters.limit + 1, [...GENERIC_ACTIONS], GENERIC_OBJECT_TYPES_EXPANDED];
  const conditions = [
    `e."action" = ANY($2::text[])`,
    `e."object_type" = ANY($3::text[])`,
  ];
  if (!access.isBoss) {
    const userParameter = values.push(context.userId);
    conditions.push(`(e."object_id" = $${userParameter} OR (e."actor_id" = $${userParameter} AND e."object_type" IN ('admin_role', 'user_account', 'user', 'admin_session')))`);
  }
  if (action) conditions.push(`e."action" = $${values.push(action)}`);
  if (objectType) conditions.push(`e."object_type" = ANY($${values.push(OBJECT_TYPE_ALIASES[objectType] ?? [objectType])}::text[])`);
  applyCommon(values, conditions, filters);

  const page = await runQuery(options, values, conditions, filters.limit);
  sendSuccess(response, {
    ...page,
    scope: access.isBoss ? "BOSS_ALL_GENERIC_ADMIN_AUDIT" : "SELF_TARGET_AND_ROLE_ACTIONS",
    allowedActions: GENERIC_ADMIN_AUDIT_ACTIONS,
    allowedObjectTypes: GENERIC_ADMIN_AUDIT_OBJECT_TYPES,
  }, requestId);
}

/** Boss 专用「操作日志」：全部 audit_event，不设动作白名单，仅只读。 */
async function operationLog(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  readContext: ContextReader,
): Promise<void> {
  const context = await readContext(request, options);
  const access = await loadEffectiveAdminAccess(options.pool, context.userId);
  if (!access || access.status !== "ACTIVE" || access.passwordChangeRequired || !access.isBoss) {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss required");
  }
  const domain = queryValue(request, "domain")?.trim();
  if (domain && !DOMAIN_PATTERN.test(domain)) invalid("Domain filter is invalid");
  const action = queryValue(request, "action")?.trim();
  if (action && !ACTION_PATTERN.test(action)) invalid("Action filter is invalid");
  const objectType = queryValue(request, "objectType")?.trim();
  if (objectType && !OBJECT_TYPE_PATTERN.test(objectType)) invalid("Object filter is invalid");
  const actorType = queryValue(request, "actorType");
  if (actorType && !["admin", "system", "user", "maintenance"].includes(actorType)) invalid("Actor type filter is invalid");
  const filters = commonFilters(request);

  const values: unknown[] = [filters.limit + 1];
  const conditions: string[] = [];
  if (domain) conditions.push(`split_part(e."action", '.', 1) = $${values.push(domain)}`);
  if (action) conditions.push(`e."action" = $${values.push(action)}`);
  if (objectType) conditions.push(`e."object_type" = ANY($${values.push(OBJECT_TYPE_ALIASES[objectType] ?? [objectType])}::text[])`);
  if (actorType) conditions.push(`e."actor_type" = $${values.push(actorType)}`);
  applyCommon(values, conditions, filters);

  const page = await runQuery(options, values, conditions, filters.limit);
  sendSuccess(response, { ...page, scope: "BOSS_ALL_AUDIT_EVENTS" }, requestId);
}

export const AUDIT_RETENTION_MIN_DAYS = 90;
export const AUDIT_RETENTION_MAX_DAYS = 3650;
export const AUDIT_RETENTION_DEFAULT_DAYS = 180;

/** 二次确认口令：前端须让 Boss 原样输入。 */
export function auditPurgeConfirmText(days: number): string {
  return `删除${days}天前的日志`;
}

function parseRetentionDays(value: unknown): number {
  const days = typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : value;
  if (typeof days !== "number" || !Number.isInteger(days) || days < AUDIT_RETENTION_MIN_DAYS || days > AUDIT_RETENTION_MAX_DAYS) {
    invalid(`Retention days must be between ${AUDIT_RETENTION_MIN_DAYS} and ${AUDIT_RETENTION_MAX_DAYS}`);
  }
  return days;
}

async function requireBoss(request: AuthSecurityNodeRequest, options: AuthSecurityOptions, readContext: ContextReader): Promise<AdminContext> {
  const context = await readContext(request, options);
  const access = await loadEffectiveAdminAccess(options.pool, context.userId);
  if (!access || access.status !== "ACTIVE" || access.passwordChangeRequired || !access.isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss required");
  return context;
}

async function callPurge(options: AuthSecurityOptions, days: number, context: AdminContext, requestId: string, dryRun: boolean, client: Pick<Pool, "query"> = options.pool) {
  try {
    const result = await client.query<{ deleted: string | number; cutoff: Date | string }>(
      `SELECT "deleted", "cutoff" FROM "zzsh_iam"."purge_admin_audit_events"($1::integer, $2, $3, $4, $5::boolean)`,
      [days, context.userId, context.sessionId, requestId, dryRun],
    );
    const row = result.rows[0];
    return { count: Number(row?.deleted ?? 0), cutoff: iso(row?.cutoff) };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "22023") invalid("Retention days out of range");
    if (code === "42501") throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss required");
    if (code === "42883") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Audit retention is not enabled yet");
    throw error;
  }
}

/** Boss 预览：N 天前可清理（admin.* / auth.*）的条数。 */
async function purgePreview(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await requireBoss(request, options, readContext);
  const days = parseRetentionDays(queryValue(request, "retentionDays") ?? String(AUDIT_RETENTION_DEFAULT_DAYS));
  const preview = await callPurge(options, days, context, requestId, true);
  sendSuccess(response, {
    retentionDays: days, cutoff: preview.cutoff, purgeableCount: preview.count,
    minDays: AUDIT_RETENTION_MIN_DAYS, maxDays: AUDIT_RETENTION_MAX_DAYS, defaultDays: AUDIT_RETENTION_DEFAULT_DAYS,
    confirmText: auditPurgeConfirmText(days), scope: ["admin", "auth"],
  }, requestId);
}

/** Boss 执行清理（复核已由 auth-security 前置完成）；清理本身写入永久审计。 */
async function purgeExecute(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await requireBoss(request, options, readContext);
  const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : invalid("Body is invalid");
  if (Object.keys(body).some((key) => key !== "retentionDays" && key !== "confirmText")) invalid("Body is invalid");
  const days = parseRetentionDays(body.retentionDays);
  if (body.confirmText !== auditPurgeConfirmText(days)) invalid("Confirmation text does not match");
  const result = await withTransaction(options.pool, async client => {
    const access = await lockActor(client, context.userId);
    if (!access.isBoss || access.status !== "ACTIVE" || access.passwordChangeRequired) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss required");
    return callPurge(options, days, context, requestId, false, client);
  });
  sendSuccess(response, { retentionDays: days, cutoff: result.cutoff, deletedCount: result.count }, requestId);
}

export async function handleAdminAuditRoute(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  readContext: ContextReader,
): Promise<void> {
  const path = routePath(request);
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET" && path === "/api/v1/admin/security/audit/events") {
    await auditEvents(request, response, requestId, options, readContext);
    return;
  }
  if (method === "GET" && path === "/api/v1/admin/security/audit/operations") {
    await operationLog(request, response, requestId, options, readContext);
    return;
  }
  if (method === "GET" && path === "/api/v1/admin/security/audit/purge/preview") {
    await purgePreview(request, response, requestId, options, readContext);
    return;
  }
  if (method === "POST" && path === "/api/v1/admin/security/audit/purge") {
    await purgeExecute(request, response, requestId, options, readContext);
    return;
  }
  throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found");
}
