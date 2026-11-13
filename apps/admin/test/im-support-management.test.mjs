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

// 只拦截 30 秒心跳，其余定时器保持真实行为（测试卸载时会清理）。
const intervalCallbacks = [];
const realSetInterval = browser.setInterval.bind(browser);
const realClearInterval = browser.clearInterval.bind(browser);
let intervalId = 0;
browser.setInterval = (callback, delay) => {
  if (delay === 30_000) {
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
const heartbeatTimers = () => intervalCallbacks.filter((entry) => entry.active && entry.delay === 30_000);

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { ImSupportView } = await vite.ssrLoadModule("/src/views/im-support-view.tsx");
const { SupportManagementPane, SupportPatrol } = await vite.ssrLoadModule("/src/views/im-support-management.tsx");
const { SupportAssistantSettings } = await vite.ssrLoadModule("/src/views/im-support-settings.tsx");
const { canOpenKind } = await vite.ssrLoadModule("/src/workspace/tab-model.ts");
const { workspaceMenuItems } = await vite.ssrLoadModule("/src/workspace/nav-config.ts");
const model = await vite.ssrLoadModule("/src/views/im-support-management-model.ts");
const { adminRequest } = await vite.ssrLoadModule("/src/api.ts");
after(async () => { await vite.close(); });

test("assistant settings show saved content, preserve edits across tabs and reuse the operation on an uncertain save",async(t)=>{
  const host=browser.document.createElement("div");browser.document.body.append(host);const root=createRoot(host),writes=[];
  t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  let fail=true;const saved={version:0,serviceMessage:"默认欢迎",complaintMessage:"请描述问题",updatedAt:null};
  const request=async(path,body,method)=>{assert.equal(path,"/im/support-settings");if(!body)return saved;writes.push({body,method});if(fail)throw Error("保存结果尚未确认");return {...body,version:1,updatedAt:"2026-10-31T04:00:00Z"};};
  const render=async(active,canConfigure=true)=>{await act(async()=>root.render(createElement(SupportAssistantSettings,{active,request,canConfigure})));await settle();};
  const group=label=>[...host.querySelectorAll("nav button")].find(button=>button.textContent.includes(label));
  await render(true);
  assert.equal(host.querySelectorAll("textarea").length,2,"settings open directly on the welcome editors");
  await act(async()=>group("咨询开场").click());await settle();
  const textarea=host.querySelector("textarea"),setValue=Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,"value").set;
  await act(async()=>{setValue.call(textarea,"修改后的欢迎\n请留言");textarea.dispatchEvent(new browser.Event("input",{bubbles:true}));});
  await render(false);await render(true);assert.equal(host.querySelector("textarea").value,"修改后的欢迎\n请留言");
  const save=()=>[...host.querySelectorAll("button")].find(button=>button.textContent==="保存欢迎消息");
  await act(async()=>save().click());await settle();assert.match(host.textContent,/操作未完成，请重试/);
  fail=false;await act(async()=>save().click());await settle();assert.match(host.textContent,/已保存。仅对之后新建的咨询轮次生效/);
  assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].method,"PUT");assert.equal(writes[0].body.serviceMessage,"修改后的欢迎\n请留言");
  await render(true,false);assert.equal(host.querySelector("textarea").disabled,true);assert.equal(save().disabled,true);assert.match(host.textContent,/当前可以查看/);
});

test("actual management tabs preserve the assistant draft and report it to the workspace close guard",async(t)=>{
  const host=browser.document.createElement("div");browser.document.body.append(host);const root=createRoot(host),dirty=[];
  t.after(async()=>{await act(async()=>root.unmount());host.remove();assert.equal(dirty.at(-1),false);});
  const request=async(path,body)=>path==="/im/support-settings"?body?{...body,version:1,updatedAt:null}:{version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null}:path.includes("handovers")?{items:[]}:overview();
  const report=value=>dirty.push(value);
  await act(async()=>root.render(createElement(SupportManagementPane,{active:true,request,canTakeover:false,canConfigure:true,currentAdminUserId:"admin-a",currentAdminName:"客服 A",onDirtyChange:report})));
  const tab=label=>[...host.querySelectorAll('[role="tab"]')].find(e=>e.textContent===label);
  await act(async()=>tab("助手设置").click());await settle();
  const group=label=>[...host.querySelectorAll("nav button")].find(button=>button.textContent.includes(label));
  await act(async()=>group("咨询开场").click());await settle();
  const textarea=host.querySelector("textarea"),setValue=Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,"value").set;
  await act(async()=>{setValue.call(textarea,"保留草稿");textarea.dispatchEvent(new browser.Event("input",{bubbles:true}));});assert.equal(dirty.at(-1),true);
  await act(async()=>tab("看板").click());await act(async()=>tab("助手设置").click());await settle();assert.equal(host.querySelector("textarea").value,"保留草稿");assert.equal(dirty.at(-1),true);
  await act(async()=>[...host.querySelectorAll("button")].find(e=>e.textContent==="保存欢迎消息").click());await settle();assert.equal(dirty.at(-1),false);
  assert.match(readFileSync(path.join(adminRoot,"src/workspace/page-content.tsx"),"utf8"),/SupportManagementPane[^\n]+onDirtyChange=\{onDirtyChange\}/);
});

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
  reportDate: "2026-10-29",
  serverNow: "2026-10-29T04:00:00.000Z",
  period: { dateFrom: "2026-10-29", dateTo: "2026-10-29", days: 1, timeZone: "Asia/Shanghai", trendFrom: "2026-10-23", trendTo: "2026-10-29" },
  onDuty: [],
  totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 0, todayUsers: 0 },
  trend: [],
  hourly: [],
  ratings: { count: 0, average: null, distribution: [0, 0, 0, 0, 0], agents: [] },
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
    messagePages: null,
    messageByConversation: null,
    rounds: null,
    orderAccess: null,
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
  if (pathname.endsWith("/im/presence/connect")) return json({ ok: true, reason: "CLAIMED", version: fixture.presence.version, stateRevision: 1 });
  if (pathname.endsWith("/im/presence/heartbeat")) return json({
    ok: true, dispatchable: true, reason: null, disconnectedSince: null, dispatchPaused: false,
    stateRevision: 1, today: { seconds: 0, sessions: 0, users: 0 },
    serverTime: "2026-11-12T00:00:00.000000Z",
  });
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
  if (/\/im\/consultations\/[^/]+\/read$/.test(pathname)) return json({ adminReadAt: "2026-10-29T02:05:00.000Z" });
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
  if (/\/im\/consultations\/[^/]+\/rounds$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split("/").at(-2) ?? "");
    return json(fixture.rounds?.[id] ?? { contractVersion: "admin-consultation-rounds.v1", consultationId: id, rounds: [], nextCursor: null });
  }
  if (pathname.includes("/im/audit/consultations/") && pathname.endsWith("/takeover")) {
    if (fixture.takeoverStatus !== 200) return failure(fixture.takeoverStatus);
    const id = decodeURIComponent(pathname.split("/").at(-2) ?? "");
    fixture.conversations.items = fixture.conversations.items.map((item) => (item.id === id ? { ...item, adminUserId: "admin-a", adminName: "客服 A" } : item));
    return json({ ok: true });
  }
  if (pathname.endsWith("/im/transfer-targets")) return json(fixture.transferTargets);
  if (pathname.endsWith("/transfer")) return json({ consultation: { ...(fixture.consultations[0] ?? activeConsultation), assignedAdmin: { id: "admin-b", name: "客服 B" } } });
  if (pathname.includes("/im/message-access")) return json({ authorized: true });
  const orderAccessMatch = /\/orders\/([^/]+)\/im$/.exec(pathname);
  if (orderAccessMatch) {
    const id = decodeURIComponent(orderAccessMatch[1] ?? "");
    const value = fixture.orderAccess?.[id];
    return value ? json(value) : failure(404);
  }
  if (pathname.includes("/im/messages")) {
    const cid = url.searchParams.get("conversationId");
    if (fixture.messageByConversation && cid && cid in fixture.messageByConversation) {
      const value = await fixture.messageByConversation[cid];
      return value instanceof browser.Response ? value : json(value);
    }
    if (fixture.messagePages) {
      const page = fixture.messagePages[url.searchParams.get("cursor") ?? ""];
      if (page === undefined) return failure(500);
      const value = typeof page === "function" ? await page(url) : page;
      return value instanceof browser.Response ? value : json(value);
    }
    return json(fixture.messages.messages.length ? fixture.messages : { messages: fixture.history, nextCursor: null });
  }
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

for (const state of ["KICKED", "AUTH_FAILED"]) {
  test(`initial ${state} login failure follows its bounded terminal policy`, async (t) => {
    const { ImClientLifecycle } = await vite.ssrLoadModule("@zzsh/im-client/lifecycle");
    const { NimLoginTerminalError } = await vite.ssrLoadModule("@zzsh/im-client/nim-web-client");
    const originalOpen = ImClientLifecycle.prototype.open;
    const originalTimeout = browser.setTimeout;
    const originalClearTimeout = browser.clearTimeout;
    const retryTimers = [];
    let calls = 0;
    ImClientLifecycle.prototype.open = async () => { calls += 1; throw new NimLoginTerminalError(state, new Error("sensitive fixture")); };
    browser.setTimeout = (callback, delay, ...args) => {
      if ([3000, 5000, 10000, 15000, 30000, 60000].includes(delay)) { retryTimers.push(delay); return -retryTimers.length; }
      return originalTimeout.call(browser, callback, delay, ...args);
    };
    browser.clearTimeout = id => { if (typeof id !== "number" || id >= 0) originalClearTimeout.call(browser, id); };
    t.after(() => { ImClientLifecycle.prototype.open = originalOpen; browser.setTimeout = originalTimeout; browser.clearTimeout = originalClearTimeout; });
    requests.length = 0;
    fixture = baseFixture({ presence: { adminUserId: "admin-a", availability: "AVAILABLE", connectionState: "CONNECTED", activeLoad: 0, version: 1, stateRevision: 1, ownedByAnotherSession: false, unbound: false } });
    const { rootNode } = await mount(t);
    await waitFor(() => calls === 1 && rootNode.querySelector(".im-wb-runtime-state")?.textContent.includes(state === "KICKED" ? "被踢" : "认证失败"));
    if (state === "AUTH_FAILED") {
      await act(async () => browser.dispatchEvent(new browser.Event("online")));
      await waitFor(() => calls === 2);
      await act(async () => browser.dispatchEvent(new browser.Event("online")));
      await waitFor(() => calls === 3);
      await waitFor(() => rootNode.querySelector(".im-wb-runtime-state")?.textContent.includes("认证失败"));
      assert.equal(calls, 3, "AUTH_FAILED retries twice before reporting the terminal state");
      assert.deepEqual(retryTimers, [5000, 15000], "the two retries use bounded backoff");
    } else {
      await act(async () => browser.dispatchEvent(new browser.Event("online")));
      await settle();
      assert.equal(calls, 1, "KICKED must never reopen automatically");
      assert.deepEqual(retryTimers, [], "KICKED must not schedule a retry");
    }
    await waitFor(() => requests.some(request => request.path.endsWith("/im/presence/heartbeat")));
    assert(!rootNode.querySelector(".im-wb-runtime-state").textContent.includes("可接待"));
    assert(requests.filter(request => request.path.endsWith("/im/presence/heartbeat")).every(request => request.body.connectionState === state));
    assert(!rootNode.textContent.includes("sensitive fixture"));
  });
}

test("a terminal failure from the previous workbench identity does not report presence", async (t) => {
  const { ImClientLifecycle } = await vite.ssrLoadModule("@zzsh/im-client/lifecycle");
  const { NimLoginTerminalError } = await vite.ssrLoadModule("@zzsh/im-client/nim-web-client");
  const originalOpen = ImClientLifecycle.prototype.open;
  let rejectOld;
  const started = [];
  ImClientLifecycle.prototype.open = identity => {
    started.push(identity);
    return new Promise((_resolve, reject) => { if (identity === "admin-a") rejectOld = reject; });
  };
  t.after(() => { ImClientLifecycle.prototype.open = originalOpen; });
  requests.length = 0;
  fixture = baseFixture();
  const { rootNode, root } = await mount(t);
  await waitFor(() => started.includes("admin-a"));
  const next = { ...snapshot(basePermissions), adminUserId: "admin-b", session: { ...snapshot(basePermissions).session, id: "session-b" } };
  await act(async () => root.render(createElement(ImSupportView, { snapshot: next, onRefresh: async () => next })));
  await waitFor(() => started.includes("admin-b"));
  await act(async () => rejectOld(new NimLoginTerminalError("KICKED", new Error("old fixture"))));
  await settle();
  assert(!rootNode.textContent.includes("被踢下线"));
  assert(!requests.some(request => request.path.endsWith("/im/presence/heartbeat") && request.body.connectionState === "KICKED"));
});

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

async function mountPatrol(t, request, props = {}) {
  const host = browser.document.createElement("div");
  host.className = "workspace-root";
  browser.document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(createElement(SupportPatrol, { active: true, request, ...props })));
  await waitFor(() => host.querySelector(".im-wb-row"));
  return { host, root };
}
function patrolDeferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}
async function clickNode(node) {
  assert.ok(node, "click target exists");
  await act(async () => node.click());
  await settle();
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
  assert.ok(workspaceMenuItems(allowed).some((item) => item.kind === "support-overview" && item.label === "客服统计"), "the permission opens the nav item");
  const boss = { isBoss: true, permissions: basePermissions };
  assert.equal(canOpenKind("support-management", boss), true);
  assert.ok(workspaceMenuItems(boss).some((item) => item.kind === "support-overview"), "boss gets it without the explicit permission");
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

  assert.equal(rootNode.querySelector('[data-panel="handovers"]'), null, "handover card is removed");
  assert.equal(rootNode.querySelector('[data-panel="handover-summary"]'), null, "handover summary is removed");
  assert.ok(requests.some((request) => request.path.includes("/im/support-overview")), "dashboard reads the overview endpoint");
});

