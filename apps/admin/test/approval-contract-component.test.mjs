/**
 * ADM-APPROVAL-UI-1 · 审批合同状态矩阵（组件层）
 *
 * 现有 approval-audit-component / approval-audit-navigation 覆盖的是生命周期风险：
 * 分页游标、序号守卫、迟到响应、UNKNOWN 重放、上下文切换、审计筛选与 URL 同步。
 * 本文件覆盖另一类风险——**后端受权投影与逐项动作资格被前端错误折叠**：
 * 五种正式业务的摘要与裁剪、旧 DTO 缺字段、缺 actions、自审批禁令、资格变化、
 * 过期、执行失败、结算由来源业务消费、未登记业务 fail closed、原结果恢复四态，
 * 以及候选读取不再要求全管理员目录权限。
 *
 * 这些规则不在纯函数层重复断言：标签与金额格式在同一处渲染里被证明，
 * 避免三层复制同一算例（docs/testing.md §1）。
 * 服务端并发、事务与真实 PG 行为归后端窗口，组件 mock 不替代。
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
const pendingWrites = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
const approvalContract = await vite.ssrLoadModule("/src/views/approval/contract.ts");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

const PERMISSIONS = [
  "approval.template.read", "approval.template.configure", "approval.request.create",
  "approval.request.read", "approval.request.approve", "approval.request.execute",
  "approval.request.add_approver", "approval.audit.read",
];

let sessionId = "session-1";

/** 责任记录按 身份|会话 分域；恢复类用例各自独立会话并清空存储，避免跨用例泄漏。 */
function freshSession(tag) {
  sessionId = "session-" + tag;
  // 产品代码用的是 globalThis.sessionStorage（Node 内置），不是 happy-dom Window 上的那个。
  globalThis.sessionStorage.clear();
}

