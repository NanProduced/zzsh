import type { PoolClient } from 'pg';
import { SecurityApiError } from '../auth/security-core';
import { exactCents } from './finance-money';
import { readJoinpayAccountSummary } from './joinpay-account-store';
import { readPrestartFinanceProjection } from '../order/prestart-termination';
import type { PrestartPaymentBasis } from '../order/prestart-termination';
import { readPrestartRefundProgress } from '../order/prestart-refund-store';

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

/** Only an intact cancellation bound to the original formal payment is a refund basis. */
async function readSupportCancellationFinanceProjection(c:PoolClient,orderId:string) {
  const rows=(await c.query(`SELECT s.id,s.order_id,s.owner_user_id,s.renter_user_id,s.payment_confirmation_id,
    s.refund_cents::text,s.source_digest,s.root_id,s.event_id,p.source,p.disposition,p.currency,
    p.merchant_scope_id,p.merchant_order_no,p.provider_transaction_id,
    zzsh_order.support_poststart_cancellation_complete(s.id) AS complete
    FROM zzsh_order.support_poststart_cancellation s
    LEFT JOIN zzsh_order.payment_confirmation p ON p.id=s.payment_confirmation_id AND p.order_id=s.order_id
    WHERE s.order_id=$1 LIMIT 2`,[orderId])).rows;
  if(!rows.length)return null;
  if(rows.length!==1||rows[0].complete!==true)throw new Error('Cancellation basis unavailable');
  const row=rows[0];
  if(row.source==='CONTROLLED')return null;
  if(row.source!=='JOINPAY'||row.disposition!=='APPLIED'||row.currency!=='CNY'
    ||![row.id,row.order_id,row.owner_user_id,row.renter_user_id,row.payment_confirmation_id,row.merchant_scope_id,row.merchant_order_no,row.provider_transaction_id]
      .every(value=>typeof value==='string'&&value.length>0)
    ||typeof row.source_digest!=='string'||!/^[a-f0-9]{64}$/.test(row.source_digest))throw new Error('Cancellation payment unavailable');
  const basis:PrestartPaymentBasis={orderId:row.order_id,renterUserId:row.renter_user_id,ownerUserId:row.owner_user_id,
    paymentConfirmationId:row.payment_confirmation_id,source:'JOINPAY',merchantIdentityId:row.merchant_scope_id,
    merchantOrderNo:row.merchant_order_no,channelTrxNo:row.provider_transaction_id,amountCents:exactCents(row.refund_cents),currency:'CNY',digest:row.source_digest};
  return {cancellationId:row.id,paymentConfirmationId:basis.paymentConfirmationId,merchantIdentityId:basis.merchantIdentityId,
    originalCents:basis.amountCents,liabilityRootId:row.root_id as string,liabilityEventId:row.event_id as string,
    refund:await readPrestartRefundProgress(c,row.id,basis,true,undefined,undefined,'SUPPORT_CANCELLATION')};
}

