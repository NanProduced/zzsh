import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(testDirectory, "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const typescript = requireFromTree("typescript");
const React = requireFromTree("react");
const { Window } = requireFromTree("happy-dom");
const intents = requireFromTree(path.join(tree, "apps/web/src/lib/order-intents.ts"));

function compile(relativePath) {
  const source = fs.readFileSync(path.join(tree, relativePath), "utf8");
  return typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
}

function loadComponent(relativePath, session, extra) {
  const module = new Module(path.join(tree, "order-trade-component-probe.cjs"));
  module.filename = path.join(tree, "order-trade-component-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "next/link") return function Link({ scroll: _scroll, ...props }) { return React.createElement("a", props); };
    if (name === "@/components/session/user-session-provider") return { useUserSession: () => session };
    if (name === "@/lib/order-client") return requireFromTree(path.join(tree, "apps/web/src/lib/order-client.ts"));
    if (name === "@/lib/order-intents") return requireFromTree(path.join(tree, "apps/web/src/lib/order-intents.ts"));
    if (name === "@/lib/order-display") return requireFromTree(path.join(tree, "apps/web/src/lib/order-display.ts"));
    if (name === "@/components/session/identity-reset") return requireFromTree(path.join(tree, "apps/web/src/components/session/identity-reset.ts"));
    if (name === "@/components/order/order-trade-actions") return loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session);
    if (name === "./rental-price-summary") return loadComponent("apps/web/src/components/order/rental-price-summary.tsx", session);
    if (name === "@/components/ui/tooltip") return { Tooltip: props => React.createElement(React.Fragment, null, props.children), TooltipTrigger: props => React.createElement(React.Fragment, null, props.children), TooltipContent: () => null };
    if (extra && Object.hasOwn(extra, name)) return extra[name];
    if (name.endsWith(".css")) return {};
    return requireFromTree(name);
  };
  module._compile(compile(relativePath), module.filename);
  return module.exports;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((next) => { resolve = next; }); return { promise, resolve }; }

async function withDom(run) {
  const window = new Window({ url: "http://127.0.0.1/accounts" });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    Event: window.Event, MouseEvent: window.MouseEvent, CustomEvent: window.CustomEvent, DOMException: window.DOMException,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  try { await run(window); } finally { await window.happyDOM.abort(); }
}

function createProbe(window, Component, props, fetchImpl, { strict = false } = {}) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = requireFromTree("react-dom/client").createRoot(host);
  const render = async (nextProps = props) => {
    const element = React.createElement(Component, nextProps);
    await React.act(async () => { root.render(strict ? React.createElement(React.StrictMode, null, element) : element); });
    await tick();
  };
  const buttons = () => [...host.querySelectorAll("button")].map((button) => button.textContent ?? "");
  const click = async (text) => {
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
    assert.ok(button, `button not found: ${text}; have ${JSON.stringify(buttons())}; text=${host.textContent?.slice(0, 300)}`);
    await React.act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 })); await tick(); });
    await tick();
  };
  const setInput = async (label, value) => {
    const input = host.querySelector(`[aria-label="${label}"]`);
    assert.ok(input, `input not found: ${label}`);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    await React.act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    await tick();
    return input;
  };
  const unmount = async () => { await React.act(async () => root.unmount()); await tick(); };
  const dispose = async (removeIntent) => {
    await unmount();
    globalThis.fetch = previousFetch;
    if (removeIntent) removeIntent();
  };
  return { host, render, click, setInput, unmount, dispose, buttons };
}

const orderClient = requireFromTree(path.join(tree, "apps/web/src/lib/order-client.ts"));
const OrderRequestError = orderClient.OrderRequestError;
const money = (amount) => ({ currency: "CNY", unit: "yuan", scale: 2, amount });
const haffLine = { itemId: "item_haff", name: "哈夫币", unit: "HAFF_BASE", quantity: "1000", buyerAmount: money("150.00") };
const pieceLine = { itemId: "item_piece", name: "测试物品", unit: "PIECE", quantity: "10", buyerAmount: money("20.00") };
const paidOrder = {
  id: "order_A", displayNo: "ZZ-1", title: "交易闭环样本", status: "PAID",
  amounts: { rental: money("170.00"), deposit: money("300.00"), totalDue: money("470.00") },
  quote: { lines: [haffLine, pieceLine] },
};
const opening = {
  id: "opening_1", versionNo: "1", status: "CONFIRMED",
  lines: [
    { itemId: "item_haff", quantity: "1000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO" },
    { itemId: "item_piece", quantity: "10", unit: "PIECE", pricingKind: "FIXED_UNIT" },
  ],
  acks: [{ party: "RENTER" }, { party: "OWNER" }],
};
const settlementBody = { orderId: "order_A", rentalStarted: true, openings: [opening], intakes: [], versions: [], currentRequest: null, settlement: null, posting: null, ready: false, reasons: ["SETTLEMENT_REQUIRED"] };
const previewBody = {
  accepted: false, reasons: [], versionHash: "f".repeat(64),
  amounts: { haffConsumedBuyer: money("150.00"), itemConsumedBuyer: money("4.00"), unusedItemRefund: money("16.00"), unusedHaffRefund: money("0.00"), earlyMakeup: money("0.00"), renterCharge: money("154.00"), renterRefund: money("316.00"), depositRefund: money("300.00"), feeAmount: money("9.84"), feeRate: "0.08", feePayer: "OWNER", haffConsumedOwner: money("120.00"), itemConsumedOwner: money("3.00"), ownerGross: money("123.00"), ownerNet: money("113.16") },
  consumed: { haff: "1000", items: [{ itemId: "item_piece", consumed: "2", remaining: "8" }] },
};

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

