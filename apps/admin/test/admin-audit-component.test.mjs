import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
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
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
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

test("cursor stack paginates and safety details collapse by default", async () => {
  calls = [];
  globalThis.fetch = mockFetch;
  const view = await renderView({ snapshot: snapshot(["admin.audit.read"]), initialQuery: {} });
  try {
    await waitFor(() => tableText(view).includes("admin.account.updated"));
    assert.equal(calls.length >= 1, true);
    assert.equal(calls[0].params.get("limit"), "25");
    assert.equal(calls[0].params.get("cursor"), null, "first page carries no cursor");

    // B2: details 默认收起,内容保留,点击可展开
    const detail = view.rootNode.querySelector("details");
    assert.ok(detail, "safety detail cell renders a details element");
    assert.equal(detail.hasAttribute("open"), false, "collapsed by default");
    const summaryEl = detail.querySelector("summary");
    assert.equal(summaryEl.textContent.trim(), "安全详情");
    assert.match(detail.querySelector("pre").textContent, /zz00002/, "JSON payload is preserved while collapsed");
    await click(summaryEl);
    assert.equal(detail.open, true, "native summary click toggles open");

    // B1: 下一页 → 第 2 页
    const next = [...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "下一页");
    assert.equal(next.disabled, false, "page 1 has a next cursor");
    const prev = [...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "上一页");
    assert.equal(prev.disabled, true, "first page cannot go back");
    assert.ok(!view.rootNode.textContent.includes("回到首页"), "no home button on page 1");
    await click(next);
    await waitFor(() => tableText(view).includes("admin.frozen"));
    assert.equal(tableText(view).includes("admin.account.updated"), false, "page 2 replaced page 1");
    assert.match(view.rootNode.textContent, /第 2 页/);
    const cursorCall = calls.find((item) => item.params.get("cursor") === "AC1");
    assert.ok(cursorCall, "page 2 requests the next cursor");
    const home = [...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "回到首页");
    assert.ok(home, "home button appears beyond page 1");
    assert.equal([...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "下一页").disabled, true, "last page has no next cursor");

    // 上一页还原
    await click([...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "上一页"));
    await waitFor(() => tableText(view).includes("admin.account.updated"));
    assert.match(view.rootNode.textContent, /第 1 页/);
    assert.equal(tableText(view).includes("admin.frozen"), false);
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
    await waitFor(() => tableText(view).includes("admin.account.updated"));
    const [actionSelect, , actorInput] = [...view.rootNode.querySelectorAll("form select, form input")];
    assert.equal(actionSelect.value, "admin.account.updated", "select restored from initialQuery");
    assert.equal(actorInput.value, "zz00002", "text input restored from initialQuery");
    assert.equal(calls[0].params.get("action"), "admin.account.updated", "first load used the restored filter");
    assert.equal(calls[0].params.get("actorUsername"), "zz00002");

    // 翻到第 2 页后再提交筛选,游标栈回到第 1 页
    await click([...view.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "下一页"));
    await waitFor(() => tableText(view).includes("admin.frozen"));
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
    assert.equal(actionSelect.value, "", "stale action filter cleared");
    assert.equal(actorInput.value, "", "stale actor filter cleared");
    const objectTypeSelect = [...view.rootNode.querySelectorAll("form select")][1];
    assert.equal(objectTypeSelect.value, "admin_role", "new query backfills objectType");
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
    assert.equal(view.rootNode.textContent.includes("admin.account.updated"), false);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});