test("empty dashboard says 暂无数据 instead of drawing invented values", async (t) => {
  fixture = baseFixture();
  const { rootNode } = await mountManagement(t);
  await openManagement(rootNode);
  await waitFor(() => rootNode.querySelector(".im-wb-mgmt-totals"));
  assert.deepEqual([...rootNode.querySelectorAll(".im-wb-mgmt-metric-value")].map((node) => node.textContent), ["0", "0", "0", "0"]);
  assert.match(rootNode.textContent, /暂无客服记录/);
  assert.equal(rootNode.querySelectorAll(".im-wb-mgmt-chart-empty").length, 2, "only trend and hourly show compact empty plots; empty comparison charts are omitted");
  assert.equal(rootNode.querySelectorAll(".im-wb-mgmt-bar").length, 0, "no bar is painted without data");

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

test("dashboard manual refresh re-reads overview", async (t) => {
  fixture = baseFixture();
  const { rootNode } = await mountManagement(t);
  await openManagement(rootNode);
  await waitFor(() => rootNode.querySelector('[data-action="refresh-dashboard"]'));
  const before = requests.filter((request) => request.path.includes("/im/support-overview")).length;
  fixture.overview = overview({ totals: { onDutyCount: 2, waitingConsultations: 1, todaySessions: 8, todayUsers: 6 } });
  await act(async () => rootNode.querySelector('[data-action="refresh-dashboard"]').click());
  await waitFor(() => [...rootNode.querySelectorAll(".im-wb-mgmt-metric-value")].some((node) => node.textContent === "8"));
  const after = requests.filter((request) => request.path.includes("/im/support-overview")).length;
  assert.ok(after > before, "manual refresh reloads dashboard source");
});

/* ------------------------------ 巡视 ------------------------------ */

const auditConversations = () => [
  { id: "audit-c1", type: "SERVICE", title: "用户甲 · 平台咨询", userName: "用户甲", adminUserId: "admin-b", adminName: "客服 B", state: "ACTIVE", lastMessageAt: "2026-10-29T02:00:00.000Z", conversationId: "conv-c1", displayNo: null, gameName: null, historyState: "AVAILABLE" },
  { id: "audit-o1", type: "ORDER", title: "订单群 20261029", userName: "", adminUserId: "admin-b", adminName: "客服 B", state: "ACTIVE", lastMessageAt: "2026-10-29T02:30:00.000Z", conversationId: "conv-o1", displayNo: "DD20261029001", gameName: "三角洲行动" },
  { id: "audit-c2", type: "COMPLAINT", title: "用户乙 · 投诉反馈", userName: "用户乙", adminUserId: null, adminName: "未分配", state: "WAITING", lastMessageAt: "2026-10-29T03:00:00.000Z", conversationId: "conv-c2", displayNo: null, gameName: null, historyState: "AVAILABLE" },
];

test("patrol lists conversations and opens only a read-only shared transcript", async (t) => {
  requests.length = 0;
  let openedWorkbench = false;
  fixture = baseFixture({ conversations: { items: auditConversations(), nextCursor: null } });
  fixture.messages = {
    messages: [
      { messageClientId: "m-1", messageServerId: "m-1", conversationId: "conv-c1", senderId: "user-1", receiverId: "admin-b", createTime: Date.parse("2026-10-29T01:59:00.000Z"), messageType: 0, text: "请问订单什么时候发货", sender: {displayName:"用户甲",avatar:null,role:"USER"} },
      { messageClientId: "m-2", messageServerId: "m-2", conversationId: "conv-c1", senderId: "admin-b", receiverId: "user-1", createTime: Date.parse("2026-10-29T02:00:00.000Z"), messageType: 0, text: "正在为你核对", sender: {displayName:"客服 B",avatar:null,role:"ADMIN"} },
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
  assert.match(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /客服已接入/, "support notices use the workbench wording");
  assert.match(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /开租确认/, "order stages keep a read-only summary");
  assert.ok(requests.some((request) => request.path.endsWith("/im/messages?conversationId=conv-c1&mode=patrol")), "messages are read through the audit route");
  await settle();
  assert.equal(rootNode.querySelector('[data-slot="conversation-map"]'), null, "zero rounds has no rail");
  assert.equal(rootNode.querySelector(".im-wb-patrol-rounds"), null, "zero rounds has no top round bar");

  const takeover = rootNode.querySelector('[data-action="audit-takeover"]');
  assert.equal(takeover, null, "takeover button is removed per owner decision");
  assert.equal(requests.every(request => request.method === "GET"), true, "patrol cannot write or establish an IM connection");
  assert.equal(requests.some(request => request.path.endsWith("/im/token") || request.path.includes("/presence")), false);
  assert.equal(rootNode.querySelector(".im-wb-composer-readonly"), null);
  assert.match(rootNode.textContent, /只读巡视/);
  // 订单群：可巡视但接管明确后续开放
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 3);
  const orderRow = [...rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row")].find((row) => row.textContent.includes("DD20261029001"));
  await act(async () => orderRow.click());
  await settle();
  assert.equal(rootNode.querySelector('[data-action="audit-takeover"]'), null);
  assert.match(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /只读巡视/);
  assert.match(rootNode.querySelector(".im-wb-chat-title").textContent, /整条订单群历史/);
  assert.equal(rootNode.querySelector('[data-slot="conversation-map"]'), null, "order groups have no round rail");
  assert.ok(requests.some((request) => request.path.endsWith("/im/messages?conversationId=conv-o1&mode=patrol")), "order groups read through type=ORDER");
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

const patrolConversation = (id, overrides = {}) => ({
  id, type: "SERVICE", title: "用户甲", userName: "用户甲", adminUserId: "admin-b", adminName: "客服 B",
  state: "ACTIVE", lastMessageAt: "2026-10-29T02:00:00.000Z", conversationId: `conv-${id}`, displayNo: null, gameName: null,
  historyState: "AVAILABLE",
  ...overrides,
});
const patrolMessage = (id, senderId, text, createTime, extra = {}) => ({
  messageClientId: `client-${id}`, messageServerId: id, conversationId: "conv-identity",
  senderId, receiverId: "admin-b", createTime, messageType: 0, text, ...extra,
});
const msgNode = (rootNode, id) => rootNode.querySelector(`.im-wb-msg[data-message-id="${id}"]`);
const roundsPage = (consultationId, rounds) => ({ contractVersion: "admin-consultation-rounds.v1", consultationId, rounds, nextCursor: null });
const auditRound = (id, roundSeq, state, name, conversationId, createdAt = "2026-10-29T01:00:00.000Z", closedAt = state === "CLOSED" ? new Date(Date.parse(createdAt) + 3_600_000).toISOString() : null) => ({
  id, roundSeq: String(roundSeq), state, assignedAdmin: name ? { name } : null, conversationId,
  createdAt, updatedAt: "2026-10-29T02:00:00.000Z", lastMessageAt: null,
  closedAt, transferCount: "0",
});
function spyPatrolScroll(t) {
  const calls = [];
  const proto = browser.HTMLElement.prototype;
  const original = proto.scrollIntoView;
  proto.scrollIntoView = function (options) { calls.push({ element: this, options }); };
  t.after(() => {
    if (original) proto.scrollIntoView = original;
    else delete proto.scrollIntoView;
  });
  return calls;
}
const mapTick = (rootNode, seq) => [...rootNode.querySelectorAll('[data-slot="conversation-map-tick"]')]
  .find((tick) => (tick.getAttribute("aria-label") ?? "").startsWith(`第 ${seq} 轮 ·`));
async function clickMapTick(rootNode, seq) {
  const tick = mapTick(rootNode, seq);
  assert.ok(tick, `round ${seq} map tick exists`);
  await act(async () => tick.click());
  await settle();
}

test("patrol loads the whole thread and round switches only jump within it", async (t) => {
  const scrolls = spyPatrolScroll(t);
  fixture = baseFixture({
    conversations: { items: [patrolConversation("rounds", { roundSeq: 2, roundCount: 2, conversationId: "conv-thread" })], nextCursor: null },
    rounds: { rounds: roundsPage("rounds", [
      auditRound("rounds", 2, "ACTIVE", "客服 B", "conv-thread", "2026-10-29T02:00:00.000Z"),
      auditRound("round-old", 1, "CLOSED", "客服 A", "conv-thread", "2026-10-29T01:00:00.000Z"),
    ]) },
    messageByConversation: {
      "conv-thread": { messages: [
        patrolMessage("round-notice", "system", "", Date.parse("2026-10-29T01:05:00.000Z"), { conversationId: "conv-thread", messageType: 5, attachment: { type: 0 } }),
        patrolMessage("old", "user-1", "旧轮次消息", Date.parse("2026-10-29T01:30:00.000Z"), { conversationId: "conv-thread" }),
        patrolMessage("latest", "user-1", "最近一轮消息", Date.parse("2026-10-29T02:30:00.000Z"), { conversationId: "conv-thread" }),
      ], nextCursor: null },
    },
  });
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => rootNode.querySelector('[data-slot="conversation-map"]'));
  assert.ok(requests.some((request) => request.path.endsWith("/im/consultations/rounds/rounds?limit=20")), "rounds reuse the existing ledger endpoint");
  await waitFor(() => rootNode.textContent.includes("旧轮次消息") && rootNode.textContent.includes("最近一轮消息"));
  const header = rootNode.querySelector(".im-wb-chat-title span").textContent;
  assert.match(header, /整条线程历史（共 2 轮）/, "the header keeps the whole-thread context");
  assert.doesNotMatch(header, /最近第|正在查看第 2 轮历史/, "the round is not repeated as a second status");
  assert.equal(rootNode.querySelector(".im-wb-patrol-rounds"), null, "there is no top filter-like round bar");
  const map = rootNode.querySelector('[data-slot="conversation-map"]');
  const stream = rootNode.querySelector(".im-wb-patrol-stream");
  const viewportShell = stream.querySelector(".im-wb-stream-wrap");
  assert.equal(map.parentElement, stream, "the assistant-ui map shares the message viewport container");
  assert.equal(viewportShell.parentElement, stream, "the message viewport is the rail's sibling, not the chat section");
  assert.ok(viewportShell.querySelector(".im-wb-mgmt-viewport"), "the rail container also holds the scrolling viewport");
  const ticks = [...rootNode.querySelectorAll('[data-slot="conversation-map-tick"]')];
  assert.equal(ticks.length, 2, "one tick per loaded round");
  assert.deepEqual(ticks.map((tick) => tick.getAttribute("aria-label")), [
    "第 1 轮 · 已结束 · 客服 A",
    "第 2 轮 · 处理中 · 客服 B",
  ], "ticks run oldest to newest and name the assignee and state");
  assert.equal(ticks[1].getAttribute("aria-current"), "true", "the newest round is active by default");
  assert.equal(ticks[1].getAttribute("data-active"), "", "the component exposes its own active hook");
  assert.equal(rootNode.querySelectorAll("[data-round-marker]").length, 0, "the message stream has no round separators");

  const before = requests.filter((request) => request.path.includes("/im/messages")).length;
  await clickMapTick(rootNode, 1);
  assert.equal(requests.filter((request) => request.path.includes("/im/messages")).length, before, "switching rounds does not refetch history");
  assert.match(rootNode.textContent, /最近一轮消息/, "the rest of the thread stays visible");
  assert.equal(mapTick(rootNode, 1).getAttribute("aria-current"), "true", "the clicked tick becomes active");
  await waitFor(() => msgNode(rootNode, "old")?.classList.contains("im-wb-patrol-round-target"), "the first ordinary message of the round is highlighted");
  const scrollCall = scrolls.find((call) => call.element.dataset.messageId === "old" && call.options?.block === "center");
  assert.ok(scrollCall, "the round bubble is scrolled into view");
  assert.equal(scrollCall.element.classList.contains("im-wb-msg"), false, "the Item wrapper is the scroll target");
  assert.ok(scrollCall.element.contains(msgNode(rootNode, "old")), "the highlighted bubble belongs to the scrolled item");
  assert.equal(scrolls.some((call) => call.element.dataset.messageId === "round-notice"), false, "the notice is skipped as a jump target");
});

test("scrolling the transcript only moves the rail active tick", async (t) => {
  const scrolls = spyPatrolScroll(t);
  fixture = baseFixture({
    conversations: { items: [patrolConversation("sync", { roundSeq: 2, roundCount: 2, conversationId: "conv-sync" })], nextCursor: null },
    rounds: { sync: roundsPage("sync", [
      auditRound("sync-2", 2, "ACTIVE", "客服 B", "conv-sync", "2026-10-29T02:00:00.000Z"),
      auditRound("sync-1", 1, "CLOSED", "客服 A", "conv-sync", "2026-10-29T01:00:00.000Z"),
    ]) },
    messageByConversation: {
      "conv-sync": { messages: [
        patrolMessage("older", "user-1", "上一轮消息", Date.parse("2026-10-29T01:30:00.000Z"), { conversationId: "conv-sync" }),
        patrolMessage("newer", "user-1", "最近一轮消息", Date.parse("2026-10-29T02:30:00.000Z"), { conversationId: "conv-sync" }),
      ], nextCursor: null },
    },
  });
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => rootNode.querySelectorAll('[data-slot="conversation-map-tick"]').length === 2);
  assert.equal(mapTick(rootNode, 2).getAttribute("aria-current"), "true", "the newest round starts active");

  const viewport = rootNode.querySelector(".im-wb-viewport");
  const rectAt = (top, bottom) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
  Object.defineProperty(viewport, "getBoundingClientRect", { configurable: true, value: () => rectAt(100, 500) });
  const setMessageRect = (id, top, bottom) => {
    for (const node of rootNode.querySelectorAll(`[data-message-id="${id}"]`)) {
      Object.defineProperty(node, "getBoundingClientRect", { configurable: true, value: () => rectAt(top, bottom) });
    }
  };
  setMessageRect("older", 140, 180);
  setMessageRect("newer", 600, 640);
  await act(async () => viewport.dispatchEvent(new browser.Event("scroll", { bubbles: true })));
  await waitFor(() => mapTick(rootNode, 1).getAttribute("aria-current") === "true", "the visible earlier round becomes active");
  assert.equal(mapTick(rootNode, 2).getAttribute("aria-current"), null);

  setMessageRect("older", -100, -60);
  setMessageRect("newer", 200, 240);
  await act(async () => viewport.dispatchEvent(new browser.Event("scroll", { bubbles: true })));
  await waitFor(() => mapTick(rootNode, 2).getAttribute("aria-current") === "true", "scrolling back activates the newest round");
  assert.equal(scrolls.length, 0, "scroll sync never triggers a jump");
});

test("round windows look back before the round row was created", async (t) => {
  const scrolls = spyPatrolScroll(t);
  const round1At = Date.parse("2026-11-10T01:39:10.000Z");
  const round2At = Date.parse("2026-11-10T04:31:38.869Z");
  const round3At = Date.parse("2026-11-10T06:49:48.966Z");
  fixture = baseFixture({
    conversations: { items: [patrolConversation("rounds-real", { roundSeq: 3, roundCount: 3, conversationId: "conv-real" })], nextCursor: null },
    rounds: { "rounds-real": roundsPage("rounds-real", [
      auditRound("round-3", 3, "ACTIVE", "客服 C", "conv-real", new Date(round3At).toISOString()),
      auditRound("round-2", 2, "CLOSED", "客服 B", "conv-real", new Date(round2At).toISOString()),
      auditRound("round-1", 1, "CLOSED", "客服 A", "conv-real", new Date(round1At).toISOString()),
    ]) },
    messageByConversation: {
      "conv-real": { messages: [
        patrolMessage("m1", "user-1", "123131", round1At - 1_300, { conversationId: "conv-real" }),
        patrolMessage("m2", "admin-b", "", round2At - 1_117, { conversationId: "conv-real", card: { kind: "ORDER_OPENING", orderId: "o-1", cardId: "card-1" } }),
        patrolMessage("m3", "user-1", "2321313", round3At - 1_312, { conversationId: "conv-real" }),
      ], nextCursor: null },
    },
  });
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => rootNode.querySelector('[data-slot="conversation-map"]'));
  await waitFor(() => rootNode.textContent.includes("2321313"));
  const hint = () => rootNode.querySelector('.im-wb-patrol-round-note[role="status"]')?.textContent ?? "";
  const highlighted = (id) => msgNode(rootNode, id)?.classList.contains("im-wb-patrol-round-target") === true;
  assert.equal(rootNode.querySelectorAll('[data-slot="conversation-map-tick"]').length, 3, "the rail lists all three rounds");

  await clickMapTick(rootNode, 1);
  await waitFor(() => highlighted("m1"), "round 1 locates its earlier trigger message");
  assert.equal(hint(), "", "round 1 is an exact match, not a nearest fallback");

  await clickMapTick(rootNode, 2);
  await waitFor(() => highlighted("m2"), "round 2 locates the associated order card, not the next round's trigger");
  assert.equal(highlighted("m3"), false, "the next round's trigger never crosses into round 2");
  assert.equal(hint(), "", "round 2 is an exact match");

  await clickMapTick(rootNode, 3);
  await waitFor(() => highlighted("m3"), "round 3 locates its own trigger message");
  assert.equal(highlighted("m2"), false);
  assert.equal(hint(), "", "round 3 is an exact match");
  assert.ok(scrolls.some((call) => call.element.dataset.messageId === "m2" && call.options?.block === "center"), "round 2 scrolled its own card");
});

test("patrol supplements distinct round Teams, merges and deduplicates them", async (t) => {
  fixture = baseFixture({
    conversations: { items: [patrolConversation("rounds", { roundSeq: 2, roundCount: 2, conversationId: "conv-latest" })], nextCursor: null },
    rounds: { rounds: roundsPage("rounds", [
      auditRound("rounds", 2, "ACTIVE", "客服 B", "conv-latest", "2026-10-29T02:00:00.000Z"),
      auditRound("round-old", 1, "CLOSED", "客服 A", "conv-old", "2026-10-29T01:00:00.000Z"),
    ]) },
    messageByConversation: {
      "conv-latest": { messages: [
        patrolMessage("shared", "user-1", "跨轮重复消息", Date.parse("2026-10-29T02:30:00.000Z"), { conversationId: "conv-latest" }),
        patrolMessage("latest", "user-1", "最近一轮消息", Date.parse("2026-10-29T02:40:00.000Z"), { conversationId: "conv-latest" }),
      ], nextCursor: null },
      "conv-old": { messages: [
        patrolMessage("old", "user-1", "旧轮次消息", Date.parse("2026-10-29T01:30:00.000Z"), { conversationId: "conv-old" }),
        patrolMessage("shared", "user-1", "跨轮重复消息", Date.parse("2026-10-29T02:30:00.000Z"), { conversationId: "conv-old" }),
      ], nextCursor: null },
    },
  });
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => rootNode.textContent.includes("旧轮次消息"));
  assert.match(rootNode.textContent, /最近一轮消息/);
  assert.equal(rootNode.querySelectorAll('.im-wb-msg[data-message-id="shared"]').length, 1, "the same message from both Teams renders once");
  assert.ok(requests.some((request) => request.path.endsWith("/im/messages?conversationId=conv-latest&mode=patrol")));
  assert.ok(requests.some((request) => request.path.endsWith("/im/messages?conversationId=conv-old&mode=patrol")), "a different round Team is read as a supplement");
  assert.equal(rootNode.querySelectorAll('[data-slot="conversation-map-tick"]').length, 2, "merged Teams keep one tick per round");
  await clickMapTick(rootNode, 1);
  await waitFor(() => msgNode(rootNode, "old")?.classList.contains("im-wb-patrol-round-target"));
});

test("a round without its own conversation never blocks readable thread history", async (t) => {
  const scrolls = spyPatrolScroll(t);
  fixture = baseFixture({
    conversations: { items: [patrolConversation("rounds", { roundSeq: 2, roundCount: 2, conversationId: "conv-latest" })], nextCursor: null },
    rounds: { rounds: roundsPage("rounds", [
      auditRound("rounds", 2, "ACTIVE", "客服 B", "conv-latest", "2026-10-29T02:00:00.000Z"),
      auditRound("round-old", 1, "CLOSED", "客服 A", null, "2026-10-29T01:00:00.000Z"),
    ]) },
    messageByConversation: {
      "conv-latest": { messages: [
        patrolMessage("round-notice", "system", "", Date.parse("2026-10-29T01:30:00.000Z"), { conversationId: "conv-latest", messageType: 5, attachment: { type: 0 } }),
        patrolMessage("latest", "user-1", "最近一轮消息", Date.parse("2026-10-29T02:30:00.000Z"), { conversationId: "conv-latest" }),
      ], nextCursor: null },
    },
  });
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => rootNode.textContent.includes("最近一轮消息"));
  const before = requests.length;
  await clickMapTick(rootNode, 1);
  assert.doesNotMatch(rootNode.textContent, /该轮无独立聊天记录\/历史不可用/, "the whole thread is still readable");
  assert.match(rootNode.textContent, /最近一轮消息/);
  assert.match(rootNode.querySelector('.im-wb-patrol-round-note[role="status"]').textContent, /第 1 轮没有普通消息，已跳到最近一条/);
  assert.equal(requests.slice(before).some((request) => request.path.includes("conversationId=conv-old")), false, "a null round sends no history request");
  await waitFor(() => msgNode(rootNode, "latest")?.classList.contains("im-wb-patrol-round-target"));
  assert.ok(scrolls.some((call) => call.element.dataset.messageId === "latest" && call.options?.block === "center"), "the nearest ordinary message is scrolled into view");
  assert.equal(scrolls.some((call) => call.element.dataset.messageId === "round-notice"), false, "a notice-only window does not become the jump target");
});

test("assistant actor and session hosts remount without moving an UNKNOWN or late save into another scope", async t => {
  const source = readFileSync(path.join(adminRoot, "src/workspace/page-content.tsx"), "utf8");
  for (const component of ["SupportAssistantSettings", "SupportManagementPane"]) assert.ok(source.includes(`${component} key={[tab.id,snapshot.adminUserId,snapshot.session.id].join("|")}`));
  for (const unknown of [true, false]) {
    const host = browser.document.createElement("div"); browser.document.body.append(host); const root = createRoot(host);
    t.after(async () => { await act(async () => root.unmount()); host.remove(); });
    const pending = patrolDeferred(); let bWrites = 0; const bLocks = [];
    const aRequest = async (path, body) => {
      if (path === "/im/support-settings") return { version: 0, serviceMessage: "欢迎", complaintMessage: "请留言", updatedAt: null };
      if (!body) return readCopyFixture();
      if (unknown) throw { status: 0 };
      return pending.promise;
    };
    const bRequest = async (path, body) => {
      if (path === "/im/support-settings") return { version: 0, serviceMessage: "B欢迎", complaintMessage: "B留言", updatedAt: null };
      if (body) bWrites++;
      return readCopyFixture({ publicOrigin: "https://b.example.com", callbackUrl: "https://b.example.com/api/v1/im/read-events/copy" });
    };
    await act(async () => root.render(createElement(SupportAssistantSettings, { key: "settings|actor-a|session-a", active: true, request: aRequest, canConfigure: true, canConfigureIntegration: true })));
    await settle(); await openIntegration(host); await setInputValue(host, "input[type=url]", "https://a-draft.example.com");
    await act(async () => findButton(host, "保存设置").click()); await settle();
    await act(async () => root.render(createElement(SupportAssistantSettings, { key: "settings|actor-b|session-b", active: true, request: bRequest, canConfigure: true, canConfigureIntegration: true, onWriteLockChange: value => bLocks.push(value) })));
    await settle(); await openIntegration(host);
    if (!unknown) { pending.resolve(readCopyFixture({ publicOrigin: "https://a-late.example.com" })); await settle(); }
    assert.equal(host.querySelector("input[type=url]").value, "https://b.example.com");
    assert.doesNotMatch(host.textContent, /保存结果尚未确认|同步设置已保存/);
    assert.equal(bWrites, 0); assert.ok(bLocks.every(value => value === false));
  }
});

test("shared user profile preview clears fetched and late facts when its capability is withdrawn", async t => {
  const { UserProfilePreview } = await vite.ssrLoadModule("/src/components/admin-preview/user-profile-preview.tsx");
  const host = browser.document.createElement("div"); browser.document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const payload = { user: { name: "资料用户", displayUsername: "ZZ-PROFILE", maskedPhone: "138****0101", accountStatus: "ACTIVE", identityStatus: "VERIFIED" } };
  let reads = 0; const request = async () => { reads++; return payload; };
  const render = async onOpenProfile => { await act(async () => root.render(createElement(UserProfilePreview, { userId: "profile-user", name: "资料用户", request, onOpenProfile }))); await settle(); };
  await render(() => {}); assert.match(host.textContent, /138\*\*\*\*0101/);
  await render(undefined); assert.doesNotMatch(host.textContent, /138\*\*\*\*0101|ZZ-PROFILE/); assert.match(host.textContent, /无权读取/); assert.equal(reads, 1);
  const pending = patrolDeferred(), slowRequest = () => pending.promise;
  await act(async () => root.render(createElement(UserProfilePreview, { userId: "profile-user", name: "资料用户", request: slowRequest, onOpenProfile: () => {} })));
  await act(async () => root.render(createElement(UserProfilePreview, { userId: "profile-user", name: "资料用户", request: slowRequest })));
  pending.resolve(payload); await settle();
  assert.doesNotMatch(host.textContent, /138\*\*\*\*0101|ZZ-PROFILE/); assert.match(host.textContent, /无权读取/);
});

test("patrol drops previous identity rows and selection even when the new identity read fails", async t => {
  let identity = "admin-a";
  const request = async path => {
    if (identity === "admin-b") throw { status: 500 };
    return path.startsWith("/im/audit/conversations")
      ? { items: [patrolConversation("identity-cache", { title: "旧身份用户", conversationId: "old-cid" })], nextCursor: "old-cursor" }
      : { messages: [patrolMessage("scope-msg", "sender", "旧身份正文", 1000)], nextCursor: null };
  };
  const host = browser.document.createElement("div"); browser.document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(createElement(SupportPatrol, { active: true, request, currentAdminUserId: identity })));
  await settle(); await act(async () => host.querySelector(".im-wb-row").click()); await settle();
  assert.match(host.textContent, /旧身份正文/);
  identity = "admin-b";
  await act(async () => root.render(createElement(SupportPatrol, { active: true, request, currentAdminUserId: identity }))); await settle();
  assert.equal(host.querySelectorAll(".im-wb-row").length, 0);
  assert.equal(host.querySelector(".im-wb-more"), null);
  assert.doesNotMatch(host.textContent, /旧身份用户|旧身份正文/);
  assert.match(host.textContent, /会话列表读取失败/);
});

