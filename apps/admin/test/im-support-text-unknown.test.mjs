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
  if (url.pathname.endsWith("/context")) return response({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-7", displayName: "测试用户甲", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (url.pathname.includes("/users/")) return response({ userId: "user-7", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
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
  const originalImage = globalThis.Image;
  globalThis.Image = class {
    constructor() { this.naturalWidth = 8; this.naturalHeight = 8; }
    set src(_value) { queueMicrotask(() => this.onload?.()); }
  };
  t.after(async () => { await act(async () => root?.unmount()); rootNode.remove(); globalThis.URL.createObjectURL = originalCreateObjectUrl; globalThis.URL.revokeObjectURL = originalRevokeObjectUrl; globalThis.Image = originalImage; });
  root = createRoot(rootNode);
  const permissions = ["im.support.read", "im.support.accept"];
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot(permissions) })); });
  await waitFor(() => Boolean(rootNode.querySelector('input[type="file"]')));
  const input = rootNode.querySelector('input[type="file"]');
  const file = new browser.File([new Uint8Array([1, 2, 3])], "proof.png", { type: "image/png" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  // Choosing a file must never put anything on the wire on its own.
  await waitFor(() => Boolean(rootNode.querySelector('.im-wb-tray-item[data-state="READY"]')));
  assert.equal(imageSends.length, 0, "staging an image must not send it");
  assert.equal(rootNode.querySelector(".im-wb-draft"), null);
  await act(async () => { rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await waitFor(() => Boolean(rootNode.querySelector(".im-wb-draft")));
  assert.match(rootNode.querySelector(".im-wb-draft").textContent, /未确认/);
  const firstId = imageSends[0].image.messageClientId;
  await act(async () => { [...rootNode.querySelectorAll(".im-wb-draft button")].find((button) => button.textContent.includes("重试")).click(); });
  await waitFor(() => imageSends.length === 2);
  assert.equal(imageSends[1].image.messageClientId, firstId, "admin image retry reuses the original messageClientId");
});

test("a text UNKNOWN on one consultation survives a successful send on another", async (t) => {
  const rows = ["A", "B"].map((tag) => ({
    ...consultation,
    id: `consultation-${tag}`,
    conversationId: `team-${tag}`,
    peerAccountId: `user-${tag.toLowerCase()}`,
    user: { id: `user-${tag.toLowerCase()}`, name: `用户 ${tag}`, username: `user-${tag.toLowerCase()}` },
  }));
  const sends = [];
  let failOnA = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
    if (url.pathname.endsWith("/im/consultations")) return response({ consultations: rows });
    if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/context")) return response({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-7", displayName: "测试用户甲", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (url.pathname.includes("/users/")) return response({ userId: "user-7", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
    if (url.pathname.endsWith("/im/messages")) {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        sends.push(body.conversationId);
        if (body.conversationId === "team-A" && failOnA) { failOnA = false; return response({ error: { code: "INTERNAL_ERROR" } }, 500); }
        return response({ message: { messageClientId: `sent-${body.conversationId}`, messageServerId: `sent-${body.conversationId}`, conversationId: body.conversationId, senderId: "admin-a", receiverId: "user-a", createTime: Date.parse("2026-09-17T00:10:00.000Z"), text: body.text ?? "", messageType: 0 } });
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
  await waitFor(() => rootNode.querySelectorAll(".im-wb-row").length === 2);

  const pick = async (tag) => {
    const row = [...rootNode.querySelectorAll(".im-wb-row")].find((item) => item.textContent.includes(`用户 ${tag}`));
    await act(async () => { row.click(); });
    await waitFor(() => rootNode.querySelector("textarea") && !rootNode.querySelector("textarea").disabled);
  };
  const type = async (value) => {
    await act(async () => {
      const element = rootNode.querySelector("textarea");
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => { await act(async () => { rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); }); await settle(); };

  await pick("A");
  await type("A 的第一条");
  await submit();
  assert.ok(rootNode.querySelector('[data-action="retry-text"]'), "conversation A keeps an unresolved text send");

  // A successful send elsewhere must not erase A's responsibility.
  await pick("B");
  await type("B 的消息");
  await submit();
  assert.equal(sends.filter((id) => id === "team-B").length, 1);

  await pick("A");
  const retry = rootNode.querySelector('[data-action="retry-text"]');
  assert.ok(retry, "A still reports its unresolved send after B succeeded");
  assert.equal(retry.textContent, "原消息重试", "A keeps the original id instead of degrading to a blind re-send");
  // A replay legitimately puts another request on the wire; what must not happen is a
  // second message. The local-fake body does not expose the text id, so the product-level
  // proof is one bubble for that text and the unresolved row cleared.
  await submit();
  await waitFor(() => !rootNode.querySelector('[data-action="retry-text"]'));
  const bubbles = [...rootNode.querySelectorAll(".im-wb-bub")].filter((el) => el.textContent === "A 的第一条");
  assert.equal(bubbles.length, 1, "replaying A's unknown send must not produce a duplicate message");
});

test("admin consultation routes the normal send and Enter to the original message after an unknown result", async (t) => {
  const sends = [];
  let failNext = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
    if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [consultation] });
    if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/context")) return response({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-7", displayName: "测试用户甲", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (url.pathname.includes("/users/")) return response({ userId: "user-7", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
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
  await act(async () => { rootNode.querySelector(".im-wb-send").click(); });
  await settle();
  assert.equal(sends.length, 2, "normal send must not create a second message beyond the retry");
  assert.equal(sends[0].text, "first");
  assert.equal(sends[1].text, "first", "the normal button replays the original message, not the newer draft");
  assert.equal(rootNode.querySelector("textarea").value, "second", "newer typing survives the original retry");
});

test("an in-flight text retry still settles the originating consultation after switching away", async (t) => {
  const rows = ["A", "B"].map((tag) => ({
    ...consultation,
    id: `consultation-${tag}`,
    conversationId: `team-${tag}`,
    peerAccountId: `user-${tag.toLowerCase()}`,
    user: { id: `user-${tag.toLowerCase()}`, name: `用户 ${tag}`, username: `user-${tag.toLowerCase()}` },
  }));
  const sends = [];
  let failOnA = true;
  let holdRetry = false;
  let releaseRetry = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
    if (url.pathname.endsWith("/im/consultations")) return response({ consultations: rows });
    if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/context")) return response({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-7", displayName: "测试用户甲", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (url.pathname.includes("/users/")) return response({ userId: "user-7", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
    if (url.pathname.endsWith("/im/messages")) {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        sends.push({ conversationId: body.conversationId, text: body.text });
        if (body.conversationId === "team-A" && failOnA) { failOnA = false; return response({ error: { code: "INTERNAL_ERROR" } }, 500); }
        const receipt = () => response({ message: { messageClientId: `sent-${body.conversationId}-${sends.length}`, messageServerId: `sent-${body.conversationId}-${sends.length}`, conversationId: body.conversationId, senderId: "admin-a", receiverId: "user-a", createTime: Date.parse("2026-09-17T00:10:00.000Z"), text: body.text ?? "", messageType: 0 } });
        if (holdRetry) return new Promise((resolve) => { releaseRetry = () => resolve(receipt()); });
        return receipt();
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
  await waitFor(() => rootNode.querySelectorAll(".im-wb-row").length === 2);

  const pick = async (tag) => {
    const row = [...rootNode.querySelectorAll(".im-wb-row")].find((item) => item.textContent.includes(`用户 ${tag}`));
    await act(async () => { row.click(); });
    await waitFor(() => rootNode.querySelector("textarea") && !rootNode.querySelector("textarea").disabled);
  };
  const type = async (value) => {
    await act(async () => {
      const element = rootNode.querySelector("textarea");
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => { await act(async () => { rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); }); await settle(); };

  await pick("A");
  await type("A 的原文");
  await submit();
  assert.ok(rootNode.querySelector('[data-action="retry-text"]'), "A keeps an unresolved text send");

  // 重试在途时切到 B：A 的收口不能由"当前选中的是谁"决定。
  holdRetry = true;
  await act(async () => { rootNode.querySelector('[data-action="retry-text"]').click(); });
  await settle();
  await pick("B");
  await act(async () => { releaseRetry(); });
  await settle();

  await pick("A");
  assert.equal(rootNode.querySelector('[data-action="retry-text"]'), null, "A's unresolved row clears even though B was selected when the receipt arrived");
  const bubbles = [...rootNode.querySelectorAll(".im-wb-bub")].filter((el) => el.textContent === "A 的原文");
  assert.equal(bubbles.length, 1, "the settled retry produces exactly one message for the original text");
  assert.equal(sends.filter((entry) => entry.conversationId === "team-A" && entry.text === "A 的原文").length, 2, "the replay carries the original text, not whatever is in the draft");
});

test("an unresolved text cannot be bypassed by clearing the draft and staging only an image", async (t) => {
  const textPosts = [];
  const imagePosts = [];
  let failFirstText = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
    if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [consultation] });
    if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/context")) return response({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-7", displayName: "测试用户甲", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (url.pathname.includes("/users/")) return response({ userId: "user-7", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
    if (url.pathname.endsWith("/im/messages")) {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.image) {
          imagePosts.push(body);
          return response({ message: { messageClientId: body.image.messageClientId, messageServerId: "srv-image", conversationId: body.conversationId, senderId: "admin-a", receiverId: "user-a", createTime: 9, messageType: 1, attachment: { imageId: "img-1", name: body.image.name, mimeType: body.image.mimeType, size: body.image.size } } });
        }
        textPosts.push(body);
        if (failFirstText) { failFirstText = false; return response({ error: { code: "INTERNAL_ERROR" } }, 500); }
        return response({ message: { messageClientId: "text-replayed", messageServerId: "text-replayed", conversationId: body.conversationId, senderId: "admin-a", receiverId: "user-a", createTime: 9, text: body.text ?? "", messageType: 0 } });
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
  globalThis.URL.createObjectURL = () => "blob:bypass-probe";
  globalThis.URL.revokeObjectURL = () => {};
  const originalImage = globalThis.Image;
  globalThis.Image = class {
    constructor() { this.naturalWidth = 8; this.naturalHeight = 8; }
    set src(_value) { queueMicrotask(() => this.onload?.()); }
  };
  t.after(async () => {
    await act(async () => root?.unmount());
    rootNode.remove();
    globalThis.URL.createObjectURL = originalCreateObjectUrl;
    globalThis.URL.revokeObjectURL = originalRevokeObjectUrl;
    globalThis.Image = originalImage;
  });
  root = createRoot(rootNode);
  const permissions = ["im.support.read", "im.support.accept"];
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot(permissions) })); });
  await waitFor(() => Boolean(rootNode.querySelector('input[type="file"]')));

  const type = async (value) => {
    await act(async () => {
      const element = rootNode.querySelector("textarea");
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => { await act(async () => { rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); }); await settle(); };
  const pressEnter = async () => { await act(async () => { rootNode.querySelector("textarea").dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); }); await settle(); };

  await type("未决的原文");
  await submit();
  assert.ok(rootNode.querySelector('[data-action="retry-text"]'), "the first text send is unresolved");

  // 清空草稿：这正是绕过点 —— 未决检查如果挂在 if (text) 里，下面这段就绕过去了。
  await type("");
  const input = rootNode.querySelector('input[type="file"]');
  const file = new browser.File([new Uint8Array([1, 2, 3])], "bypass.png", { type: "image/png" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await waitFor(() => Boolean(rootNode.querySelector('.im-wb-tray-item[data-state="READY"]')));
  assert.equal(imagePosts.length, 0, "staging never sends on its own");

  await submit();
  assert.equal(imagePosts.length, 0, "an image-only submit must not dispatch the image while the text is unresolved");
  assert.equal(textPosts.length, 1, "an image-only submit must not replay the unresolved text either");
  assert.ok(rootNode.querySelector('[data-action="retry-text"]'), "the original send keeps its unresolved responsibility");
  assert.equal(rootNode.querySelector(".im-wb-tray-item") !== null, true, "the staged image stays queued");

  await pressEnter();
  assert.equal(imagePosts.length, 0, "Enter follows the same session constraint as submit");
  assert.equal(textPosts.length, 1);

  // 显式按原消息重放之后，未决责任才消失，附件才允许在下一次提交里发出。
  await act(async () => { rootNode.querySelector('[data-action="retry-text"]').click(); });
  await waitFor(() => !rootNode.querySelector('[data-action="retry-text"]'));
  assert.equal(textPosts.length, 2, "the explicit retry replays the original message");
  await submit();
  await waitFor(() => imagePosts.length === 1);
  assert.equal(imagePosts.length, 1, "the queued image goes out only after the text converged");
});

// —— 撤权只影响"还能不能发起新的外发"，不影响已经发出去那条的回执 ——
function revokeHarness(t) {
  const node = browser.document.createElement("div");
  browser.document.body.appendChild(node);
  const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  const render = async (permissions) => {
    await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot(permissions) })); });
    await settle();
  };
  const type = async (value) => {
    await act(async () => {
      const element = node.querySelector("textarea");
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => { await act(async () => { node.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); }); await settle(); };
  return { node, render, type, submit };
}

function textSendFetch(textPosts, reply) {
  return async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
    if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [consultation] });
    if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/context")) return response({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-7", displayName: "测试用户甲", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (url.pathname.includes("/users/")) return response({ userId: "user-7", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
    if (url.pathname.endsWith("/im/messages")) {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        textPosts.push(body);
        return new Promise((resolve) => { reply.current = () => resolve(response({ message: { messageClientId: "sent-inflight", messageServerId: "sent-inflight", conversationId: body.conversationId, senderId: "admin-a", receiverId: "user-a", createTime: 5, text: body.text ?? "", messageType: 0 } })); });
      }
      return response({ messages: [] });
    }
    throw new Error(`unexpected test request ${url.pathname}`);
  };
}

test("a text send in flight when only the send permission is revoked still converges on success", async (t) => {
  const textPosts = [];
  const reply = { current: null };
  globalThis.fetch = textSendFetch(textPosts, reply);
  const { node, render, type, submit } = revokeHarness(t);
  await render(["im.support.read", "im.support.accept"]);
  await waitFor(() => Boolean(node.querySelector("form")));
  await type("撤权前发出的原文");
  await submit();
  assert.equal(textPosts.length, 1, "the text is already on the wire");

  await render(["im.support.read"]);
  assert.equal(node.querySelector(".im-wb-send").disabled, true, "a revoked send permission stops any new outbound");
  await act(async () => { reply.current(); });
  await settle();

  assert.equal(textPosts.length, 1, "converging never re-sends the message");
  assert.equal(node.querySelector("textarea").value, "", "the submitted text is no longer a draft");
  assert.equal([...node.querySelectorAll(".im-wb-bub")].some((element) => element.textContent === "撤权前发出的原文"), true, "the receipt lands as a message");
  assert.equal(node.querySelector('[data-action="retry-text"]'), null, "a successful send leaves no unresolved responsibility");
  assert.doesNotMatch(node.textContent, /发送结果未确认|发送失败/);
});

test("a text send in flight when only the send permission is revoked keeps its UNKNOWN responsibility", async (t) => {
  const textPosts = [];
  const reply = { current: null };
  let seen = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (init.method === "POST" && url.pathname.endsWith("/im/messages")) {
      const body = JSON.parse(String(init.body));
      textPosts.push(body);
      seen += 1;
      if (seen > 1) return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), { status: 500, headers: { "content-type": "application/json" } });
      return new Promise((resolve) => { reply.current = () => resolve(new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), { status: 500, headers: { "content-type": "application/json" } })); });
    }
    if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
    if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [consultation] });
    if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/context")) return response({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-7", displayName: "测试用户甲", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (url.pathname.includes("/users/")) return response({ userId: "user-7", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
    if (url.pathname.endsWith("/im/messages")) return response({ messages: [] });
    throw new Error(`unexpected test request ${url.pathname}`);
  };
  const { node, render, type, submit } = revokeHarness(t);
  await render(["im.support.read", "im.support.accept"]);
  await waitFor(() => Boolean(node.querySelector("form")));
  await type("撤权时未确认的原文");
  await submit();
  assert.equal(textPosts.length, 1);

  await render(["im.support.read"]);
  await act(async () => { reply.current(); });
  await settle();

  assert.equal(textPosts.length, 1, "the unknown outcome is not retried on its own");
  assert.equal(node.querySelector("textarea").value, "撤权时未确认的原文", "the unresolved text stays in the draft");
  const retryRow = node.querySelector('[data-action="retry-text"]');
  assert.ok(retryRow, "the unknown responsibility stays on the original conversation instead of vanishing with the permission");
  assert.match(retryRow.textContent, /原消息重试/, "the original id survives the permission change");
});

