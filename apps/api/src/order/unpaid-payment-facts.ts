import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";

export type UnpaidPaymentFacts = { hasPayment: boolean; hasRequest: boolean; hasTransaction: boolean; hasGroup: boolean };

/** Reused only with the server-owned rental_order alias `o`. */
export const UNPAID_PAYMENT_FACT_COLUMNS = `
  EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.order_id=o.id) AS "hasPayment",
  EXISTS(SELECT 1 FROM zzsh_order.payment_request r WHERE r.order_id=o.id) AS "hasRequest",
  EXISTS(SELECT 1 FROM zzsh_order.payment_channel_transaction t WHERE t.native_order_id=o.id) AS "hasTransaction",
  EXISTS(SELECT 1 FROM zzsh_order.im_order_group g WHERE g.order_id=o.id) AS "hasGroup"`;

export function hasUnpaidPaymentEvidence(facts: UnpaidPaymentFacts): boolean {
  const values = [facts.hasPayment, facts.hasRequest, facts.hasTransaction, facts.hasGroup];
  if (!values.every(value => typeof value === "boolean")) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Payment facts are unavailable");
  return values.some(Boolean);
}

/** After waiting for an order lock, only READ COMMITTED supplies a fresh evidence snapshot. */
export async function requireFreshPaymentSnapshot(client: PoolClient): Promise<void> {
  const row = (await client.query("SHOW transaction_isolation")).rows[0];
  if (row?.transaction_isolation !== "read committed")
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Payment recheck requires read committed isolation");
}
