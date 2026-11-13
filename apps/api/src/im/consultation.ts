/**
 * 咨询核心业务：开轮、消息访问、认领/转接/接管/关闭与重试入口。
 * 解析、作用域恢复、在线、轮次四块已拆出，本文件保留原有导出路径（re-export）。
 */

import {
  ADMIN_PERMISSION,
  hasPermission,
  loadEffectiveAdminAccess,
  type EffectiveAdminAccess,
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
import {
  assertUserContextInTransaction,
  type UserContext,
} from "../auth/user-identity";
import { managedProfileImagePath } from "../profile/profile-avatar";
import { assertAftersaleUserActive } from "./aftersale";
import { deriveYunxinAccountId } from "./identity-lifecycle";
import {
  storeImSendIntent,
  readImSendIntent,
  insertImSentFact,
  type ImSendIntent,
  type ImReceiptActor,
  type ImReceiptMessage,
} from "./message-receipts";
import { assignWaitingOrders } from "./order-dispatch";
import {
  lockDispatchGate,
  lockSupportMutation,
  readEligibleSupport,
} from "./support-dispatch";
import {
  recordSupportHandover,
  requireSupportManagementRead,
  resolveFirstResponseSeconds,
  SUPPORT_FIRST_RESPONSE_ACTION,
  SUPPORT_FIRST_RESPONSE_REMINDER_ACTION,
} from "./support-management";
import { isPresenceStrictOnline } from "./support-presence-policy";
import { readSupportWelcome } from "./support-settings";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  CONSULTATION_SELECT,
  type ConsultationEntryIntent,
  type ConsultationRouteOptions,
  type ConsultationRow,
  type ConsultationState,
  type ConsultationView,
  ID_PATTERN,
  type MessageScopeOperationState,
  type MessageScopeOperationType,
  type SupportRoundRatingView,
  type SupportType,
  TEAM_CONVERSATION_PATTERN,
  THREAD_SELECT,
  type ThreadRow,
  USER_THREAD_SELECT,
  type WaitingRound,
  complaintHandoverGranted,
  complaintObjectGrantSql,
  conflict,
  decrementPresence,
  ensureThread,
  identityKey,
  invalid,
  iso,
  numberValue,
  readConsultation,
  readThreadById,
  readyAccount,
  recordSupportFirstResponse,
  requireSupportAccessFor,
  supportManagerIdentityKey,
  supportMessagePreview,
  teamIdFromConversationId,
  toView,
  unavailable,
  writeEvent,
} from "./consultation-internals";
import {
  beginClaimMembership,
  readAuthorizedAdminConsultation,
  releaseFailedClaim,
  reserveEligibleAdmin,
  restoreClaimLoad,
  sendSupportText,
  supportGreetingText,
  wakeAutoAssign,
} from "./consultation-rounds";
import {
  beginThreadTeamProvision,
  claimCloseReconciliation,
  executeScopeOperation,
  readScopeOperation,
  remoteActionMayStillBeInFlight,
  runScopeOperationNow,
  scopeOperationId,
  supportBotAccountId,
  supportManagerAccount,
  userCloseOperationId,
} from "./consultation-scope-recovery";

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
    await requireSupportAccessFor(client, access, context.userId, row);
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
    const rating = await readRoundRating(client, options.appId, row.id);
    return {
      consultation: {
        ...toView(row, accountId),
        botAccountId: supportBotAccountId(options),
        rating: ratingView(rating, row.state === "CLOSED" && Boolean(row.assignedAdminId)),
      },
    };
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
    // Complaint threads require the separate grant for reads too; the object-level
    // 0181 handover grant only covers the exact pre-upgrade assigned conversation.
    const complaintObjectGrant = matching.kind === "COMPLAINT" && assigned
      && !hasPermission(access, ADMIN_PERMISSION.imSupportComplaint)
      && await complaintHandoverGranted(client, matching.id, context.userId);
    if (matching.kind === "COMPLAINT" && !hasPermission(access, ADMIN_PERMISSION.imSupportComplaint) && !complaintObjectGrant) {
      throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    }
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
      await requireSupportAccessFor(client, access, context.userId, matching);
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
  query: string | null = null,
): Promise<{ consultations: ConsultationView[]; query: string | null }> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    const accountId = await readyAccount(client, identityKey(options.appId, "admin", "ADMIN", context.userId));
    const serviceQueue = hasPermission(access, ADMIN_PERMISSION.imSupportAccept);
    const canComplaint = hasPermission(access, ADMIN_PERMISSION.imSupportComplaint);
    const adminThreadRead = Boolean(access?.isBoss || hasPermission(access, ADMIN_PERMISSION.imSupportManagementRead));
    // SERVICE/COMPLAINT 各自成线程；没有投诉权限的客服不看投诉队列。
    // 用户还没说话的 WAITING 空会话不进队列；每个线程只保留一行：优先有用户消息的开放轮，
    // 其次本人处理过的最近已结束轮，保证轮次结束后仍能从同一会话打开历史。
    const rows = (await client.query<ConsultationRow>(
      `${CONSULTATION_SELECT}
        WHERE c."app_id" = $1
          AND c."id" = (
            SELECT c2."id" FROM "zzsh_iam"."im_consultation" c2
             WHERE c2."app_id" = c."app_id" AND c2."thread_id" = c."thread_id"
               AND (c2."kind" <> 'COMPLAINT' OR $5::boolean OR ${complaintObjectGrantSql('c2."id"', "$2")})
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
          AND (c."kind" <> 'COMPLAINT' OR $5::boolean OR ${complaintObjectGrantSql('c."id"', "$2")})
          AND (c."assigned_admin_id" = $2
            OR (c."assigned_admin_id" IS NULL AND $3::boolean AND c."state" = 'WAITING'))
          AND NOT (c."state" = 'WAITING' AND c."assigned_admin_id" IS NULL AND c."first_user_message_at" IS NULL)
          AND ($6::text IS NULL OR u."name" ILIKE '%'||$6||'%' OR u."username" ILIKE '%'||$6||'%')
        ORDER BY CASE WHEN c."assigned_admin_id" = $2 THEN 0 ELSE 1 END, c."updated_at", c."id"
        LIMIT $4`,
      [options.appId, context.userId, serviceQueue, limit, canComplaint, query ?? null],
    )).rows;
    return { consultations: rows.map((row) => ({ ...toView(row, accountId, true, context.userId, adminThreadRead), botAccountId: supportBotAccountId(options) })), query: query ?? null };
  });
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
  connectionId?: string,
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
      await requireSupportAccessFor(client, currentAccess, context.userId, row, "transfer");
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
    const selfTakeover = kind === "TAKEOVER" && targetAdminId === context.userId;
    const reservation = await reserveEligibleAdmin(
      client, options.appId, locked, row.kind, targetAdminId, options.supportConcurrency, true,
      selfTakeover ? "STRICT" : "DISPATCHABLE",
      selfTakeover ? context.sessionId : undefined,
      selfTakeover ? connectionId : undefined,
    );
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
): Promise<{
  targets: { adminUserId: string; displayName: string; inGrace: boolean; disconnectedSince: string | null }[];
  transferReady: boolean;
}> {
  return withTransaction(options.pool, async (client) => {
    const locked = await lockSupportMutation(client, options.appId, [], [context.userId]);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId);
    await requireSupportAccessFor(client, access, context.userId, row, "transfer");
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) {
      throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    }
    if (row.messageScopeState !== "READY" || !row.messageScopeId) return { targets: [], transferReady: false };
    const candidates = await readEligibleSupport(client, options.appId, locked);
    const targets = candidates
      .filter((candidate) => candidate.adminUserId !== context.userId && (row.kind !== "COMPLAINT" || candidate.complaint))
      .map((candidate) => ({
        adminUserId: candidate.adminUserId,
        displayName: candidate.adminName,
        inGrace: !isPresenceStrictOnline({
          availability: "AVAILABLE",
          connectionState: candidate.connectionState ?? "DISCONNECTED",
          lastConfirmedAt: candidate.lastConfirmedAt ?? null,
          disconnectedSince: candidate.disconnectedSince ?? null,
          dispatchPaused: false,
          hasOwnedSession: true,
        }),
        disconnectedSince: candidate.disconnectedSince ?? null,
      }));
    return { targets, transferReady: true };
  });
}

