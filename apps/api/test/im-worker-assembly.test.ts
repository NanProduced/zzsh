import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool } from "pg";
import { ConfigurationError, loadConfig } from "../src/config/config";
import { OrderDispatchLifecycle } from "../src/im/order-dispatch";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_HOST: "127.0.0.1",
    DB_PORT: "55432",
    DB_NAME: "zzsh_test_dummy",
    DB_USER: "zzsh_dummy_r",
    DB_PASSWORD: "dummy-db-password",
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "56379",
    REDIS_PASSWORD: "dummy-redis-password",
    HOST: "127.0.0.1",
    PORT: "3102",
  };
}

function providerEnv(): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    APP_PROFILE: "provider-test",
    PROVIDER_TEST_SCOPE: "local-fake",
    DB_NAME: "zzsh_provider_test_dummy",
    YUNXIN_ENABLED: "true",
    YUNXIN_APP_KEY: "test-app",
    YUNXIN_APP_SECRET: "test-only-app-secret",
  };
}

const rejects = (env: NodeJS.ProcessEnv, pattern: RegExp): void => {
  assert.throws(
    () => loadConfig(env),
    (error: unknown) => error instanceof ConfigurationError && pattern.test(error.message),
  );
};

test("order group and dispatch workers stay unassembled by default", () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.orderTeams, undefined);
  assert.equal(config.supportDispatch, undefined);

  const explicitOff = loadConfig({ ...baseEnv(), ORDER_TEAMS_ENABLED: "false", SUPPORT_DISPATCH_ENABLED: "false" });
  assert.equal(explicitOff.orderTeams, undefined);
  assert.equal(explicitOff.supportDispatch, undefined);
});

test("order group workers require a members limit when enabled", () => {
  rejects({ ...baseEnv(), ORDER_TEAMS_ENABLED: "true" }, /ORDER_TEAMS_MEMBERS_LIMIT is required/);
});

test("enabling either worker without an enabled Yunxin App is rejected", () => {
  rejects({ ...baseEnv(), ORDER_TEAMS_ENABLED: "true", ORDER_TEAMS_MEMBERS_LIMIT: "50" },
    /ORDER_TEAMS_ENABLED=true requires YUNXIN_ENABLED=true/);
  rejects({ ...baseEnv(), SUPPORT_DISPATCH_ENABLED: "true" },
    /SUPPORT_DISPATCH_ENABLED=true requires YUNXIN_ENABLED=true/);
});

test("valid worker configuration returns the assembled fields and defaults", () => {
  const orderTeams = loadConfig({
    ...providerEnv(),
    ORDER_TEAMS_ENABLED: "true",
    ORDER_TEAMS_MEMBERS_LIMIT: "10",
  });
  assert.deepEqual(orderTeams.orderTeams, { membersLimit: 10, intervalMs: 15000, batchLimit: 5, escalationEnabled: false });
  assert.equal(orderTeams.supportDispatch, undefined);

  const supportDispatch = loadConfig({
    ...providerEnv(),
    SUPPORT_DISPATCH_ENABLED: "true",
    SUPPORT_DISPATCH_INTERVAL_MS: "3000",
    SUPPORT_DISPATCH_BATCH_LIMIT: "7",
  });
  assert.deepEqual(supportDispatch.supportDispatch, {
    appId: "test-app", intervalMs: 3000, batchLimit: 7, autoAssignConsultations: true,
    // Defaults restored with the capacity/first-response facts: 3 follows the historical 0032
    // capacity default, 120s matches the order-group first-response reminder window.
    concurrencyLimit: 3, firstResponseSeconds: 120,
  });

  assert.equal(supportDispatch.orderTeams, undefined);

  const consultationsOff = loadConfig({
    ...providerEnv(),
    SUPPORT_DISPATCH_ENABLED: "true",
    SUPPORT_DISPATCH_AUTO_ASSIGN_CONSULTATIONS: "false",
  });
  assert.deepEqual(consultationsOff.supportDispatch, { appId: "test-app", intervalMs: 15000, batchLimit: 5, autoAssignConsultations: false, concurrencyLimit: 3, firstResponseSeconds: 120 });

  const both = loadConfig({
    ...providerEnv(),
    ORDER_TEAMS_ENABLED: "true",
    ORDER_TEAMS_MEMBERS_LIMIT: "2000",
    ORDER_TEAMS_ESCALATION_ENABLED: "true",
    SUPPORT_DISPATCH_ENABLED: "true",
  });
  assert.deepEqual(both.orderTeams, { membersLimit: 2000, intervalMs: 15000, batchLimit: 5, escalationEnabled: true });
  assert.deepEqual(both.supportDispatch, { appId: "test-app", intervalMs: 15000, batchLimit: 5, autoAssignConsultations: true, concurrencyLimit: 3, firstResponseSeconds: 120 });
});

