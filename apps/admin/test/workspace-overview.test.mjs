import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

const snapshot = (id = "overview_boss") => ({ authenticated: true, adminUserId: id,
  user: { name: "测试管理员", twoFactorEnabled: true }, security: { status: "ACTIVE", isBoss: true, passwordChangeRequired: false },
  session: { id: `session_${id}`, locked: false, pinConfigured: false }, permissions: ["order.read", "finance.read", "user.directory.read"] });
const ids = ["usersTotal", "usersNew", "accountsTotal", "accountsPublished", "listingsPendingReview", "ordersCreated", "ordersPendingPayment", "ordersPaid", "legacyOrdersTotal", "paymentsConfirmed", "confirmedCents", "supportWaiting", "supportMine"];
const payload = (range = "7d") => ({ version: "admin.overview.v1", observedAt: "2026-11-02T02:00:00Z",
  period: { range, from: "2026-10-27T16:00:00Z", to: "2026-11-02T02:00:00Z", timeZone: "Asia/Shanghai" }, scope: { mode: "ALL_GAMES", gameIds: [] },
  metrics: ids.map(id => ({ id, value: id === "confirmedCents" ? "12345" : "7", unit: id === "confirmedCents" ? "CNY_CENTS" : "COUNT", state: "KNOWN", drilldown: id === "ordersPendingPayment" ? "/orders?origin=NATIVE&status=PENDING_PAYMENT&paymentOpen=true" : id === "ordersCreated" ? "/orders?origin=NATIVE&createdFrom=2026-10-27T16%3A00%3A00Z&createdTo=2026-11-02T02%3A00%3A00Z" : id === "confirmedCents" ? "/orders?origin=NATIVE&paymentConfirmedFrom=2026-10-27T16%3A00%3A00Z&paymentConfirmedTo=2026-11-02T02%3A00%3A00Z" : null })),
  trend: [{ date: "2026-11-02", orders: "7", payments: "3", confirmedCents: "12345" }] });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function harness(t, handler, identity = snapshot()) {
  const browser = new Window({ url: "http://127.0.0.1:4221/workbench" });
  for (const key of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "ResizeObserver", "DOMRect", "HTMLInputElement", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLSelectElement", "DocumentFragment", "SVGElement"]) if (browser[key]) globalThis[key] = browser[key];
  Object.assign(globalThis, { window: browser, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const beforeFetch = globalThis.fetch, requests = [], navigations = [];
  globalThis.fetch = async (input, init = {}) => { const url = new URL(String(input), browser.location.href); requests.push({ url, init }); return handler(url, init, requests.length); };
  const source = await createOfflineAdminSource({ root: fileURLToPath(new URL("../../../", import.meta.url)) });
  const module = await source.ssrLoadModule("/apps/admin/src/workspace/overview.tsx");
  const { createRoot } = await import("react-dom/client");
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  const root = createRoot(container);
  const render = async (next = identity) => { identity = next; await act(async () => root.render(createElement(module.WorkspaceOverview, { snapshot: identity, onNavigate: path => navigations.push(path), refreshNonce: 0 }))); };
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const click = async text => { const button = [...container.querySelectorAll("button")].find(node => node.textContent.trim() === text); assert.ok(button, `button ${text}`); await act(async () => button.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }))); await settle(); };
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = beforeFetch; container.remove(); await source.close(); await browser.happyDOM.abort(); });
  await render(); await settle();
  return { container, browser, requests, navigations, module, render, settle, click, text: () => container.textContent };
}

test("overview uses one ordinary GET and distinguishes accounting facts from bank arrival", async t => {
  const h = await harness(t, () => response(payload()));
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url.pathname, "/api/bff/admin/workspace/overview");
  assert.equal(h.requests[0].url.search, "?range=7d");
  assert.equal(h.requests[0].init.method, "GET"); assert.equal(h.requests[0].init.body, undefined);
  assert.match(h.text(), /本站确认收款/); assert.match(h.text(), /¥123\.45/);
  assert.match(h.text(), /不代表渠道或银行到账/); assert.match(h.text(), /含导入，并非旧平台注册时间/);
  assert.match(h.text(), /当前发布状态，不等于当前可租/); assert.match(h.text(), /已载入历史订单/);
  assert.equal(h.container.querySelectorAll(".overview-trend-data tbody tr").length, 1);
  await h.click("订单待付款7");
  assert.deepEqual(h.navigations, ["/orders?origin=NATIVE&status=PENDING_PAYMENT&paymentOpen=true"]);
});

