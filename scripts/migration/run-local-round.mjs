import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { matchesLoadReservation, strictRoundReservation, writeLoadCheckpoint } from "./local-load-checkpoint.mjs";
import { assertRoundBootstrap, assessRoundEvidence, assertGrowthPlanEvidence, assertGrowthPackages, assertResumeLineage, verifyResumeSchema, assessResumeStages, assertNoWriteRetryLineage } from "./local-round-contract.mjs";
import { inspectRoundDependencyLayout, probeRoundDependencies, assertRoundDependencyProof } from "./local-round-dependencies.mjs";

const args = process.argv.slice(2), option = name => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const execute = args.includes("--execute"), validate = args.includes("--validate"), inspect = args.includes("--inspect-receipt"), resumeGrowth = args.includes("--resume-growth");
assert([execute, validate, inspect, resumeGrowth].filter(Boolean).length <= 1, "ONE_ROUND_ACTION_REQUIRED");
if (!execute && !validate && !inspect && !resumeGrowth) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--execute or --resume-growth or --validate or --inspect-receipt", "--input", "--input-sha"], inspectRequired: ["--receipt", "--receipt-sha"], stages: ["core-and-funds", "display", "opening", "holdings", "paths", "readback", "growth-prepare", "growth-apply", "growth-readback"], resumeGrowth: "complete original checkpoint + fresh target-bound readbacks + new growth authorization; original checkpoint is not written", prerequisites: ["fresh registered regression database or exact completed checkpoint", "target-bound formal bootstrap evidence", "bound source and derived packages"], connections: 0, credentialReads: 0 }));
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
assert(!(execute && input.resume) && (!resumeGrowth || input.resume), "ROUND_RESUME_MODE_REQUIRED");
function growthAttemptPath() {
  assert(/^[1-9]\d*$/.test(input.target?.oid ?? "") && /^[a-f0-9]{24}$/.test(input.target?.nonce ?? ""), "ROUND_RESUME_TARGET_INVALID");
  return join(restricted, "growth-resume-attempt-" + input.target.oid + "-" + input.target.nonce + ".json");
}
function bootstrapFile(entry) {
  assert(entry && typeof entry.path === "string" && isAbsolute(entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256 ?? ""), "ROUND_BOOTSTRAP_EVIDENCE_REQUIRED");
  const file = resolve(entry.path), allowed = [restricted, resolve("E:/zzsh-local-state/runtime"), resolve("D:/CodexWorktrees"), resolve("E:/zzsh")];
  assert(allowed.some(root => file.toLowerCase().startsWith(root.toLowerCase() + "\\")), "ROUND_BOOTSTRAP_EVIDENCE_PATH_INVALID");
  for (let path = file; path !== dirname(path); path = dirname(path)) assert(!lstatSync(path).isSymbolicLink(), "ROUND_BOOTSTRAP_REPARSE_POINT_REFUSED");
  return bound(file, entry.sha256);
}
function bootstrap(actorProof) {
  const refs = input.bootstrapEvidence;
  assert(refs && Array.isArray(refs.administrators), "ROUND_BOOTSTRAP_EVIDENCE_REQUIRED");
  const evidence = { runtime: bootstrapFile(refs.runtime), swap: bootstrapFile(refs.swap), schema: bootstrapFile(refs.schema),
    administrators: refs.administrators.map(bootstrapFile), adminBindings: refs.administrators.map(ref => ref.serverBinding ? bootstrapFile(ref.serverBinding) : null),
    business: bootstrapFile(refs.business), readback: bootstrapFile(refs.readback),
    bundle: bootstrapFile(refs.bundle), ...(input.growth ? { policy: bootstrapFile(refs.policy) } : {}) };
  return assertRoundBootstrap(input, actorProof, evidence);
}
function readResumeLineage(expected) {
  const refs = input.resume;
  assert(refs?.schema === "zzsh.local-round-growth-resume.v1", "ROUND_RESUME_LINEAGE_REQUIRED");
  const previousInputPath = privatePath(refs.previousInput.path), previousReceiptPath = privatePath(refs.previousReceipt.path), checkpointPath = privatePath(refs.checkpoint.path);
  const previousInput = bound(previousInputPath, refs.previousInput.sha256), previousReceipt = bound(previousReceiptPath, refs.previousReceipt.sha256);
  const previousOutput = privatePath(previousInput.out), output = resolve(input.out), expectedCheckpoint = join(previousOutput, "loader", "checkpoint.json"), expectedReceipt = join(previousOutput, "round-receipt.json");
  assert(checkpointPath.toLowerCase() === expectedCheckpoint.toLowerCase() && previousReceiptPath.toLowerCase() === expectedReceipt.toLowerCase()
    && output.toLowerCase() !== previousOutput.toLowerCase() && !output.toLowerCase().startsWith(previousOutput.toLowerCase() + "\\"), "ROUND_RESUME_ORIGINAL_PATH_MISMATCH");
  const previousActorPath = privatePath(previousInput.actor.path), previousActorProof = bound(previousActorPath, previousInput.actor.sha256);
  const checkpoint = bound(checkpointPath, refs.checkpoint.sha256);
  const proof = assertResumeLineage({ input, previousInput, previousInputSha256: refs.previousInput.sha256, previousReceipt, previousActorProof, checkpoint, expected });
  return { proof, previousInput, previousActorProof, previousInputPath, previousReceiptPath, previousActorPath, checkpointPath };
}
function readNoWriteRetry() {
  const refs = input.retryEvidence, originalInputPath = privatePath(refs.originalInput?.path), originalReceiptPath = privatePath(refs.originalReceipt?.path), auditPath = privatePath(refs.audit?.path);
  const originalInput = bound(originalInputPath, refs.originalInput.sha256), originalReceipt = bound(originalReceiptPath, refs.originalReceipt.sha256), audit = bound(auditPath, refs.audit.sha256);
  assert(originalReceiptPath.toLowerCase() === join(privatePath(originalInput.out), "round-receipt.json").toLowerCase()
    && !existsSync(join(originalInput.out, "loader")), "ROUND_ORIGINAL_LOADER_EVIDENCE_CHANGED");
  return assertNoWriteRetryLineage({ input, originalInput, originalReceipt, audit });
}
function currentArtifacts(out) {
  const artifactIssues = [];
  const maybeRead = (file, label) => {
    try {
      if (!existsSync(file)) { artifactIssues.push("ROUND_ARTIFACT_MISSING:" + label); return null; }
      const safeFile = privatePath(file);
      if (!lstatSync(safeFile).isFile()) throw new Error("INVALID_ARTIFACT_FILE");
      const bytes = readFileSync(safeFile), value = JSON.parse(bytes);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_ARTIFACT_SHAPE");
      return { value, sha256: sha(bytes) };
    } catch { artifactIssues.push("ROUND_ARTIFACT_UNREADABLE:" + label); return null; }
  };
  const planFile = join(out, "growth-plan", "manifest.json");
  const checkpoint = maybeRead(input.resume ? input.resume.checkpoint.path : join(out, "loader", "checkpoint.json"), "checkpoint"),
    readback = maybeRead(join(out, input.resume ? "readback-final.json" : "readback.json"), "readback");
  const beforeReadback = input.resume ? maybeRead(join(out, "readback.json"), "readback-before") : null;
  let attempt = null;
  if (input.resume) try { attempt = maybeRead(growthAttemptPath(), "growth-attempt"); }
  catch { artifactIssues.push("ROUND_ARTIFACT_UNREADABLE:growth-attempt"); }
  if (input.resume && checkpoint && checkpoint.sha256 !== input.resume.checkpoint.sha256) artifactIssues.push("ROUND_ARTIFACT_CHANGED:checkpoint");
  const plan = input.growth ? maybeRead(planFile, "growth-manifest") : null;
  const prepare = input.growth ? maybeRead(join(out, "growth-plan", "summary.json"), "growth-prepare") : null;
  const apply = input.growth ? maybeRead(join(out, "growth-execution", "summary.json"), "growth-apply") : null;
  const growthReadback = input.growth ? maybeRead(join(out, "growth-readback", "summary.json"), "growth-readback") : null;
  return { checkpoint: checkpoint?.value ?? null, readback: readback?.value ?? null, beforeReadback: beforeReadback?.value ?? null,
    readbackSha256: readback?.sha256 ?? null, beforeReadbackSha256: beforeReadback?.sha256 ?? null, attempt,
    growthArtifactHashes: { "growth-prepare": prepare?.sha256 ?? null, "growth-apply": apply?.sha256 ?? null, "growth-readback": growthReadback?.sha256 ?? null }, growth: { prepare: prepare?.value ?? null,
    manifest: plan?.value ?? null, manifestSha256: plan?.sha256 ?? null, apply: apply?.value ?? null, readback: growthReadback?.value ?? null }, artifactIssues };
}
function assessArtifacts(out, context) {
  const { artifactIssues, ...artifacts } = currentArtifacts(out);
  let completion;
  try { completion = assessRoundEvidence({ ...context, ...artifacts }); }
  catch { completion = { status: "INCOMPLETE", dataset: "INCOMPLETE", growth: input.growth ? "INCOMPLETE" : "NOT_PLANNED", issues: ["ROUND_ASSESSMENT_UNAVAILABLE"] }; }
  if (artifactIssues.length) {
    completion.status = "INCOMPLETE";
    if (artifactIssues.some(issue => /:(checkpoint|readback|readback-before)$/.test(issue))) completion.dataset = "INCOMPLETE";
    if (input.growth && artifactIssues.some(issue => issue.includes(":growth-"))) completion.growth = "INCOMPLETE";
    completion.issues.push(...artifactIssues);
  }
  if (input.resume) {
    const resumeStages = assessResumeStages(context.receipt, input);
    if (resumeStages.status !== "COMPLETE") { completion.status = "INCOMPLETE"; completion.issues.push(...resumeStages.issues); }
    const expectedHashes = { readback: artifacts.beforeReadbackSha256, "readback-final": artifacts.readbackSha256, ...artifacts.growthArtifactHashes };
    for (const [name, digest] of Object.entries(expectedHashes)) {
      const stage = context.receipt?.stages?.findLast(row => row?.name === name && row.status === "ACK");
      if (!digest || stage?.metrics?.evidenceSha256 !== digest) { completion.status = "INCOMPLETE"; completion.issues.push("ROUND_RESUME_STAGE_EVIDENCE_CHANGED:" + name); }
    }
    let before;
    try { before = assessRoundEvidence({ ...context, ...artifacts, readback: artifacts.beforeReadback, requireStageAcks: false, requireGrowth: false }); }
    catch { before = { status: "INCOMPLETE" }; }
    if (before.status !== "COMPLETE") { completion.status = "INCOMPLETE"; completion.dataset = "INCOMPLETE"; completion.issues.push("ROUND_RESUME_INITIAL_READBACK_UNCONFIRMED"); }
    const attempt = artifacts.attempt, attemptStage = context.receipt?.stages?.find(stage => stage?.name === "growth-attempt-reservation" && stage.status === "ACK");
    if (!attempt || attempt.sha256 !== attemptStage?.metrics?.sha256 || attempt.value.schema !== "zzsh.round-growth-attempt.v1"
      || attempt.value.inputSha256 !== context.inputSha256 || attempt.value.datasetSha256 !== input.dataset.sha256
      || attempt.value.oid !== input.target.oid || attempt.value.nonce !== input.target.nonce
      || attempt.value.manifestSha256 !== artifacts.growth?.manifestSha256 || resolve(attempt.value.output ?? "").toLowerCase() !== resolve(out).toLowerCase()) {
      completion.status = "INCOMPLETE"; completion.growth = "INCOMPLETE"; completion.issues.push("ROUND_RESUME_GROWTH_ATTEMPT_UNCONFIRMED");
    }
  }
  return completion;
}
if (inspect) {
  const receiptPath = privatePath(option("--receipt")), output = privatePath(input.out);
  assert(receiptPath.toLowerCase().startsWith(output.toLowerCase() + "\\"), "ROUND_RECEIPT_OUTSIDE_ORIGINAL_OUTPUT");
  const receipt = bound(receiptPath, option("--receipt-sha"));
  const actorProof = bound(privatePath(input.actor.path), input.actor.sha256);
  const pinned = (entry, name = "manifest.json") => bound(join(privatePath(entry.path), name), entry.sha256);
  const expected = { dataset: pinned(input.dataset), display: pinned(input.display), openings: pinned(input.openings), paths: pinned(input.paths, "receipt.json") };
  let bootstrapStatus, bootstrapReason;
  try { bootstrap(actorProof); bootstrapStatus = "PASS"; } catch (error) {
    bootstrapStatus = "INCOMPLETE";
    const message = String(error.message ?? "");
    bootstrapReason = /^ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH:[a-z-]+$/.test(message) ? message : "ROUND_BOOTSTRAP_EVIDENCE_UNCONFIRMED";
  }
  let lineage;
  if (input.resume) try { lineage = readResumeLineage(expected); } catch { /* report missing parent proof below */ }
  const completion = assessArtifacts(output, { input, inputSha256, actorProof, receipt, expected,
    ...(lineage ? { checkpointInput: lineage.previousInput, checkpointActorProof: lineage.previousActorProof, requireStageAcks: false } : {}) });
  if (input.resume && !lineage) { completion.status = "INCOMPLETE"; completion.issues.unshift("ROUND_RESUME_LINEAGE_UNCONFIRMED"); }
  if (input.retryEvidence) try { readNoWriteRetry(); } catch { completion.status = "INCOMPLETE"; completion.issues.unshift("ROUND_RETRY_LINEAGE_UNCONFIRMED"); }
  if (bootstrapStatus !== "PASS") { completion.status = "INCOMPLETE"; completion.issues.unshift("ROUND_BOOTSTRAP_EVIDENCE_UNCONFIRMED"); }
  console.log(JSON.stringify({ status: completion.status, bootstrap: bootstrapStatus, ...(bootstrapReason ? { bootstrapReason } : {}), ...completion, evidenceOnly: true, targetConnections: 0, credentialReads: 0, targetWrites: 0 }));
  if (completion.status !== "COMPLETE") process.exitCode = 1;
  process.exit();
}
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
const retryProof = input.retryEvidence ? readNoWriteRetry() : undefined;
const lineage = input.resume ? readResumeLineage({ dataset: m, display, openings, paths: pathPlan }) : null;
if (lineage) assert(input.growth?.approvedBy === "Root" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(input.growth.approvalRef ?? "")
  && Number.isSafeInteger(input.growth.attempt) && input.growth.attempt >= 1
  && Date.parse(input.window.expiresAt) > Date.parse(input.window.notBefore)
  && Date.parse(input.window.expiresAt) - Date.parse(input.window.notBefore) <= 86400000, "ROUND_RESUME_GROWTH_AUTHORITY_REQUIRED");
