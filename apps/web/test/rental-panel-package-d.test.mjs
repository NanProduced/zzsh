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
  const file = path.join(tree, relativePath);
  const module = new Module(file);
  module.filename = file;
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (extra && Object.hasOwn(extra, name)) return extra[name];
    if (name === "next/link") return function Link({ scroll: _scroll, ...props }) { return React.createElement("a", props); };
    if (name === "@/components/session/user-session-provider") return { useUserSession: () => session };
    if (name === "@/lib/listing-view") return requireFromTree(path.join(tree, "apps/web/src/lib/listing-view.ts"));
    if (name === "@/lib/supply-client") return { supplyApi: { fullPayoutTerms: async () => ({}), publishingOptions: async () => ({ releaseId: "r1", agreement: { id: "agreement", title: "离线测试协议", body: "合成内容", digest: "offline" } }) } };
    if (name === "@/lib/order-client") return requireFromTree(path.join(tree, "apps/web/src/lib/order-client.ts"));
    if (name === "@/lib/order-intents") return requireFromTree(path.join(tree, "apps/web/src/lib/order-intents.ts"));
    if (name === "@/lib/order-display") return requireFromTree(path.join(tree, "apps/web/src/lib/order-display.ts"));
    if (name === "@/components/session/identity-reset") return requireFromTree(path.join(tree, "apps/web/src/components/session/identity-reset.ts"));
    if (name === "@/components/order/order-trade-actions") return loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session);
    if (name === "./rental-price-summary") return loadComponent("apps/web/src/components/order/rental-price-summary.tsx", session);
    if (name === "@/components/ui/tooltip") return { Tooltip: props => React.createElement(React.Fragment, null, props.children), TooltipTrigger: props => React.createElement(React.Fragment, null, props.children), TooltipContent: () => null };
    if (name.endsWith(".css")) return {};
    return requireFromTree(name);
  };
  module._compile(compile(relativePath), file);
  return module.exports;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function controlClock(context) {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  return { advance: (ms) => context.mock.timers.tick(ms), restore: () => context.mock.timers.reset() };
}

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
  const unmount = async () => { await React.act(async () => root.unmount()); await tick(); };
  const dispose = async (removeIntent) => {
    await unmount();
    globalThis.fetch = previousFetch;
    if (removeIntent) removeIntent();
  };
  return { host, render, click, unmount, dispose, buttons };
}

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

function router(routes, log) {
  return async (input, init = {}) => {
    const method = init.method ?? "GET";
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    log.push({ method, url, init });
    const parsed = new URL(url, "http://127.0.0.1");
    for (const route of routes) {
      if (route.method && route.method !== method) continue;
      if (typeof route.match === "string" && parsed.pathname === route.match) {
        return route.respond(parsed, init);
      }
      if (route.match instanceof RegExp && route.match.test(parsed.pathname)) {
        return route.respond(parsed, init);
      }
    }
    throw new Error(`unexpected fetch ${method} ${parsed.pathname}`);
  };
}

const cny = (amount, scale = 2) => ({ currency: "CNY", unit: "yuan", scale, amount });

const previewPayload = {
  schema: "rental-price-preview.v1",
  binding: { accountId: "acc_1", versionId: "v1", releaseId: "r1", listingHash: "hash1" },
  asOfUtc: new Date().toISOString(),
  refreshAfterUtc: new Date(Date.now() + 30000).toISOString(),
  quote: {
    currency: "CNY",
    scale: 2,
    baseRenterHaffRatioWanPerYuan: "52",
    resourceTotal: cny("220.18"),
    tenantDeposit: cny("50.00"),
    tenantPayableTotal: cny("270.18"),
    lines: [
      { itemId: "h1", quantity: "90000000", unit: "HAFF_BASE", unitQuantity: "1000000", buyerAmount: cny("173.08"), buyerUnitAmount: cny("1.92307692", 8) },
      { itemId: "a1", quantity: "5", unit: "PIECE", unitQuantity: "1", buyerAmount: cny("15.00"), buyerUnitAmount: cny("3.00000000", 8) },
      { itemId: "b1", quantity: "120", unit: "ROUND", unitQuantity: "60", buyerAmount: cny("24.00"), buyerUnitAmount: cny("12.00000000", 8) },
      { itemId: "c1", quantity: "3", unit: "PIECE", unitQuantity: "1", buyerAmount: cny("15.00"), buyerUnitAmount: cny("5.00000000", 8) },
      { itemId: "awm1", quantity: "10", unit: "ROUND", unitQuantity: "1", buyerAmount: cny("0.04"), buyerUnitAmount: cny("0.00400000", 8) },
      { itemId: "card1", quantity: "1", unit: "DAY", unitQuantity: "1", buyerAmount: cny("5.00"), buyerUnitAmount: cny("5.00000000", 8) },
    ],
  },
  baseTenantDeposit: cny("50.00"),
  customerTier: "STANDARD",
  membershipBenefits: {
    schema: "membership-benefits-v1",
    effectiveTier: "STANDARD",
    policyTier: "STANDARD",
    priceSource: "GROWTH",
    depositSource: "GROWTH",
    policyVersion: "v1",
  },
};

