import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { win32 as path } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import test from "node:test";
import { matchesLoadReservation, strictRoundReservation } from "./local-load-checkpoint.mjs";

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

async function load({ failure, strict = true, reservation = {}, previous, recover = false, exitAfterUsers = false } = {}) {
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
  put(manifest, { status: "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN", gameBindings: {}, files: fileEntries });
  put(fundsReceipt, {});
  const migration = { name: "test_migration", oid: "91", password: "test" };
  const registration = { ...epoch, database: "zzsh_test_regression", roles: { migration }, ...(strict ? { protectedDataset: {
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
    recover ? "--recover" : "--execute", ...(strict ? ["--strict-round-batch"] : []), ...(failure === "empty-coverage" ? ["--refund-attempts", funds, "--refund-attempts-sha", sha(get(fundsReceipt))] : ["--core-only"]), "--dataset", ds, "--dataset-sha", sha(get(manifest)),
    "--credentials", credentials, "--out", out, "--oid", epoch.oid, "--nonce", epoch.nonce, "--actor-id", "test-user", "--session-id", "test-session",
    "--schema-binding", JSON.stringify(schema), "--execution-window", JSON.stringify(window), "--funds-source", funds, "--funds-source-sha", sha(get(fundsReceipt)),
  ] };
  let commitAck = false, diskFailed = false;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      if (sql.startsWith("SELECT d.oid")) return { rows: [{ ...epoch, owner: "zzsh", marker: "zzsh:regression-test:v1", role: migration.name, role_oid: migration.oid }] };
      if (sql.startsWith("SELECT hash")) return { rows: schema.map(hash => ({ hash })) };
      if (sql.startsWith("SELECT EXISTS")) return { rows: [{ occupied: false }] };
      commands.push(sql);
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
    ...path, createHash, matchesLoadReservation, strictRoundReservation, process: proc, moduleUrl: "fixture", fileURLToPath: () => "C:\\project\\scripts\\migration\\load-local-dataset.mjs",
    financialFixture: () => ({ applyFinancialDomains: ctx => ctx.runItems("financeEmptyCoverage", [{ sourceId: "empty-original" }], () => { throw Object.assign(Error("coverage rejected"), { status: 409 }); }) }),
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
  assert.equal(r.exit, undefined);
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

async function round({ reservationStatus = strictRoundReservation, action = "execute", drift, strict = true } = {}) {
  const files = new Map(), directories = [], spawns = [], logs = [];
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
  const dataset = pinned("dataset", { sourceReceiptSha256: source.sha256, domains: { accounts: { ready: 0 }, users: { ready: 0 } } });
  const pathSourcePlan = pinned("paths-source", {}, "receipt.json");
  const apiDist = "C:\\project\\dist", buildFiles = {};
  for (const file of ["database/business-migrations.js", "supply/legacy-user-migration.js", "legacy-load/legacy-account-seam.js", "order/legacy-order-read.js", "finance/personal-finance-maintenance.js", "legacy-load/legacy-path-records.js"]) buildFiles[file] = put(path.join(apiDist, file), {}).sha256;
  const secretRoot = "E:\\zzsh\\zzsh\\apps\\api\\.secrets";
  const input = put(path.join(restricted, "round-input.json"), {
    schema: "zzsh.local-round.v1", window, credentials, target: { ...epoch, bootstrapReservation: strictRoundReservation, schemaHashes: schema, migrationRoleOid: "91" },
    out, apiDist, buildFiles, strictBatch: strict, dataset, source, pathSourcePlan,
    paths: pinned("paths", { sourcePlanReceiptSha256: pathSourcePlan.sha256, datasetSha256: dataset.sha256, accounts: 0 }, "receipt.json"),
    display: pinned("display", { datasetSha256: dataset.sha256, rows: 0, notDisplayable: 0 }),
    openings: pinned("opening", { datasetSha256: dataset.sha256, stats: { subjects: 0 } }),
    funds: pinned("funds", supplement, "receipt.json"), refundAttempts: pinned("refund", supplement, "receipt.json"), dictionary: pinned("dictionary", {}, "receipt.json"),
    actor: put(path.join(restricted, "actor.json"), { id: "test-user", sessionId: "test-session" }),
    secrets: { databaseMaintenance: put(path.join(secretRoot, "db"), "fixture"), identitySubjectHmac: put(path.join(secretRoot, "hmac"), "fixture") },
  });
  put(registry, { ...epoch, database: "zzsh_test_regression", roles: { migration: { oid: "91" } },
    ...(reservationStatus ? { protectedDataset: { status: reservationStatus, manifestSha256: dataset.sha256, epoch, ...drift } } : {}) });
  const proc = { env: {}, execPath: "node", exit() { throw "EXIT"; }, argv: ["node", "script", "--" + action, "--input", input.path, "--input-sha", input.sha256] };
  const context = {
    ...path, assert, createHash, matchesLoadReservation, strictRoundReservation, process: proc, moduleUrl: "file:///C:/project/scripts/migration/run-local-round.mjs",
    fileURLToPath: url => path.normalize(String(url).slice("file:///".length)),
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }), existsSync: file => files.has(file), mkdirSync: file => directories.push(file),
    readFileSync(file) { return files.get(file) ?? Buffer.from("fixture-tool"); }, readdirSync: () => Object.keys(buildFiles),
    spawnSync: () => ({ stdout: "S-1-5-21-1", status: 0 }),
    spawn(_node, args) { spawns.push(args); return { once(event, callback) { if (event === "close") callback(1, null); } }; },
    openSync: () => 1, closeSync() {}, writeLoadCheckpoint: put, console: { log: value => logs.push(JSON.parse(value)) },
  };
  let error;
  try { await new AsyncFunction(...Object.keys(context), script("run-local-round.mjs"))(...Object.values(context)); }
  catch (cause) { if (cause !== "EXIT") error = cause; }
  return { directories, error, exit: proc.exitCode, logs, spawns, receipt: files.get(path.join(out, "round-receipt.json")) };
}

test("round validation and execution require the exact strict reservation before output", async () => {
  for (const invalid of [{ reservationStatus: null }, { reservationStatus: "ROUND03_BOOTSTRAP_RESERVED" }, { drift: { manifestSha256: "wrong" } }, { drift: { epoch: { ...epoch, oid: "43" } } }, { drift: { epoch: { ...epoch, nonce: "wrong" } } }]) {
    const r = await round(invalid);
    assert.match(r.error.message, /STRICT_BATCH_REQUIRES_ROUND04|FRESH_REGISTERED_RESOURCE/);
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

test("round stops at a failed loader and never spawns later stages", async () => {
  const r = await round();
  assert.ifError(r.error);
  assert.equal(r.exit, 1);
  assert.equal(r.spawns.length, 1);
  assert.ok(r.spawns[0].includes("--strict-round-batch"));
  const receipt = JSON.parse(r.receipt);
  assert.equal(receipt.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
  assert.equal(receipt.failure.stage, "core-and-funds");
});
