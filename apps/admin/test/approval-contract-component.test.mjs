/**
 * ADM-APPROVAL-UI-2 · 审批中心新 UI 契约（组件层）
 *
 * 审批中心管理端 UI 已按 Owner 方案整体重写：单列表（统一接口、scope 切换）+
 * 只读规则说明表 + 新详情页（申请内容卡 / 决定区 / 缩小时间线 / 页脚技术详情）。
 * 旧 approval-* 组件测试针对多页签、模板配置、执行、追加审批人、密码复核与
 * 分离的 mine/pending/audit 接口，这些入口与接口已不复存在；因此本文件改为
 * 验证新契约，而不是继续等待已经删除的 DOM。
 *
 * 仍然渲染真实组件（vite ssrLoadModule）、拦截真实 fetch，并断言真实 DOM 与
 * 真实请求参数；不 mock 组件行为、不放宽任何生产代码。服务端并发 / 事务 /
 * 真实 PG 行为不在此层。
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
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Element = browser.Element;
globalThis.ShadowRoot = browser.ShadowRoot;
globalThis.HTMLInputElement = browser.HTMLInputElement;
globalThis.HTMLTextAreaElement = browser.HTMLTextAreaElement;
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
  cacheDir: fileURLToPath(new URL("../../../tmp/approval-vite-cache/contract/", import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const { ApprovalAuditView } = await vite.ssrLoadModule("/src/views/approval-audit-view.tsx");
const { RequestList, EMPTY_FILTER } = await vite.ssrLoadModule("/src/views/approval/request-list.tsx");
const contract = await vite.ssrLoadModule("/src/views/approval/contract.ts");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const FULL_PERMS = ["approval.request.read", "approval.request.approve", "approval.audit.read"];
const READ_ONLY_PERMS = ["approval.request.read"];
const REQUESTER = { username: "zz00002", displayUsername: "ZZ00002", name: "申请人小李" };

let sessionId = "session-1";
function freshSession(tag) {
  sessionId = "session-" + tag;
  globalThis.sessionStorage.clear();
}

function snapshot(perms = FULL_PERMS, isBoss = false) {
  return {
    authenticated: true,
    adminUserId: "admin-ops",
    user: { name: "运营小周", username: "zz00007", displayUsername: "ZZ00007", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss, passwordChangeRequired: false },
    session: { id: sessionId, locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions: perms,
  };
}

function actionsFor(status, overrides = {}) {
  const pending = status === "PENDING";
  return [
    { action: "approve", allowed: pending, reasonCode: pending ? "OK" : "STATUS_NOT_PENDING" },
    { action: "reject", allowed: pending, reasonCode: pending ? "OK" : "STATUS_NOT_PENDING" },
    { action: "withdraw", allowed: pending, reasonCode: pending ? "OK" : "REQUESTER_ONLY" },
    ...Object.entries(overrides).map(([action, allowed]) => ({ action, allowed, reasonCode: "OK" })),
  ];
}

const CREATED_EVENT = (requestId) => ({
  eventId: "evt-" + requestId,
  actor: REQUESTER,
  action: "approval.request.created",
  objectType: "approval_request",
  objectId: requestId,
  outcome: "SUCCESS",
  reason: null,
  requestId,
  occurredAt: "2026-09-24T00:00:00.000Z",
  details: {},
});

function makeSummary(requestId, status, text, operationCode = "membership.entitlement.grant") {
  return {
    requestId,
    operationCode,
    summary: text,
    status,
    statusReason: null,
    requester: REQUESTER,
    createdAt: "2026-09-24T00:00:00.000Z",
    business: { businessTitle: "发放会员礼遇", changeSummary: text, summary: {} },
    actions: actionsFor(status),
  };
}

function makeDetail(requestId, status, text, operationCode = "membership.entitlement.grant", extra = {}) {
  return {
    ...makeSummary(requestId, status, text, operationCode),
    operation: {
      code: operationCode,
      triggerCondition: operationCode + ".requested",
      payloadVersion: 1,
      payloadHash: "hash-" + requestId,
    },
    template: { id: "tpl-1", version: 1 },
    decision: null,
    execution: null,
    candidates: [],
    history: [CREATED_EVENT(requestId)],
    supersedesRequestId: null,
    supersededByRequestId: null,
    ...extra,
  };
}

const SETTLEMENT = (posted) => ({
  settlementVersionId: "sv-1", versionNo: 2, versionHash: "h", kind: "ADJUST",
  currentVersion: true, approvedPayloadMatchesVersion: true,
  confirmedParties: [], rejectedParties: [], supportReviewed: false,
  posted, postingId: posted ? "post-1" : null, postedAt: posted ? "2026-10-01T00:00:00.000Z" : null,
  refundDueAt: null,
});

// ── fetch 夹具：只暴露新 UI 实际调用的接口 ──────────────────────────────────
let calls = [];
let listResponse = null;
let detailResponse = null;
let recoveryResponse = { knowledge: "UNRESOLVED", operation: "approval.request.decide", key: "idem_x" };
let decisionStatus = { status: "APPROVED" };

async function mockFetch(input, init = {}) {
  const url = new URL(String(input), browser.location.href);
  const method = init.method ?? "GET";
  const record = {
    path: url.pathname,
    search: url.search,
    method,
    body: init.body ? JSON.parse(init.body) : undefined,
    headers: init.headers ?? {},
  };
  calls.push(record);
  if (method !== "GET") {
    if (url.pathname.endsWith("/requests/decision")) return json({ ...decisionStatus, requestId: record.body.requestId });
    if (url.pathname.endsWith("/requests/withdraw")) return json({ status: "CANCELLED", requestId: record.body.requestId });
    return json({});
  }
  // 统一列表：GET /security/approvals/requests?scope=...
  if (url.pathname.endsWith("/security/approvals/requests")) {
    return json(listResponse ?? {
      requests: [makeSummary("r1", "PENDING", "发放会员礼遇给老客户")],
      nextCursor: null, scope: "pending", pendingCount: 3,
    });
  }
  if (url.pathname.endsWith("/security/approvals/requests/detail")) {
    const id = url.searchParams.get("requestId") ?? "r1";
    return json(detailResponse ?? makeDetail(id, "PENDING", "发放会员礼遇给老客户"));
  }
  if (url.pathname.endsWith("/security/approvals/recovery")) return json(recoveryResponse);
  throw new Error(`unexpected test request ${url.pathname}${url.search}`);
}

function resetFixtures(tag) {
  freshSession(tag);
  calls = [];
  listResponse = null;
  detailResponse = null;
  recoveryResponse = { knowledge: "UNRESOLVED", operation: "approval.request.decide", key: "idem_x" };
  decisionStatus = { status: "APPROVED" };
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

async function clickRaw(element) {
  assert.ok(element, "expected clickable element");
  await act(async () => { element.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

function buttons(root = browser.document.body) {
  return [...root.querySelectorAll("button")];
}

function buttonByText(text, root = browser.document.body) {
  return buttons(root).find((button) => button.textContent.trim() === text);
}

function setInput(element, value) {
  assert.ok(element, "expected input element");
  const proto = element.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  element.dispatchEvent(new browser.Event("input", { bubbles: true }));
}

function scopeTrigger(host) {
  const label = [...host.querySelectorAll("label")].find((item) => item.textContent.includes("查看范围"));
  assert.ok(label, "查看范围筛选存在");
  const trigger = label.querySelector('[data-slot="select-trigger"]');
  assert.ok(trigger, "查看范围下拉触发器存在");
  return trigger;
}

/** base-ui Select 的 Portal 挂到 .workspace-root；测试 host 需带该 class，点击选项才能冒泡回 React root。 */
function makeHost() {
  for (const previous of [...browser.document.querySelectorAll(".workspace-root")]) previous.classList.remove("workspace-root");
  const host = browser.document.createElement("div");
  host.className = "workspace-root";
  browser.document.body.appendChild(host);
  return host;
}

