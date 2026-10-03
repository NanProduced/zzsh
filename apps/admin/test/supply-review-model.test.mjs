import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attributeFacts,
  availabilityText,
  blockerLabel,
  cursorDelta,
  effectiveRentable,
  formatAmount,
  formatTermDays,
  inventoryRows,
  isHistorical,
  lightboxKeyAction,
  mediaCanQuarantine,
  mediaCanRestore,
  mediaEligibleLabel,
  mediaPurposeLabel,
  mediaReadableLabel,
  mediaReviewLabel,
  moveCursorId,
  publicationSourceLabel,
  quantityText,
  reasonIsDirty,
  reviewStateLabel,
  skinsText,
} from "../src/views/supply-review/model.ts";

test("supervision views, sources and state labels are explicit", () => {
  assert.equal(reviewStateLabel("PUBLISHED"), "已发布(直发)");
  assert.equal(reviewStateLabel("APPROVED"), "已通过(历史审核)");
  assert.equal(reviewStateLabel("SUBMITTED"), "历史待审");
  assert.equal(reviewStateLabel("SOMETHING_NEW"), "SOMETHING_NEW");
  assert.equal(publicationSourceLabel("OWNER_DIRECT"), "号主直发");
  assert.equal(publicationSourceLabel("LEGACY_APPROVED"), "历史审核发布");
  assert.equal(publicationSourceLabel(null), "来源未确认");
});

test("blocker labels and rentability separate pause, restriction and qualification", () => {
  assert.equal(blockerLabel("RULE_CHANGED"), "规则已切换(需新版本)");
  assert.equal(blockerLabel("OCCUPANCY_UNKNOWN"), "占用状态未知");
  assert.equal(blockerLabel("CONFIRMATION_OR_MEDIA_REQUIRED"), "规则接受或展示图不满足");
  assert.equal(blockerLabel("OWNER_PAUSED"), "号主已暂停");
  assert.equal(blockerLabel("STAFF_RESTRICTED"), "运营限制中");
  assert.equal(blockerLabel("CUSTOM_CODE"), "CUSTOM_CODE");

  const base = { available: true, account: { owner_paused: false, staff_restricted: false } };
  assert.equal(effectiveRentable(base), true);
  assert.equal(availabilityText(base), "当前可公开出租");
  const paused = { ...base, account: { ...base.account, owner_paused: true } };
  assert.equal(effectiveRentable(paused), false);
  assert.equal(availabilityText(paused), "号主已暂停(隐藏于公开列表)");
  const restricted = { ...base, account: { ...base.account, staff_restricted: true } };
  assert.equal(effectiveRentable(restricted), false);
  assert.equal(availabilityText(restricted), "运营限制中(已隐藏公开展示并阻止新订单)");
  const blocked = { ...base, available: false };
  assert.equal(availabilityText(blocked), "当前不可租(存在阻塞项)");
});

test("media status labels and action eligibility mirror the display/evidence contract", () => {
  const display = { assetId: "m-1", purpose: "ACCOUNT_DISPLAY", reviewState: "NOT_REQUIRED", publicDisplayEligible: true, publiclyReadable: true };
  assert.equal(mediaPurposeLabel(display), "展示图");
  assert.equal(mediaReviewLabel(display), "免人工预审");
  assert.equal(mediaEligibleLabel(display), "具备展示资格");
  assert.equal(mediaReadableLabel(display), "当前公开可读");
  assert.equal(mediaCanQuarantine(display), true);
  assert.equal(mediaCanRestore(display), false);

  const blockedDisplay = { ...display, publicDisplayEligible: false, publiclyReadable: false };
  assert.equal(mediaEligibleLabel(blockedDisplay), "不具备展示资格");
  assert.equal(mediaReadableLabel(blockedDisplay), "当前公开不可读");

  const quarantined = { ...display, reviewState: "QUARANTINED", publicDisplayEligible: false, publiclyReadable: false };
  assert.equal(mediaCanQuarantine(quarantined), false);
  assert.equal(mediaCanRestore(quarantined), true, "quarantined display offers restore; server revalidates readiness");
  const rejected = { ...display, reviewState: "REJECTED" };
  assert.equal(mediaCanQuarantine(rejected), false);
  assert.equal(mediaCanRestore(rejected), false);
  assert.equal(mediaReviewLabel({ ...display, reviewState: "APPROVED" }), "已通过(受权)");

  const evidence = { assetId: "m-2", purpose: "ACCOUNT_EVIDENCE", reviewState: "PENDING", publicDisplayEligible: false, publiclyReadable: false };
  assert.equal(mediaPurposeLabel(evidence), "私有凭证");
  assert.equal(mediaReviewLabel(evidence), "已上传(私有)");
  assert.equal(mediaEligibleLabel(evidence), "不参与公开展示");
  assert.equal(mediaReadableLabel(evidence), "仅审核可见");
  assert.equal(mediaCanQuarantine(evidence), false, "evidence stays private, no display actions");
  assert.equal(mediaCanRestore(evidence), false);
});

