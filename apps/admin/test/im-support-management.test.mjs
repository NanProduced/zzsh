import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// 只拦截 60 秒心跳，其余定时器保持真实行为（测试卸载时会清理）。
const intervalCallbacks = [];
const realSetInterval = browser.setInterval.bind(browser);
const realClearInterval = browser.clearInterval.bind(browser);
let intervalId = 0;
browser.setInterval = (callback, delay) => {
  if (delay === 60_000) {
    const id = `heartbeat-${++intervalId}`;
    intervalCallbacks.push({ id, delay, callback, active: true });
    return id;
  }
  return realSetInterval(callback, delay);
};
browser.clearInterval = (id) => {
  const entry = intervalCallbacks.find((item) => item.id === id);
  if (entry) entry.active = false;
  else realClearInterval(id);
};
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} };
globalThis.setInterval = browser.setInterval;
globalThis.clearInterval = browser.clearInterval;
const heartbeatTimers = () => intervalCallbacks.filter((entry) => entry.active && entry.delay === 60_000);

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { ImSupportView } = await vite.ssrLoadModule("/src/views/im-support-view.tsx");
const { SupportManagementPane } = await vite.ssrLoadModule("/src/views/im-support-management.tsx");
const { canOpenKind } = await vite.ssrLoadModule("/src/workspace/tab-model.ts");
const { workspaceMenuItems } = await vite.ssrLoadModule("/src/workspace/nav-config.ts");
const model = await vite.ssrLoadModule("/src/views/im-support-management-model.ts");
const { adminRequest } = await vite.ssrLoadModule("/src/api.ts");
after(async () => { await vite.close(); });

