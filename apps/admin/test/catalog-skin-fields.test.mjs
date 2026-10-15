import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceFields, skinValues } from "../src/views/catalog-skin-fields.ts";

// 北京时间 2026-10-14 00:30 = UTC 2026-10-13 16:30：UTC 切片会把“今日”填成前一天。
const beijingMidnight = Date.UTC(2026, 9, 13, 16, 30);
const evidence = (over = {}) => ({ reason: "核对隐藏皮肤身份", evidenceUrls: "https://example.com/a", region: "中国大陆", note: "官方页面截图", ...over });

test("F5 evidence date defaults to the Beijing calendar day, not the UTC one", t => {
  t.mock.timers.enable({ apis: ["Date"], now: beijingMidnight });
  assert.equal(skinValues().observedAt, "2026-10-14", "the prefilled day matches 「今日」 in Beijing time");
  assert.equal(evidenceFields(evidence({ observedAt: "" })).evidenceRefs[0].observedAt, "2026-10-14");
});

test("F5 an explicit operator date is preserved and invalid dates are refused", () => {
  assert.equal(evidenceFields(evidence({ observedAt: "2026-09-01" })).evidenceRefs[0].observedAt, "2026-09-01", "a hand-edited date is never overwritten by today");
  for (const observedAt of ["2026-02-30", "2026-13-01", "not-a-date"]) {
    assert.throws(() => evidenceFields(evidence({ observedAt })), /核对日期/, observedAt);
  }
});
