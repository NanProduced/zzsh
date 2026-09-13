import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";

import { ADMIN_PERMISSION, loadEffectiveAdminAccess, requirePermission, type EffectiveAdminAccess } from "../auth/admin-authorization";
import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "../auth/auth-security";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "../auth/security-core";
import { API_V1_ERROR_CODES, ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { auditSnapshot } from "../supply/supply-audit";
import {
  decodeId,
  mapDatabaseError,
  readRawBody,
  requestPath,
  requireAdminAccess,
  requireOrigin,
  runIdempotentWrite,
  runMediaUpload,
  sendStoredMedia,
  type SupplyRuntimeOptions,
  type SupplyResponse as BaseSupplyResponse,
  type WriteActor,
} from "../supply/supply-routes";
import { createMediaUploadIntent, loadMediaAsset, reviewMediaAsset, changeMediaVisibility } from "../supply/media";
import {
  assertGameScope,
  bodyOf,
  ensureOnlyFields,
  fingerprintRequest,
  headerValue,
  invalid,
  notFound,
  optionalBoolean,
  optionalInteger,
  optionalTrimmedString,
  parseExpectedRevision,
  requiredString,
  sendError,
  sendInternalError,
  sendJson,
  type IdempotencyReplay,
  type SupplyNodeRequest,
} from "../supply/supply-util";
import {
  CAROUSEL_SLOTS,
  carouselCreateRequiresPublish,
  carouselUpdateRequiresPublish,
  createCarouselItem,
  createContentDraftFromLatest,
  createContentItem,
  getPublicContentItem,
  isCarouselSlot,
  isContentType,
  itemScope,
  listAdminCarousel,
  listAdminContentItems,
  listContentMedia,
  listContentMediaOptions,
  listPublicCarousel,
  listPublicContentItems,
  loadCarouselItem,
  loadContentItem,
  loadContentVersions,
  parseRfc3339Timestamp,
  publishContentVersion,
  saveContentDraft,
  updateCarouselItem,
  updateContentItemMeta,
  withdrawContentVersion,
  type CarouselInput,
  type ContentItemRow,
  type DraftInput,
} from "./content";

export type ContentRuntimeOptions = SupplyRuntimeOptions;
type ContentResponse = BaseSupplyResponse & { send?: (body: Buffer | string) => void };

type ContentAction = "read" | "edit" | "publish";

function scopePermission(platform: boolean, action: ContentAction): string {
  if (platform) return { read: ADMIN_PERMISSION.contentPlatformRead, edit: ADMIN_PERMISSION.contentPlatformEdit, publish: ADMIN_PERMISSION.contentPlatformPublish }[action];
  return { read: ADMIN_PERMISSION.contentRead, edit: ADMIN_PERMISSION.contentEdit, publish: ADMIN_PERMISSION.contentPublish }[action];
}

async function authorizeItem(client: PoolClient, actor: WriteActor, action: ContentAction, item: ContentItemRow): Promise<EffectiveAdminAccess> {
  const access = await requireAdminAccess(client, actor.id);
  const scope = itemScope(item);
  requirePermission(access, scopePermission(scope.platform, action));
  if (!scope.platform) await assertGameScope(client, actor.id, access.isBoss, scope.gameId);
  return access;
}

async function authorizeItemId(client: PoolClient, actor: WriteActor, action: ContentAction, itemId: string): Promise<ContentItemRow> {
  const item = await loadContentItem(client, itemId);
  if (!item) throw notFound();
  await authorizeItem(client, actor, action, item);
  return item;
}

function parseLimit(query: URLSearchParams, fallback = 20): number {
  const raw = query.get("limit");
  const limit = raw === null ? fallback : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
  return limit;
}

function optionalText(body: Record<string, unknown>, field: string, maxLength: number, maxBytes?: number): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw invalid(`${field} is invalid`);
  if (maxBytes !== undefined && Buffer.byteLength(value, "utf8") > maxBytes) throw invalid(`${field} is invalid`);
  return value;
}