function router(routes, log) {
  return async (url, init = {}) => {
    const target = String(url);
    const method = (init.method ?? "GET").toUpperCase();
    const key = init.headers?.get?.("idempotency-key") ?? undefined;
    const entry = { url: target, method, key, body: init.body ? JSON.parse(init.body) : undefined };
    log.push(entry);
    const route = routes.find((candidate) => target.includes(candidate.match) && candidate.method === method);
    assert.ok(route, `unexpected fetch ${method} ${target}`);
    return route.respond(entry);
  };
}

const session = (userId) => ({ status: "authenticated", userId, identityVersion: 1, revalidate() {}, confirm: async () => "authenticated", signOut: async () => undefined });

test("F3: blank and negative quantities are refused as unknown, never coerced to 0 or positive", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "/settlement", method: "GET", respond: () => json(settlementBody) }], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    assert.ok(probe.host.textContent.includes("发起结束"));
    const input = await probe.setInput("哈夫币 期末剩余数量", "");
    assert.equal(input.value, "");
    await probe.click("预览结算金额");
    assert.ok(probe.host.textContent.includes("留空表示未知"), probe.host.textContent.slice(0, 300));
    assert.equal(log.filter((entry) => entry.url.includes("settlement-preview")).length, 0);
    const negative = await probe.setInput("哈夫币 期末剩余数量", "-5");
    assert.equal(negative.value, "-5");
    await probe.click("预览结算金额");
    assert.ok(probe.host.textContent.includes("必须是 0 或正整数"), probe.host.textContent.slice(0, 300));
    assert.equal(log.filter((entry) => entry.url.includes("settlement-preview")).length, 0);
    await probe.dispose();
  });
});

test("F3: editing after a preview invalidates it and a late preview response is dropped", async () => {
  await withDom(async (window) => {
    const log = [];
    const pending = deferred();
    let previewCalls = 0;
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json(settlementBody) },
      { match: "settlement-preview", method: "POST", respond: () => { previewCalls += 1; return previewCalls === 1 ? pending.promise : json(previewBody); } },
    ], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("预览结算金额");
    await probe.setInput("测试物品 期末剩余数量", "7");
    pending.resolve(json(previewBody));
    await tick(); await tick();
    assert.ok(!probe.host.textContent.includes("提交结算"), "stale preview must not render after an edit");
    await probe.click("预览结算金额");
    await tick();
    assert.ok(probe.host.textContent.includes("¥316.00"), "concrete amounts render after a fresh preview");
    assert.ok(probe.host.textContent.includes("¥154.00"), "the renter charge renders");
    assert.ok(!probe.host.textContent.includes("¥113.16"), "the renter projection must not leak owner-side internals");
    assert.ok(probe.host.textContent.includes("7 件"), "consumed table shows the entered remaining quantity");
    assert.ok(probe.host.textContent.includes("2 件"), "consumed table shows the server-bound consumed quantity");
    await probe.setInput("测试物品 期末剩余数量", "6");
    assert.ok(!probe.host.textContent.includes("提交结算"), "editing clears the accepted preview");
    await probe.dispose();
  });
});

test("F2: an unknown settlement submit retries with the original key and body", async () => {
  await withDom(async (window) => {
    const log = [];
    let submitCalls = 0;
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json(settlementBody) },
      { match: "settlement-preview", method: "POST", respond: () => json(previewBody) },
      { match: "/settlements", method: "POST", respond: () => { submitCalls += 1; if (submitCalls === 1) throw new TypeError("network down"); return json({ ok: true }); } },
    ], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("预览结算金额");
    await probe.click("提交结算");
    assert.ok(probe.host.textContent.includes("结果未知"), probe.host.textContent.slice(0, 300));
    await probe.click("查询原请求结果");
    const submits = log.filter((entry) => entry.method === "POST" && /\/settlements$/.test(entry.url));
    assert.equal(submits.length, 2);
    assert.equal(submits[0].key, submits[1].key);
    assert.deepEqual(submits[0].body, submits[1].body);
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.submit", "order_A"));
  });
});