test("patrol profiles use mapped platform identities and shared cards without guessing sender accounts", async t => {
  const profileReads = [];
  const request = async path => {
    if (path.startsWith("/users/")) { profileReads.push(path); return { user: { name: "用户甲", displayUsername: "ZZ1001", maskedPhone: "138****0001", accountStatus: "ACTIVE", identityStatus: "VERIFIED" } }; }
    if (path.startsWith("/im/audit/conversations")) return { items: [patrolConversation("profile")], nextCursor: null };
    return { messages: [
      patrolMessage("profile-user", "zzu-provider-account", "用户消息", 1000, { sender: { displayName: "用户甲", avatar: null, role: "USER", platformId: "platform-user" } }),
      patrolMessage("profile-admin", "zza-provider-account", "客服消息", 2000, { sender: { displayName: "客服甲", avatar: null, role: "ADMIN", platformId: "platform-admin", displayUsername: "ZZ0002" } }),
      patrolMessage("profile-bot", "zzs-provider-account", "欢迎", 3000, { sender: { displayName: "洲洲助手", avatar: null, role: "SYSTEM", platformId: "invalid-bot" } }),
      patrolMessage("profile-unknown", "unknown-provider-account", "旧消息", 4000, { sender: { displayName: "旧成员", avatar: null, role: "USER" } }),
    ], nextCursor: null };
  };
  const host = browser.document.createElement("div"); browser.document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(createElement(SupportPatrol, { active: true, request, currentAdminUserId: "viewer", onOpenProfile: () => {} })));
  await settle(); await act(async () => host.querySelector(".im-wb-row").click()); await settle();
  assert.deepEqual(profileReads, [], "user profile reads start only when its preview opens");
  assert.equal(host.querySelector('[aria-label="预览用户信息 旧成员"]'), null);
  assert.equal(host.querySelector('[aria-label="预览用户信息 洲洲助手"]'), null);
  const userButton = host.querySelector('[aria-label="预览用户信息 用户甲"]'); assert.ok(userButton);
  await act(async () => userButton.click()); await settle();
  assert.deepEqual(profileReads, ["/users/platform-user"]);
  assert.match(browser.document.body.textContent, /ZZ1001|138\*\*\*\*0001/);
  await act(async () => root.render(createElement(SupportPatrol, { active: true, request, currentAdminUserId: "viewer" }))); await settle();
  assert.doesNotMatch(browser.document.body.textContent, /ZZ1001|138\*\*\*\*0001/, "revoking profile read withdraws the fetched card facts");
  await act(async () => userButton.click()); await settle();
  await act(async () => host.querySelector('[aria-label="预览客服信息 客服甲"]').click()); await settle();
  const adminCard = browser.document.querySelector('[aria-label="平台客服预览：客服甲"]'); assert.ok(adminCard);
  assert.match(adminCard.textContent, /管理员账号ZZ0002/);
  assert.doesNotMatch(adminCard.textContent, /本单关系|协作客服|负责客服/);
  assert.deepEqual(profileReads, ["/users/platform-user"], "staff cards never call the user directory using an admin id");
  assert.doesNotMatch(browser.document.body.textContent, /zzu-provider-account|zza-provider-account|zzs-provider-account|invalid-bot/);
});

