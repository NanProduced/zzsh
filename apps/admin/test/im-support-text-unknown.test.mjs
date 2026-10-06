import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { after, test } from "node:test";
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
const consultation = {
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

test("admin consultation image UNKNOWN keeps the original id for the retry", async (t) => {
  const imageSends = [];
  let failNext = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
    if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [consultation] });
    if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
    if (url.pathname.endsWith("/im/messages")) {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.image) {
          imageSends.push(body);
          if (failNext) { failNext = false; return response({ error: { code: "INTERNAL_ERROR" } }, 500); }
          return response({ message: { messageClientId: body.image.messageClientId, messageServerId: "server-image", conversationId: body.conversationId, senderId: "admin-a", receiverId: "user-a", createTime: 4, messageType: 1, attachment: { imageId: "img-1", name: body.image.name, mimeType: body.image.mimeType, size: body.image.size } } });
        }
      }
      return response({ messages: [] });
    }
    throw new Error(`unexpected test request ${url.pathname}`);
  };
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  const originalCreateObjectUrl = globalThis.URL.createObjectURL;
  const originalRevokeObjectUrl = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = () => "blob:admin-preview-test";
  globalThis.URL.revokeObjectURL = () => {};
  t.after(async () => { await act(async () => root?.unmount()); rootNode.remove(); globalThis.URL.createObjectURL = originalCreateObjectUrl; globalThis.URL.revokeObjectURL = originalRevokeObjectUrl; });
  root = createRoot(rootNode);
  const permissions = ["im.support.read", "im.support.accept"];
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot(permissions) })); });
  await waitFor(() => Boolean(rootNode.querySelector('input[type="file"]')));
  const input = rootNode.querySelector('input[type="file"]');
  const file = new browser.File([new Uint8Array([1, 2, 3])], "proof.png", { type: "image/png" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await waitFor(() => Boolean(rootNode.querySelector(".im-support-pending-image")));
  assert.match(rootNode.querySelector(".im-support-pending-image").textContent, /未确认/);
  const firstId = imageSends[0].image.messageClientId;
  await act(async () => { [...rootNode.querySelectorAll(".im-support-pending-image button")].find((button) => button.textContent.includes("重试")).click(); });
  await waitFor(() => imageSends.length === 2);
  assert.equal(imageSends[1].image.messageClientId, firstId, "admin image retry reuses the original messageClientId");
});

test("admin consultation routes the normal send and Enter to the original message after an unknown result", async (t) => {
  const sends = [];
  let failNext = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
    if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [consultation] });
    if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
    if (url.pathname.endsWith("/im/messages")) {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        sends.push(body);
        if (failNext) { failNext = false; return response({ error: { code: "INTERNAL_ERROR" } }, 500); }
        return response({ message: { messageClientId: "retried", messageServerId: "retried", conversationId: body.conversationId, senderId: "admin-a", receiverId: "user-a", createTime: 3, text: body.text, messageType: 0 } });
      }
      return response({ messages: [] });
    }
    throw new Error(`unexpected test request ${url.pathname}`);
  };
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => { await act(async () => root?.unmount()); rootNode.remove(); });
  root = createRoot(rootNode);
  const permissions = ["im.support.read", "im.support.accept"];
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot(permissions) })); });
  await waitFor(() => Boolean(rootNode.querySelector("textarea") && !rootNode.querySelector("textarea").disabled));

  const type = async (value) => {
    await act(async () => {
      const element = rootNode.querySelector("textarea");
      const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
      setValue.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type("first");
  await act(async () => { rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
  assert.match(rootNode.textContent, /发送结果未确认/);
  assert.ok([...rootNode.querySelectorAll("button")].some((button) => button.textContent.includes("原消息重试")), "pending retry is offered");

  await type("second");
  await act(async () => { rootNode.querySelector(".im-support-send").click(); });
  await settle();
  assert.equal(sends.length, 2, "normal send must not create a second message beyond the retry");
  assert.equal(sends[0].text, "first");
  assert.equal(sends[1].text, "first", "the normal button replays the original message, not the newer draft");
  assert.equal(rootNode.querySelector("textarea").value, "second", "newer typing survives the original retry");
});
