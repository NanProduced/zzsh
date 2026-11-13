import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, openSync, closeSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readBoundSourceRows, sourceJsonLine } from "./local-source-adapter.mjs";
import { prepareLocalStoredOpening, capturedOpeningUser, assertOpeningUserSource, verifyPreparedOpeningUsers } from "./local-opening-proof.mjs";

const args = process.argv.slice(2);
const required = ["--dataset", "--dataset-sha", "--funds-source", "--funds-source-sha", "--api-dist", "--out"];
if (!args.includes("--prepare")) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--prepare", ...required], dbConnections: 0, targetWrites: 0 }));
  process.exit(0);
}
assert.equal(process.version, "v24.20.0", "NODE_BASELINE_MISMATCH");
const options = Object.fromEntries(required.map(key => {
  const i = args.indexOf(key), value = args[i + 1];
  assert(i >= 0 && value && !value.startsWith("--"), "MISSING_OPENING_INPUT:" + key);
  return [key, value];
}));
const started = performance.now(), sha = bytes => createHash("sha256").update(bytes).digest("hex");
const restricted = resolve("E:/zzsh-local-state/restricted");
const privatePath = value => {
  const path = resolve(value);
  assert(path.toLowerCase().startsWith(restricted.toLowerCase() + "\\"), "PRIVATE_OPENING_PATH_REQUIRED");
  for (let parent = path; parent !== dirname(parent); parent = dirname(parent))
    if (existsSync(parent)) assert(!lstatSync(parent).isSymbolicLink(), "OPENING_REPARSE_POINT_REFUSED");
  return path;
};
const dataset = privatePath(options["--dataset"]), supplement = privatePath(options["--funds-source"]), out = privatePath(options["--out"]);
assert(!existsSync(out), "NEW_OPENING_OUTPUT_REQUIRED");
const bound = (dir, file, expected) => {
  const bytes = readFileSync(join(dir, file));
  assert.equal(sha(bytes), expected, "OPENING_INPUT_SHA_MISMATCH:" + file);
  return JSON.parse(bytes);
};
const datasetSha256 = options["--dataset-sha"], supplementReceiptSha256 = options["--funds-source-sha"];
const m = bound(dataset, "manifest.json", datasetSha256), source = privatePath(m.source);
const base = bound(source, "receipt.json", m.sourceReceiptSha256), funds = bound(supplement, "receipt.json", supplementReceiptSha256);
assert.equal(m.status, "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN");
for (const r of [base, funds]) assert(r.status === "CAPTURED_READ_ONLY" && r.rollbackConfirmed && r.clientClosed);
assert.equal(funds.sourceSupplement?.baseReceiptSha256, m.sourceReceiptSha256);
assert.equal(funds.containerId, base.containerId);
assert.equal(funds.database, base.database);
assert.equal(funds.sourceSupplement.fullSourcePopulation, true);
async function* checkedRows(dir, meta) {
  assert(meta.file === basename(meta.file), "OPENING_INPUT_FILENAME_INVALID");
  yield* readBoundSourceRows(privatePath(join(dir, meta.file)), meta);
}
const apiDist = resolve(options["--api-dist"]), require = createRequire(import.meta.url), mod = n => require(join(apiDist, n + ".js"));
const canonical = mod("supply/content-hash").canonicalize, cutoff = new Date(m.sourceCutoff).toISOString();
const openingModules = { preparation: mod("finance/legacy-finance-source-preparation"), proof: mod("finance/legacy-finance-source-evidence"), canonical,
  legacyOwnerUserId: mod("supply/legacy-user-migration").legacyOwnerUserId, financeRead: mod("finance/personal-finance-read") };
