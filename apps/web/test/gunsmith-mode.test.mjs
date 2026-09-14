import assert from "node:assert/strict";
import { test } from "node:test";
import { modeLabelText } from "../src/lib/gunsmith-mode.ts";

test("gunsmith mode labels do not infer GENERAL from an absent mode", () => {
  assert.equal(modeLabelText("HAZARD"), "烽火地带");
  assert.equal(modeLabelText("BATTLEFIELD"), "全面战场");
  assert.equal(modeLabelText("GENERAL"), "通用");
  assert.equal(modeLabelText(null), "未标注");
});