test("F2: an unknown payment retries the original key and never double-charges", async () => {
  await withDom(async (window) => {
    const log = [];
    let payCalls = 0;
    const pendingOrder = { ...paidOrder, status: "PENDING_PAYMENT" };
    const fetchImpl = router([
      { match: "payment-requests", method: "POST", respond: () => { payCalls += 1; if (payCalls === 1) throw new TypeError("network down"); return json({ payment: { confirmationId: "payment_1", disposition: "APPLIED", replay: true } }); } },
    ], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: pendingOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("提交本地受控支付");
    assert.ok(probe.host.textContent.includes("支付结果未知"), probe.host.textContent.slice(0, 300));
    await probe.click("查询原请求结果");
    const pays = log.filter((entry) => entry.url.includes("payment-requests"));
    assert.equal(pays.length, 2);
    assert.equal(pays[0].key, pays[1].key);
    assert.ok(probe.host.textContent.includes("支付已接纳"));
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});

const confirmation = {
  quote: { lines: [haffLine, pieceLine], resourceTotal: money("170.00"), tenantDeposit: money("300.00"), tenantPayableTotal: money("470.00") },
  baseTenantDeposit: money("300.00"), customerTier: "STANDARD", depositWaived: false,
  compensationDisclosure: { selected: true, disclosureVersion: "dual-line-disclosure-v1" },
  confirmationId: "c1", listingHash: "h".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString(), confirmationToken: "token_1",
};
const publishingOptions = { releaseId: "release_1", agreement: { id: "ag_1", title: "三角洲出租协议", body: "协议正文（TEST_ONLY）", digest: "d".repeat(64) } };

function loadPanelForSession(sessionObject, optionsResponder) {
  return loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", sessionObject, {
    "@/lib/listing-view": { formatMoneyLabel: (value) => (value && typeof value.amount === "string" ? `¥${value.amount}` : null) },
    "@/lib/supply-client": { supplyApi: { publishingOptions: optionsResponder } },
  }).RentalConfirmPanel;
}

function loadPanel(sessionUser, optionsResponder) {
  return loadPanelForSession(session(sessionUser), optionsResponder);
}

const referenceFees = { total: "¥295.91", haff: "¥256.41", items: "¥39.50" };
const detailPanelProps = { accountId: "detail_price", gameId: "game_1", versionId: "listing_1", releaseId: "release_1", reference: referenceFees };

test("detail fees display API buyer amounts with exact cents; missing/mismatched lines never use public fees", () => {
  const { personalFeeLines } = loadComponent("apps/web/src/components/order/rental-price-summary.tsx", session("user_A"));
  assert.deepEqual(personalFeeLines(confirmation), { haff: "¥150.00", items: "¥20.00" });
  const changedName = { ...confirmation, quote: { ...confirmation.quote, lines: [{ ...haffLine, name: "not a name heuristic" }, pieceLine] } };
  assert.deepEqual(personalFeeLines(changedName), { haff: "¥150.00", items: "¥20.00" });
  for (const lines of [undefined, [], [{ ...haffLine, buyerAmount: null }], [{ ...haffLine, unit: "FUTURE_UNIT" }], [{ ...haffLine, buyerAmount: money("-1.00") }], [{ ...haffLine, buyerAmount: money("150.000") }]]) {
    assert.equal(personalFeeLines({ ...confirmation, quote: { ...confirmation.quote, lines } }), null);
  }
  assert.equal(personalFeeLines({ ...confirmation, quote: { ...confirmation.quote, resourceTotal: money("171.00") } }), null);
  const cents = { ...confirmation, quote: { ...confirmation.quote, lines: [{ ...haffLine, buyerAmount: money("0.10") }, { ...pieceLine, buyerAmount: money("0.20") }], resourceTotal: money("0.30") } };
  assert.deepEqual(personalFeeLines(cents), { haff: "¥0.10", items: "¥0.20" });
});

test("detail card and dock replace the reference with the SAME personal payable; no guessed discount", async () => {
  await withDom(async window => {
    const log = [];
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) }], log));
    try {
      await probe.render();
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥295.91");
      assert.match(probe.host.querySelector(".rental-dock-price").textContent, /押金另核/);
      await probe.click("查看我的报价");
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥470.00");
      assert.equal(probe.host.querySelector(".rental-dock-price strong").textContent, "¥470.00");
      assert.match(probe.host.querySelector(".account-fee-lines").textContent, /¥150.00.*¥20.00.*¥300.00/);
      assert.ok(!probe.host.textContent.includes("¥256.41"));
      assert.equal(probe.host.querySelectorAll(".rental-confirm-primary").length, 1);
      assert.equal(probe.host.querySelector("del"), null);
      assert.ok(!probe.host.textContent.includes("已优惠"));
    } finally { await probe.dispose(); }
  });
});

test("detail deposit waiver strikes only the authoritative base deposit, never the resource price", async () => {
  await withDom(async window => {
    const waived = { ...confirmation, customerTier: "VIP", depositWaived: true, quote: { ...confirmation.quote, tenantDeposit: money("0.00"), tenantPayableTotal: money("170.00") } };
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(waived) }], []));
    try {
      await probe.render(); await probe.click("查看我的报价");
      assert.equal(probe.host.querySelector("del").textContent, "¥300.00");
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥170.00");
      assert.match(probe.host.querySelector(".rental-deposit").textContent, /¥0.00.*本次免押/);
      assert.ok(!probe.host.textContent.includes("金卡"), "never map VIP to a new tier");
    } finally { await probe.dispose(); }
  });
});

test("detail unknown deposit is not zero even with a tier or inconsistent waiver flag", async () => {
  await withDom(async window => {
    const incomplete = { ...confirmation, customerTier: "SVIP", depositWaived: true, quote: { ...confirmation.quote, tenantDeposit: null, tenantPayableTotal: null } };
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(incomplete) }], []));
    try {
      await probe.render(); await probe.click("查看我的报价");
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "—");
      assert.equal(probe.host.querySelector("del"), null);
      assert.ok(!probe.host.querySelector(".rental-price-summary").textContent.includes("免押"));
    } finally { await probe.dispose(); }
  });
});

