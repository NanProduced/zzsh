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
// recharts 的 ResponsiveContainer 需要 ResizeObserver；评分分布图现在也走 recharts。
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

// 桌面宽度：聊天和队列同时可见，标记已读只受选中轮次/历史状态约束。
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

// 只接管客服工作台的 5 秒轮询，让测试可以手动触发“轮询后不重复标记已读”。
const intervalCallbacks = [];
const realSetInterval = browser.setInterval.bind(browser);
const realClearInterval = browser.clearInterval.bind(browser);
let intervalId = 0;
browser.setInterval = (callback, delay) => {
  if (delay === 5_000) {
    const id = `test-${++intervalId}`;
    intervalCallbacks.push({ id, callback, delay, active: true });
    return id;
  }
  return realSetInterval(callback, delay);
};
browser.clearInterval = (id) => {
  const entry = intervalCallbacks.find((item) => item.id === id);
  if (entry) entry.active = false;
  else realClearInterval(id);
};
globalThis.setInterval = browser.setInterval;
globalThis.clearInterval = browser.clearInterval;
const pollTimers = () => intervalCallbacks.filter((entry) => entry.active && entry.delay === 5_000);

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { ImSupportView } = await vite.ssrLoadModule("/src/views/im-support-view.tsx");
const { formatTime, formatListTime } = await vite.ssrLoadModule("/src/views/im-support-format.ts");
const { SupportManagementPane } = await vite.ssrLoadModule("/src/views/im-support-management.tsx");
const model = await vite.ssrLoadModule("/src/views/im-support-management-model.ts");
const { beijingCalendarDate } = await vite.ssrLoadModule("/src/workspace/beijing-time.ts");
const { adminRequest } = await vite.ssrLoadModule("/src/api.ts");
after(async () => { await vite.close(); });

function json(body, status = 200) {
  return new browser.Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function failure(status) {
  return new browser.Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), { status, headers: { "content-type": "application/json" } });
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

const activeMine = {
  id: "c-active", threadId: "thread-a", roundId: "round-1", roundSeq: 1, threadState: "ACTIVE",
  type: "SERVICE", state: "ACTIVE", subjectRef: null, version: 1,
  assignedAdmin: { id: "admin-a", name: "客服 A" }, peerAccountId: "user-a", conversationType: "TEAM",
  conversationId: "conv-a", messageScopeState: "READY", canSend: true,
  lastMessageAt: "2026-10-29T02:00:00.000Z", createdAt: "2026-10-29T01:00:00.000Z", updatedAt: "2026-10-29T02:00:00.000Z",
  user: { id: "user-a", name: "用户 A", username: "user-a" },
};
const activeMineSecond = {
  ...activeMine,
  id: "c-second", threadId: "thread-b", roundId: "round-2", roundSeq: 1,
  conversationId: "conv-b", assignedAdmin: { id: "admin-a", name: "客服 A" },
  user: { id: "user-b", name: "用户 B", username: "user-b" },
};
const activeOther = {
  ...activeMine,
  id: "c-other", threadId: "thread-c", roundId: "round-other", roundSeq: 1,
  conversationId: "conv-c", assignedAdmin: { id: "admin-b", name: "客服 B" }, canSend: false,
  user: { id: "user-c", name: "用户 C", username: "user-c" },
};
const waitingMine = {
  ...activeMine,
  id: "c-waiting", threadId: "thread-d", roundId: "round-waiting", roundSeq: 1, threadState: "WAITING",
  state: "WAITING", conversationId: "conv-d", messageScopeState: undefined, canSend: false,
  lastMessageAt: null, user: { id: "user-d", name: "用户 D", username: "user-d" },
};
const historyMessage = {
  messageClientId: "m-1", messageServerId: "m-1", conversationId: "conv-a",
  senderId: "user-a", receiverId: "admin-a", createTime: Date.parse("2026-10-29T01:59:00.000Z"),
  text: "用户提问", messageType: 0,
};

