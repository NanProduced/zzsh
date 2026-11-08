import type { OrderFinanceTransaction } from './admin-finance-api';

export type OrderRefundSummary = {
  contractVersion: string;
  integration: string;
  coverageScope?: 'JOINPAY_ONLY' | null;
  coverage?: 'COMPLETE_WITHIN_LIMIT' | 'TRUNCATED' | null;
  truncated?: boolean;
  intents: Array<{ intentId: string; refundOrderNo: string; amount: { cents: string; currency: string }; localState: string;
    budgetDisposition: string; requiresReview: boolean; bankArrival: 'UNKNOWN' }> | null;
  bankArrival: 'UNKNOWN';
};

export type OrderRefundRow = {
  key: string;
  number: string;
  documentRef: string | null;
  amountCents: string | null;
  source: 'LEGACY_MYSQL' | 'JOINPAY' | 'CONTROLLED' | 'UNKNOWN';
  state: string;
  occurredAt: string | null;
  requiresReview: boolean;
  budgetDisposition: string | null;
  conflict: boolean;
  original: OrderFinanceTransaction | null;
};

/** Match only the same local refund intent, never an amount or a historical order number. */
export function mergeOrderRefunds(observed: readonly OrderFinanceTransaction[], summary: OrderRefundSummary | null | undefined): OrderRefundRow[] {
  const rows: OrderRefundRow[] = [];
  const byRef = new Map<string, OrderRefundRow>();
  const validCents = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,23})$/.test(value);
  for (const item of observed) {
    const source = item.source === 'LEGACY_MYSQL' ? 'LEGACY_MYSQL' : item.paymentSource ?? 'UNKNOWN';
    const existing = byRef.get(item.documentRef);
    if (existing) { existing.conflict = true; existing.amountCents = null; continue; }
    const row: OrderRefundRow = { key: item.documentRef, number: item.number, documentRef: item.documentRef,
      amountCents: validCents(item.amountCents) ? item.amountCents : null, source, state: item.state, occurredAt: item.occurredAt,
      requiresReview: false, budgetDisposition: null, conflict: false, original: item };
    rows.push(row); byRef.set(item.documentRef, row);
  }
  if (summary?.integration !== 'INTEGRATED' || !summary.intents) return rows;
  const seen = new Set<string>();
  for (const item of summary.intents) {
    const ref = `REFUND_INTENT:${item.intentId}`;
    const existing = byRef.get(ref);
    if (existing) {
      if (seen.has(ref) || item.amount.currency !== 'CNY' || !validCents(item.amount.cents) || existing.amountCents !== item.amount.cents || (existing.number && item.refundOrderNo && existing.number !== item.refundOrderNo) || existing.source === 'CONTROLLED' || existing.source === 'LEGACY_MYSQL') {
        existing.conflict = true; existing.amountCents = null;
      } else {
        existing.source = 'JOINPAY'; existing.requiresReview = item.requiresReview; existing.budgetDisposition = item.budgetDisposition;
        if (existing.state !== item.localState) existing.state = 'STATE_CHANGED';
      }
    } else {
      const row: OrderRefundRow = { key: ref, number: item.refundOrderNo, documentRef: ref, amountCents: item.amount.currency === 'CNY' && validCents(item.amount.cents) ? item.amount.cents : null,
        source: 'JOINPAY', state: item.localState, occurredAt: null, requiresReview: item.requiresReview, budgetDisposition: item.budgetDisposition,
        conflict: item.amount.currency !== 'CNY' || !validCents(item.amount.cents) || seen.has(ref), original: null };
      rows.push(row); byRef.set(ref, row);
    }
    seen.add(ref);
  }
  return rows;
}

export function refundSummaryScope(summary: OrderRefundSummary | null | undefined): string {
  if (!summary) return '退款摘要未读取';
  if (summary.integration === 'FORBIDDEN') return '当前身份无权查看退款摘要';
  if (summary.integration !== 'INTEGRATED') return '退款摘要暂不可用';
  if (summary.truncated || summary.coverage === 'TRUNCATED') return '退款记录未读全，请核对原单';
  return '汇聚退款摘要仅覆盖汇聚来源；其他来源按其原记录展示';
}
