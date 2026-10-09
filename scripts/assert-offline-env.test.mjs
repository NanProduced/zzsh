import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const guard = new URL("./assert-offline-env.mjs", import.meta.url).href;
test("offline preload rejects inherited PG switches before importing a test body, without printing values", () => {
  const env = { ...process.env };
  const keys = ["REAL_SOURCE_5_CREDENTIALS_FILE", "ADM_FINANCE_QUERY_PG", "ADMIN_READ_PG_CREDENTIALS"];
  for (const key of keys) delete env[key];
  const run = (extra) => spawnSync(process.execPath, ["--import", guard, "-e", "console.log('TEST_BODY_ENTERED')"], { env: { ...env, ...extra }, encoding: "utf8" });
  const clean = run({});
  assert.equal(clean.status, 0); assert.match(clean.stdout, /TEST_BODY_ENTERED/);
  for (const key of keys) {
    const result = run({ [key]: "private-fixture-value" });
    assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /TEST_BODY_ENTERED/);
    assert.match(result.stderr, new RegExp(key)); assert.doesNotMatch(result.stderr, /private-fixture-value/);
  }
});

test("dedicated PG entries fail without their explicit opt-in, before compilation or test import", async () => {
  const { readFile } = await import("node:fs/promises");
  const { scripts } = JSON.parse(await readFile(new URL("../apps/api/package.json", import.meta.url), "utf8"));
  const required = {
    "test:admin-finance:pg": { ADM_FINANCE_QUERY_PG: "admin_order_read" },
    "test:admin-supervision:pg": { ADMIN_READ_PG_CREDENTIALS: "fixture-path" },
    "test:legacy-observation:pg": { REAL_SOURCE_5_CREDENTIALS_FILE: "fixture-path" },
    "test:credit-guarantee:concurrency:pg": { CREDIT_GUARANTEE_CONCURRENCY_PG: "1" },
    "test:credit-guarantee:pg": { CREDIT_GUARANTEE_PASSWORD: "fixture-only" },
    "test:credit-guarantee:recovery:pg": { CREDIT_GUARANTEE_RUN_RECOVERY: "1" },
    "test:credit-guarantee:business:pg": { CREDIT_GUARANTEE_RUN_BUSINESS: "1", CREDIT_GUARANTEE_ADMIN_PROFILE_FILE: "fixture-path" },
  };
  const env = { ...process.env };
  for (const values of Object.values(required)) for (const key of Object.keys(values)) delete env[key];
  for (const [entry, values] of Object.entries(required)) {
    // Execute the actual package guard only; never import a PG suite or load .env.
    const code = scripts[entry].match(/^node --env-file-if-exists=\.env -e "([^"]+)" && npm run build/)[1];
    const run = (extra) => spawnSync(process.execPath, ["-e", code], { env: { ...env, ...extra }, encoding: "utf8" });
    assert.notEqual(run({}).status, 0, entry);
    assert.equal(run(values).status, 0, entry);
    for (const key of Object.keys(values)) {
      const missing = { ...values }; delete missing[key];
      assert.notEqual(run(missing).status, 0, `${entry} requires ${key}`);
    }
  }
});
