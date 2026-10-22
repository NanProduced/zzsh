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
function workspaceRead(path){const url=new URL(path,"http://127.0.0.1:3101");if(url.pathname.endsWith("/membership-growth/entitlement-options"))return respond({games:[{id:"game-1",name:"测试游戏"}],capability:{canRead:true,canRequest:true}});if(url.pathname.endsWith("/membership-growth/entitlements"))return respond({schema:"membership-entitlements.v1",asOfUtc:"2026-10-23T00:00:00Z",total:0,page:1,pageSize:20,contextKey:"a".repeat(64),items:[]});if(url.pathname.endsWith("/security/approvals/requests/detail"))return respond({requestId:url.searchParams.get("requestId"),operationCode:"membership.benefit.policy.publish"});if(url.pathname.includes("/users/"))return respond({subjectId:"user-a",growth:{knowledge:"UNKNOWN",effectiveTier:null,rollingPoints:null,lifetimePoints:null,sourceState:"BACKFILL_PENDING"}});return undefined;}
async function openPolicyTab(host){const tab=[...host.querySelectorAll("[role=tab]")].find(element=>element.textContent==="会员政策");assert.ok(tab,"membership policy tab is authorized");await act(async()=>tab.click());await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});}

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
    const snapshot = actorSnapshot();
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab, snapshot, onDirtyChange: (value) => dirty.push(value), refreshNonce: 0 })));
    await openPolicyTab(host);
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
    assert.equal(saves[1].body.policy.tiers.SILVER.pricing.ordinary.payableRatio, "0.91");
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

