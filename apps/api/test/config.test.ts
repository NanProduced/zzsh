import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";
import { ConfigurationError, loadConfig, orderImSdkRouteFor } from "../src/config/config";

const secret = "test-only-secret-that-must-not-be-logged";

function validEnv(profile = "dev"): NodeJS.ProcessEnv {
  const base = {
    APP_PROFILE: profile,
    DB_TARGET: profile === "ecs-test" ? "ecs-test" : "local-compose",
    HOST: profile === "ecs-test" ? "0.0.0.0" : "127.0.0.1",
    PORT: "3102",
    DB_HOST: profile === "ecs-test" ? "db.zzsh-ecs-test.internal" : "127.0.0.1",
    DB_PORT: profile === "ecs-test" ? "5432" : "55432",
    DB_USER: "zzsh",
    DB_PASSWORD: secret,
    REDIS_HOST: profile === "ecs-test" ? "redis.zzsh-ecs-test.internal" : "127.0.0.1",
    REDIS_PORT: profile === "ecs-test" ? "6379" : "56379",
    REDIS_PASSWORD: secret,
    ...(profile === "provider-test" ? { PROVIDER_TEST_SCOPE: "local-fake" } : {}),
    ...(profile === "ecs-test"
      ? { ECS_TEST_TARGET: "zzsh-ecs-test", ECS_TEST_TARGET_CONFIRMED: "true" }
      : {}),
  };
  if (profile === "migration") {
    return {
      ...base,
      DB_NAME: "zzsh_dev",
      MIGRATION_TARGET_PROFILE: "dev",
      MIGRATION_TARGET_DB_NAME: "zzsh_dev",
      MIGRATION_DB_USER: "zzsh_migration",
      MIGRATION_DB_PASSWORD: secret,
      MIGRATION_RUNTIME_USER: "zzsh_runtime",
    };
  }
  return {
    ...base,
    DB_NAME: profile === "dev" ? "zzsh_dev" : `zzsh_${profile.replace("-", "_")}`,
  };
}

test("defaults to fake providers with a valid dev target", () => {
  const config = loadConfig(validEnv());
  assert.equal(config.provider, "fake");
  assert.equal(config.testOperationsEnabled, false);
  assert.equal(config.database.target, "local-compose");
});

test("keeps the non-funding test executor opt-in and isolated to test/fake", () => {
  assert.equal(loadConfig(validEnv("test")).testOperationsEnabled, false);
  assert.equal(loadConfig({ ...validEnv("test"), ENABLE_TEST_OPERATIONS: "true" }).testOperationsEnabled, true);
  assert.throws(
    () => loadConfig({ ...validEnv(), ENABLE_TEST_OPERATIONS: "true" }),
    (error: unknown) => error instanceof ConfigurationError && /APP_PROFILE=test and PROVIDER_MODE=fake/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("provider-test"), ENABLE_TEST_OPERATIONS: "true" }),
    (error: unknown) => error instanceof ConfigurationError && /APP_PROFILE=test and PROVIDER_MODE=fake/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("test"), ENABLE_TEST_OPERATIONS: "yes" }),
    (error: unknown) => error instanceof ConfigurationError && /ENABLE_TEST_OPERATIONS/.test(error.message),
  );
});

test("validates profiles available in the current local stage", () => {
  for (const profile of ["dev", "test", "provider-test", "migration"] as const) {
    const config = loadConfig(validEnv(profile));
    assert.equal(config.profile, profile);
    assert.equal(config.database.targetProfile, profile === "migration" ? "dev" : profile);
  }
});

