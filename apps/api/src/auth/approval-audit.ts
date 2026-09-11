import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import {
  ADMIN_PERMISSION,
  hasPermission,
  loadEffectiveAdminAccess,
  requirePermission,
  type EffectiveAdminAccess,
} from "./admin-authorization";
import { lockActor } from "./admin-directory";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "./security-core";
import type { AdminContext, AuthSecurityNodeRequest, AuthSecurityNodeResponse, AuthSecurityOptions } from "./auth-security";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED" | "EXECUTED" | "EXECUTION_FAILED";

const OPERATION_PATTERN = /^[a-z][a-z0-9._:-]{1,127}$/;
const TRIGGER_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;
const TEST_OPERATION = "approval.test.execute";
const TEST_OUTCOMES = new Set(["SUCCESS", "FAILURE"]);
const SENSITIVE_DETAIL_KEY = /(password|token|secret|pin|otp|credential|raw.?payload|operation.?payload)/i;

type ContextReader = (request: AuthSecurityNodeRequest, options: AuthSecurityOptions) => Promise<AdminContext>;

type Person = {
  id: string;
  username: string;
  displayUsername: string;
  name: string;
  status: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";
  isBoss: boolean;
  twoFactorEnabled: boolean;
};

type TemplateRow = {
  id: string;
  operationCode: string;
  triggerCondition: string;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type RequestRow = {
  id: string;
  templateId: string;
  templateVersion: number;
  operationCode: string;
  triggerCondition: string;
  payloadVersion: number;
  operationPayload: Record<string, unknown>;
  operationPayloadHash: string;
  summary: string;
  requestedBy: string;
  status: ApprovalStatus;
  statusReason: string | null;
  expiresAt: Date | string;
  createdAt: Date | string;
  decidedAt: Date | string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  supersedesRequestId: string | null;
  supersededByRequestId: string | null;
};

function invalid(message = "Request body is invalid"): never {
  throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, message);
}

function conflict(message: string): never {
  throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, message);
}

function routePath(request: AuthSecurityNodeRequest): string {
  const source = request.originalUrl ?? request.url ?? "/";
  return source.split("?", 1)[0] || "/";
}

function queryValue(request: AuthSecurityNodeRequest, name: string): string | undefined {
  const source = request.originalUrl ?? request.url ?? "";
  const query = source.includes("?") ? source.slice(source.indexOf("?") + 1) : "";
  return new URLSearchParams(query).get(name) ?? undefined;
}

function bodyOf(request: AuthSecurityNodeRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) invalid();
  return request.body as Record<string, unknown>;
}

function assertFields(body: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  if (Object.keys(body).some((key) => !allowed.has(key))) invalid();
}

function requiredString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) invalid();
  return value;
}

function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  if (body[field] === undefined) return undefined;
  return requiredString(body, field, maxLength);
}

function username(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) invalid("Administrator login is invalid");
  return normalized;
}

function usernameList(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) invalid();
  const result = value.map((item) => {
    if (typeof item !== "string") invalid();
    return username(item);
  });
  if (new Set(result).size !== result.length) invalid("Candidate list must not contain duplicates");
  return result;
}

function operationCode(value: string): string {
  const normalized = value.trim();
  if (!OPERATION_PATTERN.test(normalized)) invalid("Operation code is invalid");
  return normalized;
}

function triggerCondition(value: string): string {
  const normalized = value.trim();
  if (!TRIGGER_PATTERN.test(normalized)) invalid("Trigger condition is invalid");
  return normalized;
}

function payloadVersion(body: Record<string, unknown>): number {
  const value = body.payloadVersion;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) invalid();
  return value;
}

function normalizeJson(value: unknown, depth = 0): JsonValue {
  if (depth > 8) invalid("Operation payload is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 2000) invalid("Operation payload is too large");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Operation payload contains an invalid number");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) invalid("Operation payload array is too large");
    return value.map((item) => normalizeJson(item, depth + 1));
  }
  if (typeof value !== "object") invalid("Operation payload is invalid");
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 64) invalid("Operation payload object is too large");
  const result: { [key: string]: JsonValue } = {};
  for (const [key, child] of entries) {
    if (!key || key.length > 80 || ["__proto__", "constructor", "prototype"].includes(key)) invalid("Operation payload key is invalid");
    result[key] = normalizeJson(child, depth + 1);
  }
  return result;
}

function immutablePayload(body: Record<string, unknown>): { value: Record<string, unknown>; raw: string; hash: string } {
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) invalid("Operation payload must be an object");
  const value = normalizeJson(body.payload) as Record<string, JsonValue>;
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) invalid("Operation payload is too large");
  return { value, raw, hash: createHash("sha256").update(raw, "utf8").digest("hex") };
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function send(response: AuthSecurityNodeResponse, status: number, body: unknown, requestId: string): void {
  if (response.headersSent) return;
  response.status(status).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store").json(body);
}

function sendSuccess(response: AuthSecurityNodeResponse, body: unknown, requestId: string): void {
  send(response, 200, body, requestId);
}

async function requireCurrentAccess(pool: Pool, context: AdminContext, permission: string): Promise<EffectiveAdminAccess> {
  const access = await loadEffectiveAdminAccess(pool, context.userId);
  requirePermission(access, permission);
  return access!;
}

