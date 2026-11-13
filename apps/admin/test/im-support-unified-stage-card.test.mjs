import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/workspace/support" });
Object.assign(globalThis, {
  window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
  Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
const orderIntervals = [];
const supportIntervals = [];
const realSetInterval = browser.setInterval.bind(browser);
const realClearInterval = browser.clearInterval.bind(browser);
browser.setInterval = (callback, ms) => {
  if (ms === 15_000) {
    const id = `order-refresh-${orderIntervals.length}`;
    orderIntervals.push({ id, callback, active: true });
    return id;
  }
  if (ms === 30_000) {
    const id = `support-tick-${supportIntervals.length}`;
    supportIntervals.push({ id, callback, active: true });
    return id;
  }
  return realSetInterval(callback, ms);
};
browser.clearInterval = (id) => {
  const entry = orderIntervals.find((item) => item.id === id) ?? supportIntervals.find((item) => item.id === id);
  if (entry) entry.active = false;
  else realClearInterval(id);
};
globalThis.setInterval = browser.setInterval;
globalThis.clearInterval = browser.clearInterval;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const { createRoot } = await import("react-dom/client");

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { ImSupportView, presenceRuntimeState, presenceWriteSucceeded, staleHeartbeatRetryState } = await vite.ssrLoadModule("/src/views/im-support-view.tsx");
const { WorkspaceApp } = await vite.ssrLoadModule("/src/workspace/app-shell.tsx");
after(async () => { await vite.close(); });

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function snapshot(permissions, adminUserId = "admin-a", sessionId = "session-a", locked = false) {
  return {
    authenticated: true,
    adminUserId,
    user: { name: `客服 ${adminUserId}`, username: adminUserId, displayUsername: `客服 ${adminUserId}`, twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    session: { id: sessionId, locked, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions,
  };
}
const permissions = ["im.support.read", "im.support.accept"];
const order = (id, displayNo, stage, stageCards) => ({
  id, displayNo, title: `订单 ${id}`, status: stage === "COMPLETED" ? "COMPLETED" : "PAID",
  stage, teamState: "READY", assignmentState: "ASSIGNED", stageCards,
  supportEscalation: { state: "NOT_STARTED", firstResponseAt: null, remindDueAt: null, addRound: 0 },
  lastMessageAt: null, createdAt: "2026-10-01T00:00:00.000Z", unreadCount: 0,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

let api = { admin: "A", orders: [], page2: [], nextCursor: null, requests: [], hold: null, holdMore: null, failMoreOnce: false };
let heartbeatRequests = 0;
let readRequests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), browser.location.href);
  if (url.pathname.endsWith("/im/token")) { api.tokenRequests = (api.tokenRequests ?? 0) + 1; return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" }); }
  if (url.pathname.endsWith("/im/consultations")) {
    const q = url.searchParams.get("q");
    if (q) { api.searchQueries = [...(api.searchQueries ?? []), `consultations:${q}`]; return response({ consultations: api.searchConsultations ?? [], query: q }); }
    return response({ consultations: [] });
  }
  if (url.pathname.endsWith("/im/presence")) return response(api.presence ?? { availability: "AVAILABLE", connectionState: "CONNECTED", version: 1 });
  if (url.pathname.endsWith("/im/presence/connect")) {
    api.connectRequests = (api.connectRequests ?? 0) + 1;
    const next = api.connectResponses?.shift();
    return next ? response(next.body, next.status ?? 200) : response({ ok: true, reason: "CLAIMED", version: 1, stateRevision: 1 });
  }
  if (url.pathname.endsWith("/im/presence/release")) {
    api.releaseRequests = [...(api.releaseRequests ?? []), init.body ? JSON.parse(String(init.body)) : {}];
    return response({ released: true });
  }
  if (url.pathname.endsWith("/im/presence/heartbeat")) {
    heartbeatRequests += 1;
    return response({ ok: true, dispatchable: true, reason: null, disconnectedSince: null, dispatchPaused: false, stateRevision: 1, today: { seconds: 0, sessions: 0, users: 0 }, serverTime: "2026-11-12T00:00:00.000000Z" });
  }
  if (url.pathname.includes("/im/order-teams/") && url.pathname.endsWith("/read")) { readRequests.push({ kind: "order", id: url.pathname.split("/").at(-2) }); return response({}); }
  if (/\/im\/consultations\/[^/]+\/read$/.test(url.pathname)) { readRequests.push({ kind: "consultation" }); return response({}); }
  if (url.pathname.endsWith("/orders/order-a/im")) {
    api.accessRequests = (api.accessRequests ?? 0) + 1;
    if (api.holdAccess) { const held = api.holdAccess; api.holdAccess = null; return held.promise; }
    return response(api.orderAccess);
  }
  if (url.pathname.endsWith("/orders/order-b/im")) return response({ ...api.orderAccess, orderId: "order-b", displayNo: "ZZ-B", account: { id: "account-b", title: "SYNTH-B-ACCOUNT" } });
  if (url.pathname.endsWith("/orders/im-groups")) {
    const q = url.searchParams.get("q");
    if (q) {
      api.searchQueries = [...(api.searchQueries ?? []), `orders:${q}`];
      return response({ items: api.searchOrders ?? [], nextCursor: null, query: q });
    }
    const cursor = url.searchParams.get("cursor");
    api.requests.push({ admin: api.admin, cursor });
    if (api.ordersStatus) return response({ error: { code: "FORBIDDEN", message: "synthetic" } }, api.ordersStatus);
    if (api.pageMap) {
      const key = cursor ?? "FIRST";
      if (api.failCursorOnce === key) { api.failCursorOnce = null; return response({ error: { code: "FAILED", message: "synthetic" } }, 503); }
      return api.pageMap[key] ? response(api.pageMap[key]) : response({ error: { code: "FAILED", message: "missing fake page" } }, 500);
    }
    if (api.hold && cursor === null) { const held = api.hold; api.hold = null; return held.promise; }
    if (api.holdMore && cursor !== null) { const held = api.holdMore; api.holdMore = null; return held.promise; }
    if (api.failMoreOnce && cursor !== null) { api.failMoreOnce = false; return response({}, 503); }
    return response(cursor === null
      ? { items: api.orders, nextCursor: api.nextCursor }
      : { items: api.page2, nextCursor: null });
  }
  return response({});
};

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
async function mountView(t, snap) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snap, onRefresh: async () => snap })); });
  return { host, root };
}
async function triggerOrderRefresh() {
  const interval = [...orderIntervals].reverse().find((item) => item.active);
  assert.ok(interval, "the order refresh interval is mounted");
  await act(async () => { interval.callback(); await new Promise((resolve) => setTimeout(resolve, 20)); });
}
const orderRows = (host) => [...host.querySelectorAll('.im-wb-unified-queue .im-wb-row[data-unified-kind="order"]')];

