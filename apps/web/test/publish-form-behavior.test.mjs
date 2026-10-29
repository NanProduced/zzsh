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

test("session feedback: pending identity uses the form skeleton without private data or writes", async () => {
  const p = await probe();
  p.session.status = "loading";
  try {
    await p.render();
    assert.ok(p.host.querySelector('.session-loading[data-layout="form"]'));
    assert.equal(p.host.querySelector('.publish-groups'), null);
    assert.equal(p.host.querySelector('.account-guest'), null);
    assert.equal(p.host.querySelector('[role="alert"]'), null);
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});

test("session feedback: a confirmed guest never stays in the loading skeleton", async () => {
  const p = await probe({ userId: null });
  p.session.status = "guest";
  try {
    await p.render();
    assert.match(p.text(), /登录后即可出租账号/);
    assert.equal(p.host.querySelector('.session-loading'), null);
    assert.equal(p.host.querySelector('.publish-groups'), null);
    assert.ok(p.host.querySelector('.session-recovery a[href^="/login?next="]'));
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});

test("session feedback: a failed read offers read-only retry and returns to loading", async () => {
  const p = await probe();
  p.session.status = "error";
  try {
    await p.render();
    assert.match(p.text(), /暂时无法加载上架资料/);
    assert.equal(p.host.querySelector('.session-loading'), null);
    assert.equal(p.host.querySelectorAll('[role="alert"]').length, 1);
    assert.doesNotMatch(p.text(), /刚才填写的内容仍保留/);
    await p.click('.session-recovery button');
    assert.equal(p.session.revalidations, 1);
    assert.equal(p.calls.length, 0, "retry never saves, quotes, accepts or submits");
    await React.act(async () => { p.session.status = "loading"; p.notifyIdentity(); });
    assert.ok(p.host.querySelector('.session-loading'));
    assert.equal(p.host.querySelector('.session-recovery'), null);
  } finally { await p.close(); }
});

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
const options03C = { ...optionsV2, declarationOptions: {
  next_season_pass: { enabled: true, required: true, label: '下赛季通行证计划' },
  demulan_unlocked: { enabled: true, required: true, label: '是否已解锁德穆兰' },
  info_source: { enabled: true, required: false, optionsState: 'CONFIGURED', acceptsLegacyText: true, options: [{ name: '合成渠道A', value: 'a' }, { name: '合成渠道B', value: 'b' }] },
} };
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

function resourceEstimate({ quantity = "60", amount = "12.34", total = amount, unpriced = [], unreported = [], revision = "1", release = "release_1" } = {}) {
  return {
    available: true, informationalOnly: true,
    binding: { gameId: "game_1", catalogRevision: revision, releaseId: release, releaseGeneration: "1", priceVersionId: "price_1" },
    lines: unpriced.includes("item_round") ? [] : [{ itemId: "item_round", code: "level6_round", name: "六级子弹", unit: "ROUND", unitQuantity: "60", quantity,
      ownerUnitAmount: { currency: "CNY", unit: "yuan", amount: "12.34", scale: 2 },
      ownerAmount: amount === null ? null : { currency: "CNY", unit: "yuan", amount, scale: 2 } }],
    ownerTotal: total === null ? null : { currency: "CNY", unit: "yuan", amount: total, scale: 2 },
    unpricedItemIds: unpriced, unreportedItemIds: unreported,
  };
}
const previewTick = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });

async function probe({ mode = "standard", accountId, editRequested = false, gameCode = "delta", options = optionsV1, catalogValue = catalog, mine, saveDraft, quote, confirm, fullPayoutTerms, depositRecommendation, resourceIncomePreview, ownerIncomePreview, readNotice = true, createAccount, createDraft, uploadMedia, userId = 'user_A', storageSeed, storageUnavailable = false } = {}) {
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
    resourceIncomePreview: async (...args) => resourceIncomePreview ? resourceIncomePreview(...args) : ({available:false,reason:"PREVIEW_UNAVAILABLE"}),
    ownerIncomePreview: async (gameId, input, signal) => {
      if (typeof ownerIncomePreview === "function") return ownerIncomePreview(gameId, input, signal);
      if (typeof resourceIncomePreview === "function") {
        const legacy = await resourceIncomePreview(gameId, input.inventory, { catalogRevision: input.catalogRevision, releaseId: input.releaseId }, signal);
        if (!legacy || !legacy.available) {
          return {
            schema: "owner-income-preview.v1",
            state: "UNAVAILABLE",
            binding: null,
            evaluatedAt: new Date().toISOString(),
            refreshAfter: new Date().toISOString(),
            rentalMode: null,
            ownerHaffRatioWanPerYuan: null,
            termSeconds: null,
            lines: [],
            ownerHaffIncome: null,
            ownerResourceIncome: null,
            knownResourceSubtotal: null,
            totalExpectedIncome: null,
            baseTenantDeposit: null,
            depositState: "UNAVAILABLE",
            missingFields: [],
            reasonCodes: [legacy?.reason ?? "PREVIEW_UNAVAILABLE"],
            unitAmountsInformational: true,
            estimateOnly: true,
            incomeBasis: "OWNER_RESOURCE_INCOME_BEFORE_FEES",
          };
        }
        return {
          schema: "owner-income-preview.v1",
          state: legacy.ownerTotal ? "READY" : "PARTIAL",
          binding: legacy.binding ? { ...legacy.binding, termVersionId: "term_1" } : null,
          evaluatedAt: new Date().toISOString(),
          refreshAfter: new Date().toISOString(),
          rentalMode: "ordinary",
          ownerHaffRatioWanPerYuan: "60",
          termSeconds: "864000",
          lines: (legacy.lines || []).map((l) => ({
            ...l,
            unitQuantity: l.unitQuantity ?? "1",
          })),
          ownerHaffIncome: { currency: "CNY", unit: "yuan", amount: "60.00", scale: 2 },
          ownerResourceIncome: legacy.ownerTotal,
          knownResourceSubtotal: legacy.ownerTotal,
          totalExpectedIncome: legacy.ownerTotal
            ? { currency: "CNY", unit: "yuan", amount: legacy.ownerTotal.amount, scale: 2 }
            : null,
          baseTenantDeposit: null,
          depositState: "INCOMPLETE",
          missingFields: [],
          reasonCodes: [],
          unitAmountsInformational: true,
          estimateOnly: true,
          incomeBasis: "OWNER_RESOURCE_INCOME_BEFORE_FEES",
        };
      }
      return {
        schema: "owner-income-preview.v1",
        state: "UNAVAILABLE",
        binding: null,
        evaluatedAt: new Date().toISOString(),
        refreshAfter: new Date().toISOString(),
        rentalMode: null,
        ownerHaffRatioWanPerYuan: null,
        termSeconds: null,
        lines: [],
        ownerHaffIncome: null,
        ownerResourceIncome: null,
        knownResourceSubtotal: null,
        totalExpectedIncome: null,
        baseTenantDeposit: null,
        depositState: "UNAVAILABLE",
        missingFields: [],
        reasonCodes: ["PREVIEW_UNAVAILABLE"],
        unitAmountsInformational: true,
        estimateOnly: true,
        incomeBasis: "OWNER_RESOURCE_INCOME_BEFORE_FEES",
      };
    },
    catalog: async (...args) => typeof catalogValue === "function" ? catalogValue(...args) : catalogValue,
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
    fullPayoutTerms: async (...args) => {
      calls.push({ op: "fullPayoutTerms", gameId: args[0], releaseId: args[1] });
      return fullPayoutTerms ? fullPayoutTerms(...args) : { releaseId: args[1], fullPayoutTerms: null };
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
    if (name === "../ui/information" || name === "../auth/session-loading") {
      const loadPresentation = (relative) => {
        const filename = path.join(tree, "apps/web/src/components", relative + ".tsx");
        const view = new Module(filename);
        view.filename = filename; view.paths = Module._nodeModulePaths(tree);
        view.require = dependency => dependency.endsWith(".css") ? {} : dependency === "../ui/information" ? loadPresentation("ui/information") : require(dependency);
        view._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
        return view.exports;
      };
      return loadPresentation(name === "../ui/information" ? "ui/information" : "auth/session-loading");
    }
    if (name === "../ui/form-controls") {
      const controlPath = path.join(tree, "apps/web/src/components/ui/form-controls.tsx");
      const controlModule = new Module(controlPath);
      controlModule.filename = controlPath; controlModule.paths = Module._nodeModulePaths(tree);
      controlModule.require = dependency => dependency.endsWith(".css") ? {} : require(dependency);
      controlModule._compile(ts.transpileModule(fs.readFileSync(controlPath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, controlPath);
      return controlModule.exports;
    }
    if (name === "../ui/alert-dialog") {
      const dialogPath = path.join(tree, "apps/web/src/components/ui/alert-dialog.tsx");
      const dialogModule = new Module(dialogPath);
      dialogModule.filename = dialogPath; dialogModule.paths = Module._nodeModulePaths(tree);
      dialogModule.require = dependency => dependency.endsWith(".css") ? {} : require(dependency);
      dialogModule._compile(ts.transpileModule(fs.readFileSync(dialogPath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, dialogPath);
      return dialogModule.exports;
    }
    if (name === "./skin-media-thumb") {
      const media = loadThumbModule();
      return { ...media, SkinMediaPreview: (props) => { skinPreviewObserver?.(props.skin); return React.createElement(media.SkinMediaPreview, props); } };
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
    async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); await window.happyDOM.close(); },
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

test("large ammo counts require one explicit check before saving and preserve base rounds", async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity: "1200" }] })) });
  const dialog = () => p.window.document.querySelector('[role="alertdialog"]');
  const clickDialog = async (label) => {
    const button = [...dialog().querySelectorAll('button')].find(node => node.textContent.includes(label));
    assert.ok(button, label);
    await React.act(async () => button.click());
    await p.waitFor(() => !dialog());
  };
  try {
    await p.render();
    await p.clickButton("保存草稿");
    assert.equal(dialog(), null, "20 groups do not need confirmation");
    assert.equal(p.calls.filter(call => call.op === "saveDraft").length, 1);
    await p.type('#quantity-item_round', '21');
    assert.match(p.host.querySelector('[data-resource-code="level6_round"]').textContent, /21组.*1260发/);
    await p.clickButton("保存草稿");
    assert.ok(await p.waitFor(dialog));
    assert.match(dialog().textContent, /21组.*1260发/s);
    assert.equal(p.calls.filter(call => call.op === "saveDraft").length, 1);
    await clickDialog("返回修改");
    assert.equal(p.calls.filter(call => call.op === "saveDraft").length, 1, "cancelling never writes");
    await p.clickButton("保存草稿");
    assert.ok(await p.waitFor(dialog));
    await clickDialog("确认数量");
    assert.ok(await p.waitFor(() => p.calls.filter(call => call.op === "saveDraft").length === 2));
    assert.equal(p.calls.at(-1).body.inventory.find(row => row.itemId === "item_round").quantity, "1260");
    await p.clickButton("保存草稿");
    assert.equal(dialog(), null, "an unchanged quantity is not repeatedly interrupted");
    await p.type('#quantity-item_round', '22');
    await p.type('#quantity-item_round', '21');
    await p.clickButton("保存草稿");
    assert.ok(await p.waitFor(dialog), "editing away and back invalidates the previous check");
  } finally { await p.close(); }
});

test("ammo check preserves historical remainder and is lost on remount", async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity: "1201" }] })) });
  try {
    await p.render();
    await p.clickButton("保存草稿");
    const dialog = () => p.window.document.querySelector('[role="alertdialog"]');
    assert.ok(await p.waitFor(dialog));
    assert.match(dialog().textContent, /20组.*1发.*1201发/s);
    await React.act(async () => [...dialog().querySelectorAll('button')].find(node => node.textContent.includes('确认数量')).click());
    assert.ok(await p.waitFor(() => p.calls.some(call => call.op === "saveDraft")));
    assert.equal(p.calls.find(call => call.op === "saveDraft").body.inventory[0].quantity, "1201");
    await p.remount();
    await p.clickButton("保存草稿");
    assert.ok(await p.waitFor(dialog), "restored drafts have no persisted confirmation");
  } finally { await p.close(); }
});

test("removing and readding an unpriced ammo row invalidates its confirmation", async () => {
  const p = await probe({ accountId: 'account_1',
    catalogValue: { ...catalog, items: catalog.items.map(item => item.id === 'item_round' ? { ...item, priced: false } : item) },
    mine: () => supplyOf(declaration({ inventory: [{ itemId: 'item_round', quantity: '1260' }] })) });
  const dialog = () => p.window.document.querySelector('.publish-ammo-dialog');
  try {
    await p.render(); await p.clickButton('保存草稿');
    assert.ok(await p.waitFor(dialog));
    await React.act(async () => [...dialog().querySelectorAll('button')].find(button => button.textContent.includes('确认数量')).click());
    assert.ok(await p.waitFor(() => p.calls.filter(call => call.op === 'saveDraft').length === 1));
    await p.clickButton('不纳入本次申报');
    assert.equal(p.host.querySelector('#quantity-item_round').value, '');
    await p.type('#quantity-item_round', '21'); await p.clickButton('保存草稿');
    assert.ok(await p.waitFor(dialog));
    assert.equal(p.calls.filter(call => call.op === 'saveDraft').length, 1);
  } finally { await p.close(); }
});