const referenceFees = {
  total: "¥270.18",
  haff: "¥173.08",
  items: "¥47.10",
  baseRenterHaffRatioWanPerYuan: "52",
  lines: [
    { itemId: "h1", code: "df_billable_haff", name: "哈夫币", quantity: "90000000", quantityLabel: "90M", unitLabel: "哈夫币", costAmount: "173.08", costLabel: "¥173.08", unitPriceLabel: "52万/元" },
    { itemId: "a1", code: "df_billable_level6_armor", name: "6级护甲", quantity: "5", quantityLabel: "5件", unitLabel: "件", costAmount: "15.00", costLabel: "¥15.00", unitPriceLabel: "¥3.00 / 1 件" },
    { itemId: "b1", code: "df_billable_level6_bullet", name: "6级子弹", quantity: "120", quantityLabel: "120发", unitLabel: "发", costAmount: "24.00", costLabel: "¥24.00", unitPriceLabel: "¥12.00 / 60 发" },
    { itemId: "c1", code: "df_billable_coffee", name: "咖啡豆", quantity: "3", quantityLabel: "3件", unitLabel: "件", costAmount: "15.00", costLabel: "¥15.00", unitPriceLabel: "¥5.00 / 1 件" },
    { itemId: "awm1", code: "df_billable_awm_bullet", name: "AWM子弹", quantity: "10", quantityLabel: "10发", unitLabel: "发", costAmount: "0.04", costLabel: "¥0.04", unitPriceLabel: "¥0.00400000 / 1 发" },
    { itemId: "card1", code: "df_billable_top_insure_card", name: "九格保险卡", quantity: "1", quantityLabel: "1天", unitLabel: "天", costAmount: "5.00", costLabel: "¥5.00", unitPriceLabel: "¥5.00 / 1 天" },
  ],
};

const defaultProps = {
  accountId: "acc_1",
  gameId: "game_delta",
  versionId: "v1",
  releaseId: "r1",
  reference: referenceFees,
  autoPreview: true,
  fullPayoutSelected: false,
};

const loggedSession = {
  status: "authenticated",
  userId: "user_renter_1",
  identityVersion: 1,
  revalidate: () => {},
  confirm: async () => "authenticated",
  signOut: async () => undefined,
};

// Comparison fixtures close arithmetically; they are not live account quotes.
const comparisonPreview = {
  ...previewPayload,
  binding: { ...previewPayload.binding, listingHash: "a".repeat(64) },
  quote: {
    ...previewPayload.quote,
    schemaVersion: 2,
    ruleReleaseId: "r1",
    termSeconds: "86400",
    expiryDisclosures: [],
    unitAmountsInformational: true,
    resourceTotal: cny("232.12"),
    tenantPayableTotal: cny("282.12"),
  },
};
const comparisonReference = { ...referenceFees, total: "¥232.12", items: "¥59.04" };
const readyPayoutTerms = { termsVersionId: "pv1", termsDigest: "pd1", disclosureVersion: "d1", title: "离线包赔条款", body: "合成条款正文" };
const readyPayoutSupply = {
  supplyApi: {
    fullPayoutTerms: async () => ({ releaseId: "r1", fullPayoutTerms: readyPayoutTerms }),
    publishingOptions: async () => ({ releaseId: "r1", agreement: { id: "agr1", title: "离线测试协议", body: "合成内容", digest: "offline" } }),
  },
};
function confirmationFor(preview) {
  return {
    quote: structuredClone(preview.quote),
    baseTenantDeposit: structuredClone(preview.baseTenantDeposit),
    membershipBenefits: structuredClone(preview.membershipBenefits),
    customerTier: preview.customerTier,
    ...(preview.compensationDisclosure ? { compensationDisclosure: structuredClone(preview.compensationDisclosure) } : {}),
    depositWaived: false,
    confirmationId: "OFFLINE_CONFIRMATION",
    listingHash: preview.binding.listingHash,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    confirmationToken: "OFFLINE_NOT_A_REAL_TOKEN",
  };
}

