import { strict as assert } from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertLiveTarget,
  assertMaintenanceLockHeld,
  acquireMigrationSessionFence,
  acquireMigrationTransactionFence,
  captureMaintenanceLockEpoch,
  guardedMigrationTargetPool,
  assertNextMigrationWriteReady,
  isRegisteredMigrationInstance,
  assertRuntimeRoleCompanion,
  assertReadbackTarget,
  loadRegisteredTarget,
  normalizeRegisteredTarget,
  sameMigrationProfile,
  releaseMigrationSessionFence,
} from "./local-target-registry.mjs";

test('migration profile cannot drift between registered input and subsequent reads',()=>{
  const next={migrationProfile:'LOCAL_MIGRATION_NEXT_V1'};
  assert.equal(sameMigrationProfile(next,next),true);
  assert.equal(sameMigrationProfile({},{}),true);
  assert.equal(sameMigrationProfile(next,{}),false);
  assert.equal(sameMigrationProfile({},next),false);
});

const nonce = "0123456789abcdef01234567";
const legacy = {
  database: "zzsh_test_regression",
  marker: "zzsh:regression-test:v1",
  oid: "3375850",
  nonce,
  owner: "zzsh",
  roles: { migration: "zzsh_regression_migration", runtime: "zzsh_regression_runtime" },
};
const isolated = {
  ...legacy,
  instance: { host: "127.0.0.1", port: 55433, systemIdentifier: "7704626787080364068" },
};
test("old R07 port and a separately registered next-round instance cannot be confused", () => {
  const old = normalizeRegisteredTarget(isolated);
  assert.equal(isRegisteredMigrationInstance(old), true);
  const next = normalizeRegisteredTarget({ ...isolated, instance: { ...isolated.instance, port: 55435 }, migrationProfile: "LOCAL_MIGRATION_NEXT_V1" });
  assert.equal(isRegisteredMigrationInstance(next), true);
  assert.doesNotThrow(()=>assertNextMigrationWriteReady(old));
  assert.throws(()=>assertNextMigrationWriteReady(next),/NEXT_MIGRATION_ADMISSION_INCOMPLETE/);
  for (const changed of [
    { ...next, migrationProfile: null }, { ...next, port: 55433 }, { ...next, host: "0.0.0.0" },
    { ...next, instance: { ...next.instance, systemIdentifier: "" } }, { ...next, instance: { ...next.instance, port: 55434 }, port: 55434 },
    { ...old, migrationProfile: "LOCAL_MIGRATION_NEXT_V1" },
  ]) assert.equal(isRegisteredMigrationInstance(changed), false);
  assert.throws(() => normalizeRegisteredTarget({ ...isolated, migrationProfile: "unknown" }), /TARGET_MIGRATION_PROFILE_INVALID/);
});
const live = (over = {}) => ({
  database: "zzsh_test_regression",
  oid: "3375850",
  owner: "zzsh",
  marker: "zzsh:regression-test:v1",
  nonce,
  role: "zzsh_regression_migration",
  role_oid: "16389",
  is_super: "false",
  can_create_db: "false",
  can_create_role: "false",
  can_inherit: "false",
  can_bypass_rls: "false",
  system_identifier: null,
  ...over,
});
const workspace = () => mkdtempSync(join(tmpdir(), "zzsh-target-registry-"));
const withRegistry = (body, run) => {
  const dir = workspace();
  try {
    writeFileSync(join(dir, "credentials.json"), "{}");
    writeFileSync(join(dir, "resource.json"), JSON.stringify(body));
    return run(join(dir, "credentials.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('target pool verifies each borrowed client and discards a replaced or unfenced session', async () => {
  let destroyed; const client = { release: value => { destroyed=value; } }, pool = { connect: async () => client };
  assert.equal(await guardedMigrationTargetPool(pool, async c => assert.equal(c,client)).connect(), client);
  await assert.rejects(guardedMigrationTargetPool(pool, async () => { throw Error('FENCE_LOST'); }).connect(), /FENCE_LOST/);
  assert.equal(destroyed,true);
});

test('maintenance lock proof rejects lost locks and another database or cluster', async () => {
  const target = normalizeRegisteredTarget(isolated), values = [];
  const client = row => ({ async query(sql, params) { values.push({ sql, params }); return { rows: [row] }; } });
  const ok = { database: 'postgres', system_identifier: isolated.instance.systemIdentifier, held: true };
  await assertMaintenanceLockHeld(client(ok), target);
  assert.deepEqual(values[0].params, ['806006']); assert.match(values[0].sql, /pid=pg_backend_pid\(\)/);
  for (const changed of [{ ...ok, held: false }, { ...ok, database: 'other' }, { ...ok, system_identifier: '999' }, undefined])
    await assert.rejects(assertMaintenanceLockHeld(client(changed), target), /TARGET_MAINTENANCE_LOCK_LOST/);
  await assert.rejects(assertMaintenanceLockHeld(client(ok), { ...target, lockKey: '9223372036854775808' }), /TARGET_LOCK_KEY_INVALID/);
});

test('next-round transaction fence binds the live maintenance backend and target epoch', async () => {
  const target = normalizeRegisteredTarget({ ...isolated, instance: { ...isolated.instance, port: 55435 }, migrationProfile: 'LOCAL_MIGRATION_NEXT_V1' });
  const owner = { database: 'postgres', system_identifier: target.instance.systemIdentifier, held: true };
  const ownerClient = (over = {}) => ({ query: async sql => ({ rows: [sql.includes('pg_locks') ? { ...owner, ...over }
    : sql.includes('pg_try_advisory_lock') ? { acquired: true } : { pid: 123 }] }) });
  const epoch = await captureMaintenanceLockEpoch(ownerClient(), target);
  assert.equal(epoch.pid, 123); assert.equal(epoch.systemIdentifier, target.instance.systemIdentifier); assert.equal(epoch.keys.length, 4);
  for (const changed of [{ held: false }, { system_identifier: '999' }])
    await assert.rejects(captureMaintenanceLockEpoch(ownerClient(changed), target), /TARGET_MAINTENANCE_LOCK_LOST/);
  const calls = [], proof = { database: target.database, oid: target.oid, nonce: target.nonce, system_identifier: target.instance.systemIdentifier, held: true };
  const client = (over = {}) => ({ getTransactionStatus: () => over.transaction ?? 'T', async query(sql) {
    calls.push(sql);
    if (sql.includes('pg_try_advisory_xact_lock') || sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: over.acquired ?? true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: over.released ?? true }] };
    return { rows: [over.proof ?? proof] };
  } });
  await acquireMigrationTransactionFence(client(), target, epoch);
  assert.match(calls[0], /pg_try_advisory_xact_lock/); assert.match(calls[1], /pg_locks/);
  await assert.rejects(acquireMigrationTransactionFence(client({ transaction: 'I' }), target, epoch), /TARGET_FENCE_TRANSACTION_REQUIRED/);
  await assert.rejects(acquireMigrationTransactionFence(client({ acquired: false }), target, epoch), /TARGET_FENCE_BUSY/);
  for (const changed of [{ ...proof, held: false }, { ...proof, oid: '2' }, { ...proof, nonce: 'b'.repeat(24) }, { ...proof, system_identifier: '999' }])
    await assert.rejects(acquireMigrationTransactionFence(client({ proof: changed }), target, epoch), /TARGET_FENCE_EPOCH_LOST/);
  await assert.rejects(acquireMigrationTransactionFence(client(), target, { ...epoch, keys: [1] }), /TARGET_FENCE_BINDING_INVALID/);
  const session = client({ transaction: 'I' });
  await acquireMigrationSessionFence(session, target, epoch); await releaseMigrationSessionFence(session, target);
  await assert.rejects(acquireMigrationSessionFence(client(), target, epoch), /TARGET_FENCE_IDLE_CONNECTION_REQUIRED/);
  await assert.rejects(acquireMigrationSessionFence(client({ transaction:'I', proof:{ ...proof, held:false } }), target, epoch), /TARGET_FENCE_EPOCH_LOST/);
  await assert.rejects(releaseMigrationSessionFence(client({ transaction:'I', released:false }), target), /TARGET_FENCE_RELEASE_UNCONFIRMED/);
});

