import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeOrderReference, parseOrderReference, orderReferenceSummary } from "../../../packages/im-client/src/order-reference.ts";
const order = { id: "order-1", displayNo: "ZZ20261101-00001", title: "三角洲账号", party: "renter" };
test("order reference round trips a bounded reference and caption without quote facts", () => {
  const wire = encodeOrderReference({ ...order, amount: "untrusted", url: "https://bad.invalid" }, " 请核对 \n这笔订单 ");
  assert.deepEqual(parseOrderReference(wire), { order, caption: "请核对 \n这笔订单" });
  assert.doesNotMatch(wire, /untrusted|bad.invalid/);
  assert.equal(orderReferenceSummary(wire), "[订单] 三角洲账号 · ZZ20261101-00001");
});
test("malformed, unknown-version and unsafe order references never become a navigable card", () => {
  for (const patch of [{ id: "../users/private" }, { id: "javascript:bad" }, { title: "\n伪造" }, { party: "admin" }, { title: "x".repeat(241) }]) {
    assert.throws(() => encodeOrderReference({ ...order, ...patch }));
    assert.equal(parseOrderReference("【关联订单卡】" + JSON.stringify({ version: 1, ...order, ...patch })), null);
  }
  assert.equal(parseOrderReference("【关联订单卡】" + JSON.stringify({ version: 2, ...order })), null);
  assert.equal(parseOrderReference("【关联订单卡】{"), null);
  assert.throws(() => encodeOrderReference(order, "x".repeat(4000)));
  assert.equal(orderReferenceSummary("普通消息"), "普通消息");
  assert.equal(orderReferenceSummary("【关联订单卡】{\"version\":"), "[订单]");
});
