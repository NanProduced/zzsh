import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Window } from "happy-dom";
import {
  classifyWriteError,
  clearRecord,
  clearRecordIfMatch,
  isUploadRecord,
  loadRecord,
  newIdempotencyKey,
  PersistBlockedError,
  readOperationResult,
  recoveryQuery,
  requestFingerprint,
  sameRecord,
  saveRecord,
  storageKey,
  uploadBytesFingerprint,
  uploadIntentFingerprint,
  validateStored,
  verifyRecordIntegrity,
} from "../src/views/supply-media/write-intent.ts";
// Node strip-types 无法解析 api.ts 的参数属性构造；用同形状对象模拟 API 错误。
const apiError = (status, code = "ERR") => Object.assign(new Error(code), { name: "AdminApiError", status, code });

const ADMIN = "admin_1";

function withStorage(t) {
  const browser = new Window({ url: "http://127.0.0.1:4291/supply/media" });
  Object.assign(globalThis, { window: browser, localStorage: browser.localStorage });
  t.after(() => browser.happyDOM.abort());
  return browser;
}

function simpleRecord(over = {}) {
  const body = { decision: "REJECT", reason: "图片模糊", visibility: "PRIVATE_REVIEW" };
  return {
    v: 1,
    kind: "review",
    adminId: ADMIN,
    sessionId: "sess_1",
    operation: "supply.media.review",
    targetId: "asset_1",
    targetLabel: "游戏封面 asset_1",
    gameId: "game_1",
    body,
    key: "idem_0123456789abcdef",
    fingerprint: createHash("sha256").update(JSON.stringify(["supply.media.review", "asset_1", body])).digest("hex"),
    phase: "unknown",
    recoverable: true,
    createdAt: "2026-10-13T02:00:00.000Z",
    ...over,
  };
}

function uploadRecord(over = {}) {
  const meta = { gameId: "game_1", purpose: "GAME_COVER", mime: "image/png", size: 1024 };
  return {
    v: 1,
    kind: "upload",
    adminId: ADMIN,
    sessionId: "sess_1",
    targetLabel: "游戏封面 a.png",
    gameId: "game_1",
    purpose: "GAME_COVER",
    file: { name: "a.png", size: 1024, mime: "image/png" },
    intent: { key: "idem_aaaaaaaaaaaaaaaa", fingerprint: createHash("sha256").update(JSON.stringify(["supply.media.upload_intent.create", null, meta])).digest("hex"), status: "accepted", intentId: "upload_1" },
    bytes: { key: "idem_bbbbbbbbbbbbbbbb", fingerprint: "b".repeat(64), status: "unknown" },
    phase: "unknown",
    recoverable: true,
    createdAt: "2026-10-13T02:00:00.000Z",
    ...over,
  };
}

test("指纹与服务端 fingerprintRequest 同构：sha256(JSON.stringify([op, rid, body]))", async () => {
  const expected = (op, rid, body) => createHash("sha256").update(JSON.stringify([op, rid ?? null, body ?? null])).digest("hex");
  assert.equal(await requestFingerprint("supply.media.review", "asset_1", { decision: "APPROVE" }), expected("supply.media.review", "asset_1", { decision: "APPROVE" }));
  assert.equal(await requestFingerprint("supply.media.upload_intent.create", undefined, { gameId: "g", purpose: "GAME_COVER", mime: "image/png", size: 10 }), expected("supply.media.upload_intent.create", undefined, { gameId: "g", purpose: "GAME_COVER", mime: "image/png", size: 10 }));
  // 键序敏感：与请求体同序构造才能与服务端一致。
  assert.notEqual(await requestFingerprint("op", "r", { a: 1, b: 2 }), await requestFingerprint("op", "r", { b: 2, a: 1 }));
});

test("字节上传指纹复刻 runMediaUpload 的双层哈希；只存指纹不落 token", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const b64 = Buffer.from(bytes).toString("base64");
  const contentHash = createHash("sha256").update(JSON.stringify(["bytes", "upload_1", b64])).digest("hex");
  const expected = createHash("sha256").update(JSON.stringify(["supply.media.upload", "upload_1", { intentId: "upload_1", token: "tok", contentHash }])).digest("hex");
  assert.equal(await uploadBytesFingerprint("upload_1", "tok", bytes), expected);

  const intentFp = await uploadIntentFingerprint({ gameId: "g", purpose: "GAME_COVER", mime: "image/png", size: 3 });
  assert.match(intentFp, /^[0-9a-f]{64}$/);
});