function snapshot(perms = PERMISSIONS) {
  return {
    authenticated: true,
    adminUserId: "admin-boss",
    user: { name: "陈琳", username: "zz00003", displayUsername: "ZZ00003", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    session: { id: sessionId, locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions: perms,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ── 可编程夹具 ────────────────────────────────────────────────────────────
let fixture = {};
let getCalls = [];
let writes = [];
let releaseRecovery = null;

function resetFixture(extra = {}) {
  fixture = { detail: null, requests: [], operations: [], candidateOptions: null, recovery: null, recoveryStatus: 200, failWrite: null, failDetail: null, holdRecovery: false, ...extra };
  getCalls = [];
  writes = [];
  releaseRecovery = null;
}

async function mockFetch(input, init = {}) {
  const url = new URL(String(input), browser.location.href);
  const method = init.method ?? "GET";
  if (method !== "GET") {
    writes.push({ path: url.pathname, body: JSON.parse(init.body ?? "{}"), headers: { ...(init.headers ?? {}) } });
    if (fixture.failWrite) return json({ error: { code: "INTERNAL_ERROR", message: "fixture failure" } }, fixture.failWrite);
    return json({ status: "APPROVED", requestId: fixture.detail?.requestId ?? "req-1" });
  }
  getCalls.push(url.pathname + url.search);
  if (url.pathname.endsWith("/requests/detail")) {
    if (fixture.failDetail) return json({ error: { code: "INTERNAL_ERROR", message: "fixture failure" } }, fixture.failDetail);
    return json(fixture.detail ?? {});
  }
  if (url.pathname.endsWith("/requests/mine") || url.pathname.endsWith("/requests/pending")) return json({ requests: fixture.requests, nextCursor: null });
  if (url.pathname.endsWith("/approvals/templates")) return json({ templates: [] });
  if (url.pathname.endsWith("/approvals/operations")) return json({ operations: fixture.operations, unregisteredOperationPolicy: "未知操作只读展示并给出原因，不进入通用执行器" });
  if (url.pathname.endsWith("/candidate-options")) return json(fixture.candidateOptions ?? { candidates: [], excludedByReason: {} });
  if (url.pathname.endsWith("/approvals/recovery")) {
    if (fixture.holdRecovery) return new Promise((resolve) => { releaseRecovery = () => resolve(json(fixture.recovery ?? {}, fixture.recoveryStatus)); });
    return json(fixture.recovery ?? {}, fixture.recoveryStatus);
  }
  if (url.pathname.endsWith("/audit/events")) return json({ events: [], nextCursor: null, scope: "ACTOR_OR_REQUEST_SCOPE" });
  if (url.pathname.endsWith("/security/admins")) {
    // 候选读取必须走审批专用接口；一旦回到全管理员目录就让它显式失败。
    throw new Error("the approval UI must not read the whole admin directory to pick approvers");
  }
  return json({});
}

// ── 夹具构造 ──────────────────────────────────────────────────────────────
function eligibility(action, allowed, reasonCode, extra = {}) {
  return { action, allowed, reasonCode, requiredPermission: null, executionMode: "GENERIC_TRANSACTION", nextStepCode: null, ...extra };
}

function baseDetail(overrides = {}) {
  return {
    requestId: "approval_req_fixt_1",
    operationCode: "membership.entitlement.grant",
    triggerCondition: "membership.entitlement.grant.requested",
    payloadVersion: 1,
    payloadHash: "0f3a".padEnd(64, "0"),
    summary: "申请尊享礼遇 90 天",
    status: "PENDING",
    statusReason: null,
    requester: { username: "zz00002", displayUsername: "ZZ00002", name: "周敏" },
    createdAt: "2026-10-12T09:12:44.318Z",
    expiresAt: "2026-10-13T09:12:44.318Z",
    operation: { code: "membership.entitlement.grant", triggerCondition: "membership.entitlement.grant.requested", payloadVersion: 1, payloadHash: "0f3a".padEnd(64, "0"), executionMode: "GENERIC_TRANSACTION" },
    template: { id: "tpl-1", version: 4 },
    decision: null,
    execution: null,
    candidates: [{ username: "zz00003", displayUsername: "ZZ00003", name: "陈琳", status: "ACTIVE", eligible: true, source: "TEMPLATE" }],
    history: [],
    supersedesRequestId: null,
    supersededByRequestId: null,
    actions: [
      eligibility("approve", true, "OK"),
      eligibility("reject", true, "OK"),
      eligibility("execute", false, "STATUS_NOT_APPROVED", { nextStepCode: "APPROVAL_DECISION_REQUIRED" }),
      eligibility("addCandidate", false, "REQUESTER_ONLY"),
      eligibility("replace", false, "REQUESTER_ONLY"),
    ],
    candidateAvailability: { total: 2, eligible: 1, blockingReasonCode: null },
    ...overrides,
  };
}

function membershipBusiness(overrides = {}) {
  return {
    requestId: "approval_req_fixt_1",
    businessType: "membership",
    businessTitle: "发放会员礼遇权益",
    operationCode: "membership.entitlement.grant",
    executionMode: "GENERIC_TRANSACTION",
    summaryAvailable: true,
    detailsAvailable: true,
    changeSummary: "为租客 user_fixt_7c2 发放尊享礼遇 90 天",
    summary: {
      schemaVersion: 1, changeSummary: "为租客 user_fixt_7c2 发放尊享礼遇 90 天", payloadVersion: 1, payloadHash: "0f3a".padEnd(64, "0"),
      gameName: "三角洲行动", entitlementKind: "PRESTIGE", entitlementKindTitle: "尊享礼遇",
      targetUserId: "user_fixt_7c2", scopeKey: "renter:order:fixt",
      startsAt: "2026-10-20T00:00:00.000Z", endsAt: "2027-01-18T00:00:00.000Z",
      reason: "活动补偿", depositWaived: false, policyId: "growth_policy_fixt_4", policyVersion: 4, policyStatus: "APPROVED",
    },
    objectRefs: [{ type: "membership_game", id: "game_fixt_delta" }, { type: "membership_growth_policy", id: "growth_policy_fixt_4" }],
    resultAvailability: "NOT_APPLICABLE",
    pricingRestrictedReasonCode: "MEMBERSHIP_DETAIL_READ_REQUIRED",
    ...overrides,
  };
}

const money = (amount, basis) => ({ amount, currency: "CNY", unit: "yuan", scale: 2, basis });

function settlementBusiness(overrides = {}) {
  return {
    requestId: "approval_req_fixt_settle",
    businessType: "settlement",
    businessTitle: "人工调整订单结算",
    operationCode: "order.settlement.adjust",
    executionMode: "SOURCE_BUSINESS",
    summaryAvailable: true,
    detailsAvailable: true,
    changeSummary: "提前结束，按净额调整",
    summary: {
      schemaVersion: 1, changeSummary: "提前结束，按净额调整", payloadVersion: 1, payloadHash: "a1b2".padEnd(64, "0"),
      settlementSchema: "settlement-version-v2", reason: "账号提前回收", endReason: "TENANT_VOLUNTARY_EARLY", early: true,
      currency: "CNY", unit: "yuan", scale: 2,
      baseSettlementVersionId: "setver_fixt_3", baseSettlementVersionNo: "3",
      capturedAmount: money("300.00", "CAPTURED"),
      systemOwnerNet: money("150.00", "SYSTEM_OWNER_NET"),
      systemRenterRefund: money("150.00", "SYSTEM_RENTER_REFUND"),
      proposedOwnerNet: money("120.50", "PROPOSED_OWNER_NET"),
      proposedRenterRefund: money("179.50", "PROPOSED_RENTER_REFUND"),
    },
    objectRefs: [{ type: "rental_order", id: "order_fixt_58" }, { type: "settlement_version", id: "setver_fixt_4" }],
    game: { id: "game_fixt_delta", name: "三角洲行动" },
    resultAvailability: "KNOWN",
    settlementResult: {
      settlementVersionId: "setver_fixt_4", versionNo: 4, versionHash: "a1b2".padEnd(64, "0"), kind: "MANUAL_ADJUSTMENT",
      currentVersion: true, approvedPayloadMatchesVersion: true, confirmedParties: ["RENTER"], rejectedParties: [],
      supportReviewed: false, posted: false, postingId: null, postedAt: null, refundDueAt: null,
    },
    pendingConditionCodes: ["OWNER_CONFIRMATION_REQUIRED", "SUPPORT_REVIEW_REQUIRED", "SETTLEMENT_NOT_POSTED"],
    ...overrides,
  };
}

// ── 渲染装置 ──────────────────────────────────────────────────────────────
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out; text: " + String(document.body.textContent).replace(/s+/g, " ").slice(0, 300));
    await settle();
  }
}

async function click(element) {
  assert.ok(element, "element to click exists; buttons now: " + [...document.body.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 24).join("/"));
  await act(async () => { element.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

const buttons = (container) => [...container.querySelectorAll("button")];
const buttonByText = (text, container = document.body) => buttons(container).find((button) => button.textContent.trim() === text);
const text = (view) => view.rootNode.textContent;

async function renderDetail(detail, props = {}) {
  resetFixture({ detail, ...props });
  globalThis.fetch = mockFetch;
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  await act(async () => {
    root.render(createElement(ApprovalAuditView, {
      snapshot: props.snapshot ?? snapshot(props.permissions),
      objectOnly: true,
      initialRequestId: detail.requestId,
      initialQuery: {},
      ...props.view,
    }));
  });
  const view = {
    rootNode,
    root,
    render: async (extra) => {
      await act(async () => {
        root.render(createElement(ApprovalAuditView, {
          snapshot: extra.snapshot ?? props.snapshot ?? snapshot(props.permissions),
          objectOnly: true,
          initialRequestId: detail.requestId,
          initialQuery: {},
          ...props.view,
          ...extra.view,
        }));
      });
      await settle();
    },
    cleanup: async () => { await act(async () => root.unmount()); rootNode.remove(); globalThis.fetch = undefined; },
  };
  await settle();
  return view;
}

async function renderList(extra = {}) {
  resetFixture(extra);
  globalThis.fetch = mockFetch;
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  const props = { snapshot: snapshot(extra.permissions), initialQuery: {}, onOpenObject: extra.onOpenObject, onOpenPath: extra.onOpenPath, ...extra.view };
  await act(async () => { root.render(createElement(ApprovalAuditView, props)); });
  const view = { rootNode, cleanup: async () => { await act(async () => root.unmount()); rootNode.remove(); globalThis.fetch = undefined; } };
  await settle();
  return view;
}

// ── 用例 ──────────────────────────────────────────────────────────────────

test("five registered businesses render their authorized summaries, restricted views stay distinct from action eligibility", async () => {
  const cases = [
    ["membership.benefit.policy.publish", "发布会员权益政策", membershipBusiness({ operationCode: "membership.benefit.policy.publish", businessTitle: "发布会员权益政策", changeSummary: "发布会员成长政策 v4" })],
    ["membership.entitlement.grant", "发放会员礼遇权益", membershipBusiness()],
    ["membership.entitlement.replace", "替换会员礼遇权益", membershipBusiness({ operationCode: "membership.entitlement.replace", businessTitle: "替换会员礼遇权益", changeSummary: "以尊享礼遇替换原挚友礼遇", summary: { changeSummary: "以尊享礼遇替换原挚友礼遇", replacedEntitlement: { id: "ent_fixt_old", frozenTargetScopeKey: "renter:order:fixt", currentStatus: "ACTIVE", currentEndsAt: "2026-12-01T00:00:00.000Z", readAvailable: true } } })],
    ["membership.entitlement.revoke", "撤销会员礼遇权益", membershipBusiness({ operationCode: "membership.entitlement.revoke", businessTitle: "撤销会员礼遇权益", changeSummary: "撤销已发放的尊享礼遇", summary: { changeSummary: "撤销已发放的尊享礼遇", revokedEntitlement: { id: "ent_fixt_9", frozenTargetScopeKey: "renter:order:fixt", currentStatus: null, currentEndsAt: null, readAvailable: false } } })],
  ];
  for (const [operationCode, title, business] of cases) {
    const detail = baseDetail({ operationCode, business, operation: { ...baseDetail().operation, code: operationCode } });
    const view = await renderDetail(detail);
    try {
      await waitFor(() => text(view).includes(title));
      assert.ok(text(view).includes("此次申请改变什么"), `${title}: 变更说明区块存在`);
      assert.ok(text(view).includes(business.changeSummary), `${title}: 渲染受权变更摘要`);
      assert.ok(text(view).includes("申请时快照"), `${title}: 冻结快照单独成区`);
      assert.equal(text(view).includes("业务摘要未接入"), false, `${title}: 有摘要时不得声称未接入`);
    } finally {
      await view.cleanup();
    }
  }

  // 裁剪摘要：无权查看业务摘要与「能否审批」是两件事。
  const restricted = baseDetail({
    operationCode: "order.settlement.adjust",
    business: {
      requestId: "approval_req_fixt_settle", businessType: "settlement", businessTitle: "人工调整订单结算",
      operationCode: "order.settlement.adjust", executionMode: "SOURCE_BUSINESS",
      summaryAvailable: false, detailsAvailable: false, restrictedReasonCodes: ["BUSINESS_PERMISSION_REQUIRED"],
    },
    operation: { ...baseDetail().operation, code: "order.settlement.adjust", executionMode: "SOURCE_BUSINESS" },
    actions: [eligibility("approve", true, "OK"), eligibility("reject", true, "OK")],
  });
  const view = await renderDetail(restricted);
  try {
    await waitFor(() => text(view).includes("人工调整订单结算"));
    assert.ok(text(view).includes("无权查看本次申请的业务摘要"), "裁剪原因就地说明");
    assert.ok(text(view).includes("缺少该业务的阶段权限"), "裁剪原因码翻译成业务语言");
    for (const field of ["结算口径", "系统计算（调整前）", "拟调整", "绑定依据摘要"]) {
      assert.equal(text(view).includes(field), false, "无权时不渲染快照字段：" + field);
    }
    assert.ok(buttonByText("批准"), "详情读取受限不影响批准资格，两者分别表达");
    assert.equal(buttonByText("批准").disabled, false);
  } finally {
    await view.cleanup();
  }
});

test("settlement is consumed by the source business: no generic execute, no arrival wording, pending conditions named", async () => {
  const detail = baseDetail({
    requestId: "approval_req_fixt_settle",
    operationCode: "order.settlement.adjust",
    status: "APPROVED",
    statusReason: "审批已通过，等待执行",
    business: settlementBusiness(),
    operation: { ...baseDetail().operation, code: "order.settlement.adjust", executionMode: "SOURCE_BUSINESS" },
    actions: [
      eligibility("approve", false, "STATUS_NOT_PENDING"),
      eligibility("reject", false, "STATUS_NOT_PENDING"),
      eligibility("execute", false, "EXECUTION_MODE_SOURCE_BUSINESS", { executionMode: "SOURCE_BUSINESS", nextStepCode: "SOURCE_BUSINESS_COMPLETION_REQUIRED" }),
    ],
  });
  const view = await renderDetail(detail);
  try {
    await waitFor(() => text(view).includes("人工调整订单结算"));
    const executeButton = buttonByText("执行");
    assert.ok(executeButton, "执行动作仍然列出，但资格由服务端决定");
    assert.equal(executeButton.disabled, true, "SOURCE_BUSINESS 不可在审批页执行");
    assert.ok(text(view).includes("由来源业务流程完成"), "解释执行方式");
    assert.ok(text(view).includes("回到来源业务完成双方确认、客服复核与过账"), "给出下一步");
    for (const label of ["待号主确认", "待客服复核", "尚未过账"]) {
      assert.ok(text(view).includes(label), `未完成条件具名：${label}`);
    }
    assert.ok(text(view).includes("待租客确认") === false, "已确认方不列为待办");
    // 金额：系统计算值与拟调整值分列，拟调整标明不等于到账。
    assert.ok(text(view).includes("150.00 元"), "系统计算金额按服务端精确串显示");
    assert.ok(text(view).includes("120.50 元（拟定）"), "拟调整金额标明拟定");
    assert.ok(text(view).includes("不等于渠道已到账"), "应退与到账分开");
    assert.equal(text(view).includes("执行后到账"), false, "不得出现「执行后到账」");
    assert.ok(text(view).includes("租赁订单"), "回链到来源订单对象");
  } finally {
    await view.cleanup();
  }
});

test("approval, execution and domain results stay in three separate blocks", async () => {
  const detail = baseDetail({
    status: "EXECUTION_FAILED",
    business: membershipBusiness({
      resultAvailability: "KNOWN",
      executionReceipt: { status: "FAILED", resultCode: "ENTITLEMENT_WINDOW_CONFLICT", resultDetail: "目标窗口与既有权益冲突" },
      entitlement: { id: "ent_fixt_1", status: "EXECUTED_PENDING_START", startsAt: "2026-12-01T00:00:00.000Z", endsAt: "2027-03-01T00:00:00.000Z", effectiveState: "NOT_STARTED", replacedById: null },
    }),
    execution: { status: "FAILED", resultCode: "ENTITLEMENT_WINDOW_CONFLICT", resultDetail: "目标窗口与既有权益冲突", executor: { username: "zz00003", displayUsername: "ZZ00003", name: "陈琳" }, createdAt: "2026-10-13T02:00:00.000Z", completedAt: "2026-10-13T02:00:01.000Z" },
    actions: [eligibility("execute", true, "OK")],
  });
  const view = await renderDetail(detail);
  try {
    await waitFor(() => text(view).includes("审批状态"));
    assert.ok(text(view).includes("执行状态"), "执行状态独立成列");
    assert.ok(text(view).includes("业务进度"), "业务进度独立成列");
    assert.ok(text(view).includes("执行失败"), "执行失败按事实显示");
    assert.ok(text(view).includes("目标窗口与既有权益冲突"), "受权失败原因可见");
    assert.ok(text(view).includes("已执行，未到生效时间"), "未来生效权益不得写成已启用");
    assert.equal(text(view).includes("已生效"), false, "不得把 EXECUTED_PENDING_START 说成已生效");
    assert.ok(text(view).includes("本次执行回执"), "执行回执与业务事实分列");
  } finally {
    await view.cleanup();
  }
});

test("expired requests keep their history and never read as an operable pending item", async () => {
  const detail = baseDetail({
    status: "EXPIRED",
    statusReason: "申请已超过有效期",
    actions: [
      eligibility("approve", false, "EXPIRED"),
      eligibility("reject", false, "EXPIRED"),
      eligibility("execute", false, "EXPIRED"),
      eligibility("addCandidate", false, "EXPIRED"),
      eligibility("replace", false, "REQUESTER_ONLY"),
    ],
    history: [
      { eventId: "e1", actor: { username: "zz00002", displayUsername: "ZZ00002", name: "周敏" }, action: "approval.request.created", objectType: "approval_request", objectId: "approval_req_fixt_1", outcome: "SUCCESS", reason: null, requestId: "http-trace-1", occurredAt: "2026-10-12T09:12:44.318Z", details: {} },
      { eventId: "e2", actor: { username: "zz00003", displayUsername: "ZZ00003", name: "陈琳" }, action: "approval.request.expired", objectType: "approval_request", objectId: "approval_req_fixt_1", outcome: "SUCCESS", reason: "超过有效期未处理", requestId: "http-trace-2", occurredAt: "2026-10-13T09:12:44.318Z", details: {} },
    ],
  });
  const view = await renderDetail(detail);
  try {
    await waitFor(() => text(view).includes("已过期"));
    assert.ok(text(view).includes("申请已超过有效期"), "到期原因可见");
    for (const label of ["批准", "驳回", "执行"]) {
      const button = buttonByText(label);
      assert.ok(button, `${label} 仍然列出以便解释为何不可办理`);
      assert.equal(button.disabled, true, `${label} 在过期申请上不可办理`);
    }
    assert.ok(text(view).includes("当前不能批准、驳回或执行"), "一行汇总说明，不逐条堆噪音");
    assert.ok(text(view).includes("申请已过期，不再推进"), "原因码翻译成业务语言");
    // 事件记录用时间线且保持中性：过期不是「流程成功走完」。
    const timeline = view.rootNode.querySelector('[data-slot="timeline"]');
    assert.ok(timeline, "事件记录使用既有 Timeline 组件");
    const items = [...timeline.querySelectorAll('[data-slot="timeline-item"]')];
    assert.equal(items.length, 2, "两个事件都渲染");
    assert.equal(items.filter((item) => item.hasAttribute("data-completed")).length, 0, "任何事件都不得被标记为已完成步骤");
    assert.ok(text(view).includes("超过有效期未处理"), "事件说明按真实结果显示");
  } finally {
    await view.cleanup();
  }
});

test("missing actions or an old DTO fails closed instead of inferring eligibility in the browser", async () => {
  // 旧 DTO：既没有 business 也没有 actions。
  const legacy = baseDetail();
  delete legacy.actions;
  delete legacy.business;
  delete legacy.candidateAvailability;
  const view = await renderDetail(legacy);
  try {
    await waitFor(() => text(view).includes("业务摘要未接入"));
    assert.ok(text(view).includes("受权摘要与领域结果暂未接入"), "缺摘要时明确说未接入而不是渲染空 JSON");
    assert.ok(text(view).includes("技术追溯"), "操作标识收进技术追溯");
    assert.ok(text(view).includes("本次操作资格暂未确认"), "缺 actions 明确说明且不给办理入口");
    for (const label of ["批准", "驳回", "执行"]) {
      assert.equal(buttonByText(label), undefined, `缺 actions 时不得出现${label}按钮`);
    }
    assert.equal(writes.length, 0, "缺资格时没有任何写入");
  } finally {
    await view.cleanup();
  }

  // 服务端返回本页未识别的动作名：只说明，不办理。
  const unknownAction = baseDetail({ actions: [eligibility("approve", true, "OK"), eligibility("escalate", true, "OK")] });
  const second = await renderDetail(unknownAction);
  try {
    await waitFor(() => text(second).includes("escalate"));
    assert.equal(buttonByText("escalate"), undefined, "未识别动作不渲染成可点按钮");
    assert.ok(text(second).includes("本页暂不支持的动作"), "普通提示明确说明当前不能办理该项");
    const trace = [...second.rootNode.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent === "载荷快照与模板标识");
    assert.ok(trace && !trace.open && trace.textContent.includes("escalate"), "原动作标识保留在默认折叠的技术说明内");
  } finally {
    await second.cleanup();
  }
});

test("self-approval stays forbidden and a later eligibility change is re-explained from the server", async () => {
  const selfRequest = baseDetail({
    requester: { username: "zz00003", displayUsername: "ZZ00003", name: "陈琳" },
    actions: [
      eligibility("approve", false, "SELF_REQUEST_NOT_ALLOWED"),
      eligibility("reject", false, "SELF_REQUEST_NOT_ALLOWED"),
      eligibility("execute", false, "STATUS_NOT_APPROVED", { nextStepCode: "APPROVAL_DECISION_REQUIRED" }),
    ],
  });
  const view = await renderDetail(selfRequest);
  try {
    await waitFor(() => text(view).includes("不能审批自己发起的申请"));
    assert.equal(buttonByText("批准").disabled, true, "申请人不能自批");
    assert.equal(buttonByText("驳回").disabled, true, "自批禁令同时覆盖驳回");
    assert.ok(text(view).includes("需要先有批准决定才能执行"), "执行侧给出下一步");
    assert.equal(writes.length, 0);

    // 资格变化：会话刷新后服务端改口「不在候选内」，解释必须跟着变，不能留旧文案。
    resetFixture({
      detail: baseDetail({
        requester: { username: "zz00003", displayUsername: "ZZ00003", name: "陈琳" },
        actions: [eligibility("approve", false, "NOT_CANDIDATE"), eligibility("reject", false, "NOT_CANDIDATE")],
      }),
    });
    const refreshed = snapshot();
    refreshed.session = { ...refreshed.session, id: "session-2" };
    await view.render({ snapshot: refreshed });
    await waitFor(() => text(view).includes("你不在这张申请的候选审批人内"));
    const currentAction = view.rootNode.querySelector('[aria-label="当前办理"]');
    assert.ok(currentAction.textContent.includes("批准、驳回：你不在这张申请的候选审批人内"), "合并后的解释跟着服务端资格变");
    assert.equal(currentAction.textContent.includes("不能审批自己发起的申请"), false, "旧的动作解释不得残留");
    assert.equal(buttonByText("批准").disabled, true);
  } finally {
    await view.cleanup();
  }
});

test("unregistered operations stay readable but every request-level action fails closed", async () => {
  const detail = baseDetail({
    operationCode: "approval.legacy.unknown",
    triggerCondition: "legacy",
    business: {
      requestId: "approval_req_fixt_1", businessType: "unknown", businessTitle: "未登记的业务操作",
      operationCode: "approval.legacy.unknown", executionMode: "UNSUPPORTED",
      summaryAvailable: false, detailsAvailable: false, restrictedReasonCodes: ["OPERATION_UNREGISTERED"],
    },
    operation: { code: "approval.legacy.unknown", triggerCondition: "legacy", payloadVersion: 1, payloadHash: "ff".padEnd(64, "f"), executionMode: "UNSUPPORTED" },
    actions: [
      eligibility("approve", false, "OPERATION_UNREGISTERED", { executionMode: "UNSUPPORTED" }),
      eligibility("reject", false, "OPERATION_UNREGISTERED", { executionMode: "UNSUPPORTED" }),
      eligibility("execute", false, "OPERATION_UNREGISTERED", { executionMode: "UNSUPPORTED" }),
      eligibility("addCandidate", false, "OPERATION_UNREGISTERED", { executionMode: "UNSUPPORTED" }),
      eligibility("replace", false, "OPERATION_UNREGISTERED", { executionMode: "UNSUPPORTED" }),
    ],
  });
  const view = await renderDetail(detail);
  try {
    await waitFor(() => text(view).includes("未登记的业务操作"));
    assert.ok(text(view).includes("该业务操作未登记，只读且不可办理"), "未登记原因可读");
    assert.ok(text(view).includes("不支持执行"), "执行方式按事实显示");
    for (const label of ["批准", "驳回", "执行"]) {
      assert.equal(buttonByText(label).disabled, true, `${label} 对未登记操作 fail closed`);
    }
    assert.equal(text(view).includes("追加审批人"), true, "追加候选同样不可用并被说明");
    assert.equal(writes.length, 0, "未登记操作没有任何写入入口被触发");
  } finally {
    await view.cleanup();
  }
});

test("candidate reading uses the approval-only endpoint and never the whole admin directory", async () => {
  const detail = baseDetail({
    actions: [eligibility("approve", false, "NOT_CANDIDATE"), eligibility("addCandidate", true, "OK")],
  });
  const view = await renderDetail(detail, {
    candidateOptions: {
      candidates: [
        { username: "zz00004", displayUsername: "ZZ00004", name: "周宁", isBoss: false, eligible: true, reasonCode: "OK" },
        { username: "zz00001", displayUsername: "ZZ00001", name: "Boss", isBoss: true, eligible: true, reasonCode: "OK" },
      ],
      excludedByReason: { TWO_FACTOR_REQUIRED: 2, GAME_SCOPE_DENIED: 1 },
      requesterExcluded: true,
      excludedFields: ["ip", "session", "credentials", "lastLoginAt"],
      requiredPermission: "approval.request.add_approver",
    },
  });
  try {
    await waitFor(() => text(view).includes("追加审批人"));
    await click(buttonByText("追加审批人"));
    await waitFor(() => getCalls.some((call) => call.includes("/candidate-options?requestId=approval_req_fixt_1")));
    await waitFor(() => text(view).includes("另有 2 人需要先启用双因素认证"));
    assert.equal(getCalls.some((call) => call.includes("/security/admins")), false, "不再为选审批人读取全管理员目录");
    assert.ok(text(view).includes("2 人需要先启用双因素认证"), "不合格者只给人数与原因");
    assert.ok(text(view).includes("1 人目标游戏不在你的业务范围内"), "范围不足同样只给人数");
    assert.ok(text(view).includes("原申请人已排除"), "带 requestId 时排除原申请人这一事实被说明");

    // 提交追加：原因少于 3 字不得放行，放行后组装正式 body。
    const reasonInput = view.rootNode.querySelector("textarea, input[placeholder*='追加']") ?? [...view.rootNode.querySelectorAll("input")].find((input) => input.placeholder.includes("追加"));
    assert.ok(reasonInput, "追加原因输入存在");
    const submit = buttonByText("提交追加");
    assert.equal(submit.disabled, true, "未选人或原因不足时不可提交");
    await click([...view.rootNode.querySelectorAll('[data-slot="select-trigger"]')][0]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const option = [...browser.document.querySelectorAll('[role="option"]')].find((item) => item.textContent.includes("周宁"));
    assert.ok(option, "候选人下拉列出合格者");
    await act(async () => option.click());
    await settle();
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
    setValue.call(reasonInput, "原候选已冻结");
    reasonInput.dispatchEvent(new browser.Event("input", { bubbles: true }));
    await settle();
    assert.equal(buttonByText("提交追加").disabled, false, "选人与原因齐备后可提交");
    await click(buttonByText("提交追加"));
    await waitFor(() => writes.length === 1);
    assert.equal(writes[0].path.endsWith("/security/approvals/requests/add-candidate"), true);
    assert.deepEqual(writes[0].body, { requestId: "approval_req_fixt_1", username: "zz00004", reason: "原候选已冻结" }, "只发送合同允许的字段");
    assert.match(writes[0].headers["idempotency-key"], /^idem_/, "写请求带幂等标识");
  } finally {
    await view.cleanup();
  }
});

/** 产生一笔真实未决写并返回其原 key；恢复类用例都需要从真实 UNKNOWN 状态出发。 */
async function openUnknownWrite(view, rootNodeRef) {
  await waitFor(() => text(view).includes("申请尊享礼遇 90 天"));
  await click(buttonByText("批准"));
  await waitFor(() => buttonByText("确认批准") !== undefined);
  await click(buttonByText("确认批准"));
  await waitFor(() => buttonByText("用原请求重试") !== undefined);
  return writes[0].headers["idempotency-key"];
}

async function mountRecovery(props) {
  resetFixture(props);
  globalThis.fetch = mockFetch;
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  await act(async () => {
    root.render(createElement(ApprovalAuditView, { snapshot: snapshot(), objectOnly: true, initialRequestId: "approval_req_fixt_1", initialQuery: {} }));
  });
  await settle();
  const view = { rootNode };
  const cleanup = async () => {
    await act(async () => root.unmount());
    rootNode.remove();
    globalThis.fetch = undefined;
  };
  return { view, cleanup };
}

// ── 恢复四态与终态信封 ─────────────────────────────────────────────────────

test("missing receipt keeps the responsibility and never reads as not executed", async () => {
  freshSession("rec-notfound");
  const { view, cleanup } = await mountRecovery({
    detail: baseDetail({ actions: [eligibility("approve", true, "OK")] }),
    failWrite: 500,
    recovery: { knowledge: "UNRESOLVED", operation: "approval.request.decide", targetRequestId: "approval_req_fixt_1", explanationCode: "RECEIPT_NOT_FOUND", resolution: "UNKNOWN_NOT_ABSENT" },
  });
  try {
    const key = await openUnknownWrite(view);
    fixture.recovery = { ...fixture.recovery, key };
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("没有找到这把请求标识对应的回执"));
    assert.ok(text(view).includes("读不到不等于没执行"), "未找到回执不得被说成没执行");
    assert.ok(getCalls.some((call) => call.includes("/approvals/recovery?operation=approval.request.decide")), "恢复读取带白名单操作");
    assert.ok(getCalls.some((call) => call.includes("requestId=approval_req_fixt_1")), "target 型操作带申请号");
    assert.ok(buttonByText("用原请求重试"), "责任保留");
  } finally {
    await cleanup();
  }
});

test("a complete known receipt resolves the panel and removes the replay affordance", async () => {
  freshSession("rec-known");
  const { view, cleanup } = await mountRecovery({
    detail: baseDetail({ actions: [eligibility("approve", true, "OK")] }),
    failWrite: 500,
  });
  try {
    const key = await openUnknownWrite(view);
    fixture.failWrite = null;
    fixture.recovery = {
      knowledge: "KNOWN", operation: "approval.request.decide", key, targetRequestId: "approval_req_fixt_1",
      fingerprint: "7e05".padEnd(64, "0"), committedAt: "2026-10-12T09:20:03.117Z", originalResponseStatus: 200, outcome: "ACCEPTED",
      receipt: { approvalRequestId: "approval_req_fixt_1", status: "APPROVED", decision: "APPROVED", executionMode: "GENERIC_TRANSACTION", expiresAt: "2026-10-13T09:12:44.318Z" },
    };
    await click(buttonByText("查询原结果"));
    // 读回成功即结束未决流程：回执面板收起，也不再给出 UNKNOWN 重放出口。
    await waitFor(() => text(view).includes("最新状态已读取"), 3000);
    assert.equal(buttonByText("用原请求重试"), undefined, "已核清后不再给出 UNKNOWN 重放出口");
    assert.equal(buttonByText("查询原结果"), undefined, "已核清后不再给出查询出口");
  } finally {
    await cleanup();
  }
});

test("an empty KNOWN envelope is not terminal evidence and keeps the responsibility", async () => {
  freshSession("rec-empty-known");
  const { view, cleanup } = await mountRecovery({
    detail: baseDetail({ actions: [eligibility("approve", true, "OK")] }),
    failWrite: 500,
  });
  try {
    const key = await openUnknownWrite(view);
    // Master R2 反例 C：knowledge=KNOWN 但没有 outcome / 状态 / 回执。
    fixture.recovery = { knowledge: "KNOWN", operation: "approval.request.decide", key, targetRequestId: "approval_req_fixt_1" };
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("不能据此判定原请求结果，责任保留"));
    assert.ok(text(view).includes("回执缺少原响应状态"), "指名缺哪一项终态证据");
    assert.ok(buttonByText("用原请求重试"), "空信封不解除责任");
    assert.ok(buttonByText("重新查询原结果"), "仍可继续核对");
  } finally {
    await cleanup();
  }
});

test("a self-contradictory receipt envelope keeps the responsibility", async () => {
  freshSession("rec-contradiction");
  const { view, cleanup } = await mountRecovery({
    detail: baseDetail({ actions: [eligibility("approve", true, "OK")] }),
    failWrite: 500,
  });
  try {
    const key = await openUnknownWrite(view);
    fixture.recovery = {
      knowledge: "KNOWN", operation: "approval.request.decide", key, targetRequestId: "approval_req_fixt_1",
      originalResponseStatus: 500, outcome: "ACCEPTED", receipt: { approvalRequestId: "approval_req_fixt_1", status: "APPROVED" },
    };
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("受理结果与原响应状态矛盾"));
    assert.ok(buttonByText("用原请求重试"), "矛盾信封不解除责任");
  } finally {
    await cleanup();
  }
});

test("a receipt addressed to another request keeps the responsibility", async () => {
  freshSession("rec-other-target");
  const { view, cleanup } = await mountRecovery({
    detail: baseDetail({ actions: [eligibility("approve", true, "OK")] }),
    failWrite: 500,
  });
  try {
    const key = await openUnknownWrite(view);
    fixture.recovery = {
      knowledge: "KNOWN", operation: "approval.request.decide", key, targetRequestId: "approval_req_other",
      originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: "approval_req_other", status: "APPROVED" },
    };
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("回执的标识、操作或目标与当前未决操作不一致"));
    assert.ok(buttonByText("用原请求重试"), "目标不符的回执不解除责任");
  } finally {
    await cleanup();
  }
});

test("denied recovery is reported as loss of recovery rights, not as a failed original write", async () => {
  freshSession("rec-denied");
  const { view, cleanup } = await mountRecovery({
    detail: baseDetail({ actions: [eligibility("approve", true, "OK")] }),
    failWrite: 500,
  });
  try {
    await openUnknownWrite(view);
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input), browser.location.href);
      if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/approvals/recovery")) {
        getCalls.push(url.pathname + url.search);
        return json({ error: { code: "FORBIDDEN", message: "Approval receipt scope is unavailable: GAME_SCOPE_DENIED" } }, 403);
      }
      return mockFetch(input, init);
    };
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("恢复读取被拒"));
    assert.ok(text(view).includes("不是原操作失败"), "恢复被拒不得改写成原操作失败");
    assert.ok(text(view).includes("没有产生第二次写入"), "恢复读取本身不写入");
  } finally {
    await cleanup();
  }
});

