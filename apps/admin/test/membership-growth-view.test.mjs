import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const rootPath = fileURLToPath(new URL("..", import.meta.url));

test("admin membership view separates draft, local preview and approval execution", async () => {
  const browser = new Window({ url: "http://127.0.0.1:3101/membership-growth" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true });
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { MembershipGrowthAdminView, beijingInputToUtc, entitlementWindowError, utcToBeijingInput } = await vite.ssrLoadModule("/src/views/membership-growth-view.tsx");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const contract = (mode) => ({ mode, priceVersionId: "price-v1", haff: { status: "CONFIGURED", kind: "HAFF_RATIO", schema: "haff-ratio-v1", priceVersionId: "price-v1", costBasisRef: "cost-v1", baseBySafeBox: { box: "50", "box-2": "60" }, spreadDelta: "0" }, materials: { item: { status: "CONFIGURED", kind: "FIXED_UNIT", itemId: "item", unit: "PIECE", unitQuantity: "1", buyerUnitAmount: "5.00", ownerUnitAmount: "3.00", priceVersionId: "price-v1", costBasisRef: "cost-v1" }, "item-2": { status: "CONFIGURED", kind: "FIXED_UNIT", itemId: "item-2", unit: "DAY", unitQuantity: "1", buyerUnitAmount: "6.00", ownerUnitAmount: "4.00", priceVersionId: "price-v1", costBasisRef: "cost-v1" } } });
  const policy = { version: "b1", status: "DRAFT", effectiveAt: null, catalog: { safeBoxes: ["box", "box-2"], materials: [{ id: "item", name: "物资一", unit: "PIECE" }, { id: "item-2", name: "物资二", unit: "DAY" }], priceVersions: [{ id: "price-v1", label: "当前价格方案" }] }, selectedSafeBoxCode: "box", selectedMaterialId: "item", tiers: ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"].map((tier, index) => ({ tier, threshold: String(index * 5000), tenantDeposit: index < 2 ? "ACCOUNT_BASE" : "WAIVED", ordinary: contract("ordinary"), custom: contract("custom"), fast: contract("fast"), maxEntitlement: contract("ordinary") })), changes: [{ label: "金卡免押", before: "按账号条件", after: "默认免押", risk: "LOW" }] };
  const state = { status: "ready", policy, preview: { status: "LOCAL_FIXTURE", totalCents: "5", priceBasis: "GROWTH", depositBasis: "FRIEND" }, subject: { subjectId: "user-a", status: "LOADED", userLabel: "用户甲", tier: "GOLD", rollingPoints: "12000", lifetimePoints: "15000", evidence: ["结算版本 s1", "退款更正 1 条"] }, entitlement: { kind: "FRIEND", scopeKey: "game:delta", startsAtUtc: "2026-10-10T02:00:00.000Z", endsAtUtc: "2026-10-20T02:00:00.000Z", pricingMode: "ordinary", priceVersionId: "price-v1", haffSchema: "haff-ratio-v1", safeBoxCode: "box", haffBaseRatio: "50", materialItemId: "item", materialUnit: "PIECE", materialUnitQuantity: "1", materialBuyerUnitAmount: "5.00", materialOwnerUnitAmount: "3.00", costBasisRef: "cost-v1", depositWaived: false, reason: "客服专项" }, approval: { status: "APPROVED_PENDING_EXECUTION", requestId: "approval_1", message: "已批准，等待阶段B执行接线" } };
  const changed = [];
  const entitlementChanges = [];
  const saves = [];
  const submitted = [];
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state, onEntitlementChange: (value) => entitlementChanges.push(value), onPolicyChange: (value) => changed.push(value), onSavePolicyDraft: () => saves.push("save"), onSubmitEntitlement: () => submitted.push("submit") })));
  assert.match(host.textContent, /成长权益与人工礼遇/);
  assert.match(host.textContent, /哈夫/);
  assert.match(host.textContent, /¥0.05/);
  assert.doesNotMatch(host.textContent, /LOCAL_UI \/ FIXTURE/);
  assert.doesNotMatch(host.textContent, /APPROVED_PENDING_EXECUTION|PIECE|schema/);
  assert.match(host.textContent, /已批准，等待阶段B执行接线/);
  assert.doesNotMatch(host.textContent, /授予成功/);
  assert.ok(host.querySelector("input[type=datetime-local]"));
  assert.equal(utcToBeijingInput("2026-10-10T02:00:00.000Z"), "2026-10-10T10:00");
  assert.equal(beijingInputToUtc("2026-10-10T10:00"), "2026-10-10T02:00:00.000Z");
  assert.equal(entitlementWindowError("2026-10-10T02:00:00.000Z", "2027-01-10T02:00:00.000Z"), "礼遇单次最多90天");
  const reason = host.querySelector("textarea");
  await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(reason, "新的礼遇申请原因"); reason.dispatchEvent(new browser.Event("input", { bubbles: true })); reason.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  assert.equal(entitlementChanges.at(-1).reason, "新的礼遇申请原因");
  assert.equal(host.querySelector("textarea").value, "新的礼遇申请原因");
  const materialTrigger = host.querySelector("button[aria-label='物资']");
  assert.ok(materialTrigger);
  await act(async () => materialTrigger.click());
  const materialOption = [...browser.document.querySelectorAll("[role=option]")].find((option) => option.textContent === "物资二");
  assert.ok(materialOption);
  await act(async () => materialOption.click());
  assert.equal(entitlementChanges.at(-1).materialItemId, "item-2");
  assert.equal(entitlementChanges.at(-1).materialUnit, "DAY");
  const ratio = host.querySelector("input[aria-label='STANDARDordinary哈夫比例']");
  assert.ok(ratio);
  await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(ratio, "52"); ratio.dispatchEvent(new browser.Event("input", { bubbles: true })); ratio.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  assert.ok(changed.length > 0);
  assert.equal(changed.at(-1).tiers[0].ordinary.haff.baseBySafeBox["box-2"], "60");
  assert.equal(changed.at(-1).tiers[0].ordinary.materials["item-2"].buyerUnitAmount, "6.00");
  const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "保存草稿");
  assert.ok(save);
  await act(async () => save.click());
  assert.deepEqual(saves, ["save"]);
  const submit = [...host.querySelectorAll("button")].find((button) => button.textContent === "提交礼遇审批");
  assert.ok(submit && !submit.disabled);
  await act(async () => submit.click());
  assert.deepEqual(submitted, ["submit"]);
  let revoked = null;
  const applied = { ...state, approval: { status: "APPLIED", requestId: "approval_2" } };
  browser.window.confirm = () => true;
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state: applied, onRevokeEntitlement: (reason) => { revoked = reason; } })));
  const revoke = host.querySelector("button.membership-admin-button--danger");
  const revokeInput = host.querySelector(".membership-admin-revoke-row input");
  assert.ok(revoke && revokeInput);
  await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(revokeInput, "客户要求撤销"); revokeInput.dispatchEvent(new browser.Event("input", { bubbles: true })); revokeInput.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  await act(async () => revoke.click());
  assert.equal(revoked, "客户要求撤销");
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state: { status: "loading" } })));
  assert.equal(host.querySelector('[data-state="loading"]')?.getAttribute("role"), "status");
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state: { status: "error", message: "读取失败" } })));
  assert.equal(host.querySelector('[data-state="error"]')?.getAttribute("role"), "alert");
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state: { ...state, subject: { subjectId: "user-b", status: "UNKNOWN", reason: "新对象未取得授权依据" } } })));
  assert.match(host.textContent, /成长依据未知/);
  assert.doesNotMatch(host.textContent, /用户甲/);
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state: { ...state, subject: { ...state.subject, subjectId: "user-b", userLabel: "用户甲" }, entitlement: { ...state.entitlement, scopeKey: "game:other" } } })));
  const inputValues = [...host.querySelectorAll("input")].map((input) => input.value);
  assert.ok(inputValues.includes("game:other"));
  assert.equal(inputValues.includes("game:delta"), false);
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state: { status: "permission", message: "权限已收回" } })));
  assert.match(host.textContent, /没有会员成长管理权限/);
  await act(async () => root.unmount());
  await vite.close();
  await browser.happyDOM.abort();
});

