import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";
import { managedProfileImagePath } from "../profile/profile-avatar";
import { supportSettings } from "./support-settings";
import { readCopySettings } from "./read-copy";
import { aftersaleId, createAftersale, listAftersales, claimAftersale, resolveAftersale, parseAftersaleClaim, readAftersaleForAdmin, assertAftersaleUserActive } from "./aftersale";
import { withTransaction } from "../auth/security-core";
import { parseImSendIntent, parseImReceipt, imFactId, storeImHiddenFact, insertImSentFact, planImRevoke, finishImRevoke, readImHistoryFilters, type ImReceiptActor, type ImReceiptMessage } from "./message-receipts";
import { markOrderGroupRead, readOrderTeamAccess, recordOrderGroupMessage } from "./order-team-access";

import { ADMIN_PERMISSION, requireDirectoryPermission } from "../auth/admin-directory";
import { hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import {
  readAdminContext,
  assertAdminContextInTransaction,
  SecurityApiError,
  type AuthSecurityNodeRequest,
  type AuthSecurityNodeResponse,
  type AuthSecurityOptions,
} from "../auth/auth-security";
import { readUserContext, assertUserContextInTransaction } from "../auth/user-identity";
import { YunxinApiError } from "./yunxin-provider";
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
  deriveYunxinAccountId,
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
  readConsultationLegacyOrderReference,
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
  recordConfirmedConsultationMessage,
  recordLocalAdminMessageSuccess,
  retryMessageScopeOperation,
  submitSupportRating,
  takeoverConsultation,
  prepareAftersaleConsultation,
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
  readPatrolConsultationAccess,
  requireSupportManagementRead,
  readSupportOverview,
  readOwnSupportStatistics,
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
  readCopyReceiverReady?: boolean;
  repository: ImIdentityRepository;
  provisioner: ImIdentityProvisioner;
  tokenService: YunxinDynamicTokenService;
  consultation?: ConsultationRouteOptions;
};