// 桌面通知只在页面隐藏时创建；用探针收集标题和正文，再手动点击回调验证打开行为。
function observeNotifications(t) {
  const fired = [];
  class FakeNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title, options) { fired.push(this); this.title = title; this.options = options; this.onclick = null; }
    close() {}
  }
  const originalNotification = globalThis.Notification;
  const originalBrowserNotification = browser.Notification;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(browser.document, "hidden");
  globalThis.Notification = FakeNotification;
  browser.Notification = FakeNotification;
  Object.defineProperty(browser.document, "hidden", { configurable: true, value: true });
  t.after(() => {
    globalThis.Notification = originalNotification;
    browser.Notification = originalBrowserNotification;
    if (hiddenDescriptor) Object.defineProperty(browser.document, "hidden", hiddenDescriptor);
    else delete browser.document.hidden;
  });
  return fired;
}

test("order group unread joins the bell and its notification opens that order", async (t) => {
  readRequests = [];
  const fired = observeNotifications(t);
  const card = { pending: 0, failed: 0, skipped: 0, unknown: 0 };
  const item = order("order-a", "ZZ-A", "RENTING", card);
  api = { admin: "A", requests: [], nextCursor: null, page2: [], orders: [item], orderAccess: syntheticOrderAccess() };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 1);
  await settle();
  const bell = host.querySelector('[data-action="toggle-notifications"]');
  assert.equal(bell.querySelector(".im-wb-notify-count"), null, "a zero-unread order group never counts");
  fired.length = 0;

  api.orders = [{ ...item, lastMessageAt: "2026-10-01T00:05:00.000Z", lastMessagePreview: "买家催发货", unreadCount: 2 }];
  await triggerOrderRefresh();
  await waitFor(() => fired.length === 1);
  assert.match(fired[0].title, /订单群 · ZZ-A/, "the order group is named in the notification title");
  assert.equal(fired[0].options?.body, "买家催发货", "the existing preview is the notification body");
  assert.equal(bell.querySelector(".im-wb-notify-count")?.textContent, "1", "an unread order group counts in the bell once");

  await act(async () => { fired[0].onclick?.(); });
  await waitFor(() => host.querySelector('.im-wb-unified-queue [data-order-id="order-a"]')?.getAttribute("data-active") === "true");
  assert.equal(host.querySelector(".im-wb-pane--orders").hasAttribute("hidden"), false, "clicking the notification switches to the order section");
  await waitFor(() => readRequests.some((request) => request.kind === "order" && request.id === "order-a"));
  await waitFor(() => !bell.querySelector(".im-wb-notify-count"));
  assert.equal(fired.length, 1, "marking the open order group read adds no second channel");
});

test("an order group already unread on first load seeds the bell without replaying a notification", async (t) => {
  const fired = observeNotifications(t);
  const card = { pending: 0, failed: 0, skipped: 0, unknown: 0 };
  api = { admin: "A", requests: [], nextCursor: null, page2: [], orders: [
    { ...order("order-seed", "ZZ-SEED", "RENTING", card), lastMessageAt: "2026-10-01T00:01:00.000Z", lastMessagePreview: "历史未读", unreadCount: 1 },
  ] };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 1);
  await settle();
  assert.equal(host.querySelector(".im-wb-notify-count")?.textContent, "1", "the existing unread still shows in the bell");
  assert.equal(fired.length, 0, "the first loaded order queue is a baseline, not a new-message burst");
});

test("hidden order groups never notify even when unread", async (t) => {
  const fired = observeNotifications(t);
  window.localStorage.setItem("zzsh.im-support.order-group-prefs.admin-a", JSON.stringify({ "order-hidden": { hidden: true } }));
  t.after(() => window.localStorage.removeItem("zzsh.im-support.order-group-prefs.admin-a"));
  const card = { pending: 0, failed: 0, skipped: 0, unknown: 0 };
  api = { admin: "A", requests: [], nextCursor: null, page2: [], orders: [
    { ...order("order-hidden", "ZZ-HIDDEN", "RENTING", card), lastMessageAt: "2026-10-01T00:05:00.000Z", lastMessagePreview: "隐藏群的新消息", unreadCount: 3 },
    { ...order("order-zero", "ZZ-ZERO", "RENTING", card), unreadCount: 0 },
  ] };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).some((row) => row.dataset.orderId === "order-zero"));
  await settle();
  assert.equal(host.querySelector(".im-wb-notify-count"), null);
  api.orders = [...api.orders];
  await triggerOrderRefresh();
  await settle();
  assert.equal(fired.length, 0);
  assert.equal(host.querySelector(".im-wb-notify-count"), null);
});

test("muted order groups never raise a notification or bell count", async (t) => {
  const fired = observeNotifications(t);
  window.localStorage.setItem("zzsh.im-support.order-group-prefs.admin-a", JSON.stringify({ "order-muted": { muted: true } }));
  t.after(() => window.localStorage.removeItem("zzsh.im-support.order-group-prefs.admin-a"));
  const card = { pending: 0, failed: 0, skipped: 0, unknown: 0 };
  api = { admin: "A", requests: [], nextCursor: null, page2: [], orders: [
    { ...order("order-muted", "ZZ-MUTED", "RENTING", card), lastMessageAt: "2026-10-01T00:05:00.000Z", lastMessagePreview: "免打扰群的新消息", unreadCount: 2 },
  ] };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 1);
  await settle();
  assert.equal(host.querySelector(".im-wb-notify-count"), null, "a muted group is not a notification source");
  api.orders = [...api.orders];
  await triggerOrderRefresh();
  await settle();
  assert.equal(fired.length, 0, "a muted group never raises a desktop notification");
});

