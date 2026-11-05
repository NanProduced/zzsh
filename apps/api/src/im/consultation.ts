import { createImScopeLease, onLeaseConnection, lockTeamBinding, type ScopeLease } from "./scope-lease";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { storeImSendIntent, readImSendIntent, insertImSentFact, type ImSendIntent, type ImReceiptActor, type ImReceiptMessage } from "./message-receipts";
import { readSupportWelcome } from "./support-settings";
import { Injectable, Logger, type BeforeApplicationShutdown } from "@nestjs/common";

import {
  ADMIN_PERMISSION,
  hasPermission,
  loadEffectiveAdminAccess,
  type EffectiveAdminAccess,
} from "../auth/admin-authorization";
import { assertAdminContextInTransaction, type AdminContext } from "../auth/auth-security";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "../auth/security-core";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { assertAftersaleUserActive } from "./aftersale";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  normalizeImIdentityKey,
  type ImIdentityProvisionInput,
  type ImIdentityProvisioner,
  type ImIdentityKey,
  type ImProvisionResult,
} from "./identity-lifecycle";
import {
  YunxinApiError,
  YunxinTransportError,
  supportMarkerMatches,
  type YunxinSupportScopeApi,
  type YunxinSupportTeamExistenceLookup,
  type YunxinSupportTeamLookup,
  type YunxinSupportTeamState,
} from "./yunxin-provider";
import type { ImMessageTransport } from "./im-contract";
import { managedProfileImagePath } from "../profile/profile-avatar";
import { lockDispatchGate, lockSupportMutation, readEligibleSupport, reserveSupportCandidateOutcome, type LockedSupportRoster, type SupportQueueReason } from "./support-dispatch";
import { assignWaitingOrders } from "./order-dispatch";
import {
  readLatestHandoverNote,
  readSupportToday,
  recordSupportHandover,
  requireSupportManagementRead,
  resolveFirstResponseSeconds,
  SUPPORT_FIRST_RESPONSE_ACTION,
  SUPPORT_FIRST_RESPONSE_REMINDER_ACTION,
  type SupportDayCounts,
} from "./support-management";

export type SupportType = "SERVICE" | "COMPLAINT";
/** 用户进入咨询页的入口场景；仅用于欢迎语，线程 kind 仍归一 SERVICE。 */
export type ConsultationEntryIntent = SupportType;
export type ConsultationState = "WAITING" | "ACTIVE" | "CLOSED";
export type SupportThreadState = "IDLE" | "WAITING" | "ACTIVE";
export type SupportAvailability = "OFF_DUTY" | "AVAILABLE" | "PAUSED";
export type SupportConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "KICKED" | "AUTH_FAILED";

export type ConsultationRouteOptions = {
  /** Public DETAIL visibility is supplied by the existing publishing read path. */
  readPublicAccount?: (client: PoolClient, accountId: string) => Promise<Record<string, unknown>>;
  pool: Pool;
  appId: string;
  wakeDispatch?: () => void;
  provider?: YunxinSupportScopeApi;
  messageTransport?: ImMessageTransport;
  supportManager?: {
    key: ImIdentityKey;
    provisioner: Pick<ImIdentityProvisioner, "ensure">;
    /** 公开可访问的洲洲 IP 头像；本地/未配置时省略。 */
    avatarUrl?: string;
  };
  /** Auto-assign a waiting round to the least-recently assigned eligible online agent. */
  autoAssignConsultations?: boolean;
  /** 每客服同时接待上限（咨询 + 在租订单群）；默认 3，满载的客服不进候选。 */
  supportConcurrency?: number;
  /** 咨询首响 SLA 秒数；默认 120，与订单群首响提醒同口径。 */
  firstResponseSeconds?: number;
  /** Test-only barrier; runtime assembly never wires arbitrary callbacks. */
  testPresenceBarrier?: (context: AdminContext) => Promise<void>;
};

export const SUPPORT_MANAGER_SUBJECT_ID = "support-manager";

export function supportManagerIdentityKey(appId: string): ImIdentityKey {
  return { provider: "yunxin", appId, realm: "system", kind: "SYSTEM", platformSubjectId: SUPPORT_MANAGER_SUBJECT_ID };
}

export type SupportPresence = {
  adminUserId: string;
  availability: SupportAvailability;
  connectionState: SupportConnectionState;
  lastConnectedAt: string | null;
  activeLoad: number;
  version: number;
  today: SupportDayCounts;
};

export type SupportRoundRatingView = {
  /** 当前已结束轮次且未评价、未暂不评价时可评价。 */
  available: boolean;
  submitted: boolean;
  dismissed: boolean;
  score: number | null;
  comment?: string;
};

export type ConsultationView = {
  id: string;
  /** 持久线程 id：同一 user+kind 跨轮次不变。 */
  threadId: string;
  /** 本轮 id（与 id 相同，供 UI 明确轮次边界）。 */
  roundId: string;
  roundSeq: number;
  threadState: SupportThreadState;
  type: SupportType;
  state: ConsultationState;
  subjectRef: string | null;
  assignedAdmin: { id: string; name: string; avatar?: string | null } | null;
  peerAccountId: string | null;
  /** 平台“洲洲助手（Bot）”云信账号；欢迎语与自动卡片由它发出。 */
  botAccountId: string | null;
  conversationType: "TEAM";
  conversationId: string | null;
  messageScopeState: MessageScopeState;
  /** 当前视图角色是否可发送；服务端每次发送仍重新校验。 */
  canSend: boolean;
  version: number;
  lastMessageAt: string | null;
  /** 最近一条消息摘要：纯文本折叠截断，媒体为类型标签。 */
  lastMessagePreview: string | null;
  /** 用户视图：最近消息晚于本人线程已读时间；管理视图恒为 false。 */
  hasUnread: boolean;
  /** 用户视图：本轮尚未读的客服消息数；管理视图不返回。 */
  userUnreadCount?: number;
  /** 管理视图：本轮当前负责客服尚未读的用户消息数；用户视图不返回。 */
  adminUnreadCount?: number;
  /** 平台读取事件推进的轮次已读时间；不是 NIM 原生回执。 */
  adminReadAt: string | null;
  /** 管理视图：WAITING 且未分配 = 正在排队，与“没人接待”区分。 */
  queued?: boolean;
  /** 管理视图：用户首条消息时间与已等待秒数；未发声/已结束为 null。 */
  waitingSince?: string | null;
  queueWaitSeconds?: number | null;
  /** 本轮评价状态；只有用户自读列表按已结束轮次计算可用性。 */
  rating: SupportRoundRatingView;
  createdAt: string;
  updatedAt: string;
  user?: { id: string; name: string; username: string | null; avatar?: string | null };
};

export type MessageScopeState = "PENDING" | "PROVISIONING" | "READY" | "FAILED" | "TRANSFERRING" | "REVOKING" | "REVOKED";
export type MessageScopeOperationType = "CREATE" | "TRANSFER" | "CLOSE" | "ADD_MEMBER" | "ROUND_CLOSE";
export type MessageScopeOperationState = "PENDING" | "RUNNING" | "UNKNOWN" | "SUCCEEDED" | "FAILED" | "NEEDS_REVIEW";

type ScopeOperationRow = {
  id: string;
  appId: string;
  consultationId: string;
  operationType: MessageScopeOperationType;
  state: MessageScopeOperationState;
  scopeVersion: string | number;
  ownerAccountId: string;
  userAccountId: string;
  previousAdminId: string | null;
  targetAdminId: string | null;
  previousAdminAccountId: string | null;
  targetAdminAccountId: string | null;
  providerTeamId: string | null;
  attemptCount: string | number;
  leaseTokenHash: string | null;
  leaseUntil: Date | string | null;
  nextRetryAt: Date | string;
  lastFailureClass: string | null;
  lastFailureDetail: string | null;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$/;
const SUPPORT_TYPES = new Set<SupportType>(["SERVICE", "COMPLAINT"]);
const AVAILABILITY = new Set<SupportAvailability>(["OFF_DUTY", "AVAILABLE", "PAUSED"]);
const CONNECTION_STATES = new Set<SupportConnectionState>([
  "DISCONNECTED",
  "CONNECTING",
  "CONNECTED",
  "RECONNECTING",
  "KICKED",
  "AUTH_FAILED",
]);

type ConsultationRow = {
  id: string;
  userId: string;
  kind: SupportType;
  state: ConsultationState;
  userAccountId: string;
  peerAccountId: string | null;
  assignedAdminId: string | null;
  subjectRef: string | null;
  firstUserMessageAt?: Date | string | null;
  version: string | number;
  lastMessageAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  userName: string;
  userUsername: string | null;
  userImage?: string | null;
  adminName: string | null;
  adminImage?: string | null;
  appId: string | null;
  messageScopeType: "TEAM";
  messageScopeId: string | null;
  messageScopeState: MessageScopeState;
  messageScopeVersion: string | number;
  /** Thread columns are optional only for controlled SQL-seam fixtures; real selects always join them. */
  threadId?: string;
  roundSeq?: number;
  threadState?: SupportThreadState;
  threadScopeId?: string | null;
  threadScopeState?: MessageScopeState;
  threadPeerAccountId?: string | null;
  lastMessagePreview?: string | null;
  userReadAt?: Date | string | null;
  adminReadAt?: Date | string | null;
  userUnreadCount?: string | number | null;
  adminUnreadCount?: string | number | null;
};

type ThreadRow = {
  id: string;
  appId: string;
  userId: string;
  kind: SupportType;
  state: SupportThreadState;
  userAccountId: string;
  peerAccountId: string | null;
  messageScopeId: string | null;
  messageScopeState: MessageScopeState;
  lastRoundSeq: string | number;
  version: string | number;
};

type PresenceRow = {
  adminUserId: string;
  availability: SupportAvailability;
  connectionState: SupportConnectionState;
  lastConnectedAt: Date | string | null;
  activeLoad: number;
  version: string | number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message = "Request validation failed"): SecurityApiError {
  return new SecurityApiError(400, "INVALID_ARGUMENT", message);
}

function conflict(message: string): SecurityApiError {
  return new SecurityApiError(409, "CONFLICT", message);
}

function unavailable(message = "IM service is temporarily unavailable"): SecurityApiError {
  return new SecurityApiError(503, "IM_UNAVAILABLE", message);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function numberValue(value: string | number): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("IM numeric value is invalid");
  return result;
}

export function parseLimit(value: string | null | undefined): number {
  if (value === undefined || value === null || value === "") return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
  return limit;
}

export function parseSupportType(value: unknown): SupportType {
  if (typeof value !== "string" || !SUPPORT_TYPES.has(value as SupportType)) throw invalid("Support type is invalid");
  return value as SupportType;
}

function parseSubjectRef(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invalid("Subject reference is invalid");
  return value;
}

export function parseConsultationBody(value: unknown): { type: SupportType; entryIntent: ConsultationEntryIntent; subjectRef: string | null } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  const allowed = new Set(["type", "subjectRef"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalid("Request body contains an unknown field");
  const entryIntent = parseSupportType(value.type);
  // 投诉入口已并入普通咨询：旧客户端仍可传 COMPLAINT，新建请求只落到 SERVICE 线程；
  // 原始入口意图只决定欢迎语文案，不改变线程 kind。
  return { type: entryIntent === "COMPLAINT" ? "SERVICE" : entryIntent, entryIntent, subjectRef: parseSubjectRef(value.subjectRef) };
}

export function parsePresenceBody(value: unknown): { availability: SupportAvailability; connectionState: SupportConnectionState; version?: number } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  if (Object.keys(value).some((key) => key !== "availability" && key !== "connectionState" && key !== "version")) throw invalid("Request body contains an unknown field");
  if (typeof value.availability !== "string" || !AVAILABILITY.has(value.availability as SupportAvailability)) throw invalid("Availability is invalid");
  if (typeof value.connectionState !== "string" || !CONNECTION_STATES.has(value.connectionState as SupportConnectionState)) throw invalid("Connection state is invalid");
  if (value.version !== undefined && (!Number.isSafeInteger(value.version) || (value.version as number) < 0)) throw invalid("Presence version is invalid");
  return {
    availability: value.availability as SupportAvailability,
    connectionState: value.connectionState as SupportConnectionState,
    ...(value.version === undefined ? {} : { version: value.version as number }),
  };
}

/** 评价分值只接受 1..5 整数；文字可选，去首尾空白后按码点不超过 200。 */
export function parseSupportRatingBody(value: unknown): { score: number; comment: string | null } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  if (Object.keys(value).some((key) => key !== "score" && key !== "comment")) throw invalid("Request body contains an unknown field");
  const score = value.score;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) throw invalid("Rating score is invalid");
  if (value.comment === undefined || value.comment === null) return { score, comment: null };
  if (typeof value.comment !== "string") throw invalid("Rating comment is invalid");
  const comment = value.comment.trim();
  if (!comment) return { score, comment: null };
  if ([...comment].length > 200) throw invalid("Rating comment is invalid");
  return { score, comment };
}

function teamConversationId(accountId: string, teamId: string): string {
  if (!ACCOUNT_PATTERN.test(accountId) || !/^[0-9]{1,19}$/.test(teamId)) throw new Error("IM team conversation identity is invalid");
  return `${accountId}|2|${teamId}`;
}

function identityKey(appId: string, realm: "user" | "admin", kind: "USER" | "ADMIN", subjectId: string): ImIdentityKey {
  return { provider: "yunxin", appId, realm, kind, platformSubjectId: subjectId };
}

async function readyAccount(client: PoolClient, key: ImIdentityKey): Promise<string> {
  const row = (await client.query<{ accountId: string; identityMarker: string; status: string }>(
    `SELECT "account_id" AS "accountId", "identity_marker" AS "identityMarker", "status"
       FROM "zzsh_iam"."im_identity_mapping"
      WHERE "provider" = 'yunxin' AND "app_id" = $1 AND "realm" = $2
        AND "identity_kind" = $3 AND "platform_subject_id" = $4`,
    [key.appId, key.realm, key.kind, key.platformSubjectId],
  )).rows[0];
  const expectedAccountId = deriveYunxinAccountId(key);
  const expectedMarker = buildYunxinIdentityMarker(key);
  if (!row || row.status !== "READY" || row.accountId !== expectedAccountId || row.identityMarker !== expectedMarker) {
    throw unavailable("IM identity is not ready");
  }
  return row.accountId;
}

const CONSULTATION_SELECT = `
  SELECT c."id", c."user_id" AS "userId", c."kind", c."state",
         c."user_account_id" AS "userAccountId", c."peer_account_id" AS "peerAccountId", c."app_id" AS "appId",
         c."assigned_admin_id" AS "assignedAdminId", c."subject_ref" AS "subjectRef",
         c."message_scope_type" AS "messageScopeType", c."message_scope_id" AS "messageScopeId",
         c."message_scope_state" AS "messageScopeState", c."message_scope_version" AS "messageScopeVersion",
         c."thread_id" AS "threadId", c."round_seq" AS "roundSeq",
         t."state" AS "threadState", t."message_scope_id" AS "threadScopeId",
         t."message_scope_state" AS "threadScopeState", t."peer_account_id" AS "threadPeerAccountId",
         t."user_read_at" AS "userReadAt",
         c."version", c."last_message_at" AS "lastMessageAt", c."last_message_preview" AS "lastMessagePreview",
         c."admin_read_at" AS "adminReadAt", c."first_user_message_at" AS "firstUserMessageAt",
         c."user_unread_count" AS "userUnreadCount", c."admin_unread_count" AS "adminUnreadCount",
         c."created_at" AS "createdAt",
         c."updated_at" AS "updatedAt", u."name" AS "userName", u."username" AS "userUsername",
         u."image" AS "userImage", au."name" AS "adminName", au."image" AS "adminImage"
    FROM "zzsh_iam"."im_consultation" c
    JOIN "zzsh_iam"."im_support_thread" t ON t."id" = c."thread_id"
    JOIN "zzsh_auth_user"."user" u ON u."id" = c."user_id"
    LEFT JOIN "zzsh_auth_admin"."user" au ON au."id" = c."assigned_admin_id"`;

/** User list is one row per persistent thread: the open round, else the latest closed round. */
const USER_THREAD_SELECT = `
  SELECT c."id", c."user_id" AS "userId", c."kind", c."state",
         c."user_account_id" AS "userAccountId", c."peer_account_id" AS "peerAccountId", c."app_id" AS "appId",
         c."assigned_admin_id" AS "assignedAdminId", c."subject_ref" AS "subjectRef",
         c."message_scope_type" AS "messageScopeType", c."message_scope_id" AS "messageScopeId",
         c."message_scope_state" AS "messageScopeState", c."message_scope_version" AS "messageScopeVersion",
         c."thread_id" AS "threadId", c."round_seq" AS "roundSeq",
         t."state" AS "threadState", t."message_scope_id" AS "threadScopeId",
         t."message_scope_state" AS "threadScopeState", t."peer_account_id" AS "threadPeerAccountId",
         t."user_read_at" AS "userReadAt",
         c."version", c."last_message_at" AS "lastMessageAt", c."last_message_preview" AS "lastMessagePreview",
         c."admin_read_at" AS "adminReadAt", c."first_user_message_at" AS "firstUserMessageAt",
         c."user_unread_count" AS "userUnreadCount", c."admin_unread_count" AS "adminUnreadCount",
         c."created_at" AS "createdAt",
         c."updated_at" AS "updatedAt", u."name" AS "userName", u."username" AS "userUsername",
         u."image" AS "userImage", au."name" AS "adminName", au."image" AS "adminImage"
    FROM (
      SELECT DISTINCT ON (c."thread_id") c.*
        FROM "zzsh_iam"."im_consultation" c
       WHERE c."app_id" = $1 AND c."user_id" = $2
       ORDER BY c."thread_id", (c."state" <> 'CLOSED') DESC, c."created_at" DESC, c."id" DESC
    ) c
    JOIN "zzsh_iam"."im_support_thread" t ON t."id" = c."thread_id"
    JOIN "zzsh_auth_user"."user" u ON u."id" = c."user_id"
    LEFT JOIN "zzsh_auth_admin"."user" au ON au."id" = c."assigned_admin_id"`;

async function readConsultation(client: PoolClient, appId: string, id: string, lock = false): Promise<ConsultationRow> {
  const result = await client.query<ConsultationRow>(`${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND c."id" = $2${lock ? " FOR UPDATE OF c" : ""}`, [appId, id]);
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
  return row;
}

function threadStateForRound(row: ConsultationRow): SupportThreadState {
  if (row.threadState) return row.threadState;
  return row.state === "ACTIVE" ? "ACTIVE" : row.state === "WAITING" ? "WAITING" : "IDLE";
}

/** Thread scope falls back to the round scope only for controlled fixtures without thread columns. */
function threadScopeForRow(row: ConsultationRow): { scopeId: string | null; scopeState: MessageScopeState } {
  const scopeId = row.threadScopeId !== undefined ? row.threadScopeId : row.messageScopeId;
  const scopeState = row.threadScopeState !== undefined
    ? row.threadScopeState
    : row.messageScopeState === "READY" ? "READY" : row.messageScopeState;
  return { scopeId, scopeState };
}

export function toView(row: ConsultationRow, viewerAccountId: string, includeUser = false, viewerAdminId?: string, adminThreadRead = false): ConsultationView {
  const thread = threadScopeForRow(row);
  const teamReady = thread.scopeState === "READY" && Boolean(thread.scopeId);
  // 用户始终读取本人持久线程：只要 Team 存在，任何轮次状态都能看历史、发消息。
  const userCanUseScope = teamReady && Boolean(thread.scopeId);
  // 管理端仍只对当前轮次负责客服开放会话；其他管理员走只读巡视旁路。
  const adminCanUseScope = row.state === "ACTIVE" && row.messageScopeState === "READY" && Boolean(row.messageScopeId)
    && (!includeUser || row.assignedAdminId === viewerAdminId);
  // 历史读取按持久线程 Team：轮次结束/等待接入时仍能看到上一轮消息，发送仍只看当前轮。
  const adminCanReadThread = includeUser && teamReady && (adminThreadRead || row.assignedAdminId === viewerAdminId);
  const canUseScope = includeUser ? (adminCanUseScope || adminCanReadThread) : userCanUseScope;
  const conversationScopeId = includeUser ? (adminCanUseScope ? row.messageScopeId : thread.scopeId) : thread.scopeId;
  const userReadAt = iso(row.userReadAt);
  // 排队事实：管理视图只算“用户已发声且还没人接”的等待时长；用户视图不暴露。
  const firstUserMessageAt = row.firstUserMessageAt;
  const waitingSeconds = includeUser && row.state === "WAITING" && !row.assignedAdminId && firstUserMessageAt
    ? Math.max(0, Math.round((Date.now() - new Date(firstUserMessageAt).getTime()) / 1000)) : null;
  const lastMessageStamp = row.lastMessageAt;
  // 用户未读只比较平台时间戳；管理视图不展示用户侧未读。
  const hasUnread = !includeUser && lastMessageStamp !== null && lastMessageStamp !== undefined
    && (!userReadAt || new Date(lastMessageStamp).getTime() > new Date(userReadAt).getTime());
  return {
    id: row.id,
    threadId: row.threadId ?? row.id,
    roundId: row.id,
    roundSeq: row.roundSeq ?? 1,
    threadState: threadStateForRound(row),
    type: row.kind,
    state: row.state,
    subjectRef: row.subjectRef,
    assignedAdmin: row.assignedAdminId && row.adminName ? { id: row.assignedAdminId, name: row.adminName, ...(managedProfileImagePath(row.adminImage) ? { avatar: managedProfileImagePath(row.adminImage) } : {}) } : null,
    peerAccountId: includeUser ? row.userAccountId : row.threadPeerAccountId ?? row.peerAccountId,
    botAccountId: null,
    conversationType: "TEAM",
    conversationId: canUseScope ? teamConversationId(viewerAccountId, conversationScopeId!) : null,
    messageScopeState: includeUser ? row.messageScopeState : thread.scopeState,
    canSend: includeUser
      ? row.state === "ACTIVE" && row.assignedAdminId === viewerAdminId && row.messageScopeState === "READY" && Boolean(row.messageScopeId)
      : userCanUseScope,
    version: numberValue(row.version),
    lastMessageAt: iso(row.lastMessageAt),
    lastMessagePreview: row.lastMessagePreview ?? null,
    hasUnread,
    // User sees their own unread count; the admin view gets the count for the current round.
    ...(includeUser ? { adminUnreadCount: numberValue(row.adminUnreadCount ?? 0) } : { userUnreadCount: numberValue(row.userUnreadCount ?? 0) }),
    adminReadAt: iso(row.adminReadAt),
    ...(includeUser ? {
      queued: row.state === "WAITING" && !row.assignedAdminId,
      waitingSince: iso(firstUserMessageAt),
      queueWaitSeconds: waitingSeconds,
    } : {}),
    rating: { available: false, submitted: false, dismissed: false, score: null },
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    ...(includeUser ? { user: { id: row.userId, name: row.userName, username: row.userUsername, ...(managedProfileImagePath(row.userImage) ? { avatar: managedProfileImagePath(row.userImage) } : {}) } } : {}),
  };
}

