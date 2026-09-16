import { withPublicListingSnapshot } from "./publishing";
import { handleFavorites } from "./favorites";
import { handlePublishingRoute } from "./publishing-routes";
import type { SupplyGateReader } from "./publishing";
import type { INestApplication } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { auditObjectType, auditSnapshot } from "./supply-audit";
import { ContentHashError } from "./content-hash";
import { DecimalError } from "./decimal";

import {
  ADMIN_PERMISSION,
  hasPermission,
  loadEffectiveAdminAccess,
  requirePermission,
  type EffectiveAdminAccess,
} from "../auth/admin-authorization";
import { readAdminContext, assertAdminContextInTransaction, type AuthSecurityOptions } from "../auth/auth-security";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "../auth/security-core";
import { readUserContext, assertUserContextInTransaction } from "../auth/user-identity";
import { API_V1_ERROR_CODES, ApiV1HttpException, ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import {
  bindGameCover,
  createCatalogEntry,
  createGame,
  listGames,
  readAdminCatalog,
  readPublicCatalog,
  updateCatalogEntry,
  updateGame,
} from "./catalog";
import {
  createAlias,
  createClassification,
  createFirearm,
  createGunsmithCode,
  listAdminFirearms,
  listPublicFirearmCodes,
  listPublicFirearms,
  parsePublicLimit,
  parsePublicMode,
  setGunsmithCodeStatus,
  updateAlias,
  updateClassification,
  updateFirearm,
  updateGunsmithCode,
} from "./gunsmith";
import { GAME_SERVICE, isSupportedGameService, requirePublicGameService, requireWritableGameService, unsupportedGameService, ensureGameServiceRows, type GameServiceCode } from "./game-services";
import {
  activateRelease,
  createAgreementDraft,
  createPriceDraft,
  createTermDraft,
  listRules,
  quotePreview,
  sealVersion,
  updateAgreementDraft,
  updatePriceDraft,
  updateTermDraft,
} from "./rules";
import {
  changeMediaVisibility,
  finalizeMediaUpload,
  createMediaUploadIntent,
  loadMediaAsset,
  logOrphanedMediaObjects,
  prepareMediaUpload,
  reviewMediaAsset,
  type MediaActor,
  type MediaStorage,
  type PreparedMediaUpload,
} from "./media";
import {
  assertGameScope,
  assertGameExists,
  bodyOf,
  conflict,
  ensureOnlyFields,
  fingerprintRequest,
  headerValue,
  invalid,
  newSupplyId,
  notFound,
  optionalInteger,
  optionalString,
  optionalTrimmedString,
  parseExpectedRevision,
  requiredString,
  sendError,
  sendInternalError,
  sendJson,
  withIdempotency,
  type IdempotencyReplay,
  type SupplyNodeRequest,
  type SupplyNodeResponse,
} from "./supply-util";

export type SupplyRuntimeOptions = AuthSecurityOptions & { mediaStorage: MediaStorage; supplyGateReader?: SupplyGateReader };

export type SupplyResponse = SupplyNodeResponse & {
  send?: (body: Buffer | string) => void;
};

const TOKEN = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";

export function decodeId(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!new RegExp(`^${TOKEN}$`).test(decoded)) throw notFound();
  return decoded;
}

export function requestPath(request: SupplyNodeRequest, prefix: string): { path: string; query: URLSearchParams } {
  const raw = request.url ?? request.originalUrl ?? "/";
  const index = raw.indexOf("?");
  let path = index >= 0 ? raw.slice(0, index) : raw;
  if (path === prefix) path = "/";
  else if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
  return { path: path || "/", query: new URLSearchParams(index >= 0 ? raw.slice(index + 1) : "") };
}

function originAllowed(request: SupplyNodeRequest, origins: readonly string[]): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) return request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  return origins.includes(origin);
}

export function requireOrigin(request: SupplyNodeRequest, response: SupplyResponse, options: { apiOrigin: string; userOrigin: string; adminOrigin: string }, requestId: string): boolean {
  if (originAllowed(request, [options.apiOrigin, options.userOrigin, options.adminOrigin])) return true;
  sendJson(response, 403, { error: { code: API_V1_ERROR_CODES.FORBIDDEN, message: "Request rejected", requestId } }, requestId);
  return false;
}

export function mapDatabaseError(error: unknown): SecurityApiError | null {
  const code = (error as { code?: string }).code;
  if (code === "40001" || code === "40P01") return conflict("Supply state changed; reload and retry");
  if (code === "23505") return new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Request conflicts with current state");
  if (code === "23503" || code === "23514" || code === "22P02" || code === "22003" || code === "P0001") {
    return new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request violates a supply constraint");
  }
  return null;
}

export async function safely(response: SupplyResponse, requestId: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ContentHashError || error instanceof DecimalError) { sendError(response, invalid(error.message), requestId); return; }
    if (error instanceof ApiV1HttpException) {
      sendJson(response, error.getStatus(), { error: { code: error.code, message: error.safeMessage, requestId, ...(error.details ? { details: error.details } : {}) } }, requestId);
      return;
    }
    if (error instanceof SecurityApiError) {
      sendError(response, error, requestId);
      return;
    }
    const mapped = mapDatabaseError(error);
    if (mapped) {
      sendError(response, mapped, requestId);
      return;
    }
    sendInternalError(response, requestId);
  }
}

export async function readRawBody(request: SupplyNodeRequest, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request as unknown as AsyncIterable<Buffer | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw invalid("Upload exceeds the allowed size");
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof SecurityApiError) throw error;
    throw invalid("Upload body could not be read");
  }
  return Buffer.concat(chunks);
}

export async function sendStoredMedia(
  response: SupplyResponse,
  requestId: string,
  storage: MediaStorage,
  asset: { storageKey: string; mime: string; contentHash: string },
  cacheControl: string,
): Promise<void> {
  if (!storage.available) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Media storage is not configured");
  let bytes: Buffer;
  try {
    bytes = await storage.read(asset.storageKey);
  } catch {
    throw notFound();
  }
  if (response.headersSent) return;
  response.status(200);
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Content-Type", asset.mime);
  response.setHeader("Content-Length", String(bytes.length));
  response.setHeader("ETag", `"sha256-${asset.contentHash}"`);
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.send?.(bytes);
}

export type WriteActor = { realm: "admin" | "user"; id: string; sessionId: string };

export async function runIdempotentWrite(
  options: { pool: Pool },
  request: SupplyNodeRequest,
  response: SupplyResponse,
  requestId: string,
  scope: { principalId: string; operation: string; resourceId?: string },
  actor: WriteActor,
  fingerprintBody: unknown,
  authorize: (client: PoolClient, replay: IdempotencyReplay) => Promise<boolean | void>,
  action: (client: PoolClient) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const key = validateIdempotencyKey(headerValue(request.headers["idempotency-key"]));
  const fingerprint = fingerprintRequest(scope.operation, scope.resourceId, fingerprintBody ?? null);
  try {
    const result = await withTransaction(options.pool, async (client) => {
      await setAuditContext(client, actor.realm, actor.id, actor.sessionId, requestId);
      return withIdempotency(client, { ...scope, realm: actor.realm }, key, fingerprint, (replay) => authorize(client, replay), () => action(client));
    });
    sendJson(response, result.status, result.body, requestId);
  } catch (error) {
    const uniqueViolation = (error as { code?: string }).code === "23505";
    if (uniqueViolation) {
      const committed = await withTransaction(options.pool, async (client) => {
        // Read the winner's record first so the re-authorization can also apply
        // the original operation's publish requirement.
        const row = (await client.query<{ requestFingerprint: string; responseStatus: number; responseBody: unknown; publishRequired: boolean }>(
        `SELECT "request_fingerprint" AS "requestFingerprint", "response_status" AS "responseStatus", "response_body" AS "responseBody",
                "publish_required" AS "publishRequired"
           FROM "zzsh_supply"."idempotency_record" WHERE "scope_key" = $1 AND "key" = $2`,
        [JSON.stringify([actor.realm, scope.principalId, scope.operation, scope.resourceId ?? null]), key],
      )).rows[0];
        if (row) await authorize(client, { publishRequired: row.publishRequired === true });
        return { row };
      });
      const row = committed.row;
      if (row) {
        if (row.requestFingerprint !== fingerprint) {
          sendError(response, new SecurityApiError(409, API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, "Idempotency key was reused with a different request"), requestId);
          return;
        }
        sendJson(response, row.responseStatus, row.responseBody, requestId);
        return;
      }
    }
    throw error;
  }
}