type ClosePlan = { operationId: string };

type RoundCloseActor = {
  realm: "admin" | "user";
  actorId: string;
  sessionId: string;
  /** 用户侧客户端 operationId，仅用于审计追溯。 */
  clientOperationId?: string;
};

/** Admin close and user close share this single ROUND_CLOSE implementation. */
async function beginRoundClose(
  client: PoolClient,
  options: ConsultationRouteOptions,
  row: ConsultationRow,
  requestId: string,
  actor: RoundCloseActor,
  operationId: string,
): Promise<ClosePlan | null> {
  const consultationId = row.id;
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
  await client.query(
    `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
      ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id",
       "previous_admin_id", "previous_admin_account_id", "provider_team_id")
     VALUES ($1,$2,$3,'ROUND_CLOSE',$4,$5,$6,$7,$8,$9)`,
    [operationId, options.appId, row.id, updated.rows[0].messageScopeVersion, manager.accountId, row.userAccountId,
      row.assignedAdminId, row.peerAccountId, row.messageScopeId],
  );
  await recordAudit(client, {
    actorType: actor.realm,
    actorId: actor.actorId,
    sessionId: actor.sessionId,
    action: "im.consultation.round_close.requested",
    objectType: "im_consultation",
    objectId: row.id,
    outcome: "SUCCESS",
    requestId,
    details: {
      threadId: thread.id,
      roundSeq: row.roundSeq,
      teamRetained: true,
      ...(actor.clientOperationId ? { operationId: actor.clientOperationId } : {}),
    },
  });
  return { operationId };
}

