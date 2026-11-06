import assert from "node:assert/strict";
import test from "node:test";
import { assertGrowthScopePartition } from "./local-growth-plan.mjs";

const scope = (retained, excluded) => ({
  schema: "zzsh.selected-business-scope.v1",
  write: { accounts: [], orders: retained },
  excludedKeys: { accounts: [], orders: excluded },
});
const order = (id, payIs = "0") => ({ id, pay_is: payIs });

test("a scope keeps only the retained orders and lists every exclusion by key", () => {
  const all = [order("1", "1"), order("2", "0"), order("3", "1")];
  const result = assertGrowthScopePartition(all, scope(["1", "3"], ["2"]));
  assert.deepEqual(result.orders.map(row => row.id), ["1", "3"]);
  assert.deepEqual(result.excluded, ["2"]);
});

test("without a scope every source order stays, so a legacy round is unchanged", () => {
  const all = [order("1", "1"), order("2", "0")];
  const result = assertGrowthScopePartition(all, undefined);
  assert.deepEqual(result.orders.map(row => row.id), ["1", "2"]);
  assert.deepEqual(result.excluded, []);
});

test("an order that is neither retained nor excluded stops the round", () => {
  const all = [order("1", "1"), order("2", "0"), order("3", "0")];
  assert.throws(() => assertGrowthScopePartition(all, scope(["1"], ["2"])), /GROWTH_SCOPE_PARTITION_INCOMPLETE:3/);
});

test("a scope that drops a paid order is refused instead of losing its consumption", () => {
  const all = [order("1", "1"), order("2", "1")];
  assert.throws(() => assertGrowthScopePartition(all, scope(["1"], ["2"])), /GROWTH_EXCLUDED_ORDER_WAS_PAID:2/);
});

test("a scope larger than the source is refused", () => {
  const all = [order("1", "1")];
  assert.throws(() => assertGrowthScopePartition(all, scope(["1", "9"], [])), /GROWTH_SCOPE_PARTITION_INCOMPLETE/);
});

test("an unknown scope schema is refused rather than silently ignored", () => {
  assert.throws(() => assertGrowthScopePartition([order("1", "1")], { schema: "other", write: { orders: [] }, excludedKeys: { orders: [] } }), /GROWTH_SCOPE_SCHEMA_INVALID/);
});
