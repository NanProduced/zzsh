import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

const sha = value => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/;

export function assertNewDistributionTarget(target) {
  assert(/^[1-9]\d*$/.test(target?.oid ?? "") && /^[a-f0-9]{24}$/.test(target?.nonce ?? "") && /^[1-9]\d*$/.test(target?.migrationRoleOid ?? ""), "DISTRIBUTION_TARGET_REQUIRED");
  assert.notEqual(target.oid, "3179610", "R05_PREVIEW_TARGET_PROTECTED");
  assert.equal(target.bootstrapReservation, "ROUND06_BOOTSTRAP_RESERVED", "R06_BOOTSTRAP_RESERVATION_REQUIRED");
}

export function assertRegisteredDistributionTarget(target, datasetSha256, registry) {
  assertNewDistributionTarget(target);
  assert(registry?.database === "zzsh_test_regression" && registry.marker === "zzsh:regression-test:v1" && registry.oid === target.oid && registry.nonce === target.nonce && !registry.pendingReset
    && registry.roles?.migration?.oid === target.migrationRoleOid && registry.protectedDataset?.bootstrapReservation === target.bootstrapReservation
    && registry.protectedDataset?.manifestSha256 === datasetSha256 && registry.protectedDataset.epoch?.oid === target.oid && registry.protectedDataset.epoch?.nonce === target.nonce, "DISTRIBUTION_REGISTERED_TARGET_CHANGED");
}

export function assertDistributionSourceBindings(sourceSha256, capture, dataset, candidate) {
  assert(capture?.status === "CAPTURED_READ_ONLY" && capture.rollbackConfirmed && capture.clientClosed && dataset?.sourceReceiptSha256 === sourceSha256, "DISTRIBUTION_SOURCE_CAPTURE_REQUIRED");
  assert(Number.isSafeInteger(dataset.domains?.users?.ready) && dataset.domains.users.ready >= 0, "DISTRIBUTION_SOURCE_POPULATION_REQUIRED");
  assert(candidate?.source?.receiptSha256 === sourceSha256 && candidate.source.configurationSha256 === capture.files?.distributionConfig?.sha256 && candidate.source.levelsSha256 === capture.files?.distributionLevels?.sha256, "DISTRIBUTION_CANDIDATE_SOURCE_CHANGED");
}

/** Bind the financial baseline to the completed round and its independent source-to-target readback. */
export function assertDistributionCoreReadback(round, readback, binding) {
  const stage = Array.isArray(round?.stages) ? round.stages.findLast(row => row?.name === "readback") : null;
  assert(round?.schema === "zzsh.local-round-receipt.v1" && round.inputSha256 === binding.roundInputSha256
    && round.datasetSha256 === binding.datasetSha256 && round.sourceReceiptSha256 === binding.sourceSha256
    && round.target?.oid === binding.target.oid && round.target?.nonce === binding.target.nonce
    && round.status === "DATASET_AND_GROWTH_ACK_READBACK_PASS" && round.completion?.status === "COMPLETE"
    && round.completion?.dataset === "PASS" && typeof round.finishedAt === "string"
    && stage?.status === "ACK" && stage.code === 0 && stage.signal === null && stage.metrics?.evidenceSha256 === binding.readbackSha256,
  "DISTRIBUTION_COMPLETED_ROUND_REQUIRED");
  assert(readback?.schema === "zzsh.local-dataset-readback.v1" && readback.status === "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED"
    && readback.sourceDatasetSha256 === binding.datasetSha256 && readback.resource?.database === "zzsh_test_regression"
    && readback.resource?.oid === binding.target.oid && readback.resource?.nonce === binding.target.nonce
    && readback.differenceCount === 0 && readback.targetWrites === 0 && readback.rollbackConfirmed === true
    && readback.lockReleased === true && readback.connectionsClosed === true, "DISTRIBUTION_CORE_READBACK_REQUIRED");
  const finance = readback.financialHistory, counts = finance?.counts;
  assert(finance?.walletEffectsFromObservation === false && finance.arrivalVerified === false && counts && typeof counts === "object" && !Array.isArray(counts), "DISTRIBUTION_FINANCIAL_READBACK_REQUIRED");
  let total = 0;
  for (const value of Object.values(counts)) {
    assert(Number.isSafeInteger(value?.expected) && value.expected >= 0 && value.readable === value.expected, "DISTRIBUTION_FINANCIAL_READBACK_REQUIRED");
    total += value.expected;
    assert(Number.isSafeInteger(total), "DISTRIBUTION_FINANCIAL_READBACK_REQUIRED");
  }
  return total;
}