async function writeEvent(
  client: PoolClient,
  input: {
    consultationId: string;
    eventType: "CREATED" | "ASSIGNED" | "CLAIMED" | "TRANSFERRED" | "CLOSED" | "REOPENED";
    actorType: "user" | "admin" | "system";
    actorId: string;
    fromAdminId?: string | null;
    toAdminId?: string | null;
    peerAccountId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "zzsh_iam"."im_consultation_event"
      ("id", "consultation_id", "event_type", "actor_type", "actor_id", "from_admin_id", "to_admin_id", "peer_account_id", "details")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      `im_event_${randomUUID().replaceAll("-", "")}`,
      input.consultationId,
      input.eventType,
      input.actorType,
      input.actorId,
      input.fromAdminId ?? null,
      input.toAdminId ?? null,
      input.peerAccountId ?? null,
      JSON.stringify(input.details ?? {}),
    ],
  );
}

const THREAD_SELECT = `
  SELECT "id", "app_id" AS "appId", "user_id" AS "userId", "kind", "state",
         "user_account_id" AS "userAccountId", "peer_account_id" AS "peerAccountId",
         "message_scope_id" AS "messageScopeId", "message_scope_state" AS "messageScopeState",
         "last_round_seq" AS "lastRoundSeq", "version"
    FROM "zzsh_iam"."im_support_thread"`;

async function readThread(client: PoolClient, appId: string, userId: string, kind: SupportType, lock = false): Promise<ThreadRow | null> {
  const row = (await client.query<ThreadRow>(
    `${THREAD_SELECT} WHERE "app_id" = $1 AND "user_id" = $2 AND "kind" = $3${lock ? " FOR UPDATE" : ""}`,
    [appId, userId, kind],
  )).rows[0];
  return row ?? null;
}

async function readThreadById(client: PoolClient, appId: string, threadId: string, lock = false): Promise<ThreadRow> {
  const row = (await client.query<ThreadRow>(
    `${THREAD_SELECT} WHERE "app_id" = $1 AND "id" = $2${lock ? " FOR UPDATE" : ""}`,
    [appId, threadId],
  )).rows[0];
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "Support thread not found");
  return row;
}

/** One persistent thread per app+user+kind; the unique index makes concurrent first use converge. */
async function ensureThread(client: PoolClient, appId: string, userId: string, kind: SupportType, userAccountId: string): Promise<ThreadRow> {
  const existing = await readThread(client, appId, userId, kind, true);
  if (existing) return existing;
  await client.query(
    `INSERT INTO "zzsh_iam"."im_support_thread"
      ("id", "app_id", "user_id", "kind", "state", "user_account_id")
     VALUES ($1,$2,$3,$4,'IDLE',$5)
     ON CONFLICT ("app_id", "user_id", "kind") DO NOTHING`,
    [`im_thread_${randomUUID().replaceAll("-", "")}`, appId, userId, kind, userAccountId],
  );
  const created = await readThread(client, appId, userId, kind, true);
  if (!created) throw new Error("IM support thread writeback is missing");
  return created;
}

type WaitingRound = { id: string; state: ConsultationState; created: boolean; threadScopeReady: boolean };

/**
 * Create the next round on the thread. The caller already holds the thread row
 * lock. A Team owned by the thread is copied onto the round so the user can
 * read/send while the round is WAITING; no per-round Team is ever created.
 */
async function createWaitingRound(
  client: PoolClient,
  options: ConsultationRouteOptions,
  thread: ThreadRow,
  input: { subjectRef: string | null; entryIntent: ConsultationEntryIntent; actorType: "user" | "admin" | "system"; actorId: string; requestId?: string },
): Promise<WaitingRound> {
  const nextSeq = numberValue(thread.lastRoundSeq) + 1;
  const id = `im_consult_${randomUUID().replaceAll("-", "")}`;
  const scopeReady = thread.messageScopeState === "READY" && Boolean(thread.messageScopeId);
  // 新轮次从提交起可读；first_user_message_at 只由用户真实消息推进，
  // 管理队列与自动分配都据此隐藏“只进了页面、还没说话”的空会话。
  await client.query(
    `INSERT INTO "zzsh_iam"."im_consultation"
      ("id", "app_id", "user_id", "kind", "state", "user_account_id", "subject_ref", "thread_id", "round_seq",
       "message_scope_id", "message_scope_state", "message_scope_version", "last_message_at", "entry_intent")
     VALUES ($1,$2,$3,$4,'WAITING',$5,$6,$7,$8,$9,$10,1,clock_timestamp(),$11)`,
    [id, options.appId, thread.userId, thread.kind, thread.userAccountId, input.subjectRef, thread.id, nextSeq,
      scopeReady ? thread.messageScopeId : null, scopeReady ? "READY" : "PENDING", input.entryIntent],
  );
  await client.query(
    `UPDATE "zzsh_iam"."im_support_thread"
        SET "state" = 'WAITING', "peer_account_id" = NULL, "last_round_seq" = $3,
            "user_read_at" = clock_timestamp(),
            "version" = "version" + 1, "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "id" = $2`,
    [options.appId, thread.id, nextSeq],
  );
  await writeEvent(client, {
    consultationId: id,
    eventType: nextSeq > 1 ? "REOPENED" : "CREATED",
    actorType: input.actorType,
    actorId: input.actorId,
    details: { type: thread.kind, roundSeq: nextSeq, reopened: nextSeq > 1 },
  });
  if (input.requestId) {
    await recordAudit(client, {
      actorType: input.actorType,
      actorId: input.actorId,
      action: "im.consultation.round.opened",
      objectType: "im_consultation",
      objectId: id,
      outcome: "SUCCESS",
      requestId: input.requestId,
      details: { threadId: thread.id, roundSeq: nextSeq, teamReady: scopeReady },
    });
  }
  return { id, state: "WAITING", created: true, threadScopeReady: scopeReady };
}

/**
 * Shared side effects of a newly opened round: provision the thread Team when
 * needed and send the one-off entry welcome. Opening a round never assigns:
 * auto-assignment only starts after the user's first message.
 */
async function afterRoundOpened(
  options: ConsultationRouteOptions,
  input: { roundId: string; threadId: string; threadScopeReady: boolean; threadMessageScopeId: string | null; created: boolean; entryIntent: ConsultationEntryIntent },
): Promise<void> {
  let teamId = input.threadMessageScopeId;
  if (!input.threadScopeReady) {
    await ensureThreadTeam(options, input.threadId, input.roundId);
    // The Team was just provisioned: read the binding the operation attached.
    if (input.created) {
      const thread = await withTransaction(options.pool, (client) => readThreadById(client, options.appId, input.threadId, false));
      teamId = thread.messageScopeId;
    }
  }
  if (input.created && options.supportManager) {
    // 欢迎语按入口场景选择文案，仍由平台账号发送；失败不影响轮次与后续分配。
    const texts = await withTransaction(options.pool,client=>readSupportWelcome(client,options.appId,input.entryIntent));
    for (const [index, text] of texts.entries()) {
      await sendSupportText(options, teamId, supportManagerAccount(options).accountId,
        text, `support_welcome_${input.roundId}_${index + 1}`);
    }
  }
}

/** CS-04: reuse the capacity a successful close/transfer freed; a wake failure never changes the business result. */
async function wakeAutoAssign(options: ConsultationRouteOptions, limit = 5): Promise<void> {
  if (!options.autoAssignConsultations) return;
  await autoAssignWaitingConsultations(options, limit).catch(() => undefined);
}

export function requireSupportAccess(access: EffectiveAdminAccess | null, _type: SupportType, action: "accept" | "transfer" = "accept"): void {
  // 投诉已并入普通咨询：旧 COMPLAINT 行同样只要求接待权限，不再追加 im.support.complaint。
  const required = action === "transfer"
    ? [ADMIN_PERMISSION.imSupportAccept, ADMIN_PERMISSION.imSupportTransfer]
    : [ADMIN_PERMISSION.imSupportAccept];
  if (!required.every((permission) => hasPermission(access, permission))) {
    throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
  }
}

type Candidate = {
  adminUserId: string;
  adminName: string;
  accountId: string;
};

async function reserveEligibleAdmin(client: PoolClient, appId: string, locked: LockedSupportRoster, type: SupportType,
  targetAdminId?: string, concurrencyLimit?: number, enforceCapacity = true): Promise<{ candidate: Candidate | null; reason: SupportQueueReason | null }> {
  const outcome = await reserveSupportCandidateOutcome(client, appId, type, await readEligibleSupport(client, appId, locked), targetAdminId, concurrencyLimit, enforceCapacity);
  return { candidate: outcome.candidate, reason: outcome.reason };
}

/** 本轮确定没有可用客服时平台账号的兜底；每轮最多一次，由 no_support_notice_at 保证。 */
const NO_SUPPORT_NOTICE_TEXT = "抱歉，当前暂无在线客服，请先留言，客服上线后我们会第一时间联系您！";
/** 满载排队：客服在线但都满了，不能让用户以为没人值班；不暴露任何具体客服信息。 */
const SUPPORT_BUSY_NOTICE_TEXT = "客服当前都在忙，已为您排队，请先留言，空出来会第一时间为您处理～";
const supportGreetingText = (name: string) => `您好，我是本次为您服务的客服${name}，已收到您的留言，马上为您处理。`;

/** Server-side bot/agent text. Local-fake uses the in-memory transport; real NIM uses the provider seam. */
async function sendSupportText(
  options: ConsultationRouteOptions,
  teamId: string | null | undefined,
  senderAccountId: string,
  text: string,
  messageClientId: string,
): Promise<void> {
  if (!teamId) return;
  const conversationId = `${senderAccountId}|2|${teamId}`;
  try {
    if (options.messageTransport?.sendText) {
      await options.messageTransport.sendText({ conversationId, senderAccountId, receiverAccountId: teamId, text, messageClientId });
    } else if (options.provider?.sendSupportTeamText) {
      await options.provider.sendSupportTeamText({ teamId, senderAccountId, text, messageClientId });
    } else {
      return;
    }
    await recordSupportThreadMessage(options, conversationId, text);
  } catch {
    // Auto messages are best-effort; the round/assignment facts remain authoritative.
  }
}

/**
 * 自动分配确认“本轮暂时没人接”时的平台兜底：先原子标记本轮已通知，再发送一次。
 * 标记失败（已发过/已被接管/已关闭）即不再发送；无人与满载共用同一列做每轮一次的去重。
 */
async function notifyQueueFallback(
  options: ConsultationRouteOptions,
  consultationId: string,
  teamId: string,
  reason: SupportQueueReason,
): Promise<void> {
  if (!options.supportManager) return;
  const marked = await options.pool.query(
    `UPDATE "zzsh_iam"."im_consultation"
        SET "no_support_notice_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'WAITING'
        AND "first_user_message_at" IS NOT NULL AND "no_support_notice_at" IS NULL
      RETURNING "id"`,
    [options.appId, consultationId],
  );
  if ((marked.rowCount ?? marked.rows.length) !== 1) return;
  const busy = reason === "ALL_AT_CAPACITY";
  await sendSupportText(options, teamId, supportManagerAccount(options).accountId,
    busy ? SUPPORT_BUSY_NOTICE_TEXT : NO_SUPPORT_NOTICE_TEXT, `support_${busy ? "busy" : "no_support"}_${consultationId}`);
}

async function decrementPresence(client: PoolClient, appId: string, adminUserId: string | null): Promise<void> {
  if (!adminUserId) return;
  await client.query(
    `UPDATE "zzsh_iam"."im_support_presence"
        SET "active_load" = GREATEST("active_load" - 1, 0), "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "admin_user_id" = $2`,
    [appId, adminUserId],
  );
}

/**
 * A reserved claim that never became ACTIVE gives its load back exactly once.
 * settleScopeOperationFailure already releases the reservation it recorded, so a
 * settled (NEEDS_REVIEW/UNKNOWN) operation is not decremented again; only silent
 * failures (claim lost, no writeback) reach decrementPresence here.
 */
async function releaseFailedClaim(options: ConsultationRouteOptions, consultationId: string, adminUserId: string): Promise<void> {
  try {
    await withTransaction(options.pool, async (client) => {
      const row = await readConsultation(client, options.appId, consultationId);
      if (row.state === "ACTIVE" && row.assignedAdminId === adminUserId) return;
      const operation = (await client.query<{ state: MessageScopeOperationState }>(
        `SELECT "state" FROM "zzsh_iam"."im_consultation_scope_operation"
          WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
        [options.appId, consultationId],
      )).rows[0];
      if (operation?.state === "NEEDS_REVIEW" || operation?.state === "UNKNOWN") return;
      await decrementPresence(client, options.appId, adminUserId);
    });
  } catch {
    // Load neutralisation is maintenance; it must never replace the business result.
  }
}

/** A reused ADD_MEMBER was released when its operation settled; a successful recovery restores it once. */
async function restoreClaimLoad(options: ConsultationRouteOptions, consultationId: string, adminUserId: string): Promise<void> {
  try {
    await withTransaction(options.pool, async (client) => {
      const row = await readConsultation(client, options.appId, consultationId);
      if (row.state !== "ACTIVE" || row.assignedAdminId !== adminUserId) return;
      await client.query(
        `UPDATE zzsh_iam.im_support_presence SET active_load=active_load+1,updated_at=clock_timestamp()
          WHERE app_id=$1 AND admin_user_id=$2`,
        [options.appId, adminUserId],
      );
    });
  } catch {
    // Load restoration is maintenance; the successful claim remains authoritative.
  }
}

type RoundRatingRow = {
  roundId: string;
  score: number | string | null;
  comment: string | null;
  submittedAt: Date | string | null;
  dismissedAt: Date | string | null;
};

const RATING_SELECT = `
  SELECT "round_id" AS "roundId", "score", "comment",
         "submitted_at" AS "submittedAt", "dismissed_at" AS "dismissedAt"
    FROM "zzsh_iam"."im_support_round_rating"`;

function ratingView(row: RoundRatingRow | undefined | null, available = false): SupportRoundRatingView {
  if (!row) return { available, submitted: false, dismissed: false, score: null };
  if (row.submittedAt) {
    return {
      available: false,
      submitted: true,
      dismissed: false,
      score: row.score === null ? null : Number(row.score),
      ...(row.comment ? { comment: row.comment } : {}),
    };
  }
  // 暂不评价即对该轮隐藏评价入口，服务端仍保留唯一行。
  return { available: false, submitted: false, dismissed: true, score: null };
}

async function readRoundRating(client: PoolClient, appId: string, roundId: string): Promise<RoundRatingRow | null> {
  return (await client.query<RoundRatingRow>(`${RATING_SELECT} WHERE "app_id" = $1 AND "round_id" = $2`, [appId, roundId])).rows[0] ?? null;
}

export async function listUserConsultations(
  options: ConsultationRouteOptions,
  context: UserContext,
  limit: number,
): Promise<{ consultations: ConsultationView[] }> {
  return withTransaction(options.pool, async (client) => {
    await assertUserContextInTransaction(client, context);
    const accountId = await readyAccount(client, identityKey(options.appId, "user", "USER", context.userId));
    const rows = (await client.query<ConsultationRow>(
      `${USER_THREAD_SELECT} ORDER BY c."updated_at" DESC, c."id" DESC LIMIT $3`,
      [options.appId, context.userId, limit],
    )).rows;
    const ratings = new Map<string, RoundRatingRow>();
    if (rows.length) {
      const ratingRows = (await client.query<RoundRatingRow>(
        `${RATING_SELECT} WHERE "app_id" = $1 AND "round_id" = ANY($2::text[])`,
        [options.appId, rows.map((row) => row.id)],
      )).rows;
      for (const rating of ratingRows) ratings.set(rating.roundId, rating);
    }
    return {
      consultations: rows.map((row) => ({
        ...toView(row, accountId),
        botAccountId: supportBotAccountId(options),
        // 一轮最多一条：DISTINCT ON 已保证 CLOSED 行没有同线程未结束轮次；无负责客服的历史轮不可评。
        rating: ratingView(ratings.get(row.id), row.state === "CLOSED" && Boolean(row.assignedAdminId)),
      })),
    };
  });
}

/**
 * 平台读取事件：仅当前负责客服在其 ACTIVE 轮次推进 admin_read_at。
 * 幂等；不推进 version/updated_at，避免把“已读”当成业务变更。
 */
export async function markConsultationRead(
  options: ConsultationRouteOptions,
  context: AdminContext,
  id: string,
): Promise<{ adminReadAt: string | null }> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, id, true);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) {
      throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    }
    requireSupportAccess(access, row.kind);
    const updated = await client.query<{ adminReadAt: Date | string | null }>(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "admin_read_at" = clock_timestamp(), "admin_unread_count" = 0
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "assigned_admin_id" = $3
        RETURNING "admin_read_at" AS "adminReadAt"`,
      [options.appId, id, context.userId],
    );
    if (updated.rowCount !== 1) throw conflict("Consultation changed while marking read");
    return { adminReadAt: iso(updated.rows[0]?.adminReadAt ?? null) };
  });
}

/**
 * 用户读取事件：只推进本人线程的 user_read_at，不改线程版本和队列排序。
 * 幂等；轮次归属在事务内复核，重复调用只刷新时间。
 */
export async function markUserConsultationRead(
  options: ConsultationRouteOptions,
  context: UserContext,
  roundId: string,
): Promise<{ userReadAt: string | null }> {
  return withTransaction(options.pool, async (client) => {
    await assertUserContextInTransaction(client, context);
    const round = (await client.query<{ userId: string; threadId: string }>(
      `SELECT "user_id" AS "userId", "thread_id" AS "threadId"
         FROM "zzsh_iam"."im_consultation"
        WHERE "app_id" = $1 AND "id" = $2`,
      [options.appId, roundId],
    )).rows[0];
    if (!round) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
    if (round.userId !== context.userId) {
      throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not owned by the current user");
    }
    const updated = await client.query<{ userReadAt: Date | string | null }>(
      `UPDATE "zzsh_iam"."im_support_thread"
          SET "user_read_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2
        RETURNING "user_read_at" AS "userReadAt"`,
      [options.appId, round.threadId],
    );
    if (updated.rowCount !== 1) throw conflict("Support thread changed while marking read");
    // 线程级已读覆盖该线程所有轮次的用户未读计数；轮次行仍保留，便于列表回显。
    await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "user_unread_count" = 0
        WHERE "app_id" = $1 AND "thread_id" = $2 AND "user_unread_count" <> 0`,
      [options.appId, round.threadId],
    );
    return { userReadAt: iso(updated.rows[0]?.userReadAt ?? null) };
  });
}

/** 用户只能评本人线程中已结束、且线程当前没有新一轮的轮次；客服不可代评。 */
function assertRatableRound(row: ConsultationRow, userId: string): void {
  if (row.userId !== userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not owned by the current user");
  if (row.state !== "CLOSED" || !row.assignedAdminId || !row.threadId) throw conflict("Only a closed round can be rated");
}

async function assertNoOpenRound(client: PoolClient, appId: string, threadId: string): Promise<void> {
  const open = (await client.query(
    `SELECT 1 FROM "zzsh_iam"."im_consultation" WHERE "app_id" = $1 AND "thread_id" = $2 AND "state" <> 'CLOSED' LIMIT 1`,
    [appId, threadId],
  )).rows[0];
  if (open) throw conflict("The support thread has a new open round");
}

/**
 * 评级与开轮共用 thread -> round 的加锁顺序，避免并发时互相等待；
 * 锁住线程后再复核轮次归属与状态，防止检查后被新一轮插入。
 */
async function lockRatableRound(client: PoolClient, appId: string, id: string, userId: string): Promise<ConsultationRow> {
  const initial = await readConsultation(client, appId, id);
  if (initial.userId !== userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not owned by the current user");
  if (!initial.threadId) throw conflict("Only a closed round can be rated");
  await readThreadById(client, appId, initial.threadId, true);
  const row = await readConsultation(client, appId, id, true);
  assertRatableRound(row, userId);
  await assertNoOpenRound(client, appId, row.threadId!);
  return row;
}

const RATING_RETURNING = `RETURNING "round_id" AS "roundId", "score", "comment",
         "submitted_at" AS "submittedAt", "dismissed_at" AS "dismissedAt"`;

export async function submitSupportRating(
  options: ConsultationRouteOptions,
  context: UserContext,
  id: string,
  score: number,
  comment: string | null,
): Promise<{ rating: SupportRoundRatingView }> {
  if (!Number.isInteger(score) || score < 1 || score > 5) throw invalid("Rating score is invalid");
  return withTransaction(options.pool, async (client) => {
    await assertUserContextInTransaction(client, context);
    const row = await lockRatableRound(client, options.appId, id, context.userId);
    const inserted = await client.query<RoundRatingRow>(
      `INSERT INTO "zzsh_iam"."im_support_round_rating"
        ("id", "app_id", "thread_id", "round_id", "user_id", "assigned_admin_id", "score", "comment", "submitted_at")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())
       ON CONFLICT ("round_id") DO NOTHING
       ${RATING_RETURNING}`,
      [`im_rating_${randomUUID().replaceAll("-", "")}`, options.appId, row.threadId, row.id, row.userId, row.assignedAdminId, score, comment],
    );
    const created = inserted.rows[0];
    if (created) return { rating: ratingView(created) };
    const existing = await readRoundRating(client, options.appId, row.id);
    if (existing?.submittedAt) throw conflict("本轮已评价");
    throw conflict("本轮评价已关闭");
  });
}

export async function dismissSupportRating(
  options: ConsultationRouteOptions,
  context: UserContext,
  id: string,
): Promise<{ rating: SupportRoundRatingView }> {
  return withTransaction(options.pool, async (client) => {
    await assertUserContextInTransaction(client, context);
    const row = await lockRatableRound(client, options.appId, id, context.userId);
    const existing = await readRoundRating(client, options.appId, row.id);
    if (existing?.submittedAt) throw conflict("本轮已评价");
    if (existing) return { rating: ratingView(existing) };
    const inserted = await client.query<RoundRatingRow>(
      `INSERT INTO "zzsh_iam"."im_support_round_rating"
        ("id", "app_id", "thread_id", "round_id", "user_id", "assigned_admin_id", "score", "submitted_at", "dismissed_at")
       VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,clock_timestamp())
       ON CONFLICT ("round_id") DO NOTHING
       ${RATING_RETURNING}`,
      [`im_rating_${randomUUID().replaceAll("-", "")}`, options.appId, row.threadId, row.id, row.userId, row.assignedAdminId],
    );
    const created = inserted.rows[0] ?? await readRoundRating(client, options.appId, row.id);
    if (!created) throw conflict("Rating was not recorded");
    if (created.submittedAt) throw conflict("本轮已评价");
    return { rating: ratingView(created) };
  });
}

const SCOPE_OPERATION_SELECT = `
  SELECT "id", "app_id" AS "appId", "consultation_id" AS "consultationId", "operation_type" AS "operationType",
         "state", "scope_version" AS "scopeVersion", "owner_account_id" AS "ownerAccountId",
         "user_account_id" AS "userAccountId", "previous_admin_id" AS "previousAdminId",
         "target_admin_id" AS "targetAdminId", "previous_admin_account_id" AS "previousAdminAccountId",
         "target_admin_account_id" AS "targetAdminAccountId", "provider_team_id" AS "providerTeamId",
          "attempt_count" AS "attemptCount", "lease_token_hash" AS "leaseTokenHash", "lease_until" AS "leaseUntil",
         "next_retry_at" AS "nextRetryAt",
         "last_failure_class" AS "lastFailureClass", "last_failure_detail" AS "lastFailureDetail"
    FROM "zzsh_iam"."im_consultation_scope_operation"`;

const SCOPE_LEASE_MS = 30_000;
const SCOPE_RETRY_BASE_MS = 5_000;
const SCOPE_RETRY_CAP_MS = 5 * 60_000;
const SCOPE_AUTO_ATTEMPT_LIMIT = 8;

type ScopeOperationClaim = ScopeOperationRow & { leaseToken: string; attemptCount: number };
type ScopeFailureClass = "IDENTITY_PENDING" | "PROVIDER_UNKNOWN" | "PROVIDER_TRANSIENT" | "REMOTE_MISMATCH" | "DB_WRITEBACK_UNKNOWN" | "STALE_OPERATION" | "REQUIRES_MANUAL_REVIEW";

class ScopeOperationFailure extends Error {
  constructor(readonly failureClass: ScopeFailureClass, readonly detail: string, readonly manual = failureClass !== "IDENTITY_PENDING") {
    super(detail);
  }
}

type ScopeRecoveryFailureObserver = (failureClass: ScopeFailureClass | "RECOVERY_UNEXPECTED") => void;

function recoveryFailureClass(error: unknown): ScopeFailureClass | "RECOVERY_UNEXPECTED" {
  if (error instanceof ScopeOperationFailure) return error.failureClass;
  if (error instanceof YunxinApiError) return error.retryable ? "PROVIDER_UNKNOWN" : "REQUIRES_MANUAL_REVIEW";
  if (error instanceof YunxinTransportError) return "PROVIDER_UNKNOWN";
  return "RECOVERY_UNEXPECTED";
}

function reportRecoveryFailure(observer: ScopeRecoveryFailureObserver | undefined, error: unknown): void {
  if (!observer) return;
  try {
    observer(recoveryFailureClass(error));
  } catch {
    // Recovery observation must not take down the worker or hide the persisted state.
  }
}

function createScopeLease(options: ConsultationRouteOptions, claim: ScopeOperationClaim): ScopeLease {
  return createImScopeLease(options.pool, options.appId, async (db) => {
    const result = await db.query(`UPDATE zzsh_iam.im_consultation_scope_operation
      SET lease_until=clock_timestamp()+($3::bigint*interval '1 millisecond'),updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2 AND state='RUNNING' AND lease_token_hash=$4 AND lease_until>clock_timestamp() RETURNING id`,
      [options.appId,claim.id,SCOPE_LEASE_MS,scopeLeaseHash(claim.leaseToken)]);
    return result.rowCount===1;
  }, () => new ScopeOperationFailure("STALE_OPERATION", "scope lease is no longer valid", true));
}
function scopeOperationId(): string {
  return `im_scope_op_${randomBytes(16).toString("hex")}`;
}

function scopeLeaseHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function scopeOperationState(value: string): MessageScopeOperationState {
  if (value === "PENDING" || value === "RUNNING" || value === "UNKNOWN" || value === "SUCCEEDED" || value === "FAILED" || value === "NEEDS_REVIEW") return value;
  throw new Error("IM scope operation state is invalid");
}

function scopeOperationRow(row: ScopeOperationRow): ScopeOperationRow {
  return { ...row, operationType: row.operationType, state: scopeOperationState(row.state) };
}

async function readScopeOperation(client: PoolClient, appId: string, operationId: string, lock = false): Promise<ScopeOperationRow> {
  const result = await client.query<ScopeOperationRow>(`${SCOPE_OPERATION_SELECT} WHERE "app_id" = $1 AND "id" = $2${lock ? " FOR UPDATE" : ""}`, [appId, operationId]);
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "IM scope operation not found");
  return scopeOperationRow(row);
}

function supportBotAccountId(options: ConsultationRouteOptions): string | null {
  return options.supportManager ? deriveYunxinAccountId(options.supportManager.key) : null;
}

function supportManagerAccount(options: ConsultationRouteOptions): { key: ImIdentityKey; accountId: string } {
  if (!options.supportManager) throw unavailable("IM support manager is not configured");
  const key = normalizeImIdentityKey(options.supportManager.key);
  if (key.appId !== options.appId || key.realm !== "system" || key.kind !== "SYSTEM" || key.platformSubjectId !== SUPPORT_MANAGER_SUBJECT_ID) {
    throw new Error("IM support manager identity is invalid");
  }
  return { key, accountId: deriveYunxinAccountId(key) };
}

async function ensureSupportManager(options: ConsultationRouteOptions): Promise<string | null> {
  const manager = supportManagerAccount(options);
  const input: ImIdentityProvisionInput = { key: manager.key, displayName: "洲洲助手（Bot）", ...(options.supportManager?.avatarUrl ? { avatar: options.supportManager.avatarUrl } : {}) };
  const result: ImProvisionResult = await options.supportManager!.provisioner.ensure(input);
  if (result.mapping.accountId !== manager.accountId
    || result.mapping.key.appId !== manager.key.appId
    || result.mapping.key.realm !== manager.key.realm
    || result.mapping.key.kind !== manager.key.kind
    || result.mapping.key.platformSubjectId !== manager.key.platformSubjectId
    || result.mapping.identityMarker !== buildYunxinIdentityMarker(manager.key)) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "IM support manager identity mismatch", true);
  }
  if (result.outcome === "READY") return manager.accountId;
  if (result.outcome === "PENDING") return null;
  throw new ScopeOperationFailure("REMOTE_MISMATCH", "IM support manager is blocked", true);
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 8);
  return Math.min(SCOPE_RETRY_CAP_MS, SCOPE_RETRY_BASE_MS * 2 ** exponent);
}

function providerFailure(error: unknown): ScopeOperationFailure {
  if (error instanceof ScopeOperationFailure) return error;
  if (error instanceof YunxinApiError) {
    return new ScopeOperationFailure(error.retryable ? "PROVIDER_UNKNOWN" : "REQUIRES_MANUAL_REVIEW", `yunxin:${error.operation}`, true);
  }
  if (error instanceof YunxinTransportError) return new ScopeOperationFailure("PROVIDER_UNKNOWN", `yunxin:${error.operation}`, true);
  return new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "scope operation writeback is unknown", true);
}

function remoteActionMayStillBeInFlight(failureClass: string | null): boolean {
  // ponytail: without a provider idempotency/result fence, every non-identity failure stays fail-closed.
  return failureClass !== "IDENTITY_PENDING";
}

function exactMembers(team: YunxinSupportTeamState, required: string[]): boolean {
  if (team.memberAccountIds.length !== required.length) return false;
  const expected = new Set(required);
  return team.memberAccountIds.every((accountId) => expected.has(accountId));
}

function allowedMembers(team: YunxinSupportTeamState, allowed: string[]): boolean {
  const expected = new Set(allowed);
  return team.memberAccountIds.every((accountId) => expected.has(accountId));
}

/**
 * Thread-scoped Team creation. The operation carries no target agent: the Team
 * starts with the server manager as owner and the user as member; agents are
 * added per-claim. The operation row is what makes a provider create
 * recoverable without ever creating a second Team.
 */
async function beginThreadTeamProvision(
  options: ConsultationRouteOptions,
  threadId: string,
  roundId: string,
): Promise<{ operationId: string } | null> {
  if (!options.provider) throw unavailable("IM message scope provider is not configured");
  const manager = supportManagerAccount(options);
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    const thread = await readThreadById(client, options.appId, threadId, true);
    const row = await readConsultation(client, options.appId, roundId, true);
    if (row.threadId !== threadId) return null;
    if (thread.messageScopeState === "READY" && thread.messageScopeId) {
      // The Team already exists: copy it onto the open round instead of creating another.
      await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_id" = $3, "message_scope_state" = 'READY',
                "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" <> 'CLOSED'
            AND ("message_scope_id" IS NULL OR "message_scope_id" = $3)
            AND "message_scope_state" IN ('PENDING', 'PROVISIONING', 'FAILED')`,
        [options.appId, roundId, thread.messageScopeId],
      );
      return null;
    }
    if (row.state === "CLOSED") return null;
    const active = (await client.query<{ id: string }>(
      `SELECT o."id" FROM "zzsh_iam"."im_consultation_scope_operation" o
         JOIN "zzsh_iam"."im_consultation" c ON c."id" = o."consultation_id"
        WHERE c."app_id" = $1 AND c."thread_id" = $2 AND o."operation_type" = 'CREATE'
          AND o."state" IN ('PENDING', 'RUNNING', 'UNKNOWN')
        LIMIT 1 FOR UPDATE OF o`,
      [options.appId, threadId],
    )).rows[0];
    if (active) return null;
    await client.query(
      `UPDATE "zzsh_iam"."im_support_thread"
          SET "message_scope_state" = 'PROVISIONING', "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "message_scope_state" IN ('PENDING', 'FAILED')`,
      [options.appId, threadId],
    );
    let scopeVersion = numberValue(row.messageScopeVersion);
    if (row.messageScopeId === null && (row.messageScopeState === "PENDING" || row.messageScopeState === "FAILED")) {
      const updated = await client.query<{ messageScopeVersion: string | number }>(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_state" = 'PROVISIONING', "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" <> 'CLOSED'
            AND "message_scope_state" IN ('PENDING', 'FAILED') AND "message_scope_id" IS NULL
          RETURNING "message_scope_version" AS "messageScopeVersion"`,
        [options.appId, roundId],
      );
      if (updated.rowCount === 1 && updated.rows[0]) scopeVersion = numberValue(updated.rows[0].messageScopeVersion);
    }
    const operationId = scopeOperationId();
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
        ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id", "provider_team_id")
       VALUES ($1,$2,$3,'CREATE',$4,$5,$6,$7)`,
      [operationId, options.appId, roundId, scopeVersion, manager.accountId, thread.userAccountId, thread.messageScopeId],
    );
    return { operationId };
  });
}

