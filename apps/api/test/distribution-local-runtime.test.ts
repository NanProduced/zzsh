import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../src/config/config';
import { createLocalDistributionRuntime } from '../src/finance/distribution-local-runtime';
import { assertLocalDistributionAssembly } from '../src/finance/distribution-policy-store';
import { createDistributionEarningStore, distributionSettlementPostCommitCallback } from '../src/finance/distribution-earning-store';
import { freezePaymentDistributionBasis, type PaymentReferralFacts } from '../src/finance/distribution-payment-basis';
import { validateDistributionPolicy } from '../src/finance/distribution-policy';
import { canonicalize } from '../src/supply/content-hash';
import { mountLocalControlledPayments } from '../src/order/local-payment-routes';

const digest = 'a'.repeat(64), sha = (v: string) => createHash('sha256').update(v).digest('hex');
// TEST_ONLY synthetic resource and business examples, never active operating configuration.
const receipt = { database: 'zzsh_test_order_credit_admin_batch2', resourceOid: 12345, owner: 'zzsh',
  marker: 'zzsh:order-reservation-test:v1', migrationRole: 'zzsh_order_credit_admin_batch2_m', runtimeRole: 'zzsh_order_credit_admin_batch2_r' };
const config = { profile: 'test', provider: 'fake', testOperationsEnabled: true,
  database: { target: 'local-compose', host: '127.0.0.1', port: 55432, name: receipt.database, user: receipt.runtimeRole } } as AppConfig;
const input = () => ({ config, receipt, resourceSet: 'credit_admin_batch2', approvalDigest: digest,
  allowedOrderIds: ['order'], payment: { appId: 'app', merchantScopeId: 'merchant' } });
const assembly = { testOperationsEnabled: true, secureCookies: false, apiOrigin: 'http://127.0.0.1:4282', userOrigin: 'http://127.0.0.1:4280', adminOrigin: 'http://127.0.0.1:4281' };
const response = () => ({ statusCode: 0, payload: null as any, setHeader() { return this; }, status(n: number) { this.statusCode = n; return this; }, json(body: any) { this.payload = body; return this; } });

test('one explicit assembly reuses registration, payment, origin and optional exact withdrawal capabilities without creating data', () => {
  const selected = input(), runtime = createLocalDistributionRuntime({ ...selected,
    withdrawalBindings: [{ userId: 'beneficiary', admissionId: 'admission', destinationId: 'destination', intentId: 'intent', payoutKey: 'payout' }] });
  assertLocalDistributionAssembly(runtime.auth.distributionScope, assembly);
  assert.equal(runtime.auth.distributionReadScope, runtime.auth.distributionScope);
  assert(runtime.auth.nativeWithdrawalScope);
  assert.equal(runtime.auth.nativeWalletOrigin.resourceOid, receipt.resourceOid);
  assert.equal(runtime.auth.localControlledPayments.config, config);
  assert.equal(runtime.auth.distributionEarnings, runtime.earnings);
  selected.allowedOrderIds.push('later');
  assert.equal(runtime.earnings.admitsOrder('later'), false);
  assert.equal(createLocalDistributionRuntime(input()).auth.nativeWithdrawalScope, undefined);
  for (const patch of [{ config: { ...config, profile: 'production' } }, { config: { ...config, provider: 'real' } },
    { resourceSet: 'other' }, { allowedOrderIds: ['order', 'order'] }, { allowedOrderIds: Array.from({ length: 101 }, (_, i) => 'o' + i) },
    { approvalDigest: 'unknown' }, { payment: { appId: '', merchantScopeId: 'merchant' } }, { withdrawalBindings: [] }]) {
    assert.throws(() => createLocalDistributionRuntime({ ...input(), ...patch } as any));
  }
});

