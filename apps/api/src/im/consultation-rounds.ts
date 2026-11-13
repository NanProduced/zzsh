/**
 * 咨询轮次：自动分配等待轮次、事件游标、事件/轮次台账读取与分配基础设施。
 */

import {
  ADMIN_PERMISSION,
  hasPermission,
  loadEffectiveAdminAccess,
} from "../auth/admin-authorization";
import {
  assertAdminContextInTransaction,
  type AdminContext,
} from "../auth/auth-security";
import {
  recordAudit,
  SecurityApiError,
  setAuditContext,
  withTransaction,
} from "../auth/security-core";
import { managedProfileImagePath } from "../profile/profile-avatar";
import { assignWaitingOrders } from "./order-dispatch";
import {
  lockSupportMutation,
  readEligibleSupport,
  reserveSupportCandidateOutcome,
  type LockedSupportRoster,
  type SupportQueueReason,
} from "./support-dispatch";
import { auditViewerAccount } from "./support-management";
import type { PoolClient } from "pg";
import {
  CONSULTATION_SELECT,
  type ConsultationRouteOptions,
  type ConsultationRow,
  type ConsultationState,
  ID_PATTERN,
  type MessageScopeOperationState,
  type MessageScopeOperationType,
  type MessageScopeState,
  type SupportType,
  complaintObjectGrantSql,
  conflict,
  decrementPresence,
  invalid,
  readConsultation,
  readThreadById,
  recordSupportThreadMessage,
  requireSupportAccessFor,
  unavailable,
} from "./consultation-internals";
import {
  ScopeOperationFailure,
  runScopeOperationNow,
  scopeOperationId,
  supportManagerAccount,
} from "./consultation-scope-recovery";

/** CS-04: reuse the capacity a successful close/transfer freed; a wake failure never changes the business result. */
export async function wakeAutoAssign(options: ConsultationRouteOptions, limit = 5): Promise<void> {
  if (!options.autoAssignConsultations) return;
  await autoAssignWaitingConsultations(options, limit).catch(() => undefined);
}

export type Candidate = {
  adminUserId: string;
  adminName: string;
  accountId: string;
};

export async function reserveEligibleAdmin(client: PoolClient, appId: string, locked: LockedSupportRoster, type: SupportType,
  targetAdminId?: string, concurrencyLimit?: number, enforceCapacity = true,
  mode: "DISPATCHABLE" | "STRICT" = "DISPATCHABLE", sessionId?: string, connectionId?: string): Promise<{ candidate: Candidate | null; reason: SupportQueueReason | null }> {
  const outcome = await reserveSupportCandidateOutcome(
    client, appId, type, await readEligibleSupport(client, appId, locked, mode, sessionId, connectionId),
    targetAdminId, concurrencyLimit, enforceCapacity, mode, sessionId, connectionId,
  );
  return { candidate: outcome.candidate, reason: outcome.reason };
}

/** 本轮确定没有可用客服时平台账号的兜底；每轮最多一次，由 no_support_notice_at 保证。 */
export const NO_SUPPORT_NOTICE_TEXT = "抱歉，当前暂无在线客服，请先留言，客服上线后我们会第一时间联系您！";

/** 满载排队：客服在线但都满了，不能让用户以为没人值班；不暴露任何具体客服信息。 */
export const SUPPORT_BUSY_NOTICE_TEXT = "客服当前都在忙，已为您排队，请先留言，空出来会第一时间为您处理～";

export const supportGreetingText = (name: string) => `您好，我是本次为您服务的客服${name}，已收到您的留言，马上为您处理。`;

