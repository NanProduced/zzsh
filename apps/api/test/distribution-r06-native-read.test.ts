import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../src/config/config';
import { createApp } from '../src/app';
import { mountAuthHandlers } from '../src/auth/auth-runtime';
import { canonicalize } from '../src/supply/content-hash';
import {
  assertLocalDistributionAssembly, assertLocalNativeDistributionReadOnlyAssembly,
  assertReviewedDistributionMaintenanceResource, assertDistributionPolicyWriteReadyInTransaction,
  createRegisteredLocalNativeDistributionReadScope, createReviewedLocalNativeDistributionScope,
  distributionPolicyScopeOf, readActiveDistributionPolicyInTransaction, readDistributionPolicy,
  readInvitationPolicyInTransaction, readRegistrationDistributionPolicyInTransaction,
} from '../src/finance/distribution-policy-store';
import { readMyInvitations, bindMyDistributionLeader } from '../src/finance/invitation-store';
import { mountInvitationRoutes } from '../src/finance/invitation-routes';
import { mountDistributionPolicyRoutes } from '../src/finance/distribution-policy-routes';

// Synthetic identifiers only; this suite does not connect to any database or provider.
const receipt = { database: 'zzsh_test_regression', resourceOid: 210001, owner: 'fixture_owner', ownerOid: 210002,
  marker: 'zzsh:regression-test:v1', migrationRole: 'fixture_migration', migrationRoleOid: 210003,
  runtimeRole: 'zzsh_regression_runtime', runtimeRoleOid: 210004, nonce: 'a'.repeat(24) };
const origins = { apiOrigin: 'http://127.0.0.1:4232', userOrigin: 'http://127.0.0.1:4230',
  adminOrigin: 'http://127.0.0.1:4231', secureCookies: false, testOperationsEnabled: false };
const config = { profile: 'test', provider: 'fake', host: '127.0.0.1', port: 4232, testOperationsEnabled: false,
  database: { target: 'local-compose', targetProfile: 'test', host: '127.0.0.1', port: 55432,
    name: receipt.database, user: receipt.runtimeRole, runtimeUser: receipt.runtimeRole } } as AppConfig;
const actor = { userId: 'fixture_subject', sessionId: 'fixture_session', requestId: 'fixture_request' };
const policy = { schema: 'distribution-policy.v2', scope: 'NATIVE', enabled: true, participation: 'AUTO_AT_REGISTRATION',
  depth: 1, selfRebate: false, accountModes: ['ordinary', 'custom'], minimumAccrualCents: '1', settlementDelayDays: 7,
  rateMode: 'UNIFORM', renterPercent: '5', ownerPercent: '5', levels: [] };
const canonical = canonicalize(policy), digest = createHash('sha256').update(canonical).digest('hex');
const scope = () => createRegisteredLocalNativeDistributionReadScope(config, receipt, origins);

