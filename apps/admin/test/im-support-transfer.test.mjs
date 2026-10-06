import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/workspace/support" });
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
const { ImSupportView } = await vite.ssrLoadModule("/src/views/im-support-view.tsx");
after(async () => { await vite.close(); });

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

const waitingConsultation = {
  id: "consultation-waiting",
  type: "SERVICE",
  state: "WAITING",
  subjectRef: null,
  assignedAdmin: null,
  peerAccountId: "user-w",
  conversationType: "TEAM",
  conversationId: null,
  messageScopeState: "PENDING",
  version: 1,
  lastMessageAt: null,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  user: { id: "user-w", name: "用户 W", username: "user-w" },
};
const activeConsultation = {
  id: "consultation-active",
  type: "SERVICE",
  state: "ACTIVE",
  subjectRef: null,
  assignedAdmin: { id: "admin-a", name: "客服 A" },
  peerAccountId: "user-a",
  conversationType: "TEAM",
  conversationId: "team-a",
  messageScopeState: "READY",
  version: 1,
  lastMessageAt: "2026-09-17T00:05:00.000Z",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:05:00.000Z",
  user: { id: "user-a", name: "用户 A", username: "user-a" },
};

const requests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), browser.location.href);
  requests.push({ path: `${url.pathname}${url.search}`, method: init.method ?? "GET", body: init.body });
  if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
  if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [waitingConsultation, activeConsultation] });
  if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/im/messages")) return response({ messages: [] });
  if (url.pathname.endsWith("/im/transfer-targets")) return response({ targets: [{ adminUserId: "admin-b", displayName: "客服 B" }], transferReady: true });
  if (url.pathname.endsWith("/consultations/consultation-active/transfer")) {
    return response({ consultation: { ...activeConsultation, assignedAdmin: { id: "admin-b", name: "客服 B" } } });
  }
  throw new Error(`unexpected test request ${url.pathname}${url.search}`);
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

test("support workbench groups the queue, marks local unread and runs the transfer dialog", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => {
    await act(async () => { root?.unmount(); });
    rootNode.remove();
  });
  root = createRoot(rootNode);
  const permissions = ["im.support.read", "im.support.accept", "im.support.transfer", "im.support.presence"];
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot(permissions) })); });
  await waitFor(() => rootNode.querySelectorAll(".im-support-queue-item").length === 2);

  const groups = [...rootNode.querySelectorAll(".im-support-queue-group")].map((element) => element.textContent);
  assert.ok(groups.some((label) => label.includes("待接入")), `queue groups the waiting item, got ${JSON.stringify(groups)}`);
  assert.ok(groups.some((label) => label.includes("处理中")), `queue groups the active item, got ${JSON.stringify(groups)}`);

  const unreadBadge = rootNode.querySelector('.im-support-queue-item[data-active="false"] .im-support-queue-meta b');
  assert.ok(unreadBadge, "the unselected assigned conversation shows a local unread badge");

  const activeItem = [...rootNode.querySelectorAll(".im-support-queue-item")].find((item) => item.textContent.includes("用户 A"));
  await act(async () => { activeItem.click(); });
  await settle();
  await act(async () => { rootNode.querySelector('[data-action="toggle-consultation-context"]').click(); });
  await waitFor(() => rootNode.querySelector(".im-support-inspector"));
  const transferButton = rootNode.querySelector('[data-action="open-transfer"]');
  assert.ok(transferButton && !transferButton.disabled, "transfer is enabled for the assigned READY consultation");
  await act(async () => { transferButton.click(); });
  await waitFor(() => browser.document.querySelector(".im-support-dialog"));
  assert.ok(requests.some((request) => request.path.includes("/im/transfer-targets?consultationId=consultation-active")), "the dialog reads transfer targets for the selected consultation");
  const target = [...browser.document.querySelectorAll(".im-support-dialog-list button")].find((button) => button.textContent.includes("客服 B"));
  assert.ok(target, "eligible target is listed");
  await act(async () => { target.click(); });
  await settle();
  const transferRequest = requests.find((request) => request.path.endsWith("/consultations/consultation-active/transfer"));
  assert.ok(transferRequest, "the transfer command is submitted");
  assert.deepEqual(JSON.parse(transferRequest.body), { targetAdminId: "admin-b" });
  assert.equal(browser.document.querySelector(".im-support-dialog"), null, "dialog closes after the transfer");
  assert.match(rootNode.textContent, /已转交当前咨询/);
  assert.match(rootNode.textContent, /客服 B/, "the queue reflects the new assignee");
});

test("transfer dialog reports an unavailable service when the target route fails", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/im/transfer-targets")) return response({ error: { code: "NOT_FOUND" } }, 404);
    return originalFetch(input, init);
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await act(async () => { root?.unmount(); });
    rootNode.remove();
  });
  root = createRoot(rootNode);
  const permissions = ["im.support.read", "im.support.accept", "im.support.transfer"];
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot(permissions) })); });
  await waitFor(() => rootNode.querySelectorAll(".im-support-queue-item").length === 2);
  const activeItem = [...rootNode.querySelectorAll(".im-support-queue-item")].find((item) => item.textContent.includes("用户 A"));
  await act(async () => { activeItem.click(); });
  await settle();
  await act(async () => { rootNode.querySelector('[data-action="toggle-consultation-context"]').click(); });
  await waitFor(() => rootNode.querySelector('[data-action="open-transfer"]'));
  await act(async () => { rootNode.querySelector('[data-action="open-transfer"]').click(); });
  await waitFor(() => browser.document.querySelector(".im-support-dialog-error"));
  assert.match(browser.document.querySelector(".im-support-dialog-error").textContent, /暂不可用/);
});