function paymentProbe(prior = false) {
  const seen: string[] = [], calls: string[] = [];
  let failRecord = false;
  const client = { release() {}, async query(sql: string) {
    seen.push(sql);
    if (sql.startsWith('SELECT id, display_no')) return { rows: [{ id: 'order', display_no: 'merchant', currency: 'CNY', renter_user_id: 'renter', status: 'PENDING_PAYMENT', rental_amount_cents: '100', deposit_amount_cents: '0', created_at: '2026-10-05T00:00:00.000Z' }] };
    if (sql.startsWith('SELECT id, reason_code')) return { rows: prior ? [{ id: 'original', reasonCode: null }] : [] };
    if (sql.includes('current_database() AS db')) return { rows: [{ db: config.database.name, actor: config.database.user }] };
    if (sql.includes('FROM zzsh_order.payment_confirmation')) return { rows: [] };
    if (sql.startsWith('SELECT account_id')) return { rows: [{ account_id: 'account', renter_user_id: 'renter', owner_user_id: 'owner' }] };
    if (sql.includes('WHERE id = ANY')) return { rows: [{ id: 'owner' }, { id: 'renter' }] };
    if (sql.startsWith('SELECT status, display_no')) return { rows: [{ status: 'PENDING_PAYMENT', display_no: 'merchant', currency: 'CNY', total: '100', hold: '2026-10-06T00:00:00.000000Z' }] };
    if (sql.includes(' AS accepted,')) return { rows: [{ accepted: '2026-10-05T00:00:00.000000Z', open: true }] };
    return { rows: [], rowCount: 1 };
  } } as unknown as PoolClient;
  const prepared = { orderId: 'order' }, distribution = {
    async prepare(c: PoolClient) { assert.equal(c, client); calls.push('prepare'); seen.push('PREPARE'); return prepared; },
    async record(c: PoolClient, p: unknown) { assert.equal(c, client); assert.equal(p, prepared); calls.push('record'); seen.push('RECORD'); if (failRecord) throw new Error('basis write unavailable'); return {}; },
    async readOriginal(c: PoolClient, orderId: string, confirmationId: string) { assert.equal(c, client); assert.equal(orderId, 'order'); assert.equal(confirmationId, 'original'); calls.push('original'); return { knowledge: 'UNKNOWN', reason: 'MISSING_ORIGINAL_BASIS', basis: null }; },
  };
  return { seen, calls, distribution, pool: { connect: async () => client } as unknown as Pool, fail() { failRecord = true; } };
}

test('actual mounted payment route freezes on the original transaction; failed record rolls back payment and no commit is acknowledged', async t => {
  const users = require('../src/auth/user-identity'), original = users.readUserContext;
  users.readUserContext = async () => ({ userId: 'renter', sessionId: 'session' });
  t.after(() => { users.readUserContext = original; });
  for (const fail of [false, true]) {
    const p = paymentProbe(); if (fail) p.fail();
    let handler: Function = () => { throw new Error('not mounted'); };
    const app: any = { getHttpAdapter: () => ({ getInstance: () => ({ use: (_: string, fn: Function) => { handler = fn; } }) }) };
    mountLocalControlledPayments(app, { pool: p.pool, userOrigin: assembly.userOrigin } as any,
      { ...createLocalDistributionRuntime(input()).auth.localControlledPayments, distribution: p.distribution as any });
    const r = response();
    await handler({ method: 'POST', originalUrl: '/api/bff/user/orders/order/payment-requests', headers: { origin: assembly.userOrigin, 'x-request-id': 'req_payment', 'idempotency-key': 'original_key' }, body: {} }, r, () => assert.fail('route missed'));
    assert.deepEqual(p.calls, ['prepare', 'record']);
    assert(p.seen.indexOf('RECORD') > p.seen.findIndex(sql => sql.startsWith('INSERT INTO zzsh_order.im_order_group')));
    if (fail) { assert.equal(r.statusCode, 500); assert(p.seen.includes('ROLLBACK')); assert(!p.seen.includes('COMMIT')); }
    else { assert.equal(r.statusCode, 200); assert.equal(r.payload.payment.disposition, 'APPLIED'); assert(p.seen.indexOf('COMMIT') > p.seen.indexOf('RECORD')); }
  }
});

