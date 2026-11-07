import { strict as assert } from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertLiveTarget,
  assertRuntimeRoleCompanion,
  assertReadbackTarget,
  loadRegisteredTarget,
  normalizeRegisteredTarget,
} from "./local-target-registry.mjs";

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