test("记录结构校验：损坏/他人/缺字段都不能直接删除后重提", () => {
  assert.deepEqual(validateStored(null, ADMIN), { ok: false, reason: "missing" });
  assert.equal(validateStored("{", ADMIN).reason, "corrupt", "非法 JSON 按 corrupt 处理");
  assert.equal(validateStored({ v: 2, kind: "review" }, ADMIN).reason, "corrupt");
  assert.equal(validateStored({ v: 1, kind: "unknown-kind" }, ADMIN).reason, "corrupt");
  assert.equal(validateStored(simpleRecord({ key: "bad key!" }), ADMIN).reason, "corrupt", "幂等键格式非法");
  assert.equal(validateStored(simpleRecord({ fingerprint: "zz" }), ADMIN).reason, "corrupt", "指纹非法");
  assert.equal(validateStored(simpleRecord({ phase: "weird" }), ADMIN).reason, "corrupt");
  assert.equal(validateStored(simpleRecord({ body: "not-object" }), ADMIN).reason, "corrupt");
  assert.equal(validateStored(simpleRecord({ adminId: "other" }), ADMIN).reason, "foreign");
  assert.equal(validateStored(uploadRecord({ intent: { key: "x", fingerprint: "a".repeat(64), status: "accepted", intentId: "i" } }), ADMIN).reason, "corrupt", "upload 子键格式非法");
  assert.equal(validateStored(uploadRecord({ bytes: { key: "idem_bbbbbbbbbbbbbbbb", fingerprint: "nope", status: "unknown" } }), ADMIN).reason, "corrupt");
  assert.equal(validateStored(uploadRecord(), ADMIN).ok, true);
  assert.equal(validateStored(simpleRecord(), ADMIN).ok, true);
});

test("持久化：保存失败阻止提交；读取校验结构；清除后缺失", (t) => {
  withStorage(t);
  const record = simpleRecord();
  saveRecord(record);
  assert.equal(loadRecord(ADMIN).ok, true);
  assert.deepEqual(loadRecord(ADMIN).record, record);
  assert.equal(loadRecord("other_admin").reason, "missing", "他人身份读不到该记录");
  clearRecord(ADMIN);
  assert.equal(loadRecord(ADMIN).reason, "missing");
  window.localStorage.setItem(storageKey(ADMIN), "{corrupt");
  assert.equal(loadRecord(ADMIN).reason, "corrupt", "损坏记录保留为 corrupt，不静默删除");
  // 保存失败（序列化/存储异常）必须抛 PersistBlockedError，调用方阻止提交。
  const circular = simpleRecord();
  circular.body.self = circular.body;
  assert.throws(() => saveRecord(circular), (e) => e instanceof PersistBlockedError);
  assert.throws(() => saveRecord({ ...simpleRecord(), body: { get boom() { throw new Error("x"); } } }), (e) => e instanceof PersistBlockedError);
});

test("稳定幂等键：格式合法、调用唯一、同 key 重试不变", () => {
  const key = newIdempotencyKey();
  assert.match(key, /^idem_[A-Za-z0-9_-]{8,64}$/);
  assert.notEqual(key, newIdempotencyKey());
});

test("错误分类：网络/5xx/不确定 4xx=UNKNOWN；明确拒绝≠未执行", () => {
  assert.equal(classifyWriteError(apiError(0, "NETWORK_ERROR"), false), "unknown");
  assert.equal(classifyWriteError(apiError(503, "INTERNAL_ERROR"), false), "unknown");
  assert.equal(classifyWriteError(new Error("plain"), false), "unknown", "非 API 异常按未知处理");
  assert.equal(classifyWriteError(apiError(400, "INVALID_ARGUMENT"), false), "rejected");
  assert.equal(classifyWriteError(apiError(409, "CONFLICT"), false), "rejected");
  assert.equal(classifyWriteError(apiError(403, "FORBIDDEN"), false), "rejected", "首次403是明确拒绝");
  assert.equal(classifyWriteError(apiError(403, "FORBIDDEN"), true), "unknown", "已受理线索后的403按未知");
  assert.equal(classifyWriteError(apiError(423, "LOCKED"), true), "unknown");
});