function decodeCursor(cursorParam: string, predicate: (record: Record<string, unknown>) => boolean): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursorParam, "base64url").toString("utf8"));
  } catch {
    throw invalid("Cursor is invalid");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw invalid("Cursor is invalid");
  const record = decoded as Record<string, unknown>;
  if (record.v !== 1 || !predicate(record)) throw conflict("Cursor does not match the current filters; refresh and retry");
  return record;
}

function conflict(message: string): SecurityApiError {
  return new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, message);
}

function readCursorTimestamp(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) || Number.isNaN(Date.parse(value))) throw invalid("Cursor is invalid");
  try {
    parseRfc3339Timestamp(value, field);
  } catch {
    throw invalid("Cursor is invalid");
  }
  return value;
}

function readCursorId(record: Record<string, unknown>): string {
  const value = record.id;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw invalid("Cursor is invalid");
  return value;
}

async function safely(response: ContentResponse, requestId: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
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

function versionSnapshotFields(table: "content_item" | "content_version" | "carousel_item"): string {
  if (table === "content_item") return `"id", "type", "game_id" AS "gameId", "sort_order" AS "sortOrder", "revision"::text AS "revision"`;
  if (table === "content_version") {
    return `"id", "item_id" AS "itemId", "sequence", "state", "title", "summary", "cover_media_id" AS "coverMediaId",
      octet_length("body") AS "bodyBytes", "revision"::text AS "revision", "published_at" AS "publishedAt"`;
  }
  return `"id", "slot_code" AS "slotCode", "media_id" AS "mediaId", "image_alt" AS "imageAlt", "title", "description",
    "link_url" AS "linkUrl", "enabled", "sort_order" AS "sortOrder", "starts_at" AS "startsAt", "ends_at" AS "endsAt", "revision"::text AS "revision"`;
}

async function contentSnapshot(client: PoolClient, table: "content_item" | "content_version" | "carousel_item", id: string): Promise<Record<string, unknown> | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${versionSnapshotFields(table)} FROM "zzsh_content"."${table}" WHERE "id" = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function auditContent(
  client: PoolClient,
  input: {
    actor: WriteActor;
    requestId: string;
    action: string;
    objectType: string;
    objectId: string;
    scope: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    result: string;
  },
): Promise<void> {
  await recordAudit(client, {
    actorType: "admin",
    actorId: input.actor.id,
    sessionId: input.actor.sessionId,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    outcome: "SUCCESS",
    requestId: input.requestId,
    reason: input.action,
    details: { scope: input.scope, before: input.before, after: input.after, result: input.result },
  });
}

function itemScopeLabel(item: ContentItemRow): string {
  return item.gameId === null ? "platform" : item.gameId;
}

// ---------------------------------------------------------------------------
// Public routes: /api/v1/content
// ---------------------------------------------------------------------------

const PUBLIC_CACHE = "no-store";

export async function handleContentPublicRoute(
  request: SupplyNodeRequest,
  response: ContentResponse,
  options: ContentRuntimeOptions,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const { path, query } = requestPath(request, "/api/v1/content");
  const method = (request.method ?? "GET").toUpperCase();

  await safely(response, requestId, async () => {
    if (method !== "GET") throw notFound();
    if (path === "/items") {
      const type = query.get("type");
      if (type !== null && !isContentType(type)) throw invalid("Type is invalid");
      const gameId = query.get("gameId");
      if (gameId !== null) decodeId(gameId);
      const limit = parseLimit(query);
      const cursorParam = query.get("cursor");
      let cursor: { sortOrder: number; publishedAt: string; id: string } | null = null;
      if (cursorParam !== null) {
        const record = decodeCursor(cursorParam, (value) =>
          value.type === (type ?? null) && value.gameId === (gameId ?? null) && value.limit === limit);
        if (!Number.isInteger(record.sortOrder)) throw invalid("Cursor is invalid");
        cursor = { sortOrder: record.sortOrder as number, publishedAt: readCursorTimestamp(record, "publishedAt"), id: readCursorId(record) };
      }
      const result = await withTransaction(options.pool, (client) => listPublicContentItems(client, { ...(type ? { type } : {}), ...(gameId ? { gameId } : {}) }, limit, cursor));
      sendJson(response, 200, result, requestId, PUBLIC_CACHE);
      return;
    }
    const itemMatch = /^\/items\/([^/]+)$/.exec(path);
    if (itemMatch) {
      const itemId = decodeId(itemMatch[1]!);
      const item = await withTransaction(options.pool, (client) => getPublicContentItem(client, itemId));
      if (!item) throw notFound();
      sendJson(response, 200, item, requestId, PUBLIC_CACHE);
      return;
    }
    if (path === "/carousel") {
      const slotRaw = query.get("slot") ?? "HOME_HERO";
      if (!isCarouselSlot(slotRaw)) throw invalid("Slot is invalid");
      const limit = parseLimit(query, 50);
      const items = (await withTransaction(options.pool, (client) => listPublicCarousel(client, slotRaw, limit))).map((item) => ({
        ...item,
        mediaUrl: `/api/v1/content/media/${encodeURIComponent(String(item.mediaId))}/content`,
      }));
      sendJson(response, 200, { items, limit }, requestId, PUBLIC_CACHE);
      return;
    }
    const mediaMatch = /^\/media\/([^/]+)\/content$/.exec(path);
    if (mediaMatch) {
      const assetId = decodeId(mediaMatch[1]!);
      const asset = await loadMediaAsset(options.pool, assetId);
      if (!asset || asset.ownershipKind !== "PLATFORM_CONTENT" || asset.purpose !== "CONTENT_MEDIA" || asset.reviewState !== "APPROVED" || asset.accessClass !== "PUBLIC_DISPLAY" || !asset.publicStorageKey) throw notFound();
      await sendStoredMedia(response, requestId, options.mediaStorage, { ...asset, storageKey: asset.publicStorageKey, contentHash: asset.publicStorageKey }, "public, max-age=0, must-revalidate");
      return;
    }
    throw notFound();
  });
}

// ---------------------------------------------------------------------------
// Admin routes: /api/v1/admin/content
// ---------------------------------------------------------------------------

export async function handleContentAdminRoute(
  request: SupplyNodeRequest,
  response: ContentResponse,
  options: ContentRuntimeOptions,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const { path, query } = requestPath(request, "/api/v1/admin/content");
  const method = (request.method ?? "GET").toUpperCase();

  await safely(response, requestId, async () => {
    if (!requireOrigin(request, response, options, requestId)) return;
    const context = await readAdminContext(request, options);
    const actor: WriteActor = { realm: "admin", id: context.userId, sessionId: context.sessionId };
    if (method === "GET") {
      await handleAdminRead(response, options, requestId, path, query, actor);
      return;
    }
    if (method !== "POST" && method !== "PUT") throw notFound();
    await handleAdminWrite(request, response, options, requestId, method, path, actor);
  });
}

async function handleAdminRead(
  response: ContentResponse,
  options: ContentRuntimeOptions,
  requestId: string,
  path: string,
  query: URLSearchParams,
  actor: WriteActor,
): Promise<void> {
  if (path === "/items") {
    const scope = query.get("scope");
    if (scope !== "platform" && scope !== "game") throw invalid("Scope is required");
    const type = query.get("type");
    if (type !== null && !isContentType(type)) throw invalid("Type is invalid");
    const gameIdRaw = query.get("gameId");
    if (scope === "game" && gameIdRaw === null) throw invalid("gameId is required for game scope");
    const gameId = gameIdRaw === null ? undefined : decodeId(gameIdRaw);
    if (scope === "platform" && gameId !== undefined) throw invalid("Platform scope does not accept gameId");
    const limit = parseLimit(query);
    const cursorParam = query.get("cursor");
    const result = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      if (scope === "platform") requirePermission(access, ADMIN_PERMISSION.contentPlatformRead);
      else {
        requirePermission(access, ADMIN_PERMISSION.contentRead);
        await assertGameScope(client, actor.id, access.isBoss, gameId!);
      }
      let cursor: { updatedAt: string; id: string } | null = null;
      if (cursorParam !== null) {
        const record = decodeCursor(cursorParam, (value) =>
          value.type === (type ?? null) && value.scope === scope && value.gameId === (gameId ?? null) && value.limit === limit);
        cursor = { updatedAt: readCursorTimestamp(record, "updatedAt"), id: readCursorId(record) };
      }
      return listAdminContentItems(client, { ...(type ? { type } : {}), scope, ...(gameId ? { gameId } : {}) }, limit, cursor);
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  const itemMatch = /^\/items\/([^/]+)$/.exec(path);
  if (itemMatch) {
    const itemId = decodeId(itemMatch[1]!);
    const result = await withTransaction(options.pool, async (client) => {
      const item = await authorizeItemId(client, actor, "read", itemId);
      const versions = await loadContentVersions(client, itemId);
      const draft = versions.find((version) => version.state === "DRAFT") ?? null;
      const published = versions.find((version) => version.state === "PUBLISHED") ?? null;
      return { item: { ...item, draft, published }, versions: versions.slice(0, 20) };
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  if (path === "/carousel") {
    const slotRaw = query.get("slot") ?? "HOME_HERO";
    if (!isCarouselSlot(slotRaw)) throw invalid("Slot is invalid");
    const limit = parseLimit(query);
    const cursorParam = query.get("cursor");
    const result = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformRead);
      let cursor: { sortOrder: number; id: string } | null = null;
      if (cursorParam !== null) {
        const record = decodeCursor(cursorParam, (value) => value.slot === slotRaw && value.limit === limit);
        if (!Number.isInteger(record.sortOrder)) throw invalid("Cursor is invalid");
        cursor = { sortOrder: record.sortOrder as number, id: readCursorId(record) };
      }
      return listAdminCarousel(client, slotRaw, limit, cursor);
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  if (path === "/media") {
    const limit = parseLimit(query);
    const cursorParam = query.get("cursor");
    const result = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformRead);
      let cursor: { updatedAt: string; id: string } | null = null;
      if (cursorParam !== null) {
        const record = decodeCursor(cursorParam, (value) => value.limit === limit);
        cursor = { updatedAt: readCursorTimestamp(record, "updatedAt"), id: readCursorId(record) };
      }
      return listContentMedia(client, limit, cursor);
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  if (path === "/media-options") {
    const limit = parseLimit(query);
    const cursorParam = query.get("cursor");
    const result = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformRead);
      let cursor: { updatedAt: string; id: string } | null = null;
      if (cursorParam !== null) {
        const record = decodeCursor(cursorParam, (value) => value.limit === limit);
        cursor = { updatedAt: readCursorTimestamp(record, "updatedAt"), id: readCursorId(record) };
      }
      return listContentMediaOptions(client, limit, cursor);
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  const mediaContentMatch = /^\/media\/([^/]+)\/content$/.exec(path);
  if (mediaContentMatch) {
    const assetId = decodeId(mediaContentMatch[1]!);
    const asset = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformRead);
      const row = await loadMediaAsset(client, assetId);
      if (!row || row.ownershipKind !== "PLATFORM_CONTENT" || row.purpose !== "CONTENT_MEDIA") throw notFound();
      return row;
    });
    await sendStoredMedia(response, requestId, options.mediaStorage, asset, "private, no-store");
    return;
  }
  if (path === "/games") {
    const games = await withTransaction(options.pool, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentRead);
      const scoped = access.isBoss ? "" : ` AND EXISTS (SELECT 1 FROM "zzsh_supply"."admin_supply_scope" s WHERE s."game_id" = g."id" AND s."admin_user_id" = $1)`;
      return (await client.query(`SELECT g."id", g."code", g."name" FROM "zzsh_supply"."game" g WHERE g."enabled"${scoped} ORDER BY g."code"`, access.isBoss ? [] : [actor.id])).rows;
    });
    sendJson(response, 200, { games }, requestId);
    return;
  }
  throw notFound();
}

