import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionsFor,
  objectName,
  queueParams,
  reviewReasonError,
  shortAssetId,
  sizeText,
  timeFull,
  timeShort,
  validateImageFile,
  visibilityReasonError,
  VISIBILITY_LABELS,
  MAX_MEDIA_BYTES,
} from "../src/views/supply-media/model.ts";

const platform = (over = {}) => ({
  id: "asset_platform_1",
  accountId: null,
  gameId: "game_1",
  purpose: "GAME_COVER",
  ownershipKind: "PLATFORM_CATALOG",
  ownerUserId: null,
  uploadedByRealm: "admin",
  uploadedByUserId: null,
  uploadedByAdminId: "admin_1",
  contentHash: "a".repeat(64),
  mime: "image/png",
  byteSize: "12345",
  width: 1920,
  height: 1080,
  accessClass: "PRIVATE_REVIEW",
  reviewState: "PENDING",
  reviewReason: null,
  createdAt: "2026-10-13T02:00:00.000000Z",
  ...over,
});

const evidence = (over = {}) =>
  platform({ id: "asset_evidence_1", accountId: "account_1", purpose: "ACCOUNT_EVIDENCE", ownershipKind: "USER_SUPPLY", uploadedByRealm: "user", uploadedByUserId: "user_1", uploadedByAdminId: null, ...over });

const display = (over = {}) =>
  platform({ id: "asset_display_1", accountId: "account_1", purpose: "ACCOUNT_DISPLAY", ownershipKind: "USER_SUPPLY", uploadedByRealm: "user", uploadedByUserId: "user_1", uploadedByAdminId: null, ...over });

const ctx = { canDecide: true, canUpload: true };
const kinds = (set) => set.actions.map((a) => (a.kind === "review" ? `review:${a.decision}` : a.kind === "visibility" ? `visibility:${a.visibility}` : "cover"));