test("search asks the server for sessions outside the loaded order pages", async (t) => {
  api = { admin: "A", hold: null, nextCursor: null, page2: [], requests: [], searchQueries: [],
    orders: [order("order-loaded", "ZZ-LOADED", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 })],
    searchOrders: [order("order-server", "ZZ-SERVER", "CANCELLED", { pending: 0, failed: 0, skipped: 0, unknown: 0 })] };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 1);
  const input = host.querySelector('.im-wb-search input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, "ZZ-SERVER");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitFor(() => orderRows(host).some((row) => row.dataset.orderId === "order-server"));
  assert.ok(api.searchQueries.includes("orders:ZZ-SERVER"), "the order directory is queried server-side");
  assert.ok(api.searchQueries.includes("consultations:ZZ-SERVER"), "the consultation directory is queried server-side");
});

test("desktop unified order list marks UNKNOWN cards without treating them as sent or unsent", async (t) => {
  api = { admin: "A", hold: null, nextCursor: null, page2: [], requests: [],
    orders: [
      order("order-unknown", "ZZ-UNKNOWN", "OPENING_CONFIRM", { pending: 0, failed: 2, skipped: 0, unknown: 2 }),
      order("order-skipped", "ZZ-SKIPPED", "COMPLETED", { pending: 0, failed: 1, skipped: 1, unknown: 0, attention: { state: "SKIPPED" } }),
      order("order-clean", "ZZ-CLEAN", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 }),
    ] };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 3);

  assert.equal(host.querySelector(".im-wb-root").getAttribute("data-unified"), "true", "the desktop shell uses the outer unified list");
  const row = (id) => host.querySelector(`.im-wb-unified-queue .im-wb-row[data-order-id="${id}"]`);
  assert.equal(row("order-unknown").querySelectorAll('.im-wb-tag[data-tone="warn"]').length, 1, "multi-card UNKNOWN is summarised once");
  assert.match(row("order-unknown").textContent, /自动卡待核对/);
  assert.doesNotMatch(row("order-skipped").textContent, /自动卡待核对/, "a skipped attention card does not hide a clean count");
  assert.doesNotMatch(row("order-clean").textContent, /自动卡待核对/);

});

test("switching admin clears the previous order queue and refetches for the new identity", async (t) => {
  api = { admin: "A", hold: null, nextCursor: null, page2: [], requests: [],
    orders: [order("order-a", "ZZ-A", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 })] };
  const first = snapshot(permissions, "admin-a", "session-a");
  const { host, root } = await mountView(t, first);
  await waitFor(() => Boolean(host.querySelector('[data-order-id="order-a"]')));
  api.admin = "B";
  api.orders = [order("order-b", "ZZ-B", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 })];
  const second = snapshot(permissions, "admin-b", "session-b");
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: second, onRefresh: async () => second })); });
  assert.equal(host.querySelector('[data-order-id="order-a"]'), null, "the previous identity's queue is hidden immediately");
  await waitFor(() => Boolean(host.querySelector('[data-order-id="order-b"]')));
  assert.ok(api.requests.some((request) => request.admin === "B"), "the new identity triggers its own list read");
});

test("a late previous-identity order response cannot repopulate the new queue", async (t) => {
  const held = deferred();
  api = { admin: "A", hold: held, nextCursor: null, page2: [], requests: [],
    orders: [order("order-a", "ZZ-A", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 })] };
  const { host, root } = await mountView(t, snapshot(permissions, "admin-a", "session-a"));
  await waitFor(() => api.requests.some((request) => request.admin === "A"));
  api.admin = "B";
  api.orders = [order("order-b", "ZZ-B", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 })];
  const second = snapshot(permissions, "admin-b", "session-b");
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: second, onRefresh: async () => second })); });
  await waitFor(() => Boolean(host.querySelector('[data-order-id="order-b"]')));
  await act(async () => { held.resolve(response({ items: [order("order-a", "ZZ-A", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 })], nextCursor: null })); });
  await settle();
  assert.equal(host.querySelector('[data-order-id="order-a"]'), null, "the stale A response is discarded");
  assert.match(host.querySelector('[data-order-id="order-b"]').textContent, /ZZ-B/);
});

test("desktop unified queue can load the next order page and find a second-page UNKNOWN", async (t) => {
  const firstPage = Array.from({ length: 50 }, (_, index) =>
    order(`order-${index}`, `ZZ-${String(index).padStart(2, "0")}`, "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 }));
  api = { admin: "A", hold: null, nextCursor: "page-2", requests: [], page2: [
    order("order-unknown-2", "ZZ-SECOND", "OPENING_CONFIRM", { pending: 0, failed: 1, skipped: 0, unknown: 1 }),
  ], orders: firstPage };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 50);
  const more = host.querySelector('[data-action="load-more-orders"]');
  assert.ok(more, "the next page entry is visible");
  await act(async () => { more.click(); });
  await waitFor(() => orderRows(host).length === 51);
  assert.ok(api.requests.some((request) => request.cursor === "page-2"), "the next cursor reaches the API");
  assert.match(host.querySelector('[data-order-id="order-unknown-2"]').textContent, /自动卡待核对/);
});

test("locking or losing read permission hides the loaded order queue", async (t) => {
  const first = order("order-a", "ZZ-A", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 });
  api = { admin: "A", hold: null, holdMore: null, failMoreOnce: false, nextCursor: null, page2: [], requests: [], orders: [first] };
  const { host, root } = await mountView(t, snapshot(permissions));
  await waitFor(() => Boolean(host.querySelector('[data-order-id="order-a"]')));
  api.orders = [];
  const locked = snapshot(permissions, "admin-a", "session-a", true);
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: locked, onRefresh: async () => locked })); });
  assert.equal(host.querySelector('[data-order-id="order-a"]'), null, "a locked session cannot keep the old order list");
  api.orders = [first];
  const unlocked = snapshot(permissions);
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: unlocked, onRefresh: async () => unlocked })); });
  await waitFor(() => Boolean(host.querySelector('[data-order-id="order-a"]')));
  const revoked = snapshot([]);
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: revoked, onRefresh: async () => revoked })); });
  assert.equal(host.querySelector('[data-order-id="order-a"]'), null, "a revoked read permission hides the old order list");
});

