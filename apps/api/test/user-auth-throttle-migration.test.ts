import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { preflightPostgresUserAuthThrottle } from "../src/auth/user-auth-throttle";
import { prepareBusinessInitial, readBusinessInitialRegistry } from "../src/database/business-initial";
import { BUSINESS_INITIAL_ROOT, BUSINESS_MIGRATIONS_FOLDER, configureUserAuthThrottlePrivileges } from "../src/database/business-migrations";

type PrivilegePool = Parameters<typeof configureUserAuthThrottlePrivileges>[0];

test("authentication throttle ACL skips an older schema but rejects a partial one", async () => {
  for (const [state, shouldReject] of [
    [{ event: false, captcha: false, sequence: false }, false],
    [{ event: true, captcha: false, sequence: true }, true],
  ] as const) {
    let calls = 0;
    const pool = { query: async () => { calls += 1; return { rows: [state] }; } } as unknown as PrivilegePool;
    const operation = configureUserAuthThrottlePrivileges(pool, "runtime_user");
    if (shouldReject) await assert.rejects(operation, /schema is incomplete/);
    else await operation;
    assert.equal(calls, 1);
  }
});

test("authentication throttle ACL rejects an unsafe role before issuing grants", async () => {
  let calls = 0;
  const pool = { query: async () => { calls += 1; return { rows: [{ event: true, captcha: true, sequence: true }] }; } } as unknown as PrivilegePool;
  await assert.rejects(configureUserAuthThrottlePrivileges(pool, "runtime;drop"), /safe identifier/);
  assert.equal(calls, 1);
});

test("PostgreSQL authentication throttle cannot start with missing or unreadable dependencies", async () => {
  const pool = (ready: boolean) => ({ query: async () => ({ rows: [{ ready }] }) }) as unknown as PrivilegePool;
  await preflightPostgresUserAuthThrottle(pool(true));
  await assert.rejects(preflightPostgresUserAuthThrottle(pool(false)), /USER_AUTH_THROTTLE_SCHEMA_NOT_READY/);
  const unavailable = { query: async () => { throw new Error("private database detail"); } } as unknown as PrivilegePool;
  await assert.rejects(preflightPostgresUserAuthThrottle(unavailable), error =>
    error instanceof Error && error.message === "USER_AUTH_THROTTLE_SCHEMA_NOT_READY");
});

test("production initial installation includes the authentication throttle migration tail", () => {
  const baseline = readBusinessInitialRegistry(BUSINESS_INITIAL_ROOT).supported.find(item => item.name === "release_production_0174");
  assert.ok(baseline);
  const prepared = prepareBusinessInitial(BUSINESS_MIGRATIONS_FOLDER, baseline.folder);
  try {
    const journal = JSON.parse(readFileSync(join(prepared.folder, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    assert.deepEqual(journal.entries.slice(-2).map(entry => entry.tag), ["0175_legacy_account_capture_facts", "0176_user_auth_throttle"]);
    assert.ok(readFileSync(join(prepared.folder, "0176_user_auth_throttle.sql"), "utf8").includes("user_auth_captcha_used"));
  } finally { prepared.cleanup(); }
});
