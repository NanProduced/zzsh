import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey } from "./identity-lifecycle";
import type { ImTransportMessage } from "./im-contract";

/**
 * O-02 rental due reminders. Five fixed buckets per order, one system text
 * message each; the order/settlement facts remain the stop condition.
 */
export type DueReminderTransport = {
  sendText(input: { conversationId: string; senderAccountId: string; receiverAccountId: string; text: string; messageClientId?: string }): Promise<ImTransportMessage>;
};

export type OrderDueReminderOptions = {
  pool: Pool;
  appId: string;
  transport: DueReminderTransport;
  leaseMs?: number;
};

const BUCKETS = ["BEFORE_24H", "DUE", "AFTER_1D", "AFTER_2D", "AFTER_3D"] as const;
export type DueReminderBucket = (typeof BUCKETS)[number];
const HOUR = 60 * 60 * 1_000;
const SYSTEM_SUBJECT = "support-manager";

type DueRow = {
  id: string;
  order_id: string;
  bucket: string;
  team_id: string;
  order_status: string;
  due_at: Date | string | null;
  ended_intake: boolean;
  ended_settlement: boolean;
  ended_posting: boolean;
  system_account: string | null;
  system_status: string | null;
  system_marker: string | null;
  system_subject: string | null;
};

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function failureClass(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "SEND_FAILED";
}

/** The current bucket only; a worker that missed earlier buckets sends the latest one. */
export function dueReminderBucket(dueAt: Date | string | null | undefined, now: number): DueReminderBucket | null {
  const due = dueAt === null || dueAt === undefined ? Number.NaN : new Date(dueAt).getTime();
  if (!Number.isFinite(due)) return null;
  if (now < due - 24 * HOUR) return null;
  if (now < due) return "BEFORE_24H";
  if (now < due + 24 * HOUR) return "DUE";
  if (now < due + 48 * HOUR) return "AFTER_1D";
  if (now < due + 72 * HOUR) return "AFTER_2D";
  if (now < due + 96 * HOUR) return "AFTER_3D";
  return null;
}

function beijingTime(value: Date | string | null): string {
  if (!value) return "时间暂不可用";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间暂不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date).replaceAll("/", "-");
}

export function dueReminderText(bucket: DueReminderBucket, dueAt: Date | string | null): string {
  const at = beijingTime(dueAt);
  switch (bucket) {
    case "BEFORE_24H": return `本单将于 24 小时内到期（到期时间 ${at}）。如需结束，请在订单页发起结束或联系客服。`;
    case "DUE": return `本单已到期（到期时间 ${at}）。订单仍在进行中，请发起结束或联系客服。`;
    case "AFTER_1D": return `本单已到期 1 天（到期时间 ${at}），订单仍在进行中。请尽快发起结束或联系客服。`;
    case "AFTER_2D": return `本单已到期 2 天（到期时间 ${at}），订单仍在进行中。请尽快发起结束或联系客服。`;
    case "AFTER_3D": return `本单已到期 3 天（到期时间 ${at}），订单仍在进行中。请尽快发起结束或联系客服。`;
  }
}

function isBucket(value: string): value is DueReminderBucket {
  return (BUCKETS as readonly string[]).includes(value);
}

function systemAccountOf(appId: string, row: DueRow): string {
  const expected: ImIdentityKey = { provider: "yunxin", appId, realm: "system", kind: "SYSTEM", platformSubjectId: SYSTEM_SUBJECT };
  if (!row.system_account || row.system_status !== "READY" || row.system_subject !== SYSTEM_SUBJECT
    || row.system_account !== deriveYunxinAccountId(expected) || row.system_marker !== buildYunxinIdentityMarker(expected)) {
    throw codedError("IDENTITY_PENDING");
  }
  return row.system_account;
}

