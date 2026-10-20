import assert from "node:assert/strict";
import { test } from "node:test";
import { fundingPolicyFixture } from "../../api/test/funding-authority-fixtures.ts";
import { buildSkinDepositPolicy, depositCentsToYuan, depositYuanToCents, skinDepositDraft, skinDepositIssues, skinDepositSaveBody } from "../src/views/supply-rules/skin-deposit-policy.ts";

test("new skin policy starts unconfigured and preserves every non-skin policy field", () => {
  const base = fundingPolicyFixture("NOT_REQUIRED"), original = structuredClone(base), draft = skinDepositDraft(base);
  assert.equal(draft.policyVersion, "");
  assert.deepEqual(draft.rules.map(row => [row.first, row.subsequent]), [["", ""], ["", ""], ["", ""]]);
  assert.ok(skinDepositIssues(draft).length > 0);
  draft.policyVersion = "synthetic-v2";
  const built = buildSkinDepositPolicy(base, draft);
  assert.equal(built.recommendation.parameters.skinRules[0].firstCents, null);
  assert.equal(Object.hasOwn(built.recommendation.parameters, "skinWeights"), false);
  assert.equal(Object.hasOwn(built.recommendation.parameters, "skinGroupById"), false);
  for (const key of Object.keys(base).filter(key => !["recommendation", "policyVersion"].includes(key))) assert.deepEqual(built[key], base[key], key);
  for (const key of ["safeBoxWeightsByCode", "vitalityAtLeast7Cents", "bearAtLeast7Cents", "diveAtLeast3Cents", "rounding", "upperLimitCents"]) assert.deepEqual(built.recommendation.parameters[key], base.recommendation.parameters[key]);
  assert.deepEqual(base, original);
});

test("deposit editing keeps zero distinct from blank, uses exact cents and rejects invalid input", () => {
  for (const [cents, yuan] of [["0", "0"], ["1", "0.01"], ["10", "0.1"], ["1010", "10.1"], ["999999999999999999999999", "9999999999999999999999.99"]]) {
    assert.equal(depositCentsToYuan(cents), yuan); assert.equal(depositYuanToCents(yuan), cents);
  }
  assert.equal(depositYuanToCents(""), null); assert.equal(depositCentsToYuan(null), "");
  for (const value of ["-1", "1e3", "0.001", "01", "NaN", "99999999999999999999999.99"]) assert.throws(() => depositYuanToCents(value));
  const base = fundingPolicyFixture("NOT_REQUIRED"), draft = skinDepositDraft(base);
  draft.policyVersion = "synthetic-v2"; draft.rules.forEach(row => { row.first = "0"; row.subsequent = "0"; });
  assert.deepEqual(skinDepositIssues(draft), []);
  const policy = buildSkinDepositPolicy(base, draft); assert.equal(policy.recommendation.parameters.skinRules[0].firstCents, "0");
  assert.deepEqual(skinDepositDraft(policy), draft);
  draft.rules.push({ ...draft.rules[0] }); assert.match(skinDepositIssues(draft).join(), /重复/);
});

test("policy-only updates omit other price fields; new drafts copy complete existing member price lines", () => {
  const target = { id: "draft", revision: "1", mode: "SPREAD", haffRule: null }, base = { id: "base", mode: "SPREAD", haffRule: { schema: "fixture" }, commissionRate: null, roundingPolicy: "HALF_UP_CENT_V1" }, policy = fundingPolicyFixture("NOT_REQUIRED");
  const rules = { priceLines: ["STANDARD", "VIP", "SVIP", "DISCOUNT_USER"].map(customerTier => ({ priceVersionId: "base", customerTier, itemId: "item", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "1.25", ownerUnitAmount: "1.00" })) };
  const body = skinDepositSaveBody(rules, target, base, policy);
  assert.equal(body.lines.length, 4); assert.deepEqual(body.lines.map(line => line.customerTier), ["STANDARD", "VIP", "SVIP", "DISCOUNT_USER"]);
  assert.deepEqual(body.haffRule, base.haffRule);
  rules.priceLines.push({ ...rules.priceLines[0], priceVersionId: "draft" });
  assert.deepEqual(skinDepositSaveBody(rules, target, base, policy), { expectedRevision: "1", fundingPolicy: policy });
});
