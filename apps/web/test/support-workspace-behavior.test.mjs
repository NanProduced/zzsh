import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after } from "node:test";
import ts from "typescript";
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
const orderTeamModule = await vite.ssrLoadModule("/../../packages/ui/src/order-team-panel.tsx");
const { OrderTeamPanel, orderTeamLabel } = orderTeamModule;
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
    if(url.startsWith("/api/orders/"))return new Response(JSON.stringify({items:[],nextCursor:null}));
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
    if(url.startsWith("/api/orders/"))return new Response(JSON.stringify({items:[],nextCursor:null}));
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
  await until(() => host.querySelector(".support-staged-image"));
  assert.equal(imageSends.length, 0, "selecting image only stages it without sending");
  assert.match(host.querySelector(".support-staged-image").textContent, /proof\.png/);
  await act(async () => { host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
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

test("selecting or pasting an image only stages it, removal triggers zero sends, and staged image binds to conversation", async (t) => {
  const originalFetch = globalThis.fetch;
  const rows = [
    { id: "c-1", type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", conversationId: "team-1", assignedAdmin: { id: "admin-a", name: "客服 A" }, updatedAt: "2026-09-26T00:00:00Z" },
    { id: "c-2", type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", conversationId: "team-2", assignedAdmin: { id: "admin-a", name: "客服 A" }, updatedAt: "2026-09-25T00:00:00Z" },
  ];
  const imageSends = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: rows }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.image) {
          imageSends.push(body);
          return new Response(JSON.stringify({ message: { messageClientId: body.image.messageClientId, messageServerId: "server-image", conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: 4, messageType: 1, attachment: { imageId: "img-1", name: body.image.name, mimeType: body.image.mimeType, size: body.image.size } } }), { headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const host = browser.document.createElement("div"); host.className = "support-dialog-content"; browser.document.body.appendChild(host);
  const root = createRoot(host);
  const originalCreateObjectUrl = globalThis.URL.createObjectURL;
  const originalRevokeObjectUrl = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = () => "blob:preview-stage";
  globalThis.URL.revokeObjectURL = () => {};
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; globalThis.URL.createObjectURL = originalCreateObjectUrl; globalThis.URL.revokeObjectURL = originalRevokeObjectUrl; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => Boolean(host.querySelector('input[type="file"]')));
  const input = host.querySelector('input[type="file"]');
  const file = new browser.File([new Uint8Array([1, 2, 3])], "stage-test.png", { type: "image/png" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await until(() => host.querySelector(".support-staged-image"));
  assert.equal(imageSends.length, 0, "selecting image does not send");
  // Test removing staged image
  const removeBtn = host.querySelector(".support-staged-remove");
  assert.ok(removeBtn, "remove button exists on staged preview");
  await act(async () => { removeBtn.click(); });
  await settle();
  assert.equal(host.querySelector(".support-staged-image"), null, "staged preview removed");
  assert.equal(imageSends.length, 0, "removing staged image triggers zero sends");

  // Re-stage and test conversation switching isolation
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await until(() => host.querySelector(".support-staged-image"));
  await act(async () => { host.querySelector('[data-action="back-to-conversations"]').click(); });
  await settle();
  await act(async () => { host.querySelectorAll(".support-conversation-item")[1].click(); });
  await settle();
  assert.equal(host.querySelector(".support-staged-image"), null, "staged image does not leak to other conversations");
  await act(async () => { host.querySelector('[data-action="back-to-conversations"]').click(); });
  await settle();
  await act(async () => { [...host.querySelectorAll(".support-conversation-item")][0].click(); });
  await settle();
  await until(() => host.querySelector(".support-staged-image"));
  assert.ok(host.querySelector(".support-staged-image"), "staged image restored when returning to conversation");

  // Submit and verify single send
  await act(async () => { host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await until(() => imageSends.length === 1);
  assert.equal(imageSends.length, 1, "submit triggers exactly one send");
  assert.equal(host.querySelector(".support-staged-image"), null, "staged image cleared after send");
});

test("nonpreview fifty conversations restore selection and draft in the real host", async (t) => {
  const originalFetch = globalThis.fetch;
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `c-${i}`, type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", conversationId: `team-${i}`, assignedAdmin: { id: "admin-a", name: `客服 ${i}` }, updatedAt: "2026-09-26T00:00:00Z" }));
  globalThis.fetch = async (input) => {
    const url = String(input);
    if(url.startsWith("/api/orders/"))return new Response(JSON.stringify({items:[],nextCursor:null}));
    const body = url.startsWith('/api/orders/') ? {items:[],nextCursor:null} : url.includes('/im/token') ? { appKey: 'synthetic', accountId: 'preview-user', token: 'synthetic', transport: 'local-fake' }
      : url.includes('/im/consultations') ? { consultations: rows } : { messages: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const style = browser.document.createElement("style"); style.textContent = readFileSync(path.join(webRoot, "src/components/support/customer-support-workspace.css"), "utf8"); browser.document.head.appendChild(style); t.after(() => style.remove());
  const host = browser.document.createElement('div'); host.className = 'support-dialog-content'; browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  assert.ok(host.querySelector('nav[aria-label="全部会话"]'), 'unified authorized directory is mounted');
  assert.equal(parseFloat(getComputedStyle(host.querySelector('.support-workspace')).minHeight), 0);
  await act(async () => host.querySelector('[data-action="back-to-conversations"]').click()); await settle();
  const items = host.querySelectorAll('.support-conversation-item'); assert.equal(items.length, 50);
  await act(async () => items[49].click()); await settle();
  assert.equal(items[49].getAttribute('data-active'), 'true');
  await act(async () => host.querySelector('[data-action="back-to-conversations"]').click()); await settle();
  assert.equal(browser.document.activeElement === items[49], true, 'return focuses the selected last item, not the first');
});

test('directory refresh has a two-page budget and stops when the window is hidden or unmounted',async(t)=>{
 const oldFetch=globalThis.fetch,oldInterval=window.setInterval,oldClear=window.clearInterval;
 let tick,orderCalls=0,release;
 window.setInterval=callback=>{tick=callback;return 1;};window.clearInterval=()=>{};
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.includes('/im/token'))return new Response('{}',{status:503});
  if(url.includes('/im/consultations'))return new Response('{"consultations":[]}');
  orderCalls++;
  if(orderCalls===5)await new Promise(resolve=>release=resolve);
  return new Response(JSON.stringify({items:[],nextCursor:'page-'+orderCalls}));
 };
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();globalThis.fetch=oldFetch;window.setInterval=oldInterval;window.clearInterval=oldClear;});
 const render=visible=>root.render(renderPreview({preview:false,embedded:true,visible}));
 await act(async()=>render(true));await settle();assert.equal(orderCalls,2);assert.doesNotMatch(host.textContent,/你好，需要/);
 await act(async()=>tick());await settle();assert.equal(orderCalls,4);
 const oldTick=tick;
 await act(async()=>render(false));await act(async()=>oldTick());assert.equal(orderCalls,4);
 await act(async()=>render(true));await settle();assert.equal(orderCalls,5);
 await act(async()=>root.unmount());await act(async()=>release());await settle();assert.equal(orderCalls,5,'no follow-up page after unmount');
});

test("F1 requires complete directory success; failures never become empty and creation is single-flight", async(t)=>{
 const old=globalThis.fetch;let mode="loading",resolveDirectory,creates=0,finishCreate;
 const reply=body=>new Response(JSON.stringify(body));
 globalThis.fetch=async(input,init={})=>{
  const url=String(input);
  if(url.includes('/im/token'))return new Response('{}',{status:503});
  if(url.startsWith('/api/orders/')){
   if(mode==='loading')await new Promise(resolve=>{resolveDirectory=resolve;});
   if(mode==='forbidden')return new Response('{}',{status:403});
   return reply({items:[],nextCursor:null});
  }
  if(url.includes('/im/consultations')){
   if(init.method==='POST'){creates++;await new Promise(resolve=>{finishCreate=resolve;});return reply({consultation:{id:'waiting',type:'COMPLAINT',state:'WAITING',conversationId:null,assignedAdmin:null}});}
   return reply({consultations:[]});
  }
  throw Error(url);
 };
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();globalThis.fetch=old;});
 await act(async()=>root.render(renderPreview({preview:false,embedded:true})));
 await settle();assert.match(host.textContent,/正在读取会话/);assert.doesNotMatch(host.textContent,/你好，需要/);
 // Two roles must both finish. Remount cancels unresolved reads before checking error recovery.
 mode='forbidden';await act(async()=>root.render(renderPreview({preview:false,embedded:true,key:'forbidden'})));await settle();
 assert.match(host.textContent,/不可访问/);assert.doesNotMatch(host.textContent,/你好，需要/);
 mode='empty';await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='重试读取').click());await settle();
 assert.match(host.textContent,/你好，需要什么帮助/);assert.equal(host.querySelector('textarea'),null);assert.equal(creates,0);
 const complaint=[...host.querySelectorAll('button')].find(b=>b.textContent==='投诉反馈');
 await act(async()=>{complaint.click();complaint.click();});assert.equal(creates,1);
 await act(async()=>finishCreate());await settle();assert.ok(host.querySelector('.support-unified'));assert.match(host.textContent,/等待客服接待/);
});

test("each consultation type and readable history opens F2 without requiring SDK availability",async(t)=>{
 const old=globalThis.fetch;const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();globalThis.fetch=old;});
 for(const [type,state] of [['SERVICE','ACTIVE'],['COMPLAINT','ACTIVE'],['SERVICE','CLOSED']]){
  globalThis.fetch=async(input)=>new Response(JSON.stringify(String(input).includes('/im/consultations')?{consultations:[{id:type+state,type,state,conversationId:null,assignedAdmin:null}]}:String(input).startsWith('/api/orders/')?{items:[],nextCursor:null}:{}),{status:String(input).includes('/im/token')?503:200});
  await act(async()=>root.render(renderPreview({preview:false,embedded:true,key:type+state})));await settle();
  assert.ok(host.querySelector('.support-unified'));assert.doesNotMatch(host.textContent,/你好，需要什么帮助/);
 }
});

test('only renter or owner group opens F2; explicit order authorizes that id and never falls back on denial',async(t)=>{
 const old=globalThis.fetch;const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();globalThis.fetch=old;});
 for(const party of ['renter','owner']){
  const paths=[];
  globalThis.fetch=async input=>{const url=String(input);paths.push(url);if(url.includes('/im/token'))return new Response('{}',{status:503});if(url.includes('/im/consultations'))return new Response(JSON.stringify({consultations:[]}));if(url.includes('/im?'))return new Response('{}',{status:403});return new Response(JSON.stringify({items:url.includes('party='+party)?[{id:'only-'+party,title:'关联订单',displayNo:'Z1',status:'PAID',fulfillmentAssignment:{state:'ASSIGNED',teamState:'READY'}}]:[],nextCursor:null}));};
  await act(async()=>root.render(renderPreview({preview:false,embedded:true,key:party,initialOrderId:'target-'+party,initialOrderParty:party})));
  await settle();await settle();
  assert.ok(host.querySelector('.support-unified'));assert.ok(paths.some(p=>p.includes('/target-'+party+'/im?operation=read')));assert.ok(!paths.some(p=>p.includes('/only-'+party+'/im?')));assert.match(host.textContent,/当前订单不可访问/);assert.doesNotMatch(host.textContent,/你好，需要什么帮助/);
 }
});