test('the actual route replay only reads the old basis, including missing-basis old APPLIED; it never prepares or acquires a new policy', async t => {
  const users = require('../src/auth/user-identity'), original = users.readUserContext;
  users.readUserContext = async () => ({ userId: 'renter', sessionId: 'session' }); t.after(() => { users.readUserContext = original; });
  const p = paymentProbe(true); let handler: Function = () => {};
  mountLocalControlledPayments({ getHttpAdapter: () => ({ getInstance: () => ({ use: (_: string, fn: Function) => { handler = fn; } }) }) } as any,
    { pool: p.pool, userOrigin: assembly.userOrigin } as any, { ...createLocalDistributionRuntime(input()).auth.localControlledPayments, distribution: p.distribution as any });
  const r = response(); await handler({ method: 'POST', originalUrl: '/api/bff/user/orders/order/payment-requests', headers: { origin: assembly.userOrigin, 'x-request-id': 'req_replay', 'idempotency-key': 'original_key' }, body: {} }, r, () => {});
  assert.equal(r.statusCode, 200); assert.equal(r.payload.payment.replay, true); assert.deepEqual(p.calls, ['original']);
  assert(!p.seen.some(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)));
});

// Transactional in-memory adapter for failure/recovery contracts, not a PostgreSQL lock or trigger test.
function earningProbe() {
  const at = '2026-10-05T00:00:00.000000Z';
  const payment = { id: 'payment', order_id: 'order', source: 'CONTROLLED', merchant_scope_id: 'scope', provider_transaction_id: 'transaction', merchant_order_no: 'merchant', amount_cents: '10000', currency: 'CNY', provider_paid_at: at, accepted_at: at };
  const policy = validateDistributionPolicy({ schema: 'distribution-policy.v1', scope: 'LOCAL_CONTROLLED', enabled: true, participation: 'AUTO_AT_REGISTRATION', depth: 1, selfRebate: false, accountModes: ['ordinary'], minimumAccrualCents: '1', settlementDelayDays: 7,
    levels: [{ code: 'TEST_ONLY_5', rank: 1, default: true, renterPercent: '5', ownerPercent: '5', upgrade: null }] });
  const facts: PaymentReferralFacts[] = (['RENTER_REFERRAL', 'OWNER_REFERRAL'] as const).map((role, i) => ({ role, partyUserId: 'party' + i,
    relation: { knowledge: 'KNOWN_PARENT', id: 'relation' + i, childUserId: 'party' + i, parentUserId: 'parent' + i, sourceDigest: digest },
    beneficiary: { userId: 'parent' + i, active: true, eligibility: 'ELIGIBLE', commissionFrozen: false, levelCode: 'TEST_ONLY_5' } }));
  const frozen = freezePaymentDistributionBasis({ orderId: 'order', gameId: 'delta', currency: 'CNY', confirmationId: 'payment', acceptedAt: at, paymentDigest: sha(canonicalize(payment)), admissionId: 'admission', admissionRevision: '1', origin: 'NATIVE', accountMode: 'ordinary', estimate: { baseCents: '5000', sourceDigest: digest }, policy: { versionId: 'policy', config: policy, digest: sha(canonicalize(policy)) }, facts });
  const { digest: basisDigest, ...basis } = frozen;
  const posting = { id: 'posting', order_id: 'order', payment_confirmation_id: 'payment', version_hash: digest, early: false, manual_reason: null, captured_cents: '10000', owner_net_cents: '4000', renter_refund_cents: '1000', platform_contribution_cents: '5000', compensation_fee_cents: '200', posted_at: at };
  type State = { roots: any[]; lines: any[][]; events: string[]; receipts: any[]; audits: number };
  let state: State = { roots: [], lines: [], events: [], receipts: [], audits: 0 };
  const control = { hasPosting: true, hasBasis: true, failAudit: 0, lostCommit: false, now: '2026-10-05T00:00:01.000Z' }, seen: string[] = [];
  const pool = { async connect() {
    let tx: State;
    return { release() {}, async query(sql: string, args: any[] = []): Promise<any> {
      seen.push(sql); const rows = (values: any[] = []) => ({ rows: values, rowCount: values.length });
      if (sql === 'BEGIN') { tx = structuredClone(state); return rows(); }
      if (sql === 'ROLLBACK') return rows();
      if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') return rows();
      if (sql === 'COMMIT') { state = tx; if (control.lostCommit) { control.lostCommit = false; throw Object.assign(new Error('commit acknowledgement lost'), { code: 'ECONNRESET' }); } return rows(); }
      if (sql.startsWith('SELECT d.oid')) return rows([{ oid: receipt.resourceOid, name: receipt.database, role: receipt.runtimeRole, marker: receipt.marker, complete: true }]);
      if (sql.startsWith('SELECT pg_advisory') || sql === 'SET CONSTRAINTS ALL IMMEDIATE') return rows();
      if (sql.startsWith('SELECT p.id,p.order_id,p.payment_confirmation_id')) return rows(control.hasPosting ? [posting] : []);
      if (sql.startsWith('SELECT p.id,p.order_id,p.source')) return rows([payment]);
      if (sql.startsWith('SELECT canonical_basis')) return rows(control.hasBasis ? [{ canonical_basis: canonicalize(basis), basis_digest: basisDigest }] : []);
      if (sql.startsWith('SELECT id FROM zzsh_auth_user')) return rows(args[0] instanceof Array ? args[0].map((id: string) => ({ id })) : [{ id: args[0] }]);
      if (sql.startsWith('SELECT e.*')) return rows(sql.includes('economic_key=$1') ? tx.roots.filter(r => r.economic_key === args[0]) : sql.includes('WHERE order_id=$1') ? tx.roots.filter(r => r.order_id === args[0]) : tx.roots.filter(r => r.id === args[0]));
      if (sql.startsWith('SELECT 1 FROM zzsh_order.wallet_coverage')) return rows([{}]);
      if (sql.startsWith('SELECT ledger_revision')) return rows([{ revision: '1', available: tx.lines.filter(l => l[6] === args[0] && l[3] === 'WALLET_AVAILABLE').reduce((n, l) => n + BigInt(l[5]) - BigInt(l[4]), 0n).toString() }]);
      if (sql.startsWith('SELECT order_id,beneficiary_user_id')) return rows(tx.roots.filter(r => r.id === args[0]).map(r => ({ order_id: r.order_id, beneficiary_user_id: r.beneficiary_user_id })));
      if (sql.startsWith('SELECT id,version::text')) { assert(sql.includes('due_at<=clock_timestamp()')); assert.deepEqual(args[0], ['order']); return rows(tx.roots.filter(r => r.state === 'PENDING' && Date.parse(r.due_exact) <= Date.parse(control.now)).slice(0, args[1]).map(r => ({ id: r.id, version: r.version }))); }
      if (sql.startsWith('SELECT date_trunc')) return rows([{ now: new Date(control.now), due: Date.parse(control.now) >= Date.parse(args[0]) }]);
      if (sql.startsWith('SELECT * FROM zzsh_order.rental_referral_transition')) return rows(tx.receipts.filter(r => r.earning_id === args[0] && (!sql.includes('action=$2') || r.action === args[1])));
      if (sql.startsWith('INSERT INTO zzsh_order.finance_economic_root')) return rows();
      if (sql.startsWith('INSERT INTO zzsh_order.rental_referral_earning')) {
        assert(!tx.roots.some(r => r.economic_key === args[1]));
        tx.roots.push({ id: args[0], economic_root_id: args[0], economic_key: args[1], order_id: args[2], payment_confirmation_id: args[3], posting_id: args[4], beneficiary_user_id: args[5], beneficiary_role: args[6], amount_cents: args[7], due_exact: args[8], basis_digest: args[9], posting_digest: args[10], canonical_seed: args[11], seed_digest: args[12], state: 'PENDING', funds_disposition: 'PENDING', version: '1', recovery_required_cents: null }); return rows();
      }
      if (sql.startsWith('INSERT INTO zzsh_order.finance_event')) { assert(!tx.events.includes(args[0])); tx.events.push(args[0]); return rows(); }
      if (sql.startsWith('INSERT INTO zzsh_order.settlement_ledger_entry')) { tx.lines.push(args); return rows(); }
      if (sql.startsWith('INSERT INTO zzsh_order.rental_referral_transition')) {
        tx.receipts.push(sql.includes("'ACCRUE'") ? { earning_id: args[1], action: 'ACCRUE', expected_version: '0', result_version: '1', finance_event_id: args[2], source_digest: args[3] }
          : { earning_id: args[1], action: args[2], expected_version: args[3], result_version: args[4], finance_event_id: args[5], reversal_source_id: args[6], source_digest: args[7] }); return rows();
      }
      if (sql.startsWith('UPDATE zzsh_order.rental_referral_earning')) { const root = tx.roots.find(r => r.id === args[0] && r.version === args[5]); if (!root) return rows(); Object.assign(root, { state: args[1], funds_disposition: args[2], version: args[3], recovery_required_cents: args[4] }); return rows([root]); }
      if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { tx.audits++; if (control.failAudit === tx.audits) throw new Error('audit unavailable'); return rows(); }
      throw new Error('Unexpected SQL in isolated contract test: ' + sql);
    } };
  } } as unknown as Pool;
  return { pool, control, seen, state: () => structuredClone(state), store: createDistributionEarningStore({ resourceSet: 'credit_admin_batch2', resourceOid: receipt.resourceOid, approvalDigest: digest, allowedOrderIds: ['order'] }) };
}

