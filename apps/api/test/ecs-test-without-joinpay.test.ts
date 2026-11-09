import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { businessFeatureEnabled, isEcsTestWithoutJoinpay, loadConfig } from '../src/config/config';
import { loadAuthRuntimeConfig, mountAuthHandlers } from '../src/auth/auth-runtime';
import { loadEcsTestDistributionRuntime, loadNativeDistributionRuntime } from '../src/finance/distribution-native-runtime';
import { loadDistributionDueRuntime } from '../src/finance/distribution-due.module';
import { assertLocalDistributionAssembly, distributionPolicyScopeOf, readDistributionPolicy,
  createReviewedLocalNativeDistributionScope, readActiveDistributionPolicyInTransaction, readInvitationPolicyInTransaction, readRegistrationDistributionPolicyInTransaction } from '../src/finance/distribution-policy-store';
import { createControlledRegressionResource } from '../src/finance/controlled-regression-resource';
import { loadJoinpayCollectionRuntime } from '../src/order/joinpay-collection-runtime';
import { loadJoinpayRefundRuntime } from '../src/order/joinpay-refund-runtime';
import { loadJoinpayPayoutRuntime } from '../src/finance/joinpay-payout-runtime';
import { loadEcsTestJoinpayAccountSnapshotRuntime, loadJoinpayAccountRuntime } from '../src/finance/joinpay-account-runtime';
import { loadWithdrawalBankBindingRuntime } from '../src/finance/withdrawal-bank-binding-runtime';
import { CREDIT_TABLES } from '../src/credit/credit-guarantee-runtime';
import { assertSyntheticChannelRequestCapability } from '../src/order/channel-payment-store';
import { settlementSurfaceOpen } from '../src/order/settlement-record';
import { canonicalize } from '../src/supply/content-hash';
import * as settlement from '../src/order/settlement-record';
import * as identity from '../src/auth/user-identity';
import * as authSecurity from '../src/auth/auth-security';
import * as adminAuthorization from '../src/auth/admin-authorization';
import * as imAccess from '../src/im/order-team-access';
import * as securityCore from '../src/auth/security-core';
import * as supplyRoutes from '../src/supply/supply-routes';
import { handleSettlementUserRoute, handleSettlementAdminRoute } from '../src/order/settlement-routes';

const noChannel: NodeJS.ProcessEnv = {
  APP_PROFILE: 'ecs-test', NODE_ENV: 'production',
  JOINPAY_COLLECTION_ENABLED: 'false', JOINPAY_REFUND_ENABLED: 'false',
  JOINPAY_PAYOUT_ENABLED: 'false', JOINPAY_ACCOUNTS_ENABLED: 'false',
};
const env: NodeJS.ProcessEnv = {
  ...noChannel, DB_TARGET: 'ecs-test', HOST: '0.0.0.0', DB_HOST: 'pg.internal', DB_PORT: '5432',
  DB_NAME: 'zzsh_ecs_test_review', DB_USER: 'zzsh_ecs_runtime', DB_PASSWORD: 'synthetic-db-only',
  REDIS_HOST: 'redis.internal', REDIS_PORT: '6379', REDIS_USER: 'synthetic_redis', REDIS_PASSWORD: 'synthetic-redis-only',
  YUNXIN_APP_KEY: 'synthetic_app', YUNXIN_APP_SECRET: 'synthetic-yunxin-only', ORDER_TEAMS_MEMBERS_LIMIT: '100',
  AUTH_API_ORIGIN: 'https://api.example.invalid', AUTH_USER_ORIGIN: 'https://user.example.invalid', AUTH_ADMIN_ORIGIN: 'https://admin.example.invalid',
  AUTH_USER_SECRET: 'u'.repeat(32), AUTH_ADMIN_SECRET: 'a'.repeat(32), AUTH_SECURE_COOKIES: 'true',
  USER_AUTH_THROTTLE_HMAC_KEY: 't'.repeat(32), USER_IDENTITY_SUBJECT_HMAC_KEY: 'i'.repeat(32), ADMIN_ALTCHA_HMAC_KEY: 'h'.repeat(32),
};
const config = loadConfig(env);
const context = { provider: config.provider, database: config.database, authEnabled: true, settlementRecordingEnabled: false };
const authAssembly = { testOperationsEnabled: false, secureCookies: true, settlementRecordingEnabled: false,
  apiOrigin: 'https://api.example.invalid', userOrigin: 'https://user.example.invalid', adminOrigin: 'https://admin.example.invalid' };