async function openSelect(trigger) {
  await act(async () => { trigger.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

function currentOptions() {
  return [...browser.document.querySelectorAll('[role="option"]')].map((item) => item.textContent.trim());
}

async function chooseOpened(label) {
  const option = [...browser.document.querySelectorAll('[role="option"]')].find((item) => item.textContent.trim() === label);
  assert.ok(option, `找不到下拉选项 ${label}（当前：${currentOptions().join("、")}）`);
  await act(async () => {
    option.dispatchEvent(new browser.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    option.dispatchEvent(new browser.MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    option.click();
  });
  await settle();
}

async function pickOption(trigger, label) {
  await openSelect(trigger);
  await chooseOpened(label);
}

async function openOptions(trigger) {
  await openSelect(trigger);
  return currentOptions();
}

async function renderView(props = {}) {
  const host = makeHost();
  const root = createRoot(host);
  let latest = { snapshot: snapshot(), ...props };
  const render = async (extra = {}) => {
    latest = { ...latest, ...extra };
    await act(async () => { root.render(createElement(ApprovalAuditView, latest)); });
  };
  await render();
  return { host, root, render, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

function listCalls() {
  return calls.filter((call) => call.method === "GET" && call.path.endsWith("/security/approvals/requests"));
}

function postCalls(pathSuffix) {
  return calls.filter((call) => call.method === "POST" && call.path.endsWith(pathSuffix));
}

// ── 1. 纯展示契约（规则表 / 状态 / 动态码 / 时间线 / 摘要）─────────────────

test("规则说明是 7 列 6 行的只读表，且不含全额冲回分销佣金", () => {
  assert.equal(contract.RULES_COLUMNS.length, 7);
  assert.deepEqual([...contract.RULES_COLUMNS], ["类型", "谁提交", "谁批准", "能否自批", "动态码", "批准后", "在哪发起"]);
  assert.equal(contract.RULES_ROWS.length, 6);
  const text = JSON.stringify(contract.RULES_ROWS);
  assert.ok(!text.includes("全额冲回分销佣金"), "规则表不得出现全额冲回分销佣金");
  assert.ok(!text.includes("冲回"), "规则表不得出现冲回业务");
});

test("规则表每行字段齐全，动态码只标记在高影响的三类业务上", () => {
  for (const row of contract.RULES_ROWS) {
    for (const key of ["type", "submitters", "approvers", "selfApprove", "totp", "afterApprove", "entry"]) {
      assert.equal(typeof row[key], "string", `${row.type}.${key} 必须是文字`);
      assert.ok(row[key].trim().length > 0, `${row.type}.${key} 不能为空`);
    }
  }
  assert.equal(contract.RULES_ROWS.filter((row) => row.totp === "要").length, 3);
  assert.equal(contract.RULES_ROWS.filter((row) => row.totp === "不用").length, 3);
});

test("申请状态只使用 待审批/已生效/已驳回/已撤回", () => {
  assert.equal(contract.statusView("PENDING").label, "待审批");
  assert.equal(contract.statusView("APPROVED").label, "已生效");
  assert.equal(contract.statusView("REJECTED").label, "已驳回");
  assert.equal(contract.statusView("CANCELLED").label, "已撤回");
});

test("结算单另有「已批准，待订单确认」与「已完成」两个专用状态", () => {
  assert.equal(
    contract.requestStatusView({ status: "APPROVED", operationCode: "order.settlement.adjust", business: { settlementResult: { posted: false } } }).label,
    "已批准，待订单确认",
  );
  assert.equal(
    contract.requestStatusView({ status: "APPROVED", operationCode: "order.settlement.adjust", business: { settlementResult: { posted: true } } }).label,
    "已完成",
  );
  // 其它业务不借用结算单文案
  assert.equal(contract.requestStatusView({ status: "APPROVED", operationCode: "membership.entitlement.grant" }).label, "已生效");
});

test("动态码仅高影响类型需要；结算调整为中级，礼遇为低级", () => {
  for (const code of ["membership.benefit.policy.publish", "distribution.policy.publish", "order.compensation.grant"]) {
    assert.equal(contract.isHighImpactOperation(code), true, code);
  }
  for (const code of ["order.settlement.adjust", "membership.entitlement.grant", "membership.entitlement.revoke", undefined]) {
    assert.equal(contract.isHighImpactOperation(code), false, String(code));
  }
  assert.equal(contract.operationLevel("order.compensation.grant"), "高");
  assert.equal(contract.operationLevel("order.settlement.adjust"), "中");
  assert.equal(contract.operationLevel("membership.entitlement.grant"), "低");
});

test("时间线动作用「提交/批准/驳回/撤回/已生效」等人话", () => {
  assert.equal(contract.auditActionLabel("approval.request.created"), "提交");
  assert.equal(contract.auditActionLabel("approval.request.approved"), "批准");
  assert.equal(contract.auditActionLabel("approval.request.rejected"), "驳回");
  assert.equal(contract.auditActionLabel("approval.request.withdrawn"), "撤回");
  assert.equal(contract.auditActionLabel("approval.execution.completed"), "已生效");
});

test("列表摘要写人话，不裸露操作码或哈希", () => {
  const line = contract.requestSummaryLine({
    operationCode: "order.compensation.grant",
    summary: "兜底摘要",
    business: { compensation: { orderId: "o1", displayNo: "DD-9", amountCents: "12345", reason: "租客赔付" } },
  });
  assert.match(line, /赔偿 123\.45 元/);
  assert.match(line, /DD-9/);
  assert.ok(!line.includes("order.compensation.grant"));
  assert.ok(!line.includes("hash-"));
  assert.equal(contract.personLabel(REQUESTER), "申请人小李（ZZ00002）");
});

// ── 2. 统一列表接口 ────────────────────────────────────────────────────────

test("默认走统一列表接口 GET /security/approvals/requests?scope=pending&limit=50 并读取 pendingCount", async (t) => {
  resetFixtures("list-default");
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => view.host.textContent.includes("待我处理 3 件"));
  const first = listCalls()[0];
  assert.ok(first, "应发出统一列表请求");
  const params = new URLSearchParams(first.search);
  assert.equal(params.get("scope"), "pending");
  assert.equal(params.get("limit"), "50");
  assert.ok(view.host.textContent.includes("发放会员礼遇"), "{requests} 被渲染为业务标题");
  assert.ok(view.host.textContent.includes("待我处理 3 件"), "{pendingCount} 被消费");
});

test("列表每行显示申请人，表头为业务事项/申请人/当前状态/申请时间/级别/操作", async (t) => {
  resetFixtures("list-requester");
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => view.host.querySelector("tbody tr"));
  const headers = [...view.host.querySelectorAll("table thead th")].map((th) => th.textContent.trim());
  assert.deepEqual(headers, ["业务事项", "申请人", "当前状态", "申请时间", "级别", "操作"]);
  const row = view.host.querySelector("tbody tr");
  assert.ok(row.textContent.includes("申请人小李（ZZ00002）"), "每行写清申请人");
  assert.ok(row.textContent.includes("待审批"));
});

test("纯客服（无审批权限）默认 scope=involved", async (t) => {
  resetFixtures("list-cs");
  const view = await renderView({ snapshot: snapshot(READ_ONLY_PERMS) });
  t.after(() => view.cleanup());
  await waitFor(() => listCalls().length >= 1);
  assert.equal(new URLSearchParams(listCalls()[0].search).get("scope"), "involved");
  assert.ok(view.host.textContent.includes("与我相关"));
});

test("Boss 可见「全部申请」范围，且可切换为 scope=all", async (t) => {
  resetFixtures("list-boss");
  const view = await renderView({ snapshot: snapshot(FULL_PERMS, true) });
  t.after(() => view.cleanup());
  await waitFor(() => view.host.querySelector('[data-slot="select-trigger"]'));
  await openSelect(scopeTrigger(view.host));
  assert.deepEqual(currentOptions(), ["待我处理", "与我相关", "全部申请"]);
  await chooseOpened("全部申请");
  await waitFor(() => listCalls().some((call) => new URLSearchParams(call.search).get("scope") === "all"));
  assert.ok(listCalls().at(-1).search.includes("scope=all"));
});

test("非 Boss 没有「全部申请」范围选项", async (t) => {
  resetFixtures("list-non-boss");
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => view.host.querySelector('[data-slot="select-trigger"]'));
  assert.deepEqual(await openOptions(scopeTrigger(view.host)), ["待我处理", "与我相关"]);
});

test("范围切到「与我相关」时以 scope=involved 重新请求", async (t) => {
  resetFixtures("list-switch");
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => view.host.querySelector('[data-slot="select-trigger"]'));
  await pickOption(scopeTrigger(view.host), "与我相关");
  await waitFor(() => listCalls().some((call) => new URLSearchParams(call.search).get("scope") === "involved"));
});

test("筛选条件进入统一接口的 URL 参数", async (t) => {
  resetFixtures("list-filters");
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => view.host.querySelector('input[placeholder="姓名或账号"]'));
  await act(async () => setInput(view.host.querySelector('input[placeholder="姓名或账号"]'), "小李"));
  await clickRaw(buttonByText("查询", view.host));
  await waitFor(() => listCalls().some((call) => call.search.includes("requester=")));
  const filtered = listCalls().find((call) => call.search.includes("requester="));
  assert.equal(new URLSearchParams(filtered.search).get("requester"), "小李");
  assert.equal(new URLSearchParams(filtered.search).get("limit"), "50");
});

test("不再有旧页签：没有 tablist / role=tab，只有一个申请列表", async (t) => {
  resetFixtures("list-no-tabs");
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => view.host.textContent.includes("申请列表"));
  assert.equal(view.host.querySelector('[role="tablist"]'), null);
  assert.equal(view.host.querySelector('[role="tab"]'), null);
  for (const removed of ["我的申请", "审计记录", "审批设置"]) {
    assert.ok(!view.host.textContent.includes(removed), `不应再出现旧页签 ${removed}`);
  }
  assert.equal(view.host.querySelectorAll("table").length, 1, "只有一张统一列表");
});

// ── 3. 规则说明（从列表右上角进入的只读表）────────────────────────────────

test("右上角「规则说明」进入只读表：7 列 6 行", async (t) => {
  resetFixtures("rules-open");
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => buttonByText("规则说明", view.host));
  await clickRaw(buttonByText("规则说明", view.host));
  await waitFor(() => view.host.textContent.includes("这张表只说明规则"));
  assert.equal(view.host.querySelectorAll("table thead th").length, 7);
  assert.equal(view.host.querySelectorAll("table tbody tr").length, 6);
  assert.ok(!view.host.textContent.includes("全额冲回分销佣金"));
});

