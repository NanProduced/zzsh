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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

// 模拟窄屏：仅在 ≤760px 时队列/聊天才互斥，借此验证移动端焦点迁移。
browser.matchMedia = (query) => ({
  matches: /max-width:\s*760px/.test(query),
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { ImSupportView } = await vite.ssrLoadModule("/src/views/im-support-view.tsx");
after(async () => { await vite.close(); });

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

const requests = [];
globalThis.fetch = async (input) => {
  requests.push(String(input));
  throw new Error(`preview must not call the network: ${String(input)}`);
};

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

async function mount(t, props) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    rootNode.remove();
  });
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(["im.support.read", "im.support.accept", "im.support.presence"]), onRefresh: async () => snapshot([]), ...props })); });
  await settle();
  return { rootNode, root };
}

test("preview facts bar follows the selected display item instead of a missing real consultation", async (t) => {
  const { rootNode } = await mount(t, { preview: true });

  assert.ok(rootNode.querySelector('.im-support-message-viewport[role="region"]'), "viewport has an explicit CSS target");
  const title = rootNode.querySelector(".im-support-chat-title h2").textContent;
  assert.equal(title, "商品咨询 · 演示", "title comes from the selected preview item");
  const facts = [...rootNode.querySelectorAll(".im-support-facts-bar .im-support-fact-chip")].map((chip) => chip.textContent);
  assert.ok(facts.includes("在线客服"), `facts show the selected type, got ${JSON.stringify(facts)}`);
  assert.ok(facts.includes("处理中"), `facts show the selected state, got ${JSON.stringify(facts)}`);
  assert.ok(facts.includes("本地演示 · 云信未连接"), `local demo state is stated once, got ${JSON.stringify(facts)}`);
  assert.ok(!facts.includes("未选择咨询"), "preview never claims nothing is selected");
  assert.ok(!facts.includes("云信连接等待启动"), "preview never claims a pending NIM connection");
  assert.deepEqual(requests, [], "preview renders without touching the network");
});

test("preview empty conversations keep their selected display state", async (t) => {
  const { rootNode } = await mount(t, { preview: true });
  const emptyItem = rootNode.querySelectorAll(".im-support-queue-item")[1];
  assert.ok(emptyItem, "preview queue includes an empty conversation");

  await act(async () => { emptyItem.click(); });
  await settle();

  assert.equal(rootNode.querySelector(".im-support-chat-title h2").textContent, "一般咨询 · 演示");
  const messageArea = rootNode.querySelector(".im-support-message-area");
  assert.match(messageArea.textContent, /等待第一条消息/);
  assert.doesNotMatch(messageArea.textContent, /尚未选择会话/);
});

