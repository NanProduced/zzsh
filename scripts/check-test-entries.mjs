// Static inventory only: never import or execute an inventoried suite.
// Registration comes from explicit node --test files; default scope comes from
// root check:offline/check npm calls. Import reachability starts at those runners.
import { readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKSPACES = [
  { dir: "apps/api", pkgName: "@zzsh/api", testDir: "apps/api/test" },
  { dir: "apps/web", pkgName: "@zzsh/web", testDir: "apps/web/test" },
  { dir: "apps/admin", pkgName: "@zzsh/admin", testDir: "apps/admin/test" },
];

const parseSource = source => ts.createSourceFile("inventory.ts", source, ts.ScriptTarget.Latest, true);
const hasValueImport = clause => clause && !clause.isTypeOnly && (
  clause.name || ts.isNamespaceImport(clause.namedBindings ?? {}) ||
  clause.namedBindings?.elements?.some(binding => !binding.isTypeOnly)
);

// A value namespace/default may supply test(); conservatively treat it as a suite.
function executableSuite(tree) {
  return tree.statements.some(node => ts.isImportDeclaration(node) &&
    node.moduleSpecifier.text === "node:test" && hasValueImport(node.importClause) && (
      node.importClause.name || ts.isNamespaceImport(node.importClause.namedBindings ?? {}) ||
      node.importClause.namedBindings.elements.some(binding => !binding.isTypeOnly &&
        ["test", "describe", "it"].includes((binding.propertyName ?? binding.name).text))
    ));
}

export const isExecutableSuite = source => executableSuite(parseSource(source));

function unsupportedTestImport(tree) {
  let found = false;
  const visit = node => {
    if (ts.isCallExpression(node) && node.arguments[0]?.text === "node:test" &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.text === "require")) found = true;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** File-stage gates are separate annotations; they do not establish a runner. */
export function fileLevelOptIn(source) {
  const direct = source.match(/skip\s*:\s*[^,{}]*?process\.env\.([A-Z][A-Z_0-9]+)/);
  if (direct) return direct[1];
  const alias = source.match(/const\s+(\w+)\s*=\s*process\.env\.([A-Z][A-Z_0-9]+)/);
  if (alias && new RegExp(`skip\\s*:\\s*${alias[1]}\\b`).test(source)) return alias[2];
  return source.match(/if\s*\(\s*process\.env\.([A-Z][A-Z_0-9]+)\s*\)\s*\{[^}]*\btest\s*\(/)?.[1] ?? null;
}

function readPackage(root, dir) {
  const file = join(root, dir, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

// shortcut: only current literal commands and && chains are supported; report
// UNKNOWN before extending this grammar for a new runner or shell construct.
function parseScript(script) {
  const tokens = [];
  const token = /"([^"]*)"|'([^']*)'|(&&)|([^\s"'&|;<>`$()]+)/y;
  for (let offset = 0; offset < script.length;) {
    if (/\s/.test(script[offset])) { offset++; continue; }
    token.lastIndex = offset;
    const match = token.exec(script);
    if (!match) return { files: [], calls: [], switches: [], errors: ["unsupported shell syntax"] };
    tokens.push(match[3] ? null : match[1] ?? match[2] ?? match[4]);
    offset = token.lastIndex;
  }
  const commands = [[]];
  for (const item of tokens) item === null ? commands.push([]) : commands.at(-1).push(item);
  const files = [], calls = [], switches = [], errors = [];
  for (const [program, ...args] of commands) {
    if (program === "npm") {
      const name = args[0] === "run" ? args[1] : args[0] === "test" ? "test" : null;
      const options = args.slice(args[0] === "run" ? 2 : 1);
      let workspace = null, all = false, ifPresent = false, supported = Boolean(name);
      for (let i = 0; i < options.length; i++) {
        if (["-w", "--workspace"].includes(options[i])) {
          workspace = options[++i];
          if (!workspace || workspace.startsWith("-")) supported = false;
        }
        else if (options[i].startsWith("--workspace=")) workspace = options[i].slice(12);
        else if (options[i] === "--workspaces") all = true;
        else if (options[i] === "--if-present") ifPresent = true;
        else supported = false;
      }
      if (supported && !(all && workspace)) calls.push({ script: name, workspace, all, ifPresent });
      else errors.push("unsupported npm invocation");
    } else if (program === "node") {
      const testFiles = [];
      const runner = args.includes("--test");
      let supported = true;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--test") continue;
        else if (arg === "--import") { if (!args[++i]) supported = false; }
        else if (/^(--env-file-if-exists=|--test-concurrency=)/.test(arg) || arg === "--experimental-strip-types") continue;
        else if (arg === "-e") {
          const code = args[++i] ?? "";
          if (files.length || !/^require\(['"]node:assert\/strict['"]\)\.ok\(/.test(code)) supported = false;
          else for (const match of code.matchAll(/process\.env\.([A-Z][A-Z_0-9]+)/g)) switches.push(match[1]);
        } else if (/^(?:dist\/test\/|test\/|scripts\/)[\w.-]+\.(?:js|mjs|ts)$/.test(arg)) testFiles.push(arg);
        else if (!runner && /^[\w./-]+\.(?:js|mjs)$/.test(arg)) continue;
        else supported = false;
      }
      if (runner && supported && testFiles.length) files.push(...testFiles);
      else if (!supported || (runner && !testFiles.length)) errors.push("unsupported node invocation");
    } else if (!["tsc", "next", "vite", "echo"].includes(program)) {
      errors.push("unsupported command");
    }
  }
  return { files: [...new Set(files)], calls, switches: [...new Set(switches)], errors };
}

/** Only explicit runner arguments count; text inside echo/eval/wrappers does not. */
export function collectEntries(pkg) {
  return Object.entries(pkg.scripts ?? {}).flatMap(([script, command]) => {
    const parsed = parseScript(command);
    return parsed.files.length ? [{ script, ...parsed,
      pgOptIn: parsed.switches.length > 0, switch: parsed.switches[0] ?? null,
      guarded: parsed.switches.length > 0,
    }] : [];
  });
}

function walk(roots, edges) {
  const visited = new Set(), pending = [...roots];
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(edges[id] ?? []));
  }
  return visited;
}

export async function analyze({ root = defaultRoot, workspaces = WORKSPACES } = {}) {
  const packages = [{ dir: "", pkgName: "root", pkg: readPackage(root, "") },
    ...workspaces.map(ws => ({ ...ws, pkg: readPackage(root, ws.dir) }))].filter(ws => ws.pkg);
  const scripts = packages.flatMap(ws => Object.entries(ws.pkg.scripts ?? {}).map(([script, command]) => ({
    id: `${ws.pkgName}:${script}`, workspace: ws.pkgName, script, ...parseScript(command),
  })));
  const scriptEdges = {};
  for (const entry of scripts) {
    scriptEdges[entry.id] = [];
    for (const call of entry.calls) {
      const targets = call.all ? packages.filter(ws => ws.dir) :
        packages.filter(ws => ws.pkgName === (call.workspace ?? entry.workspace) || (call.workspace && ws.dir === call.workspace));
      if (!targets.length) entry.errors.push("unresolved workspace");
      for (const target of targets) {
        const id = `${target.pkgName}:${call.script}`;
        if (scripts.some(script => script.id === id)) scriptEdges[entry.id].push(id);
        else if (!call.ifPresent) entry.errors.push(`unresolved npm script ${id}`);
      }
    }
  }
  const offline = walk(scripts.some(e => e.id === "root:check:offline") ? ["root:check:offline"] : [], scriptEdges);
  const check = walk(scripts.some(e => e.id === "root:check") ? ["root:check"] : [], scriptEdges);
  const unknownScripts = scripts.filter(e => e.errors.length).map(e => ({
    workspace: e.workspace, script: e.script, status: "UNKNOWN", reasons: e.errors,
    defaultReachable: offline.has(e.id), checkReachable: check.has(e.id),
  }));
  const result = [];
  for (const ws of packages.filter(ws => ws.testDir)) {
    const entries = collectEntries(ws.pkg).map(e => ({ ...e, id: `${ws.pkgName}:${e.script}` }));
    const absolute = join(root, ws.testDir);
    const names = existsSync(absolute) ? (await readdir(absolute)).filter(n => /\.(ts|mjs)$/.test(n) && !n.endsWith(".d.ts")) : [];
    const edges = {};
    const files = names.sort().map(name => {
      const source = readFileSync(join(absolute, name), "utf8");
      const tree = parseSource(source);
      edges[name] = [];
      for (const node of tree.statements) {
        if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier || node.isTypeOnly) continue;
        if (ts.isImportDeclaration(node) && node.importClause && !hasValueImport(node.importClause)) continue;
        if (ts.isExportDeclaration(node) && node.exportClause?.elements?.every(e => e.isTypeOnly)) continue;
        const path = node.moduleSpecifier.text;
        if (!path?.startsWith("./")) continue;
        const target = path.slice(2);
        const resolved = [target, `${target}.ts`, `${target}.mjs`, target.replace(/\.js$/, ".ts")].find(n => names.includes(n));
        if (resolved) edges[name].push(resolved);
      }
      const compiled = name.replace(/\.ts$/, ".js");
      const owners = entries.filter(e => e.files.includes(`dist/test/${compiled}`) || e.files.includes(`test/${name}`));
      return { name, executable: executableSuite(tree), sourceStatus: tree.parseDiagnostics.length || unsupportedTestImport(tree) ? "UNKNOWN" : "KNOWN",
        registered: owners.length > 0, owners: owners.map(e => e.script), fileSwitch: fileLevelOptIn(source) };
    });
    const reachability = new Map(entries.map(e => [e.id, walk(files.filter(file => file.owners.includes(e.script)).map(file => file.name), edges)]));
    for (const file of files) {
      const roots = entries.filter(e => reachability.get(e.id).has(file.name));
      file.reachable = roots.length > 0;
      file.reachedFrom = roots.map(e => e.id);
      file.defaultReachable = roots.some(e => offline.has(e.id));
      file.checkReachable = roots.some(e => check.has(e.id));
      file.pgOptIn = roots.length > 0 && roots.every(e => e.pgOptIn);
      file.switches = [...new Set(roots.flatMap(e => e.switches))];
    }
    result.push({ dir: ws.dir, pkgName: ws.pkgName, entries, files, edges });
  }
  return { root, workspaces: result, unknownScripts, roots: { offline: [...offline], check: [...check] } };
}

export function classify(analysis) {
  const rows = [];
  for (const ws of analysis.workspaces) for (const file of ws.files) {
    const importedBy = Object.entries(ws.edges).filter(([, tos]) => tos.includes(file.name)).map(([from]) => from);
    let category;
    if (file.sourceStatus === "UNKNOWN") category = "UNKNOWN";
    else if (!file.executable) category = file.reachable ? "helper" : importedBy.length ? "helper-unreachable" : "helper-unreferenced";
    else if (!file.reachable) category = "unregistered";
    else if (file.defaultReachable) category = file.fileSwitch ? "default-file-optin" : "default";
    else if (file.checkReachable) category = file.fileSwitch ? "check-only-file-optin" : "check-only";
    else if (file.pgOptIn) category = "pg-opt-in";
    else category = file.fileSwitch ? "manual-file-optin" : "manual";
    rows.push({ workspace: ws.pkgName, file: file.name, category, entries: file.owners,
      registered: file.registered, reachable: file.reachable, reachedFrom: file.reachedFrom,
      defaultReachable: file.defaultReachable, checkReachable: file.checkReachable,
      switch: file.switches[0] ?? file.fileSwitch, fileSwitch: file.fileSwitch, scriptSwitches: file.switches, importedBy });
  }
  return rows;
}

export const findUnregistered = rows => rows.filter(row => row.category === "unregistered");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const analysis = await analyze();
  const rows = classify(analysis);
  const unregistered = findUnregistered(rows);
  const unknown = rows.filter(row => row.category === "UNKNOWN");
  const unknownReachable = analysis.unknownScripts.filter(row => row.defaultReachable || row.checkReachable);
  console.log(JSON.stringify({
    schema: "wave4-L-test-entry-classification-v2", atUtc: new Date().toISOString(), node: process.version,
    counts: rows.reduce((sum, row) => (sum[row.category] = (sum[row.category] ?? 0) + 1, sum), {}),
    roots: analysis.roots, unknownScripts: analysis.unknownScripts,
    unregistered: unregistered.map(row => `${row.workspace}:${row.file}`), unknown,
  }, null, 2));
  if (unregistered.length || unknown.length || unknownReachable.length || !analysis.roots.offline.length) {
    console.error("FAIL: unregistered suites or UNKNOWN source/default/check entry coverage.");
    process.exitCode = 1;
  } else console.log("OK: every executable suite is reachable from an explicit runner; default/check scopes are traced.");
}
