import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { assertActiveInTransaction } from "../auth/user-identity";
import { normalizeQuote } from "../supply/content-hash";
import {
  evaluatePublication,
  type ListingVersion,
  type PublishingAccount,
  type SupplyGateReader,
} from "../supply/publishing";
import { projectDeltaQuote, type InternalQuote, type QuoteAmount } from "../supply/pricing";
import { conflict, forbidden, invalid, notFound, sha256Hex } from "../supply/supply-util";

export const ORDER_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PAID: "PAID",
  CANCELLED: "CANCELLED",
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export type OrderUserContext = { userId: string; sessionId: string };

export type OrderRow = {
  id: string;
  displayNo: string;
  accountId: string;
  versionId: string;
  ownerUserId: string;
  renterUserId: string;
  gameId: string;
  releaseId: string;
  contentHash: string;
  termOptionCode: string;
  status: OrderStatus;
  rentalAmountCents: string;
  depositAmountCents: string;
  currency: string;
  termSeconds: string;
  quoteSnapshot: InternalQuote & { contentHash?: string };
  title: string;
  holdUntil: string;
  paidAt: string | null;
  cancelReason: "USER" | "TIMEOUT" | null;
  cancelledAt: string | null;
  createdAt: string;
  revision: string;
  expiredAwaitingCancel: boolean;
  ownerName: string;
  renterName: string;
};

const ORDER_FIELDS = `
  o.id, o.display_no AS "displayNo", o.account_id AS "accountId", o.listing_version_id AS "versionId",
  o.owner_user_id AS "ownerUserId", o.renter_user_id AS "renterUserId", o.game_id AS "gameId",
  o.rule_release_id AS "releaseId", o.content_hash AS "contentHash", o.term_option_code AS "termOptionCode",
  o.status, o.rental_amount_cents::text AS "rentalAmountCents", o.deposit_amount_cents::text AS "depositAmountCents",
  o.currency, o.term_seconds::text AS "termSeconds", o.quote_snapshot AS "quoteSnapshot", o.title,
  to_char(o.hold_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "holdUntil",
  to_char(o.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "paidAt",
  o.cancel_reason AS "cancelReason",
  CASE WHEN o.cancelled_at IS NULL THEN NULL ELSE to_char(o.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "cancelledAt",
  to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  o.revision::text AS "revision",
  (o.status = 'PENDING_PAYMENT' AND o.hold_until <= clock_timestamp()) AS "expiredAwaitingCancel",
  owner_u.name AS "ownerName", renter_u.name AS "renterName"`;
const ORDER_FROM = `FROM zzsh_order.rental_order o
  JOIN zzsh_auth_user."user" owner_u ON owner_u.id = o.owner_user_id
  JOIN zzsh_auth_user."user" renter_u ON renter_u.id = o.renter_user_id`;

const YUAN_PATTERN = /^(0|[1-9]\d*)\.(\d{2})$/;

export function yuanToCents(amount: QuoteAmount | null | undefined, label: string): bigint {
  if (!amount || amount.currency !== "CNY" || amount.unit !== "yuan" || amount.scale !== 2) {
    throw invalid(`${label} is invalid`);
  }
  const match = YUAN_PATTERN.exec(amount.amount);
  if (!match) throw invalid(`${label} is invalid`);
  return BigInt(match[1]!) * 100n + BigInt(match[2]!);
}

export function centsToYuan(cents: string | bigint): QuoteAmount {
  const value = typeof cents === "bigint" ? cents : BigInt(cents);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return {
    currency: "CNY",
    unit: "yuan",
    amount: `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`,
    scale: 2,
  };
}

function orderConflict(code: "OCCUPIED" | "RULE_CHANGED" | "VERSION_CHANGED" | "DEPOSIT_UNCONFIGURED", message: string): SecurityApiError {
  return new SecurityApiError(409, API_V1_ERROR_CODES[code], message);
}

export type OrderParty = "renter" | "owner" | "admin";