export function assertHistoricalFinancePopulation(history, expected) {
  assert(Array.isArray(history) && Number.isSafeInteger(expected) && expected >= 0
    && history.every(row => /^(0|[1-9]\d*)$/.test(row?.count ?? ""))
    && history.reduce((sum, row) => sum + BigInt(row.count), 0n) === BigInt(expected), "DISTRIBUTION_FINANCIAL_POPULATION_CHANGED");
}

/** Isolated compiled output must stay under the current worktree's ignored tmp directory. */
export function isolatedDistributionBuild(root, value) {
  assert(typeof value === "string" && isAbsolute(value), "DISTRIBUTION_ISOLATED_BUILD_REQUIRED");
  const api = resolve(value), rel = relative(resolve(root, "tmp"), api).replaceAll("\\", "/");
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}\/api\/dist\/src$/.test(rel), "DISTRIBUTION_ISOLATED_BUILD_REQUIRED");
  return api;
}

export function privateDistributionPath(root, value) {
  assert(typeof value === "string" && isAbsolute(value), "DISTRIBUTION_PRIVATE_PATH_REQUIRED");
  const path = resolve(value), rel = relative(resolve(root), path);
  assert(rel && !rel.startsWith("..") && !isAbsolute(rel), "DISTRIBUTION_PRIVATE_PATH_REQUIRED");
  return path;
}

/** Rebuild the proposed policy from the pinned old configuration, never from the proposed rates alone. */
export function legacyDistributionPolicy({ scope, receiptSha256, configurationSha256, levelsSha256, configuration, rawLevels }) {
  assert(["LOCAL_CONTROLLED", "NATIVE"].includes(scope));
  assert([receiptSha256, configurationSha256, levelsSha256].every(value => hex.test(value)));
  assert(Array.isArray(configuration) && Array.isArray(rawLevels));
  assert([...configuration, ...rawLevels].every(row => row && ["0", "1"].includes(row.is_delete)), "LEGACY_DISTRIBUTION_DELETION_FLAG_UNKNOWN");
  const activeConfig = configuration.filter(row => row.is_delete === "0");
  const flags = new Map(activeConfig.map(row => [row.name, typeof row.value === "string" ? row.value.trim() : row.value]));
  assert.equal(flags.size, activeConfig.length, "DUPLICATE_LEGACY_DISTRIBUTION_SETTING");
  for (const [name, value] of Object.entries({ open: "1", level: "1", openCondition: "1", isSelfRebate: "0", settlementTiming: "1", settlementTime: "7.0" }))
    assert.equal(flags.get(name), value, "LEGACY_DISTRIBUTION_SETTING_CHANGED:" + name);
  assert.equal(flags.get("earningsCalMethod") ?? "1", "1", "LEGACY_DISTRIBUTION_CALCULATION_CHANGED");
  const active = rawLevels.filter(row => row.is_delete === "0");
  const levels = active.map(row => ({ code: "legacy_" + row.id, rank: Number(row.weights), default: row.is_default === "1", renterPercent: row.first_ratio, ownerPercent: row.second_ratio, upgrade: null }));
  assert(levels.length && levels.filter(level => level.default).length === 1 && levels.every(level => Number.isSafeInteger(level.rank) && level.rank > 0));
  assert.equal(new Set(levels.map(level => level.code)).size, levels.length, "DUPLICATE_LEGACY_LEVEL");
  const legacySource = { receiptSha256, configurationSha256, levelsSha256, levelNames: Object.fromEntries(active.map(row => ["legacy_" + row.id, row.name])) };
  return { schema: "distribution-policy-initialize.v2", config: { schema: "distribution-policy.v3", scope, enabled: true, participation: "AUTO_AT_REGISTRATION", depth: 1, selfRebate: false, accountModes: ["ordinary", "custom"], minimumAccrualCents: "1", settlementDelayDays: 7, levels, legacySource }, reason: "承接已核旧平台租赁分销策略和有效档位" };
}