async function handleAdminWrite(
  request: SupplyNodeRequest,
  response: ContentResponse,
  options: ContentRuntimeOptions,
  requestId: string,
  method: "POST" | "PUT",
  path: string,
  actor: WriteActor,
): Promise<void> {
  const write = async (
    operation: string,
    resourceId: string | undefined,
    authorize: (client: PoolClient, replay: IdempotencyReplay) => Promise<boolean | void>,
    action: (client: PoolClient) => Promise<{ status: number; body: unknown }>,
  ): Promise<void> => {
    await runIdempotentWrite(
      options,
      request,
      response,
      requestId,
      { principalId: actor.id, operation, ...(resourceId ? { resourceId } : {}) },
      actor,
      request.body,
      async (client, replay) => {
        await assertAdminContextInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
        return authorize(client, replay);
      },
      action,
    );
  };

  if (path === "/items" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["type", "gameId", "title", "summary", "body", "coverMediaId"]);
    const type = requiredString(body, "type", 16);
    if (!isContentType(type)) throw invalid("Type is invalid");
    const gameIdRaw = body.gameId === undefined || body.gameId === null ? null : decodeId(requiredString(body, "gameId", 128));
    if (type === "ANNOUNCEMENT" && gameIdRaw !== null) throw invalid("Platform announcements cannot belong to a game");
    const title = optionalText(body, "title", 200);
    const summary = optionalText(body, "summary", 500);
    const contentBody = optionalText(body, "body", 20_000, 20_000);
    const coverMediaId = body.coverMediaId === undefined ? undefined : body.coverMediaId === null ? null : decodeId(requiredString(body, "coverMediaId", 128));
    await write("content.item.create", undefined, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, scopePermission(gameIdRaw === null, "edit"));
      if (gameIdRaw !== null) await assertGameScope(client, actor.id, access.isBoss, gameIdRaw);
    }, async (client) => {
      const created = await createContentItem(client, actor.id, {
        type,
        gameId: gameIdRaw,
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(contentBody !== undefined ? { body: contentBody } : {}),
        ...(coverMediaId !== undefined ? { coverMediaId } : {}),
      });
      await auditContent(client, {
        actor, requestId,
        action: "content.item.created",
        objectType: "content_item",
        objectId: created.item.id,
        scope: itemScopeLabel(created.item),
        before: null,
        after: await contentSnapshot(client, "content_item", created.item.id),
        result: "CREATED",
      });
      return { status: 200, body: { item: created.item, version: created.version } };
    });
    return;
  }

  const draftMatch = /^\/items\/([^/]+)\/draft$/.exec(path);
  if (draftMatch && method === "PUT") {
    const itemId = decodeId(draftMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["versionId", "expectedRevision", "title", "summary", "body", "coverMediaId"]);
    // Version identity is required: the server never picks a draft on its own,
    // so a stale editor cannot overwrite a replacement draft that shares the
    // same per-version revision counter.
    const versionId = decodeId(requiredString(body, "versionId", 128));
    const expectedRevision = parseExpectedRevision(body);
    const draft: DraftInput = {};
    if (body.title !== undefined) draft.title = optionalText(body, "title", 200)!;
    if (body.summary !== undefined) draft.summary = optionalText(body, "summary", 500)!;
    if (body.body !== undefined) draft.body = optionalText(body, "body", 20_000, 20_000)!;
    if (body.coverMediaId !== undefined) draft.coverMediaId = body.coverMediaId === null ? null : decodeId(requiredString(body, "coverMediaId", 128));
    await write("content.draft.save", itemId, async (client) => {
      await authorizeItemId(client, actor, "edit", itemId);
    }, async (client) => {
      const item = await loadContentItem(client, itemId, true);
      if (!item) throw notFound();
      const before = await contentSnapshot(client, "content_version", versionId);
      const saved = await saveContentDraft(client, itemId, versionId, expectedRevision, draft);
      await auditContent(client, {
        actor, requestId,
        action: "content.draft.saved",
        objectType: "content_version",
        objectId: saved.version.id,
        scope: itemScopeLabel(saved.item),
        before,
        after: await contentSnapshot(client, "content_version", saved.version.id),
        result: "APPLIED",
      });
      return { status: 200, body: { item: saved.item, version: saved.version } };
    });
    return;
  }

  if (draftMatch && method === "POST") {
    const itemId = decodeId(draftMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, []);
    await write("content.draft.create", itemId, async (client) => {
      await authorizeItemId(client, actor, "edit", itemId);
    }, async (client) => {
      const item = await loadContentItem(client, itemId, true);
      if (!item) throw notFound();
      const created = await createContentDraftFromLatest(client, actor.id, itemId);
      await auditContent(client, {
        actor, requestId,
        action: "content.draft.created",
        objectType: "content_version",
        objectId: created.version.id,
        scope: itemScopeLabel(item),
        before: null,
        after: await contentSnapshot(client, "content_version", created.version.id),
        result: "CREATED",
      });
      return { status: 200, body: { item, version: created.version } };
    });
    return;
  }

  const publishMatch = /^\/items\/([^/]+)\/publish$/.exec(path);
  if (publishMatch && method === "POST") {
    const itemId = decodeId(publishMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["versionId", "expectedRevision"]);
    const versionId = decodeId(requiredString(body, "versionId", 128));
    const expectedRevision = parseExpectedRevision(body);
    await write("content.version.publish", itemId, async (client) => {
      await authorizeItemId(client, actor, "publish", itemId);
    }, async (client) => {
      const item = await loadContentItem(client, itemId, true);
      if (!item) throw notFound();
      const before = await contentSnapshot(client, "content_version", versionId);
      const published = await publishContentVersion(client, actor.id, itemId, versionId, expectedRevision);
      await auditContent(client, {
        actor, requestId,
        action: "content.version.published",
        objectType: "content_version",
        objectId: versionId,
        scope: itemScopeLabel(published.item),
        before,
        after: await contentSnapshot(client, "content_version", versionId),
        result: "PUBLISHED",
      });
      return { status: 200, body: { item: published.item, version: published.version } };
    });
    return;
  }

  const withdrawMatch = /^\/items\/([^/]+)\/withdraw$/.exec(path);
  if (withdrawMatch && method === "POST") {
    const itemId = decodeId(withdrawMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["versionId", "expectedRevision"]);
    const versionId = decodeId(requiredString(body, "versionId", 128));
    const expectedRevision = parseExpectedRevision(body);
    await write("content.version.withdraw", itemId, async (client) => {
      await authorizeItemId(client, actor, "publish", itemId);
    }, async (client) => {
      const item = await loadContentItem(client, itemId, true);
      if (!item) throw notFound();
      const before = await contentSnapshot(client, "content_version", versionId);
      const withdrawn = await withdrawContentVersion(client, itemId, versionId, expectedRevision);
      await auditContent(client, {
        actor, requestId,
        action: "content.version.withdrawn",
        objectType: "content_version",
        objectId: versionId,
        scope: itemScopeLabel(withdrawn.item),
        before,
        after: await contentSnapshot(client, "content_version", versionId),
        result: "WITHDRAWN",
      });
      return { status: 200, body: { item: withdrawn.item, version: withdrawn.version } };
    });
    return;
  }

  const itemMatch = /^\/items\/([^/]+)$/.exec(path);
  if (itemMatch && method === "PUT") {
    const itemId = decodeId(itemMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "sortOrder"]);
    const expectedRevision = parseExpectedRevision(body);
    const sortOrder = optionalInteger(body, "sortOrder", -1_000_000, 1_000_000);
    if (sortOrder === undefined) throw invalid("sortOrder is required");
    await write("content.item.update", itemId, async (client) => {
      await authorizeItemId(client, actor, "edit", itemId);
    }, async (client) => {
      const before = await contentSnapshot(client, "content_item", itemId);
      const item = await updateContentItemMeta(client, itemId, expectedRevision, { sortOrder });
      await auditContent(client, {
        actor, requestId,
        action: "content.item.meta_updated",
        objectType: "content_item",
        objectId: item.id,
        scope: itemScopeLabel(item),
        before,
        after: await contentSnapshot(client, "content_item", item.id),
        result: "APPLIED",
      });
      return { status: 200, body: { item } };
    });
    return;
  }

  if (path === "/carousel" && method === "POST") {
    const body = bodyOf(request);
    const input = carouselInput(body, true);
    await write("content.carousel.create", undefined, async (client, replay) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformEdit);
      // Creating an enabled entry publishes it immediately. A replay keeps the
      // original operation's publish requirement even after the fact.
      const requiresPublish = carouselCreateRequiresPublish(input.fields);
      if (requiresPublish || replay?.publishRequired) requirePermission(access, ADMIN_PERMISSION.contentPlatformPublish);
      return requiresPublish;
    }, async (client) => {
      const item = await createCarouselItem(client, actor.id, input.slot, input.fields);
      await auditContent(client, {
        actor, requestId,
        action: "content.carousel.created",
        objectType: "carousel_item",
        objectId: item.id,
        scope: "platform",
        before: null,
        after: await contentSnapshot(client, "carousel_item", item.id),
        result: "CREATED",
      });
      return { status: 200, body: { item } };
    });
    return;
  }

  const carouselMatch = /^\/carousel\/([^/]+)$/.exec(path);
  if (carouselMatch && method === "PUT") {
    const carouselId = decodeId(carouselMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "mediaId", "imageAlt", "title", "description", "linkUrl", "enabled", "sortOrder", "startsAt", "endsAt"]);
    const expectedRevision = parseExpectedRevision(body);
    const input = carouselInput(body, false);
    await write("content.carousel.update", carouselId, async (client, replay) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformEdit);
      // Lock the row before deciding: enable/disable and any public-field edit
      // of an enabled or scheduled entry require the publish permission. The
      // decision must never be made from a pre-transaction read, and a replay
      // must keep at least the original operation's publish requirement even
      // when the row state has changed since (e.g. a successful disable).
      const row = await loadCarouselItem(client, carouselId, true);
      if (!row) throw notFound();
      const requiresPublish = carouselUpdateRequiresPublish(row, input.fields);
      if (requiresPublish || replay?.publishRequired) requirePermission(access, ADMIN_PERMISSION.contentPlatformPublish);
      return requiresPublish;
    }, async (client) => {
      const before = await contentSnapshot(client, "carousel_item", carouselId);
      const item = await updateCarouselItem(client, carouselId, expectedRevision, input.fields);
      await auditContent(client, {
        actor, requestId,
        action: "content.carousel.updated",
        objectType: "carousel_item",
        objectId: item.id,
        scope: "platform",
        before,
        after: await contentSnapshot(client, "carousel_item", item.id),
        result: "APPLIED",
      });
      return { status: 200, body: { item } };
    });
    return;
  }

  if (path === "/media/upload-intents" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["purpose", "mime", "size"]);
    const purpose = requiredString(body, "purpose", 64);
    if (purpose !== "CONTENT_MEDIA") throw invalid("Purpose is not allowed");
    const mime = requiredString(body, "mime", 64);
    const size = optionalInteger(body, "size", 1, 10 * 1024 * 1024);
    if (size === undefined) throw invalid("Size is required");
    if (!options.mediaStorage.available) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Media storage is not configured");
    await write("content.media.upload_intent.create", undefined, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformEdit);
    }, async (client) => {
      const intent = await createMediaUploadIntent(client, { realm: "admin", adminUserId: actor.id }, { purpose, mime, size });
      await auditContent(client, {
        actor, requestId,
        action: "content.media.upload_intent_created",
        objectType: "media_upload_intent",
        objectId: intent.intentId,
        scope: "platform",
        before: null,
        after: { intentId: intent.intentId, purpose, mime, size },
        result: "CREATED",
      });
      return { status: 200, body: { intentId: intent.intentId, uploadToken: intent.uploadToken, expiresAt: intent.expiresAt } };
    });
    return;
  }

  const uploadMatch = /^\/media\/uploads\/([^/]+)$/.exec(path);
  if (uploadMatch && method === "PUT") {
    const intentId = decodeId(uploadMatch[1]!);
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
        const access = await requireAdminAccess(client, actor.id);
        requirePermission(access, ADMIN_PERMISSION.contentPlatformEdit);
      },
      beforeFinalize: async (client) => {
        const access = await requireAdminAccess(client, actor.id);
        requirePermission(access, ADMIN_PERMISSION.contentPlatformEdit);
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
    const visibility = body.visibility === undefined ? undefined : requiredString(body, "visibility", 32);
    await write("content.media.review", assetId, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformPublish);
      const row = await loadMediaAsset(client, assetId);
      if (!row || row.ownershipKind !== "PLATFORM_CONTENT" || row.purpose !== "CONTENT_MEDIA") throw notFound();
    }, async (client) => {
      const before = await auditSnapshot(client, "media_asset", assetId);
      const asset = await reviewMediaAsset(client, actor.id, false, assetId, { decision, ...(reason ? { reason } : {}), ...(visibility ? { visibility } : {}) });
      await auditContent(client, {
        actor, requestId,
        action: "content.media.reviewed",
        objectType: "media_asset",
        objectId: assetId,
        scope: "platform",
        before,
        after: await auditSnapshot(client, "media_asset", assetId),
        result: asset.reviewState,
      });
      return { status: 200, body: asset };
    });
    return;
  }

  const visibilityMatch = /^\/media\/([^/]+)\/visibility$/.exec(path);
  if (visibilityMatch && method === "POST") {
    const assetId = decodeId(visibilityMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["visibility", "reason"]);
    const visibility = requiredString(body, "visibility", 32);
    const reason = optionalTrimmedString(body, "reason", 500);
    await write("content.media.visibility", assetId, async (client) => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformPublish);
      const row = await loadMediaAsset(client, assetId);
      if (!row || row.ownershipKind !== "PLATFORM_CONTENT" || row.purpose !== "CONTENT_MEDIA") throw notFound();
    }, async (client) => {
      const before = await auditSnapshot(client, "media_asset", assetId);
      const asset = await changeMediaVisibility(client, actor.id, false, assetId, { visibility, ...(reason ? { reason } : {}) });
      await auditContent(client, {
        actor, requestId,
        action: "content.media.visibility_changed",
        objectType: "media_asset",
        objectId: assetId,
        scope: "platform",
        before,
        after: await auditSnapshot(client, "media_asset", assetId),
        result: asset.accessClass,
      });
      return { status: 200, body: asset };
    });
    return;
  }

  throw notFound();
}

