import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mergeImMessages } from "../src/lib/nim-web-client.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4240/support?preview=1" });
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
  root: webRoot,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/components\/session\/user-session-provider$/, replacement: path.join(webRoot, "test", "stubs", "user-session-provider.tsx") },
      { find: /^@\/components\/auth\/auth-overlay-provider$/, replacement: path.join(webRoot, "test", "stubs", "auth-overlay-provider.tsx") },
      { find: /^@\//, replacement: `${path.join(webRoot, "src")}/` },
    ],
  },
  server: { middlewareMode: true, hmr: false },
});
const workspaceModule = await vite.ssrLoadModule("/src/components/support/customer-support-workspace.tsx");
const { CustomerSupportWorkspace, messageFromNim } = workspaceModule;
const { UserSessionProvider } = await vite.ssrLoadModule("/test/stubs/user-session-provider.tsx");
const { AuthOverlayProvider } = await vite.ssrLoadModule("/test/stubs/auth-overlay-provider.tsx");
after(async () => { await vite.close(); });

function renderPreview(props = {}) {
  return createElement(UserSessionProvider, null, createElement(AuthOverlayProvider, null, createElement(CustomerSupportWorkspace, { preview: true, ...props })));
}

const requests = [];
globalThis.fetch = async (input) => {
  requests.push(String(input));
  throw new Error(`preview must not call the network: ${String(input)}`);
};

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

test("preview chat keeps viewer identity explicit and never claims a read receipt", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => {
    await act(async () => { root?.unmount(); });
    rootNode.remove();
  });
  root = createRoot(rootNode);
  await act(async () => { root.render(renderPreview()); });
  await settle();

  const customer = rootNode.querySelector('.support-message[data-from="customer"]');
  const agent = rootNode.querySelector('.support-message[data-from="agent"]');
  assert.ok(rootNode.querySelector('.support-message-viewport[role="region"]'), "viewport has an explicit CSS target");
  assert.ok(customer, "buyer-side message renders");
  assert.ok(agent, "agent-side message renders");
  assert.equal(customer.getAttribute("data-self"), "true", "own message carries explicit self fact");
  assert.equal(agent.getAttribute("data-self"), "false", "agent message carries explicit non-self fact");
  assert.equal(customer.querySelector(".support-message-meta span").textContent, "我");
  assert.equal(agent.querySelector(".support-message-meta span").textContent, "客服");
  assert.match(customer.textContent, /已发送/, "own message may show at most a sent state");
  assert.doesNotMatch(rootNode.textContent, /已读/, "preview never claims a read receipt");
  assert.doesNotMatch(agent.textContent, /已发送/, "send state stays under the sender's own message");

  const textarea = rootNode.querySelector("textarea");
  assert.equal(textarea.disabled, false, "preview composer stays usable");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
    setValue.call(textarea, "预览发送检查");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  await act(async () => { rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
  const sent = [...rootNode.querySelectorAll('.support-message[data-from="customer"]')].at(-1);
  assert.equal(sent.getAttribute("data-self"), "true", "a locally sent message stays on the viewer's own side");
  assert.match(sent.textContent, /预览发送检查/);
  assert.doesNotMatch(rootNode.textContent, /已读/);
  assert.deepEqual(requests, [], "preview renders without touching the network");
});

test("switching chat to list and back moves focus onto visible controls", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => {
    await act(async () => { root?.unmount(); });
    rootNode.remove();
  });
  root = createRoot(rootNode);
  await act(async () => { root.render(renderPreview()); });
  await settle();

  const list = rootNode.querySelector(".support-conversation-list");
  const panel = rootNode.querySelector(".support-conversation-panel");

  await act(async () => { rootNode.querySelector('[data-action="back-to-conversations"]').click(); });
  await settle();
  const activeAfterList = browser.document.activeElement;
  assert.ok(activeAfterList.classList.contains("support-conversation-item"), `list switch focuses a list item, got ${activeAfterList.tagName}`);
  assert.ok(list.contains(activeAfterList), "focus lands inside the visible list pane");
  assert.equal(list.contains(browser.document.activeElement), true);

  await act(async () => { activeAfterList.click(); });
  await settle();
  const activeAfterChat = browser.document.activeElement;
  assert.equal(activeAfterChat.getAttribute("data-focus-target"), "chat", "chat switch focuses the visible chat heading");
  assert.equal(panel.contains(activeAfterChat), true, "focus lands inside the visible chat pane");
  assert.notEqual(activeAfterChat, browser.document.body, "focus never falls back to body");

  await act(async () => { rootNode.querySelector('[data-action="back-to-conversations"]').click(); });
  await settle();
  assert.ok(browser.document.activeElement.classList.contains("support-conversation-item"), "returning to the list restores list focus");
});

