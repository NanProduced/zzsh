import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertFinalLegacyBankSchema, makeLegacyBankAuthority, relativeBankSecretPath, requireFinalR06ApiDist } from "./prepare-local-legacy-bank-input.mjs";

const input = { schema: "zzsh.local-legacy-bank-input.v1", target: { round: 6, databaseOid: 123 }, source: { sourceReceiptSha256: "a".repeat(64) },
  dataset: { sha256: "b".repeat(64) }, buildSha256: "c".repeat(64), schemaJournalSha256: "d".repeat(64), schemaHistorySha256: "e".repeat(64) };
const inputSha = "1".repeat(64), planSha = "2".repeat(64), window = { notBefore: "2026-11-05T00:00:00.000Z", expiresAt: "2026-11-05T01:00:00.000Z" };
const plan = { schema: "zzsh.local-legacy-bank-plan.v1", inputSha256: inputSha, datasetSha256: input.dataset.sha256, buildSha256: input.buildSha256,
  schemaJournalSha256: input.schemaJournalSha256, schemaHistorySha256: input.schemaHistorySha256, binding: { target: input.target, source: input.source },
  commitment: "3".repeat(64), counts: { ready: 7 } };

test("保护钥引用只转换为工作目录内 .secrets 相对路径，最终构建限定同根且拒绝链接", () => {
  const api = resolve("E:/zzsh/zzsh/apps/api"), key = join(api, ".secrets", "synthetic", "key.v1");
  assert.equal(relativeBankSecretPath(api, key), ".secrets/synthetic/key.v1");
  assert.throws(() => relativeBankSecretPath(api, resolve("E:/zzsh/zzsh/outside-key")));
  assert.throws(() => relativeBankSecretPath(api, join(api, ".secrets", "..unsafe", "key.v1")));
  assert.throws(() => relativeBankSecretPath(api, ".secrets/key.v1"));
  const root = resolve("D:/synthetic-r06/source"), expected = join(root, "apps/api/dist-r06-v3/src"), plain = () => ({ isSymbolicLink: () => false });
  assert.equal(requireFinalR06ApiDist(root, expected, plain), expected);
  assert.throws(() => requireFinalR06ApiDist(root, join(root, "apps/api/dist/src"), plain));
  assert.throws(() => requireFinalR06ApiDist(root, resolve("D:/another-source/apps/api/dist-r06-v3/src"), plain));
  assert.throws(() => requireFinalR06ApiDist(root, expected, p => ({ isSymbolicLink: () => p === join(root, "apps/api/dist-r06-v3") })));
});