/** Server-side bot/agent text. Local-fake uses the in-memory transport; real NIM uses the provider seam. */
export async function sendSupportText(
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
export async function notifyQueueFallback(
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

/**
 * A reserved claim that never became ACTIVE gives its load back exactly once.
 * settleScopeOperationFailure already releases the reservation it recorded, so a
 * settled (NEEDS_REVIEW/UNKNOWN) operation is not decremented again; only silent
 * failures (claim lost, no writeback) reach decrementPresence here.
 */
export async function releaseFailedClaim(options: ConsultationRouteOptions, consultationId: string, adminUserId: string): Promise<void> {
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
export async function restoreClaimLoad(options: ConsultationRouteOptions, consultationId: string, adminUserId: string): Promise<void> {
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

export type ClaimPlan =
  | { kind: "OPERATION"; operationId: string; reservedNew: boolean }
  | { kind: "ALREADY_ASSIGNED"; roundId: string }
  | { kind: "NEEDS_TEAM"; threadId: string };

/**
 * Round operations that still own the reception intent. A new ADD_MEMBER must
 * never be stacked on any of them: the owner recovers the same operation or
 * waits for it to settle. FAILED stays in the set because its only safe retry
 * is the explicit recovery path, which resets this row instead of inserting one.
 */
export const UNRESOLVED_SCOPE_OPERATION_STATES = "('PENDING','RUNNING','UNKNOWN','NEEDS_REVIEW','FAILED')";

/**
 * Claim reserves the agent and records an ADD_MEMBER operation. The round stays
 * WAITING and no one is "responsible" until the thread Team membership is
 * confirmed remotely; a second admin cannot slip in because the active
 * operation and the row lock serialise the intent.
 */
export async function beginClaimMembership(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, requestId: string, aftersaleId?:string, connectionId?: string): Promise<ClaimPlan> {
  const plan = await withTransaction(options.pool, async (client) => {
    const locked = await lockSupportMutation(client, options.appId, [], [context.userId]);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const currentAccess = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(currentAccess, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId);
    await requireSupportAccessFor(client, currentAccess, context.userId, row);
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
    // Claiming is an explicit action: a 2-minute reconnect grace is suitable for
    // automatic dispatch, not for proving that this agent can actually see the chat.
    const strictEligible = await readEligibleSupport(client, options.appId, locked, "STRICT", context.sessionId, connectionId);
    await readConsultation(client, options.appId, consultationId, true);
    if (unresolved) {
      // The unresolved operation already reserved this round: eligibility is checked
      // read-only so the same agent never adds a second active_load for one round.
      const target = strictEligible.find((candidate) => candidate.adminUserId === context.userId);
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
    const reservation = await reserveSupportCandidateOutcome(client, options.appId, row.kind, strictEligible, context.userId, options.supportConcurrency, false, "STRICT", context.sessionId, connectionId);
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
export type AutoAssignOutcome = string | { noCandidateTeamId: string; reason: SupportQueueReason };

export type AutoAssignPlan = { operationId: string; candidate: Candidate; teamId: string } | { noCandidateTeamId: string; reason: SupportQueueReason };

export async function autoAssignOne(options: ConsultationRouteOptions, consultationId: string): Promise<AutoAssignOutcome | null> {
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

/* ===================== right-hand context read projections =====================
 * Read-only. Reuses the exact object-authorization predicate of listAdminConsultations
 * so a caller cannot reach an event row the queue would not have shown them.
 */

export const EVENT_PAGE_DEFAULT = 20;

export const EVENT_PAGE_MAX = 50;

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
export async function readAuthorizedAdminConsultation(
  client: PoolClient,
  context: AdminContext,
  appId: string,
  consultationId: string,
): Promise<ConsultationRow> {
  const access = await loadEffectiveAdminAccess(client, context.userId);
  if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
  const serviceQueue = hasPermission(access, ADMIN_PERMISSION.imSupportAccept);
  const canComplaint = hasPermission(access, ADMIN_PERMISSION.imSupportComplaint);
  const result = await client.query<ConsultationRow>(
    `${CONSULTATION_SELECT}
      WHERE c."app_id" = $1 AND c."id" = $2 AND c."state" <> 'CLOSED'
        AND (c."kind" <> 'COMPLAINT' OR $5::boolean OR ${complaintObjectGrantSql('c."id"', "$3")})
        AND (
          c."assigned_admin_id" = $3
          OR (c."assigned_admin_id" IS NULL AND $4::boolean)
        )`,
    [appId, consultationId, context.userId, serviceQueue, canComplaint],
  );
  const row = result.rows[0];
  // Identical rejection for "does not exist", "other app", "closed" and "not yours":
  // the projection must not confirm the existence of an object the caller cannot read.
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
  return row;
}

export const EVENT_TYPES = new Set(["CREATED", "ASSIGNED", "CLAIMED", "TRANSFERRED", "CLOSED", "REOPENED"]);

export type ConsultationEventView = {
  id: string;
  type: string;
  occurredAt: string;
  actor: { kind: string; displayName: string };
  from: { displayName: string } | null;
  to: { displayName: string } | null;
};

export type ConsultationEventPage = { events: ConsultationEventView[]; nextCursor: string | null };

export const ADMIN_USER_RELATION = `"zzsh_auth_admin"."user"`;

export const AUTH_USER_RELATION = `"zzsh_auth_user"."user"`;

export async function displayNames(client: PoolClient, relation: string, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!ids.length) return names;
  const rows = (await client.query<{ id: string; name: string | null; username: string | null }>(
    `SELECT "id", "name", "username" FROM ${relation} WHERE "id" = ANY($1::text[])`,
    [ids],
  )).rows;
  for (const row of rows) names.set(row.id, row.name?.trim() || row.username?.trim() || "");
  return names;
}

/**
 * Historical round records are read-only and public to every support reader.
 * Sending and receiving still go through the current-round checks.
 */
export async function readAuthorizedAdminConsultationHistory(
  client: PoolClient,
  context: AdminContext,
  appId: string,
  consultationId: string,
): Promise<ConsultationRow> {
  const access = await loadEffectiveAdminAccess(client, context.userId);
  if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
  const row = (await client.query<ConsultationRow>(
    `${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND c."id" = $2`,
    [appId, consultationId],
  )).rows[0];
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
  return row;
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
    await readAuthorizedAdminConsultationHistory(client, context, options.appId, consultationId);
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

export type ConsultationRoundView = {
  id: string;
  roundSeq: string;
  state: ConsultationState;
  assignedAdmin: { id: string; name: string; avatar?: string } | null;
  /** Read-only patrol handle for this round's own Team, scoped to the current viewer. */
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  closedAt: string | null;
  transferCount: string;
};

export type ConsultationRoundsPage = {
  contractVersion: "admin-consultation-rounds.v1";
  consultationId: string;
  rounds: ConsultationRoundView[];
  nextCursor: string | null;
};

export function parseRoundCursor(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[1-9][0-9]{0,18}$/.test(value)) throw invalid("Cursor is invalid");
  return value;
}

/**
 * All rounds on one persistent thread, newest first. Public to support readers;
 * no assignment, complaint or rating projection is added here.
 */
export async function listConsultationRounds(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  limitValue: string | null,
  cursorValue: string | null,
): Promise<ConsultationRoundsPage> {
  const limit = parseEventLimit(limitValue);
  if (!ID_PATTERN.test(consultationId)) throw invalid("Consultation identifier is invalid");
  const cursor = parseRoundCursor(cursorValue);
  return withTransaction(options.pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertAdminContextInTransaction(client, context);
    const target = await readAuthorizedAdminConsultationHistory(client, context, options.appId, consultationId);
    const threadId = target.threadId ?? target.id;
    const viewerAccountId = await auditViewerAccount(client, options.appId, context.userId);
    const rows = (await client.query<{
      id: string; roundSeq: string; state: ConsultationState; assignedAdminId: string | null;
      adminName: string | null; adminImage: string | null; messageScopeId: string | null; messageScopeState: MessageScopeState;
      createdAt: string; updatedAt: string;
      lastMessageAt: string | null; closedAt: string | null; transferCount: string;
    }>(
      `SELECT c."id", COALESCE(c."round_seq", 1)::text AS "roundSeq", c."state",
              c."assigned_admin_id" AS "assignedAdminId", au."name" AS "adminName", au."image" AS "adminImage",
              c."message_scope_id" AS "messageScopeId", c."message_scope_state" AS "messageScopeState",
              to_char(c."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
              to_char(c."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
              to_char(c."last_message_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastMessageAt",
              to_char(ev."closedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "closedAt",
              ev."transferCount"::text AS "transferCount"
         FROM "zzsh_iam"."im_consultation" c
         LEFT JOIN "zzsh_auth_admin"."user" au ON au."id" = c."assigned_admin_id"
         LEFT JOIN LATERAL (
           SELECT max(e."created_at") FILTER (WHERE e."event_type" = 'CLOSED') AS "closedAt",
                  count(*) FILTER (WHERE e."event_type" = 'TRANSFERRED') AS "transferCount"
             FROM "zzsh_iam"."im_consultation_event" e
            WHERE e."consultation_id" = c."id"
         ) ev ON true
        WHERE c."app_id" = $1 AND c."thread_id" = $2
          AND ($3::bigint IS NULL OR COALESCE(c."round_seq", 1) < $3::bigint)
        ORDER BY COALESCE(c."round_seq", 1) DESC, c."created_at" DESC, c."id" DESC
        LIMIT $4`,
      [options.appId, threadId, cursor, limit + 1],
    )).rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      contractVersion: "admin-consultation-rounds.v1",
      consultationId,
      rounds: page.map((row) => ({
        id: row.id,
        roundSeq: row.roundSeq,
        state: row.state,
        assignedAdmin: row.assignedAdminId
          ? { id: row.assignedAdminId, name: row.adminName?.trim() || "平台客服", ...(managedProfileImagePath(row.adminImage) ? { avatar: managedProfileImagePath(row.adminImage)! } : {}) }
          : null,
        conversationId: row.messageScopeState === "READY" && row.messageScopeId && viewerAccountId
          ? `${viewerAccountId}|2|${row.messageScopeId}`
          : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastMessageAt: row.lastMessageAt,
        closedAt: row.closedAt,
        transferCount: row.transferCount,
      })),
      nextCursor: hasMore && page.at(-1) ? page.at(-1)!.roundSeq : null,
    };
  });
}
