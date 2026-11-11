/**
 * ADM-APPROVAL-UI-2 · 礼遇调整后批准（决定表单契约）
 *
 * 旧测试用「批准/驳回」按钮 + 密码/TOTP 复核对话框。新详情页内联「决定区」，
 * 按钮改为「确认批准/确认驳回/撤回申请」，调整礼遇收进「调整礼遇后批准」
 * 折叠块；决定 callback 的第 3 参是 6 位动态码（仅高影响类型），不再有 password。
 * 本文件按新表单验证：调整载荷、驳回不带 amendment、非法比例禁用、旧 DTO
 * 不暴露编辑入口、切换申请清空编辑。
 *
 * 仍然渲染真实 RequestDetail，用回调捕获真实决定参数；不 mock 组件行为。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = fileURLToPath(new URL("..", import.meta.url));
const browser = new Window({ url: "http://127.0.0.1:3101/approvals/entitlement-fixture" });
browser.matchMedia = (query) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
});
globalThis.window = browser;
for (const key of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "HTMLInputElement", "HTMLTextAreaElement", "MutationObserver", "ResizeObserver", "ShadowRoot", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: browser[key], writable: true, configurable: true });
}
globalThis.matchMedia = browser.matchMedia;
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("RequestDetail decisions must use the supplied callback, never HTTP in this suite"); };

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": adminRoot.replace(/\\/g, "/").replace(/\/$/, "") + "/src" } },
  // 独立缓存目录：避免与其它 vite 测试共享 node_modules/.vite/deps 时反复重建删除。
  cacheDir: fileURLToPath(new URL("../../../tmp/approval-vite-cache/entitlement/", import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
let RequestDetail;
try {
  ({ RequestDetail } = await vite.ssrLoadModule("/src/views/approval/request-detail.tsx"));
} catch (error) {
  await vite.close(); await browser.happyDOM.abort(); globalThis.fetch = previousFetch; throw error;
}
const { createRoot } = await import("react-dom/client");
after(async () => { await vite.close(); await browser.happyDOM.abort(); globalThis.fetch = previousFetch; });

function payload(userId = "user-fixture") {
  return {
    userId, gameId: "delta-fixture", kind: "FRIEND", policyId: "approved-policy-1",
    scopeKey: "legacy:immutable-scope", replaceEntitlementId: "entitlement-1",
    startsAtUtc: "2026-11-01T02:00:00.000Z", endsAtUtc: "2026-11-20T02:00:00.000Z",
    depositWaived: false, reason: "原办理依据",
    pricing: { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode: "ordinary", priceVersionId: "frozen-price-1", costBasisRef: "frozen-cost-1", payableRatio: "0.9" },
  };
}

function detail(id = "request-a", editable = true) {
  const hash = (id === "request-a" ? "a" : "b").repeat(64);
  const original = payload(id === "request-a" ? "user-a" : "user-b");
  return {
    requestId: id,
    operationCode: "membership.entitlement.replace",
    triggerCondition: "membership.entitlement.replace.requested",
    payloadVersion: 1, payloadHash: hash,
    summary: "为用户办理挚友礼遇", status: "PENDING",
    requester: { username: "requester", displayUsername: "REQUESTER", name: "申请人" },
    createdAt: "2026-10-23T00:00:00.000Z",
    business: { businessTitle: "替换会员礼遇", changeSummary: "为用户办理挚友礼遇", summary: {} },
    operation: { code: "membership.entitlement.replace", triggerCondition: "membership.entitlement.replace.requested", payloadVersion: 1, payloadHash: hash, executionMode: "GENERIC_TRANSACTION" },
    template: { id: "template", version: 1 },
    decision: null, execution: null,
    candidates: [{ username: "reviewer", displayUsername: "REVIEWER", name: "审核人", status: "ACTIVE", eligible: true, source: "TEMPLATE" }],
    history: [],
    supersedesRequestId: null, supersededByRequestId: null,
    actions: [
      { action: "approve", allowed: true, reasonCode: "OK", executionMode: "GENERIC_TRANSACTION" },
      { action: "reject", allowed: true, reasonCode: "OK", executionMode: "GENERIC_TRANSACTION" },
    ],
    ...(editable ? { entitlementAmendment: { expectedPayloadHash: hash, editablePayload: original } } : {}),
  };
}

const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const button = (text, within = browser.document) => [...within.querySelectorAll("button")].find((element) => element.textContent.trim() === text);

async function clickRaw(element) {
  assert.ok(element, "expected an interactive control");
  await act(async () => { element.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

async function type(element, value) {
  assert.ok(element, "expected an editable field");
  await act(async () => {
    const proto = element.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new browser.Event("input", { bubbles: true }));
    element.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  await settle();
}

async function check(host, text) {
  const label = [...host.querySelectorAll("label")].find((element) => element.textContent.trim() === text);
  assert.ok(label, `label ${text}`);
  const control = browser.document.getElementById(label.htmlFor);
  assert.ok(control, `control for ${text}`);
  await clickRaw(control);
}

function decisionArea(host) {
  return host.querySelector('section[aria-label="决定区"]');
}

async function mount(t, data) {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  const decisions = [];
  const props = {
    busy: false, blocked: false, canApprove: true,
    onOpenRequest() {}, onOpenPath() {}, onLocateRecovery() {},
    onWithdraw() { throw new Error("No withdrawal is authorized by this decision test"); },
    onDecide: (decision, reason, totpCode, amendment) => {
      decisions.push({ decision, reason, totpCode, amendment: amendment === undefined ? undefined : structuredClone(amendment) });
    },
  };
  // 用 requestId 作为 key：切换申请时重新挂载，模拟主视图卸载再重建详情的路径。
  const render = async (next) => {
    await act(async () => root.render(createElement(RequestDetail, { key: next.requestId, ...props, detail: next })));
    await settle();
  };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); await settle(); });
  await render(data);
  return { host, decisions, render };
}

test("authorized amendment submits the exact final payload and keeps fixed identity, scope and pricing references", async (t) => {
  const data = detail();
  const original = structuredClone(data.entitlementAmendment.editablePayload);
  const h = await mount(t, data);
  assert.ok(h.host.textContent.includes("调整礼遇后批准"), "编辑入口仍在决定区");
  await check(h.host, "按调整后的内容批准");
  await type(decisionArea(h.host).querySelector('[aria-label="批准应付比例"]'), "0.85");
  await check(h.host, "独立免押");
  await type(decisionArea(h.host).querySelector('[aria-label="批准礼遇原因"]'), "核对后调整权益");
  await type(decisionArea(h.host).querySelector('textarea[placeholder="补充说明（可选）"]'), "已核对申请依据");
  await clickRaw(button("确认批准", decisionArea(h.host)));

  assert.equal(h.decisions.length, 1);
  const written = h.decisions[0];
  assert.equal(written.decision, "APPROVE");
  assert.equal(written.reason, "已核对申请依据");
  assert.equal(written.totpCode, undefined, "非高影响类型不带动态码");
  assert.ok(written.amendment);
  assert.equal(written.amendment.expectedPayloadHash, data.entitlementAmendment.expectedPayloadHash);
  const finalPayload = written.amendment.finalPayload;
  assert.equal(finalPayload.pricing.payableRatio, "0.85");
  assert.equal(finalPayload.depositWaived, true);
  assert.equal(finalPayload.reason, "核对后调整权益");
  assert.equal(finalPayload.userId, "user-a", "身份固定，不随编辑改动");
  assert.equal(finalPayload.scopeKey, "legacy:immutable-scope", "作用范围固定");
  assert.equal(finalPayload.pricing.priceVersionId, "frozen-price-1", "定价引用固定");
  assert.equal(finalPayload.pricing.costBasisRef, "frozen-cost-1", "成本引用固定");
  assert.deepEqual(data.entitlementAmendment.editablePayload, original, "原服务端载荷保持不可变");
  assert.ok(!("password" in finalPayload) && !("totpCode" in finalPayload), "决定不含任何密码凭据");
});

test("rejecting never carries a previously edited amendment", async (t) => {
  const h = await mount(t, detail());
  await check(h.host, "按调整后的内容批准");
  await type(decisionArea(h.host).querySelector('[aria-label="批准应付比例"]'), "0.75");
  await type(decisionArea(h.host).querySelector('textarea[placeholder="补充说明（可选）"]'), "当前依据不足");
  await clickRaw(button("确认驳回", decisionArea(h.host)));
  assert.equal(h.decisions.length, 1);
  assert.equal(h.decisions[0].decision, "REJECT");
  assert.equal(h.decisions[0].reason, "当前依据不足");
  assert.equal(h.decisions[0].amendment, undefined, "驳回不带任何调整载荷");
  assert.equal(h.decisions[0].totpCode, undefined);
});

test("invalid decimal ratios and an illegal deposit allowance disable approval", async (t) => {
  const h = await mount(t, detail());
  await check(h.host, "按调整后的内容批准");
  const area = decisionArea(h.host);
  for (const ratio of ["0", "1.1", "0.123456789"]) {
    await type(area.querySelector('[aria-label="批准应付比例"]'), ratio);
    assert.equal(button("确认批准", area).disabled, true, `比例 ${ratio} 应禁用批准`);
  }
  await type(area.querySelector('[aria-label="批准应付比例"]'), "0.85");
  assert.equal(button("确认批准", area).disabled, false);
  await type(area.querySelector('[aria-label="批准押金减免额度"]'), "12.345");
  assert.equal(button("确认批准", area).disabled, true, "押金减免额度超过 2 位小数应禁用批准");
  assert.deepEqual(h.decisions, []);
});

test("old DTOs and non-eligible actions do not expose an amendment entry", async (t) => {
  const data = detail("request-old", false);
  const h = await mount(t, data);
  assert.ok(!h.host.textContent.includes("调整礼遇后批准"), "旧 DTO 不暴露编辑入口");
  await clickRaw(button("确认批准", decisionArea(h.host)));
  assert.equal(h.decisions.length, 1);
  assert.equal(h.decisions[0].decision, "APPROVE");
  assert.equal(h.decisions[0].amendment, undefined);

  const denied = detail("request-denied");
  denied.actions = denied.actions.map((action) => ({ ...action, allowed: false, reasonCode: "BUSINESS_PERMISSION_REQUIRED" }));
  await h.render(denied);
  assert.equal(button("确认批准", h.host), undefined, "批准不可用时不再渲染批准按钮");
  assert.ok(!h.host.textContent.includes("调整礼遇后批准"));
  assert.ok(decisionArea(h.host).querySelector('[role="status"]'), "只显示不能办理的原因");
});

test("switching requests clears old edits and approval opinions before the next decision", async (t) => {
  const h = await mount(t, detail());
  await check(h.host, "按调整后的内容批准");
  await type(decisionArea(h.host).querySelector('[aria-label="批准应付比例"]'), "0.71");
  await type(decisionArea(h.host).querySelector('textarea[placeholder="补充说明（可选）"]'), "旧申请意见");

  const next = detail("request-b");
  next.entitlementAmendment.editablePayload.pricing.payableRatio = "0.97";
  await h.render(next);

  const area = decisionArea(h.host);
  assert.equal(area.querySelector('textarea[placeholder="补充说明（可选）"]').value, "", "切换后办理意见清空");
  assert.equal(area.querySelector('[aria-label="批准应付比例"]'), null, "切换后编辑重新收起");
  await check(h.host, "按调整后的内容批准");
  assert.equal(decisionArea(h.host).querySelector('[aria-label="批准应付比例"]').value, "0.97", "重新展开后是新申请的载荷");
  await clickRaw(button("确认批准", decisionArea(h.host)));
  assert.equal(h.decisions.length, 1);
  assert.equal(h.decisions[0].amendment.expectedPayloadHash, next.entitlementAmendment.expectedPayloadHash);
  assert.equal(h.decisions[0].amendment.finalPayload.userId, "user-b");
  assert.equal(h.decisions[0].amendment.finalPayload.pricing.payableRatio, "0.97");
});