test("规则说明不提供模板/触发条件/审批人的配置入口", async (t) => {
  resetFixtures("rules-readonly");
  const view = await renderView();
  t.after(() => view.cleanup());
  await clickRaw(buttonByText("规则说明", view.host));
  await waitFor(() => view.host.textContent.includes("不在这里配置模板"));
  const section = [...view.host.querySelectorAll("section")].find((item) => item.textContent.includes("规则说明"));
  assert.ok(section);
  assert.equal(section.querySelectorAll("input, textarea, select").length, 0, "规则表只读，没有表单控件");
  assert.equal(buttonByText("配置模板", section), undefined);
  assert.equal(buttonByText("配置审批人", section), undefined);
});

test("规则表的「返回列表」回到申请列表", async (t) => {
  resetFixtures("rules-back");
  const view = await renderView();
  t.after(() => view.cleanup());
  await clickRaw(buttonByText("规则说明", view.host));
  await waitFor(() => view.host.textContent.includes("这张表只说明规则"));
  await clickRaw(buttonByText("返回列表", view.host));
  await waitFor(() => view.host.textContent.includes("申请列表"));
  assert.ok(!view.host.textContent.includes("这张表只说明规则"));
});

// ── 4. 详情页结构 ─────────────────────────────────────────────────────────