test("rejects invalid profiles, missing fields, and out-of-range ports", () => {
  assert.throws(
    () => loadConfig({ ...validEnv(), APP_PROFILE: "prod" }),
    (error: unknown) => error instanceof ConfigurationError && /APP_PROFILE/.test(error.message),
  );

  const missing = validEnv();
  delete missing.DB_PASSWORD;
  assert.throws(
    () => loadConfig(missing),
    (error: unknown) => error instanceof ConfigurationError && /DB_PASSWORD/.test(error.message),
  );

  const missingSecretFile = validEnv();
  delete missingSecretFile.DB_PASSWORD;
  missingSecretFile.DB_PASSWORD_FILE = ".secrets/does-not-exist";
  assert.throws(
    () => loadConfig(missingSecretFile),
    (error: unknown) => error instanceof ConfigurationError && /DB_PASSWORD_FILE/.test(error.message),
  );

  assert.throws(
    () => loadConfig({ ...validEnv(), DB_PORT: "65536" }),
    (error: unknown) => error instanceof ConfigurationError && /DB_PORT/.test(error.message),
  );
});

test("rejects database targets outside the selected profile boundary", () => {
  assert.throws(
    () => loadConfig({ ...validEnv(), DB_PORT: "5432" }),
    (error: unknown) => error instanceof ConfigurationError && /local-compose ports/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv(), DB_TARGET: "ecs-test" }),
    (error: unknown) => error instanceof ConfigurationError && /DB_TARGET/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("ecs-test"), DB_TARGET: "local-compose" }),
    (error: unknown) => error instanceof ConfigurationError && /APP_PROFILE=ecs-test/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("migration"), MIGRATION_TARGET_PROFILE: "test", MIGRATION_TARGET_DB_NAME: "zzsh_dev" }),
    (error: unknown) => error instanceof ConfigurationError && /test target boundary/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("migration"), MIGRATION_RUNTIME_USER: "zzsh_migration" }),
    (error: unknown) => error instanceof ConfigurationError && /different/.test(error.message),
  );
});

test("retains ecs-test but fails closed until a real target is registered", () => {
  const unconfirmed = validEnv("ecs-test");
  delete unconfirmed.ECS_TEST_TARGET_CONFIRMED;
  assert.throws(
    () => loadConfig(unconfirmed),
    (error: unknown) => error instanceof ConfigurationError && /APP_PROFILE=ecs-test/.test(error.message),
  );

  const exampleTarget = validEnv("ecs-test");
  assert.equal(exampleTarget.ECS_TEST_TARGET_CONFIRMED, "true");
  assert.equal(exampleTarget.DB_HOST, "db.zzsh-ecs-test.internal");
  assert.equal(exampleTarget.REDIS_HOST, "redis.zzsh-ecs-test.internal");
  assert.throws(
    () => loadConfig(exampleTarget),
    (error: unknown) => error instanceof ConfigurationError && /APP_PROFILE=ecs-test/.test(error.message),
  );
});

test("keeps real providers behind provider-test scope and disables them for test and migration", () => {
  assert.throws(
    () => loadConfig({ ...validEnv("test"), PROVIDER_MODE: "real" }),
    (error: unknown) => error instanceof ConfigurationError && /requires PROVIDER_MODE=fake/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("migration"), PROVIDER_MODE: "real" }),
    (error: unknown) => error instanceof ConfigurationError && /requires PROVIDER_MODE=fake/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("provider-test"), PROVIDER_TEST_SCOPE: "" }),
    (error: unknown) => error instanceof ConfigurationError && /PROVIDER_TEST_SCOPE/.test(error.message),
  );
  assert.equal(loadConfig({ ...validEnv("provider-test"), PROVIDER_MODE: "real" }).provider, "real");
});

