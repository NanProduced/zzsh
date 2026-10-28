import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingMatches, draftTrialRequest } from "../src/views/supply-rules/rental-mode-trial.ts";

const haff = (fast) => ({ schema: "haff-ratio-v2", baseBySafeBox: { S6: "10" }, vitalityDeltaByLevel: { "7": "0" }, bearDeltaByLevel: { "7": "0" }, dailyDeltaByTermOption: {}, compatibility: { ordinary: { spreadDelta: "4", discounts: {} }, fast: { spreadDelta: "12", discounts: {} }, modes: { ordinary: { enabled: true }, custom: { enabled: false }, fast } } });
const rules = { release: { termVersionId: "term_1", priceVersionId: "price_cur" }, termOptions: [{ versionId: "term_1", code: "D3" }, { versionId: "old", code: "D7" }], items: [{ id: "item_haff", enabled: true, unit: "HAFF_BASE" }] };
const draft = (fast = { enabled: true, min: { base: "C", value: "6" } }) => ({ id: "price_draft", status: "DRAFT", revision: "4", haffRule: haff(fast) });
const input = { ownerRatioB: "18", haffM: "100", box: "S6", vit: "7", bear: "7", term: "D3" };

test("请求绑定草稿 id/revision、fast 模式、B、库存与当前消耗档版本", () => {
  const r = draftTrialRequest(rules, draft(), input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { priceVersionId: "price_draft", expectedRevision: "4", termVersionId: "term_1", conditions: { safeBoxCode: "S6", vitLevel: 7, bearLevel: 7, termOptionCode: "D3", rentalPricing: { rentalMode: "fast", ownerRatioB: "18" } }, inventory: [{ itemId: "item_haff", quantity: "100000000" }] });
  assert.notEqual(draftTrialRequest(rules, draft(), { ...input, ownerRatioB: "17" }).signature, r.signature, "改 B 即失效");
  assert.notEqual(draftTrialRequest(rules, { ...draft(), revision: "5" }, input).signature, r.signature, "改修订即失效");
});

test("拒绝：非草稿、未启用极速、B 非法、旧消耗档版本", () => {
  assert.equal(draftTrialRequest(rules, { ...draft(), status: "PUBLISHED" }, input).ok, false);
  assert.ok(draftTrialRequest(rules, draft({ enabled: false }), input).errors.version);
  for (const b of ["", "0", "-1", "1.123456789", "abc"]) assert.ok(draftTrialRequest(rules, draft(), { ...input, ownerRatioB: b }).errors.ownerRatioB, b);
  assert.ok(draftTrialRequest(rules, draft(), { ...input, term: "D7" }).errors.term);
});

test("回执 binding 逐项比对；B 按数值等价", () => {
  const { expected } = draftTrialRequest(rules, draft(), input);
  assert.ok(bindingMatches({ ...expected, ownerRatioB: "18.00000000" }, expected));
  assert.equal(bindingMatches({ ...expected, priceVersionRevision: "3" }, expected), false);
  assert.equal(bindingMatches({ ...expected, rentalMode: "ordinary" }, expected), false);
  assert.equal(bindingMatches({ ...expected, ownerRatioB: "17" }, expected), false);
  assert.equal(bindingMatches({ ...expected, inventory: [] }, expected), false);
  assert.equal(bindingMatches(undefined, expected), false);
});