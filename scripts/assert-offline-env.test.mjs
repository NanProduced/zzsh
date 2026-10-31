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
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "zzsh", scripts: { "check:offline": "npm run test:compiled -w @zzsh/api" },
    }));
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

test("compiled runner inventory reads its explicit manifest without executing suites", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { collectEntries } = await import("./check-test-entries.mjs");
  const root = await mkdtemp(join(tmpdir(), "zzsh-compiled-manifest-"));
  try {
    await mkdir(join(root, "scripts"));
    const pkg = { scripts: { "test:compiled": "node scripts/run-compiled-tests.mjs" } };
    for (const value of [[], ["../outside.js"], ["dist/test/a.test.js", "dist/test/a.test.js"], { files: [] }]) {
      await writeFile(join(root, "scripts/compiled-tests.json"), JSON.stringify(value));
      assert.deepEqual(collectEntries(pkg, root), []);
    }
    await writeFile(join(root, "scripts/compiled-tests.json"), '["dist/test/a.test.js"]');
    assert.deepEqual(collectEntries(pkg, root)[0].files, ["dist/test/a.test.js"]);
    const migration = { scripts: { "test:migration-rehearsal": "node --test scripts/migration/legacy-rehearsal.test.mjs" } };
    assert.deepEqual(collectEntries(migration, root)[0].files, ["scripts/migration/legacy-rehearsal.test.mjs"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("regression runner inventory reads literal suites and rejects unknown selections without running it", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { collectEntries } = await import("./check-test-entries.mjs");
  const root = await mkdtemp(join(tmpdir(), "zzsh-regression-inventory-"));
  try {
    await mkdir(join(root, "scripts"));
    const file = join(root, "scripts/run-regression-suites.mjs");
    await writeFile(file, 'const SUITES = ["auth", "supply-m3b"]; throw new Error("must not execute");');
    const command = "node --env-file-if-exists=.env scripts/run-regression-suites.mjs";
    const read = suffix => collectEntries({ scripts: { "test:db": command + suffix } }, root);
    assert.deepEqual(read("")[0].files, ["dist/test/auth.test.js", "dist/test/supply-m3b.test.js"]);
    assert.deepEqual(read(" --rounds 1 --suites auth")[0].files, ["dist/test/auth.test.js"]);
    for (const args of [" --suites forged", " --suites auth,auth", " --rounds 3", " --continue", " --suites", " --rounds 1 --rounds 2"]) assert.deepEqual(read(args), []);
    for (const source of ['const SUITES = ["auth", "auth"];', 'const SUITES = ["../foreign"];', 'const SUITES = makeSuites();']) {
      await writeFile(file, source); assert.deepEqual(read(""), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runner bindings distinguish value aliases and namespaces from type-only imports", async () => {
  const { isExecutableSuite } = await import("./check-test-entries.mjs");
  const cases = [
    ['import { test as check } from "node:test";', true],
    ['import { describe as group, it as check } from "node:test";', true],
    ['import check from "node:test";', true],
    ['import * as runner from "node:test"; runner.test("case", () => {});', true],
    ['import { type test, type TestContext } from "node:test";', false],
    ['import type { test as check } from "node:test";', false],
    ['import type check from "node:test";', false],
    ['import type * as runner from "node:test";', false],
    ['import { before, type TestContext } from "node:test";', false],
    ['// import { test } from "node:test";\nexport const helper = 1;', false],
  ];
  for (const [source, expected] of cases) assert.equal(isExecutableSuite(source), expected, source);
});

async function entryFixture(files, scripts, run) {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { analyze, classify } = await import("./check-test-entries.mjs");
  const root = await mkdtemp(join(tmpdir(), "zzsh-entry-check-"));
  try {
    await mkdir(join(root, "apps/api/test"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "zzsh", scripts: {
      "check:offline": "npm run offline", offline: "npm test -w @zzsh/api",
      check: "npm run check:offline && npm run test:db:compiled -w @zzsh/api",
    } }));
    await writeFile(join(root, "apps/api/package.json"), JSON.stringify({ name: "@zzsh/api", scripts }));
    for (const [name, source] of Object.entries(files)) await writeFile(join(root, "apps/api/test", name), source);
    const analysis = await analyze({ root, workspaces: [{ dir: "apps/api", pkgName: "@zzsh/api", testDir: "apps/api/test" }] });
    await run(classify(analysis), analysis);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("only actual runners register suites; root npm calls separate offline, check, manual and guarded entries", async () => {
  const suite = 'import { test } from "node:test"; throw new Error("INVENTORY_MUST_NOT_IMPORT");';
  await entryFixture({
    "offline.test.ts": suite, "db-only.test.ts": suite,
    "manual.test.ts": suite + ' test("PG", { skip: !process.env.IM_PG_TEST }, () => {});',
    "guarded.test.ts": suite, "printed.test.ts": suite, "unknown.test.ts": suite,
    "unknown-import.test.ts": 'const { test } = require("node:test");',
  }, {
    test: "npm run test:compiled", "test:compiled": "node --import ../../scripts/assert-offline-env.mjs --test dist/test/offline.test.js",
    "test:db:compiled": "node --test dist/test/db-only.test.js",
    manual: "node --env-file-if-exists=.env --test dist/test/manual.test.js",
    guarded: 'node --env-file-if-exists=.env -e "require(\'node:assert/strict\').ok(process.env.PG_OPT_IN===\'1\')" && node --test dist/test/guarded.test.js',
    "print-path": "echo dist/test/printed.test.js",
    unsupported: "unknown-runner dist/test/unknown.test.js",
  }, (rows, analysis) => {
    const byName = Object.fromEntries(rows.map(row => [row.file, row]));
    assert.equal(byName["offline.test.ts"].category, "default");
    assert.equal(byName["db-only.test.ts"].category, "check-only");
    assert.equal(byName["manual.test.ts"].category, "manual-file-optin");
    assert.equal(byName["guarded.test.ts"].category, "pg-opt-in");
    assert.equal(byName["printed.test.ts"].category, "unregistered");
    assert.equal(byName["unknown.test.ts"].category, "unregistered");
    assert.equal(byName["unknown-import.test.ts"].category, "UNKNOWN");
    assert.ok(analysis.unknownScripts.some(row => row.script === "unsupported" && row.status === "UNKNOWN"));
  });
});

test("registration follows runtime import reachability through helpers, never disconnected chains, cycles or type edges", async () => {
  const suite = 'import { test } from "node:test"; throw new Error("INVENTORY_MUST_NOT_IMPORT");';
  await entryFixture({
    "root.test.ts": suite + ' import "./reachable-helper.js"; import type { Marker } from "./type-edge.test";',
    "reachable-helper.ts": 'export { marker } from "./child.test";',
    "child.test.ts": suite + ' export const marker = 1;',
    "unused-helper.ts": 'import "./orphan.test";', "orphan.test.ts": suite,
    "cycle-a.test.ts": suite + ' import "./cycle-b.test";',
    "cycle-b.test.ts": suite + ' import "./cycle-a.test";',
    "type-edge.test.ts": suite + ' export type Marker = string;',
  }, { test: "node --test dist/test/root.test.js", "test:db:compiled": "node --test dist/test/root.test.js" }, rows => {
    const byName = Object.fromEntries(rows.map(row => [row.file, row]));
    assert.equal(byName["child.test.ts"].category, "default");
    assert.equal(byName["reachable-helper.ts"].category, "helper");
    for (const name of ["orphan.test.ts", "cycle-a.test.ts", "cycle-b.test.ts", "type-edge.test.ts"]) {
      assert.equal(byName[name].category, "unregistered", name);
      assert.equal(byName[name].reachable, false, name);
    }
  });
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
    assert.equal(row.defaultReachable, false, `${name} is not in check:offline`);
    assert.equal(row.checkReachable, true, `${name} is in the additional root check DB entry`);
    assert.deepEqual(row.reachedFrom, ["@zzsh/api:test:db:compiled", "@zzsh/api:test:db:rounds"], name);
  }
  // The real repository has no unregistered executable suite.
  assert.deepEqual(findUnregistered(rows).map(r => `${r.workspace}:${r.file}`), []);
});