test("pasting image stages file via clipboard DataTransfer, transfer preserves previewUrl until cleared, and unrelated pending is protected", async (t) => {
  const originalFetch = globalThis.fetch;
  const rows = [
    { id: "c-1", type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", conversationId: "team-1", assignedAdmin: { id: "admin-a", name: "客服 A" }, updatedAt: "2026-09-26T00:00:00Z" },
  ];
  const imageSends = [];
  let finishSend;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: rows }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.image) {
          imageSends.push(body);
          await new Promise((resolve) => { finishSend = resolve; });
          return new Response(JSON.stringify({ message: { messageClientId: body.image.messageClientId, messageServerId: "server-image", conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: 4, messageType: 1, attachment: { imageId: "img-1", name: body.image.name, mimeType: body.image.mimeType, size: body.image.size } } }), { headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const host = browser.document.createElement("div"); host.className = "support-dialog-content"; browser.document.body.appendChild(host);
  const root = createRoot(host);
  const revokedUrls = [];
  const originalCreateObjectUrl = globalThis.URL.createObjectURL;
  const originalRevokeObjectUrl = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = () => "blob:pasted-stage-1";
  globalThis.URL.revokeObjectURL = (url) => { revokedUrls.push(url); };
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectUrl;
    globalThis.URL.revokeObjectURL = originalRevokeObjectUrl;
  });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => Boolean(host.querySelector("textarea")));
  const textarea = host.querySelector("textarea");

  // Dispatch real paste event with image File
  const pasteFile = new browser.File([new Uint8Array([7, 8, 9])], "clipboard-shot.png", { type: "image/png" });
  const pasteEvent = new browser.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, "clipboardData", {
    value: {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => pasteFile,
        },
      ],
    },
  });
  await act(async () => { textarea.dispatchEvent(pasteEvent); });
  await until(() => host.querySelector(".support-staged-image"));
  assert.equal(imageSends.length, 0, "pasting image stages file without immediate sending");
  assert.ok(host.querySelector(".support-staged-image"), "staged preview is visible");

  // Submit staged image: verify ownership transfer (previewUrl NOT revoked during transfer)
  await act(async () => { host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await until(() => imageSends.length === 1);
  assert.equal(revokedUrls.includes("blob:pasted-stage-1"), false, "preview URL is not prematurely revoked during staged-to-pending transfer");

  // Complete send: verify previewUrl is cleanly revoked upon success
  await act(async () => { finishSend(); });
  await until(() => revokedUrls.includes("blob:pasted-stage-1"));
  assert.ok(revokedUrls.includes("blob:pasted-stage-1"), "preview URL is revoked once pending send completes");
});

test("TEAM_INVITE notification maps to neutral member joined label rather than consultation created", () => {
  const inviteMsg = messageFromNim({
    messageType: 5,
    attachment: { type: 0 },
    senderId: "system-1",
    createTime: 1000,
    messageClientId: "invite-1",
  }, "user-1");
  assert.ok(inviteMsg);
  assert.equal(inviteMsg.from, "system");
  assert.equal(inviteMsg.text, "成员已加入会话");

  const otherSysMsg = messageFromNim({
    messageType: 5,
    attachment: { type: 1 },
    senderId: "system-1",
    createTime: 1001,
    messageClientId: "update-1",
  }, "user-1");
  assert.ok(otherSysMsg);
  assert.equal(otherSysMsg.text, "会话信息已更新");
});

test("OrderConversation 本单信息 action appends current order info to draft", async (t) => {
  const { OrderTeamPanel } = await vite.ssrLoadModule("/../../packages/ui/src/order-team-panel.tsx");
  const host = browser.document.createElement("div"); browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const fakeOrderAccess = {
    orderId: "ord-test-1",
    displayNo: "Z8899",
    orderStatus: "PAID",
    assignmentState: "ASSIGNED",
    teamState: "READY",
    appId: "app-1",
    teamId: "team-1",
    gameName: "绝区零",
    account: { id: "acc-1", title: "高练度全限定号" },
    canRead: true,
    canSend: true,
    members: [{ platformId: "u-1", accountId: "test-user", party: "USER", name: "买家", avatar: null }],
    supportEscalation: { firstResponseAt: null, remindDueAt: null, addRound: 0, state: "RUNNING", needsManualReview: false, noEligibleStaff: false },
    conversationId: "conv-1",
    viewerAccountId: "test-user",
  };

  const fakeClient = {
    accountId: "test-user",
    transport: "local-fake",
    getConnectionState: () => "CONNECTED",
    getMessageHistory: async () => [],
    onMessages: () => () => {},
    onConnectionStateChange: () => () => {},
  };

  const requestMock = async (path) => {
    if (path.includes("im?operation=read") || path.includes("im?operation=send")) {
      return fakeOrderAccess;
    }
    return { items: [{ id: "ord-test-1", displayNo: "Z8899", title: "高练度全限定号", status: "PAID" }], nextCursor: null };
  };

  await act(async () => {
    root.render(
      createElement(OrderTeamPanel, {
        identity: "user-1",
        realm: "user",
        client: fakeClient,
        connection: "CONNECTED",
        active: true,
        selectedOrderId: "ord-test-1",
        compact: true,
        request: requestMock,
        onAuthError: () => {},
      })
    );
  });
  await settle(); await settle();

  const infoBtn = [...host.querySelectorAll(".order-team-tool")].find((button) => button.textContent.includes("本单信息"));
  assert.ok(infoBtn, "order team info button rendered in conversation form");
  const textarea = host.querySelector("textarea");
  assert.ok(textarea, "textarea rendered");

  await act(async () => {
    infoBtn.click();
  });
  await settle();

  assert.match(textarea.value, /【本单信息】高练度全限定号 \(订单尾号: Z8899\)/, "clicking button inserts order text into draft");
});

test("order team labels surface completed and cancelled orders without changing active copy", () => {
  assert.equal(orderTeamLabel({ orderStatus: "PENDING_PAYMENT" }), "未付款");
  assert.equal(orderTeamLabel({ orderStatus: "COMPLETED", teamState: "READY" }), "订单已完成", "an ended order outranks its ready group");
  assert.equal(orderTeamLabel({ status: "COMPLETED" }), "订单已完成", "status-only orders keep the compatibility read");
  assert.equal(orderTeamLabel({ orderStatus: "CANCELLED", teamState: "READY" }), "已取消");
  assert.equal(orderTeamLabel({ status: "CANCELLED" }), "已取消");
  assert.equal(orderTeamLabel({ orderStatus: "PAID", assignmentState: "ASSIGNED" }), "已分配 · 正在准备订单群");
  assert.equal(orderTeamLabel({ orderStatus: "PAID", teamState: "READY" }), "订单群已就绪");
  assert.equal(orderTeamLabel({ orderStatus: "PAID", teamState: "NEEDS_REVIEW" }), "建群待人工核查");
  assert.equal(orderTeamLabel({ orderStatus: "PAID" }), "已付款 · 等待匹配客服");
});

