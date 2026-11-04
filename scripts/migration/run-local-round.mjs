import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { matchesLoadReservation, strictRoundReservation, writeLoadCheckpoint } from "./local-load-checkpoint.mjs";

const args = process.argv.slice(2), option = name => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const execute = args.includes("--execute"), validate = args.includes("--validate");
assert(!(execute && validate), "ONE_ROUND_ACTION_REQUIRED");
if (!execute && !validate) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--execute or --validate", "--input", "--input-sha"], stages: ["core-and-funds", "display", "opening", "holdings", "paths", "readback"], growthWhenPolicyBound: ["growth-prepare", "growth-apply", "growth-readback"], prerequisites: ["fresh registered regression database", "formal admin and business reference initialization", "bound source and derived packages"], connections: 0, credentialReads: 0 }));
  process.exit(0);
}
const started = performance.now(), sha = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => JSON.parse(readFileSync(file)), restricted = resolve("E:/zzsh-local-state/restricted");
function privatePath(path, output = false) {
  assert(typeof path === "string" && isAbsolute(path), "ROUND_PRIVATE_PATH_REQUIRED");
  path = resolve(path);
  assert(path.toLowerCase().startsWith(restricted.toLowerCase() + "\\"), "ROUND_PRIVATE_PATH_REQUIRED");
  let cursor = output ? dirname(path) : path;
  for (;;) {
    assert(!lstatSync(cursor).isSymbolicLink(), "ROUND_REPARSE_POINT_REFUSED");
    if (cursor.toLowerCase() === restricted.toLowerCase()) break;
    cursor = dirname(cursor);
  }
  return path;
}
function bound(file, expected) {
  const bytes = readFileSync(file);
  assert.equal(sha(bytes), expected, "ROUND_INPUT_SHA_MISMATCH:" + basename(file));
  return JSON.parse(bytes);
}
const inputSha256 = option("--input-sha"), input = bound(privatePath(option("--input")), inputSha256);
assert.equal(input.schema, "zzsh.local-round.v1");
assert(input.window && Object.keys(input.window).every(k => ["notBefore", "expiresAt"].includes(k))
  && [input.window.notBefore, input.window.expiresAt].every(time => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time)), "ROUND_EXECUTION_WINDOW_INVALID");
assert(Date.now() >= Date.parse(input.window.notBefore) && Date.now() < Date.parse(input.window.expiresAt), "ROUND_EXECUTION_WINDOW_INACTIVE");
assert(/^[1-9]\d*$/.test(input.target.oid) && /^[a-f0-9]{24}$/.test(input.target.nonce));
assert(input.target.schemaHashes.length >= 1 && input.target.schemaHashes.every(x => /^[a-f0-9]{64}$/.test(x)));
const out = privatePath(input.out, true);
assert(!existsSync(out), "PRESERVE_ORIGINAL_ROUND_OUTPUT");
const pinned = (entry, name = "manifest.json") => bound(join(privatePath(entry.path), name), entry.sha256);
const m = pinned(input.dataset), display = pinned(input.display), openings = pinned(input.openings);
const funds = pinned(input.funds, "receipt.json"), refund = pinned(input.refundAttempts, "receipt.json");
const source = pinned(input.source, "receipt.json"), pathPlan = pinned(input.paths, "receipt.json");
pinned(input.pathSourcePlan, "receipt.json");
pinned(input.dictionary, "receipt.json");
assert.equal(m.sourceReceiptSha256, input.source.sha256);
assert.equal(funds.sourceSupplement.baseReceiptSha256, input.source.sha256);
assert.equal(refund.sourceSupplement.baseReceiptSha256, input.source.sha256);
assert.equal(source.status, "CAPTURED_READ_ONLY");
for (const plan of [display, openings, pathPlan]) assert.equal(plan.datasetSha256, input.dataset.sha256);
assert.equal(pathPlan.sourcePlanReceiptSha256, input.pathSourcePlan.sha256);
assert.equal(display.rows + display.notDisplayable, m.domains.accounts.ready);
assert.equal(pathPlan.accounts, m.domains.accounts.ready);
assert.equal(openings.stats.subjects, m.domains.users.ready);
if (input.holdingOverlay) bound(privatePath(input.holdingOverlay.path), input.holdingOverlay.sha256);
const actorFile = privatePath(input.actor.path), actorProof = bound(actorFile, input.actor.sha256);
const actor = { id: actorProof.id ?? actorProof.actorId, sessionId: actorProof.sessionId };
assert(actor.id && actor.sessionId && (!actorProof.actorId || actor.id === actorProof.actorId), "ONE_BOUND_ADMIN_ACTOR_REQUIRED");
const secretRoot = resolve("E:/zzsh/zzsh/apps/api/.secrets");
const secretFiles = { databaseMaintenance: "DB_PASSWORD_FILE", identitySubjectHmac: "USER_IDENTITY_SUBJECT_HMAC_KEY_FILE" };
const secretEnv = Object.fromEntries(Object.entries(secretFiles).map(([name, env]) => {
  const binding = input.secrets?.[name];
  assert(binding && isAbsolute(binding.path) && resolve(binding.path).toLowerCase().startsWith(secretRoot.toLowerCase() + "\\")
    && /^[a-f0-9]{64}$/.test(binding.sha256) && lstatSync(binding.path).isFile() && !lstatSync(binding.path).isSymbolicLink(), "ROUND_SECRET_FILE_BINDING_REQUIRED:" + name);
  return [env, binding.path];
}));
const registry = read(join(dirname(input.credentials), "resource.json"));
assert.equal(registry.database, "zzsh_test_regression");
assert.equal(registry.oid, input.target.oid);
assert.equal(registry.nonce, input.target.nonce);
assert.equal(registry.roles.migration.oid, input.target.migrationRoleOid);
const reservation = registry.protectedDataset;
const reservationStatus = input.target.bootstrapReservation ?? "ROUND02_BOOTSTRAP_RESERVED";
assert(/^ROUND[0-9]{2}_BOOTSTRAP_RESERVED$/.test(reservationStatus), "ROUND_BOOTSTRAP_RESERVATION_STATUS_INVALID");
assert(!registry.pendingReset && (!reservation || reservation.status === reservationStatus
  && matchesLoadReservation(reservation, { ...input.target, datasetSha256: input.dataset.sha256 })), "FRESH_REGISTERED_RESOURCE_OR_EXACT_BOOTSTRAP_RESERVATION_REQUIRED");
