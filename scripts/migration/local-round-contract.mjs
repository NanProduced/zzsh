import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const requiredDatasetStages = ["core-and-funds", "display", "opening", "holdings", "paths", "readback"];
const requiredGrowthStages = ["growth-prepare", "growth-apply", "growth-readback"];
const loadPhases = ["users", "accounts", "orders", "invitationFacts", "financeHistory", "financeEmptyCoverage", "guaranteeHistory", "continuationEvidence", "liabilityDuties", "completedCommissions", "accountDisplay", "storedOpening", "skinHoldings"];
const knownLoadStatuses = new Set(["LOCAL_DATASET_CORE_AND_FINANCIAL_DOMAINS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_DISPLAY_ENRICHMENT_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_STORED_OPENINGS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED", "FAILED_ROLLED_BACK"]);

/** Whole-user migrations must close child sets; scenario subsets intentionally cannot. */
export function requiresInvitationCountClosure(manifest) {
  if (!["SELECTED_BUSINESS_SCOPE", "FULL_CAPTURED_SOURCE"].includes(manifest?.population?.mode)) return false;
  const users = manifest.domains?.users, facts = manifest.invitationFacts;
  const packetRows = manifest.files?.["invitation-facts"]?.rows ?? 0;
  if (!users || !facts || ![users.source, users.ready, users.isolated, facts.subjects, facts.codes,
    facts.selectedSubjects, facts.packets, facts.selectedPackets, packetRows].every(n => Number.isSafeInteger(n) && n >= 0)
    || users.source !== users.ready || users.isolated !== 0 || facts.subjects !== users.source
    || facts.codes !== users.source || facts.selectedSubjects !== users.source
    || facts.selectedPackets !== facts.packets || packetRows !== facts.selectedPackets
    || facts.financialEffects !== false || facts.policy !== null) throw new Error("INVITATION_FULL_USER_SCOPE_UNPROVEN");
  return true;
}

/** Check the exact packet population before any target transaction begins. */
export function assertInvitationCountPackets(manifest, packets, invitation) {
  if (!requiresInvitationCountClosure(manifest)) return false;
  if (!Array.isArray(packets) || packets.length !== manifest.invitationFacts.selectedPackets
    || !invitation || typeof invitation.prepareLegacyInvitationFacts !== "function" || typeof invitation.invitationFactHash !== "function")
    throw new Error("INVITATION_PACKET_POPULATION_UNPROVEN");
  const users = new Set(), legacyIds = [], codes = new Set(), codeFacts = new Map(), sourceHashes = new Set(); let source, qualifications = 0;
  for (const packet of packets) {
    if (!packet?.input || packet.input.policy !== null) throw new Error("INVITATION_PACKET_BINDING_INVALID");
    const planned = invitation.prepareLegacyInvitationFacts(packet.input, packet.bodyDigest);
    if (planned.key !== packet.key || planned.relations.length !== packet.relations
      || packet.input.source.receiptSha256 !== manifest.sourceReceiptSha256
      || packet.input.source.files.users.rows !== manifest.domains.users.source) throw new Error("INVITATION_PACKET_BINDING_INVALID");
    source = packet.input.source; sourceHashes.add(invitation.invitationFactHash(source));
    for (const fact of packet.input.subjects) {
      if (users.has(fact.userId)) throw new Error("INVITATION_DUPLICATE_SUBJECT");
      const code=fact.codeSource.code.toUpperCase();
      if(codes.has(code))throw new Error("INVITATION_DUPLICATE_CODE");
      users.add(fact.userId);legacyIds.push(fact.legacyId);codes.add(code);codeFacts.set(fact.legacyId,[code,invitation.invitationFactHash(fact.codeSource)]);
      if(fact.qualificationSource!==null)qualifications++;
    }
  }
  legacyIds.sort();
  if (users.size !== manifest.domains.users.source || (users.size > 0 && (sourceHashes.size !== 1
    || qualifications!==source.files.qualification.rows
    || invitation.invitationFactHash(legacyIds) !== source.subjectSetDigest
    || invitation.invitationFactHash(legacyIds.map(id=>[id,...codeFacts.get(id)])) !== source.codeSetDigest)))
    throw new Error("INVITATION_PACKET_POPULATION_UNPROVEN");
  return true;
}

export function assessInvitationChildSet(fact, actualByType, hash) {
  const types = ["INVITER", "DISTRIBUTION_LEADER"];
  let complete = true, matches = true;
  for (const type of types) {
    const expected = fact.children[type], actual = actualByType[type] ?? [];
    if (expected.sourceCount !== expected.knownCount) complete = false;
    if (expected.knownCount !== actual.length || expected.setDigest !== hash(actual)) matches = false;
  }
  return { knowledge: complete ? "KNOWN" : "UNKNOWN", matches };
}

/** Growth cannot start until the reviewed, immutable old rule sources are available. */
export function assertReviewedGrowthRuleFiles(files,{root=resolve("E:/zzsh/analysis"),read=readFileSync,stat=lstatSync}={}) {
  assert(files&&typeof files==="object"&&!Array.isArray(files),"REVIEWED_OLD_RULE_FILES_REQUIRED");
  const entries=Object.entries(files),seen=new Set();assert(entries.length>0&&entries.length<=16,"REVIEWED_OLD_RULE_FILES_REQUIRED");
  for(const [file,digest] of entries){
    assert(isAbsolute(file)&&/\.java$/i.test(file)&&/^[a-f0-9]{64}$/.test(digest??""),"REVIEWED_OLD_RULE_FILES_INVALID");
    const absolute=resolve(file),rel=relative(root,absolute),key=absolute.toLowerCase();
    assert(rel&&!rel.startsWith("..")&&!isAbsolute(rel)&&!seen.has(key),"REVIEWED_OLD_RULE_FILES_INVALID");seen.add(key);
    for(let at=absolute;at!==dirname(at);at=dirname(at))assert(!stat(at).isSymbolicLink(),"REVIEWED_OLD_RULE_FILE_UNSAFE");
    assert(stat(absolute).isFile()&&createHash("sha256").update(read(absolute)).digest("hex")===digest,"REVIEWED_OLD_RULE_FILE_CHANGED");
  }
  return true;
}