function json(body, status = 200) {
  return new browser.Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function failure(status) {
  return new browser.Response(JSON.stringify({ error: { code: status === 403 ? "FORBIDDEN" : "INTERNAL_ERROR" } }), { status, headers: { "content-type": "application/json" } });
}

function snapshot(permissions, isBoss = false) {
  return {
    authenticated: true,
    adminUserId: "admin-a",
    user: { name: "客服 A", username: "admin-a", displayUsername: "客服 A", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss, passwordChangeRequired: false },
    session: { id: "session-a", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions,
  };
}

const activeConsultation = {
  id: "c-active", threadId: "thread-a", roundId: "c-active", roundSeq: 2, threadState: "ACTIVE",
  type: "SERVICE", state: "ACTIVE", subjectRef: null, version: 1,
  assignedAdmin: { id: "admin-a", name: "客服 A" }, peerAccountId: "user-a", conversationType: "TEAM",
  conversationId: "conv-a", messageScopeState: "READY", canSend: true,
  lastMessageAt: "2026-10-29T02:00:00.000Z", createdAt: "2026-10-29T01:00:00.000Z", updatedAt: "2026-10-29T02:00:00.000Z",
  user: { id: "user-a", name: "用户 A", username: "user-a" },
};

const overview = (overrides = {}) => ({
  onDuty: [],
  totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 0, todayUsers: 0 },
  trend: [],
  hourly: [],
  ...overrides,
});

function baseFixture(overrides = {}) {
  return {
    presence: { adminUserId: "admin-a", availability: "OFF_DUTY", connectionState: "CONNECTED", activeLoad: 0, version: 1 },
    consultations: [],
    history: [],
    overview: overview(),
    overviewStatus: 200,
    handovers: { items: [] },
    handoverStatus: 200,
    conversations: { items: [], nextCursor: null },
    auditStatus: 200,
    messages: { messages: [], nextCursor: null },
    auditMessagesStatus: 200,
    takeoverStatus: 200,
    transferTargets: { targets: [{ adminUserId: "admin-b", displayName: "客服 B" }], transferReady: true },
    ...overrides,
  };
}

const requests = [];
const presenceWrites = [];
let fixture = baseFixture();

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), browser.location.href);
  const method = init.method ?? "GET";
  requests.push({ path: `${url.pathname}${url.search}`, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
  const pathname = url.pathname;
  if (pathname.endsWith("/im/token")) return json({ appKey: "synthetic", accountId: "admin-a", token: "synthetic", transport: "local-fake" });
  if (pathname.endsWith("/im/presence/heartbeat")) return json({ ok: true });
  if (pathname.endsWith("/im/presence")) {
    if (method === "PUT") {
      const body = JSON.parse(String(init.body));
      presenceWrites.push(body);
      fixture.presence = {
        ...fixture.presence,
        availability: body.availability,
        connectionState: body.connectionState,
        version: (fixture.presence.version ?? 0) + 1,
      };
    }
    return json(fixture.presence);
  }
  if (pathname.endsWith("/im/consultations")) return json({ consultations: fixture.consultations });
  if (pathname.endsWith("/im/support-overview")) return fixture.overviewStatus === 200 ? json(fixture.overview) : failure(fixture.overviewStatus);
  if (pathname.endsWith("/im/handovers")) return fixture.handoverStatus === 200 ? json(fixture.handovers) : failure(fixture.handoverStatus);
  if (pathname.endsWith("/im/audit/conversations")) {
    if (fixture.auditStatus !== 200) return failure(fixture.auditStatus);
    const type = url.searchParams.get("type");
    const adminUserId = url.searchParams.get("adminUserId");
    const items = fixture.conversations.items.filter((item) =>
      (!type || item.type === type) && (!adminUserId || item.adminUserId === adminUserId));
    return json({ items, nextCursor: fixture.conversations.nextCursor ?? null });
  }
  if (pathname.endsWith("/im/audit/messages")) return fixture.auditMessagesStatus === 200 ? json(fixture.messages) : failure(fixture.auditMessagesStatus);
  if (pathname.includes("/im/audit/consultations/") && pathname.endsWith("/takeover")) {
    if (fixture.takeoverStatus !== 200) return failure(fixture.takeoverStatus);
    const id = decodeURIComponent(pathname.split("/").at(-2) ?? "");
    fixture.conversations.items = fixture.conversations.items.map((item) => (item.id === id ? { ...item, adminUserId: "admin-a", adminName: "客服 A" } : item));
    return json({ ok: true });
  }
  if (pathname.endsWith("/im/transfer-targets")) return json(fixture.transferTargets);
  if (pathname.endsWith("/transfer")) return json({ consultation: { ...(fixture.consultations[0] ?? activeConsultation), assignedAdmin: { id: "admin-b", name: "客服 B" } } });
  if (pathname.endsWith("/im/message-access")) return json({ authorized: true });
  if (pathname.includes("/im/messages")) return json(fixture.messages.messages.length ? fixture.messages : { messages: fixture.history, nextCursor: null });
  if (pathname.endsWith("/context")) return json({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-a", displayName: "用户 A", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (pathname.includes("/users/")) return json({ user: { userId: "user-a", displayName: "用户 A", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z", resourceSummary: { state: "denied", permission: "supply.rental_account.read" }, orderSummary: { state: "denied", permission: "order.read" } } });
  throw new Error(`unexpected test request ${pathname}${url.search}`);
};

async function settle(ms = 25) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function waitFor(predicate, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

const basePermissions = ["im.support.read", "im.support.accept", "im.support.transfer", "im.support.presence"];
const managementPermissions = [...basePermissions, "im.support.management.read", "im.support.audit.takeover"];

async function mount(t, { permissions = basePermissions, isBoss = false } = {}) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    rootNode.remove();
  });
  const snap = snapshot(permissions, isBoss);
  await act(async () => {
    root.render(createElement(ImSupportView, {
      snapshot: snap,
      onRefresh: async () => snap,
    }));
  });
  await settle();
  return { rootNode, root };
}

async function mountManagement(t, { canTakeover = true, onOpenConsultation } = {}) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    rootNode.remove();
  });
  await act(async () => {
    root.render(createElement(SupportManagementPane, {
      active: true, request: adminRequest, canTakeover, currentAdminUserId: "admin-a", currentAdminName: "客服 A", ...(onOpenConsultation ? { onOpenConsultation } : {}),
    }));
  });
  await settle();
  return { rootNode, root };
}

async function openManagement(rootNode) {
  await waitFor(() => rootNode.querySelector(".im-wb-mgmt"));
}

async function openPatrol(rootNode) {
  await openManagement(rootNode);
  const tab = [...rootNode.querySelectorAll('[data-slot="tabs-trigger"]')].find((item) => item.textContent.trim() === "巡视");
  assert.ok(tab, "the patrol sub-tab exists");
  await act(async () => tab.click());
  await settle();
  await waitFor(() => rootNode.querySelector("[data-patrol]"));
}

