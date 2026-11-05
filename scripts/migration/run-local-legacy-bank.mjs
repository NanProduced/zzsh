import { createHash } from "node:crypto";
import { existsSync, lstatSync, openSync, closeSync, fsyncSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivate } from "../local-auth.mjs";
import { assertBankNoSymlinkPath, assertFinalLegacyBankSchema, assertWindowsBankAcl, relativeBankSecretPath, requireFinalR06ApiDist } from "./prepare-local-legacy-bank-input.mjs";
import { bankCleanupPassed, describeLocalLegacyBankRun, executeLocalLegacyBankRun, prepareLocalLegacyBankRun, readbackLocalLegacyBankRun, recordBankCleanup, releaseLocalLegacyBankRun } from "./local-legacy-bank-runner.mjs";

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const modes = ["--prepare", "--execute", "--readback"].filter(mode => args.includes(mode));
if (!modes.length) {
  console.log(JSON.stringify({ status: "PLAN_ONLY", modes: ["--prepare", "--execute", "--readback"], required: ["--input", "--input-sha", "--out"],
    nonPrepare: ["--plan", "--plan-sha"], execute: ["--authority", "--authority-sha"], connections: 0, credentialReads: 0, writes: 0 }));
  process.exit(0);
}
const fail = () => { throw Error("LEGACY_BANK_COMMAND_FAILED"); };
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value), sha = value => createHash("sha256").update(value).digest("hex");
const root = resolve(fileURLToPath(new URL("../..", import.meta.url))), restricted = resolve("E:/zzsh-local-state/restricted"), secretRoot = resolve("E:/zzsh/zzsh/apps/api/.secrets");
let failureOut, reservedAttempt = false;
function protectedPath(value, output = false, roots = [restricted]) {
  if (typeof value !== "string" || !isAbsolute(value)) fail();
  const path = resolve(value);
  if (!roots.some(base => { const rel = relative(base, path); return rel && !rel.startsWith("..") && !isAbsolute(rel); })) fail();
  for (let p = output ? dirname(path) : path; p !== dirname(p); p = dirname(p)) if (lstatSync(p).isSymbolicLink()) fail();
  return path;
}
function pinned(file, expected) {
  if (!hex(expected)) fail(); const bytes = readFileSync(file); if (sha(bytes) !== expected) fail();
  try { return JSON.parse(bytes); } catch { return fail(); }
}
function jsFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) fail(); const name = prefix + entry.name;
    return entry.isDirectory() ? jsFiles(join(dir, entry.name), name + "/") : entry.isFile() && name.endsWith(".js") ? [name] : [];
  });
}

