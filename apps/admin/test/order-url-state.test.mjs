import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

/** 订单列表的非敏感筛选/页码与地址栏一致：刷新与前进后退可恢复，查找线索不落 URL。 */
const snapshot = {
  authenticated: true,
  adminUserId: "admin-order-url",
  user: { name: "订单客服", username: "ZZ-ORDER", twoFactorEnabled: true },
  security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
  session: { id: "session-order-url", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
  permissions: ["order.read"],
};

const order = {
  id: "order_url_1",
  displayNo: "ZZ20260930-000001",
  status: "PAID",
  accountId: "account_1",
  accountDisplayNo: null,
  title: "编号待核账号",
  gameId: "game_delta",
  ownerUserId: "user-owner-1",
  renterUserId: "user-renter-1",
  ownerName: "号主",
  renterName: "租客",
  createdAt: "2026-09-30T00:00:00.000000Z",
  paidAt: null,
  payment: { state: "RECORDED_PAID", recordedAt: "2026-09-30T00:10:00.000000Z", recordedAmount: { currency: "CNY", unit: "yuan", amount: "10.00", scale: 2 } },
  amounts: { totalDue: { currency: "CNY", unit: "yuan", amount: "10.00", scale: 2 }, rental: { currency: "CNY", unit: "yuan", amount: "10.00", scale: 2 }, deposit: { currency: "CNY", unit: "yuan", amount: "0.00", scale: 2 } },
  source: { origin: "NATIVE" },
};
const page = (items = [order], over = {}) => ({ items, page: 1, pageSize: 20, total: items.length, contextKey: "ctx-1", ...over });

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
}

async function setup(t) {
  const browser = new Window({ url: "http://127.0.0.1:4311/orders" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent,
    FormData: browser.FormData,
    CSS: browser.CSS,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const vite = await createOfflineAdminSource({ root: rootPath });
  const { AdminOrderChainView } = await vite.ssrLoadModule("/apps/admin/src/views/admin-order-chain-view.tsx");
  const node = browser.document.createElement("div");
  browser.document.body.append(node);
  const root = createRoot(node);
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    browser.happyDOM.abort();
  });
  return { browser, root, node, AdminOrderChainView };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
const until = async (predicate, detail = "") => {
  for (let index = 0; index < 120; index += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`order URL condition timed out ${detail}`);
};
const buttonNamed = (node, name) => [...node.querySelectorAll("button")].find((button) => button.textContent.trim() === name);
const buttonLabeled = (node, label) => [...node.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === label);
const selectNamed = (node, label) => [...node.querySelectorAll("select")].find((select) => select.getAttribute("aria-label") === label);

test("订单列表把状态/时间/页码写入地址栏，查找线索不落 URL，刷新按地址栏恢复", async (t) => {
  const { browser, root, node, AdminOrderChainView } = await setup(t);
  const queries = [];
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/orders?")) {
      urls.push(value);
      return response(page(undefined, { total: 45 }));
    }
    return response({ order });
  };
  const mount = async (initialQuery) =>
    act(async () => {
      root.render(
        createElement(AdminOrderChainView, {
          snapshot,
          objectOnly: false,
          initialQuery,
          onOpenPath: () => undefined,
          onQueryChange: (query) => queries.push(query),
          refreshNonce: 0,
        }),
      );
    });

  await mount(undefined);
  await until(() => node.textContent.includes(order.displayNo));
  assert.deepEqual(queries, [], "默认无筛选时不写地址栏");

  // 状态筛选 → 写入 URL 并随请求发出
  const statusSelect = selectNamed(node, "主状态");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLSelectElement.prototype, "value").set;
    setValue.call(statusSelect, "PAID");
    statusSelect.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  await act(async () => buttonNamed(node, "查询").click());
  await until(() => queries.at(-1)?.status === "PAID");
  assert.deepEqual(queries.at(-1), { status: "PAID" }, "状态筛选写入地址栏");
  await until(() => urls.at(-1).includes("status=PAID"));

  // 查找线索 → 不写入 URL
  const clue = [...node.querySelectorAll("input")].find((input) => input.getAttribute("aria-label") === "查找线索");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
    setValue.call(clue, "私密线索");
    clue.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await act(async () => buttonNamed(node, "查询").click());
  await until(() => urls.at(-1).includes("qValue="));
  assert.equal(queries.at(-1).qValue, undefined, "查找线索不写入地址栏");
  assert.equal(queries.at(-1).status, "PAID", "线索查询保留已选状态");

  // 刷新/重开：按地址栏恢复状态，线索需重输且如实提示
  await mount({ status: "CANCELLED" });
  await until(() => node.textContent.includes("查找线索需重新输入"));
  assert.equal(selectNamed(node, "主状态").value, "CANCELLED", "按地址栏恢复状态筛选");
  assert.equal(clue.value, "", "查找线索不按地址栏恢复");

  // 页码写入地址栏（分页按钮以 aria-label 标识）
  const nextButton = buttonLabeled(node, "下一页");
  await act(async () => nextButton?.click());
  await until(() => queries.at(-1)?.page === "2", `nextExists=${Boolean(nextButton)} lastQuery=${JSON.stringify(queries.at(-1))}`);
  assert.equal(queries.at(-1).status, "CANCELLED", "翻页保留筛选");
});