async function pickOption(rootNode, ariaLabel, label) {
  const trigger = rootNode.querySelector(`[aria-label="${ariaLabel}"]`) ?? browser.document.querySelector(`[aria-label="${ariaLabel}"]`);
  assert.ok(trigger, `filter ${ariaLabel} exists`);
  await act(async () => trigger.click());
  await waitFor(() => browser.document.querySelector('[role="option"]'));
  const option = [...browser.document.querySelectorAll('[role="option"]')].find((item) => item.textContent.trim() === label);
  assert.ok(option, `option ${label} exists`);
  await act(async () => option.click());
  await settle();
  await waitFor(() => (rootNode.querySelector(`[aria-label="${ariaLabel}"]`)?.textContent ?? "").includes(label));
}

/* ------------------------------ 权限门禁 ------------------------------ */

test("the management route and navigation entry require boss or im.support.management.read", async () => {
  fixture = baseFixture();
  const denied = { isBoss: false, permissions: basePermissions };
  assert.equal(canOpenKind("support-management", denied), false, "an unpermitted admin cannot open the route");
  assert.equal(workspaceMenuItems(denied).some((item) => item.kind === "support-management"), false, "the nav item stays hidden");
  const allowed = { isBoss: false, permissions: managementPermissions };
  assert.equal(canOpenKind("support-management", allowed), true);
  assert.ok(workspaceMenuItems(allowed).some((item) => item.kind === "support-management" && item.label === "客服管理"), "the permission opens the nav item");
  const boss = { isBoss: true, permissions: basePermissions };
  assert.equal(canOpenKind("support-management", boss), true);
  assert.ok(workspaceMenuItems(boss).some((item) => item.kind === "support-management"), "boss gets it without the explicit permission");
});

test("page-content guards and renders the standalone management page", () => {
  const source = readFileSync(path.join(adminRoot, "src/workspace/page-content.tsx"), "utf8");
  assert.match(source, /if \(tab\.kind === "support-management"\)/);
  assert.match(source, /const canManageSupport = snapshot\.security\.isBoss \|\| snapshot\.permissions\.includes\("im\.support\.management\.read"\)/);
  assert.match(source, /<SupportManagementPane[^>]*canTakeover=/);
});

/* ------------------------------ 看板 ------------------------------ */

test("dashboard renders real totals, on-duty rows, three charts and honest empty states", async (t) => {
  fixture = baseFixture({
    overview: overview({
      onDuty: [{ adminUserId: "admin-a", name: "客服 A", availability: "AVAILABLE", connectionState: "CONNECTED", activeLoad: 2, todaySeconds: 8100, todaySessions: 12, todayUsers: 9, currentOrderGroups: 3 }],
      totals: { onDutyCount: 1, waitingConsultations: 4, todaySessions: 12, todayUsers: 9 },
      trend: [
        { date: "2026-10-23", sessions: 3, users: 2 },
        { date: "2026-10-24", sessions: 5, users: 4 },
        { date: "2026-10-25", sessions: 0, users: 0 },
        { date: "2026-10-26", sessions: 6, users: 5 },
        { date: "2026-10-27", sessions: 2, users: 1 },
        { date: "2026-10-28", sessions: 7, users: 4 },
        { date: "2026-10-29", sessions: 4, users: 3 },
      ],
      hourly: [{ hour: 9, sessions: 4 }, { hour: 14, sessions: 7 }],
    }),
    handovers: { items: [{ id: "h-1", objectType: "CONSULTATION", objectId: "c-1", display: "用户 A · 平台咨询", fromName: "客服 B", toName: "客服 A", note: "午休交接", createdAt: "2026-10-29T03:00:00.000Z" }] },
  });
  const { rootNode } = await mountManagement(t);
  await openManagement(rootNode);
  await waitFor(() => rootNode.querySelector(".im-wb-mgmt-totals"));

  const metrics = [...rootNode.querySelectorAll(".im-wb-mgmt-metric-value")].map((node) => node.textContent);
  assert.deepEqual(metrics, ["1", "4", "12", "9"]);
  const row = rootNode.querySelector('tr[data-admin-user-id="admin-a"]');
  assert.ok(row, "on-duty row uses the server identity");
  assert.match(row.textContent, /客服 A/);
  assert.match(row.textContent, /可接待/);
  assert.match(row.textContent, /2h 15m/, "connection time is formatted from seconds");
  assert.match(row.textContent, /12/);
  assert.match(row.textContent, /9/);
  assert.match(row.textContent, /3/, "current order groups are shown");

  const trend = rootNode.querySelector('[data-chart="trend"]');
  assert.equal(trend.dataset.points, "7", "seven trend points are handed to the chart");
  assert.match(trend.textContent, /会话/);
  assert.match(trend.textContent, /用户/);

  const hourly = rootNode.querySelector('[data-chart="hourly"]');
  assert.equal(hourly.dataset.points, "2", "only hours with data are counted");
  assert.match(hourly.textContent, /今日每小时新咨询/);

  const workload = rootNode.querySelector('[data-chart="workload"]');
  assert.equal(workload.dataset.points, "1", "each agent becomes one bar");
  assert.match(workload.textContent, /今日接待时长/);

  const handover = rootNode.querySelector('[data-handover-id="h-1"]');
  assert.ok(handover, "handover record is rendered");
  assert.match(handover.textContent, /客服 B → 客服 A/);
  assert.match(handover.textContent, /咨询会话/);
  assert.match(handover.textContent, /用户 A · 平台咨询/);
  assert.match(handover.textContent, /备注：午休交接/);

  const overviewRequest = requests.find((request) => request.path.includes("/im/support-overview?date="));
  assert.ok(overviewRequest, "dashboard reads the overview endpoint");
  assert.match(overviewRequest.path, /date=\d{4}-\d{2}-\d{2}$/);
  assert.ok(requests.some((request) => request.path.endsWith("/im/handovers?limit=20")), "handovers read the documented limit");
});