async function withConfirmedPanel(preview, confirmed, run) {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(preview) },
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmed) },
    ], log);
    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, { ...defaultProps, reference: comparisonReference }, fetchImpl);
    try {
      await probe.render();
      await probe.click("立即租用");
      const create = probe.host.querySelector(".rental-confirm-primary");
      assert.match(create?.textContent ?? "", /确认并创建订单/);
      assert.equal(create.disabled, false, "a missing agreement stub must not silently block this confirmation scenario");
      assert.equal(log.filter(x => x.method === "POST").length, 1, "only the synthetic confirmation may be posted");
      assert.ok(!log.some(x => x.url.includes("/api/orders-v2")), "no order may be created before explicit submission");
      await run({ probe, log, window });
    } finally { await probe.dispose(); }
  });
}

// Case 1: Auto GET without POST
test("D-01: autoPreview triggers GET /api/rental-price-preview, never POST /api/order-confirmations", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(previewPayload) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      assert.equal(log.length, 1);
      assert.equal(log[0].method, "GET");
      assert.ok(log[0].url.includes("/api/rental-price-preview"));
      assert.ok(log[0].url.includes("accountId=acc_1"));

      // Must display "立即租用" button once preview is loaded
      const primaryBtn = probe.host.querySelector(".rental-confirm-primary");
      assert.ok(primaryBtn);
      assert.match(primaryBtn.textContent, /立即租用/);

      // Must display authoritative ratio tag "52万/元"
      const ratioBadge = probe.host.querySelector(".account-haff-ratio-badge");
      assert.ok(ratioBadge);
      assert.equal(ratioBadge.textContent.trim(), "52万/元");
      assert.equal(ratioBadge.getAttribute("title"), "发布版基础客价（已含平台价差，未计会员优惠）");

      // Dock price matches preview total
      assert.match(probe.host.querySelector(".rental-dock-price strong").textContent, /¥270\.18/);
    } finally {
      await probe.dispose();
    }
  });
});

// Case 2: Identity / Target change aborts in-flight preview
test("D-02: target / identity change aborts in-flight preview and drops late responses", async () => {
  await withDom(async (window) => {
    const log = [];
    const gate = deferred();
    const nextGate = deferred();
    const nextPreview = {
      ...comparisonPreview,
      binding: { ...comparisonPreview.binding, versionId: "v2" },
      quote: {
        ...comparisonPreview.quote,
        lines: comparisonPreview.quote.lines.map((line, index) => index === 0 ? { ...line, buyerAmount: cny("183.08") } : line),
        resourceTotal: cny("242.12"),
        tenantPayableTotal: cny("292.12"),
      },
    };
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: (url) => url.searchParams.get("versionId") === "v1" ? gate.promise.then(() => json(comparisonPreview)) : nextGate.promise.then(() => json(nextPreview)) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      assert.equal(log.length, 1);
      const signal = log[0].init.signal;
      assert.ok(signal, "fetch must receive abort signal");
      assert.equal(signal.aborted, false);

      // Change target version
      await probe.render({ ...defaultProps, versionId: "v2" });
      assert.equal(signal.aborted, true, "in-flight preview must be aborted on target change");

      // Resolve delayed promise after abort
      await React.act(async () => { gate.resolve(); await tick(); });
      assert.notEqual(probe.host.querySelector(".rental-price-summary")?.getAttribute("data-personal"), "true", "late v1 response cannot become v2's personal price");
      await React.act(async () => { nextGate.resolve(); await tick(); });
      assert.equal(probe.host.querySelector(".account-reference-price")?.textContent, "¥292.12");
      assert.equal(probe.host.querySelector(".rental-price-summary")?.getAttribute("data-personal"), "true");
    } finally {
      await probe.dispose();
    }
  });
});

// Case 3: Missing personal fields isolation
test("D-03: personal lines isolate missing personal fields and never borrow public reference values", async () => {
  await withDom(async (window) => {
    const log = [];
    const missingFieldPayload = {
      ...previewPayload,
      quote: {
        ...previewPayload.quote,
        lines: [
          { itemId: "h1", quantity: "90000000", unit: "HAFF_BASE", unitQuantity: "1000000", buyerAmount: null },
          { itemId: "a1", quantity: "5", unit: "PIECE", unitQuantity: "1", buyerAmount: cny("15.00") },
        ],
      },
    };
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(missingFieldPayload) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      const haffRow = probe.host.querySelector(".account-quote-bill-row--haff");
      assert.ok(haffRow);
      // Personal haff missing amount must NOT borrow public ¥173.08!
      assert.equal(haffRow.querySelector(".account-quote-bill-amount").textContent, "未提供");
      // Ratio badge must NOT be shown when personal haff amount is missing
      assert.equal(probe.host.querySelector(".account-haff-ratio-badge"), null);
    } finally {
      await probe.dispose();
    }
  });
});

