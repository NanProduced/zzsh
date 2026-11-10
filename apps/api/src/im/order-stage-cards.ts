import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey } from "./identity-lifecycle";
import type { ImTransportCard, ImTransportMessage } from "./im-contract";
import { recordOrderGroupMessage } from "./order-team-access";
import { stageCardSafeSendSql } from "./order-stage-card-retry";

/**
 * O-01 stage cards. A card is an ordinary chat message; the order facts stay in
 * the role-projected read path and the payload only carries kind/orderId/cardId.
 * This worker turns committed order facts into at most one message per stage.
 */
export type StageCardTransport = {
  card(input: { conversationId: string; senderAccountId: string; receiverAccountId: string; card: ImTransportCard; text?: string }): Promise<ImTransportMessage>;
  text?(input: { conversationId: string; senderAccountId: string; receiverAccountId: string; text: string; messageClientId?: string }): Promise<ImTransportMessage>;
};

export type OrderStageCardOptions = {
  pool: Pool;
  appId: string;
  transport: StageCardTransport;
  now?: () => number;
  leaseMs?: number;
};

const STAGE_KINDS = ["ORDER_WELCOME", "ORDER_OPENING", "ORDER_ENDING", "ORDER_SETTLED", "ORDER_CANCELLED"] as const;
export type StageCardKind = (typeof STAGE_KINDS)[number];
const WELCOME_TEXT = "订单群已建立。本单的账号核对、开租确认和沟通都会在这里进行，双方确认后开始计算租期。有疑问可以直接在群里留言。";
const PREVIEWS: Record<StageCardKind, string> = {
  ORDER_WELCOME: "洲洲助手：订单群已建立",
  ORDER_OPENING: "开租确认卡",
  ORDER_ENDING: "结束确认卡",
  ORDER_SETTLED: "洲洲助手：本单已完成结算",
  ORDER_CANCELLED: "洲洲助手：本单已取消",
};

const WINDOW_MS = 72 * 60 * 60 * 1_000;
const SYSTEM_SUBJECT = "support-manager";

type DueRow = {
  id: string;
  order_id: string;
  kind: string;
  card_id: string;
  attempt_count: number;
  team_id: string;
  order_status: string;
  posted_at: Date | string | null;
  has_activity: boolean;
  system_account: string | null;
  system_status: string | null;
  system_marker: string | null;
  system_subject: string | null;
};

function isStageKind(value: string): value is StageCardKind {
  return (STAGE_KINDS as readonly string[]).includes(value);
}

function systemAccountOf(appId: string, row: DueRow): string | null {
  const expected: ImIdentityKey = { provider: "yunxin", appId, realm: "system", kind: "SYSTEM", platformSubjectId: SYSTEM_SUBJECT };
  if (!row.system_account || row.system_status !== "READY" || row.system_subject !== SYSTEM_SUBJECT
    || row.system_account !== deriveYunxinAccountId(expected) || row.system_marker !== buildYunxinIdentityMarker(expected)) {
    return null;
  }
  return row.system_account;
}

function failureClass(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "SEND_FAILED";
}

/** Card sends never outlive the order's terminal chat window. */
export function stageCardWindowReason(orderStatus: string, postedAt: Date | string | null, now: number): StageCardSkipReason | null {
  if (orderStatus === "CANCELLED") return "ORDER_CANCELLED";
  if (orderStatus === "PENDING_PAYMENT") return "ORDER_NOT_PAID";
  if (orderStatus !== "COMPLETED") return null;
  const posted = postedAt === null ? Number.NaN : new Date(postedAt).getTime();
  return Number.isFinite(posted) && now < posted + WINDOW_MS ? null : "SEND_WINDOW_CLOSED";
}

/** Why a produced card is not going to be posted. Narrow on purpose: every value is a reviewable fact. */
export type StageCardSkipReason =
  | "ORDER_CANCELLED"
  | "ORDER_NOT_PAID"
  | "ORDER_ENDED"
  | "SEND_WINDOW_CLOSED"
  | "STAGE_SUPERSEDED"
  | "STAGE_NOT_REACHED"
  | "WELCOME_SUPERSEDED";

/**
 * A card only describes the stage it was produced for. Once the order moved on, posting
 * it would rewind the conversation ("请确认开租" after settlement), so it is skipped with an
 * explicit reason instead of being replayed. The reason is written to failure_class, which is
 * what makes a card that never went out visible in the admin read model.
 */