test("only level-six head and body armor receive the exact durability reminder", async () => {
  const items = [...catalog.items, ...['df_billable_level6_helmet', 'df_billable_level6_armor', 'df_billable_coffee'].map(code => ({ id: code, code, name: code, unit: 'PIECE', quantityScale: 0, required: false }))];
  const p = await probe({ accountId: 'account_1', catalogValue: { ...catalog, items }, mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    for (const code of ['df_billable_level6_helmet', 'df_billable_level6_armor']) {
      assert.match(p.host.querySelector(`[data-resource-code="${code}"]`).textContent, /磨损不超过5耐久/);
    }
    assert.doesNotMatch(p.host.querySelector('[data-resource-code="df_billable_coffee"]').textContent, /耐久/);
    assert.equal(p.calls.some(call => call.op === 'saveDraft'), false);
  } finally { await p.close(); }
});

test("ammo blur stays quiet inside its stepper and never survives an identity switch", async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity: "1260" }] })) });
  try {
    await p.render();
    const closedSupport = p.window.document.createElement('div');
    closedSupport.setAttribute('role', 'dialog'); closedSupport.setAttribute('data-state', 'closed');
    p.window.document.body.append(closedSupport);
    const input = p.host.querySelector('#quantity-item_round');
    const plus = input.parentElement.querySelector('button:last-child');
    await React.act(async () => input.dispatchEvent(new p.window.FocusEvent('focusout', { bubbles: true, relatedTarget: plus })));
    assert.equal(p.window.document.querySelector('[role="alertdialog"]'), null);
    await React.act(async () => input.dispatchEvent(new p.window.FocusEvent('focusout', { bubbles: true, relatedTarget: p.host.querySelector('#publish-description') })));
    assert.ok(await p.waitFor(() => p.window.document.querySelector('[role="alertdialog"]')));
    assert.equal(p.calls.length, 0, "checking an input does not save or quote");
    p.session.userId = 'user_B'; p.session.identityVersion += 1;
    await React.act(async () => p.notifyIdentity());
    assert.ok(await p.waitFor(() => !p.window.document.querySelector('[role="alertdialog"]')));
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});

test("ammo review resumes quote once despite duplicate confirmation clicks", async () => {
  const declared = declaration({ inventory: [{ itemId: "item_haff", quantity: "60000000" }, { itemId: "item_round", quantity: "3600" }] });
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declared), quote: () => supplyOf(declared, { quote: ownerQuote }) });
  try {
    await p.render();
    await p.click('.publish-rail-actions input[type="checkbox"]');
    await p.clickButton('确认上架');
    const dialog = () => p.window.document.querySelector('[role="alertdialog"]');
    assert.ok(await p.waitFor(dialog));
    assert.match(dialog().textContent, /60组.*3600发/s);
    assert.equal(p.calls.length, 0);
    const confirm = [...dialog().querySelectorAll('button')].find(button => button.textContent.includes('确认数量'));
    await React.act(async () => { confirm.click(); confirm.click(); });
    assert.ok(await p.waitFor(() => p.calls.some(call => call.op === 'quote')));
    assert.equal(p.calls.filter(call => call.op === 'saveDraft').length, 1);
    assert.equal(p.calls.filter(call => call.op === 'quote').length, 1);
    assert.equal(p.calls.find(call => call.op === 'saveDraft').body.inventory.find(row => row.itemId === 'item_round').quantity, '3600');
  } finally { await p.close(); }
});

test("ammo blur does not stack its alert over the existing unsaved-navigation dialog", async () => {
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    await p.type('#quantity-item_round', '21');
    const input = p.host.querySelector('#quantity-item_round');
    const link = p.window.document.createElement('a'); link.href = '/accounts'; link.textContent = '账号市场'; p.host.append(link);
    await React.act(async () => {
      input.dispatchEvent(new p.window.FocusEvent('focusout', { bubbles: true, relatedTarget: link }));
      link.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    assert.ok(await p.waitFor(() => p.window.document.querySelector('.publish-leave-dialog')));
    assert.equal(p.window.document.querySelector('.publish-ammo-dialog'), null);
    assert.equal(p.window.document.querySelectorAll('[role="alertdialog"]').length, 1);
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});

test("a restored quote still checks its large ammo quantity before publication", async () => {
  const declared = declaration({ inventory: [{ itemId: 'item_round', quantity: '1260' }] });
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declared, { quote: ownerQuote }),
    confirm: action => supplyOf(declared, { quote: ownerQuote, reviewState: action === 'submit' ? 'PUBLISHED' : 'DRAFT' }) });
  try {
    await p.render();
    await p.click('.publish-agreement-acceptance input');
    await p.clickButton('确认上架');
    const dialog = () => p.window.document.querySelector('[role="alertdialog"]');
    assert.ok(await p.waitFor(dialog));
    assert.equal(p.calls.filter(call => call.op === 'confirm').length, 0);
    await React.act(async () => [...dialog().querySelectorAll('button')].find(button => button.textContent.includes('确认数量')).click());
    assert.ok(await p.waitFor(() => p.calls.filter(call => call.op === 'confirm').length === 2));
    assert.deepEqual(p.calls.filter(call => call.op === 'confirm').map(call => call.action), ['accept-rules', 'submit']);
  } finally { await p.close(); }
});

test("deposit recommendation cannot save a newly edited large ammo count without review", async () => {
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    await p.type('#quantity-item_round', '21');
    await p.clickButton('查看推荐押金');
    const dialog = () => p.window.document.querySelector('[role="alertdialog"]');
    assert.ok(await p.waitFor(dialog));
    assert.equal(p.calls.length, 0);
    await React.act(async () => [...dialog().querySelectorAll('button')].find(button => button.textContent.includes('确认数量')).click());
    assert.ok(await p.waitFor(() => p.calls.some(call => call.op === 'depositRecommendation')));
    assert.equal(p.calls.filter(call => call.op === 'saveDraft').length, 1);
    assert.equal(p.calls.find(call => call.op === 'saveDraft').body.inventory.find(row => row.itemId === 'item_round').quantity, '1260');
    assert.equal(p.calls.filter(call => call.op === 'depositRecommendation').length, 1);
  } finally { await p.close(); }
});

test('all real directory resources can be edited and saved while their missing prices remain explicit',async()=>{
  const codes=['df_billable_haff','df_billable_level6_bullet','df_billable_level6_armor','df_billable_level6_helmet','df_billable_awm_bullet','df_billable_barrett_bullet','df_billable_coffee','df_billable_top_insure_card'];
  const items=codes.map((code,n)=>({id:`catalog_${n}`,code,name:`目录物资${n}`,unit:n===0?'HAFF_BASE':n===1||n===4||n===5?'ROUND':n===7?'DAY':'PIECE',quantityScale:0,required:false,sortOrder:n,priced:n===0}));
  const inventory=items.map((item,n)=>({itemId:item.id,quantity:n===1?'120':String(n)}));
  const p=await probe({accountId:'account_1',catalogValue:{...catalog,items},mine:()=>supplyOf(declaration({inventory}))});
  try{
    await p.render();
    for(const code of codes.slice(1))assert.ok(p.host.querySelector(`[data-resource-code="${code}"]`),code);
    assert.equal(p.host.querySelectorAll('.publish-resource-state').length>0,true);
    assert.match(p.text(),/可保存草稿，暂不能核价/);
    assert.doesNotMatch(p.text(),/这份历史资源未进入当前价目/);
    await p.type('#quantity-catalog_6','9');
    await p.clickButton('保存草稿');
    assert.ok(await p.waitFor(()=>p.calls.some(c=>c.op==='saveDraft')));
    const saved=p.calls.find(c=>c.op==='saveDraft').body.inventory;
    assert.equal(saved.length,8);
    assert.equal(saved.find(i=>i.itemId==='catalog_6').quantity,'9');
    assert.equal(saved.find(i=>i.itemId==='catalog_1').quantity,'120');
    assert.equal(p.calls.some(c=>c.op==='quote'||c.op==='confirm'),false);
  }finally{await p.close();}
});

test('real safe-box and lower-level declarations can be saved without claiming the current rule can price them',async()=>{
  const codes=['safe_box_1x2','safe_box_2x2','safe_box_2x3','safe_box_3x3'];
  const opts={...optionsV1,safeBoxCodes:codes,safeBoxOptions:codes.map((code,n)=>({code,displayName:['基础安全箱(1*2)','进阶安全箱(2*2)','高级安全箱(2*3)','顶级安全箱(3*3)'][n],mappingStatus:'CONFIRMED',issueCode:null})),vitalityLevels:[4,5,6,7],bearLevels:[4,5,6,7],pricingInputOptions:{safeBoxCodes:[],vitalityLevels:[6,7],bearLevels:[6,7]}};
  const attrs={...declaration().attributes,safe_box_code:codes[0],vit_level:4,bear_level:5};
  const p=await probe({accountId:'account_1',options:opts,mine:()=>supplyOf(declaration({attributes:attrs}))});
  try{
    await p.render();assert.match(p.text(),/基础安全箱\(1\*2\)/);assert.doesNotMatch(p.text(),/未确认（代码 safe_box_1x2）/);
    await p.type('#publish-description','真实属性草稿');await p.clickButton('保存草稿');
    assert.ok(await p.waitFor(()=>p.calls.some(c=>c.op==='saveDraft')));
    const saved=p.calls.find(c=>c.op==='saveDraft').body.attributes;
    assert.equal(saved.safe_box_code,codes[0]);assert.equal(saved.vit_level,4);assert.equal(saved.bear_level,5);
    assert.equal(p.calls.some(c=>c.op==='quote'||c.op==='confirm'),false);
  }finally{await p.close();}
});