async function adminByUserId(client: Pool | PoolClient, userId: string): Promise<Person> {
  const result = await client.query<{
    id: string;
    username: string | null;
    displayUsername: string | null;
    name: string;
    status: Person["status"];
    isBoss: boolean;
    twoFactorEnabled: boolean;
  }>(
    `SELECT u."id", u."username", u."displayUsername", u."name", s."status", s."is_boss" AS "isBoss", u."twoFactorEnabled"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE u."id" = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
  const login = row.username ?? row.displayUsername?.toLowerCase() ?? "unknown";
  return {
    id: row.id,
    username: login,
    displayUsername: row.displayUsername ?? login.toUpperCase(),
    name: row.name,
    status: row.status,
    isBoss: row.isBoss,
    twoFactorEnabled: row.twoFactorEnabled === true,
  };
}

async function adminsByUsernames(client: PoolClient, usernames: string[]): Promise<Person[]> {
  const result = await client.query<{
    id: string;
    username: string | null;
    displayUsername: string | null;
    name: string;
    status: Person["status"];
    isBoss: boolean;
    twoFactorEnabled: boolean;
  }>(
    `SELECT u."id", u."username", u."displayUsername", u."name", s."status", s."is_boss" AS "isBoss", u."twoFactorEnabled"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE lower(u."username") = ANY($1::text[])
      FOR UPDATE OF u, s`,
    [usernames],
  );
  const byUsername = new Map(result.rows.map((row) => [row.username?.toLowerCase() ?? "", row]));
  if (byUsername.size !== usernames.length || usernames.some((item) => !byUsername.has(item))) {
    throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Candidate administrator not found");
  }
  return usernames.map((item) => {
    const row = byUsername.get(item)!;
    return {
      id: row.id,
      username: row.username ?? item,
      displayUsername: row.displayUsername ?? item.toUpperCase(),
      name: row.name,
      status: row.status,
      isBoss: row.isBoss,
      twoFactorEnabled: row.twoFactorEnabled === true,
    };
  });
}

async function candidateView(client: Pool | PoolClient, candidate: Person, source?: string, addedBy?: string | null): Promise<Record<string, unknown>> {
  const access = await loadEffectiveAdminAccess(client, candidate.id);
  return {
    username: candidate.username,
    displayUsername: candidate.displayUsername,
    name: candidate.name,
    status: candidate.status,
    isBoss: candidate.isBoss,
    eligible: candidate.status === "ACTIVE" && candidate.twoFactorEnabled && hasPermission(access, ADMIN_PERMISSION.approvalRequestApprove),
    ...(source ? { source } : {}),
    ...(addedBy ? { addedBy: (await adminByUserId(client, addedBy)).displayUsername } : {}),
  };
}

async function templateRows(pool: Pool): Promise<TemplateRow[]> {
  const result = await pool.query<TemplateRow>(
    `SELECT "id", "operation_code" AS "operationCode", "trigger_condition" AS "triggerCondition", "version", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "zzsh_iam"."approval_template"
      ORDER BY "operation_code", "trigger_condition"`,
  );
  return result.rows;
}

async function templateResponse(pool: Pool, row: TemplateRow): Promise<Record<string, unknown>> {
  const candidates = await pool.query<{ id: string; username: string | null; displayUsername: string | null; name: string; status: Person["status"]; isBoss: boolean; twoFactorEnabled: boolean }>(
    `SELECT u."id", u."username", u."displayUsername", u."name", s."status", s."is_boss" AS "isBoss", u."twoFactorEnabled"
       FROM "zzsh_iam"."approval_template_candidate" c
       JOIN "zzsh_auth_admin"."user" u ON u."id" = c."admin_user_id"
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE c."template_id" = $1
      ORDER BY lower(u."username")`,
    [row.id],
  );
  return {
    id: row.id,
    operationCode: row.operationCode,
    triggerCondition: row.triggerCondition,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    candidates: await Promise.all(candidates.rows.map(async (candidate) => candidateView(pool, {
      id: candidate.id,
      username: candidate.username ?? "unknown",
      displayUsername: candidate.displayUsername ?? candidate.username?.toUpperCase() ?? "UNKNOWN",
      name: candidate.name,
      status: candidate.status,
      isBoss: candidate.isBoss,
      twoFactorEnabled: candidate.twoFactorEnabled === true,
    }))),
  };
}

async function listTemplates(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  await requireCurrentAccess(options.pool, context, ADMIN_PERMISSION.approvalTemplateRead);
  sendSuccess(response, { templates: await Promise.all((await templateRows(options.pool)).map((row) => templateResponse(options.pool, row))) }, requestId);
}

async function configureTemplate(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["operationCode", "triggerCondition", "candidateUsernames"]);
  const op = operationCode(requiredString(body, "operationCode", 128));
  const trigger = triggerCondition(requiredString(body, "triggerCondition", 64));
  const candidateUsernames = usernameList(body, "candidateUsernames");
  const result = await withTransaction(options.pool, async (client) => {
    const access = await lockActor(client, context.userId);
    requirePermission(access, ADMIN_PERMISSION.approvalTemplateConfigure);
    const candidates = await adminsByUsernames(client, candidateUsernames);
    const current = await client.query<{ id: string; version: number }>(
      `SELECT "id", "version" FROM "zzsh_iam"."approval_template" WHERE "operation_code" = $1 AND "trigger_condition" = $2 FOR UPDATE`,
      [op, trigger],
    );
    const existing = current.rows[0];
    const templateId = existing?.id ?? `approval_tpl_${randomUUID().replaceAll("-", "")}`;
    const version = existing ? existing.version + 1 : 1;
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    if (existing) {
      await client.query(
        `UPDATE "zzsh_iam"."approval_template" SET "version" = $1, "updated_at" = clock_timestamp() WHERE "id" = $2`,
        [version, templateId],
      );
      await client.query(`DELETE FROM "zzsh_iam"."approval_template_candidate" WHERE "template_id" = $1`, [templateId]);
    } else {
      await client.query(
        `INSERT INTO "zzsh_iam"."approval_template" ("id", "operation_code", "trigger_condition", "version") VALUES ($1, $2, $3, $4)`,
        [templateId, op, trigger, version],
      );
    }
    for (const candidate of candidates) {
      await client.query(
        `INSERT INTO "zzsh_iam"."approval_template_candidate" ("template_id", "admin_user_id") VALUES ($1, $2)`,
        [templateId, candidate.id],
      );
    }
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "approval.template.configured",
      objectType: "approval_template",
      objectId: templateId,
      outcome: "SUCCESS",
      requestId,
      details: { operationCode: op, triggerCondition: trigger, version, candidateCount: candidates.length },
    });
    return { templateId, version };
  });
  sendSuccess(response, { ...result, status: "CONFIGURED" }, requestId);
}

async function readRequestForUpdate(client: PoolClient, requestId: string): Promise<RequestRow> {
  const result = await client.query<RequestRow>(
    `SELECT "id", "template_id" AS "templateId", "template_version" AS "templateVersion", "operation_code" AS "operationCode", "trigger_condition" AS "triggerCondition", "payload_version" AS "payloadVersion", "operation_payload" AS "operationPayload", "operation_payload_hash" AS "operationPayloadHash", "summary", "requested_by" AS "requestedBy", "status", "status_reason" AS "statusReason", "expires_at" AS "expiresAt", "created_at" AS "createdAt", "decided_at" AS "decidedAt", "decided_by" AS "decidedBy", "decision_reason" AS "decisionReason", "supersedes_request_id" AS "supersedesRequestId", "superseded_by_request_id" AS "supersededByRequestId"
       FROM "zzsh_iam"."approval_request" WHERE "id" = $1 FOR UPDATE`,
    [requestId],
  );
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval request not found");
  return row;
}

function requireRequestManager(access: EffectiveAdminAccess, row: RequestRow, userId: string): void {
  if (access.isBoss || row.requestedBy === userId) return;
  throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Only the requester or a Boss can manage this approval request");
}

async function requireRequestCandidate(client: PoolClient, row: RequestRow, userId: string): Promise<void> {
  const candidate = await client.query(
    `SELECT 1 FROM "zzsh_iam"."approval_request_candidate" WHERE "request_id" = $1 AND "admin_user_id" = $2`,
    [row.id, userId],
  );
  if (candidate.rows.length !== 1) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "The current administrator is not an eligible candidate");
}

async function requestCandidateRows(client: Pool | PoolClient, requestId: string): Promise<Array<{ candidate: Person; source: string; templateVersion: number; addedBy: string | null }>> {
  const result = await client.query<{ id: string; username: string | null; displayUsername: string | null; name: string; status: Person["status"]; isBoss: boolean; twoFactorEnabled: boolean; source: string; templateVersion: number; addedBy: string | null }>(
    `SELECT u."id", u."username", u."displayUsername", u."name", s."status", s."is_boss" AS "isBoss", u."twoFactorEnabled", c."source", c."template_version" AS "templateVersion", c."added_by" AS "addedBy"
       FROM "zzsh_iam"."approval_request_candidate" c
       JOIN "zzsh_auth_admin"."user" u ON u."id" = c."admin_user_id"
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE c."request_id" = $1
      ORDER BY c."source", lower(u."username")`,
    [requestId],
  );
  return result.rows.map((row) => ({
    candidate: {
      id: row.id,
      username: row.username ?? "unknown",
      displayUsername: row.displayUsername ?? row.username?.toUpperCase() ?? "UNKNOWN",
      name: row.name,
      status: row.status,
      isBoss: row.isBoss,
      twoFactorEnabled: row.twoFactorEnabled === true,
    },
    source: row.source,
    templateVersion: row.templateVersion,
    addedBy: row.addedBy,
  }));
}

function requestFingerprint(row: Pick<RequestRow, "operationCode" | "triggerCondition" | "payloadVersion" | "operationPayloadHash" | "summary">): string {
  return [row.operationCode, row.triggerCondition, row.payloadVersion, row.operationPayloadHash, row.summary].join("\u0000");
}

async function createRequest(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["operationCode", "triggerCondition", "payloadVersion", "payload", "summary", "supersedesRequestId"]);
  const op = operationCode(requiredString(body, "operationCode", 128));
  const trigger = triggerCondition(requiredString(body, "triggerCondition", 64));
  const version = payloadVersion(body);
  const payload = immutablePayload(body);
  const summary = requiredString(body, "summary", 240).trim();
  if (summary.length < 3) invalid("Summary is required");
  const supersedes = optionalString(body, "supersedesRequestId", 128);
  const result = await withTransaction(options.pool, async (client) => {
    const access = await lockActor(client, context.userId);
    requirePermission(access, ADMIN_PERMISSION.approvalRequestCreate);
    const templateResult = await client.query<TemplateRow>(
      `SELECT "id", "operation_code" AS "operationCode", "trigger_condition" AS "triggerCondition", "version", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
         FROM "zzsh_iam"."approval_template" WHERE "operation_code" = $1 AND "trigger_condition" = $2 FOR UPDATE`,
      [op, trigger],
    );
    const template = templateResult.rows[0];
    if (!template) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval template not found");
    const candidates = await client.query<{ adminUserId: string }>(
      `SELECT "admin_user_id" AS "adminUserId" FROM "zzsh_iam"."approval_template_candidate" WHERE "template_id" = $1 ORDER BY "admin_user_id"`,
      [template.id],
    );
    if (candidates.rows.length < 1) conflict("Approval template has no candidate");
    const newRequestId = `approval_req_${randomUUID().replaceAll("-", "")}`;
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    let previous: RequestRow | undefined;
    if (supersedes) {
      previous = await readRequestForUpdate(client, supersedes);
      if (previous.requestedBy !== context.userId) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Only the requester can replace its pending request");
      if (previous.status !== "PENDING") conflict("Only a pending request can be replaced; submit a new request after rejection");
      const nextFingerprint = requestFingerprint({ operationCode: op, triggerCondition: trigger, payloadVersion: version, operationPayloadHash: payload.hash, summary });
      if (requestFingerprint(previous) === nextFingerprint) conflict("Replacement must change the operation request");
    }
    const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);
    await client.query(
      `INSERT INTO "zzsh_iam"."approval_request" ("id", "template_id", "template_version", "operation_code", "trigger_condition", "payload_version", "operation_payload", "operation_payload_hash", "summary", "requested_by", "status", "expires_at", "supersedes_request_id")
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'PENDING', $11, $12)`,
      [newRequestId, template.id, template.version, op, trigger, version, payload.raw, payload.hash, summary, context.userId, expiresAt, supersedes ?? null],
    );
    for (const candidate of candidates.rows) {
      await client.query(
        `INSERT INTO "zzsh_iam"."approval_request_candidate" ("request_id", "admin_user_id", "source", "template_version") VALUES ($1, $2, 'TEMPLATE', $3)`,
        [newRequestId, candidate.adminUserId, template.version],
      );
    }
    if (previous) {
      await client.query(
        `UPDATE "zzsh_iam"."approval_request" SET "status" = 'CANCELLED', "status_reason" = '已由新申请替代', "superseded_by_request_id" = $1 WHERE "id" = $2 AND "status" = 'PENDING'`,
        [newRequestId, previous.id],
      );
      await recordAudit(client, {
        actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
        action: "approval.request.cancelled", objectType: "approval_request", objectId: previous.id,
        outcome: "SUCCESS", requestId, reason: "已由新申请替代", details: { supersededByRequestId: newRequestId },
      });
    }
    await recordAudit(client, {
      actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
      action: "approval.request.created", objectType: "approval_request", objectId: newRequestId,
      outcome: "SUCCESS", requestId,
      details: { operationCode: op, triggerCondition: trigger, payloadVersion: version, operationPayloadHash: payload.hash, templateVersion: template.version, candidateCount: candidates.rows.length, summary },
    });
    return { requestId: newRequestId, templateVersion: template.version, expiresAt: expiresAt.toISOString() };
  });
  sendSuccess(response, { ...result, status: "PENDING" }, requestId);
}

async function expireRequest(client: PoolClient, row: RequestRow, context: AdminContext, requestId: string): Promise<void> {
  await client.query(
    `UPDATE "zzsh_iam"."approval_request" SET "status" = 'EXPIRED', "status_reason" = '审批有效期已过' WHERE "id" = $1 AND "status" IN ('PENDING', 'APPROVED')`,
    [row.id],
  );
  await recordAudit(client, {
    actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
    action: "approval.request.expired", objectType: "approval_request", objectId: row.id,
    outcome: "FAILURE", requestId, reason: "审批有效期已过",
    details: { previousStatus: row.status },
  });
}

async function decideRequest(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["requestId", "decision", "reason"]);
  const targetRequestId = requiredString(body, "requestId", 128);
  const decision = requiredString(body, "decision", 16);
  if (decision !== "APPROVE" && decision !== "REJECT") invalid("Decision is invalid");
  const reason = optionalString(body, "reason", 500)?.trim();
  if (decision === "REJECT" && (!reason || reason.length < 3)) invalid("A rejection reason is required");
  const result = await withTransaction(options.pool, async (client) => {
    const access = await lockActor(client, context.userId);
    requirePermission(access, ADMIN_PERMISSION.approvalRequestApprove);
    const row = await readRequestForUpdate(client, targetRequestId);
    if (row.requestedBy === context.userId) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "The requester cannot approve its own request");
    await requireRequestCandidate(client, row, context.userId);
    if (row.status !== "PENDING") conflict("This approval request is already closed");
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      await expireRequest(client, row, context, requestId);
      return { expired: true } as const;
    }
    const finalStatus: ApprovalStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await client.query(
      `INSERT INTO "zzsh_iam"."approval_decision" ("id", "request_id", "approver_admin_id", "decision", "reason") VALUES ($1, $2, $3, $4, $5)`,
      [`approval_dec_${randomUUID().replaceAll("-", "")}`, row.id, context.userId, finalStatus, reason ?? null],
    );
    await client.query(
      `UPDATE "zzsh_iam"."approval_request" SET "status" = $1, "decided_at" = clock_timestamp(), "decided_by" = $2, "decision_reason" = $3, "status_reason" = $4 WHERE "id" = $5 AND "status" = 'PENDING'`,
      [finalStatus, context.userId, reason ?? null, finalStatus === "REJECTED" ? "审批已拒绝" : "审批已通过，等待执行", row.id],
    );
    await recordAudit(client, {
      actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
      action: decision === "APPROVE" ? "approval.request.approved" : "approval.request.rejected",
      objectType: "approval_request", objectId: row.id, outcome: "SUCCESS", requestId, reason,
      details: { decision: finalStatus, summary: row.summary, operationCode: row.operationCode },
    });
    return { status: finalStatus, requestId: row.id } as const;
  });
  if ("expired" in result && result.expired) conflict("Approval request expired before the decision");
  sendSuccess(response, result, requestId);
}

async function appendCandidate(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["requestId", "username", "reason"]);
  const targetRequestId = requiredString(body, "requestId", 128);
  const targetUsername = username(requiredString(body, "username", 64));
  const reason = requiredString(body, "reason", 500).trim();
  if (reason.length < 3) invalid("A reason is required");
  const result = await withTransaction(options.pool, async (client) => {
    const access = await lockActor(client, context.userId);
    requirePermission(access, ADMIN_PERMISSION.approvalRequestAddApprover);
    const row = await readRequestForUpdate(client, targetRequestId);
    requireRequestManager(access, row, context.userId);
    if (row.status !== "PENDING") conflict("Only a pending request can receive an additional candidate");
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      await expireRequest(client, row, context, requestId);
      return { expired: true } as const;
    }
    const target = (await adminsByUsernames(client, [targetUsername]))[0]!;
    if (target.id === row.requestedBy) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "The requester cannot be added as an approver");
    const targetAccess = await loadEffectiveAdminAccess(client, target.id);
    if (target.status !== "ACTIVE" || !target.twoFactorEnabled || !hasPermission(targetAccess, ADMIN_PERMISSION.approvalRequestApprove)) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "The additional candidate is not currently eligible");
    }
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const inserted = await client.query(
      `INSERT INTO "zzsh_iam"."approval_request_candidate" ("request_id", "admin_user_id", "source", "template_version", "added_by") VALUES ($1, $2, 'APPENDED', $3, $4) ON CONFLICT ("request_id", "admin_user_id") DO NOTHING`,
      [row.id, target.id, row.templateVersion, context.userId],
    );
    if (inserted.rowCount !== 1) conflict("This administrator is already a candidate");
    await recordAudit(client, {
      actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
      action: "approval.request.candidate_added", objectType: "approval_request", objectId: row.id,
      outcome: "SUCCESS", requestId, reason,
      details: { candidateUsername: target.username, source: "APPENDED" },
    });
    return { status: "CANDIDATE_ADDED" } as const;
  });
  if ("expired" in result && result.expired) conflict("Approval request expired before the candidate was added");
  sendSuccess(response, { status: result.status, requestId: targetRequestId }, requestId);
}

async function executeRequest(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["requestId"]);
  const targetRequestId = requiredString(body, "requestId", 128);
  const result = await withTransaction(options.pool, async (client) => {
    const access = await lockActor(client, context.userId);
    requirePermission(access, ADMIN_PERMISSION.approvalRequestExecute);
    if (!options.testOperationsEnabled) {
      throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Test operation is disabled in this environment");
    }
    const row = await readRequestForUpdate(client, targetRequestId);
    const linked = access.isBoss || row.requestedBy === context.userId || (await client.query(`SELECT 1 FROM "zzsh_iam"."approval_request_candidate" WHERE "request_id" = $1 AND "admin_user_id" = $2`, [row.id, context.userId])).rows.length === 1;
    if (!linked) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "The current administrator is outside this request scope");
    if (new Date(row.expiresAt).getTime() <= Date.now() && ["PENDING", "APPROVED"].includes(row.status)) {
      await expireRequest(client, row, context, requestId);
      return { expired: true } as const;
    }
    if (row.status !== "APPROVED") conflict("Only an approved request can be executed");
    if (row.operationCode !== TEST_OPERATION) conflict("This package has no executor for the configured operation");
    const outcome = row.operationPayload.outcome;
    if (typeof outcome !== "string" || !TEST_OUTCOMES.has(outcome)) conflict("The test operation payload is invalid");
    const executionStatus = outcome === "SUCCESS" ? "SUCCEEDED" : "FAILED";
    const resultCode = outcome === "SUCCESS" ? "TEST_ACTION_EXECUTED" : "TEST_ACTION_FAILED";
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await client.query(
      `INSERT INTO "zzsh_iam"."approval_execution" ("id", "request_id", "operation_code", "status", "result_code", "result_detail", "executed_by") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [`approval_exec_${randomUUID().replaceAll("-", "")}`, row.id, row.operationCode, executionStatus, resultCode, outcome === "SUCCESS" ? "本地非资金测试动作已执行一次" : "本地非资金测试动作按载荷返回失败", context.userId],
    );
    await client.query(
      `UPDATE "zzsh_iam"."approval_request" SET "status" = $1, "status_reason" = $2 WHERE "id" = $3 AND "status" = 'APPROVED'`,
      [outcome === "SUCCESS" ? "EXECUTED" : "EXECUTION_FAILED", executionStatus === "SUCCEEDED" ? "执行成功" : "执行失败，结果已记录", row.id],
    );
    await recordAudit(client, {
      actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
      action: "approval.execution.completed", objectType: "approval_request", objectId: row.id,
      outcome: executionStatus === "SUCCEEDED" ? "SUCCESS" : "FAILURE", requestId,
      details: { operationCode: row.operationCode, executionStatus, resultCode, summary: row.summary },
    });
    return { status: outcome === "SUCCESS" ? "EXECUTED" : "EXECUTION_FAILED", executionStatus, resultCode, requestId: row.id } as const;
  });
  if ("expired" in result && result.expired) conflict("Approved request expired before execution");
  sendSuccess(response, result, requestId);
}

