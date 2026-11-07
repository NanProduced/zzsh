import { createHash } from "node:crypto";
import { createReadStream, readFileSync, mkdirSync, existsSync, openSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertSourceSupplementFields, readSourceRows as rows, sourceJsonLine } from "./local-source-adapter.mjs";

const args = process.argv.slice(2), option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
if (!args.includes("--prepare")) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--prepare", "--dataset", "--dataset-sha", "--supplement", "--supplement-sha", "--out"], connections: 0, credentialReads: 0, targetWrites: 0 }));
  process.exit(0);
}
const started = performance.now();
if (process.version !== "v24.20.0") throw new Error("NODE_BASELINE_MISMATCH");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), require = createRequire(import.meta.url);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const dataset = resolve(option("--dataset") ?? ""), supplement = resolve(option("--supplement") ?? ""), out = resolve(option("--out") ?? "");
for (const path of [dataset, supplement, out]) if (!path.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\")) throw new Error("PRIVATE_LOCAL_PATH_REQUIRED");
if (existsSync(out)) throw new Error("NEW_DERIVED_OUTPUT_REQUIRED");
const boundJson = (path, expected) => { const bytes = readFileSync(path); if (hash(bytes) !== expected) throw new Error("INPUT_SHA_MISMATCH"); return JSON.parse(bytes); };
const manifest = boundJson(join(dataset, "manifest.json"), option("--dataset-sha"));
const captured = boundJson(join(supplement, "receipt.json"), option("--supplement-sha"));
const base = boundJson(join(manifest.source, "receipt.json"), manifest.sourceReceiptSha256);
if (!["FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN", "SOURCE_CLOSED_PENDING_ROOT_REVIEW_AND_FRESH_TARGET_CAS"].includes(manifest.status) || captured.status !== "CAPTURED_READ_ONLY" || !captured.rollbackConfirmed || !captured.clientClosed || captured.containerId !== base.containerId || captured.database !== base.database || !captured.files.accountDisplay) throw new Error("SOURCE_SUPPLEMENT_NOT_BOUND");
async function checkedFile(dir, entry) { if (!entry || entry.file !== basename(entry.file)) throw new Error("SOURCE_FILE_PATH_INVALID"); const path = join(dir, entry.file), digest = createHash("sha256"); for await (const bytes of createReadStream(path)) digest.update(bytes); if (digest.digest("hex") !== entry.sha256) throw new Error("SOURCE_FILE_SHA_MISMATCH"); return path; }
const basePath = await checkedFile(manifest.source, base.files.accounts), displayPath = await checkedFile(supplement, captured.files.accountDisplay), accountPath = await checkedFile(dataset, manifest.files.accounts);
const raw = new Map(); for await (const row of rows(basePath)) { if (raw.has(row.id)) throw new Error("DUPLICATE_BASE_SOURCE_ID"); raw.set(row.id, row); }
const sameExtract = base.files.accounts.sha256 === captured.files.accountDisplay.sha256;
const displays = sameExtract ? raw : new Map(); let compared = sameExtract ? raw.size : 0;
if (!sameExtract) {
  for await (const row of rows(displayPath)) {
    const original = raw.get(row.id); if (!original || displays.has(row.id)) throw new Error("SUPPLEMENT_SOURCE_ID_SET_CHANGED");
    assertSourceSupplementFields(original, row);
    compared++; displays.set(row.id, row);
  }
}
if (compared !== raw.size || raw.size !== base.files.accounts.rows || compared !== captured.files.accountDisplay.rows) throw new Error("SUPPLEMENT_SOURCE_DENOMINATOR_CHANGED");
const display = require(join(resolve(option("--api-dist") ?? join(root, "apps/api/dist/src")), "supply/legacy-display-snapshot.js"));
const sid = /S-1-5-[0-9-]+/.exec(spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout)?.[0];
if (!sid) throw new Error("SID_REQUIRED");
mkdirSync(out); if (spawnSync("icacls", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true }).status !== 0) throw new Error("OUTPUT_ACL_FAILED");
const output = join(out, "display.jsonl"), fd = openSync(output, "wx"), digest = createHash("sha256");
const result = { schema: "zzsh.local-display-supplement.v1", datasetSha256: option("--dataset-sha"), supplementSha256: option("--supplement-sha"), extractSha256: captured.files.accountDisplay.sha256, sourceRowsCompared: compared, commonFieldDifferences: 0, rows: 0, notDisplayable: 0, issueCounts: {}, accountBaseRatio: { scope: "ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT", known: 0, unknown: 0 }, accountFullPayout: { scope: "ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT", selected: 0, unselected: 0, unknown: 0 }, targetWrites: 0, connections: 0, file: "display.jsonl" };
try {
  for await (const account of rows(accountPath)) {
    if (!account.snapshot || !account.sourceUpdatedAt || ![0, 3, 4, 5, 6].includes(Number(account.sourceStatus)) || account.sourceDeleted) { result.notDisplayable++; continue; }
    const snapshot = display.parseLegacyDisplaySnapshot(display.convertLegacyDisplayFields(displays.get(account.sourceId), { includeAccountBaseRatio: true, includeAccountFullPayout: true }));
    result.accountBaseRatio[snapshot.sourceAccountBaseRatioWanPerYuan === null ? "unknown" : "known"]++;
    result.accountFullPayout[snapshot.sourceAccountFullPayoutSelected === null ? "unknown" : snapshot.sourceAccountFullPayoutSelected ? "selected" : "unselected"]++;
    for (const issue of snapshot.issues) result.issueCounts[issue] = (result.issueCounts[issue] ?? 0) + 1;
    const bytes = Buffer.from(sourceJsonLine({ sourceId: account.sourceId, baseSourceDigest: account.sourceDigest, sourceUpdatedAt: account.sourceUpdatedAt, snapshot }));
    writeSync(fd, bytes); digest.update(bytes); result.rows++;
  }
} finally { closeSync(fd); }
result.sha256 = digest.digest("hex"); result.status = "DISPLAY_SUPPLEMENT_PREPARED_TARGET_NOT_RUN";
result.wallMs = performance.now() - started;
result.identicalExtractParsedOnce = sameExtract;
writeFileSync(join(out, "manifest.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(result));
