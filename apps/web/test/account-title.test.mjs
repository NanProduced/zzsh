import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rq = createRequire(path.join(tree, "package.json"));
const ts = rq("typescript");

function loadAccountTitle() {
  const filePath = path.join(tree, "apps/web/src/lib/account-title.ts");
  const compiled = ts.transpileModule(fs.readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filePath);
  mod.filename = filePath;
  mod.paths = Module._nodeModulePaths(tree);
  mod.require = (name) => {
    if (name === "./listing-filters" || name === "@/lib/listing-filters") {
      return {
        canonicalResourceCode: (code) =>
          ({
            level6_armor: "df_billable_level6_armor",
            level6_helmet: "df_billable_level6_helmet",
            level6_round: "df_billable_level6_bullet",
            awm_round: "df_billable_awm_bullet",
            coffee: "df_billable_coffee",
          }[code] ?? code),
      };
    }
    return rq(name);
  };
  mod._compile(compiled, filePath);
  return mod.exports;
}

const {
  deriveAccountTitle,
  deriveDetailTitle,
  parseRank,
  parseSafeBox,
  extractSafeBoxForTitle,
  extractRankForTitle,
  extractLevelForTitle,
  extractVitForTitle,
  extractBearForTitle,
  formatSupplyItem,
  isHaff,
  orderedQuoteResources,
} = loadAccountTitle();

test("deriveAccountTitle creates identical primary and secondary titles across views", () => {
  const account = {
    title: "193M 哈夫币 · 旧号202609110112",
    publicTitle: null,
    resourceLines: [
      { itemId: "h", code: "df_billable_haff", name: "哈夫币", quantity: "193000000", unitLabel: "哈夫币" },
      { itemId: "a", code: "df_billable_level6_armor", name: "六级甲", quantity: "12", unitLabel: "件" },
      { itemId: "hl", code: "df_billable_level6_helmet", name: "六级头", quantity: "7", unitLabel: "件" },
      { itemId: "b", code: "df_billable_level6_bullet", name: "六级子弹", quantity: "300", unitLabel: "发" },
      { itemId: "awm", code: "df_billable_awm_bullet", name: "AWM子弹", quantity: "61", unitLabel: "发" },
      { itemId: "c", code: "df_billable_coffee", name: "咖啡", quantity: "25", unitLabel: "件" },
      { itemId: "barrett", code: "df_billable_barrett_bullet", name: "巴雷特子弹", quantity: "0", unitLabel: "发" },
      { itemId: "ins", code: "df_billable_top_insure_card", name: "九格保险卡", quantity: "0", unitLabel: "天" },
    ],
    conditionLines: [
      { key: "safe_box_code", value: "3*3" },
      { key: "grading_code", value: "钻石" },
      { key: "character_level", value: "60" },
      { key: "vit_level", value: "7" },
      { key: "bear_level", value: "5" },
    ],
  };

  const title = deriveAccountTitle(account);
  assert.equal(
    title.primary,
    "193M 哈夫币 · 3×3安全箱 · 钻石 · 60级 · 体力7 · 负重5"
  );
  assert.equal(
    title.secondary,
    "12六甲 · 7六头 · 5组六级弹 · 61发AWM"
  );
  // Old platform ID MUST NOT leak into primary, secondary or rest
  assert.ok(!title.primary.includes("旧号"));
  assert.ok(!title.secondary.includes("旧号"));
  assert.ok(!title.rest.includes("旧号"));

  // deriveDetailTitle gives identical primary and secondary
  const detailTitle = deriveDetailTitle(account);
  assert.equal(detailTitle.primary, title.primary);
  assert.equal(detailTitle.secondary, title.secondary);
});