test("a refresh removes rows that left the authorized page chain", async (t) => {
  const first = order("order-a", "ZZ-A", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 });
  const second = order("order-b", "ZZ-B", "OPENING_CONFIRM", { pending: 0, failed: 1, skipped: 0, unknown: 1 });
  api = { admin: "A", hold: null, holdMore: null, failMoreOnce: false, nextCursor: "page-2", page2: [second], requests: [], orders: [first] };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 1);
  await act(async () => { host.querySelector('[data-action="load-more-orders"]').click(); });
  await waitFor(() => orderRows(host).length === 2);
  api.orders = [];
  api.nextCursor = null;
  api.page2 = [];
  await triggerOrderRefresh();
  await waitFor(() => orderRows(host).length === 0);
  assert.equal(host.querySelector('[data-action="load-more-orders"]'), null, "the empty refreshed chain has no next page");
  assert.equal(host.querySelector('[data-order-id="order-a"]'), null);
  assert.equal(host.querySelector('[data-order-id="order-b"]'), null);
});

test("a refresh is deferred while a next page is in flight and never mixes old cursors", async (t) => {
  const id900 = order("id-900", "ZZ-900", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 });
  const id800 = order("id-800", "ZZ-800", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 });
  const id700 = order("id-700", "ZZ-700", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 });
  const heldPage = deferred();
  api = { admin: "A", hold: null, holdMore: heldPage, failMoreOnce: false, nextCursor: "id-800", page2: [id700], requests: [], orders: [id900, id800] };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 2);
  await act(async () => { host.querySelector('[data-action="load-more-orders"]').click(); });
  await waitFor(() => api.requests.some((request) => request.cursor === "id-800"));
  await triggerOrderRefresh();
  assert.equal(api.requests.filter((request) => request.cursor === null).length, 1, "refresh waits for the in-flight page");
  await act(async () => { heldPage.resolve(response({ items: [id700], nextCursor: null })); });
  await waitFor(() => orderRows(host).length === 3);
  assert.ok(host.querySelector('[data-order-id="id-800"]'), "the existing page boundary is preserved");

  api.orders = [order("id-950", "ZZ-950", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 }), id900];
  api.nextCursor = "id-900";
  api.page2 = [id800, id700];
  await triggerOrderRefresh();
  await waitFor(() => orderRows(host).length === 4);
  for (const id of ["id-950", "id-900", "id-800", "id-700"]) assert.ok(host.querySelector(`[data-order-id="${id}"]`), id);
});

test("a failed next page keeps the loaded list and shows a retryable notice", async (t) => {
  const first = order("order-a", "ZZ-A", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 });
  const second = order("order-b", "ZZ-B", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 });
  api = { admin: "A", hold: null, holdMore: null, failMoreOnce: true, nextCursor: "page-2", page2: [second], requests: [], orders: [first] };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 1);
  const more = host.querySelector('[data-action="load-more-orders"]');
  await act(async () => { more.click(); });
  await waitFor(() => Boolean(host.querySelector('[data-action="order-queue-notice"]')));
  assert.match(host.querySelector('[data-action="order-queue-notice"]').textContent, /加载更多订单群失败/);
  assert.equal(orderRows(host).length, 1, "the loaded page is kept");
  await act(async () => { host.querySelector('[data-action="load-more-orders"]').click(); });
  await waitFor(() => orderRows(host).length === 2);
  assert.ok(host.querySelector('[data-order-id="order-b"]'));
});

test("order group preferences follow the current administrator", async (t) => {
  const shared = order("order-shared", "ZZ-SHARED", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 });
  window.localStorage.setItem("zzsh.im-support.order-group-prefs.admin-a", JSON.stringify({ "order-shared": { hidden: true } }));
  t.after(() => window.localStorage.removeItem("zzsh.im-support.order-group-prefs.admin-a"));
  api = { admin: "A", hold: null, holdMore: null, failMoreOnce: false, nextCursor: null, page2: [], requests: [], orders: [shared] };
  const { host, root } = await mountView(t, snapshot(permissions, "admin-a", "session-a"));
  await waitFor(() => api.requests.some((request) => request.admin === "A"));
  assert.equal(orderRows(host).length, 0, "the first admin's hidden preference applies");
  api.admin = "B";
  const second = snapshot(permissions, "admin-b", "session-b");
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: second, onRefresh: async () => second })); });
  await waitFor(() => Boolean(host.querySelector('[data-order-id="order-shared"]')));
});

test("a locked snapshot does not request the order list", async (t) => {
  api = { admin: "A", hold: null, holdMore: null, failMoreOnce: false, nextCursor: null, page2: [], requests: [],
    orders: [order("order-a", "ZZ-A", "RENTING", { pending: 0, failed: 0, skipped: 0, unknown: 0 })] };
  const { host, root } = await mountView(t, snapshot(permissions, "admin-a", "session-a", true));
  await settle();
  assert.equal(api.requests.length, 0, "a locked session never asks for order groups");
  const unlocked = snapshot(permissions);
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: unlocked, onRefresh: async () => unlocked })); });
  await waitFor(() => Boolean(host.querySelector('[data-order-id="order-a"]')));
});