test("detail expiry and 503 clear the payable while preserving a user-initiated requote", async () => {
  await withDom(async window => {
    const old = { ...confirmation, expiresAt: new Date(Date.now() - 10000).toISOString() };
    let calls = 0;
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => ++calls === 1 ? json(old) : json({ error: { code: "DEPENDENCY_UNAVAILABLE" } }, 503) }], []));
    try {
      await probe.render(); await probe.click("查看我的报价");
      assert.match(probe.host.querySelector(".rental-price-summary").textContent, /报价已过期/);
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "—");
      assert.ok([...probe.host.querySelectorAll("button")].find(x => x.textContent.includes("确认并创建订单")).disabled);
      await probe.click("重新报价");
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "—");
      assert.ok(!probe.host.textContent.includes("¥470.00"));
      assert.equal(calls, 2);
    } finally { await probe.dispose(); }
  });
});

test("detail identity loading/B and late A quote never reveal A payable or waiver", async () => {
  await withDom(async window => {
    const current = session("user_A"), pending = deferred();
    const probe = createProbe(window, loadPanelForSession(current, async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => pending.promise }], []));
    try {
      await probe.render(); await probe.click("查看我的报价");
      current.status = "loading"; current.userId = null; await probe.render();
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "—");
      current.status = "authenticated"; current.userId = "user_B"; current.identityVersion++; await probe.render();
      pending.resolve(json({ ...confirmation, customerTier: "VIP", depositWaived: true, quote: { ...confirmation.quote, tenantDeposit: money("0.00") } }));
      await React.act(async () => { await tick(); await tick(); });
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥295.91");
      assert.ok(!probe.host.textContent.includes("¥470.00"));
      assert.equal(probe.host.querySelector("del"), null);
    } finally { await probe.dispose(); }
  });
});

test("detail auto quote runs once, keeps the actionable button, and consumes the returned token", async () => {
  await withDom(async window => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) },
      { match: "/api/v2/orders", method: "POST", respond: () => json({ order: { id: "order_auto", displayNo: "ZZ-AUTO", status: "PENDING_PAYMENT" } }) },
    ], log);
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), { ...detailPanelProps, autoQuote: true }, fetchImpl, { strict: true });
    try {
      await probe.render();
      await tick(); await tick();
      assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 1);
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥470.00");
      assert.ok(probe.host.textContent.includes("立即租用"));
      assert.ok(!probe.host.textContent.includes("查看我的报价"));
      assert.ok(!probe.host.textContent.includes("确认并创建订单"));
      await probe.render(); await tick();
      assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 1);
      await probe.click("立即租用");
      const creates = log.filter(entry => entry.url.endsWith("/api/v2/orders"));
      assert.equal(creates.length, 1);
      assert.deepEqual(creates[0].body, { confirmationToken: "token_1" });
    } finally { await probe.dispose(() => intents.clearIntent("user_A", "order.create.v2", "detail_price")); }
  });
});

test("guest detail auto quote links directly to login without a quote request", async () => {
  await withDom(async window => {
    const guest = { status: "guest", userId: null, identityVersion: 1, revalidate() {}, confirm: async () => "guest", signOut: async () => undefined };
    const log = [];
    const fetchImpl = router([], log);
    const probe = createProbe(window, loadPanelForSession(guest, async () => publishingOptions), { ...detailPanelProps, autoQuote: true }, fetchImpl);
    try {
      await probe.render();
      const link = probe.host.querySelector('a[href*="/login?next="]');
      assert.ok(link);
      assert.match(link.textContent, /登录后显示最终报价/);
      assert.equal(log.length, 0);
      assert.ok(!probe.host.textContent.includes("查看我的报价"));
    } finally { await probe.dispose(); }
  });
});

test("auto quote does not loop after 401 or 503", async () => {
  for (const failure of [
    { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "登录已失效" } }, message: "登录状态已变化" },
    { status: 503, body: { error: { code: "DEPENDENCY_UNAVAILABLE", message: "依赖暂不可用" } }, message: "最终报价暂时无法读取" },
  ]) {
    await withDom(async window => {
      const current = session("user_A");
      let confirms = 0;
      current.confirm = async () => { confirms += 1; return "authenticated"; };
      const log = [];
      const fetchImpl = router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(failure.body, failure.status) }], log);
      const probe = createProbe(window, loadPanelForSession(current, async () => publishingOptions), { ...detailPanelProps, autoQuote: true }, fetchImpl, { strict: true });
      try {
        await probe.render(); await tick(); await tick();
        assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 1);
        assert.equal(confirms, failure.status === 401 ? 1 : 0);
        assert.match(probe.host.textContent, new RegExp(failure.message));
        await probe.render(); await tick();
        assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 1);
      } finally { await probe.dispose(); }
    });
  }
});

