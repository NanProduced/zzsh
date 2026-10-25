import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer, loadConfigFromFile } from "vite";

const rootPath = fileURLToPath(new URL("..", import.meta.url));
const respond = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, headers: { get: () => null } });
let actorSerial=0;
const roots=new Set(),originalFetch=globalThis.fetch;
async function closeUI(vite,browser){await act(async()=>{for(const root of roots)root.unmount();roots.clear();});await vite.close();await browser.happyDOM.abort();globalThis.fetch=originalFetch;}
const actorSnapshot=(permissions=[],isBoss=true)=>({authenticated:true,adminUserId:"admin-host-fixture",permissions,security:{status:"ACTIVE",isBoss,passwordChangeRequired:false},session:{id:`host-session-${actorSerial}`,locked:false,pinConfigured:true}});
function workspaceRead(path){const url=new URL(path,"http://127.0.0.1:3101");if(url.pathname.endsWith("/membership-growth/entitlement-options"))return respond({games:[{id:"game-1",name:"测试游戏"}],capability:{canRead:true,canRequest:true}});if(url.pathname.endsWith("/membership-growth/entitlements"))return respond({schema:"membership-entitlements.v1",asOfUtc:"2026-10-23T00:00:00Z",total:0,page:1,pageSize:20,contextKey:"a".repeat(64),items:[]});if(url.pathname.includes("/users/"))return respond({subjectId:"user-a",growth:{knowledge:"UNKNOWN",effectiveTier:null,rollingPoints:null,lifetimePoints:null,sourceState:"BACKFILL_PENDING"}});return undefined;}
async function openPolicyTab(host){const tab=[...host.querySelectorAll("[role=tab]")].find(element=>element.textContent==="会员政策");assert.ok(tab,"membership policy tab is authorized");await act(async()=>tab.click());await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});}
async function flushUntil(predicate,label='condition'){for(let index=0;index<60;index+=1){if(predicate())return;await act(async()=>{await Promise.resolve();await Promise.resolve();});}assert.fail(`timed out flushing ${label}`);}

function installBrowser() {
  actorSerial++;
  const browser = new Window({ url: "http://127.0.0.1:3101/membership-growth" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis,"sessionStorage",{value:browser.sessionStorage,configurable:true,writable:true});
  Object.defineProperty(globalThis,"localStorage",{value:browser.localStorage,configurable:true,writable:true});
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
    entitlementRanges:Object.fromEntries(["FRIEND","PRESTIGE"].map(kind=>[kind,{byMode:Object.fromEntries(["ordinary","custom"].map(mode=>[mode,{status:"CONFIGURED",kind:"TOTAL_DISCOUNT_RANGE",mode,priceVersionId:"price-v1",minPayableRatio:"0.6",maxPayableRatio:"1",costBasisRef:"cost-independent"}]))}])),
  };
}

const UNIFIED_RATIOS = ["0.95", "0.92", "0.90", "0.88", "0.85"];
const UNIFIED_TIERS = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"];
const unifiedFixture = () => ({
  schema: "membership-unified-pricing.v1", scope: "ALL_ENABLED_RENTAL_MODES", knowledge: "KNOWN",
  tiers: Object.fromEntries(UNIFIED_TIERS.map((tier, index) => [tier, { knowledge: "KNOWN", payableRatio: UNIFIED_RATIOS[index], reasonCodes: [] }])),
  entitlementRanges: {
    FRIEND: { knowledge: "KNOWN", minPayableRatio: "0.6", maxPayableRatio: "1", priceVersionId: "price-v1", costBasisRef: "cost-ent", reasonCodes: [] },
    PRESTIGE: { knowledge: "KNOWN", minPayableRatio: "0.5", maxPayableRatio: "1", priceVersionId: "price-v1", costBasisRef: "cost-ent", reasonCodes: [] },
  },
});
const unifiedCapability = { canDraft: true, canChangeEntitlementRanges: true, canRequestEntitlement: true, depositAllowanceSupported: true, unifiedPricingSupported: true, canSimulateProfit: true };
const policyResponse = (overrides = {}) => ({ policy: policyPayload(), meta: metaFixture(), catalog, thresholds, bootstrap: null, unifiedPricing: unifiedFixture(), capability: unifiedCapability, policyChange: { knowledge: "KNOWN", request: null, immutableDiff: [] }, ...overrides });
const serverChange = (overrides = {}) => ({
  knowledge: "KNOWN",
  draftReference: { id: "draft-1", version: "1", payloadHash: "a".repeat(64) },
  request: { id: "server-context-1", operationCode: "membership.benefit.policy.publish", approvalStatus: "PENDING", executionStatus: null, submittedBy: { id: "ops-2", name: "运营乙" }, submittedAtUtc: "2026-10-20T02:30:00.000Z", plannedEffectiveAtUtc: "2026-11-01T00:00:00.000Z", steps: null },
  immutableDiff: [{ label: "金卡 · 统一应付折扣", baseline: "1", requested: "0.9", format: "DISCOUNT" }],
  effectiveState: { status: "NOT_EFFECTIVE" },
  ...overrides,
});
const catalog = { safeBoxes: [], materials: [], priceVersions: [{ id: "price-v1", label: "price-v1" }], enabledModes: ["ordinary", "custom"], haffSchema: "haff-ratio-v2", releaseMode: "SPREAD", catalogSource: "SEALED" };
const thresholds = { STANDARD: "0", SILVER: "5000", GOLD: "10000", PLATINUM: "20000", DIAMOND: "40000" };
const metaFixture = () => ({ id: "draft-1", version: "1", status: "DRAFT", effectiveAtUtc: "2026-11-01T00:00:00.000Z", ruleReleaseId: "release-1", priceVersionId: "price-v1", sourceRef: "fixture", payloadHash: "a".repeat(64) });

async function loadHost() {
  const configFile=process.env.ADMIN_TEST_VITE_CONFIG || fileURLToPath(new URL("../vite.config.ts", import.meta.url));
  const loaded=await loadConfigFromFile({command:'serve',mode:'test'},configFile,rootPath),config=loaded?.config;
  assert.ok(config,'the existing Vite configuration must load');
  // Preserve the supplied graph packages, while native SSR loads real CJS dependencies normally.
  const aliases=Array.isArray(config.resolve?.alias)?config.resolve.alias.filter(entry=>!(entry.find instanceof RegExp&&['react','react-dom','dagre'].some(id=>entry.find.test(id)))):config.resolve?.alias;
  const vite = await createServer({ ...config, configFile:false, root:rootPath,resolve:{...config.resolve,alias:aliases},
    cacheDir:fileURLToPath(new URL(`../../../tmp/admin-integration-test-cache/${process.pid}-host/`,import.meta.url)),server:{...config.server,middlewareMode:true,hmr:false,ws:false,watch:null},optimizeDeps:{noDiscovery:true,include:[]} });
  try { const { MembershipGrowthAdminHost } = await vite.ssrLoadModule("/src/views/membership-growth-admin-host.tsx"); return { vite, MembershipGrowthAdminHost }; }
  catch(error){await vite.close();throw error;}
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
    const root = createRoot(host);roots.add(root);
    const requests = [];
    let releaseFirstSave = null;
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url);
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ path, method, body });
      if(method==="GET"){const shared=workspaceRead(path);if(shared)return shared;}
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(policyResponse());
      if (method === "POST" && path.endsWith("/membership-growth/policy-drafts")) {
        if (!releaseFirstSave) return new Promise((resolve) => { releaseFirstSave = () => resolve(respond({ id: "draft-2", version: "2", payloadHash: "b".repeat(64), publishable: true, warnings: [], unifiedPricing: unifiedFixture() })); });
        return respond({ id: "draft-3", version: "3", payloadHash: "c".repeat(64), publishable: true, warnings: [], unifiedPricing: unifiedFixture() });
      }
      if (method === "POST" && path.endsWith("/security/approvals/requests")) return respond({ requestId: "approval-1" });
      throw new Error(`unexpected ${method} ${path}`);
    };
    const dirty = [];
    const tab = { query: { userId: "user-a", gameId: "game-1" } };
    const snapshot = actorSnapshot();
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab, snapshot, onDirtyChange: (value) => dirty.push(value), refreshNonce: 0 })));
    await openPolicyTab(host);
    const ratio = host.querySelector("input[aria-label='银卡 统一应付折扣']");
    assert.ok(ratio, host.textContent.slice(0, 500));
    // Save A (0.90), then edit B (0.91) while the request is still pending.
    await setInput(browser, ratio, "0.90");
    await act(async () => buttonByText(host, "保存草稿").click());
    assert.equal(requests.filter((request) => request.method === "POST" && request.path.endsWith("/policy-drafts")).length, 1);
    assert.equal(requests.at(-1).body.unifiedPricing.schema, "membership-unified-pricing.v1");
    assert.equal(requests.at(-1).body.unifiedPricing.scope, "ALL_ENABLED_RENTAL_MODES");
    assert.equal(requests.at(-1).body.unifiedPricing.tiers.SILVER.payableRatio, "0.90");
    assert.equal(Object.hasOwn(requests.at(-1).body.unifiedPricing.tiers.SILVER, "mode"), false, "unified tiers have no mode");
    assert.equal(Object.hasOwn(requests.at(-1).body.policy.tiers.SILVER, "pricing"), false, "the frontend never generates pricing[mode]");
    await setInput(browser, host.querySelector("input[aria-label='银卡 统一应付折扣']"), "0.91");
    await act(async () => { releaseFirstSave(); await Promise.resolve(); });
    // A's late receipt must not mark B saved: the draft is still dirty and submitting must not send A's hash.
    assert.equal(host.querySelector("input[aria-label='银卡 统一应付折扣']").value, "0.91");
    assert.equal(dirty.at(-1), true);
    assert.ok(!buttonByText(host, "保存草稿").disabled, host.textContent.slice(-900));
    const unsavedSubmit=buttonByText(host,'提交审批');
    assert.ok(!unsavedSubmit||unsavedSubmit.disabled,'unsaved B cannot submit A\'s saved hash');
    if(unsavedSubmit)await act(async()=>unsavedSubmit.click());
    assert.equal(requests.some((request) => request.path.endsWith("/security/approvals/requests")), false);
    // Saving B records B's edit; only then can the approval reference B's immutable hash.
    await act(async () => buttonByText(host, "保存草稿").click());
    const saves = requests.filter((request) => request.method === "POST" && request.path.endsWith("/policy-drafts"));
    assert.equal(saves.length, 2);
    assert.equal(saves[1].body.versionNo, 3);
    assert.equal(saves[1].body.expectedVersion, "2");
    assert.equal(saves[1].body.unifiedPricing.tiers.SILVER.payableRatio, "0.91");
    assert.equal(dirty.at(-1), false);
    await act(async () => buttonByText(host, "提交审批").click());
    const approval = requests.find((request) => request.path.endsWith("/security/approvals/requests"));
    assert.ok(approval);
    assert.equal(Object.hasOwn(approval.body, "supersedesRequestId"), false);
    assert.equal(approval.body.payload.policyDraftId, "draft-3");
    assert.equal(approval.body.payload.policyDraftVersion, 3);
    assert.equal(approval.body.payload.policyDraftHash, "c".repeat(64));
    const duplicateSubmit=buttonByText(host,'提交审批');
    assert.ok(!duplicateSubmit||duplicateSubmit.disabled,'the same submitted hash cannot create another approval');
    if(duplicateSubmit)await act(async()=>duplicateSubmit.click());
    assert.equal(requests.filter(request=>request.path.endsWith('/security/approvals/requests')).length,1);
    await act(async () => root.unmount());
  } finally {
    await closeUI(vite,browser);
  }
});