export function projectOrder(
  row: OrderRow,
  party: OrderParty,
  options?: { internalQuote?: boolean },
): Record<string, unknown> {
  const expired = row.expiredAwaitingCancel === true;
  const amounts = {
    rental: centsToYuan(row.rentalAmountCents),
    deposit: centsToYuan(row.depositAmountCents),
    totalDue: centsToYuan(BigInt(row.rentalAmountCents) + BigInt(row.depositAmountCents)),
    currency: "CNY",
  };
  const base = {
    id: row.id,
    displayNo: row.displayNo,
    status: row.status,
    accountId: row.accountId,
    versionId: row.versionId,
    title: row.title,
    termOptionCode: row.termOptionCode,
    termSeconds: row.termSeconds,
    amounts,
    createdAt: row.createdAt,
    holdUntil: row.holdUntil,
    expiredAwaitingCancel: expired,
    paymentOpen: row.status === ORDER_STATUS.PENDING_PAYMENT && !expired,
    cancelOpen: row.status === ORDER_STATUS.PENDING_PAYMENT,
    ...(row.status === ORDER_STATUS.PAID ? { paidAt: row.paidAt } : {}),
    ...(row.status === ORDER_STATUS.CANCELLED
      ? { cancelReason: row.cancelReason, cancelledAt: row.cancelledAt }
      : {}),
  };
  if (party === "renter") {
    return { ...base, quote: projectDeltaQuote(row.quoteSnapshot as InternalQuote, "public") };
  }
  if (party === "owner") {
    return {
      ...base,
      renterName: row.renterName,
      quote: projectDeltaQuote(row.quoteSnapshot as InternalQuote, "owner"),
    };
  }
  return {
    ...base,
    ownerUserId: row.ownerUserId,
    renterUserId: row.renterUserId,
    ownerName: row.ownerName,
    renterName: row.renterName,
    gameId: row.gameId,
    releaseId: row.releaseId,
    contentHash: row.contentHash,
    revision: row.revision,
    quote: projectDeltaQuote(row.quoteSnapshot as InternalQuote, options?.internalQuote ? "admin" : "owner"),
  };
}

/**
 * Lock both parties' user rows with one explicitly ordered statement: PostgreSQL
 * takes the row locks in the ORDER BY order, so the lock sequence is guaranteed
 * by SQL rather than by an assumed JS-side sort. Part of the global lock order
 * user(asc) -> game -> account -> version -> order.
 */
