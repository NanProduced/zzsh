import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attributeFacts,
  accountNumberLabel,
  historicalAttributeFacts,
  historicalReadSummary,
  historicalResourceText,
  availabilityText,
  blockerLabel,
  cursorDelta,
  effectiveRentable,
  formatAmount,
  formatTermDays,
  entitlementTermText,
  inventoryRows,
  isHistorical,
  quoteLineFacts,
  skinFacts,
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
  orderTitleText,
  publicBasisVersion,
  supplyObjectLabel,
  unitText,
} from "../src/views/supply-review/model.ts";

test("same public basis keeps its own release, ratio and line pricing metadata", () => {
  const basis = { id: "v-public", releaseId: "rel-public", accountId: "a", title: "对外版", description: null, attributes: {}, presentation: { items: [{ id: "barrett", name: "巴雷特", unit: "ROUND" }] }, media: [], termOption: null, fullPayoutSelected: true, publishedAt: null,
    quote: { resourceTotal: { amount: "100.00" }, termSeconds: "86400", unitAmountsInformational: true, baseRenterHaffRatioWanPerYuan: "12.5",
      lines: [{ itemId: "barrett", quantity: "2", unit: "ROUND", unitQuantity: "10", buyerUnitAmount: { amount: "0.50" }, buyerAmount: { amount: "1.00" } }] } };
  const version = publicBasisVersion(basis), line = quoteLineFacts(version)[0];
  assert.equal(version.releaseId, "rel-public");
  assert.equal(version.quote.unitAmountsInformational, true);
  assert.equal(version.quote.baseRenterHaffRatioWanPerYuan, "12.5");
  assert.equal(line.unitQuantity, "10");
  assert.equal(line.buyerUnitAmount, "0.50");
  assert.equal(line.amount, "1.00");
  assert.equal(publicBasisVersion({ ...basis, releaseId: null }).releaseId, null);
});

test("new account declarations preserve true false and unknown without inferring an answer", () => {
  const version = { declaration: { attributes: {} } };
  const values = attributes => new Map(attributeFacts({ ...version, declaration: { attributes } }).map(item => [item.label, item.value]));
  assert.equal(values({ next_season_pass: true, demulan_unlocked: false }).get('下赛季通行证'), '计划购买');
  assert.equal(values({ next_season_pass: true, demulan_unlocked: false }).get('德穆兰'), '未解锁');
  assert.equal(values({ next_season_pass: false, demulan_unlocked: true }).get('下赛季通行证'), '不计划购买');
  for (const value of [undefined, null, 'false', 0]) {
    assert.equal(values({ next_season_pass: value, demulan_unlocked: value }).get('下赛季通行证'), '未提供');
    assert.equal(values({ next_season_pass: value, demulan_unlocked: value }).get('德穆兰'), '未提供');
  }
});

test("mixed account numbers keep canonical ZZ/AC separate from numeric legacy sources", () => {
  assert.equal(accountNumberLabel("ZZ20261018000001"), "账号 ZZ20261018000001");
  assert.equal(accountNumberLabel("AC9000000000002"), "账号 AC9000000000002");
  assert.equal(accountNumberLabel("0000123"), "旧来源号 0000123");
  for (const value of [null, undefined, "", "ZZ20261018", "AC1", "not-a-number", " 0000123", "AC"+"1".repeat(127)]) assert.equal(accountNumberLabel(value), "账号编号待核");
});

test("review skin list stays text-only and distinguishes platform quality from identity", () => {
  const version = { presentation: { skins: [{ id: "skin", name: "合成近战", ownerKind: "MELEE_TYPE", rarityName: "合成品质", rarityBasis: "PLATFORM_REFERENCE", isCollectible: true, defaultState: "DEFAULT", imageUrl: "https://example.org/do-not-render" }] }, declaration: { skins: ["skin"] } };
  assert.equal(skinsText(version), "近战外观 · 合成近战 · 合成品质 · 品质为平台参考 · 典藏 · 默认外观");
  assert.equal(skinsText(version).includes("https:"), false);
});

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
  assert.equal(blockerLabel("CONFIRMATION_OR_MEDIA_REQUIRED"), "规则接受或展示图尚未同时满足");
  assert.equal(blockerLabel("MEDIA_REQUIRED"), "展示图不满足");
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
  assert.equal(facts.length, 17);
  assert.equal(byLabel["小段位"].value, "未申报");
  assert.equal(byLabel["本人脸声明"].value, "未提供");
  assert.equal(byLabel["封禁记录声明"].value, "未提供");
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

