/**
 * ADM-APPROVAL-UI-2 · 「提交中暂存」责任记录（N5 补回）
 *
 * UI 改版删掉了旧 pending-writes 组件用例，但实现（views/approval/pending-writes.ts）
 * 一行没改，保护不能没有测试。这里直接针对真实实现与可失败的存储，覆盖旧用例的核心反例：
 * 存储写失败不发 POST、损坏记录不覆盖、从存储恢复、冷启动恢复、在途重复确认不换 key、
 * 卸载/迟到响应不能清掉或改写原责任。没有 mock 业务组件，也不放宽生产代码。
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { beforeEach, test } from "node:test";

import {
  dropPendingWrite, findPendingWrites, inspectPending, pendingWriteSubject,
  readPendingWrite, savePendingWrite, updatePendingWriteKind,
  APPROVAL_WRITE_PATHS,
} from "../src/views/approval/pending-writes.ts";

class FakeStorage {
  constructor() { this.map = new Map(); this.failSet = false; this.failGet = false; }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { if (this.failGet) throw new Error("storage read denied"); return this.map.get(key) ?? null; }
  setItem(key, value) { if (this.failSet) throw new Error("storage write denied"); this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

let storage;
beforeEach(() => { storage = new FakeStorage(); globalThis.sessionStorage = storage; });

const key = () => `idem_${randomBytes(16).toString("hex")}`;
let sequence = 0;
function binding(overrides = {}) {
  const id = `pw_${++sequence}`;
  const target = `approval_req_${id}`;
  const base = {
    actorId: `admin_${id}`, sessionId: `session_${id}`, target,
    operation: "approval.request.decide", path: "/security/approvals/requests/decision",
    idempotencyKey: key(), body: { requestId: target, decision: "APPROVE" },
    readback: { kind: "detail-and-lists", requestId: target, keys: [] },
    successMessage: "审批已提交", kind: "unknown",
  };
  return { ...base, ...overrides };
}
const subjectOf = (value) => pendingWriteSubject(value.actorId, value.sessionId, value.target, value.operation);
const prefix = "zzsh.admin.approval.pending-write.";
const storageKey = (subject) => `${prefix}${encodeURIComponent(subject)}`;

test("路径与操作码白名单仍覆盖新 UI 的四个写入口", () => {
  assert.equal(APPROVAL_WRITE_PATHS["/security/approvals/requests"], "approval.request.create");
  assert.equal(APPROVAL_WRITE_PATHS["/security/approvals/requests/decision"], "approval.request.decide");
  assert.equal(APPROVAL_WRITE_PATHS["/security/approvals/requests/withdraw"], "approval.request.withdraw");
  assert.equal(Object.keys(APPROVAL_WRITE_PATHS).length, 6);
});

test("存储写失败就不发 POST：落盘不成功时返回失败且不留下「以为记过了」的记录", () => {
  const value = binding();
  storage.failSet = true;
  assert.deepEqual(savePendingWrite(value), { ok: false, reason: "storage-unavailable" });
  assert.equal(storage.map.size, 0);
  assert.equal(inspectPending(subjectOf(value)).state, "absent", "调用方必须先拿到 ok=true 才能发起写请求");
});

test("损坏记录不覆盖：不可读的存储原样保留，并挡住新的提交与换 key", () => {
  const value = binding();
  const subject = subjectOf(value);
  storage.setItem(storageKey(subject), "{not-json");
  const before = storage.getItem(storageKey(subject));
  assert.deepEqual(inspectPending(subject), { state: "unreadable", reason: "corrupt" });
  assert.deepEqual(savePendingWrite(value), { ok: false, reason: "corrupt-record" });
  assert.equal(readPendingWrite(subject), null);
  assert.equal(dropPendingWrite(subject, value.idempotencyKey), false);
  assert.equal(storage.getItem(storageKey(subject)), before, "损坏记录绝不被覆盖或删除");
});

test("从存储恢复：内存里从没见过的记录仍按原 key 与原请求体恢复", async () => {
  const value = binding();
  const subject = subjectOf(value);
  const saved = savePendingWrite(value);
  assert.equal(saved.ok, true);
  const serialized = storage.getItem(storageKey(subject));
  // 用带 query 的动态导入模拟冷启动后的全新模块实例（内存缓存为空）。
  const fresh = await import("../src/views/approval/pending-writes.ts?cold-restore=1");
  const inspection = fresh.inspectPending(subject);
  assert.equal(inspection.state, "valid");
  assert.equal(inspection.record.idempotencyKey, value.idempotencyKey);
  assert.deepEqual(inspection.record.body, value.body);
  assert.equal(serialized.includes(value.idempotencyKey), true);
  assert.equal(fresh.savePendingWrite({ ...value, idempotencyKey: key() }).reason, "existing-unresolved");
});

test("冷启动恢复：findPendingWrites 只从存储枚举出当前身份的原责任，不靠进程内缓存", async () => {
  const value = binding();
  const saved = savePendingWrite(value);
  assert.equal(saved.ok, true);
  const fresh = await import("../src/views/approval/pending-writes.ts?cold-list=1");
  const found = fresh.findPendingWrites(value.actorId, value.sessionId, value.target);
  assert.equal(found.length, 1);
  assert.equal(found[0].idempotencyKey, value.idempotencyKey);
  assert.deepEqual(fresh.findPendingWrites("someone_else", value.sessionId, value.target), [], "身份分域不串号");
});

test("写在途时重复确认不会发第二笔：不同 key 被挡回并带回原记录，相同 key 可重放", () => {
  const value = binding();
  const subject = subjectOf(value);
  assert.equal(savePendingWrite(value).ok, true);
  const second = savePendingWrite({ ...value, idempotencyKey: key() });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "existing-unresolved");
  assert.equal(second.existing.idempotencyKey, value.idempotencyKey);
  assert.equal(JSON.parse(storage.getItem(storageKey(subject))).idempotencyKey, value.idempotencyKey, "存储里仍是原 key");
  const replay = savePendingWrite(value);
  assert.equal(replay.ok, true);
  assert.equal(replay.record.idempotencyKey, value.idempotencyKey, "同 key 重放不换键");
});

test("StrictMode / 卸载后的迟到响应不能改写或解除原责任", async () => {
  const value = binding();
  const subject = subjectOf(value);
  const saved = savePendingWrite(value);
  assert.equal(saved.ok, true);
  const fresh = await import("../src/views/approval/pending-writes.ts?cold-late=1");
  // 迟到的「另一个 key 已成功」不能解除当前责任。
  assert.equal(fresh.dropPendingWrite(subject, key()), false);
  assert.equal(fresh.readPendingWrite(subject).idempotencyKey, value.idempotencyKey);
  // 已受理后的降级只改 kind，不改 key / body，也不把责任改回「未提交」。
  const downgraded = fresh.updatePendingWriteKind(subject, value.idempotencyKey, "readback");
  assert.equal(downgraded.idempotencyKey, value.idempotencyKey);
  assert.deepEqual(downgraded.body, value.body);
  assert.equal(downgraded.kind, "readback");
  assert.equal(fresh.updatePendingWriteKind(subject, key(), "unknown"), null, "异 key 的迟到更新不能写入");
  assert.equal(fresh.dropPendingWrite(subject, value.idempotencyKey), true, "只有原 key 的终态证据能解除");
  assert.equal(fresh.inspectPending(subject).state, "absent");
});