test('publish picker forwards explicit poster kind to the real shared preview without a write', async () => {
  const observed = [];
  skinPreviewObserver = skin => observed.push(skin);
  const skin = { id: 'poster_skin', code: 'poster_skin', name: '测试海报', categoryId: 'poster_category', mediaId: 'poster_media', mediaKind: 'PROMO_POSTER' };
  const p = await probe({ accountId: 'account_1', catalogValue: { ...catalog, categories: [{ id: 'poster_category', code: 'firearm', name: '枪械外观', parentId: null }], skins: [skin] }, mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    assert.equal(await p.waitFor(() => observed.some(value => value.id === skin.id)), true);
    assert.equal(observed.find(value => value.id === skin.id).mediaKind, 'PROMO_POSTER');
    assert.equal(p.calls.some(call => ['saveDraft', 'quote', 'confirm'].includes(call.op)), false);
  } finally { skinPreviewObserver = undefined; await p.close(); }
});

test("skin picker renders the public summary, neutral missing-media state, and keyboard selection", async () => {
  const skinCatalog = {
    ...catalog,
    categories: [{ id: "category_1", code: "agent", name: "干员外观", parentId: null }],
    rarities: [{ code: "gold", name: "金色" }],
    skins: [
      { id: "skin_1", code: "skin_1", name: "骇爪-维什戴尔", baseName: "维什戴尔", ownerName: "骇爪", ownerKind: "AGENT", categoryId: "category_1", rarityCode: "gold", rarityName: "测试品质", rarityBasis: "PLATFORM_REFERENCE", isCollectible: true, defaultState: "DEFAULT", mediaId: "asset_1" },
      { id: "skin_2", code: "skin_2", name: "待核缺图", baseName: null, ownerName: null, categoryId: "category_1", rarityCode: null, mediaId: null },
    ],
  };
  const p = await probe({ accountId: "account_1", catalogValue: skinCatalog, mine: () => supplyOf(declaration({ skins: ["legacy_skin"] })) });
  try {
    await p.render();
    assert.ok(await p.waitFor(() => p.host.querySelectorAll(".skin-card").length === 2));
    assert.match(p.text(), /骇爪-维什戴尔/);
    assert.equal(p.host.querySelector('.skin-card-name').textContent, '骇爪-维什戴尔');
    assert.equal(p.host.querySelector('.skin-card-owner'), null, 'no duplicate owner/base subtitle');
    assert.equal(p.host.querySelector('.skin-card-media').getAttribute('data-owner-kind'), 'AGENT');
    assert.match(p.text(), /测试品质 · 平台资料/);
    assert.match(p.text(), /典藏/);
    assert.match(p.text(), /默认外观/);
    assert.match(p.text(), /品质待核/);
    assert.match(p.text(), /暂无公开图/);
    assert.equal(p.host.querySelector('.skin-card img')?.getAttribute("src"), "/api/supply/media/asset_1/content");
    assert.match(p.text(), /目录名称待加载/, "a saved unknown skin remains visible instead of being silently dropped");
    await p.click('input[aria-label="选择 骇爪-维什戴尔"]');
    assert.equal(p.host.querySelector('input[aria-label="选择 骇爪-维什戴尔"]').checked, true);
    const image = p.host.querySelector(".skin-card img");
    await React.act(async () => image.dispatchEvent(new p.window.Event("error", { bubbles: true })));
    assert.equal(p.host.querySelector(".skin-card img"), null, "加载失败后小图必须卸载而不是留着隐藏的图片节点");
    assert.equal(p.host.querySelector(".skin-card-media-fallback:not([hidden])") !== null, true);
    skinCatalog.skins[0].mediaId = "asset_2";
    const search = p.host.querySelector('input[aria-label="搜索皮肤或所属名称"]');
    await React.act(async () => search.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.ok(await p.waitFor(() => p.host.querySelector('.skin-card img')?.getAttribute('src') === '/api/supply/media/asset_2/content'));
    const replacement = p.host.querySelector('.skin-card img');
    await React.act(async () => image.dispatchEvent(new p.window.Event("error", { bubbles: true })));
    assert.equal(p.host.querySelector(".skin-card img"), replacement, "a late error from the old media cannot hide the replacement");
    await React.act(async () => replacement.dispatchEvent(new p.window.Event("load", { bubbles: true })));
    assert.equal(p.host.querySelector(".skin-card img"), replacement, "replacement public media must recover after previous image failure");
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

test('R03: publishing cannot resolve pause/resume/withdraw by reading current account state',async()=>{
  for(const action of ['pause','resume','withdraw'])for(const phase of ['pending','accepted']){
    const record={version:1,userId:'user_A',gameId:'game_1',accountId:'account_1',action,key:'frozen-management-key',body:{expectedRevision:'1',...(action==='withdraw'?{versionId:'version_1'}:{})},phase,uncertain:true,createdAt:new Date().toISOString(),...(phase==='accepted'?{receipt:{accountId:'account_1',revision:'2'}}:{})};
    const slot='zzsh.supply-write.v1:user_A',raw=JSON.stringify(record);let reads=0;
    const p=await probe({accountId:'account_1',mine:()=>{reads++;return supplyOf(declaration());},storageSeed:[[slot,raw]]});
    try{
      await p.render();assert.ok(p.findButton('重试当前步骤'));const before=reads;
      await p.clickButton('重试当前步骤');
      assert.match(p.text(),/返回上架账号查询原操作结果/);
      assert.equal(reads,before,'recovery never substitutes a current-account read for the original receipt');
      assert.equal(p.calls.length,0);assert.equal(p.window.sessionStorage.getItem(slot),raw);
      assert.equal(p.host.querySelector('#publish-description').disabled,true);
    }finally{await p.close();}
  }
});

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
    assert.match(popup.textContent,/可用渠道和办理条件以钱包的当前状态为准/);
    assert.doesNotMatch(popup.textContent,/仅支持银行卡提现/);
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
    assert.doesNotMatch(popup.textContent,/180%|10%的结算|保险卡按张|卡片库存/);
    assert.match(popup.textContent,/九格保险体验卡按天/);
    assert.match(popup.textContent,/体验卡另填可用天数/);
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
    assert.equal(unload.defaultPrevented,false,'no native beforeunload prompt; in-app links use the unified dialog');
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

test("unquoted summary distinguishes missing pricing from a zero income", { timeout: 5000 }, async () => {
  const requestStarted = Promise.withResolvers();
  const response = Promise.withResolvers();
  const p=await probe({ resourceIncomePreview: () => {
    requestStarted.resolve();
    return response.promise;
  } });
  try {
    await p.render();
    const rail=p.host.querySelector('#publish-quote');
    assert.equal(rail.dataset.quoted,'false');
    assert.equal(rail.querySelector('[aria-label="预计收入合计"]'),null);
    assert.doesNotMatch(rail.textContent,/0\.00 元/);
    // Wait for the real debounced read, then control its completion instead of sleeping.
    await React.act(async () => { await requestStarted.promise; });
    assert.equal(p.host.querySelector('.supply-resource-grid').getAttribute('aria-busy'),'true');
    assert.equal(p.host.querySelector('[aria-label="物品预估收入"]').textContent,'读取中…');
    await React.act(async () => { response.resolve({ available: false, reason: 'PREVIEW_UNAVAILABLE' }); });
    assert.equal(p.host.querySelector('.supply-resource-grid').getAttribute('aria-busy'),'false');
    assert.equal(p.host.querySelector('[aria-label="物品预估收入"]').textContent,'预估暂不可用');
    assert.doesNotMatch(rail.textContent,/0\.00 元/);
    assert.match(p.host.querySelector('[data-resource-code="df_billable_barrett_bullet"]').textContent,/待配置.*目录待配置/);
  } finally { await p.close(); }
});

test("PUBLISH-UX-2 quantity pending keeps a clearly previous estimate and invalidates the formal quote", async () => {
  let finish, reads = 0;
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity: "60" }] }), { quote: ownerQuote }),
    resourceIncomePreview: () => ++reads === 1 ? resourceEstimate() : new Promise(resolve => { finish = resolve; }) });
  try {
    await p.render(); await previewTick();
    assert.equal(p.host.querySelector('[aria-label="物品预估收入"]').textContent, "0.00 元", "the official quote, not L2, owns the initial amount");
    await p.type('[aria-label="六级子弹数量"]', "2"); await previewTick();
    assert.equal(p.host.querySelector('#publish-quote').dataset.quoted, "false");
    assert.equal(p.host.querySelector('.publish-confirm'), null);
    assert.equal(p.host.querySelector('[aria-label="物品预估收入"]').textContent, "12.34 元");
    assert.match(p.host.querySelector('.publish-live-resource-total').textContent, /上次预估/);
    assert.equal(p.host.querySelector('.supply-resource-grid').getAttribute('aria-busy'), "true");
    assert.match(p.host.querySelector('[data-resource-code="level6_round"] .publish-resource-subtotal').textContent, /上次预估.*12\.34/);
    await React.act(async () => finish(resourceEstimate({ quantity: "120", amount: "24.68" })));
    assert.equal(p.host.querySelector('[aria-label="物品预估收入"]').textContent, "24.68 元");
    assert.doesNotMatch(p.host.querySelector('.publish-live-resource-total').textContent, /上次预估/);
    assert.equal(p.host.querySelector('.supply-resource-grid').getAttribute('aria-busy'), "false");
  } finally { await p.close(); }
});

test("PUBLISH-UX-2 missing price explains configuration instead of asking for an already filled quantity", async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity: "60" }] })),
    resourceIncomePreview: () => resourceEstimate({ amount: null, total: null, unpriced: ["item_round"] }) });
  try {
    await p.render(); await previewTick();
    const total = p.host.querySelector('[aria-label="物品预估收入"]');
    assert.match(total.textContent, /价目.*配置|未配置.*价目/);
    assert.doesNotMatch(total.textContent, /填写数量|0\.00/);
    assert.match(p.host.querySelector('[data-resource-code="level6_round"] .publish-resource-subtotal').textContent, /价目.*配置|未配置.*价目/);
  } finally { await p.close(); }
});

test("PUBLISH-UX-2 legal zero and partial server totals survive an unrelated unmapped quantity", async () => {
  for (const amount of ["0.00", "12.34"]) {
    const quantity = amount === "0.00" ? "0" : "60";
    const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity }] })),
      resourceIncomePreview: () => resourceEstimate({ quantity, amount, total: amount, unreported: ["other_item"] }) });
    try {
      await p.render(); await previewTick();
      await p.type('[aria-label="巴雷特子弹数量"]', "7");
      assert.equal(p.host.querySelector('[aria-label="物品预估收入"]').textContent, `${amount} 元`);
      assert.match(p.text(), /目录待配置/);
      assert.equal(p.calls.length, 0);
    } finally { await p.close(); }
  }
});

test("PUBLISH-03 CSS keeps desktop columns and lets a tall rail flow without internal scrolling", () => {
  const source = fs.readFileSync(path.join(tree, "apps/web/src/components/supply/publish-form.tsx"), "utf8");
  const css = fs.readFileSync(path.join(tree, "apps/web/src/components/supply/publish-refinement.css"), "utf8");
  assert.match(css, /\.publish-rail\[data-tall="true"\]\s*\{\s*position:static/, "a rail taller than the viewport must remain reachable by document scrolling");
  assert.doesNotMatch(css, /\.functional-shell\.functional-shell--editor\s+\.publish-rail\s*\{[^}]*overflow-y:\s*auto/, "no internal scrolling in rail");
  assert.equal(/@media\s*\(max-width:\s*1023px\)/.test(css), true, "1024 retains the collaborative two columns");
  assert.equal(/@media\s*\(max-width:\s*1279px\)\s*\{\s*\.functional-shell--editor \.publish-page-layout/.test(css), false);
});

test("PUBLISH-UX-2 fast edits abort the previous read and refuse its late amount", async () => {
  const pending = []; let reads = 0;
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity: "60" }] })),
    resourceIncomePreview: (_game, inventory, _binding, signal) => ++reads === 1 ? resourceEstimate() : new Promise(resolve => pending.push({ inventory, signal, resolve })) });
  try {
    await p.render(); await previewTick();
    await p.type('[aria-label="六级子弹数量"]', "2"); await previewTick();
    await p.type('[aria-label="六级子弹数量"]', "3"); await previewTick();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending[1].inventory.find((r) => r.itemId === "item_round")?.quantity, "180");
    await React.act(async () => pending[1].resolve(resourceEstimate({ quantity: "180", amount: "37.02" })));
    await React.act(async () => pending[0].resolve(resourceEstimate({ quantity: "120", amount: "24.68" })));
    assert.equal(p.host.querySelector('[aria-label="物品预估收入"]').textContent, "37.02 元");
    assert.doesNotMatch(p.host.querySelector('.publish-live-resource-total').textContent, /上次预估/);
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});

test("PUBLISH-UX-2 a rule change clears previous estimates and refuses an old binding", async () => {
  const currentCatalog = structuredClone(catalog), pending = []; let reads = 0;
  const p = await probe({ catalogValue: currentCatalog, accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity: "60" }] })),
    resourceIncomePreview: () => ++reads === 1 ? resourceEstimate() : new Promise(resolve => pending.push(resolve)) });
  try {
    await p.render(); await previewTick();
    await p.type('[aria-label="六级子弹数量"]', "2"); await previewTick();
    currentCatalog.game.catalogRevision = "2";
    currentCatalog.game.currentReleaseId = "release_2";
    await p.type('[aria-label="六级子弹数量"]', "3");
    assert.doesNotMatch(p.host.querySelector('.publish-live-resource-total').textContent, /12\.34|上次预估/);
    await previewTick();
    await React.act(async () => pending[0](resourceEstimate({ quantity: "120", amount: "24.68" })));
    await React.act(async () => pending[1](resourceEstimate({ quantity: "180", amount: "37.02", revision: "1", release: "release_1" })));
    assert.doesNotMatch(p.host.querySelector('.publish-live-resource-total').textContent, /12\.34|24\.68|37\.02|0\.00/);
    assert.equal(p.host.querySelector('.supply-resource-grid').getAttribute('aria-busy'), "false");
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});

test("PUBLISH-UX-2 identity changes hide previous values and a late read cannot restore them", async () => {
  const pending = []; let reads = 0;
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity: "60" }] })),
    resourceIncomePreview: () => ++reads === 1 ? resourceEstimate() : new Promise(resolve => pending.push(resolve)) });
  try {
    await p.render(); await previewTick();
    await p.type('[aria-label="六级子弹数量"]', "2"); await previewTick();
    await changeSubject(p, "user_B");
    assert.doesNotMatch(p.text(), /12\.34 元|上次预估/);
    await React.act(async () => pending[0](resourceEstimate({ quantity: "120", amount: "24.68" })));
    assert.doesNotMatch(p.text(), /12\.34 元|24\.68 元|上次预估/);
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});

test("PUBLISH-UX-2 preview failure and an unknown save cannot retain an apparently current amount", async () => {
  let rejectPreview, reads = 0;
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_round", quantity: "60" }] })),
    resourceIncomePreview: () => ++reads === 1 ? resourceEstimate() : new Promise((_resolve, reject) => { rejectPreview = reject; }),
    saveDraft: () => { throw new actualSupply.SupplyRequestError(503, { error: { code: "INTERNAL_ERROR", message: "unknown save" } }); } });
  try {
    await p.render(); await previewTick();
    await p.type('[aria-label="六级子弹数量"]', "2"); await previewTick();
    await React.act(async () => rejectPreview(new actualSupply.SupplyRequestError(503, { error: { code: "INTERNAL_ERROR", message: "preview failed" } })));
    assert.equal(p.host.querySelector('[aria-label="物品预估收入"]').textContent, "预估暂不可用");
    assert.match(p.host.querySelector('.publish-resource-preview-status').textContent, /暂未取得/);
    assert.doesNotMatch(p.host.querySelector('.publish-live-resource-total').textContent, /12\.34|0\.00|上次预估/);
    await p.clickButton("保存草稿");
    assert.ok(await p.waitFor(() => intentFor(p, "user_A")?.uncertain === true));
    assert.equal(intentFor(p, "user_A").phase, "pending");
    const before = reads; await previewTick();
    assert.equal(reads, before, "an unknown write must not start another preview");
    assert.equal(p.host.querySelector('[aria-label="六级子弹数量"]').disabled, true);
    assert.equal(p.calls.filter(c => c.op === "saveDraft").length, 1);
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

test("a saved quote with UNKNOWN confirmation still blocks in-app leaving without a native unload prompt", async () => {
  const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration({title:'quoted'}),{quote:ownerQuote}),confirm:()=>{throw new actualSupply.SupplyRequestError(0,{error:{code:'NETWORK_ERROR',message:'结果未知',requestId:'unknown-confirm'}})}});
  try {
    await p.render();
    await p.click('.publish-confirm input[type=checkbox]');
    await p.click('.publish-confirm button.button.primary');
    await p.waitFor(()=>p.text().includes('结果未知'));
    const unload=new p.window.Event('beforeunload',{cancelable:true});p.window.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented,false,'no native beforeunload prompt; the unresolved-write guard stays in the unified dialog');
    const link=p.window.document.createElement('a');link.href='/accounts';link.textContent='leave';p.host.append(link);
    p.window.document.addEventListener('click',e=>e.preventDefault(),{once:true});
    await React.act(async()=>link.click());
    await p.waitFor(()=>p.window.document.querySelector('[role="alertdialog"]'));
    const dialog=p.window.document.querySelector('[role="alertdialog"]');assert.ok(dialog);
    assert.match(dialog.textContent,/上次操作结果仍待确认/);
    assert.equal(dialog.querySelector('.ui-alert-dialog-confirm, button.button.primary').disabled,true);
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
    assert.match(dialog.textContent,/当前操作尚未完成/);assert.equal(dialog.querySelector('.ui-alert-dialog-confirm, button.button.primary').disabled,true);
    const unload=new p.window.Event('beforeunload',{cancelable:true});p.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,false,'no native beforeunload prompt');
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
    assert.match(dialog.textContent,/上次操作结果仍待确认/);assert.equal(dialog.querySelector('.ui-alert-dialog-confirm, button.button.primary').disabled,true);
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
    assert.ok(p.host.querySelector('[aria-label="体力等级"]'), 'editable account fields are present before the uncertain save');
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
    await disabledFast.click('.publish-rail-actions input[type="checkbox"]');
    await disabledFast.clickButton("确认上架");
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
    await v1Fast.click('.publish-rail-actions input[type="checkbox"]');
    await v1Fast.clickButton("确认上架");
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
    await p.type('input[aria-label$="（M）"]', "60");
    await p.waitFor(() => p.text().includes("= 60,000,000 哈夫币"));
    assert.match(p.text(), /= 60,000,000 哈夫币/);
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

