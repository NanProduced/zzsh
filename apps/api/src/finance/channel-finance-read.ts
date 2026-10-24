import type { PoolClient } from 'pg';
import { SecurityApiError } from '../auth/security-core';
import { exactCents } from './finance-money';
import { readJoinpayAccountSummary } from './joinpay-account-store';

/** Explicit server grants; neither a finance permission nor a URL supplies merchant scope. */
export type JoinpayAccountReadAccess = Readonly<{
  database: string;
  runtimeUser: string;
  merchantIdsByAdmin: ReadonlyMap<string, ReadonlySet<string>>;
}>;

export async function readAdminJoinpayMerchantAccounts(c: PoolClient, input: { adminId: string; merchantIdentityId: string }, access?: JoinpayAccountReadAccess) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.merchantIdentityId)) throw new SecurityApiError(400, 'INVALID_ARGUMENT', 'Invalid merchant identity');
  if (!access) throw new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', 'Merchant account read scope is not configured');
  if (!access.merchantIdsByAdmin.get(input.adminId)?.has(input.merchantIdentityId)) throw new SecurityApiError(404, 'NOT_FOUND', 'Merchant account not found');
  const resource = (await c.query('SELECT current_database() AS database,current_user AS runtime_user')).rows[0];
  if (resource?.database !== access.database || resource.runtime_user !== access.runtimeUser) throw new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', 'Merchant account resource differs');
  const available = await readJoinpayAccountSummary(c, input.merchantIdentityId, 'AVAILABLE');
  const collection = await readJoinpayAccountSummary(c, input.merchantIdentityId, 'COLLECTION');
  if (!access.merchantIdsByAdmin.get(input.adminId)?.has(input.merchantIdentityId)) throw new SecurityApiError(409, 'CONFLICT', 'Merchant read access changed');
  return { contractVersion: 'admin-joinpay-accounts.read.v1', merchantIdentityId: input.merchantIdentityId,
    available, collection, aggregateAssets: null, channelAsOf: null, bankArrival: 'UNKNOWN' as const };
}

/** Caller has already selected this exact order under order/game/object authorization. */
export async function readAdminOrderRefundSummary(c: PoolClient, input: { orderId: string; origin: 'NATIVE' | 'LEGACY'; financeReadable: boolean }) {
  const absent = (integration: 'FORBIDDEN' | 'NOT_APPLICABLE' | 'NOT_INTEGRATED' | 'UNAVAILABLE', reason: string) => ({
    contractVersion: 'admin-order-refund-summary.v1' as const, integration, intents: null, bankArrival: 'UNKNOWN' as const, reasonCodes: [reason],
  });
  if (!input.financeReadable) return absent('FORBIDDEN', 'FINANCE_PERMISSION_REQUIRED');
  if (input.origin !== 'NATIVE') return absent('NOT_APPLICABLE', 'LEGACY_REFUND_SOURCE_NOT_INTEGRATED');
  const ready = (await c.query(`SELECT to_regclass('zzsh_order.channel_refund_intent') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_refund_attempt') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_refund_observation') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_refund_evidence') IS NOT NULL
    AND (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.channel_refund_intent')
      AND attname=ANY($1::text[]) AND attnum>0 AND NOT attisdropped)=$2 AS ready`,
    [['id','refund_order_no','amount_cents','currency','state','budget_disposition','requires_review','terminal_evidence_id','terminal_root_id','terminal_event_id','posting_id','order_id','payment_source','renter_user_id','payment_confirmation_id','responsibility_version_hash'],16])).rows[0];
  if (ready?.ready !== true) return absent('NOT_INTEGRATED', 'FORMAL_REFUND_SCHEMA_UNAVAILABLE');
  const rows = (await c.query(`SELECT i.id,i.refund_order_no,i.amount_cents::text AS amount_cents,i.currency,i.state,i.budget_disposition,
    i.requires_review,i.terminal_evidence_id,i.terminal_root_id,i.terminal_event_id,
    (i.renter_user_id=o.renter_user_id AND p.order_id=i.order_id AND p.payment_confirmation_id=i.payment_confirmation_id
      AND p.version_hash=i.responsibility_version_hash) AS binding_matches
    FROM zzsh_order.channel_refund_intent i
    LEFT JOIN zzsh_order.settlement_posting p ON p.id=i.posting_id
    LEFT JOIN zzsh_order.rental_order o ON o.id=i.order_id
    WHERE i.order_id=$1 AND i.payment_source='JOINPAY' ORDER BY i.id COLLATE "C" LIMIT 65`, [input.orderId])).rows;
  if (rows.length > 64 || rows.some(r => r.binding_matches !== true)) return absent('UNAVAILABLE', 'REFUND_BINDING_OR_READ_BOUND_EXCEEDED');
  try {
    const intents = rows.map(r => {
      const amountCents = exactCents(r.amount_cents);
      if (BigInt(amountCents) <= 0n || r.currency !== 'CNY' || typeof r.requires_review !== 'boolean'
        || typeof r.id !== 'string' || typeof r.refund_order_no !== 'string'
        || [r.terminal_evidence_id,r.terminal_root_id,r.terminal_event_id].some(v=>v!==null&&typeof v!=='string')) throw new Error('Invalid refund projection');
      return { intentId: r.id as string, refundOrderNo: r.refund_order_no as string, amount: { cents: amountCents, currency: 'CNY' as const },
        localState: ['READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED'].includes(r.state) ? r.state as string : 'UNKNOWN',
        budgetDisposition: ['ALLOCATED','CONSUMED','RELEASED'].includes(r.budget_disposition) ? r.budget_disposition as string : 'UNKNOWN',
        requiresReview: r.requires_review as boolean, evidenceId: r.terminal_evidence_id ?? null, rootId: r.terminal_root_id ?? null,
        eventId: r.terminal_event_id ?? null, mayResubmit: false, bankArrival: 'UNKNOWN' as const };
    });
    return { contractVersion: 'admin-order-refund-summary.v1' as const, integration: 'INTEGRATED' as const, intents,
      bankArrival: 'UNKNOWN' as const, reasonCodes: ['LOCAL_RECORDS_ONLY_TERMINAL_EVIDENCE_NOT_REVALIDATED'] };
  } catch { return absent('UNAVAILABLE', 'REFUND_RECORD_PROJECTION_INVALID'); }
}
