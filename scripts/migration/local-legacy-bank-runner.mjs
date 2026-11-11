import { performance } from "node:perf_hooks";
import { captureBoundLegacyBankSelection, captureBoundLegacyBankSource, releaseBoundLegacyBankSelection, releaseBoundLegacyBankSource,
  useBoundLegacyBankSelection, useBoundLegacyBankSource } from "./local-legacy-bank-source.mjs";

const prepared = new WeakMap();
const fail = () => { throw Error("LEGACY_BANK_RUN_NOT_AUTHORIZED"); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function validBankPartition(counts, subjects) {
  return ["source", "ready", "invalid", "duplicate", "userSourceMissing"].every(field => Number.isSafeInteger(counts?.[field]) && counts[field] >= 0)
    && counts.source === counts.ready + counts.invalid + counts.duplicate + counts.userSourceMissing
    && subjects.length === counts.ready && new Set(subjects).size === subjects.length;
}
export function bankCleanupPassed(maintenanceChecks, schemaChecks, pools) {
  return Boolean(pools && pools.writePoolClosed === true && pools.readPoolClosed === true && pools.schemaPoolClosed === true
    && Array.isArray(maintenanceChecks) && maintenanceChecks.length > 0 && maintenanceChecks.every(item => item.acquired === true && item.unlockAck === true && item.maintenanceClosed === true
      && (item.requiresFence !== true || item.targetFenceReleased === true))
    && Array.isArray(schemaChecks) && schemaChecks.length > 0 && schemaChecks.every(item => item.runtimeRollbackAck === true && item.migrationRollbackAck === true));
}
export function recordBankCleanup(report, maintenanceChecks, schemaChecks, pools) {
  Object.assign(report, { maintenanceChecks, schemaChecks, ...pools });
  if (!bankCleanupPassed(maintenanceChecks, schemaChecks, pools)) {
    report.cleanupStatus = "CLEANUP_UNKNOWN";
    if (["READBACK_MATCHED", "READBACK_MATCHED_WITH_ISOLATIONS", "NO_BINDINGS_IMPORTED", "ORIGINAL_KEYS_READ_BACK"].includes(report.status))
      report.status = "CLEANUP_UNKNOWN";
  }
  return report;
}

/** No raw source values or user identifiers are returned to the caller or written to disk. */
export async function prepareLocalLegacyBankRun({ sourceInput, selectionInput, canonicalize, target, operator, options, api }) {
  const captureStartedAt = new Date().toISOString(), start = performance.now(); let sourceToken, selectionToken;
  try {
    sourceToken = await captureBoundLegacyBankSource(sourceInput, canonicalize);
    selectionToken = await captureBoundLegacyBankSelection(selectionInput?.path, selectionInput?.sha256);
    const captureMs = performance.now() - start, captureFinishedAt = new Date().toISOString(), mappingStartedAt = captureFinishedAt,
      mapped = performance.now(), source = useBoundLegacyBankSource(sourceToken), selection = useBoundLegacyBankSelection(selectionToken);
    if (selection.sourceReceiptSha256 !== source.source.sourceReceiptSha256 || selection.datasetSha256 !== selectionInput.sha256) fail();
    for (const [id, digest] of selection.selected) if (source.userDigests.get(id) !== digest) fail();
    const plan = api.prepareLegacyBankImport(source.rows, selection.selected, source.source, target, operator);
    const binding = api.legacyBankImportBinding(plan), counts = api.legacyBankImportCounts(plan), commitment = api.legacyBankImportCommitment(plan, options);
    const token = Object.freeze({ kind: "PREPARED_LEGACY_BANK_RUN" });
    prepared.set(token, { api, plan, options, binding, commitment, counts, captureMs, captureStartedAt, captureFinishedAt,
      mappingStartedAt, mappingFinishedAt: new Date().toISOString(), mappingMs: performance.now() - mapped });
    return token;
  } finally { if (sourceToken) releaseBoundLegacyBankSource(sourceToken); if (selectionToken) releaseBoundLegacyBankSelection(selectionToken); }
}

export function describeLocalLegacyBankRun(token) {
  const data = prepared.get(token); if (!data) fail();
  return { schema: "zzsh.local-legacy-bank-plan.v1", binding: data.binding, counts: data.counts, commitment: data.commitment,
    sourceMode: "REUSED_BOUND_DUMP", stages: {
      sourceReadAndVerify: { startedAt: data.captureStartedAt, finishedAt: data.captureFinishedAt, elapsedMs: data.captureMs },
      sourceMappingAndPlan: { startedAt: data.mappingStartedAt, finishedAt: data.mappingFinishedAt, elapsedMs: data.mappingMs },
    }, durationMs: { sourceReadAndVerify: data.captureMs, sourceMappingAndPlan: data.mappingMs }, plaintextSourceRowsPersisted: false };
}

function authorized(authority, data, buildSha256) {
  const now = Date.now();
  return authority && authority.schema === "zzsh.local-legacy-bank-authority.v1" && [6,7,'next'].includes(data.binding?.target?.round)
    && authority.purpose === (data.binding.target.round === 'next' ? "LOCAL_MIGRATION_BANK_IMPORT" : data.binding.target.round === 7 ? "ROUND_07_BANK_IMPORT" : "ROUND_06_BANK_IMPORT")
    && same(authority.binding, data.binding) && authority.commitment === data.commitment && authority.buildSha256 === buildSha256
    && /^[a-f0-9]{64}$/.test(buildSha256 ?? "") && Number.isSafeInteger(authority.maxWrites) && authority.maxWrites >= data.counts.ready
    && Number.isFinite(Date.parse(authority.notBefore)) && Number.isFinite(Date.parse(authority.expiresAt))
    && Date.parse(authority.notBefore) <= now && now < Date.parse(authority.expiresAt);
}

/** Caller owns the registered maintenance lock and sealed build verification; every actual write still checks target identity. */
export async function executeLocalLegacyBankRun(token, { authority, buildSha256, verifyBuild, withMaintenanceLock, writePool, readPool, verifyReadTarget, persistBatch, batchSize = 100 }) {
  const data = prepared.get(token);
  if (!data || !authorized(authority, data, buildSha256) || typeof verifyBuild !== "function" || typeof withMaintenanceLock !== "function"
    || !writePool || !readPool || writePool === readPool || typeof verifyReadTarget !== "function" || typeof persistBatch !== "function"
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) fail();
  const { api, plan, options } = data, subjects = [...api.legacyBankImportSubjects(plan)], imported = [];
  if (!validBankPartition(data.counts, subjects)) fail();
  const report = { schema: "zzsh.local-legacy-bank-receipt.v1", status: "STARTED", sourceCounts: data.counts,
    binding: data.binding, planCommitment: data.commitment, buildSha256, sourceMode: "REUSED_BOUND_DUMP",
    counts: { imported: 0, targetNotMatched: 0, targetNotAvailable: 0, bindingConflict: 0, readbackMatched: 0 },
    batchSummary: { intents: 0, commitAcks: 0, receiptFailures: 0 },
    readbackRollbackAck: false,
    stages: { sourceReadAndVerify: { startedAt: data.captureStartedAt, finishedAt: data.captureFinishedAt, elapsedMs: data.captureMs },
      sourceMappingAndPlan: { startedAt: data.mappingStartedAt, finishedAt: data.mappingFinishedAt, elapsedMs: data.mappingMs },
      encryption: { firstStartedAt: null, lastFinishedAt: null, totalMs: 0 }, writes: { startedAt: null, finishedAt: null },
      independentReadback: { startedAt: null, finishedAt: null } },
    durationMs: { sourceReadAndVerify: data.captureMs, sourceMappingAndPlan: data.mappingMs, encryption: 0, writesExcludingEncryption: 0, independentReadback: 0 },
    plaintextSourceRowsPersisted: false, providerCalls: 0, automaticRetry: false };
  let writing;
  try {
    await withMaintenanceLock(async guard => {
      if (data.binding.target.round === 'next' && (!guard?.writePool || guard.writePool === readPool
        || typeof guard.verifyWrite !== 'function' || typeof guard.verifyRead !== 'function')) fail();
      const activeWritePool = guard?.writePool ?? writePool;
      writing = performance.now(); report.stages.writes.startedAt = new Date().toISOString();
      for (let at = 0; at < subjects.length; at += batchSize) {
        if (!authorized(authority, data, buildSha256)) fail();
        await verifyBuild(buildSha256);
        const batch = subjects.slice(at, at + batchSize), batchNo = Math.floor(at / batchSize) + 1, batchStart = performance.now(), startedAt = new Date().toISOString();
        const receipt = (phase, extra = {}) => ({ schema: "zzsh.local-legacy-bank-batch.v1", phase, batchNo, attempted: batch.length,
          planCommitment: data.commitment, startedAt, ...extra });
        try { await persistBatch(receipt("INTENT")); report.batchSummary.intents++; }
        catch { report.batchSummary.receiptFailures++; report.status = "BATCH_INTENT_WRITE_FAILED"; throw Error("BANK_BATCH_INTENT_FAILED"); }
        const client = await activeWritePool.connect(), results = []; let commitStarted = false, commitAcknowledged = false, destroy = false, conflict;
        try {
          await client.query("BEGIN");
          if (guard) await guard.verifyWrite(client);
          for (const subject of batch) {
            const requestId = api.legacyBankImportRequestId(plan, subject, options);
            const result = await api.importLegacyBankBinding(client, plan, subject, options, requestId);
            if (result.status === "TARGET_NOT_MATCHED" || result.status === "BINDING_CONFLICT") { conflict = result.status; throw Error("BANK_TARGET_CONFLICT"); }
            if (result.status !== "IMPORTED" && result.status !== "TARGET_NOT_AVAILABLE") throw Error("BANK_RESULT_UNEXPECTED");
            results.push({ subject, ...result }); report.durationMs.encryption += result.encryptMs;
            if (result.encryptStartedAt && !report.stages.encryption.firstStartedAt) report.stages.encryption.firstStartedAt = result.encryptStartedAt;
            if (result.encryptFinishedAt) report.stages.encryption.lastFinishedAt = result.encryptFinishedAt;
          }
          if (!authorized(authority, data, buildSha256)) fail(); await verifyBuild(buildSha256);
          if (guard) await guard.verifyWrite(client);
          commitStarted = true; const committed = await client.query("COMMIT"); if (committed?.command !== "COMMIT") throw Error("BANK_COMMIT_UNKNOWN");
          commitStarted = false; commitAcknowledged = true;
          for (const result of results) {
            if (result.status === "IMPORTED") { report.counts.imported++; imported.push(result.subject); }
            else if (result.status === "TARGET_NOT_MATCHED") report.counts.targetNotMatched++;
            else if (result.status === "TARGET_NOT_AVAILABLE") report.counts.targetNotAvailable++;
            else if (result.status === "BINDING_CONFLICT") report.counts.bindingConflict++;
            else fail();
          }
          try {
            await persistBatch(receipt("COMMIT_ACK", { imported: results.filter(item => item.status === "IMPORTED").length,
              targetNotAvailable: results.filter(item => item.status === "TARGET_NOT_AVAILABLE").length,
              cumulativeImported: report.counts.imported, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - batchStart }));
            report.batchSummary.commitAcks++;
          } catch { report.batchSummary.receiptFailures++; report.status = "BATCH_ACK_PERSIST_FAILED"; throw Error("BANK_BATCH_ACK_FAILED"); }
        } catch {
          if (commitStarted) {
            report.status = "COMMIT_UNKNOWN"; report.unknownBatchSize = batch.length; destroy = true;
            try { await persistBatch(receipt("COMMIT_UNKNOWN", { finishedAt: new Date().toISOString(), elapsedMs: performance.now() - batchStart })); }
            catch { report.batchSummary.receiptFailures++; }
          }
          else if (commitAcknowledged) { report.status = "BATCH_ACK_PERSIST_FAILED"; }
          else {
            let rollbackAck = false;
            try { rollbackAck = (await client.query("ROLLBACK"))?.command === "ROLLBACK"; } catch { /* keep outcome unknown */ }
            if (!rollbackAck) destroy = true;
            report.status = !rollbackAck ? "ROLLBACK_UNKNOWN" : conflict ? "CONFLICT_STOPPED" : "STOPPED";
            report.abortedBatchSize = batch.length; report.rollbackAck = rollbackAck;
            if (conflict) report.conflictType = conflict;
            try { await persistBatch(receipt(rollbackAck ? "ROLLBACK_ACK" : "ROLLBACK_UNKNOWN", { conflictType: conflict ?? null,
              finishedAt: new Date().toISOString(), elapsedMs: performance.now() - batchStart })); }
            catch { report.batchSummary.receiptFailures++; if (rollbackAck) report.status = "BATCH_TERMINAL_RECEIPT_FAILED"; }
          }
          throw Error("LEGACY_BANK_BATCH_STOPPED");
        } finally { client.release(destroy ? true : undefined); }
      }
      report.stages.writes.finishedAt = new Date().toISOString();
      report.durationMs.writesExcludingEncryption = Math.max(0, performance.now() - writing - report.durationMs.encryption);
      const readStart = performance.now(); report.stages.independentReadback.startedAt = new Date().toISOString();
      if (guard) await guard.verifyRead();
      const client = await readPool.connect(); let begun = false, destroyRead = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
        await verifyReadTarget(client);
        for (const subject of imported) if (await api.readbackLegacyBankBinding(client, plan, subject, options)) report.counts.readbackMatched++;
        report.targetSet = await readLegacyBankTargetSet(client, report.counts.readbackMatched);
        if ((await client.query("ROLLBACK"))?.command !== "ROLLBACK") throw Error("BANK_READBACK_ROLLBACK_UNKNOWN");
        begun = false; report.readbackRollbackAck = true;
      } finally { try { if (begun) await client.query("ROLLBACK"); } catch { destroyRead = true; throw Error("LEGACY_BANK_READBACK_ROLLBACK_FAILED"); } finally { client.release(destroyRead ? true : undefined); } }
      if (guard) { await guard.verifyRead(); report.targetFence = 'HELD_ACROSS_WRITE_AND_READBACK'; }
      report.durationMs.independentReadback = performance.now() - readStart;
      report.stages.independentReadback.finishedAt = new Date().toISOString();
      const isolated = data.counts.invalid + data.counts.duplicate + data.counts.userSourceMissing + report.counts.targetNotMatched
        + report.counts.targetNotAvailable + report.counts.bindingConflict;
      report.status = report.counts.readbackMatched !== report.counts.imported || report.targetSet?.status !== "BANK_TARGET_SET_READBACK_PASSED" ? "READBACK_MISMATCH"
        : isolated ? (report.counts.imported ? "READBACK_MATCHED_WITH_ISOLATIONS" : "NO_BINDINGS_IMPORTED_REVIEW_REQUIRED")
        : report.counts.imported ? "READBACK_MATCHED" : "NO_BINDINGS_IMPORTED";
    });
    if (report.status === "STARTED") report.status = "STOPPED";
  } catch {
    if (!["COMMIT_UNKNOWN", "ROLLBACK_UNKNOWN", "CONFLICT_STOPPED", "BATCH_INTENT_WRITE_FAILED", "BATCH_ACK_PERSIST_FAILED", "BATCH_TERMINAL_RECEIPT_FAILED"].includes(report.status))
      report.status = report.batchSummary.commitAcks ? "COMMITTED_READBACK_REQUIRED" : "STOPPED";
  }
  if (report.stages.writes.startedAt && !report.stages.writes.finishedAt) report.stages.writes.finishedAt = new Date().toISOString();
  if (report.stages.independentReadback.startedAt && !report.stages.independentReadback.finishedAt) report.stages.independentReadback.finishedAt = new Date().toISOString();
  report.stages.encryption.totalMs = report.durationMs.encryption;
  if (writing !== undefined && !report.durationMs.writesExcludingEncryption && report.status !== "READBACK_MATCHED" && report.status !== "READBACK_MATCHED_WITH_ISOLATIONS")
    report.durationMs.writesExcludingEncryption = Math.max(0, performance.now() - writing - report.durationMs.encryption);
  return report;
}

