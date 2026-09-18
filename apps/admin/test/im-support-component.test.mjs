import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/workspace/support" });
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

const intervalCallbacks = [];
const realSetInterval = browser.setInterval.bind(browser);
const realClearInterval = browser.clearInterval.bind(browser);
let fakeIntervalId = 0;
browser.setInterval = (callback, delay) => {
  if (delay === 5_000) {
    const id = `test-${++fakeIntervalId}`;
    intervalCallbacks.push({ callback, delay, id, active: true });
    return id;
  }
  return realSetInterval(callback, delay);
};
browser.clearInterval = (id) => {
  const callback = intervalCallbacks.find((entry) => entry.id === id);
  if (callback) callback.active = false;
  else realClearInterval(id);
};
globalThis.setInterval = browser.setInterval;
globalThis.clearInterval = browser.clearInterval;

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { ImSupportView } = await vite.ssrLoadModule("/src/views/im-support-view.tsx");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function snapshot(permissions) {
  return {
    authenticated: true,
    adminUserId: "admin-a",
    user: { name: "客服 A", username: "admin-a", displayUsername: "客服 A", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    session: { id: "session-a", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions,
  };
}

const serviceConsultation = {
  id: "consultation-a",
  type: "SERVICE",
  state: "ACTIVE",
  subjectRef: null,
  assignedAdmin: { id: "admin-a", name: "客服 A" },
  peerAccountId: "user-a",
  conversationType: "TEAM",
  conversationId: "team-a",
  messageScopeState: "READY",
  version: 1,
  lastMessageAt: null,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  user: { id: "user-a", name: "用户 A", username: "user-a" },
};
const historyMessage = {
  messageClientId: "message-client-a",
  messageServerId: "message-server-a",
  conversationId: "team-a",
  senderId: "user-a",
  receiverId: "admin-a",
  createTime: Date.parse("2026-09-17T00:01:00.000Z"),
  text: "保留的授权历史消息",
  messageType: 0,
};

const basePermissions = ["im.support.read", "im.support.accept"];
const requests = [];
let pendingSend;
let resolvePendingSend;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), browser.location.href);
  requests.push({ path: `${url.pathname}${url.search}`, method: init.method ?? "GET" });
  if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
  if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [serviceConsultation] });
  if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/im/messages")) {
    if (init.method === "POST") return pendingSend;
    return response({ messages: [historyMessage] });
  }
  throw new Error(`unexpected test request ${url.pathname}${url.search}`);
};

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

async function waitFor(predicate, timeout = 1_500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

test("support component preserves read state for send-only revoke and keeps session refresh after read revoke", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => {
    await act(async () => { root?.unmount(); });
    await vite.close();
  });
  root = createRoot(rootNode);
  let refreshCalls = 0;
  const onRefresh = async () => {
    refreshCalls += 1;
    return snapshot(basePermissions);
  };

  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(basePermissions), onRefresh })); });
  await waitFor(() => Boolean(rootNode.querySelector("textarea") && !rootNode.querySelector("textarea").disabled));
  await waitFor(() => [...rootNode.querySelectorAll(".im-support-bubble")].some((element) => element.textContent === "保留的授权历史消息"));
  const textarea = () => rootNode.querySelector("textarea");
  assert.ok(textarea());
  const tokenRequests = () => requests.filter((request) => request.path.endsWith("/im/token")).length;
  const queueRequests = () => requests.filter((request) => request.path.split("?")[0].endsWith("/im/consultations")).length;
  const sessionTimer = intervalCallbacks.find((entry) => entry.active && entry.delay === 5_000 && entry.callback);
  const queueTimer = intervalCallbacks.find((entry) => entry.active && entry.delay === 5_000 && entry.callback && entry !== sessionTimer);
  assert.ok(sessionTimer, "session refresh timer should be mounted");
  assert.ok(queueTimer, "queue refresh timer should start after the IM client becomes ready");
  const queueBefore = queueRequests();
  await act(async () => { queueTimer.callback(); await Promise.resolve(); });
  await settle();
  assert.equal(queueRequests(), queueBefore + 1);
  const tokenRequestsBeforeSendOnlyRevoke = tokenRequests();

  pendingSend = new Promise((resolve) => { resolvePendingSend = resolve; });
  await act(async () => {
    const element = textarea();
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
    setValue.call(element, "撤权中的草稿");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  assert.equal(textarea().value, "撤权中的草稿");
  assert.equal(rootNode.querySelector(".im-support-send").disabled, false);
  await act(async () => { rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  await settle();
  assert.match(rootNode.querySelector(".im-support-send").textContent, /处理中/);
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(["im.support.read"]), onRefresh })); });
  await settle();
  resolvePendingSend(response({ message: { ...historyMessage, messageClientId: "message-send-a", messageServerId: "message-send-a", senderId: "admin-a", receiverId: "user-a", text: "撤权期间的响应", createTime: Date.parse("2026-09-17T00:02:00.000Z") } }));
  await settle();
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(basePermissions), onRefresh })); });
  await settle();
  assert.doesNotMatch(rootNode.querySelector(".im-support-send").textContent, /处理中/);
  assert.equal(textarea().value, "撤权中的草稿");

  await act(async () => {
    const element = textarea();
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
    setValue.call(element, "保留中的草稿");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  assert.equal(textarea().value, "保留中的草稿");

  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(["im.support.read"]), onRefresh })); });
  await settle();
  assert.equal(textarea().disabled, true);
  assert.equal(textarea().value, "保留中的草稿");
  assert.equal(tokenRequests(), tokenRequestsBeforeSendOnlyRevoke);
  assert.equal([...rootNode.querySelectorAll(".im-support-bubble")].some((element) => element.textContent === "保留的授权历史消息"), true);

  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot([]), onRefresh })); });
  await settle();
  assert.equal(textarea().value, "");
  assert.equal(textarea().disabled, true);
  assert.equal(tokenRequests(), tokenRequestsBeforeSendOnlyRevoke);

  assert.equal(sessionTimer.active, true, "independent 5-second timer should remain mounted after read revoke");
  const before = refreshCalls;
  await act(async () => { sessionTimer.callback(); await Promise.resolve(); });
  assert.equal(refreshCalls, before + 1);

});