/** Caller has already selected this exact order under order/game/object authorization. */
export async function readAdminOrderRefundSummary(c: PoolClient, input: { orderId: string; origin: 'NATIVE' | 'LEGACY'; financeReadable: boolean }) {
  const absent = (integration: 'FORBIDDEN' | 'NOT_APPLICABLE' | 'NOT_INTEGRATED' | 'UNAVAILABLE', reason: string) => ({
    contractVersion: 'admin-order-refund-summary.v1' as const, integration, intents: null,
    bankArrival: 'UNKNOWN' as const, reasonCodes: [reason], limit: null as number | null, truncated: false, maySubmit: false as const,
    coverage: null as 'COMPLETE_WITHIN_LIMIT' | 'TRUNCATED' | null,
    coverageScope: null as 'JOINPAY_ONLY' | null,
    budget: null as { allocatedCents: string; consumedCents: string; releasedCents: string } | null,
    responsibilityBudget: null as null | { originalCents: string | null; allocatedCents: string | null; consumedCents: string | null;
      releasedCents: string | null; remainingCents: string | null; totalsComplete: boolean; postingOriginalCents: string | null },
  });
  if (!input.financeReadable) return absent('FORBIDDEN', 'FINANCE_PERMISSION_REQUIRED');
  if (input.origin !== 'NATIVE') return absent('NOT_APPLICABLE', 'LEGACY_REFUND_SOURCE_NOT_INTEGRATED');
  const ready = (await c.query(`SELECT to_regclass('zzsh_order.prestart_termination') IS NOT NULL
    AND has_table_privilege(current_user,to_regclass('zzsh_order.prestart_termination'),'SELECT') AS has_prestart,
    to_regclass('zzsh_order.support_poststart_cancellation') IS NOT NULL
    AND COALESCE(has_table_privilege(current_user,to_regclass('zzsh_order.support_poststart_cancellation'),'SELECT'),false)
    AND COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.support_poststart_cancellation_complete(text)'),'EXECUTE'),false) AS has_support_cancel,
    to_regclass('zzsh_order.channel_refund_intent') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_refund_attempt') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_refund_observation') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_refund_evidence') IS NOT NULL
    AND (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.channel_refund_intent')
      AND attname=ANY($1::text[]) AND attnum>0 AND NOT attisdropped)=$2 AS ready`,
    [['id','refund_order_no','amount_cents','currency','state','budget_disposition','requires_review','terminal_evidence_id','terminal_root_id','terminal_event_id','posting_id','order_id','payment_source','renter_user_id','payment_confirmation_id','responsibility_version_hash','basis_kind','liability_root_id','liability_event_id','original_payment_trx_no','original_payment_order_no','merchant_identity_id','created_at','updated_at'],24])).rows[0];
  if (ready?.ready !== true) return absent('NOT_INTEGRATED', 'FORMAL_REFUND_SCHEMA_UNAVAILABLE');
  if (ready.has_support_cancel === false) {
    const order=(await c.query(`SELECT cancel_reason FROM zzsh_order.rental_order WHERE id=$1`,[input.orderId])).rows[0];
    if(order?.cancel_reason==='SUPPORT_AFTER_START_CANCELLED')return absent('NOT_INTEGRATED','SUPPORT_CANCEL_REFUND_SCHEMA_UNAVAILABLE');
  }
  const rows = (await c.query(`SELECT i.id,i.refund_order_no,i.amount_cents::text AS amount_cents,i.currency,i.state,i.budget_disposition,
    i.requires_review,i.terminal_evidence_id,i.terminal_root_id,i.terminal_event_id,i.merchant_identity_id,i.payment_source,i.provider_refund_trx_no,
    i.basis_kind,i.payment_confirmation_id,i.liability_root_id,i.liability_event_id,
    p.renter_refund_cents::text AS responsibility_cents,
    (i.renter_user_id=o.renter_user_id AND p.order_id=i.order_id AND p.payment_confirmation_id=i.payment_confirmation_id
      AND p.version_hash=i.responsibility_version_hash) AS binding_matches
    FROM zzsh_order.channel_refund_intent i
    LEFT JOIN zzsh_order.settlement_posting p ON p.id=i.posting_id
    LEFT JOIN zzsh_order.rental_order o ON o.id=i.order_id
    WHERE i.order_id=$1 AND i.payment_source='JOINPAY' AND i.basis_kind='POSTING' AND i.posting_id IS NOT NULL
    ORDER BY i.id COLLATE "C" LIMIT 65`, [input.orderId])).rows;
  if (rows.length > 64) return { ...absent('UNAVAILABLE', 'REFUND_BINDING_OR_READ_BOUND_EXCEEDED'), limit: 64, truncated: true, coverage: 'TRUNCATED' as const };
  if (rows.some(r => r.binding_matches !== true)) return absent('UNAVAILABLE', 'REFUND_BINDING_OR_READ_BOUND_EXCEEDED');
  try {
    const postingRows = (await c.query<{ renter_refund_cents: string | null; currency: string }>(`SELECT p.renter_refund_cents::text AS renter_refund_cents,p.currency
    FROM zzsh_order.settlement_posting p WHERE p.order_id=$1 ORDER BY p.posted_at DESC,p.id COLLATE "C" DESC LIMIT 2`, [input.orderId])).rows;
  if (postingRows.length > 1) return absent('UNAVAILABLE', 'MULTIPLE_SETTLEMENT_POSTINGS');
  if (postingRows.some(row => row.currency !== 'CNY')) return absent('UNAVAILABLE', 'RESPONSIBILITY_CURRENCY_NOT_CNY');
  const normalIntents = rows.map(r => {
      const amountCents = exactCents(r.amount_cents);
      if (BigInt(amountCents) <= 0n || r.currency !== 'CNY' || typeof r.requires_review !== 'boolean'
        || typeof r.id !== 'string' || typeof r.refund_order_no !== 'string'
        || [r.terminal_evidence_id,r.terminal_root_id,r.terminal_event_id].some(v=>v!==null&&typeof v!=='string')) throw new Error('Invalid refund projection');
      const responsibilityCents = r.responsibility_cents == null ? null : exactCents(r.responsibility_cents);
      return { intentId: r.id as string, refundOrderNo: r.refund_order_no as string, amount: { cents: amountCents, currency: 'CNY' as const },
        localState: ['READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED'].includes(r.state) ? r.state as string : 'UNKNOWN',
        budgetDisposition: ['ALLOCATED','CONSUMED','RELEASED'].includes(r.budget_disposition) ? r.budget_disposition as string : 'UNKNOWN',
        requiresReview: r.requires_review as boolean, evidenceId: r.terminal_evidence_id ?? null, rootId: r.terminal_root_id ?? null,
        eventId: r.terminal_event_id ?? null, responsibilityCents, merchantIdentityId: typeof r.merchant_identity_id === 'string' ? r.merchant_identity_id : null,
        basisKind: 'POSTING' as const, paymentConfirmationId: typeof r.payment_confirmation_id === 'string' ? r.payment_confirmation_id : null,
        liabilityRootId: null, liabilityEventId: null,
        productFamily: r.payment_source === 'JOINPAY' ? 'JOINPAY' as const : null, providerRefundTrxNo: typeof r.provider_refund_trx_no === 'string' ? r.provider_refund_trx_no : null,
        safeTarget: 'ORIGINAL_CHANNEL' as const, mayResubmit: false, maySubmit: false as const, bankArrival: 'UNKNOWN' as const };
    });
    const sum = (disposition: string) => normalIntents.filter(intent => intent.budgetDisposition === disposition)
      .reduce((total, intent) => total + BigInt(intent.amount.cents), 0n);
    const normalActive = sum('ALLOCATED') + sum('CONSUMED'), normalAllocatedPartition = sum('ALLOCATED'),
      normalConsumed = sum('CONSUMED'), normalReleased = sum('RELEASED');
    const postingOriginal = postingRows[0]?.renter_refund_cents ?? null;
    const prestart=ready.has_prestart===true?await readPrestartFinanceProjection(c,input.orderId):null;
    const support=ready.has_support_cancel===true?await readSupportCancellationFinanceProjection(c,input.orderId):null;
    if (Number(Boolean(postingRows.length))+Number(Boolean(prestart))+Number(Boolean(support))>1) return absent('UNAVAILABLE', 'CONFLICTING_REFUND_RESPONSIBILITIES');
    const direct=prestart??support;
    const ps=direct?.refund.totals;
    const psComplete=!direct||direct.refund.integration==='INTEGRATED'&&ps?.totalsComplete===true;
    const psAllocated=psComplete?BigInt(ps?.allocatedCents??'0'):null,psConsumed=psComplete?BigInt(ps?.consumedCents??'0'):null,
      psReleased=psComplete?BigInt(ps?.releasedCents??'0'):null;
    const prestartIntents=direct?.refund.integration==='INTEGRATED'?(direct.refund.intents??[]).filter(r=>r.intentId&&r.refundOrderNo&&r.amountCents).map(r=>({
      intentId:r.intentId!,refundOrderNo:r.refundOrderNo!,amount:{cents:r.amountCents!,currency:'CNY' as const},
      localState:r.state,budgetDisposition:r.budgetDisposition,requiresReview:r.requiresReview,merchantIdentityId:direct.merchantIdentityId,
      basisKind:prestart?'PRESTART_TERMINATION' as const:'SUPPORT_CANCELLATION' as const,paymentConfirmationId:direct.paymentConfirmationId,liabilityRootId:direct.liabilityRootId,
      liabilityEventId:direct.liabilityEventId,responsibilityCents:direct.originalCents,
      evidenceId:r.terminalEvidenceId,rootId:r.terminalRootId,eventId:r.terminalEventId,
      productFamily:'JOINPAY' as const,providerRefundTrxNo:r.savedChannelEvidence?.channelRefundTrxNo??null,
      safeTarget:'ORIGINAL_CHANNEL' as const,mayResubmit:false,maySubmit:false as const,bankArrival:'UNKNOWN' as const
    })):[];
    const intents=[...normalIntents,...prestartIntents];
    if(intents.length>64)return {...absent('UNAVAILABLE','REFUND_BINDING_OR_READ_BOUND_EXCEEDED'),limit:64,truncated:true,coverage:'TRUNCATED' as const};
    const originalCents = postingOriginal === null && !direct ? null : BigInt(postingOriginal??'0') + BigInt(direct?.originalCents??'0');
    const responsibilityTotalsComplete = originalCents !== null && psAllocated!==null && psConsumed!==null && psReleased!==null
      && originalCents >= normalActive + psAllocated;
    return { contractVersion: 'admin-order-refund-summary.v1' as const, integration: 'INTEGRATED' as const, intents,
      ...(prestart?{prestartTermination:prestart}:{}), ...(support?{supportCancellation:support}:{}), limit: 64, truncated: false, maySubmit: false as const,
      coverage: 'COMPLETE_WITHIN_LIMIT' as const, coverageScope: 'JOINPAY_ONLY' as const,
      budget: psAllocated!==null&&psConsumed!==null&&psReleased!==null ? {
        allocatedCents: (normalAllocatedPartition+psAllocated-psConsumed).toString(),
        consumedCents: (normalConsumed+psConsumed).toString(), releasedCents: (normalReleased+psReleased).toString() } : null,
      responsibilityBudget: { originalCents: originalCents?.toString() ?? null,
        allocatedCents: psAllocated===null ? null : (normalActive+psAllocated).toString(),
        consumedCents: psConsumed===null ? null : (normalConsumed+psConsumed).toString(),
        releasedCents: psReleased===null ? null : (normalReleased+psReleased).toString(),
        remainingCents: responsibilityTotalsComplete && originalCents !== null ? (originalCents-normalActive-psAllocated!).toString() : null,
        totalsComplete: responsibilityTotalsComplete, postingOriginalCents: postingOriginal,...(prestart?{prestartOriginalCents:prestart.originalCents}:{}),...(support?{supportCancellationOriginalCents:support.originalCents}:{}) },
      bankArrival: 'UNKNOWN' as const, reasonCodes: ['LOCAL_RECORDS_ONLY_TERMINAL_EVIDENCE_NOT_REVALIDATED'] };
  } catch { return absent('UNAVAILABLE', 'REFUND_RECORD_PROJECTION_INVALID'); }
}
