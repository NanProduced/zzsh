import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { prepareBusinessInitial, readBusinessInitialRegistry, resolveBusinessInitialSelection, type BusinessInitialManifest } from "../src/database/business-initial";
import { runBusinessMigrations } from "../src/database/business-migrations";
const sha = (input: string) => createHash("sha256").update(input).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zzsh-initial-test-"));
  const canonical = join(root, "canonical"), initial = join(root, "initial");
  mkdirSync(join(canonical, "meta"), { recursive: true }); mkdirSync(initial);
  const entries = ["0000_a", "0001_b", "0002_future"].map((tag, index) => ({ idx: index, tag, when: 100 + index, breakpoints: true, version: "7" }));
  for (const entry of entries) writeFileSync(join(canonical, entry.tag + ".sql"), `SELECT ${entry.idx};`);
  writeFileSync(join(canonical, "meta/_journal.json"), JSON.stringify({ entries }));
  const parts = ["01-schema.sql", "02-seed.sql", "03-guard.sql", "04-acl.sql"].map((file, index) => {
    const sql = `SELECT ${index + 10};`; writeFileSync(join(initial, file), sql); return { file, sha256: sha(sql) };
  });
  const manifest: BusinessInitialManifest = {
    format: "zzsh.business-initial.v1", baseline: "test", migrationTag: "0001_initial_test", when: 101, sourceCount: 2,
    migrationHash: sha(parts.map(part => readFileSync(join(initial, part.file), "utf8")).join("\n--> statement-breakpoint\n")),
    sourceChain: entries.slice(0, 2).map(entry => ({ tag: entry.tag, when: entry.when, sha256: sha(readFileSync(join(canonical, entry.tag + ".sql"), "utf8")) })), parts,
  };
  const seal = () => writeFileSync(join(initial, "manifest.json"), JSON.stringify(manifest)); seal();
  return { root, canonical, initial, manifest, seal, cleanup: () => rmSync(root, { recursive: true }) };
}

test("initial registry keeps an older installed hash while a separately sealed Chinese version becomes the new default", () => {
  const root = mkdtempSync(join(tmpdir(), "zzsh-initial-registry-"));
  try {
    for (const [name, value] of [["release_old", "a"], ["release_m1_zh_v1", "b"]]) {
      mkdirSync(join(root, name!));
      writeFileSync(join(root, name!, "manifest.json"), JSON.stringify({ format: "zzsh.business-initial.v1", baseline: name, migrationHash: value!.repeat(64) }));
    }
    writeFileSync(join(root, "registry.json"), JSON.stringify({ format: "zzsh.business-initial-registry.v1", active: "release_m1_zh_v1", supported: ["release_old", "release_m1_zh_v1"] }));
    const registry = readBusinessInitialRegistry(root);
    assert.equal(registry.active, "release_m1_zh_v1");
    assert.equal(registry.supported.find(entry => entry.manifest.migrationHash === "a".repeat(64))!.name, "release_old");
  } finally { rmSync(root, { recursive: true }); }
});

