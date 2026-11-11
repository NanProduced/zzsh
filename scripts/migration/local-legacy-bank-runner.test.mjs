import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Synthetic source provider; no MySQL, PostgreSQL, bank or channel connections.
const source = { rows: [{ user_id: "unit-user-1", name: "synthetic-name", card_no: "0000000000000015" }], userDigests: new Map([["unit-user-1", "a".repeat(64)]]),
  source: { sourceReceiptSha256: "d".repeat(64) } };
const selection = { selected: new Map([["unit-user-1", "a".repeat(64)]]), sourceReceiptSha256: "d".repeat(64), datasetSha256: "e".repeat(64) };
const selectionInput = { path: "synthetic-manifest", sha256: "e".repeat(64) };
mock.module(new URL("./local-legacy-bank-source.mjs", import.meta.url), { namedExports: {
  captureBoundLegacyBankSource: async () => ({}), useBoundLegacyBankSource: () => source, releaseBoundLegacyBankSource: () => {},
  captureBoundLegacyBankSelection: async () => ({}), useBoundLegacyBankSelection: () => selection, releaseBoundLegacyBankSelection: () => {},
} });
const { bankCleanupPassed, recordBankCleanup, prepareLocalLegacyBankRun, describeLocalLegacyBankRun, executeLocalLegacyBankRun, readbackLocalLegacyBankRun, releaseLocalLegacyBankRun } = await import("./local-legacy-bank-runner.mjs");
const binding = { target: { round: 6, databaseOid: 100 }, source: { sourceDumpSha256: "1".repeat(64) } };
function fixture() {
  const events = [], receipts = [], state = { commitUnknown: false, readback: true, locks: 0, buildChecks: 0, targetBindings: "1", targetAudits: "1" };
  const api = { prepareLegacyBankImport: () => ({}), legacyBankImportBinding: () => binding,
    legacyBankImportCounts: () => ({ source: 2, ready: 2, invalid: 0, duplicate: 0, userSourceMissing: 0 }),
    legacyBankImportCommitment: () => "2".repeat(64), legacyBankImportRequestId: () => "bank-import_" + "a".repeat(32), legacyBankImportSubjects: () => ["unit-user-1", "unit-user-2"],
    async importLegacyBankBinding(_c, _p, id) { return { status: id === "unit-user-1" ? "IMPORTED" : "TARGET_NOT_AVAILABLE", encryptMs: 1,
      encryptStartedAt: "2026-11-05T00:00:00.000Z", encryptFinishedAt: "2026-11-05T00:00:00.001Z" }; },
    async readbackLegacyBankBinding() { events.push("readback"); return state.readback; }, releaseLegacyBankImportPlan() {} };
  const pool = kind => ({ async connect() { return { async query(sql) { events.push(kind + ":" + sql); if (sql === "COMMIT" && state.commitUnknown) throw Error("unknown");
    if (kind === "read" && sql.startsWith("SELECT") && sql.includes("withdrawal_bank_binding")) return { rows: [{ bindings: state.targetBindings, legacy_import_audits: state.targetAudits }] };
    return { command: sql }; },
    release(destroy) { events.push(kind + ":release:" + Boolean(destroy)); } }; } });
  return { events, receipts, state, api, writePool: pool("write"), readPool: pool("read"), persistBatch: async value => { events.push("receipt:" + value.phase); receipts.push(value); },
    verifyBuild: async () => { state.buildChecks++; }, verifyReadTarget: async () => { events.push("read:verify-identity"); },
    withMaintenanceLock: async fn => { state.locks++; await fn(); } };
}
const authority = { schema: "zzsh.local-legacy-bank-authority.v1", purpose: "ROUND_06_BANK_IMPORT", binding, commitment: "2".repeat(64),
  buildSha256: "3".repeat(64), maxWrites: 2, notBefore: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };

