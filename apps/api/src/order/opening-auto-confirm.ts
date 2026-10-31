import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { recordAudit, withTransaction } from "../auth/security-core";

/** Owner-approved 2026-10-31: an unconfirmed opening is auto-confirmed 40 minutes
 * after the DRAFT was recorded. This is deliberately not the older 15-minute draft. */
export const OPENING_AUTO_CONFIRM_MS = 40 * 60 * 1_000;
export const OPENING_AUTO_CONFIRM_ACTION = "order.opening.auto_confirmed";

export type OpeningConfirmParty = "RENTER" | "OWNER";
export type OpeningConfirmMode = "PARTY" | "ON_BEHALF" | "AUTO";

export type OpeningConfirmStep =
  | { kind: "STALE" }
  | { kind: "ALREADY_CONFIRMED" }
  | { kind: "ALREADY_ACKED" }
  | { kind: "ACK"; parties: OpeningConfirmParty[]; completes: boolean };

/** Server-side deadline for one DRAFT opening; null when the timestamp is unusable. */
export function openingAutoConfirmDueAt(createdAt: string | Date): string | null {
  const ms = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Number.isFinite(ms) ? new Date(ms + OPENING_AUTO_CONFIRM_MS).toISOString() : null;
}

/** Boundary is inclusive: exactly 40 minutes after creation is due. */
export function isOpeningAutoConfirmDue(createdAt: string | Date, nowMs: number): boolean {
  const ms = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Number.isFinite(ms) && Number.isFinite(nowMs) && nowMs >= ms + OPENING_AUTO_CONFIRM_MS;
}

/**
 * One rule for party confirmation, CS confirmation on behalf and auto-confirmation.
 * A superseded or stale version never gets new acks; an already confirmed opening is
 * only replayed as a read. AUTO fills every missing party; PARTY/ON_BEHALF fills one.
 */
export function openingConfirmStep(input: {
  status: string;
  openingVersionNo: number;
  requestedVersionNo: number;
  latestVersionNo: number | null;
  acks: readonly string[];
  mode: OpeningConfirmMode;
  party?: OpeningConfirmParty;
}): OpeningConfirmStep {
  if (input.status === "CONFIRMED") return { kind: "ALREADY_CONFIRMED" };
  if (input.status !== "DRAFT"
    || input.openingVersionNo !== input.requestedVersionNo
    || input.openingVersionNo !== Number(input.latestVersionNo)) return { kind: "STALE" };
  const targets: OpeningConfirmParty[] = input.mode === "AUTO"
    ? ["RENTER", "OWNER"]
    : [input.party ?? "RENTER"];
  const missing = targets.filter((party) => !input.acks.includes(party));
  if (!missing.length) return { kind: "ALREADY_ACKED" };
  const merged = new Set([...input.acks, ...missing]);
  return { kind: "ACK", parties: missing, completes: merged.has("RENTER") && merged.has("OWNER") };
}

export type OpeningAutoConfirmOptions = {
  batchLimit: number;
  lockTimeoutMs: number;
  now?: () => number;
  requestId?: () => string;
};

export type OpeningAutoConfirmResult = {
  candidates: number;
  confirmed: string[];
  skipped: string[];
  skippedLocked: string[];
  failed: string[];
};

type DueOpening = { id: string; orderId: string; versionNo: number };

async function dueOpenings(pool: Pool, limit: number): Promise<DueOpening[]> {
  return (await pool.query<DueOpening>(
    `SELECT op.id, op.order_id AS "orderId", op.version_no AS "versionNo"
       FROM zzsh_order.rental_opening op
       JOIN zzsh_order.rental_order o ON o.id = op.order_id
      WHERE op.status = 'DRAFT'
        AND op.auto_confirm_due_at <= clock_timestamp()
        AND op.version_no = (SELECT max(x.version_no) FROM zzsh_order.rental_opening x WHERE x.order_id = op.order_id)
        AND o.status = 'PAID'
        AND NOT EXISTS (SELECT 1 FROM zzsh_order.prestart_termination t
                         WHERE t.order_id = o.id AND t.state <> 'REJECTED')
      ORDER BY op.auto_confirm_due_at, op.id
      LIMIT $1`,
    [limit],
  )).rows;
}

