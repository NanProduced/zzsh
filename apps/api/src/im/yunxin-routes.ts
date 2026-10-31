import type { INestApplication } from "@nestjs/common";
import { withTransaction } from "../auth/security-core";
import { markOrderGroupRead, readOrderTeamAccess, recordOrderGroupMessage } from "./order-team-access";

import { ADMIN_PERMISSION, requireDirectoryPermission } from "../auth/admin-directory";
import { hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import {
  readAdminContext,
  SecurityApiError,
  type AuthSecurityNodeRequest,
  type AuthSecurityNodeResponse,
  type AuthSecurityOptions,
} from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { API_V1_ERROR_CODES, ensureApiV1RequestId } from "../contracts/api-v1";
import {
  ImIdentityInvariantError,
  ImIdentityUnavailableError,
  type ImIdentityKey,
  type ImIdentityMapping,
  type ImIdentityRepository,
  type ImIdentityProvisionInput,
  type ImProvisionResult,
  ImIdentityProvisioner,
  YunxinDynamicTokenService,
} from "./identity-lifecycle";
import {
  autoAssignWaitingConsultations,
  claimConsultation,
  closeConsultation,
  createOrResumeUserConsultation,
  dismissSupportRating,
  heartbeatOwnPresence,
  listAdminConsultations,
  listConsultationEvents,
  markConsultationRead,
  readConsultationContext,
  listTransferTargets,
  listUserConsultations,
  markUserConsultationRead,
  parseConsultationBody,
  parseLimit,
  parsePresenceBody,
  parseSupportRatingBody,
  readAdminMessageAccess,
  readOwnPresence,
  readUserMessageAccess,
  recordSupportThreadMessage,
  retryMessageScopeOperation,
  submitSupportRating,
  takeoverConsultation,
  transferConsultation,
  updateOwnPresence,
  type ConsultationRouteOptions,
} from "./consultation";
import {
  listAuditConversations,
  listSupportHandovers,
  parseHandoverNote,
  parseSupportDate,
  readPatrolOrderTeamAccess,
  readSupportOverview,
} from "./support-management";
import { inspectImage, MAX_MEDIA_BYTES } from "../supply/media";
import {
  ImTransportRequestError,
  IM_TRANSPORT_MEDIA_LIMITS,
  isImTransportMediaKind,
  isImTransportMediaMimeType,
  type ImOrderImageScope,
  type ImOrderMediaScope,
  type ImTransportMediaFile,
  type ImTransportMediaKind,
  type ImTransportMessage,
  type ImTransportMessageReference,
} from "./im-contract";

type NodeRequest = AuthSecurityNodeRequest;
type NodeResponse = AuthSecurityNodeResponse;

export type YunxinRouteOptions = {
  security: AuthSecurityOptions;
  appId: string;
  repository: ImIdentityRepository;
  provisioner: ImIdentityProvisioner;
  tokenService: YunxinDynamicTokenService;
  consultation?: ConsultationRouteOptions;
};

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function routePath(request: NodeRequest): string {
  const source = request.originalUrl ?? request.url ?? "/";
  const path = source.split("?", 1)[0] || "/";
  const prefix = "/api/v1/im";
  if (path === prefix) return "/";
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || "/" : path;
}

function routeQuery(request: NodeRequest): URLSearchParams {
  const source = request.originalUrl ?? request.url ?? "/";
  return new URL(source, "http://yunxin-route.local").searchParams;
}

function originAllowed(request: NodeRequest, origins: readonly string[]): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) return request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  return origins.includes(origin);
}

function sendJson(response: NodeResponse, status: number, body: unknown, requestId: string): void {
  if (response.headersSent) return;
  response.status(status).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store").json(body);
}

function sendError(response: NodeResponse, error: SecurityApiError, requestId: string): void {
  sendJson(response, error.status, { error: { code: error.code, message: error.message, requestId } }, requestId);
}

function sendInternalError(response: NodeResponse, requestId: string): void {
  sendJson(response, 500, { error: { code: API_V1_ERROR_CODES.INTERNAL_ERROR, message: "Internal server error", requestId } }, requestId);
}

function sendUnavailable(response: NodeResponse, requestId: string): void {
  sendJson(response, 503, { error: { code: API_V1_ERROR_CODES.IM_UNAVAILABLE, message: "IM service is temporarily unavailable", requestId } }, requestId);
}

function keyFor(appId: string, realm: "user" | "admin", kind: "USER" | "ADMIN", subjectId: string): ImIdentityKey {
  return { provider: "yunxin", appId, realm, kind, platformSubjectId: subjectId };
}

function identityUnavailable(result: ImProvisionResult): SecurityApiError | null {
  if (result.outcome === "READY" || result.outcome === "PENDING") return null;
  return new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "IM identity is unavailable");
}

async function assertAdminSubjectActive(options: AuthSecurityOptions, userId: string): Promise<void> {
  const result = await options.pool.query<{ suspended: boolean }>(
    `SELECT "suspended" FROM "zzsh_auth_admin"."user" WHERE "id" = $1`,
    [userId],
  );
  if (!result.rows[0] || result.rows[0].suspended) {
    throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
  }
}

function tokenBody(result: Awaited<ReturnType<YunxinDynamicTokenService["issue"]>>, appKey: string, transport: "nim" | "local-fake"): Record<string, unknown> {
  return {
    // AppKey is a public client bootstrap value; AppSecret never leaves the API.
    appKey,
    accountId: result.accountId,
    token: result.token,
    issuedAt: new Date(result.issuedAt).toISOString(),
    expiresAt: new Date(result.expiresAt).toISOString(),
    ttlSeconds: result.ttlSeconds,
    transport,
  };
}

async function provision(
  options: YunxinRouteOptions,
  input: ImIdentityProvisionInput,
  response: NodeResponse,
  requestId: string,
): Promise<boolean> {
  const result = await options.provisioner.ensure(input);
  const blocked = identityUnavailable(result);
  if (blocked) {
    sendError(response, blocked, requestId);
    return false;
  }
  if (result.outcome === "PENDING") {
    sendUnavailable(response, requestId);
    return false;
  }
  return true;
}