test("R07 bank authority cannot reuse R06 purpose or target", async () => {
  const f=fixture(),r07={...binding,target:{...binding.target,round:7}};f.api.legacyBankImportBinding=()=>r07;
  const token=await prepareLocalLegacyBankRun({sourceInput:{},selectionInput,canonicalize:()=>"",target:r07.target,options:{},api:f.api});
  await assert.rejects(executeLocalLegacyBankRun(token,{...f,authority:{...authority,binding:r07},buildSha256:authority.buildSha256}));
  const report=await executeLocalLegacyBankRun(token,{...f,authority:{...authority,binding:r07,purpose:"ROUND_07_BANK_IMPORT"},buildSha256:authority.buildSha256});
  assert.equal(report.status,"READBACK_MATCHED_WITH_ISOLATIONS");releaseLocalLegacyBankRun(token);
});
test("next-round bank authority cannot reuse an old round purpose",async()=>{
  const f=fixture(),next={...binding,target:{...binding.target,round:'next',migrationProfile:'LOCAL_MIGRATION_NEXT_V1'}};f.api.legacyBankImportBinding=()=>next;
  const token=await prepareLocalLegacyBankRun({sourceInput:{},selectionInput,canonicalize:()=>"",target:next.target,options:{},api:f.api});
  await assert.rejects(executeLocalLegacyBankRun(token,{...f,authority:{...authority,binding:next,purpose:'ROUND_07_BANK_IMPORT'},buildSha256:authority.buildSha256}));
  const blocked=await executeLocalLegacyBankRun(token,{...f,authority:{...authority,binding:next,purpose:'LOCAL_MIGRATION_BANK_IMPORT'},buildSha256:authority.buildSha256});
  assert.equal(blocked.status,'STOPPED');assert(!f.events.includes('write:BEGIN'));
  f.withMaintenanceLock=async fn=>fn({writePool:f.writePool,verifyWrite:async()=>f.events.push('write:fence'),verifyRead:async()=>f.events.push('read:fence')});
  const report=await executeLocalLegacyBankRun(token,{...f,authority:{...authority,binding:next,purpose:'LOCAL_MIGRATION_BANK_IMPORT'},buildSha256:authority.buildSha256});
  assert.equal(report.status,'READBACK_MATCHED_WITH_ISOLATIONS');assert.equal(report.targetFence,'HELD_ACROSS_WRITE_AND_READBACK');
  assert.equal(f.events.filter(event=>event==='write:fence').length,2);assert.equal(f.events.filter(event=>event==='read:fence').length,2);
  releaseLocalLegacyBankRun(token);
});

test('next-round bank import rolls back when its target fence is lost before commit',async()=>{
  const f=fixture(),next={...binding,target:{...binding.target,round:'next',migrationProfile:'LOCAL_MIGRATION_NEXT_V1'}};f.api.legacyBankImportBinding=()=>next;
  let checks=0;f.withMaintenanceLock=async fn=>fn({writePool:f.writePool,verifyWrite:async()=>{if(++checks===2)throw Error('TARGET_FENCE_EPOCH_LOST')},verifyRead:async()=>{}});
  const token=await prepareLocalLegacyBankRun({sourceInput:{},selectionInput,canonicalize:()=>'',target:next.target,options:{},api:f.api});
  const report=await executeLocalLegacyBankRun(token,{...f,authority:{...authority,binding:next,purpose:'LOCAL_MIGRATION_BANK_IMPORT'},buildSha256:authority.buildSha256});
  assert.equal(report.rollbackAck,true);assert(f.events.includes('write:ROLLBACK'));assert(!f.events.includes('write:COMMIT'));
  releaseLocalLegacyBankRun(token);
});

