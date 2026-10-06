import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4291/support" });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Node = browser.Node;
globalThis.Event = browser.Event;
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.CustomEvent = browser.CustomEvent;
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { OrderFulfillmentSection } = await vite.ssrLoadModule("/src/views/im-support-fulfillment.tsx");
after(async () => { await vite.close(); });
beforeEach(() => { browser.localStorage.clear(); });

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}
async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

const frozenInventory = [
  { itemId: "item_haff", quantity: "5000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", name: "哈夫币" },
  { itemId: "item_ammo", quantity: "120", unit: "ROUND", pricingKind: "PER_UNIT", name: "六级弹" },
];
// Real settlement read shape: no frozen inventory (that lives only in the IM slot projection).
const paidNoOpening = { orderId: "order-A", rentalStarted: false, openings: [], settlement: null, ready: false, reasons: ["SETTLEMENT_VERSION_MISSING"] };
const confirmedOpening = { orderId: "order-A", rentalStarted: true, openings: [{ id: "opening_1", versionNo: 1, status: "CONFIRMED", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit, pricingKind: line.pricingKind })) }], settlement: null, ready: false, reasons: ["SETTLEMENT_VERSION_MISSING"] };

function mount() {
  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}
async function render(root, host, props = {}) {
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", frozenInventory, ...props })); });
  await waitFor(() => Boolean(host.querySelector(".im-support-fulfillment")));
}
function find(host, text) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent.includes(text));
}
async function click(host, text) {
  const button = find(host, text);
  assert.ok(button, `button available: ${text}`);
  await act(async () => { button.click(); });
  await settle();
}

test("first opening reads the slot's frozen inventory, not the settlement response", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    if (url.endsWith("/orders/order-A/openings")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);

  const inputs = [...host.querySelectorAll(".im-support-fulfillment-lines input")];
  assert.equal(inputs.length, 2, "frozen inventory slot projection seeds the first opening");
  assert.equal(inputs[0].value, "5000");
  assert.match(host.textContent, /哈夫币/);
  await click(host, "期初代录");
  const write = requests.find((request) => request.method === "POST");
  assert.ok(write, "opening write submitted");
  assert.deepEqual(JSON.parse(write.body), { lines: [{ itemId: "item_haff", quantity: "5000" }, { itemId: "item_ammo", quantity: "120" }] });
  assert.ok(String(write.headers["idempotency-key"] ?? "").startsWith("im_ful_record-opening_order-A_"), "stable intent key attached");
  assert.match(host.textContent, /期初已提交/);
});

test("without the slot projection the section refuses to fake an opening", async (t) => {
  globalThis.fetch = async () => response(paidNoOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host, { frozenInventory: undefined });
  assert.equal(host.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
  assert.match(host.textContent, /未返回订单冻结库存投影/);
  assert.equal(find(host, "期初代录").disabled, true);
});

test("an unknown write keeps the intent; an old identical opening and another version's review never unlock it", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    if (url.endsWith("/orders/order-A/openings")) return response({ error: { code: "INTERNAL_ERROR" } }, 500);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "期初代录");
  assert.match(host.textContent, /操作结果未确认/);
  const firstKey = requests.find((request) => request.method === "POST").headers["idempotency-key"];
  assert.equal(find(host, "期初代录").disabled, true, "primary write stays locked while the result is unknown");

  // A plain GET is observation only: even a historical identical opening must not confirm the request.
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response({ ...confirmedOpening, openings: [{ ...confirmedOpening.openings[0], id: "opening_OLD", status: "DRAFT" }] });
    throw new Error(`unexpected request ${url}`);
  };
  await click(host, "查看当前状态");
  assert.doesNotMatch(host.textContent, /已在服务端确认完成/);
  assert.ok(find(host, "按原请求重放"), "identical historical projection does not resolve the unknown intent");

  // Another version's SUPPORT REVIEW is equally not a receipt for this key.
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response({ ...confirmedOpening, settlement: { id: "settle_other", versionNo: 3, early: true, versionHash: "hash_other", decisions: [{ party: "SUPPORT", action: "REVIEW" }] } });
    throw new Error(`unexpected request ${url}`);
  };
  await click(host, "查看当前状态");
  assert.ok(find(host, "按原请求重放"), "another version's review does not resolve the unknown intent");

  await click(host, "按原请求重放");
  const writes = requests.filter((request) => request.method === "POST");
  assert.equal(writes.length, 2);
  assert.equal(writes[1].headers["idempotency-key"], firstKey, "replay reuses the original key");
  assert.deepEqual(JSON.parse(writes[1].body), JSON.parse(writes[0].body), "replay reuses the original body");
});