test("empty dashboard says 暂无数据 instead of drawing invented values", async (t) => {
  fixture = baseFixture();
  const { rootNode } = await mountManagement(t);
  await openManagement(rootNode);
  await waitFor(() => rootNode.querySelector(".im-wb-mgmt-totals"));
  assert.deepEqual([...rootNode.querySelectorAll(".im-wb-mgmt-metric-value")].map((node) => node.textContent), ["0", "0", "0", "0"]);
  assert.match(rootNode.textContent, /暂无客服数据/);
  assert.equal(rootNode.querySelectorAll(".im-wb-mgmt-chart-empty").length, 3, "all three charts declare no data");
  assert.equal(rootNode.querySelectorAll(".im-wb-mgmt-bar").length, 0, "no bar is painted without data");
  assert.match(rootNode.textContent, /暂无交接记录/);
});

test("dashboard failure and forbidden states are real and retryable", async (t) => {
  fixture = baseFixture({ overviewStatus: 500 });
  const { rootNode } = await mountManagement(t);
  await openManagement(rootNode);
  await waitFor(() => rootNode.querySelector('.im-wb-mgmt-state[data-state="error"]'));
  assert.match(rootNode.textContent, /客服数据读取失败/);
  assert.match(rootNode.textContent, /服务暂时无法完成请求/);
  fixture.overviewStatus = 200;
  fixture.overview = overview({ totals: { onDutyCount: 0, waitingConsultations: 2, todaySessions: 5, todayUsers: 3 } });
  const retry = [...rootNode.querySelectorAll(".im-wb-mgmt-state button")].find((button) => button.textContent.includes("重新读取"));
  assert.ok(retry, "error offers an explicit retry");
  await act(async () => retry.click());
  await waitFor(() => rootNode.querySelector(".im-wb-mgmt-totals"));
  assert.deepEqual([...rootNode.querySelectorAll(".im-wb-mgmt-metric-value")].map((node) => node.textContent), ["0", "2", "5", "3"]);

  fixture = baseFixture({ overviewStatus: 403 });
  const forbidden = await mountManagement(t);
  await openManagement(forbidden.rootNode);
  await waitFor(() => forbidden.rootNode.querySelector('.im-wb-mgmt-state[data-state="forbidden"]'));
  assert.match(forbidden.rootNode.textContent, /无权查看客服管理数据/);
});