/** Plan exactly the target's imported participants against immutable source-backed audit facts. */
export function buildLegacyQualificationPlan({ participants, packets, payload, sourceDigest, canonicalize, projectQualification, expectedParticipants }) {
  assert(Array.isArray(participants) && Array.isArray(packets));
  assert(Number.isSafeInteger(expectedParticipants) && expectedParticipants >= 0 && participants.length === expectedParticipants, "LEGACY_PARTICIPANT_POPULATION_CHANGED");
  assert(payload?.config?.legacySource?.receiptSha256 === sourceDigest && hex.test(sourceDigest));
  const config = payload.config, policyDigest = sha(canonicalize(config));
  const policyId = "distribution_policy_" + sha(canonicalize([config.scope, "1", policyDigest])).slice(0, 40);
  const sourceFacts = new Map();
  for (const packet of packets) {
    assert(packet?.source?.receiptSha256 === sourceDigest && Array.isArray(packet.facts) && packet.facts.length <= 5000, "LEGACY_AUDIT_PACKET_INVALID");
    for (const fact of packet.facts) {
      assert(typeof fact?.userId === "string" && !sourceFacts.has(fact.userId), "LEGACY_AUDIT_SUBJECT_DUPLICATE");
      sourceFacts.set(fact.userId, { source: packet.source, fact });
    }
  }
  const codes = new Set(config.levels.map(level => level.code));
  const seen = new Set(), accepted = [], existing = [], ineligible = [], exceptions = [];
  const issue = (row, reason) => exceptions.push({ userId: row.user_id, reason });
  for (const row of participants) {
    assert(typeof row.user_id === "string" && !seen.has(row.user_id), "LEGACY_TARGET_SUBJECT_DUPLICATE");
    seen.add(row.user_id);
    const item = sourceFacts.get(row.user_id);
    if (!item) { issue(row, "ORIGINAL_FACT_MISSING"); continue; }
    let fact;
    try { fact = projectQualification(item.source, item.fact, row.source_digest); }
    catch { issue(row, "ORIGINAL_FACT_DIGEST_DIFFERS"); continue; }
    if (!hex.test(row.source_digest ?? "") || !/^[1-9]\d{0,18}$/.test(row.revision ?? "") || fact.commissionFrozen !== row.commission_frozen) {
      issue(row, "CURRENT_PARTICIPANT_FACT_DIFFERS"); continue;
    }
    if (fact.eligibility === "INELIGIBLE" && row.eligibility === "INELIGIBLE" && row.policy_version_id === null && row.level_code === null) {
      ineligible.push({ userId: row.user_id, sourceDigest: row.source_digest, revision: row.revision, frozen: fact.commissionFrozen }); continue;
    }
    const levelCode = "legacy_" + fact.levelId;
    if (fact.eligibility !== "ELIGIBLE" || typeof fact.commissionFrozen !== "boolean") { issue(row, "ORIGINAL_QUALIFICATION_UNKNOWN"); continue; }
    if (!codes.has(levelCode)) { issue(row, "ACTIVE_SOURCE_LEVEL_MISSING"); continue; }
    const subject = { userId: row.user_id, sourceDigest: row.source_digest, revision: row.revision, levelCode, frozen: fact.commissionFrozen };
    if (row.policy_version_id === policyId && row.eligibility === "ELIGIBLE" && row.level_code === levelCode) { existing.push(subject); continue; }
    if (row.eligibility !== "UNKNOWN" || row.policy_version_id !== null || row.level_code !== null) { issue(row, "CURRENT_PARTICIPANT_FACT_DIFFERS"); continue; }
    accepted.push(subject);
  }
  for (const userId of sourceFacts.keys()) if (!seen.has(userId)) exceptions.push({ userId, reason: "TARGET_PARTICIPANT_MISSING" });
  const batches = [];
  for (let i = 0; i < accepted.length; i += 1000) {
    const body = { scope: config.scope, policyId, policyDigest, subjects: accepted.slice(i, i + 1000) };
    batches.push({ body, bodyDigest: sha(canonicalize(body)) });
  }
  const approvalBody = { operationCode: "distribution.policy.publish", triggerCondition: "distribution.policy.publish.requested", payloadVersion: 1, payload, summary: "承接旧平台实际生效的租赁分销策略" };
  return { scope: config.scope, policyId, policyDigest, approvalBody, approvalKey: "legacy_policy_" + sha(canonicalize(approvalBody)).slice(0, 40), accepted, existing, ineligible, exceptions, batches };
}

