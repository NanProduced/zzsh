import type { PoolClient } from 'pg';
import { ConfigurationError, type AppConfig } from '../config/config';
import { SecurityApiError } from '../auth/security-core';
import { conflict, invalid } from '../supply/supply-util';

export type NativeWithdrawalBinding = Readonly<{
  userId: string;
  admissionId: string;
  destinationId: string;
  intentId: string;
  payoutKey: string;
}>;
export type NativeWithdrawalScope = Readonly<{ kind: 'NATIVE_LOCAL_CONTROLLED_WITHDRAWAL' }>;
type Proof = Readonly<{ name: string; role: string; oid: number; bindings: readonly NativeWithdrawalBinding[] }>;
const proofs = new WeakMap<object, Proof>();
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const marker = 'zzsh:order-reservation-test:v1';
const unavailable = (reason: string) => new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', reason);

/** Explicit local assembly only. No environment fallback and no HTTP constructor. */
export function createNativeWithdrawalScope(options: {
  config: AppConfig;
  resourceSet: string;
  resourceOid: number;
  bindings: readonly NativeWithdrawalBinding[];
}): NativeWithdrawalScope {
  const { config, resourceSet, resourceOid } = options;
  const name = config.database.name, role = config.database.user;
  if (config.profile !== 'test' || config.provider !== 'fake' || !config.testOperationsEnabled
    || config.database.target !== 'local-compose' || config.database.host !== '127.0.0.1'
    || config.database.port !== 55432 || !/^[a-z][a-z0-9_]{0,20}$/.test(resourceSet)
    || name !== `zzsh_test_order_${resourceSet}` || role !== `zzsh_order_${resourceSet}_r`
    || !Number.isSafeInteger(resourceOid) || resourceOid <= 0) {
    throw new ConfigurationError('Native withdrawal requires explicit local test/fake resource and runtime role');
  }
  if (!Array.isArray(options.bindings) || options.bindings.length === 0) throw invalid('Exact native withdrawal bindings required');
  const bindings = options.bindings.map(b => Object.freeze({
    userId: b.userId, admissionId: b.admissionId, destinationId: b.destinationId,
    intentId: b.intentId, payoutKey: b.payoutKey,
  }));
  for (const b of bindings) if (Object.values(b).some(v => typeof v !== 'string' || !id.test(v))) throw invalid('Native withdrawal binding identifier invalid');
  for (const selector of [(b: NativeWithdrawalBinding) => b.intentId, (b: NativeWithdrawalBinding) => b.payoutKey,
    (b: NativeWithdrawalBinding) => JSON.stringify([b.userId, b.admissionId, b.destinationId])]) {
    if (new Set(bindings.map(selector)).size !== bindings.length) throw invalid('Native withdrawal binding is ambiguous');
  }
  const token = Object.freeze({ kind: 'NATIVE_LOCAL_CONTROLLED_WITHDRAWAL' as const });
  proofs.set(token, Object.freeze({ name, role, oid: resourceOid, bindings: Object.freeze(bindings) }));
  return token;
}

function proof(scope: NativeWithdrawalScope): Proof {
  const value = proofs.get(scope);
  if (!value) throw conflict('Native withdrawal scope is not verified');
  return value;
}

export async function assertNativeWithdrawalResource(client: PoolClient, scope: NativeWithdrawalScope) {
  const expected = proof(scope);
  const row = (await client.query(`SELECT d.oid::int AS oid,current_database() AS name,current_user AS role,
    shobj_description(d.oid,'pg_database') AS marker,r.rolsuper,r.rolbypassrls,
    to_regclass('zzsh_order.withdrawal_intent') IS NOT NULL
    AND to_regclass('zzsh_order.withdrawal_admission') IS NOT NULL
    AND to_regclass('zzsh_order.withdrawal_destination') IS NOT NULL
    AND to_regclass('zzsh_order.withdrawal_provider_fact') IS NOT NULL
    AND to_regclass('zzsh_order.controlled_payout_operation') IS NOT NULL AS complete
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  if (!row || Number(row.oid) !== expected.oid || row.name !== expected.name || row.role !== expected.role
    || row.marker !== marker || row.rolsuper !== false || row.rolbypassrls !== false) throw unavailable('NATIVE_WITHDRAWAL_RESOURCE_NOT_ADMITTED');
  if (row.complete !== true) throw unavailable('CONTROLLED_WITHDRAWAL_SCHEMA_UNAVAILABLE');
  // Debt-schema availability is checked only for new quote/reserve, not recovery.
  return { name: expected.name, oid: expected.oid, marker };
}

export function nativeWithdrawalBindings(scope: NativeWithdrawalScope, userId: string): readonly NativeWithdrawalBinding[] {
  const bindings = proof(scope).bindings.filter(b => b.userId === userId);
  if (bindings.length === 0) throw unavailable('NATIVE_WITHDRAWAL_SUBJECT_NOT_ADMITTED');
  return bindings.map(b => ({ ...b }));
}

/** Read projection only; false must not suppress the subject's ordinary wallet. */
export function nativeWithdrawalSubjectInScope(scope: NativeWithdrawalScope, userId: string): boolean {
  return proof(scope).bindings.some(b => b.userId === userId);
}

export function assertNativeWithdrawalDestination(scope: NativeWithdrawalScope, target: { userId: string; admissionId: string; destinationId: string }): void {
  if (!nativeWithdrawalBindings(scope, target.userId).some(b => b.admissionId === target.admissionId && b.destinationId === target.destinationId)) {
    throw unavailable('NATIVE_WITHDRAWAL_DESTINATION_NOT_ADMITTED');
  }
}

export function assertNativeWithdrawalIntent(scope: NativeWithdrawalScope, row: {
  id: string; user_id: string; admission_id: string; destination_id: string; payout_key: string;
}): void {
  if (!nativeWithdrawalBindings(scope, row.user_id).some(b => b.intentId === row.id && b.admissionId === row.admission_id
    && b.destinationId === row.destination_id && b.payoutKey === row.payout_key)) {
    throw unavailable('NATIVE_WITHDRAWAL_INTENT_NOT_ADMITTED');
  }
}
