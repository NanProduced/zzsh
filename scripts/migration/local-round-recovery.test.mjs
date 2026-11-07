import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { win32 as path } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import test from "node:test";
import { assertSameDirectoryResumeSafe, isRoundReceiptPath, isStrictRoundReservation, matchesLoadReservation, strictRoundReservation } from "./local-load-checkpoint.mjs";
import { advisoryLockSql, assertLiveTarget, maintenanceConnection, normalizeRegisteredTarget, targetConnection, targetIdentityQuery } from "./local-target-registry.mjs";
import { assertRoundPopulationBinding, assertFullExecutionAdmitted } from "./full-source-scope.mjs";
import { assertRoundBootstrap, assessRoundEvidence, assertGrowthPlanEvidence, assertGrowthPackages, assertResumeLineage, verifyResumeSchema, assessResumeStages, assertNoWriteRetryLineage, preflightInvitationFile, readBoundInvitationPackets, requiresInvitationCountClosure } from "./local-round-contract.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const script = name => readFileSync(new URL(name, import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replaceAll("import.meta.url", "moduleUrl").replaceAll('await import("./local-target-finance.mjs")', "await financialFixture()");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const epoch = { oid: "42", nonce: "a".repeat(24) };
const window = { notBefore: "2000-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
const schema = ["b".repeat(64)];
const restricted = "E:\\zzsh-local-state\\restricted";
const ds = path.join(restricted, "dataset"), out = path.join(restricted, "load"), funds = path.join(restricted, "funds");
const credentials = path.join(restricted, "resource", "credentials.json"), registry = path.join(path.dirname(credentials), "resource.json");
const checkpoint = path.join(out, "checkpoint.json"), users = [{ sourceId: "101", input: { id: 1 } }, { sourceId: "102", input: { id: 2 } }];

async function load({ failure, strict = true, reservation = {}, previous, recover = false, exitAfterUsers = false, populationMode, undeclaredPopulation = false, invalidPopulationDigest = false, instance = null, pendingReset = null } = {}) {
  const files = new Map(), directories = new Set(), commands = [], events = [], logs = [], saves = [];
  const put = (file, value) => files.set(file, JSON.stringify(value));
  const get = file => { assert(files.has(file), file); return files.get(file); };
  const fileEntries = {};
  for (const [name, rows] of Object.entries({ users, accounts: [], orders: [] })) {
    const file = name + ".jsonl", body = rows.map(row => JSON.stringify(row) + "\n").join("");
    files.set(path.join(ds, file), body);
    fileEntries[name] = { file, sha256: sha(body) };
  }
  const manifest = path.join(ds, "manifest.json"), fundsReceipt = path.join(funds, "receipt.json");
  const population = populationMode ? { schema: "zzsh.local-population-scope.v1", mode: populationMode } : null;
  put(manifest, { status: "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN", gameBindings: {}, files: fileEntries,
    ...(population ? { population, populationSha256: invalidPopulationDigest ? "f".repeat(64) : sha(JSON.stringify(population)) } : undeclaredPopulation ? {} : { scenarioSelection: { schema: "zzsh.source-scenarios.v1" } }) });
  put(fundsReceipt, {});
  const migration = { name: "test_migration", oid: "91", password: "test" }, runtime = { name: "test_runtime", oid: "92" };
  const registration = { ...epoch, database: "zzsh_test_regression", marker: "zzsh:regression-test:v1", roles: { migration, runtime }, ...(instance ? {instance} : {}), ...(pendingReset ? {pendingReset} : {}), ...(strict || Object.keys(reservation).length ? { protectedDataset: {
    status: strictRoundReservation, epoch, manifestSha256: sha(get(manifest)), ...reservation,
  } } : {}) };
  files.set(registry, previous?.files.get(registry) ?? JSON.stringify(registration));
  if (previous) {
    files.set(checkpoint, previous.files.get(checkpoint));
    directories.add(out);
  }
  put(credentials, { database: registration.database, migration });
  files.set("test-secret", "fixture");
  const proc = { version: "v24.20.0", env: { DB_PASSWORD_FILE: "test-secret", USER_IDENTITY_SUBJECT_HMAC_KEY_FILE: "test-secret" }, argv: ["node", "script",
    recover ? "--recover" : "--execute", ...(strict ? ["--strict-round-batch"] : []), ...(failure?.startsWith("empty-coverage") ? ["--refund-attempts", funds, "--refund-attempts-sha", sha(get(fundsReceipt))] : ["--core-only"]), "--dataset", ds, "--dataset-sha", sha(get(manifest)),
    "--credentials", credentials, "--out", out, "--oid", epoch.oid, "--nonce", epoch.nonce, "--actor-id", "test-user", "--session-id", "test-session",
    "--schema-binding", JSON.stringify(schema), "--execution-window", JSON.stringify(window), "--funds-source", funds, "--funds-source-sha", sha(get(fundsReceipt)),
  ] };
  let commitAck = false, diskFailed = false;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      if (sql.startsWith("SELECT current_database()")) return { rows: [{ ...epoch, database: registration.database, owner: "zzsh", marker: registration.marker, role: migration.name, role_oid: migration.oid, is_super: "false", can_create_db: "false", can_create_role: "false", can_inherit: "false", can_bypass_rls: "false", system_identifier: instance?.systemIdentifier ?? null }] };
      if (sql.startsWith("SELECT hash")) return { rows: schema.map(hash => ({ hash })) };
      if (sql.startsWith("SELECT EXISTS")) return { rows: [{ occupied: false }] };
      commands.push(sql);
      if (sql === "COMMIT" && failure === "empty-coverage-unknown" && events.some(e => e.domain === "financeEmptyCoverage" && e.event === "INTENT")) throw Object.assign(Error("original coverage commit error"), {code:"ECONNRESET"});
      if (sql === "COMMIT" && failure === "lost-commit") {
        const error = Object.assign(Error("original commit error"), { code: "ECONNRESET" });
        this.emit("error", error);
        throw error;
      }
      if (sql === "COMMIT") commitAck = true;
      if (sql === "ROLLBACK" && commands.includes("BEGIN") && failure === "lost-rollback") {
        const error = Error("lost rollback");
        this.emit("error", error);
        throw error;
      }
      return { command: sql };
    },
    release(error) { commands.push(error ? "DESTROY_CLIENT" : "RELEASE_CLIENT"); },
  });
  const modules = {
    "supply/content-hash": { canonicalize: JSON.stringify },
    "auth/identity-subject": { deriveIdentitySubjectKey() {} },
    "database/business-migrations": { assertBusinessMigrationPrefix() {} },
    "finance/personal-finance-maintenance": { authorizeFinanceMaintenance() {} },
    "supply/legacy-user-migration": { migrateLegacyOwner(_client, row) {
      if (row.id === 2 && ["rejected", "lost-rollback"].includes(failure)) throw Object.assign(Error("original rejection"), { status: 409 });
      return { replayed: false };
    } },
  };
  const context = {
    ...path, createHash, isStrictRoundReservation, matchesLoadReservation, strictRoundReservation, process: proc, moduleUrl: "fixture", fileURLToPath: () => "C:\\project\\scripts\\migration\\load-local-dataset.mjs",
    advisoryLockSql, assertLiveTarget, maintenanceConnection, targetConnection, targetIdentityQuery, assertFullExecutionAdmitted, preflightInvitationFile, readBoundInvitationPackets, requiresInvitationCountClosure,
    // The loader reads its registry through this sandbox filesystem, not the real disk.
    loadRegisteredTarget: credentialPath => { const file = path.join(path.dirname(credentialPath), "resource.json"); return normalizeRegisteredTarget(JSON.parse(get(file)), file); },    financialFixture: () => ({ applyFinancialDomains: ctx => ctx.runItems("financeEmptyCoverage", failure === "empty-coverage" ? [{ sourceId: "empty-original" }] : Array.from({length:5},(_,i)=>({sourceId:`chunk-${i}`})), row => { if(failure === "empty-coverage" || (failure === "empty-coverage-batch" && row.sourceId === "chunk-1")) throw Object.assign(Error("coverage rejected"), { status: 409 }); return {replayed:false}; }, failure === "empty-coverage" ? 1 : 5) }),
    console: { log: message => logs.push(JSON.parse(message)), error: message => logs.push(JSON.parse(message)) },
    createInterface, createReadStream: file => Readable.from([Buffer.from(get(file))]),
    existsSync: file => files.has(file) || directories.has(file), mkdirSync: file => directories.add(file), readFileSync: (file, encoding) => encoding ? get(file) : Buffer.from(get(file)),
    writeFileSync: (file, value) => files.set(file, value), appendFileSync: (_file, value) => events.push(JSON.parse(value)),
    writeLoadCheckpoint(file, value) {
      if (file === checkpoint && commitAck && failure === "receipt" && !diskFailed) { diskFailed = true; throw Object.assign(Error("original disk error"), { code: "ENOSPC" }); }
      put(file, value);
      if (file === checkpoint) saves.push(JSON.parse(get(file)));
    },
    spawnSync: () => ({ stdout: "S-1-5-21-1", status: 0 }),
    createRequire: () => name => name === "pg" ? {
      Client: class { async connect() {} async query(sql) { commands.push(sql.includes("try_advisory") ? "LOCK" : "UNLOCK"); return { rows: [{ ok: true }] }; } async end() { commands.push("MAINTENANCE_END"); } },
      Pool: class { async connect() { return client; } async end() { commands.push("POOL_END"); } },
    } : modules[name.slice(name.indexOf("dist\\src\\") + 9, -3).replaceAll("\\", "/")],
  };
  if (exitAfterUsers) context.createReadStream = file => {
    const reads = commands.includes("COMMIT");
    if (reads && file === path.join(ds, "accounts.jsonl")) throw Error("fixture continued after users");
    return Readable.from([Buffer.from(get(file))]);
  };
  let error;
  try { await new AsyncFunction(...Object.keys(context), script("load-local-dataset.mjs"))(...Object.values(context)); }
  catch (cause) { error = cause; }
  return { commands, directories, error, events, files, logs, saves, exit: proc.exitCode, state: files.has(checkpoint) ? JSON.parse(get(checkpoint)) : null };
}

