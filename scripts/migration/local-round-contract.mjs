import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const requiredDatasetStages = ["core-and-funds", "display", "opening", "holdings", "paths", "readback"];
const requiredGrowthStages = ["growth-prepare", "growth-apply", "growth-readback"];
const loadPhases = ["users", "accounts", "orders", "invitationFacts", "financeHistory", "financeEmptyCoverage", "guaranteeHistory", "continuationEvidence", "liabilityDuties", "completedCommissions", "accountDisplay", "storedOpening", "skinHoldings"];
const knownLoadStatuses = new Set(["LOCAL_DATASET_CORE_AND_FINANCIAL_DOMAINS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_DISPLAY_ENRICHMENT_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_STORED_OPENINGS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED", "FAILED_ROLLED_BACK"]);

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
  const sameTarget = (value, database = true) => value && String(value.oid) === target.oid && value.nonce === target.nonce
    && (!database || value.database === "zzsh_test_regression");
  const fail = "ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH";
  assert(binding && evidence && sameTarget(evidence.runtime?.resource) && sameTarget(evidence.runtime?.actualResource), fail + ":runtime");
  assert(evidence.runtime.resource.marker === "zzsh:regression-test:v1" && evidence.runtime.actualResource.marker === "zzsh:regression-test:v1"
    && String(evidence.runtime.resource.migrationRoleOid) === target.migrationRoleOid
    && String(evidence.runtime.actualResource.migration_role_oid) === target.migrationRoleOid
    && evidence.runtime.actualResource.read_only === "on" && evidence.runtime.formalAppMounted === true, fail + ":runtime-identity");
  assert(evidence.runtime.copyManifestSha256 === binding.bundle.sha256 && evidence.runtime.moduleSha256 === evidence.bundle?.moduleSha256, fail + ":bundle");
  assert(Array.isArray(evidence.bundle.entries), fail + ":bundle");
  const bundleBuild = Object.fromEntries(evidence.bundle.entries.filter(item => typeof item.path === "string" && item.path.startsWith("api-build/src/") && item.path.endsWith(".js"))
    .map(item => [item.path.slice("api-build/src/".length), item.sha256]));
  assert.deepEqual(bundleBuild, input.buildFiles, fail + ":bundle-build");
  const normalPath = value => typeof value === "string" ? value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() : "";
  assert(normalPath(evidence.runtime.compiledRoot) && normalPath(evidence.runtime.compiledRoot) === normalPath(input.apiDist), fail + ":runtime-build");
  assert(evidence.swap?.status === "COMMIT_ACK" && sameTarget(evidence.swap, false), fail + ":swap");
  const finalRound06Schema = evidence.schema?.status === "FINAL_SCHEMA_0157_VERIFIED" && sameTarget(evidence.schema, false)
    && sameTarget(evidence.schema.target, false) && evidence.schema.target.database === "zzsh_test_round06_stage"
    && evidence.schema.target.marker === "zzsh:round06-schema-build:v1" && String(evidence.schema.target.migrationRoleOid) === target.migrationRoleOid
    && evidence.schema.finalOrdinal >= 157 && evidence.schema.commitAck === true && evidence.schema.migrationExit?.code === 0
    && evidence.schema.migrationExit?.signal === null && evidence.schema.readbackRollbackAck === true && evidence.schema.readbackClientClosed === true
    && evidence.schema.unlockAck === true && evidence.schema.maintenanceClosed === true
    && /^[a-f0-9]{64}$/.test(evidence.schema.journalSha256 ?? "") && /^[a-f0-9]{64}$/.test(evidence.schema.historySha256 ?? "");
  assert(target.bootstrapReservation === "ROUND06_BOOTSTRAP_RESERVED" ? finalRound06Schema
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
  const sameTarget = value => value && String(value.oid) === target.oid && value.nonce === target.nonce;
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
    for (const phase of loadPhases) {
      const value = checkpoint.phases?.[phase];
      if (!value?.complete || value.quarantined !== 0 || !Number.isSafeInteger(value.nextIndex)) issues.push("ROUND_PHASE_INCOMPLETE:" + phase);
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
    for (const domain of ["users", "accounts", "orders"]) if (!Number.isSafeInteger(expected?.dataset?.domains?.[domain]?.ready) || readback.domains?.[domain]?.expected !== expected.dataset.domains[domain].ready) issues.push("ROUND_READBACK_COUNT_DRIFT:" + domain);
    for (const [domain, count] of Object.entries({ display: expected?.display?.rows, openings: expected?.openings?.stats?.candidate,
      holdings: checkpoint?.skinHoldingsPreparation?.ready, paths: expected?.paths?.accounts })) {
      if (!Number.isSafeInteger(count) || readback[domain]?.expected !== count || readback[domain]?.matched !== count) issues.push("ROUND_READBACK_COUNT_DRIFT:" + domain);
    }
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
    && JSON.stringify(previousInput.target?.schemaHashes) === JSON.stringify(input.target.schemaHashes)
    && (previousInput.strictBatch === true) === (input.strictBatch === true), fail + ":target");
  const baseline = assessRoundEvidence({ input: previousInput, inputSha256: previousInputSha256, actorProof: previousActorProof,
    receipt: previousReceipt, checkpoint, expected, requireStageAcks: false, requireReadback: false, requireGrowth: false });
  assert(baseline.status === "COMPLETE", "ROUND_RESUME_ORIGINAL_CHECKPOINT_UNCONFIRMED");
  return { status: "ORIGINAL_COMPLETE_CHECKPOINT_BOUND", previousInputSha256, datasetSha256: input.dataset.sha256, oid: input.target.oid, nonce: input.target.nonce };
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
    const identity = (await client.query(`SELECT current_database() database,d.oid::text,pg_get_userbyid(d.datdba) owner,shobj_description(d.oid,'pg_database') marker,current_setting('zzsh.regression_run') nonce,current_user role,r.oid::text role_oid,current_setting('transaction_read_only') read_only,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
    assert(identity?.database === "zzsh_test_regression" && identity.oid === target.oid && identity.nonce === target.nonce
      && identity.owner === "zzsh" && identity.marker === "zzsh:regression-test:v1" && identity.role === migrationName
      && identity.role_oid === target.migrationRoleOid && identity.read_only === "on"
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
