import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalize } from '../src/supply/content-hash';
import { previewFrozenFinanceObservation } from '../src/finance/legacy-finance-source-preparation';
import { projectAdminFinanceObservation, financePeriodProjection, financeDocuments, loadAdminFinanceFacts, parseAdminFinanceFilters } from '../src/finance/admin-finance-read';
import type { FinanceOrderFact } from '../src/finance/admin-finance-order-read';
import { enrichHistoricalObservations, historicalObservationDisplay, resolveHistoricalReverseLinks, type HistoricalRelationAccess } from '../src/finance/legacy-observation-display';
import {FinanceSqlFixture} from './admin-finance-fixture';

type Row = Record<string, any>;
const userId = 'fixture-user', legacyUserId = '11', at = 1782762304;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const sha = (value: unknown) => createHash('sha256').update(canonicalize(value)).digest('hex');
const access: HistoricalRelationAccess = { adminId: 'fixture-admin', isBoss: false, orderRead: true, financeDocumentRead: true };

function rawObservation(kind: 'HISTORICAL_EARNINGS_LOG' | 'HISTORICAL_WITHDRAWAL' | 'HISTORICAL_DISTRIBUTION' | 'HISTORICAL_PAYMENT' | 'HISTORICAL_REFUND', raw: Row, originalUserId = legacyUserId): Row {
  const prepared = previewFrozenFinanceObservation(kind, raw, { userId, legacyUserId: originalUserId }), snapshot = prepared.row;
  return {
    id: `fixture-${kind}-${raw.id}`, subject_id: userId, subject_name: '测试用户',
    source_kind: kind, source_type: 'LEGACY_MYSQL', source_system: 'legacy_mysql_restore',
    source_entity: (snapshot.rawSource as {entity:string}).entity,
    source_id: prepared.sourceId, source_digest: prepared.sourceDigest, basis_id: null, included_in_opening: false,
    at: prepared.sourceEventAt, imported_at: '2026-10-22T00:00:00.000Z',
    amount: snapshot.amount, action: snapshot.action === undefined ? null : String(snapshot.action),
    source_status: snapshot.sourceStatus === undefined ? null : String(snapshot.sourceStatus),
    reference_id: snapshot.referenceId ?? null, reference_no: snapshot.referenceSn ?? null,
    balance_after: snapshot.leftAmount ?? null, fee: snapshot.fee ?? null, net: snapshot.net ?? null,
    extra_evidence: { snapshot, canonical: canonicalize(snapshot), legacyUserId: originalUserId },
  };
}
function log(overrides: Row = {}): Row {
  return rawObservation('HISTORICAL_EARNINGS_LOG', {
    id: 901, sn: 'LOG-SELF-NUMBER', action: 1, amount: '77.00', userId: 11,
    sourceId: 14998, createdAt: at, changeType: 1001, leftAmount: '200.00',
    ...(['1002','1003','1004','1005'].includes(String(overrides.changeType)) ? {sourceSn:'WITHDRAWAL-BUSINESS-NUMBER'} : {}), ...overrides,
  }, String(overrides.userId ?? legacyUserId));
}
function withdrawal(overrides: Row = {}): Row {
  return rawObservation('HISTORICAL_WITHDRAWAL', {
    id: 5053, sn: 'WITHDRAWAL-BUSINESS-NUMBER', type: 0, money: '734.00', status: 3,
    userId: 11, batch_no: 'FIXTURE-BATCH', is_delete: 0, left_money: '733.00',
    create_time: at, handling_fee: '1.00', payment_time: 0, ...overrides,
  }, String(overrides.userId ?? legacyUserId));
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

test('typed order finance edges preserve independent source amounts and deny same-id or wrong-party guesses', () => {
  const parent=order({id:'32',user_id:'11',return_order_money:'625.00'},{renterId:userId});
  const refund=(overrides:Row={})=>rawObservation('HISTORICAL_REFUND',{
    id:'19',user_id:'11',userId:'11',order_type:'order',order_id:'32',order_sn:parent.number,sn:'REFUND-19',
    order_amount:'685.00',refund_amount:'685.00',refund_status:'1',create_time:String(at),relationship:'VERIFIED',...overrides,
  });
  const payment=(orderType:string)=>rawObservation('HISTORICAL_PAYMENT',{
    id:'19',userId:'11',order_type:orderType,order_id:'32',pay_order_sn:'PAY-19',
    pay_money:'685.00',pay_is:'1',pay_time:String(at),create_time:String(at),relationship:'VERIFIED',
  });
  const positive=enrich(refund(),[],[parent]);
  assert.equal(positive.historical!.recordedAmountCents,'68500');
  assert.equal(positive.historical!.association.role,'RENTER');
  assert.equal(positive.affectsCurrentWallet,false);
  assert.equal(positive.affectsCurrentLedger,false);
  assert.equal(positive.evidence.channelArrival,'UNKNOWN');
  for(const other of [refund({order_sn:'wrong'}),refund({relationship:'UNRESOLVED'}),payment('2')]) {
    const entry=enrich(other,[],[parent]);assert.equal(entry.historical!.association.state,'UNRESOLVED');assert.deepEqual(entry.related,[]);
  }
  assert.equal(enrich(refund(),[],[{...parent,renterId:'other'}]).historical!.association.state,'UNRESOLVED');
  assert.equal(enrich(refund(),[],[{...parent,objectReadable:false}]).historical!.association.state,'DENIED');
  const commission=distribution({order_id:'32',status:1,earnings:'3.40'});
  const links=resolveHistoricalReverseLinks(parent.ref,[refund(),payment('1'),payment('2'),commission],[parent],access);
  assert.deepEqual(links.related.map(link=>link.ref.split(':')[0]),['HISTORY_REFUND','HISTORY_PAYMENT','HISTORY_DISTRIBUTION']);
  assert.equal(enrich(commission,[],[parent]).historical!.association.role,'BENEFICIARY');
});

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

test('only a proved original earnings log receives balance-record amount semantics',()=>{
  const valid=log({action:2,amount:'734.00',sourceId:5053,changeType:1002});
  assert.equal(projectAdminFinanceObservation(valid).historical!.amountSemantics,'BALANCE_RECORD');
  const zero=log({action:2,amount:'0.00',sourceId:5053,changeType:1002});assert.equal(projectAdminFinanceObservation(zero).historical!.amountSemantics,'BALANCE_RECORD');
  const badDigest=structuredClone(valid);badDigest.source_digest='0'.repeat(64);
  const badTime=structuredClone(valid);badTime.at=iso(at-1);
  const rewrite=(field:string,value:unknown)=>{const row=structuredClone(valid),s=row.extra_evidence.snapshot,raw=JSON.parse(s.rawSource.canonical);raw[field]=value;s[field]=value;row[field==='action'?'action':'amount']=String(value);s.rawSource.canonical=canonicalize(raw);s.rawSource.digest=sha(raw);row.extra_evidence.canonical=canonicalize(s);row.source_digest=sha(s);return row;};
  for(const row of [badDigest,badTime,rewrite('action',9),rewrite('amount','invalid')]){
    const projected=projectAdminFinanceObservation(row);assert.equal(projected.historical!.amountSemantics,'UNVERIFIED');assert.equal(projected.affectsCurrentWallet,false);assert.equal(projected.affectsCurrentLedger,false);
  }
});

test('every legacy business observation requires original source proof before its amount is presented as recorded',()=>{
  const payment=(pay_is:string)=>rawObservation('HISTORICAL_PAYMENT',{id:'19',userId:'11',order_type:'1',order_id:'32',pay_order_sn:'PAY-19',pay_money:'685.00',pay_is,pay_time:'0',create_time:String(at),relationship:'VERIFIED'});
  const refund=rawObservation('HISTORICAL_REFUND',{id:'20',user_id:'11',userId:'11',order_type:'order',order_id:'32',order_sn:'ORDER-32',sn:'REFUND-20',order_amount:'685.00',refund_amount:'10.00',refund_status:'1',create_time:String(at),relationship:'VERIFIED'});
  for(const row of [payment('0'),payment('1'),refund,distribution(),withdrawal()]){
    const value=projectAdminFinanceObservation(row);assert.equal(value.historical!.amountSemantics,'BUSINESS_RECORD');assert.notEqual(value.historical!.recordedAmountCents,null);
    assert.equal(value.affectsCurrentWallet,false);assert.equal(value.affectsCurrentLedger,false);
    const broken=structuredClone(row);broken.source_digest='0'.repeat(64);const unverified=projectAdminFinanceObservation(broken);
    assert.equal(unverified.historical!.amountSemantics,'UNVERIFIED');assert.equal(unverified.historical!.recordedAmountCents,value.historical!.recordedAmountCents);
  }
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
    const row = log({ id: sample.logId, sourceId: sample.orderId, sourceSn: sample.number, amount: sample.amount, createdAt: sample.seconds });
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
  for (const candidate of candidates) assert.equal(enrich(log({sourceSn:'ORDER-BUSINESS-NUMBER'}), [], [candidate]).historical!.association.state, 'UNRESOLVED');
});

test('owner income permits a later log only with verified source number, amount and original proof',()=>{
  const parent=order(),expected='ORDER-BUSINESS-NUMBER';
  for(const seconds of [0,1,60])assert.equal(enrich(log({sourceSn:expected,createdAt:at+seconds}),[],[parent]).historical!.association.state,'MATCHED');
  for(const row of [log({sourceSn:expected,createdAt:at-1}),log({sourceSn:'WRONG-ORDER',createdAt:at+1}),log({createdAt:at+1}),log({sourceSn:expected,createdAt:at+1,amount:'76.99'})])assert.equal(enrich(row,[],[parent]).historical!.association.state,'UNRESOLVED');
  const corrupt=log({sourceSn:expected,createdAt:at+1}),snap=corrupt.extra_evidence.snapshot;snap.sourceSupplement.digest='0'.repeat(64);corrupt.extra_evidence.canonical=canonicalize(snap);corrupt.source_digest=sha(snap);
  assert.equal(enrich(corrupt,[],[parent]).historical!.association.state,'UNRESOLVED');
  const first=log({id:901,sourceSn:expected,createdAt:at+1}),second=log({id:902,sourceSn:expected,createdAt:at+1});
  assert.equal(enrich(first,[second],[parent]).historical!.association.state,'AMBIGUOUS');
  assert.equal(resolveHistoricalReverseLinks(parent.ref,[first,second],[parent],access).state,'AMBIGUOUS');
});

test('owner original number and canonical proof must agree with the projected order fact', () => {
  const sourceSn='ORDER-BUSINESS-NUMBER';
  assert.equal(enrich(log({sourceSn}), [], [order({}, { number: 'WRONG-PROJECTED-NUMBER' })]).historical!.association.state, 'UNRESOLVED');
  assert.equal(enrich(log({sourceSn}), [], [order({}, { sourceDigest: '0'.repeat(64) })]).historical!.association.state, 'UNRESOLVED');
  assert.equal(enrich(log({sourceSn, action: 2 }), [], [order()]).historical!.association.state, 'UNRESOLVED');
});

test('distribution income is polymorphic; a task distribution links only to its finance document', () => {
  const entry = enrich(log({sourceSn:'DISTRIBUTION-BUSINESS-NUMBER'}), [distribution({ order_type: 2, level: 1 })]);
  assert.equal(entry.historical!.purposeCode, 'DISTRIBUTION_INCOME');
  assert.equal(entry.historical!.association.kind, 'DISTRIBUTION');
  assert.equal(entry.historical!.association.role, 'BENEFICIARY');
  assert.equal(entry.historical!.association.number, 'DISTRIBUTION-BUSINESS-NUMBER');
  assert.ok(entry.historical!.association.path!.startsWith('/finance/documents/'));
  assert.equal(entry.related.some(link => link.path?.startsWith('/orders/')), false);
});

test('distribution log precedes settlement time only when both original keys and amount close',()=>{
  const number='DISTRIBUTION-BUSINESS-NUMBER', parent=distribution();
  for(const seconds of [0,1,60])assert.equal(enrich(log({sourceSn:number,createdAt:at-seconds}),[parent]).historical!.association.state,'MATCHED');
  for(const row of [log({sourceSn:number,createdAt:at+1}),log({sourceSn:'WRONG-DISTRIBUTION',createdAt:at-1}),log({createdAt:at-1}),log({sourceSn:number,createdAt:at-1,amount:'76.99'})])assert.equal(enrich(row,[parent]).historical!.association.state,'UNRESOLVED');
  const first=log({id:901,sourceSn:number,createdAt:at-1}),second=log({id:902,sourceSn:number,createdAt:at-1});
  assert.equal(enrich(first,[parent,second]).historical!.association.state,'AMBIGUOUS');
  assert.equal(enrich(first,[distribution({status:1})]).historical!.association.state,'UNRESOLVED');
});

test('a matching numeric ID in both economic source entities stays ambiguous without an object link', () => {
  const entry = enrich(log({sourceSn:'ORDER-BUSINESS-NUMBER'}), [distribution({sn:'ORDER-BUSINESS-NUMBER'})], [order()]);
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
    enrich(log({sourceSn:'DISTRIBUTION-BUSINESS-NUMBER'}), [wrongAmount])]) {
    assert.equal(entry.historical!.association.state, 'UNRESOLVED');
    assert.equal(entry.historical!.association.path, null);
  }
});

