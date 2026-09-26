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
  "approval.template.configure",
  "approval.request.create",
  "approval.request.read",
  "approval.request.approve",
  "approval.request.execute",
  "approval.request.add_approver",
  "approval.audit.read",
  "admin.account.read",
];

function snapshot(perms = permissions) {
  return {
    authenticated: true,
    adminUserId: "admin-boss",
    user: { name: "Boss", username: "zz00001", displayUsername: "ZZ00001", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: true, passwordChangeRequired: false },
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
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: "2026-09-25T00:00:00.000Z",
  };
}

function detail(requestId, status, summaryText) {
  return {
    ...summary(requestId, status, summaryText),
    operation: { code: "approval.test.execute", triggerCondition: "manual", payloadVersion: 1, payloadHash: "hash-" + requestId, payload: { outcome: "SUCCESS" } },
    template: { id: "tpl-1", version: 1 },
    requester: { username: "zz00002", displayUsername: "ZZ00002", name: "审批人", status: "ACTIVE" },
    decision: null,
    execution: null,
    candidates: [{ username: "zz00001", displayUsername: "ZZ00001", name: "Boss", status: "ACTIVE", eligible: true, source: "TEMPLATE" }],
    history: [],
    supersedesRequestId: null,
    supersededByRequestId: null,
  };
}

const auditEvent = (id, action) => ({
  eventId: id,
  actor: { username: "zz00001", displayUsername: "ZZ00001", name: "Boss" },
  action,
  objectType: "approval_request",
  objectId: id,
  outcome: "SUCCESS",
  reason: null,
  requestId: id,
  occurredAt: "2026-09-24T00:00:00.000Z",
  details: { operationCode: "approval.test.execute" },
});

const PENDING_SUMMARY = "分页与确认样本一";
const APPROVED_SUMMARY = "已批准待执行样本内容";

let writes = [];
let mineCall = 0;
let holdFirstMine = false;
let mineFresh = false;
let releaseFirstMine = null;

async function mockFetch(input, init = {}) {
  const url = new URL(String(input), browser.location.href);
  const method = init.method ?? "GET";
  const pathAndQuery = `${url.pathname}${url.search}`;
  if (method !== "GET") {
    writes.push({ path: url.pathname, body: JSON.parse(init.body ?? "{}"), headers: { ...(init.headers ?? {}) } });
    if (url.pathname.endsWith("/requests/decision")) return json({ status: "REJECTED", requestId: writes.at(-1).body.requestId });
    if (url.pathname.endsWith("/requests/execute")) return json({ status: "EXECUTED", executionStatus: "SUCCEEDED", requestId: writes.at(-1).body.requestId });
    if (url.pathname.endsWith("/templates/update")) return json({ templateId: "tpl-1", version: 2, status: "CONFIGURED" });
    return json({});
  }
  if (url.pathname.endsWith("/security/approvals/templates")) {
    return json({ templates: [{ id: "tpl-1", operationCode: "approval.test.execute", triggerCondition: "manual", version: 1, updatedAt: null, candidates: [{ username: "zz00001", name: "Boss", status: "ACTIVE", eligible: true }] }] });
  }
  if (url.pathname.endsWith("/security/admins")) {
    return json({ admins: [{ id: "admin-boss", username: "zz00001", name: "Boss", status: "ACTIVE" }, { id: "admin-staff", username: "zz00002", name: "审批人", status: "ACTIVE" }] });
  }
  if (url.pathname.endsWith("/security/approvals/requests/mine")) {
    mineCall += 1;
    if (holdFirstMine && mineCall === 1) {
      return new Promise((resolve) => { releaseFirstMine = () => resolve(json({ requests: [summary("m-old", "PENDING", "旧数据样本")], nextCursor: null })); });
    }
    if (mineFresh && mineCall >= 2) {
      return json({ requests: [summary("m-new", "PENDING", "刷新后样本")], nextCursor: null });
    }
    if (url.searchParams.get("cursor") === "CUR1") {
      return json({ requests: [summary("m3", "PENDING", "第二页样本")], nextCursor: null });
    }
    return json({ requests: [summary("m1", "PENDING", PENDING_SUMMARY), summary("m2", "APPROVED", APPROVED_SUMMARY)], nextCursor: "CUR1" });
  }
  if (url.pathname.endsWith("/security/approvals/requests/pending")) {
    return json({ requests: [summary("p1", "PENDING", "待我审批样本")], nextCursor: null });
  }
  if (url.pathname.endsWith("/security/approvals/requests/detail")) {
    const id = url.searchParams.get("requestId");
    if (id === "m2") return json(detail("m2", "APPROVED", APPROVED_SUMMARY));
    if (id === "p1") return json(detail("p1", "PENDING", "待我审批样本"));
    return json(detail("m1", "PENDING", PENDING_SUMMARY));
  }
  if (url.pathname.endsWith("/security/approvals/audit/events")) {
    if (url.searchParams.get("cursor") === "ACUR1") return json({ events: [auditEvent("a3", "approval.request.executed")], nextCursor: null });
    return json({ events: [auditEvent("a1", "approval.request.created"), auditEvent("a2", "approval.request.rejected")], nextCursor: "ACUR1" });
  }
  throw new Error(`unexpected test request ${pathAndQuery}`);
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

function buttons(container) {
  return [...container.querySelectorAll("button")];
}

function buttonByText(text) {
  return buttons(document.body).find((button) => button.textContent.trim() === text);
}

const dialog = () => document.querySelector('[data-slot="dialog-content"]');

async function renderView(props = {}) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  let latest = { snapshot: snapshot() };
  const render = async (extra = {}) => {
    latest = { ...latest, ...extra };
    await act(async () => {
      root.render(createElement(ApprovalAuditView, { snapshot: latest.snapshot, ...latest }));
    });
  };
  await render(props);
  return { rootNode, root, render, cleanup: async () => { await act(async () => root.unmount()); rootNode.remove(); } };
}

