import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { readSourceRows } from "./local-source-adapter.mjs";
import { planAccountMediaReferences } from "./legacy-account-media-plan.mjs";

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes("--prepare")) throw new Error("SUPERSEDED_USE_LEGACY_PATH_MEDIA");
if (!args.includes("--prepare")) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--prepare", "--source-dir", "--receipt-sha", "--out"], targetWrites: 0, dbConnections: 0, storageWrites: 0 }));
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("WINDOWS_PRIVATE_ACL_REQUIRED");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const privateRoot = realpathSync("E:/zzsh-local-state/restricted"), source = resolve(option("--source-dir") ?? ""), out = resolve(option("--out") ?? "");
for (const path of [source, out]) {
  if (!path.toLowerCase().startsWith(privateRoot.toLowerCase() + "\\")) throw new Error("PRIVATE_PATH_REQUIRED");
  let current = existsSync(path) ? path : dirname(path);
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("REPARSE_POINT_REFUSED");
    const parent = dirname(current); if (parent === current || current === parse(current).root) break; current = parent;
  }
}
if (existsSync(out)) throw new Error("NEW_OUTPUT_REQUIRED");
const receiptBytes = readFileSync(join(source, "receipt.json"));
if (sha(receiptBytes) !== option("--receipt-sha")) throw new Error("SOURCE_RECEIPT_SHA_MISMATCH");
const captured = JSON.parse(receiptBytes), accountFile = captured.files?.accounts;
if (captured.status !== "CAPTURED_READ_ONLY" || !captured.rollbackConfirmed || !captured.clientClosed || !accountFile || accountFile.file !== basename(accountFile.file) || !/^[a-f0-9]{64}$/.test(accountFile.sha256) || !["id", "user_id", "img_paths", "punishment_img_url"].every(field => accountFile.fields.includes(field))) throw new Error("SOURCE_CAPTURE_NOT_BOUND");
const sourcePath = join(source, accountFile.file), sourceHash = createHash("sha256");
for await (const bytes of createReadStream(sourcePath)) sourceHash.update(bytes);
if (sourceHash.digest("hex") !== accountFile.sha256) throw new Error("SOURCE_FILE_SHA_MISMATCH");

const user = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
const sid = /S-1-5-[0-9-]+/.exec(user.stdout)?.[0];
if (user.status !== 0 || !sid) throw new Error("CURRENT_SID_REQUIRED");
mkdirSync(out);
const acl = spawnSync("icacls", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
if (acl.status !== 0) throw new Error("PRIVATE_OUTPUT_ACL_FAILED");
const verifyScript = "$a=Get-Acl -LiteralPath $env:ZZSH_MEDIA_ACL_PATH;if(!$a.AreAccessRulesProtected){exit 2};$allowed=@($env:ZZSH_MEDIA_ACL_SID,'S-1-5-18','S-1-5-32-544');foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($s -notin $allowed){exit 3}}";
const verified = spawnSync("pwsh.exe", ["-NoProfile", "-Command", verifyScript], { env: { ...process.env, ZZSH_MEDIA_ACL_PATH: out, ZZSH_MEDIA_ACL_SID: sid }, encoding: "utf8", windowsHide: true, timeout: 5000 });
if (verified.status !== 0) throw new Error("PRIVATE_OUTPUT_ACL_UNVERIFIED");

const output = join(out, "references.jsonl"), fd = openSync(output, "wx"), outputHash = createHash("sha256");
const quarantine = openSync(join(out, "quarantine.jsonl"), "wx"), quarantineHash = createHash("sha256");
const writeAll = (handle, bytes) => { let offset = 0; while (offset < bytes.length) { const n = writeSync(handle, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error("PRIVATE_OUTPUT_WRITE_FAILED"); offset += n; } };
const summary = { schema: "legacy-account-media-extract-v1", status: "SOURCE_REFERENCES_PLANNED_TARGET_NOT_RUN", sourceReceiptSha256: sha(receiptBytes), sourceAccountsSha256: accountFile.sha256,
  rows: 0, plannedRows: 0, quarantinedRows: 0, pendingDisplay: 0, pendingEvidence: 0, isolatedReferences: 0, acl: "CURRENT_SID_SYSTEM_ADMINISTRATORS_ONLY", dbConnections: 0, storageWrites: 0, targetWrites: 0 };
try {
  for await (const row of readSourceRows(sourcePath)) {
    summary.rows++;
    let record;
    try {
      record = planAccountMediaReferences({ sourceSnapshotSha256: accountFile.sha256, row });
    } catch (error) {
      if (error.message !== "SOURCE_IDENTITY_REQUIRED") throw error;
      const bytes = Buffer.from(JSON.stringify({ sourceRow: summary.rows, reason: "SOURCE_IDENTITY_INVALID" }) + "\n");
      writeAll(quarantine, bytes); quarantineHash.update(bytes); summary.quarantinedRows++; continue;
    }
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    writeAll(fd, bytes); outputHash.update(bytes); summary.plannedRows++;
    for (const ref of record.references) {
      if (ref.state === "ISOLATED") summary.isolatedReferences++;
      else if (ref.purpose === "ACCOUNT_DISPLAY") summary.pendingDisplay++;
      else summary.pendingEvidence++;
    }
  }
} finally { closeSync(fd); closeSync(quarantine); }
if (summary.rows !== accountFile.rows) throw new Error("SOURCE_ROW_COUNT_MISMATCH");
const sourceRecheck = createHash("sha256");
for await (const bytes of createReadStream(sourcePath)) sourceRecheck.update(bytes);
if (sourceRecheck.digest("hex") !== accountFile.sha256) throw new Error("SOURCE_CHANGED_DURING_PREPARATION");
summary.referencesSha256 = outputHash.digest("hex");
summary.quarantineSha256 = quarantineHash.digest("hex");
writeFileSync(join(out, "receipt.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(summary));
