import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { assertCaptureTargetProfile, assertNextMigrationWriteReady, loadRegisteredTarget, NEXT_MIGRATION_PROFILE, sameMigrationProfile, targetConnection } from "./local-target-registry.mjs";
import { assertSameDirectoryResumeSafe, inspectRoundResumeOutput, isRoundReceiptPath, isStrictRoundReservation, matchesLoadReservation, reserveRoundResumeOutput, strictRoundReservation, writeLoadCheckpoint } from "./local-load-checkpoint.mjs";
import { assertRoundBootstrap, assertRoundLegalBootstrap, assertRoundIdentityKeyBinding, assertRoundOpeningPartition, assertRoundPreparationTools, assertRoundSourceOrigin, assessRoundEvidence, compactEmptyCoverageReadbackMatches, assertGrowthPlanEvidence, assertGrowthPackages, assertResumeLineage, verifyResumeSchema, assessResumeStages, assertNoWriteRetryLineage, assertReadbackRecoveryOverlay, assertReviewedGrowthRuleFiles, assertGrowthRuleRetry, requiresInvitationCountClosure } from "./local-round-contract.mjs";
import { inspectRoundDependencyLayout, probeRoundDependencies, assertRoundDependencyProof, assertBoundRunnerScripts, assertNextSourceTools, verifyRoundDistributionSource } from "./local-round-dependencies.mjs";
import { assertFullExecutionAdmitted, assertRoundPopulationBinding } from "./full-source-scope.mjs";
import { LEGACY_REFUND_RELATIONSHIP_POLICY, assertDisplayCaptureCoverage, assertNextBusinessPopulation, expectedContinuationImports, verifyDisplayCaptureInputs } from "./local-source-adapter.mjs";
import { verifySelectedPopulationFiles } from "./verify-full-source-population.mjs";
import { legacyListedProofVersion, legacyListedTargetMatches } from "./selected-business-scope.mjs";
import { digestInlineGrowthLog, openGrowthPackageReader } from "./local-growth-packages.mjs";
import { verifyOpeningCapture } from "./local-opening-proof.mjs";

const args = process.argv.slice(2), option = name => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const execute = args.includes("--execute"), validate = args.includes("--validate"), inspect = args.includes("--inspect-receipt"), resumeGrowth = args.includes("--resume-growth");
const externalReadiness = { status: "NOT_ASSESSED_BY_ROUND", checks: ["distribution-policy-and-qualification", "credit-initialization", "listed-account-takeover", "legacy-bank-binding", "backup-restore-and-page-acceptance"] };
function setSourceReadiness(proof) {
  const accounts = proof.accountSnapshots, refunds = proof.refundParents;
  externalReadiness.accountSnapshots = { status: accounts.unavailable ? "REVIEW_REQUIRED" : "NO_REVIEW_IN_PREPARED_INPUT", ...accounts };
  if (proof.legacyListed) externalReadiness.legacyListed = { ...proof.legacyListed, targetStatus: "NOT_ASSESSED" };
  externalReadiness.refundRelationships = { status: refunds.relationshipUnresolved || refunds.subjectIsolated ? "REVIEW_REQUIRED" : "NO_REVIEW_IN_CAPTURED_INPUT", ...refunds };
  if (proof.unsupportedContinuations) externalReadiness.unsupportedContinuations = {
    status: proof.unsupportedContinuations.total ? "REVIEW_REQUIRED" : "NO_REVIEW_IN_CAPTURED_INPUT", ...proof.unsupportedContinuations };
  if (proof.continuationCommissions) externalReadiness.continuationCommissions = {
    status: proof.continuationCommissions.settled || proof.continuationCommissions.unknown ? "REVIEW_REQUIRED" : "NO_REVIEW_IN_CAPTURED_INPUT", ...proof.continuationCommissions };
}
assert([execute, validate, inspect, resumeGrowth].filter(Boolean).length <= 1, "ONE_ROUND_ACTION_REQUIRED");
if (!execute && !validate && !inspect && !resumeGrowth) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--execute or --resume-growth or --validate or --inspect-receipt", "--input", "--input-sha"], inspectRequired: ["--receipt", "--receipt-sha"], stages: ["core-and-funds", "display", "opening", "holdings", "paths", "readback", "growth-prepare", "growth-apply", "growth-readback"], fullCapturedSource: "REQUIRES_BOUNDED_COVERAGE_AND_INDEPENDENT_SCOPE_PROOF", selectedBusinessScope: "FULL_SOURCE_SCAN_SELECTED_ACCOUNTS_AND_PAID_ORDERS", resumeGrowth: "complete original checkpoint + fresh target-bound readbacks + new growth authorization; original checkpoint is not written", prerequisites: ["fresh registered regression database or exact completed checkpoint", "target-bound formal bootstrap evidence", "bound source and derived packages"], connections: 0, credentialReads: 0 }));
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
async function verifyRoundOpeningCapture(input,dataset,source,funds,opening){
  const api=resolve(input.apiDist),load=createRequire(import.meta.url),modules={canonical:load(join(api,'supply/content-hash.js')).canonicalize,
    legacyOwnerUserId:load(join(api,'supply/legacy-user-migration.js')).legacyOwnerUserId,financeRead:load(join(api,'finance/personal-finance-read.js')),
    preparation:load(join(api,'finance/legacy-finance-source-preparation.js')),proof:load(join(api,'finance/legacy-finance-source-evidence.js'))};
  if(!inspect&&typeof load(join(api,'finance/personal-finance-maintenance.js')).systemOpeningReview!=='function')throw new Error('NEXT_SYSTEM_OPENING_READBACK_BUILD_REQUIRED');
  return {...await verifyOpeningCapture({datasetDir:privatePath(input.dataset.path),sourceDir:privatePath(input.source.path),fundsDir:privatePath(input.funds.path),
    openingDir:privatePath(input.openings.path),dataset,source,funds,opening,datasetSha256:input.dataset.sha256,
    sourceReceiptSha256:input.source.sha256,fundsReceiptSha256:input.funds.sha256,modules,privatePath}),
    datasetManifestSha256:input.dataset.sha256,sourceReceiptSha256:input.source.sha256,openingManifestSha256:input.openings.sha256,
    fundsReceiptSha256:input.funds.sha256,sourceConnections:0,targetConnections:0,targetWrites:0};
}
const inputSha256 = option("--input-sha"), input = bound(privatePath(option("--input")), inputSha256);
const runnerDir = dirname(fileURLToPath(import.meta.url));
assert.equal(input.schema, "zzsh.local-round.v1");
if (input.target?.migrationProfile === NEXT_MIGRATION_PROFILE) {
  externalReadiness.nextTargetAdmission = { status: "INCOMPLETE" };
  externalReadiness.checks = externalReadiness.checks.map(check => check === "listed-account-takeover" ? "legacy-listed-offline-readback" : check);
}
if (execute || resumeGrowth) assertNextMigrationWriteReady(input.target);
assert(!input.growth||input.growth.packageLayout===undefined||input.growth.packageLayout==='PACKED_V2',"ROUND_GROWTH_PACKAGE_LAYOUT_INVALID");
assert(!input.growth || input.growth.approvalLayout === undefined || input.growth.packageLayout === 'PACKED_V2'
  && input.growth.approvalLayout === 'INLINE_INTENT_V1', 'ROUND_GROWTH_APPROVAL_LAYOUT_INVALID');
