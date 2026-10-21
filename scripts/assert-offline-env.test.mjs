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

test("an unregistered executable suite is detected without importing any inventoried suite", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { analyze, classify, findUnregistered } = await import("./check-test-entries.mjs");
  const root = await mkdtemp(join(tmpdir(), "zzsh-entry-check-"));
  try {
    const api = join(root, "apps/api");
    await mkdir(join(api, "test"), { recursive: true });
    await writeFile(join(api, "package.json"), JSON.stringify({
      name: "@zzsh/api",
      scripts: { "test:compiled": "node --test dist/test/registered.test.js" },
    }));
    await writeFile(join(api, "test/registered.test.ts"), 'import { test } from "node:test";\ntest("registered", () => {});\n');
    await writeFile(join(api, "test/orphan.test.ts"), 'import { test } from "node:test";\ntest("orphan", () => {});\n');
    await writeFile(join(api, "test/helper.ts"), 'export const helper = 1;\n');

    const analysis = await analyze({
      root,
      workspaces: [{ dir: "apps/api", pkgName: "@zzsh/api", testDir: "apps/api/test" }],
    });
    const rows = classify(analysis);
    // The counter-example is found by static inspection: nothing was imported or run.
    assert.deepEqual(findUnregistered(rows).map(r => r.file), ["orphan.test.ts"]);
    // A registered suite is not reported, and a helper is never an orphan.
    assert.equal(rows.find(r => r.file === "registered.test.ts").category, "default");
    assert.equal(rows.find(r => r.file === "helper.ts").category, "helper-unreferenced");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the 5 order PG helpers are helpers, not unregistered default suites", async () => {
  const { analyze, classify, findUnregistered } = await import("./check-test-entries.mjs");
  const analysis = await analyze();
  const rows = classify(analysis);
  const helpers = [
    "order-payment-im-postgres.test.ts",
    "settlement-postgres.test.ts",
    "order-dispatch-postgres.test.ts",
    "order-team-postgres.test.ts",
    "order-first-response-postgres.test.ts",
  ];
  for (const name of helpers) {
    const row = rows.find(r => r.file === name);
    assert.ok(row, name);
    // They carry no node:test runner binding of their own, and the registered
    // order-reservation suite imports them.
    assert.equal(row.category, "helper", name);
    assert.ok(row.importedBy.includes("order-reservation.test.ts"), `${name} imported by order-reservation`);
  }
  // The real repository has no unregistered executable suite.
  assert.deepEqual(findUnregistered(rows).map(r => `${r.workspace}:${r.file}`), []);
});