test("an ended order shows a neutral notice while canSend alone keeps the composer usable", async (t) => {
  const mounts = [];
  t.after(async () => {
    for (const { root, host } of mounts) {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  const fakeClient = {
    accountId: "test-user",
    transport: "local-fake",
    getConnectionState: () => "CONNECTED",
    getMessageHistory: async () => [],
    onMessages: () => () => {},
    onConnectionStateChange: () => () => {},
  };
  const access = (orderStatus, canSend = true, sendUntil = null) => ({
    orderId: `ord-${orderStatus.toLowerCase()}`,
    displayNo: "Z9001",
    orderStatus,
    ...(sendUntil ? { sendUntil } : {}),
    assignmentState: "ASSIGNED",
    teamState: "READY",
    appId: "app-1",
    teamId: "team-1",
    gameName: "绝区零",
    account: { id: "acc-1", title: "高练度全限定号" },
    canRead: true,
    canSend,
    members: [{ platformId: "u-1", accountId: "test-user", party: "USER", name: "买家", avatar: null }],
    supportEscalation: { firstResponseAt: null, remindDueAt: null, addRound: 0, state: "RUNNING", needsManualReview: false, noEligibleStaff: false },
    conversationId: "conv-1",
    viewerAccountId: "test-user",
  });
  const mountPanel = async (info) => {
    const host = browser.document.createElement("div");
    browser.document.body.appendChild(host);
    const root = createRoot(host);
    mounts.push({ root, host });
    const request = async (requestPath) => requestPath.includes("im?operation=")
      ? info
      : { items: [{ id: info.orderId, displayNo: info.displayNo, title: info.account.title, status: info.orderStatus }], nextCursor: null };
    await act(async () => {
      root.render(createElement(OrderTeamPanel, {
        identity: "user-1",
        realm: "user",
        client: fakeClient,
        connection: "CONNECTED",
        active: true,
        selectedOrderId: info.orderId,
        compact: true,
        request,
        onAuthError: () => {},
      }));
    });
    await settle();
    await settle();
    return host;
  };
  const typeDraft = async (host, text) => {
    const textarea = host.querySelector("textarea");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
      setValue.call(textarea, text);
      textarea.dispatchEvent(new browser.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new browser.Event("change", { bubbles: true }));
    });
    await settle();
  };

  const liveHost = await mountPanel(access("COMPLETED", true, new Date(Date.now() + 3_600_000).toISOString()));
  const liveNotice = liveHost.querySelector(".order-team-stage-now");
  assert.match(liveNotice.textContent, /^结算完成 · 可沟通至 .+$/, "within 72 hours the stage bar names the remaining window");
  await typeDraft(liveHost, "还能继续沟通吗");
  assert.equal(liveHost.querySelector('.order-team-chat form button[type="submit"]').disabled, false, "the 72-hour window keeps the composer usable");

  for (const orderStatus of ["COMPLETED", "CANCELLED"]) {
    const host = await mountPanel(access(orderStatus, true, new Date(Date.now() - 3_600_000).toISOString()));
    const detail = host.querySelector(".order-team-detail");
    assert.match(detail.textContent, orderStatus === "COMPLETED" ? /结算完成/ : /已取消/);
    const chip = detail.querySelector(".order-team-head-chip");
    assert.equal(chip?.textContent, orderStatus === "COMPLETED" ? "结算完成" : "已取消", "the head carries the current stage");
    const notice = host.querySelector(".order-team-stage-now");
    assert.ok(notice, "the stage bar explains the ended state");
    assert.match(notice.textContent, orderStatus === "COMPLETED" ? /^结算完成 · 已超过 72 小时 · 仅可查看$/ : /^已取消$/);
    assert.doesNotMatch(notice.textContent, /只读|禁止发送|不可发送/, "the stage bar never claims a send restriction");
    const submit = host.querySelector('.order-team-chat form button[type="submit"]');
    assert.equal(submit.disabled, true, "an empty draft still blocks the submit");
    await typeDraft(host, "确认订单状态");
    assert.equal(submit.disabled, false, "canSend keeps governing the composer after the order ends");
    assert.doesNotMatch(host.querySelector(".order-team-chat").textContent, /当前只可阅读/);
  }

  const noSendHost = await mountPanel(access("COMPLETED", false));
  assert.ok(noSendHost.querySelector(".order-team-stage-now"), "the stage bar still renders without send permission");
  assert.ok(noSendHost.querySelector(".order-team-readonly"), "the ended order explains why the composer is gone");
  assert.equal(noSendHost.querySelector('.order-team-chat form'), null, "read-only replaces the composer instead of leaving a disabled box");
});

test("identity switch resets imageSending busy state and stale request cannot keep new identity locked", async () => {
  const source = readFileSync(path.join(webRoot, "src/components/support/customer-support-workspace.tsx"), "utf8");
  const ast = ts.createSourceFile("w.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const funcs = {};
  function visit(n) {
    if (ts.isVariableDeclaration(n) && ["sendPendingImage"].includes(n.name.getText(ast))) {
      funcs[n.name.getText(ast)] = n.initializer.getText(ast);
    }
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(funcs.sendPendingImage, "sendPendingImage extracted");

  // In-flight request for identity A
  let finishA;
  let imageBusy = false;
  const generation = { current: 1 };
  const identity = { current: "user-A" };
  const activeIntentRef = { current: null };
  const clientA = {
    accountId: "user-A",
    sendImage: () => new Promise((resolve) => { finishA = resolve; }),
  };
  const clientRef = { current: clientA };

  const sendPendingImage = new Function(
    "clientRef", "identityGenerationRef", "currentIdentity", "identityRef", "activeSendingIntentIdRef",
    "setImageSending", "setError", "messageFromNim", "setMessages", "mergeImMessages", "setPendingImageFor",
    "revalidateAfterUnauthorized", "NimImageSendError",
    ts.transpileModule("const run=" + funcs.sendPendingImage, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + ";return run;"
  )(
    clientRef, generation, "user-A", identity, activeIntentRef,
    (val) => { imageBusy = val; }, () => {}, () => null, () => {}, () => {}, () => {}, () => {}, Error
  );

  const promiseA = sendPendingImage("conv-A", { id: "intent-A", conversationId: "team-A", file: { name: "shotA.png" } });
  assert.equal(imageBusy, true, "imageSending is set to true when sending starts for identity A");
  assert.equal(activeIntentRef.current, "intent-A", "activeSendingIntentIdRef holds in-flight intent");

  // Simulate identity switch to user-B (common cleanup resets imageBusy and ref)
  generation.current = 2;
  identity.current = "user-B";
  clientRef.current = { accountId: "user-B" };
  imageBusy = false;
  activeIntentRef.current = null;

  // Stale request A completes late
  finishA({});
  await promiseA;

  // Verify stale request cannot mutate or lock new identity B
  assert.equal(imageBusy, false, "new identity B is not locked by stale request A completion");
  assert.equal(activeIntentRef.current, null, "activeSendingIntentIdRef remains cleared for new identity");
});

test("drag and drop image stages file, composer renders kbd shortcuts, and supportedImageUrl accepts local URLs", async (t) => {
  const source = readFileSync(path.join(webRoot, "src/components/support/customer-support-workspace.tsx"), "utf8");
  const ast = ts.createSourceFile("w.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const funcs = {};
  function visit(n) {
    if (ts.isFunctionDeclaration(n) && ["supportedImageUrl", "imageOf"].includes(n.name?.getText(ast))) {
      funcs[n.name.getText(ast)] = n.getText(ast);
    }
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(funcs.supportedImageUrl, "supportedImageUrl extracted");
  assert.ok(funcs.imageOf, "imageOf extracted");

  const supportedImageUrl = new Function(
    ts.transpileModule(funcs.supportedImageUrl + ";return supportedImageUrl;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  )();
  const imageOf = new Function(
    "supportedImageUrl",
    ts.transpileModule(funcs.imageOf + ";return imageOf;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  )(supportedImageUrl);

  // Test supportedImageUrl exact-origin enforcement
  assert.equal(supportedImageUrl("/api/im/images/img-123"), "/api/im/images/img-123", "relative /api/im/images/ allowed");
  assert.equal(supportedImageUrl("http://127.0.0.1:4240/api/im/images/img-123"), "http://127.0.0.1:4240/api/im/images/img-123", "same-origin HTTP allowed");
  assert.equal(supportedImageUrl("http://127.0.0.1:9999/api/im/images/img-123"), null, "cross-port HTTP rejected");
  assert.equal(supportedImageUrl("http://localhost:4240/api/im/images/img-123"), null, "cross-host HTTP rejected");
  assert.equal(supportedImageUrl("https://example.com/pic.jpg"), "https://example.com/pic.jpg", "https allowed");
  assert.equal(supportedImageUrl("blob:http://127.0.0.1:4240/fake"), null, "blob rejected");
  assert.equal(supportedImageUrl("javascript:alert(1)"), null, "javascript rejected");

  // Test imageOf fallback and bypass prevention
  const fallbackImg = imageOf({ messageType: 1, attachment: { imageId: "fallback-id-1" } });
  assert.equal(fallbackImg?.url, "/api/im/images/fallback-id-1", "imageOf falls back to imageId URL when raw url is absent");

  const rejectedRawImg = imageOf({
    messageType: 1,
    attachment: { url: "http://127.0.0.1:9999/evil.png", imageId: "bypass-id" },
  });
  assert.equal(rejectedRawImg?.url, undefined, "imageOf rejects cross-port rawUrl without falling back to imageId");
  assert.equal(rejectedRawImg?.imageId, "", "imageOf clears imageId when rawUrl was provided but rejected");

  // Test drag & drop in rendered workspace
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  globalThis.URL.createObjectURL = () => "blob:drag-stage-1";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: [{ id: "c-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-1", messageScopeState: "READY", assignedAdmin: { id: "a-1", name: "客服甲" } }] }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/messages")) {
      return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
  });

  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => host.querySelector(".support-composer"));
  const composer = host.querySelector(".support-composer");
  assert.ok(composer, "composer rendered");

  // Verify kbd shortcuts
  const kbds = host.querySelectorAll(".support-kbd");
  assert.ok(kbds.length >= 2, "kbd shortcut elements rendered");

  // Simulate drag and drop
  const dropFile = new browser.File([new Uint8Array([1, 2, 3])], "drag-proof.png", { type: "image/png" });
  const dragEvent = new browser.Event("drop", { bubbles: true });
  Object.defineProperty(dragEvent, "dataTransfer", {
    value: { files: [dropFile] },
    configurable: true,
  });
  await act(async () => {
    composer.dispatchEvent(dragEvent);
  });
  await until(() => host.querySelector(".support-staged-image"));
  assert.match(host.querySelector(".support-staged-image").textContent, /drag-proof\.png/, "dragged image is staged");
});

test("sequential multi-image queue: text-first ordering, max in-flight 1, UNKNOWN pauses remainder, original id retry, and no duplicates", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  let stageCount = 0;
  globalThis.URL.createObjectURL = () => `blob:multi-stage-${++stageCount}`;

  const sendSequence = [];
  let currentInFlight = 0;
  let maxInFlight = 0;
  let triggerUnknownForPic2 = true;
  let pic2FirstClientId = null;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: [{ id: "c-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-1", messageScopeState: "READY", assignedAdmin: { id: "a-1", name: "客服甲" } }] }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "POST") {
        currentInFlight += 1;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        const body = JSON.parse(String(init.body));

        await new Promise((resolve) => setTimeout(resolve, 15));

        if (body.text) {
          sendSequence.push({ type: "text", text: body.text });
          currentInFlight -= 1;
          return new Response(JSON.stringify({ message: { messageClientId: "t-1", messageServerId: "srv-t1", conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: Date.now(), text: body.text, messageType: 0 } }), { headers: { "content-type": "application/json" } });
        }

        if (body.image) {
          const imageName = body.image.name;
          sendSequence.push({ type: "image", name: imageName, messageClientId: body.image.messageClientId });

          if (imageName === "pic2.png" && triggerUnknownForPic2) {
            triggerUnknownForPic2 = false;
            pic2FirstClientId = body.image.messageClientId;
            currentInFlight -= 1;
            // 503 triggers UNKNOWN
            return new Response("gateway timeout", { status: 503 });
          }

          currentInFlight -= 1;
          return new Response(JSON.stringify({ message: { messageClientId: body.image.messageClientId, messageServerId: `srv-${imageName}`, conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: Date.now(), messageType: 1, attachment: { imageId: `img-${imageName}`, name: imageName, mimeType: body.image.mimeType, size: body.image.size } } }), { headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
  });

  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => host.querySelector(".support-composer"));

  // 1. Stage 3 images
  const composer = host.querySelector(".support-composer");
  const file1 = new browser.File([new Uint8Array([1])], "pic1.png", { type: "image/png" });
  const file2 = new browser.File([new Uint8Array([2])], "pic2.png", { type: "image/png" });
  const file3 = new browser.File([new Uint8Array([3])], "pic3.png", { type: "image/png" });

  const dropEvent = new browser.Event("drop", { bubbles: true });
  Object.defineProperty(dropEvent, "dataTransfer", {
    value: { files: [file1, file2, file3] },
    configurable: true,
  });
  await act(async () => { composer.dispatchEvent(dropEvent); });
  await until(() => host.querySelectorAll(".support-staged-image").length === 3);

  assert.equal(sendSequence.length, 0, "staging images triggers zero network calls");
  assert.equal(host.querySelectorAll(".support-staged-image").length, 3, "all 3 images staged");

  // 2. Set draft text
  await act(async () => {
    const element = host.querySelector("textarea");
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(element, "Hello Support with 3 pics");
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // 3. Submit
  await act(async () => {
    composer.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  });

  // Wait for pic2 to hit UNKNOWN and pause
  await until(() => host.querySelector('.support-pending-image[data-state="UNKNOWN"]'));
  assert.equal(maxInFlight, 1, "max in-flight requests at any moment is strictly 1");

  // Verify sendSequence: text first, then pic1, then pic2, and pic3 NEVER called yet
  assert.equal(sendSequence[0]?.type, "text", "text is sent first before any images");
  assert.equal(sendSequence[1]?.type, "image", "pic1 is sent next");
  assert.equal(sendSequence[1]?.name, "pic1.png");
  assert.equal(sendSequence[2]?.type, "image", "pic2 is sent third");
  assert.equal(sendSequence[2]?.name, "pic2.png");
  assert.equal(sendSequence.some((s) => s.name === "pic3.png"), false, "pic3 is NOT sent after pic2 hits UNKNOWN");

  // Verify UI states: pic2 shows in pending image with 未确认, pic3 remains staged
  assert.match(host.querySelector(".support-pending-image").textContent, /未确认/);
  assert.match(host.querySelector(".support-pending-image").textContent, /pic2\.png/);
  assert.equal(host.querySelectorAll(".support-staged-image").length, 1, "pic3 remains in staged queue");
  assert.match(host.querySelector(".support-staged-image").textContent, /pic3\.png/);

  // 4. Retry pic2: should reuse pic2FirstClientId, and upon success pic3 continues automatically
  const retryBtn = [...host.querySelectorAll(".support-pending-image button")].find((b) => b.textContent.includes("重试"));
  assert.ok(retryBtn, "retry button is present");

  await act(async () => {
    retryBtn.click();
  });

  // Wait until both pic2 retry and pic3 finish
  await until(() => sendSequence.length === 5); // [text, pic1, pic2-fail, pic2-retry, pic3]
  assert.equal(sendSequence[3]?.name, "pic2.png", "pic2 was retried");
  assert.equal(sendSequence[3]?.messageClientId, pic2FirstClientId, "pic2 retry reused original messageClientId");
  assert.equal(sendSequence[4]?.name, "pic3.png", "pic3 sent sequentially after pic2 recovery");

  // Verify text and pic1 were never resent
  const textSends = sendSequence.filter((s) => s.type === "text");
  assert.equal(textSends.length, 1, "text was sent exactly once");
  const pic1Sends = sendSequence.filter((s) => s.name === "pic1.png");
  assert.equal(pic1Sends.length, 1, "pic1 was sent exactly once without duplicate");

  // Verify all staged and pending are cleanly resolved
  await until(() => host.querySelector(".support-pending-image") === null);
  assert.equal(host.querySelector(".support-staged-image"), null, "all staged images cleared after queue completion");
});

test("multi-image queue bounds: max 6 images, invalid formats rejected with errors, and individual removal revokes previewUrl", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
  const revokedUrls = [];
  let stageCount = 0;
  globalThis.URL.createObjectURL = () => `blob:bound-stage-${++stageCount}`;
  globalThis.URL.revokeObjectURL = (url) => { revokedUrls.push(url); };

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: [{ id: "c-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-1", messageScopeState: "READY", assignedAdmin: { id: "a-1", name: "客服甲" } }] }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/messages")) return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  });

  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => host.querySelector(".support-composer"));

  const composer = host.querySelector(".support-composer");

  // Attempt to drop 8 files: 1 invalid text, 7 png images
  const badFile = new browser.File([new Uint8Array([1])], "bad.txt", { type: "text/plain" });
  const validFiles = Array.from({ length: 7 }, (_, i) => new browser.File([new Uint8Array([i + 1])], `img-${i + 1}.png`, { type: "image/png" }));

  const dropEvent = new browser.Event("drop", { bubbles: true });
  Object.defineProperty(dropEvent, "dataTransfer", {
    value: { files: [badFile, ...validFiles] },
    configurable: true,
  });
  await act(async () => { composer.dispatchEvent(dropEvent); });
  await until(() => host.querySelectorAll(".support-staged-image").length === 6);

  // Exactly 6 staged images allowed, bad.txt skipped, 7th image omitted due to 6 limit
  assert.equal(host.querySelectorAll(".support-staged-image").length, 6, "queue bounded at exactly 6 images");
  assert.match(host.textContent, /最多保留 6 张/);

  // Remove the 1st staged image
  const removeButtons = host.querySelectorAll(".support-staged-remove");
  assert.equal(removeButtons.length, 6);
  await act(async () => {
    removeButtons[0].click();
  });
  await settle();

  assert.equal(host.querySelectorAll(".support-staged-image").length, 5, "one image removed, 5 remaining");
  assert.ok(revokedUrls.includes("blob:bound-stage-1"), "previewUrl of removed image is immediately revoked");
});

test("UNKNOWN pending image strictly protects against removal and cannot be bypassed or skipped", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  let stageCount = 0;
  globalThis.URL.createObjectURL = () => `blob:protect-unknown-${++stageCount}`;

  const sendSequence = [];
  let picAAttempts = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: [{ id: "c-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-1", messageScopeState: "READY", assignedAdmin: { id: "a-1", name: "客服甲" } }] }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.image) {
          const imageName = body.image.name;
          sendSequence.push({ name: imageName, messageClientId: body.image.messageClientId });
          if (imageName === "picA.png") {
            picAAttempts += 1;
            if (picAAttempts === 1) {
              return new Response("gateway timeout", { status: 503 });
            }
          }
          return new Response(JSON.stringify({ message: { messageClientId: body.image.messageClientId, messageServerId: `srv-${imageName}`, conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: Date.now(), messageType: 1, attachment: { imageId: `img-${imageName}`, name: imageName, mimeType: body.image.mimeType, size: body.image.size } } }), { headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
  });

  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  await settle(); await settle();
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => host.querySelector(".support-composer"));

  const composer = host.querySelector(".support-composer");
  const fileA = new browser.File([new Uint8Array([1])], "picA.png", { type: "image/png" });
  const fileB = new browser.File([new Uint8Array([2])], "picB.png", { type: "image/png" });

  const dropEvent = new browser.Event("drop", { bubbles: true });
  Object.defineProperty(dropEvent, "dataTransfer", {
    value: { files: [fileA, fileB] },
    configurable: true,
  });
  await act(async () => { composer.dispatchEvent(dropEvent); });
  await until(() => host.querySelectorAll(".support-staged-image").length === 2);

  // Submit
  await act(async () => {
    composer.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  });

  // Wait for picA to fail with UNKNOWN
  await until(() => host.querySelector('.support-pending-image[data-state="UNKNOWN"]'));
  const pendingBanner = host.querySelector(".support-pending-image");
  assert.match(pendingBanner.textContent, /picA\.png/);
  assert.match(pendingBanner.textContent, /发送结果未确认/);

  // 1. Assert "移除" button is disabled in UNKNOWN state
  const removeBtn = [...pendingBanner.querySelectorAll("button")].find((b) => b.textContent.trim() === "移除");
  assert.ok(removeBtn);
  assert.equal(removeBtn.disabled, true, "remove button must be disabled for UNKNOWN image");

  // Clicking it must not remove the pending item
  await act(async () => {
    removeBtn.click();
  });
  await settle();
  assert.ok(host.querySelector('.support-pending-image[data-state="UNKNOWN"]'), "UNKNOWN pending image survives remove attempt");

  // 2. Assert no "继续发送后续" button in pending banner
  const skipBtn = [...pendingBanner.querySelectorAll("button")].find((b) => b.textContent.includes("继续发送后续"));
  assert.equal(skipBtn, undefined, "cannot skip an un-converged UNKNOWN image");

  // 3. Retry picA with original ID
  const retryBtn = [...pendingBanner.querySelectorAll("button")].find((b) => b.textContent.includes("重试"));
  assert.ok(retryBtn);
  await act(async () => {
    retryBtn.click();
  });

  // Wait for queue to complete both picA and picB
  await until(() => sendSequence.length === 3); // [picA-fail, picA-retry, picB]
  assert.equal(sendSequence[0]?.name, "picA.png");
  assert.equal(sendSequence[1]?.name, "picA.png");
  assert.equal(sendSequence[1]?.messageClientId, sendSequence[0]?.messageClientId, "retry picA reuses messageClientId");
  assert.equal(sendSequence[2]?.name, "picB.png", "picB sent after picA resolution");
});