function carouselInput(body: Record<string, unknown>, creating: boolean): { slot: (typeof CAROUSEL_SLOTS)[number]; fields: CarouselInput } {
  let slot: (typeof CAROUSEL_SLOTS)[number] = "HOME_HERO";
  if (creating) {
    const slotRaw = requiredString(body, "slotCode", 32);
    if (!isCarouselSlot(slotRaw)) throw invalid("Slot is invalid");
    slot = slotRaw;
  }
  const fields: CarouselInput = {};
  if (body.mediaId !== undefined) fields.mediaId = decodeId(requiredString(body, "mediaId", 128));
  if (body.imageAlt !== undefined) fields.imageAlt = optionalText(body, "imageAlt", 300)!;
  if (body.title !== undefined) fields.title = optionalText(body, "title", 120)!;
  if (body.description !== undefined) fields.description = optionalText(body, "description", 300)!;
  if (body.linkUrl !== undefined) fields.linkUrl = body.linkUrl === null ? null : optionalText(body, "linkUrl", 300)!;
  if (body.enabled !== undefined) {
    const enabled = optionalBoolean(body, "enabled");
    if (enabled === undefined) throw invalid("enabled is invalid");
    fields.enabled = enabled;
  }
  if (body.sortOrder !== undefined) {
    const sortOrder = optionalInteger(body, "sortOrder", -1_000_000, 1_000_000);
    if (sortOrder === undefined) throw invalid("sortOrder is invalid");
    fields.sortOrder = sortOrder;
  }
  if (body.startsAt !== undefined) fields.startsAt = body.startsAt === null ? null : optionalText(body, "startsAt", 64)!;
  if (body.endsAt !== undefined) fields.endsAt = body.endsAt === null ? null : optionalText(body, "endsAt", 64)!;
  return { slot, fields };
}

export function mountContentHandlers(app: INestApplication, options: ContentRuntimeOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: SupplyNodeRequest, response: ContentResponse) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/content", (request, response) => handleContentPublicRoute(request, response, options));
  expressApp.use("/api/v1/admin/content", (request, response) => handleContentAdminRoute(request, response, options));
}
