import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalize } from '../src/supply/content-hash';
import { previewFrozenFinanceObservation } from '../src/finance/legacy-finance-source-preparation';
import { projectAdminFinanceObservation, financePeriodProjection, financeDocuments } from '../src/finance/admin-finance-read';
import type { FinanceOrderFact } from '../src/finance/admin-finance-order-read';
import { enrichHistoricalObservations, historicalObservationDisplay, type HistoricalRelationAccess } from '../src/finance/legacy-observation-display';

type Row = Record<string, any>;
const userId = 'fixture-user', legacyUserId = '11', at = 1782762304;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const sha = (value: unknown) => createHash('sha256').update(canonicalize(value)).digest('hex');
const access: HistoricalRelationAccess = { adminId: 'fixture-admin', isBoss: false, orderRead: true, financeDocumentRead: true };

function rawObservation(kind: 'HISTORICAL_EARNINGS_LOG' | 'HISTORICAL_WITHDRAWAL' | 'HISTORICAL_DISTRIBUTION', raw: Row): Row {
  const prepared = previewFrozenFinanceObservation(kind, raw, { userId, legacyUserId }), snapshot = prepared.row;
  return {
    id: `fixture-${kind}-${raw.id}`, subject_id: userId, subject_name: '测试用户',
    source_kind: kind, source_type: 'LEGACY_MYSQL', source_system: 'legacy_mysql_restore',
    source_entity: kind === 'HISTORICAL_EARNINGS_LOG' ? 'la_log_earnings' : kind === 'HISTORICAL_WITHDRAWAL' ? 'la_withdraw_apply' : 'la_distribution_order',
    source_id: prepared.sourceId, source_digest: prepared.sourceDigest, basis_id: null, included_in_opening: false,
    at: prepared.sourceEventAt, imported_at: '2026-10-22T00:00:00.000Z',
    amount: snapshot.amount, action: snapshot.action === undefined ? null : String(snapshot.action),
    source_status: snapshot.sourceStatus === undefined ? null : String(snapshot.sourceStatus),
    reference_id: snapshot.referenceId ?? null, reference_no: snapshot.referenceSn ?? null,
    balance_after: snapshot.leftAmount ?? null, fee: snapshot.fee ?? null, net: snapshot.net ?? null,
    extra_evidence: { snapshot, canonical: canonicalize(snapshot), legacyUserId },
  };
}
function log(overrides: Row = {}): Row {
  return rawObservation('HISTORICAL_EARNINGS_LOG', {
    id: 901, sn: 'LOG-SELF-NUMBER', action: 1, amount: '77.00', userId: 11,
    sourceId: 14998, createdAt: at, changeType: 1001, leftAmount: '200.00', ...overrides,
  });
}
function withdrawal(overrides: Row = {}): Row {
  return rawObservation('HISTORICAL_WITHDRAWAL', {
    id: 5053, sn: 'WITHDRAWAL-BUSINESS-NUMBER', type: 0, money: '734.00', status: 3,
    userId: 11, batch_no: 'FIXTURE-BATCH', is_delete: 0, left_money: '733.00',
    create_time: at, handling_fee: '1.00', payment_time: 0, ...overrides,
  });
}
function distribution(overrides: Row = {}): Row {
  return rawObservation('HISTORICAL_DISTRIBUTION', {
    id: 14998, sn: 'DISTRIBUTION-BUSINESS-NUMBER', user_id: 11, order_type: 1,
    order_id: 77, earnings: '77.00', level: 2, level_id: 1, ratio: '5.00', status: 2,
    settle_time: at, is_delete: 0, create_time: at - 600, update_time: at, ...overrides,
  });
}
function order(overrides: Row = {}, fact: Partial<FinanceOrderFact> = {}): FinanceOrderFact {
  const original = { id: '14998', order_sn: 'ORDER-BUSINESS-NUMBER', sale_user_id: '11',
    order_status: '4', pay_is: '1', sale_earnings: '80.00', full_payout_money: '3.00', confirm_time: String(at), ...overrides };
  return {
    ref: `LEGACY_ORDER:fixture-order-${original.id}`, id: `fixture-order-${original.id}`, number: original.order_sn,
    sourceType: 'LEGACY_MYSQL', sourceSystem: 'legacy_mysql_restore', sourceId: String(original.id), sourceDigest: sha(original),
    kind: 'SETTLEMENT', state: 'HISTORICAL_ORDER_RECORDED', occurredAt: iso(at - 3600), importedAt: '2026-10-22T00:00:00.000Z',
    ownerId: userId, renterId: 'fixture-renter', accountId: 'fixture-account', dueCents: '9000', recordedPaidCents: '9000', depositCents: '1000',
    originalOrderStatus: '4', originalPaymentStatus: '1', objectReadable: true,
    legacySource: { entity: 'la_order', snapshot: original, completedAt: iso(Number(original.confirm_time)) }, ...fact,
  };
}
function enrich(row: Row, candidates: Row[] = [], orders: FinanceOrderFact[] = [], permission: HistoricalRelationAccess | undefined = access) {
  const entry = projectAdminFinanceObservation(row);
  enrichHistoricalObservations([entry], [row, ...candidates], orders, permission);
  return entry;
}