test("auto quote honors a frozen create intent before requesting a new quote", async () => {
  await withDom(async window => {
    intents.saveIntent({ userId: "user_A", kind: "order.create.v2", resourceId: "detail_intent", key: "op_frozen", body: {}, token: "token_frozen", context: { payable: "470.00" } });
    const log = [];
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), { ...detailPanelProps, accountId: "detail_intent", autoQuote: true }, router([], log), { strict: true });
    try {
      await probe.render(); await tick();
      assert.ok(probe.host.textContent.includes("创建请求结果未知"));
      assert.equal(log.length, 0);
    } finally { await probe.dispose(() => intents.clearIntent("user_A", "order.create.v2", "detail_intent")); }
  });
});

test("late auto quotes are dropped across an A to B to A object switch", async () => {
  await withDom(async window => {
    const pending = [deferred(), deferred(), deferred()];
    let call = 0;
    const fetchImpl = router([{ match: "/api/order-confirmations", method: "POST", respond: () => pending[call++].promise }], []);
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), { ...detailPanelProps, autoQuote: true }, fetchImpl);
    const props = accountId => ({ ...detailPanelProps, accountId, autoQuote: true });
    try {
      await probe.render(); await tick();
      assert.equal(call, 1);
      await probe.render(props("detail_other")); await tick();
      assert.equal(call, 2);
      await React.act(async () => { pending[0].resolve(json(confirmation)); await tick(); await tick(); });
      assert.ok(!probe.host.textContent.includes("¥470.00"));
      await probe.render(props("detail_price")); await tick();
      assert.equal(call, 3);
      await React.act(async () => { pending[1].resolve(json(confirmation)); await tick(); await tick(); });
      assert.ok(!probe.host.textContent.includes("¥470.00"));
      await React.act(async () => { pending[2].resolve(json(confirmation)); await tick(); await tick(); });
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥470.00");
      assert.ok(probe.host.textContent.includes("立即租用"));
    } finally { await probe.dispose(); }
  });
});

test("F2: an unknown create keeps the original token and key and recovers after remount", async () => {
  await withDom(async (window) => {
    const log = [];
    let createCalls = 0;
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) },
      { match: "/api/v2/orders", method: "POST", respond: () => { createCalls += 1; if (createCalls === 1) throw new TypeError("network down"); return json({ order: { id: "order_B", displayNo: "ZZ-2", status: "PENDING_PAYMENT" } }); } },
    ], log);
    const Panel = loadPanel("user_A", async () => publishingOptions);
    const props = { accountId: "account_1", gameId: "game_1", versionId: "listing_1", releaseId: "release_1", reference: referenceFees };
    const first = createProbe(window, Panel, props, fetchImpl);
    await first.render();
    await first.click("查看我的报价");
    assert.ok(first.host.textContent.includes("¥470.00"));
    assert.ok(first.host.textContent.includes("三角洲出租协议"));
    await first.click("确认并创建订单");
    assert.ok(first.host.textContent.includes("创建请求结果未知"), first.host.textContent.slice(0, 300));
    assert.equal(first.host.querySelector(".account-reference-price").textContent, "—");
    assert.ok(!first.host.querySelector(".rental-price-summary").textContent.includes("¥470.00"));
    const firstCreate = log.find((entry) => entry.url.endsWith("/api/v2/orders"));
    assert.deepEqual(firstCreate.body, { confirmationToken: "token_1" });
    await first.unmount();
    // Remount in the same window/session: the frozen intent is offered for query.
    const second = createProbe(window, Panel, props, fetchImpl);
    await second.render();
    assert.ok(second.host.textContent.includes("创建请求结果未知"), "remount must restore the unknown create");
    assert.equal(second.host.querySelector(".account-reference-price").textContent, "—");
    await second.click("查询原创建结果");
    const creates = log.filter((entry) => entry.url.endsWith("/api/v2/orders"));
    assert.equal(creates.length, 2);
    assert.equal(creates[0].key, creates[1].key, "same idempotency key");
    assert.deepEqual(creates[0].body, creates[1].body, "same original body/token");
    assert.ok(second.host.textContent.includes("原创建请求已确认成功"), second.host.textContent.slice(0, 300));
    await second.dispose(() => intents.clearIntent("user_A", "order.create.v2", "account_1"));
  });
});

test("F2: another identity cannot see or reuse the frozen create intent; 401 keeps it for the owner", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) },
      { match: "/api/v2/orders", method: "POST", respond: () => json({ error: { code: "UNAUTHENTICATED", message: "登录已失效" } }, 401) },
    ], log);
    const props = { accountId: "account_2", gameId: "game_1", versionId: "listing_1", releaseId: "release_1" };
    const ownerView = createProbe(window, loadPanel("user_A", async () => publishingOptions), props, fetchImpl);
    await ownerView.render();
    await ownerView.click("查看我的报价");
    await ownerView.click("确认并创建订单");
    assert.ok(ownerView.host.textContent.includes("登录状态已变化"), ownerView.host.textContent.slice(0, 300));
    assert.ok(intents.loadIntent("user_A", "order.create.v2", "account_2"), "the owner's intent is retained");
    const stranger = createProbe(window, loadPanel("user_B", async () => publishingOptions), props, fetchImpl);
    await stranger.render();
    assert.ok(stranger.host.textContent.includes("查看我的报价"), "another identity starts idle");
    assert.ok(!stranger.host.textContent.includes("创建请求结果未知"), "another identity must not see the frozen intent");
    await stranger.dispose();
    await ownerView.dispose(() => intents.clearIntent("user_A", "order.create.v2", "account_2"));
  });
});

