import { createHash } from 'node:crypto';
import { SecurityApiError } from '../auth/security-core';
import { canonicalize } from '../supply/content-hash';
import { divideToScale } from '../supply/decimal';
import { conflict, forbidden, invalid, notFound } from '../supply/supply-util';
import { exactCents } from './personal-finance-read';

export type InvitationType = 'INVITER' | 'DISTRIBUTION_LEADER';
export type InvitationRelation = { type: InvitationType; childUserId: string; parentUserId: string; policyVersion: string };
export type LocalInvitationPolicy = { mode: 'LOCAL_CONTROLLED'; version: string; admittedSubjectIds: readonly string[]; allowedTypes: readonly InvitationType[]; binding: 'SINGLE_IMMUTABLE_PARENT'; codeCase: 'EXACT' | 'ASCII_UPPER' };
export type InvitationCode = { code: string; userId: string | null; active: boolean; ownerActive: boolean | null; ownerEligible: boolean | null; sourceType: 'NATIVE' | 'LEGACY_MYSQL' };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason: string) => new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', reason);
function cents(value: unknown): bigint { const n = BigInt(exactCents(value)); if (n < 0n) throw invalid('Nonnegative cents required'); return n; }
function utc(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid('Canonical UTC time required');
  return Date.parse(value);
}

/** Codes, graph and active flags must come from the server under graph locks.
 * Only returns a binding plan; no implicit registration or cross-type filling. */
export function planInvitationBinding(input: { childUserId: string; type: InvitationType; code: string; policyVersion: string }, policy: LocalInvitationPolicy | null,
  facts: { childActive: boolean; eligible: boolean | null; codes: readonly InvitationCode[]; relations: readonly InvitationRelation[]; graphComplete: boolean }) {
  if (!policy || policy.mode !== 'LOCAL_CONTROLLED' || typeof policy.version !== 'string' || !policy.version || policy.version.length > 128 || policy.binding !== 'SINGLE_IMMUTABLE_PARENT' || !['EXACT', 'ASCII_UPPER'].includes(policy.codeCase)) throw unavailable('INVITATION_POLICY_UNAVAILABLE');
  if (!['INVITER', 'DISTRIBUTION_LEADER'].includes(input.type) || !policy.allowedTypes.includes(input.type)) throw invalid('Unsupported invitation relation type');
  if (policy.version !== input.policyVersion) throw conflict('Invitation policy changed');
  if (!policy.admittedSubjectIds.includes(input.childUserId) || !facts.childActive || facts.eligible === false) throw forbidden('Invitation participant unavailable');
  if (facts.eligible !== true || !facts.graphComplete) throw unavailable('INVITATION_RELATION_UNKNOWN');
  if (typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.code)) throw invalid('Invitation code invalid');
  const normalize = (code: string) => policy.codeCase === 'ASCII_UPPER' ? code.toUpperCase() : code;
  const matches = facts.codes.filter(c => c.active && normalize(c.code) === normalize(input.code));
  if (!matches.length) throw notFound();
  if (matches.length !== 1) throw conflict('Invitation code is ambiguous');
  const parentUserId = matches[0]!.userId;
  if (!parentUserId) throw unavailable('INVITATION_PARENT_NOT_MAPPED');
  if (matches[0]!.ownerActive == null || matches[0]!.ownerEligible == null) throw unavailable('INVITATION_PARENT_UNKNOWN');
  if (!matches[0]!.ownerActive || !matches[0]!.ownerEligible) throw forbidden('Invitation parent unavailable');
  if (!policy.admittedSubjectIds.includes(parentUserId)) throw forbidden('Invitation parent is not admitted');
  if (parentUserId === input.childUserId) throw conflict('Self invitation is not allowed');
  const existing = facts.relations.filter(r => r.type === input.type && r.childUserId === input.childUserId);
  if (existing.length > 1) throw conflict('Invitation source has multiple parents');
  if (existing.length) {
    if (existing[0]!.parentUserId !== parentUserId) throw conflict('Invitation parent is immutable');
    return { relation: existing[0]!, replayed: true };
  }
  const parents = new Map<string, string>();
  for (const relation of facts.relations.filter(r => r.type === input.type)) {
    if (parents.has(relation.childUserId)) throw conflict('Invitation graph is ambiguous');
    parents.set(relation.childUserId, relation.parentUserId);
  }
  const visited = new Set([input.childUserId]);
  for (let node: string | undefined = parentUserId; node !== undefined; node = parents.get(node)) {
    if (visited.has(node)) throw conflict('Invitation cycle is not allowed');
    visited.add(node);
  }
  return { relation: { type: input.type, childUserId: input.childUserId, parentUserId, policyVersion: policy.version }, replayed: false };
}