export async function requireAdminAccess(client: PoolClient, adminUserId: string): Promise<EffectiveAdminAccess> {
  const access = await loadEffectiveAdminAccess(client, adminUserId);
  if (!access || access.status !== "ACTIVE") throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Access denied");
  return access;
}

async function authorizeUpload(client: PoolClient, actor: WriteActor, intentId: string): Promise<void> {
  const row = (await client.query<{ game_id: string | null; purpose: string; account_id: string | null; uploaded_by_realm: string; uploaded_by_user_id: string | null; uploaded_by_admin_id: string | null }>(
    `SELECT game_id, purpose, account_id, uploaded_by_realm, uploaded_by_user_id, uploaded_by_admin_id FROM zzsh_supply.media_upload_intent WHERE id = $1`, [intentId],
  )).rows[0];
  if (!row || row.uploaded_by_realm !== actor.realm || (actor.realm === "admin" ? row.uploaded_by_admin_id : row.uploaded_by_user_id) !== actor.id) throw notFound();
  if (actor.realm === "admin") {
    const access = await requireAdminAccess(client, actor.id);
    if (row.game_id === null) {
      // Platform-level content media is gated by the content management
      // permission instead of a game scope.
      requirePermission(access, ADMIN_PERMISSION.contentPlatformEdit);
      if (row.purpose !== "CONTENT_MEDIA") throw notFound();
    } else {
      requirePermission(access, ADMIN_PERMISSION.supplyCatalogManage);
      await assertGameScope(client, actor.id, access.isBoss, row.game_id);
    }
  } else if (!(await client.query(`SELECT 1 FROM zzsh_supply.rental_account WHERE id = $1 AND owner_user_id = $2 AND game_id = $3`, [row.account_id, actor.id, row.game_id])).rowCount) throw notFound();
}

async function hasIdempotencyRecord(pool: SupplyRuntimeOptions["pool"], scope: { realm: "admin" | "user"; principalId: string; operation: string; resourceId?: string }, key: string): Promise<boolean> {
  const scopeKey = JSON.stringify([scope.realm, scope.principalId, scope.operation, scope.resourceId ?? null]);
  const result = await pool.query(`SELECT 1 FROM zzsh_supply.idempotency_record WHERE scope_key = $1 AND key = $2`, [scopeKey, key]);
  return (result.rowCount ?? 0) > 0;
}

// Media uploads write content-addressed objects to storage before the database
// transaction runs, so no pooled connection is held across storage network
// calls. Current permissions and object ownership are re-checked in a short
// transaction before any storage write, so an already-revoked request performs
// zero object writes; the check is repeated inside the final transaction. This
// narrows but does not eliminate the revocation race between the two checks.
// Replay lookups skip the object writes entirely; if a concurrent request with
// the same key commits between the pre-check and preparation, the recorded
// result is still returned instead of a spurious conflict.
export async function runMediaUpload(
  options: SupplyRuntimeOptions,
  request: SupplyNodeRequest,
  response: SupplyResponse,
  requestId: string,
  input: {
    actor: WriteActor;
    mediaActor: MediaActor;
    intentId: string;
    uploadToken: string;
    bytes: Buffer;
    authorize: (client: PoolClient) => Promise<void>;
    beforeFinalize?: (client: PoolClient) => Promise<void>;
  },
): Promise<void> {
  const scope = { principalId: input.actor.id, operation: "supply.media.upload", resourceId: input.intentId };
  const key = validateIdempotencyKey(headerValue(request.headers["idempotency-key"]));
  const idempotentScope = { ...scope, realm: input.actor.realm };
  let prepared: PreparedMediaUpload | undefined;
  if (!(await hasIdempotencyRecord(options.pool, idempotentScope, key))) {
    // Short transaction: verify current permissions/ownership and release the
    // connection before any storage network call is made.
    await withTransaction(options.pool, async (client) => {
      await input.authorize(client);
    });
    try {
      prepared = await prepareMediaUpload(options.pool, options.mediaStorage, input.mediaActor, input.intentId, input.uploadToken, input.bytes);
    } catch (error) {
      if (!(error instanceof SecurityApiError) || error.status !== 409 || !(await hasIdempotencyRecord(options.pool, idempotentScope, key))) throw error;
    }
  }
  try {
    await runIdempotentWrite(
      options,
      request,
      response,
      requestId,
      scope,
      input.actor,
      { intentId: input.intentId, token: input.uploadToken, contentHash: fingerprintRequest("bytes", input.intentId, input.bytes.toString("base64")) },
      input.authorize,
      async (client) => {
        await input.beforeFinalize?.(client);
        if (!prepared) throw new SecurityApiError(500, API_V1_ERROR_CODES.INTERNAL_ERROR, "Media upload was not prepared");
        const asset = await finalizeMediaUpload(client, input.mediaActor, prepared);
        await recordAudit(client, {
          actorType: input.actor.realm,
          actorId: input.actor.id,
          sessionId: input.actor.sessionId,
          action: "supply.media.uploaded",
          objectType: "media_asset",
          objectId: asset.assetId,
          outcome: "SUCCESS",
          requestId,
          reason: "supply.media.upload",
          details: { gameId: asset.gameId, before: null, after: { ...asset, revision: "1" }, result: "CREATED" },
        });
        return { status: 200, body: asset };
      },
    );
  } catch (error) {
    // A prepared result whose transaction failed always logs pending candidates.
    // An idempotency record for this key may belong to a DIFFERENT concurrent
    // request (same intent/token/key, different bytes), so its mere presence
    // cannot prove this request's objects are referenced. Candidates are not
    // confirmed orphans: a cleanup sweep must verify actual references, and the
    // request path never deletes objects.
    if (prepared) {
      logOrphanedMediaObjects({ intentId: input.intentId, storageKeys: prepared.writtenStorageKeys, phase: "commit" });
    }
    throw error;
  }
}

const CATALOG_KINDS = new Set(["items", "rarities", "categories", "skins", "entitlements"]);

function catalogKind(value: string): "items" | "rarities" | "categories" | "skins" | "entitlements" {
  if (!CATALOG_KINDS.has(value)) throw notFound();
  return value as "items" | "rarities" | "categories" | "skins" | "entitlements";
}