test("a failed recovery read keeps the responsibility and both exits", async () => {
  freshSession("rec-readfail");
  const { view, cleanup } = await mountRecovery({
    detail: baseDetail({ actions: [eligibility("approve", true, "OK")] }),
    failWrite: 500,
  });
  try {
    await openUnknownWrite(view);
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input), browser.location.href);
      if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/approvals/recovery")) {
        getCalls.push(url.pathname + url.search);
        return json({ error: { code: "INTERNAL_ERROR", message: "fixture failure" } }, 500);
      }
      return mockFetch(input, init);
    };
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("查询原结果失败"));
    assert.ok(text(view).includes("原责任仍未核清"), "读取失败不释放责任");
    assert.ok(buttonByText("用原请求重试") !== undefined, "仍保留原请求重试出口");
    assert.ok(buttonByText("暂时收起") !== undefined, "仍保留收起出口");
  } finally {
    await cleanup();
  }
});

// ── C1：回执正文也要与绑定目标一致并按后端终态枚举校验 ─────────────────────

/** 执行确认要求复述摘要前 8 字；填好后才可能真正提交。 */
async function passRecallCheck(detail) {
  const field = dialogField("复述摘要前 8 字");
  assert.ok(field, "执行确认含复述输入");
  const proto = field.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value").set;
  setValue.call(field, detail.summary.slice(0, 8));
  field.dispatchEvent(new browser.Event("input", { bubbles: true }));
  await settle();
}