for (const failure of ["removed", 401, 403, 423]) test(`a selected order detail is hidden when the refreshed queue reports ${failure}`, async (t) => {
  browser.history.replaceState(null, "", "/support?section=orders&order=order-a");
  browser.localStorage.clear();
  browser.matchMedia = (query) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  const snap = snapshot(permissions), item = order("order-a", "ZZ-A", "OPENING_CONFIRM", { pending: 0, failed: 0, skipped: 0, unknown: 0 });
  api = { admin: "A", requests: [], orders: [item], nextCursor: null, page2: [], orderAccess: {
    orderId: "order-a", displayNo: "ZZ-A", orderStatus: "PAID", assignmentState: "ASSIGNED", teamState: "READY", appId: "synth", teamId: "12345",
    gameName: "SYNTH-SECRET-GAME", account: { id: "account-a", title: "SYNTH-SECRET-ACCOUNT" }, viewerAccountId: "admin-a", conversationId: "admin-a|2|12345",
    canRead: true, canSend: false, members: [{ platformId: "admin-a", accountId: "admin-a", party: "STAFF", name: "客服", avatar: null }],
    supportEscalation: { state: "STOPPED", firstResponseAt: null, remindDueAt: null, addRound: 0, needsManualReview: false, noEligibleStaff: false },
  } };
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); browser.history.replaceState(null, "", "/workspace/support"); });
  const props = { theme: "light", idleMinutes: 15, onIdleMinutes: () => {}, onLock: () => {}, onSignOut: () => {}, onRefresh: async () => snap, onRecoveryCompleted: () => {} };
  await act(async () => root.render(createElement(WorkspaceApp, { ...props, snapshot: snap })));
  await waitFor(() => host.querySelector('.im-wb-pane--orders .im-wb-details')?.textContent.includes('本单详情'), 4000);
  const before = api.accessRequests;
  if (failure === "removed") api.orders = []; else api.ordersStatus = failure;
  await triggerOrderRefresh();
  await waitFor(() => !host.querySelector('.im-wb-unified-queue [data-order-id="order-a"]'));
  assert.equal(host.querySelector('.im-wb-pane--orders .im-wb-details'), null, "the dropped order's detail unmounts");
  assert.equal(api.accessRequests, before, "hiding does not depend on a later detail response");
});

test("refresh retains every loaded page, including pages beyond the former limit", async (t) => {
  const pageMap = {}, card = { pending: 0, failed: 0, skipped: 0, unknown: 0 };
  for (let page = 1; page <= 11; page++) {
    const key = page === 1 ? "FIRST" : `cursor-${page}`;
    const items = Array.from({ length: 50 }, (_, i) => order(`id-${2000-(page-1)*50-i}`, `ZZ-${i}`, "RENTING", card));
    pageMap[key] = { items, nextCursor: page < 11 ? `cursor-${page+1}` : null };
  }
  api = { admin: "A", requests: [], pageMap };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 50, 8000);
  for (let page = 2; page <= 11; page++) {
    await act(async () => host.querySelector('[data-action="load-more-orders"]').click());
    await waitFor(() => orderRows(host).length === page * 50, 8000);
  }
  const before = api.requests.length;
  await triggerOrderRefresh();
  await waitFor(() => api.requests.length >= before + 11, 8000);
  assert.equal(orderRows(host).length, 550);
  assert.ok(host.querySelector('[data-order-id="id-1500"]'));
});

test("partial refresh retries the failed page on the next refresh", async (t) => {
  const card = { pending: 0, failed: 0, skipped: 0, unknown: 0 };
  api = { admin: "A", requests: [], pageMap: { FIRST: { items: [order("a", "ZZ-A", "RENTING", card)], nextCursor: "page-2" },
    "page-2": { items: [order("b", "ZZ-B", "RENTING", card)], nextCursor: null } } };
  const { host } = await mountView(t, snapshot(permissions));
  await waitFor(() => orderRows(host).length === 1);
  await act(async () => host.querySelector('[data-action="load-more-orders"]').click());
  await waitFor(() => orderRows(host).length === 2);
  api.failCursorOnce = "page-2";
  await triggerOrderRefresh();
  await waitFor(() => Boolean(host.querySelector('[data-action="order-queue-notice"]')));
  assert.equal(orderRows(host).length, 1);
  const before = api.requests.length;
  await triggerOrderRefresh();
  await waitFor(() => orderRows(host).length === 2);
  assert.deepEqual(api.requests.slice(before).map(x => x.cursor), [null, "page-2"]);
  assert.equal(host.querySelector('[data-action="order-queue-notice"]'), null);
});

function syntheticOrderAccess() {
  return { orderId: "order-a", displayNo: "ZZ-A", orderStatus: "PAID", assignmentState: "ASSIGNED", teamState: "READY", appId: "synth", teamId: "12345",
    gameName: "SYNTH-GAME", account: { id: "account-a", title: "SYNTH-A-ACCOUNT" }, viewerAccountId: "admin-a", conversationId: "admin-a|2|12345",
    canRead: true, canSend: false, members: [{ platformId: "admin-a", accountId: "admin-a", party: "STAFF", name: "客服", avatar: null }],
    supportEscalation: { state: "STOPPED", firstResponseAt: null, remindDueAt: null, addRound: 0, needsManualReview: false, noEligibleStaff: false } };
}

async function mountWorkspace(t, route, narrow = false, grants = permissions) {
  browser.history.replaceState(null, "", route);
  browser.localStorage.clear();
  const previousMatchMedia = browser.matchMedia;
  browser.matchMedia = (query) => ({ matches: narrow && /max-width:\s*(760|1024|1439)px/.test(String(query)), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  const snap = snapshot(grants), host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); browser.matchMedia = previousMatchMedia; browser.history.replaceState(null, "", "/workspace/support"); });
  const props = { theme: "light", idleMinutes: 15, onIdleMinutes: () => {}, onLock: () => {}, onSignOut: () => {}, onRefresh: async () => snap, onRecoveryCompleted: () => {} };
  await act(async () => root.render(createElement(WorkspaceApp, { ...props, snapshot: snap })));
  return host;
}