async function materialize(options: OrderDueReminderOptions): Promise<void> {
  await options.pool.query(
    `WITH facts AS (
       SELECT g.order_id, g.app_id,
              opening.confirmed_at + (o.term_seconds * interval '1 second') AS due_at
         FROM zzsh_order.im_order_group g
         JOIN zzsh_order.rental_order o ON o.id = g.order_id
         JOIN LATERAL (
           SELECT op.confirmed_at FROM zzsh_order.rental_opening op
            WHERE op.order_id = o.id AND op.status = 'CONFIRMED' AND op.confirmed_at IS NOT NULL
            ORDER BY op.version_no DESC LIMIT 1
         ) opening ON TRUE
        WHERE g.app_id = $1 AND g.team_state = 'READY' AND g.team_id IS NOT NULL
          AND o.status = 'PAID' AND o.term_seconds > 0
          AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_intake si WHERE si.order_id = o.id)
          AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_version sv WHERE sv.order_id = o.id)
          AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting sp WHERE sp.order_id = o.id)
     ), wanted AS (
       SELECT order_id, app_id, CASE
         WHEN clock_timestamp() < due_at - interval '24 hours' THEN NULL
         WHEN clock_timestamp() < due_at THEN 'BEFORE_24H'
         WHEN clock_timestamp() < due_at + interval '24 hours' THEN 'DUE'
         WHEN clock_timestamp() < due_at + interval '48 hours' THEN 'AFTER_1D'
         WHEN clock_timestamp() < due_at + interval '72 hours' THEN 'AFTER_2D'
         WHEN clock_timestamp() < due_at + interval '96 hours' THEN 'AFTER_3D'
         ELSE NULL END AS bucket
       FROM facts
     )
     INSERT INTO zzsh_order.im_order_due_reminder (id, order_id, app_id, bucket)
     SELECT 'im_due_' || substr(md5(order_id || ':' || bucket), 1, 32), order_id, app_id, bucket
       FROM wanted WHERE bucket IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [options.appId],
  );
}

async function dueRows(options: OrderDueReminderOptions, limit: number): Promise<DueRow[]> {
  return (await options.pool.query<DueRow>(
    `SELECT r.id, r.order_id, r.bucket, g.team_id, o.status AS order_status,
            opening.confirmed_at + (o.term_seconds * interval '1 second') AS due_at,
            EXISTS(SELECT 1 FROM zzsh_order.settlement_intake si WHERE si.order_id = o.id) AS ended_intake,
            EXISTS(SELECT 1 FROM zzsh_order.settlement_version sv WHERE sv.order_id = o.id) AS ended_settlement,
            EXISTS(SELECT 1 FROM zzsh_order.settlement_posting sp WHERE sp.order_id = o.id) AS ended_posting,
            m.account_id AS system_account, m.status AS system_status,
            m.identity_marker AS system_marker, m.platform_subject_id AS system_subject
       FROM zzsh_order.im_order_due_reminder r
       JOIN zzsh_order.im_order_group g ON g.order_id = r.order_id AND g.app_id = r.app_id
       JOIN zzsh_order.rental_order o ON o.id = r.order_id
       LEFT JOIN LATERAL (
         SELECT op.confirmed_at FROM zzsh_order.rental_opening op
          WHERE op.order_id = o.id AND op.status = 'CONFIRMED' AND op.confirmed_at IS NOT NULL
          ORDER BY op.version_no DESC LIMIT 1
       ) opening ON TRUE
       LEFT JOIN zzsh_iam.im_identity_mapping m ON m.id = g.system_identity_id
      WHERE r.app_id = $1 AND r.state = 'PENDING' AND r.next_attempt_at <= clock_timestamp()
        AND g.team_state = 'READY' AND g.team_id IS NOT NULL
      ORDER BY r.created_at, r.id
      LIMIT $2`,
    [options.appId, limit],
  )).rows;
}

async function claim(options: OrderDueReminderOptions, row: DueRow, tokenHash: string): Promise<boolean> {
  const changed = await options.pool.query(
    `UPDATE zzsh_order.im_order_due_reminder
        SET state = 'SENDING', attempt_count = attempt_count + 1,
            lease_until = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
            lease_token_hash = $3, updated_at = clock_timestamp()
      WHERE id = $1 AND app_id = $4 AND state = 'PENDING' AND next_attempt_at <= clock_timestamp()`,
    [row.id, options.leaseMs ?? 30_000, tokenHash, options.appId],
  );
  return changed.rowCount === 1;
}

async function finish(options: OrderDueReminderOptions, row: DueRow, tokenHash: string, state: "SENT" | "SKIPPED", reason: string | null): Promise<void> {
  await options.pool.query(
    `UPDATE zzsh_order.im_order_due_reminder
        SET state = $3, sent_at = CASE WHEN $3::text = 'SENT' THEN clock_timestamp() ELSE NULL END,
            lease_until = NULL, lease_token_hash = NULL, failure_class = $4, updated_at = clock_timestamp()
      WHERE id = $1 AND app_id = $2 AND state = 'SENDING' AND lease_token_hash = $5`,
    [row.id, options.appId, state, reason, tokenHash],
  );
}

async function retry(options: OrderDueReminderOptions, row: DueRow, tokenHash: string, reason: string): Promise<void> {
  await options.pool.query(
    `UPDATE zzsh_order.im_order_due_reminder
        SET state = 'PENDING', lease_until = NULL, lease_token_hash = NULL, failure_class = $3,
            next_attempt_at = clock_timestamp() + (CASE WHEN attempt_count >= 3 THEN interval '60 seconds'
              WHEN attempt_count = 2 THEN interval '15 seconds' ELSE interval '5 seconds' END),
            updated_at = clock_timestamp()
      WHERE id = $1 AND app_id = $2 AND state = 'SENDING' AND lease_token_hash = $4`,
    [row.id, options.appId, reason, tokenHash],
  );
}

async function deliver(options: OrderDueReminderOptions, row: DueRow): Promise<void> {
  if (!isBucket(row.bucket)) throw codedError("INVALID_BUCKET");
  if (row.order_status !== "PAID" || row.ended_intake || row.ended_settlement || row.ended_posting) throw codedError("ORDER_ENDED");
  if (!row.due_at) throw codedError("DUE_UNKNOWN");
  const systemAccount = systemAccountOf(options.appId, row);
  await options.transport.sendText({
    conversationId: `${systemAccount}|2|${row.team_id}`,
    senderAccountId: systemAccount,
    receiverAccountId: row.team_id,
    text: dueReminderText(row.bucket, row.due_at),
    messageClientId: row.id,
  });
}

export async function scanOrderDueReminders(options: OrderDueReminderOptions, limit = 10): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_LIMIT");
  await materialize(options);
  await options.pool.query(
    `UPDATE zzsh_order.im_order_due_reminder
        SET state = 'PENDING', lease_until = NULL, lease_token_hash = NULL,
            failure_class = 'LEASE_EXPIRED', updated_at = clock_timestamp()
      WHERE app_id = $1 AND state = 'SENDING' AND lease_until <= clock_timestamp()`,
    [options.appId],
  );
  for (const row of await dueRows(options, limit)) {
    const tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    if (!(await claim(options, row, tokenHash))) continue;
    if (row.order_status !== "PAID" || row.ended_intake || row.ended_settlement || row.ended_posting) {
      await finish(options, row, tokenHash, "SKIPPED", "ORDER_ENDED");
      continue;
    }
    try {
      await deliver(options, row);
      await finish(options, row, tokenHash, "SENT", null);
    } catch (error) {
      const code = failureClass(error);
      if (code === "ORDER_ENDED" || code === "DUE_UNKNOWN") await finish(options, row, tokenHash, "SKIPPED", code);
      else await retry(options, row, tokenHash, code);
    }
  }
}