test("closing window pauses sequential image queue, returning allows explicit resume", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  let stageCount = 0;
  globalThis.URL.createObjectURL = () => `blob:pause-resume-${++stageCount}`;

  const sendSequence = [];
  let pic1HoldResolve = null;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: [{ id: "c-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-1", messageScopeState: "READY", assignedAdmin: { id: "a-1", name: "客服甲" } }] }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.image) {
          const imageName = body.image.name;
          sendSequence.push({ name: imageName });
          if (imageName === "pic1.png") {
            await new Promise((resolve) => { pic1HoldResolve = resolve; });
          }
          return new Response(JSON.stringify({ message: { messageClientId: body.image.messageClientId, messageServerId: `srv-${imageName}`, conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: Date.now(), messageType: 1, attachment: { imageId: `img-${imageName}`, name: imageName, mimeType: body.image.mimeType, size: body.image.size } } }), { headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
  });

  await act(async () => root.render(renderPreview({ preview: false, embedded: true, visible: true, onClose: () => {} })));
  await settle(); await settle();
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => host.querySelector(".support-composer"));

  const composer = host.querySelector(".support-composer");
  const file1 = new browser.File([new Uint8Array([1])], "pic1.png", { type: "image/png" });
  const file2 = new browser.File([new Uint8Array([2])], "pic2.png", { type: "image/png" });

  const dropEvent = new browser.Event("drop", { bubbles: true });
  Object.defineProperty(dropEvent, "dataTransfer", {
    value: { files: [file1, file2] },
    configurable: true,
  });
  await act(async () => { composer.dispatchEvent(dropEvent); });
  await until(() => host.querySelectorAll(".support-staged-image").length === 2);

  // Submit
  await act(async () => {
    composer.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  });

  // Wait until pic1 is in-flight
  await until(() => sendSequence.length === 1);
  assert.equal(sendSequence[0]?.name, "pic1.png");

  // While pic1 is in-flight, simulate closing window (visible = false)
  await act(async () => {
    root.render(renderPreview({ preview: false, embedded: true, visible: false, onClose: () => {} }));
  });
  await settle();

  // Release pic1 hold so pic1 completes
  pic1HoldResolve();
  await settle(); await settle();

  // Assert pic2 was NOT sent (zero network calls while closed)
  assert.equal(sendSequence.length, 1, "pic2 must NOT be sent while window is closed");

  // Re-open window (visible = true)
  await act(async () => {
    root.render(renderPreview({ preview: false, embedded: true, visible: true, onClose: () => {} }));
  });
  await settle(); await settle();

  // pic2 is still in staged queue with resume button
  await until(() => host.querySelector(".support-staged-image"));
  assert.match(host.querySelector(".support-staged-image").textContent, /pic2\.png/);
  const resumeBtn = host.querySelector(".support-staged-resume-button");
  assert.ok(resumeBtn, "resume button is shown in staged tray header");

  // Click resume button
  await act(async () => {
    resumeBtn.click();
  });

  // Now pic2 is sent
  await until(() => sendSequence.length === 2);
  assert.equal(sendSequence[1]?.name, "pic2.png", "pic2 sent after explicit resume");
});

test("a closed consultation is read-only: it states the end instead of waiting for a first message",async(t)=>{
 const old=globalThis.fetch;const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();globalThis.fetch=old;});
 globalThis.fetch=async(input)=>{
  const url=String(input);
  if(url.includes('/im/token'))return new Response(JSON.stringify({}),{status:503});
  if(url.includes('/im/consultations'))return new Response(JSON.stringify({consultations:[{id:'closed-1',type:'SERVICE',state:'CLOSED',conversationId:null,assignedAdmin:null,messageScopeState:'READY'}]}),{status:200});
  if(url.startsWith('/api/orders/'))return new Response(JSON.stringify({items:[],nextCursor:null}),{status:200});
  return new Response(JSON.stringify({}),{status:200});
 };
 await act(async()=>root.render(renderPreview({preview:false,embedded:true})));
 const until=async predicate=>{for(let index=0;index<150;index+=1){if(predicate())return;await settle();}throw new Error('closed consultation condition timed out');};
 // Opening the window only auto-selects a live consultation; an ended one is entered
 // explicitly from the directory, exactly like a user reviewing past history.
 await until(()=>host.querySelector('.support-directory .support-conversation-item'));
 await act(async()=>host.querySelector('.support-directory .support-conversation-item').click());
 await settle();
 assert.ok(host.querySelector('.support-unified'),'a closed consultation still opens the expanded window');
 assert.doesNotMatch(host.textContent,/等待第一条消息/,'an ended consultation must not look like it awaits a first message');
 assert.match(host.textContent,/本次咨询已结束/);
 assert.equal(host.querySelector('textarea'),null,'an ended consultation offers no waiting-for-reception input');
 assert.doesNotMatch(host.textContent,/等待客服接待后可发送消息/);
 assert.ok(host.querySelector('[data-action="start-new-consultation"]'),'the ended consultation keeps the new-consultation entry');
 assert.ok(host.querySelector('.support-composer-closed'),'the composer area states the session ended');
});

/** Mount the real non-preview workspace with a fixed directory and count creations. */
async function mountSupportDirectory(t, consultations, props = {}) {
  const originalFetch = globalThis.fetch;
  const creates = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }));
    if (url.includes("/im/consultations")) {
      if ((init.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init.body));
        creates.push(body);
        return new Response(JSON.stringify({ consultation: { id: "created-1", type: body.type, state: "WAITING", conversationId: null, assignedAdmin: null, messageScopeState: "READY" } }));
      }
      return new Response(JSON.stringify({ consultations }));
    }
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }));
    if (url.includes("/im/messages")) return new Response(JSON.stringify({ messages: [] }));
    throw new Error(`unexpected support fetch ${url}`);
  };
  const host = browser.document.createElement("div"); host.className = "support-dialog-content"; browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {}, ...props })));
  const until = async (predicate, label = "condition") => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error(`${label} timed out`); };
  return { host, creates, until };
}

test("opening with SERVICE never presents or creates a live COMPLAINT conversation", async (t) => {
  const { host, creates, until } = await mountSupportDirectory(t, [
    { id: "complaint-1", type: "COMPLAINT", state: "WAITING", conversationId: null, assignedAdmin: null, messageScopeState: "READY" },
  ], { initialType: "SERVICE" });
  await until(() => host.querySelector(".support-directory .support-conversation-item"), "directory");
  await until(() => host.querySelector('.support-start-panel[data-state="initial"]'), "service start panel");
  const panel = host.querySelector(".support-conversation-panel");
  assert.match(panel.textContent, /从这里开始你的咨询/, "the requested type starts from its own panel");
  assert.match(panel.textContent, /开始平台客服/);
  assert.match(panel.querySelector('.support-type-picker [role="radio"][aria-checked="true"]').textContent, /在线客服/, "the picker shows SERVICE");
  assert.doesNotMatch(panel.textContent, /已记录，等待客服接待/, "the complaint conversation is not shown in the chat pane");
  assert.equal(host.querySelector(".support-message-scroller"), null, "no conversation timeline is mounted");
  assert.equal(creates.length, 0, "opening the window never creates a consultation");
});

