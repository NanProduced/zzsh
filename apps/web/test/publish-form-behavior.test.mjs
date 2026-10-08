import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(tree, "package.json"));
const React = require("react");
const { Window } = require("happy-dom");
const ts = require("typescript");
const actualSupply = require(path.join(tree, "apps/web/src/lib/supply-client.ts"));
const compiled = ts.transpileModule(fs.readFileSync(path.join(tree, "apps/web/src/components/supply/publish-form.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

const games = [{ id: "game_1", code: "delta", name: "三角洲行动", description: null }];
const catalog = {
  game: { id: "game_1", code: "delta", name: "三角洲行动", catalogRevision: "1", currentReleaseId: "release_1" },
  inputScale: 0,
  ready: true,
  blockers: [],
  items: [
    { id: "item_haff", code: "haff_base", name: "哈夫币", unit: "HAFF_BASE", quantityScale: 0, required: true, sortOrder: 0 },
    { id: "item_round", code: "level6_round", name: "六级子弹", unit: "ROUND", quantityScale: 0, required: false, sortOrder: 1 },
  ],
  categories: [], rarities: [], skins: [], entitlements: [], nextCursor: null, limit: 30,
};
const optionsV1 = {
  releaseId: "release_1", generation: "1",
  termOptions: [{ code: "daily-10m", name: "10M/天", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }],
  safeBoxCodes: ["box-a"], vitalityLevels: [4, 5, 6, 7], bearLevels: [4, 5, 6, 7], pricingOptionCodes: ["standard"],
  agreement: { id: "ag_1", title: "出租协议", body: "合成协议正文", digest: "digest_1" },
};
const optionsV2 = {
  ...optionsV1,
  pricingOptionCodes: [],
  pricingSchema: "haff-ratio-v2",
  rentalModes: {
    ordinary: { enabled: true },
    custom: { enabled: true, min: { base: "ABSOLUTE", value: "39" }, max: { base: "ABSOLUTE", value: "41" } },
    fast: { enabled: true, min: { base: "ABSOLUTE", value: "48" }, max: { base: "ABSOLUTE", value: "99" } },
  },
};
const optionsV2NoFast = { ...optionsV2, rentalModes: { ...optionsV2.rentalModes, fast: { enabled: false } } };
const ownerQuote = {
  schemaVersion: 1, currency: "CNY", ruleReleaseId: "release_1",
  lines: [{
    itemId: "item_haff", quantity: "60000000", unit: "HAFF_BASE", unitQuantity: "1000000",
    buyerUnitAmount: { currency: "CNY", unit: "yuan", amount: "2.5", scale: 8 },
    buyerAmount: { currency: "CNY", unit: "yuan", amount: "150.00", scale: 2 },
    ownerUnitAmount: { currency: "CNY", unit: "yuan", amount: "2", scale: 8 },
    ownerAmount: { currency: "CNY", unit: "yuan", amount: "120.00", scale: 2 },
  }],
  resourceTotal: { currency: "CNY", unit: "yuan", amount: "150.00", scale: 2 },
  ownerTotal: { currency: "CNY", unit: "yuan", amount: "120.00", scale: 2 },
  publisherBailRequirement: null, contentHash: "hash_1", termSeconds: "518400",
  expiryDisclosures: [], unitAmountsInformational: true, tenantDeposit: null, tenantPayableTotal: null,
};

function declaration(overrides = {}) {
  return {
    title: "", description: null,
    attributes: {
      safe_box_code: null, vit_level: null, bear_level: null, dive_level: null, character_level: null,
      awm_weapon_count: null, grading_code: null, login_method_code: null, region_province: null, region_city: null,
      ban_record: null, face_is_self: null, secret_kd: null, service_window_start_minute: null, service_window_end_minute: null,
      service_window_timezone: null, service_window_cross_midnight: null,
    },
    termOptionCode: "daily-10m", pricingOptionCode: "standard", inventory: [], skins: [], entitlements: [], mediaBindings: [],
    ...overrides,
  };
}
function supplyOf(declarationValue, { quote = null, reviewState = "DRAFT", revision = "5", versionId = "version_1", schemaVersion = 1, versionRevision = "1" } = {}) {
  return {
    account: { id: "account_1", game_id: "game_1", revision, current_version_id: versionId, owner_paused: false, staff_restricted: false, restriction_reason: null },
    version: {
      id: versionId, schemaVersion, sequence: "1", revision: versionRevision, reviewState,
      releaseId: quote ? "release_1" : null, contentHash: quote ? "hash_1" : null,
      declaration: declarationValue,
      catalogItems: [
        { id: "item_haff", code: "haff_base", name: "哈夫币", unit: "HAFF_BASE", priced: true },
        { id: "item_round", code: "level6_round", name: "六级子弹", unit: "ROUND", priced: true },
      ],
      quote,
    },
    agreement: optionsV1.agreement, available: true, blockers: [],
  };
}

async function probe({ mode = "standard", accountId, editRequested = false, gameCode = "delta", options = optionsV1, catalogValue = catalog, mine, saveDraft, quote, confirm, depositRecommendation, readNotice = true, createAccount, createDraft, uploadMedia, userId = 'user_A', storageSeed, storageUnavailable = false } = {}) {
  const window = new Window({ url: "http://127.0.0.1:3100/publish" });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    DOMParser: window.DOMParser, Event: window.Event, MouseEvent: window.MouseEvent, DOMException: window.DOMException, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: window.ResizeObserver,
    CustomEvent: window.CustomEvent, NodeFilter: window.NodeFilter, HTMLInputElement: window.HTMLInputElement,
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  window.scrollTo = () => {};
  if(storageSeed)for(const [key,value] of storageSeed)window.sessionStorage.setItem(key,value);
  if(storageUnavailable)Object.defineProperty(window,'sessionStorage',{get(){throw Error('Storage denied');}});
  window.confirm = () => { throw Error("Publishing must use its app dialog, not window.confirm"); };
  let readingTime = 0, readingTick;
  window.performance.now = () => readingTime;
  window.setInterval = callback => { readingTick = callback; return 1; };
  window.clearInterval = () => {};
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  const session = { status: "authenticated", userId, identityVersion: 1, revalidations: 0, revalidate() { this.revalidations += 1; } };
  const listeners = new Set();
  const store = {
    getSnapshot: () => session,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    confirm: async () => { session.revalidations += 1; for (const listener of listeners) listener(); return true; },
  };
  const navigationCalls = [];
  const router = { replace(href) { navigationCalls.push({method:"replace",href}); }, push(href) { navigationCalls.push({method:"push",href}); } };
  const calls = [];
  const api = {
    games: async () => ({ games }),
    publishingOptions: async () => options,
    resourceIncomePreview: async () => ({available:false,reason:"PREVIEW_UNAVAILABLE"}),
    catalog: async () => typeof catalogValue === "function" ? catalogValue() : catalogValue,
    mine: async (...args) => (typeof mine === "function" ? mine(...args) : mine),
    createAccount: async (...args) => createAccount ? createAccount(...args) : ({ accountId: "account_1", gameId: "game_1" }),
    createDraft: async (...args) => createDraft ? createDraft(...args) : supplyOf(declaration()),
    saveDraft: async (accountId, body, key) => {
      calls.push({ op: "saveDraft", accountId, body, key });
      if (typeof saveDraft === "function") return saveDraft(body, key, calls);
      return supplyOf(body);
    },
    quote: async (accountId, revision, key) => {
      calls.push({ op: "quote", accountId, revision, key });
      if (typeof quote === "function") return quote(calls);
      return supplyOf(declaration({ inventory: [{ itemId: "item_haff", quantity: "60000000" }] }), { quote: ownerQuote });
    },
    confirm: async (accountId, action, body, key) => {
      calls.push({ op: "confirm", action, accountId, body, key });
      if (typeof confirm === "function") return confirm(action, body, calls);
      return supplyOf(declaration(), { quote: ownerQuote });
    },
    depositRecommendation: async (accountId) => {
      calls.push({ op: "depositRecommendation", accountId });
      if (typeof depositRecommendation === "function") return depositRecommendation(calls);
      return { available: false, reason: "FUNDING_POLICY_UNCONFIGURED", releaseId: "release_1" };
    },
  };
  const module = new Module(path.join(tree, "publish-form-probe.cjs"));
  module.filename = path.join(tree, "publish-form-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name.endsWith(".css")) return {};
    if (name === "../ui/form-controls") {
      const controlPath = path.join(tree, "apps/web/src/components/ui/form-controls.tsx");
      const controlModule = new Module(controlPath);
      controlModule.filename = controlPath; controlModule.paths = Module._nodeModulePaths(tree);
      controlModule.require = dependency => dependency.endsWith(".css") ? {} : require(dependency);
      controlModule._compile(ts.transpileModule(fs.readFileSync(controlPath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, controlPath);
      return controlModule.exports;
    }
    if (name === "next/link") return ({ children, href, ...props }) => React.createElement("a", { href, ...props }, children);
    if (name === "next/navigation") return { useRouter: () => router };
    if (name === "../session/user-session-provider") return { useUserSessionStore: () => store, useUserSession: () => session };
    if (name === "../layout/service-shell") return { ServiceShell: ({ children, topContent }) => React.createElement("main", null, topContent, children) };
    if (name === "../../lib/supply-client") return { ...actualSupply, supplyApi: api, uploadSupplyMedia: uploadMedia ?? (async () => null) };
    if (name.startsWith("../../lib/")) return require(path.join(tree, "apps/web/src/lib", `${name.slice(10)}.ts`));
    return require(name);
  };
  module._compile(compiled, module.filename);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  let root = require("react-dom/client").createRoot(host);
  let props = { mode, accountId, editRequested, gameCode };
  const settle = async (turns = 5) => {
    for (let index = 0; index < turns; index += 1) {
      await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  return {
    host, session, calls, window, navigationCalls,
    async remount() { await React.act(async()=>root.unmount());root=require('react-dom/client').createRoot(host);await this.render(); },
    async navigate(next) { props = { ...props, ...next }; await this.render(); },
    storageDump() { return Array.from({length:window.sessionStorage.length},(_,i)=>{const k=window.sessionStorage.key(i);return[k,window.sessionStorage.getItem(k)];}); },
    notifyIdentity() { for (const listener of listeners) listener(); },
    async advanceReading(milliseconds) { await React.act(async () => { readingTime += milliseconds; readingTick?.(); }); await settle(); },
    text: () => host.textContent ?? "",
    findButton: (label) => [...host.querySelectorAll("button")].find((button) => (button.textContent ?? "").includes(label) && !button.disabled),
    async render() {
      await React.act(async () => {
        root.render(React.createElement(module.exports.PublishForm, props));
      });
      await settle();
      if (readNotice) {
        await React.act(async () => { readingTime += 5000; readingTick?.(); });
        await settle();
        const button = window.document.querySelector('.publish-reading-footer > button');
        if (button) { await React.act(async () => button.click()); await settle(); }
      }
    },
    async waitFor(predicate, turns = 30) {
      for (let index = 0; index < turns; index += 1) {
        if (predicate()) return true;
        await settle(1);
      }
      return predicate();
    },
    inputByLabel(fragment) {
      return [...host.querySelectorAll("input")].find((input) => (input.getAttribute("aria-label") ?? "").includes(fragment)) ?? null;
    },
    async click(selector) {
      const element = host.querySelector(selector);
      assert.ok(element, `missing ${selector}`);
      await React.act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
      await settle();
    },
    async clickButton(label) {
      const button = [...host.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").includes(label));
      assert.ok(button, `missing button ${label}`);
      await React.act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
      await settle();
    },
    async type(selector, value) {
      const element = host.querySelector(selector);
      assert.ok(element, `missing ${selector}`);
      await React.act(async () => {
        const proto = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(element, value);
        element.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await settle();
    },
    async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); },
  };
}

test("availability stays undeclared until chosen, and help opens by click", async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    const mode = p.host.querySelector('[role="radiogroup"][aria-label="可配合上号时间"]');
    assert.ok(mode);
    assert.equal(mode.querySelectorAll('[aria-checked="true"]').length, 0);
    assert.equal(p.host.querySelector('[aria-label="开始时间"]'), null);
    assert.match(p.host.querySelector('#publish-secret-kd').labels[0].textContent,/绝密KD/);
    await p.click('button[aria-label="安全箱档位说明"]');
    await p.waitFor(() => p.window.document.querySelector('[role="tooltip"]'));
    assert.match(p.window.document.querySelector('[role="tooltip"]').textContent, /永久安全箱/);
    await p.clickButton("保存草稿");
    await p.waitFor(() => p.calls.some(call => call.op === "saveDraft"));
    const attrs=p.calls.find(call => call.op === "saveDraft").body.attributes;
    assert.equal(attrs.service_window_start_minute,null);
    assert.equal(attrs.service_window_end_minute,null);
    assert.equal(attrs.ban_record,null);
    assert.equal(attrs.face_is_self,null);
  } finally { await p.close(); }
});

test('gateway 500/503/504 keep frozen draft responsibility and same-key recovery',async()=>{
 for(const status of [500,503,504]){let attempts=0;const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration()),saveDraft:body=>{if(++attempts===1)throw new actualSupply.SupplyRequestError(status,{error:{code:'INTERNAL_ERROR',message:'upstream failure'}});return supplyOf(body);}});
 try{await p.render();await p.type('#publish-description','original body');await p.clickButton('保存草稿');await p.waitFor(()=>p.calls.some(c=>c.op==='saveDraft'));assert.equal(p.host.querySelector('#publish-description').disabled,true);const first=p.calls.find(c=>c.op==='saveDraft');await p.clickButton('重试当前步骤');await p.waitFor(()=>p.calls.filter(c=>c.op==='saveDraft').length===2);const second=p.calls.filter(c=>c.op==='saveDraft')[1];assert.equal(second.key,first.key);assert.deepEqual(second.body,first.body);}finally{await p.close();}}
});

test('same-user remount and fresh-window restore preserve uncertain confirmation; another user cannot consume it',async()=>{
 const saved=supplyOf(declaration({title:'quoted'}),{quote:ownerQuote});const fail=()=>{throw new actualSupply.SupplyRequestError(503,{error:{code:'INTERNAL_ERROR',message:'lost confirmation'}})};
 const p=await probe({accountId:'account_1',mine:()=>saved,confirm:fail});let dump,first;
 try{await p.render();await p.click('.publish-confirm input');await p.click('.publish-confirm button.button.primary');await p.waitFor(()=>p.calls.some(c=>c.op==='confirm'));first=p.calls.find(c=>c.op==='confirm');await p.remount();assert.ok(p.findButton('重试当前步骤'));await p.clickButton('重试当前步骤');assert.equal(p.calls.filter(c=>c.op==='confirm')[1].key,first.key);dump=p.storageDump();}finally{await p.close();}
 const other=await probe({accountId:'account_1',mine:()=>saved,userId:'user_B',storageSeed:dump});try{await other.render();assert.equal(other.findButton('重试当前步骤'),undefined);assert.equal(other.calls.length,0);}finally{await other.close();}
 const returned=await probe({accountId:'account_1',mine:()=>saved,storageSeed:dump,confirm:fail});try{await returned.render();assert.ok(returned.findButton('重试当前步骤'));assert.equal(returned.calls.length,0,'mount never auto-POSTs');await returned.clickButton('重试当前步骤');assert.equal(returned.calls[0].key,first.key);assert.deepEqual(returned.calls[0].body,first.body);}finally{await returned.close();}
});

test('accepted account creation followed by readback failure only recovers GET, including remount',async()=>{
 let creates=0,reads=0;const p=await probe({createAccount:()=>{creates++;return{accountId:'account_1',gameId:'game_1'};},mine:()=>{if(++reads===1)throw new actualSupply.SupplyRequestError(503,{error:{code:'INTERNAL_ERROR',message:'readback failed'}});return supplyOf(declaration());}});
 try{await p.render();await p.clickButton('保存草稿');await p.waitFor(()=>creates===1);assert.equal(creates,1);const raw=p.storageDump().find(([k])=>k.startsWith('zzsh.supply-write'))[1];assert.equal(JSON.parse(raw).phase,'accepted');await p.remount();assert.ok(p.findButton('重试当前步骤'));await p.clickButton('重试当前步骤');assert.equal(creates,1);assert.equal(p.calls.filter(c=>c.op==='saveDraft').length,0);assert.ok(reads>=2);}finally{await p.close();}
});

test('unavailable intent persistence blocks account creation and any new business write',async()=>{let creates=0;const p=await probe({storageUnavailable:true,createAccount:()=>{creates++;return{accountId:'account_1',gameId:'game_1'};}});try{await p.render();await p.clickButton('保存草稿');assert.equal(creates,0);assert.equal(p.calls.length,0);assert.match(p.text(),/无法读取原操作记录|无法保留/);}finally{await p.close();}});

test('KD retains invalid/decimal/empty/historical input instead of laundering it',async()=>{
 for(const [raw,allowed] of [['-1.5',false],['100.01',false],['1.25',true],['',true],['100',true],['x',false]]){const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration())});try{await p.render();await p.type('#publish-secret-kd',raw);assert.equal(p.host.querySelector('#publish-secret-kd').value,raw);await p.clickButton('保存草稿');if(allowed){await p.waitFor(()=>p.calls.some(c=>c.op==='saveDraft'));assert.equal(p.calls.find(c=>c.op==='saveDraft').body.attributes.secret_kd,raw||null);}else{assert.equal(p.calls.filter(c=>c.op==='saveDraft').length,0);assert.equal(p.host.querySelector('#publish-secret-kd').value,raw);}}finally{await p.close();}}
 const attrs={...declaration().attributes,secret_kd:'123.45'};const old=await probe({accountId:'account_1',mine:()=>supplyOf(declaration({attributes:attrs}))});try{await old.render();assert.equal(old.host.querySelector('#publish-secret-kd').value,'123.45');await old.clickButton('保存草稿');assert.equal(old.calls.length,0);}finally{await old.close();}
});