async function beginClose(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, requestId: string): Promise<ClosePlan | null> {
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId, true);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    await requireSupportAccessFor(client, access, context.userId, row);
    return beginRoundClose(client, options, row, requestId,
      { realm: "admin", actorId: context.userId, sessionId: context.sessionId }, scopeOperationId());
  });
}

type LocalCloseActor =
  | { realm: "admin"; context: AdminContext }
  | { realm: "user"; context: UserContext };

async function completeLocalCloseInTransaction(
  client: PoolClient,
  options: ConsultationRouteOptions,
  actor: LocalCloseActor,
  row: ConsultationRow,
  requestId: string,
  clientOperationId?: string,
): Promise<void> {
  const actorId = actor.context.userId;
  if (actor.realm === "admin") {
    const access = await loadEffectiveAdminAccess(client, actorId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    await requireSupportAccessFor(client, access, actorId, row);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== actorId) throw conflict("Consultation changed during close");
  } else {
    if (row.userId !== actorId) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
    if (row.state === "WAITING") throw conflict("等待客服接入后才能结束本轮咨询");
    if (row.state !== "ACTIVE") throw conflict("本轮咨询已结束");
  }
  if (row.messageScopeId) throw conflict("IM message scope requires remote close");
  // No Team ever existed: close the business object without claiming remote revocation.
  const updated = await client.query(
    actor.realm === "admin"
      ? `UPDATE "zzsh_iam"."im_consultation"
            SET "state" = 'CLOSED',
                "version" = "version" + 1, "message_scope_version" = "message_scope_version" + 1,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "assigned_admin_id" = $3`
      : `UPDATE "zzsh_iam"."im_consultation"
            SET "state" = 'CLOSED',
                "version" = "version" + 1, "message_scope_version" = "message_scope_version" + 1,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "user_id" = $3`,
    [options.appId, row.id, actorId],
  );
  if (updated.rowCount !== 1) throw conflict("Consultation changed during close");
  await decrementPresence(client, options.appId, row.assignedAdminId);
  await client.query(
    `UPDATE "zzsh_iam"."im_support_thread"
        SET "state" = 'IDLE', "peer_account_id" = NULL, "version" = "version" + 1, "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "id" = $2`,
    [options.appId, row.threadId ?? ""],
  );
  await writeEvent(client, {
    consultationId: row.id,
    eventType: "CLOSED",
    actorType: actor.realm,
    actorId,
    fromAdminId: row.assignedAdminId,
    peerAccountId: row.peerAccountId,
    ...(clientOperationId ? { details: { operationId: clientOperationId, local: true } } : {}),
  });
  await recordAudit(client, {
    actorType: actor.realm,
    actorId,
    sessionId: actor.context.sessionId,
    action: "im.consultation.closed",
    objectType: "im_consultation",
    objectId: row.id,
    outcome: "SUCCESS",
    requestId,
    ...(clientOperationId ? { details: { operationId: clientOperationId, local: true } } : {}),
  });
}