export function assertQualificationReadback(before, after) {
  assert.equal(after.policyId, before.policyId, "QUALIFICATION_READBACK_POLICY_CHANGED");
  assert.equal(after.policyDigest, before.policyDigest, "QUALIFICATION_READBACK_POLICY_CHANGED");
  assert.equal(after.exceptions.length, 0, "QUALIFICATION_READBACK_EXCEPTIONS");
  assert.equal(after.accepted.length, 0, "QUALIFICATION_READBACK_INCOMPLETE");
  const current = new Map(after.existing.map(row => [row.userId, row]));
  assert.equal(current.size, before.accepted.length + before.existing.length, "QUALIFICATION_READBACK_POPULATION_CHANGED");
  for (const [rows, increment] of [[before.accepted, 1n], [before.existing, 0n]]) for (const row of rows) {
    const got = current.get(row.userId), revision = (BigInt(row.revision) + increment).toString();
    assert(got && got.sourceDigest === row.sourceDigest && got.levelCode === row.levelCode && got.frozen === row.frozen && got.revision === revision, "QUALIFICATION_READBACK_SUBJECT_CHANGED");
  }
  assert.deepEqual(after.ineligible, before.ineligible, "QUALIFICATION_READBACK_INELIGIBLE_CHANGED");
}

export function assertQualificationBatches(plan, canonicalize) {
  assert(Array.isArray(plan.accepted) && Array.isArray(plan.batches), "DISTRIBUTION_BATCHES_REQUIRED");
  const subjects = [];
  for (const batch of plan.batches) {
    assert(batch.body?.scope === plan.scope && batch.body.policyId === plan.policyId && batch.body.policyDigest === plan.policyDigest && Array.isArray(batch.body.subjects) && batch.body.subjects.length > 0 && batch.body.subjects.length <= 1000, "DISTRIBUTION_BATCH_BINDING_CHANGED");
    assert.equal(sha(canonicalize(batch.body)), batch.bodyDigest, "DISTRIBUTION_BATCH_CHANGED");
    subjects.push(...batch.body.subjects);
  }
  assert.equal(canonicalize(subjects), canonicalize(plan.accepted), "DISTRIBUTION_BATCH_POPULATION_CHANGED");
  assert.equal(new Set(subjects.map(subject => subject.userId)).size, subjects.length, "DISTRIBUTION_BATCH_DUPLICATE");
}

export function assertQualificationPolicy(plan, expected, canonicalize) {
  assert(plan.policyId === expected.policyId && plan.policyDigest === expected.policyDigest && plan.approvalKey === expected.approvalKey && canonicalize(plan.approvalBody) === canonicalize(expected.approvalBody), "DISTRIBUTION_PLAN_POLICY_CHANGED");
}

export function assertHistoricalFinanceUnchanged(expected, actual, canonicalize) {
  assert(Array.isArray(expected) && Array.isArray(actual) && canonicalize(expected) === canonicalize(actual), "HISTORICAL_FINANCE_CHANGED");
}

