import { strict as assert } from "node:assert";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { loadConfig } from "../src/config/config";

const execFileAsync = promisify(execFile);
const PROJECT = "zzsh-rebuild-local";
const repoRoot = resolve(__dirname, "../../../..");
const apiRoot = resolve(repoRoot, "apps/api");

const TARGETS = {
  postgres: {
    container: "zzsh-rebuild-local-postgres-1",
    image: "postgres:16-alpine",
    containerPort: "5432/tcp",
    hostPort: 55432,
  },
  redis: {
    container: "zzsh-rebuild-local-redis-1",
    image: "redis:7-alpine",
    containerPort: "6379/tcp",
    hostPort: 56379,
  },
} as const;
type CleanupFailure = keyof typeof TARGETS | "api";

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function runDocker(args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("docker", [...args], {
      cwd: repoRoot,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 8 * 1024,
    });
    return result.stdout.trim();
  } catch {
    throw new Error("zzsh readiness Docker command failed");
  }
}

function composeArgs(args: readonly string[]): string[] {
  return ["compose", "-p", PROJECT, ...args];
}

async function compose(args: readonly string[]): Promise<string> {
  return runDocker(composeArgs(args));
}

async function isRunning(container: string): Promise<boolean> {
  return (await runDocker(["inspect", "--format", "{{.State.Running}}", container])) === "true";
}

async function assertOwnedTarget(
  service: keyof typeof TARGETS,
): Promise<void> {
  const target = TARGETS[service];
  const labels = await runDocker([
    "inspect",
    "--format",
    "{{index .Config.Labels \"com.docker.compose.project\"}}|{{index .Config.Labels \"com.docker.compose.service\"}}|{{.Config.Image}}",
    target.container,
  ]);
  assert.equal(labels, `${PROJECT}|${service}|${target.image}`);
  const port = await runDocker(["port", target.container, target.containerPort]);
  assert.match(port, new RegExp(`127\\.0\\.0\\.1:${target.hostPort}(?:\\r?\\n|$)`));
}

async function waitForContainerRunning(container: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isRunning(container)) return;
    await delay(100);
  }
  throw new Error("zzsh readiness container did not start");
}

async function waitForContainerHealthy(container: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await runDocker(["inspect", "--format", "{{.State.Health.Status}}", container]) === "healthy") {
      return;
    }
    await delay(100);
  }
  throw new Error("zzsh readiness container did not become healthy");
}

async function waitForStatus(
  baseUrl: string,
  path: "/api/health" | "/api/ready",
  expectedStatus: number,
  child: ChildProcess,
): Promise<Response> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("API readiness process exited early");
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === expectedStatus) return response;
    } catch {
      // The API is still starting or the dependency is transitioning.
    }
    await delay(100);
  }
  throw new Error("API readiness did not reach the expected state");
}

function startApi(port: number): ChildProcess {
  const child = spawn(process.execPath, [resolve(apiRoot, "dist/src/main.js")], {
    cwd: apiRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      READINESS_MODE: "real",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  child.on("error", () => undefined);
  return child;
}

async function stopApi(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exitPromise = once(child, "exit").then(() => true);
  child.kill("SIGTERM");
  const exited = await Promise.race([
    exitPromise,
    delay(5_000).then(() => false),
  ]);
  if (exited || child.exitCode !== null) return;

  if (child.pid !== undefined) {
    try {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 2 * 1024,
      });
    } catch {
      // The process may have exited between the timeout and taskkill.
    }
  }
  await Promise.race([
    exitPromise.then(() => undefined),
    delay(2_000).then(() => undefined),
  ]);
  if (child.exitCode === null) throw new Error("API readiness process did not stop");
}

async function restoreTarget(
  service: keyof typeof TARGETS,
  initiallyRunning: boolean,
): Promise<void> {
  const target = TARGETS[service];
  const running = await isRunning(target.container);
  if (initiallyRunning && !running) {
    await compose(["start", service]);
    await waitForContainerRunning(target.container);
  }
  if (initiallyRunning) {
    await waitForContainerHealthy(target.container);
  } else if (running) {
    await compose(["stop", service]);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (!(await isRunning(target.container))) return;
      await delay(100);
    }
    throw new Error("zzsh readiness container did not stop");
  }
}

async function restoreIndependently(
  services: readonly (keyof typeof TARGETS)[],
  restore: (service: keyof typeof TARGETS) => Promise<void>,
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  for (const service of services) {
    try {
      await restore(service);
    } catch {
      failures.push(service);
    }
  }
  return failures;
}

test("readiness cleanup attempts every target after an injected first failure", async () => {
  const attempted: (keyof typeof TARGETS)[] = [];
  const failures = await restoreIndependently(["redis", "postgres"], async (service) => {
    attempted.push(service);
    if (service === "redis") throw new Error("injected restore failure");
  });
  assert.deepEqual(attempted, ["redis", "postgres"]);
  assert.deepEqual(failures, ["redis"]);
});

test("real readiness transitions only the confirmed zzsh Compose targets", { timeout: 120_000 }, async () => {
  const config = loadConfig();
  assert.equal(config.database.target, "local-compose");
  assert.equal(config.database.host, "127.0.0.1");
  assert.equal(config.database.port, TARGETS.postgres.hostPort);
  assert.equal(config.redis.host, "127.0.0.1");
  assert.equal(config.redis.port, TARGETS.redis.hostPort);

  await assertOwnedTarget("postgres");
  await assertOwnedTarget("redis");
  await waitForContainerHealthy(TARGETS.postgres.container);
  await waitForContainerHealthy(TARGETS.redis.container);
  const initiallyRunning = {
    postgres: await isRunning(TARGETS.postgres.container),
    redis: await isRunning(TARGETS.redis.container),
  };
  assert.equal(initiallyRunning.postgres, true);
  assert.equal(initiallyRunning.redis, true);

  const port = await freePort();
  const child = startApi(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const ready = await waitForStatus(baseUrl, "/api/ready", 200, child);
    assert.deepEqual(await ready.json(), { status: "ok", service: "zzsh-api", scope: "readiness" });

    await compose(["stop", "redis"]);
    await waitForStatus(baseUrl, "/api/ready", 503, child);
    assert.equal((await waitForStatus(baseUrl, "/api/health", 200, child)).status, 200);
    await compose(["start", "redis"]);
    await waitForStatus(baseUrl, "/api/ready", 200, child);

    await compose(["stop", "postgres"]);
    await waitForStatus(baseUrl, "/api/ready", 503, child);
    assert.equal((await waitForStatus(baseUrl, "/api/health", 200, child)).status, 200);
    await compose(["start", "postgres"]);
    await waitForStatus(baseUrl, "/api/ready", 200, child);
  } finally {
    const cleanupFailures = await restoreIndependently(
      ["redis", "postgres"],
      async (service) => restoreTarget(service, initiallyRunning[service]),
    );
    try {
      await stopApi(child);
    } catch {
      cleanupFailures.push("api");
    }
    if (cleanupFailures.length > 0) {
      throw new Error(`zzsh readiness cleanup failed: ${cleanupFailures.join(",")}`);
    }
  }
});