test("haff balance sits in terms, stays a single input, and invalid input locates its field", async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    const haff = p.host.querySelector('#publish-haff-balance');
    assert.ok(haff);
    assert.equal(p.host.querySelectorAll('input[aria-label="哈夫币数量（M）"]').length, 1);
    assert.ok(p.host.querySelector('#publish-group-terms #publish-haff-balance'));
    assert.equal(p.host.querySelector('#publish-group-account #publish-haff-balance'), null);
    assert.match(p.host.querySelector('#publish-group-terms').textContent, /哈夫币余额/);
    await p.type('#publish-haff-balance', '-5');
    assert.equal(haff.getAttribute('aria-invalid'), 'true');
    assert.equal(haff.getAttribute('aria-describedby'), 'publish-haff-balance-hint publish-haff-balance-error');
    assert.match(p.host.querySelector('#publish-haff-balance-error').textContent, /不支持小数/);
    await p.clickButton('保存草稿');
    assert.equal(p.calls.length, 0);
    assert.equal(p.window.document.activeElement, haff);
    assert.match(p.text(), /不支持小数/);
  } finally { await p.close(); }
});

test("KD invalid input shows an in-place message linked to the field", async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    const kd = p.host.querySelector('#publish-secret-kd');
    assert.equal(kd.getAttribute('aria-describedby'), null);
    await p.type('#publish-secret-kd', 'abc');
    assert.equal(kd.getAttribute('aria-invalid'), 'true');
    assert.equal(kd.getAttribute('aria-describedby'), 'publish-secret-kd-error');
    assert.match(p.host.querySelector('#publish-secret-kd-error').textContent, /0–100/);
    await p.clickButton('保存草稿');
    assert.equal(p.calls.length, 0);
    assert.equal(p.window.document.activeElement, kd);
  } finally { await p.close(); }
});

test("region popover exposes an accessible name and keeps its search focused", async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    await p.click('button[aria-label="地区选择"]');
    const popover = p.window.document.querySelector('.publish-region-popover');
    assert.ok(popover);
    assert.equal(popover.getAttribute('role'), 'dialog');
    assert.equal(popover.getAttribute('aria-label'), '选择地区');
    assert.equal(p.window.document.activeElement, popover.querySelector('input[type="search"]'));
  } finally { await p.close(); }
});

test("notice returns focus to the first entry field and to its trigger when reopened", async () => {
  const p = await probe({ readNotice: false });
  try {
    await p.render();
    await p.advanceReading(5000);
    const confirm = p.window.document.querySelector('.publish-reading-footer > button');
    assert.equal(confirm.disabled, false);
    await React.act(async () => confirm.click());
    assert.ok(await p.waitFor(() => !p.window.document.querySelector('[data-slot="dialog-content"]')));
    assert.equal(p.window.document.activeElement, p.host.querySelector('#publish-secret-kd'));
    const trigger = [...p.host.querySelectorAll('button')].find(button => button.textContent.includes('上架须知'));
    assert.ok(trigger);
    await React.act(async () => trigger.click());
    assert.ok(await p.waitFor(() => p.window.document.querySelector('[data-slot="dialog-content"]')));
    const close = p.window.document.querySelector('button[aria-label="关闭上架须知"]');
    assert.equal(close.disabled, false);
    await React.act(async () => close.click());
    assert.ok(await p.waitFor(() => !p.window.document.querySelector('[data-slot="dialog-content"]')));
    assert.equal(p.window.document.activeElement, trigger);
  } finally { await p.close(); }
});

test("resource art uses the approved delta materials and keeps the insurance day identity", async () => {
  const resources = [
    ['df_billable_level6_bullet', 'ROUND', 'level6-ammo.png'],
    ['df_billable_level6_helmet', 'PIECE', 'level6-helmet-dich9.png'],
    ['df_billable_level6_armor', 'PIECE', 'level6-armor-mas2.png'],
    ['df_billable_awm_bullet', 'ROUND', 'awm-ammo.png'],
    ['df_billable_barrett_bullet', 'ROUND', 'barrett-ammo.png'],
    ['df_billable_coffee', 'PIECE', 'coffee-beans.png'],
    ['df_billable_top_insure_card', 'DAY', 'insurance-experience-card-thumb.png'],
    ['df_billable_turtle_backpack_45', 'PIECE', 'turtle-backpack-45.png'],
  ];
  const items = [catalog.items[0], ...resources.map(([code, unit], index) => ({ id: `item_art_${index}`, code, name: `材料${index}`, unit, quantityScale: 0, required: false, priced: true }))];
  const p = await probe({ accountId: 'account_1', catalogValue: { ...catalog, items }, mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    for (const [code, , file] of resources) {
      const image = p.host.querySelector(`[data-resource-code="${code}"] img`);
      assert.ok(image, code);
      assert.equal(image.getAttribute('src'), `/art/delta/items/${file}`);
    }
    assert.doesNotMatch(p.host.querySelector('#publish-group-assets').innerHTML, /inventory-polished/);
    assert.match(p.host.querySelector('[data-resource-code="df_billable_top_insure_card"]').textContent, /九格保险体验卡/);
    assert.doesNotMatch(p.text(), /顶级保险卡/);
  } finally { await p.close(); }
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

const recommendationSkin = { id: 'skin_v2', code: 'skin_v2', name: '测试干员-外观', categoryId: 'category_v2', ownerKind: 'AGENT', ownerName: '测试干员', baseName: '外观', rarityCode: 'legend', rarityName: '测试品质', mediaId: null };
const recommendationCatalog = (revision = '1', skins = [recommendationSkin]) => ({ ...catalog, game: { ...catalog.game, catalogRevision: revision }, categories: [{ id: 'category_v2', name: '干员外观', ownerKind: 'AGENT' }], skins });
function recommendationV2(skinIds = ['skin_v2']) {
  return {
    available: true, recommendationSchema: 'deposit-recommendation-v2', amountCents: '31234', minCents: '1', fullPayoutMinCents: '30000', capCents: '100000',
    policyVersion: 'p2', accountId: 'account_1', accountRevision: '5', versionId: 'version_1', versionRevision: '1', ruleReleaseId: 'release_1', priceVersionId: 'price_1',
    inputs: { safeBoxCode: null, vitality: null, bear: null, dive: null, skinIds, skinFacts: {
      schema: 'deposit-skin-facts-v1', gameId: 'game_1', listingVersionId: 'version_1', catalogRevision: '1',
      skins: skinIds.map(skinId => ({ skinId, ownerKind: 'AGENT', rarityCode: 'legend' })),
    } },
  };
}

test('v2 recommendation verifies every selected skin across catalog pages, rechecks before adoption, and expires on a later directory change', async () => {
  const reads = []; let revision = '1';
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration({ skins: ['skin_v2'] })), depositRecommendation: () => recommendationV2(),
    catalogValue: async (_game, query) => {
      if (query.get('limit') === '100') {
        reads.push(Object.fromEntries(query));
        return query.get('cursor') ? recommendationCatalog(revision) : { ...recommendationCatalog(revision, []), nextCursor: 'metadata_next' };
      }
      return recommendationCatalog(revision, []);
    },
  });
  try {
    await p.render(); await p.clickButton('查看推荐押金');
    assert.equal(await p.waitFor(() => p.text().includes('推荐 312.34 元（依据当前版本资料）')), true);
    assert.equal(reads.length, 2, 'selected facts outside the visible picker page are read as metadata');
    await p.clickButton('采用推荐');
    assert.equal(await p.waitFor(() => p.host.querySelector('#publish-deposit').value === '312.34'), true);
    assert.equal(reads.length, 4, 'adoption repeats the directory check without calculating a client price');
    assert.equal(p.calls.some(call => call.op === 'saveDraft'), false, 'adoption only edits the local declaration');
    revision = '2';
    await p.clickButton('查找');
    assert.equal(await p.waitFor(() => p.text().includes('已过期')), true);
    assert.equal(p.text().includes('已采用推荐'), false);
    assert.equal(p.host.querySelector('#publish-deposit').value, '312.34', 'a stale recommendation does not erase the owner declaration');
  } finally { await p.close(); }
});

test('v2 recommendation refuses missing, foreign, duplicate and mismatched skin facts before adoption', async () => {
  const original = recommendationV2();
  const cases = [
    undefined,
    { ...original.inputs.skinFacts, gameId: 'other_game' },
    { ...original.inputs.skinFacts, listingVersionId: 'other_version' },
    { ...original.inputs.skinFacts, catalogRevision: '2' },
    { ...original.inputs.skinFacts, skins: [] },
    { ...original.inputs.skinFacts, skins: [{ skinId: 'other_skin', ownerKind: 'AGENT', rarityCode: 'legend' }] },
    { ...original.inputs.skinFacts, skins: [...original.inputs.skinFacts.skins, ...original.inputs.skinFacts.skins] },
    { ...original.inputs.skinFacts, skins: [{ skinId: 'skin_v2', ownerKind: 'FIREARM', rarityCode: 'legend' }] },
    { ...original.inputs.skinFacts, skins: [{ skinId: 'skin_v2', ownerKind: 'AGENT', rarityCode: 'other_quality' }] },
  ];
  for (const skinFacts of cases) {
    const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration({ skins: ['skin_v2'] })), catalogValue: recommendationCatalog(),
      depositRecommendation: () => ({ ...original, inputs: { ...original.inputs, skinFacts } }),
    });
    try {
      await p.render(); await p.clickButton('查看推荐押金');
      assert.equal(await p.waitFor(() => p.text().includes('不匹配')), true, JSON.stringify(skinFacts));
      const adopt = [...p.host.querySelectorAll('button')].find(button => button.textContent === '采用推荐');
      assert.equal(adopt.disabled, true);
      assert.equal(p.host.querySelector('#publish-deposit').value, '');
    } finally { await p.close(); }
  }
});

test('v2 empty selection still needs explicit empty facts while v1 keeps its original contract', async () => {
  for (const [schema, withFacts, adoptable] of [['deposit-recommendation-v2', false, false], ['deposit-recommendation-v2', true, true], ['deposit-recommendation-v1', false, true], ['deposit-recommendation-v3', false, false]]) {
    const response = recommendationV2([]); response.recommendationSchema = schema;
    if (!withFacts) delete response.inputs.skinFacts;
    const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration()), catalogValue: recommendationCatalog('1', []), depositRecommendation: () => response });
    try {
      await p.render(); await p.clickButton('查看推荐押金');
      assert.equal(await p.waitFor(() => p.text().includes(adoptable ? '推荐 312.34' : '不匹配')), true);
      const adopt = [...p.host.querySelectorAll('button')].find(button => button.textContent === '采用推荐');
      assert.equal(adopt.disabled, !adoptable, schema);
    } finally { await p.close(); }
  }
});