test('relationship authorization denial discloses no object reference, number, path or role', () => {
  const denied: HistoricalRelationAccess = { adminId: 'limited', isBoss: false, orderRead: false, financeDocumentRead: false };
  const entries = [enrich(log({sourceSn:'ORDER-BUSINESS-NUMBER'}), [], [order({}, { objectReadable: false })], denied),
    enrich(log({sourceSn:'DISTRIBUTION-BUSINESS-NUMBER'}), [distribution()], [], denied),
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

test('withdrawal application and old order expose their precisely proved original logs in reverse', () => {
  const application = withdrawal(), debit = log({ id: 11437, action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 });
  const sources = [application, debit], before = JSON.stringify(sources);
  const result = resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, sources, [], access);
  assert.equal(result.state, 'MATCHED');
  assert.deepEqual(result.related, [{ ref: `HISTORY_EARNINGS:${debit.id}`, label: 'LOG-SELF-NUMBER', path: `/finance/documents/${encodeURIComponent('HISTORY_EARNINGS:' + debit.id)}` }]);
  const original = order(), income = log({sourceSn:'ORDER-BUSINESS-NUMBER'});
  const incomeResult = resolveHistoricalReverseLinks(original.ref, [income], [original], access);
  assert.equal(incomeResult.state, 'MATCHED');
  assert.equal(incomeResult.related[0]!.ref, `HISTORY_EARNINGS:${income.id}`);
  assert.equal(JSON.stringify(sources), before);
  const entry = enrich(application, [debit]);
  assert.equal(entry.historical!.association.state, 'MATCHED');
  assert.equal(entry.related[0]!.ref, `HISTORY_EARNINGS:${debit.id}`);
  assert.equal(entry.documentRef, `HISTORY_WITHDRAWAL:${application.id}`);
  assert.equal(entry.deltaCents, '-73400');
  assert.equal(entry.affectsCurrentWallet, false);
  assert.equal(entry.affectsCurrentLedger, false);
});

test('reverse relationship rejects amount, subject, original user, source, reversed time and missing proof mismatches', () => {
  const application = withdrawal(), base = { id: 11437, action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 };
  const mismatches = [log({ ...base, amount: '733.00' }), log({ ...base, sourceId: 5054 }), log({ ...base, createdAt: at - 1 }), log({ ...base, sourceSn: 'WRONG-SOURCE-SN' }), log({ ...base, sourceSn: null }),
    { ...log(base), subject_id: 'other-user' }, { ...log(base), source_system: 'another-source' },
    { ...log(base), source_digest: '0'.repeat(64) }];
  for (const candidate of mismatches) {
    const result = resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, [application, candidate], [], access);
    assert.equal(result.state, 'UNRESOLVED');
    assert.deepEqual(result.related, []);
  }
  const otherOriginal = withdrawal({ userId: 12 });
  assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${otherOriginal.id}`, [otherOriginal, log(base)], [], access).state, 'UNRESOLVED');
});

test('withdrawal association accepts separately sampled clocks only with both verified original keys', () => {
  const application=withdrawal(),base={id:11437,action:2,amount:'734.00',sourceId:5053,changeType:1002};
  for(const seconds of [0,1,60]){
    const debit=log({...base,createdAt:at+seconds}),sources=[application,debit];
    assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`,sources,[],access).state,'MATCHED');
    assert.deepEqual(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`,sources,[],access).related.map(link=>link.ref),[`HISTORY_EARNINGS:${debit.id}`]);
    assert.equal(enrich(debit,[application]).historical!.association.state,'MATCHED');
  }
  const brokenSupplement=log(base),snapshot=brokenSupplement.extra_evidence.snapshot;
  snapshot.sourceSupplement.digest='0'.repeat(64);
  brokenSupplement.extra_evidence.canonical=canonicalize(snapshot);brokenSupplement.source_digest=sha(snapshot);
  assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`,[application,brokenSupplement],[],access).state,'UNRESOLVED');
  assert.deepEqual(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`,[application,brokenSupplement],[],access).related,[]);
  const wrongSupplement=log(base),snap=wrongSupplement.extra_evidence.snapshot,raw=JSON.parse(snap.sourceSupplement.canonical);
  raw.sourceSn='OTHER-APPLICATION';snap.sourceSupplement.canonical=canonicalize(raw);snap.sourceSupplement.digest=sha(raw);
  wrongSupplement.extra_evidence.canonical=canonicalize(snap);wrongSupplement.source_digest=sha(snap);
  assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`,[application,wrongSupplement],[],access).state,'UNRESOLVED');
  assert.deepEqual(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`,[application,wrongSupplement],[],access).related,[]);
  assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`,[application,log(base)],[],{...access,financeDocumentRead:false}).state,'DENIED');
});

