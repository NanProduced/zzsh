import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewItemLabel } from "../src/views/supply-review-labels.ts";

test("draft item names use the current catalog and frozen snapshots stay unchanged", () => {
  assert.deepEqual(reviewItemLabel({
    itemId: "item-new",
    inCurrent: true,
    presentation: [],
    catalog: [{ id: "item-new", name: "六级头盔", unit: "PIECE" }],
    previousPresentation: [{ id: "item-new", name: "历史物品", unit: "DAY" }],
  }), { name: "六级头盔", unit: "件" });
  assert.deepEqual(reviewItemLabel({
    itemId: "item-old",
    inCurrent: true,
    presentation: [{ id: "item-old", name: "报价时名称", unit: "ROUND" }],
    catalog: [{ id: "item-old", name: "当前目录新名", unit: "PIECE" }],
  }), { name: "报价时名称", unit: "发" });
  assert.deepEqual(reviewItemLabel({
    itemId: "item-hist",
    inCurrent: false,
    catalog: [{ id: "item-hist", name: "当前目录新名", unit: "PIECE" }],
    previousPresentation: [{ id: "item-hist", name: "冻结旧名", unit: "HAFF_BASE" }],
  }), { name: "冻结旧名", unit: "哈夫币" });
  assert.deepEqual(reviewItemLabel({
    itemId: "item-x",
    inCurrent: true,
    presentation: [{ id: "item-x", name: "只有名称" }],
    catalog: [{ id: "item-x", name: "目录名", unit: "PIECE" }],
  }), { name: "只有名称", unit: "未确认" });
  assert.deepEqual(reviewItemLabel({ itemId: "item-missing", inCurrent: true }), { name: "未确认（item-missing）", unit: "未确认" });
});
