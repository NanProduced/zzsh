import type { PoolClient } from 'pg';
import { ConfigurationError, type AppConfig } from '../config/config';
import { SecurityApiError } from '../auth/security-core';
import { conflict, invalid } from '../supply/supply-util';
import { REGRESSION_MARKER } from '../config/test-resource';
import { createControlledRegressionResource, assertControlledRegressionResource, type ControlledRegressionBinding, type ControlledRegressionResource } from './controlled-regression-resource';
import { assertLocalFinancialSandboxResource, localFinancialSandboxRegistration, type LocalFinancialSandbox } from './local-financial-sandbox-resource';

export type NativeWithdrawalBinding = Readonly<{
  userId: string;
  admissionId: string;
  destinationId: string;
  intentId: string;
  payoutKey: string;
}>;
export type NativeWithdrawalScope = Readonly<{ kind: 'NATIVE_LOCAL_CONTROLLED_WITHDRAWAL' }>;
type Proof = Readonly<{ name: string; role: string; oid: number; bindings: readonly NativeWithdrawalBinding[]; regression?: ControlledRegressionResource; sandbox?: LocalFinancialSandbox }>;
const proofs = new WeakMap<object, Proof>();
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const marker = 'zzsh:order-reservation-test:v1';
const unavailable = (reason: string) => new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', reason);

/** One genuine isolated environment capability; objects still require authenticated ownership,
 * their durable registered target, the original wallet/limit kernel and database guards. */
export function createSandboxNativeWithdrawalScope(sandbox: LocalFinancialSandbox): NativeWithdrawalScope {
  const r = localFinancialSandboxRegistration(sandbox).registration.resource;
  const token = Object.freeze({ kind: 'NATIVE_LOCAL_CONTROLLED_WITHDRAWAL' as const });
  proofs.set(token, Object.freeze({ name: r.database, role: r.runtimeRole, oid: r.resourceOid, bindings: Object.freeze([]), sandbox })); return token;
}
export function nativeWithdrawalSandbox(scope: NativeWithdrawalScope): LocalFinancialSandbox | undefined { return proof(scope).sandbox; }

/** Explicit local assembly only. No environment fallback and no HTTP constructor. */
export function createNativeWithdrawalScope(options: {
  config: AppConfig;
  resourceSet: string;
  resourceOid: number;
  bindings: readonly NativeWithdrawalBinding[];
  regression?: ControlledRegressionBinding;
}): NativeWithdrawalScope {
  const { config, resourceSet, resourceOid } = options;
  const name = config.database.name, role = config.database.user;
  const regression = resourceSet === 'regression' && options.regression ? createControlledRegressionResource(config, options.regression, 'WITHDRAWAL') : undefined;
  if (config.profile !== 'test' || config.provider !== 'fake' || !config.testOperationsEnabled
    || config.database.target !== 'local-compose' || config.database.host !== '127.0.0.1'
    || ![55432,55433].includes(config.database.port) || !/^[a-z][a-z0-9_]{0,20}$/.test(resourceSet)
    || (resourceSet === 'regression' ? !regression || options.regression!.resourceOid !== resourceOid
      : name !== `zzsh_test_order_${resourceSet}` || role !== `zzsh_order_${resourceSet}_r`)
    || !Number.isSafeInteger(resourceOid) || resourceOid <= 0) {
    throw new ConfigurationError('Native withdrawal requires explicit local test/fake resource and runtime role');
  }
  if (!Array.isArray(options.bindings) || options.bindings.length === 0 || regression && options.bindings.length > 10) throw invalid('Exact native withdrawal bindings required');
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
  proofs.set(token, Object.freeze({ name, role, oid: resourceOid, bindings: Object.freeze(bindings), ...(regression ? { regression } : {}) }));
  return token;
}

function proof(scope: NativeWithdrawalScope): Proof {
  const value = proofs.get(scope);
  if (!value) throw conflict('Native withdrawal scope is not verified');
  return value;
}

