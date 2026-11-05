import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const sha = value => createHash("sha256").update(value).digest("hex"), hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const stop = () => { throw Error("LEGACY_BANK_PREPARATION_UNAVAILABLE"); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tools = ["run-local-legacy-bank.mjs", "prepare-local-legacy-bank-input.mjs", "local-legacy-bank-source.mjs", "local-legacy-bank-runner.mjs", "local-source-adapter.mjs", "verify-legacy-listed-policy-dump.mjs", "../local-auth.mjs"];

/** The local loader reads only files below the explicit working directory's .secrets. */
export function relativeBankSecretPath(workingDirectory, filePath) {
  if (typeof workingDirectory !== "string" || typeof filePath !== "string" || !isAbsolute(workingDirectory) || !isAbsolute(filePath)) stop();
  const base = resolve(workingDirectory), path = resolve(filePath), inside = relative(resolve(base, ".secrets"), path);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) stop();
  const result = relative(base, path).replaceAll("\\", "/"); if (!result.startsWith(".secrets/")) stop(); return result;
}

/** The migration CLI consumes only this task's sealed final build. */
export function assertBankNoSymlinkPath(path, stat = lstatSync) {
  if (typeof path !== "string" || !isAbsolute(path)) stop();
  for (let p = resolve(path); p !== dirname(p); p = dirname(p)) if (stat(p).isSymbolicLink()) stop();
}
export function requireFinalR06ApiDist(root, candidate, stat = lstatSync) {
  if (typeof root !== "string" || typeof candidate !== "string" || !isAbsolute(root) || !isAbsolute(candidate)) stop();
  const expected = resolve(root, "apps/api/dist-r06-v3/src");
  if (resolve(candidate).toLowerCase() !== expected.toLowerCase()) stop(); assertBankNoSymlinkPath(expected, stat); return expected;
}

/** Intermediate 0156 or an unacknowledged/mismatched final target cannot authorize a bank input. */
export function assertFinalLegacyBankSchema(proof, final, registry, stage, swap) {
  const t = proof?.target;
  if (proof?.schema !== "zzsh.round06-bank-schema-proof.v1" || proof.status !== "FINAL_SCHEMA_READBACK_ACK" || !Number.isInteger(proof.finalOrdinal) || proof.finalOrdinal < 157
    || proof.readOnlyRollbackAck !== true || proof.clientClosed !== true || !hex(proof.journalSha256) || !hex(proof.historySha256)
    || final?.schema !== "zzsh.round06-final-schema.v1" || final.status !== "FINAL_SCHEMA_VERIFIED" || final.operation !== "POST_SWAP_READ_ONLY_REVALIDATION"
    || final.actualMigrationPerformed !== false || final.finalOrdinal !== proof.finalOrdinal
    || final.journalSha256 !== proof.journalSha256 || final.historySha256 !== proof.historySha256 || final.readOnlyRollbackAck !== true || final.clientClosed !== true
    || final.unlockAck !== true || final.maintenanceClosed !== true || !hex(final.stageReceipt?.sha256) || !hex(final.swapReceipt?.sha256)
    || !t || t.round !== 6 || t.host !== "127.0.0.1" || t.port !== 55432 || t.database !== "zzsh_test_regression"
    || ![t.databaseOid, t.ownerOid, t.runtimeRoleOid].every(v => Number.isSafeInteger(v) && v > 0 && v <= 4294967295)
    || [3058841, 3179610, 3287891].includes(t.databaseOid) || !/^[a-f0-9]{24}$/.test(t.nonce ?? "")
    || !/^zzsh:[a-z0-9-]+:v1$/.test(t.marker ?? "") || !/^zzsh(?:_[a-z0-9_]+)?$/.test(t.owner ?? "") || !/^zzsh_[a-z0-9_]+$/.test(t.runtimeUser ?? "")
    || Number(final.target?.oid) !== t.databaseOid || final.target?.nonce !== t.nonce || final.target?.marker !== t.marker || final.target?.database !== t.database
    || final.target?.owner !== t.owner || Number(final.target?.ownerOid) !== t.ownerOid || final.target?.runtimeUser !== t.runtimeUser || Number(final.target?.runtimeRoleOid) !== t.runtimeRoleOid
    || stage?.status !== "FINAL_SCHEMA_0157_VERIFIED" || stage.target?.database !== "zzsh_test_round06_stage" || stage.target?.marker !== "zzsh:round06-schema-build:v1"
    || Number(stage.target?.oid) !== t.databaseOid || stage.target?.nonce !== t.nonce || stage.commitAck !== true || stage.unlockAck !== true || stage.maintenanceClosed !== true
    || !Array.isArray(stage.hashes) || stage.hashes.length < 5 || stage.hashes.some(v => !hex(v)) || !same(stage.hashes, final.stageHashes)
    || swap?.status !== "COMMIT_ACK" || Number(swap.oid) !== t.databaseOid || swap.nonce !== t.nonce || swap.schemaReceiptSha256 !== final.stageReceipt.sha256
    || swap.unlockAck !== true || swap.maintenanceClosed !== true || swap.targetIdentity?.rollbackAck !== true || swap.targetIdentity?.clientClosed !== true
    || swap.targetIdentity?.database !== t.database || Number(swap.targetIdentity?.oid) !== t.databaseOid || swap.targetIdentity?.nonce !== t.nonce
    || swap.targetIdentity?.marker !== t.marker || swap.targetIdentity?.owner !== t.owner || Number(swap.targetIdentity?.ownerOid) !== t.ownerOid
    || swap.targetIdentity?.runtimeRole !== t.runtimeUser || Number(swap.targetIdentity?.runtimeRoleOid) !== t.runtimeRoleOid
    || Number(registry?.oid) !== t.databaseOid || registry.database !== t.database || registry.marker !== t.marker || registry.nonce !== t.nonce || registry.pendingReset
    || registry.roles?.runtime?.name !== t.runtimeUser || Number(registry.roles?.runtime?.oid) !== t.runtimeRoleOid) stop();
  return t;
}