test("a receipt that arrives after the read permission is gone never refills the message body", async (t) => {
  const textPosts = [];
  const reply = { current: null };
  globalThis.fetch = textSendFetch(textPosts, reply);
  const { node, render, type, submit } = revokeHarness(t);
  await render(["im.support.read", "im.support.accept"]);
  await waitFor(() => Boolean(node.querySelector("form")));
  await type("读取权限被撤后不应回填");
  await submit();
  assert.equal(textPosts.length, 1);

  await render([]);
  await act(async () => { reply.current(); });
  await settle();
  assert.equal(node.querySelectorAll(".im-wb-bub").length, 0, "a late receipt cannot put private history back on screen");
  assert.equal(node.querySelector("textarea").value, "", "read revoke drops the private projection");
});

test("restoring the send permission never re-sends an already completed message", async (t) => {
  const textPosts = [];
  const reply = { current: null };
  globalThis.fetch = textSendFetch(textPosts, reply);
  const { node, render, type, submit } = revokeHarness(t);
  await render(["im.support.read", "im.support.accept"]);
  await waitFor(() => Boolean(node.querySelector("form")));
  await type("只发一次的原文");
  await submit();
  await render(["im.support.read"]);
  await act(async () => { reply.current(); });
  await settle();
  assert.equal(node.querySelector('[data-action="retry-text"]'), null);

  await render(["im.support.read", "im.support.accept"]);
  assert.equal(node.querySelector(".im-wb-send").disabled, true, "an empty draft has nothing to submit");
  await submit();
  await settle();
  assert.equal(textPosts.length, 1, "restoring the permission does not replay the completed message");
  await type("新的内容");
  await submit();
  await settle();
  assert.equal(textPosts.length, 2, "a genuinely new message still works once the permission is back");
});