if (lineage) assert(!existsSync(growthAttemptPath()), "ROUND_GROWTH_EXISTING_ATTEMPT_REQUIRES_RECOVERY");
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
if (lineage) {
  assert(!registry.pendingReset && matchesLoadReservation(reservation, { ...input.target, datasetSha256: input.dataset.sha256 })
    && typeof reservation.report === "string" && resolve(reservation.report).toLowerCase() === lineage.checkpointPath.toLowerCase()
    && !["BUILDING", "COMMIT_UNKNOWN", "ROLLBACK_UNKNOWN", "RECEIPT_WRITE_FAILED_COMMITTED"].includes(reservation.status), "ROUND_RESUME_PROTECTED_DATASET_REQUIRED");
} else {
  assert(!registry.pendingReset && (!reservation || reservation.status === reservationStatus
    && matchesLoadReservation(reservation, { ...input.target, datasetSha256: input.dataset.sha256 })), "FRESH_REGISTERED_RESOURCE_OR_EXACT_BOOTSTRAP_RESERVATION_REQUIRED");
}
assert(input.strictBatch === undefined || typeof input.strictBatch === "boolean", "ROUND_STRICT_BATCH_INVALID");
const strictBatch = input.strictBatch === true;
assert(lineage || strictBatch || reservation?.status !== "ROUND06_BOOTSTRAP_RESERVED", "ROUND06_STRICT_BATCH_REQUIRED");
assert(lineage || !strictBatch || [strictRoundReservation, "ROUND05_BOOTSTRAP_RESERVED", "ROUND06_BOOTSTRAP_RESERVED"].includes(reservation?.status), "STRICT_BATCH_REQUIRES_REGISTERED_ROUND");
const bootstrapEvidence = bootstrap(actorProof);
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
let dependencyLayout, dependencyProof;
if (input.target.bootstrapReservation === "ROUND06_BOOTSTRAP_RESERVED") {
  const binding = input.dependencyBinding;
  assert(binding?.buildManifest && binding?.sourceManifest && typeof binding.sourceSnapshot === "string" && binding?.proof, "ROUND_DEPENDENCY_BINDING_REQUIRED");
  bootstrapFile(binding.buildManifest); bootstrapFile(binding.sourceManifest);
  dependencyProof = bound(privatePath(binding.proof.path), binding.proof.sha256);
  const inspectLayout = () => inspectRoundDependencyLayout({ apiDist, bundlePath: input.bootstrapEvidence.bundle.path, bundleSha256: input.bootstrapEvidence.bundle.sha256,
    buildManifestPath: binding.buildManifest.path, buildManifestSha256: binding.buildManifest.sha256, sourceSnapshot: binding.sourceSnapshot,
    sourceManifestPath: binding.sourceManifest.path, sourceManifestSha256: binding.sourceManifest.sha256 });
  dependencyLayout = inspectLayout(); assertRoundDependencyProof(dependencyProof, dependencyLayout);
  const liveProbe = probeRoundDependencies(dependencyLayout);
  assert(liveProbe.closureSha256 === dependencyProof.closureSha256 && liveProbe.entrypoints === dependencyProof.entrypoints, "ROUND_DEPENDENCY_CLOSURE_CHANGED");
}
const validationWallMs = performance.now() - started;
if (validate) {
  console.log(JSON.stringify({ status: "SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN", inputSha256, datasetSha256: input.dataset.sha256, strictBatch, bootstrapEvidence, ...(lineage ? { resumeLineage: lineage.proof } : {}), ...(retryProof ? { retryLineage: retryProof } : {}), ...(dependencyProof ? { dependencies: { status: dependencyProof.status, entrypoints: dependencyProof.entrypoints, files: dependencyProof.closureFiles.length, closureSha256: dependencyProof.closureSha256 } } : {}), growthPlanned: Boolean(input.growth), validationWallMs, buildModulesVerified, targetConnections: 0, credentialReads: 0, targetWrites: 0 }));
  process.exit(0);
}

