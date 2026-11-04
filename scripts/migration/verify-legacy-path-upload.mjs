import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isLegacyImagePath, legacyImageMime, legacyImageObjectKey } from "../../apps/api/src/supply/legacy-path-media.ts";

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--verify")) { console.log(JSON.stringify({ action: "PLAN", required: ["--verify", "--source-root", "--manifest", "--manifest-sha", "--batch-log", "--batch-sha", "--api-dist", "--expected-bucket", "--expected-prefix", "--out-dir"], storageWrites: 0, connections: 0 })); process.exit(0); }
if (process.platform !== "win32") throw new Error("WINDOWS_PRIVATE_ACL_REQUIRED");
const sourceRoot = option("--source-root"), manifest = option("--manifest"), batchLog = option("--batch-log"), apiDist = option("--api-dist"), outDir = option("--out-dir");
if (![sourceRoot, manifest, batchLog, apiDist, outDir].every(path => path && isAbsolute(path))) throw new Error("ABSOLUTE_PATHS_REQUIRED");
const root = realpathSync("E:/zzsh-local-state/restricted"), output = resolve(outDir);
if (!output.toLowerCase().startsWith(root.toLowerCase() + "\\")) throw new Error("PRIVATE_OUTPUT_REQUIRED");
for (const path of [resolve(sourceRoot), output]) { let current = path; for (;;) { if (lstatSync(current).isSymbolicLink()) throw new Error("REPARSE_POINT_REFUSED"); const parent = dirname(current); if (parent === current || current === parse(current).root) break; current = parent; } }
const user = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 5000 }), sid = /S-1-5-[0-9-]+/.exec(user.stdout)?.[0];
if (user.status !== 0 || !sid) throw new Error("CURRENT_SID_REQUIRED");
const verify = "$a=Get-Acl -LiteralPath $env:ZZSH_MEDIA_ACL_PATH;if(!$a.AreAccessRulesProtected){exit 2};$allowed=@($env:ZZSH_MEDIA_ACL_SID,'S-1-5-18','S-1-5-32-544');foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($s -notin $allowed){exit 3}}";
if (spawnSync("pwsh.exe", ["-NoProfile", "-Command", verify], { env: { ...process.env, ZZSH_MEDIA_ACL_PATH: output, ZZSH_MEDIA_ACL_SID: sid }, windowsHide: true, timeout: 5000 }).status !== 0) throw new Error("PRIVATE_OUTPUT_ACL_UNVERIFIED");
const target = join(output, "independent-readback.jsonl"); if (existsSync(target)) throw new Error("NEW_READBACK_REQUIRED");
const sha = bytes => createHash("sha256").update(bytes).digest("hex"), manifestBytes = await readFile(manifest), batchBytes = await readFile(batchLog);
if (sha(manifestBytes) !== option("--manifest-sha") || sha(batchBytes) !== option("--batch-sha")) throw new Error("SEALED_INPUT_CHANGED");
const records = manifestBytes.toString("utf8").split("\n").filter(Boolean).map(JSON.parse), events = batchBytes.toString("utf8").split("\n").filter(Boolean).map(JSON.parse), acknowledgements = new Map(), uploaded = new Map();
for (const e of events) { if (e.status === "PUT_ACK") { if (acknowledgements.has(e.sourcePath)) throw new Error("DUPLICATE_PUT_ACK"); acknowledgements.set(e.sourcePath, e); } else if (e.status === "UPLOADED") { if (uploaded.has(e.sourcePath)) throw new Error("DUPLICATE_UPLOAD_RECEIPT"); uploaded.set(e.sourcePath, e); } }
if (records.length !== new Set(records.map(r => r.sourcePath)).size || records.length !== uploaded.size || records.some(r => r.status !== "EXTRACTED" || !isLegacyImagePath(r.sourcePath) || !acknowledgements.has(r.sourcePath) || acknowledgements.get(r.sourcePath).receipt?.status !== 200 || uploaded.get(r.sourcePath)?.sha256 !== r.sha256)) throw new Error("UPLOAD_RECEIPT_INCOMPLETE");
const require = createRequire(import.meta.url), mediaOss = require(join(resolve(apiDist), "supply/media-oss.js")), options = mediaOss.loadOssMediaStorageOptions(process.env);
if (options.bucket !== option("--expected-bucket") || options.objectPrefix !== option("--expected-prefix")) throw new Error("OSS_TARGET_MISMATCH");
if (records.some(r => acknowledgements.get(r.sourcePath).key !== legacyImageObjectKey(options.objectPrefix, r.sourcePath) || uploaded.get(r.sourcePath).key !== legacyImageObjectKey(options.objectPrefix, r.sourcePath))) throw new Error("UPLOAD_RECEIPT_KEY_MISMATCH");
const credentials = mediaOss.loadOssCredentials(process.env), OSS = require("ali-oss"), client = new OSS({ region: options.region, bucket: options.bucket, endpoint: options.endpoint, secure: true, accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret, ...(credentials.stsToken ? { stsToken: credentials.stsToken } : {}), authorizationV4: true, timeout: 30000 });
const fd = openSync(target, "wx"), log = value => { const bytes = Buffer.from(JSON.stringify(value) + "\n"); let at = 0; while (at < bytes.length) { const n = writeSync(fd, bytes, at, bytes.length - at); if (n <= 0) throw new Error("READBACK_LOG_WRITE_FAILED"); at += n; } };
const summary = { status: "STARTED", total: records.length, checked: 0, headVerified: 0, etagVerified: 0, getVerified: 0, sampleVerified: 0, failed: 0, storageWrites: 0 }, start = performance.now();
const firstDates = new Set(), maxSize = records.reduce((max, row) => Math.max(max, row.size), 0), samples = records.map(row => { const day = row.sourcePath.split("/")[1]; const sample = row.size === maxSize || createHash("sha256").update(row.sourcePath).digest()[0] < 3 || !firstDates.has(day); firstDates.add(day); return sample; });
let next = 0, stop = false;
async function worker() {
  try {
    while (!stop && next < records.length) {
      const i = next++, item = records[i], key = legacyImageObjectKey(options.objectPrefix, item.sourcePath), file = join(sourceRoot, ...item.sourcePath.split("/").slice(1));
      let result;
      try {
        const parent = await lstat(dirname(file)), before = await lstat(file);
        if (parent.isSymbolicLink() || before.isSymbolicLink() || !before.isFile()) throw new Error("UNSAFE_SOURCE");
        const bytes = await readFile(file), after = await lstat(file);
        if (before.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.isSymbolicLink() || bytes.length !== item.size || sha(bytes) !== item.sha256 || legacyImageMime(bytes) !== item.mime) throw new Error("SOURCE_CHANGED");
        const head = await client.head(key, { headers: { "Accept-Encoding": "identity" } }), headers = head?.res?.headers ?? {}, type = String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (head.status !== 200 || Number(headers["content-length"]) !== item.size || type !== item.mime) throw new Error("HEAD_MISMATCH");
        const md5 = createHash("md5").update(bytes).digest("hex"), etag = String(headers.etag ?? "").replace(/^"|"$/g, "").toLowerCase();
        const etagVerified = !headers["x-oss-server-side-encryption"] && /^[0-9a-f]{32}$/.test(etag) && etag === md5;
        const needGet = samples[i] || !etagVerified;
        let remoteSha = null;
        if (needGet) { const actual = await client.get(key), mime = String(actual?.res?.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase(); if (!Buffer.isBuffer(actual.content) || mime !== item.mime || (remoteSha = sha(actual.content)) !== item.sha256) throw new Error("GET_MISMATCH"); }
        result = { sourcePath: item.sourcePath, key, status: "VERIFIED", headStatus: head.status, size: item.size, mime: type, etagVerified, sample: samples[i], getVerified: needGet, remoteSha256: remoteSha };
        summary.headVerified++; if (etagVerified) summary.etagVerified++; if (needGet) summary.getVerified++; if (samples[i]) summary.sampleVerified++;
      } catch { result = { sourcePath: item.sourcePath, key, status: "READBACK_FAILED" }; summary.failed++; }
      log(result); summary.checked++; if (summary.checked % 100 === 0) console.log(JSON.stringify({ event: "PROGRESS", ...summary }));
    }
  } catch (error) { stop = true; throw error; }
}
try {
  log({ event: "STARTED", manifestSha256: option("--manifest-sha"), batchSha256: option("--batch-sha"), bucket: options.bucket, prefix: options.objectPrefix, at: new Date().toISOString() });
  const settled = await Promise.allSettled(Array.from({ length: 4 }, () => worker()));
  if (settled.some(item => item.status === "rejected")) throw new Error("READBACK_WORKER_FAILED");
  summary.status = summary.failed === 0 && summary.checked === summary.total ? "PASS" : "PARTIAL";
  summary.elapsedSeconds = Math.round((performance.now() - start) / 100) / 10;
  log({ event: "FINISHED", ...summary, at: new Date().toISOString() });
} catch { summary.status = "STOPPED"; log({ event: "STOPPED", reason: "READBACK_ERROR", at: new Date().toISOString() }); }
finally { closeSync(fd); }
console.log(JSON.stringify(summary)); if (summary.status !== "PASS") process.exitCode = 1;