async function renderDetail(t, overrides = {}) {
  resetFixtures(overrides.tag ?? "detail");
  detailResponse = overrides.detail ?? makeDetail("r1", "PENDING", "发放会员礼遇给老客户");
  const view = await renderView({ initialRequestId: "r1", ...(overrides.viewProps ?? {}) });
  t.after(() => view.cleanup());
  await waitFor(() => view.host.textContent.includes("技术详情"));
  return view;
}

test("详情页顺序为 页头 → 申请内容卡（默认展开）→ 决定区 → 办理时间线", async (t) => {
  const view = await renderDetail(t, { tag: "detail-order" });
  const host = view.host;
  const cardButton = [...host.querySelectorAll("button[aria-expanded]")].find((item) => item.textContent.includes("申请内容"));
  assert.ok(cardButton, "申请内容卡可折叠");
  assert.equal(cardButton.getAttribute("aria-expanded"), "true", "申请内容默认展开");
  assert.ok(host.querySelector('section[aria-label="决定区"]'));
  assert.ok(host.querySelector('section[aria-label="流程与时间线"]'));
  const order = [cardButton, host.querySelector('section[aria-label="决定区"]'), host.querySelector('section[aria-label="流程与时间线"]')];
  assert.ok(order.every(Boolean));
  assert.ok(host.textContent.includes("办理时间线"));
  assert.ok(host.querySelector("dl[aria-label='申请基本信息']"), "页头含申请人等基本信息");
});

