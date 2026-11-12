import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertRentalReferenceReceipt } from "./business-reference-readiness.mjs";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { LEGACY_DATASET_PREPARATION_TOOLS, assertCapturedSourceOrigin, expectedContinuationImports, readSourceRows } from "./local-source-adapter.mjs";
import { sameGrowthInstance, validateGrowthPackageLayout, verifyGrowthPackageBytes } from "./local-growth-packages.mjs";
import { hasVerifiedNextInitialSchema, NEXT_MIGRATION_PROFILE } from "./local-target-registry.mjs";
import { legacyListedTargetMatches } from "./selected-business-scope.mjs";

const requiredDatasetStages = ["core-and-funds", "display", "opening", "holdings", "paths", "readback"];
const requiredGrowthStages = ["growth-prepare", "growth-apply", "growth-readback"];
const loadPhases = ["users", "accounts", "orders", "invitationFacts", "financeHistory", "financeEmptyCoverage", "guaranteeHistory", "continuationEvidence", "liabilityDuties", "completedCommissions", "accountDisplay", "storedOpening", "skinHoldings"];
const knownLoadStatuses = new Set(["LOCAL_DATASET_CORE_AND_FINANCIAL_DOMAINS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_DISPLAY_ENRICHMENT_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_STORED_OPENINGS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED", "FAILED_ROLLED_BACK"]);

/** A new round must not silently reuse an unproven old restore or mix source captures. */
export function assertRoundSourceOrigin(input,source,dataset,binding,funds,refund,workflow,workflowInput) {
  if(input.target?.migrationProfile!==NEXT_MIGRATION_PROFILE)return;
  const ref=input.sourceBinding,workflowRef=input.sourceWorkflow;
  assert(ref&&typeof ref.path==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256??'')&&binding?.schema==='zzsh.local-source-origin.v2','ROUND_SOURCE_RESTORE_PROOF_REQUIRED');
  const sameRef=(a,b)=>a&&b&&isAbsolute(a.path??'')&&isAbsolute(b.path??'')&&resolve(a.path).toLowerCase()===resolve(b.path).toLowerCase()&&a.sha256===b.sha256&&/^[a-f0-9]{64}$/.test(a.sha256??'');
  assert(workflowRef&&/^[a-f0-9]{64}$/.test(workflowRef.sha256??'')&&workflow?.schema==='zzsh.local-source-workflow-receipt.v1'
    &&workflow.status==='SOURCE_CAPTURED_DATASET_NOT_PREPARED'&&workflow.targetWrites===0&&workflow.automaticCleanup===false
    &&workflow.input?.sha256===workflow.inputSha256&&/^[a-f0-9]{64}$/.test(workflow.inputSha256??'')
    &&Array.isArray(workflow.stages)&&workflow.stages.length===6
    &&['prepare','restore','capture','finance','refund','verify'].every((name,i)=>workflow.stages[i]?.name===name&&workflow.stages[i].status==='ACK'&&Number.isSafeInteger(workflow.stages[i].wallMs)&&workflow.stages[i].wallMs>=0)
    &&sameRef(workflow.result?.source,input.source)&&sameRef(workflow.result?.funds,input.funds)&&sameRef(workflow.result?.refundAttempts,input.refundAttempts)
    &&sameRef(workflow.result?.sourceBinding,ref)&&workflow.result?.containerId===binding.container?.id,
    'ROUND_SOURCE_WORKFLOW_PROOF_REQUIRED');
  assert(workflowInput?.schema==='zzsh.local-source-workflow.v1'&&binding.container.name==='zzsh-migration-mysql-'+workflowInput.suffix
    &&workflowInput.imageId===binding.container.imageId&&isAbsolute(workflowInput.dump??'')&&resolve(workflowInput.dump).toLowerCase()===resolve(binding.restoreRecord.dumpPath??'').toLowerCase()
    &&workflowInput.exportStartedAt===binding.restoreRecord.exportStartedAt&&workflowInput.cutoff===binding.restoreRecord.cutoff
    &&isAbsolute(workflowInput.out??'')&&resolve(workflowInput.out).toLowerCase()===resolve(dirname(workflow.result.source.path)).toLowerCase(),
    'ROUND_SOURCE_WORKFLOW_INPUT_CHANGED');
  for(const receipt of [source,funds,refund])assertCapturedSourceOrigin(receipt,binding,ref.sha256);
  assert(dataset?.sourceReceiptSha256===input.source?.sha256&&dataset.sourceOrigin?.bindingSha256===ref.sha256
    &&dataset.sourceOrigin?.dumpSha256===binding.restoreRecord?.dumpSha256&&dataset.sourceCutoff===binding.restoreRecord?.cutoff
    &&funds.sourceSupplement?.baseReceiptSha256===input.source.sha256&&refund.sourceSupplement?.baseReceiptSha256===input.source.sha256,
    'ROUND_SOURCE_RESTORE_BINDING_CHANGED');
}

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
export function createInvitationCountPacketVerifier(manifest, invitation) {
  if (!requiresInvitationCountClosure(manifest)) return false;
  if (!invitation || typeof invitation.prepareLegacyInvitationFacts !== "function" || typeof invitation.invitationFactHash !== "function")
    throw new Error("INVITATION_PACKET_POPULATION_UNPROVEN");
  const users = new Set(), legacyIds = [], codes = new Set(), codeFacts = new Map(), sourceHashes = new Set(); let source, qualifications = 0, count = 0;
  const add = packet => {
    if (++count > manifest.invitationFacts.selectedPackets) throw new Error("INVITATION_PACKET_POPULATION_UNPROVEN");
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
  };
  const finish = () => {
    legacyIds.sort();
    if (count !== manifest.invitationFacts.selectedPackets || users.size !== manifest.domains.users.source || (users.size > 0 && (sourceHashes.size !== 1
      || qualifications!==source.files.qualification.rows
      || invitation.invitationFactHash(legacyIds) !== source.subjectSetDigest
      || invitation.invitationFactHash(legacyIds.map(id=>[id,...codeFacts.get(id)])) !== source.codeSetDigest)))
      throw new Error("INVITATION_PACKET_POPULATION_UNPROVEN");
    return true;
  };
  return {add,finish};
}
export function assertInvitationCountPackets(manifest, packets, invitation) {
  const verifier=createInvitationCountPacketVerifier(manifest,invitation);
  if (!verifier) return false;
  if (!Array.isArray(packets)) throw new Error("INVITATION_PACKET_POPULATION_UNPROVEN");
  for (const packet of packets) verifier.add(packet);
  return verifier.finish();
}