test('immutable posting accrual rolls back a partial pair, retries the same source and cannot duplicate roots or money on replay', async () => {
  const p = earningProbe(); p.control.failAudit = 2;
  await assert.rejects(p.store.accrue(p.pool, 'order', 'req_partial'), /audit unavailable/);
  assert.deepEqual(p.state(), { roots: [], lines: [], events: [], receipts: [], audits: 0 });
  p.control.failAudit = 0;
  const written = await p.store.accrue(p.pool, 'order', 'req_recovery');
  assert.equal(written.knowledge, 'KNOWN'); assert.deepEqual(written.items.map((x: any) => x.root.amountCents), ['240', '240']);
  const before = p.state(), replay = await p.store.accrue(p.pool, 'order', 'req_replay');
  assert.equal(replay.knowledge, 'KNOWN'); assert(replay.items.every((x: any) => x.replayed)); assert.deepEqual(p.state(), before);
  assert(!p.seen.some(sql => /distribution_policy_head|UPDATE zzsh_order.settlement_posting|UPDATE zzsh_order.payment_confirmation/.test(sql)));
});

test('unfinished settlement and missing old payment basis stay UNKNOWN and cannot create fresh policy-backed earnings', async () => {
  const p = earningProbe(); p.control.hasPosting = false;
  assert.equal((await p.store.accrue(p.pool, 'order', 'req_pending') as any).reason, 'ORDER_NOT_COMPLETED');
  p.control.hasPosting = true; p.control.hasBasis = false;
  assert.equal((await p.store.accrue(p.pool, 'order', 'req_old') as any).reason, 'MISSING_ORIGINAL_BASIS');
  assert.equal(p.state().lines.length, 0); assert.equal(p.state().roots.length, 0);
  await assert.rejects(p.store.accrue(p.pool, 'outside', 'req_outside'));
});