function buildDigest(buildFiles) {
  if (!buildFiles || typeof buildFiles !== "object" || Array.isArray(buildFiles)) return null;
  const entries = Object.entries(buildFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!entries.length || entries.some(([key, value]) => key === "contentHash" || typeof value !== "string")) return null;
  const canonical = "{" + entries.map(([key, value]) => JSON.stringify(key.normalize("NFC")) + ":" + JSON.stringify(value)).join(",") + "}";
  return createHash("sha256").update(canonical).digest("hex");
}

export function assertGrowthPlanEvidence({ input, inputSha256, expected, prepare, manifest, manifestSha256 }) {
  const sameTarget = item => item && item.oid === input.target.oid && item.nonce === input.target.nonce;
  let cutoff = null;
  try { cutoff = new Date(expected.dataset.sourceCutoff).toISOString().replace(/\.(\d{3})Z$/, (_, ms) => "." + ms + "000Z"); } catch { /* missing cutoff is not evidence */ }
  const digest = buildDigest(input.buildFiles);
  assert(prepare && prepare.inputSha256 === inputSha256 && prepare.datasetSha256 === input.dataset.sha256 && sameTarget(prepare)
    && prepare.mode === "--prepare" && prepare.status === "PREPARED_NOT_APPLIED" && prepare.readOnlyRollbackAck === true && prepare.readOnlyClientClosed === true
    && manifest && manifest.schema === "zzsh.local-growth-round-plan.v1" && manifest.status === "PREPARED_NOT_APPLIED"
    && manifestSha256 === prepare.manifestSha256 && manifest.datasetSha256 === input.dataset.sha256 && sameTarget(manifest)
    && cutoff !== null && manifest.cutoff === cutoff && digest !== null && manifest.buildDigest === digest
    && manifest.policy?.id === input.growth?.policyId && Date.parse(manifest.policy?.effectiveAt) === Date.parse(input.growth?.policyEffectiveAt)
    && Array.isArray(manifest.packages) && manifest.packages.length === expected?.dataset?.domains?.users?.ready
    && prepare.summary?.users === expected?.dataset?.domains?.users?.ready && prepare.summary?.orders === expected?.dataset?.domains?.orders?.ready
    && ["users", "orders", "complete", "pending", "contributions"].every(key => manifest.summary?.[key] === prepare.summary?.[key]), "ROUND_GROWTH_PREPARE_UNCONFIRMED");
  const summary = prepare.summary, seenUsers = new Set(), seenKeys = new Set();
  assert(["users", "orders", "complete", "pending", "contributions"].every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0)
    && summary.complete + summary.pending === summary.users, "ROUND_GROWTH_PREPARE_UNCONFIRMED");
  let complete = 0, pending = 0, contributions = 0;
  for (const [index, item] of manifest.packages.entries()) {
    assert(item && item.file === "packages/" + String(index + 1).padStart(5, "0") + ".json"
      && typeof item.userId === "string" && item.userId.length > 0 && typeof item.executionKey === "string" && item.executionKey.length > 0
      && /^[a-f0-9]{64}$/.test(item.sha256 ?? "") && /^[a-f0-9]{64}$/.test(item.coverageFingerprint ?? "")
      && ["COMPLETE", "BACKFILL_PENDING"].includes(item.coverageState) && Number.isSafeInteger(item.contributionCount) && item.contributionCount >= 0
      && !seenUsers.has(item.userId) && !seenKeys.has(item.executionKey), "ROUND_GROWTH_PREPARE_UNCONFIRMED");
    seenUsers.add(item.userId); seenKeys.add(item.executionKey);
    if (item.coverageState === "COMPLETE") complete++; else pending++;
    contributions += item.contributionCount;
  }
  assert(complete === summary.complete && pending === summary.pending && contributions === summary.contributions, "ROUND_GROWTH_PREPARE_UNCONFIRMED");
}

/** Check every sealed package before the first growth commit, not only when its turn arrives. */
export function assertGrowthPackages(manifest, readPackage) {
  for (const item of manifest.packages) {
    const bytes = readPackage(item.file);
    assert(createHash("sha256").update(bytes).digest("hex") === item.sha256, "ROUND_GROWTH_PACKAGE_SHA_MISMATCH");
  }
}

/** A new output is allowed only when the failed original never reached a loader write boundary. */
export function assertNoWriteRetryLineage({ input, originalInput, originalReceipt, audit }) {
  const ref = input.retryEvidence, fail = "ROUND_NO_WRITE_RETRY_LINEAGE_CHANGED";
  assert(ref?.schema === "zzsh.local-round-no-write-retry.v1" && originalInput?.schema === "zzsh.local-round.v1"
    && originalReceipt?.inputSha256 === ref.originalInput?.sha256 && originalReceipt.status === "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS"
    && Array.isArray(originalReceipt.stages) && originalReceipt.stages.length === 1 && originalReceipt.stages[0]?.name === "core-and-funds"
    && originalReceipt.stages[0]?.status === "INTENT" && originalReceipt.stages[0]?.code === 1, fail);
  assert(audit?.status === "NO_WRITES_CONFIRMED_FOR_FAILED_ATTEMPT" && audit.originalReceiptSha256 === ref.originalReceipt?.sha256
    && audit.loaderSha256 === originalReceipt.toolFiles?.["load-local-dataset.mjs"] && audit.moduleFailureBeforeCredentialAndPool === true
    && audit.loaderDirectoryCreated === false && audit.targetWrites === 0 && audit.rollbackAck === true && audit.clientClosed === true
    && audit.unlockAck === true && audit.maintenanceClosed === true, fail);
  for (const name of ["legacy_users", "legacy_accounts", "legacy_orders", "finance_observations", "opening_basis", "ledger_entries", "economic_roots", "growth_coverage"])
    assert.equal(audit.counts?.[name], 0, fail);
  for (const key of Object.keys(originalInput)) if (key !== "out") assert.deepEqual(input[key], originalInput[key], fail + ":" + key);
  assert(input.out !== originalInput.out, fail + ":output");
  return { status: "ORIGINAL_PREWRITE_FAILURE_CONFIRMED", originalInputSha256: ref.originalInput.sha256, originalReceiptSha256: ref.originalReceipt.sha256 };
}