async function claimScopeOperation(options: ConsultationRouteOptions, operationId: string): Promise<ScopeOperationClaim | null> {
  const leaseToken = randomBytes(32).toString("base64url");
  const result = await options.pool.query<ScopeOperationRow>(
    `UPDATE "zzsh_iam"."im_consultation_scope_operation"
        SET "state" = 'RUNNING', "attempt_count" = "attempt_count" + 1,
            "lease_until" = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
            "lease_token_hash" = $4, "last_failure_class" = NULL,
            "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "id" = $2
        AND (
          ("state" = 'PENDING' AND "next_retry_at" <= clock_timestamp())
          OR ("state" = 'UNKNOWN' AND "last_failure_class" = 'IDENTITY_PENDING'
              AND "next_retry_at" <= clock_timestamp())
        )
      RETURNING "id", "app_id" AS "appId", "consultation_id" AS "consultationId", "operation_type" AS "operationType",
                "state", "scope_version" AS "scopeVersion", "owner_account_id" AS "ownerAccountId",
                "user_account_id" AS "userAccountId", "previous_admin_id" AS "previousAdminId",
                "target_admin_id" AS "targetAdminId", "previous_admin_account_id" AS "previousAdminAccountId",
                "target_admin_account_id" AS "targetAdminAccountId", "provider_team_id" AS "providerTeamId",
                "attempt_count" AS "attemptCount", "lease_token_hash" AS "leaseTokenHash", "lease_until" AS "leaseUntil",
                "next_retry_at" AS "nextRetryAt",
                "last_failure_class" AS "lastFailureClass", "last_failure_detail" AS "lastFailureDetail"`,
    [options.appId, operationId, SCOPE_LEASE_MS, scopeLeaseHash(leaseToken)],
  );
  const row = result.rows[0];
  return row ? { ...scopeOperationRow(row), leaseToken, attemptCount: numberValue(row.attemptCount) } : null;
}

async function settleScopeOperationFailure(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  failure: ScopeOperationFailure,
): Promise<"RETRYING" | "NEEDS_REVIEW"> {
  const needsReview = failure.manual || remoteActionMayStillBeInFlight(failure.failureClass) || claim.attemptCount >= SCOPE_AUTO_ATTEMPT_LIMIT;
  const nextState: MessageScopeOperationState = needsReview ? "NEEDS_REVIEW" : "UNKNOWN";
  await withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = $3, "next_retry_at" = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
              "lease_until" = NULL, "lease_token_hash" = NULL,
              "last_failure_class" = $5, "last_failure_detail" = $6, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $7
            AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, nextState, needsReview ? 0 : retryDelayMs(claim.attemptCount), failure.failureClass, failure.detail.slice(0, 512), scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope lease changed before failure was recorded", true);
    // A failed claim releases the reservation it took; an already-written claim keeps its load.
    if (claim.operationType === "ADD_MEMBER" && claim.targetAdminId && row.assignedAdminId !== claim.targetAdminId) {
      await decrementPresence(client, options.appId, claim.targetAdminId);
    }
    if (needsReview) {
      const nextScopeState = "FAILED";
      await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_state" = $3, "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2
            AND "message_scope_state" IN ('PROVISIONING', 'TRANSFERRING', 'REVOKING')`,
        [options.appId, claim.consultationId, nextScopeState],
      );
      await client.query(
        `UPDATE "zzsh_iam"."im_support_thread" t
            SET "message_scope_state" = 'FAILED', "version" = t."version" + 1, "updated_at" = clock_timestamp()
          FROM "zzsh_iam"."im_consultation" c
         WHERE c."app_id" = $1 AND c."id" = $2 AND t."id" = c."thread_id"
           AND t."message_scope_state" = 'PROVISIONING'`,
        [options.appId, claim.consultationId],
      );
    }
    await recordAudit(client, {
      actorType: "system",
      actorId: claim.ownerAccountId,
      action: needsReview ? "im.scope.recovery.needs_review" : "im.scope.recovery.deferred",
      objectType: "im_consultation_scope_operation",
      objectId: claim.id,
      outcome: "FAILURE",
      requestId: `im_scope_${claim.id}`,
      reason: failure.failureClass,
      details: { operationType: claim.operationType, attemptCount: claim.attemptCount },
    });
  });
  return needsReview ? "NEEDS_REVIEW" : "RETRYING";
}

async function quarantineUncertainScopeOperations(options: ConsultationRouteOptions, limit: number): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    const candidates = (await client.query<{
      id: string;
      consultationId: string;
      ownerAccountId: string;
      operationType: MessageScopeOperationType;
      state: "RUNNING" | "UNKNOWN";
      lastFailureClass: string | null;
    }>(
      `SELECT "id", "consultation_id" AS "consultationId", "owner_account_id" AS "ownerAccountId",
              "operation_type" AS "operationType", "state", "last_failure_class" AS "lastFailureClass"
         FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND (
          ("state" = 'RUNNING' AND "lease_until" <= clock_timestamp())
          OR ("state" = 'UNKNOWN' AND "last_failure_class" IS DISTINCT FROM 'IDENTITY_PENDING'
              AND COALESCE("last_failure_detail", '') NOT LIKE 'remote action may still be in flight;%')
        )
        ORDER BY "next_retry_at", "updated_at", "id"
        LIMIT $2`,
      [options.appId, limit],
    )).rows;

    for (const candidate of candidates) {
      await readConsultation(client, options.appId, candidate.consultationId, true);
      const detail = "remote action may still be in flight; local lease is not provider fencing";
      const updated = candidate.state === "RUNNING"
        ? await client.query(
          `UPDATE "zzsh_iam"."im_consultation_scope_operation"
              SET "state" = 'NEEDS_REVIEW', "next_retry_at" = clock_timestamp(),
                  "lease_until" = NULL, "lease_token_hash" = NULL,
                  "last_failure_class" = 'PROVIDER_UNKNOWN',
                  "last_failure_detail" = left($3 || COALESCE("last_failure_detail", ''), 512),
                  "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING'
              AND "lease_until" <= clock_timestamp()`,
          [options.appId, candidate.id, `${detail}; `],
        )
        : await client.query(
          `UPDATE "zzsh_iam"."im_consultation_scope_operation"
              SET "next_retry_at" = clock_timestamp(),
                  "last_failure_class" = COALESCE("last_failure_class", 'PROVIDER_UNKNOWN'),
                  "last_failure_detail" = left($3 || COALESCE("last_failure_detail", ''), 512),
                  "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'UNKNOWN'
              AND "last_failure_class" IS DISTINCT FROM 'IDENTITY_PENDING'
              AND COALESCE("last_failure_detail", '') NOT LIKE 'remote action may still be in flight;%'`,
          [options.appId, candidate.id, `${detail}; `],
        );
      if (updated.rowCount !== 1) continue;

      await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_state" = 'FAILED', "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2
            AND "message_scope_state" IN ('PROVISIONING', 'TRANSFERRING', 'REVOKING')`,
        [options.appId, candidate.consultationId],
      );
      await client.query(
        `UPDATE "zzsh_iam"."im_support_thread" t
            SET "message_scope_state" = 'FAILED', "version" = t."version" + 1, "updated_at" = clock_timestamp()
          FROM "zzsh_iam"."im_consultation" c
         WHERE c."app_id" = $1 AND c."id" = $2 AND t."id" = c."thread_id"
           AND t."message_scope_state" = 'PROVISIONING'`,
        [options.appId, candidate.consultationId],
      );
      await recordAudit(client, {
        actorType: "system",
        actorId: candidate.ownerAccountId,
        action: "im.scope.recovery.quarantined",
        objectType: "im_consultation_scope_operation",
        objectId: candidate.id,
        outcome: "FAILURE",
        requestId: `im_scope_${candidate.id}`,
        reason: candidate.state === "RUNNING" ? "PROVIDER_UNKNOWN" : candidate.lastFailureClass ?? "PROVIDER_UNKNOWN",
        details: { operationType: candidate.operationType, previousState: candidate.state, remoteFence: "unavailable" },
      });
    }
  });
}

async function attachCreatedTeam(options: ConsultationRouteOptions, claim: ScopeOperationClaim, teamId: string, threadId: string): Promise<boolean> {
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await lockTeamBinding(client, options.appId, teamId);
    if ((await client.query(`SELECT 1 FROM zzsh_order.im_order_group WHERE app_id=$1 AND team_id=$2`, [options.appId,teamId])).rowCount) throw new ScopeOperationFailure("REMOTE_MISMATCH", "Team is already bound to an order", true);
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING" || operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) return false;
    if (row.threadId !== threadId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "consultation thread changed before scope attach", true);
    const thread = await readThreadById(client, options.appId, threadId, true);
    // One Team per thread: a second remote create must never overwrite an existing binding.
    if (thread.messageScopeId && thread.messageScopeId !== teamId) {
      throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread already has a different Team", true);
    }
    const bound = await client.query(
      `UPDATE "zzsh_iam"."im_support_thread"
          SET "message_scope_id" = $3, "message_scope_state" = 'READY',
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2
          AND ("message_scope_id" IS NULL OR "message_scope_id" = $3)
          AND "message_scope_state" IN ('PENDING', 'PROVISIONING', 'FAILED')`,
      [options.appId, threadId, teamId],
    );
    if (bound.rowCount !== 1 && !(thread.messageScopeId === teamId && thread.messageScopeState === "READY")) {
      throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "thread scope writeback is unknown");
    }
    if (row.state !== "CLOSED" && (row.messageScopeId === null || row.messageScopeId === teamId)
      && row.messageScopeState !== "READY") {
      const updated = await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_id" = $3, "message_scope_state" = 'READY',
                "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" <> 'CLOSED'
            AND "message_scope_state" IN ('PENDING', 'PROVISIONING', 'FAILED')
            AND ("message_scope_id" IS NULL OR "message_scope_id" = $3)`,
        [options.appId, claim.consultationId, teamId],
      );
      if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", `scope create writeback is unknown: state=${row.messageScopeState} scopeId=${row.messageScopeId ?? "null"} team=${teamId}`);
    }
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
              "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL,
              "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before completion", true);
    await recordAudit(client, { actorType: "system", actorId: claim.ownerAccountId, action: "im.scope.ready", objectType: "im_consultation_scope_operation", objectId: claim.id, outcome: "SUCCESS", requestId: `im_scope_${claim.id}` });
    return true;
  });
}

async function rememberCreatedTeamCandidate(options: ConsultationRouteOptions, claim: ScopeOperationClaim, teamId: string, connection: PoolClient): Promise<void> {
  await onLeaseConnection(connection, async (client) => {
    await lockDispatchGate(client, options.appId);
    await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING" || operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) {
      throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before team candidate was recorded", true);
    }
    if (operation.providerTeamId && operation.providerTeamId !== teamId) {
      throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create returned multiple team IDs", true);
    }
    const recorded = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = COALESCE("provider_team_id", $3), "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING'
          AND "lease_token_hash" = $4 AND "lease_until" > clock_timestamp()` ,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (recorded.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before team candidate was recorded", true);
  });
}