/** Testable content-only authority construction; no source rows, credentials or key bytes enter this object. */
export function makeLegacyBankAuthority(input, inputSha256, plan, planSha256, window, approvalRef) {
  if (!hex(inputSha256) || !hex(planSha256) || !input || !plan || input.schema !== "zzsh.local-legacy-bank-input.v1"
    || plan.schema !== "zzsh.local-legacy-bank-plan.v1" || plan.inputSha256 !== inputSha256 || plan.datasetSha256 !== input.dataset?.sha256
    || plan.buildSha256 !== input.buildSha256 || plan.schemaJournalSha256 !== input.schemaJournalSha256 || plan.schemaHistorySha256 !== input.schemaHistorySha256
    || !same(plan.binding?.target, input.target) || plan.binding?.source?.sourceReceiptSha256 !== input.source?.sourceReceiptSha256
    || !hex(plan.commitment) || !Number.isSafeInteger(plan.counts?.ready) || plan.counts.ready < 1
    || !window || !Number.isFinite(Date.parse(window.notBefore)) || !Number.isFinite(Date.parse(window.expiresAt))
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(window.notBefore) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(window.expiresAt)
    || Date.parse(window.notBefore) >= Date.parse(window.expiresAt) || typeof approvalRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(approvalRef)) stop();
  return { schema: "zzsh.local-legacy-bank-authority.v1", purpose: "ROUND_06_BANK_IMPORT", inputSha256, planSha256,
    binding: plan.binding, commitment: plan.commitment, buildSha256: input.buildSha256, schemaJournalSha256: input.schemaJournalSha256,
    schemaHistorySha256: input.schemaHistorySha256, maxWrites: plan.counts.ready, notBefore: window.notBefore, expiresAt: window.expiresAt, approvalRef };
}

export function collectLegacyBankBuild(apiDir) {
  const files = {};
  function walk(dir, prefix = "") {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) stop(); const name = prefix + item.name, path = join(dir, item.name);
      if (item.isDirectory()) walk(path, name + "/"); else if (item.isFile() && name.endsWith(".js")) files[name] = sha(readFileSync(path));
    }
  }
  walk(apiDir); if (!Object.keys(files).length) stop(); return files;
}

function pathUnder(value, roots, parentOnly = false) {
  if (typeof value !== "string" || !isAbsolute(value)) stop(); const path = resolve(value);
  if (!roots.some(root => { const rel = relative(root, path); return rel && !rel.startsWith("..") && !isAbsolute(rel); })) stop();
  for (let p = parentOnly ? dirname(path) : path; p !== dirname(p); p = dirname(p)) if (lstatSync(p).isSymbolicLink()) stop();
  return path;
}