test("申请编号/模板/触发条件/哈希/事件编码收敛到页脚折叠的「技术详情」", async (t) => {
  const view = await renderDetail(t, { tag: "detail-tech" });
  const details = [...view.host.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent.includes("技术详情"));
  assert.ok(details, "存在技术详情折叠块");
  assert.equal(details.open, false, "技术详情默认折叠");
  for (const label of ["申请编号", "业务操作", "触发条件", "载荷版本", "内容校验值", "模板版本", "事件编码"]) {
    assert.ok(details.textContent.includes(label), `${label} 应收敛在技术详情内`);
  }
  assert.ok(details.textContent.includes("hash-r1"));
});

test("时间线用「提交」等中文动作，不显示英文事件编码", async (t) => {
  const view = await renderDetail(t, { tag: "detail-timeline" });
  const timeline = view.host.querySelector('[aria-label="申请时间线"]') ?? view.host.querySelector('section[aria-label="流程与时间线"]');
  assert.ok(timeline);
  assert.ok(timeline.textContent.includes("提交"));
  assert.ok(!timeline.textContent.includes("approval.request.created"));
});

test("页面去掉了候选快照/通用资格/系统旁路/平台执行/规则快照/有效期/模板配置字样", async (t) => {
  const view = await renderDetail(t, { tag: "detail-wording" });
  const text = view.host.textContent;
  for (const removed of ["候选快照", "通用资格", "系统旁路", "平台执行", "规则快照", "申请有效期至", "尚未配置审批模板"]) {
    assert.ok(!text.includes(removed), `不应再出现 ${removed}`);
  }
});

