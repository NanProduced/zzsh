import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalize } from '../src/supply/content-hash';
import { createDistributionEarningStore } from '../src/finance/distribution-earning-store';
import { freezePaymentDistributionBasis, type PaymentReferralFacts } from '../src/finance/distribution-payment-basis';
import { prepareAccrualFromFrozenPayment } from '../src/finance/distribution-accrual';
import { validateDistributionPolicy } from '../src/finance/distribution-policy';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = 'a'.repeat(64), receipt = { database: 'zzsh_test_order_credit_admin_batch2', runtimeRole: 'zzsh_order_credit_admin_batch2_r', marker: 'zzsh:order-reservation-test:v1', resourceOid: 777001 };
test('discovery paginates to the oldest missing accrual instead of starving behind newer complete rows', async () => {
  const policy = validateDistributionPolicy({ schema: 'distribution-policy.v1', scope: 'LOCAL_CONTROLLED', enabled: true, participation: 'AUTO_AT_REGISTRATION', depth: 1, selfRebate: false,
    accountModes: ['ordinary'], minimumAccrualCents: '1', settlementDelayDays: 7, levels: [{ code: 'TEST_ONLY_5', rank: 1, default: true, renterPercent: '5', ownerPercent: '5', upgrade: null }] });
  const facts: PaymentReferralFacts[] = (['RENTER_REFERRAL', 'OWNER_REFERRAL'] as const).map((role, index) => ({ role, partyUserId: 'party' + index,
    relation: { knowledge: 'KNOWN_PARENT', id: 'relation' + index, childUserId: 'party' + index, parentUserId: 'parent' + index, sourceDigest: digest },
    beneficiary: { userId: 'parent' + index, active: true, eligibility: 'ELIGIBLE', commissionFrozen: false, levelCode: 'TEST_ONLY_5' } }));
  const orders = Array.from({ length: 101 }, (_, i) => ({ orderId: 'order_' + String(i + 1).padStart(3, '0'), at: `2026-10-05T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000000Z` }));
  const payments = new Map<string, any>(), postings = new Map<string, any>(), bases = new Map<string, any>(), roots = new Map<string, any>();
  for (const order of orders) {
    const payment = { id: 'payment_' + order.orderId, order_id: order.orderId, source: 'CONTROLLED', merchant_scope_id: 'scope', provider_transaction_id: 'trx_' + order.orderId, merchant_order_no: 'merchant_' + order.orderId, amount_cents: '10000', currency: 'CNY', provider_paid_at: order.at, accepted_at: order.at };
    const frozen = freezePaymentDistributionBasis({ orderId: order.orderId, gameId: 'delta', currency: 'CNY', confirmationId: payment.id, acceptedAt: order.at, paymentDigest: sha(canonicalize(payment)), admissionId: 'admission', admissionRevision: '1', origin: 'NATIVE', accountMode: 'ordinary', estimate: { baseCents: '5000', sourceDigest: digest }, policy: { versionId: 'policy', config: policy, digest: sha(canonicalize(policy)) }, facts });
    const { digest: basisDigest, ...basis } = frozen;
    const posting = { id: 'posting_' + order.orderId, order_id: order.orderId, payment_confirmation_id: payment.id, version_hash: digest, early: false, manual_reason: null, captured_cents: '10000', owner_net_cents: '4000', renter_refund_cents: '1000', platform_contribution_cents: '5000', compensation_fee_cents: '200', posted_at: order.at };
    const allocation = prepareAccrualFromFrozenPayment({ ...basis, digest: basisDigest } as any, { origin: 'NATIVE', orderId: order.orderId, confirmationId: payment.id, postingId: posting.id, postingDigest: sha(canonicalize(posting)), postedAt: order.at, classification: 'NORMAL', calculationMode: 'SYSTEM', capturedCents: '10000', ownerNetCents: '4000', renterRefundCents: '1000', platformContributionCents: '5000', compensationFeeCents: '200' });
    if (allocation.knowledge !== 'KNOWN') throw new Error('fixture allocation');
    payments.set(order.orderId, payment); postings.set(order.orderId, posting); bases.set(order.orderId, { canonical_basis: canonicalize(basis), basis_digest: basisDigest });
    if (order.orderId !== 'order_001') for (const item of allocation.items) roots.set(item.economicKey, { amount_cents: item.amountCents, basis_digest: item.basisDigest, posting_digest: item.postingDigest });
  }
  const pool = { async connect() { return { release() {}, async query(sql: string, args: any[] = []): Promise<any> {
    const rows = (values: any[] = []) => ({ rows: values, rowCount: values.length });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') return rows();
    if (sql.startsWith('SELECT d.oid')) return rows([{ oid: receipt.resourceOid, name: receipt.database, role: receipt.runtimeRole, marker: receipt.marker, complete: true }]);
    if (sql.startsWith('SELECT p.id,p.order_id,p.payment_confirmation_id,p.version_hash')) {
      const cursorAt = args[3] as string | null, cursorId = args[4] as string | null, list = [...postings.values()]
        .filter(p => !cursorAt || p.posted_at < cursorAt || p.posted_at === cursorAt && p.id < cursorId!)
        .sort((a, b) => a.posted_at === b.posted_at ? b.id.localeCompare(a.id) : b.posted_at.localeCompare(a.posted_at));
      return rows(list.slice(0, args[2]).map(p => ({ ...p, game_id: 'delta' })));
    }
    if (sql.startsWith('SELECT p.id,p.order_id,p.source')) return rows([payments.get(args[1])]);
    if (sql.startsWith('SELECT canonical_basis')) { const basis = bases.get(args[0]); return rows(basis ? [basis] : []); }
    if (sql.startsWith('SELECT amount_cents::text,basis_digest,posting_digest')) return rows(roots.has(args[0]) ? [roots.get(args[0])] : []);
    throw new Error('Unexpected discovery SQL: ' + sql);
  } }; } } as unknown as Pool;
  const store = createDistributionEarningStore({ resourceSet: 'credit_admin_batch2', resourceOid: receipt.resourceOid, approvalDigest: digest, allowedOrderIds: orders.map(o => o.orderId) });
  const seen = new Set<string>(); let cursor: string | null = null, pages = 0, missing: any = null;
  do {
    const page = await store.discover(pool, { limit: 20, cursor });
    pages++;
    for (const order of page.orders) { assert(!seen.has(order.orderId)); seen.add(order.orderId); if (order.status === 'MISSING') missing = order; }
    cursor = page.nextCursor;
  } while (cursor && pages < 10);
  assert.equal(pages, 6); assert.equal(seen.size, 101); assert.equal(missing?.orderId, 'order_001'); assert.equal(missing.items.length, 2);
});