function probe(patch: { identity?: Record<string, unknown>; shape?: Record<string, unknown>; connection?: Record<string, unknown>;
  transaction?: string; unsafe?: string; permission?: boolean; suspended?: boolean; ownerUser?: string } = {}) {
  const sql: string[] = [], policyScopes: unknown[] = [];
  const safeIdentity = { databaseName: receipt.database, currentUser: receipt.runtimeRole, owner: receipt.owner,
    ...Object.fromEntries(['isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase',
      'canCreateIamSchema','canCreateUserSchema','canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema',
      'canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit'].map(key => [key, key === patch.unsafe])) };
  const client = { release() {}, getTransactionStatus: () => patch.transaction ?? 'T',
    connectionParameters: { host: '127.0.0.1', port: 55432, database: receipt.database, user: receipt.runtimeRole, ...patch.connection },
    async query(text: string, values: unknown[] = []) {
      sql.push(text); const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
      if (['BEGIN','COMMIT','ROLLBACK','SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'].includes(text)) return result();
      if (text.startsWith('SELECT s.')) return result([{ locked: false, twoFactorEnabled: true }]);
      if (text.includes('FROM "zzsh_iam"."admin_security"')) return result([{ status: 'ACTIVE', isBoss: false, passwordChangeRequired: false }]);
      if (text.startsWith('WITH role_permissions')) return result(patch.permission === false ? [] : [{ permissionCode: 'personal.distribution.policy.read' }]);
      if (text.startsWith('SELECT suspended') || text.startsWith('SELECT "suspended"') || text.startsWith('SELECT u."suspended"')) return result([{ suspended: patch.suspended === true, accountStatus: 'ACTIVE' }]);
      if (text.includes('FROM "zzsh_iam"."user_identity_state"')) return result([{ accountStatus: 'ACTIVE', identityStatus: 'UNVERIFIED', ageStatus: 'UNKNOWN' }]);
      if (text.startsWith('SELECT 1 FROM "zzsh_auth_user"."session"')) return result([{}]);
      if (text.startsWith('SELECT d.oid')) return result([{ oid: receipt.resourceOid, name: receipt.database, role: receipt.runtimeRole,
        marker: receipt.marker, nonce: receipt.nonce, complete: true, ...patch.identity }]);
      if (text.includes('pg_get_userbyid(d.datdba) AS owner,d.datdba')) return result([{ owner: receipt.owner, ownerOid: receipt.ownerOid,
        roleOid: receipt.runtimeRoleOid, migrationRoleOid: receipt.migrationRoleOid, rolsuper: false, rolbypassrls: false,
        migrationSuper: false, migrationBypass: false, complete: true, ...patch.shape }]);
      if (text.includes('AS "databaseName"')) return result([safeIdentity]);
      if (text.includes('AS "ownsBusinessSchema"')) return result([{ ownsBusinessSchema: patch.unsafe === 'ownsBusinessSchema',
        ownsBusinessRelation: false, hasPrivilegedMembership: false }]);
      if (text.startsWith("SELECT to_regclass('zzsh_order.distribution_policy_version')")) return result([{ complete: true }]);
      if (text.startsWith("SELECT to_regprocedure('zzsh_order.distribution_management_contract_version()')")) return result([{ready:false}]);
      if (text.startsWith("SELECT to_regclass('zzsh_iam.approval_request')")) return result([{ requests_ready: false, contract_ready: false }]);
      if (text.startsWith('SELECT v.* FROM zzsh_order.distribution_policy_head')) {
        policyScopes.push(values[0]); return result([{ id: 'fixture_native_policy', revision: '1', canonical_config: canonical,
          config_digest: digest, created_at: '2026-11-01T00:00:00Z' }]);
      }
      if (text.startsWith('SELECT * FROM zzsh_order.distribution_participant')) return result([{ user_id: patch.ownerUser ?? actor.userId,
        eligibility: 'ELIGIBLE', level_code: null, revision: '1', leader_knowledge: 'KNOWN_NONE', inviter_knowledge: 'KNOWN_NONE' }]);
      if (text.startsWith('SELECT id,display_code')) return result([{ id:'fixture_code',display_code: 'FIXTURE', source_type: 'LEGACY_MYSQL' }]);
      if (text.startsWith('SELECT * FROM zzsh_order.invitation_relation')) return result();
      if (text.startsWith('SELECT to_regclass')) return result([{ complete: true }]);
      throw new Error('Unexpected synthetic SQL: ' + text);
    } } as unknown as PoolClient;
  return { client, pool: { connect: async () => client, query: client.query.bind(client) } as unknown as Pool, sql, policyScopes };
}

