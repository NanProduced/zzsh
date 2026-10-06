import { strict as assert } from "node:assert";
import { test } from "node:test";
import { projectFrozenInventory } from "../src/im/order-team-access";

test("frozen inventory projection whitelists order snapshot lines and never invents stock", () => {
  const snapshot = {
    lines: [
      { itemId: "item_haff", quantity: "5000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", buyerAmount: { currency: "CNY", unit: "yuan", amount: "9.99", scale: 2 } },
      { itemId: "item_ammo", quantity: "120", unit: "ROUND", pricingKind: "PER_UNIT" },
    ],
  };
  const projected = projectFrozenInventory(snapshot, new Map([["item_haff", "哈夫币"]]));
  assert.deepEqual(projected, [
    { itemId: "item_haff", quantity: "5000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", name: "哈夫币" },
    { itemId: "item_ammo", quantity: "120", unit: "ROUND", pricingKind: "PER_UNIT", name: null },
  ]);
  assert.equal(JSON.stringify(projected).includes("9.99"), false, "no buyer/owner amounts leak into the inventory projection");
  assert.equal(JSON.stringify(projected).includes("buyerAmount"), false);
});

test("frozen inventory projection rejects malformed or unknown lines instead of guessing", () => {
  assert.deepEqual(projectFrozenInventory(null, new Map()), []);
  assert.deepEqual(projectFrozenInventory({ lines: "not-an-array" }, new Map()), []);
  assert.deepEqual(projectFrozenInventory({ lines: [null, { itemId: "only-id" }, { itemId: "bad id", quantity: "1", unit: "ROUND", pricingKind: "PER_UNIT" }, { itemId: "ok", quantity: "-1", unit: "ROUND", pricingKind: "PER_UNIT" }, { itemId: "ok2", quantity: "1.5", unit: "ROUND", pricingKind: "PER_UNIT" }] }, new Map()), []);
  assert.deepEqual(projectFrozenInventory({ lines: [] }, new Map()), []);
});
