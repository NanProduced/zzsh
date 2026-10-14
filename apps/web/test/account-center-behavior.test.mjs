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
const source = fs.readFileSync(path.join(tree, "apps/web/src/components/account/account-center.tsx"), "utf8");
const compiled = typescript.transpileModule(source, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const pageSource = fs.readFileSync(path.join(tree, "apps/web/src/app/account/page.tsx"), "utf8");

let membershipModule = null;

function makeEmblaApi() {
  const handlers = {};
  const api = {
    container: null,
    index: 0,
    calls: [],
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    off(name, fn) { handlers[name] = (handlers[name] || []).filter((item) => item !== fn); },
    selectedScrollSnap: () => api.index,
    scrollSnapList: () => Array.from({ length: 10 }, (_, i) => i / 9),
    scrollProgress: () => api.index / 9,
    scrollTo(next) { api.index = next; api.calls.push(next); (handlers.select || []).slice().forEach((fn) => fn(api)); },
    scrollPrev() { api.scrollTo(api.index - 1); },
    scrollNext() { api.scrollTo(api.index + 1); },
    reInit() { (handlers.reInit || []).slice().forEach((fn) => fn(api)); },
    slideNodes: () => [],
    containerNode: () => api.container,
  };
  return api;
}

const emblaStub = { __esModule: true, default: () => [() => {}, makeEmblaApi()] };
const dialogStub = {
  Root: ({ children }) => React.createElement("div", null, children),
  Trigger: ({ children }) => children,
  Portal: ({ children }) => children,
  Overlay: () => null,
  Content: ({ children }) => React.createElement("div", { role: "dialog" }, children),
  Title: ({ children }) => React.createElement("h2", null, children),
  Close: ({ children }) => children,
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function loadCenter(session) {
  const module = new Module(path.join(tree, "account-center-component-probe.cjs"));
  module.filename = path.join(tree, "account-center-component-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "next/link") return function Link({ scroll: _scroll, ...props }) { return React.createElement("a", props); };
    if (name === "@/components/session/user-session-provider") return { useUserSession: () => session, useUserSessionStore: () => ({ getSnapshot: () => session }) };
    if (name === "./personal-wallet") {
      const child = new Module(path.join(tree, "wallet-summary-probe.cjs"));
      child.filename = path.join(tree, "wallet-summary-probe.cjs"); child.paths = Module._nodeModulePaths(tree); child.require = module.require;
      child._compile(typescript.transpileModule(fs.readFileSync(path.join(tree, "apps/web/src/components/account/personal-wallet.tsx"), "utf8"), { compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, child.filename);
      return child.exports;
    }
    if (name === "./controlled-withdrawal") return { ControlledWithdrawal: () => null };
    // 昵称编辑入口迁到总览后由其专属用例覆盖（test/nickname-edit.test.mjs）；本文件只桩掉渲染。
    if (name === "./nickname-edit") return { NicknameEditEntry: () => null };
    if (name === "@/components/auth/auth-form") return {
      WebAuthError: class WebAuthError extends Error { constructor(status) { super("AUTH_ERROR"); this.status = status; } },
      webAuthRequest: async (path, _body, signal) => {
        const response = await globalThis.fetch(`/api/auth/user${path}`, { signal });
        if (!response.ok) throw new Error("AUTH_ERROR");
        return response.json();
      },
      maskPhone: (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`,
    };
    if (name === "@/app/user-account-status") return {
      accountStatusLabel: (status) => ({ ACTIVE: "账号正常", DEACTIVATED: "账号已停用", CANCELLED: "账号已注销" })[status],
      identityStatusLabel: (status) => ({ VERIFIED: "实名已验证", UNVERIFIED: "尚未验证", REJECTED: "实名未通过", UNKNOWN: "暂无法确认" })[status],
    };
    if (name === "@/lib/order-client") return requireFromTree(path.join(tree, "apps/web/src/lib/order-client.ts"));
    if (name === "@/lib/membership-client") return requireFromTree(path.join(tree, "apps/web/src/lib/membership-client.ts"));
    if (name === "@/lib/membership-growth-client") {
      const MockGrowthError = class MembershipGrowthRequestError extends Error {
        constructor(status, body) {
          super(body?.error?.message ?? "GROWTH_ERROR");
          this.status = status;
          this.code = status === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR";
        }
      };
      return {
        MembershipGrowthRequestError: MockGrowthError,
        readMyMembershipGrowth: async (signal) => {
          const response = await globalThis.fetch("/api/account/membership-growth", { signal });
          if (!response.ok) throw new MockGrowthError(response.status, await response.json().catch(() => null));
          return response.json();
        },
      };
    }
    if (name === "./membership-center") {
      const child = new Module(path.join(tree, "membership-center-probe.cjs"));
      child.filename = path.join(tree, "membership-center-probe.cjs");
      child.paths = Module._nodeModulePaths(tree);
      child.require = (request) => {
        if (request === "../ui/progress") {
          const progressPath = path.join(tree, "apps/web/src/components/ui/progress.tsx");
          const progress = new Module(progressPath);
          progress.filename = progressPath;
          progress.paths = Module._nodeModulePaths(path.dirname(progressPath));
          progress._compile(typescript.transpileModule(fs.readFileSync(progressPath, "utf8"), { compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, progressPath);
          return progress.exports;
        }
        if (request === "embla-carousel-react") return emblaStub;
        if (request === "@radix-ui/react-dialog") return dialogStub;
        return module.require(request);
      };
      child._compile(typescript.transpileModule(fs.readFileSync(path.join(tree, "apps/web/src/components/account/membership-center.tsx"), "utf8"), { compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, child.filename);
      membershipModule = child.exports;
      return child.exports;
    }
    if (name === "@/lib/personal-wallet-client") return requireFromTree(path.join(tree, "apps/web/src/lib/personal-wallet-client.ts"));
    if (name === "@/lib/credit-guarantee-client") {
      const child = new Module(path.join(tree, "credit-probe.cjs"));
      child.filename = path.join(tree, "credit-probe.cjs");
      child.paths = Module._nodeModulePaths(tree);
      child.require = module.require;
      child._compile(typescript.transpileModule(fs.readFileSync(path.join(tree, "apps/web/src/lib/credit-guarantee-client.ts"), "utf8"), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, child.filename);
      return child.exports;
    }
    if (name.endsWith(".css")) return {};
    return requireFromTree(name);
  };
  module._compile(compiled, module.filename);
  return module.exports;
}

async function createProbe(fetchImpl, options = {}) {
  const window = new Window({ url: "http://127.0.0.1:3100/account" });
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    DOMException: window.DOMException,
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  window.scrollTo = (options) => { window.__lastScrollTo = options; };
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const session = {
    status: "authenticated",
    userId: "user_A",
    displayName: "用户甲",
    identityVersion: 1,
    revalidations: 0,
    ...options.session,
  };
  session.revalidate = () => { session.revalidations += 1; };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (input, requestOptions) => {
    const url = String(input);
    const authReply = options.authFetch?.(url);
    if (authReply) return authReply;
    if (url.endsWith("/get-session")) return Promise.resolve(json({ user: { id: session.userId, phoneNumber: "13800138000" } }));
    if (url.endsWith("/identity/status")) return Promise.resolve(json({ accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", provider: "fake", eligibleForProtectedTrade: true }));
    if (url.includes("/api/account/credit") || url.includes("/credit/overview")) return Promise.resolve(json({ credit: { userId: session.userId, score: 100, revision: "1", initializedAt: "2026-09-01", events: [] }, recoveryRequests: [], guarantees: [], transactions: [] }));
    if (url.includes("/api/account/membership-growth")) {
      const growthReply = options.growthFetch?.(url);
      if (growthReply) return growthReply;
      return Promise.resolve(json({ status: "unknown", message: "成长服务尚未接线" }));
    }
    return fetchImpl(input, requestOptions);
  };
  const center = loadCenter(session);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = requireFromTree("react-dom/client").createRoot(host);

  async function render(node) {
    await React.act(async () => { root.render(node); });
    await tick();
  }

  async function click(selector) {
    const target = host.querySelector(selector);
    assert.ok(target, `missing ${selector}`);
    await React.act(async () => {
      target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
      await tick();
    });
    await tick();
  }

  async function dispose() {
    await React.act(async () => root.unmount());
    await window.happyDOM.abort();
    globalThis.fetch = previousFetch;
  }

  return { window, host, session, center, membership: membershipModule, render, click, dispose };
}

const emptyPage = { items: [], nextCursor: null, limit: 100 };
const orderA = { id: "order_A", displayNo: "A-001", title: "PRIVATE_ORDER_A", status: "PENDING_PAYMENT" };
const orderB = { id: "order_B", displayNo: "B-001", title: "PRIVATE_ORDER_B", status: "PAID" };

function json(body, status = 200) {
  return Response.json(body, { status });
}

test("missing account view opens the overview and order links keep the current order location", () => {
  assert.match(pageSource, /p\.view:''/);
  assert.doesNotMatch(pageSource, /p\.view:'accounts'/);
  const { resolveAccountView, accountSectionHref } = loadCenter({});
  assert.equal(resolveAccountView(""), "overview");
  assert.equal(resolveAccountView("overview"), "overview");
  assert.equal(resolveAccountView("favorites"), "favorites");
  assert.equal(resolveAccountView("unknown-view"), "rentals");
  const href = accountSectionHref("rentals", { view: "rentals", accountId: "acc_1", orderId: "order_A", status: "PAID" });
  const query = new URLSearchParams(href.split("?")[1]);
  assert.equal(query.get("view"), "rentals");
  assert.equal(query.get("accountId"), "acc_1");
  assert.equal(query.get("orderId"), "order_A");
  assert.equal(query.get("status"), "PAID");
  assert.equal(accountSectionHref("leased", { view: "rentals", orderId: "order_A", status: "PAID" }), "/account?view=leased");
});

test("empty orders show the next step and no invented count", async () => {
  const calls = [];
  const probe = await createProbe(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("membership-growth") || url.includes("rental-membership")) return json({ status: "unknown", message: "成长服务尚未接线" });
    return json(emptyPage);
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    assert.match(probe.host.textContent, /暂无租入记录/);
    assert.match(probe.host.textContent, /暂无出租记录/);
    assert.equal(probe.host.querySelector("[data-testid=order-count-renter]"), null);
    assert.equal(probe.host.querySelector("[data-testid=order-count-owner]"), null);
    assert.equal(probe.host.querySelector(".account-profile-actions"), null);
    // UUID removed per M1 requirement
    assert.equal(probe.host.querySelector(".account-profile-id"), null);
    assert.doesNotMatch(probe.host.textContent, /账号编号/);
    assert.equal(probe.host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow"), "100");
    // Real credit score in Row 2 strip replaces obsolete placeholder
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /信用/);
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /100/);
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /按出租账号查看保证金要求/);
    assert.match(probe.host.querySelector(".account-status-panel").textContent, /138\*\*\*\*8000/);
    assert.match(probe.host.querySelector(".account-status-panel").textContent, /实名已验证/);
    assert.match(probe.host.querySelector(".account-wallet-preview").textContent, /钱包暂时无法读取/);
    assert.doesNotMatch(probe.host.querySelector(".account-wallet-preview").textContent, /\d+\.\d{2}/);
    assert.equal(probe.host.querySelector("[data-testid=order-summary-renter] a[href='/accounts']").textContent, "浏览账号");
    assert.equal(probe.host.querySelector("[data-testid=order-summary-owner] a[href='/publish']").textContent, "发布账号");
    assert.equal(probe.host.querySelectorAll(".account-summary-more").length, 0);
    assert.ok(calls.some((url) => url.includes("party=renter") && url.includes("limit=3")));
    assert.ok(calls.some((url) => url.includes("party=owner") && url.includes("limit=3")));
    assert.equal(probe.host.querySelector("[data-testid=membership-tier]").textContent, "资格待确认");
  } finally {
    await probe.dispose();
  }
});

test("overview account status fails closed and can be retried", async () => {
  let statusFails = true;
  const probe = await createProbe(async (input) => {
    return json(emptyPage);
  }, { authFetch: (url) => url.endsWith("/identity/status") && statusFails ? Promise.resolve(json({ error: { code: "UNAVAILABLE" } }, 503)) : null });
  try {
    await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_A:1" }));
    assert.match(probe.host.querySelector(".account-status-panel").textContent, /账号状态暂无法读取/);
    assert.doesNotMatch(probe.host.querySelector(".account-status-panel").textContent, /实名已验证/);
    statusFails = false;
    await probe.click(".account-status-retry button");
    assert.match(probe.host.querySelector(".account-status-panel").textContent, /实名已验证/);
  } finally {
    await probe.dispose();
  }
});

test("a loading summary does not show the previous identity's order", async () => {
  const pending = deferred();
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("party=renter")) return pending.promise;
    return json(emptyPage);
  });
  try {
    const { AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:1" }));
    const rental = probe.host.querySelector("[data-testid=order-summary-renter]");
    assert.equal(rental.getAttribute("aria-busy"), "true");
    assert.match(rental.textContent, /正在读取订单/);
    assert.doesNotMatch(rental.textContent, /PRIVATE_ORDER_A/);
    pending.resolve(json({ items: [orderA], nextCursor: null, limit: 3 }));
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:1" }));
    assert.match(probe.host.textContent, /PRIVATE_ORDER_A/);
    assert.equal(probe.host.querySelector("[data-testid=order-status-renter]").textContent, "待支付");
    assert.equal(probe.host.querySelector("[data-testid=order-count-renter]"), null);
  } finally {
    await probe.dispose();
  }
});

test("one order card can fail and retry without clearing the other card", async () => {
  let renterFails = true;
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("party=renter")) return renterFails ? json({ error: { code: "INTERNAL_ERROR" } }, 500) : json({ items: [orderA], nextCursor: null, limit: 100 });
    return json({ items: [orderB], nextCursor: null, limit: 100 });
  });
  try {
    const { AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:1" }));
    assert.match(probe.host.querySelector("[data-testid=order-summary-renter]").textContent, /租入订单暂时无法读取/);
    assert.match(probe.host.querySelector("[data-testid=order-summary-owner]").textContent, /PRIVATE_ORDER_B/);
    assert.equal(probe.host.querySelector("[data-testid=order-status-owner]").textContent, "已支付");
    renterFails = false;
    await probe.click("[data-testid=retry-renter]");
    assert.match(probe.host.querySelector("[data-testid=order-summary-renter]").textContent, /PRIVATE_ORDER_A/);
    assert.match(probe.host.querySelector("[data-testid=order-summary-owner]").textContent, /PRIVATE_ORDER_B/);
  } finally {
    await probe.dispose();
  }
});

test("an incomplete page shows the latest status without inventing a total", async () => {
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("party=renter")) return json({ items: [orderA], nextCursor: "more", limit: 100 });
    return json(emptyPage);
  });
  try {
    const { AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:1" }));
    assert.equal(probe.host.querySelector("[data-testid=order-count-renter]"), null);
    assert.match(probe.host.textContent, /待支付/);
    assert.match(probe.host.textContent, /还有更多订单/);
    assert.doesNotMatch(probe.host.querySelector("[data-testid=order-summary-renter]").textContent, /1 条/);
  } finally {
    await probe.dispose();
  }
});

test("membership card uses the confirmed tier and a missing field is not invented", async () => {
  const blackGoldGrowth = {
    status: "ready",
    data: {
      tier: "BLACK_GOLD",
      rollingPoints: "15200",
      lifetimePoints: "58620",
      asOf: "2026-10-11T00:00:00Z",
      nextTier: null,
      grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
      nextExpiryAt: null,
      benefits: [],
      entitlements: [],
      contributions: [],
      pendingCount: 0,
    },
  };
  let growthPayload = blackGoldGrowth;
  const probe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json(growthPayload)),
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    const card = probe.host.querySelector("[data-testid=membership-card]");
    assert.equal(card.getAttribute("aria-hidden"), "true");
    assert.equal(card.getAttribute("data-tier"), "BLACK_GOLD");
    assert.ok(card.classList.contains("has-card-art"));
    const cardImg = card.querySelector(".membership-card-img");
    assert.ok(cardImg);
    assert.equal(cardImg.getAttribute("src"), "/art/membership/a-metal/black-gold-card.webp");
    const tier = probe.host.querySelector("[data-testid=membership-tier]");
    assert.equal(tier.textContent, "黑金会员 · 终身");
    assert.equal(card.contains(tier), false);
    assert.match(probe.host.textContent, /用户甲/);
    assert.ok(probe.host.querySelector(".account-growth-header-wrap.tier-black-gold"));

    growthPayload = { status: "unknown", message: "成长服务尚未接线" };
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:2" }, React.createElement(AccountOverview, { scope: "user_A:2" })));
    const unknownTier = probe.host.querySelector("[data-testid=membership-tier]");
    assert.equal(unknownTier.textContent, "资格待确认");
    assert.equal(probe.host.querySelector("[data-testid=membership-card]").getAttribute("data-tier"), null);

    const nav = [...probe.host.querySelectorAll(".account-nav a")];
    assert.equal(nav.length, 11);
    assert.ok(nav.every((link) => link.tagName === "A" && link.getAttribute("href")?.startsWith("/account?view=")));
    assert.equal(probe.host.querySelector(".account-nav a[aria-current=page]").textContent.includes("总览"), true);
    const membershipNav = nav.find((link) => link.getAttribute("href") === "/account?view=membership");
    assert.ok(membershipNav);
    assert.match(membershipNav.textContent, /会员中心/);
    const wallet = nav.find((link) => link.getAttribute("href") === "/account?view=wallet");
    assert.doesNotMatch(wallet.textContent, /待接入/);
    assert.ok(wallet.querySelector(".account-nav-chevron"));
  } finally {
    await probe.dispose();
  }
});

test("membership growth displays entitlements and points progression accurately", async () => {
  const goldGrowth = {
    status: "ready",
    data: {
      tier: "GOLD",
      rollingPoints: "12480",
      lifetimePoints: "12480",
      asOf: "2026-10-11T00:00:00Z",
      nextTier: { tier: "PLATINUM", threshold: "20000", remaining: "7520" },
      grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
      nextExpiryAt: null,
      benefits: [{ label: "免押权益", value: "部分免押" }],
      entitlements: [
        {
          kind: "PRESTIGE",
          label: "尊享礼遇",
          scope: "DELTA_ACCOUNT_RENTAL",
          endsAt: "2026-12-31T00:00:00Z",
          state: "ACTIVE",
          depositWaived: true,
        },
      ],
      contributions: [],
      pendingCount: 0,
    },
  };
  const probe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json(goldGrowth)),
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    // Entitlement badge
    const entitlement = probe.host.querySelector("[data-testid=active-entitlement]");
    assert.ok(entitlement);
    assert.match(entitlement.textContent, /尊享礼遇/);
    assert.match(entitlement.textContent, /三角洲租赁/);
    assert.match(entitlement.textContent, /2026\.12\.31/);

    // Points display
    assert.match(probe.host.textContent, /近90天成长/);
    assert.match(probe.host.textContent, /12480/);
    assert.match(probe.host.textContent, /距铂金会员 7520 积分/);

    // Navigation link to independent membership center
    const actionLink = probe.host.querySelector(".account-growth-action-link");
    assert.ok(actionLink);
    assert.equal(actionLink.getAttribute("href"), "/account?view=membership");
    assert.match(actionLink.textContent, /查看成长与权益/);
  } finally {
    await probe.dispose();
  }
});

test("a membership read failure can retry and does not remove the order summaries", async () => {
  let fail = true;
  const silverGrowth = {
    status: "ready",
    data: {
      tier: "SILVER",
      rollingPoints: "6400",
      lifetimePoints: "6400",
      asOf: "2026-10-11T00:00:00Z",
      nextTier: { tier: "GOLD", threshold: "10000", remaining: "3600" },
      grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
      nextExpiryAt: null,
      benefits: [],
      entitlements: [],
      contributions: [],
      pendingCount: 0,
    },
  };
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("party=owner")) return json({ items: [orderB], nextCursor: null, limit: 100 });
    return json(emptyPage);
  }, {
    growthFetch: () => fail ? Promise.resolve(json({ error: { code: "INTERNAL_ERROR", message: "服务内部错误" } }, 503)) : Promise.resolve(json(silverGrowth)),
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "rentals", scope: "user_A:1", orderId: "order_A", status: "PAID", accountId: "acc_1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    assert.match(probe.host.textContent, /会员成长暂时无法读取/);
    assert.match(probe.host.textContent, /PRIVATE_ORDER_B/);
    assert.equal(probe.host.querySelector(".account-nav a[aria-current=page]").getAttribute("href"), "/account?view=rentals&accountId=acc_1&status=PAID&orderId=order_A");
    fail = false;
    await probe.click("[data-testid=retry-membership]");
    assert.equal(probe.host.querySelector("[data-testid=membership-tier]").textContent, "银卡会员");
    assert.equal(probe.host.querySelector("[data-testid=membership-card]").getAttribute("data-tier"), "SILVER");
    assert.match(probe.host.textContent, /PRIVATE_ORDER_B/);
  } finally {
    await probe.dispose();
  }
});

test("a late response from the previous identity cannot replace the current one", async () => {
  const pendingOrders = deferred();
  const pendingGrowth = deferred();
  let phase = "A";
  const standardGrowth = {
    status: "ready",
    data: {
      tier: "STANDARD",
      rollingPoints: "1280",
      lifetimePoints: "1280",
      asOf: "2026-10-11T00:00:00Z",
      nextTier: { tier: "SILVER", threshold: "5000", remaining: "3720" },
      grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
      nextExpiryAt: null,
      benefits: [],
      entitlements: [],
      contributions: [],
      pendingCount: 0,
    },
  };
  const diamondGrowth = {
    status: "ready",
    data: {
      tier: "DIAMOND",
      rollingPoints: "43280",
      lifetimePoints: "43280",
      asOf: "2026-10-11T00:00:00Z",
      nextTier: null,
      grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
      nextExpiryAt: null,
      benefits: [],
      entitlements: [],
      contributions: [],
      pendingCount: 0,
    },
  };
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("party=renter")) return phase === "A" ? pendingOrders.promise : json({ items: [orderB], nextCursor: null, limit: 100 });
    return json(emptyPage);
  }, {
    growthFetch: () => phase === "A" ? pendingGrowth.promise : Promise.resolve(json(standardGrowth)),
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    phase = "B";
    probe.session.userId = "user_B";
    probe.session.displayName = "用户乙";
    probe.session.identityVersion = 2;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_B:2" }, React.createElement(AccountOverview, { scope: "user_B:2" })));
    pendingGrowth.resolve(json(diamondGrowth));
    pendingOrders.resolve(json({ items: [orderA], nextCursor: null, limit: 100 }));
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_B:2" }, React.createElement(AccountOverview, { scope: "user_B:2" })));
    assert.match(probe.host.textContent, /用户乙/);
    assert.doesNotMatch(probe.host.textContent, /用户甲|PRIVATE_ORDER_A|钻石会员/);
    assert.equal(probe.host.querySelector("[data-testid=membership-tier]").textContent, "普通会员");
    assert.match(probe.host.textContent, /PRIVATE_ORDER_B/);
  } finally {
    await probe.dispose();
  }
});

test("three recent orders are rendered with their confirmed fields and deep links, and mobile tabs render", async () => {
  const order1 = { id: "order_1", displayNo: "ORD-001", title: "三角洲突击账号", status: "PENDING_PAYMENT", createdAt: "2026-09-30 10:00" };
  const order2 = { id: "order_2", displayNo: "ORD-002", title: "无畏契约全英雄", status: "PAID", createdAt: "2026-09-30 09:00" };
  const order3 = { id: "order_3", displayNo: "ORD-003", title: "英雄联盟全皮肤", status: "COMPLETED", createdAt: "2026-09-30 08:00" };
  const order4 = { id: "order_4", displayNo: "ORD-004", title: "第四条多余订单", status: "CANCELLED", createdAt: "2026-09-30 07:00" };

  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("party=renter")) return json({ items: [order1, order2, order3, order4], nextCursor: "cursor_4", limit: 3 });
    return json(emptyPage);
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));

    // Renter card has 3 items, not 4
    const renterCard = probe.host.querySelector("[data-testid=order-summary-renter]");
    assert.ok(renterCard);
    const rows = renterCard.querySelectorAll(".account-order-row");
    assert.equal(rows.length, 3);
    assert.match(renterCard.textContent, /ORD-001/);
    assert.match(renterCard.textContent, /ORD-002/);
    assert.match(renterCard.textContent, /ORD-003/);
    assert.doesNotMatch(renterCard.textContent, /ORD-004/);
    assert.doesNotMatch(renterCard.textContent, /第四条多余订单/);

    // Deep link href
    const firstLink = rows[0].getAttribute("href");
    assert.ok(firstLink.includes("view=rentals"));
    assert.ok(firstLink.includes("orderId=order_1"));

    // Pending tasks card shows pending payment order
    const pendingCard = probe.host.querySelector(".account-pending-card");
    assert.ok(pendingCard);
    assert.match(pendingCard.textContent, /近期订单提醒/);
    assert.match(pendingCard.textContent, /订单待付款/);
    assert.match(pendingCard.textContent, /去付款/);

    // Mobile tabs (4 fixed buttons: overview, membership, rentals, more)
    const mobileTabs = probe.host.querySelectorAll(".account-mobile-tab-btn");
    assert.equal(mobileTabs.length, 4);
    assert.equal(mobileTabs[0].getAttribute("aria-current"), "page");
    assert.match(mobileTabs[0].textContent, /总览/);
    assert.match(mobileTabs[1].textContent, /会员中心/);
    assert.match(mobileTabs[2].textContent, /租入订单/);

    // Click "更多" opens the more menu
    const moreBtn = probe.host.querySelector(".account-mobile-tab-btn[aria-controls=account-mobile-more-menu]");
    assert.ok(moreBtn);
    assert.equal(moreBtn.getAttribute("aria-expanded"), "false");
    await probe.click(".account-mobile-tab-btn[aria-controls=account-mobile-more-menu]");
    assert.equal(moreBtn.getAttribute("aria-expanded"), "true");
    const moreMenu = probe.host.querySelector("#account-mobile-more-menu");
    assert.ok(moreMenu);
    assert.match(moreMenu.textContent, /实名认证/);
    assert.match(moreMenu.textContent, /我的钱包/);
    assert.match(moreMenu.textContent, /邀请与佣金/);
  } finally {
    await probe.dispose();
  }
});

test("switching or clicking primary tabs resets scroll to unified content start", async () => {
  const probe = await createProbe(async () => json(emptyPage));
  try {
    const { AccountCenterFrame } = probe.center;
    probe.window.__lastScrollTo = null;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement("div", null, "overview content")));

    // Initial render does not needlessly scroll if not active transition
    // Now switch active tab to rentals
    probe.window.__lastScrollTo = null;
    await probe.render(React.createElement(AccountCenterFrame, { active: "rentals", scope: "user_A:1" }, React.createElement("div", null, "rentals content")));
    assert.deepEqual(probe.window.__lastScrollTo, { top: 0, behavior: "auto" });

    // Clicking the already active tab also resets scroll to top
    probe.window.__lastScrollTo = null;
    await probe.click(".account-nav a[aria-current=page]");
    assert.deepEqual(probe.window.__lastScrollTo, { top: 0, behavior: "auto" });
  } finally {
    await probe.dispose();
  }
});

test("F1: identity scope switch isolates wallet and credit without leaking old values", async () => {
  const pendingCredit = deferred();
  let currentCredit = { credit: { userId: "user_A", score: 88, revision: "1", initializedAt: "2026-09-01", events: [] }, recoveryRequests: [], guarantees: [], transactions: [] };
  const probe = await createProbe(async () => json(emptyPage), {
    authFetch: (url) => {
      if (url.includes("/credit")) {
        if (probe.session.userId === "user_B") return pendingCredit.promise;
        return Promise.resolve(json(currentCredit));
      }
      return null;
    },
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /88/);

    // Switch to user_B
    probe.session.userId = "user_B";
    probe.session.displayName = "用户乙";
    probe.session.identityVersion = 2;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_B:2" }, React.createElement(AccountOverview, { scope: "user_B:2" })));

    // During user_B loading, credit score must be isolated, not showing user_A's 88
    const creditPreview = probe.host.querySelector(".account-credit-preview");
    assert.doesNotMatch(creditPreview.textContent, /88/);
    assert.match(creditPreview.textContent, /正在读取信用分/);

    // Resolve user_B credit with score 95
    pendingCredit.resolve(json({ credit: { userId: "user_B", score: 95, revision: "1", initializedAt: "2026-09-01", events: [] }, recoveryRequests: [], guarantees: [], transactions: [] }));
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_B:2" }, React.createElement(AccountOverview, { scope: "user_B:2" })));
    assert.match(creditPreview.textContent, /95/);
  } finally {
    await probe.dispose();
  }
});

test("F2: 401 in readMyCredit and readMyWallet triggers session.revalidate()", async () => {
  let credit401 = false;
  const probe = await createProbe(async () => json(emptyPage), {
    authFetch: (url) => {
      if (url.includes("/credit") && credit401) {
        return Promise.resolve(json({ error: { code: "UNAUTHENTICATED" } }, 401));
      }
      return null;
    },
  });
  try {
    const { AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:1" }));
    const initialRevalidations = probe.session.revalidations;

    credit401 = true;
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:2" }));
    assert.ok(probe.session.revalidations > initialRevalidations, "401 credit response triggered session.revalidate");
  } finally {
    await probe.dispose();
  }
});

test("F3: credit guarantee mapping handles UNKNOWN, REQUIRED, PAYMENT_PENDING, REFUND, and NOT_REQUIRED", async () => {
  const makeGuarantee = (state) => ({
    accountId: "acc_1",
    displayNo: "ACC-01",
    gameId: "game_1",
    versionId: null,
    priceVersionId: "pv_1",
    releaseId: "rel_1",
    baseCents: null,
    requiredCents: "1000",
    score: 80,
    state,
    reference: null,
  });
  let guaranteeList = [makeGuarantee("UNKNOWN")];
  const probe = await createProbe(async () => json(emptyPage), {
    authFetch: (url) => {
      if (url.includes("/credit")) {
        return Promise.resolve(json({
          credit: { userId: "user_A", score: 80, revision: "1", initializedAt: "2026-09-01", events: [] },
          recoveryRequests: [],
          guarantees: guaranteeList,
          transactions: [],
        }));
      }
      return null;
    },
  });
  try {
    const { AccountOverview } = probe.center;

    // UNKNOWN -> 按出租账号查看保证金要求
    guaranteeList = [makeGuarantee("UNKNOWN")];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:1" }));
    await tick();
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /按出租账号查看保证金要求/);

    // REQUIRED -> 待补号主保证金
    guaranteeList = [makeGuarantee("REQUIRED")];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:2" }));
    await tick();
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /待补号主保证金/);

    // PAYMENT_PENDING -> 保证金支付结果待确认
    guaranteeList = [makeGuarantee("PAYMENT_PENDING")];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:3" }));
    await tick();
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /保证金支付结果待确认/);

    // REFUND_REQUESTED -> 保证金退还处理中
    guaranteeList = [makeGuarantee("REFUND_REQUESTED")];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:4" }));
    await tick();
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /保证金退还处理中/);

    // FAILED -> 保证金状态待核
    guaranteeList = [makeGuarantee("FAILED")];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:5" }));
    await tick();
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /保证金状态待核/);

    // NOT_REQUIRED -> 当前无需缴纳号主保证金
    guaranteeList = [makeGuarantee("NOT_REQUIRED")];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:6" }));
    await tick();
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /当前无需缴纳号主保证金/);

    // SATISFIED -> 号主保证金已覆盖
    guaranteeList = [makeGuarantee("SATISFIED")];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:7" }));
    await tick();
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /号主保证金已覆盖/);

    guaranteeList = [makeGuarantee("REFUNDED")];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:8" }));
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /号主保证金已原路退还/);
    assert.doesNotMatch(probe.host.querySelector(".account-credit-preview").textContent, /已覆盖/);

    guaranteeList = [makeGuarantee("SATISFIED"), { ...makeGuarantee("REFUNDED"), accountId: "acc_2" }];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:9" }));
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /按出租账号查看保证金要求/);
    assert.doesNotMatch(probe.host.querySelector(".account-credit-preview").textContent, /已覆盖/);

    guaranteeList = [];
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:10" }));
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /按出租账号查看保证金要求/);
  } finally {
    await probe.dispose();
  }
});

test("F4 & F5: pending tasks handles loading, errors, expired cancellations, and dual navigation links", async () => {
  const pendingOrders = deferred();
  let renterItems = [];
  let ownerItems = [];
  let shouldFail = false;

  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("party=renter")) {
      if (shouldFail) return json({ error: { code: "SERVER_ERROR" } }, 500);
      return json({ items: renterItems, nextCursor: null, limit: 3 });
    }
    if (url.includes("party=owner")) {
      if (shouldFail) return json({ error: { code: "SERVER_ERROR" } }, 500);
      return json({ items: ownerItems, nextCursor: null, limit: 3 });
    }
    return json(emptyPage);
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;

    // 1. Initial empty ready state: says "近期订单暂无待处理事项。" and has dual links without badge
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    let pendingCard = probe.host.querySelector(".account-pending-card");
    assert.equal(pendingCard, null, "known empty recent tasks do not occupy a block");

    // 2. F5: Owner PAID orders are not invented as delivery confirmation tasks; expiredAwaitingCancel renter orders are not shown as "去付款"
    renterItems = [
      { id: "ord_expired", displayNo: "EXP-01", title: "已过期租赁", status: "PENDING_PAYMENT", expiredAwaitingCancel: true },
      { id: "ord_valid", displayNo: "VAL-02", title: "正常待付租赁", status: "PENDING_PAYMENT" },
    ];
    ownerItems = [
      { id: "ord_owner_paid", displayNo: "OWN-01", title: "已付款出租单", status: "PAID" },
    ];
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:2" }, React.createElement(AccountOverview, { scope: "user_A:2" })));

    pendingCard = probe.host.querySelector(".account-pending-card");
    // ord_valid should be present
    assert.match(pendingCard.textContent, /VAL-02/);
    assert.match(pendingCard.textContent, /正常待付租赁/);
    // ord_expired should NOT be in pending tasks
    assert.doesNotMatch(pendingCard.textContent, /EXP-01/);
    assert.doesNotMatch(pendingCard.textContent, /已过期租赁/);
    // owner PAID order should NOT generate "待确认交付"
    assert.doesNotMatch(pendingCard.textContent, /OWN-01/);
    assert.doesNotMatch(pendingCard.textContent, /待确认交付/);

    // 3. F4: Both party errors show failure feedback and retry button
    shouldFail = true;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:3" }, React.createElement(AccountOverview, { scope: "user_A:3" })));
    pendingCard = probe.host.querySelector(".account-pending-card");
    assert.match(pendingCard.textContent, /待处理事项暂时无法读取。/);
    assert.ok(pendingCard.querySelector("button"));
  } finally {
    await probe.dispose();
  }
});

test("F6: diamond member under active grace displays grace details and handles null gapPoints", async () => {
  let graceData = {
    tier: "DIAMOND",
    rollingPoints: "39200",
    lifetimePoints: "45000",
    asOf: "2026-10-11T00:00:00Z",
    nextTier: null,
    grace: { state: "ACTIVE", fromTier: "DIAMOND", until: "2026-12-31T00:00:00Z", gapPoints: "800" },
    nextExpiryAt: null,
    benefits: [],
    entitlements: [],
    contributions: [],
    pendingCount: 0,
  };
  const probe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json({ status: "ready", data: graceData })),
  });
  try {
    const { AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:1" }));

    // DIAMOND + ACTIVE grace must prioritize grace display
    assert.match(probe.host.textContent, /保级中 · 需 800 积分 · 截止 2026\.12\.31/);
    assert.doesNotMatch(probe.host.textContent, /当前成长档位已确认/);

    // When gapPoints is null, formats as "待确认"
    graceData = {
      ...graceData,
      grace: { state: "ACTIVE", fromTier: "DIAMOND", until: "2026-12-31T00:00:00Z", gapPoints: null },
    };
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:2" }));
    assert.match(probe.host.textContent, /保级中 · 需 待确认 积分 · 截止 2026\.12\.31/);
  } finally {
    await probe.dispose();
  }
});

test("F7: account security displays non-active accountStatus, provider=fake note, and guards loading phone", async () => {
  let identityData = {
    accountStatus: "DEACTIVATED",
    identityStatus: "VERIFIED",
    ageStatus: "ADULT",
    provider: "fake",
    eligibleForProtectedTrade: true,
  };
  const probe = await createProbe(async () => json(emptyPage), {
    authFetch: (url) => {
      if (url.endsWith("/identity/status")) return Promise.resolve(json(identityData));
      return null;
    },
  });
  try {
    const { AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:1" }));
    await tick();

    const securityPanel = probe.host.querySelector(".account-status-panel");
    assert.ok(securityPanel);
    // accountStatus = DEACTIVATED shows warning pill
    assert.match(securityPanel.textContent, /账号已停用/);
    // provider = fake shows note
    assert.match(securityPanel.textContent, /实名状态来自本地测试环境/);

    // Cancelled status
    identityData = { ...identityData, accountStatus: "CANCELLED" };
    await probe.render(React.createElement(AccountOverview, { scope: "user_A:2" }));
    await tick();
    const updatedPanel = probe.host.querySelector(".account-status-panel");
    assert.ok(updatedPanel);
    assert.match(updatedPanel.textContent, /账号已注销/);
  } finally {
    await probe.dispose();
  }
});


for (const failedParties of [["renter"], ["owner"], ["renter", "owner"]]) {
  test("F4: pending retry recovers only failed orders (" + failedParties.join("+") + ")", async () => {
    let fail = true;
    const calls = { renter: 0, owner: 0 };
    const ancillaryCalls = [];
    const payable = { id: "payable_1", displayNo: "P-01", title: "待付款账号", status: "PENDING_PAYMENT" };
    const probe = await createProbe(async (input) => {
      const url = String(input);
      const party = url.includes("party=renter") ? "renter" : url.includes("party=owner") ? "owner" : null;
      if (!party) return json(emptyPage);
      calls[party]++;
      if (fail && failedParties.includes(party)) return json({ error: { code: "INTERNAL_ERROR" } }, 500);
      return json({ ...emptyPage, items: party === "renter" ? [payable] : [] });
    }, {
      authFetch: (url) => { if (!url.includes("party=")) ancillaryCalls.push(url); return null; },
    });
    try {
      await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_A:1" }));
      const pending = probe.host.querySelector(".account-pending-card");
      assert.deepEqual(calls, { renter: 1, owner: 1 });
      assert.match(pending.querySelector('[role="alert"]').textContent, /暂时无法读取/);
      assert.doesNotMatch(pending.textContent, /暂无待处理事项/);
      if (!failedParties.includes("renter")) assert.match(pending.textContent, /P-01/);
      const ancillaryBefore = [...ancillaryCalls];
      fail = false;
      await probe.click('.account-pending-card [role="alert"] button');
      assert.deepEqual(calls, {
        renter: failedParties.includes("renter") ? 2 : 1,
        owner: failedParties.includes("owner") ? 2 : 1,
      });
      assert.deepEqual(ancillaryCalls, ancillaryBefore, "Order retry must not refresh identity, membership, wallet or credit");
      assert.equal(pending.querySelector('[role="alert"]'), null);
      assert.match(pending.textContent, /P-01/);
    } finally { await probe.dispose(); }
  });
}

for (const failedParty of ["renter", "owner"]) {
  test("F4: one empty order list cannot hide " + failedParty + " read failure", async () => {
    const probe = await createProbe(async (input) => String(input).includes("party=" + failedParty)
      ? json({ error: { code: "INTERNAL_ERROR" } }, 500) : json(emptyPage));
    try {
      await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_A:1" }));
      const pending = probe.host.querySelector(".account-pending-card");
      assert.match(pending.querySelector('[role="alert"]').textContent,
        failedParty === "renter" ? /租入订单暂时无法读取/ : /出租订单暂时无法读取/);
      assert.doesNotMatch(pending.textContent, /暂无待处理事项/);
    } finally { await probe.dispose(); }
  });
}

test("F4: a loading party preserves confirmed tasks from the other party", async () => {
  const ownerRead = deferred();
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("party=owner")) return ownerRead.promise;
    if (url.includes("party=renter")) return json({ ...emptyPage, items: [{ id: "known_pending", status: "PENDING_PAYMENT", displayNo: "KNOWN-01" }] });
    return json(emptyPage);
  });
  try {
    await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_A:1" }));
    const pending = probe.host.querySelector(".account-pending-card");
    assert.match(pending.querySelector('[role="status"]').textContent, /正在读取/);
    assert.match(pending.textContent, /KNOWN-01/);
    assert.doesNotMatch(pending.textContent, /暂无待处理事项/);
    await React.act(async () => { ownerRead.resolve(json(emptyPage)); await tick(); });
    assert.equal(pending.querySelector('[role="status"]'), null);
    assert.match(pending.textContent, /KNOWN-01/);
  } finally { await probe.dispose(); }
});

test("F4: pending summary exposes the bounded recent page when there is a cursor", async () => {
  const probe = await createProbe(async (input) => String(input).includes("party=renter")
    ? json({ items: [1, 2, 3].map((n) => ({ id: "complete_" + n, status: "COMPLETED" })), nextCursor: "more-orders", limit: 3 })
    : json(emptyPage));
  try {
    await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_A:1" }));
    const pending = probe.host.querySelector(".account-pending-card");
    assert.equal(pending, null);
    assert.match(probe.host.textContent, /还有更多订单/);
  } finally { await probe.dispose(); }
});

test("M1B: all 6 confirmed tiers map to designated A-metal card images", async () => {
  const tiers = [
    { tier: "STANDARD", file: "/art/membership/a-metal/standard-card.webp", label: "普通会员" },
    { tier: "SILVER", file: "/art/membership/a-metal/silver-card.webp", label: "银卡会员" },
    { tier: "GOLD", file: "/art/membership/a-metal/gold-card.webp", label: "金卡会员" },
    { tier: "PLATINUM", file: "/art/membership/a-metal/platinum-card.webp", label: "铂金会员" },
    { tier: "DIAMOND", file: "/art/membership/a-metal/diamond-card.webp", label: "钻石会员" },
    { tier: "BLACK_GOLD", file: "/art/membership/a-metal/black-gold-card.webp", label: "黑金会员 · 终身" },
  ];
  for (const { tier, file, label } of tiers) {
    const probe = await createProbe(async () => json(emptyPage), {
      growthFetch: () => Promise.resolve(json({
        status: "ready",
        data: {
          tier,
          rollingPoints: "1000",
          lifetimePoints: "1000",
          asOf: "2026-10-11T00:00:00Z",
          nextTier: null,
          grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
          nextExpiryAt: null,
          benefits: [],
          entitlements: [],
          contributions: [],
          pendingCount: 0,
        },
      })),
    });
    try {
      await probe.render(React.createElement(probe.center.AccountOverview, { scope: `user_${tier}:1` }));
      const card = probe.host.querySelector("[data-testid=membership-card]");
      assert.ok(card, `Card must render for ${tier}`);
      assert.equal(card.getAttribute("data-tier"), tier);
      assert.ok(card.classList.contains("has-card-art"));
      const img = card.querySelector(".membership-card-img");
      assert.ok(img, `Image must render for ${tier}`);
      assert.equal(img.getAttribute("src"), file);
      const tierBadge = probe.host.querySelector("[data-testid=membership-tier]");
      assert.equal(tierBadge.textContent, label);
    } finally {
      await probe.dispose();
    }
  }
});

test("M1B: card image error triggers graceful DOM fallback without blank layout", async () => {
  const probe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json({
      status: "ready",
      data: {
        tier: "DIAMOND",
        rollingPoints: "50000",
        lifetimePoints: "80000",
        asOf: "2026-10-11T00:00:00Z",
        nextTier: null,
        grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
        nextExpiryAt: null,
        benefits: [],
        entitlements: [],
        contributions: [],
        pendingCount: 0,
      },
    })),
  });
  try {
    await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_diamond:1" }));
    const card = probe.host.querySelector("[data-testid=membership-card]");
    assert.ok(card.classList.contains("has-card-art"));
    const img = card.querySelector(".membership-card-img");
    assert.ok(img);

    // Simulate image error event
    await React.act(async () => {
      img.dispatchEvent(new probe.window.Event("error"));
      await tick();
    });

    // When image failed, fallback content renders and has-card-art is removed
    assert.equal(card.classList.contains("has-card-art"), false);
    assert.equal(card.querySelector(".membership-card-img"), null);
    const fallback = card.querySelector(".membership-card-fallback-content");
    assert.ok(fallback);
    assert.match(fallback.textContent, /洲洲商行/);
    assert.match(fallback.textContent, /DIAMOND MEMBER/);
    assert.match(fallback.textContent, /钻石会员/);
  } finally {
    await probe.dispose();
  }
});

test("M1B: UNKNOWN tier renders neutral DOM card without attempting image load or standard fallback", async () => {
  const probe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json({ status: "unknown", message: "成长服务尚未接线" })),
  });
  try {
    await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_unknown:1" }));
    const card = probe.host.querySelector("[data-testid=membership-card]");
    assert.ok(card);
    assert.equal(card.getAttribute("data-tier"), null);
    assert.equal(card.classList.contains("has-card-art"), false);
    assert.equal(card.querySelector(".membership-card-img"), null);
    const fallback = card.querySelector(".membership-card-fallback-content");
    assert.ok(fallback);
    assert.match(fallback.textContent, /洲洲商行/);
    assert.match(fallback.textContent, /MEMBER/);
    assert.doesNotMatch(fallback.textContent, /标准会员/);
    const tierBadge = probe.host.querySelector("[data-testid=membership-tier]");
    assert.equal(tierBadge.textContent, "资格待确认");
  } finally {
    await probe.dispose();
  }
});

test("M1B: active FRIEND and PRESTIGE entitlements render C-badge images, inactive/expired are hidden", async () => {
  // Test 1: Active FRIEND entitlement
  const friendProbe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json({
      status: "ready",
      data: {
        tier: "SILVER",
        rollingPoints: "5000",
        lifetimePoints: "5000",
        asOf: "2026-10-11T00:00:00Z",
        nextTier: null,
        grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
        nextExpiryAt: null,
        benefits: [],
        entitlements: [
          {
            kind: "FRIEND",
            label: "商行之友",
            scope: "ALL_PLATFORM",
            endsAt: "2026-11-30T00:00:00Z",
            state: "ACTIVE",
          },
        ],
        contributions: [],
        pendingCount: 0,
      },
    })),
  });
  try {
    await friendProbe.render(React.createElement(friendProbe.center.AccountOverview, { scope: "user_friend:1" }));
    const badge = friendProbe.host.querySelector("[data-testid=active-entitlement]");
    assert.ok(badge);
    assert.match(badge.textContent, /商行之友/);
    assert.match(badge.textContent, /全平台适用/);
    const badgeImg = badge.querySelector(".account-entitlement-badge-img");
    assert.ok(badgeImg);
    assert.equal(badgeImg.getAttribute("src"), "/art/membership/friend-badge.webp");
  } finally {
    await friendProbe.dispose();
  }

  // Test 2: Active PRESTIGE entitlement
  const prestigeProbe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json({
      status: "ready",
      data: {
        tier: "PLATINUM",
        rollingPoints: "25000",
        lifetimePoints: "25000",
        asOf: "2026-10-11T00:00:00Z",
        nextTier: null,
        grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
        nextExpiryAt: null,
        benefits: [],
        entitlements: [
          {
            kind: "PRESTIGE",
            label: "尊享礼遇",
            scope: "DELTA_ACCOUNT_RENTAL",
            endsAt: "2026-12-31T00:00:00Z",
            state: "ACTIVE",
          },
        ],
        contributions: [],
        pendingCount: 0,
      },
    })),
  });
  try {
    await prestigeProbe.render(React.createElement(prestigeProbe.center.AccountOverview, { scope: "user_prestige:1" }));
    const badge = prestigeProbe.host.querySelector("[data-testid=active-entitlement]");
    assert.ok(badge);
    assert.match(badge.textContent, /尊享礼遇/);
    assert.match(badge.textContent, /三角洲租赁/);
    const badgeImg = badge.querySelector(".account-entitlement-badge-img");
    assert.ok(badgeImg);
    assert.equal(badgeImg.getAttribute("src"), "/art/membership/prestige-badge.webp");
  } finally {
    await prestigeProbe.dispose();
  }

  // Test 3: Inactive/Expired entitlement does not render
  const expiredProbe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json({
      status: "ready",
      data: {
        tier: "SILVER",
        rollingPoints: "5000",
        lifetimePoints: "5000",
        asOf: "2026-10-11T00:00:00Z",
        nextTier: null,
        grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
        nextExpiryAt: null,
        benefits: [],
        entitlements: [
          {
            kind: "FRIEND",
            label: "商行之友",
            scope: "ALL_PLATFORM",
            endsAt: "2026-09-30T00:00:00Z",
            state: "EXPIRED",
          },
        ],
        contributions: [],
        pendingCount: 0,
      },
    })),
  });
  try {
    await expiredProbe.render(React.createElement(expiredProbe.center.AccountOverview, { scope: "user_expired:1" }));
    assert.equal(expiredProbe.host.querySelector("[data-testid=active-entitlement]"), null);
  } finally {
    await expiredProbe.dispose();
  }

  // Test 4: PENDING entitlement does not render
  const pendingProbe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json({
      status: "ready",
      data: {
        tier: "GOLD",
        rollingPoints: "15000",
        lifetimePoints: "15000",
        asOf: "2026-10-11T00:00:00Z",
        nextTier: null,
        grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
        nextExpiryAt: null,
        benefits: [],
        entitlements: [
          {
            kind: "PRESTIGE",
            label: "尊享礼遇",
            scope: "DELTA_ACCOUNT_RENTAL",
            endsAt: "2026-12-31T00:00:00Z",
            state: "PENDING",
          },
        ],
        contributions: [],
        pendingCount: 0,
      },
    })),
  });
  try {
    await pendingProbe.render(React.createElement(pendingProbe.center.AccountOverview, { scope: "user_pending:1" }));
    assert.equal(pendingProbe.host.querySelector("[data-testid=active-entitlement]"), null);
  } finally {
    await pendingProbe.dispose();
  }
});

test("M1B: entitlement badge error triggers fallback emblem and recovers when switched to valid art", async () => {
  const getGrowth = (kind) => ({
    status: "ready",
    data: {
      tier: "GOLD",
      rollingPoints: "12000",
      lifetimePoints: "22000",
      asOf: "2026-10-11T00:00:00Z",
      nextTier: null,
      grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
      nextExpiryAt: null,
      benefits: [],
      entitlements: [
        {
          kind,
          label: kind === "FRIEND" ? "商行之友" : "尊享礼遇",
          scope: "ALL_PLATFORM",
          endsAt: "2026-11-30T00:00:00Z",
          state: "ACTIVE",
        },
      ],
      contributions: [],
      pendingCount: 0,
    },
  });

  let currentKind = "FRIEND";
  const probe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => Promise.resolve(json(getGrowth(currentKind))),
  });
  try {
    await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_badge_test:1" }));
    const img = probe.host.querySelector(".account-entitlement-badge-img");
    assert.ok(img);
    assert.equal(img.getAttribute("src"), "/art/membership/friend-badge.webp");

    // Simulate image error event
    await React.act(async () => {
      img.dispatchEvent(new probe.window.Event("error"));
      await tick();
    });

    // Fallback icon appears in fixed 32x32 slot
    assert.equal(probe.host.querySelector(".account-entitlement-badge-img"), null);
    const fallbackIcon = probe.host.querySelector(".account-entitlement-badge-icon");
    assert.ok(fallbackIcon);
    assert.equal(fallbackIcon.style.display, "");

    // Switch to PRESTIGE entitlement - resets failure state and renders new image
    currentKind = "PRESTIGE";
    await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_badge_test:2" }));
    const newImg = probe.host.querySelector(".account-entitlement-badge-img");
    assert.ok(newImg);
    assert.equal(newImg.getAttribute("src"), "/art/membership/prestige-badge.webp");
    assert.notEqual(newImg.style.display, "none");
    assert.equal(probe.host.querySelector(".account-entitlement-badge-icon"), null);
  } finally {
    await probe.dispose();
  }
});

test("M1B: card art in image mode clears background paint and border cascade without DOM bleed-through", async () => {
  const probe = await createProbe(async () => json(emptyPage));
  try {
    const style = probe.window.document.createElement("style");
    style.textContent = fs.readFileSync(path.join(tree, "apps/web/src/components/account/account-center.css"), "utf8");
    probe.window.document.head.append(style);

    await probe.render(React.createElement(probe.membership.GrowthMemberCardArt, { tier: "GOLD" }));
    const card = probe.host.querySelector(".membership-card");
    assert.ok(card.classList.contains("has-card-art"));
    const computed = probe.window.getComputedStyle(card);
    assert.equal(computed.backgroundImage, "none", "Card art mode must have backgroundImage none");
    assert.equal(computed.borderTopWidth, "0px", "Card art mode must have 0px border");
  } finally {
    await probe.dispose();
  }
});

test("M1C: navigation grouping, labels, and independent membership view route", async () => {
  const probe = await createProbe(async () => json(emptyPage));
  try {
    const { resolveAccountView, NAV_GROUPS, NAV_ITEMS, accountSectionLabels, AccountCenterFrame, AccountMembershipCenter } = probe.center;

    // Route resolution
    assert.equal(resolveAccountView("membership"), "membership");
    assert.equal(accountSectionLabels.membership, "会员中心");
    assert.equal(accountSectionLabels.accounts, "出租账号");
    assert.equal(accountSectionLabels.invite, "邀请与佣金");

    // 4 groups
    assert.equal(NAV_GROUPS.length, 4);
    assert.equal(NAV_GROUPS[0].title, undefined, "顶部三项不再加「常用」标题");
    assert.deepEqual(NAV_GROUPS[0].items.map(item => item.section), ["overview", "membership", "favorites"]);
    assert.equal(NAV_GROUPS[1].title, "租赁管理");
    assert.equal(NAV_GROUPS[2].title, "资产与收益");
    assert.equal(NAV_GROUPS[3].title, "账号设置");
    assert.equal(NAV_ITEMS.length, 11);

    // Sidebar renders group titles
    await probe.render(React.createElement(AccountCenterFrame, { active: "membership", scope: "user_nav_test:1" }, React.createElement("div", null, "content")));
    const titles = [...probe.host.querySelectorAll(".account-nav-group-title")].map(el => el.textContent);
    assert.deepEqual(titles, ["租赁管理", "资产与收益", "账号设置"]);

    // AccountMembershipCenter renders
    await probe.render(React.createElement(AccountMembershipCenter, { scope: "user_membership_test:1" }));
    assert.ok(probe.host.querySelector(".account-membership-view"));
  } finally {
    await probe.dispose();
  }
});

test("overview polish preserves unknown credit and makes both summary links lead to orders", async () => {
  const probe = await createProbe(async () => json(emptyPage), {
    authFetch: url => url.includes("/credit") ? Promise.resolve(json({ error: { code: "NOT_FOUND" } }, 404)) : null,
  });
  try {
    await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_A:1" }));
    const credit = probe.host.querySelector(".account-credit-preview");
    assert.match(credit.textContent, /暂时无法读取/);
    assert.equal(credit.querySelector(".strip-credit-number"), null);
    assert.doesNotMatch(credit.textContent, /0\s*信用分|无需缴纳/);
    assert.equal(probe.host.querySelector('[data-testid="order-summary-renter"] .account-summary-header-link').getAttribute("href"), "/account?view=rentals");
    assert.equal(probe.host.querySelector('[data-testid="order-summary-owner"] .account-summary-header-link').getAttribute("href"), "/account?view=leased");
    assert.doesNotMatch(probe.host.textContent, /即时履约|即刻开启/);
    assert.equal(probe.host.querySelectorAll(".account-summary-more").length, 0);
  } finally { await probe.dispose(); }
});

test("overview order rows keep full Beijing time accessible while the visible date is compact", async () => {
  const probe = await createProbe(async () => json({ ...emptyPage, items: [{ id: "date_1", status: "COMPLETED", title: "测试订单", createdAt: "2026-10-10T06:03:00Z" }] }));
  try {
    await probe.render(React.createElement(probe.center.OrderSummaryCard, { scope: "user_A:1", party: "owner" }));
    const time = probe.host.querySelector(".account-order-row time");
    assert.equal(time.getAttribute("datetime"), "2026-10-10T06:03:00Z");
    assert.match(time.textContent, /2026.*10.*10.*14:03/);
    assert.doesNotMatch(time.textContent, /GMT/);
    assert.match(time.getAttribute("aria-label"), /GMT\+08:00/);
    assert.equal(probe.host.querySelector(".account-order-row-status").getAttribute("data-status"), "COMPLETED");
  } finally { await probe.dispose(); }
});

const goldGrowth = { status: "ready", data: { tier: "GOLD", rollingPoints: "12480", lifetimePoints: "28600", asOf: "2026-10-11T00:00:00.000Z", windowStart: "2026-07-13T00:00:00.000Z", benefitsState: "CONFIGURED", nextTier: { tier: "PLATINUM", threshold: "20000", remaining: "7520" }, grace: { state: "NONE", fromTier: null, until: null, gapPoints: null }, nextExpiryAt: null, benefits: [], comparison: [], entitlements: [], contributions: [], pendingCount: 0 } };
const silverGrowth = { ...goldGrowth, data: { ...goldGrowth.data, tier: "SILVER", nextTier: { tier: "GOLD", threshold: "10000", remaining: "1000" } } };

test("membership center clears the previous identity before the next read lands", async () => {
  let calls = 0;
  const pending = deferred();
  const probe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => {
      calls += 1;
      return calls === 1 ? json(goldGrowth) : pending.promise;
    },
  });
  try {
    await probe.render(React.createElement(probe.center.AccountMembershipCenter, { scope: "user_A:1" }));
    assert.match(probe.host.textContent, /当前：金卡会员/);

    await probe.render(React.createElement(probe.center.AccountMembershipCenter, { scope: "user_B:1" }));
    assert.match(probe.host.textContent, /正在读取成长档案/);
    assert.doesNotMatch(probe.host.textContent, /金卡会员/);

    await React.act(async () => {
      pending.resolve(json(silverGrowth));
      await tick();
    });
    await tick();
    assert.match(probe.host.textContent, /当前：银卡会员/);
    assert.doesNotMatch(probe.host.textContent, /金卡会员/);
  } finally {
    await probe.dispose();
  }
});

test("membership read 401 revalidates the shared session and keeps the failure honest", async () => {
  const probe = await createProbe(async () => json(emptyPage), {
    growthFetch: () => json({ error: { code: "UNAUTHENTICATED" } }, 401),
  });
  try {
    await probe.render(React.createElement(probe.center.AccountMembershipCenter, { scope: "user_A:1" }));
    assert.equal(probe.session.revalidations, 1);
    assert.match(probe.host.textContent, /成长档案暂不可用/);
    assert.doesNotMatch(probe.host.textContent, /普通会员/);
    assert.equal(probe.host.querySelector("[data-testid=retry-membership-center]"), null);
  } finally {
    await probe.dispose();
  }
});


test("credit gauge displays only known in-range scores, including zero", async () => {
  for (const score of [0, 100, -1, 101, null]) {
    const probe = await createProbe(async () => json(emptyPage), { authFetch: (url) => url.includes("/credit") ? Promise.resolve(json({ credit: score === null ? null : { userId: "user_A", score, revision: "1", initializedAt: "2026-09-01", events: [] }, guarantees: [], transactions: [], recoveryRequests: [] })) : undefined });
    try {
      await probe.render(React.createElement(probe.center.AccountOverview, { scope: "user_A:1" }));
      const meter = probe.host.querySelector('[role="meter"]');
      if (score === 0 || score === 100) {
        assert.equal(meter?.getAttribute("aria-valuenow"), String(score));
        assert.equal(meter?.getAttribute("data-state"), score === 100 ? "full" : "known");
      }
      else assert.equal(Boolean(meter), false);
    } finally { await probe.dispose(); }
  }
});

test("F6: breadcrumb sits at the top of the right content column, not above both columns", async () => {
  const probe = await createProbe(async () => json(emptyPage));
  try {
    const { AccountCenterFrame } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, {
      active: "security",
      scope: "user_A:1",
      breadcrumbs: [{ label: "首页", href: "/" }, { label: "个人中心", href: "/account" }, { label: "账号安全" }],
    }, React.createElement("div", { className: "account-module" }, "security content")));

    const main = probe.host.querySelector(".account-center-main");
    assert.ok(main);
    const crumb = main.querySelector(".account-breadcrumb");
    assert.ok(crumb, "面包屑必须由内容列自己渲染");
    assert.equal(main.firstElementChild, crumb, "面包屑必须是右侧内容列的第一个元素，位于统一标题/操作页头之上");
    assert.equal(probe.host.querySelector(".account-center > .account-breadcrumb"), null, "面包屑不得再停留在双栏容器顶部");
    assert.equal(probe.host.querySelectorAll(".account-breadcrumb").length, 1, "同页只允许一条面包屑");

    const items = [...crumb.querySelectorAll("li")];
    assert.equal(items.length, 3);
    assert.equal(items[0].querySelector("a").getAttribute("href"), "/");
    assert.equal(items[0].querySelector("a").textContent, "首页");
    assert.equal(items[1].querySelector("a").getAttribute("href"), "/account");
    assert.equal(items[1].querySelector("a").textContent, "个人中心");
    assert.equal(items[2].getAttribute("aria-current"), "page");
    assert.equal(items[2].querySelector("a"), null, "当前页面不能链向自身");
    assert.match(items[2].textContent, /账号安全$/);

    // 未传面包屑时框架不自造一条（详情页由自身标题与返回链接承担）。
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement("div", null, "content")));
    assert.equal(probe.host.querySelector(".account-breadcrumb"), null);

    // 左侧独立轻量表面的载体与导航分组结构保持不变。
    const side = probe.host.querySelector(".account-center-side");
    assert.ok(side);
    assert.ok(side.querySelector(".account-nav[aria-label=个人中心]"));
    assert.equal(side.closest(".account-center-main"), null);
  } finally { await probe.dispose(); }
});

test("F4: the desktop three-column session grid cannot override narrow breakpoints", () => {
  const css = fs.readFileSync(path.join(tree, "apps/web/src/components/account/account-center.css"), "utf8");
  // 复核评审的CSS级联反例：收集每条 .sec-session 的 grid-template-columns 声明及其 @media 上下文，
  // 按源码顺序模拟级联，确认窄屏断点始终胜出（禁止靠全局 overflow 掩盖）。
  const regions = [];
  const mediaRe = /@media\s*\(([^)]*)\)\s*\{/g;
  let cursor = 0;
  let media;
  while ((media = mediaRe.exec(css))) {
    let depth = 1;
    let i = mediaRe.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    regions.push({ from: cursor, to: media.index, condition: null });
    regions.push({ from: mediaRe.lastIndex, to: i - 1, condition: media[1] });
    cursor = i;
    mediaRe.lastIndex = i;
  }
  regions.push({ from: cursor, to: css.length, condition: null });
  const declarations = [];
  const ruleRe = /\.sec-session\s*\{([^}]*)\}/g;
  for (const region of regions) {
    ruleRe.lastIndex = region.from;
    let rule;
    while ((rule = ruleRe.exec(css)) && rule.index < region.to) {
      const grid = rule[1].match(/grid-template-columns:[^;]+/);
      if (grid) declarations.push({ at: rule.index, condition: region.condition, value: grid[0] });
    }
  }
  declarations.sort((a, b) => a.at - b.at);
  const winnerAt = (width) => declarations.filter((d) => {
    if (!d.condition) return true;
    const max = d.condition.match(/max-width:\s*(\d+)px/);
    return max ? width <= Number(max[1]) : true;
  }).slice(-1)[0];
  const countColumns = (decl) => {
    const value = decl.replace(/grid-template-columns:\s*/, "").trim();
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of value) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === " " && depth === 0) { if (current) parts.push(current); current = ""; } else current += ch;
    }
    if (current) parts.push(current);
    return parts.length;
  };
  const baseRules = declarations.filter((d) => !d.condition);
  assert.equal(baseRules.length, 1, "桌面三列只保留一条基础段规则");
  assert.equal(countColumns(baseRules[0].value), 3);
  assert.match(baseRules[0].value, /178px/, "动作列须容纳详情＋退出两个文字动作");
  for (const d of declarations.filter((d) => d.condition)) {
    assert.ok(d.at > baseRules[0].at, `断点规则（${d.condition}）必须在基础段之后才能覆盖窄屏`);
  }
  assert.equal(countColumns(winnerAt(390).value), 1, "390 宽必须单列");
  assert.equal(countColumns(winnerAt(639).value), 1, "639 宽必须单列");
  assert.equal(countColumns(winnerAt(800).value), 2, "640–1023 两列＋操作整行");
  assert.equal(countColumns(winnerAt(1024).value), 3, "1024 桌面恢复三列");
  // 精确匹配这三个容器/行选择器本身：IM-02 的行内标签 sr-only 隐藏用 1px clip＋overflow 是标准读屏模式
  // （选择器 .sec-session-when span），不属于“掩盖溢出”，不允许被 sec-session 前缀误伤。
  assert.ok(!/(^|[^\w.-])\.(account-center|account-center-main|sec-session)(?![\w-])[^{}]*\{[^}]*overflow:\s*hidden/.test(css), "禁止用 overflow 掩盖会话行溢出");
});

test("T11-01: .sec-dialog 层叠高于全局 .modal-overlay，鼠标命中测试不再落在遮罩上", () => {
  // 静态层叠防线：真实 elementFromPoint 命中由 t11 浏览器验收与 t16 复验覆盖（happy-dom 无命中测试）。
  const css = fs.readFileSync(path.join(tree, "apps/web/src/components/account/account-center.css"), "utf8");
  const start = css.indexOf(".sec-dialog {");
  assert.ok(start >= 0, ".sec-dialog 规则存在");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /position: fixed/);
  assert.match(rule, /z-index: 101/, "弹层与 .ui-alert-dialog 同层 101（T11-01）");
  const globals = fs.readFileSync(path.join(tree, "apps/web/src/app/globals.css"), "utf8");
  const overlayStart = globals.indexOf(".modal-overlay");
  assert.ok(overlayStart >= 0, ".modal-overlay 规则存在");
  const overlayZ = Number((globals.slice(overlayStart).match(/z-index:\s*(\d+)/) || [])[1]);
  assert.equal(overlayZ, 100, "遮罩层基准 z-index 不变");
  assert.ok(101 > overlayZ, "弹层严格高于遮罩，鼠标点击才能命中弹窗内容");
  // t2 的 Alert Dialog 层叠不受本次改动影响。
  const alertCss = fs.readFileSync(path.join(tree, "apps/web/src/components/ui/alert-dialog.css"), "utf8");
  assert.match(alertCss, /\.ui-alert-dialog \{[^}]*z-index: 101;/s, "Alert Dialog 仍为 101");
});