test("dashboard manual refresh re-reads overview and handovers", async (t) => {
  fixture = baseFixture();
  const { rootNode } = await mountManagement(t);
  await openManagement(rootNode);
  await waitFor(() => rootNode.querySelector('[data-action="refresh-dashboard"]'));
  const before = requests.filter((request) => request.path.includes("/im/support-overview") || request.path.includes("/im/handovers")).length;
  fixture.handovers = { items: [{ id: "h-2", objectType: "ORDER_GROUP", objectId: "o-1", display: "订单 DD-1", fromName: "客服 B", toName: "客服 A", note: null, createdAt: "2026-10-29T04:00:00.000Z" }] };
  await act(async () => rootNode.querySelector('[data-action="refresh-dashboard"]').click());
  await waitFor(() => /订单 DD-1/.test(rootNode.textContent));
  const after = requests.filter((request) => request.path.includes("/im/support-overview") || request.path.includes("/im/handovers")).length;
  assert.ok(after >= before + 2, "manual refresh reloads both dashboard sources");
});

/* ------------------------------ 巡视 ------------------------------ */

const auditConversations = () => [
  { id: "audit-c1", type: "SERVICE", title: "用户甲 · 平台咨询", userName: "用户甲", adminUserId: "admin-b", adminName: "客服 B", state: "ACTIVE", lastMessageAt: "2026-10-29T02:00:00.000Z", conversationId: "conv-c1", displayNo: null, gameName: null },
  { id: "audit-o1", type: "ORDER", title: "订单群 20261029", userName: "", adminUserId: "admin-b", adminName: "客服 B", state: "ACTIVE", lastMessageAt: "2026-10-29T02:30:00.000Z", conversationId: "conv-o1", displayNo: "DD20261029001", gameName: "三角洲行动" },
  { id: "audit-c2", type: "COMPLAINT", title: "用户乙 · 投诉反馈", userName: "用户乙", adminUserId: null, adminName: "未分配", state: "WAITING", lastMessageAt: "2026-10-29T03:00:00.000Z", conversationId: "conv-c2", displayNo: null, gameName: null },
];

test("patrol lists conversations, opens a read-only transcript and takes over a consultation", async (t) => {
  let openedWorkbench = false;
  fixture = baseFixture({ conversations: { items: auditConversations(), nextCursor: null } });
  fixture.messages = {
    messages: [
      { messageClientId: "m-1", messageServerId: "m-1", conversationId: "conv-c1", senderId: "user-1", receiverId: "admin-b", createTime: Date.parse("2026-10-29T01:59:00.000Z"), messageType: 0, text: "请问订单什么时候发货" },
      { messageClientId: "m-2", messageServerId: "m-2", conversationId: "conv-c1", senderId: "admin-b", receiverId: "user-1", createTime: Date.parse("2026-10-29T02:00:00.000Z"), messageType: 0, text: "正在为你核对" },
      { messageClientId: "m-3", messageServerId: "m-3", conversationId: "conv-c1", senderId: "system", receiverId: "admin-b", createTime: Date.parse("2026-10-29T02:01:00.000Z"), messageType: 5, attachment: { type: 0 } },
      { messageClientId: "m-4", messageServerId: "m-4", conversationId: "conv-c1", senderId: "admin-b", receiverId: "user-1", createTime: Date.parse("2026-10-29T02:02:00.000Z"), card: { kind: "ORDER_OPENING", orderId: "o-1", cardId: "card-1" } },
    ],
    nextCursor: null,
  };
  const { rootNode } = await mountManagement(t, { onOpenConsultation: () => { openedWorkbench = true; } });
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 3);
  const rows = [...rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row")];
  assert.match(rows[0].textContent, /用户甲/);
  assert.match(rows[0].textContent, /客服 B/);
  assert.match(rows[0].textContent, /处理中/);
  assert.match(rows[1].textContent, /DD20261029001/);
  assert.match(rows[1].textContent, /三角洲行动/);
  assert.match(rows[2].textContent, /待接入/);

  await act(async () => rows[0].click());
  await waitFor(() => /请问订单什么时候发货/.test(rootNode.querySelector(".im-wb-mgmt-chat")?.textContent ?? ""));
  assert.equal(rootNode.querySelector(".im-wb-mgmt-chat textarea"), null, "patrol is read-only: no composer");
  assert.match(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /只读巡视/);
  assert.match(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /成员已加入会话/, "system notices keep the existing rendering");
  assert.match(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /订单卡片 · 本单确认/, "order cards keep a card-shaped message");
  assert.ok(requests.some((request) => request.path.endsWith("/im/messages?conversationId=conv-c1")), "messages are read through the audit route");

  const takeover = rootNode.querySelector('[data-action="audit-takeover"]');
  assert.ok(takeover && !takeover.disabled, "takeover is available for a consultation");
  await act(async () => takeover.click());
  await waitFor(() => requests.some((request) => request.method === "POST" && request.path.endsWith("/im/audit/consultations/audit-c1/takeover")));
  await waitFor(() => /已接管/.test(rootNode.querySelector(".im-wb-mgmt-chat")?.textContent ?? ""));
  assert.match(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /由你接待/, "ownership follows the successful takeover");
  assert.ok([...rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row")].some((row) => /客服 A/.test(row.textContent)), "the list is refreshed with the new owner");

  const jump = rootNode.querySelector('[data-action="open-consultations"]');
  assert.ok(jump, "a successful takeover offers the consultation workspace");
  await act(async () => jump.click());
  assert.equal(openedWorkbench, true, "the jump hands off to the support workbench");

  // 订单群：可巡视但接管明确后续开放
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 3);
  const orderRow = [...rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row")].find((row) => row.textContent.includes("DD20261029001"));
  await act(async () => orderRow.click());
  await settle();
  assert.equal(rootNode.querySelector('[data-action="audit-takeover"]'), null);
  assert.match(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /订单群接管后续开放/);
  assert.ok(requests.some((request) => request.path.endsWith("/im/messages?conversationId=conv-o1")), "order groups read through type=ORDER");
});

test("patrol filters conversations by type on the server and by customer on the loaded list", async (t) => {
  fixture = baseFixture({ conversations: { items: auditConversations(), nextCursor: null } });
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 3);

  await pickOption(rootNode, "按类型筛选", "订单群");
  await waitFor(() => requests.some((request) => request.path.endsWith("/im/audit/conversations?type=ORDER")));
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  assert.match(rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").textContent, /DD20261029001/);

  await pickOption(rootNode, "按类型筛选", "全部类型");
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 3);
  await pickOption(rootNode, "按客服筛选", "客服 B");
  await waitFor(() => requests.some((request) => request.path.endsWith("/im/audit/conversations?adminUserId=admin-b")));
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 2);
  await pickOption(rootNode, "按客服筛选", "全部客服");
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 3);
  await pickOption(rootNode, "按状态筛选", "已结束");
  await waitFor(() => /当前筛选没有匹配会话/.test(rootNode.textContent));
});