async function* checkedInvitationPackets(file, expectedSha256, expectedPacketHashes) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) throw new Error("INVITATION_FILE_BINDING_REQUIRED");
  const digest=createHash("sha256");let count=0;
  for await(const packet of readSourceRows(file,chunk=>digest.update(chunk))) {
    const packetHash=createHash("sha256").update(JSON.stringify(packet)).digest("hex");
    if(expectedPacketHashes && packetHash!==expectedPacketHashes[count]) throw new Error("INVITATION_PACKET_CHANGED");
    count++;yield {packet,packetHash};
  }
  if(expectedPacketHashes && count!==expectedPacketHashes.length) throw new Error("INVITATION_PACKET_COUNT_CHANGED");
  if(digest.digest("hex")!==expectedSha256) throw new Error("INVITATION_FILE_SHA_MISMATCH");
  // Also re-open the named file: replacement after buffering must stop the phase.
  const current=createHash("sha256");for await(const chunk of createReadStream(file))current.update(chunk);
  if(current.digest("hex")!==expectedSha256) throw new Error("INVITATION_FILE_SHA_MISMATCH");
}

/** No packet payload survives preflight; each write pass rechecks its preflight digest and file. */
export async function preflightInvitationFile(file, fileSha256, manifest, invitation) {
  const verifier=createInvitationCountPacketVerifier(manifest,invitation);
  if(!verifier) throw new Error("INVITATION_FULL_USER_SCOPE_UNPROVEN");
  const hashes=[];for await(const {packet,packetHash} of checkedInvitationPackets(file,fileSha256)) {verifier.add(packet);hashes.push(packetHash);}
  verifier.finish();return hashes;
}
export async function* readBoundInvitationPackets(file,fileSha256,packetHashes) {
  if(!Array.isArray(packetHashes) || packetHashes.some(hash=>!/^[a-f0-9]{64}$/.test(hash))) throw new Error("INVITATION_PACKET_BINDING_REQUIRED");
  for await(const {packet} of checkedInvitationPackets(file,fileSha256,packetHashes)) yield packet;
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
  assert(input.growth?.packageLayout===undefined||input.growth.packageLayout==='PACKED_V2',"ROUND_GROWTH_PREPARE_UNCONFIRMED");
  const packed=input.growth?.packageLayout==='PACKED_V2';
  assert(input.growth?.approvalLayout === undefined || packed && input.growth.approvalLayout === 'INLINE_INTENT_V1', 'ROUND_GROWTH_PREPARE_UNCONFIRMED');
  const sameTarget = item => item && item.oid === input.target.oid && item.nonce === input.target.nonce
    && (!packed || sameGrowthInstance(item.instance, input.target.instance))
    && (item.migrationProfile ?? null) === (input.target.migrationProfile ?? null);
  let cutoff = null;
  try { cutoff = new Date(expected.dataset.sourceCutoff).toISOString().replace(/\.(\d{3})Z$/, (_, ms) => "." + ms + "000Z"); } catch { /* missing cutoff is not evidence */ }
  const digest = buildDigest(input.buildFiles);
  assert(prepare && prepare.inputSha256 === inputSha256 && prepare.datasetSha256 === input.dataset.sha256 && sameTarget(prepare)
    && prepare.mode === "--prepare" && prepare.status === "PREPARED_NOT_APPLIED" && prepare.readOnlyRollbackAck === true && prepare.readOnlyClientClosed === true
    && (input.target.migrationProfile !== NEXT_MIGRATION_PROFILE || prepare.readOnlyFence === "HELD_UNTIL_ROLLBACK"
      && prepare.readOnlyMaintenanceUnlock === true && prepare.readOnlyMaintenanceClosed === true)
    && manifest && manifest.schema === (packed?"zzsh.local-growth-round-plan.v2":"zzsh.local-growth-round-plan.v1") && manifest.status === "PREPARED_NOT_APPLIED"
    && manifestSha256 === prepare.manifestSha256 && manifest.datasetSha256 === input.dataset.sha256 && sameTarget(manifest)
    && cutoff !== null && manifest.cutoff === cutoff && digest !== null && manifest.buildDigest === digest
    && manifest.policy?.id === input.growth?.policyId && Date.parse(manifest.policy?.effectiveAt) === Date.parse(input.growth?.policyEffectiveAt)
    && Array.isArray(manifest.packages) && manifest.packages.length === expected?.dataset?.domains?.users?.ready
    && prepare.summary?.users === expected?.dataset?.domains?.users?.ready && prepare.summary?.orders === expected?.dataset?.domains?.orders?.ready
    && ["users", "orders", "complete", "pending", "contributions"].every(key => manifest.summary?.[key] === prepare.summary?.[key]), "ROUND_GROWTH_PREPARE_UNCONFIRMED");
  const summary = prepare.summary, seenUsers = new Set(), seenKeys = new Set();
  if(packed)validateGrowthPackageLayout(manifest);
  assert(["users", "orders", "complete", "pending", "contributions"].every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0)
    && summary.complete + summary.pending === summary.users, "ROUND_GROWTH_PREPARE_UNCONFIRMED");
  let complete = 0, pending = 0, contributions = 0;
  for (const [index, item] of manifest.packages.entries()) {
    assert(item && (packed || item.file === "packages/" + String(index + 1).padStart(5, "0") + ".json")
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
  verifyGrowthPackageBytes(manifest,readPackage);
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
  assert(target.migrationProfile !== NEXT_MIGRATION_PROFILE || target.bootstrapReservation === "ROUND07_BOOTSTRAP_RESERVED", "ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH:schema");
  // shortcut: old receipts require activated Boss accounts; replace this gate when the first-deployment contract is verified.
  assert.notEqual(target.migrationProfile, NEXT_MIGRATION_PROFILE, "ROUND_NEXT_INITIALIZATION_CONTRACT_NOT_READY");
    const sameTarget = (value, database = true) => value && String(value.oid ?? value.resourceOid) === target.oid && value.nonce === target.nonce
    && (!database || value.database === "zzsh_test_regression")
    && (!target.instance || JSON.stringify(value.instance ?? null) === JSON.stringify(target.instance));
  const fail = "ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH";
    const runtimeEvidence = evidence.runtime ?? {};
    const actualEvidence = runtimeEvidence.actualResource ?? evidence.build?.actualResource;
    assert(binding && evidence && sameTarget(runtimeEvidence.resource) && sameTarget(actualEvidence), fail + ":runtime");
    assert((runtimeEvidence.resource.migrationProfile ?? null) === (target.migrationProfile ?? null)
      && (actualEvidence.migrationProfile ?? null) === (target.migrationProfile ?? null), fail + ":runtime-profile");
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
    && (evidence.schema.migrationProfile ?? null) === (target.migrationProfile ?? null)
    && evidence.schema.finalOrdinal >= 160 && evidence.schema.commitAck === true && evidence.schema.migrationAck === true
    && evidence.schema.readbackRollbackAck === true && evidence.schema.readbackClientClosed === true && evidence.schema.unlockAck === true && evidence.schema.maintenanceClosed === true
    && (target.migrationProfile !== NEXT_MIGRATION_PROFILE || evidence.schema.migrationProfile === NEXT_MIGRATION_PROFILE
      && evidence.schema.targetFence === "HELD_ACROSS_SCHEMA_AND_ACL" && evidence.schema.targetFenceReleased === true && evidence.schema.runtimeAclReadback === true
      && hasVerifiedNextInitialSchema(evidence.schema))
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
    && business.commitAck === true && business.maintenanceClosed === true && business.poolClosed === true && business.unlock === true
    && (target.migrationProfile !== NEXT_MIGRATION_PROFILE || business.migrationProfile === NEXT_MIGRATION_PROFILE
      && business.targetFence === "HELD_UNTIL_TRANSACTION_END"), fail + ":business");
  if (input.legal) {
    assertRentalReferenceReceipt(business);
    const validatorSha256 = createHash("sha256").update(readFileSync(new URL("./business-reference-readiness.mjs", import.meta.url))).digest("hex");
    assert.equal(business.rentalReference.validatorSha256, validatorSha256, "ROUND_RENTAL_REFERENCE_VALIDATOR_CHANGED");
  }
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
  return { status: "TARGET_BOUND_BOOTSTRAP_EVIDENCE_VERIFIED", database: "zzsh_test_regression", oid: target.oid, nonce: target.nonce,
    ...(input.legal ? { rentalReference: { targetDigest: business.rentalReference.targetDigest, businessReceiptSha256: binding.business.sha256 } } : {}) };
}