// ── 5. 决定 / 撤回 请求体 ─────────────────────────────────────────────────

test("低影响类型批准：决定 body 只有 requestId/decision/reason，不含 password 与 totpCode", async (t) => {
  const view = await renderDetail(t, { tag: "decide-low" });
  assert.equal(view.host.querySelector('input[aria-label="批准动态验证码"]'), null, "低影响类型不要求动态码");
  await act(async () => setInput(view.host.querySelector('textarea[placeholder="补充说明（可选）"]'), "核对通过"));
  await clickRaw(buttonByText("确认批准", view.host));
  await waitFor(() => postCalls("/requests/decision").length >= 1);
  const body = postCalls("/requests/decision")[0].body;
  assert.deepEqual(Object.keys(body).sort(), ["decision", "reason", "requestId"]);
  assert.equal(body.decision, "APPROVE");
  assert.ok(!("password" in body));
  assert.ok(!("totpCode" in body));
});

test("高影响类型批准：需 6 位动态码，body 带 totpCode 且始终不含 password", async (t) => {
  const view = await renderDetail(t, {
    tag: "decide-high",
    detail: makeDetail("r1", "PENDING", "调整分销政策", "distribution.policy.publish"),
  });
  const totp = view.host.querySelector('input[aria-label="批准动态验证码"]');
  assert.ok(totp, "高影响类型显示 6 位动态码输入");
  assert.equal(buttonByText("确认批准", view.host).disabled, true, "未填动态码时批准禁用");
  await act(async () => setInput(totp, "123456"));
  await waitFor(() => buttonByText("确认批准", view.host).disabled === false);
  await clickRaw(buttonByText("确认批准", view.host));
  await waitFor(() => postCalls("/requests/decision").length >= 1);
  const body = postCalls("/requests/decision")[0].body;
  assert.equal(body.totpCode, "123456");
  assert.equal(body.decision, "APPROVE");
  assert.ok(!("password" in body), "决定不再携带 password");
});

