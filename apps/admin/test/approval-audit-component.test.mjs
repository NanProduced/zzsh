/**
 * ADM-APPROVAL-UI-2 · 审批中心生命周期与结果未知责任（组件层）
 *
 * 旧测试围绕分离的 mine/pending/audit 接口、模板配置与密码复核构建。新 UI 只保留
 * 一条统一列表接口，但「写入前落盘、结果未知只查原结果或用原请求重试、沿用同一
 * 幂等键、迟到响应序号守卫、上下文切换重新读取」这些生命周期契约仍然成立，
 * 本文件按新接口与新 DOM 重新验证它们。
 *
 * 仍然渲染真实组件、拦截真实 fetch 并断言真实请求参数；不 mock 掉组件行为。
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
  cacheDir: fileURLToPath(new URL("../../../tmp/approval-vite-cache/audit-component/", import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const { ApprovalAuditView } = await vite.ssrLoadModule("/src/views/approval-audit-view.tsx");
const contract = await vite.ssrLoadModule("/src/views/approval/contract.ts");
const { APPROVAL_WRITE_PATHS, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PERMS = ["approval.request.read", "approval.request.approve", "approval.audit.read"];
const REQUESTER = { username: "zz00002", displayUsername: "ZZ00002", name: "申请人小李" };

let sessionId = "session-1";
function snapshot(perms = PERMS) {
  return {
    authenticated: true,
    adminUserId: "admin-ops",
    user: { name: "运营小周", username: "zz00007", displayUsername: "ZZ00007", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    session: { id: sessionId, locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions: perms,
  };
}

function actionsFor(status = "PENDING") {
  const pending = status === "PENDING";
  return [
    { action: "approve", allowed: pending, reasonCode: pending ? "OK" : "STATUS_NOT_PENDING" },
    { action: "reject", allowed: pending, reasonCode: pending ? "OK" : "STATUS_NOT_PENDING" },
    { action: "withdraw", allowed: pending, reasonCode: pending ? "OK" : "REQUESTER_ONLY" },
  ];
}

function makeSummary(requestId, status, text, operationCode = "membership.entitlement.grant") {
  return {
    requestId, operationCode, summary: text, status, statusReason: null,
    requester: REQUESTER, createdAt: "2026-09-24T00:00:00.000Z",
    business: { businessTitle: "发放会员礼遇", changeSummary: text, summary: {} },
    actions: actionsFor(status),
  };
}

/** 列表行显示业务标题与申请人，不直接显示 summary 文本；用申请人姓名做可区分标记。 */
function withRequester(summary, name, username) {
  summary.requester = { username, displayUsername: username.toUpperCase(), name };
  return summary;
}

function makeDetail(requestId, status, text, operationCode = "membership.entitlement.grant") {
  return {
    ...makeSummary(requestId, status, text, operationCode),
    operation: { code: operationCode, triggerCondition: operationCode + ".requested", payloadVersion: 1, payloadHash: "hash-" + requestId },
    template: { id: "tpl-1", version: 1 },
    decision: null, execution: null, candidates: [],
    history: [{
      eventId: "evt-1", actor: REQUESTER, action: "approval.request.created", objectType: "approval_request",
      objectId: requestId, outcome: "SUCCESS", reason: null, requestId,
      occurredAt: "2026-09-24T00:00:00.000Z", details: {},
    }],
    supersedesRequestId: null, supersededByRequestId: null,
  };
}

// ── fetch 夹具 ─────────────────────────────────────────────────────────────
let calls = [];
let decisionHttpStatus = 200;
let recoveryResponse = { knowledge: "UNRESOLVED", operation: "approval.request.decide", key: "idem_x" };
let holdFirstList = false;
let releaseFirstList = null;
let listCallCount = 0;
let listPayload = null;
let detailResponse = null;

