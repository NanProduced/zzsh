import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";

import { ADMIN_PERMISSION, requirePermission } from "../auth/admin-authorization";
import { assertAdminContextInTransaction, readAdminContext } from "../auth/auth-security";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { assertUserContextInTransaction, readUserContext } from "../auth/user-identity";
import { API_V1_ERROR_CODES, ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { assertDeclaredMediaSize, createMediaUploadIntent, loadMediaAsset, MAX_MEDIA_BYTES, reviewMediaAsset, type MediaStorage } from "../supply/media";
import { decodeId, requireAdminAccess, readRawBody, requireOrigin, runIdempotentWrite, runMediaUpload, sendStoredMedia, type SupplyRuntimeOptions, type WriteActor } from "../supply/supply-routes";
import { bodyOf, conflict, ensureOnlyFields, fingerprintRequest, invalid, notFound, optionalTrimmedString, parseExpectedRevision, requiredString, sendError, sendInternalError, sendJson, type SupplyNodeRequest, type SupplyNodeResponse } from "../supply/supply-util";
import {
  applyAvatarReview,
  avatarImagePath,
  avatarSubjectOfAsset,
  bindPendingAvatar,
  isAvatarAsset,
  isAvatarAssetPubliclyEligible,
  listAvatarReviews,
  loadProfileAvatar,
  ownershipForAvatarRealm,
  profileAvatarWithPending,
  readAvatarOperationReceipt,
  reserveAvatarUpload,
  selectDefaultAvatar,
  type ProfileAvatarDecision,
} from "./profile-avatar";
import {
  deterministicPresetId,
  isProfileAvatarPresetId,
  profileAvatarPreset,
  type ProfileAvatarRealm,
} from "./profile-avatar-presets";

export type ProfileAvatarRuntimeOptions = SupplyRuntimeOptions & { mediaStorage: MediaStorage };

const PUBLIC_AVATAR_CACHE = "public, max-age=0, must-revalidate";
const PRESET_CACHE = "public, max-age=31536000, immutable";
const TOKEN = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const AVATAR_VERSION = /^(?:0|[1-9]\d{0,18})$/;

function pathOf(request: SupplyNodeRequest, prefix: string): { path: string; query: URLSearchParams } {
  const raw = request.originalUrl ?? request.url ?? "/";
  const index = raw.indexOf("?");
  const path = (index >= 0 ? raw.slice(0, index) : raw) === prefix ? "/" : (index >= 0 ? raw.slice(0, index) : raw).slice(prefix.length) || "/";
  return { path, query: new URLSearchParams(index >= 0 ? raw.slice(index + 1) : "") };
}

function requestId(request: SupplyNodeRequest): string {
  return ensureApiV1RequestId(request);
}

function idempotencyKey(request: SupplyNodeRequest): string {
  const value = request.headers["idempotency-key"];
  return validateIdempotencyKey(value);
}

function avatarRevision(body: Record<string, unknown>, allowZero = false): string {
  const value = body.expectedRevision;
  if (typeof value !== "string" || !(allowZero ? /^(?:0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/).test(value)) throw invalid("Avatar revision is invalid", "expectedRevision");
  return value;
}
function subjectContext(actor: WriteActor) {
  if (!actor.sessionId) throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
  return { userId: actor.id, sessionId: actor.sessionId };
}
async function lockAvatarSubject(client: PoolClient, realm: ProfileAvatarRealm, id: string): Promise<void> {
  const table = realm === "user" ? '"zzsh_auth_user"."user"' : '"zzsh_auth_admin"."user"';
  if (!(await client.query(`SELECT "id" FROM ${table} WHERE "id"=$1 FOR UPDATE`, [id])).rows.length) throw notFound();
}
async function lockAvatarReviewSubjects(client: PoolClient, reviewerId: string, subject: { realm: ProfileAvatarRealm; subjectId: string }): Promise<void> {
  // The asset reviewer FK also locks the reviewer; sort both admin subjects before the asset.
  const adminIds = [...new Set(subject.realm === "admin" ? [reviewerId, subject.subjectId] : [reviewerId])].sort();
  const locked = await client.query('SELECT "id" FROM "zzsh_auth_admin"."user" WHERE "id"=ANY($1::text[]) ORDER BY "id" FOR UPDATE', [adminIds]);
  if (locked.rows.length !== adminIds.length) throw notFound();
  if (subject.realm === "user") await lockAvatarSubject(client, "user", subject.subjectId);
}
function reviewInput(body: Record<string, unknown>, withdraw: boolean) {
  ensureOnlyFields(body, withdraw ? ["reason", "expectedRevision"] : ["decision", "reason", "expectedRevision"]);
  const decision = withdraw ? "WITHDRAW" : requiredString(body, "decision", 16);
  if (!withdraw && !["APPROVE", "REJECT", "QUARANTINE"].includes(decision)) throw invalid("Review decision is invalid");
  const reason = optionalTrimmedString(body, "reason", 500) ?? null;
  if (decision !== "APPROVE" && !reason) throw invalid("A reason is required for this review decision");
  return { decision, reason, expectedRevision: avatarRevision(body) };
}

function sendMediaFailure(realm: ProfileAvatarRealm | "preset", subjectId: string, version: string, presetId: string): void {
  // Fixed fields only: no storage credentials, signed URLs or local paths.
  console.error(JSON.stringify({ event: "zzsh_profile_avatar_object_missing", realm, subjectId, version, presetId }));
}

async function readSubjectImage(client: PoolClient, realm: ProfileAvatarRealm, subjectId: string): Promise<string | null> {
  const table = realm === "user" ? `"zzsh_auth_user"."user"` : `"zzsh_auth_admin"."user"`;
  const row = (await client.query<{ image: string | null }>(`SELECT "image" FROM ${table} WHERE "id" = $1`, [subjectId])).rows[0];
  return row?.image ?? null;
}

async function servePreset(
  response: SupplyNodeResponse,
  requestIdValue: string,
  options: ProfileAvatarRuntimeOptions,
  presetId: string,
  version: string,
  cacheControl: string,
): Promise<void> {
  if (!isProfileAvatarPresetId(presetId)) throw notFound();
  const preset = profileAvatarPreset(presetId);
  if (String(preset.version) !== version) throw notFound();
  if (!options.mediaStorage.available) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Media storage is not configured");
  try {
    await sendStoredMedia(response, requestIdValue, options.mediaStorage, { storageKey: preset.contentHash, mime: preset.mime, contentHash: preset.contentHash }, cacheControl);
  } catch (error) {
    sendMediaFailure("preset", preset.presetId, version, preset.presetId);
    throw error;
  }
}

async function serveCurrentAvatar(
  response: SupplyNodeResponse,
  requestIdValue: string,
  options: ProfileAvatarRuntimeOptions,
  realm: ProfileAvatarRealm,
  subjectId: string,
  version: string,
): Promise<void> {
  if (!AVATAR_VERSION.test(version)) throw notFound();
  const current = await withTransaction(options.pool, async (client): Promise<{ presetId: string } | { asset: NonNullable<Awaited<ReturnType<typeof loadMediaAsset>>> }> => {
    const row = await loadProfileAvatar(client, realm, subjectId);
    if (!row) {
      if (version !== "0") throw notFound();
      return { presetId: deterministicPresetId(realm, subjectId) };
    }
    if (row.currentVersion !== version) throw notFound();
    const expected = avatarImagePath(realm, subjectId, row.currentVersion);
    if (await readSubjectImage(client, realm, subjectId) !== expected) throw notFound();
    if (row.currentKind === "DEFAULT") return { presetId: row.currentPresetId ?? row.defaultPresetId };
    const asset = row.currentAssetId ? await loadMediaAsset(client, row.currentAssetId) : null;
    if (!asset || !isAvatarAssetPubliclyEligible(asset) || avatarSubjectOfAsset(asset)?.realm !== realm || avatarSubjectOfAsset(asset)?.subjectId !== subjectId) return { presetId: row.defaultPresetId };
    return { asset };
  });
  if ("presetId" in current) {
    await servePreset(response, requestIdValue, options, current.presetId, "1", PUBLIC_AVATAR_CACHE);
    return;
  }
  const asset = current.asset;
  if (!options.mediaStorage.available) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Media storage is not configured");
  try {
    await sendStoredMedia(response, requestIdValue, options.mediaStorage, { storageKey: asset.publicStorageKey!, mime: asset.mime, contentHash: asset.publicStorageKey! }, PUBLIC_AVATAR_CACHE);
  } catch (error) {
    sendMediaFailure(realm, subjectId, version, asset.purpose);
    throw error;
  }
}

async function requireAvatarUploadIntent(client: PoolClient, actor: { realm: ProfileAvatarRealm; id: string }, intentId: string): Promise<void> {
  const row = (await client.query<{
    purpose: string; ownershipKind: string; gameId: string | null; accountId: string | null; ownerUserId: string | null;
    uploadedByRealm: string; uploadedByUserId: string | null; uploadedByAdminId: string | null;
  }>(
    `SELECT "purpose", "ownership_kind" AS "ownershipKind", "game_id" AS "gameId", "account_id" AS "accountId",
            "owner_user_id" AS "ownerUserId", "uploaded_by_realm" AS "uploadedByRealm",
            "uploaded_by_user_id" AS "uploadedByUserId", "uploaded_by_admin_id" AS "uploadedByAdminId"
       FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1`,
    [intentId],
  )).rows[0];
  if (!row || row.purpose !== "AVATAR" || row.ownershipKind !== ownershipForAvatarRealm(actor.realm)
    || row.uploadedByRealm !== actor.realm || row.gameId !== null || row.accountId !== null
    || (actor.realm === "user" ? row.ownerUserId !== actor.id || row.uploadedByUserId !== actor.id || row.uploadedByAdminId !== null
      : row.uploadedByAdminId !== actor.id || row.ownerUserId !== null || row.uploadedByUserId !== null)) throw notFound();
}

async function createAvatarUploadIntent(
  options: ProfileAvatarRuntimeOptions,
  request: SupplyNodeRequest,
  response: SupplyNodeResponse,
  requestIdValue: string,
  actor: WriteActor,
  realm: ProfileAvatarRealm,
) {
  const body = bodyOf(request);
  ensureOnlyFields(body, ["mime", "size", "expectedRevision"]);
  const expectedRevision = avatarRevision(body, true);
  let freshToken: string | undefined;
  const mime = requiredString(body, "mime", 64);
  const size = assertDeclaredMediaSize(body.size);
  if (!options.mediaStorage.available) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Media storage is not configured");
  const context = realm === "user" ? await readUserContext(request, options) : await readAdminContext(request, options);
  const subjectId = context.userId;
  await runIdempotentWrite(
    options,
    request,
    response,
    requestIdValue,
    { principalId: subjectId, operation: "profile.avatar.upload_intent.create" },
    actor,
    { mime, size, expectedRevision },
    async (client) => {
      if (realm === "user") await assertUserContextInTransaction(client, { userId: context.userId, sessionId: context.sessionId });
      else await assertAdminContextInTransaction(client, { userId: context.userId, sessionId: context.sessionId });
    },
    async (client) => {
      await lockAvatarSubject(client, realm, subjectId);
      const intent = await createMediaUploadIntent(client, realm === "user" ? { realm: "user", userId: subjectId } : { realm: "admin", adminUserId: subjectId }, { purpose: "AVATAR", mime, size });
      await reserveAvatarUpload(client, realm, subjectId, intent.intentId, expectedRevision, { realm, id: subjectId, sessionId: actor.sessionId }, requestIdValue);
      freshToken = intent.uploadToken;
      await recordAudit(client, {
        actorType: realm,
        actorId: subjectId,
        sessionId: actor.sessionId,
        action: "profile.avatar.upload_intent.created",
        objectType: "media_upload_intent",
        objectId: intent.intentId,
        outcome: "SUCCESS",
        requestId: requestIdValue,
        reason: "profile.avatar.upload_intent.create",
        details: { realm, mime, size },
      });
      return { status: 200, body: { intentId: intent.intentId, expiresAt: intent.expiresAt } };
    },
    async (_client, result) => freshToken
      ? { status: result.status, body: { ...(result.body as Record<string, unknown>), uploadToken: freshToken } }
      : { status: 409, body: { error: { code: "CONFLICT", reason: "UPLOAD_TOKEN_NOT_RECOVERABLE", message: "Upload preparation is recorded; explicitly prepare again for a new token", requestId: requestIdValue } } },
  );
}

async function uploadAvatar(
  options: ProfileAvatarRuntimeOptions,
  request: SupplyNodeRequest,
  response: SupplyNodeResponse,
  requestIdValue: string,
  actor: WriteActor,
  realm: ProfileAvatarRealm,
  intentId: string,
) {
  const uploadToken = Array.isArray(request.headers["x-upload-token"]) ? request.headers["x-upload-token"][0] : request.headers["x-upload-token"];
  if (!uploadToken) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Upload token is invalid");
  const bytes = await readRawBody(request, MAX_MEDIA_BYTES);
  const subjectId = actor.id;
  await runMediaUpload(options, request, response, requestIdValue, {
    actor,
    mediaActor: realm === "user" ? { realm: "user", userId: subjectId } : { realm: "admin", adminUserId: subjectId },
    intentId,
    uploadToken,
    bytes,
    authorize: async (client) => {
      if (realm === "user") await assertUserContextInTransaction(client, subjectContext(actor));
      else await assertAdminContextInTransaction(client, { userId: subjectId, sessionId: actor.sessionId });
      await lockAvatarSubject(client, realm, subjectId);
      await requireAvatarUploadIntent(client, { realm, id: subjectId }, intentId);
    },
    afterFinalize: async (client, asset) => {
      await bindPendingAvatar(client, realm, subjectId, asset.assetId, intentId, { realm, id: subjectId, sessionId: actor.sessionId }, requestIdValue);
    },
  });
}

async function selectAvatarDefault(
  options: ProfileAvatarRuntimeOptions,
  request: SupplyNodeRequest,
  response: SupplyNodeResponse,
  requestIdValue: string,
  actor: WriteActor,
  realm: ProfileAvatarRealm,
) {
  const body = bodyOf(request);
  ensureOnlyFields(body, ["presetId", "expectedRevision"]);
  const presetId = requiredString(body, "presetId", 32);
  if (!isProfileAvatarPresetId(presetId)) throw invalid("Avatar preset is invalid", "presetId");
  const expectedRevision = avatarRevision(body, true);
  const normalized = { presetId, expectedRevision };
  const subjectId = actor.id;
  await runIdempotentWrite(
    options,
    request,
    response,
    requestIdValue,
    { principalId: subjectId, operation: "profile.avatar.default.select" },
    actor,
    normalized,
    async (client) => {
      if (realm === "user") await assertUserContextInTransaction(client, subjectContext(actor));
      else await assertAdminContextInTransaction(client, { userId: subjectId, sessionId: actor.sessionId });
    },
    async (client) => {
      if (!options.mediaStorage.available) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Media storage is not configured");
      const preset = profileAvatarPreset(presetId);
      try {
        await options.mediaStorage.read(preset.contentHash);
      } catch {
        throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Default avatar object is not initialized");
      }
      await lockAvatarSubject(client, realm, subjectId);
      const result = await selectDefaultAvatar(client, realm, subjectId, normalized, { realm, id: subjectId, sessionId: actor.sessionId }, requestIdValue);
      return { status: 200, body: { changed: result.changed, ...result.state } };
    },
  );
}

async function readAvatarState(options: ProfileAvatarRuntimeOptions, request: SupplyNodeRequest, realm: ProfileAvatarRealm): Promise<unknown> {
  const context = realm === "user" ? await readUserContext(request, options) : await readAdminContext(request, options);
  return withTransaction(options.pool, async (client) => {
    if (realm === "user") {
      await assertUserContextInTransaction(client, context as { userId: string; sessionId: string }, "READ");
      return profileAvatarWithPending(client, "user", context.userId);
    }
    await assertAdminContextInTransaction(client, { userId: context.userId, sessionId: context.sessionId });
    return profileAvatarWithPending(client, "admin", context.userId);
  });
}

async function readAvatarPreview(options: ProfileAvatarRuntimeOptions, request: SupplyNodeRequest, response: SupplyNodeResponse, requestIdValue: string, realm: ProfileAvatarRealm): Promise<void> {
  const context = realm === "user" ? await readUserContext(request, options) : await readAdminContext(request, options);
  const data = await withTransaction(options.pool, async (client) => {
    if (realm === "user") await assertUserContextInTransaction(client, context as { userId: string; sessionId: string }, "READ");
    else await assertAdminContextInTransaction(client, { userId: (context as { userId: string }).userId, sessionId: (context as { sessionId: string }).sessionId });
    const subjectId = (context as { userId: string }).userId;
    const row = await loadProfileAvatar(client, realm, subjectId);
    if (!row?.pendingAssetId) throw notFound();
    const asset = await loadMediaAsset(client, row.pendingAssetId);
    if (!asset || !isAvatarAsset(asset) || !asset.publicStorageKey || avatarSubjectOfAsset(asset)?.realm !== realm || avatarSubjectOfAsset(asset)?.subjectId !== subjectId) throw notFound();
    return asset;
  });
  await sendStoredMedia(response, requestIdValue, options.mediaStorage, { storageKey: data.publicStorageKey!, mime: data.mime, contentHash: data.publicStorageKey! }, "private, no-store");
}

async function readDefaultOperationResult(
  options: ProfileAvatarRuntimeOptions,
  request: SupplyNodeRequest,
  realm: ProfileAvatarRealm,
): Promise<unknown> {
  const query = new URLSearchParams((request.url ?? request.originalUrl ?? "").split("?")[1] ?? "");
  for (const name of query.keys()) if (!["operation", "presetId", "expectedRevision"].includes(name) || query.getAll(name).length !== 1) throw invalid("Unsupported avatar result query");
  if (query.get("operation") !== "profile.avatar.default.select") throw invalid("Operation does not support result recovery", "operation");
  const presetId = query.get("presetId");
  if (!isProfileAvatarPresetId(presetId)) throw invalid("Avatar preset is invalid", "presetId");
  const expectedRevision = query.get("expectedRevision");
  if (typeof expectedRevision !== "string" || !/^(?:0|[1-9]\d{0,18})$/.test(expectedRevision)) throw invalid("Avatar revision is invalid", "expectedRevision");
  const context = realm === "user" ? await readUserContext(request, options) : await readAdminContext(request, options);
  return withTransaction(options.pool, async (client) => {
    if (realm === "user") await assertUserContextInTransaction(client, context as { userId: string; sessionId: string }, "READ");
    else await assertAdminContextInTransaction(client, { userId: (context as { userId: string }).userId, sessionId: (context as { sessionId: string }).sessionId });
    const actor = { realm, id: (context as { userId: string }).userId };
    return readAvatarOperationReceipt(
      client,
      actor,
      "profile.avatar.default.select",
      null,
      fingerprintRequest("profile.avatar.default.select", undefined, { presetId, expectedRevision }),
      idempotencyKey(request),
    );
  });
}

export async function handleProfileAvatarUserRoute(request: SupplyNodeRequest, response: SupplyNodeResponse, options: ProfileAvatarRuntimeOptions): Promise<void> {
  const requestIdValue = requestId(request);
  response.setHeader("X-Request-Id", requestIdValue);
  const { path } = pathOf(request, "/api/v1/profile");
  const method = (request.method ?? "GET").toUpperCase();
  try {
    if (method === "POST" || method === "PUT") idempotencyKey(request);
    const presetMatch = /^\/avatars\/presets\/([^/]+)\/([^/]+)\/content$/.exec(path);
    if (presetMatch && method === "GET") {
      await servePreset(response, requestIdValue, options, decodeId(presetMatch[1]!), presetMatch[2]!, PRESET_CACHE);
      return;
    }
    const publicMatch = /^\/avatars\/(user|admin)\/([^/]+)\/([^/]+)$/.exec(path);
    if (publicMatch && method === "GET") {
      await serveCurrentAvatar(response, requestIdValue, options, publicMatch[1] as ProfileAvatarRealm, decodeId(publicMatch[2]!), publicMatch[3]!);
      return;
    }
    if (!requireOrigin(request, response, options, requestIdValue)) return;
    if (path === "/avatar" && method === "GET") {
      sendJson(response, 200, await readAvatarState(options, request, "user"), requestIdValue);
      return;
    }
    if (path === "/avatar/preview" && method === "GET") {
      await readAvatarPreview(options, request, response, requestIdValue, "user");
      return;
    }
    if (path === "/avatar/operation-result" && method === "GET") {
      sendJson(response, 200, await readDefaultOperationResult(options, request, "user"), requestIdValue);
      return;
    }
    if (path === "/avatar/default" && method === "POST") {
      const context = await readUserContext(request, options);
      await selectAvatarDefault(options, request, response, requestIdValue, { realm: "user", id: context.userId, sessionId: context.sessionId }, "user");
      return;
    }
    if (path === "/avatar/upload-intents" && method === "POST") {
      const context = await readUserContext(request, options);
      await createAvatarUploadIntent(options, request, response, requestIdValue, { realm: "user", id: context.userId, sessionId: context.sessionId }, "user");
      return;
    }
    const uploadMatch = /^\/avatar\/uploads\/([^/]+)$/.exec(path);
    if (uploadMatch && method === "PUT") {
      const context = await readUserContext(request, options);
      await uploadAvatar(options, request, response, requestIdValue, { realm: "user", id: context.userId, sessionId: context.sessionId }, "user", decodeId(uploadMatch[1]!));
      return;
    }
    throw notFound();
  } catch (error) {
    if (error instanceof SecurityApiError) sendError(response, error, requestIdValue);
    else sendInternalError(response, requestIdValue);
  }
}

async function adminReviewAsset(client: PoolClient, assetId: string, expectedRevision: string | undefined) {
  const asset = await loadMediaAsset(client, assetId, true);
  if (!asset || !isAvatarAsset(asset)) throw notFound();
  if (expectedRevision !== undefined && asset.revision !== expectedRevision) throw conflict("Avatar review changed; reload before deciding");
  const subject = avatarSubjectOfAsset(asset);
  if (!subject) throw notFound();
  return { asset, subject };
}

export async function handleProfileAvatarAdminSelfRoute(request: SupplyNodeRequest, response: SupplyNodeResponse, options: ProfileAvatarRuntimeOptions): Promise<void> {
  const requestIdValue = requestId(request);
  response.setHeader("X-Request-Id", requestIdValue);
  const { path } = pathOf(request, "/api/v1/admin/profile-avatar");
  const method = (request.method ?? "GET").toUpperCase();
  try {
    if (method === "POST" || method === "PUT") idempotencyKey(request);
    if (!requireOrigin(request, response, options, requestIdValue)) return;
    if (path === "/" && method === "GET") {
      sendJson(response, 200, await readAvatarState(options, request, "admin"), requestIdValue);
      return;
    }
    if (path === "/preview" && method === "GET") {
      await readAvatarPreview(options, request, response, requestIdValue, "admin");
      return;
    }
    if (path === "/operation-result" && method === "GET") {
      sendJson(response, 200, await readDefaultOperationResult(options, request, "admin"), requestIdValue);
      return;
    }
    if (path === "/default" && method === "POST") {
      const context = await readAdminContext(request, options);
      await selectAvatarDefault(options, request, response, requestIdValue, { realm: "admin", id: context.userId, sessionId: context.sessionId }, "admin");
      return;
    }
    if (path === "/upload-intents" && method === "POST") {
      const context = await readAdminContext(request, options);
      await createAvatarUploadIntent(options, request, response, requestIdValue, { realm: "admin", id: context.userId, sessionId: context.sessionId }, "admin");
      return;
    }
    const uploadMatch = /^\/uploads\/([^/]+)$/.exec(path);
    if (uploadMatch && method === "PUT") {
      const context = await readAdminContext(request, options);
      await uploadAvatar(options, request, response, requestIdValue, { realm: "admin", id: context.userId, sessionId: context.sessionId }, "admin", decodeId(uploadMatch[1]!));
      return;
    }
    throw notFound();
  } catch (error) {
    if (error instanceof SecurityApiError) sendError(response, error, requestIdValue);
    else sendInternalError(response, requestIdValue);
  }
}

function parseCursor(value: string | null, state: string): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { v?: unknown; state?: unknown; createdAt?: unknown; id?: unknown };
    if (decoded.v !== 1 || decoded.state !== state || typeof decoded.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(decoded.createdAt) || typeof decoded.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(decoded.id)) throw invalid("Cursor is invalid");
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch (error) {
    if (error instanceof SecurityApiError) throw error;
    throw invalid("Cursor is invalid");
  }
}

async function adminAccess(client: PoolClient, adminId: string) {
  const access = await requireAdminAccess(client, adminId);
  requirePermission(access, ADMIN_PERMISSION.profileAvatarReview);
  return access;
}

export async function handleProfileAvatarAdminReviewRoute(request: SupplyNodeRequest, response: SupplyNodeResponse, options: ProfileAvatarRuntimeOptions): Promise<void> {
  const requestIdValue = requestId(request);
  response.setHeader("X-Request-Id", requestIdValue);
  const { path, query } = pathOf(request, "/api/v1/admin/profile-avatars");
  const method = (request.method ?? "GET").toUpperCase();
  try {
    if (method === "POST" || method === "PUT") idempotencyKey(request);
    if (!requireOrigin(request, response, options, requestIdValue)) return;
    if (path === "/" && method === "GET") {
      const context = await readAdminContext(request, options);
      const state = query.get("state") ?? "PENDING";
      if (!["PENDING", "APPROVED", "REJECTED", "QUARANTINED"].includes(state)) throw invalid("State is invalid");
      const limitRaw = query.get("limit");
      const limit = limitRaw === null ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
      const cursor = parseCursor(query.get("cursor"), state);
      const result = await withTransaction(options.pool, async (client) => {
        await assertAdminContextInTransaction(client, { userId: context.userId, sessionId: context.sessionId });
        await adminAccess(client, context.userId);
        return listAvatarReviews(client, { state, cursor, limit });
      });
      sendJson(response, 200, result, requestIdValue);
      return;
    }
    if (path === "/operation-result" && method === "POST") {
      if (query.size) throw invalid("Result recovery does not accept query parameters");
      const body = bodyOf(request);
      ensureOnlyFields(body, ["operation", "assetId", "decision", "reason", "expectedRevision"]);
      const operation = requiredString(body, "operation", 64);
      if (operation !== "profile.avatar.review" && operation !== "profile.avatar.withdraw") throw invalid("Operation does not support result recovery");
      const assetId = requiredString(body, "assetId", 128);
      if (!new RegExp(`^${TOKEN}$`).test(assetId)) throw invalid("Avatar asset is required");
      const normalized = reviewInput({ ...(operation === "profile.avatar.review" ? { decision: body.decision } : {}), reason: body.reason, expectedRevision: body.expectedRevision }, operation === "profile.avatar.withdraw");
      const context = await readAdminContext(request, options);
      const result = await withTransaction(options.pool, async client => {
        await assertAdminContextInTransaction(client, { userId: context.userId, sessionId: context.sessionId });
        await adminAccess(client, context.userId);
        await adminReviewAsset(client, assetId, undefined);
        return readAvatarOperationReceipt(client, { realm: "admin", id: context.userId }, operation, assetId, fingerprintRequest(operation, assetId, normalized), idempotencyKey(request));
      });
      sendJson(response, 200, result, requestIdValue);
      return;
    }
    const contentMatch = /^\/([^/]+)\/content$/.exec(path);
    if (contentMatch && method === "GET") {
      const assetId = decodeId(contentMatch[1]!);
      const context = await readAdminContext(request, options);
      const asset = await withTransaction(options.pool, async (client) => {
        await assertAdminContextInTransaction(client, { userId: context.userId, sessionId: context.sessionId });
        await adminAccess(client, context.userId);
        const row = await loadMediaAsset(client, assetId);
        if (!row || !isAvatarAsset(row)) throw notFound();
        return row;
      });
      await sendStoredMedia(response, requestIdValue, options.mediaStorage, asset, "private, no-store");
      return;
    }
    const reviewMatch = /^\/([^/]+)\/(review|withdraw)$/.exec(path);
    if (reviewMatch && method === "POST") {
      const assetId = decodeId(reviewMatch[1]!);
      const withdraw = reviewMatch[2] === "withdraw";
      const body = bodyOf(request);
      const normalized = reviewInput(body, withdraw);
      const { decision, reason, expectedRevision } = normalized;
      const context = await readAdminContext(request, options);
      const actor: WriteActor = { realm: "admin", id: context.userId, sessionId: context.sessionId };
      const operation = withdraw ? "profile.avatar.withdraw" : "profile.avatar.review";
      await runIdempotentWrite(
        options,
        request,
        response,
        requestIdValue,
        { principalId: context.userId, operation, resourceId: assetId },
        actor,
        normalized,
        async (client) => {
          await assertAdminContextInTransaction(client, { userId: context.userId, sessionId: context.sessionId });
          await adminAccess(client, context.userId);
          const hint = await loadMediaAsset(client, assetId);
          const subject = hint && isAvatarAsset(hint) ? avatarSubjectOfAsset(hint) : null;
          if (!subject) throw notFound();
          await lockAvatarReviewSubjects(client, context.userId, subject);
          await adminReviewAsset(client, assetId, undefined);
        },
        async (client) => {
          const access = await adminAccess(client, context.userId);
          const target = await adminReviewAsset(client, assetId, expectedRevision);
          if (withdraw && target.asset.reviewState !== "APPROVED") throw conflict("Only an approved avatar can be withdrawn");
          const reviewed = await reviewMediaAsset(client, context.userId, access.isBoss, assetId, {
            decision: withdraw ? "APPROVE" : decision,
            ...(reason ? { reason } : {}),
            visibility: decision === "APPROVE" ? "PUBLIC_DISPLAY" : "PRIVATE_REVIEW",
          });
          const application = await applyAvatarReview(
            client,
            target.subject.realm,
            target.subject.subjectId,
            assetId,
            decision as ProfileAvatarDecision,
            reason ?? null,
            { realm: "admin", id: context.userId, sessionId: context.sessionId },
            requestIdValue,
          );
          const avatar = await profileAvatarWithPending(client, target.subject.realm, target.subject.subjectId);
          return { status: 200, body: { asset: reviewed, review: application, avatar } };
        },
      );
      return;
    }
    throw notFound();
  } catch (error) {
    if (error instanceof SecurityApiError) sendError(response, error, requestIdValue);
    else sendInternalError(response, requestIdValue);
  }
}

export function mountProfileAvatarHandlers(app: INestApplication, options: ProfileAvatarRuntimeOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: SupplyNodeRequest, response: SupplyNodeResponse) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/profile", (request, response) => handleProfileAvatarUserRoute(request, response, options));
  expressApp.use("/api/v1/admin/profile-avatar", (request, response) => handleProfileAvatarAdminSelfRoute(request, response, options));
  expressApp.use("/api/v1/admin/profile-avatars", (request, response) => handleProfileAvatarAdminReviewRoute(request, response, options));
}