test('v2 directory changes or lookup failure just before adoption never fill the deposit', async () => {
  for (const mode of ['revision', 'type', 'rarity', 'failure']) {
    let changed = false;
    const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration({ skins: ['skin_v2'] })), depositRecommendation: () => recommendationV2(),
      catalogValue: async (_game, query) => {
        if (changed && query.get('limit') === '100' && mode === 'failure') throw new actualSupply.SupplyRequestError(0, null);
        const skin = changed ? { ...recommendationSkin, ...(mode === 'type' ? { ownerKind: 'FIREARM' } : mode === 'rarity' ? { rarityCode: 'other_quality' } : {}) } : recommendationSkin;
        return recommendationCatalog(changed && mode === 'revision' ? '2' : '1', [skin]);
      },
    });
    try {
      await p.render(); await p.clickButton('查看推荐押金');
      assert.equal(await p.waitFor(() => p.text().includes('推荐 312.34')), true);
      changed = true; await p.clickButton('采用推荐');
      assert.equal(await p.waitFor(() => p.text().includes(mode === 'failure' ? '目录核对未完成' : '目录或资料已变化')), true);
      assert.equal(p.host.querySelector('#publish-deposit').value, '');
    } finally { await p.close(); }
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
    assert.equal(p.window.document.querySelector('.publish-agreement-dialog'), null);
    assert.equal(p.host.querySelector('[aria-hidden="true"] summary'), null);
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
    await p.click('.publish-rail-actions input[type="checkbox"]');
    await p.clickButton("确认上架");
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
    await p.click('.publish-rail-actions input[type="checkbox"]');
    await p.clickButton("确认上架");
    assert.equal(p.calls.some((c) => c.op === "quote"), true);
    assert.match(p.text(), /报价已取得|报价已更新|已成功上架/);
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
   try {await p.render();await p.clickButton('出租协议');assert.equal(p.host.querySelector('.publish-agreement-acceptance input').checked,false,'opening the agreement does not grant consent');const node=p.window.document.querySelector('.publish-agreement-dialog .publish-terms-body');assert.match(node.textContent,/真实条款\n请阅读条件/);assert.match(node.textContent,/物品\t金额/);assert.doesNotMatch(node.textContent,/<h3>|bad/);assert.equal(node.querySelector('script'),null);assert.equal(data.agreement.body,body);}finally{await p.close();}
});

const selectedPayoutDeclaration = () => declaration({ title: "包赔声明", inventory: [{ itemId: "item_haff", quantity: "60000000" }], attributes: { full_payout_declaration: { schema: "full-payout-declaration-v1", selected: true }, owner_deposit_declaration: { schema: "owner-deposit-declaration-v1", amountCents: "30000", declarationVersion: "test" } } });
const ownerPayoutTerms = { termsVersionId: "payout_v1", termsDigest: "a".repeat(64), disclosureVersion: "disclosure_v1", policyRef: "policy_v1", policyVersion: "1", title: "本次包赔条款", body: "本次保障条件与责任。" };

test("owner selected payout requires its separate acceptance and sends exact sealed refs only to accept-rules", async () => {
  let complete;
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(selectedPayoutDeclaration(), { quote: ownerQuote }), fullPayoutTerms: () => new Promise(resolve => { complete = resolve; }),
    confirm: action => supplyOf(selectedPayoutDeclaration(), { quote: ownerQuote, revision: action === "accept-rules" ? "6" : "7", reviewState: action === "accept-rules" ? "DRAFT" : "PUBLISHED" }) });
  try {
    await p.render(); await p.click(".publish-agreement-acceptance input");
    assert.equal(p.host.querySelector(".publish-confirm button.button.primary").disabled, true);
    assert.equal(p.host.querySelector(".publish-payout-acceptance input").disabled, true);
    await React.act(async () => complete({ releaseId: "release_1", fullPayoutTerms: ownerPayoutTerms })); await p.waitFor(() => !p.host.querySelector(".publish-payout-acceptance input").disabled);
    await p.clickButton('包赔条款');
    assert.match(p.window.document.querySelector('.publish-agreement-dialog').textContent, /本次保障条件与责任/);
    await React.act(async () => p.window.document.querySelector('[aria-label="关闭包赔条款"]').click());
    assert.equal(p.host.querySelector(".publish-confirm button.button.primary").disabled, true);
    await p.click(".publish-payout-acceptance input"); await p.clickButton("确认上架");
    assert.ok(await p.waitFor(() => p.calls.filter(c => c.op === "confirm").length === 2));
    const calls = p.calls.filter(c => c.op === "confirm");
    assert.deepEqual(calls[0].body.fullPayoutTermsAcceptance, { termsVersionId: "payout_v1", termsDigest: "a".repeat(64), disclosureVersion: "disclosure_v1" });
    assert.equal(calls[1].action, "submit"); assert.equal(calls[1].body.fullPayoutTermsAcceptance, undefined);
  } finally { await p.close(); }
});

test("owner unreadable or wrong-release payout terms never permit publishing", async () => {
  for (const fullPayoutTerms of [async () => { throw Error("offline"); }, async () => ({ releaseId: "old_release", fullPayoutTerms: ownerPayoutTerms })]) {
    const p = await probe({ accountId: "account_1", mine: () => supplyOf(selectedPayoutDeclaration(), { quote: ownerQuote }), fullPayoutTerms });
    try { await p.render(); await p.click(".publish-agreement-acceptance input"); assert.match(p.text(), /全额包赔条款暂时无法读取或版本已变化/); assert.equal(p.host.querySelector(".publish-confirm button.button.primary").disabled, true); assert.equal(p.calls.some(c => c.op === "confirm"), false); } finally { await p.close(); }
  }
});

test("owner quote revision change reloads payout terms and clears the earlier acceptance", async () => {
  let reads = 0;
  const next = supplyOf(selectedPayoutDeclaration(), { quote: ownerQuote, revision: "6", versionRevision: "2" });
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(selectedPayoutDeclaration(), { quote: ownerQuote }), fullPayoutTerms: async () => ({ releaseId: "release_1", fullPayoutTerms: { ...ownerPayoutTerms, termsDigest: (++reads === 1 ? "a" : "b").repeat(64) } }), saveDraft: () => next, quote: () => next });
  try { await p.render(); await p.click(".publish-agreement-acceptance input"); await p.click(".publish-payout-acceptance input"); assert.equal(p.host.querySelector(".publish-confirm button.button.primary").disabled, false); await p.clickButton("重新核对报价"); assert.ok(await p.waitFor(() => reads === 2)); assert.equal(p.host.querySelector(".publish-payout-acceptance input").checked, false); assert.equal(p.host.querySelector(".publish-confirm button.button.primary").disabled, true); assert.equal(p.calls.some(c => c.op === "confirm"), false); } finally { await p.close(); }
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
    await p.type('input[aria-label="巴雷特子弹数量"]','2');await p.type('input[aria-label="九格保险体验卡数量"]','3');
    await p.clickButton('保存草稿');assert.equal(p.calls.some(c=>c.op==='saveDraft'),false);assert.match(p.text(),/数量已保留在本页/);
    assert.doesNotMatch(p.text(),/暂不可填写/);
  }finally{await p.close();}
});

test("payout rules are readable before quote and reading does not consent or send a write",async()=>{
  const p=await probe({accountId:"account_1",mine:()=>supplyOf(declaration())});
  try{await p.render();const rules=p.host.querySelector('#publish-payout-rules');rules.open=true;rules.querySelector('summary').focus();assert.equal(rules.open,true);assert.equal(p.window.document.activeElement,rules.querySelector('summary'));assert.equal(p.calls.length,0);assert.match(p.text(),/8%/);}finally{await p.close();}
});

test('UX22-U06 optional payout information never impersonates the current payout selection',async()=>{
  const original=declaration({attributes:{...declaration().attributes,owner_deposit_declaration:{schema:'owner-deposit-declaration-v1',amountCents:'5000',declarationVersion:'1'}}});
  const frozen=JSON.stringify(original),p=await probe({accountId:'account_1',mine:()=>supplyOf(original)});
  try{
    await p.render();
    const title=()=>p.host.querySelector('.publish-payout-feature-heading strong').textContent;
    const selected=()=>p.host.querySelector('.publish-payout-feature').getAttribute('data-selected');
    assert.equal(title(),'可选全额包赔方案说明');assert.equal(selected(),'false');
    assert.match(p.host.querySelector('.publish-payout-feature-heading span').textContent,/尚未选择赔付方案/);
    assert.match(p.host.querySelector('.publish-payout-facts').textContent,/全额包赔基础押金门槛/);
    assert.match(p.host.querySelector('.publish-payout-facts').textContent,/8%.*300 元起/);
    assert.equal(parseFloat(p.host.querySelector('#publish-deposit').value),50);
    await p.click('.publish-payout-group label:first-of-type [role="radio"]');
    assert.equal(title(),'可选全额包赔方案说明');assert.equal(selected(),'false');
    assert.match(p.host.querySelector('.publish-payout-feature-heading span').textContent,/当前选择普通赔付/);
    await p.click('.publish-payout-group label:last-of-type [role="radio"]');
    assert.equal(title(),'全额包赔');assert.equal(selected(),'true');
    assert.match(p.host.querySelector('.publish-payout-feature-heading span').textContent,/已选择此方案/);
    assert.equal(parseFloat(p.host.querySelector('#publish-deposit').value),50,'selecting optional cover must not replace the declared deposit');
    assert.equal(JSON.stringify(original),frozen);assert.ok(p.calls.every(call=>call.op==='fullPayoutTerms'),'only current terms may be read; selection never writes');
  }finally{await p.close();}
});

test("catalog changes invalidate a quote and consent without overwriting the declaration",async()=>{
  let revision='1';
  const p=await probe({accountId:"account_1",catalogValue:()=>({...catalog,game:{...catalog.game,catalogRevision:revision}}),mine:()=>supplyOf(declaration({description:'keep me'}),{quote:{...ownerQuote,catalogRevision:'1'}})});
  try{await p.render();assert.match(p.text(),/报价已取得/);revision='2';await p.type('.skin-search-input','skin');const input=p.host.querySelector('.skin-search-input');await React.act(async()=>input.dispatchEvent(new p.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));await p.waitFor(()=>p.text().includes('待重新核算'));assert.match(p.text(),/待重新核算/);assert.match(p.text(),/条件已修改，重新核对报价后更新收入/);assert.ok(p.host.querySelector('.publish-requote-link'));assert.equal(p.host.querySelector('#publish-description').value,'keep me');assert.equal(p.calls.length,0);}finally{await p.close();}
});

test("insurance uses the existing DAY identity once and saves unchanged base day quantities",async()=>{
  const dayId='item_32489f25a1b148d9be19875c7123d312',pieceId='item_277e7b4df99c47faa95e8504601c7e15';
  const items=[...catalog.items,{id:'item_barrett',code:'df_billable_barrett_bullet',name:'巴雷特子弹',unit:'ROUND',quantityScale:0,required:false},{id:dayId,code:'df_billable_top_insure_card',name:'旧保险天数',unit:'DAY',quantityScale:0,required:false},{id:pieceId,code:'top_insure_card_piece',name:'顶级保险卡',unit:'PIECE',quantityScale:0,required:false}];
  const original=declaration({inventory:[{itemId:'item_haff',quantity:'60000000'},{itemId:dayId,quantity:'3'}]});
  const saved=supplyOf(original);saved.version.catalogItems.push({id:dayId,code:'df_billable_top_insure_card',name:'旧保险天数',unit:'DAY',priced:false});
  const p=await probe({accountId:'account_1',catalogValue:{...catalog,items},mine:()=>saved});
  try{
    await p.render();
    const card=p.host.querySelector('[data-resource-code="df_billable_top_insure_card"]');
    assert.ok(card);assert.match(card.textContent,/九格保险体验卡/);assert.match(card.textContent,/天/);assert.doesNotMatch(card.textContent,/旧保险|张数/);
    assert.match(card.querySelector('img').getAttribute('src'),/insurance-experience-card-thumb\.png$/);
    assert.equal(p.host.querySelector('#quantity-'+pieceId),null);
    assert.equal(p.host.querySelectorAll('[data-resource-code="df_billable_top_insure_card"]').length,1);
    assert.equal(p.host.querySelector('#quantity-'+dayId).value,'3');
    await p.type('#quantity-item_barrett','2');await p.type('#quantity-'+dayId,'4');
    await p.clickButton('保存草稿');
    const body=p.calls.find(call=>call.op==='saveDraft').body;
    assert.equal(body.inventory.find(row=>row.itemId==='item_barrett').quantity,'2');
    assert.equal(body.inventory.find(row=>row.itemId===dayId).quantity,'4');
    assert.equal(body.inventory.some(row=>row.itemId===pieceId),false);
    assert.equal(original.inventory.find(row=>row.itemId===dayId).quantity,'3');
  }finally{await p.close();}
});

test("insurance catalog absence offers only a DAY placeholder and no piece inventory input",async()=>{
 const p=await probe({accountId:'account_1',mine:()=>supplyOf(declaration())});
 try{await p.render();const row=p.host.querySelector('[data-resource-code="df_billable_top_insure_card"]');assert.ok(row);assert.match(row.textContent,/天/);assert.equal(p.host.querySelector('[data-resource-code="top_insure_card_piece"]'),null);assert.equal(p.calls.length,0);}finally{await p.close();}
});

test("a previously referenced wrong PIECE insurance row is retained read-only without becoming days",async()=>{
 const id='wrong_piece',original=declaration({inventory:[{itemId:'item_haff',quantity:'60000000'},{itemId:id,quantity:'7'}]}),saved=supplyOf(original);saved.version.catalogItems.push({id,code:'top_insure_card_piece',name:'保险历史记录',unit:'PIECE',priced:false});
 const p=await probe({accountId:'account_1',mine:()=>saved});
 try{await p.render();const input=p.host.querySelector('#quantity-'+id);assert.equal(input.value,'7');assert.equal(input.disabled,true);assert.match(input.closest('article').textContent,/单位需核对/);assert.equal(p.host.querySelector('[data-resource-code="df_billable_top_insure_card"] input').value,'');assert.deepEqual(original.inventory,[{itemId:'item_haff',quantity:'60000000'},{itemId:id,quantity:'7'}]);assert.equal(p.calls.length,0);}finally{await p.close();}
});