async function completeLocalClose(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, requestId: string): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [context.userId]);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const row = await readConsultation(client, options.appId, consultationId, true);
    await completeLocalCloseInTransaction(client, options, { realm: "admin", context }, row, requestId);
  });
}

type UserCloseReplay =
  | { operationId: string; state: MessageScopeOperationState }
  | { local: true };

/**
 * Same operationId replays the durable scope operation or the local CLOSED event;
 * a different round under the same operationId is a conflict, never a second close.
 */
async function readUserCloseReplay(
  client: PoolClient,
  options: ConsultationRouteOptions,
  row: ConsultationRow,
  operationId: string,
  clientOperationId: string,
): Promise<UserCloseReplay | null> {
  const operation = (await client.query<{ consultationId: string; operationType: MessageScopeOperationType; state: MessageScopeOperationState }>(
    `SELECT "consultation_id" AS "consultationId", "operation_type" AS "operationType", "state"
       FROM "zzsh_iam"."im_consultation_scope_operation"
      WHERE "app_id" = $1 AND "id" = $2 FOR UPDATE`,
    [options.appId, operationId],
  )).rows[0];
  if (operation) {
    if (operation.consultationId !== row.id || operation.operationType !== "ROUND_CLOSE") throw conflict("Operation identity was reused with different input");
    return { operationId, state: operation.state };
  }
  const closed = (await client.query<{ consultationId: string }>(
    `SELECT e."consultation_id" AS "consultationId"
       FROM "zzsh_iam"."im_consultation_event" e
       JOIN "zzsh_iam"."im_consultation" c ON c."id" = e."consultation_id"
      WHERE c."app_id" = $1 AND e."actor_type" = 'user' AND e."actor_id" = $2
        AND e."event_type" = 'CLOSED' AND e."details"->>'operationId' = $3
      LIMIT 1`,
    [options.appId, row.userId, clientOperationId],
  )).rows[0];
  if (closed) {
    if (closed.consultationId !== row.id) throw conflict("Operation identity was reused with different input");
    return { local: true };
  }
  return null;
}

/**
 * User-initiated close: only the active round owned by the caller. The durable
 * ROUND_CLOSE operation keeps retries and remote recovery on the admin path;
 * idempotency also rides that operation (or the local CLOSED event), so the
 * provider call is never wrapped in the request's database transaction.
 */
export async function closeUserConsultation(
  options: ConsultationRouteOptions,
  context: UserContext,
  id: string,
  clientOperationId: string,
  requestId: string,
): Promise<{ consultation: ConsultationView }> {
  const plan = await withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "user", context.userId, context.sessionId, requestId);
    await assertUserContextInTransaction(client, context);
    const row = await readConsultation(client, options.appId, id, true);
    if (row.userId !== context.userId) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
    const operationId = userCloseOperationId(options.appId, context.userId, clientOperationId);
    const replay = await readUserCloseReplay(client, options, row, operationId, clientOperationId);
    if (replay) return { ...replay, replayed: true as const };
    if (row.state === "WAITING") throw conflict("等待客服接入后才能结束本轮咨询");
    if (row.state !== "ACTIVE") throw conflict("本轮咨询已结束");
    const close = await beginRoundClose(client, options, row, requestId,
      { realm: "user", actorId: context.userId, sessionId: context.sessionId, clientOperationId }, operationId);
    if (!close) {
      await completeLocalCloseInTransaction(client, options, { realm: "user", context }, row, requestId, clientOperationId);
      return { local: true as const, replayed: false as const };
    }
    return { ...close, state: "PENDING" as const, replayed: false as const };
  });
  if ("operationId" in plan && plan.state !== "SUCCEEDED") await runScopeOperationNow(options, plan.operationId);
  const result = await readUserConsultationView(options, context, id);
  if (result.consultation.state !== "CLOSED") throw unavailable("本轮结束正在处理中，请稍后刷新");
  void wakeAutoAssign(options);
  return result;
}