export function stageCardDeliveryBlock(input: {
  kind: StageCardKind;
  orderStatus: string;
  postedAt: Date | string | null;
  hasActivity: boolean;
  now: number;
}): StageCardSkipReason | null {
  if (input.kind === "ORDER_CANCELLED") {
    return input.orderStatus === "CANCELLED" ? null : "STAGE_NOT_REACHED";
  }
  if (input.kind === "ORDER_WELCOME") {
    if (input.orderStatus !== "PAID") return "ORDER_ENDED";
    // Someone already spoke in the group; a late "群已建立" would read as a duplicate greeting.
    return input.hasActivity ? "WELCOME_SUPERSEDED" : null;
  }
  // Terminal intercept: a settled or cancelled order must never receive a pre-terminal stage card.
  if (input.kind !== "ORDER_SETTLED" && input.orderStatus === "COMPLETED") return "STAGE_SUPERSEDED";
  if (input.kind !== "ORDER_SETTLED" && input.orderStatus === "CANCELLED") return "ORDER_CANCELLED";
  if (input.kind === "ORDER_SETTLED" && input.orderStatus !== "COMPLETED") return "STAGE_NOT_REACHED";
  return stageCardWindowReason(input.orderStatus, input.postedAt, input.now);
}

function beijingTime(value: Date | string | null): string {
  if (!value) return "时间暂不可用";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间暂不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date).replaceAll("/", "-");
}

/**
 * The settlement notice is the last message an order group gets. It names the posting time
 * and where the amounts live; it deliberately carries no amount and no party-specific figure,
 * because every member of the group reads the same text.
 */
export function settledNoticeText(postedAt: Date | string | null): string {
  return `【结算完成】本单已完成结算（过账时间 ${beijingTime(postedAt)}）。退款与结算明细请到订单页查看；如有疑问，可直接在本群留言，客服会继续跟进。`;
}

/** Inserts only stages that are currently true; a later tick catches groups that were not READY yet. */
async function materialize(options: OrderStageCardOptions): Promise<void> {
  await options.pool.query(
    `WITH facts AS (
       SELECT g.order_id, g.app_id, o.status AS order_status, latest_opening.status AS opening_status,
              EXISTS(SELECT 1 FROM zzsh_order.settlement_intake si WHERE si.order_id = o.id) AS has_intake,
              posting.posted_at
         FROM zzsh_order.im_order_group g
         JOIN zzsh_order.rental_order o ON o.id = g.order_id
         LEFT JOIN LATERAL (
           SELECT op.status FROM zzsh_order.rental_opening op WHERE op.order_id = o.id
           ORDER BY op.version_no DESC LIMIT 1
         ) latest_opening ON TRUE
         LEFT JOIN LATERAL (
           SELECT p.posted_at FROM zzsh_order.settlement_posting p WHERE p.order_id = o.id
           ORDER BY p.posted_at DESC, p.id DESC LIMIT 1
         ) posting ON TRUE
        WHERE g.app_id = $1 AND g.team_state = 'READY' AND g.team_id IS NOT NULL
          AND (o.status = 'PAID'
            OR (o.status = 'CANCELLED' AND o.cancelled_at > clock_timestamp() - interval '72 hours')
            OR (o.status = 'COMPLETED' AND posting.posted_at > clock_timestamp() - interval '72 hours'))
     ), wanted AS (
       SELECT f.order_id, f.app_id, 'ORDER_WELCOME'::text AS kind FROM facts f
        WHERE f.order_status = 'PAID'
          AND NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_stage_card sc WHERE sc.order_id = f.order_id)
       UNION ALL
       SELECT order_id, app_id, 'ORDER_OPENING'::text AS kind FROM facts WHERE order_status = 'PAID' AND opening_status IN ('DRAFT', 'CONFIRMED')
       UNION ALL
       SELECT order_id, app_id, 'ORDER_ENDING' FROM facts WHERE order_status = 'PAID' AND has_intake
       UNION ALL
       SELECT order_id, app_id, 'ORDER_SETTLED' FROM facts WHERE order_status = 'COMPLETED' AND posted_at IS NOT NULL
       UNION ALL
       SELECT order_id, app_id, 'ORDER_CANCELLED' FROM facts WHERE order_status = 'CANCELLED'
     )
     INSERT INTO zzsh_order.im_order_stage_card (id, order_id, app_id, kind, card_id)
     SELECT 'im_card_' || substr(md5(order_id || ':' || kind), 1, 32), order_id, app_id, kind,
            'im_card_' || substr(md5(order_id || ':' || kind), 1, 32)
       FROM wanted
     ON CONFLICT DO NOTHING`,
    [options.appId],
  );
}