function powershell(script, extraEnv = {}) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) stop(); return r.stdout.trim();
}
function currentSid() {
  const sid = powershell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
  if (!/^S-1-[0-9-]+$/.test(sid)) stop(); return sid;
}
function checkAcl(dir, sid, requireProtected = false) {
  const script = `$ErrorActionPreference='Stop'; $p=$env:ZZSH_BANK_ACL_PATH; if([System.IO.Directory]::Exists($p)) { $acl=([System.IO.DirectoryInfo]::new($p)).GetAccessControl() } else { $acl=([System.IO.FileInfo]::new($p)).GetAccessControl() };\n` +
    `$allowed=@($env:ZZSH_BANK_ACL_SID,'S-1-5-18','S-1-5-32-544');\n` +
    `if ($env:ZZSH_BANK_ACL_REQUIRE_PROTECTED -eq '1' -and -not $acl.AreAccessRulesProtected) { exit 2 };\n` +
    `$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);\n` +
    `foreach($r in $rules) { if($r.AccessControlType -eq 'Allow' -and $allowed -notcontains $r.IdentityReference.Value) { exit 3 } }; exit 0`;
  powershell(script, { ZZSH_BANK_ACL_PATH: dir, ZZSH_BANK_ACL_SID: sid, ZZSH_BANK_ACL_REQUIRE_PROTECTED: requireProtected ? "1" : "0" });
}
/** Check effective allow ACEs; newly created key/backup directories additionally require protected inheritance. */
export function assertWindowsBankAcl(path, requireProtected = false) {
  if (process.platform !== "win32") stop(); checkAcl(path, currentSid(), requireProtected);
}
function secureNewDirectory(path, restricted, sid) {
  const out = pathUnder(path, [restricted], true); if (existsSync(out)) stop();
  mkdirSync(out, { recursive: false, mode: 0o700 });
  if (process.platform !== "win32") stop();
  const acl = spawnSync("icacls.exe", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"],
    { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (acl.status !== 0) stop(); checkAcl(out, sid, true); return out;
}
function jsonFile(path, expected, roots, sid) {
  const file = pathUnder(path, roots); checkAcl(dirname(file), sid); checkAcl(file, sid);
  if (!hex(expected)) stop(); const bytes = readFileSync(file); if (sha(bytes) !== expected) stop();
  try { return JSON.parse(bytes); } catch { return stop(); }
}
function writeNew(path, value) { let fd; try { fd = openSync(path, "wx", 0o600); writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); } finally { if (fd !== undefined) closeSync(fd); } }

async function main() {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const modes = ["--input", "--authority"].filter(mode => args.includes(mode));
  if (!modes.length) { console.log(JSON.stringify({ status: "PLAN_ONLY", modes: ["--input", "--authority"], required: ["--request", "--request-sha", "--out"], dbConnections: 0, keyReads: 0, keysGenerated: 0 })); return; }
  if (modes.length !== 1 || process.platform !== "win32") stop();
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url))), restricted = resolve("E:/zzsh-local-state/restricted"), secrets = resolve("E:/zzsh/zzsh/apps/api/.secrets"), sid = currentSid();
  const request = jsonFile(option("--request"), option("--request-sha"), [restricted], sid), out = secureNewDirectory(option("--out"), restricted, sid);
  if (modes[0] === "--input") {
    if (request.schema !== "zzsh.local-legacy-bank-input-request.v1") stop();
    const registryPath = resolve(secrets, "local-postgresql/regression_test/resource.json");
    if (resolve(request.registry?.path ?? "").toLowerCase() !== registryPath.toLowerCase()) stop();
    const registry = jsonFile(registryPath, request.registry?.sha256, [secrets], sid), proof = jsonFile(request.schemaProof?.path, request.schemaProof?.sha256, [restricted], sid);
    const final = jsonFile(proof.finalReceipt?.path, proof.finalReceipt?.sha256, [restricted], sid);
    const stage = jsonFile(final.stageReceipt?.path, final.stageReceipt?.sha256, [restricted], sid), swap = jsonFile(final.swapReceipt?.path, final.swapReceipt?.sha256, [restricted], sid);
    const source = jsonFile(request.sourceProof?.path, request.sourceProof?.sha256, [restricted], sid);
    const dataset = jsonFile(request.dataset?.path, request.dataset?.sha256, [restricted], sid), keyring = jsonFile(request.keyringProof?.path, request.keyringProof?.sha256, [restricted], sid);
    const t = assertFinalLegacyBankSchema(proof, final, registry, stage, swap);
    if (source.schema !== "zzsh.r06-bank-source-validation.v1" || source.status !== "SOURCE_VERIFIED_READ_ONLY" || source.restoreMatchesDump !== true
      || source.sourceAccess !== "MYSQL_REPEATABLE_READ_READ_ONLY_ROLLBACK" || source.plaintextRowsPersisted !== false || source.postgresConnections !== 0 || source.writes !== 0
      || !hex(source.sourceReceiptSha256) || !hex(source.sourceBindingSha256)
      || dataset.sourceReceiptSha256 !== source.sourceReceiptSha256 || !Number.isSafeInteger(dataset.domains?.users?.ready)) stop();
    if (keyring.schema !== "zzsh.r06-bank-keyring-receipt.v1" || keyring.status !== "KEYRING_READY" || keyring.aclVerified !== true || keyring.backupMatches !== true
      || keyring.database !== t.database || keyring.runtimeUser !== t.runtimeUser || typeof keyring.version !== "string" || !keyring.files?.[keyring.version]) stop();
    const referencedFiles = [keyring.config, ...Object.values(keyring.files)];
    for (const ref of referencedFiles) {
      if (!hex(ref?.sha256)) stop(); const file = pathUnder(ref.path, [restricted, secrets]); checkAcl(dirname(file), sid, true); checkAcl(file, sid);
    }
    const backupDir = pathUnder(keyring.backupDirectory, [restricted, secrets]); checkAcl(backupDir, sid, true);
    const backupFile = pathUnder(keyring.backupFile, [backupDir]); checkAcl(backupFile, sid);
    if (!hex(keyring.backupSha256) || keyring.backupSha256 !== keyring.files[keyring.version].sha256) stop();
    if (!hex(request.operator?.sha256)) stop(); const actorPath = pathUnder(request.operator.path, [restricted, secrets]); checkAcl(dirname(actorPath), sid); checkAcl(actorPath, sid);
    const apiDir = requireFinalR06ApiDist(root, resolve(root, "apps/api/dist-r06-v3/src")), buildFiles = collectLegacyBankBuild(apiDir), require = createRequire(join(root, "apps/api/package.json"));
    const { canonicalize } = require(join(apiDir, "supply/content-hash.js")), buildSha256 = sha(canonicalize(buildFiles));
    const journalSha = sha(readFileSync(join(root, "apps/api/migrations/business/meta/_journal.json"))); if (journalSha !== proof.journalSha256) stop();
    const toolFiles = Object.fromEntries(tools.map(name => { const path = join(root, "scripts/migration", name); assertBankNoSymlinkPath(path); return [name, sha(readFileSync(path))]; }));
    const input = { schema: "zzsh.local-legacy-bank-input.v1", target: t, lockId: 806006,
      source: { sourceDir: request.sourceDir, sourceReceiptSha256: source.sourceReceiptSha256, sourceBinding: request.sourceBinding, sourceBindingSha256: source.sourceBindingSha256 },
      dataset: request.dataset, apiDist: apiDir, buildFiles, buildSha256, toolFiles, schemaJournalSha256: proof.journalSha256,
      schemaHistorySha256: proof.historySha256, operator: request.operator, keyring: { version: keyring.version, config: keyring.config, files: keyring.files },
      evidence: { schemaProof: request.schemaProof, finalSchemaReceipt: proof.finalReceipt, sourceProof: request.sourceProof, keyringProof: request.keyringProof } };
    writeNew(join(out, "input.json"), input);
    console.log(JSON.stringify({ status: "INPUT_READY_NOT_EXECUTED", inputSha256: sha(readFileSync(join(out, "input.json"))), buildFiles: Object.keys(buildFiles).length, dbConnections: 0, keyReads: 0, keysGenerated: 0 }));
  } else {
    if (request.schema !== "zzsh.local-legacy-bank-authority-request.v1") stop();
    const input = jsonFile(request.input?.path, request.input?.sha256, [restricted], sid), plan = jsonFile(request.plan?.path, request.plan?.sha256, [restricted], sid);
    const authority = makeLegacyBankAuthority(input, request.input.sha256, plan, request.plan.sha256, request.window, request.approvalRef);
    writeNew(join(out, "authority.json"), authority);
    console.log(JSON.stringify({ status: "AUTHORITY_READY_NOT_EXECUTED", authoritySha256: sha(readFileSync(join(out, "authority.json"))), maxWrites: authority.maxWrites, dbConnections: 0, keyReads: 0, keysGenerated: 0 }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error("LEGACY_BANK_PREPARATION_UNAVAILABLE"); process.exitCode = 1; });