test("候选报告只有绑定、计数和耗时，审核不含用户或银行卡数据", async () => {
  const f = fixture(), token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
  const summary = describeLocalLegacyBankRun(token), text = JSON.stringify(summary);
  assert.equal(summary.counts.ready, 2); assert.equal(summary.plaintextSourceRowsPersisted, false);
  assert(!text.includes("synthetic-name")); assert(!text.includes("0000000000000015")); assert(!text.includes("unit-user"));
  releaseLocalLegacyBankRun(token); assert.throws(() => describeLocalLegacyBankRun(token));
});
test("没有导入的银行卡须区分源数据为空和全部待核", async () => {
  for (const reason of ["invalid", "targetNotAvailable", "empty"]) {
    const f = fixture();
    f.state.targetBindings = "0"; f.state.targetAudits = "0";
    if (reason !== "targetNotAvailable") {
      f.api.legacyBankImportCounts = () => ({ source: reason === "invalid" ? 2 : 0, ready: 0, invalid: reason === "invalid" ? 2 : 0, duplicate: 0, userSourceMissing: 0 });
      f.api.legacyBankImportSubjects = () => [];
    } else {
      f.api.importLegacyBankBinding = async () => ({ status: "TARGET_NOT_AVAILABLE", encryptMs: 0 });
    }
    const token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
    const report = await executeLocalLegacyBankRun(token, { ...f, authority, buildSha256: authority.buildSha256 });
    assert.equal(report.status, reason === "empty" ? "NO_BINDINGS_IMPORTED" : "NO_BINDINGS_IMPORTED_REVIEW_REQUIRED");
    assert.equal(report.counts.imported, 0);
    assert.equal(reason === "targetNotAvailable" ? report.counts.targetNotAvailable : report.sourceCounts.invalid, reason === "empty" ? 0 : 2);
    assert.equal(report.readbackRollbackAck, true);
    releaseLocalLegacyBankRun(token);
  }
});
test("审核绑定、独立连接与锁必需；提交后独立只读读回并记录各阶段", async () => {
  const f = fixture(), token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
  await assert.rejects(executeLocalLegacyBankRun(token, { ...f, authority: { ...authority, commitment: "4".repeat(64) }, buildSha256: authority.buildSha256 }));
  const report = await executeLocalLegacyBankRun(token, { ...f, authority, buildSha256: authority.buildSha256 });
  assert.equal(report.status, "READBACK_MATCHED_WITH_ISOLATIONS"); assert.equal(report.counts.imported, 1); assert.equal(report.counts.targetNotAvailable, 1);
  assert.equal(report.counts.readbackMatched, 1); assert.equal(f.state.locks, 1); assert.equal(f.state.buildChecks, 2);
  assert.equal(report.readbackRollbackAck, true);
  assert.deepEqual(f.receipts.map(x => x.phase), ["INTENT", "COMMIT_ACK"]); assert.equal(f.receipts[1].imported, 1); assert.equal(f.receipts[1].targetNotAvailable, 1);
  assert(f.events.indexOf("receipt:INTENT") < f.events.indexOf("write:BEGIN")); assert(f.events.indexOf("write:COMMIT") < f.events.indexOf("receipt:COMMIT_ACK"));
  assert(f.events.includes("read:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")); assert(f.events.includes("read:ROLLBACK"));
  assert(report.stages.sourceReadAndVerify.startedAt && report.stages.sourceReadAndVerify.finishedAt);
  assert(report.stages.writes.startedAt && report.stages.writes.finishedAt && report.stages.independentReadback.startedAt && report.stages.independentReadback.finishedAt);
  assert.equal(report.stages.encryption.totalMs, 2); assert.equal(report.sourceMode, "REUSED_BOUND_DUMP");
  assert(Object.values(report.durationMs).every(n => typeof n === "number" && n >= 0)); assert(!JSON.stringify(report).includes("unit-user"));
});
test("新出现的映射或已有卡冲突回滚当前批并停，不把冲突当已批准隔离", async () => {
  for (const conflict of ["TARGET_NOT_MATCHED", "BINDING_CONFLICT"]) {
    const f = fixture(), original = f.api.importLegacyBankBinding;
    f.api.importLegacyBankBinding = async (c, p, id, ...rest) => id === "unit-user-2" ? { status: conflict, encryptMs: 0 } : original(c, p, id, ...rest);
    const token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
    const report = await executeLocalLegacyBankRun(token, { ...f, authority, buildSha256: authority.buildSha256 });
    assert.equal(report.status, "CONFLICT_STOPPED"); assert.equal(report.conflictType, conflict); assert.equal(report.rollbackAck, true);
    assert.equal(report.counts.imported, 0); assert(f.events.includes("write:ROLLBACK")); assert(!f.events.includes("write:COMMIT")); assert(!f.events.includes("readback"));
    assert.deepEqual(f.receipts.map(x => x.phase), ["INTENT", "ROLLBACK_ACK"]);
  }
});
test("先前批次已提交后遇新冲突停下，且回滚结果未知不报告成功", async () => {
  const f = fixture(); f.api.importLegacyBankBinding = async (_c, _p, id) => ({ status: id === "unit-user-1" ? "IMPORTED" : "BINDING_CONFLICT", encryptMs: 0 });
  const token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
  const report = await executeLocalLegacyBankRun(token, { ...f, authority, buildSha256: authority.buildSha256, batchSize: 1 });
  assert.equal(report.status, "CONFLICT_STOPPED"); assert.equal(report.counts.imported, 1); assert.equal(f.events.filter(x => x === "write:COMMIT").length, 1);
  const g = fixture(); g.api.importLegacyBankBinding = async () => ({ status: "BINDING_CONFLICT", encryptMs: 0 });
  g.writePool = { async connect() { return { async query(sql) { if (sql === "ROLLBACK") throw Error("unknown"); return { command: sql }; }, release() {} }; } };
  const next = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: g.api });
  assert.equal((await executeLocalLegacyBankRun(next, { ...g, authority, buildSha256: authority.buildSha256 })).status, "ROLLBACK_UNKNOWN");
});
test("COMMIT 结果未知立即停止，不自动重试或宣称读回成功", async () => {
  const f = fixture(), token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
  f.state.commitUnknown = true;
  const report = await executeLocalLegacyBankRun(token, { ...f, authority, buildSha256: authority.buildSha256 });
  assert.equal(report.status, "COMMIT_UNKNOWN"); assert.equal(report.counts.imported, 0); assert.equal(report.unknownBatchSize, 2);
  assert(!f.events.includes("readback")); assert(f.events.includes("write:release:true"));
  assert.deepEqual(f.receipts.map(x => x.phase), ["INTENT", "COMMIT_UNKNOWN"]);
  const before = f.events.filter(event => event.startsWith("write:")).length;
  f.state.targetBindings = "2"; f.state.targetAudits = "2";
  const recovery = await readbackLocalLegacyBankRun(token, { ...f, buildSha256: authority.buildSha256 });
  assert.equal(recovery.status, "ORIGINAL_KEYS_READ_BACK"); assert.equal(recovery.writeCount, 0); assert.equal(recovery.automaticRetry, false);
  assert.equal(recovery.readbackRollbackAck, true);
  assert.equal(f.events.filter(event => event.startsWith("write:")).length, before);
});
test("原键回查区分全部匹配、部分缺失、源数据隔离和计数不闭合", async () => {
  for (const scenario of ["all", "missing", "isolated", "bad-count", "bad-subject-count"]) {
    const f = fixture();
    if (scenario !== "missing") { f.state.targetBindings = "2"; f.state.targetAudits = "2"; }
    if (scenario === "missing") f.api.readbackLegacyBankBinding = async (_client, _plan, id) => id === "unit-user-1";
    if (scenario === "isolated") f.api.legacyBankImportCounts = () => ({ source: 3, ready: 2, invalid: 1, duplicate: 0, userSourceMissing: 0 });
    if (scenario === "bad-count") f.api.legacyBankImportCounts = () => ({ source: 3, ready: 2, invalid: 0, duplicate: 0, userSourceMissing: 0 });
    if (scenario === "bad-subject-count") f.api.legacyBankImportCounts = () => ({ source: 3, ready: 3, invalid: 0, duplicate: 0, userSourceMissing: 0 });
    const token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
    const report = await readbackLocalLegacyBankRun(token, { ...f, buildSha256: authority.buildSha256 });
    assert.equal(report.status, scenario === "all" ? "ORIGINAL_KEYS_READ_BACK" : scenario.startsWith("bad-") ? "STOPPED" : "ORIGINAL_KEYS_READ_BACK_REVIEW_REQUIRED");
    assert.equal(report.counts.notMatched, scenario === "missing" ? 1 : 0);
    assert.equal(report.sourceCounts.invalid, scenario === "isolated" ? 1 : 0);
    assert.equal(report.readbackRollbackAck, true);
    assert.equal(report.writeCount, 0);
    assert.equal(report.automaticRetry, false);
    releaseLocalLegacyBankRun(token);
  }
});

