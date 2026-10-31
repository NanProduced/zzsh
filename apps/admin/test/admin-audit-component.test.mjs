import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/workspace/audit" });
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
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/admin-audit"),
  configFile: false,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { AdminAuditView } = await vite.ssrLoadModule("/src/views/admin-audit-view.tsx");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function snapshot(permissions) {
  return {
    authenticated: true,
    adminUserId: "admin-boss",
    user: { name: "Boss", username: "zz00001", displayUsername: "ZZ00001", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: true, passwordChangeRequired: false },
    session: { id: "session-1", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions,
  };
}

const auditEvent = (id, action, details) => ({
  eventId: id,
  actor: { username: "zz00002", displayUsername: "ZZ00002", name: "审批人" },
  action,
  objectType: "admin_user",
  objectId: "admin_staff",
  outcome: "SUCCESS",
  reason: null,
  requestId: null,
  occurredAt: "2026-09-24T00:00:00.000Z",
  details,
});

let calls = [];

async function mockFetch(input, init = {}) {
  const url = new URL(String(input), browser.location.href);
  calls.push({ path: url.pathname, params: url.searchParams });
  if (init.method && init.method !== "GET") throw new Error("audit view must not write");
  if (url.searchParams.get("cursor") === "AC1") {
    return json({ events: [auditEvent("e3", "admin.frozen", { note: "page2" })], nextCursor: null, scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" });
  }
  return json({
    events: [
      auditEvent("e1", "admin.account.updated", { username: "zz00002", before: { name: "甲" }, after: { name: "乙" } }),
      auditEvent("e2", "admin.role.updated", { roleCode: "staff_admin" }),
    ],
    nextCursor: "AC1",
    scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT",
  });
}

function fieldValue(view, name) {
  const value = view.rootNode.querySelector(`input[name="${name}"]`)?.value ?? null;
  return value === "ALL" ? "" : value;
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

async function click(element) {
  await act(async () => { element.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

function setInput(element, value) {
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
  setValue.call(element, value);
  element.dispatchEvent(new browser.Event("input", { bubbles: true }));
}

const tableText = (view) => view.rootNode.querySelector("tbody")?.textContent ?? "";

async function renderView(props = {}) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  let latest = props;
  const render = async (extra = {}) => {
    latest = { ...latest, ...extra };
    await act(async () => {
      root.render(createElement(AdminAuditView, latest));
    });
  };
  await render();
  return { rootNode, root, render, cleanup: async () => { await act(async () => root.unmount()); rootNode.remove(); } };
}

test("game scope action is selectable and carried into the audit read", async () => {
  calls = [];
  globalThis.fetch = mockFetch;
  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: { action: "admin.game_scope.assigned" } });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.equal(calls[0].params.get("action"), "admin.game_scope.assigned");
    const trigger = view.rootNode.querySelector('[aria-label="操作类型"]');
    assert.ok(trigger && trigger.getAttribute("role") === "combobox", "action filter is the project Select");
    assert.equal(fieldValue(view, "action"), "admin.game_scope.assigned");
    await click(trigger);
    await waitFor(() => browser.document.querySelector('[role="option"]'));
    const option = [...browser.document.querySelectorAll('[role="option"]')].find((item) => item.getAttribute("aria-selected") === "true");
    assert.ok(option, "existing action picker must include game scope events");
    assert.equal(option.textContent.trim(), trigger.querySelector('[data-slot="select-value"]').textContent.trim());
  } finally { await view.cleanup(); }
});

test("cursor stack paginates and safety details collapse by default", async () => {
  calls = [];
  globalThis.fetch = mockFetch;
  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.equal(calls.length >= 1, true);
    assert.equal(calls[0].params.get("limit"), "25");
    assert.equal(calls[0].params.get("cursor"), null, "first page carries no cursor");

    // B2: details 默认收起,内容保留,点击可展开
    const detail = view.rootNode.querySelector("details");
    assert.ok(detail, "safety detail cell renders a details element");
    assert.equal(detail.hasAttribute("open"), false, "collapsed by default");
    const summaryEl = detail.querySelector("summary");
    assert.equal(summaryEl.textContent.trim(), "详情");
    assert.match(detail.querySelector("dl").textContent, /账号zz00002/, "details render as a Chinese key-value list");
    assert.equal(tableText(view).includes("admin.account.updated"), false, "raw action code is only in the tooltip");
    assert.match(view.rootNode.textContent, /时间（北京时间）/);
    assert.match(view.rootNode.textContent, /本页 \d+ 条/);
    await click(summaryEl);
    assert.equal(detail.open, true, "native summary click toggles open");

    // B1: 下一页 → 第 2 页
    const next = [...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "下一页");
    assert.equal(next.disabled, false, "page 1 has a next cursor");
    const prev = [...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "上一页");
    assert.equal(prev.disabled, true, "first page cannot go back");
    assert.ok(!view.rootNode.textContent.includes("回到首页"), "no home button on page 1");
    await click(next);
    await waitFor(() => tableText(view).includes("冻结管理员"));
    assert.equal(tableText(view).includes("修改管理员资料"), false, "page 2 replaced page 1");
    assert.match(view.rootNode.textContent, /第 2 页/);
    const cursorCall = calls.find((item) => item.params.get("cursor") === "AC1");
    assert.ok(cursorCall, "page 2 requests the next cursor");
    const home = [...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "回到首页");
    assert.ok(home, "home button appears beyond page 1");
    assert.equal([...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "下一页").disabled, true, "last page has no next cursor");

    // 上一页还原
    await click([...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "上一页"));
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.match(view.rootNode.textContent, /第 1 页/);
    assert.equal(tableText(view).includes("冻结管理员"), false);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("initialQuery backfills the filters and submit resets the cursor stack", async () => {
  calls = [];
  globalThis.fetch = mockFetch;
  const changes = [];
  const view = await renderView({
    snapshot: snapshot(["admin.audit.read"]),
    initialQuery: { action: "admin.account.updated", actorUsername: "zz00002" },
    onQueryChange: (query) => changes.push(query),
  });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    const actorInput = [...view.rootNode.querySelectorAll("form label")].find((label) => label.textContent.includes("操作者账号")).querySelector("input");
    assert.equal(view.rootNode.querySelectorAll("form select").length, 0, "filters use the project Select, not native selects");
    assert.equal(fieldValue(view, "action"), "admin.account.updated", "select restored from initialQuery");
    assert.equal(actorInput.value, "zz00002", "text input restored from initialQuery");
    assert.equal(calls[0].params.get("action"), "admin.account.updated", "first load used the restored filter");
    assert.equal(calls[0].params.get("actorUsername"), "zz00002");

    // 翻到第 2 页后再提交筛选,游标栈回到第 1 页
    await click([...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "下一页"));
    await waitFor(() => tableText(view).includes("冻结管理员"));
    setInput(actorInput, "ZZ00001");
    const form = view.rootNode.querySelector("form");
    await act(async () => { form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
    assert.deepEqual(changes.at(-1), { action: "admin.account.updated", actorUsername: "ZZ00001" }, "submit reports normalized filters");
    const resetCall = calls.at(-1);
    assert.equal(resetCall.params.get("cursor"), null, "submit restarts from the first cursor");
    assert.equal(resetCall.params.get("actorUsername"), "ZZ00001");

    // B3: 外部 query 变化回填表单
    await view.render({ initialQuery: { objectType: "admin_role" } });
    await settle();
    assert.equal(fieldValue(view, "action"), "", "stale action filter cleared");
    assert.equal(actorInput.value, "", "stale actor filter cleared");
    assert.equal(fieldValue(view, "objectType"), "admin_role", "new query backfills objectType");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("without permission the view refuses to render audit data", async () => {
  calls = [];
  globalThis.fetch = mockFetch;
  const view = await renderView({ snapshot: snapshot(["admin.account.read"]), initialQuery: {} });
  try {
    await waitFor(() => view.rootNode.textContent.includes("当前账号没有账号与权限审计读取权限"));
    assert.equal(calls.length, 0, "no audit request without the permission");
    assert.equal(view.rootNode.textContent.includes("修改管理员资料"), false);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("audit data clears when actor and session context changes before the new read returns", async () => {
  calls = [];
  let auditCalls = 0;
  let releaseSecondAudit = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/security/audit/events")) {
      auditCalls += 1;
      if (auditCalls === 1) return json({ events: [auditEvent("actor-a", "admin.account.updated", { owner: "A" })], nextCursor: null, scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" });
      if (auditCalls === 2) return new Promise((resolve) => { releaseSecondAudit = () => resolve(json({ events: [auditEvent("actor-b", "admin.frozen", { owner: "B" })], nextCursor: null, scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" })); });
    }
    return mockFetch(input, init);
  };
  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    const nextSnapshot = {
      ...snapshot(["admin.audit.read"]),
      adminUserId: "admin-staff",
      user: { name: "审批人", username: "zz00002", displayUsername: "ZZ00002", twoFactorEnabled: true },
      session: { ...snapshot().session, id: "session-2" },
    };
    await view.render({ snapshot: nextSnapshot, refreshNonce: 1 });
    await settle();
    assert.equal(tableText(view).includes("修改管理员资料"), false, "old actor audit data is cleared while the new read is pending");
    assert.ok(releaseSecondAudit, "new actor audit read is held");
    releaseSecondAudit();
    await waitFor(() => tableText(view).includes("冻结管理员"));
  } finally {
    if (releaseSecondAudit) releaseSecondAudit();
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("StrictMode restores audit reads and unmount rejects late responses", async () => {
  calls = [];
  let auditCalls = 0;
  let releaseOld;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/security/audit/events")) {
      auditCalls += 1;
      if (auditCalls === 1) return new Promise((resolve) => { releaseOld = () => resolve(json({ events: [auditEvent("strict-old", "admin.account.updated", { owner: "old" })], nextCursor: null, scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" })); });
      return json({ events: [auditEvent("strict-new", "admin.frozen", { owner: "new" })], nextCursor: null, scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" });
    }
    return mockFetch(input, init);
  };
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(AdminAuditView, { snapshot: snapshot(["admin.audit.read"]), initialQuery: {} }))));
    await waitFor(() => tableText({ rootNode }).includes("冻结管理员"));
    assert.equal(tableText({ rootNode }).includes("修改管理员资料"), false, "StrictMode cleanup drops the first setup response");
    releaseOld();
    await settle();
    assert.equal(tableText({ rootNode }).includes("冻结管理员"), true, "the rebuilt effect remains live");
  } finally {
    await act(async () => root.unmount());
    rootNode.remove();
  }

  let releaseLate;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/security/audit/events")) {
      return new Promise((resolve) => { releaseLate = () => resolve(json({ events: [auditEvent("late", "admin.role.updated", { owner: "late" })], nextCursor: null, scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" })); });
    }
    return mockFetch(input, init);
  };
  const late = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => releaseLate !== undefined);
  } finally {
    await late.cleanup();
    releaseLate();
    await settle();
    assert.equal(late.rootNode.textContent, "", "unmounted audit view ignores a late response");
    globalThis.fetch = undefined;
  }
});

test("initial loading shows skeleton and '正在读取…', never '0条' or empty state", async () => {
  let releaseLoad;
  globalThis.fetch = async () => new Promise((resolve) => {
    releaseLoad = () => resolve(json({
      events: [auditEvent("e1", "admin.account.updated", {})],
      nextCursor: null,
      scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT",
    }));
  });

  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    assert.match(view.rootNode.textContent, /正在读取…/);
    assert.equal(view.rootNode.textContent.includes("0 条"), false, "never shows 0 条 while initial loading");
    assert.equal(view.rootNode.textContent.includes("暂无"), false, "never shows 暂无 while initial loading");
    const skeletons = view.rootNode.querySelectorAll('[data-slot="skeleton"]');
    assert.ok(skeletons.length >= 5, "renders skeleton placeholder rows while loading");

    releaseLoad();
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.match(view.rootNode.textContent, /1 条/);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("first page empty without filters shows '当前可见范围暂无账号与权限事件'", async () => {
  globalThis.fetch = async () => json({ events: [], nextCursor: null, scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" });

  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => view.rootNode.textContent.includes("当前可见范围暂无账号与权限事件"));
    assert.match(view.rootNode.textContent, /0 条/);
    assert.equal(view.rootNode.textContent.includes("清除筛选"), false, "no clear filters button when query has no filters");
    assert.equal(view.rootNode.textContent.includes("新建"), false, "no create action on audit records");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("first page empty with filters shows '当前筛选无匹配记录' and clear filters resets query", async () => {
  calls = [];
  const changes = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    calls.push({ path: url.pathname, params: url.searchParams });
    if (url.searchParams.get("action") === "admin.frozen") {
      return json({ events: [], nextCursor: null, scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" });
    }
    return json({
      events: [auditEvent("e1", "admin.account.updated", {})],
      nextCursor: null,
      scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT",
    });
  };

  const view = await renderView({
    snapshot: snapshot(["admin.audit.read"]),
    initialQuery: { action: "admin.frozen" },
    onQueryChange: (q) => changes.push(q),
  });
  try {
    await waitFor(() => view.rootNode.textContent.includes("当前筛选无匹配记录"));
    assert.match(view.rootNode.textContent, /0 条/);
    const clearBtn = [...view.rootNode.querySelectorAll("button")].find((b) => b.textContent.trim() === "清除筛选");
    assert.ok(clearBtn, "shows clear filters button");

    await click(clearBtn);
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.deepEqual(changes.at(-1), {}, "onQueryChange reports cleared query");
    assert.equal(calls.at(-1).params.get("action"), null, "clear filters re-fetched without action");
    assert.match(view.rootNode.textContent, /1 条/);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("non-first page empty shows '当前页暂无记录' with back and home buttons", async () => {
  calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    calls.push({ path: url.pathname, params: url.searchParams });
    if (url.searchParams.get("cursor") === "PAGE2") {
      return json({ events: [], nextCursor: null, scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT" });
    }
    return json({
      events: [auditEvent("e1", "admin.account.updated", {})],
      nextCursor: "PAGE2",
      scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT",
    });
  };

  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    const nextBtn = [...view.rootNode.querySelectorAll("button")].find((b) => b.textContent.trim() === "下一页");
    assert.ok(nextBtn && !nextBtn.disabled);
    await click(nextBtn);

    await waitFor(() => view.rootNode.textContent.includes("当前页暂无记录"));
    assert.ok(!view.rootNode.textContent.includes("当前筛选无匹配记录"), "does not confuse empty page with empty query");

    const prevBtn = [...view.rootNode.querySelectorAll("button")].find((b) => b.textContent.trim() === "返回上一页");
    assert.ok(prevBtn, "renders return to previous page button");
    await click(prevBtn);

    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.match(view.rootNode.textContent, /第 1 页/);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("initial read 500 displays failure empty state and retry recovers", async () => {
  let attempt = 0;
  globalThis.fetch = async () => {
    attempt += 1;
    if (attempt === 1) {
      return json({ error: { code: "INTERNAL_ERROR", requestId: "req-err-1" } }, 500);
    }
    return json({
      events: [auditEvent("e1", "admin.account.updated", {})],
      nextCursor: null,
      scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT",
    });
  };

  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => view.rootNode.textContent.includes("审计记录读取失败"));
    assert.match(view.rootNode.textContent, /读取失败/);
    assert.equal(view.rootNode.textContent.includes("0 条"), false, "error does not show 0 条");
    assert.equal(view.rootNode.textContent.includes("没有更多记录"), false, "error does not show end of feed");

    const retryBtn = [...view.rootNode.querySelectorAll("button")].find((b) => b.textContent.trim() === "重试");
    assert.ok(retryBtn, "retry button is available");

    await click(retryBtn);
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.match(view.rootNode.textContent, /1 条/);
    assert.equal(view.rootNode.textContent.includes("读取失败"), false);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("contract violation with missing events array throws and shows failure state", async () => {
  globalThis.fetch = async () => json({ wrongField: "not-an-array" });

  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => view.rootNode.textContent.includes("审计记录读取失败"));
    assert.match(view.rootNode.textContent, /缺少必需的 events 列表/);
    assert.equal(view.rootNode.textContent.includes("0 条"), false, "malformed response does not masquerade as 0 results");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("same query refresh failure retains existing rows and shows warning alert", async () => {
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return json({
        events: [auditEvent("e1", "admin.account.updated", {})],
        nextCursor: null,
        scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT",
      });
    }
    return json({ error: { code: "SERVICE_UNAVAILABLE", requestId: "req-down-1" } }, 503);
  };

  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.match(view.rootNode.textContent, /1 条/);

    // Trigger a refresh with the same query via refreshNonce
    await view.render({ refreshNonce: 1 });
    await waitFor(() => view.rootNode.textContent.includes("数据未更新"));

    // Previous row is still displayed!
    assert.ok(tableText(view).includes("修改管理员资料"), "retains existing records on same-query refresh failure");
    assert.match(view.rootNode.textContent, /1 条（未更新）/);
    assert.match(view.rootNode.textContent, /刷新失败：当前展示为上次成功获取的内容（未能更新）/);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("query change failure does not retain old records from previous query", async () => {
  let callCount = 0;
  globalThis.fetch = async (input) => {
    callCount += 1;
    const url = new URL(String(input), browser.location.href);
    if (url.searchParams.get("actorUsername") === "ZZ00009") {
      return json({ error: { code: "INTERNAL_ERROR" } }, 500);
    }
    return json({
      events: [auditEvent("e1", "admin.account.updated", {})],
      nextCursor: null,
      scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT",
    });
  };

  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));

    // Submit new query with different actor
    const actorInput = view.rootNode.querySelector('form input[name="actorUsername"]');
    setInput(actorInput, "ZZ00009");
    const form = view.rootNode.querySelector("form");
    await act(async () => { form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
    await settle();

    await waitFor(() => view.rootNode.textContent.includes("审计记录读取失败"));
    assert.equal(tableText(view).includes("修改管理员资料"), false, "does not leak previous records into new failed query");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("end-of-feed badge is shown when nextCursor is null and hidden when nextCursor exists", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.searchParams.get("cursor") === "PAGE2") {
      return json({
        events: [auditEvent("e2", "admin.frozen", {})],
        nextCursor: null,
        scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT",
      });
    }
    return json({
      events: [auditEvent("e1", "admin.account.updated", {})],
      nextCursor: "PAGE2",
      scope: "BOSS_ALL_GENERIC_ADMIN_AUDIT",
    });
  };

  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.equal(view.rootNode.textContent.includes("当前查询没有更多记录"), false, "no end-of-feed when nextCursor exists");

    const nextBtn = [...view.rootNode.querySelectorAll("button")].find((b) => b.textContent.trim() === "下一页");
    await click(nextBtn);
    await waitFor(() => tableText(view).includes("冻结管理员"));

    assert.ok(view.rootNode.textContent.includes("当前查询没有更多记录"), "renders end-of-feed when nextCursor is null");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("403 error or revoked permissions clears records and shows unauthorized state", async () => {
  globalThis.fetch = async () => json({ error: { code: "FORBIDDEN" } }, 403);

  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => view.rootNode.textContent.includes("当前账号没有账号与权限审计读取权限"));
    assert.equal(tableText(view).includes("修改管理员资料"), false);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("F1: page-two failure retry replays target cursor instead of resetting to first page", async () => {
  const seen = [];
  globalThis.fetch = async (input) => {
    const u = new URL(String(input), browser.location.href);
    seen.push(u.searchParams.get("cursor"));
    return seen.length === 2
      ? json({ error: { message: "fixture fail" } }, 500)
      : json({ events: [auditEvent("one", "admin.account.updated", {})], nextCursor: "AC1" });
  };
  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    await click([...view.rootNode.querySelectorAll("button")].find((b) => b.textContent === "下一页"));
    await waitFor(() => view.rootNode.textContent.includes("审计记录读取失败"));
    await click([...view.rootNode.querySelectorAll("button")].find((b) => b.textContent === "重试"));
    // Target was AC1, retry must replay AC1!
    assert.deepEqual(seen, [null, "AC1", "AC1"]);
    await waitFor(() => tableText(view).includes("修改管理员资料"));
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("F1: new filter failure retry keeps new filter with cursor=null instead of mixing with previous page cursor", async () => {
  const seen = [];
  globalThis.fetch = async (input) => {
    const u = new URL(String(input), browser.location.href);
    seen.push({ cursor: u.searchParams.get("cursor"), actor: u.searchParams.get("actorUsername") });
    return seen.length === 3
      ? json({ error: { message: "fixture fail" } }, 500)
      : json({ events: [auditEvent("one", "admin.account.updated", {})], nextCursor: "AC1" });
  };
  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    await click([...view.rootNode.querySelectorAll("button")].find((b) => b.textContent === "下一页"));
    await act(async () => setInput(view.rootNode.querySelector('input[placeholder="如 ZZ00001"]'), "ZZ00002"));
    await act(async () => view.rootNode.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    await waitFor(() => view.rootNode.textContent.includes("审计记录读取失败"));
    await click([...view.rootNode.querySelectorAll("button")].find((b) => b.textContent === "重试"));
    // Attempt 3 was cursor: null, actor: ZZ00002 (failed).
    // Attempt 4 (retry) must replay cursor: null, actor: ZZ00002 (NOT AC1)!
    assert.deepEqual(seen[2], { cursor: null, actor: "ZZ00002" });
    assert.deepEqual(seen[3], { cursor: null, actor: "ZZ00002" });
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("F2: successful refresh after 403 unlatches forbidden state and displays records", async () => {
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return callCount === 1
      ? json({ error: { code: "FORBIDDEN", message: "temporarily denied" } }, 403)
      : json({ events: [auditEvent("after-recovery", "admin.account.updated", {})], nextCursor: null });
  };
  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), refreshNonce: 0, initialQuery: {} });
  try {
    await waitFor(() => view.rootNode.textContent.includes("当前账号没有"));
    assert.equal(tableText(view), "");

    // Service recovers and user triggers workspace refresh via refreshNonce
    await view.render({ refreshNonce: 1 });
    await settle();
    await waitFor(() => tableText(view).includes("修改管理员资料"));
    assert.equal(view.rootNode.textContent.includes("当前账号没有"), false);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("outcome and Beijing time range filters are sent as ISO instants", async () => {
  calls = [];
  globalThis.fetch = mockFetch;
  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: { outcome: "FAILURE", from: "2026-10-01T08:00", to: "2026-10-02T08:00" } });
  try {
    await waitFor(() => calls.length >= 1);
    assert.equal(calls[0].params.get("outcome"), "FAILURE");
    assert.equal(calls[0].params.get("from"), "2026-10-01T00:00:00.000Z");
    assert.equal(calls[0].params.get("to"), "2026-10-02T00:00:00.000Z");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});
