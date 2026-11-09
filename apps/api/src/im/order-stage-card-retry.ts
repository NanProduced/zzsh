/** Failures that are proven to happen before the transport call, so a retry cannot duplicate a message. */
export const STAGE_CARD_PRE_SEND_FAILURES = ["IDENTITY_PENDING", "TEXT_TRANSPORT_UNAVAILABLE"] as const;

export function stageCardSafeSendSql(column: string): string {
  return `(${column} IS NULL OR ${column} IN (${STAGE_CARD_PRE_SEND_FAILURES.map((code) => `'${code}'`).join(",")}))`;
}