async function readAndValidateTeam(options: ConsultationRouteOptions, teamId: string, ownerAccountId: string): Promise<YunxinSupportTeamState> {
  const team = await options.provider!.getSupportTeam(teamId);
  if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support team state is not readable");
  if (team.ownerAccountId !== ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support team owner is not the server manager", true);
  return team;
}

async function readTeamWithLease(options: ConsultationRouteOptions, lease: ScopeLease, teamId: string): Promise<YunxinSupportTeamState | null> {
  return lease.mutate(`team:${teamId}`, () => options.provider!.getSupportTeam(teamId));
}

async function findTeamWithLease(
  options: ConsultationRouteOptions,
  lease: ScopeLease,
  input: { appId: string; consultationId: string; ownerAccountId: string },
): Promise<YunxinSupportTeamLookup> {
  return lease.mutate(`consultation:${input.consultationId}`, () => options.provider!.findSupportTeam(input));
}

async function mutateTeamMember(
  options: ConsultationRouteOptions,
  lease: ScopeLease,
  teamId: string,
  ownerAccountId: string,
  action: () => Promise<void>,
): Promise<YunxinSupportTeamState> {
  return lease.mutate(`team:${teamId}`, async () => {
    await action();
    return readAndValidateTeam(options, teamId, ownerAccountId);
  });
}

async function convergeCreateTeam(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  lease: ScopeLease,
  team: YunxinSupportTeamState,
  required: string[],
  threadId: string,
  markerId: string,
): Promise<void> {
  if (!allowedMembers(team, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support team contains an unauthorized member", true);
  let current = team;
  for (const accountId of required) {
    if (current.memberAccountIds.includes(accountId)) continue;
    current = await mutateTeamMember(options, lease, current.teamId, claim.ownerAccountId,
      () => options.provider!.addSupportTeamMember(current.teamId, claim.ownerAccountId, accountId));
  }
  if (!exactMembers(current, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support team members do not match consultation", true);
  if (supportMarkerMatches(current.serverExtension,options.appId,markerId)!==true) throw new ScopeOperationFailure("REMOTE_MISMATCH", "consultation Team marker is not confirmed", true);
  if (!await attachCreatedTeam(options, claim, current.teamId, threadId)) throw new ScopeOperationFailure("STALE_OPERATION", "scope operation lost its consultation version", true);
}

async function reconcileCreate(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner || owner !== claim.ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create identity is inconsistent", true);
  const threadRow = (await options.pool.query<{ threadId: string | null }>(
    `SELECT "thread_id" AS "threadId" FROM "zzsh_iam"."im_consultation" WHERE "app_id" = $1 AND "id" = $2`,
    [options.appId, claim.consultationId],
  )).rows[0];
  const threadId = threadRow?.threadId;
  if (!threadId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create has no support thread", true);
  const targetAdminAccountId = claim.targetAdminAccountId;
  if (Boolean(targetAdminAccountId) !== Boolean(claim.targetAdminId)) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create target is inconsistent", true);
  }
  const required = targetAdminAccountId
    ? [owner, claim.userAccountId, targetAdminAccountId]
    : [owner, claim.userAccountId];
  // Legacy round-scoped operations keep their original Team marker; thread-scoped creates use the thread id.
  const markerId = targetAdminAccountId ? claim.consultationId : threadId;
  let team: YunxinSupportTeamState | null = null;
  if (claim.providerTeamId) {
    team = await readTeamWithLease(options, lease, claim.providerTeamId);
    if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "recorded support team candidate is not readable");
  }
  await lease.assertValid();
  if (!team) {
    const lookup = await findTeamWithLease(options, lease, { appId: options.appId, consultationId: markerId, ownerAccountId: owner });
    if (lookup.status === "AMBIGUOUS") throw new ScopeOperationFailure("REQUIRES_MANUAL_REVIEW", "support team cannot be uniquely located", true);
    if (lookup.status === "FOUND") team = lookup.team;
  }
  if (!team) {
    team = await lease.mutate(`consultation:${claim.consultationId}`, async (connection) => {
      const created = await options.provider!.createSupportTeam({
        appId: options.appId,
        consultationId: markerId,
        ownerAccountId: owner,
        memberAccountIds: required.filter((accountId) => accountId !== owner),
      });
      await rememberCreatedTeamCandidate(options, claim, created.teamId, connection);
      return readAndValidateTeam(options, created.teamId, owner);
    });
  }
  if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support team state is not readable");
  await convergeCreateTeam(options, claim, lease, team, required, threadId, markerId);
}

async function completeTransferRecovery(options: ConsultationRouteOptions, claim: ScopeOperationClaim, teamId: string): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.previousAdminId, claim.targetAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "transfer lease changed before reconciliation", true);
    if (!row.threadId) throw new ScopeOperationFailure("STALE_OPERATION", "transfer has no support thread", true);
    const thread = await readThreadById(client, options.appId, row.threadId, true);
    if (thread.messageScopeId !== teamId || thread.messageScopeState !== "READY") {
      throw new ScopeOperationFailure("STALE_OPERATION", "transfer thread Team changed", true);
    }
    const projectThreadResponsible = async () => {
      await client.query(
        `UPDATE "zzsh_iam"."im_support_thread"
            SET "peer_account_id" = $3, "state" = 'ACTIVE', "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2`,
        [options.appId, thread.id, claim.targetAdminAccountId],
      );
    };
    if (row.state === "ACTIVE" && row.messageScopeState === "READY" && row.messageScopeId === teamId && row.assignedAdminId === claim.targetAdminId && row.peerAccountId === claim.targetAdminAccountId) {
      await projectThreadResponsible();
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
                "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "transfer lease changed before completion", true);
      return;
    }
    if (row.state !== "ACTIVE" || row.messageScopeState !== "TRANSFERRING" || row.messageScopeId !== teamId || row.assignedAdminId !== claim.previousAdminId || row.peerAccountId !== claim.previousAdminAccountId) {
      throw new ScopeOperationFailure("STALE_OPERATION", "transfer consultation version changed", true);
    }
    await decrementPresence(client, options.appId, claim.previousAdminId);
    const updated = await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "assigned_admin_id" = $3, "peer_account_id" = $4, "message_scope_state" = 'READY',
              "message_scope_version" = "message_scope_version" + 1, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "message_scope_state" = 'TRANSFERRING'`,
      [options.appId, claim.consultationId, claim.targetAdminId, claim.targetAdminAccountId],
    );
    if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "transfer writeback is unknown");
    // The thread keeps the same Team; only the responsible agent reference moves.
    await client.query(
      `UPDATE "zzsh_iam"."im_support_thread" t
          SET "peer_account_id" = $3, "state" = 'ACTIVE', "version" = t."version" + 1, "updated_at" = clock_timestamp()
        FROM "zzsh_iam"."im_consultation" c
       WHERE c."app_id" = $1 AND c."id" = $2 AND t."id" = c."thread_id"`,
      [options.appId, claim.consultationId, claim.targetAdminAccountId],
    );
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
              "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "transfer lease changed before completion", true);
    const note = claim.previousAdminId && claim.targetAdminId
      ? await readLatestHandoverNote(client, options.appId, "CONSULTATION", claim.consultationId, claim.previousAdminId, claim.targetAdminId)
      : null;
    await writeEvent(client, { consultationId: claim.consultationId, eventType: "TRANSFERRED", actorType: "system", actorId: claim.ownerAccountId, fromAdminId: claim.previousAdminId, toAdminId: claim.targetAdminId, peerAccountId: claim.targetAdminAccountId, details: { recovered: true, ...(note ? { note } : {}) } });
    await recordAudit(client, { actorType: "system", actorId: claim.ownerAccountId, action: "im.scope.transfer.recovered", objectType: "im_consultation_scope_operation", objectId: claim.id, outcome: "SUCCESS", requestId: `im_scope_${claim.id}` });
  });
}

async function reconcileTransfer(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner) throw new ScopeOperationFailure("IDENTITY_PENDING", "IM support manager identity is pending");
  if (owner !== claim.ownerAccountId || !claim.providerTeamId || !claim.previousAdminAccountId || !claim.targetAdminAccountId || !claim.previousAdminId || !claim.targetAdminId) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "transfer identity is inconsistent", true);
  }
  let team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation team is missing", true);
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation owner changed", true);
  const allowed = [owner, claim.userAccountId, claim.previousAdminAccountId, claim.targetAdminAccountId];
  if (!allowedMembers(team, allowed)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation has an unauthorized member", true);
  if (!team.memberAccountIds.includes(claim.targetAdminAccountId)) {
    team = await mutateTeamMember(options, lease, team.teamId, owner,
      () => options.provider!.addSupportTeamMember(team!.teamId, owner, claim.targetAdminAccountId!));
  }
  if (team.memberAccountIds.includes(claim.previousAdminAccountId)) {
    team = await mutateTeamMember(options, lease, team.teamId, owner,
      () => options.provider!.removeSupportTeamMember(team!.teamId, owner, claim.previousAdminAccountId!));
  }
  if (!exactMembers(team, [owner, claim.userAccountId, claim.targetAdminAccountId])) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation members did not converge", true);
  }
  await completeTransferRecovery(options, claim, team.teamId);
}

async function completeClaimRecovery(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  teamId: string,
  threadId: string,
): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.targetAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "claim lease changed before reconciliation", true);
    const thread = await readThreadById(client, options.appId, threadId, true);
    if (row.threadId !== threadId) throw new ScopeOperationFailure("STALE_OPERATION", "claim thread changed", true);
    if (thread.messageScopeId !== teamId || thread.messageScopeState !== "READY") {
      throw new ScopeOperationFailure("STALE_OPERATION", "claim team is no longer bound to the thread", true);
    }
    if (!claim.targetAdminId || !claim.targetAdminAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "claim target is inconsistent", true);
    const alreadyClaimed = row.state === "ACTIVE" && row.assignedAdminId === claim.targetAdminId
      && row.peerAccountId === claim.targetAdminAccountId;
    if (!alreadyClaimed) {
      if (row.state !== "WAITING" || row.assignedAdminId !== null) {
        throw new ScopeOperationFailure("STALE_OPERATION", "claim consultation changed", true);
      }
      if (row.messageScopeId !== null && row.messageScopeId !== teamId) {
        throw new ScopeOperationFailure("STALE_OPERATION", "claim round scope changed", true);
      }
      if (row.messageScopeState !== "READY") throw new ScopeOperationFailure("STALE_OPERATION", "claim round scope is not ready", true);
      const updated = await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "state" = 'ACTIVE', "assigned_admin_id" = $3, "peer_account_id" = $4,
                "message_scope_id" = COALESCE("message_scope_id", $5), "message_scope_state" = 'READY',
                "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'WAITING' AND "assigned_admin_id" IS NULL
            AND "message_scope_state" = 'READY'`,
        [options.appId, claim.consultationId, claim.targetAdminId, claim.targetAdminAccountId, teamId],
      );
      if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "claim writeback is unknown");
      const automatic = (await client.query<{automatic:boolean}>(`SELECT EXISTS(SELECT 1 FROM zzsh_iam.audit_event
        WHERE action='im.consultation.auto_assign.requested' AND object_type='im_consultation'
          AND object_id=$1 AND request_id=$2) AS automatic`,[claim.consultationId,claim.id])).rows[0]?.automatic === true;
      await writeEvent(client, { consultationId: claim.consultationId, eventType: automatic ? "ASSIGNED" : "CLAIMED",
        actorType: automatic ? "system" : "admin", actorId: automatic ? claim.ownerAccountId : claim.targetAdminId,
        toAdminId: claim.targetAdminId, peerAccountId: claim.targetAdminAccountId, details: { threadId } });
      await recordAudit(client, { actorType: "admin", actorId: claim.targetAdminId, action: "im.consultation.claimed", objectType: "im_consultation", objectId: claim.consultationId, outcome: "SUCCESS", requestId: `im_scope_${claim.id}`, details: { threadId, roundSeq: row.roundSeq } });
    }
    // Re-applying the thread projection also repairs a crash after the round writeback.
    await client.query(
      `UPDATE "zzsh_iam"."im_support_thread"
          SET "state" = 'ACTIVE', "peer_account_id" = $3, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2`,
      [options.appId, threadId, claim.targetAdminAccountId],
    );
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
              "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "claim lease changed before completion", true);
  });
}

/** Claim adds the agent to the existing thread Team; only then does the round become ACTIVE. */
async function reconcileAddMember(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner || owner !== claim.ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "claim identity is inconsistent", true);
  if (!claim.providerTeamId || !claim.targetAdminId || !claim.targetAdminAccountId) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "claim operation is incomplete", true);
  }
  const threadId = await readRoundThreadId(options, claim.consultationId);
  const team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support thread Team is not readable");
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team owner changed", true);
  const required = [owner, claim.userAccountId, claim.targetAdminAccountId];
  if (!allowedMembers(team, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team contains an unauthorized member", true);
  let current = team;
  if (!current.memberAccountIds.includes(claim.targetAdminAccountId)) {
    current = await mutateTeamMember(options, lease, current.teamId, owner,
      () => options.provider!.addSupportTeamMember(current.teamId, owner, claim.targetAdminAccountId!));
  }
  if (!exactMembers(current, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team members did not converge", true);
  if (supportMarkerMatches(current.serverExtension, options.appId, threadId) !== true
    && supportMarkerMatches(current.serverExtension, options.appId, claim.consultationId) !== true) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team marker is not confirmed", true);
  }
  await completeClaimRecovery(options, claim, current.teamId, threadId);
}

async function readRoundThreadId(options: ConsultationRouteOptions, consultationId: string): Promise<string> {
  const row = (await options.pool.query<{ threadId: string | null }>(
    `SELECT "thread_id" AS "threadId" FROM "zzsh_iam"."im_consultation" WHERE "app_id" = $1 AND "id" = $2`,
    [options.appId, consultationId],
  )).rows[0];
  if (!row?.threadId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "consultation has no support thread", true);
  return row.threadId;
}

async function completeCloseRecovery(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  teamId: string,
  expectedScopeState: "REVOKING" | "FAILED" = "REVOKING",
): Promise<void> {
  if (claim.appId !== options.appId || claim.operationType !== "CLOSE" || claim.providerTeamId !== teamId) {
    throw new ScopeOperationFailure("STALE_OPERATION", "close operation is not bound to this team", true);
  }
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.previousAdminId, claim.targetAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "close lease changed before reconciliation", true);
    if (row.state === "CLOSED" && row.messageScopeState === "REVOKED") {
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "state" = 'SUCCEEDED', "lease_until" = NULL, "lease_token_hash" = NULL,
                "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $3
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close lease changed before completion", true);
      return;
    }
    const expectedScopeVersion = numberValue(claim.scopeVersion) + (expectedScopeState === "FAILED" ? 1 : 0);
    if (
      row.state !== "ACTIVE"
      || row.messageScopeState !== expectedScopeState
      || row.messageScopeId !== teamId
      || numberValue(row.messageScopeVersion) !== expectedScopeVersion
    ) {
      throw new ScopeOperationFailure("STALE_OPERATION", "close consultation version changed", true);
    }
    const updated = await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "state" = 'CLOSED', "message_scope_state" = 'REVOKED',
              "message_scope_version" = "message_scope_version" + 1, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "message_scope_state" = $3`,
      [options.appId, claim.consultationId, expectedScopeState],
    );
    if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "close writeback is unknown");
    await decrementPresence(client, options.appId, row.assignedAdminId);
    // Legacy CLOSE dismissed the remote Team; the thread must not pretend that history is recoverable.
    await client.query(
      `UPDATE "zzsh_iam"."im_support_thread" t
          SET "state" = 'IDLE', "peer_account_id" = NULL,
              "message_scope_id" = NULL, "message_scope_state" = 'PENDING',
              "version" = t."version" + 1, "updated_at" = clock_timestamp()
        FROM "zzsh_iam"."im_consultation" c
       WHERE c."app_id" = $1 AND c."id" = $2 AND t."id" = c."thread_id"`,
      [options.appId, claim.consultationId],
    );
    await writeEvent(client, { consultationId: claim.consultationId, eventType: "CLOSED", actorType: "system", actorId: claim.ownerAccountId, fromAdminId: row.assignedAdminId, peerAccountId: row.peerAccountId, details: { recovered: true } });
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'SUCCEEDED', "lease_until" = NULL, "lease_token_hash" = NULL,
              "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $3
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close lease changed before completion", true);
    await recordAudit(client, {
      actorType: "system",
      actorId: claim.ownerAccountId,
      action: expectedScopeState === "FAILED" ? "im.scope.close.reconciled" : "im.scope.close.recovered",
      objectType: "im_consultation_scope_operation",
      objectId: claim.id,
      outcome: "SUCCESS",
      requestId: `im_scope_${claim.id}`,
      ...(expectedScopeState === "FAILED" ? { details: { providerAbsenceConfirmed: true } } : {}),
    });
  });
}

async function readSupportTeamExistenceWithLease(
  options: ConsultationRouteOptions,
  lease: ScopeLease,
  claim: ScopeOperationClaim,
): Promise<YunxinSupportTeamExistenceLookup> {
  if (!claim.providerTeamId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close operation has no provider team", true);
  return lease.mutate(`team:${claim.providerTeamId}`, () => options.provider!.readSupportTeamExistence({
    appId: options.appId,
    consultationId: claim.consultationId,
    ownerAccountId: claim.ownerAccountId,
    teamId: claim.providerTeamId!,
  }));
}

async function reconcileClose(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner) throw new ScopeOperationFailure("IDENTITY_PENDING", "IM support manager identity is pending");
  if (owner !== claim.ownerAccountId || !claim.providerTeamId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close identity is inconsistent", true);
  const team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) {
    const existence = await readSupportTeamExistenceWithLease(options, lease, claim);
    if (existence.status !== "ABSENT") {
      throw new ScopeOperationFailure(
        existence.status === "FOUND" ? "PROVIDER_UNKNOWN" : "REMOTE_MISMATCH",
        "support team absence could not be confirmed",
        true,
      );
    }
    await completeCloseRecovery(options, claim, claim.providerTeamId);
    return;
  }
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close team owner changed", true);
  const afterDismiss = await lease.mutate(`team:${claim.providerTeamId}`, async () => {
    await options.provider!.dismissSupportTeam(claim.providerTeamId!, owner);
    return options.provider!.readSupportTeamExistence({
      appId: options.appId,
      consultationId: claim.consultationId,
      ownerAccountId: owner,
      teamId: claim.providerTeamId!,
    });
  });
  if (afterDismiss.status !== "ABSENT") {
    throw new ScopeOperationFailure(
      afterDismiss.status === "FOUND" ? "PROVIDER_UNKNOWN" : "REMOTE_MISMATCH",
      "support team still exists or has the wrong identity after dismiss",
      true,
    );
  }
  await completeCloseRecovery(options, claim, claim.providerTeamId);
}

async function reconcileCloseAfterKnownAbsence(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  if (claim.operationType !== "CLOSE" || !claim.providerTeamId) {
    throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation operation is invalid", true);
  }
  const owner = supportManagerAccount(options).accountId;
  if (owner !== claim.ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close reconciliation owner changed", true);
  const existence = await readSupportTeamExistenceWithLease(options, lease, claim);
  if (existence.status === "AMBIGUOUS") {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "close reconciliation team identity is ambiguous", true);
  }
  if (existence.status === "FOUND") {
    throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support team still exists after close reconciliation", true);
  }
  await completeCloseRecovery(options, claim, claim.providerTeamId, "FAILED");
}

async function completeRoundCloseRecovery(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  teamId: string,
  threadId: string,
  teamGone = false,
): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.previousAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "round close lease changed before reconciliation", true);
    const thread = await readThreadById(client, options.appId, threadId, true);
    if (row.threadId !== threadId) throw new ScopeOperationFailure("STALE_OPERATION", "round close thread changed", true);
    const settleSuccess = async () => {
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "state" = 'SUCCEEDED', "lease_until" = NULL, "lease_token_hash" = NULL,
                "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $3
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "round close lease changed before completion", true);
    };
    if (row.state === "CLOSED" && thread.state === "IDLE") {
      await settleSuccess();
      return;
    }
    if (!claim.previousAdminId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close operation has no responsible agent", true);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== claim.previousAdminId || row.messageScopeState !== "REVOKING"
      || row.messageScopeId !== teamId) {
      throw new ScopeOperationFailure("STALE_OPERATION", "round close consultation changed", true);
    }
    if (!teamGone && (thread.messageScopeId !== teamId || thread.messageScopeState !== "READY")) {
      throw new ScopeOperationFailure("STALE_OPERATION", "round close thread scope changed", true);
    }
    const updated = await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "state" = 'CLOSED', "message_scope_state" = 'READY',
              "message_scope_version" = "message_scope_version" + 1,
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "message_scope_state" = 'REVOKING'`,
      [options.appId, claim.consultationId],
    );
    if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "round close writeback is unknown");
    await decrementPresence(client, options.appId, claim.previousAdminId);
    // 结束本轮不 dismiss Team、不删除历史；线程回 IDLE 等待用户再次触发。
    await client.query(
      teamGone
        ? `UPDATE "zzsh_iam"."im_support_thread"
              SET "state" = 'IDLE', "peer_account_id" = NULL,
                  "message_scope_id" = NULL, "message_scope_state" = 'PENDING',
                  "version" = "version" + 1, "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2`
        : `UPDATE "zzsh_iam"."im_support_thread"
              SET "state" = 'IDLE', "peer_account_id" = NULL,
                  "version" = "version" + 1, "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2`,
      [options.appId, threadId],
    );
    await writeEvent(client, { consultationId: claim.consultationId, eventType: "CLOSED", actorType: "system", actorId: claim.ownerAccountId, fromAdminId: claim.previousAdminId, peerAccountId: claim.previousAdminAccountId, details: { roundClosed: true, threadId, teamRetained: !teamGone } });
    await recordAudit(client, {
      actorType: "system",
      actorId: claim.ownerAccountId,
      action: teamGone ? "im.scope.round_close.reconciled" : "im.scope.round_close.completed",
      objectType: "im_consultation_scope_operation",
      objectId: claim.id,
      outcome: "SUCCESS",
      requestId: `im_scope_${claim.id}`,
      details: { threadId, teamRetained: !teamGone },
    });
    await settleSuccess();
  });
}

async function reconcileRoundClose(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner || owner !== claim.ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close identity is inconsistent", true);
  if (!claim.providerTeamId || !claim.previousAdminAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close operation is incomplete", true);
  const threadId = await readRoundThreadId(options, claim.consultationId);
  const team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) {
    const existence = await readSupportTeamExistenceWithLease(options, lease, claim);
    if (existence.status !== "ABSENT") {
      throw new ScopeOperationFailure(existence.status === "FOUND" ? "PROVIDER_UNKNOWN" : "REMOTE_MISMATCH", "support team absence could not be confirmed", true);
    }
    // 线程 Team 已不存在：本轮按本地事实结束，线程不再声称旧历史可恢复。
    await completeRoundCloseRecovery(options, claim, claim.providerTeamId, threadId, true);
    return;
  }
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close Team owner changed", true);
  if (supportMarkerMatches(team.serverExtension, options.appId, threadId) !== true
    && supportMarkerMatches(team.serverExtension, options.appId, claim.consultationId) !== true) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close Team marker is not confirmed", true);
  }
  let current = team;
  if (current.memberAccountIds.includes(claim.previousAdminAccountId)) {
    current = await mutateTeamMember(options, lease, current.teamId, owner,
      () => options.provider!.removeSupportTeamMember(current.teamId, owner, claim.previousAdminAccountId!));
  }
  if (current.memberAccountIds.includes(claim.previousAdminAccountId)) {
    throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "responsible agent is still a Team member after removal", true);
  }
  if (!allowedMembers(current, [owner, claim.userAccountId])) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team retained an unauthorized member", true);
  }
  await completeRoundCloseRecovery(options, claim, current.teamId, threadId);
}

function activeLease(value: Date | string | null): boolean {
  if (value === null) return false;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp > Date.now();
}