const sid = /S-1-5-[0-9-]+/.exec(spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout)?.[0];
assert(sid, "ROUND_SID_REQUIRED");
mkdirSync(out);
assert.equal(spawnSync("icacls", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true }).status, 0, "ROUND_ACL_FAILED");
const runnerScripts = dirname(fileURLToPath(import.meta.url)), root = dependencyLayout?.sourceRoot ?? fileURLToPath(new URL("../..", import.meta.url)), scripts = dependencyLayout?.scriptDir ?? runnerScripts;
const toolNames = ["run-local-round.mjs", "local-round-contract.mjs", ...(dependencyLayout ? ["local-round-dependencies.mjs", "local-source-adapter.mjs"] : []), "load-local-dataset.mjs", "local-load-checkpoint.mjs", "local-target-finance.mjs", "local-funds-plan.mjs", "local-target-display.mjs", "local-target-opening.mjs", "local-target-holdings.mjs", "load-legacy-path-accounts.mjs", "readback-local-dataset.mjs", "run-local-growth.mjs", "local-growth-plan.mjs"];
const toolPaths = Object.fromEntries(toolNames.map(name => [name, join(["run-local-round.mjs", "local-round-contract.mjs", "local-round-dependencies.mjs"].includes(name) ? runnerScripts : scripts, name)]));
const toolFiles = Object.fromEntries(toolNames.map(name => [name, sha(readFileSync(toolPaths[name]))]));
if (dependencyLayout) assert.equal(sha(readFileSync(join(runnerScripts, "local-load-checkpoint.mjs"))), toolFiles["local-load-checkpoint.mjs"], "ROUND_SHARED_CHECKPOINT_TOOL_CHANGED");
const receipt = { schema: "zzsh.local-round-receipt.v1", inputSha256, datasetSha256: input.dataset.sha256, sourceReceiptSha256: input.source.sha256, target: input.target, strictBatch, bootstrapEvidence, validationWallMs, buildModulesVerified, toolFiles,
  ...(retryProof ? { retryLineage: retryProof } : {}),
  ...(lineage ? { mode: "RESUME_GROWTH", prior: { previousInput: input.resume.previousInput, previousReceipt: input.resume.previousReceipt, checkpoint: input.resume.checkpoint, proof: lineage.proof } } : {}),
  status: "RUNNING", startedAt: new Date().toISOString(), stages: [] };