assert(input.strictBatch === undefined || typeof input.strictBatch === "boolean", "ROUND_STRICT_BATCH_INVALID");
const strictBatch = input.strictBatch === true;
assert(!strictBatch || reservation?.status === strictRoundReservation || reservation?.status === "ROUND05_BOOTSTRAP_RESERVED", "STRICT_BATCH_REQUIRES_ROUND04");
const apiDist = resolve(input.apiDist);
function assertBuild() {
  const files = readdirSync(apiDist, { recursive: true }).filter(file => file.endsWith(".js")).map(file => file.replaceAll("\\", "/")).sort();
  assert.deepEqual(Object.keys(input.buildFiles).sort(), files, "ROUND_BUILD_DENOMINATOR_CHANGED");
  for (const file of files) assert.equal(sha(readFileSync(join(apiDist, file))), input.buildFiles[file], "ROUND_BUILD_CHANGED:" + file);
  return files.length;
}
const buildModulesVerified = assertBuild();
for (const file of ["database/business-migrations.js", "supply/legacy-user-migration.js", "legacy-load/legacy-account-seam.js", "order/legacy-order-read.js", "finance/personal-finance-maintenance.js", "legacy-load/legacy-path-records.js"])
  assert(Object.hasOwn(input.buildFiles, file), "ROUND_BUILD_ENTRYPOINT_MISSING:" + file);
const validationWallMs = performance.now() - started;
if (validate) {
  console.log(JSON.stringify({ status: "SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN", inputSha256, datasetSha256: input.dataset.sha256, strictBatch, validationWallMs, buildModulesVerified, targetConnections: 0, credentialReads: 0, targetWrites: 0 }));
  process.exit(0);
}