test('lookup of an old debit loads its siblings and original application before exposing the parent link',async()=>{
  const application=withdrawal(),debit=log({id:11437,action:2,amount:'734.00',sourceId:5053,changeType:1002,createdAt:at+1});
  for(const duplicate of [false,true]){
  const sibling=log({id:11438,action:2,amount:'734.00',sourceId:5053,changeType:1002,createdAt:at+1});
  const calls:string[]=[],fixture=new FinanceSqlFixture({history:duplicate?[application,debit,sibling]:[application,debit]});
  const client={query:async(sql:string,values:unknown[]=[])=>{calls.push(sql);
    if(sql.startsWith('SELECT to_regclass'))return{rows:[{ready:true}]};
    if(sql.includes('AS finance_version'))return{rows:[{finance_version:'fixture-version'}]};
    if(sql.includes('clock_timestamp()'))return{rows:[{at:iso(at+90)}]};
    if(sql.startsWith('WITH finance_lookup_'))return{rows:[{ref:`HISTORY_EARNINGS:${debit.id}`,document_count:'1',entry_count:'1'}]};
    if(sql.startsWith('WITH finance_scoped_rows'))return{rows:sql.includes('personal_finance_observation')?[debit]:[]};
    if(sql.startsWith('WITH finance_reverse_candidates')||sql.startsWith('WITH finance_reference_rows'))return fixture.query(sql,values);
    if(sql.startsWith('SELECT id,COALESCE(name'))return{rows:[{id:userId,name:'用户一'}]};
    throw Error('unexpected finance read');
  }};
  const filters=parseAdminFinanceFilters(new URLSearchParams({q:'LOG-SELF-NUMBER',period:'0',kind:'WITHDRAWAL'}),new Date(),false);
  try{
    const facts=await loadAdminFinanceFacts(client as never,{filters,lookup:{exact:true},page:1,pageSize:20},access);
    assert.equal(facts.lookupPage!.documentCount,1);assert.equal(facts.entries.length,1);
    assert.equal(facts.entries[0]!.historical!.association.state,duplicate?'AMBIGUOUS':'MATCHED');assert.equal(facts.entries[0]!.historical!.association.documentRef,duplicate?null:`HISTORY_WITHDRAWAL:${application.id}`);
    assert.equal(facts.entries[0]!.affectsCurrentWallet,false);assert.equal(facts.entries[0]!.affectsCurrentLedger,false);
    const reverse=calls.find(sql=>sql.startsWith('WITH finance_reverse_candidates'))!,reference=calls.find(sql=>sql.startsWith('WITH finance_reference_rows'))!;
    assert.match(reverse,/o\.source_kind='HISTORICAL_EARNINGS_LOG'/);assert.match(reverse,/o\.user_id/);assert.match(reference,/o\.source_type='LEGACY_MYSQL'/);assert.match(reference,/o\.source_id/);
  }finally{fixture.close();}
  }
});

