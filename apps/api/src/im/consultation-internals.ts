/**
 * 咨询域共享基座：公开类型、行模型、SQL 投影、校验/格式化 helper 与事务内读写。
 * 下层模块只依赖本文件，本文件不依赖任何咨询业务块，避免拆分后的模块循环。
 */

import {
  ADMIN_PERMISSION,
  hasPermission,
  type EffectiveAdminAccess,
} from "../auth/admin-authorization";
import type { AdminContext } from "../auth/auth-security";
import { SecurityApiError } from "../auth/security-core";
import { managedProfileImagePath } from "../profile/profile-avatar";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  type ImIdentityProvisioner,
  type ImIdentityKey,
} from "./identity-lifecycle";
import type { ImMessageTransport } from "./im-contract";
import {
  SUPPORT_FIRST_RESPONSE_ACTION,
  type SupportDayCounts,
} from "./support-management";
import type { YunxinSupportScopeApi } from "./yunxin-provider";
import { randomUUID } from "node:crypto";
import type {
  Pool,
  PoolClient,
} from "pg";

export type SupportType = "SERVICE" | "COMPLAINT";

/** 用户进入咨询页的入口场景；决定欢迎语，并对应 SERVICE/COMPLAINT 两类持久线程。 */
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

export type SupportPresenceReason =
  | "NOT_OWNER"
  | "TAKEN_OVER"
  | "LOCKED"
  | "ENDED"
  | "SESSION_INVALID"
  | "FORBIDDEN"
  | "GRACE"
  | "PAUSED_DISPATCH"
  | "CONNECTION_TERMINAL"
  | "RECONNECTING"
  | "STALE_STATE"
  | "STALE_CONNECTION"
  | "OTHER_WINDOW";

export type SupportPresence = {
  adminUserId: string;
  availability: SupportAvailability;
  connectionState: SupportConnectionState;
  lastConnectedAt: string | null;
  lastConfirmedAt: string | null;
  disconnectedSince: string | null;
  dispatchPaused: boolean;
  dispatchable: boolean;
  reason: SupportPresenceReason | null;
  stateRevision: number;
  activeLoad: number;
  version: number;
  /** Another browser session currently owns this admin's single presence row. */
  ownedByAnotherSession: boolean;
  /** Pre-0184 row with no auth session owner; requires an explicit start to bind. */
  unbound: boolean;
  today: SupportDayCounts;
};