test("routes only configured order/team/conversation pairs for the bound non-production provider-test App", () => {
  const routeConfig = {
    routeEnvironment: "oim4d-test",
    scopes: [
      { appId: "test-app", orderId: "order-1", teamId: "9001", conversationId: "staff-1|2|9001" },
      { appId: "test-app", orderId: "order-1", teamId: "9001", conversationId: "sys-manager|2|9001" },
    ],
  };
  const env = {
    ...validEnv("provider-test"), PROVIDER_MODE: "real", YUNXIN_ENABLED: "true",
    YUNXIN_APP_KEY: "test-app", YUNXIN_APP_SECRET: secret, YUNXIN_ORDER_TEST_ROUTE_CONFIG: JSON.stringify(routeConfig),
  };
  const config = loadConfig(env);
  assert.deepEqual(config.orderImSdkRouteConfig, routeConfig);
  assert.deepEqual(orderImSdkRouteFor(config.orderImSdkRouteConfig, routeConfig.scopes[0]!), {
    ...routeConfig.scopes[0], routeEnvironment: "oim4d-test",
  });
  for (const change of [
    { appId: "other-app" }, { orderId: "order-2" }, { teamId: "9002" }, { conversationId: "staff-1|2|9002" },
  ]) assert.equal(orderImSdkRouteFor(config.orderImSdkRouteConfig, { ...routeConfig.scopes[0]!, ...change }), undefined);
  assert.throws(() => loadConfig({ ...env, NODE_ENV: "production" }), /non-production provider-test/);
  assert.throws(() => loadConfig({ ...env, YUNXIN_APP_KEY: "other-app" }), /YUNXIN_ORDER_TEST_ROUTE_CONFIG is invalid/);
});

test("fails closed for incomplete or misplaced Yunxin configuration", () => {
  assert.equal(loadConfig(validEnv()).yunxin.enabled, false);
  assert.throws(
    () => loadConfig({ ...validEnv(), YUNXIN_APP_KEY: "app-key" }),
    (error: unknown) => error instanceof ConfigurationError && /credentials require YUNXIN_ENABLED=true/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv(), YUNXIN_ENABLED: "true", YUNXIN_APP_KEY: "app-key", YUNXIN_APP_SECRET: "secret" }),
    (error: unknown) => error instanceof ConfigurationError && /APP_PROFILE=provider-test/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("provider-test"), YUNXIN_ENABLED: "true" }),
    (error: unknown) => error instanceof ConfigurationError && /YUNXIN_APP_KEY/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("provider-test"), YUNXIN_ENABLED: "true", YUNXIN_APP_KEY: "app-key" }),
    (error: unknown) => error instanceof ConfigurationError && /YUNXIN_APP_SECRET/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("provider-test"), YUNXIN_ENABLED: "true", YUNXIN_APP_KEY: "app key", YUNXIN_APP_SECRET: "secret" }),
    (error: unknown) => error instanceof ConfigurationError && /single-line/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv("provider-test"), YUNXIN_ENABLED: "yes" }),
    (error: unknown) => error instanceof ConfigurationError && /YUNXIN_ENABLED/.test(error.message),
  );
});