test('an uncertain retry rejected after remount retains responsibility rather than unlocking edits',async()=>{let attempts=0;const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration()),saveDraft:()=>{if(++attempts===1)throw new actualSupply.SupplyRequestError(503,{error:{code:'INTERNAL_ERROR',message:'unknown'}});throw new actualSupply.SupplyRequestError(404,{error:{code:'NOT_FOUND',message:'no current object'}});}});try{await p.render();await p.type('#publish-description','frozen');await p.clickButton('保存草稿');await p.waitFor(()=>p.calls.length);await p.remount();await p.clickButton('重试当前步骤');assert.equal(p.host.querySelector('#publish-description').disabled,true);assert.ok(p.storageDump().some(([key])=>key.startsWith('zzsh.supply-write')));assert.equal(p.calls[1].key,p.calls[0].key);}finally{await p.close();}});

test('pending media survives remount without storing File or upload tokens and cannot pretend to reupload',async()=>{const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration()),uploadMedia:()=>{throw new actualSupply.SupplyRequestError(503,{error:{code:'INTERNAL_ERROR',message:'upload unknown'}})}});try{await p.render();const input=p.host.querySelector('input[type=file]');Object.defineProperty(input,'files',{value:[new File(['valid-bytes-for-component-probe'],'show.png',{type:'image/png'})],configurable:true});await React.act(async()=>input.dispatchEvent(new p.window.Event('change',{bubbles:true})));await p.waitFor(()=>p.storageDump().some(([key])=>key.startsWith('zzsh.supply-write')));const raw=p.storageDump().find(([key])=>key.startsWith('zzsh.supply-write'))[1];assert.doesNotMatch(raw,/uploadToken|valid-bytes-for-component-probe/);assert.equal(JSON.parse(raw).action,'media');await p.remount();await p.clickButton('重试当前步骤');assert.match(p.text(),/原图片文件没有保留/);assert.ok(p.storageDump().some(([key])=>key.startsWith('zzsh.supply-write')));}finally{await p.close();}});

