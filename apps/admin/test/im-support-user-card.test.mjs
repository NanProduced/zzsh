import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

/**
 * D-01：右栏「关联对象」的 resolved / unresolved / absent 三条渲染路径。
 * request 由调用方注入，测试不碰真实网络；未解析对象不暴露裸引用。
 */

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4241/support?preview=1" });
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
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

browser.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});

const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false, ws: false },
});
const { ConsultationUserCard } = await vite.ssrLoadModule("/src/views/im-support-user-card.tsx");
after(async () => { await vite.close(); });

async function settle(ms = 20) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function waitFor(predicate, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

const scope = { profile: false, orders: false, resources: false };

async function mount(t, { context, onOpenSubject, onOpenProfile }) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path.endsWith("/context")) return context;
    throw new Error(`unexpected test request ${path}`);
  };
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    rootNode.remove();
  });
  await act(async () => {
    root.render(createElement(ConsultationUserCard, {
      consultationId: "c-1",
      rowUserId: "user-a",
      fallbackName: "用户 A",
      scope,
      request,
      ...(onOpenSubject ? { onOpenSubject } : {}),
      ...(onOpenProfile ? { onOpenProfile } : {}),
    }));
  });
  await settle();
  await waitFor(() => rootNode.querySelector('[data-subject-status], .im-rail-value'));
  return { rootNode, calls };
}

const footerOf = (rootNode) => rootNode.querySelector(".im-wb-card");

test("resolved 订单：类型 + 业务展示号 + 标题 + 可跳转入口，id 不上屏", async (t) => {
  const opened = [];
  const { rootNode } = await mount(t, {
    context: {
      consultationId: "c-1",
      user: { status: "available", publicId: "user-a", displayName: "用户 A" },
      subject: {
        status: "resolved", kind: "ORDER", displayNo: "DD20261029001",
        title: "三角洲行动 · 全皮肤账号",
        target: { kind: "ORDER", id: "rental_order_2f1c9a70b30e4d01" },
      },
    },
    onOpenSubject: (target, label) => opened.push({ target, label }),
  });

  const card = footerOf(rootNode);
  assert.match(card.textContent, /关联对象 · 订单/);
  assert.match(card.textContent, /DD20261029001/);
  assert.match(card.textContent, /三角洲行动 · 全皮肤账号/, "订单标题要显示");
  assert.doesNotMatch(card.textContent, /rental_order_2f1c9a70b30e4d01/, "内部主键不得上屏");

  const status = rootNode.querySelector("[data-subject-status]");
  assert.equal(status.dataset.subjectStatus, "resolved");
  assert.equal(status.dataset.subjectKind, "ORDER");

  const button = rootNode.querySelector('[data-action="open-subject"]');
  assert.ok(button, "resolved 且有 target 时必须给入口");
  assert.equal(button.textContent, "DD20261029001", "按钮文案用业务展示号");
  await act(async () => button.click());
  assert.deepEqual(opened, [{ target: { kind: "ORDER", id: "rental_order_2f1c9a70b30e4d01" }, label: "DD20261029001" }]);
});

test("resolved 资源账号：title 为 null 时不渲染标题行，入口类型是 ACCOUNT", async (t) => {
  const opened = [];
  const { rootNode } = await mount(t, {
    context: {
      consultationId: "c-1",
      user: { status: "available", publicId: "user-a", displayName: "用户 A" },
      subject: { status: "resolved", kind: "ACCOUNT", displayNo: "AC88231", title: null, target: { kind: "ACCOUNT", id: "acct_01" } },
    },
    onOpenSubject: (target) => opened.push(target),
  });
  const card = footerOf(rootNode);
  assert.match(card.textContent, /关联对象 · 资源账号/);
  assert.match(card.textContent, /AC88231/);
  assert.equal(rootNode.querySelector("[data-subject-title]"), null, "账号没有订单标题，就不该有空标题行");

  const button = rootNode.querySelector('[data-action="open-subject"]');
  await act(async () => button.click());
  assert.deepEqual(opened, [{ kind: "ACCOUNT", id: "acct_01" }]);
});

test("resolved 但缺 target：只展示业务号，不给假入口", async (t) => {
  const { rootNode } = await mount(t, {
    context: {
      consultationId: "c-1",
      user: { status: "available", publicId: "user-a", displayName: "用户 A" },
      subject: { status: "resolved", kind: "ORDER", displayNo: "DD0001", title: null },
    },
    onOpenSubject: () => { throw new Error("should not open without target"); },
  });
  assert.equal(rootNode.querySelector('[data-action="open-subject"]'), null);
  assert.match(rootNode.querySelector("[data-subject-display-no]").textContent ?? "", /DD0001/);
});

test("resolved 但缺业务展示号：退回兑底文案，不拿内部 id 顶单号", async (t) => {
  const { rootNode } = await mount(t, {
    context: {
      consultationId: "c-1",
      user: { status: "available", publicId: "user-a", displayName: "用户 A" },
      subject: { status: "resolved", kind: "ORDER", target: { kind: "ORDER", id: "rental_order_2f1c9a70b30e4d01" } },
    },
    onOpenSubject: () => { throw new Error("should not open"); },
  });
  const card = footerOf(rootNode);
  assert.match(card.textContent, /关联对象类型暂未确认/);
  assert.doesNotMatch(card.textContent, /rental_order_2f1c9a70b30e4d01/);
  assert.equal(rootNode.querySelector('[data-action="open-subject"]'), null);
});

test("unresolved：明确暂未识别，不暴露裸引用也不给入口", async (t) => {
  const { rootNode } = await mount(t, {
    context: {
      consultationId: "c-1",
      user: { status: "available", publicId: "user-a", displayName: "用户 A" },
      subject: { status: "unresolved", rawRef: "550e8400-e29b-41d4-a716-446655440000" },
    },
    onOpenSubject: () => { throw new Error("unresolved must not open"); },
  });
  const card = footerOf(rootNode);
  assert.match(card.textContent, /关联对象暂未识别/);
  assert.doesNotMatch(card.textContent, /550e8400/, "裸引用（可能是 UUID）不上屏");
  assert.equal(rootNode.querySelector('[data-action="open-subject"]'), null);
});

test("absent：说明尚未关联，不出现任何对象号码", async (t) => {
  const { rootNode } = await mount(t, {
    context: {
      consultationId: "c-1",
      user: { status: "available", publicId: "user-a", displayName: "用户 A" },
      subject: { status: "absent" },
    },
  });
  assert.match(footerOf(rootNode).textContent, /尚未关联商品或订单/);
  assert.equal(rootNode.querySelector('[data-action="open-subject"]'), null);
});

test("调用方没给 onOpenSubject 时：resolved 只展示业务号，不渲染按钮", async (t) => {
  const { rootNode } = await mount(t, {
    context: {
      consultationId: "c-1",
      user: { status: "available", publicId: "user-a", displayName: "用户 A" },
      subject: { status: "resolved", kind: "ORDER", displayNo: "DD0002", title: null, target: { kind: "ORDER", id: "order_02" } },
    },
  });
  assert.equal(rootNode.querySelector('[data-action="open-subject"]'), null);
  assert.match(rootNode.querySelector("[data-subject-display-no]").textContent ?? "", /DD0002/);
});
