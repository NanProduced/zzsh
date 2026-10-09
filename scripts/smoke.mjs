import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Build first. Only starts local framework servers; no database or provider calls.
const root = resolve(import.meta.dirname, "..");
const children = [];
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
function start(script, args, cwd, env = {}) {
  const childEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  const child = spawn(process.execPath, [script, ...args], {
    cwd, env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.on("data", data => { child.output = (child.output + data).slice(-6000); });
  child.stderr.on("data", data => { child.output = (child.output + data).slice(-6000); });
  child.on("error", error => { child.failure = error; });
  children.push(child);
  return child;
}
// Consume the body inside its request deadline; never leak a live Response to Promise.all callers.
export async function readResponse(url, stage) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    const body = await response.text();
    return { ok: response.ok, status: response.status, url: response.url, body };
  } catch (error) {
    throw new Error(stage + " " + url + ": " + (error?.name ?? "Error") + " " + (error?.cause?.code ?? ""));
  }
}
export async function waitFor(child, url, stage) {
  let last = "not requested";
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.failure || child.exitCode !== null) throw new Error(stage + " " + url + ": child failed/exited " + (child.failure?.code ?? child.exitCode));
    try {
      const response = await readResponse(url, stage);
      if (response.ok) return response;
      last = "HTTP " + response.status;
    } catch (error) { last = error.message; }
    await delay(250);
  }
  throw new Error(stage + " " + url + ": readiness exhausted; " + last);
}
async function runSmoke() {
try {
  for (const name of await readdir(resolve(root, "apps/admin/dist/assets"))) {
    if (!name.endsWith(".js")) continue;
    const bundle = await readFile(resolve(root, "apps/admin/dist/assets", name), "utf8");
    assert.doesNotMatch(bundle, /DevAuthPreview|DevlLoginBaseline|DevlOnboardingBaseline|UI 预览沙盒/, "Admin artifacts must not include the removed mock preview");
  }
  const webPort = await freePort(), adminPort = await freePort(), apiPort = await freePort();
  const web = start(resolve(root, "node_modules/next/dist/bin/next"), ["start", "-H", "127.0.0.1", "-p", String(webPort)], resolve(root, "apps/web"));
  const admin = start(resolve(root, "node_modules/vite/bin/vite.js"), ["preview", "--host", "127.0.0.1", "--port", String(adminPort), "--strictPort"], resolve(root, "apps/admin"));
  const api = start(resolve(root, "apps/api/dist/src/main.js"), [], root, {
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    READINESS_MODE: "fake",
    DB_TARGET: "local-compose",
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    DB_HOST: "127.0.0.1",
    DB_PORT: "55432",
    DB_NAME: "zzsh_test",
    DB_USER: "zzsh",
    DB_PASSWORD: "smoke-only-fake",
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "56379",
    REDIS_PASSWORD: "smoke-only-fake",
    DB_PASSWORD_FILE: undefined,
    REDIS_PASSWORD_FILE: undefined,
    PROVIDER_TEST_SCOPE: undefined,
    ECS_TEST_TARGET: undefined,
    ECS_TEST_TARGET_CONFIRMED: undefined,
  });
  const [webResponse, adminResponse, apiResponse, apiReadyResponse] = await Promise.all([
    waitFor(web, `http://127.0.0.1:${webPort}/`, "web-home"),
    waitFor(admin, `http://127.0.0.1:${adminPort}/`, "admin-home"),
    waitFor(api, `http://127.0.0.1:${apiPort}/api/health`, "api-health"),
    waitFor(api, `http://127.0.0.1:${apiPort}/api/ready`, "api-ready"),
  ]);
  const webHtml = webResponse.body;
  assert.match(webHtml, /洲洲商行/);
  assert.match(webHtml, /id="main-content"/);
  assert.match(webHtml, /三角洲行动/);
  const loginResponse = await readResponse(`http://127.0.0.1:${webPort}/login`, "web-login");
  assert.equal(loginResponse.status, 200, "The separate login route must remain available");
  const adminHtml = adminResponse.body;
  assert.match(adminHtml, /洲洲商行/);
  const asset = adminHtml.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset, "Admin build must reference a JavaScript bundle");
  assert.equal((await readResponse(new URL(asset, adminResponse.url), "admin-asset")).status, 200);
  assert.deepEqual(JSON.parse(apiResponse.body), { status: "ok", service: "zzsh-api", scope: "liveness" });
  assert.deepEqual(JSON.parse(apiReadyResponse.body), { status: "ok", service: "zzsh-api", scope: "readiness" });
  assert.equal((await readResponse(`http://127.0.0.1:${apiPort}/docs`, "api-production-docs")).status, 404);
  console.log("PASS: built web, admin assets, API liveness and production docs boundary");
} finally {
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  }));
}

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runSmoke();