const policy = { schema: 'distribution-policy.v2', scope: 'NATIVE', enabled: true, participation: 'AUTO_AT_REGISTRATION', depth: 1,
  selfRebate: false, accountModes: ['ordinary', 'custom'], minimumAccrualCents: '1', settlementDelayDays: 7,
  rateMode: 'UNIFORM', renterPercent: '5', ownerPercent: '5', levels: [] };
const canonical = canonicalize(policy);
const digest = createHash('sha256').update(canonical).digest('hex');

function clientProbe(patch: { database?: string; role?: string; unsafe?: string; complete?: boolean; permission?: boolean } = {}) {
  const sql: string[] = [], readScopes: unknown[] = [];
  const safeIdentity = { databaseName: patch.database ?? config.database.name, currentUser: patch.role ?? config.database.user,
    owner: 'migration_owner', ...Object.fromEntries(['isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls',
      'canCreateDatabase','canCreateIamSchema','canCreateUserSchema','canCreateAdminSchema','canCreateSupplySchema',
      'canCreateContentSchema','canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit'].map(key => [key, key === patch.unsafe])) };
  const client = { release() {}, async query(text: string, params: unknown[] = []) {
    sql.push(text);
    if (['BEGIN','COMMIT','ROLLBACK','SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'].includes(text)) return { rows: [] };
    if (text.startsWith('SELECT s.')) return { rows: [{ locked: false, twoFactorEnabled: true }] };
    if (text.includes('FROM "zzsh_iam"."admin_security"')) return { rows: [{ status: 'ACTIVE', isBoss: false, passwordChangeRequired: false }] };
    if (text.startsWith('SELECT suspended')) return { rows: [{ suspended: false }] };
    if (text.startsWith('WITH role_permissions')) return { rows: patch.permission ? [{ permissionCode: 'personal.distribution.policy.read' }] : [] };
    if (text.startsWith('SELECT d.oid')) return { rows: [{ oid: 42, name: patch.database ?? config.database.name, role: patch.role ?? config.database.user, complete: patch.complete ?? true }] };
    if (text.includes('pg_get_userbyid(d.datdba) AS owner,d.datdba')) return { rows: [{ rolsuper: false, rolbypassrls: false, complete: patch.complete ?? true }] };
    if (text.includes('AS "databaseName"')) return { rows: [safeIdentity] };
    if (text.includes('AS "ownsBusinessSchema"')) return { rows: [{ ownsBusinessSchema: patch.unsafe === 'ownsBusinessSchema', ownsBusinessRelation: false, hasPrivilegedMembership: false }] };
    if (text.startsWith("SELECT to_regclass('zzsh_order.distribution_policy_version')")) return { rows: [{ complete: true }] };
    if (text.startsWith("SELECT to_regclass('zzsh_iam.approval_request')")) return { rows: [{ requests_ready: false, contract_ready: false }] };
    if (text.startsWith('SELECT v.* FROM zzsh_order.distribution_policy_head')) {
      readScopes.push(params[0]);
      return { rows: [{ id: 'native_policy', revision: '1', canonical_config: canonical, config_digest: digest, created_at: new Date('2026-11-01T00:00:00Z') }] };
    }
    throw new Error('Unexpected synthetic policy SQL');
  } };
  return { client: client as unknown as PoolClient, pool: { connect: async () => client } as unknown as Pool, sql, readScopes };
}

