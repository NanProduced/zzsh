import type { PoolClient } from "pg";

import { assertAdminContextInTransaction, readAdminContext } from "../auth/auth-security";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { API_V1_ERROR_CODES, ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { decodeImage, MAX_MEDIA_BYTES, type ImageMime } from "../supply/media";
import {
  decodeId,
  readRawBody,
  requestPath,
  requireOrigin,
  runIdempotentWrite,
  sendStoredMedia,
  safely,
  type SupplyRuntimeOptions,
  type SupplyResponse,
  type WriteActor,
} from "../supply/supply-routes";
import {
  bodyOf,
  ensureOnlyFields,
  headerValue,
  invalid,
  notFound,
  optionalInteger,
  parseExpectedRevision,
  requiredString,
  sendJson,
  sha256Hex,
  type IdempotencyReplay,
  type SupplyNodeRequest,
} from "../supply/supply-util";
import {
  addComment,
  authorizeDocs,
  completeImageRecord,
  createDiscussion,
  createImageRecord,
  createNode,
  deleteComment,
  deleteNode,
  editComment,
  imageReferenced,
  listDiscussions,
  listTrashForActor,
  listTree,
  listVersions,
  loadImage,
  loadNode,
  moveNode,
  readNodeDetail,
  readVersion,
  renameNode,
  resolveDiscussion,
  reopenDiscussion,
  restoreBatch,
  restoreVersion,
  saveContent,
  searchNodes,
  signableImages,
} from "./docs-store";
import { DOCS_IMAGE_VIEW_TTL_MS, type DocsImageFeature } from "./docs-images";
import type { MediaStorage } from "../supply/media";

export type DocsRuntimeOptions = SupplyRuntimeOptions & { docsImages: DocsImageFeature };
type DocsResponse = SupplyResponse & { send?: (body: Buffer | string) => void };

const IMAGE_MIME_SET = new Set<string>(["image/png", "image/jpeg", "image/webp"]);

function imagesDisabled(): SecurityApiError {
  return new SecurityApiError(503, API_V1_ERROR_CODES.IMAGES_DISABLED, "未开启图片存储");
}

function requireImages(options: DocsRuntimeOptions): Extract<DocsImageFeature, { enabled: true }> {
  if (!options.docsImages.enabled) throw imagesDisabled();
  return options.docsImages;
}

function imageUrl(imageId: string): string {
  return `/api/bff/admin/docs/images/${encodeURIComponent(imageId)}/content`;
}

function parseTitle(body: Record<string, unknown>): string {
  const title = requiredString(body, "title", 200);
  return title;
}

function parseParentId(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === null || value === undefined) return null;
  return decodeId(requiredString(body, field, 128));
}

function parseCursor(query: URLSearchParams): string | undefined {
  const raw = query.get("cursor");
  if (raw === null) return undefined;
  return decodeId(raw);
}

function parseLimit(query: URLSearchParams, fallback = 50): number {
  const raw = query.get("limit");
  const limit = raw === null ? fallback : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
  return limit;
}

export async function handleDocsAdminRoute(
  request: SupplyNodeRequest,
  response: DocsResponse,
  options: DocsRuntimeOptions,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const { path, query } = requestPath(request, "/api/v1/admin/docs");
  const method = (request.method ?? "GET").toUpperCase();
  await safely(response, requestId, async () => {
    if (!requireOrigin(request, response, options, requestId)) return;
    const context = await readAdminContext(request, options);
    const actor: WriteActor = { realm: "admin", id: context.userId, sessionId: context.sessionId };
    if (method === "GET") {
      await handleRead(response, options, requestId, path, query, actor);
      return;
    }
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      await handleWrite(request, response, options, requestId, method, path, actor);
      return;
    }
    throw notFound();
  });
}

