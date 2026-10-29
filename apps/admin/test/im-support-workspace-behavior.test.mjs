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
let fixture = { consultations: [], history: [], post: null };
let contextStatus = 200;
let contextSubject = { status: "absent" };
let profileGate = null;
let profileFixture = { user: { userId: "user-7", image: null, maskedPhone: "138****8000", phoneNumberVerified: true, maskedEmail: "z***@example.com", accountStatus: "ACTIVE", suspended: false, identity: { status: "VERIFIED", ageStatus: "ADULT", provider: "local-fixture", verifiedAt: null }, identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z", resourceSummary: { state: "ready", count: 2 }, orderSummary: { state: "denied", permission: "order.read" }, lastBusinessActivity: { state: "not_connected", domains: ["ORDER"] } } };
function json(body) { return new browser.Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); }
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), browser.location.href);
  requests.push(url.pathname);
  if (url.pathname.endsWith("/im/token")) return json({ appKey: "synthetic", accountId: "admin-a", token: "synthetic", transport: "local-fake" });
  if (url.pathname.endsWith("/im/consultations")) return json({ consultations: fixture.consultations });
  if (url.pathname.endsWith("/im/message-access")) return json({ authorized: true });
  if (url.pathname.endsWith("/context")) {
    if (contextStatus !== 200) return new browser.Response("{}", { status: contextStatus });
    return json({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-a", displayName: "测试用户甲", avatar: null }, subject: contextSubject, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  }
  if (url.pathname.includes("/users/")) { if (profileGate) await profileGate; return json(profileFixture); }
  if (url.pathname.endsWith("/im/presence")) return json({ adminUserId: "admin-a", availability: "OFF_DUTY", connectionState: "CONNECTED", activeLoad: 0, version: 1 });
  if (url.pathname.endsWith("/im/messages") && init.method === "POST") {
    const result = fixture.post ? fixture.post(JSON.parse(String(init.body))) : { message: {} };
    const isResponse = Boolean(result) && typeof result === "object" && typeof result.status === "number" && typeof result.json === "function";
    return isResponse ? result : json(result);
  }
  if (url.pathname.includes("/im/")) return json({ messages: fixture.history });
  throw new Error(`unexpected test request ${url.pathname}`);
};

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

async function waitFor(predicate, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
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

const activeConsultation = {
  id: "c-active", type: "SERVICE", state: "ACTIVE", subjectRef: null, version: 1,
  assignedAdmin: { id: "admin-a", name: "客服 A" }, peerAccountId: "user-a", conversationType: "TEAM",
  conversationId: "conv-a", messageScopeState: "READY",
  lastMessageAt: "2026-09-17T00:02:00.000Z", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:02:00.000Z",
  user: { id: "user-a", name: "用户 A", username: "user-a" },
};
const waitingConsultation = { ...activeConsultation, id: "c-waiting", state: "WAITING", assignedAdmin: null, conversationId: null, messageScopeState: undefined, lastMessageAt: null, user: { id: "user-b", name: "用户 B", username: "user-b" } };

test("chat header and queue follow the real selected consultation", async (t) => {
  fixture = { consultations: [activeConsultation, waitingConsultation], history: [], post: null };
  const { rootNode } = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept"]) });
  await waitFor(() => Boolean(rootNode.querySelector(".im-wb-row")));

  assert.ok(rootNode.querySelector(".im-wb-viewport"), "viewport renders inside the scroller");
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 1, "the default filter lists only my own sessions");
  assert.equal(rootNode.querySelector(".im-wb-chat-title h2").textContent, "用户 A · 平台咨询", "title comes from the selected consultation");
  assert.match(rootNode.querySelector(".im-wb-chat-title span").textContent, /当前接待：客服 A/);

  // The unassigned consultation must be reachable and must not invent an input.
  await act(async () => { [...rootNode.querySelectorAll(".im-wb-filters button")].find((b) => b.textContent.includes("待接待")).click(); });
  await settle();
  const rows = [...rootNode.querySelectorAll(".im-wb-row")];
  assert.equal(rows.length, 1, "the waiting filter shows only the unassigned consultation");
  assert.match(rows[0].textContent, /待接入/, "the unassigned consultation is labelled as waiting");
  await act(async () => { rows[0].click(); });
  await settle();
  assert.equal(rootNode.querySelector(".im-wb-chat-title h2").textContent, "用户 B · 平台咨询");
  assert.match(rootNode.querySelector(".im-wb-chat-title span").textContent, /等待客服接待/);
  assert.equal(rootNode.querySelector("textarea").disabled, true, "a waiting consultation cannot be replied to");
});

test("an empty conversation keeps its own identity instead of the unselected state", async (t) => {
  fixture = { consultations: [activeConsultation], history: [], post: null };
  const { rootNode } = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept"]) });
  await waitFor(() => Boolean(rootNode.querySelector(".im-wb-row")));
  await settle();
  assert.equal(rootNode.querySelector(".im-wb-chat-title h2").textContent, "用户 A · 平台咨询");
  const messageArea = rootNode.querySelector(".im-wb-stream-wrap");
  assert.match(messageArea.textContent, /等待第一条消息/);
  assert.doesNotMatch(messageArea.textContent, /尚未选择会话/);
});

test("messages keep real sender identity, notices stay neutral, and only own messages claim sent", async (t) => {
  fixture = {
    consultations: [activeConsultation],
    post: null,
    history: [
      { messageClientId: "n-1", messageServerId: "n-1", conversationId: "conv-a", senderId: "user-a", createTime: Date.parse("2026-09-17T00:01:00.000Z"), messageType: 5, attachment: { type: 0 } },
      { messageClientId: "m-1", messageServerId: "m-1", conversationId: "conv-a", senderId: "user-a", createTime: Date.parse("2026-09-17T00:02:00.000Z"), messageType: 0, text: "用户提问" },
      { messageClientId: "m-2", messageServerId: "m-2", conversationId: "conv-a", senderId: "admin-a", createTime: Date.parse("2026-09-17T00:03:00.000Z"), messageType: 0, text: "客服回复" },
      { messageClientId: "m-3", messageServerId: "m-3", conversationId: "conv-a", senderId: "admin-other", createTime: Date.parse("2026-09-17T00:04:00.000Z"), messageType: 0, text: "另一位客服" },
    ],
  };
  const { rootNode } = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept"]) });
  await waitFor(() => rootNode.querySelectorAll(".im-wb-msg").length === 3);

  const system = rootNode.querySelector(".im-wb-sys");
  assert.ok(system, "a TEAM_INVITE notification renders as a system line, not a bubble");
  assert.equal(system.textContent, "成员已加入会话");
  assert.equal(rootNode.querySelectorAll('.im-wb-msg[data-from="system"]').length, 0, "a notice is never attributed to a speaker");
  assert.doesNotMatch(rootNode.textContent, /暂不支持展示的消息类型/, "known notice types are decoded instead of dumped");

  const own = rootNode.querySelector('.im-wb-msg[data-self="true"]');
  const peer = rootNode.querySelector('.im-wb-msg[data-from="customer"]');
  assert.match(own.textContent, /已发送/, "own message states it was sent");
  assert.doesNotMatch(peer.textContent, /已发送/, "peer message never claims a send state");
  assert.doesNotMatch(rootNode.textContent, /已读/, "no read receipt is claimed without a source");
  assert.equal(peer.querySelector(".im-wb-msg-meta b").textContent, "用户 A");
  assert.equal(own.querySelector(".im-wb-msg-meta b").textContent, "客服 A");
  // A historical staff message from someone else must not borrow the current assignee's name.
  const other = [...rootNode.querySelectorAll('.im-wb-msg[data-from="agent"]')].find((item) => item !== own);
  assert.equal(other.querySelector(".im-wb-msg-meta b").textContent, "客服");
});

test("queue/chat switching moves focus onto the visible pane control", async (t) => {
  fixture = { consultations: [activeConsultation], history: [], post: null };
  const { rootNode } = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept", "im.support.transfer", "im.support.presence"]) });
  await waitFor(() => Boolean(rootNode.querySelector(".im-wb-row")));

  const firstItem = rootNode.querySelector(".im-wb-row");
  assert.ok(firstItem, "queue renders real consultations");
  await act(async () => { firstItem.click(); });
  await settle();
  const activeInChat = browser.document.activeElement;
  assert.equal(activeInChat.getAttribute("data-focus-target"), "chat", `chat switch focuses the chat heading, got ${activeInChat.tagName}`);
  assert.equal(activeInChat, rootNode.querySelector(".im-wb-chat-head"));
  assert.notEqual(activeInChat, browser.document.body, "focus never falls back to body");

  await act(async () => { rootNode.querySelector('[data-action="back-to-queue"]').click(); });
  await settle();
  const activeInQueue = browser.document.activeElement;
  assert.ok(activeInQueue.classList.contains("im-wb-row"), `queue switch focuses a queue row, got ${activeInQueue.tagName}`);
  assert.equal(activeInQueue.getAttribute("data-active"), "true", "the selected queue row receives focus");
  assert.equal(rootNode.querySelector(".im-wb-queue").contains(activeInQueue), true);
});

test("closing the case column on a narrow screen returns to the conversation and restores focus", async (t) => {
  const originalMatchMedia = browser.matchMedia;
  browser.matchMedia = (query) => ({ matches: String(query).includes("760"), media: String(query), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  t.after(() => { browser.matchMedia = originalMatchMedia; });
  fixture = { consultations: [activeConsultation], history: [], post: null };
  const { rootNode } = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept"]) });
  await waitFor(() => Boolean(rootNode.querySelector(".im-wb-row")));
  const grid = () => rootNode.querySelector(".im-wb");

  await act(async () => { rootNode.querySelector(".im-wb-row").click(); });
  await settle();
  assert.equal(grid().dataset.pane, "chat", "a narrow screen shows one pane at a time");

  await act(async () => { rootNode.querySelector('[data-action="toggle-details"]').click(); });
  await settle();
  assert.equal(grid().dataset.pane, "details");
  assert.equal(rootNode.querySelector(".im-wb-details").hidden, false);

  // 详情是独立面板：收起后必须回到会话，而不是三个面板同时隐藏留下空屏。
  await act(async () => { rootNode.querySelector('[data-action="back-to-chat"]').click(); });
  await settle();
  assert.equal(grid().dataset.details, "false");
  assert.equal(rootNode.querySelector(".im-wb-details").hidden, true);
  assert.equal(grid().dataset.pane, "chat", "closing details returns to the conversation, not an empty screen");
  assert.notEqual(browser.document.activeElement, browser.document.body, "focus never falls back to body");
  assert.equal(browser.document.activeElement.getAttribute("data-focus-target"), "chat", "focus lands on the visible chat pane");
});

test("timeline calendar labels preserve January and December", () => {  const source = readFileSync(path.join(adminRoot, "src/views/im-support-format.ts"), "utf8");
  const helpers = source.slice(source.indexOf("const DISPLAY_TIME_ZONE"), source.indexOf("export function initialOf")).replaceAll("export function", "function");
  const { dayKeyOf, dayLabelOf, formatDateTime, formatTime } = new Function(stripTypeScriptTypes(helpers) + ";return { dayKeyOf, dayLabelOf, formatDateTime, formatTime };")();
  assert.equal(dayKeyOf(undefined), null);
  assert.equal(dayKeyOf(NaN), null);
  for (const [month, expected] of [[0, "1月15日"], [11, "12月15日"]]) {
    assert.equal(dayLabelOf(dayKeyOf(new Date(2020, month, 15, 12).getTime())), expected);
  }
  assert.equal(dayLabelOf(dayKeyOf(Date.now())), "今天");
  assert.equal(dayKeyOf(Date.parse("2026-01-01T16:30:00.000Z")), "2026-0-2", "day grouping follows Beijing time, not the browser host timezone");
  assert.equal(formatTime("2026-01-01T16:30:00.000Z"), "00:30");
  assert.match(formatDateTime("2026-01-01T16:30:00.000Z"), /1(?:月|\/)2.*00:30/);
  assert.equal(dayLabelOf("not-a-day"), "日期暂不可用");
});

test("the case column is a real grid column that reports its own collapsed state", async (t) => {
  fixture = { consultations: [activeConsultation], history: [], post: null };
  const { rootNode } = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept"]) });
  await waitFor(() => Boolean(rootNode.querySelector(".im-wb-row")));
  const trigger = rootNode.querySelector('[data-action="toggle-details"]');
  const panel = rootNode.querySelector(".im-wb-details");
  // The case column is permanent on desktop: it starts open and never squeezes the chat
  // into a hidden or unusable track.
  assert.equal(trigger.getAttribute("aria-expanded"), "true", "open by default at this width");
  assert.equal(trigger.getAttribute("aria-controls"), "im-wb-details", "the toggle names the panel it controls");
  assert.equal(panel.id, "im-wb-details", "the panel is the announced target");
  assert.equal(panel.hidden, false, "the case column is visible, not collapsed");
  assert.equal(rootNode.querySelector(".im-wb").dataset.details, "true");
  assert.ok(rootNode.querySelector(".im-wb-send"), "the composer stays reachable either way");
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
    const button = rootNode.querySelector(".im-wb-presence-toggle");
    assert.equal(writes.some(value => value.availability === "AVAILABLE"), false, "render never starts accepting automatically");
    if (scenario === "no-permission") { assert.equal(button, null); assert.equal(writes.length, 0); return; }
    assert.ok(button.closest('.im-wb-root > nav'), "presence is outside either mutually hidden pane");
    assert.equal(rootNode.querySelectorAll('.im-wb-row').length, 0);
    assert.equal(button.disabled, scenario === "disconnected");
    if (scenario === "disconnected") { assert.equal(writes.length, 0); return; }
    for (const expected of ["AVAILABLE", "OFF_DUTY", "AVAILABLE"]) {
      await act(async () => button.click()); await settle();
      assert.equal(writes.at(-1).availability, expected);
      assert.equal(button.textContent, expected === "AVAILABLE" ? "暂停接待" : "开始接待");
    }
    const written = writes.length;
    await settle();
    assert.equal(writes.length, written, "a successful toggle is not followed by an automatic rewrite");
  });
}

// 状态写入的失败注入装置：初始 GET/PUT 走真实成功路径，用户点击后的那一次写入按场景失败。
async function mountPresenceHarness(t, { refreshedAvailability = "PAUSED" } = {}) {
  const originalFetch = globalThis.fetch;
  let availability = "OFF_DUTY";
  let version = 1;
  let failNext = null;
  let conflictPending = false;
  const writes = [];
  const reads = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/im/token")) return json({ appKey: "synthetic", accountId: "admin-a", token: "synthetic", transport: "local-fake" });
    if (url.includes("/im/consultations")) return json({ consultations: [] });
    if (url.endsWith("/im/presence")) {
      if (init.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        if (failNext === "conflict") {
          failNext = null;
          conflictPending = true;
          return new browser.Response(JSON.stringify({ error: { code: "CONFLICT" } }), { status: 409, headers: { "content-type": "application/json" } });
        }
        if (failNext === "server") {
          failNext = null;
          return new browser.Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), { status: 500, headers: { "content-type": "application/json" } });
        }
        availability = body.availability;
        version += 1;
        return json({ adminUserId: "admin-a", availability, connectionState: "CONNECTED", activeLoad: 0, version });
      }
      reads.push(true);
      if (conflictPending) { conflictPending = false; availability = refreshedAvailability; version = 9; }
      return json({ adminUserId: "admin-a", availability, connectionState: "CONNECTED", activeLoad: 0, version });
    }
    if (url.includes("/im/messages")) return json({ messages: [] });
    throw new Error(`unexpected test request ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { rootNode } = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept", "im.support.presence"]) });
  // 等到初始 GET + PUT 都完成且按钮可用，再注入用户点击的那一次失败。
  await waitFor(() => Boolean(rootNode.querySelector(".im-wb-presence-toggle")) && !rootNode.querySelector(".im-wb-presence-toggle").disabled && writes.length >= 1);
  await settle();
  const button = () => rootNode.querySelector(".im-wb-presence-toggle");
  const stateLabel = () => rootNode.querySelector(".im-wb-bar .im-wb-state");
  const noticeText = () => rootNode.querySelector(".im-wb-notice[role='status']")?.textContent ?? "";
  return { rootNode, writes, reads, button, stateLabel, noticeText, arm: (mode) => { failNext = mode; } };
}

test("a presence version conflict re-reads the server, never resends, and shows a neutral notice", async (t) => {
  const harness = await mountPresenceHarness(t);
  assert.equal(harness.button().textContent, "开始接待");
  assert.match(harness.stateLabel().textContent, /未上线/);
  const writesBefore = harness.writes.length;
  const readsBefore = harness.reads.length;

  harness.arm("conflict");
  await act(async () => harness.button().click());
  await settle();

  assert.equal(harness.writes.length, writesBefore + 1, "the conflicting write is not retried");
  assert.equal(harness.reads.length, readsBefore + 1, "the conflict reads the authoritative presence instead");
  assert.match(harness.noticeText(), /另一窗口已更新接待状态，已刷新为最新状态。/, "the conflict is explained, not hidden");
  // 服务端刷新值是第三种状态：显示只能来自 GET，而不是这次点击的意图。
  assert.match(harness.stateLabel().textContent, /已暂停/);
  assert.equal(harness.button().textContent, "开始接待");
  assert.doesNotMatch(harness.rootNode.querySelector(".im-wb-bar").textContent, /接待中/);

  // 冲突刷新同时更新了本地版本：下一次显式切换必须带上服务端返回的 version。
  await act(async () => harness.button().click());
  await settle();
  assert.equal(harness.writes.at(-1).version, 9, "the refreshed version is used by the next explicit write");
  assert.equal(harness.writes.at(-1).availability, "AVAILABLE");
  assert.equal(harness.button().textContent, "暂停接待", "an explicit retry after the refresh can still succeed");
});

test("a failed presence write stays visibly unsaved instead of showing the attempted state", async (t) => {
  const harness = await mountPresenceHarness(t);
  const writesBefore = harness.writes.length;
  const readsBefore = harness.reads.length;

  harness.arm("server");
  await act(async () => harness.button().click());
  await settle();

  assert.equal(harness.writes.length, writesBefore + 1, "only the explicit write is attempted");
  assert.equal(harness.reads.length, readsBefore, "a plain failure does not re-read the server");
  assert.match(harness.noticeText(), /接待状态未保存，请重试/);
  assert.match(harness.stateLabel().textContent, /未上线/, "the last server-confirmed state stays on screen");
  assert.equal(harness.button().textContent, "开始接待", "the attempted AVAILABLE state is never shown as applied");
  assert.doesNotMatch(harness.rootNode.querySelector(".im-wb-bar").textContent, /接待中/);

  await settle();
  assert.equal(harness.writes.length, writesBefore + 1, "no automatic retry follows a failed write");
  assert.equal(harness.button().disabled, false, "the operator can deliberately retry");
});

test("the case column reads the account profile only through its own permission", async (t) => {
  fixture = { consultations: [activeConsultation], history: [], post: null };
  profileFixture = { user: { userId: "user-a", image: null, maskedPhone: "138****8000", phoneNumberVerified: false, maskedEmail: null, accountStatus: "ACTIVE", suspended: false, identity: { status: "VERIFIED", ageStatus: "ADULT", provider: "local-fixture", verifiedAt: null }, identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "MIGRATED" }, registeredAt: "2026-01-05T00:00:00.000Z", resourceSummary: { state: "ready", count: 2 }, orderSummary: { state: "denied", permission: "order.read" }, lastBusinessActivity: { state: "not_connected", domains: ["ORDER"] } } };
  const granted = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept", "user.directory.read"]) });
  await waitFor(() => /账号正常/.test(granted.rootNode.textContent));
  const aside = granted.rootNode.querySelector(".im-wb-details");
  assert.match(aside.textContent, /测试用户甲/, "the display name comes from the consultation context, not the list row");
  assert.match(aside.textContent, /user-a/, "the stable user id is shown for addressing");
  assert.match(aside.textContent, /已实名/);
  assert.match(aside.textContent, /138.{4}8000 · 未验证/, "the phone arrives pre-masked with its own verification state");
  assert.match(aside.textContent, /邮箱未绑定/, "an absent email says absent instead of disappearing");
  assert.match(aside.textContent, /进行中订单需「订单读取」权限/, "a denied summary is a permission fact, never a count of zero");
  assert.match(aside.textContent, /名下资源账号需「资源账号读取」权限/, "each summary names the capability it actually needs");
  await act(async () => aside.querySelector('[aria-label="查看进行中订单读取权限"]').click());
  await waitFor(() => document.querySelector('[data-slot="popover-content"]')?.textContent.includes("order.read"));
  await act(async () => document.querySelector('[data-slot="popover-content"]').dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.match(aside.textContent, /138\*\*\*\*8000/, "the phone arrives pre-masked from the server");
  assert.match(aside.textContent, /旧平台迁移/);
  assert.ok([...aside.querySelectorAll("button")].some((b) => b.textContent.includes("完整资料")), "a permitted operator can open the full profile");

  // Without user.directory.read the profile must be absent, not filled with guesses.
  const limited = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept"]) });
  await waitFor(() => /关联对象/.test(limited.rootNode.textContent));
  assert.doesNotMatch(limited.rootNode.querySelector(".im-wb-details").textContent, /账号正常|已实名|138\*\*\*\*8000|完整资料/, "no profile is invented without the permission");
  assert.match(limited.rootNode.querySelector(".im-wb-details").textContent, /需用户目录读取权限/, "the missing permission is named instead of the block silently vanishing");
  assert.match(limited.rootNode.querySelector(".im-wb-details").textContent, /测试用户甲/, "the conversation itself stays usable");

  // UNKNOWN never collapses into a friendlier default.
  profileFixture = { user: { userId: "user-a", image: null, maskedPhone: null, phoneNumberVerified: false, maskedEmail: null, accountStatus: "UNKNOWN", suspended: false, identity: { status: "UNKNOWN", ageStatus: "UNKNOWN", provider: null, verifiedAt: null }, identityStatus: "UNKNOWN", ageStatus: "UNKNOWN", source: { kind: "UNKNOWN" }, registeredAt: null, resourceSummary: { state: "denied", permission: "supply.rental_account.read" }, orderSummary: { state: "denied", permission: "order.read" }, lastBusinessActivity: { state: "not_connected", domains: ["ORDER"] } } };
  const unknown = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept", "user.directory.read"]) });
  await waitFor(() => /账号状态未知/.test(unknown.rootNode.textContent));
  const rail = unknown.rootNode.querySelector(".im-wb-details");
  assert.match(rail.textContent, /实名状态未知/);
  assert.match(rail.textContent, /年龄状态未知/);
  assert.doesNotMatch(rail.textContent, /未实名|普通用户|成人|未成年/, "unknown is not downgraded to a conclusion");
  profileFixture = { user: { userId: "user-7", image: null, maskedPhone: "138****8000", phoneNumberVerified: true, maskedEmail: "z***@example.com", accountStatus: "ACTIVE", suspended: false, identity: { status: "VERIFIED", ageStatus: "ADULT", provider: "local-fixture", verifiedAt: null }, identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z", resourceSummary: { state: "ready", count: 2 }, orderSummary: { state: "denied", permission: "order.read" }, lastBusinessActivity: { state: "not_connected", domains: ["ORDER"] } } };
});

test("a failed context read keeps the base identity and marks the subject unavailable", async (t) => {
  contextStatus = 404;
  contextSubject = { status: "absent" };
  t.after(() => { contextStatus = 200; contextSubject = { status: "absent" }; });
  fixture = { consultations: [activeConsultation], history: [], post: null };
  const { rootNode } = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept"]) });
  await waitFor(() => /关联对象暂时不可读取/.test(rootNode.textContent));
  const details = rootNode.querySelector(".im-wb-details");
  assert.match(details.textContent, /user-a/, "the list-projected user id remains available when context is unavailable");
  assert.match(details.textContent, /关联对象暂时不可读取/);
  assert.doesNotMatch(details.textContent, /尚未关联商品或订单/, "a failed context read is not turned into an absent subject");
});

test("an unknown subject status fails closed instead of exposing a bare reference", async (t) => {
  contextStatus = 200;
  contextSubject = { status: "future_type", reference: "order-secret" };
  t.after(() => { contextStatus = 200; contextSubject = { status: "absent" }; });
  fixture = { consultations: [activeConsultation], history: [], post: null };
  const { rootNode } = await mount(t, { snapshot: snapshot(["im.support.read", "im.support.accept"]) });
  await waitFor(() => /关联对象类型暂未确认/.test(rootNode.textContent));
  assert.doesNotMatch(rootNode.querySelector(".im-wb-details").textContent, /order-secret/);
});

const FULL_PROFILE = { user: { userId: "user-a", image: "https://cdn.example/avatar-a.png", maskedPhone: "138****8000", phoneNumberVerified: true, maskedEmail: "a***@example.com", accountStatus: "ACTIVE", suspended: false, identity: { status: "VERIFIED", ageStatus: "ADULT", provider: "local-fixture", verifiedAt: null }, identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "MIGRATED" }, registeredAt: "2026-01-05T00:00:00.000Z", resourceSummary: { state: "ready", count: 4 }, orderSummary: { state: "ready", currentCount: 18 }, lastBusinessActivity: { state: "not_connected", domains: ["ORDER"] } } };
const IM_BASE = ["im.support.read", "im.support.accept"];

async function rerender(root, permissions) {
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot([]) })); });
  await settle();
}

test("revoking a read capability invalidates the profile facts it produced", async (t) => {
  fixture = { consultations: [activeConsultation], history: [], post: null };
  profileFixture = FULL_PROFILE;
  const { rootNode, root } = await mount(t, { snapshot: snapshot([...IM_BASE, "user.directory.read", "order.read", "supply.rental_account.read"]) });
  await waitFor(() => /进行中订单18 单/.test(rootNode.textContent));
  assert.match(rootNode.textContent, /名下资源账号4 个/, "the label names ownership, not an active rental");
  assert.match(rootNode.textContent, /旧平台迁移/);
  assert.ok(rootNode.querySelector(".im-wb-avatar img"), "the profile avatar is shown while the read is held");

  // Same identity, same session, same im.support.read: only the two summary reads go away.
  await rerender(root, [...IM_BASE, "user.directory.read"]);
  await waitFor(() => /需「订单读取」权限/.test(rootNode.textContent));
  assert.doesNotMatch(rootNode.textContent, /18 单|4 个/, "counts produced by a revoked read cannot stay on screen");
  assert.match(rootNode.textContent, /已实名/, "the profile itself is still readable, so its own facts stay");

  // Revoking the profile read must clear every fact it produced, including 来源 and the avatar.
  await rerender(root, IM_BASE);
  await waitFor(() => /需用户目录读取权限/.test(rootNode.textContent));
  const aside = rootNode.querySelector(".im-wb-details");
  assert.doesNotMatch(aside.textContent, /旧平台迁移|已实名|138\*\*\*\*8000|18 单|4 个/, "no profile fact survives its permission");
  assert.equal(aside.querySelector(".im-wb-avatar img"), null, "the profile avatar is not kept after the read is revoked");
  assert.match(aside.textContent, /测试用户甲/, "the conversation identity from the context stays usable");

  // Restoring the permission re-reads instead of resurrecting the old snapshot.
  await rerender(root, [...IM_BASE, "user.directory.read", "order.read", "supply.rental_account.read"]);
  await waitFor(() => /进行中订单18 单/.test(rootNode.textContent));
  assert.match(rootNode.textContent, /旧平台迁移/);
});

test("a profile response that lands after its capability is gone never refills the card", async (t) => {
  fixture = { consultations: [activeConsultation], history: [], post: null };
  profileFixture = FULL_PROFILE;
  let release;
  profileGate = new Promise((resolve) => { release = resolve; });
  const { rootNode, root } = await mount(t, { snapshot: snapshot([...IM_BASE, "user.directory.read", "order.read", "supply.rental_account.read"]) });
  await waitFor(() => /正在读取账号资料/.test(rootNode.textContent));

  await rerender(root, IM_BASE);
  await waitFor(() => /需用户目录读取权限/.test(rootNode.textContent));
  profileGate = null;
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 40)); });
  const aside = rootNode.querySelector(".im-wb-details");
  assert.doesNotMatch(aside.textContent, /18 单|4 个|已实名|旧平台迁移/, "a late response for a revoked capability is dropped, not painted");
  assert.equal(aside.querySelector(".im-wb-avatar img"), null, "the late avatar cannot come back either");
});

test("a failed profile read can be retried without restarting the IM client", async (t) => {
  fixture = { consultations: [activeConsultation], history: [], post: null };
  profileFixture = FULL_PROFILE;
  const originalFetch = globalThis.fetch;
  let profileReads = 0;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), browser.location.href).pathname;
    calls.push({ path, method: init.method ?? "GET" });
    if (path.includes("/users/") && ++profileReads === 1) return new Response(JSON.stringify({ error: { code: "SYNTHETIC_UNAVAILABLE" } }), { status: 503, headers: { "content-type": "application/json" } });
    return originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { rootNode } = await mount(t, { snapshot: snapshot([...IM_BASE, "user.directory.read", "order.read", "supply.rental_account.read"]) });
  await waitFor(() => [...rootNode.querySelectorAll("button")].some(button => button.textContent.includes("重读资料")));
  const tokenReads = calls.filter(call => call.path.endsWith("/im/token")).length;
  const mark = calls.length;
  await act(async () => [...rootNode.querySelectorAll("button")].find(button => button.textContent.includes("重读资料")).click());
  await waitFor(() => /账号正常/.test(rootNode.textContent));
  assert.equal(profileReads, 2, "retry performs a fresh profile read");
  assert.equal(calls.filter(call => call.path.endsWith("/im/token")).length, tokenReads, "the NIM identity is not restarted for profile retry");
  assert.equal(calls.slice(mark).every(call => call.method === "GET"), true, "retry only reads");
});

test("profile copying gives visible success and failure feedback", async (t) => {
  fixture = { consultations: [activeConsultation], history: [], post: null };
  profileFixture = FULL_PROFILE;
  const previous = Object.getOwnPropertyDescriptor(browser.navigator, "clipboard");
  let fail = false;
  Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: { writeText: async () => { if (fail) throw new Error("Synthetic clipboard denied"); } } });
  t.after(() => { if (previous) Object.defineProperty(browser.navigator, "clipboard", previous); else delete browser.navigator.clipboard; });
  const { rootNode } = await mount(t, { snapshot: snapshot([...IM_BASE, "user.directory.read"]) });
  await waitFor(() => rootNode.querySelector('[aria-label="复制用户ID"]'));
  await act(async () => rootNode.querySelector('[aria-label="复制用户ID"]').click());
  await waitFor(() => /已复制用户ID/.test(rootNode.querySelector(".im-rail-copy-status")?.textContent ?? ""));
  assert.equal(rootNode.querySelector(".im-rail-copy-status").classList.contains("sr-only"), false, "copy feedback is visible as well as announced");
  fail = true;
  await act(async () => rootNode.querySelector('[aria-label="复制用户ID"]').click());
  await waitFor(() => /复制失败/.test(rootNode.querySelector(".im-rail-copy-status")?.textContent ?? ""));
});

test("missing profile summaries remain unavailable rather than zero or a false permission denial", async (t) => {
  fixture = { consultations: [activeConsultation], history: [], post: null };
  profileFixture = { user: { ...FULL_PROFILE.user, orderSummary: { state: "ready" }, resourceSummary: undefined } };
  const { rootNode } = await mount(t, { snapshot: snapshot([...IM_BASE, "user.directory.read", "order.read", "supply.rental_account.read"]) });
  await waitFor(() => /账号正常/.test(rootNode.textContent));
  assert.match(rootNode.textContent, /进行中订单暂无数据/);
  assert.match(rootNode.textContent, /名下资源账号暂未提供/);
  assert.doesNotMatch(rootNode.querySelector(".im-wb-details").textContent, /0 单|0 个|需「订单读取」权限|需「资源账号读取」权限/);
  profileFixture = FULL_PROFILE;
});

/* ---------- consultation message menu ---------- */

const menuHistory = () => [
  { messageClientId: "peer-text", messageServerId: "srv-peer", conversationId: "conv-a", senderId: "user-a", receiverId: "admin-a", createTime: Date.parse("2026-09-17T00:01:00.000Z"), messageType: 0, text: "用户提问" },
  { messageClientId: "own-text", messageServerId: "srv-own", conversationId: "conv-a", senderId: "admin-a", receiverId: "user-a", createTime: Date.parse("2026-09-17T00:02:00.000Z"), messageType: 0, text: "我方原文" },
  { messageClientId: "peer-image", messageServerId: "srv-image", conversationId: "conv-a", senderId: "user-a", receiverId: "admin-a", createTime: Date.parse("2026-09-17T00:03:00.000Z"), messageType: 1, attachment: { imageId: "image-1", url: "/api/im/images/menu-peer", name: "图片", mimeType: "image/png", size: 1024 } },
  { messageClientId: "sys-invite", messageServerId: "srv-system", conversationId: "conv-a", senderId: "system", receiverId: "admin-a", createTime: Date.parse("2026-09-17T00:04:00.000Z"), messageType: 5, attachment: { type: 0 } },
  { messageClientId: "revoked-own", messageServerId: "srv-revoked", conversationId: "conv-a", senderId: "admin-a", receiverId: "user-a", createTime: Date.parse("2026-09-17T00:05:00.000Z"), messageType: 0, text: "", revoked: true },
];

async function mountMenu(t, options = {}) {
  fixture = { consultations: [activeConsultation], history: options.history ?? menuHistory(), post: options.post ?? null };
  return mount(t, { snapshot: snapshot(options.permissions ?? ["im.support.read", "im.support.accept"]) });
}

async function waitForMenuHistory(rootNode) {
  await waitFor(() => rootNode.querySelectorAll(".im-wb-msg").length === 4 && rootNode.querySelector(".im-wb-sys"));
}

const menuLabels = () => [...document.querySelectorAll('.message-action-menu [role="menuitem"]')].map((button) => button.textContent.trim());

async function openMenu(rootNode, id, point = { clientX: 120, clientY: 90 }) {
  const row = rootNode.querySelector(`[data-message-id="${id}"]`);
  assert.ok(row, `message row ${id} exists`);
  await act(async () => { row.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...point })); });
  await settle();
  return row;
}

async function pickMenu(label) {
  const button = [...document.querySelectorAll('.message-action-menu [role="menuitem"]')].find((item) => item.textContent.trim() === label);
  assert.ok(button, `menu item ${label} exists`);
  await act(async () => button.click());
  await settle();
}

async function typeDraft(rootNode, text) {
  await act(async () => {
    const element = rootNode.querySelector("textarea");
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
    setValue.call(element, text);
    element.dispatchEvent(new browser.Event("input", { bubbles: true }));
    element.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  await settle();
}

async function submitComposer(rootNode) {
  await act(async () => {
    rootNode.querySelector("form.im-wb-composer").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await settle();
}

function stubClipboard(t) {
  const previous = Object.getOwnPropertyDescriptor(browser.navigator, "clipboard");
  let copied = null;
  Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied = text; } } });
  t.after(() => { if (previous) Object.defineProperty(browser.navigator, "clipboard", previous); else delete browser.navigator.clipboard; });
  return () => copied;
}

test("consultation message menu follows message type, send capability and keyboard rules", async (t) => {
  const { rootNode } = await mountMenu(t);
  await waitForMenuHistory(rootNode);
  await waitFor(() => !rootNode.querySelector("textarea").disabled);

  const own = await openMenu(rootNode, "srv-own");
  assert.deepEqual(menuLabels(), ["复制", "回复", "撤回", "删除"], "own text offers every action");
  const menu = document.querySelector(".message-action-menu");
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(document.activeElement?.getAttribute("role"), "menuitem", "focus enters the first item");
  assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 4);
  await act(async () => { document.activeElement.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();
  assert.equal(document.querySelector(".message-action-menu"), null, "Escape closes the menu");
  assert.equal(document.activeElement, own, "Escape returns focus to the message row");

  await openMenu(rootNode, "srv-peer");
  assert.deepEqual(menuLabels(), ["复制", "回复", "删除"], "another account's message cannot be revoked");
  await act(async () => { browser.document.body.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true })); });
  await settle();
  assert.equal(document.querySelector(".message-action-menu"), null, "an outside press closes the menu");

  await openMenu(rootNode, "srv-image");
  assert.deepEqual(menuLabels(), ["回复", "删除"], "images cannot be copied");
  await act(async () => { document.activeElement.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();

  const systemEvent = new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  await act(async () => { rootNode.querySelector('[data-message-id="srv-system"]').dispatchEvent(systemEvent); });
  await settle();
  assert.equal(systemEvent.defaultPrevented, true, "a message row never falls back to the browser menu");
  assert.equal(document.querySelector(".message-action-menu"), null, "system notices have no menu");

  const revokedEvent = new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  await act(async () => { rootNode.querySelector('[data-message-id="srv-revoked"]').dispatchEvent(revokedEvent); });
  await settle();
  assert.equal(revokedEvent.defaultPrevented, true);
  assert.equal(document.querySelector(".message-action-menu"), null, "revoked messages have no menu");
  assert.match(rootNode.querySelector('[data-message-id="srv-revoked"]').textContent, /消息已撤回/);
  assert.doesNotMatch(rootNode.querySelector('[data-message-id="srv-revoked"]').textContent, /已发送/, "a revoked message claims no send state");

  await openMenu(rootNode, "srv-own", { clientX: 5000, clientY: 5000 });
  const clamped = document.querySelector(".message-action-menu");
  assert.ok(parseFloat(clamped.style.left) <= browser.innerWidth - 8, "menu is clamped inside the viewport horizontally");
  assert.ok(parseFloat(clamped.style.top) <= browser.innerHeight - 8, "menu is clamped inside the viewport vertically");
  await act(async () => { document.activeElement.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();

  const ownRow = rootNode.querySelector('[data-message-id="srv-own"]');
  await act(async () => {
    ownRow.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 200, clientY: 150 }));
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  await settle();
  assert.deepEqual(menuLabels(), ["复制", "回复", "撤回", "删除"], "long press opens the same menu");
  await act(async () => { document.activeElement.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();

  const readOnly = await mountMenu(t, { permissions: ["im.support.read"] });
  await waitForMenuHistory(readOnly.rootNode);
  assert.equal(readOnly.rootNode.querySelector("textarea").disabled, true, "read-only consultations cannot write");
  await openMenu(readOnly.rootNode, "srv-own");
  assert.deepEqual(menuLabels(), ["复制", "删除"], "without send capability reply and revoke are absent");
  await act(async () => { document.activeElement.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();
});

test("copy writes only the original text", async (t) => {
  const copied = stubClipboard(t);
  const { rootNode } = await mountMenu(t);
  await waitForMenuHistory(rootNode);

  await openMenu(rootNode, "srv-own");
  await pickMenu("复制");
  assert.equal(copied(), "我方原文");
  assert.equal(document.querySelector(".message-action-menu"), null, "copy closes the menu");

  await openMenu(rootNode, "srv-image");
  assert.equal(menuLabels().includes("复制"), false, "an image has no copy entry");
});

test("reply sends replyText with a quote above the composer and clears it after success", async (t) => {
  let replyBody = null;
  const { rootNode } = await mountMenu(t, {
    post: (body) => {
      if (body.action !== "reply") throw new Error(`unexpected action ${body.action}`);
      replyBody = body;
      return { message: { messageClientId: "reply-1", messageServerId: "reply-1", conversationId: "conv-a", senderId: "admin-a", receiverId: "user-a", createTime: Date.parse("2026-09-17T00:06:00.000Z"), messageType: 0, text: body.text, reply: { messageId: "srv-peer", senderId: "user-a", text: "用户提问" } } };
    },
  });
  await waitForMenuHistory(rootNode);
  await waitFor(() => !rootNode.querySelector("textarea").disabled);

  await openMenu(rootNode, "srv-image");
  await pickMenu("回复");
  assert.match(rootNode.querySelector(".message-reply-quote").textContent, /回复：\[图片\]/, "an image quote uses the [图片] summary");
  await act(async () => rootNode.querySelector(".message-reply-quote button").click());
  await settle();
  assert.equal(rootNode.querySelector(".message-reply-quote"), null, "cancelling clears the quote");

  await openMenu(rootNode, "srv-peer");
  await pickMenu("回复");
  const quote = rootNode.querySelector(".message-reply-quote");
  assert.match(quote.textContent, /回复：用户提问/);
  assert.equal(quote.nextElementSibling, rootNode.querySelector("form.im-wb-composer"), "the quote sits directly above the composer");

  await typeDraft(rootNode, "收到");
  await submitComposer(rootNode);
  await waitFor(() => replyBody?.text === "收到");
  assert.equal(replyBody.action, "reply");
  assert.equal(replyBody.conversationId, "conv-a");
  assert.deepEqual(replyBody.replyTo, { messageServerId: "srv-peer", messageClientId: "peer-text" }, "replyText addresses the original message");
  await waitFor(() => rootNode.querySelector(".message-reply-quote") === null);
  assert.equal(rootNode.querySelector("textarea").value, "", "a confirmed reply clears the draft");
  const replyBubble = [...rootNode.querySelectorAll(".im-wb-bub")].find((element) => element.textContent.includes("收到"));
  assert.ok(replyBubble, "the reply receipt is merged into the timeline");
  assert.match(replyBubble.querySelector(".message-quoted").textContent, /引用.*用户提问/, "the sent reply shows its quote on the admin side");
});

test("an unknown reply keeps the draft and quote and is never re-sent under a new id", async (t) => {
  let replyCalls = 0;
  let plainCalls = 0;
  const { rootNode } = await mountMenu(t, {
    post: (body) => {
      if (body.action === "reply") { replyCalls += 1; return new browser.Response("{}", { status: 500 }); }
      if (!body.action) {
        plainCalls += 1;
        return { message: { messageClientId: `plain-${plainCalls}`, messageServerId: `plain-${plainCalls}`, conversationId: "conv-a", senderId: "admin-a", receiverId: "user-a", createTime: Date.parse("2026-09-17T00:07:00.000Z"), messageType: 0, text: body.text } };
      }
      throw new Error(`unexpected action ${body.action}`);
    },
  });
  await waitForMenuHistory(rootNode);
  await waitFor(() => !rootNode.querySelector("textarea").disabled);

  await openMenu(rootNode, "srv-peer");
  await pickMenu("回复");
  await typeDraft(rootNode, "回复内容");
  await submitComposer(rootNode);
  await waitFor(() => replyCalls === 1);
  await waitFor(() => /回复结果未确认，请刷新确认后再发送/.test(rootNode.querySelector(".im-wb-notice")?.textContent ?? ""));
  assert.equal(rootNode.querySelector("textarea").value, "回复内容", "the reply draft survives an unknown result");
  assert.match(rootNode.querySelector(".message-reply-quote").textContent, /回复：用户提问/, "the quote survives an unknown result");

  await submitComposer(rootNode);
  assert.equal(replyCalls, 1, "a quoted submit cannot repeat an unconfirmed reply");
  assert.equal(plainCalls, 0, "an unconfirmed reply never degrades into a new plain message");

  await act(async () => rootNode.querySelector(".message-reply-quote button").click());
  await settle();
  assert.equal(rootNode.querySelector(".message-reply-quote"), null);
  await submitComposer(rootNode);
  await waitFor(() => plainCalls === 1);
  assert.equal(replyCalls, 1, "cancelling the quote does not replay the reply");
  assert.equal(rootNode.querySelector("textarea").value, "");
});

test("revoke asks for a second confirmation, replaces the content and maps 409/403", async (t) => {
  let revokeCalls = 0;
  const { rootNode } = await mountMenu(t, {
    post: (body) => {
      if (body.action !== "revoke") throw new Error(`unexpected action ${body.action}`);
      revokeCalls += 1;
      return { message: { messageClientId: "own-text", messageServerId: "srv-own", conversationId: "conv-a", senderId: "admin-a", receiverId: "user-a", createTime: Date.parse("2026-09-17T00:02:00.000Z"), messageType: 0, text: "", revoked: true } };
    },
  });
  await waitForMenuHistory(rootNode);

  await openMenu(rootNode, "srv-own");
  await pickMenu("撤回");
  assert.ok(menuLabels().includes("确认撤回"), "the same menu asks for confirmation");
  assert.equal(revokeCalls, 0, "the first press only arms the confirmation");
  await pickMenu("确认撤回");
  await waitFor(() => revokeCalls === 1);
  await waitFor(() => /消息已撤回/.test(rootNode.querySelector('[data-message-id="srv-own"]').textContent));
  assert.doesNotMatch(rootNode.querySelector('[data-message-id="srv-own"]').textContent, /我方原文/, "revoked content is cleared");
  await act(async () => { rootNode.querySelector('[data-message-id="srv-own"]').dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await settle();
  assert.equal(document.querySelector(".message-action-menu"), null, "a revoked message has no menu");

  for (const [status, copy] of [[409, "已超过可撤回时间"], [403, "无权撤回此消息"]]) {
    const failing = await mountMenu(t, { post: () => new browser.Response("{}", { status }) });
    await waitForMenuHistory(failing.rootNode);
    await openMenu(failing.rootNode, "srv-own");
    await pickMenu("撤回");
    await pickMenu("确认撤回");
    await waitFor(() => new RegExp(copy).test(failing.rootNode.querySelector(".im-wb-notice")?.textContent ?? ""));
    assert.match(failing.rootNode.querySelector('[data-message-id="srv-own"]').textContent, /我方原文/, "a failed revoke keeps the message");
  }
});

test("delete hides the message locally and a failure never fakes success", async (t) => {
  let deleteCalls = 0;
  const { rootNode } = await mountMenu(t, {
    post: (body) => {
      if (body.action !== "delete") throw new Error(`unexpected action ${body.action}`);
      deleteCalls += 1;
      return { ok: true };
    },
  });
  await waitForMenuHistory(rootNode);
  await openMenu(rootNode, "srv-peer");
  await pickMenu("删除");
  await waitFor(() => !rootNode.querySelector('[data-message-id="srv-peer"]'));
  assert.equal(deleteCalls, 1);

  const failing = await mountMenu(t, { post: () => new browser.Response("{}", { status: 403 }) });
  await waitForMenuHistory(failing.rootNode);
  await openMenu(failing.rootNode, "srv-peer");
  await pickMenu("删除");
  await waitFor(() => /无权删除此消息/.test(failing.rootNode.querySelector(".im-wb-notice")?.textContent ?? ""));
  assert.ok(failing.rootNode.querySelector('[data-message-id="srv-peer"]'), "a failed delete keeps the message");
});
