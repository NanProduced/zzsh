import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

// 组件源码经 createOfflineAdminSource 以 CommonJS 加载，React 必须来自同一实例（createRequire），
// 否则 hooks dispatcher 不同源，ContentView 会静默不渲染。
const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(tree, "apps/admin/package.json"));
const { act, createElement, useState } = require("react");

/**
 * ADM-BASIC-ADAPT-2 R1 回归：用真实 ContentView / AdminOrderChainView 组件 + 合成 DOM/fetch，
 * 复现 Root 评审的四个反例与权限默认反例，断言修复后的行为。
 * 证据边界：合成 DOM 与 fetch，不等于 PG / 真实 HTTP / 浏览器验收。
 */

const snapshot = (id, permissions) => ({
  authenticated: true,
  adminUserId: id,
  user: { name: "离线回归", username: id, twoFactorEnabled: true },
  security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
  session: { id: `session-${id}`, locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
  permissions,
});
const noop = () => undefined;
const money = (amount) => ({ currency: "CNY", unit: "yuan", amount, scale: 2 });
const order = {
  id: "order-r1", displayNo: "ORDER_R1", status: "PAID", accountId: "account-r1", accountDisplayNo: null,
  title: "离线资料", gameId: "game-r1", ownerUserId: "owner-r1", renterUserId: "renter-r1",
  ownerName: "号主", renterName: "租客", createdAt: "2026-10-18T00:00:00Z", paidAt: null,
  payment: { state: "RECORDED_PAID", recordedAt: null, recordedAmount: money("10.00") },
  amounts: { totalDue: money("10.00"), rental: money("10.00"), deposit: money("0.00") },
  source: { origin: "NATIVE" },
};

async function harness(t, { permissions, path: pathname = "/content", contentGames = [{ id: "game_1", code: "delta", name: "三角洲行动" }] }) {
  const browser = new Window({ url: `http://127.0.0.1:4311${pathname}` });
  Object.assign(globalThis, {
    window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
    Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent, FormData: browser.FormData, CSS: browser.CSS, SVGElement: browser.SVGElement,
    HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
    HTMLSelectElement: browser.HTMLSelectElement, DocumentFragment: browser.DocumentFragment,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const loader = await createOfflineAdminSource({ root: tree });
  const { ContentView } = await loader.ssrLoadModule("/apps/admin/src/views/content-view.tsx");
  const { AdminOrderChainView } = await loader.ssrLoadModule("/apps/admin/src/views/admin-order-chain-view.tsx");
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.method ?? "GET", "GET", "离线回归只做只读请求");
    const value = new URL(String(url), browser.location.href);
    requests.push(value.pathname + value.search);
    const body = value.pathname.endsWith("/orders")
      ? { items: [order], page: Number(value.searchParams.get("page") || 1), pageSize: Number(value.searchParams.get("pageSize") || 20), total: 60, contextKey: "ctx-r1" }
      : value.pathname.endsWith("/content/games")
        ? { games: contentGames }
        : { items: [], nextCursor: null, limit: 20 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  const until = async (predicate, detail = "") => {
    for (let index = 0; index < 120; index += 1) { if (predicate()) return; await settle(); }
    throw new Error(`R1 条件未满足 ${detail}`);
  };
  const mount = async (Component, props) => {
    const node = browser.document.createElement("div");
    browser.document.body.append(node);
    const root = createRoot(node);
    await act(async () => root.render(createElement(Component, props)));
    return { root, node: browser.document.body, element: node, close: async () => { await act(async () => root.unmount()); node.remove(); } };
  };
  const change = async (node, label, value) => {
    const element = node.querySelector(`[aria-label="${label}"]`);
    assert.ok(element, `控件存在：${label}`);
    const isSelect = element.tagName === "SELECT";
    await act(async () => {
      Object.getOwnPropertyDescriptor(isSelect ? browser.HTMLSelectElement.prototype : browser.HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new browser.Event(isSelect ? "change" : "input", { bubbles: true }));
    });
  };
  const click = async (node, label, aria = false) => {
    const button = [...node.querySelectorAll("button")].find((item) => (aria ? item.getAttribute("aria-label") : item.textContent.trim()) === label);
    assert.ok(button, `按钮存在：${label}`);
    await act(async () => button.click());
  };
  t.after(async () => { await loader.close(); browser.happyDOM.abort(); });
  return { browser, node: browser.document.body, requests, settle, until, mount, change, click, ContentView, AdminOrderChainView, permissions };
}

test("ADM-R1-01：父级每次渲染产生新回调并更新 tab 时，内容页回写必须收敛（不再 21 次）", async (t) => {
  const h = await harness(t, { permissions: ["content.platform.read"] });
  const calls = [];
  function ContentParent() {
    const [tab, setTab] = useState({ id: "content", kind: "content", path: "/content", title: "内容管理", closable: true, query: { tab: "announcement" } });
    return createElement(h.ContentView, {
      snapshot: snapshot("r1-content-parent", h.permissions),
      onDirtyChange: noop,
      refreshNonce: 0,
      tab,
      // 与 workspace/app-shell.tsx 的真实宿主一致：回调每次渲染都是新函数，并在回调里更新 tab。
      onQueryChange: (query) => { calls.push(query); setTab((current) => ({ ...current, query })); },
    });
  }
  const view = await h.mount(ContentParent, {});
  await h.settle();
  await h.settle();
  await h.settle();
  assert.deepEqual(calls, [], "query 已与地址一致时不回写");
  assert.equal(calls.length, 0, `相同 query 不得重复回写（实际 ${calls.length} 次）`);
  // 用户切换分区：恰好回写一次，且内容正确
  await h.click(view.element, "资讯");
  await h.until(() => calls.length === 1, `calls=${JSON.stringify(calls)}`);
  await h.settle();
  assert.deepEqual(calls, [{ tab: "news", scope: "platform" }], "切分区只回写一次且内容正确");
  // 再切一次：仍然每次只写一次
  await h.click(view.element, "平台公告");
  await h.until(() => calls.length === 2, `calls=${JSON.stringify(calls)}`);
  await h.settle();
  assert.deepEqual(calls.at(-1), { tab: "announcement" });
  assert.equal(calls.length, 2, "多次交互只产生对应次数的回写");
  await view.close();
});

test("ADM-R1-02：仅 content.read 且无 query 时，首个列表请求直接是游戏资讯（不先请求平台公告）", async (t) => {
  const h = await harness(t, { permissions: ["content.read"], path: "/content" });
  const view = await h.mount(h.ContentView, {
    snapshot: snapshot("r1-content-read-only", h.permissions),
    onDirtyChange: noop,
    refreshNonce: 0,
    tab: { id: "content", kind: "content", path: "/content", title: "内容管理", closable: true, query: {} },
    onQueryChange: noop,
  });
  await h.until(() => h.requests.some((url) => url.includes("/content/items")));
  const itemsRequests = h.requests.filter((url) => url.includes("/content/items"));
  const first = new URLSearchParams(itemsRequests[0].split("?")[1]);
  assert.equal(first.get("scope"), "game", "首个 items 请求为游戏范围");
  assert.equal(first.get("type"), "NEWS", "首个 items 请求为资讯");
  assert.equal(first.get("gameId"), "game_1", "带对象范围");
  assert.equal(itemsRequests.some((url) => url.includes("type=ANNOUNCEMENT")), false, "不得先请求平台公告");
  assert.equal(itemsRequests.some((url) => url.includes("scope=platform")), false, "不得先请求平台范围");
  assert.ok(view.element.textContent.includes("资讯"), "只渲染可访问分区");
  await view.close();
});

test("ADM-R1-03a：有线索时翻第二页仍写 page2，线索不落 URL", async (t) => {
  const h = await harness(t, { permissions: ["order.read"], path: "/orders" });
  const queries = [];
  const view = await h.mount(h.AdminOrderChainView, {
    snapshot: snapshot("r1-order-clue", h.permissions), onOpenPath: noop, refreshNonce: 0,
    initialQuery: {}, onQueryChange: (query) => queries.push(query),
  });
  await h.until(() => view.element.textContent.includes("ORDER_R1"));
  await h.change(view.element, "查找线索", "PRIVATE_CLUE_PROBE");
  await h.click(view.element, "查询");
  await h.until(() => h.requests.at(-1)?.includes("qValue=PRIVATE_CLUE_PROBE"));
  await h.click(view.element, "下一页", true);
  await h.until(() => h.requests.at(-1)?.includes("page=2"));
  await h.until(() => queries.some((query) => query.page === "2"), `queries=${JSON.stringify(queries)}`);
  assert.deepEqual(queries.at(-1), { page: "2" }, "只投影 page，线索不参与也不写入");
  assert.ok(h.requests.at(-1).includes("qValue=PRIVATE_CLUE_PROBE"), "线索仍随请求发送");
  assert.equal(JSON.stringify(queries).includes("PRIVATE_CLUE_PROBE"), false, "线索不出现在任何 URL 写回里");
  await view.close();
});

test("ADM-R1-03b：UI 每页 3 条与 URL 往返一致", async (t) => {
  const h = await harness(t, { permissions: ["order.read"], path: "/orders" });
  const queries = [];
  const view = await h.mount(h.AdminOrderChainView, {
    snapshot: snapshot("r1-order-size", h.permissions), onOpenPath: noop, refreshNonce: 0,
    initialQuery: {}, onQueryChange: (query) => queries.push(query),
  });
  await h.until(() => view.element.textContent.includes("ORDER_R1"));
  await h.change(view.element, "每页条数", "3");
  await h.until(() => h.requests.at(-1)?.includes("pageSize=3"));
  await h.until(() => queries.some((query) => query.size === "3"), `queries=${JSON.stringify(queries)}`);
  assert.deepEqual(queries.at(-1), { size: "3" }, "选 3 回写 size=3");
  assert.equal(view.element.querySelector('[aria-label="每页条数"]').value, "3");
  await view.close();
  // 全新挂载 size=3：必须恢复成 3，而不是 20
  const reloaded = await h.mount(h.AdminOrderChainView, {
    snapshot: snapshot("r1-order-size-reload", h.permissions), onOpenPath: noop, refreshNonce: 0,
    initialQuery: { size: "3" }, onQueryChange: noop,
  });
  await h.until(() => reloaded.element.textContent.includes("ORDER_R1"));
  assert.equal(reloaded.element.querySelector('[aria-label="每页条数"]').value, "3", "按 URL 恢复每页 3 条");
  assert.ok(h.requests.at(-1).includes("pageSize=3"), "恢复后请求按 3 条");
  await reloaded.close();
});

test("ADM-R1-03c：显式 CANCELLED 地址优先于旧 PAID/page2 缓存", async (t) => {
  const h = await harness(t, { permissions: ["order.read"], path: "/orders" });
  const queries = [];
  const first = await h.mount(h.AdminOrderChainView, {
    snapshot: snapshot("r1-order-cache", h.permissions), onOpenPath: noop, refreshNonce: 0,
    initialQuery: { status: "PAID", page: "2" }, onQueryChange: (query) => queries.push(query),
  });
  await h.until(() => first.element.textContent.includes("ORDER_R1"));
  await first.close();
  h.requests.length = 0;
  queries.length = 0;
  const second = await h.mount(h.AdminOrderChainView, {
    snapshot: snapshot("r1-order-cache", h.permissions), onOpenPath: noop, refreshNonce: 0,
    initialQuery: { status: "CANCELLED" }, onQueryChange: (query) => queries.push(query),
  });
  await h.until(() => second.element.textContent.includes("ORDER_R1"));
  await h.settle();
  assert.equal(second.element.querySelector('[aria-label="主状态"]').value, "CANCELLED", "显式地址覆盖旧缓存");
  assert.ok(h.requests.at(-1).includes("status=CANCELLED"), `请求按 CANCELLED：${h.requests.at(-1)}`);
  assert.equal(h.requests.at(-1).includes("status=PAID"), false, "不得回到旧 PAID");
  assert.equal(queries.some((query) => query.status === "PAID"), false, "不得把旧缓存写回地址");
  await second.close();
});

test("同一订单列表返回时保留本地线索，线索仍不进入地址栏", async (t) => {
  const h = await harness(t, { permissions: ["order.read"], path: "/orders" });
  const queries = [];
  const props = {
    snapshot: snapshot("root-order-return", h.permissions), onOpenPath: noop, refreshNonce: 0,
    initialQuery: {}, onQueryChange: (query) => queries.push(query),
  };
  const first = await h.mount(h.AdminOrderChainView, props);
  await h.until(() => first.element.textContent.includes("ORDER_R1"));
  await h.change(first.element, "查找线索", "ORDER_R1");
  await h.click(first.element, "查询");
  await h.until(() => h.requests.at(-1)?.includes("qValue=ORDER_R1"));
  await first.close();
  h.requests.length = 0;
  const returned = await h.mount(h.AdminOrderChainView, props);
  await h.until(() => returned.element.textContent.includes("ORDER_R1"));
  assert.equal(returned.element.querySelector('[aria-label="查找线索"]').value, "ORDER_R1");
  assert.ok(h.requests.at(-1).includes("qValue=ORDER_R1"), "同地址返回保持原查找范围");
  assert.equal(JSON.stringify(queries).includes("ORDER_R1"), false, "线索始终只留在内存");
  await returned.close();
});