async function changeSubject(p, userId) {
  await React.act(async () => { p.session.status = 'loading'; p.notifyIdentity(); });
  assert.ok(await p.waitFor(() => !p.host.querySelector('.publish-groups')));
  await React.act(async () => { p.session.status = 'authenticated'; p.session.userId = userId; p.notifyIdentity(); });
  assert.ok(await p.waitFor(() => p.host.querySelector('.publish-groups')));
}
function intentFor(p, userId) {
  const row = p.storageDump().find(([key]) => key === 'zzsh.supply-write.v1:' + userId);
  return row ? JSON.parse(row[1]) : null;
}
function accountSupply(id, description = null) {
  const value = supplyOf(declaration({ description }));
  value.account.id = id;
  return value;
}

test('late A creation success records A accepted but cannot replace or unlock B UNKNOWN', async () => {
  let finishA;
  const delayed = new Promise(resolve => { finishA = resolve; }), creates = [];
  const p = await probe({ createAccount: (game, key) => { creates.push(key); if (creates.length === 1) return delayed; throw new actualSupply.SupplyRequestError(503, null, key); } });
  try {
    await p.render(); await p.clickButton('保存草稿'); assert.ok(await p.waitFor(() => creates.length === 1));
    await changeSubject(p, 'user_B'); await p.clickButton('保存草稿'); assert.ok(await p.waitFor(() => creates.length === 2));
    const beforeB = intentFor(p, 'user_B'); assert.equal(beforeB.phase, 'pending');
    await React.act(async () => finishA({ accountId: 'account_A', gameId: 'game_1' }));
    assert.ok(await p.waitFor(() => intentFor(p, 'user_A')?.phase === 'accepted'));
    assert.deepEqual(intentFor(p, 'user_B'), beforeB);
    assert.equal(p.host.querySelector('#publish-description').disabled, true);
    assert.ok(p.findButton('重试当前步骤'));
    await p.clickButton('重试当前步骤'); assert.equal(creates.length, 3); assert.equal(creates[2], beforeB.key);
    assert.ok(p.findButton('重试当前步骤')); assert.equal(p.host.querySelector('#publish-description').disabled, true);
    assert.equal(intentFor(p, 'user_A').phase, 'accepted'); assert.equal(intentFor(p, 'user_B').phase, 'pending');
  } finally { await p.close(); }
});

test('late A definite/401/503 failure cannot change B storage, identity or recovery lock', async () => {
  for (const status of [400, 401, 503]) {
    let rejectA;
    const delayed = new Promise((_, reject) => { rejectA = reject; }), creates = [];
    const p = await probe({ createAccount: (game, key) => { creates.push(key); if (creates.length === 1) return delayed; throw new actualSupply.SupplyRequestError(503, null, key); } });
    try {
      await p.render(); await p.clickButton('保存草稿'); assert.ok(await p.waitFor(() => creates.length === 1));
      await changeSubject(p, 'user_B'); await p.clickButton('保存草稿'); assert.ok(await p.waitFor(() => creates.length === 2));
      const beforeB = intentFor(p, 'user_B'), beforeText = p.text();
      await React.act(async () => rejectA(new actualSupply.SupplyRequestError(status, null, creates[0])));
      assert.ok(await p.waitFor(() => status === 400 ? intentFor(p, 'user_A') === null : intentFor(p, 'user_A')?.uncertain));
      assert.deepEqual(intentFor(p, 'user_B'), beforeB); assert.equal(p.text(), beforeText);
      assert.equal(p.session.revalidations, 0); assert.ok(p.findButton('重试当前步骤'));
      assert.equal(p.host.querySelector('#publish-description').disabled, true);
      await p.clickButton('重试当前步骤'); assert.equal(creates[2], beforeB.key);
      assert.ok(p.findButton('重试当前步骤')); assert.equal(p.host.querySelector('#publish-description').disabled, true);
    } finally { await p.close(); }
  }
});

test('A to B to A preserves epochs and recovers late accepted A only by GET, leaving B pending', async () => {
  let finishA;
  const delayed = new Promise(resolve => { finishA = resolve; }), creates = [], reads = [];
  const p = await probe({ createAccount: (game, key) => { creates.push(key); if (creates.length === 1) return delayed; throw new actualSupply.SupplyRequestError(503, null, key); }, mine: id => { reads.push(id); return accountSupply(id); } });
  try {
    await p.render(); await p.clickButton('保存草稿'); assert.ok(await p.waitFor(() => creates.length === 1));
    const originalA = intentFor(p, 'user_A');
    await changeSubject(p, 'user_B'); await p.clickButton('保存草稿'); assert.ok(await p.waitFor(() => creates.length === 2));
    const originalB = intentFor(p, 'user_B');
    await changeSubject(p, 'user_A'); assert.ok(await p.waitFor(() => p.findButton('重试当前步骤')));
    assert.equal(intentFor(p, 'user_A').key, originalA.key);
    await React.act(async () => finishA({ accountId: 'account_A', gameId: 'game_1' }));
    assert.ok(await p.waitFor(() => intentFor(p, 'user_A')?.phase === 'accepted'));
    assert.equal(reads.length, 0, 'old epoch cannot consume its accepted receipt');
    assert.ok(p.findButton('重试当前步骤')); assert.equal(p.host.querySelector('#publish-description').disabled, true);
    await p.clickButton('重试当前步骤'); assert.ok(await p.waitFor(() => intentFor(p, 'user_A') === null));
    assert.deepEqual(reads, ['account_A']); assert.equal(creates.length, 2, 'accepted restoration must not POST');
    assert.deepEqual(intentFor(p, 'user_B'), originalB);
    await changeSubject(p, 'user_B'); assert.ok(await p.waitFor(() => p.findButton('重试当前步骤')));
    await p.clickButton('重试当前步骤'); assert.equal(creates[2], originalB.key);
    assert.ok(p.findButton('重试当前步骤')); assert.equal(p.host.querySelector('#publish-description').disabled, true);
  } finally { await p.close(); }
});