function publicIdentity(mapping: ImIdentityMapping): Record<string, unknown> {
  return {
    id: mapping.id,
    appId: mapping.key.appId,
    realm: mapping.key.realm,
    kind: mapping.key.kind,
    platformSubjectId: mapping.key.platformSubjectId,
    accountId: mapping.accountId,
    status: mapping.status,
    version: mapping.version,
    attemptCount: mapping.attemptCount,
    attemptLeaseUntil: mapping.attemptLeaseUntil,
    nextRetryAt: mapping.nextRetryAt,
    lastFailure: mapping.lastFailure,
  };
}

async function handleUserToken(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const context = await readUserContext(request, options.security);
  const key = keyFor(options.appId, "user", "USER", context.userId);
  if (!await provision(options, { key }, response, requestId)) return;
  // The provider call is outside the auth transaction; recheck the platform session before issuing a token.
  const fresh = await readUserContext(request, options.security);
  if (fresh.userId !== context.userId || fresh.sessionId !== context.sessionId) {
    throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
  }
  try {
    sendJson(response, 200, tokenBody(await options.tokenService.issue(key), options.appId, options.consultation?.messageTransport ? "local-fake" : "nim"), requestId);
  } catch (error) {
    if (error instanceof ImIdentityUnavailableError) sendUnavailable(response, requestId);
    else throw error;
  }
}

async function handleAdminToken(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const context = await readAdminContext(request, options.security);
  await assertAdminSubjectActive(options.security, context.userId);
  await requireDirectoryPermission(options.security.pool, context.userId, ADMIN_PERMISSION.imSupportRead);
  const key = keyFor(options.appId, "admin", "ADMIN", context.userId);
  if (!await provision(options, { key }, response, requestId)) return;
  // Recheck session, lock state, active status, and permission after the external provisioning call.
  const fresh = await readAdminContext(request, options.security);
  if (fresh.userId !== context.userId || fresh.sessionId !== context.sessionId) {
    throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
  }
  await assertAdminSubjectActive(options.security, fresh.userId);
  await requireDirectoryPermission(options.security.pool, fresh.userId, ADMIN_PERMISSION.imSupportRead);
  try {
    sendJson(response, 200, tokenBody(await options.tokenService.issue(key), options.appId, options.consultation?.messageTransport ? "local-fake" : "nim"), requestId);
  } catch (error) {
    if (error instanceof ImIdentityUnavailableError) sendUnavailable(response, requestId);
    else throw error;
  }
}

async function handleAdminIdentities(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const context = await readAdminContext(request, options.security);
  await assertAdminSubjectActive(options.security, context.userId);
  await requireDirectoryPermission(options.security.pool, context.userId, ADMIN_PERMISSION.imSupportRead);
  // Support scope is intentionally self-only until consultation assignment exists; never expose the app-wide mapping directory.
  const identity = await options.repository.findByKey(keyFor(options.appId, "admin", "ADMIN", context.userId));
  sendJson(response, 200, { identities: identity ? [publicIdentity(identity)] : [] }, requestId);
}

async function handleUserConsultations(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readUserContext(request, options.security);
  if (request.method?.toUpperCase() === "GET") {
    sendJson(response, 200, await listUserConsultations(options.consultation, context, parseLimit(routeQuery(request).get("limit"))), requestId);
    return;
  }
  const input = parseConsultationBody(request.body);
  sendJson(response, 200, await createOrResumeUserConsultation(options.consultation, context, input.type, input.subjectRef, requestId, input.entryIntent), requestId);
}

async function handleUserConsultationRating(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, consultationId: string): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readUserContext(request, options.security);
  const input = parseSupportRatingBody(request.body);
  sendJson(response, 200, await submitSupportRating(options.consultation, context, consultationId, input.score, input.comment), requestId);
}

async function handleUserConsultationRead(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, consultationId: string): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const body = request.body;
  if (body !== undefined && body !== null
    && (typeof body !== "object" || Array.isArray(body) || Object.keys(body as Record<string, unknown>).length !== 0)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Read body must be empty");
  }
  const context = await readUserContext(request, options.security);
  sendJson(response, 200, await markUserConsultationRead(options.consultation, context, consultationId), requestId);
}

async function handleUserConsultationRatingDismiss(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, consultationId: string): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const body = request.body;
  if (body !== undefined && body !== null
    && (typeof body !== "object" || Array.isArray(body) || Object.keys(body as Record<string, unknown>).length !== 0)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Dismiss body must be empty");
  }
  const context = await readUserContext(request, options.security);
  sendJson(response, 200, await dismissSupportRating(options.consultation, context, consultationId), requestId);
}

function messageConversationId(value: string | null): string {
  if (!value || value.length > 160) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Conversation is invalid");
  return value;
}

const MEDIA_MESSAGE_PREVIEW: Record<ImTransportMediaKind, string> = {
  video: "[视频]",
  file: "[文件]",
  audio: "[语音]",
};

/** 消息已发送成功后才写摘要；摘要只是 best-effort，失败不能把成功发送改判为失败。 */
async function recordSupportPreview(options: YunxinRouteOptions, conversationId: string, preview: string, fromUser = false): Promise<boolean> {
  if (!options.consultation) return false;
  try {
    if (await recordSupportThreadMessage(options.consultation, conversationId, preview, fromUser)) return true;
  } catch {
    // Message already sent; a failed preview is overwritten by the next message.
    return false;
  }
  // 订单群复用同一个发送入口：记录最后活动时间，列表才能和客服线程一起按最近消息排序。
  try {
    await recordOrderGroupMessage(options.consultation.pool, options.consultation.appId, conversationId, preview);
  } catch {
    // Activity is a read-side convenience; the message send remains authoritative.
  }
  return false;
}

/**
 * 用户首条消息落库后唤醒一次自动分配；失败只影响后续分配时机，
 * 不影响已经成功的发送结果。客服/管理端消息与订单群消息不调用。
 */
function wakeConsultationAutoAssign(options: YunxinRouteOptions): void {
  const consultation = options.consultation;
  if (!consultation?.autoAssignConsultations) return;
  void autoAssignWaitingConsultations(consultation, 5).catch(() => undefined);
}

type ParsedMessageBody =
  | { conversationId: string; kind: "text"; text: string }
  | { conversationId: string; kind: "image"; image: { messageClientId: string; name: string; mimeType: "image/jpeg" | "image/png"; size: number; body: Buffer; width: number; height: number } }
  | { conversationId: string; kind: "media"; media: { messageClientId: string; kind: ImTransportMediaKind; name: string; mimeType: string; size: number; body: Buffer; width?: number; height?: number; durationMs?: number } }
  | { conversationId: string; kind: "reply"; text: string; replyTo: ImTransportMessageReference }
  | { conversationId: string; kind: "revoke"; message: ImTransportMessageReference }
  | { conversationId: string; kind: "delete"; message: ImTransportMessageReference };