test("空银行卡来源须在同一只读事务核验目标身份、绑定和旧导入审计均为空", async () => {
  for (const scenario of ["empty", "binding", "audit", "hidden", "bad-count", "missing-identity"]) {
    const f = fixture();
    f.api.legacyBankImportCounts = () => ({ source: 0, ready: 0, invalid: 0, duplicate: 0, userSourceMissing: 0 });
    f.api.legacyBankImportSubjects = () => [];
    f.verifyReadTarget = async () => { f.events.push("read:verify-identity"); };
    if (scenario === "missing-identity") delete f.verifyReadTarget;
    f.readPool = { async connect() { return { async query(sql) {
      f.events.push("read:" + sql);
      if (sql.startsWith("SELECT") && sql.includes("withdrawal_bank_binding")) {
        if (scenario === "hidden") throw Error("row security would hide rows");
        return { rows: [{ bindings: scenario === "binding" ? "1" : scenario === "bad-count" ? null : "0", legacy_import_audits: scenario === "audit" ? "1" : "0" }] };
      }
      return { command: sql };
    }, release(destroy) { f.events.push("read:release:" + Boolean(destroy)); } }; } };
    const token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
    const report = await readbackLocalLegacyBankRun(token, { ...f, buildSha256: authority.buildSha256 });
    assert.equal(report.status, scenario === "empty" ? "ORIGINAL_KEYS_READ_BACK" : ["binding", "audit"].includes(scenario)
      ? "ORIGINAL_KEYS_READ_BACK_REVIEW_REQUIRED" : "STOPPED");
    assert.equal(report.targetSet?.status, scenario === "empty" ? "BANK_TARGET_SET_READBACK_PASSED"
      : ["binding", "audit"].includes(scenario) ? "BANK_TARGET_SET_REVIEW_REQUIRED" : undefined);
    assert.equal(report.writeCount, 0);
    assert(!f.events.some(event => event.startsWith("write:")));
    if (scenario !== "missing-identity") assert(f.events.indexOf("read:verify-identity") < f.events.indexOf("read:SET LOCAL row_security = off"));
    releaseLocalLegacyBankRun(token);
  }
});