test('lost accrual commit acknowledgement recovers with a read of original roots, then same-source replay posts nothing', async () => {
  const p = earningProbe(); p.control.lostCommit = true;
  await assert.rejects(p.store.accrue(p.pool, 'order', 'req_lost'), /acknowledgement lost/);
  const before = p.state(), start = p.seen.length, recovered = await p.store.readOrder(p.pool, 'order');
  assert.equal(recovered.items.length, 2); assert.equal(before.lines.length, 4);
  assert(!p.seen.slice(start).some(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)));
  assert(p.seen.slice(start).includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  const replay = await p.store.accrue(p.pool, 'order', 'req_same_source'); assert(replay.items.every((x: any) => x.replayed)); assert.deepEqual(p.state(), before);
});

test('bounded due driver waits for source due time, credits only the selected original root and is safe on subsequent passes', async () => {
  const p = earningProbe(); await p.store.accrue(p.pool, 'order', 'req_accrue');
  assert.equal((await p.store.settleDue(p.pool, 1, 'req_early')).selected, 0);
  p.control.now = '2026-10-12T00:00:01.000Z';
  for (let i = 0; i < 2; i++) { const result = await p.store.settleDue(p.pool, 1, 'req_due_' + i); assert.equal(result.selected, 1); assert.equal(result.results[0]!.status, 'SETTLED'); }
  const before = p.state(); assert.equal((await p.store.settleDue(p.pool, 100, 'req_again')).selected, 0); assert.deepEqual(p.state(), before);
  assert.equal(before.lines.filter(l => l[3] === 'WALLET_AVAILABLE').reduce((n, l) => n + BigInt(l[5]), 0n), 480n);
  for (const limit of [0, 101, 1.5]) await assert.rejects(p.store.settleDue(p.pool, limit, 'req_invalid'));
  const oversized = createDistributionEarningStore({ resourceSet: 'credit_admin_batch2', resourceOid: receipt.resourceOid, approvalDigest: digest,
    allowedOrderIds: Array.from({ length: 101 }, (_, i) => 'order_' + i) }), seen = p.seen.length;
  await assert.rejects(oversized.settleDue(p.pool, 1, 'req_oversized')); assert.equal(p.seen.length, seen);
});

