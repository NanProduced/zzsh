import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { readMigrationFiles } from "drizzle-orm/migrator";

const runnerPath = resolve("src/database/business-migrations.ts");
const source = transpileModule(readFileSync(runnerPath, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
const folder = resolve("migrations/business"), migrations = readMigrationFiles({ migrationsFolder: folder });
const history = migrations.map(m => ({ hash: m.hash, createdAt: String(m.folderMillis) }));

function fixture(rows: unknown[], present: unknown = true) {
  let ddlCalls = 0, aclConnections = 0;
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => { queries.push(sql); return { rows: sql.includes("to_regclass") ? [{ present }] : rows }; },
    connect: async () => { aclConnections++; throw new Error("ACL_CONNECTION_REACHED"); },
  };
  const exports: Record<string, any> = {}, native = createRequire(runnerPath);
  const require = (id: string) => id === "drizzle-orm/node-postgres" ? { drizzle: () => pool }
    : id === "drizzle-orm/node-postgres/migrator" ? { migrate: async () => { ddlCalls++; } } : native(id);
  runInNewContext(source, { exports, require, __dirname: resolve("src/database") });
  return { queries, prefix: (dir = folder) => exports.assertBusinessMigrationPrefix(pool, dir),
    run: () => exports.runBusinessMigrations(pool, { runtimeUser: "runtime", migrationsFolder: folder }),
    get ddlCalls() { return ddlCalls; }, get aclConnections() { return aclConnections; } };
}

test("migration history accepts new installation, exact prefixes and repeated full-chain reads without writing", async () => {
  const fresh = fixture([], false); await fresh.prefix(); assert.equal(fresh.queries.length, 1);
  for (const size of [0, 1, 112, 113]) {
    const f = fixture(history.slice(0, size)); await f.prefix();
    assert.equal(f.queries.length, 2); assert.equal(f.ddlCalls, 0); assert.equal(f.aclConnections, 0);
  }
});

test("an exact prefix reaches the existing migration and separate ACL stage", async () => {
  const f = fixture(history.slice(0, 112));
  await assert.rejects(f.run(), (e: any) => e.outcome === "ACL_NOT_COMMITTED" && e.cause?.message === "ACL_CONNECTION_REACHED");
  assert.equal(f.ddlCalls, 1); assert.equal(f.aclConnections, 1);
});

for (const [name, rows] of [
  ["same timestamps but changed SQL", history.map((row, i) => i === 112 ? { ...row, hash: "a".repeat(64) } : row)],
  ["missing earlier migration hidden by the latest timestamp", history.filter((_, i) => i !== 73)],
  ["appended private migration", [...history, { hash: "a".repeat(64), createdAt: "1793184002000" }]],
  ["duplicate journal row", [...history.slice(0, 3), history[2]]],
  ["changed timestamp", [{ ...history[0], createdAt: "1" }]],
  ["null timestamp", [{ ...history[0], createdAt: null }]],
  ["reordered history", [history[1], history[0]]],
] as Array<[string, unknown[]]>) {
  test(`migration entry rejects ${name} before DDL or ACL`, async () => {
    const f = fixture(rows); await assert.rejects(f.run(), (e: any) => e.reason === "NOT_EXACT_PREFIX");
    assert.equal(f.ddlCalls, 0); assert.equal(f.aclConnections, 0);
  });
}

test("an unreadable presence result is not an empty database", async () => {
  const f = fixture([], null); await assert.rejects(f.prefix(), (e: any) => e.reason === "HISTORY_UNAVAILABLE");
});

test("local duplicate or decreasing timestamps are refused before querying a database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zzsh-migration-history-"));
  try {
    mkdirSync(join(dir, "meta")); writeFileSync(join(dir, "a.sql"), "SELECT 1;"); writeFileSync(join(dir, "b.sql"), "SELECT 2;");
    for (const when of [1000, 999]) {
      writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ entries: [{ tag: "a", when: 1000, breakpoints: true }, { tag: "b", when, breakpoints: true }] }));
      const f = fixture([]); await assert.rejects(f.prefix(dir), (e: any) => e.reason === "INVALID_LOCAL_CHAIN"); assert.equal(f.queries.length, 0);
    }
  } finally { rmSync(dir, { recursive: true }); }
});