for (const [name, registry] of [
  ["path traversal", { active: "../outside", supported: ["../outside"] }],
  ["duplicate supported baseline", { active: "release_old", supported: ["release_old", "release_old"] }],
  ["unregistered default", { active: "release_missing", supported: ["release_old"] }],
] as const) test(`initial registry rejects ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), "zzsh-initial-registry-negative-"));
  try { writeFileSync(join(root, "registry.json"), JSON.stringify({ format: "zzsh.business-initial-registry.v1", ...registry })); assert.throws(() => readBusinessInitialRegistry(root), /BUSINESS_INITIAL_MANIFEST_INVALID/); }
  finally { rmSync(root, { recursive: true }); }
});
test("an installed baseline stays on its own hash when a newer baseline is active", () => {
  const registry = { active: "release_0151", supported: [
    { name: "release_0141", manifest: { migrationHash: "a" } },
    { name: "release_0151", manifest: { migrationHash: "b" } },
  ] };
  const installed = resolveBusinessInitialSelection(registry, { initialInstall: false, installedHash: "a" });
  const fresh = resolveBusinessInitialSelection(registry, { initialInstall: true });
  const explicitOld = resolveBusinessInitialSelection(registry, { initialInstall: true, requestedBaseline: "release_0141" });
  assert.equal(installed.kind, "installed");
  assert.equal(fresh.kind, "selected");
  assert.equal(explicitOld.kind, "selected");
  if (installed.kind === "installed") assert.equal(installed.name, "release_0141");
  if (fresh.kind === "selected") assert.equal(fresh.name, "release_0151");
  if (explicitOld.kind === "selected") assert.equal(explicitOld.name, "release_0141");
  assert.equal(resolveBusinessInitialSelection(registry, { initialInstall: true, requestedBaseline: "release_missing" }).kind, "missing");
  assert.equal(resolveBusinessInitialSelection(registry, { initialInstall: true, requestedBaseline: "release_0151", installedHash: "a" }).kind, "conflict");
  assert.equal(resolveBusinessInitialSelection(registry, { initialInstall: false }).kind, "canonical");
  assert.equal(resolveBusinessInitialSelection(registry, { initialInstall: true, installedHash: "canonical-hash" }).kind, "not-baseline");
});

test("initial refuses an occupied unregistered schema before DDL or ACL", async () => {
  const queries: string[] = [];
  const pool = { query: async (sql: string) => { queries.push(sql); return { rows: sql.includes('to_regclass') ? [{ present: false }] : [{ count: 1 }] }; },
    connect: async () => { throw new Error('DDL_OR_ACL_REACHED'); } };
  await assert.rejects(runBusinessMigrations(pool as any, { runtimeUser: 'runtime', initialInstall: true }), /BUSINESS_INITIAL_REQUIRES_EMPTY_DATABASE/);
  assert.equal(queries.length, 2);
});
test("initial baseline is one distinct journal entry followed by unchanged future canonical SQL", () => {
  const f = fixture(); try {
    const prepared = prepareBusinessInitial(f.canonical, f.initial); try {
      const migrations = readMigrationFiles({ migrationsFolder: prepared.folder });
      assert.equal(migrations.length, 2); assert.equal(migrations[0]!.hash, f.manifest.migrationHash);
      assert.equal(migrations[1]!.hash, sha("SELECT 2;"));
      const journal = JSON.parse(readFileSync(join(prepared.folder, "meta/_journal.json"), "utf8"));
      assert.deepEqual(journal.entries.map((entry: any) => entry.tag), ["0001_initial_test", "0002_future"]);
      assert.equal(readFileSync(join(f.canonical, "0000_a.sql"), "utf8"), "SELECT 0;");
    } finally { const directory = prepared.folder; prepared.cleanup(); assert.equal(existsSync(directory), false); }
  } finally { f.cleanup(); }
});
for (const [name, mutate] of [
  ["changed canonical SQL", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.canonical, "0000_a.sql"), "SELECT 9;")],
  ["changed seed SQL", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.initial, "02-seed.sql"), "SELECT 99;")],
  ["changed combined baseline hash", (f: ReturnType<typeof fixture>) => { f.manifest.migrationHash = "0".repeat(64); f.seal(); }],
  ["fake source checkpoint", (f: ReturnType<typeof fixture>) => { f.manifest.when = 999; f.seal(); }],
  ["path traversal", (f: ReturnType<typeof fixture>) => { f.manifest.parts[0]!.file = "../outside.sql"; f.seal(); }],
  ["duplicate parts", (f: ReturnType<typeof fixture>) => { f.manifest.parts[1] = f.manifest.parts[0]!; f.seal(); }],
  ["missing source entry", (f: ReturnType<typeof fixture>) => { f.manifest.sourceChain.pop(); f.seal(); }],
  ["changed journal bytes at the frozen checkpoint", (f: ReturnType<typeof fixture>) => { const file = join(f.canonical, "meta/_journal.json"); const journal = JSON.parse(readFileSync(file, "utf8")); journal.entries = journal.entries.slice(0, 2); writeFileSync(file, JSON.stringify(journal)); (f.manifest as BusinessInitialManifest & { journalSha256: string }).journalSha256 = "f".repeat(64); f.seal(); }],
  ["changed navigation document", (f: ReturnType<typeof fixture>) => { writeFileSync(join(f.initial, "NAVIGATION.md"), "changed\n"); (f.manifest as BusinessInitialManifest & { documents: { file: string; sha256: string }[] }).documents = [{ file: "NAVIGATION.md", sha256: "1".repeat(64) }]; f.seal(); }],
] as const) {
  test(`initial rejects ${name} before preparing migration SQL`, () => {
    const f = fixture(); try { mutate(f); assert.throws(() => prepareBusinessInitial(f.canonical, f.initial), /BUSINESS_INITIAL_MANIFEST_INVALID/); } finally { f.cleanup(); }
  });
}

test("a sealed full journal admits a later canonical tail without rewriting the baseline", () => {
  const f = fixture(); try {
    const file = join(f.canonical, "meta/_journal.json"), full = readFileSync(file, "utf8"), journal = JSON.parse(full);
    journal.entries = journal.entries.slice(0, 2); writeFileSync(file, JSON.stringify(journal));
    (f.manifest as BusinessInitialManifest & { journalSha256: string }).journalSha256 = sha(readFileSync(file, "utf8")); f.seal();
    (f.manifest as BusinessInitialManifest & { journalPrefixSha256: string }).journalPrefixSha256 = sha(JSON.stringify(journal.entries)); f.seal();
    const atCheckpoint = prepareBusinessInitial(f.canonical, f.initial); atCheckpoint.cleanup();
    writeFileSync(file, full);
    const upgraded = prepareBusinessInitial(f.canonical, f.initial); try {
      const migrations = readMigrationFiles({ migrationsFolder: upgraded.folder });
      assert.equal(migrations.length, 2); assert.equal(migrations[0]!.hash, f.manifest.migrationHash);
      assert.equal(migrations[1]!.hash, sha("SELECT 2;"));
    } finally { upgraded.cleanup(); }
    const altered = JSON.parse(full); altered.entries[0].breakpoints = false; writeFileSync(file, JSON.stringify(altered));
    assert.throws(() => prepareBusinessInitial(f.canonical, f.initial), /BUSINESS_INITIAL_MANIFEST_INVALID/);
  } finally { f.cleanup(); }
});