test("高影响类型批准时动态码只接受 6 位数字", async (t) => {
  const view = await renderDetail(t, {
    tag: "decide-high-format",
    detail: makeDetail("r1", "PENDING", "发布会员权益政策", "membership.benefit.policy.publish"),
  });
  const totp = view.host.querySelector('input[aria-label="批准动态验证码"]');
  await act(async () => setInput(totp, "12ab56"));
  await settle();
  assert.equal(totp.value, "1256", "非数字被过滤");
  assert.equal(buttonByText("确认批准", view.host).disabled, true, "不足 6 位不能批准");
});

test("驳回不携带任何凭据（password / totpCode）", async (t) => {
  const view = await renderDetail(t, { tag: "decide-reject" });
  const textarea = view.host.querySelector('textarea[placeholder="补充说明（可选）"]');
  assert.ok(textarea);
  await act(async () => setInput(textarea, "资料与当前版本不符"));
  await waitFor(() => buttonByText("确认驳回", view.host).disabled === false);
  await clickRaw(buttonByText("确认驳回", view.host));
  await waitFor(() => postCalls("/requests/decision").length >= 1);
  const body = postCalls("/requests/decision")[0].body;
  assert.equal(body.decision, "REJECT");
  assert.ok(!("password" in body));
  assert.ok(!("totpCode" in body));
});

test("撤回走 /requests/withdraw 且不带任何凭据", async (t) => {
  const view = await renderDetail(t, { tag: "withdraw" });
  assert.ok(buttonByText("撤回申请", view.host), "待审批且有资格时显示撤回");
  await clickRaw(buttonByText("撤回申请", view.host));
  await waitFor(() => postCalls("/requests/withdraw").length >= 1);
  const body = postCalls("/requests/withdraw")[0].body;
  assert.equal(body.requestId, "r1");
  assert.ok(!("password" in body));
  assert.ok(!("totpCode" in body));
  assert.ok(!("altcha" in body));
  assert.equal(postCalls("/requests/decision").length, 0);
});

test("没有「执行」按钮、没有「追加审批人」，也不调用 execute / add-candidate 接口", async (t) => {
  const view = await renderDetail(t, { tag: "no-execute" });
  const labels = buttons(view.host).map((button) => button.textContent.trim());
  assert.ok(!labels.includes("执行"));
  assert.ok(!labels.includes("确认执行"));
  assert.ok(!labels.includes("追加审批人"));
  assert.ok(!view.host.textContent.includes("追加审批人"));
  assert.equal(postCalls("/requests/execute").length, 0);
  assert.equal(postCalls("/requests/add-candidate").length, 0);
  assert.equal(calls.filter((call) => call.path.includes("/audit/events")).length, 0, "不再请求审计事件接口");
  assert.equal(calls.filter((call) => call.path.includes("/templates")).length, 0, "不再请求模板接口");
});

