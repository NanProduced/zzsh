import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertGrowthScopePartition, buildLocalGrowthPlan } from "./local-growth-plan.mjs";
import { SELECTED_SCOPE_POLICY } from "./selected-business-scope.mjs";

const scope = (retained, excluded) => ({
  schema: "zzsh.selected-business-scope.v1", policy: SELECTED_SCOPE_POLICY,
  write: { accounts: [], orders: retained }, excludedKeys: { accounts: [], orders: excluded },
});
const order = (id, payIs = "0") => ({ id, pay_is: payIs });
const pay = (orderId, payIs = "1", orderType = "1") => ({ order_id: orderId, pay_is: payIs, order_type: orderType });

test("the selected scope follows successful rental payment, including both marker mismatches", () => {
  const all = [order("1", "1"), order("2", "1"), order("3", "0"), order("4", "0")];
  const result = assertGrowthScopePartition(all, scope(["1", "3"], ["2", "4"]), [pay("1"), pay("2", "0"), pay("3"), pay("4", "1", "2")]);
  assert.deepEqual(result.orders.map(row => row.id), ["1", "3"]);
  assert.deepEqual(result.excluded, ["2", "4"]);
});

test("without a scope every source order stays", () => {
  const all = [order("1", "1"), order("2", "0")];
  assert.deepEqual(assertGrowthScopePartition(all, undefined), { orders: all, excluded: [] });
});

test("missing, duplicated, overlapping or unknown scope keys stop the round", () => {
  const all = [order("1"), order("2"), order("3")];
  assert.throws(() => assertGrowthScopePartition(all, scope([], ["1", "2"]), []), /GROWTH_SCOPE_PARTITION_INCOMPLETE:3/);
  assert.throws(() => assertGrowthScopePartition(all, scope(["1"], ["1", "2", "3"]), [pay("1")]), /GROWTH_SCOPE_PARTITION_INCOMPLETE:1/);
  assert.throws(() => assertGrowthScopePartition(all, scope([], ["1", "1", "2", "3"]), []), /GROWTH_SCOPE_PARTITION_INVALID/);
  assert.throws(() => assertGrowthScopePartition(all, scope([], ["1", "2", "3", "9"]), []), /GROWTH_SCOPE_PARTITION_INCOMPLETE/);
});

test("a retained order requires a paid rental payment and an excluded order must have none", () => {
  assert.throws(() => assertGrowthScopePartition([order("1")], scope([], ["1"]), [pay("1")]), /GROWTH_EXCLUDED_ORDER_WAS_PAID:1/);
  assert.throws(() => assertGrowthScopePartition([order("1", "1")], scope(["1"], []), [pay("1", "0")]), /GROWTH_RETAINED_ORDER_HAS_NO_PAID_PAYMENT:1/);
});

test("unknown policy, missing payment input and unknown schema fail closed", () => {
  const valid = scope([], ["1"]);
  assert.throws(() => assertGrowthScopePartition([order("1")], valid), /GROWTH_PAYMENT_SOURCE_MISSING/);
  assert.throws(() => assertGrowthScopePartition([order("1")], { ...valid, policy: {} }, []), /GROWTH_SCOPE_POLICY_CHANGED/);
  assert.throws(() => assertGrowthScopePartition([order("1")], { ...valid, schema: "other" }, []), /GROWTH_SCOPE_SCHEMA_INVALID/);
});

test("a retained payment-marker conflict is passed to growth as unknown rather than unpaid", () => {
  const raw = { id: "1", user_id: "r", sale_user_id: "o", accounts_id: "a", order_status: "4", pay_is: "0" };
  const canonicalize = value => JSON.stringify(value), digest = createHash("sha256").update(canonicalize(raw)).digest("hex");
  const target = { legacyId: "1", sourceSnapshot: raw, sourceDigest: digest, renterUserId: "R", ownerUserId: "O", legacyAccountId: "a", legacyOwnerId: "o", legacyRenterId: "r", sourceOrderStatus: 4, sourcePayStatus: 0, gameId: "g" };
  const modules = {
    canonicalize, growthWindowStartAt: () => "start",
    prepareLegacyGrowthBackfill: () => ({ ok: true, coverageState: "BACKFILL_PENDING", rows: [] }),
    projectLegacyGrowthConsumption: input => {
      const component = JSON.parse(input.origin.components.canonical);
      assert.equal(component.reason, "ORDER_PAYMENT_SOURCE_CONFLICT");
      assert.equal(component.payment.records.length, 1);
      assert.equal(JSON.parse(component.payment.records[0].canonical).pay_is, "1");
      return { knowledge: "UNKNOWN", reason: component.reason };
    },
  };
  const result = buildLocalGrowthPlan({ modules, cohort: [{ sourceId: "r", userId: "R" }, { sourceId: "o", userId: "O" }], orders: [raw], targets: [target], payments: [pay("1")], refunds: [], refundLogs: [], cutoff: "cutoff", lineage: { paymentFileSha256: "p", captureReceiptSha256: "c" }, oldRuleEvidenceRef: "fixture" });
  assert.equal(result.summary.orderKnowledge.UNKNOWN, 1);
  assert.equal(result.unknownSources[0].reason, "ORDER_PAYMENT_SOURCE_CONFLICT");
});

test("new rounds keep their own cutoff and do not inherit the November 3 reason or execution key", () => {
  const modules = {
    canonicalize: value => JSON.stringify(value),
    growthWindowStartAt: () => "2026-08-13T00:00:00.000000Z",
    prepareLegacyGrowthBackfill: () => ({ ok: true, coverageState: "BACKFILL_PENDING", rows: [] }),
  };
  const input = {
    modules, cohort: [{ sourceId: "1", userId: "user_fixture" }], orders: [], targets: [],
    payments: [], refunds: [], refundLogs: [], cutoff: "2026-11-11T00:00:00.000000Z",
    lineage: { captureReceiptSha256: "a".repeat(64) }, oldRuleEvidenceRef: "fixture",
  };
  const previous = buildLocalGrowthPlan(input).packages[0];
  const explicitPrevious = buildLocalGrowthPlan({ ...input, isNextMigration: false }).packages[0];
  const next = buildLocalGrowthPlan({ ...input, isNextMigration: true }).packages[0];
  const oldBusiness = JSON.parse(previous.bytes), newBusiness = JSON.parse(next.bytes);
  assert.equal(previous.bytes, explicitPrevious.bytes);
  assert.equal(previous.executionKey, explicitPrevious.executionKey);
  assert.equal(oldBusiness.reason, "本地Nov3完整旧源租赁消费按正式90天成长合同承接；不产生资金分录或旧等级礼遇");
  assert.match(previous.executionKey, /^nov3-growth-[a-f0-9]{48}$/);
  assert.doesNotMatch(newBusiness.reason, /Nov3|11月3日/i);
  assert.match(next.executionKey, /^legacy-growth-[a-f0-9]{48}$/);
  assert.equal(newBusiness.source.receipt.cutoff, input.cutoff);
  assert.deepEqual(newBusiness.source, oldBusiness.source);
  assert.equal(buildLocalGrowthPlan({ ...input, isNextMigration: true }).packages[0].bytes, next.bytes);
  const newer = buildLocalGrowthPlan({ ...input, cutoff: "2026-11-12T00:00:00.000000Z", isNextMigration: true }).packages[0];
  assert.notEqual(newer.executionKey, next.executionKey);
  assert.throws(() => buildLocalGrowthPlan({ ...input, isNextMigration: "true" }), /GROWTH_MIGRATION_PROFILE_INVALID/);
});