test("R1-03 discard restores the last saved Host baseline instead of leaving the discarded draft ref", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const host = browser.document.createElement("div");
    browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);roots.add(root);
    const requests = [];
    const one = { ...unifiedFixture(), tiers: Object.fromEntries(UNIFIED_TIERS.map((tier) => [tier, { knowledge: "KNOWN", payableRatio: "1", reasonCodes: [] }])) };
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(policyResponse({ unifiedPricing: one, approvedUnifiedPricing: one, approvedPolicy: policyPayload(), approvedMeta: { ...metaFixture(), id: "approved-1", version: "0", status: "APPROVED" } }));
      if (method === "POST" && path.endsWith("/membership-growth/policy-drafts")) return respond({ id: "draft-2", version: "2", payloadHash: "b".repeat(64), publishable: true, warnings: [], unifiedPricing: one });
      throw new Error(`unexpected ${method} ${path}`);
    };
    const dirty = [];
    const snapshot = actorSnapshot();
    const { savePendingWrite, inspectPending, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
    const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", "approval.request.create");
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: (value) => dirty.push(value), refreshNonce: 0 })));
    await openPolicyTab(host);
    const dialog = () => [...browser.document.querySelectorAll("[role=dialog]")].find((element) => element.textContent.includes("调整会员政策"));
    await act(async () => buttonByText(host, "调整会员政策").click());
    const diamond = dialog().querySelector("input[aria-label='钻石 统一应付折扣']");
    assert.ok(diamond);
    await setInput(browser, diamond, "0.8");
    await act(async () => buttonByText(dialog(), "取消修改").click());
    await act(async () => buttonByText(browser.document, "放弃修改并关闭").click());
    await act(async () => buttonByText(host, "调整会员政策").click());
    const reopened = dialog().querySelector("input[aria-label='钻石 统一应付折扣']");
    assert.equal(reopened.value, "1", "the discarded 0.8 must not remain in the reopened view");
    const save = buttonByText(dialog(), "保存草稿");
    assert.equal(save.disabled, true, "a restored saved draft is not dirty and cannot be re-saved as a phantom edit");
    assert.equal(dirty.at(-1), false, "discard clears the global dirty flag");
    await act(async () => save.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.equal(requests.some((request) => request.method === "POST" && request.path.endsWith("/policy-drafts")), false, "discard never posts the stale draft");
    // A new edit after discard must save from the restored server meta/ref, not from the discarded draft.
    await setInput(browser, reopened, "0.9");
    await act(async () => buttonByText(dialog(), "保存草稿").click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const savedPost = requests.find((request) => request.method === "POST" && request.path.endsWith("/policy-drafts"));
    assert.ok(savedPost);
    assert.equal(savedPost.body.unifiedPricing.tiers.DIAMOND.payableRatio, "0.9");
    assert.equal(savedPost.body.expectedVersion, "1", "the discarded draft never advanced the Host CAS baseline");
    assert.equal(savedPost.body.ruleReleaseId, "release-1");
    assert.equal(savedPost.body.priceVersionId, "price-v1");
    await setInput(browser, dialog().querySelector("input[aria-label='钻石 统一应付折扣']"), "0.8");
    const pendingSaved = savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: "", operation: "approval.request.create", path: "/security/approvals/requests", idempotencyKey: `idem_${"a".repeat(32)}`, body: {}, readback: { kind: "lists", keys: [] }, successMessage: "fixture", kind: "unknown" });
    assert.equal(pendingSaved.ok, true, "the pre-existing unknown write is stored while the policy editor is open");
    await act(async () => browser.dispatchEvent(new browser.Event("zzsh:membership-approval-pending")));
    await act(async () => buttonByText(dialog(), "取消修改").click());
    await act(async () => buttonByText(browser.document, "放弃修改并关闭").click());
    const pendingAfter = inspectPending(subject);
    assert.equal(pendingAfter.state, "valid", "discard never clears an already-sent write's original key or UNKNOWN responsibility");
    assert.equal(pendingAfter.record.idempotencyKey, `idem_${"a".repeat(32)}`);
    await act(async () => root.unmount());
  } finally {
    await closeUI(vite, browser);
  }
});