test("opening with COMPLAINT on a live SERVICE directory shows the COMPLAINT start panel", async (t) => {
  const { host, creates, until } = await mountSupportDirectory(t, [
    { id: "service-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-service", messageScopeState: "READY", assignedAdmin: { id: "a-1", name: "客服甲" } },
  ], { initialType: "COMPLAINT" });
  await until(() => host.querySelector(".support-directory .support-conversation-item"), "directory");
  await until(() => host.querySelector('.support-start-panel[data-state="initial"]'), "complaint start panel");
  const panel = host.querySelector(".support-conversation-panel");
  assert.match(panel.querySelector('.support-type-picker [role="radio"][aria-checked="true"]').textContent, /投诉反馈/, "the picker follows the entry type");
  assert.match(panel.textContent, /开始投诉反馈/);
  assert.equal(creates.length, 0, "the other type's live consultation is not reused and nothing is created");
});

test("opening selects the live consultation of the requested type", async (t) => {
  for (const [type, state, expected] of [["COMPLAINT", "ACTIVE", /投诉反馈/], ["SERVICE", "WAITING", /平台客服/]]) {
    const other = type === "COMPLAINT" ? "SERVICE" : "COMPLAINT";
    const { host, until } = await mountSupportDirectory(t, [
      { id: `live-${type}`, type, state, conversationId: state === "ACTIVE" ? `team-${type}` : null, messageScopeState: "READY", assignedAdmin: state === "ACTIVE" ? { id: "a-1", name: "客服甲" } : null },
      { id: `other-${other}`, type: other, state: "CLOSED", conversationId: null, messageScopeState: "READY", assignedAdmin: null },
    ], { initialType: type });
    await until(() => host.querySelector('.support-directory .support-conversation-item[data-active="true"]'), `${type} selection`);
    const active = host.querySelector('.support-directory .support-conversation-item[data-active="true"]');
    assert.match(active.textContent, expected, `the ${type} consultation is selected instead of the ${other} one`);
    assert.match(host.querySelector(".support-conversation-identity h3").textContent, expected);
    assert.equal(host.querySelector('.support-start-panel[data-state="initial"]'), null, "a live consultation replaces the start panel");
  }
});

test("from an ended conversation the new-consultation entry opens the start panel without creating", async (t) => {
  const { host, creates, until } = await mountSupportDirectory(t, [
    { id: "complaint-1", type: "COMPLAINT", state: "ACTIVE", conversationId: "team-complaint", messageScopeState: "READY", assignedAdmin: { id: "a-2", name: "专员乙" } },
    { id: "service-1", type: "SERVICE", state: "CLOSED", conversationId: null, messageScopeState: "READY", assignedAdmin: null },
  ], { initialType: "COMPLAINT" });
  await until(() => host.querySelector('.support-directory .support-conversation-item[data-active="true"]'), "complaint selection");
  const ended = [...host.querySelectorAll(".support-directory .support-conversation-item")].find((item) => item.textContent.includes("平台客服"));
  assert.ok(ended, "the ended service consultation stays listed");
  await act(async () => { ended.click(); });
  await settle();
  const entry = host.querySelector('[data-action="start-new-consultation"]');
  assert.ok(entry, "the ended conversation offers the new-consultation entry");
  assert.match(entry.textContent, /发起新咨询/);
  await act(async () => { entry.click(); });
  await settle();
  const panel = host.querySelector('.support-start-panel[data-state="new"]');
  assert.ok(panel, "the entry shows the start panel instead of creating directly");
  assert.match(panel.textContent, /发起新的咨询/);
  assert.match(panel.querySelector('.support-type-picker [role="radio"][aria-checked="true"]').textContent, /在线客服/);
  assert.equal(creates.length, 0, "nothing is created before the explicit start click");
});

test("a definite rejection that never reached the channel leaves the composer usable", async (t) => {
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }));
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: [{ id: "c-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-1", messageScopeState: "READY", peerAccountId: "admin-1", assignedAdmin: { id: "a-1", name: "客服甲" } }] }));
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return new Response(JSON.stringify({ message: { messageClientId: "srv-1", messageServerId: "srv-1", conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: 3, text: body.text, messageType: 0 } }));
      }
      return new Response(JSON.stringify({ messages: [] }));
    }
    return new Response(JSON.stringify({}));
  };
  const host = browser.document.createElement("div"); browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => Boolean(host.querySelector("textarea")) && !host.querySelector("textarea").disabled);
  const type = async (value) => {
    await act(async () => {
      const element = host.querySelector("textarea");
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  // Rejected by the client before the request starts: nothing is in flight and no
  // responsibility remains, so a corrected draft must still be sendable.
  await type("长".repeat(4_001));
  await act(async () => { host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await until(() => Boolean(host.querySelector(".support-send-retry")));
  assert.equal(posts.length, 0, "the over-length draft never reached the channel");
  assert.doesNotMatch(host.textContent, /结果未确认/, "a rejection before the request started is not an unconfirmed result");
  await type("改写后的内容");
  await act(async () => { host.querySelector('button[type="submit"]').click(); });
  await until(() => posts.length === 1);
  assert.equal(posts[0].text, "改写后的内容", "the corrected draft is dispatched instead of locked out");
  assert.doesNotMatch(host.textContent, /原消息标识不可用/, "no phantom original-message claim for a request that never started");
});

test("a batch stops dispatching the remaining images once the send capability is gone", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalSetInterval = window.setInterval;
  let stageCount = 0;
  let tick = null;
  let scopeState = "READY";
  let releasePic1 = null;
  const sent = [];
  globalThis.URL.createObjectURL = () => "blob:revoke-" + (++stageCount);
  window.setInterval = (callback, ms) => { if (ms === 5000) tick = callback; return originalSetInterval(callback, ms); };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }));
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: [{ id: "c-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-1", messageScopeState: scopeState, peerAccountId: "admin-1", assignedAdmin: { id: "a-1", name: "客服甲" } }] }));
    if (url.includes("/im/messages") && (init.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init.body));
      const name = body.image.name;
      sent.push(name);
      if (name === "pic1.png") await new Promise((resolve) => { releasePic1 = resolve; });
      return new Response(JSON.stringify({ message: { messageClientId: body.image.messageClientId, messageServerId: "srv-" + name, conversationId: body.conversationId, senderId: "preview-user", receiverId: "team-1", createTime: Date.now(), messageType: 1, attachment: { imageId: "img-" + name, name, mimeType: body.image.mimeType, size: body.image.size } } }));
    }
    return new Response(JSON.stringify({ messages: [] }));
  };
  const host = browser.document.createElement("div"); browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    window.setInterval = originalSetInterval;
  });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => Boolean(host.querySelector(".support-composer")));
  const composer = host.querySelector(".support-composer");
  const files = [new browser.File([new Uint8Array([1])], "pic1.png", { type: "image/png" }), new browser.File([new Uint8Array([2])], "pic2.png", { type: "image/png" })];
  const drop = new browser.Event("drop", { bubbles: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files }, configurable: true });
  await act(async () => { composer.dispatchEvent(drop); });
  await until(() => host.querySelectorAll(".support-staged-image").length === 2);
  await act(async () => { composer.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await until(() => sent.length === 1);

  // The platform takes the send capability away while pic1 is in flight.
  scopeState = "FAILED";
  await act(async () => tick());
  await settle();
  releasePic1();
  await settle(); await settle();
  assert.deepEqual(sent, ["pic1.png"], "pic2 must not be dispatched after the send capability is gone");
  assert.ok(host.querySelector(".support-staged-image"), "pic2 stays in the tray instead of being dropped");
  assert.equal(host.querySelector(".support-staged-resume-button").disabled, true, "resume stays closed while the scope is not sendable");

  scopeState = "READY";
  await act(async () => tick());
  await until(() => Boolean(host.querySelector(".support-staged-resume-button")) && !host.querySelector(".support-staged-resume-button").disabled);
  await act(async () => { host.querySelector(".support-staged-resume-button").click(); });
  await until(() => sent.length === 2);
  assert.equal(sent[1], "pic2.png", "the paused item dispatches only after the capability returns");
});

test("a previous agent's history is never re-labelled with the current 接待人", async (t) => {
  const originalFetch = globalThis.fetch;
  const history = [
    { messageClientId: "h1", conversationId: "team-1", senderId: "admin-prev", receiverId: "preview-user", createTime: 1_700_000_000_000, messageType: 0, text: "上一位客服的答复" },
    { messageClientId: "h2", conversationId: "team-1", senderId: "admin-now", receiverId: "preview-user", createTime: 1_700_000_600_000, messageType: 0, text: "当前客服的答复" },
  ];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }));
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: [{ id: "c-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-1", messageScopeState: "READY", peerAccountId: "admin-now", assignedAdmin: { id: "a-1", name: "客服甲" } }] }));
    if (url.includes("/im/messages")) return (init.method ?? "GET") === "POST" ? new Response(JSON.stringify({ message: history[1] })) : new Response(JSON.stringify({ messages: history }));
    return new Response(JSON.stringify({}));
  };
  const host = browser.document.createElement("div"); browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, onClose: () => {} })));
  const until = async (predicate) => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error("condition timed out"); };
  await until(() => host.querySelectorAll('.support-message[data-from="agent"]').length === 2);
  const rows = [...host.querySelectorAll('.support-message[data-from="agent"]')];
  assert.equal(rows[0].querySelector(".support-sender-name").textContent, "客服", "an author outside the current peer scope keeps only the provable role");
  assert.equal(rows[0].querySelector(".support-role-tag"), null, "no role chip duplicates an unproven name");
  assert.equal(rows[1].querySelector(".support-sender-name").textContent, "客服甲", "the current peer keeps its real name");
  assert.equal(rows[1].querySelector(".support-role-tag").textContent, "客服");
});

test("the composer names the real blocker instead of blaming 客服接待", async (t) => {
  const originalFetch = globalThis.fetch;
  let row = { id: "c-1", type: "SERVICE", state: "WAITING", conversationId: null, assignedAdmin: null, messageScopeState: "READY" };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/im/token")) return new Response(JSON.stringify({}), { status: 503 });
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations: [row] }));
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    return new Response(JSON.stringify({}));
  };
  const host = browser.document.createElement("div"); browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  const render = async (key, next) => {
    row = next;
    await act(async () => root.render(renderPreview({ preview: false, embedded: true, key, onClose: () => {} })));
    await settle(); await settle();
    return host.querySelector("textarea").placeholder;
  };
  assert.match(await render("waiting", { id: "c-1", type: "SERVICE", state: "WAITING", conversationId: null, assignedAdmin: null, messageScopeState: "READY" }), /等待客服接待后可发送消息/, "a queued consultation really is waiting for reception");
  assert.match(await render("link-down", { id: "c-2", type: "SERVICE", state: "ACTIVE", conversationId: "team-2", assignedAdmin: { id: "a-1", name: "客服甲" }, messageScopeState: "READY" }), /云信连接未就绪/, "a missing link is reported as a link problem, not as waiting for reception");
});