const receiptFile = join(out, "round-receipt.json"), work = join(out, "loader"), checkpoint = lineage?.checkpointPath ?? join(work, "checkpoint.json");
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
function assertStageBindings() {
  assertBuild();
  if (dependencyLayout) {
    const binding = input.dependencyBinding, current = inspectRoundDependencyLayout({ apiDist, bundlePath: input.bootstrapEvidence.bundle.path, bundleSha256: input.bootstrapEvidence.bundle.sha256,
      buildManifestPath: binding.buildManifest.path, buildManifestSha256: binding.buildManifest.sha256, sourceSnapshot: binding.sourceSnapshot,
      sourceManifestPath: binding.sourceManifest.path, sourceManifestSha256: binding.sourceManifest.sha256 });
    assertRoundDependencyProof(dependencyProof, current);
  }
  assert.equal(sha(readFileSync(actorFile)), input.actor.sha256, "ROUND_ACTOR_CHANGED");
  bootstrap(actorProof);
  for (const name of Object.keys(secretFiles)) {
    const binding = input.secrets[name];
    assert.equal(sha(readFileSync(binding.path)), binding.sha256, "ROUND_SECRET_FILE_CHANGED:" + name);
  }
  for (const [file, expected] of Object.entries(toolFiles)) assert.equal(sha(readFileSync(toolPaths[file])), expected, "ROUND_TOOL_CHANGED:" + file);
  if (input.retryEvidence) {
    for (const key of ["originalInput", "originalReceipt", "audit"]) {
      const ref = input.retryEvidence[key]; assert.equal(sha(readFileSync(privatePath(ref.path))), ref.sha256, "ROUND_RETRY_ORIGINAL_EVIDENCE_CHANGED");
    }
    const original = bound(privatePath(input.retryEvidence.originalInput.path), input.retryEvidence.originalInput.sha256);
    assert(!existsSync(join(original.out, "loader")), "ROUND_ORIGINAL_LOADER_EVIDENCE_CHANGED");
  }
  if (lineage) {
    for (const [path, expected] of [[lineage.previousInputPath, input.resume.previousInput.sha256], [lineage.previousReceiptPath, input.resume.previousReceipt.sha256],
      [lineage.checkpointPath, input.resume.checkpoint.sha256], [lineage.previousActorPath, lineage.previousInput.actor.sha256]]) {
      assert.equal(sha(readFileSync(privatePath(path))), expected, "ROUND_RESUME_ORIGINAL_EVIDENCE_CHANGED");
    }
  }
}
async function step(name, script, flags, verify) {
  assertStageBindings();
  const before = performance.now(), stage = { name, startedAt: new Date().toISOString(), status: "INTENT" };
  receipt.stages.push(stage);
  save();
  console.log(JSON.stringify({ stage: name, status: "STARTED" }));
  const stdoutPath = join(out, name + ".stdout.log"), stderrPath = join(out, name + ".stderr.log");
  const stdout = openSync(stdoutPath, "wx"), stderr = openSync(stderrPath, "wx");
  try {
    const child = spawn(process.execPath, [join(scripts, script), ...flags], {
      cwd: root, windowsHide: true, stdio: ["ignore", stdout, stderr],
      env: { ...process.env, ...secretEnv, NODE_PATH: dependencyLayout ? dependencyLayout.moduleDirs.join(delimiter) : [join(root, "apps/api/node_modules"), join(root, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter) },
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
async function resumeSchemaPreflight() {
  assertStageBindings();
  const before = performance.now(), stage = { name: "schema-preflight", origin: "IN_PROCESS_READ_ONLY", startedAt: new Date().toISOString(), status: "INTENT" };
  receipt.stages.push(stage); save();
  try {
    const credentials = read(input.credentials), migration = credentials.migration;
    assert(credentials.database === "zzsh_test_regression" && migration?.name === registry.roles.migration.name
      && migration?.oid === input.target.migrationRoleOid && typeof migration.password === "string" && migration.password.length > 0, "ROUND_RESUME_MIGRATION_ROLE_CHANGED");
    const { Client } = createRequire(import.meta.url)("pg");
    const client = new Client({ host: "127.0.0.1", port: 55432, database: "zzsh_test_regression", user: migration.name, password: migration.password,
      connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500, application_name: "zzsh-round-resume-schema-readonly" });
    stage.metrics = await verifyResumeSchema(client, { target: input.target, migrationName: migration.name });
    Object.assign(stage, { code: 0, signal: null, status: "ACK" });
  } finally {
    stage.finishedAt = new Date().toISOString(); stage.wallMs = performance.now() - before; save();
  }
}
function reserveResumeGrowthAttempt(manifestSha256) {
  assertStageBindings();
  const before = performance.now(), stage = { name: "growth-attempt-reservation", origin: "ATOMIC_PRIVATE_FILE", startedAt: new Date().toISOString(), status: "INTENT" };
  receipt.stages.push(stage); save();
  const file = privatePath(growthAttemptPath(), true);
  const bytes = Buffer.from(JSON.stringify({ schema: "zzsh.round-growth-attempt.v1", oid: input.target.oid, nonce: input.target.nonce,
    datasetSha256: input.dataset.sha256, inputSha256, manifestSha256, output: out, createdAt: new Date().toISOString() }) + "\n");
  let fd;
  try {
    try { fd = openSync(file, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") throw new Error("ROUND_GROWTH_EXISTING_ATTEMPT_REQUIRES_RECOVERY"); throw error; }
    writeFileSync(fd, bytes); fsyncSync(fd);
    stage.metrics = { path: file, sha256: sha(bytes) };
    Object.assign(stage, { code: 0, signal: null, status: "ACK" });
  } finally {
    if (fd !== undefined) closeSync(fd);
    stage.finishedAt = new Date().toISOString(); stage.wallMs = performance.now() - before; save();
  }
}
try {
  if (lineage) await resumeSchemaPreflight();
  if (!lineage) {
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
  }
  const readback = join(out, "readback.json");
  await step("readback", "readback-local-dataset.mjs", ["--readback", ...base, "--checkpoint", checkpoint, ...bind("paths-plan", input.paths), "--out", readback], () => {
    const result = read(readback);
    assert.equal(result.status, "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED");
    assert.equal(result.differenceCount, 0);
    assert(result.rollbackConfirmed && result.lockReleased && result.connectionsClosed);
    if (lineage) {
      assertStageBindings();
      const evidence = assessRoundEvidence({ input, inputSha256, actorProof, receipt, checkpoint: read(checkpoint), readback: result,
        expected: { dataset: m, display, openings, paths: pathPlan }, checkpointInput: lineage.previousInput,
        checkpointActorProof: lineage.previousActorProof, requireStageAcks: false, requireGrowth: false });
      assert.equal(evidence.status, "COMPLETE", "ROUND_RESUME_DATA_READBACK_UNCONFIRMED");
    }
    return { domains: result.domains, display: result.display, holdings: result.holdings, openings: result.openings, paths: result.paths, queries: result.queries, differences: result.differenceCount, evidenceSha256: sha(readFileSync(readback)) };
  });
  receipt.datasetStatus = lineage ? "FRESH_DATA_READBACK_PASS" : "DATASET_STAGES_ACK_READBACK_PASS";
  if (input.growth) {
    const growth = "run-local-growth.mjs", planDir = join(out, "growth-plan");
    const growthBase = ["--input", option("--input"), "--input-sha", inputSha256];
    await step("growth-prepare", growth, ["--prepare", ...growthBase, "--out", planDir], () => {
      const p = read(join(planDir, "summary.json"));
      const manifest = bound(join(planDir, "manifest.json"), p.manifestSha256);
      assertGrowthPlanEvidence({ input, inputSha256, expected: { dataset: m, display, openings, paths: pathPlan }, prepare: p, manifest, manifestSha256: p.manifestSha256 });
      assertGrowthPackages(manifest, file => readFileSync(privatePath(join(planDir, file))));
      return { manifestSha256: p.manifestSha256, queries: p.queries, ...p.summary, evidenceSha256: sha(readFileSync(join(planDir, "summary.json"))) };
    });
    const p = receipt.stages.at(-1).metrics, plan = ["--manifest", join(planDir, "manifest.json"), "--manifest-sha", p.manifestSha256];
    const growthWrite = join(out, "growth-execution"), growthRead = join(out, "growth-readback");
    if (lineage) reserveResumeGrowthAttempt(p.manifestSha256);
    await step("growth-apply", growth, ["--apply", ...growthBase, ...plan, "--out", growthWrite], () => {
      const r = read(join(growthWrite, "summary.json"));
      assert(r.status === "APPLIED_COMMIT_ACK_INDEPENDENT_READBACK_REQUIRED" && r.poolClosed && r.unlockAck && r.lockClosed);
      assert(r.mode === "--apply" && r.inputSha256 === inputSha256 && r.datasetSha256 === input.dataset.sha256 && r.oid === input.target.oid
        && r.nonce === input.target.nonce && r.manifestSha256 === p.manifestSha256 && r.fundsWrites === 0 && r.pending === null
        && r.completed === p.users && r.inserted === p.contributions && r.replayed === 0 && r.complete === p.complete && r.partial === p.pending, "ROUND_GROWTH_APPLY_ACK_MISMATCH");
      return { completed: r.completed, inserted: r.inserted, replayed: r.replayed, queries: r.queries, evidenceSha256: sha(readFileSync(join(growthWrite, "summary.json"))) };
    });
    await step("growth-readback", growth, ["--readback", ...growthBase, ...plan, "--out", growthRead], () => {
      const r = read(join(growthRead, "summary.json"));
      assert(r.status === "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED" && r.readOnlyRollbackAck && r.readOnlyClientClosed);
      return { queries: r.queries, ...r.summary, evidenceSha256: sha(readFileSync(join(growthRead, "summary.json"))) };
    });
    if (lineage) {
      const finalReadback = join(out, "readback-final.json");
      await step("readback-final", "readback-local-dataset.mjs", ["--readback", ...base, "--checkpoint", checkpoint, ...bind("paths-plan", input.paths), "--out", finalReadback], () => {
        const result = read(finalReadback);
        assertStageBindings();
        const evidence = assessRoundEvidence({ input, inputSha256, actorProof, receipt, checkpoint: read(checkpoint), readback: result,
          expected: { dataset: m, display, openings, paths: pathPlan }, checkpointInput: lineage.previousInput,
          checkpointActorProof: lineage.previousActorProof, requireStageAcks: false, requireGrowth: false });
        assert.equal(evidence.status, "COMPLETE", "ROUND_RESUME_FINAL_READBACK_UNCONFIRMED");
        return { domains: result.domains, display: result.display, holdings: result.holdings, openings: result.openings, paths: result.paths, queries: result.queries, differences: result.differenceCount, evidenceSha256: sha(readFileSync(finalReadback)) };
      });
    }
    receipt.status = lineage ? "DATASET_AND_GROWTH_REVALIDATED_PASS" : "DATASET_AND_GROWTH_ACK_READBACK_PASS";
  } else {
    receipt.status = "INCOMPLETE_GROWTH_NOT_PLANNED";
    process.exitCode = 1;
  }
} catch (error) {
  receipt.status = "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS";
  receipt.failure = { stage: receipt.stages.at(-1)?.name, code: error.code ?? null, message: String(error.message ?? "ROUND_FAILED").slice(0, 200),
    ...(error.resumeCleanup ? { readOnlyCleanup: error.resumeCleanup } : {}) };
  process.exitCode = 1;
} finally {
  receipt.completion = assessArtifacts(out, { input, inputSha256, actorProof, receipt, expected: { dataset: m, display, openings, paths: pathPlan },
    ...(lineage ? { checkpointInput: lineage.previousInput, checkpointActorProof: lineage.previousActorProof, requireStageAcks: false } : {}) });
  if (["DATASET_AND_GROWTH_ACK_READBACK_PASS", "DATASET_AND_GROWTH_REVALIDATED_PASS"].includes(receipt.status) && receipt.completion.status !== "COMPLETE") {
    receipt.status = "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS";
    receipt.failure = { stage: "completion", code: "ROUND_COMPLETION_EVIDENCE_INCOMPLETE" };
    process.exitCode = 1;
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.wallMs = performance.now() - started;
  save();
  console.log(JSON.stringify({ status: receipt.status, wallMs: receipt.wallMs, receipt: receiptFile }));
}