test("strict run commits one batch without savepoints", async () => {
  const r = await load();
  assert.ifError(r.error);
  assert.equal(r.exit, undefined, JSON.stringify(r.logs));
  assert.deepEqual(r.commands.slice(3, 6), ["BEGIN", "SET CONSTRAINTS ALL IMMEDIATE", "COMMIT"]);
  assert.equal(r.state.phases.users.nextIndex, 2);
  assert.equal(r.state.rollbackConfirmed, true);
  assert.equal(JSON.parse(r.files.get(registry)).protectedDataset.bootstrapReservation, strictRoundReservation);
  const continued = await load({ previous: r });
  assert.ifError(continued.error);
  assert.equal(continued.exit, undefined);
  assert.equal(continued.state.phases.users.nextIndex, 2);
  assert.ok(!continued.commands.includes("COMMIT"));
});

test("a checkpoint refuses another cluster even with the same database OID and nonce", async () => {
  const firstInstance={host:"127.0.0.1",port:55433,systemIdentifier:"123"};
  const first=await load({instance:firstInstance});assert.ifError(first.error);
  assert.deepEqual(first.state.binding.instance,firstInstance);
  const changed=JSON.parse(first.files.get(registry));changed.instance={...firstInstance,systemIdentifier:"456"};
  first.files.set(registry,JSON.stringify(changed));
  const resumed=await load({previous:first,instance:changed.instance});
  assert.match(resumed.error.message,/CHECKPOINT_BINDING_CHANGED/);assert.deepEqual(resumed.commands,[]);
});

test("a registered pending reset stops before any database connection", async () => {
  const result=await load({pendingReset:{oid:"42",at:"2026-11-06T00:00:00Z"}});
  assert.match(result.error.message,/^RES:/);assert.deepEqual(result.commands,[]);
});

test("direct loader refuses full captured source before database connection while selected and legacy plans remain compatible", async () => {
  // A full-source dataset that does not declare the bounded empty-coverage path stays refused before
  // any connection or output, and a scenario or legacy dataset keeps working.
  const full = await load({ populationMode: "FULL_CAPTURED_SOURCE" });
  assert.match(full.error.message, /FULL_CAPTURED_EXECUTION_REQUIRES_BOUNDED_EMPTY_COVERAGE/);
  assert.deepEqual(full.commands, []); assert.equal(full.state, null); assert.deepEqual([...full.directories], []);
  const selected = await load({ populationMode: "SCENARIO_SELECTION" });
  assert.ifError(selected.error); assert.ok(selected.commands.includes("COMMIT"));
  const legacy = await load(); assert.ifError(legacy.error); assert.ok(legacy.commands.includes("COMMIT"));
  const unknown = await load({ undeclaredPopulation: true }); assert.match(unknown.error.message, /UNDECLARED_POPULATION_EXECUTION_BLOCKED/); assert.deepEqual(unknown.commands, []);
  const invalid = await load({ populationMode: "UNKNOWN" }); assert.match(invalid.error.message, /UNDECLARED_POPULATION_EXECUTION_BLOCKED/); assert.deepEqual(invalid.commands, []);
  const badDigest = await load({ populationMode: "SCENARIO_SELECTION", invalidPopulationDigest: true }); assert.match(badDigest.error.message, /POPULATION_SCOPE_DIGEST_INVALID/); assert.deepEqual(badDigest.commands, []);
});

test("R06 strict reservation remains bound across checkpoint continuation", async () => {
  const reservation = { status: "ROUND06_BOOTSTRAP_RESERVED" };
  const first = await load({ reservation });
  assert.ifError(first.error);
  assert.equal(first.exit, undefined);
  assert.equal(JSON.parse(first.files.get(registry)).protectedDataset.bootstrapReservation, reservation.status);
  const continued = await load({ previous: first });
  assert.ifError(continued.error);
  assert.equal(continued.exit, undefined);
  assert.equal(JSON.parse(continued.files.get(registry)).protectedDataset.bootstrapReservation, reservation.status);
  assert.ok(!continued.commands.includes("COMMIT"));
});

test("R07 strict reservation remains R07 across checkpoint continuation", async () => {
  const reservation={status:"ROUND07_BOOTSTRAP_RESERVED"},instance={host:"127.0.0.1",port:55433,systemIdentifier:"123"};
  const first=await load({reservation,instance});assert.ifError(first.error);
  assert.equal(JSON.parse(first.files.get(registry)).protectedDataset.bootstrapReservation,reservation.status);
  const continued=await load({previous:first,instance});assert.ifError(continued.error);
  assert.equal(JSON.parse(continued.files.get(registry)).protectedDataset.bootstrapReservation,reservation.status);
});

test("R06 rejects ordinary mode, other-round markers and source or target drift before connecting", async () => {
  for (const options of [
    { strict: false, reservation: { status: "ROUND06_BOOTSTRAP_RESERVED" } },
    { reservation: { status: "ROUND06_BOOTSTRAP_RESERVED", bootstrapReservation: strictRoundReservation } },
    { reservation: { status: strictRoundReservation, bootstrapReservation: "ROUND06_BOOTSTRAP_RESERVED" } },
    { reservation: { status: "ROUND06_BOOTSTRAP_RESERVED", manifestSha256: "wrong" } },
    { reservation: { status: "ROUND06_BOOTSTRAP_RESERVED", epoch: { ...epoch, oid: "43" } } },
    { reservation: { status: "ROUND06_BOOTSTRAP_RESERVED", epoch: { ...epoch, nonce: "wrong" } } },
  ]) {
    const r = await load(options);
    assert.match(r.error.message, /CHECKPOINT_STRICT_BATCH_CHANGED|ROUND06_RESERVATION_CHANGED|STRICT_BATCH_REQUIRES_ROUND04/);
    assert.deepEqual(r.commands, []);
    assert.equal(r.directories.size, 0);
  }
});

test("strict rejection rolls back once and ordinary rejection still quarantines", async () => {
  const strict = await load({ failure: "rejected" });
  assert.equal(strict.state.status, "FAILED_ROLLED_BACK");
  assert.equal(strict.state.rollbackConfirmed, true);
  assert.equal(strict.state.pending, null);
  assert.equal(strict.state.phases.users.nextIndex, 0);
  assert.deepEqual(strict.commands.slice(3, 6), ["BEGIN", "ROLLBACK", "RELEASE_CLIENT"]);
  assert.equal(strict.events.find(e => e.event === "STRICT_ROW_REJECTED").index, 1);
  const ordinary = await load({ strict: false, failure: "rejected" });
  assert.equal(ordinary.exit, undefined);
  assert.ok(ordinary.commands.includes("ROLLBACK TO SAVEPOINT source_row"));
  assert.equal(ordinary.state.phases.users.quarantined, 1);
});

for (const [failure, status, stage, lastSql, errorMessage] of [
  ["lost-commit", "COMMIT_UNKNOWN", "COMMIT_UNKNOWN", "COMMIT", "original commit error"],
  ["lost-rollback", "ROLLBACK_UNKNOWN", "ROLLBACK_UNKNOWN", "ROLLBACK", "original rejection"],
  ["receipt", "RECEIPT_WRITE_FAILED_COMMITTED", "COMMIT_ACK_RECEIPT_FAILED", "COMMIT", "original disk error"],
]) test(`${failure} stops the whole run, destroys the client, and retains the exact pending batch`, async () => {
  const r = await load({ failure, exitAfterUsers: true });
  assert.ifError(r.error);
  assert.equal(r.exit, 1);
  assert.deepEqual(r.commands.slice(-5), [lastSql, "DESTROY_CLIENT", "POOL_END", "UNLOCK", "MAINTENANCE_END"]);
  assert.equal(r.state.status, status);
  assert.equal(r.state.error.message, errorMessage);
  assert.equal(r.state.rollbackConfirmed, false);
  assert.equal(r.state.checkpoints, 0);
  assert.equal(r.state.phases.users.nextIndex, 0);
  assert.deepEqual(Object.keys(r.state.phases), ["users"]);
  assert.deepEqual(r.state.pending, { domain: "users", start: 0, end: 2, sourceIds: ["101", "102"], phaseBodyDigest: sha(JSON.stringify(users)), stage });
  assert.ok(r.saves.every(saved => saved.phases.users?.nextIndex !== 2));
  const execute = await load({ previous: r });
  assert.match(execute.error.message, /PENDING_TRANSACTION_READ_ONLY_RECOVERY_REQUIRED/);
  assert.deepEqual(execute.commands, []);
  const recovery = await load({ previous: r, recover: true });
  assert.ifError(recovery.error);
  assert.equal(recovery.exit, undefined);
  assert.equal(recovery.files.get(checkpoint), r.files.get(checkpoint));
  assert.equal(recovery.files.get(registry), r.files.get(registry));
  assert.deepEqual(recovery.commands, ["LOCK", "RELEASE_CLIENT", "POOL_END", "UNLOCK", "MAINTENANCE_END"]);
  const receipt = JSON.parse([...recovery.files].find(([file]) => file.startsWith(path.join(out, "recovery-")))[1]);
  assert.deepEqual(receipt.pending, r.state.pending);
  assert.equal(receipt.knowledge, "EXACT_PENDING_KEYS_REQUIRE_INSPECTION");
});

test("direct strict load rejects reservation drift before creating output or connecting", async () => {
  for (const reservation of [{ status: "ROUND03_BOOTSTRAP_RESERVED" }, { manifestSha256: "wrong" }, { epoch: { ...epoch, oid: "43" } }, { epoch: { ...epoch, nonce: "wrong" } }]) {
    const r = await load({ reservation });
    assert.match(r.error.message, /STRICT_BATCH_REQUIRES_ROUND04/);
    assert.deepEqual(r.commands, []);
    assert.equal(r.directories.size, 0);
  }
});