async function mockFetch(input, init = {}) {
  const url = new URL(String(input), browser.location.href);
  const method = init.method ?? "GET";
  const record = {
    path: url.pathname, search: url.search, method,
    body: init.body ? JSON.parse(init.body) : undefined,
    headers: init.headers ?? {},
  };
  calls.push(record);
  if (method !== "GET") {
    if (url.pathname.endsWith("/requests/decision")) return json({ status: "APPROVED", requestId: record.body.requestId }, decisionHttpStatus);
    if (url.pathname.endsWith("/requests/withdraw")) return json({ status: "CANCELLED", requestId: record.body.requestId }, decisionHttpStatus);
    return json({});
  }
  if (url.pathname.endsWith("/security/approvals/requests")) {
    listCallCount += 1;
    if (holdFirstList && listCallCount === 1) {
      return new Promise((resolve) => {
        releaseFirstList = () => resolve(json({
          requests: [withRequester(makeSummary("old", "PENDING", "旧数据样本"), "旧数据样本", "old")],
          nextCursor: null, scope: "pending", pendingCount: 0,
        }));
      });
    }
    return json(listPayload ?? {
      requests: [makeSummary("r1", "PENDING", "发放会员礼遇给老客户")],
      nextCursor: null, scope: "pending", pendingCount: 2,
    });
  }
  if (url.pathname.endsWith("/security/approvals/requests/detail")) {
    return json(detailResponse ?? makeDetail(url.searchParams.get("requestId") ?? "r1", "PENDING", "发放会员礼遇给老客户"));
  }
  if (url.pathname.endsWith("/security/approvals/recovery")) {
    // 回执标识必须与请求里的 key/operation/requestId 一致，否则组件按「读取失败」处理。
    return json({
      ...recoveryResponse,
      key: url.searchParams.get("key") ?? recoveryResponse.key,
      operation: url.searchParams.get("operation") ?? recoveryResponse.operation,
      targetRequestId: url.searchParams.get("requestId") ?? null,
    });
  }
  throw new Error(`unexpected test request ${url.pathname}${url.search}`);
}

function resetFixtures(tag) {
  sessionId = "session-" + tag;
  globalThis.sessionStorage.clear();
  calls = [];
  decisionHttpStatus = 200;
  recoveryResponse = { knowledge: "UNRESOLVED", operation: "approval.request.decide", key: "idem_x" };
  holdFirstList = false;
  releaseFirstList = null;
  listCallCount = 0;
  listPayload = null;
  detailResponse = null;
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

function buttonByText(text, root = browser.document.body) {
  return [...root.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
}

function setInput(element, value) {
  assert.ok(element, "expected input element");
  const proto = element.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  element.dispatchEvent(new browser.Event("input", { bubbles: true }));
}

function actionDialog() {
  return browser.document.querySelector('[data-slot="dialog-content"]');
}

async function openAction(view, label) {
  await clickRaw(buttonByText(label, view.host));
  await waitFor(() => actionDialog() !== null);
  return actionDialog();
}

function makeHost() {
  for (const previous of [...browser.document.querySelectorAll(".workspace-root")]) previous.classList.remove("workspace-root");
  const host = browser.document.createElement("div");
  host.className = "workspace-root";
  browser.document.body.appendChild(host);
  return host;
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

async function renderDetail(t, overrides = {}) {
  resetFixtures(overrides.tag ?? "lifecycle");
  if (overrides.detail) detailResponse = overrides.detail;
  if (overrides.decisionHttpStatus !== undefined) decisionHttpStatus = overrides.decisionHttpStatus;
  const view = await renderView({ initialRequestId: "r1", ...(overrides.viewProps ?? {}) });
  t.after(() => view.cleanup());
  await waitFor(() => view.host.textContent.includes("技术详情"));
  return view;
}

function listCalls() {
  return calls.filter((call) => call.method === "GET" && call.path.endsWith("/security/approvals/requests"));
}

function postCalls(suffix) {
  return calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));
}

function storedRecords() {
  const records = [];
  const storage = globalThis.sessionStorage;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith("zzsh.admin.approval.pending-write.")) records.push(storage.getItem(key));
  }
  return records;
}

// ── 1. 权限与写入契约 ─────────────────────────────────────────────────────