test("an unconfirmed result without its original id is never re-sent under a new id", async () => {
  const source = readFileSync(path.join(webRoot, "src/components/support/customer-support-workspace.tsx"), "utf8");
  const ast = ts.createSourceFile("w.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bodies = {};
  function visit(n) {
    if (ts.isVariableDeclaration(n) && ["sendPendingImage", "retrySend"].includes(n.name.getText(ast))) bodies[n.name.getText(ast)] = n.initializer.getText(ast);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  const compile = (name, injections) => new Function(...Object.keys(injections), ts.transpileModule("const run=" + bodies[name], { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + ";return run;")(...Object.values(injections));
  const noop = () => {};

  let imagePosts = 0;
  const imageErrors = [];
  const sendPendingImage = compile("sendPendingImage", {
    clientRef: { current: { accountId: "u-1", transport: "nim", retryImage: () => { imagePosts += 1; return Promise.reject(new Error("mutated: re-sent under a new attempt")); }, sendImage: () => { imagePosts += 1; return Promise.reject(new Error("mutated: re-sent under a new attempt")); } } },
    identityGenerationRef: { current: 1 }, currentIdentity: "u-1", identityRef: { current: "u-1" }, activeSendingIntentIdRef: { current: null },
    setImageSending: noop, setError: (value) => imageErrors.push(value), messageFromNim: () => null, setMessages: noop, mergeImMessages: (list) => list,
    setPendingImageFor: noop, revalidateAfterUnauthorized: () => false, NimImageSendError: Error,
  });
  await sendPendingImage("c-1", { conversationId: "team-1", file: { name: "pic.png" }, previewUrl: "blob:x", name: "pic.png", state: "UNKNOWN" });
  assert.equal(imagePosts, 0, "an UNKNOWN image without an original id never starts a new send");
  assert.match(imageErrors.join("|"), /刷新历史/);

  let textPosts = 0;
  const textErrors = [];
  const key = "c-1";
  const retrySend = compile("retrySend", {
    activeConversationKey: key,
    failedTexts: { [key]: { conversationId: "team-1", text: "原文", unknown: true } },
    clientRef: { current: { accountId: "u-1", retryText: () => { textPosts += 1; return Promise.reject(new Error("mutated: re-sent")); }, sendText: () => { textPosts += 1; return Promise.reject(new Error("mutated: re-sent")); } } },
    canSend: true, busy: false, imageSending: false, isSubmittingRef: { current: false },
    identityGenerationRef: { current: 1 }, currentIdentity: "u-1", identityRef: { current: "u-1" }, readHiddenRef: { current: {} },
    setBusy: noop, setError: (value) => textErrors.push(value), setMessages: noop, setDrafts: noop,
    setUnresolvedTextFor: noop, setFailedTexts: noop, mergeImMessages: (list) => list,
    messageFromNim: () => null, revalidateAfterUnauthorized: () => false, NimTextSendError: Error,
    NO_ORIGINAL_ID_HINT: "原消息标识不可用，请先刷新历史确认是否送达。",
  });
  await retrySend();
  assert.equal(textPosts, 0, "an UNKNOWN text without an original id never starts a new send");
  assert.match(textErrors.join("|"), /原消息标识不可用/);
});

/** Two sendable consultations in one window, with a controllable text POST. */
async function mountTwoConversations(t, textHandler) {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  let blobSerial = 0;
  globalThis.URL.createObjectURL = () => "blob:two-conv-" + (++blobSerial);
  const consultations = [
    { id: "c-a", type: "SERVICE", state: "ACTIVE", conversationId: "team-a", messageScopeState: "READY", peerAccountId: "staff-a", assignedAdmin: { id: "a-1", name: "客服甲" } },
    { id: "c-b", type: "COMPLAINT", state: "ACTIVE", conversationId: "team-b", messageScopeState: "READY", peerAccountId: "staff-b", assignedAdmin: { id: "b-1", name: "专员乙" } },
  ];
  const posts = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }));
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations }));
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }));
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify({ messages: [] }));
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (!body.image && textHandler) await textHandler(body, posts);
      const id = `srv-${posts.length}`;
      return new Response(JSON.stringify({ message: {
        messageClientId: body.image ? body.image.messageClientId : id, messageServerId: id,
        conversationId: body.conversationId, senderId: "preview-user", receiverId: body.conversationId,
        createTime: 1_700_000_000_000 + posts.length, messageType: body.image ? 1 : 0,
        ...(body.image ? { attachment: { ...body.image } } : { text: body.text }),
      } }));
    }
    throw new Error(`unexpected user fetch ${url}`);
  };
  const host = browser.document.createElement("div"); browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; globalThis.URL.createObjectURL = originalCreateObjectURL; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, visible: true, onClose: () => {} })));
  const until = async (predicate, label = "condition") => { for (let i = 0; i < 150; i += 1) { if (predicate()) return; await settle(); } throw new Error(`${label} timed out`); };
  await until(() => host.querySelector("textarea") && !host.querySelector("textarea").disabled, "sendable consultation A");
  const type = async (value) => { await act(async () => {
    const element = host.querySelector("textarea");
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }); };
  const submit = async () => { await act(async () => { host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); }); };
  const stage = async (name = "shot.png") => {
    const event = new browser.Event("drop", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [new browser.File([new Uint8Array([1])], name, { type: "image/png" })] }, configurable: true });
    await act(async () => { host.querySelector("form").dispatchEvent(event); });
    await until(() => {
      const items = host.querySelectorAll(".support-staged-image");
      return items.length > 0 && !items[0].textContent.includes("检查中");
    }, "decoded staged image");
  };
  const choose = async (index) => { await act(async () => { host.querySelectorAll(".support-directory .support-conversation-item")[index].click(); }); await settle(); await settle(); };
  const resume = () => host.querySelector(".support-staged-resume-button");
  const imagePosts = () => posts.filter((item) => item.image).length;
  const draft = () => host.querySelector("textarea").value;
  return { host, posts, until, type, submit, stage, choose, resume, imagePosts, draft };
}

test("the tray resume entry cannot dispatch an image while the text stage is in flight", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = await mountTwoConversations(t, async () => { await gate; });
  t.after(() => release());
  await page.stage();
  await page.type("在途文字");
  await page.submit();
  await page.until(() => page.posts.length === 1, "text in flight");
  const button = page.resume();
  assert.ok(button, "the resume button is rendered while the text is still in flight");
  await act(async () => { button.click(); });
  await settle(); await settle();
  assert.equal(page.imagePosts(), 0, "an image must not overtake the text of the same conversation");
  assert.equal(page.posts.length, 1, "resume cannot start a second in-flight request either");
  await act(async () => { release(); });
  await page.until(() => page.imagePosts() === 1, "the queued image dispatches after the text succeeds");
  assert.equal(page.posts.filter((item) => item.text === "在途文字").length, 1, "the text is sent exactly once");
});

test("the tray resume entry cannot bypass an unresolved text result", async (t) => {
  const page = await mountTwoConversations(t, async () => { throw new TypeError("Synthetic network outcome unknown"); });
  await page.stage();
  await page.type("未决文字");
  await page.submit();
  await page.until(() => page.host.querySelector(".support-send-retry")?.textContent.includes("未确认"), "text UNKNOWN responsibility");
  await act(async () => { page.resume().click(); });
  await page.until(() => page.posts.length === 2, "resume routed to the original text");
  await settle();
  assert.equal(page.imagePosts(), 0, "an unresolved text blocks the secondary image entry too");
  assert.equal(page.posts.filter((item) => item.text === "未决文字").length, 2, "resume replays the original text instead of jumping ahead to the image");
  assert.ok(page.host.querySelector(".support-staged-image"), "the queued image is kept, not dropped");
  assert.match(page.host.textContent, /发送结果未确认/, "a failed replay keeps the responsibility open");
});

test("success in another consultation cannot erase this consultation's unresolved text", async (t) => {
  const page = await mountTwoConversations(t, async (body) => { if (body.conversationId === "team-a") throw new TypeError("Synthetic A outcome unknown"); });
  await page.type("A未决原文");
  await page.submit();
  await page.until(() => page.host.querySelector(".support-send-retry")?.textContent.includes("未确认"), "A UNKNOWN");
  await page.choose(1);
  await page.type("B正常文字");
  await page.submit();
  await page.until(() => page.draft() === "", "B success");
  await page.choose(0);
  assert.match(page.host.textContent, /发送结果未确认，内容已保留/, "A keeps its own unresolved responsibility after B succeeds");
  assert.equal(page.draft(), "A未决原文", "A's original draft survives B's success");
  assert.ok([...page.host.querySelectorAll("button")].some((item) => item.textContent === "原消息重试"), "A keeps the original-id retry entry");
});

test("a text receipt settles the original draft while another conversation is selected", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = await mountTwoConversations(t, async () => { await gate; });
  t.after(() => release());
  await page.type("A发送中原文");
  await page.submit();
  await page.until(() => page.posts.length === 1, "A text in flight");
  await page.choose(1);
  await page.type("B的草稿");
  await act(async () => { release(); });
  await page.until(() => page.host.querySelectorAll(".support-directory .support-conversation-item")[0].textContent.includes("A发送中原文"), "A receipt landed");
  assert.equal(page.draft(), "B的草稿", "the receipt never touches the other conversation's draft");
  await page.choose(0);
  assert.equal(page.draft(), "", "an acknowledged original text clears only its own unchanged draft");
});

test("same-frame submissions acquire the in-flight lock before yielding", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = await mountTwoConversations(t, async () => { await gate; });
  t.after(() => release());
  await page.type("同帧原文");
  await act(async () => {
    const form = page.host.querySelector("form");
    form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  });
  await page.until(() => page.posts.length > 0, "first dispatch");
  assert.equal(page.posts.length, 1, "an async no-op gate must not let two submissions acquire the same lock");
  await act(async () => { release(); });
  await page.until(() => page.draft() === "", "one receipt settles the draft");
  assert.equal(page.posts.length, 1, "only the confirmed original submission was sent");
});

function supportMenuHistory() {
  return [
    { messageClientId: "own-text", messageServerId: "srv-own", conversationId: "team-1", senderId: "preview-user", receiverId: "staff-a", createTime: 1_700_000_000_000, text: "我发的原文", messageType: 0 },
    { messageClientId: "peer-text", messageServerId: "srv-peer", conversationId: "team-1", senderId: "staff-a", receiverId: "preview-user", createTime: 1_700_000_001_000, text: "客服回复内容", messageType: 0 },
    { messageClientId: "own-image", messageServerId: "srv-image", conversationId: "team-1", senderId: "preview-user", receiverId: "staff-a", createTime: 1_700_000_002_000, text: "", messageType: 1, attachment: { imageId: "img-1", name: "截图.png", mimeType: "image/png", size: 10 } },
    { messageClientId: "system-notice", messageServerId: "srv-system", conversationId: "team-1", senderId: "system", receiverId: "preview-user", createTime: 1_700_000_003_000, text: "", messageType: 5, attachment: { type: 0 } },
    { messageClientId: "revoked-note", messageServerId: "srv-revoked", conversationId: "team-1", senderId: "staff-a", receiverId: "preview-user", createTime: 1_700_000_004_000, text: "", messageType: 0, revoked: true },
  ];
}

function stubBrowserClipboard(t) {
  const previous = Object.getOwnPropertyDescriptor(browser.navigator, "clipboard");
  let copied = null;
  Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied = text; } } });
  t.after(() => { if (previous) Object.defineProperty(browser.navigator, "clipboard", previous); else delete browser.navigator.clipboard; });
  return () => copied;
}