const BASE64_ALPHABET = /^[A-Za-z0-9+/]$/;

function decodeBase64(value: string, size: number, maxBytes: number, label: "Image" | "Media"): Buffer {
  if (!value || value.length !== Math.ceil(size / 3) * 4 || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, `${label} data is invalid`);
  }
  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "=") {
      padding += 1;
      if (padding > 2 || index < value.length - 2) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, `${label} data is invalid`);
    } else if (padding > 0 || !BASE64_ALPHABET.test(character)) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, `${label} data is invalid`);
    }
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== size) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, `${label} bytes are invalid`);
  return bytes;
}

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function messageReference(value: unknown): ImTransportMessageReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message reference is invalid");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => key !== "messageServerId" && key !== "messageClientId")) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message reference is invalid");
  }
  const reference: ImTransportMessageReference = {};
  for (const key of ["messageServerId", "messageClientId"] as const) {
    const id = source[key];
    if (id === undefined) continue;
    if (typeof id !== "string" || !MESSAGE_ID_PATTERN.test(id)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message reference is invalid");
    reference[key] = id;
  }
  if (!reference.messageServerId && !reference.messageClientId) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message reference is invalid");
  return reference;
}

function messageText(value: unknown): string {
  if (typeof value !== "string") throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message text is invalid");
  const text = value.trim();
  if (!text || text.length > 4_000) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message text is invalid");
  return text;
}

const MAX_MEDIA_DIMENSION = 8192;
const MAX_MEDIA_DURATION_MS = 24 * 60 * 60 * 1000;
const MEDIA_KEYS = ["kind", "messageClientId", "name", "mimeType", "size", "data", "width", "height", "durationMs"] as const;

function optionalPositiveInteger(value: unknown, max: number): { ok: true; value?: number } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max) return { ok: true, value };
  return { ok: false };
}

export async function parseMessageBody(value: unknown): Promise<ParsedMessageBody> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message body is invalid");
  const body = value as Record<string, unknown>;
  if (typeof body.conversationId !== "string") throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message body is invalid");
  const conversationId = messageConversationId(body.conversationId);
  if (body.action !== undefined) {
    if (body.action === "reply") {
      if (Object.keys(body).some((key) => !["conversationId", "action", "text", "replyTo"].includes(key))) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Reply message is invalid");
      return { conversationId, kind: "reply", text: messageText(body.text), replyTo: messageReference(body.replyTo) };
    }
    if (body.action === "revoke" || body.action === "delete") {
      if (Object.keys(body).some((key) => !["conversationId", "action", "message"].includes(key))) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message action is invalid");
      return { conversationId, kind: body.action, message: messageReference(body.message) };
    }
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message action is invalid");
  }
  const contentKeys = ["text", "image", "media"].filter((key) => body[key] !== undefined);
  if (contentKeys.length !== 1) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message body is invalid");
  }
  if (body.text !== undefined) {
    if (Object.keys(body).some((key) => key !== "conversationId" && key !== "text")) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message body is invalid");
    return { conversationId, kind: "text", text: messageText(body.text) };
  }
  if (body.media !== undefined) {
    if (Object.keys(body).some((key) => key !== "conversationId" && key !== "media")
      || !body.media || typeof body.media !== "object" || Array.isArray(body.media)) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Media message is invalid");
    }
    const media = body.media as Record<string, unknown>;
    if (Object.keys(media).some((key) => !(MEDIA_KEYS as readonly string[]).includes(key))
      || !isImTransportMediaKind(media.kind)
      || typeof media.messageClientId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(media.messageClientId)
      || typeof media.name !== "string" || media.name.length < 1 || media.name.length > 255
      || /[\u0000-\u001F\u007F]/.test(media.name)
      || !isImTransportMediaMimeType(media.kind, media.mimeType)
      || typeof media.size !== "number" || !Number.isInteger(media.size) || media.size < 1
      || media.size > IM_TRANSPORT_MEDIA_LIMITS[media.kind].maxBytes
      || typeof media.data !== "string") {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Media message is invalid");
    }
    const kind = media.kind;
    const width = optionalPositiveInteger(media.width, MAX_MEDIA_DIMENSION);
    const height = optionalPositiveInteger(media.height, MAX_MEDIA_DIMENSION);
    const durationMs = optionalPositiveInteger(media.durationMs, MAX_MEDIA_DURATION_MS);
    const dimensionsPresent = media.width !== undefined || media.height !== undefined;
    if (!width.ok || !height.ok || !durationMs.ok
      || (dimensionsPresent && (width.value === undefined || height.value === undefined))
      || (kind === "file" && (media.width !== undefined || media.height !== undefined || media.durationMs !== undefined))
      || (kind === "audio" && dimensionsPresent)) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Media metadata is invalid");
    }
    const size = media.size;
    const bytes = decodeBase64(media.data, size, IM_TRANSPORT_MEDIA_LIMITS[kind].maxBytes, "Media");
    return {
      conversationId,
      kind: "media",
      media: {
        messageClientId: media.messageClientId,
        kind,
        name: media.name,
        mimeType: media.mimeType,
        size,
        body: bytes,
        ...(width.value === undefined ? {} : { width: width.value }),
        ...(height.value === undefined ? {} : { height: height.value }),
        ...(durationMs.value === undefined ? {} : { durationMs: durationMs.value }),
      },
    };
  }
  if (Object.keys(body).some((key) => key !== "conversationId" && key !== "image") || !body.image || typeof body.image !== "object" || Array.isArray(body.image)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Image message is invalid");
  const image = body.image as Record<string, unknown>;
  if (Object.keys(image).some((key) => !["messageClientId", "name", "mimeType", "size", "data", "width", "height"].includes(key))
    || typeof image.messageClientId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(image.messageClientId)
    || typeof image.name !== "string" || image.name.length < 1 || image.name.length > 255
    || /[\u0000-\u001F\u007F]/.test(image.name)
    || (image.mimeType !== "image/jpeg" && image.mimeType !== "image/png")
    || typeof image.size !== "number" || !Number.isInteger(image.size) || image.size < 1 || image.size > MAX_MEDIA_BYTES
    || typeof image.data !== "string") {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Image message is invalid");
  }
  const size = image.size as number;
  const bytes = decodeBase64(image.data as string, size, MAX_MEDIA_BYTES, "Image");
  let actual;
  try {
    actual = await inspectImage(bytes);
  } catch {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Image bytes are invalid");
  }
  if (actual.mime !== image.mimeType) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Image MIME type is invalid");
  const declaredDimension = (key: "width" | "height") => image[key] === undefined ? actual[key] : Number.isInteger(image[key]) && Number(image[key]) === actual[key] ? actual[key] : null;
  const width = declaredDimension("width");
  const height = declaredDimension("height");
  if (width === null || height === null) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Image dimensions are invalid");
  const messageClientId = image.messageClientId as string;
  const name = image.name as string;
  const mimeType = image.mimeType as "image/jpeg" | "image/png";
  return { conversationId, kind: "image", image: { messageClientId, name, mimeType, size, body: bytes, width, height } };
}

