import assert from "node:assert/strict";
import test from "node:test";
import { readPresentation } from "../src/supply/publishing";

test("readPresentation only fills missing snapshot presentation fields", async () => {
  const result = await readPresentation(
    {
      query: async () => ({
        rows: [
          { id: "item-a", code: "current-code", name: "当前目录新名", unit: "DAY" },
          { id: "item-b", code: "current-code-b", name: "当前目录新名B", unit: "PIECE" },
        ],
      }),
    } as never,
    {
      presentation: {
        items: [
          { id: "item-a", name: "审核时旧名", unit: "ROUND" },
          { id: "item-b", code: "snapshot-code-b", name: "审核时旧名B", unit: "HAFF_BASE" },
        ],
        skins: [
          { id: "skin-a", name: "旧皮肤", categoryName: "旧分类" },
          { id: "skin-b", name: "完整旧皮肤", categoryCode: "snapshot-category", categoryName: "完整旧分类" },
        ],
      },
    } as never,
  );

  assert.deepEqual(result.items, [
    { id: "item-a", code: "current-code", name: "审核时旧名", unit: "ROUND" },
    { id: "item-b", code: "snapshot-code-b", name: "审核时旧名B", unit: "HAFF_BASE" },
  ]);
  assert.deepEqual(result.skins, [
    { id: "skin-a", name: "旧皮肤", categoryName: "旧分类" },
    { id: "skin-b", name: "完整旧皮肤", categoryCode: "snapshot-category", categoryName: "完整旧分类" },
  ]);
});

test("readPresentation fills both missing skin category fields without changing existing labels", async () => {
  const result = await readPresentation(
    {
      query: async () => ({ rows: [{ id: "skin-a", categoryCode: "current-category", categoryName: "当前分类" }] }),
    } as never,
    {
      presentation: {
        items: [],
        skins: [{ id: "skin-a", name: "皮肤", categoryName: "审核分类" }],
      },
    } as never,
  );

  assert.deepEqual(result.skins, [{ id: "skin-a", name: "皮肤", categoryName: "审核分类", categoryCode: "current-category" }]);
});