test("patrol reports a failed list read without pretending it is empty", async (t) => {
  fixture = baseFixture({ conversations: { items: auditConversations(), nextCursor: null }, auditStatus: 500 });
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => /会话列表读取失败/.test(rootNode.textContent));
  assert.doesNotMatch(rootNode.textContent, /暂无可巡视会话/, "a failure is not an empty list");
  assert.match(rootNode.textContent, /服务暂时无法完成请求/);
});

/* ------------------------------ 客服工作台 ------------------------------ */

test("today connection time comes from presence and shows — when absent", async (t) => {
  fixture = baseFixture();
  fixture.presence = { ...fixture.presence, today: { seconds: 8100, sessions: 3, users: 2 } };
  const first = await mount(t, {});
  await waitFor(() => first.rootNode.querySelector(".im-wb-today"));
  assert.match(first.rootNode.querySelector(".im-wb-today").textContent, /今日接待 2h 15m/);

  fixture = baseFixture();
  const second = await mount(t, {});
  await waitFor(() => second.rootNode.querySelector(".im-wb-today"));
  assert.match(second.rootNode.querySelector(".im-wb-today").textContent, /今日接待 —/);
});

test("a transfer carries an optional note and confirms it was recorded", async (t) => {
  fixture = baseFixture({ consultations: [activeConsultation] });
  const { rootNode } = await mount(t, {});
  await waitFor(() => rootNode.querySelector(".im-wb-row"));
  await act(async () => rootNode.querySelector('[data-action="open-transfer"]').click());
  await waitFor(() => browser.document.querySelector('[aria-label="转交会话"]'));
  const note = browser.document.querySelector('[aria-label="交接备注（可选）"]');
  assert.ok(note, "the transfer dialog offers an optional note");
  assert.equal(note.getAttribute("maxlength"), "200");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
    setValue.call(note, "午休交接，注意买家已催");
    note.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await settle();
  const target = [...browser.document.querySelectorAll(".im-wb-dialog-list button")].find((button) => button.textContent.includes("客服 B"));
  assert.ok(target, "transfer target is listed");
  await act(async () => target.click());
  await waitFor(() => requests.some((request) => request.method === "POST" && request.path.endsWith("/consultations/c-active/transfer")));
  const transfer = requests.filter((request) => request.method === "POST" && request.path.endsWith("/consultations/c-active/transfer")).at(-1);
  assert.deepEqual(transfer.body, { targetAdminId: "admin-b", note: "午休交接，注意买家已催" });
  await waitFor(() => /已转交，交接备注已记录/.test(rootNode.textContent));
});