test("恢复查询：仅平台四操作可读原结果；用户素材/封面返回 null", () => {
  const rec = simpleRecord();
  assert.deepEqual(recoveryQuery(rec), { operation: "supply.media.review", resourceId: "asset_1", fingerprint: rec.fingerprint, key: "idem_0123456789abcdef" });
  const vis = simpleRecord({ kind: "visibility", operation: "supply.media.visibility" });
  assert.deepEqual(
    recoveryQuery(vis),
    { operation: "supply.media.visibility", resourceId: "asset_1", fingerprint: vis.fingerprint, key: "idem_0123456789abcdef" },
  );
  assert.equal(recoveryQuery(simpleRecord({ recoverable: false, recoverNote: "x" })), null);
  assert.equal(recoveryQuery(simpleRecord({ kind: "cover", operation: "supply.game.cover", recoverable: false })), null, "封面绑定不在白名单");
});

test("恢复读取：RECORDED/UNRESOLVED/404 三种语义互不替代", async (t) => {
  withStorage(t);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), key: new Headers(init.headers).get("idempotency-key") });
    return {
      ok: true,
      status: 200,
      json: async () => ({ receipt: "RECORDED", responseStatus: 200, result: { reviewState: "APPROVED" } }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const target = { operation: "supply.media.review", resourceId: "asset_1", fingerprint: "f".repeat(64), key: "idem_0123456789abcdef" };
  const recorded = await readOperationResult(target);
  assert.equal(recorded.receipt, "RECORDED");
  assert.equal(recorded.result.reviewState, "APPROVED");
  assert.ok(calls[0].url.includes("operation=supply.media.review"));
  assert.ok(calls[0].url.includes(`resourceId=asset_1`));
  assert.equal(calls[0].key, "idem_0123456789abcdef", "恢复读取带原幂等键");

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ receipt: "UNRESOLVED" }) });
  const unresolved = await readOperationResult(target);
  assert.equal(unresolved.receipt, "UNRESOLVED", "UNRESOLVED 不等于未执行，只是查不到原记录");

  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { code: "NOT_FOUND" } }) });
  const unsupported = await readOperationResult(target);
  assert.equal(unsupported.receipt, "UNSUPPORTED");
  assert.ok(unsupported.note.includes("不能视为未执行"));

  globalThis.fetch = async () => { throw new Error("network"); };
  await assert.rejects(() => readOperationResult(target), (e) => e.name === "WriteNetworkError" && e.status === 0);
});

test("上传记录识别与阶段文案", () => {
  assert.equal(isUploadRecord(uploadRecord()), true);
  assert.equal(isUploadRecord(simpleRecord()), false);
  const r = uploadRecord();
  assert.equal(validateStored(r, ADMIN).ok, true);
});

test("反例M-F2/清理守卫：原体篡改可检出；清理只删匹配的原记录", async (t) => {
  withStorage(t);
  // 原体篡改：body 改动但指纹仍是原值 → verifyRecordIntegrity 报 tampered。
  const clean = simpleRecord({ phase: "unknown" });
  const tampered = simpleRecord({ phase: "unknown", body: { decision: "APPROVE", visibility: "PRIVATE_REVIEW" } });
  assert.equal(await verifyRecordIntegrity(clean), "ok");
  assert.equal(await verifyRecordIntegrity(tampered), "tampered", "body 变更必须被摘要检出");
  // 上传意图指纹同理。
  const upClean = uploadRecord();
  const upTampered = uploadRecord({ file: { name: "a.png", size: 2048, mime: "image/png" } });
  assert.equal(await verifyRecordIntegrity(upClean), "ok");
  assert.equal(await verifyRecordIntegrity(upTampered), "tampered", "指纹内字段（size）变更必须被检出");

  // 清理守卫：键/时间戳不匹配（另一窗口的新请求）不删除；匹配才删（M-F4）。
  saveRecord(clean);
  assert.equal(clearRecordIfMatch(ADMIN, uploadRecord()), false, "不同命令不能清槽");
  assert.equal(loadRecord(ADMIN).ok, true, "记录仍在");
  assert.equal(clearRecordIfMatch(ADMIN, { ...clean, key: "idem_otherkey123" }), false, "不同 key 不能清槽");
  assert.equal(loadRecord(ADMIN).ok, true);
  assert.equal(clearRecordIfMatch(ADMIN, clean), true, "匹配的原命令可清理");
  assert.equal(loadRecord(ADMIN).reason, "missing");
});