test('reverse dual log or polymorphic source matches stay ambiguous without leaking candidate references', () => {
  const application = withdrawal(), base = { action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 };
  const duplicate = resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, [application, log({ ...base, id: 1 }), log({ ...base, id: 2 })], [], access);
  assert.equal(duplicate.state, 'AMBIGUOUS');
  assert.deepEqual(duplicate.related, []);
  assert.equal(enrich(log({...base,id:1}),[application,log({...base,id:2})]).historical!.association.state,'AMBIGUOUS');
  const original = order(), ambiguous = resolveHistoricalReverseLinks(original.ref, [log({sourceSn:'ORDER-BUSINESS-NUMBER'}), distribution({sn:'ORDER-BUSINESS-NUMBER'})], [original], access);
  assert.equal(ambiguous.state, 'AMBIGUOUS');
  assert.deepEqual(ambiguous.related, []);
});

test('reverse authorization is explicit and matches the original object and financial gates', () => {
  const application = withdrawal(), debit = log({ action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 });
  const denied = { ...access, financeDocumentRead: false };
  assert.deepEqual(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, [application, debit], [], denied), { state: 'DENIED', related: [], reasonCodes: [] });
  assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, [application, debit], []).state, 'DENIED');
  const original = order({}, { objectReadable: false });
  assert.equal(resolveHistoricalReverseLinks(original.ref, [log()], [original], access).state, 'DENIED');
});