// Case 4: 0 stock vs positive inventory
test("D-04: zero-stock inventory is omitted while positive zero-cost inventory remains visible", async () => {
  await withDom(async (window) => {
    const log = [];
    const zeroStockPayload = {
      ...previewPayload,
      quote: {
        ...previewPayload.quote,
        lines: [
          { itemId: "h1", quantity: "90000000", unit: "HAFF_BASE", unitQuantity: "1000000", buyerAmount: cny("173.08") },
          { itemId: "a1", quantity: "0", unit: "PIECE", unitQuantity: "1", buyerAmount: cny("0.00") }, // 0 stock
          { itemId: "b1", quantity: "120", unit: "ROUND", unitQuantity: "60", buyerAmount: cny("0.00") }, // free inventory (120 rounds)
        ],
      },
    };
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(zeroStockPayload) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      const rows = probe.host.querySelectorAll(".account-quote-bill-row");
      // Haff + b1 (free bullets) visible, a1 (0-stock) omitted
      assert.equal(rows.length, 2);
      assert.ok(probe.host.textContent.includes("2组（120发）"));
    } finally {
      await probe.dispose();
    }
  });
});

// Case 5: Preview without waiver does not claim waiver
test("D-05: preview without waiver does not claim waiver even with 0 deposit", async () => {
  await withDom(async (window) => {
    const log = [];
    const zeroDepositPayload = {
      ...previewPayload,
      quote: {
        ...previewPayload.quote,
        tenantDeposit: cny("0.00"),
        tenantPayableTotal: cny("220.18"),
      },
    };
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(zeroDepositPayload) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      // Must not display "本次免押" label since depositWaived was not provided
      assert.equal(probe.host.querySelector(".rental-waiver-label"), null);
      assert.match(probe.host.textContent, /¥0\.00/);
    } finally {
      await probe.dispose();
    }
  });
});

// Case 6: Price change between preview and confirmation surfaces priceChangeNotice
test("D-06: price change between preview and confirmation surfaces priceChangeNotice", async () => {
  await withDom(async (window) => {
    const log = [];
    const confirmPayload = {
      quote: {
        ...previewPayload.quote,
        tenantPayableTotal: cny("280.00"), // price increased from 270.18 to 280.00!
      },
      baseTenantDeposit: cny("50.00"),
      depositWaived: false,
      confirmationId: "conf_new",
      listingHash: "hash1",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      confirmationToken: "token_abc_123",
    };
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(previewPayload) },
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmPayload) },
      { match: "/api/publishing-options", method: "GET", respond: () => json({ releaseId: "r1", agreement: { id: "agr1", title: "租赁协议", body: "内容", digest: "d1" } }) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      assert.match(probe.host.querySelector(".rental-confirm-primary").textContent, /立即租用/);

      // Click "立即租用"
      await probe.click("立即租用");

      // Price change notice must be surfaced
      const notice = probe.host.querySelector(".rental-confirm-notice--price-change");
      assert.ok(notice, "price change notice must be present");
      assert.match(notice.textContent, /270\.18/);
      assert.match(notice.textContent, /280\.00/);

      // Quoted stage: must require user to click "确认并创建订单"
      assert.ok(probe.host.querySelector(".rental-confirm-primary")?.textContent?.includes("确认并创建订单"));
    } finally {
      await probe.dispose();
    }
  });
});

// Case 7: Terms and full payout consent required before ordering
test("D-07: terms and full payout consent required before ordering", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(previewPayload) },
      { match: "/api/full-payout-terms", method: "GET", respond: () => json({ releaseId: "r1", fullPayoutTerms: { termsVersionId: "pv1", termsDigest: "pd1", disclosureVersion: "d1", title: "包赔条款", body: "包赔条款正文" } }) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession, { "@/lib/supply-client": readyPayoutSupply });
    const probe = createProbe(window, RentalConfirmPanel, { ...defaultProps, fullPayoutSelected: true }, fetchImpl);
    try {
      await probe.render();
      const consent = probe.host.querySelector('input[aria-label="我已阅读并同意全额包赔条款"]');
      assert.ok(consent, "this scenario must load real terms rather than pass because the stub made them unavailable");
      assert.equal(consent.checked, false);
      // Primary button must be blocked when full payout terms are not agreed
      const btn = probe.host.querySelector(".rental-confirm-primary");
      assert.ok(btn);
      assert.match(btn.textContent, /查看并同意包赔条款/);
      assert.equal(btn.disabled, false, "the terms gate stays reachable while consent is unchecked");
      assert.equal([...probe.host.querySelectorAll('button')].some(button => button.textContent.includes('确认并创建订单')), false, "no create action exists before consent");
    } finally {
      await probe.dispose();
    }
  });
});