test("policy pending after remount auto-recovers the accepted id without posting a second request", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(policyResponse());
      if (method === "GET" && path.includes("/security/approvals/recovery")) return respond({ knowledge: "KNOWN", key: new URL(path, "http://test").searchParams.get("key"), operation: "approval.request.create", targetRequestId: null, originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: "policy-approval", status: "PENDING" } });
      if (method === "GET" && path.includes("/security/approvals/requests/detail")) return respond({ requestId: "policy-approval", status: "PENDING", operation: { code: "membership.benefit.policy.publish" } });
      throw new Error(`unexpected ${method} ${path}`);
    };
    const snapshot = actorSnapshot();
    const opened = [];
    const { savePendingWrite, inspectPending, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
    const saved = savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: "", operation: "approval.request.create", path: "/security/approvals/requests", idempotencyKey: `idem_${"e".repeat(32)}`, body: { operationCode: "membership.benefit.policy.publish", payload: { policyDraftId: "draft-1", policyDraftVersion: 1, policyDraftHash: "a".repeat(64) } }, readback: { kind: "lists", keys: ["mine"] }, successMessage: "fixture", kind: "readback" });
    assert.equal(saved.ok, true);
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path, title) => opened.push({ path, title }) })));
    await openPolicyTab(host);
    for (let index = 0; index < 20 && !host.textContent.includes("已提交审批"); index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.match(host.textContent, /已提交审批/);
    assert.doesNotMatch(host.textContent, /关联申请暂未读到/);
    assert.equal(inspectPending(pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", "approval.request.create")).state, "absent", "verified recovery clears the original responsibility");
    assert.equal(requests.some((request) => request.method === "POST" && request.path.endsWith("/security/approvals/requests")), false, "recovery is read-only and never re-sends the approval");
    assert.ok(requests.some((request) => request.method === "GET" && request.path.includes("/security/approvals/requests/detail")));
    await act(async () => buttonByText(host, "到审批中心处理").click());
    assert.equal(opened.at(-1).path, "/approvals/policy-approval?from=membership-growth&fromTab=policy");
    assert.equal(opened.at(-1).title, "审批详情");
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("recovery that finishes before policy load still binds once the current draft is known", async () => {
  const browser = installBrowser(), { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
    const requests = [];
    let releasePolicy;
    const policyPending = new Promise(resolve => { releasePolicy = () => resolve(respond(policyResponse())); });
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      requests.push({ path, method });
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return policyPending;
      if (method === "GET" && path.includes("/security/approvals/recovery")) return respond({ knowledge: "KNOWN", key: new URL(path, "http://test").searchParams.get("key"), operation: "approval.request.create", targetRequestId: null, originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: "policy-approval", status: "PENDING" } });
      if (method === "GET" && path.includes("/security/approvals/requests/detail")) return respond({ requestId: "policy-approval", status: "PENDING", operation: { code: "membership.benefit.policy.publish" } });
      throw new Error(`unexpected ${method} ${path}`);
    };
    const snapshot = actorSnapshot();
    const { savePendingWrite, inspectPending, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
    const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", "approval.request.create");
    const saved = savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: "", operation: "approval.request.create", path: "/security/approvals/requests", idempotencyKey: `idem_${"f".repeat(32)}`, body: { operationCode: "membership.benefit.policy.publish", payload: { policyDraftId: "draft-1", policyDraftVersion: 1, policyDraftHash: "a".repeat(64) } }, readback: { kind: "lists", keys: ["mine"] }, successMessage: "fixture", kind: "readback" });
    assert.equal(saved.ok, true);
    const opened = [];
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path, title) => opened.push({ path, title }) })));
    await openPolicyTab(host);
    await flushUntil(() => inspectPending(subject).state === "absent", "recovery clears pending before policy ready");
    releasePolicy();
    await flushUntil(() => host.textContent.includes("已提交审批"), "recovered request binds after policy ready");
    assert.equal(inspectPending(subject).state, "absent");
    assert.match(host.textContent, /已提交审批/);
    assert.doesNotMatch(host.textContent, /关联申请暂未读到/);
    assert.equal(requests.some((request) => request.method === "POST" && request.path.endsWith("/security/approvals/requests")), false);
    await act(async () => buttonByText(host, "到审批中心处理").click());
    assert.equal(opened.at(-1).path, "/approvals/policy-approval?from=membership-growth&fromTab=policy");
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 1, onOpenPath: (path, title) => opened.push({ path, title }) })));
    await flushUntil(() => host.textContent.includes("已提交审批"), "same-draft refresh keeps the binding");
    assert.match(host.textContent, /已提交审批/);
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("a verified request for another draft never binds the current draft", async () => {
  const browser = installBrowser(), { vite, MembershipGrowthAdminHost } = await loadHost();
  const { savePendingWrite, inspectPending, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
  const cases = [
    { name: "different id", reference: { policyDraftId: "draft-old", policyDraftVersion: 1, policyDraftHash: "a".repeat(64) } },
    { name: "different version", reference: { policyDraftId: "draft-1", policyDraftVersion: 2, policyDraftHash: "a".repeat(64) } },
    { name: "different hash", reference: { policyDraftId: "draft-1", policyDraftVersion: 1, policyDraftHash: "b".repeat(64) } },
  ];
  try {
    for (const testCase of cases) {
      const host = browser.document.createElement("div"); browser.document.body.append(host);
      const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
      const requests = [];
      globalThis.fetch = async (url, init = {}) => {
        const path = String(url), method = (init.method ?? "GET").toUpperCase();
        requests.push({ path, method });
        if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
        if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(policyResponse());
        if (method === "GET" && path.includes("/security/approvals/recovery")) return respond({ knowledge: "KNOWN", key: new URL(path, "http://test").searchParams.get("key"), operation: "approval.request.create", targetRequestId: null, originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: "old-draft-approval", status: "PENDING" } });
        if (method === "GET" && path.includes("/security/approvals/requests/detail")) return respond({ requestId: "old-draft-approval", status: "PENDING", operation: { code: "membership.benefit.policy.publish" } });
        throw new Error(`unexpected ${method} ${path}`);
      };
      const snapshot = actorSnapshot(), subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", "approval.request.create");
      const saved = savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: "", operation: "approval.request.create", path: "/security/approvals/requests", idempotencyKey: `idem_${testCase.name.length.toString(16).padStart(2, "0").repeat(16)}`, body: { operationCode: "membership.benefit.policy.publish", payload: testCase.reference }, readback: { kind: "lists", keys: ["mine"] }, successMessage: "fixture", kind: "readback" });
      assert.equal(saved.ok, true, testCase.name);
      const opened = [];
      await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path, title) => opened.push({ path, title }) })));
      await openPolicyTab(host);
      await flushUntil(() => inspectPending(subject).state === "absent", testCase.name);
      await flushUntil(() => host.textContent.includes("原申请需核对"), testCase.name);
      assert.match(host.textContent, /原申请需核对/, testCase.name);
      assert.match(host.textContent, /确认对应的政策草稿/, testCase.name);
      assert.match(host.textContent, /核对|确认对应的政策草稿/, testCase.name);
      assert.doesNotMatch(host.textContent, /已提交审批/, testCase.name);
      const link = buttonByText(host, "查看原申请"); assert.ok(link, testCase.name);
      await act(async () => link.click());
      assert.equal(opened.at(-1).path, "/approvals/old-draft-approval?from=membership-growth&fromTab=policy", testCase.name);
      assert.equal(requests.some((request) => request.method === "POST"), false, testCase.name);
      await act(async () => root.unmount()); roots.delete(root); host.remove();
    }
  } finally { await closeUI(vite, browser); }
});

test("wrong detail id or operation keeps the original key/body and does not bind the current draft", async () => {
  const browser = installBrowser(), { vite, MembershipGrowthAdminHost } = await loadHost();
  const { savePendingWrite, inspectPending, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
  const cases = [
    { name: "wrong id", detail: { requestId: "other-approval", status: "PENDING", operation: { code: "membership.benefit.policy.publish" } } },
    { name: "wrong code", detail: { requestId: "policy-approval", status: "PENDING", operation: { code: "membership.entitlement.grant" } } },
  ];
  const originalBody = { operationCode: "membership.benefit.policy.publish", payload: { policyDraftId: "draft-1", policyDraftVersion: 1, policyDraftHash: "a".repeat(64) } };
  try {
    for (const testCase of cases) {
      const host = browser.document.createElement("div"); browser.document.body.append(host);
      const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
      const requests = [];
      globalThis.fetch = async (url, init = {}) => {
        const path = String(url), method = (init.method ?? "GET").toUpperCase();
        requests.push({ path, method });
        if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
        if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(policyResponse());
        if (method === "GET" && path.includes("/security/approvals/recovery")) return respond({ knowledge: "KNOWN", key: new URL(path, "http://test").searchParams.get("key"), operation: "approval.request.create", targetRequestId: null, originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: "policy-approval", status: "PENDING" } });
        if (method === "GET" && path.includes("/security/approvals/requests/detail")) return respond(testCase.detail);
        throw new Error(`unexpected ${method} ${path}`);
      };
      const snapshot = actorSnapshot();
      snapshot.adminUserId = `${snapshot.adminUserId}-${testCase.name.replaceAll(" ", "-")}`;
      snapshot.session.id = `${snapshot.session.id}-${testCase.name.replaceAll(" ", "-")}`;
      const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", "approval.request.create");
      const key = `idem_${(testCase.name === "wrong id" ? "1" : "2").repeat(32)}`;
      const saved = savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: "", operation: "approval.request.create", path: "/security/approvals/requests", idempotencyKey: key, body: originalBody, readback: { kind: "lists", keys: ["mine"] }, successMessage: "fixture", kind: "readback" });
      assert.equal(saved.ok, true, testCase.name);
      await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0 })));
      await openPolicyTab(host);
      await flushUntil(() => buttonByText(host, "查询原结果") && !buttonByText(host, "查询原结果").disabled, testCase.name);
      const pending = inspectPending(subject);
      assert.equal(pending.state, "valid", testCase.name);
      assert.equal(pending.record.idempotencyKey, key, testCase.name);
      assert.deepEqual(pending.record.body, originalBody, testCase.name);
      assert.doesNotMatch(host.textContent, /已提交审批/, testCase.name);
      assert.equal(requests.some((request) => request.method === "POST"), false, testCase.name);
      await act(async () => root.unmount()); roots.delete(root); host.remove();
    }
  } finally { await closeUI(vite, browser); }
});

test("R2 an accepted id without a verified same-draft detail never marks the current draft requested", async () => {
  const browser = installBrowser(), { vite, MembershipGrowthAdminHost } = await loadHost();
  const { inspectPending, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
  const cases = [
    { mode: "verified", detail: (id) => respond({ requestId: id, status: "PENDING", operation: { code: "membership.benefit.policy.publish" } }) },
    { mode: "404", failure: () => respond({ error: { code: "DETAIL_UNAVAILABLE" } }, 404) },
    { mode: "403", failure: () => respond({ error: { code: "FORBIDDEN" } }, 403) },
    { mode: "wrong-code", failure: (id) => respond({ requestId: id, status: "PENDING", operation: { code: "membership.entitlement.grant" } }) },
  ];
  try {
    for (const testCase of cases) {
      const host = browser.document.createElement("div"); browser.document.body.append(host);
      const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
      const id = `r2-delayed-${testCase.mode}`;
      const snapshot = actorSnapshot();
      snapshot.adminUserId = `${snapshot.adminUserId}-${testCase.mode}`;
      snapshot.session.id = `${snapshot.session.id}-${testCase.mode}`;
      const requests = [];
      let releaseDetail = null, postedKey = null, postedBody = null;
      globalThis.fetch = async (url, init = {}) => {
        const path = String(url), method = (init.method ?? "GET").toUpperCase();
        requests.push({ path, method });
        if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
        if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(policyResponse());
        if (method === "POST" && path.endsWith("/security/approvals/requests")) {
          postedKey = init.headers?.["idempotency-key"] ?? init.headers?.get?.("idempotency-key");
          postedBody = init.body === undefined ? undefined : JSON.parse(String(init.body));
          return respond({ requestId: id });
        }
        if (method === "GET" && path.includes("/security/approvals/requests/detail")) {
          if (testCase.detail) return testCase.detail(id);
          return new Promise((resolve) => { releaseDetail = () => resolve(testCase.failure(id)); });
        }
        throw new Error(`unexpected ${method} ${path}`);
      };
      const opened = [];
      await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path) => opened.push(path) })));
      await openPolicyTab(host);
      const submit = buttonByText(host, "提交审批"); assert.ok(submit && !submit.disabled, testCase.mode);
      await act(async () => submit.click());
      await flushUntil(() => postedBody !== null, `${testCase.mode} approval POST`);
      if (testCase.detail) {
        await flushUntil(() => host.textContent.includes("已提交审批"), `${testCase.mode} verified same-draft detail`);
        assert.match(host.textContent, /已提交审批/, testCase.mode);
        assert.doesNotMatch(host.textContent, /原申请对应另一份草稿|原申请需核对/, testCase.mode);
        assert.equal(inspectPending(pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", "approval.request.create")).state, "absent", testCase.mode);
        await act(async () => buttonByText(host, "到审批中心处理").click());
        assert.equal(opened.at(-1), `/approvals/${id}?from=membership-growth&fromTab=policy`, testCase.mode);
      } else {
        await flushUntil(() => releaseDetail !== null && Boolean(buttonByText(host, "查看原申请")), `${testCase.mode} accepted id rendered before detail`);
        assert.match(host.textContent, /待核对|正在确认提交结果/, `${testCase.mode}: an accepted id alone is not a verified current-draft approval`);
        assert.doesNotMatch(host.textContent, /已提交审批/, testCase.mode);
        await act(async () => releaseDetail());
        await flushUntil(() => Boolean(buttonByText(host, "查看原申请")) && buttonByText(host, "查询原结果") && !buttonByText(host, "查询原结果").disabled, `${testCase.mode} detail failure settled`);
        const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", "approval.request.create");
        const record = inspectPending(subject);
        assert.equal(record.state, "valid", testCase.mode);
        assert.equal(record.record.idempotencyKey, postedKey, testCase.mode);
        assert.deepEqual(record.record.body, postedBody, testCase.mode);
        assert.match(host.textContent, /待核对|正在确认提交结果/, testCase.mode);
        assert.match(host.textContent, /核对|确认对应的政策草稿/, testCase.mode);
        assert.doesNotMatch(host.textContent, /已提交审批/, testCase.mode);
        const link = buttonByText(host, "查看原申请"); assert.ok(link, testCase.mode);
        await act(async () => link.click());
        assert.equal(opened.at(-1), `/approvals/${id}?from=membership-growth&fromTab=policy`, testCase.mode);
      }
      assert.equal(requests.filter((request) => request.method === "POST" && request.path.endsWith("/security/approvals/requests")).length, 1, testCase.mode);
      await act(async () => root.unmount()); roots.delete(root); host.remove();
    }
  } finally { await closeUI(vite, browser); }
});