test("dependent worker settings without their enable switch are rejected", () => {
  for (const [key, value] of [
    ["ORDER_TEAMS_MEMBERS_LIMIT", "50"],
    ["ORDER_TEAMS_INTERVAL_MS", "15000"],
    ["ORDER_TEAMS_BATCH_LIMIT", "5"],
    ["ORDER_TEAMS_ESCALATION_ENABLED", "false"],
  ] as const) rejects({ ...baseEnv(), ORDER_TEAMS_ENABLED: "false", [key]: value }, /ORDER_TEAMS_ENABLED=true/);
  for (const [key, value] of [
    ["SUPPORT_DISPATCH_INTERVAL_MS", "15000"],
    ["SUPPORT_DISPATCH_BATCH_LIMIT", "5"],
    ["SUPPORT_DISPATCH_AUTO_ASSIGN_CONSULTATIONS", "false"],
  ] as const) rejects({ ...baseEnv(), [key]: value }, /SUPPORT_DISPATCH_ENABLED=true/);
});

test("worker switches and numbers reject malformed or out-of-range values", () => {
  rejects({ ...baseEnv(), ORDER_TEAMS_ENABLED: "TRUE" }, /ORDER_TEAMS_ENABLED must be true or false/);
  rejects({ ...baseEnv(), ORDER_TEAMS_ENABLED: "1" }, /ORDER_TEAMS_ENABLED must be true or false/);
  rejects({ ...baseEnv(), SUPPORT_DISPATCH_ENABLED: "yes" }, /SUPPORT_DISPATCH_ENABLED must be true or false/);

  for (const value of ["1.5", "not-a-number", "999", "600001"]) {
    rejects({ ...baseEnv(), ORDER_TEAMS_ENABLED: "true", ORDER_TEAMS_MEMBERS_LIMIT: "50", ORDER_TEAMS_INTERVAL_MS: value },
      /ORDER_TEAMS_INTERVAL_MS must be an integer between 1000 and 600000/);
  }
  for (const value of ["0", "101", "2.5"]) {
    rejects({ ...baseEnv(), ORDER_TEAMS_ENABLED: "true", ORDER_TEAMS_MEMBERS_LIMIT: "50", ORDER_TEAMS_BATCH_LIMIT: value },
      /ORDER_TEAMS_BATCH_LIMIT must be an integer between 1 and 100/);
  }
  for (const value of ["9", "2001", "10.5"]) {
    rejects({ ...baseEnv(), ORDER_TEAMS_ENABLED: "true", ORDER_TEAMS_MEMBERS_LIMIT: value },
      /ORDER_TEAMS_MEMBERS_LIMIT must be an integer between 10 and 2000/);
  }
  rejects({ ...providerEnv(), ORDER_TEAMS_ENABLED: "true", ORDER_TEAMS_MEMBERS_LIMIT: "50", ORDER_TEAMS_ESCALATION_ENABLED: "maybe" },
    /ORDER_TEAMS_ESCALATION_ENABLED must be true or false/);

  for (const value of ["0", "600001", "abc"]) {
    rejects({ ...baseEnv(), SUPPORT_DISPATCH_ENABLED: "true", SUPPORT_DISPATCH_INTERVAL_MS: value },
      /SUPPORT_DISPATCH_INTERVAL_MS must be an integer between 1000 and 600000/);
  }
  rejects({ ...baseEnv(), SUPPORT_DISPATCH_ENABLED: "true", SUPPORT_DISPATCH_BATCH_LIMIT: "1.5" },
    /SUPPORT_DISPATCH_BATCH_LIMIT must be an integer between 1 and 100/);
  for (const value of ["TRUE", "1", "yes"]) {
    rejects({ ...providerEnv(), SUPPORT_DISPATCH_ENABLED: "true", SUPPORT_DISPATCH_AUTO_ASSIGN_CONSULTATIONS: value },
      /SUPPORT_DISPATCH_AUTO_ASSIGN_CONSULTATIONS must be true or false/);
  }
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

/** Minimal Pool stand-in: every statement succeeds with no rows, no database needed. */
function countingPool(): { pool: Pool; connects: () => number } {
  let connects = 0;
  const pool = {
    connect: async () => {
      connects++;
      return { query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined };
    },
  } as unknown as Pool;
  return { pool, connects: () => connects };
}

test("the dispatch worker runs the consultation tick after a successful dispatch", async () => {
  const { pool } = countingPool();
  const worker = new OrderDispatchLifecycle();
  const events: string[] = [];
  const ticked = deferred();
  worker.start({ pool, appId: "app_test", batchLimit: 5, intervalMs: 600000,
    onResult: () => { events.push("result"); },
    onFailure: (code) => { events.push(code); },
    consultationTick: async () => { events.push("tick"); ticked.resolve(); } });
  await ticked.promise;
  await worker.beforeApplicationShutdown();
  assert.deepEqual(events, ["result", "tick"]);
});

test("the consultation tick still runs after a failed dispatch", async () => {
  const worker = new OrderDispatchLifecycle();
  const events: string[] = [];
  const ticked = deferred();
  const failing = { connect: async () => { throw Object.assign(new Error("connect failed"), { code: "08006" }); } } as unknown as Pool;
  worker.start({ pool: failing, appId: "app_test", batchLimit: 5, intervalMs: 600000,
    onFailure: (code) => { events.push(code); },
    consultationTick: async () => { events.push("tick"); ticked.resolve(); } });
  await ticked.promise;
  await worker.beforeApplicationShutdown();
  assert.deepEqual(events, ["DISPATCH_FAILED", "tick"]);
});

test("a failing consultation tick is logged and cannot change the dispatch outcome", async () => {
  const { pool } = countingPool();
  const worker = new OrderDispatchLifecycle();
  const logs: string[] = [];
  (worker as unknown as { logger: { error: (value: string) => void } }).logger.error = (value) => { logs.push(value); };
  const events: string[] = [];
  const firstTick = deferred(), secondTick = deferred();
  let ticks = 0;
  const options = { pool, appId: "app_test", batchLimit: 5, intervalMs: 600000,
    onResult: () => { events.push("result"); }, onFailure: (code: string) => { events.push(code); } };
  worker.start({ ...options, consultationTick: async () => {
    ticks++;
    if (ticks === 1) { firstTick.resolve(); throw new Error("consultation sweep unavailable"); }
    secondTick.resolve();
  } });
  await firstTick.promise;
  await worker.beforeApplicationShutdown();
  assert.deepEqual(events, ["result"]);
  assert.deepEqual(logs.map((line) => JSON.parse(line)), [{ event: "im.order.dispatch.observer_failed", kind: "CONSULTATION" }]);
  worker.start({ ...options, consultationTick: async () => { ticks++; secondTick.resolve(); } });
  await secondTick.promise;
  await worker.beforeApplicationShutdown();
  assert.deepEqual(events, ["result", "result"]);
  assert.equal(ticks, 2);
});

test("wake bursts while the consultation tick is running stay on one dispatch", async () => {
  const { pool } = countingPool();
  const worker = new OrderDispatchLifecycle();
  const entered = deferred(), release = deferred(), finished = deferred();
  let ticks = 0;
  let results = 0;
  worker.start({ pool, appId: "app_test", batchLimit: 1, intervalMs: 600000,
    onResult: () => { results++; },
    consultationTick: async () => {
      ticks++;
      if (ticks === 1) { entered.resolve(); await release.promise; finished.resolve(); }
    } });
  await entered.promise;
  worker.wake();
  worker.wake();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(results, 1, "the consultation tick stays inside the single in-flight slot");
  release.resolve();
  await finished.promise;
  await worker.beforeApplicationShutdown();
  assert.equal(results, 1);
  assert.equal(ticks, 1);
});