// ── 6. 权限与状态提示 ─────────────────────────────────────────────────────

test("纯客服看不到批准/驳回按钮，只显示不能办理的原因", async (t) => {
  const view = await renderDetail(t, {
    tag: "readonly-detail",
    viewProps: { snapshot: snapshot(READ_ONLY_PERMS) },
  });
  assert.equal(buttonByText("确认批准", view.host), undefined);
  assert.equal(buttonByText("确认驳回", view.host), undefined);
  assert.ok(view.host.textContent.includes("当前账号没有审批权限，只能查看申请内容。"));
});

test("不能批准/驳回时决定区只显示原因，不渲染办理按钮", async (t) => {
  const blocked = makeDetail("r1", "PENDING", "发放会员礼遇给老客户");
  blocked.actions = actionsFor("APPROVED");
  blocked.statusReason = "这张申请已处理或你不在可办理范围内";
  const view = await renderDetail(t, { tag: "no-action", detail: blocked });
  const decision = view.host.querySelector('section[aria-label="决定区"]');
  assert.ok(decision);
  assert.ok(decision.querySelector('[role="status"]'), "原因用 role=status 呈现");
  assert.equal(buttonByText("确认批准", decision), undefined);
  assert.equal(buttonByText("确认驳回", decision), undefined);
});

test("客服+运营按运营显示：具备审批权限时显示批准与驳回按钮", async (t) => {
  const view = await renderDetail(t, {
    tag: "ops-detail",
    viewProps: { snapshot: snapshot(["approval.request.read", "approval.request.approve"]) },
  });
  assert.ok(buttonByText("确认批准", view.host));
  assert.ok(buttonByText("确认驳回", view.host));
});

test("结算单批准后未过账：显示「已批准，待订单确认」并提示回订单确认", async (t) => {
  const settlement = makeDetail("r1", "APPROVED", "人工调整订单结算", "order.settlement.adjust");
  settlement.business = { businessTitle: "人工调整订单结算", changeSummary: "调整结算", summary: {}, settlementResult: SETTLEMENT(false), objectRefs: [] };
  const view = await renderDetail(t, { tag: "settlement-pending", detail: settlement });
  assert.ok(view.host.textContent.includes("已批准，待订单确认"));
  assert.ok(view.host.textContent.includes("请回订单完成双方确认和过账。"));
  assert.ok(!view.host.textContent.includes("已生效"), "结算单不借用通用「已生效」");
});

test("结算单已过账：显示「已完成」", async (t) => {
  const settlement = makeDetail("r1", "APPROVED", "人工调整订单结算", "order.settlement.adjust");
  settlement.business = { businessTitle: "人工调整订单结算", changeSummary: "调整结算", summary: {}, settlementResult: SETTLEMENT(true), objectRefs: [] };
  const view = await renderDetail(t, { tag: "settlement-done", detail: settlement });
  assert.ok(view.host.textContent.includes("已完成"));
  assert.ok(!view.host.textContent.includes("已批准，待订单确认"));
});

// ── 7. RequestList 组件本身的范围契约 ─────────────────────────────────────

test("RequestList 在 canSeeAll=false 时只渲染 pending / involved 两个范围", async (t) => {
  resetFixtures("component-scope");
  const host = makeHost();
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const changes = [];
  await act(async () => {
    root.render(createElement(RequestList, {
      items: [], busy: false, emptyNote: "无", onOpen() {}, scope: "pending",
      onScopeChange: (value) => changes.push(value), canSeeAll: false,
      filters: EMPTY_FILTER, onFiltersChange() {},
    }));
  });
  await settle();
  await openSelect(scopeTrigger(host));
  assert.deepEqual(currentOptions(), ["待我处理", "与我相关"]);
  await chooseOpened("与我相关");
  assert.deepEqual(changes, ["involved"]);
});