test("patrol shows projected names, avatars and roles without provider accounts or borrowed identities", async (t) => {
  const at = Date.parse("2026-10-29T02:00:00.000Z");
  requests.length = 0;
  fixture = baseFixture({
    conversations: {
      items: [patrolConversation("identity", {
        title: "林晓", userName: "", conversationId: "conv-identity",
        user: { id: "user-current", name: "林晓", avatar: "/api/v1/profile/avatars/user/user-current/1" },
      })],
      nextCursor: null,
    },
  });
  fixture.messages = {
    messages: [
      patrolMessage("1", "user-current", "租客消息", at, { sender: { displayName: "林晓", avatar: "/api/v1/profile/avatars/user/user-current/1", role: "USER" } }),
      patrolMessage("2", "admin-current", "当前客服", at + 1_000, { sender: { displayName: "陈晨", avatar: null, role: "ADMIN" } }),
      patrolMessage("3", "admin-old", "转交前客服", at + 2_000, { sender: { displayName: "王悦", avatar: null, role: "ADMIN" } }),
      patrolMessage("4", "bot", "助手消息", at + 3_000, { sender: { displayName: "洲洲助手", avatar: null, role: "SYSTEM" } }),
      patrolMessage("5", "zzu123456789", "无投影的未知发送者", at + 4_000),
      patrolMessage("6", "zza987654321", "服务端通用兜底", at + 5_000, { sender: { displayName: "平台用户", avatar: "javascript:alert(1)", role: "USER" } }),
      patrolMessage("7", "zzs999", "账号形状昵称", at + 6_000, { sender: { displayName: "zzs999", avatar: null, role: "SYSTEM" } }),
      patrolMessage("8", "user-a", "同昵称甲", at + 7_000, { sender: { displayName: "小林", avatar: null, role: "USER" } }),
      patrolMessage("9", "user-b", "同昵称乙", at + 8_000, { sender: { displayName: "小林", avatar: null, role: "USER" } }),
      patrolMessage("10", "user-a", "同人第一条", at + 9_000, { sender: { displayName: "小林", avatar: null, role: "USER" } }),
      patrolMessage("11", "user-a", "同人第二条", at + 10_000, { sender: { displayName: "小林", avatar: null, role: "USER" } }),
    ],
    nextCursor: null,
  };
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  const row = rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row");
  assert.ok(row.querySelector(".im-wb-row-av img"), "the list uses the real public avatar");
  await act(async () => row.click());
  await waitFor(() => msgNode(rootNode, "1"));

  const chat = rootNode.querySelector(".im-wb-mgmt-chat");
  assert.ok(chat.querySelector(".im-wb-chat-av img"), "the header uses the real public avatar");
  assert.match(chat.querySelector(".im-wb-chat-title h2").textContent, /林晓/);

  const nameOf = (id) => msgNode(rootNode, id)?.querySelector(".im-wb-msg-meta b")?.textContent ?? null;
  const roleOf = (id) => msgNode(rootNode, id)?.querySelector(".im-wb-role-tag")?.dataset.role ?? null;
  assert.equal(nameOf("1"), "林晓");
  assert.equal(roleOf("1"), "平台用户");
  assert.equal(msgNode(rootNode, "1").getAttribute("data-align"), "start");
  assert.equal(msgNode(rootNode, "2").getAttribute("data-align"), "end");
  assert.equal(nameOf("2"), "陈晨");
  assert.equal(roleOf("2"), "平台客服");
  assert.equal(nameOf("3"), "王悦", "a transferred historical admin keeps their own name");
  assert.equal(nameOf("4"), "洲洲助手");
  assert.equal(roleOf("4"), "机器人");
  assert.equal(msgNode(rootNode, "4").querySelector(".im-wb-av img").getAttribute("src"), "/art/zhouzhou/avatar.webp");

  assert.equal(nameOf("5"), "会话成员");
  assert.equal(roleOf("5"), null, "an unprojected sender gets no invented role");
  assert.equal(nameOf("6"), "会话成员", "generic server labels are not treated as a real name");
  assert.equal(roleOf("6"), "平台用户");
  assert.equal(msgNode(rootNode, "6").querySelector(".im-wb-av img"), null, "an unsafe avatar is not rendered");
  assert.equal(nameOf("7"), "会话成员", "an account-shaped display name is rejected");
  assert.equal(msgNode(rootNode, "7").querySelector(".im-wb-av img").getAttribute("src"), "/art/zhouzhou/avatar.webp");

  assert.equal(nameOf("8"), "小林");
  assert.equal(nameOf("9"), "小林", "the same nickname from a different account stays a separate author");
  assert.ok(msgNode(rootNode, "9").querySelector(".im-wb-msg-meta"), "different sender ids are not grouped");
  assert.equal(msgNode(rootNode, "11").querySelector(".im-wb-msg-meta"), null, "consecutive messages from one sender are grouped");
  assert.equal(msgNode(rootNode, "11").dataset.grouped, "true");

  assert.doesNotMatch(chat.textContent, /zz[aus]\d{3,}/i, "provider account ids never become visible names");
  assert.equal(requests.some((request) => request.path.includes("/users/")), false, "patrol does not fetch the user directory");
  assert.equal(requests.some((request) => request.method !== "GET"), false, "patrol stays read-only");
});

test("patrol renders support notices as workbench lines and keeps order stages factual without money", async (t) => {
  const at = Date.parse("2026-10-29T02:00:00.000Z");
  fixture = baseFixture({ conversations: { items: [patrolConversation("notices", { conversationId: "conv-notices" })], nextCursor: null } });
  fixture.messages = {
    messages: [
      patrolMessage("n-1", "user-1", "你好", at, { sender: { displayName: "用户甲", avatar: null, role: "USER" } }),
      patrolMessage("n-2", "system", "", at + 1_000, { messageType: 5, attachment: { type: 0 } }),
      patrolMessage("n-2b", "system", "", at + 1_500, { messageType: 5, attachment: { type: 0 } }),
      patrolMessage("n-3", "system", "", at + 2_000, { messageType: 5, attachment: { type: 3 } }),
      patrolMessage("n-4", "system", "", at + 2_500, { messageType: 5, attachment: { type: 0 }, revoked: true }),
      patrolMessage("card-1", "admin-b", "", at + 3_000, { messageType: 0, card: { kind: "ORDER_OPENING", orderId: "o-1", cardId: "card-1" } }),
    ],
    nextCursor: null,
  };
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => msgNode(rootNode, "card-1"));

  assert.equal(rootNode.querySelector(".im-wb-patrol-notices"), null, "there is no collapsed notice block");
  const notices = [...rootNode.querySelectorAll(".im-wb-sys")];
  assert.equal(notices.length, 1, "consecutive identical notices collapse to one line");
  assert.match(notices[0].textContent, /客服已接入/, "support notices use the workbench wording");
  assert.doesNotMatch(rootNode.textContent, /会话信息已更新/, "TEAM_UPDATED is invisible in support threads");
  assert.match(msgNode(rootNode, "n-4").textContent, /消息已撤回/, "a revoked notice is not resurrected as a generic notice");

  const card = msgNode(rootNode, "card-1");
  assert.match(card.textContent, /开租确认/);
  assert.doesNotMatch(card.textContent, /[¥￥]|金额依据待核对|待核对/, "patrol does not invent money facts");
  assert.equal(card.querySelector("a[href*='/orders/']"), null, "patrol does not fabricate a full order card link");
});

test("patrol renders order stage cards parsed from attachment.raw without write controls", async (t) => {
  const orderId = "order-7742";
  const conversationId = "admin-b|2|team-1";
  const raw = JSON.stringify({ schema: "zzsh.order-card", version: 1, kind: "ORDER_OPENING", orderId, cardId: "card-1" });
  const conversation = {
    id: orderId, type: "ORDER", title: "订单群 ZZ261110-000001", userName: "", adminUserId: "admin-b", adminName: "客服 B",
    state: "ACTIVE", lastMessageAt: "2026-11-10T04:31:38.000Z", conversationId, displayNo: "ZZ261110-000001", gameName: "三角洲行动",
  };
  const message = {
    messageClientId: "order-card-1", messageServerId: "order-card-1", conversationId, senderId: "bot", receiverId: "team-1",
    createTime: Date.parse("2026-11-10T04:31:37.752Z"), messageType: 100, text: `【开租确认卡】${raw}`, attachment: { raw },
  };
  const access = {
    orderId, displayNo: "ZZ261110-000001", orderStatus: "PAID", assignmentState: "ASSIGNED", teamState: "READY",
    appId: "synthetic", teamId: "team-1", name: "满配六套", gameName: "三角洲行动", account: { id: "acc-1", title: "满配六套" },
    viewerAccountId: "admin-b", conversationId, canRead: true, canSend: false,
    members: [{ platformId: "admin-b", accountId: "admin-b", party: "STAFF", name: "客服 B", avatar: null }],
    supportEscalation: { firstResponseAt: null, remindDueAt: null, addRound: 0, state: "NOT_STARTED", needsManualReview: false, noEligibleStaff: false },
    openingState: "DRAFT", openingAcks: { renter: false, owner: false }, openingId: "opening-1", openingVersion: 1,
  };
  fixture = baseFixture({
    conversations: { items: [conversation], nextCursor: null },
    messageByConversation: { [conversationId]: { messages: [message], nextCursor: null } },
    orderAccess: { [orderId]: access },
  });
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => rootNode.querySelector('.order-card[data-kind="ORDER_OPENING"]'), "the stage card is rich");
  const card = rootNode.querySelector('.order-card[data-kind="ORDER_OPENING"]');
  assert.equal(card.dataset.orderId, orderId);
  assert.match(card.textContent, /ZZ261110-000001/);
  assert.equal(card.querySelector(".order-card-confirm"), null, "patrol never offers a confirmation write");
  assert.doesNotMatch(rootNode.textContent, /【开租确认卡】|\{"schema"|"version":1/, "raw custom-message text never renders");
  assert.ok(requests.some((request) => request.path.endsWith(`/orders/${orderId}/im?operation=read`)), "the card reads the authorized order access");
});

test("an unavailable order access falls back to a readable card label", async (t) => {
  const orderId = "order-7742";
  const conversationId = "admin-b|2|team-1";
  const raw = JSON.stringify({ schema: "zzsh.order-card", version: 1, kind: "ORDER_OPENING", orderId, cardId: "card-1" });
  const conversation = {
    id: orderId, type: "ORDER", title: "订单群", userName: "", adminUserId: "admin-b", adminName: "客服 B",
    state: "ACTIVE", lastMessageAt: "2026-11-10T04:31:38.000Z", conversationId, displayNo: "ZZ261110-000001", gameName: "三角洲行动",
  };
  fixture = baseFixture({
    conversations: { items: [conversation], nextCursor: null },
    messageByConversation: {
      [conversationId]: { messages: [{
        messageClientId: "order-card-1", messageServerId: "order-card-1", conversationId, senderId: "bot", receiverId: "team-1",
        createTime: Date.parse("2026-11-10T04:31:37.752Z"), messageType: 100, text: `【开租确认卡】${raw}`, attachment: { raw },
      }], nextCursor: null },
    },
  });
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => rootNode.textContent.includes("开租确认"));
  assert.equal(rootNode.querySelector(".order-card"), null, "no rich card without access");
  assert.doesNotMatch(rootNode.textContent, /【开租确认卡】|\{"schema"|"version":1/, "the fallback never prints raw JSON");
});

test("patrol renders reply quotes from the stored server extension", async (t) => {
  const at = Date.parse("2026-10-29T02:00:00.000Z");
  fixture = baseFixture({ conversations: { items: [patrolConversation("reply-quote", { conversationId: "conv-reply-quote" })], nextCursor: null } });
  fixture.messages = {
    messages: [
      patrolMessage("orig", "user-1", "原消息", at, { conversationId: "conv-reply-quote", sender: { displayName: "用户甲", avatar: null, role: "USER" } }),
      patrolMessage("quoted", "admin-b", "回复内容", at + 1_000, {
        conversationId: "conv-reply-quote",
        sender: { displayName: "客服 B", avatar: null, role: "ADMIN" },
        serverExtension: JSON.stringify({ schema: "zzsh.message-reply", version: 1, messageId: "orig", senderId: "user-1", text: "原消息" }),
      }),
    ],
    nextCursor: null,
  };
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => msgNode(rootNode, "quoted"));
  const quote = msgNode(rootNode, "quoted").querySelector(".message-quoted");
  assert.ok(quote, "the patrol bubble keeps the quoted reply");
  assert.equal(quote.querySelector(".message-quoted-text").textContent, "原消息");
  assert.equal(quote.querySelector(".message-quoted-sender").textContent, "用户甲：");
});

test("patrol continues past an empty filtered page and merges 64-bit ids in ascending order", async (t) => {
  const at = Date.parse("2026-10-29T02:00:00.000Z");
  fixture = baseFixture({ conversations: { items: [patrolConversation("empty-page", { conversationId: "conv-empty-page" })], nextCursor: null } });
  fixture.messagePages = {
    "": { messages: [], nextCursor: "older-1" },
    "older-1": {
      messages: [
        patrolMessage("10000000000000000000", "user-1", "较晚", at, { sender: { displayName: "用户甲", avatar: null, role: "USER" } }),
        patrolMessage("9999999999999999999", "user-1", "较早", at, { sender: { displayName: "用户甲", avatar: null, role: "USER" } }),
      ],
      nextCursor: null,
    },
  };
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => rootNode.querySelector(".im-wb-patrol-history button"));
  assert.match(rootNode.textContent, /当前页没有可显示消息，可继续读取更早记录/);
  assert.equal(rootNode.querySelector(".im-wb-patrol-content .im-wb-patrol-history"), null, "the load control stays outside the prepend list");

  await act(async () => rootNode.querySelector(".im-wb-patrol-history button").click());
  await waitFor(() => msgNode(rootNode, "9999999999999999999"));
  const texts = [...rootNode.querySelectorAll(".im-wb-msg[data-message-id] .im-wb-bub")].map((node) => node.textContent);
  assert.deepEqual(texts, ["较早", "较晚"], "pages merge by time and full 64-bit server id");
  assert.equal(rootNode.querySelector(".im-wb-patrol-history"), null, "the cursor is exhausted");
});

test("patrol keeps loaded messages when an earlier page fails and retries in place", async (t) => {
  const at = Date.parse("2026-10-29T02:00:00.000Z");
  let failEarlier = true;
  fixture = baseFixture({ conversations: { items: [patrolConversation("earlier-retry", { conversationId: "conv-earlier-retry" })], nextCursor: null } });
  fixture.messagePages = {
    "": { messages: [patrolMessage("recent", "user-1", "最近消息", at, { sender: { displayName: "用户甲", avatar: null, role: "USER" } })], nextCursor: "older-retry" },
    "older-retry": () => failEarlier ? failure(500) : json({
      messages: [patrolMessage("older", "user-1", "更早消息", at - 60_000, { sender: { displayName: "用户甲", avatar: null, role: "USER" } })],
      nextCursor: null,
    }),
  };
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => msgNode(rootNode, "recent"));

  await act(async () => rootNode.querySelector(".im-wb-patrol-history button").click());
  await waitFor(() => rootNode.querySelector(".im-wb-history-error"));
  assert.match(rootNode.querySelector(".im-wb-history-error").textContent, /服务暂时无法完成请求/);
  assert.ok(msgNode(rootNode, "recent"), "the loaded page stays visible");
  assert.equal(rootNode.querySelector(".im-wb-patrol-history button").textContent, "重新读取更早消息");

  failEarlier = false;
  await act(async () => rootNode.querySelector(".im-wb-patrol-history button").click());
  await waitFor(() => msgNode(rootNode, "older"));
  assert.equal(rootNode.querySelector(".im-wb-history-error"), null);
  assert.ok(msgNode(rootNode, "recent"));
});