test("legacy registry keeps the fixed local instance and needs no cluster identity", () => {
  const target = withRegistry(legacy, loadRegisteredTarget);
  assert.equal(target.port, 55432);
  assert.equal(target.instance, null);
  assert.equal(target.lockKey, "806006");
  assert.equal(target.maintenanceDatabase, "postgres");
  assert.equal(assertLiveTarget(target, live()).database, "zzsh_test_regression");
});

test("a declared instance must pin the live cluster identity", () => {
  const target = withRegistry(isolated, loadRegisteredTarget);
  assert.deepEqual(target.instance, { host: "127.0.0.1", port: 55433, systemIdentifier: "7704626787080364068" });
  assert.equal(assertLiveTarget(target, live({ system_identifier: "7704626787080364068" })).oid, "3375850");
  assert.throws(() => assertLiveTarget(target, live({ system_identifier: null })), /TARGET_SYSTEM_IDENTIFIER_UNAVAILABLE/);
  assert.throws(() => assertLiveTarget(target, live({ system_identifier: "7683455772595376163" })), /TARGET_INSTANCE_SYSTEM_IDENTIFIER_MISMATCH/);
});

test("an instance block without systemIdentifier is refused instead of guessed", () => {
  for (const bad of [{ port: 55433 }, { host: "127.0.0.1", port: 55433 }, { systemIdentifier: "" }]) {
    assert.throws(
      () => normalizeRegisteredTarget({ ...legacy, instance: bad }),
      /TARGET_INSTANCE_SYSTEM_IDENTIFIER_(REQUIRED|INVALID)/,
    );
  }
});