const baseOverview = () => ({
  reportDate: "2026-10-29",
  serverNow: "2026-10-29T04:00:00.000Z",
  onDuty: [],
  totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 0, todayUsers: 0 },
  trend: [],
  hourly: [],
  ratings: { count: 0, average: null, distribution: [0, 0, 0, 0, 0], agents: [] },
});

const requests = [];
let fixture = {};
function resetFixture(overrides = {}) {
  requests.length = 0;
  fixture = {
    consultations: [activeMine],
    history: [historyMessage],
    historyStatus: 200,
    readStatus: 200,
    overview: baseOverview(),
    overviewStatus: 200,
    ...overrides,
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), browser.location.href);
  const pathname = url.pathname;
  requests.push({ path: `${pathname}${url.search}`, method: init.method ?? "GET" });
  if (pathname.endsWith("/im/token")) return json({ appKey: "synthetic", accountId: "admin-a", token: "synthetic", transport: "local-fake" });
  if (pathname.endsWith("/im/presence/heartbeat")) return json({ ok: true });
  if (pathname.endsWith("/im/presence")) return json({ adminUserId: "admin-a", availability: "OFF_DUTY", connectionState: "CONNECTED", activeLoad: 0, version: 1 });
  if (/\/im\/consultations\/[^/]+\/read$/.test(pathname)) {
    return fixture.readStatus === 200 ? json({ adminReadAt: "2026-10-29T02:05:00.000Z" }) : failure(fixture.readStatus);
  }
  if (pathname.endsWith("/im/consultations")) return json({ consultations: fixture.consultations });
  if (pathname.endsWith("/im/support-overview")) return fixture.overviewStatus === 200 ? json(fixture.overview) : failure(fixture.overviewStatus);
  if (pathname.endsWith("/im/handovers")) return json({ items: [] });
  if (pathname.endsWith("/im/message-access")) return json({ authorized: true });
  if (pathname.endsWith("/im/messages")) return fixture.historyStatus === 200 ? json({ messages: fixture.history }) : failure(fixture.historyStatus);
  if (pathname.endsWith("/context")) return json({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-a", displayName: "用户 A", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (pathname.includes("/users/")) return json({ userId: "user-a", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
  throw new Error(`unexpected test request ${pathname}${url.search}`);
};

const consultationRows = (root) => [...(root.querySelector(".im-wb-pane:not([hidden]) .im-wb-queue")?.querySelectorAll(".im-wb-row") ?? [])];
async function settle(ms = 25) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function waitFor(predicate, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

const readRequests = () => requests.filter((request) => /\/im\/consultations\/[^/]+\/read$/.test(request.path));

async function selectRow(rootNode, text) {
  await waitFor(() => consultationRows(rootNode).length > 0);
  const row = [...consultationRows(rootNode)].find((item) => item.textContent.includes(text));
  assert.ok(row, `queue lists ${text}`);
  await act(async () => { row.click(); });
  await settle();
}

const basePermissions = ["im.support.read", "im.support.accept"];

async function mountSupport(t, { permissions = basePermissions } = {}) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    rootNode.remove();
  });
  const snap = snapshot(permissions);
  const onRefresh = async () => snap;
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snap, onRefresh })); });
  await settle();
  return { rootNode, root, snap, onRefresh };
}

async function rerenderSupport(root, snap, onRefresh) {
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snap, onRefresh })); });
  await settle();
}

async function mountManagement(t) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    rootNode.remove();
  });
  await act(async () => {
    root.render(createElement(SupportManagementPane, {
      active: true, request: adminRequest, canTakeover: false, currentAdminUserId: "admin-a", currentAdminName: "客服 A",
    }));
  });
  await settle();
  return { rootNode };
}

const historyLoaded = (rootNode) => [...rootNode.querySelectorAll(".im-wb-bub")].some((element) => element.textContent === "用户提问");

/* ------------------------------ 标记已读 ------------------------------ */