async function claimCloseReconciliation(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  requestId: string,
): Promise<ScopeOperationClaim | "SUCCEEDED" | null> {
  if (!options.provider) throw unavailable("IM message scope provider is not configured");
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportTransfer)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId, true);
    if (row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    requireSupportAccess(access, row.kind);
    const latest = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
         WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (!latest) return null;
    const detail = await readScopeOperation(client, options.appId, latest.id, true);
    if (detail.operationType !== "CLOSE") return null;
    if (detail.state === "SUCCEEDED") return "SUCCEEDED";
    if (detail.state !== "NEEDS_REVIEW") return null;
    if (row.state !== "ACTIVE") throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation consultation is no longer active", true);
    if (detail.leaseTokenHash !== null || activeLease(detail.leaseUntil)) {
      throw unavailable("IM close reconciliation lease is still active");
    }
    const closeReadEligibleFailure =
      (detail.lastFailureClass === "REQUIRES_MANUAL_REVIEW" && detail.lastFailureDetail === "yunxin:get-support-team")
      || (detail.lastFailureClass === "PROVIDER_UNKNOWN" && detail.lastFailureDetail === "yunxin:dismiss-support-team");
    if (numberValue(detail.attemptCount) !== 1 || !closeReadEligibleFailure) {
      throw unavailable("IM close reconciliation is not eligible for the single read");
    }
    if (
      !detail.providerTeamId
      || row.messageScopeId !== detail.providerTeamId
      || row.userAccountId !== detail.userAccountId
      || row.messageScopeState !== "FAILED"
      || numberValue(row.messageScopeVersion) !== numberValue(detail.scopeVersion) + 1
    ) {
      throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation binding or version changed", true);
    }
    if (supportManagerAccount(options).accountId !== detail.ownerAccountId) {
      throw new ScopeOperationFailure("REMOTE_MISMATCH", "close reconciliation manager changed", true);
    }
    const leaseToken = randomBytes(32).toString("base64url");
    const requeued = await client.query<{ id: string }>(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'PENDING', "next_retry_at" = clock_timestamp(), "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "operation_type" = 'CLOSE'
          AND "state" = 'NEEDS_REVIEW' AND "attempt_count" = 1
          AND "scope_version" = $3 AND "provider_team_id" = $4
          AND "lease_token_hash" IS NULL
          AND ("lease_until" IS NULL OR "lease_until" <= clock_timestamp())
        RETURNING "id"`,
      [options.appId, detail.id, detail.scopeVersion, detail.providerTeamId],
    );
    if (requeued.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation state changed", true);
    const claimed = await client.query<{ id: string }>(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'RUNNING', "attempt_count" = "attempt_count" + 1,
              "lease_until" = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
              "lease_token_hash" = $4, "last_failure_class" = NULL,
              "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "operation_type" = 'CLOSE'
          AND "state" = 'PENDING' AND "attempt_count" = 1
          AND "scope_version" = $5 AND "provider_team_id" = $6
          AND "lease_token_hash" IS NULL
          AND ("lease_until" IS NULL OR "lease_until" <= clock_timestamp())
        RETURNING "id"`,
      [options.appId, detail.id, SCOPE_LEASE_MS, scopeLeaseHash(leaseToken), detail.scopeVersion, detail.providerTeamId],
    );
    if (claimed.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation lease changed", true);
    const claimRow = await readScopeOperation(client, options.appId, detail.id, true);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.scope.close.reconciliation.started",
      objectType: "im_consultation_scope_operation",
      objectId: detail.id,
      outcome: "SUCCESS",
      requestId,
      details: {
        providerTeamId: detail.providerTeamId,
        priorAttemptCount: 1,
        expectedScopeVersion: numberValue(row.messageScopeVersion),
        readLimit: 1,
      },
    });
    return { ...claimRow, leaseToken, attemptCount: numberValue(claimRow.attemptCount) };
  });
}

type ScopeOperationExecutionMode = "NORMAL" | "CLOSE_ABSENCE";

async function executeScopeOperation(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  mode: ScopeOperationExecutionMode = "NORMAL",
): Promise<"SUCCEEDED" | "RETRYING" | "NEEDS_REVIEW"> {
  const lease = createScopeLease(options, claim);
  try {
    if (claim.operationType === "CREATE") await reconcileCreate(options, claim, lease);
    else if (claim.operationType === "TRANSFER") await reconcileTransfer(options, claim, lease);
    else if (claim.operationType === "ADD_MEMBER") await reconcileAddMember(options, claim, lease);
    else if (claim.operationType === "ROUND_CLOSE") await reconcileRoundClose(options, claim, lease);
    else if (mode === "CLOSE_ABSENCE") await reconcileCloseAfterKnownAbsence(options, claim, lease);
    else await reconcileClose(options, claim, lease);
    await lease.stop();
    return "SUCCEEDED";
  } catch (error) {
    await lease.stop();
    return settleScopeOperationFailure(options, claim, providerFailure(error));
  }
}

async function runScopeOperationNow(options: ConsultationRouteOptions, operationId: string): Promise<void> {
  const claim = await claimScopeOperation(options, operationId);
  if (!claim) return;
  const result = await executeScopeOperation(options, claim);
  if (result !== "SUCCEEDED") throw unavailable("IM message scope is being recovered");
}

export async function reconcileMessageScopes(options: ConsultationRouteOptions, limit = 10, onFailure?: ScopeRecoveryFailureObserver): Promise<number> {
  if (!options.provider || !options.supportManager) return 0;
  await quarantineUncertainScopeOperations(options, limit);
  const candidates = await options.pool.query<{ id: string }>(
    `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
      WHERE "app_id" = $1 AND (
        ("state" = 'PENDING' AND "next_retry_at" <= clock_timestamp())
        OR ("state" = 'UNKNOWN' AND "last_failure_class" = 'IDENTITY_PENDING'
            AND "next_retry_at" <= clock_timestamp())
      ) ORDER BY "next_retry_at", "updated_at", "id" LIMIT $2`,
    [options.appId, limit],
  );
  let claimedCount = 0;
  for (const candidate of candidates.rows) {
    try {
      const claim = await claimScopeOperation(options, candidate.id);
      if (!claim) continue;
      claimedCount += 1;
      await executeScopeOperation(options, claim);
    } catch (error) {
      reportRecoveryFailure(onFailure, error);
    }
  }
  return claimedCount;
}

export function startMessageScopeRecovery(options: ConsultationRouteOptions, intervalMs = 30_000, onFailure?: ScopeRecoveryFailureObserver): () => Promise<void> {
  if (!options.provider || !options.supportManager) return async () => undefined;
  let stopped = false;
  let inFlight: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    const current = reconcileMessageScopes(options, 10, onFailure).catch((error) => {
      reportRecoveryFailure(onFailure, error);
    });
    inFlight = current;
    void current.finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
  }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    const current = inFlight;
    if (current) await current;
  };
}

@Injectable()
export class MessageScopeRecoveryLifecycle implements BeforeApplicationShutdown {
  private readonly logger = new Logger(MessageScopeRecoveryLifecycle.name);
  private stopRecovery: (() => Promise<void>) | undefined;

  start(options: ConsultationRouteOptions, intervalMs = 30_000): void {
    if (this.stopRecovery) return;
    this.stopRecovery = startMessageScopeRecovery(options, intervalMs, (failureClass) => {
      this.logger.error(JSON.stringify({ event: "im.scope.recovery.failed", failureClass }));
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    const stop = this.stopRecovery;
    this.stopRecovery = undefined;
    if (stop) await stop();
  }
}

async function ensureThreadTeam(options: ConsultationRouteOptions, threadId: string, roundId: string): Promise<void> {
  const operation = await beginThreadTeamProvision(options, threadId, roundId);
  if (!operation) return;
  await runScopeOperationNow(options, operation.operationId);
}

async function readUserConsultationView(options: ConsultationRouteOptions, context: UserContext, consultationId: string): Promise<{ consultation: ConsultationView }> {
  return withTransaction(options.pool, async (client) => {
    await assertUserContextInTransaction(client, context);
    const accountId = await readyAccount(client, identityKey(options.appId, "user", "USER", context.userId));
    const row = (await client.query<ConsultationRow>(
      `${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND c."id" = $2 AND c."user_id" = $3`,
      [options.appId, consultationId, context.userId],
    )).rows[0];
    if (!row) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
    return { consultation: { ...toView(row, accountId), botAccountId: supportBotAccountId(options) } };
  });
}

async function readAdminConsultationView(options: ConsultationRouteOptions, context: AdminContext, consultationId: string): Promise<{ consultation: ConsultationView }> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const accountId = await readyAccount(client, identityKey(options.appId, "admin", "ADMIN", context.userId));
    const access = await loadEffectiveAdminAccess(client, context.userId);
    const adminThreadRead = Boolean(access?.isBoss || hasPermission(access, ADMIN_PERMISSION.imSupportManagementRead));
    return { consultation: { ...toView(await readConsultation(client, options.appId, consultationId), accountId, true, context.userId, adminThreadRead), botAccountId: supportBotAccountId(options) } };
  });
}

export type ImConversationAccess = { viewerAccountId: string; peerAccountId: string };

function teamIdFromConversationId(accountId: string, conversationId: string): string {
  const prefix = `${accountId}|2|`;
  const teamId = conversationId.startsWith(prefix) ? conversationId.slice(prefix.length) : "";
  if (!/^\d{1,19}$/.test(teamId) || teamConversationId(accountId, teamId) !== conversationId) {
    throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
  }
  return teamId;
}

/** 双端 account 都符合 ACCOUNT_PATTERN；订单群也会命中形状，由线程 join 自然 no-op。 */
const TEAM_CONVERSATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}\|2\|([0-9]{1,19})$/;

/** 摘要折叠空白并按码点截断到 80，空串归一为 null；客户端原文不直接进入队列。 */
export function supportMessagePreview(value: string | null): string | null {
  if (value === null) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return [...collapsed].slice(0, 80).join("");
}

/**
 * Best-effort 最近消息摘要：只更新该 Team 对应线程上未结束的轮次。
 * 订单群或未知 Team 没有匹配线程即 no-op；调用方在消息发送成功后调用并自行吞错。
 * fromUser 只有用户本人发出的消息才置 true：它推进 first_user_message_at，
 * 平台欢迎/兜底与客服消息绝不写这个字段。返回是否命中了一个真实咨询轮次。
 */
export async function recordSupportThreadMessage(
  options: Pick<ConsultationRouteOptions, "pool" | "appId">,
  conversationId: string,
  preview: string | null,
  fromUser = false,
): Promise<boolean> {
  const teamId = TEAM_CONVERSATION_PATTERN.exec(conversationId)?.[1];
  if (!teamId) return false;
  const result = await options.pool.query(
    `UPDATE "zzsh_iam"."im_consultation" c
        SET "last_message_at" = clock_timestamp(), "last_message_preview" = $3,
            "user_unread_count" = CASE WHEN $4::boolean THEN c."user_unread_count" ELSE LEAST(c."user_unread_count" + 1, 999) END,
            "admin_unread_count" = CASE WHEN $4::boolean THEN LEAST(c."admin_unread_count" + 1, 999) ELSE c."admin_unread_count" END,
            "first_user_message_at" = CASE WHEN $4::boolean
              THEN COALESCE(c."first_user_message_at", clock_timestamp())
              ELSE c."first_user_message_at" END,
            "updated_at" = clock_timestamp()
       FROM "zzsh_iam"."im_support_thread" t
      WHERE c."app_id" = $1 AND t."app_id" = c."app_id" AND c."thread_id" = t."id"
        AND t."message_scope_id" = $2 AND c."state" <> 'CLOSED'
      RETURNING c."id"`,
    [options.appId, teamId, supportMessagePreview(preview), fromUser],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * 首响事实：本轮首条人工回复只记一次，落在 append-only 的 audit_event。
 * ponytail: 0120 只加了 first_user_message_at，事件类型又受 0032 的 CHECK 约束，暂不新增列/新事件类型；
 * 写入封在本函数、读取封在 support-management.ts::readConsultationFirstResponse，将来补正列只改这两处。
 * 口径差异：这里是“平台确认人工发送成功”，由云信核验 SDK 结果；不代表对方已读，重试不重复计。
 */
async function recordSupportFirstResponse(
  client: PoolClient,
  row: ConsultationRow,
  context: Pick<AdminContext,"userId"|"sessionId">,
  requestId?: string,
  sentAt?: number,
): Promise<void> {
  await client.query(
    `INSERT INTO "zzsh_iam"."audit_event"
       ("id","actor_type","actor_id","session_id","action","object_type","object_id","outcome","request_id","occurred_at","details")
     SELECT $1,'admin',$2,$3,$4,'im_consultation',$5,'SUCCESS',$6,COALESCE(to_timestamp($8::double precision/1000),clock_timestamp()),$7::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM "zzsh_iam"."audit_event"
                         WHERE "action" = $4 AND "object_type" = 'im_consultation' AND "object_id" = $5)`,
    [`audit_${randomUUID().replaceAll("-", "")}`, context.userId, context.sessionId, SUPPORT_FIRST_RESPONSE_ACTION,
      row.id, requestId ?? `im_first_response_${row.id}`,
      JSON.stringify({ threadId: row.threadId ?? null, roundSeq: row.roundSeq ?? null, adminUserId: context.userId }),sentAt??null],
  );
}

/**
 * 首响超时提醒事实（与订单群 first_response_reminder 同语义）：每轮只记一条提醒。
 * NOT_WIRED: 需要 worker 装配（auth-runtime）按批调用；插入 0 行不是失败。
 */
export async function scanSupportFirstResponseBreaches(
  options: Pick<ConsultationRouteOptions, "pool" | "appId" | "firstResponseSeconds">,
  limit = 20,
): Promise<{ overdue: string[]; reminded: string[] }> {
  const seconds = resolveFirstResponseSeconds(options.firstResponseSeconds);
  const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const rows = (await options.pool.query<{ id: string; reminded: boolean }>(
    `WITH due AS (
       SELECT c."id"
         FROM "zzsh_iam"."im_consultation" c
        WHERE c."app_id" = $1 AND c."state" IN ('WAITING', 'ACTIVE')
          AND c."first_user_message_at" IS NOT NULL
          AND c."first_user_message_at" <= clock_timestamp() - ($2::int * interval '1 second')
          AND NOT EXISTS (SELECT 1 FROM "zzsh_iam"."audit_event" a
                           WHERE a."action" = $3 AND a."object_type" = 'im_consultation' AND a."object_id" = c."id")
          AND NOT EXISTS (SELECT 1 FROM "zzsh_iam"."audit_event" a
                           WHERE a."action" = $4 AND a."object_type" = 'im_consultation' AND a."object_id" = c."id")
        ORDER BY c."first_user_message_at", c."id" LIMIT $5
     ), inserted AS (
       INSERT INTO "zzsh_iam"."audit_event"
         ("id","actor_type","actor_id","action","object_type","object_id","outcome","request_id","occurred_at","details")
       SELECT 'audit_' || replace(gen_random_uuid()::text, '-', ''), 'system', NULL, $4, 'im_consultation', d."id",
              'SUCCESS', 'im_first_response_reminder_' || d."id", clock_timestamp(),
              jsonb_build_object('slaSeconds', $2::int)
         FROM due d
       RETURNING "object_id"
     )
     SELECT d."id", EXISTS (SELECT 1 FROM inserted i WHERE i."object_id" = d."id") AS "reminded" FROM due d`,
    [options.appId, seconds, SUPPORT_FIRST_RESPONSE_ACTION, SUPPORT_FIRST_RESPONSE_REMINDER_ACTION, bounded],
  )).rows;
  return { overdue: rows.map((row) => row.id), reminded: rows.filter((row) => row.reminded).map((row) => row.id) };
}

/**
 * User message access is thread-based: history stays readable in IDLE, WAITING
 * and ACTIVE as long as the thread Team exists. A send also (re)opens a round so
 * the next responsible agent sees a WAITING round instead of a CLOSED history.
 */
export async function readUserMessageAccess(
  options: ConsultationRouteOptions,
  context: UserContext,
  conversationId: string,
  send = false,
  intent?: ImSendIntent,
  entryIntent:ConsultationEntryIntent="SERVICE",
): Promise<ImConversationAccess> {
  const result = await withTransaction(options.pool, async (client) => {
    await assertUserContextInTransaction(client, context);
    const viewerAccountId = await readyAccount(client, identityKey(options.appId, "user", "USER", context.userId));
    const teamId = teamIdFromConversationId(viewerAccountId, conversationId);
    const thread = (await client.query<ThreadRow>(
      `${THREAD_SELECT}
        WHERE "app_id" = $1 AND "user_id" = $2 AND "message_scope_id" = $3
          AND "message_scope_state" = 'READY' AND "user_account_id" = $4
        FOR UPDATE`,
      [options.appId, context.userId, teamId, viewerAccountId],
    )).rows[0];
    if (!thread) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
    let opened: WaitingRound | null = null;
    let roundId: string | null = null;
    if (send) {
      const open = (await client.query<{ id: string; state: ConsultationState }>(
        `SELECT "id", "state" FROM "zzsh_iam"."im_consultation"
          WHERE "app_id" = $1 AND "thread_id" = $2 AND "state" <> 'CLOSED' FOR UPDATE`,
        [options.appId, thread.id],
      )).rows[0];
      if (!open) {
        if (thread.state === "ACTIVE") throw unavailable("IM support thread state is inconsistent");
        // 消息入口没有场景参数；重开轮次按普通客服咨询欢迎。真正的分配由调用方在
        // 消息落库（first_user_message_at）后触发。
        opened = await createWaitingRound(client, options, thread, { subjectRef: null, entryIntent, actorType: "user", actorId: context.userId });
      } else if (thread.state === "IDLE") {
        await client.query(
          `UPDATE "zzsh_iam"."im_support_thread"
              SET "state" = $3, "version" = "version" + 1, "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'IDLE'`,
          [options.appId, thread.id, open.state === "ACTIVE" ? "ACTIVE" : "WAITING"],
        );
      }
      roundId = opened?.id ?? open?.id ?? null;
    }
    let peerAccountId = thread.peerAccountId;
    if (!peerAccountId) {
      // Team messages do not route by receiver; the manager account is the stable
      // platform-side member while no agent is responsible.
      peerAccountId = deriveYunxinAccountId(supportManagerIdentityKey(options.appId));
    }
    if (send && intent && roundId) await storeImSendIntent(client,{...intent,appId:options.appId,threadId:thread.id,roundId,conversationId,accountId:viewerAccountId,actorId:context.userId,realm:"user"},{...context,realm:"user"});
    return { access: { viewerAccountId, peerAccountId }, threadId: thread.id, threadMessageScopeId: thread.messageScopeId, opened };
  });
  // 只有本次调用真正打开了新轮次才执行欢迎和自动分配；普通发送不会重复触发。
  // 副作用在提交后 fire-and-forget：慢 NIM 不能把已经落库的发送/开轮误报为失败。
  if (result.opened) {
    void afterRoundOpened(options, {
      roundId: result.opened.id,
      threadId: result.threadId,
      threadScopeReady: result.opened.threadScopeReady,
      threadMessageScopeId: result.threadMessageScopeId,
      created: result.opened.created,
      entryIntent,
    }).catch(() => undefined);
  }
  return result.access;
}

export async function readAdminMessageAccess(
  options: ConsultationRouteOptions,
  context: AdminContext,
  conversationId: string,
  requireSendPermission = false,
  requestId?: string,
  intent?: ImSendIntent,
): Promise<ImConversationAccess> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const viewerAccountId = await readyAccount(client, identityKey(options.appId, "admin", "ADMIN", context.userId));
    const teamId = teamIdFromConversationId(viewerAccountId, conversationId);
    // Current round if open, otherwise the latest closed round on the same thread Team.
    const matching = (await client.query<ConsultationRow>(
      `${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND t."message_scope_id" = $2 AND t."message_scope_state" = 'READY'
        ORDER BY (c."state" <> 'CLOSED') DESC, c."created_at" DESC, c."id" DESC LIMIT 1`,
      [options.appId, teamId],
    )).rows[0];
    if (!matching || matching.threadScopeState !== "READY" || (requireSendPermission && matching.state !== "ACTIVE")) {
      throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
    }
    const access = await loadEffectiveAdminAccess(client, context.userId);
    const assigned = matching.assignedAdminId === context.userId;
    if(!hasPermission(access,ADMIN_PERMISSION.imSupportRead)&&!hasPermission(access,ADMIN_PERMISSION.imSupportManagementRead))throw new SecurityApiError(403,"FORBIDDEN","Permission required");
    if (assigned) {
      if (matching.peerAccountId !== viewerAccountId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
      // One responsible agent per round: only the ACTIVE assignee may send.
      if (requireSendPermission && matching.state !== "ACTIVE") throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
    } else {
      // 运营巡视旁路：只读任意会话，不要求 assigned；发送权限仍逐次重查。
      if (requireSendPermission || !hasPermission(access, ADMIN_PERMISSION.imSupportManagementRead)) {
        throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
      }
      await recordAudit(client, {
        actorType: "admin",
        actorId: context.userId,
        sessionId: context.sessionId,
        action: "im.audit.conversation_viewed",
        objectType: "im_consultation",
        objectId: matching.id,
        outcome: "SUCCESS",
        requestId: requestId ?? `im_patrol_${matching.id}`,
        details: { mode: "PATROL_READ", teamId },
      });
    }
    // History remains readable under the directory/read contract; every send
    // rechecks the current type-specific reception grant in this transaction.
    if (requireSendPermission) {
      requireSupportAccess(access, matching.kind);
      if (intent && matching.threadId) await storeImSendIntent(client,{...intent,appId:options.appId,threadId:matching.threadId,roundId:matching.id,conversationId,accountId:viewerAccountId,actorId:context.userId,realm:"admin"},{...context,realm:"admin"});
    }
    return { viewerAccountId, peerAccountId: matching.userAccountId };
  });
}

