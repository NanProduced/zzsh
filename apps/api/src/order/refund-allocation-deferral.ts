import type { Pool } from "pg";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";

export class RefundAllocationNeedsReview extends SecurityApiError {
  constructor(readonly reviewReason: string) { super(503, "EVIDENCE_UNAVAILABLE", "Original refund basis requires review"); }
}

/** A known per-order refusal may be deferred; unknown commits and infrastructure errors must stop. */
export function isRefundAllocationRefusal(error: unknown): error is SecurityApiError {
  return error instanceof RefundAllocationNeedsReview || error instanceof SecurityApiError && error.status === 409 && [
    "Original payment refund requires review",
    "Refund allocation exceeds original payment or frozen responsibility",
    "Original full refund is allocated or requires review",
    "Original prestart refund key has different facts",
    "Native refund original revision unavailable",
  ].includes(error.message);
}

export function refundAllocationReason(error: SecurityApiError): string {
  return error instanceof RefundAllocationNeedsReview ? error.reviewReason : error.message;
}

export async function deferRefundAllocation(
  pool: Pool,
  resource: { database: string; runtimeUser: string },
  objectType: "settlement_posting" | "prestart_termination" | "support_poststart_cancellation",
  objectId: string,
  reason: string,
): Promise<void> {
  await withTransaction(pool, async client => {
    const identity = (await client.query("SELECT current_database() AS db,current_user AS actor")).rows[0];
    if (identity?.db !== resource.database || identity?.actor !== resource.runtimeUser) throw new Error("REFUND_ALLOCATION_RESOURCE_MISMATCH");
    await recordAudit(client, { actorType: "system", action: "order.refund.allocation.deferred", objectType, objectId,
      outcome: "FAILURE", requestId: objectId, reason, details: { channelResult: "NOT_SUBMITTED" } });
  });
}