test("a recovery finishing after a policy refresh cannot bind the new current draft", async () => {
  const browser = installBrowser(), { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
    let releaseRecovery; let recoveryPending = new Promise(resolve => { releaseRecovery = () => resolve(respond({ knowledge: "KNOWN", key: "idem_99999999999999999999999999999999", operation: "approval.request.create", targetRequestId: null, originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: "old-refresh-approval", status: "PENDING" } })); });
    let policyCalls = 0;
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) {
        policyCalls += 1;
        return respond(policyResponse(policyCalls === 1 ? {} : { meta: { ...metaFixture(), id: "draft-2", version: "2", payloadHash: "c".repeat(64) } }));
      }
      if (method === "GET" && path.includes("/security/approvals/recovery")) return recoveryPending;
      if (method === "GET" && path.includes("/security/approvals/requests/detail")) return respond({ requestId: "old-refresh-approval", status: "PENDING", operation: { code: "membership.benefit.policy.publish" } });
      throw new Error(`unexpected ${method} ${path}`);
    };
    const snapshot = actorSnapshot();
    const { savePendingWrite, inspectPending, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
    const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", "approval.request.create");
    const saved = savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: "", operation: "approval.request.create", path: "/security/approvals/requests", idempotencyKey: "idem_99999999999999999999999999999999", body: { operationCode: "membership.benefit.policy.publish", payload: { policyDraftId: "draft-1", policyDraftVersion: 1, policyDraftHash: "a".repeat(64) } }, readback: { kind: "lists", keys: ["mine"] }, successMessage: "fixture", kind: "readback" });
    assert.equal(saved.ok, true);
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0 })));
    await openPolicyTab(host);
    await flushUntil(() => policyCalls === 1, "first policy load");
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 1 })));
    await flushUntil(() => policyCalls === 2, "policy refresh");
    releaseRecovery();
    await flushUntil(() => host.textContent.includes("原申请需核对"), "late recovery mismatch");
    assert.match(host.textContent, /核对|确认对应的政策草稿/);
    assert.doesNotMatch(host.textContent, /已提交审批/);
    assert.equal(inspectPending(subject).state, "absent");
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("a saved new draft does not inherit an old-draft request after remount", async () => {
  const browser = installBrowser(), { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    let host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); let root = createRoot(host); roots.add(root);
    const requests = [];
    let reloadPolicy = policyResponse();
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      requests.push({ path, method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(reloadPolicy);
      if (method === "POST" && path.endsWith("/membership-growth/policy-drafts")) return respond({ id: "draft-2", version: "2", payloadHash: "b".repeat(64), publishable: true, warnings: [], unifiedPricing: unifiedFixture() });
      if (method === "GET" && path.includes("/security/approvals/recovery")) return respond({ knowledge: "KNOWN", key: new URL(path, "http://test").searchParams.get("key"), operation: "approval.request.create", targetRequestId: null, originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: "old-save-approval", status: "PENDING" } });
      if (method === "GET" && path.includes("/security/approvals/requests/detail")) return respond({ requestId: "old-save-approval", status: "PENDING", operation: { code: "membership.benefit.policy.publish" } });
      throw new Error(`unexpected ${method} ${path}`);
    };
    const snapshot = actorSnapshot();
    const { savePendingWrite, inspectPending, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0 })));
    await openPolicyTab(host);
    const silver = host.querySelector("input[aria-label='银卡 统一应付折扣']"); assert.ok(silver);
    await setInput(browser, silver, "0.91");
    await act(async () => buttonByText(host, "保存草稿").click());
    await flushUntil(() => requests.some(request => request.method === "POST" && request.path.endsWith("/membership-growth/policy-drafts")), "new draft save");
    await act(async () => root.unmount()); roots.delete(root); host.remove();
    reloadPolicy = policyResponse({ meta: { ...metaFixture(), id: "draft-2", version: "2", payloadHash: "b".repeat(64) } });
    const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", "approval.request.create");
    const saved = savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: "", operation: "approval.request.create", path: "/security/approvals/requests", idempotencyKey: "idem_"+ "7".repeat(32), body: { operationCode: "membership.benefit.policy.publish", payload: { policyDraftId: "draft-1", policyDraftVersion: 1, policyDraftHash: "a".repeat(64) } }, readback: { kind: "lists", keys: ["mine"] }, successMessage: "fixture", kind: "readback" });
    assert.equal(saved.ok, true);
    host = browser.document.createElement("div"); browser.document.body.append(host); root = createRoot(host); roots.add(root);
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0 })));
    await openPolicyTab(host);
    await flushUntil(() => host.textContent.includes("原申请需核对"), "old request after saved draft");
    assert.match(host.textContent, /核对|确认对应的政策草稿/);
    assert.doesNotMatch(host.textContent, /已提交审批/);
    assert.equal(inspectPending(subject).state, "absent");
    assert.equal(requests.some(request => request.method === "POST" && request.path.endsWith("/security/approvals/requests")), false);
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("R1-07 host entitlement replacement uses the approved context and its own discount references", async () => {
  const browser=installBrowser(),{vite,MembershipGrowthAdminHost}=await loadHost();let releasePost;
  try{
    const host=browser.document.createElement('div');browser.document.body.append(host);const {createRoot}=await import('react-dom/client'),root=createRoot(host);roots.add(root);
    const requests=[],original={id:'existing-entitlement',userId:'user-a',userSummary:{name:'合成用户甲',image:null,maskedPhone:null},gameId:'game-1',gameName:'测试游戏',kind:'FRIEND',scopeKey:'legacy:scope',startsAtUtc:'2026-11-01T00:00:00.000Z',endsAtUtc:'2026-11-20T00:00:00.000Z',status:'EXECUTED_PENDING_START',depositWaived:false,approvedPolicyId:'approved-effective-1',approvalRequestId:'original-approval',pricingSummary:{knowledge:'KNOWN',kind:'TOTAL_DISCOUNT',mode:'ordinary',payableRatio:'0.85'}};
    const context={schema:'membership-entitlement-context.v1',subject:{userId:'user-a',name:'合成用户甲',image:null,maskedPhone:null},game:{id:'game-1',name:'测试游戏'},approvedMeta:{id:'approved-effective-1',version:'7',effectiveAtUtc:'2026-10-01T00:00:00.000Z',ruleReleaseId:'release-1',priceVersionId:'price-v1',payloadHash:'d'.repeat(64),sourceRef:'fixture'},ranges:policyPayload().entitlementRanges,unifiedRanges:{FRIEND:{knowledge:'KNOWN',minPayableRatio:'0.6',maxPayableRatio:'1',priceVersionId:'price-v1',costBasisRef:'cost-independent',reasonCodes:[]},PRESTIGE:{knowledge:'KNOWN',minPayableRatio:'0.5',maxPayableRatio:'1',priceVersionId:'price-v1',costBasisRef:'cost-independent',reasonCodes:[]}},pricingScope:'ALL_ENABLED_RENTAL_MODES',rangeSource:'INDEPENDENT',capability:{canRequest:true,reasonCode:'OK',unifiedPricingSupported:true,requiresUnifiedPricing:true},existingEntitlements:[original]};
    globalThis.fetch=async(url,init={})=>{
      const path=String(url),method=(init.method??'GET').toUpperCase(),body=init.body===undefined?undefined:JSON.parse(String(init.body));requests.push({path,method,body});
      if(method==='GET'&&path.includes('/membership-growth/entitlements?'))return respond({schema:'membership-entitlements.v1',asOfUtc:'2026-10-23T00:00:00Z',total:1,page:1,pageSize:20,contextKey:'b'.repeat(64),items:[original]});
      if(method==='GET'&&path.includes('/membership-growth/entitlement-context?'))return respond(context);
      if(method==='GET'){const shared=workspaceRead(path);if(shared)return shared;}
      if(method==='GET'&&path.endsWith('/membership-growth/policy'))return respond(policyResponse());
      if(method==='POST'&&path.endsWith('/security/approvals/requests'))return new Promise(resolve=>{releasePost=()=>resolve(respond({requestId:'approval-fixture'}));});
      throw new Error(`unexpected ${method} ${path}`);
    };
    await act(async()=>root.render(createElement(MembershipGrowthAdminHost,{tab:{query:{userId:'user-a',gameId:'game-1'}},snapshot:actorSnapshot(),onDirtyChange(){},refreshNonce:0})));
    assert.equal(host.querySelector('[role=tab][aria-selected=true]').textContent,'礼遇管理');
    await act(async()=>buttonByText(host,'替换/续期').click());
    const ratio=browser.document.querySelector('input[aria-label="礼遇应付比例"]');assert.ok(ratio);
    assert.equal(ratio.value,'','an old-mode entitlement is never re-seeded as the new unified ratio');
    await setInput(browser,ratio,'0.80');
    const reason=browser.document.querySelector('textarea[aria-label="礼遇原因"]');
    await act(async()=>{Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set.call(reason,'专项礼遇续期');reason.dispatchEvent(new browser.Event('input',{bubbles:true}));reason.dispatchEvent(new browser.Event('change',{bubbles:true}));});
    const submit=buttonByText(browser.document,'提交礼遇审批');assert.ok(submit&&!submit.disabled);
    await act(async()=>submit.click());
    const approval=requests.find(request=>request.method==='POST'&&request.path.endsWith('/security/approvals/requests'));assert.ok(approval);
    assert.equal(approval.body.operationCode,'membership.entitlement.replace');assert.equal(approval.body.payload.policyId,'approved-effective-1','the editable draft meta is never used for a grant');
    assert.equal(approval.body.payload.replaceEntitlementId,original.id);assert.equal(approval.body.payload.scopeKey,original.scopeKey);
    assert.deepEqual(approval.body.payload.pricing,{status:'CONFIGURED',kind:'TOTAL_DISCOUNT',scope:'ALL_ENABLED_RENTAL_MODES',priceVersionId:'price-v1',payableRatio:'0.80',costBasisRef:'cost-independent'});assert.equal(Object.hasOwn(approval.body.payload.pricing,'mode'),false);
    assert.equal(approval.body.payload.pricing.haff,undefined);assert.equal(approval.body.payload.pricing.materials,undefined);assert.equal(approval.body.payload.depositWaived,false);
    assert.equal(Object.hasOwn(approval.body,'supersedesRequestId'),false);
    // This assertion stops at the POST boundary; the hook's ACK/readback scenarios are tested elsewhere.
    await act(async()=>root.unmount());await act(async()=>{releasePost();await Promise.resolve();});
  }finally{await closeUI(vite,browser);}
});
test("R2-06 a save receipt from a previous refresh generation never pollutes the current CAS binding", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const host = browser.document.createElement("div");
    browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);roots.add(root);
    const requests = [];
    let releaseFirstSave = null;
    let policyGets = 0;
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url);
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ path, method, body });
      if(method==="GET"){const shared=workspaceRead(path);if(shared)return shared;}
      if (method === "GET" && path.endsWith("/membership-growth/policy")) {
        policyGets += 1;
        if (policyGets === 1) return respond(policyResponse());
        return respond(policyResponse({ policy: { ...policyPayload(), version: "5" }, meta: { id: "draft-5", version: "5", status: "DRAFT", effectiveAtUtc: "2026-11-01T00:00:00.000Z", ruleReleaseId: "release-5", priceVersionId: "price-v5", sourceRef: "fixture", payloadHash: "e".repeat(64) }, unifiedPricing: unifiedFixture() }));
      }
      if (method === "GET" && path.includes("/users/")) return respond({ subjectId: "user-a" });
      if (method === "POST" && path.endsWith("/membership-growth/policy-drafts")) {
        if (!releaseFirstSave) return new Promise((resolve) => { releaseFirstSave = () => resolve(respond({ id: "draft-2", version: "2", payloadHash: "b".repeat(64), publishable: true, warnings: [], unifiedPricing: unifiedFixture() })); });
        return respond({ id: "draft-6", version: "6", payloadHash: "f".repeat(64), publishable: true, warnings: [], unifiedPricing: unifiedFixture() });
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const tab = { query: { userId: "user-a", gameId: "game-1" } };
    const snapshot = actorSnapshot();
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab, snapshot, onDirtyChange: () => undefined, refreshNonce: 0 })));
    await openPolicyTab(host);
    const ratio = () => host.querySelector("input[aria-label='银卡 统一应付折扣']");
    assert.ok(ratio(), host.textContent.slice(0, 400));
    // Save A on v1/price-v1, then refresh to v5/price-v5 while A is still pending.
    await setInput(browser, ratio(), "0.90");
    await act(async () => buttonByText(host, "保存草稿").click());
    assert.equal(requests.filter((request) => request.method === "POST" && request.path.endsWith("/policy-drafts")).length, 1);
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab, snapshot, onDirtyChange: () => undefined, refreshNonce: 1 })));
    assert.equal(policyGets, 2);
    assert.equal(ratio().value, "0.92");
    await act(async () => { releaseFirstSave(); await Promise.resolve(); });
    // The stale v2 receipt must not advance or rebind the current v5 context: the next save uses v5 and price-v5.
    await setInput(browser, ratio(), "0.93");
    await act(async () => buttonByText(host, "保存草稿").click());
    const saves = requests.filter((request) => request.method === "POST" && request.path.endsWith("/policy-drafts"));
    assert.equal(saves.length, 2);
    assert.equal(saves[1].body.expectedVersion, "5");
    assert.equal(saves[1].body.ruleReleaseId, "release-5");
    assert.equal(saves[1].body.priceVersionId, "price-v5");
    assert.equal(saves[1].body.versionNo, 6);
    assert.equal(saves[1].body.unifiedPricing.tiers.SILVER.payableRatio, "0.93");
    await act(async () => root.unmount());
  } finally {
    await closeUI(vite,browser);
  }
});