/** Bootstrap receipts are evidence for one database epoch, not reusable seed data. */
export function assertRoundBootstrap(input, actorProof, evidence) {
  const target = input.target, binding = input.bootstrapEvidence;
    const sameTarget = (value, database = true) => value && String(value.oid ?? value.resourceOid) === target.oid && value.nonce === target.nonce
    && (!database || value.database === "zzsh_test_regression")
    && (!target.instance || JSON.stringify(value.instance ?? null) === JSON.stringify(target.instance));
  const fail = "ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH";
    const runtimeEvidence = evidence.runtime ?? {};
    const actualEvidence = runtimeEvidence.actualResource ?? evidence.build?.actualResource;
    assert(binding && evidence && sameTarget(runtimeEvidence.resource) && sameTarget(actualEvidence), fail + ":runtime");
    assert(runtimeEvidence.resource.marker === "zzsh:regression-test:v1" && actualEvidence.marker === "zzsh:regression-test:v1"
    && String(runtimeEvidence.resource.migrationRoleOid ?? actualEvidence.migration_role_oid) === target.migrationRoleOid
    && String(actualEvidence.migration_role_oid) === target.migrationRoleOid
    && actualEvidence.read_only === "on" && runtimeEvidence.formalAppMounted === true, fail + ":runtime-identity");
    // The administrators' receipts pin the server binding they were created against, while the build
    // evidence proves which compiled files the round will load. They are separate files on purpose.
    const build = evidence.build ?? evidence.runtime;
    assert(build.copyManifestSha256 === binding.bundle.sha256 && build.moduleSha256 === evidence.bundle?.moduleSha256, fail + ":bundle");
  assert(Array.isArray(evidence.bundle.entries), fail + ":bundle");
  const bundleBuild = Object.fromEntries(evidence.bundle.entries.filter(item => typeof item.path === "string" && item.path.startsWith("api-build/src/") && item.path.endsWith(".js"))
    .map(item => [item.path.slice("api-build/src/".length), item.sha256]));
  assert.deepEqual(bundleBuild, input.buildFiles, fail + ":bundle-build");
  const normalPath = value => typeof value === "string" ? value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() : "";
    assert(normalPath(build.compiledRoot) && normalPath(build.compiledRoot) === normalPath(input.apiDist), fail + ":runtime-build");
    // A round installed straight onto its own clean database has no swap receipt; a round that took over an existing database must still prove the rename committed.
    assert(evidence.schema?.status === "CLEAN_SCHEMA_INSTALLED" ? (evidence.swap === undefined || (evidence.swap?.status === "COMMIT_ACK" && sameTarget(evidence.swap, false))) : (evidence.swap?.status === "COMMIT_ACK" && sameTarget(evidence.swap, false)), fail + ":swap");
    const finalRound06Schema = evidence.schema?.status === "FINAL_SCHEMA_0157_VERIFIED" && sameTarget(evidence.schema, false)
    && sameTarget(evidence.schema.target, false) && evidence.schema.target.database === "zzsh_test_round06_stage"
    && evidence.schema.target.marker === "zzsh:round06-schema-build:v1" && String(evidence.schema.target.migrationRoleOid) === target.migrationRoleOid
    && evidence.schema.finalOrdinal >= 157 && evidence.schema.commitAck === true && evidence.schema.migrationExit?.code === 0
    && evidence.schema.readbackRollbackAck === true && evidence.schema.readbackClientClosed === true
    && /^[a-f0-9]{64}$/.test(evidence.schema.journalSha256 ?? "") && /^[a-f0-9]{64}$/.test(evidence.schema.historySha256 ?? "");
  const finalRound07Schema = target.instance && evidence.schema?.status === "CLEAN_SCHEMA_INSTALLED" && sameTarget(evidence.schema, false)
    && evidence.schema.finalOrdinal >= 160 && evidence.schema.commitAck === true && evidence.schema.migrationAck === true
    && evidence.schema.readbackRollbackAck === true && evidence.schema.readbackClientClosed === true && evidence.schema.unlockAck === true && evidence.schema.maintenanceClosed === true
    && /^[a-f0-9]{64}$/.test(evidence.schema.journalSha256 ?? "") && /^[a-f0-9]{64}$/.test(evidence.schema.historySha256 ?? "");
  assert(target.bootstrapReservation === "ROUND07_BOOTSTRAP_RESERVED" ? finalRound07Schema
    : target.bootstrapReservation === "ROUND06_BOOTSTRAP_RESERVED" ? finalRound06Schema
    : evidence.schema?.status === "CLEAN_SCHEMA_INSTALLED" && sameTarget(evidence.schema, false), fail + ":schema");
  assert.deepEqual(evidence.schema.hashes, target.schemaHashes, fail + ":schema");
  assert(Array.isArray(evidence.administrators) && evidence.administrators.length === 2, fail + ":administrators");
  for (const stage of ["bosses", "staff"]) {
    const indexes = evidence.administrators.map((row, index) => row && typeof row === "object" && row.stage === stage ? index : -1).filter(index => index >= 0);
    assert(indexes.length === 1, fail + ":" + stage);
    const index = indexes[0], row = evidence.administrators[index], reference = binding.administrators[index];
    const origin = evidence.adminBindings?.[index] ?? evidence.runtime, originSha256 = reference?.serverBinding?.sha256 ?? binding.runtime.sha256;
    const originResource = origin?.resource;
    const originOid = originResource?.oid ?? originResource?.resourceOid, originNonce = originResource?.nonce ?? origin?.initialization?.nonce;
    assert(originResource?.database === "zzsh_test_regression" && String(originOid) === target.oid && originNonce === target.nonce
      && (!target.instance || JSON.stringify(originResource?.instance ?? null) === JSON.stringify(target.instance))
      && (!reference?.serverBinding || origin?.initialization?.imProvisioner === false && origin.initialization.imIdentityRepository === false && origin.initialization.imAppId === null)
      && row.status === "FORMAL_INITIALIZATION_COMPLETED" && sameTarget(row.target) && row.serverBindingSha256 === originSha256
      && row.finalReadbackRollbackAck === true && row.maintenanceClosed === true && row.unlock === true && row.oldAdminRowsImported === false, fail + ":" + stage);
  }
  const business = evidence.business;
  assert(business?.status === "REFERENCE_BOOTSTRAP_COMMITTED" && sameTarget(business, false)
    && Array.isArray(business.tables) && business.tables.length > 0 && /^[a-f0-9]{64}$/.test(business.manifestSha256 ?? "")
    && business.commitAck === true && business.maintenanceClosed === true && business.poolClosed === true && business.unlock === true, fail + ":business");
  const actorId = actorProof.id ?? actorProof.actorId;
  assert(actorId && actorProof.sessionId && String(actorProof.resourceOid) === target.oid && actorProof.nonce === target.nonce
    && (!actorProof.actorId || actorProof.actorId === actorId) && business.maintenanceAdminId === actorId, fail + ":actor");
  const readback = evidence.readback;
  assert(sameTarget(readback?.identity) && readback.identity.marker === "zzsh:regression-test:v1" && readback.identity.read_only === "on"
    && readback.rollbackAck === true && readback.clientClosed === true && readback.admins?.allActive === true
    && readback.admins?.twoFactor === true && readback.admins?.onlyNewUids === true
    && readback.admins?.oldSessions === 0 && Number.isSafeInteger(readback.admins?.count) && readback.admins.count >= 3, fail + ":readback");
  if (input.growth) {
    const policy = evidence.policy, actual = readback.policy;
    assert(policy?.status === "FORMAL_LOCAL_POLICY_INITIALIZED" && policy.executionStatus === "SUCCEEDED" && policy.oldApprovalsCopied === false
      && policy.approvalRequestId && policy.policyId === input.growth.policyId
      && Date.parse(policy.effectiveAtUtc) === Date.parse(input.growth.policyEffectiveAt)
      && actual?.id === policy.policyId && actual.status === "APPROVED" && actual.effectiveNow === true
      && actual.newApprovalRequestId === policy.approvalRequestId && actual.requestStatus === "EXECUTED"
      && actual.decision === "APPROVED" && actual.executionStatus === "SUCCEEDED" && actual.onlyNewBossRelations === true
      && Date.parse(actual.effectiveAtUtc) === Date.parse(input.growth.policyEffectiveAt), fail + ":policy");
  }
  return { status: "TARGET_BOUND_BOOTSTRAP_EVIDENCE_VERIFIED", database: "zzsh_test_regression", oid: target.oid, nonce: target.nonce };
}