export async function lockOrderPartiesInOrder(
  client: PoolClient,
  renterUserId: string,
  ownerUserId: string,
): Promise<void> {
  const rows = (
    await client.query(
      `SELECT id FROM zzsh_auth_user."user" WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [[renterUserId, ownerUserId]],
    )
  ).rows;
  if (rows.length !== 2) throw notFound();
}

/**
 * Authorization for a FIRST-TIME order creation (never for replays): resolves the
 * account owner, locks both user rows in ascending id order, then re-checks
 * activity, session and fresh trade eligibility on the locked rows.
 */
export async function assertFreshCreateAuthorization(
  client: PoolClient,
  context: OrderUserContext,
  accountId: string,
): Promise<{ ownerUserId: string; gameId: string }> {
  const account = (
    await client.query<{ ownerUserId: string; gameId: string }>(
      `SELECT owner_user_id AS "ownerUserId", game_id AS "gameId" FROM zzsh_supply.rental_account WHERE id = $1`,
      [accountId],
    )
  ).rows[0];
  if (!account) throw notFound();
  if (account.ownerUserId === context.userId) throw forbidden();
  await lockOrderPartiesInOrder(client, context.userId, account.ownerUserId);
  const states = (
    await client.query<{
      id: string;
      suspended: boolean;
      accountStatus: string;
      identityStatus: string | null;
      ageStatus: string | null;
    }>(
      `SELECT u.id, u.suspended, COALESCE(s.account_status, 'ACTIVE') AS "accountStatus",
              s.identity_status AS "identityStatus", s.age_status AS "ageStatus"
         FROM zzsh_auth_user."user" u
         LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id
        WHERE u.id = ANY($1::text[])`,
      [[context.userId, account.ownerUserId]],
    )
  ).rows;
  const renter = states.find((row) => row.id === context.userId);
  if (!renter || renter.suspended || renter.accountStatus !== "ACTIVE") {
    throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
  }
  const session = await client.query(
    `SELECT 1 FROM zzsh_auth_user."session" WHERE "id" = $1 AND "userId" = $2 AND "expiresAt" > clock_timestamp()`,
    [context.sessionId, context.userId],
  );
  if (!session.rowCount) {
    throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
  }
  if (renter.identityStatus !== "VERIFIED" || renter.ageStatus !== "ADULT") {
    throw forbidden("请先完成实名校验后再进行受保护交易");
  }
  return { ownerUserId: account.ownerUserId, gameId: account.gameId };
}

/** Authorization for idempotent replays: current session and activity only. */
export async function assertReplayAuthorization(
  client: PoolClient,
  context: OrderUserContext,
): Promise<void> {
  await assertActiveInTransaction(client, context.userId);
  const session = await client.query(
    `SELECT 1 FROM zzsh_auth_user."session" WHERE "id" = $1 AND "userId" = $2 AND "expiresAt" > clock_timestamp()`,
    [context.sessionId, context.userId],
  );
  if (!session.rowCount) {
    throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
  }
}

export type CreateReservationInput = {
  context: OrderUserContext;
  accountId: string;
  versionId: string;
  releaseId: string;
  ownerUserId: string;
  gameId: string;
  /** Explicit hold seconds; creation refuses to run when missing or invalid. */
  holdSeconds?: number;
  gate: SupplyGateReader;
  requestId: string;
};

export async function createReservation(
  client: PoolClient,
  input: CreateReservationInput,
): Promise<{ status: number; body: unknown }> {
  // Fresh-execution-only gate: idempotent replays return before reaching here and
  // must survive the hold configuration being removed after the original create.
  if (!Number.isSafeInteger(input.holdSeconds) || (input.holdSeconds as number) <= 0) {
    throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Order hold is not configured");
  }
  // Global lock order: both users (already locked by the authorize step) -> game -> account -> order.
  const game = (
    await client.query<{ id: string; enabled: boolean; currentReleaseId: string | null }>(
      `SELECT id, enabled, current_release_id AS "currentReleaseId" FROM zzsh_supply.game WHERE id = $1 FOR UPDATE`,
      [input.gameId],
    )
  ).rows[0];
  if (!game) throw notFound();
  const account = (
    await client.query<PublishingAccount>(
      `SELECT * FROM zzsh_supply.rental_account WHERE id = $1 FOR UPDATE`,
      [input.accountId],
    )
  ).rows[0];
  if (!account) throw notFound();
  if (account.owner_user_id !== input.ownerUserId || account.game_id !== input.gameId) {
    throw conflict("Supply state changed; reload and retry");
  }
  const version = (
    await client.query<ListingVersion>(
      `SELECT * FROM zzsh_supply.listing_version WHERE id = $1 AND account_id = $2`,
      [account.current_version_id, account.id],
    )
  ).rows[0];
  if (!version || version.id !== input.versionId) {
    throw orderConflict("VERSION_CHANGED", "资料已变化，请刷新后重新确认");
  }
  if (
    !version.rule_release_id ||
    version.rule_release_id !== input.releaseId ||
    game.currentReleaseId !== version.rule_release_id
  ) {
    throw orderConflict("RULE_CHANGED", "规则已更新，请刷新后重新确认");
  }
  if (!game.enabled) throw notFound();
  const blockers = await evaluatePublication(client, account, version, input.gate);
  if (blockers.includes("OCCUPIED")) {
    throw orderConflict("OCCUPIED", "账号当前已被占用");
  }
  // Any other blocker (including OCCUPANCY_UNKNOWN / PUBLISHER_BAIL_UNCONFIRMED)
  // fails closed as "not publicly orderable" without claiming an occupancy fact.
  if (blockers.length > 0) throw notFound();
  if (!version.payload) throw notFound();
  const quote = normalizeQuote(version.payload.quoteValues);
  if (quote.pricingInputs.depositPolicy !== "CONFIGURED" || !quote.tenantDeposit) {
    throw orderConflict("DEPOSIT_UNCONFIGURED", "押金规则未配置，暂不能创建可付款订单");
  }
  const rentalCents = yuanToCents(quote.resourceTotal, "rental amount");
  const depositCents = yuanToCents(quote.tenantDeposit, "deposit amount");
  const orderId = `order_${randomUUID().replaceAll("-", "")}`;
  const snapshot = { ...quote, contentHash: version.content_hash };
  const inserted = await client.query(
    `INSERT INTO zzsh_order.rental_order (
       id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id,
       rule_release_id, content_hash, term_option_code, status,
       rental_amount_cents, deposit_amount_cents, currency, term_seconds,
       quote_snapshot, title, hold_until
     ) VALUES (
       $1,
       zzsh_order.next_display_no(),
       $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_PAYMENT',
       $10, $11, 'CNY', $12, $13::jsonb, $14,
       clock_timestamp() + make_interval(secs => $15)
     ) RETURNING id`,
    [
      orderId,
      input.accountId,
      version.id,
      account.owner_user_id,
      input.context.userId,
      account.game_id,
      version.rule_release_id,
      version.content_hash,
      version.term_option_code,
      rentalCents.toString(),
      depositCents.toString(),
      quote.termSeconds,
      JSON.stringify(snapshot),
      version.title,
      input.holdSeconds,
    ],
  );
  if (inserted.rowCount !== 1) throw conflict("Request conflicts with current state");
  const row = (
    await client.query<OrderRow>(`SELECT ${ORDER_FIELDS} ${ORDER_FROM} WHERE o.id = $1`, [orderId])
  ).rows[0]!;
  await recordAudit(client, {
    actorType: "user",
    actorId: input.context.userId,
    sessionId: input.context.sessionId,
    action: "order.reservation.created",
    objectType: "rental_order",
    objectId: orderId,
    outcome: "SUCCESS",
    reason: "order.reservation.create",
    requestId: input.requestId,
    details: {
      before: null,
      after: {
        orderId,
        displayNo: row.displayNo,
        accountId: row.accountId,
        versionId: row.versionId,
        releaseId: row.releaseId,
        status: row.status,
        rentalAmountCents: row.rentalAmountCents,
        depositAmountCents: row.depositAmountCents,
        holdUntil: row.holdUntil,
      },
      result: "CREATED",
    },
  });
  return { status: 200, body: { order: projectOrder(row, "renter") } };
}

export type CancelReservationInput = {
  context: OrderUserContext;
  orderId: string;
  reason?: string;
  requestId: string;
};

export async function cancelReservation(
  client: PoolClient,
  input: CancelReservationInput,
): Promise<{ status: number; body: unknown }> {
  const found = (
    await client.query<{ accountId: string; renterUserId: string; status: string }>(
      `SELECT account_id AS "accountId", renter_user_id AS "renterUserId", status FROM zzsh_order.rental_order WHERE id = $1`,
      [input.orderId],
    )
  ).rows[0];
  if (!found || found.renterUserId !== input.context.userId) throw notFound();
  // Lock order: renter user (authorize step) -> account -> order.
  await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id = $1 FOR UPDATE`, [
    found.accountId,
  ]);
  const locked = (
    await client.query<{ status: string }>(
      `SELECT status FROM zzsh_order.rental_order WHERE id = $1 FOR UPDATE`,
      [input.orderId],
    )
  ).rows[0]!;
  if (locked.status !== ORDER_STATUS.PENDING_PAYMENT) {
    throw conflict("订单已不是待支付状态");
  }
  const updated = await client.query(
    `UPDATE zzsh_order.rental_order
        SET status = 'CANCELLED', cancel_reason = 'USER', cancelled_at = clock_timestamp(),
            updated_at = clock_timestamp(), revision = revision + 1
      WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
    [input.orderId],
  );
  if (updated.rowCount !== 1) throw conflict("订单已不是待支付状态");
  const row = (
    await client.query<OrderRow>(`SELECT ${ORDER_FIELDS} ${ORDER_FROM} WHERE o.id = $1`, [
      input.orderId,
    ])
  ).rows[0]!;
  await recordAudit(client, {
    actorType: "user",
    actorId: input.context.userId,
    sessionId: input.context.sessionId,
    action: "order.reservation.cancelled",
    objectType: "rental_order",
    objectId: input.orderId,
    outcome: "SUCCESS",
    reason: "USER",
    requestId: input.requestId,
    details: {
      before: { status: "PENDING_PAYMENT" },
      after: { status: "CANCELLED", cancelReason: "USER" },
      ...(input.reason ? { userReason: input.reason } : {}),
      result: "CANCELLED",
    },
  });
  return { status: 200, body: { order: projectOrder(row, "renter") } };
}

export async function getMyOrder(
  client: PoolClient,
  userId: string,
  orderId: string,
): Promise<Record<string, unknown>> {
  const row = (
    await client.query<OrderRow>(`SELECT ${ORDER_FIELDS} ${ORDER_FROM} WHERE o.id = $1`, [orderId])
  ).rows[0];
  if (!row) throw notFound();
  if (row.renterUserId === userId) return { order: projectOrder(row, "renter") };
  if (row.ownerUserId === userId) return { order: projectOrder(row, "owner") };
  throw notFound();
}

export type MyOrdersFilter = {
  party: "renter" | "owner";
  status?: OrderStatus;
  accountId?: string;
  limit: number;
  cursor?: string;
};

const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function parseOrderCursor(
  cursor: string | undefined,
  filterKey: string,
): { createdAt: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      f?: unknown;
      c?: unknown;
      i?: unknown;
    };
    if (
      parsed.f !== filterKey ||
      typeof parsed.c !== "string" ||
      !CURSOR_TIME_PATTERN.test(parsed.c) ||
      typeof parsed.i !== "string" ||
      !CURSOR_ID_PATTERN.test(parsed.i)
    ) {
      throw new Error("mismatch");
    }
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    throw conflict("Cursor is invalid");
  }
}

function encodeOrderCursor(filterKey: string, row: OrderRow): string {
  return Buffer.from(JSON.stringify({ f: filterKey, c: row.createdAt, i: row.id })).toString(
    "base64url",
  );
}

export async function listMyOrders(
  client: PoolClient,
  userId: string,
  filter: MyOrdersFilter,
): Promise<Record<string, unknown>> {
  const filterKey = sha256Hex(
    JSON.stringify({
      scope: "my-orders",
      party: filter.party,
      principal: userId,
      status: filter.status ?? null,
      accountId: filter.accountId ?? null,
      limit: filter.limit,
    }),
  );
  const cursor = parseOrderCursor(filter.cursor, filterKey);
  const rows = (
    await client.query<OrderRow>(
      `SELECT ${ORDER_FIELDS} ${ORDER_FROM}
        WHERE ${filter.party === "renter" ? "o.renter_user_id" : "o.owner_user_id"} = $1
          AND ($2::text IS NULL OR o.status = $2)
          AND ($3::text IS NULL OR o.account_id = $3)
          AND ($4::timestamptz IS NULL OR o.created_at < $4 OR (o.created_at = $4 AND o.id < $5))
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $6`,
      [
        userId,
        filter.status ?? null,
        filter.accountId ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        filter.limit + 1,
      ],
    )
  ).rows;
  const items = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  return {
    items: items.map((row) => projectOrder(row, filter.party)),
    nextCursor: hasMore ? encodeOrderCursor(filterKey, items[items.length - 1]!) : null,
    limit: filter.limit,
  };
}

export type AdminOrdersFilter = {
  status?: OrderStatus;
  accountId?: string;
  gameId?: string;
  limit: number;
  cursor?: string;
};

export async function listAdminOrders(
  client: PoolClient,
  admin: { adminId: string; isBoss: boolean; internalQuote: boolean },
  filter: AdminOrdersFilter,
): Promise<Record<string, unknown>> {
  const filterKey = sha256Hex(
    JSON.stringify({
      scope: "admin-orders",
      principal: admin.adminId,
      status: filter.status ?? null,
      accountId: filter.accountId ?? null,
      gameId: filter.gameId ?? null,
      limit: filter.limit,
    }),
  );
  const cursor = parseOrderCursor(filter.cursor, filterKey);
  const rows = (
    await client.query<OrderRow>(
      `SELECT ${ORDER_FIELDS} ${ORDER_FROM}
        WHERE ($1::boolean OR EXISTS (
            SELECT 1 FROM zzsh_supply.admin_supply_scope s
             WHERE s.admin_user_id = $2 AND s.game_id = o.game_id))
          AND ($3::text IS NULL OR o.status = $3)
          AND ($4::text IS NULL OR o.account_id = $4)
          AND ($5::text IS NULL OR o.game_id = $5)
          AND ($6::timestamptz IS NULL OR o.created_at < $6 OR (o.created_at = $6 AND o.id < $7))
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $8`,
      [
        admin.isBoss,
        admin.adminId,
        filter.status ?? null,
        filter.accountId ?? null,
        filter.gameId ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        filter.limit + 1,
      ],
    )
  ).rows;
  const items = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  return {
    items: items.map((row) => projectOrder(row, "admin", { internalQuote: admin.internalQuote })),
    nextCursor: hasMore ? encodeOrderCursor(filterKey, items[items.length - 1]!) : null,
    limit: filter.limit,
  };
}

export async function getAdminOrder(
  client: PoolClient,
  admin: { adminId: string; isBoss: boolean; internalQuote: boolean },
  orderId: string,
  assertScope: (client: PoolClient, adminId: string, isBoss: boolean, gameId: string) => Promise<void>,
): Promise<Record<string, unknown>> {
  const row = (
    await client.query<OrderRow>(`SELECT ${ORDER_FIELDS} ${ORDER_FROM} WHERE o.id = $1`, [orderId])
  ).rows[0];
  if (!row) throw notFound();
  await assertScope(client, admin.adminId, admin.isBoss, row.gameId);
  return { order: projectOrder(row, "admin", { internalQuote: admin.internalQuote }) };
}

/** Real occupancy seam for the supply gate: an occupying order wins over the base reader. */
export async function readOrderOccupancy(client: PoolClient, accountId: string): Promise<boolean> {
  return (
    ((await client.query(
      `SELECT 1 FROM zzsh_order.rental_order WHERE account_id = $1 AND status IN ('PENDING_PAYMENT','PAID') LIMIT 1`,
      [accountId],
    )).rowCount ?? 0) > 0
  );
}

export function composeSupplyGateWithOrderOccupancy(base: SupplyGateReader): SupplyGateReader {
  return async (client, account) => {
    const gate = await base(client, account);
    // Occupancy truth is order-derived only: no occupying order means FREE.
    // The publisher-bail seam stays independent (UNKNOWN fails closed until M5).
    const occupied = await readOrderOccupancy(client, account.id);
    return { ...gate, occupancy: occupied ? "OCCUPIED" : "FREE" };
  };
}

/** Caller holds account then order (or performs the order CAS here). */
export async function cancelExpiredReservation(client: PoolClient, orderId: string, holdUntil: string, requestId: string): Promise<boolean> {
  const updated = await client.query(
    `UPDATE zzsh_order.rental_order
        SET status = 'CANCELLED', cancel_reason = 'TIMEOUT', cancelled_at = clock_timestamp(),
            updated_at = clock_timestamp(), revision = revision + 1
      WHERE id = $1 AND status = 'PENDING_PAYMENT' AND hold_until = $2::timestamptz`,
    [orderId, holdUntil],
  );
  if (updated.rowCount !== 1) return false;
  await recordAudit(client, {
    actorType: "system",
    action: "order.reservation.cancelled",
    objectType: "rental_order",
    objectId: orderId,
    outcome: "SUCCESS",
    reason: "TIMEOUT",
    requestId,
    details: {
      before: { status: "PENDING_PAYMENT" },
      after: { status: "CANCELLED", cancelReason: "TIMEOUT" },
      result: "CANCELLED",
    },
  });
  return true;
}

export type SweepOptions = {
  asOf?: Date;
  batchLimit: number;
  lockTimeoutMs: number;
  /** Candidate scan window per run; locked rows never consume the batch budget. */
  scanLimit?: number;
  /** Keyset position from the previous run (process-local); null/absent scans from the start. */
  after?: { holdUntil: string; id: string } | null;
};

export type SweepResult = {
  candidates: number;
  cancelled: string[];
  skippedChanged: string[];
  skippedLocked: string[];
  failed: string[];
  /** Resume position for the next run; null means the tail was reached and the next run wraps to the start (retrying previously skipped rows). */
  nextCursor: { holdUntil: string; id: string } | null;
};

/**
 * Cancel expired pending holds in bounded, fairly advancing batches. Each run
 * scans at most scanLimit candidates in (hold_until, id) keyset order starting
 * after the caller-supplied position. Only successful cancels consume the batch
 * budget: rows whose lock cannot be taken within lockTimeoutMs and row-level
 * failures are skipped without pushing later candidates out of the run. The
 * returned position advances past the last attempted row when the budget ended
 * the run early or the scan window was full; it resets to the start (wrap) only
 * once the tail was reached and everything in it was attempted, so previously
 * skipped rows are retried. The position is process-local; a restart simply
 * rescans from the start.
 * hold_until round-trips as a microsecond-precision text value: pg's default
 * Date mapping loses microseconds and would make the CAS predicate never match.
 */
export async function sweepExpiredHolds(pool: Pool, options: SweepOptions): Promise<SweepResult> {
  const scanLimit = options.scanLimit ?? Math.max(options.batchLimit * 4, options.batchLimit + 10);
  const candidates = (
    await pool.query<{ id: string; account_id: string; hold_until_text: string }>(
      `SELECT id, account_id,
              to_char(hold_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS hold_until_text
         FROM zzsh_order.rental_order
        WHERE status = 'PENDING_PAYMENT' AND hold_until <= COALESCE($1::timestamptz, clock_timestamp())
          AND ($3::timestamptz IS NULL OR (hold_until, id) > ($3::timestamptz, $4::text))
        ORDER BY hold_until, id
        LIMIT $2`,
      [options.asOf ?? null, scanLimit, options.after?.holdUntil ?? null, options.after?.id ?? ""],
    )
  ).rows;
  const result: SweepResult = {
    candidates: candidates.length,
    cancelled: [],
    skippedChanged: [],
    skippedLocked: [],
    failed: [],
    nextCursor: null,
  };
  let lastAttempted: { holdUntil: string; id: string } | null = null;
  let budgetExhausted = false;
  for (const candidate of candidates) {
    // Only successful cancels consume the batch budget: lock waits and
    // row-level failures must not push later candidates out of this run.
    if (result.cancelled.length >= options.batchLimit) {
      budgetExhausted = true;
      break;
    }
    try {
      const changed = await withTransaction(pool, async (client) => {
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
          `${options.lockTimeoutMs}ms`,
        ]);
        // Lock order: account -> order; the CAS predicate pins the exact hold we read.
        await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id = $1 FOR UPDATE`, [
          candidate.account_id,
        ]);
        return cancelExpiredReservation(client, candidate.id, candidate.hold_until_text, `req_sweep_${randomUUID().replaceAll("-", "")}`);
      });
      if (changed) result.cancelled.push(candidate.id);
      else result.skippedChanged.push(candidate.id);
    } catch (error) {
      if ((error as { code?: string }).code === "55P03") result.skippedLocked.push(candidate.id);
      else result.failed.push(candidate.id);
    }
    lastAttempted = { holdUntil: candidate.hold_until_text, id: candidate.id };
  }
  // Position semantics: keep scanning after the last attempted row when the
  // budget ended the run early or the window was full (more may exist beyond
  // it). Wrap to the start only when the tail was reached and everything in it
  // was attempted, so previously skipped rows are retried.
  if (lastAttempted && (budgetExhausted || candidates.length >= scanLimit)) {
    result.nextCursor = lastAttempted;
  }
  return result;
}

