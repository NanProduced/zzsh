import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
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
globalThis.ResizeObserver = browser.ResizeObserver;
globalThis.Node = browser.Node;
globalThis.Event = browser.Event;
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.CustomEvent = browser.CustomEvent;
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// 产品代码读写 globalThis.sessionStorage；显式绑定到本测试窗口的存储，
// 不依赖 Node 某个启动环境是否默认提供 Web Storage。用例结束由 happyDOM.abort 回收。
Object.defineProperty(globalThis, "sessionStorage", { value: browser.sessionStorage, configurable: true, writable: true });

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

let sessionId = "session-1";

/** 恢复类用例各自独立会话并清空责任存储，避免记录跨用例泄漏。 */
function freshSession(tag) {
  sessionId = "session-" + tag;
  browser.sessionStorage.clear();
}

function snapshot(perms = permissions) {
  return {
    authenticated: true,
    adminUserId: "admin-boss",
    user: { name: "Boss", username: "zz00001", displayUsername: "ZZ00001", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: true, passwordChangeRequired: false },
    session: { id: sessionId, locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions: perms,
  };
}

/**
 * 动作资格夹具。前端只负责「服务端说什么就渲染什么」，因此这里直接给出
 * evaluateApprovalActions 的输出形状，不在测试里复制服务端判定逻辑。
 */
function eligibility(action, allowed, reasonCode, extra = {}) {
  return { action, allowed, reasonCode, requiredPermission: null, executionMode: "GENERIC_TRANSACTION", nextStepCode: null, ...extra };
}

function actionsFor(status) {
  const pending = status === "PENDING";
  const approved = status === "APPROVED";
  return [
    eligibility("approve", pending, pending ? "OK" : "STATUS_NOT_PENDING"),
    eligibility("reject", pending, pending ? "OK" : "STATUS_NOT_PENDING"),
    eligibility("execute", approved, approved ? "OK" : "STATUS_NOT_APPROVED", approved ? {} : { nextStepCode: "APPROVAL_DECISION_REQUIRED" }),
    eligibility("addCandidate", pending, pending ? "OK" : "STATUS_NOT_PENDING"),
    eligibility("replace", false, "REQUESTER_ONLY"),
  ];
}

function membershipBusiness(requestId, summaryText) {
  return {
    requestId,
    businessType: "membership",
    businessTitle: "发放会员礼遇权益",
    operationCode: "membership.entitlement.grant",
    executionMode: "GENERIC_TRANSACTION",
    summaryAvailable: true,
    detailsAvailable: true,
    changeSummary: summaryText,
    summary: {
      schemaVersion: 1, changeSummary: summaryText, payloadVersion: 1, payloadHash: "hash-" + requestId,
      gameName: "三角洲行动", entitlementKind: "PRESTIGE", entitlementKindTitle: "尊享礼遇",
      targetUserId: "user_fixt_7c2", scopeKey: "renter:order:fixt", reason: "活动补偿", depositWaived: false,
    },
    objectRefs: [{ type: "membership_game", id: "game_fixt_delta" }],
    resultAvailability: "NOT_APPLICABLE",
    pricingRestrictedReasonCode: "MEMBERSHIP_DETAIL_READ_REQUIRED",
  };
}

function summary(requestId, status, summaryText) {
  return {
    requestId,
    // 工作台不再面向普通运营提供测试操作入口，夹具代表已登记的正式业务。
    operationCode: "membership.entitlement.grant",
    triggerCondition: "membership.entitlement.grant.requested",
    payloadVersion: 1,
    payloadHash: "hash-" + requestId,
    summary: summaryText,
    status,
    statusReason: null,
    requester: { username: "zz00001", displayUsername: "ZZ00001", name: "Boss" },
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: "2026-09-25T00:00:00.000Z",
    business: membershipBusiness(requestId, summaryText),
    actions: actionsFor(status),
    candidateAvailability: { total: 2, eligible: 1, blockingReasonCode: null },
  };
}

function detail(requestId, status, summaryText) {
  return {
    ...summary(requestId, status, summaryText),
    operation: { code: "membership.entitlement.grant", triggerCondition: "membership.entitlement.grant.requested", payloadVersion: 1, payloadHash: "hash-" + requestId, executionMode: "GENERIC_TRANSACTION" },
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
let candidateCalls = [];
let recoveryCalls = [];
let recoveryResponse = { knowledge: "UNRESOLVED", operation: "approval.request.execute", key: "idem_x", explanationCode: "RECEIPT_NOT_FOUND", resolution: "UNKNOWN_NOT_ABSENT" };
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
  if (url.pathname.endsWith("/security/approvals/operations")) {
    return json({
      operations: [
        { operationCode: "membership.entitlement.grant", businessType: "membership", title: "发放会员礼遇权益", executionMode: "GENERIC_TRANSACTION", testOnly: false, initiation: { allowed: true, reasonCode: "OK", requiredPermission: "approval.request.create" }, triggers: [{ triggerCondition: "membership.entitlement.grant.requested", templateVersion: 1, candidateTotal: 2, candidateEligible: 1, blockingReasonCode: null }] },
        { operationCode: "order.settlement.adjust", businessType: "settlement", title: "人工调整订单结算", executionMode: "SOURCE_BUSINESS", testOnly: false, initiation: { allowed: false, reasonCode: "INITIATED_FROM_SOURCE_BUSINESS", requiredPermission: "approval.request.create" }, triggers: [] },
      ],
      unregisteredOperationPolicy: "未知操作只读展示并给出原因，不进入通用执行器",
      scope: "REGISTERED_OPERATIONS_FOR_CURRENT_ADMIN",
      testOperationsEnabled: false,
    });
  }
  if (url.pathname.endsWith("/security/approvals/candidate-options")) {
    candidateCalls.push(url.search);
    return json({
      candidates: [{ username: "zz00002", displayUsername: "ZZ00002", name: "审批人", isBoss: false, eligible: true, reasonCode: "OK" }],
      excludedByReason: { TWO_FACTOR_REQUIRED: 1 },
      requesterExcluded: Boolean(url.searchParams.get("requestId")),
      excludedFields: ["ip", "session", "credentials", "lastLoginAt"],
      requiredPermission: "approval.template.configure",
    });
  }
  if (url.pathname.endsWith("/security/approvals/recovery")) {
    recoveryCalls.push(url.search);
    return json(recoveryResponse);
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

async function clickRaw(element) {
  await act(async () => { element.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

function setInput(element, value) {
  const proto = element.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value").set;
  setValue.call(element, value);
  element.dispatchEvent(new browser.Event("input", { bubbles: true }));
}

function buttons(container) {
  return [...container.querySelectorAll("button")];
}

function buttonByText(text) {
  return buttons(document.body).find((button) => button.textContent.trim() === text);
}

/** 列表行不再整行可点：打开详情走操作列的真实按钮，键盘与读屏同样可达。 */
function rowOpenButton(rootNode, text) {
  const row = [...rootNode.querySelectorAll("tbody tr")].find((item) => item.textContent.includes(text));
  return row ? [...row.querySelectorAll("button")].find((button) => button.textContent.trim().startsWith("查看")) : undefined;
}

const dialog = () => document.querySelector('[data-slot="dialog-content"]');

async function renderView(props = {}) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  // 默认页已改为「待我处理」；这些用例的前提是「我的申请」，显式声明而不是依赖默认。
  let latest = { snapshot: snapshot(), initialTab: "mine", ...props };
  const render = async (extra = {}) => {
    latest = { ...latest, ...extra };
    await act(async () => {
      root.render(createElement(ApprovalAuditView, { snapshot: latest.snapshot, ...latest }));
    });
  };
  await render();
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
    await click(rowOpenButton(view.rootNode, PENDING_SUMMARY));
    await waitFor(() => buttonByText("批准") !== undefined);

    // L2 同意:对话框含对象摘要与后果,取消零写入
    await click(buttonByText("批准"));
    await waitFor(() => dialog() !== null);
    assert.match(dialog().textContent, /确认批准/);
    assert.match(dialog().textContent, new RegExp(PENDING_SUMMARY));
    assert.match(dialog().textContent, /批准不代表执行完成或资金到账/);
    assert.equal(writes.length, 0, "opening the dialog must not write");
    const confirmApprove = buttons(dialog()).find((button) => button.textContent.trim() === "确认批准");
    assert.ok(confirmApprove);
    assert.equal(confirmApprove.disabled, false, "approve reason is optional");
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "取消"));
    await waitFor(() => dialog() === null);
    assert.equal(writes.length, 0, "cancel must not write");

    // L2 拒绝:原因输入在按钮之前,不足 3 字禁用
    await click(buttonByText("驳回"));
    await waitFor(() => dialog() !== null);
    const dialogButtons = buttons(dialog());
    const confirmReject = dialogButtons.find((button) => button.textContent.trim() === "确认驳回");
    assert.ok(confirmReject, "reject confirm lives inside the dialog");
    const reasonInput = dialog().querySelector("textarea");
    assert.ok(reasonInput, "reason entry precedes the confirm buttons");
    assert.ok([...dialog().querySelectorAll("textarea,input,button")].indexOf(reasonInput) < [...dialog().querySelectorAll("textarea,input,button")].indexOf(confirmReject), "reason input is before buttons");
    assert.equal(confirmReject.disabled, true, "reject disabled below 3 chars");
    setInput(reasonInput, "ab");
    await settle();
    assert.equal(buttons(dialog()).find((button) => button.textContent.trim() === "确认驳回").disabled, true);
    setInput(reasonInput, "范围不符");
    await settle();
    assert.equal(buttons(dialog()).find((button) => button.textContent.trim() === "确认驳回").disabled, false);
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "确认驳回"));
    await waitFor(() => writes.length === 1);
    assert.equal(writes[0].path.endsWith("/security/approvals/requests/decision"), true);
    assert.equal(writes[0].body.decision, "REJECT");
    assert.equal(writes[0].body.reason, "范围不符");
    assert.match(writes[0].headers["idempotency-key"], /^idem_/);
    await waitFor(() => dialog() === null);

    // L3 执行:复述前 8 字匹配才可点
    await click(rowOpenButton(view.rootNode, APPROVED_SUMMARY));
    await waitFor(() => buttonByText("执行") !== undefined);
    await click(buttonByText("执行"));
    await waitFor(() => dialog() !== null);
    assert.match(dialog().textContent, /确认执行/);
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
    assert.equal(tabs.find((tab) => tab.textContent.includes("待我处理")).getAttribute("aria-selected"), "false");
    await click(tabs.find((tab) => tab.textContent.includes("待我处理")));
    await waitFor(() => view.rootNode.textContent.includes("待我审批样本"));
    const afterSwitch = [...view.rootNode.querySelector('[role="tablist"]').querySelectorAll("button")];
    assert.equal(afterSwitch.find((tab) => tab.textContent.includes("待我处理")).getAttribute("aria-selected"), "true");
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

    // 审计 tab 同样有游标分页（筛选下拉含有动作全名，断言限定在结果表体）
    const auditRows = () => [...view.rootNode.querySelectorAll("tbody tr")].map((row) => row.textContent).join("\n");
    await click([...view.rootNode.querySelector('[role="tablist"]').querySelectorAll("button")].find((tab) => tab.textContent.includes("审计记录")));
    await waitFor(() => auditRows().includes("approval.request.created"));
    const auditNext = buttons(view.rootNode).find((button) => button.textContent.trim() === "下一页");
    assert.equal(auditNext.disabled, false, "audit page 1 has a next cursor");
    await click(auditNext);
    await waitFor(() => auditRows().includes("approval.request.executed"));
    assert.match(view.rootNode.textContent, /第 2 页/);
    assert.equal(auditRows().includes("approval.request.rejected"), false, "audit page 2 replaced page 1");
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

test("unknown writes replay the frozen original request and preserve the original key", async () => {
  freshSession("replay");
  writes = [];
  mineCall = 0;
  let decisionAttempts = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    const method = init.method ?? "GET";
    if (method !== "GET" && url.pathname.endsWith("/requests/decision")) {
      const entry = { path: url.pathname, body: JSON.parse(init.body ?? "{}"), headers: { ...(init.headers ?? {}) } };
      writes.push(entry);
      if (decisionAttempts++ === 0) throw new TypeError("connection lost after the write");
      return json({ status: "APPROVED", requestId: entry.body.requestId });
    }
    return mockFetch(input, init);
  };
  const view = await renderView();
  try {
    await waitFor(() => view.rootNode.textContent.includes(PENDING_SUMMARY));
    await click(rowOpenButton(view.rootNode, PENDING_SUMMARY));
    await waitFor(() => buttonByText("批准") !== undefined);
    await click(buttonByText("批准"));
    await waitFor(() => dialog() !== null);
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "确认批准"));
    await waitFor(() => view.rootNode.textContent.includes("请求结果未知"));

    const original = writes[0];
    assert.equal(writes.length, 1, "the lost response creates one original write intent");
    assert.match(original.headers["idempotency-key"], /^idem_/);
    await click(buttonByText("审计记录"));
    await waitFor(() => view.rootNode.querySelectorAll("form input").length > 0);
    setInput(view.rootNode.querySelectorAll("form input")[0], "changed-after-unknown");
    await click(buttonByText("用原请求重试"));
    await waitFor(() => writes.length === 2);

    assert.equal(writes[1].path, original.path);
    assert.deepEqual(writes[1].body, original.body, "recovery does not read changed form state");
    assert.equal(writes[1].headers["idempotency-key"], original.headers["idempotency-key"], "recovery reuses the original idempotency key");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("successful write with failed detail readback keeps success fact and exposes GET-only recovery", async () => {
  freshSession("readback");
  writes = [];
  mineCall = 0;
  let detailReads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/requests/detail")) {
      detailReads += 1;
      if (detailReads === 2) throw new TypeError("detail readback lost");
    }
    return mockFetch(input, init);
  };
  const view = await renderView();
  try {
    await waitFor(() => view.rootNode.textContent.includes(APPROVED_SUMMARY));
    await click(rowOpenButton(view.rootNode, APPROVED_SUMMARY));
    await waitFor(() => buttonByText("执行") !== undefined);
    await click(buttonByText("执行"));
    await waitFor(() => dialog() !== null);
    setInput(dialog().querySelector("input"), APPROVED_SUMMARY.slice(0, 8));
    await settle();
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "确认执行"));
    await waitFor(() => view.rootNode.textContent.includes("已成功，最新状态未确认"));
    assert.equal(writes.filter((entry) => entry.path.endsWith("/requests/execute")).length, 1);
    assert.ok(buttonByText("重试读取最新状态"), "readback recovery is GET-only");
    assert.equal(buttonByText("执行"), undefined, "stale detail cannot drive another write");

    await click(buttonByText("重试读取最新状态"));
    await waitFor(() => buttonByText("执行") !== undefined);
    assert.equal(writes.filter((entry) => entry.path.endsWith("/requests/execute")).length, 1, "readback recovery does not POST");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("approval lists clear when actor and session context changes before the new read returns", async () => {
  writes = [];
  mineCall = 0;
  let releaseSecondMine = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/requests/mine")) {
      mineCall += 1;
      if (mineCall === 1) return json({ requests: [summary("actor-a", "PENDING", "账号 A 的旧列表")], nextCursor: null });
      if (mineCall === 2) return new Promise((resolve) => { releaseSecondMine = () => resolve(json({ requests: [summary("actor-b", "PENDING", "账号 B 的新列表")], nextCursor: null })); });
    }
    return mockFetch(input, init);
  };
  const view = await renderView();
  try {
    await waitFor(() => view.rootNode.textContent.includes("账号 A 的旧列表"));
    const nextSnapshot = {
      ...snapshot(),
      adminUserId: "admin-staff",
      user: { name: "审批人", username: "zz00002", displayUsername: "ZZ00002", twoFactorEnabled: true },
      session: { ...snapshot().session, id: "session-2" },
    };
    await view.render({ snapshot: nextSnapshot, refreshNonce: 1 });
    await settle();
    assert.equal(view.rootNode.textContent.includes("账号 A 的旧列表"), false, "old actor data is cleared while the new read is pending");
    assert.ok(releaseSecondMine, "new actor read is held");
    releaseSecondMine();
    await waitFor(() => view.rootNode.textContent.includes("账号 B 的新列表"));
  } finally {
    if (releaseSecondMine) releaseSecondMine();
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("permission loss hides the recovery panel but the responsibility returns with the same identity", async () => {
  freshSession("permloss");
  writes = [];
  mineCall = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") !== "GET" && url.pathname.endsWith("/requests/decision")) {
      writes.push({ path: url.pathname, body: JSON.parse(init.body ?? "{}"), headers: { ...(init.headers ?? {}) } });
      throw new TypeError("response lost after write");
    }
    return mockFetch(input, init);
  };
  const view = await renderView();
  try {
    await waitFor(() => view.rootNode.textContent.includes(PENDING_SUMMARY));
    await click(rowOpenButton(view.rootNode, PENDING_SUMMARY));
    await waitFor(() => buttonByText("批准") !== undefined);
    await click(buttonByText("批准"));
    await waitFor(() => dialog() !== null);
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "确认批准"));
    await waitFor(() => view.rootNode.textContent.includes("请求结果未知"));

    await view.render({ snapshot: snapshot(permissions.filter((permission) => permission !== "approval.request.approve")), refreshNonce: 1 });
    await settle();
    assert.equal(view.rootNode.textContent.includes("用原请求重试"), false, "permission loss clears the old recovery");
    assert.equal(writes.length, 1);

    await view.render({ snapshot: snapshot(), refreshNonce: 2 });
    await waitFor(() => view.rootNode.textContent.includes(PENDING_SUMMARY));
    // 失权只隐藏敏感投影；回到同身份同会话后责任必须重新出现，但不自动重放。
    await waitFor(() => view.rootNode.textContent.includes("用原请求重试"), 3000);
    assert.ok(view.rootNode.textContent.includes("责任记录里"), "面板说明责任保留而非清除");
    assert.equal(writes.length, 1, "permission restoration does not replay a write");
  } finally {
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("switching the approval object clears the old detail and drops its late response", async () => {
  writes = [];
  mineCall = 0;
  let releaseFirstDetail = null;
  let detailCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/requests/detail")) {
      detailCalls += 1;
      if (detailCalls === 1) return new Promise((resolve) => { releaseFirstDetail = () => resolve(json(detail("m1", "PENDING", "对象 A 旧详情"))); });
      return json(detail("m2", "APPROVED", "对象 B 新详情"));
    }
    return mockFetch(input, init);
  };
  const view = await renderView({ initialRequestId: "m1", objectOnly: true });
  try {
    await view.render({ initialRequestId: "m2", refreshNonce: 1 });
    await waitFor(() => view.rootNode.textContent.includes("对象 B 新详情"));
    assert.equal(view.rootNode.textContent.includes("对象 A 旧详情"), false);
    assert.ok(releaseFirstDetail, "old object detail remains in flight");
    releaseFirstDetail();
    await settle();
    assert.equal(view.rootNode.textContent.includes("对象 B 新详情"), true, "late old-object detail cannot overwrite the new object");
    assert.equal(view.rootNode.textContent.includes("对象 A 旧详情"), false);
  } finally {
    if (releaseFirstDetail) releaseFirstDetail();
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("repeated confirmation while a write is in flight cannot create a second write", async () => {
  freshSession("doubleconfirm");
  writes = [];
  mineCall = 0;
  let releaseDecision = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") !== "GET" && url.pathname.endsWith("/requests/decision")) {
      writes.push({ path: url.pathname, body: JSON.parse(init.body ?? "{}"), headers: { ...(init.headers ?? {}) } });
      return new Promise((resolve) => { releaseDecision = () => resolve(json({ status: "APPROVED", requestId: writes[0].body.requestId })); });
    }
    return mockFetch(input, init);
  };
  const view = await renderView();
  try {
    await waitFor(() => view.rootNode.textContent.includes(PENDING_SUMMARY));
    await click(rowOpenButton(view.rootNode, PENDING_SUMMARY));
    await waitFor(() => buttonByText("批准") !== undefined);
    await click(buttonByText("批准"));
    await waitFor(() => dialog() !== null);
    const confirm = buttons(dialog()).find((button) => button.textContent.trim() === "确认批准");
    await act(async () => {
      confirm.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }));
      confirm.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
    assert.equal(writes.length, 1, "the second confirmation is ignored while the first write is pending");
    assert.ok(releaseDecision);
    releaseDecision();
    await waitFor(() => view.rootNode.textContent.includes("已记录首个有效批准"));
  } finally {
    if (releaseDecision) releaseDecision();
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("StrictMode restores approval reads and unmount rejects late responses", async () => {
  writes = [];
  mineCall = 0;
  holdFirstMine = false;
  mineFresh = false;
  let releaseOld;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/security/approvals/requests/mine")) {
      mineCall += 1;
      if (mineCall === 1) return new Promise((resolve) => { releaseOld = () => resolve(json({ requests: [summary("strict-old", "PENDING", "StrictMode 旧列表")], nextCursor: null })); });
      return json({ requests: [summary("strict-new", "PENDING", "StrictMode 新列表")], nextCursor: null });
    }
    return mockFetch(input, init);
  };
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(ApprovalAuditView, { snapshot: snapshot(), initialTab: "mine" }))));
    await waitFor(() => rootNode.textContent.includes("StrictMode 新列表"));
    assert.equal(rootNode.textContent.includes("StrictMode 旧列表"), false, "StrictMode cleanup drops the first setup response");
    releaseOld();
    await settle();
    assert.equal(rootNode.textContent.includes("StrictMode 新列表"), true, "the rebuilt effect remains live");
  } finally {
    await act(async () => root.unmount());
    rootNode.remove();
  }

  let releaseLate;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/security/approvals/requests/mine")) {
      return new Promise((resolve) => { releaseLate = () => resolve(json({ requests: [summary("late", "PENDING", "卸载后迟到列表")], nextCursor: null })); });
    }
    return mockFetch(input, init);
  };
  const late = await renderView();
  try {
    await waitFor(() => releaseLate !== undefined);
  } finally {
    await late.cleanup();
    releaseLate();
    await settle();
    assert.equal(late.rootNode.textContent, "", "unmounted approval view ignores a late response");
    globalThis.fetch = undefined;
  }
});