test("没有任何审批权限时视图拒绝，且不再渲染申请列表", async (t) => {
  resetFixtures("no-permission");
  const view = await renderView({ snapshot: snapshot([]) });
  t.after(() => view.cleanup());
  await settle();
  assert.ok(view.host.textContent.includes("当前账号没有审批读取或办理权限。"));
  assert.equal(view.host.querySelector("table"), null);
  assert.equal(view.host.querySelector('section[aria-label="办理"]'), null);
});

test("决定写入带 idempotency-key 头，且成功后按 GET 读回详情与统一列表", async (t) => {
  const view = await renderDetail(t, { tag: "decide-readback" });
  const dialog = await openAction(view, "批准");
  await clickRaw(buttonByText("确认批准", dialog));
  await waitFor(() => postCalls("/requests/decision").length >= 1);
  const write = postCalls("/requests/decision")[0];
  assert.ok(write.headers["idempotency-key"], "决定写入带幂等键");
  assert.equal(write.body.decision, "APPROVE");
  assert.ok(!("password" in write.body));
  await waitFor(() => calls.filter((call) => call.method === "GET" && call.path.endsWith("/requests/detail")).length >= 2);
  assert.ok(listCalls().length >= 2, "写成功后重新读取统一列表");
  assert.equal(postCalls("/requests/execute").length, 0);
});

test("恢复白名单只登记决定与撤回路径，不登记密码或旧执行/追加审批人写", () => {
  assert.equal(APPROVAL_WRITE_PATHS["/security/approvals/requests/decision"], "approval.request.decide");
  assert.equal(APPROVAL_WRITE_PATHS["/security/approvals/requests/withdraw"], "approval.request.withdraw");
  assert.equal(pendingWriteSubject("a", "s", "r1", "approval.request.decide"), "a|s|r1|approval.request.decide");
});

// ── 2. 结果未知：只查原结果或用原请求重试，沿用原幂等键 ────────────────────

test("结果未知只提供「查询原结果」与「用原请求重试」，明确禁止换请求重试", async (t) => {
  const view = await renderDetail(t, { tag: "unknown-exits", decisionHttpStatus: 500 });
  const dialog = await openAction(view, "批准");
  await clickRaw(buttonByText("确认批准", dialog));
  await waitFor(() => view.host.textContent.includes("请求结果未知"));
  assert.ok(view.host.textContent.includes("不要换请求重试"));
  assert.ok(buttonByText("用原请求重试", view.host), "提供用原请求重试");
  assert.ok(buttonByText("查询原结果", view.host), "提供查询原结果");
  for (const forbidden of ["换请求重新提交", "重新提交申请", "用新请求重试"]) {
    assert.ok(!view.host.textContent.includes(forbidden), `不应出现 ${forbidden}`);
  }
});

test("用原请求重试沿用同一幂等键与同一请求体，不换键", async (t) => {
  const view = await renderDetail(t, { tag: "retry-same-key", decisionHttpStatus: 500 });
  const dialog = await openAction(view, "批准");
  await act(async () => setInput(dialog.querySelector('textarea[placeholder="补充说明（可选）"]'), "核对无误"));
  await clickRaw(buttonByText("确认批准", dialog));
  await waitFor(() => postCalls("/requests/decision").length >= 1);
  const first = postCalls("/requests/decision")[0];
  await clickRaw(buttonByText("用原请求重试", view.host));
  await waitFor(() => postCalls("/requests/decision").length >= 2);
  const second = postCalls("/requests/decision")[1];
  assert.equal(second.headers["idempotency-key"], first.headers["idempotency-key"], "重试沿用原幂等键");
  assert.deepEqual(second.body, first.body, "重试沿用原请求体");
});

