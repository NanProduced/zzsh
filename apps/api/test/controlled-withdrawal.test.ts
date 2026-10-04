import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteControlledWithdrawal, reserveControlledWithdrawal, claimControlledWithdrawal, finishControlledWithdrawal,
  ownerLocalWithdrawalPolicy, localWithdrawalDayWindow, countLocalWithdrawalQuota,localWithdrawalRequestKey,
  type ControlledWithdrawalPolicy, type ControlledWithdrawalFacts, type ControlledWithdrawalIntent, type ControlledPayoutEvidence } from '../src/finance/controlled-withdrawal';

// Explicit synthetic fixture only. No imported users or runtime default policy.
const policy: ControlledWithdrawalPolicy = { version: 'LOCAL_FIXTURE_WITHDRAWAL_v1', mode: 'LOCAL_CONTROLLED', destinationKind: 'BANK_CARD', admittedSubjectIds: ['fixture-u'], minCents: '200', maxCents: '1000000', maxAcceptedPerWindow: 2, frequencyBasis: 'ACCEPTED_INTENT', fee: { kind: 'FIXED', cents: '100' } };
const facts: ControlledWithdrawalFacts = { userId: 'fixture-u', active: true, localAdmissionEligible: true, coverageKnown: true, availableCents: '100000', ledgerRevision: '4', destination: { id: 'fixture-d', userId: 'fixture-u', mode: 'LOCAL_CONTROLLED', kind: 'BANK_CARD', active: true }, usage: { start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z', quotaCount: 0 }, now: '2026-10-03T01:00:00.000Z' };
const body = { amountCents: '12000', destinationId: 'fixture-d', policyVersion: policy.version, expectedWalletVersion: '4' };
const token = 'controlled-fixture-lease-token-0001', otherToken = 'controlled-fixture-lease-token-0002';
const now = '2026-10-03T01:00:00.000Z', until = '2026-10-03T01:00:30.000Z', later = '2026-10-03T01:00:31.000Z';
function reserve() { return reserveControlledWithdrawal('fixture-intent', quoteControlledWithdrawal(body, policy, facts)); }
function claim(intent = reserve().intent, at = now, t = token) { return claimControlledWithdrawal(intent, intent.operationVersion, t, '2026-10-03T01:01:00.000Z', at); }
function evidence(intent: ControlledWithdrawalIntent, outcome: ControlledPayoutEvidence['outcome']): ControlledPayoutEvidence {
  const base = { mode: 'LOCAL_CONTROLLED' as const, intentId: intent.id, payoutKey: intent.payoutKey };
  return outcome === 'SUCCEEDED' ? { ...base, outcome, reference: 'fixture-receipt', netCents: intent.netCents, feeCents: intent.feeCents }
    : outcome === 'FAILED' ? { ...base, outcome, reference: 'fixture-receipt', unpaidConfirmed: true, transferredCents: '0', chargedFeeCents: '0' }
      : { ...base, outcome };
}
function finish(intent: ControlledWithdrawalIntent, result: ControlledPayoutEvidence, at = now, t = token) { return finishControlledWithdrawal(intent, intent.operationVersion, t, result, at); }
function balanced(result: ReturnType<typeof reserve>['ledgerPlan']) {
  assert.equal(result.lines.reduce((n, l) => n + BigInt(l.debitCents), 0n), result.lines.reduce((n, l) => n + BigInt(l.creditCents), 0n));
}
test('controlled quote pins policy, destination, identity, subject admission and exact wallet revision', () => {
  const q = quoteControlledWithdrawal(body, policy, facts); assert.equal(q.grossCents, '12000'); assert.equal(q.netCents, '11900'); assert.equal(q.feeCents, '100');
  const cases: [unknown, unknown, unknown, number][] = [
    [body, null, facts, 503], [body, policy, { ...facts, userId: 'not-admitted' }, 403],
    [body, policy, { ...facts, destination: { ...facts.destination, userId: 'other' } }, 404],
    [body, policy, { ...facts, localAdmissionEligible: null }, 503], [body, policy, { ...facts, localAdmissionEligible: false }, 403],
    [body, policy, { ...facts, active: false }, 403], [body, policy, { ...facts, coverageKnown: false }, 503],
    [body, policy, { ...facts, availableCents: null }, 503], [body, policy, { ...facts, availableCents: '-1' }, 503],
    [body, policy, { ...facts, availableCents: '11999' }, 409], [body, policy, { ...facts, ledgerRevision: '5' }, 409],
    [{ ...body, policyVersion: 'another-policy' }, policy, facts, 409],
    [{ ...body, fee: '0' }, policy, facts, 400], [{ ...body, userId: 'other' }, policy, facts, 400],
    [body, policy, { ...facts, destination: { ...facts.destination, mode: 'REAL_BANK' } }, 403],
  ];
  for (const [b, p, f, status] of cases) assert.throws(() => quoteControlledWithdrawal(b as any, p as any, f as any), (e: any) => e.status === status);
});
test('controlled policy has explicit exact fee rounding and frequency, no fallback defaults', () => {
  const ratio = { ...policy, fee: { kind: 'RATIO' as const, numerator: '2', denominator: '100', rounding: 'HALF_UP_CENT' as const } };
  assert.equal(quoteControlledWithdrawal({ ...body, amountCents: '225' }, ratio, facts).feeCents, '5');
  const large = quoteControlledWithdrawal({ ...body, amountCents: '999999999999999999999999' }, { ...ratio, maxCents: '999999999999999999999999' }, { ...facts, availableCents: '999999999999999999999999' });
  assert.equal(large.feeCents, '20000000000000000000000'); assert.equal(large.netCents, '979999999999999999999999');
  for (const fee of [{ kind: 'RATIO', numerator: '2', denominator: '0', rounding: 'HALF_UP_CENT' }, { kind: 'RATIO', numerator: '2', denominator: '100', rounding: 'UNDEFINED' }, { kind: 'OTHER', numerator: '2', denominator: '100', rounding: 'HALF_UP_CENT' }]) assert.throws(() => quoteControlledWithdrawal(body, { ...policy, fee } as any, facts), (e: any) => e.status === 503);
  for (const amountCents of ['199', '1000001', '100']) assert.throws(() => quoteControlledWithdrawal({ ...body, amountCents }, policy, facts), (e: any) => e.status === 409);
  for (const amountCents of [12000, '12000.0', '-0', '-1']) assert.throws(() => quoteControlledWithdrawal({ ...body, amountCents }, policy, facts), (e: any) => e.status === 400);
  assert.throws(() => quoteControlledWithdrawal(body, policy, { ...facts, usage: { ...facts.usage, quotaCount: 2 } }), (e: any) => e.status === 409);
  assert.throws(() => quoteControlledWithdrawal(body, policy, { ...facts, now: facts.usage.end }), (e: any) => e.status === 503);
  assert.throws(() => quoteControlledWithdrawal(body, { ...policy, fee: { kind: 'FIXED', cents: '12000' } }, facts), (e: any) => e.status === 409);
});
test('Owner restored local rules bind bank and code fees to authoritative destination kind', () => {
  const bank = ownerLocalWithdrawalPolicy('BANK_CARD', ['fixture-u']), qr = ownerLocalWithdrawalPolicy('PAYMENT_CODE', ['fixture-u']);
  const localFacts = { ...facts, usage: { ...localWithdrawalDayWindow(facts.now), quotaCount: 0 } };
  const bankQuote = quoteControlledWithdrawal({ ...body, policyVersion: bank.version }, bank, localFacts);
  assert.equal(bankQuote.feeCents, '100'); assert.equal(bankQuote.acceptedAt, facts.now);
  const q = quoteControlledWithdrawal({ ...body, policyVersion: qr.version, amountCents: '225' }, qr, { ...localFacts, destination: { ...facts.destination, kind: 'PAYMENT_CODE' } });
  assert.equal(q.feeCents, '5'); assert.equal(q.netCents, '220');
  assert.throws(() => quoteControlledWithdrawal({ ...body, policyVersion: bank.version }, bank, { ...facts, destination: { ...facts.destination, kind: 'PAYMENT_CODE' } }), (e: any) => e.status === 409);
  assert.throws(() => quoteControlledWithdrawal({ ...body, policyVersion: bank.version }, ownerLocalWithdrawalPolicy('BANK_CARD', []), facts), (e: any) => e.status === 403);
  assert.throws(() => quoteControlledWithdrawal({ ...body, policyVersion: bank.version }, bank, facts), (e: any) => e.status === 503);
});
test('restored daily quota uses UTC+8, excludes certain failed intents and keeps unknown or conflicting intents counted', () => {
  const p = ownerLocalWithdrawalPolicy('BANK_CARD', ['fixture-u']), before = '2026-10-03T15:59:59.999Z', next = '2026-10-03T16:00:00.000Z';
  assert.deepEqual(localWithdrawalDayWindow(before), { start: '2026-10-02T16:00:00.000Z', end: next });
  assert.deepEqual(localWithdrawalDayWindow(next), { start: next, end: '2026-10-04T16:00:00.000Z' });
  const records: { state: ControlledWithdrawalIntent['state']; acceptedAt: string }[] = [
    { state: 'FAILED', acceptedAt: '2026-10-03T01:00:00.000Z' }, { state: 'UNKNOWN', acceptedAt: '2026-10-03T01:00:00.000Z' },
    { state: 'SUCCEEDED', acceptedAt: '2026-10-03T01:00:00.000Z' }, { state: 'RESERVED', acceptedAt: next }];
  assert.equal(countLocalWithdrawalQuota(records, p, before).quotaCount, 2); assert.equal(countLocalWithdrawalQuota(records, p, next).quotaCount, 1);
  assert.equal(countLocalWithdrawalQuota([{ state: 'RECONCILIATION_REQUIRED', acceptedAt: before }], p, before).quotaCount, 1);
});
test('reservation, successful payout and certain unpaid release conserve the same wallet ledger', () => {
  const reservation = reserve(); balanced(reservation.ledgerPlan); assert.equal(reservation.ledgerPlan.lines[0]!.accountCode, 'WALLET_AVAILABLE');
  for (const outcome of ['SUCCEEDED', 'FAILED'] as const) {
    const attempt = claim().intent, result = finish(attempt, evidence(attempt, outcome)); assert(result.ledgerPlan); balanced(result.ledgerPlan);
    assert.equal(result.ledgerPlan.kind, outcome === 'SUCCEEDED' ? 'PAYOUT' : 'RELEASE'); assert.equal(result.intent.state, outcome);
    assert.equal(result.intent.fundsDisposition, outcome === 'SUCCEEDED' ? 'PAYOUT_POSTED' : 'RELEASE_POSTED');
    if (outcome === 'SUCCEEDED') assert.deepEqual(result.ledgerPlan.lines.map(l => [l.accountCode, l.creditCents]), [['WALLET_RESERVED', '0'], ['PAYOUT_CLEARING', '11900'], ['WITHDRAW_FEE', '100']]);
  }
});
test('timeout keeps reserve and subsequent workers only query the original payout key', () => {
  const initial = claim(); assert.equal(initial.command, 'SUBMIT');
  const unknown = finish(initial.intent, evidence(initial.intent, 'TIMEOUT')); assert.equal(unknown.intent.state, 'UNKNOWN'); assert.equal(unknown.ledgerPlan, null); assert.equal(unknown.intent.fundsDisposition, 'RESERVED');
  const retry = claim(unknown.intent); assert.equal(retry.command, 'QUERY'); assert.equal(retry.intent.payoutKey, initial.intent.payoutKey);
  const paid = finish(retry.intent, evidence(retry.intent, 'SUCCEEDED')); assert.equal(paid.intent.state, 'SUCCEEDED'); assert.equal(paid.ledgerPlan?.kind, 'PAYOUT');
});
test('expired, superseded and mismatched workers cannot mutate an intent', () => {
  const first = claimControlledWithdrawal(reserve().intent, '1', token, until, now).intent;
  const before = JSON.stringify(first);
  assert.throws(() => finish(first, evidence(first, 'SUCCEEDED'), until), (e: any) => e.status === 409);
  assert.throws(() => finish(first, evidence(first, 'SUCCEEDED'), now, otherToken), (e: any) => e.status === 409);
  assert.throws(() => finishControlledWithdrawal(first, '1', token, evidence(first, 'SUCCEEDED'), now), (e: any) => e.status === 409);
  assert.equal(JSON.stringify(first), before);
  const replacement = claim(first, later, otherToken); assert.equal(replacement.command, 'QUERY'); assert.equal(replacement.intent.state, 'UNKNOWN'); assert.equal(replacement.intent.payoutKey, first.payoutKey);
  assert.throws(() => finish(replacement.intent, evidence(replacement.intent, 'SUCCEEDED'), later, token), (e: any) => e.status === 409);
  assert.throws(() => finish(replacement.intent, { ...evidence(replacement.intent, 'TIMEOUT'), intentId: 'other' }, later, otherToken), (e: any) => e.status === 409);
});
test('duplicate and late results do not add ledger; conflicting terminal retains original evidence and disposition', () => {
  const attempt = claim().intent, original = evidence(attempt, 'SUCCEEDED'), paid = finish(attempt, original);
  const query = claim(paid.intent).intent, replay = finish(query, original); assert.equal(replay.ledgerPlan, null); assert.equal(replay.intent.state, 'SUCCEEDED');
  const late = claim(replay.intent).intent, ack = finish(late, evidence(late, 'ACKNOWLEDGED')); assert.equal(ack.intent.state, 'SUCCEEDED'); assert.equal(ack.ledgerPlan, null);
  const probe = claim(ack.intent).intent, conflictResult = finish(probe, evidence(probe, 'FAILED'));
  assert.equal(conflictResult.intent.state, 'RECONCILIATION_REQUIRED'); assert.equal(conflictResult.ledgerPlan, null); assert.equal(conflictResult.intent.fundsDisposition, 'PAYOUT_POSTED'); assert.deepEqual(conflictResult.intent.terminal, paid.intent.terminal); assert(conflictResult.intent.conflictDigest);
  assert.throws(() => claim(conflictResult.intent), (e: any) => e.status === 409);
});
test('partial or uncertain failure never releases reserve and mismatched paid amounts require reconciliation', () => {
  for (const patch of [{ unpaidConfirmed: false }, { transferredCents: '1' }, { chargedFeeCents: '1' }]) {
    const attempt = claim().intent, result = finish(attempt, { ...evidence(attempt, 'FAILED'), ...patch } as any);
    assert.equal(result.intent.state, 'RECONCILIATION_REQUIRED'); assert.equal(result.intent.fundsDisposition, 'RESERVED'); assert.equal(result.ledgerPlan, null);
  }
  const attempt = claim().intent, badPaid = finish(attempt, { ...evidence(attempt, 'SUCCEEDED'), netCents: '12000' } as any);
  assert.equal(badPaid.intent.state, 'RECONCILIATION_REQUIRED'); assert.equal(badPaid.ledgerPlan, null);
  assert.throws(() => finish(attempt, { ...evidence(attempt, 'TIMEOUT'), outcome: 'BOGUS' } as any), (e: any) => e.status === 400);
});

test('declared local original request key is stable across retries and unique by target revision',()=>{
 const key=localWithdrawalRequestKey('admission','1','bank','1');assert.match(key,/^local-withdrawal-[0-9a-f]{48}$/);assert.equal(localWithdrawalRequestKey('admission','1','bank','1'),key);
 for(const args of [['admission','1','code','1'],['admission','2','bank','1'],['admission','1','bank','2']])assert.notEqual(localWithdrawalRequestKey(...args as [string,string,string,string]),key);
});