test("F4: missing agreement evidence blocks creation instead of accepting a version code only", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) },
    ], log);
    const Panel = loadPanel("user_A", async () => { throw new Error("options unavailable"); });
    const probe = createProbe(window, Panel, { accountId: "account_3", gameId: "game_1", versionId: "listing_1", releaseId: "release_1" }, fetchImpl);
    await probe.render();
    await probe.click("查看我的报价");
    assert.ok(probe.host.textContent.includes("条款依据暂时无法读取"), probe.host.textContent.slice(0, 300));
    const create = probe.buttons().find((text) => text.includes("确认并创建订单"));
    const button = [...probe.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("确认并创建订单"));
    assert.ok(button.disabled, "create must be disabled while agreement evidence is unavailable");
    assert.ok(create);
    await probe.dispose();
  });
});


test("R2: an existing intent is consumed with its frozen body and key, never overwritten", async () => {
  await withDom(async () => {
    const actions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A"));
    const sent = [];
    const first = await actions.performGuardedWrite("user_A", "order.payment", "order_frozen", { amount: "first" }, { ctx: "first" }, async (key, body) => { sent.push({ key, body }); throw new TypeError("network down"); });
    assert.equal(first.status, "unknown");
    const second = await actions.performGuardedWrite("user_A", "order.payment", "order_frozen", { amount: "second" }, { ctx: "second" }, async (key, body) => { sent.push({ key, body }); return { ok: true }; });
    assert.equal(second.status, "ok");
    assert.equal(sent[0].key, sent[1].key);
    assert.deepEqual(sent[1].body, { amount: "first" }, "recovery must send the frozen body");
    intents.clearIntent("user_A", "order.payment", "order_frozen");
  });
});

test("R1: 401 keeps the intent and asks the shared session to confirm the identity", async () => {
  await withDom(async () => {
    const actions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A"));
    const outcome = await actions.performGuardedWrite("user_A", "order.cancel", "order_401", {}, undefined, async () => { throw new OrderRequestError(401, null); });
    assert.equal(outcome.status, "unauthorized");
    assert.ok(intents.loadIntent("user_A", "order.cancel", "order_401"), "401 must not release the intent");
    intents.clearIntent("user_A", "order.cancel", "order_401");
  });
});

test("R2/R3: storage failure blocks a new write instead of creating an unrecoverable one", async () => {
  await withDom(async (window) => {
    const actions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A"));
    const realWindow = globalThis.window;
    globalThis.window = { sessionStorage: { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} } };
    try {
      let called = 0;
      const outcome = await actions.performGuardedWrite("user_A", "order.payment", "order_quota", {}, undefined, async () => { called += 1; return {}; });
      assert.equal(outcome.status, "blocked");
      assert.equal(called, 0, "no request may be sent without a persisted recovery record");
    } finally {
      globalThis.window = realWindow;
    }
  });
});

test("R3: an aged intent is not auto-replayed and stays available for an explicit authoritative query", async () => {
  await withDom(async (window) => {
    const log = [];
    intents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_A", key: "key_aged", body: {} });
    const storageKey = "zzsh.order-intent.v1:user_A:order.payment:order_A";
    const stored = JSON.parse(window.sessionStorage.getItem(storageKey));
    stored.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    window.sessionStorage.setItem(storageKey, JSON.stringify(stored));
    const fetchImpl = router([{ match: "payment-requests", method: "POST", respond: () => json({ payment: { confirmationId: "p1", disposition: "APPLIED", replay: true } }) }], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "PENDING_PAYMENT" }, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    assert.ok(probe.host.textContent.includes("超出自动查询窗口"), probe.host.textContent.slice(0, 300));
    assert.equal(log.length, 0, "an aged intent must not be replayed automatically");
    await probe.click("查询原请求结果");
    assert.equal(log.length, 1, "explicit query still uses the frozen key");
    assert.equal(log[0].key, "key_aged");
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});

test("R2: settlement unknown locks the form; payment and cancel lock each other", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json(settlementBody) },
      { match: "settlement-preview", method: "POST", respond: () => json(previewBody) },
      { match: "/settlements", method: "POST", respond: () => { throw new TypeError("network down"); } },
    ], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("预览结算金额");
    await probe.click("提交结算");
    assert.ok(probe.host.textContent.includes("结果未知"), probe.host.textContent.slice(0, 300));
    const inputs = [...probe.host.querySelectorAll("input")];
    assert.ok(inputs.length > 0 && inputs.every((input) => input.disabled), "inputs must be locked while the submit outcome is unknown");
    assert.ok(!probe.buttons().some((text) => text.includes("提交结算")), "no resubmit while unknown");
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.submit", "order_A"));
  });
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "payment-requests", method: "POST", respond: () => { throw new TypeError("network down"); } }], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "PENDING_PAYMENT" }, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("提交本地受控支付");
    assert.ok(probe.host.textContent.includes("支付结果未知"), probe.host.textContent.slice(0, 300));
    const cancelButton = [...probe.host.querySelectorAll("button")].find((button) => button.textContent?.includes("取消订单"));
    assert.ok(cancelButton?.disabled, "cancel must be locked while payment is unknown");
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});