test("an authorized selected order is not cleared when it moves beyond the loaded page", async (t) => {
  const card = { pending: 0, failed: 0, skipped: 0, unknown: 0 }, target = order("order-a", "ZZ-A", "OPENING_CONFIRM", card);
  const fillers = Array.from({ length: 49 }, (_, i) => order(`z-${1049-i}`, `ZZ-${i}`, "RENTING", card));
  api = { admin: "A", requests: [], pageMap: { FIRST: { items: [...fillers, target], nextCursor: "order-a" } }, orderAccess: syntheticOrderAccess() };
  const host = await mountWorkspace(t, "/support?section=orders&order=order-a");
  await waitFor(() => host.querySelector('.im-wb-pane--orders .im-wb-details')?.textContent.includes('本单详情'), 4000);
  api.pageMap.FIRST = { items: [order("zz-2000", "ZZ-NEW", "RENTING", card), ...fillers], nextCursor: "z-1001" };
  await triggerOrderRefresh();
  await waitFor(() => !host.querySelector('.im-wb-unified-queue [data-order-id="order-a"]'));
  assert.match(host.querySelector('.im-wb-pane--orders .im-wb-details')?.textContent ?? "", /本单详情/);
});

test("narrow order list selection stays synchronized when switching orders", async (t) => {
  const card = { pending: 0, failed: 0, skipped: 0, unknown: 0 };
  api = { admin: "A", requests: [], nextCursor: null, page2: [], orders: [order("order-a", "ZZ-A", "OPENING_CONFIRM", card), order("order-b", "ZZ-B", "OPENING_CONFIRM", card)], orderAccess: syntheticOrderAccess() };
  const host = await mountWorkspace(t, "/support?section=orders", true);
  await waitFor(() => host.querySelector('.im-wb-pane--orders .im-wb-queue [data-order-id="order-a"]'), 4000);
  await act(async () => host.querySelector('.im-wb-pane--orders .im-wb-queue [data-order-id="order-a"]').click());
  await waitFor(() => host.querySelector('.im-wb-pane--orders .im-wb-chat-title')?.textContent.includes('ZZ-A'), 3000);
  await act(async () => host.querySelector('[data-action="back-to-order-list"]').click());
  await act(async () => host.querySelector('.im-wb-pane--orders .im-wb-queue [data-order-id="order-b"]').click());
  await waitFor(() => host.querySelector('.im-wb-pane--orders .im-wb-chat-title')?.textContent.includes('ZZ-B'), 3000);
  assert.doesNotMatch(host.querySelector('.im-wb-pane--orders .im-wb-chat-title').textContent, /ZZ-A/);
});

test("a late successful order detail response cannot restore revoked content", async (t) => {
  const card = { pending: 0, failed: 0, skipped: 0, unknown: 0 };
  api = { admin: "A", requests: [], nextCursor: null, page2: [], orders: [order("order-a", "ZZ-A", "OPENING_CONFIRM", card)], orderAccess: syntheticOrderAccess() };
  const host = await mountWorkspace(t, "/support?section=orders&order=order-a");
  await waitFor(() => host.querySelector('.im-wb-pane--orders .im-wb-details')?.textContent.includes('本单详情'), 4000);
  const held = deferred(); api.holdAccess = held;
  await act(async () => host.querySelector('[data-action="refresh-order-panel"]').click());
  await waitFor(() => api.holdAccess === null);
  api.ordersStatus = 403; await triggerOrderRefresh();
  await waitFor(() => host.querySelector('[data-action="order-queue-notice"]')?.textContent.includes('权限已变化'));
  assert.equal(host.querySelector('.im-wb-pane--orders .im-wb-details'), null);
  await act(async () => { held.resolve(response(api.orderAccess)); await new Promise(resolve => setTimeout(resolve, 80)); });
  assert.equal(host.querySelector('.im-wb-pane--orders .im-wb-details'), null);
});

