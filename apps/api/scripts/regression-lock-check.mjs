// Cross-process proof that the shared resource lock excludes a second entry: this process holds
// 806006 on the maintenance database, a child process must fail to acquire it, and after release the
// child must succeed. Two separate PIDs, one real advisory lock.
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_KEY = "806006";
function resolveSecret() {
  if (process.env.DB_PASSWORD) return process.env.DB_PASSWORD.trim();
  const file = process.env.DB_PASSWORD_FILE?.trim();
  if (!file) throw new Error("DB_PASSWORD or DB_PASSWORD_FILE is required");
  return readFileSync(resolve(process.cwd(), file), "utf8").trim();
}

const client = () => new Client({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 55432),
  database: "postgres",
  user: process.env.DB_USER ?? "zzsh",
  password: resolveSecret(),
  application_name: "zzsh-regression-lock",
  connectionTimeoutMillis: 3000,
});

function child() {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
    encoding: "utf8",
    env: process.env,
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`lock child failed: status=${result.status}, code=${result.error?.code ?? "CHILD_EXIT"}`);
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
  return JSON.parse(line || "{}");
}

if (process.argv.includes("--child")) {
  const c = client();
  await c.connect();
  try {
    const acquired = (await c.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired;
    console.log(JSON.stringify({ pid: process.pid, acquired }));
    if (acquired) await c.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
  } finally {
    await c.end();
  }
  process.exit(0);
}

const holder = client();
await holder.connect();
const verdict = {};
try {
  verdict.held = (await holder.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired === true;
  verdict.contenderWhileHeld = child();
  await holder.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
  verdict.contenderAfterRelease = child();
} finally {
  await holder.end();
}
verdict.pass = verdict.held && verdict.contenderWhileHeld?.acquired === false && verdict.contenderAfterRelease?.acquired === true;
console.log(JSON.stringify(verdict));
process.exitCode = verdict.pass ? 0 : 1;