test("R1: identity switch clears the private quote and resets order actions", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) }], log);
    const mutable = session("user_A");
    const Panel = loadPanelForSession(mutable, async () => publishingOptions);
    const probe = createProbe(window, Panel, { accountId: "account_switch", gameId: "game_1", versionId: "listing_1", releaseId: "release_1" }, fetchImpl);
    await probe.render();
    await probe.click("查看我的报价");
    assert.ok(probe.host.textContent.includes("¥470.00"));
    mutable.userId = "user_B";
    mutable.identityVersion = 2;
    await probe.render();
    assert.ok(!probe.host.textContent.includes("¥470.00"), "B must not see A's quote");
    assert.ok(probe.host.textContent.includes("查看我的报价"));
    await probe.dispose();
  });
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "payment-requests", method: "POST", respond: () => { throw new TypeError("network down"); } }], log);
    const mutable = session("user_A");
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", mutable).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "PENDING_PAYMENT" }, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("提交本地受控支付");
    assert.ok(probe.host.textContent.includes("支付结果未知"));
    mutable.userId = "user_B";
    mutable.identityVersion = 2;
    await probe.render();
    assert.ok(!probe.host.textContent.includes("支付结果未知"), "B must not inherit A's unknown state");
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});


test("P1-A: opening recovery consumes the frozen target object and version, never the current page opening", async () => {
  await withDom(async (window) => {
    const log = [];
    const openingNew = { ...opening, id: "opening_NEW", versionNo: "2", status: "DRAFT", acks: [] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json({ ...settlementBody, openings: [openingNew] }) },
      { match: "/openings/opening_OLD/confirm", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "状态已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "opening.confirm", resourceId: "order_A", key: "old_key", body: { versionNo: 1 }, context: { openingId: "opening_OLD", orderId: "order_A" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    const confirms = log.filter((entry) => entry.url.includes("/openings/"));
    assert.equal(confirms.length, 1, "recovery must send exactly one confirm request");
    assert.ok(confirms[0].url.includes("opening_OLD"), `recovery must use the frozen opening id: ${confirms[0].url}`);
    assert.ok(!confirms[0].url.includes("opening_NEW"), "recovery must never fall back to the current page opening");
    assert.equal(confirms[0].key, "old_key");
    assert.ok(intents.loadIntent("user_A", "opening.confirm", "order_A"), "the unresolved intent must stay frozen");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 300));
    assert.ok(!probe.host.textContent.includes("本次确认未生效"), "a read must not claim the request failed");
    await probe.dispose(() => intents.clearIntent("user_A", "opening.confirm", "order_A"));
  });
});

test("P1-B: an existing acknowledgement on the original opening is matched and releases the lock correctly", async () => {
  await withDom(async (window) => {
    const log = [];
    const openingOldAcked = { ...opening, id: "opening_OLD", status: "DRAFT", acks: [{ party: "RENTER" }] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json({ ...settlementBody, openings: [openingOldAcked] }) },
      { match: "/openings/opening_OLD/confirm", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "状态已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "opening.confirm", resourceId: "order_A", key: "old_key", body: { versionNo: 1 }, context: { openingId: "opening_OLD", orderId: "order_A" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    for (let i = 0; i < 25 && !probe.host.textContent.includes("服务端已记录你的期初确认"); i += 1) await React.act(async () => { await tick(); });
    assert.equal(intents.loadIntent("user_A", "opening.confirm", "order_A"), null, "a matched acknowledgement releases the lock");
    for (let i = 0; i < 25 && !probe.host.textContent.includes("已提交确认"); i += 1) await React.act(async () => { await tick(); });
    assert.ok(probe.host.textContent.includes("已提交确认"), "the authoritative acked state is shown");
    assert.ok(!probe.host.textContent.includes("未生效"), "the read must not be presented as a failure");
    await probe.dispose();
  });
});

test("P1-B: a payment read without a record never releases the intent or reopens payment", async () => {
  await withDom(async (window) => {
    const log = [];
    const pendingOrder = { ...paidOrder, status: "PENDING_PAYMENT" };
    const fetchImpl = router([
      { match: "payment-requests", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "订单当前不可支付" } }, 409) },
      { match: "payment-requests", method: "GET", respond: () => json({ order: { id: "order_A", status: "PENDING_PAYMENT", paidAt: null }, payment: null }) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_A", key: "pay_key", body: {} });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: pendingOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    assert.ok(intents.loadIntent("user_A", "order.payment", "order_A"), "the payment intent must stay frozen");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 300));
    assert.ok(!probe.host.textContent.includes("原请求未生效"), "a missing record is not proof of non-occurrence");
    const payButton = [...probe.host.querySelectorAll("button")].find((button) => button.textContent?.includes("提交本地受控支付"));
    assert.ok(payButton?.disabled, "payment must stay locked while the original request is unresolved");
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});

test("P1-B: a decision on another version does not release the original decision intent", async () => {
  await withDom(async (window) => {
    const log = [];
    const versionNew = { id: "v_NEW", versionNo: "2", kind: "SYSTEM", early: false, versionHash: "h_new", decisions: [{ party: "OWNER", action: "CONFIRM" }] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json({ ...settlementBody, openings: [opening], settlement: versionNew, versions: [versionNew] }) },
      { match: "/settlements/v_OLD/decision", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "版本已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "settlement.decision", resourceId: "order_A", key: "old_key", body: { action: "CONFIRM", versionHash: "h_old" }, context: { versionId: "v_OLD", orderId: "order_A" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    const decisions = log.filter((entry) => entry.url.includes("/decision"));
    assert.equal(decisions.length, 1);
    assert.ok(decisions[0].url.includes("v_OLD"), "recovery must target the original version");
    assert.ok(intents.loadIntent("user_A", "settlement.decision", "order_A"), "another version's decision must not release the intent");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 300));
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.decision", "order_A"));
  });
});

test("P1-B: an unrelated recent order never proves the original create succeeded", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/v2/orders", method: "POST", respond: () => json({ error: { code: "CONFIRMATION_USED", message: "凭据已使用" } }, 409) },
      { match: "/api/orders?", method: "GET", respond: () => json({ items: [{ id: "order_other", displayNo: "ZZ-OTHER", createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }], nextCursor: null, limit: 5 }) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "order.create.v2", resourceId: "account_1", key: "old_key", body: {}, token: "token_1", context: { payable: "470.00" } });
    const Panel = loadPanel("user_A", async () => publishingOptions);
    const probe = createProbe(window, Panel, { accountId: "account_1", gameId: "game_1", versionId: "listing_1", releaseId: "release_1" }, fetchImpl);
    await probe.render();
    await probe.click("查询原创建结果");
    assert.ok(intents.loadIntent("user_A", "order.create.v2", "account_1"), "an unrelated order must not release the create intent");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 300));
    assert.ok(probe.host.textContent.includes("ZZ-OTHER"), "the observed list may be shown as current state only");
    assert.ok(!probe.host.textContent.includes("已确认成功"), "a list entry is not proof the original request succeeded");
    await probe.dispose(() => intents.clearIntent("user_A", "order.create.v2", "account_1"));
  });
});