test("R2 cleanup rejects a late save receipt after leaving the membership tab", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  let mounted = false;
  let root;
  try {
    const host = browser.document.createElement("div");
    browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);roots.add(root);
    let releaseSave;
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url);
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(policyResponse());
      if (method === "GET" && path.includes("/users/")) return respond({ subjectId: "user-a" });
      if (method === "POST" && path.endsWith("/membership-growth/policy-drafts")) return new Promise((resolve) => { releaseSave = () => resolve(respond({ id: "draft-2", version: "2", payloadHash: "b".repeat(64), publishable: true, warnings: [], unifiedPricing: unifiedFixture() })); });
      throw new Error(`unexpected ${method} ${path}`);
    };
    let activeTab = "membership";
    const dirtyByTab = { membership: false, other: true };
    const dirtySignals = [];
    // AppShell's callback applies to activeIdRef.current, so an old host must stop calling it after cleanup.
    const onDirtyChange = (dirty) => { dirtyByTab[activeTab] = dirty; dirtySignals.push({ tab: activeTab, dirty }); };
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: actorSnapshot(), onDirtyChange, refreshNonce: 0 })));
    mounted = true;
    await setInput(browser, host.querySelector("input[aria-label='银卡 统一应付折扣']"), "0.91");
    await act(async () => buttonByText(host, "保存草稿").click());
    assert.ok(releaseSave);
    await act(async () => root.unmount());
    mounted = false;
    activeTab = "other";
    await act(async () => { releaseSave(); await Promise.resolve(); });
    assert.equal(dirtyByTab.other, true);
    assert.equal(dirtySignals.some((signal) => signal.tab === "other" && signal.dirty === false), false);
  } finally {
    if (mounted) await act(async () => root.unmount());
    await closeUI(vite,browser);
  }
});

test('summary-only policy readers retain read-only UI and revocation removes the policy tab',async()=>{
  const browser=installBrowser(),{vite,MembershipGrowthAdminHost}=await loadHost();
  try{
    const host=browser.document.createElement('div');browser.document.body.append(host);const {createRoot}=await import('react-dom/client'),root=createRoot(host);roots.add(root);
    const requests=[];let allowed=true;
    globalThis.fetch=async(url,init={})=>{
      const path=String(url),method=(init.method??'GET').toUpperCase();requests.push({path,method});
      if(method!=='GET')throw new Error('summary reader must never send a command');
      if(path.endsWith('/membership-growth/entitlement-options'))return allowed?respond({games:[{id:'game-1',name:'测试游戏'}],capability:{canRead:true,canRequest:false}}):respond({error:{code:'FORBIDDEN',message:'fixture revoked'}},403);
      const shared=workspaceRead(path);if(shared)return shared;
      if(path.endsWith('/membership-growth/policy'))return respond({policy:policyPayload(),meta:metaFixture(),catalog,thresholds,bootstrap:null});
      throw new Error(`unexpected ${path}`);
    };
    const props={tab:{query:{gameId:'game-1'}},snapshot:actorSnapshot(['membership.growth.read.summary'],false),onDirtyChange(){},refreshNonce:0};
    await act(async()=>root.render(createElement(MembershipGrowthAdminHost,props)));await openPolicyTab(host);
    assert.equal(host.querySelector("input[aria-label='银卡 统一应付折扣']").disabled,true);
    assert.equal(buttonByText(host,'保存草稿'),undefined);assert.equal(buttonByText(host,'提交审批'),undefined);assert.equal(buttonByText(host,'办理礼遇'),undefined);
    allowed=false;await act(async()=>root.render(createElement(MembershipGrowthAdminHost,{...props,snapshot:actorSnapshot([],false)})));
    assert.equal([...host.querySelectorAll('[role=tab]')].some(element=>element.textContent==='会员政策'),false);
    assert.equal(requests.some(request=>request.method!=='GET'),false);
  }finally{await closeUI(vite,browser);}
});