async function handleAftersales(request:NodeRequest,response:NodeResponse,options:YunxinRouteOptions,requestId:string,realm:"user"|"admin",id?:string,action?:string):Promise<void>{
  const config=options.consultation;
  if(!config){sendUnavailable(response,requestId);return;}
  const method=request.method?.toUpperCase(),query=routeQuery(request);
  if(id){
    if(realm!=="admin"||method!=="POST"||query.size)throw new SecurityApiError(404,"NOT_FOUND","Resource not found");
    aftersaleId(id);const context=await readAdminContext(request,options.security);
    if(action==="claim"){sendJson(response,200,await claimAftersale(config,context,id,parseAftersaleClaim(request.body),requestId),requestId);return;}
    if(action==="resolve"){sendJson(response,200,await resolveAftersale(config,context,id,request.body,requestId),requestId);return;}
    if(action!=="contact"||!request.body||typeof request.body!=="object"||Array.isArray(request.body)||Object.keys(request.body).length)throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid contact request");
    const before=await readAftersaleForAdmin(config,context,id,true);
    if(before.record.state!=="PENDING")throw new SecurityApiError(409,"CONFLICT","该售后记录已处理。");
    await withTransaction(config.pool,async client=>{await assertAdminContextInTransaction(client,context);await assertAftersaleUserActive(client,before.requesterUserId);});
    const provisioned=await options.provisioner.ensure({key:keyFor(options.appId,"user","USER",before.requesterUserId)});
    if(provisioned.outcome!=="READY")throw new SecurityApiError(503,"IM_UNAVAILABLE","用户咨询通道正在准备，请保留记录后重试。");
    const prepared=await prepareAftersaleConsultation(config,context,id,requestId);
    const result=prepared.state==="ACTIVE"&&prepared.assignedAdminId!==context.userId
      ? await takeoverConsultation(config,context,prepared.id,requestId,null)
      : await claimConsultation(config,context,prepared.id,requestId,id);
    if(result.consultation.state!=="ACTIVE"||result.consultation.assignedAdmin?.id!==context.userId||result.consultation.messageScopeState!=="READY"||result.consultation.canSend!==true)throw Object.assign(new SecurityApiError(503,"IM_UNAVAILABLE","咨询通道尚未就绪，售后记录已保留，请稍后重试。"),{reason:"AFTERSALE_CONTACT_PENDING"});
    const current=await readAftersaleForAdmin(config,context,id,true);
    const claimed=await claimAftersale(config,context,id,current.record.version,requestId);
    sendJson(response,200,{...claimed,consultation:result.consultation},requestId);return;
  }
  const keys=realm==="user"?["orderId","orderSource","cursor"]:["orderId","state","cursor"];
  for(const key of query.keys())if(!keys.includes(key)||query.getAll(key).length!==1)throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid aftersale query");
  if(realm==="user"){
    const context=await readUserContext(request,options.security);
    if(method==="POST"){if(query.size)throw new SecurityApiError(400,"INVALID_ARGUMENT","Unexpected query");sendJson(response,200,await createAftersale(config,context,request.body,requestId),requestId);return;}
    if(method==="GET"){sendJson(response,200,await listAftersales(config,{...context,realm:"user"},{orderId:query.get("orderId")??undefined,orderSource:query.get("orderSource")??undefined,cursor:query.get("cursor")??undefined}),requestId);return;}
  }else if(method==="GET"){
    const context=await readAdminContext(request,options.security);
    sendJson(response,200,await listAftersales(config,{...context,realm:"admin"},{orderId:query.get("orderId")??undefined,state:query.get("state")??undefined,cursor:query.get("cursor")??undefined}),requestId);return;
  }
  throw new SecurityApiError(404,"NOT_FOUND","Resource not found");
}

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
  const reason=(error as SecurityApiError & {reason?:unknown}).reason;
  sendJson(response, error.status, { error: { code: error.code, message: error.message, requestId, ...(["SUPPORT_AT_CAPACITY","AFTERSALE_USER_UNAVAILABLE","AFTERSALE_CONTACT_PENDING"].includes(String(reason))?{reason}:{}) } }, requestId);
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
async function recordSupportPreview(options: YunxinRouteOptions, conversationId: string, preview: string, fromUser = false, actor?: {userId:string;sessionId:string}): Promise<boolean> {
  if (!options.consultation) return false;
  try {
    if (await recordSupportThreadMessage(options.consultation, conversationId, preview, fromUser)) { if(actor)await recordLocalAdminMessageSuccess(options.consultation,actor,conversationId);return true; }
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

function messageIntent(query:URLSearchParams) {
  for(const key of ["operation","conversationId","messageClientId","messageType","entryIntent"])if(query.getAll(key).length>1)throw new SecurityApiError(400,"INVALID_ARGUMENT","Duplicate message access argument");
  const type=query.get("messageType");
  if(type!==null&&!/^(0|1|2|3|6)$/.test(type))throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid message type");
  return parseImSendIntent(query.get("messageClientId")??undefined,type===null?undefined:Number(type));
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
  const intent=messageIntent(query);
  if(intent&&operation!=="send")throw new SecurityApiError(400,"INVALID_ARGUMENT","Unexpected message intent");
  const entry=query.get("entryIntent");
  if(entry!==null&&(operation!=="send"||!["SERVICE","COMPLAINT"].includes(entry)))throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid entry intent");
  await readUserMessageAccess(options.consultation, context, messageConversationId(query.get("conversationId")), operation === "send",intent,entry==="COMPLAINT"?"COMPLAINT":"SERVICE");
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
  const intent=messageIntent(query);
  if(intent&&operation!=="send")throw new SecurityApiError(400,"INVALID_ARGUMENT","Unexpected message intent");
  await readAdminMessageAccess(options.consultation, context, messageConversationId(query.get("conversationId")), operation === "send", requestId,intent);
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
    if (await recordSupportPreview(options, input.conversationId, input.text, fromUser,actor.realm==="admin"?actor:undefined) && fromUser) wakeConsultationAutoAssign(options);
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
    if(request.method?.toUpperCase()==="POST"&&(request.body as {kind?:unknown})?.kind==="receipt"){
      await handleRealReceipt(request,response,requestId,options,{...await readUserContext(request,options.security),realm:"user"});return;
    }
    if(request.method?.toUpperCase()==="POST"&&(request.body as {kind?:unknown})?.kind==="revoke"){
      await handleRealRevoke(request,response,requestId,options,{...await readUserContext(request,options.security),realm:"user"});return;
    }
    throw new SecurityApiError(400,"INVALID_ARGUMENT","A confirmed SDK receipt is required");
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

type HistorySenderView = { displayName: string; avatar: string | null; role: "USER" | "ADMIN" | "SYSTEM"; platformId?: string; displayUsername?: string };
async function historySenders(options: YunxinRouteOptions, accountIds: string[]): Promise<Map<string, HistorySenderView>> {
  const senders = new Map<string, HistorySenderView>();
  if (!accountIds.length) return senders;
  const rows = (await options.security.pool.query<{accountId:string;kind:string;name:string|null;image:string|null;platformId:string|null;displayUsername:string|null}>(`
    SELECT m.account_id AS "accountId",m.identity_kind AS kind,
      CASE WHEN m.identity_kind='USER' THEN u.id WHEN m.identity_kind='ADMIN' THEN a.id END AS "platformId",
      CASE WHEN m.identity_kind='ADMIN' THEN COALESCE(NULLIF(a."displayUsername",''),UPPER(a.username)) END AS "displayUsername",
      CASE WHEN m.identity_kind='USER' THEN COALESCE(NULLIF(btrim(u.name),''),NULLIF(btrim(u.username),''))
        WHEN m.identity_kind='ADMIN' THEN NULLIF(btrim(a.name),'') END AS name,
      CASE WHEN m.identity_kind='USER' THEN u.image WHEN m.identity_kind='ADMIN' THEN a.image END AS image
    FROM zzsh_iam.im_identity_mapping m
    LEFT JOIN zzsh_auth_user."user" u ON m.identity_kind='USER' AND m.platform_subject_id=u.id
    LEFT JOIN zzsh_auth_admin."user" a ON m.identity_kind='ADMIN' AND m.platform_subject_id=a.id
    WHERE m.provider='yunxin' AND m.app_id=$1 AND m.account_id=ANY($2::text[])
  `,[options.appId,[...new Set(accountIds)]])).rows;
  for (const row of rows) {
    if (!["USER","ADMIN","SYSTEM"].includes(row.kind)) continue;
    const publicLogin = typeof row.displayUsername === "string" ? row.displayUsername.trim().toUpperCase() : "";
    const displayUsername = /^ZZ\d{1,19}$/.test(publicLogin) ? publicLogin : null;
    const avatar = managedProfileImagePath(row.image);
    senders.set(row.accountId,{displayName:row.kind==='SYSTEM'?'洲洲助手':row.name?.trim()||(row.kind==='ADMIN'?'平台客服':'平台用户'),avatar,role:row.kind as HistorySenderView['role'],
      ...(row.kind!=='SYSTEM'&&row.platformId?{platformId:row.platformId}:{}),
      ...(row.kind==='ADMIN'&&displayUsername?{displayUsername}:{})});
  }
  return senders;
}

async function readRealAdminHistory(request:NodeRequest,options:YunxinRouteOptions,context:Awaited<ReturnType<typeof readAdminContext>>,requestId:string){
  const query=routeQuery(request),conversationId=messageConversationId(query.get("conversationId"));
  for(const key of query.keys())if(!["mode","conversationId","limit","cursor","history","opening","before","beforeTime"].includes(key)||query.getAll(key).length!==1)throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid history argument");
  if(query.has("cursor")&&(query.has("before")||query.has("beforeTime"))||query.has("before")!==query.has("beforeTime"))throw new SecurityApiError(400,"INVALID_ARGUMENT","Conflicting history anchor");
  if(query.has("cursor")&&!query.get("cursor"))throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid history cursor");
  const mode=query.get("mode")??(query.has("history")||query.has("opening")?"member":"patrol");
  if(!["member","patrol"].includes(mode))throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid history mode");
  const teamId=/^[^|]+\|2\|([0-9]{1,19})$/.exec(conversationId)?.[1];
  if(!teamId)throw new SecurityApiError(403,"FORBIDDEN","Team history required");
  const actor={...context,realm:"admin" as const};
  const authorize=async():Promise<MessageAccess>=>{
    if(mode==="member")return readMessageAccess(options,actor,conversationId,false,false,requestId);
    return withTransaction(options.security.pool,async client=>{
      const access=await loadEffectiveAdminAccess(client,context.userId);requireSupportManagementRead(access);
      const input={appId:options.appId,teamId,conversationId,requestId};
      const result=await readPatrolOrderTeamAccess(client,input,context)??await readPatrolConsultationAccess(client,input,context);
      if(!result)throw new SecurityApiError(403,"FORBIDDEN","History access denied");return result;
    });
  };
  const access=await authorize(),limit=parseLimit(query.get("limit"));
  let before:{id:string;time:number}|undefined;
  const cursor=query.get("cursor");
  if(cursor){
    try{if(cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();const c:unknown=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));
      if(!Array.isArray(c)||c.length!==5||c[0]!==options.appId||c[1]!==access.viewerAccountId||c[2]!==conversationId||!Number.isSafeInteger(c[3])||c[3]<=0||typeof c[4]!=="string"||!/^[1-9][0-9]{0,19}$/.test(c[4]))throw new Error();before={time:c[3],id:c[4]};
    }catch{throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid history cursor");}
  }else if(query.has("before")){
    const id=messageBefore(request),time=Number(query.get("beforeTime"));
    if(!id||!Number.isSafeInteger(time)||time<=0)throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid history anchor");before={id,time};
  }
  const provider=options.consultation?.provider,manager=options.consultation?.supportManager;
  if(!provider?.readSupportMemberHistory||!manager)throw new SecurityApiError(503,"IM_UNAVAILABLE","History provider unavailable");
  const managerId=deriveYunxinAccountId(manager.key),team=await provider.getSupportTeam(teamId);
  if(!team||team.ownerAccountId!==managerId)throw new SecurityApiError(503,"IM_UNAVAILABLE","History Team binding requires review");
  let marker:Record<string,unknown>;try{if(typeof team.serverExtension!=="string")throw new Error();marker=JSON.parse(team.serverExtension);if(!marker||typeof marker!=="object"||Array.isArray(marker))throw new Error();}catch{throw new SecurityApiError(503,"IM_UNAVAILABLE","History Team binding requires review");}
  if(marker.appId!==options.appId)throw new SecurityApiError(403,"FORBIDDEN","History App mismatch");
  if(access.scope){if(marker.schema!=="zzsh.im-order.v1"||marker.orderId!==access.scope.orderId)throw new SecurityApiError(403,"FORBIDDEN","History order mismatch");}
  else {
    const bindings=(await options.security.pool.query<{id:string}>(`SELECT id FROM zzsh_iam.im_support_thread WHERE app_id=$1 AND message_scope_id=$2
      UNION ALL SELECT id FROM zzsh_iam.im_consultation WHERE app_id=$1 AND message_scope_id=$2
        AND message_scope_state='READY' AND state='CLOSED'`,[options.appId,teamId])).rows;
    if(marker.schema!=="zzsh.im-consultation.v1"||!bindings.some(row=>marker.consultationId===row.id))throw new SecurityApiError(403,"FORBIDDEN","History thread mismatch");
  }
  const all=await provider.readSupportMemberHistory({teamId,accountId:managerId,limit:Math.min(limit+1,100),...(before?{before}:{})});
  all.sort((a,b)=>b.createTime-a.createTime||(BigInt(a.messageServerId)<BigInt(b.messageServerId)?1:BigInt(a.messageServerId)>BigInt(b.messageServerId)?-1:0));
  const raw=all.slice(0,limit),hasMore=limit<100?all.length>limit:all.length===100;
  const senders=await historySenders(options,raw.map(message=>message.senderId));
  const latest=await authorize();if(latest.viewerAccountId!==access.viewerAccountId)throw new SecurityApiError(403,"FORBIDDEN","History identity changed");
  const filters=await withTransaction(options.security.pool,async client=>{await assertAdminContextInTransaction(client,context);return readImHistoryFilters(client,options.appId,access.viewerAccountId,raw.map(m=>m.messageServerId));});
  const messages=raw.filter(m=>!filters.hidden.has(m.messageServerId)).map(m=>filters.revoked.has(m.messageServerId)
    ?{messageServerId:m.messageServerId,messageClientId:m.messageClientId,senderId:m.senderId,createTime:m.createTime,conversationId,conversationType:2,receiverId:teamId,messageType:0,text:"",revoked:true}
    :{...m,conversationId,conversationType:2,receiverId:teamId});
  const oldest=raw.at(-1),nextCursor=hasMore&&oldest?Buffer.from(JSON.stringify([options.appId,access.viewerAccountId,conversationId,oldest.createTime,oldest.messageServerId])).toString("base64url"):null;
  return {messages:messages.map(message=>({...message,...(senders.has(message.senderId)?{sender:senders.get(message.senderId)}:{})})),hasMore,nextCursor};
}

async function assertReceiptActor(client:PoolClient,actor:ImReceiptActor):Promise<void>{
  if(actor.realm==="user")await assertUserContextInTransaction(client,actor);
  else {
    await assertAdminContextInTransaction(client,actor);
    const access=await loadEffectiveAdminAccess(client,actor.userId);
    if(!hasPermission(access,"im.support.read"))throw new SecurityApiError(403,"FORBIDDEN","Permission required");
  }
}
function receiptAccount(options:YunxinRouteOptions,actor:ImReceiptActor):string {
  return deriveYunxinAccountId(keyFor(options.appId,actor.realm,actor.realm==="user"?"USER":"ADMIN",actor.userId));
}
function receiptPreview(type:number,text?:string):string {
  return type===0?text??"[文字消息]":type===1?"[图片]":type===2?"[语音]":type===3?"[视频]":"[文件]";
}
async function handleRealReceipt(request:NodeRequest,response:NodeResponse,requestId:string,options:YunxinRouteOptions,actor:ImReceiptActor):Promise<void>{
  const receipt=parseImReceipt(request.body),message=receipt.message,account=receiptAccount(options,actor);
  await withTransaction(options.security.pool,client=>assertReceiptActor(client,actor));
  if(receipt.action==="hidden"){
    await readMessageAccess(options,actor as MessageActor,message.conversationId,false,false,requestId);
    await withTransaction(options.security.pool,async client=>{await assertReceiptActor(client,actor);await storeImHiddenFact(client,options.appId,account,actor,message);});
    sendJson(response,200,{recorded:true},requestId);return;
  }
  if(account!==message.senderId)throw new SecurityApiError(403,"FORBIDDEN","Message sender mismatch");
  const prior=(await options.security.pool.query<{details:ImReceiptMessage}>(`SELECT details FROM zzsh_iam.audit_event WHERE id=$1`,[imFactId("sent",options.appId,account,message.messageClientId)])).rows[0]?.details;
  if(prior){
    if(prior.messageServerId!==message.messageServerId||prior.conversationId!==message.conversationId||prior.messageType!==message.messageType)throw new SecurityApiError(409,"CONFLICT","Conflicting message receipt");
    sendJson(response,200,{recorded:true,duplicate:true},requestId);return;
  }
  const mapping=await options.repository.findByKey(keyFor(options.appId,actor.realm,actor.realm==="user"?"USER":"ADMIN",actor.userId));
  if(!mapping||mapping.status!=="READY"||mapping.accountId!==account)throw new SecurityApiError(403,"FORBIDDEN","Message identity unavailable");
  const teamId=/^[^|]+\|2\|([0-9]{1,19})$/.exec(message.conversationId)?.[1];
  const provider=options.consultation?.provider,manager=options.consultation?.supportManager;
  if(!teamId||!provider?.readSupportMessage||!manager)throw new SecurityApiError(503,"IM_UNAVAILABLE","Message verification unavailable");
  const fact=await provider.readSupportMessage({teamId,operatorAccountId:deriveYunxinAccountId(manager.key),messageServerId:message.messageServerId,messageTime:message.createTime});
  if(!fact)throw new SecurityApiError(503,"IM_UNAVAILABLE","Message verification pending");
  if(fact.senderId!==account||fact.teamId!==teamId||fact.messageType!==message.messageType||fact.messageClientId&&fact.messageClientId!==message.messageClientId)throw new SecurityApiError(403,"FORBIDDEN","Message proof mismatch");
  const confirmed={...message,createTime:fact.createTime},preview=receiptPreview(fact.messageType,fact.text);
  const order=(await options.security.pool.query<{order_id:string}>(`SELECT order_id FROM zzsh_order.im_order_group WHERE app_id=$1 AND team_id=$2`,[options.appId,teamId])).rows[0];
  let inserted:boolean;
  if(order){
    inserted=await withTransaction(options.security.pool,async client=>{
      await assertReceiptActor(client,actor);await readOrderTeamAccess(client,actor,order.order_id,"read");
      const fresh=await insertImSentFact(client,options.appId,account,actor,confirmed,order.order_id);
      if(fresh)await recordOrderGroupMessage(client,options.appId,message.conversationId,preview);return fresh;
    });
  }else inserted=await recordConfirmedConsultationMessage(options.consultation!,actor,confirmed,preview);
  if(inserted&&actor.realm==="user")wakeConsultationAutoAssign(options);
  sendJson(response,200,{recorded:true,duplicate:!inserted},requestId);
}

async function handleRealRevoke(request:NodeRequest,response:NodeResponse,requestId:string,options:YunxinRouteOptions,actor:ImReceiptActor):Promise<void>{
  const input=request.body as {message?:unknown};
  const message=parseImReceipt({kind:"receipt",action:"hidden",message:input?.message}).message,account=receiptAccount(options,actor);
  await withTransaction(options.security.pool,client=>assertReceiptActor(client,actor));
  if(message.senderId!==account)throw new SecurityApiError(403,"FORBIDDEN","Only the message author may revoke");
  const guard=imFactId("revoke_guard",options.appId,"system",message.messageServerId);
  const last=(await options.security.pool.query<{action:string;actor_id:string}>(`SELECT action,actor_id FROM zzsh_iam.audit_event WHERE object_type='im_message_revoke' AND object_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1`,[guard])).rows[0];
  if(last?.actor_id===actor.userId&&last.action==="im.message.revoke.completed"){sendJson(response,200,{revoked:true},requestId);return;}
  const unknown=()=>sendJson(response,409,{revoked:false,outcome:"UNKNOWN",error:{code:"CONFLICT",message:"撤回结果未确认，请由平台核对，勿重复提交。"}},requestId);
  if(last?.action==="im.message.revoke.started"){unknown();return;}
  await readMessageAccess(options,actor as MessageActor,message.conversationId,actor.realm==="admin",false,requestId);
  const teamId=/^[^|]+\|2\|([0-9]{1,19})$/.exec(message.conversationId)?.[1];
  const provider=options.consultation?.provider,manager=options.consultation?.supportManager;
  if(!teamId||!provider?.readSupportMessage||!provider.revokeSupportMessage||!manager)throw new SecurityApiError(503,"IM_UNAVAILABLE","Message revoke unavailable");
  const fact=await provider.readSupportMessage({teamId,operatorAccountId:deriveYunxinAccountId(manager.key),messageServerId:message.messageServerId,messageTime:message.createTime});
  if(!fact||fact.senderId!==account||fact.teamId!==teamId)throw new SecurityApiError(403,"FORBIDDEN","Message author proof required");
  const confirmed={...message,createTime:fact.createTime};
  const state=await withTransaction(options.security.pool,async client=>{await assertReceiptActor(client,actor);return planImRevoke(client,options.appId,account,actor,message,requestId);});
  if(state==="SUCCEEDED"){sendJson(response,200,{revoked:true},requestId);return;}
  if(state==="UNKNOWN"){unknown();return;}
  try{await provider.revokeSupportMessage({teamId,senderId:account,messageServerId:message.messageServerId,createTime:fact.createTime});}
  catch(error){
    if(error instanceof YunxinApiError&&[403,414,416].includes(error.providerCode??0)){
      await withTransaction(options.security.pool,client=>finishImRevoke(client,options.appId,account,actor,confirmed,requestId,false));
      throw new SecurityApiError(error.providerCode===416?503:409,error.providerCode===416?"IM_UNAVAILABLE":"CONFLICT","当前消息无法撤回，请稍后核对。");
    }
    unknown();return;
  }
  await withTransaction(options.security.pool,client=>finishImRevoke(client,options.appId,account,actor,confirmed,requestId,true));
  sendJson(response,200,{revoked:true},requestId);
}

async function handleAdminMessages(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const transport = options.consultation?.messageTransport;
  if (!options.consultation) {
    sendUnavailable(response, requestId);
    return;
  }
  // 与用户侧对称：真实通道没有服务端消息通道，客服正文也由浏览器 NIM 直连发出。
  // 这里只登记预览事实（谁接待、最后一句是什么），仍先过同一份客服访问校验。
  if (!transport) {
    const actor={...await readAdminContext(request,options.security),realm:"admin" as const};
    if(request.method?.toUpperCase()==="GET"){
      await requireAdminImRead(options.security.pool,actor.userId);
      sendJson(response,200,await readRealAdminHistory(request,options,actor,requestId),requestId);return;
    }
    if((request.body as {kind?:unknown})?.kind==="receipt"){await handleRealReceipt(request,response,requestId,options,actor);return;}
    if((request.body as {kind?:unknown})?.kind==="revoke"){await handleRealRevoke(request,response,requestId,options,actor);return;}
    throw new SecurityApiError(400,"INVALID_ARGUMENT","A confirmed SDK receipt is required");
  }
  const context = await readAdminContext(request, options.security);
  await requireAdminImRead(options.security.pool, context.userId);
  if (request.method?.toUpperCase() === "GET") {
    const conversationId = messageConversationId(routeQuery(request).get("conversationId"));
    const query=routeQuery(request),limit=parseLimit(query.get("limit"));
    if(query.get("mode")==="patrol")requireSupportManagementRead(await loadEffectiveAdminAccess(options.security.pool,context.userId));
    const access = await readMessageAccess(options, {...context,realm:"admin"}, conversationId, false, true, requestId);
    const before=query.get("cursor")??messageBefore(request);
    if(before&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(before))throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid history cursor");
    const messages=(await transport.history({conversationId,viewerAccountId:access.viewerAccountId,limit,before:before??undefined})).map(message=>publicMessage(message,"admin"));
    const oldest=messages.at(-1);
    sendJson(response,200,{messages,hasMore:messages.length===limit,nextCursor:messages.length===limit&&oldest?oldest.messageServerId??oldest.messageClientId:null},requestId);
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
    await recordSupportPreview(options, input.conversationId, input.text,false,context);
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
    await recordSupportPreview(options, input.conversationId, MEDIA_MESSAGE_PREVIEW[media.kind],false,context);
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
  await recordSupportPreview(options, input.conversationId, "[图片]",false,context);
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

function supportReportQuery(query: URLSearchParams): { date: string | null; dateTo: string | undefined } {
  strictQuery(query, ["date", "dateFrom", "dateTo"]);
  const range = query.has("dateFrom") || query.has("dateTo");
  if (range && (query.has("date") || !query.has("dateFrom") || !query.has("dateTo")))
    throw new SecurityApiError(400, "INVALID_ARGUMENT", "Use date or both dateFrom/dateTo");
  return { date: range ? query.get("dateFrom") : query.get("date"), dateTo: range ? query.get("dateTo")! : undefined };
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
  const query = supportReportQuery(routeQuery(request));
  const context = await readAdminContext(request, options.security);
  sendJson(response, 200, await readSupportOverview({ pool: options.security.pool, appId: options.appId }, context, query.date, {
    capacityLimit: options.consultation?.supportConcurrency,
    firstResponseSeconds: options.consultation?.firstResponseSeconds,
  }, query.dateTo), requestId);
}

async function handleAdminHandovers(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const query = routeQuery(request);
  strictQuery(query, ["limit"]);
  const context = await readAdminContext(request, options.security);
  sendJson(response, 200, await listSupportHandovers({ pool: options.security.pool, appId: options.appId }, context, query.get("limit")), requestId);
}

async function handleAdminAuditConversations(request: NodeRequest, response: NodeResponse, requestId: string, options: YunxinRouteOptions): Promise<void> {
  const query = routeQuery(request);
  strictQuery(query, ["limit", "cursor", "type", "adminUserId"]);
  const context = await readAdminContext(request, options.security);
  sendJson(response, 200, await listAuditConversations({ pool: options.security.pool, appId: options.appId }, context, query.get("limit"), query.get("cursor"), { type: query.get("type"), adminUserId: query.get("adminUserId") }), requestId);
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
    const aftersaleRoute=/^\/(user|admin)\/aftersales(?:\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(claim|contact|resolve))?$/.exec(path);
    if(aftersaleRoute){
      const realm=aftersaleRoute[1] as "user"|"admin";
      if(!originAllowed(request,[options.security.apiOrigin,realm==="user"?options.security.userOrigin:options.security.adminOrigin]))throw new SecurityApiError(403,"FORBIDDEN","Request rejected");
      await handleAftersales(request,response,options,requestId,realm,aftersaleRoute[2],aftersaleRoute[3]);return;
    }
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
    const legacyOrderMatch = /^\/admin\/consultations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/legacy-orders\/(legacy_order_[a-f0-9]{40})$/.exec(path);
    if (legacyOrderMatch) {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin]) || method !== "GET") {
        sendError(response, new SecurityApiError(method === "GET" ? 403 : 404, method === "GET" ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, "Request rejected"), requestId);
        return;
      }
      if (!options.consultation) { sendUnavailable(response, requestId); return; }
      if (routeQuery(request).size) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Query is invalid");
      const context = await readAdminContext(request, options.security);
      sendJson(response, 200, await readConsultationLegacyOrderReference(options.consultation, context, legacyOrderMatch[1]!, legacyOrderMatch[2]!), requestId);
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
    if (path === "/admin/read-copy-settings") {
      if (!originAllowed(request, [options.security.apiOrigin, options.security.adminOrigin])) throw new SecurityApiError(403, "FORBIDDEN", "Request rejected");
      if (method !== "GET" && method !== "PUT") throw new SecurityApiError(404, "NOT_FOUND", "Resource not found");
      if (routeQuery(request).size) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Unexpected settings argument");
      if (method === "PUT" && request.body === undefined) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Settings body required");
      const context = await readAdminContext(request, options.security);
      sendJson(response, 200, await readCopySettings({ pool: options.security.pool, appId: options.appId,
        receiverReady: options.readCopyReceiverReady === true }, context, method === "GET" ? undefined : request.body, requestId), requestId);
      return;
    }
    if (path === "/admin/support-settings") {
      if(!originAllowed(request,[options.security.apiOrigin,options.security.adminOrigin]))throw new SecurityApiError(403,"FORBIDDEN","Request rejected");
      if(method!=="GET"&&method!=="PUT")throw new SecurityApiError(404,"NOT_FOUND","Resource not found");
      if(!options.consultation){sendUnavailable(response,requestId);return;}
      const context=await readAdminContext(request,options.security);
      if(routeQuery(request).size)throw new SecurityApiError(400,"INVALID_ARGUMENT","Unexpected settings argument");
      sendJson(response,200,await supportSettings(options.consultation,context,method==="GET"?undefined:request.body,requestId),requestId);return;
    }
    if (path === "/admin/my-support-statistics") {
      if (!originAllowed(request,[options.security.apiOrigin,options.security.adminOrigin]) || method !== "GET") {
        throw new SecurityApiError(method === "GET" ? 403 : 404,method === "GET" ? "FORBIDDEN" : "NOT_FOUND","Request rejected");
      }
      const query = supportReportQuery(routeQuery(request));
      const context = await readAdminContext(request,options.security);
      sendJson(response,200,await readOwnSupportStatistics({pool:options.security.pool,appId:options.appId},context,query.date,query.dateTo),requestId);
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