/** Offline assessment: historical artifacts prove their recorded run, not current target state. */
export function assessRoundEvidence({ input, inputSha256, actorProof, receipt, checkpoint, readback, expected, growth, checkpointInput = input, checkpointActorProof = actorProof, requireStageAcks = true, requireReadback = true, requireGrowth = true }) {
  const issues = [], target = input.target;
  let invitationClosure = false;
  try { invitationClosure = requiresInvitationCountClosure(expected?.dataset); }
  catch { issues.push("ROUND_INVITATION_SCOPE_UNPROVEN"); }
  const sameTarget = value => value && String(value.oid) === target.oid && value.nonce === target.nonce
    && (!target.instance || JSON.stringify(value.instance ?? null) === JSON.stringify(target.instance));
  if (!receipt || receipt.schema !== "zzsh.local-round-receipt.v1" || receipt.inputSha256 !== inputSha256
    || receipt.datasetSha256 !== input.dataset.sha256 || !sameTarget(receipt.target)
    || JSON.stringify(receipt.target?.schemaHashes) !== JSON.stringify(target.schemaHashes)
    || (receipt.strictBatch ?? false) !== (input.strictBatch === true)) issues.push("ROUND_RECEIPT_BINDING_MISMATCH");
  const stages = Array.isArray(receipt?.stages) ? receipt.stages : [];
  const stageIndex = name => {
    const indexes = stages.map((item, i) => item && typeof item === "object" && item.name === name ? i : -1).filter(i => i >= 0);
    if (!indexes.length) return -1;
    const i = indexes.at(-1), row = stages[i];
    return row.status === "ACK" && row.code === 0 && row.signal === null && row.metrics && typeof row.metrics === "object" ? i : -1;
  };
  const checkStages = names => {
    let previous = -1;
    for (const name of names) {
      const index = stageIndex(name);
      if (index < 0) issues.push("ROUND_STAGE_NOT_ACKNOWLEDGED:" + name);
      else if (index <= previous) issues.push("ROUND_STAGE_ORDER_INVALID:" + name);
      if (index >= 0) previous = index;
    }
  };
  if (requireStageAcks) checkStages(requiredDatasetStages);
  const actorId = checkpointActorProof?.id ?? checkpointActorProof?.actorId;
  if (!checkpoint || checkpoint.schema !== "zzsh.local-legacy-load.v1" || !sameTarget(checkpoint.binding)
    || checkpoint.binding.database !== "zzsh_test_regression" || checkpoint.binding.datasetSha256 !== input.dataset.sha256
    || checkpoint.binding.actorId !== actorId || checkpoint.binding.sessionId !== checkpointActorProof?.sessionId || checkpoint.pending !== null
    || (checkpoint.strictBatch ?? false) !== (checkpointInput.strictBatch === true)
    || JSON.stringify(checkpoint.schemaHashes) !== JSON.stringify(checkpointInput.target.schemaHashes)
    || JSON.stringify(checkpoint.executionWindow ?? null) !== JSON.stringify(checkpointInput.window ?? null)
    || ["poolClosed", "unlock", "maintenanceClosed", "rollbackConfirmed"].some(key => checkpoint[key] !== true)
    || !knownLoadStatuses.has(checkpoint.status)) {
    issues.push("ROUND_CHECKPOINT_UNCONFIRMED");
  } else {
    const excludedGuarantee = checkpointInput.target?.bootstrapReservation === "ROUND07_BOOTSTRAP_RESERVED"
      && checkpoint.fundsSupplement?.coverage?.guarantees?.policyExcluded === true
      && ["selected", "planned", "writer"].every(key => checkpoint.fundsSupplement.coverage.guarantees[key] === 0)
      && checkpoint.fundsSupplement.coverage.guarantees.listingDeposit?.targetRows === 0
      && checkpoint.generatedPhases?.guaranteeHistory?.rows === 0
      && checkpoint.generatedPhases.guaranteeHistory.sha256 === createHash("sha256").update("[]").digest("hex");
    for (const phase of loadPhases) {
      const value = checkpoint.phases?.[phase];
      if (phase === "guaranteeHistory" && !value && excludedGuarantee) continue;
      if (!value?.complete || value.quarantined !== 0 || !Number.isSafeInteger(value.nextIndex)) issues.push("ROUND_PHASE_INCOMPLETE:" + phase);
    }
    if(invitationClosure){
      const phase=checkpoint.phases?.invitationCounts, expectedPackets=expected.dataset.invitationFacts.selectedPackets;
      if(!phase?.complete || phase.quarantined!==0 || phase.nextIndex!==expectedPackets
        || checkpoint.phases?.invitationFacts?.nextIndex!==expectedPackets) issues.push("ROUND_INVITATION_COUNT_CLOSURE_INCOMPLETE");
    }
    const counts = { users: expected?.dataset?.domains?.users?.ready, accounts: expected?.dataset?.domains?.accounts?.ready,
      orders: expected?.dataset?.domains?.orders?.ready, continuationEvidence: expected?.dataset?.domains?.continuations?.parameterComplete,
      accountDisplay: expected?.display?.rows, storedOpening: expected?.openings?.stats?.candidate, skinHoldings: checkpoint.skinHoldingsPreparation?.ready };
    for (const [name, count] of Object.entries(counts)) if (!Number.isSafeInteger(count) || checkpoint.phases?.[name]?.nextIndex !== count) issues.push("ROUND_PHASE_COUNT_DRIFT:" + name);
    if (!Number.isSafeInteger(checkpoint.skinHoldingsPreparation?.isolated)
      || checkpoint.skinHoldingsPreparation.ready + checkpoint.skinHoldingsPreparation.isolated !== expected?.dataset?.domains?.accounts?.ready) issues.push("ROUND_HOLDINGS_DENOMINATOR_DRIFT");
  }
  if (requireReadback && (!readback || readback.schema !== "zzsh.local-dataset-readback.v1" || !sameTarget(readback.resource)
    || readback.resource.database !== "zzsh_test_regression" || readback.sourceDatasetSha256 !== input.dataset.sha256
    || readback.status !== "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED" || readback.differenceCount !== 0
    || readback.targetWrites !== 0 || !readback.rollbackConfirmed || !readback.lockReleased || !readback.connectionsClosed)) issues.push("ROUND_DATASET_READBACK_UNCONFIRMED");
  else if (requireReadback) {
    if(invitationClosure){
      const closure=readback.invitationFacts?.childCountClosure, facts=expected.dataset.invitationFacts;
      if(closure?.status!=="VERIFIED" || closure.packets!==facts.selectedPackets || closure.auditsMatched!==facts.selectedPackets
        || closure.subjects!==facts.subjects || closure.matched!==facts.subjects
        || !Number.isSafeInteger(closure.known) || !Number.isSafeInteger(closure.unknown) || closure.known+closure.unknown!==facts.subjects)
        issues.push("ROUND_INVITATION_COUNT_READBACK_UNCONFIRMED");
      const sourceRatio=expected?.display?.accountBaseRatio, ratio=readback?.display?.accountBaseRatio, total=expected?.display?.rows;
      if(sourceRatio?.scope!=="ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT" || !Number.isSafeInteger(sourceRatio.known) || sourceRatio.known<0
        || !Number.isSafeInteger(sourceRatio.unknown) || sourceRatio.unknown<0 || sourceRatio.known+sourceRatio.unknown!==total
        || ratio?.scope!==sourceRatio.scope || ratio.status!=="VERIFIED" || ratio.expected!==total || ratio.matched!==total
        || ratio.known!==sourceRatio.known || ratio.unknown!==sourceRatio.unknown) issues.push("ROUND_ACCOUNT_CAPTURE_RATIO_READBACK_UNCONFIRMED");
      const sourcePayout=expected?.display?.accountFullPayout,payout=readback?.display?.accountFullPayout;
      const payoutKeys=['selected','unselected','unknown'];
      if(sourcePayout?.scope!=="ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT" || payoutKeys.some(key=>!Number.isSafeInteger(sourcePayout[key])||sourcePayout[key]<0)
        || payoutKeys.reduce((sum,key)=>sum+sourcePayout[key],0)!==total || payout?.scope!==sourcePayout.scope || payout.status!=="VERIFIED"
        || payout.expected!==total || payout.matched!==total || payoutKeys.some(key=>payout[key]!==sourcePayout[key])) issues.push("ROUND_ACCOUNT_CAPTURE_PAYOUT_READBACK_UNCONFIRMED");
    }
    for (const domain of ["users", "accounts", "orders"]) if (!Number.isSafeInteger(expected?.dataset?.domains?.[domain]?.ready) || readback.domains?.[domain]?.expected !== expected.dataset.domains[domain].ready) issues.push("ROUND_READBACK_COUNT_DRIFT:" + domain);
    for (const [domain, count] of Object.entries({ display: expected?.display?.rows, openings: expected?.openings?.stats?.candidate,
      holdings: checkpoint?.skinHoldingsPreparation?.ready, paths: expected?.paths?.accounts })) {
      if (!Number.isSafeInteger(count) || readback[domain]?.expected !== count || readback[domain]?.matched !== count) issues.push("ROUND_READBACK_COUNT_DRIFT:" + domain);
    }
    const empty=checkpoint?.generatedPhases?.financeEmptyCoverage;
    if(empty?.schema==="zzsh.empty-coverage-chunks.v1" && (readback.emptyFinancialCoverage?.sourceRebuilt!==true
      ||readback.emptyFinancialCoverage.expected!==empty.rows||readback.emptyFinancialCoverage.readable!==empty.rows
      ||readback.emptyFinancialCoverage.actual!==empty.rows||readback.emptyFinancialCoverage.chunks!==empty.chunks?.length)) issues.push("ROUND_EMPTY_COVERAGE_READBACK_UNCONFIRMED");
    const guarantee=checkpoint?.fundsSupplement?.coverage?.guarantees;
    if(guarantee?.policyExcluded===true && (readback.ownerGuaranteeHistory?.policyExcluded!==true
      ||readback.ownerGuaranteeHistory.expected!==0||readback.ownerGuaranteeHistory.actual!==0)) issues.push("ROUND_GUARANTEE_EXCLUSION_READBACK_UNCONFIRMED");
  }
  const dataset = issues.length === 0 ? "PASS" : "INCOMPLETE";
  if (!requireGrowth) return { status: issues.length ? "INCOMPLETE" : "COMPLETE", dataset, growth: "NOT_ASSESSED", issues };
  if (!input.growth) issues.push("ROUND_GROWTH_NOT_PLANNED");
  else {
    checkStages(requiredGrowthStages);
    if (stageIndex("readback") >= 0 && stageIndex("growth-prepare") >= 0 && stageIndex("growth-prepare") <= stageIndex("readback")) issues.push("ROUND_STAGE_ORDER_INVALID:growth-prepare");
    const { prepare, manifest, apply, readback: result, manifestSha256 } = growth ?? {};
    const binding = item => item && item.inputSha256 === inputSha256 && item.datasetSha256 === input.dataset.sha256 && sameTarget(item);
    try { assertGrowthPlanEvidence({ input, inputSha256, expected, prepare, manifest, manifestSha256 }); }
    catch { issues.push("ROUND_GROWTH_PREPARE_UNCONFIRMED"); }
    if (!binding(apply) || apply.mode !== "--apply" || apply.status !== "APPLIED_COMMIT_ACK_INDEPENDENT_READBACK_REQUIRED"
      || apply.manifestSha256 !== manifestSha256 || !apply.poolClosed || !apply.unlockAck || !apply.lockClosed
      || apply.fundsWrites !== 0 || apply.pending !== null || apply.completed !== prepare?.summary?.users || apply.inserted !== prepare?.summary?.contributions
      || apply.replayed !== 0 || apply.complete !== prepare?.summary?.complete || apply.partial !== prepare?.summary?.pending) issues.push("ROUND_GROWTH_APPLY_UNCONFIRMED");
    if (!binding(result) || result.mode !== "--readback" || result.status !== "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED"
      || result.manifestSha256 !== manifestSha256 || !result.readOnlyRollbackAck || !result.readOnlyClientClosed || result.fundsWrites !== 0
      || result.summary?.coverage !== prepare?.summary?.users || result.summary?.contributions !== prepare?.summary?.contributions
      || result.summary?.complete !== prepare?.summary?.complete || result.summary?.pending !== prepare?.summary?.pending) issues.push("ROUND_GROWTH_READBACK_UNCONFIRMED");
  }
  return { status: issues.length ? "INCOMPLETE" : "COMPLETE", dataset, growth: !input.growth ? "NOT_PLANNED" : issues.some(x => x.startsWith("ROUND_GROWTH_") || requiredGrowthStages.some(stage => x.endsWith(":" + stage))) ? "INCOMPLETE" : "PASS", issues };
}