/** A verified SDK success consumes the original authorization, never the currently selected round. */
export async function recordConfirmedConsultationMessage(options:ConsultationRouteOptions,actor:ImReceiptActor,message:ImReceiptMessage,preview:string|null):Promise<boolean>{
  return withTransaction(options.pool,async client=>{
    if(actor.realm==="user")await assertUserContextInTransaction(client,actor);
    else {
      await assertAdminContextInTransaction(client,actor);
      const access=await loadEffectiveAdminAccess(client,actor.userId);
      if(!hasPermission(access,ADMIN_PERMISSION.imSupportRead))throw new SecurityApiError(403,"FORBIDDEN","Permission required");
    }
    const accountId=await readyAccount(client,identityKey(options.appId,actor.realm,actor.realm==="user"?"USER":"ADMIN",actor.userId));
    if(accountId!==message.senderId)throw new SecurityApiError(403,"FORBIDDEN","Message sender mismatch");
    const intent=await readImSendIntent(client,options.appId,accountId,message.messageClientId);
    if(!intent||intent.actorId!==actor.userId||intent.realm!==actor.realm||intent.conversationId!==message.conversationId||intent.messageType!==message.messageType)throw invalid("Message authorization is missing");
    const row=(await client.query<ConsultationRow>(`${CONSULTATION_SELECT} WHERE c."app_id"=$1 AND c."id"=$2 AND c."thread_id"=$3 FOR UPDATE OF c`,[options.appId,intent.roundId,intent.threadId])).rows[0];
    if(!row||row.threadScopeId!==TEAM_CONVERSATION_PATTERN.exec(message.conversationId)?.[1]||(actor.realm==="user"&&row.userId!==actor.userId))throw new SecurityApiError(403,"FORBIDDEN","Message scope mismatch");
    if(!await insertImSentFact(client,options.appId,accountId,actor,message,row.id))return false;
    await client.query(`UPDATE zzsh_iam.im_consultation SET
      last_message_preview=CASE WHEN last_message_at IS NULL OR last_message_at<=to_timestamp($3/1000.0) THEN $4 ELSE last_message_preview END,
      last_message_at=greatest(last_message_at,to_timestamp($3/1000.0)),
      admin_unread_count=CASE WHEN $5 AND (admin_read_at IS NULL OR admin_read_at<to_timestamp($3/1000.0)) THEN least(admin_unread_count+1,999) ELSE admin_unread_count END,
      user_unread_count=CASE WHEN NOT $5 AND EXISTS(SELECT 1 FROM zzsh_iam.im_support_thread read_thread WHERE read_thread.id=im_consultation.thread_id AND (read_thread.user_read_at IS NULL OR read_thread.user_read_at<to_timestamp($3/1000.0))) THEN least(user_unread_count+1,999) ELSE user_unread_count END,
      first_user_message_at=CASE WHEN $5 THEN least(first_user_message_at,greatest(created_at,to_timestamp($3/1000.0))) ELSE first_user_message_at END,updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2 AND state<>'CLOSED'`,[options.appId,row.id,message.createTime,supportMessagePreview(preview),actor.realm==="user"]);
    if(actor.realm==="admin")await recordSupportFirstResponse(client,row,actor,undefined,message.createTime);
    return true;
  });
}

export async function recordLocalAdminMessageSuccess(options:ConsultationRouteOptions,actor:Pick<AdminContext,"userId"|"sessionId">,conversationId:string):Promise<void>{
  await withTransaction(options.pool,async client=>{
    await assertAdminContextInTransaction(client,actor);
    const row=(await client.query<ConsultationRow>(`${CONSULTATION_SELECT} WHERE c."app_id"=$1 AND t."message_scope_id"=$2 AND c."state"='ACTIVE' AND c."assigned_admin_id"=$3 FOR UPDATE OF c`,[options.appId,TEAM_CONVERSATION_PATTERN.exec(conversationId)?.[1],actor.userId])).rows[0];
    if(row)await recordSupportFirstResponse(client,row,actor);
  });
}

export async function createOrResumeUserConsultation(
  options: ConsultationRouteOptions,
  context: UserContext,
  type: SupportType,
  subjectRef: string | null,
  requestId: string,
  entryIntent: ConsultationEntryIntent = "SERVICE",
): Promise<{ consultation: ConsultationView }> {
  const result = await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [context.userId]);
    await setAuditContext(client, "user", context.userId, context.sessionId, requestId);
    await assertUserContextInTransaction(client, context);
    if (subjectRef?.startsWith("legacy-order:")) {
      const legacyId = subjectRef.slice("legacy-order:".length);
      if (!await resolveLegacyConsultationOrder(client, legacyId, context.userId)) {
        throw new SecurityApiError(404, "NOT_FOUND", "Order not found");
      }
    }
    const accountId = await readyAccount(client, identityKey(options.appId, "user", "USER", context.userId));
    const thread = await ensureThread(client, options.appId, context.userId, type, accountId);
    const open = (await client.query<{ id: string; state: ConsultationState }>(
      `SELECT "id", "state" FROM "zzsh_iam"."im_consultation"
        WHERE "app_id" = $1 AND "thread_id" = $2 AND "state" <> 'CLOSED' FOR UPDATE`,
      [options.appId, thread.id],
    )).rows[0];
    // A round keeps its immutable entry source; later order context travels in messages/cards.
    const round = open
      ? { id: open.id, state: open.state, created: false, threadScopeReady: thread.messageScopeState === "READY" }
      : await createWaitingRound(client, options, thread, { subjectRef, entryIntent, actorType: "user", actorId: context.userId, requestId });
    await recordAudit(client, {
      actorType: "user",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: round.created ? "im.consultation.created" : "im.consultation.resumed",
      objectType: "im_consultation",
      objectId: round.id,
      outcome: "SUCCESS",
      requestId,
      details: { type, entryIntent, threadId: thread.id, openedNewRound: round.created },
    });
    return { id: round.id, threadId: thread.id, threadMessageScopeId: thread.messageScopeId, threadScopeReady: round.threadScopeReady, created: round.created };
  });
  const view = await readUserConsultationView(options, context, result.id);
  // 业务事实和视图已经提交/读出；欢迎失败不回滚、也不阻塞响应。进入页面不发欢迎时
  // 不分配：自动分配只在用户第一条消息落库后由消息入口触发。
  void afterRoundOpened(options, {
    roundId: result.id,
    threadId: result.threadId,
    threadScopeReady: result.threadScopeReady,
    threadMessageScopeId: result.threadMessageScopeId,
    created: result.created,
    entryIntent,
  }).catch(() => undefined);
  return view;
}

/** A pending, assigned aftersale is the authority to prepare this user's existing SERVICE thread. */
export async function prepareAftersaleConsultation(options:ConsultationRouteOptions,context:AdminContext,recordId:string,requestId:string):Promise<{id:string;state:ConsultationState;assignedAdminId:string|null}> {
  const result=await withTransaction(options.pool,async client=>{
    await assertAdminContextInTransaction(client,context);
    const first=(await client.query<{requester_user_id:string}>(`SELECT requester_user_id FROM zzsh_iam.im_aftersale_record WHERE app_id=$1 AND id=$2 AND state='PENDING'`,[options.appId,recordId])).rows[0];
    if(!first)throw new SecurityApiError(404,"NOT_FOUND","Aftersale record not found");
    await lockSupportMutation(client,options.appId,[first.requester_user_id],[context.userId]);
    await assertAdminContextInTransaction(client,context);
    const access=await loadEffectiveAdminAccess(client,context.userId);
    if(!hasPermission(access,ADMIN_PERMISSION.imSupportRead)||!hasPermission(access,ADMIN_PERMISSION.imSupportAccept))throw new SecurityApiError(403,"FORBIDDEN","Permission required");
    await assertAftersaleUserActive(client,first.requester_user_id);
    const record=(await client.query<{requester_user_id:string;order_id:string;handler_admin_id:string|null}>(`SELECT a.requester_user_id,a.order_id,a.handler_admin_id FROM zzsh_iam.im_aftersale_record a
      JOIN zzsh_order.rental_order o ON o.id=a.order_id AND (o.renter_user_id=a.requester_user_id OR o.owner_user_id=a.requester_user_id)
      WHERE a.app_id=$1 AND a.id=$2 AND a.state='PENDING' FOR UPDATE OF a`,[options.appId,recordId])).rows[0];
    if(!record||record.requester_user_id!==first.requester_user_id)throw new SecurityApiError(404,"NOT_FOUND","Aftersale record not found");
    const manager=Boolean(access?.isBoss||hasPermission(access,ADMIN_PERMISSION.imSupportAuditTakeover));
    const accountId=await readyAccount(client,identityKey(options.appId,"user","USER",record.requester_user_id));
    const thread=await ensureThread(client,options.appId,record.requester_user_id,"SERVICE",accountId);
    const open=(await client.query<{id:string;state:ConsultationState;assignedAdminId:string|null}>(`SELECT id,state,assigned_admin_id AS "assignedAdminId" FROM zzsh_iam.im_consultation WHERE app_id=$1 AND thread_id=$2 AND state<>'CLOSED' FOR UPDATE`,[options.appId,thread.id])).rows[0];
    const owner=open?.state==="ACTIVE"?open.assignedAdminId:record.handler_admin_id;
    if(owner&&owner!==context.userId&&!manager)throw new SecurityApiError(403,"FORBIDDEN","Aftersale contact belongs to another agent");
    if(!owner||owner===context.userId||open?.state!=="ACTIVE"){
      await client.query(`UPDATE zzsh_iam.im_aftersale_record SET handler_admin_id=$3,version=version+CASE WHEN handler_admin_id IS DISTINCT FROM $3 THEN 1 ELSE 0 END,updated_at=clock_timestamp() WHERE app_id=$1 AND id=$2`,[options.appId,recordId,context.userId]);
    }
    const round=open??{...await createWaitingRound(client,options,thread,{subjectRef:`order:${record.order_id}`,entryIntent:"SERVICE",actorType:"admin",actorId:context.userId,requestId}),assignedAdminId:null};
    await recordAudit(client,{actorType:"admin",actorId:context.userId,sessionId:context.sessionId,action:"im.aftersale.contact.prepared",objectType:"im_aftersale_record",objectId:recordId,outcome:"SUCCESS",requestId,details:{threadId:thread.id,consultationId:round.id,created:!open}});
    return {id:round.id,state:round.state,assignedAdminId:round.assignedAdminId,opened:!open,threadId:thread.id,scopeReady:thread.messageScopeState==="READY",scopeId:thread.messageScopeId};
  });
  if(result.opened)await afterRoundOpened(options,{roundId:result.id,threadId:result.threadId,threadScopeReady:result.scopeReady,threadMessageScopeId:result.scopeId,created:true,entryIntent:"SERVICE"});
  return {id:result.id,state:result.state,assignedAdminId:result.assignedAdminId};
}

export async function listAdminConsultations(
  options: ConsultationRouteOptions,
  context: AdminContext,
  _access: EffectiveAdminAccess,
  limit: number,
): Promise<{ consultations: ConsultationView[] }> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    const accountId = await readyAccount(client, identityKey(options.appId, "admin", "ADMIN", context.userId));
    const serviceQueue = hasPermission(access, ADMIN_PERMISSION.imSupportAccept);
    const adminThreadRead = Boolean(access?.isBoss || hasPermission(access, ADMIN_PERMISSION.imSupportManagementRead));
    // 旧 COMPLAINT 行按普通会话进入同一队列；不再按 kind 或 im.support.complaint 分流。
    // 用户还没说话的 WAITING 空会话不进队列；每个线程只保留一行：优先有用户消息的开放轮，
    // 其次本人处理过的最近已结束轮，保证轮次结束后仍能从同一会话打开历史。
    const rows = (await client.query<ConsultationRow>(
      `${CONSULTATION_SELECT}
        WHERE c."app_id" = $1
          AND c."id" = (
            SELECT c2."id" FROM "zzsh_iam"."im_consultation" c2
             WHERE c2."app_id" = c."app_id" AND c2."thread_id" = c."thread_id"
               AND (c2."assigned_admin_id" = $2
                 OR (c2."assigned_admin_id" IS NULL AND $3::boolean AND c2."state" = 'WAITING'))
               AND (c2."state" <> 'CLOSED' OR NOT EXISTS (
                 SELECT 1 FROM "zzsh_iam"."im_consultation" open_round
                  WHERE open_round."app_id" = c2."app_id" AND open_round."thread_id" = c2."thread_id"
                    AND open_round."state" <> 'CLOSED'))
             ORDER BY (c2."state" <> 'CLOSED' AND c2."first_user_message_at" IS NOT NULL) DESC,
                      (c2."assigned_admin_id" = $2 AND c2."state" = 'CLOSED') DESC,
                      c2."created_at" DESC, c2."id" DESC
             LIMIT 1
          )
          AND (c."assigned_admin_id" = $2
            OR (c."assigned_admin_id" IS NULL AND $3::boolean AND c."state" = 'WAITING'))
          AND NOT (c."state" = 'WAITING' AND c."assigned_admin_id" IS NULL AND c."first_user_message_at" IS NULL)
        ORDER BY CASE WHEN c."assigned_admin_id" = $2 THEN 0 ELSE 1 END, c."updated_at", c."id"
        LIMIT $4`,
      [options.appId, context.userId, serviceQueue, limit],
    )).rows;
    return { consultations: rows.map((row) => ({ ...toView(row, accountId, true, context.userId, adminThreadRead), botAccountId: supportBotAccountId(options) })) };
  });
}

export async function readOwnPresence(options: ConsultationRouteOptions, context: AdminContext): Promise<SupportPresence> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const row = (await client.query<PresenceRow>(
      `SELECT "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
              "last_connected_at" AS "lastConnectedAt", "active_load" AS "activeLoad", "version"
         FROM "zzsh_iam"."im_support_presence" WHERE "app_id" = $1 AND "admin_user_id" = $2`,
      [options.appId, context.userId],
    )).rows[0];
    const today = await readSupportToday(client, options.appId, context.userId);
    return row ? { ...presenceView(row), today } : { ...defaultPresence(context.userId), today };
  });
}

function defaultPresence(adminUserId: string): Omit<SupportPresence, "today"> {
  return { adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", lastConnectedAt: null, activeLoad: 0, version: 0 };
}

function presenceView(row: PresenceRow): Omit<SupportPresence, "today"> {
  return {
    adminUserId: row.adminUserId,
    availability: row.availability,
    connectionState: row.connectionState,
    lastConnectedAt: iso(row.lastConnectedAt),
    activeLoad: row.activeLoad,
    version: numberValue(row.version),
  };
}

/** 开区间只在 AVAILABLE + CONNECTED 成立；所有其他组合都结束区间。 */
export function presenceSessionAction(
  availability: SupportAvailability,
  connectionState: SupportConnectionState,
): "OPEN" | "CLOSE" {
  return availability === "AVAILABLE" && connectionState === "CONNECTED" ? "OPEN" : "CLOSE";
}

export function presenceSessionEndReason(
  availability: SupportAvailability,
  connectionState: SupportConnectionState,
): "PAUSED" | "OFF_DUTY" | "DISCONNECTED" | null {
  if (availability === "PAUSED") return "PAUSED";
  if (availability === "OFF_DUTY") return "OFF_DUTY";
  if (connectionState !== "CONNECTED") return "DISCONNECTED";
  // AVAILABLE + CONNECTED is the open interval, not an end reason.
  return null;
}

export const PRESENCE_SESSION_OPEN_SQL = `INSERT INTO "zzsh_iam"."im_support_presence_session"
  ("id", "app_id", "admin_user_id")
  VALUES ($1, $2, $3)
  ON CONFLICT ("app_id", "admin_user_id") WHERE "ended_at" IS NULL DO NOTHING`;

export const PRESENCE_SESSION_CLOSE_SQL = `UPDATE "zzsh_iam"."im_support_presence_session"
  SET "ended_at" = clock_timestamp(), "end_reason" = $3
  WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "ended_at" IS NULL`;

async function syncPresenceSession(client: PoolClient, appId: string, adminUserId: string, row: PresenceRow): Promise<void> {
  if (presenceSessionAction(row.availability, row.connectionState) === "OPEN") {
    await client.query(PRESENCE_SESSION_OPEN_SQL, [`im_presence_${randomUUID().replaceAll("-", "")}`, appId, adminUserId]);
    return;
  }
  const reason = presenceSessionEndReason(row.availability, row.connectionState);
  if (!reason) return;
  await client.query(PRESENCE_SESSION_CLOSE_SQL, [appId, adminUserId, reason]);
}

/** 心跳只在本人当前 AVAILABLE + CONNECTED 且存在未结束区间时生效；不推进 presence 版本。 */
export async function heartbeatOwnPresence(
  options: ConsultationRouteOptions,
  context: AdminContext,
): Promise<{ ok: boolean; serverTime: string }> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const row = (await client.query<{ presence: boolean; session: boolean; serverTime: string }>(
      `WITH p AS (
         UPDATE "zzsh_iam"."im_support_presence"
            SET "last_connected_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "admin_user_id" = $2
            AND "availability" = 'AVAILABLE' AND "connection_state" = 'CONNECTED'
          RETURNING "admin_user_id"
       ), s AS (
         UPDATE "zzsh_iam"."im_support_presence_session"
            SET "last_heartbeat_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "ended_at" IS NULL
            AND EXISTS (SELECT 1 FROM p)
          RETURNING "id"
       )
       SELECT EXISTS (SELECT 1 FROM p) AS "presence",
              EXISTS (SELECT 1 FROM s) AS "session",
              to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "serverTime"`,
      [options.appId, context.userId],
    )).rows[0];
    return {
      ok: row?.presence === true && row?.session === true,
      serverTime: row?.serverTime ?? new Date().toISOString(),
    };
  });
}

export async function updateOwnPresence(
  options: ConsultationRouteOptions,
  context: AdminContext,
  input: { availability: SupportAvailability; connectionState: SupportConnectionState; version?: number },
  requestId: string,
): Promise<SupportPresence> {
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportPresence)) {
      throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    }
    const current = (await client.query<PresenceRow>(
      `SELECT "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
              "last_connected_at" AS "lastConnectedAt", "active_load" AS "activeLoad", "version"
         FROM "zzsh_iam"."im_support_presence"
        WHERE "app_id" = $1 AND "admin_user_id" = $2`,
      [options.appId, context.userId],
    )).rows[0];
    const currentVersion = current ? numberValue(current.version) : 0;
    if (current && (input.version === undefined || input.version !== currentVersion)) {
      throw conflict("Presence version is stale");
    }
    if (!current && input.version !== undefined && input.version !== 0) {
      throw conflict("Presence version is stale");
    }
    await options.testPresenceBarrier?.(context);
    let persisted: PresenceRow | undefined;
    if (!current) {
      const inserted = await client.query<PresenceRow>(
        `INSERT INTO "zzsh_iam"."im_support_presence"
          ("app_id", "admin_user_id", "availability", "connection_state", "last_connected_at")
         VALUES ($1,$2,$3,$4,CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE NULL END)
         ON CONFLICT ("app_id", "admin_user_id") DO NOTHING
         RETURNING "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
                   "last_connected_at" AS "lastConnectedAt", "active_load" AS "activeLoad", "version"`,
        [options.appId, context.userId, input.availability, input.connectionState],
      );
      persisted = inserted.rows[0];
    } else {
      const updated = await client.query<PresenceRow>(
        `UPDATE "zzsh_iam"."im_support_presence"
            SET "availability" = $3,
                "connection_state" = $4,
                "last_connected_at" = CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE NULL END,
                "version" = "version" + 1,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "version" = $5
          RETURNING "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
                    "last_connected_at" AS "lastConnectedAt", "active_load" AS "activeLoad", "version"`,
        [options.appId, context.userId, input.availability, input.connectionState, currentVersion],
      );
      persisted = updated.rows[0];
    }
    if (!persisted) throw conflict("Presence version is stale");
    await syncPresenceSession(client, options.appId, context.userId, persisted);
    const today = await readSupportToday(client, options.appId, context.userId);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.presence.updated",
      objectType: "im_support_presence",
      objectId: context.userId,
      outcome: "SUCCESS",
      requestId,
      details: { availability: input.availability, connectionState: input.connectionState, appId: options.appId },
    });
    return { ...presenceView(persisted), today };
  });
  if (result.availability === "AVAILABLE" && result.connectionState === "CONNECTED") {
    options.wakeDispatch?.();
    if (options.autoAssignConsultations) void autoAssignWaitingConsultations(options, 5).catch(() => undefined);
  }
  return result;
}

type ClaimPlan =
  | { kind: "OPERATION"; operationId: string; reservedNew: boolean }
  | { kind: "ALREADY_ASSIGNED"; roundId: string }
  | { kind: "NEEDS_TEAM"; threadId: string };

/**
 * Round operations that still own the reception intent. A new ADD_MEMBER must
 * never be stacked on any of them: the owner recovers the same operation or
 * waits for it to settle. FAILED stays in the set because its only safe retry
 * is the explicit recovery path, which resets this row instead of inserting one.
 */
const UNRESOLVED_SCOPE_OPERATION_STATES = "('PENDING','RUNNING','UNKNOWN','NEEDS_REVIEW','FAILED')";

/**
 * Claim reserves the agent and records an ADD_MEMBER operation. The round stays
 * WAITING and no one is "responsible" until the thread Team membership is
 * confirmed remotely; a second admin cannot slip in because the active
 * operation and the row lock serialise the intent.
 */
async function beginClaimMembership(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, requestId: string, aftersaleId?:string): Promise<ClaimPlan> {
  const plan = await withTransaction(options.pool, async (client) => {
    const locked = await lockSupportMutation(client, options.appId, [], [context.userId]);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const currentAccess = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(currentAccess, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId);
    requireSupportAccess(currentAccess, row.kind);
    if(aftersaleId){
      const record=(await client.query<{requester_user_id:string;handler_admin_id:string|null}>(`SELECT requester_user_id,handler_admin_id FROM zzsh_iam.im_aftersale_record WHERE app_id=$1 AND id=$2 AND state='PENDING' FOR UPDATE`,[options.appId,aftersaleId])).rows[0];
      if(!record||row.kind!=="SERVICE"||record.requester_user_id!==row.userId||record.handler_admin_id!==context.userId)throw new SecurityApiError(403,"FORBIDDEN","Aftersale contact is not assigned to this agent");
    }
    if (row.state === "ACTIVE" && row.assignedAdminId === context.userId) return { kind: "ALREADY_ASSIGNED" as const, roundId: row.id };
    if (row.state !== "WAITING" || row.assignedAdminId) throw conflict("Consultation is already assigned");
    if (!row.threadId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "consultation has no support thread", true);
    if (!options.provider) throw unavailable("IM message scope provider is not configured");
    const thread = await readThreadById(client, options.appId, row.threadId, true);
    if (thread.messageScopeState !== "READY" || !thread.messageScopeId
      || row.messageScopeState !== "READY" || row.messageScopeId !== thread.messageScopeId) {
      return { kind: "NEEDS_TEAM" as const, threadId: thread.id };
    }
    const unresolved = (await client.query<{
      id: string;
      operationType: MessageScopeOperationType;
      state: MessageScopeOperationState;
      targetAdminId: string | null;
    }>(
      `SELECT "id", "operation_type" AS "operationType", "state", "target_admin_id" AS "targetAdminId"
         FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 AND "state" IN ${UNRESOLVED_SCOPE_OPERATION_STATES}
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT 1 FOR UPDATE`,
      [options.appId, row.id],
    )).rows[0];
    if (unresolved && ["PENDING", "RUNNING", "UNKNOWN"].includes(unresolved.state)) {
      throw unavailable("IM 接待操作正在恢复，请稍后重试");
    }
    if (unresolved && unresolved.operationType !== "ADD_MEMBER") {
      throw unavailable("IM message scope operation requires recovery before claim");
    }
    // 本轮接入已由同一客服的对账操作占用：只能恢复那一条，绝不插第二条 ADD_MEMBER。
    if (unresolved && unresolved.targetAdminId !== context.userId) {
      throw conflict("本轮接入待对账，请先恢复原接入");
    }
    const eligible = await readEligibleSupport(client, options.appId, locked);
    const priority = await assignWaitingOrders(client, options.appId, eligible);
    if (priority.more) return null;
    await readConsultation(client, options.appId, consultationId, true);
    if (unresolved) {
      // The unresolved operation already reserved this round: eligibility is checked
      // read-only so the same agent never adds a second active_load for one round.
      const target = eligible.find((candidate) => candidate.adminUserId === context.userId);
      if (!target) throw unavailable("当前客服不可接待新咨询");
      const resumed = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "state" = 'PENDING', "attempt_count" = 0, "next_retry_at" = clock_timestamp(),
                "lease_until" = NULL, "lease_token_hash" = NULL, "last_failure_class" = NULL,
                "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" IN ('NEEDS_REVIEW', 'FAILED')`,
        [options.appId, unresolved.id],
      );
      if (resumed.rowCount !== 1) throw unavailable("IM 接待操作正在恢复，请稍后重试");
      await recordAudit(client, {
        actorType: "admin",
        actorId: context.userId,
        sessionId: context.sessionId,
        action: "im.consultation.claim.retried",
        objectType: "im_consultation_scope_operation",
        objectId: unresolved.id,
        outcome: "SUCCESS",
        requestId,
        details: { consultationId: row.id, threadId: thread.id, targetAdminId: context.userId },
      });
      return { kind: "OPERATION" as const, operationId: unresolved.id, reservedNew: false };
    }
    const reservation = await reserveSupportCandidateOutcome(client, options.appId, row.kind, eligible, context.userId, options.supportConcurrency);
    if (!reservation.candidate) {
      throw Object.assign(unavailable(reservation.reason === "ALL_AT_CAPACITY"
        ? "当前客服已满接待上限，请先处理现有会话"
        : "当前客服不可接待新咨询"),reservation.reason==="ALL_AT_CAPACITY"?{reason:"SUPPORT_AT_CAPACITY"}:{});
    }
    const candidate = reservation.candidate;
    const operationId = scopeOperationId();
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
        ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id",
         "target_admin_id", "target_admin_account_id", "provider_team_id")
       VALUES ($1,$2,$3,'ADD_MEMBER',$4,$5,$6,$7,$8,$9)`,
      [operationId, options.appId, row.id, row.messageScopeVersion, supportManagerAccount(options).accountId,
        row.userAccountId, candidate.adminUserId, candidate.accountId, thread.messageScopeId],
    );
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.consultation.claim.requested",
      objectType: "im_consultation",
      objectId: row.id,
      outcome: "SUCCESS",
      requestId,
      details: { threadId: thread.id, roundSeq: row.roundSeq },
    });
    return { kind: "OPERATION" as const, operationId, reservedNew: true };
  });
  if (!plan) throw unavailable("已付款订单正在优先分配，请稍后重试");
  return plan;
}