// Case 8: Unknown intent freezes panel into create-unknown
test("D-08: unknown intent freezes panel into create-unknown, ignoring auto-preview", async () => {
  await withDom(async (window) => {
    const log = [];
    intents.saveIntent({
      userId: loggedSession.userId,
      kind: "order.create.v2",
      resourceId: defaultProps.accountId,
      key: "idemp_1",
      token: "tok_frozen",
      context: { payable: "270.18" },
    });

    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(previewPayload) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      // Must NOT send auto-preview fetch when an unknown intent is present
      assert.equal(log.length, 0, "must not initiate auto-preview when unknown intent exists");

      // Must render create-unknown status
      assert.ok(probe.host.querySelector(".rental-confirm--unknown"));
      assert.match(probe.host.textContent, /创建请求结果未知/);
    } finally {
      intents.clearIntent(loggedSession.userId, "order.create.v2", defaultProps.accountId);
      await probe.dispose();
    }
  });
});

// Case 9: Preview read failure offers GET retry, not POST confirm
test("D-09: preview read failure provides GET retry button and never issues POST order confirmation", async (context) => {
  await withDom(async (window) => {
    const clock = controlClock(context);
    const log = [];
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json({ error: { code: "MEMBERSHIP_UNKNOWN", message: "独立反例：权益暂不可读", requestId: "OFFLINE" } }, 503) },
      { match: "/api/order-confirmations", method: "POST", respond: () => json({ error: { code: "MEMBERSHIP_UNKNOWN", message: "offline only" } }, 503) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      const retryBtn = probe.host.querySelector(".rental-confirm-primary");
      assert.ok(retryBtn);
      assert.match(retryBtn.textContent, /重试|稍后/);

      // Clicking retry button must issue GET retry, NOT POST
      await probe.click(retryBtn.textContent);
      assert.equal(log.filter((x) => x.method === "GET").length, 1, "rapid retry must be throttled");
      await React.act(async () => { clock.advance(5100); await tick(); });
      await probe.render();
      await probe.click("重试读取报价");
      assert.equal(log.filter((x) => x.method === "POST").length, 0, "must not route read retry through confirmation POST");
      assert.equal(log.filter((x) => x.method === "GET").length, 2, "must issue a 2nd GET on read retry");
    } finally {
      await probe.dispose();
      clock.restore();
    }
  });
});

// Case 10: Equal payable total with changed breakdown surfaces priceChangeNotice
test("D-10: equal payable total with changed resource breakdown and deposit surfaces priceChangeNotice", async () => {
  await withDom(async (window) => {
    const log = [];
    const discounted = ["155.77", "13.50", "10.80", "7.20", "10.89"];
    const changedQuote = {
      ...previewPayload.quote,
      lines: previewPayload.quote.lines.map((x, i) => ({ ...x, buyerAmount: cny(discounted[i] ?? "0.00") })),
      resourceTotal: cny("198.16"),
      tenantDeposit: cny("72.02"),
      tenantPayableTotal: cny("270.18"),
    };
    const confirmPayload = {
      quote: changedQuote,
      baseTenantDeposit: cny("50.00"),
      depositWaived: false,
      confirmationId: "conf_changed",
      listingHash: "hash1",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      confirmationToken: "token_abc_123",
    };
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(previewPayload) },
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmPayload) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      await probe.click("立即租用");
      const notice = probe.host.querySelector(".rental-confirm-notice--price-change");
      assert.ok(notice, "equal payable with changed breakdown still requires priceChangeNotice");
    } finally {
      await probe.dispose();
    }
  });
});

// Case 11: Equal amounts with changed membership benefits policy surfaces reconfirmation notice
test("D-11: equal amounts with changed membership benefits policy surfaces reconfirmation notice", async () => {
  await withDom(async (window) => {
    const log = [];
    const changedBenefits = {
      ...previewPayload.membershipBenefits,
      priceSource: "FRIEND",
      policyVersion: "v2",
    };
    const confirmPayload = {
      quote: previewPayload.quote,
      baseTenantDeposit: cny("50.00"),
      membershipBenefits: changedBenefits,
      depositWaived: false,
      confirmationId: "conf_benefits_changed",
      listingHash: "hash1",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      confirmationToken: "token_abc_123",
    };
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(previewPayload) },
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmPayload) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      await probe.click("立即租用");
      const notice = probe.host.querySelector(".rental-confirm-notice--price-change");
      assert.ok(notice, "source/policy changed even though amounts did not must show notice");
    } finally {
      await probe.dispose();
    }
  });
});