test("平台目录素材四态动作：重审必填理由、公开与审核分开、封面仅 GAME_COVER+公开", () => {
  const pending = actionsFor(platform(), ctx);
  assert.deepEqual(kinds(pending), ["review:APPROVE", "review:REJECT", "review:QUARANTINE"]);
  assert.equal(pending.actions.find((a) => a.kind === "review" && a.decision === "APPROVE").reasonRequired, false);

  const approvedPrivate = actionsFor(platform({ reviewState: "APPROVED", accessClass: "PRIVATE_REVIEW" }), ctx);
  assert.deepEqual(kinds(approvedPrivate), ["review:REJECT", "review:QUARANTINE", "visibility:PUBLIC_DISPLAY"]);

  const approvedPublic = actionsFor(platform({ reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY" }), ctx);
  assert.deepEqual(kinds(approvedPublic), ["review:REJECT", "review:QUARANTINE", "visibility:PRIVATE_REVIEW", "cover"]);

  const rejected = actionsFor(platform({ reviewState: "REJECTED" }), ctx);
  assert.equal(rejected.actions.find((a) => a.kind === "review" && a.decision === "APPROVE").reasonRequired, true, "REJECTED 重新通过必须理由");

  const quarantined = actionsFor(platform({ reviewState: "QUARANTINED" }), ctx);
  assert.equal(quarantined.actions.find((a) => a.kind === "review" && a.decision === "APPROVE").reasonRequired, true);

  const cover = actionsFor(platform({ purpose: "SKIN_MEDIA", reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY" }), ctx);
  assert.ok(!kinds(cover).includes("cover"), "非 GAME_COVER 不提供设封面");
});

test("用户凭证：只审不公开；通过=保持私有，通过不等于账号可接单", () => {
  const set = actionsFor(evidence(), ctx);
  assert.deepEqual(kinds(set), ["review:APPROVE", "review:REJECT", "review:QUARANTINE"]);
  assert.ok(!kinds(set).some((k) => k.startsWith("visibility")), "私有凭证不提供公开选项");
  assert.ok(set.actions.find((a) => a.kind === "review" && a.decision === "APPROVE").effect.includes("不等于账号可接单"));

  const approved = actionsFor(evidence({ reviewState: "APPROVED" }), ctx);
  assert.deepEqual(kinds(approved), ["review:REJECT", "review:QUARANTINE"]);
});

test("ACCOUNT_DISPLAY 只跳来源账号，不做任何处置；缺 accountId 也保持只读", () => {
  const set = actionsFor(display(), ctx);
  assert.equal(set.actions.length, 0);
  assert.equal(set.accountDisplayOnly, true);
  assert.ok(set.note.includes("免发布前预审"));

  const noAccount = actionsFor(display({ accountId: null }), ctx);
  assert.equal(noAccount.actions.length, 0);
  assert.equal(noAccount.accountDisplayOnly, true);
});

test("未知用途/未知归属/不合法组合 fail closed，不用宽泛 else 归入可审或可公开", () => {
  const unknownPurpose = actionsFor(platform({ purpose: "CONTENT_MEDIA" }), ctx);
  assert.equal(unknownPurpose.actions.length, 0);
  assert.ok(unknownPurpose.note);

  const unknownOwnership = actionsFor(platform({ ownershipKind: "PLATFORM_CONTENT" }), ctx);
  assert.equal(unknownOwnership.actions.length, 0);
  assert.ok(unknownOwnership.note);

  const mismatch = actionsFor(platform({ purpose: "ACCOUNT_EVIDENCE", ownershipKind: "PLATFORM_CATALOG" }), ctx);
  assert.equal(mismatch.actions.length, 0, "归属与用途组合异常必须只读");
  assert.ok(mismatch.note);

  const mismatch2 = actionsFor(evidence({ ownershipKind: "PLATFORM_CATALOG", purpose: "ACCOUNT_DISPLAY" }), ctx);
  assert.equal(mismatch2.actions.length, 0);

  const unknownState = actionsFor(platform({ reviewState: "UNKNOWN_STATE" }), ctx);
  assert.equal(unknownState.actions.length, 0);
});

test("无决定权：不出审核动作但封面归目录权限；无上传权：不出设封面", () => {
  // 封面绑定只要求 supply.catalog.manage（服务端 supply-routes:1222），不属于审核决定。
  const readOnly = actionsFor(platform({ reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY" }), { canDecide: false, canUpload: true });
  assert.ok(!kinds(readOnly).some((k) => k.startsWith("review") || k.startsWith("visibility")), "无 decide 不出审核/可见性动作");
  assert.ok(kinds(readOnly).includes("cover"), "目录维护者无需审核决定权即可设封面");
  assert.ok(readOnly.note.includes("不能决定审核"));

  const noUpload = actionsFor(platform({ reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY" }), { canDecide: true, canUpload: false });
  assert.ok(!kinds(noUpload).includes("cover"), "无 catalog.manage 不出设封面");
  assert.ok(kinds(noUpload).includes("visibility:PRIVATE_REVIEW"), "审核决定权仍可管可见性");
});

test("理由约束镜像服务端：驳回/隔离/重审必填 2–500，通过 PENDING 可空", () => {
  assert.equal(reviewReasonError(platform(), "APPROVE", ""), null);
  assert.ok(reviewReasonError(platform(), "REJECT", "")?.includes("必填"));
  assert.ok(reviewReasonError(platform(), "REJECT", " ")?.includes("必填"));
  assert.equal(reviewReasonError(platform(), "REJECT", "图片模糊"), null);
  assert.ok(reviewReasonError(platform(), "QUARANTINE", "x")?.includes("必填"), "单字不足 2 字");
  assert.ok(reviewReasonError(platform(), "REJECT", "a".repeat(501))?.includes("500"));
  assert.ok(reviewReasonError(platform({ reviewState: "REJECTED" }), "APPROVE", "")?.includes("必填"), "重新通过必填理由");
  assert.equal(visibilityReasonError(""), null);
  assert.ok(visibilityReasonError("x")?.includes("2–500"));
  assert.equal(visibilityReasonError("撤销原因说明"), null);
});

test("查询映射只产生真实单状态查询，不造 ALL/未登记枚举", () => {
  assert.deepEqual(queueParams({ state: "PENDING", ownershipKind: "PLATFORM_CATALOG" }), { state: "PENDING", ownershipKind: "PLATFORM_CATALOG", limit: 20 });
  assert.deepEqual(queueParams({ state: "QUARANTINED", ownershipKind: "USER_SUPPLY", cursor: "c1", limit: 5 }), { state: "QUARANTINED", ownershipKind: "USER_SUPPLY", limit: 5, cursor: "c1" });
  assert.throws(() => queueParams({ state: "ALL", ownershipKind: "PLATFORM_CATALOG" }), /unknown state/);
});

test("列表对象名：游戏名可用、账号显示来源、缺字段显示真实缺失态", () => {
  const names = new Map([["game_1", "三角洲行动"]]);
  assert.equal(objectName(platform(), names), "三角洲行动");
  assert.equal(objectName(platform({ gameId: "game_x" }), names), "游戏名未提供");
  assert.equal(objectName(display(), names), "账号 account_1");
  assert.equal(objectName(display({ accountId: null }), names), "来源账号未提供");
  assert.equal(objectName(platform({ purpose: "SKIN_MEDIA" }), names), "对象名未提供");
});

test("时间：北京时间短格式同年省略年份，完整格式带时区标注；未知不填今天", () => {
  const now = new Date("2026-10-13T04:00:00Z");
  assert.equal(timeShort("2026-10-13T02:00:00.000000Z", now), "10-13 10:00");
  assert.ok(timeShort("2025-06-01T02:00:00.000000Z", now).startsWith("2025-06-01"));
  assert.equal(timeFull("2026-10-13T02:00:00.000000Z"), "2026-10-13 10:00:00 北京时间");
  assert.equal(timeShort(null, now), "时间未提供");
  assert.equal(timeShort("not-a-date", now), "时间未知");
  assert.ok(!timeShort(null, now).includes("10-13"), "未知时间不能填今天");
});

test("上传本地校验：类型与大小边界；png 通过不代表全部类型可用", () => {
  assert.equal(validateImageFile({ name: "a.png", size: 10, type: "image/png" }), null);
  assert.equal(validateImageFile({ name: "a.webp", size: 10, type: "image/webp" }), null);
  assert.ok(validateImageFile({ name: "a.gif", size: 10, type: "image/gif" })?.includes("JPEG/PNG/WebP"));
  assert.ok(validateImageFile({ name: "a.png", size: 0, type: "image/png" })?.includes("为空"));
  assert.ok(validateImageFile({ name: "a.png", size: MAX_MEDIA_BYTES + 1, type: "image/png" })?.includes("10 MiB"));
  assert.equal(validateImageFile({ name: "a.png", size: MAX_MEDIA_BYTES, type: "image/png" }), null);
});

test("公开素材的审核决定必须告知解除绑定影响（F9）；可见性措辞是配置不是可读证明（F12）", () => {
  const pub = platform({ reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY" });
  const rejectOnPublic = actionsFor(pub, ctx).actions.find((a) => a.kind === "review" && a.decision === "REJECT");
  assert.ok(rejectOnPublic.effect.includes("解除目录绑定"), "驳回公开素材要说明解绑影响");
  assert.ok(rejectOnPublic.effect.includes("数量未提供"), "不编造绑定数量");
  const quarantineOnPublic = actionsFor(pub, ctx).actions.find((a) => a.kind === "review" && a.decision === "QUARANTINE");
  assert.ok(quarantineOnPublic.effect.includes("撤销公开访问"));
  const rejectOnPrivate = actionsFor(platform({ reviewState: "APPROVED" }), ctx).actions.find((a) => a.kind === "review" && a.decision === "REJECT");
  assert.ok(!rejectOnPrivate.effect.includes("解除目录绑定"), "私有素材不虚构解绑影响");
  assert.equal(VISIBILITY_LABELS.PUBLIC_DISPLAY, "公开配置");
});

test("显示工具：大小与短 ID", () => {
  assert.equal(sizeText(512), "512 B");
  assert.equal(sizeText(2 * 1024 * 1024), "2.0 MiB");
  assert.equal(shortAssetId("asset_demo_01"), "asset_de…o_01");
  assert.equal(shortAssetId("short"), "short");
});

/* ---------- API B：技术/绑定/修订四轴只报服务端投影 ---------- */
import { technicalFact, bindingFact, revisionFact } from '../src/views/supply-media/model.ts';

const assetOf = (over = {}) => ({ id: 'm-1', gameId: 'g-1', purpose: 'ACCOUNT_DISPLAY', ownershipKind: 'USER_SUPPLY', ownerUserId: null, uploadedByRealm: 'user', uploadedByUserId: 'u-1', uploadedByAdminId: null, contentHash: 'a'.repeat(64), mime: 'image/png', byteSize: '10', width: 1, height: 1, accessClass: 'PRIVATE_REVIEW', reviewState: 'PENDING', reviewReason: null, createdAt: '2026-10-03T00:00:00.000Z', ...over });

test('technical axis reports the stored state and never infers it from loading or publicity', () => {
  assert.equal(technicalFact(assetOf()), '技术状态未提供', 'an older queue response stays unprovided');
  assert.equal(technicalFact(assetOf({ technicalState: 'UNKNOWN' })), '尚未完成技术检查');
  assert.equal(technicalFact(assetOf({ technicalState: 'READY', accessClass: 'PUBLIC_DISPLAY' })), '技术处理就绪');
  assert.match(technicalFact(assetOf({ technicalState: 'FAILED', technicalCheckedAt: '2026-10-03T00:00:00.000Z' })), /^技术处理失败 · 检查于 /);
  assert.equal(technicalFact(assetOf({ technicalState: 'PENDING_TECH' })), '技术状态未识别（PENDING_TECH）');
});

test('binding axis separates current references from historical version references', () => {
  assert.equal(bindingFact(assetOf()), '对象绑定未提供');
  assert.equal(bindingFact(assetOf({ binding: { state: 'UNAVAILABLE', current: {}, historical: {} } })), '绑定事实本次不可读');
  assert.equal(bindingFact(assetOf({ binding: { state: 'KNOWN', current: {}, historical: {} } })), '当前无有效引用，也无历史版本引用');
  assert.equal(bindingFact(assetOf({ binding: { state: 'KNOWN', current: { game: 1, listing_version: 2 }, historical: { listing_version: 3 } } })),
    '当前有效引用：游戏封面 1 处、账号资料版本 2 处 · 历史版本引用：账号资料版本 3 处');
  assert.equal(bindingFact(assetOf({ binding: { state: 'KNOWN', current: { mystery_object: 1 }, historical: {} } })), '当前有效引用：对象类型 mystery_object 1 处', 'unknown types are reported, not dropped');
});

test('revision axis reports the asset revision without promising conflict protection', () => {
  assert.equal(revisionFact(assetOf()), '素材修订未提供');
  assert.equal(revisionFact(assetOf({ revision: '7' })), '修订 7');
});