test("approval confirm levels: cancel writes nothing, reject reason gates before buttons, execute requires 8-char recall", async () => {
  writes = [];
  mineCall = 0;
  holdFirstMine = false;
  mineFresh = false;
  releaseFirstMine = null;
  globalThis.fetch = mockFetch;
  const view = await renderView();
  try {
    await waitFor(() => view.rootNode.textContent.includes(PENDING_SUMMARY));

    // 打开 PENDING 详情
    const pendingRow = [...view.rootNode.querySelectorAll("tbody tr")].find((row) => row.textContent.includes(PENDING_SUMMARY));
    await click(pendingRow);
    await waitFor(() => buttonByText("同意") !== undefined);

    // L2 同意:对话框含对象摘要与后果,取消零写入
    await click(buttonByText("同意"));
    await waitFor(() => dialog() !== null);
    assert.match(dialog().textContent, /确认同意审批/);
    assert.match(dialog().textContent, new RegExp(PENDING_SUMMARY));
    assert.match(dialog().textContent, /审批同意不代表执行完成或资金到账/);
    assert.equal(writes.length, 0, "opening the dialog must not write");
    const confirmApprove = buttons(dialog()).find((button) => button.textContent.trim() === "确认同意");
    assert.ok(confirmApprove);
    assert.equal(confirmApprove.disabled, false, "approve reason is optional");
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "取消"));
    await waitFor(() => dialog() === null);
    assert.equal(writes.length, 0, "cancel must not write");

    // L2 拒绝:原因输入在按钮之前,不足 3 字禁用
    await click(buttonByText("拒绝"));
    await waitFor(() => dialog() !== null);
    const dialogButtons = buttons(dialog());
    const confirmReject = dialogButtons.find((button) => button.textContent.trim() === "确认拒绝");
    assert.ok(confirmReject, "reject confirm lives inside the dialog");
    const reasonInput = dialog().querySelector("input");
    assert.ok(reasonInput, "reason entry precedes the confirm buttons");
    assert.ok([...dialog().querySelectorAll("input,button")].indexOf(reasonInput) < [...dialog().querySelectorAll("input,button")].indexOf(confirmReject), "reason input is before buttons");
    assert.equal(confirmReject.disabled, true, "reject disabled below 3 chars");
    setInput(reasonInput, "ab");
    await settle();
    assert.equal(buttons(dialog()).find((button) => button.textContent.trim() === "确认拒绝").disabled, true);
    setInput(reasonInput, "范围不符");
    await settle();
    assert.equal(buttons(dialog()).find((button) => button.textContent.trim() === "确认拒绝").disabled, false);
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "确认拒绝"));
    await waitFor(() => writes.length === 1);
    assert.equal(writes[0].path.endsWith("/security/approvals/requests/decision"), true);
    assert.equal(writes[0].body.decision, "REJECT");
    assert.equal(writes[0].body.reason, "范围不符");
    assert.match(writes[0].headers["idempotency-key"], /^idem_/);
    await waitFor(() => dialog() === null);

    // L3 执行:复述前 8 字匹配才可点
    const approvedRow = [...view.rootNode.querySelectorAll("tbody tr")].find((row) => row.textContent.includes(APPROVED_SUMMARY));
    await click(approvedRow);
    await waitFor(() => buttonByText("执行本地测试动作") !== undefined);
    await click(buttonByText("执行本地测试动作"));
    await waitFor(() => dialog() !== null);
    assert.match(dialog().textContent, /确认执行本地测试动作/);
    assert.match(dialog().textContent, /不可撤销/);
    const recallTarget = APPROVED_SUMMARY.slice(0, 8);
    assert.match(dialog().textContent, new RegExp(recallTarget));
    const executeConfirm = buttons(dialog()).find((button) => button.textContent.trim() === "确认执行");
    assert.equal(executeConfirm.disabled, true, "execute disabled before recall matches");
    const recallInput = dialog().querySelector("input");
    setInput(recallInput, "错误复述内容");
    await settle();
    assert.equal(buttons(dialog()).find((button) => button.textContent.trim() === "确认执行").disabled, true, "wrong recall keeps execute disabled");
    setInput(recallInput, recallTarget);
    await settle();
    assert.equal(buttons(dialog()).find((button) => button.textContent.trim() === "确认执行").disabled, false);
    const beforeExecute = writes.length;
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "确认执行"));
    await waitFor(() => writes.length === beforeExecute + 1);
    assert.equal(writes.at(-1).path.endsWith("/security/approvals/requests/execute"), true);
    assert.equal(writes.at(-1).body.requestId, "m2");
    assert.match(writes.at(-1).headers["idempotency-key"], /^idem_/);
    await waitFor(() => dialog() === null);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("cursor stack restores the previous page and tabs expose role=tab with aria-selected", async () => {
  writes = [];
  mineCall = 0;
  holdFirstMine = false;
  mineFresh = false;
  releaseFirstMine = null;
  globalThis.fetch = mockFetch;
  const tabChanges = [];
  const view = await renderView({ onTabChange: (value) => tabChanges.push(value) });
  try {
    await waitFor(() => view.rootNode.textContent.includes(PENDING_SUMMARY));

    // A3: role=tab / aria-selected
    const tablist = view.rootNode.querySelector('[role="tablist"]');
    assert.ok(tablist, "tablist container exists");
    const tabs = [...tablist.querySelectorAll("button")];
    assert.ok(tabs.length >= 4);
    for (const tab of tabs) {
      assert.equal(tab.getAttribute("role"), "tab");
      assert.ok(tab.hasAttribute("aria-selected"));
    }
    assert.equal(tabs.find((tab) => tab.textContent.includes("我的申请")).getAttribute("aria-selected"), "true");
    assert.equal(tabs.find((tab) => tab.textContent.includes("待我审批")).getAttribute("aria-selected"), "false");
    await click(tabs.find((tab) => tab.textContent.includes("待我审批")));
    await waitFor(() => view.rootNode.textContent.includes("待我审批样本"));
    const afterSwitch = [...view.rootNode.querySelector('[role="tablist"]').querySelectorAll("button")];
    assert.equal(afterSwitch.find((tab) => tab.textContent.includes("待我审批")).getAttribute("aria-selected"), "true");
    assert.equal(afterSwitch.find((tab) => tab.textContent.includes("我的申请")).getAttribute("aria-selected"), "false");
    assert.deepEqual(tabChanges, ["pending"]);
    await click(afterSwitch.find((tab) => tab.textContent.includes("我的申请")));
    await waitFor(() => view.rootNode.textContent.includes(PENDING_SUMMARY));

    // A2: 下一页 → 上一页 还原
    const nextPage = buttons(view.rootNode).find((button) => button.textContent.trim() === "下一页");
    assert.ok(nextPage);
    assert.equal(nextPage.disabled, false, "page 1 has a next cursor");
    const prevOnFirstPage = buttons(view.rootNode).find((button) => button.textContent.trim() === "上一页");
    assert.equal(prevOnFirstPage.disabled, true, "first page cannot go back");
    await click(nextPage);
    await waitFor(() => view.rootNode.textContent.includes("第二页样本"));
    assert.equal(view.rootNode.textContent.includes(PENDING_SUMMARY), false, "page 2 replaced page 1");
    assert.match(view.rootNode.textContent, /第 2 页/);
    const backHome = buttons(view.rootNode).find((button) => button.textContent.trim() === "回到首页");
    assert.ok(backHome, "back-to-first appears beyond page 1");
    const nextPageOnLast = buttons(view.rootNode).find((button) => button.textContent.trim() === "下一页");
    assert.equal(nextPageOnLast.disabled, true, "last page has no next cursor");
    await click(buttons(view.rootNode).find((button) => button.textContent.trim() === "上一页"));
    await waitFor(() => view.rootNode.textContent.includes(PENDING_SUMMARY));
    assert.equal(view.rootNode.textContent.includes("第二页样本"), false);
    assert.match(view.rootNode.textContent, /第 1 页/);

    // 审计 tab 同样有游标分页
    await click([...view.rootNode.querySelector('[role="tablist"]').querySelectorAll("button")].find((tab) => tab.textContent.includes("审计记录")));
    await waitFor(() => view.rootNode.textContent.includes("approval.request.created"));
    const auditNext = buttons(view.rootNode).find((button) => button.textContent.trim() === "下一页");
    assert.equal(auditNext.disabled, false, "audit page 1 has a next cursor");
    await click(auditNext);
    await waitFor(() => view.rootNode.textContent.includes("approval.request.executed"));
    assert.match(view.rootNode.textContent, /第 2 页/);
    assert.equal(view.rootNode.textContent.includes("approval.request.rejected"), false, "audit page 2 replaced page 1");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("without any approval permission the view refuses and fires no request", async () => {
  writes = [];
  mineCall = 0;
  holdFirstMine = false;
  mineFresh = false;
  releaseFirstMine = null;
  let calls = 0;
  const callPaths = [];
  globalThis.fetch = async (input) => { calls += 1; callPaths.push(String(input)); throw new Error("should not be called"); };
  const view = await renderView({ snapshot: snapshot([]) });
  try {
    await waitFor(() => view.rootNode.textContent.includes("当前账号没有审批或审批审计读取权限"));
    assert.equal(view.rootNode.querySelector('[role="tablist"]'), null, "no tab strip without approval permissions");
    assert.equal(calls, 0, `no approval request without permission, got: ${callPaths.join(", ")}`);
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("sequence guard: a late list response cannot overwrite the refreshed data", async () => {
  writes = [];
  mineCall = 0;
  holdFirstMine = true;
  mineFresh = true;
  releaseFirstMine = null;
  globalThis.fetch = mockFetch;
  const view = await renderView();
  try {
    await waitFor(() => view.rootNode.textContent.includes("正在读取…"));
    assert.equal(releaseFirstMine !== null, true, "first mine response is held open");

    await view.render({ refreshNonce: 1 });
    await waitFor(() => view.rootNode.textContent.includes("刷新后样本"));
    assert.equal(view.rootNode.textContent.includes("正在读取…"), false, "refresh finished and cleared the reading state");

    releaseFirstMine();
    await settle();
    await settle();
    assert.equal(view.rootNode.textContent.includes("刷新后样本"), true, "fresh data stays");
    assert.equal(view.rootNode.textContent.includes("旧数据样本"), false, "late response must not overwrite fresh data");
    assert.equal(view.rootNode.textContent.includes("正在读取…"), false, "stale settle must not resurrect the reading state");
  } finally {
    holdFirstMine = false;
    mineFresh = false;
    if (releaseFirstMine) releaseFirstMine();
    releaseFirstMine = null;
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});