/** 分配成功返回轮次 id；没有候选时带回线程 Team 与原因，交由调用方发一次区分文案的兜底。 */
type AutoAssignOutcome = string | { noCandidateTeamId: string; reason: SupportQueueReason };
type AutoAssignPlan = { operationId: string; candidate: Candidate; teamId: string } | { noCandidateTeamId: string; reason: SupportQueueReason };

async function autoAssignOne(options: ConsultationRouteOptions, consultationId: string): Promise<AutoAssignOutcome | null> {
  const plan = await withTransaction<AutoAssignPlan | null>(options.pool, async (client) => {
    const locked = await lockSupportMutation(client, options.appId);
    const row = await readConsultation(client, options.appId, consultationId);
    if (row.state !== "WAITING" || row.assignedAdminId || !row.threadId) return null;
    const thread = await readThreadById(client, options.appId, row.threadId, true);
    if (thread.messageScopeState !== "READY" || !thread.messageScopeId
      || row.messageScopeState !== "READY" || row.messageScopeId !== thread.messageScopeId) return null;
    const active = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 AND "state" IN ${UNRESOLVED_SCOPE_OPERATION_STATES}
        LIMIT 1 FOR UPDATE`,
      [options.appId, row.id],
    )).rows[0];
    if (active) return null;
    // 已付款订单优先：同一批在线客服还有待派订单时不先占咨询。
    const priority = await assignWaitingOrders(client, options.appId, await readEligibleSupport(client, options.appId, locked));
    if (priority.more) return null;
    const reservation = await reserveEligibleAdmin(client, options.appId, locked, row.kind, undefined, options.supportConcurrency);
    // 没有候选是业务事实（无人接待或在线全满），不是一次失败：发一次区分文案的兜底，
    // 客服上线/空位释放后的 presence/tick 仍会再次尝试分配。
    if (!reservation.candidate) {
      return { noCandidateTeamId: thread.messageScopeId, reason: reservation.reason ?? "NO_ONLINE_STAFF" };
    }
    const candidate = reservation.candidate;
    const operationId = scopeOperationId();
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
        ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id",
         "target_admin_id", "target_admin_account_id", "provider_team_id")
       VALUES ($1,$2,$3,'ADD_MEMBER',$4,$5,$6,$7,$8,$9)`,
      [operationId, options.appId, row.id, row.messageScopeVersion, supportManagerAccount(options).accountId,
        row.userAccountId, candidate.adminUserId, candidate.accountId, thread.messageScopeId],
    );
    await recordAudit(client, {
      actorType: "system",
      actorId: supportManagerAccount(options).accountId,
      action: "im.consultation.auto_assign.requested",
      objectType: "im_consultation",
      objectId: row.id,
      outcome: "SUCCESS",
      requestId: operationId,
      details: { threadId: thread.id, roundSeq: row.roundSeq, assignedAdminId: candidate.adminUserId, auto: true },
    });
    return { operationId, candidate, teamId: thread.messageScopeId };
  });
  if (!plan) return null;
  if ("noCandidateTeamId" in plan) return plan;
  try {
    await runScopeOperationNow(options, plan.operationId);
  } catch {
    await releaseFailedClaim(options, consultationId, plan.candidate.adminUserId);
    return null;
  }
  const round = await withTransaction(options.pool, (client) => readConsultation(client, options.appId, consultationId));
  if (round.state !== "ACTIVE" || round.assignedAdminId !== plan.candidate.adminUserId) {
    await releaseFailedClaim(options, consultationId, plan.candidate.adminUserId);
    return null;
  }
  await sendSupportText(options, plan.teamId, plan.candidate.accountId, supportGreetingText(plan.candidate.adminName),
    `support_greeting_${round.id}_${plan.candidate.adminUserId}`);
  return round.id;
}

/** Assigns waiting rounds to eligible online agents; called on presence changes and after a user message. */
export async function autoAssignWaitingConsultations(options: ConsultationRouteOptions, limit = 5): Promise<string[]> {
  if (!options.autoAssignConsultations || !options.provider || !options.supportManager) return [];
  const rows = (await options.pool.query<{ id: string }>(
    `SELECT c."id"
       FROM "zzsh_iam"."im_consultation" c
       JOIN "zzsh_iam"."im_support_thread" t ON t."id" = c."thread_id"
      WHERE c."app_id" = $1 AND c."state" = 'WAITING' AND c."assigned_admin_id" IS NULL
        AND c."first_user_message_at" IS NOT NULL
        AND t."message_scope_state" = 'READY' AND t."message_scope_id" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "zzsh_iam"."im_consultation_scope_operation" o
                         WHERE o."app_id" = c."app_id" AND o."consultation_id" = c."id"
                           AND o."state" IN ${UNRESOLVED_SCOPE_OPERATION_STATES})
      ORDER BY c."created_at", c."id" LIMIT $2`,
    [options.appId, Math.max(1, Math.min(limit, 20))],
  )).rows;
  const assigned: string[] = [];
  for (const row of rows) {
    const outcome = await autoAssignOne(options, row.id).catch(() => null);
    if (!outcome) continue;
    if (typeof outcome === "string") {
      assigned.push(outcome);
      continue;
    }
    await notifyQueueFallback(options, row.id, outcome.noCandidateTeamId, outcome.reason).catch(() => undefined);
  }
  return assigned;
}

type TransferPlan =
  | { operationId: string; teamId: string | null; targetAdminId: string }
  | { alreadyAssigned: true };
type TransferKind = "TRANSFER" | "TAKEOVER";

export function takeoverDecision(
  row: { state: ConsultationState; assignedAdminId: string | null },
  actorId: string,
): "NOOP" | "TRANSFER" {
  if (row.state !== "ACTIVE") throw conflict("Consultation is not active");
  return row.assignedAdminId === actorId ? "NOOP" : "TRANSFER";
}

async function beginTransfer(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  targetAdminId: string,
  requestId: string,
  note: string | null,
  kind: TransferKind,
): Promise<TransferPlan | null> {
  const manager = supportManagerAccount(options);
  if (!options.provider) throw unavailable("IM message scope provider is not configured");
  const result = await withTransaction(options.pool, async (client) => {
    const locked = await lockSupportMutation(client, options.appId, [], [context.userId, targetAdminId]);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const currentAccess = await loadEffectiveAdminAccess(client, context.userId);
    if (kind === "TAKEOVER") {
      requireSupportManagementRead(currentAccess);
      if (!hasPermission(currentAccess, ADMIN_PERMISSION.imSupportAuditTakeover)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    } else if (!hasPermission(currentAccess, ADMIN_PERMISSION.imSupportRead)) {
      throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    }
    if (!ID_PATTERN.test(targetAdminId)) throw invalid("Target administrator is invalid");
    const row = await readConsultation(client, options.appId, consultationId);
    if (kind === "TAKEOVER") {
      if (takeoverDecision(row, context.userId) === "NOOP") return { alreadyAssigned: true } as const;
    } else {
      requireSupportAccess(currentAccess, row.kind, "transfer");
      if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
      if (targetAdminId === context.userId) throw invalid("Target administrator must be different");
    }
    if (!row.assignedAdminId) throw conflict("Consultation is not assigned");
    if (row.messageScopeState !== "READY" || !row.messageScopeId || !row.peerAccountId) throw unavailable("IM message scope is not ready for transfer");
    const priority = await assignWaitingOrders(client, options.appId, await readEligibleSupport(client, options.appId, locked));
    if (priority.more) return null;
    await readConsultation(client, options.appId, consultationId, true);
    const activeOperation = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 AND "state" IN ('PENDING', 'RUNNING', 'UNKNOWN')
        LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (activeOperation) throw unavailable("IM message scope operation is being recovered");
    const targetAccess = await loadEffectiveAdminAccess(client, targetAdminId);
    if (!hasPermission(targetAccess, ADMIN_PERMISSION.imSupportAccept)) throw new SecurityApiError(403, "FORBIDDEN", "Target administrator is not authorized");
    // 转交与接管都会增加目标客服的个人负载，使用相同接待上限。
    const reservation = await reserveEligibleAdmin(client, options.appId, locked, row.kind, targetAdminId, options.supportConcurrency);
    if (!reservation.candidate) {
      throw Object.assign(unavailable(reservation.reason === "ALL_AT_CAPACITY" ? "目标客服已满接待上限" : "目标客服当前不可接待"),
        reservation.reason === "ALL_AT_CAPACITY" ? { reason: "SUPPORT_AT_CAPACITY" } : {});
    }
    const target = reservation.candidate;
    const updated = await client.query<{ messageScopeVersion: string | number }>(
      `UPDATE "zzsh_iam"."im_consultation"
        SET "message_scope_state" = 'TRANSFERRING', "message_scope_version" = "message_scope_version" + 1,
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "message_scope_state" = 'READY'
        RETURNING "message_scope_version" AS "messageScopeVersion"`,
      [options.appId, row.id],
    );
    if (updated.rowCount !== 1 || !updated.rows[0]) throw conflict("Consultation changed during transfer");
    const operationId = scopeOperationId();
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
        ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id",
         "previous_admin_id", "target_admin_id", "previous_admin_account_id", "target_admin_account_id", "provider_team_id")
       VALUES ($1,$2,$3,'TRANSFER',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [operationId, options.appId, row.id, updated.rows[0].messageScopeVersion, manager.accountId, row.userAccountId,
        row.assignedAdminId, target.adminUserId, row.peerAccountId, target.accountId, row.messageScopeId],
    );
    // 交接记录在转交发起并完成全部本地校验后写入；远端恢复失败不会抹掉这次请求。
    await recordSupportHandover(client, {
      appId: options.appId,
      objectType: "CONSULTATION",
      objectId: row.id,
      fromAdminId: row.assignedAdminId,
      toAdminId: target.adminUserId,
      note,
    });
    return { operationId, teamId: row.messageScopeId, targetAdminId: target.adminUserId };
  });
  if (!result) throw unavailable("已付款订单正在优先分配，请稍后重试");
  return result;
}

/** 用户可见的转接提示：只使用客服显示名，不暴露后台账号或流程术语。 */
export function transferNoticeText(adminName: string): string {
  const name = [...adminName.replace(/\s+/g, " ").trim()].slice(0, 40).join("");
  return name ? `已为您转接客服 ${name}，请继续沟通。` : "已为您转接客服，请继续沟通。";
}

/** 转接成功后由平台助手告知新客服；发送失败只丢这条自动消息，不影响转接结果。 */
async function notifyTransferReceived(
  options: ConsultationRouteOptions,
  input: { operationId: string; teamId: string | null; adminName: string },
): Promise<void> {
  try {
    // messageClientId 绑定本次转交操作：同一操作被重试或对账时不会产生第二条提示。
    await sendSupportText(options, input.teamId, supportManagerAccount(options).accountId,
      transferNoticeText(input.adminName), `support_transfer_${input.operationId}`);
  } catch {
    // 自动提示是尽力而为，转交事实已提交。
  }
}

async function transferWithScope(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  targetAdminId: string,
  requestId: string,
  note: string | null,
): Promise<{ consultation: ConsultationView }> {
  const plan = await beginTransfer(options, context, consultationId, targetAdminId, requestId, note, "TRANSFER");
  if (!plan) throw unavailable("已付款订单正在优先分配，请稍后重试");
  if ("alreadyAssigned" in plan) return readAdminConsultationView(options, context, consultationId);
  const transfer = plan;
  await runScopeOperationNow(options, transfer.operationId);
  const result = await readAdminConsultationView(options, context, consultationId);
  // 只有主动转交才广播新客服；巡视接管复用同一种 scope 操作，不能按操作类型区分。
  // 以服务端返回的负责人为准，避免远端未完成时提前告知用户。
  const assigned = result.consultation.assignedAdmin;
  if (result.consultation.state === "ACTIVE" && assigned?.id === transfer.targetAdminId) {
    await notifyTransferReceived(options, { operationId: transfer.operationId, teamId: transfer.teamId, adminName: assigned.name });
  }
  // 已提交的转交不被后台派发阻塞：容量唤醒失败只影响后续分配时机。
  void wakeAutoAssign(options);
  return result;
}

/**
 * Read-only candidate projection for the transfer dialog. Reuses the same
 * eligibility rules as the transfer itself; it never reserves, updates presence
 * or writes an operation.
 */
export async function listTransferTargets(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
): Promise<{ targets: { adminUserId: string; displayName: string }[]; transferReady: boolean }> {
  return withTransaction(options.pool, async (client) => {
    const locked = await lockSupportMutation(client, options.appId, [], [context.userId]);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId);
    requireSupportAccess(access, row.kind, "transfer");
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) {
      throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    }
    if (row.messageScopeState !== "READY" || !row.messageScopeId) return { targets: [], transferReady: false };
    const candidates = await readEligibleSupport(client, options.appId, locked);
    const targets = candidates
      .filter((candidate) => candidate.adminUserId !== context.userId)
      .map((candidate) => ({ adminUserId: candidate.adminUserId, displayName: candidate.adminName }));
    return { targets, transferReady: true };
  });
}

type ClosePlan = { operationId: string };

async function beginClose(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, requestId: string): Promise<ClosePlan | null> {
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId, true);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    requireSupportAccess(access, row.kind);
    if (!row.threadId) throw conflict("Consultation has no support thread");
    const latestOperation = (await client.query<{ id: string; operationType: MessageScopeOperationType; state: MessageScopeOperationState }>(
      `SELECT "id", "operation_type" AS "operationType", "state" FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (latestOperation && ["PENDING", "RUNNING", "UNKNOWN"].includes(latestOperation.state)) throw unavailable("IM message scope operation is being recovered");
    if (!row.messageScopeId) {
      if (latestOperation && latestOperation.state !== "SUCCEEDED") throw unavailable("IM message scope requires recovery before close");
      if (!["PENDING", "FAILED", "REVOKED"].includes(row.messageScopeState)) throw unavailable("IM message scope requires recovery before close");
      return null;
    }
    if (!options.provider) throw unavailable("IM message scope provider is not configured");
    if (latestOperation?.operationType === "ROUND_CLOSE" && (latestOperation.state === "FAILED" || latestOperation.state === "NEEDS_REVIEW")) {
      throw unavailable("IM 本轮结束结果待对账，请使用恢复入口重试");
    }
    if (row.messageScopeState !== "READY" && row.messageScopeState !== "FAILED") throw unavailable("IM message scope is not ready to close");
    const thread = await readThreadById(client, options.appId, row.threadId, true);
    if (thread.messageScopeState !== "READY" || thread.messageScopeId !== row.messageScopeId) throw unavailable("IM support thread Team is inconsistent");
    if (!row.assignedAdminId || !row.peerAccountId) throw conflict("Consultation assignment is inconsistent");
    const manager = supportManagerAccount(options);
    const updated = await client.query<{ messageScopeVersion: string | number }>(
      `UPDATE "zzsh_iam"."im_consultation"
        SET "message_scope_state" = 'REVOKING', "message_scope_version" = "message_scope_version" + 1,
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "message_scope_state" IN ('READY', 'FAILED')
        RETURNING "message_scope_version" AS "messageScopeVersion"`,
      [options.appId, row.id],
    );
    if (updated.rowCount !== 1 || !updated.rows[0]) throw conflict("Consultation changed during close");
    const operationId = scopeOperationId();
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
        ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id",
         "previous_admin_id", "previous_admin_account_id", "provider_team_id")
       VALUES ($1,$2,$3,'ROUND_CLOSE',$4,$5,$6,$7,$8,$9)`,
      [operationId, options.appId, row.id, updated.rows[0].messageScopeVersion, manager.accountId, row.userAccountId,
        row.assignedAdminId, row.peerAccountId, row.messageScopeId],
    );
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.consultation.round_close.requested",
      objectType: "im_consultation",
      objectId: row.id,
      outcome: "SUCCESS",
      requestId,
      details: { threadId: thread.id, roundSeq: row.roundSeq, teamRetained: true },
    });
    return { operationId };
  });
}

async function completeLocalClose(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, requestId: string): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [context.userId]);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const row = await readConsultation(client, options.appId, consultationId, true);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    requireSupportAccess(access, row.kind);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) throw conflict("Consultation changed during close");
    if (row.messageScopeId) throw conflict("IM message scope requires remote close");
    // No Team ever existed: close the business object without claiming remote revocation.
    await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "state" = 'CLOSED',
              "version" = "version" + 1, "message_scope_version" = "message_scope_version" + 1,
              "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "assigned_admin_id" = $3`,
      [options.appId, consultationId, context.userId],
    );
    await decrementPresence(client, options.appId, context.userId);
    await client.query(
      `UPDATE "zzsh_iam"."im_support_thread"
          SET "state" = 'IDLE', "peer_account_id" = NULL, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2`,
      [options.appId, row.threadId ?? ""],
    );
    await writeEvent(client, { consultationId, eventType: "CLOSED", actorType: "admin", actorId: context.userId, fromAdminId: context.userId, peerAccountId: row.peerAccountId });
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "im.consultation.closed", objectType: "im_consultation", objectId: consultationId, outcome: "SUCCESS", requestId });
  });
}

export async function claimConsultation(options: ConsultationRouteOptions, context: AdminContext, id: string, requestId: string, aftersaleId?:string): Promise<{ consultation: ConsultationView }> {
  // Auto-assignment is the primary path. Manual claim is a management fallback;
  // enforce it server-side so hiding the button is not the only control.
  const access = await withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    return loadEffectiveAdminAccess(client, context.userId);
  });
  if (!aftersaleId && !(access?.isBoss || hasPermission(access, ADMIN_PERMISSION.imSupportAuditTakeover))) {
    throw new SecurityApiError(403, "FORBIDDEN", "Manual takeover requires a management grant");
  }
  let plan = await beginClaimMembership(options, context, id, requestId, aftersaleId);
  if (plan.kind === "NEEDS_TEAM") {
    // First use after close/reopen may still need the thread Team; create it before adding the agent.
    await ensureThreadTeam(options, plan.threadId, id);
    plan = await beginClaimMembership(options, context, id, requestId, aftersaleId);
  }
  const claimedNow = plan.kind === "OPERATION";
  const reservedNew = plan.kind === "OPERATION" && plan.reservedNew;
  if (plan.kind === "OPERATION") {
    try {
      await runScopeOperationNow(options, plan.operationId);
    } catch (error) {
      // 新 claim 已 reserve 但没变成 ACTIVE：只中和本次预留，不掩盖原始错误。
      if (reservedNew) await releaseFailedClaim(options, id, context.userId);
      throw error;
    }
  } else if (plan.kind === "NEEDS_TEAM") throw unavailable("IM support thread Team is being recovered");
  const result = await readAdminConsultationView(options, context, id);
  if (claimedNow && !reservedNew && result.consultation.state === "ACTIVE" && result.consultation.assignedAdmin?.id === context.userId) {
    // The settled operation released its reservation; recovery must put the active load back exactly once.
    await restoreClaimLoad(options, id, context.userId);
  }
  if (reservedNew && (result.consultation.state !== "ACTIVE" || result.consultation.assignedAdmin?.id !== context.userId)) {
    // 操作被并发认领或没有写回时 runScopeOperationNow 不抛错，这里补上中和。
    await releaseFailedClaim(options, id, context.userId);
  } else if (claimedNow && result.consultation.state === "ACTIVE" && result.consultation.assignedAdmin?.id === context.userId) {
    const thread = await withTransaction(options.pool, (client) => readThreadById(client, options.appId, result.consultation.threadId, false));
    await sendSupportText(options, thread?.messageScopeId, deriveYunxinAccountId(identityKey(options.appId, "admin", "ADMIN", context.userId)),
      supportGreetingText(result.consultation.assignedAdmin.name), `support_greeting_${result.consultation.id}_${context.userId}`);
  }
  return result;
}

export function transferConsultation(options: ConsultationRouteOptions, context: AdminContext, id: string, targetAdminId: string, requestId: string, note: string | null = null): Promise<{ consultation: ConsultationView }> {
  return transferWithScope(options, context, id, targetAdminId, requestId, note);
}