if(!inspect&&input.target?.bootstrapReservation==="ROUND07_BOOTSTRAP_RESERVED"&&input.growth)assertReviewedGrowthRuleFiles(input.growth.oldRuleFiles);
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
        const evidence = { runtime: bootstrapFile(refs.runtime), build: refs.build ? bootstrapFile(refs.build) : undefined, swap: refs.swap ? bootstrapFile(refs.swap) : undefined, schema: bootstrapFile(refs.schema),
    administrators: refs.administrators.map(bootstrapFile), adminBindings: refs.administrators.map(ref => ref.serverBinding ? bootstrapFile(ref.serverBinding) : null),
    business: bootstrapFile(refs.business), readback: bootstrapFile(refs.readback),
    bundle: bootstrapFile(refs.bundle), ...(input.growth ? { policy: bootstrapFile(refs.policy) } : {}) };
  const verified = assertRoundBootstrap(input, actorProof, evidence);
  if (input.secrets?.identityProfile) assertRoundIdentityKeyBinding(input, evidence.runtime);
  if (input.legal) {
    assert(evidence.business?.catalogModel === "OWNER_KIND_V2", "ROUND_CATALOG_BOOTSTRAP_UNCONFIRMED");
    assertRoundLegalBootstrap(input, bound(privatePath(input.legal.path), input.legal.sha256), evidence.business?.legal);
  }
  return verified;
}
function readResumeLineage(expected) {
  const refs = input.resume;
  assert(refs?.schema === "zzsh.local-round-growth-resume.v1", "ROUND_RESUME_LINEAGE_REQUIRED");
  const previousInputPath = privatePath(refs.previousInput.path), previousReceiptPath = privatePath(refs.previousReceipt.path), checkpointPath = privatePath(refs.checkpoint.path);
  const previousInput = bound(previousInputPath, refs.previousInput.sha256), previousReceipt = bound(previousReceiptPath, refs.previousReceipt.sha256);
  const previousOutput = privatePath(previousInput.out), output = resolve(input.out), expectedCheckpoint = join(previousOutput, "loader", "checkpoint.json");
  assert(checkpointPath.toLowerCase() === expectedCheckpoint.toLowerCase() && isRoundReceiptPath(previousOutput, previousReceiptPath)
    && output.toLowerCase() !== previousOutput.toLowerCase() && !output.toLowerCase().startsWith(previousOutput.toLowerCase() + "\\"), "ROUND_RESUME_ORIGINAL_PATH_MISMATCH");
  const latest = inspectRoundResumeOutput(previousOutput, refs.previousInput.sha256, { allowGrowthContinuation: true });
  assert(latest?.previousReceipt.path.toLowerCase() === previousReceiptPath.toLowerCase()
    && latest.previousReceipt.sha256 === refs.previousReceipt.sha256, "ROUND_RESUME_RECEIPT_NOT_LATEST");
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
  if (!input.resume && input.growth?.approvalLayout === 'INLINE_INTENT_V1') {
    const hashes = { readback: artifacts.readbackSha256, ...artifacts.growthArtifactHashes };
    for (const [name, digest] of Object.entries(hashes)) {
      const stage = context.receipt?.stages?.findLast(row => row?.name === name && row.status === 'ACK');
      if (!digest || stage?.metrics?.evidenceSha256 !== digest) {
        completion.status = 'INCOMPLETE';
        if (name === 'readback') completion.dataset = 'INCOMPLETE'; else completion.growth = 'INCOMPLETE';
        completion.issues.push('ROUND_STAGE_EVIDENCE_CHANGED:' + name);
      }
    }
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
  const expected = { dataset: pinned(input.dataset), source: pinned(input.source, "receipt.json"), funds: pinned(input.funds, "receipt.json"), display: pinned(input.display), openings: pinned(input.openings), paths: pinned(input.paths, "receipt.json") };
  let populationIssue=false, openingIssue=false, openingSourceIssue=false, distributionIssue=false, sourceOriginIssue=false, sourceWorkflowForInspect=null;
  try{assertCaptureTargetProfile(expected.source,input.target?.migrationProfile ?? null);}catch{sourceOriginIssue=true;}
  if(input.target?.migrationProfile===NEXT_MIGRATION_PROFILE)try{
    const binding=bound(privatePath(input.sourceBinding?.path),input.sourceBinding?.sha256);
    sourceWorkflowForInspect=bound(privatePath(input.sourceWorkflow?.path),input.sourceWorkflow?.sha256);
    const workflowInput=bound(privatePath(sourceWorkflowForInspect.input?.path),sourceWorkflowForInspect.input?.sha256);
    assertRoundSourceOrigin(input,expected.source,expected.dataset,binding,pinned(input.funds,'receipt.json'),pinned(input.refundAttempts,'receipt.json'),sourceWorkflowForInspect,workflowInput);
  }catch{sourceOriginIssue=true;}
  if (expected.dataset.identityProfiles && expected.dataset.refundRelationshipPolicy !== LEGACY_REFUND_RELATIONSHIP_POLICY) populationIssue=true;
  if (!input.resume && expected.dataset.identityProfiles) try { assertRoundPreparationTools(expected.dataset, receipt.toolFiles); }
  catch { populationIssue=true; }
  if (expected.dataset.identityProfiles) try { externalReadiness.storedOpening = assertRoundOpeningPartition(expected.dataset, expected.openings); }
  catch { openingIssue=true; }
  if(!input.resume&&expected.dataset.identityProfiles&&input.target?.migrationProfile===NEXT_MIGRATION_PROFILE)try{
    assert.deepEqual(await verifyRoundOpeningCapture(input,expected.dataset,expected.source,expected.funds,expected.openings),receipt.openingSourcePreflight);
  }catch{openingSourceIssue=true;}
  if(expected.dataset.population||input.population)try{
    const source=expected.source,v=input.population?.verification;
    assert.equal(expected.dataset.sourceReceiptSha256,input.source.sha256,'ROUND_SOURCE_RECEIPT_CHANGED');
    const proof=expected.dataset.population?.mode==='FULL_CAPTURED_SOURCE'?bound(privatePath(v?.path),v?.sha256):null;
    assertRoundPopulationBinding(input,expected.dataset,source,proof);
    if (!input.resume && expected.dataset.identityProfiles && expected.dataset.population?.mode === 'SELECTED_BUSINESS_SCOPE') {
      const { elapsedMs, ...recorded } = receipt.population?.sourceVerification ?? {};
      assert(receipt.population?.mode === 'SELECTED_BUSINESS_SCOPE' && Number.isSafeInteger(elapsedMs) && elapsedMs >= 0, 'ROUND_SOURCE_SCOPE_VERIFICATION_REQUIRED');
      const current = await verifySelectedPopulationFiles({ datasetDir: privatePath(input.dataset.path), sourceDir: privatePath(input.source.path), dataset: expected.dataset, source,
        listedProofVersion: legacyListedProofVersion(recorded) });
      assert.deepEqual(recorded, current, 'ROUND_SOURCE_SCOPE_VERIFICATION_CHANGED');
      setSourceReadiness(current);
    }
  }catch{populationIssue=true;}
  let bootstrapStatus, bootstrapReason;
  try { bootstrap(actorProof); bootstrapStatus = "PASS"; } catch (error) {
    bootstrapStatus = "INCOMPLETE";
    const message = String(error.message ?? "");
    bootstrapReason = /^ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH:[a-z-]+$/.test(message) ? message : "ROUND_BOOTSTRAP_EVIDENCE_UNCONFIRMED";
  }
  let lineage;
  if (input.resume) try { lineage = readResumeLineage(expected); } catch { /* report missing parent proof below */ }
  const completion = assessArtifacts(output, { input, inputSha256, actorProof, receipt, expected, requireCurrentLegacyListed: false,
    ...(lineage ? { checkpointInput: lineage.previousInput, checkpointActorProof: lineage.previousActorProof, requireStageAcks: false } : {}) });
  if (input.resume && !lineage) { completion.status = "INCOMPLETE"; completion.issues.unshift("ROUND_RESUME_LINEAGE_UNCONFIRMED"); }
  if(populationIssue){completion.status='INCOMPLETE';completion.dataset='INCOMPLETE';completion.issues.unshift('ROUND_POPULATION_SCOPE_UNCONFIRMED');}
  if(sourceOriginIssue){completion.status='INCOMPLETE';completion.dataset='INCOMPLETE';completion.issues.unshift('ROUND_SOURCE_RESTORE_PROOF_UNCONFIRMED');}
  if(openingIssue){completion.status='INCOMPLETE';completion.dataset='INCOMPLETE';completion.issues.unshift('ROUND_OPENING_PARTITION_UNCONFIRMED');}
  if(openingSourceIssue){completion.status='INCOMPLETE';completion.dataset='INCOMPLETE';completion.issues.unshift('ROUND_OPENING_SOURCE_UNCONFIRMED');}
  if (expected.dataset.identityProfiles && input.growth?.packageLayout === 'PACKED_V2') try {
    const binding = input.dependencyBinding, proof = bound(privatePath(binding.proof.path), binding.proof.sha256);
    const layout = inspectRoundDependencyLayout({ apiDist: resolve(input.apiDist), bundlePath: input.bootstrapEvidence.bundle.path,
      bundleSha256: input.bootstrapEvidence.bundle.sha256, buildManifestPath: binding.buildManifest.path, buildManifestSha256: binding.buildManifest.sha256,
      sourceSnapshot: binding.sourceSnapshot, sourceManifestPath: binding.sourceManifest.path, sourceManifestSha256: binding.sourceManifest.sha256 });
    assertRoundDependencyProof(proof, layout); assertBoundRunnerScripts(runnerDir, layout.scriptFiles);
    if(input.target?.migrationProfile===NEXT_MIGRATION_PROFILE)
      assertNextSourceTools(input,bound(privatePath(input.sourceBinding.path),input.sourceBinding.sha256),[expected.source,pinned(input.funds,'receipt.json'),pinned(input.refundAttempts,'receipt.json')],layout.scriptFiles,sourceWorkflowForInspect);
    assert.deepEqual(await verifyRoundDistributionSource({input,source:expected.source,layout,proof,runnerDir,privatePath}), receipt.distributionSourcePreflight);
    assert.equal(sha(readFileSync(join(privatePath(input.source.path), "receipt.json"))), input.source.sha256);
  } catch { distributionIssue = true; }
  if (distributionIssue) { completion.status = 'INCOMPLETE'; completion.dataset = 'INCOMPLETE'; completion.issues.unshift('ROUND_DISTRIBUTION_SOURCE_UNCONFIRMED'); }
  if (input.growth?.approvalLayout === 'INLINE_INTENT_V1') try {
    const growthSummary = read(privatePath(join(output, 'growth-execution', 'summary.json')));
    const log = privatePath(join(output, 'growth-execution', 'events.jsonl'));
    assert.equal(await digestInlineGrowthLog(log), growthSummary.approvalLog?.sha256, 'ROUND_GROWTH_APPROVAL_LOG_CHANGED');
  } catch { completion.status = 'INCOMPLETE'; completion.growth = 'INCOMPLETE'; completion.issues.unshift('ROUND_GROWTH_APPROVAL_LOG_UNCONFIRMED'); }
  if (input.retryEvidence) try { readNoWriteRetry(); } catch { completion.status = "INCOMPLETE"; completion.issues.unshift("ROUND_RETRY_LINEAGE_UNCONFIRMED"); }
  if (bootstrapStatus !== "PASS") { completion.status = "INCOMPLETE"; completion.issues.unshift("ROUND_BOOTSTRAP_EVIDENCE_UNCONFIRMED"); }
  console.log(JSON.stringify({ status: completion.status, bootstrap: bootstrapStatus, ...(bootstrapReason ? { bootstrapReason } : {}), ...completion,
    assessmentScope: input.target?.migrationProfile === NEXT_MIGRATION_PROFILE ? "HISTORICAL_DATASET_AND_GROWTH" : "DATASET_AND_GROWTH",
    ...(input.target?.migrationProfile === NEXT_MIGRATION_PROFILE ? { currentLegacyListed: { status: "NOT_ASSESSED", reason: "HISTORICAL_RECEIPT_ONLY" } } : {}),
    externalReadiness, evidenceOnly: true, targetConnections: 0, credentialReads: 0, targetWrites: 0 }));
  if (completion.status !== "COMPLETE") process.exitCode = 1;
  process.exit();
}
assert(input.window && Object.keys(input.window).every(k => ["notBefore", "expiresAt"].includes(k))
  && [input.window.notBefore, input.window.expiresAt].every(time => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time)), "ROUND_EXECUTION_WINDOW_INVALID");
