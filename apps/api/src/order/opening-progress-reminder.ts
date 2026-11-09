import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../im/identity-lifecycle";
import { assertSupportOrderAccess, type ManualCloseActor } from "./manual-close";

export type ReminderParty = "RENTER" | "OWNER";
export type ReminderStage = "OPENING_PENDING" | "SETTLEMENT_DECISION" | "IN_RENTAL";
export type ReminderReason =
  | "ORDER_NOT_ACTIVE"
  | "OPENING_MISSING"
  | "OPENING_REVIEW_REQUIRED"
  | "INTAKE_PENDING"
  | "PARTIES_CONFIRMED"
  | "DECISION_REJECTED"
  | "SETTLEMENT_POSTED";

export type ReminderPlan =
  | { kind: "READY"; stage: ReminderStage; targets: ReminderParty[]; text: string }
  | { kind: "NO_ACTION"; reason: ReminderReason };

export type PreparedReminder = {
  kind: "SEND";
  id: string;
  orderId: string;
  stage: ReminderStage;
  targets: ReminderParty[];
  text: string;
  appId: string;
  teamId: string;
  systemAccount: string;
  leaseToken: string;
};
export type PreparedReminderOutcome =
  | PreparedReminder
  | { kind: "SENT"; id: string; orderId: string; stage: ReminderStage; targets: ReminderParty[]; messageServerId: string | null }
  | { kind: "IN_PROGRESS"; id: string }
  | { kind: "UNKNOWN"; id: string; failureClass: string | null }
  | { kind: "STALE"; id: string; reason: ReminderReason | "STAGE_CHANGED"; currentStage: ReminderStage | null }
  | { kind: "NO_ACTION"; reason: ReminderReason }
  | { kind: "TEAM_NOT_READY"; reason: "TEAM_NOT_READY" | "IDENTITY_PENDING" };

const REMINDER_LEASE_MS = 30_000;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export function isOpeningReminderRequestKey(value: unknown): value is string {
  return typeof value === "string" && REQUEST_KEY.test(value);
}

function partyNames(targets: readonly ReminderParty[]): string {
  return targets.length === 2 ? "租客和号主" : targets[0] === "RENTER" ? "租客" : "号主";
}

/** 群内通用提醒，只含订单号、阶段与入口；金额和身份仍从受权订单读取。 */
export function openingReminderText(displayNo: string, stage: ReminderStage, targets: readonly ReminderParty[]): string {
  const who = partyNames(targets);
  if (stage === "OPENING_PENDING") {
    return `【开租确认提醒】订单 ${displayNo} 的开租清单已生成，请${who}到订单页核对并确认，确认后开始计算租期。`;
  }
  if (stage === "SETTLEMENT_DECISION") {
    return `【结算确认提醒】订单 ${displayNo} 的结算方案待${who}确认，请到订单页核对数量与金额。`;
  }
  return `【履约提醒】订单 ${displayNo} 仍在租期中，如需结束，请到订单页发起结算并核对剩余资源。`;
}