test("opening the workbench selects nothing and marks nothing read", async (t) => {
  resetFixture();
  const { rootNode } = await mountSupport(t);
  await waitFor(() => consultationRows(rootNode).length === 1);
  await settle();
  assert.equal(rootNode.querySelector('.im-wb-row[data-active="true"]'), null, "no row is selected automatically");
  assert.equal(rootNode.querySelector(".im-wb-chat-title h2").textContent, "选择一条会话");
  assert.match(rootNode.querySelector(".im-wb-stream-wrap").textContent, /尚未选择会话/);
  assert.equal(readRequests().length, 0, "nothing is marked read before the operator opens a round");
  assert.equal(rootNode.querySelectorAll(".im-wb-bub").length, 0, "no history is opened for an unselected row");
});

test("a responsible ACTIVE round is marked read once after its history loads", async (t) => {
  resetFixture();
  const { rootNode, root, snap, onRefresh } = await mountSupport(t);
  await selectRow(rootNode, "用户 A");
  await waitFor(() => historyLoaded(rootNode));
  await waitFor(() => readRequests().length === 1);

  const read = readRequests()[0];
  assert.equal(read.method, "POST");
  assert.match(read.path, /\/im\/consultations\/round-1\/read$/, "the round id is used, not the display row id");

  // 轮询/重渲染不得重复上报同一轮次。
  await rerenderSupport(root, snapshot(basePermissions), onRefresh);
  for (const timer of pollTimers()) await act(async () => { await timer.callback(); });
  await settle();
  assert.equal(readRequests().length, 1, "a poll or rerender does not re-fire the read event");
  assert.equal(snap.adminUserId, "admin-a");
});

test("an unopened active thread shows the server preview and last-message time", async (t) => {
  const previewMine = {
    ...activeMineSecond,
    lastMessageAt: "2026-10-29T02:30:00.000Z",
    lastMessagePreview: "明天能发货吗？",
  };
  const noPreviewMine = {
    ...activeMineSecond,
    id: "c-no-preview", threadId: "thread-e", roundId: "round-3", conversationId: "conv-e",
    lastMessagePreview: null,
    user: { id: "user-e", name: "用户 E", username: "user-e" },
  };
  resetFixture({ consultations: [activeMine, previewMine, noPreviewMine] });
  const { rootNode } = await mountSupport(t);
  await waitFor(() => consultationRows(rootNode).length === 3);

  const second = [...consultationRows(rootNode)].find((row) => row.textContent.includes("用户 B"));
  assert.ok(second, "the second active thread is listed");
  assert.match(second.textContent, /明天能发货吗？/, "the queue shows the server preview before its history is opened");
  assert.doesNotMatch(second.textContent, /等待消息|等待客服接待|打开查看消息/, "a preview replaces the stale state fallbacks");
  const time = second.querySelector("time")?.textContent?.trim();
  assert.equal(time, formatListTime(Date.parse(previewMine.lastMessageAt)), "the row time comes from lastMessageAt before its history is opened");
  assert.notEqual(time, "—");

  const third = [...consultationRows(rootNode)].find((row) => row.textContent.includes("用户 E"));
  assert.ok(third, "the preview-less active thread is listed");
  assert.match(third.textContent, /打开查看消息/, "without a preview an unopened active row still offers to open the thread");
  assert.doesNotMatch(third.textContent, /等待消息/, "the queue does not claim an active thread is waiting for its first message");
});

test("other admins' rounds and non-ACTIVE rounds are never marked read", async (t) => {
  // 保留一条我负责的 ACTIVE，避免默认筛选在“无我的会话”时自动落到待接待，从而能显式打开别人负责的轮次。
  resetFixture({ consultations: [activeOther, activeMine, waitingMine] });
  const { rootNode } = await mountSupport(t);
  await waitFor(() => consultationRows(rootNode).length > 0);
  await selectRow(rootNode, "用户 C");
  await waitFor(() => historyLoaded(rootNode));
  await settle();
  assert.equal(readRequests().length, 0, "a round owned by another admin is not read by this account");
  assert.doesNotMatch(rootNode.textContent, /已读/, "no read receipt is shown for another admin's round");

  await act(async () => { [...rootNode.querySelectorAll(".im-wb-filters button")].find((button) => button.textContent.includes("待接待")).click(); });
  await settle();
  const waitingRow = [...consultationRows(rootNode)].find((row) => row.textContent.includes("用户 D"));
  assert.ok(waitingRow, "the waiting round is reachable in the waiting filter");
  await act(async () => waitingRow.click());
  await settle();
  await settle();
  assert.equal(readRequests().length, 0, "a WAITING round has no responsible read event");
});