async function mountSupportActions(t, options = {}) {
  const originalFetch = globalThis.fetch;
  const history = (options.history ?? supportMenuHistory()).map((row) => ({ ...row }));
  const posts = [];
  const replyFailure = options.replyFailure ?? 0;
  const revokeStatus = options.revokeStatus ?? 0;
  const deleteStatus = options.deleteStatus ?? 0;
  const consultations = [{ id: "c-1", type: "SERVICE", state: "ACTIVE", conversationId: "team-1", messageScopeState: "READY", assignedAdmin: { id: "a-1", name: "客服甲" }, peerAccountId: "staff-a", updatedAt: "2026-09-26T00:00:00Z" }];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }));
    if (url.includes("/im/consultations")) return new Response(JSON.stringify({ consultations }));
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }));
    if (url.includes("/im/messages")) {
      if ((init.method ?? "GET") === "GET") {
        const conversationId = new URL(url, "http://synthetic.local").searchParams.get("conversationId");
        return new Response(JSON.stringify({ messages: history.filter((row) => row.conversationId === conversationId) }));
      }
      const body = JSON.parse(String(init.body));
      posts.push(body);
      const reference = body.replyTo ?? body.message;
      const referenceId = reference ? reference.messageServerId || reference.messageClientId : "";
      const target = history.find((row) => (row.messageServerId || row.messageClientId) === referenceId);
      if (body.action === "reply") {
        if (replyFailure) return new Response(JSON.stringify({ error: { code: "SYNTHETIC" } }), { status: replyFailure });
        const sent = {
          messageClientId: `reply-client-${posts.length}`, messageServerId: `srv-reply-${posts.length}`, conversationId: body.conversationId,
          senderId: "preview-user", receiverId: "staff-a", createTime: 1_700_000_100_000 + posts.length, text: body.text, messageType: 0,
          reply: { messageId: referenceId, senderId: target?.senderId ?? "staff-a", text: target?.messageType === 1 ? "[图片]" : target?.text ?? "消息" },
        };
        history.push(sent);
        return new Response(JSON.stringify({ message: sent }));
      }
      if (body.action === "revoke") {
        if (revokeStatus) return new Response(JSON.stringify({ error: { code: "SYNTHETIC" } }), { status: revokeStatus });
        if (target) { target.revoked = true; target.text = ""; delete target.attachment; delete target.reply; }
        const updated = { ...(target ?? {}), messageClientId: target?.messageClientId ?? "revoked-client", ...(target?.messageServerId ? { messageServerId: target.messageServerId } : {}), conversationId: body.conversationId, senderId: target?.senderId ?? "preview-user", receiverId: "staff-a", createTime: target?.createTime ?? 1, text: "", revoked: true };
        return new Response(JSON.stringify({ message: updated }));
      }
      if (body.action === "delete") {
        if (deleteStatus) return new Response(JSON.stringify({ error: { code: "SYNTHETIC" } }), { status: deleteStatus });
        const index = history.findIndex((row) => (row.messageServerId || row.messageClientId) === referenceId);
        if (index >= 0) history.splice(index, 1);
        return new Response(JSON.stringify({ deleted: true }));
      }
      const id = `srv-send-${posts.length}`;
      const sent = { messageClientId: id, messageServerId: id, conversationId: body.conversationId, senderId: "preview-user", receiverId: "staff-a", createTime: 1_700_000_200_000 + posts.length, ...(body.image ? { messageType: 1, attachment: { ...body.image } } : { text: body.text, messageType: 0 }) };
      history.push(sent);
      return new Response(JSON.stringify({ message: sent }));
    }
    throw new Error(`unexpected user fetch ${url}`);
  };
  const host = browser.document.createElement("div"); host.className = "support-dialog-content"; browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(renderPreview({ preview: false, embedded: true, visible: true, onClose: () => {} })));
  const until = async (predicate, label = "support action condition") => { for (let index = 0; index < 150; index += 1) { if (predicate()) return; await settle(); } throw new Error(`${label} timed out`); };
  await until(() => host.querySelector("textarea") && !host.querySelector("textarea").disabled, "sendable consultation");
  await until(() => host.querySelector('[data-message-id="srv-peer"]'), "history rendered");
  const row = (id) => host.querySelector(`[data-message-id="${id}"]`);
  const open = async (id, point = { clientX: 120, clientY: 90 }) => {
    await act(async () => { const target = row(id); assert.ok(target, id); target.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...point })); });
    await settle();
  };
  const labels = () => [...browser.document.querySelectorAll(".message-action-menu [role=menuitem]")].map((item) => item.textContent.trim());
  const pick = async (label) => { const button = [...browser.document.querySelectorAll(".message-action-menu [role=menuitem]")].find((item) => item.textContent.trim() === label); assert.ok(button, label); await act(async () => button.click()); await settle(); };
  const type = async (value) => { await act(async () => { const element = host.querySelector("textarea"); Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); };
  const submit = async () => { await act(async () => { host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); }); };
  const longPress = async (id) => { await act(async () => { row(id).dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 160, clientY: 100 })); await new Promise((resolve) => setTimeout(resolve, 600)); }); };
  return { host, posts, row, open, labels, pick, type, submit, longPress, until, draft: () => host.querySelector("textarea").value };
}

test("support message menu exposes copy/reply/revoke/delete by type and ownership and replaces the native menu", async (t) => {
  const page = await mountSupportActions(t);
  const copied = stubBrowserClipboard(t);
  await page.open("srv-own");
  assert.deepEqual(page.labels(), ["复制", "回复", "撤回", "删除"]);
  assert.equal(browser.document.querySelector(".message-action-menu").getAttribute("role"), "menu");
  assert.equal(browser.document.activeElement?.getAttribute("role"), "menuitem", "focus enters the first item");
  await page.pick("复制");
  assert.equal(copied(), "我发的原文");
  assert.equal(browser.document.querySelector(".message-action-menu"), null, "copy closes the menu");

  await page.open("srv-peer");
  assert.deepEqual(page.labels(), ["复制", "回复", "删除"], "another account cannot revoke");
  await act(async () => browser.document.activeElement.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await settle();
  assert.equal(browser.document.querySelector(".message-action-menu"), null, "Escape closes");
  assert.equal(browser.document.activeElement, page.row("srv-peer"), "Escape returns focus to the message");

  await page.open("srv-image");
  assert.deepEqual(page.labels(), ["回复", "撤回", "删除"], "images cannot be copied");
  await page.pick("回复");
  assert.match(page.host.querySelector(".message-reply-quote").textContent, /回复：\[图片\]/);
  await act(async () => page.host.querySelector(".message-reply-quote button").click());
  assert.equal(page.host.querySelector(".message-reply-quote"), null);

  const systemEvent = new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  await act(async () => page.row("srv-system").dispatchEvent(systemEvent));
  await settle();
  assert.equal(systemEvent.defaultPrevented, true, "a message row never falls back to the browser menu");
  assert.equal(browser.document.querySelector(".message-action-menu"), null, "system notices have no menu");
  await page.open("srv-revoked");
  assert.equal(browser.document.querySelector(".message-action-menu"), null, "revoked messages have no menu");
  assert.match(page.row("srv-revoked").textContent, /消息已撤回/);

  await page.open("srv-peer", { clientX: 5000, clientY: 5000 });
  const menu = browser.document.querySelector(".message-action-menu");
  assert.ok(parseFloat(menu.style.left) <= browser.innerWidth - 8, "menu is clamped inside the viewport");
  assert.ok(parseFloat(menu.style.top) <= browser.innerHeight - 8);
  await act(async () => browser.document.activeElement.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await settle();
  await page.open("srv-peer");
  await act(async () => browser.document.body.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true })));
  await settle();
  assert.equal(browser.document.querySelector(".message-action-menu"), null, "an outside press closes the menu");
  await page.open("srv-peer");
  await act(async () => browser.dispatchEvent(new browser.Event("scroll")));
  await settle();
  assert.equal(browser.document.querySelector(".message-action-menu"), null, "scrolling closes the menu");
  await page.longPress("srv-peer");
  assert.deepEqual(page.labels(), ["复制", "回复", "删除"], "long press opens the same menu");
});

test("support reply calls replyText, clears the quote after success and a plain send never quotes", async (t) => {
  const page = await mountSupportActions(t);
  await page.open("srv-peer");
  await page.pick("回复");
  assert.match(page.host.querySelector(".message-reply-quote").textContent, /回复：客服回复内容/);
  await page.type("收到");
  await page.submit();
  await page.until(() => page.posts.some((item) => item.action === "reply"), "reply dispatched");
  const reply = page.posts.find((item) => item.action === "reply");
  assert.equal(reply.text, "收到");
  assert.equal(reply.replyTo.messageClientId, "peer-text", "the original message is addressed");
  assert.equal(page.draft(), "", "a confirmed reply clears the draft");
  assert.equal(page.host.querySelector(".message-reply-quote"), null, "a confirmed reply clears the quote");
  await page.until(() => page.host.textContent.includes("回复：客服回复内容"), "reply summary rendered");

  await page.type("普通消息");
  await page.submit();
  await page.until(() => page.posts.some((item) => item.text === "普通消息"), "plain send");
  assert.equal(page.posts.filter((item) => item.action === "reply").length, 1, "no quote means no reply dispatch");
});

test("support reply UNKNOWN keeps text and quote and never re-sends under a new id", async (t) => {
  const page = await mountSupportActions(t, { replyFailure: 500 });
  await page.open("srv-peer");
  await page.pick("回复");
  await page.type("回复内容");
  await page.submit();
  await page.until(() => page.host.textContent.includes("回复结果未确认"), "reply UNKNOWN visible");
  assert.equal(page.draft(), "回复内容", "the reply draft survives an unknown result");
  assert.match(page.host.querySelector(".message-reply-quote").textContent, /回复：客服回复内容/, "the quote survives an unknown result");
  assert.equal(page.posts.filter((item) => item.action === "reply").length, 1);
  await page.submit();
  await settle();
  assert.equal(page.posts.filter((item) => item.action === "reply").length, 1, "a quoted submit cannot repeat an unconfirmed reply");
  await act(async () => page.host.querySelector(".message-reply-quote button").click());
  assert.equal(page.host.querySelector(".message-reply-quote"), null);
  await page.submit();
  await page.until(() => page.posts.some((item) => item.text === "回复内容"), "cancelling the quote allows a plain send");
});

test("support revoke confirms in place, merges the revoked message and keeps 409/403 visible", async (t) => {
  const page = await mountSupportActions(t);
  await page.open("srv-own");
  await page.pick("撤回");
  assert.ok(page.labels().includes("确认撤回"), "the same menu asks for confirmation");
  assert.equal(page.posts.filter((item) => item.action === "revoke").length, 0, "the first press only arms the confirmation");
  await page.pick("确认撤回");
  await page.until(() => page.posts.some((item) => item.action === "revoke"), "revoke dispatched");
  await page.until(() => page.row("srv-own").textContent.includes("消息已撤回"));
  assert.doesNotMatch(page.row("srv-own").textContent, /我发的原文/);
  await page.open("srv-own");
  assert.equal(browser.document.querySelector(".message-action-menu"), null, "a revoked message has no menu");

  for (const [status, copy] of [[409, "已超过可撤回时间"], [403, "无权撤回此消息"]]) {
    const failing = await mountSupportActions(t, { revokeStatus: status });
    await failing.open("srv-own");
    await failing.pick("撤回");
    await failing.pick("确认撤回");
    await failing.until(() => failing.host.querySelector(".support-inline-error")?.textContent.includes(copy));
    assert.match(failing.row("srv-own").textContent, /我发的原文/, "a failed revoke keeps the message");
  }
});

test("support delete removes the message and a failure never fakes success", async (t) => {
  const page = await mountSupportActions(t);
  await page.open("srv-peer");
  await page.pick("删除");
  await page.until(() => !page.row("srv-peer"), "message removed");
  assert.equal(page.posts.filter((item) => item.action === "delete").length, 1);

  const failing = await mountSupportActions(t, { deleteStatus: 500 });
  await failing.open("srv-peer");
  await failing.pick("删除");
  await failing.until(() => failing.host.querySelector(".support-inline-error")?.textContent.includes("删除失败，消息仍保留"));
  assert.ok(failing.row("srv-peer"), "a failed delete keeps the message");
});

// ---- Order-stage cards as chat messages -------------------------------------