test("timeline calendar labels preserve January and December", () => {
  const source = readFileSync(path.join(webRoot, "src/components/support/customer-support-workspace.tsx"), "utf8");
  const helpers = source.slice(source.indexOf("function dayKeyOf"), source.indexOf("function responseError"));
  const { dayKeyOf, dayLabelOf } = new Function(stripTypeScriptTypes(helpers) + ";return { dayKeyOf, dayLabelOf };")();
  assert.equal(dayKeyOf(undefined), null);
  assert.equal(dayKeyOf(NaN), null);
  for (const [month, expected] of [[0, "1月15日"], [11, "12月15日"]]) {
    assert.equal(dayLabelOf(dayKeyOf(new Date(2020, month, 15, 12).getTime())), expected);
  }
  assert.equal(dayLabelOf(dayKeyOf(Date.now())), "今天");
});

test("closing context restores keyboard focus to its trigger", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => { await act(async () => root.unmount()); rootNode.remove(); });
  await act(async () => { root.render(renderPreview()); });
  await settle();
  const trigger = rootNode.querySelector('[data-action="toggle-product-context"]');
  await act(async () => { trigger.click(); });
  await settle();
  const close = rootNode.querySelector('[data-action="close-product-context"]');
  await act(async () => { close.focus(); close.click(); });
  await settle();
  assert.equal(rootNode.querySelector('[data-action="close-product-context"]'), null);
  assert.equal(browser.document.activeElement === trigger, true, "focus returns to context trigger");
});
test("projected image survives a later sender echo without the uploaded URL", () => {
  const rich = messageFromNim({
    messageClientId: "m1", conversationId: "me|2|1", senderId: "me", receiverId: "1", createTime: 1, messageType: 1,
    attachment: { url: "https://nim-nosdn.example/a.png", thumbUrl: "https://nim-nosdn.example/a-thumb.png", name: "a.png", size: 10 },
  }, "me");
  const echo = messageFromNim({
    messageClientId: "m1", conversationId: "me|2|1", senderId: "me", receiverId: "1", createTime: 1, messageType: 1,
    attachment: { name: "a.png", size: 10 },
  }, "me");
  assert.ok(rich?.image?.url, "history projects the uploaded URL");
  assert.ok(echo?.image, "a no-URL echo still projects an image placeholder instead of unsupported text");
  const merged = mergeImMessages([rich], [echo]);
  assert.equal(merged[0].image.url, "https://nim-nosdn.example/a.png", "the rich URL survives the echo");
  assert.notEqual(merged[0].text, "暂不支持展示的消息类型");
});

