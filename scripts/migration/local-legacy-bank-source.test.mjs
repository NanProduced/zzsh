import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { captureBoundLegacyBankSelection, captureBoundLegacyBankSource, legacyBankPrivateComparisonDigest, legacyBankSnapshotQuery, releaseBoundLegacyBankSelection, useBoundLegacyBankSelection, useBoundLegacyBankSource, verifyLegacyBankSnapshotLines } from "./local-legacy-bank-source.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

test("临时盐摘要绑定五列且与输入顺序无关，不输出原始数据", () => {
  const row = { user_id: "1", name: "synthetic-name", card_no: "0000000000000015", create_time: "1760000000", update_time: "1760000001" };
  const second = { ...row, user_id: "2", card_no: "0000000000000023" }, salt = "a".repeat(64);
  const digest = legacyBankPrivateComparisonDigest([row, second], salt);
  assert.match(digest, /^[a-f0-9]{64}$/); assert.equal(digest, legacyBankPrivateComparisonDigest([second, row], salt));
  assert.notEqual(digest, legacyBankPrivateComparisonDigest([{ ...row, card_no: second.card_no }, second], salt));
  assert.notEqual(digest, legacyBankPrivateComparisonDigest([row, second], "b".repeat(64)));
  assert.throws(() => legacyBankPrivateComparisonDigest([row, row], salt));
  assert(!digest.includes(row.name)); assert(!digest.includes(row.card_no));
});
test("银行卡源快照逐行校验不受聚合长度限制，空集和损坏记录分开", async () => {
  const identity = JSON.stringify({ phase: "identity", database: "sg_zzsh_restore", principal: "root@localhost", readOnly: 1, isolation: "REPEATABLE-READ", accessMode: "READ ONLY", txState: "ACTIVE" });
  const rollback = JSON.stringify({ phase: "rollback" }), salt = "a".repeat(64);
  const rows = Array.from({ length: 31251 }, (_, i) => ({ user_id: String(i + 1), name: "synthetic", card_no: "0000000000000015", create_time: "1760000000", update_time: "1760000001" }));
  const privateHash = row => sha(salt + row.user_id.padStart(24, "0") + String(Buffer.byteLength(row.name)).padStart(6, "0") + row.name
    + String(Buffer.byteLength(row.card_no)).padStart(6, "0") + row.card_no + row.create_time.padStart(16, "0") + row.update_time.padStart(16, "0"));
  const hashes = rows.map(privateHash), digest = legacyBankPrivateComparisonDigest(rows, salt), lines = [identity, ...hashes.map(hash => "B:" + hash), rollback];
  assert.equal(hashes.join("").length, 2000064);
  await verifyLegacyBankSnapshotLines(lines, rows.length, digest);
  await verifyLegacyBankSnapshotLines([identity, rollback], 0, legacyBankPrivateComparisonDigest([], salt));
  for (const invalid of [lines.slice(0, -1), [identity, ...lines.slice(2)], [identity, "B:" + "0".repeat(64), ...lines.slice(2)],
    [identity, ...lines.slice(1), rollback], [JSON.stringify({ phase: "identity" }), ...lines.slice(1)]]) {
    await assert.rejects(verifyLegacyBankSnapshotLines(invalid, rows.length, digest), /LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
  }
  assert.doesNotMatch(legacyBankSnapshotQuery(salt), /GROUP_CONCAT/);
  assert.throws(() => legacyBankSnapshotQuery("invalid"), /LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
});
test("未绑定来源不能取得私有行或触发连接", async () => {
  assert.throws(() => useBoundLegacyBankSource({}));
  assert.throws(() => useBoundLegacyBankSelection({}));
  await assert.rejects(captureBoundLegacyBankSource({}, () => ""), /LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
  await assert.rejects(captureBoundLegacyBankSelection("not-a-sealed-manifest", "a".repeat(64)), /LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
});
test("new bank source verification checks the same frozen server inside the read-only transaction", async () => {
  const uuid="12345678-1234-1234-1234-123456789abc",origin={serverUuid:uuid},salt="a".repeat(64);
  const identity={phase:"identity",database:"sg_zzsh_restore",principal:"root@localhost",readOnly:1,isolation:"REPEATABLE-READ",accessMode:"READ ONLY",txState:"ACTIVE",
    serverUuid:uuid,globalReadOnly:1,superReadOnly:1,eventScheduler:"DISABLED"};
  const digest=legacyBankPrivateComparisonDigest([],salt),tail=JSON.stringify({phase:"rollback"});
  await verifyLegacyBankSnapshotLines([JSON.stringify(identity),tail],0,digest,origin);
  for(const changed of [{serverUuid:"other"},{superReadOnly:0},{eventScheduler:"OFF"}])
    await assert.rejects(verifyLegacyBankSnapshotLines([JSON.stringify({...identity,...changed}),tail],0,digest,origin),/LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
  assert.match(legacyBankSnapshotQuery(salt,true),/serverUuid/);assert.doesNotMatch(legacyBankSnapshotQuery(salt),/serverUuid/);
});
test("银行卡选集读取的实际字节必须匹配封存摘要", { skip: process.platform !== "win32" || !existsSync("E:/zzsh-local-state/restricted") }, async t => {
  const dir = mkdtempSync("E:/zzsh-local-state/restricted/bank-selection-synthetic-"), data = join(dir, "users.jsonl"), path = join(dir, "manifest.json");
  t.after(() => { for (const file of [data, path]) if (existsSync(file)) unlinkSync(file); rmdirSync(dir); });
  const sourceId = "1", row = { sourceId, sourceDigest: "a".repeat(64), userId: `user_${sha(JSON.stringify(["legacy-owner", "legacy_mysql_restore", "la_user", sourceId])).slice(0, 40)}` };
  const bytes = Buffer.from(JSON.stringify(row) + "\n"); writeFileSync(data, bytes);
  const manifest = { status: "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN", sourceReceiptSha256: "b".repeat(64),
    files: { users: { file: "users.jsonl", sha256: sha(bytes), rows: 1 } }, domains: { users: { ready: 1 } } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); writeFileSync(path, manifestBytes);
  const token = await captureBoundLegacyBankSelection(path, sha(manifestBytes));
  try { assert.equal(useBoundLegacyBankSelection(token).selected.get(sourceId), row.sourceDigest); }
  finally { releaseBoundLegacyBankSelection(token); }
  writeFileSync(data, JSON.stringify({ ...row, sourceDigest: "c".repeat(64) }) + "\n");
  await assert.rejects(captureBoundLegacyBankSelection(path, sha(manifestBytes)), /LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
});
