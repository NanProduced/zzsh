/**
 * ADM-APPROVAL-UI-2 · 审批中心导航待办角标（组件层）
 *
 * 旧测试覆盖的是「审计记录」页签的筛选 / 分页 / URL 同步 / 审计行跳转，
 * 该页签及 /audit/events 接口已整体移除。新 UI 只保留一处导航角标：
 * useApprovalPendingCount 用统一接口 scope=pending&limit=1 读 pendingCount，
 * 跟随 refreshNonce 刷新，无待办或无权限时不显示。
 *
 * 仍然渲染真实组件、拦截真实 fetch 并断言真实 DOM 与真实请求参数。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/workspace/approvals" });
browser.matchMedia = (query) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
});
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.matchMedia = browser.matchMedia;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Element = browser.Element;
globalThis.ShadowRoot = browser.ShadowRoot;
globalThis.HTMLInputElement = browser.HTMLInputElement;
globalThis.MutationObserver = browser.MutationObserver;
globalThis.ResizeObserver = browser.ResizeObserver;
globalThis.Node = browser.Node;
globalThis.Event = browser.Event;
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.CustomEvent = browser.CustomEvent;
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "sessionStorage", { value: browser.sessionStorage, configurable: true, writable: true });

const { createRoot } = await import("react-dom/client");

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  // 独立缓存目录：避免与其它 vite 测试共享 node_modules/.vite/deps 时反复重建删除。
  cacheDir: fileURLToPath(new URL("../../../tmp/approval-vite-cache/audit-navigation/", import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const { useApprovalPendingCount } = await vite.ssrLoadModule("/src/workspace/boss-touches.tsx");
const { WorkspaceNavItem } = await vite.ssrLoadModule("/src/workspace/nav-item.tsx");
const { WorkspaceSidebar } = await vite.ssrLoadModule("/src/workspace/sidebar.tsx");
const { SidebarProvider } = await vite.ssrLoadModule("/src/components/ui/sidebar.tsx");
const { workspaceMenuItems } = await vite.ssrLoadModule("/src/workspace/nav-config.ts");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function snapshot(perms = ["approval.request.read", "approval.request.approve"], isBoss = false) {
  return {
    authenticated: true,
    adminUserId: "admin-ops",
    user: { name: "运营小周", username: "zz00007", displayUsername: "ZZ00007", image: null },
    security: { status: "ACTIVE", isBoss, passwordChangeRequired: false },
    session: { id: "session-1", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions: perms,
  };
}

// ── fetch 夹具 ─────────────────────────────────────────────────────────────
let calls = [];
let pendingCountValue = 3;
let omitPendingCount = false;
let fetchShouldFail = false;

async function mockFetch(input, init = {}) {
  const url = new URL(String(input), browser.location.href);
  calls.push({ path: url.pathname, search: url.search, method: init.method ?? "GET" });
  if (fetchShouldFail) throw new Error("network unavailable");
  const body = { requests: [], nextCursor: null, scope: "pending" };
  if (!omitPendingCount) body.pendingCount = pendingCountValue;
  return json(body);
}

function resetFixtures() {
  calls = [];
  pendingCountValue = 3;
  omitPendingCount = false;
  fetchShouldFail = false;
  globalThis.fetch = mockFetch;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

function makeHost() {
  for (const previous of [...browser.document.querySelectorAll(".workspace-root")]) previous.classList.remove("workspace-root");
  const host = browser.document.createElement("div");
  host.className = "workspace-root";
  browser.document.body.appendChild(host);
  return host;
}

async function mount(element, t) {
  const host = makeHost();
  const root = createRoot(host);
  const view = {
    host,
    rerender: async (next) => { await act(async () => root.render(next)); },
  };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(element));
  return view;
}

/** hook 探针：把 useApprovalPendingCount 的真实返回值渲染成文本。 */
function Probe({ enabled, refreshNonce }) {
  const count = useApprovalPendingCount(enabled, refreshNonce);
  return createElement("output", { "data-testid": "pending-count" }, count === undefined ? "none" : String(count));
}

function withProvider(child) {
  return createElement(SidebarProvider, null, child);
}

function badgeOf(host) {
  return host.querySelector('[data-slot="sidebar-menu-badge"]');
}

// ── 1. useApprovalPendingCount 的统一接口契约 ──────────────────────────────

test("角标使用统一接口 GET /security/approvals/requests?scope=pending&limit=1 读 pendingCount", async (t) => {
  resetFixtures();
  pendingCountValue = 4;
  const view = await mount(createElement(Probe, { enabled: true, refreshNonce: 0 }), t);
  await waitFor(() => view.host.textContent.includes("4"));
  assert.equal(view.host.querySelector('[data-testid="pending-count"]').textContent, "4");
  assert.equal(calls.length, 1);
  const params = new URLSearchParams(calls[0].search);
  assert.equal(params.get("scope"), "pending");
  assert.equal(params.get("limit"), "1");
  assert.ok(calls[0].path.endsWith("/security/approvals/requests"));
});

test("pendingCount=0 时不显示角标", async (t) => {
  resetFixtures();
  pendingCountValue = 0;
  const view = await mount(createElement(Probe, { enabled: true, refreshNonce: 0 }), t);
  await waitFor(() => calls.length >= 1);
  await settle();
  assert.equal(view.host.querySelector('[data-testid="pending-count"]').textContent, "none");
});