export type OrderSweepWorkerOptions = {
  intervalMs: number;
  batchLimit: number;
  lockTimeoutMs: number;
  scanLimit?: number;
  sweep?: (pool: Pool, options: SweepOptions) => Promise<SweepResult>;
  onResult?: (result: SweepResult) => void;
  onError?: (error: unknown) => void;
};

/**
 * In-process interval worker for expired holds. At most one batch runs per
 * process at a time; stop() clears the timer and awaits the in-flight batch.
 */
export class OrderSweepWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  /** Keyset scan position carried across batches (process-local). */
  private cursor: { holdUntil: string; id: string } | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly options: OrderSweepWorkerOptions,
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.inFlight = (async () => {
      try {
        const sweep = this.options.sweep ?? sweepExpiredHolds;
        const outcome = await sweep(this.pool, {
          batchLimit: this.options.batchLimit,
          lockTimeoutMs: this.options.lockTimeoutMs,
          ...(this.options.scanLimit !== undefined ? { scanLimit: this.options.scanLimit } : {}),
          after: this.cursor,
        });
        this.cursor = outcome.nextCursor;
        // Row-level failures must stay observable; they never throw the batch.
        this.options.onResult?.(outcome);
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.running = false;
      }
    })();
    await this.inFlight;
  }
}