/** 服务端按真实订单状态决定提醒阶段和接收方；客户端不能指定或覆盖。 */
export async function planOrderProgressReminder(client: Pick<PoolClient, "query">, orderId: string): Promise<ReminderPlan> {
  const order = (await client.query<{ status: string; displayNo: string; renterUserId: string; ownerUserId: string }>(
    `SELECT status, display_no AS "displayNo", renter_user_id AS "renterUserId", owner_user_id AS "ownerUserId"
       FROM zzsh_order.rental_order WHERE id = $1`,
    [orderId],
  )).rows[0];
  if (!order) return { kind: "NO_ACTION", reason: "ORDER_NOT_ACTIVE" };
  if (order.status !== "PAID") return { kind: "NO_ACTION", reason: "ORDER_NOT_ACTIVE" };
  const posted = (await client.query(`SELECT 1 FROM zzsh_order.settlement_posting WHERE order_id = $1 LIMIT 1`, [orderId])).rowCount;
  if (posted) return { kind: "NO_ACTION", reason: "SETTLEMENT_POSTED" };
  const opening = (await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM zzsh_order.rental_opening WHERE order_id = $1 ORDER BY version_no DESC LIMIT 1`,
    [orderId],
  )).rows[0];
  if (!opening) {
    const generation = (await client.query<{ state: string }>(
      `SELECT state FROM zzsh_order.rental_opening_generation WHERE order_id = $1`, [orderId],
    )).rows[0];
    return { kind: "NO_ACTION", reason: generation?.state === "REVIEW_REQUIRED" ? "OPENING_REVIEW_REQUIRED" : "OPENING_MISSING" };
  }
  if (opening.status === "DRAFT") {
    const acks = new Set((await client.query<{ party: string }>(
      `SELECT party FROM zzsh_order.rental_opening_ack WHERE opening_id = $1`, [opening.id],
    )).rows.map((row) => row.party));
    const targets = (["RENTER", "OWNER"] as const).filter((party) => !acks.has(party));
    return targets.length
      ? { kind: "READY", stage: "OPENING_PENDING", targets, text: openingReminderText(order.displayNo, "OPENING_PENDING", targets) }
      : { kind: "NO_ACTION", reason: "PARTIES_CONFIRMED" };
  }
  const intake = (await client.query<{ id: string }>(
    `SELECT id FROM zzsh_order.settlement_intake WHERE order_id = $1 AND status = 'OPEN' ORDER BY version_no DESC LIMIT 1`,
    [orderId],
  )).rows[0];
  if (intake) return { kind: "NO_ACTION", reason: "INTAKE_PENDING" };
  const current = (await client.query<{ id: string }>(
    `SELECT id FROM zzsh_order.settlement_version WHERE order_id = $1 AND superseded_at IS NULL`, [orderId],
  )).rows[0];
  if (current) {
    const decisions = (await client.query<{ party: string; action: string }>(
      `SELECT party, action FROM zzsh_order.settlement_decision
        WHERE settlement_version_id = $1 AND party IN ('RENTER','OWNER') AND action IN ('CONFIRM','REJECT')`,
      [current.id],
    )).rows;
    if (decisions.some((row) => row.action === "REJECT")) {
      return { kind: "NO_ACTION", reason: "DECISION_REJECTED" };
    }
    const confirmed = new Set(decisions.filter((row) => row.action === "CONFIRM").map((row) => row.party));
    const targets = (["RENTER", "OWNER"] as const).filter((party) => !confirmed.has(party));
    return targets.length
      ? { kind: "READY", stage: "SETTLEMENT_DECISION", targets, text: openingReminderText(order.displayNo, "SETTLEMENT_DECISION", targets) }
      : { kind: "NO_ACTION", reason: "PARTIES_CONFIRMED" };
  }
  return { kind: "READY", stage: "IN_RENTAL", targets: ["RENTER", "OWNER"], text: openingReminderText(order.displayNo, "IN_RENTAL", ["RENTER", "OWNER"]) };
}

async function systemTeam(client: Pick<PoolClient, "query">, appId: string, orderId: string): Promise<{ teamId: string; systemAccount: string } | null> {
  const row = (await client.query<{
    teamId: string | null; teamState: string | null; accountId: string | null; status: string | null;
    subject: string | null; marker: string | null;
  }>(
    `SELECT g.team_id AS "teamId", g.team_state AS "teamState",
            m.account_id AS "accountId", m.status, m.platform_subject_id AS subject, m.identity_marker AS marker
       FROM zzsh_order.im_order_group g
       LEFT JOIN zzsh_iam.im_identity_mapping m ON m.id = g.system_identity_id
      WHERE g.order_id = $1 AND g.app_id = $2`,
    [orderId, appId],
  )).rows[0];
  if (!row || row.teamState !== "READY" || !row.teamId || !ID.test(row.teamId)) return null;
  const expected = { provider: "yunxin" as const, appId, realm: "system" as const, kind: "SYSTEM" as const, platformSubjectId: "support-manager" };
  if (!row.accountId || row.status !== "READY" || row.subject !== "support-manager"
    || row.accountId !== deriveYunxinAccountId(expected) || row.marker !== buildYunxinIdentityMarker(expected)) return null;
  return { teamId: row.teamId, systemAccount: row.accountId };
}

/**
 * 创建或恢复同一次点击的提醒。请求键相同只复用一条记录；实际发送由调用方
 * 用返回的 id 作为云信 message_client_id 执行，成功后才标记 SENT。
 */
/** True only when the stored request still describes the current stage and recipients. */
export function reminderPlanMatchesExisting(
  existing: { stage: ReminderStage; targets: readonly ReminderParty[] },
  plan: ReminderPlan,
): boolean {
  return plan.kind === "READY" && plan.stage === existing.stage
    && plan.targets.length === existing.targets.length
    && plan.targets.every((party) => existing.targets.includes(party));
}

export async function prepareOpeningProgressReminder(
  pool: Pool,
  orderId: string,
  actor: ManualCloseActor,
  requestKey: string,
  _requestId: string,
): Promise<PreparedReminderOutcome> {
  if (!ID.test(orderId) || !isOpeningReminderRequestKey(requestKey)) throw new Error("INVALID_REMINDER_REQUEST");
  return withTransaction(pool, async (client) => {
    await assertSupportOrderAccess(client, orderId, actor);
    const existing = (await client.query<{
      id: string; orderId: string; state: "PENDING" | "SENDING" | "SENT" | "UNKNOWN" | "FAILED";
      stage: ReminderStage; targets: ReminderParty[]; text: string; appId: string;
      failureClass: string | null; leaseUntil: Date | string | null; messageServerId: string | null;
    }>(
      `SELECT id, order_id AS "orderId", state, stage, target_parties AS targets, message_text AS text,
              app_id AS "appId", failure_class AS "failureClass", lease_until AS "leaseUntil",
              server_message_id AS "messageServerId"
         FROM zzsh_order.opening_progress_reminder WHERE admin_user_id = $1 AND request_key = $2`,
      [actor.userId, requestKey],
    )).rows[0];
    if (existing) {
      if (existing.orderId !== orderId) throw new SecurityApiError(409, "IDEMPOTENCY_KEY_REUSED", "请求键已用于其他订单");
      if (existing.state === "SENT") {
        return { kind: "SENT", id: existing.id, orderId, stage: existing.stage, targets: existing.targets, messageServerId: existing.messageServerId };
      }
      if (existing.state === "UNKNOWN") return { kind: "UNKNOWN", id: existing.id, failureClass: existing.failureClass };
      if (existing.state === "SENDING") {
        const lease = existing.leaseUntil ? new Date(existing.leaseUntil).getTime() : 0;
        if (Number.isFinite(lease) && lease > Date.now()) return { kind: "IN_PROGRESS", id: existing.id };
        // A crashed/expired claim cannot be assumed unsent. Freeze it as unknown and
        // require a fresh manual click after the operator checks the group.
        await client.query(
          `UPDATE zzsh_order.opening_progress_reminder
              SET state='UNKNOWN', failure_class='LEASE_EXPIRED', lease_token_hash=NULL, lease_until=NULL,
                  sent_at=NULL, updated_at=clock_timestamp()
            WHERE id=$1 AND admin_user_id=$2 AND state='SENDING' AND lease_token_hash IS NOT NULL`,
          [existing.id, actor.userId],
        );
        return { kind: "UNKNOWN", id: existing.id, failureClass: "LEASE_EXPIRED" };
      }
      const team = await systemTeam(client, existing.appId, orderId);
      if (!team) return { kind: "TEAM_NOT_READY", reason: "TEAM_NOT_READY" };
      // A retry keeps the original request, but it must never replay a stage that
      // has already moved on. Re-derive the current stage before claiming.
      const currentPlan = await planOrderProgressReminder(client, orderId);
      const samePlan = reminderPlanMatchesExisting(existing, currentPlan);
      if (!samePlan) {
        await client.query(
          `UPDATE zzsh_order.opening_progress_reminder
              SET state='FAILED', failure_class='STAGE_CHANGED', lease_token_hash=NULL, lease_until=NULL,
                  sent_at=NULL, updated_at=clock_timestamp()
            WHERE id=$1 AND admin_user_id=$2 AND state IN ('PENDING','FAILED')`,
          [existing.id, actor.userId],
        );
        return {
          kind: "STALE", id: existing.id,
          reason: currentPlan.kind === "NO_ACTION" ? currentPlan.reason : "STAGE_CHANGED",
          currentStage: currentPlan.kind === "READY" ? currentPlan.stage : null,
        };
      }
      const token = randomUUID();
      const claimed = await client.query(
        `UPDATE zzsh_order.opening_progress_reminder
            SET state='SENDING', lease_token_hash=$3, lease_until=clock_timestamp() + ($4::bigint * interval '1 millisecond'),
                attempt_count=attempt_count+1, failure_class=NULL, sent_at=NULL, updated_at=clock_timestamp()
          WHERE id=$1 AND admin_user_id=$2 AND state IN ('PENDING','FAILED')`,
        [existing.id, actor.userId, tokenHash(token), REMINDER_LEASE_MS],
      );
      if (claimed.rowCount !== 1) {
        const current = (await client.query<{ state: string; id: string }>(
          `SELECT id, state FROM zzsh_order.opening_progress_reminder WHERE id=$1 AND admin_user_id=$2`,
          [existing.id, actor.userId],
        )).rows[0];
        if (!current) throw new Error("REMINDER_PREPARE_LOST");
        if (current.state === "SENT") return { kind: "SENT", id: current.id, orderId, stage: existing.stage, targets: existing.targets, messageServerId: existing.messageServerId };
        if (current.state === "SENDING") return { kind: "IN_PROGRESS", id: current.id };
        return { kind: "UNKNOWN", id: current.id, failureClass: existing.failureClass ?? "CONCURRENT_STATE" };
      }
      return {
        kind: "SEND", id: existing.id, orderId, stage: existing.stage, targets: existing.targets, text: existing.text,
        appId: existing.appId, ...team, leaseToken: token,
      };
    }
    const plan = await planOrderProgressReminder(client, orderId);
    if (plan.kind === "NO_ACTION") return plan;
    const group = (await client.query<{ appId: string }>(
      `SELECT app_id AS "appId" FROM zzsh_order.im_order_group WHERE order_id = $1`, [orderId],
    )).rows[0];
    if (!group?.appId) return { kind: "TEAM_NOT_READY", reason: "TEAM_NOT_READY" };
    const team = await systemTeam(client, group.appId, orderId);
    if (!team) return { kind: "TEAM_NOT_READY", reason: "TEAM_NOT_READY" };
    const id = `reminder_${randomUUID().replaceAll("-", "")}`;
    const token = randomUUID();
    const inserted = (await client.query<{
      id: string; orderId: string; state: "PENDING" | "SENDING" | "SENT" | "UNKNOWN" | "FAILED"; stage: ReminderStage;
      targets: ReminderParty[]; text: string; appId: string;
    }>(
      `INSERT INTO zzsh_order.opening_progress_reminder
         (id, order_id, app_id, admin_user_id, request_key, stage, target_parties, message_text, state, attempt_count, lease_token_hash, lease_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, 'SENDING', 1, $9, clock_timestamp() + ($10::bigint * interval '1 millisecond'))
       ON CONFLICT (admin_user_id, request_key) DO NOTHING
       RETURNING id, order_id AS "orderId", state, stage, target_parties AS targets, message_text AS text, app_id AS "appId"`,
      [id, orderId, group.appId, actor.userId, requestKey, plan.stage, plan.targets, plan.text, tokenHash(token), REMINDER_LEASE_MS],
    )).rows[0];
    if (inserted) {
      return { kind: "SEND", ...inserted, ...team, leaseToken: token };
    }
    const raced = (await client.query<{
      id: string; orderId: string; state: "PENDING" | "SENDING" | "SENT" | "UNKNOWN" | "FAILED";
      stage: ReminderStage; targets: ReminderParty[]; text: string; appId: string;
    }>(
      `SELECT id, order_id AS "orderId", state, stage, target_parties AS targets, message_text AS text, app_id AS "appId"
         FROM zzsh_order.opening_progress_reminder WHERE admin_user_id = $1 AND request_key = $2`,
      [actor.userId, requestKey],
    )).rows[0];
    if (!raced) throw new Error("REMINDER_PREPARE_LOST");
    if (raced.orderId !== orderId) throw new SecurityApiError(409, "IDEMPOTENCY_KEY_REUSED", "请求键已用于其他订单");
    if (raced.state === "SENT") return { kind: "SENT", id: raced.id, orderId, stage: raced.stage, targets: raced.targets, messageServerId: null };
    if (raced.state === "SENDING") return { kind: "IN_PROGRESS", id: raced.id };
    return { kind: "UNKNOWN", id: raced.id, failureClass: "CONCURRENT_STATE" };
  });
}

export function reminderFailureClass(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "SEND_FAILED";
}

/** Only a provider's numeric 4xx rejection proves the message was not accepted. */
export function reminderDeliveryDisposition(error: unknown): "FAILED" | "UNKNOWN" {
  const value = error as { name?: unknown; providerCode?: unknown; retryable?: unknown; httpStatus?: unknown } | null;
  if (value?.name === "YunxinApiError" && typeof value.providerCode === "number") {
    // 429, 5xx and retryable responses stay unknown; a generic transport code
    // such as ECONNRESET or ETIMEDOUT never proves the message was unsent.
    if (value.retryable === true || value.providerCode >= 500 || value.providerCode === 429
      || (typeof value.httpStatus === "number" && (value.httpStatus >= 500 || value.httpStatus === 429))) return "UNKNOWN";
    return "FAILED";
  }
  return "UNKNOWN";
}

export async function markOpeningProgressReminder(
  pool: Pool,
  reminder: PreparedReminder,
  actor: { userId: string; sessionId: string },
  state: "SENT" | "UNKNOWN" | "FAILED",
  requestId: string,
  failureClass: string | null,
  serverMessageId: string | null = null,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const updated = await client.query<{ state: string }>(
      `UPDATE zzsh_order.opening_progress_reminder
          SET state = $4, failure_class = $5, server_message_id = $6,
              sent_at = CASE WHEN $4 = 'SENT' THEN clock_timestamp() ELSE NULL END,
              lease_token_hash = NULL, lease_until = NULL, updated_at = clock_timestamp()
        WHERE id = $1 AND admin_user_id = $2 AND state = 'SENDING' AND lease_token_hash = $3
        RETURNING state`,
      [reminder.id, actor.userId, tokenHash(reminder.leaseToken), state, failureClass, serverMessageId],
    );
    if (updated.rowCount !== 1) {
      const current = (await client.query<{ state: string }>(
        `SELECT state FROM zzsh_order.opening_progress_reminder WHERE id=$1 AND admin_user_id=$2`,
        [reminder.id, actor.userId],
      )).rows[0];
      return current?.state === "SENT";
    }
    await recordAudit(client, {
      actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, requestId,
      action: state === "SENT" ? "order.opening.reminder.sent" : state === "UNKNOWN" ? "order.opening.reminder.unknown" : "order.opening.reminder.failed",
      objectType: "opening_progress_reminder", objectId: reminder.id,
      outcome: state === "SENT" ? "SUCCESS" : "FAILURE",
      ...(failureClass === null ? {} : { reason: failureClass }),
      details: { orderId: reminder.orderId, stage: reminder.stage, targets: reminder.targets },
    });
    return true;
  });
}