test('late save on another account of the same subject cannot apply its body, notice or unlock', async () => {
  let finishFirst, savedBody;
  const delayed = new Promise(resolve => { finishFirst = resolve; });
  const p = await probe({ accountId: 'account_1', mine: id => accountSupply(id, id === 'account_2' ? 'second object' : 'first object'), saveDraft: body => { savedBody = body; return delayed; } });
  try {
    await p.render(); await p.type('#publish-description', 'first submitted body'); await p.clickButton('保存草稿');
    assert.ok(await p.waitFor(() => p.calls.length === 1)); const original = intentFor(p, 'user_A');
    await p.navigate({ accountId: 'account_2' }); assert.ok(await p.waitFor(() => p.host.querySelector('#publish-description')?.value === 'second object'));
    const beforeText = p.text(); assert.equal(p.host.querySelector('#publish-description').disabled, true);
    const accepted = supplyOf(savedBody); await React.act(async () => finishFirst(accepted));
    assert.ok(await p.waitFor(() => intentFor(p, 'user_A')?.phase === 'accepted'));
    assert.equal(p.host.querySelector('#publish-description').value, 'second object'); assert.equal(p.text(), beforeText);
    assert.equal(p.host.querySelector('#publish-description').disabled, true); assert.equal(intentFor(p, 'user_A').key, original.key);
    await p.navigate({ accountId: 'account_1' }); assert.ok(await p.waitFor(() => p.findButton('重试当前步骤')));
    await p.clickButton('重试当前步骤'); assert.ok(await p.waitFor(() => intentFor(p, 'user_A') === null));
    assert.equal(p.calls.length, 1, 'accepted original save is recovered by GET');
  } finally { await p.close(); }
});

test('late accepted recovery GET for A cannot apply into or release B pending responsibility', async () => {
  let finishRead;
  const delayed = new Promise(resolve => { finishRead = resolve; }), creates = [];
  const acceptedA = { version: 1, userId: 'user_A', gameId: 'game_1', accountId: null, action: 'create-account', key: 'accepted_A', body: { gameId: 'game_1' }, phase: 'accepted', receipt: { accountId: 'account_A' }, createdAt: '2026-10-07T00:00:00.000Z' };
  const p = await probe({ storageSeed: [['zzsh.supply-write.v1:user_A', JSON.stringify(acceptedA)]], mine: () => delayed, createAccount: (game, key) => { creates.push(key); throw new actualSupply.SupplyRequestError(503, null, key); } });
  try {
    await p.render(); assert.ok(p.findButton('重试当前步骤')); await p.clickButton('重试当前步骤');
    await changeSubject(p, 'user_B'); await p.clickButton('保存草稿'); assert.ok(await p.waitFor(() => creates.length === 1));
    const beforeB = intentFor(p, 'user_B');
    await React.act(async () => finishRead(accountSupply('account_A', 'must stay private to A')));
    assert.deepEqual(intentFor(p, 'user_A'), acceptedA); assert.deepEqual(intentFor(p, 'user_B'), beforeB);
    assert.doesNotMatch(p.text(), /must stay private to A/); assert.ok(p.findButton('重试当前步骤'));
    assert.equal(p.host.querySelector('#publish-description').disabled, true);
    await p.clickButton('重试当前步骤'); assert.equal(creates[1], beforeB.key);
    assert.ok(p.findButton('重试当前步骤')); assert.equal(p.host.querySelector('#publish-description').disabled, true);
  } finally { await p.close(); }
});

test("entry notice requires five seconds, cannot escape early, and never accepts rules", async () => {
  const p = await probe({readNotice:false});
  try {
    await p.render();
    const popup = p.window.document.querySelector('[data-slot="dialog-content"]');
    assert.ok(popup);
    assert.match(popup.textContent,/绑定人脸须为号主本人/);
    assert.match(popup.textContent,/双设备.*两部手机/);
    assert.match(popup.textContent,/仅支持银行卡提现/);
    const button = popup.querySelector('button');
    assert.equal(button.disabled,true);
    await React.act(async () => popup.dispatchEvent(new p.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    assert.ok(p.window.document.querySelector('[data-slot="dialog-content"]'));
    await p.advanceReading(4999);
    assert.equal(button.disabled,true);
    await p.advanceReading(1);
    assert.equal(button.disabled,false);
    await React.act(async () => button.click());
    await p.waitFor(() => !p.window.document.querySelector('[data-slot="dialog-content"]'));
    assert.equal(p.calls.length,0,'reading does not save, quote or accept a contract');
    assert.doesNotMatch(popup.textContent,/180%|10%的结算/);
  } finally { await p.close(); }
});

test("unsaved and pending-catalog inputs use a cancellable app navigation dialog", async () => {
  const p = await probe();
  try {
    await p.render();
    await p.type('[aria-label="巴雷特子弹数量"]','7');
    const link = p.window.document.createElement('a');
    link.href='/accounts'; link.textContent='离开测试'; p.host.append(link);
    await React.act(async () => link.click());
    await p.waitFor(() => p.window.document.querySelector('[role="alertdialog"]'));
    let popup = p.window.document.querySelector('[role="alertdialog"]');
    assert.ok(popup);
    assert.equal(p.navigationCalls.length,0);
    await React.act(async () => [...popup.querySelectorAll('button')].find(b=>b.textContent==='继续填写').click());
    await p.waitFor(() => !p.window.document.querySelector('[role="alertdialog"]'));
    assert.equal(p.host.querySelector('[aria-label="巴雷特子弹数量"]').value,'7');
    assert.equal(p.navigationCalls.length,0);
    const unload=new p.window.Event('beforeunload',{cancelable:true});
    p.window.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented,true,'reload retains browser protection');
    await React.act(async () => link.click());
    await p.waitFor(() => p.window.document.querySelector('[role="alertdialog"]'));
    popup=p.window.document.querySelector('[role="alertdialog"]');
    await React.act(async () => [...popup.querySelectorAll('button')].find(b=>b.textContent==='放弃修改并离开').click());
    assert.deepEqual(p.navigationCalls,[{method:'push',href:'/accounts'}]);
    assert.equal(p.calls.length,0,'leaving is not an implicit save');
  } finally { await p.close(); }
});

test("page anchors keep every group expanded and do not prompt or write", async () => {
  const p=await probe();
  try {
    await p.render();
    await p.type('[aria-label="巴雷特子弹数量"]','2');
    assert.equal(p.host.querySelectorAll('.publish-outline-groups a').length,4);
    assert.equal(p.host.querySelectorAll('[data-publish-group]').length,4);
    await p.click('.publish-outline-groups a[href="#publish-group-terms"]');
    assert.equal(p.window.document.querySelector('[role="alertdialog"]'),null);
    assert.equal(p.calls.length,0);
    assert.equal(p.host.querySelector('[aria-label="巴雷特子弹数量"]').value,'2');
  } finally { await p.close(); }
});

test("unquoted summary distinguishes missing pricing from a zero income", async () => {
  const p=await probe();
  try {
    await p.render();
    const rail=p.host.querySelector('#publish-quote');
    assert.equal(rail.dataset.quoted,'false');
    assert.equal(rail.querySelector('[aria-label="预计收入合计"]'),null);
    assert.doesNotMatch(rail.textContent,/0\.00 元/);
    assert.equal(p.host.querySelector('[aria-label="物品预估收入"]').textContent,'预估暂不可用');
    assert.match(p.host.querySelector('[data-resource-code="df_billable_barrett_bullet"]').textContent,/待配置.*目录待配置/);
  } finally { await p.close(); }
});

test("notice trade link reads the supplied agreement without saving or accepting", async () => {
  const body='<p>真实版本格式的合成协议正文</p><script>unsafe()</script>';
  const p=await probe({readNotice:false,options:{...optionsV1,agreement:{...optionsV1.agreement,body}}});
  try {
    await p.render();
    const link=p.window.document.querySelector('.publish-reading-agreement-link');
    assert.ok(link && !link.disabled);
    await React.act(async()=>link.click());
    await p.waitFor(()=>p.window.document.querySelector('.publish-agreement-dialog'));
    const popup=p.window.document.querySelector('.publish-agreement-dialog');
    await p.waitFor(()=>popup.textContent.includes('真实版本格式的合成协议正文'));
    assert.doesNotMatch(popup.textContent,/unsafe\(\)/);
    assert.equal(p.calls.length,0,'a reading link must not implicitly save, quote or accept');
    await React.act(async()=>[...popup.querySelectorAll('button')].find(b=>b.textContent==='返回上架须知').click());
    await p.waitFor(()=>!p.window.document.querySelector('.publish-agreement-dialog'));
    assert.ok(p.window.document.querySelector('.publish-reading-dialog'));
    assert.equal(p.calls.length,0);
  } finally {await p.close();}
});

test("a saved quote with UNKNOWN confirmation still blocks leaving and unload", async () => {
  const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration({title:'quoted'}),{quote:ownerQuote}),confirm:()=>{throw new actualSupply.SupplyRequestError(0,{error:{code:'NETWORK_ERROR',message:'结果未知',requestId:'unknown-confirm'}})}});
  try {
    await p.render();
    await p.click('.publish-confirm input[type=checkbox]');
    await p.click('.publish-confirm button.button.primary');
    await p.waitFor(()=>p.text().includes('结果未知'));
    const unload=new p.window.Event('beforeunload',{cancelable:true});p.window.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented,true,'saved declaration must not disable an unresolved-write guard');
    const link=p.window.document.createElement('a');link.href='/accounts';link.textContent='leave';p.host.append(link);
    p.window.document.addEventListener('click',e=>e.preventDefault(),{once:true});
    await React.act(async()=>link.click());
    await p.waitFor(()=>p.window.document.querySelector('[role="alertdialog"]'));
    const dialog=p.window.document.querySelector('[role="alertdialog"]');assert.ok(dialog);
    assert.match(dialog.textContent,/上次操作结果仍待确认/);
    assert.equal(dialog.querySelector('button.button.primary').disabled,true);
    assert.equal(p.calls.filter(c=>c.op==='confirm').length,1);
  } finally {await p.close();}
});

