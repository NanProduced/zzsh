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
globalThis.Element = browser.Element;
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
  // 右栏只留任务与入口；用例默认进入专用核对面板再操作数量与版本。
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", frozenInventory, ...props })); });
  await waitFor(() => Boolean(host.querySelector(".im-support-fulfillment")));
  await openPanel(host);
}
function find(host, text) {
  return [...document.body.querySelectorAll("button")].find((button) => button.textContent.includes(text));
}
async function click(host, text) {
  const button = find(host, text);
  assert.ok(button, `button available: ${text}`);
  await act(async () => { button.click(); });
  await settle();
}
// 数量与版本核对在专用面板里；右栏只留当前任务与入口。
async function openPanel(host) {
  const button = host.querySelector('[data-action="open-fulfillment-panel"]');
  assert.ok(button, "task card offers the check panel entry");
  await act(async () => { button.click(); });
  await waitFor(() => Boolean(document.body.querySelector(".im-order-panel")));
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

  const inputs = [...document.body.querySelectorAll(".im-support-fulfillment-lines input")];
  assert.equal(inputs.length, 2, "frozen inventory slot projection seeds the first opening");
  assert.equal(inputs[0].value, "5000");
  assert.match(document.body.textContent, /哈夫币/);
  await click(host, "期初代录");
  const write = requests.find((request) => request.method === "POST");
  assert.ok(write, "opening write submitted");
  assert.deepEqual(JSON.parse(write.body), { lines: [{ itemId: "item_haff", quantity: "5000" }, { itemId: "item_ammo", quantity: "120" }] });
  assert.ok(String(write.headers["idempotency-key"] ?? "").startsWith("im_ful_record-opening_order-A_"), "stable intent key attached");
  assert.match(document.body.textContent, /期初已提交/);
});