test("P1-B: a failing authoritative read keeps the intent frozen", async () => {
  await withDom(async (window) => {
    const log = [];
    let reads = 0;
    const openingOld = { ...opening, id: "opening_OLD", status: "DRAFT", acks: [] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => { reads += 1; if (reads === 1) return json({ ...settlementBody, openings: [openingOld] }); throw new TypeError("network down"); } },
      { match: "/openings/opening_OLD/confirm", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "状态已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "opening.confirm", resourceId: "order_A", key: "old_key", body: { versionNo: 1 }, context: { openingId: "opening_OLD", orderId: "order_A" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    assert.ok(intents.loadIntent("user_A", "opening.confirm", "order_A"), "a failed read must keep the intent");
    assert.ok(probe.host.textContent.includes("原请求保留"), probe.host.textContent.slice(0, 300));
    await probe.dispose(() => intents.clearIntent("user_A", "opening.confirm", "order_A"));
  });
});


test("P1: a historical same-content intake never releases the submit intent", async () => {
  await withDom(async (window) => {
    const log = [];
    const historical = {
      orderId: "order_A", rentalStarted: true, openings: [opening],
      intakes: [{ id: "intake_old", versionNo: "1", status: "REJECTED", initiatorParty: "RENTER", lines: [{ itemId: "item_haff", remainingQuantity: "0" }, { itemId: "item_piece", remainingQuantity: "8" }] }],
      versions: [], currentRequest: { kind: "INTAKE", id: "intake_old", versionNo: "1", status: "REJECTED" },
      settlement: null, posting: null, ready: false, reasons: ["SETTLEMENT_INTAKE_PENDING"],
    };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json(historical) },
      { match: "/settlements", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "状态已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "settlement.submit", resourceId: "order_A", key: "old_key", body: { lines: [{ itemId: "item_haff", remainingQuantity: "0" }, { itemId: "item_piece", remainingQuantity: "8" }], acceptedHash: "h_old" }, context: { openingId: "opening_1", openingVersion: "1" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    assert.ok(intents.loadIntent("user_A", "settlement.submit", "order_A"), "equal content is not proof the original request succeeded");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 400));
    assert.ok(!probe.host.textContent.includes("已记录本次结束提交"), "a historical intake must not be claimed as this submission");
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.submit", "order_A"));
  });
});

test("P1: decision recovery without a frozen version target blocks instead of using the current page version", async () => {
  await withDom(async (window) => {
    const log = [];
    const versionNew = { id: "v_NEW", versionNo: "2", kind: "SYSTEM", early: false, versionHash: "h_new", decisions: [{ party: "OWNER", action: "CONFIRM" }] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json({ ...settlementBody, openings: [opening], settlement: versionNew, versions: [versionNew] }) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "settlement.decision", resourceId: "order_A", key: "old_key", body: { action: "CONFIRM", versionHash: "h_old" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    assert.equal(log.filter((entry) => entry.method === "POST").length, 0, "no decision may be sent without the frozen target version");
    assert.ok(intents.loadIntent("user_A", "settlement.decision", "order_A"), "the intent stays frozen");
    assert.ok(probe.host.textContent.includes("缺少目标版本"), probe.host.textContent.slice(0, 400));
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.decision", "order_A"));
  });
});