/** Resume growth only after the old checkpoint is complete and still bound to its original actor/window. */
export function assertResumeLineage({ input, previousInput, previousInputSha256, previousReceipt, previousActorProof, checkpoint, expected }) {
  const fail = "ROUND_RESUME_LINEAGE_MISMATCH";
  assert(input.resume?.schema === "zzsh.local-round-growth-resume.v1" && input.growth && previousInput?.schema === "zzsh.local-round.v1", fail);
  assert(previousInputSha256 === input.resume.previousInput?.sha256 && previousReceipt?.inputSha256 === previousInputSha256, fail);
  assert(Array.isArray(previousReceipt.stages) && previousReceipt.stages.length > 0
    && !previousReceipt.stages.some(stage => stage?.name === "growth-apply"), "ROUND_RESUME_PRIOR_GROWTH_ATTEMPT_REQUIRES_RECOVERY");
  for (const key of ["source", "dataset", "funds", "refundAttempts", "display", "openings", "paths", "pathSourcePlan", "dictionary", "holdingOverlay"]) {
    const before = previousInput[key], after = input[key];
    assert((key === "holdingOverlay" && !before && !after) || (before && after && /^[a-f0-9]{64}$/.test(before.sha256 ?? "") && before.sha256 === after.sha256), fail + ":" + key);
  }
  assert(previousInput.target?.oid === input.target.oid && previousInput.target?.nonce === input.target.nonce
    && previousInput.target?.migrationRoleOid === input.target.migrationRoleOid
    && JSON.stringify(previousInput.target?.instance ?? null) === JSON.stringify(input.target?.instance ?? null)
    && JSON.stringify(previousInput.target?.schemaHashes) === JSON.stringify(input.target.schemaHashes)
    && (previousInput.strictBatch === true) === (input.strictBatch === true), fail + ":target");
  const baseline = assessRoundEvidence({ input: previousInput, inputSha256: previousInputSha256, actorProof: previousActorProof,
    receipt: previousReceipt, checkpoint, expected, requireStageAcks: false, requireReadback: false, requireGrowth: false });
  assert(baseline.status === "COMPLETE", "ROUND_RESUME_ORIGINAL_CHECKPOINT_UNCONFIRMED");
  return { status: "ORIGINAL_COMPLETE_CHECKPOINT_BOUND", previousInputSha256, datasetSha256: input.dataset.sha256, oid: input.target.oid, nonce: input.target.nonce };
}

