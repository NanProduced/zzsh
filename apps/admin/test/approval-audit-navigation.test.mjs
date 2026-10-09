import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4301/workspace/approvals" });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Element = browser.Element;
globalThis.ShadowRoot = browser.ShadowRoot;
globalThis.HTMLInputElement = browser.HTMLInputElement;
globalThis.MutationObserver = browser.MutationObserver;
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
const { ApprovalAuditView } = await vite.ssrLoadModule("/src/views/approval-audit-view.tsx");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const permissions = [
  "approval.template.read",
  "approval.request.create",
  "approval.request.read",
  "approval.request.approve",
  "approval.audit.read",
  "admin.account.read",
];

function snapshot(perms = permissions, isBoss = true) {
  return {
    authenticated: true,
    adminUserId: "admin-boss",
    user: { name: "Boss", username: "zz00001", displayUsername: "ZZ00001", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss, passwordChangeRequired: false },
    session: { id: "session-1", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions: perms,
  };
}

function summary(requestId, status, summaryText) {
  return {
    requestId,
    operationCode: "approval.test.execute",
    triggerCondition: "manual",
    payloadVersion: 1,
    payloadHash: "hash-" + requestId,
    summary: summaryText,
    status,
    statusReason: null,
    requester: { username: "zz00001", displayUsername: "ZZ00001", name: "Boss" },
    createdAt: "2026-10-06T00:00:00.000Z",
    expiresAt: "2026-10-08T00:00:00.000Z",
  };
}

function detail(requestId, status, summaryText, links = {}) {
  return {
    ...summary(requestId, status, summaryText),
    operation: { code: "approval.test.execute", triggerCondition: "manual", payloadVersion: 1, payloadHash: "hash-" + requestId, payload: { outcome: "SUCCESS" } },
    template: { id: "tpl-1", version: 1 },
    requester: { username: "zz00002", displayUsername: "ZZ00002", name: "审批人", status: "ACTIVE" },
    decision: null,
    execution: null,
    candidates: [{ username: "zz00001", displayUsername: "ZZ00001", name: "Boss", status: "ACTIVE", eligible: true, source: "TEMPLATE" }],
    history: [],
    supersedesRequestId: links.supersedes ?? null,
    supersededByRequestId: links.supersededBy ?? null,
  };
}

const auditEvent = (id, action, options = {}) => ({
  eventId: "evt-" + id,
  actor: { username: options.actorUsername ?? "zz00001", displayUsername: (options.actorUsername ?? "zz00001").toUpperCase(), name: "Boss" },
  action,
  objectType: options.objectType ?? "approval_request",
  objectId: options.objectId === undefined ? id : options.objectId,
  outcome: options.outcome ?? "SUCCESS",
  reason: options.reason ?? null,
  requestId: options.requestId === undefined ? id : options.requestId,
  occurredAt: "2026-10-06T00:00:00.000Z",
  details: options.details ?? { operationCode: "approval.test.execute" },
});

let auditCalls = [];

async function mockFetch(input, init = {}) {
  const url = new URL(String(input), browser.location.href);
  if ((init.method ?? "GET") !== "GET") return json({});
  if (url.pathname.endsWith("/security/approvals/templates")) {
    return json({ templates: [{ id: "tpl-1", operationCode: "approval.test.execute", triggerCondition: "manual", version: 1, updatedAt: null, candidates: [{ username: "zz00001", name: "Boss", status: "ACTIVE", eligible: true }] }] });
  }
  if (url.pathname.endsWith("/security/admins")) {
    return json({ admins: [{ id: "admin-boss", username: "zz00001", name: "Boss", status: "ACTIVE" }] });
  }
  if (url.pathname.endsWith("/security/approvals/requests/mine")) {
    return json({ requests: [summary("m1", "PENDING", "定位样本申请")], nextCursor: null });
  }
  if (url.pathname.endsWith("/security/approvals/requests/pending")) {
    return json({ requests: [], nextCursor: null });
  }
  if (url.pathname.endsWith("/security/approvals/requests/detail")) {
    const id = url.searchParams.get("requestId");
    if (id === "m1") return json(detail("m1", "CANCELLED", "定位样本申请", { supersedes: "m0", supersededBy: "m9" }));
    return json(detail(id ?? "m0", "PENDING", "其他申请"));
  }
  if (url.pathname.endsWith("/security/approvals/audit/events")) {
    auditCalls.push(url.search);
    const action = url.searchParams.get("action");
    const actor = url.searchParams.get("actorUsername");
    const requestId = url.searchParams.get("requestId");
    let events = [
      auditEvent("req-1", "approval.request.created", { requestId: "req_http_trace_1", details: { summary: "样本业务摘要文字", operationCode: "approval.test.execute", payloadVersion: 1, templateVersion: 1 } }),
      auditEvent("req-2", "approval.request.rejected", { actorUsername: "zz00002", requestId: "req_http_trace_2", outcome: "FAILURE", reason: "资料与当前版本不符" }),
      auditEvent("tpl-1", "approval.template.configured", { objectType: "approval_template", objectId: "tpl-1", requestId: null }),
      auditEvent("tpl-2", "approval.template.configured", { objectType: "approval_template", objectId: "tpl-2", requestId: "req_http_trace_9" }),
    ];
    if (action) events = events.filter((event) => event.action === action);
    if (requestId) events = events.filter((event) => event.objectId === requestId || event.requestId === requestId);
    if (actor) events = events.filter((event) => event.actor.username === actor.toLowerCase());
    return json({ events, nextCursor: null, scope: "BOSS_ALL_APPROVAL_EVENTS" });
  }
  throw new Error(`unexpected test request ${url.pathname}${url.search}`);
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
  assert.ok(element, "expected clickable element");
  await act(async () => { element.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

function setInput(element, value) {
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
  setValue.call(element, value);
  element.dispatchEvent(new browser.Event("input", { bubbles: true }));
}

function setSelect(element, value) {
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLSelectElement.prototype, "value").set;
  setValue.call(element, value);
  element.dispatchEvent(new browser.Event("change", { bubbles: true }));
}

function buttons(container) {
  return [...container.querySelectorAll("button")];
}

function buttonByText(text) {
  return buttons(document.body).find((button) => button.textContent.trim() === text);
}

async function renderView(props = {}) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  let latest = { snapshot: snapshot(), ...props };
  const render = async (extra = {}) => {
    latest = { ...latest, ...extra };
    await act(async () => {
      root.render(createElement(ApprovalAuditView, latest));
    });
  };
  await render();
  return { rootNode, root, render, cleanup: async () => { await act(async () => root.unmount()); rootNode.remove(); } };
}

async function openAuditTab(view) {
  const tablist = view.rootNode.querySelector('[role="tablist"]');
  await click([...tablist.querySelectorAll("button")].find((tab) => tab.textContent.includes("审计记录")));
  await waitFor(() => view.rootNode.textContent.includes("approval.request.created"));
}

test("audit tab filters reach the API, reset paging, render scope and sync the tab query", async () => {
  auditCalls = [];
  globalThis.fetch = mockFetch;
  const queryWrites = [];
  const view = await renderView({ onQueryChange: (query) => queryWrites.push(query) });
  try {
    await waitFor(() => view.rootNode.textContent.includes("定位样本申请"));
    await openAuditTab(view);
    assert.equal(auditCalls.length >= 1, true, "initial audit load happened");
    assert.ok(!auditCalls[0].includes("action="), "initial load has no filter params");
    assert.ok(view.rootNode.textContent.includes("Boss：全部审批与授权事件"), "scope label rendered");

    const form = buttonByText("查询审计").closest("form");
    const [actionSelect, objectTypeSelect] = form.querySelectorAll("select");
    const inputs = form.querySelectorAll("input");
    setSelect(actionSelect, "approval.request.rejected");
    setSelect(objectTypeSelect, "approval_request");
    setInput(inputs[0], "ZZ00002");
    setInput(inputs[1], "req-2");
    await settle();
    assert.equal(actionSelect.value, "approval.request.rejected", "action select applied");
    assert.equal(objectTypeSelect.value, "approval_request", "objectType select applied");
    await act(async () => { form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
    await waitFor(() => auditCalls.some((query) => query.includes("action=approval.request.rejected")));
    const last = auditCalls.at(-1);
    assert.ok(last.includes("action=approval.request.rejected"), "action param sent");
    assert.ok(last.includes("objectType=approval_request"), "objectType param sent");
    assert.ok(last.includes("actorUsername=ZZ00002"), "actorUsername param sent");
    assert.ok(last.includes("requestId=req-2"), "requestId param sent");
    assert.ok(!last.includes("cursor="), "filter submit restarts from the first page");
    const rows = () => [...view.rootNode.querySelectorAll("tbody tr")].map((row) => row.textContent);
    await waitFor(() => rows().every((text) => !text.includes("approval.request.created")));
    assert.ok(rows().some((text) => text.includes("approval.request.rejected")), "filtered row remains");
    const synced = queryWrites.at(-1);
    assert.equal(synced.tab, "audit");
    assert.equal(synced.action, "approval.request.rejected");
    assert.equal(synced.objectType, "approval_request");
    assert.equal(synced.actorUsername, "ZZ00002");
    assert.equal(synced.requestId, "req-2");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("audit rows expose the related request and open its detail", async () => {
  auditCalls = [];
  globalThis.fetch = mockFetch;
  const opened = [];
  const view = await renderView({ onOpenObject: (id, title) => opened.push({ id, title }) });
  try {
    await waitFor(() => view.rootNode.textContent.includes("定位样本申请"));
    await openAuditTab(view);
    const rows = [...view.rootNode.querySelectorAll("tbody tr")];
    const createdRow = rows.find((row) => row.textContent.includes("approval.request.created"));
    assert.ok(createdRow.textContent.includes("req-1"), "object id visible for tracing");
    const templateRows = rows.filter((row) => row.textContent.includes("approval.template.configured"));
    assert.equal(templateRows.length, 2, "both template events rendered");
    for (const templateRow of templateRows) {
      assert.ok(templateRow.textContent.includes("审批模板"), "object type label is business-readable");
      assert.equal([...templateRow.querySelectorAll("button")].length, 0, "template events never link to a request, even with an HTTP trace id");
    }
    const link = [...createdRow.querySelectorAll("button")].find((button) => button.textContent.trim() === "查看申请");
    await click(link);
    assert.deepEqual(opened, [{ id: "req-1", title: "审批详情" }], "row link opens the approval request object, not the HTTP trace id");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("detail renders supersede links that open the related requests", async () => {
  auditCalls = [];
  globalThis.fetch = mockFetch;
  const opened = [];
  const view = await renderView({ objectOnly: true, initialRequestId: "m1", onOpenObject: (id, title) => opened.push({ id, title }) });
  try {
    await waitFor(() => view.rootNode.textContent.includes("定位样本申请"));
    await waitFor(() => buttonByText("查看被替代的原申请") !== undefined);
    const supersededNotice = view.rootNode.textContent.includes("本申请已被另一申请替代");
    assert.equal(supersededNotice, true, "superseded notice is visible without promising the terminal request");
    await click(buttonByText("查看被替代的原申请"));
    assert.deepEqual(opened.at(-1), { id: "m0", title: "被替代的审批申请" });
    await click(buttonByText("查看替代申请"));
    assert.deepEqual(opened.at(-1), { id: "m9", title: "替代本申请的审批申请" });
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("an external query change backfills the audit filters and reloads", async () => {
  auditCalls = [];
  globalThis.fetch = mockFetch;
  const view = await renderView({ initialTab: "audit", initialQuery: { tab: "audit" } });
  try {
    await waitFor(() => view.rootNode.textContent.includes("approval.request.created"));
    const before = auditCalls.length;
    await view.render({ initialQuery: { tab: "audit", actorUsername: "zz00001" } });
    await waitFor(() => auditCalls.length > before && auditCalls.at(-1).includes("actorUsername=zz00001"));
    const form = buttonByText("查询审计").closest("form");
    assert.equal(form.querySelector("input").value, "zz00001", "filter form backfilled from the query");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("Master: external URL matching an unsubmitted draft still reloads the applied query", async () => {
  auditCalls = [];
  globalThis.fetch = mockFetch;
  const view = await renderView({ initialTab: "audit", initialQuery: { tab: "audit", actorUsername: "zz00001" } });
  try {
    await waitFor(() => auditCalls.some((query) => query.includes("actorUsername=zz00001")) && view.rootNode.querySelectorAll("tbody tr").length > 0);
    const form = buttonByText("查询审计").closest("form");
    await act(async () => setInput(form.querySelector("input"), "zz00002"));
    await settle();
    const before = auditCalls.length;
    await view.render({ initialQuery: { tab: "audit", actorUsername: "zz00002" } });
    await settle();
    await settle();
    assert.ok(auditCalls.length > before && auditCalls.at(-1).includes("actorUsername=zz00002"), "URL switched to zz00002 must reload the applied query instead of keeping zz00001 results");
    const appliedRows = [...view.rootNode.querySelectorAll("tbody tr")].map((row) => row.textContent).join("\n");
    assert.ok(appliedRows.includes("审批拒绝"), "zz00002 results are now applied");
    assert.ok(!appliedRows.includes("提交申请"), "zz00001 rows replaced");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("Master: failed new filter cannot present previous rows as current results", async () => {
  auditCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/audit/events") && url.searchParams.get("actorUsername") === "zz00002") {
      auditCalls.push(url.search);
      return json({ error: { code: "INTERNAL_ERROR", message: "fixture failure" } }, 500);
    }
    return mockFetch(input, init);
  };
  const view = await renderView({ initialTab: "audit", initialQuery: { tab: "audit", actorUsername: "zz00001" } });
  try {
    await waitFor(() => view.rootNode.querySelectorAll("tbody tr").length > 0);
    const form = buttonByText("查询审计").closest("form");
    await act(async () => setInput(form.querySelector("input"), "zz00002"));
    await click(buttonByText("查询审计"));
    await settle();
    const rows = [...view.rootNode.querySelectorAll("tbody tr")];
    assert.equal(rows.length, 0, "failed new filter must clear previous rows instead of presenting them as current results");
    assert.ok(!view.rootNode.textContent.includes("暂无符合条件"), "error state and empty state stay mutually exclusive");
    assert.ok(view.rootNode.textContent.includes("服务暂时无法完成请求"), "the failure surfaces as an error with recovery guidance");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("a late response from an older query cannot overwrite the newer results", async () => {
  auditCalls = [];
  let releaseOld = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname.endsWith("/audit/events") && url.searchParams.get("actorUsername") === "zz00001") {
      auditCalls.push(url.search);
      return new Promise((resolve) => {
        releaseOld = () => resolve(mockFetch(input, init));
      });
    }
    if (url.pathname.endsWith("/audit/events")) auditCalls.push(url.search);
    return mockFetch(input, init);
  };
  const view = await renderView({ initialTab: "audit", initialQuery: { tab: "audit", actorUsername: "zz00001" } });
  try {
    await waitFor(() => releaseOld !== null);
    const form = view.rootNode.querySelector("form");
    await act(async () => setInput(form.querySelector("input"), "zz00002"));
    await act(async () => { form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
    await waitFor(() => [...view.rootNode.querySelectorAll("tbody tr")].some((row) => row.textContent.includes("审批拒绝")));
    releaseOld();
    await settle();
    await settle();
    const rows = [...view.rootNode.querySelectorAll("tbody tr")].map((row) => row.textContent).join("\n");
    assert.ok(rows.includes("审批拒绝"), "newer zz00002 rows stay visible");
    assert.ok(!rows.includes("提交申请"), "the stale zz00001 response was discarded");
    assert.equal([...view.rootNode.querySelectorAll("tbody tr")].length, 1, "only the newer response rows remain");
    assert.ok(view.rootNode.textContent.includes("第 1 页"), "paging follows the newer response");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("audit rows lead with Chinese labels and the business narrative, technical trace folded", async () => {
  auditCalls = [];
  globalThis.fetch = mockFetch;
  const view = await renderView({ onOpenObject: () => {} });
  try {
    await waitFor(() => view.rootNode.textContent.includes("定位样本申请"));
    await openAuditTab(view);
    const rows = [...view.rootNode.querySelectorAll("tbody tr")];
    const createdRow = rows.find((row) => row.textContent.includes("样本业务摘要文字"));
    assert.ok(createdRow, "business summary leads the narrative cell");
    assert.ok(createdRow.textContent.includes("提交申请"), "Chinese action label leads the action cell");
    assert.ok(createdRow.textContent.includes("approval.request.created"), "raw action code kept as secondary trace");
    const outcomeCell = createdRow.querySelectorAll("td")[4];
    assert.equal(outcomeCell.textContent.trim(), "成功", "outcome renders in Chinese");
    assert.ok(outcomeCell.querySelector("span").className.includes("whitespace-nowrap"), "outcome stays on one line");
    assert.ok(outcomeCell.querySelector("span").className.includes("text-emerald-600"), "light-theme-readable success token");
    assert.ok(outcomeCell.querySelector("span").className.includes("dark:text-emerald-400"), "dark-theme success token kept");
    const fold = createdRow.querySelector("details");
    assert.ok(fold, "technical trace folded into details");
    assert.ok(fold.textContent.includes("payloadVersion"), "fold keeps the raw technical fields");
    const rejectedRow = rows.find((row) => row.textContent.includes("审批拒绝"));
    assert.equal(rejectedRow.querySelectorAll("td")[4].textContent.trim(), "失败", "failure outcome renders in Chinese");
    assert.ok(rejectedRow.querySelectorAll("td")[4].querySelector("span").className.includes("text-rose-600"), "light-theme-readable failure token");
    assert.ok(rejectedRow.textContent.includes("资料与当前版本不符"), "reason leads the narrative when present");
    const linkCell = createdRow.querySelectorAll("td")[5];
    assert.ok(linkCell.className.includes("whitespace-nowrap"), "link column keeps the button on one line");
    assert.ok(linkCell.textContent.includes("查看申请"), "link column sits before the long narrative column for narrow screens");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});
