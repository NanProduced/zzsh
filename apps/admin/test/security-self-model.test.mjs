import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { createServer } from "vite";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({
  root: adminRoot,
  configFile: false,
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/security-self-model"),
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
after(async () => {
  await vite.close();
});

// model.ts 复用 api.ts 的既有日期格式；经 Vite 载入避免 Node strip-only 不支持参数属性。
const {
  buildPendingRecord,
  backupCodesResultSubset,
  createLocalPendingStore,
  describeCommandError,
  describeOperation,
  describeReadError,
  dismissedPendingRecords,
  isUnknownOutcome,
  isUnresolvedRecord,
  makeSecurityCommandId,
  normalizeIdleMinutes,
  patchPendingRecord,
  pendingRecordKey,
  removePendingRecord,
  unresolvedGate,
  upsertPendingRecord,
  validateBackupPassword,
  validateOperationResult,
  validatePasswordChange,
  validatePin,
  verifyCommandSuccess,
  visiblePendingRecords,
  SECURITY_PENDING_KEY,
} = await vite.ssrLoadModule("/src/views/security-self/model.ts");

const NOW = "2026-10-14T03:00:00.000Z";

function record(overrides = {}) {
  return {
    adminUserId: "admin-1",
    action: "password.change",
    commandId: "idem_fixture_1",
    targetKind: "credential",
    createdAt: NOW,
    updatedAt: NOW,
    outcome: "unknown",
    dispatched: false,
    ...overrides,
  };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    _map: map,
  };
}

test("1. password validation enforces length, mismatch and same-password rules without inventing server rules", () => {
  assert.deepEqual(validatePasswordChange({ currentPassword: "", newPassword: "", confirmPassword: "" }), {
    currentPassword: "请输入当前密码。",
    newPassword: "请输入新密码。",
  });
  assert.deepEqual(validatePasswordChange({ currentPassword: "current", newPassword: "short", confirmPassword: "short" }), {
    newPassword: "新密码至少 12 位。",
  });
  assert.deepEqual(
    validatePasswordChange({ currentPassword: "current", newPassword: "x".repeat(129), confirmPassword: "x".repeat(129) }),
    { newPassword: "新密码不能超过 128 位。" },
  );
  assert.deepEqual(
    validatePasswordChange({ currentPassword: "same-pass-0001", newPassword: "same-pass-0001", confirmPassword: "same-pass-0001" }),
    { newPassword: "新密码不能与当前密码相同。" },
  );
  assert.deepEqual(
    validatePasswordChange({ currentPassword: "current-pass-1", newPassword: "next-pass-0001", confirmPassword: "next-pass-0001" }),
    {},
  );
  assert.equal(validatePin("12345"), "请输入 6 位数字 PIN。");
  assert.equal(validatePin("123456"), undefined);
  assert.equal(validateBackupPassword(""), "请输入当前登录密码。");
  assert.equal(validateBackupPassword("any"), undefined);
});

test("2. error mapping uses status/code/reason with precise copy and unknown-outcome classification", () => {
  assert.equal(
    describeCommandError("password.change", { status: 400, code: "INVALID_ARGUMENT", reason: "invalid_current_password" }),
    "当前密码不正确，请重新输入。",
  );
  assert.equal(describeCommandError("pin.change", { status: 401, code: "UNAUTHENTICATED", reason: "invalid_pin" }).includes("可能已计入尝试次数"), true);
  assert.equal(describeCommandError("pin.change", { status: 423, code: "FORBIDDEN", reason: "pin_attempt_limit" }).includes("完整重新认证"), true);
  assert.equal(isUnknownOutcome({ status: 0, code: "NETWORK_ERROR" }), true);
  assert.equal(isUnknownOutcome({ status: 500, code: "INTERNAL_ERROR" }), true);
  assert.equal(isUnknownOutcome({ status: 401, code: "UNAUTHENTICATED" }), false);
  assert.equal(describeReadError({ status: 423, code: "FORBIDDEN", reason: "session_locked" }).includes("锁定"), true);
});

test("3. operation presentation covers the four validated read states and session target isolation", () => {
  const completedPassword = describeOperation(
    { commandId: "idem_1", status: "completed", action: "password.change", targetKind: "credential", result: { revokedSessionCount: 3 } },
    { currentSessionId: "session-1" },
  );
  assert.equal(completedPassword.tone, "success");
  assert.ok(completedPassword.lines.join(" ").includes("密码已修改"));
  const unconfirmed = describeOperation({ commandId: "idem_1", status: "unconfirmed" }, { currentSessionId: "session-1" });
  assert.equal(unconfirmed.tone, "warning");
  const expired = describeOperation({ commandId: "idem_1", status: "expired", action: "pin.change" }, { currentSessionId: "session-1" });
  assert.equal(expired.tone, "neutral");
  const otherSession = describeOperation(
    { commandId: "idem_1", status: "completed", action: "pin.change", targetKind: "session", targetSessionId: "session-old" },
    { currentSessionId: "session-1" },
  );
  assert.equal(otherSession.targetNote?.includes("更早的会话"), true);
});

test("4. success envelopes require this request's key, real DTO minimum fields and the original PIN session", () => {
  const commandId = "idem_fixture_verify";
  const passwordReceipt = { passwordChanged: true, sessionsRotated: true, revokedSessionCount: 3, newSessionId: "session-2" };
  assert.equal(verifyCommandSuccess("password.change", { commandId, receipt: passwordReceipt }, commandId), true);
  assert.equal(verifyCommandSuccess("password.change", { receipt: passwordReceipt }, commandId), false, "missing key must fail");
  assert.equal(verifyCommandSuccess("password.change", { commandId: null, receipt: passwordReceipt }, commandId), false, "null key must fail");
  assert.equal(verifyCommandSuccess("password.change", { commandId: "other", receipt: passwordReceipt }, commandId), false);
  assert.equal(verifyCommandSuccess("password.change", {}, commandId), false);
  assert.equal(verifyCommandSuccess("password.change", { commandId, receipt: { passwordChanged: true } }, commandId), false, "one boolean is not the whole DTO");
  assert.equal(verifyCommandSuccess("password.change", { commandId, receipt: { ...passwordReceipt, sessionsRotated: false } }, commandId), false);
  assert.equal(verifyCommandSuccess("password.change", { commandId, receipt: { ...passwordReceipt, newSessionId: "" } }, commandId), false);

  assert.equal(verifyCommandSuccess("pin.set", { commandId, receipt: { pinConfigured: true, sessionId: "session-1" } }, commandId, { sessionId: "session-1" }), true);
  assert.equal(
    verifyCommandSuccess("pin.set", { commandId, receipt: { pinConfigured: true, sessionId: "other-session" } }, commandId, { sessionId: "session-1" }),
    false,
    "PIN receipt session must equal the original target",
  );
  assert.equal(verifyCommandSuccess("pin.set", { commandId, receipt: { pinConfigured: true } }, commandId, { sessionId: "session-1" }), false);
  assert.equal(verifyCommandSuccess("pin.change", { commandId, receipt: { pinChanged: true, sessionId: "session-1" } }, commandId, { sessionId: "session-1" }), true);

  const backupReceipt = { generated: true, generation: 3, generationId: "bcgen_1", generatedAt: NOW, codeCount: 6 };
  assert.equal(
    verifyCommandSuccess("backup-codes.generate", { commandId, backupCodes: ["AAAAA-BBBBB"], receipt: { ...backupReceipt, codeCount: 1 } }, commandId),
    true,
  );
  assert.equal(verifyCommandSuccess("backup-codes.generate", { commandId, backupCodes: [], receipt: backupReceipt }, commandId), false);
  assert.equal(verifyCommandSuccess("backup-codes.generate", { commandId, receipt: backupReceipt }, commandId), false);
  assert.equal(verifyCommandSuccess("backup-codes.generate", { commandId, backupCodes: ["AAAAA-BBBBB"], receipt: { generated: true } }, commandId), false);
  assert.equal(
    verifyCommandSuccess("backup-codes.generate", { commandId, backupCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"], receipt: backupReceipt }, commandId),
    false,
    "codeCount must match the delivered array",
  );
});

test("5. read receipts are bound to key/action/target and consistent outer/body session", () => {
  const passwordRecord = { commandId: "idem_1", action: "password.change", targetKind: "credential" };
  const passwordBody = { passwordChanged: true, sessionsRotated: true, revokedSessionCount: 2, newSessionId: "session-2" };
  assert.deepEqual(
    validateOperationResult({ commandId: "idem_1", status: "completed", action: "password.change", targetKind: "credential", result: passwordBody }, passwordRecord),
    { ok: true },
  );
  assert.equal(validateOperationResult({ commandId: "other", status: "completed", action: "password.change", targetKind: "credential", result: passwordBody }, passwordRecord).ok, false);
  assert.equal(validateOperationResult({ commandId: "idem_1", status: "completed", action: "password.change", targetKind: "credential", result: {} }, passwordRecord).ok, false);
  assert.equal(
    validateOperationResult({ commandId: "idem_1", status: "completed", action: "password.change", targetKind: "credential", result: { passwordChanged: true } }, passwordRecord).ok,
    false,
    "partial completed body must fail",
  );
  assert.equal(validateOperationResult({ commandId: "idem_1", status: "mystery" }, passwordRecord).ok, false);
  assert.equal(validateOperationResult({ commandId: "idem_1", status: "rejected", action: "password.change", targetKind: "credential" }, passwordRecord).ok, false);

  const pinRecord = { commandId: "idem_2", action: "pin.change", targetKind: "session", targetSessionId: "session-1" };
  assert.deepEqual(
    validateOperationResult({ commandId: "idem_2", status: "completed", action: "pin.change", targetKind: "session", targetSessionId: "session-1", result: { pinChanged: true, sessionId: "session-1" } }, pinRecord),
    { ok: true },
  );
  assert.equal(
    validateOperationResult({ commandId: "idem_2", status: "completed", action: "pin.change", targetKind: "session", targetSessionId: "session-1", result: { pinChanged: true, sessionId: "other-session" } }, pinRecord).ok,
    false,
    "outer target and body sessionId must agree",
  );
  assert.equal(
    validateOperationResult({ commandId: "idem_2", status: "completed", action: "pin.change", targetKind: "session", targetSessionId: "another", result: { pinChanged: true, sessionId: "another" } }, pinRecord).ok,
    false,
  );
  assert.deepEqual(validateOperationResult({ commandId: "idem_2", status: "unconfirmed" }, pinRecord), { ok: true });
  assert.equal(
    validateOperationResult({ commandId: "idem_2", status: "completed", action: "pin.change", targetKind: "session", targetSessionId: "session-1", result: { pinChanged: true } }, pinRecord).ok,
    false,
    "missing body sessionId must fail",
  );
});

test("6. pending records: build, patch, visibility, unresolved gate fingerprint", () => {
  const built = buildPendingRecord({ adminUserId: "admin-1", action: "pin.change", commandId: "idem_2", sessionId: "session-1", now: NOW });
  assert.equal(built.targetKind, "session");
  assert.equal(built.targetSessionId, "session-1");
  assert.equal(built.dispatched, false);

  let records = upsertPendingRecord([], built);
  records = patchPendingRecord(records, "admin-1", "idem_2", { outcome: "unconfirmed", updatedAt: NOW });
  records = upsertPendingRecord(records, record({ commandId: "idem_3", dismissed: true }));
  assert.equal(records.length, 2);

  const delivered = record({ commandId: "idem_4", action: "backup-codes.generate", outcome: "completed", delivered: true });
  assert.equal(isUnresolvedRecord(delivered), false);
  assert.equal(isUnresolvedRecord(record({ commandId: "idem_5", outcome: "expired" })), true);
  assert.deepEqual(
    visiblePendingRecords([record({ commandId: "idem_6" }), records[1]], "admin-1").map((item) => item.commandId),
    ["idem_6"],
  );
  assert.deepEqual(dismissedPendingRecords([record({ commandId: "idem_7", dismissed: true })], "admin-1").map((item) => item.commandId), ["idem_7"]);

  const gate = unresolvedGate([record({ commandId: "idem_b" }), record({ commandId: "idem_a" })], "admin-1", "password.change");
  assert.ok(gate.notice.includes("尚未核清"));
  assert.equal(gate.fingerprint, "idem_a|idem_b", "fingerprint is bound to the exact unresolved set");
  assert.equal(unresolvedGate([], "admin-1", "password.change"), null);
  assert.equal(unresolvedGate([delivered], "admin-1", "backup-codes.generate"), null, "delivered codes are resolved");
  assert.equal(typeof backupCodesResultSubset({ generation: 3, generatedAt: NOW, codeCount: 10 })?.generation, "number");
  assert.equal(removePendingRecord(records, "admin-1", "idem_2").length, 1);
});

test("9. updating another command does not overwrite a concurrent completion", () => {
  const storage = fakeStorage();
  const first = createLocalPendingStore(storage), second = createLocalPendingStore(storage);
  const original = record({ commandId: "idem_existing" });
  assert.equal(first.update(() => [original]).ok, true);
  assert.equal(first.update((current) => {
    second.update((latest) => patchPendingRecord(latest, "admin-1", "idem_existing", { dismissed: true }));
    return upsertPendingRecord(current, record({ commandId: "idem_new" }));
  }).ok, true);
  assert.equal(first.read().records.find((item) => item.commandId === "idem_existing").dismissed, true);
});

test("7. per-record store: strict rows, no silent projection, no raw secret persistence", () => {
  const storage = fakeStorage();
  const store = createLocalPendingStore(storage);
  assert.deepEqual(store.read(), { records: [], error: false });

  const first = store.update((current) => upsertPendingRecord(current, record({ commandId: "idem_one" })));
  assert.equal(first.ok, true);
  assert.ok(storage.getItem(pendingRecordKey("admin-1", "idem_one")), "record is stored under its own key");

  // 未知顶层字段：读取失败；写回被拒绝且存储原文不被覆盖、不新增键
  storage._map.set(pendingRecordKey("admin-1", "idem_bad"), JSON.stringify({ ...record({ commandId: "idem_bad" }), password: "FIXTURE-NOT-REAL-SECRET" }));
  assert.deepEqual(store.read(), { records: [], error: true }, "unknown top-level field must fail the read");
  const beforeRefused = new Map(storage._map);
  const refused = store.update(() => [{ ...record({ commandId: "idem_secret" }), password: "FIXTURE-NOT-REAL-SECRET" }]);
  assert.equal(refused.ok, false, "unknown field must refuse the update");
  assert.deepEqual([...storage._map.entries()], [...beforeRefused.entries()], "refused update must not touch storage at all");
  assert.equal(storage.getItem(pendingRecordKey("admin-1", "idem_secret")), null, "no key may be written for the secret-bearing record");
  storage._map.delete(pendingRecordKey("admin-1", "idem_bad"));

  // action 与 targetKind 必须一致
  storage._map.set(pendingRecordKey("admin-1", "idem_mix"), JSON.stringify(record({ commandId: "idem_mix", action: "pin.set", targetKind: "credential" })));
  assert.equal(store.read().error, true, "action/targetKind mismatch must fail the read");
  storage._map.delete(pendingRecordKey("admin-1", "idem_mix"));

  // 键与内容不一致（篡改/复制）视为损坏
  storage._map.set(`${SECURITY_PENDING_KEY}:admin-1:tampered`, JSON.stringify(record({ commandId: "idem_one" })));
  assert.equal(store.read().error, true, "key/content mismatch must fail the read");
  storage._map.delete(`${SECURITY_PENDING_KEY}:admin-1:tampered`);

  // 损坏 JSON：读取失败、更新拒绝且原文保留
  const corruptKey = pendingRecordKey("admin-1", "idem_corrupt");
  storage._map.set(corruptKey, "{corrupt-old-pending-record");
  assert.deepEqual(store.read(), { records: [], error: true });
  assert.equal(store.update((current) => upsertPendingRecord(current, record({ commandId: "idem_new" }))).ok, false);
  assert.equal(storage.getItem(corruptKey), "{corrupt-old-pending-record");
  storage._map.delete(corruptKey);

  // mutate 返回 null 是"主动拒绝"，与存储失败区分
  const refusedByCaller = store.update(() => null);
  assert.equal(refusedByCaller.ok, false);
  assert.equal(refusedByCaller.reason, "refused");

  // 写失败：报告 storage，且旧记录保留
  const failing = {
    get length() {
      return storage.length;
    },
    key: storage.key.bind(storage),
    getItem: storage.getItem.bind(storage),
    setItem() {
      throw new Error("quota");
    },
    removeItem: storage.removeItem.bind(storage),
  };
  const failingStore = createLocalPendingStore(failing);
  const failedWrite = failingStore.update((current) => upsertPendingRecord(current, record({ commandId: "idem_fail" })));
  assert.equal(failedWrite.ok, false);
  assert.equal(failedWrite.reason, "storage");
  assert.equal(storage.getItem(pendingRecordKey("admin-1", "idem_one")) !== null, true, "existing record survives a failed write");

  assert.match(makeSecurityCommandId(), /^idem_[0-9a-f]+$/);
  assert.equal(normalizeIdleMinutes(30), 30);
  assert.equal(normalizeIdleMinutes(7), 15);
});

test("8. two store writers interleave without losing either record; same key keeps last valid write", () => {
  // 顺序交错：B 在 A 之后写不同记录
  const sequential = fakeStorage();
  const storeSeqA = createLocalPendingStore(sequential);
  const storeSeqB = createLocalPendingStore(sequential);
  const a = record({ commandId: "idem_writer_A" });
  const b = record({ commandId: "idem_writer_B" });
  assert.equal(storeSeqA.update((rows) => [...rows, a]).ok, true);
  assert.equal(storeSeqB.update((rows) => [...rows, b]).ok, true);
  assert.deepEqual(storeSeqB.read().records.map((item) => item.commandId).sort(), ["idem_writer_A", "idem_writer_B"]);

  // 确定性嵌套交错：A 写自己的键时触发 B 的完整读改写
  const nested = fakeStorage();
  const storeNestedA = createLocalPendingStore(nested);
  const storeNestedB = createLocalPendingStore(nested);
  const nestedA = record({ commandId: "idem_nested_A" });
  const nestedB = record({ commandId: "idem_nested_B" });
  const originalSet = nested.setItem.bind(nested);
  let innerResult = null;
  nested.setItem = (key, value) => {
    originalSet(key, value);
    if (key === pendingRecordKey(nestedA.adminUserId, nestedA.commandId) && innerResult === null) {
      innerResult = storeNestedB.update((rows) => [...rows, nestedB]);
    }
  };
  const outerResult = storeNestedA.update((rows) => [...rows, nestedA]);
  assert.equal(innerResult.ok, true);
  assert.equal(outerResult.ok, true);
  assert.deepEqual(storeNestedA.read().records.map((item) => item.commandId).sort(), ["idem_nested_A", "idem_nested_B"], "nested writer's record must survive");

  // 同一命令键的并发写：后写覆盖，仍是合法记录
  const sameKey = fakeStorage();
  const storeSameA = createLocalPendingStore(sameKey);
  const storeSameB = createLocalPendingStore(sameKey);
  const sameRecord = record({ commandId: "idem_same" });
  storeSameA.update((rows) => [...rows, sameRecord]);
  storeSameB.update((rows) => patchPendingRecord(rows, "admin-1", "idem_same", { dispatched: true, updatedAt: NOW }));
  const after = storeSameB.read();
  assert.equal(after.error, false);
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].dispatched, true);
});