function publicMessage(message: ImTransportMessage, realm: "user" | "admin"): ImTransportMessage {
  const imageId = message.attachment?.imageId;
  if (message.messageType !== 1 || !imageId) {
    if (!message.media) return message;
    const prefix = realm === "user" ? "/api/im/media/" : "/api/bff/admin/im/media/";
    return { ...message, media: { ...message.media, url: `${prefix}${encodeURIComponent(message.media.mediaId)}` } };
  }
  const prefix = realm === "user" ? "/api/im/images/" : "/api/bff/admin/im/images/";
  return { ...message, attachment: { ...message.attachment, url: `${prefix}${encodeURIComponent(imageId)}` } } as ImTransportMessage;
}

function sendImage(response: NodeResponse, image: { mimeType: string; body: Uint8Array }, requestId: string): void {
  if (response.headersSent) return;
  response.status(200).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store").setHeader("Content-Type", image.mimeType);
  if (response.send) response.send(image.body);
  else sendInternalError(response, requestId);
}

function sendMediaFile(response: NodeResponse, media: ImTransportMediaFile, requestId: string): void {
  if (response.headersSent) return;
  response.status(200)
    .setHeader("X-Request-Id", requestId)
    .setHeader("Cache-Control", "no-store")
    .setHeader("Content-Type", media.mimeType)
    .setHeader("X-Content-Type-Options", "nosniff");
  // File downloads never render inline; video/audio may stream in a player.
  if (media.kind === "file") response.setHeader("Content-Disposition", "attachment");
  if (response.send) response.send(media.body);
  else sendInternalError(response, requestId);
}

function parseMessageOperation(value: string | null): "read" | "send" {
  if (value !== "read" && value !== "send") throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message operation is invalid");
  return value;
}

/** 客服读路径：接待客服需要 im.support.read；运营巡视只需 im.support.management.read。 */
async function requireAdminImRead(pool: Parameters<typeof loadEffectiveAdminAccess>[0], userId: string): Promise<void> {
  const access = await loadEffectiveAdminAccess(pool, userId);
  if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)
    && !hasPermission(access, ADMIN_PERMISSION.imSupportManagementRead)) {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
  }
}

async function handleUserMessageAccess(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readUserContext(request, options.security);
  const query = routeQuery(request);
  const operation = parseMessageOperation(query.get("operation"));
  await readUserMessageAccess(options.consultation, context, messageConversationId(query.get("conversationId")), operation === "send");
  sendJson(response, 200, { authorized: true }, requestId);
}

async function handleAdminMessageAccess(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  await requireAdminImRead(options.security.pool, context.userId);
  const query = routeQuery(request);
  const operation = parseMessageOperation(query.get("operation"));
  await readAdminMessageAccess(options.consultation, context, messageConversationId(query.get("conversationId")), operation === "send", requestId);
  sendJson(response, 200, { authorized: true }, requestId);
}

type MessageAccess = { viewerAccountId: string; peerAccountId: string; scope?: ImOrderImageScope };