test("unavailable and out-of-scope metrics render unknown, and forbidden metrics never expose a count or link", async t => {
  const data = payload(); data.trend = [];
  data.metrics = data.metrics.map(metric => ({ ...metric, value: null, state: metric.id === "confirmedCents" ? "FORBIDDEN" : metric.id === "supportMine" ? "UNAVAILABLE" : "NO_GAME_SCOPE" }));
  const h = await harness(t, () => response(data));
  assert.equal(h.container.querySelector('[data-metric="confirmedCents"]'), null);
  assert.match(h.text(), /不在当前游戏范围/); assert.match(h.text(), /能力尚未装配/);
  assert.doesNotMatch(h.text(), /¥0|7条|¥123/);
  assert.equal(h.container.querySelectorAll(".overview-metrics button:not(:disabled),.overview-queues button:not(:disabled)").length, 0);
});

test("same-session lock and permission change clear data immediately and discard late responses", async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = await harness(t, (_url, _init, n) => n === 1 ? response(payload()) : pending);
  assert.match(h.text(), /¥123\.45/);
  await h.click("近30天");
  assert.doesNotMatch(h.text(), /¥123\.45/);
  const locked = snapshot(); locked.session.locked = true;
  await h.render(locked);
  assert.equal(h.text(), ""); assert.equal(h.requests[1].init.signal.aborted, true);
  await act(async () => release(response(payload("30d")))); await h.settle();
  assert.equal(h.text(), "");
});

test("a fresh failed read removes prior totals and provides a retry without manufacturing zeros", async t => {
  const h = await harness(t, (_url, _init, n) => n === 1 ? response(payload()) : response({ error: { code: "UNAVAILABLE" } }, 503));
  assert.match(h.text(), /¥123\.45/);
  await h.click("今天");
  assert.match(h.text(), /经营数据暂时无法读取/); assert.doesNotMatch(h.text(), /¥123\.45|¥0\.00/);
  assert.ok([...h.container.querySelectorAll("button")].some(button => button.textContent === "重试概览"));
});

test("wrong period, duplicate metrics and invalid known values are rejected rather than displayed", async t => {
  const h = await harness(t, () => response(payload()));
  for (const mutate of [
    data => data.metrics.push(data.metrics[0]),
    data => data.metrics[0].value = null,
    data => data.metrics[0].value = "1.5",
    data => data.metrics[0].state = "MADE_UP",
    data => data.trend[0].orders = "NaN",
  ]) {
    const data = payload(); mutate(data); assert.throws(() => h.module.parseWorkspaceOverview(data), /OVERVIEW_CONTRACT_INVALID/);
  }
  await h.click("今天");
  assert.match(h.text(), /经营数据暂时无法读取/);
});

test("exact cents remain exact beyond floating point range and missing values never become zero", async t => {
  const h = await harness(t, () => response(payload()));
  assert.equal(h.module.overviewMetricText({ id: "money", unit: "CNY_CENTS", value: "900719925474099399", state: "KNOWN" }), "¥9,007,199,254,740,993.99");
  assert.equal(h.module.overviewMetricText({ id: "money", unit: "CNY_CENTS", value: "0", state: "KNOWN" }), "¥0.00");
  assert.equal(h.module.overviewMetricText({ id: "money", unit: "CNY_CENTS", value: null, state: "FORBIDDEN" }), "—");
});

test("all-forbidden identity keeps the workbench useful without leaking old overview data", async t => {
  const hidden = payload(); hidden.trend = []; hidden.metrics = hidden.metrics.map(metric => ({ ...metric, value: null, state: "FORBIDDEN" }));
  const h = await harness(t, (_url, _init, n) => response(n === 1 ? payload() : hidden));
  const ordinary = snapshot("staff"); ordinary.security.isBoss = false; ordinary.permissions = [];
  await h.render(ordinary); await h.settle();
  assert.match(h.text(), /当前没有可展示的经营数据/); assert.doesNotMatch(h.text(), /¥123\.45|本站确认收款|用户档案 7/);
});

test('server drilldowns preserve their exact source and period and reject foreign or command navigation', async t => {
  const h = await harness(t, () => response(payload()));
  const good = '/orders?origin=NATIVE&paymentConfirmedFrom=2026-10-27T16%3A00%3A00.000Z&paymentConfirmedTo=2026-11-02T02%3A00%3A00.000Z';
  assert.equal(h.module.overviewDrilldown({ state: 'KNOWN', drilldown: good }), good);
  for (const path of ['https://evil.example/orders', '//evil.example/orders', '/orders?next=https://evil.example', '/orders?origin=NATIVE&origin=LEGACY', '/orders#command', '/api/v1/admin/orders/order-A/manual-close']) {
    assert.equal(h.module.overviewDrilldown({ state: 'KNOWN', drilldown: path }), null, path);
  }
  assert.equal(h.module.overviewDrilldown({ state: 'FORBIDDEN', drilldown: '/orders' }), null);
  assert.equal(h.module.overviewDrilldown({ state: 'KNOWN', drilldown: null }), null);
  const card = h.container.querySelector('[data-metric="accountsPublished"]');
  assert.equal(card.querySelector('button').disabled, true, 'unsupported matching filters never fall back to a related list');
  assert.match(card.textContent, /暂无同口径明细/);
});