test('legacy purpose codes keep their business meaning without inferring from sign', () => {
  const codes = ['SETTLEMENT_INCOME', 'WITHDRAWAL_DEBIT', 'WITHDRAWAL_REJECTED_RETURN', 'TRANSFER_FAILED_RETURN',
    'WECHAT_WITHDRAWAL_FAILED_RETURN', 'PLATFORM_CREDIT', 'PLATFORM_DEBIT', 'DEPOSIT_COMPENSATION', 'TASK_SETTLEMENT'];
  for (let index = 0; index < codes.length; index++) {
    const value = historicalObservationDisplay(log({ changeType: 1001 + index, action: index % 2 ? 1 : 2 }));
    assert.equal(value.purposeCode, codes[index]);
    assert.equal(value.changeType, String(1001 + index));
    assert.equal(value.channelState, 'UNVERIFIED');
  }
  assert.equal(historicalObservationDisplay(log({ changeType: 32109, action: 1 })).purposeCode, 'UNKNOWN');
  assert.equal(historicalObservationDisplay(log({ changeType: 32109, action: 2 })).purposeCode, 'UNKNOWN');
});

test('the original log number is its own number and never an invented order reference', () => {
  const entry = enrich(log());
  assert.equal(entry.documentNumber, 'LOG-SELF-NUMBER');
  assert.equal(entry.historical!.originalLogNumber, 'LOG-SELF-NUMBER');
  assert.equal(entry.evidence.originalNumber, null);
  assert.equal(entry.historical!.association.state, 'UNRESOLVED');
  assert.equal(entry.historical!.association.number, null);
  assert.deepEqual(entry.related, []);
});

test('withdrawal debit preserves gross, fee, net and unverified channel facts separately', () => {
  const row = log({ id: 11437, action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 });
  const entry = enrich(row, [withdrawal()]);
  assert.equal(entry.deltaCents, '-73400');
  assert.equal(entry.historical!.purposeCode, 'WITHDRAWAL_DEBIT');
  assert.equal(entry.historical!.recordedAmountCents, '73400');
  assert.equal(entry.historical!.feeCents, '100');
  assert.equal(entry.historical!.netCents, '73300');
  assert.equal(entry.historical!.association.kind, 'WITHDRAWAL');
  assert.equal(entry.historical!.association.number, 'WITHDRAWAL-BUSINESS-NUMBER');
  assert.equal(entry.historical!.association.originalStatusLabel, '旧平台记为成功');
  assert.equal(entry.historical!.channelState, 'UNVERIFIED');
  assert.equal(entry.historical!.originalStatus, null);
});