test("a late earlier-page response never fills the newly selected conversation", async (t) => {
  const at = Date.parse("2026-10-29T02:00:00.000Z");
  let resolveOlder;
  const older = new Promise((resolve) => { resolveOlder = resolve; });
  fixture = baseFixture({
    conversations: {
      items: [
        patrolConversation("late-a", { title: "会话甲", userName: "会话甲", conversationId: "conv-late-a" }),
        patrolConversation("late-b", { title: "会话乙", userName: "会话乙", conversationId: "conv-late-b", adminUserId: "admin-c", adminName: "客服 C" }),
      ],
      nextCursor: null,
    },
  });
  fixture.messagePages = {
    "": (url) => url.searchParams.get("conversationId") === "conv-late-a"
      ? { messages: [patrolMessage("late-a-recent", "user-a", "甲的最近消息", at, { conversationId: "conv-late-a", sender: { displayName: "会话甲", avatar: null, role: "USER" } })], nextCursor: "late-a-older" }
      : { messages: [patrolMessage("late-b-recent", "user-b", "乙的最近消息", at, { conversationId: "conv-late-b", sender: { displayName: "会话乙", avatar: null, role: "USER" } })], nextCursor: null },
    "late-a-older": () => older,
  };
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 2);
  const rows = [...rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row")];
  await act(async () => rows.find((row) => row.textContent.includes("会话甲")).click());
  await waitFor(() => msgNode(rootNode, "late-a-recent"));
  await act(async () => rootNode.querySelector(".im-wb-patrol-history button").click());
  await act(async () => rows.find((row) => row.textContent.includes("会话乙")).click());
  await waitFor(() => msgNode(rootNode, "late-b-recent"));

  resolveOlder(json({ messages: [patrolMessage("late-a-old", "user-a", "甲的旧消息", at - 60_000, { conversationId: "conv-late-a", sender: { displayName: "会话甲", avatar: null, role: "USER" } })], nextCursor: null }));
  await settle(50);
  assert.equal(msgNode(rootNode, "late-a-old"), null, "the old response is discarded");
  assert.doesNotMatch(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /甲的旧消息/);
  assert.ok(msgNode(rootNode, "late-b-recent"));
});

test("patrol states each history condition, waiting facts and unread counts honestly", async (t) => {
  fixture = baseFixture({
    conversations: {
      items: [
        patrolConversation("h-available", { title: "可用历史", userName: "可用历史", state: "CLOSED", conversationId: "conv-h-available", historyState: "AVAILABLE", adminUnreadCount: 0 }),
        patrolConversation("h-not-established", { title: "未建立通道", userName: "未建立通道", state: "ACTIVE", conversationId: null, historyState: "NOT_ESTABLISHED" }),
        patrolConversation("h-legacy", { title: "旧历史缺失", userName: "旧历史缺失", state: "CLOSED", conversationId: null, historyState: "LEGACY_UNAVAILABLE" }),
        patrolConversation("h-recovering", { title: "恢复中", userName: "恢复中", state: "ACTIVE", conversationId: "conv-h-recovering", historyState: "RECOVERING" }),
        patrolConversation("h-waiting", {
          title: "等待接入", userName: "等待接入", state: "WAITING", conversationId: null, historyState: "NOT_ESTABLISHED",
          adminUserId: null, adminName: "未分配", firstUserMessageAt: "2026-10-29T01:40:00.000Z", adminUnreadCount: 3, addRound: 2,
        }),
      ],
      nextCursor: null,
    },
  });
  fixture.messages = { messages: [], nextCursor: null };
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 5);
  const rows = () => [...rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row")];
  const open = async (label) => {
    const row = rows().find((item) => item.textContent.includes(label));
    assert.ok(row, `row ${label} exists`);
    await act(async () => row.click());
    await settle();
  };
  const emptyText = () => rootNode.querySelector(".im-wb-mgmt-chat .im-wb-empty")?.textContent ?? "";
  const waiting = rows().find((row) => row.textContent.includes("等待接入"));
  assert.match(waiting.textContent, /待接入/);
  assert.match(waiting.textContent, /接待未读 3/);
  assert.match(waiting.textContent, /已补派第 2 轮/);
  assert.match(waiting.textContent, /留言于/);
  assert.equal(rootNode.querySelectorAll(".im-wb-unread-pill").length, 1, "a missing unread count is not shown as zero");

  const before = requests.filter((request) => request.path.includes("/im/messages")).length;
  await open("可用历史");
  await waitFor(() => /该会话暂无可读消息/.test(emptyText()));
  assert.match(emptyText(), /该会话暂无可读消息/);
  assert.match(rootNode.querySelector(".im-wb-chat-title").textContent, /已结束/);
  assert.equal(requests.filter((request) => request.path.includes("/im/messages")).length, before + 1, "only AVAILABLE history is requested");

  await open("未建立通道");
  assert.match(emptyText(), /会话通道尚未建立/);
  await open("旧历史缺失");
  assert.match(emptyText(), /历史会话暂不可读/);
  await open("恢复中");
  assert.match(emptyText(), /会话通道恢复中，请稍后刷新/);
  assert.equal(requests.filter((request) => request.path.includes("/im/messages")).length, before + 1, "unavailable histories never issue a read");
});

test("patrol renders video, file and image through shared media instead of an unsupported placeholder", async (t) => {
  const at = Date.parse("2026-10-29T02:00:00.000Z");
  fixture = baseFixture({ conversations: { items: [patrolConversation("media", { conversationId: "conv-media" })], nextCursor: null } });
  fixture.messages = {
    messages: [
      patrolMessage("video", "user-1", "", at, { messageType: 3, attachment: { name: "演示.mp4", size: 2048, duration: 2000, url: "https://example.test/review.mp4" }, sender: { displayName: "用户甲", avatar: null, role: "USER" } }),
      patrolMessage("file", "user-1", "", at + 1_000, { messageType: 6, attachment: { name: "附件.pdf", size: 4096, url: "https://example.test/file.pdf" }, sender: { displayName: "用户甲", avatar: null, role: "USER" } }),
      patrolMessage("image", "user-1", "", at + 2_000, { messageType: 1, attachment: { name: "截图.png", url: "https://example.test/full.png", thumbUrl: "https://example.test/thumb.png" }, sender: { displayName: "用户甲", avatar: null, role: "USER" } }),
      patrolMessage("unknown", "user-1", "", at + 3_000, { messageType: 99, sender: { displayName: "用户甲", avatar: null, role: "USER" } }),
    ],
    nextCursor: null,
  };
  const { rootNode } = await mountManagement(t);
  await openPatrol(rootNode);
  await waitFor(() => rootNode.querySelectorAll(".im-wb-mgmt-patrol-list .im-wb-row").length === 1);
  await act(async () => rootNode.querySelector(".im-wb-mgmt-patrol-list .im-wb-row").click());
  await waitFor(() => msgNode(rootNode, "video"));
  assert.ok(msgNode(rootNode, "video").querySelector(".message-media-video-open"));
  assert.match(msgNode(rootNode, "video").textContent, /演示.mp4/);
  assert.ok(msgNode(rootNode, "file").querySelector("a.message-media-file[href='https://example.test/file.pdf']"));
  assert.ok(msgNode(rootNode, "image").querySelector(".message-image"));
  assert.match(msgNode(rootNode, "unknown").textContent, /这条消息暂无法显示/);
  assert.doesNotMatch(rootNode.querySelector(".im-wb-mgmt-chat").textContent, /暂不支持展示的消息类型/);
});

/* ------------------------------ 巡视返修 R1 ------------------------------ */

const directMessage = (id, text, conversationId = "viewer|2|1001") => patrolMessage(
  id, "synthetic-sender", text, Date.parse("2026-11-01T01:00:00.000Z"),
  { conversationId, sender: { displayName: "合成用户", avatar: null, role: "USER" } },
);

test("PBR-01 list 401/403/423 refreshes clear old rows, selection and message body", async (t) => {
  for (const status of [401, 403, 423]) {
    let deny = false;
    const request = async (path) => {
      if (path.startsWith("/im/audit/conversations")) {
        if (deny) return Promise.reject({ status });
        return { items: [patrolConversation("1001", { conversationId: "viewer|2|1001" })], nextCursor: null };
      }
      return { messages: [directMessage(`body-${status}`, `AUTHORIZED_BODY_${status}`)], nextCursor: "older" };
    };
    const { host } = await mountPatrol(t, request);
    await clickNode(host.querySelector(".im-wb-row"));
    await waitFor(() => host.textContent.includes(`AUTHORIZED_BODY_${status}`));
    deny = true;
    await clickNode(host.querySelector('[aria-label="刷新巡视列表"]'));
    await waitFor(() => host.textContent.includes("无权查看会话巡视"));
    assert.equal(host.querySelectorAll(".im-wb-row").length, 0, `${status}: old rows are gone`);
    assert.doesNotMatch(host.textContent, new RegExp(`AUTHORIZED_BODY_${status}`), `${status}: old body is gone`);
  }
});

test("PBR-01 a list denial invalidates an in-flight message read", async (t) => {
  const pending = patrolDeferred();
  let deny = false;
  const request = async (path) => {
    if (path.startsWith("/im/audit/conversations")) {
      return deny ? Promise.reject({ status: 403 }) : { items: [patrolConversation("1001", { conversationId: "viewer|2|1001" })], nextCursor: null };
    }
    return pending.promise;
  };
  const { host } = await mountPatrol(t, request);
  await clickNode(host.querySelector(".im-wb-row"));
  deny = true;
  await clickNode(host.querySelector('[aria-label="刷新巡视列表"]'));
  await waitFor(() => host.textContent.includes("无权查看会话巡视"));
  pending.resolve({ messages: [directMessage("late", "LATE_BODY_AFTER_LIST_DENIAL")], nextCursor: null });
  await settle();
  assert.doesNotMatch(host.textContent, /LATE_BODY_AFTER_LIST_DENIAL/);
});

test("PBR-01 list refresh 500 keeps loaded rows/body and retries in place", async (t) => {
  let fail = false;
  const request = async (path) => {
    if (path.startsWith("/im/audit/conversations")) {
      return fail ? Promise.reject({ status: 500 }) : { items: [patrolConversation("1001", { conversationId: "viewer|2|1001" })], nextCursor: null };
    }
    return { messages: [directMessage("body", "BODY_KEPT_ON_LIST_REFRESH_500")], nextCursor: null };
  };
  const { host } = await mountPatrol(t, request);
  await clickNode(host.querySelector(".im-wb-row"));
  await waitFor(() => host.textContent.includes("BODY_KEPT_ON_LIST_REFRESH_500"));
  fail = true;
  await clickNode(host.querySelector('[aria-label="刷新巡视列表"]'));
  await waitFor(() => host.textContent.includes("会话列表读取失败"));
  assert.equal(host.querySelectorAll(".im-wb-row").length, 1);
  assert.match(host.textContent, /BODY_KEPT_ON_LIST_REFRESH_500/);
  fail = false;
  await clickNode([...host.querySelectorAll(".im-wb-list-empty button")].find((button) => button.textContent.includes("重新读取")));
  await waitFor(() => !host.textContent.includes("会话列表读取失败"));
  assert.equal(host.querySelectorAll(".im-wb-row").length, 1);
  assert.match(host.textContent, /BODY_KEPT_ON_LIST_REFRESH_500/);
});

test("PBR-01 earlier-page 403 clears the object body, cursor and retry", async (t) => {
  const request = async (path) => {
    if (path.startsWith("/im/audit/conversations")) return { items: [patrolConversation("1001", { conversationId: "viewer|2|1001" })], nextCursor: null };
    if (new URL(path, "http://synthetic.local").searchParams.has("cursor")) return Promise.reject({ status: 403 });
    return { messages: [directMessage("body", "BODY_BEFORE_EARLIER_DENIAL")], nextCursor: "older" };
  };
  const { host } = await mountPatrol(t, request);
  await clickNode(host.querySelector(".im-wb-row"));
  await waitFor(() => host.textContent.includes("BODY_BEFORE_EARLIER_DENIAL"));
  await clickNode(host.querySelector(".im-wb-patrol-history button"));
  await waitFor(() => host.textContent.includes("无权查看该会话消息"));
  assert.doesNotMatch(host.textContent, /BODY_BEFORE_EARLIER_DENIAL/);
  assert.equal(host.querySelector(".im-wb-patrol-history"), null);
  assert.equal(host.querySelector(".im-wb-history-error"), null);
  assert.match(host.querySelector(".im-wb-mgmt-chat").textContent, /需要该会话的只读历史权限/);
});

test("PBR-01 list-more 403 clears old rows, selection and body", async (t) => {
  const request = async (path) => {
    const url = new URL(path, "http://synthetic.local");
    if (url.pathname === "/im/audit/conversations") {
      if (url.searchParams.get("cursor") === "more-denied") return Promise.reject({ status: 403 });
      return { items: [patrolConversation("1001", { conversationId: "viewer|2|1001" })], nextCursor: "more-denied" };
    }
    return { messages: [directMessage("body", "BODY_BEFORE_MORE_DENIAL")], nextCursor: null };
  };
  const { host } = await mountPatrol(t, request);
  await clickNode(host.querySelector(".im-wb-row"));
  await waitFor(() => host.textContent.includes("BODY_BEFORE_MORE_DENIAL"));
  await clickNode(host.querySelector(".im-wb-more"));
  await waitFor(() => host.textContent.includes("无权查看会话巡视"));
  assert.equal(host.querySelectorAll(".im-wb-row").length, 0);
  assert.doesNotMatch(host.textContent, /BODY_BEFORE_MORE_DENIAL/);
});

test("PBR-02 stale ALL pagination cannot append, replace cursor or clear new loading", async (t) => {
  const oldPage = patrolDeferred();
  const newPage = patrolDeferred();
  const request = async (path) => {
    const url = new URL(path, "http://synthetic.local");
    if (url.pathname !== "/im/audit/conversations") return { messages: [], nextCursor: null };
    const cursor = url.searchParams.get("cursor");
    if (cursor === "old-list-cursor") return oldPage.promise;
    if (cursor === "order-cursor") return newPage.promise;
    if (url.searchParams.get("type") === "ORDER") {
      return { items: [patrolConversation("3001", { type: "ORDER", title: "新订单筛选结果", displayNo: "SYNTHETIC-ORDER" })], nextCursor: "order-cursor" };
    }
    return { items: [patrolConversation("1001", { conversationId: "viewer|2|1001" })], nextCursor: "old-list-cursor" };
  };
  const { host } = await mountPatrol(t, request);
  await clickNode(host.querySelector(".im-wb-more"));
  await pickOption(host, "按类型筛选", "订单群");
  await waitFor(() => host.textContent.includes("新订单筛选结果"));

  await clickNode(host.querySelector(".im-wb-more"));
  assert.equal(host.querySelector(".im-wb-more").textContent, "正在读取…");
  oldPage.resolve({ items: [patrolConversation("2001", { title: "旧筛选迟到咨询" })], nextCursor: "stale-next" });
  await settle();
  assert.doesNotMatch(host.textContent, /旧筛选迟到咨询/, "the old ALL page is discarded");
  assert.equal(host.querySelector(".im-wb-more").textContent, "正在读取…", "the stale request does not clear the new loading state");

  newPage.resolve({ items: [patrolConversation("4001", { type: "ORDER", title: "订单更多页" })], nextCursor: null });
  await waitFor(() => host.textContent.includes("订单更多页"));
  assert.equal(host.querySelector(".im-wb-more"), null);
});

