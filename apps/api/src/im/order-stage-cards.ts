import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey } from "./identity-lifecycle";
import type { ImTransportCard, ImTransportMessage } from "./im-contract";

/**
 * O-01 stage cards. A card is an ordinary chat message; the order facts stay in
 * the role-projected read path and the payload only carries kind/orderId/cardId.
 * This worker turns committed order facts into at most one message per stage.
 */
export type StageCardTransport = {
  card(input: { conversationId: string; senderAccountId: string; receiverAccountId: string; card: ImTransportCard }): Promise<ImTransportMessage>;
};

export type OrderStageCardOptions = {
  pool: Pool;
  appId: string;
  transport: StageCardTransport;
  now?: () => number;
  leaseMs?: number;
};

const STAGE_KINDS = ["ORDER_OPENING", "ORDER_ENDING", "ORDER_SETTLED"] as const;
type StageCardKind = (typeof STAGE_KINDS)[number];

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
  system_account: string | null;
  system_status: string | null;
  system_marker: string | null;
  system_subject: string | null;
};

function isStageKind(value: string): value is StageCardKind {
  return (STAGE_KINDS as readonly string[]).includes(value);
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function systemAccountOf(appId: string, row: DueRow): string {
  const expected: ImIdentityKey = { provider: "yunxin", appId, realm: "system", kind: "SYSTEM", platformSubjectId: SYSTEM_SUBJECT };
  if (!row.system_account || row.system_status !== "READY" || row.system_subject !== SYSTEM_SUBJECT
    || row.system_account !== deriveYunxinAccountId(expected) || row.system_marker !== buildYunxinIdentityMarker(expected)) {
    throw codedError("IDENTITY_PENDING");
  }
  return row.system_account;
}

function failureClass(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "SEND_FAILED";
}

/** Card sends never outlive the order's terminal chat window. */
export function stageCardWindowReason(orderStatus: string, postedAt: Date | string | null, now: number): string | null {
  if (orderStatus === "CANCELLED") return "ORDER_CANCELLED";
  if (orderStatus === "PENDING_PAYMENT") return "ORDER_NOT_PAID";
  if (orderStatus !== "COMPLETED") return null;
  const posted = postedAt === null ? Number.NaN : new Date(postedAt).getTime();
  return Number.isFinite(posted) && now < posted + WINDOW_MS ? null : "SEND_WINDOW_CLOSED";
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
            OR (o.status = 'COMPLETED' AND posting.posted_at > clock_timestamp() - interval '72 hours'))
     ), wanted AS (
       SELECT order_id, app_id, 'ORDER_OPENING'::text AS kind FROM facts WHERE opening_status = 'CONFIRMED'
       UNION ALL
       SELECT order_id, app_id, 'ORDER_ENDING' FROM facts WHERE has_intake
       UNION ALL
       SELECT order_id, app_id, 'ORDER_SETTLED' FROM facts WHERE order_status = 'COMPLETED' AND posted_at IS NOT NULL
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
        AND g.team_state = 'READY' AND g.team_id IS NOT NULL
      ORDER BY CASE sc.kind WHEN 'ORDER_OPENING' THEN 1 WHEN 'ORDER_ENDING' THEN 2 ELSE 3 END, sc.created_at, sc.id
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
      WHERE id = $1 AND app_id = $4 AND state = 'PENDING' AND next_attempt_at <= clock_timestamp()`,
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

async function deliver(options: OrderStageCardOptions, row: DueRow): Promise<void> {
  if (!isStageKind(row.kind)) throw codedError("INVALID_STAGE_KIND");
  const systemAccount = systemAccountOf(options.appId, row);
  // Retries reuse cardId; a card-capable supplier must key delivery idempotency on it.
  await options.transport.card({
    conversationId: `${systemAccount}|2|${row.team_id}`,
    senderAccountId: systemAccount,
    receiverAccountId: row.team_id,
    card: { kind: row.kind, orderId: row.order_id, cardId: row.card_id },
  });
}

export async function scanOrderStageCards(options: OrderStageCardOptions, limit = 10): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_LIMIT");
  await materialize(options);
  await options.pool.query(
    `UPDATE zzsh_order.im_order_stage_card
        SET state = 'PENDING', lease_until = NULL, lease_token_hash = NULL,
            failure_class = 'LEASE_EXPIRED', updated_at = clock_timestamp()
      WHERE app_id = $1 AND state = 'SENDING' AND lease_until <= clock_timestamp()`,
    [options.appId],
  );
  const now = (options.now ?? Date.now)();
  for (const row of await dueRows(options, limit)) {
    const tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    if (!(await claim(options, row, tokenHash))) continue;
    const closed = stageCardWindowReason(row.order_status, row.posted_at, now);
    if (closed) {
      await finish(options, row, tokenHash, "SKIPPED", closed);
      continue;
    }
    try {
      await deliver(options, row);
      await finish(options, row, tokenHash, "SENT", null);
    } catch (error) {
      await retry(options, row, tokenHash, failureClass(error));
    }
  }
}
