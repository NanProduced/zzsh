// Offline test-entry self-check (P-V2 item 1).
//
// Purpose: make the default/offline vs explicit-PG vs helper vs excluded split visible
// without running any suite, and fail when an executable suite is not registered.
//
// Rules this tool enforces (each has a counter-example in assert-offline-env.test.mjs):
//   1. An executable suite = a file that imports node:test's test/describe/it as a VALUE.
//      Detection is static: the file is never imported, so a missing registration is
//      still visible, and no inventoried suite has to run for the check to work.
//   2. A registered entry = the compiled file name appears in some package script.
//   3. A helper = no value import of node:test; it is reachable only through a suite
//      that imports it. Helpers are not orphans.
//   4. The 5 order PG helpers are helpers: they are imported by a registered suite
//      (order-reservation), so they must not be reported as unregistered suites.
//   5. A PG entry is opt-in: its script requires a named environment switch. The
//      switch is read from the script, never from the environment at check time.
//
// Exit code 0 = no unregistered executable suite. Exit code 1 = one or more found.

import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const selfDir = dirname(fileURLToPath(import.meta.url));
export const defaultRoot = resolve(selfDir, "..");

// Static only: a value import of the test/describe/it bindings from node:test.
const VALUE_IMPORT = /import\s*(?:\{([^}]*)\}|(\w+))\s*from\s*["']node:test["']/g;
const TEST_BINDING = /(^|[\s,{])(test|describe|it)([\s,}]|$)/;

export const WORKSPACES = [
  { dir: "apps/api", pkgName: "@zzsh/api", testDir: "apps/api/test" },
  { dir: "apps/web", pkgName: "@zzsh/web", testDir: "apps/web/test" },
  { dir: "apps/admin", pkgName: "@zzsh/admin", testDir: "apps/admin/test" },
];

/** A file is an executable suite when it imports node:test's runner bindings by value. */
export function isExecutableSuite(source) {
  VALUE_IMPORT.lastIndex = 0;
  let match;
  while ((match = VALUE_IMPORT.exec(source)) !== null) {
    const named = match[1];
    if (named === undefined) return true; // default import: import test from "node:test"
    if (TEST_BINDING.test(named)) return true;
  }
  return false;
}

/** The environment switch a PG entry requires, read from the script text. */
export function optInSwitch(script) {
  const match = script.match(/process\.env\.([A-Z][A-Z_0-9]+)/);
  return match ? match[1] : null;
}

/**
 * A switch a suite reads to decide whether its own PG stage runs. A suite that
 * self-skips its PG stage still runs in the default entry, so this is reported
 * separately from a script-level opt-in.
 */
export function fileLevelOptIn(source) {
  // { skip: process.env.X ... } or { skip: !process.env.X }
  const direct = source.match(/skip\s*:\s*[^,{}]*?process\.env\.([A-Z][A-Z_0-9]+)/);
  if (direct) return direct[1];
  // const ENABLED = process.env.X  ...  { skip: ENABLED ? false : ... }
  const alias = source.match(/const\s+(\w+)\s*=\s*process\.env\.([A-Z][A-Z_0-9]+)/);
  if (alias && new RegExp(`skip\\s*:\\s*${alias[1]}\\b`).test(source)) return alias[2];
  // if (process.env.X) { test(...) }
  const guarded = source.match(/if\s*\(\s*process\.env\.([A-Z][A-Z_0-9]+)\s*\)\s*\{[^}]*\btest\s*\(/);
  if (guarded) return guarded[1];
  return null;
}

function readPackage(root, dir) {
  const file = join(root, dir, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Every script entry, with the files it runs and whether it is a PG opt-in. */
export function collectEntries(pkg) {
  const entries = [];
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    const files = [];
    for (const match of script.matchAll(/(?:dist\/test\/|test\/)([\w.-]+\.(?:js|mjs))/g)) {
      if (!files.includes(match[1])) files.push(match[1]);
    }
    if (files.length === 0) continue;
    const switchName = optInSwitch(script);
    entries.push({
      script: name,
      files,
      pgOptIn: switchName !== null,
      switch: switchName,
      // A script that asserts its switch before doing anything is a real gate.
      guarded: /node --env-file-if-exists=\.env -e/.test(script) && switchName !== null,
    });
  }
  return entries;
}

function importEdges(root, testDir, names) {
  const edges = new Map();
  for (const name of names) {
    const source = readFileSync(join(root, testDir, name), "utf8");
    const imported = new Set();
    for (const match of source.matchAll(/from\s*["']\.\/([\w.-]+)["']/g)) {
      const target = match[1];
      for (const candidate of [target, `${target}.ts`, `${target}.js`]) {
        if (names.includes(candidate)) imported.add(candidate);
      }
    }
    edges.set(name, imported);
  }
  return edges;
}

export async function analyze({ root = defaultRoot, workspaces = WORKSPACES } = {}) {
  const result = [];
  for (const { dir, pkgName, testDir } of workspaces) {
    const pkg = readPackage(root, dir);
    if (!pkg) continue;
    const entries = collectEntries(pkg);
    const registered = new Set(entries.flatMap(e => e.files));
    const absolute = join(root, testDir);
    const names = existsSync(absolute)
      ? (await readdir(absolute)).filter(n => /\.(ts|mjs)$/.test(n) && !n.endsWith(".d.ts"))
      : [];
    const files = names.map(name => {
      const source = readFileSync(join(absolute, name), "utf8");
      const compiled = name.replace(/\.ts$/, ".js");
      const owners = entries.filter(e => e.files.includes(compiled) || e.files.includes(name));
      return {
        name,
        compiled,
        source,
        executable: isExecutableSuite(source),
        registered: owners.length > 0,
        owners: owners.map(o => o.script),
        pgOptIn: owners.length > 0 && owners.every(o => o.pgOptIn),
        switch: owners.length > 0 ? owners.map(o => o.switch).find(Boolean) ?? null : null,
        fileSwitch: fileLevelOptIn(source),
      };
    });
    files.sort((a, b) => a.name.localeCompare(b.name));
    const edges = Object.fromEntries([...importEdges(root, testDir, names)]);
    result.push({ dir, pkgName, entries, files, edges });
  }
  return { root, workspaces: result };
}

/**
 * Classify every file into one of:
 *   default              - runs with the offline entry
 *   default-file-optin   - runs with the offline entry, but its own PG stage is
 *                          gated by a switch the suite reads itself
 *   pg-opt-in            - only reachable through a script that requires a switch
 *   helper               - no runner bindings; reached through an importing suite
 *   helper-unreferenced  - no runner bindings and no importer (dead support module)
 *   unregistered         - has runner bindings, no script runs it, nothing imports it
 */
export function classify(analysis) {
  const rows = [];
  for (const ws of analysis.workspaces) {
    const importedBy = new Map();
    for (const [from, tos] of Object.entries(ws.edges)) {
      for (const to of tos) {
        if (!importedBy.has(to)) importedBy.set(to, []);
        importedBy.get(to).push(from);
      }
    }
    for (const file of ws.files) {
      const importers = importedBy.get(file.name) ?? [];
      let category;
      if (!file.executable) {
        category = importers.length > 0 ? "helper" : "helper-unreferenced";
      } else if (file.registered && file.pgOptIn) {
        category = "pg-opt-in";
      } else if (file.registered && file.fileSwitch) {
        category = "default-file-optin";
      } else if (file.registered) {
        category = "default";
      } else if (importers.length > 0) {
        category = "helper-imported-by-suite";
      } else {
        category = "unregistered";
      }
      rows.push({
        workspace: ws.pkgName,
        file: file.name,
        category,
        entries: file.owners,
        switch: file.switch ?? file.fileSwitch,
        importedBy: importers,
      });
    }
  }
  return rows;
}

export function findUnregistered(rows) {
  return rows.filter(r => r.category === "unregistered");
}

// --- CLI ---------------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const analysis = await analyze();
  const rows = classify(analysis);
  const unregistered = findUnregistered(rows);
  const tally = rows.reduce((acc, r) => ((acc[r.category] = (acc[r.category] ?? 0) + 1), acc), {});
  const report = {
    schema: "wave4-L-test-entry-classification-v1",
    atUtc: new Date().toISOString(),
    node: process.version,
    counts: tally,
    entries: analysis.workspaces.map(w => ({
      workspace: w.pkgName,
      scripts: w.entries.map(e => ({
        script: e.script,
        files: e.files.length,
        pgOptIn: e.pgOptIn,
        switch: e.switch,
        guarded: e.guarded,
      })),
    })),
    unregistered: unregistered.map(u => `${u.workspace}:${u.file}`),
    helperUnreferenced: rows.filter(r => r.category === "helper-unreferenced").map(r => `${r.workspace}:${r.file}`),
  };
  console.log(JSON.stringify(report, null, 2));
  if (unregistered.length > 0) {
    console.error(`FAIL: ${unregistered.length} executable suite(s) are not registered in any package script.`);
    process.exit(1);
  }
  console.log("OK: every executable suite is registered.");
}