test("ordinary financeEmptyCoverage rolls back the entire chunk on a conflict", async () => {
  const r = await load({ strict: false, failure: "empty-coverage" });
  assert.ifError(r.error);
  assert.equal(r.exit, 1);
  assert.equal(r.state.phases.financeEmptyCoverage.nextIndex, 0);
  assert.equal(r.state.phases.financeEmptyCoverage.quarantined, 0);
  assert.equal(r.state.pending, null);
  assert.ok(!r.commands.includes("ROLLBACK TO SAVEPOINT source_row"));
  assert.deepEqual(r.commands.slice(-7), ["BEGIN", "SAVEPOINT source_row", "ROLLBACK", "RELEASE_CLIENT", "POOL_END", "UNLOCK", "MAINTENANCE_END"]);
});

test("five proved-empty chunks roll back together when a later chunk is rejected", async () => {
  const r=await load({failure:"empty-coverage-batch"});
  assert.ifError(r.error);assert.equal(r.exit,1);
  assert.equal(r.state.phases.financeEmptyCoverage.nextIndex,0);
  assert.equal(r.state.pending,null);
  assert.equal(r.events.some(e=>e.domain==="financeEmptyCoverage"&&e.event==="COMMIT_ACK"),false);
  assert.equal(r.state.status,"FAILED_ROLLED_BACK");
});

test("five proved-empty chunks use one acknowledged transaction and retain each chunk outcome", async () => {
  const r=await load({failure:"empty-coverage-success"});
  assert.ifError(r.error);assert.equal(r.exit,undefined);
  assert.equal(r.state.phases.financeEmptyCoverage.nextIndex,5);
  assert.equal(r.state.phases.financeEmptyCoverage.created,5);
  assert.equal(r.events.filter(e=>e.domain==="financeEmptyCoverage"&&e.event==="COMMIT_ACK").length,1);
});

test("unknown coverage commit keeps all five original chunk keys and stops", async () => {
  const r=await load({failure:"empty-coverage-unknown"});
  assert.ifError(r.error);assert.equal(r.exit,1);
  assert.equal(r.state.status,"COMMIT_UNKNOWN");
  assert.deepEqual(r.state.pending.sourceIds,["chunk-0","chunk-1","chunk-2","chunk-3","chunk-4"]);
  assert.equal(r.state.phases.financeEmptyCoverage.nextIndex,0);
});

