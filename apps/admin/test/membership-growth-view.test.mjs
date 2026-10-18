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
  const contract = (mode) => ({ mode, priceVersionId: "price-v1", haff: { status: "CONFIGURED", kind: "HAFF_RATIO", schema: "haff-ratio-v2", priceVersionId: "price-v1", costBasisRef: "cost-v1", baseBySafeBox: { box: "50", "box-2": "60" }, spreadDelta: "8" }, materials: { item: { status: "CONFIGURED", kind: "FIXED_UNIT", itemId: "item", unit: "PIECE", unitQuantity: "1", buyerUnitAmount: "5.00", ownerUnitAmount: "3.00", priceVersionId: "price-v1", costBasisRef: "cost-v1" }, "item-2": { status: "CONFIGURED", kind: "FIXED_UNIT", itemId: "item-2", unit: "DAY", unitQuantity: "1", buyerUnitAmount: "6.00", ownerUnitAmount: "4.00", priceVersionId: "price-v1", costBasisRef: "cost-v1" } } });
  const policy = { version: "b1", status: "DRAFT", effectiveAt: "2026-11-01T00:00:00.000Z", catalog: { safeBoxes: ["box", "box-2"], materials: [{ id: "item", name: "物资一", unit: "PIECE", unitQuantity: "1" }, { id: "item-2", name: "物资二", unit: "DAY", unitQuantity: "1" }], priceVersions: [{ id: "price-v1", label: "当前价格方案" }], enabledModes: ["ordinary", "custom"], haffSchema: "haff-ratio-v2", releaseMode: "SPREAD" }, selectedSafeBoxCode: "box", selectedMaterialId: "item", tiers: ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"].map((tier, index) => ({ tier, threshold: String(index * 5000), tenantDeposit: index < 2 ? "ACCOUNT_BASE" : "WAIVED", ordinary: contract("ordinary"), custom: contract("custom"), fast: { status: "NOT_PRICED", reason: "权威禁用模式" }, maxEntitlement: { byMode: { ordinary: contract("ordinary"), custom: contract("custom") } } })), changes: [{ label: "金卡免押", before: "按账号条件", after: "默认免押", risk: "LOW" }] };
  const state = { status: "ready", policy, preview: { status: "LOCAL_FIXTURE", totalCents: "5", priceBasis: "GROWTH", depositBasis: "FRIEND" }, subject: { subjectId: "user-a", status: "LOADED", userLabel: "用户甲", tier: "GOLD", rollingPoints: "12000", lifetimePoints: "15000", evidence: ["结算版本 s1", "退款更正 1 条"] }, entitlement: { kind: "FRIEND", scopeKey: "game:delta", startsAtUtc: "2026-10-10T02:00:00.000Z", endsAtUtc: "2026-10-20T02:00:00.000Z", pricingMode: "ordinary", priceVersionId: "price-v1", spreadDelta: "8", haffBaseBySafeBox: { box: "50", "box-2": "60" }, materials: { item: { unit: "PIECE", unitQuantity: "1", buyerUnitAmount: "5.00", ownerUnitAmount: "3.00" }, "item-2": { unit: "DAY", unitQuantity: "1", buyerUnitAmount: "6.00", ownerUnitAmount: "4.00" } }, costBasisRef: "cost-v1", depositWaived: false, reason: "客服专项" }, approval: { status: "APPROVED_PENDING_EXECUTION", requestId: "approval_1", message: "已批准，等待阶段B执行接线" } };
  const changed = [];
  const entitlementChanges = [];
  const saves = [];
  const submitted = [];
  const policysubmitted = [];
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state, onEntitlementChange: (value) => entitlementChanges.push(value), onPolicyChange: (value) => changed.push(value), onSavePolicyDraft: () => saves.push("save"), onSubmitPolicy: () => policysubmitted.push("submit-policy"), onSubmitEntitlement: () => submitted.push("submit") })));
  assert.match(host.textContent, /成长权益与人工礼遇/);
  assert.match(host.textContent, /哈夫/);
  assert.match(host.textContent, /¥0.05/);
  assert.match(host.textContent, /礼遇上限/);
  assert.doesNotMatch(host.textContent, /LOCAL_UI \/ FIXTURE/);
  assert.doesNotMatch(host.textContent, /APPROVED_PENDING_EXECUTION/);
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
  const setInput = async (element, value) => { await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(element, value); element.dispatchEvent(new browser.Event("input", { bubbles: true })); element.dispatchEvent(new browser.Event("change", { bubbles: true })); }); };
  const inputByLabel = (label) => { const input = host.querySelector(`input[aria-label='${label}']`); assert.ok(input, `missing input ${label}`); return input; };
  // The full contract is edited per catalog key: one safe box / one material / spread / cost basis at a time.
  await setInput(inputByLabel("STANDARDordinary哈夫比例"), "52");
  assert.ok(changed.length > 0);
  assert.equal(changed.at(-1).tiers[0].ordinary.haff.baseBySafeBox["box"], "52");
  assert.equal(changed.at(-1).tiers[0].ordinary.haff.baseBySafeBox["box-2"], "60");
  await setInput(inputByLabel("STANDARDordinary价差"), "9");
  assert.equal(changed.at(-1).tiers[0].ordinary.haff.spreadDelta, "9");
  await setInput(inputByLabel("STANDARD物资单位数量"), "2");
  assert.equal(changed.at(-1).tiers[0].ordinary.materials.item.unitQuantity, "2");
  await setInput(inputByLabel("STANDARD物资买方单价"), "5.50");
  assert.equal(changed.at(-1).tiers[0].ordinary.materials.item.buyerUnitAmount, "5.50");
  await setInput(inputByLabel("STANDARD成本依据"), "cost-v2");
  assert.equal(changed.at(-1).tiers[0].ordinary.haff.costBasisRef, "cost-v2");
  assert.equal(changed.at(-1).tiers[0].ordinary.materials.item.costBasisRef, "cost-v2");
  await setInput(inputByLabel("政策生效时点"), "2026-11-01T00:00");
  assert.equal(changed.at(-1).effectiveAt, "2026-10-31T16:00:00.000Z");
  // DRAFT with complete enabled modes can request approval without pretending to be APPROVED.
  const submitPolicy = [...host.querySelectorAll("button")].find((button) => button.textContent === "提交审批");
  assert.ok(submitPolicy && !submitPolicy.disabled);
  await act(async () => submitPolicy.click());
  assert.deepEqual(policysubmitted, ["submit-policy"]);
  // Entitlement contract edits stay full: any safe box and any resource of the release can be adjusted.
  await setInput(inputByLabel("礼遇哈夫比例box-2"), "61");
  assert.equal(entitlementChanges.at(-1).haffBaseBySafeBox["box-2"], "61");
  await setInput(inputByLabel("礼遇价差"), "9");
  assert.equal(entitlementChanges.at(-1).spreadDelta, "9");
  await setInput(inputByLabel("礼遇买方单价item-2"), "6.50");
  assert.equal(entitlementChanges.at(-1).materials["item-2"].buyerUnitAmount, "6.50");
  await setInput(inputByLabel("礼遇成本依据"), "cost-v2");
  assert.equal(entitlementChanges.at(-1).costBasisRef, "cost-v2");
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
  await setInput(revokeInput, "客户要求撤销");
  await act(async () => revoke.click());
  assert.equal(revoked, "客户要求撤销");
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state: { status: "loading" } })));
  assert.equal(host.querySelector('[data-state="loading"]')?.getAttribute("role"), "status");
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state: { status: "error", message: "读取失败" } })));
  assert.equal(host.querySelector('[data-state="error"]')?.getAttribute("role"), "alert");
  assert.doesNotMatch(host.textContent, /用户成长依据/);
  // A missing policy must not hide the granted subject read (PC-READ-1 live defect).
  await act(async () => root.render(createElement(MembershipGrowthAdminView, { state: { status: "error", message: "尚未读取到会员政策；功能保持未启用或等待首个草稿", subject: { subjectId: "user-1", status: "UNKNOWN", reason: "来源状态：BACKFILL_PENDING" } } })));
  assert.match(host.textContent, /尚未读取到会员政策/);
  assert.match(host.textContent, /用户成长依据/);
  assert.match(host.textContent, /成长依据未知/);
  assert.match(host.textContent, /来源状态：BACKFILL_PENDING/);
  assert.doesNotMatch(host.textContent, /普通会员|0 分/);
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