test("six-level bullet conversion handles whole stacks and remainder accurately", () => {
  const cases = [
    { qty: "59", expectedInventory: "59发", expectedCompact: "59发六级弹" },
    { qty: "60", expectedInventory: "1组（60发）", expectedCompact: "1组六级弹" },
    { qty: "61", expectedInventory: "1组零1发（共61发）", expectedCompact: "1组零1发六级弹" },
    { qty: "119", expectedInventory: "1组零59发（共119发）", expectedCompact: "1组零59发六级弹" },
    { qty: "120", expectedInventory: "2组（120发）", expectedCompact: "2组六级弹" },
    { qty: "300", expectedInventory: "5组（300发）", expectedCompact: "5组六级弹" },
    { qty: "0", expectedInventory: "0组（0发）", expectedCompact: "" },
  ];

  for (const c of cases) {
    const line = { itemId: "b", code: "df_billable_level6_bullet", name: "六级子弹", quantity: c.qty, unitLabel: "发" };
    const formatted = formatSupplyItem(line);
    assert.equal(formatted.quantityText, c.expectedInventory, `inventory qty for ${c.qty}`);
    assert.equal(formatted.isZero, c.qty === "0", `isZero for ${c.qty}`);

    const res = deriveAccountTitle({ resourceLines: [line], conditionLines: [] });
    assert.equal(res.secondary, c.expectedCompact, `compact secondary for ${c.qty}`);
  }
});

test("real zero, unknown/null, and missing rows are strictly differentiated", () => {
  const zeroArmor = { itemId: "1", code: "df_billable_level6_armor", name: "六级甲", quantity: "0", unitLabel: "件" };
  const unknownHelmet = { itemId: "2", code: "df_billable_level6_helmet", name: "六级头", quantity: null, unitLabel: "件" };
  const undeclaredAwm = { itemId: "3", code: "df_billable_awm_bullet", name: "AWM子弹", quantity: "未提供", unitLabel: "发" };

  const fmtZero = formatSupplyItem(zeroArmor);
  assert.equal(fmtZero.isZero, true);
  assert.equal(fmtZero.isUnknown, false);
  assert.equal(fmtZero.quantityText, "0件");

  const fmtUnknown = formatSupplyItem(unknownHelmet);
  assert.equal(fmtUnknown.isZero, false);
  assert.equal(fmtUnknown.isUnknown, true);
  assert.equal(fmtUnknown.quantityText, "未提供");

  const fmtUndeclared = formatSupplyItem(undeclaredAwm);
  assert.equal(fmtUndeclared.isZero, false);
  assert.equal(fmtUndeclared.isUnknown, true);
  assert.equal(fmtUndeclared.quantityText, "未提供");

  // Real 0 does not invent positive war stock into secondary title
  const res = deriveAccountTitle({ resourceLines: [zeroArmor, unknownHelmet], conditionLines: [] });
  assert.equal(res.secondary, "");
});

test("rank parser correctly maps Roman numerals and Peak", () => {
  assert.equal(parseRank("巅峰").text, "巅峰");
  assert.equal(parseRank("peak").text, "巅峰");
  assert.equal(parseRank("黄金4").text, "黄金IV");
  assert.equal(parseRank("黄金IV").text, "黄金IV");
  assert.equal(parseRank("钻石3").text, "钻石III");
  assert.equal(parseRank("黑鹰5").text, "黑鹰V");
  assert.equal(parseRank("青铜1").text, "青铜I");
  assert.equal(parseRank("白银2").text, "白银II");
  assert.equal(parseRank("黄金").text, "黄金 · 小段位未提供");
  assert.equal(parseRank("未提供").text, "未提供");
  assert.equal(parseRank(null).text, "未提供");
  assert.equal(parseRank("").text, "未提供");

  // extractRankForTitle omits incomplete subrank note
  assert.equal(extractRankForTitle("黄金"), "黄金");
  assert.equal(extractRankForTitle("黄金4"), "黄金IV");
  assert.equal(extractRankForTitle("未提供"), null);
});