test("a queued image batch stops dispatching the rest once the send permission is revoked", async (t) => {
  const imagePosts = [];
  const textPosts = [];
  const reply = { current: null };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
    if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [consultation] });
    if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/context")) return response({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-7", displayName: "测试用户甲", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (url.pathname.includes("/users/")) return response({ userId: "user-7", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
    if (url.pathname.endsWith("/im/messages")) {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (!body.image) { textPosts.push(body); return response({ message: { messageClientId: "t", messageServerId: "t", conversationId: body.conversationId, senderId: "admin-a", receiverId: "user-a", createTime: 1, text: body.text ?? "", messageType: 0 } }); }
        imagePosts.push(body);
        const receipt = () => response({ message: { messageClientId: body.image.messageClientId, messageServerId: "im", conversationId: body.conversationId, senderId: "admin-a", receiverId: "user-a", createTime: 2, messageType: 1, attachment: { imageId: "img", name: body.image.name, mimeType: body.image.mimeType, size: body.image.size } } });
        if (imagePosts.length === 1) return new Promise((resolve) => { reply.current = () => resolve(receipt()); });
        return receipt();
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
  globalThis.URL.createObjectURL = () => "blob:batch-probe";
  globalThis.URL.revokeObjectURL = () => {};
  const originalImage = globalThis.Image;
  globalThis.Image = class {
    constructor() { this.naturalWidth = 8; this.naturalHeight = 8; }
    set src(_value) { queueMicrotask(() => this.onload?.()); }
  };
  t.after(async () => {
    await act(async () => { root?.unmount(); });
    rootNode.remove();
    globalThis.URL.createObjectURL = originalCreateObjectUrl;
    globalThis.URL.revokeObjectURL = originalRevokeObjectUrl;
    globalThis.Image = originalImage;
  });
  root = createRoot(rootNode);
  const render = async (permissions) => {
    await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot(permissions) })); });
    await settle();
  };
  await render(["im.support.read", "im.support.accept"]);
  await waitFor(() => Boolean(rootNode.querySelector('input[type="file"]')));
  const input = rootNode.querySelector('input[type="file"]');
  const files = [1, 2].map((n) => new browser.File([new Uint8Array([1, 2, 3, n])], `batch-${n}.png`, { type: "image/png" }));
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await waitFor(() => rootNode.querySelectorAll('.im-wb-tray-item[data-state="READY"]').length === 2);

  await act(async () => { rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
  assert.equal(imagePosts.length, 1, "the batch starts with exactly one image in flight");

  await render(["im.support.read"]);
  await act(async () => { reply.current(); });
  await settle();

  assert.equal(imagePosts.length, 1, "restoring nothing: the revoked permission stops the rest of the batch");
  assert.equal(rootNode.querySelectorAll(".im-wb-tray-item").length, 1, "the undelivered image stays queued instead of being lost");
  assert.equal(textPosts.length, 0);
});