async function main() {
  if (modes.length !== 1 || process.version !== "v24.20.0") fail();
  const mode = modes[0], inputSha256 = option("--input-sha"), input = pinned(protectedPath(option("--input")), inputSha256);
  if (input.schema !== "zzsh.local-legacy-bank-input.v1" || input.target?.round !== 6 || input.lockId !== 806006
    || input.target.database !== "zzsh_test_regression" || !hex(input.buildSha256) || !hex(input.schemaJournalSha256)
    || !hex(input.schemaHistorySha256) || !input.buildFiles || !input.toolFiles) fail();
  const out = protectedPath(option("--out"), true); if (existsSync(out)) fail(); failureOut = out;
  const output = (name, value) => writePrivate(join(out, name), value);
  const dataset = pinned(protectedPath(input.dataset?.path), input.dataset?.sha256);
  if (dataset.sourceReceiptSha256 !== input.source?.sourceReceiptSha256 || !Number.isSafeInteger(dataset.domains?.users?.ready)) fail();
  const actorPath = protectedPath(input.operator?.path, false, [restricted, secretRoot]);
  assertWindowsBankAcl(dirname(actorPath)); assertWindowsBankAcl(actorPath);
  const actor = pinned(actorPath, input.operator?.sha256);
  const operator = { userId: actor.id ?? actor.actorId ?? actor.userId, sessionId: actor.sessionId };
  if (actor.realm !== "admin" || !operator.userId || !operator.sessionId) fail();

  const registryDir = resolve(secretRoot, "local-postgresql/regression_test"), registry = JSON.parse(readFileSync(join(registryDir, "resource.json"))),
    credentials = JSON.parse(readFileSync(join(registryDir, "credentials.json"))), t = input.target;
  if (registry.database !== t.database || Number(registry.oid) !== t.databaseOid || registry.nonce !== t.nonce || registry.marker !== t.marker
    || registry.pendingReset || credentials.database !== t.database || credentials.runtime?.name !== t.runtimeUser
    || Number(credentials.runtime?.oid) !== t.runtimeRoleOid || credentials.runtime?.name !== registry.roles?.runtime?.name
    || String(credentials.runtime?.oid) !== String(registry.roles?.runtime?.oid) || credentials.migration?.name !== "zzsh_regression_migration"
    || credentials.migration?.name !== registry.roles?.migration?.name || String(credentials.migration?.oid) !== String(registry.roles?.migration?.oid)) fail();
  const apiDir = requireFinalR06ApiDist(root, input.apiDist);
  const require = createRequire(join(root, "apps/api/package.json"));
  function verifyFiles() {
    requireFinalR06ApiDist(root, apiDir);
    if (!Object.keys(input.buildFiles).length || JSON.stringify(jsFiles(apiDir).sort()) !== JSON.stringify(Object.keys(input.buildFiles).sort())) fail();
    for (const [name, digest] of Object.entries(input.buildFiles)) {
      if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || !name.endsWith(".js") || !hex(digest) || sha(readFileSync(join(apiDir, name))) !== digest) fail();
    }
    const tools = ["run-local-legacy-bank.mjs", "prepare-local-legacy-bank-input.mjs", "local-legacy-bank-source.mjs", "local-legacy-bank-runner.mjs", "local-source-adapter.mjs", "verify-legacy-listed-policy-dump.mjs", "../local-auth.mjs"];
    if (JSON.stringify(Object.keys(input.toolFiles).sort()) !== JSON.stringify(tools.sort())) fail();
    for (const name of tools) { const path = join(root, "scripts/migration", name); assertBankNoSymlinkPath(path); if (!hex(input.toolFiles[name]) || sha(readFileSync(path)) !== input.toolFiles[name]) fail(); }
    if (sha(readFileSync(join(root, "apps/api/migrations/business/meta/_journal.json"))) !== input.schemaJournalSha256) fail();
  }
  verifyFiles();
  const mod = name => { if (!Object.hasOwn(input.buildFiles, name + ".js")) fail(); return require(join(apiDir, name + ".js")); };
  const { canonicalize } = mod("supply/content-hash");
  if (sha(canonicalize(input.buildFiles)) !== input.buildSha256) fail();
  const verifyBuild = async expected => { if (expected !== input.buildSha256) fail(); verifyFiles(); };
  const api = mod("finance/legacy-withdrawal-bank-import"), { loadWithdrawalBankBindingRuntime } = mod("finance/withdrawal-bank-binding-runtime");

  const schemaProof = pinned(protectedPath(input.evidence?.schemaProof?.path), input.evidence?.schemaProof?.sha256);
  const final = pinned(protectedPath(input.evidence?.finalSchemaReceipt?.path), input.evidence?.finalSchemaReceipt?.sha256);
  const stage = pinned(protectedPath(final.stageReceipt?.path), final.stageReceipt?.sha256);
  const swap = pinned(protectedPath(final.swapReceipt?.path), final.swapReceipt?.sha256);
  const sourceProof = pinned(protectedPath(input.evidence?.sourceProof?.path), input.evidence?.sourceProof?.sha256);
  const keyringProof = pinned(protectedPath(input.evidence?.keyringProof?.path), input.evidence?.keyringProof?.sha256);
  assertFinalLegacyBankSchema(schemaProof, final, registry, stage, swap);
  if (schemaProof.journalSha256 !== input.schemaJournalSha256 || schemaProof.historySha256 !== input.schemaHistorySha256
    || canonicalize(schemaProof.target) !== canonicalize(t) || canonicalize(schemaProof.finalReceipt) !== canonicalize(input.evidence.finalSchemaReceipt)) fail();
  if (sourceProof.schema !== "zzsh.r06-bank-source-validation.v1" || sourceProof.status !== "SOURCE_VERIFIED_READ_ONLY" || sourceProof.restoreMatchesDump !== true
    || sourceProof.sourceAccess !== "MYSQL_REPEATABLE_READ_READ_ONLY_ROLLBACK" || sourceProof.plaintextRowsPersisted !== false || sourceProof.postgresConnections !== 0 || sourceProof.writes !== 0
    || sourceProof.sourceReceiptSha256 !== input.source?.sourceReceiptSha256
    || sourceProof.sourceBindingSha256 !== input.source?.sourceBindingSha256) fail();
  if (keyringProof.schema !== "zzsh.r06-bank-keyring-receipt.v1" || keyringProof.status !== "KEYRING_READY" || keyringProof.aclVerified !== true || keyringProof.backupMatches !== true
    || keyringProof.database !== t.database || keyringProof.runtimeUser !== t.runtimeUser || keyringProof.version !== input.keyring?.version
    || canonicalize(keyringProof.config) !== canonicalize(input.keyring?.config) || canonicalize(keyringProof.files) !== canonicalize(input.keyring?.files)) fail();
  const backupDir = protectedPath(keyringProof.backupDirectory, false, [restricted, secretRoot]), backupFile = protectedPath(keyringProof.backupFile, false, [backupDir]);
  assertWindowsBankAcl(backupDir, true); assertWindowsBankAcl(backupFile);
  if (!hex(keyringProof.backupSha256) || keyringProof.backupSha256 !== input.keyring.files[input.keyring.version]?.sha256
    || sha(readFileSync(backupFile)) !== keyringProof.backupSha256) fail();
  const configPath = protectedPath(input.keyring?.config?.path, false, [restricted, secretRoot]);
  assertWindowsBankAcl(dirname(configPath), true); assertWindowsBankAcl(configPath);
  const config = pinned(configPath, input.keyring?.config?.sha256);
  if (config.database !== t.database || config.runtimeUser !== t.runtimeUser || config.writeEnabled !== true || !config.keyVariables
    || !Object.hasOwn(config.keyVariables, input.keyring?.version) || !input.keyring?.files) fail();
  const secretWorkingDirectory = "E:/zzsh/zzsh/apps/api";
  const env = { ...process.env, WITHDRAWAL_BANK_BINDING_ENABLED: "true", WITHDRAWAL_BANK_BINDING_CONFIG_FILE: relativeBankSecretPath(secretWorkingDirectory, configPath) };
  delete env.WITHDRAWAL_BANK_BINDING_CONFIG;
  for (const [version, variable] of Object.entries(config.keyVariables)) {
    if (typeof variable !== "string" || !/^WITHDRAWAL_BANK_KEY_[A-Z0-9_]{1,64}$/.test(variable)) fail();
    const ref = input.keyring.files[version], path = protectedPath(ref?.path, false, [restricted, secretRoot]);
    assertWindowsBankAcl(dirname(path), true); assertWindowsBankAcl(path);
    if (!hex(ref?.sha256) || sha(readFileSync(path)) !== ref.sha256) fail();
    delete env[variable]; env[`${variable}_FILE`] = relativeBankSecretPath(secretWorkingDirectory, path);
  }
  const configContext = { authEnabled: true, database: { name: t.database, user: t.runtimeUser, runtimeUser: t.runtimeUser } };
  const bankRuntime = loadWithdrawalBankBindingRuntime(configContext, env, secretWorkingDirectory);
  if (!bankRuntime?.protection) fail();
  const options = { ...bankRuntime, protection: { currentKeyVersion: input.keyring.version, keyFor: bankRuntime.protection.keyFor } };
  const { Client, Pool } = require("pg"), base = { host: "127.0.0.1", port: 55432, database: t.database,
    statement_timeout: 30000, lock_timeout: 1000, connectionTimeoutMillis: 3000, application_name: "zzsh-r06-legacy-bank" };
  const writePool = new Pool({ ...base, user: credentials.runtime.name, password: credentials.runtime.password, max: 1 });
  const readPool = new Pool({ ...base, user: credentials.runtime.name, password: credentials.runtime.password, max: 1 });
  const schemaPool = new Pool({ ...base, user: credentials.migration.name, password: credentials.migration.password, max: 1 });
  const maintenanceChecks = [], schemaChecks = []; let poolClosures;
  async function closePools() {
    if (!poolClosures) {
      const values = await Promise.allSettled([writePool.end(), readPool.end(), schemaPool.end()]);
      poolClosures = { writePoolClosed: values[0].status === "fulfilled", readPoolClosed: values[1].status === "fulfilled", schemaPoolClosed: values[2].status === "fulfilled" };
    }
    return poolClosures;
  }
  const cleanupPassed = pools => bankCleanupPassed(maintenanceChecks, schemaChecks, pools);
  async function assertSchema() {
    const check = { runtimeRollbackAck: false, migrationRollbackAck: false };
    const c = await readPool.connect(); let begun = false, destroy = false;
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
      const identity = (await c.query(`SELECT d.oid::text oid,current_database() name,current_user role,r.oid::text role_oid,
        pg_get_userbyid(d.datdba) owner,d.datdba::text owner_oid,shobj_description(d.oid,'pg_database') marker,
        current_setting('zzsh.regression_run',true) nonce,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls
        FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
      if (!identity || Number(identity.oid) !== t.databaseOid || identity.name !== t.database || identity.role !== t.runtimeUser
        || Number(identity.role_oid) !== t.runtimeRoleOid || identity.owner !== t.owner || Number(identity.owner_oid) !== t.ownerOid
        || identity.marker !== t.marker || identity.nonce !== t.nonce || identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolbypassrls) fail();
      check.runtimeRollbackAck = (await c.query("ROLLBACK"))?.command === "ROLLBACK"; if (!check.runtimeRollbackAck) fail(); begun = false;
    } finally { try { if (begun) await c.query("ROLLBACK"); } catch { destroy = true; } finally { c.release(destroy ? true : undefined); } }
    const migration = await schemaPool.connect(); begun = false; destroy = false;
    try {
      await migration.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
      const identity = (await migration.query(`SELECT d.oid::text oid,current_database() name,current_user role,r.oid::text role_oid,
        pg_get_userbyid(d.datdba) owner,d.datdba::text owner_oid,shobj_description(d.oid,'pg_database') marker,
        current_setting('zzsh.regression_run',true) nonce FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
      if (!identity || Number(identity.oid) !== t.databaseOid || identity.name !== t.database || identity.role !== credentials.migration.name
        || identity.role_oid !== String(credentials.migration.oid) || identity.owner !== t.owner || Number(identity.owner_oid) !== t.ownerOid
        || identity.marker !== t.marker || identity.nonce !== t.nonce) fail();
      const history = (await migration.query('SELECT hash,created_at::text AS "createdAt" FROM zzsh_business_meta.migrations ORDER BY id')).rows;
      if (sha(canonicalize(history)) !== input.schemaHistorySha256) fail();
      check.migrationRollbackAck = (await migration.query("ROLLBACK"))?.command === "ROLLBACK"; if (!check.migrationRollbackAck) fail(); begun = false;
    } finally { try { if (begun) await migration.query("ROLLBACK"); } catch { destroy = true; } finally { migration.release(destroy ? true : undefined); } }
    schemaChecks.push(check);
  }
  async function withMaintenanceLock(fn) {
    const lock = new Client({ ...base, database: "postgres", user: credentials.migration.name, password: credentials.migration.password });
    let locked = false; const check = { acquired: false, unlockAck: false, maintenanceClosed: false };
    try {
      await lock.connect();
      const role = (await lock.query("SELECT current_user AS role,oid::text AS oid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
      if (!role || role.role !== credentials.migration.name || role.oid !== String(credentials.migration.oid) || role.rolsuper || role.rolcreaterole || role.rolbypassrls) fail();
      locked = (await lock.query("SELECT pg_try_advisory_lock($1) AS ok", [input.lockId])).rows[0]?.ok === true; check.acquired = locked; if (!locked) fail();
      await assertSchema(); await fn();
    } finally {
      try { if (locked) check.unlockAck = (await lock.query("SELECT pg_advisory_unlock($1) AS ok", [input.lockId])).rows[0]?.ok === true; } catch { /* outcome stays unknown */ }
      try { await lock.end(); check.maintenanceClosed = true; } catch { /* outcome stays unknown */ }
      maintenanceChecks.push(check); if (locked && (!check.unlockAck || !check.maintenanceClosed)) fail();
    }
  }
  let token;
  try {
    await withMaintenanceLock(async () => { await verifyBuild(input.buildSha256); });
    token = await prepareLocalLegacyBankRun({ sourceInput: input.source, selectionInput: input.dataset, canonicalize, target: t, operator, options, api });
    const plan = describeLocalLegacyBankRun(token);
    if (mode === "--prepare") {
      const pools = await closePools(); if (!cleanupPassed(pools)) fail();
      output("plan.json", { ...plan, inputSha256, datasetSha256: input.dataset.sha256, buildSha256: input.buildSha256,
        schemaJournalSha256: input.schemaJournalSha256, schemaHistorySha256: input.schemaHistorySha256 });
      const planSha256 = sha(readFileSync(join(out, "plan.json")));
      output("receipt.json", { status: "PREPARED_READ_ONLY", planSha256, counts: plan.counts, stages: plan.stages,
        maintenanceChecks, schemaChecks, ...pools, plaintextSourceRowsPersisted: false });
      console.log(JSON.stringify({ status: "PREPARED_READ_ONLY", planSha256, counts: plan.counts, durationMs: plan.durationMs }));
      return;
    }
    const prior = pinned(protectedPath(option("--plan")), option("--plan-sha"));
    if (prior.schema !== plan.schema || prior.inputSha256 !== inputSha256 || prior.datasetSha256 !== input.dataset.sha256
      || prior.buildSha256 !== input.buildSha256 || prior.schemaJournalSha256 !== input.schemaJournalSha256 || prior.schemaHistorySha256 !== input.schemaHistorySha256
      || canonicalize(prior.binding) !== canonicalize(plan.binding) || canonicalize(prior.counts) !== canonicalize(plan.counts) || prior.commitment !== plan.commitment) fail();
    let report;
    if (mode === "--readback") {
      report = await readbackLocalLegacyBankRun(token, { buildSha256: input.buildSha256, verifyBuild, withMaintenanceLock, readPool });
    } else {
      const authority = pinned(protectedPath(option("--authority")), option("--authority-sha"));
      if (authority.inputSha256 !== inputSha256 || authority.planSha256 !== option("--plan-sha") || authority.schemaJournalSha256 !== input.schemaJournalSha256
        || authority.schemaHistorySha256 !== input.schemaHistorySha256) fail();
      let marked = false;
      const lockAndReserve = fn => withMaintenanceLock(async () => {
        const markerDir = protectedPath(join(restricted, `round06-bank-attempt-${t.databaseOid}-${sha(JSON.stringify([t.nonce, plan.binding.source.sourceDumpSha256])).slice(0, 32)}`), true);
        if (existsSync(markerDir)) fail();
        writePrivate(join(markerDir, "init.json"), { schema: "zzsh.local-legacy-bank-attempt-directory.v1", status: "RESERVED", startedAt: new Date().toISOString() });
        marked = true; reservedAttempt = true; assertWindowsBankAcl(markerDir, true);
        const marker = join(markerDir, "attempt.json"); let fd;
        try { fd = openSync(marker, "wx", 0o600); writeFileSync(fd, JSON.stringify({ schema: "zzsh.local-legacy-bank-attempt.v1", inputSha256, planSha256: option("--plan-sha"), startedAt: new Date().toISOString() })); fsyncSync(fd); }
        finally { if (fd !== undefined) closeSync(fd); }
        await fn();
      });
      let batchesReady = false;
      const persistBatch = async value => {
        if (!batchesReady) {
          output("execution-intent.json", { schema: "zzsh.local-legacy-bank-execution.v1", inputSha256, planSha256: option("--plan-sha"),
            startedAt: new Date().toISOString(), automaticRetry: false, plaintextSourceRowsPersisted: false });
          writePrivate(join(out, "batches", "manifest.json"), { schema: "zzsh.local-legacy-bank-batches.v1", inputSha256, planSha256: option("--plan-sha"), batchSize: 100 });
          assertWindowsBankAcl(join(out, "batches"), true); batchesReady = true;
        }
        if (!value || value.schema !== "zzsh.local-legacy-bank-batch.v1" || !Number.isSafeInteger(value.batchNo) || value.batchNo < 1
          || !["INTENT", "COMMIT_ACK", "COMMIT_UNKNOWN", "ROLLBACK_ACK", "ROLLBACK_UNKNOWN"].includes(value.phase)) fail();
        const path = join(out, "batches", `batch-${String(value.batchNo).padStart(5, "0")}-${value.phase.toLowerCase()}.json`); let fd;
        try { fd = openSync(path, "wx", 0o600); writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
        finally { if (fd !== undefined) closeSync(fd); }
      };
      report = await executeLocalLegacyBankRun(token, { authority, buildSha256: input.buildSha256, verifyBuild, withMaintenanceLock: lockAndReserve, writePool, readPool, persistBatch });
      report.attemptReserved = marked;
    }
    report.planStages = plan.stages;
    const pools = await closePools(); recordBankCleanup(report, maintenanceChecks, schemaChecks, pools);
    output("receipt.json", report);
    console.log(JSON.stringify({ status: report.status, counts: report.counts, durationMs: report.durationMs ?? report.elapsedMs, automaticRetry: false }));
    if (!["READBACK_MATCHED", "READBACK_MATCHED_WITH_ISOLATIONS", "NO_BINDINGS_IMPORTED", "ORIGINAL_KEYS_READ_BACK"].includes(report.status)) process.exitCode = 1;
  } finally {
    if (token) releaseLocalLegacyBankRun(token);
    await closePools();
  }
}
main().catch(() => {
  if (failureOut) try {
    if (!existsSync(join(failureOut, "receipt.json"))) writePrivate(join(failureOut, "receipt.json"),
      { status: reservedAttempt ? "OUTCOME_UNKNOWN_READBACK_REQUIRED" : "STOPPED_BEFORE_RESERVED_ATTEMPT", finishedAt: new Date().toISOString(), automaticRetry: false, plaintextSourceRowsPersisted: false });
  } catch { /* Preserve the generic error; no source values are emitted. */ }
  console.error("LEGACY_BANK_COMMAND_FAILED"); process.exitCode = 1;
});