test("银行卡原键全匹配时仍需核对目标集合，额外绑定或重复审计不得当作完成", async () => {
  for (const [bindings, audits, expected] of [["2", "2", "ORIGINAL_KEYS_READ_BACK"], ["3", "2", "ORIGINAL_KEYS_READ_BACK_REVIEW_REQUIRED"],
    ["2", "3", "ORIGINAL_KEYS_READ_BACK_REVIEW_REQUIRED"], ["1", "2", "ORIGINAL_KEYS_READ_BACK_REVIEW_REQUIRED"]]) {
    const f = fixture(); f.state.targetBindings = bindings; f.state.targetAudits = audits;
    const token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
    const report = await readbackLocalLegacyBankRun(token, { ...f, buildSha256: authority.buildSha256 });
    assert.equal(report.status, expected);
    assert.equal(report.counts.matchedOriginalKey, 2);
    assert.equal(report.targetSet.expected, "2");
    releaseLocalLegacyBankRun(token);
  }
});

test("执行前拒绝不闭合的来源或重复主体；提交后的目标多余记录保持待核", async () => {
  for (const scenario of ["bad-count", "duplicate-subject", "missing-identity", "extra-target"]) {
    const f = fixture();
    if (scenario === "bad-count") f.api.legacyBankImportCounts = () => ({ source: 3, ready: 2, invalid: 0, duplicate: 0, userSourceMissing: 0 });
    if (scenario === "duplicate-subject") f.api.legacyBankImportSubjects = () => ["unit-user-1", "unit-user-1"];
    if (scenario === "missing-identity") delete f.verifyReadTarget;
    if (scenario === "extra-target") f.state.targetBindings = "2";
    const token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
    if (scenario === "extra-target") {
      const report = await executeLocalLegacyBankRun(token, { ...f, authority, buildSha256: authority.buildSha256 });
      assert.equal(report.status, "READBACK_MISMATCH"); assert.equal(report.targetSet.status, "BANK_TARGET_SET_REVIEW_REQUIRED");
      assert.equal(report.batchSummary.commitAcks, 1); assert.equal(report.automaticRetry, false);
    } else {
      await assert.rejects(executeLocalLegacyBankRun(token, { ...f, authority, buildSha256: authority.buildSha256 }));
      assert(!f.events.some(event => event.startsWith("write:")));
    }
    releaseLocalLegacyBankRun(token);
  }
});
test("清理成功必须确有锁释放、维护连接关闭、schema 事务回滚及三个池关闭 ACK", () => {
  const lock = [{ acquired: true, unlockAck: true, maintenanceClosed: true }], schema = [{ runtimeRollbackAck: true, migrationRollbackAck: true }],
    pools = { writePoolClosed: true, readPoolClosed: true, schemaPoolClosed: true };
  assert.equal(bankCleanupPassed(lock, schema, pools), true);
  assert.equal(bankCleanupPassed([{...lock[0],requiresFence:true,targetFenceReleased:false}], schema, pools), false);
  assert.equal(bankCleanupPassed([{...lock[0],requiresFence:true,targetFenceReleased:true}], schema, pools), true);
  assert.equal(bankCleanupPassed([{ ...lock[0], unlockAck: false }], schema, pools), false);
  assert.equal(bankCleanupPassed(lock, [{ ...schema[0], migrationRollbackAck: false }], pools), false);
  assert.equal(bankCleanupPassed(lock, schema, { ...pools, readPoolClosed: false }), false);
  assert.equal(bankCleanupPassed([], schema, pools), false);
  for (const status of ['COMMIT_UNKNOWN','ROLLBACK_UNKNOWN','BATCH_ACK_PERSIST_FAILED','COMMITTED_READBACK_REQUIRED']) {
    const report=recordBankCleanup({status},[{...lock[0],unlockAck:false}],schema,pools);
    assert.equal(report.status,status);assert.equal(report.cleanupStatus,'CLEANUP_UNKNOWN');
  }
  for (const [l, s, p] of [[[{ ...lock[0], unlockAck: false }], schema, pools], [lock, [{ ...schema[0], migrationRollbackAck: false }], pools], [lock, schema, { ...pools, readPoolClosed: false }]]) {
    const report = recordBankCleanup({ status: "READBACK_MATCHED", counts: { imported: 100 }, automaticRetry: false }, l, s, p);
    assert.equal(report.status, "CLEANUP_UNKNOWN"); assert.equal(report.counts.imported, 100); assert.equal(report.automaticRetry, false);
  }
});
test("批 intent 无法持久化则不开始事务，commit ACK 回执失败则停止且不回滚已提交批", async () => {
  const first = fixture(), token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: first.api });
  first.persistBatch = async () => { throw Error("SYNTHETIC_INTENT_FAILURE"); };
  const a = await executeLocalLegacyBankRun(token, { ...first, authority, buildSha256: authority.buildSha256 });
  assert.equal(a.status, "BATCH_INTENT_WRITE_FAILED"); assert(!first.events.some(x => x.startsWith("write:")));
  const second = fixture(), next = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: second.api });
  const persist = second.persistBatch; second.persistBatch = async value => { if (value.phase === "COMMIT_ACK") throw Error("SYNTHETIC_ACK_FAILURE"); await persist(value); };
  const b = await executeLocalLegacyBankRun(next, { ...second, authority, buildSha256: authority.buildSha256 });
  assert.equal(b.status, "BATCH_ACK_PERSIST_FAILED"); assert.equal(b.counts.imported, 1); assert.equal(b.batchSummary.commitAcks, 0);
  assert(second.events.includes("write:COMMIT")); assert(!second.events.includes("write:ROLLBACK")); assert(!second.events.includes("readback"));
  assert.deepEqual(second.receipts.map(x => x.phase), ["INTENT"]);
});
test("回滚结果未知及回执写入失败都停止，保留原 intent 供原键恢复", async () => {
  const f = fixture(); f.api.importLegacyBankBinding = async () => ({ status: "BINDING_CONFLICT", encryptMs: 0 });
  const persist = f.persistBatch; f.persistBatch = async value => { if (value.phase === "ROLLBACK_ACK") throw Error("SYNTHETIC_TERMINAL_RECEIPT_FAILURE"); await persist(value); };
  const token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
  const report = await executeLocalLegacyBankRun(token, { ...f, authority, buildSha256: authority.buildSha256 });
  assert.equal(report.status, "BATCH_TERMINAL_RECEIPT_FAILED"); assert.equal(report.rollbackAck, true); assert.deepEqual(f.receipts.map(x => x.phase), ["INTENT"]);
});
test("独立读回未收到 ROLLBACK ACK 时不报告成功且保留已提交数量", async () => {
  const f = fixture(); f.readPool = { async connect() { return { async query(sql) { return { command: sql === "ROLLBACK" ? "UNKNOWN" : sql }; }, release() {} }; } };
  const token = await prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api });
  const report = await executeLocalLegacyBankRun(token, { ...f, authority, buildSha256: authority.buildSha256 });
  assert.equal(report.status, "COMMITTED_READBACK_REQUIRED"); assert.equal(report.readbackRollbackAck, false); assert.equal(report.counts.imported, 1); assert.equal(report.batchSummary.commitAcks, 1);
});
test("选集中的用户摘要与源捕获不一致时，在建计划或写入前拒绝", async () => {
  const f = fixture(); selection.selected.set("unit-user-1", "f".repeat(64));
  try { await assert.rejects(prepareLocalLegacyBankRun({ sourceInput: {}, selectionInput, canonicalize: () => "", target: binding.target, options: {}, api: f.api }));
    assert.equal(f.events.length, 0); }
  finally { selection.selected.set("unit-user-1", "a".repeat(64)); }
});
