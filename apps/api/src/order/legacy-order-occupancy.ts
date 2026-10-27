import type { PoolClient } from "pg";
import { conflict } from "../supply/supply-util";

export type OrderOccupancy = "FREE" | "OCCUPIED" | "UNKNOWN";
export type AccountOccupancyFacts = { state: OrderOccupancy; kind: "PENDING_PAYMENT" | "RENTED" | "OCCUPIED" | null; rentalCompleted?: true };

/** Only server-owned SQL references (a.id or $1); never a request value. */
export function accountOccupancySql(accountId: string) {
  const paid = `EXISTS(SELECT 1 FROM zzsh_order.rental_order WHERE account_id=${accountId} AND status='PAID')`;
  const pending = `EXISTS(SELECT 1 FROM zzsh_order.rental_order WHERE account_id=${accountId} AND status='PENDING_PAYMENT')`;
  return {
    occupied: `(${paid} OR ${pending}
      OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot l
        LEFT JOIN zzsh_order.legacy_continuation_version h ON h.order_id=l.id AND h.superseded_at IS NULL
        WHERE l.account_id=${accountId} AND l.source_pay_status=1 AND l.source_order_status IN(3,8,9) AND (h.id IS NULL OR h.stage<>4))
      OR EXISTS(SELECT 1 FROM zzsh_order.legacy_inflight_register r WHERE r.account_id=${accountId} AND r.disposition='ISOLATED_PARTY'))`,
    unknown: `(EXISTS(SELECT 1 FROM zzsh_order.legacy_inflight_register r WHERE r.account_id=${accountId} AND r.disposition IN('REVIEW_REQUIRED','UNKNOWN'))
      OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot l WHERE l.account_id=${accountId}
        AND (l.source_pay_status NOT IN(0,1) OR (l.source_pay_status=1 AND l.source_order_status NOT IN(3,4,5,8,9)))))`,
    paid, pending,
    completed: `EXISTS(SELECT 1 FROM zzsh_order.rental_order WHERE account_id=${accountId} AND status='COMPLETED')`,
  };
}
export function mergeOrderOccupancy(...states: OrderOccupancy[]): OrderOccupancy {
  if (states.includes("OCCUPIED")) return "OCCUPIED";
  return states.includes("UNKNOWN") ? "UNKNOWN" : "FREE";
}

/** Missing schema or query failure is a deployment error, never evidence of FREE. */
export async function readAccountOccupancyFacts(client: PoolClient, accountId: string): Promise<AccountOccupancyFacts> {
  const sql = accountOccupancySql("$1");
  const row = (await client.query<{ state: OrderOccupancy; kind?: string; rentalCompleted?: boolean }>(`SELECT CASE
    WHEN ${sql.occupied} THEN 'OCCUPIED' WHEN ${sql.unknown} THEN 'UNKNOWN' ELSE 'FREE' END AS state,
    CASE WHEN ${sql.paid} THEN 'RENTED' WHEN ${sql.pending} THEN 'PENDING_PAYMENT' ELSE NULL END AS kind,
    ${sql.completed} AS "rentalCompleted"`, [accountId])).rows[0];
  if (!row || !["FREE", "OCCUPIED", "UNKNOWN"].includes(row.state)) throw conflict("OCCUPANCY_UNKNOWN");
  return { state: row.state, kind: row.state !== "OCCUPIED" ? null : row.kind === "RENTED" || row.kind === "PENDING_PAYMENT" ? row.kind : "OCCUPIED", ...(row.rentalCompleted === true ? { rentalCompleted: true } : {}) };
}
export async function readLegacyAwareOrderOccupancy(client: PoolClient, accountId: string): Promise<OrderOccupancy> {
  return (await readAccountOccupancyFacts(client, accountId)).state;
}