export async function assertNativeWithdrawalResource(client: PoolClient, scope: NativeWithdrawalScope, purpose: 'WRITE' | 'READ_ORIGINAL' = 'WRITE') {
  const expected = proof(scope);
  if (expected.sandbox) {
    const r = await assertLocalFinancialSandboxResource(client, expected.sandbox, purpose);
    const ready = (await client.query(`SELECT to_regclass('zzsh_order.withdrawal_intent') IS NOT NULL
      AND to_regclass('zzsh_order.withdrawal_admission') IS NOT NULL AND to_regclass('zzsh_order.withdrawal_destination') IS NOT NULL
      AND to_regclass('zzsh_order.withdrawal_provider_fact') IS NOT NULL AND to_regclass('zzsh_order.controlled_payout_operation') IS NOT NULL AS complete`)).rows[0];
    if (ready?.complete !== true) throw unavailable('CONTROLLED_WITHDRAWAL_SCHEMA_UNAVAILABLE');
    return { name: r.resource.database, oid: r.resource.resourceOid, marker: r.resource.marker, active: r.active };
  }
  if (expected.regression) await assertControlledRegressionResource(client, expected.regression, 'WITHDRAWAL');
  const row = (await client.query(`SELECT d.oid::int AS oid,current_database() AS name,current_user AS role,
    shobj_description(d.oid,'pg_database') AS marker,r.rolsuper,r.rolbypassrls,
    to_regclass('zzsh_order.withdrawal_intent') IS NOT NULL
    AND to_regclass('zzsh_order.withdrawal_admission') IS NOT NULL
    AND to_regclass('zzsh_order.withdrawal_destination') IS NOT NULL
    AND to_regclass('zzsh_order.withdrawal_provider_fact') IS NOT NULL
    AND to_regclass('zzsh_order.controlled_payout_operation') IS NOT NULL AS complete
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  if (!row || Number(row.oid) !== expected.oid || row.name !== expected.name || row.role !== expected.role
    || row.marker !== (expected.regression ? REGRESSION_MARKER : marker) || row.rolsuper !== false || row.rolbypassrls !== false) throw unavailable('NATIVE_WITHDRAWAL_RESOURCE_NOT_ADMITTED');
  if (row.complete !== true) throw unavailable('CONTROLLED_WITHDRAWAL_SCHEMA_UNAVAILABLE');
  // Debt-schema availability is checked only for new quote/reserve, not recovery.
  return { name: expected.name, oid: expected.oid, marker: expected.regression ? REGRESSION_MARKER : marker, active: true };
}

export function nativeWithdrawalBindings(scope: NativeWithdrawalScope, userId: string): readonly NativeWithdrawalBinding[] {
  if (proof(scope).sandbox) throw conflict('Registered withdrawal objects require their transaction reader');
  const bindings = proof(scope).bindings.filter(b => b.userId === userId);
  if (bindings.length === 0) throw unavailable('NATIVE_WITHDRAWAL_SUBJECT_NOT_ADMITTED');
  return bindings.map(b => ({ ...b }));
}

/** Read projection only; false must not suppress the subject's ordinary wallet. */
export function nativeWithdrawalSubjectInScope(scope: NativeWithdrawalScope, userId: string): boolean {
  if (proof(scope).sandbox) return typeof userId === 'string' && id.test(userId);
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

export async function assertNativeWithdrawalDestinationInTransaction(client: PoolClient, scope: NativeWithdrawalScope,
  target: { userId: string; admissionId: string; destinationId: string }, purpose: 'WRITE' | 'READ_ORIGINAL' = 'WRITE'): Promise<void> {
  const sandbox = proof(scope).sandbox;
  if (!sandbox) return assertNativeWithdrawalDestination(scope, target);
  const p = localFinancialSandboxRegistration(sandbox);
  const row = (await client.query(`SELECT d.id FROM zzsh_order.withdrawal_destination d
    JOIN zzsh_order.withdrawal_admission a ON a.id=d.admission_id AND a.user_id=d.user_id
    ${purpose==='WRITE'?'JOIN zzsh_order.withdrawal_bank_binding b ON b.id=d.bank_binding_id AND b.user_id=d.user_id AND b.revision=d.bank_binding_revision':''}
    WHERE d.id=$1 AND d.user_id=$2 AND a.id=$3 AND d.sandbox_registration_ref=$4 AND a.sandbox_registration_ref=$4
      AND a.resource_oid=$5 AND a.resource_name=$6 AND a.resource_marker=$7 AND d.mode='LOCAL_CONTROLLED'`,
  [target.destinationId,target.userId,target.admissionId,p.registration.reference,p.registration.resource.resourceOid,p.registration.resource.database,p.registration.resource.marker])).rows[0];
  if (!row) throw unavailable('NATIVE_WITHDRAWAL_DESTINATION_NOT_ADMITTED');
  if (purpose === 'WRITE') await assertLocalFinancialSandboxResource(client, sandbox);
}

export async function assertNativeWithdrawalIntentInTransaction(client: PoolClient, scope: NativeWithdrawalScope, row: {
  id: string; user_id: string; admission_id: string; destination_id: string; payout_key: string;
}, purpose: 'WRITE' | 'READ_ORIGINAL' = 'WRITE'): Promise<void> {
  const sandbox = proof(scope).sandbox;
  if (!sandbox) return assertNativeWithdrawalIntent(scope,row);
  const p = localFinancialSandboxRegistration(sandbox);
  const original = (await client.query(`SELECT i.id FROM zzsh_order.withdrawal_intent i
    JOIN zzsh_order.withdrawal_admission a ON a.id=i.admission_id AND a.user_id=i.user_id
    JOIN zzsh_order.withdrawal_destination d ON d.id=i.destination_id AND d.admission_id=a.id AND d.user_id=i.user_id
    WHERE i.id=$1 AND i.user_id=$2 AND i.admission_id=$3 AND i.destination_id=$4 AND i.payout_key=$5
      AND i.sandbox_registration_ref=$6 AND a.sandbox_registration_ref=$6 AND d.sandbox_registration_ref=$6
      AND a.resource_oid=$7 AND a.resource_name=$8 AND a.resource_marker=$9 AND i.mode='LOCAL_CONTROLLED'`,
  [row.id,row.user_id,row.admission_id,row.destination_id,row.payout_key,p.registration.reference,p.registration.resource.resourceOid,p.registration.resource.database,p.registration.resource.marker])).rows[0];
  if (!original) throw unavailable('NATIVE_WITHDRAWAL_INTENT_NOT_ADMITTED');
  if (purpose === 'WRITE') await assertLocalFinancialSandboxResource(client,sandbox);
}