test("without the slot projection the section refuses to fake an opening", async (t) => {
  globalThis.fetch = async () => response(paidNoOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host, { frozenInventory: undefined });
  assert.equal(document.body.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
  assert.match(document.body.textContent, /未返回订单冻结库存投影/);
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
  assert.match(document.body.textContent, /操作结果未确认/);
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
  assert.doesNotMatch(document.body.textContent, /已在服务端确认完成/);
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
  assert.match(document.body.textContent, /操作结果未确认/);
  // 403 and a bare 409 CONFLICT come from the replay's own recheck: they say nothing about the original write.
  for (const [status, body] of [[403, { error: { code: "FORBIDDEN" } }], [409, { error: { code: "CONFLICT", message: "ORDER_NOT_SETTLEABLE" } }]]) {
    replayStatus = status; replayBody = body;
    await click(host, "按原请求重放");
    assert.match(document.body.textContent, /不能证明原请求未执行/, `${status} keeps the unknown responsibility`);
    assert.ok(find(host, "按原请求重放"), `${status} does not release the intent`);
  }
  // The recorded receipt for the original key resolves it: a 409 carrying the original business reasons.
  replayStatus = 409;
  replayBody = { error: { code: "CONFLICT", message: "PAYMENT_BASIS_MISSING" }, reasons: ["PAYMENT_BASIS_MISSING"] };
  await click(host, "按原请求重放");
  assert.match(document.body.textContent, /PAYMENT_BASIS_MISSING/);
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
  assert.match(document.body.textContent, /ORDER_NOT_PAID/);
  assert.doesNotMatch(document.body.textContent, /期初已提交/);
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
  assert.match(document.body.textContent, /期初已提交/);
  assert.match(document.body.textContent, /读取最新状态失败/);
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
    assert.match(document.body.textContent, /请勿刷新或离开页面，先查看当前状态或联系维护处理/);
    assert.doesNotMatch(document.body.textContent, /刷新后重试/);
    assert.equal(find(host, "按原请求重放"), undefined, "an accepted request remains GET-only");
    assert.equal(posts, 1);
  };
  warning();
  assert.equal(find(host, "期初代录").disabled, true, "the accepted responsibility keeps new writes locked");
  for (const status of [500, 401, 423]) {
    readFailureStatus = status;
    await click(host, "查看当前状态");
    warning();
    if (status !== 500) assert.equal(document.body.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
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
  assert.match(document.body.textContent, /期初已提交/);
  assert.match(document.body.textContent, /读取最新状态失败/);
  assert.equal(find(host, "按原请求重放"), undefined);
  await act(async () => root.unmount());
  host.remove();

  // Remount: the accepted fact must not degrade into UNKNOWN/replay.
  ({ host, root } = mount());
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(document.body.textContent, /上次操作已受理/);
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
    assert.doesNotMatch(document.body.textContent, /哈夫币/, `${status} hides the private projection immediately`);
    assert.equal(document.body.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
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
  assert.match(document.body.textContent, /哈夫币/, "initial read shows the private projection");
  await click(host, "期初代录");
  assert.match(document.body.textContent, /操作结果未确认/);
  await click(host, "查看当前状态");
  assert.match(document.body.textContent, /哈夫币/, "a successful observation may show current facts");
  await click(host, "查看当前状态");
  assert.doesNotMatch(document.body.textContent, /哈夫币/, "an observational 401 hides the private projection");
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
  const action = () => document.body.querySelector('[data-action="open-fulfillment-panel"]')?.textContent ?? "";
  await waitFor(() => action().includes("打开核对面板"));
  await act(async () => { document.body.querySelector('[data-action="open-fulfillment-panel"]').click(); });
  await waitFor(() => Boolean(document.body.querySelector(".im-order-panel")));
  const panel = () => document.body.querySelector(".im-order-panel");
  assert.match(panel().textContent, /履约中 · 等待结算/, "order-B's stage is in the check panel");
  await act(async () => { resolveA(response(paidNoOpening)); await settle(); });
  assert.match(panel().textContent, /履约中 · 等待结算/, "the late order-A response cannot replace order-B facts");
  assert.doesNotMatch(panel().textContent, /待核对期初/, "a superseded order's stage never refills the current panel");
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
  const input = document.body.querySelector(".im-support-fulfillment-lines input");
  assert.equal(input.disabled, true, "edits are locked while sending");
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    finish(response({ error: { code: "INTERNAL_ERROR" } }, 500));
  });
  await settle();
  assert.match(document.body.textContent, /操作结果未确认/);
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
  assert.match(document.body.textContent, /未确认/);
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
  assert.match(document.body.textContent, /登录状态已变化/);
  assert.doesNotMatch(document.body.textContent, /哈夫币/, "401/423 hides private projections immediately");
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
  const select = document.body.querySelector(".im-support-fulfillment-controls select");
  await act(async () => {
    select.value = "TENANT_VOLUNTARY_EARLY";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  await click(host, "生成提前结算预览");
  assert.match(document.body.textContent, /号主净额/);
  assert.match(document.body.textContent, /123\.45 元/);
  assert.match(document.body.textContent, /租客应退/);
  const classify = find(host, "确认分类");
  assert.ok(classify && !classify.disabled, "classify enabled after a preview");
  const input = document.body.querySelector(".im-support-fulfillment-lines input");
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
  assert.match(document.body.textContent, /待客服复核/);
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
  assert.match(document.body.textContent, /待客服复核/);
  const labels = [...document.body.querySelectorAll('[aria-label="当前版本数量"] label span')].map((node) => node.textContent);
  assert.deepEqual(labels, ["六级弹 · 发"], "current version lines are named from the frozen projection");
  assert.match(document.body.textContent, /123\.45 元/);
  assert.match(document.body.textContent, /12\.00 元/);
  assert.doesNotMatch(document.body.textContent, /物资 · 件/);
});

test("confirmed opening lines borrow names from the frozen projection instead of a placeholder", async (t) => {
  globalThis.fetch = async () => response(confirmedOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  const labels = [...document.body.querySelectorAll(".im-support-fulfillment-lines label span")].map((node) => node.textContent);
  assert.deepEqual(labels, ["哈夫币 · 哈夫币", "六级弹 · 发"]);
  assert.doesNotMatch(document.body.textContent, /物资 · 件/);
});

test("a 404 settlement read is a neutral unavailable state, not a permission claim", async (t) => {
  globalThis.fetch = async () => response({ error: { code: "NOT_FOUND" } }, 404);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", frozenInventory })); });
  await waitFor(() => host.querySelector('[data-read-state="unavailable"]'));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /本单结算记录不可用/);
  assert.match(card.textContent, /本环境未启用结算记录/);
  assert.match(card.textContent, /不影响本单沟通/);
  assert.doesNotMatch(card.textContent, /未找到此内容|无权/, "404 must not be dressed up as a permission problem");
  assert.equal(card.querySelector('[role="alert"]'), null, "an unavailable surface is neutral, not a red error");
  assert.ok(host.querySelector('[data-action="fulfillment-reload"]'), "a read-only retry stays available");
  assert.equal(host.querySelector('[data-action="open-fulfillment-panel"]'), null, "an unreadable settlement never opens a write panel");
});

test("a 403 settlement read still names the missing permission", async (t) => {
  globalThis.fetch = async () => response({ error: { code: "FORBIDDEN" } }, 403);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", frozenInventory })); });
  await waitFor(() => host.querySelector('[data-read-state="forbidden"]'));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /当前账号无权查看本单结算记录/);
  assert.doesNotMatch(card.textContent, /本环境未启用结算记录/, "403 keeps its own permission meaning");
  assert.ok(card.querySelector('[role="alert"]'), "a permission failure remains an alert");
  assert.ok(host.querySelector('[data-action="fulfillment-reload"]'));
  assert.equal(host.querySelector('[data-action="open-fulfillment-panel"]'), null);
});

test("a completed order shows read-only ended facts and no write commands", async (t) => {
  const posted = {
    orderId: "order-A", rentalStarted: true,
    openings: [{ id: "opening_1", versionNo: 1, status: "CONFIRMED", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit })) }],
    settlement: { id: "settle_v3", versionNo: 3, early: true, versionHash: "hash_v3", decisions: [{ party: "RENTER", action: "CONFIRM" }, { party: "OWNER", action: "CONFIRM" }, { party: "SUPPORT", action: "REVIEW" }] },
    posting: { id: "posting_1", versionHash: "hash_v3", early: true, postedAt: "2026-10-11T08:00:00.000Z", refundDueAt: "2026-10-14T08:00:00.000Z", amounts: { renterRefund: { amount: "320.00", unit: "yuan" } } },
  };
  globalThis.fetch = async () => response(posted);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", orderStatus: "COMPLETED", frozenInventory })); });
  await waitFor(() => host.querySelector('.im-support-fulfillment[data-ended="true"]'));
  await waitFor(() => host.querySelector(".im-support-fulfillment").textContent.includes("已结算"));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /本单已结束/);
  assert.match(card.textContent, /已完成/);
  assert.match(card.textContent, /已结算/);
  assert.match(card.textContent, /退款应付时间：10\/14 16:00/);
  assert.equal(host.querySelector('[data-action="open-fulfillment-panel"]'), null, "ended orders offer no write entry");
  assert.equal(document.body.querySelector(".im-order-panel"), null, "no check panel is mounted");
  assert.equal(host.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
  assert.doesNotMatch(card.textContent, /期初代录|生成提前结算预览|确认复核|人工调整/);
});