async function dueRows(options: OrderStageCardOptions, limit: number): Promise<DueRow[]> {
  return (await options.pool.query<DueRow>(
    `SELECT sc.id, sc.order_id, sc.kind, sc.card_id, sc.attempt_count,
            g.team_id, o.status AS order_status, posting.posted_at,
            EXISTS(SELECT 1 FROM zzsh_order.im_order_activity act WHERE act.order_id = sc.order_id) AS has_activity,
            m.account_id AS system_account, m.status AS system_status,
            m.identity_marker AS system_marker, m.platform_subject_id AS system_subject
       FROM zzsh_order.im_order_stage_card sc
       JOIN zzsh_order.im_order_group g ON g.order_id = sc.order_id AND g.app_id = sc.app_id
       JOIN zzsh_order.rental_order o ON o.id = sc.order_id
       LEFT JOIN LATERAL (
         SELECT p.posted_at FROM zzsh_order.settlement_posting p WHERE p.order_id = o.id
         ORDER BY p.posted_at DESC, p.id DESC LIMIT 1
       ) posting ON TRUE
       LEFT JOIN zzsh_iam.im_identity_mapping m ON m.id = g.system_identity_id
      WHERE sc.app_id = $1 AND sc.state = 'PENDING' AND sc.next_attempt_at <= clock_timestamp()
        AND ${stageCardSafeSendSql("sc.failure_class")}
        AND g.team_state = 'READY' AND g.team_id IS NOT NULL
      ORDER BY CASE sc.kind WHEN 'ORDER_CANCELLED' THEN 0 WHEN 'ORDER_WELCOME' THEN 1 WHEN 'ORDER_OPENING' THEN 2 WHEN 'ORDER_ENDING' THEN 3 ELSE 4 END, sc.created_at, sc.id
      LIMIT $2`,
    [options.appId, limit],
  )).rows;
}

async function claim(options: OrderStageCardOptions, row: DueRow, tokenHash: string): Promise<boolean> {
  const changed = await options.pool.query(
    `UPDATE zzsh_order.im_order_stage_card
        SET state = 'SENDING', attempt_count = attempt_count + 1,
            lease_until = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
            lease_token_hash = $3, updated_at = clock_timestamp()
      WHERE id = $1 AND app_id = $4 AND state = 'PENDING' AND next_attempt_at <= clock_timestamp()
        AND ${stageCardSafeSendSql("failure_class")}`,
    [row.id, options.leaseMs ?? 30_000, tokenHash, options.appId],
  );
  return changed.rowCount === 1;
}

async function finish(options: OrderStageCardOptions, row: DueRow, tokenHash: string, state: "SENT" | "SKIPPED", reason: string | null): Promise<void> {
  await options.pool.query(
    `UPDATE zzsh_order.im_order_stage_card
        SET state = $3, sent_at = CASE WHEN $3::text = 'SENT' THEN clock_timestamp() ELSE NULL END,
            lease_until = NULL, lease_token_hash = NULL, failure_class = $4, updated_at = clock_timestamp()
      WHERE id = $1 AND app_id = $2 AND state = 'SENDING' AND lease_token_hash = $5`,
    [row.id, options.appId, state, reason, tokenHash],
  );
}

async function retry(options: OrderStageCardOptions, row: DueRow, tokenHash: string, reason: string): Promise<void> {
  await options.pool.query(
    `UPDATE zzsh_order.im_order_stage_card
        SET state = 'PENDING', lease_until = NULL, lease_token_hash = NULL, failure_class = $3,
            next_attempt_at = clock_timestamp() + (CASE WHEN attempt_count >= 3 THEN interval '60 seconds'
              WHEN attempt_count = 2 THEN interval '15 seconds' ELSE interval '5 seconds' END),
            updated_at = clock_timestamp()
      WHERE id = $1 AND app_id = $2 AND state = 'SENDING' AND lease_token_hash = $4`,
    [row.id, options.appId, reason, tokenHash],
  );
}

/** The channel may have accepted the message; only an operator may decide to send again. */
async function unknown(options: OrderStageCardOptions, row: DueRow, tokenHash: string, reason: string): Promise<void> {
  await options.pool.query(
    `UPDATE zzsh_order.im_order_stage_card
        SET state = 'UNKNOWN', lease_until = NULL, lease_token_hash = NULL, failure_class = $3,
            updated_at = clock_timestamp()
      WHERE id = $1 AND app_id = $2 AND state = 'SENDING' AND lease_token_hash = $4`,
    [row.id, options.appId, reason, tokenHash],
  );
}