test('due commit acknowledgement loss stops the batch as UNKNOWN; the original transition is readable without writing', async () => {
  const p = earningProbe(); await p.store.accrue(p.pool, 'order', 'req_accrue'); p.control.now = '2026-10-12T00:00:01.000Z';
  // Skip the read transaction's COMMIT; lose acknowledgement only after the actual SETTLE.
  const connect = p.pool.connect.bind(p.pool) as any;
  (p.pool as any).connect = async () => { const c = await connect(); const query = c.query.bind(c); let monetary = false; c.query = async (sql: string, args?: any[]) => { if (sql.startsWith('INSERT INTO zzsh_order.finance_event')) monetary = true; if (sql === 'COMMIT' && monetary) p.control.lostCommit = true; return query(sql, args); }; return c; };
  const result = await p.store.settleDue(p.pool, 2, 'req_unknown'); assert.equal(result.recoveryRequired, true); assert.equal(result.notAttempted, 1); assert.equal(result.results[0]!.status, 'UNKNOWN');
  (p.pool as any).connect = connect;
  const recovered = await p.store.readOrder(p.pool, 'order');
  assert.equal(recovered.items.filter(x => x.root.state === 'SETTLED').length, 1);
  assert.equal(recovered.items.flatMap(x => x.transitions).filter(x => x.action === 'SETTLE').length, 1);
});

