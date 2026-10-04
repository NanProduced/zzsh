import { createHash } from 'node:crypto';
import { SecurityApiError } from '../auth/security-core';
import { conflict, ensureOnlyFields, forbidden, invalid, notFound, requiredString } from '../supply/supply-util';
import { canonicalize } from '../supply/content-hash';
import { divideToScale } from '../supply/decimal';
import { exactCents } from './personal-finance-read';

export type ControlledWithdrawalPolicy = {
  version: string;
  mode: 'LOCAL_CONTROLLED';
  destinationKind: 'BANK_CARD' | 'PAYMENT_CODE';
  admittedSubjectIds: readonly string[];
  minCents: string;
  maxCents: string;
  maxAcceptedPerWindow: number;
  frequencyBasis: 'ACCEPTED_INTENT' | 'ACTIVE_OR_SUCCEEDED';
  fee: { kind: 'FIXED'; cents: string } | { kind: 'RATIO'; numerator: string; denominator: string; rounding: 'HALF_UP_CENT' };
};
/** These are server facts read under the stable user lock, never request fields.
 * The persistence adapter must recheck them and write the returned plan atomically. */
export type ControlledWithdrawalFacts = {
  userId: string;
  active: boolean;
  /** Explicit eligibility for this bounded local test, never a real KYC claim. */
  localAdmissionEligible: boolean | null;
  coverageKnown: boolean;
  availableCents: string | null;
  ledgerRevision: string;
  destination: { id: string; userId: string; mode: 'LOCAL_CONTROLLED'; kind: 'BANK_CARD' | 'PAYMENT_CODE'; active: boolean };
  usage: { start: string; end: string; quotaCount: number };
  now: string;
};
export type ControlledWithdrawalQuote = {
  userId: string; destinationId: string; policyVersion: string; ledgerRevision: string;
  acceptedAt: string;
  currency: 'CNY'; grossCents: string; netCents: string; feeCents: string; mode: 'LOCAL_CONTROLLED';
};
export type WithdrawalState = 'RESERVED' | 'SUBMITTING' | 'PROCESSING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED';
type Terminal = { state: 'SUCCEEDED' | 'FAILED'; evidenceDigest: string; reference: string };
export type ControlledWithdrawalIntent = ControlledWithdrawalQuote & {
  id: string; payoutKey: string; state: WithdrawalState; operationVersion: string;
  fundsDisposition: 'RESERVED' | 'PAYOUT_POSTED' | 'RELEASE_POSTED';
  terminal: Terminal | null; conflictDigest: string | null;
  lease: { tokenHash: string; until: string } | null;
};
export type ControlledPayoutEvidence = {
  mode: 'LOCAL_CONTROLLED'; intentId: string; payoutKey: string;
} & (
  | { outcome: 'ACKNOWLEDGED' }
  | { outcome: 'TIMEOUT' }
  | { outcome: 'SUCCEEDED'; reference: string; netCents: string; feeCents: string }
  | { outcome: 'FAILED'; reference: string; unpaidConfirmed: boolean; transferredCents: string; chargedFeeCents: string }
);
export type WithdrawalLedgerPlan = {
  kind: 'RESERVE' | 'RELEASE' | 'PAYOUT'; intentId: string; subjectUserId: string;
  lines: { accountCode: string; debitCents: string; creditCents: string; counterpartyUserId: string | null }[];
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** One declared local test action per immutable admission/target revision. */
export function localWithdrawalRequestKey(admissionId:string,admissionRevision:string,destinationId:string,destinationRevision:string){
  return 'local-withdrawal-'+sha(canonicalize(['LOCAL_CONTROLLED',admissionId,admissionRevision,destinationId,destinationRevision])).slice(0,48);
}
const unavailable = (reason: string) => new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', reason);
function unsigned(value: unknown): bigint {
  const amount = BigInt(exactCents(value));
  if (amount < 0n) throw invalid('Unsigned cents required');
  return amount;
}
function time(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid('UTC time required');
  return Date.parse(value);
}
function revision(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw invalid('Exact revision required');
  return BigInt(value);
}
function plan(intent: Pick<ControlledWithdrawalIntent, 'id' | 'userId' | 'grossCents' | 'netCents' | 'feeCents'>, kind: WithdrawalLedgerPlan['kind']): WithdrawalLedgerPlan {
  const line = (accountCode: string, debitCents: string, creditCents: string, user = true) => ({ accountCode, debitCents, creditCents, counterpartyUserId: user ? intent.userId : null });
  const lines = kind === 'RESERVE'
    ? [line('WALLET_AVAILABLE', intent.grossCents, '0'), line('WALLET_RESERVED', '0', intent.grossCents)]
    : kind === 'RELEASE'
      ? [line('WALLET_RESERVED', intent.grossCents, '0'), line('WALLET_AVAILABLE', '0', intent.grossCents)]
      : [line('WALLET_RESERVED', intent.grossCents, '0'), line('PAYOUT_CLEARING', '0', intent.netCents, false), ...(intent.feeCents === '0' ? [] : [line('WITHDRAW_FEE', '0', intent.feeCents, false)])];
  return { kind, intentId: intent.id, subjectUserId: intent.userId, lines };
}

/** No runtime default policy and no real destination can enter this seam. */
export function quoteControlledWithdrawal(body: Record<string, unknown>, policy: ControlledWithdrawalPolicy | null, facts: ControlledWithdrawalFacts): ControlledWithdrawalQuote {
  ensureOnlyFields(body, ['amountCents', 'destinationId', 'policyVersion', 'expectedWalletVersion']);
  const amount = unsigned(body.amountCents), destinationId = requiredString(body, 'destinationId', 128);
  const policyVersion = requiredString(body, 'policyVersion', 128), expected = requiredString(body, 'expectedWalletVersion', 128);
  if (!policy || policy.mode !== 'LOCAL_CONTROLLED') throw unavailable('WITHDRAW_POLICY_UNAVAILABLE');
  if (!policy.admittedSubjectIds.includes(facts.userId)) throw forbidden('Subject is not admitted to controlled withdrawal');
  if (!facts.active) throw forbidden('Account unavailable');
  if (facts.destination.userId !== facts.userId || facts.destination.id !== destinationId) throw notFound();
  if (!facts.destination.active || facts.destination.mode !== 'LOCAL_CONTROLLED') throw forbidden('Controlled destination required');
  if (facts.localAdmissionEligible === null) throw unavailable('WITHDRAW_LOCAL_ADMISSION_UNKNOWN');
  if (!facts.localAdmissionEligible) throw forbidden('Controlled local admission requirement is not satisfied');
  if (!facts.coverageKnown || facts.availableCents === null) throw unavailable('SOURCE_COVERAGE_UNKNOWN');
  if (policy.destinationKind !== facts.destination.kind || policy.version !== policyVersion || revision(expected) !== revision(facts.ledgerRevision)) throw conflict('Withdrawal destination, policy or wallet changed');
  const min = unsigned(policy.minCents), max = unsigned(policy.maxCents);
  if (min === 0n || max < min || !['ACCEPTED_INTENT', 'ACTIVE_OR_SUCCEEDED'].includes(policy.frequencyBasis) || !Number.isSafeInteger(policy.maxAcceptedPerWindow) || policy.maxAcceptedPerWindow < 1) throw unavailable('WITHDRAW_POLICY_INVALID');
  const now = time(facts.now), start = time(facts.usage.start), end = time(facts.usage.end);
  if (start >= end || now < start || now >= end || !Number.isSafeInteger(facts.usage.quotaCount) || facts.usage.quotaCount < 0) throw unavailable('WITHDRAW_FREQUENCY_UNKNOWN');
  if (policy.frequencyBasis === 'ACTIVE_OR_SUCCEEDED') {
    const day = localWithdrawalDayWindow(facts.now);
    if (facts.usage.start !== day.start || facts.usage.end !== day.end) throw unavailable('WITHDRAW_FREQUENCY_UNKNOWN');
  }
  if (amount < min || amount > max || facts.usage.quotaCount >= policy.maxAcceptedPerWindow) throw conflict('Withdrawal limit reached');
  let fee: bigint;
  if (policy.fee.kind === 'FIXED') fee = unsigned(policy.fee.cents);
  else if (policy.fee.kind === 'RATIO') {
    const numerator = unsigned(policy.fee.numerator), denominator = unsigned(policy.fee.denominator);
    if (denominator === 0n || numerator > denominator || policy.fee.rounding !== 'HALF_UP_CENT') throw unavailable('WITHDRAW_POLICY_INVALID');
    fee = divideToScale({ value: amount * numerator, scale: 0 }, { value: denominator, scale: 0 }, 0).value;
  } else throw unavailable('WITHDRAW_POLICY_INVALID');
  if (amount <= fee) throw conflict('Net payout must be positive');
  const available = BigInt(exactCents(facts.availableCents));
  if (available < 0n) throw unavailable('WALLET_RECONCILIATION_REQUIRED');
  if (amount > available) throw conflict('Insufficient available funds');
  return { userId: facts.userId, destinationId, policyVersion, ledgerRevision: facts.ledgerRevision, acceptedAt: facts.now, currency: 'CNY', grossCents: amount.toString(), netCents: (amount - fee).toString(), feeCents: fee.toString(), mode: 'LOCAL_CONTROLLED' };
}

/** Owner selected these restored rules for this local round only. Admission
 * remains an explicit server-owned cohort from a separately reviewed write set. */
export function ownerLocalWithdrawalPolicy(destinationKind: 'BANK_CARD' | 'PAYMENT_CODE', admittedSubjectIds: readonly string[]): ControlledWithdrawalPolicy {
  if (!['BANK_CARD', 'PAYMENT_CODE'].includes(destinationKind)) throw invalid('Controlled destination kind required');
  return { mode: 'LOCAL_CONTROLLED', destinationKind, version: 'OWNER_LOCAL_RESTORED_20261003_v1_' + destinationKind,
    admittedSubjectIds: [...admittedSubjectIds], minCents: '200', maxCents: '1000000', maxAcceptedPerWindow: 2, frequencyBasis: 'ACTIVE_OR_SUCCEEDED',
    fee: destinationKind === 'BANK_CARD' ? { kind: 'FIXED', cents: '100' } : { kind: 'RATIO', numerator: '2', denominator: '100', rounding: 'HALF_UP_CENT' } };
}
export function localWithdrawalDayWindow(now: string) {
  const offset = 8 * 60 * 60 * 1000, day = 24 * 60 * 60 * 1000;
  const start = Math.floor((time(now) + offset) / day) * day - offset;
  return { start: new Date(start).toISOString(), end: new Date(start + day).toISOString() };
}
export function countLocalWithdrawalQuota(records: readonly { state: WithdrawalState; acceptedAt: string }[], policy: ControlledWithdrawalPolicy, now: string) {
  const window = localWithdrawalDayWindow(now), start = time(window.start), end = time(window.end);
  if (!['ACCEPTED_INTENT', 'ACTIVE_OR_SUCCEEDED'].includes(policy.frequencyBasis)) throw unavailable('WITHDRAW_POLICY_INVALID');
  let quotaCount = 0;
  for (const record of records) {
    if (!['RESERVED', 'SUBMITTING', 'PROCESSING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(record.state)) throw unavailable('WITHDRAW_FREQUENCY_UNKNOWN');
    const at = time(record.acceptedAt);
    if (at >= start && at < end && (policy.frequencyBasis === 'ACCEPTED_INTENT' || record.state !== 'FAILED')) quotaCount++;
  }
  return { ...window, quotaCount };
}

export function reserveControlledWithdrawal(id: string, quote: ControlledWithdrawalQuote) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw invalid('Intent id required');
  const gross = unsigned(quote.grossCents), net = unsigned(quote.netCents), fee = unsigned(quote.feeCents);
  time(quote.acceptedAt);
  if (quote.mode !== 'LOCAL_CONTROLLED' || quote.currency !== 'CNY' || net === 0n || gross !== net + fee) throw invalid('Frozen payout amounts are invalid');
  const intent: ControlledWithdrawalIntent = { ...quote, id, payoutKey: 'controlled-withdrawal-' + sha(id), state: 'RESERVED', operationVersion: '1', fundsDisposition: 'RESERVED', terminal: null, conflictDigest: null, lease: null };
  return { intent, ledgerPlan: plan(intent, 'RESERVE') };
}

export function claimControlledWithdrawal(intent: ControlledWithdrawalIntent, expectedVersion: string, token: string, until: string, now: string) {
  if (intent.mode !== 'LOCAL_CONTROLLED' || intent.state === 'RECONCILIATION_REQUIRED') throw conflict('Withdrawal requires reconciliation');
  if (revision(expectedVersion) !== revision(intent.operationVersion)) throw conflict('Stale withdrawal operation');
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || time(until) <= time(now)) throw invalid('Valid worker lease required');
  if (intent.lease && time(intent.lease.until) > time(now)) throw conflict('Withdrawal worker already holds a lease');
  const command = intent.state === 'RESERVED' ? 'SUBMIT' : 'QUERY';
  // A crashed SUBMITTING attempt might already have paid. Its successor queries
  // the original key instead of creating a second payout.
  const state = intent.state === 'RESERVED' ? 'SUBMITTING' : intent.state === 'SUBMITTING' ? 'UNKNOWN' : intent.state;
  return { command, intent: { ...intent, state, operationVersion: (revision(intent.operationVersion) + 1n).toString(), lease: { tokenHash: sha(token), until } } as ControlledWithdrawalIntent };
}

export function finishControlledWithdrawal(intent: ControlledWithdrawalIntent, expectedVersion: string, token: string, evidence: ControlledPayoutEvidence, now: string) {
  if (intent.mode !== 'LOCAL_CONTROLLED' || !intent.lease || intent.lease.tokenHash !== sha(token) || time(intent.lease.until) <= time(now) || revision(intent.operationVersion) !== revision(expectedVersion)) throw conflict('Stale or expired withdrawal lease');
  if (evidence.mode !== 'LOCAL_CONTROLLED' || evidence.intentId !== intent.id || evidence.payoutKey !== intent.payoutKey) throw conflict('Payout evidence belongs to another intent');
  if (!['ACKNOWLEDGED', 'TIMEOUT', 'SUCCEEDED', 'FAILED'].includes(evidence.outcome)) throw invalid('Unknown controlled payout result');
  let state = intent.state, terminal = intent.terminal, conflictDigest = intent.conflictDigest, fundsDisposition = intent.fundsDisposition;
  let ledgerPlan: WithdrawalLedgerPlan | null = null;
  const digest = sha(canonicalize(evidence));
  const reconcile = () => { state = 'RECONCILIATION_REQUIRED'; conflictDigest = digest; };
  if (state !== 'RECONCILIATION_REQUIRED') {
    if (evidence.outcome === 'TIMEOUT' || evidence.outcome === 'ACKNOWLEDGED') {
      if (!terminal) state = evidence.outcome === 'TIMEOUT' ? 'UNKNOWN' : 'PROCESSING';
    } else {
      if (typeof evidence.reference !== 'string' || !evidence.reference || evidence.reference.length > 128) throw invalid('Bound controlled result reference required');
      const certain = evidence.outcome === 'SUCCEEDED'
        ? unsigned(evidence.netCents).toString() === intent.netCents && unsigned(evidence.feeCents).toString() === intent.feeCents
        : evidence.unpaidConfirmed === true && unsigned(evidence.transferredCents) === 0n && unsigned(evidence.chargedFeeCents) === 0n;
      if (!certain || terminal && (terminal.state !== evidence.outcome || terminal.evidenceDigest !== digest)) reconcile();
      else if (!terminal) {
        if (fundsDisposition !== 'RESERVED') throw conflict('Reserved funds already consumed');
        state = evidence.outcome; terminal = { state, evidenceDigest: digest, reference: evidence.reference };
        const kind = state === 'SUCCEEDED' ? 'PAYOUT' : 'RELEASE';
        fundsDisposition = state === 'SUCCEEDED' ? 'PAYOUT_POSTED' : 'RELEASE_POSTED';
        ledgerPlan = plan(intent, kind);
      }
    }
  }
  return { intent: { ...intent, state, terminal, conflictDigest, fundsDisposition, lease: null, operationVersion: (revision(intent.operationVersion) + 1n).toString() }, ledgerPlan };
}