test('application and its debit remain distinct historical rows with no current accounting effect', () => {
  const raw = withdrawal(), application = projectAdminFinanceObservation(raw);
  const debit = enrich(log({ action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 }), [raw]);
  assert.equal(application.historical!.purposeCode, 'WITHDRAWAL_APPLICATION');
  assert.equal(financeDocuments([application])[0]!.requestedAmountCents,'73400');
  assert.equal(application.historical!.originalStatus, '3');
  assert.equal(application.historical!.originalStatusLabel, '旧平台记为成功');
  assert.equal(debit.historical!.association.documentRef, application.documentRef);
  assert.notEqual(debit.id, application.id);
  for (const entry of [application, debit]) {
    assert.equal(entry.affectsCurrentWallet, false);
    assert.equal(entry.affectsCurrentLedger, false);
  }
  assert.ok(financePeriodProjection([application, debit]).every(bucket => bucket.knownInflows === '0' && bucket.knownOutflows === '0'));
});

test('withdrawal debit can reference any legitimate later application status and never its net', () => {
  for (const status of [1, 2, 3, 4, 5]) {
    const entry = enrich(log({ action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 }), [withdrawal({ status })]);
    assert.equal(entry.historical!.association.state, 'MATCHED');
  }
  const netInsteadOfGross = enrich(log({ action: 2, amount: '733.00', sourceId: 5053, changeType: 1002 }), [withdrawal()]);
  assert.equal(netInsteadOfGross.historical!.association.state, 'UNRESOLVED');
});

test('known owner income examples use the generic original fact predicate rather than row ID exceptions', () => {
  const examples = [
    { logId: 11894, orderId: 14998, number: '20260630184504906252', amount: '77.00', earnings: '80.00', seconds: at },
    { logId: 14361, orderId: 16789, number: '20260707223243103699', amount: '59.00', earnings: '62.00', seconds: at + 100 },
    { logId: 8892, orderId: 12097, number: '20260620142604294552', amount: '130.00', earnings: '133.00', seconds: at + 200 },
    { logId: 997713, orderId: 887719, number: 'SYNTHETIC-OTHER-ORDER', amount: '2.01', earnings: '5.01', seconds: at + 300 },
  ];
  for (const sample of examples) {
    const row = log({ id: sample.logId, sourceId: sample.orderId, amount: sample.amount, createdAt: sample.seconds });
    const original = order({ id: String(sample.orderId), order_sn: sample.number, sale_earnings: sample.earnings, confirm_time: String(sample.seconds) });
    const before = projectAdminFinanceObservation(row), entry = enrich(row, [], [original]);
    assert.equal(entry.historical!.purposeCode, 'OWNER_RENTAL_INCOME');
    assert.equal(entry.historical!.association.state, 'MATCHED');
    assert.equal(entry.historical!.association.number, sample.number);
    assert.equal(entry.historical!.association.role, 'OWNER');
    assert.equal(entry.documentRef, before.documentRef);
    assert.equal(entry.id, before.id);
    assert.equal(entry.deltaCents, before.deltaCents);
    assert.equal(entry.sourceDigest, before.sourceDigest);
    assert.equal(entry.affectsCurrentLedger, false);
    assert.equal(entry.affectsCurrentWallet, false);
  }
});

test('owner relation rejects wrong party, amount, state, payment status, source system and business time', () => {
  const candidates = [order({ sale_user_id: '12' }), order({ sale_earnings: '80.01' }), order({ order_status: '3' }),
    order({ pay_is: '0' }), order({ confirm_time: String(at + 1) }), order({}, { ownerId: 'other-user' }),
    order({}, { sourceSystem: 'another-source' }), order({}, { sourceId: '42' }), order({}, { sourceType: 'NATIVE' }),
    order({}, { legacySource: undefined })];
  for (const candidate of candidates) assert.equal(enrich(log(), [], [candidate]).historical!.association.state, 'UNRESOLVED');
});

test('owner original number and canonical proof must agree with the projected order fact', () => {
  assert.equal(enrich(log(), [], [order({}, { number: 'WRONG-PROJECTED-NUMBER' })]).historical!.association.state, 'UNRESOLVED');
  assert.equal(enrich(log(), [], [order({}, { sourceDigest: '0'.repeat(64) })]).historical!.association.state, 'UNRESOLVED');
  assert.equal(enrich(log({ action: 2 }), [], [order()]).historical!.association.state, 'UNRESOLVED');
});