export async function claimConsultation(options: ConsultationRouteOptions, context: AdminContext, id: string, requestId: string, aftersaleId?:string, connectionId?: string): Promise<{ consultation: ConsultationView }> {
  // Auto-assignment is the primary path. Manual claim is a management fallback;
  // enforce it server-side so hiding the button is not the only control.
  const access = await withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    return loadEffectiveAdminAccess(client, context.userId);
  });
  if (!aftersaleId && !(access?.isBoss || hasPermission(access, ADMIN_PERMISSION.imSupportAuditTakeover))) {
    throw new SecurityApiError(403, "FORBIDDEN", "Manual takeover requires a management grant");
  }
  let plan = await beginClaimMembership(options, context, id, requestId, aftersaleId, connectionId);
  if (plan.kind === "NEEDS_TEAM") {
    // First use after close/reopen may still need the thread Team; create it before adding the agent.
    await ensureThreadTeam(options, plan.threadId, id);
    plan = await beginClaimMembership(options, context, id, requestId, aftersaleId, connectionId);
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
  connectionId?: string,
): Promise<{ consultation: ConsultationView }> {
  const plan = await beginTransfer(options, context, id, context.userId, requestId, note, "TAKEOVER", connectionId);
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
  connectionId?: string,
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
    await requireSupportAccessFor(client, access, context.userId, row);
    if (row.messageScopeState !== "READY" || row.messageScopeId !== detail.providerTeamId) {
      throw conflict("IM claim scope changed during recovery");
    }
    const locked = await lockSupportMutation(client, options.appId, [], [context.userId]);
    // 同一目标已由原操作预留过一次：恢复只做只读资格校验，不 reserve、不再推进分配时间。
    const target = (await readEligibleSupport(client, options.appId, locked, "STRICT", context.sessionId, connectionId)).find((candidate) => candidate.adminUserId === context.userId);
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
  connectionId?: string,
): Promise<{ consultation: ConsultationView }> {
  // ADD_MEMBER 对账恢复必须先于关单对账：等待中轮次没有负责人，关单路径会直接拒绝。
  const claimRecoveryId = await retryOwnClaimOperation(options, context, consultationId, requestId, connectionId);
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

export {
  type ConsultationEntryIntent,
  type ConsultationRouteOptions,
  type ConsultationState,
  type ConsultationView,
  type MessageScopeOperationState,
  type MessageScopeOperationType,
  type MessageScopeState,
  SUPPORT_MANAGER_SUBJECT_ID,
  type SupportAvailability,
  type SupportConnectionState,
  type SupportPresence,
  type SupportPresenceHeartbeat,
  type SupportPresenceReason,
  type SupportRoundRatingView,
  type SupportThreadState,
  type SupportType,
  ownsPresenceConnection,
  recordSupportThreadMessage,
  requireSupportAccess,
  supportManagerIdentityKey,
  supportMessagePreview,
  toView,
} from "./consultation-internals";

export {
  parseConnectionIdBody,
  parseConsultationBody,
  parseLimit,
  parsePresenceBody,
  parsePresenceHeartbeatBody,
  parseSupportRatingBody,
  parseSupportType,
  parseUserCloseBody,
} from "./consultation-parsing";

export {
  MessageScopeRecoveryLifecycle,
  reconcileMessageScopes,
  startMessageScopeRecovery,
} from "./consultation-scope-recovery";

export {
  type SupportConnectionClaim,
  type SupportConnectionLease,
  type SupportConnectionRelease,
  claimSupportConnection,
  heartbeatLockedOwnPresence,
  heartbeatOwnPresence,
  readOwnPresence,
  refreshSupportConnection,
  releaseSupportConnection,
  updateOwnPresence,
} from "./consultation-presence";

export {
  type ConsultationEventPage,
  type ConsultationEventView,
  type ConsultationRoundView,
  type ConsultationRoundsPage,
  autoAssignWaitingConsultations,
  decodeEventCursor,
  encodeEventCursor,
  listConsultationEvents,
  listConsultationRounds,
  parseEventLimit,
} from "./consultation-rounds";
