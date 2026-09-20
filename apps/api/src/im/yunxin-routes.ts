import type { INestApplication } from "@nestjs/common";
import { withTransaction } from "../auth/security-core";
import { readOrderTeamAccess } from "./order-team-access";

import { ADMIN_PERMISSION, requireDirectoryPermission } from "../auth/admin-directory";
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
  claimConsultation,
  closeConsultation,
  createOrResumeUserConsultation,
  listAdminConsultations,
  listUserConsultations,
  parseConsultationBody,
  parseLimit,
  parsePresenceBody,
  readAdminMessageAccess,
  readOwnPresence,
  readUserMessageAccess,
  retryMessageScopeOperation,
  transferConsultation,
  updateOwnPresence,
  type ConsultationRouteOptions,
} from "./consultation";
import { inspectImage, MAX_MEDIA_BYTES } from "../supply/media";
import type { ImOrderImageScope, ImTransportMessage } from "./im-contract";

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
  sendJson(response, 200, await createOrResumeUserConsultation(options.consultation, context, input.type, input.subjectRef, requestId), requestId);
}

function messageConversationId(value: string | null): string {
  if (!value || value.length > 160) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Conversation is invalid");
  return value;
}

type ParsedMessageBody =
  | { conversationId: string; kind: "text"; text: string }
  | { conversationId: string; kind: "image"; image: { messageClientId: string; name: string; mimeType: "image/jpeg" | "image/png"; size: number; body: Buffer; width: number; height: number } };

const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_MEDIA_BYTES / 3) * 4;
const BASE64_ALPHABET = /^[A-Za-z0-9+/]$/;

function decodeBase64(value: string, size: number): Buffer {
  if (!value || value.length !== Math.ceil(size / 3) * 4 || value.length > MAX_IMAGE_BASE64_LENGTH || value.length % 4 !== 0) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Image data is invalid");
  }
  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "=") {
      padding += 1;
      if (padding > 2 || index < value.length - 2) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Image data is invalid");
    } else if (padding > 0 || !BASE64_ALPHABET.test(character)) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Image data is invalid");
    }
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== size) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Image bytes are invalid");
  return bytes;
}

export async function parseMessageBody(value: unknown): Promise<ParsedMessageBody> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message body is invalid");
  const body = value as Record<string, unknown>;
  if (typeof body.conversationId !== "string" || (body.text === undefined && body.image === undefined) || (body.text !== undefined && body.image !== undefined)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message body is invalid");
  }
  const conversationId = messageConversationId(body.conversationId);
  if (body.text !== undefined) {
    if (Object.keys(body).some((key) => key !== "conversationId" && key !== "text") || typeof body.text !== "string") throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message body is invalid");
    const text = body.text.trim();
    if (!text || text.length > 4_000) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message text is invalid");
    return { conversationId, kind: "text", text };
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
  const bytes = decodeBase64(image.data as string, size);
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
  if (message.messageType !== 1 || !imageId) return message;
  const prefix = realm === "user" ? "/api/im/images/" : "/api/bff/admin/im/images/";
  return { ...message, attachment: { ...message.attachment, url: `${prefix}${encodeURIComponent(imageId)}` } } as ImTransportMessage;
}

function sendImage(response: NodeResponse, image: { mimeType: string; body: Uint8Array }, requestId: string): void {
  if (response.headersSent) return;
  response.status(200).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store").setHeader("Content-Type", image.mimeType);
  if (response.send) response.send(image.body);
  else sendInternalError(response, requestId);
}

function parseMessageOperation(value: string | null): "read" | "send" {
  if (value !== "read" && value !== "send") throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Message operation is invalid");
  return value;
}

async function handleUserMessageAccess(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readUserContext(request, options.security);
  const query = routeQuery(request);
  parseMessageOperation(query.get("operation"));
  await readUserMessageAccess(options.consultation, context, messageConversationId(query.get("conversationId")));
  sendJson(response, 200, { authorized: true }, requestId);
}

async function handleAdminMessageAccess(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  await requireDirectoryPermission(options.security.pool, context.userId, ADMIN_PERMISSION.imSupportRead);
  const query = routeQuery(request);
  const operation = parseMessageOperation(query.get("operation"));
  await readAdminMessageAccess(options.consultation, context, messageConversationId(query.get("conversationId")), operation === "send");
  sendJson(response, 200, { authorized: true }, requestId);
}

type MessageAccess = { viewerAccountId: string; peerAccountId: string; scope?: ImOrderImageScope };