const capturedUsers = new Map(), plannedUsers = new Map();
for await (const raw of checkedRows(source, base.files.users)) {
  const user = capturedOpeningUser(raw, openingModules);
  assert(!capturedUsers.has(user.sourceId), "OPENING_CAPTURED_USER_DUPLICATE"); capturedUsers.set(user.sourceId, user);
}
for await (const user of checkedRows(dataset, m.files.users)) {
  assert(typeof user.sourceId === "string" && !plannedUsers.has(user.sourceId), "OPENING_PLANNED_USER_DUPLICATE");
  plannedUsers.set(user.sourceId, { sourceId: user.sourceId, userId: user.userId, sourceDigest: user.sourceDigest });
}
const maps = { logs: new Map(), orders: new Map(), withdraws: new Map(), distributions: new Map() };
for (const [dir, file, map] of [
  [supplement, funds.files.earnings, maps.logs], [source, base.files.orders, maps.orders],
  [supplement, funds.files.withdraws, maps.withdraws], [source, base.files.distributionOrders, maps.distributions],
]) {
  for await (const row of checkedRows(dir, file)) {
    if (map === maps.logs) {
      if (!map.has(row.user_id)) map.set(row.user_id, []);
      map.get(row.user_id).push(row);
    } else {
      assert(!map.has(row.id), "DUPLICATE_OPENING_SOURCE_ID");
      map.set(row.id, row);
    }
  }
}
const inputSha256 = sha(canonical({ datasetSha256, sourceReceiptSha256: m.sourceReceiptSha256, supplementReceiptSha256, cutoff }));
const ctx = { modules: openingModules, ...maps, cutoff, inputSha256, sourceExtractSha256: funds.files.earnings.sha256 };
const sid = /S-1-5-[0-9-]+/.exec(spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout)?.[0];
assert(sid, "OPENING_OUTPUT_SID_REQUIRED");
mkdirSync(out);
assert.equal(spawnSync("icacls", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true }).status, 0, "OPENING_OUTPUT_ACL_FAILED");
const file = "openings.jsonl", fd = openSync(join(out, file), "wx"), hash = createHash("sha256");
const stats = { subjects: 0, candidate: 0, reviewRequired: 0, positiveSource: 0, candidatePositive: 0, reasons: {} };
let sourceAvailableCents = 0n, candidateAvailableCents = 0n, reviewAvailableCents = 0n;
const seenBalances = new Set();
try {
  for await (const balance of checkedRows(dataset, m.files["stored-balances"])) {
    assert(!seenBalances.has(balance.sourceId), "OPENING_SOURCE_BALANCE_DUPLICATE"); seenBalances.add(balance.sourceId);
    assertOpeningUserSource(balance, capturedUsers.get(balance.sourceId), plannedUsers.get(balance.sourceId), openingModules);
    const amount = BigInt(balance.amounts.earnings), row = prepareLocalStoredOpening(balance, ctx);
    stats.subjects++;
    sourceAvailableCents += amount;
    if (amount > 0n) stats.positiveSource++;
    if (row.state === "CANDIDATE") {
      assert.equal(row.input.proof.availableCents, balance.amounts.earnings);
      stats.candidate++;
      if (amount > 0n) stats.candidatePositive++;
      candidateAvailableCents += amount;
    } else {
      stats.reviewRequired++;
      reviewAvailableCents += amount;
      stats.reasons[row.reason] = (stats.reasons[row.reason] ?? 0) + 1;
    }
    const bytes = Buffer.from(sourceJsonLine(row)); writeSync(fd, bytes); hash.update(bytes);
  }
} finally { closeSync(fd); }
assert.equal(stats.subjects, m.domains.users.ready);
assert.equal(sourceAvailableCents.toString(), m.storedBalanceTotals.mappedEarningsCents);
assert.equal(candidateAvailableCents + reviewAvailableCents, sourceAvailableCents);
Object.assign(stats, { sourceAvailableCents: String(sourceAvailableCents), candidateAvailableCents: String(candidateAvailableCents), reviewAvailableCents: String(reviewAvailableCents) });
const fileSha256 = hash.digest("hex");
const sourceUsers = await verifyPreparedOpeningUsers({ balances: checkedRows(dataset, m.files["stored-balances"]),
  openings: checkedRows(out, { file, sha256: fileSha256, rows: stats.subjects }), capturedUsers, plannedUsers, modules: openingModules, inputSha256, cutoff });
assert(sourceUsers.subjects === stats.subjects && sourceUsers.candidate === stats.candidate && sourceUsers.reviewRequired === stats.reviewRequired
  && sourceUsers.candidateAvailableCents === stats.candidateAvailableCents, "OPENING_SOURCE_RECONCILIATION_CHANGED");
const report = { status: "REVIEWED_CANDIDATES_TARGET_NOT_RUN", datasetSha256, sourceCutoff: cutoff, file, sha256: fileSha256, stats, wallMs: performance.now() - started, sourceInputSha256: inputSha256, proofRule: "ORIGINAL_STORED_BALANCE_NEVER_FLOW_SUM", sourceUsers: { ...sourceUsers, sha256: base.files.users.sha256, matched: sourceUsers.subjects }, targetWrites: 0 };
const manifest = JSON.stringify(report, null, 2) + "\n";
writeFileSync(join(out, "manifest.json"), manifest, { flag: "wx" });
console.log(JSON.stringify({ ...report, manifestSha256: sha(manifest) }));