test("pending confirmation cannot leave before its result, without a dirty declaration", async () => {
  let rejectPending;
  const pending=new Promise((resolve,reject)=>{rejectPending=reject;});
  const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration({title:'quoted'}),{quote:ownerQuote}),confirm:()=>pending});
  try {
    await p.render();await p.click('.publish-confirm input[type=checkbox]');await p.click('.publish-confirm button.button.primary');
    await p.waitFor(()=>p.calls.some(c=>c.op==='confirm'));
    const link=p.window.document.createElement('a');link.href='/accounts';link.textContent='leave';p.host.append(link);
    p.window.document.addEventListener('click',e=>e.preventDefault(),{once:true});await React.act(async()=>link.click());
    await p.waitFor(()=>p.window.document.querySelector('[role="alertdialog"]'));
    const dialog=p.window.document.querySelector('[role="alertdialog"]');assert.ok(dialog);
    assert.match(dialog.textContent,/当前操作尚未完成/);assert.equal(dialog.querySelector('button.button.primary').disabled,true);
    const unload=new p.window.Event('beforeunload',{cancelable:true});p.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  } finally {
    await React.act(async()=>rejectPending(new actualSupply.SupplyRequestError(0,{error:{code:'NETWORK_ERROR',message:'结果未知',requestId:'pending-confirm'}})));
    await p.close();
  }
});

test("UNKNOWN navigation guard remains visible while private fields are hidden for identity failure", async () => {
  const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration({title:'quoted'}),{quote:ownerQuote}),confirm:()=>{throw new actualSupply.SupplyRequestError(0,{error:{code:'NETWORK_ERROR',message:'结果未知',requestId:'paused-confirm'}})}});
  try {
    await p.render();await p.click('.publish-confirm input[type=checkbox]');await p.click('.publish-confirm button.button.primary');await p.waitFor(()=>p.text().includes('结果未知'));
    await React.act(async()=>{p.session.status='error';p.notifyIdentity();});
    await p.waitFor(()=>p.host.querySelector('.publish-groups')===null);
    assert.equal(p.host.querySelector('.publish-groups'),null);
    const link=p.window.document.createElement('a');link.href='/accounts';link.textContent='leave';p.host.append(link);
    p.window.document.addEventListener('click',e=>e.preventDefault(),{once:true});await React.act(async()=>link.click());
    await p.waitFor(()=>p.window.document.querySelector('[role="alertdialog"]'));
    const dialog=p.window.document.querySelector('[role="alertdialog"]');assert.ok(dialog,'identity gate must retain the generic recovery guard');
    assert.match(dialog.textContent,/上次操作结果仍待确认/);assert.equal(dialog.querySelector('button.button.primary').disabled,true);
    assert.equal(p.calls.filter(c=>c.op==='confirm').length,1);
  } finally {await p.close();}
});

test("a guest recheck preserves UNKNOWN context and same-user recovery uses the original confirmation key", async () => {
  let attempts=0;
  const saved=supplyOf(declaration({title:'quoted'}),{quote:ownerQuote});
  const p=await probe({accountId:'account_1',mine:()=>saved,confirm:()=>{if(++attempts===1)throw new actualSupply.SupplyRequestError(0,{error:{code:'NETWORK_ERROR',message:'结果未知',requestId:'guest-confirm'}});return saved;}});
  try {
    await p.render();await p.click('.publish-confirm input[type=checkbox]');await p.click('.publish-confirm button.button.primary');await p.waitFor(()=>p.text().includes('结果未知'));
    const navigationCount=p.navigationCalls.length,first=p.calls.find(c=>c.op==='confirm');
    await React.act(async()=>{p.session.status='guest';p.session.userId=null;p.notifyIdentity();});
    await p.waitFor(()=>p.host.querySelector('.publish-groups')===null);
    assert.equal(p.navigationCalls.length,navigationCount,'a guest recheck must not unmount the original intent by redirecting');
    assert.equal(p.host.querySelector('.publish-groups'),null);
    assert.match(p.text(),/登录状态已失效/);
    await React.act(async()=>{p.session.status='authenticated';p.session.userId='user_A';p.notifyIdentity();});
    await p.waitFor(()=>p.host.querySelector('.publish-groups'));
    await p.clickButton('重试当前步骤');await p.waitFor(()=>p.calls.filter(c=>c.op==='confirm').length===2);
    const second=p.calls.filter(c=>c.op==='confirm')[1];assert.equal(second.key,first.key);assert.deepEqual(second.body,first.body);
  } finally {await p.close();}
});

test("all-day choice saves explicit bounds and returning to a time window restores the same draft", async () => {
  const attrs={...declaration().attributes,service_window_start_minute:1320,service_window_end_minute:120,service_window_timezone:"Asia/Shanghai",service_window_cross_midnight:true};
  const p=await probe({accountId:"account_1",mine:()=>supplyOf(declaration({attributes:attrs}))});
  try {
    await p.render();
    assert.match(p.text(),/22:00 至 次日 02:00/);
    await p.click('[aria-label="可配合上号时间"] .form-radio-choice:first-of-type .form-radio-control');
    await p.waitFor(()=>p.text().includes("全天可配合 · 00:00 至 24:00"));
    assert.equal(p.host.querySelector('[aria-label="开始时间"]'),null);
    await p.clickButton("保存草稿");
    await p.waitFor(()=>p.calls.filter(call=>call.op==="saveDraft").length===1);
    const allDay=p.calls.find(call=>call.op==="saveDraft").body.attributes;
    assert.equal(allDay.service_window_start_minute,0);
    assert.equal(allDay.service_window_end_minute,1440);
    assert.equal(allDay.service_window_cross_midnight,false);
    assert.equal(allDay.service_window_timezone,"Asia/Shanghai");
    await p.click('[aria-label="可配合上号时间"] .form-radio-choice:last-of-type .form-radio-control');
    await p.waitFor(()=>p.text().includes("22:00 至 次日 02:00"));
    await p.clickButton("保存草稿");
    await p.waitFor(()=>p.calls.filter(call=>call.op==="saveDraft").length===2);
    const restored=p.calls.filter(call=>call.op==="saveDraft")[1].body.attributes;
    assert.equal(restored.service_window_start_minute,1320);
    assert.equal(restored.service_window_end_minute,120);
    assert.equal(restored.service_window_cross_midnight,true);
  } finally { await p.close(); }
});

test("an unknown save keeps the frozen intent, blocks edits and replays the same key after retry", async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ title: "before" })),
    saveDraft: (body, key, calls) => {
      if (calls.filter((call) => call.op === "saveDraft").length === 1) throw new actualSupply.SupplyRequestError(0, null, key);
      return supplyOf(body);
    },
  });
  try {
    await p.render();
    assert.match(p.text(), /账号能力/);
    await p.type('textarea[placeholder*="使用说明"]', "edited-after-unknown");
    await p.clickButton("保存草稿");
    await p.waitFor(() => p.text().includes("结果未知"));
    assert.match(p.text(), /结果未知/);
    const noteInput = p.host.querySelector('textarea[placeholder*="使用说明"]');
    assert.equal(noteInput.disabled, true, "fields freeze while the write result is unknown");
    await p.type('textarea[placeholder*="使用说明"]', "changed-during-unknown");
    const saves = p.calls.filter((call) => call.op === "saveDraft");
    assert.equal(saves.length, 1);
    await p.clickButton("重试当前步骤");
    await p.waitFor(() => p.text().includes("草稿已保存"));
    const retried = p.calls.filter((call) => call.op === "saveDraft");
    assert.equal(retried.length, 2);
    assert.equal(retried[1].key, saves[0].key, "the retry replays the original idempotency key");
    assert.deepEqual(retried[1].body, saves[0].body, "the retry replays the frozen body");
    assert.equal(retried[1].body.description, "edited-after-unknown", "edits during the unknown window never enter the frozen intent");
    assert.doesNotMatch(p.text(), /结果未知/);
    assert.match(p.text(), /草稿已保存/);
  } finally {
    await p.close();
  }
});