test('a failed application links a unique original debit and supported return without granting accounting proof', () => {
  for (const changeType of [1003, 1004, 1005]) {
    const application = withdrawal({ status: 4 }), debit = log({ id: 11437, action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 });
    const returned = log({ id: 11438, action: 1, amount: '734.00', sourceId: 5053, changeType, createdAt: at + 60 });
    const sources = [application, debit, returned], before = JSON.stringify(sources);
    const result = resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, sources, [], access);
    assert.equal(result.state, 'MATCHED');
    assert.deepEqual(result.related.map(link => link.ref), [`HISTORY_EARNINGS:${debit.id}`, `HISTORY_EARNINGS:${returned.id}`]);
    const entry = enrich(returned, [application, debit]);
    assert.equal(entry.historical!.association.state, 'MATCHED');
    assert.equal(entry.historical!.association.documentRef, `HISTORY_WITHDRAWAL:${application.id}`);
    assert.equal(entry.historical!.channelState, 'UNVERIFIED');
    assert.equal(entry.deltaCents, '73400');
    assert.equal(entry.affectsCurrentWallet, false);
    assert.equal(entry.affectsCurrentLedger, false);
    assert.equal(entry.classification, 'HISTORICAL_UNCOVERED');
    assert.equal(entry.basisId, null);
    assert.equal(JSON.stringify(sources), before);
  }
});

test('return without exact debit, terminal status, time, gross or a unique supported event stays unresolved', () => {
  const application = withdrawal({ status: 4 }), debit = log({ id: 11437, action: 2, amount: '734.00', sourceId: 5053, changeType: 1002 });
  const base = { id: 11438, action: 1, amount: '734.00', sourceId: 5053, changeType: 1003, createdAt: at + 60 };
  const badReturns = [log({ ...base, amount: '733.00' }), log({ ...base, createdAt: at - 1 }), log({ ...base, sourceSn:'WRONG-SOURCE-SN' }), log({ ...base, action: 2 })];
  for (const candidate of badReturns) assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, [application, debit, candidate], [], access).state, 'UNRESOLVED');
  assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, [application, log(base)], [], access).state, 'UNRESOLVED');
  assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, [withdrawal({ status: 3 }), debit, log(base)], [], access).state, 'UNRESOLVED');
  assert.equal(resolveHistoricalReverseLinks(`HISTORY_WITHDRAWAL:${application.id}`, [application, debit, log(base), log({ ...base, id: 11439 })], [], access).state, 'AMBIGUOUS');
});