const sid = /S-1-5-[0-9-]+/.exec(spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout)?.[0];
assert(sid, "ROUND_SID_REQUIRED");
mkdirSync(out);
assert.equal(spawnSync("icacls", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true }).status, 0, "ROUND_ACL_FAILED");
const root = fileURLToPath(new URL("../..", import.meta.url)), scripts = dirname(fileURLToPath(import.meta.url));
const toolFiles = Object.fromEntries(["run-local-round.mjs", "load-local-dataset.mjs", "local-load-checkpoint.mjs", "local-target-finance.mjs", "local-funds-plan.mjs", "local-target-display.mjs", "local-target-opening.mjs", "local-target-holdings.mjs", "load-legacy-path-accounts.mjs", "readback-local-dataset.mjs", "run-local-growth.mjs", "local-growth-plan.mjs"].map(name => [name, sha(readFileSync(join(scripts, name)))]));
const receipt = { schema: "zzsh.local-round-receipt.v1", inputSha256, datasetSha256: input.dataset.sha256, target: input.target, strictBatch, validationWallMs, buildModulesVerified, toolFiles, status: "RUNNING", startedAt: new Date().toISOString(), stages: [] };
const receiptFile = join(out, "round-receipt.json"), work = join(out, "loader"), checkpoint = join(work, "checkpoint.json");
const save = () => writeLoadCheckpoint(receiptFile, receipt);
save();
const load = "load-local-dataset.mjs", base = ["--dataset", input.dataset.path, "--dataset-sha", input.dataset.sha256, "--credentials", input.credentials, "--api-dist", apiDist];
const target = ["--oid", input.target.oid, "--nonce", input.target.nonce];
const bind = (name, item) => ["--" + name, item.path, "--" + name + "-sha", item.sha256];
const write = ["--execute", ...(strictBatch ? ["--strict-round-batch"] : []), ...base, ...target, "--out", work, "--actor-id", actor.id, "--session-id", actor.sessionId, "--schema-binding", JSON.stringify(input.target.schemaHashes), "--execution-window", JSON.stringify(input.window)];
function assertCheckpoint(phaseNames) {
  const state = read(checkpoint);
  assert.equal(state.strictBatch ?? false, strictBatch, "CHECKPOINT_STRICT_BATCH_CHANGED");
  assert.equal(state.pending, null, "ROUND_COMMIT_KNOWLEDGE_UNKNOWN");
  for (const field of ["poolClosed", "unlock", "maintenanceClosed", "rollbackConfirmed"]) assert.equal(state[field], true, "ROUND_CLEANUP_UNCONFIRMED:" + field);
  assert(!["RUNNING", "COMMIT_UNKNOWN", "ROLLBACK_UNKNOWN", "RECEIPT_WRITE_FAILED_COMMITTED", "FAILED_STOPPED"].includes(state.status));
  return Object.fromEntries(phaseNames.map(name => {
    const phase = state.phases[name];
    assert(phase?.complete, "ROUND_PHASE_INCOMPLETE:" + name);
    assert.equal(phase.quarantined, 0, "ROUND_RUNTIME_ISOLATION_REQUIRES_REVIEW:" + name);
    return [name, phase];
  }));
}
function closedPhases(names, expected = {}) {
  const phases = assertCheckpoint(names);
  for (const [name, count] of Object.entries(expected)) assert.equal(phases[name].nextIndex, count, "ROUND_PHASE_COUNT_DRIFT:" + name);
  return phases;
}
async function step(name, script, flags, verify) {
  assertBuild();
  assert.equal(sha(readFileSync(actorFile)), input.actor.sha256, "ROUND_ACTOR_CHANGED");
  for (const name of Object.keys(secretFiles)) {
    const binding = input.secrets[name];
    assert.equal(sha(readFileSync(binding.path)), binding.sha256, "ROUND_SECRET_FILE_CHANGED:" + name);
  }
  for (const [file, expected] of Object.entries(toolFiles)) assert.equal(sha(readFileSync(join(scripts, file))), expected, "ROUND_TOOL_CHANGED:" + file);
  const before = performance.now(), stage = { name, startedAt: new Date().toISOString(), status: "INTENT" };
  receipt.stages.push(stage);
  save();
  console.log(JSON.stringify({ stage: name, status: "STARTED" }));
  const stdoutPath = join(out, name + ".stdout.log"), stderrPath = join(out, name + ".stderr.log");
  const stdout = openSync(stdoutPath, "wx"), stderr = openSync(stderrPath, "wx");
  try {
    const child = spawn(process.execPath, [join(scripts, script), ...flags], {
      cwd: root, windowsHide: true, stdio: ["ignore", stdout, stderr],
      env: { ...process.env, ...secretEnv, NODE_PATH: [join(root, "apps/api/node_modules"), join(root, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter) },
    });
    const result = await new Promise((ok, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => ok({ code, signal }));
    });
    Object.assign(stage, result);
    assert.equal(result.code, 0, "ROUND_STAGE_STOPPED:" + name);
    stage.metrics = verify(stdoutPath);
    stage.status = "ACK";
  } finally {
    closeSync(stdout);
    closeSync(stderr);
    stage.finishedAt = new Date().toISOString();
    stage.wallMs = performance.now() - before;
    save();
  }
  console.log(JSON.stringify({ stage: name, status: stage.status, wallMs: stage.wallMs }));
}
try {
  await step("core-and-funds", load, [...write, ...bind("funds-source", input.funds), ...bind("refund-attempts", input.refundAttempts)], () => closedPhases(
    ["users", "accounts", "orders", "invitationFacts", "financeHistory", "financeEmptyCoverage", "guaranteeHistory", "continuationEvidence", "liabilityDuties", "completedCommissions"],
    { users: m.domains.users.ready, accounts: m.domains.accounts.ready, orders: m.domains.orders.ready, continuationEvidence: m.domains.continuations.parameterComplete },
  ));
  await step("display", load, [...write, "--enrich-display", ...bind("display-plan", input.display)], () => closedPhases(["accountDisplay"], { accountDisplay: display.rows }));
  await step("opening", load, [...write, "--import-openings", ...bind("opening-proof", input.openings)], () => closedPhases(["storedOpening"], { storedOpening: openings.stats.candidate }));
  await step("holdings", load, [...write, "--enrich-holdings", ...bind("holding-source", input.source), ...bind("skin-dictionary", input.dictionary), ...(input.holdingOverlay ? bind("holding-mapping-overlay", input.holdingOverlay) : [])], () => {
    const prepared = read(checkpoint).skinHoldingsPreparation;
    assert.equal(prepared.ready + prepared.isolated, m.domains.accounts.ready);
    return closedPhases(["skinHoldings"], { skinHoldings: prepared.ready });
  });
  const pathsOut = join(out, "path-execution");
  await step("paths", "load-legacy-path-accounts.mjs", ["--apply", "--plan-dir", input.paths.path, "--plan-receipt-sha", input.paths.sha256, "--source-plan-dir", input.pathSourcePlan.path, "--source-dir", input.source.path, "--source-receipt-sha", input.source.sha256, "--api-dist", apiDist, "--credentials", input.credentials, "--actor-file", actorFile, ...target, "--not-before", input.window.notBefore, "--expires-at", input.window.expiresAt, "--out", pathsOut], stdout => {
    const result = JSON.parse(readFileSync(stdout, "utf8").trim().split(/\r?\n/).at(-1));
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.applied + result.replayed, pathPlan.accounts);
    return result;
  });
  const readback = join(out, "readback.json");
  await step("readback", "readback-local-dataset.mjs", ["--readback", ...base, "--checkpoint", checkpoint, ...bind("paths-plan", input.paths), "--out", readback], () => {
    const result = read(readback);
    assert.equal(result.status, "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED");
    assert.equal(result.differenceCount, 0);
    assert(result.rollbackConfirmed && result.lockReleased && result.connectionsClosed);
    return { domains: result.domains, display: result.display, holdings: result.holdings, openings: result.openings, paths: result.paths, queries: result.queries, differences: result.differenceCount };
  });
  receipt.status = "DATASET_STAGES_ACK_READBACK_PASS";
  if (input.growth) {
    const growth = "run-local-growth.mjs", planDir = join(out, "growth-plan");
    const growthBase = ["--input", option("--input"), "--input-sha", inputSha256];
    await step("growth-prepare", growth, ["--prepare", ...growthBase, "--out", planDir], () => {
      const p = read(join(planDir, "summary.json"));
      assert(p.status === "PREPARED_NOT_APPLIED" && p.readOnlyRollbackAck && p.readOnlyClientClosed);
      return { manifestSha256: p.manifestSha256, queries: p.queries, ...p.summary };
    });
    const p = receipt.stages.at(-1).metrics, plan = ["--manifest", join(planDir, "manifest.json"), "--manifest-sha", p.manifestSha256];
    const growthWrite = join(out, "growth-execution"), growthRead = join(out, "growth-readback");
    await step("growth-apply", growth, ["--apply", ...growthBase, ...plan, "--out", growthWrite], () => {
      const r = read(join(growthWrite, "summary.json"));
      assert(r.status === "APPLIED_COMMIT_ACK_INDEPENDENT_READBACK_REQUIRED" && r.poolClosed && r.unlockAck && r.lockClosed);
      assert.equal(r.completed, p.users);
      return { completed: r.completed, inserted: r.inserted, replayed: r.replayed, queries: r.queries };
    });
    await step("growth-readback", growth, ["--readback", ...growthBase, ...plan, "--out", growthRead], () => {
      const r = read(join(growthRead, "summary.json"));
      assert(r.status === "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED" && r.readOnlyRollbackAck && r.readOnlyClientClosed);
      return { queries: r.queries, ...r.summary };
    });
    receipt.status = "DATASET_AND_GROWTH_ACK_READBACK_PASS";
  }
} catch (error) {
  receipt.status = "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS";
  receipt.failure = { stage: receipt.stages.at(-1)?.name, code: error.code ?? null };
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  receipt.wallMs = performance.now() - started;
  save();
  console.log(JSON.stringify({ status: receipt.status, wallMs: receipt.wallMs, receipt: receiptFile }));
}