test('distribution income is polymorphic; a task distribution links only to its finance document', () => {
  const entry = enrich(log(), [distribution({ order_type: 2, level: 1 })]);
  assert.equal(entry.historical!.purposeCode, 'DISTRIBUTION_INCOME');
  assert.equal(entry.historical!.association.kind, 'DISTRIBUTION');
  assert.equal(entry.historical!.association.role, 'BENEFICIARY');
  assert.equal(entry.historical!.association.number, 'DISTRIBUTION-BUSINESS-NUMBER');
  assert.ok(entry.historical!.association.path!.startsWith('/finance/documents/'));
  assert.equal(entry.related.some(link => link.path?.startsWith('/orders/')), false);
});

test('a matching numeric ID in both economic source entities stays ambiguous without an object link', () => {
  const entry = enrich(log(), [distribution()], [order()]);
  assert.equal(entry.historical!.association.state, 'AMBIGUOUS');
  assert.equal(entry.historical!.purposeCode, 'SETTLEMENT_INCOME');
  assert.equal(entry.historical!.association.documentRef, null);
  assert.equal(entry.historical!.association.number, null);
  assert.equal(entry.historical!.association.path, null);
  assert.deepEqual(entry.related, []);
});

test('corrupt observation proof and mismatched source projection never establish a relation', () => {
  const corruptLog = log(); corruptLog.source_digest = '0'.repeat(64);
  const corruptWithdrawal = withdrawal(); corruptWithdrawal.extra_evidence.snapshot.rawSource.digest = '0'.repeat(64);
  const wrongFee = withdrawal(); wrongFee.fee = '2.00';
  const wrongAmount = distribution(); wrongAmount.amount = '78.00';
  for (const entry of [enrich(corruptLog, [], [order()]),
    enrich(log({ action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 }), [corruptWithdrawal]),
    enrich(log({ action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 }), [wrongFee]),
    enrich(log(), [wrongAmount])]) {
    assert.equal(entry.historical!.association.state, 'UNRESOLVED');
    assert.equal(entry.historical!.association.path, null);
  }
});

test('relationship authorization denial discloses no object reference, number, path or role', () => {
  const denied: HistoricalRelationAccess = { adminId: 'limited', isBoss: false, orderRead: false, financeDocumentRead: false };
  const entries = [enrich(log(), [], [order({}, { objectReadable: false })], denied),
    enrich(log(), [distribution()], [], denied),
    enrich(log({ action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 }), [withdrawal()], [], denied)];
  for (const entry of entries) {
    assert.equal(entry.historical!.association.state, 'DENIED');
    for (const field of ['documentRef', 'number', 'path', 'role'] as const) assert.equal(entry.historical!.association[field], null);
    assert.deepEqual(entry.related, []);
  }
});

test('return types retain known purpose but require missing return event time rather than using application or import time', () => {
  for (const type of [1003, 1004, 1005]) {
    const entry = enrich(log({ amount: '734.00', sourceId: 5053, changeType: type }), [withdrawal({ status: 4 })]);
    assert.equal(entry.historical!.association.state, 'UNRESOLVED');
    assert.ok(entry.reasonCodes.includes('HISTORICAL_RETURN_EVENT_TIME_UNAVAILABLE'));
    assert.equal(entry.historical!.channelState, 'UNVERIFIED');
    assert.equal(entry.historical!.association.path, null);
  }
});

test('missing authority context cannot grant a finance document association', () => {
  const entry = projectAdminFinanceObservation(log({ action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 }));
  const row = log({ action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 });
  enrichHistoricalObservations([entry], [row, withdrawal()], []);
  assert.equal(entry.historical!.association.state, 'DENIED');
  assert.equal(entry.historical!.association.documentRef, null);
  assert.equal(entry.historical!.association.path, null);
});

test('amounts above JavaScript safe integers and negative historic balance keep exact cents', () => {
  const display = historicalObservationDisplay(log({ amount: '99999999999999999999.99', leftAmount: '-12.34', changeType: 1006 }));
  assert.equal(display.recordedAmountCents, '9999999999999999999999');
  assert.equal(display.balanceAfterCents, '-1234');
  assert.equal(display.purposeCode, 'PLATFORM_CREDIT');
});
