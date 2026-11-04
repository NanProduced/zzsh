import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, writeSync, existsSync, realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isLegacyImagePath } from "../../apps/api/src/supply/legacy-path-media.ts";
import { assertNoOverwriteSupport, uploadLegacyManifestBatch } from "./legacy-path-media-upload.mjs";

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--upload")) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--upload", "--source-root", "--manifest", "--manifest-sha", "--dates", "--api-dist", "--expected-bucket", "--expected-prefix", "--log-dir"], storageWrites: 0, connections: 0 }));
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("WINDOWS_PRIVATE_ACL_REQUIRED");
const sourceRoot = option("--source-root"), apiDist = option("--api-dist"), logDir = option("--log-dir"), manifestPath = option("--manifest");
if (![sourceRoot, apiDist, logDir, manifestPath].every(path => path && isAbsolute(path))) throw new Error("ABSOLUTE_PATHS_REQUIRED");
const privateRoot = realpathSync("E:/zzsh-local-state/restricted"), logPath = resolve(logDir);
if (!logPath.toLowerCase().startsWith(privateRoot.toLowerCase() + "\\") || existsSync(logPath)) throw new Error("NEW_PRIVATE_LOG_DIRECTORY_REQUIRED");
for (const path of [resolve(sourceRoot), dirname(logPath)]) {
  let current = path;
  for (;;) { if (lstatSync(current).isSymbolicLink()) throw new Error("REPARSE_POINT_REFUSED"); const parent = dirname(current); if (parent === current || current === parse(current).root) break; current = parent; }
}
if (!lstatSync(sourceRoot).isDirectory()) throw new Error("SOURCE_DIRECTORY_REQUIRED");
const manifestBytes = await readFile(manifestPath), manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
if (manifestSha !== option("--manifest-sha")) throw new Error("MANIFEST_SHA_MISMATCH");
const dates = (option("--dates") ?? "").split(",");
if (!dates.length || dates.some(date => !/^\d{8}$/.test(date)) || new Set(dates).size !== dates.length) throw new Error("EXACT_DATES_REQUIRED");
const records = manifestBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)), seenPaths = new Set();
for (const record of records) {
  if (!isLegacyImagePath(record.sourcePath) || !dates.includes(record.sourcePath.split("/")[1]) || seenPaths.has(record.sourcePath) || !Number.isSafeInteger(record.size) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "") || !["EXTRACTED", "EXCLUDED_INVALID_IMAGE"].includes(record.status)) throw new Error("MANIFEST_RECORD_INVALID");
  seenPaths.add(record.sourcePath);
}
const require = createRequire(import.meta.url), mediaOss = require(join(resolve(apiDist), "supply/media-oss.js"));
const options = mediaOss.loadOssMediaStorageOptions(process.env);
if (options.bucket !== option("--expected-bucket") || options.objectPrefix !== option("--expected-prefix")) throw new Error("OSS_TARGET_MISMATCH");
const credentials = mediaOss.loadOssCredentials(process.env), OSS = require("ali-oss");
const client = new OSS({ region: options.region, bucket: options.bucket, endpoint: options.endpoint, secure: true, accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret, ...(credentials.stsToken ? { stsToken: credentials.stsToken } : {}), authorizationV4: true, timeout: 30000 });

const user = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
const sid = /S-1-5-[0-9-]+/.exec(user.stdout)?.[0];
if (user.status !== 0 || !sid) throw new Error("CURRENT_SID_REQUIRED");
mkdirSync(logPath);
const acl = spawnSync("icacls", [logPath, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
if (acl.status !== 0) throw new Error("PRIVATE_LOG_ACL_FAILED");
const verifyScript = "$a=Get-Acl -LiteralPath $env:ZZSH_MEDIA_ACL_PATH;if(!$a.AreAccessRulesProtected){exit 2};$allowed=@($env:ZZSH_MEDIA_ACL_SID,'S-1-5-18','S-1-5-32-544');foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($s -notin $allowed){exit 3}}";
const verified = spawnSync("pwsh.exe", ["-NoProfile", "-Command", verifyScript], { env: { ...process.env, ZZSH_MEDIA_ACL_PATH: logPath, ZZSH_MEDIA_ACL_SID: sid }, encoding: "utf8", windowsHide: true, timeout: 5000 });
if (verified.status !== 0) throw new Error("PRIVATE_LOG_ACL_UNVERIFIED");
const fd = openSync(join(logPath, "batch.jsonl"), "wx");
const log = value => { const bytes = Buffer.from(JSON.stringify(value) + "\n"); let at = 0; while (at < bytes.length) { const n = writeSync(fd, bytes, at, bytes.length - at); if (n <= 0) throw new Error("BATCH_LOG_WRITE_FAILED"); at += n; } };
let summary = { status: "STARTED", total: records.length };
try {
  log({ event: "STARTED", bucket: options.bucket, prefix: options.objectPrefix, manifestSha256: manifestSha, dates, concurrency: 4, at: new Date().toISOString() });
  await assertNoOverwriteSupport(client, options.bucket);
  summary = await uploadLegacyManifestBatch({ records, client, prefix: options.objectPrefix, log,
    onProgress: value => console.log(JSON.stringify({ event: "PROGRESS", ...value })),
    readBytes: async record => {
      const file = join(sourceRoot, ...record.sourcePath.split("/").slice(1));
      const parent = await lstat(dirname(file)), before = await lstat(file);
      if (parent.isSymbolicLink() || before.isSymbolicLink() || !before.isFile()) throw new Error("UNSAFE_FILE");
      const bytes = await readFile(file), after = await lstat(file);
      if (before.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.isSymbolicLink()) throw new Error("SOURCE_CHANGED");
      return bytes;
    } });
  log({ event: "FINISHED", ...summary, at: new Date().toISOString() });
} catch {
  summary.status = "STOPPED";
  log({ event: "STOPPED", reason: "PRECHECK_OR_BATCH_ERROR", at: new Date().toISOString() });
} finally { closeSync(fd); }
console.log(JSON.stringify(summary));
if (summary.status !== "COMPLETE") process.exitCode = 1;