test("a cancelled order stays neutral even when settlement recording is unavailable", async (t) => {
  globalThis.fetch = async () => response({ error: { code: "NOT_FOUND" } }, 404);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", orderStatus: "CANCELLED", frozenInventory })); });
  await waitFor(() => host.querySelector('.im-support-fulfillment[data-ended="true"]'));
  await waitFor(() => host.querySelector(".im-support-fulfillment").textContent.includes("本环境未启用结算记录"));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /已结束/);
  assert.match(card.textContent, /已取消/);
  assert.doesNotMatch(card.textContent, /无权|未找到此内容/, "a 404 on an ended order is not a permission verdict");
  assert.equal(card.querySelector('[role="alert"]'), null, "ended reads stay neutral, never red");
  assert.ok(host.querySelector('[data-action="fulfillment-reload"]'), "only another read is offered");
  assert.equal(host.querySelector('[data-action="open-fulfillment-panel"]'), null);
});

test("an active order keeps its existing fulfillment entry", async (t) => {
  globalThis.fetch = async () => response(paidNoOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.ok(host.querySelector('[data-action="open-fulfillment-panel"]'), "the active order keeps its write entry");
  assert.equal(host.querySelector('[data-ended="true"]'), null, "an active order is never labelled ended");
  assert.equal(host.querySelector('[data-read-state]'), null, "the loaded active card has no read-failure state");
});

test("the rail card keeps the action and leaves stage and status facts to the header and check panel", async (t) => {
  globalThis.fetch = async () => response(paidNoOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", frozenInventory })); });
  await waitFor(() => Boolean(host.querySelector('[data-action="open-fulfillment-panel"]')));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /履约核对/, "the rail card speaks about the action, not the stage");
  assert.doesNotMatch(card.textContent, /待核对期初|未开租|已开租|有结算申请待处理|已过账|双方确认/, "the rail card does not repeat stage or status facts");
  assert.match(card.querySelector('[data-action="open-fulfillment-panel"]').textContent, /期初/, "the stage-specific action stays available");
  await act(async () => { card.querySelector('[data-action="open-fulfillment-panel"]').click(); });
  await waitFor(() => Boolean(document.body.querySelector(".im-order-panel")));
  assert.match(document.body.querySelector(".im-order-panel").textContent, /待核对期初/, "the check panel owns the stage facts");
});

test("manual close is offered only with permission, warns that funds stay offline, and reports success", async (t) => {
  let posted = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/manual-close")) {
      posted = { url: String(url), method: init?.method, key: new Headers(init?.headers).get("idempotency-key"), body: JSON.parse(String(init?.body)) };
      return response({ orderId: "order-A", status: "CANCELLED", cancelReason: "MANUAL_CLOSE", cancelledAt: "2026-10-29T13:30:00.000Z", localFundsEffect: "NONE", financeHandling: "OFFLINE_REQUIRED" });
    }
    return response(confirmedOpening);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host, { orderStatus: "PAID", canManualClose: true });
  await waitFor(() => host.querySelector('[data-action="manual-close-open"]'));

  const card = host.querySelector('[data-manual-close="true"]');
  assert.match(card.textContent, /不生成结算或退款/);
  assert.match(card.textContent, /财务线下核对/);
  await click(host, "手动结单");
  await waitFor(() => document.body.querySelector('[aria-label="手动结单"]'));
  assert.match(document.body.textContent, /资金不会被自动处理/);

  assert.equal(document.body.querySelector('[data-action="manual-close-submit"]').disabled, true, "an empty remark cannot submit");
  const textarea = document.body.querySelector('textarea[aria-label="手动结单处理备注"]');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
  setter.call(textarea, "异常订单，线下核对资金");
  await act(async () => { textarea.dispatchEvent(new browser.Event("input", { bubbles: true })); });
  await settle();
  await click(host, "确认手动结单");
  await waitFor(() => host.querySelector('[data-manual-close="true"]').textContent.includes("已手动结单"));

  assert.equal(posted.method, "POST");
  assert.match(posted.url, /\/orders\/order-A\/manual-close$/);
  assert.equal(posted.body.remark, "异常订单，线下核对资金");
  assert.ok(posted.key, "the idempotency key is sent");
  assert.equal(host.querySelector('[data-action="manual-close-open"]'), null, "a closed order hides the action");
  assert.match(host.textContent, /资金未自动结算或退款/);
});