test('ecs-test requires four explicit false flags; normal business remains enabled', () => {
  assert.equal(isEcsTestWithoutJoinpay(noChannel), true);
  assert.equal(isEcsTestWithoutJoinpay({ ...noChannel, NODE_ENV: 'development' }), false);
  for (const key of ['JOINPAY_COLLECTION_ENABLED','JOINPAY_REFUND_ENABLED','JOINPAY_PAYOUT_ENABLED','JOINPAY_ACCOUNTS_ENABLED']) {
    assert.equal(isEcsTestWithoutJoinpay({ ...noChannel, [key]: undefined }), false);
    assert.equal(isEcsTestWithoutJoinpay({ ...noChannel, [key]: 'true' }), false);
  }
  for (const profile of ['production','dev','test','provider-test']) assert.equal(isEcsTestWithoutJoinpay({ ...noChannel, APP_PROFILE: profile }), false);
  for (const key of ['AUTH_ENABLED','CREDIT_GUARANTEE_ENABLED','ZZSH_MEMBERSHIP_GROWTH_ENABLED','DISTRIBUTION_NATIVE_ENABLED','ORDER_TEAMS_ENABLED','SUPPORT_DISPATCH_ENABLED']) {
    assert.equal(businessFeatureEnabled(noChannel, key), true);
  }
  for (const key of ['ORDER_SETTLEMENT_RECORDING_ENABLED','DISTRIBUTION_DUE_WORKER_ENABLED']) {
    assert.equal(businessFeatureEnabled(noChannel, key), false);
    assert.equal(businessFeatureEnabled({ ...noChannel, [key]: 'false' }, key), false);
    for (const value of ['true','yes']) assert.throws(() => businessFeatureEnabled({ ...noChannel, [key]: value }, key), /must be false/);
    assert.equal(businessFeatureEnabled({ ...noChannel, APP_PROFILE: 'production' }, key), true);
  }
  assert.equal(config.provider, 'real');
  assert.equal(loadAuthRuntimeConfig(env).settlementRecordingEnabled, false);
  assert.equal(loadDistributionDueRuntime({} as Pool, undefined, noChannel), undefined);
  assert.equal(settlementSurfaceOpen(false), false);
});