async function readMessageAccess(options:YunxinRouteOptions,actor:({realm:"user"}&Awaited<ReturnType<typeof readUserContext>>)|({realm:"admin"}&Awaited<ReturnType<typeof readAdminContext>>),conversationId:string,send=false):Promise<MessageAccess>{
  const teamId=/^[^|]+\|2\|([0-9]{1,19})$/.exec(conversationId)?.[1];
  if(teamId){
    const access=await withTransaction(options.security.pool,async c=>{
      const row=(await c.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE app_id=$1 AND team_id=$2`,[options.appId,teamId])).rows[0];
      if(!row)return null;
      const result=await readOrderTeamAccess(c,actor,row.order_id,send?"send":"read");
      if(result.canRead!==true||result.conversationId!==conversationId)throw new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
      return {viewerAccountId:result.viewerAccountId as string,peerAccountId:teamId,scope:{appId:options.appId,orderId:result.orderId as string,teamId:result.teamId as string}};
    });
    if(access)return access;
  }
  return actor.realm==="user"?readUserMessageAccess(options.consultation!,actor,conversationId):readAdminMessageAccess(options.consultation!,actor,conversationId,send);
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

async function handleUserMessages(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const transport = options.consultation?.messageTransport;
  if (!options.consultation || !transport) {
    sendUnavailable(response, requestId);
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
  const access = await readMessageAccess(options, {...context,realm:"user"}, input.conversationId,true);
  if (input.kind === "text") {
    sendJson(response, 200, { message: publicMessage(await transport.sendText({ conversationId: input.conversationId, senderAccountId: access.viewerAccountId, receiverAccountId: access.peerAccountId, text: input.text }), "user") }, requestId);
    return;
  }
  if (!transport.sendImage) {
    sendUnavailable(response, requestId);
    return;
  }
  const image = input.image;
  if (!access.scope) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Order Team image access denied");
  sendJson(response, 200, { message: publicMessage(await transport.sendImage({ conversationId: input.conversationId, scope: access.scope, senderAccountId: access.viewerAccountId, receiverAccountId: access.peerAccountId, messageClientId: image.messageClientId, name: image.name, mimeType: image.mimeType, size: image.size, body: image.body, width: image.width, height: image.height }), "user") }, requestId);
}

async function handleAdminMessages(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const transport = options.consultation?.messageTransport;
  if (!options.consultation || !transport) {
    sendUnavailable(response, requestId);
    return;
  }
  const context = await readAdminContext(request, options.security);
  await requireDirectoryPermission(options.security.pool, context.userId, ADMIN_PERMISSION.imSupportRead);
  if (request.method?.toUpperCase() === "GET") {
    const conversationId = messageConversationId(routeQuery(request).get("conversationId"));
    const access = await readMessageAccess(options, {...context,realm:"admin"}, conversationId);
    sendJson(response, 200, { messages: (await transport.history({ conversationId, viewerAccountId: access.viewerAccountId, limit: parseLimit(routeQuery(request).get("limit")),before:messageBefore(request) })).map(message => publicMessage(message, "admin")) }, requestId);
    return;
  }
  const input = await parseMessageBody(request.body);
  const access = await readMessageAccess(options, {...context,realm:"admin"}, input.conversationId, true);
  if (input.kind === "text") {
    sendJson(response, 200, { message: publicMessage(await transport.sendText({ conversationId: input.conversationId, senderAccountId: access.viewerAccountId, receiverAccountId: access.peerAccountId, text: input.text }), "admin") }, requestId);
    return;
  }
  if (!transport.sendImage) {
    sendUnavailable(response, requestId);
    return;
  }
  const image = input.image;
  if (!access.scope) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Order Team image access denied");
  sendJson(response, 200, { message: publicMessage(await transport.sendImage({ conversationId: input.conversationId, scope: access.scope, senderAccountId: access.viewerAccountId, receiverAccountId: access.peerAccountId, messageClientId: image.messageClientId, name: image.name, mimeType: image.mimeType, size: image.size, body: image.body, width: image.width, height: image.height }), "admin") }, requestId);
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

async function handleAdminConsultations(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions, action?: { id: string; name: "claim" | "transfer" | "close" | "reconcile" }): Promise<void> {
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
  if (action.name === "reconcile") {
    const body = request.body;
    if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body) || Object.keys(body as Record<string, unknown>).length !== 0)) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Reconcile body must be empty");
    }
    sendJson(response, 200, await retryMessageScopeOperation(options.consultation, context, action.id, requestId), requestId);
    return;
  }
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body as Record<string, unknown>).length !== 1 || typeof (body as Record<string, unknown>).targetAdminId !== "string") {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Target administrator is required");
  }
  sendJson(response, 200, await transferConsultation(options.consultation, context, action.id, (body as { targetAdminId: string }).targetAdminId, requestId), requestId);
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
    if (path === "/user/message-access") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.userOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleUserMessageAccess(request, response, requestId, options);
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
    if (path === "/admin/message-access") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "GET" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminMessageAccess(request, response, requestId, options);
      return;
    }
    const actionMatch = /^\/admin\/consultations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(claim|transfer|close|reconcile)$/.exec(path);
    if (actionMatch) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "POST") {
        sendError(response, new SecurityApiError(method === "POST" ? 403 : 404, method === "POST" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, method === "POST" ? "Request rejected" : "Resource not found"), requestId);
        return;
      }
      await handleAdminConsultations(request, response, requestId, options, { id: actionMatch[1]!, name: actionMatch[2] as "claim" | "transfer" | "close" | "reconcile" });
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
    sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
  } catch (error) {
    if (error instanceof SecurityApiError) sendError(response, error, requestId);
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