test("a registry cannot point outside loopback or at an unusable identity", () => {
  const cases = [
    [{ ...legacy, instance: { host: "0.0.0.0", port: 55433, systemIdentifier: "1" } }, /TARGET_HOST_MUST_BE_LOOPBACK/],
    [{ ...legacy, instance: { port: 0, systemIdentifier: "1" } }, /TARGET_PORT_INVALID/],
    [{ ...legacy, oid: "33758x" }, /TARGET_OID_INVALID/],
    [{ ...legacy, nonce: "ABCDEF" }, /TARGET_NONCE_INVALID/],
    [{ ...legacy, marker: "" }, /TARGET_MARKER_INVALID/],
    [{ ...legacy, database: "ZZSH" }, /TARGET_DATABASE_INVALID/],
    [{ ...legacy, roles: { migration: "same", runtime: "same" } }, /TARGET_ROLES_MUST_DIFFER/],
    [{ ...legacy, roles: { migration: "zzsh", runtime: "zzsh_regression_runtime" } }, /TARGET_MIGRATION_ROLE_MUST_DIFFER_FROM_OWNER/],
    [{ ...legacy, lockKey: "lock" }, /TARGET_LOCK_KEY_INVALID/],
    [{ ...legacy, pendingReset: false }, /TARGET_PENDING_RESET_INVALID/],
  ];
  for (const [body, expected] of cases) assert.throws(() => normalizeRegisteredTarget(body), expected);
});

test("pending reset remains visible to every registered-target caller", () => {
  const target = normalizeRegisteredTarget({ ...legacy, pendingReset: {oid: "123", at: "2026-11-06T00:00:00Z"} });
  assert.equal(target.pendingReset.oid, "123");
  assert.equal(normalizeRegisteredTarget(legacy).pendingReset, null);
});

test("every live mismatch fails with its own code", () => {
  const target = normalizeRegisteredTarget({ ...legacy, instance: isolated.instance });
  const cases = [
    [{ database: "zzsh_test_regression_r01_retained" }, /TARGET_DATABASE_MISMATCH/],
    [{ oid: "3375851" }, /TARGET_OID_MISMATCH/],
    [{ owner: "someone" }, /TARGET_OWNER_MISMATCH/],
    [{ marker: "zzsh:regression-test:v2" }, /TARGET_MARKER_MISMATCH/],
    [{ nonce: "ffffffffffffffffffffffff" }, /TARGET_NONCE_MISMATCH/],
    [{ role: "zzsh_regression_runtime" }, /TARGET_ROLE_MISMATCH/],
    [{ is_super: "true" }, /TARGET_MIGRATION_ROLE_MUST_NOT_BE_SUPERUSER/],
    [{ can_create_db: "true" }, /TARGET_MIGRATION_ROLE_MUST_NOT_CREATE_DB/],
    [{ can_create_role: "true" }, /TARGET_MIGRATION_ROLE_MUST_NOT_CREATE_ROLE/],
    [{ is_super: undefined }, /TARGET_MIGRATION_ROLE_MUST_NOT_BE_SUPERUSER/],
    [{ can_inherit: "true" }, /TARGET_MIGRATION_ROLE_MUST_NOT_INHERIT/],
    [{ can_bypass_rls: "true" }, /TARGET_MIGRATION_ROLE_MUST_NOT_BYPASS_RLS/],
  ];
  for (const [over, expected] of cases) {
    assert.throws(
      () => assertLiveTarget(target, live({ system_identifier: "7704626787080364068", ...over })),
      expected,
    );
  }
});

test("recorded migration role OID must match the live role", () => {
  const target = normalizeRegisteredTarget({ ...isolated, roles: { migration: {name:"zzsh_regression_migration",oid:"16389"}, runtime: {name:"zzsh_regression_runtime",oid:"16390"} } });
  assert.equal(assertLiveTarget(target, live({system_identifier:isolated.instance.systemIdentifier})).oid, "3375850");
  assert.throws(() => assertLiveTarget(target, live({system_identifier:isolated.instance.systemIdentifier,role_oid:"16390"})), /TARGET_ROLE_OID_MISMATCH/);
  assert.throws(() => assertLiveTarget(target, live({system_identifier:isolated.instance.systemIdentifier,role_oid:undefined})), /TARGET_ROLE_OID_MISMATCH/);
  assert.equal(assertLiveTarget(target, live({system_identifier:isolated.instance.systemIdentifier,role:"zzsh_regression_runtime",role_oid:"16390"}), "runtime").role, "zzsh_regression_runtime");
  assert.throws(() => assertLiveTarget(target, live({system_identifier:isolated.instance.systemIdentifier,role:"zzsh_regression_runtime",role_oid:"16389"}), "runtime"), /TARGET_ROLE_OID_MISMATCH/);
});