test("a 401 pauses and hides private fields, then the same identity resumes the receipt", async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ title: "before" })),
    saveDraft: (body, key, calls) => {
      if (calls.filter((call) => call.op === "saveDraft").length === 1) throw new actualSupply.SupplyRequestError(401, { error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: "req_401" } }, key);
      return supplyOf(body);
    },
  });
  try {
    await p.render();
    await p.clickButton("保存草稿");
    await p.waitFor(() => p.text().includes("登录状态已失效"));
    assert.match(p.text(), /登录状态已失效/);
    assert.equal(p.host.querySelector(".publish-groups"), null, "private projections stay hidden while identity is unconfirmed");
    await p.clickButton("重新确认身份");
    assert.equal(p.session.revalidations, 1);
    await p.waitFor(() => p.text().includes("结果未知"));
    assert.match(p.text(), /结果未知/);
    await p.clickButton("重试当前步骤");
    await p.waitFor(() => p.text().includes("草稿已保存"));
    assert.match(p.text(), /草稿已保存/);
    assert.equal(p.calls.filter((call) => call.op === "saveDraft").length, 2);
  } finally {
    await p.close();
  }
});

test("a 409 invalidates the quote and the agreement before any new confirmation", async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ title: "quoted" }), { quote: ownerQuote }),
    confirm: () => { throw new actualSupply.SupplyRequestError(409, { error: { code: "CONFLICT", message: "资料或规则已变化，请重新预览确认", requestId: "req_409" } }); },
  });
  try {
    await p.render();
    assert.match(p.text(), /确认上架/);
    await p.click(".publish-confirm input[type=checkbox]");
    await p.click(".publish-confirm button.button.primary");
    await p.waitFor(() => p.text().includes("资料状态已变化"));
    assert.equal(p.host.querySelector(".publish-confirm button.button.primary"), null, "the stale quote is cleared, so no confirm action remains");
    assert.match(p.text(), /资料状态已变化/);
    const checkbox = p.host.querySelector(".publish-confirm input[type=checkbox]");
    assert.equal(checkbox, null, "the agreement is reset");
    assert.equal(p.calls.some((call) => call.op === "confirm" && call.action === "submit"), false, "no submit was attempted after the conflict");
  } finally {
    await p.close();
  }
});

test("the fast entry converts an ordinary draft to a fast declaration before saving", async () => {
  const p = await probe({
    mode: "fast",
    accountId: "account_1",
    options: optionsV2,
    mine: () => supplyOf(declaration({ title: "saved ordinary", attributes: { ...declaration().attributes, rentalPricing: { rentalMode: "ordinary" } } })),
  });
  try {
    await p.render();
    await p.waitFor(() => p.text().includes("已按极速入口切换为极速比例"));
    assert.match(p.text(), /极速比例/);
    assert.match(p.text(), /已按极速入口切换为极速比例/);
    await p.type('input[aria-label="兑换比例"]', "48");
    await p.clickButton("保存草稿");
    const save = p.calls.filter((call) => call.op === "saveDraft").at(-1);
    assert.deepEqual(save.body.attributes.rentalPricing, { rentalMode: "fast", ownerRatioB: "48" });
    assert.equal(save.body.pricingOptionCode, "");
  } finally {
    await p.close();
  }
});

test("a disabled fast mode and a v1 rule both refuse to pretend fast pricing", async () => {
  const disabledFast = await probe({
    mode: "fast", accountId: "account_1", options: optionsV2NoFast,
    mine: () => supplyOf(declaration({ title: "fast draft" })),
  });
  try {
    await disabledFast.render();
    assert.match(disabledFast.text(), /极速比例当前未启用/);
    await disabledFast.type('input[aria-label$="（M）"]', "60");
    await disabledFast.clickButton("核对报价");
    assert.match(disabledFast.text(), /当前规则未启用极速比例/);
    assert.equal(disabledFast.calls.some((call) => call.op === "quote"), false);
  } finally {
    await disabledFast.close();
  }
  const v1Fast = await probe({
    mode: "fast", accountId: "account_1", options: optionsV1,
    mine: () => supplyOf(declaration({ title: "fast draft" })),
  });
  try {
    await v1Fast.render();
    assert.match(v1Fast.text(), /极速入口当前不可用/);
    await v1Fast.type('input[aria-label$="（M）"]', "60");
    await v1Fast.clickButton("核对报价");
    assert.match(v1Fast.text(), /当前规则未开放极速比例合同/);
    assert.equal(v1Fast.calls.some((call) => call.op === "quote"), false);
  } finally {
    await v1Fast.close();
  }
});

test("viewing the deposit recommendation saves first, never auto-applies, and adoption is explicit", async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ title: "recommend target" })),
    saveDraft: (body) => supplyOf(body, { revision: "6", versionRevision: "2" }),
    depositRecommendation: () => ({
      available: true, amountCents: "30000", minCents: "1", fullPayoutMinCents: "30000", capCents: "100000",
      policyVersion: "p1", accountId: "account_1", accountRevision: "6", versionId: "version_1", versionRevision: "2",
      ruleReleaseId: "release_1", priceVersionId: "price_1",
      inputs: { safeBoxCode: null, vitality: null, bear: null, dive: null, skinIds: [] },
    }),
  });
  try {
    await p.render();
    await p.type('textarea[placeholder*="使用说明"]', "recommend target edited");
    await p.clickButton("查看推荐押金");
    await p.waitFor(() => p.text().includes("推荐 300.00"));
    const order = p.calls.map((call) => call.op);
    assert.ok(order.indexOf("saveDraft") >= 0 && order.indexOf("saveDraft") < order.indexOf("depositRecommendation"), "the recommendation is computed from the saved draft");
    const deposit = p.host.querySelector('input[placeholder="填写押金金额"]');
    assert.equal(deposit.value, "", "viewing must not overwrite the deposit declaration");
    assert.match(p.text(), /推荐 300.00 元/);
    await p.clickButton("采用推荐");
    await p.waitFor(() => p.host.querySelector('input[placeholder="填写押金金额"]').value === "300.00");
    assert.equal(p.host.querySelector('input[placeholder="填写押金金额"]').value, "300.00", "adoption is the only path that fills the declaration");
    assert.match(p.text(), /已采用推荐/);
    await p.type('textarea[placeholder*="使用说明"]', "changed again");
    await p.waitFor(() => p.text().includes("已过期"));
    assert.match(p.text(), /已过期/);
    const adopt = [...p.host.querySelectorAll("button")].find((button) => (button.textContent ?? "").includes("采用推荐"));
    assert.equal(adopt.disabled, true, "a stale recommendation cannot be adopted");
  } finally {
    await p.close();
  }
});

test("the haff M input converts exactly and only the six-level bullet shows the bundle hint", async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ title: "units" })),
  });
  try {
    await p.render();
    const haff = p.inputByLabel("哈夫币数量");
    assert.ok(haff, "haff uses an M input");
    await p.type('input[aria-label$="（M）"]', "60.5");
    await p.waitFor(() => p.text().includes("= 60,500,000 哈夫币"));
    assert.match(p.text(), /= 60,500,000 哈夫币/);
    await p.type('input[aria-label$="六级子弹数量"]', "2");
    await p.waitFor(() => p.text().includes("1组 = 60发"));
    assert.match(p.text(), /1组 = 60发/);
    assert.equal(p.host.querySelector('#quantity-item_round').value,'2');
    await p.type('input[aria-label$="六级子弹数量"]', "3");
    assert.equal(p.host.querySelector('#quantity-item_round').value,'3');
  } finally {
    await p.close();
  }
});

test("a generic old-state GET cannot resolve or overwrite an unknown write", async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ title: "old-server-value" })),
    saveDraft: (body, key) => { throw new actualSupply.SupplyRequestError(0, null, key); },
  });
  try {
    await p.render();
    await p.type('textarea[placeholder*="使用说明"]', "pending-new-value");
    await p.clickButton("保存草稿");
    await p.waitFor(() => p.text().includes("结果未知"));
    await p.clickButton("重新读取最新状态");
    const desc = p.host.querySelector('textarea[placeholder*="使用说明"]');
    assert.equal(desc.disabled, true, "old GET is not evidence that the original write failed or finished");
    assert.equal(desc.value, "pending-new-value", "the pending input is not overwritten by a generic read");
    assert.match(p.text(), /结果未知/);
    await p.clickButton("重试当前步骤");
    await p.waitFor(() => p.text().includes("结果未知"));
    assert.equal(p.host.querySelector('textarea[placeholder*="使用说明"]').disabled, true, "a still-unknown retry keeps the lock");
    assert.equal(p.calls.filter((call) => call.op === "saveDraft").length, 2);
  } finally {
    await p.close();
  }
});