/** A readback repair may change only the explicitly sealed scripts; every other byte stays original. */
export function assertReadbackRecoveryOverlay(manifest,{input,previousReceipt,originalFiles,observedFiles,scriptDir,proofSha256}) {
  const fail="ROUND_READBACK_RECOVERY_OVERLAY_INVALID",changed=["local-funds-plan.mjs","local-round-contract.mjs","readback-local-dataset.mjs","run-local-round.mjs"].sort();
  assert(input?.target?.bootstrapReservation==="ROUND07_BOOTSTRAP_RESERVED" && input.resume?.schema==="zzsh.local-round-growth-resume.v1"
    && manifest?.schema==="zzsh.round07-readback-recovery-overlay.v1" && manifest.scriptDir===scriptDir
    && manifest.previousInputSha256===input.resume.previousInput?.sha256 && manifest.previousReceiptSha256===input.resume.previousReceipt?.sha256
    && manifest.checkpointSha256===input.resume.checkpoint?.sha256 && manifest.dependencyProofSha256===proofSha256
    && previousReceipt?.status==="STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS" && previousReceipt.failure?.stage==="readback"
    && !previousReceipt.stages?.some(row=>row?.name==="growth-apply") && Array.isArray(manifest.changed)
    && JSON.stringify([...manifest.changed].sort())===JSON.stringify(changed),fail);
  const expectedStages=["core-and-funds","display","opening","holdings","paths"],stages=previousReceipt.stages??[];
  assert(stages.length===6&&expectedStages.every((name,index)=>stages[index]?.name===name&&stages[index].status==="ACK"&&stages[index].code===0&&stages[index].signal===null)
    &&stages[5]?.name==="readback"&&stages[5].status==="INTENT"&&stages[5].code!==0,fail);
  const names=Object.keys(originalFiles??{}).sort();
  assert(names.length>0&&JSON.stringify(Object.keys(manifest.files??{}).sort())===JSON.stringify(names)
    &&JSON.stringify(Object.keys(observedFiles??{}).sort())===JSON.stringify(names),fail);
  for(const name of names){const row=manifest.files[name],actual=observedFiles[name],original=originalFiles[name];
    assert(row?.before===original&&row.after===actual&&/^[a-f0-9]{64}$/.test(actual??"")
      &&(changed.includes(name)?actual!==original:actual===original),fail);
  }
  return {status:"READBACK_RECOVERY_OVERLAY_BOUND",changed:changed.length};
}