test("readback binds registry, checkpoint instance and the migration credential OID", () => {
  const target=normalizeRegisteredTarget({...isolated,roles:{migration:{name:'zzsh_regression_migration',oid:'16389'},runtime:{name:'zzsh_regression_runtime',oid:'16390'}}});
  const binding={database:target.database,oid:target.oid,nonce:target.nonce,instance:target.instance};
  const credential={migration:{name:target.migrationRole,oid:'16389'}};
  assert.doesNotThrow(()=>assertReadbackTarget(target,binding,credential));
  assert.throws(()=>assertReadbackTarget(target,{...binding,instance:{...binding.instance,systemIdentifier:'999'}},credential),/RESOURCE_BINDING_CHANGED/);
  assert.throws(()=>assertReadbackTarget(target,binding,{migration:{...credential.migration,oid:'16390'}}),/RESOURCE_BINDING_CHANGED/);
  assert.throws(()=>assertReadbackTarget({...target,pendingReset:{oid:target.oid}},binding,credential),/RESOURCE_BINDING_CHANGED/);
  const next=normalizeRegisteredTarget({...isolated,instance:{...isolated.instance,port:55435},migrationProfile:'LOCAL_MIGRATION_NEXT_V1',roles:{migration:{name:'zzsh_regression_migration',oid:'16389'},runtime:{name:'zzsh_regression_runtime',oid:'16390'}}});
  const nextBinding={...binding,instance:next.instance,migrationProfile:next.migrationProfile};
  assert.doesNotThrow(()=>assertReadbackTarget(next,nextBinding,credential));
  assert.throws(()=>assertReadbackTarget(next,{...nextBinding,migrationProfile:undefined},credential),/RESOURCE_BINDING_CHANGED/);
});

test("the runtime companion role must be a separate non-privileged login", () => {
  const target = normalizeRegisteredTarget(legacy);
  const row = (over = {}) => ({ rolname: "zzsh_regression_runtime", rolcanlogin: "true", rolsuper: "false", rolcreatedb: "false", rolcreaterole: "false", rolbypassrls: "false", ...over });
  assert.equal(assertRuntimeRoleCompanion(target, row()), true);
  assert.throws(() => assertRuntimeRoleCompanion(target, row({ rolname: "zzsh_regression_migration" })), /TARGET_RUNTIME_ROLE_MISMATCH/);
  assert.throws(() => assertRuntimeRoleCompanion(target, row({ rolsuper: "true" })), /TARGET_RUNTIME_ROLE_MUST_NOT_BE_SUPERUSER/);
  assert.throws(() => assertRuntimeRoleCompanion(target, row({ rolbypassrls: "true" })), /TARGET_RUNTIME_ROLE_MUST_NOT_BYPASS_RLS/);
});

test("the registry file itself must be a regular file next to the credentials", () => {
  const dir = workspace();
  try {
    writeFileSync(join(dir, "credentials.json"), "{}");
    assert.throws(() => loadRegisteredTarget(join(dir, "credentials.json")), /ENOENT/);
    writeFileSync(join(dir, "resource.json"), JSON.stringify(legacy));
    assert.equal(loadRegisteredTarget(join(dir, "credentials.json")).database, "zzsh_test_regression");
    assert.equal(normalizeRegisteredTarget({ ...legacy, protectedDataset: { reason: "REHEARSAL_REVIEW" } }).protectedDataset.reason, "REHEARSAL_REVIEW");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const linkDir = workspace();
  try {
    writeFileSync(join(linkDir, "credentials.json"), "{}");
    writeFileSync(join(linkDir, "real.json"), JSON.stringify(legacy));
    symlinkSync(join(linkDir, "real.json"), join(linkDir, "resource.json"), "file");
    assert.throws(() => loadRegisteredTarget(join(linkDir, "credentials.json")), /TARGET_RESOURCE_FILE_UNSAFE/);
  } catch (error) {
    // Creating a symlink needs extra privilege on some Windows profiles; the own-file check above
    // already runs, and this case must not become a silent pass.
    if (!/EPERM|EACCES|UNKNOWN/.test(String(error?.code))) throw error;
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
});