test("a failed history load keeps the round unread until a successful retry", async (t) => {
  resetFixture({ historyStatus: 500 });
  const { rootNode } = await mountSupport(t);
  await selectRow(rootNode, "用户 A");
  await waitFor(() => rootNode.querySelector('[data-action="retry-history"]'));
  await settle();
  assert.equal(readRequests().length, 0, "a failed read of the thread never claims the round was read");

  fixture.historyStatus = 200;
  await act(async () => rootNode.querySelector('[data-action="retry-history"]').click());
  await waitFor(() => historyLoaded(rootNode));
  await waitFor(() => readRequests().length === 1);
  assert.match(readRequests()[0].path, /\/round-1\/read$/);
});

test("switching rounds marks each once and going back does not repeat a round", async (t) => {
  resetFixture({ consultations: [activeMine, activeMineSecond], history: [historyMessage] });
  const { rootNode } = await mountSupport(t);
  await selectRow(rootNode, "用户 A");
  await waitFor(() => readRequests().length === 1);
  assert.match(readRequests()[0].path, /\/round-1\/read$/);

  const secondRow = [...consultationRows(rootNode)].find((row) => row.textContent.includes("用户 B"));
  assert.ok(secondRow, "the second responsible round is listed");
  await act(async () => secondRow.click());
  await waitFor(() => readRequests().length === 2);
  assert.match(readRequests()[1].path, /\/round-2\/read$/);

  const firstRow = [...consultationRows(rootNode)].find((row) => row.textContent.includes("用户 A"));
  await act(async () => firstRow.click());
  await settle();
  await settle();
  assert.equal(readRequests().length, 2, "returning to an already-read round stays deduped");
});

test("a new history version on the same round advances the read marker once", async (t) => {
  resetFixture({ consultations: [activeMine, activeMineSecond], history: [historyMessage] });
  const { rootNode } = await mountSupport(t);
  await selectRow(rootNode, "用户 A");
  await waitFor(() => readRequests().length === 1);

  fixture.history = [...fixture.history, {
    ...historyMessage,
    messageClientId: "m-2",
    messageServerId: "m-2",
    text: "用户追问",
    createTime: Date.parse("2026-10-29T02:03:00.000Z"),
  }];
  const secondRow = [...consultationRows(rootNode)].find((row) => row.textContent.includes("用户 B"));
  await act(async () => secondRow.click());
  await waitFor(() => readRequests().length === 2);

  const firstRow = [...consultationRows(rootNode)].find((row) => row.textContent.includes("用户 A"));
  await act(async () => firstRow.click());
  await waitFor(() => readRequests().length === 3);
  assert.match(readRequests()[2].path, /\/round-1\/read$/, "the same round is re-marked after its history changed");

  await act(async () => secondRow.click());
  await settle();
  await act(async () => firstRow.click());
  await settle();
  await settle();
  assert.equal(readRequests().length, 3, "returning with an unchanged history stays deduped");
});

test("a failed mark-read stays silent and is not retried by polls", async (t) => {
  resetFixture({ readStatus: 500 });
  const { rootNode } = await mountSupport(t);
  await selectRow(rootNode, "用户 A");
  await waitFor(() => historyLoaded(rootNode));
  await waitFor(() => readRequests().length === 1);
  await settle();
  assert.equal(readRequests().length, 1, "the failed attempt is not automatically repeated");
  assert.doesNotMatch(rootNode.textContent, /已读|标记已读失败/, "no local read receipt is fabricated and no error banner is raised");
  assert.equal(rootNode.querySelector('.im-wb-notice[role="alert"]'), null);
});

