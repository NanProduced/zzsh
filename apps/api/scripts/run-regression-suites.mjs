// Serial runner for the nine compiled PostgreSQL suites. Each suite starts from a freshly reset
// regression database; a failure is recorded, recovered by a reset, and stops the round unless
// --continue is given. Records code/build/resource hashes for every round.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const SUITES = [
  "database",
  "database-reset",
  "auth",
  "approval-audit",
  "admin-workspace-layout",
  "supply-m3b",
  "content-foundation",
  "order-reservation",
  "user-directory",
];
const args = process.argv.slice(2);
const rounds = Number(args.includes("--rounds") ? args[args.indexOf("--rounds") + 1] : 2);
const suites = args.includes("--suites") ? args[args.indexOf("--suites") + 1].split(",") : SUITES;
const keepGoing = args.includes("--continue");
if (Object.entries(process.env).some(([name, value]) => /_TEST_RESOURCE_SET$/.test(name) && value?.trim())) throw new Error("the shared regression runner cannot target a historical resource set");
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 2) throw new Error("--rounds must be 1 or 2");
if (!suites.length || new Set(suites).size !== suites.length || suites.some((s) => !SUITES.includes(s) && s !== "__fail__")) throw new Error("--suites must name unique registered suites");
if (suites.includes("__fail__") && suites.length !== 1) throw new Error("the failure probe must run alone");
const failures = [];
const receiptDir = process.env.REGRESSION_RECEIPT_DIR ?? resolve(process.cwd(), ".secrets/local-postgresql/regression_test");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const fileSha = (p) => sha(readFileSync(p));
const node = process.execPath;
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: "utf8", ...opts });

mkdirSync(receiptDir, { recursive: true });
const gitHead = run("git", ["-C", resolve(process.cwd(), "../.."), "rev-parse", "HEAD"]).stdout?.trim();
const buildFiles = [];
function bindBuild(directory) {
  for (const name of readdirSync(directory).sort()) {
    const file = resolve(directory, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("build input must not be a symbolic link");
    if (stat.isDirectory()) bindBuild(file);
    else if (name.endsWith(".js")) buildFiles.push({ file, sha256: fileSha(file) });
  }
}
bindBuild(resolve(process.cwd(), "dist"));
const buildHash = sha(buildFiles.map((f) => f.file + ":" + f.sha256).join("\n"));
const receipt = { startedAt: new Date().toISOString(), gitHead, buildHash, buildFiles, scope: suites.length === SUITES.length && suites.every((s, i) => s === SUITES[i]) && rounds === 2 ? "FULL_NINE_TWO_ROUND" : "TARGETED_DIAGNOSTIC", rounds: [] };

function reset(label) {
  const result = run(node, ["--env-file-if-exists=.env", "scripts/regression-reset.mjs"], { env: process.env });
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { parsed = null; }
  if (result.status !== 0 || parsed?.reset !== "READY") {
    return { ok: false, status: result.status, stderr: (result.stderr ?? "").slice(-800), parsed };
  }
  return { ok: true, ...parsed };
}

let failed = null;
for (let round = 1; round <= rounds && !failed; round += 1) {
  const roundReceipt = { round, startedAt: new Date().toISOString(), suites: [] };
  receipt.rounds.push(roundReceipt);
  for (const suite of suites) {
    const label = `round${round}:${suite}`;
    const ready = reset(label);
    if (!ready.ok) { failed = { label, stage: "reset", ...ready }; break; }
    const started = Date.now();
    const result = suite === "__fail__"
      ? run(node, ["-e", "process.exit(3)"])
      : run(node, ["--env-file-if-exists=.env", "--test", `dist/test/${suite}.test.js`], {
        env: { ...process.env, ZZSH_REGRESSION_DB_OID: ready.oid, ZZSH_REGRESSION_RUN: ready.nonce, ZZSH_TEST_RESOURCE: "" },
      });
    const entry = { suite, oid: ready.oid, nonce: ready.nonce, retiredOid: ready.retiredOid, exit: result.status, ms: Date.now() - started, tail: (result.stdout ?? "").trim().split("\n").slice(-12) };
    roundReceipt.suites.push(entry);
    process.stderr.write(`${label} exit=${result.status} ${entry.ms}ms\n`);
    if (result.status !== 0) {
      failed = { label, stage: "suite", ...entry, stderr: (result.stderr ?? "").slice(-2000) };
      failed.recovery = { state: "NOT_RESET_FAILURE_SCENE_PRESERVED", instruction: "Inspect the failed database before an explicitly requested next run" };
      failures.push(failed);
      roundReceipt.failed = failed;
      if (!keepGoing) break;
      failed = null;
    }
  }
}
receipt.finishedAt = new Date().toISOString();
if (failed && !failures.includes(failed)) failures.push(failed);
receipt.failed = failures[0] ?? failed ?? null;
receipt.failures = failures;
receipt.fullSuiteAcceptance = receipt.scope === "FULL_NINE_TWO_ROUND" && !receipt.failed && receipt.rounds.length === 2 && receipt.rounds.every((r) => r.suites.length === 9 && r.suites.every((s) => s.exit === 0));
receipt.file = resolve(receiptDir, `suite-run-${receipt.startedAt.replace(/[^0-9]/g, "").slice(0, 14)}.json`);
writeFileSync(receipt.file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ receipt: receipt.file, rounds: receipt.rounds.length, failed: receipt.failed ? receipt.failed.label : null }));
process.exitCode = receipt.failed ? 1 : 0;