test("PBR-03 same-cid history downgrade clears the body and missing status is never read", async (t) => {
  let historyState = "AVAILABLE";
  let reads = 0;
  const request = async (path) => {
    if (path.startsWith("/im/audit/conversations")) {
      return { items: [patrolConversation("1001", { conversationId: "viewer|2|1001", historyState })], nextCursor: null };
    }
    if (path.includes("/rounds")) return roundsPage("1001", []);
    reads += 1;
    return { messages: [directMessage(`read-${reads}`, `BODY_${reads}`)], nextCursor: null };
  };
  const { host } = await mountPatrol(t, request);
  await clickNode(host.querySelector(".im-wb-row"));
  await waitFor(() => host.textContent.includes("BODY_1"));

  historyState = "RECOVERING";
  await clickNode(host.querySelector('[aria-label="刷新巡视列表"]'));
  await waitFor(() => host.textContent.includes("会话通道恢复中，请稍后刷新"));
  assert.doesNotMatch(host.textContent, /BODY_1/);
  assert.equal(reads, 1, "a recovering conversation is not read");
  assert.equal(host.querySelector(".im-wb-patrol-history"), null);

  historyState = "AVAILABLE";
  await clickNode(host.querySelector('[aria-label="刷新巡视列表"]'));
  await waitFor(() => host.textContent.includes("BODY_2"));
  assert.equal(reads, 2, "returning to AVAILABLE reads again");

  historyState = undefined;
  await clickNode(host.querySelector('[aria-label="刷新巡视列表"]'));
  await waitFor(() => host.textContent.includes("历史状态尚未提供，暂不读取"));
  assert.equal(reads, 2, "missing historyState is not treated as authorized");
});

test("PBR-03 A-B-A and request changes discard the prior earlier page", async (t) => {
  const pending = patrolDeferred();
  let aReads = 0;
  const request = async (path) => {
    const url = new URL(path, "http://synthetic.local");
    if (url.pathname === "/im/audit/conversations") {
      return { items: [
        patrolConversation("1001", { conversationId: "viewer|2|1001" }),
        patrolConversation("1002", { conversationId: "viewer|2|1002" }),
      ], nextCursor: null };
    }
    if (url.pathname.endsWith("/rounds")) return roundsPage("1001", []);
    if (url.searchParams.has("cursor")) return pending.promise;
    if (url.searchParams.get("conversationId") === "viewer|2|1001") {
      aReads += 1;
      return { messages: [directMessage(`a-${aReads}`, `A_READ_${aReads}`)], nextCursor: `a-older-${aReads}` };
    }
    return { messages: [directMessage("b-1", "B_READ", "viewer|2|1002")], nextCursor: null };
  };
  const first = await mountPatrol(t, request);
  const rows = () => first.host.querySelectorAll(".im-wb-row");
  await clickNode(rows()[0]);
  await waitFor(() => first.host.textContent.includes("A_READ_1"));
  await clickNode(first.host.querySelector(".im-wb-patrol-history button"));
  await clickNode(rows()[1]);
  await waitFor(() => first.host.textContent.includes("B_READ"));
  await clickNode(rows()[0]);
  await waitFor(() => first.host.textContent.includes("A_READ_2"));
  pending.resolve({ messages: [directMessage("a-old", "OLD_A_PAGE_FROM_PRIOR_VISIT")], nextCursor: "stale-cursor" });
  await settle();
  assert.doesNotMatch(first.host.textContent, /OLD_A_PAGE_FROM_PRIOR_VISIT/);
  assert.match(first.host.textContent, /A_READ_2/);

  const replacement = patrolDeferred();
  let replacementReads = 0;
  const request2 = async (path) => {
    const url = new URL(path, "http://synthetic.local");
    if (url.pathname === "/im/audit/conversations") return { items: [patrolConversation("2001", { conversationId: "viewer|2|2001" })], nextCursor: null };
    if (url.pathname.endsWith("/rounds")) return roundsPage("2001", []);
    if (url.searchParams.has("cursor")) return replacement.promise;
    replacementReads += 1;
    return { messages: [directMessage(`new-${replacementReads}`, `NEW_REQUEST_BODY_${replacementReads}`, "viewer|2|2001")], nextCursor: "new-older" };
  };
  const second = await mountPatrol(t, request2, { currentAdminUserId: "admin-b" });
  await clickNode(second.host.querySelector(".im-wb-row"));
  await waitFor(() => second.host.textContent.includes("NEW_REQUEST_BODY_1"));
  await clickNode(second.host.querySelector(".im-wb-patrol-history button"));
  await act(async () => second.root.render(createElement(SupportPatrol, { active: true, request: async (path) => request2(path), currentAdminUserId: "admin-b" })));
  await waitFor(() => second.host.textContent.includes("NEW_REQUEST_BODY_2"));
  replacement.resolve({ messages: [directMessage("stale", "STALE_PAGE_AFTER_REQUEST_CHANGE", "viewer|2|2001")], nextCursor: "stale" });
  await settle();
  assert.doesNotMatch(second.host.textContent, /STALE_PAGE_AFTER_REQUEST_CHANGE/);
  assert.match(second.host.textContent, /NEW_REQUEST_BODY_2/);
});

test("PBR-03 active=false invalidates an in-flight earlier page and re-reads on return", async (t) => {
  const pending = patrolDeferred();
  let reads = 0;
  const request = async (path) => {
    if (path.startsWith("/im/audit/conversations")) return { items: [patrolConversation("1001", { conversationId: "viewer|2|1001" })], nextCursor: null };
    const url = new URL(path, "http://synthetic.local");
    if (url.pathname.endsWith("/rounds")) return roundsPage("1001", []);
    if (url.searchParams.has("cursor")) return pending.promise;
    reads += 1;
    return { messages: [directMessage(`active-${reads}`, `ACTIVE_BODY_${reads}`)], nextCursor: "older" };
  };
  const view = await mountPatrol(t, request);
  await clickNode(view.host.querySelector(".im-wb-row"));
  await waitFor(() => view.host.textContent.includes("ACTIVE_BODY_1"));
  await clickNode(view.host.querySelector(".im-wb-patrol-history button"));
  await act(async () => view.root.render(createElement(SupportPatrol, { active: false, request })));
  await settle();
  assert.doesNotMatch(view.host.textContent, /ACTIVE_BODY_1/);
  pending.resolve({ messages: [directMessage("old", "STALE_WHILE_INACTIVE")], nextCursor: "stale" });
  await settle();
  assert.doesNotMatch(view.host.textContent, /STALE_WHILE_INACTIVE/);

  await act(async () => view.root.render(createElement(SupportPatrol, { active: true, request })));
  await waitFor(() => view.host.textContent.includes("ACTIVE_BODY_2"));
  assert.equal(reads, 2);
});

test("PBR-01 list-more 500 is visible, keeps loaded rows and retries", async (t) => {
  let failMore = true;
  const request = async (path) => {
    const url = new URL(path, "http://synthetic.local");
    if (url.pathname === "/im/audit/conversations") {
      if (url.searchParams.get("cursor") === "list-older") {
        return failMore
          ? Promise.reject({ status: 500 })
          : { items: [patrolConversation("2001", { title: "LIST_MORE_OK" })], nextCursor: null };
      }
      return { items: [patrolConversation("1001", { conversationId: "viewer|2|1001" })], nextCursor: "list-older" };
    }
    return { messages: [directMessage("body", "BODY_KEPT_ON_LIST_MORE_500")], nextCursor: null };
  };
  const { host } = await mountPatrol(t, request);
  await clickNode(host.querySelector(".im-wb-row"));
  await waitFor(() => host.textContent.includes("BODY_KEPT_ON_LIST_MORE_500"));
  await clickNode(host.querySelector(".im-wb-more"));
  await waitFor(() => host.querySelector(".im-wb-notice[role='alert']"));
  assert.match(host.querySelector(".im-wb-notice[role='alert']").textContent, /操作未完成|服务暂时无法完成请求/);
  assert.match(host.textContent, /BODY_KEPT_ON_LIST_MORE_500/);
  assert.match(host.querySelector(".im-wb-notice[role='alert']").textContent, /重试/);

  failMore = false;
  await clickNode(host.querySelector(".im-wb-notice[role='alert'] button"));
  await waitFor(() => host.textContent.includes("LIST_MORE_OK"));
  assert.match(host.textContent, /BODY_KEPT_ON_LIST_MORE_500/);
});