function dialogField(match) {
  const dialog = document.querySelector('[data-slot="dialog-content"]');
  if (!dialog) return null;
  return [...dialog.querySelectorAll("input,textarea")].find((el) => (el.placeholder || "").includes(match) || (el.getAttribute("aria-label") || "").includes(match));
}

/** 外层信封完全匹配、只有正文有问题的 KNOWN 回执。 */
function envelope(receipt, extra = {}) {
  return {
    knowledge: "KNOWN", operation: "approval.request.decide", key: "idem_placeholder", targetRequestId: "approval_req_fixt_1",
    originalResponseStatus: 200, outcome: "ACCEPTED", receipt, ...extra,
  };
}

test("a receipt whose body names another request keeps the responsibility", async () => {
  freshSession("c1-body-target");
  const { view, cleanup } = await mountRecovery({
    detail: baseDetail({ actions: [eligibility("approve", true, "OK")] }),
    failWrite: 500,
  });
  try {
    const key = await openUnknownWrite(view);
    fixture.recovery = envelope({ approvalRequestId: "approval_req_other", status: "APPROVED", decision: "APPROVED" }, { key });
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("回执正文的申请号与当前未决请求不是同一笔"));
    assert.ok(buttonByText("用原请求重试"), "正文目标不符不解除责任");
    assert.equal(text(view).includes("原结果已核清"), false, "不得进入已核清态");
  } finally {
    await cleanup();
  }
});