test("a replay precondition rejection never pretends the original request did not run", async (t) => {
  let posts = 0;
  let replayStatus = 403;
  let replayBody = { error: { code: "FORBIDDEN", message: "Order Team access denied" } };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") {
      posts += 1;
      if (posts === 1) return response({ error: { code: "INTERNAL_ERROR" } }, 500);
      return response(replayBody, replayStatus);
    }
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "期初代录");
  assert.match(host.textContent, /操作结果未确认/);
  // 403 and a bare 409 CONFLICT come from the replay's own recheck: they say nothing about the original write.
  for (const [status, body] of [[403, { error: { code: "FORBIDDEN" } }], [409, { error: { code: "CONFLICT", message: "ORDER_NOT_SETTLEABLE" } }]]) {
    replayStatus = status; replayBody = body;
    await click(host, "按原请求重放");
    assert.match(host.textContent, /不能证明原请求未执行/, `${status} keeps the unknown responsibility`);
    assert.ok(find(host, "按原请求重放"), `${status} does not release the intent`);
  }
  // The recorded receipt for the original key resolves it: a 409 carrying the original business reasons.
  replayStatus = 409;
  replayBody = { error: { code: "CONFLICT", message: "PAYMENT_BASIS_MISSING" }, reasons: ["PAYMENT_BASIS_MISSING"] };
  await click(host, "按原请求重放");
  assert.match(host.textContent, /PAYMENT_BASIS_MISSING/);
  assert.equal(find(host, "按原请求重放"), undefined, "the recorded receipt releases the intent");
});

test("a business rejection is shown as blocked, not as success", async (t) => {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    if (url.endsWith("/orders/order-A/openings")) return response({ error: { code: "CONFLICT", message: "ORDER_NOT_PAID" }, reasons: ["ORDER_NOT_PAID"] }, 409);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "期初代录");
  assert.match(host.textContent, /ORDER_NOT_PAID/);
  assert.doesNotMatch(host.textContent, /期初已提交/);
  assert.equal(find(host, "期初代录").disabled, false, "a definitive rejection releases the intent");
});

test("an accepted write with a failed readback locks writes until the authoritative state is read", async (t) => {
  const requests = [];
  let settlementReads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) {
      settlementReads += 1;
      if (settlementReads === 1) return response(paidNoOpening);
      if (settlementReads === 2) return response({ error: { code: "INTERNAL_ERROR" } }, 500);
      return response(paidNoOpening);
    }
    if (url.endsWith("/orders/order-A/openings")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "期初代录");
  assert.match(host.textContent, /期初已提交/);
  assert.match(host.textContent, /读取最新状态失败/);
  assert.equal(find(host, "期初代录").disabled, true, "no fresh write while readback is pending");
  assert.equal(find(host, "按原请求重放"), undefined, "accepted writes are never replayed");
  assert.equal(requests.filter((request) => request.method === "POST").length, 1, "no second write after an accepted receipt");
  await click(host, "查看当前状态");
  assert.equal(requests.filter((request) => request.method === "POST").length, 1, "observation still never posts");
  assert.equal(find(host, "期初代录").disabled, false, "authoritative state observed, work resumes");
});

