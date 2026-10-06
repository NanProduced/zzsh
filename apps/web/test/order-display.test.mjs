import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(testDirectory, "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const display = requireFromTree(path.join(tree, "apps/web/src/lib/order-display.ts"));

const yuan = (amount) => ({ currency: "CNY", unit: "yuan", scale: 2, amount });

test("resource names resolve through the order projection and never invent a name", () => {
  const order = { quote: { lines: [{ itemId: "item_haff", name: "哈夫币", unit: "HAFF_BASE" }, { itemId: "item_piece", name: "", unit: "PIECE" }] } };
  assert.equal(display.resourceName(order, "item_haff"), "哈夫币");
  assert.equal(display.resourceName(order, "item_piece"), "item_piece");
  assert.equal(display.resourceName(order, "item_unknown"), "item_unknown");
});

test("haff quantities keep the exact integer and the exact M helper", () => {
  assert.equal(display.quantityText("HAFF_BASE", "60000000"), "60,000,000 哈夫币（60 M）");
  assert.equal(display.quantityText("HAFF_BASE", "30500000"), "30,500,000 哈夫币（30.5 M）");
  assert.equal(display.quantityText("PIECE", "10"), "10 件");
  assert.equal(display.quantityText("ROUND", "1020"), "1,020 发");
  assert.equal(display.quantityText("PIECE", "not-a-number"), "not-a-number");
});

test("party amounts expose the concrete values and fee payer without internal profit fields", () => {
  const amounts = {
    haffConsumedBuyer: yuan("150.00"), itemConsumedBuyer: yuan("4.00"), unusedItemRefund: yuan("16.00"), unusedHaffRefund: yuan("0.00"),
    earlyMakeup: yuan("0.00"), renterCharge: yuan("154.00"), renterRefund: yuan("316.00"), depositRefund: yuan("300.00"),
    feeAmount: yuan("9.84"), feeRate: "0.08", feePayer: "OWNER",
    haffConsumedOwner: yuan("120.00"), itemConsumedOwner: yuan("3.00"), ownerGross: yuan("123.00"), ownerNet: yuan("113.16"),
    platformHaffSpread: yuan("30.00"), platformContribution: yuan("40.84"),
  };
  const renter = display.settlementAmountRows("renter", amounts);
  const labels = renter.map((row) => row.label);
  assert.ok(labels.includes("预计应退"));
  assert.ok(labels.includes("本次消耗合计"));
  assert.ok(!labels.some((label) => label.includes("平台")));
  assert.equal(renter.find((row) => row.label === "预计应退").value, "¥316.00");
  const owner = display.settlementAmountRows("owner", amounts);
  assert.equal(owner.find((row) => row.label === "号主净入账").value, "¥113.16");
  assert.ok(owner.some((row) => row.label.includes("包赔费用（号主承担") && row.value === "¥9.84"));
  assert.ok(!owner.some((row) => row.value === "¥40.84"));
  const renterPayerOwner = display.settlementAmountRows("owner", { ...amounts, feePayer: "RENTER" });
  assert.ok(renterPayerOwner.some((row) => row.label.includes("包赔费用") && row.value === "由租客承担"));
  assert.ok(!renterPayerOwner.some((row) => row.value === "¥9.84" && row.label.includes("包赔")));
});

test("projected yuan strings and money objects render identically", () => {
  assert.equal(display.moneyText("316.00"), "¥316.00");
  assert.equal(display.moneyText(yuan("316.00")), "¥316.00");
  assert.equal(display.moneyText("not-money"), "—");
});

test("missing or non-CNY amounts are explicit, never zero-filled", () => {
  assert.equal(display.moneyText(undefined), "—");
  assert.equal(display.moneyText({ currency: "USD", amount: "1.00" }), "—");
  const rows = display.settlementAmountRows("renter", { feePayer: "RENTER", feeAmount: yuan("1.00") });
  assert.equal(rows.find((row) => row.label.includes("包赔费用")).value, "¥1.00");
  assert.equal(rows.find((row) => row.label === "哈夫币消耗（租客侧）").value, "—");
});