test("pausing with unfinished consultations shows the checklist without blocking", async (t) => {
  fixture = baseFixture({ consultations: [activeConsultation] });
  fixture.presence = { ...fixture.presence, availability: "AVAILABLE", connectionState: "CONNECTED" };
  const { rootNode } = await mount(t, {});
  await waitFor(() => rootNode.querySelector(".im-wb-presence-toggle") && rootNode.querySelector(".im-wb-presence-toggle").textContent === "暂停接待");
  const writesBefore = presenceWrites.length;
  await act(async () => rootNode.querySelector(".im-wb-presence-toggle").click());
  await waitFor(() => browser.document.querySelector('[aria-label="暂停接待确认"]'));
  const dialog = browser.document.querySelector('[aria-label="暂停接待确认"]');
  assert.match(dialog.textContent, /还有 1 条未完成咨询/);
  assert.match(dialog.textContent, /用户 A/);
  assert.match(dialog.textContent, /处理中/);
  assert.ok(dialog.querySelector('[data-action="offduty-transfer"]'), "the checklist offers 去交接");
  assert.equal(presenceWrites.length, writesBefore, "opening the checklist does not pause automatically");

  await act(async () => dialog.querySelector('[data-action="offduty-transfer"]').click());
  await waitFor(() => browser.document.querySelector('[aria-label="转交会话"]'));
  assert.ok(requests.some((request) => request.path.includes("/im/transfer-targets?consultationId=c-active")), "去交接 opens the existing transfer flow for that conversation");
  await act(async () => browser.document.querySelector('[aria-label="关闭转交"]').click());
  await settle();

  await act(async () => rootNode.querySelector(".im-wb-presence-toggle").click());
  await waitFor(() => browser.document.querySelector('[aria-label="暂停接待确认"]'));
  await act(async () => browser.document.querySelector('[data-action="confirm-pause-presence"]').click());
  await waitFor(() => presenceWrites.length === writesBefore + 1);
  assert.equal(presenceWrites.at(-1).availability, "OFF_DUTY", "the operator can still pause");
  await settle();
  assert.equal(browser.document.querySelector('[aria-label="暂停接待确认"]'), null);
});

test("heartbeat posts every 60s only while available, connected and visible", async (t) => {
  fixture = baseFixture();
  fixture.presence = { ...fixture.presence, availability: "AVAILABLE", connectionState: "CONNECTED" };
  const { rootNode } = await mount(t, {});
  await waitFor(() => heartbeatTimers().length === 1);
  const beats = () => requests.filter((request) => request.path.endsWith("/im/presence/heartbeat")).length;
  const before = beats();
  await act(async () => { heartbeatTimers()[0].callback(); await Promise.resolve(); });
  await waitFor(() => beats() === before + 1);

  const originalVisibility = Object.getOwnPropertyDescriptor(browser.document, "visibilityState");
  Object.defineProperty(browser.document, "visibilityState", { configurable: true, get: () => "hidden" });
  try {
    await act(async () => { heartbeatTimers()[0].callback(); await Promise.resolve(); });
    await settle();
    assert.equal(beats(), before + 1, "a hidden page does not send heartbeats");
  } finally {
    if (originalVisibility) Object.defineProperty(browser.document, "visibilityState", originalVisibility);
    else Object.defineProperty(browser.document, "visibilityState", { configurable: true, get: () => "visible" });
  }

  await act(async () => rootNode.querySelector(".im-wb-presence-toggle").click());
  await waitFor(() => presenceWrites.at(-1)?.availability === "OFF_DUTY");
  await settle();
  assert.equal(heartbeatTimers().length, 0, "leaving AVAILABLE stops the heartbeat");
});

/* ------------------------------ 纯模型 ------------------------------ */