async function listRequests(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader, pending: boolean): Promise<void> {
  const context = await readContext(request, options);
  const access = await requireCurrentAccess(options.pool, context, pending ? ADMIN_PERMISSION.approvalRequestApprove : ADMIN_PERMISSION.approvalRequestRead);
  const rawLimit = queryValue(request, "limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) invalid("Limit is invalid");
  const cursor = queryValue(request, "cursor");
  if (cursor && cursor.length > 256) invalid("Cursor is invalid");
  let cursorValues: [Date, string] | undefined;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: string; id?: string };
      if (!decoded.createdAt || !decoded.id) invalid("Cursor is invalid");
      cursorValues = [new Date(decoded.createdAt), decoded.id];
      if (Number.isNaN(cursorValues[0].getTime())) invalid("Cursor is invalid");
    } catch {
      invalid("Cursor is invalid");
    }
  }
  const values: unknown[] = [limit + 1];
  const conditions = pending
    ? [`c."admin_user_id" = $${values.push(context.userId)}`, `r."status" = 'PENDING'`, `r."expires_at" > clock_timestamp()`, `r."requested_by" <> $${values.push(context.userId)}`]
    : [`r."requested_by" = $${values.push(context.userId)}`];
  if (cursorValues) {
    values.push(cursorValues[0], cursorValues[1]);
    const timeParam = values.length - 1;
    const idParam = values.length;
    conditions.push(`(r."created_at" < $${timeParam} OR (r."created_at" = $${timeParam} AND r."id" < $${idParam}))`);
  }
  const result = await options.pool.query<RequestRow & { requesterUsername: string | null; requesterDisplayUsername: string | null; requesterName: string }>(
    `SELECT r."id", r."template_id" AS "templateId", r."template_version" AS "templateVersion", r."operation_code" AS "operationCode", r."trigger_condition" AS "triggerCondition", r."payload_version" AS "payloadVersion", r."operation_payload" AS "operationPayload", r."operation_payload_hash" AS "operationPayloadHash", r."summary", r."requested_by" AS "requestedBy", r."status", r."status_reason" AS "statusReason", r."expires_at" AS "expiresAt", r."created_at" AS "createdAt", r."decided_at" AS "decidedAt", r."decided_by" AS "decidedBy", r."decision_reason" AS "decisionReason", r."supersedes_request_id" AS "supersedesRequestId", r."superseded_by_request_id" AS "supersededByRequestId", u."username" AS "requesterUsername", u."displayUsername" AS "requesterDisplayUsername", u."name" AS "requesterName"
       FROM "zzsh_iam"."approval_request" r
       JOIN "zzsh_auth_admin"."user" u ON u."id" = r."requested_by"
       ${pending ? `JOIN "zzsh_iam"."approval_request_candidate" c ON c."request_id" = r."id"` : ""}
      WHERE ${conditions.join(" AND ")}
      ORDER BY r."created_at" DESC, r."id" DESC
      LIMIT $1`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const next = hasMore ? Buffer.from(JSON.stringify({ createdAt: iso(rows.at(-1)?.createdAt), id: rows.at(-1)?.id })).toString("base64url") : null;
  sendSuccess(response, {
    requests: rows.map((row) => ({
      requestId: row.id,
      operationCode: row.operationCode,
      triggerCondition: row.triggerCondition,
      payloadVersion: row.payloadVersion,
      payloadHash: row.operationPayloadHash,
      summary: row.summary,
      status: new Date(row.expiresAt).getTime() <= Date.now() && ["PENDING", "APPROVED"].includes(row.status) ? "EXPIRED" : row.status,
      statusReason: row.statusReason,
      requester: { username: row.requesterUsername ?? "unknown", displayUsername: row.requesterDisplayUsername ?? row.requesterUsername?.toUpperCase() ?? "UNKNOWN", name: row.requesterName },
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
    })),
    nextCursor: next,
    scope: pending ? "PENDING_FOR_CURRENT_ADMIN" : "REQUESTED_BY_CURRENT_ADMIN",
    ...(access.isBoss ? { includesBossScope: true } : {}),
  }, requestId);
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

type AuditRow = {
  id: string;
  actorId: string | null;
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

function auditView(row: AuditRow): Record<string, unknown> {
  return {
    eventId: row.id,
    actor: { username: row.actorUsername ?? "系统", displayUsername: row.actorDisplayUsername ?? row.actorUsername?.toUpperCase() ?? "系统", name: row.actorName ?? "系统" },
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

async function requestScope(pool: Pool, userId: string, requestId: string, isBoss: boolean): Promise<boolean> {
  if (isBoss) return true;
  const result = await pool.query<{ allowed: boolean }>(
    `SELECT (r."requested_by" = $1 OR EXISTS (SELECT 1 FROM "zzsh_iam"."approval_request_candidate" c WHERE c."request_id" = r."id" AND c."admin_user_id" = $1)) AS allowed
       FROM "zzsh_iam"."approval_request" r WHERE r."id" = $2`,
    [userId, requestId],
  );
  return result.rows[0]?.allowed === true;
}

async function requestDetail(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const access = await requireCurrentAccess(options.pool, context, ADMIN_PERMISSION.approvalRequestRead);
  const targetRequestId = queryValue(request, "requestId");
  if (!targetRequestId || targetRequestId.length > 128) invalid("Request id is required");
  if (!(await requestScope(options.pool, context.userId, targetRequestId, access.isBoss))) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval request not found");
  const result = await options.pool.query<RequestRow>(
    `SELECT "id", "template_id" AS "templateId", "template_version" AS "templateVersion", "operation_code" AS "operationCode", "trigger_condition" AS "triggerCondition", "payload_version" AS "payloadVersion", "operation_payload" AS "operationPayload", "operation_payload_hash" AS "operationPayloadHash", "summary", "requested_by" AS "requestedBy", "status", "status_reason" AS "statusReason", "expires_at" AS "expiresAt", "created_at" AS "createdAt", "decided_at" AS "decidedAt", "decided_by" AS "decidedBy", "decision_reason" AS "decisionReason", "supersedes_request_id" AS "supersedesRequestId", "superseded_by_request_id" AS "supersededByRequestId"
       FROM "zzsh_iam"."approval_request" WHERE "id" = $1`,
    [targetRequestId],
  );
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval request not found");
  const requester = await adminByUserId(options.pool, row.requestedBy);
  const candidates = await requestCandidateRows(options.pool, row.id);
  const decision = await options.pool.query<{ decision: string; reason: string | null; createdAt: Date | string; approverId: string }>(
    `SELECT "decision", "reason", "created_at" AS "createdAt", "approver_admin_id" AS "approverId" FROM "zzsh_iam"."approval_decision" WHERE "request_id" = $1`,
    [row.id],
  );
  const execution = await options.pool.query<{ status: string; resultCode: string; resultDetail: string | null; executedBy: string; createdAt: Date | string; completedAt: Date | string }>(
    `SELECT "status", "result_code" AS "resultCode", "result_detail" AS "resultDetail", "executed_by" AS "executedBy", "created_at" AS "createdAt", "completed_at" AS "completedAt" FROM "zzsh_iam"."approval_execution" WHERE "request_id" = $1`,
    [row.id],
  );
  const history = await options.pool.query<AuditRow>(
    `SELECT e."id", e."actor_id" AS "actorId", u."username" AS "actorUsername", u."displayUsername" AS "actorDisplayUsername", u."name" AS "actorName", e."action", e."object_type" AS "objectType", e."object_id" AS "objectId", e."outcome", e."reason", e."request_id" AS "requestId", e."occurred_at" AS "occurredAt", e."details"
       FROM "zzsh_iam"."audit_event" e
       LEFT JOIN "zzsh_auth_admin"."user" u ON u."id" = e."actor_id"
      WHERE e."action" LIKE 'approval.%' AND e."object_type" = 'approval_request' AND e."object_id" = $1
      ORDER BY e."occurred_at", e."id"`,
    [row.id],
  );
  const status: ApprovalStatus = new Date(row.expiresAt).getTime() <= Date.now() && ["PENDING", "APPROVED"].includes(row.status) ? "EXPIRED" : row.status;
  sendSuccess(response, {
    requestId: row.id,
    status,
    statusReason: status === "EXPIRED" ? "审批有效期已过" : row.statusReason,
    operation: { code: row.operationCode, triggerCondition: row.triggerCondition, payloadVersion: row.payloadVersion, payloadHash: row.operationPayloadHash, payload: row.operationCode === TEST_OPERATION ? sanitizeDetail(row.operationPayload) : undefined },
    summary: row.summary,
    template: { id: row.templateId, version: row.templateVersion },
    requester: { username: requester.username, displayUsername: requester.displayUsername, name: requester.name, status: requester.status },
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    decision: decision.rows[0] ? { decision: decision.rows[0].decision, reason: decision.rows[0].reason, approver: await adminByUserId(options.pool, decision.rows[0].approverId), createdAt: iso(decision.rows[0].createdAt) } : null,
    execution: execution.rows[0] ? { status: execution.rows[0].status, resultCode: execution.rows[0].resultCode, resultDetail: execution.rows[0].resultDetail, executor: await adminByUserId(options.pool, execution.rows[0].executedBy), createdAt: iso(execution.rows[0].createdAt), completedAt: iso(execution.rows[0].completedAt) } : null,
    candidates: await Promise.all(candidates.map((item) => candidateView(options.pool, item.candidate, item.source, item.addedBy))),
    history: history.rows.map(auditView),
    supersedesRequestId: row.supersedesRequestId,
    supersededByRequestId: row.supersededByRequestId,
  }, requestId);
}

async function auditEvents(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const access = await requireCurrentAccess(options.pool, context, ADMIN_PERMISSION.approvalAuditRead);
  const rawLimit = queryValue(request, "limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) invalid("Limit is invalid");
  const cursor = queryValue(request, "cursor");
  let cursorValues: [Date, string] | undefined;
  if (cursor) {
    if (cursor.length > 256) invalid("Cursor is invalid");
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { occurredAt?: string; id?: string };
      if (!decoded.occurredAt || !decoded.id) invalid("Cursor is invalid");
      cursorValues = [new Date(decoded.occurredAt), decoded.id];
      if (Number.isNaN(cursorValues[0].getTime())) invalid("Cursor is invalid");
    } catch {
      invalid("Cursor is invalid");
    }
  }
  const action = queryValue(request, "action");
  const targetRequestId = queryValue(request, "requestId");
  const actorUsername = queryValue(request, "actorUsername")?.trim().toLowerCase();
  const objectType = queryValue(request, "objectType");
  if (action && (!action.startsWith("approval.") || action.length > 128)) invalid("Action filter is invalid");
  if (targetRequestId && targetRequestId.length > 128) invalid("Request id is invalid");
  if (actorUsername && !USERNAME_PATTERN.test(actorUsername)) invalid("Actor filter is invalid");
  if (objectType && !/^[a-z][a-z0-9_]{0,63}$/.test(objectType)) invalid("Object filter is invalid");
  const values: unknown[] = access.isBoss ? [limit + 1] : [limit + 1, context.userId];
  const conditions = [
    `e."action" LIKE 'approval.%'`,
    access.isBoss ? "TRUE" : `(e."actor_id" = $2 OR (e."object_type" = 'approval_request' AND (r."requested_by" = $2 OR EXISTS (SELECT 1 FROM "zzsh_iam"."approval_request_candidate" rc WHERE rc."request_id" = r."id" AND rc."admin_user_id" = $2))))`,
  ];
  if (action) conditions.push(`e."action" = $${values.push(action)}`);
  if (targetRequestId) {
    const requestParameter = values.push(targetRequestId);
    conditions.push(`((e."object_type" = 'approval_request' AND e."object_id" = $${requestParameter}) OR (e."request_id" = $${requestParameter}))`);
  }
  if (actorUsername) conditions.push(`lower(COALESCE(u."username", '')) = $${values.push(actorUsername)}`);
  if (objectType) conditions.push(`e."object_type" = $${values.push(objectType)}`);
  if (cursorValues) {
    values.push(cursorValues[0], cursorValues[1]);
    const timeParam = values.length - 1;
    const idParam = values.length;
    conditions.push(`(e."occurred_at" < $${timeParam} OR (e."occurred_at" = $${timeParam} AND e."id" < $${idParam}))`);
  }
  const result = await options.pool.query<AuditRow>(
    `SELECT e."id", e."actor_id" AS "actorId", u."username" AS "actorUsername", u."displayUsername" AS "actorDisplayUsername", u."name" AS "actorName", e."action", e."object_type" AS "objectType", e."object_id" AS "objectId", e."outcome", e."reason", e."request_id" AS "requestId", e."occurred_at" AS "occurredAt", e."details"
       FROM "zzsh_iam"."audit_event" e
       LEFT JOIN "zzsh_auth_admin"."user" u ON u."id" = e."actor_id"
       LEFT JOIN "zzsh_iam"."approval_request" r ON e."object_type" = 'approval_request' AND e."object_id" = r."id"
      WHERE ${conditions.join(" AND ")}
      ORDER BY e."occurred_at" DESC, e."id" DESC
      LIMIT $1`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const next = hasMore ? Buffer.from(JSON.stringify({ occurredAt: iso(rows.at(-1)?.occurredAt), id: rows.at(-1)?.id })).toString("base64url") : null;
  sendSuccess(response, { events: rows.map(auditView), nextCursor: next, scope: access.isBoss ? "BOSS_ALL_APPROVAL_EVENTS" : "ACTOR_OR_REQUEST_SCOPE" }, requestId);
}

export async function handleAdminApprovalRoute(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  readContext: ContextReader,
): Promise<void> {
  const path = routePath(request);
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET") {
    if (path === "/api/v1/admin/security/approvals/templates") return listTemplates(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests/mine") return listRequests(request, response, requestId, options, readContext, false);
    if (path === "/api/v1/admin/security/approvals/requests/pending") return listRequests(request, response, requestId, options, readContext, true);
    if (path === "/api/v1/admin/security/approvals/requests/detail") return requestDetail(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/audit/events") return auditEvents(request, response, requestId, options, readContext);
  }
  if (method === "POST") {
    if (path === "/api/v1/admin/security/approvals/templates/update") return configureTemplate(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests") return createRequest(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests/decision") return decideRequest(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests/add-candidate") return appendCandidate(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests/execute") return executeRequest(request, response, requestId, options, readContext);
  }
  throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found");
}