test("a decide receipt that is not a terminal status keeps the responsibility", async () => {
  for (const status of ["", "PENDING", "NOT_A_STATUS"]) {
    freshSession("c1-decide-" + (status || "empty"));
    const { view, cleanup } = await mountRecovery({
      detail: baseDetail({ actions: [eligibility("approve", true, "OK")] }),
      failWrite: 500,
    });
    try {
      const key = await openUnknownWrite(view);
      fixture.recovery = envelope({ approvalRequestId: "approval_req_fixt_1", status, decision: "APPROVED" }, { key });
      await click(buttonByText("查询原结果"));
      await waitFor(() => text(view).includes("决定回执不是已生效的批准或驳回终态"));
      assert.ok(buttonByText("用原请求重试"), `空值／PENDING／未知状态(${status || "empty"}都不能作为决定终态`);
    } finally {
      await cleanup();
    }
  }
});

test("an execute receipt contradicting its own request status keeps the responsibility", async () => {
  freshSession("c1-execute-conflict");
  const detail = baseDetail({
    status: "APPROVED",
    actions: [eligibility("execute", true, "OK")],
  });
  const { view, cleanup } = await mountRecovery({ detail, failWrite: 500 });
  try {
    await waitFor(() => text(view).includes("此次申请改变什么"));
    await click(buttonByText("执行"));
    await waitFor(() => buttonByText("确认执行") !== undefined);
    await passRecallCheck(detail);
    await click(buttonByText("确认执行"));
    await waitFor(() => buttonByText("用原请求重试") !== undefined);
    fixture.recovery = {
      knowledge: "KNOWN", operation: "approval.request.execute", key: writes[0].headers["idempotency-key"],
      targetRequestId: detail.requestId, originalResponseStatus: 200, outcome: "ACCEPTED",
      receipt: { approvalRequestId: detail.requestId, status: "APPROVED", executionStatus: "SUCCEEDED" },
    };
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("执行回执的申请状态与执行结果矛盾"));
    assert.ok(buttonByText("用原请求重试"), "自相矛盾的执行回执不解除责任");
  } finally {
    await cleanup();
  }
});

// ── F1：模板受理回执必须是 CONFIGURED，版本号不能绕过状态 ──────────────────

test("the template receipt branch accepts only the backend's CONFIGURED projection", async () => {
  const bound = { key: "idem_a", operation: "approval.template.configure", target: null };
  const envelope = (receipt, extra = {}) => ({
    knowledge: "KNOWN", operation: bound.operation, key: bound.key, targetRequestId: null,
    originalResponseStatus: 200, outcome: "ACCEPTED", receipt, ...extra,
  });
  const { receiptEnvelopeIssue } = approvalContract;

  // 后端 configureTemplate 返回 { templateId, version, candidateCount, status: "CONFIGURED" }，
  // 恢复白名单不映射 version → templateVersion，所以合法投影是 CONFIGURED + candidateCount。
  assert.equal(receiptEnvelopeIssue(envelope({ status: "CONFIGURED", candidateCount: 2 }), bound), null, "合法后端投影可接受");
  assert.equal(receiptEnvelopeIssue(envelope({ status: "CONFIGURED", candidateCount: 2, templateVersion: 3 }), bound), null, "带合法版本号可接受");

  for (const receipt of [{ status: "PENDING" }, { status: "NOT_A_STATUS" }, { status: "" }, { candidateCount: 2 }]) {
    assert.equal(receiptEnvelopeIssue(envelope(receipt), bound), "模板回执不是已配置完成的终态", JSON.stringify(receipt) + " 不能作为模板终态");
  }
  // 版本号存在时仍要合法，且不能借版本绕过状态。
  assert.equal(receiptEnvelopeIssue(envelope({ status: "CONFIGURED", templateVersion: 0 }), bound), "模板回执的版本号不是合法正整数");
  assert.equal(receiptEnvelopeIssue(envelope({ status: "PENDING", templateVersion: 1 }), bound), "模板回执不是已配置完成的终态");
});

// ── C2：核清之后能继续办理，刷新是真读回 ───────────────────────────────────

test("a resolved request unblocks the next action once the latest state is read back", async () => {
  freshSession("c2-continue");
  const pending = baseDetail({ actions: [eligibility("approve", true, "OK"), eligibility("reject", true, "OK")] });
  const { view, cleanup } = await mountRecovery({ detail: pending, failWrite: 500 });
  try {
    const key = await openUnknownWrite(view);
    // 核清后读回的详情：已批准且服务端允许执行。
    fixture.recovery = {
      knowledge: "KNOWN", operation: "approval.request.decide", key, targetRequestId: pending.requestId,
      originalResponseStatus: 200, outcome: "ACCEPTED",
      receipt: { approvalRequestId: pending.requestId, status: "APPROVED", decision: "APPROVED" },
    };
    fixture.detail = baseDetail({
      status: "APPROVED",
      actions: [
        eligibility("approve", false, "STATUS_NOT_PENDING"),
        eligibility("reject", false, "STATUS_NOT_PENDING"),
        eligibility("execute", true, "OK"),
      ],
    });
    fixture.failWrite = null;
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("最新状态已读取"), 3000);
    const execute = buttonByText("执行");
    assert.ok(execute, "执行动作仍然列出");
    assert.equal(execute.disabled, false, "核清并读回后不再被未决责任阻塞");
    await click(execute);
    await waitFor(() => buttonByText("确认执行") !== undefined);
    await passRecallCheck(fixture.detail);
    await click(buttonByText("确认执行"));
    await waitFor(() => writes.length === 2);
    assert.equal(writes[1].path.endsWith("/requests/execute"), true, "下一步动作真实发出");
    assert.notEqual(writes[1].headers["idempotency-key"], key, "这是新的执行命令，不是重放已核清的决定");
  } finally {
    await cleanup();
  }
});

test("refreshing after a failed readback issues another GET and keeps the receipt", async () => {
  freshSession("c2-refresh");
  const pending = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const { view, cleanup } = await mountRecovery({ detail: pending, failWrite: 500 });
  try {
    const key = await openUnknownWrite(view);
    fixture.recovery = {
      knowledge: "KNOWN", operation: "approval.request.decide", key, targetRequestId: pending.requestId,
      originalResponseStatus: 200, outcome: "ACCEPTED",
      receipt: { approvalRequestId: pending.requestId, status: "APPROVED", decision: "APPROVED" },
    };
    const detailGets = () => getCalls.filter((call) => call.includes("/requests/detail")).length;
    fixture.failDetail = 500;
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("最新状态暂未读到"), 3000);
    assert.ok(text(view).includes("原结果已核清"), "读回失败不撤销已核清的回执");
    assert.ok(text(view).includes("不代表业务已落地"), "回执内容仍可查看");
    const before = detailGets();
    await click(buttonByText("刷新最新状态"));
    await waitFor(() => detailGets() > before, 3000);
    assert.equal(writes.length, 1, "刷新只做 GET，不重放已核清的命令");
    fixture.failDetail = null;
    await click(buttonByText("刷新最新状态"));
    await waitFor(() => text(view).includes("最新状态已读取"), 3000);
    assert.equal(buttonByText("刷新最新状态"), undefined, "读回成功后收起回执面板");
  } finally {
    await cleanup();
  }
});

// ── A：收起后重开同一记录不得换新 key ──────────────────────────────────────

test("a record never seen in memory is restored from storage and blocks a new key", async () => {
  freshSession("b-storage-only");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const subject = ["admin-boss", sessionId, detail.requestId, "approval.request.decide"].join("|");
  const storageKey = "zzsh.admin.approval.pending-write." + encodeURIComponent(subject);
  const seeded = {
    subject, actorId: "admin-boss", sessionId, target: detail.requestId,
    operation: "approval.request.decide", path: "/security/approvals/requests/decision",
    idempotencyKey: "idem_5eed0000000000000000", body: { requestId: detail.requestId, decision: "APPROVE" },
    readback: { kind: "detail-and-lists", requestId: detail.requestId, keys: [] },
    successMessage: "已记录首个有效批准。", kind: "unknown", at: new Date().toISOString(),
  };
  const { fake, restore } = withFakeStorage({ [storageKey]: JSON.stringify(seeded) });
  const view = await renderDetail(detail, { failWrite: 500 });
  try {
    await waitFor(() => buttonByText("用原请求重试") !== undefined, 3000);
    await click(buttonByText("暂时收起"));
    await click(buttonByText("批准"));
    await waitFor(() => buttonByText("确认批准") !== undefined);
    await click(buttonByText("确认批准"));
    await settle();
    assert.equal(writes.length, 0, "只靠存储读回的未决记录同样拦住新 key 的写");
    assert.equal(JSON.parse(fake.getItem(storageKey)).idempotencyKey, "idem_5eed0000000000000000", "存储里的原 key 未被覆盖");
  } finally {
    await view.cleanup();
    restore();
  }
});

test("dismissing then reopening the same request through the real click path cannot replace the key", async () => {
  freshSession("a-dismiss-reopen");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const view = await renderList({
    detail,
    failWrite: 500,
    requests: [{ ...detail }],
    view: { initialTab: "mine" },
  });
  try {
    await waitFor(() => text(view).includes("申请尊享礼遇 90 天"));
    // 真实路径：列表行 → 查看并处理 → 详情 → 批准 → 确认 → 500 未知。
    const row = () => [...view.rootNode.querySelectorAll("tbody tr")].find((r) => r.textContent.includes(detail.requestId));
    const openRow = () => [...row().querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("查看"));
    await click(openRow());
    await waitFor(() => buttonByText("批准") !== undefined, 3000);
    await click(buttonByText("批准"));
    await waitFor(() => buttonByText("确认批准") !== undefined);
    await click(buttonByText("确认批准"));
    await waitFor(() => buttonByText("用原请求重试") !== undefined, 3000);
    const key = writes[0].headers["idempotency-key"];
    assert.equal(writes.length, 1);

    await click(buttonByText("暂时收起"));
    assert.equal(buttonByText("用原请求重试"), undefined, "收起只隐藏面板");

    // 收起后重新点开同一行：未决面板必须回来。
    await click(openRow());
    await waitFor(() => buttonByText("用原请求重试") !== undefined, 3000);

    // 再收起一次，直接点批准也不能发出第二把 key。
    await click(buttonByText("暂时收起"));
    await click(buttonByText("批准"));
    await waitFor(() => buttonByText("确认批准") !== undefined);
    await click(buttonByText("确认批准"));
    await settle();
    assert.equal(writes.length, 1, "存在未核清记录时不再发出新 key 的写");
    assert.equal(writes[0].headers["idempotency-key"], key, "原 key 仍是唯一可重放的那一笔");
    assert.ok(text(view).includes("已有一笔未核清的同类请求"), "给出可行动的下一步");
    await waitFor(() => buttonByText("用原请求重试") !== undefined, 3000);
  } finally {
    await view.cleanup();
  }
});

