import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ConfigurationError, loadConfig } from "../src/config/config";

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
  assert.deepEqual(supportDispatch.supportDispatch, { appId: "test-app", intervalMs: 3000, batchLimit: 7 });
  assert.equal(supportDispatch.orderTeams, undefined);

  const both = loadConfig({
    ...providerEnv(),
    ORDER_TEAMS_ENABLED: "true",
    ORDER_TEAMS_MEMBERS_LIMIT: "2000",
    ORDER_TEAMS_ESCALATION_ENABLED: "true",
    SUPPORT_DISPATCH_ENABLED: "true",
  });
  assert.deepEqual(both.orderTeams, { membersLimit: 2000, intervalMs: 15000, batchLimit: 5, escalationEnabled: true });
  assert.deepEqual(both.supportDispatch, { appId: "test-app", intervalMs: 15000, batchLimit: 5 });
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
});