test("the bell covers complaint rows and its notification opens that consultation", async (t) => {
  const complaint = {
    ...activeMine,
    id: "c-complaint-bell", threadId: "thread-complaint", roundId: "round-complaint", type: "COMPLAINT",
    adminUnreadCount: 1,
    user: { id: "user-c", name: "投诉用户", username: "user-c" },
  };
  resetFixture({ consultations: [complaint], history: [] });
  const fired = [];
  class FakeNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title, options) { fired.push(this); this.title = title; this.options = options; this.onclick = null; }
    close() {}
  }
  const originalNotification = globalThis.Notification;
  const originalBrowserNotification = browser.Notification;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(browser.document, "hidden");
  globalThis.Notification = FakeNotification;
  browser.Notification = FakeNotification;
  Object.defineProperty(browser.document, "hidden", { configurable: true, value: true });
  t.after(() => {
    globalThis.Notification = originalNotification;
    browser.Notification = originalBrowserNotification;
    if (hiddenDescriptor) Object.defineProperty(browser.document, "hidden", hiddenDescriptor);
    else delete browser.document.hidden;
    browser.localStorage.removeItem("zzsh.im-support.seen.admin-a");
  });
  browser.localStorage.removeItem("zzsh.im-support.seen.admin-a");

  const { rootNode } = await mountSupport(t, { permissions: ["im.support.read", "im.support.accept", "im.support.complaint"] });
  await waitFor(() => consultationRows(rootNode).length === 1);
  await settle();
  assert.equal(rootNode.querySelector('.im-wb-row[data-active="true"]'), null, "loading the queue selects nothing");
  const bell = rootNode.querySelector('[data-action="toggle-notifications"]');
  assert.equal(bell.querySelector(".im-wb-notify-count")?.textContent, "1", "an unread complaint counts in the bell");

  fixture.consultations = [{ ...complaint, lastMessageAt: "2026-10-29T02:30:00.000Z" }];
  for (const timer of pollTimers()) await act(async () => { await timer.callback(); });
  await waitFor(() => fired.length === 1);
  assert.equal(rootNode.querySelector('.im-wb-row[data-active="true"]'), null, "a queue refresh does not select a row either");
  assert.match(fired[0].title, /投诉反馈/, "a complaint is a notification row, not consultation-only");
  assert.equal(fired[0].options?.tag, "zzsh-im-c-complaint-bell");

  await act(async () => { fired[0].onclick?.(); });
  await settle();
  assert.match(rootNode.querySelector('.im-wb-row[data-active="true"]')?.textContent ?? "", /投诉用户/, "the notification selects its own row");
  assert.match(rootNode.querySelector(".im-wb-chat-title h2").textContent, /投诉反馈/);
  assert.equal(rootNode.querySelector(".im-wb").dataset.pane, "chat", "opening a notification switches to the chat pane");
});

/* ------------------------------ 评价统计 ------------------------------ */

const ratedOverview = () => ({
  ...baseOverview(),
  ratings: {
    count: 7,
    average: 4.6,
    distribution: [0, 0, 1, 1, 5],
    agents: [
      { adminUserId: "admin-a", name: "客服 A", count: 5, average: 4.8 },
      { adminUserId: "admin-b", name: "客服 B", count: 2, average: 4.2 },
    ],
  },
});

test("the dashboard renders today's rating count, average, distribution and per-agent rows", async (t) => {
  resetFixture({ overview: ratedOverview() });
  const { rootNode } = await mountManagement(t);
  await waitFor(() => rootNode.querySelector('[data-panel="ratings"]'));

  const panel = rootNode.querySelector('[data-panel="ratings"]');
  assert.equal(panel.dataset.count, "7");
  assert.match(panel.querySelector('[data-rating-metric="count"]').textContent, /^7评价数$/);
  assert.match(panel.querySelector('[data-rating-metric="average"]').textContent, /^4\.6平均分$/, "the average keeps one decimal");
  assert.doesNotMatch(panel.textContent, /今日暂无评价/);

  // 星级分布只在一处画：看板的「今日评分分布」图。卡内 CSS 条形已合并删除，避免两套渲染漂移。
  assert.equal(panel.querySelectorAll("[data-rating-score]").length, 0, "卡内不再重复画分布");
  assert.equal(panel.querySelectorAll('[data-chart="rating-distribution"]').length, 1, "one distribution is included with its rating summary");
  const chart = rootNode.querySelector('[data-chart="rating-distribution"]');
  assert.equal(chart.dataset.count, "7", "图表读的是同一份服务端计数");
  const summary = chart.getAttribute("aria-label");
  assert.match(summary, /5 星 5 条/, "图表自带无障碍数值，删掉条形也不丢数字");
  assert.match(summary, /3 星 1 条/);
  assert.match(summary, /1 星 0 条/);

  const agentA = panel.querySelector('[data-rating-agent="admin-a"]');
  assert.ok(agentA, "each agent keeps a row");
  assert.match(agentA.textContent, /客服 A/);
  assert.match(agentA.textContent, /5/);
  assert.match(agentA.textContent, /4\.8/);
  assert.match(panel.querySelector('[data-rating-agent="admin-b"]').textContent, /4\.2/);
  assert.match(panel.textContent, /客服/);
  assert.match(panel.textContent, /评价数/);
  assert.match(panel.textContent, /平均分/);
});