/** 用假存储替换全局 sessionStorage；返回读写句柄与恢复函数。 */
function withFakeStorage(entries = {}, { failSet = false } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const map = new Map(Object.entries(entries));
  const fake = {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { if (failSet) throw new Error("QuotaExceededError"); map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
  };
  Object.defineProperty(globalThis, "sessionStorage", { value: fake, configurable: true, writable: true });
  return {
    fake,
    restore: () => {
      if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
      else delete globalThis.sessionStorage;
    },
  };
}

// ── B：存储故障与损坏记录 fail closed ──────────────────────────────────────

test("storage write failure blocks the first POST instead of sending it", async () => {
  freshSession("b-storage-fail");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const { restore } = withFakeStorage({}, { failSet: true });
  const view = await renderDetail(detail, {});
  try {
    await waitFor(() => text(view).includes("此次申请改变什么"));
    await click(buttonByText("批准"));
    await click(buttonByText("确认批准"));
    await settle();
    assert.equal(writes.length, 0, "落盘失败时不得发出业务 POST");
    assert.ok(text(view).includes("本次未提交"), "说明为何没有提交");
    assert.ok(buttonByText("批准") !== undefined, "原表单仍可再次尝试，不锁死页面");
  } finally {
    await view.cleanup();
    restore();
  }
});

test("a corrupt record blocks new writes and is never overwritten", async () => {
  freshSession("b-corrupt");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const subject = ["admin-boss", sessionId, detail.requestId, "approval.request.decide"].join("|");
  const storageKey = "zzsh.admin.approval.pending-write." + encodeURIComponent(subject);
  // 内存里没有该 subject，只能从存储读：这正是冷启动读取路径。
  const { fake, restore } = withFakeStorage({ [storageKey]: "{not json" });
  const view = await renderDetail(detail, {});
  try {
    await waitFor(() => text(view).includes("此次申请改变什么"));
    await click(buttonByText("批准"));
    await click(buttonByText("确认批准"));
    await settle();
    assert.equal(writes.length, 0, "损坏记录不得被新请求覆盖后放行");
    assert.ok(text(view).includes("读不出可信内容"), "损坏记录给出可行动的核对说明");
    assert.equal(fake.getItem(storageKey), "{not json", "损坏原文保持原样供人工核对");
  } finally {
    await view.cleanup();
    restore();
  }
});

test("a cold reload restores the unresolved write from storage, not from the in-process cache", async () => {
  freshSession("b-cold-read");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const first = await renderDetail(detail, { failWrite: 500 });
  let key = null;
  try {
    key = await openUnknownWrite(first);
  } finally {
    await first.cleanup();
  }
  // 绕开模块内存：直接断言存储里就是那把原 key，且新挂载能从存储读回并拦住新 key。
  const subject = ["admin-boss", sessionId, detail.requestId, "approval.request.decide"].join("|");
  const stored = JSON.parse(globalThis.sessionStorage.getItem("zzsh.admin.approval.pending-write." + encodeURIComponent(subject)) ?? "null");
  assert.equal(stored?.idempotencyKey, key, "原 key 确实落在存储里");
  const second = await renderDetail(detail, { failWrite: 500 });
  try {
    await waitFor(() => buttonByText("用原请求重试") !== undefined, 3000);
    await click(buttonByText("暂时收起"));
    const before = writes.length;
    await click(buttonByText("批准"));
    await click(buttonByText("确认批准"));
    await settle();
    assert.equal(writes.length, before, "冷读到的未决记录同样拦住新 key");
    assert.equal(JSON.parse(globalThis.sessionStorage.getItem("zzsh.admin.approval.pending-write." + encodeURIComponent(subject))).idempotencyKey, key, "存储里的原 key 未被覆盖");
  } finally {
    await second.cleanup();
  }
});


test("the workbench lists registered businesses with real initiation entries and never offers the test operation", async () => {
  const view = await renderList({
    operations: [
      { operationCode: "membership.benefit.policy.publish", businessType: "membership", title: "发布会员权益政策", executionMode: "GENERIC_TRANSACTION", testOnly: false, initiation: { allowed: true, reasonCode: "OK", requiredPermission: "approval.request.create" }, triggers: [{ triggerCondition: "membership.policy.publish.requested", templateVersion: 3, candidateTotal: 2, candidateEligible: 2, blockingReasonCode: null }] },
      { operationCode: "membership.entitlement.grant", businessType: "membership", title: "发放会员礼遇权益", executionMode: "GENERIC_TRANSACTION", testOnly: false, initiation: { allowed: false, reasonCode: "BUSINESS_PERMISSION_REQUIRED", requiredPermission: "membership.entitlement.request" }, triggers: [] },
      { operationCode: "order.settlement.adjust", businessType: "settlement", title: "人工调整订单结算", executionMode: "SOURCE_BUSINESS", testOnly: false, initiation: { allowed: false, reasonCode: "INITIATED_FROM_SOURCE_BUSINESS", requiredPermission: "approval.request.create" }, triggers: [] },
      { operationCode: "approval.test.execute", businessType: "test", title: "本地非资金测试动作", executionMode: "GENERIC_TRANSACTION", testOnly: true, initiation: { allowed: false, reasonCode: "TEST_OPERATION_DISABLED", requiredPermission: "approval.request.create" }, triggers: [] },
    ],
    view: { initialTab: "operations" },
  });
  try {
    await waitFor(() => text(view).includes("审批业务与发起入口"));
    assert.ok(text(view).includes("发布会员权益政策"), "已登记业务列出");
    assert.ok(text(view).includes("当前可发起"), "可发起资格来自服务端");
    assert.ok(text(view).includes("缺少该业务的阶段权限"), "不可发起给出业务语言原因");
    assert.ok(text(view).includes("只能由订单结算流程发起") || text(view).includes("由订单结算流程在结算事务内发起"), "结算的发起入口说明");
    assert.ok(text(view).includes("仅测试"), "测试操作被标为仅测试");
    assert.ok(text(view).includes("测试操作在当前环境未开启"), "测试操作不作为运营发起入口");
    assert.equal(view.rootNode.querySelector("form"), null, "工作台不再提供自由文本新建申请表单");
    assert.ok(text(view).includes("供给规则发布的审批绑定"), "规则发布的后端绑定缺口被显式登记");
    assert.ok(text(view).includes("本页不提供临时入口或占位按钮绕过"), "不用临时入口绕过");
  } finally {
    await view.cleanup();
  }
});

test("list rows lead with the business title and expose per-row eligibility from the server", async () => {
  const view = await renderList({
    requests: [
      { ...baseDetail({ requestId: "req-a", summary: "甲申请" }), business: membershipBusiness({ requestId: "req-a", changeSummary: "甲申请" }), actions: [eligibility("approve", true, "OK")] },
      { ...baseDetail({ requestId: "req-b", summary: "乙申请", status: "APPROVED" }), business: settlementBusiness({ requestId: "req-b", changeSummary: "乙申请" }), actions: [eligibility("execute", false, "EXECUTION_MODE_SOURCE_BUSINESS")] },
    ],
    view: { initialTab: "pending" },
  });
  try {
    await waitFor(() => text(view).includes("甲申请"));
    const rows = [...view.rootNode.querySelectorAll("tbody tr")];
    assert.equal(rows.length, 2);
    assert.ok(rows[0].textContent.includes("发放会员礼遇权益"), "业务名称是主文本");
    assert.ok(rows[1].textContent.includes("人工调整订单结算"), "结算业务名称是主文本");
    assert.equal(rows[0].textContent.includes("membership.entitlement.grant"), false, "裸操作码不作为列表主文本");
    assert.ok(rows[0].textContent.includes("待审批"), "审批状态列");
    assert.ok(rows[1].textContent.includes("结算未完成"), "业务进度与审批状态分列");
    assert.ok(rows[1].textContent.includes("待号主确认"), "业务进度带未完成条件");
    assert.ok(buttonByText("查看并处理", rows[0]), "有可办理动作的行给出处理入口");
    assert.ok(buttonByText("查看", rows[1]), "无可办理动作的行只给查看");
    assert.ok(text(view).includes("本页过滤") === false, "未过滤时不谎称已按全集过滤");
    assert.ok(text(view).includes("按条件查全集与统计暂未接入"), "全集筛选缺口以运营语言明示");
  } finally {
    await view.cleanup();
  }
});

// ── R1：未决责任跨卸载/重放被拒存活 ────────────────────────────────────────

test("an unresolved write survives unmount and remount for the same identity and object", async () => {
  freshSession("r1-remount");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK"), eligibility("reject", true, "OK")] });
  const first = await renderDetail(detail, { failWrite: 500 });
  let originalKey = null;
  let originalBody = null;
  try {
    await waitFor(() => text(first).includes("此次申请改变什么"));
    await click(buttonByText("批准"));
    await waitFor(() => buttonByText("确认批准") !== undefined);
    await click(buttonByText("确认批准"));
    await waitFor(() => text(first).includes("请求结果未知"));
    originalKey = writes[0].headers["idempotency-key"];
    originalBody = writes[0].body;
    assert.match(originalKey, /^idem_/);
  } finally {
    await first.cleanup();
  }

  // 同身份、同会话、同对象重新挂载：恢复入口必须回来，且重放沿用原 key。
  const second = await renderDetail(detail, { failWrite: 500 });
  try {
    await waitFor(() => buttonByText("用原请求重试") !== undefined, 3000);
    assert.ok(text(second).includes("责任记录里"), "重挂载后说明责任来自记录");
    await click(buttonByText("用原请求重试"));
    await waitFor(() => writes.length === 1);
    assert.equal(writes[0].headers["idempotency-key"], originalKey, "重放沿用原幂等标识");
    assert.deepEqual(writes[0].body, originalBody, "重放沿用原请求体");
  } finally {
    await second.cleanup();
  }
});

test("a rejected replay keeps the original unknown instead of clearing it", async () => {
  freshSession("r1-replay403");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const view = await renderDetail(detail, { failWrite: 500 });
  try {
    await waitFor(() => text(view).includes("此次申请改变什么"));
    await click(buttonByText("批准"));
    await click(buttonByText("确认批准"));
    await waitFor(() => text(view).includes("请求结果未知"));
    fixture.failWrite = 403;
    await click(buttonByText("用原请求重试"));
    await waitFor(() => text(view).includes("重放被拒不代表第一次写没有发生"));
    assert.ok(buttonByText("用原请求重试"), "重放被拒后原未知责任仍在");
    assert.ok(buttonByText("查询原结果"), "仍可查询原结果");
    assert.equal(writes.length, 2);
  } finally {
    await view.cleanup();
  }
});

test("a first-attempt explicit rejection is terminal and releases that one responsibility", async () => {
  freshSession("r1-first403");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const view = await renderDetail(detail, { failWrite: 409 });
  try {
    await waitFor(() => text(view).includes("此次申请改变什么"));
    await click(buttonByText("批准"));
    await click(buttonByText("确认批准"));
    await waitFor(() => buttonByText("用原请求重试") === undefined);
    assert.equal(buttonByText("用原请求重试"), undefined, "首次提交被明确拒绝不产生未知责任");
  } finally {
    await view.cleanup();
  }
  // 同身份重挂载也不得复活这笔已解除的责任。
  const again = await renderDetail(detail, {});
  try {
    await waitFor(() => text(again).includes("此次申请改变什么"));
    await settle();
    assert.equal(buttonByText("用原请求重试"), undefined, "已解除的责任不随重挂载复活");
  } finally {
    await again.cleanup();
  }
});

// ── R2：恢复查询绑定原意图 ─────────────────────────────────────────────────

test("a late recovery response from a previous identity cannot write into the new context", async () => {
  freshSession("r2-late");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const view = await renderDetail(detail, {
    failWrite: 500,
    holdRecovery: true,
    recovery: { knowledge: "KNOWN", operation: "approval.request.decide", key: "idem_late", targetRequestId: detail.requestId, originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: detail.requestId, status: "APPROVED" } },
  });
  try {
    await waitFor(() => text(view).includes("此次申请改变什么"));
    await click(buttonByText("批准"));
    await waitFor(() => buttonByText("确认批准") !== undefined);
    await click(buttonByText("确认批准"));
    await waitFor(() => buttonByText("用原请求重试") !== undefined);
    await click(buttonByText("查询原结果"));
    await waitFor(() => getCalls.some((call) => call.includes("/approvals/recovery")));
    // 查询挂起时切身份：旧查询的迟到回执不得写回新上下文。
    const other = snapshot();
    other.session = { ...other.session, id: "session-r2-other" };
    other.adminUserId = "admin-other";
    await view.render({ snapshot: other });
    await settle();
    assert.ok(releaseRecovery, "原查询仍在挂起");
    releaseRecovery();
    await settle();
    assert.equal(text(view).includes("原请求提交时间"), false, "迟到回执不写回新身份的面板");
    assert.equal(buttonByText("用原请求重试"), undefined, "新身份没有旧责任");
  } finally {
    if (releaseRecovery) releaseRecovery();
    await view.cleanup();
  }
});