test("safe box extracts size with × normalization", () => {
  assert.equal(extractSafeBoxForTitle("3*3"), "3×3安全箱");
  assert.equal(extractSafeBoxForTitle("3*3安全箱"), "3×3安全箱");
  assert.equal(extractSafeBoxForTitle("1*2 2格安全箱"), "1×2安全箱");
  assert.equal(extractSafeBoxForTitle("顶级安全箱(3*3)"), "3×3安全箱");
  assert.equal(extractSafeBoxForTitle("未提供"), null);
  assert.equal(extractSafeBoxForTitle(null), null);
});

test("fallback title cleaning deduplicates haff quantity", () => {
  const withHaffInTitle = {
    title: "100M 哈夫币 极品满配全装",
    conditionLines: [],
  };
  const title1 = deriveAccountTitle(withHaffInTitle, "100M");
  assert.equal(title1.haff, "100M 哈夫币");
  assert.equal(title1.rest, "极品满配全装");
  assert.equal(title1.primary, "100M 哈夫币 · 极品满配全装");

  const emptyTitle = {
    title: "",
    conditionLines: [],
  };
  const title2 = deriveAccountTitle(emptyTitle, null);
  assert.equal(title2.primary, "游戏账号");
  assert.equal(title2.rest, "游戏账号");
});

test("inventory art resolves to existing game item images for current and legacy codes", () => {
  const images = [
    ["df_billable_level6_armor", "level6-armor-mas2.png"],
    ["level6_armor", "level6-armor-mas2.png"],
    ["df_billable_level6_helmet", "level6-helmet-dich9.png"],
    ["level6_helmet", "level6-helmet-dich9.png"],
    ["df_billable_barrett_bullet", "barrett-ammo.png"],
    ["barrett_round", "barrett-ammo.png"],
    ["legacy_barrett_round", "barrett-ammo.png"],
    ["df_billable_awm_bullet", "awm-ammo.png"],
    ["awm_round", "awm-ammo.png"],
    ["df_billable_level6_bullet", "level6-ammo.png"],
    ["level6_round", "level6-ammo.png"],
    ["df_billable_coffee", "coffee-beans.png"],
    ["coffee", "coffee-beans.png"],
    ["df_billable_turtle_backpack_45", "turtle-backpack-45.png"],
    ["turtle_backpack_45", "turtle-backpack-45.png"],
    ["df_billable_top_insure_card", "insurance-experience-card-thumb.png"],
    ["top_insure_card_piece", "insurance-experience-card-thumb.png"],
    ["df_billable_top_insure_card_piece", "insurance-experience-card-thumb.png"],
    ["legacy_insurance_day", "insurance-experience-card-thumb.png"],
  ];
  for (const [code, filename] of images) {
    const { imageSrc } = formatSupplyItem({ code, quantity: "0", unitLabel: "件" });
    assert.equal(imageSrc, `/art/delta/items/${filename}`, code);
    const image = fs.readFileSync(path.join(tree, "apps/web/public", imageSrc));
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", code);
    assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0, code);
  }
  assert.equal(formatSupplyItem({ code: "unmapped_item", quantity: "1" }).imageSrc, null);
});

test("turtle backpack uses individual pieces while preserving zero and undeclared quantities", () => {
  for (const code of ["df_billable_turtle_backpack_45", "turtle_backpack_45"]) {
    for (const [quantity, quantityText, isZero, isUnknown] of [
      ["3", "3个", false, false],
      ["0", "0个", true, false],
      [null, "未提供", false, true],
      ["", "未提供", false, true],
    ]) {
      const line = { itemId: "item_ddc2cdca19f8414a896ea149a7e21d2a", code, quantity, unitLabel: "件" };
      assert.deepEqual(formatSupplyItem(line), {
        imageSrc: "/art/delta/items/turtle-backpack-45.png", quantityText, isZero, isUnknown,
      });
      assert.equal(orderedQuoteResources({ resourceLines: [line] })[0], line);
    }
  }
  assert.deepEqual(orderedQuoteResources({ resourceLines: [] }), [], "a missing backpack row must stay absent");
});
