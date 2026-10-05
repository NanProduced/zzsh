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
    { id: "item_round", code: "level6_bullet", name: "六级子弹", unit: "ROUND", quantityScale: 0, required: false, sortOrder: 1 },
  ],
  categories: [], rarities: [], skins: [], entitlements: [], nextCursor: null, limit: 30,
};
const optionsV1 = {
  releaseId: "release_1", generation: "1",
  termOptions: [{ code: "daily-10m", name: "10M/天", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }],
  safeBoxCodes: ["box-a"], vitalityLevels: [6, 7], bearLevels: [6, 7], pricingOptionCodes: ["standard"],
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
        { id: "item_round", code: "level6_bullet", name: "六级子弹", unit: "ROUND", priced: true },
      ],
      quote,
    },
    agreement: optionsV1.agreement, available: true, blockers: [],
  };
}

async function probe({ mode = "standard", accountId, editRequested = false, gameCode = "delta", options = optionsV1, mine, saveDraft, quote, confirm, depositRecommendation } = {}) {
  const window = new Window({ url: "http://127.0.0.1:3100/publish" });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    DOMParser: window.DOMParser, Event: window.Event, MouseEvent: window.MouseEvent, DOMException: window.DOMException, IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  const session = { status: "authenticated", userId: "user_A", identityVersion: 1, revalidations: 0, revalidate() { this.revalidations += 1; } };
  const listeners = new Set();
  const store = {
    getSnapshot: () => session,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    confirm: async () => { session.revalidations += 1; for (const listener of listeners) listener(); return true; },
  };
  const router = { replace() {}, push() {} };
  const calls = [];
  const api = {
    games: async () => ({ games }),
    publishingOptions: async () => options,
    catalog: async () => catalog,
    mine: async () => (typeof mine === "function" ? mine() : mine),
    createAccount: async () => ({ accountId: "account_1", gameId: "game_1" }),
    createDraft: async () => supplyOf(declaration()),
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
    if (name === "next/link") return ({ children, href, ...props }) => React.createElement("a", { href, ...props }, children);
    if (name === "next/navigation") return { useRouter: () => router };
    if (name === "../session/user-session-provider") return { useUserSessionStore: () => store, useUserSession: () => session };
    if (name === "../layout/service-shell") return { ServiceShell: ({ children }) => React.createElement("main", null, children) };
    if (name === "../../lib/supply-client") return { ...actualSupply, supplyApi: api, uploadSupplyMedia: async () => null };
    if (name.startsWith("../../lib/")) return require(path.join(tree, "apps/web/src/lib", `${name.slice(10)}.ts`));
    return require(name);
  };
  module._compile(compiled, module.filename);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  const settle = async (turns = 5) => {
    for (let index = 0; index < turns; index += 1) {
      await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  return {
    host, session, calls, window,
    text: () => host.textContent ?? "",
    findButton: (label) => [...host.querySelectorAll("button")].find((button) => (button.textContent ?? "").includes(label) && !button.disabled),
    async render() {
      await React.act(async () => {
        root.render(React.createElement(module.exports.PublishForm, { mode, accountId, editRequested, gameCode }));
      });
      await settle();
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
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(element, value);
        element.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await settle();
    },
    async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); },
  };
}

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
    assert.match(p.text(), /账号名称/);
    await p.type('input[placeholder^="例如：满仓"]', "edited-after-unknown");
    await p.clickButton("保存草稿");
    await p.waitFor(() => p.text().includes("结果未知"));
    assert.match(p.text(), /结果未知/);
    const titleInput = p.host.querySelector('input[placeholder^="例如：满仓"]');
    assert.equal(titleInput.disabled, true, "fields freeze while the write result is unknown");
    await p.type('input[placeholder^="例如：满仓"]', "changed-during-unknown");
    const saves = p.calls.filter((call) => call.op === "saveDraft");
    assert.equal(saves.length, 1);
    await p.clickButton("重试当前步骤");
    await p.waitFor(() => p.text().includes("草稿已保存"));
    const retried = p.calls.filter((call) => call.op === "saveDraft");
    assert.equal(retried.length, 2);
    assert.equal(retried[1].key, saves[0].key, "the retry replays the original idempotency key");
    assert.deepEqual(retried[1].body, saves[0].body, "the retry replays the frozen body");
    assert.equal(retried[1].body.title, "edited-after-unknown", "edits during the unknown window never enter the frozen intent");
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
    await p.type(".supply-ratio-value input", "48");
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
    await p.type('input[placeholder^="例如：满仓"]', "recommend target edited");
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
    await p.type('input[placeholder^="例如：满仓"]', "changed again");
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
    await p.type('input[aria-label$="六级子弹数量"]', "120");
    await p.waitFor(() => p.text().includes("每 60 发为 1 组：2 组"));
    assert.match(p.text(), /每 60 发为 1 组：2 组/);
    await p.type('input[aria-label$="六级子弹数量"]', "121");
    await p.waitFor(() => p.text().includes("每 60 发为 1 组：2 组 1 发"));
    assert.match(p.text(), /每 60 发为 1 组：2 组 1 发/);
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
    await p.type('input[placeholder^="例如：满仓"]', "pending-new-value");
    await p.clickButton("保存草稿");
    await p.waitFor(() => p.text().includes("结果未知"));
    await p.clickButton("重新读取最新状态");
    const title = p.host.querySelector('input[placeholder^="例如：满仓"]');
    assert.equal(title.disabled, true, "old GET is not evidence that the original write failed or finished");
    assert.equal(title.value, "pending-new-value", "the pending input is not overwritten by a generic read");
    assert.match(p.text(), /结果未知/);
    await p.clickButton("重试当前步骤");
    await p.waitFor(() => p.text().includes("结果未知"));
    assert.equal(p.host.querySelector('input[placeholder^="例如：满仓"]').disabled, true, "a still-unknown retry keeps the lock");
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
    await p.type('input[placeholder^="例如：满仓"]', "changed after adoption");
    await p.waitFor(() => p.text().includes("已过期"));
    assert.match(p.text(), /已过期/);
  } finally {
    await p.close();
  }
});