export function assertDistributionPolicyReceipt(receipt, binding, canonicalize) {
  assert(receipt?.status === "NATIVE_POLICY_APPROVED_READBACK_PASSED" && receipt.policyId === binding.policyId && receipt.policyActive === true
    && receipt.inputSha256 === binding.inputSha256 && receipt.datasetSha256 === binding.datasetSha256 && receipt.sourceDigest === binding.sourceDigest
    && receipt.target?.oid === binding.target.oid && receipt.target?.nonce === binding.target.nonce
    && receipt.financialWrites === 0 && receipt.lockReleased === true && receipt.lockClientClosed === true && receipt.clientsClosed === true
    && Array.isArray(receipt.steps) && ["decision", "execute", "approval-readback"].every(name => receipt.steps.some(step => step.step === name && step.status === 200)), "DISTRIBUTION_APPROVAL_RECEIPT_REQUIRED");
  assertHistoricalFinanceUnchanged(binding.historicalFinance, receipt.historicalFinanceBaseline, canonicalize);
  assertHistoricalFinanceUnchanged(binding.historicalFinance, receipt.historicalFinanceReadback, canonicalize);
}

export function assertQualificationPlanBinding(plan, binding, canonicalize) {
  assert(plan.schema === "zzsh.local-distribution-qualification-plan.v1" && plan.inputSha256 === binding.inputSha256 && plan.datasetSha256 === binding.datasetSha256 && plan.sourceDigest === binding.sourceDigest && plan.candidateSha256 === binding.candidateSha256 && plan.scope === binding.scope && plan.target?.oid === binding.target.oid && plan.target?.nonce === binding.target.nonce && plan.target?.database === binding.target.database && plan.target?.marker === binding.target.marker && plan.target?.migrationRoleOid === binding.target.migrationRoleOid && plan.buildDigest === binding.buildDigest && canonicalize(plan.toolFiles) === canonicalize(binding.toolFiles) && plan.readOnlyRollbackAck && plan.clientClosed && plan.headCompatible && Array.isArray(plan.exceptions) && plan.exceptions.length === 0, "DISTRIBUTION_PLAN_BINDING_CHANGED");
  assertQualificationBatches(plan, canonicalize);
  assert(Array.isArray(plan.existing) && Array.isArray(plan.ineligible));
  assert.equal(plan.existing.length, 0, "ORIGINAL_QUALIFICATION_PLAN_REQUIRED_FOR_EXISTING_SUBJECTS");
  const subjects = [...plan.accepted, ...plan.existing, ...plan.ineligible].map(row => row.userId);
  assert(subjects.length === binding.expectedParticipants && new Set(subjects).size === subjects.length, "DISTRIBUTION_PLAN_POPULATION_CHANGED");
}

export function assertQualificationAuthority(authority, binding, now = Date.now()) {
  const start = Date.parse(authority.notBefore), end = Date.parse(authority.expiresAt);
  assert(authority.schema === "root-reviewed-legacy-distribution-qualification.v2" && authority.approvedBy === "Root" && authority.status === "APPROVED" && authority.inputSha256 === binding.inputSha256 && authority.planSha256 === binding.planSha256 && authority.scope === binding.scope && authority.policyId === binding.policyId && authority.policyDigest === binding.policyDigest && authority.target?.oid === binding.target.oid && authority.target?.nonce === binding.target.nonce && authority.target?.database === binding.target.database && authority.target?.marker === binding.target.marker && authority.target?.migrationRoleOid === binding.target.migrationRoleOid && authority.lock === 806006 && authority.allowFinancialWrites === false && start <= now && now < end && end - start <= 30 * 60000 && start >= Date.parse(binding.window?.notBefore) && end <= Date.parse(binding.window?.expiresAt), "DISTRIBUTION_AUTHORITY_CHANGED_OR_EXPIRED");
}

export function reviewedDistributionActor(actorFile, target, approved) {
  const actor = { userId: actorFile?.id ?? actorFile?.actorId, sessionId: actorFile?.sessionId, requestId: approved?.requestId };
  assert(actorFile?.realm === "admin" && actorFile.resourceOid === target.oid && actorFile.nonce === target.nonce && actor.userId === approved?.userId && actor.sessionId === approved?.sessionId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(actor.requestId ?? ""), "DISTRIBUTION_ACTOR_CHANGED");
  return actor;
}