/** A fresh target must contain exactly the bindings and old import audits individually read back. */
export async function readLegacyBankTargetSet(client, matchedCount) {
  if (!Number.isSafeInteger(matchedCount) || matchedCount < 0) throw Error("BANK_TARGET_SET_EXPECTED_COUNT_INVALID");
  await client.query("SET LOCAL row_security = off");
  const result = await client.query(`SELECT
    (SELECT count(*)::text FROM zzsh_order.withdrawal_bank_binding) AS bindings,
    (SELECT count(*)::text FROM zzsh_iam.audit_event WHERE object_type='withdrawal_bank_binding'
      AND action='withdrawal.bank_binding.legacy_imported' AND outcome='SUCCESS') AS legacy_import_audits`);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || ![row?.bindings, row?.legacy_import_audits].every(value => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)))
    throw Error("BANK_TARGET_SET_UNAVAILABLE");
  const expected = String(matchedCount);
  return { status: row.bindings === expected && row.legacy_import_audits === expected ? "BANK_TARGET_SET_READBACK_PASSED" : "BANK_TARGET_SET_REVIEW_REQUIRED",
    expected, bindings: row.bindings, legacyImportAudits: row.legacy_import_audits };
}

/** Original-key recovery is read-only and never retries an uncertain write. */
export async function readbackLocalLegacyBankRun(token, { buildSha256, verifyBuild, withMaintenanceLock, readPool, verifyReadTarget }) {
  const data = prepared.get(token);
  if (!data || !/^[a-f0-9]{64}$/.test(buildSha256 ?? "") || typeof verifyBuild !== "function" || typeof withMaintenanceLock !== "function" || !readPool) fail();
  const report = { schema: "zzsh.local-legacy-bank-readback.v1", status: "STARTED", binding: data.binding, planCommitment: data.commitment, buildSha256,
    sourceCounts: data.counts, counts: { sourceEligible: data.counts.ready, matchedOriginalKey: 0, notMatched: 0 }, sourceMode: "REUSED_BOUND_DUMP",
    startedAt: new Date().toISOString(), finishedAt: null, elapsedMs: 0, readbackRollbackAck: false, writeCount: 0, automaticRetry: false, plaintextSourceRowsPersisted: false };
  const started = performance.now();
  try {
    await withMaintenanceLock(async guard => {
      if (data.binding.target.round === 'next' && typeof guard?.verifyRead !== 'function') fail();
      if (guard) await guard.verifyRead();
      await verifyBuild(buildSha256);
      const client = await readPool.connect(); let begun = false, destroy = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
        if (typeof verifyReadTarget !== "function") throw Error("BANK_READBACK_TARGET_IDENTITY_REQUIRED");
        await verifyReadTarget(client);
        const subjects = [...data.api.legacyBankImportSubjects(data.plan)];
        if (!validBankPartition(data.counts, subjects)) throw Error("BANK_READBACK_PARTITION_INVALID");
        for (const subject of subjects) {
          if (await data.api.readbackLegacyBankBinding(client, data.plan, subject, data.options)) report.counts.matchedOriginalKey++;
          else report.counts.notMatched++;
        }
        report.targetSet = await readLegacyBankTargetSet(client, report.counts.matchedOriginalKey);
        if ((await client.query("ROLLBACK"))?.command !== "ROLLBACK") throw Error("BANK_READBACK_ROLLBACK_UNKNOWN");
        begun = false; report.readbackRollbackAck = true;
      } finally {
        try { if (begun) { report.readbackRollbackAck = (await client.query("ROLLBACK"))?.command === "ROLLBACK"; if (!report.readbackRollbackAck) destroy = true; } }
        catch { destroy = true; throw Error("LEGACY_BANK_READBACK_ROLLBACK_FAILED"); }
        finally { client.release(destroy ? true : undefined); }
      }
      if (guard) { await guard.verifyRead(); report.targetFence = 'HELD_DURING_READBACK'; }
      await verifyBuild(buildSha256);
      const counts = data.counts;
      if (report.counts.matchedOriginalKey + report.counts.notMatched !== counts.ready) throw Error("BANK_READBACK_PARTITION_INVALID");
      report.status = report.counts.notMatched || counts.invalid || counts.duplicate || counts.userSourceMissing
        || report.targetSet?.status !== "BANK_TARGET_SET_READBACK_PASSED"
        ? "ORIGINAL_KEYS_READ_BACK_REVIEW_REQUIRED" : "ORIGINAL_KEYS_READ_BACK";
    });
  } catch { report.status = "STOPPED"; }
  if (report.status === "STARTED") report.status = "STOPPED";
  report.finishedAt = new Date().toISOString(); report.elapsedMs = performance.now() - started; return report;
}

export function releaseLocalLegacyBankRun(token) { const data = prepared.get(token); if (data) data.api.releaseLegacyBankImportPlan(data.plan); prepared.delete(token); }
