import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRentalModeRule, rentalModeDraft, rentalModeIssues, withFastDefaults } from "../src/views/supply-rules/rental-modes.ts";

// 合成的 haff-ratio-v2：极速关闭且无 lane，模拟现网 v1 规则
const base = () => ({ schema: "haff-ratio-v2", compatibility: { ordinary: { spreadDelta: "4" }, modes: { ordinary: { enabled: true }, custom: { enabled: true, min: { base: "C", value: "-2" }, max: { base: "C", value: "10" } }, fast: { enabled: false } } } });

test("读取不补默认；极速默认只在显式新建时套用，且不写上限、档位增量为 0", () => {
  const b = base(), d = rentalModeDraft(b);
  assert.equal(d.fast.enabled, false); assert.equal(d.fast.spreadDelta, ""); assert.equal(d.fast.min.value, "");
  const f = withFastDefaults(d);
  assert.deepEqual([f.fast.enabled, f.fast.spreadDelta, f.fast.min, f.fast.max.value], [true, "12", { base: "C", value: "6" }, ""]);
  assert.ok(Object.values(f.fast.discounts).every(v => v === "0"));
  assert.deepEqual(rentalModeIssues(f), {});
  const rule = buildRentalModeRule(b, f);
  assert.deepEqual(rule.compatibility.modes.fast, { enabled: true, min: { base: "C", value: "6" } });
  assert.equal("max" in rule.compatibility.modes.fast, false);
  assert.equal(rule.compatibility.fast.spreadDelta, "12");
  assert.deepEqual(rule.compatibility.modes.custom, b.compatibility.modes.custom);
  assert.deepEqual(b, base(), "基线不被修改");
});

test("校验：启用缺下限、上限小于下限、增量超过利润点、普通档非 0 都拦截", () => {
  const f = withFastDefaults(rentalModeDraft(base()));
  assert.ok(rentalModeIssues({ ...f, fast: { ...f.fast, min: { base: "C", value: "" } } })["fast.min"]);
  assert.ok(rentalModeIssues({ ...f, fast: { ...f.fast, max: { base: "C", value: "5" } } })["fast.max"]);
  assert.ok(rentalModeIssues({ ...f, fast: { ...f.fast, discounts: { ...f.fast.discounts, VIP: "13" } } })["fast.discounts.VIP"]);
  assert.ok(rentalModeIssues({ ...f, fast: { ...f.fast, discounts: { ...f.fast.discounts, STANDARD: "1" } } })["fast.discounts.STANDARD"]);
  assert.ok(rentalModeIssues({ ...f, fast: { ...f.fast, spreadDelta: "1.123456789" } })["fast.spreadDelta"]);
});

test("关闭模式只翻转启停并保留原界值", () => {
  const d = rentalModeDraft(base()); d.custom.enabled = false;
  assert.deepEqual(buildRentalModeRule(base(), d).compatibility.modes.custom, { enabled: false, min: { base: "C", value: "-2" }, max: { base: "C", value: "10" } });
  assert.equal("fast" in buildRentalModeRule(base(), d).compatibility, false, "极速关闭时不凭空合成 lane");
});
