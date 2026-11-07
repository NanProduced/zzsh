import assert from "node:assert/strict";
import test from "node:test";
import { planSelectedBusinessScope, selectedScopeDigest } from "./selected-business-scope.mjs";

const account = (id, over = {}) => ({ id, status: "4", is_delete: "0", ...over });
const order = (id, accountId, over = {}) => ({ id, accounts_id: accountId, pay_is: "0", ...over });
const pay = (orderId, payIs, over = {}) => ({ id: "p" + orderId, order_id: orderId, order_type: "1", pay_is: payIs, ...over });

test("a listed account is kept even with no order or only unpaid orders", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1", { status: "3" }), account("a2")],
    orders: [order("o1", "a1")],
    pays: [pay("o1", "0")],
  });
  assert.deepEqual(scope.write.accounts, ["a1"]);
  assert.deepEqual(scope.excludedKeys.accounts, ["a2"]);
  assert.deepEqual(scope.write.orders, []);
});

test("an account with a paid order is kept and its unpaid orders stay out", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1", { pay_is: "1" }), order("o2", "a1")],
    pays: [pay("o1", "1"), pay("o2", "0")],
  });
  assert.deepEqual(scope.write.accounts, ["a1"]);
  assert.deepEqual(scope.write.orders, ["o1"]);
  assert.deepEqual(scope.excludedKeys.orders, ["o2"]);
});

test("a paid-then-cancelled order is retained because the money moved", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1", { pay_is: "1", order_status: "5" })],
    pays: [pay("o1", "1")],
  });
  assert.deepEqual(scope.write.orders, ["o1"]);
});

test("an unpaid order with failed attempts is excluded, not isolated and not queried", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1")],
    pays: [pay("o1", "0"), pay("o1", "0")],
  });
  assert.deepEqual(scope.excludedKeys.orders, ["o1"]);
  assert.equal(scope.partition.orders.conflicts.count, 0);
  // Its account has no retained rental money and is not listed, so it goes too.
  assert.deepEqual(scope.excludedKeys.accounts, ["a1"]);
  assert.equal(scope.policy.channelLookup, "NOT_PERFORMED");
  assert.equal(scope.policy.unpaidWithFailedAttempts, "EXCLUDED");
});

test("a type-1 payment with a paid marker keeps an order the order row calls unpaid", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1", { pay_is: "0" })],
    pays: [pay("o1", "1")],
  });
  assert.deepEqual(scope.write.orders, ["o1"]);
  assert.deepEqual(scope.conflictKeys.orders, ["o1"]);
  assert.deepEqual(scope.conflictKeys.paymentPaidOrderUnpaid, ["o1"]);
  assert.equal(scope.partition.orders.paymentPaidOrderUnpaid.count, 1);
  assert.equal(scope.partition.orders.orderPaidPaymentUnconfirmed.count, 0);
});

test("an order marked paid without a successful rental payment is excluded and counted as a conflict", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1", { pay_is: "1" })],
    pays: [pay("o1", "0")],
  });
  assert.deepEqual(scope.write.orders, []);
  assert.deepEqual(scope.excludedKeys.orders, ["o1"]);
  assert.deepEqual(scope.excludedKeys.accounts, ["a1"]);
  assert.deepEqual(scope.conflictKeys.orders, ["o1"]);
  assert.deepEqual(scope.conflictKeys.orderPaidPaymentUnconfirmed, ["o1"]);
  assert.equal(scope.partition.orders.orderPaidPaymentUnconfirmed.count, 1);
  assert.equal(scope.partition.orders.paymentPaidOrderUnpaid.count, 0);
  assert.equal(scope.policy.orderPaidWithoutPayment, "EXCLUDED");
});

test("a listed account survives an excluded payment conflict, and another paid order keeps its own account", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("listed", { status: "3" }), account("mixed")],
    orders: [order("unpaid-listed", "listed", { pay_is: "1" }), order("unpaid-mixed", "mixed", { pay_is: "1" }), order("paid", "mixed")],
    pays: [pay("unpaid-listed", "0"), pay("unpaid-mixed", "1", { order_type: "2" }), pay("paid", "1")],
  });
  assert.deepEqual(scope.write.accounts, ["listed", "mixed"]);
  assert.deepEqual(scope.write.orders, ["paid"]);
  assert.deepEqual(scope.excludedKeys.orders, ["unpaid-listed", "unpaid-mixed"]);
  assert.deepEqual(scope.conflictKeys.orderPaidPaymentUnconfirmed, ["unpaid-listed", "unpaid-mixed"]);
});

test("the old listing deposit can never make an order look paid", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1")],
    orders: [order("o1", "a1")],
    pays: [pay("o1", "1", { order_type: "2" })],
  });
  assert.deepEqual(scope.excludedKeys.orders, ["o1"]);
  assert.equal(scope.partition.orders.conflicts.count, 0);
});

test("the partition is disjoint and covers the source", () => {
  const scope = planSelectedBusinessScope({
    accounts: [account("a1", { status: "3" }), account("a2"), account("a3")],
    orders: [order("o1", "a1"), order("o2", "a2", { pay_is: "1" }), order("o3", "a3")],
    pays: [pay("o2", "1")],
  });
  for (const domain of ["accounts", "orders"]) {
    const seen = new Set();
    const lists = domain === "accounts"
      ? [scope.write.accounts, scope.excludedKeys.accounts]
      : [scope.write.orders, scope.excludedKeys.orders];
    for (const list of lists) for (const id of list) {
      assert.ok(!seen.has(id), `${domain}:${id} appears twice`);
      seen.add(id);
    }
    assert.equal(seen.size, scope.totals[domain]);
    assert.equal(scope.closure[domain].complete, true);
  }
});

test("duplicate or missing source keys are refused instead of silently merged", () => {
  assert.throws(() => planSelectedBusinessScope({ accounts: [account("a1"), account("a1")], orders: [], pays: [] }), /ACCOUNT_KEY_DUPLICATE/);
  assert.throws(() => planSelectedBusinessScope({ accounts: [{ status: "4" }], orders: [], pays: [] }), /ACCOUNT_KEY_INVALID/);
  assert.throws(() => planSelectedBusinessScope({ accounts: [], orders: [order("o1", "a1"), order("o1", "a1")], pays: [] }), /ORDER_KEY_DUPLICATE/);
  assert.throws(() => planSelectedBusinessScope({ accounts: [], orders: [] }), /SELECTED_SCOPE_SOURCE_INVALID/);
});

test("the digest is stable for the same source and changes with the partition", () => {
  const source = { accounts: [account("a1")], orders: [order("o1", "a1", { pay_is: "1" })], pays: [pay("o1", "1")] };
  assert.equal(selectedScopeDigest(planSelectedBusinessScope(source)), selectedScopeDigest(planSelectedBusinessScope(source)));
  const changed = { ...source, orders: [order("o1", "a1")] };
  assert.notEqual(selectedScopeDigest(planSelectedBusinessScope(source)), selectedScopeDigest(planSelectedBusinessScope(changed)));
});
