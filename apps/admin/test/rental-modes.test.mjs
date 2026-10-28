import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRentalModeRule, legacyNonZero, rentalModeDraft, rentalModeIssues, withFastDefaults } from "../src/views/supply-rules/rental-modes.ts";

// 合成的 haff-ratio-v2：极速关闭且无 lane，模拟现网 v1 规则
const base = () => ({ schema: "haff-ratio-v2", compatibility: { ordinary: { spreadDelta: "4" }, modes: { ordinary: { enabled: true }, custom: { enabled: true, min: { base: "C", value: "-2" }, max: { base: "C", value: "10" } }, fast: { enabled: false } } } });

test("读取不补默认；极速默认只在显式新建时套用，且不写上限、档位增量为 0", () => {
  const b = base(), d = rentalModeDraft(b);
  assert.equal(d.fast.enabled, false); assert.equal(d.fast.spreadDelta, ""); assert.equal(d.fast.min.value, "");
  const f = withFastDefaults(d);
  assert.deepEqual([f.fast.enabled, f.fast.spreadDelta, f.fast.min, f.fast.max.value], [true, "12", { base: "C", value: "6" }, ""]);
  assert.ok(Object.values(f.fast.legacyDiscounts).every(v => v === "0"));
  assert.ok(Object.isFrozen(f.fast.legacyDiscounts), "旧档位增量只读");
  assert.deepEqual(rentalModeIssues(f), {});
  const rule = buildRentalModeRule(b, f);
  assert.deepEqual(rule.compatibility.modes.fast, { enabled: true, min: { base: "C", value: "6" } });
  assert.equal("max" in rule.compatibility.modes.fast, false);
  assert.equal(rule.compatibility.fast.spreadDelta, "12");
  assert.deepEqual(rule.compatibility.modes.custom, b.compatibility.modes.custom);
  assert.deepEqual(b, base(), "基线不被修改");
});

test("校验：启用缺下限、上限小于下限、小数位超限都拦截（旧档位增量不再可编辑）", () => {
  const f = withFastDefaults(rentalModeDraft(base()));
  assert.ok(rentalModeIssues({ ...f, fast: { ...f.fast, min: { base: "C", value: "" } } })["fast.min"]);
  assert.ok(rentalModeIssues({ ...f, fast: { ...f.fast, max: { base: "C", value: "5" } } })["fast.max"]);
  assert.ok(rentalModeIssues({ ...f, fast: { ...f.fast, spreadDelta: "1.123456789" } })["fast.spreadDelta"]);
});

test("关闭模式只翻转启停并保留原界值", () => {
  const d = rentalModeDraft(base()); d.custom.enabled = false;
  assert.deepEqual(buildRentalModeRule(base(), d).compatibility.modes.custom, { enabled: false, min: { base: "C", value: "-2" }, max: { base: "C", value: "10" } });
  assert.equal("fast" in buildRentalModeRule(base(), d).compatibility, false, "极速关闭时不凭空合成 lane");
});

test("R4：已有非零旧档位增量原样保留且只读，不被静默清零；新建默认为 0", () => {
  const b = base(); b.compatibility.fast = { spreadDelta: "12", discounts: { STANDARD: "0", VIP: "2", SVIP: "3", DISCOUNT_USER: "1" } }; b.compatibility.modes.fast = { enabled: true, min: { base: "C", value: "6" } };
  const d = rentalModeDraft(b);
  assert.ok(legacyNonZero(d).length === 3);
  assert.throws(() => { d.fast.legacyDiscounts.VIP = "0"; });
  assert.deepEqual(buildRentalModeRule(b, d).compatibility.fast.discounts, b.compatibility.fast.discounts);
  assert.deepEqual(buildRentalModeRule(base(), withFastDefaults(rentalModeDraft(base()))).compatibility.fast.discounts, { STANDARD: "0", VIP: "0", SVIP: "0", DISCOUNT_USER: "0" });
});