test('local native read capability binds the exact receipt and three local origins', () => {
  const candidate = scope(); assert.equal(distributionPolicyScopeOf(candidate), 'NATIVE');
  assertLocalDistributionAssembly(candidate, origins);
  const cloned = { ...receipt }, copiedOrigins = { ...origins };
  const fixed = createRegisteredLocalNativeDistributionReadScope(config, cloned, copiedOrigins);
  cloned.nonce = 'b'.repeat(24); copiedOrigins.userOrigin = 'http://127.0.0.1:9999';
  assertLocalDistributionAssembly(fixed, origins);
  for (const change of [{ profile: 'dev' }, { profile: 'production' }, { provider: 'real' }, { testOperationsEnabled: true }, { host: 'localhost' }, { port: 9999 }])
    assert.throws(() => createRegisteredLocalNativeDistributionReadScope({ ...config, ...change } as AppConfig, receipt, origins));
  for (const change of [{ target: 'ecs-test' }, { targetProfile: 'production' }, { host: 'localhost' }, { port: 5432 },
    { name: 'wrong' }, { user: 'wrong' }, { runtimeUser: 'wrong' }])
    assert.throws(() => createRegisteredLocalNativeDistributionReadScope({ ...config, database: { ...config.database, ...change } } as AppConfig, receipt, origins));
  for (const change of [{ nonce: '' }, { nonce: 'A'.repeat(24) }, { resourceOid: 0 }, { runtimeRoleOid: 0 },
    { marker: 'wrong' }, { ownerOid: receipt.runtimeRoleOid }, { migrationRole: receipt.runtimeRole }])
    assert.throws(() => createRegisteredLocalNativeDistributionReadScope(config, { ...receipt, ...change }, origins));
  for (const change of [{ secureCookies: true }, { apiOrigin: 'http://127.0.0.1:4233' }, { userOrigin: 'http://localhost:4230' },
    { adminOrigin: 'https://127.0.0.1:4231' }, { adminOrigin: origins.userOrigin }])
    assert.throws(() => createRegisteredLocalNativeDistributionReadScope(config, receipt, { ...origins, ...change }));
  assert.throws(() => assertLocalDistributionAssembly({ ...candidate }, origins));
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { assert.throws(() => scope()); assert.throws(() => assertLocalDistributionAssembly(candidate, origins)); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('local native read may not be mixed with policy writes, funds, payments or workers', async () => {
  const read = scope(); assertLocalNativeDistributionReadOnlyAssembly(read, undefined, origins);
  assert.throws(() => assertLocalNativeDistributionReadOnlyAssembly(undefined, read, origins));
  assert.throws(() => assertLocalNativeDistributionReadOnlyAssembly(read, { kind: 'NATIVE_DISTRIBUTION' }, origins));
  for (const property of ['distributionEarnings','joinpayCollection','joinpayRefund','joinpayWithdrawal','joinpayAccountRead',
    'joinpayAccountObservation','localControlledPayments','localFinancialSandbox','nativeWithdrawalScope','distributionDue'])
    assert.throws(() => assertLocalNativeDistributionReadOnlyAssembly(read, undefined, { ...origins, [property]: {} }), /READ_ONLY/);
  for (const property of ['testOperationsEnabled','settlementRecordingEnabled'])
    assert.throws(() => assertLocalNativeDistributionReadOnlyAssembly(read, undefined, { ...origins, [property]: true }), /READ_ONLY/);
  let queries = 0; const app = { get: () => { throw new Error('Lifecycle must not start'); } };
  await assert.rejects(mountAuthHandlers(app as never, { ...origins, distributionReadScope: read, distributionScope: read,
    pool: { query: async () => { queries++; } } } as never), /READ_ONLY/); assert.equal(queries, 0);
  await assert.rejects(createApp({ auth: { ...origins, distributionReadScope: read }, distributionDue: {} } as never), /READ_ONLY/);
  const old = createReviewedLocalNativeDistributionScope({ kind: 'CONTROLLED_REGRESSION_RESOURCE' }, { owner: receipt.owner, ownerOid: receipt.ownerOid });
  assert.throws(() => assertLocalDistributionAssembly(old, origins), /OFFLINE_ONLY/);
});

test('native policy and self relationship reads keep their authorization and never grant writes', async () => {
  const read = scope(), admin = probe();
  const policyResult = await readDistributionPolicy(admin.pool, actor, read);
  assert.equal(policyResult.scope, 'NATIVE'); assert.equal(policyResult.knowledge, 'KNOWN');
  assert.equal(policyResult.changeContext.writeAssemblyReady, false); assert.deepEqual(admin.policyScopes, ['NATIVE']);
  const denied = probe({ permission: false });
  await assert.rejects(readDistributionPolicy(denied.pool, actor, read), e => (e as { status?: number }).status === 403);
  assert.deepEqual(denied.policyScopes, []);
  const self = probe(); const summary = await readMyInvitations(self.pool, actor, read);
  assert.equal(summary.subjectId, actor.userId); assert.equal(summary.scope, 'NATIVE'); assert.equal(summary.canBindLeader, false);
  assert.deepEqual(self.policyScopes, ['NATIVE']);
  const suspended = probe({ suspended: true });
  await assert.rejects(readMyInvitations(suspended.pool, actor, read), e => (e as { status?: number }).status === 401);
  assert.deepEqual(suspended.policyScopes, []);
  const invitation = await readInvitationPolicyInTransaction(probe().client, read); assert.equal(invitation.writeResourceAdmitted, false);
  for (const operation of [() => readActiveDistributionPolicyInTransaction(probe().client, false, read),
    () => readRegistrationDistributionPolicyInTransaction(probe().client, read),
    () => assertDistributionPolicyWriteReadyInTransaction(probe().client, read),
    () => assertReviewedDistributionMaintenanceResource(probe().client, read)]) await assert.rejects(operation());
  assert(![...admin.sql, ...denied.sql, ...self.sql].some(sql => /^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(sql)));
});

test('authenticated routes read NATIVE facts but refuse the relationship write before any transaction', async () => {
  const read = scope(), direct = probe();
  await assert.rejects(bindMyDistributionLeader(direct.pool, actor, { code: 'FIXTURE', policyVersion: 'policy', expectedParticipantRevision: '1' }, 'key', read));
  assert.deepEqual(direct.sql, []);
  const routed = probe(), handlers = new Map<string, Function>();
  const app = { getHttpAdapter: () => ({ getInstance: () => ({ use: (path: string, handler: Function) => handlers.set(path, handler) }) }) };
  const userAuth = { api: { getSession: async () => ({ user: { id: actor.userId }, session: { id: actor.sessionId } }) } };
  mountInvitationRoutes(app as never, { ...origins, pool: routed.pool, userAuth, distributionReadScope: read } as never);
  let status = 0, body: any; const response = { setHeader() { return this; }, status(value: number) { status = value; return this; }, json(value: unknown) { body = value; return this; } };
  await handlers.get('/api/v1/users/me/distribution')!({ method: 'GET', originalUrl: '/api/v1/users/me/distribution',
    headers: { origin: origins.userOrigin } }, response);
  assert.equal(status, 200); assert.equal(body.scope, 'NATIVE'); assert.equal(body.canBindLeader, false);
  const prior = routed.sql.length;
  await handlers.get('/api/v1/users/me/distribution')!({ method: 'POST', originalUrl: '/api/v1/users/me/distribution/bind',
    headers: { origin: origins.userOrigin, 'idempotency-key': 'fixture-key' }, body: { code: 'FIXTURE', policyVersion: 'policy', expectedParticipantRevision: '1' } }, response);
  assert.equal(status, 503); assert(!routed.sql.slice(prior).some(text => /^(BEGIN|INSERT|UPDATE|DELETE)/i.test(text)));
  const admin = probe(), adminHandlers = new Map<string, Function>();
  const adminApp = { getHttpAdapter: () => ({ getInstance: () => ({ use: (path: string, handler: Function) => adminHandlers.set(path, handler) }) }) };
  const adminAuth = { api: { getSession: async () => ({ user: { id: actor.userId, twoFactorEnabled: true }, session: { id: actor.sessionId } }) } };
  mountDistributionPolicyRoutes(adminApp as never, { ...origins, pool: admin.pool, adminAuth, distributionReadScope: read } as never);
  await adminHandlers.get('/api/v1/admin/distribution/policy')!({ method: 'GET', originalUrl: '/api/v1/admin/distribution/policy',
    headers: { origin: origins.adminOrigin } }, response);
  assert.equal(status, 200); assert.equal(body.scope, 'NATIVE'); assert.equal(body.changeContext.writeAssemblyReady, false);
});

test('R05 identity, stale nonce, role drift, unsafe privilege and missing schema all fail closed', async () => {
  for (const change of [{ identity: { oid: 210000 } }, { identity: { nonce: 'b'.repeat(24) } }, { identity: { marker: 'other' } },
    { identity: { role: 'other' } }, { identity: { complete: false } }, { shape: { ownerOid: 210005 } },
    { shape: { roleOid: 210005 } }, { shape: { migrationRoleOid: 210005 } }, { shape: { complete: false } },
    { connection: { host: 'other' } }, { connection: { database: 'other' } }, { transaction: 'I' },
    { unsafe: 'canCreateRole' }, { unsafe: 'ownsBusinessSchema' }]) {
    const denied = probe(change); await assert.rejects(readInvitationPolicyInTransaction(denied.client, scope()));
    assert.deepEqual(denied.policyScopes, []);
  }
});
