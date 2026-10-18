import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const rootPath = fileURLToPath(new URL("..", import.meta.url));
const respond = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, headers: { get: () => null } });

function installBrowser() {
  const browser = new Window({ url: "http://127.0.0.1:3101/membership-growth" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true });
  return browser;
}

function discount(mode, payableRatio, costBasisRef = `cost-${mode}`) {
  return { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode, priceVersionId: "price-v1", payableRatio, costBasisRef };
}

function policyPayload() {
  const shares = ["0.95", "0.92", "0.90", "0.88", "0.85"];
  const tiers = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"];
  return {
    schema: "membership-growth-v1", version: "1", status: "DRAFT", effectiveAt: "2026-11-01T00:00:00.000Z", sourceRef: "fixture",
    tiers: Object.fromEntries(tiers.map((tier, index) => [tier, { tier, tenantDeposit: index < 2 ? "ACCOUNT_BASE" : "WAIVED", pricing: { ordinary: discount("ordinary", shares[index]), custom: discount("custom", shares[index]), fast: { status: "NOT_PRICED", reason: "权威禁用模式" } }, entitlementCap: { byMode: { ordinary: discount("ordinary", shares[index]), custom: discount("custom", shares[index]) } } }])),
    entitlementCaps: { FRIEND: "GOLD", PRESTIGE: "DIAMOND" },
  };
}

const catalog = { safeBoxes: [], materials: [], priceVersions: [{ id: "price-v1", label: "price-v1" }], enabledModes: ["ordinary", "custom"], haffSchema: "haff-ratio-v2", releaseMode: "SPREAD", catalogSource: "SEALED" };
const thresholds = { STANDARD: "0", SILVER: "5000", GOLD: "10000", PLATINUM: "20000", DIAMOND: "40000" };
const metaFixture = () => ({ id: "draft-1", version: "1", status: "DRAFT", effectiveAtUtc: "2026-11-01T00:00:00.000Z", ruleReleaseId: "release-1", priceVersionId: "price-v1", sourceRef: "fixture", payloadHash: "a".repeat(64) });

async function loadHost() {
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { MembershipGrowthAdminHost } = await vite.ssrLoadModule("/src/views/membership-growth-admin-host.tsx");
  return { vite, MembershipGrowthAdminHost };
}

const setInput = async (browser, element, value) => { await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(element, value); element.dispatchEvent(new browser.Event("input", { bubbles: true })); element.dispatchEvent(new browser.Event("change", { bubbles: true })); }); };
const buttonByText = (host, text) => [...host.querySelectorAll("button")].find((button) => button.textContent === text);