// Case 12: Mismatched preview binding tuple is rejected
test("D-12: mismatched preview binding tuple is rejected and not accepted as personal price", async () => {
  await withDom(async (window) => {
    const log = [];
    const wrongBinding = { ...previewPayload, binding: { ...previewPayload.binding, versionId: "another-version" } };
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(wrongBinding) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      const summary = probe.host.querySelector(".rental-price-summary");
      assert.notEqual(summary?.getAttribute("data-personal"), "true", "mismatched response must not be accepted as personal price");
    } finally {
      await probe.dispose();
    }
  });
});

// Case 13: Focus after server refresh hint triggers GET refresh
test("D-13: focus event after server refresh hint triggers GET preview refresh", async () => {
  await withDom(async (window) => {
    const log = [];
    const expiredPreview = {
      ...previewPayload,
      asOfUtc: new Date(Date.now() - 60000).toISOString(),
      refreshAfterUtc: new Date(Date.now() - 30000).toISOString(),
    };
    const fetchImpl = router([
      { match: "/api/rental-price-preview", method: "GET", respond: () => json(expiredPreview) },
    ], log);

    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
    try {
      await probe.render();
      assert.equal(log.filter((x) => x.url.includes("/api/rental-price-preview")).length, 1);

      await React.act(async () => {
        window.dispatchEvent(new window.Event("focus"));
        await tick();
      });

      assert.equal(log.filter((x) => x.url.includes("/api/rental-price-preview")).length, 2, "focus after refreshAfterUtc must issue a fresh GET");
    } finally {
      await probe.dispose();
    }
  });
});

// Case 14: Missing authoritative ratio does not promote fallback label to authoritative badge
test("D-14: missing authoritative ratio does not promote fallback label to authoritative badge", async () => {
  await withDom(async (window) => {
    const missing = {
      ...referenceFees,
      baseRenterHaffRatioWanPerYuan: null,
      lines: referenceFees.lines.map((x, i) => (i === 0 ? { ...x, unitPriceLabel: "约77万/元" } : x)),
    };
    const { RentalPriceSummary } = loadComponent("apps/web/src/components/order/rental-price-summary.tsx", loggedSession);
    const probe = createProbe(window, RentalPriceSummary, { reference: missing, quote: null }, async () => {
      throw Error("No network permitted");
    });
    try {
      await probe.render();
      const badge = probe.host.querySelector(".account-haff-ratio-badge");
      assert.equal(badge, null, "display label is not authoritative ratio metadata");
    } finally {
      await probe.dispose();
    }
  });
});

const changedFactCases = [
  ["pricing denominator", (confirmed) => { confirmed.quote.lines[2].unitQuantity = "30"; }],
  ["informational buyer unit amount", (confirmed) => { confirmed.quote.lines[2].buyerUnitAmount = cny("13.00000000", 8); }],
  ["base tenant deposit", (confirmed) => { confirmed.baseTenantDeposit = cny("100.00"); }],
  ["compensation disclosure version", (confirmed) => { confirmed.compensationDisclosure = { selected: false, disclosureVersion: "disclosure-v2" }; }],
];
for (const [name, change] of changedFactCases) {
  test(`D-facts: ${name} change is disclosed even with unchanged payable`, async () => {
    const preview = structuredClone(comparisonPreview);
    preview.compensationDisclosure = { selected: false, disclosureVersion: "disclosure-v1" };
    const confirmed = confirmationFor(preview);
    change(confirmed);
    await withConfirmedPanel(preview, confirmed, async ({ probe }) => {
      assert.ok(probe.host.querySelector(".rental-confirm-notice--price-change"), `${name} must not silently be treated as identical pricing facts`);
    });
  });
}

test("D-facts: legacy customer tier changes are compared without modern benefit metadata", async () => {
  const preview = structuredClone(comparisonPreview);
  delete preview.membershipBenefits;
  const confirmed = confirmationFor(preview);
  confirmed.customerTier = "VIP";
  await withConfirmedPanel(preview, confirmed, async ({ probe }) => {
    assert.ok(probe.host.querySelector(".rental-confirm-notice--price-change"));
  });
});