test("查询原结果走统一恢复接口，带 operation / key / requestId", async (t) => {
  const view = await renderDetail(t, { tag: "lookup", decisionHttpStatus: 500 });
  const dialog = await openAction(view, "批准");
  await clickRaw(buttonByText("确认批准", dialog));
  await waitFor(() => postCalls("/requests/decision").length >= 1);
  const key = postCalls("/requests/decision")[0].headers["idempotency-key"];
  await clickRaw(buttonByText("查询原结果", view.host));
  await waitFor(() => calls.some((call) => call.path.endsWith("/security/approvals/recovery")));
  const lookup = calls.find((call) => call.path.endsWith("/security/approvals/recovery"));
  const params = new URLSearchParams(lookup.search);
  assert.equal(params.get("operation"), "approval.request.decide");
  assert.equal(params.get("key"), key);
  assert.equal(params.get("requestId"), "r1");
  assert.ok(view.host.textContent.includes("没有找到这把请求标识对应的回执"), "UNRESOLVED 不解除责任");
});

test("高影响批准的动态码只随 POST 发送，不写进 sessionStorage 责任记录", async (t) => {
  const view = await renderDetail(t, {
    tag: "stepup-storage",
    decisionHttpStatus: 500,
    detail: makeDetail("r1", "PENDING", "调整分销政策", "distribution.policy.publish"),
  });
  const dialog = await openAction(view, "批准");
  const totp = dialog.querySelector('input[aria-label="批准动态验证码"]');
  assert.ok(totp);
  await act(async () => setInput(totp, "123456"));
  await clickRaw(buttonByText("确认批准", dialog));
  await waitFor(() => postCalls("/requests/decision").length >= 1);
  assert.equal(postCalls("/requests/decision")[0].body.totpCode, "123456", "动态码随请求发出");
  const records = storedRecords();
  assert.ok(records.length >= 1, "结果未知时责任记录已落盘");
  for (const raw of records) {
    assert.ok(!raw.includes("totpCode"), "动态码不进入待核对记录");
    assert.ok(!raw.includes("password"), "密码不进入待核对记录");
    assert.ok(!raw.includes("123456"), "动态码明文不落盘");
  }
  assert.ok(view.host.querySelector('input[aria-label="原请求重试动态码"]'), "重试需重新输入动态码");
});

// ── 3. 生命周期：序号守卫、上下文切换与刷新 ─────────────────────────────────

test("迟到列表响应不能覆盖刷新后的数据", async (t) => {
  resetFixtures("seq-guard");
  holdFirstList = true;
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => typeof releaseFirstList === "function");
  listPayload = { requests: [withRequester(makeSummary("fresh", "PENDING", "刷新后样本"), "刷新后样本", "fresh")], nextCursor: null, scope: "pending", pendingCount: 0 };
  await view.render({ refreshNonce: 1 });
  await waitFor(() => view.host.textContent.includes("刷新后样本"));
  await act(async () => { releaseFirstList(); });
  await settle();
  assert.ok(view.host.textContent.includes("刷新后样本"), "保留新请求结果");
  assert.ok(!view.host.textContent.includes("旧数据样本"), "迟到响应不得覆盖");
});

test("refreshNonce 变化会重新读取统一列表", async (t) => {
  resetFixtures("refresh-nonce");
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => listCalls().length >= 1);
  const before = listCalls().length;
  await view.render({ refreshNonce: 1 });
  await waitFor(() => listCalls().length > before);
  assert.ok(listCalls().length >= before + 1);
});

test("身份与会话上下文切换后清空旧列表并重新读取", async (t) => {
  resetFixtures("context-switch");
  listPayload = { requests: [withRequester(makeSummary("first", "PENDING", "切换前样本"), "切换前样本", "first")], nextCursor: null, scope: "pending", pendingCount: 0 };
  const view = await renderView();
  t.after(() => view.cleanup());
  await waitFor(() => view.host.textContent.includes("切换前样本"));
  sessionId = "session-after-switch";
  listPayload = { requests: [withRequester(makeSummary("second", "PENDING", "切换后样本"), "切换后样本", "second")], nextCursor: null, scope: "pending", pendingCount: 0 };
  await view.render({ snapshot: snapshot() });
  await waitFor(() => view.host.textContent.includes("切换后样本"));
  assert.ok(!view.host.textContent.includes("切换前样本"), "上下文切换后旧数据被清空");
});

