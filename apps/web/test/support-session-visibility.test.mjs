import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4240/support" });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  NodeFilter: browser.NodeFilter,
  HTMLInputElement: browser.HTMLInputElement,
  MutationObserver: browser.MutationObserver,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
const { createRoot } = await import("react-dom/client");

// No provider alias here: this test must exercise the real UserSessionProvider
// and its real visibility -> store.confirm() -> loading -> authenticated path.
const vite = await createServer({
  root: webRoot,
  plugins: [react()],
  resolve: { alias: [
    { find: /^@\/components\/auth\/auth-overlay-provider$/, replacement: path.join(webRoot, "test", "stubs", "auth-overlay-provider.tsx") },
    { find: /^@\//, replacement: `${path.join(webRoot, "src")}/` },
  ] },
  server: { middlewareMode: true, hmr: false, ws: false },
});
const { UserSessionProvider, useUserSession } = await vite.ssrLoadModule("/src/components/session/user-session-provider.tsx");
const { CustomerSupportWorkspace } = await vite.ssrLoadModule("/src/components/support/customer-support-workspace.tsx");
const { AuthOverlayProvider } = await vite.ssrLoadModule("/test/stubs/auth-overlay-provider.tsx");
after(async () => { await vite.close(); });

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle(ms = 25) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

test("a same-user visibility confirmation keeps the IM connection; a real user switch rebuilds it", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalVisibility = Object.getOwnPropertyDescriptor(browser.document, "visibilityState");
  let tokenCalls = 0;
  let readCalls = 0;
  let historyRequested = false;
  let unread = true;
  const historyGate = deferred();
  let sessionRead = () => json({ user: { id: "user_A", name: "用户 A" } });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/auth/user/get-session")) return sessionRead();
    if (url.startsWith("/api/orders/")) return json({ items: [], nextCursor: null });
    if (url.includes("/im/token")) {
      tokenCalls += 1;
      return json({ appKey: "synthetic", accountId: "user_A", token: "synthetic", transport: "local-fake" });
    }
    if (/\/im\/consultations\/[^/]+\/read$/.test(url)) { readCalls += 1; unread = false; return json({ userReadAt: "2026-11-12T00:00:00Z" }); }
    if (url.includes("/im/consultations")) return json({ consultations: [{
      id: "round-1", threadId: "thread-1", roundId: "round-1", type: "SERVICE", state: "ACTIVE",
      conversationId: "team-1", messageScopeState: "READY", canSend: true, assignedAdmin: { id: "admin-1", name: "客服" },
      hasUnread: unread, userUnreadCount: unread ? 1 : 0, lastMessageAt: "2026-11-12T00:00:00Z",
    }] });
    if (url.includes("/im/message-access")) return json({ authorized: true });
    if (url.includes("/im/messages")) { historyRequested = true; await historyGate.promise; return json({ messages: [] }); }
    return json({});
  };
  Object.defineProperty(browser.document, "visibilityState", { configurable: true, get: () => "visible" });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalVisibility) Object.defineProperty(browser.document, "visibilityState", originalVisibility);
    else delete browser.document.visibilityState;
  });

  const statuses = [];
  function Probe() {
    const session = useUserSession();
    statuses.push(`${session.status}:${session.userId ?? ""}`);
    return createElement("span", { "data-session-status": session.status, "data-session-user": session.userId ?? "" });
  }

  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const until = async (predicate, label) => {
    for (let index = 0; index < 160; index += 1) {
      if (predicate()) return;
      await settle();
    }
    throw new Error(`${label} timed out`);
  };

  await act(async () => {
    root.render(createElement(UserSessionProvider, null,
      createElement(AuthOverlayProvider, null,
        createElement(Probe),
        createElement(CustomerSupportWorkspace, { preview: false, embedded: true, visible: true, onClose: () => {} }))));
  });
  await until(() => tokenCalls === 1, "initial IM connection");
  await until(() => historyRequested, "initial history request");

  // Same-user visibility confirmation: the provider deliberately goes through
  // `loading`. The workspace must keep the open lifecycle during that window.
  const sameUser = deferred();
  sessionRead = async () => sameUser.promise;
  await act(async () => { browser.document.dispatchEvent(new browser.Event("visibilitychange")); });
  await until(() => host.querySelector('[data-session-status="loading"]'), "same-user confirmation loading");
  assert.equal(tokenCalls, 1, "loading for the same subject must not close and reopen the IM connection");
  await act(async () => { historyGate.resolve(); await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.equal(readCalls, 0, "a hidden identity-confirmation screen must not mark the chat read");
  await act(async () => { sameUser.resolve(json({ user: { id: "user_A", name: "用户 A" } })); await new Promise((resolve) => setTimeout(resolve, 30)); });
  await until(() => host.querySelector('[data-session-status="authenticated"][data-session-user="user_A"]'), "same-user confirmation settles");
  assert.equal(tokenCalls, 1, "same-user confirmation keeps the existing IM connection");
  await until(() => readCalls === 1, "visible authenticated chat marks the message read");

  // A real identity switch changes the confirmed subject and must rebuild.
  const switched = deferred();
  sessionRead = async () => switched.promise;
  await act(async () => { browser.document.dispatchEvent(new browser.Event("visibilitychange")); });
  await until(() => host.querySelector('[data-session-status="loading"]'), "identity switch confirmation loading");
  await act(async () => { switched.resolve(json({ user: { id: "user_B", name: "用户 B" } })); await new Promise((resolve) => setTimeout(resolve, 30)); });
  await until(() => host.querySelector('[data-session-status="authenticated"][data-session-user="user_B"]'), "identity switch settles");
  await until(() => tokenCalls === 2, "identity switch opens the new subject connection");
  assert.ok(statuses.includes("loading:"), "the test exercised the real loading transition");
  assert.ok(statuses.includes("authenticated:user_B"));
});