test("delta resource code labels preserve dynamic inventory, frozen names, zero and unknown", () => {
  const code = "df_billable_turtle_backpack_45";
  assert.equal(unitText("PIECE", code), "个");
  assert.equal(unitText("PIECE", "unrecognized_resource"), "件");
  assert.equal(unitText("DAY", code), "天", "code never overrides the recorded unit");
  assert.equal(historicalResourceText({ code, quantity: "2", unit: "PIECE" }), "2 个");
  assert.equal(historicalResourceText({ code, quantity: "0", unit: "PIECE" }), "0 个");
  assert.equal(historicalResourceText({ code, quantity: null, unit: "PIECE" }), "数量待核");
  assert.equal(historicalResourceText({ code: "df_billable_top_insure_card", quantity: "7", unit: "DAY" }), "7 天");
  const version = { declaration: { inventory: [{ itemId: "dynamic-id", quantity: "2" }, { itemId: "old-card", quantity: "0" }] },
    presentation: { items: [{ id: "dynamic-id", code, name: "45格乌龟包", unit: "PIECE" },
      { id: "old-card", code: "df_billable_top_insure_card", name: "顶级保险卡", unit: "DAY" }] } };
  const rows = inventoryRows(version, null);
  assert.deepEqual(rows.map(row => [row.name, row.current, row.unit]), [["45格乌龟包", "2", "个"], ["顶级保险卡", "0", "天"]]);
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

test("historical display stays separate from native declarations, exact zero and unknown resources", () => {
  const read = {
    resourceNo: "SOURCE-1", canCreateOrder: false, trade: "UNKNOWN", quote: null,
    historicalQuote: { haffRentYuan: "12.30", goodsYuan: "0.00", depositYuan: "0.00", termDays: "2", dailyHaffBase: "1000000" },
    display: { state: "KNOWN", facts: {
      schema: "legacy-listing-display-v1", rentalMode: "fast",
      attributes: { safe_box_code: "safe_box_3x3", character_level: 0, region_province: null },
      resources: [{ code: "haff_base", name: "哈夫币", quantity: "0", unit: "HAFF_BASE" }, { code: "coffee", name: "咖啡豆", quantity: null, unit: "PIECE" }],
      attributeDisplay: { safeBox: { code: "safe_box_3x3", displayName: "顶级安全箱", mappingStatus: "CONFIRMED", issueCode: null }, grading: null, loginMethod: null, serviceWindow: null },
      sourceUpdatedAt: "2026-09-13T00:00:00.000Z",
    } },
  };
  const before = JSON.stringify(read);
  assert.match(historicalReadSummary(read), /SOURCE-1.*极速.*顶级安全箱/);
  assert.equal(historicalResourceText(read.display.facts.resources[0]), "0 M 哈夫币");
  assert.equal(historicalResourceText(read.display.facts.resources[1]), "数量待核");
  assert.equal(historicalResourceText({ quantity: "bad", unit: "ROUND" }), "数量待核");
  assert.equal(historicalResourceText({ quantity: "0", unit: "ROUND" }), "0 发");
  assert.equal(historicalAttributeFacts(read).find(f => f.label === "角色等级").value, "0 级");
  assert.equal(historicalAttributeFacts(read).find(f => f.label === "地区").value, "来源未提供");
  assert.equal(JSON.stringify(read), before);
  assert.equal(historicalReadSummary(null), null);
  assert.match(historicalReadSummary({ ...read, display: { state: "NOT_IMPORTED", facts: null } }), /尚待接入/);
  assert.deepEqual(historicalAttributeFacts({ ...read, display: { state: "NOT_IMPORTED", facts: null } }), []);
});

test("ADM-R1-04：编号分列——displayNo 只认 canonical，旧来源号单独标注", () => {
  // canonical 存在：直接用新编号，不掺旧号
  assert.equal(supplyObjectLabel({ id: "a1", displayNo: "ZZ20261018000001", facts: { legacyNumbers: ["0000123"] } }), "ZZ20261018000001");
  // canonical 为空、只有一个旧来源号：显式标注旧号，不冒充新编号
  assert.equal(supplyObjectLabel({ id: "a2", displayNo: null, facts: { legacyNumbers: ["0000123"] } }), "旧来源号 0000123");
  // canonical 为空且没有旧号：退回账号短标识，不编造编号
  const fallback = supplyObjectLabel({ id: "account-fixture-0001", displayNo: null, facts: { legacyNumbers: [] } });
  assert.match(fallback, /^账号 /);
  assert.equal(fallback.includes("ZZ"), false, "不生成任何 canonical 形态编号");
  // 多个旧号不冒充唯一编号
  assert.match(supplyObjectLabel({ id: "a3", displayNo: null, facts: { legacyNumbers: ["0000123", "0000124"] } }), /^账号 /);
  // 前导零保留
  assert.equal(supplyObjectLabel({ id: "a4", displayNo: null, facts: { legacyNumbers: ["0000123"] } }).endsWith("0000123"), true);
});

test("declarations stay tri-state and an empty draft skin selection does not revive the old list", () => {
  const version = { declaration: { attributes: { face_is_self: true, ban_record: null, grading_division: null }, inventory: [{ itemId: "barrett", quantity: "2" }, { itemId: "six", quantity: "120" }, { itemId: "helm", quantity: "0" }, { itemId: "armor", quantity: null }, { itemId: "coffee", quantity: "1" }, { itemId: "pack", quantity: "3" }], skins: ["old"], entitlements: [] }, presentation: { items: [], skins: [{ id: "old", name: "旧皮肤" }] }, catalogItems: [{ id: "barrett", name: "巴雷特", unit: "ROUND", code: "df_billable_barrett_bullet" }, { id: "six", name: "六级弹", unit: "ROUND" }, { id: "helm", name: "六级头", unit: "PIECE" }, { id: "armor", name: "六级甲", unit: "PIECE" }, { id: "coffee", name: "咖啡", unit: "PIECE" }, { id: "pack", name: "背包", unit: "PIECE", code: "df_billable_turtle_backpack_45" }], draftSkinSummary: { items: [], withheld: 2 }, quote: { resourceTotal: { amount: "10.00" }, termSeconds: "86400", lines: [{ itemId: "barrett", quantity: "2", unit: "ROUND", buyerAmount: { amount: "1.00" }, ownerAmount: { amount: "0.40" } }] } };
  const facts = attributeFacts(version);
  assert.equal(facts.find(fact => fact.label === "本人脸声明").value, "号主声明本人脸");
  assert.equal(facts.find(fact => fact.label === "封禁记录声明").value, "未提供");
  assert.equal(facts.find(fact => fact.label === "小段位").value, "未知");
  const rows = inventoryRows(version, null);
  assert.deepEqual(rows.map(row => row.name), ["巴雷特", "六级弹", "六级头", "六级甲", "咖啡", "背包"]);
  assert.equal(rows.at(-1).unit, "个");
  assert.equal(skinFacts(version).rows.length, 0);
  assert.equal(skinFacts(version).source, "CURRENT_DRAFT_SELECTION");
  assert.equal(entitlementTermText({ expiresAt: null, expiryKnowledge: "UNKNOWN" }), "期限未知");
  assert.match(entitlementTermText({ expiresAt: "2026-01-02T00:00:00.000Z", expiryKnowledge: "KNOWN" }), /到期/);
  const line = quoteLineFacts(version)[0];
  assert.equal(line.name, "巴雷特");
  assert.equal(line.ownerAmount, "0.40");
  assert.equal(orderTitleText({ title: "历史资料待核实", accountTitle: { source: "CURRENT_ACCOUNT", title: "当前号" } }), "当前账号资料：当前号（不是本单原标题）");
  assert.equal(orderTitleText({ title: "本单原题" }), "本单原题");
  assert.equal(orderTitleText({ title: null }), "本单原标题未提供");
});