/** 巡视接管：把当前 ACTIVE 咨询责任转给当前运营；已归属本人时幂等返回，不重复写事件。 */
export async function takeoverConsultation(
  options: ConsultationRouteOptions,
  context: AdminContext,
  id: string,
  requestId: string,
  note: string | null,
): Promise<{ consultation: ConsultationView }> {
  const plan = await beginTransfer(options, context, id, context.userId, requestId, note, "TAKEOVER");
  if (!plan) throw unavailable("已付款订单正在优先分配，请稍后重试");
  if ("alreadyAssigned" in plan) return readAdminConsultationView(options, context, id);
  await runScopeOperationNow(options, plan.operationId);
  const result = await readAdminConsultationView(options, context, id);
  void wakeAutoAssign(options);
  return result;
}

export async function closeConsultation(options: ConsultationRouteOptions, context: AdminContext, id: string, requestId: string): Promise<{ consultation: ConsultationView }> {
  const plan = await beginClose(options, context, id, requestId);
  if (plan) {
    await runScopeOperationNow(options, plan.operationId);
  } else {
    await completeLocalClose(options, context, id, requestId);
  }
  const result = await readAdminConsultationView(options, context, id);
  void wakeAutoAssign(options);
  return result;
}

/**
 * CS-03: an unresolved ADD_MEMBER is recovered through the claim flow. Only the
 * agent the round was reserved for may reset that single operation; every other
 * state falls through to the generic scope-operation retry unchanged.
 */
async function retryOwnClaimOperation(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  requestId: string,
): Promise<string | null> {
  if (!options.provider) return null;
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) return null;
    const row = await readConsultation(client, options.appId, consultationId, true);
    // Only a waiting, unassigned round can still be owned by an ADD_MEMBER; every
    // other retry path keeps its existing close/transfer recovery semantics.
    if (row.state !== "WAITING" || row.assignedAdminId !== null || !row.messageScopeId) return null;
    const operation = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (!operation) return null;
    const detail = await readScopeOperation(client, options.appId, operation.id, true);
    if (detail.operationType !== "ADD_MEMBER" || detail.targetAdminId !== context.userId) return null;
    if (detail.state !== "FAILED" && detail.state !== "NEEDS_REVIEW") return null;
    requireSupportAccess(access, row.kind);
    if (row.messageScopeState !== "READY" || row.messageScopeId !== detail.providerTeamId) {
      throw conflict("IM claim scope changed during recovery");
    }
    const locked = await lockSupportMutation(client, options.appId, [], [context.userId]);
    // 同一目标已由原操作预留过一次：恢复只做只读资格校验，不 reserve、不再推进分配时间。
    const target = (await readEligibleSupport(client, options.appId, locked)).find((candidate) => candidate.adminUserId === context.userId);
    if (!target) throw unavailable("当前客服不可接待新咨询");
    const resumed = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'PENDING', "attempt_count" = 0, "next_retry_at" = clock_timestamp(),
              "lease_until" = NULL, "lease_token_hash" = NULL, "last_failure_class" = NULL,
              "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" IN ('NEEDS_REVIEW', 'FAILED')`,
      [options.appId, detail.id],
    );
    if (resumed.rowCount !== 1) throw unavailable("IM 接待操作正在恢复，请稍后重试");
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.scope.recovery.retried",
      objectType: "im_consultation_scope_operation",
      objectId: detail.id,
      outcome: "SUCCESS",
      requestId,
      details: { operationType: detail.operationType, resumedClaim: true },
    });
    return detail.id;
  });
}

export async function retryMessageScopeOperation(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  requestId: string,
): Promise<{ consultation: ConsultationView }> {
  // ADD_MEMBER 对账恢复必须先于关单对账：等待中轮次没有负责人，关单路径会直接拒绝。
  const claimRecoveryId = await retryOwnClaimOperation(options, context, consultationId, requestId);
  if (claimRecoveryId) {
    await runScopeOperationNow(options, claimRecoveryId);
    await restoreClaimLoad(options, consultationId, context.userId);
    return readAdminConsultationView(options, context, consultationId);
  }
  const closeReconciliationClaim = await claimCloseReconciliation(options, context, consultationId, requestId);
  if (closeReconciliationClaim === "SUCCEEDED") return readAdminConsultationView(options, context, consultationId);
  if (closeReconciliationClaim) {
    const result = await executeScopeOperation(options, closeReconciliationClaim, "CLOSE_ABSENCE");
    if (result !== "SUCCEEDED") throw unavailable("IM close remains blocked until the remote team state is confirmed");
    return readAdminConsultationView(options, context, consultationId);
  }
  const operationId = await withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportTransfer)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId, true);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    const operation = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (!operation) throw new SecurityApiError(404, "NOT_FOUND", "IM scope operation not found");
    const detail = await readScopeOperation(client, options.appId, operation.id, true);
    if (detail.state === "SUCCEEDED") return detail.id;
    if (detail.state !== "FAILED" && detail.state !== "NEEDS_REVIEW") throw unavailable("IM message scope operation is still running");
    if (remoteActionMayStillBeInFlight(detail.lastFailureClass)) {
      throw unavailable("IM 远端结果未知或尚未完成对账，暂不能直接重试");
    }
    if (detail.operationType === "ADD_MEMBER") throw unavailable("请重新接入本轮接待");
    const nextScopeState = detail.operationType === "CREATE" ? "PROVISIONING"
      : detail.operationType === "TRANSFER" ? "TRANSFERRING" : "REVOKING";
    if (detail.operationType === "CREATE") {
      if (row.messageScopeId && detail.providerTeamId && row.messageScopeId !== detail.providerTeamId) throw conflict("IM scope team changed during recovery");
      if (detail.targetAdminAccountId !== null) {
        if (!row.peerAccountId || row.peerAccountId !== detail.targetAdminAccountId) throw conflict("IM scope assignment changed during recovery");
      }
    } else if (detail.operationType === "TRANSFER") {
      if (row.messageScopeId !== detail.providerTeamId || row.assignedAdminId !== detail.previousAdminId || row.peerAccountId !== detail.previousAdminAccountId) throw conflict("IM transfer assignment changed during recovery");
    } else if (detail.operationType === "ROUND_CLOSE") {
      if (row.messageScopeId !== detail.providerTeamId || row.assignedAdminId !== detail.previousAdminId || row.peerAccountId !== detail.previousAdminAccountId) throw conflict("IM round close assignment changed during recovery");
    } else if (row.messageScopeId !== detail.providerTeamId) {
      throw conflict("IM close team changed during recovery");
    }
    await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "message_scope_state" = $3, "message_scope_version" = "message_scope_version" + 1,
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE'`,
      [options.appId, consultationId, nextScopeState],
    );
    await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'PENDING', "attempt_count" = 0, "next_retry_at" = clock_timestamp(),
              "lease_until" = NULL, "lease_token_hash" = NULL, "last_failure_class" = NULL,
              "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" IN ('FAILED', 'NEEDS_REVIEW')`,
      [options.appId, detail.id],
    );
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.scope.recovery.retried",
      objectType: "im_consultation_scope_operation",
      objectId: detail.id,
      outcome: "SUCCESS",
      requestId,
      details: { operationType: detail.operationType },
    });
    return detail.id;
  });
  await runScopeOperationNow(options, operationId);
  return readAdminConsultationView(options, context, consultationId);
}


/* ===================== right-hand context read projections =====================
 * Read-only. Reuses the exact object-authorization predicate of listAdminConsultations
 * so a caller cannot reach an event row the queue would not have shown them.
 */

const EVENT_PAGE_DEFAULT = 20;
const EVENT_PAGE_MAX = 50;

export function parseEventLimit(value: string | null): number {
  if (value === null) return EVENT_PAGE_DEFAULT;
  if (!/^[1-9]\d?$/.test(value)) throw invalid("Limit is invalid");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > EVENT_PAGE_MAX) throw invalid("Limit is invalid");
  return parsed;
}

/** Cursor is bound to the consultation so it cannot be replayed against another object. */
export function encodeEventCursor(consultationId: string, createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([consultationId, createdAt, id])).toString("base64url");
}

export function decodeEventCursor(consultationId: string, value: string): { createdAt: string; id: string } {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid("Cursor is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid("Cursor is invalid");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || typeof parsed[2] !== "string") {
    throw invalid("Cursor is invalid");
  }
  if (parsed[0] !== consultationId) throw invalid("Cursor is invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/.test(parsed[1]) || !ID_PATTERN.test(parsed[2])) throw invalid("Cursor is invalid");
  const date = new Date(`${parsed[1].slice(0, 19)}.000Z`);
  if (parsed[1].startsWith("0000") || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== parsed[1].slice(0, 19)
    || encodeEventCursor(consultationId, parsed[1], parsed[2]) !== value) throw invalid("Cursor is invalid");
  return { createdAt: parsed[1], id: parsed[2] };
}

/**
 * Same predicate as listAdminConsultations: own assignment, or unassigned rows this
 * admin may claim. CLOSED stays out of scope this round.
 */
async function readAuthorizedAdminConsultation(
  client: PoolClient,
  context: AdminContext,
  appId: string,
  consultationId: string,
): Promise<ConsultationRow> {
  const access = await loadEffectiveAdminAccess(client, context.userId);
  if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
  const serviceQueue = hasPermission(access, ADMIN_PERMISSION.imSupportAccept);
  const result = await client.query<ConsultationRow>(
    `${CONSULTATION_SELECT}
      WHERE c."app_id" = $1 AND c."id" = $2 AND c."state" <> 'CLOSED' AND (
        c."assigned_admin_id" = $3
        OR (c."assigned_admin_id" IS NULL AND $4::boolean)
      )`,
    [appId, consultationId, context.userId, serviceQueue],
  );
  const row = result.rows[0];
  // Identical rejection for "does not exist", "other app", "closed" and "not yours":
  // the projection must not confirm the existence of an object the caller cannot read.
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
  return row;
}

const EVENT_TYPES = new Set(["CREATED", "ASSIGNED", "CLAIMED", "TRANSFERRED", "CLOSED", "REOPENED"]);

export type ConsultationEventView = {
  id: string;
  type: string;
  occurredAt: string;
  actor: { kind: string; displayName: string };
  from: { displayName: string } | null;
  to: { displayName: string } | null;
};

export type ConsultationEventPage = { events: ConsultationEventView[]; nextCursor: string | null };

const ADMIN_USER_RELATION = `"zzsh_auth_admin"."user"`;
const AUTH_USER_RELATION = `"zzsh_auth_user"."user"`;

async function displayNames(client: PoolClient, relation: string, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!ids.length) return names;
  const rows = (await client.query<{ id: string; name: string | null; username: string | null }>(
    `SELECT "id", "name", "username" FROM ${relation} WHERE "id" = ANY($1::text[])`,
    [ids],
  )).rows;
  for (const row of rows) names.set(row.id, row.name?.trim() || row.username?.trim() || "");
  return names;
}

export async function listConsultationEvents(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  limitValue: string | null,
  cursorValue: string | null,
): Promise<ConsultationEventPage> {
  const limit = parseEventLimit(limitValue);
  if (!ID_PATTERN.test(consultationId)) throw invalid("Consultation identifier is invalid");
  const cursor = cursorValue === null ? null : decodeEventCursor(consultationId, cursorValue);
  return withTransaction(options.pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    await readAuthorizedAdminConsultation(client, context, options.appId, consultationId);
    // Newest page first, then flipped for display: the first screen must not be the oldest 20.
    const rows = (await client.query<{
      id: string; type: string; actorType: string; actorId: string | null; fromAdminId: string | null; toAdminId: string | null;
      createdAt: string;
    }>(
      `SELECT "id", "event_type" AS "type", "actor_type" AS "actorType", "actor_id" AS "actorId",
              "from_admin_id" AS "fromAdminId", "to_admin_id" AS "toAdminId",
              to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
         FROM "zzsh_iam"."im_consultation_event"
        WHERE "consultation_id" = $1
          AND ($2::text IS NULL OR ("created_at", "id") < ($3::timestamptz, $2::text))
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT $4`,
      [consultationId, cursor?.id ?? null, cursor?.createdAt ?? null, limit + 1],
    )).rows;
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
    const adminIds = [...new Set([
      ...page.filter((row) => row.actorType === "admin").map((row) => row.actorId).filter((id): id is string => Boolean(id)),
      ...page.map((row) => row.fromAdminId).filter((id): id is string => Boolean(id)),
      ...page.map((row) => row.toAdminId).filter((id): id is string => Boolean(id)),
    ])];
    const userIds = [...new Set(page.filter((row) => row.actorType === "user").map((row) => row.actorId).filter((id): id is string => Boolean(id)))];
    // Batched: one lookup per identity table for the whole page, never per event row.
    const adminNames = await displayNames(client, ADMIN_USER_RELATION, adminIds);
    const userNames = await displayNames(client, AUTH_USER_RELATION, userIds);
    const nameFor = (kind: string, id: string | null) => (id ? (kind === "admin" ? adminNames.get(id) : userNames.get(id)) : null) || (kind === "admin" ? "客服" : "平台用户");
    return {
      events: page.map((row) => ({
        id: row.id,
        // An unrecognised type must degrade neutrally rather than fail the whole panel.
        type: EVENT_TYPES.has(row.type) ? row.type : "UNKNOWN",
        occurredAt: row.createdAt,
        actor: row.actorType === "system"
          ? { kind: "system", displayName: "系统" }
          : { kind: row.actorType, displayName: nameFor(row.actorType, row.actorId) },
        from: row.fromAdminId ? { displayName: adminNames.get(row.fromAdminId) || "客服" } : null,
        to: row.toAdminId ? { displayName: adminNames.get(row.toAdminId) || "客服" } : null,
      })),
      nextCursor: hasMore && page[0] ? encodeEventCursor(consultationId, page[0].createdAt, page[0].id) : null,
    };
  });
}

export type ConsultationSectionStatus = "available" | "absent" | "forbidden" | "unavailable" | "unresolved";

export type ConsultationSubjectKind = "ORDER" | "ACCOUNT";

/**
 * 咨询关联对象：客服必须能直接看出“关于哪一单”，但仍不允许从裸引用猜类型。
 * displayNo 是业务展示号（订单 DD… / 资源账号 AC…）；内部主键只放 target.id 供跳转，不上屏。
 */
export type ConsultationSubjectView =
  | { status: "absent" }
  | { status: "unresolved"; rawRef: string }
  | {
    status: "resolved";
    kind: ConsultationSubjectKind;
    displayNo: string;
    title: string | null;
    target: { kind: ConsultationSubjectKind; id: string };
    party?: "RENTER" | "OWNER";
    origin?: "LEGACY";
  };

export type ConsultationContextView = {
  consultationId: string;
  version: number;
  service: { type: string; state: string; messageScopeState: string | null; handler: { id: string; displayName: string } | null };
  user: { status: ConsultationSectionStatus; publicId?: string; displayName?: string; avatar: string | null };
  subject: ConsultationSubjectView;
  membership: { status: ConsultationSectionStatus; reason?: string };
};

/** subject_ref 的显式前缀；无前缀时只在唯一命中时解析，不猜类型。 */
const SUBJECT_PREFIXES: Record<string, ConsultationSubjectKind> = {
  order: "ORDER", account: "ACCOUNT", listing: "ACCOUNT", product: "ACCOUNT",
};

function splitSubjectRef(value: string): { ref: string; kind: ConsultationSubjectKind | null } {
  const index = value.indexOf(":");
  if (index <= 0) return { ref: value, kind: null };
  const kind = SUBJECT_PREFIXES[value.slice(0, index).toLowerCase()];
  return kind && value.length > index + 1 ? { ref: value.slice(index + 1), kind } : { ref: value, kind: null };
}

/** Legacy IDs are a separate source type; only the consultation user's own order is projected. */
async function resolveLegacyConsultationOrder(client: PoolClient, id: string, userId: string): Promise<Extract<ConsultationSubjectView, { status: "resolved" }> | null> {
  if (!/^legacy_order_[a-f0-9]{40}$/.test(id)) return null;
  const row = (await client.query<{ id: string; displayNo: string | null; party: "RENTER" | "OWNER" }>(
    `SELECT l.id, l.original_order_no AS "displayNo",
       CASE WHEN l.renter_user_id=$2 THEN 'RENTER' WHEN l.owner_user_id=$2 THEN 'OWNER' END AS party
       FROM zzsh_order.legacy_order_read_snapshot l
      WHERE l.id=$1 AND COALESCE(l.source_snapshot->>'is_delete','0')='0'
        AND (l.renter_user_id=$2 OR l.owner_user_id=$2)`, [id, userId],
  )).rows[0];
  if (!row || row.id !== id || !row.displayNo || !["RENTER", "OWNER"].includes(row.party)) return null;
  return { status: "resolved", kind: "ORDER", origin: "LEGACY", displayNo: row.displayNo, title: null,
    target: { kind: "ORDER", id: row.id }, party: row.party };
}

/**
 * 把 subject_ref 解析成客服能用的业务单号；解析不了就 unresolved。
 * 只在唯一命中时 resolved（订单 id/display_no、资源账号 id/display_no、listing_version id）；
 * 同时命中多行（如订单与账号撞号）视为无法确定，绝不猜成订单；拿不到业务展示号也不 resolved。
 */
async function resolveConsultationSubject(
  client: PoolClient,
  subjectRef: string | null,
  userId: string,
  readPublicAccount: ConsultationRouteOptions["readPublicAccount"],
): Promise<ConsultationSubjectView> {
  if (!subjectRef) return { status: "absent" };
  if (subjectRef.startsWith("legacy-order:")) {
    return await resolveLegacyConsultationOrder(client, subjectRef.slice("legacy-order:".length), userId)
      ?? { status: "unresolved", rawRef: subjectRef };
  }
  const { ref, kind } = splitSubjectRef(subjectRef);
  if (!ref) return { status: "unresolved", rawRef: subjectRef };
  const rows = (await client.query<{
    kind: ConsultationSubjectKind; id: string; displayNo: string | null; title: string | null; related: boolean; versionId: string | null; party: "RENTER" | "OWNER" | null;
  }>(
    `SELECT 'ORDER'::text AS "kind", o."id", o."display_no" AS "displayNo", o."title",
            (o."renter_user_id"=$3 OR o."owner_user_id"=$3) AS "related", NULL::text AS "versionId",
            CASE WHEN o."renter_user_id"=$3 THEN 'RENTER' WHEN o."owner_user_id"=$3 THEN 'OWNER' END AS "party"
       FROM "zzsh_order"."rental_order" o
      WHERE ($2::text IS NULL OR $2::text = 'ORDER') AND (o."id" = $1 OR o."display_no" = $1)
     UNION ALL
      SELECT 'ACCOUNT'::text, a."id", a."display_no", NULL,
             (a."owner_user_id"=$3 OR EXISTS(SELECT 1 FROM zzsh_order.rental_order own_order WHERE own_order.account_id=a.id AND (own_order.renter_user_id=$3 OR own_order.owner_user_id=$3))),NULL::text,NULL::text
       FROM "zzsh_supply"."rental_account" a
      WHERE ($2::text IS NULL OR $2::text = 'ACCOUNT') AND (a."id" = $1 OR a."display_no" = $1)
     UNION ALL
      SELECT 'ACCOUNT'::text, a."id", a."display_no", NULL,
             (a."owner_user_id"=$3 OR EXISTS(SELECT 1 FROM zzsh_order.rental_order own_order WHERE own_order.account_id=a.id AND (own_order.renter_user_id=$3 OR own_order.owner_user_id=$3))),l.id,NULL::text
       FROM "zzsh_supply"."listing_version" l
       JOIN "zzsh_supply"."rental_account" a ON a."id" = l."account_id"
      WHERE ($2::text IS NULL OR $2::text = 'ACCOUNT') AND l."id" = $1`,
    [ref, kind, userId],
  )).rows;
  const unique = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row]));
  if (unique.size !== 1) return { status: "unresolved", rawRef: subjectRef };
  const resolved = [...unique.values()][0]!;
  if (!resolved.displayNo) return { status: "unresolved", rawRef: subjectRef };
  if (!resolved.related) {
    if (resolved.kind !== "ACCOUNT" || !readPublicAccount) return { status: "unresolved", rawRef: subjectRef };
    try {
      const publicAccount = await readPublicAccount(client, resolved.id);
      if (resolved.versionId && publicAccount.versionId !== resolved.versionId) return { status: "unresolved", rawRef: subjectRef };
    } catch (error) {
      if (error instanceof SecurityApiError && error.status === 404) return { status: "unresolved", rawRef: subjectRef };
      throw error;
    }
  }
  return {
    status: "resolved",
    kind: resolved.kind,
    displayNo: resolved.displayNo!,
    title: resolved.title,
    target: { kind: resolved.kind, id: resolved.id },
    ...(resolved.kind === "ORDER" && resolved.related && resolved.party ? { party: resolved.party } : {}),
  };
}

export async function readConsultationContext(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
): Promise<ConsultationContextView> {
  if (!ID_PATTERN.test(consultationId)) throw invalid("Consultation identifier is invalid");
  return withTransaction(options.pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    const row = await readAuthorizedAdminConsultation(client, context, options.appId, consultationId);
    const subjectRef = row.subjectRef;
    const avatar = managedProfileImagePath(row.userImage);
    return {
      consultationId: row.id,
      version: numberValue(row.version),
      service: {
        type: row.kind,
        state: row.state,
        messageScopeState: row.messageScopeState ?? null,
        handler: row.assignedAdminId ? { id: row.assignedAdminId, displayName: row.adminName?.trim() || "客服" } : null,
      },
      // Only what the consultation projection already authorises: stable subject id + name.
      user: {
        status: "available",
        publicId: row.userId,
        displayName: row.userName?.trim() || row.userUsername?.trim() || "平台用户",
        avatar,
      },
      // subject_ref 本身没有类型列：先按显式前缀/唯一命中解析成业务单号，解析不了就是 unresolved，
      // 绝不把裸引用猜成订单；业务展示号缺失时同样不上屏。
      subject: await resolveConsultationSubject(client, subjectRef, row.userId, options.readPublicAccount),
      // This tree carries no membership read dependency; absence is not "ordinary member".
      membership: { status: "unavailable", reason: "membership_projection_not_integrated" },
    };
  });
}

/** A text card is only a reference; authorize both the consultation and its user's legacy order. */
export async function readConsultationLegacyOrderReference(options: ConsultationRouteOptions, context: AdminContext,
  consultationId: string, legacyOrderId: string): Promise<{ contractVersion: "im-legacy-order-reference.v1"; subject: Extract<ConsultationSubjectView, { status: "resolved" }> }> {
  if (!ID_PATTERN.test(consultationId) || !/^legacy_order_[a-f0-9]{40}$/.test(legacyOrderId)) throw new SecurityApiError(404, "NOT_FOUND", "Order not found");
  return withTransaction(options.pool, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    const consultation = await readAuthorizedAdminConsultation(client, context, options.appId, consultationId);
    const subject = await resolveLegacyConsultationOrder(client, legacyOrderId, consultation.userId);
    if (!subject) throw new SecurityApiError(404, "NOT_FOUND", "Order not found");
    return { contractVersion: "im-legacy-order-reference.v1", subject };
  });
}