test("PBR-03 an earlier-page 500 keeps loaded content and retries in place", async (t) => {
  let failEarlier = true;
  const request = async (path) => {
    if (path.startsWith("/im/audit/conversations")) return { items: [patrolConversation("1001", { conversationId: "viewer|2|1001" })], nextCursor: null };
    if (new URL(path, "http://synthetic.local").searchParams.has("cursor")) {
      return failEarlier ? Promise.reject({ status: 500 }) : { messages: [directMessage("older", "EARLIER_RETRY_500")], nextCursor: null };
    }
    return { messages: [directMessage("body", "BODY_KEPT_ON_EARLIER_500")], nextCursor: "older" };
  };
  const { host } = await mountPatrol(t, request);
  await clickNode(host.querySelector(".im-wb-row"));
  await waitFor(() => host.textContent.includes("BODY_KEPT_ON_EARLIER_500"));
  await clickNode(host.querySelector(".im-wb-patrol-history button"));
  await waitFor(() => host.querySelector(".im-wb-history-error"));
  assert.match(host.textContent, /BODY_KEPT_ON_EARLIER_500/);
  assert.equal(host.querySelector(".im-wb-patrol-history button").textContent, "重新读取更早消息");
  failEarlier = false;
  await clickNode(host.querySelector(".im-wb-patrol-history button"));
  await waitFor(() => host.textContent.includes("EARLIER_RETRY_500"));
  assert.match(host.textContent, /BODY_KEPT_ON_EARLIER_500/);
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
  await act(async () => { rootNode.querySelector(".im-wb-row").click(); });
  await settle();
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
  const pauseToggle = rootNode.querySelector(".im-wb-presence-toggle");
  assert.ok(pauseToggle.classList.contains("im-wb-btn-outline"), "pause is a secondary control");
  assert.equal(pauseToggle.classList.contains("im-wb-btn-primary"), false, "pause is not a primary action");
  const writesBefore = presenceWrites.length;
  await act(async () => rootNode.querySelector(".im-wb-presence-toggle").click());
  await waitFor(() => browser.document.querySelector('[aria-label="暂停接待确认"]'));
  const dialog = browser.document.querySelector('[aria-label="暂停接待确认"]');
  assert.match(dialog.textContent, /还有 1 条未完成咨询/);
  assert.match(dialog.textContent, /用户 A/);
  assert.match(dialog.textContent, /接待中/);
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

test("heartbeat posts every 30s while available and connected", async (t) => {
  fixture = baseFixture();
  fixture.presence = { ...fixture.presence, availability: "AVAILABLE", connectionState: "CONNECTED" };
  const { rootNode } = await mount(t, {});
  await waitFor(() => heartbeatTimers().length > 0);
  const beats = () => requests.filter((request) => request.path.endsWith("/im/presence/heartbeat")).length;
  // 30s 同时用于 presence 回写和心跳，统一触发再按 heartbeat 请求计数断言。
  const tickTimers = async () => {
    for (const entry of heartbeatTimers()) await act(async () => { entry.callback(); await Promise.resolve(); });
  };
  const before = beats();
  await tickTimers();
  await waitFor(() => beats() === before + 1);
  assert.equal(requests.filter((request) => request.path.endsWith("/im/presence/heartbeat")).at(-1)?.body?.connectionState, "CONNECTED");

  const originalVisibility = Object.getOwnPropertyDescriptor(browser.document, "visibilityState");
  Object.defineProperty(browser.document, "visibilityState", { configurable: true, get: () => "hidden" });
  try {
    const hiddenBefore = beats();
    await tickTimers();
    await waitFor(() => beats() === hiddenBefore + 1);
    assert.ok(beats() > hiddenBefore, "the interval keeps the operator online while the page is hidden");
  } finally {
    if (originalVisibility) Object.defineProperty(browser.document, "visibilityState", originalVisibility);
    else Object.defineProperty(browser.document, "visibilityState", { configurable: true, get: () => "visible" });
  }

  await act(async () => rootNode.querySelector(".im-wb-presence-toggle").click());
  await waitFor(() => presenceWrites.at(-1)?.availability === "OFF_DUTY");
  await settle();
  const stopped = beats();
  await tickTimers();
  await settle();
  assert.equal(beats(), stopped, "leaving AVAILABLE stops the heartbeat");
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

test("overview parsing keeps valid points, rejects missing required metrics and keeps real zero", () => {
  const parsed = model.parseSupportOverview({
    reportDate: "2026-10-29",
    serverNow: "2026-10-29T04:00:00.000Z",
    period: { dateFrom: "2026-10-29", dateTo: "2026-10-29", days: 1, timeZone: "Asia/Shanghai", trendFrom: "2026-10-23", trendTo: "2026-10-29" },
    totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 0, todayUsers: 0 },
    onDuty: [{ adminUserId: "a", name: "", availability: "PAUSED", connectionState: "CONNECTED", todaySeconds: 60, activeLoad: 0, todaySessions: 0, todayUsers: 0, currentOrderGroups: 0 }],
    trend: [{ date: "2026-10-29", sessions: 2, users: 1 }, { date: "", sessions: 4 }, { sessions: 1 }],
    hourly: [{ hour: 8, sessions: 3 }, { hour: 24, sessions: 9 }, { hour: "9", sessions: 2 }],
    ratings: { count: 0, average: null, distribution: [0, 0, 0, 0, 0], agents: [] },
  });
  assert.equal(parsed.onDuty[0].name, "未命名客服");
  assert.equal(parsed.onDuty[0].activeLoad, 0);
  assert.equal(parsed.totals.todaySessions, 0);
  assert.equal(parsed.trend.length, 1);
  assert.equal(parsed.hourly.length, 1);
  assert.throws(() => model.parseSupportOverview({}), /客服统计数据不完整/);
  assert.throws(() => model.parseSupportOverview({
    ...overview(),
    totals: undefined,
  }), /客服统计数据不完整/);
  const slots = model.hourlySlots([{ hour: 8, sessions: 3 }, { hour: 8, sessions: 2 }, { hour: 9, sessions: 1 }]);
  assert.equal(slots.length, 24);
  assert.equal(slots[8].sessions, 5);
  assert.equal(slots[23].sessions, 0);
});

test("audit parsing tolerates missing fields and builds documented query paths", () => {
  const page = model.parseAuditConversations({
    items: [
      { id: "a", type: "SERVICE", roundSeq: 3, roundCount: 4 },
      { id: "", type: "SERVICE" },
      { id: "b", type: "future", title: "未来类型", adminUserId: "" },
    ],
    nextCursor: "",
  });
  assert.deepEqual(page.items.map((item) => item.id), ["a", "b"]);
  assert.equal(page.items[0].title, "未命名会话");
  assert.equal(page.items[1].type, "UNKNOWN");
  assert.equal(page.items[0].roundSeq, 3);
  assert.equal(page.items[0].roundCount, 4);
  assert.equal(page.items[0].historyState, undefined, "missing consultation historyState stays missing");
  assert.equal(page.nextCursor, null);

  const orders = model.parseAuditConversations({
    items: [
      { id: "order-ready", kind: "ORDER_GROUP", status: "ACTIVE", teamState: "READY", conversationId: "viewer|2|7" },
      { id: "order-waiting", kind: "ORDER_GROUP", status: "WAITING", teamState: "PENDING", conversationId: null },
      { id: "order-closed", kind: "ORDER_GROUP", status: "COMPLETED", teamState: "READY", conversationId: null },
    ],
  }).items;
  assert.equal(orders[0].historyState, "AVAILABLE", "order cid is the explicit READY capability");
  assert.equal(orders[1].historyState, "NOT_ESTABLISHED");
  assert.equal(orders[2].historyState, "LEGACY_UNAVAILABLE");

  assert.equal(model.auditConversationsPath({ type: "ALL" }), "/im/audit/conversations");
  assert.equal(model.auditConversationsPath({ type: "ORDER", adminUserId: "admin-a", cursor: "c1" }), "/im/audit/conversations?type=ORDER&adminUserId=admin-a&cursor=c1");
  assert.equal(model.auditMessagesPath("conv-c1"), "/im/messages?conversationId=conv-c1&mode=patrol");
  assert.equal(model.auditMessageType("ORDER"), "ORDER");
  assert.equal(model.auditMessageType("COMPLAINT"), "CONSULTATION");

  const messages = model.parseAuditMessages({
    messages: [
      { senderId: "u1", createTime: 100, text: "hi" },
      { senderId: "", createTime: 100 },
      { senderId: "u2", createTime: "bad" },
      { senderId: "u3", createTime: 200, card: { kind: "ORDER_OPENING", orderId: "o1", cardId: "c1" } },
      { senderId: "u4", createTime: 300, text: "quoted", serverExtension: JSON.stringify({ schema: "zzsh.message-reply", version: 1, messageId: "u1-100", senderId: "u1", text: "orig" }) },
      {
        senderId: "u5", createTime: 400, messageClientId: "m5", messageType: 100, text: "【开租确认卡】",
        attachment: { raw: JSON.stringify({ schema: "zzsh.order-card", version: 1, kind: "ORDER_OPENING", orderId: "o2", cardId: "c2" }) },
      },
    ],
  });
  assert.equal(messages.messages.length, 4);
  assert.equal(messages.messages[0].messageClientId, "u1-100");
  assert.equal(messages.messages[1].card.kind, "ORDER_OPENING");
  assert.equal(messages.messages[2].reply?.messageId, "u1-100");
  assert.equal(messages.messages[2].reply?.text, "orig");
  assert.equal(messages.messages[3].card?.kind, "ORDER_OPENING");
  assert.equal(messages.messages[3].card?.orderId, "o2");
});

test("time filters use Beijing calendar boundaries", () => {
  const now = new Date("2026-10-29T04:00:00.000Z");
  assert.equal(model.withinTimeFilter(null, "all", now), true);
  assert.equal(model.withinTimeFilter(null, "today", now), false);
  assert.equal(model.withinTimeFilter("2026-10-29T01:00:00.000Z", "today", now), true);
  assert.equal(model.withinTimeFilter("2026-10-28T15:00:00.000Z", "today", now), false, "before Beijing midnight");
  assert.equal(model.withinTimeFilter("2026-10-28T23:00:00.000Z", "7d", now), true);});

test("assistant scene catalog explains built-in messages without pretending to configure money",async t=>{
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  const request=async()=>({version:0,serviceMessage:'欢迎',complaintMessage:'请留言',updatedAt:null});
  await act(async()=>root.render(createElement(SupportAssistantSettings,{active:true,request,canConfigure:true})));await settle();
  assert.equal(host.querySelectorAll('textarea').length,2,'settings start with their editable content');
  assert.doesNotMatch(host.textContent,/职责与边界|不会做什么|本页管理范围|自动场景|configure 权限|分销客服/);
  assert.equal([...host.querySelectorAll('nav button')].some(b=>b.textContent.includes('总览')),false);
  const group=label=>[...host.querySelectorAll('nav button')].find(b=>b.textContent.includes(label));
  await act(async()=>group('咨询开场').click());await settle();
  assert.equal(host.querySelectorAll('textarea').length,2);
  assert.match(host.textContent,/发送身份：洲洲助手（系统）/);assert.match(host.textContent,/消息预览/);
  await act(async()=>group('订单通知').click());await settle();
  assert.match(host.textContent,/结算完成/);assert.match(host.textContent,/不代表退款已到账/);
  assert.equal(host.querySelectorAll('textarea').length,0,'system facts do not become fake editable templates');
  assert.equal([...host.querySelectorAll('button')].some(b=>/保存|试发/.test(b.textContent)),false,'read-only catalog has no fake save or test-send button');
  await act(async()=>group('接待通知').click());await settle();assert.match(host.textContent,/接待客服身份（系统代发）/);
  await act(async()=>group('到期与补派').click());await settle();
  assert.match(host.textContent,/按系统设置/);assert.match(host.textContent,/本页只读/);assert.match(host.textContent,/补派安抚/);
  assert.equal(host.querySelectorAll('textarea').length,0);
});

test("assistant welcome reload asks before discarding a dirty draft",async t=>{
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);let reads=0;
  t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  const saved={version:0,serviceMessage:'默认欢迎',complaintMessage:'请描述问题',updatedAt:null};
  const request=async(path,body)=>{assert.equal(path,'/im/support-settings');if(body)return {...body,version:1,updatedAt:null};reads++;return reads>1?{...saved,serviceMessage:'服务端新版本'}:saved;};
  await act(async()=>root.render(createElement(SupportAssistantSettings,{active:true,request,canConfigure:true})));await settle();
  await act(async()=>[...host.querySelectorAll('nav button')].find(b=>b.textContent.includes('咨询开场')).click());await settle();
  const textarea=host.querySelector('textarea'),setValue=Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set;
  await act(async()=>{setValue.call(textarea,'未保存草稿');textarea.dispatchEvent(new browser.Event('input',{bubbles:true}));});await settle();
  const click=label=>[...host.querySelectorAll('button')].find(b=>b.textContent===label);
  await act(async()=>click('重新加载').click());await settle();
  assert.match(host.textContent,/重新加载会放弃未保存的欢迎消息/);
  await act(async()=>click('取消').click());await settle();assert.equal(host.querySelector('textarea').value,'未保存草稿');
  await act(async()=>click('重新加载').click());await settle();await act(async()=>click('确认放弃').click());await settle();
  assert.equal(reads,2);assert.equal(host.querySelector('textarea').value,'服务端新版本');
});

test("assistant welcome preview follows input and rejects unsupported variables",async t=>{
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  const request=async()=>({version:0,serviceMessage:'默认欢迎',complaintMessage:'请描述问题',updatedAt:null});
  await act(async()=>root.render(createElement(SupportAssistantSettings,{active:true,request,canConfigure:true})));await settle();
  await act(async()=>[...host.querySelectorAll('nav button')].find(b=>b.textContent.includes('咨询开场')).click());await settle();
  const textarea=host.querySelector('textarea'),setValue=Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set;
  const save=()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='保存欢迎消息');
  await act(async()=>{setValue.call(textarea,'欢迎 {{agentName}}');textarea.dispatchEvent(new browser.Event('input',{bubbles:true}));});await settle();
  assert.match(host.textContent,/暂不支持变量/);assert.equal(save().disabled,true);
  await act(async()=>{setValue.call(textarea,'新的欢迎消息');textarea.dispatchEvent(new browser.Event('input',{bubbles:true}));});await settle();
  assert.equal(host.querySelector('.im-assistant-bubble').textContent,'新的欢迎消息');
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='投诉入口').click());await settle();
  assert.equal(host.querySelector('.im-assistant-bubble').textContent,'请描述问题');
  assert.match(host.textContent,/消息预览/);
});

function readCopyFixture(overrides = {}) {
  return {
    version: 0,
    enabled: false,
    publicOrigin: null,
    callbackPath: "/api/v1/im/read-events/copy",
    callbackUrl: null,
    receiverReady: true,
    status: "DISABLED",
    updatedAt: null,
    lastVerifiedAt: null,
    lastEventAt: null,
    serverNow: "2026-11-01T04:00:00.000Z",
    ...overrides,
  };
}

