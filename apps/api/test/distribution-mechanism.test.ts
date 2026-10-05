import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInvitationBinding, prepareRentalEarning, transitionRentalEarning, earningEconomicKey,
  type LocalInvitationPolicy, type InvitationCode, type InvitationRelation, type LocalEarningPolicy, type RentalEarningFacts } from '../src/finance/distribution-mechanism';

const invitePolicy: LocalInvitationPolicy = { mode: 'LOCAL_CONTROLLED', version: 'LOCAL_FIXTURE_INVITE_v1', admittedSubjectIds: ['a', 'b', 'c', 'd'], allowedTypes: ['INVITER', 'DISTRIBUTION_LEADER'], binding: 'SINGLE_IMMUTABLE_PARENT', codeCase: 'EXACT' };
const code: InvitationCode = { code: 'Fixture_B', userId: 'b', active: true, ownerActive: true, ownerEligible: true, sourceType: 'NATIVE' };
const binding = { childUserId: 'a', type: 'INVITER' as const, code: code.code, policyVersion: invitePolicy.version };
const inviteFacts = { childActive: true, eligible: true, codes: [code], relations: [] as InvitationRelation[], graphComplete: true };
function relation(childUserId: string, parentUserId: string, type: InvitationRelation['type'] = 'INVITER'): InvitationRelation { return { type, childUserId, parentUserId, policyVersion: 'frozen-relation-fixture-v1' }; }

const earningPolicy: LocalEarningPolicy = { mode: 'LOCAL_CONTROLLED', version: 'LOCAL_FIXTURE_EARNING_v1', admittedSubjectIds: ['b'], sourceKind: 'VERIFIED_RENTAL_SETTLEMENT_FIXTURE', gameIds: ['fixture-game'], accountModes: ['fixture-manual'], baseDefinition: 'EXPLICIT_VERIFIED_FIXTURE_BASIS', ratios: { RENTER_REFERRAL: { numerator: '1', denominator: '20' }, OWNER_REFERRAL: { numerator: '3', denominator: '100' } }, rounding: 'HALF_UP_CENT', dueAfterMs: 7000 };
const facts: RentalEarningFacts = { source: { kind: earningPolicy.sourceKind, type: 'NATIVE', system: 'zzsh-fixture', entity: 'rental_order', id: 'fixture-order', digest: 'a'.repeat(64), eventAt: '2026-10-03T01:00:00.000Z' }, legacyBusiness: false, businessVerified: true, gameId: 'fixture-game', accountMode: 'fixture-manual', renterUserId: 'a', ownerUserId: 'c', beneficiaryUserId: 'b', beneficiaryActive: true, beneficiaryEligible: true, walletCoverageKnown: true, role: 'RENTER_REFERRAL', relation: relation('a', 'b', 'DISTRIBUTION_LEADER'), relationDigest: 'b'.repeat(64), baseCents: '12000', baseDefinition: earningPolicy.baseDefinition, baseDigest: 'c'.repeat(64), coveredEconomicRoots: new Set() };
function earning() { return prepareRentalEarning(facts, earningPolicy, null).root; }
function settled() { const r = earning(); return transitionRentalEarning(r, 'SETTLE', r.version, r.dueAt, null).root; }
function balanced(plan: ReturnType<typeof prepareRentalEarning>['ledgerPlan']) { assert(plan); assert.equal(plan.lines.reduce((n, l) => n + BigInt(l.debitCents), 0n), plan.lines.reduce((n, l) => n + BigInt(l.creditCents), 0n)); }