test("D-facts: missing required confirmation money cannot become a creatable unknown price", async () => {
  await withDom(async (window) => {
    const log = [], confirmed = confirmationFor(comparisonPreview);
    delete confirmed.quote.tenantDeposit;
    const fetchImpl = router([
      { match: '/api/rental-price-preview', method: 'GET', respond: () => json(comparisonPreview) },
      { match: '/api/order-confirmations', method: 'POST', respond: () => json(confirmed) },
    ], log);
    const { RentalConfirmPanel } = loadComponent('apps/web/src/components/order/rental-confirm-panel.tsx', loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, { ...defaultProps, reference: comparisonReference }, fetchImpl);
    try {
      await probe.render();
      await probe.click('立即租用');
      const submit = [...probe.host.querySelectorAll('button')].find(button => button.textContent.includes('确认并创建订单'));
      assert.ok(!submit || submit.disabled, 'a required deposit is unknown: do not enable order submission');
      assert.ok(probe.host.querySelector('[role="alert"]'), 'show why confirmation cannot continue');
      assert.ok(!log.some(x => x.url.includes('/api/orders-v2')));
    } finally { await probe.dispose(); }
  });
});

test("D-facts: unchanged facts with reordered lines and new credentials do not raise a false change", async () => {
  const preview = structuredClone(comparisonPreview);
  preview.compensationDisclosure = { selected: false, disclosureVersion: "disclosure-v1" };
  const confirmed = confirmationFor(preview);
  confirmed.quote.lines.reverse();
  confirmed.confirmationId = "OFFLINE_SECOND_CONFIRMATION";
  confirmed.confirmationToken = "OFFLINE_SECOND_NOT_REAL_TOKEN";
  confirmed.expiresAt = new Date(Date.now() + 290000).toISOString();
  await withConfirmedPanel(preview, confirmed, async ({ probe }) => {
    assert.equal(probe.host.querySelector(".rental-confirm-notice--price-change"), null);
    assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥282.12");
  });
});

for (const [code, status, readable] of [
  ["CONFIRMATION_CHANGED", 409, /版本|发布.*变化|账号.*变化/],
  ["OCCUPIED", 409, /占用|已被租用|暂不可租/],
  ["CONFIRMATION_DEPENDENCY_UNAVAILABLE", 503, /费用|报价|押金|资金/],
]) {
  test(`D-errors: actual API code ${code} has readable recovery without a confirmation POST`, async (context) => {
    await withDom(async (window) => {
      const clock = controlClock(context), log = [];
      const fetchImpl = router([{ match: "/api/rental-price-preview", method: "GET", respond: () => json({ error: { code, message: "OFFLINE_UPSTREAM_DETAIL", requestId: "OFFLINE_REQUEST" } }, status) }], log);
      const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession);
      const probe = createProbe(window, RentalConfirmPanel, defaultProps, fetchImpl);
      try {
        await probe.render();
        const alert = probe.host.querySelector('.rental-confirm-error[role="alert"]');
        assert.ok(alert);
        assert.match(alert.textContent, readable, "known protocol codes need a useful user-facing explanation");
        assert.notEqual(probe.host.querySelector('.rental-price-summary')?.getAttribute('data-personal'), 'true');
        if (code === "CONFIRMATION_CHANGED") {
          assert.ok([...probe.host.querySelectorAll('button,a')].some(x => /刷新/.test(x.textContent)), "stale references need an account refresh action");
        } else if (code === "CONFIRMATION_DEPENDENCY_UNAVAILABLE") {
          await React.act(async () => { clock.advance(5100); await tick(); });
          await probe.render();
          await probe.click("重试读取报价");
          assert.equal(log.filter(x => x.method === 'GET').length, 2);
        }
        assert.equal(log.filter(x => x.method === 'POST').length, 0);
      } finally { await probe.dispose(); clock.restore(); }
    });
  });
}

test("D-retry: unaccepted full-payout terms do not block a read-only price retry", async (context) => {
  await withDom(async (window) => {
    const clock = controlClock(context), log = [];
    let reads = 0;
    const fetchImpl = router([{ match: "/api/rental-price-preview", method: "GET", respond: () => ++reads === 1
      ? json({ error: { code: "CONFIRMATION_DEPENDENCY_UNAVAILABLE", message: "OFFLINE_UPSTREAM_DETAIL" } }, 503)
      : json({ ...comparisonPreview, compensationDisclosure: { selected: true, disclosureVersion: "d1", terms: readyPayoutTerms } }) }], log);
    const { RentalConfirmPanel } = loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", loggedSession, { "@/lib/supply-client": readyPayoutSupply });
    const probe = createProbe(window, RentalConfirmPanel, { ...defaultProps, reference: comparisonReference, fullPayoutSelected: true }, fetchImpl);
    try {
      await probe.render();
      const consent = probe.host.querySelector('input[aria-label="我已阅读并同意全额包赔条款"]');
      assert.ok(consent);
      assert.equal(consent.checked, false);
      await React.act(async () => { clock.advance(5100); await tick(); });
      await probe.render();
      await probe.click("重试读取报价");
      assert.equal(reads, 2, "consent gates renting, not reading price");
      assert.equal(log.filter(x => x.method === 'POST').length, 0);
      assert.equal(probe.host.querySelector('.account-reference-price').textContent, '¥282.12');
      assert.equal(probe.host.querySelector('.rental-confirm-primary').textContent, "查看并同意包赔条款", "a successful price read keeps the terms gate instead of skipping it");
      assert.equal([...probe.host.querySelectorAll('button')].some(button => button.textContent.includes('确认并创建订单')), false, "successful price read must not accept terms implicitly");
      assert.equal(consent.checked, false);
    } finally { await probe.dispose(); clock.restore(); }
  });
});