test("a receipt whose identity fields do not match is treated as a read failure and keeps the responsibility", async () => {
  freshSession("r2-mismatch");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const view = await renderDetail(detail, {
    failWrite: 500,
    recovery: { knowledge: "KNOWN", operation: "approval.request.decide", key: "idem_some_other_key", targetRequestId: detail.requestId, originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: detail.requestId, status: "APPROVED" } },
  });
  try {
    await waitFor(() => text(view).includes("此次申请改变什么"));
    await click(buttonByText("批准"));
    await waitFor(() => buttonByText("确认批准") !== undefined);
    await click(buttonByText("确认批准"));
    await waitFor(() => buttonByText("用原请求重试") !== undefined);
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("回执的标识、操作或目标与当前未决操作不一致"));
    assert.ok(buttonByText("用原请求重试"), "不匹配回执不解除责任");
    assert.equal(text(view).includes("原请求提交时间"), false, "不匹配回执不按已知回执展示");
  } finally {
    await view.cleanup();
  }
});

test("lookup and same-key replay are mutually exclusive while either is in flight", async () => {
  freshSession("r2-mutex");
  const detail = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const view = await renderDetail(detail, { failWrite: 500, holdRecovery: true });
  try {
    await waitFor(() => text(view).includes("此次申请改变什么"));
    await click(buttonByText("批准"));
    await waitFor(() => buttonByText("确认批准") !== undefined);
    await click(buttonByText("确认批准"));
    await waitFor(() => buttonByText("用原请求重试") !== undefined);
    await click(buttonByText("查询原结果"));
    await waitFor(() => getCalls.some((call) => call.includes("/approvals/recovery")));
    assert.equal(buttonByText("用原请求重试").disabled, true, "查询在途时不允许交叠重放");
    assert.ok(releaseRecovery);
    releaseRecovery();
    await waitFor(() => buttonByText("用原请求重试").disabled === false);
  } finally {
    if (releaseRecovery) releaseRecovery();
    await view.cleanup();
  }
});

// ── R4：通用资格与本单资格分开 ─────────────────────────────────────────────

test("general eligibility is never presented as per-request eligibility", async () => {
  freshSession("r4-eligibility");
  const reviewFact = (view, label) => [...view.rootNode.querySelectorAll('section[aria-label="审批流程"] dl dt')].find((term) => term.textContent === label)?.nextElementSibling?.textContent;
  // 通用全合格，但本单 0 人可处理。
  const blocked = baseDetail({
    actions: [eligibility("approve", false, "BUSINESS_PERMISSION_REQUIRED"), eligibility("reject", false, "BUSINESS_PERMISSION_REQUIRED")],
    candidateAvailability: { total: 1, eligible: 0, blockingReasonCode: "NO_ELIGIBLE_CANDIDATE" },
  });
  const view = await renderDetail(blocked);
  try {
    await waitFor(() => text(view).includes("候选 1 人，无人可处理"));
    assert.equal(reviewFact(view, "本单可处理"), "0 人", "流程记录使用本单资格，不反推通用候选人数");
    assert.equal(text(view).includes("1 人当前合格"), false, "不得由通用名单反推本单合格人数");
    assert.equal(text(view).includes("当前可审批"), false, "个人徽标不得声称可审批这一单");
    assert.ok(text(view).includes("具备通用审批资格"), "个人徽标只声明通用资格");
    assert.ok(text(view).includes("候选 1 人，无人可处理"), "汇总与规则图口径一致");
  } finally {
    await view.cleanup();
  }

  // 自审批排除：快照 2 人、本单 1 人可处理。
  const self = baseDetail({
    requester: { username: "zz00003", displayUsername: "ZZ00003", name: "陈琳" },
    actions: [eligibility("approve", false, "SELF_REQUEST_NOT_ALLOWED")],
    candidateAvailability: { total: 2, eligible: 1, blockingReasonCode: null },
  });
  const second = await renderDetail(self);
  try {
    await waitFor(() => text(second).includes("候选 2 人，其中 1 人当前合格"));
    assert.equal(reviewFact(second, "本单可处理"), "1 人", "流程记录与服务端本单汇总一致");
    assert.ok(text(second).includes("不能审批自己发起的申请"), "自审批禁令就地说明");
    assert.equal(text(second).includes("2 人当前合格"), false, "不得把快照人数说成本单合格人数");
  } finally {
    await second.cleanup();
  }

  // 汇总缺失：显示未提供，不反推。
  const missing = baseDetail();
  delete missing.candidateAvailability;
  const third = await renderDetail(missing);
  try {
    await waitFor(() => reviewFact(third, "本单可处理") === "未提供");
    assert.equal(reviewFact(third, "本单可处理"), "未提供", "缺少本单汇总不能按候选快照补人数");
    assert.equal(text(third).includes("当前合格"), false, "汇总缺失时不给出合格人数");
  } finally {
    await third.cleanup();
  }
});

// ── R3：模板专职岗位的登记读取权限区分 ─────────────────────────────────────

test("a template-only role attempts the registry read and gets a permission explanation, not a deployment claim", async () => {
  freshSession("r3-template-only");
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/approvals/operations")) {
      getCalls.push(url.pathname + url.search);
      return json({ error: { code: "FORBIDDEN", message: "Permission required" } }, 403);
    }
    return mockFetch(input, init);
  };
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  try {
    await act(async () => {
      root.render(createElement(ApprovalAuditView, {
        snapshot: snapshot(["approval.template.read", "approval.template.configure"]),
        initialTab: "templates",
        initialQuery: {},
      }));
    });
    const view = { rootNode };
    await waitFor(() => getCalls.some((call) => call.includes("/approvals/operations")));
    await waitFor(() => text(view).includes("业务登记读取当前需要审批申请读取权限"));
    assert.equal(text(view).includes("业务登记读取未接入"), false, "权限不足不得说成未接入");
    assert.ok(text(view).includes("开放一项最小业务读取"), "说明需要什么能力才会可用，不暴露内部协调细节");
  } finally {
    await act(async () => root.unmount());
    rootNode.remove();
    globalThis.fetch = undefined;
  }
});

test("a rejected receipt reads back as a refusal, never as the original success wording", async () => {
  freshSession("f2-rejected");
  const pending = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const expired = baseDetail({
    status: "EXPIRED",
    statusReason: "申请已超过有效期",
    actions: [eligibility("approve", false, "EXPIRED"), eligibility("execute", false, "EXPIRED")],
  });
  const { view, cleanup } = await mountRecovery({ detail: pending, failWrite: 500 });
  try {
    const key = await openUnknownWrite(view);
    fixture.recovery = {
      knowledge: "KNOWN", operation: "approval.request.decide", key, targetRequestId: pending.requestId,
      originalResponseStatus: 409, outcome: "REJECTED",
      receipt: { rejection: { code: "CONFLICT", message: "Approval request is not pending", reasons: ["EXPIRED"] } },
    };
    fixture.detail = expired;
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("原请求当时已被拒绝"), 3000);
    assert.ok(text(view).includes("申请已过期，不再推进"), "拒绝原因按合同翻译展示");
    assert.equal(text(view).includes("已记录首个有效批准"), false, "不得拼接原批准的成功文案");
    assert.equal(text(view).includes("可按当前资格继续处理"), false, "拒绝不是可继续办理的暗示");
    assert.equal(writes.length, 1, "读回不重发命令");
    const refusalNotice = [...view.rootNode.querySelectorAll('[data-slot=status-message]')].find(node => node.textContent.includes('原请求当时已被拒绝'));
    assert.ok(refusalNotice, 'the verified refusal remains visible');
    assert.doesNotMatch(refusalNotice.className, /bg-success|border-success|bg-emerald|text-emerald/, 'known original refusal is not a green success notice');
  } finally {
    await cleanup();
  }
});