async function handleRead(
  response: DocsResponse, options: DocsRuntimeOptions, requestId: string, path: string, query: URLSearchParams, actor: WriteActor,
): Promise<void> {
  if (path === "/tree") {
    const nodes = await withTransaction(options.pool, async client => {
      await authorizeDocs(client, actor, "read");
      return listTree(client);
    });
    sendJson(response, 200, { nodes: nodes.map(node => ({
      id: node.id, parentId: node.parentId, depth: node.depth, title: node.title, sortKey: node.sortKey,
      updatedAt: node.updatedAt, updatedBy: node.updatedByAdminId,
    })) }, requestId);
    return;
  }
  if (path === "/trash") {
    const result = await withTransaction(options.pool, client => listTrashForActor(client, actor, parseCursor(query), parseLimit(query)));
    sendJson(response, 200, result, requestId);
    return;
  }
  if (path === "/search") {
    const q = query.get("q");
    if (q !== null && q.length > 100) throw invalid("Search query exceeds 100 characters");
    const parentIdRaw = query.get("parentId");
    const updatedFromRaw = query.get("updatedFrom");
    const updatedToRaw = query.get("updatedTo");
    const result = await withTransaction(options.pool, client => searchNodes(client, actor, {
      ...(q !== null ? { q } : {}),
      ...(parentIdRaw !== null ? { parentId: parentIdRaw === "" ? null : decodeId(parentIdRaw) } : {}),
      ...(query.get("updatedBy") !== null ? { updatedBy: decodeId(query.get("updatedBy")!) } : {}),
      ...(updatedFromRaw !== null ? { updatedFrom: parseDate(updatedFromRaw) } : {}),
      ...(updatedToRaw !== null ? { updatedTo: parseDate(updatedToRaw) } : {}),
      ...(parseCursor(query) !== undefined ? { cursor: parseCursor(query) } : {}),
      limit: parseLimit(query),
    }));
    sendJson(response, 200, result, requestId);
    return;
  }
  const viewMatch = /^\/images\/([^/]+)\/content$/.exec(path);
  if (viewMatch) {
    const imageId = decodeId(viewMatch[1]!);
    const images = requireImages(options);
    const asset = await withTransaction(options.pool, async client => {
      await authorizeDocs(client, actor, "read");
      const image = await loadImage(client, imageId);
      if (!image || image.status !== "READY") throw notFound();
      if (!(await imageReferenced(client, imageId))) throw notFound();
      return image;
    });
    const storage: MediaStorage = { available: true, kind: "oss", write: async () => { throw imagesDisabled(); }, read: key => images.storage.readObject(key) };
    await sendStoredMedia(response, requestId, storage, { storageKey: asset.objectKey, mime: asset.mime, contentHash: asset.id }, "private, no-store");
    return;
  }
  const versionsMatch = /^\/([^/]+)\/versions$/.exec(path);
  if (versionsMatch) {
    const id = decodeId(versionsMatch[1]!);
    const result = await withTransaction(options.pool, async client => {
      await authorizeDocs(client, actor, "read");
      return listVersions(client, id, parseCursor(query), parseLimit(query));
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  const versionMatch = /^\/([^/]+)\/versions\/([^/]+)$/.exec(path);
  if (versionMatch) {
    const id = decodeId(versionMatch[1]!);
    const versionId = decodeId(versionMatch[2]!);
    const version = await withTransaction(options.pool, async client => {
      await authorizeDocs(client, actor, "read");
      return readVersion(client, id, versionId);
    });
    sendJson(response, 200, { version }, requestId);
    return;
  }
  const discussionsMatch = /^\/([^/]+)\/discussions$/.exec(path);
  if (discussionsMatch) {
    const id = decodeId(discussionsMatch[1]!);
    const status = parseDiscussionStatus(query);
    const discussions = await withTransaction(options.pool, client => listDiscussions(client, actor, id, status));
    sendJson(response, 200, { discussions }, requestId);
    return;
  }
  const detailMatch = /^\/([^/]+)$/.exec(path);
  if (detailMatch) {
    const id = decodeId(detailMatch[1]!);
    const detail = await withTransaction(options.pool, async client => {
      await authorizeDocs(client, actor, "read");
      return readNodeDetail(client, id);
    });
    sendJson(response, 200, detail, requestId);
    return;
  }
  throw notFound();
}

function parseDiscussionStatus(query: URLSearchParams): "OPEN" | "RESOLVED" | undefined {
  const raw = query.get("status");
  if (raw === null || raw === "") return undefined;
  if (raw !== "OPEN" && raw !== "RESOLVED") throw invalid("status must be OPEN or RESOLVED");
  return raw;
}

function parseCommentBody(body: Record<string, unknown>): string {
  return requiredString(body, "body", 2000);
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid("Timestamp is invalid");
  return date;
}

async function handleWrite(
  request: SupplyNodeRequest, response: DocsResponse, options: DocsRuntimeOptions, requestId: string,
  method: string, path: string, actor: WriteActor,
): Promise<void> {
  const write = async (
    operation: string, resourceId: string | undefined,
    authorize: (client: PoolClient, replay: IdempotencyReplay) => Promise<boolean | void>,
    action: (client: PoolClient) => Promise<{ status: number; body: unknown }>,
    fingerprintBody?: unknown,
  ): Promise<void> => {
    await runIdempotentWrite(
      options, request, response, requestId,
      { principalId: actor.id, operation, ...(resourceId ? { resourceId } : {}) },
      actor, fingerprintBody === undefined ? request.body : fingerprintBody,
      async (client, replay) => {
        await assertAdminContextInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
        return authorize(client, replay);
      },
      action,
    );
  };

  if (path === "/" && method === "POST") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["parentId", "title", "afterId"]);
    const parentId = parseParentId(body, "parentId");
    const title = parseTitle(body);
    const afterId = body.afterId === undefined || body.afterId === null ? null : decodeId(requiredString(body, "afterId", 128));
    await write("docs.node.create", undefined, async client => { await authorizeDocs(client, actor, "manage"); }, async client => {
      const detail = await createNode(client, actor, requestId, { parentId, title, afterId });
      return { status: 200, body: detail };
    });
    return;
  }

  const contentMatch = /^\/([^/]+)\/content$/.exec(path);
  if (contentMatch && method === "PUT") {
    const id = decodeId(contentMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "document"]);
    const expectedRevision = parseExpectedRevision(body);
    await write("docs.node.content.save", id, async client => { await authorizeDocs(client, actor, "manage"); }, async client => {
      const result = await saveContent(client, actor, id, expectedRevision, body.document, new Date());
      return { status: 200, body: result };
    });
    return;
  }

  const createDiscussionMatch = /^\/([^/]+)\/discussions$/.exec(path);
  if (createDiscussionMatch && method === "POST") {
    const id = decodeId(createDiscussionMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["discussionId", "anchorText", "anchorOffset", "expectedRevision", "body"]);
    const discussionId = requiredString(body, "discussionId", 64);
    const anchorText = requiredString(body, "anchorText", 500);
    const anchorOffset = optionalInteger(body, "anchorOffset", 0, Number.MAX_SAFE_INTEGER);
    const expectedRevision = anchorOffset !== undefined || body.expectedRevision !== undefined ? parseExpectedRevision(body) : undefined;
    const commentBody = parseCommentBody(body);
    await write("docs.discussion.create", id, async client => { await authorizeDocs(client, actor, "comment"); }, async client => {
      const result = await createDiscussion(client, actor, id, { discussionId, anchorText, anchorOffset, expectedRevision, body: commentBody }, new Date());
      return { status: 200, body: result };
    });
    return;
  }

  const addCommentMatch = /^\/discussions\/([^/]+)\/comments$/.exec(path);
  if (addCommentMatch && method === "POST") {
    const discussionId = decodeId(addCommentMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["body"]);
    const commentBody = parseCommentBody(body);
    await write("docs.comment.create", discussionId, async client => { await authorizeDocs(client, actor, "comment"); }, async client => {
      const comment = await addComment(client, actor, discussionId, commentBody);
      return { status: 200, body: { comment } };
    });
    return;
  }

  const commentMatch = /^\/comments\/([^/]+)$/.exec(path);
  if (commentMatch && method === "PATCH") {
    const commentId = decodeId(commentMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["body"]);
    const commentBody = parseCommentBody(body);
    await write("docs.comment.edit", commentId, async client => { await authorizeDocs(client, actor, "comment"); }, async client => {
      const comment = await editComment(client, actor, commentId, commentBody, new Date());
      return { status: 200, body: { comment } };
    });
    return;
  }
  if (commentMatch && method === "DELETE") {
    const commentId = decodeId(commentMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, []);
    await write("docs.comment.delete", commentId, async client => { await authorizeDocs(client, actor, "comment"); }, async client => {
      const comment = await deleteComment(client, actor, requestId, commentId, new Date());
      return { status: 200, body: { comment } };
    });
    return;
  }

  const resolveMatch = /^\/discussions\/([^/]+)\/resolve$/.exec(path);
  if (resolveMatch && method === "POST") {
    const discussionId = decodeId(resolveMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, []);
    await write("docs.discussion.resolve", discussionId, async client => { await authorizeDocs(client, actor, "comment"); }, async client => {
      const result = await resolveDiscussion(client, actor, requestId, discussionId, new Date());
      return { status: 200, body: result };
    });
    return;
  }

  const reopenMatch = /^\/discussions\/([^/]+)\/reopen$/.exec(path);
  if (reopenMatch && method === "POST") {
    const discussionId = decodeId(reopenMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, []);
    await write("docs.discussion.reopen", discussionId, async client => { await authorizeDocs(client, actor, "comment"); }, async client => {
      const discussion = await reopenDiscussion(client, actor, requestId, discussionId);
      return { status: 200, body: { discussion } };
    });
    return;
  }

  const renameMatch = /^\/([^/]+)$/.exec(path);
  if (renameMatch && method === "PATCH") {
    const id = decodeId(renameMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "title"]);
    const expectedRevision = parseExpectedRevision(body);
    const title = parseTitle(body);
    await write("docs.node.rename", id, async client => { await authorizeDocs(client, actor, "manage"); }, async client => {
      const detail = await renameNode(client, actor, requestId, id, expectedRevision, title);
      return { status: 200, body: detail };
    });
    return;
  }

  const moveMatch = /^\/([^/]+)\/move$/.exec(path);
  if (moveMatch && method === "POST") {
    const id = decodeId(moveMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "parentId", "afterId"]);
    const expectedRevision = parseExpectedRevision(body);
    const parentId = parseParentId(body, "parentId");
    const afterId = body.afterId === undefined || body.afterId === null ? null : decodeId(requiredString(body, "afterId", 128));
    await write("docs.node.move", id, async client => { await authorizeDocs(client, actor, "manage"); }, async client => {
      const result = await moveNode(client, actor, requestId, id, expectedRevision, parentId, afterId);
      return { status: 200, body: result };
    });
    return;
  }

  const restoreVersionMatch = /^\/([^/]+)\/restore-version$/.exec(path);
  if (restoreVersionMatch && method === "POST") {
    const id = decodeId(restoreVersionMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision", "versionId"]);
    const expectedRevision = parseExpectedRevision(body);
    const versionId = decodeId(requiredString(body, "versionId", 128));
    await write("docs.node.version.restore", id, async client => { await authorizeDocs(client, actor, "manage"); }, async client => {
      const detail = await restoreVersion(client, actor, requestId, id, expectedRevision, versionId);
      return { status: 200, body: detail };
    });
    return;
  }

  const deleteMatch = /^\/([^/]+)$/.exec(path);
  if (deleteMatch && method === "DELETE") {
    const id = decodeId(deleteMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision"]);
    const expectedRevision = parseExpectedRevision(body);
    await write("docs.node.delete", id, async client => { await authorizeDocs(client, actor, "manage"); }, async client => {
      const result = await deleteNode(client, actor, requestId, id, expectedRevision);
      return { status: 200, body: result };
    });
    return;
  }

  const trashRestoreMatch = /^\/trash\/([^/]+)\/restore$/.exec(path);
  if (trashRestoreMatch && method === "POST") {
    const batchId = decodeId(trashRestoreMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["parentId"]);
    const parentId = body.parentId === undefined ? undefined : parseParentId(body, "parentId");
    await write("docs.trash.restore", batchId, async client => { await authorizeDocs(client, actor, "manage"); }, async client => {
      const result = await restoreBatch(client, actor, requestId, batchId, parentId);
      return { status: 200, body: result };
    });
    return;
  }

  const signMatch = /^\/([^/]+)\/images\/sign$/.exec(path);
  if (signMatch && method === "POST") {
    const id = decodeId(signMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["imageIds"]);
    if (!Array.isArray(body.imageIds) || body.imageIds.length > 100) throw invalid("imageIds must be an array of at most 100");
    const imageIds = body.imageIds.map(value => {
      if (typeof value !== "string") throw invalid("imageIds must contain string ids");
      return decodeId(value);
    });
    requireImages(options);
    await write("docs.image.sign", id, async client => { await authorizeDocs(client, actor, "read"); }, async client => {
      const node = await loadNode(client, id);
      if (!node) throw notFound();
      if (node.deletedAt) throw notFound({ path: "id", code: "DOC_DELETED" });
      const signable = await signableImages(client, id, imageIds);
      const expiresAt = new Date(Date.now() + DOCS_IMAGE_VIEW_TTL_MS);
      const urls: Record<string, { url: string; expiresAt: Date }> = {};
      for (const image of signable) urls[image.id] = { url: imageUrl(image.id), expiresAt };
      return { status: 200, body: { urls } };
    });
    return;
  }

  const createImageMatch = /^\/([^/]+)\/images$/.exec(path);
  if (createImageMatch && method === "POST") {
    const id = decodeId(createImageMatch[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["mime", "bytes", "width", "height"]);
    const mime = requiredString(body, "mime", 64);
    if (!IMAGE_MIME_SET.has(mime)) throw invalid("Image MIME is not allowed");
    const bytes = optionalInteger(body, "bytes", 1, MAX_MEDIA_BYTES);
    const width = optionalInteger(body, "width", 1, 8192);
    const height = optionalInteger(body, "height", 1, 8192);
    if (bytes === undefined || width === undefined || height === undefined) throw invalid("Image bytes, width and height are required");
    requireImages(options);
    await write("docs.image.create", id, async client => { await authorizeDocs(client, actor, "manage"); }, async client => {
      const { image, uploadExpiresAt } = await createImageRecord(client, actor, requestId, id, { mime: mime as ImageMime, bytes, width, height }, new Date());
      return { status: 200, body: { imageId: image.id, upload: { url: imageUrl(image.id), method: "PUT", headers: { "content-type": image.mime }, expiresAt: uploadExpiresAt } } };
    });
    return;
  }

  const completeImageMatch = /^\/images\/([^/]+)\/complete$/.exec(path);
  if (completeImageMatch && method === "POST") {
    const imageId = decodeId(completeImageMatch[1]!);
    const images = requireImages(options);
    await write("docs.image.complete", imageId, async client => { await authorizeDocs(client, actor, "manage"); }, async client => {
      const image = await loadImage(client, imageId);
      if (!image || image.uploadedByAdminId !== actor.id) throw notFound();
      const exists = await images.storage.headObject(image.objectKey);
      if (!exists) throw invalid("Image object was not uploaded");
      const completed = await completeImageRecord(client, actor, requestId, imageId);
      return { status: 200, body: { imageId: completed.id, status: completed.status } };
    });
    return;
  }

  const uploadMatch = /^\/images\/([^/]+)\/content$/.exec(path);
  if (uploadMatch && method === "PUT") {
    const imageId = decodeId(uploadMatch[1]!);
    const images = requireImages(options);
    const bytes = await readRawBody(request, MAX_MEDIA_BYTES);
    let decoded;
    try { decoded = await decodeImage(bytes); } catch { throw invalid("Image is incomplete, invalid or outside resource limits"); }
    await write("docs.image.upload", imageId, async client => {
      await authorizeDocs(client, actor, "manage");
      const image = await loadImage(client, imageId);
      if (!image || image.uploadedByAdminId !== actor.id || image.status !== "PENDING") throw notFound();
      if (image.uploadExpiresAt.getTime() <= Date.now()) throw invalid("Image upload has expired");
      const node = await loadNode(client, image.uploadedInNodeId);
      if (!node) throw notFound();
      if (node.deletedAt) throw notFound({ path: "id", code: "DOC_DELETED" });
    }, async client => {
      const image = await loadImage(client, imageId);
      if (!image || image.uploadedByAdminId !== actor.id || image.status !== "PENDING") throw notFound();
      if (decoded.info.mime !== image.mime || decoded.info.width !== image.width || decoded.info.height !== image.height || bytes.length !== image.bytes) {
        throw invalid("Uploaded image does not match the declared metadata");
      }
      await images.storage.writeObject(image.objectKey, bytes, image.mime);
      return { status: 200, body: { imageId, status: "PENDING", bytes: bytes.length, width: decoded.info.width, height: decoded.info.height, mime: decoded.info.mime } };
    }, { imageId, contentHash: sha256Hex(bytes.toString("base64")) });
    return;
  }

  throw notFound();
}