export type RentalReferralRole = 'RENTER_REFERRAL' | 'OWNER_REFERRAL';
export type EarningSource = { kind: string; type: 'NATIVE' | 'LEGACY_MYSQL'; system: string; entity: string; id: string; digest: string; eventAt: string };
export type LocalEarningPolicy = {
  mode: 'LOCAL_CONTROLLED'; version: string; admittedSubjectIds: readonly string[];
  sourceKind: string; gameIds: readonly string[]; accountModes: readonly string[]; baseDefinition: string;
  ratios: Record<RentalReferralRole, { numerator: string; denominator: string }>;
  rounding: 'HALF_UP_CENT'; dueAfterMs: number;
};
/** Authoritative business facts and relation snapshots, never browser prices. */
export type RentalEarningFacts = {
  source: EarningSource; legacyBusiness: boolean; businessVerified: boolean;
  gameId: string; accountMode: string; renterUserId: string; ownerUserId: string;
  beneficiaryUserId: string; beneficiaryActive: boolean; beneficiaryEligible: boolean | null; walletCoverageKnown: boolean;
  role: RentalReferralRole; relation: InvitationRelation | null; relationDigest: string;
  baseCents: string; baseDefinition: string; baseDigest: string; coveredEconomicRoots: ReadonlySet<string>;
};
export type RentalEarning = {
  id: string; economicKey: string; source: EarningSource; beneficiaryUserId: string; role: RentalReferralRole;
  policyVersion: string; policyDigest: string; baseDigest: string; relationDigest: string; amountCents: string; dueAt: string; fingerprint: string;
  state: 'PENDING' | 'SETTLED' | 'REVOKED' | 'RECOVERY_REQUIRED'; fundsDisposition: 'PENDING' | 'SETTLED' | 'REVOKED';
  recoveryRequiredCents: string | null; version: string;
};
export type EarningLedgerPlan = { kind: 'EARNING_PENDING' | 'EARNING_SETTLED' | 'EARNING_REVOKED'; rootId: string; subjectUserId: string;
  lines: { accountCode: string; debitCents: string; creditCents: string; counterpartyUserId: string | null }[] };
/** Matches the root tuple in 0058; policy/version/time are attributes, not identity. */
export function earningEconomicKey(source: Pick<EarningSource, 'kind' | 'type' | 'system' | 'entity' | 'id'>, beneficiaryUserId: string, role: RentalReferralRole) {
  const tuple = [source.kind, source.type, source.system, source.entity, source.id, beneficiaryUserId, role];
  if (tuple.some(v => typeof v !== 'string' || !v || v.length > 128) || !['RENTER_REFERRAL', 'OWNER_REFERRAL'].includes(role)) throw invalid('Earning economic identity invalid');
  return canonicalize(tuple);
}
function earningLedger(root: RentalEarning, kind: EarningLedgerPlan['kind'], fromSettled = false): EarningLedgerPlan {
  const n = root.amountCents;
  const line = (accountCode: string, debitCents: string, creditCents: string, user: boolean) => ({ accountCode, debitCents, creditCents, counterpartyUserId: user ? root.beneficiaryUserId : null });
  const lines = n === '0' ? [] : kind === 'EARNING_PENDING' ? [line('DISTRIBUTION_EXPENSE', n, '0', false), line('WALLET_PENDING_EARNINGS', '0', n, true)]
    : kind === 'EARNING_SETTLED' ? [line('WALLET_PENDING_EARNINGS', n, '0', true), line('WALLET_AVAILABLE', '0', n, true)]
      : [line(fromSettled ? 'WALLET_AVAILABLE' : 'WALLET_PENDING_EARNINGS', n, '0', true), line('DISTRIBUTION_EXPENSE', '0', n, false)];
  return { kind, rootId: root.id, subjectUserId: root.beneficiaryUserId, lines };
}