/** A newly initialized round must bind both reviewed documents to the same build and bootstrap receipt. */
export function assertRoundLegalBootstrap(input, legal, proof) {
  const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  assert(digest(input?.legal?.sha256), "ROUND_LEGAL_INPUT_REQUIRED");
  const at = legal?.effectiveAt;
  assert(legal?.schema === "zzsh.legal-initial-source.v1" && typeof at === "string"
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) && Number.isFinite(Date.parse(at))
    && new Date(at).toISOString() === at && ["INITIALIZED", "EXACT_PRESENT"].includes(proof?.status)
    && proof.inputSha256 === input.legal.sha256 && proof.effectiveAt === at
    && digest(legal.terms?.sha256) && digest(legal.privacy?.sha256)
    && proof.terms?.sourceSha256 === legal.terms.sha256 && proof.privacy?.sourceSha256 === legal.privacy.sha256
    && digest(proof.terms?.digest) && digest(proof.privacy?.digest), "ROUND_LEGAL_BOOTSTRAP_UNCONFIRMED");
  for (const file of ["legal/legal-documents.js", "auth/security-core.js", "supply/content-hash.js", "supply/supply-util.js"])
    assert(digest(legal.build?.[file]) && legal.build[file] === input.buildFiles?.[file], "ROUND_LEGAL_BUILD_CHANGED");
}