test('closed channel loaders read no channel config or key and mint no payment capability', async () => {
  let sensitiveReads = 0, fetches = 0;
  const guarded = new Proxy(noChannel, { get(target, key, receiver) {
    if (typeof key === 'string' && /^JOINPAY_.*(?:CONFIG|KEY)/.test(key)) { sensitiveReads++; throw new Error('unexpected channel configuration read'); }
    return Reflect.get(target, key, receiver);
  } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetches++; throw new Error('unexpected outbound call'); }) as typeof fetch;
  try {
    assert.equal(loadJoinpayCollectionRuntime(context, guarded), undefined);
    assert.equal(loadJoinpayRefundRuntime(context, guarded), undefined);
    assert.equal(loadJoinpayPayoutRuntime(context, undefined, guarded), undefined);
    assert.equal(loadJoinpayAccountRuntime(context, guarded), undefined);
    await assert.rejects(assertSyntheticChannelRequestCapability({ query: async () => { throw new Error('unexpected database'); } } as unknown as PoolClient, undefined),
      error => (error as { paymentReason?: string }).paymentReason === 'PAYMENT_CHANNEL_NOT_ENABLED');
    assert.equal(sensitiveReads, 0); assert.equal(fetches, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('native business policy scope is target-bound and cannot be mixed with payment or local controlled capabilities', () => {
  const candidate = loadEcsTestDistributionRuntime({ config, authEnabled: true, admission: undefined, env: noChannel });
  const scope = candidate.auth.distributionScope;
  assert.equal(distributionPolicyScopeOf(scope), 'NATIVE');
  assert.equal(candidate.auth.distributionReadScope, scope);
  assert.equal('distributionEarnings' in candidate.auth, false);
  assertLocalDistributionAssembly(scope, authAssembly);
  for (const property of ['joinpayCollection','joinpayRefund','joinpayWithdrawal','joinpayAccountObservation','localControlledPayments','localFinancialSandbox','distributionEarnings']) {
    assert.throws(() => assertLocalDistributionAssembly(scope, { ...authAssembly, [property]: {} }), /PAYMENT_ASSEMBLY_FORBIDDEN/);
  }
  assert.throws(() => assertLocalDistributionAssembly(scope, { ...authAssembly, settlementRecordingEnabled: true }), /PAYMENT_ASSEMBLY_FORBIDDEN/);
  assert.throws(() => assertLocalDistributionAssembly(scope, { ...authAssembly, secureCookies: false }), /secure non-local/);
  for (const change of [
    { profile: 'production' }, { profile: 'test' }, { provider: 'fake' },
    { database: { ...config.database, target: 'production' } }, { database: { ...config.database, targetProfile: 'production' } },
    { database: { ...config.database, name: 'zzsh_prod' } }, { database: { ...config.database, runtimeUser: 'different_role' } },
  ]) assert.throws(() => loadEcsTestDistributionRuntime({ config: { ...config, ...change } as typeof config, authEnabled: true, admission: undefined, env: noChannel }));
  assert.throws(() => loadEcsTestDistributionRuntime({ config, authEnabled: false, admission: undefined, env: noChannel }));
  assert.throws(() => loadEcsTestDistributionRuntime({ config, authEnabled: true, admission: {} as never, env: noChannel }));
  assert.throws(() => loadEcsTestDistributionRuntime({ config, authEnabled: true, admission: undefined, env: { ...noChannel, APP_PROFILE: 'production' } }));
  assert.throws(() => loadNativeDistributionRuntime({ config, authEnabled: true, admission: undefined, env: { APP_PROFILE: 'production' } }), /FORMAL_COLLECTION_ADMISSION/);
});

test('mixed payment assembly is rejected before an observer or recovery lifecycle can start', async () => {
  const scope = loadEcsTestDistributionRuntime({ config, authEnabled: true, admission: undefined, env: noChannel }).auth.distributionScope;
  let starts = 0;
  const app = { get: () => ({ start: () => { starts++; } }) };
  for (const property of ['joinpayCollection','joinpayRefund','joinpayWithdrawal','joinpayAccountObservation']) {
    await assert.rejects(mountAuthHandlers(app as never, { ...authAssembly, pool: {} as Pool, distributionScope: scope, [property]: {} } as never), /PAYMENT_ASSEMBLY_FORBIDDEN/);
    assert.equal(starts, 0);
  }
});

test('synthetic authenticated startup mounts ordinary routes but no JoinPay callback or worker', async () => {
  const oldEnv = Object.fromEntries(Object.keys(noChannel).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(noChannel)) process.env[key] = value;
  const oldFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error('unexpected outbound call'); }) as typeof fetch;
  try {
    const mounted: string[] = [], started: string[] = [];
    const express = { use: (path: string | readonly string[]) => { mounted.push(...(Array.isArray(path) ? path : [path])); } };
    const app = { getHttpAdapter: () => ({ getInstance: () => express }), get: (token: { name?: string }) => ({
      start: () => { started.push(token.name ?? 'unknown'); }, wake: () => {}, status: () => ({}) }) };
    const pool = { query: async (text: string) => {
      if (text.includes('FROM unnest')) return { rows: CREDIT_TABLES.map(name => ({ name, present: true, readable: true })) };
      if (text.includes('runtime_contract_version')) return { rows: [{ version: 1, schemaCreate: false }] };
      if (text.includes("zzsh_iam.user_auth_throttle_event")) return { rows: [{ ready: true }] };
      throw new Error('unexpected startup database query');
    }, connect: async () => { throw new Error('unexpected startup connection'); } };
    const scope = loadEcsTestDistributionRuntime({ config, authEnabled: true, admission: undefined, env: noChannel });
    const security = await mountAuthHandlers(app as never, { ...loadAuthRuntimeConfig(env), ...scope.auth, pool: pool as never,
      yunxin: { appId: 'synthetic_app', appKey: 'synthetic_app', appSecret: 'synthetic_only' },
      orderTeams: { membersLimit: 100, intervalMs: 15000, batchLimit: 5 }, supportDispatch: config.supportDispatch } as never);
    assert.equal(security.settlementRecordingEnabled, false);
    for (const path of ['/api/v1/orders','/api/v1/im','/api/v1/users/me/membership-growth','/api/v1/users/me/distribution','/api/v1/admin/distribution/policy']) assert(mounted.includes(path), path);
    for (const path of ['/api/v1/payments/joinpay/notifications','/api/v1/refunds/joinpay/notifications','/api/v1/withdrawals/joinpay/notifications']) assert(!mounted.includes(path), path);
    assert(started.some(name => name === 'MessageScopeRecoveryLifecycle'));
    assert(started.some(name => name === 'OrderDispatchLifecycle'));
    assert(!started.some(name => name.startsWith('Joinpay')));
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('NATIVE policy and relationships read the target while cross-resource and unsafe roles fail closed', async () => {
  const scope = loadEcsTestDistributionRuntime({ config, authEnabled: true, admission: undefined, env: noChannel }).auth.distributionScope;
  const positive = clientProbe();
  assert.equal((await readRegistrationDistributionPolicyInTransaction(positive.client, scope)).knowledge, 'KNOWN');
  const invitation = await readInvitationPolicyInTransaction(positive.client, scope);
  assert.equal(invitation.knowledge, 'KNOWN'); assert.equal(invitation.writeResourceAdmitted, true);
  assert.deepEqual(positive.readScopes, ['NATIVE','NATIVE']);
  assert(!positive.sql.some(text => /^(INSERT|UPDATE|DELETE)/i.test(text)));
  for (const patch of [{ database: 'zzsh_ecs_test_other' }, { role: 'other_role' }, { unsafe: 'isSuperuser' }, { unsafe: 'ownsBusinessSchema' }, { complete: false }]) {
    const probe = clientProbe(patch);
    await assert.rejects(readActiveDistributionPolicyInTransaction(probe.client, false, scope), error => (error as { status?: number }).status === 503);
    assert.equal(probe.readScopes.length, 0);
  }
  const restored = loadEcsTestDistributionRuntime({ config: { ...config, database: { ...config.database, name: 'zzsh_ecs_test_restored' } }, authEnabled: true, admission: undefined, env: noChannel }).auth.distributionScope;
  await assert.rejects(readActiveDistributionPolicyInTransaction(clientProbe().client, false, restored));
  const denied = clientProbe();
  await assert.rejects(readDistributionPolicy(denied.pool, { userId: 'admin', sessionId: 'session', requestId: 'req' }, scope, scope), error => (error as { status?: number }).status === 403);
  assert.equal(denied.readScopes.length, 0);
});

test('optional account snapshot is local-only, scoped, and rejects observers or cross-profile use', () => {
  const doc = { resource: { database: config.database.name, runtimeUser: config.database.user }, merchantIdentityId: 'synthetic_merchant', readAdminIds: ['synthetic_admin'] };
  const local = { ...noChannel, JOINPAY_ACCOUNTS_LOCAL_READ_ENABLED: 'true', JOINPAY_ACCOUNTS_CONFIG: JSON.stringify(doc) };
  const result = loadEcsTestJoinpayAccountSnapshotRuntime(context, local)!;
  assert.equal(result.observation, undefined);
  assert.deepEqual([...result.read.merchantIdsByAdmin.get('synthetic_admin')!], ['synthetic_merchant']);
  assert.equal(result.read.merchantIdsByAdmin.has('other_admin'), false);
  assert.throws(() => loadEcsTestJoinpayAccountSnapshotRuntime(context, { ...local, JOINPAY_ACCOUNTS_CONFIG: JSON.stringify({ ...doc, observation: {} }) }), /OBSERVATION_FORBIDDEN/);
  assert.throws(() => loadEcsTestJoinpayAccountSnapshotRuntime(context, { ...local, APP_PROFILE: 'production' }), /LOCAL_READ_CONTEXT_INVALID/);
  assert.throws(() => loadEcsTestJoinpayAccountSnapshotRuntime(context, { ...local, JOINPAY_REFUND_ENABLED: 'true' }), /LOCAL_READ_CONTEXT_INVALID/);
  assert.throws(() => loadEcsTestJoinpayAccountSnapshotRuntime({ ...context, database: { ...context.database, name: 'zzsh_prod' } }, local), /LOCAL_READ_CONTEXT_INVALID/);
  assert.throws(() => loadEcsTestJoinpayAccountSnapshotRuntime(context, { ...local, JOINPAY_ACCOUNTS_CONFIG: JSON.stringify({ ...doc, resource: { ...doc.resource, database: 'zzsh_ecs_test_other' } }) }), /RESOURCE_MISMATCH/);
});

test('test deployment template closes four channel assemblies while preserving configured local bank binding', () => {
  const example = readFileSync('.env.deployment.example', 'utf8');
  for (const key of ['JOINPAY_COLLECTION_ENABLED','JOINPAY_REFUND_ENABLED','JOINPAY_PAYOUT_ENABLED','JOINPAY_ACCOUNTS_ENABLED']) {
    assert.match(example, new RegExp(`^${key}=false$`, 'm'));
  }
  assert.match(example, /^WITHDRAWAL_BANK_BINDING_ENABLED=true$/m);
  assert.match(example, /^WITHDRAWAL_BANK_BINDING_CONFIG_FILE=/m);
  assert.throws(() => loadWithdrawalBankBindingRuntime(context, { WITHDRAWAL_BANK_BINDING_ENABLED: 'true' }), /BANK_BINDING_CONFIG_UNAVAILABLE/);
  const doc = { database: config.database.name, runtimeUser: config.database.user, writeEnabled: true,
    currentKeyVersion: 'v1', keyVariables: { v1: 'WITHDRAWAL_BANK_KEY_V1' } };
  const bankEnv = { WITHDRAWAL_BANK_BINDING_ENABLED: 'true', WITHDRAWAL_BANK_BINDING_CONFIG: JSON.stringify(doc),
    WITHDRAWAL_BANK_KEY_V1: Buffer.alloc(32, 7).toString('base64url') };
  const bank = loadWithdrawalBankBindingRuntime(context, bankEnv)!;
  assert.equal(bank.protection!.keyFor('v1').byteLength, 32);
  assert.throws(() => loadWithdrawalBankBindingRuntime(context, { ...bankEnv, WITHDRAWAL_BANK_BINDING_CONFIG: JSON.stringify({ ...doc, database: 'zzsh_ecs_test_other' }) }), /RESOURCE_MISMATCH/);
});

test('disabled settlement responds only after party, staff and object authorization; old modes and GET remain intact', async t => {
  const oldEnv = Object.fromEntries(Object.keys(noChannel).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(noChannel)) process.env[key] = value;
  try {
    const state = { owned: true, validTeam: true, canWrite: true, active: true, origin: true, reads: 0, locks: 0, sql: [] as string[] };
    const client = { async query(text: string) { state.sql.push(text); return { rowCount: state.owned ? 1 : 0, rows: state.owned ? [{}] : [] }; } };
    t.mock.method(supplyRoutes, 'requireOrigin', () => state.origin);
    t.mock.method(identity, 'readUserContext', async () => { state.reads++; if (!state.active) throw new securityCore.SecurityApiError(401, 'UNAUTHENTICATED', 'no session'); return { userId: 'party', sessionId: 'session' }; });
    t.mock.method(authSecurity, 'readAdminContext', async () => { state.reads++; return { userId: 'staff', sessionId: 'session' }; });
    t.mock.method(identity, 'assertUserContextInTransaction', async (_client: PoolClient, _actor: { userId: string; sessionId: string }, purpose?: 'READ' | 'WRITE') => { assert.equal(purpose, 'READ'); });
    t.mock.method(authSecurity, 'assertAdminContextInTransaction', async () => {});
    t.mock.method(adminAuthorization, 'loadEffectiveAdminAccess', async () => ({ status: 'ACTIVE', isBoss: false, passwordChangeRequired: false,
      permissions: new Set(state.canWrite ? ['order.settlement.write'] : ['order.read']) }));
    t.mock.method(imAccess, 'readOrderTeamAccess', async () => { if (!state.validTeam) throw new securityCore.SecurityApiError(403, 'FORBIDDEN', 'not a member'); return { teamState: 'READY', canRead: true }; });
    t.mock.method(settlement, 'lockSettlement', async () => { state.locks++; throw new Error('unexpected settlement lock'); });
    t.mock.method(securityCore, 'withTransaction', async (_pool: unknown, action: (value: PoolClient) => Promise<unknown>) => action(client as never));
    const response = { headersSent: false, statusCode: 0, body: null as unknown, setHeader() { return this; }, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    const options = { pool: { options: { database: config.database.name, user: config.database.user } }, settlementRecordingEnabled: false } as never;
    const user = (suffix: string, method = 'POST') => handleSettlementUserRoute({ method, url: `/api/v1/orders/order_1${suffix}`, headers: {} } as never, response as never, options);
    const admin = (suffix: string, method = 'POST') => handleSettlementAdminRoute({ method, url: `/api/v1/admin/orders/order_1${suffix}`, headers: {} } as never, response as never, options);
    const status = (expected: number) => (error: unknown) => (error as { status?: number }).status === expected;
    for (const path of ['/settlement-preview','/settlements','/settlements/v1/decision','/openings/o1/confirm']) await assert.rejects(user(path), status(503));
    for (const path of ['/settlement-preview','/openings','/openings/o1/confirm','/settlements/classify','/settlements/v1/review','/settlements/adjustments']) await assert.rejects(admin(path), status(503));
    assert.equal(state.locks, 0);
    assert(state.sql.every(text => text === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' || /^SELECT 1 FROM zzsh_order\.rental_order/.test(text)));
    state.owned = false; await assert.rejects(user('/settlements'), status(404)); state.owned = true;
    state.canWrite = false; await assert.rejects(admin('/openings'), status(404)); state.canWrite = true;
    state.validTeam = false; await assert.rejects(admin('/openings'), status(404)); state.validTeam = true;
    state.active = false; await assert.rejects(user('/settlements'), status(401)); state.active = true;
    state.origin = false; const before = state.reads; assert.equal(await user('/settlements'), true); assert.equal(state.reads, before); state.origin = true;
    process.env.JOINPAY_PAYOUT_ENABLED = 'true'; const beforeOld = state.reads; await assert.rejects(user('/settlements'), status(404)); assert.equal(state.reads, beforeOld);
    process.env.JOINPAY_PAYOUT_ENABLED = 'false';
    t.mock.method(settlement, 'readSettlement', async () => ({ status: 200, body: { stable: true } } as never));
    t.mock.method(settlement, 'projectSettlementResponse', async (_c: PoolClient, _actor: unknown, result: unknown) => result as never);
    assert.equal(await user('/settlement', 'GET'), true); assert.equal(response.statusCode, 200); assert.deepEqual(response.body, { stable: true });
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('reviewed local native policy is bound to the exact transaction and cannot be mounted in HTTP', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const localConfig = { ...config, profile: 'test' as const, provider: 'fake' as const, testOperationsEnabled: true,
      database: { ...config.database, target: 'local-compose' as const, targetProfile: 'test' as const, host: '127.0.0.1', port: 55432,
        name: 'zzsh_test_regression', user: 'zzsh_regression_runtime', runtimeUser: 'zzsh_regression_runtime' } };
    const binding = { resourceOid: 123456, runtimeRoleOid: 123457, nonce: 'a'.repeat(24) };
    const proof = createControlledRegressionResource(localConfig, binding, 'DISTRIBUTION');
    const owner = { owner: 'zzsh_migration', ownerOid: 123458 };
    const scope = createReviewedLocalNativeDistributionScope(proof, owner);
    assert.equal(distributionPolicyScopeOf(scope), 'NATIVE');
    assert.throws(() => assertLocalDistributionAssembly(scope, authAssembly), /OFFLINE_ONLY/);
    const resourceClient = (change: Record<string, unknown> = {}) => {
      const sql: string[] = [], scopes: unknown[] = [];
      const client = { connectionParameters: { host: '127.0.0.1', port: 55432, database: 'zzsh_test_regression', user: 'zzsh_regression_runtime', ...(change.connection as object ?? {}) },
        getTransactionStatus: () => change.transaction ?? 'T', async query(text: string, params: unknown[] = []) {
          sql.push(text);
          if (text.startsWith('SELECT d.oid::int')) return { rows: [{ oid: binding.resourceOid, name: 'zzsh_test_regression', role: 'zzsh_regression_runtime', role_oid: binding.runtimeRoleOid,
            nonce: binding.nonce, marker: 'zzsh:regression-test:v1', ...(change.identity as object ?? {}) }] };
          if (text.includes('AS "databaseName"')) return { rows: [{ databaseName: 'zzsh_test_regression', currentUser: 'zzsh_regression_runtime', owner: 'zzsh_migration',
            ...Object.fromEntries(['isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase','canCreateIamSchema','canCreateUserSchema',
              'canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema','canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit'].map(key => [key, false])) }] };
          if (text.includes('AS "ownsBusinessSchema"')) return { rows: [{ ownsBusinessSchema: false, ownsBusinessRelation: false, hasPrivilegedMembership: false }] };
          if (text.startsWith('SELECT pg_get_userbyid(d.datdba) AS owner')) return { rows: [{ ...owner, complete: true, ...(change.owner as object ?? {}) }] };
          if (text.startsWith('SELECT v.* FROM zzsh_order.distribution_policy_head')) { scopes.push(params[0]); return { rows: [{ id: 'native_policy', revision: '1', canonical_config: canonical, config_digest: digest, created_at: new Date('2026-11-01T00:00:00Z') }] }; }
          throw new Error('Unexpected synthetic local policy SQL');
        } } as unknown as PoolClient;
      return { client, sql, scopes };
    };
    const correct = resourceClient();
    assert.equal((await readActiveDistributionPolicyInTransaction(correct.client, false, scope)).knowledge, 'KNOWN');
    assert.deepEqual(correct.scopes, ['NATIVE']);
    for (const change of [{ connection: { host: 'different-host' } }, { connection: { database: 'other' } }, { transaction: 'I' },
      { identity: { oid: 123455 } }, { identity: { role_oid: 123455 } }, { identity: { nonce: 'b'.repeat(24) } }, { identity: { marker: 'other' } },
      { owner: { owner: 'other_owner' } }, { owner: { ownerOid: 123459 } }]) {
      const denied = resourceClient(change);
      await assert.rejects(readActiveDistributionPolicyInTransaction(denied.client, false, scope));
      assert.equal(denied.scopes.length, 0);
    }
    const forged = createReviewedLocalNativeDistributionScope({ kind: 'CONTROLLED_REGRESSION_RESOURCE' }, owner);
    await assert.rejects(readActiveDistributionPolicyInTransaction(resourceClient().client, false, forged), /CONTROLLED_REGRESSION_RESOURCE_NOT_ADMITTED/);
    assert.throws(() => createControlledRegressionResource({ ...localConfig, profile: 'production' }, binding, 'DISTRIBUTION'));
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  }
});