test("a recommendation response with a foreign binding or inputs cannot be adopted", async () => {
  const cases = [
    { name: "foreign account/version", patch: { accountId: "other_account", accountRevision: "999", versionId: "other_version", versionRevision: "999" } },
    { name: "another device bumped the account revision", patch: { accountRevision: "7" } },
    { name: "rule release changed", patch: { ruleReleaseId: "release_2" } },
    { name: "version revision changed", patch: { versionRevision: "9" } },
    { name: "inputs differ from the saved snapshot", patch: { inputs: { safeBoxCode: "foreign", vitality: 7, bear: 7, dive: 3, skinIds: [] } } },
  ];
  for (const item of cases) {
    const p = await probe({
      accountId: "account_1",
      mine: () => supplyOf(declaration({ title: "target" })),
      depositRecommendation: () => ({
        available: true, amountCents: "30000", minCents: "1", fullPayoutMinCents: "30000", capCents: "100000",
        policyVersion: "p1", accountId: "account_1", accountRevision: "5", versionId: "version_1", versionRevision: "1",
        ruleReleaseId: "release_1", priceVersionId: "price_1",
        inputs: { safeBoxCode: null, vitality: null, bear: null, dive: null, skinIds: [] },
        ...item.patch,
      }),
    });
    try {
      await p.render();
      await p.clickButton("查看推荐押金");
      await p.waitFor(() => p.text().includes("不匹配"));
      const adopt = [...p.host.querySelectorAll("button")].find((button) => (button.textContent ?? "").includes("采用推荐"));
      assert.equal(!adopt || adopt.disabled, true, `${item.name}: response identity/version must match the request snapshot before adoption`);
      assert.match(p.text(), /不匹配/);
    } finally {
      await p.close();
    }
  }
});

test("a matching recommendation is adoptable and becomes stale after further edits", async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ title: "target" })),
    depositRecommendation: () => ({
      available: true, amountCents: "30000", minCents: "1", fullPayoutMinCents: "30000", capCents: "100000",
      policyVersion: "p1", accountId: "account_1", accountRevision: "5", versionId: "version_1", versionRevision: "1",
      ruleReleaseId: "release_1", priceVersionId: "price_1",
      inputs: { safeBoxCode: null, vitality: null, bear: null, dive: null, skinIds: [] },
    }),
  });
  try {
    await p.render();
    await p.clickButton("查看推荐押金");
    await p.waitFor(() => p.text().includes("推荐 300.00 元（依据当前版本资料）"));
    const adopt = [...p.host.querySelectorAll("button")].find((button) => (button.textContent ?? "").includes("采用推荐"));
    assert.equal(adopt.disabled, false, "a matching recommendation can be adopted");
    await p.clickButton("采用推荐");
    await p.waitFor(() => p.host.querySelector('input[placeholder="填写押金金额"]').value === "300.00");
    await p.type('textarea[placeholder*="使用说明"]', "changed after adoption");
    await p.waitFor(() => p.text().includes("已过期"));
    assert.match(p.text(), /已过期/);
  } finally {
    await p.close();
  }
});

test("timed entitlement calendar preserves Beijing time through save without a native date input", async () => {
  const entitlement = {id:"ent_1",name:"安全箱体验卡",valueKind:"FLAG",expiryKind:"TIMED"};
  const declared = declaration({entitlements:[{entitlementId:"ent_1",value:true,expiryKnowledge:"KNOWN",expiresAt:"2026-10-05T16:00:00.000Z"}]});
  const p = await probe({accountId:"account_1",catalogValue:{...catalog,entitlements:[entitlement]},mine:()=>supplyOf(declared)});
  try {
    await p.render();
    assert.equal(p.host.querySelector('input[type="datetime-local"],input[type="date"]'),null);
    await p.click('button[aria-label="安全箱体验卡有效期至日期"]');
    const day = [...p.window.document.querySelectorAll('.form-calendar .rdp-day_button')].find(button=>button.textContent==='7');
    assert(day);
    await React.act(async()=>day.dispatchEvent(new p.window.MouseEvent('click',{bubbles:true})));
    await p.clickButton("保存草稿");
    const saved=p.calls.find(call=>call.op==='saveDraft');
    assert.equal(saved.body.entitlements[0].expiresAt,"2026-10-06T16:00:00.000Z");
  } finally {await p.close();}
});

test("quote help explains gross income without opening terms or consenting", async () => {
  const p = await probe({accountId:"account_1", mine:()=>({...supplyOf(declaration({title:"quoted"}), {quote:ownerQuote}),blockers:["PUBLICATION_REQUIRED","CONFIRMATION_OR_MEDIA_REQUIRED"]})});
  try {
    await p.render();
    assert.doesNotMatch(p.text(), /公开发布事实尚未形成/);
    await p.click('button[aria-label="查看出租报价说明"]');
    await p.waitFor(() => p.window.document.querySelector('[role="tooltip"]'));
    assert.match(p.window.document.querySelector('[role="tooltip"]').textContent,/押金不计入收入/);
    assert.equal(p.host.querySelector(".publish-terms").open,false);
    assert.equal(p.host.querySelector(".publish-confirm input").checked,false);
    assert.equal(p.calls.some(c=>c.op==="confirm"),false);
    assert.equal(p.host.querySelectorAll("h2.publish-group-title").length,4);
    assert.equal(p.host.querySelector('[aria-label="编辑账号资料"]'),null);
    assert.equal(p.host.querySelectorAll('[data-publish-group][hidden]').length,0);
  } finally { await p.close(); }
});

test("unsupplied title does not block quote and missing inventory locates the inventory group", async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ title: "", inventory: [] })),
  });
  try {
    await p.render();
    await p.clickButton("核对报价");
    assert.match(p.text(), /请先填写必填资源数量/);
    assert.equal(p.calls.some((c) => c.op === "quote"), false);
  } finally {
    await p.close();
  }
});

test("unsupplied title successfully quotes when declaration is complete", async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ title: "", inventory: [{ itemId: "item_haff", quantity: "60000000" }] })),
  });
  try {
    await p.render();
    await p.clickButton("核对报价");
    assert.equal(p.calls.some((c) => c.op === "quote"), true);
    assert.match(p.text(), /报价已更新/);
  } finally {
    await p.close();
  }
});

test("account disclosures and compensation require an explicit choice, without defaulting unknown to false", async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    const radios = p.host.querySelectorAll('.supply-radio-field:not(.publish-choice-field) [role="radio"]');
    assert.equal(radios.length, 4);
    assert.doesNotMatch(p.host.querySelector(".publish-vitality-field")?.textContent ?? "", /未申报/);
    assert.doesNotMatch(p.host.querySelector(".publish-bear-field")?.textContent ?? "", /未申报/);
    assert.doesNotMatch(p.host.querySelector(".publish-dive-field")?.textContent ?? "", /未申报/);
    assert.match(p.host.querySelector(".publish-vitality-field")?.textContent ?? "", /4级/);
    assert.match(p.host.querySelector(".publish-bear-field")?.textContent ?? "", /7级/);
    assert.match(p.host.querySelector(".publish-dive-field")?.textContent ?? "", /0级/);
    for (const radio of radios) {
      assert.equal(radio.getAttribute("aria-checked"), "false");
    }
    await p.click('[role="radio"]');
    assert.equal(p.host.querySelector('[role="radio"]').getAttribute("aria-checked"), "true");
    assert.equal(p.calls.some(call => call.op === "saveDraft"), false);
  } finally {
    await p.close();
  }
});


test("legacy agreement markup renders readable inert text while retaining the original body", async () => {
  const body='<h3>真实条款</h3><p>请阅读<strong>条件</strong>。</p><table><tr><td>物品</td><td>金额</td></tr></table><script>bad()</script>';
  const data={...supplyOf(declaration({title:"agreement"}),{quote:ownerQuote}),agreement:{...optionsV1.agreement,body}};
  const p=await probe({accountId:"account_1",mine:()=>data});
  try {await p.render();const node=p.host.querySelector('.publish-terms-body');assert.match(node.textContent,/真实条款\n请阅读条件/);assert.match(node.textContent,/物品\t金额/);assert.doesNotMatch(node.textContent,/<h3>|bad/);assert.equal(node.querySelector('script'),null);assert.equal(data.agreement.body,body);}finally{await p.close();}
});

