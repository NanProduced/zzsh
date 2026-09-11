import type { AuthSecurityNodeRequest, AuthSecurityNodeResponse, AuthSecurityOptions } from "./auth-security";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "./admin-authorization";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError } from "./security-core";

type AdminContext = { userId: string; sessionId: string };
type ContextReader = (request: AuthSecurityNodeRequest, options: AuthSecurityOptions) => Promise<AdminContext>;

export const GENERIC_ADMIN_AUDIT_ACTIONS = [
  "admin.account.created",
  "admin.account.updated",
  "admin.permission.assigned",
  "admin.role.created",
  "admin.role.updated",
  "admin.frozen",
  "admin.unfrozen",
  "admin.session.force_logged_out",
  "user.account.restored",
] as const;

const GENERIC_ACTIONS = new Set<string>(GENERIC_ADMIN_AUDIT_ACTIONS);
const GENERIC_OBJECT_TYPES = new Set(["admin_user", "admin_security", "admin_role", "user_account"]);
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,127}$/;
const MAX_PAGE_SIZE = 100;
const SENSITIVE_DETAIL_KEY = /(password|token|secret|pin|otp|credential|authorization|cookie|document|id.?number|phone|raw|payload|provider.?response|chat.?body|request.?body)/i;

type AuditRow = {
  id: string;
  actorUsername: string | null;
  actorDisplayUsername: string | null;
  actorName: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
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

function sanitizeDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDetail);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) continue;
    result[key] = sanitizeDetail(child);
  }
  return result;
}

function auditView(row: AuditRow): Record<string, unknown> {
  return {
    eventId: row.id,
    actor: {
      username: row.actorUsername ?? "系统",
      displayUsername: row.actorDisplayUsername ?? row.actorUsername?.toUpperCase() ?? "系统",
      name: row.actorName ?? "系统",
    },
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
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
  const rawLimit = queryValue(request, "limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) invalid("Limit is invalid");
  const action = queryValue(request, "action");
  if (action && !GENERIC_ACTIONS.has(action)) invalid("Action filter is invalid");
  const objectType = queryValue(request, "objectType");
  if (objectType && !GENERIC_OBJECT_TYPES.has(objectType)) invalid("Object filter is invalid");
  const actorUsername = queryValue(request, "actorUsername")?.trim().toLowerCase();
  if (actorUsername && !USERNAME_PATTERN.test(actorUsername)) invalid("Actor filter is invalid");
  const objectId = queryValue(request, "objectId");
  if (objectId && !ID_PATTERN.test(objectId)) invalid("Object id is invalid");
  const targetRequestId = queryValue(request, "requestId");
  if (targetRequestId && targetRequestId.length > 128) invalid("Request id is invalid");
  const cursor = parseCursor(queryValue(request, "cursor"));

  const values: unknown[] = [limit + 1, [...GENERIC_ACTIONS], [...GENERIC_OBJECT_TYPES]];
  const conditions = [
    `e."actor_type" = 'admin'`,
    `e."action" = ANY($2::text[])`,
    `e."object_type" = ANY($3::text[])`,
  ];
  if (!access.isBoss) {
    const userParameter = values.push(context.userId);
    conditions.push(`(e."object_id" = $${userParameter} OR (e."actor_id" = $${userParameter} AND e."object_type" IN ('admin_role', 'user_account')))`);
  }
  if (action) conditions.push(`e."action" = $${values.push(action)}`);
  if (objectType) conditions.push(`e."object_type" = $${values.push(objectType)}`);
  if (actorUsername) conditions.push(`lower(COALESCE(u."username", '')) = $${values.push(actorUsername)}`);
  if (objectId) conditions.push(`e."object_id" = $${values.push(objectId)}`);
  if (targetRequestId) conditions.push(`e."request_id" = $${values.push(targetRequestId)}`);
  if (cursor) {
    values.push(cursor[0], cursor[1]);
    const timeParameter = values.length - 1;
    const idParameter = values.length;
    conditions.push(`(e."occurred_at" < $${timeParameter} OR (e."occurred_at" = $${timeParameter} AND e."id" < $${idParameter}))`);
  }

  const result = await options.pool.query<AuditRow>(
    `SELECT e."id", u."username" AS "actorUsername", u."displayUsername" AS "actorDisplayUsername", u."name" AS "actorName", e."action", e."object_type" AS "objectType", e."object_id" AS "objectId", e."outcome", e."reason", e."request_id" AS "requestId", e."occurred_at" AS "occurredAt", e."details"
       FROM "zzsh_iam"."audit_event" e
       LEFT JOIN "zzsh_auth_admin"."user" u ON u."id" = e."actor_id"
      WHERE ${conditions.join(" AND ")}
      ORDER BY e."occurred_at" DESC, e."id" DESC
      LIMIT $1`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ occurredAt: iso(rows.at(-1)?.occurredAt), id: rows.at(-1)?.id })).toString("base64url")
    : null;
  sendSuccess(response, {
    events: rows.map(auditView),
    nextCursor,
    scope: access.isBoss ? "BOSS_ALL_GENERIC_ADMIN_AUDIT" : "SELF_TARGET_AND_ROLE_ACTIONS",
    allowedActions: GENERIC_ADMIN_AUDIT_ACTIONS,
  }, requestId);
}

export async function handleAdminAuditRoute(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  readContext: ContextReader,
): Promise<void> {
  if (routePath(request) !== "/api/v1/admin/security/audit/events" || (request.method ?? "GET").toUpperCase() !== "GET") {
    throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found");
  }
  await auditEvents(request, response, requestId, options, readContext);
}