async function round({ reservationStatus = strictRoundReservation, action = "execute", drift, strict = true, bootstrapDrift, missingBootstrap = false, withGrowth = false, artifactFault, separateBossBinding = false, resumeCase, dependencyDrift, instance = null, sameOutputStopped = false, sameOutputStages = [{ name: "core-and-funds", status: "INTENT" }], sameOutputArtifacts = [] } = {}) {
  const files = new Map(), directories = [], spawns = [], logs = [], reads = [], liveCommands = [], logOpens = [];
  const targetSchema = reservationStatus === "ROUND06_BOOTSTRAP_RESERVED" ? ["1", "2", "3", "4", "5"].map(x => x.repeat(64)) : schema;
  const cohort = resumeCase === "bad-package" ? 1 : 0;
  const put = (file, body) => {
    const bytes = Buffer.from(JSON.stringify(body));
    files.set(file, bytes);
    return { path: file, sha256: sha(bytes) };
  };
  const pinned = (name, data, filename = "manifest.json") => {
    const directory = path.join(restricted, name);
    return { ...put(path.join(directory, filename), data), path: directory };
  };
  const source = pinned("source", { status: "CAPTURED_READ_ONLY" }, "receipt.json");
  const supplement = { sourceSupplement: { baseReceiptSha256: source.sha256 } };
  const dataset = pinned("dataset", { sourceReceiptSha256: source.sha256, sourceCutoff: "2026-01-01T00:00:00.000Z", scenarioSelection: { schema: "zzsh.source-scenarios.v1" }, domains: { accounts: { ready: cohort }, users: { ready: cohort }, orders: { ready: cohort }, continuations: { parameterComplete: 0 } } });
  const pathSourcePlan = pinned("paths-source", {}, "receipt.json");
  const apiDist = "C:\\project\\dist", buildFiles = {};
  for (const file of ["database/business-migrations.js", "supply/legacy-user-migration.js", "legacy-load/legacy-account-seam.js", "order/legacy-order-read.js", "finance/personal-finance-maintenance.js", "legacy-load/legacy-path-records.js"]) buildFiles[file] = put(path.join(apiDist, file), {}).sha256;
  const secretRoot = "E:\\zzsh\\zzsh\\apps\\api\\.secrets";
  const target = { ...epoch, database: "zzsh_test_regression", ...(instance?{instance}:{}) }, marker = "zzsh:regression-test:v1";
  const bundle = put(path.join(restricted, "bundle.json"), { moduleSha256: "c".repeat(64), entries: Object.entries(buildFiles).map(([file, digest]) => ({ path: "api-build/src/" + file, sha256: bootstrapDrift === "bundle" ? "2".repeat(64) : digest })) });
  const runtime = put(path.join(restricted, "runtime.json"), { resource: { ...target, ...(bootstrapDrift === "runtime" ? { oid: "43" } : {}), marker, migrationRoleOid: "91" },
    actualResource: { ...target, marker, migration_role_oid: "91", read_only: "on" }, formalAppMounted: true,
    copyManifestSha256: bundle.sha256, moduleSha256: "c".repeat(64), compiledRoot: apiDist });
  const bossOrigin = put(path.join(restricted, "boss-runtime.json"), { resource: { database: target.database, resourceOid: bootstrapDrift === "boss-origin" ? "43" : epoch.oid },
    initialization: { nonce: epoch.nonce, imProvisioner: false, imIdentityRepository: false, imAppId: null } });
  const admin = stage => {
    const prior = stage === "bosses" && separateBossBinding;
    const ref = put(path.join(restricted, stage + ".json"), { stage, status: "FORMAL_INITIALIZATION_COMPLETED", target: bootstrapDrift === stage ? { ...target, oid: "43" } : target,
      serverBindingSha256: prior ? bossOrigin.sha256 : runtime.sha256, finalReadbackRollbackAck: true, maintenanceClosed: true, unlock: true, oldAdminRowsImported: false });
    return prior ? { ...ref, serverBinding: bossOrigin } : ref;
  };
  const policyId = "growth-policy-1", effectiveAt = "2026-01-01T00:00:00.000Z", approvalId = "approval-1";
  const evidence = { runtime, bundle, swap: put(path.join(restricted, "swap.json"), { ...epoch, ...(instance?{instance}:{}), ...(bootstrapDrift === "swap" ? { oid: "43" } : {}), status: "COMMIT_ACK" }),
    schema: put(path.join(restricted, "schema.json"), reservationStatus === "ROUND06_BOOTSTRAP_RESERVED"
      ? { ...epoch, status: "FINAL_SCHEMA_0157_VERIFIED", target: { ...target, database: "zzsh_test_round06_stage", marker: "zzsh:round06-schema-build:v1", migrationRoleOid: "91" },
        hashes: bootstrapDrift === "schema" ? ["2".repeat(64)] : targetSchema, finalOrdinal: 157, commitAck: true, migrationExit: { code: 0, signal: null },
        readbackRollbackAck: true, readbackClientClosed: true, unlockAck: true, maintenanceClosed: true, journalSha256: "a".repeat(64), historySha256: "b".repeat(64) }
      : { ...epoch, ...(instance?{instance}:{}), status: "CLEAN_SCHEMA_INSTALLED", hashes: bootstrapDrift === "schema" ? ["2".repeat(64)] : targetSchema,
        ...(reservationStatus === "ROUND07_BOOTSTRAP_RESERVED" ? {finalOrdinal:160,commitAck:true,migrationAck:true,readbackRollbackAck:true,readbackClientClosed:true,unlockAck:true,maintenanceClosed:true,journalSha256:'a'.repeat(64),historySha256:'b'.repeat(64)} : {}) }),
    administrators: [admin("bosses"), admin("staff")], business: put(path.join(restricted, "business.json"), { ...epoch, ...(instance?{instance}:{}), ...(bootstrapDrift === "business" ? { oid: "43" } : {}), status: "REFERENCE_BOOTSTRAP_COMMITTED", manifestSha256: "d".repeat(64), tables: [{}], commitAck: true, maintenanceClosed: true, poolClosed: true, unlock: true, maintenanceAdminId: "test-user" }),
    readback: put(path.join(restricted, "bootstrap-readback.json"), { identity: { ...target, ...(bootstrapDrift === "readback" ? { oid: "43" } : {}), marker, read_only: "on" }, rollbackAck: true, clientClosed: true, admins: { allActive: true, twoFactor: true, onlyNewUids: true, oldSessions: 0, count: 4 },
      policy: { id: bootstrapDrift === "policy" ? "old-policy" : policyId, status: "APPROVED", effectiveAtUtc: effectiveAt, effectiveNow: true, newApprovalRequestId: approvalId, requestStatus: "EXECUTED", decision: "APPROVED", executionStatus: "SUCCEEDED", onlyNewBossRelations: true } }),
    policy: put(path.join(restricted, "policy.json"), { status: "FORMAL_LOCAL_POLICY_INITIALIZED", executionStatus: "SUCCEEDED", oldApprovalsCopied: false, approvalRequestId: approvalId, policyId, effectiveAtUtc: effectiveAt }) };
  const inputBody = {
    schema: "zzsh.local-round.v1", window: resumeCase ? { notBefore: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } : window,
    credentials, target: { ...epoch, ...(instance?{instance}:{}), bootstrapReservation: ["ROUND06_BOOTSTRAP_RESERVED","ROUND07_BOOTSTRAP_RESERVED"].includes(reservationStatus) ? reservationStatus : strictRoundReservation, schemaHashes: targetSchema, migrationRoleOid: "91" },
    out, apiDist, buildFiles, strictBatch: strict, dataset, source, pathSourcePlan,
    paths: pinned("paths", { sourcePlanReceiptSha256: pathSourcePlan.sha256, datasetSha256: dataset.sha256, accounts: cohort }, "receipt.json"),
    display: pinned("display", { datasetSha256: dataset.sha256, rows: cohort, notDisplayable: 0 }),
    openings: pinned("opening", { datasetSha256: dataset.sha256, stats: { subjects: cohort, candidate: cohort } }),
    funds: pinned("funds", supplement, "receipt.json"), refundAttempts: pinned("refund", supplement, "receipt.json"), dictionary: pinned("dictionary", {}, "receipt.json"),
    actor: put(path.join(restricted, "actor.json"), { id: "test-user", sessionId: "test-session", resourceOid: epoch.oid, nonce: epoch.nonce }),
    secrets: { databaseMaintenance: put(path.join(secretRoot, "db"), "fixture"), identitySubjectHmac: put(path.join(secretRoot, "hmac"), "fixture") },
    ...(withGrowth || resumeCase ? { growth: { policyId, policyEffectiveAt: effectiveAt, approvedBy: "Root", approvalRef: "ROOT-FIXTURE-GROWTH", attempt: 1 } } : {}),
    ...(missingBootstrap ? {} : { bootstrapEvidence: evidence }),
  };
  if (["ROUND06_BOOTSTRAP_RESERVED","ROUND07_BOOTSTRAP_RESERVED"].includes(reservationStatus) && dependencyDrift !== "missing") inputBody.dependencyBinding = {
    buildManifest: put(path.join(restricted, "dependency-build.json"), {}), sourceManifest: put(path.join(restricted, "dependency-source.json"), {}), sourceSnapshot: "C:\\fixture",
    proof: put(path.join(restricted, "dependency-proof.json"), { status: "ROUND_DEPENDENCY_CLOSURE_VERIFIED", entrypoints: 32, closureFiles: [["fixture", "a".repeat(64)]], closureSha256: "c".repeat(64) }) };
  let oldCheckpointPath, oldCheckpointBytes, oldReceiptRef, oldOut;
  if (resumeCase) {
    oldOut = path.join(restricted, "original-round");
    const oldWindow = { notBefore: "2000-01-01T00:00:00.000Z", expiresAt: "2000-01-01T01:00:00.000Z" };
    const oldActor = put(path.join(restricted, "old-actor.json"), { id: "test-user", sessionId: "old-session", resourceOid: epoch.oid, nonce: epoch.nonce });
    const oldBody = { ...inputBody, out: oldOut, actor: oldActor, window: oldWindow };
    const oldInput = put(path.join(restricted, "original-input.json"), oldBody);
    const oldReceipt = put(path.join(oldOut, resumeCase === "fabricated-receipt" ? "round-receipt-resumed.json" : "round-receipt.json"), { schema: "zzsh.local-round-receipt.v1", inputSha256: oldInput.sha256,
      datasetSha256: dataset.sha256, target: inputBody.target, strictBatch: strict, status: "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS",
      stages: [{ name: "opening", status: "INTENT", code: 1, signal: null }, ...(resumeCase === "prior-growth-stage" ? [{ name: "growth-apply", status: "INTENT" }] : [])] });
    oldReceiptRef = oldReceipt;
    const phaseNames = ["users", "accounts", "orders", "invitationFacts", "financeHistory", "financeEmptyCoverage", "guaranteeHistory", "continuationEvidence", "liabilityDuties", "completedCommissions", "accountDisplay", "storedOpening", "skinHoldings"];
    const oldCheckpoint = { schema: "zzsh.local-legacy-load.v1", binding: { ...epoch, database: "zzsh_test_regression", datasetSha256: dataset.sha256, actorId: "test-user", sessionId: "old-session" },
      strictBatch: strict, schemaHashes: schema, executionWindow: oldWindow, status: resumeCase === "unknown" ? "COMMIT_UNKNOWN" : "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED",
      pending: resumeCase === "unknown" ? { stage: "COMMIT_UNKNOWN" } : null, poolClosed: true, unlock: true, maintenanceClosed: true, rollbackConfirmed: true,
      phases: Object.fromEntries(phaseNames.map(name => [name, { complete: name !== (resumeCase === "missing-phase" ? "storedOpening" : ""), quarantined: 0, nextIndex: ["users", "accounts", "orders", "accountDisplay", "storedOpening", "skinHoldings"].includes(name) ? cohort : 0 }])), skinHoldingsPreparation: { ready: cohort, isolated: 0 } };
    oldCheckpointPath = path.join(oldOut, "loader", "checkpoint.json");
    const oldCheckpointRef = put(oldCheckpointPath, oldCheckpoint); oldCheckpointBytes = Buffer.from(files.get(oldCheckpointPath));
    inputBody.resume = { schema: "zzsh.local-round-growth-resume.v1", previousInput: oldInput, previousReceipt: oldReceipt, checkpoint: oldCheckpointRef };
    if (resumeCase === "different-source") inputBody.resume.previousInput.sha256 = "f".repeat(64);
    put(credentials, { database: "zzsh_test_regression", migration: { name: "fixture_m", oid: "91", password: "fixture" } });
  }
  const input = put(path.join(restricted, "round-input.json"), inputBody);
  let sameOutputReceipt;
  if (sameOutputStopped) {
    sameOutputReceipt = put(path.join(out, "round-receipt.json"), { schema: "zzsh.local-round-receipt.v1", inputSha256: input.sha256, status: "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS", stages: sameOutputStages });
    files.set(path.join(out, "core-and-funds.stdout.log"), Buffer.from("old stdout"));
    files.set(path.join(out, "core-and-funds.stderr.log"), Buffer.from("old stderr"));
    for (const name of sameOutputArtifacts) files.set(path.join(out, name), Buffer.from("old " + name));
  }
  put(registry, { ...epoch, ...(instance?{instance}:{}), database: "zzsh_test_regression", marker: "zzsh:regression-test:v1", roles: { migration: { name: "fixture_m", oid: "91" }, runtime: { name: "fixture_r", oid: "92" } },
    ...(resumeCase ? { protectedDataset: { status: "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED", manifestSha256: dataset.sha256, epoch, report: oldCheckpointPath } }
      : reservationStatus ? { protectedDataset: { status: reservationStatus, manifestSha256: dataset.sha256, epoch, ...drift } } : {}) });
  const attemptPath = path.join(restricted, `growth-resume-attempt-${epoch.oid}-${epoch.nonce}.json`);
  if (resumeCase === "prior-attempt") files.set(attemptPath, Buffer.from("{}"));
  if (bootstrapDrift === "digest") files.set(evidence.business.path, Buffer.from("{}"));
  const proc = { env: {}, execPath: "node", exit() { throw "EXIT"; }, argv: ["node", "script", "--" + action, "--input", input.path, "--input-sha", input.sha256] };
  if (action === "inspect-receipt") {
    const original = put(path.join(out, "round-receipt-resumed.json"), { schema: "zzsh.local-round-receipt.v1", inputSha256: input.sha256,
      datasetSha256: dataset.sha256, target: epoch, strictBatch: strict, status: "DATASET_STAGES_ACK_READBACK_PASS", stages: [] });
    proc.argv.push("--receipt", original.path, "--receipt-sha", original.sha256);
  }
  const brokenPath = artifactFault ? path.join(out, ...artifactFault.file.split("/")) : null;
  if (brokenPath) files.set(brokenPath, Buffer.from(artifactFault.kind === "null" ? "null" : artifactFault.kind === "array" ? "[]" : "{"));
  let attemptFile;
  const context = {
    ...path, assert, createHash, isRoundReceiptPath, isStrictRoundReservation, matchesLoadReservation, strictRoundReservation,
    assertSameDirectoryResumeSafe,
    inspectRoundResumeOutput: directory => directory === oldOut && oldReceiptRef ? { sequence: 1, previousReceipt: oldReceiptRef } : directory === out && sameOutputReceipt ? { sequence: 1, previousReceipt: sameOutputReceipt, stageNames: sameOutputStages.map(stage => stage.name) } : null,
    reserveRoundResumeOutput: directory => { const attempt = path.join(directory, "round-attempt-000001"); directories.push(attempt); return attempt; },
    assertRoundBootstrap, assessRoundEvidence, assertGrowthPlanEvidence, assertGrowthPackages, assertResumeLineage, verifyResumeSchema, assessResumeStages, assertNoWriteRetryLineage, assertRoundPopulationBinding, assertFullExecutionAdmitted, requiresInvitationCountClosure, process: proc, moduleUrl: "file:///C:/project/scripts/migration/run-local-round.mjs",
    targetConnection, loadRegisteredTarget: credentialPath => { const file = path.join(path.dirname(credentialPath), "resource.json"); return normalizeRegisteredTarget(JSON.parse(String(files.get(file))), file); },
    inspectRoundDependencyLayout: () => ({ sourceRoot: "C:\\fixture", scriptDir: "C:\\fixture\\scripts\\migration", moduleDirs: ["C:\\fixture\\node_modules"] }),
    assertRoundDependencyProof: () => { if (dependencyDrift === "proof") throw Error("ROUND_DEPENDENCY_PROOF_CHANGED"); },
    assertBoundRunnerScripts: () => { if (dependencyDrift === "runner") throw Error("ROUND_DEPENDENCY_RUNNER_CHANGED"); },
    probeRoundDependencies: () => ({ closureSha256: dependencyDrift === "closure" ? "d".repeat(64) : "c".repeat(64), entrypoints: 32 }),
    fileURLToPath: url => path.normalize(String(url).slice("file:///".length)),
    createRequire: () => () => ({ Client: class { async connect() { liveCommands.push("connect"); } async query(sql) {
      liveCommands.push(sql); if (sql.startsWith("SELECT current_database")) return { rows: [{ database: "zzsh_test_regression", ...epoch,
        ...(resumeCase === "schema-target-drift" ? { oid: "43" } : {}), owner: "zzsh", marker, role: "fixture_m", role_oid: "91", read_only: "on", rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }] };
      if (sql.startsWith("SELECT hash")) return { rows: (resumeCase.startsWith("schema-drift") ? ["3".repeat(64)] : schema).map(hash => ({ hash })) };
      if (sql === "ROLLBACK" && resumeCase.endsWith("rollback-fail")) throw Error("fixture rollback failure");
      return { command: sql }; } async end() { liveCommands.push("end"); if (resumeCase === "schema-close-fail") throw Error("fixture close failure"); } } }),
    lstatSync: file => {
      if (sameOutputStopped && path.dirname(file) === out && ["path-execution", "readback.json", "growth-plan", "growth-execution", "growth-readback", "readback-final.json"].includes(path.basename(file)) && !files.has(file)) throw Object.assign(Error("missing fixture output"), { code: "ENOENT" });
      return { isFile: () => true, isSymbolicLink: () => false };
    }, existsSync: file => files.has(file), mkdirSync: file => directories.push(file),
    readFileSync(file) { reads.push(file); if (file === brokenPath && artifactFault.kind === "read-error") throw Object.assign(Error("original artifact read failure"), { code: "EIO" }); return files.get(file) ?? Buffer.from("fixture-tool"); }, readdirSync: () => Object.keys(buildFiles),
    spawnSync: () => ({ stdout: "S-1-5-21-1", status: 0 }),
    spawn(_node, args) {
      spawns.push(args);
      let exit = 1;
      if (resumeCase && !["readback-fail", "schema-drift", "schema-target-drift", "schema-drift-rollback-fail", "schema-rollback-fail", "schema-close-fail", "unknown", "missing-phase", "different-source"].includes(resumeCase)) {
        const scriptName = args[0], outputPath = args[args.indexOf("--out") + 1];
        if (scriptName.endsWith("readback-local-dataset.mjs")) {
          if (!(resumeCase === "final-readback-fail" && outputPath.endsWith("readback-final.json"))) {
            put(outputPath, { schema: "zzsh.local-dataset-readback.v1", resource: { ...epoch, database: "zzsh_test_regression" }, sourceDatasetSha256: dataset.sha256,
              status: "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED", differenceCount: 0, targetWrites: 0, rollbackConfirmed: true, lockReleased: true, connectionsClosed: true,
              domains: { users: { expected: cohort }, accounts: { expected: cohort }, orders: { expected: cohort } },
              display: { expected: cohort, matched: cohort }, openings: { expected: cohort, matched: cohort }, holdings: { expected: cohort, matched: cohort }, paths: { expected: cohort, matched: cohort } });
            if (resumeCase === "checkpoint-drift") files.set(oldCheckpointPath, Buffer.from("{}"));
            if (resumeCase === "before-corrupt" && outputPath.endsWith("readback-final.json")) files.set(path.join(out, "readback.json"), Buffer.from("{}"));
            if (resumeCase === "summary-drift" && outputPath.endsWith("readback-final.json")) {
              const file = path.join(out, "growth-execution", "summary.json"), value = JSON.parse(files.get(file)); value.extra = "changed"; put(file, value);
            }
            exit = 0;
          }
        } else if (scriptName.endsWith("run-local-growth.mjs")) {
          const shared = { ...epoch, inputSha256: input.sha256, datasetSha256: dataset.sha256 };
          const growthSummary = { users: cohort, orders: cohort, complete: cohort, pending: 0, contributions: 0 };
          if (args.includes("--prepare") && resumeCase !== "growth-prepare-fail") {
            const sorted = Object.fromEntries(Object.entries(buildFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
            const packages = cohort ? [{ file: "packages/00001.json", userId: "user-1", executionKey: "key-1", sha256: sha("correct"), coverageFingerprint: "4".repeat(64), coverageState: "COMPLETE", contributionCount: 0 }] : [];
            if (cohort) files.set(path.join(outputPath, "packages/00001.json"), Buffer.from("changed"));
            const manifest = put(path.join(outputPath, "manifest.json"), { ...epoch, schema: "zzsh.local-growth-round-plan.v1", status: "PREPARED_NOT_APPLIED",
              datasetSha256: dataset.sha256, policy: { id: resumeCase === "growth-prepare-bad-manifest" ? "old-policy" : policyId, effectiveAt }, cutoff: "2026-01-01T00:00:00.000000Z", buildDigest: sha(JSON.stringify(sorted)), packages, summary: growthSummary });
            put(path.join(outputPath, "summary.json"), { ...shared, mode: "--prepare", status: "PREPARED_NOT_APPLIED", readOnlyRollbackAck: true, readOnlyClientClosed: true, manifestSha256: manifest.sha256, summary: growthSummary }); exit = 0;
          } else if (args.includes("--apply")) {
            put(path.join(outputPath, "summary.json"), { ...shared, mode: "--apply", status: "APPLIED_COMMIT_ACK_INDEPENDENT_READBACK_REQUIRED", manifestSha256: args[args.indexOf("--manifest-sha") + 1], poolClosed: true, unlockAck: true, lockClosed: true, completed: 0, inserted: 0, replayed: 0, complete: 0, partial: 0, pending: null, fundsWrites: 0 }); exit = 0;
          } else if (args.includes("--readback")) {
            put(path.join(outputPath, "summary.json"), { ...shared, mode: "--readback", status: "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED", manifestSha256: args[args.indexOf("--manifest-sha") + 1], readOnlyRollbackAck: true, readOnlyClientClosed: true, fundsWrites: 0, summary: { coverage: 0, contributions: 0, complete: 0, pending: 0 } }); exit = 0;
          }
        }
      }
      return { once(event, callback) { if (event === "close") callback(exit, null); } };
    },
    openSync(file, flags) {
      if (file === attemptPath) {
        if (resumeCase === "reservation-race" || files.has(file)) throw Object.assign(Error("already exists"), { code: "EEXIST" });
        attemptFile = file; files.set(file, Buffer.alloc(0)); return 9;
      }
      logOpens.push({ file, flags });
      return 1;
    },
    writeFileSync(fd, bytes) { if (fd === 9) files.set(attemptFile, Buffer.from(bytes)); },
    fsyncSync(fd) { if (fd === 9 && resumeCase === "reservation-fsync-fail") throw Error("fixture marker fsync failure"); },
    closeSync() {}, writeLoadCheckpoint: put, console: { log: value => logs.push(JSON.parse(value)) },
  };
  let error;
  try { await new AsyncFunction(...Object.keys(context), script("run-local-round.mjs"))(...Object.values(context)); }
  catch (cause) { if (cause !== "EXIT") error = cause; }
  const inspectCurrent = async () => {
    const receiptPath = path.join(out, "round-receipt.json"), bytes = files.get(receiptPath);
    proc.argv = ["node", "script", "--inspect-receipt", "--input", input.path, "--input-sha", input.sha256, "--receipt", receiptPath, "--receipt-sha", sha(bytes)];
    delete proc.exitCode;
    const start = logs.length;
    let inspectError;
    try { await new AsyncFunction(...Object.keys(context), script("run-local-round.mjs"))(...Object.values(context)); }
    catch (cause) { if (cause !== "EXIT") inspectError = cause; }
    return { error: inspectError, exit: proc.exitCode, report: logs[start] };
  };
  return { directories, error, exit: proc.exitCode, logs, reads, spawns, liveCommands, logOpens, oldCheckpointUnchanged: oldCheckpointPath ? Buffer.compare(oldCheckpointBytes, files.get(oldCheckpointPath)) === 0 : undefined,
    receipt: files.get(path.join(out, ...(sameOutputStopped ? ["round-attempt-000001"] : []), "round-receipt.json")),
    sameOutputOriginal: sameOutputReceipt && { receipt: files.get(sameOutputReceipt.path), sha256: sameOutputReceipt.sha256, stdout: files.get(path.join(out, "core-and-funds.stdout.log")), stderr: files.get(path.join(out, "core-and-funds.stderr.log")), artifacts: Object.fromEntries(sameOutputArtifacts.map(name => [name, files.get(path.join(out, name))])) },
    attemptPresent: files.has(attemptPath), inspectCurrent };
}

test("round validation and execution require the exact strict reservation before output", async () => {
  for (const invalid of [{ reservationStatus: null }, { reservationStatus: "ROUND03_BOOTSTRAP_RESERVED" }, { drift: { manifestSha256: "wrong" } }, { drift: { epoch: { ...epoch, oid: "43" } } }, { drift: { epoch: { ...epoch, nonce: "wrong" } } }]) {
    const r = await round(invalid);
    assert.match(r.error.message, /STRICT_BATCH_REQUIRES_REGISTERED_ROUND|FRESH_REGISTERED_RESOURCE/);
    assert.deepEqual(r.directories, []);
    assert.deepEqual(r.spawns, []);
  }
  for (const options of [{ action: "validate" }, { action: "validate", strict: false, reservationStatus: null }]) {
    const valid = await round(options);
    assert.ifError(valid.error);
    assert.equal(valid.logs[0].status, "SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN");
    assert.deepEqual(valid.directories, []);
    assert.deepEqual(valid.spawns, []);
  }
});

test("prewrite retry preserves original input and demands independently confirmed zero writes", () => {
  const originalInput = { schema: "zzsh.local-round.v1", out: "original", target: { oid: "42", nonce: "nonce" }, actor: { sha256: "actor" }, window: { expiresAt: "original" } };
  const input = { ...originalInput, out: "retry", retryEvidence: { schema: "zzsh.local-round-no-write-retry.v1", originalInput: { sha256: "a" }, originalReceipt: { sha256: "b" } } };
  const originalReceipt = { inputSha256: "a", status: "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS", stages: [{ name: "core-and-funds", status: "INTENT", code: 1 }], toolFiles: { "load-local-dataset.mjs": "loader" } };
  const audit = { status: "NO_WRITES_CONFIRMED_FOR_FAILED_ATTEMPT", originalReceiptSha256: "b", loaderSha256: "loader", moduleFailureBeforeCredentialAndPool: true,
    loaderDirectoryCreated: false, targetWrites: 0, rollbackAck: true, clientClosed: true, unlockAck: true, maintenanceClosed: true,
    counts: Object.fromEntries(["legacy_users", "legacy_accounts", "legacy_orders", "finance_observations", "opening_basis", "ledger_entries", "economic_roots", "growth_coverage"].map(key => [key, 0])) };
  assert.equal(assertNoWriteRetryLineage({ input, originalInput, originalReceipt, audit }).status, "ORIGINAL_PREWRITE_FAILURE_CONFIRMED");
  for (const change of [{ input: { ...input, actor: { sha256: "different" } } }, { audit: { ...audit, counts: { ...audit.counts, legacy_users: 1 } } },
    { audit: { ...audit, unlockAck: false } }, { originalReceipt: { ...originalReceipt, stages: [{ name: "core-and-funds", status: "ACK", code: 0 }] } }])
    assert.throws(() => assertNoWriteRetryLineage({ input, originalInput, originalReceipt, audit, ...change }), /ROUND_NO_WRITE_RETRY_LINEAGE_CHANGED/);
});

test("R06 round validation accepts its exact reservation and rejects target or source drift", async () => {
  const valid = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", action: "validate" });
  assert.ifError(valid.error);
  assert.equal(valid.logs[0].status, "SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN");
  assert.deepEqual(valid.spawns, []);
  const nonStrict = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", action: "validate", strict: false });
  assert.match(nonStrict.error.message, /ROUND06_STRICT_BATCH_REQUIRED/);
  assert.deepEqual(nonStrict.spawns, []);
  const wrongSchema = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", action: "validate", bootstrapDrift: "schema" });
  assert.match(wrongSchema.error.message, /ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH:schema/);
  for (const dependencyDrift of ["missing", "proof", "runner", "closure"]) {
    const invalid = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", action: "validate", dependencyDrift });
    assert.match(invalid.error.message, /ROUND_DEPENDENCY_(BINDING_REQUIRED|PROOF_CHANGED|RUNNER_CHANGED|CLOSURE_CHANGED)/);
    assert.deepEqual(invalid.spawns, []);
  }
  for (const drift of [{ manifestSha256: "wrong" }, { epoch: { ...epoch, oid: "43" } }, { epoch: { ...epoch, nonce: "wrong" } }]) {
    const r = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", drift, action: "validate" });
    assert.match(r.error.message, /FRESH_REGISTERED_RESOURCE/);
    assert.deepEqual(r.spawns, []);
  }
});

test("R07 fresh-schema inputs require the same isolated instance and dependency closure", async () => {
  const instance={host:"127.0.0.1",port:55433,systemIdentifier:"123"};
  const valid=await round({reservationStatus:"ROUND07_BOOTSTRAP_RESERVED",action:"validate",instance});
  assert.ifError(valid.error);assert.equal(valid.logs[0].status,"SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN");assert.deepEqual(valid.spawns,[]);
  const noDependencies=await round({reservationStatus:"ROUND07_BOOTSTRAP_RESERVED",action:"validate",instance,dependencyDrift:"missing"});
  assert.match(noDependencies.error.message,/ROUND_DEPENDENCY_BINDING_REQUIRED/);assert.deepEqual(noDependencies.spawns,[]);
  const nonStrict=await round({reservationStatus:"ROUND07_BOOTSTRAP_RESERVED",action:"validate",instance,strict:false});
  assert.match(nonStrict.error.message,/ROUND07_STRICT_BATCH_REQUIRED/);assert.deepEqual(nonStrict.spawns,[]);
});

test("round stops at a failed loader and never spawns later stages", async () => {
  const r = await round();
  assert.ifError(r.error);
  assert.equal(r.exit, 1);
  assert.equal(r.spawns.length, 1);
  assert.ok(r.spawns[0].includes("--strict-round-batch"));
  const receipt = JSON.parse(r.receipt);
  assert.equal(receipt.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
  assert.equal(receipt.failure.stage, "core-and-funds");
  assert.equal(receipt.completion.status, "INCOMPLETE");
  assert.equal(receipt.completion.growth, "NOT_PLANNED");
});

test("same-directory recovery keeps the prior receipt and writes exclusive attempt logs", async () => {
  const result = await round({ sameOutputStopped: true });
  assert.ifError(result.error);
  assert.equal(result.exit, 1);
  assert.equal(sha(result.sameOutputOriginal.receipt), result.sameOutputOriginal.sha256);
  assert.equal(result.sameOutputOriginal.stdout.toString(), "old stdout");
  assert.equal(result.sameOutputOriginal.stderr.toString(), "old stderr");
  const resumed = JSON.parse(result.receipt);
  assert.equal(resumed.sameDirectoryResume.previousReceipt.sha256, result.sameOutputOriginal.sha256);
  assert.equal(resumed.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
  assert.equal(result.logOpens.length, 2);
  assert.ok(result.logOpens.every(item => item.flags === "wx" && item.file.includes("round-attempt-000001")));
});

test("same-directory recovery stops before any spawn after paths and readback succeeded and growth failed", async () => {
  const stages = ["core-and-funds", "display", "opening", "holdings", "paths", "readback"].map(name => ({ name, status: "ACK" }));
  stages.push({ name: "growth-prepare", status: "INTENT" });
  const result = await round({ sameOutputStopped: true, sameOutputStages: stages, sameOutputArtifacts: ["path-execution", "readback.json", "growth-plan"] });
  assert.match(result.error.message, /ROUND_SAME_OUTPUT_STAGE_REQUIRES_SEPARATE_RECOVERY/);
  assert.deepEqual(result.spawns, []);
  assert.deepEqual(result.directories, []);
  assert.equal(sha(result.sameOutputOriginal.receipt), result.sameOutputOriginal.sha256);
  assert.equal(result.sameOutputOriginal.artifacts["readback.json"].toString(), "old readback.json");
  assert.equal(result.sameOutputOriginal.artifacts["path-execution"].toString(), "old path-execution");
  assert.equal(result.sameOutputOriginal.stdout.toString(), "old stdout");
});

test("same-directory recovery refuses an existing later-stage artifact even if the receipt has no later stage", async () => {
  const result = await round({ sameOutputStopped: true, sameOutputArtifacts: ["readback.json"] });
  assert.match(result.error.message, /ROUND_SAME_OUTPUT_ARTIFACT_REQUIRES_SEPARATE_RECOVERY:readback\.json/);
  assert.deepEqual(result.spawns, []);
  assert.deepEqual(result.directories, []);
  assert.equal(result.sameOutputOriginal.artifacts["readback.json"].toString(), "old readback.json");
  assert.equal(sha(result.sameOutputOriginal.receipt), result.sameOutputOriginal.sha256);
});

test("missing or cross-target bootstrap evidence stops before output and execution", async () => {
  for (const options of [{ missingBootstrap: true }, ...["runtime", "swap", "schema", "staff", "bosses", "business", "readback", "bundle", "digest"].map(bootstrapDrift => ({ bootstrapDrift })), { bootstrapDrift: "policy", withGrowth: true }, { bootstrapDrift: "boss-origin", separateBossBinding: true }]) {
    const r = await round(options);
    assert.match(r.error.message, /ROUND_BOOTSTRAP_EVIDENCE_REQUIRED|ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH|ROUND_INPUT_SHA_MISMATCH/);
    assert.deepEqual(r.directories, []);
    assert.deepEqual(r.spawns, []);
  }
  const valid = await round({ action: "validate", withGrowth: true });
  assert.ifError(valid.error);
  assert.equal(valid.logs[0].growthPlanned, true);
  const reuseBoss = await round({ action: "validate", separateBossBinding: true });
  assert.ifError(reuseBoss.error);
  assert.equal(reuseBoss.logs[0].bootstrapEvidence.status, "TARGET_BOUND_BOOTSTRAP_EVIDENCE_VERIFIED");
});

function completedEvidence() {
  const inputSha256 = "e".repeat(64), datasetSha = "f".repeat(64), manifestSha = "1".repeat(64);
  const target = { ...epoch, schemaHashes: schema };
  const input = { target, dataset: { sha256: datasetSha }, window, strictBatch: true, buildFiles: { "one.js": "2".repeat(64) },
    growth: { policyId: "policy-1", policyEffectiveAt: "2026-01-01T00:00:00.000Z" } };
  const actorProof = { id: "test-user", sessionId: "test-session" };
  const dataset = { sourceCutoff: "2026-01-01T00:00:00.000Z", domains: { users: { ready: 2 }, accounts: { ready: 2 }, orders: { ready: 2 }, continuations: { parameterComplete: 1 } } };
  const expected = { dataset, display: { rows: 2 }, openings: { stats: { candidate: 2 } }, paths: { accounts: 2 } };
  const names = ["core-and-funds", "display", "opening", "holdings", "paths", "readback", "growth-prepare", "growth-apply", "growth-readback"];
  const receipt = { schema: "zzsh.local-round-receipt.v1", inputSha256, datasetSha256: datasetSha, target, strictBatch: true,
    status: "DATASET_AND_GROWTH_ACK_READBACK_PASS", stages: names.map(name => ({ name, status: "ACK", code: 0, signal: null, metrics: {} })) };
  const phases = Object.fromEntries(["users", "accounts", "orders", "invitationFacts", "financeHistory", "financeEmptyCoverage", "guaranteeHistory", "continuationEvidence", "liabilityDuties", "completedCommissions", "accountDisplay", "storedOpening", "skinHoldings"].map(name => [name, { complete: true, quarantined: 0, nextIndex: 2 }]));
  phases.continuationEvidence.nextIndex = 1;
  const checkpoint = { schema: "zzsh.local-legacy-load.v1", binding: { ...epoch, database: "zzsh_test_regression", datasetSha256: datasetSha, actorId: actorProof.id, sessionId: actorProof.sessionId },
    strictBatch: true, schemaHashes: schema, executionWindow: window, pending: null, status: "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED", phases, poolClosed: true, unlock: true, maintenanceClosed: true, rollbackConfirmed: true,
    skinHoldingsPreparation: { ready: 2, isolated: 0 } };
  const readback = { schema: "zzsh.local-dataset-readback.v1", resource: { ...epoch, database: "zzsh_test_regression" }, sourceDatasetSha256: datasetSha,
    status: "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED", differenceCount: 0, targetWrites: 0, rollbackConfirmed: true, lockReleased: true, connectionsClosed: true,
    domains: { users: { expected: 2 }, accounts: { expected: 2 }, orders: { expected: 2 } },
    display: { expected: 2, matched: 2 }, openings: { expected: 2, matched: 2 }, holdings: { expected: 2, matched: 2 }, paths: { expected: 2, matched: 2 } };
  const summary = { users: 2, orders: 2, complete: 1, pending: 1, contributions: 3 };
  const shared = { ...epoch, inputSha256, datasetSha256: datasetSha, manifestSha256: manifestSha };
  const growth = { manifestSha256: manifestSha,
    prepare: { ...shared, mode: "--prepare", status: "PREPARED_NOT_APPLIED", readOnlyRollbackAck: true, readOnlyClientClosed: true, summary },
    manifest: { ...epoch, schema: "zzsh.local-growth-round-plan.v1", status: "PREPARED_NOT_APPLIED", datasetSha256: datasetSha, policy: { id: "policy-1", effectiveAt: input.growth.policyEffectiveAt }, cutoff: "2026-01-01T00:00:00.000000Z", buildDigest: sha(JSON.stringify(input.buildFiles)), packages: [
      { file: "packages/00001.json", userId: "user-1", executionKey: "key-1", sha256: "3".repeat(64), coverageFingerprint: "4".repeat(64), coverageState: "COMPLETE", contributionCount: 2 },
      { file: "packages/00002.json", userId: "user-2", executionKey: "key-2", sha256: "5".repeat(64), coverageFingerprint: "6".repeat(64), coverageState: "BACKFILL_PENDING", contributionCount: 1 },
    ], summary },
    apply: { ...shared, mode: "--apply", status: "APPLIED_COMMIT_ACK_INDEPENDENT_READBACK_REQUIRED", poolClosed: true, unlockAck: true, lockClosed: true, completed: 2, inserted: 3, replayed: 0, complete: 1, partial: 1, pending: null, fundsWrites: 0 },
    readback: { ...shared, mode: "--readback", status: "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED", readOnlyRollbackAck: true, readOnlyClientClosed: true, fundsWrites: 0,
      summary: { coverage: 2, contributions: 3, complete: 1, pending: 1 } } };
  return { input, inputSha256, actorProof, receipt, checkpoint, readback, expected, growth };
}

test("full completion requires actual stage acknowledgements, target checkpoints and independent growth readback", () => {
  const data = completedEvidence();
  assert.deepEqual(assessRoundEvidence(data), { status: "COMPLETE", dataset: "PASS", growth: "PASS", issues: [] });
  const cases = [
    ["ROUND_STAGE_NOT_ACKNOWLEDGED:opening", d => { d.receipt.stages[2].status = "INTENT"; d.receipt.stages[2].code = 1; }],
    ["ROUND_STAGE_NOT_ACKNOWLEDGED:paths", d => { delete d.receipt.stages[4].code; }],
    ["ROUND_PHASE_INCOMPLETE:storedOpening", d => { d.checkpoint.phases.storedOpening.complete = false; }],
    ["ROUND_CHECKPOINT_UNCONFIRMED", d => { d.checkpoint.pending = { stage: "COMMIT_UNKNOWN" }; }],
    ["ROUND_CHECKPOINT_UNCONFIRMED", d => { d.checkpoint.status = "UNKNOWN_STATUS"; }],
    ["ROUND_CHECKPOINT_UNCONFIRMED", d => { d.checkpoint.schemaHashes = ["3".repeat(64)]; }],
    ["ROUND_DATASET_READBACK_UNCONFIRMED", d => { d.readback.resource.oid = "43"; }],
    ["ROUND_GROWTH_PREPARE_UNCONFIRMED", d => { d.growth.manifestSha256 = "2".repeat(64); }],
    ["ROUND_GROWTH_PREPARE_UNCONFIRMED", d => { d.growth.manifest.buildDigest = "3".repeat(64); }],
    ["ROUND_GROWTH_PREPARE_UNCONFIRMED", d => { d.growth.manifest.cutoff = "2026-02-01T00:00:00.000000Z"; }],
    ["ROUND_GROWTH_PREPARE_UNCONFIRMED", d => { d.growth.manifest.packages[1].executionKey = "key-1"; }],
    ["ROUND_GROWTH_APPLY_UNCONFIRMED", d => { d.growth.apply.completed = 1; }],
    ["ROUND_GROWTH_READBACK_UNCONFIRMED", d => { d.growth.readback = null; }],
    ["ROUND_STAGE_ORDER_INVALID:growth-prepare", d => { const s = d.receipt.stages.splice(6, 1)[0]; d.receipt.stages.splice(0, 0, s); }],
  ];
  for (const [issue, change] of cases) {
    const d = structuredClone(data); change(d);
    const result = assessRoundEvidence(d);
    assert.equal(result.status, "INCOMPLETE", issue);
    assert.ok(result.issues.includes(issue), `${issue}: ${result.issues}`);
  }
});

test("whole-user migration cannot report completion without invitation count closure and independent readback",()=>{
  const data=completedEvidence(),dataset=data.expected.dataset;
  dataset.population={mode:"SELECTED_BUSINESS_SCOPE"};dataset.domains.users={source:2,ready:2,isolated:0};
  dataset.invitationFacts={subjects:2,codes:2,selectedSubjects:2,packets:2,selectedPackets:2,policy:null,financialEffects:false};
  dataset.files={"invitation-facts":{rows:2}};
  data.checkpoint.phases.invitationCounts={complete:true,quarantined:0,nextIndex:2};
  data.readback.invitationFacts={childCountClosure:{status:"VERIFIED",packets:2,auditsMatched:2,subjects:2,known:1,unknown:1,matched:2}};
  data.expected.display.accountBaseRatio={scope:"ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT",known:data.expected.display.rows,unknown:0};
  data.readback.display.accountBaseRatio={status:"VERIFIED",scope:"ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT",expected:data.expected.display.rows,matched:data.expected.display.rows,known:data.expected.display.rows,unknown:0};
  data.expected.display.accountFullPayout={scope:"ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT",selected:0,unselected:data.expected.display.rows,unknown:0};
  data.readback.display.accountFullPayout={status:"VERIFIED",scope:"ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT",expected:data.expected.display.rows,matched:data.expected.display.rows,selected:0,unselected:data.expected.display.rows,unknown:0};
  assert.equal(assessRoundEvidence(data).status,"COMPLETE");
  const missing=structuredClone(data);delete missing.checkpoint.phases.invitationCounts;
  assert(assessRoundEvidence(missing).issues.includes("ROUND_INVITATION_COUNT_CLOSURE_INCOMPLETE"));
  const unverified=structuredClone(data);unverified.readback.invitationFacts.childCountClosure.auditsMatched=1;
  assert(assessRoundEvidence(unverified).issues.includes("ROUND_INVITATION_COUNT_READBACK_UNCONFIRMED"));
  const ratio=structuredClone(data);ratio.readback.display.accountBaseRatio.matched--;
  assert(assessRoundEvidence(ratio).issues.includes("ROUND_ACCOUNT_CAPTURE_RATIO_READBACK_UNCONFIRMED"));
  const payout=structuredClone(data);payout.readback.display.accountFullPayout.unselected--;
  assert(assessRoundEvidence(payout).issues.includes("ROUND_ACCOUNT_CAPTURE_PAYOUT_READBACK_UNCONFIRMED"));
  const missingUsers=structuredClone(data);missingUsers.expected.dataset.domains.users.ready=1;
  assert(assessRoundEvidence(missingUsers).issues.includes("ROUND_INVITATION_SCOPE_UNPROVEN"));
});

test("R07 accepts an excluded guarantee only with an empty source plan and independent target proof", () => {
  const d=completedEvidence();d.input.target.bootstrapReservation="ROUND07_BOOTSTRAP_RESERVED";delete d.checkpoint.phases.guaranteeHistory;
  d.checkpoint.fundsSupplement={coverage:{guarantees:{policyExcluded:true,selected:0,planned:0,writer:0,listingDeposit:{targetRows:0}}}};
  d.checkpoint.generatedPhases={guaranteeHistory:{rows:0,sha256:sha("[]")},financeEmptyCoverage:{schema:"zzsh.empty-coverage-chunks.v1",rows:2,chunks:[{},{}]}};
  d.readback.ownerGuaranteeHistory={policyExcluded:true,expected:0,actual:0};
  d.readback.emptyFinancialCoverage={sourceRebuilt:true,expected:2,readable:2,actual:2,chunks:2};
  assert.deepEqual(assessRoundEvidence(d),{status:"COMPLETE",dataset:"PASS",growth:"PASS",issues:[]});
  for(const change of [x=>{x.checkpoint.fundsSupplement.coverage.guarantees.writer=1},x=>{x.checkpoint.generatedPhases.guaranteeHistory.sha256="0".repeat(64)},x=>{x.checkpoint.generatedPhases.guaranteeHistory.rows=1}]){
    const bad=structuredClone(d);change(bad);assert(assessRoundEvidence(bad).issues.includes("ROUND_PHASE_INCOMPLETE:guaranteeHistory"));
  }
  const badReadback=structuredClone(d);badReadback.readback.ownerGuaranteeHistory.actual=1;
  assert(assessRoundEvidence(badReadback).issues.includes("ROUND_GUARANTEE_EXCLUSION_READBACK_UNCONFIRMED"));
  const badChunks=structuredClone(d);badChunks.readback.emptyFinancialCoverage.sourceRebuilt=false;
  assert(assessRoundEvidence(badChunks).issues.includes("ROUND_EMPTY_COVERAGE_READBACK_UNCONFIRMED"));
});

test("every growth package is checked before apply, including later missing or changed packages", () => {
  const bytes = [Buffer.from("first"), Buffer.from("second")];
  const manifest = { packages: bytes.map((value, index) => ({ file: `packages/0000${index + 1}.json`, sha256: sha(value) })) };
  assert.doesNotThrow(() => assertGrowthPackages(manifest, file => bytes[file.includes("00001") ? 0 : 1]));
  assert.throws(() => assertGrowthPackages(manifest, file => file.includes("00001") ? bytes[0] : Buffer.from("changed")), /ROUND_GROWTH_PACKAGE_SHA_MISMATCH/);
  assert.throws(() => assertGrowthPackages(manifest, file => { if (file.includes("00002")) throw Error("missing package"); return bytes[0]; }), /missing package/);
});

test("dataset-only success and a manually resumed receipt cannot claim complete growth", () => {
  const data = completedEvidence();
  delete data.input.growth;
  data.receipt.stages = data.receipt.stages.slice(0, 6);
  let result = assessRoundEvidence(data);
  assert.deepEqual(result, { status: "INCOMPLETE", dataset: "PASS", growth: "NOT_PLANNED", issues: ["ROUND_GROWTH_NOT_PLANNED"] });
  const resumed = completedEvidence();
  resumed.receipt.status = "DATASET_STAGES_ACK_READBACK_PASS";
  resumed.receipt.stages = resumed.receipt.stages.slice(0, 6);
  resumed.receipt.stages[2] = { name: "opening", status: "INTENT", code: 1 };
  for (const index of [3, 4, 5]) delete resumed.receipt.stages[index].code;
  result = assessRoundEvidence(resumed);
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.growth, "INCOMPLETE");
  assert.ok(result.issues.includes("ROUND_STAGE_NOT_ACKNOWLEDGED:opening"));
  assert.ok(result.issues.includes("ROUND_STAGE_NOT_ACKNOWLEDGED:growth-prepare"));
});

test("receipt inspection is offline, read-only, and reports cross-target bootstrap and missing stages", async () => {
  const r = await round({ action: "inspect-receipt", bootstrapDrift: "staff" });
  assert.ifError(r.error);
  assert.equal(r.exit, 1);
  assert.equal(r.logs[0].status, "INCOMPLETE");
  assert.equal(r.logs[0].bootstrap, "INCOMPLETE");
  assert.equal(r.logs[0].bootstrapReason, "ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH:staff");
  assert.equal(r.logs[0].growth, "NOT_PLANNED");
  assert.ok(r.logs[0].issues.includes("ROUND_BOOTSTRAP_EVIDENCE_UNCONFIRMED"));
  assert.deepEqual(r.directories, []);
  assert.deepEqual(r.spawns, []);
  assert.ok(!r.reads.includes(credentials));
});

test("corrupt and unreadable artifacts never hide the original stopped stage or prevent its receipt", async () => {
  for (const artifactFault of [
    { file: "loader/checkpoint.json", kind: "json", label: "checkpoint" },
    { file: "readback.json", kind: "null", label: "readback" },
    { file: "growth-plan/manifest.json", kind: "array", label: "growth-manifest" },
    { file: "loader/checkpoint.json", kind: "read-error", label: "checkpoint" },
  ]) {
    const r = await round({ withGrowth: true, artifactFault });
    assert.ifError(r.error);
    assert.equal(r.exit, 1);
    const receipt = JSON.parse(r.receipt);
    assert.equal(receipt.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
    assert.equal(receipt.failure.stage, "core-and-funds");
    assert.match(receipt.failure.message, /ROUND_STAGE_STOPPED/);
    assert.equal(receipt.completion.status, "INCOMPLETE");
    assert.ok(receipt.completion.issues.includes("ROUND_ARTIFACT_UNREADABLE:" + artifactFault.label));
  }
  const inspected = await round({ action: "inspect-receipt", artifactFault: { file: "readback.json", kind: "json" } });
  assert.ifError(inspected.error);
  assert.equal(inspected.logs[0].status, "INCOMPLETE");
  assert.ok(inspected.logs[0].issues.includes("ROUND_ARTIFACT_UNREADABLE:readback"));
});

test("null and malformed stage entries are incomplete rather than an assessment exception", () => {
  const d = completedEvidence();
  d.receipt.stages[0] = null;
  d.receipt.stages[1] = "invalid";
  d.expected.dataset = null;
  const result = assessRoundEvidence(d);
  assert.equal(result.status, "INCOMPLETE");
  assert.ok(result.issues.includes("ROUND_STAGE_NOT_ACKNOWLEDGED:core-and-funds"));
  assert.ok(result.issues.includes("ROUND_STAGE_NOT_ACKNOWLEDGED:display"));
});

test("growth-only continuation preserves original failure/checkpoint and proves data before and after new growth", async () => {
  const r = await round({ action: "resume-growth", resumeCase: "success" });
  assert.ifError(r.error);
  assert.equal(r.exit, undefined, r.receipt?.toString());
  assert.equal(r.oldCheckpointUnchanged, true);
  const receipt = JSON.parse(r.receipt);
  assert.equal(receipt.mode, "RESUME_GROWTH");
  assert.equal(receipt.status, "DATASET_AND_GROWTH_REVALIDATED_PASS");
  assert.equal(receipt.completion.status, "COMPLETE");
  assert.equal(receipt.prior.proof.status, "ORIGINAL_COMPLETE_CHECKPOINT_BOUND");
  assert.deepEqual(receipt.stages.map(s => s.name), ["schema-preflight", "readback", "growth-prepare", "growth-attempt-reservation", "growth-apply", "growth-readback", "readback-final"]);
  assert.equal(r.attemptPresent, true);
  assert.equal(receipt.stages.some(s => s.name === "opening"), false);
  assert.equal(r.spawns.some(args => args[0].endsWith("load-local-dataset.mjs") || args[0].endsWith("load-legacy-path-accounts.mjs")), false);
  assert.equal(r.liveCommands[0], "connect");
  assert.equal(r.liveCommands.at(-2), "ROLLBACK"); assert.equal(r.liveCommands.at(-1), "end");
  const inspected = await r.inspectCurrent();
  assert.ifError(inspected.error); assert.equal(inspected.report.status, "COMPLETE");
  assert.equal(inspected.report.evidenceOnly, true); assert.equal(inspected.report.targetConnections, 0);
  const stages = structuredClone(receipt), input = { resume: structuredClone(receipt.prior) };
  assert.equal(assessResumeStages(stages, input).status, "COMPLETE");
  stages.prior.previousReceipt.sha256 = "0".repeat(64);
  assert.ok(assessResumeStages(stages, input).issues.includes("ROUND_RESUME_RECEIPT_LINEAGE_MISMATCH"));
});

test("growth-only continuation rejects unproven lineage and unknown commits before output", async () => {
  for (const resumeCase of ["unknown", "missing-phase", "different-source", "fabricated-receipt", "prior-growth-stage", "prior-attempt"]) {
    const r = await round({ action: "resume-growth", resumeCase });
    assert.ok(r.error, resumeCase);
    assert.equal(r.oldCheckpointUnchanged, true);
    assert.deepEqual(r.directories, []); assert.deepEqual(r.spawns, []); assert.deepEqual(r.liveCommands, []);
  }
});

test("growth-only continuation does not write growth when live schema or initial readback is unproven", async () => {
  for (const resumeCase of ["schema-drift", "schema-target-drift", "schema-drift-rollback-fail", "schema-rollback-fail", "schema-close-fail", "readback-fail", "growth-prepare-fail", "growth-prepare-bad-manifest", "bad-package", "checkpoint-drift", "reservation-race", "reservation-fsync-fail"]) {
    const r = await round({ action: "resume-growth", resumeCase });
    assert.ifError(r.error);
    assert.equal(r.exit, 1);
    const receipt = JSON.parse(r.receipt);
    assert.equal(receipt.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
    assert.equal(receipt.completion.status, "INCOMPLETE");
    assert.equal(r.spawns.some(args => args[0].endsWith("run-local-growth.mjs") && args.includes("--apply")), false, resumeCase);
    if (resumeCase !== "checkpoint-drift") assert.equal(r.oldCheckpointUnchanged, true);
    else assert.ok(receipt.completion.issues.includes("ROUND_ARTIFACT_CHANGED:checkpoint"));
    if (resumeCase.endsWith("rollback-fail")) assert.deepEqual(receipt.failure.readOnlyCleanup, { rollbackAck: false, closed: true });
    if (resumeCase === "schema-close-fail") assert.deepEqual(receipt.failure.readOnlyCleanup, { rollbackAck: true, closed: false });
    if (resumeCase === "reservation-fsync-fail") assert.equal(r.attemptPresent, true);
    if (resumeCase === "bad-package") assert.equal(r.attemptPresent, false);
  }
});

test("final readback failure keeps the committed growth stage visible without claiming complete", async () => {
  const r = await round({ action: "resume-growth", resumeCase: "final-readback-fail" });
  assert.ifError(r.error); assert.equal(r.exit, 1); assert.equal(r.oldCheckpointUnchanged, true);
  const receipt = JSON.parse(r.receipt);
  assert.equal(receipt.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
  assert.equal(receipt.failure.stage, "readback-final");
  assert.equal(receipt.stages.find(s => s.name === "growth-apply").status, "ACK");
  assert.equal(receipt.completion.status, "INCOMPLETE");
  const corrupted = await round({ action: "resume-growth", resumeCase: "before-corrupt" });
  assert.ifError(corrupted.error); assert.equal(corrupted.exit, 1);
  const corruptedReceipt = JSON.parse(corrupted.receipt);
  assert.equal(corruptedReceipt.completion.status, "INCOMPLETE");
  assert.ok(corruptedReceipt.completion.issues.includes("ROUND_RESUME_INITIAL_READBACK_UNCONFIRMED"));
  const changed = await round({ action: "resume-growth", resumeCase: "summary-drift" });
  assert.ifError(changed.error); assert.equal(changed.exit, 1);
  assert.ok(JSON.parse(changed.receipt).completion.issues.includes("ROUND_RESUME_STAGE_EVIDENCE_CHANGED:growth-apply"));
});