/** The API and importer must use the same independent identity keys for this database epoch. */
export function assertRoundIdentityKeyBinding(input, runtime) {
  const subject = input?.secrets?.identitySubjectHmac?.sha256, profile = input?.secrets?.identityProfile?.sha256;
  assert(/^[a-f0-9]{64}$/.test(subject ?? "") && /^[a-f0-9]{64}$/.test(profile ?? "") && subject !== profile
    && runtime?.identitySubjectKeySha256 === subject && runtime?.legacyIdentityProfileKeySha256 === profile,
  "ROUND_IDENTITY_BOOTSTRAP_UNCONFIRMED");
}

export function assertRoundPreparationTools(dataset, scripts) {
  for (const name of LEGACY_DATASET_PREPARATION_TOOLS) {
    const digest = dataset?.toolFiles?.[name];
    assert(/^[a-f0-9]{64}$/.test(digest ?? "") && digest === scripts?.[name], "ROUND_PREPARATION_TOOL_CHANGED:" + name);
  }
}

/** Count pending openings explicitly; a zero balance does not prove its historical evidence. */
export function assertRoundOpeningPartition(dataset, opening) {
  const s = opening?.stats, count = n => Number.isSafeInteger(n) && n >= 0;
  const cents = n => typeof n === "string" && /^(0|[1-9]\d{0,35})$/.test(n);
  assert(s && [s.subjects, s.candidate, s.reviewRequired, s.positiveSource, s.candidatePositive].every(count)
    && s.subjects === dataset?.domains?.users?.ready && s.candidate + s.reviewRequired === s.subjects
    && s.candidatePositive <= s.candidate && s.candidatePositive <= s.positiveSource
    && s.positiveSource <= s.subjects && s.positiveSource - s.candidatePositive <= s.reviewRequired
    && [s.sourceAvailableCents, s.candidateAvailableCents, s.reviewAvailableCents, dataset?.storedBalanceTotals?.mappedEarningsCents].every(cents)
    && s.sourceAvailableCents === dataset.storedBalanceTotals.mappedEarningsCents
    && BigInt(s.sourceAvailableCents) === BigInt(s.candidateAvailableCents) + BigInt(s.reviewAvailableCents)
    && (BigInt(s.sourceAvailableCents) > 0n) === (s.positiveSource > 0)
    && (BigInt(s.candidateAvailableCents) > 0n) === (s.candidatePositive > 0)
    && (BigInt(s.reviewAvailableCents) > 0n) === (s.positiveSource - s.candidatePositive > 0),
  "ROUND_OPENING_PARTITION_INCOMPLETE");
  return { status: s.reviewRequired ? "REVIEW_REQUIRED" : "NO_REVIEW_IN_PREPARED_INPUT", subjects: s.subjects,
    candidate: s.candidate, reviewRequired: s.reviewRequired, reviewAvailableCents: s.reviewAvailableCents };
}

/** NEXT must prove the batch receipts as well as every original coverage row. */
export function compactEmptyCoverageReadbackMatches(phase,readback){
 const proof=readback?.emptyFinancialCoverage,batch=proof?.batchProof;
 return phase?.schema==='zzsh.empty-coverage-chunks.v1'&&phase.receiptMode==='BATCH_V2'&&Array.isArray(phase.chunks)
  &&Number.isSafeInteger(phase.rows)&&phase.rows>=0&&proof?.sourceRebuilt===true&&proof.expected===phase.rows
  &&proof.readable===phase.rows&&proof.actual===phase.rows&&proof.chunks===phase.chunks.length
  &&batch?.mode==='BATCH_V2'&&batch.expected===phase.chunks.length&&batch.matched===phase.chunks.length;
}

export function systemCoreAttributionMatches(checkpoint,readback){
 const binding=checkpoint?.binding??{},pairs=[["systemUserId","legacy-user-migration"],["systemAccountId","legacy-account-migration"],["systemOrderId","legacy-order-migration"]];
 if(pairs.every(([key])=>binding[key]===undefined))return true;
 if(pairs.some(([key,prefix])=>typeof binding[key]!=="string"||!new RegExp("^"+prefix+":[a-f0-9]{64}$").test(binding[key])))return false;
 const proof=readback?.systemMigrationAttribution;
 return proof?.status==="VERIFIED"&&["users","accounts","orders"].every(domain=>Number.isSafeInteger(proof[domain]?.expected)
  &&proof[domain].expected>=0&&proof[domain].expected===proof[domain].matched&&proof[domain].expected===readback.domains?.[domain]?.expected);
}

