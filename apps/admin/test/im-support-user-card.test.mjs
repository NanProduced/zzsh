import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 用户卡只展示用户与风险摘要；服务端仍返回的关联对象投影不再请求业务号或渲染入口。
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

async function mount(t, { context, scope = { profile: false, orders: false, resources: false }, onOpenProfile }) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path.endsWith("/context")) return context;
    if (path === "/users/user-a") return { user: { userId: "user-a", name: "用户 A", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, orderSummary: { state: "ready", count: 2 }, resourceSummary: { state: "denied" } } };
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
      ...(onOpenProfile ? { onOpenProfile } : {}),
    }));
  });
  await settle();
  await waitFor(() => rootNode.querySelector(".im-wb-card")?.textContent.includes("用户 A"));
  return { rootNode, calls };
}

test("resolved subject is never rendered or turned into a business-number request", async (t) => {
  const { rootNode, calls } = await mount(t, {
    context: {
      consultationId: "c-1",
      user: { status: "available", publicId: "user-a", displayName: "用户 A" },
      subject: { status: "resolved", kind: "ORDER", displayNo: "DD20261029001", title: "三角洲行动 · 全皮肤账号", target: { kind: "ORDER", id: "rental_order_2f1c9a70b30e4d01" } },
    },
  });
  const card = rootNode.querySelector(".im-wb-card");
  assert.doesNotMatch(card.textContent, /关联对象|DD20261029001|三角洲行动/);
  assert.doesNotMatch(card.textContent, /rental_order_2f1c9a70b30e4d01/);
  assert.equal(card.querySelector("[data-subject-status], [data-subject-display-no], [data-action='open-subject']"), null);
  assert.deepEqual(calls, ["/im/consultations/c-1/context"], "only the conversation context is read with its user");
});

test("profile facts still render without a subject footer", async (t) => {
  const { rootNode } = await mount(t, {
    scope: { profile: true, orders: true, resources: true },
    context: {
      consultationId: "c-1",
      user: { status: "available", publicId: "user-a", displayName: "用户 A" },
      subject: { status: "absent" },
    },
  });
  const card = rootNode.querySelector(".im-wb-card");
  assert.match(card.textContent, /138\*\*\*\*8000/);
  assert.match(card.textContent, /2 单/);
  assert.doesNotMatch(card.textContent, /关联对象|尚未关联|已关联/);
});