test("policy change reads the same server-linked request on a fresh mount without posting", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const requests = [], opened = [];
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      requests.push({ path, method });
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(policyResponse({ policyChange: serverChange() }));
      throw new Error(`unexpected ${method} ${path}`);
    };
    const mount = async (snapshot) => {
      const host = browser.document.createElement("div"); browser.document.body.append(host);
      const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
      await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path, title) => opened.push({ path, title }) })));
      await openPolicyTab(host);
      return { host, root };
    };
    const first = await mount(actorSnapshot());
    await flushUntil(() => first.host.textContent.includes("待处理变更 · 待审批"), "server request on first mount");
    assert.match(first.host.textContent, /申请已提交，等待审批/);
    assert.match(first.host.textContent, /运营乙/);
    await act(async () => buttonByText(first.host, "查看变更详情").click());
    const dialog = browser.document.querySelector("[data-slot=dialog-content]"); assert.ok(dialog);
    assert.match(dialog.textContent, /原价/); assert.match(dialog.textContent, /9折/);
    const detail = [...dialog.querySelectorAll("button")].find((button) => button.textContent.trim() === "打开审批详情"); assert.ok(detail);
    await act(async () => detail.click());
    assert.deepEqual(opened.at(-1), { path: "/approvals/server-context-1?from=membership-growth&fromTab=policy", title: "审批详情" });
    await act(async () => first.root.unmount()); roots.delete(first.root); first.host.remove();
    const next = actorSnapshot(); next.adminUserId = "another-admin"; next.session = { ...next.session, id: "another-session" };
    const second = await mount(next);
    await flushUntil(() => second.host.textContent.includes("待处理变更 · 待审批"), "server request on a fresh session");
    assert.match(second.host.textContent, /申请已提交，等待审批/);
    assert.equal(requests.filter((request) => request.method === "POST" && request.path.endsWith("/security/approvals/requests")).length, 0);
    await act(async () => second.root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("policy change refresh reads the server projection and never creates an approval", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    let policyGets = 0;
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      requests.push({ path, method });
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) {
        policyGets += 1;
        return respond(policyResponse(policyGets === 1 ? { policyChange: undefined } : { policyChange: serverChange() }));
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: actorSnapshot(), onDirtyChange: () => {}, refreshNonce: 0 })));
    await openPolicyTab(host);
    await flushUntil(() => host.textContent.includes("待处理变更 · 申请状态待确认"), "undeployed projection");
    assert.match(host.textContent, /申请状态暂未确认/);assert.doesNotMatch(host.textContent, /字段未部署/);
    const submit = buttonByText(host, "提交审批"); assert.ok(submit); assert.equal(submit.disabled, true);
    await act(async () => buttonByText(host, "刷新状态").click());
    await flushUntil(() => host.textContent.includes("待处理变更 · 待审批"), "change refresh");
    assert.equal(policyGets, 2);
    assert.match(host.textContent, /申请已提交，等待审批/);
    assert.equal(requests.filter((request) => request.method === "POST" && request.path.endsWith("/security/approvals/requests")).length, 0);
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("policy change for another draft is not attached to the current draft", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const requests = [], opened = [];
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      requests.push({ path, method });
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(policyResponse({ policyChange: serverChange({ draftReference: { id: "draft-old", version: "4", payloadHash: "b".repeat(64) } }) }));
      throw new Error(`unexpected ${method} ${path}`);
    };
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: actorSnapshot(), onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path, title) => opened.push({ path, title }) })));
    await openPolicyTab(host);
    await flushUntil(() => host.textContent.includes("待处理变更 · 原申请属于另一份草稿"), "old draft isolation");
    assert.match(host.textContent, /原申请对应另一份草稿|原申请需核对/);
    assert.equal(buttonByText(host, "提交审批").disabled, true);
    await act(async () => buttonByText(host, "查看原申请").click());
    assert.deepEqual(opened.at(-1), { path: "/approvals/server-context-1?from=membership-growth&fromTab=policy", title: "审批详情" });
    assert.equal(requests.filter((request) => request.method === "POST" && request.path.endsWith("/security/approvals/requests")).length, 0);
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("a late policy-change read from a previous identity cannot overwrite the new identity", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    let policyGets = 0, releaseFirst;
    const firstRead = new Promise((resolve) => { releaseFirst = () => resolve(respond(policyResponse({ policyChange: serverChange({ request: { ...serverChange().request, id: "actor-a-approval", submittedBy: { id: "a", name: "运营甲" } } }) }))); });
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) {
        policyGets += 1;
        if (policyGets === 1) return firstRead;
        return respond(policyResponse({ policyChange: serverChange({ request: { ...serverChange().request, id: "actor-b-approval", submittedBy: { id: "b", name: "运营乙" } } }) }));
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
    const first = actorSnapshot();
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: first, onDirtyChange: () => {}, refreshNonce: 0 })));
    await openPolicyTab(host);
    await flushUntil(() => policyGets === 1, "first identity read");
    const next = actorSnapshot(); next.adminUserId = "another-admin"; next.session = { ...next.session, id: "another-session" };
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: next, onDirtyChange: () => {}, refreshNonce: 0 })));
    await openPolicyTab(host);
    await flushUntil(() => host.textContent.includes("待处理变更 · 待审批") && host.textContent.includes("运营乙"), "second identity read");
    releaseFirst();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.match(host.textContent, /运营乙/);
    assert.doesNotMatch(host.textContent, /运营甲/);
    assert.equal(policyGets, 2);
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("policy read failures stay inline and never call window.alert", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    let alerted = false;
    browser.alert = () => { alerted = true; };
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond({ error: { code: "FORBIDDEN" } }, 403);
      throw new Error(`unexpected ${method} ${path}`);
    };
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: actorSnapshot(), onDirtyChange: () => {}, refreshNonce: 0 })));
    await openPolicyTab(host);
    await flushUntil(() => host.textContent.includes("没有会员成长读取权限"), "inline policy error");
    assert.ok(host.querySelector("[role=alert]"));
    assert.equal(alerted, false);
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("R1 a server-only original request survives FORBIDDEN with an ID-only readback", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    let policyGets = 0, failNext = false;
    const requests = [], opened = [];
    const initial = policyResponse({ policyChange: serverChange({
      request: { ...serverChange().request, id: "server-read-only-request", approvalStatus: "APPROVED", executionStatus: "FAILED", submittedBy: { id: "ops-c", name: "运营丙" }, submittedAtUtc: "2026-10-25T01:00:00.000Z" },
      immutableDiff: [{ label: "金卡 · 押金权益", baseline: "0", requested: "20000", format: "CENTS" }],
      effectiveState: { status: "NOT_EFFECTIVE" },
    }) });
    const forbidden = policyResponse({ policyChange: { knowledge: "FORBIDDEN", request: null, draftReference: null, immutableDiff: null, effectiveState: null } });
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      requests.push({ path, method });
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) {
        policyGets += 1;
        if (policyGets === 1) return respond(initial);
        if (failNext) { failNext = false; throw new Error("synthetic refresh failure"); }
        return respond(forbidden);
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: actorSnapshot(), onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path, title) => opened.push({ path, title }) })));
    await openPolicyTab(host);
    await flushUntil(() => host.textContent.includes("待处理变更 · 执行状态待核对"), "server-only execution failure");
    assert.match(host.textContent, /运营丙/);
    await act(async () => buttonByText(host, "查看变更详情").click());
    const originalDialog = browser.document.querySelector("[data-slot=dialog-content]");
    assert.match(originalDialog.textContent, /金卡 · 押金权益/);
    await act(async () => buttonByText(originalDialog, "关闭").click());
    failNext = true;
    await act(async () => buttonByText(host, "刷新状态").click());
    await flushUntil(() => host.textContent.includes("刷新失败，请稍后重试"), "refresh transport failure");
    assert.equal(host.querySelectorAll("[data-testid=membership-policy-feedback]").length, 1);
    assert.ok(buttonByText(host, "查看原申请"));
    await act(async () => buttonByText(host, "刷新状态").click());
    await flushUntil(() => host.textContent.includes("暂时无法查看申请"), "forbidden ID-only fallback");
    assert.doesNotMatch(host.textContent, /运营丙|金卡 · 押金权益|待审批/);
    assert.equal(buttonByText(host, "提交审批").disabled, true);
    await act(async () => buttonByText(host, "查看原申请").click());
    assert.deepEqual(opened.at(-1), { path: "/approvals/server-read-only-request?from=membership-growth&fromTab=policy", title: "审批详情" });
    assert.equal(requests.filter((request) => request.method === "POST").length, 0);
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("R1 an incomplete refreshed request cannot release the unknown submit gate", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    let policyGets = 0;
    const requests = [], opened = [];
    const initial = policyResponse({ policyChange: undefined });
    const refreshed = policyResponse({ policyChange: serverChange({
      draftReference: null,
      request: { ...serverChange().request, id: "rejected-without-reference", approvalStatus: "REJECTED", executionStatus: null },
    }) });
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = (init.method ?? "GET").toUpperCase();
      requests.push({ path, method });
      if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
      if (method === "GET" && path.endsWith("/membership-growth/policy")) {
        policyGets += 1;
        return respond(policyGets === 1 ? initial : refreshed);
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const host = browser.document.createElement("div"); browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: actorSnapshot(), onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path, title) => opened.push({ path, title }) })));
    await openPolicyTab(host);
    await flushUntil(() => host.textContent.includes("待处理变更 · 申请状态待确认"), "undeployed projection");
    assert.equal(buttonByText(host, "提交审批").disabled, true);
    await act(async () => buttonByText(host, "刷新状态").click());
    await flushUntil(() => host.textContent.includes("申请状态暂未更新"), "incomplete refreshed request");
    assert.doesNotMatch(host.textContent, /草稿待提交|另一份草稿|已退回/);
    assert.equal(buttonByText(host, "提交审批").disabled, true);
    const original = buttonByText(host, "查看原申请"); assert.ok(original);
    await act(async () => original.click());
    assert.deepEqual(opened.at(-1), { path: "/approvals/rejected-without-reference?from=membership-growth&fromTab=policy", title: "审批详情" });
    assert.equal(requests.filter((request) => request.method === "POST").length, 0);
    await act(async () => root.unmount());
  } finally { await closeUI(vite, browser); }
});

