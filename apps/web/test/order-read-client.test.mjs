import assert from "node:assert/strict";
import { test } from "node:test";

const { formatOrderMoney, formatOrderTime, mergeOrderItems, orderApi, OrderRequestError } = await import("../src/lib/order-client.ts");

test("order times use the declared timezone and refuse missing or invalid dates", () => {
  assert.match(formatOrderTime("2026-10-01T00:30:00Z"), /08:30/);
  assert.match(formatOrderTime("2026-10-01T00:30:00Z"), /GMT\+08:00/);
  assert.equal(formatOrderTime(undefined), "时间暂不可用");
  assert.equal(formatOrderTime("not-a-date"), "时间暂不可用");
});

test("money rendering preserves zero and refuses unknown values", () => {
  assert.equal(formatOrderMoney({ amount: "0.00", currency: "CNY" }), "0.00 元");
  assert.equal(formatOrderMoney({ amount: "12.3", currency: "CNY" }), "待确认");
  assert.equal(formatOrderMoney({ amount: "12.30" }), "待确认");
  assert.equal(formatOrderMoney(null), "待确认");
});

test("cursor pages append by id while accepting the newest projection", () => {
  assert.deepEqual(mergeOrderItems([{ id: "a", status: "PAID" }, { id: "b", status: "CANCELLED" }], [{ id: "b", status: "COMPLETED" }, { id: "c", status: "PAID" }]).map((item) => [item.id, item.status]), [["a", "PAID"], ["b", "COMPLETED"], ["c", "PAID"]]);
});

test("order read client keeps party, filters, cursor, and same-origin no-store GETs", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json({ items: [], nextCursor: "cursor-next", limit: 3 });
  };
  try {
    const page = await orderApi.list({ party: "owner", status: "PAID", accountId: "acct_1", limit: 3, cursor: "cursor-1" });
    assert.equal(page.nextCursor, "cursor-next");
    assert.equal(requests[0].input, "/api/orders?party=owner&limit=3&status=PAID&accountId=acct_1&cursor=cursor-1");
    assert.equal(requests[0].init.method, undefined);
    assert.equal(requests[0].init.credentials, "same-origin");
    assert.equal(requests[0].init.cache, "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("order detail unwraps the read envelope and encodes the id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/orders/order%2Fprivate");
    return Response.json({ order: { id: "order/private", status: "COMPLETED" } });
  };
  try {
    assert.deepEqual(await orderApi.detail("order/private"), { id: "order/private", status: "COMPLETED" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read failures preserve status and API error code without exposing write recovery", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { code: "CONFLICT", message: "cursor changed" } }, { status: 409 });
  try {
    await assert.rejects(() => orderApi.list({ party: "renter" }), (error) => {
      assert.ok(error instanceof OrderRequestError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "CONFLICT");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
