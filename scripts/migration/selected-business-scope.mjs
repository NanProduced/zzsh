// The seventh round reads the whole captured source and then keeps a business-selected part of it:
// the rental accounts listed at the cutoff, plus every account that carries real rental money, and
// only the orders that carry that money. Neither existing mode expresses this - the full capture
// demands zero exclusions and the retired scenario sample selects whole subjects - so this module
// partitions accounts and orders and proves the buckets are disjoint and cover the source.
//
// Owner decision (2026-11-05): a legacy order marked unpaid whose type-1 rental payment carries no
// paid marker is excluded as unpaid, even when it has failed payment attempts. Channel state is not
// queried and such an order is not isolated. What still needs checking is a source conflict: one
// marker says paid and the other does not, which must never be silently deleted as unpaid.
import { createHash } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
export const SELECTED_SCOPE_SCHEMA = "zzsh.selected-business-scope.v1";
export const SELECTED_SCOPE_POLICY = Object.freeze({
  listedStatus: "3",
  orderPaidMarker: "pay_is=1",
  paymentKind: "order_type=1",
  unpaidWithFailedAttempts: "EXCLUDED",
  channelLookup: "NOT_PERFORMED",
});

const isListed = account => account?.status === SELECTED_SCOPE_POLICY.listedStatus && account?.is_delete === "0";
const bucket = () => ({ retained: [], excluded: [], conflicts: [] });
const digestOf = ids => sha([...ids].sort().join("\n"));

/**
 * @param {{accounts: object[], orders: object[], pays?: object[]}} source captured source rows
 * @returns a partition whose buckets are disjoint and whose union equals the source key set.
 */
export function planSelectedBusinessScope(source) {
  const accounts = source?.accounts ?? [], orders = source?.orders ?? [], pays = source?.pays ?? [];
  if (!Array.isArray(accounts) || !Array.isArray(orders) || !Array.isArray(pays)) throw new Error("SELECTED_SCOPE_SOURCE_INVALID");

  const accountIds = new Set(), orderIds = new Set();
  for (const account of accounts) {
    if (typeof account?.id !== "string" || !account.id) throw new Error("SELECTED_SCOPE_ACCOUNT_KEY_INVALID");
    if (accountIds.has(account.id)) throw new Error("SELECTED_SCOPE_ACCOUNT_KEY_DUPLICATE");
    accountIds.add(account.id);
  }
  for (const order of orders) {
    if (typeof order?.id !== "string" || !order.id) throw new Error("SELECTED_SCOPE_ORDER_KEY_INVALID");
    if (orderIds.has(order.id)) throw new Error("SELECTED_SCOPE_ORDER_KEY_DUPLICATE");
    orderIds.add(order.id);
  }

  // Only type-1 rental payments prove rental money; type-2 rows are the old listing deposit and are
  // out of scope, so they can never make an order look paid.
  const paidByOrder = new Set(), attemptsByOrder = new Map();
  for (const pay of pays) {
    if (pay?.order_type !== "1") continue;
    const key = pay?.order_id;
    if (typeof key !== "string" || !key) continue;
    if (!attemptsByOrder.has(key)) attemptsByOrder.set(key, 0);
    attemptsByOrder.set(key, attemptsByOrder.get(key) + 1);
    if (pay.pay_is === "1") paidByOrder.add(key);
  }

  const partition = { accounts: bucket(), orders: bucket() };
  partition.orders.paymentPaidOrderUnpaid = [];
  partition.orders.orderPaidPaymentUnconfirmed = [];
  const orderDisposition = new Map();
  for (const order of orders) {
    const marked = order?.pay_is === "1", paidRecord = paidByOrder.has(order.id);
    if (marked || paidRecord) {
      partition.orders.retained.push(order.id);
      orderDisposition.set(order.id, "retained");
      // One side says paid and the other does not: keep the order, but record that the source
      // disagrees instead of letting the weaker marker decide.
      if (marked !== paidRecord) {
        partition.orders.conflicts.push(order.id);
        partition.orders[paidRecord ? "paymentPaidOrderUnpaid" : "orderPaidPaymentUnconfirmed"].push(order.id);
      }
      continue;
    }
    partition.orders.excluded.push(order.id);
    orderDisposition.set(order.id, "excluded");
  }

  const ordersByAccount = new Map();
  for (const order of orders) {
    const key = order?.accounts_id;
    if (typeof key !== "string" || !key) continue;
    if (!ordersByAccount.has(key)) ordersByAccount.set(key, []);
    ordersByAccount.get(key).push(order.id);
  }
  for (const account of accounts) {
    const related = ordersByAccount.get(account.id) ?? [];
    const retained = related.some(id => orderDisposition.get(id) === "retained");
    // A listed account is kept even with no order at all, which is the explicit exception to the
    // "no retained rental money means no account" rule.
    if (isListed(account) || retained) partition.accounts.retained.push(account.id);
    else partition.accounts.excluded.push(account.id);
  }

  const totals = { accounts: accountIds.size, orders: orderIds.size };
  const sealed = {};
  for (const [domain, sets] of Object.entries(partition)) {
    sealed[domain] = {};
    for (const [name, ids] of Object.entries(sets)) sealed[domain][name] = { count: ids.length, digest: digestOf(ids) };
  }
  const closure = {};
  for (const domain of ["accounts", "orders"]) {
    // Conflicts annotate retained orders; only retained and excluded form the partition.
    const sum = sealed[domain].retained.count + sealed[domain].excluded.count;
    if (sum !== totals[domain]) throw new Error("SELECTED_SCOPE_PARTITION_INCOMPLETE:" + domain);
    closure[domain] = { source: totals[domain], partitioned: sum, complete: true };
  }

  return {
    schema: SELECTED_SCOPE_SCHEMA,
    policy: SELECTED_SCOPE_POLICY,
    meaning: "SELECTED_ACCOUNTS_AND_ORDERS_NOT_FULL_SOURCE",
    totals,
    partition: sealed,
    closure,
    write: { accounts: [...partition.accounts.retained].sort(), orders: [...partition.orders.retained].sort() },
    excludedKeys: { accounts: [...partition.accounts.excluded].sort(), orders: [...partition.orders.excluded].sort() },
    conflictKeys: { orders: [...partition.orders.conflicts].sort(), paymentPaidOrderUnpaid: [...partition.orders.paymentPaidOrderUnpaid].sort(),
      orderPaidPaymentUnconfirmed: [...partition.orders.orderPaidPaymentUnconfirmed].sort() },
  };
}

export function selectedScopeDigest(scope) {
  if (scope?.schema !== SELECTED_SCOPE_SCHEMA) throw new Error("SELECTED_SCOPE_INVALID");
  return sha(JSON.stringify({
    schema: scope.schema, policy: scope.policy, totals: scope.totals, partition: scope.partition, closure: scope.closure,
  }));
}

/** The prepare stage filters accounts and orders by this scope; every other domain stays whole. */
export function selectedScopeFilter(scope) {
  if (scope?.schema !== SELECTED_SCOPE_SCHEMA) throw new Error("SELECTED_SCOPE_INVALID");
  const write = { accounts: new Set(scope.write.accounts), orders: new Set(scope.write.orders) };
  return {
    includes(domain, raw) {
      const set = write[domain];
      return set === undefined ? true : set.has(String(raw?.id));
    },
  };
}