test('post-commit accrual leaves the committed settlement response intact, records no fake success and permits original-source recovery', async t => {
  const logger = require('@nestjs/common').Logger, original = logger.warn, warnings: any[] = [];
  logger.warn = (value: any) => warnings.push(value); t.after(() => { logger.warn = original; });
  const p = earningProbe(); p.control.failAudit = 1;
  assert.equal(distributionSettlementPostCommitCallback(p.pool, 'outside', 'req_outside', p.store), undefined);
  await distributionSettlementPostCommitCallback(p.pool, 'order', 'req_post', p.store)!();
  assert.equal(p.state().lines.length, 0); assert.equal(warnings.length, 1); assert.equal(warnings[0].event, 'distribution.accrual.unknown');
  p.control.failAudit = 0; await distributionSettlementPostCommitCallback(p.pool, 'order', 'req_recover', p.store)!();
  assert.equal(p.state().roots.length, 2); assert.equal(warnings.length, 1);
});

test('actual user decision and admin review routes run accrual after the committed writer, including growth failure', async t => {
  const routes = require('../src/supply/supply-routes'), users = require('../src/auth/user-identity'), security = require('../src/auth/auth-security'), growth = require('../src/auth/membership-growth-integration');
  const previous = { write: routes.runIdempotentWrite, user: users.readUserContext, admin: security.readAdminContext, growth: growth.membershipGrowthPostCommitCallback,
    env: process.env.ZZSH_SETTLEMENT_RECORDING, nodeEnv: process.env.NODE_ENV };
  const seen: string[] = []; let failGrowth = false;
  t.after(() => { routes.runIdempotentWrite = previous.write; users.readUserContext = previous.user; security.readAdminContext = previous.admin; growth.membershipGrowthPostCommitCallback = previous.growth;
    if (previous.env === undefined) delete process.env.ZZSH_SETTLEMENT_RECORDING; else process.env.ZZSH_SETTLEMENT_RECORDING = previous.env;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv; });
  process.env.ZZSH_SETTLEMENT_RECORDING = 'controlled'; process.env.NODE_ENV = 'test';
  users.readUserContext = security.readAdminContext = async () => ({ userId: 'actor', sessionId: 'session' });
  growth.membershipGrowthPostCommitCallback = () => async () => { seen.push('growth'); if (failGrowth) throw new Error('growth failed'); };
  routes.runIdempotentWrite = async (...args: any[]) => { seen.push('settlement COMMIT'); await args[10]?.(); };
  const earnings = { admitsOrder: (id: string) => id === 'order', accrue: async () => { seen.push('distribution'); return { knowledge: 'KNOWN', items: [] }; } };
  const options = { ...assembly, pool: {}, settlementRecordingEnabled: true, distributionEarnings: earnings };
  const { handleSettlementUserRoute, handleSettlementAdminRoute } = require('../src/order/settlement-routes');
  for (const admin of [false, true]) {
    seen.length = 0;
    const handler = admin ? handleSettlementAdminRoute : handleSettlementUserRoute;
    const req = { method: 'POST', originalUrl: admin ? '/api/v1/admin/orders/order/settlements/version/review' : '/api/v1/orders/order/settlements/version/decision',
      headers: { origin: admin ? assembly.adminOrigin : assembly.userOrigin, 'x-request-id': 'req_settlement', 'idempotency-key': 'original' }, body: admin ? { versionHash: digest } : { action: 'CONFIRM', versionHash: digest } };
    assert.equal(await handler(req, response(), options), true);
    assert.deepEqual(seen, ['settlement COMMIT', 'growth', 'distribution']);
    failGrowth = true; seen.length = 0;
    await assert.rejects(handler(req, response(), options), /growth failed/);
    assert.deepEqual(seen, ['settlement COMMIT', 'growth', 'distribution']); failGrowth = false;
  }
});

test('auth rejects an earnings capability without its explicit local payment and registration capabilities before touching a pool', async () => {
  const { mountAuthHandlers } = require('../src/auth/auth-runtime'); let queries = 0;
  const pool = { connect: async () => { queries++; throw new Error('pool must not be reached'); } };
  await assert.rejects(mountAuthHandlers({}, { ...assembly, pool, distributionEarnings: createLocalDistributionRuntime(input()).earnings }), /explicit local payment/);
  assert.equal(queries, 0);
});