async function handlePublicGunsmithRoute(
  response: SupplyResponse,
  options: SupplyRuntimeOptions,
  requestId: string,
  method: string,
  path: string,
  query: URLSearchParams,
): Promise<boolean> {
  if (method !== "GET") return false;
  if (path === "/gunsmith/games") {
    const games = (await options.pool.query<{ id: string; code: string; name: string; description: string | null }>(
      `SELECT g.id,g.code,g.name,g.description
         FROM zzsh_supply.game g JOIN zzsh_supply.game_service_operation s ON s.game_id=g.id AND s.service_code='GUNSMITH'
        WHERE g.enabled AND s.enabled ORDER BY g.code,g.id`,
    )).rows.filter((game) => isSupportedGameService(game.code, GAME_SERVICE.GUNSMITH));
    sendJson(response, 200, { games }, requestId, "public, max-age=30");
    return true;
  }
  const firearmsMatch = /^\/gunsmith\/games\/([^/]+)\/firearms$/.exec(path);
  if (firearmsMatch) {
    const gameId = decodeId(firearmsMatch[1]!);
    const q = query.get("q");
    const classificationId = query.get("classificationId") ?? query.get("class");
    if (classificationId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(classificationId)) throw invalid("Classification is invalid");
    const result = await withTransaction(options.pool, (client) => listPublicFirearms(client, gameId, {
      q,
      classificationId,
      limit: parsePublicLimit(query.get("limit")),
      cursor: query.get("cursor") ?? undefined,
    }));
    sendJson(response, 200, result, requestId, "public, max-age=30");
    return true;
  }
  const codesMatch = /^\/gunsmith\/firearms\/([^/]+)\/codes$/.exec(path);
  if (codesMatch) {
    const firearmId = decodeId(codesMatch[1]!);
    const result = await withTransaction(options.pool, (client) => listPublicFirearmCodes(client, firearmId, {
      mode: parsePublicMode(query.get("mode")),
      limit: parsePublicLimit(query.get("limit")),
      cursor: query.get("cursor") ?? undefined,
    }));
    sendJson(response, 200, result, requestId, "public, max-age=30");
    return true;
  }
  return false;
}

export async function handleSupplyUserRoute(
  request: SupplyNodeRequest,
  response: SupplyResponse,
  options: SupplyRuntimeOptions,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const { path, query } = requestPath(request, "/api/v1/supply");
  const method = (request.method ?? "GET").toUpperCase();

  await safely(response, requestId, async () => {
    if (await handlePublicGunsmithRoute(response, options, requestId, method, path, query)) return;
    if (await handleFavorites(request,response,options,requestId,path,query)) return;
    if (await handlePublishingRoute(request,response,options,requestId,path,query,false)) return;
    if (method === "GET") {
      if (path === "/games") {
        const rows = (await options.pool.query<{ id: string; code: string; name: string; description: string | null }>(
          `SELECT g.id,g.code,g.name,g.description
             FROM zzsh_supply.game g JOIN zzsh_supply.game_service_operation s ON s.game_id=g.id AND s.service_code='ACCOUNT_RENTAL'
            WHERE g.enabled AND g.current_release_id IS NOT NULL AND s.enabled ORDER BY g.code,g.id`,
        )).rows.filter((game) => isSupportedGameService(game.code, GAME_SERVICE.ACCOUNT_RENTAL));
        sendJson(response,200,{games: rows},requestId);
        return;
      }
      const catalogMatch = /^\/games\/([^/]+)\/(catalog|publishing-catalog)$/.exec(path);
      if (catalogMatch) {
        const gameId = decodeId(catalogMatch[1]!);
        const limitRaw = query.get("limit");
        const limit = limitRaw === null ? 20 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
        const result = await withPublicListingSnapshot(options.pool, async (client) => {
          await requirePublicGameService(client, gameId, GAME_SERVICE.ACCOUNT_RENTAL);
          return readPublicCatalog(
            client,
            gameId,
            {
              ...(query.get("q") ? { q: query.get("q")! } : {}),
              ...(query.get("categoryId") ? { categoryId: query.get("categoryId")! } : {}),
              ...(query.get("rarityCode") ? { rarityCode: query.get("rarityCode")! } : {}),
            },
            limit,
            query.get("cursor") ?? undefined,
            catalogMatch[2] === "publishing-catalog" ? "publishing" : "browse",
          );
        });
        sendJson(response, 200, result, requestId, catalogMatch[2] === "publishing-catalog" ? "no-store" : "public, max-age=30");
        return;
      }
      const contentMatch = /^\/media\/([^/]+)\/content$/.exec(path);
      if (contentMatch) {
        const assetId = decodeId(contentMatch[1]!);
        const asset = await loadMediaAsset(options.pool, assetId);
        if (!asset || asset.ownershipKind !== "PLATFORM_CATALOG" || asset.reviewState !== "APPROVED" || asset.accessClass !== "PUBLIC_DISPLAY") throw notFound();
        if (!asset.publicStorageKey) throw notFound();
        await sendStoredMedia(response, requestId, options.mediaStorage, { ...asset, storageKey: asset.publicStorageKey, contentHash: asset.publicStorageKey }, "public, max-age=0, must-revalidate");
        return;
      }
    }

    if (!requireOrigin(request, response, options, requestId)) return;

    if (path === "/accounts" && method === "POST") {
      const context = await readUserContext(request, options);
      const body = bodyOf(request);
      ensureOnlyFields(body, ["gameId"]);
      const gameId = decodeId(requiredString(body, "gameId", 128));
      const accountId = newSupplyId("account");
      await runIdempotentWrite(
        options,
        request,
        response,
        requestId,
        { principalId: context.userId, operation: "supply.account.create" },
        { realm: "user", id: context.userId, sessionId: context.sessionId },
        { gameId },
        async (client) => {
          await assertUserContextInTransaction(client, context);
          await requireWritableGameService(client, gameId, GAME_SERVICE.ACCOUNT_RENTAL);
        },
        async (client) => {
          await requireWritableGameService(client, gameId, GAME_SERVICE.ACCOUNT_RENTAL);
          await client.query(
            `INSERT INTO "zzsh_supply"."rental_account" ("id", "owner_user_id", "game_id") VALUES ($1, $2, $3)`,
            [accountId, context.userId, gameId],
          );
          await recordAudit(client, {
            actorType: "user",
            actorId: context.userId,
            sessionId: context.sessionId,
            action: "supply.account.created",
            objectType: "rental_account",
            objectId: accountId,
            outcome: "SUCCESS",
            requestId,
            reason: "supply.account.create",
            details: { gameId, before: null, after: { accountId, gameId, revision: "1" }, result: "CREATED" },
          });
          return { status: 200, body: { accountId, gameId } };
        },
      );
      return;
    }

    const userIntentMatch = path === "/media/upload-intents" && method === "POST";
    if (userIntentMatch) {
      const context = await readUserContext(request, options);
      const body = bodyOf(request);
      ensureOnlyFields(body, ["gameId", "accountId", "mime", "size", "purpose"]);
      const gameId = decodeId(requiredString(body, "gameId", 128));
      const accountId = decodeId(requiredString(body, "accountId", 128));
      const mime = requiredString(body, "mime", 64);
      const size = optionalInteger(body, "size", 1, 10 * 1024 * 1024);
      if (size === undefined) throw invalid("Size is required");
      if (!options.mediaStorage.available) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Media storage is not configured");
      await runIdempotentWrite(
        options,
        request,
        response,
        requestId,
        { principalId: context.userId, operation: "supply.media.upload_intent.create" },
        { realm: "user", id: context.userId, sessionId: context.sessionId },
        { gameId, accountId, mime, size, ...(body.purpose === undefined ? {} : { purpose: body.purpose }) },
        async (client) => {
          await assertUserContextInTransaction(client, context);
          if (!(await client.query(`SELECT 1 FROM zzsh_supply.rental_account WHERE id = $1 AND game_id = $2 AND owner_user_id = $3`, [accountId, gameId, context.userId])).rowCount) throw notFound();
        },
        async (client) => {
          const intent = await createMediaUploadIntent(client, { realm: "user", userId: context.userId }, { gameId, accountId, purpose: String(body.purpose ?? "ACCOUNT_EVIDENCE"), mime, size });
          await recordAudit(client, {
            actorType: "user",
            actorId: context.userId,
            sessionId: context.sessionId,
            action: "supply.media.upload_intent_created",
            objectType: "media_upload_intent",
            objectId: intent.intentId,
            outcome: "SUCCESS",
            requestId,
            reason: "supply.media.upload_intent.create",
            details: { gameId, before: null, after: { intentId: intent.intentId, accountId, purpose: "ACCOUNT_EVIDENCE" }, result: "CREATED" },
          });
          return { status: 200, body: { intentId: intent.intentId, uploadToken: intent.uploadToken, expiresAt: intent.expiresAt } };
        },
      );
      return;
    }

    const userUploadMatch = /^\/media\/uploads\/([^/]+)$/.exec(path);
    if (userUploadMatch && method === "PUT") {
      const context = await readUserContext(request, options);
      const intentId = decodeId(userUploadMatch[1]!);
      const uploadToken = headerValue(request.headers["x-upload-token"]);
      if (!uploadToken) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Upload token is invalid");
      const bytes = await readRawBody(request, 10 * 1024 * 1024);
      await runMediaUpload(options, request, response, requestId, {
        actor: { realm: "user", id: context.userId, sessionId: context.sessionId },
        mediaActor: { realm: "user", userId: context.userId },
        intentId,
        uploadToken,
        bytes,
        authorize: async (client) => {
          await assertUserContextInTransaction(client, context);
          await authorizeUpload(client, { realm: "user", id: context.userId, sessionId: context.sessionId }, intentId);
        },
      });
      return;
    }

    const accessMatch = /^\/media\/([^/]+)\/access$/.exec(path);
    if (accessMatch && method === "GET") {
      const context = await readUserContext(request, options);
      const assetId = decodeId(accessMatch[1]!);
      const asset = await loadMediaAsset(options.pool, assetId);
      if (!asset || asset.ownerUserId !== context.userId) throw notFound();
      await sendStoredMedia(response, requestId, options.mediaStorage, asset, "private, no-store");
      return;
    }

    throw notFound();
  });
}