test("R1 a verified published policy without a current draft keeps its published state", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const opened = [];
    const noDraftResponse = (status) => policyResponse({
      meta: { ...metaFixture(), id: "approved-1", version: "1", status: "APPROVED" },
      policy: { ...policyPayload(), status: "APPROVED", version: "1" },
      policyChange: serverChange({
        draftReference: { id: "published-original-draft", version: "3", payloadHash: "a".repeat(64) },
        request: { id: "published-original-request", operationCode: "membership.benefit.policy.publish", approvalStatus: "APPROVED", executionStatus: "SUCCEEDED", submittedBy: { id: "ops-c", name: "运营丙" }, submittedAtUtc: "2026-10-25T01:00:00.000Z", plannedEffectiveAtUtc: status === "EFFECTIVE" ? "2026-10-20T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" },
        immutableDiff: [{ label: "钻石 · 押金权益", baseline: "0", requested: "20000", format: "CENTS" }],
        effectiveState: { status, executed: true },
      }),
    });
    for (const [status, label] of [["PENDING_EFFECTIVE", "已发布待生效"], ["EFFECTIVE", "已生效"]]) {
      const host = browser.document.createElement("div"); browser.document.body.append(host);
      const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
      const response = noDraftResponse(status);
      globalThis.fetch = async (url, init = {}) => {
        const path = String(url), method = (init.method ?? "GET").toUpperCase();
        if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
        if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond(response);
        throw new Error(`unexpected ${method} ${path}`);
      };
      await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: actorSnapshot(), onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path, title) => opened.push({ path, title }) })));
      await openPolicyTab(host);
      await flushUntil(() => host.textContent.includes(`${status === "EFFECTIVE" ? "最近变更" : "待处理变更"} · ${label}`), `${status} without a draft`);
      assert.doesNotMatch(host.textContent, /另一份草稿|暂无待处理变更/);
      assert.equal(buttonByText(host, "提交审批"), undefined);
      if (status === "EFFECTIVE") assert.match(host.textContent, /生效时间/);
      const original = buttonByText(host, "查看原申请"); assert.ok(original);
      await act(async () => original.click());
      assert.deepEqual(opened.at(-1), { path: "/approvals/published-original-request?from=membership-growth&fromTab=policy", title: "审批详情" });
      await act(async () => root.unmount()); roots.delete(root); host.remove();
    }
  } finally { await closeUI(vite, browser); }
});


async function openRootPolicyReloadFixture(t, sequence) {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  const requests = [], opened = []; let policyGets = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url), method = (init.method ?? "GET").toUpperCase();
    requests.push({ path, method });
    if (method === "GET") { const shared = workspaceRead(path); if (shared) return shared; }
    if (method === "GET" && path.endsWith("/membership-growth/policy")) {
      const policyChange = sequence[Math.min(policyGets++, sequence.length - 1)];
      return respond(policyResponse({ policyChange }));
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const { createRoot } = await import("react-dom/client"); const root = createRoot(host); roots.add(root);
  let props = { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: actorSnapshot(), onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: (path, title) => opened.push({ path, title }) };
  const render = async (patch = {}) => { props = { ...props, ...patch }; await act(async () => root.render(createElement(MembershipGrowthAdminHost, props))); await openPolicyTab(host); };
  t.after(async () => { await closeUI(vite, browser); host.remove(); });
  await render();
  return { browser, host, root, render, snapshot: () => props.snapshot, requests, opened, policyGets: () => policyGets };
}

for (const mode of ["refreshNonce", "snapshot"]) test(`Root F1 same identity workspace ${mode} retains a server-only original request after forbidden read`, async t => {
  const h = await openRootPolicyReloadFixture(t, [serverChange(), { knowledge: "FORBIDDEN", request: null }]);
  await flushUntil(() => h.host.textContent.includes("待处理变更 · 待审批"), "first server-linked request");
  assert.match(h.host.textContent, /运营乙/);
  const snapshot = h.snapshot();
  await h.render(mode === "refreshNonce" ? { refreshNonce: 1 } : { snapshot: { ...snapshot, session: { ...snapshot.session }, security: { ...snapshot.security }, permissions: [...snapshot.permissions] } });
  await flushUntil(() => h.host.textContent.includes("无权读取变更状态"), "same identity forbidden reload");
  assert.doesNotMatch(h.host.textContent, /运营乙/);
  assert.doesNotMatch(h.host.textContent, /调整1项权益/);
  const original = buttonByText(h.host, "查看原申请"); assert.ok(original, "server-only original request stays reachable");
  await act(async () => original.click());
  assert.deepEqual(h.opened.at(-1), { path: "/approvals/server-context-1?from=membership-growth&fromTab=policy", title: "审批详情" });
  assert.equal(h.policyGets(), 2); assert(h.requests.every(request => request.method === "GET"));
});

test("Root F1 a locally refreshed server ID survives the next workspace reload", async t => {
  const h = await openRootPolicyReloadFixture(t, [{ knowledge: "UNKNOWN", request: null }, serverChange(), { knowledge: "FORBIDDEN", request: null }]);
  await flushUntil(() => h.host.textContent.includes("待处理变更 · 申请状态待确认"), "initial unknown");
  await act(async () => buttonByText(h.host, "刷新状态").click());
  await flushUntil(() => h.host.textContent.includes("待处理变更 · 待审批"), "local refresh discovers original");
  await h.render({ refreshNonce: 1 });
  await flushUntil(() => h.host.textContent.includes("无权读取变更状态"), "workspace reload forbidden");
  const original = buttonByText(h.host, "查看原申请"); assert.ok(original);
  await act(async () => original.click());
  assert.equal(h.opened.at(-1).path, "/approvals/server-context-1?from=membership-growth&fromTab=policy");
  assert.equal(h.policyGets(), 3); assert(h.requests.every(request => request.method === "GET"));
});

test("Root F1 changing the administrator or session clears the original server ID", async t => {
  const h = await openRootPolicyReloadFixture(t, [serverChange(), { knowledge: "FORBIDDEN", request: null }]);
  await flushUntil(() => h.host.textContent.includes("待处理变更 · 待审批"), "old identity request");
  const snapshot = h.snapshot();
  await h.render({ snapshot: { ...snapshot, adminUserId: "other-root-f1-admin", session: { ...snapshot.session, id: "other-root-f1-session" } } });
  await flushUntil(() => h.host.textContent.includes("无权读取变更状态"), "new identity forbidden");
  assert.equal(buttonByText(h.host, "查看原申请"), undefined);
  assert.doesNotMatch(h.host.textContent, /server-context-1|运营乙|调整1项权益/);
  assert.equal(h.policyGets(), 2); assert(h.requests.every(request => request.method === "GET"));
});


test("Root F1 explicit known no-request clears the remembered read-only ID", async t => {
  const h = await openRootPolicyReloadFixture(t, [serverChange(), { knowledge: "KNOWN", request: null }, { knowledge: "FORBIDDEN", request: null }]);
  await flushUntil(() => h.host.textContent.includes("待处理变更 · 待审批"), "known original before clear");
  await h.render({ refreshNonce: 1 });
  await flushUntil(() => h.host.textContent.includes("待处理变更 · 草稿待提交"), "explicit no request");
  assert.equal(buttonByText(h.host, "查看原申请"), undefined);
  await h.render({ refreshNonce: 2 });
  await flushUntil(() => h.host.textContent.includes("无权读取变更状态"), "no cached ID after clear");
  assert.equal(buttonByText(h.host, "查看原申请"), undefined);
  assert.doesNotMatch(h.host.textContent, /server-context-1|运营乙/);
  assert.equal(h.policyGets(), 3); assert(h.requests.every(request => request.method === "GET"));
});