/** A failed read-only growth preparation can be retried only with its original evidence intact. */
export function assertGrowthRuleRetry({input,previousInput,previousReceipt,summary,readback,rulesEvidence}) {
  const fail="ROUND_GROWTH_RULE_RETRY_UNCONFIRMED",refs=input.resume?.previousRepair;
  assert(refs&&["input","receipt","summary","readback","rulesEvidence"].every(key=>/^[a-f0-9]{64}$/.test(refs[key]?.sha256??""))
    &&previousReceipt?.schema==="zzsh.local-round-receipt.v1"&&previousReceipt.mode==="RESUME_GROWTH"
    &&previousReceipt.status==="STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS"&&previousReceipt.inputSha256===refs.input.sha256
    &&previousReceipt.failure?.stage==="growth-prepare"&&previousReceipt.stages?.length===3
    &&["schema-preflight","readback"].every((name,index)=>previousReceipt.stages[index]?.name===name&&previousReceipt.stages[index].status==="ACK"&&previousReceipt.stages[index].code===0&&previousReceipt.stages[index].signal===null)
    &&previousReceipt.stages[2]?.name==="growth-prepare"&&previousReceipt.stages[2].status==="INTENT"&&previousReceipt.stages[2].code!==0
    &&previousReceipt.stages[1].metrics?.evidenceSha256===refs.readback.sha256,fail);
  assert(summary?.schema==="zzsh.local-growth-round-receipt.v1"&&summary.mode==="--prepare"&&summary.inputSha256===refs.input.sha256
    &&summary.status==="STOPPED_PRESERVE_ORIGINAL_EVIDENCE"&&summary.error?.message==="REVIEWED_OLD_RULE_FILES_REQUIRED"
    &&summary.readOnlyRollbackAck===true&&summary.readOnlyClientClosed===true&&summary.fundsWrites===0
    &&summary.oid===input.target.oid&&summary.nonce===input.target.nonce,fail);
  assert(readback?.schema==="zzsh.local-dataset-readback.v1"&&readback.status==="CORE_SOURCE_TARGET_EXACT_READBACK_PASSED"
    &&readback.differenceCount===0&&readback.targetWrites===0&&readback.rollbackConfirmed===true&&readback.lockReleased===true&&readback.connectionsClosed===true
    &&readback.sourceDatasetSha256===input.dataset.sha256&&readback.resource?.oid===input.target.oid&&readback.resource?.nonce===input.target.nonce
    &&JSON.stringify(readback.resource?.instance??null)===JSON.stringify(input.target.instance??null),fail);
  assert.deepEqual(input.growth?.oldRuleFiles,rulesEvidence?.growth?.oldRuleFiles,fail);
  const normalized=structuredClone(input);normalized.out=previousInput.out;normalized.resume.readbackRepair=previousInput.resume?.readbackRepair;
  delete normalized.resume.previousRepair;delete normalized.growth.oldRuleFiles;
  assert.deepEqual(normalized,previousInput,fail);
  return {status:"READ_ONLY_GROWTH_PREPARATION_FAILURE_BOUND",fundsWrites:0};
}

