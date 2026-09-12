import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError } from "../auth/security-core";
import type { AuthSecurityNodeRequest, AuthSecurityNodeResponse } from "../auth/auth-security";

export type SupplyNodeRequest = AuthSecurityNodeRequest & { ip?: string; socket?: { remoteAddress?: string } };
export type SupplyNodeResponse = AuthSecurityNodeResponse;

export function sendJson(response: SupplyNodeResponse, status: number, body: unknown, requestId: string, cacheControl = "no-store"): void {
  if (response.headersSent) return;
  response.status(status).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", cacheControl).json(body);
}

export function sendError(response: SupplyNodeResponse, error: SecurityApiError, requestId: string): void {
  sendJson(response, error.status, { error: { code: error.code, message: error.message, requestId } }, requestId);
}

export function sendInternalError(response: SupplyNodeResponse, requestId: string): void {
  sendJson(response, 500, { error: { code: API_V1_ERROR_CODES.INTERNAL_ERROR, message: "Internal server error", requestId } }, requestId);
}

export function invalid(message = "Request body is invalid"): SecurityApiError {
  return new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, message);
}

export function notFound(): SecurityApiError {
  return new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found");
}

export function conflict(message = "Request conflicts with current state"): SecurityApiError {
  return new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, message);
}

export function forbidden(message = "Access denied"): SecurityApiError {
  return new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, message);
}

export function newSupplyId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function bodyOf(request: SupplyNodeRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  return body as Record<string, unknown>;
}

export function ensureOnlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(body)) {
    if (!allowedSet.has(key)) throw invalid("Request contains unsupported fields");
  }
}

export function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw invalid();
  return value;
}

export function requiredString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = optionalString(body, field, maxLength);
  if (value === undefined) throw invalid();
  return value;
}

export function optionalTrimmedString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw invalid();
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalid();
  return trimmed;
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid();
  return value;
}

export function optionalInteger(body: Record<string, unknown>, field: string, min: number, max: number): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid();
  return value;
}

export function optionalNullableString(body: Record<string, unknown>, field: string, maxLength: number): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw invalid();
  return value;
}

export async function assertGameScope(client: PoolClient, adminUserId: string, isBoss: boolean, gameId: string): Promise<void> {
  if (isBoss) return;
  const scoped = await client.query(
    `SELECT 1 FROM "zzsh_supply"."admin_supply_scope" WHERE "admin_user_id" = $1 AND "game_id" = $2`,
    [adminUserId, gameId],
  );
  if (scoped.rows.length === 0) throw notFound();
}

export async function assertGameExists(client: PoolClient, gameId: string): Promise<{ id: string; catalogRevision: string }> {
  const result = await client.query<{ id: string; catalogRevision: string }>(
    `SELECT "id", "catalog_revision"::text AS "catalogRevision" FROM "zzsh_supply"."game" WHERE "id" = $1`,
    [gameId],
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  return row;
}

export async function bumpCatalogRevision(client: PoolClient, gameId: string): Promise<void> {
  await client.query(
    `UPDATE "zzsh_supply"."game" SET "catalog_revision" = "catalog_revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [gameId],
  );
}

export function parseExpectedRevision(body: Record<string, unknown>): string {
  const value = body.expectedRevision;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw invalid();
  return value;
}

export function fingerprintRequest(operation: string, resourceId: string | undefined, body: unknown): string {
  return sha256Hex(JSON.stringify([operation, resourceId ?? null, body ?? null]));
}

export type IdempotentResult = { replayed: boolean; status: number; body: unknown };

export async function withIdempotency(
  client: PoolClient,
  scope: { realm: "admin" | "user"; principalId: string; operation: string; resourceId?: string },
  key: string,
  fingerprint: string,
  authorize: () => Promise<void>,
  action: () => Promise<{ status: number; body: unknown }>,
): Promise<IdempotentResult> {
  const scopeKey = JSON.stringify([scope.realm, scope.principalId, scope.operation, scope.resourceId ?? null]);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [JSON.stringify(["supply-idempotency", scopeKey, key])]);
  await authorize();
  const existing = await client.query<{ requestFingerprint: string; responseStatus: number; responseBody: unknown }>(
    `SELECT "request_fingerprint" AS "requestFingerprint", "response_status" AS "responseStatus", "response_body" AS "responseBody"
       FROM "zzsh_supply"."idempotency_record" WHERE "scope_key" = $1 AND "key" = $2 FOR UPDATE`,
    [scopeKey, key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.requestFingerprint !== fingerprint) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, "Idempotency key was reused with a different request");
    }
    return { replayed: true, status: row.responseStatus, body: row.responseBody };
  }
  const result = await action();
  await client.query(
    `INSERT INTO "zzsh_supply"."idempotency_record" ("scope_key", "key", "request_fingerprint", "response_status", "response_body")
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [scopeKey, key, fingerprint, result.status, JSON.stringify(result.body)],
  );
  return { replayed: false, status: result.status, body: result.body };
}