export async function handleSupplyAdminRoute(
  request: SupplyNodeRequest,
  response: SupplyResponse,
  options: SupplyRuntimeOptions,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const { path, query } = requestPath(request, "/api/v1/admin/supply");
  const method = (request.method ?? "GET").toUpperCase();

  await safely(response, requestId, async () => {
    if (!requireOrigin(request, response, options, requestId)) return;
    if (await handlePublishingRoute(request,response,options,requestId,path,query,true)) return;
    const context = await readAdminContext(request, options);
    const actor: WriteActor = { realm: "admin", id: context.userId, sessionId: context.sessionId };

    if (method === "GET") {
      await handleAdminRead(response, options, requestId, path, query, context.userId);
      return;
    }
    if (method !== "POST" && method !== "PUT") throw notFound();
    await handleAdminWrite(request, response, options, requestId, method, path, actor);
  });
}

async function handleAdminRead(
  response: SupplyResponse,
  options: SupplyRuntimeOptions,
  requestId: string,
  path: string,
  query: URLSearchParams,
  adminUserId: string,
): Promise<void> {
  if (path === "/games") {
    const games = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, adminUserId);
      if (!hasPermission(access, ADMIN_PERMISSION.supplyCatalogManage)) requirePermission(access, ADMIN_PERMISSION.supplyGunsmithManage);
      return listGames(client, adminUserId, access.isBoss);
    });
    sendJson(response, 200, games, requestId);
    return;
  }
  const gunsmithReadMatch = /^\/games\/([^/]+)\/(firearms|firearm-classifications)$/.exec(path);
  if (gunsmithReadMatch) {
    const gameId = decodeId(gunsmithReadMatch[1]!);
    const data = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, adminUserId);
      requirePermission(access, ADMIN_PERMISSION.supplyGunsmithManage);
      const result = await listAdminFirearms(client, adminUserId, access.isBoss, gameId);
      return gunsmithReadMatch[2] === "firearms" ? result : { classifications: result.classifications };
    });
    sendJson(response, 200, data, requestId);
    return;
  }
  const catalogMatch = /^\/games\/([^/]+)\/catalog$/.exec(path);
  if (catalogMatch) {
    const gameId = decodeId(catalogMatch[1]!);
    const result = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, adminUserId);
      requirePermission(access, ADMIN_PERMISSION.supplyCatalogManage);
      return readAdminCatalog(client, adminUserId, access.isBoss, gameId);
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  const rulesMatch = /^\/games\/([^/]+)\/rules$/.exec(path);
  if (rulesMatch) {
    const gameId = decodeId(rulesMatch[1]!);
    const result = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, adminUserId);
      requirePermission(access, ADMIN_PERMISSION.supplyRulesEdit);
      return listRules(client, adminUserId, access.isBoss, gameId);
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  // Approved public catalog media usable as a binding option. Scoped to
  // catalog maintenance rather than media review: choosing an image must not
  // require access to the private review queue. The server filters purpose,
  // game, review state and public visibility; clients cannot promote hidden
  // or unapproved media by passing an id. Pagination mirrors /media/reviews;
  // cursors carry the full-precision updated_at rendered in PostgreSQL so the
  // client-side JSON never truncates microseconds.
  const mediaOptionsMatch = /^\/games\/([^/]+)\/media-options$/.exec(path);
  if (mediaOptionsMatch) {
    const mediaGameId = decodeId(mediaOptionsMatch[1]!);
    const purpose = query.get("purpose") ?? null;
    if (purpose !== null && !["GAME_COVER", "SKIN_MEDIA", "ITEM_MEDIA", "FIREARM_MEDIA"].includes(purpose)) throw invalid("Purpose is invalid");
    const limitRaw = query.get("limit");
    const limit = limitRaw === null ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
    const cursorParam = query.get("cursor");
    const result = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, adminUserId);
      if (purpose === "FIREARM_MEDIA" && !hasPermission(access, ADMIN_PERMISSION.supplyCatalogManage)) requirePermission(access, ADMIN_PERMISSION.supplyGunsmithManage);
      else requirePermission(access, ADMIN_PERMISSION.supplyCatalogManage);
      await assertGameScope(client, adminUserId, access.isBoss, mediaGameId);
      let cursorRow: { updatedAt: string; id: string } | undefined;
      if (cursorParam !== null) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(Buffer.from(cursorParam, "base64url").toString("utf8"));
        } catch {
          throw invalid("Cursor is invalid");
        }
        // Guard structure before touching fields: a JSON null or array must
        // not reach property access (would otherwise surface as a 500).
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw invalid("Cursor is invalid");
        const record = decoded as Record<string, unknown>;
        const { v, gameId: cursorGameId, purpose: cursorPurpose, limit: cursorLimit, updatedAt, id } = record;
        if (v !== 1 || cursorGameId !== mediaGameId || (cursorPurpose ?? null) !== purpose || cursorLimit !== limit ||
            typeof updatedAt !== "string" || typeof id !== "string") {
          throw conflict("Cursor does not match the current filters; refresh and retry");
        }
        // Full-precision RFC3339 text from PostgreSQL; anything else must be a
        // controlled client error rather than a cast failure inside the query.
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(updatedAt) || Number.isNaN(Date.parse(updatedAt))) {
          throw invalid("Cursor is invalid");
        }
        // Date.parse normalizes impossible dates (e.g. February 30); PostgreSQL
        // rejects them. Compare calendar fields without truncating the cursor.
        if (updatedAt.startsWith("0000-") || new Date(updatedAt).toISOString().slice(0, 19) !== updatedAt.slice(0, 19)) throw invalid("Cursor is invalid");
        cursorRow = { updatedAt, id };
      }
      const parameters: unknown[] = [mediaGameId, purpose];
      const conditions = [
        `a."game_id" = $1 AND a."ownership_kind" = 'PLATFORM_CATALOG'`,
        `($2::text IS NULL OR a."purpose" = $2)`,
        `a."review_state" = 'APPROVED' AND a."access_class" = 'PUBLIC_DISPLAY' AND a."public_storage_key" IS NOT NULL`,
      ];
      if (cursorRow) {
        parameters.push(cursorRow.updatedAt);
        conditions.push(`(a."updated_at", a."id") < ($${parameters.length}::timestamptz, $${parameters.length + 1})`);
        parameters.push(cursorRow.id);
      }
      parameters.push(limit + 1);
      const rows = (
        await client.query(
          // to_char keeps the PostgreSQL microsecond precision as text; the
          // JSON cursor must never round it to JavaScript Date milliseconds.
          `SELECT a."id", a."game_id" AS "gameId", a."mime", a."width", a."height", a."byte_size"::text AS "byteSize",
                  to_char(a."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
             FROM "zzsh_supply"."media_asset" a
            WHERE ${conditions.join(" AND ")}
            ORDER BY a."updated_at" DESC, a."id" DESC
            LIMIT $${parameters.length}`,
          parameters,
        )
      ).rows;
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1] as { updatedAt: string; id: string } | undefined;
      const nextCursor = hasMore && last
        ? Buffer.from(JSON.stringify({ v: 1, gameId: mediaGameId, purpose, limit, updatedAt: last.updatedAt, id: last.id })).toString("base64url")
        : null;
      return { items, nextCursor, limit };
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  if (path === "/media/reviews") {
    const state = query.get("state") ?? "PENDING";
    const ownershipKind = query.get("ownershipKind") ?? null;
    if (!["PENDING", "APPROVED", "REJECTED", "QUARANTINED"].includes(state)) throw invalid("State is invalid");
    if (ownershipKind !== null && ownershipKind !== "PLATFORM_CATALOG" && ownershipKind !== "USER_SUPPLY") throw invalid("Ownership kind is invalid");
    const limitRaw = query.get("limit");
    const limit = limitRaw === null ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
    const cursor = query.get("cursor");
    const result = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, adminUserId);
      requirePermission(access, ADMIN_PERMISSION.supplyReviewRead);
      let cursorRow: { createdAt: string; id: string } | undefined;
      if (cursor) {
        let decoded: { v?: unknown; state?: unknown; ownershipKind?: unknown; createdAt?: unknown; id?: unknown };
        try {
          decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as typeof decoded;
        } catch {
          throw invalid("Cursor is invalid");
        }
        if (decoded.v !== 1 || decoded.state !== state || (decoded.ownershipKind ?? null) !== ownershipKind || typeof decoded.createdAt !== "string" || typeof decoded.id !== "string") {
          throw conflict("Cursor does not match the current filters; refresh and retry");
        }
        cursorRow = { createdAt: decoded.createdAt, id: decoded.id };
      }
      const parameters: unknown[] = [state];
      const conditions = [`a."review_state" = $1`];
      if (ownershipKind) {
        parameters.push(ownershipKind);
        conditions.push(`a."ownership_kind" = $${parameters.length}`);
      }
      if (!access.isBoss) {
        parameters.push(adminUserId);
        conditions.push(`EXISTS (SELECT 1 FROM "zzsh_supply"."admin_supply_scope" s WHERE s."game_id" = a."game_id" AND s."admin_user_id" = $${parameters.length})`);
      }
      if (cursorRow) {
        parameters.push(cursorRow.createdAt);
        conditions.push(`(a."created_at", a."id") < ($${parameters.length}::timestamptz, $${parameters.length + 1})`);
        parameters.push(cursorRow.id);
      }
      parameters.push(limit + 1);
      const rows = await client.query(
        `SELECT a."id", a."game_id" AS "gameId", a."purpose", a."ownership_kind" AS "ownershipKind", a."owner_user_id" AS "ownerUserId",
                a."uploaded_by_realm" AS "uploadedByRealm", a."uploaded_by_user_id" AS "uploadedByUserId", a."uploaded_by_admin_id" AS "uploadedByAdminId",
                a."content_hash" AS "contentHash", a."mime", a."byte_size"::text AS "byteSize", a."width", a."height",
                a."access_class" AS "accessClass", a."review_state" AS "reviewState", a."review_reason" AS "reviewReason", a."created_at" AS "createdAt"
           FROM "zzsh_supply"."media_asset" a
          WHERE ${conditions.join(" AND ")}
          ORDER BY a."created_at" DESC, a."id" DESC
          LIMIT $${parameters.length}`,
        parameters,
      );
      const hasMore = rows.rows.length > limit;
      const items = hasMore ? rows.rows.slice(0, limit) : rows.rows;
      const last = items[items.length - 1] as { createdAt: string; id: string } | undefined;
      const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ v: 1, state, ownershipKind, createdAt: last.createdAt, id: last.id })).toString("base64url") : null;
      return { items, nextCursor, limit };
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  const contentMatch = /^\/media\/([^/]+)\/content$/.exec(path);
  if (contentMatch) {
    const assetId = decodeId(contentMatch[1]!);
    const asset = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, adminUserId);
      requirePermission(access, ADMIN_PERMISSION.supplyReviewRead);
      const row = await loadMediaAsset(client, assetId);
      if (!row || row.gameId === null) throw notFound();
      await assertGameScope(client, adminUserId, access.isBoss, row.gameId);
      return row;
    });
    await sendStoredMedia(response, requestId, options.mediaStorage, asset, "private, no-store");
    return;
  }
  throw notFound();
}