test("loads Yunxin credentials without enabling other real providers", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "zzsh-yunxin-config-"));
  const secretDirectory = join(workingDirectory, ".secrets");
  mkdirSync(secretDirectory);
  try {
    writeFileSync(join(secretDirectory, "yunxin_secret"), "yunxin-test-secret\n");
    const config = loadConfig(
      {
        ...validEnv("provider-test"),
        YUNXIN_ENABLED: "true",
        YUNXIN_APP_KEY: " app-key ",
        YUNXIN_APP_SECRET_FILE: ".secrets/yunxin_secret",
      },
      workingDirectory,
    );
    assert.equal(config.provider, "fake");
    assert.deepEqual(config.yunxin, {
      enabled: true,
      appKey: "app-key",
      appSecret: "yunxin-test-secret",
    });
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("rejects blank secrets and gives file secrets priority over env values", () => {
  assert.throws(
    () => loadConfig({ ...validEnv(), DB_PASSWORD: "   " }),
    (error: unknown) => error instanceof ConfigurationError && /DB_PASSWORD/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ ...validEnv(), REDIS_PASSWORD: "\t\r\n" }),
    (error: unknown) => error instanceof ConfigurationError && /REDIS_PASSWORD/.test(error.message),
  );

  const workingDirectory = mkdtempSync(join(tmpdir(), "zzsh-config-"));
  const secretDirectory = join(workingDirectory, ".secrets");
  mkdirSync(secretDirectory);
  const env = {
    ...validEnv(),
    DB_PASSWORD: "env-password",
    REDIS_PASSWORD: "env-redis-password",
    DB_PASSWORD_FILE: ".secrets/postgres_password",
    REDIS_PASSWORD_FILE: ".secrets/redis_password",
  };
  try {
    writeFileSync(join(secretDirectory, "postgres_password"), " file-password \r\n");
    writeFileSync(join(secretDirectory, "redis_password"), " file-redis-password \n");
    const config = loadConfig(env, workingDirectory);
    assert.equal(config.database.password, "file-password");
    assert.equal(config.redis.password, "file-redis-password");

    writeFileSync(join(secretDirectory, "postgres_password"), " \t\r\n");
    assert.throws(
      () => loadConfig(env, workingDirectory),
      (error: unknown) => error instanceof ConfigurationError && /non-empty file/.test(error.message),
    );
    assert.throws(
      () => loadConfig({ ...validEnv(), DB_PASSWORD_FILE: "   " }, workingDirectory),
      (error: unknown) => error instanceof ConfigurationError && /DB_PASSWORD_FILE/.test(error.message),
    );
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("does not leak a secret through startup configuration errors", () => {
  const result = spawnSync(process.execPath, [resolve(__dirname, "../src/main.js")], {
    cwd: resolve(__dirname, "../.."),
    env: { ...validEnv(), DB_PORT: "not-a-port" },
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /API configuration rejected/);
  assert.match(output, /DB_PORT/);
  assert.doesNotMatch(output, new RegExp(secret));
});

test("requires distinct auth secrets and secure production cookies", () => {
  const authEnv = {
    AUTH_USER_SECRET: "u".repeat(32),
    AUTH_ADMIN_SECRET: "a".repeat(32),
    AUTH_ADMIN_BOOTSTRAP_SECRET: "b".repeat(32),
    AUTH_SECURE_COOKIES: "false",
  };
  const config = loadAuthRuntimeConfig(authEnv);
  assert.equal(config.adminBootstrapSecret, authEnv.AUTH_ADMIN_BOOTSTRAP_SECRET);
  assert.equal(config.secureCookies, false);
  assert.equal(config.testOperationsEnabled, false);

  assert.throws(
    () => loadAuthRuntimeConfig({ ...authEnv, AUTH_ADMIN_SECRET: authEnv.AUTH_USER_SECRET }),
    (error: unknown) => error instanceof ConfigurationError && /must be different/.test(error.message),
  );
  assert.throws(
    () => loadAuthRuntimeConfig({ ...authEnv, AUTH_ADMIN_BOOTSTRAP_SECRET: authEnv.AUTH_USER_SECRET }),
    (error: unknown) => error instanceof ConfigurationError && /must be different/.test(error.message),
  );
  assert.throws(
    () => loadAuthRuntimeConfig({ ...authEnv, NODE_ENV: "production" }),
    (error: unknown) => error instanceof ConfigurationError && /AUTH_SECURE_COOKIES/.test(error.message),
  );
  assert.equal(loadAuthRuntimeConfig({ ...authEnv, NODE_ENV: "production", AUTH_SECURE_COOKIES: "true" }).secureCookies, true);
});


test("fixed SMS mock is explicit and rejects non-local/production targets", () => {
  const env = { ...validEnv(), PROVIDER_MODE: "fake", AUTH_USER_SECRET: "u".repeat(32), AUTH_ADMIN_SECRET: "a".repeat(32) };
  assert.equal(loadAuthRuntimeConfig(env).localSmsMock, false);
  assert.equal(loadAuthRuntimeConfig({ ...env, AUTH_LOCAL_SMS_MOCK: "true" }).localSmsMock, true);
  for (const override of [
    { NODE_ENV: "production", AUTH_SECURE_COOKIES: "true" },
    { APP_PROFILE: "provider-test" }, { PROVIDER_MODE: "real" },
    { HOST: "0.0.0.0" }, { DB_HOST: "remote.invalid" }, { DB_NAME: "production" },
    { DB_TARGET: "ecs-test" }, { AUTH_USER_ORIGIN: "https://example.com" },
    { AUTH_LOCAL_SMS_MOCK: "yes" },
  ]) assert.throws(() => loadAuthRuntimeConfig({ ...env, AUTH_LOCAL_SMS_MOCK: "true", ...override }), ConfigurationError);
});