test("gross owner income excludes declared deposits and never pre-deducts a flat payout fee",async()=>{
  const attrs={...declaration().attributes,rentalPricing:{rentalMode:'ordinary'},owner_deposit_declaration:{schema:'owner-deposit-declaration-v1',amountCents:'30000',declarationVersion:'1'},full_payout_declaration:{schema:'full-payout-declaration-v1',selected:true}};
  const p=await probe({accountId:'account_1',options:optionsV2,mine:()=>supplyOf(declaration({attributes:attrs}),{schemaVersion:2,quote:{...ownerQuote,schemaVersion:2,rentalMode:'ordinary',ownerHaffRatio:'50',publisherBailRequirement:{currency:'CNY',unit:'yuan',amount:'0.00',scale:2}}})});
  try{await p.render();assert.equal(p.host.querySelector('[aria-label="预计收入合计"]').textContent,'120.00 元');assert.match(p.host.querySelector('.publish-rail-deposits').textContent,/300.00 元/);assert.doesNotMatch(p.host.querySelector('.publish-rail-deposits').textContent,/发布保证金/);assert.match(p.host.querySelector('[aria-label="测算出租比例"]').textContent,/50 万哈夫币/);assert.equal(p.host.querySelector('.publish-confirm input').checked,false);assert.deepEqual(p.calls.map(c=>c.op),["fullPayoutTerms"]);}finally{await p.close();}
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

// --- 皮肤小图接线（离线 fixture；不需要服务、数据库或真实数据） ---
function loadTsFile(file, overrides = {}) {
  const mod = new Module(file, null);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  const native = mod.require.bind(mod);
  mod.require = (name) => overrides[name] ?? native(name);
  mod._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, file);
  return mod.exports;
}

let thumbModuleCache, skinPreviewObserver;
function loadThumbModule() {
  thumbModuleCache ??= loadTsFile(path.join(tree, "apps/web/src/components/supply/skin-media-thumb.tsx"), {
    react: React,
    "./skin-media.css": {},
    "lucide-react": { FileImage: (props) => React.createElement("span", { "data-icon": "FileImage", ...props }) },
  });
  return thumbModuleCache;
}

async function openThumb() {
  const window = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: window.getComputedStyle.bind(window),
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  return {
    window, host,
    render: async (mediaId) => { await React.act(async () => root.render(React.createElement(loadThumbModule().SkinMediaThumb, { mediaId }))); },
    img: () => host.querySelector("img"),
    fallbacks: () => [...host.querySelectorAll(".skin-card-media-fallback")],
    close: async () => { await React.act(async () => root.unmount()); await window.happyDOM.close(); },
  };
}

test("皮肤小图：有 mediaId 才出图，且使用既有公开媒体 URL 合同", async () => {
  const p = await openThumb();
  try {
    await p.render("m_1");
    const img = p.img();
    assert.ok(img, "有 mediaId 必须出图");
    assert.equal(img.getAttribute("src"), "/api/supply/media/m_1/content");
    assert.equal(p.fallbacks().length, 0, "出图时不渲染占位");

    await p.render(null);
    assert.equal(p.img(), null, "无 mediaId 不得留旧图");
    assert.equal(p.fallbacks().length, 1, "无图时显示一个中性占位");
    assert.match(p.host.textContent, /暂无公开图/);
  } finally { await p.close(); }
});

test("皮肤小图：加载失败回退，换到新媒体后自动恢复", async () => {
  const p = await openThumb();
  try {
    await p.render("m_1");
    await React.act(async () => { p.img().dispatchEvent(new p.window.Event("error")); });
    assert.equal(p.img(), null, "加载失败不再出图");
    assert.equal(p.fallbacks().length, 1, "加载失败显示中性占位");

    await p.render("m_2");
    const second = p.img();
    assert.ok(second, "换到新媒体后失败态必须恢复");
    assert.equal(second.getAttribute("src"), "/api/supply/media/m_2/content");
    assert.equal(p.fallbacks().length, 0, "恢复后不得残留占位");
  } finally { await p.close(); }
});

test("皮肤小图：旧图迟到事件不影响当前图，撤图回到占位", async () => {
  const p = await openThumb();
  try {
    await p.render("m_1");
    const stale = p.img();
    await p.render("m_2");
    const current = p.img();
    assert.notEqual(current, stale, "换图必须是新的图片元素，旧节点不得复用");
    await React.act(async () => { stale.dispatchEvent(new p.window.Event("error")); });
    assert.equal(p.img(), current, "旧图迟到 error 不得移除当前图");
    assert.equal(current.getAttribute("src"), "/api/supply/media/m_2/content");
    assert.equal(p.fallbacks().length, 0, "旧图迟到 error 不得露出占位");

    await p.render(null);
    assert.equal(p.img(), null, "撤图后不再出图");
    assert.equal(p.fallbacks().length, 1, "撤图后回到中性占位");
  } finally { await p.close(); }
});

test("皮肤小图：失败态不跨显示周期残留（换走再绑回同一媒体、撤图再绑回都重新出图）", async () => {
  const p = await openThumb();
  try {
    await p.render("m_1");
    await React.act(async () => { p.img().dispatchEvent(new p.window.Event("error")); });
    assert.equal(p.fallbacks().length, 1, "首次失败显示占位");

    await p.render("m_2");
    assert.equal(p.img()?.getAttribute("src"), "/api/supply/media/m_2/content", "换到新媒体恢复出图");
    await p.render("m_1");
    const back = p.img();
    assert.ok(back, "失败态不得跨周期残留：重新绑回同一媒体必须再次尝试出图");
    assert.equal(back.getAttribute("src"), "/api/supply/media/m_1/content");
    assert.equal(p.fallbacks().length, 0, "绑回后不得残留占位");

    await React.act(async () => { p.img().dispatchEvent(new p.window.Event("error")); });
    await p.render(null);
    assert.equal(p.img(), null, "无图仍走中性占位");
    assert.equal(p.fallbacks().length, 1);
    await p.render("m_1");
    assert.ok(p.img(), "撤图后重新绑回同一媒体必须重新出图");
    assert.equal(p.fallbacks().length, 0, "重新绑回后不得残留占位");
  } finally { await p.close(); }
});

test("皮肤标题：保留服务端规范名，不在客户端按 owner/base 改写", () => {
  const { skinCardTitle } = loadThumbModule();
  assert.equal(skinCardTitle({ name: "服务端名" }), "服务端名");
  assert.equal(skinCardTitle({ name: "服务端名", ownerName: "威龙" }), "服务端名", "缺 baseName 不组合");
  assert.equal(skinCardTitle({ name: "服务端名", ownerName: "威龙", baseName: "凌霄戍卫" }), "服务端名");
  assert.equal(skinCardTitle({ name: "威龙-凌霄戍卫", ownerName: "威龙", baseName: "凌霄戍卫" }), "威龙-凌霄戍卫", "已带前缀不重复拼接");
  assert.equal(skinCardTitle({ name: "水墨云图", ownerName: "骇爪", baseName: "水墨云图" }), "水墨云图", "旧快照名称也不由客户端重写");
});

function skin12CatalogPage(categoryId, cursor) {
  const categories = [{ id: 'category_agent', name: '干员外观' }, { id: 'category_firearm', name: '枪械外观' }];
  const selected = categoryId || 'category_firearm';
  return { ...catalog, categories, skins: [{ id: `${selected}_${cursor ? 'second' : 'first'}`, code: 'fixture', name: `${selected} ${cursor ? '第二页' : '第一页'}`, categoryId: selected, mediaId: null }], nextCursor: cursor ? null : `${selected}_next` };
}

test('SKIN12 publish default category requests its own first page before exposing a cursor', async () => {
  const requests = [];
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration()), catalogValue: async (_game, query) => {
    requests.push(Object.fromEntries(query)); return skin12CatalogPage(query.get('categoryId'), query.get('cursor'));
  } });
  try {
    await p.render();
    assert.equal(await p.waitFor(() => requests.some(q => q.categoryId === 'category_agent')), true, '默认可见分类须读取同一分类的第一页');
    assert.match(p.host.querySelector('.skin-card-name')?.textContent ?? '', /category_agent/);
  } finally { await p.close(); }
});

test('SKIN12 publish load-more keeps the default category query and accepts its second page', async () => {
  const requests = [];
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration()), catalogValue: async (_game, query) => {
    requests.push(Object.fromEntries(query)); return skin12CatalogPage(query.get('categoryId'), query.get('cursor'));
  } });
  try {
    await p.render(); await p.clickButton('加载更多皮肤');
    assert.equal(await p.waitFor(() => requests.some(q => q.cursor === 'category_agent_next' && q.categoryId === 'category_agent')), true, '不能因空分类首包与默认分类 key 不同而静默丢掉加载更多');
    assert.equal(p.host.querySelectorAll('.skin-card').length, 2);
    assert.match(p.text(), /category_agent 第二页/);
  } finally { await p.close(); }
});

test('skin catalog owner/quality/search pagination keeps selected IDs and canonical names', async () => {
  const requests = [];
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration()), catalogValue: async (_game, query) => {
    requests.push(Object.fromEntries(query));
    const page = skin12CatalogPage(query.get('categoryId'), query.get('cursor'));
    return { ...page, categories: page.categories.map(category => ({ ...category, ownerKind: category.id === 'category_agent' ? 'AGENT' : 'FIREARM' })), owners: [{ id: 'owner_A', kind: 'AGENT', name: '测试干员' }, { id: 'owner_GUN', kind: 'FIREARM', name: '测试枪械' }], rarities: [{ code: 'legend', name: '传说' }] };
  } });
  const choose = async (label, text) => {
    await p.click(`button[aria-label="${label}"]`);
    const option = [...p.window.document.querySelectorAll('[role="option"]')].find(item => item.textContent.includes(text));
    assert.ok(option, text);
    if (label === '皮肤所属') assert.equal([...p.window.document.querySelectorAll('[role="option"]')].some(item => item.textContent.includes('测试枪械')), false, 'owner menu follows the full-catalog category kind');
    await React.act(async () => option.click());
    await p.waitFor(() => !p.host.textContent.includes('正在读取皮肤目录'));
  };
  try {
    await p.render();
    await p.click('input[aria-label="选择 category_agent 第一页"]');
    await choose('皮肤所属', '测试干员');
    assert.equal(await p.waitFor(() => requests.some(query => query.ownerId === 'owner_A')), true);
    await choose('皮肤品质', '传说');
    assert.equal(await p.waitFor(() => requests.some(query => query.ownerId === 'owner_A' && query.rarityCode === 'legend')), true);
    await p.type('.skin-search-input', '测试');
    await p.clickButton('查找');
    assert.equal(await p.waitFor(() => requests.some(query => query.q === '测试' && query.ownerId === 'owner_A' && query.rarityCode === 'legend')), true);
    await p.clickButton('加载更多皮肤');
    assert.equal(await p.waitFor(() => requests.some(query => query.cursor === 'category_agent_next' && query.q === '测试' && query.ownerId === 'owner_A' && query.rarityCode === 'legend')), true);
    assert.ok(p.host.querySelector('.supply-selected-chips [data-skin-id="category_agent_first"]'));
    assert.equal(p.host.querySelectorAll('input[aria-label="选择 category_agent 第一页"]:checked').length, 1);
    await choose('皮肤所属', '全部所属');
    assert.equal(requests.at(-1).ownerId, undefined);
    await p.clickButton('枪械外观');
    assert.equal(requests.at(-1).categoryId, 'category_firearm');
    assert.ok(p.host.querySelector('.supply-selected-chips [data-skin-id="category_agent_first"]'));
  } finally { await p.close(); }
});

test('skin append failure preserves loaded rows and selections, retry keeps the applied cursor query', async () => {
  const requests = [];
  let failNextPage = true;
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration()), catalogValue: async (_game, query) => {
    requests.push(Object.fromEntries(query));
    if (query.get('cursor') && failNextPage) { failNextPage = false; throw new actualSupply.SupplyRequestError(0, null); }
    return skin12CatalogPage(query.get('categoryId'), query.get('cursor'));
  } });
  try {
    await p.render();
    await p.click('input[aria-label="选择 category_agent 第一页"]');
    await p.type('.skin-search-input', '尚未点击查找');
    await p.clickButton('加载更多皮肤');
    assert.equal(await p.waitFor(() => p.text().includes('更多皮肤加载失败')), true);
    assert.equal(p.host.querySelectorAll('.skin-card').length, 1);
    assert.ok(p.host.querySelector('.supply-selected-chips [data-skin-id="category_agent_first"]'));
    await p.clickButton('重试皮肤目录');
    assert.equal(await p.waitFor(() => p.host.querySelectorAll('.skin-card').length === 2), true);
    assert.equal(requests.at(-1).cursor, 'category_agent_next');
    assert.equal(requests.at(-1).q, undefined, 'unapplied input never changes an existing cursor binding');
    assert.equal(p.host.querySelector('input[aria-label="选择 category_agent 第一页"]').checked, true);
  } finally { await p.close(); }
});


test('PUBLISH-02A: grading options with divisions render paired select and preserve state', async () => {
  const gradingOptionsWithDivisions = [
    { code: '4', displayName: '钻石', mappingStatus: 'CONFIRMED', issueCode: null, divisions: [4, 3, 2, 1] },
    { code: '8', displayName: '巅峰', mappingStatus: 'CONFIRMED', issueCode: null, divisions: [] },
  ];
  const p = await probe({
    accountId: 'account_1',
    editRequested: true,
    options: { ...optionsV1, gradingOptions: gradingOptionsWithDivisions },
    mine: () => supplyOf(declaration({ attributes: { ...declaration().attributes, grading_code: '4', grading_division: 2 } })),
  });
  try {
    await p.render();
    assert.ok(p.host.querySelector('[aria-label="账号段位"]'));
    const divisionSelect = p.host.querySelector('[aria-label="小段位"]');
    assert.ok(divisionSelect, '小段位选择器应该成对渲染');
    assert.match(divisionSelect.textContent ?? '', /2 级/);
  } finally { await p.close(); }
});