test("inventory stepper rejects fractional or negative input, maps groups once, and haff invalid input cannot save",async()=>{
  const p=await probe({accountId:"account_1",mine:()=>supplyOf(declaration())});
  try{
    await p.render();
    for(const raw of ["1.5","-5","abc"]){
      await p.type('#quantity-item_round',raw);
      assert.equal(p.host.querySelector('#quantity-item_round').value,"");
    }
    await p.type('#quantity-item_round','2');
    await p.clickButton('保存草稿');
    assert.equal(p.calls.find(call=>call.op==='saveDraft').body.inventory.find(row=>row.itemId==='item_round').quantity,'120');
    const count=p.calls.length;
    await p.type('input[aria-label="哈夫币数量（M）"]','-5');
    assert.equal(p.host.querySelector('input[aria-label="哈夫币数量（M）"]').value,'-5');
    await p.clickButton('保存草稿');assert.equal(p.calls.length,count);
  }finally{await p.close();}
});

test("new inventory fields hold unresolved code quantities without fabricating IDs, and account level rejects non-integers",async()=>{
  const p=await probe({accountId:"account_1",mine:()=>supplyOf(declaration())});
  try{await p.render();
    for(const raw of ['abc','1.5','61']){await p.type('input[aria-label="账号等级"]',raw);assert.equal(p.host.querySelector('input[aria-label="账号等级"]').value,'');}
    await p.type('input[aria-label="账号等级"]','60');assert.equal(p.host.querySelector('input[aria-label="账号等级"]').value,'60');
    await p.type('input[aria-label="巴雷特子弹数量"]','2');await p.type('input[aria-label="顶级保险卡数量"]','3');
    await p.clickButton('保存草稿');assert.equal(p.calls.some(c=>c.op==='saveDraft'),false);assert.match(p.text(),/数量已保留在本页/);
    assert.doesNotMatch(p.text(),/暂不可填写/);
  }finally{await p.close();}
});

test("payout rules are readable before quote and reading does not consent or send a write",async()=>{
  const p=await probe({accountId:"account_1",mine:()=>supplyOf(declaration())});
  try{await p.render();await p.clickButton('查看赔付规则');assert.equal(p.host.querySelector('#publish-payout-rules').open,true);assert.equal(p.window.document.activeElement,p.host.querySelector('#publish-payout-rules summary'));assert.equal(p.calls.length,0);assert.match(p.text(),/8%/);}finally{await p.close();}
});

test("catalog changes invalidate a quote and consent without overwriting the declaration",async()=>{
  let revision='1';
  const p=await probe({accountId:"account_1",catalogValue:()=>({...catalog,game:{...catalog.game,catalogRevision:revision}}),mine:()=>supplyOf(declaration({description:'keep me'}),{quote:{...ownerQuote,catalogRevision:'1'}})});
  try{await p.render();assert.match(p.text(),/报价已取得/);revision='2';await p.type('.skin-search-input','skin');const input=p.host.querySelector('.skin-search-input');await React.act(async()=>input.dispatchEvent(new p.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));await p.waitFor(()=>p.text().includes('报价已过期'));assert.match(p.text(),/报价已过期/);assert.equal(p.host.querySelector('#publish-description').value,'keep me');assert.equal(p.calls.length,0);}finally{await p.close();}
});

test("new Barrett/card inputs save their own IDs and an old DAY row is excluded only by explicit choice",async()=>{
  const items=[...catalog.items,{id:'item_barrett',code:'df_billable_barrett_bullet',name:'巴雷特子弹',unit:'ROUND',quantityScale:0,required:false},{id:'item_card',code:'top_insure_card_piece',name:'顶级保险卡',unit:'PIECE',quantityScale:0,required:false}];
  const original=declaration({inventory:[{itemId:'item_haff',quantity:'60000000'},{itemId:'old_day',quantity:'3'}]});
  const saved=supplyOf(original);saved.version.catalogItems.push({id:'old_day',code:'df_billable_top_insure_card',name:'旧保险天数',unit:'DAY',priced:false});
  const p=await probe({accountId:'account_1',catalogValue:{...catalog,items},mine:()=>saved});
  try{
    await p.render();
    assert.match(p.text(),/旧保险天数/);
    assert.equal(p.host.querySelector('#quantity-old_day').value,'3');
    await p.type('#quantity-item_barrett','2');await p.type('#quantity-item_card','4');
    await p.clickButton('不纳入本次申报');await p.clickButton('保存草稿');
    const body=p.calls.find(call=>call.op==='saveDraft').body;
    assert.equal(body.inventory.find(row=>row.itemId==='item_barrett').quantity,'2');
    assert.equal(body.inventory.find(row=>row.itemId==='item_card').quantity,'4');
    assert.equal(body.inventory.some(row=>row.itemId==='old_day'),false);
    assert.equal(original.inventory.find(row=>row.itemId==='old_day').quantity,'3');
  }finally{await p.close();}
});

test("gross owner income excludes declared deposits and never pre-deducts a flat payout fee",async()=>{
  const attrs={...declaration().attributes,rentalPricing:{rentalMode:'ordinary'},owner_deposit_declaration:{schema:'owner-deposit-declaration-v1',amountCents:'30000',declarationVersion:'1'},full_payout_declaration:{schema:'full-payout-declaration-v1',selected:true}};
  const p=await probe({accountId:'account_1',options:optionsV2,mine:()=>supplyOf(declaration({attributes:attrs}),{schemaVersion:2,quote:{...ownerQuote,schemaVersion:2,rentalMode:'ordinary',ownerHaffRatio:'50',publisherBailRequirement:{currency:'CNY',unit:'yuan',amount:'0.00',scale:2}}})});
  try{await p.render();assert.equal(p.host.querySelector('[aria-label="预计收入合计"]').textContent,'120.00 元');assert.match(p.host.querySelector('.publish-rail-deposits').textContent,/300.00 元/);assert.doesNotMatch(p.host.querySelector('.publish-rail-deposits').textContent,/发布保证金/);assert.match(p.host.querySelector('[aria-label="普通兑换比例"]').textContent,/50 万哈夫币/);assert.equal(p.host.querySelector('.publish-confirm input').checked,false);assert.equal(p.calls.length,0);}finally{await p.close();}
});

test("an explicit positive server publisher requirement remains separate from income",async()=>{
  const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration(),{quote:{...ownerQuote,publisherBailRequirement:{currency:'CNY',unit:'yuan',amount:'80.00',scale:2}}})});
  try{await p.render();assert.equal(p.host.querySelector('[aria-label="预计收入合计"]').textContent,'120.00 元');assert.match(p.host.querySelector('.publish-rail-deposits').textContent,/发布保证金.*80.00 元/);assert.equal(p.calls.length,0);}finally{await p.close();}
});

test("penalty upload requires an explicit ban disclosure, while existing bindings remain manageable",async()=>{
  const binding={assetId:'penalty_1',position:0,category:'PENALTY',purpose:'ACCOUNT_DISPLAY'};
  const original=declaration({mediaBindings:[binding]});
  const p=await probe({accountId:'account_1',mine:()=>supplyOf(original)});
  try{
    await p.render();
    assert.equal(p.host.querySelector('input[aria-label="上传封禁记录截图"]'),null);
    assert.ok(p.host.querySelector('input[aria-label="上传账号展示图"]'));
    assert.match(p.host.querySelector('.publish-retained-media summary').textContent,/已保留 1 张/);
    await p.click('[aria-label="封禁记录"] .form-radio-choice:last-of-type .form-radio-control');
    assert.ok(p.host.querySelector('input[aria-label="上传封禁记录截图"]'));
    await p.click('[aria-label="封禁记录"] .form-radio-choice:first-of-type .form-radio-control');
    assert.equal(p.host.querySelector('input[aria-label="上传封禁记录截图"]'),null);
    await p.clickButton('保存草稿');
    const saved=p.calls.find(call=>call.op==='saveDraft');
    assert.equal(saved.body.attributes.ban_record,false);
    assert.equal(saved.body.mediaBindings.length,1);
    assert.equal(saved.body.mediaBindings[0].assetId,'penalty_1');
    assert.equal(saved.body.mediaBindings[0].category,'PENALTY');
    assert.deepEqual(original.mediaBindings,[binding]);
  }finally{await p.close();}
});

test("unsupported images fail locally without a broken preview or a futile retry",async()=>{
  const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration())});
  try{
    await p.render();const input=p.host.querySelector('input[aria-label="上传账号展示图"]');
    const file=new p.window.File(['local ui check'],'invalid-format.txt',{type:'text/plain'});
    Object.defineProperty(input,'files',{configurable:true,value:[file]});
    await React.act(async()=>input.dispatchEvent(new p.window.Event('change',{bubbles:true})));
    await p.waitFor(()=>p.host.querySelector('.supply-media-row'));
    assert.match(p.host.querySelector('.supply-media-row').textContent,/invalid-format.txt/);
    assert.ok(p.host.querySelector('.supply-media-row [role="alert"]'));
    assert.equal(p.host.querySelector('.supply-media-preview img'),null);
    assert.equal([...p.host.querySelectorAll('.supply-media-actions button')].some(button=>button.textContent==='重试'),false);
    assert.equal(p.calls.length,0);
  }finally{await p.close();}
});
