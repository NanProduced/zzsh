import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../src/config/config';
import { createApp } from '../src/app';
import { canonicalize } from '../src/supply/content-hash';
import { createRegisteredLocalNativeDistributionReadScope, createReviewedLocalNativeDistributionScope } from '../src/finance/distribution-policy-store';
import { assertLocalNativeDistributionRegistrationAssembly, createRegisteredLocalNativeDistributionRegistrationScope,
  initializeNewDistributionRegistration } from '../src/finance/distribution-registration';

// All IDs, policies and role names in this suite are synthetic; no database or provider is contacted.
const receipt = { database: 'zzsh_test_regression', resourceOid: 310001, owner: 'fixture_owner', ownerOid: 310002,
  marker: 'zzsh:regression-test:v1', migrationRole: 'fixture_migration', migrationRoleOid: 310003,
  runtimeRole: 'zzsh_regression_runtime', runtimeRoleOid: 310004, nonce: 'a'.repeat(24) };
const config = { profile: 'test', provider: 'fake', host: '127.0.0.1', port: 4232, testOperationsEnabled: false,
  database: { target: 'local-compose', targetProfile: 'test', host: '127.0.0.1', port: 55432,
    name: receipt.database, user: receipt.runtimeRole, runtimeUser: receipt.runtimeRole } } as AppConfig;
const origins = { apiOrigin: 'http://127.0.0.1:4232', userOrigin: 'http://127.0.0.1:4230',
  adminOrigin: 'http://127.0.0.1:4231', secureCookies: false, testOperationsEnabled: false };
const policy = { schema: 'distribution-policy.v2', scope: 'NATIVE', enabled: true, participation: 'AUTO_AT_REGISTRATION',
  depth: 1, selfRebate: false, accountModes: ['ordinary', 'custom'], minimumAccrualCents: '1', settlementDelayDays: 7,
  rateMode: 'UNIFORM', renterPercent: '5', ownerPercent: '5', levels: [] };
const canonical = canonicalize(policy), digest = createHash('sha256').update(canonical).digest('hex');
const read = () => createRegisteredLocalNativeDistributionReadScope(config, receipt, origins);
const fresh = { userId: 'fixture_new', requestId: 'fixture_request' };

function probe(change: { missingProof?: boolean; previous?: boolean; user?: Record<string, unknown>; identity?: Record<string, unknown>;
  owner?: Record<string, unknown>; absentPolicy?: boolean; badDigest?: boolean; inviter?: boolean } = {}) {
  const calls: { text: string; values: unknown[] }[] = [];
  const safeIdentity = { databaseName: receipt.database, currentUser: receipt.runtimeRole, owner: receipt.owner,
    ...Object.fromEntries(['isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase',
      'canCreateIamSchema','canCreateUserSchema','canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema',
      'canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit'].map(key => [key, false])) };
  const c = { getTransactionStatus: () => 'T', connectionParameters: { host: '127.0.0.1', port: 55432, database: receipt.database, user: receipt.runtimeRole },
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values }); const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
      if (text.startsWith('SELECT to_regclass') && text.includes('protected_proof')) return result([{ complete: true, protected_proof: !change.missingProof }]);
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return result();
      if (text.startsWith('SELECT user_id FROM zzsh_order.distribution_participant')) return result(change.previous ? [{ user_id: fresh.userId }] : []);
      if (text.startsWith('SELECT u.id,u.suspended')) return result([{ id: fresh.userId, suspended: false, account_status: 'ACTIVE',
        identity_provider: 'none', inserted_in_transaction: true, not_migrated: true, ...change.user }]);
      if (text.startsWith("SELECT to_regclass('zzsh_order.distribution_policy_version')")) return result([{ complete: true }]);
      if (text.startsWith('SELECT d.oid')) return result([{ oid: receipt.resourceOid, name: receipt.database, role: receipt.runtimeRole,
        marker: receipt.marker, nonce: receipt.nonce, complete: true, ...change.identity }]);
      if (text.includes('pg_get_userbyid(d.datdba) AS owner,d.datdba')) return result([{ owner: receipt.owner, ownerOid: receipt.ownerOid,
        roleOid: receipt.runtimeRoleOid, migrationRoleOid: receipt.migrationRoleOid, rolsuper: false, rolbypassrls: false,
        migrationSuper: false, migrationBypass: false, complete: true, ...change.owner }]);
      if (text.includes('AS "databaseName"')) return result([safeIdentity]);
      if (text.includes('AS "ownsBusinessSchema"')) return result([{ ownsBusinessSchema: false, ownsBusinessRelation: false, hasPrivilegedMembership: false }]);
      if (text.startsWith('SELECT v.* FROM zzsh_order.distribution_policy_head')) return result(change.absentPolicy ? [] : [{ id: 'native_policy', revision: '1',
        canonical_config: canonical, config_digest: change.badDigest ? '0'.repeat(64) : digest, created_at: '2026-11-01T00:00:00Z' }]);
      if (text.startsWith('SELECT * FROM zzsh_order.distribution_invite_code')) return result(change.inviter ? [{ id: 'fixture_code', user_id: 'fixture_parent' }] : []);
      if (text.startsWith('SELECT id FROM zzsh_auth_user."user"')) return result([{ id: 'fixture_parent' }]);
      if (text.startsWith('SELECT p.*,u.suspended')) return result([{ user_id: 'fixture_parent', eligibility: 'ELIGIBLE', suspended: false, account_status: 'ACTIVE' }]);
      if (text.startsWith('WITH RECURSIVE chain')) return result([{ user_id: 'fixture_parent', cyclic: false, leader_knowledge: 'KNOWN_NONE', parent_user_id: null }]);
      if (text.startsWith('INSERT INTO zzsh_order.distribution_invite_code')) return result([{ id: 'fixture_invite' }]);
      if (/^(INSERT|UPDATE)/.test(text)) return result([{}]);
      throw new Error('Unexpected synthetic SQL: '+text);
    } } as unknown as PoolClient;
  return { c, calls };
}