/** Offline assessment: historical artifacts prove their recorded run, not current target state. */
export function assessRoundEvidence({ input, inputSha256, actorProof, receipt, checkpoint, readback, expected, growth, checkpointInput = input, checkpointActorProof = actorProof, requireStageAcks = true, requireReadback = true, requireGrowth = true, requireCurrentLegacyListed = true }) {
  const issues = [], target = input.target;
  if (target.migrationProfile === NEXT_MIGRATION_PROFILE && expected?.dataset?.population?.mode !== 'SELECTED_BUSINESS_SCOPE') issues.push('ROUND_NEXT_SELECTED_BUSINESS_SCOPE_REQUIRED');
  let continuationExpected;
  try { continuationExpected = expectedContinuationImports(expected?.dataset, target.migrationProfile === NEXT_MIGRATION_PROFILE); }
  catch { issues.push('ROUND_CONTINUATION_SOURCE_COVERAGE_UNPROVEN'); }
  let invitationClosure = false;
  try { invitationClosure = requiresInvitationCountClosure(expected?.dataset); }
  catch { issues.push("ROUND_INVITATION_SCOPE_UNPROVEN"); }
  const sameTarget = value => value && String(value.oid) === target.oid && value.nonce === target.nonce
    && (!target.instance || JSON.stringify(value.instance ?? null) === JSON.stringify(target.instance))
    && (value.migrationProfile ?? null) === (target.migrationProfile ?? null);
  if (!receipt || receipt.schema !== "zzsh.local-round-receipt.v1" || receipt.inputSha256 !== inputSha256
    || receipt.datasetSha256 !== input.dataset.sha256 || !sameTarget(receipt.target)
    || JSON.stringify(receipt.target?.schemaHashes) !== JSON.stringify(target.schemaHashes)
    || (receipt.strictBatch ?? false) !== (input.strictBatch === true)) issues.push("ROUND_RECEIPT_BINDING_MISMATCH");
  if (!input.resume && expected?.dataset?.identityProfiles && expected.dataset.population?.mode === "SELECTED_BUSINESS_SCOPE") {
    const { elapsedMs, ...scope } = receipt?.population?.sourceVerification ?? {};
    const domainsMatch = ["users", "accounts", "orders"].every(name => {
      const actual = scope[name], planned = expected.dataset.domains?.[name], captured = expected.dataset.population.domains?.[name]?.captured;
      return actual && Number.isSafeInteger(captured) && actual.captured === captured && actual.retained === planned?.source
        && actual.ready === planned?.ready && actual.isolated === planned?.isolated && actual.excluded === captured - actual.retained;
    });
    if (receipt?.population?.mode !== "SELECTED_BUSINESS_SCOPE" || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0
      || scope.status !== "SELECTED_SCOPE_SOURCE_AND_INPUT_VERIFIED_TARGET_NOT_RUN" || scope.sourceConnections !== 0
      || scope.targetConnections !== 0 || scope.targetWrites !== 0 || !domainsMatch
      || JSON.stringify(scope) !== JSON.stringify(checkpoint?.sourceScopeVerification)) issues.push("ROUND_SOURCE_SCOPE_CHECKPOINT_UNCONFIRMED");
  }
  if(!input.resume&&expected?.dataset?.identityProfiles){
    const p=receipt?.displayCapturePreflight,display=expected.display,accountFile=expected.dataset.files?.accounts;
    if(p?.status!=='SOURCE_DISPLAY_CAPTURE_VERIFIED_TARGET_NOT_RUN'||p.sourceReceiptSha256!==input.source?.sha256
      ||p.datasetManifestSha256!==input.dataset.sha256||p.displayManifestSha256!==input.display?.sha256
      ||!/^[a-f0-9]{64}$/.test(p.sourceSha256??'')||p.accountsSha256!==accountFile?.sha256||p.displaySha256!==display?.sha256
      ||!Number.isSafeInteger(p.sourceAccounts)||p.sourceAccounts<p.preparedAccounts||p.preparedAccounts!==expected.dataset.domains?.accounts?.ready
      ||p.displayRows!==display?.rows||p.notDisplayable!==display?.notDisplayable||p.sourceConnections!==0||p.targetConnections!==0||p.targetWrites!==0
      ||p.ratio?.known!==display?.accountBaseRatio?.known||p.ratio?.unknown!==display?.accountBaseRatio?.unknown
      ||['selected','unselected','unknown'].some(key=>p.payout?.[key]!==display?.accountFullPayout?.[key]))
      issues.push('ROUND_DISPLAY_CAPTURE_PREFLIGHT_UNCONFIRMED');
  }
  if (expected?.dataset?.identityProfiles && input.growth?.packageLayout === 'PACKED_V2') {
    const proof = receipt?.distributionSourcePreflight, source = expected.source;
    if (proof?.status !== 'DISTRIBUTION_SOURCE_PRECHECK_PASSED_TARGET_NOT_RUN' || proof.sourceReceiptSha256 !== input.source?.sha256
      || !['configurationSha256','levelsSha256','validatorSha256','policyParserSha256'].every(key => /^[a-f0-9]{64}$/.test(proof[key] ?? ''))
      || proof.configurationSha256 !== source?.files?.distributionConfig?.sha256 || proof.levelsSha256 !== source?.files?.distributionLevels?.sha256
      || proof.configurationRows !== source?.files?.distributionConfig?.rows || proof.sourceLevels !== source?.files?.distributionLevels?.rows
      || !Number.isSafeInteger(proof.activeLevels) || proof.activeLevels < 1 || !Number.isSafeInteger(proof.settlementDelayDays) || proof.settlementDelayDays < 0
      || !/^[a-f0-9]{64}$/.test(proof.policyDigest ?? '') || proof.connections !== 0 || proof.targetWrites !== 0
      || proof.validatorSha256 !== receipt.toolFiles?.['local-distribution-qualification-plan.mjs']
      || proof.policyParserSha256 !== input.buildFiles?.['finance/distribution-policy-change.js']
      || input.target?.migrationProfile === NEXT_MIGRATION_PROFILE && (proof.growthFenceGuardVersion !== 'v1'
        || proof.growthCommitGuardSha256 !== input.buildFiles?.['auth/membership-growth-legacy-cli.js'])
      || input.growth.approvalLayout === 'INLINE_INTENT_V1' && (!/^[a-f0-9]{64}$/.test(proof.growthCommitGuardSha256 ?? '')
        || proof.growthCommitGuardSha256 !== input.buildFiles?.['auth/membership-growth-legacy-cli.js']))
      issues.push('ROUND_DISTRIBUTION_SOURCE_UNCONFIRMED');
  }
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
  if (requireStageAcks && target.migrationProfile === NEXT_MIGRATION_PROFILE) {
    const pathStage = stages.filter(item => item?.name === 'paths').at(-1);
    if (pathStage?.metrics?.targetFence !== 'HELD_ACROSS_BATCHES' || pathStage.metrics.targetFenceReleased !== true)
      issues.push('ROUND_PATH_FENCE_UNCONFIRMED');
  }
  const actorId = checkpointActorProof?.id ?? checkpointActorProof?.actorId;
  if (!checkpoint || checkpoint.schema !== "zzsh.local-legacy-load.v1" || !sameTarget(checkpoint.binding)
    || checkpoint.binding.database !== "zzsh_test_regression" || checkpoint.binding.datasetSha256 !== input.dataset.sha256
    || checkpoint.binding.actorId !== actorId || checkpoint.binding.sessionId !== checkpointActorProof?.sessionId || checkpoint.pending !== null
    || (checkpoint.strictBatch ?? false) !== (checkpointInput.strictBatch === true)
    || JSON.stringify(checkpoint.schemaHashes) !== JSON.stringify(checkpointInput.target.schemaHashes)
    || JSON.stringify(checkpoint.executionWindow ?? null) !== JSON.stringify(checkpointInput.window ?? null)
    || ["poolClosed", "unlock", "maintenanceClosed", "rollbackConfirmed"].some(key => checkpoint[key] !== true)
    || checkpointInput.target?.migrationProfile === NEXT_MIGRATION_PROFILE && (checkpoint.targetFenceReleased !== true || checkpoint.protectionRecorded !== true)
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
      orders: expected?.dataset?.domains?.orders?.ready, continuationEvidence: continuationExpected,
      accountDisplay: expected?.display?.rows, storedOpening: expected?.openings?.stats?.candidate, skinHoldings: checkpoint.skinHoldingsPreparation?.ready };
    for (const [name, count] of Object.entries(counts)) if (!Number.isSafeInteger(count) || checkpoint.phases?.[name]?.nextIndex !== count) issues.push("ROUND_PHASE_COUNT_DRIFT:" + name);
    if (target.migrationProfile === NEXT_MIGRATION_PROFILE) {
      if (checkpoint.phases?.continuationEvidence?.quarantined !== 0) issues.push('ROUND_CONTINUATION_IMPORT_INCOMPLETE');
      if (['users','accounts','orders'].some(name=>{
        const domain=expected?.dataset?.domains?.[name];
        return !Number.isSafeInteger(domain?.source) || !Number.isSafeInteger(domain?.ready)
          || domain.isolated!==0 || domain.ready!==domain.source;
      })) issues.push('ROUND_SELECTED_BUSINESS_REQUIRES_REVIEW');
      const unsupported=expected?.dataset?.domains?.continuations?.unsupportedStatuses;
      if (['2','6','7'].some(status=>!Number.isSafeInteger(unsupported?.[status])||unsupported[status]!==0)
          || expected?.dataset?.domains?.continuations?.preparedEvidence?.readyIsolated!==0)
        issues.push('ROUND_LEGACY_CONTINUATION_MANUAL_REVIEW');
      if (!Array.isArray(checkpoint.quarantine) || checkpoint.quarantine.some(row => ['liabilityDuties','completedCommissions'].includes(row?.domain)))
        issues.push('ROUND_LEGACY_FINANCE_ASSEMBLY_REQUIRES_REVIEW');
      const liabilities=expected?.dataset?.domains?.liabilities?.source;
      const completedCommissions=checkpoint.fundsSupplement?.pendingCommissionCoverage?.completedDutyCandidates;
      if (!Number.isSafeInteger(liabilities) || checkpoint.phases?.liabilityDuties?.nextIndex!==liabilities
          || !Number.isSafeInteger(completedCommissions) || checkpoint.phases?.completedCommissions?.nextIndex!==completedCommissions)
        issues.push('ROUND_LEGACY_FINANCE_SOURCE_COUNT_DRIFT');
      const sourceProof=checkpoint.sourceScopeVerification, commissions=sourceProof?.continuationCommissions;
      const keys=['total','pending','settled','void','unknown','softDeletedSettled'];
      if (sourceProof?.continuationSource?.orders!==continuationExpected || sourceProof?.liabilitySource?.total!==liabilities
          || !keys.every(key=>Number.isSafeInteger(commissions?.[key])&&commissions[key]>=0)
          || commissions.pending!==checkpoint.fundsSupplement?.pendingCommissionCoverage?.continuationEvidence
          || commissions.pending+commissions.settled+commissions.void+commissions.unknown!==commissions.total
          || commissions.softDeletedSettled>commissions.settled) issues.push('ROUND_LEGACY_FINANCE_SOURCE_PROOF_UNCONFIRMED');
      else if (commissions.settled||commissions.unknown) issues.push('ROUND_LEGACY_COMMISSION_MANUAL_REVIEW');
    }
    if (!Number.isSafeInteger(checkpoint.skinHoldingsPreparation?.isolated)
      || checkpoint.skinHoldingsPreparation.ready + checkpoint.skinHoldingsPreparation.isolated !== expected?.dataset?.domains?.accounts?.ready) issues.push("ROUND_HOLDINGS_DENOMINATOR_DRIFT");
  }
  if (requireReadback && (!readback || readback.schema !== "zzsh.local-dataset-readback.v1" || !sameTarget(readback.resource)
    || readback.resource.database !== "zzsh_test_regression" || readback.sourceDatasetSha256 !== input.dataset.sha256
    || readback.status !== "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED" || readback.differenceCount !== 0
    || target.migrationProfile === NEXT_MIGRATION_PROFILE && readback.targetFence !== "HELD_UNTIL_ROLLBACK"
    || readback.targetWrites !== 0 || !readback.rollbackConfirmed || !readback.lockReleased || !readback.connectionsClosed)) issues.push("ROUND_DATASET_READBACK_UNCONFIRMED");
  else if (requireReadback) {
    if(!systemCoreAttributionMatches(checkpoint,readback))issues.push("ROUND_SYSTEM_SOURCE_ATTRIBUTION_UNCONFIRMED");
    if (target.migrationProfile === NEXT_MIGRATION_PROFILE && (requireCurrentLegacyListed
      || Object.hasOwn(readback, "legacyListedSource") || Object.hasOwn(readback, "legacyListedSourceOrigin")
      || readback.legacyListedTarget?.sourceProofSha256 !== undefined)) {
      const listed = readback.legacyListedSource, recorded = checkpoint?.sourceScopeVerification?.legacyListed;
      const binding = { sourceReceiptSha256: expected?.dataset?.sourceReceiptSha256,
        sourceAccountsSha256: expected?.source?.files?.accounts?.sha256 ?? null, sourceGamesSha256: expected?.source?.files?.games?.sha256 ?? null,
        datasetAccountsSha256: expected?.dataset?.files?.accounts?.sha256 ?? null,
        gameBindingsSha256: createHash("sha256").update(JSON.stringify(expected?.dataset?.gameBindings ?? {})).digest("hex") };
      const checkpointV2 = recorded?.schema === "zzsh.legacy-listed-source-scope.v2";
      if (binding.sourceReceiptSha256 !== input.source?.sha256 || readback.legacyListedTarget?.status !== "MAPPED_HISTORICAL_NOT_PUBLISHED"
        || readback.legacyListedSourceOrigin !== (checkpointV2 ? "CHECKPOINT_BOUND_V2" : "RECOMPUTED_FROM_BOUND_SOURCE")
        || (checkpointV2 && JSON.stringify(recorded) !== JSON.stringify(listed))
        || !legacyListedTargetMatches(listed, readback.legacyListedTarget, binding)) issues.push("ROUND_LEGACY_LISTED_READBACK_UNCONFIRMED");
      else if (listed.status !== "SOURCE_PARTITION_VERIFIED_TARGET_NOT_RUN") issues.push("ROUND_LEGACY_LISTED_SOURCE_REVIEW_REQUIRED");
    }
    if (expected?.dataset?.identityProfiles) {
      const source = expected.dataset.identityProfiles, actual = readback.identityProfiles;
      if (source.schema !== "zzsh.legacy-identity-profile-source.v1" || source.invalid !== 0
        || !Number.isSafeInteger(source.ready) || source.ready < 0 || source.verified !== source.ready
        || !/^[a-f0-9]{64}$/.test(checkpoint?.binding?.identityProfileKeyProof ?? "")
        || !/^[a-f0-9]{64}$/.test(checkpoint?.binding?.identitySubjectKeyProof ?? "")
        || actual?.expected !== source.ready || actual?.sourceMatched !== source.ready || actual?.matched !== source.ready || actual?.target !== source.ready
        || actual?.source?.closed !== true || !Number.isSafeInteger(actual?.source?.rows) || actual.source.rows < source.ready
        || !Number.isSafeInteger(actual?.source?.verified) || actual.source.verified < source.ready)
        issues.push("ROUND_IDENTITY_PROFILE_READBACK_UNCONFIRMED");
      const legal = readback.legal;
      if (!/^[a-f0-9]{64}$/.test(input.legal?.sha256 ?? "") || legal?.status !== "VERIFIED" || legal.inputSha256 !== input.legal.sha256
        || !legal.terms?.id || !legal.privacy?.id || !/^[a-f0-9]{64}$/.test(legal.terms?.digest ?? "")
        || !/^[a-f0-9]{64}$/.test(legal.privacy?.digest ?? "") || !Number.isFinite(Date.parse(legal.effectiveAt ?? "")))
        issues.push("ROUND_LEGAL_READBACK_UNCONFIRMED");
      const rental = readback.rentalReference, bootstrap = receipt?.bootstrapEvidence?.rentalReference;
      if (rental?.status !== "TARGET_CONFIG_VERIFIED" || rental.runtimeAccess !== "VERIFIED" || rental.runtimeRollbackConfirmed !== true || rental.runtimeClosed !== true
        || !/^[a-f0-9]{64}$/.test(rental.targetDigest ?? "")
        || rental.targetDigest !== bootstrap?.targetDigest || rental.businessReceiptSha256 !== input.bootstrapEvidence?.business?.sha256
        || rental.businessReceiptSha256 !== bootstrap?.businessReceiptSha256)
        issues.push("ROUND_RENTAL_REFERENCE_READBACK_UNCONFIRMED");
    }
    if(invitationClosure){
      const closure=readback.invitationFacts?.childCountClosure, facts=expected.dataset.invitationFacts;
      if(closure?.status!=="VERIFIED" || closure.packets!==facts.selectedPackets || closure.auditsMatched!==facts.selectedPackets
        || closure.subjects!==facts.subjects || closure.matched!==facts.subjects
        || !Number.isSafeInteger(closure.known) || !Number.isSafeInteger(closure.unknown) || closure.known+closure.unknown!==facts.subjects)
        issues.push("ROUND_INVITATION_COUNT_READBACK_UNCONFIRMED");
    }
    if(invitationClosure||expected?.dataset?.identityProfiles){
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
    if(target.migrationProfile===NEXT_MIGRATION_PROFILE&&!compactEmptyCoverageReadbackMatches(empty,readback))issues.push('ROUND_COMPACT_EMPTY_COVERAGE_READBACK_UNCONFIRMED');
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
      || target.migrationProfile === NEXT_MIGRATION_PROFILE && (apply.targetFence !== 'HELD_ACROSS_BATCHES' || apply.targetFenceReleased !== true)
      || apply.fundsWrites !== 0 || apply.pending !== null || apply.completed !== prepare?.summary?.users || apply.inserted !== prepare?.summary?.contributions
      || apply.replayed !== 0 || apply.complete !== prepare?.summary?.complete || apply.partial !== prepare?.summary?.pending) issues.push("ROUND_GROWTH_APPLY_UNCONFIRMED");
    if (input.growth.approvalLayout === 'INLINE_INTENT_V1' && (apply?.approvalLayout !== 'INLINE_INTENT_V1'
      || apply.approvalLog?.status !== 'INLINE_INTENTS_AND_ACKS_VERIFIED' || apply.approvalLog.startIndex !== 0
      || apply.approvalLog.completed !== prepare?.summary?.users || apply.approvalLog.lines !== prepare?.summary?.users * 2
      || !/^[a-f0-9]{64}$/.test(apply.approvalLog.sha256 ?? ''))) issues.push('ROUND_GROWTH_APPROVAL_LOG_UNCONFIRMED');
    if (!binding(result) || result.mode !== "--readback" || result.status !== "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED"
      || result.manifestSha256 !== manifestSha256 || !result.readOnlyRollbackAck || !result.readOnlyClientClosed || result.fundsWrites !== 0
      || target.migrationProfile === NEXT_MIGRATION_PROFILE && (result.readOnlyFence !== 'HELD_UNTIL_ROLLBACK'
        || result.readOnlyMaintenanceUnlock !== true || result.readOnlyMaintenanceClosed !== true)
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
  if(input.target?.migrationProfile===NEXT_MIGRATION_PROFILE)
    for(const key of ['sourceBinding','sourceWorkflow'])assert(/^[a-f0-9]{64}$/.test(previousInput[key]?.sha256??'')&&previousInput[key].sha256===input[key]?.sha256,fail+':'+key);
  assert(previousInput.target?.oid === input.target.oid && previousInput.target?.nonce === input.target.nonce
    && previousInput.target?.migrationRoleOid === input.target.migrationRoleOid
    && (previousInput.target?.migrationProfile ?? null) === (input.target.migrationProfile ?? null)
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