const findButton = (host, label) => [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === label);
const navButton = (host, label) => [...host.querySelectorAll("nav button")].find((button) => button.textContent.includes(label));
async function clickButton(host, label) {
  const button = findButton(host, label);
  assert.ok(button, `button ${label}`);
  await act(async () => button.click());
  await settle();
}
async function mountAssistant(t, request, props = {}) {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(createElement(SupportAssistantSettings, { active: true, request, canConfigure: true, ...props })));
  await settle();
  return { host, root };
}
async function openIntegration(host) {
  const button = [...host.querySelectorAll("nav button")].find((item) => item.textContent.includes("阅读状态同步"));
  assert.ok(button, "integration nav item");
  await act(async () => button.click());
  await settle();
}
async function setInputValue(host, selector, value) {
  const input = host.querySelector(selector);
  assert.ok(input, `input ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new browser.Event("input", { bubbles: true })); });
  await settle();
}

test("assistant read-copy settings allow closed empty origin and derive callback from saved origin", async t => {
  let reads=0; const writes=[]; let copied="";
  const base=readCopyFixture();
  const request=async(path,body)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");
    if(body===undefined){reads++;return base;}
    writes.push(body);
    return readCopyFixture({...body,version:body.version+1,callbackUrl:body.publicOrigin?`${body.publicOrigin}/api/v1/im/read-events/copy`:null,status:body.enabled?"WAITING_FOR_CALLBACK":"DISABLED",updatedAt:"2026-11-01T04:05:00.000Z"});
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true});
  await openIntegration(host);
  assert.equal(reads,1);
  assert.match(host.textContent,/已关闭/);
  assert.equal(host.querySelector("input[type=url]").value,"");
  assert.equal(findButton(host,"保存设置").disabled,true);
  await setInputValue(host,"input[type=url]","https://im-dev.example.com");
  assert.equal(writes.length,0);
  assert.equal(host.querySelector("#read-copy-callback").value,"","callback URL must not be derived from an unsaved draft");
  assert.match(host.textContent,/域名尚未保存，此处仍为原地址/);
  await clickButton(host,"保存设置");
  assert.equal(writes.length,1);
  assert.deepEqual(Object.keys(writes[0]).sort(),["enabled","operationId","publicOrigin","version"]);
  assert.equal(writes[0].enabled,false);
  assert.equal(writes[0].publicOrigin,"https://im-dev.example.com");
  assert.match(writes[0].operationId,/^[A-Za-z0-9_-]{16,80}$/);
  assert.equal(host.querySelector("#read-copy-callback").value,"https://im-dev.example.com/api/v1/im/read-events/copy");
  assert.equal(findButton(host,"复制").disabled,false);
  Object.defineProperty(browser.navigator,"clipboard",{value:{writeText:async value=>{copied=value;}},configurable:true});
  await clickButton(host,"复制");
  assert.equal(copied,"https://im-dev.example.com/api/v1/im/read-events/copy");
  assert.match(host.textContent,/已复制回调地址/);
  await setInputValue(host,"input[type=url]","");
  assert.equal(host.querySelector("#read-copy-callback").value,"https://im-dev.example.com/api/v1/im/read-events/copy","saved callback stays until the draft is saved");
  await clickButton(host,"保存设置");
  assert.equal(writes.length,2);
  assert.equal(writes[1].version,1);
  assert.equal(writes[1].publicOrigin,null);
  assert.equal(host.querySelector("#read-copy-callback").value,"");
  assert.equal(findButton(host,"复制").disabled,true);
});

test("assistant read-copy settings enable path explains waiting and never claims healthy sync", async t => {
  const writes=[];
  const base=readCopyFixture({receiverReady:true,enabled:false,status:"DISABLED"});
  const request=async(path,body)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");
    if(body===undefined)return base;
    writes.push(body);
    return readCopyFixture({...body,version:body.version+1,callbackUrl:`${body.publicOrigin}/api/v1/im/read-events/copy`,status:body.enabled?"WAITING_FOR_CALLBACK":"DISABLED",updatedAt:"2026-11-01T04:05:00.000Z"});
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true});
  await openIntegration(host);
  const checkboxInput=host.querySelector(".im-assistant-check input[type=checkbox]");
  await act(async()=>checkboxInput.click());await settle();
  assert.equal(host.querySelector("[data-slot=checkbox]").getAttribute("aria-checked"),"true");
  assert.match(host.textContent,/启用前请填写公网 HTTPS 域名/);
  assert.equal(findButton(host,"保存设置").disabled,true);
  await setInputValue(host,"input[type=url]","https://im-dev.example.com");
  await clickButton(host,"保存设置");
  assert.equal(writes.length,1);
  assert.equal(writes[0].enabled,true);
  assert.match(host.textContent,/等待云信通知/);
  assert.match(host.textContent,/请确认已在云信后台填写回调地址/);
  assert.match(host.textContent,/最近地址验证/);
  assert.match(host.textContent,/最近阅读通知/);
  assert.doesNotMatch(host.textContent,/已收到云信通知/);
});

test("assistant read-copy settings retry an uncertain save with the exact original payload", async t => {
  const writes=[]; let fail=true;
  const base=readCopyFixture();
  const request=async(path,body)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");
    if(body===undefined)return base;
    writes.push(body);
    if(fail){fail=false;throw Object.assign(new Error("network"),{status:0});}
    return readCopyFixture({...body,version:body.version+1,callbackUrl:`${body.publicOrigin}/api/v1/im/read-events/copy`,status:"WAITING_FOR_CALLBACK",updatedAt:"2026-11-01T04:05:00.000Z"});
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true});
  await openIntegration(host);
  await setInputValue(host,"input[type=url]","https://im-dev.example.com");
  await clickButton(host,"保存设置");
  assert.match(host.textContent,/保存结果尚未确认/);
  assert.equal(host.querySelector("input[type=url]").disabled,true);
  assert.equal(findButton(host,"重试保存").disabled,false);
  assert.equal(writes.length,1);
  await clickButton(host,"重试保存");
  assert.equal(writes.length,2);
  assert.deepEqual(writes[0],writes[1]);
  assert.match(host.textContent,/同步设置已保存/);
  assert.equal(host.querySelector("input[type=url]").disabled,false);
});

test("assistant read-copy settings preserve a conflicting draft until an explicit reload", async t => {
  let reads=0;
  const first=readCopyFixture({version:1,enabled:false,publicOrigin:"https://old.example.com",callbackUrl:"https://old.example.com/api/v1/im/read-events/copy",status:"DISABLED",updatedAt:"2026-11-01T01:00:00.000Z"});
  const second=readCopyFixture({version:2,enabled:false,publicOrigin:"https://new.example.com",callbackUrl:"https://new.example.com/api/v1/im/read-events/copy",status:"DISABLED",updatedAt:"2026-11-01T02:00:00.000Z"});
  const request=async(path,body)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");
    if(body!==undefined)throw Object.assign(new Error("conflict"),{status:409});
    reads++;return reads===1?first:second;
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true});
  await openIntegration(host);
  await setInputValue(host,"input[type=url]","https://draft.example.com");
  await clickButton(host,"保存设置");
  assert.match(host.textContent,/设置或服务状态已变化/);
  assert.equal(host.querySelector("input[type=url]").value,"https://draft.example.com");
  assert.equal(host.querySelector("input[type=url]").disabled,true);
  assert.equal(reads,1,"conflict must not auto-overwrite the draft");
  await clickButton(host,"刷新");
  assert.match(host.textContent,/刷新会放弃未保存的修改/);
  assert.equal(host.querySelector("input[type=url]").value,"https://draft.example.com");
  await clickButton(host,"取消");
  assert.equal(host.querySelector("input[type=url]").value,"https://draft.example.com");
  await clickButton(host,"刷新");
  await clickButton(host,"确认放弃");
  assert.equal(reads,2);
  assert.equal(host.querySelector("input[type=url]").value,"https://new.example.com");
  assert.doesNotMatch(host.textContent,/设置或服务状态已变化/);
});

test("assistant read-copy settings separate integration permission and undeployed API states", async t => {
  const base=readCopyFixture();
  const permissionRequest=async(path)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");return base;
  };
  const readOnly=await mountAssistant(t,permissionRequest,{canConfigure:true,canConfigureIntegration:false});
  await openIntegration(readOnly.host);
  assert.equal(readOnly.host.querySelector("[data-slot=checkbox]").getAttribute("aria-disabled"),"true");
  assert.equal(readOnly.host.querySelector("input[type=url]").disabled,true);
  assert.equal(findButton(readOnly.host,"保存设置").disabled,true);
  assert.match(readOnly.host.textContent,/配置客服消息接入/);
  assert.match(readOnly.host.textContent,/修改需要“配置客服消息接入”权限/);
  const pageSource=readFileSync(path.join(adminRoot,"src/workspace/page-content.tsx"),"utf8");
  assert.match(pageSource,/SupportAssistantSettings[^>]*canConfigureIntegration=/);
  assert.match(pageSource,/SupportManagementPane[^>]*canConfigureIntegration=/);
  assert.match(pageSource,/SupportAssistantSettings[^>]*onWriteLockChange=\{onWriteLockChange\}/);
  assert.match(pageSource,/SupportManagementPane[^>]*onWriteLockChange=\{onWriteLockChange\}/);
  assert.match(readFileSync(path.join(adminRoot,"src/views/im-support-management.tsx"),"utf8"),/SupportAssistantSettings[^>]*canConfigureIntegration=[^>]*onWriteLockChange=\{onWriteLockChange\}/);

  const missingRequest=async(path)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    throw Object.assign(new Error("missing"),{status:404});
  };
  const missing=await mountAssistant(t,missingRequest,{canConfigureIntegration:true});
  await openIntegration(missing.host);
  assert.match(missing.host.textContent,/同步服务尚未部署/);
  assert.match(missing.host.textContent,/无法读取同步设置/);
  assert.equal(missing.host.querySelector("input[type=url]"),null);
  assert.equal(findButton(missing.host,"保存设置"),undefined);
});

test("assistant read-copy settings reject unknown and stale status without claiming sync", async t => {
  let reads=0;
  const unknown=readCopyFixture({status:"FUTURE_STATE",receiverReady:true,enabled:false,publicOrigin:null});
  const inconsistent=readCopyFixture({status:"CALLBACK_OBSERVED",receiverReady:true,enabled:true,publicOrigin:"https://im.example.com",callbackUrl:"https://im.example.com/api/v1/im/read-events/copy",lastVerifiedAt:null,lastEventAt:null});
  const receiverDown=readCopyFixture({status:"WAITING_FOR_CALLBACK",receiverReady:false,enabled:false,publicOrigin:null});
  const request=async(path)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");reads++;return reads===1?unknown:reads===2?inconsistent:receiverDown;
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true});
  await openIntegration(host);
  assert.match(host.textContent,/状态未知/);
  assert.match(host.textContent,/暂时无法确认同步状态/);
  await clickButton(host,"刷新");
  assert.match(host.textContent,/状态待核对/);
  assert.match(host.textContent,/设置与服务状态不一致/);
  await clickButton(host,"刷新");
  assert.match(host.textContent,/暂不可启用/);
  assert.equal(host.querySelector("[data-slot=checkbox]").getAttribute("aria-disabled"),"true");
  assert.equal(reads,3);
});

test("assistant read-copy settings serialize explicit reload and retry while an unknown save is unresolved", async t => {
  const initial=readCopyFixture({version:1,publicOrigin:"https://saved.example.com",callbackUrl:"https://saved.example.com/api/v1/im/read-events/copy",updatedAt:"2026-11-01T04:00:00.000Z"});
  const pending=patrolDeferred(); const bodies=[]; const locks=[];
  let reads=0,writes=0;
  const request=async(path,body)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");
    if(body===undefined){reads++;return reads===1?initial:reads===2?pending.promise:initial;}
    writes++;bodies.push(structuredClone(body));
    if(writes===1)throw Object.assign(new Error("network"),{status:0});
    return readCopyFixture({...body,version:2,publicOrigin:body.publicOrigin,callbackUrl:body.publicOrigin?`${body.publicOrigin}/api/v1/im/read-events/copy`:null,status:"WAITING_FOR_CALLBACK",updatedAt:"2026-11-01T04:05:00.000Z"});
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true,onWriteLockChange:value=>locks.push(value)});
  await openIntegration(host);
  await setInputValue(host,"input[type=url]","https://new.example.com");
  await clickButton(host,"保存设置");
  assert.match(host.textContent,/保存结果尚未确认/);
  assert.equal(writes,1);assert.equal(locks.at(-1),true);
  await clickButton(host,"刷新");
  await clickButton(host,"确认放弃");
  assert.equal(reads,2);assert.equal(locks.at(-1),true);
  assert.equal(findButton(host,"重试保存").disabled,true);
  await clickButton(host,"重试保存");
  assert.equal(writes,1);
  assert.equal(findButton(host,"刷新").disabled,true);
  await clickButton(host,"刷新");
  assert.equal(reads,2);
  pending.resolve(initial);await settle();
  assert.equal(writes,1);
  assert.equal(host.querySelector("input[type=url]").value,"https://saved.example.com");
  assert.equal(locks.at(-1),false);
  assert.doesNotMatch(host.textContent,/保存结果尚未确认/);
});

test("assistant read-copy settings ignore an older read response after a newer read", async t => {
  const first=patrolDeferred(),second=patrolDeferred();let reads=0;
  const request=async(path)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");reads++;
    return reads===1?first.promise:second.promise;
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true});
  await openIntegration(host);
  assert.equal(reads,1);
  await act(async()=>navButton(host,"咨询开场").click());await settle();
  await openIntegration(host);
  assert.equal(reads,2);
  second.resolve(readCopyFixture({publicOrigin:"https://new.example.com",callbackUrl:"https://new.example.com/api/v1/im/read-events/copy"}));await settle();
  assert.equal(host.querySelector("input[type=url]").value,"https://new.example.com");
  first.resolve(readCopyFixture({publicOrigin:"https://old.example.com",callbackUrl:"https://old.example.com/api/v1/im/read-events/copy"}));await settle();
  assert.equal(host.querySelector("input[type=url]").value,"https://new.example.com");
  assert.equal(host.querySelector(".im-assistant-loading"),null);
});

test("assistant read-copy settings withdraw the projection after refresh returns 403", async t => {
  let reads=0;
  const initial=readCopyFixture({publicOrigin:"https://saved.example.com",callbackUrl:"https://saved.example.com/api/v1/im/read-events/copy"});
  const request=async(path)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");reads++;
    if(reads===1)return initial;
    throw Object.assign(new Error("forbidden"),{status:403});
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true});
  await openIntegration(host);
  assert.equal(host.querySelector("#read-copy-callback").value,"https://saved.example.com/api/v1/im/read-events/copy");
  await clickButton(host,"刷新");
  assert.match(host.textContent,/你没有查看同步设置的权限/);
  assert.match(host.textContent,/无法查看同步设置/);
  assert.match(host.textContent,/无法查看同步设置/);
  assert.equal(host.querySelector("#read-copy-callback"),null);
  assert.equal(findButton(host,"复制"),undefined);
  assert.equal(findButton(host,"保存设置"),undefined);
  assert.doesNotMatch(host.textContent,/saved\.example\.com/);
});

test("assistant read-copy settings keep denial when a late success arrives after 403", async t => {
  const stale=patrolDeferred();let reads=0;
  const initial=readCopyFixture({publicOrigin:"https://saved.example.com",callbackUrl:"https://saved.example.com/api/v1/im/read-events/copy"});
  const request=async(path)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");reads++;
    if(reads===1)return initial;
    if(reads===2)return stale.promise;
    throw Object.assign(new Error("forbidden"),{status:403});
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true});
  await openIntegration(host);
  await clickButton(host,"刷新");
  await act(async()=>navButton(host,"咨询开场").click());await settle();
  await openIntegration(host);
  assert.match(host.textContent,/你没有查看同步设置的权限/);
  assert.equal(host.querySelector("#read-copy-callback"),null);
  stale.resolve(readCopyFixture({publicOrigin:"https://late.example.com",callbackUrl:"https://late.example.com/api/v1/im/read-events/copy"}));await settle();
  assert.match(host.textContent,/你没有查看同步设置的权限/);
  assert.equal(host.querySelector("#read-copy-callback"),null);
  assert.doesNotMatch(host.textContent,/late\.example\.com/);
});

test("assistant read-copy settings retain marked stale data on 500 but disable writes", async t => {
  let reads=0;
  const initial=readCopyFixture({publicOrigin:"https://saved.example.com",callbackUrl:"https://saved.example.com/api/v1/im/read-events/copy"});
  const request=async(path)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");reads++;
    if(reads===1)return initial;
    throw Object.assign(new Error("server"),{status:500});
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true});
  await openIntegration(host);
  await clickButton(host,"刷新");
  assert.match(host.textContent,/上次读取的设置/);
  assert.match(host.textContent,/操作未完成，请重试|服务暂时无法完成请求/);
  assert.equal(host.querySelector("#read-copy-callback").value,"https://saved.example.com/api/v1/im/read-events/copy");
  assert.equal(host.querySelector("input[type=url]").disabled,true);
  assert.equal(findButton(host,"复制").disabled,false);
  assert.equal(findButton(host,"保存设置").disabled,true);
});

test("assistant read-copy settings hold the workspace write lock while a save is pending and after UNKNOWN", async t => {
  let rejectPut; const pendingPut=new Promise((_,reject)=>{rejectPut=reject;}); const locks=[];
  const initial=readCopyFixture({version:1,publicOrigin:"https://saved.example.com",callbackUrl:"https://saved.example.com/api/v1/im/read-events/copy"});
  const request=async(path,body)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");
    if(body!==undefined)return pendingPut;
    return initial;
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true,onWriteLockChange:value=>locks.push(value)});
  await openIntegration(host);
  await setInputValue(host,"input[type=url]","https://new.example.com");
  await clickButton(host,"保存设置");
  assert.equal(locks.at(-1),true,"pending PUT must lock the workspace");
  rejectPut(Object.assign(new Error("network"),{status:0}));await settle();
  assert.match(host.textContent,/保存结果尚未确认/);
  assert.equal(locks.at(-1),true,"UNKNOWN must keep the workspace locked");
  await clickButton(host,"刷新");
  await clickButton(host,"确认放弃");
  assert.equal(locks.at(-1),false,"a successful explicit read unlocks");
});

test("assistant read-copy settings hold unknown write lock through 403 and unlock after a successful read", async t => {
  const locks=[];let reads=0,writes=0;
  const initial=readCopyFixture({version:1,publicOrigin:"https://saved.example.com",callbackUrl:"https://saved.example.com/api/v1/im/read-events/copy"});
  const committed=readCopyFixture({version:2,enabled:true,publicOrigin:"https://new.example.com",callbackUrl:"https://new.example.com/api/v1/im/read-events/copy",status:"WAITING_FOR_CALLBACK",updatedAt:"2026-11-01T04:05:00.000Z"});
  const request=async(path,body)=>{
    if(path==="/im/support-settings") return {version:0,serviceMessage:"欢迎",complaintMessage:"请留言",updatedAt:null};
    assert.equal(path,"/im/read-copy-settings");
    if(body===undefined){reads++;if(reads===1)return initial;if(reads===2)throw Object.assign(new Error("forbidden"),{status:403});return committed;}
    writes++;throw Object.assign(new Error("network"),{status:0});
  };
  const {host}=await mountAssistant(t,request,{canConfigureIntegration:true,onWriteLockChange:value=>locks.push(value)});
  await openIntegration(host);
  await setInputValue(host,"input[type=url]","https://new.example.com");
  await clickButton(host,"保存设置");
  assert.match(host.textContent,/保存结果尚未确认/);
  assert.equal(locks.at(-1),true);
  await clickButton(host,"刷新");
  await clickButton(host,"确认放弃");
  assert.match(host.textContent,/你没有查看同步设置的权限/);
  assert.match(host.textContent,/此前保存结果尚未确认/);
  assert.equal(host.querySelector("#read-copy-callback"),null);
  assert.equal(findButton(host,"复制"),undefined);
  assert.equal(findButton(host,"保存设置"),undefined);
  assert.equal(locks.at(-1),true);
  await clickButton(host,"刷新");
  assert.equal(host.querySelector("input[type=url]").value,"https://new.example.com");
  assert.equal(locks.at(-1),false);
  assert.equal(writes,1);assert.equal(reads,3);
  assert.doesNotMatch(host.textContent,/此前保存结果尚未确认/);
});