test("accepted-marker storage failure keeps its warning through failed reads without suggesting refresh", async (t) => {
  const originalSetItem = browser.localStorage.setItem;
  let acceptedStorageAttempts = 0;
  Object.defineProperty(browser.localStorage, "setItem", { configurable: true, value: (key, value) => {
    if (JSON.parse(value).accepted === true) {
      acceptedStorageAttempts += 1;
      throw new Error("accepted marker storage unavailable");
    }
    return originalSetItem(key, value);
  } });
  t.after(() => { Object.defineProperty(browser.localStorage, "setItem", { configurable: true, value: originalSetItem }); });
  let posts = 0;
  let reads = 0;
  let readFailureStatus = 500;
  globalThis.fetch = async (input, init = {}) => {
    if (init.method === "POST") { posts += 1; return response(paidNoOpening); }
    if (String(input).endsWith("/orders/order-A/settlement")) {
      reads += 1;
      return reads === 1 ? response(paidNoOpening) : response({ error: { code: "READBACK_FAILED" } }, readFailureStatus);
    }
    throw new Error(`unexpected request ${input}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "期初代录");
  assert.equal(acceptedStorageAttempts, 1, "the original intent persisted, only its accepted marker failed");
  const warning = () => {
    assert.match(host.textContent, /请勿刷新或离开页面，先查看当前状态或联系维护处理/);
    assert.doesNotMatch(host.textContent, /刷新后重试/);
    assert.equal(find(host, "按原请求重放"), undefined, "an accepted request remains GET-only");
    assert.equal(posts, 1);
  };
  warning();
  assert.equal(find(host, "期初代录").disabled, true, "the accepted responsibility keeps new writes locked");
  for (const status of [500, 401, 423]) {
    readFailureStatus = status;
    await click(host, "查看当前状态");
    warning();
    if (status !== 500) assert.equal(host.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
  }
});

test("an accepted receipt survives unmount and only a GET clears it", async (t) => {
  let posts = 0;
  let reads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") { posts += 1; return response(paidNoOpening); }
    if (url.endsWith("/orders/order-A/settlement")) {
      reads += 1;
      return reads === 2 ? response({ error: { code: "INTERNAL_ERROR" } }, 500) : response(paidNoOpening);
    }
    throw new Error(`unexpected request ${url}`);
  };
  let { host, root } = mount();
  await render(root, host);
  await click(host, "期初代录");
  assert.match(host.textContent, /期初已提交/);
  assert.match(host.textContent, /读取最新状态失败/);
  assert.equal(find(host, "按原请求重放"), undefined);
  await act(async () => root.unmount());
  host.remove();

  // Remount: the accepted fact must not degrade into UNKNOWN/replay.
  ({ host, root } = mount());
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(host.textContent, /上次操作已受理/);
  assert.equal(find(host, "按原请求重放"), undefined, "accepted never offers replay after remount");
  assert.equal(find(host, "期初代录").disabled, true, "accepted keeps the write lock");
  assert.equal(posts, 1, "remount issues no second POST");
  await click(host, "查看当前状态");
  assert.equal(posts, 1, "observation still never posts");
  assert.equal(find(host, "期初代录").disabled, false, "the authoritative GET releases the accepted lock");
});

test("a 401/423 readback hides private projections and keeps the accepted receipt", async (t) => {
  for (const status of [401, 423]) {
    let posts = 0;
    let reads = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (init.method === "POST") { posts += 1; return response(paidNoOpening); }
      if (url.endsWith("/orders/order-A/settlement")) {
        reads += 1;
        return reads === 2 ? response({ error: { code: status === 401 ? "UNAUTHENTICATED" : "SESSION_LOCKED" } }, status) : response(paidNoOpening);
      }
      throw new Error(`unexpected request ${url}`);
    };
    let { host, root } = mount();
    await render(root, host);
    await click(host, "期初代录");
    assert.doesNotMatch(host.textContent, /哈夫币/, `${status} hides the private projection immediately`);
    assert.equal(host.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
    assert.ok(find(host, "查看当前状态"), `${status} keeps the accepted responsibility`);
    assert.equal(find(host, "按原请求重放"), undefined);
    await act(async () => root.unmount());
    host.remove();

    // Another administrator cannot see or consume this subject's accepted receipt.
    ({ host, root } = mount());
    await render(root, host, { viewerId: "admin-B" });
    assert.equal(find(host, "查看当前状态"), undefined, `${status} other subject sees no receipt`);
    assert.equal(find(host, "按原请求重放"), undefined);
    assert.equal(find(host, "期初代录").disabled, false, "the other subject starts from their own fresh state");
    assert.equal(posts, 1);
    await act(async () => root.unmount());
    host.remove();

    ({ host, root } = mount());
    await render(root, host);
    assert.equal(find(host, "按原请求重放"), undefined, `${status} remount stays accepted, never UNKNOWN`);
    assert.ok(find(host, "查看当前状态"));
    assert.equal(find(host, "期初代录").disabled, true);
    await click(host, "查看当前状态");
    assert.equal(posts, 1, `${status} recovery is GET-only`);
    assert.equal(find(host, "期初代录").disabled, false);
    await act(async () => root.unmount());
    host.remove();
  }
});

test("plain and observational reads also hide private projections on 401/423", async (t) => {
  let posts = 0;
  let reads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") { posts += 1; return response({ error: { code: "INTERNAL_ERROR" } }, 500); }
    if (url.endsWith("/orders/order-A/settlement")) {
      reads += 1;
      if (reads === 3) return response({ error: { code: "UNAUTHENTICATED" } }, 401);
      return response(paidNoOpening);
    }
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(host.textContent, /哈夫币/, "initial read shows the private projection");
  await click(host, "期初代录");
  assert.match(host.textContent, /操作结果未确认/);
  await click(host, "查看当前状态");
  assert.match(host.textContent, /哈夫币/, "a successful observation may show current facts");
  await click(host, "查看当前状态");
  assert.doesNotMatch(host.textContent, /哈夫币/, "an observational 401 hides the private projection");
  assert.ok(find(host, "按原请求重放"), "the unknown responsibility survives the auth failure");
  assert.equal(posts, 1);
});

test("a late settlement read never refills private data across an order switch", async (t) => {
  let resolveA;
  const orderB = { orderId: "order-B", rentalStarted: true, openings: [{ id: "opening_B", versionNo: 1, status: "CONFIRMED", lines: [{ itemId: "item_haff", quantity: "5000", unit: "HAFF_BASE" }] }], settlement: null };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("order-A")) return new Promise((resolve) => { resolveA = resolve; });
    if (url.includes("order-B")) return response(orderB);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "A", viewerId: "admin-A", frozenInventory })); });
  await settle();
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-B", displayNo: "B", viewerId: "admin-A", frozenInventory })); });
  await waitFor(() => host.textContent.includes("履约中 · 待结算"));
  await act(async () => { resolveA(response(paidNoOpening)); await settle(); });
  assert.match(host.textContent, /履约中 · 待结算/, "the late order-A response cannot replace order-B facts");
  assert.doesNotMatch(host.textContent, /待期初代录/);
});

test("editing while the write is in flight cannot lose the original responsibility", async (t) => {
  let finish;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") return new Promise((resolve) => { finish = resolve; });
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await act(async () => { find(host, "期初代录").click(); });
  await settle();
  const input = host.querySelector(".im-support-fulfillment-lines input");
  assert.equal(input.disabled, true, "edits are locked while sending");
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    finish(response({ error: { code: "INTERNAL_ERROR" } }, 500));
  });
  await settle();
  assert.match(host.textContent, /操作结果未确认/);
  assert.ok(find(host, "按原请求重放"), "late response still leaves the original responsibility");
  assert.equal(find(host, "期初代录").disabled, true);
});

test("an unknown intent survives unmount and remounts under the same key", async (t) => {
  const writes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") { writes.push(init.headers["idempotency-key"]); return response({ error: { code: "INTERNAL_ERROR" } }, 500); }
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  let { host, root } = mount();
  await render(root, host);
  await click(host, "期初代录");
  await act(async () => root.unmount());
  host.remove();

  ({ host, root } = mount());
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(host.textContent, /未确认/);
  assert.equal(find(host, "期初代录").disabled, true, "remount cannot start a fresh write");
  await click(host, "按原请求重放");
  assert.equal(writes.length, 2);
  assert.equal(writes[1], writes[0], "remount replay keeps the original idempotency key");
});

test("auth failure keeps the intent for the same subject and is never consumed by another admin", async (t) => {
  const writes = [];
  let mode = "auth";
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") {
      writes.push(init.headers["idempotency-key"]);
      if (mode === "auth") return response({ error: { code: "UNAUTHORIZED" } }, 401);
      return response(paidNoOpening);
    }
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  let { host, root } = mount();
  await render(root, host);
  await click(host, "期初代录");
  assert.match(host.textContent, /登录状态已变化/);
  assert.doesNotMatch(host.textContent, /哈夫币/, "401/423 hides private projections immediately");
  assert.ok(find(host, "按原请求重放"), "401/423 keeps the original responsibility");
  await act(async () => root.unmount());
  host.remove();

  // Another administrator must not see, replay or clear this subject's responsibility.
  ({ host, root } = mount());
  await render(root, host, { viewerId: "admin-B" });
  assert.equal(find(host, "按原请求重放"), undefined, "cross-identity replay is forbidden");
  assert.equal(find(host, "期初代录").disabled, false, "the other admin keeps their own fresh write");
  assert.equal(writes.length, 1);
  await act(async () => root.unmount());
  host.remove();

  // The original subject recovers the same intent after re-authentication.
  ({ host, root } = mount());
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.ok(find(host, "按原请求重放"), "same subject recovers the unresolved intent");
  mode = "ok";
  await click(host, "按原请求重放");
  assert.equal(writes.length, 2);
  assert.equal(writes[1], writes[0], "auth recovery replays the original key, never a new one");
});

test("preview shows named server amounts and editing invalidates the accepted hash", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response(confirmedOpening);
    if (url.endsWith("/orders/order-A/settlement-preview")) {
      return response({ accepted: false, early: true, amounts: { ownerNet: { currency: "CNY", unit: "yuan", scale: 2, amount: "123.45" }, renterRefund: { currency: "CNY", unit: "yuan", scale: 2, amount: "12.00" } }, versionHash: "hash_preview", baseVersionId: "settle_base" });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  const select = host.querySelector(".im-support-fulfillment-controls select");
  await act(async () => {
    select.value = "TENANT_VOLUNTARY_EARLY";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  await click(host, "生成提前结算预览");
  assert.match(host.textContent, /号主净额/);
  assert.match(host.textContent, /123\.45 元/);
  assert.match(host.textContent, /租客应退/);
  const classify = find(host, "确认分类");
  assert.ok(classify && !classify.disabled, "classify enabled after a preview");
  const input = host.querySelector(".im-support-fulfillment-lines input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
    setter.call(input, "10");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  assert.equal(find(host, "确认分类"), undefined, "editing invalidates the preview hash");
});

test("review binds the landed current version id and hash", async (t) => {
  const requests = [];
  const confirmedEarly = { orderId: "order-A", rentalStarted: true, openings: [{ id: "opening_1", versionNo: 1, status: "CONFIRMED", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit })) }], settlement: { id: "settle_current", versionNo: 2, early: true, versionHash: "hash_current", supersededAt: null, decisions: [{ party: "RENTER", action: "CONFIRM" }, { party: "OWNER", action: "CONFIRM" }] }, frozenInventory, posting: null };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response(confirmedEarly);
    if (url.endsWith("/orders/order-A/settlements/settle_current/review")) return response(confirmedEarly);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(host.textContent, /待客服复核/);
  await click(host, "确认复核");
  const write = requests.find((request) => request.method === "POST");
  assert.ok(write.url.endsWith("/settlements/settle_current/review"));
  assert.deepEqual(JSON.parse(write.body), { versionHash: "hash_current" });
});

test("review stage exposes the current version quantities and amounts for cross-checking", async (t) => {
  const confirmedEarly = { orderId: "order-A", rentalStarted: true, openings: [{ id: "opening_1", versionNo: 1, status: "CONFIRMED", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit })) }], settlement: { id: "settle_current", versionNo: 2, early: true, versionHash: "hash_current", supersededAt: null, inputSnapshot: { lines: [{ itemId: "item_ammo", openingQuantity: "120", remainingQuantity: "40" }] }, computation: { ok: true, early: true, amounts: { ownerNet: { currency: "CNY", unit: "yuan", scale: 2, amount: "123.45" }, renterRefund: { currency: "CNY", unit: "yuan", scale: 2, amount: "12.00" } } }, decisions: [{ party: "RENTER", action: "CONFIRM" }, { party: "OWNER", action: "CONFIRM" }] }, posting: null };
  globalThis.fetch = async () => response(confirmedEarly);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(host.textContent, /待客服复核/);
  const labels = [...host.querySelectorAll('[aria-label="当前版本数量"] label span')].map((node) => node.textContent);
  assert.deepEqual(labels, ["六级弹 · 发"], "current version lines are named from the frozen projection");
  assert.match(host.textContent, /123\.45 元/);
  assert.match(host.textContent, /12\.00 元/);
  assert.doesNotMatch(host.textContent, /物资 · 件/);
});

test("confirmed opening lines borrow names from the frozen projection instead of a placeholder", async (t) => {
  globalThis.fetch = async () => response(confirmedOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  const labels = [...host.querySelectorAll(".im-support-fulfillment-lines label span")].map((node) => node.textContent);
  assert.deepEqual(labels, ["哈夫币 · 哈夫币", "六级弹 · 发"]);
  assert.doesNotMatch(host.textContent, /物资 · 件/);
});