/** Confirms exactly this DRAFT version under the order row lock; a newer version wins. */
async function confirmDueOpening(
  client: PoolClient,
  due: DueOpening,
  requestId: string,
): Promise<"CONFIRMED" | "SKIPPED"> {
  const order = (await client.query<{ status: string; renterUserId: string; ownerUserId: string }>(
    `SELECT status, renter_user_id AS "renterUserId", owner_user_id AS "ownerUserId"
       FROM zzsh_order.rental_order WHERE id = $1 FOR UPDATE`,
    [due.orderId],
  )).rows[0];
  if (!order || order.status !== "PAID") return "SKIPPED";
  const opening = (await client.query<{
    id: string; versionNo: number; status: string; latestVersionNo: number | null;
    due: boolean;
  }>(
    `SELECT op.id, op.version_no AS "versionNo", op.status,
            (SELECT max(x.version_no) FROM zzsh_order.rental_opening x WHERE x.order_id = op.order_id) AS "latestVersionNo",
            op.auto_confirm_due_at <= clock_timestamp() AS "due"
       FROM zzsh_order.rental_opening op
      WHERE op.id = $1 AND op.order_id = $2
      FOR UPDATE`,
    [due.id, due.orderId],
  )).rows[0];
  if (!opening || opening.status !== "DRAFT" || !opening.due) return "SKIPPED";
  const acks = (await client.query<{ party: string }>(
    `SELECT party FROM zzsh_order.rental_opening_ack WHERE opening_id = $1`,
    [opening.id],
  )).rows.map((row) => row.party);
  const step = openingConfirmStep({
    status: opening.status,
    openingVersionNo: opening.versionNo,
    requestedVersionNo: due.versionNo,
    latestVersionNo: opening.latestVersionNo,
    acks,
    mode: "AUTO",
  });
  if (step.kind === "STALE" || step.kind === "ALREADY_CONFIRMED") return "SKIPPED";
  const missing = step.kind === "ACK" ? step.parties : [];
  const userIds: Record<OpeningConfirmParty, string> = {
    RENTER: order.renterUserId,
    OWNER: order.ownerUserId,
  };
  for (const party of missing) {
    await client.query(
      `INSERT INTO zzsh_order.rental_opening_ack (opening_id, party, user_id, version_no, source)
       VALUES ($1, $2, $3, $4, 'AUTO')
       ON CONFLICT (opening_id, party) DO NOTHING`,
      [opening.id, party, userIds[party], opening.versionNo],
    );
  }
  const confirmed = await client.query(
    `UPDATE zzsh_order.rental_opening
        SET status = 'CONFIRMED', confirmed_at = clock_timestamp(), confirm_source = 'AUTO'
      WHERE id = $1 AND status = 'DRAFT' AND version_no = $2
        AND auto_confirm_due_at <= clock_timestamp()`,
    [opening.id, opening.versionNo],
  );
  if (confirmed.rowCount !== 1) return "SKIPPED";
  await recordAudit(client, {
    actorType: "system",
    action: OPENING_AUTO_CONFIRM_ACTION,
    objectType: "rental_order",
    objectId: due.orderId,
    outcome: "SUCCESS",
    requestId,
    details: {
      openingId: opening.id,
      versionNo: opening.versionNo,
      confirmedParties: missing,
      confirmedAtRule: "AUTO_CONFIRM_40_MINUTES",
    },
  });
  return "CONFIRMED";
}

/**
 * One bounded batch. Each order/opening is confirmed in its own transaction with
 * `FOR UPDATE` locks, so concurrent workers or a late party confirmation can only
 * move the same opening forward once. Rows locked by another writer are retried on
 * a later tick; nothing is written for superseded versions or non-PAID orders.
 */
export async function runOpeningAutoConfirmBatch(
  pool: Pool,
  options: OpeningAutoConfirmOptions,
): Promise<OpeningAutoConfirmResult> {
  const candidates = await dueOpenings(pool, options.batchLimit);
  const result: OpeningAutoConfirmResult = { candidates: candidates.length, confirmed: [], skipped: [], skippedLocked: [], failed: [] };
  const nextRequestId = options.requestId ?? (() => `req_auto_${randomUUID().replaceAll("-", "")}`);
  for (const candidate of candidates) {
    try {
      const outcome = await withTransaction(pool, async (client) => {
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${options.lockTimeoutMs}ms`]);
        return confirmDueOpening(client, candidate, nextRequestId());
      });
      if (outcome === "CONFIRMED") result.confirmed.push(candidate.orderId);
      else result.skipped.push(candidate.orderId);
    } catch (error) {
      if ((error as { code?: string }).code === "55P03") result.skippedLocked.push(candidate.orderId);
      else result.failed.push(candidate.orderId);
    }
  }
  return result;
}

export type OpeningAutoConfirmWorkerOptions = OpeningAutoConfirmOptions & {
  intervalMs: number;
  onResult?: (result: OpeningAutoConfirmResult) => void;
  onError?: (error: unknown) => void;
};

/** In-process interval worker; at most one batch per process at a time. */
export class OpeningAutoConfirmWorker {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly options: OpeningAutoConfirmWorkerOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) throw new Error("opening auto-confirm interval must be a positive integer");
    if (!Number.isSafeInteger(options.batchLimit) || options.batchLimit < 1 || options.batchLimit > 100) throw new Error("opening auto-confirm batch must be between 1 and 100");
    if (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs < 1) throw new Error("opening auto-confirm lock timeout must be a positive integer");
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = (async () => {
      try {
        this.options.onResult?.(await runOpeningAutoConfirmBatch(this.pool, this.options));
      } catch (error) {
        this.options.onError?.(error);
      }
    })();
    const clear = () => { this.inFlight = undefined; };
    void this.inFlight.then(clear, clear);
    await this.inFlight;
  }
}