type DeliveryPreparation =
  | { kind: "SEND"; stageKind: StageCardKind; conversationId: string; systemAccount: string }
  | { kind: "RETRY"; reason: "IDENTITY_PENDING" | "TEXT_TRANSPORT_UNAVAILABLE" | "INVALID_STAGE_KIND" };

/** Everything that can fail before a transport call returns a value; no transport error is inspected. */
function prepareStageCardDelivery(options: OrderStageCardOptions, row: DueRow): DeliveryPreparation {
  if (!isStageKind(row.kind)) return { kind: "RETRY", reason: "INVALID_STAGE_KIND" };
  const systemAccount = systemAccountOf(options.appId, row);
  if (!systemAccount) return { kind: "RETRY", reason: "IDENTITY_PENDING" };
  if (row.kind === "ORDER_WELCOME" && !options.transport.text) return { kind: "RETRY", reason: "TEXT_TRANSPORT_UNAVAILABLE" };
  return { kind: "SEND", stageKind: row.kind, conversationId: `${systemAccount}|2|${row.team_id}`, systemAccount };
}

async function deliver(options: OrderStageCardOptions, row: DueRow, prepared: { stageKind: StageCardKind; conversationId: string; systemAccount: string }): Promise<void> {
  // Retries reuse cardId; a card-capable supplier must key delivery idempotency on it.
  if (prepared.stageKind === "ORDER_WELCOME") {
    await options.transport.text!({ conversationId: prepared.conversationId, senderAccountId: prepared.systemAccount,
      receiverAccountId: row.team_id, text: WELCOME_TEXT, messageClientId: row.card_id });
  } else {
    await options.transport.card({
      conversationId: prepared.conversationId,
      senderAccountId: prepared.systemAccount,
      receiverAccountId: row.team_id,
      card: { kind: prepared.stageKind, orderId: row.order_id, cardId: row.card_id },
      ...(prepared.stageKind === "ORDER_SETTLED" ? { text: settledNoticeText(row.posted_at) } : {}),
    });
  }
  // The message is already out; a failed list projection must not make the sender retry it.
  try { await recordOrderGroupMessage(options.pool, options.appId, prepared.conversationId, PREVIEWS[prepared.stageKind]); } catch { /* next real message refreshes the preview */ }
}

export async function scanOrderStageCards(options: OrderStageCardOptions, limit = 10): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_LIMIT");
  await materialize(options);
  await options.pool.query(
    `UPDATE zzsh_order.im_order_stage_card
        SET state = 'UNKNOWN', lease_until = NULL, lease_token_hash = NULL,
            failure_class = 'LEASE_EXPIRED', updated_at = clock_timestamp()
      WHERE app_id = $1 AND state = 'SENDING' AND lease_until <= clock_timestamp()`,
    [options.appId],
  );
  // Dirty PENDING rows with an unsafe failure reason must be reviewable, never sent.
  await options.pool.query(
    `UPDATE zzsh_order.im_order_stage_card
        SET state = 'UNKNOWN', updated_at = clock_timestamp()
      WHERE app_id = $1 AND state = 'PENDING' AND NOT ${stageCardSafeSendSql("failure_class")}`,
    [options.appId],
  );
  const now = (options.now ?? Date.now)();
  for (const row of await dueRows(options, limit)) {
    const tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    if (!(await claim(options, row, tokenHash))) continue;
    // An unknown kind can never be delivered; recording it as SKIPPED keeps it out of the retry loop.
    if (!isStageKind(row.kind)) {
      await finish(options, row, tokenHash, "SKIPPED", "INVALID_STAGE_KIND");
      continue;
    }
    const blocked = stageCardDeliveryBlock({ kind: row.kind, orderStatus: row.order_status, postedAt: row.posted_at, hasActivity: row.has_activity === true, now });
    if (blocked) {
      await finish(options, row, tokenHash, "SKIPPED", blocked);
      continue;
    }
    const delivery = prepareStageCardDelivery(options, row);
    if (delivery.kind === "RETRY") {
      await retry(options, row, tokenHash, delivery.reason);
      continue;
    }
    try {
      await deliver(options, row, delivery);
    } catch (error) {
      // Any throw from here is a channel call result; it may already be visible.
      await unknown(options, row, tokenHash, failureClass(error));
      continue;
    }
    // The channel accepted the message. A failed SENT write must never cause a
    // blind re-send; it becomes an operator-visible unknown instead.
    try {
      await finish(options, row, tokenHash, "SENT", null);
    } catch {
      await unknown(options, row, tokenHash, "SENT_RECORD_FAILED");
    }
  }
}
