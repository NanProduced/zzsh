import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { readBoundSourceRows } from "./local-source-adapter.mjs";
import { parseLegacyImagePaths } from "../../apps/api/src/supply/legacy-path-media.ts";

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--prepare")) { console.log(JSON.stringify({ action: "PLAN", required: ["--prepare", "--dataset-dir", "--dataset-sha", "--source-plan-dir", "--source-plan-receipt-sha", "--out"], dbConnections: 0, targetWrites: 0 })); process.exit(0); }
if (process.platform !== "win32") throw new Error("WINDOWS_PRIVATE_ACL_REQUIRED");
const dataset = option("--dataset-dir"), source = option("--source-plan-dir"), out = option("--out");
if (![dataset, source, out].every(path => path && isAbsolute(path))) throw new Error("ABSOLUTE_PATHS_REQUIRED");
const root = realpathSync("E:/zzsh-local-state/restricted");
for (const path of [dataset, source, out]) {
  if (!resolve(path).toLowerCase().startsWith(root.toLowerCase() + "\\")) throw new Error("PRIVATE_PATH_REQUIRED");
  let p = existsSync(path) ? resolve(path) : dirname(resolve(path));
  for (;;) { if (lstatSync(p).isSymbolicLink()) throw new Error("REPARSE_POINT_REFUSED"); const parent = dirname(p); if (parent === p || p === parse(p).root) break; p = parent; }
}
if (existsSync(out)) throw new Error("NEW_OUTPUT_REQUIRED");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const bound = (path, expected) => { const bytes = readFileSync(path); if (sha(bytes) !== expected) throw new Error("INPUT_SHA_MISMATCH"); return JSON.parse(bytes); };
const datasetManifest = bound(join(dataset, "manifest.json"), option("--dataset-sha"));
const sourceReceipt = bound(join(source, "receipt.json"), option("--source-plan-receipt-sha"));
if (datasetManifest.status !== "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN" || sourceReceipt.status !== "SOURCE_REFERENCES_PLANNED_TARGET_NOT_RUN" || datasetManifest.sourceReceiptSha256 !== sourceReceipt.sourceReceiptSha256) throw new Error("SOURCE_BINDING_MISMATCH");
async function checkFile(path, expected) { const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); if (hash.digest("hex") !== expected) throw new Error("SOURCE_FILE_SHA_MISMATCH"); }
const accountsFile = join(dataset, "accounts.jsonl"), sourceFile = join(source, "references.jsonl");
await checkFile(sourceFile, sourceReceipt.referencesSha256);
const accounts = new Map();
for await (const row of readBoundSourceRows(accountsFile, datasetManifest.files.accounts)) {
  if (!row.ready || typeof row.sourceId !== "string" || accounts.has(row.sourceId) || !/^[a-f0-9]{64}$/.test(row.sourceDigest ?? "") || typeof row.ownerUserId !== "string") throw new Error("ACCOUNT_PLAN_INVALID");
  accounts.set(row.sourceId, row);
}
if (accounts.size !== datasetManifest.files.accounts.rows) throw new Error("ACCOUNT_PLAN_COUNT_MISMATCH");
const user = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 5000 }), sid = /S-1-5-[0-9-]+/.exec(user.stdout)?.[0];
if (user.status !== 0 || !sid) throw new Error("CURRENT_SID_REQUIRED");
mkdirSync(out);
if (spawnSync("icacls", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true, timeout: 5000 }).status !== 0) throw new Error("PRIVATE_OUTPUT_ACL_FAILED");
const verify = "$a=Get-Acl -LiteralPath $env:ZZSH_MEDIA_ACL_PATH;if(!$a.AreAccessRulesProtected){exit 2};$allowed=@($env:ZZSH_MEDIA_ACL_SID,'S-1-5-18','S-1-5-32-544');foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($s -notin $allowed){exit 3}}";
if (spawnSync("pwsh.exe", ["-NoProfile", "-Command", verify], { env: { ...process.env, ZZSH_MEDIA_ACL_PATH: resolve(out), ZZSH_MEDIA_ACL_SID: sid }, windowsHide: true, timeout: 5000 }).status !== 0) throw new Error("PRIVATE_OUTPUT_ACL_UNVERIFIED");
const fd = openSync(join(out, "account-paths.jsonl"), "wx"), outputHash = createHash("sha256");
const counts = { accounts: 0, displayPaths: 0, penaltyPaths: 0 }, seen = new Set();
try {
  for await (const row of readBoundSourceRows(sourceFile, { sha256: sourceReceipt.referencesSha256, rows: sourceReceipt.plannedRows })) {
    const account = accounts.get(row.legacyAccountId); if (!account) continue;
    if (seen.has(row.legacyAccountId) || row.sourceSnapshotSha256 !== sourceReceipt.sourceAccountsSha256 || row.legacyOwnerId !== account.ownerLegacyId || !["PRESENT", "EMPTY", "NULL"].includes(row.fields?.img_paths?.observation) || !["PRESENT", "EMPTY", "NULL"].includes(row.fields?.punishment_img_url?.observation)) throw new Error("SOURCE_ACCOUNT_MISMATCH");
    const displayPaths = parseLegacyImagePaths(row.fields.img_paths.raw), penaltyPaths = parseLegacyImagePaths(row.fields.punishment_img_url.raw);
    if (JSON.stringify(displayPaths) !== JSON.stringify(row.references.filter(x => x.field === "img_paths").map(x => x.sourceToken)) || JSON.stringify(penaltyPaths) !== JSON.stringify(row.references.filter(x => x.field === "punishment_img_url").map(x => x.sourceToken))) throw new Error("SOURCE_PATH_ORDER_MISMATCH");
    const record = { legacyId: row.legacyAccountId, legacyOwnerId: row.legacyOwnerId, ownerUserId: account.ownerUserId, sourceDigest: account.sourceDigest, displayPaths, penaltyPaths };
    const bytes = Buffer.from(JSON.stringify(record) + "\n"); let at = 0; while (at < bytes.length) { const n = writeSync(fd, bytes, at, bytes.length - at); if (n <= 0) throw new Error("OUTPUT_WRITE_FAILED"); at += n; } outputHash.update(bytes);
    seen.add(row.legacyAccountId); counts.accounts++; counts.displayPaths += displayPaths.length; counts.penaltyPaths += penaltyPaths.length;
  }
} finally { closeSync(fd); }
if (seen.size !== accounts.size) throw new Error("SOURCE_ACCOUNT_CLOSURE_MISMATCH");
await checkFile(accountsFile, datasetManifest.files.accounts.sha256);
const receipt = { schema: "legacy-account-path-plan-v1", status: "PREPARED_TARGET_NOT_RUN", datasetSha256: option("--dataset-sha"), sourcePlanReceiptSha256: option("--source-plan-receipt-sha"), file: "account-paths.jsonl", fileSha256: outputHash.digest("hex"), ...counts, dbConnections: 0, targetWrites: 0, storageWrites: 0 };
writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(receipt));