test("D-refresh: focus during confirmation and after quoting cannot replace the frozen confirmation", async () => {
  await withDom(async (window) => {
    const log = [], confirmationGate = deferred();
    const old = { ...comparisonPreview, refreshAfterUtc: new Date(Date.now() - 30000).toISOString() };
    const confirmed = confirmationFor(old);
    confirmed.quote.tenantDeposit = cny('60.00');
    confirmed.baseTenantDeposit = cny('100.00');
    confirmed.quote.tenantPayableTotal = cny('292.12');
    const fetchImpl = router([
      { match: '/api/rental-price-preview', method: 'GET', respond: () => json(old) },
      { match: '/api/order-confirmations', method: 'POST', respond: () => confirmationGate.promise.then(() => json(confirmed)) },
    ], log);
    const { RentalConfirmPanel } = loadComponent('apps/web/src/components/order/rental-confirm-panel.tsx', loggedSession);
    const probe = createProbe(window, RentalConfirmPanel, { ...defaultProps, reference: comparisonReference }, fetchImpl);
    try {
      await probe.render();
      await probe.click('立即租用');
      await React.act(async () => { window.dispatchEvent(new window.Event('focus')); await tick(); });
      assert.equal(log.filter(x => x.method === 'GET').length, 1, 'a confirming transaction must not start another price read');
      await React.act(async () => { confirmationGate.resolve(); await tick(); });
      assert.equal(probe.host.querySelector('.account-reference-price').textContent, '¥292.12');
      await React.act(async () => { window.dispatchEvent(new window.Event('focus')); await tick(); });
      assert.equal(log.filter(x => x.method === 'GET').length, 1);
      assert.equal(probe.host.querySelector('.account-reference-price').textContent, '¥292.12');
      assert.equal(probe.host.querySelector('.rental-confirm-primary').disabled, false);
    } finally { await probe.dispose(); }
  });
});

test("D-refresh: identity change aborts an in-flight refresh and rejects its late private price", async () => {
  await withDom(async (window) => {
    const session = { ...loggedSession }, log = [], oldRefresh = deferred();
    const old = { ...comparisonPreview, refreshAfterUtc: new Date(Date.now() - 30000).toISOString() };
    const next = {
      ...comparisonPreview,
      quote: { ...comparisonPreview.quote, lines: comparisonPreview.quote.lines.map((line, index) => index === 0 ? { ...line, buyerAmount: cny('183.08') } : line), resourceTotal: cny('242.12'), tenantPayableTotal: cny('292.12') },
    };
    let reads = 0;
    const fetchImpl = router([{ match: '/api/rental-price-preview', method: 'GET', respond: () => ++reads === 1 ? json(old) : reads === 2 ? oldRefresh.promise.then(() => json(old)) : json(next) }], log);
    const { RentalConfirmPanel } = loadComponent('apps/web/src/components/order/rental-confirm-panel.tsx', session);
    const probe = createProbe(window, RentalConfirmPanel, { ...defaultProps, reference: comparisonReference }, fetchImpl);
    try {
      await probe.render();
      await React.act(async () => { window.dispatchEvent(new window.Event('focus')); await tick(); });
      const refreshSignal = log[1].init.signal;
      assert.equal(refreshSignal.aborted, false);
      session.userId = 'user_renter_2';
      session.identityVersion = 2;
      await probe.render();
      assert.equal(refreshSignal.aborted, true);
      assert.equal(probe.host.querySelector('.account-reference-price').textContent, '¥292.12');
      await React.act(async () => { oldRefresh.resolve(); await tick(); });
      assert.equal(probe.host.querySelector('.account-reference-price').textContent, '¥292.12');
      assert.equal(log.filter(x => x.method === 'POST').length, 0);
    } finally { await probe.dispose(); }
  });
});