assert(Date.now() >= Date.parse(input.window.notBefore) && Date.now() < Date.parse(input.window.expiresAt), "ROUND_EXECUTION_WINDOW_INACTIVE");
assert(/^[1-9]\d*$/.test(input.target.oid) && /^[a-f0-9]{24}$/.test(input.target.nonce));
assert(input.target.schemaHashes.length >= 1 && input.target.schemaHashes.every(x => /^[a-f0-9]{64}$/.test(x)));
const out = privatePath(input.out, true);
// A stopped round may resume from its bound checkpoint, but each attempt retains its own receipt and logs.
const sameDirectoryResume = inspectRoundResumeOutput(out, inputSha256);
function assertResumeOutputStillSafe() {
  if (!sameDirectoryResume) return;
  assertSameDirectoryResumeSafe(sameDirectoryResume, name => {
    try { lstatSync(join(out, name)); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
}
assertResumeOutputStillSafe();
const pinned = (entry, name = "manifest.json") => bound(join(privatePath(entry.path), name), entry.sha256);
const m = pinned(input.dataset), display = pinned(input.display), openings = pinned(input.openings);
assertNextBusinessPopulation(m.population, input.target?.migrationProfile === NEXT_MIGRATION_PROFILE);
const continuationExpected = expectedContinuationImports(m, input.target?.migrationProfile === NEXT_MIGRATION_PROFILE);
// New rounds must detect obsolete source packages during validation; historical growth-only resumes retain their original evidence.
if (!input.resume) assert(m.identityProfiles?.schema === "zzsh.legacy-identity-profile-source.v1", "ROUND_IDENTITY_PROFILE_SOURCE_REQUIRED");
if (!input.resume) assert(m.refundRelationshipPolicy === LEGACY_REFUND_RELATIONSHIP_POLICY, "ROUND_REFUND_RELATIONSHIP_POLICY_REQUIRED");
if (m.identityProfiles) assert(input.legal && /^[a-f0-9]{64}$/.test(input.legal.sha256 ?? ""), "ROUND_LEGAL_INPUT_REQUIRED");
const funds = pinned(input.funds, "receipt.json"), refund = pinned(input.refundAttempts, "receipt.json");
const source = pinned(input.source, "receipt.json"), pathPlan = pinned(input.paths, "receipt.json");
const hasNextSource=input.target?.migrationProfile===NEXT_MIGRATION_PROFILE;
const sourceWorkflow=hasNextSource?bound(privatePath(input.sourceWorkflow?.path),input.sourceWorkflow?.sha256):null;
if(hasNextSource)
  assertRoundSourceOrigin(input,source,m,bound(privatePath(input.sourceBinding?.path),input.sourceBinding?.sha256),funds,refund,sourceWorkflow,bound(privatePath(sourceWorkflow?.input?.path),sourceWorkflow?.input?.sha256));
const populationProof=m.population?.mode==='FULL_CAPTURED_SOURCE'?bound(privatePath(input.population?.verification?.path),input.population?.verification?.sha256):null;
const populationAudit=assertRoundPopulationBinding(input,m,source,populationProof);
assertFullExecutionAdmitted(populationAudit,execute?'execute':resumeGrowth?'resume-growth':'validate');
pinned(input.pathSourcePlan, "receipt.json");
pinned(input.dictionary, "receipt.json");
assert.equal(m.sourceReceiptSha256, input.source.sha256);
if (!input.resume && populationAudit.mode === "SELECTED_BUSINESS_SCOPE") {
  const scopeStarted = performance.now();
  const priorCheckpoint = join(out, "loader", "checkpoint.json");
  const priorScope = sameDirectoryResume && existsSync(priorCheckpoint) ? read(priorCheckpoint).sourceScopeVerification : null;
  populationAudit.sourceVerification = { ...await verifySelectedPopulationFiles({ datasetDir: privatePath(input.dataset.path), sourceDir: privatePath(input.source.path), dataset: m, source,
      listedProofVersion: legacyListedProofVersion(priorScope) }),
    elapsedMs: Math.round(performance.now() - scopeStarted) };
  setSourceReadiness(populationAudit.sourceVerification);
}
assert.equal(funds.sourceSupplement.baseReceiptSha256, input.source.sha256);
assert.equal(refund.sourceSupplement.baseReceiptSha256, input.source.sha256);
assert.equal(source.status, "CAPTURED_READ_ONLY");
for (const plan of [display, openings, pathPlan]) assert.equal(plan.datasetSha256, input.dataset.sha256);
assert.equal(pathPlan.sourcePlanReceiptSha256, input.pathSourcePlan.sha256);
assert.equal(display.rows + display.notDisplayable, m.domains.accounts.ready);
if(!input.resume&&m.identityProfiles)assertDisplayCaptureCoverage(display);
assert.equal(pathPlan.accounts, m.domains.accounts.ready);
assert.equal(openings.stats.subjects, m.domains.users.ready);
if (m.identityProfiles) externalReadiness.storedOpening = assertRoundOpeningPartition(m, openings);
if (input.holdingOverlay) bound(privatePath(input.holdingOverlay.path), input.holdingOverlay.sha256);
const actorFile = privatePath(input.actor.path), actorProof = bound(actorFile, input.actor.sha256);
const actor = { id: actorProof.id ?? actorProof.actorId, sessionId: actorProof.sessionId };
assert(actor.id && actor.sessionId && (!actorProof.actorId || actor.id === actorProof.actorId), "ONE_BOUND_ADMIN_ACTOR_REQUIRED");
const retryProof = input.retryEvidence ? readNoWriteRetry() : undefined;
const lineage = input.resume ? readResumeLineage({ dataset: m, source, display, openings, paths: pathPlan }) : null;
let previousRepair;
if(input.resume?.previousRepair){
  assert(lineage,"ROUND_GROWTH_RULE_RETRY_UNCONFIRMED");const refs=input.resume.previousRepair;
  const values=Object.fromEntries(["input","receipt","summary","readback","rulesEvidence"].map(key=>[key,bound(privatePath(refs[key]?.path),refs[key]?.sha256)]));
  const priorOut=privatePath(values.input.out),samePath=(a,b)=>resolve(a??"").toLowerCase()===resolve(b).toLowerCase();
  assert(samePath(refs.receipt.path,join(priorOut,"round-receipt.json"))&&samePath(refs.summary.path,join(priorOut,"growth-plan","summary.json"))
    &&samePath(refs.readback.path,join(priorOut,"readback.json")),"ROUND_GROWTH_RULE_RETRY_UNCONFIRMED");
  previousRepair={refs,proof:assertGrowthRuleRetry({input,previousInput:values.input,previousReceipt:values.receipt,summary:values.summary,readback:values.readback,rulesEvidence:values.rulesEvidence})};
}
if (lineage) assert(input.growth?.approvedBy === "Root" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(input.growth.approvalRef ?? "")
  && Number.isSafeInteger(input.growth.attempt) && input.growth.attempt >= 1
  && Date.parse(input.window.expiresAt) > Date.parse(input.window.notBefore)
  && Date.parse(input.window.expiresAt) - Date.parse(input.window.notBefore) <= 86400000, "ROUND_RESUME_GROWTH_AUTHORITY_REQUIRED");
if (lineage) assert(!existsSync(growthAttemptPath()), "ROUND_GROWTH_EXISTING_ATTEMPT_REQUIRES_RECOVERY");
const secretRoot = resolve("E:/zzsh/zzsh/apps/api/.secrets");
const secretFiles = { databaseMaintenance: "DB_PASSWORD_FILE", identitySubjectHmac: "USER_IDENTITY_SUBJECT_HMAC_KEY_FILE" };
if (m.identityProfiles) {
  assert(m.identityProfiles.schema === "zzsh.legacy-identity-profile-source.v1" && m.identityProfiles.invalid === 0
    && Number.isSafeInteger(m.identityProfiles.ready) && m.identityProfiles.ready >= 0
    && m.identityProfiles.verified === m.identityProfiles.ready, "ROUND_IDENTITY_PROFILE_SOURCE_INCOMPLETE");
  secretFiles.identityProfile = "USER_LEGACY_IDENTITY_PROFILE_KEY_FILE";
}
const secretEnv = Object.fromEntries(Object.entries(secretFiles).map(([name, env]) => {
  const binding = input.secrets?.[name];
  assert(binding && isAbsolute(binding.path) && resolve(binding.path).toLowerCase().startsWith(secretRoot.toLowerCase() + "\\")
    && /^[a-f0-9]{64}$/.test(binding.sha256) && lstatSync(binding.path).isFile() && !lstatSync(binding.path).isSymbolicLink(), "ROUND_SECRET_FILE_BINDING_REQUIRED:" + name);
  return [env, binding.path];
}));
const registry = loadRegisteredTarget(input.credentials);
assert(sameMigrationProfile(input.target,registry), "ROUND_REGISTERED_PROFILE_CHANGED");
if (execute || resumeGrowth) assertNextMigrationWriteReady(registry);
assert.equal(registry.oid, input.target.oid);
assert.equal(registry.nonce, input.target.nonce);
assert.equal(registry.migrationRoleOid, input.target.migrationRoleOid);
assert.deepEqual(input.target.instance ?? null, registry.instance, "ROUND_REGISTERED_INSTANCE_CHANGED");
assert.equal(registry.pendingReset, null, "ROUND_TARGET_RESET_PENDING");
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
assert(lineage || strictBatch || !["ROUND06_BOOTSTRAP_RESERVED","ROUND07_BOOTSTRAP_RESERVED"].includes(reservation?.status), reservation?.status === "ROUND07_BOOTSTRAP_RESERVED" ? "ROUND07_STRICT_BATCH_REQUIRED" : "ROUND06_STRICT_BATCH_REQUIRED");
    assert(lineage || !strictBatch || isStrictRoundReservation(reservation?.status), "STRICT_BATCH_REQUIRES_REGISTERED_ROUND");
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
let dependencyLayout, dependencyProof, recoveryOverlay;
if (["ROUND06_BOOTSTRAP_RESERVED","ROUND07_BOOTSTRAP_RESERVED"].includes(input.target.bootstrapReservation)) {
  const binding = input.dependencyBinding;
  assert(binding?.buildManifest && binding?.sourceManifest && typeof binding.sourceSnapshot === "string" && binding?.proof, "ROUND_DEPENDENCY_BINDING_REQUIRED");
  bootstrapFile(binding.buildManifest); bootstrapFile(binding.sourceManifest);
  dependencyProof = bound(privatePath(binding.proof.path), binding.proof.sha256);
  const inspectLayout = () => inspectRoundDependencyLayout({ apiDist, bundlePath: input.bootstrapEvidence.bundle.path, bundleSha256: input.bootstrapEvidence.bundle.sha256,
    buildManifestPath: binding.buildManifest.path, buildManifestSha256: binding.buildManifest.sha256, sourceSnapshot: binding.sourceSnapshot,
    sourceManifestPath: binding.sourceManifest.path, sourceManifestSha256: binding.sourceManifest.sha256 });
  dependencyLayout = inspectLayout(); assertRoundDependencyProof(dependencyProof, dependencyLayout);
  if(input.target?.migrationProfile===NEXT_MIGRATION_PROFILE)
    assertNextSourceTools(input,bound(privatePath(input.sourceBinding.path),input.sourceBinding.sha256),[source,funds,refund],dependencyLayout.scriptFiles,sourceWorkflow);
  if(!inspect&&!input.resume&&m.identityProfiles&&input.target?.migrationProfile===NEXT_MIGRATION_PROFILE)
    assert(/^[a-f0-9]{64}$/.test(dependencyLayout.scriptFiles['system-opening-readback.mjs']??''),'ROUND_SYSTEM_OPENING_READBACK_NOT_SEALED');
  if (input.legal) assert.equal(dependencyLayout.scriptFiles["business-reference-readiness.mjs"], bootstrapFile(input.bootstrapEvidence.business).rentalReference?.validatorSha256, "ROUND_RENTAL_REFERENCE_VALIDATOR_NOT_SEALED");
  if (!inspect&&input.growth?.packageLayout==='PACKED_V2') assert.equal(dependencyLayout.scriptFiles['local-growth-packages.mjs'],sha(readFileSync(join(runnerDir,'local-growth-packages.mjs'))),'ROUND_GROWTH_PACKAGER_NOT_SEALED');
  if (!input.resume && m.identityProfiles) assertRoundPreparationTools(m, dependencyLayout.scriptFiles);
  if(input.resume?.readbackRepair){
    assert(lineage, "ROUND_READBACK_RECOVERY_REQUIRES_LINEAGE");
    const repair=bound(privatePath(input.resume.readbackRepair.path),input.resume.readbackRepair.sha256),relativeRunner=relative(resolve(apiDist,"../../../.."),runnerDir).replaceAll("\\","/");
    assert(/^round07-readback-recovery-[a-z0-9-]+\/scripts\/migration$/i.test(relativeRunner),"ROUND_READBACK_RECOVERY_PATH_INVALID");
    for(let at=runnerDir;at!==dirname(at);at=dirname(at))assert(!lstatSync(at).isSymbolicLink(),"ROUND_READBACK_RECOVERY_FILE_UNSAFE");
    const observedFiles=()=>Object.fromEntries(Object.keys(dependencyLayout.scriptFiles).map(name=>{const file=join(runnerDir,name),stat=lstatSync(file);
      assert(stat.isFile()&&!stat.isSymbolicLink(),"ROUND_READBACK_RECOVERY_FILE_UNSAFE");return[name,sha(readFileSync(file))];}));
    const previousReceipt=bound(lineage.previousReceiptPath,input.resume.previousReceipt.sha256);
    const verify=()=>assertReadbackRecoveryOverlay(repair,{input,previousReceipt,originalFiles:dependencyLayout.scriptFiles,observedFiles:observedFiles(),scriptDir:runnerDir,proofSha256:binding.proof.sha256});
    assertBoundRunnerScripts(dependencyLayout.scriptDir,dependencyLayout.scriptFiles);verify();recoveryOverlay={repair,verify};
  }else assertBoundRunnerScripts(runnerDir, dependencyLayout.scriptFiles);
  const liveProbe = probeRoundDependencies(dependencyLayout);
  assert(liveProbe.closureSha256 === dependencyProof.closureSha256 && liveProbe.entrypoints === dependencyProof.entrypoints, "ROUND_DEPENDENCY_CLOSURE_CHANGED");
}
if(!inspect&&input.growth?.packageLayout==='PACKED_V2')assert(dependencyLayout,'ROUND_GROWTH_PACKAGER_NOT_SEALED');
let displayCapturePreflight, distributionSourcePreflight, openingSourcePreflight;
if(!input.resume&&m.identityProfiles){
  const contentHash=createRequire(import.meta.url)(join(apiDist,'supply/content-hash.js'));
  assert(typeof contentHash.canonicalize==='function','ROUND_DISPLAY_CANONICALIZER_REQUIRED');
  displayCapturePreflight={...await verifyDisplayCaptureInputs({sourceDir:privatePath(input.source.path),sourceEntry:source.files?.accounts,
    accountsDir:privatePath(input.dataset.path),accountsEntry:m.files?.accounts,displayDir:privatePath(input.display.path),display,canonicalize:contentHash.canonicalize}),
    sourceReceiptSha256:input.source.sha256,datasetManifestSha256:input.dataset.sha256,displayManifestSha256:input.display.sha256};
}
if (!input.resume && hasNextSource) {
  openingSourcePreflight=await verifyRoundOpeningCapture(input,m,source,funds,openings);
}
if (m.identityProfiles && input.growth?.packageLayout === 'PACKED_V2') {
  distributionSourcePreflight = await verifyRoundDistributionSource({input,source,layout:dependencyLayout,proof:dependencyProof,runnerDir,privatePath});
  assert.equal(sha(readFileSync(join(privatePath(input.source.path), "receipt.json"))), input.source.sha256, "ROUND_DISTRIBUTION_SOURCE_CHANGED");
  if (lineage) {
    const previous = bound(lineage.previousReceiptPath, input.resume.previousReceipt.sha256);
    assert.deepEqual(distributionSourcePreflight, previous.distributionSourcePreflight, "ROUND_RESUME_DISTRIBUTION_SOURCE_CHANGED");
  }
}
const validationWallMs = performance.now() - started;
if (validate) {
  console.log(JSON.stringify({ status: "SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN", inputSha256, datasetSha256: input.dataset.sha256, population:populationAudit, ...(displayCapturePreflight?{displayCapturePreflight}:{}), ...(distributionSourcePreflight?{distributionSourcePreflight}:{}), ...(openingSourcePreflight?{openingSourcePreflight}:{}), assessmentScope: "DATASET_AND_GROWTH", externalReadiness, strictBatch, bootstrapEvidence, ...(lineage ? { resumeLineage: lineage.proof } : {}), ...(retryProof ? { retryLineage: retryProof } : {}), ...(dependencyProof ? { dependencies: { status: dependencyProof.status, entrypoints: dependencyProof.entrypoints, files: dependencyProof.closureFiles.length, closureSha256: dependencyProof.closureSha256 } } : {}), growthPlanned: Boolean(input.growth), validationWallMs, buildModulesVerified, targetConnections: 0, credentialReads: 0, targetWrites: 0 }));
  process.exit(0);
}

const sid = /S-1-5-[0-9-]+/.exec(spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout)?.[0];
assert(sid, "ROUND_SID_REQUIRED");
    mkdirSync(out, { recursive: true });
assert.equal(spawnSync("icacls", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true }).status, 0, "ROUND_ACL_FAILED");
const runnerScripts = runnerDir, root = dependencyLayout?.sourceRoot ?? fileURLToPath(new URL("../..", import.meta.url)), scripts = dependencyLayout?.scriptDir ?? runnerScripts;
const scopeRunnerTools = ["full-source-scope.mjs", "selected-business-scope.mjs", "verify-full-source-population.mjs", "local-source-adapter.mjs", "local-opening-proof.mjs"];
const toolNames = ["run-local-round.mjs", "local-round-contract.mjs", ...(input.legal ? ["business-reference-readiness.mjs"] : []), ...(input.growth?.packageLayout==='PACKED_V2'?["local-growth-packages.mjs"]:[]), ...(distributionSourcePreflight?["local-distribution-qualification-plan.mjs"]:[]), ...(!input.resume&&m.identityProfiles&&input.target?.migrationProfile===NEXT_MIGRATION_PROFILE?["system-opening-readback.mjs"]:[]), ...scopeRunnerTools, ...(dependencyLayout ? ["local-round-dependencies.mjs"] : []), "prepare-local-dataset.mjs", "local-source-scenarios.mjs", "load-local-dataset.mjs", "local-load-checkpoint.mjs", "local-target-finance.mjs", "local-funds-plan.mjs", "local-target-display.mjs", "local-target-opening.mjs", "local-target-holdings.mjs", "load-legacy-path-accounts.mjs", "local-legal-pair.mjs", "readback-local-dataset.mjs", "run-local-growth.mjs", "local-growth-plan.mjs"];
const toolPaths = Object.fromEntries(toolNames.map(name => [name, join(["run-local-round.mjs", "local-round-contract.mjs", "business-reference-readiness.mjs", "local-growth-packages.mjs", "local-distribution-qualification-plan.mjs", "local-round-dependencies.mjs", ...scopeRunnerTools].includes(name) || recoveryOverlay && ["readback-local-dataset.mjs", "local-funds-plan.mjs", "local-legal-pair.mjs"].includes(name) ? runnerScripts : scripts, name)]));
const toolFiles = Object.fromEntries(toolNames.map(name => [name, sha(readFileSync(toolPaths[name]))]));
if (dependencyLayout) assert.equal(sha(readFileSync(join(runnerScripts, "local-load-checkpoint.mjs"))), toolFiles["local-load-checkpoint.mjs"], "ROUND_SHARED_CHECKPOINT_TOOL_CHANGED");
assertResumeOutputStillSafe();
const attemptOut = sameDirectoryResume ? reserveRoundResumeOutput(out, sameDirectoryResume) : out;
const receipt = { schema: "zzsh.local-round-receipt.v1", inputSha256, datasetSha256: input.dataset.sha256, sourceReceiptSha256: input.source.sha256, target: input.target, strictBatch, bootstrapEvidence, validationWallMs, buildModulesVerified, toolFiles, population: populationAudit, ...(displayCapturePreflight?{displayCapturePreflight}:{}), ...(distributionSourcePreflight?{distributionSourcePreflight}:{}), ...(openingSourcePreflight?{openingSourcePreflight}:{}), assessmentScope: "DATASET_AND_GROWTH", externalReadiness,
  ...(sameDirectoryResume ? { sameDirectoryResume } : {}),
  ...(retryProof ? { retryLineage: retryProof } : {}),
  ...(lineage ? { mode: "RESUME_GROWTH", prior: { previousInput: input.resume.previousInput, previousReceipt: input.resume.previousReceipt, checkpoint: input.resume.checkpoint, proof: lineage.proof }, ...(recoveryOverlay?{readbackRepair:input.resume.readbackRepair}:{}), ...(previousRepair?{previousRepair}: {}) } : {}),
  status: "RUNNING", startedAt: new Date().toISOString(), stages: [] };
const receiptFile = join(attemptOut, "round-receipt.json"), work = join(out, "loader"), checkpoint = lineage?.checkpointPath ?? join(work, "checkpoint.json");
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
  if (input.target.migrationProfile === NEXT_MIGRATION_PROFILE) {
    assert.equal(state.targetFenceReleased, true, "ROUND_CLEANUP_UNCONFIRMED:targetFenceReleased");
    assert.equal(state.protectionRecorded, true, "ROUND_CLEANUP_UNCONFIRMED:protectionRecorded");
  }
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
  if (sameDirectoryResume) assert.equal(sha(readFileSync(privatePath(sameDirectoryResume.previousReceipt.path))), sameDirectoryResume.previousReceipt.sha256, "ROUND_PRIOR_ATTEMPT_RECEIPT_CHANGED");
  if (dependencyLayout) {
    const binding = input.dependencyBinding, current = inspectRoundDependencyLayout({ apiDist, bundlePath: input.bootstrapEvidence.bundle.path, bundleSha256: input.bootstrapEvidence.bundle.sha256,
      buildManifestPath: binding.buildManifest.path, buildManifestSha256: binding.buildManifest.sha256, sourceSnapshot: binding.sourceSnapshot,
      sourceManifestPath: binding.sourceManifest.path, sourceManifestSha256: binding.sourceManifest.sha256 });
    assertRoundDependencyProof(dependencyProof, current);
  }
  if(recoveryOverlay){bound(privatePath(input.resume.readbackRepair.path),input.resume.readbackRepair.sha256);recoveryOverlay.verify();}
  if(previousRepair){for(const ref of Object.values(previousRepair.refs))bound(privatePath(ref.path),ref.sha256);assertReviewedGrowthRuleFiles(input.growth.oldRuleFiles);}
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
  const stdoutPath = join(attemptOut, name + ".stdout.log"), stderrPath = join(attemptOut, name + ".stderr.log");
  let stdout, stderr;
  try {
    stdout = openSync(stdoutPath, "wx", 0o600);
    stderr = openSync(stderrPath, "wx", 0o600);
    stage.logs = { stdout: stdoutPath, stderr: stderrPath };
    save();
    const child = spawn(process.execPath, [toolPaths[script] ?? join(scripts, script), ...flags], {
      cwd: root, windowsHide: true, stdio: ["ignore", stdout, stderr],
      env: { ...process.env, ...secretEnv, NODE_PATH: dependencyLayout ? dependencyLayout.moduleDirs.join(delimiter) : [join(root, "apps/api/node_modules"), join(root, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter) },
    });
    const result = await new Promise((ok, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => ok({ code, signal }));
    });
    Object.assign(stage, result);
    assert.equal(result.code, 0, "ROUND_STAGE_STOPPED:" + name);
    stage.metrics = await verify(stdoutPath);
    stage.status = "ACK";
  } finally {
    if (stdout !== undefined) closeSync(stdout);
    if (stderr !== undefined) closeSync(stderr);
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
    assert(credentials.database === registry.database && migration?.name === registry.migrationRole
      && migration?.oid === input.target.migrationRoleOid && typeof migration.password === "string" && migration.password.length > 0, "ROUND_RESUME_MIGRATION_ROLE_CHANGED");
    const { Client } = createRequire(join(apiDist,"app.js"))("pg");
    const client = new Client(targetConnection(registry, { user: migration.name, password: migration.password,
      connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500, applicationName: "zzsh-round-resume-schema-readonly" }));
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
    ["users", "accounts", "orders", "invitationFacts", ...(requiresInvitationCountClosure(m)?["invitationCounts"]:[]), "financeHistory", "financeEmptyCoverage", "continuationEvidence", "liabilityDuties", "completedCommissions"],
    { users: m.domains.users.ready, accounts: m.domains.accounts.ready, orders: m.domains.orders.ready, continuationEvidence: continuationExpected,
      ...(requiresInvitationCountClosure(m)?{invitationFacts:m.invitationFacts.selectedPackets,invitationCounts:m.invitationFacts.selectedPackets}:{}) },
  ));
  await step("display", load, [...write, "--enrich-display", ...bind("display-plan", input.display)], () => closedPhases(["accountDisplay"], { accountDisplay: display.rows }));
  if(hasNextSource)assert.deepEqual(await verifyRoundOpeningCapture(input,m,source,funds,openings),openingSourcePreflight,"ROUND_OPENING_SOURCE_CHANGED");
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
    if (input.target.migrationProfile === NEXT_MIGRATION_PROFILE) {
      assert(result.targetFence === 'HELD_ACROSS_BATCHES' && result.targetFenceReleased === true, 'ROUND_PATH_TARGET_FENCE_UNCONFIRMED');
      assert(result.receiptMode === 'SYSTEM_ACCOUNT_V1' && result.systemAccountId === read(checkpoint).binding.systemAccountId
        && result.sourceDatasetSha256 === input.dataset.sha256, 'ROUND_SYSTEM_MEDIA_RECEIPT_UNCONFIRMED');
    }
    assert.equal(result.applied + result.replayed, pathPlan.accounts);
    return result;
  });
  }
  const readback = join(out, "readback.json");
  await step("readback", "readback-local-dataset.mjs", ["--readback", ...base, "--checkpoint", checkpoint, ...bind("paths-plan", input.paths), ...bind("funds-source", input.funds), ...bind("refund-attempts", input.refundAttempts), ...(input.legal ? [...bind("legal-input", input.legal), ...bind("business-bootstrap", input.bootstrapEvidence.business)] : []), "--out", readback], () => {
    const result = read(readback);
    assert.equal(result.status, "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED");
    assert.equal(result.differenceCount, 0);
    assert(result.rollbackConfirmed && result.lockReleased && result.connectionsClosed);
    if (input.target.migrationProfile === NEXT_MIGRATION_PROFILE) {
      assert(result.resource?.migrationProfile === NEXT_MIGRATION_PROFILE && result.targetFence === "HELD_UNTIL_ROLLBACK", "ROUND_TARGET_READBACK_FENCE_UNCONFIRMED");
      const listed = result.legacyListedSource, recorded = read(checkpoint)?.sourceScopeVerification?.legacyListed;
      const binding = { sourceReceiptSha256: m.sourceReceiptSha256, sourceAccountsSha256: source.files?.accounts?.sha256 ?? null,
        sourceGamesSha256: source.files?.games?.sha256 ?? null, datasetAccountsSha256: m.files?.accounts?.sha256 ?? null,
        gameBindingsSha256: sha(JSON.stringify(m.gameBindings ?? {})) };
      const checkpointV2 = recorded?.schema === "zzsh.legacy-listed-source-scope.v2";
      externalReadiness.legacyListed = { ...(listed ?? {}), targetStatus: result.legacyListedTarget?.status ?? "NOT_ASSESSED" };
      assert(result.legacyListedTarget?.status === "MAPPED_HISTORICAL_NOT_PUBLISHED"
        && result.legacyListedSourceOrigin === (checkpointV2 ? "CHECKPOINT_BOUND_V2" : "RECOMPUTED_FROM_BOUND_SOURCE")
        && (!checkpointV2 || JSON.stringify(listed) === JSON.stringify(recorded))
        && legacyListedTargetMatches(listed, result.legacyListedTarget, binding), "ROUND_LEGACY_LISTED_READBACK_UNCONFIRMED");
      assert(listed.status === "SOURCE_PARTITION_VERIFIED_TARGET_NOT_RUN", "ROUND_LEGACY_LISTED_SOURCE_REVIEW_REQUIRED");
      assert(compactEmptyCoverageReadbackMatches(read(checkpoint)?.generatedPhases?.financeEmptyCoverage,result),"ROUND_COMPACT_EMPTY_COVERAGE_READBACK_UNCONFIRMED");
    }
    if (input.legal) assert(result.rentalReference?.status === "TARGET_CONFIG_VERIFIED" && result.rentalReference.businessReceiptSha256 === input.bootstrapEvidence.business.sha256
      && result.rentalReference.targetDigest === bootstrapEvidence.rentalReference.targetDigest && result.rentalReference.runtimeAccess === "VERIFIED"
      && result.rentalReference.runtimeRollbackConfirmed === true && result.rentalReference.runtimeClosed === true, "ROUND_RENTAL_REFERENCE_READBACK_UNCONFIRMED");
    if (lineage) {
      assertStageBindings();
      const evidence = assessRoundEvidence({ input, inputSha256, actorProof, receipt, checkpoint: read(checkpoint), readback: result,
        expected: { dataset: m, source, funds, display, openings, paths: pathPlan }, checkpointInput: lineage.previousInput,
        checkpointActorProof: lineage.previousActorProof, requireStageAcks: false, requireGrowth: false });
      assert.equal(evidence.status, "COMPLETE", "ROUND_RESUME_DATA_READBACK_UNCONFIRMED");
    }
    return { domains: result.domains, ...(result.identityProfiles ? { identityProfiles: result.identityProfiles } : {}), display: result.display, holdings: result.holdings, openings: result.openings, paths: result.paths, queries: result.queries, differences: result.differenceCount, evidenceSha256: sha(readFileSync(readback)) };
  });
  receipt.datasetStatus = lineage ? "FRESH_DATA_READBACK_PASS" : "DATASET_STAGES_ACK_READBACK_PASS";
  if (input.growth) {
    const growth = "run-local-growth.mjs", planDir = join(out, "growth-plan");
    const growthBase = ["--input", option("--input"), "--input-sha", inputSha256];
    await step("growth-prepare", growth, ["--prepare", ...growthBase, "--out", planDir], () => {
      const p = read(join(planDir, "summary.json"));
      const manifest = bound(join(planDir, "manifest.json"), p.manifestSha256);
      assertGrowthPlanEvidence({ input, inputSha256, expected: { dataset: m, display, openings, paths: pathPlan }, prepare: p, manifest, manifestSha256: p.manifestSha256 });
      if(manifest.schema==='zzsh.local-growth-round-plan.v2'){
        const reader=openGrowthPackageReader(manifest,file=>privatePath(join(planDir,file)));
        try{assertGrowthPackages(manifest,reader.read);}finally{reader.close();}
      }else assertGrowthPackages(manifest, file => readFileSync(privatePath(join(planDir, file))));
      return { manifestSha256: p.manifestSha256, queries: p.queries, ...p.summary, evidenceSha256: sha(readFileSync(join(planDir, "summary.json"))) };
    });
    const p = receipt.stages.at(-1).metrics, plan = ["--manifest", join(planDir, "manifest.json"), "--manifest-sha", p.manifestSha256];
    const growthWrite = join(out, "growth-execution"), growthRead = join(out, "growth-readback");
    if (lineage) reserveResumeGrowthAttempt(p.manifestSha256);
    await step("growth-apply", growth, ["--apply", ...growthBase, ...plan, "--out", growthWrite], async () => {
      const r = read(join(growthWrite, "summary.json"));
      assert(r.status === "APPLIED_COMMIT_ACK_INDEPENDENT_READBACK_REQUIRED" && r.poolClosed && r.unlockAck && r.lockClosed);
      if (input.target.migrationProfile === NEXT_MIGRATION_PROFILE)
        assert(r.targetFence === 'HELD_ACROSS_BATCHES' && r.targetFenceReleased === true, 'ROUND_GROWTH_TARGET_FENCE_UNCONFIRMED');
      assert(r.mode === "--apply" && r.inputSha256 === inputSha256 && r.datasetSha256 === input.dataset.sha256 && r.oid === input.target.oid
        && r.nonce === input.target.nonce && r.manifestSha256 === p.manifestSha256 && r.fundsWrites === 0 && r.pending === null
        && r.completed === p.users && r.inserted === p.contributions && r.replayed === 0 && r.complete === p.complete && r.partial === p.pending, "ROUND_GROWTH_APPLY_ACK_MISMATCH");
      if (input.growth.approvalLayout === 'INLINE_INTENT_V1') {
        assert(r.approvalLayout === 'INLINE_INTENT_V1' && r.approvalLog?.status === 'INLINE_INTENTS_AND_ACKS_VERIFIED'
          && r.approvalLog.startIndex === 0 && r.approvalLog.completed === p.users && r.approvalLog.lines === p.users * 2
          && /^[a-f0-9]{64}$/.test(r.approvalLog.sha256 ?? ''), 'ROUND_GROWTH_APPROVAL_LOG_UNCONFIRMED');
        assert.equal(await digestInlineGrowthLog(privatePath(join(growthWrite, 'events.jsonl'))), r.approvalLog.sha256, 'ROUND_GROWTH_APPROVAL_LOG_CHANGED');
      }
      return { completed: r.completed, inserted: r.inserted, replayed: r.replayed, queries: r.queries, evidenceSha256: sha(readFileSync(join(growthWrite, "summary.json"))) };
    });
    await step("growth-readback", growth, ["--readback", ...growthBase, ...plan, "--out", growthRead], () => {
      const r = read(join(growthRead, "summary.json"));
      assert(r.status === "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED" && r.readOnlyRollbackAck && r.readOnlyClientClosed);
      if (input.target.migrationProfile === NEXT_MIGRATION_PROFILE)
        assert(r.readOnlyFence === 'HELD_UNTIL_ROLLBACK' && r.readOnlyMaintenanceUnlock && r.readOnlyMaintenanceClosed, 'ROUND_GROWTH_READBACK_FENCE_UNCONFIRMED');
      return { queries: r.queries, ...r.summary, evidenceSha256: sha(readFileSync(join(growthRead, "summary.json"))) };
    });
    if (lineage) {
      const finalReadback = join(out, "readback-final.json");
      await step("readback-final", "readback-local-dataset.mjs", ["--readback", ...base, "--checkpoint", checkpoint, ...bind("paths-plan", input.paths), ...bind("funds-source", input.funds), ...bind("refund-attempts", input.refundAttempts), ...(input.legal ? [...bind("legal-input", input.legal), ...bind("business-bootstrap", input.bootstrapEvidence.business)] : []), "--out", finalReadback], () => {
        const result = read(finalReadback);
        assertStageBindings();
        const evidence = assessRoundEvidence({ input, inputSha256, actorProof, receipt, checkpoint: read(checkpoint), readback: result,
          expected: { dataset: m, source, funds, display, openings, paths: pathPlan }, checkpointInput: lineage.previousInput,
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
  receipt.completion = assessArtifacts(out, { input, inputSha256, actorProof, receipt, expected: { dataset: m, source, funds, display, openings, paths: pathPlan },
    ...(lineage ? { checkpointInput: lineage.previousInput, checkpointActorProof: lineage.previousActorProof, requireStageAcks: false } : {}) });
  if (["DATASET_AND_GROWTH_ACK_READBACK_PASS", "DATASET_AND_GROWTH_REVALIDATED_PASS"].includes(receipt.status) && receipt.completion.status !== "COMPLETE") {
    receipt.status = "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS";
    receipt.failure = { stage: "completion", code: "ROUND_COMPLETION_EVIDENCE_INCOMPLETE" };
    process.exitCode = 1;
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.wallMs = performance.now() - started;
  save();
  console.log(JSON.stringify({ status: receipt.status, assessmentScope: receipt.assessmentScope, externalReadiness, wallMs: receipt.wallMs, receipt: receiptFile }));
}