test("policy approval uses immutable saved-draft metadata rather than the full policy body", async () => {
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)), "@brand": fileURLToPath(new URL("../../../assets/brand", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { policyDraftApprovalPayload } = await vite.ssrLoadModule("/src/views/membership-growth-admin-host.tsx");
    const meta = { id: "draft-1", version: "2", status: "DRAFT", payloadHash: "a".repeat(64), ruleReleaseId: "release-1", priceVersionId: "price-1", sourceRef: "fixture", effectiveAtUtc: "2026-10-10T00:00:00.000Z" };
    const payload = policyDraftApprovalPayload(meta);
    assert.deepEqual(payload, { policyDraftId: "draft-1", policyDraftVersion: 2, policyDraftHash: "a".repeat(64), ruleReleaseId: "release-1", priceVersionId: "price-1", sourceRef: "fixture", effectiveAtUtc: "2026-10-10T00:00:00.000Z" });
    assert(Buffer.byteLength(JSON.stringify(payload)) < 8192);
    assert.throws(() => policyDraftApprovalPayload({ ...meta, status: "APPROVED" }));
    assert.throws(() => policyDraftApprovalPayload({ ...meta, payloadHash: "" }));
  } finally { await vite.close(); }
});

test("GAP-007 membership host gate matches nav/API read admission and hides writes from summary readers", async () => {
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { membershipGrowthAccess } = await vite.ssrLoadModule("/src/views/membership-growth-admin-host.tsx");
    const snap = (permissions, isBoss = false) => ({ authenticated: true, permissions, security: { isBoss } });
    assert.deepEqual(membershipGrowthAccess(snap(["membership.growth.read.summary"])), { canRead: true, canDraft: false, canRequest: false });
    assert.deepEqual(membershipGrowthAccess(snap(["membership.policy.publish"])), { canRead: true, canDraft: false, canRequest: true });
    assert.deepEqual(membershipGrowthAccess(snap(["membership.policy.draft"])), { canRead: true, canDraft: true, canRequest: true });
    assert.deepEqual(membershipGrowthAccess(snap([], true)), { canRead: true, canDraft: true, canRequest: true });
    assert.deepEqual(membershipGrowthAccess(snap(["membership.growth.read.detail"])), { canRead: false, canDraft: false, canRequest: false });
  } finally { await vite.close(); }
});