const CARD_RAW_LINES = [
  { itemId: "item_haff", name: "哈夫币", quantity: "1000000", buyerUnitPrice: "1", ownerUnitPrice: "0.8", buyerAmount: "1000000", ownerAmount: "800000" },
  { itemId: "item_case", name: "装备箱", quantity: "3", buyerUnitPrice: "6000", ownerUnitPrice: "5000", buyerAmount: "18000", ownerAmount: "15000" },
  { itemId: "item_ammo", name: "弹药箱", quantity: "2", buyerUnitPrice: "5000", ownerUnitPrice: "4000", buyerAmount: "10000", ownerAmount: "8000" },
  { itemId: "item_med", name: "医疗包", quantity: "5", buyerUnitPrice: "800", ownerUnitPrice: "600", buyerAmount: "4000", ownerAmount: "3000" },
];
const CARD_STAFF_TOTALS = { buyerRentalAmount: "1032000", ownerRentalAmount: "826000", buyerTotal: "1532000", ownerTotal: "1126000", platformContribution: "206000" };

/** Synthetic role projections. RENTER deliberately carries staff fields so the UI must drop them. */
function cardTermsFor(party, { basis = "QUOTE" } = {}) {
  if (party === "STAFF") return {
    viewerParty: "STAFF", basis, currency: "CNY", scale: 2, version: "quote-v1", rentalAmount: null, depositAmount: null, paidTotal: null,
    lines: CARD_RAW_LINES.map(line => ({
      itemId: line.itemId, name: line.name, quantity: line.quantity, unitPrice: null, amount: null,
      buyerUnitPrice: line.buyerUnitPrice, ownerUnitPrice: line.ownerUnitPrice, buyerAmount: line.buyerAmount, ownerAmount: line.ownerAmount,
      platformContribution: String(Number(line.buyerAmount) - Number(line.ownerAmount)),
    })),
    staff: { ...CARD_STAFF_TOTALS },
  };
  const owner = party === "OWNER";
  return {
    viewerParty: party, basis, currency: "CNY", scale: 2, version: basis === "QUOTE" ? "quote-v1" : null,
    rentalAmount: basis === "QUOTE" ? (owner ? "826000" : "1032000") : null,
    depositAmount: basis === "QUOTE" ? (owner ? "300000" : "500000") : null,
    paidTotal: basis === "QUOTE" ? (owner ? "1126000" : "1532000") : null,
    lines: CARD_RAW_LINES.map(line => ({
      itemId: line.itemId, name: line.name, quantity: line.quantity,
      unitPrice: basis === "QUOTE" ? (owner ? line.ownerUnitPrice : line.buyerUnitPrice) : null,
      amount: basis === "QUOTE" ? (owner ? line.ownerAmount : line.buyerAmount) : null,
    })),
    ...(owner ? {} : { staff: { ...CARD_STAFF_TOTALS } }),
  };
}

function cardAccess(terms, over = {}) {
  return {
    orderId: "ord-card-1",
    displayNo: "Z9100",
    orderStatus: "PAID",
    stage: "OPENING_CONFIRM",
    dueAt: null,
    openingState: "PARTIAL",
    openingAcks: { renter: true, owner: false },
    endState: "NONE",
    sendUntil: null,
    assignmentState: "ASSIGNED",
    teamState: "READY",
    appId: "app-card",
    teamId: "team-card",
    gameName: "绝区零",
    account: { id: "acc-card-1", title: "高练度全限定号" },
    viewerAccountId: "test-user",
    conversationId: "conv-card",
    canRead: true,
    canSend: true,
    members: [{ platformId: "u-1", accountId: "test-user", party: "USER", name: "买家", avatar: null }],
    supportEscalation: { firstResponseAt: null, remindDueAt: null, addRound: 0, state: "RUNNING", needsManualReview: false, noEligibleStaff: false },
    terms,
    ...over,
  };
}

function cardMessage(kind, index, info) {
  return {
    messageClientId: `card-${index}`, messageServerId: `srv-card-${index}`, conversationId: info.conversationId,
    senderId: "platform-1", receiverId: "test-user", createTime: Date.parse("2026-10-20T02:00:00Z") + index * 60_000,
    messageType: 0, text: "", card: { kind, orderId: info.orderId, cardId: `card-${index}` },
  };
}

async function mountOrderCardPanel(t, info, messages) {
  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const client = {
    accountId: info.viewerAccountId,
    transport: "local-fake",
    getConnectionState: () => "CONNECTED",
    getMessageHistory: async (conversationId) => messages.map(message => ({ ...message, conversationId })),
    onMessages: () => () => {},
    onConnectionStateChange: () => () => {},
  };
  const request = async (requestPath) => requestPath.includes("im?operation=")
    ? info
    : { items: [{ id: info.orderId, displayNo: info.displayNo, title: info.account.title, status: info.orderStatus }], nextCursor: null };
  await act(async () => {
    root.render(createElement(OrderTeamPanel, {
      identity: "user-1", realm: "user", client, connection: "CONNECTED", active: true,
      selectedOrderId: info.orderId, compact: true, request, onAuthError: () => {},
    }));
  });
  await settle();
  await settle();
  return host;
}

test("order stage cards render by kind as chat messages with the stage facts", async (t) => {
  const info = cardAccess(cardTermsFor("STAFF"), { stage: "SETTLED", orderStatus: "COMPLETED", endState: "REQUESTED", dueAt: "2026-10-19T10:00:00.000Z", sendUntil: "2026-10-18T10:00:00.000Z" });
  // 三种阶段卡与一条普通文字消息同处一个会话。
  const host = await mountOrderCardPanel(t, info, [
    cardMessage("ORDER_OPENING", 1, info),
    cardMessage("ORDER_ENDING", 2, info),
    cardMessage("ORDER_SETTLED", 3, info),
  ]);
  const cards = [...host.querySelectorAll(".order-card")];
  assert.deepEqual(cards.map(card => card.getAttribute("data-kind")), ["ORDER_OPENING", "ORDER_ENDING", "ORDER_SETTLED"], "each card keeps its kind");
  assert.equal(cards[0].querySelector(".order-card-title").textContent, "账号信息与开租确认");
  assert.equal(cards[0].querySelector(".order-card-tag").textContent, "本单确认");
  assert.equal(cards[1].querySelector(".order-card-title").textContent, "结束确认");
  assert.equal(cards[2].querySelector(".order-card-title").textContent, "结算完成");
  assert.match(cards[0].textContent, /买家 已确认/);
  assert.match(cards[0].textContent, /号主 待确认/);
  assert.match(cards[1].textContent, /已发起 · 待双方确认/, "endState REQUESTED is spoken as awaiting both sides");
  assert.match(cards[2].textContent, /已结算/);
  assert.match(cards[2].textContent, /仅可查看/, "an expired sendUntil is read-only, not an invented window");
  assert.equal(host.querySelectorAll(".order-team-messages li[data-message-id]").length, 3, "cards stay ordinary message rows");
  for (const card of cards) assert.ok(card.querySelector(".order-card-action"), "every card opens the order detail");
  const staffCard = cards[0];
  assert.equal(staffCard.getAttribute("data-party"), "STAFF");
  assert.match(staffCard.textContent, /平台贡献/, "staff sees the platform contribution");
  assert.match(staffCard.textContent, /买家合计 ¥15,320\.00/, "staff sees both sides");
  assert.match(staffCard.textContent, /号主合计 ¥11,260\.00/);
  assert.match(staffCard.textContent, /物品3 项 · 买家 ¥320\.00 · 号主 ¥260\.00/, "the 物品 row sums only non-Haff lines, not the rental total");
  assert.equal(staffCard.querySelectorAll(".order-card-line").length, 3, "the Haff line is summarized above, so the item list stays at three rows");
  assert.equal(staffCard.querySelector(".order-card-toggle"), null, "three non-Haff items need no fold toggle");
});

test("user cards hide the counterparty and platform amounts, and unknown basis says 待核对", async (t) => {
  const renter = cardAccess(cardTermsFor("RENTER"));
  const renterHost = await mountOrderCardPanel(t, renter, [cardMessage("ORDER_OPENING", 1, renter)]);
  const renterCard = renterHost.querySelector(".order-card");
  assert.equal(renterCard.getAttribute("data-party"), "RENTER");
  assert.match(renterCard.textContent, /押金 ¥5,000\.00 · 实付 ¥15,320\.00/, "the renter sees only their own deposit and payment");
  assert.match(renterCard.textContent, /物品3 项 · 合计 ¥320\.00/, "the 物品 row is the non-Haff item sum, not the rental total");
  assert.doesNotMatch(renterCard.textContent, /¥8,260\.00|¥11,260\.00|¥2,060\.00|平台贡献|号主合计/, "no owner or platform amount leaks to a user");
  assert.match(renterCard.textContent, /稳定 ID acc-card-1/, "the stable account id is shown");
  assert.doesNotMatch(renterCard.textContent, /密码|验证码/, "the card never renders credentials");

  const owner = cardAccess(cardTermsFor("OWNER"));
  const ownerHost = await mountOrderCardPanel(t, owner, [cardMessage("ORDER_OPENING", 1, owner)]);
  const ownerCard = ownerHost.querySelector(".order-card");
  assert.equal(ownerCard.getAttribute("data-party"), "OWNER");
  assert.match(ownerCard.textContent, /保证金 ¥3,000\.00 · 应收 ¥8,260\.00/);
  assert.doesNotMatch(ownerCard.textContent, /¥15,320\.00|¥10,320\.00|¥2,060\.00|平台贡献|买家合计/, "the owner never sees the buyer or platform side");

  const unknown = cardAccess(cardTermsFor("RENTER", { basis: "UNKNOWN" }));
  const unknownHost = await mountOrderCardPanel(t, unknown, [cardMessage("ORDER_OPENING", 1, unknown)]);
  const unknownCard = unknownHost.querySelector(".order-card");
  assert.equal(unknownCard.getAttribute("data-basis"), "UNKNOWN");
  assert.match(unknownCard.textContent, /金额依据待核对/);
  assert.doesNotMatch(unknownCard.textContent, /¥0\.00|¥[\d,]+\.00/, "unreadable amounts are never rendered as zero");
});

test("a long item list folds and a card row still opens the message menu", async (t) => {
  const terms = cardTermsFor("RENTER");
  terms.lines.push({ itemId: "item_extra", name: "战术背心", quantity: "1", unitPrice: "10000", amount: "10000" });
  const info = cardAccess(terms);
  const host = await mountOrderCardPanel(t, info, [cardMessage("ORDER_OPENING", 1, info)]);
  const card = host.querySelector(".order-card");
  const row = card.closest("[data-message-id]");
  assert.ok(row, "the card lives in a message row");
  assert.equal(card.querySelectorAll(".order-card-line").length, 3, "summary first: three item rows");
  const toggle = card.querySelector(".order-card-toggle");
  assert.match(toggle.textContent, /查看完整清单（4 项）/);
  await act(async () => toggle.click());
  assert.equal(card.querySelectorAll(".order-card-line").length, 4, "the full list is one press away");
  assert.match(card.querySelector(".order-card-toggle").textContent, /收起清单/);
  await act(async () => card.querySelector(".order-card-toggle").click());
  assert.equal(card.querySelectorAll(".order-card-line").length, 3);

  await act(async () => row.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 140 })));
  const menu = browser.document.querySelector('.message-action-menu[role="menu"]');
  assert.ok(menu, "contextmenu on a card still opens the platform menu");
  const labels = [...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent.trim());
  assert.ok(labels.includes("删除"), "delete stays available");
  assert.ok(labels.includes("回复"), "a sendable group still offers reply");
  assert.ok(!labels.includes("复制"), "a card has no text to copy");
  await act(async () => browser.document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  assert.equal(browser.document.querySelector(".message-action-menu"), null, "Escape closes the menu");
});
