import type { PoolClient } from "pg";
import { conflict } from "../supply/supply-util";

export type OrderOccupancy = "FREE" | "OCCUPIED" | "UNKNOWN";
export type AccountOccupancyFacts = { state: OrderOccupancy; kind: "PENDING_PAYMENT" | "RENTED" | "OCCUPIED" | null };
export function mergeOrderOccupancy(...states: OrderOccupancy[]): OrderOccupancy {
  if (states.includes("OCCUPIED")) return "OCCUPIED";
  return states.includes("UNKNOWN") ? "UNKNOWN" : "FREE";
}

/** Missing schema or query failure is a deployment error, never evidence of FREE. */
export async function readAccountOccupancyFacts(client: PoolClient, accountId: string): Promise<AccountOccupancyFacts> {
  const row = (await client.query<{ state: OrderOccupancy; kind?: string }>(`SELECT CASE
    WHEN EXISTS(SELECT 1 FROM zzsh_order.rental_order WHERE account_id=$1 AND status IN ('PENDING_PAYMENT','PAID'))
      OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot l
        LEFT JOIN zzsh_order.legacy_continuation_version h ON h.order_id=l.id AND h.superseded_at IS NULL
        WHERE l.account_id=$1 AND l.source_pay_status=1 AND l.source_order_status IN(3,8,9) AND (h.id IS NULL OR h.stage<>4))
      OR EXISTS(SELECT 1 FROM zzsh_order.legacy_inflight_register r WHERE r.account_id=$1 AND r.disposition='ISOLATED_PARTY') THEN 'OCCUPIED'
    WHEN EXISTS(SELECT 1 FROM zzsh_order.legacy_inflight_register r WHERE r.account_id=$1 AND r.disposition IN('REVIEW_REQUIRED','UNKNOWN'))
      OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot l WHERE l.account_id=$1
        AND (l.source_pay_status NOT IN(0,1) OR (l.source_pay_status=1 AND l.source_order_status NOT IN(3,4,5,8,9)))) THEN 'UNKNOWN'
    ELSE 'FREE' END AS state,
    CASE WHEN EXISTS(SELECT 1 FROM zzsh_order.rental_order WHERE account_id=$1 AND status='PAID') THEN 'RENTED'
     WHEN EXISTS(SELECT 1 FROM zzsh_order.rental_order WHERE account_id=$1 AND status='PENDING_PAYMENT') THEN 'PENDING_PAYMENT'
     ELSE NULL END AS kind`, [accountId])).rows[0];
  if (!row || !["FREE", "OCCUPIED", "UNKNOWN"].includes(row.state)) throw conflict("OCCUPANCY_UNKNOWN");
  return { state: row.state, kind: row.state !== "OCCUPIED" ? null : row.kind === "RENTED" || row.kind === "PENDING_PAYMENT" ? row.kind : "OCCUPIED" };
}
export async function readLegacyAwareOrderOccupancy(client: PoolClient, accountId: string): Promise<OrderOccupancy> {
  return (await readAccountOccupancyFacts(client, accountId)).state;
}