test("R1-07 host entitlement replacement uses the approved context and its own discount references", async () => {
  const browser=installBrowser(),{vite,MembershipGrowthAdminHost}=await loadHost();let releasePost;
  try{
    const host=browser.document.createElement('div');browser.document.body.append(host);const {createRoot}=await import('react-dom/client'),root=createRoot(host);roots.add(root);
    const requests=[],original={id:'existing-entitlement',userId:'user-a',userSummary:{name:'合成用户甲',image:null,maskedPhone:null},gameId:'game-1',gameName:'测试游戏',kind:'FRIEND',scopeKey:'legacy:scope',startsAtUtc:'2026-11-01T00:00:00.000Z',endsAtUtc:'2026-11-20T00:00:00.000Z',status:'EXECUTED_PENDING_START',depositWaived:false,approvedPolicyId:'approved-effective-1',approvalRequestId:'original-approval',pricingSummary:{knowledge:'KNOWN',kind:'TOTAL_DISCOUNT',mode:'ordinary',payableRatio:'0.85'}};
    const context={schema:'membership-entitlement-context.v1',subject:{userId:'user-a',name:'合成用户甲',image:null,maskedPhone:null},game:{id:'game-1',name:'测试游戏'},approvedMeta:{id:'approved-effective-1',version:'7',effectiveAtUtc:'2026-10-01T00:00:00.000Z',ruleReleaseId:'release-1',priceVersionId:'price-v1',payloadHash:'d'.repeat(64),sourceRef:'fixture'},ranges:policyPayload().entitlementRanges,rangeSource:'INDEPENDENT',capability:{canRequest:true,reasonCode:'OK'},existingEntitlements:[original]};
    globalThis.fetch=async(url,init={})=>{
      const path=String(url),method=(init.method??'GET').toUpperCase(),body=init.body===undefined?undefined:JSON.parse(String(init.body));requests.push({path,method,body});
      if(method==='GET'&&path.includes('/membership-growth/entitlements?'))return respond({schema:'membership-entitlements.v1',asOfUtc:'2026-10-23T00:00:00Z',total:1,page:1,pageSize:20,contextKey:'b'.repeat(64),items:[original]});
      if(method==='GET'&&path.includes('/membership-growth/entitlement-context?'))return respond(context);
      if(method==='GET'){const shared=workspaceRead(path);if(shared)return shared;}
      if(method==='GET'&&path.endsWith('/membership-growth/policy'))return respond({policy:policyPayload(),meta:metaFixture(),catalog,thresholds,bootstrap:null});
      if(method==='POST'&&path.endsWith('/security/approvals/requests'))return new Promise(resolve=>{releasePost=()=>resolve(respond({requestId:'approval-fixture'}));});
      throw new Error(`unexpected ${method} ${path}`);
    };
    await act(async()=>root.render(createElement(MembershipGrowthAdminHost,{tab:{query:{userId:'user-a',gameId:'game-1'}},snapshot:actorSnapshot(),onDirtyChange(){},refreshNonce:0})));
    assert.equal(host.querySelector('[role=tab][aria-selected=true]').textContent,'礼遇管理');
    await act(async()=>buttonByText(host,'替换/续期').click());
    const ratio=browser.document.querySelector('input[aria-label="礼遇应付比例"]');assert.ok(ratio);
    assert.equal(ratio.value,'0.85','the current entitlement is not re-seeded from GOLD tier 0.90');
    await setInput(browser,ratio,'0.80');
    const reason=browser.document.querySelector('textarea[aria-label="礼遇原因"]');
    await act(async()=>{Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set.call(reason,'专项礼遇续期');reason.dispatchEvent(new browser.Event('input',{bubbles:true}));reason.dispatchEvent(new browser.Event('change',{bubbles:true}));});
    const submit=buttonByText(browser.document,'提交礼遇审批');assert.ok(submit&&!submit.disabled);
    await act(async()=>submit.click());
    const approval=requests.find(request=>request.method==='POST'&&request.path.endsWith('/security/approvals/requests'));assert.ok(approval);
    assert.equal(approval.body.operationCode,'membership.entitlement.replace');assert.equal(approval.body.payload.policyId,'approved-effective-1','the editable draft meta is never used for a grant');
    assert.equal(approval.body.payload.replaceEntitlementId,original.id);assert.equal(approval.body.payload.scopeKey,original.scopeKey);
    assert.deepEqual(approval.body.payload.pricing,{status:'CONFIGURED',kind:'TOTAL_DISCOUNT',mode:'ordinary',priceVersionId:'price-v1',payableRatio:'0.80',costBasisRef:'cost-independent'});
    assert.equal(approval.body.payload.pricing.haff,undefined);assert.equal(approval.body.payload.pricing.materials,undefined);assert.equal(approval.body.payload.depositWaived,false);
    assert.equal(Object.hasOwn(approval.body,'supersedesRequestId'),false);
    // This assertion stops at the POST boundary; the hook's ACK/readback scenarios are tested elsewhere.
    await act(async()=>root.unmount());await act(async()=>{releasePost();await Promise.resolve();});
  }finally{await closeUI(vite,browser);}
});
test("R2-05 a late approval receipt never overwrites edits made while it was pending", async () => {
  const browser = installBrowser();
  const { vite, MembershipGrowthAdminHost } = await loadHost();
  try {
    const host = browser.document.createElement("div");
    browser.document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);roots.add(root);
    const requests = [];
    let releaseApproval = null;
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url);
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ path, method, body });
      if(method==="GET"){const shared=workspaceRead(path);if(shared)return shared;}
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond({ policy: policyPayload(), meta: metaFixture(), catalog, thresholds, bootstrap: null });
      if (method === "GET" && path.includes("/users/")) return respond({ subjectId: "user-a" });
      if (method === "POST" && path.endsWith("/security/approvals/requests")) return new Promise((resolve) => { releaseApproval = () => resolve(respond({ requestId: "approval-late" })); });
      if (method === "POST" && path.endsWith("/membership-growth/policy-drafts")) return respond({ id: "draft-9", version: "2", payloadHash: "d".repeat(64) });
      throw new Error(`unexpected ${method} ${path}`);
    };
    const tab = { query: { userId: "user-a", gameId: "game-1" } };
    const snapshot = actorSnapshot();
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab, snapshot, onDirtyChange: () => undefined, refreshNonce: 0 })));
    await openPolicyTab(host);
    const ratio = () => host.querySelector("input[aria-label='SILVERordinary应付比例']");
    assert.ok(ratio(), host.textContent.slice(0, 400));
    // The saved draft can request approval; the response is delayed while the operator keeps editing.
    await act(async () => buttonByText(host, "提交审批").click());
    assert.ok(releaseApproval);
    await setInput(browser, ratio(), "0.91");
    await act(async () => { releaseApproval(); await Promise.resolve(); });
    assert.equal(ratio().value, "0.91");
    assert.match(host.textContent, /审批申请已提交/);
    // The next save must send the current edit, not the stale pre-approval policy captured by the receipt.
    await act(async () => buttonByText(host, "保存草稿").click());
    const saves = requests.filter((request) => request.method === "POST" && request.path.endsWith("/policy-drafts"));
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body.policy.tiers.SILVER.pricing.ordinary.payableRatio, "0.91");
    await act(async () => root.unmount());
  } finally {
    await closeUI(vite,browser);
  }
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
        if (policyGets === 1) return respond({ policy: policyPayload(), meta: metaFixture(), catalog, thresholds, bootstrap: null });
        return respond({ policy: { ...policyPayload(), version: "5" }, meta: { id: "draft-5", version: "5", status: "DRAFT", effectiveAtUtc: "2026-11-01T00:00:00.000Z", ruleReleaseId: "release-5", priceVersionId: "price-v5", sourceRef: "fixture", payloadHash: "e".repeat(64) }, catalog, thresholds, bootstrap: null });
      }
      if (method === "GET" && path.includes("/users/")) return respond({ subjectId: "user-a" });
      if (method === "POST" && path.endsWith("/membership-growth/policy-drafts")) {
        if (!releaseFirstSave) return new Promise((resolve) => { releaseFirstSave = () => resolve(respond({ id: "draft-2", version: "2", payloadHash: "b".repeat(64) })); });
        return respond({ id: "draft-6", version: "6", payloadHash: "f".repeat(64) });
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const tab = { query: { userId: "user-a", gameId: "game-1" } };
    const snapshot = actorSnapshot();
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab, snapshot, onDirtyChange: () => undefined, refreshNonce: 0 })));
    await openPolicyTab(host);
    const ratio = () => host.querySelector("input[aria-label='SILVERordinary应付比例']");
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
    assert.equal(saves[1].body.policy.tiers.SILVER.pricing.ordinary.payableRatio, "0.93");
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
      if (method === "GET" && path.endsWith("/membership-growth/policy")) return respond({ policy: policyPayload(), meta: metaFixture(), catalog, thresholds, bootstrap: null });
      if (method === "GET" && path.includes("/users/")) return respond({ subjectId: "user-a" });
      if (method === "POST" && path.endsWith("/membership-growth/policy-drafts")) return new Promise((resolve) => { releaseSave = () => resolve(respond({ id: "draft-2", version: "2", payloadHash: "b".repeat(64) })); });
      throw new Error(`unexpected ${method} ${path}`);
    };
    let activeTab = "membership";
    const dirtyByTab = { membership: false, other: true };
    const dirtySignals = [];
    // AppShell's callback applies to activeIdRef.current, so an old host must stop calling it after cleanup.
    const onDirtyChange = (dirty) => { dirtyByTab[activeTab] = dirty; dirtySignals.push({ tab: activeTab, dirty }); };
    await act(async () => root.render(createElement(MembershipGrowthAdminHost, { tab: { query: { userId: "user-a", gameId: "game-1" } }, snapshot: actorSnapshot(), onDirtyChange, refreshNonce: 0 })));
    mounted = true;
    await setInput(browser, host.querySelector("input[aria-label='SILVERordinary应付比例']"), "0.91");
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
    assert.equal(host.querySelector("input[aria-label='SILVERordinary应付比例']").disabled,true);
    assert.equal(buttonByText(host,'保存草稿'),undefined);assert.equal(buttonByText(host,'提交审批'),undefined);assert.equal(buttonByText(host,'办理礼遇'),undefined);
    allowed=false;await act(async()=>root.render(createElement(MembershipGrowthAdminHost,{...props,snapshot:actorSnapshot([],false)})));
    assert.equal([...host.querySelectorAll('[role=tab]')].some(element=>element.textContent==='会员政策'),false);
    assert.equal(requests.some(request=>request.method!=='GET'),false);
  }finally{await closeUI(vite,browser);}
});