test("只接受完整 ACK 的 0157 之后最终 schema；中间 0156 或目标漂移拒绝", () => {
  const target = { round: 6, host: "127.0.0.1", port: 55432, database: "zzsh_test_regression", databaseOid: 123, marker: "zzsh:regression-test:v1",
    nonce: "a".repeat(24), owner: "zzsh", ownerOid: 456, runtimeUser: "zzsh_regression_runtime", runtimeRoleOid: 789 };
  const proof = { schema: "zzsh.round06-bank-schema-proof.v1", status: "FINAL_SCHEMA_READBACK_ACK", finalOrdinal: 157, target,
    journalSha256: "d".repeat(64), historySha256: "e".repeat(64), readOnlyRollbackAck: true, clientClosed: true };
  const final = { schema: "zzsh.round06-final-schema.v1", status: "FINAL_SCHEMA_VERIFIED", finalOrdinal: 157, journalSha256: proof.journalSha256,
    operation: "POST_SWAP_READ_ONLY_REVALIDATION", actualMigrationPerformed: false, stageReceipt: { path: "stage", sha256: "1".repeat(64) },
    swapReceipt: { path: "swap", sha256: "2".repeat(64) }, stageHashes: Array(5).fill("3".repeat(64)),
    historySha256: proof.historySha256, readOnlyRollbackAck: true, clientClosed: true, unlockAck: true, maintenanceClosed: true,
    target: { database: target.database, oid: target.databaseOid, nonce: target.nonce, marker: target.marker, owner: target.owner, ownerOid: target.ownerOid,
      runtimeUser: target.runtimeUser, runtimeRoleOid: target.runtimeRoleOid } };
  const registry = { database: target.database, oid: target.databaseOid, marker: target.marker, nonce: target.nonce, pendingReset: false,
    roles: { runtime: { name: target.runtimeUser, oid: target.runtimeRoleOid } } };
  const stage = { status: "FINAL_SCHEMA_0157_VERIFIED", target: { database: "zzsh_test_round06_stage", marker: "zzsh:round06-schema-build:v1", oid: target.databaseOid, nonce: target.nonce },
    hashes: final.stageHashes, commitAck: true, unlockAck: true, maintenanceClosed: true };
  const swap = { status: "COMMIT_ACK", oid: target.databaseOid, nonce: target.nonce, schemaReceiptSha256: final.stageReceipt.sha256, unlockAck: true, maintenanceClosed: true,
    targetIdentity: { ...final.target, runtimeRole: target.runtimeUser, rollbackAck: true, clientClosed: true } };
  assert.deepEqual(assertFinalLegacyBankSchema(proof, final, registry, stage, swap), target);
  for (const changed of [{ ...final, status: "INTERMEDIATE_0156_INSTALLED_FINAL_0157_REQUIRED" }, { ...final, finalOrdinal: 156 },
    { ...final, readOnlyRollbackAck: "true" }, { ...final, actualMigrationPerformed: true }, { ...final, target: { ...final.target, oid: 3179610 } }])
    assert.throws(() => assertFinalLegacyBankSchema(proof, changed, registry, stage, swap));
  assert.throws(() => assertFinalLegacyBankSchema({ ...proof, finalOrdinal: 156 }, final, registry, stage, swap));
  assert.throws(() => assertFinalLegacyBankSchema(proof, final, { ...registry, nonce: "b".repeat(24) }, stage, swap));
  assert.throws(() => assertFinalLegacyBankSchema(proof, final, registry, { ...stage, target: { ...stage.target, database: target.database } }, swap));
  assert.throws(() => assertFinalLegacyBankSchema(proof, final, registry, stage, { ...swap, schemaReceiptSha256: "f".repeat(64) }));
});

test("审批只绑定目标、来源、schema、构建、计划摘要与窗口，不包含用户或卡资料", () => {
  const result = makeLegacyBankAuthority(input, inputSha, plan, planSha, window, "r06-bank-review");
  assert.equal(result.maxWrites, 7); assert.equal(result.purpose, "ROUND_06_BANK_IMPORT");
  assert(!JSON.stringify(result).includes("synthetic-name")); assert(!JSON.stringify(result).includes("0000000000000015"));
});
test("目标、源、schema、构建或原计划不一致以及无效窗口均拒绝生成", () => {
  for (const altered of [{ ...plan, inputSha256: "f".repeat(64) }, { ...plan, schemaHistorySha256: "f".repeat(64) },
    { ...plan, binding: { ...plan.binding, target: { ...input.target, databaseOid: 124 } } },
    { ...plan, binding: { ...plan.binding, source: { sourceReceiptSha256: "f".repeat(64) } } }, { ...plan, counts: { ready: 0 } }])
    assert.throws(() => makeLegacyBankAuthority(input, inputSha, altered, planSha, window, "review"));
  assert.throws(() => makeLegacyBankAuthority(input, inputSha, plan, planSha, { ...window, expiresAt: window.notBefore }, "review"));
  assert.throws(() => makeLegacyBankAuthority(input, inputSha, plan, planSha, window, "bad approval ref"));
});
test("无参数默认只输出计划，不读 key、不连数据库", () => {
  const result = spawnSync(process.execPath, [new URL("./prepare-local-legacy-bank-input.mjs", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")], { encoding: "utf8" });
  assert.equal(result.status, 0); const output = JSON.parse(result.stdout);
  assert.equal(output.status, "PLAN_ONLY"); assert.equal(output.dbConnections, 0); assert.equal(output.keyReads, 0); assert.equal(output.keysGenerated, 0);
});