test('inviter and distribution leader remain independent and same parent replay keeps frozen relation', () => {
  const first = planInvitationBinding(binding, invitePolicy, inviteFacts); assert.equal(first.relation.parentUserId, 'b');
  const another = planInvitationBinding({ ...binding, type: 'DISTRIBUTION_LEADER', code: 'Fixture_C' }, invitePolicy, { ...inviteFacts, codes: [{ ...code, code: 'Fixture_C', userId: 'c' }], relations: [first.relation] });
  assert.equal(another.relation.parentUserId, 'c'); assert.equal(another.relation.type, 'DISTRIBUTION_LEADER');
  const replay = planInvitationBinding(binding, invitePolicy, { ...inviteFacts, relations: [first.relation] }); assert.equal(replay.replayed, true); assert.deepEqual(replay.relation, first.relation);
  assert.throws(() => planInvitationBinding({ ...binding, code: 'Fixture_C' }, invitePolicy, { ...inviteFacts, codes: [{ ...code, code: 'Fixture_C', userId: 'c' }], relations: [first.relation] }), (e: any) => e.status === 409);
});
test('binding rejects self, cycle, ambiguous code and unverified legacy parent without inventing an identity', () => {
  const cases: [any, number][] = [
    [{ ...inviteFacts, codes: [{ ...code, userId: 'a' }] }, 409],
    [{ ...inviteFacts, relations: [relation('b', 'c'), relation('c', 'a')] }, 409],
    [{ ...inviteFacts, relations: [relation('b', 'c'), relation('c', 'b')] }, 409],
    [{ ...inviteFacts, codes: [code, { ...code, sourceType: 'LEGACY_MYSQL' }] }, 409],
    [{ ...inviteFacts, codes: [{ ...code, userId: null, sourceType: 'LEGACY_MYSQL' }] }, 503],
    [{ ...inviteFacts, codes: [{ ...code, ownerActive: null }] }, 503],
    [{ ...inviteFacts, codes: [{ ...code, ownerActive: false }] }, 403],
    [{ ...inviteFacts, graphComplete: false }, 503], [{ ...inviteFacts, eligible: null }, 503], [{ ...inviteFacts, eligible: undefined }, 503],
    [{ ...inviteFacts, childActive: false }, 403], [{ ...inviteFacts, codes: [] }, 404],
  ];
  for (const [f, status] of cases) assert.throws(() => planInvitationBinding(binding, invitePolicy, f), (e: any) => e.status === status);
  assert.throws(() => planInvitationBinding(binding, null, inviteFacts), (e: any) => e.status === 503);
  assert.throws(() => planInvitationBinding({ ...binding, type: 'UNKNOWN' } as any, invitePolicy, inviteFacts), (e: any) => e.status === 400);
});
test('code case comes from explicit policy and cross-type edges do not create a false cycle', () => {
  assert.throws(() => planInvitationBinding({ ...binding, code: 'fixture_b' }, invitePolicy, inviteFacts), (e: any) => e.status === 404);
  assert.equal(planInvitationBinding({ ...binding, code: 'fixture_b' }, { ...invitePolicy, codeCase: 'ASCII_UPPER' }, inviteFacts).relation.parentUserId, 'b');
  assert.equal(planInvitationBinding(binding, invitePolicy, { ...inviteFacts, relations: [relation('b', 'a', 'DISTRIBUTION_LEADER')] }).replayed, false);
});
test('new earnings require authoritative native facts, explicit policy, verified leader and admitted wallet', () => {
  const result = prepareRentalEarning(facts, earningPolicy, null); assert.equal(result.root.amountCents, '600'); assert.equal(result.root.dueAt, '2026-10-03T01:00:07.000Z'); balanced(result.ledgerPlan);
  const cases: [any, any, number][] = [
    [facts, null, 503], [{ ...facts, legacyBusiness: true }, earningPolicy, 409],
    [{ ...facts, source: { ...facts.source, type: 'LEGACY_MYSQL' } }, earningPolicy, 409],
    [{ ...facts, businessVerified: false }, earningPolicy, 503], [{ ...facts, beneficiaryEligible: null }, earningPolicy, 503], [{ ...facts, beneficiaryEligible: undefined }, earningPolicy, 503],
    [{ ...facts, walletCoverageKnown: false }, earningPolicy, 503], [{ ...facts, beneficiaryActive: false }, earningPolicy, 403],
    [{ ...facts, accountMode: 'another-mode' }, earningPolicy, 409], [{ ...facts, baseDefinition: 'browser-profit' }, earningPolicy, 409],
    [{ ...facts, relation: relation('a', 'b', 'INVITER') }, earningPolicy, 503],
    [{ ...facts, coveredEconomicRoots: new Set([earningEconomicKey(facts.source, 'b', facts.role)]) }, earningPolicy, 409],
  ];
  for (const [f, p, status] of cases) assert.throws(() => prepareRentalEarning(f, p, null), (e: any) => e.status === status);
});
test('policy change cannot reaccrue same economic root while legal roles and source systems stay distinct', () => {
  const original = earning(); const replay = prepareRentalEarning(facts, earningPolicy, original); assert.equal(replay.replayed, true); assert.equal(replay.ledgerPlan, null);
  assert.throws(() => prepareRentalEarning(facts, { ...earningPolicy, version: 'LOCAL_FIXTURE_EARNING_v2' }, original), (e: any) => e.status === 409);
  assert.throws(() => prepareRentalEarning(facts, { ...earningPolicy, ratios: { ...earningPolicy.ratios, RENTER_REFERRAL: { numerator: '1', denominator: '10' } } }, original), (e: any) => e.status === 409);
  assert.throws(() => prepareRentalEarning({ ...facts, baseCents: '12001' }, earningPolicy, original), (e: any) => e.status === 409);
  const owner = prepareRentalEarning({ ...facts, role: 'OWNER_REFERRAL', relation: relation('c', 'b', 'DISTRIBUTION_LEADER') }, earningPolicy, null).root;
  assert.notEqual(owner.id, original.id); assert.equal(owner.amountCents, '360');
  const otherSystem = prepareRentalEarning({ ...facts, source: { ...facts.source, system: 'another-fixture' } }, earningPolicy, null).root; assert.notEqual(otherSystem.id, original.id);
});
test('settlement observes exact due boundary and frozen amount; pending revocation never touches available', () => {
  const root = earning(); assert.throws(() => transitionRentalEarning(root, 'SETTLE', root.version, '2026-10-03T01:00:06.999Z', null), (e: any) => e.status === 409);
  const paid = transitionRentalEarning(root, 'SETTLE', root.version, root.dueAt, null); assert.equal(paid.root.state, 'SETTLED'); balanced(paid.ledgerPlan);
  assert.equal(paid.ledgerPlan!.lines[1]!.accountCode, 'WALLET_AVAILABLE');
  assert.equal(transitionRentalEarning(paid.root, 'SETTLE', paid.root.version, root.dueAt, null).ledgerPlan, null);
  const revoked = transitionRentalEarning(root, 'REVOKE', root.version, root.dueAt, null); assert.equal(revoked.root.state, 'REVOKED'); balanced(revoked.ledgerPlan); assert(revoked.ledgerPlan!.lines.every(l => l.accountCode !== 'WALLET_AVAILABLE'));
  assert.throws(() => transitionRentalEarning(revoked.root, 'SETTLE', revoked.root.version, root.dueAt, null), (e: any) => e.status === 409);
});
test('settled reversal uses only available or records recovery required without negative wallet or other buckets', () => {
  const root = settled();
  const enough = transitionRentalEarning(root, 'REVOKE', root.version, root.dueAt, '600'); balanced(enough.ledgerPlan); assert.equal(enough.ledgerPlan!.lines[0]!.accountCode, 'WALLET_AVAILABLE');
  assert.equal(transitionRentalEarning(enough.root, 'REVOKE', enough.root.version, root.dueAt, '0').ledgerPlan, null);
  const insufficient = transitionRentalEarning(root, 'REVOKE', root.version, root.dueAt, '599'); assert.equal(insufficient.root.state, 'RECOVERY_REQUIRED'); assert.equal(insufficient.root.fundsDisposition, 'SETTLED'); assert.equal(insufficient.root.recoveryRequiredCents, '600'); assert.equal(insufficient.ledgerPlan, null);
  assert.equal(transitionRentalEarning(insufficient.root, 'REVOKE', insufficient.root.version, root.dueAt, '10000').ledgerPlan, null);
  assert.throws(() => transitionRentalEarning(root, 'REVOKE', root.version, root.dueAt, null), (e: any) => e.status === 503);
  assert.throws(() => transitionRentalEarning(root, 'REVOKE', '1', root.dueAt, '600'), (e: any) => e.status === 409);
  assert.throws(() => transitionRentalEarning({ ...root, fundsDisposition: 'PENDING' }, 'REVOKE', root.version, root.dueAt, '600'), (e: any) => e.status === 409);
});
test('zero earning freezes a root and policy; exact ratios reject zero denominator or unsupported rounding', () => {
  const zero = prepareRentalEarning({ ...facts, baseCents: '1' }, earningPolicy, null); assert.equal(zero.root.amountCents, '0'); assert.deepEqual(zero.ledgerPlan!.lines, []);
  assert.throws(() => prepareRentalEarning({ ...facts, baseCents: '1' }, { ...earningPolicy, version: 'another-policy' }, zero.root), (e: any) => e.status === 409);
  for (const patch of [{ rounding: 'UNDEFINED' }, { ratios: { ...earningPolicy.ratios, RENTER_REFERRAL: { numerator: '1', denominator: '0' } } }, { dueAfterMs: -1 }]) assert.throws(() => prepareRentalEarning(facts, { ...earningPolicy, ...patch } as any, null), (e: any) => e.status === 503);
  assert.throws(() => prepareRentalEarning({ ...facts, baseCents: 1 } as any, earningPolicy, null), (e: any) => e.status === 400);
});