test('PUBLISH-02A: inventory stepper forwards describedBy and the required badge is removed', async () => {
  const p = await probe({
    mine: () => supplyOf(declaration()),
  });
  try {
    await p.render();
    const ammoInput = p.host.querySelector('input[aria-label="六级子弹数量"]');
    assert.ok(ammoInput);
    assert.match(ammoInput.getAttribute('aria-describedby') ?? '', /measure-/);

    assert.equal(p.host.querySelectorAll('.publish-required-note').length, 0, '核价必填标签已移除');
    assert.equal(p.host.querySelector('#publish-haff-balance')?.getAttribute('aria-required'), 'true', '余额仍保留必填语义');
  } finally { await p.close(); }
});

test('owner-income-preview: consumes real server response directly without client recalculation (READY, complete, zero, lines, haff, total)', async () => {
  let previewCalled = 0;
  const mockPreview = {
    schema: "owner-income-preview.v1",
    state: "READY",
    binding: {
      gameId: "game_1",
      releaseId: "release_1",
      releaseGeneration: "3",
      priceVersionId: "price_1",
      termVersionId: "term_1",
      catalogRevision: "1",
    },
    evaluatedAt: "2026-10-25T17:22:22.348Z",
    refreshAfter: "2026-10-25T17:22:52.348Z",
    rentalMode: "ordinary",
    ownerHaffRatioWanPerYuan: "60",
    termSeconds: "864000",
    lines: [
      {
        itemId: "item_round",
        code: "df_billable_level6_bullet",
        name: "六级子弹",
        quantity: "60",
        unit: "ROUND",
        unitQuantity: "60",
        ownerUnitAmount: { currency: "CNY", unit: "yuan", amount: "4.00000000", scale: 8 },
        ownerAmount: { currency: "CNY", unit: "yuan", amount: "4.00", scale: 2 },
      },
      {
        itemId: "item_haff",
        code: "df_billable_haff",
        name: "哈夫币",
        quantity: "100000000",
        unit: "HAFF_BASE",
        unitQuantity: "1000000",
        ownerUnitAmount: { currency: "CNY", unit: "yuan", amount: "1.66666667", scale: 8 },
        ownerAmount: { currency: "CNY", unit: "yuan", amount: "166.67", scale: 2 },
      },
      {
        itemId: "item_zero",
        code: "df_billable_coffee",
        name: "咖啡",
        quantity: "0",
        unit: "PIECE",
        unitQuantity: "1",
        ownerUnitAmount: { currency: "CNY", unit: "yuan", amount: "2.00000000", scale: 8 },
        ownerAmount: { currency: "CNY", unit: "yuan", amount: "0.00", scale: 2 },
      },
    ],
    ownerHaffIncome: { currency: "CNY", unit: "yuan", amount: "166.67", scale: 2 },
    ownerResourceIncome: { currency: "CNY", unit: "yuan", amount: "49.00", scale: 2 },
    knownResourceSubtotal: { currency: "CNY", unit: "yuan", amount: "49.00", scale: 2 },
    totalExpectedIncome: { currency: "CNY", unit: "yuan", amount: "215.67", scale: 2 },
    baseTenantDeposit: { currency: "CNY", unit: "yuan", amount: "300.00", scale: 2 },
    depositState: "KNOWN",
    missingFields: [],
    reasonCodes: [],
    unitAmountsInformational: true,
    estimateOnly: true,
    incomeBasis: "OWNER_RESOURCE_INCOME_BEFORE_FEES",
  };

  const declared = declaration({
    inventory: [
      { itemId: "item_haff", quantity: "100000000" },
      { itemId: "item_round", quantity: "60" },
    ],
  });

  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declared),
    ownerIncomePreview: async () => {
      previewCalled += 1;
      return mockPreview;
    },
  });

  try {
    await p.render();
    await previewTick();
    assert.ok(previewCalled >= 1, "ownerIncomePreview was called");
    assert.equal(p.calls.length, 0, "preview call does not produce persistent business writes");

    // Rail check
    const rail = p.host.querySelector("#publish-quote");
    assert.ok(rail);
    assert.match(rail.textContent, /215\.67 元/, "total expected income directly consumed");
    assert.match(rail.textContent, /166\.67/, "haff income directly consumed");
    assert.match(rail.textContent, /49\.00 元/, "resource income directly consumed");
    assert.match(rail.textContent, /60 万哈夫币\/元/, "nominal ratio directly consumed");
    assert.match(rail.textContent, /10 天/, "duration directly consumed");
    assert.match(rail.querySelector('.publish-rail-deposits').textContent, /300\.00/, "base tenant deposit directly consumed");
    assert.match(rail.textContent, /符合押金要求/);

    // Item line check
    const roundSubtotal = p.host.querySelector('[data-resource-code="df_billable_level6_bullet"] .publish-resource-subtotal output');
    if (roundSubtotal) assert.equal(roundSubtotal.textContent, "¥ 4.00");
  } finally {
    await p.close();
  }
});

test('owner-income-preview: PARTIAL state displays partial subtotal and does not claim full income', async () => {
  const partialPreview = {
    schema: "owner-income-preview.v1",
    state: "PARTIAL",
    binding: { gameId: "game_1", releaseId: "release_1", releaseGeneration: "3", priceVersionId: "price_1", termVersionId: "term_1", catalogRevision: "1" },
    evaluatedAt: "2026-10-25T17:22:22.348Z",
    refreshAfter: "2026-10-25T17:22:52.348Z",
    rentalMode: "ordinary",
    ownerHaffRatioWanPerYuan: null,
    termSeconds: null,
    lines: [],
    ownerHaffIncome: null,
    ownerResourceIncome: null,
    knownResourceSubtotal: { currency: "CNY", unit: "yuan", amount: "49.00", scale: 2 },
    totalExpectedIncome: null,
    baseTenantDeposit: null,
    depositState: "INCOMPLETE",
    missingFields: ["attributes.safe_box_code"],
    reasonCodes: [],
    unitAmountsInformational: true,
    estimateOnly: true,
    incomeBasis: "OWNER_RESOURCE_INCOME_BEFORE_FEES",
  };

  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration()),
    ownerIncomePreview: async () => partialPreview,
  });

  try {
    await p.render();
    await previewTick();
    const rail = p.host.querySelector("#publish-quote");
    assert.ok(rail);
    assert.doesNotMatch(rail.textContent, /预计总收入（权威核准）/);
    const resourceTotal = p.host.querySelector('[aria-label="物品预估收入"]');
    assert.ok(resourceTotal);
    assert.match(resourceTotal.textContent, /49\.00/);
    assert.equal(p.calls.length, 0);
  } finally {
    await p.close();
  }
});

test('owner-income-preview: primary submission pipeline runs save -> quote -> accept -> submit on unquoted draft', async () => {
  const declared = declaration({
    inventory: [
      { itemId: "item_haff", quantity: "60000000" },
      { itemId: "item_round", quantity: "60" },
    ],
    termOptionCode: "legacy_daily_10m",
  });

  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declared),
    saveDraft: (body, key, calls) => supplyOf(body),
    quote: (calls) => supplyOf(declared, { quote: ownerQuote }),
    confirm: (action, body, calls) => supplyOf(declared, { quote: ownerQuote, reviewState: action === 'submit' ? 'PUBLISHED' : 'DRAFT' }),
  });

  try {
    await p.render();
    await previewTick();

    // Check agreement
    await p.click('.publish-rail-footer input[type="checkbox"]');
    // Click primary submit button
    await p.clickButton('确认上架');

    assert.ok(await p.waitFor(() => p.calls.some(c => c.op === 'confirm' && c.action === 'submit')));
    assert.equal(p.calls.filter(c => c.op === 'saveDraft').length, 1);
    assert.equal(p.calls.filter(c => c.op === 'quote').length, 1);
    assert.equal(p.calls.filter(c => c.op === 'confirm').length, 2);
    assert.deepEqual(p.calls.filter(c => c.op === 'confirm').map(c => c.action), ['accept-rules', 'submit']);
  } finally {
    await p.close();
  }
});

test('owner-income-preview: proxy route whitelist regex accepts owner-income-preview and enforces 64KiB bound', async () => {
  const routeSource = fs.readFileSync(path.join(tree, "apps/web/src/app/api/supply/[...path]/route.ts"), "utf8");
  assert.match(routeSource, /games\/\$\{id\}\/owner-income-preview/, "postPath whitelist includes owner-income-preview");
  assert.match(routeSource, /64 \* 1024/, "readBoundedBody enforces 64KiB bound");
});

test('PUBLISH-03A: pricing and deposits follow resources and screenshots, with matching anchors', async () => {
  const p = await probe({ accountId: "account_1", mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    const groups = Array.from(p.host.querySelectorAll('.publish-groups > section')).map(s => s.getAttribute('data-publish-group'));
    assert.deepEqual(groups, ['account', 'assets', 'media', 'terms'], 'pricing and deposits belong at the end');
    const outlineAnchors = Array.from(p.host.querySelectorAll('.publish-outline-groups a')).map(a => a.getAttribute('href'));
    assert.deepEqual(outlineAnchors, ['#publish-group-account', '#publish-group-assets', '#publish-group-media', '#publish-group-terms']);
  } finally {
    await p.close();
  }
});

test('PUBLISH-03A: rail formatting, title, units and agreement modal reading', async () => {
  const p = await probe({
    accountId: "account_1",
    mine: () => supplyOf(declaration({ inventory: [{ itemId: "item_haff", quantity: "60000000" }] }), { quote: { ...ownerQuote, ownerHaffRatio: "50" } }),
  });
  try {
    await p.render();
    const rail = p.host.querySelector("#publish-quote");
    assert.ok(rail);
    assert.match(rail.querySelector("h2").textContent, /预计出租收入/);
    assert.match(rail.textContent, /哈夫币计价比例/);
    assert.match(rail.textContent, /50 万哈夫币\/元/);
    assert.match(rail.textContent, /基础租客押金.*不计入收入/);
    assert.doesNotMatch(rail.textContent, /名义号主比例/);
    assert.doesNotMatch(rail.textContent, /边填边计价/);
    assert.doesNotMatch(rail.textContent, /完成左侧条件/);
    const trigger = rail.querySelector(".publish-terms-inline-link");
    assert.ok(trigger, "modal reading button exists");
    assert.match(trigger.textContent, /出租协议/);
    const checkbox = rail.querySelector(".publish-confirm label.supply-check input");
    assert.equal(checkbox.checked, false, "terms must be explicitly accepted by user");
  } finally {
    await p.close();
  }
});

test('PUBLISH-03A: custom mode restricts daily consumption to 10M and checks range without clamping', async () => {
  const customOptions = {
    ...optionsV2,
    termOptions: [
      { code: "daily-10m", name: "10M/天", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" },
      { code: "daily-20m", name: "20M/天", dailyConsumption: "20000000", durationRounding: "CEIL_DAY" },
    ],
  };
  const p = await probe({
    accountId: "account_1",
    options: customOptions,
    mine: () => supplyOf(declaration({ termOptionCode: "daily-20m" })),
  });
  try {
    await p.render();
    const customChoice = [...p.host.querySelectorAll('[aria-label="出租比例"] .form-radio-choice')].find(el => el.textContent.includes('自定义'));
    assert.ok(customChoice, "custom choice label must exist");
    const customControl = customChoice.querySelector('.form-radio-control');
    assert.ok(customControl, "custom radio control must exist");
    await React.act(async () => { customControl.click(); });

    const term10m = [...p.host.querySelectorAll('[aria-label="每日消耗"] .form-radio-choice')].find(el => el.textContent.includes('10 M'));
    const term20m = [...p.host.querySelectorAll('[aria-label="每日消耗"] .form-radio-choice')].find(el => el.textContent.includes('20 M'));
    assert.ok(term10m, "10M choice must exist");
    assert.ok(term20m, "20M choice must exist");
    assert.equal(term10m.classList.contains('is-selected'), true, "10M must be selected");
    const control20m = term20m.querySelector('.form-radio-control');
    const is20mDisabled = Boolean(control20m?.hasAttribute('disabled') || control20m?.hasAttribute('data-disabled') || control20m?.getAttribute('aria-disabled') === 'true');
    assert.equal(is20mDisabled, true, "20M must be disabled");

    // Out of range check
    await p.type('input[aria-label="兑换比例"]', '50');
    assert.match(p.text(), /不在当前允许范围/);
  } finally {
    await p.close();
  }
});

test('PUBLISH-03A return: a new payout selection can read current terms before quoting without writing', async () => {
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(selectedPayoutDeclaration()),
    fullPayoutTerms: async () => ({ releaseId: 'release_1', fullPayoutTerms: ownerPayoutTerms }) });
  try {
    await p.render();
    assert.ok(await p.waitFor(() => p.calls.some(call => call.op === 'fullPayoutTerms')));
    assert.equal(p.host.querySelector('.publish-payout-acceptance input').disabled, false);
    assert.equal(p.host.querySelector('.publish-payout-acceptance input').checked, false);
    assert.deepEqual(p.calls.map(call => call.op), ['fullPayoutTerms']);
  } finally { await p.close(); }
});