/** A continuation proves fresh reads and growth stages; it never relabels old INTENTs as ACKs. */
export function assessResumeStages(receipt, input) {
  const names = ["schema-preflight", "readback", "growth-prepare", "growth-attempt-reservation", "growth-apply", "growth-readback", "readback-final"];
  const stages = Array.isArray(receipt?.stages) ? receipt.stages : [], issues = [];
  if (receipt?.mode !== "RESUME_GROWTH" || ["previousInput", "previousReceipt", "checkpoint"].some(key =>
    !input?.resume?.[key] || receipt.prior?.[key]?.path !== input.resume[key].path || receipt.prior?.[key]?.sha256 !== input.resume[key].sha256)) issues.push("ROUND_RESUME_RECEIPT_LINEAGE_MISMATCH");
  let previous = -1;
  for (const name of names) {
    const matches = stages.map((row, index) => row && typeof row === "object" && row.name === name ? index : -1).filter(index => index >= 0);
    const index = matches.at(-1), row = index === undefined ? null : stages[index];
    if (!row || row.status !== "ACK" || row.code !== 0 || row.signal !== null || !row.metrics || typeof row.metrics !== "object") issues.push("ROUND_RESUME_STAGE_NOT_ACKNOWLEDGED:" + name);
    else if (index <= previous) issues.push("ROUND_RESUME_STAGE_ORDER_INVALID:" + name);
    if (index !== undefined) previous = index;
  }
  const preflight = stages.find(row => row?.name === "schema-preflight" && row.status === "ACK")?.metrics;
  if (preflight?.status !== "LIVE_SCHEMA_READ_ONLY_VERIFIED" || preflight.oid !== receipt?.target?.oid || preflight.nonce !== receipt?.target?.nonce
    || preflight.rollbackAck !== true || preflight.closed !== true) issues.push("ROUND_RESUME_SCHEMA_PREFLIGHT_UNCONFIRMED");
  return { status: issues.length ? "INCOMPLETE" : "COMPLETE", issues };
}

/** Live check is read-only and ends before any independent readback or growth write. */
export async function verifyResumeSchema(client, { target, migrationName }) {
  let begun = false, rollbackAck = false, closed = false, failure;
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
    const identity = (await client.query(`SELECT current_database() database,d.oid::text,pg_get_userbyid(d.datdba) owner,shobj_description(d.oid,'pg_database') marker,current_setting('zzsh.regression_run') nonce,current_user role,r.oid::text role_oid,current_setting('transaction_read_only') read_only,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,(SELECT system_identifier::text FROM pg_control_system()) system_identifier FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
    assert(identity?.database === "zzsh_test_regression" && identity.oid === target.oid && identity.nonce === target.nonce
      && identity.owner === "zzsh" && identity.marker === "zzsh:regression-test:v1" && identity.role === migrationName
      && identity.role_oid === target.migrationRoleOid && identity.read_only === "on"
      && (!target.instance || identity.system_identifier === target.instance.systemIdentifier)
      && identity.rolsuper === false && identity.rolcreatedb === false && identity.rolcreaterole === false && identity.rolbypassrls === false, "ROUND_RESUME_LIVE_TARGET_CHANGED");
    const hashes = (await client.query("SELECT hash FROM zzsh_business_meta.migrations ORDER BY id")).rows.map(row => row.hash);
    assert.deepEqual(hashes, target.schemaHashes, "ROUND_RESUME_LIVE_SCHEMA_CHANGED");
  } catch (error) { failure = error; }
  finally {
    if (begun) try { rollbackAck = (await client.query("ROLLBACK")).command === "ROLLBACK"; } catch { rollbackAck = false; }
    try { await client.end(); closed = true; } catch { closed = false; }
  }
  if (failure) { failure.resumeCleanup = { rollbackAck, closed }; throw failure; }
  if (!rollbackAck || !closed) throw Object.assign(new Error("ROUND_RESUME_READ_ONLY_CLEANUP_UNCONFIRMED"), { resumeCleanup: { rollbackAck, closed } });
  return { status: "LIVE_SCHEMA_READ_ONLY_VERIFIED", oid: target.oid, nonce: target.nonce, rollbackAck, closed };
}