test("preview messages keep sender identity, side facts, and sent-only state", async (t) => {
  const { rootNode } = await mount(t, { preview: true });

  const customer = rootNode.querySelector('.im-support-message[data-from="customer"]');
  const agent = rootNode.querySelector('.im-support-message[data-from="agent"]');
  assert.ok(customer && agent, "both preview messages render");
  assert.equal(customer.getAttribute("data-self"), "false");
  assert.equal(agent.getAttribute("data-self"), "true");
  assert.equal(agent.querySelector(".im-support-message-meta span").textContent, "客服 A · 客服");
  assert.equal(customer.querySelector(".im-support-message-meta span").textContent, "演示用户 · 用户");
  assert.match(agent.textContent, /已发送/, "own message shows a sent state");
  assert.doesNotMatch(customer.textContent, /已发送/, "peer messages never show a send state");
  assert.doesNotMatch(rootNode.textContent, /已读/, "preview never claims a read receipt");

  const textarea = rootNode.querySelector("textarea");
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "客服回复检查");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  await act(async () => { rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
  const sent = [...rootNode.querySelectorAll('.im-support-message[data-from="agent"]')].at(-1);
  assert.equal(sent.getAttribute("data-self"), "true");
  assert.match(sent.textContent, /客服回复检查/);
  assert.doesNotMatch(rootNode.textContent, /已读/);
});

test("queue/chat switching moves focus onto the visible pane control", async (t) => {
  const { rootNode } = await mount(t, { preview: true });

  const firstItem = rootNode.querySelector(".im-support-queue-item");
  assert.ok(firstItem, "preview queue renders");
  await act(async () => { firstItem.click(); });
  await settle();
  const activeInChat = browser.document.activeElement;
  assert.equal(activeInChat.getAttribute("data-focus-target"), "chat", `chat switch focuses the chat heading, got ${activeInChat.tagName}`);
  assert.equal(activeInChat, rootNode.querySelector(".im-support-chat-heading"));
  assert.notEqual(activeInChat, browser.document.body, "focus never falls back to body");

  await act(async () => { rootNode.querySelector('[data-action="back-to-queue"]').click(); });
  await settle();
  const activeInQueue = browser.document.activeElement;
  assert.ok(activeInQueue.classList.contains("im-support-queue-item"), `queue switch focuses a queue row, got ${activeInQueue.tagName}`);
  assert.equal(activeInQueue.getAttribute("data-active"), "true", "the selected queue row receives focus");
  assert.equal(rootNode.querySelector(".im-support-queue").contains(activeInQueue), true);
});

test("timeline calendar labels preserve January and December", () => {
  const source = readFileSync(path.join(adminRoot, "src/views/im-support-view.tsx"), "utf8");
  const helpers = source.slice(source.indexOf("function dayKeyOf"), source.indexOf("function connectionForPresence"));
  const { dayKeyOf, dayLabelOf } = new Function(stripTypeScriptTypes(helpers) + ";return { dayKeyOf, dayLabelOf };")();
  assert.equal(dayKeyOf(undefined), null);
  assert.equal(dayKeyOf(NaN), null);
  for (const [month, expected] of [[0, "1月15日"], [11, "12月15日"]]) {
    assert.equal(dayLabelOf(dayKeyOf(new Date(2020, month, 15, 12).getTime())), expected);
  }
  assert.equal(dayLabelOf(dayKeyOf(Date.now())), "今天");
});

test("closing context restores keyboard focus to its trigger", async (t) => {
  const { rootNode } = await mount(t, { preview: true });
  const trigger = rootNode.querySelector('[data-action="toggle-consultation-context"]');
  await act(async () => { trigger.click(); });
  await settle();
  const close = rootNode.querySelector('[data-action="close-consultation-context"]');
  await act(async () => { close.focus(); close.click(); });
  await settle();
  assert.equal(rootNode.querySelector('[data-action="close-consultation-context"]'), null);
  assert.equal(browser.document.activeElement === trigger, true, "focus returns to context trigger");
});
for (const scenario of ["connected", "no-permission", "disconnected"]) {
  test(`nonpreview empty queue presence: ${scenario}`, async (t) => {
    const originalFetch = globalThis.fetch;
    const writes = [];
    let availability = "OFF_DUTY", version = 1;
    const permissions = ["im.support.read", "im.support.accept", ...(scenario === "no-permission" ? [] : ["im.support.presence"])];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      let body;
      if (url.endsWith("/im/token")) {
        if (scenario === "disconnected") return new Response("{}", { status: 503 });
        body = { appKey: "synthetic", accountId: "admin-a", token: "synthetic", transport: "local-fake" };
      } else if (url.includes("/im/consultations")) body = { consultations: [] };
      else if (url.endsWith("/im/presence")) {
        if (init.method === "PUT") { const value = JSON.parse(init.body); writes.push(value); availability = value.availability; version++; }
        body = { adminUserId: "admin-a", availability, connectionState: "CONNECTED", activeLoad: 0, version };
      } else if (url.includes("/im/messages")) body = { messages: [] };
      else throw new Error(`unexpected request ${url}`);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const { rootNode } = await mount(t, { preview: false, snapshot: snapshot(permissions) });
    await settle();
    const button = rootNode.querySelector(".im-support-presence-toggle");
    assert.equal(writes.some(value => value.availability === "AVAILABLE"), false, "render never starts accepting automatically");
    if (scenario === "no-permission") { assert.equal(button, null); assert.equal(writes.length, 0); return; }
    assert.ok(button.closest('.im-support-root > nav'), "presence is outside either mutually hidden pane");
    assert.equal(rootNode.querySelectorAll('.im-support-queue-item').length, 0);
    assert.equal(button.disabled, scenario === "disconnected");
    if (scenario === "disconnected") { assert.equal(writes.length, 0); return; }
    for (const expected of ["AVAILABLE", "OFF_DUTY", "AVAILABLE"]) {
      await act(async () => button.click()); await settle();
      assert.equal(writes.at(-1).availability, expected);
      assert.equal(button.textContent, expected === "AVAILABLE" ? "暂停接待" : "开始接待");
    }
  });
}