test('closeout requested values parser keeps exact safe strings and drops unbound or malformed values', async () => {
  const { vite } = await loadHost();
  try {
    const { normalizePolicyChange } = await vite.ssrLoadModule('/src/views/membership-growth-admin-host.tsx');
    const requestedValues = [{ label: '普通 · 应付比例', value: '0.95000000', format: 'DISCOUNT' }, { label: '普通 · 每单押金减免额度', value: '0', format: 'CENTS' }];
    const good = serverChange({ requestedValues, immutableDiff: null });
    assert.deepEqual(normalizePolicyChange(good).change.requestedValues, requestedValues);
    for (const patch of [
      { knowledge: 'FORBIDDEN' }, { knowledge: 'UNKNOWN' }, { request: null }, { draftReference: null },
      { request: { ...good.request, operationCode: 'membership.entitlement.grant' } },
      { requestedValues: [{ label: '比例', value: 0.95, format: 'DISCOUNT' }] },
      { requestedValues: [{ label: '比例', value: '0.95', format: 'HTML' }] },
      { requestedValues: Array.from({ length: 20 }, () => requestedValues[0]) },
    ]) assert.equal(normalizePolicyChange({ ...good, ...patch }).change.requestedValues, null);
    assert.equal(normalizePolicyChange(good).change.immutableDiff, null, 'requested values never invent an immutable baseline');
  } finally { await vite.close(); }
});

for (const terminal of ['EXPIRED', 'CANCELLED', 'EFFECTIVE']) test(`closeout Host ${terminal} history cannot relock a new draft after known no-request refresh`, async t => {
  const browser = installBrowser(), { vite, MembershipGrowthAdminHost } = await loadHost();
  t.after(async () => { await closeUI(vite, browser); });
  const snapshot = actorSnapshot(), requests = [], opened = [];
  const { savePendingWrite, inspectPending, pendingWriteSubject } = await vite.ssrLoadModule('/src/views/approval/pending-writes.ts');
  const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, '', 'approval.request.create');
  const originalBody = { operationCode: 'membership.benefit.policy.publish', payload: { policyDraftId: 'draft-1', policyDraftVersion: 1, policyDraftHash: 'a'.repeat(64) } };
  assert.equal(savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: '', operation: 'approval.request.create', path: '/security/approvals/requests', idempotencyKey: 'idem_' + 'd'.repeat(32), body: originalBody, readback: { kind: 'lists', keys: ['mine'] }, successMessage: 'fixture', kind: 'readback' }).ok, true);
  const request = { ...serverChange().request, id: 'closed-history', approvalStatus: terminal === 'EFFECTIVE' ? 'APPROVED' : terminal, executionStatus: terminal === 'EFFECTIVE' ? 'SUCCEEDED' : null };
  const original = policyResponse({ policyChange: serverChange({ request, immutableDiff: null, effectiveState: { status: terminal === 'EFFECTIVE' ? 'EFFECTIVE' : 'NOT_EFFECTIVE', executed: terminal === 'EFFECTIVE' } }) });
  if (terminal === 'EFFECTIVE') { original.policy = { ...original.policy, status: 'APPROVED' }; original.meta = { ...original.meta, status: 'APPROVED' }; original.approvedPolicy = original.policy; original.approvedUnifiedPricing = unifiedFixture(); original.approvedMeta = original.meta; }
  let current = original;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url), method = (init.method ?? 'GET').toUpperCase(), body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (method === 'GET') { const shared = workspaceRead(path); if (shared) return shared; }
    if (method === 'GET' && path.endsWith('/membership-growth/policy')) return respond(current);
    if (method === 'GET' && path.includes('/security/approvals/recovery')) return respond({ knowledge: 'KNOWN', key: 'idem_' + 'd'.repeat(32), operation: 'approval.request.create', targetRequestId: null, originalResponseStatus: 200, outcome: 'ACCEPTED', receipt: { approvalRequestId: 'closed-history', status: 'PENDING' } });
    if (method === 'GET' && path.includes('/security/approvals/requests/detail')) { const id = new URL(path, 'http://test').searchParams.get('requestId'); return respond({ requestId: id, status: id === 'closed-history' ? terminal === 'EFFECTIVE' ? 'EXECUTED' : terminal : 'PENDING', operation: { code: 'membership.benefit.policy.publish' } }); }
    if (method === 'POST' && path.endsWith('/membership-growth/policy-drafts')) return respond({ id: 'draft-2', version: '2', payloadHash: 'b'.repeat(64), publishable: true, warnings: [], unifiedPricing: unifiedFixture() });
    if (method === 'POST' && path.endsWith('/security/approvals/requests')) return respond({ requestId: 'new-draft-request' });
    throw new Error(`unexpected ${method} ${path}`);
  };
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const { createRoot } = await import('react-dom/client'), root = createRoot(host); roots.add(root);
  const props = { tab: { query: { userId: 'user-a', gameId: 'game-1' } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0, onOpenPath: path => opened.push(path) };
  const until = async (predicate, label) => { try { await flushUntil(predicate, label); } catch (error) { error.message += '\n' + JSON.stringify({ feedback: host.querySelector('[data-testid=membership-policy-feedback]')?.textContent, buttons: [...host.querySelectorAll('button')].map(button => ({ text: button.textContent, disabled: button.disabled })), pending: inspectPending(subject).state }); throw error; } };
  await act(async () => root.render(createElement(MembershipGrowthAdminHost, props))); await openPolicyTab(host);
  await until(() => inspectPending(subject).state === 'absent' && !buttonByText(host, '调整会员政策').disabled, 'closed original allows a new edit');
  assert.equal(host.querySelectorAll('[data-testid=membership-policy-feedback]').length, 1);
  if (terminal === 'EFFECTIVE') { assert.match(host.textContent, /最近变更 · 已生效/); assert.doesNotMatch(host.textContent, /待处理变更 · 已生效/); }
  await setInput(browser, host.querySelector('input[aria-label="银卡 统一应付折扣"]'), '0.91');
  await act(async () => buttonByText(host, '保存草稿').click());
  await until(() => requests.some(item => item.method === 'POST' && item.path.endsWith('/policy-drafts')), 'new draft saved');
  current = policyResponse({ meta: { ...metaFixture(), id: 'draft-2', version: '2', payloadHash: 'b'.repeat(64) }, policyChange: { knowledge: 'KNOWN', request: null, requestedValues: null, immutableDiff: null } });
  await act(async () => root.render(createElement(MembershipGrowthAdminHost, { ...props, refreshNonce: 1 }))); await openPolicyTab(host);
  await until(() => { const button = buttonByText(host, '提交审批'); return button && !button.disabled; }, 'no-request proof releases the new draft');
  assert.doesNotMatch(host.querySelector('[data-testid=membership-policy-feedback]').textContent, /UNKNOWN|待核对|状态待确认|另一份草稿/);
  assert.equal(inspectPending(subject).state, 'absent');
  const audit = buttonByText(host, '查看上次申请'); assert.ok(audit); await act(async () => audit.click());
  assert.equal(opened.at(-1), '/approvals/closed-history?from=membership-growth&fromTab=policy');
  await act(async () => buttonByText(host, '提交审批').click());
  const post = requests.find(item => item.method === 'POST' && item.path.endsWith('/security/approvals/requests')); assert.ok(post);
  assert.deepEqual(post.body.payload, { policyDraftId: 'draft-2', policyDraftVersion: 2, policyDraftHash: 'b'.repeat(64), ruleReleaseId: 'release-1', priceVersionId: 'price-v1', sourceRef: 'fixture', effectiveAtUtc: '2026-11-01T00:00:00.000Z' });
  assert.equal(Object.hasOwn(post.body, 'supersedesRequestId'), false);
});

test('closeout Host unresolved original key blocks edit and save without dropping its body', async t => {
  const browser = installBrowser(), { vite, MembershipGrowthAdminHost } = await loadHost();
  t.after(async () => { await closeUI(vite, browser); });
  const snapshot = actorSnapshot(), requests = [];
  const { savePendingWrite, inspectPending, pendingWriteSubject } = await vite.ssrLoadModule('/src/views/approval/pending-writes.ts');
  const key = 'idem_' + 'e'.repeat(32), body = { operationCode: 'membership.benefit.policy.publish', payload: { policyDraftId: 'draft-1', policyDraftVersion: 1, policyDraftHash: 'a'.repeat(64) } };
  const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, '', 'approval.request.create');
  assert.equal(savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: '', operation: 'approval.request.create', path: '/security/approvals/requests', idempotencyKey: key, body, readback: { kind: 'lists', keys: ['mine'] }, successMessage: 'fixture', kind: 'unknown' }).ok, true);
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url), method = (init.method ?? 'GET').toUpperCase(); requests.push({ path, method });
    const shared = workspaceRead(path); if (shared) return shared;
    if (method === 'GET' && path.endsWith('/membership-growth/policy')) return respond(policyResponse());
    if (method === 'GET' && path.includes('/security/approvals/recovery')) return respond({ knowledge: 'UNKNOWN' });
    throw new Error(`unexpected ${method} ${path}`);
  };
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const { createRoot } = await import('react-dom/client'), root = createRoot(host); roots.add(root);
  await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: 'user-a', gameId: 'game-1' } }, snapshot, onDirtyChange: () => {}, refreshNonce: 0 })));
  await openPolicyTab(host);
  await flushUntil(() => buttonByText(host, '查询原结果') && !buttonByText(host, '查询原结果').disabled, 'unknown recovery settled');
  assert.equal(host.querySelectorAll('[data-testid=membership-policy-feedback]').length, 1);
  assert.equal(buttonByText(host, '调整会员政策').disabled, true);
  assert.equal(buttonByText(host, '保存草稿').disabled, true);
  assert.ok(!buttonByText(host, '提交审批') || buttonByText(host, '提交审批').disabled);
  await act(async () => buttonByText(host, '保存草稿').click());
  const pending = inspectPending(subject); assert.equal(pending.state, 'valid');
  assert.equal(pending.record.idempotencyKey, key); assert.deepEqual(pending.record.body, body);
  assert.equal(requests.some(item => item.method !== 'GET'), false);
});