test("switching workspace tabs keeps the support workbench mounted and heartbeating while hidden", async (t) => {
  const host = await mountWorkspace(t, "/support", false, [...permissions, "im.support.presence"]);
  await waitFor(() => host.querySelector(".im-wb-root") !== null);
  await waitFor(() => supportIntervals.filter((item) => item.active).length >= 1, 4000);
  const root = host.querySelector(".im-wb-root");
  await act(async () => host.querySelector('[data-tab-id="workbench"]').click());
  assert.equal(root.isConnected, true, "the support workbench stays mounted after switching tabs");
  assert.equal(root.parentElement.hidden, true, "the inactive support tab is hidden, not unmounted");
  assert.equal(host.querySelector('[data-tab-id="workbench"]').getAttribute("aria-selected"), "true");

  Object.defineProperty(browser.document, "visibilityState", { configurable: true, value: "hidden" });
  t.after(() => { delete browser.document.visibilityState; });
  const before = heartbeatRequests;
  await act(async () => {
    for (const item of supportIntervals.filter((entry) => entry.active)) item.callback();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await waitFor(() => heartbeatRequests > before, 2000);
});

test("a hidden support tab does not mark an order group read until it is visible again", async (t) => {
  readRequests = [];
  const card = { pending: 0, failed: 0, skipped: 0, unknown: 0 };
  const row = order("order-a", "ZZ-A", "RENTING", card);
  api = { admin: "A", requests: [], nextCursor: null, page2: [], orders: [{ ...row, lastMessageAt: "2026-10-01T00:00:00.000Z", unreadCount: 0 }], orderAccess: syntheticOrderAccess() };
  const host = await mountWorkspace(t, "/support?section=orders&order=order-a");
  await waitFor(() => host.querySelector('.im-wb-pane--orders .im-wb-details')?.textContent.includes('本单详情'), 4000);
  await act(async () => host.querySelector('[data-tab-id="workbench"]').click());
  api.orders = [{ ...row, lastMessageAt: "2026-10-01T00:01:00.000Z", unreadCount: 2 }];
  await triggerOrderRefresh();
  await settle();
  assert.equal(readRequests.filter((request) => request.kind === "order").length, 0, "a hidden tab never marks the newly received order messages read");
  await act(async () => host.querySelector('[data-tab-id="support"]').click());
  await waitFor(() => readRequests.filter((request) => request.kind === "order").length === 1);
  assert.equal(readRequests.find((request) => request.kind === "order").id, "order-a");
});

test("same-session connection recovery retries the claim before logging into IM", async (t) => {
  api = {
    admin: "A", requests: [], nextCursor: null, page2: [], orders: [],
    presence: { availability: "AVAILABLE", connectionState: "DISCONNECTED", version: 1, stateRevision: 1, ownedByAnotherSession: false },
    connectResponses: [{ body: { ok: false, reason: "OTHER_WINDOW", version: 1, stateRevision: 1 } }],
  };
  const { host } = await mountView(t, snapshot([...permissions, "im.support.presence"]));
  await waitFor(() => host.textContent.includes("系统会自动尝试恢复"));
  assert.equal(api.connectRequests, 1);
  assert.equal(api.tokenRequests ?? 0, 0, "do not log in while the previous connection owns the lease");
  await act(async () => { browser.dispatchEvent(new browser.Event("online")); });
  await waitFor(() => api.tokenRequests === 1);
  assert.equal(api.connectRequests, 2, "retry the server claim before the new login");
});

test("pagehide waits for a pending previous lifecycle handoff before releasing the connection slot", async (t) => {
  api = { admin: "A", requests: [], nextCursor: null, page2: [], orders: [] };
  const { ImClientLifecycle } = await vite.ssrLoadModule("@zzsh/im-client/lifecycle");
  const originalClose = ImClientLifecycle.prototype.close;
  let closeCalls = 0;
  let releaseClose;
  const heldClose = new Promise((resolve) => { releaseClose = resolve; });
  ImClientLifecycle.prototype.close = function close() {
    closeCalls += 1;
    return closeCalls === 1 ? heldClose.then(() => originalClose.call(this)) : originalClose.call(this);
  };
  t.after(() => { ImClientLifecycle.prototype.close = originalClose; });
  const snap = snapshot([...permissions, "im.support.presence"]);
  const { root } = await mountView(t, snap);
  await waitFor(() => api.tokenRequests === 1);
  // Rebuilding the effect replaces lifecycleRef immediately, while the old
  // effect's close is still pending in the handoff chain.
  const next = { ...snap, session: { ...snap.session, id: "session-a2" } };
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: next, onRefresh: async () => next })); });
  await waitFor(() => closeCalls === 1);
  await act(async () => {
    browser.dispatchEvent(new browser.Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(api.releaseRequests?.length ?? 0, 0, "the server slot stays claimed while the old close is unproven");
  await act(async () => { releaseClose(); await new Promise((resolve) => setTimeout(resolve, 50)); });
  await waitFor(() => (api.releaseRequests?.length ?? 0) === 1);
  assert.equal(typeof api.releaseRequests[0].connectionId, "string", "release carries the exact connection instance after the handoff");
});

test("a temporary connection-claim outage retries without treating it as revoked permission", async (t) => {
  api = {
    admin: "A", requests: [], nextCursor: null, page2: [], orders: [],
    presence: { availability: "AVAILABLE", connectionState: "DISCONNECTED", version: 1, stateRevision: 1, ownedByAnotherSession: false },
    connectResponses: [{ body: { error: { code: "UNAVAILABLE", message: "synthetic" } }, status: 503 }],
  };
  const { host } = await mountView(t, snapshot([...permissions, "im.support.presence"]));
  await waitFor(() => host.textContent.includes("消息服务暂不可用，正在自动重试"));
  assert.equal(api.tokenRequests ?? 0, 0);
  await act(async () => { browser.dispatchEvent(new browser.Event("online")); });
  await waitFor(() => api.tokenRequests === 1);
  assert.equal(api.connectRequests, 2);
});

test("tab lease hands the single IM slot to the next tab only after the holder releases it", async () => {
  const previous = browser.navigator.locks;
  let holder = null;
  const queue = [];
  const startNext = () => {
    const next = queue.shift();
    if (next) { holder = next; next(); } else holder = null;
  };
  const fake = {
    request: async (_name, _options, callback) => {
      await new Promise((resolve, reject) => {
        const run = async () => {
          try { await callback(); resolve(); } catch (error) { reject(error); }
        };
        const hold = () => { void run().finally(() => { if (queue.length) startNext(); else holder = null; }); };
        if (holder) queue.push(hold); else { holder = hold; hold(); }
      });
    },
  };
  Object.defineProperty(browser.navigator, "locks", { configurable: true, value: fake });
  try {
    const { acquireSupportTabLease } = await vite.ssrLoadModule("/src/views/support-tab-lease.ts");
    const first = acquireSupportTabLease("tab-lease-test", new AbortController().signal);
    assert.equal(first.supported, true);
    assert.equal(await first.acquired, true);
    let secondGranted = false;
    const second = acquireSupportTabLease("tab-lease-test", new AbortController().signal);
    second.acquired.then((granted) => { secondGranted = granted; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(secondGranted, false, "the second tab waits while the first holds the IM slot");
    first.release();
    assert.equal(await second.acquired, true);
    assert.equal(secondGranted, true);
    second.release();

    const controller = new AbortController();
    const aborting = acquireSupportTabLease("tab-lease-abort", controller.signal);
    assert.equal(await aborting.acquired, true);
    controller.abort();
    const afterAbort = acquireSupportTabLease("tab-lease-abort", new AbortController().signal);
    let afterAbortGranted = false;
    afterAbort.acquired.then((granted) => { afterAbortGranted = granted; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(afterAbortGranted, false, "aborting a granted holder must wait for its explicit release");
    aborting.release();
    assert.equal(await afterAbort.acquired, true);
    afterAbort.release();
  } finally {
    Object.defineProperty(browser.navigator, "locks", { configurable: true, value: previous });
  }
});

test("tab lease failure is false and unsupported browsers use the server claim", async () => {
  const previous = browser.navigator.locks;
  try {
    Object.defineProperty(browser.navigator, "locks", { configurable: true, value: {
      request: async () => { throw new Error("denied"); },
    } });
    const { acquireSupportTabLease } = await vite.ssrLoadModule("/src/views/support-tab-lease.ts");
    assert.equal(await acquireSupportTabLease("tab-lease-denied", new AbortController().signal).acquired, false);
    Object.defineProperty(browser.navigator, "locks", { configurable: true, value: undefined });
    const unsupported = acquireSupportTabLease("tab-lease-unsupported", new AbortController().signal);
    assert.equal(unsupported.supported, false);
    assert.equal(await unsupported.acquired, true, "the server claim, not a fake local lock, decides the owner");
    unsupported.release();
  } finally {
    Object.defineProperty(browser.navigator, "locks", { configurable: true, value: previous });
  }
});

test("a stale heartbeat never replays an old CONNECTED into a new connection generation", () => {
  const client = {};
  const base = { liveConnection: "CONNECTED", terminal: undefined, sentGeneration: 2, liveGeneration: 2, sentClient: client, liveClient: client };
  assert.equal(staleHeartbeatRetryState(base), "CONNECTED", "the same live connection may refresh its revision");
  assert.equal(staleHeartbeatRetryState({ ...base, liveGeneration: 3 }), null, "a new connection generation rejects the old retry");
  assert.equal(staleHeartbeatRetryState({ ...base, liveClient: {} }), null, "a replaced NIM client rejects the old retry");
  assert.equal(staleHeartbeatRetryState({ ...base, liveConnection: "KICKED", terminal: "KICKED" }), "KICKED", "the current terminal event is recorded");
  assert.equal(staleHeartbeatRetryState({ ...base, liveConnection: "KICKED", terminal: undefined }), "KICKED", "a kick observed after the request is the live state");
  assert.equal(staleHeartbeatRetryState({ ...base, liveConnection: "DISCONNECTED", terminal: undefined }), "DISCONNECTED", "an old CONNECTED retry becomes the newer disconnect");
  assert.equal(staleHeartbeatRetryState({ ...base, liveConnection: "CONNECTED", terminal: "KICKED" }), null, "a terminal state blocks a lingering connected retry");
  assert.equal(staleHeartbeatRetryState({ ...base, liveConnection: "AUTH_FAILED", terminal: "AUTH_FAILED" }), "AUTH_FAILED");
});

test("reconnecting presence never looks like dispatchable reception", () => {
  const reconnecting = presenceRuntimeState("AVAILABLE", "RECONNECTING", false);
  assert.equal(reconnecting.connected, false);
  assert.equal(reconnecting.tone, "warn");
  assert.match(reconnecting.label, /连接异常/);
  assert.equal(reconnecting.toggleDisabled, false, "the operator can still end a stale AVAILABLE presence");
  assert.match(reconnecting.toggleTitle ?? "", /可先结束接待/);

  const connected = presenceRuntimeState("AVAILABLE", "CONNECTED", false);
  assert.equal(connected.label, "可接待");
  assert.equal(connected.toggleDisabled, false);

  const offDuty = presenceRuntimeState("OFF_DUTY", "RECONNECTING", false);
  assert.equal(offDuty.toggleDisabled, true, "starting reception still requires a connected channel");

  const otherWindow = presenceRuntimeState("AVAILABLE", "CONNECTED", false, true);
  assert.equal(otherWindow.label, "其他窗口接待中");
  assert.equal(otherWindow.tone, "warn");
  assert.equal(otherWindow.toggleLabel, "接管接待");
  assert.equal(otherWindow.toggleDisabled, false, "the other window can explicitly take over");

  const unbound = presenceRuntimeState("AVAILABLE", "CONNECTED", false, false, true);
  assert.equal(unbound.label, "需重新开始接待");
  assert.equal(unbound.toggleLabel, "开始接待");
  assert.equal(unbound.toggleDisabled, false, "an unbound old row needs an explicit start");

  const unboundReconnecting = presenceRuntimeState("AVAILABLE", "RECONNECTING", false, false, true);
  assert.match(unboundReconnecting.label, /需重新开始接待/);
  assert.doesNotMatch(unboundReconnecting.label, /接待中|可接待/, "an unbound old row is not on duty while reconnecting");
  assert.equal(unboundReconnecting.toggleDisabled, true);

  const kicked = presenceRuntimeState("AVAILABLE", "KICKED", false);
  assert.match(kicked.label, /被踢下线/);
  assert.equal(kicked.toggleLabel, "在此接待");
  assert.equal(kicked.toggleDisabled, false, "an explicit reconnect may retry after a kick");

  const authFailed = presenceRuntimeState("AVAILABLE", "AUTH_FAILED", false);
  assert.match(authFailed.label, /认证失败/);
  assert.equal(authFailed.toggleLabel, "重新连接");

  for (const state of ["KICKED", "AUTH_FAILED"]) {
    const stopped = presenceRuntimeState("OFF_DUTY", state, false);
    assert.match(stopped.label, /未接待/);
    assert.doesNotMatch(stopped.label, /接待中/);
    assert.equal(stopped.toggleLabel, "重新连接");
  }

  const pausedDispatch = presenceRuntimeState("AVAILABLE", "CONNECTED", false, false, false, true, false);
  assert.equal(pausedDispatch.label, "接待中 · 暂停派单");
  assert.equal(pausedDispatch.tone, "warn");

  const secondaryTab = presenceRuntimeState("AVAILABLE", "CONNECTED", false, false, false, false);
  assert.equal(secondaryTab.label, "其他窗口接待中");
  assert.equal(secondaryTab.toggleDisabled, true, "a non-holder tab never changes reception");

  assert.equal(presenceWriteSucceeded(undefined, "AVAILABLE"), false);
  assert.equal(presenceWriteSucceeded({ availability: "AVAILABLE", ownedByAnotherSession: true }, "AVAILABLE"), false, "another window's AVAILABLE is not this write's success");
  assert.equal(presenceWriteSucceeded({ availability: "AVAILABLE", unbound: true }, "AVAILABLE"), false);
  assert.equal(presenceWriteSucceeded({ availability: "AVAILABLE", ownedByAnotherSession: false, unbound: false }, "AVAILABLE"), true);
});