test("no ratings today shows 今日暂无评价 without a fabricated average", async (t) => {
  resetFixture();
  const { rootNode } = await mountManagement(t);
  await waitFor(() => rootNode.querySelector('[data-panel="ratings"]'));

  const panel = rootNode.querySelector('[data-panel="ratings"]');
  assert.equal(panel.dataset.count, "0");
  assert.equal(panel.querySelector('[data-rating-empty]')?.textContent, "今日暂无评价");
  assert.equal(panel.querySelectorAll("[data-rating-metric]").length, 0, "no average or count metric is invented");
  assert.equal(panel.querySelectorAll("[data-rating-score]").length, 0, "没有评价就不画分布行");
  assert.equal(rootNode.querySelector('[data-chart="rating-distribution"]'), null, "no empty rating graph duplicates the no-rating summary");
  assert.equal(panel.querySelectorAll("[data-rating-agent]").length, 0);
  assert.doesNotMatch(panel.textContent, /0\.0|平均分/);
});

test("ratings use the overview server day without a browser-supplied date", async (t) => {
  resetFixture({ overview: ratedOverview() });
  const { rootNode } = await mountManagement(t);
  await waitFor(() => rootNode.querySelector('[data-panel="ratings"]'));

  const overviewRequests = requests.filter((request) => request.path.includes("/im/support-overview"));
  assert.equal(overviewRequests.length, 1, "ratings do not add a second stats request");
  const date = new URL(overviewRequests[0].path, "http://localhost").searchParams.get("date");
  assert.equal(date, null, "the server owns today; the browser clock is not sent");
});

/* ------------------------------ 纯模型 ------------------------------ */

test("rating parsing keeps valid values and refuses out-of-range averages", () => {
  const parsed = model.parseSupportOverview({
    ...baseOverview(),
    ratings: {
      count: 3,
      average: 4.666,
      distribution: [1, 0, 0, 0, 2],
      agents: [
        { adminUserId: "a", name: "客服 A", count: 2, average: 4.5 },
        { adminUserId: "b", count: 1, average: 0 },
        { adminUserId: "", name: "无身份", count: 9, average: 5 },
      ],
    },
  });
  assert.equal(parsed.ratings.count, 3);
  assert.equal(parsed.ratings.average, 4.666);
  assert.deepEqual(parsed.ratings.distribution, [1, 0, 0, 0, 2]);
  assert.deepEqual(parsed.ratings.agents.map((agent) => agent.adminUserId), ["a", "b"]);
  assert.equal(parsed.ratings.agents[0].average, 4.5);
  assert.equal(parsed.ratings.agents[1].name, "未命名客服");
  assert.equal(parsed.ratings.agents[1].average, null, "0 is not a valid 1..5 average");

  assert.throws(() => model.parseSupportOverview({}), /客服统计数据不完整/);
  assert.throws(() => model.parseSupportOverview({
    ...baseOverview(),
    ratings: { count: 1, average: 5, distribution: [1, 2], agents: [] },
  }), /客服统计数据不完整/);
  assert.equal(model.formatRatingAverage(null), "—");
  assert.equal(model.formatRatingAverage(4.666), "4.7");
});