test("R1-02 host save race: edits during a pending save stay unsaved and only the saved hash can be submitted", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const host = browser.document.createElement("div");
    browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);
    const requests = [];
    let releaseFirstSave = null;
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url);
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ path, method, body });
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond({ policy: policyPayload(), meta: metaFixture(), catalog, thresholds, bootstrap: null });
      if (method === "POST" && path.endsWith("/membership-growth/policy-drafts")) {
        if (!releaseFirstSave) return new Promise((resolve) => { releaseFirstSave = () => resolve(respond({ id: "draft-2", version: "2", payloadHash: "b".repeat(64) })); });
        return respond({ id: "draft-3", version: "3", payloadHash: "c".repeat(64) });
      }
      if (method === "POST" && path.endsWith("/security/approvals/requests")) return respond({ requestId: "approval-1" });
      throw new Error(`unexpected ${method} ${path}`);
    };
    const dirty = [];
    const tab = { query: { userId: "user-a", gameId: "game-1" } };
    const snapshot = { authenticated: true, permissions: [], security: { isBoss: true } };
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab, snapshot, onDirtyChange: (value) => dirty.push(value), refreshNonce: 0 })));
    const ratio = host.querySelector("input[aria-label='SILVERordinary应付比例']");
    assert.ok(ratio, host.textContent.slice(0, 500));
    // Save A (0.90), then edit B (0.91) while the request is still pending.
    await setInput(browser, ratio, "0.90");
    await act(async () => buttonByText(host, "保存草稿").click());
    assert.equal(requests.filter((request) => request.method === "POST" && request.path.endsWith("/policy-drafts")).length, 1);
    assert.equal(requests.at(-1).body.policy.tiers.SILVER.pricing.ordinary.payableRatio, "0.90");
    await setInput(browser, host.querySelector("input[aria-label='SILVERordinary应付比例']"), "0.91");
    await act(async () => { releaseFirstSave(); await Promise.resolve(); });
    // A's late receipt must not mark B saved: the draft is still dirty and submitting must not send A's hash.
    assert.equal(host.querySelector("input[aria-label='SILVERordinary应付比例']").value, "0.91");
    assert.equal(dirty.at(-1), true);
    assert.ok(!buttonByText(host, "保存草稿").disabled, host.textContent.slice(-900));
    await act(async () => buttonByText(host, "提交审批").click());
    assert.equal(requests.some((request) => request.path.endsWith("/security/approvals/requests")), false);
    assert.match(host.textContent, /请先保存当前政策草稿/);
    // Saving B records B's edit; only then can the approval reference B's immutable hash.
    await act(async () => buttonByText(host, "保存草稿").click());
    const saves = requests.filter((request) => request.method === "POST" && request.path.endsWith("/policy-drafts"));
    assert.equal(saves.length, 2);
    assert.equal(saves[1].body.versionNo, 3);
    assert.equal(saves[1].body.expectedVersion, "2");
    assert.equal(saves[1].body.policy.tiers.SILVER.pricing.ordinary.payableRatio, "0.91");
    assert.equal(dirty.at(-1), false);
    await act(async () => buttonByText(host, "提交审批").click());
    const approval = requests.find((request) => request.path.endsWith("/security/approvals/requests"));
    assert.ok(approval);
    assert.equal(approval.body.payload.policyDraftId, "draft-3");
    assert.equal(approval.body.payload.policyDraftVersion, 3);
    assert.equal(approval.body.payload.policyDraftHash, "c".repeat(64));
    await act(async () => root.unmount());
  } finally {
    await vite.close();
    await browser.happyDOM.abort();
  }
});

test("R1-07 host manual entitlement sends its own discount share and cost basis", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const host = browser.document.createElement("div");
    browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url);
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ path, method, body });
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond({ policy: policyPayload(), meta: metaFixture(), catalog, thresholds, bootstrap: null });
      if (method === "GET" && path.includes("/users/")) return respond({ subjectId: "user-a", growth: { knowledge: "KNOWN", effectiveTier: "GOLD", rollingPoints: "12000", lifetimePoints: "15000", sourceState: "COMPLETE" } });
      if (method === "POST" && path.endsWith("/security/approvals/requests")) return respond({ requestId: "approval-1" });
      throw new Error(`unexpected ${method} ${path}`);
    };
    const tab = { query: { userId: "user-a", gameId: "game-1" } };
    const snapshot = { authenticated: true, permissions: [], security: { isBoss: true } };
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab, snapshot, onDirtyChange: () => undefined, refreshNonce: 0 })));
    const scope = host.querySelector("input[aria-label='礼遇业务范围']");
    assert.ok(scope, host.textContent.slice(0, 500));
    await setInput(browser, scope, "game:delta");
    const reason = host.querySelector("textarea");
    await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(reason, "专项礼遇"); reason.dispatchEvent(new browser.Event("input", { bubbles: true })); reason.dispatchEvent(new browser.Event("change", { bubbles: true })); });
    // The GOLD cap share seeds the manual grant; a deeper share would be blocked by the view.
    assert.equal(host.querySelector("input[aria-label='礼遇应付比例']").value, "0.90");
    const submit = buttonByText(host, "提交礼遇审批");
    assert.ok(submit && !submit.disabled, host.textContent.slice(-800));
    await act(async () => submit.click());
    const approval = requests.find((request) => request.path.endsWith("/security/approvals/requests"));
    assert.ok(approval);
    assert.equal(approval.body.operationCode, "membership.entitlement.grant");
    assert.deepEqual(approval.body.payload.pricing, { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode: "ordinary", priceVersionId: "price-v1", payableRatio: "0.90", costBasisRef: "cost-ordinary" });
    assert.equal(approval.body.payload.pricing.haff, undefined);
    assert.equal(approval.body.payload.pricing.materials, undefined);
    assert.equal(approval.body.payload.depositWaived, false);
    await act(async () => root.unmount());
  } finally {
    await vite.close();
    await browser.happyDOM.abort();
  }
});