test("formatting never invents connection time or chart scale", () => {
  assert.equal(model.formatDuration(8100), "2h 15m");
  assert.equal(model.formatDuration(59), "0h 0m");
  assert.equal(model.formatDuration(undefined), "—");
  assert.equal(model.formatDuration(-1), "—");
  assert.equal(model.todaySecondsOf({ today: { seconds: 75 } }), 75);
  assert.equal(model.todaySecondsOf({}), null);
  assert.equal(model.todaySecondsOf({ today: { seconds: -3 } }), null);
  assert.equal(model.barPercent(0, 10), 0);
  assert.equal(model.barPercent(10, 10), 100);
  assert.equal(model.barPercent(1, 100), 4);
  assert.equal(model.formatDayLabel("2026-10-29"), "10/29");
  assert.equal(model.formatDayLabel("bad"), "bad");
  assert.equal(model.hourLabel(9), "09:00");
});

test("overview parsing keeps only valid points and leaves missing totals at zero", () => {
  const parsed = model.parseSupportOverview({
    onDuty: [{ adminUserId: "a", name: "", availability: "PAUSED", connectionState: "CONNECTED", todaySeconds: 60 }],
    trend: [{ date: "2026-10-29", sessions: 2, users: 1 }, { date: "", sessions: 4 }, { sessions: 1 }],
    hourly: [{ hour: 8, sessions: 3 }, { hour: 24, sessions: 9 }, { hour: "9", sessions: 2 }],
  });
  assert.equal(parsed.onDuty[0].name, "未命名客服");
  assert.equal(parsed.onDuty[0].activeLoad, 0);
  assert.equal(parsed.totals.todaySessions, 0);
  assert.equal(parsed.trend.length, 1);
  assert.equal(parsed.hourly.length, 1);
  const slots = model.hourlySlots([{ hour: 8, sessions: 3 }, { hour: 8, sessions: 2 }, { hour: 9, sessions: 1 }]);
  assert.equal(slots.length, 24);
  assert.equal(slots[8].sessions, 5);
  assert.equal(slots[23].sessions, 0);
});

test("audit parsing tolerates missing fields and builds documented query paths", () => {
  const page = model.parseAuditConversations({
    items: [
      { id: "a", type: "SERVICE" },
      { id: "", type: "SERVICE" },
      { id: "b", type: "future", title: "未来类型", adminUserId: "" },
    ],
    nextCursor: "",
  });
  assert.deepEqual(page.items.map((item) => item.id), ["a", "b"]);
  assert.equal(page.items[0].title, "未命名会话");
  assert.equal(page.items[1].type, "UNKNOWN");
  assert.equal(page.nextCursor, null);

  assert.equal(model.auditConversationsPath({ type: "ALL" }), "/im/audit/conversations");
  assert.equal(model.auditConversationsPath({ type: "ORDER", adminUserId: "admin-a", cursor: "c1" }), "/im/audit/conversations?type=ORDER&adminUserId=admin-a&cursor=c1");
  assert.equal(model.auditMessagesPath("conv-c1"), "/im/messages?conversationId=conv-c1");
  assert.equal(model.auditMessageType("ORDER"), "ORDER");
  assert.equal(model.auditMessageType("COMPLAINT"), "CONSULTATION");

  const messages = model.parseAuditMessages({
    messages: [
      { senderId: "u1", createTime: 100, text: "hi" },
      { senderId: "", createTime: 100 },
      { senderId: "u2", createTime: "bad" },
      { senderId: "u3", createTime: 200, card: { kind: "ORDER_OPENING", orderId: "o1", cardId: "c1" } },
    ],
  });
  assert.equal(messages.messages.length, 2);
  assert.equal(messages.messages[0].messageClientId, "u1-100");
  assert.equal(messages.messages[1].card.kind, "ORDER_OPENING");
});

test("time filters use Beijing calendar boundaries", () => {
  const now = new Date("2026-10-29T04:00:00.000Z");
  assert.equal(model.withinTimeFilter(null, "all", now), true);
  assert.equal(model.withinTimeFilter(null, "today", now), false);
  assert.equal(model.withinTimeFilter("2026-10-29T01:00:00.000Z", "today", now), true);
  assert.equal(model.withinTimeFilter("2026-10-28T15:00:00.000Z", "today", now), false, "before Beijing midnight");
  assert.equal(model.withinTimeFilter("2026-10-28T23:00:00.000Z", "7d", now), true);});