export function prepareRentalEarning(facts: RentalEarningFacts, policy: LocalEarningPolicy | null, existing: RentalEarning | null) {
  const key = earningEconomicKey(facts.source, facts.beneficiaryUserId, facts.role);
  if (facts.legacyBusiness || facts.source.type !== 'NATIVE') throw conflict('Legacy earnings are observations, not new accruals');
  if (facts.coveredEconomicRoots.has(key)) throw conflict('Economic event already included in opening');
  if (!policy || policy.mode !== 'LOCAL_CONTROLLED' || typeof policy.version !== 'string' || !policy.version || policy.version.length > 128) throw unavailable('EARNING_POLICY_UNAVAILABLE');
  if (!policy.admittedSubjectIds.includes(facts.beneficiaryUserId) || !facts.beneficiaryActive || facts.beneficiaryEligible === false) throw forbidden('Earning beneficiary unavailable');
  if (facts.beneficiaryEligible !== true || !facts.walletCoverageKnown || !facts.businessVerified) throw unavailable('EARNING_SOURCE_UNKNOWN');
  if (facts.source.kind !== policy.sourceKind || !policy.gameIds.includes(facts.gameId) || !policy.accountModes.includes(facts.accountMode) || facts.baseDefinition !== policy.baseDefinition) throw conflict('Earning business is outside frozen policy');
  const partyUserId = facts.role === 'RENTER_REFERRAL' ? facts.renterUserId : facts.ownerUserId;
  if (!facts.relation || facts.relation.type !== 'DISTRIBUTION_LEADER' || facts.relation.childUserId !== partyUserId || facts.relation.parentUserId !== facts.beneficiaryUserId) throw unavailable('EARNING_RELATION_UNKNOWN');
  if ([facts.source.digest, facts.baseDigest, facts.relationDigest].some(d => !/^[0-9a-f]{64}$/.test(d))) throw invalid('Frozen earning digests required');
  const ratio = policy.ratios[facts.role], base = cents(facts.baseCents);
  if (!ratio || policy.rounding !== 'HALF_UP_CENT' || !Number.isSafeInteger(policy.dueAfterMs) || policy.dueAfterMs < 0) throw unavailable('EARNING_POLICY_INVALID');
  const numerator = cents(ratio.numerator), denominator = cents(ratio.denominator);
  if (denominator === 0n || numerator > denominator) throw unavailable('EARNING_POLICY_INVALID');
  const amountCents = divideToScale({ value: base * numerator, scale: 0 }, { value: denominator, scale: 0 }, 0).value.toString();
  const dueMillis = utc(facts.source.eventAt) + policy.dueAfterMs;
  if (!Number.isSafeInteger(dueMillis) || dueMillis > 253402300799999) throw unavailable('EARNING_POLICY_INVALID');
  const dueAt = new Date(dueMillis).toISOString(), policyDigest = sha(canonicalize(policy));
  const fingerprint = sha(canonicalize({ key, sourceDigest: facts.source.digest, eventAt: facts.source.eventAt, policyVersion: policy.version, policyDigest, baseDigest: facts.baseDigest, baseCents: facts.baseCents, relationDigest: facts.relationDigest, amountCents, dueAt }));
  if (existing) {
    if (existing.economicKey !== key || existing.fingerprint !== fingerprint) throw conflict('Earning root or frozen policy changed');
    return { root: existing, replayed: true, ledgerPlan: null };
  }
  const root: RentalEarning = { id: 'earning_' + sha(key), economicKey: key, source: { ...facts.source }, beneficiaryUserId: facts.beneficiaryUserId, role: facts.role,
    policyVersion: policy.version, policyDigest, baseDigest: facts.baseDigest, relationDigest: facts.relationDigest, amountCents, dueAt, fingerprint,
    state: 'PENDING', fundsDisposition: 'PENDING', recoveryRequiredCents: null, version: '1' };
  return { root, replayed: false, ledgerPlan: earningLedger(root, 'EARNING_PENDING') };
}

/** Caller must persist state, unique root/action, ledger, audit and receipt in one
 * transaction and obtain AVAILABLE from the same locked wallet. */
export function transitionRentalEarning(root: RentalEarning, action: 'SETTLE' | 'REVOKE', expectedVersion: string, now: string, availableCents: string | null) {
  if (root.version !== expectedVersion) throw conflict('Stale earning version');
  if (!/^[1-9]\d{0,18}$/.test(root.version)) throw invalid('Earning version invalid');
  const amount = cents(root.amountCents);
  const expectedDisposition = root.state === 'PENDING' ? 'PENDING' : root.state === 'SETTLED' || root.state === 'RECOVERY_REQUIRED' ? 'SETTLED' : root.state === 'REVOKED' ? 'REVOKED' : null;
  if (root.fundsDisposition !== expectedDisposition || root.state === 'RECOVERY_REQUIRED' && (root.recoveryRequiredCents !== root.amountCents || amount === 0n)) throw conflict('Earning state disagrees with posted funds');
  if (action !== 'SETTLE' && action !== 'REVOKE') throw invalid('Earning action invalid');
  if (action === 'SETTLE') {
    if (root.state === 'SETTLED') return { root, replayed: true, ledgerPlan: null };
    if (root.state !== 'PENDING' || root.fundsDisposition !== 'PENDING') throw conflict('Earning cannot settle');
    if (utc(now) < utc(root.dueAt)) throw conflict('Earning is not due');
    return { root: { ...root, state: 'SETTLED' as const, fundsDisposition: 'SETTLED' as const, version: (BigInt(root.version) + 1n).toString() }, replayed: false, ledgerPlan: earningLedger(root, 'EARNING_SETTLED') };
  }
  if (root.state === 'REVOKED' || root.state === 'RECOVERY_REQUIRED') return { root, replayed: true, ledgerPlan: null };
  if (root.state !== 'PENDING' && root.state !== 'SETTLED') throw conflict('Earning cannot revoke');
  if (root.state === 'SETTLED') {
    if (availableCents === null) throw unavailable('WALLET_KNOWLEDGE_UNKNOWN');
    const available = BigInt(exactCents(availableCents));
    if (available < 0n) throw unavailable('WALLET_RECONCILIATION_REQUIRED');
    if (available < amount) return { root: { ...root, state: 'RECOVERY_REQUIRED' as const, recoveryRequiredCents: amount.toString(), version: (BigInt(root.version) + 1n).toString() }, replayed: false, ledgerPlan: null };
  }
  return { root: { ...root, state: 'REVOKED' as const, fundsDisposition: 'REVOKED' as const, version: (BigInt(root.version) + 1n).toString() }, replayed: false, ledgerPlan: earningLedger(root, 'EARNING_REVOKED', root.state === 'SETTLED') };
}