test('PUBLISH-03A return: payout quote requires fresh sealed consent before acceptance or publication', async () => {
  const selected = selectedPayoutDeclaration();
  const quoted = supplyOf(selected, { quote: ownerQuote, revision: '6' });
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(selected),
    fullPayoutTerms: async () => ({ releaseId: 'release_1', fullPayoutTerms: ownerPayoutTerms }),
    saveDraft: () => supplyOf(selected), quote: () => quoted });
  try {
    await p.render();
    assert.ok(await p.waitFor(() => !p.host.querySelector('.publish-payout-acceptance input').disabled));
    await p.click('.publish-agreement-acceptance input');
    await p.click('.publish-payout-acceptance input');
    await p.clickButton('确认上架');
    assert.ok(await p.waitFor(() => p.calls.some(call => call.op === 'quote')));
    assert.equal(p.calls.some(call => call.op === 'confirm'), false, 'a pre-quote reading cannot accept the frozen quote');
    assert.equal(p.host.querySelector('.publish-payout-acceptance input').checked, false);
  } finally { await p.close(); }
});

test('PUBLISH-03A return: a misleading term name never substitutes for the actual 10M consumption', async () => {
  const p = await probe({ accountId: 'account_1', mine: () => supplyOf(declaration()), options: {
    ...optionsV2, termOptions: [
      { code: 'misleading-10m', name: '10M/天', dailyConsumption: '20000000', durationRounding: 'CEIL_DAY' },
      { code: 'opaque-real-term', name: '当前低日耗', dailyConsumption: '10000000', durationRounding: 'CEIL_DAY' },
    ],
  } });
  try {
    await p.render();
    const custom = [...p.host.querySelectorAll('[aria-label="出租比例"] .form-radio-choice')].find(el => el.textContent.includes('自定义'));
    await p.click('[aria-label="出租比例"] .form-radio-choice:nth-child(2) .form-radio-control');
    assert.ok(custom);
    assert.match(p.host.querySelector('[aria-label="每日消耗"] .is-selected').textContent, /10 M/);
    assert.doesNotMatch(p.host.querySelector('[aria-label="每日消耗"] .is-selected').textContent, /20 M/);
  } finally { await p.close(); }
});

test('PUBLISH-03C: declarations start unanswered and saving a draft does not inject false or clear legacy source', async () => {
  const original = declaration({ attributes: { ...declaration().attributes, info_source: '历史渠道原文' } });
  const p = await probe({ accountId: 'account_1', options: options03C, mine: () => supplyOf(original) });
  try {
    await p.render();
    for (const label of ['下赛季通行证', '解锁德穆兰']) assert.equal(p.host.querySelectorAll(`[aria-label="${label}"] [role="radio"][aria-checked="true"]`).length, 0);
    assert.match(p.text(), /历史渠道原文/);
    await p.clickButton('保存草稿');
    const saved = p.calls.find(c => c.op === 'saveDraft');
    assert.ok(saved);
    assert.equal(Object.hasOwn(saved.body.attributes, 'next_season_pass'), false);
    assert.equal(Object.hasOwn(saved.body.attributes, 'demulan_unlocked'), false);
    assert.equal(saved.body.attributes.info_source, '历史渠道原文');
  } finally { await p.close(); }
});

test('PUBLISH-03C: explicit false is valid JSON boolean and survives editing and draft saving', async () => {
  const p = await probe({ accountId: 'account_1', options: options03C, mine: () => supplyOf(declaration()) });
  try {
    await p.render();
    for (const label of ['下赛季通行证', '解锁德穆兰']) await p.click(`[aria-label="${label}"] .form-radio-choice:nth-child(2) [role="radio"]`);
    await p.clickButton('保存草稿');
    const saved = p.calls.find(c => c.op === 'saveDraft');
    assert.equal(saved.body.attributes.next_season_pass, false);
    assert.equal(saved.body.attributes.demulan_unlocked, false);
  } finally { await p.close(); }
});

test('PUBLISH-03C: an existing quote cannot accept or publish while a required new declaration is unanswered', async () => {
  const p = await probe({ accountId: 'account_1', options: options03C, mine: () => supplyOf(declaration(), { quote: ownerQuote }) });
  try {
    await p.render();
    await p.click('.publish-agreement-acceptance input');
    await p.clickButton('确认上架');
    assert.match(p.text(), /请明确选择下赛季通行证计划/);
    assert.equal(p.calls.some(c => c.op === 'confirm'), false);
  } finally { await p.close(); }
});

function completeNetPreview(selected = true) {
  const amount = amount => ({ currency: 'CNY', unit: 'yuan', amount, scale: 2 });
  return { schema: 'owner-income-preview.v1', state: 'READY', binding: { gameId: 'game_1', releaseId: 'release_1', releaseGeneration: '1', priceVersionId: 'p1', termVersionId: 't1', catalogRevision: '1' },
    totalExpectedIncome: amount('215.67'), ownerHaffIncome: amount('166.67'), ownerResourceIncome: amount('49.00'), knownResourceSubtotal: amount('49.00'), lines: [], termSeconds: '864000', ownerHaffRatioWanPerYuan: '60', depositState: 'KNOWN', baseTenantDeposit: amount('300.00'), reasonCodes: [], missingFields: [],
    normalEndEstimate: { schema: 'owner-normal-end-estimate.v1', state: 'READY', scenario: 'ALL_DECLARED_INVENTORY_CONSUMED_NORMAL_END', selected, ownerGross: amount('215.67'),
      serviceFee: { base: amount(selected ? '215.67' : '0.00'), rate: selected ? '0.08' : '0', amount: amount(selected ? '17.25' : '0.00'), payer: selected ? 'OWNER' : 'NONE' }, ownerNet: amount(selected ? '198.42' : '215.67'), policy: selected ? { fullPayoutPolicyRef: 'p', fullPayoutPolicyVersion: '1', disclosureVersion: 'd' } : null },
  };
}

test('PUBLISH fee read: net is a current server field, and non-pricing declarations never enter the preview body', async () => {
  const inputs = [];
  const declared = declaration({ inventory: [{ itemId: 'item_haff', quantity: '100000000' }], attributes: { ...declaration().attributes, next_season_pass: false, demulan_unlocked: true, info_source: 'a', full_payout_declaration: { schema: 'full-payout-declaration-v1', selected: true } } });
  const p = await probe({ accountId: 'account_1', options: options03C, mine: () => supplyOf(declared), ownerIncomePreview: async (_game, input) => { inputs.push(input); return completeNetPreview(); } });
  try {
    await p.render(); await previewTick();
    assert.equal(p.host.querySelector('[aria-label="预计净所得"]').textContent, '198.42 元');
    assert.match(p.host.querySelector('.publish-fee-pending').textContent, /215\.67.*17\.25/);
    for (const key of ['next_season_pass', 'demulan_unlocked', 'info_source']) assert.equal(Object.hasOwn(inputs.at(-1).attributes, key), false);
    await p.type('#publish-haff-balance', '101');
    await React.act(async () => { await new Promise(r => setTimeout(r, 5)); });
    assert.equal(p.host.querySelector('[aria-label="预计净所得"]'), null, 'editing pricing input invalidates the old net immediately');
    assert.equal(p.calls.some(c => ['saveDraft', 'quote', 'confirm'].includes(c.op)), false);
  } finally { await p.close(); }
});

test("FAST-WEB-CONSUME-1 only-min fast range is shown without inventing an upper bound", async () => {
  const options = {
    ...optionsV2,
    rentalModes: { ...optionsV2.rentalModes, fast: { enabled: true, min: { base: "C", value: "6" } } },
  };
  const p = await probe({ mode: "fast", accountId: "account_1", options, mine: () => supplyOf(declaration({ title: "fast only-min" })) });
  try {
    await p.render();
    await p.waitFor(() => p.text().includes("最低 普通比例+6"));
    assert.match(p.text(), /允许范围（万哈夫币\/元）：最低 普通比例\+6/);
    assert.doesNotMatch(p.text(), /允许范围需读取当前规则后确认/);
    assert.match(p.text(), /当前使用极速出租/);
  } finally { await p.close(); }
});

test("FAST-WEB-CONSUME-1 missing fast config refuses the fast entry instead of assuming enabled", async () => {
  const options = { ...optionsV2, rentalModes: { ordinary: { enabled: true }, custom: optionsV2.rentalModes.custom } };
  const p = await probe({ mode: "fast", accountId: "account_1", options, mine: () => supplyOf(declaration({ title: "fast missing" })) });
  try {
    await p.render();
    assert.match(p.text(), /极速比例当前未启用/);
    assert.match(p.text(), /当前规则未提供极速比例范围，不能以极速入口上架/);
    assert.doesNotMatch(p.text(), /已按极速入口切换为极速比例/);
    assert.equal(p.calls.some((call) => call.op === "quote"), false);
  } finally { await p.close(); }
});

test("FAST-WEB-CONSUME-1 absolute only-min rejects a value below the server lower bound", async () => {
  const options = {
    ...optionsV2,
    rentalModes: { ...optionsV2.rentalModes, fast: { enabled: true, min: { base: "ABSOLUTE", value: "48" } } },
  };
  const p = await probe({ mode: "fast", accountId: "account_1", options, mine: () => supplyOf(declaration({ title: "fast bound" })) });
  try {
    await p.render();
    await p.type('input[aria-label="兑换比例"]', "40");
    await p.type('input[aria-label$="（M）"]', "60");
    await p.click('.publish-rail-actions input[type="checkbox"]');
    await p.clickButton("确认上架");
    assert.match(p.text(), /已不在当前允许范围（最低 48，万哈夫币\/元）/);
    assert.equal(p.calls.some((call) => call.op === "quote"), false);
  } finally { await p.close(); }
});

test("FAST-REPAIR F1 fast 48-99 accepts 50 in the inline hint and on submit", async () => {
  const p = await probe({ mode: "fast", accountId: "account_1", options: optionsV2, mine: () => supplyOf(declaration({ title: "fast inline legal" })) });
  try {
    await p.render();
    await p.waitFor(() => p.text().includes("当前使用极速出租"));
    await p.type('input[aria-label="兑换比例"]', "50");
    assert.doesNotMatch(p.text(), /自定义比例（50）/);
    assert.doesNotMatch(p.text(), /极速比例（50）已不在当前允许范围/);
    await p.type('input[aria-label$="（M）"]', "60");
    await p.clickButton("保存草稿");
    await p.waitFor(() => p.calls.some((call) => call.op === "saveDraft"));
    const save = p.calls.filter((call) => call.op === "saveDraft").at(-1);
    assert.deepEqual(save.body.attributes.rentalPricing, { rentalMode: "fast", ownerRatioB: "50" });
    assert.doesNotMatch(p.text(), /已不在当前允许范围/);
  } finally {
    await p.close();
  }
});

test("FAST-REPAIR F1 only-min C+6 leaves the client bound to the server", async () => {
  const options = { ...optionsV2, rentalModes: { ...optionsV2.rentalModes, fast: { enabled: true, min: { base: "C", value: "6" } } } };
  const p = await probe({ mode: "fast", accountId: "account_1", options, mine: () => supplyOf(declaration({ title: "fast C only-min" })) });
  try {
    await p.render();
    await p.waitFor(() => p.text().includes("最低 普通比例+6"));
    await p.type('input[aria-label="兑换比例"]', "50");
    assert.doesNotMatch(p.text(), /已不在当前允许范围/);
    assert.doesNotMatch(p.text(), /自定义比例（50）/);
  } finally {
    await p.close();
  }
});

test("FAST-REPAIR F1 only-max fast rejects above the upper bound and accepts inside it", async () => {
  const options = { ...optionsV2, rentalModes: { ...optionsV2.rentalModes, fast: { enabled: true, max: { base: "ABSOLUTE", value: "99" } } } };
  const p = await probe({ mode: "fast", accountId: "account_1", options, mine: () => supplyOf(declaration({ title: "fast only-max" })) });
  try {
    await p.render();
    await p.waitFor(() => p.text().includes("最高 99"));
    await p.type('input[aria-label="兑换比例"]', "50");
    assert.doesNotMatch(p.text(), /已不在当前允许范围/);
    await p.type('input[aria-label="兑换比例"]', "120");
    assert.match(p.text(), /极速比例（120）已不在当前允许范围（最高 99，万哈夫币\/元）/);
  } finally {
    await p.close();
  }
});

test("FAST-REPAIR F1 custom 39-41 keeps its own inline bound", async () => {
  const custom = declaration({ title: "custom regression", attributes: { ...declaration().attributes, rentalPricing: { rentalMode: "custom", ownerRatioB: "40" } } });
  const p = await probe({ accountId: "account_1", options: optionsV2, mine: () => supplyOf(custom) });
  try {
    await p.render();
    await p.waitFor(() => p.text().includes("自定义比例"));
    await p.type('input[aria-label="兑换比例"]', "50");
    assert.match(p.text(), /自定义比例（50）已不在当前允许范围（39 ~ 41，万哈夫币\/元）/);
    await p.type('input[aria-label="兑换比例"]', "40");
    assert.doesNotMatch(p.text(), /自定义比例（40）已不在当前允许范围/);
  } finally {
    await p.close();
  }
});