test("反例M-F3分类：UNKNOWN 原请求的重放 401/403/404/423 仍是未知，不改写成原业务拒绝", () => {
  // 重放（wasUnknown=true）遇权限/会话拒绝：保留待核。
  for (const status of [401, 403, 404, 423]) {
    assert.equal(classifyWriteError(apiError(status), true), "unknown", `重放 ${status} 不得当作原命令被拒`);
  }
  // 首次发送的 403 是明确拒绝。
  assert.equal(classifyWriteError(apiError(403), false), "rejected");
});

test("R2上传阶段：初始idle、意图等待、字节等待及受理待读回均是合法记录", async () => {
  const base = uploadRecord();
  const idleBytes = { ...base.bytes, fingerprint: null, status: "idle" };
  const legal = [
    uploadRecord({ intent: { ...base.intent, fingerprint: null, status: "idle", intentId: null }, bytes: idleBytes, phase: "idle" }),
    uploadRecord({ intent: { ...base.intent, status: "sending", intentId: null }, bytes: idleBytes, phase: "sending" }),
    uploadRecord({ intent: { ...base.intent, status: "unknown", intentId: null }, bytes: idleBytes, phase: "unknown" }),
    uploadRecord({ bytes: idleBytes, phase: "idle" }),
    uploadRecord({ bytes: idleBytes, phase: "sending" }),
    uploadRecord({ bytes: { ...base.bytes, status: "sending" }, phase: "sending" }),
    base,
    uploadRecord({ bytes: { ...base.bytes, status: "accepted" }, resultAssetId: "asset_1", phase: "accepted_readback" }),
  ];
  for (const record of legal) {
    assert.equal(validateStored(record, ADMIN).ok, true, JSON.stringify([record.intent.status, record.bytes.status, record.phase]));
    assert.equal(await verifyRecordIntegrity(record), "ok");
  }
});

test("R2上传损坏：阶段矛盾、缺ID/摘要、非法声明与缺身份字段都fail closed", async () => {
  const base = uploadRecord();
  const corrupt = [
    ["accepted字节没有摘要却伪造完成", { bytes: { ...base.bytes, fingerprint: null, status: "accepted" }, resultAssetId: "asset_never_uploaded", phase: "accepted_readback" }],
    ["sending意图没有摘要", { intent: { ...base.intent, fingerprint: null, status: "sending", intentId: null }, bytes: { ...base.bytes, fingerprint: null, status: "idle" }, phase: "sending" }],
    ["unknown意图没有摘要", { intent: { ...base.intent, fingerprint: null, status: "unknown", intentId: null }, bytes: { ...base.bytes, fingerprint: null, status: "idle" } }],
    ["accepted意图没有ID", { intent: { ...base.intent, intentId: null } }],
    ["accepted意图ID为空", { intent: { ...base.intent, intentId: "" } }],
    ["非法意图ID", { intent: { ...base.intent, intentId: "../../other" } }],
    ["意图未确认就发字节", { intent: { ...base.intent, status: "unknown", intentId: null } }],
    ["unknown字节没有摘要", { bytes: { ...base.bytes, fingerprint: null } }],
    ["accepted字节没有assetId", { bytes: { ...base.bytes, status: "accepted" }, phase: "accepted_readback" }],
    ["accepted字节非法assetId", { bytes: { ...base.bytes, status: "accepted" }, resultAssetId: "bad/id", phase: "accepted_readback" }],
    ["accepted字节却整体unknown", { bytes: { ...base.bytes, status: "accepted" }, resultAssetId: "asset_1" }],
    ["未确认字节却待读回", { phase: "accepted_readback", resultAssetId: "asset_1" }],
    ["size=0", { file: { ...base.file, size: 0 } }],
    ["size<0", { file: { ...base.file, size: -1 } }],
    ["size不是整数", { file: { ...base.file, size: 0.5 } }],
    ["size=NaN", { file: { ...base.file, size: Number.NaN } }],
    ["size无限大", { file: { ...base.file, size: Number.POSITIVE_INFINITY } }],
    ["超10MiB", { file: { ...base.file, size: 10 * 1024 * 1024 + 1 } }],
    ["声明SVG", { file: { ...base.file, mime: "image/svg+xml" } }],
    ["空文件名", { file: { ...base.file, name: "" } }],
    ["用户凭证不能伪装本页上传", { purpose: "ACCOUNT_EVIDENCE" }],
    ["空管理员ID", { adminId: "" }],
    ["缺会话ID", { sessionId: undefined }],
    ["非法游戏ID", { gameId: "bad/game" }],
    ["缺对象文案", { targetLabel: undefined }],
    ["缺建立时间", { createdAt: undefined }],
    ["非法建立时间", { createdAt: "not-a-date" }],
    ["恢复标记错误", { recoverable: false }],
  ];
  for (const [label, over] of corrupt) {
    const record = uploadRecord(over);
    assert.equal(validateStored(record, ADMIN).reason, "corrupt", label);
    assert.equal(await verifyRecordIntegrity(record), "tampered", label);
  }
  assert.equal(validateStored({ v: 1, get kind() { throw new Error("damaged field"); } }, ADMIN).reason, "corrupt", "损坏字段读取不抛出界面");
});