export type SupportPresenceHeartbeat = {
  ok: boolean;
  dispatchable: boolean;
  reason: SupportPresenceReason | null;
  disconnectedSince: string | null;
  dispatchPaused: boolean;
  stateRevision: number;
  today?: SupportDayCounts;
  serverTime: string;
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

export type ScopeOperationRow = {
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

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$/;

export const SUPPORT_TYPES = new Set<SupportType>(["SERVICE", "COMPLAINT"]);

export const AVAILABILITY = new Set<SupportAvailability>(["OFF_DUTY", "AVAILABLE", "PAUSED"]);

export const CONNECTION_STATES = new Set<SupportConnectionState>([
  "DISCONNECTED",
  "CONNECTING",
  "CONNECTED",
  "RECONNECTING",
  "KICKED",
  "AUTH_FAILED",
]);

export type ConsultationRow = {
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

export type ThreadRow = {
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

export type PresenceRow = {
  adminUserId: string;
  availability: SupportAvailability;
  connectionState: SupportConnectionState;
  lastConnectedAt: Date | string | null;
  lastConfirmedAt: Date | string | null;
  disconnectedSince: Date | string | null;
  dispatchPaused: boolean;
  stateRevision: string | number;
  connectionId: string | null;
  connectionExpiresAt: Date | string | null;
  activeLoad: number;
  version: string | number;
  authSessionId: string | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalid(message = "Request validation failed"): SecurityApiError {
  return new SecurityApiError(400, "INVALID_ARGUMENT", message);
}

export function conflict(message: string): SecurityApiError {
  return new SecurityApiError(409, "CONFLICT", message);
}

/** A browser tab is an owner only after it has claimed this exact connection. */
export function ownsPresenceConnection(
  row: Pick<PresenceRow, "authSessionId" | "connectionId"> | undefined,
  sessionId: string,
  connectionId: string,
): boolean {
  return Boolean(row && row.authSessionId === sessionId && row.connectionId === connectionId);
}

export function unavailable(message = "IM service is temporarily unavailable"): SecurityApiError {
  return new SecurityApiError(503, "IM_UNAVAILABLE", message);
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

export function numberValue(value: string | number): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("IM numeric value is invalid");
  return result;
}

export const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

export function teamConversationId(accountId: string, teamId: string): string {
  if (!ACCOUNT_PATTERN.test(accountId) || !/^[0-9]{1,19}$/.test(teamId)) throw new Error("IM team conversation identity is invalid");
  return `${accountId}|2|${teamId}`;
}

export function identityKey(appId: string, realm: "user" | "admin", kind: "USER" | "ADMIN", subjectId: string): ImIdentityKey {
  return { provider: "yunxin", appId, realm, kind, platformSubjectId: subjectId };
}

export async function readyAccount(client: PoolClient, key: ImIdentityKey): Promise<string> {
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

export const CONSULTATION_SELECT = `
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
export const USER_THREAD_SELECT = `
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

export async function readConsultation(client: PoolClient, appId: string, id: string, lock = false): Promise<ConsultationRow> {
  const result = await client.query<ConsultationRow>(`${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND c."id" = $2${lock ? " FOR UPDATE OF c" : ""}`, [appId, id]);
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
  return row;
}

export function threadStateForRound(row: ConsultationRow): SupportThreadState {
  if (row.threadState) return row.threadState;
  return row.state === "ACTIVE" ? "ACTIVE" : row.state === "WAITING" ? "WAITING" : "IDLE";
}

/** Thread scope falls back to the round scope only for controlled fixtures without thread columns. */
export function threadScopeForRow(row: ConsultationRow): { scopeId: string | null; scopeState: MessageScopeState } {
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

export async function writeEvent(
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

export const THREAD_SELECT = `
  SELECT "id", "app_id" AS "appId", "user_id" AS "userId", "kind", "state",
         "user_account_id" AS "userAccountId", "peer_account_id" AS "peerAccountId",
         "message_scope_id" AS "messageScopeId", "message_scope_state" AS "messageScopeState",
         "last_round_seq" AS "lastRoundSeq", "version"
    FROM "zzsh_iam"."im_support_thread"`;

export async function readThread(client: PoolClient, appId: string, userId: string, kind: SupportType, lock = false): Promise<ThreadRow | null> {
  const row = (await client.query<ThreadRow>(
    `${THREAD_SELECT} WHERE "app_id" = $1 AND "user_id" = $2 AND "kind" = $3${lock ? " FOR UPDATE" : ""}`,
    [appId, userId, kind],
  )).rows[0];
  return row ?? null;
}

export async function readThreadById(client: PoolClient, appId: string, threadId: string, lock = false): Promise<ThreadRow> {
  const row = (await client.query<ThreadRow>(
    `${THREAD_SELECT} WHERE "app_id" = $1 AND "id" = $2${lock ? " FOR UPDATE" : ""}`,
    [appId, threadId],
  )).rows[0];
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "Support thread not found");
  return row;
}

/** One persistent thread per app+user+kind; the unique index makes concurrent first use converge. */
export async function ensureThread(client: PoolClient, appId: string, userId: string, kind: SupportType, userAccountId: string): Promise<ThreadRow> {
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

export type WaitingRound = { id: string; state: ConsultationState; created: boolean; threadScopeReady: boolean };

export function requireSupportAccess(
  access: EffectiveAdminAccess | null,
  type: SupportType,
  action: "accept" | "transfer" = "accept",
  objectGrant = false,
): void {
  const required: string[] = action === "transfer"
    ? [ADMIN_PERMISSION.imSupportAccept, ADMIN_PERMISSION.imSupportTransfer]
    : [ADMIN_PERMISSION.imSupportAccept];
  if (type === "COMPLAINT" && !objectGrant) required.push(ADMIN_PERMISSION.imSupportComplaint);
  if (!required.every((permission) => hasPermission(access, permission))) {
    throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
  }
}

export const complaintObjectGrantSql = (consultationColumn: string, adminParameter: string) => `EXISTS (
  SELECT 1 FROM "zzsh_iam"."im_complaint_handover_grant" h
   WHERE h."consultation_id" = ${consultationColumn} AND h."admin_user_id" = ${adminParameter}
     AND NOT EXISTS (SELECT 1 FROM "zzsh_iam"."admin_user_permission" d
       WHERE d."admin_user_id" = ${adminParameter} AND d."permission_code" = 'im.support.complaint' AND d."effect" = 'DENY'))`;

export async function complaintHandoverGranted(client: PoolClient, consultationId: string, adminUserId: string): Promise<boolean> {
  return ((await client.query(
    `SELECT 1 WHERE ${complaintObjectGrantSql("$1", "$2")}`,
    [consultationId, adminUserId],
  )).rowCount ?? 0) === 1;
}

/** Object-level exception only for the exact pre-upgrade complaint assigned to this admin. */
export async function requireSupportAccessFor(
  client: PoolClient,
  access: EffectiveAdminAccess | null,
  adminUserId: string,
  row: { id: string; kind: SupportType; assignedAdminId: string | null },
  action: "accept" | "transfer" = "accept",
): Promise<void> {
  const objectGrant = row.kind === "COMPLAINT"
    && row.assignedAdminId === adminUserId
    && !hasPermission(access, ADMIN_PERMISSION.imSupportComplaint)
    && await complaintHandoverGranted(client, row.id, adminUserId);
  requireSupportAccess(access, row.kind, action, objectGrant);
}

export async function decrementPresence(client: PoolClient, appId: string, adminUserId: string | null): Promise<void> {
  if (!adminUserId) return;
  await client.query(
    `UPDATE "zzsh_iam"."im_support_presence"
        SET "active_load" = GREATEST("active_load" - 1, 0), "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "admin_user_id" = $2`,
    [appId, adminUserId],
  );
}

export function teamIdFromConversationId(accountId: string, conversationId: string): string {
  const prefix = `${accountId}|2|`;
  const teamId = conversationId.startsWith(prefix) ? conversationId.slice(prefix.length) : "";
  if (!/^\d{1,19}$/.test(teamId) || teamConversationId(accountId, teamId) !== conversationId) {
    throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
  }
  return teamId;
}

/** 双端 account 都符合 ACCOUNT_PATTERN；订单群也会命中形状，由线程 join 自然 no-op。 */
export const TEAM_CONVERSATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}\|2\|([0-9]{1,19})$/;

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
export async function recordSupportFirstResponse(
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