test("a rejected receipt whose first readback fails still reports the refusal after refresh", async () => {
  freshSession("f2-rejected-refresh");
  const pending = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const { view, cleanup } = await mountRecovery({ detail: pending, failWrite: 500 });
  try {
    const key = await openUnknownWrite(view);
    fixture.recovery = {
      knowledge: "KNOWN", operation: "approval.request.decide", key, targetRequestId: pending.requestId,
      originalResponseStatus: 409, outcome: "REJECTED",
      receipt: { rejection: { code: "CONFLICT", message: "Approval request is not pending", reasons: ["EXPIRED"] } },
    };
    const detailGets = () => getCalls.filter((call) => call.includes("/requests/detail")).length;
    fixture.failDetail = 500;
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("最新状态暂未读到"), 3000);
    assert.ok(text(view).includes("原结果已核清"), "读回失败不撤销已核清的回执");
    const before = detailGets();
    fixture.failDetail = null;
    await click(buttonByText("刷新最新状态"));
    await waitFor(() => detailGets() > before, 3000);
    await waitFor(() => text(view).includes("原请求当时已被拒绝"), 3000);
    assert.equal(text(view).includes("已记录首个有效批准"), false, "手动刷新同样不得用原命令成功文案");
    assert.equal(writes.length, 1, "两次刷新都只做 GET");
  } finally {
    await cleanup();
  }
});
test("a rejected receipt whose readback keeps failing never borrows the success wording", async () => {
  freshSession("f5-rejected-still-failing");
  const pending = baseDetail({ actions: [eligibility("approve", true, "OK")] });
  const { view, cleanup } = await mountRecovery({ detail: pending, failWrite: 500 });
  try {
    const key = await openUnknownWrite(view);
    fixture.recovery = {
      knowledge: "KNOWN", operation: "approval.request.decide", key, targetRequestId: pending.requestId,
      originalResponseStatus: 409, outcome: "REJECTED",
      receipt: { rejection: { code: "CONFLICT", message: "Approval request is not pending", reasons: ["EXPIRED"] } },
    };
    // 自动读回与手动刷新都持续 500：两次都只能陈述「已被拒绝 + 最新状态暂未读到」。
    fixture.failDetail = 500;
    await click(buttonByText("查询原结果"));
    await waitFor(() => text(view).includes("最新状态暂未读到"), 3000);
    assert.ok(text(view).includes("原请求当时已被拒绝"), "自动读回失败仍说明拒绝");
    assert.ok(text(view).includes("申请已过期，不再推进"), "拒绝原因按合同翻译");
    assert.equal(text(view).includes("已记录首个有效批准"), false, "不得拼接原批准成功文案");
    assert.equal(text(view).includes("已成功，最新状态未确认"), false, "不得把拒绝说成已成功");
    assert.equal(text(view).includes("最新状态已读取"), false, "读回失败不得声称已读取");
    const detailGets = () => getCalls.filter((call) => call.includes("/requests/detail")).length;
    const before = detailGets();
    await click(buttonByText("刷新最新状态"));
    await waitFor(() => detailGets() > before, 3000);
    assert.ok(text(view).includes("原请求当时已被拒绝"), "刷新再失败仍是拒绝说明");
    assert.ok(text(view).includes("最新状态暂未读到"), "刷新再失败仍承认未读到");
    assert.equal(text(view).includes("已记录首个有效批准"), false, "手动刷新再失败也不得借用成功文案");
    assert.equal(writes.length, 1, "全程只有一次原始 POST，刷新只做 GET");
  } finally {
    await cleanup();
  }
});


test("usability first package: self-blocker is visible before the flow and technical details start closed", async () => {
  freshSession("usability-self");
  const detail = baseDetail({
    business: membershipBusiness(),
    candidateAvailability: { total: 1, eligible: 0, blockingReasonCode: "SELF_REQUEST_NOT_ALLOWED" },
    actions: [eligibility("approve", false, "SELF_REQUEST_NOT_ALLOWED"), eligibility("reject", false, "SELF_REQUEST_NOT_ALLOWED")],
  });
  const view = await renderDetail(detail);
  try {
    await waitFor(() => text(view).includes("发放会员礼遇权益"));
    const current = view.rootNode.querySelector('[aria-label="当前办理"]');
    assert.ok(current, "the original server blocker and action entry must be visible first");
    assert.match(current.textContent, /不能审批自己发起的申请/);
    const flow = view.rootNode.querySelector('[aria-label="审批流程"]');
    const details = view.rootNode.querySelector("[data-approval-business-details]");
    assert.ok(flow && details);
    assert.equal(details.open, false, "snapshot hashes are available on demand");
    assert.ok(current.compareDocumentPosition(flow) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(flow.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(buttonByText("批准", current).disabled, true);
    assert.equal(writes.length, 0);
  } finally { await view.cleanup(); }
});

test("usability first package: flow locates the original execute confirmation and never posts by itself", async () => {
  freshSession("usability-flow");
  const detail = baseDetail({
    status: "APPROVED", business: membershipBusiness(),
    decision: { decision: "APPROVED", approver: { username: "reviewer", name: "已决定人员" }, createdAt: "2026-10-12T10:00:00Z", reason: "核对通过" },
    actions: [eligibility("execute", true, "OK")],
  });
  const view = await renderDetail(detail);
  try {
    await waitFor(() => text(view).includes("发放会员礼遇权益"));
    await click(buttonByText("定位当前办理", view.rootNode));
    const current = view.rootNode.querySelector('[aria-label="当前办理"]');
    assert.equal(document.activeElement, current);
    assert.equal(writes.length, 0);
    await click(buttonByText("执行", current));
    const confirm = buttonByText("确认执行");
    assert.ok(confirm);
    assert.equal(confirm.disabled, true, "the original eight-character confirmation still gates execution");
    assert.equal(writes.length, 0);
    await click(buttonByText("取消"));
    assert.equal(writes.length, 0);
  } finally { await view.cleanup(); }
});

test("usability first package: daily actions and configuration have separate entry groups", async () => {
  freshSession("usability-navigation");
  const view = await renderList({ requests: [] });
  try {
    const daily = view.rootNode.querySelector('[aria-label="日常处理"]');
    const config = view.rootNode.querySelector('[aria-label="审批配置"]');
    assert.ok(daily && config);
    assert.ok(buttonByText("待我处理", daily));
    assert.ok(buttonByText("我的申请", daily));
    assert.equal(buttonByText("模板与规则", daily), undefined);
    assert.ok(buttonByText("模板与规则", config));
    assert.equal(writes.length, 0);
  } finally { await view.cleanup(); }
});

test("usability first package: source-business next step navigates the existing object without generic execution", async () => {
  freshSession("usability-source");
  const business = settlementBusiness(), opened = [];
  const detail = baseDetail({
    status: "APPROVED", business,
    operation: { ...baseDetail().operation, code: "order.settlement.adjust", executionMode: "SOURCE_BUSINESS" },
    actions: [eligibility("execute", false, "EXECUTION_MODE_SOURCE_BUSINESS", { executionMode: "SOURCE_BUSINESS", nextStepCode: "SOURCE_BUSINESS_COMPLETION_REQUIRED" })],
  });
  const view = await renderDetail(detail, { view: { onOpenPath: (path, title) => opened.push({ path, title }) } });
  try {
    await waitFor(() => text(view).includes("人工调整订单结算"));
    const current = view.rootNode.querySelector('[aria-label="当前办理"]');
    assert.ok(current);
    assert.equal(buttonByText("执行", current).disabled, true);
    await click(buttonByText("前往来源业务", current));
    const order = business.objectRefs.find(ref => ref.type === "rental_order");
    assert.equal(opened.at(-1).path, "/orders/" + encodeURIComponent(order.id));
    assert.equal(writes.length, 0);
  } finally { await view.cleanup(); }
});


test("usability r1: primary refusal reasons stay visible beside an allowed navigation or repair entry", async () => {
  for (const auxiliary of ["replace", "addCandidate"]) {
    freshSession("usability-r1-" + auxiliary);
    const opened = [], business = membershipBusiness();
    const detail = baseDetail({
      business, requester: baseDetail().candidates[0],
      candidateAvailability: { total: 1, eligible: 0, blockingReasonCode: null },
      actions: [
        eligibility("approve", false, "SELF_REQUEST_NOT_ALLOWED"),
        eligibility("reject", false, "SELF_REQUEST_NOT_ALLOWED"),
        eligibility("execute", false, "STATUS_NOT_APPROVED", { nextStepCode: "APPROVAL_DECISION_REQUIRED" }),
        eligibility(auxiliary, true, "OK"),
      ],
    });
    const view = await renderDetail(detail, { view: { onOpenPath: (path, title) => opened.push({ path, title }) } });
    try {
      await waitFor(() => text(view).includes("发放会员礼遇权益"));
      const current = view.rootNode.querySelector('[aria-label="当前办理"]');
      assert.ok(current);
      console.log("APPROVAL_R1_PRIMARY_REFUSALS " + JSON.stringify({ auxiliary, currentText: current.textContent, posts: writes.length }));
      assert.match(current.textContent, /不能审批自己发起的申请/, auxiliary);
      assert.match(current.textContent, /需要先有批准决定才能执行/, auxiliary);
      assert.doesNotMatch(current.textContent, /服务端/, "ordinary guidance uses the actual human-readable reasons");
      for (const label of ["批准", "驳回", "执行"]) assert.equal(buttonByText(label, current).disabled, true, label);
      if (auxiliary === "replace") {
        assert.equal(buttonByText("回到来源业务重新发起", current), undefined);
        await click(buttonByText("返回来源业务", current));
        assert.equal(opened.at(-1).path, "/membership-growth");
        assert.equal(opened.at(-1).title, "重新发起（替代本申请）", "the existing navigation callback parameters remain unchanged");
      }
      assert.equal(writes.length, 0, "navigation and presentation do not issue a POST");
    } finally { await view.cleanup(); }
  }
});