test("R2简单命令匹配：核身份/操作/目标/原体摘要，允许phase和显示时间变化", (t) => {
  withStorage(t);
  const original = simpleRecord();
  const advanced = { ...original, phase: "accepted_readback", createdAt: "2026-10-13T03:00:00.000Z" };
  assert.equal(sameRecord(original, advanced), true, "受理后改变phase/时间仍是原命令");
  const changed = [
    { adminId: "admin_2" },
    { sessionId: "sess_2" },
    { targetId: "asset_2" },
    { gameId: "game_2" },
    { kind: "visibility", operation: "supply.media.visibility" },
    { key: "idem_anotherkey123" },
    { fingerprint: "f".repeat(64) },
    { body: { decision: "APPROVE", visibility: "PRIVATE_REVIEW" } },
  ];
  for (const over of changed) {
    const other = { ...original, ...over };
    window.localStorage.setItem(storageKey(ADMIN), JSON.stringify(other));
    assert.equal(sameRecord(original, other), false, JSON.stringify(over));
    assert.equal(clearRecordIfMatch(ADMIN, original), false, "不一致记录不能被旧回调清除");
    assert.ok(window.localStorage.getItem(storageKey(ADMIN)));
  }
  saveRecord(advanced);
  assert.equal(clearRecordIfMatch(ADMIN, original), true, "合法受理阶段可匹配清理");
});

test("R2上传命令匹配：核双key/双摘要/意图关联，合法阶段前进不丢原命令", (t) => {
  withStorage(t);
  const original = uploadRecord();
  const accepted = uploadRecord({ bytes: { ...original.bytes, status: "accepted" }, resultAssetId: "asset_1", phase: "accepted_readback", createdAt: "2026-10-13T03:00:00.000Z" });
  assert.equal(sameRecord(original, accepted), true, "字节unknown→accepted保持原双key/摘要/intentId");
  const changed = [
    { adminId: "admin_2" },
    { sessionId: "sess_2" },
    { gameId: "game_2" },
    { purpose: "SKIN_MEDIA" },
    { file: { ...original.file, name: "other.png" } },
    { intent: { ...original.intent, key: "idem_anotherintent123" } },
    { intent: { ...original.intent, fingerprint: "f".repeat(64) } },
    { intent: { ...original.intent, intentId: "upload_2" } },
    { bytes: { ...original.bytes, key: "idem_anotherbytes123" } },
    { bytes: { ...original.bytes, fingerprint: "f".repeat(64) } },
  ];
  for (const over of changed) {
    const other = uploadRecord(over);
    window.localStorage.setItem(storageKey(ADMIN), JSON.stringify(other));
    assert.equal(sameRecord(original, other), false, JSON.stringify(over));
    assert.equal(clearRecordIfMatch(ADMIN, original), false);
    assert.ok(window.localStorage.getItem(storageKey(ADMIN)));
  }
  assert.equal(sameRecord(accepted, { ...accepted, resultAssetId: "asset_2" }), false, "两条已知素材回执ID不同不可混同");
  saveRecord(accepted);
  assert.equal(clearRecordIfMatch(ADMIN, original), true, "原字节命令可清理其受理阶段");
});

test("R2清理失败：存储拒绝删除时不返回假成功", () => {
  const originalWindow = globalThis.window;
  const record = simpleRecord();
  globalThis.window = { localStorage: { getItem: () => JSON.stringify(record), removeItem: () => { throw new Error("storage denied"); } } };
  try {
    assert.equal(clearRecordIfMatch(ADMIN, record), false);
  } finally {
    globalThis.window = originalWindow;
  }
});