test("object and actor-session changes release only the new approval lifecycle", async () => {
  freshSession("lifecycle");
  writes = [];
  mineCall = 0;
  let releaseWrite;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") !== "GET" && url.pathname.endsWith("/requests/decision")) {
      writes.push({ path: url.pathname, body: JSON.parse(init.body ?? "{}"), headers: { ...(init.headers ?? {}) } });
      return new Promise((resolve) => { releaseWrite = () => resolve(json({ status: "APPROVED", requestId: writes[0].body.requestId })); });
    }
    return mockFetch(input, init);
  };
  const view = await renderView({ initialRequestId: "m1", objectOnly: true });
  try {
    await waitFor(() => buttonByText("批准") !== undefined);
    await click(buttonByText("批准"));
    await waitFor(() => dialog() !== null);
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "确认批准"));
    assert.ok(releaseWrite, "the original POST is in flight");

    await view.render({ initialRequestId: "m2", refreshNonce: 1 });
    await waitFor(() => buttonByText("执行") !== undefined);
    assert.equal(buttonByText("执行").disabled, false, "the new object is not held by the old POST");
    releaseWrite();
    await settle();
    assert.equal(buttonByText("执行").disabled, false, "the old finally cannot release a new object lock");
  } finally {
    if (releaseWrite) releaseWrite();
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

test("actor-session change during readback clears the old busy state", async () => {
  freshSession("readbackswitch");
  writes = [];
  mineCall = 0;
  let detailCalls = 0;
  let releaseReadback;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/security/approvals/requests/detail")) {
      detailCalls += 1;
      if (detailCalls === 2) return new Promise((resolve) => { releaseReadback = () => resolve(json(detail("m1", "APPROVED", APPROVED_SUMMARY))); });
    }
    if ((init.method ?? "GET") !== "GET" && url.pathname.endsWith("/requests/decision")) {
      writes.push({ path: url.pathname, body: JSON.parse(init.body ?? "{}"), headers: { ...(init.headers ?? {}) } });
      return json({ status: "APPROVED", requestId: "m1" });
    }
    return mockFetch(input, init);
  };
  const view = await renderView({ initialRequestId: "m1", objectOnly: true });
  try {
    await waitFor(() => buttonByText("批准") !== undefined);
    await click(buttonByText("批准"));
    await waitFor(() => dialog() !== null);
    await click(buttons(dialog()).find((button) => button.textContent.trim() === "确认批准"));
    await waitFor(() => releaseReadback !== undefined);

    await view.render({
      snapshot: { ...snapshot(), adminUserId: "admin-staff", user: { name: "审批人", username: "zz00002", displayUsername: "ZZ00002", twoFactorEnabled: true }, session: { ...snapshot().session, id: "session-2" } },
      initialRequestId: "m1",
      refreshNonce: 1,
    });
    await waitFor(() => buttonByText("批准") !== undefined);
    assert.equal(buttonByText("批准").disabled, false, "the new actor-session is not held by old readback");
    releaseReadback();
    await settle();
    assert.equal(buttonByText("批准").disabled, false, "the old readback cannot clear the new actor-session state");
  } finally {
    if (releaseReadback) releaseReadback();
    await view.cleanup();
    globalThis.fetch = undefined;
  }
});

// Step-up credentials are required in every approval write dialog; tests fill them once the dialog opens.
async function click(element) { await clickRaw(element); await fillStepUpFields(element); }
async function fillStepUpFields(element) {
  const doc = element?.ownerDocument; if (!doc) return;
  const fields = [...doc.querySelectorAll('input[autocomplete="current-password"], input[autocomplete="one-time-code"]')].filter((field) => !field.value);
  if (fields.length === 0) return;
  const setValue = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, "value").set;
  await act(async () => { for (const field of fields) { setValue.call(field, field.autocomplete === "one-time-code" ? "123456" : "step-up-password-1"); field.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true })); } });
}