test("mobile terms action opens and focuses terms without consenting or submitting", async () => {
  const p = await probe({accountId:"account_1", mine:()=>({...supplyOf(declaration({title:"quoted"}), {quote:ownerQuote}),blockers:["PUBLICATION_REQUIRED","CONFIRMATION_OR_MEDIA_REQUIRED"]})});
  try {
    await p.render();
    assert.doesNotMatch(p.text(), /公开发布事实尚未形成/);
    await p.click(".publish-mobile-actions .primary");
    assert.equal(p.host.querySelector(".publish-terms").open,true);
    assert.equal(p.window.document.activeElement,p.host.querySelector(".publish-terms summary"));
    assert.equal(p.host.querySelector(".publish-confirm input").checked,false);
    assert.equal(p.calls.some(c=>c.op==="confirm"),false);
    assert.equal(p.host.querySelectorAll("h2.publish-group-title").length,4);
    assert.ok(p.host.querySelector('[aria-label="编辑账号资料"]'));
  } finally { await p.close(); }
});

test("missing title focuses the designated title field rather than the first select", async () => {
  const p=await probe({accountId:"account_1",mine:()=>supplyOf(declaration({title:""}))});
  try {
    await p.render(); await p.clickButton("核对报价");
    assert.match(p.text(), /请先填写账号名称/);
    assert.equal(p.window.document.activeElement,p.host.querySelector('input[placeholder^="例如：满仓"]'));
    assert.equal(p.calls.some(c=>c.op==="quote"),false);
  } finally { await p.close(); }
});


test("legacy agreement markup renders readable inert text while retaining the original body", async () => {
  const body='<h3>真实条款</h3><p>请阅读<strong>条件</strong>。</p><table><tr><td>物品</td><td>金额</td></tr></table><script>bad()</script>';
  const data={...supplyOf(declaration({title:"agreement"}),{quote:ownerQuote}),agreement:{...optionsV1.agreement,body}};
  const p=await probe({accountId:"account_1",mine:()=>data});
  try {await p.render();const node=p.host.querySelector('.publish-terms-body');assert.match(node.textContent,/真实条款\n请阅读条件/);assert.match(node.textContent,/物品\t金额/);assert.doesNotMatch(node.textContent,/<h3>|bad/);assert.equal(node.querySelector('script'),null);assert.equal(data.agreement.body,body);}finally{await p.close();}
});
