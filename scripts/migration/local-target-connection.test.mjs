import { strict as assert } from "node:assert/strict";
import test from "node:test";
import {
  advisoryLockSql,
  maintenanceConnection,
  normalizeRegisteredTarget,
  targetConnection,
} from "./local-target-registry.mjs";

const target = normalizeRegisteredTarget({
  database: "zzsh_test_regression",
  marker: "zzsh:regression-test:v1",
  oid: "3375850",
  nonce: "0123456789abcdef01234567",
  owner: "zzsh",
  roles: { migration: "zzsh_regression_migration", runtime: "zzsh_regression_runtime" },
  lockKey: "806006",
  instance: { host: "127.0.0.1", port: 55433, systemIdentifier: "7704626787080364068" },
});

test("the target connection carries the registered host, port and database", () => {
  const connection = targetConnection(target, { user: "zzsh_regression_migration", password: "x", applicationName: "round" });
  assert.deepEqual({ ...connection }, {
    host: "127.0.0.1", port: 55433, database: "zzsh_test_regression",
    user: "zzsh_regression_migration", password: "x", application_name: "round",
  });
});

test("the maintenance connection uses the maintenance database on the same instance", () => {
  const connection = maintenanceConnection(target, { user: "zzsh", password: "x", applicationName: "lock" });
  assert.equal(connection.database, "postgres");
  assert.equal(connection.port, 55433);
});

test("lock statements come from the registered key, not from the caller", () => {
  assert.equal(advisoryLockSql(target, "try"), "SELECT pg_try_advisory_lock(806006::bigint) ok");
  assert.equal(advisoryLockSql(target, "unlock"), "SELECT pg_advisory_unlock(806006::bigint) ok");
  assert.throws(() => advisoryLockSql({ ...target, lockKey: "lock" }, "try"), /TARGET_LOCK_KEY_INVALID/);
  assert.throws(() => advisoryLockSql(target, "hold"), /TARGET_LOCK_ACTION_INVALID/);
});

test("a caller cannot smuggle its own host or database over the registry", () => {
  const connection = targetConnection(target, { user: "u", password: "p", database: "zzsh_dev_daily", port: 55432 });
  assert.equal(connection.database, "zzsh_test_regression");
  assert.equal(connection.port, 55433);
});