async function readMessageAccess(
  options: YunxinRouteOptions,
  actor: ({ realm: "user" } & Awaited<ReturnType<typeof readUserContext>>) | ({ realm: "admin" } & Awaited<ReturnType<typeof readAdminContext>>),
  conversationId: string,
  send = false,
  allowPatrol = false,
  requestId = "im_message_access",
): Promise<MessageAccess> {
  const teamId = /^[^|]+\|2\|([0-9]{1,19})$/.exec(conversationId)?.[1];
  if (teamId) {
    let access: MessageAccess | null = null;
    try {
      access = await withTransaction(options.security.pool, async (c) => {
        const row = (await c.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE app_id=$1 AND team_id=$2`, [options.appId, teamId])).rows[0];
        if (!row) return null;
        const result = await readOrderTeamAccess(c, actor, row.order_id, send ? "send" : "read");
        if (result.canRead !== true || result.conversationId !== conversationId) throw new SecurityApiError(403, "FORBIDDEN", "Order Team access denied");
        return { viewerAccountId: result.viewerAccountId as string, peerAccountId: teamId, scope: { appId: options.appId, orderId: result.orderId as string, teamId: result.teamId as string } };
      });
    } catch (error) {
      // 运营巡视旁路：订单群只读不要求 JOINED，但仍要求 appId/订单群存在；不获得发送权。
      if (!send && allowPatrol && actor.realm === "admin" && error instanceof SecurityApiError && error.status === 403) {
        const patrol = await withTransaction(options.security.pool, (c) => readPatrolOrderTeamAccess(
          c, { appId: options.appId, teamId, conversationId, requestId }, actor,
        ));
        if (patrol) return patrol;
      }
      throw error;
    }
    if (access) return access;
  }
  return actor.realm === "user"
    ? readUserMessageAccess(options.consultation!, actor, conversationId, send)
    : readAdminMessageAccess(options.consultation!, actor, conversationId, send, requestId);
}

function sameImageScope(left: ImOrderImageScope, right: ImOrderImageScope): boolean {
  return left.appId === right.appId && left.orderId === right.orderId && left.teamId === right.teamId;
}

async function readOrderImageAccess(
  options: YunxinRouteOptions,
  actor: ({ realm: "user" } & Awaited<ReturnType<typeof readUserContext>>) | ({ realm: "admin" } & Awaited<ReturnType<typeof readAdminContext>>),
  scope: ImOrderImageScope,
): Promise<{ viewerAccountId: string; peerAccountId: string }> {
  if (scope.appId !== options.appId) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Image not found");
  const access = await withTransaction(options.security.pool, async (c) => {
    const row = (await c.query(`SELECT order_id,team_id,app_id FROM zzsh_order.im_order_group WHERE app_id=$1 AND order_id=$2 AND team_id=$3`, [options.appId, scope.orderId, scope.teamId])).rows[0];
    if (!row) return null;
    const result = await readOrderTeamAccess(c, actor, row.order_id, "read");
    if (result.canRead !== true || result.appId !== scope.appId || result.orderId !== scope.orderId || result.teamId !== scope.teamId) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Order Team image access denied");
    return { viewerAccountId: result.viewerAccountId as string, peerAccountId: result.teamId as string };
  });
  if (!access) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Image not found");
  return access;
}

function messageBefore(request:NodeRequest):string|undefined{
  const raw=routeQuery(request).get("before");if(raw===null)return undefined;
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(raw))throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid history cursor");return raw;
}

type MessageActor = ({ realm: "user" } & Awaited<ReturnType<typeof readUserContext>>) | ({ realm: "admin" } & Awaited<ReturnType<typeof readAdminContext>>);

async function handleMessageAction(
  response: NodeResponse,
  requestId: string,
  options: YunxinRouteOptions,
  actor: MessageActor,
  input: Extract<ParsedMessageBody, { kind: "reply" | "revoke" | "delete" }>,
): Promise<void> {
  const transport = options.consultation?.messageTransport;
  if (!options.consultation || !transport) {
    sendUnavailable(response, requestId);
    return;
  }
  // Reply and revoke reuse the send grant; hiding a message only needs read.
  const access = await readMessageAccess(options, actor, input.conversationId, input.kind !== "delete", false, requestId);
  if (input.kind === "reply") {
    if (!transport.replyText) {
      sendUnavailable(response, requestId);
      return;
    }
    const message = await transport.replyText({
      conversationId: input.conversationId,
      senderAccountId: access.viewerAccountId,
      receiverAccountId: access.peerAccountId,
      text: input.text,
      replyTo: input.replyTo,
    });
    const fromUser = actor.realm === "user";
    if (await recordSupportPreview(options, input.conversationId, input.text, fromUser) && fromUser) wakeConsultationAutoAssign(options);
    sendJson(response, 200, { message: publicMessage(message, actor.realm) }, requestId);
    return;
  }
  if (input.kind === "revoke") {
    if (!transport.revoke) {
      sendUnavailable(response, requestId);
      return;
    }
    const message = await transport.revoke({ conversationId: input.conversationId, viewerAccountId: access.viewerAccountId, message: input.message });
    sendJson(response, 200, { message: publicMessage(message, actor.realm) }, requestId);
    return;
  }
  if (!transport.hideForViewer) {
    sendUnavailable(response, requestId);
    return;
  }
  await transport.hideForViewer({ conversationId: input.conversationId, viewerAccountId: access.viewerAccountId, message: input.message });
  sendJson(response, 200, { deleted: true }, requestId);
}

async function handleUserMessages(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const transport = options.consultation?.messageTransport;
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  // 真实通道没有服务端消息通道：正文由浏览器 NIM SDK 直连收发。这里只登记事实
  // （预览、首响起点、未读），并且仍然先过同一份对象访问校验，避免客户端拿上报接口
  // 去写别人会话的摘要。它不保存正文、不参与任何金额或状态判定。
  if (!transport) {
    if (request.method?.toUpperCase() !== "POST") { sendUnavailable(response, requestId); return; }
    const realContext = await readUserContext(request, options.security);
    const realInput = await parseMessageBody(request.body);
    if (realInput.kind !== "text") { sendUnavailable(response, requestId); return; }
    await readMessageAccess(options, {...realContext,realm:"user"}, realInput.conversationId, true);
    const recorded = await recordSupportPreview(options, realInput.conversationId, realInput.text, true);
    sendJson(response, 200, { recorded, via: "nim" }, requestId);
    return;
  }
  const context = await readUserContext(request, options.security);
  if (request.method?.toUpperCase() === "GET") {
    const conversationId = messageConversationId(routeQuery(request).get("conversationId"));
    const access = await readMessageAccess(options, {...context,realm:"user"}, conversationId);
    sendJson(response, 200, { messages: (await transport.history({ conversationId, viewerAccountId: access.viewerAccountId, limit: parseLimit(routeQuery(request).get("limit")),before:messageBefore(request) })).map(message => publicMessage(message, "user")) }, requestId);
    return;
  }
  const input = await parseMessageBody(request.body);
  if (input.kind === "reply" || input.kind === "revoke" || input.kind === "delete") {
    await handleMessageAction(response, requestId, options, {...context,realm:"user"}, input);
    return;
  }
  const access = await readMessageAccess(options, {...context,realm:"user"}, input.conversationId,true);
  if (input.kind === "text") {
    const message = await transport.sendText({ conversationId: input.conversationId, senderAccountId: access.viewerAccountId, receiverAccountId: access.peerAccountId, text: input.text });
    if (await recordSupportPreview(options, input.conversationId, input.text, true)) wakeConsultationAutoAssign(options);
    sendJson(response, 200, { message: publicMessage(message, "user") }, requestId);
    return;
  }
  if (input.kind === "media") {
    if (!transport.sendMedia) {
      sendUnavailable(response, requestId);
      return;
    }
    if (!access.scope) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Order Team media access denied");
    const media = input.media;
    const message = await transport.sendMedia({
      conversationId: input.conversationId,
      scope: access.scope,
      senderAccountId: access.viewerAccountId,
      receiverAccountId: access.peerAccountId,
      messageClientId: media.messageClientId,
      kind: media.kind,
      name: media.name,
      mimeType: media.mimeType,
      size: media.size,
      body: media.body,
      ...(media.width === undefined ? {} : { width: media.width }),
      ...(media.height === undefined ? {} : { height: media.height }),
      ...(media.durationMs === undefined ? {} : { durationMs: media.durationMs }),
    });
    if (await recordSupportPreview(options, input.conversationId, MEDIA_MESSAGE_PREVIEW[media.kind], true)) wakeConsultationAutoAssign(options);
    sendJson(response, 200, { message: publicMessage(message, "user") }, requestId);
    return;
  }
  if (!transport.sendImage) {
    sendUnavailable(response, requestId);
    return;
  }
  const image = input.image;
  if (!access.scope) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Order Team image access denied");
  const message = await transport.sendImage({ conversationId: input.conversationId, scope: access.scope, senderAccountId: access.viewerAccountId, receiverAccountId: access.peerAccountId, messageClientId: image.messageClientId, name: image.name, mimeType: image.mimeType, size: image.size, body: image.body, width: image.width, height: image.height });
  if (await recordSupportPreview(options, input.conversationId, "[图片]", true)) wakeConsultationAutoAssign(options);
  sendJson(response, 200, { message: publicMessage(message, "user") }, requestId);
}

async function handleOrderTeamRead(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, realm: "user" | "admin", orderId: string): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  if (realm === "user") {
    const context = await readUserContext(request, options.security);
    sendJson(response, 200, await markOrderGroupRead(options.consultation.pool, options.consultation.appId, orderId, { realm, userId: context.userId, sessionId: context.sessionId }), requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  await requireAdminImRead(options.security.pool, context.userId);
  sendJson(response, 200, await markOrderGroupRead(options.consultation.pool, options.consultation.appId, orderId, { realm, userId: context.userId, sessionId: context.sessionId }), requestId);
}

async function handleAdminMessages(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const transport = options.consultation?.messageTransport;
  if (!options.consultation || !transport) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  await requireAdminImRead(options.security.pool, context.userId);
  if (request.method?.toUpperCase() === "GET") {
    const conversationId = messageConversationId(routeQuery(request).get("conversationId"));
    const access = await readMessageAccess(options, {...context,realm:"admin"}, conversationId, false, true, requestId);
    sendJson(response, 200, { messages: (await transport.history({ conversationId, viewerAccountId: access.viewerAccountId, limit: parseLimit(routeQuery(request).get("limit")),before:messageBefore(request) })).map(message => publicMessage(message, "admin")) }, requestId);
    return;
  }
  const input = await parseMessageBody(request.body);
  if (input.kind === "reply" || input.kind === "revoke" || input.kind === "delete") {
    await handleMessageAction(response, requestId, options, {...context,realm:"admin"}, input);
    return;
  }
  const access = await readMessageAccess(options, {...context,realm:"admin"}, input.conversationId, true, false, requestId);
  if (input.kind === "text") {
    const message = await transport.sendText({ conversationId: input.conversationId, senderAccountId: access.viewerAccountId, receiverAccountId: access.peerAccountId, text: input.text });
    await recordSupportPreview(options, input.conversationId, input.text);
    sendJson(response, 200, { message: publicMessage(message, "admin") }, requestId);
    return;
  }
  if (input.kind === "media") {
    if (!transport.sendMedia) {
      sendUnavailable(response, requestId);
      return;
    }
    if (!access.scope) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Order Team media access denied");
    const media = input.media;
    const message = await transport.sendMedia({
      conversationId: input.conversationId,
      scope: access.scope,
      senderAccountId: access.viewerAccountId,
      receiverAccountId: access.peerAccountId,
      messageClientId: media.messageClientId,
      kind: media.kind,
      name: media.name,
      mimeType: media.mimeType,
      size: media.size,
      body: media.body,
      ...(media.width === undefined ? {} : { width: media.width }),
      ...(media.height === undefined ? {} : { height: media.height }),
      ...(media.durationMs === undefined ? {} : { durationMs: media.durationMs }),
    });
    await recordSupportPreview(options, input.conversationId, MEDIA_MESSAGE_PREVIEW[media.kind]);
    sendJson(response, 200, { message: publicMessage(message, "admin") }, requestId);
    return;
  }
  if (!transport.sendImage) {
    sendUnavailable(response, requestId);
    return;
  }
  const image = input.image;
  if (!access.scope) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Order Team image access denied");
  const message = await transport.sendImage({ conversationId: input.conversationId, scope: access.scope, senderAccountId: access.viewerAccountId, receiverAccountId: access.peerAccountId, messageClientId: image.messageClientId, name: image.name, mimeType: image.mimeType, size: image.size, body: image.body, width: image.width, height: image.height });
  await recordSupportPreview(options, input.conversationId, "[图片]");
  sendJson(response, 200, { message: publicMessage(message, "admin") }, requestId);
}

async function handleImage(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, realm: "user" | "admin", imageId: string): Promise<void> {
  const transport = options.consultation?.messageTransport;
  if (!options.consultation || !transport?.getImageScope || !transport.readImage) {
    sendUnavailable(response, requestId);
    return;
  }
  const scope = await transport.getImageScope(imageId);
  if (!scope || scope.imageId !== imageId) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Image not found");
  const access = realm === "user"
    ? await readOrderImageAccess(options, { ...(await readUserContext(request, options.security)), realm: "user" as const }, scope.scope)
    : await (async () => {
      const context = await readAdminContext(request, options.security);
      await requireDirectoryPermission(options.security.pool, context.userId, ADMIN_PERMISSION.imSupportRead);
      return readOrderImageAccess(options, { ...context, realm: "admin" as const }, scope.scope);
    })();
  const image = await transport.readImage({ imageId, scope: scope.scope, viewerAccountId: access.viewerAccountId });
  if (!image || image.imageId !== imageId || !sameImageScope(image.scope, scope.scope)) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Image not found");
  sendImage(response, image, requestId);
}

function sameMediaScope(left: ImOrderMediaScope, right: ImOrderMediaScope): boolean {
  return left.appId === right.appId && left.orderId === right.orderId && left.teamId === right.teamId;
}

async function handleMedia(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, realm: "user" | "admin", mediaId: string): Promise<void> {
  const transport = options.consultation?.messageTransport;
  if (!options.consultation || !transport?.getMediaScope || !transport.readMedia) {
    sendUnavailable(response, requestId);
    return;
  }
  const scope = await transport.getMediaScope(mediaId);
  if (!scope || scope.mediaId !== mediaId) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Media not found");
  const access = realm === "user"
    ? await readOrderImageAccess(options, { ...(await readUserContext(request, options.security)), realm: "user" as const }, scope.scope)
    : await (async () => {
      const context = await readAdminContext(request, options.security);
      await requireDirectoryPermission(options.security.pool, context.userId, ADMIN_PERMISSION.imSupportRead);
      return readOrderImageAccess(options, { ...context, realm: "admin" as const }, scope.scope);
    })();
  const media = await transport.readMedia({ mediaId, scope: scope.scope, viewerAccountId: access.viewerAccountId });
  if (!media || media.mediaId !== mediaId || !sameMediaScope(media.scope, scope.scope) || !isImTransportMediaMimeType(media.kind, media.mimeType)) {
    throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Media not found");
  }
  sendMediaFile(response, media, requestId);
}

async function handleAdminConsultations(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, action?: { id: string; name: "claim" | "transfer" | "close" | "reconcile" | "read" }): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  const access = await requireDirectoryPermission(options.security.pool, context.userId, ADMIN_PERMISSION.imSupportRead);
  if (!action) {
    sendJson(response, 200, await listAdminConsultations(options.consultation, context, access, parseLimit(routeQuery(request).get("limit"))), requestId);
    return;
  }
  if (action.name === "claim") {
    sendJson(response, 200, await claimConsultation(options.consultation, context, action.id, requestId), requestId);
    return;
  }
  if (action.name === "close") {
    sendJson(response, 200, await closeConsultation(options.consultation, context, action.id, requestId), requestId);
    return;
  }
  if (action.name === "read") {
    const body = request.body;
    if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body) || Object.keys(body as Record<string, unknown>).length !== 0)) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Read body must be empty");
    }
    sendJson(response, 200, await markConsultationRead(options.consultation, context, action.id), requestId);
    return;
  }
  if (action.name === "reconcile") {
    const body = request.body;
    if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body) || Object.keys(body as Record<string, unknown>).length !== 0)) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Reconcile body must be empty");
    }
    sendJson(response, 200, await retryMessageScopeOperation(options.consultation, context, action.id, requestId), requestId);
    return;
  }
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body as Record<string, unknown>).some((key) => key !== "targetAdminId" && key !== "note")
    || typeof (body as Record<string, unknown>).targetAdminId !== "string") {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Target administrator is required");
  }
  const note = parseHandoverNote((body as Record<string, unknown>).note);
  sendJson(response, 200, await transferConsultation(options.consultation, context, action.id, (body as { targetAdminId: string }).targetAdminId, requestId, note), requestId);
}

async function handleAdminConsultationEvents(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, consultationId: string): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  const query = routeQuery(request);
  if ([...query.keys()].some((key) => key !== "limit" && key !== "cursor") || query.getAll("limit").length > 1 || query.getAll("cursor").length > 1) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Query is invalid");
  sendJson(response, 200, await listConsultationEvents(options.consultation, context, consultationId, query.get("limit"), query.get("cursor")), requestId);
}

async function handleAdminConsultationContext(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, consultationId: string): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  if ([...routeQuery(request).keys()].length) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Query is invalid");
  sendJson(response, 200, await readConsultationContext(options.consultation, context, consultationId), requestId);
}

async function handleAdminTransferTargets(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  await requireDirectoryPermission(options.security.pool, context.userId, ADMIN_PERMISSION.imSupportRead);
  const consultationId = routeQuery(request).get("consultationId");
  if (!consultationId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(consultationId)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Consultation is invalid");
  }
  sendJson(response, 200, await listTransferTargets(options.consultation, context, consultationId), requestId);
}

async function handleAdminPresence(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  await requireDirectoryPermission(options.security.pool, context.userId, ADMIN_PERMISSION.imSupportPresence);
  if (request.method?.toUpperCase() === "GET") {
    sendJson(response, 200, await readOwnPresence(options.consultation, context), requestId);
    return;
  }
  sendJson(response, 200, await updateOwnPresence(options.consultation, context, parsePresenceBody(request.body), requestId), requestId);
}

function strictQuery(query: URLSearchParams, allowed: readonly string[]): void {
  if ([...query.keys()].some((key) => !allowed.includes(key))) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Query is invalid");
  for (const key of allowed) if (query.getAll(key).length > 1) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Query is invalid");
}

async function handleAdminPresenceHeartbeat(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  strictQuery(routeQuery(request), []);
  const context = await readAdminContext(request, options.security);
  sendJson(response, 200, await heartbeatOwnPresence(options.consultation, context), requestId);
}

async function handleAdminSupportOverview(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const query = routeQuery(request);
  strictQuery(query, ["date"]);
  const context = await readAdminContext(request, options.security);
  sendJson(response, 200, await readSupportOverview({ pool: options.security.pool, appId: options.appId }, context, query.get("date")), requestId);
}

async function handleAdminHandovers(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const query = routeQuery(request);
  strictQuery(query, ["limit"]);
  const context = await readAdminContext(request, options.security);
  sendJson(response, 200, await listSupportHandovers({ pool: options.security.pool, appId: options.appId }, context, query.get("limit")), requestId);
}

async function handleAdminAuditConversations(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const query = routeQuery(request);
  strictQuery(query, ["limit", "cursor"]);
  const context = await readAdminContext(request, options.security);
  sendJson(response, 200, await listAuditConversations({ pool: options.security.pool, appId: options.appId }, context, query.get("limit"), query.get("cursor")), requestId);
}

async function handleAdminTakeover(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, consultationId: string): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  strictQuery(routeQuery(request), []);
  const body = request.body;
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body)
    || Object.keys(body as Record<string, unknown>).some((key) => key !== "note"))) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Takeover body is invalid");
  }
  const note = body && typeof body === "object" ? parseHandoverNote((body as Record<string, unknown>).note) : null;
  const context = await readAdminContext(request, options.security);
  sendJson(response, 200, await takeoverConsultation(options.consultation, context, consultationId, requestId, note), requestId);
}

export async function handleYunxinRoute(request: NodeRequest, response: NodeResponse, options: YunxinRouteOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const path = routePath(request);
  const method = (request.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST" && method !== "PUT") {
    sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
    return;
  }
  try {
    if (path === "/user/token") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin])) {
        sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
        return;
      }
      await handleUserToken(request, response, requestId, options);
      return;
    }
    if (path === "/admin/token") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin])) {
        sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
        return;
      }
      await handleAdminToken(request, response, requestId, options);
      return;
    }
    if (path === "/admin/identities") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin])) {
        sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
        return;
      }
      await handleAdminIdentities(request, response, requestId, options);
      return;
    }
    const userRating = /^\/user\/consultations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/rating$/.exec(path);
    if (userRating) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin]) || method !== "POST") {
        sendError(response, new SecurityApiError(method === "POST" ? 403 : 404, method === "POST" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "POST" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleUserConsultationRating(request, response, requestId, options, userRating[1]!);
      return;
    }
    const userRatingDismiss = /^\/user\/consultations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/rating\/dismiss$/.exec(path);
    if (userRatingDismiss) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin]) || method !== "POST") {
        sendError(response, new SecurityApiError(method === "POST" ? 403 : 404, method === "POST" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "POST" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleUserConsultationRatingDismiss(request, response, requestId, options, userRatingDismiss[1]!);
      return;
    }
    const userRead = /^\/user\/consultations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/read$/.exec(path);
    if (userRead) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin]) || method !== "POST") {
        sendError(response, new SecurityApiError(method === "POST" ? 403 : 404, method === "POST" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "POST" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleUserConsultationRead(request, response, requestId, options, userRead[1]!);
      return;
    }
    const userOrderRead = /^\/user\/order-teams\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/read$/.exec(path);
    if (userOrderRead) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin]) || method !== "POST") {
        sendError(response, new SecurityApiError(method === "POST" ? 403 : 404, method === "POST" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "POST" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleOrderTeamRead(request, response, requestId, options, "user", userOrderRead[1]!);
      return;
    }
    if (path === "/user/consultations") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin])) {
        sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
        return;
      }
      if (method !== "GET" && method !== "POST") {
        sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
        return;
      }
      await handleUserConsultations(request, response, requestId, options);
      return;
    }
    if (path === "/user/messages") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin])) {
        sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
        return;
      }
      if (method !== "GET" && method !== "POST") {
        sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
        return;
      }
      await handleUserMessages(request, response, requestId, options);
      return;
    }
    const userImage = /^\/user\/images\/([A-Za-z0-9._:-]{1,128})$/.exec(path);
    if (userImage) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleImage(request, response, requestId, options, "user", userImage[1]!);
      return;
    }
    const userMedia = /^\/user\/media\/([A-Za-z0-9._:-]{1,128})$/.exec(path);
    if (userMedia) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleMedia(request, response, requestId, options, "user", userMedia[1]!);
      return;
    }
    if (path === "/user/message-access") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleUserMessageAccess(request, response, requestId, options);
      return;
    }
    const adminOrderRead = /^\/admin\/order-teams\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/read$/.exec(path);
    if (adminOrderRead) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "POST") {
        sendError(response, new SecurityApiError(method === "POST" ? 403 : 404, method === "POST" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "POST" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleOrderTeamRead(request, response, requestId, options, "admin", adminOrderRead[1]!);
      return;
    }
    if (path === "/admin/consultations") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminConsultations(request, response, requestId, options);
      return;
    }
    if (path === "/admin/transfer-targets") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminTransferTargets(request, response, requestId, options);
      return;
    }
    if (path === "/admin/messages") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin])) {
        sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
        return;
      }
      if (method !== "GET" && method !== "POST") {
        sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
        return;
      }
      await handleAdminMessages(request, response, requestId, options);
      return;
    }
    const adminImage = /^\/admin\/images\/([A-Za-z0-9._:-]{1,128})$/.exec(path);
    if (adminImage) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleImage(request, response, requestId, options, "admin", adminImage[1]!);
      return;
    }
    const adminMedia = /^\/admin\/media\/([A-Za-z0-9._:-]{1,128})$/.exec(path);
    if (adminMedia) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleMedia(request, response, requestId, options, "admin", adminMedia[1]!);
      return;
    }
    if (path === "/admin/message-access") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminMessageAccess(request, response, requestId, options);
      return;
    }
    const readMatch = /^\/admin\/consultations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(events|context)$/.exec(path);
    if (readMatch) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      if (readMatch[2] === "events") await handleAdminConsultationEvents(request, response, requestId, options, readMatch[1]!);
      else await handleAdminConsultationContext(request, response, requestId, options, readMatch[1]!);
      return;
    }
    const actionMatch = /^\/admin\/consultations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(claim|transfer|close|reconcile|read)$/.exec(path);
    if (actionMatch) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "POST") {
        sendError(response, new SecurityApiError(method === "POST" ? 403 : 404, method === "POST" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "POST" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminConsultations(request, response, requestId, options, { id: actionMatch[1]!, name: actionMatch[2] as "claim" | "transfer" | "close" | "reconcile" | "read" });
      return;
    }
    if (path === "/admin/presence") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin])) {
        sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
        return;
      }
      if (method !== "GET" && method !== "PUT") {
        sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
        return;
      }
      await handleAdminPresence(request, response, requestId, options);
      return;
    }
    if (path === "/admin/presence/heartbeat") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin])) {
        sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
        return;
      }
      if (method !== "POST") {
        sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
        return;
      }
      await handleAdminPresenceHeartbeat(request, response, requestId, options);
      return;
    }
    if (path === "/admin/support-overview") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminSupportOverview(request, response, requestId, options);
      return;
    }
    if (path === "/admin/handovers") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminHandovers(request, response, requestId, options);
      return;
    }
    if (path === "/admin/audit/conversations") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminAuditConversations(request, response, requestId, options);
      return;
    }
    const auditTakeover = /^\/admin\/audit\/consultations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/takeover$/.exec(path);
    if (auditTakeover) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "POST") {
        sendError(response, new SecurityApiError(method === "POST" ? 403 : 404, method === "POST" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "POST" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminTakeover(request, response, requestId, options, auditTakeover[1]!);
      return;
    }
    sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
  } catch (error) {
    if (error instanceof SecurityApiError) sendError(response, error, requestId);
    else if (error instanceof ImTransportRequestError) {
      const code = error.status === 404 ? API_V1_ERROR_CODES.NOT_FOUND
        : error.status === 403 ? API_V1_ERROR_CODES.FORBIDDEN
        : error.status === 409 ? API_V1_ERROR_CODES.CONFLICT
        : API_V1_ERROR_CODES.INVALID_ARGUMENT;
      sendError(response, new SecurityApiError(error.status, code, error.message), requestId);
    }
    else if ((error as { code?: string })?.code === "55P03") sendUnavailable(response, requestId);
    else if (error instanceof ImIdentityUnavailableError) sendUnavailable(response, requestId);
    else if (error instanceof ImIdentityInvariantError) sendInternalError(response, requestId);
    else sendInternalError(response, requestId);
  }
}

export function mountYunxinHandlers(app: INestApplication, options: YunxinRouteOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: NodeRequest, response: NodeResponse) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/im", (request, response) => handleYunxinRoute(request, response, options));
}