async function handleAdminWrite(
  request: SupplyNodeRequest,
  response: SupplyResponse,
  options: SupplyRuntimeOptions,
  requestId: string,
  method: "POST" | "PUT",
  path: string,
  actor: WriteActor,
): Promise<void> {
  const fail = (): never => {
    throw notFound();
  };
  const write = async (
    operation: string,
    resourceId: string | undefined,
    permission: string,
    gameIdResolver: (client: PoolClient) => Promise<string | undefined>,
    action: (client: PoolClient, access: EffectiveAdminAccess, gameId: string) => Promise<{ status: number; body: unknown; details?: Record<string, unknown> }>,
    auditAction?: string,
  ): Promise<void> => {
    const fingerprintBody = request.body;
    await runIdempotentWrite(
      options,
      request,
      response,
      requestId,
      { principalId: actor.id, operation, ...(resourceId ? { resourceId } : {}) },
      actor,
      fingerprintBody,
      async (client) => {
        await assertAdminContextInTransaction(client, {userId:actor.id,sessionId:actor.sessionId});
        const access = await requireAdminAccess(client, actor.id);
        requirePermission(access, permission);
        const gameId = await gameIdResolver(client);
        if (gameId) await assertGameScope(client, actor.id, access.isBoss, gameId);
      },
      async (client) => {
        const access = await requireAdminAccess(client, actor.id);
        requirePermission(access, permission);
        const gameId = await gameIdResolver(client);
        const objectType = auditObjectType(operation);
        const before = resourceId && !operation.endsWith(".create")
          ? await auditSnapshot(client, objectType === "rule_release" ? "game" : objectType, resourceId) : null;
        const result = await action(client, access, gameId ?? "");
        if (auditAction) {
          const body = result.body as Record<string, unknown>;
          const objectId = String(body.id ?? body.releaseId ?? body.intentId ?? (body.game as { id?: string } | undefined)?.id ?? resourceId);
          const after = await auditSnapshot(client, objectType, objectId);
          await recordAudit(client, {
            actorType: "admin",
            actorId: actor.id,
            sessionId: actor.sessionId,
            action: auditAction,
            objectType,
            objectId,
            outcome: "SUCCESS",
            requestId,
            reason: typeof (request.body as Record<string, unknown>)?.reason === "string" ? (request.body as Record<string, string>).reason! : operation,
            details: { operation, gameId: gameId ?? objectId, before, after, result: "APPLIED" },
          });
        }
        return { status: result.status, body: result.body };
      },
    );
  };

  const serviceMatch = /^\/games\/([^/]+)\/services\/(ACCOUNT_RENTAL|GUNSMITH)$/.exec(path);
  if (serviceMatch && method === "PUT") {
    const gameId = decodeId(serviceMatch[1]!);
    const serviceCode = serviceMatch[2] as GameServiceCode;
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "enabled"]);
    const enabled = body.enabled;
    if (typeof enabled !== "boolean") throw invalid("Enabled is required");
    parseExpectedRevision(body);
    const serviceId = `${gameId}:service:${serviceCode}`;
    await write(
      "supply.game_service.update",
      serviceId,
      serviceCode === GAME_SERVICE.ACCOUNT_RENTAL ? ADMIN_PERMISSION.supplyRulesActivate : ADMIN_PERMISSION.supplyGunsmithManage,
      async (client) => {
        await assertGameExists(client, gameId);
        await ensureGameServiceRows(client, gameId);
        return gameId;
      },
      async (client) => {
        const game = (await client.query<{ code: string }>(`SELECT "code" FROM "zzsh_supply"."game" WHERE "id"=$1`, [gameId])).rows[0];
        if (!game) throw notFound();
        if (enabled && !isSupportedGameService(game.code, serviceCode)) throw unsupportedGameService();
        const result = await client.query<{ id: string; gameId: string; serviceCode: GameServiceCode; enabled: boolean; revision: string }>(
          `UPDATE "zzsh_supply"."game_service_operation" SET "enabled"=$1,"revision"="revision"+1,"updated_at"=clock_timestamp() WHERE "id"=$2 AND "revision"::text=$3 RETURNING "id","game_id" AS "gameId","service_code" AS "serviceCode","enabled","revision"::text AS "revision"`,
          [enabled, serviceId, body.expectedRevision],
        );
        if (result.rowCount !== 1) throw conflict("Service status changed; refresh and retry");
        return { status: 200, body: { service: { ...result.rows[0], supported: isSupportedGameService(game.code, serviceCode) } } };
      },
      "supply.game_service.updated",
    );
    return;
  }

  const classificationCreateMatch = /^\/games\/([^/]+)\/firearm-classifications$/.exec(path);
  if (classificationCreateMatch && method === "POST") {
    const gameId = decodeId(classificationCreateMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["code", "name", "enabled", "sortOrder", "sourceNamespace", "sourceToken", "sourceNote"]);
    await write("supply.gunsmith.classification.create", undefined, ADMIN_PERMISSION.supplyGunsmithManage, async () => gameId, async (client, access) => ({ status: 200, body: await createClassification(client, actor.id, access.isBoss, gameId, body) }), "supply.gunsmith.classification.created");
    return;
  }
  const classificationUpdateMatch = /^\/firearm-classifications\/([^/]+)$/.exec(path);
  if (classificationUpdateMatch && method === "PUT") {
    const id = decodeId(classificationUpdateMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "name", "enabled", "sortOrder"]);
    parseExpectedRevision(body);
    await write("supply.gunsmith.classification.update", id, ADMIN_PERMISSION.supplyGunsmithManage, async (client) => {
      const row = (await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."firearm_classification" WHERE "id"=$1`, [id])).rows[0];
      if (!row) throw notFound();
      return row.gameId;
    }, async (client, access) => ({ status: 200, body: await updateClassification(client, actor.id, access.isBoss, id, body) }), "supply.gunsmith.classification.updated");
    return;
  }

  const firearmCreateMatch = /^\/games\/([^/]+)\/firearms$/.exec(path);
  if (firearmCreateMatch && method === "POST") {
    const gameId = decodeId(firearmCreateMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["code", "name", "classificationId", "enabled", "sortOrder", "mediaId", "sourceNamespace", "sourceToken", "sourceNote"]);
    await write("supply.gunsmith.firearm.create", undefined, ADMIN_PERMISSION.supplyGunsmithManage, async () => gameId, async (client, access) => ({ status: 200, body: await createFirearm(client, actor.id, access.isBoss, gameId, body) }), "supply.gunsmith.firearm.created");
    return;
  }
  const firearmUpdateMatch = /^\/firearms\/([^/]+)$/.exec(path);
  if (firearmUpdateMatch && method === "PUT") {
    const id = decodeId(firearmUpdateMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "name", "classificationId", "enabled", "sortOrder", "mediaId"]);
    parseExpectedRevision(body);
    await write("supply.gunsmith.firearm.update", id, ADMIN_PERMISSION.supplyGunsmithManage, async (client) => {
      const row = (await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."firearm" WHERE "id"=$1`, [id])).rows[0];
      if (!row) throw notFound();
      return row.gameId;
    }, async (client, access) => ({ status: 200, body: await updateFirearm(client, actor.id, access.isBoss, id, body) }), "supply.gunsmith.firearm.updated");
    return;
  }

  const aliasCreateMatch = /^\/games\/([^/]+)\/firearms\/([^/]+)\/aliases$/.exec(path);
  if (aliasCreateMatch && method === "POST") {
    const gameId = decodeId(aliasCreateMatch[1]!);
    const firearmId = decodeId(aliasCreateMatch[2]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["locale", "name", "enabled", "sortOrder", "sourceNamespace", "sourceToken", "sourceNote"]);
    await write("supply.gunsmith.alias.create", undefined, ADMIN_PERMISSION.supplyGunsmithManage, async () => gameId, async (client, access) => ({ status: 200, body: await createAlias(client, actor.id, access.isBoss, gameId, firearmId, body) }), "supply.gunsmith.alias.created");
    return;
  }
  const aliasUpdateMatch = /^\/firearm-aliases\/([^/]+)$/.exec(path);
  if (aliasUpdateMatch && method === "PUT") {
    const id = decodeId(aliasUpdateMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "name", "enabled", "sortOrder"]);
    parseExpectedRevision(body);
    await write("supply.gunsmith.alias.update", id, ADMIN_PERMISSION.supplyGunsmithManage, async (client) => {
      const row = (await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."firearm_alias" WHERE "id"=$1`, [id])).rows[0];
      if (!row) throw notFound();
      return row.gameId;
    }, async (client, access) => ({ status: 200, body: await updateAlias(client, actor.id, access.isBoss, id, body) }), "supply.gunsmith.alias.updated");
    return;
  }

  if (path === "/gunsmith/codes" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["gameId", "firearmId", "code", "note", "modeCode", "lastReviewedAt", "sourceNamespace", "sourceToken", "sourceNote"]);
    const gameId = decodeId(requiredString(body, "gameId", 128));
    const firearmId = decodeId(requiredString(body, "firearmId", 128));
    await write("supply.gunsmith.code.create", undefined, ADMIN_PERMISSION.supplyGunsmithManage, async () => gameId, async (client, access) => ({ status: 200, body: await createGunsmithCode(client, actor.id, access.isBoss, { ...body, gameId, firearmId }) }), "supply.gunsmith.code.created");
    return;
  }
  const codeUpdateMatch = /^\/gunsmith\/codes\/([^/]+)$/.exec(path);
  if (codeUpdateMatch && method === "PUT") {
    const id = decodeId(codeUpdateMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "code", "note", "modeCode", "lastReviewedAt"]);
    parseExpectedRevision(body);
    await write("supply.gunsmith.code.update", id, ADMIN_PERMISSION.supplyGunsmithManage, async (client) => {
      const row = (await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."gunsmith_code" WHERE "id"=$1`, [id])).rows[0];
      if (!row) throw notFound();
      return row.gameId;
    }, async (client, access) => ({ status: 200, body: await updateGunsmithCode(client, actor.id, access.isBoss, id, body) }), "supply.gunsmith.code.updated");
    return;
  }
  const codeStatusMatch = /^\/gunsmith\/codes\/([^/]+)\/(withdraw|restore)$/.exec(path);
  if (codeStatusMatch && method === "POST") {
    const id = decodeId(codeStatusMatch[1]!);
    const status = codeStatusMatch[2] === "restore" ? "ACTIVE" : "WITHDRAWN";
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision"]);
    parseExpectedRevision(body);
    await write(`supply.gunsmith.code.${codeStatusMatch[2]}`, id, ADMIN_PERMISSION.supplyGunsmithManage, async (client) => {
      const row = (await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."gunsmith_code" WHERE "id"=$1`, [id])).rows[0];
      if (!row) throw notFound();
      return row.gameId;
    }, async (client, access) => ({ status: 200, body: await setGunsmithCodeStatus(client, actor.id, access.isBoss, id, status, body) }), status === "ACTIVE" ? "supply.gunsmith.code.restored" : "supply.gunsmith.code.withdrawn");
    return;
  }

  if (path === "/games" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["code", "name", "description"]);
    await write(
      "supply.game.create",
      undefined,
      ADMIN_PERMISSION.supplyCatalogManage,
      async () => undefined,
      async (client, access) => {
        const game = await createGame(client, access.isBoss, body);
        return { status: 200, body: { game }, details: { code: game.code } };
      },
      "supply.game.created",
    );
    return;
  }
  const gameMatch = /^\/games\/([^/]+)$/.exec(path);
  if (gameMatch && method === "PUT") {
    const gameId = decodeId(gameMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "name", "description", "enabled"]);
    parseExpectedRevision(body);
    await write("supply.game.update", gameId, ADMIN_PERMISSION.supplyCatalogManage, async () => gameId, async (client, access) => {
      await updateGame(client, actor.id, access.isBoss, gameId, body);
      return { status: 200, body: { gameId } };
    }, "supply.game.updated");
    return;
  }
  const coverMatch = /^\/games\/([^/]+)\/cover$/.exec(path);
  if (coverMatch && method === "PUT") {
    const gameId = decodeId(coverMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["mediaId"]);
    await write("supply.game.cover", gameId, ADMIN_PERMISSION.supplyCatalogManage, async () => gameId, async (client, access) => {
      await bindGameCover(client, actor.id, access.isBoss, gameId, body);
      return { status: 200, body: { gameId } };
    }, "supply.catalog.cover_bound");
    return;
  }
  const createEntryMatch = /^\/games\/([^/]+)\/(items|rarities|categories|skins|entitlements)$/.exec(path);
  if (createEntryMatch && method === "POST") {
    const gameId = decodeId(createEntryMatch[1]!);
    const kind = catalogKind(createEntryMatch[2]!);
    const body = bodyOf(request);
    await write(`supply.catalog.${kind}.create`, gameId, ADMIN_PERMISSION.supplyCatalogManage, async () => gameId, async (client, access) => {
      const entry = await createCatalogEntry(client, actor.id, access.isBoss, kind, gameId, body);
      return { status: 200, body: entry, details: { kind } };
    }, "supply.catalog.entry_created");
    return;
  }
  const updateEntryMatch = /^\/(items|rarities|categories|skins|entitlements)\/([^/]+)$/.exec(path);
  if (updateEntryMatch && method === "PUT") {
    const kind = catalogKind(updateEntryMatch[1]!);
    const entryId = decodeId(updateEntryMatch[2]!);
    const body = bodyOf(request);
    await write(`supply.catalog.${kind}.update`, entryId, ADMIN_PERMISSION.supplyCatalogManage, async (client) => {
      const found = await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."${TABLE_BY_KIND[kind]}" WHERE "id" = $1`, [entryId]);
      if (!found.rows[0]) throw notFound();
      return found.rows[0].gameId;
    }, async (client, access) => {
      const result = await updateCatalogEntry(client, actor.id, access.isBoss, kind, entryId, body);
      return { status: 200, body: { id: entryId }, details: { kind, gameId: result.gameId } };
    }, "supply.catalog.entry_updated");
    return;
  }
  if (path === "/price-drafts" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["gameId", "mode"]);
    const gameId = decodeId(requiredString(body, "gameId", 128));
    await write("supply.rules.price_draft.create", undefined, ADMIN_PERMISSION.supplyRulesEdit, async () => gameId, async (client, access) => {
      const draft = await createPriceDraft(client, actor.id, access.isBoss, gameId, body.mode);
      return { status: 200, body: draft };
    }, "supply.rules.price_draft_created");
    return;
  }
  const priceUpdateMatch = /^\/price-drafts\/([^/]+)$/.exec(path);
  if (priceUpdateMatch && method === "PUT") {
    const versionId = decodeId(priceUpdateMatch[1]!);
    const body = bodyOf(request);
    await write("supply.rules.price_draft.update", versionId, ADMIN_PERMISSION.supplyRulesEdit, async (client) => {
      const found = await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."price_version" WHERE "id" = $1`, [versionId]);
      if (!found.rows[0]) throw notFound();
      return found.rows[0].gameId;
    }, async (client, access) => {
      await updatePriceDraft(client, actor.id, access.isBoss, versionId, body);
      return { status: 200, body: { id: versionId } };
    }, "supply.rules.price_draft_updated");
    return;
  }
  const sealMatch = /^\/(price|term|agreement)-drafts\/([^/]+)\/seal$/.exec(path);
  if (sealMatch && method === "POST") {
    const versionId = decodeId(sealMatch[2]!);
    const table = sealMatch[1] === "price" ? "price_version" : sealMatch[1] === "term" ? "term_version" : "agreement_version";
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision"]);
    await write(`supply.rules.${sealMatch[1]}_draft.seal`, versionId, ADMIN_PERMISSION.supplyRulesEdit, async (client) => {
      const found = await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."${table}" WHERE "id" = $1`, [versionId]);
      if (!found.rows[0]) throw notFound();
      return found.rows[0].gameId;
    }, async (client, access) => {
      await sealVersion(client, actor.id, access.isBoss, table, versionId, body.expectedRevision);
      return { status: 200, body: { id: versionId, status: "SEALED" } };
    }, `supply.rules.${sealMatch[1]}_draft_sealed`);
    return;
  }
  if (path === "/term-drafts" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["gameId"]);
    const gameId = decodeId(requiredString(body, "gameId", 128));
    await write("supply.rules.term_draft.create", undefined, ADMIN_PERMISSION.supplyRulesEdit, async () => gameId, async (client, access) => {
      const draft = await createTermDraft(client, actor.id, access.isBoss, gameId);
      return { status: 200, body: draft };
    }, "supply.rules.term_draft_created");
    return;
  }
  const termUpdateMatch = /^\/term-drafts\/([^/]+)$/.exec(path);
  if (termUpdateMatch && method === "PUT") {
    const versionId = decodeId(termUpdateMatch[1]!);
    const body = bodyOf(request);
    await write("supply.rules.term_draft.update", versionId, ADMIN_PERMISSION.supplyRulesEdit, async (client) => {
      const found = await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."term_version" WHERE "id" = $1`, [versionId]);
      if (!found.rows[0]) throw notFound();
      return found.rows[0].gameId;
    }, async (client, access) => {
      await updateTermDraft(client, actor.id, access.isBoss, versionId, body);
      return { status: 200, body: { id: versionId } };
    }, "supply.rules.term_draft_updated");
    return;
  }
  if (path === "/agreement-drafts" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["gameId", "title", "body"]);
    const gameId = decodeId(requiredString(body, "gameId", 128));
    const title = requiredString(body, "title", 120);
    const agreementBody = requiredString(body, "body", 20_001);
    await write("supply.rules.agreement_draft.create", undefined, ADMIN_PERMISSION.supplyRulesEdit, async () => gameId, async (client, access) => {
      const draft = await createAgreementDraft(client, actor.id, access.isBoss, gameId, title, agreementBody);
      return { status: 200, body: draft };
    }, "supply.rules.agreement_draft_created");
    return;
  }
  const agreementUpdateMatch = /^\/agreement-drafts\/([^/]+)$/.exec(path);
  if (agreementUpdateMatch && method === "PUT") {
    const versionId = decodeId(agreementUpdateMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "title", "body"]);
    await write("supply.rules.agreement_draft.update", versionId, ADMIN_PERMISSION.supplyRulesEdit, async (client) => {
      const found = await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."agreement_version" WHERE "id" = $1`, [versionId]);
      if (!found.rows[0]) throw notFound();
      return found.rows[0].gameId;
    }, async (client, access) => {
      await updateAgreementDraft(client, actor.id, access.isBoss, versionId, body);
      return { status: 200, body: { id: versionId } };
    }, "supply.rules.agreement_draft_updated");
    return;
  }
  if (path === "/quote-preview" && method === "POST") {
    const body = bodyOf(request);
    const result = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.supplyRulesEdit);
      requirePermission(access, ADMIN_PERMISSION.supplyQuoteInternalRead);
      return quotePreview(client, actor.id, access.isBoss, body);
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  if (path === "/releases" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["gameId", "priceVersionId", "termVersionId", "agreementVersionId", "expectedGeneration"]);
    const gameId = decodeId(requiredString(body, "gameId", 128));
    const priceVersionId = decodeId(requiredString(body, "priceVersionId", 128));
    const termVersionId = decodeId(requiredString(body, "termVersionId", 128));
    const agreementVersionId = decodeId(requiredString(body, "agreementVersionId", 128));
    await write(
      "supply.rules.release.activate",
      gameId,
      ADMIN_PERMISSION.supplyRulesActivate,
      async () => gameId,
      async (client, access) => {
        const result = await activateRelease(client, actor.id, access.isBoss, gameId, priceVersionId, termVersionId, agreementVersionId, requiredString(body, "expectedGeneration", 20));
        return { status: 200, body: result, details: { releaseId: result.releaseId, generation: result.generation, affectedCount: result.affectedCount } };
      },
      "supply.rules.release_activated",
    );
    return;
  }
  if (path === "/media/upload-intents" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["gameId", "purpose", "mime", "size"]);
    const gameId = decodeId(requiredString(body, "gameId", 128));
    const purpose = requiredString(body, "purpose", 64);
    const mime = requiredString(body, "mime", 64);
    const size = optionalInteger(body, "size", 1, 10 * 1024 * 1024);
    if (size === undefined) throw invalid("Size is required");
    if (!options.mediaStorage.available) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Media storage is not configured");
    await write("supply.media.upload_intent.create", undefined, ADMIN_PERMISSION.supplyCatalogManage, async () => gameId, async (client) => {
      const intent = await createMediaUploadIntent(client, { realm: "admin", adminUserId: actor.id }, { gameId, purpose, mime, size });
      return { status: 200, body: { intentId: intent.intentId, uploadToken: intent.uploadToken, expiresAt: intent.expiresAt }, details: { gameId, purpose } };
    }, "supply.media.upload_intent_created");
    return;
  }
  const adminUploadMatch = /^\/media\/uploads\/([^/]+)$/.exec(path);
  if (adminUploadMatch && method === "PUT") {
    const intentId = decodeId(adminUploadMatch[1]!);
    const uploadToken = headerValue(request.headers["x-upload-token"]);
    if (!uploadToken) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Upload token is invalid");
    const bytes = await readRawBody(request, 10 * 1024 * 1024);
    await runMediaUpload(options, request, response, requestId, {
      actor,
      mediaActor: { realm: "admin", adminUserId: actor.id },
      intentId,
      uploadToken,
      bytes,
      authorize: async (client) => {
        await assertAdminContextInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
        await authorizeUpload(client, actor, intentId);
      },
      beforeFinalize: async (client) => {
        const access = await requireAdminAccess(client, actor.id);
        requirePermission(access, ADMIN_PERMISSION.supplyCatalogManage);
      },
    });
    return;
  }
  const reviewMatch = /^\/media\/([^/]+)\/review$/.exec(path);
  if (reviewMatch && method === "POST") {
    const assetId = decodeId(reviewMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["decision", "reason", "visibility"]);
    const decision = requiredString(body, "decision", 16);
    const reason = optionalTrimmedString(body, "reason", 500);
    const visibility = optionalString(body, "visibility", 32);
    await write("supply.media.review", assetId, ADMIN_PERMISSION.supplyReviewDecide, async (client) => {
      const row = await loadMediaAsset(client, assetId);
      if (!row || row.gameId === null) throw notFound();
      return row.gameId;
    }, async (client, access) => {
      const asset = await reviewMediaAsset(client, actor.id, access.isBoss, assetId, {
        decision,
        ...(reason ? { reason } : {}),
        ...(visibility ? { visibility } : {}),
      });
      return { status: 200, body: asset, details: { reviewState: asset.reviewState, accessClass: asset.accessClass } };
    }, "supply.media.reviewed");
    return;
  }
  const visibilityMatch = /^\/media\/([^/]+)\/visibility$/.exec(path);
  if (visibilityMatch && method === "POST") {
    const assetId = decodeId(visibilityMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["visibility", "reason"]);
    const visibility = requiredString(body, "visibility", 32);
    const reason = optionalTrimmedString(body, "reason", 500);
    await write("supply.media.visibility", assetId, ADMIN_PERMISSION.supplyReviewDecide, async (client) => {
      const row = await loadMediaAsset(client, assetId);
      if (!row || row.gameId === null) throw notFound();
      return row.gameId;
    }, async (client, access) => {
      const asset = await changeMediaVisibility(client, actor.id, access.isBoss, assetId, { visibility, ...(reason ? { reason } : {}) });
      return { status: 200, body: asset, details: { accessClass: asset.accessClass } };
    }, "supply.media.visibility_changed");
    return;
  }
  fail();
}

const TABLE_BY_KIND = {
  items: "billable_item",
  rarities: "skin_rarity",
  categories: "skin_category",
  skins: "skin",
  entitlements: "entitlement",
} as const;

export function mountSupplyHandlers(app: INestApplication, options: SupplyRuntimeOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: SupplyNodeRequest, response: SupplyResponse) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/supply", (request, response) => handleSupplyUserRoute(request, response, options));
  expressApp.use("/api/v1/admin/supply", (request, response) => handleSupplyAdminRoute(request, response, options));
}