test("切换申请对象时旧详情不会残留", async (t) => {
  resetFixtures("object-switch");
  const view = await renderView({ initialRequestId: "r1" });
  t.after(() => view.cleanup());
  await waitFor(() => view.host.textContent.includes("技术详情"));
  detailResponse = makeDetail("r2", "PENDING", "另一张申请的内容");
  await view.render({ initialRequestId: "r2" });
  await waitFor(() => view.host.textContent.includes("另一张申请的内容"));
  assert.ok(!view.host.textContent.includes("发放会员礼遇给老客户"));
});

// ── 4. 恢复回执终态证据（纯契约，仍由组件沿用）────────────────────────────

const BOUND = { key: "idem_1", operation: "approval.request.decide", target: "r1" };
function knownReceipt(overrides = {}) {
  return {
    knowledge: "KNOWN", operation: "approval.request.decide", key: "idem_1", targetRequestId: "r1",
    originalResponseStatus: 200, outcome: "ACCEPTED",
    receipt: { approvalRequestId: "r1", status: "APPROVED", decision: "APPROVED" },
    ...overrides,
  };
}

test("完整且自洽的 KNOWN 回执才是终态证据", () => {
  assert.equal(contract.receiptEnvelopeIssue(knownReceipt(), BOUND), null);
});

test("空的 KNOWN 信封不是终态证据", () => {
  assert.ok(contract.receiptEnvelopeIssue(knownReceipt({ receipt: null }), BOUND));
  assert.ok(contract.receiptEnvelopeIssue(knownReceipt({ originalResponseStatus: undefined }), BOUND));
  assert.ok(contract.receiptEnvelopeIssue(knownReceipt({ outcome: undefined }), BOUND));
});

test("自相矛盾或目标不一致的回执保留责任", () => {
  assert.match(contract.receiptEnvelopeIssue(knownReceipt({ originalResponseStatus: 500 }), BOUND), /矛盾/);
  assert.match(contract.receiptEnvelopeIssue(knownReceipt({ receipt: { approvalRequestId: "r1", status: "APPROVED", decision: "REJECTED" } }), BOUND), /矛盾/);
  assert.match(contract.receiptEnvelopeIssue(knownReceipt({ targetRequestId: "other" }), BOUND), /不一致/);
  assert.match(contract.receiptEnvelopeIssue(knownReceipt({ key: "idem_other" }), BOUND), /不一致/);
});

test("决定回执不是终态（PENDING）时不能据此判定结果", () => {
  assert.match(contract.receiptEnvelopeIssue(knownReceipt({ receipt: { approvalRequestId: "r1", status: "PENDING", decision: "APPROVED" } }), BOUND), /终态/);
});

test("被拒绝的回执缺少原因码时不是合法终态证据", () => {
  const rejected = knownReceipt({ originalResponseStatus: 409, outcome: "REJECTED", receipt: { rejection: {} } });
  assert.ok(contract.receiptEnvelopeIssue(rejected, BOUND));
  const valid = knownReceipt({ originalResponseStatus: 409, outcome: "REJECTED", receipt: { rejection: { code: "SELF_REQUEST_NOT_ALLOWED", message: "不能自批" } } });
  assert.equal(contract.receiptEnvelopeIssue(valid, BOUND), null);
});

test("已核实回执的结果说明不借用原命令的成功文案", () => {
  const summary = contract.recoveryOutcomeSummary(knownReceipt({ outcome: "REJECTED", originalResponseStatus: 409, receipt: { rejection: { code: "SELF_REQUEST_NOT_ALLOWED", message: "不能自批" } } }));
  assert.match(summary, /原请求当时已被拒绝/);
  assert.ok(!summary.includes("已记录批准"));
  assert.match(contract.recoveryOutcomeUnconfirmedSummary(knownReceipt()), /原请求已确认受理/);
  assert.match(contract.recoveryOutcomeUnconfirmedSummary(knownReceipt()), /未重发|重试读取|最新状态暂未读到/);
});