test("queue cursor follows j/k and clamps at both ends", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(cursorDelta("j"), 1);
  assert.equal(cursorDelta("ArrowDown"), 1);
  assert.equal(cursorDelta("k"), -1);
  assert.equal(cursorDelta("ArrowUp"), -1);
  assert.equal(cursorDelta("Enter"), null);
  assert.equal(moveCursorId(items, undefined, 1), "a");
  assert.equal(moveCursorId(items, "c", 1), "c");
  assert.equal(moveCursorId(items, "a", -1), "a");
  assert.equal(moveCursorId([], "a", 1), null);
});

test("reason dirty check, lightbox key and historical blocker stay explicit", () => {
  assert.equal(reasonIsDirty(""), false);
  assert.equal(reasonIsDirty(" 处置原因 "), true);
  assert.equal(lightboxKeyAction("Escape"), "close");
  assert.equal(lightboxKeyAction("j"), null);
  assert.equal(isHistorical({ blockers: ["HISTORICAL_VERSION"] }), true);
  assert.equal(isHistorical({ blockers: [] }), false);
});

test("attribute facts mirror the API fields and flag unconfirmed codes", () => {
  const version = {
    termOption: { code: "term-1", displayName: "日消耗 10M", dailyConsumption: { quantity: "10000000", unit: "HAFF_BASE" } },
    attributeDisplay: {
      safeBox: { code: "box-a", displayName: null, mappingStatus: "UNCONFIRMED", issueCode: null },
      grading: { code: "g-1", displayName: "传奇", mappingStatus: "CONFIRMED", issueCode: null },
      loginMethod: null,
      serviceWindow: { startMinute: 540, endMinute: 1380, displayName: "" },
    },
    declaration: {
      attributes: {
        safe_box_code: "box-a",
        vit_level: 6,
        grading_code: "g-1",
        secret_kd: 2.5,
        region_province: "上海",
        region_city: "浦东",
      },
    },
  };
  const facts = attributeFacts(version);
  const byLabel = Object.fromEntries(facts.map((fact) => [fact.label, fact]));
  assert.equal(facts.length, 12);
  assert.deepEqual(byLabel["安全箱配置"], { label: "安全箱配置", value: "未确认(代码 box-a)", unconfirmed: true });
  assert.equal(byLabel["段位"].value, "传奇");
  assert.equal(byLabel["每日消耗"].value, "10 M 哈夫币");
  assert.equal(byLabel["上号时间"].unconfirmed, true);
});

test("inventory rows mark only real quantity changes and keep history names", () => {
  const version = {
    declaration: { inventory: [{ itemId: "haff", quantity: "60000000" }, { itemId: "round", quantity: null }] },
    presentation: { items: [{ id: "haff", name: "哈夫币", unit: "HAFF_BASE" }] },
  };
  const previous = { inventory: [{ itemId: "haff", quantity: "60000000" }, { itemId: "round", quantity: "3000" }, { itemId: "legacy", quantity: "1" }] };
  const rows = inventoryRows(version, previous, [{ id: "legacy", name: "旧物品" }]);
  const byId = Object.fromEntries(rows.map((row) => [row.itemId, row]));
  assert.equal(byId.haff.changed, false);
  assert.equal(byId.round.changed, true);
  assert.equal(byId.legacy.current, "本次未申报");
  assert.equal(inventoryRows(version, null).find((row) => row.itemId === "haff").previous, "未申报");
});

test("amounts, terms and quantities format without floats; skins tolerate missing data", () => {
  assert.equal(formatAmount("7650.00"), "7,650.00");
  assert.equal(formatAmount("123456789012345678.5"), "123,456,789,012,345,678.5");
  assert.equal(formatTermDays("518400"), "6 天");
  assert.equal(formatTermDays("bad"), "未确认");
  assert.equal(quantityText("60000000"), "60 M 哈夫币");
  assert.equal(quantityText(null), "未确认");
  assert.equal(skinsText({ presentation: { skins: [{ id: "s1", name: "M4A1 鎏金", categoryName: "M4A1" }] } }), "M4A1 · M4A1 鎏金");
  assert.equal(skinsText({ presentation: {} }), "皮肤资料未提供");
});

test("finish F3: missing region never derives a skin statement", () => {
  for (const skins of [[], ["skin-unmapped"]]) {
    const version = {declaration:{attributes:{},skins},presentation:{}};
    assert.deepEqual(attributeFacts(version).find(fact=>fact.label==="地区"),{label:"地区",value:"未申报",unconfirmed:false});
    assert.equal(skinsText(version),skins.length ? "皮肤名称或归属尚未核齐" : "未申报皮肤");
  }
  const version={declaration:{attributes:{region_province:"上海",region_city:"浦东"},skins:["skin-unmapped"]},presentation:{}};
  assert.equal(attributeFacts(version).find(fact=>fact.label==="地区").value,"上海 · 浦东");
});
