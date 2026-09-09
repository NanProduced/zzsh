import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createApp } from "../src/app";
import { ReadinessService } from "../src/health/readiness";

function fakeHealthDependencies(overrides: {
  postgres?: () => Promise<void>;
  redis?: () => Promise<void>;
  closePostgres?: () => Promise<void>;
  closeRedis?: () => Promise<void>;
} = {}) {
  return {
    postgres: {
      check: overrides.postgres ?? (async () => undefined),
      close: overrides.closePostgres ?? (async () => undefined),
    },
    redis: {
      check: overrides.redis ?? (async () => undefined),
      close: overrides.closeRedis ?? (async () => undefined),
    },
  };
}

async function startApp(options: Parameters<typeof createApp>[0] = {
  health: { dependencies: fakeHealthDependencies() },
}) {
  const app = await createApp(options);
  await app.listen(0, "127.0.0.1");
  return app;
}

test("HTTP liveness is independent from explicit fake dependency readiness", async () => {
  const app = await startApp();
  try {
    const url = await app.getUrl();
    const health = await fetch(url + "/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "zzsh-api", scope: "liveness" });
    assert.equal((await fetch(url + "/docs-json")).status, 200);
    const ready = await fetch(url + "/api/ready");
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ok", service: "zzsh-api", scope: "readiness" });
    assert.equal((await fetch(url + "/api/orders", { method: "POST" })).status, 404);
    assert.equal((await fetch(url + "/api/v1/contracts/validate", { method: "POST" })).status, 404);
    assert.equal((await fetch(url + "/api/logging/ok")).status, 404);
    const spec = await (await fetch(url + "/docs-json")).json() as { paths: Record<string, unknown> };
    assert.ok(spec.paths["/api/health"]);
    assert.ok(spec.paths["/api/ready"]);
    assert.equal(spec.paths["/api/v1/contracts/validate"], undefined);
    assert.equal(spec.paths["/api/logging/ok"], undefined);
  } finally { await app.close(); }
});

test("readiness returns safe 503 on dependency failure and recovers", async () => {
  let databaseAvailable = false;
  let redisAvailable = true;
  const app = await startApp({
    health: {
      timeoutMs: 50,
      dependencies: fakeHealthDependencies({
        postgres: async () => {
          if (!databaseAvailable) throw new Error("private database failure");
        },
        redis: async () => {
          if (!redisAvailable) throw new Error("private redis failure");
        },
      }),
    },
  });
  try {
    const url = await app.getUrl();
    const failed = await fetch(url + "/api/ready", { headers: { "X-Request-Id": "req_ready_failure" } });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("x-request-id"), "req_ready_failure");
    assert.doesNotMatch(await failed.text(), /private database|private redis/);
    assert.equal((await fetch(url + "/api/health")).status, 200);

    databaseAvailable = true;
    const recovered = await fetch(url + "/api/ready");
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { status: "ok", service: "zzsh-api", scope: "readiness" });

    redisAvailable = false;
    const redisFailed = await fetch(url + "/api/ready");
    assert.equal(redisFailed.status, 503);
    assert.doesNotMatch(await redisFailed.text(), /private database|private redis/);
    assert.equal((await fetch(url + "/api/health")).status, 200);
  } finally { await app.close(); }
});

test("readiness timeout is finite and shutdown is idempotent", async () => {
  let closePostgresCalls = 0;
  let closeRedisCalls = 0;
  const app = await startApp({
    health: {
      timeoutMs: 25,
      dependencies: fakeHealthDependencies({
        postgres: () => new Promise<void>(() => undefined),
        closePostgres: async () => { closePostgresCalls += 1; },
        closeRedis: async () => { closeRedisCalls += 1; },
      }),
    },
  });
  try {
    const url = await app.getUrl();
    const ready = await fetch(url + "/api/ready");
    assert.equal(ready.status, 503);
    assert.equal((await fetch(url + "/api/health")).status, 200);

    const readiness = app.get(ReadinessService);
    await readiness.beforeApplicationShutdown();
    await readiness.beforeApplicationShutdown();
    assert.equal(closePostgresCalls, 1);
    assert.equal(closeRedisCalls, 1);
    assert.equal((await fetch(url + "/api/health")).status, 200);
    assert.equal((await fetch(url + "/api/ready")).status, 503);
    const rejected = await fetch(url + "/api/orders", { headers: { "X-Request-Id": "req_shutdown_work" } });
    assert.equal(rejected.status, 503);
    assert.doesNotMatch(await rejected.text(), /private|postgres|redis/);
  } finally { await app.close(); }
});

test("app.close invokes dependency shutdown without requiring process.exit", async () => {
  let closePostgresCalls = 0;
  let closeRedisCalls = 0;
  let closePostgresCompleted = false;
  const app = await startApp({
    health: {
      timeoutMs: 25,
      dependencies: fakeHealthDependencies({
        closePostgres: async () => {
          closePostgresCalls += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          closePostgresCompleted = true;
        },
        closeRedis: async () => { closeRedisCalls += 1; },
      }),
    },
  });
  const startedAt = Date.now();
  await app.close();
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(closePostgresCalls, 1);
  assert.equal(closeRedisCalls, 1);
  assert.equal(closePostgresCompleted, true);
});

test("shutdown drains an in-flight HTTP readiness request before closing dependencies", async () => {
  let releaseCheck!: () => void;
  let checkStarted!: () => void;
  let httpResponseCompleted = false;
  let closeStarted = false;
  const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve; });
  const startedGate = new Promise<void>((resolve) => { checkStarted = resolve; });
  const requestId = "req_slow_shutdown";
  const app = await startApp({
    logSink: {
      write: (event) => {
        if (event.requestId === requestId) httpResponseCompleted = true;
      },
    },
    health: {
      timeoutMs: 100,
      dependencies: fakeHealthDependencies({
        postgres: async () => {
          checkStarted();
          await checkGate;
        },
        closePostgres: async () => {
          closeStarted = true;
          assert.equal(httpResponseCompleted, true);
        },
      }),
    },
  });
  try {
    const url = await app.getUrl();
    const responsePromise = fetch(url + "/api/ready", { headers: { "X-Request-Id": requestId } });
    await startedGate;
    const readiness = app.get(ReadinessService);
    const shutdownPromise = readiness.beforeApplicationShutdown();
    assert.equal(closeStarted, false);
    releaseCheck();
    const response = await responsePromise;
    assert.equal(response.status, 503);
    await response.text();
    await shutdownPromise;
    assert.equal(httpResponseCompleted, true);
    assert.equal(closeStarted, true);
  } finally { await app.close(); }
});

test("shutdown force-closes an HTTP request that misses the drain deadline", async () => {
  let checkStarted!: () => void;
  const startedGate = new Promise<void>((resolve) => { checkStarted = resolve; });
  const app = await startApp({
    health: {
      timeoutMs: 100,
      shutdownTimeoutMs: 10,
      dependencies: fakeHealthDependencies({
        postgres: () => {
          checkStarted();
          return new Promise<void>(() => undefined);
        },
      }),
    },
  });
  try {
    const responsePromise = fetch(`${await app.getUrl()}/api/ready`);
    await startedGate;
    const shutdownPromise = app.get(ReadinessService).beforeApplicationShutdown();
    const [responseResult, shutdownResult] = await Promise.allSettled([
      responsePromise,
      shutdownPromise,
    ]);
    assert.equal(responseResult.status, "rejected");
    assert.equal(shutdownResult.status, "fulfilled");
  } finally { await app.close(); }
});
