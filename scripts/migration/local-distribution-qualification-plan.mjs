import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NEXT_MIGRATION_PROFILE } from "./local-target-registry.mjs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { readVerifiedSourceRows } from "./local-source-adapter.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/;

export function assertNewDistributionTarget(target) {
  assert(/^[1-9]\d*$/.test(target?.oid ?? "") && /^[a-f0-9]{24}$/.test(target?.nonce ?? "") && /^[1-9]\d*$/.test(target?.migrationRoleOid ?? ""), "DISTRIBUTION_TARGET_REQUIRED");
  assert.notEqual(target.oid, "3179610", "R05_PREVIEW_TARGET_PROTECTED");
  assert(["ROUND06_BOOTSTRAP_RESERVED","ROUND07_BOOTSTRAP_RESERVED"].includes(target.bootstrapReservation), "LOCAL_BOOTSTRAP_RESERVATION_REQUIRED");
}

export function assertRegisteredDistributionTarget(target, datasetSha256, registry) {
  assertNewDistributionTarget(target);
  assert(registry?.database === "zzsh_test_regression" && registry.marker === "zzsh:regression-test:v1" && registry.oid === target.oid && registry.nonce === target.nonce && !registry.pendingReset
    && JSON.stringify(target.instance ?? null) === JSON.stringify(registry.instance ?? null)
    && (target.migrationProfile ?? null) === (registry.migrationProfile ?? null)
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
  const recovered=round?.status==="DATASET_AND_GROWTH_REVALIDATED_PASS"&&round?.mode==="RESUME_GROWTH";
  const stage = Array.isArray(round?.stages) ? round.stages.findLast(row => row?.name === (recovered?"readback-final":"readback")) : null;
  if(recovered){
    const names=["schema-preflight","readback","growth-prepare","growth-attempt-reservation","growth-apply","growth-readback","readback-final"];
    assert(round.prior?.proof?.status==="ORIGINAL_COMPLETE_CHECKPOINT_BOUND"&&["previousInput","previousReceipt","checkpoint"].every(key=>hex.test(round.prior?.[key]?.sha256??""))
      &&round.stages?.length===names.length&&names.every((name,index)=>round.stages[index]?.name===name&&round.stages[index].status==="ACK"&&round.stages[index].code===0&&round.stages[index].signal===null),"DISTRIBUTION_COMPLETED_ROUND_REQUIRED");
  }
  assert(round?.schema === "zzsh.local-round-receipt.v1" && round.inputSha256 === binding.roundInputSha256
    && round.datasetSha256 === binding.datasetSha256 && round.sourceReceiptSha256 === binding.sourceSha256
    && round.target?.oid === binding.target.oid && round.target?.nonce === binding.target.nonce
    && JSON.stringify(round.target?.instance ?? null) === JSON.stringify(binding.target.instance ?? null)
    && (round.target?.migrationProfile ?? null) === (binding.target.migrationProfile ?? null)
    && (round.status === "DATASET_AND_GROWTH_ACK_READBACK_PASS" || recovered) && round.completion?.status === "COMPLETE"
    && round.completion?.dataset === "PASS" && (!binding.target.instance || round.completion?.growth === "PASS") && typeof round.finishedAt === "string"
    && stage?.status === "ACK" && stage.code === 0 && stage.signal === null && stage.metrics?.evidenceSha256 === binding.readbackSha256,
  "DISTRIBUTION_COMPLETED_ROUND_REQUIRED");
  assert(readback?.schema === "zzsh.local-dataset-readback.v1" && readback.status === "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED"
    && readback.sourceDatasetSha256 === binding.datasetSha256 && readback.resource?.database === "zzsh_test_regression"
    && readback.resource?.oid === binding.target.oid && readback.resource?.nonce === binding.target.nonce
    && JSON.stringify(readback.resource?.instance ?? null) === JSON.stringify(binding.target.instance ?? null)
    && (readback.resource?.migrationProfile ?? null) === (binding.target.migrationProfile ?? null)
    && (binding.target.migrationProfile !== NEXT_MIGRATION_PROFILE || readback.targetFence === 'HELD_UNTIL_ROLLBACK')
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

/** A repair build may differ only in the reviewed distribution resource guard. */
export function assertDistributionRepairBuild(base,repair){
  const keys=Object.keys(base??{}).sort();assert(keys.length>0&&JSON.stringify(keys)===JSON.stringify(Object.keys(repair??{}).sort()),'DISTRIBUTION_REPAIR_BUILD_FILE_SET_CHANGED');
  const changed=keys.filter(name=>base[name]!==repair[name]);
  assert(changed.length===1&&changed[0]==='finance/distribution-policy-store.js'&&keys.every(name=>hex.test(base[name]??'')&&hex.test(repair[name]??'')),'DISTRIBUTION_REPAIR_BUILD_SCOPE_CHANGED');
}

/** The renewed build keeps the prior policy fix and adds only the reviewed qualification index. */
export function assertDistributionOptimizedBuild(base,repair){
  const keys=Object.keys(base??{}).sort();assert(keys.length>0&&JSON.stringify(keys)===JSON.stringify(Object.keys(repair??{}).sort()),'DISTRIBUTION_REPAIR_BUILD_FILE_SET_CHANGED');
  const changed=keys.filter(name=>base[name]!==repair[name]);
  assert(JSON.stringify(changed)===JSON.stringify(['finance/distribution-policy-store.js','finance/legacy-invitation-facts-maintenance.js'])
    &&keys.every(name=>hex.test(base[name]??'')&&hex.test(repair[name]??'')),'DISTRIBUTION_OPTIMIZED_BUILD_SCOPE_CHANGED');
}
export function assertDistributionRepairGuard(probe,{target,registry,moduleSha256}){
  const t=probe?.target,checks=['exact','wrongPort','wrongCluster','wrongOid','wrongRoleOid','wrongNonce','wrongOwnerOid','missingInstance'];
  assert(probe?.schema==='zzsh.round07-distribution-repair-guard.v2'&&probe.status==='EXACT_TARGET_ACCEPTED_AND_DRIFT_REJECTED'
    &&probe.moduleSha256===moduleSha256&&hex.test(moduleSha256??'')&&t?.oid===target.oid&&t.nonce===target.nonce
    &&JSON.stringify(t.instance??null)===JSON.stringify(target.instance??null)&&t.database===registry.database&&t.owner===registry.owner
    &&String(t.ownerOid)===String(registry.ownerOid)&&t.marker===registry.marker&&t.migrationRole===registry.migrationRole
    &&String(t.migrationRoleOid)===String(registry.migrationRoleOid)&&t.runtimeRole===registry.runtimeRole&&String(t.runtimeRoleOid)===String(registry.runtimeRoleOid)
    &&checks.every(key=>probe.checks?.[key]===true)&&probe.rollbackAck===true&&probe.unlockAck===true&&probe.connectionsClosed===true&&probe.targetWrites===0,
  'DISTRIBUTION_REPAIR_GUARD_UNCONFIRMED');
}

/** A qualification retry is admitted only after the original all-or-nothing transaction rolled back. */
export function assertQualificationRecoveryEvidence({failure,inspection,guard,previousPlan,previousInput,previousAuthority,plan,input,refs,canonicalize}){
  const fail='DISTRIBUTION_QUALIFICATION_RECOVERY_UNCONFIRMED',same=(a,b)=>canonicalize(a)===canonicalize(b),t=input.target;
  const expectedParticipants=['accepted','existing','ineligible','unresolved'].reduce((sum,key)=>sum+(Array.isArray(previousPlan?.[key])?previousPlan[key].length:0),0);
  assert(failure?.status==='STOPPED'&&failure.mode==='--execute'&&failure.inputSha256===refs.previousInput.sha256
    &&failure.transaction?.status==='ROLLBACK_ACKNOWLEDGED'&&failure.rollbackAck===true&&failure.lockReleased===true&&failure.clientsClosed===true
    &&failure.lockClientClosed===true&&failure.financialWrites===0&&failure.pending==null&&failure.batches?.length===0
    &&failure.failedBatch?.bodyDigest===previousPlan?.batches?.[0]?.bodyDigest&&failure.error?.code==='FORBIDDEN',fail);
  assert(inspection?.schema==='zzsh.round07-distribution-qualification-rollback-inspection.v1'&&inspection.status==='READ_ONLY_POST_ROLLBACK_INSPECTED'
    &&inspection.failureSha256===refs.failure.sha256&&inspection.planSha256===refs.previousPlan.sha256&&inspection.target?.oid===t.oid&&inspection.target.nonce===t.nonce
    &&same(inspection.target.instance,t.instance)&&inspection.batchCount===0&&inspection.firstFailed===true&&inspection.guard?.code==='FORBIDDEN'
    &&['accepted','ineligible','unresolved'].every(key=>inspection.mismatch?.[key]===0)&&expectedParticipants>0&&inspection.counts?.participants===expectedParticipants
    &&inspection.counts.receipts===0&&inspection.counts.audits===0&&inspection.counts.policy_heads===1
    &&inspection.rollbackAck===true&&inspection.unlockAck===true&&inspection.connectionsClosed===true&&inspection.targetWrites===0,fail);
  const checks=['exact','wrongPort','wrongCluster','wrongOid','wrongRole','wrongRoleOid','wrongOwner','wrongMarker','wrongReadOnly'];
  assert(guard?.schema==='zzsh.round07-qualification-repair-guard.v2'&&guard.status==='EXACT_READ_ONLY_TARGET_ACCEPTED_AND_DRIFT_REJECTED'
    &&guard.sourcePlanSha256===refs.previousPlan.sha256&&guard.runnerSha256===plan.toolFiles?.['local-distribution-qualification-runner.mjs']
    &&guard.target?.oid===t.oid&&guard.target.nonce===t.nonce&&same(guard.target.instance,t.instance)&&checks.every(key=>guard.checks?.[key]===true)
    &&guard.actualTransaction==='READ_ONLY'&&guard.admissionMode==='recover'&&guard.notAWriteOrCommitProof===true
    &&guard.rollbackAck===true&&guard.unlockAck===true&&guard.connectionsClosed===true&&guard.targetWrites===0,fail);
  assert(previousPlan?.inputSha256===refs.previousInput.sha256&&Array.isArray(previousPlan.existing)&&previousPlan.existing.length===0&&previousAuthority?.inputSha256===refs.previousInput.sha256&&previousAuthority.planSha256===refs.previousPlan.sha256
    &&previousInput?.dataset?.sha256===input.dataset.sha256&&previousInput.source?.sha256===input.source.sha256&&same(previousInput.target,t)
    &&same(previousInput.buildFiles,input.buildFiles)&&previousPlan.policyId===plan.policyId&&previousPlan.policyDigest===plan.policyDigest
    &&['accepted','existing','ineligible','unresolved'].every(key=>same(previousPlan[key]??[],plan[key]??[]))
    &&same(previousPlan.batches.map(row=>row.bodyDigest),plan.batches.map(row=>row.bodyDigest))&&plan.exceptions.length===0
    &&Date.parse(input.window.notBefore)>=Date.parse(previousAuthority.notBefore)&&Date.parse(input.window.expiresAt)<=Date.parse(previousAuthority.expiresAt),fail);
  assertHistoricalFinanceUnchanged(previousPlan.historicalFinance,plan.historicalFinance,canonicalize);
  return {status:'ROLLED_BACK_QUALIFICATION_ATTEMPT_BOUND',previousInputSha256:refs.previousInput.sha256};
}

/** A new window may retry only the same plan after a fully acknowledged rollback and exact readback. */
export function assertQualificationRenewalEvidence({failure,inspection,previousPlan,previousInput,previousAuthority,buildManifest,plan,input,refs,canonicalize}){
  const fail='DISTRIBUTION_QUALIFICATION_RENEWAL_UNCONFIRMED',same=(a,b)=>canonicalize(a)===canonicalize(b),t=input.target;
  const batches=failure?.batches,expected=['accepted','existing','ineligible','unresolved'].reduce((sum,key)=>sum+(Array.isArray(previousPlan?.[key])?previousPlan[key].length:0),0);
  assert(failure?.status==='STOPPED'&&failure.mode==='--execute'&&failure.inputSha256===refs.previousInput.sha256&&failure.transaction?.status==='ROLLBACK_ACKNOWLEDGED'
    &&failure.rollbackAck===true&&failure.lockReleased===true&&failure.clientsClosed===true&&failure.lockClientClosed===true&&failure.financialWrites===0
    &&failure.target?.oid===t.oid&&failure.target.nonce===t.nonce&&same(failure.target.instance,t.instance)
    &&failure.transaction.plannedBatches===previousPlan.batches.length&&failure.recoveryPreflight?.status==='ORIGINAL_QUALIFICATION_PREIMAGE_RECHECKED'
    &&failure.error?.code==='FORBIDDEN'&&Array.isArray(batches)&&batches.length>0&&batches.length<previousPlan.batches.length
    &&batches.every((batch,i)=>batch.status==='ACK_IN_OPEN_TRANSACTION'&&batch.bodyDigest===previousPlan.batches[i].bodyDigest&&batch.participants===previousPlan.batches[i].body.subjects.length)
    &&failure.failedBatch?.bodyDigest===previousPlan.batches[batches.length].bodyDigest&&Date.parse(failure.finishedAt)>=Date.parse(previousAuthority.expiresAt),fail);
  assert(inspection?.schema==='zzsh.r07-qualification-renewal-preimage.v1'&&inspection.status==='ALL_QUALIFICATION_PREIMAGE_UNCHANGED'
    &&inspection.previous?.plan===refs.previousPlan.sha256&&inspection.previous.input===refs.previousInput.sha256&&inspection.previous.authority===refs.previousAuthority.sha256&&inspection.previous.failure===refs.failure.sha256
    &&inspection.target?.oid===t.oid&&inspection.target.nonce===t.nonce&&same(inspection.target.instance,t.instance)&&inspection.target.database===previousPlan.target.database
    &&inspection.target.marker===previousPlan.target.marker&&String(inspection.target.roleOid)===String(t.migrationRoleOid)
    &&inspection.counts?.participants===expected&&expected>0&&inspection.counts.receipts===0&&inspection.counts.audits===0&&inspection.counts.policy_heads===1
    &&['accepted','ineligible','unresolved'].every(key=>inspection.mismatches?.[key]===0)&&inspection.rollbackAck===true&&inspection.clientClosed===true&&inspection.targetWrites===0,fail);
  assert(previousPlan.inputSha256===refs.previousInput.sha256&&previousAuthority.inputSha256===refs.previousInput.sha256&&previousAuthority.planSha256===refs.previousPlan.sha256
    &&same(previousInput.target,t)&&previousInput.dataset.sha256===input.dataset.sha256&&previousInput.source.sha256===input.source.sha256&&previousInput.actor.sha256===input.actor.sha256
    &&previousPlan.policyId===plan.policyId&&previousPlan.policyDigest===plan.policyDigest&&same(previousPlan.target,plan.target)
    &&['accepted','existing','ineligible','unresolved'].every(key=>same(previousPlan[key]??[],plan[key]??[]))
    &&same(previousPlan.batches.map(row=>row.bodyDigest),plan.batches.map(row=>row.bodyDigest))&&plan.exceptions.length===0
    &&Date.parse(input.window.notBefore)>=Date.parse(previousAuthority.expiresAt),fail);
  const changed=Object.keys(previousInput.buildFiles??{}).filter(name=>previousInput.buildFiles[name]!==input.buildFiles?.[name]).sort();
  assert(same(Object.keys(previousInput.buildFiles??{}).sort(),Object.keys(input.buildFiles??{}).sort())&&same(changed,['finance/legacy-invitation-facts-maintenance.js'])
    &&buildManifest?.status==='REVIEW_ONLY_BUILD_SEALED'&&same(buildManifest.buildFiles,input.buildFiles)&&buildManifest.build===input.apiDist
    &&same(buildManifest.changedFromPrevious,changed)&&buildManifest.targetWrites===0&&buildManifest.authorityCreated===false,fail);
  assertHistoricalFinanceUnchanged(previousPlan.historicalFinance,plan.historicalFinance,canonicalize);
  return {status:'EXPIRED_QUALIFICATION_ROLLBACK_BOUND',rolledBackBatches:batches.length,previousInputSha256:refs.previousInput.sha256};
}

/** Retry a constraint-timeout rollback only after migration 0161 and an independent unchanged-preimage readback. */
export function assertQualificationConstraintRetryEvidence({failure,inspection,previousPlan,previousInput,previousAuthority,priorRecoveryInput,upgradePlan,upgradeExecution,upgradeReadback,buildManifest,plan,input,refs,canonicalize}){
  const fail='DISTRIBUTION_CONSTRAINT_RETRY_UNCONFIRMED',same=(a,b)=>canonicalize(a)===canonicalize(b),t=input.target,batches=failure?.batches;
  assert(failure?.status==='STOPPED'&&failure.mode==='--execute'&&failure.inputSha256===refs.previousInput.sha256&&failure.error?.code==='57014'
    &&failure.transaction?.status==='ROLLBACK_ACKNOWLEDGED'&&failure.rollbackAck===true&&failure.lockReleased===true&&failure.clientsClosed===true&&failure.financialWrites===0
    &&failure.target?.oid===t.oid&&failure.target.nonce===t.nonce&&same(failure.target.instance,t.instance)&&failure.failedBatch==null
    &&Array.isArray(batches)&&batches.length===175&&batches.length===previousPlan.batches?.length
    &&batches.every((batch,i)=>batch.status==='ACK_IN_OPEN_TRANSACTION'&&batch.bodyDigest===previousPlan.batches[i].bodyDigest&&batch.participants===previousPlan.batches[i].body.subjects.length),fail);
  assert(inspection?.schema==='zzsh.r07-qualification-constraint-analysis.v1'&&inspection.status==='READ_ONLY_CONSTRAINT_ANALYSIS_COMPLETE'
    &&inspection.previous?.plan===refs.previousPlan.sha256&&inspection.previous.input===refs.previousInput.sha256&&inspection.previous.authority===refs.previousAuthority.sha256&&inspection.previous.failure===refs.failure.sha256
    &&inspection.target?.oid===t.oid&&inspection.target.nonce===t.nonce&&same(inspection.target.instance,t.instance)&&inspection.settings?.statement_timeout==='30s'
    &&inspection.preimage?.counts?.participants===174846&&inspection.preimage.counts.receipts===0&&inspection.preimage.counts.audits===0&&inspection.preimage.counts.policy_heads===1
    &&['accepted','ineligible','unresolved'].every(k=>inspection.preimage.mismatches?.[k]===0)&&inspection.rollbackAck===true&&inspection.clientClosed===true&&inspection.targetWrites===0,fail);
  assert(upgradePlan?.status==='READ_ONLY_PREPARED'&&upgradePlan.target?.oid===t.oid&&upgradePlan.target.nonce===t.nonce&&same(upgradePlan.target.instance,t.instance)
    &&upgradeExecution?.status==='UPGRADE_READBACK_PASSED'&&upgradeExecution.commitAck===true&&upgradeExecution.readbackRollbackAck===true&&upgradeExecution.unlockAck===true&&upgradeExecution.clientClosed===true&&upgradeExecution.financialWrites===0
    &&upgradeReadback?.status==='EXACT_0161_AND_PREIMAGE_READBACK_PASSED'&&upgradeReadback.inputs?.plan===refs.upgradePlan.sha256&&upgradeReadback.inputs.execution===refs.upgradeExecution.sha256
    &&upgradeReadback.inputs.qualificationPlan===refs.previousPlan.sha256&&upgradeReadback.inputs.qualificationInput===refs.previousInput.sha256
    &&upgradeReadback.target?.oid===t.oid&&upgradeReadback.target.nonce===t.nonce&&same(upgradeReadback.target.instance,t.instance)
    &&upgradeReadback.lastMigrationSha256===upgradePlan.migrationSha256&&upgradeReadback.functionSha256===upgradePlan.expectedFunctionSha256
    &&upgradeReadback.preimage?.counts?.participants===174846&&upgradeReadback.preimage.counts.receipts===0&&upgradeReadback.preimage.counts.audits===0&&upgradeReadback.preimage.counts.policy_heads===1
    &&['accepted','ineligible','unresolved'].every(k=>upgradeReadback.preimage.mismatches?.[k]===0)&&upgradeReadback.readOnlyRollbackAck===true&&upgradeReadback.clientClosed===true&&upgradeReadback.targetWrites===0,fail);
  assert(previousPlan.inputSha256===refs.previousInput.sha256&&previousAuthority.inputSha256===refs.previousInput.sha256&&previousAuthority.planSha256===refs.previousPlan.sha256
    &&previousInput.distribution?.qualificationRenewal?.previousInput?.sha256===refs.priorRecoveryInput.sha256&&priorRecoveryInput.distribution?.qualificationRecovery?.previousInput?.sha256
    &&same(previousInput.target,t)&&previousInput.dataset.sha256===input.dataset.sha256&&previousInput.source.sha256===input.source.sha256&&previousInput.actor.sha256===input.actor.sha256
    &&previousPlan.policyId===plan.policyId&&previousPlan.policyDigest===plan.policyDigest&&same(previousPlan.target,plan.target)
    &&['accepted','existing','ineligible','unresolved'].every(k=>same(previousPlan[k]??[],plan[k]??[]))&&same(previousPlan.batches.map(row=>row.bodyDigest),plan.batches.map(row=>row.bodyDigest))
    &&plan.exceptions.length===0&&Date.parse(input.window.notBefore)>=Date.parse(previousAuthority.expiresAt),fail);
  assert(same(previousInput.buildFiles,input.buildFiles)&&buildManifest?.status==='REVIEW_ONLY_BUILD_SEALED'&&same(buildManifest.buildFiles,input.buildFiles)
    &&buildManifest.build===input.apiDist&&buildManifest.targetWrites===0&&buildManifest.authorityCreated===false,fail);
  assertHistoricalFinanceUnchanged(previousPlan.historicalFinance,plan.historicalFinance,canonicalize);
  return{status:'CONSTRAINT_ROLLBACK_AND_0161_BOUND',rolledBackBatches:batches.length,previousInputSha256:refs.previousInput.sha256};
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
  for (const [name, value] of Object.entries({ open: "1", level: "1", openCondition: "1", isSelfRebate: "0", settlementTiming: "1" }))
    assert.equal(flags.get(name), value, "LEGACY_DISTRIBUTION_SETTING_CHANGED:" + name);
  const rawDelay = flags.get("settlementTime");
  assert(typeof rawDelay === "string" && rawDelay.length <= 64 && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawDelay), "LEGACY_DISTRIBUTION_DELAY_INVALID");
  const significant = rawDelay.split(/[eE]/)[0].replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  assert(significant.length <= 9, "LEGACY_DISTRIBUTION_DELAY_INVALID");
  // The old settlement job parsed a Java Float, then truncated it to whole days.
  const legacyDelay = Math.fround(Number(rawDelay));
  assert(Number.isFinite(legacyDelay) && legacyDelay >= 0 && legacyDelay <= 999999, "LEGACY_DISTRIBUTION_DELAY_INVALID");
  const settlementDelayDays = Math.trunc(legacyDelay);
  assert.equal(flags.get("earningsCalMethod") ?? "1", "1", "LEGACY_DISTRIBUTION_CALCULATION_CHANGED");
  const active = rawLevels.filter(row => row.is_delete === "0");
  const levels = active.map(row => ({ code: "legacy_" + row.id, rank: Number(row.weights), default: row.is_default === "1", renterPercent: row.first_ratio, ownerPercent: row.second_ratio, upgrade: null }));
  assert(levels.length && levels.filter(level => level.default).length === 1 && levels.every(level => Number.isSafeInteger(level.rank) && level.rank > 0));
  assert.equal(new Set(levels.map(level => level.code)).size, levels.length, "DUPLICATE_LEGACY_LEVEL");
  const legacySource = { receiptSha256, configurationSha256, levelsSha256, levelNames: Object.fromEntries(active.map(row => ["legacy_" + row.id, row.name])) };
  return { schema: "distribution-policy-initialize.v2", config: { schema: "distribution-policy.v3", scope, enabled: true, participation: "AUTO_AT_REGISTRATION", depth: 1, selfRebate: false, accountModes: ["ordinary", "custom"], minimumAccrualCents: "1", settlementDelayDays, levels, legacySource }, reason: "承接已核旧平台租赁分销策略和有效档位" };
}

/** New rounds use the API's exact decimal normalization; sealed old rounds keep their original rule. */
export function validatedLegacyDistributionPayload(sourcePayload, parsePolicy, canonicalize, fresh) {
  assert(typeof parsePolicy === 'function' && typeof canonicalize === 'function' && typeof fresh === 'boolean', 'DISTRIBUTION_POLICY_VALIDATOR_REQUIRED');
  const parsed = parsePolicy(sourcePayload);
  if (!fresh) assert.equal(canonicalize(parsed), canonicalize(sourcePayload), 'DISTRIBUTION_POLICY_INVALID');
  return fresh ? parsed : sourcePayload;
}

export function normalizedDistributionPolicyFormat(format, roundReceipt) {
  const proved = roundReceipt?.distributionSourcePreflight?.status === 'DISTRIBUTION_SOURCE_PRECHECK_PASSED_TARGET_NOT_RUN';
  if (format === undefined) { assert(!proved, 'DISTRIBUTION_POLICY_FORMAT_REQUIRED'); return false; }
  assert(format === 'SOURCE_API_NORMALIZED_V1' && proved, 'DISTRIBUTION_POLICY_FORMAT_UNPROVEN');
  return true;
}

/** The payload and its summary are built from the same verified source bytes. */
export async function loadLegacyDistributionPrerequisite({ sourceDir, receipt, sourceSha256, canonicalize, parsePolicy, safePath = value => value }) {
  assert(receipt?.status === "CAPTURED_READ_ONLY" && receipt.rollbackConfirmed === true && receipt.clientClosed === true
    && hex.test(sourceSha256 ?? "") && typeof sourceDir === "string" && typeof canonicalize === "function"
    && typeof parsePolicy === "function" && typeof safePath === "function", "DISTRIBUTION_PREFLIGHT_SOURCE_REQUIRED");
  const receiptPath = safePath(join(sourceDir, "receipt.json"));
  const receiptBytes = readFileSync(receiptPath);
  assert(sha(receiptBytes) === sourceSha256, "DISTRIBUTION_PREFLIGHT_RECEIPT_CHANGED");
  assert.deepEqual(JSON.parse(receiptBytes), receipt, "DISTRIBUTION_PREFLIGHT_RECEIPT_CHANGED");
  const rows = {};
  for (const name of ["distributionConfig", "distributionLevels"]) {
    const entry = receipt.files?.[name];
    assert(entry && typeof entry.file === "string" && entry.file === basename(entry.file) && hex.test(entry.sha256 ?? "")
      && Number.isSafeInteger(entry.rows) && entry.rows >= 0, "DISTRIBUTION_PREFLIGHT_SOURCE_REQUIRED");
    rows[name] = [];
    await readVerifiedSourceRows(safePath(join(sourceDir, entry.file)), entry, row => rows[name].push(row));
  }
  const rawPayload = legacyDistributionPolicy({ scope: "NATIVE", receiptSha256: sourceSha256,
    configurationSha256: receipt.files.distributionConfig.sha256, levelsSha256: receipt.files.distributionLevels.sha256,
    configuration: rows.distributionConfig, rawLevels: rows.distributionLevels });
  const payload = validatedLegacyDistributionPayload(rawPayload, parsePolicy, canonicalize, true);
  assert(sha(readFileSync(receiptPath)) === sourceSha256, "DISTRIBUTION_PREFLIGHT_RECEIPT_CHANGED");
  const summary = { status: "DISTRIBUTION_SOURCE_PRECHECK_PASSED_TARGET_NOT_RUN", sourceReceiptSha256: sourceSha256,
    configurationSha256: receipt.files.distributionConfig.sha256, levelsSha256: receipt.files.distributionLevels.sha256,
    configurationRows: rows.distributionConfig.length, sourceLevels: rows.distributionLevels.length,
    activeLevels: payload.config.levels.length, settlementDelayDays: payload.config.settlementDelayDays,
    policyDigest: sha(canonicalize(payload.config)), connections: 0, targetWrites: 0 };
  return { payload, summary };
}

/** Catch missing or invalid source policy before a long core migration begins. */
export async function verifyLegacyDistributionPrerequisite(options) {
  return (await loadLegacyDistributionPrerequisite(options)).summary;
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
  const seen = new Set(), accepted = [], existing = [], ineligible = [], unresolved = [], exceptions = [];
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
    // A missing original qualification is not a grant, denial, or default tier. Keep the exact
    // pre-existing UNKNOWN row outside all write batches and verify it again during readback.
    if (item.fact.qualificationSource === null && fact.eligibility === "UNKNOWN" && fact.commissionFrozen === null && fact.levelId === null
      && row.eligibility === "UNKNOWN" && row.policy_version_id === null && row.level_code === null) {
      unresolved.push({ userId: row.user_id, sourceDigest: row.source_digest, revision: row.revision, frozen: null, reason: "ORIGINAL_QUALIFICATION_MISSING" }); continue;
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
  return { scope: config.scope, policyId, policyDigest, approvalBody, approvalKey: "legacy_policy_" + sha(canonicalize(approvalBody)).slice(0, 40), accepted, existing, ineligible, unresolved, exceptions, batches };
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
  assert.deepEqual(after.unresolved ?? [], before.unresolved ?? [], "QUALIFICATION_READBACK_UNRESOLVED_CHANGED");
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
    && JSON.stringify(receipt.target?.instance ?? null) === JSON.stringify(binding.target.instance ?? null)
    && (receipt.target?.migrationProfile ?? null) === (binding.target.migrationProfile ?? null)
    && receipt.financialWrites === 0 && receipt.lockReleased === true && receipt.lockClientClosed === true && receipt.clientsClosed === true
    && Array.isArray(receipt.steps) && ["decision", "execute", "approval-readback"].every(name => receipt.steps.some(step => step.step === name && step.status === 200)), "DISTRIBUTION_APPROVAL_RECEIPT_REQUIRED");
  assertHistoricalFinanceUnchanged(binding.historicalFinance, receipt.historicalFinanceBaseline, canonicalize);
  assertHistoricalFinanceUnchanged(binding.historicalFinance, receipt.historicalFinanceReadback, canonicalize);
}

export function assertQualificationPlanBinding(plan, binding, canonicalize) {
  assert(plan.schema === "zzsh.local-distribution-qualification-plan.v1" && plan.inputSha256 === binding.inputSha256 && plan.datasetSha256 === binding.datasetSha256 && plan.sourceDigest === binding.sourceDigest && plan.candidateSha256 === binding.candidateSha256 && plan.scope === binding.scope && plan.target?.oid === binding.target.oid && plan.target?.nonce === binding.target.nonce && plan.target?.database === binding.target.database && plan.target?.marker === binding.target.marker && plan.target?.migrationRoleOid === binding.target.migrationRoleOid && JSON.stringify(plan.target?.instance ?? null) === JSON.stringify(binding.target.instance ?? null) && (plan.target?.migrationProfile ?? null) === (binding.target.migrationProfile ?? null) && plan.buildDigest === binding.buildDigest && canonicalize(plan.toolFiles) === canonicalize(binding.toolFiles) && plan.readOnlyRollbackAck && plan.clientClosed && plan.headCompatible && Array.isArray(plan.exceptions) && plan.exceptions.length === 0, "DISTRIBUTION_PLAN_BINDING_CHANGED");
  assertQualificationBatches(plan, canonicalize);
  assert(Array.isArray(plan.existing) && Array.isArray(plan.ineligible) && Array.isArray(plan.unresolved ?? [])
    && (plan.unresolved ?? []).every(row => row.reason === "ORIGINAL_QUALIFICATION_MISSING" && row.frozen === null
      && typeof row.userId === "string" && hex.test(row.sourceDigest ?? "") && /^[1-9]\d{0,18}$/.test(row.revision ?? "")), "DISTRIBUTION_UNRESOLVED_INVALID");
  assert.equal(plan.existing.length, 0, "ORIGINAL_QUALIFICATION_PLAN_REQUIRED_FOR_EXISTING_SUBJECTS");
  const subjects = [...plan.accepted, ...plan.existing, ...plan.ineligible, ...(plan.unresolved ?? [])].map(row => row.userId);
  assert(subjects.length === binding.expectedParticipants && new Set(subjects).size === subjects.length, "DISTRIBUTION_PLAN_POPULATION_CHANGED");
}

export function assertQualificationAuthority(authority, binding, now = Date.now()) {
  const start = Date.parse(authority.notBefore), end = Date.parse(authority.expiresAt);
  assert(authority.schema === "root-reviewed-legacy-distribution-qualification.v2" && authority.approvedBy === "Root" && authority.status === "APPROVED" && authority.inputSha256 === binding.inputSha256 && authority.planSha256 === binding.planSha256 && authority.scope === binding.scope && authority.policyId === binding.policyId && authority.policyDigest === binding.policyDigest && authority.target?.oid === binding.target.oid && authority.target?.nonce === binding.target.nonce && authority.target?.database === binding.target.database && authority.target?.marker === binding.target.marker && authority.target?.migrationRoleOid === binding.target.migrationRoleOid && JSON.stringify(authority.target?.instance ?? null) === JSON.stringify(binding.target.instance ?? null) && (authority.target?.migrationProfile ?? null) === (binding.target.migrationProfile ?? null) && authority.lock === 806006 && authority.allowFinancialWrites === false && start <= now && now < end && end - start <= 30 * 60000 && start >= Date.parse(binding.window?.notBefore) && end <= Date.parse(binding.window?.expiresAt), "DISTRIBUTION_AUTHORITY_CHANGED_OR_EXPIRED");
}

export function reviewedDistributionActor(actorFile, target, approved) {
  const actor = { userId: actorFile?.id ?? actorFile?.actorId, sessionId: actorFile?.sessionId, requestId: approved?.requestId };
  assert(actorFile?.realm === "admin" && actorFile.resourceOid === target.oid && actorFile.nonce === target.nonce && actor.userId === approved?.userId && actor.sessionId === approved?.sessionId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(actor.requestId ?? ""), "DISTRIBUTION_ACTOR_CHANGED");
  return actor;
}