test("empty policy bootstrap, draft gating and cap seeding stay honest", async () => {
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { bootstrapGrowthPolicy, validateAdminPolicyDraft, entitlementFromCap, capStatusSummary } = await vite.ssrLoadModule("/src/views/membership-growth-view.tsx");
    const catalog = { safeBoxes: ["safe_box_1x2", "safe_box_3x3"], materials: [{ id: "item-a", name: "物资甲", unit: "PIECE", unitQuantity: "1" }], priceVersions: [{ id: "price-v1", label: "price-v1" }], enabledModes: ["ordinary", "custom"], haffSchema: "haff-ratio-v2", releaseMode: "SPREAD" };
    const policy = bootstrapGrowthPolicy(catalog, { STANDARD: "0", SILVER: "5000", GOLD: "10000", PLATINUM: "20000", DIAMOND: "40000" }, 1);
    assert.equal(policy.version, "1");
    assert.equal(policy.status, "DRAFT");
    assert.equal(policy.selectedSafeBoxCode, "safe_box_1x2");
    assert.equal(policy.selectedMaterialId, "item-a");
    assert.deepEqual(policy.tiers.map((tier) => tier.tenantDeposit), ["ACCOUNT_BASE", "ACCOUNT_BASE", "WAIVED", "WAIVED", "WAIVED"]);
    assert.equal(policy.tiers.every((tier) => tier.ordinary.status === "NOT_PRICED" && tier.maxEntitlement.status === "NOT_PRICED"), true);
    // First draft is savable (no structural errors) but not publishable; the disabled mode never warns.
    const first = validateAdminPolicyDraft(policy, ["ordinary", "custom"]);
    assert.deepEqual(first.errors, []);
    assert.equal(first.publishable, false);
    assert.ok(first.warnings.every((warning) => !warning.includes(".fast")));
    // An enabled but unpriced mode blocks publish, not the draft.
    const enabled = structuredClone(policy);
    enabled.effectiveAt = "2026-11-01T00:00:00.000Z";
    for (const tier of enabled.tiers) { tier.ordinary = { mode: "ordinary", priceVersionId: "price-v1", haff: { status: "CONFIGURED", kind: "HAFF_RATIO", schema: "haff-ratio-v2", priceVersionId: "price-v1", costBasisRef: "cost-v1", baseBySafeBox: { safe_box_1x2: "60", safe_box_3x3: "49" }, spreadDelta: "8" }, materials: { "item-a": { status: "CONFIGURED", kind: "FIXED_UNIT", itemId: "item-a", unit: "PIECE", unitQuantity: "1", buyerUnitAmount: "5.00", ownerUnitAmount: "3.00", priceVersionId: "price-v1", costBasisRef: "cost-v1" } } }; tier.custom = structuredClone(tier.ordinary); tier.custom.mode = "custom"; }
    const ready = validateAdminPolicyDraft(enabled, ["ordinary", "custom"]);
    assert.deepEqual(ready.errors, []);
    assert.equal(ready.publishable, true, JSON.stringify(ready));
    // A policy without an effective time can never be consumed and must not be publishable.
    const noTime = structuredClone(enabled);
    noTime.effectiveAt = null;
    assert.equal(validateAdminPolicyDraft(noTime, ["ordinary", "custom"]).publishable, false);
    // The entitlement editor seeds from the GOLD cap so edits start at the approved boundary.
    enabled.tiers.find((tier) => tier.tier === "GOLD").maxEntitlement = { byMode: { ordinary: structuredClone(enabled.tiers[2].ordinary) } };
    const seeded = entitlementFromCap(enabled, "FRIEND", "ordinary", "2026-10-10T02:00:00.000Z", "2026-10-20T02:00:00.000Z");
    assert.equal(seeded.priceVersionId, "price-v1");
    assert.equal(seeded.spreadDelta, "8");
    assert.equal(seeded.haffBaseBySafeBox["safe_box_3x3"], "49");
    assert.equal(seeded.materials["item-a"].buyerUnitAmount, "5.00");
    assert.equal(seeded.costBasisRef, "cost-v1");
    assert.equal(capStatusSummary(enabled.tiers[2].maxEntitlement, ["ordinary", "custom"]), "礼遇上限 普通 已配置（部分模式）");
    assert.equal(capStatusSummary({ status: "NOT_PRICED", reason: "待核" }, ["ordinary"]), "礼遇上限未配置");
  } finally { await vite.close(); }
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