test('registration-only brand must be paired to its exact local native read scope', async () => {
  const scope = read(), registration = createRegisteredLocalNativeDistributionRegistrationScope(scope);
  assertLocalNativeDistributionRegistrationAssembly(registration, scope);
  assert.throws(() => assertLocalNativeDistributionRegistrationAssembly(registration, read()));
  assert.throws(() => assertLocalNativeDistributionRegistrationAssembly({ ...registration }, scope));
  assert.throws(() => createRegisteredLocalNativeDistributionRegistrationScope({ ...scope }));
  const old = createReviewedLocalNativeDistributionScope({ kind: 'CONTROLLED_REGRESSION_RESOURCE' }, { owner: receipt.owner, ownerOid: receipt.ownerOid });
  assert.throws(() => createRegisteredLocalNativeDistributionRegistrationScope(old));
  await assert.rejects(createApp({ auth: { ...origins, distributionReadScope: scope, distributionRegistrationScope: { ...registration } } } as never), /ASSEMBLY_INVALID/);
});

test('a proved fresh native registration locks the NATIVE policy and initializes only its own participation and code', async () => {
  const scope = read(), registration = createRegisteredLocalNativeDistributionRegistrationScope(scope), p = probe();
  const result = await initializeNewDistributionRegistration(p.c, fresh, undefined, registration);
  assert.equal(result.eligibility, 'ELIGIBLE'); assert.equal(result.policyVersion, 'native_policy');
  const participant = p.calls.find(q => q.text.startsWith('INSERT INTO zzsh_order.distribution_participant'))!;
  assert.equal(participant.values[0], fresh.userId); assert.equal(participant.values[1], 'ELIGIBLE'); assert.equal(participant.values[3], 'native_policy');
  const locked = p.calls.findIndex(q => q.text.includes('FOR SHARE OF h'));
  assert(locked >= 0 && locked < p.calls.indexOf(participant));
  assert(p.calls.some(q => q.text.startsWith('INSERT INTO zzsh_order.distribution_invite_code') && q.values.includes(fresh.userId)));
  assert(!p.calls.some(q => q.text.startsWith('INSERT INTO zzsh_order.invitation_relation')));
  assert(!p.calls.some(q => /settlement_ledger|payment_confirmation|withdrawal_intent/i.test(q.text)));
});

test('a valid known inviter only creates the normal registration relations', async () => {
  const scope = read(), registration = createRegisteredLocalNativeDistributionRegistrationScope(scope), p = probe({ inviter: true });
  await initializeNewDistributionRegistration(p.c, { ...fresh, inviteCode: 'FIXTURE' }, undefined, registration);
  const relations = p.calls.filter(q => q.text.startsWith('INSERT INTO zzsh_order.invitation_relation'));
  assert.equal(relations.length, 2); assert(relations.some(q => q.text.includes("'INVITER'")));
  assert(relations.some(q => q.text.includes("'DISTRIBUTION_LEADER'")));
  assert(relations.every(q => q.values.includes(fresh.userId) && q.values.includes('fixture_parent') && q.values.includes('native_policy')));
});

test('existing, migrated, wrong-resource or unproved users and unknown policy fail before any write', async () => {
  const registration = createRegisteredLocalNativeDistributionRegistrationScope(read());
  const cases = [{ missingProof: true }, { previous: true }, { user: { inserted_in_transaction: false } },
    { user: { id: 'different' } }, { user: { suspended: true } }, { user: { account_status: 'FROZEN' } },
    { user: { identity_provider: 'legacy_mysql_restore' } }, { user: { not_migrated: false } },
    { identity: { oid: 310000 } }, { identity: { nonce: 'b'.repeat(24) } }, { owner: { ownerOid: 310099 } },
    { absentPolicy: true }, { badDigest: true }];
  for (const change of cases) {
    const p = probe(change); await assert.rejects(initializeNewDistributionRegistration(p.c, fresh, undefined, registration));
    assert(!p.calls.some(q => /^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(q.text)));
  }
  const forged = probe();
  await assert.rejects(initializeNewDistributionRegistration(forged.c, fresh, undefined, { ...registration }));
  assert.deepEqual(forged.calls, []);
  const combined = probe();
  await assert.rejects(initializeNewDistributionRegistration(combined.c, fresh, read(), registration));
  assert.deepEqual(combined.calls, []);
});