test("服务端未返回 pendingCount 时不显示角标，不猜 0 也不猜有值", async (t) => {
  resetFixtures();
  omitPendingCount = true;
  const view = await mount(createElement(Probe, { enabled: true, refreshNonce: 0 }), t);
  await waitFor(() => calls.length >= 1);
  await settle();
  assert.equal(view.host.querySelector('[data-testid="pending-count"]').textContent, "none");
});

test("读取失败（网络错误）时不显示角标", async (t) => {
  resetFixtures();
  fetchShouldFail = true;
  const view = await mount(createElement(Probe, { enabled: true, refreshNonce: 0 }), t);
  await waitFor(() => calls.length >= 1);
  await settle();
  assert.equal(view.host.querySelector('[data-testid="pending-count"]').textContent, "none");
});

test("refreshNonce 变化会重新读取同一接口", async (t) => {
  resetFixtures();
  const view = await mount(createElement(Probe, { enabled: true, refreshNonce: 0 }), t);
  await waitFor(() => calls.length === 1);
  pendingCountValue = 7;
  await view.rerender(createElement(Probe, { enabled: true, refreshNonce: 1 }));
  await waitFor(() => calls.length === 2 && view.host.textContent.includes("7"));
  assert.deepEqual(calls.map((call) => call.search), ["?scope=pending&limit=1", "?scope=pending&limit=1"]);
});

test("关闭开关（无权限/不可见）时完全不发请求", async (t) => {
  resetFixtures();
  const view = await mount(createElement(Probe, { enabled: false, refreshNonce: 0 }), t);
  await settle();
  assert.equal(view.host.querySelector('[data-testid="pending-count"]').textContent, "none");
  assert.equal(calls.length, 0);
});

// ── 2. 角标在导航项上的渲染 ────────────────────────────────────────────────

const approvalsItem = (badge) => ({
  label: "审批中心", path: "/approvals", kind: "approvals", ...(badge === undefined ? {} : { badge }),
});
const location = { pathname: "/approvals", search: "" };

test("审批中心项有待办时渲染「待我处理 N 件」角标", async (t) => {
  resetFixtures();
  const view = await mount(withProvider(createElement(WorkspaceNavItem, {
    item: approvalsItem(5), location, onNavigate() {},
  })), t);
  await settle();
  const badge = badgeOf(view.host);
  assert.ok(badge, "有待办时显示角标");
  assert.equal(badge.getAttribute("aria-label"), "待我处理 5 件");
  assert.equal(badge.textContent.trim(), "5");
});

test("超过 99 件时角标显示 99+", async (t) => {
  resetFixtures();
  const view = await mount(withProvider(createElement(WorkspaceNavItem, {
    item: approvalsItem(150), location, onNavigate() {},
  })), t);
  await settle();
  assert.equal(badgeOf(view.host).textContent.trim(), "99+");
});

test("审批中心项没有待办时不渲染角标", async (t) => {
  resetFixtures();
  const view = await mount(withProvider(createElement(WorkspaceNavItem, {
    item: approvalsItem(undefined), location, onNavigate() {},
  })), t);
  await settle();
  assert.equal(badgeOf(view.host), null);
  assert.ok(!view.host.textContent.includes("待我处理"));
});

// ── 3. WorkspaceSidebar 端到端 ─────────────────────────────────────────────

function sidebar(snapshotValue, refreshNonce = 0) {
  return withProvider(createElement(WorkspaceSidebar, {
    snapshot: snapshotValue, location, onNavigate() {}, onSignOut() {}, refreshNonce,
  }));
}

test("菜单配置里审批中心是 kind=approvals 的唯一入口", () => {
  const items = workspaceMenuItems({ isBoss: false, permissions: ["approval.request.read"] });
  const approvals = items.filter((item) => item.kind === "approvals");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].label, "审批中心");
  assert.equal(approvals[0].badge, undefined, "静态菜单不预置角标");
});

test("侧栏有 pendingCount 时审批中心显示待办角标", async (t) => {
  resetFixtures();
  pendingCountValue = 3;
  const view = await mount(sidebar(snapshot()), t);
  await waitFor(() => badgeOf(view.host) !== null);
  assert.ok(view.host.textContent.includes("审批中心"));
  assert.equal(badgeOf(view.host).getAttribute("aria-label"), "待我处理 3 件");
  const params = new URLSearchParams(calls[0].search);
  assert.equal(params.get("scope"), "pending");
  assert.equal(params.get("limit"), "1");
});

test("侧栏无待办时审批中心不显示角标", async (t) => {
  resetFixtures();
  pendingCountValue = 0;
  const view = await mount(sidebar(snapshot()), t);
  await waitFor(() => calls.length >= 1);
  await settle();
  assert.ok(view.host.textContent.includes("审批中心"));
  assert.equal(badgeOf(view.host), null, "无待办不显示角标");
});

test("侧栏随 refreshNonce 刷新待办数量", async (t) => {
  resetFixtures();
  pendingCountValue = 2;
  const view = await mount(sidebar(snapshot(), 0), t);
  await waitFor(() => badgeOf(view.host) !== null);
  assert.equal(badgeOf(view.host).getAttribute("aria-label"), "待我处理 2 件");
  pendingCountValue = 6;
  await view.rerender(sidebar(snapshot(), 1));
  await waitFor(() => badgeOf(view.host)?.getAttribute("aria-label") === "待我处理 6 件");
  assert.equal(calls.length, 2);
});