test("nonpreview user consultation routes the normal send to the original message after an unknown result", async (t) => {
  const originalFetch = globalThis.fetch;
  const rows = [{ id: "c-1", type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", conversationId: "team-1", assignedAdmin: { id: "admin-a", name: "客服 A" }, updatedAt: "2026-09-26T00:00:00Z" }];
  const sends = [];
  let failNext = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: rows }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init.body));
        sends.push(body);
        if (failNext) { failNext = false; return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), { status: 500, headers: { "content-type": "application/json" } }); }
        return new Response(JSON.stringify({ message: { messageClientId: "retried", messageServerId: "retried", conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: 3, text: body.text, messageType: 0 } }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected user fetch ${url}`);
  };
  const host = browser.document.createElement("div"); host.className = "support-dialog-content"; browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  const until = async (predicate) => { for (let index = 0; index < 120; index += 1) { if (predicate()) return; await settle(); } throw new Error("user unknown condition timed out"); };
  await until(() => Boolean(host.querySelector("textarea") && !host.querySelector("textarea").disabled));
  const type = async (value) => {
    await act(async () => {
      const element = host.querySelector("textarea");
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type("first");
  await act(async () => { host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await until(() => host.textContent.includes("发送结果未确认"));
  await type("second");
  await act(async () => { host.querySelector('button[type="submit"]').click(); });
  await until(() => sends.length === 2);
  assert.equal(sends[0].text, "first");
  assert.equal(sends[1].text, "first", "the normal button replays the original message, not the newer draft");
  assert.equal(host.querySelector("textarea").value, "second", "newer typing survives the original retry");
});

test("nonpreview user image UNKNOWN keeps the file bound to its conversation and retries the original id", async (t) => {
  const originalFetch = globalThis.fetch;
  const rows = [
    { id: "c-1", type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", conversationId: "team-1", assignedAdmin: { id: "admin-a", name: "客服 A" }, updatedAt: "2026-09-26T00:00:00Z" },
    { id: "c-2", type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", conversationId: "team-2", assignedAdmin: { id: "admin-a", name: "客服 A" }, updatedAt: "2026-09-25T00:00:00Z" },
  ];
  const imageSends = [];
  let failNext = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: rows }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.image) {
          imageSends.push(body);
          if (failNext) { failNext = false; return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), { status: 500, headers: { "content-type": "application/json" } }); }
          return new Response(JSON.stringify({ message: { messageClientId: body.image.messageClientId, messageServerId: "server-image", conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: 4, messageType: 1, attachment: { imageId: "img-1", name: body.image.name, mimeType: body.image.mimeType, size: body.image.size } } }), { headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ message: { messageClientId: "text", conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: 5, text: body.text, messageType: 0 } }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected user image fetch ${url}`);
  };
  const host = browser.document.createElement("div"); host.className = "support-dialog-content"; browser.document.body.appendChild(host);
  const root = createRoot(host);
  const originalCreateObjectUrl = globalThis.URL.createObjectURL;
  const originalRevokeObjectUrl = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = () => "blob:preview-test";
  globalThis.URL.revokeObjectURL = () => {};
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; globalThis.URL.createObjectURL = originalCreateObjectUrl; globalThis.URL.revokeObjectURL = originalRevokeObjectUrl; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("user image condition timed out"); };
  await until(() => Boolean(host.querySelector('input[type="file"]')));
  const input = host.querySelector('input[type="file"]');
  const file = new browser.File([new Uint8Array([1, 2, 3])], "proof.png", { type: "image/png" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await until(() => host.querySelector(".support-pending-image"));
  assert.match(host.querySelector(".support-pending-image").textContent, /未确认/);
  const firstId = imageSends[0].image.messageClientId;
  await act(async () => { host.querySelector('[data-action="back-to-conversations"]').click(); });
  await settle();
  await act(async () => { host.querySelectorAll(".support-conversation-item")[1].click(); });
  await settle();
  assert.equal(host.querySelector(".support-pending-image"), null, "the pending image stays bound to its own conversation");
  await act(async () => { host.querySelector('[data-action="back-to-conversations"]').click(); });
  await settle();
  await act(async () => { [...host.querySelectorAll(".support-conversation-item")][0].click(); });
  await settle();
  await until(() => host.querySelector(".support-pending-image"));
  await act(async () => { [...host.querySelectorAll(".support-pending-image button")].find((button) => button.textContent.includes("重试")).click(); });
  await until(() => imageSends.length === 2);
  assert.equal(imageSends[1].image.messageClientId, firstId, "image retry reuses the original messageClientId");
});

test("nonpreview fifty conversations restore selection and draft in the real host", async (t) => {
  const originalFetch = globalThis.fetch;
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `c-${i}`, type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", conversationId: `team-${i}`, assignedAdmin: { id: "admin-a", name: `客服 ${i}` }, updatedAt: "2026-09-26T00:00:00Z" }));
  globalThis.fetch = async (input) => {
    const url = String(input);
    const body = url.includes('/im/token') ? { appKey: 'synthetic', accountId: 'preview-user', token: 'synthetic', transport: 'local-fake' }
      : url.includes('/im/consultations') ? { consultations: rows } : { messages: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const style = browser.document.createElement("style"); style.textContent = readFileSync(path.join(webRoot, "src/components/support/customer-support-workspace.css"), "utf8"); browser.document.head.appendChild(style); t.after(() => style.remove());
  const host = browser.document.createElement('div'); host.className = 'support-dialog-content'; browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  assert.ok(host.querySelector(':scope > nav[aria-label="沟通类型"]'), 'authenticated toolbar is really mounted');
  assert.equal(getComputedStyle(host.querySelector(':scope > nav')).flexGrow, '0');
  assert.equal(parseFloat(getComputedStyle(host.querySelector('.support-workspace')).minHeight), 0);
  await act(async () => host.querySelector('[data-action="back-to-conversations"]').click()); await settle();
  const items = host.querySelectorAll('.support-conversation-item'); assert.equal(items.length, 50);
  await act(async () => items[49].click()); await settle();
  assert.equal(items[49].getAttribute('data-active'), 'true');
  await act(async () => host.querySelector('[data-action="back-to-conversations"]').click()); await settle();
  assert.equal(browser.document.activeElement === items[49], true, 'return focuses the selected last item, not the first');
});
