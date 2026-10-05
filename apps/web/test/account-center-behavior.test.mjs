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
    if (name === "@/lib/personal-wallet-client") return requireFromTree(path.join(tree, "apps/web/src/lib/personal-wallet-client.ts"));
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
    revalidate() { this.revalidations += 1; },
    ...options.session,
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (input, requestOptions) => {
    const url = String(input);
    const authReply = options.authFetch?.(url);
    if (authReply) return authReply;
    if (url.endsWith("/get-session")) return Promise.resolve(json({ user: { id: session.userId, phoneNumber: "13800138000" } }));
    if (url.endsWith("/identity/status")) return Promise.resolve(json({ accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", provider: "fake", eligibleForProtectedTrade: true }));
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

  return { window, host, session, center, render, click, dispose };
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
    if (url.includes("rental-membership")) return json({ membership: { tier: "UNKNOWN", version: "0" } });
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
    assert.match(probe.host.querySelector(".account-credit-preview").textContent, /信用分规则待公布即将上线/);
    assert.doesNotMatch(probe.host.querySelector(".account-credit-preview").textContent, /\b98\b/);
    assert.match(probe.host.querySelector(".account-status-panel").textContent, /138\*\*\*\*8000/);
    assert.match(probe.host.querySelector(".account-status-panel").textContent, /实名已验证/);
    assert.match(probe.host.querySelector(".account-wallet-preview").textContent, /钱包暂时无法读取/);
    assert.equal(probe.host.querySelector(".account-overview-aside").firstElementChild.className, "account-wallet-preview");
    assert.doesNotMatch(probe.host.querySelector(".account-wallet-preview").textContent, /\d+\.\d{2}/);
    assert.equal(probe.host.querySelector("[data-testid=order-summary-renter] a[href='/accounts']").textContent, "浏览账号");
    assert.equal(probe.host.querySelector("[data-testid=order-summary-owner] a[href='/publish']").textContent, "发布账号");
    assert.equal(probe.host.querySelectorAll(".account-summary-more").length, 0);
    assert.ok(calls.some((url) => url.includes("party=renter") && url.includes("limit=3")));
    assert.ok(calls.some((url) => url.includes("party=owner") && url.includes("limit=3")));
    assert.equal(probe.host.querySelector("[data-testid=membership-tier]").textContent, "资格未知");
  } finally {
    await probe.dispose();
  }
});

test("overview account status fails closed and can be retried", async () => {
  let statusFails = true;
  const probe = await createProbe(async (input) => {
    if (String(input).includes("rental-membership")) return json({ membership: { tier: "STANDARD", version: "1" } });
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
    if (url.includes("rental-membership")) return json({ membership: { tier: "STANDARD", version: "1" } });
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
    if (url.includes("rental-membership")) return json({ membership: { tier: "VIP", version: "2" } });
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
    if (url.includes("rental-membership")) return json({ membership: { tier: "VIP", version: "2" } });
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
  let membershipBody = { membership: { tier: "SVIP", version: "8" } };
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("rental-membership")) return json(membershipBody);
    return json(emptyPage);
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    const card = probe.host.querySelector("[data-testid=membership-card]");
    assert.equal(card.getAttribute("aria-hidden"), "true");
    assert.equal(card.getAttribute("data-tier"), "SVIP");
    assert.equal(card.querySelector("svg, img"), null);
    assert.match(card.textContent, /洲洲商行/);
    assert.match(card.textContent, /SVIP/);
    const tier = probe.host.querySelector("[data-testid=membership-tier]");
    assert.equal(tier.textContent, "SVIP");
    assert.equal(card.contains(tier), false);
    assert.match(probe.host.textContent, /用户甲/);
    const note = probe.host.querySelector("#membership-benefits");
    assert.equal(note.getAttribute("data-gap"), "MEMBERSHIP_CONTRACT_REQUIRED");
    assert.match(note.textContent, /会员权益说明暂未提供/);
    assert.doesNotMatch(note.textContent, /免押|黑金|升级|购买/);
    assert.equal(probe.host.querySelector(".membership-benefits"), null);

    membershipBody = { profile: { tier: "VIP" } };
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:2" }, React.createElement(AccountOverview, { scope: "user_A:2" })));
    assert.equal(probe.host.querySelector("[data-testid=membership-tier]"), null);
    assert.doesNotMatch(probe.host.querySelector("[data-testid=membership-card]").textContent, /SVIP|VIP/);
    assert.equal(probe.host.querySelector("[data-gap=MEMBERSHIP_CONTRACT_REQUIRED]").textContent.includes("会员等级暂未由服务端提供"), true);
    assert.doesNotMatch(probe.host.textContent, /SVIP|VIP|R1/);
    const nav = [...probe.host.querySelectorAll(".account-nav a")];
    assert.equal(nav.length, 9);
    assert.ok(nav.every((link) => link.tagName === "A" && link.getAttribute("href")?.startsWith("/account?view=")));
    assert.equal(probe.host.querySelector(".account-nav a[aria-current=page]").textContent.includes("总览"), true);
    const wallet = nav.find((link) => link.getAttribute("href") === "/account?view=wallet");
    assert.doesNotMatch(wallet.textContent, /待接入/);
    assert.ok(wallet.querySelector(".account-nav-chevron"));
  } finally {
    await probe.dispose();
  }
});

test("membership benefits use the public policy without inventing validity or treating UNKNOWN as STANDARD", async () => {
  const policy = { version: "rental-benefits-20261003.v1", scope: "DELTA_ACCOUNT_RENTAL", scopeLabel: "三角洲行动账号租赁",
    tenantDeposit: { STANDARD: "ACCOUNT_BASE", VIP: "WAIVED", SVIP: "WAIVED", DISCOUNT_USER: "ACCOUNT_BASE" },
    resourcePrice: "PERSONAL_QUOTE", validity: "UNKNOWN", acquisition: "UNKNOWN", notice: "以个人确认结果为准。" };
  let body = { membership: { tier: "VIP", version: "12" }, benefitPolicy: policy };
  const probe = await createProbe(async input => String(input).includes("rental-membership") ? json(body) : json(emptyPage));
  try {
    const render = scope => probe.render(React.createElement(probe.center.AccountOverview, { scope }));
    await render("user_A:1");
    assert.match(probe.host.querySelector("#membership-benefits").textContent, /免租客押金/);
    const details = probe.host.querySelector(".membership-benefits-details");
    assert.match(details.textContent, /本人资格版本 12.*权益说明版本 rental-benefits-20261003.v1/);
    assert.match(details.textContent, /有效期、购买与授予方式暂未提供/);
    assert.doesNotMatch(details.textContent, /终身|打折|升级会员/);
    body = { ...body, membership: { tier: "DISCOUNT_USER", version: "13" } };
    await render("user_A:2");
    assert.match(probe.host.querySelector("#membership-benefits").textContent, /按账号条件缴纳/);
    body = { ...body, membership: { tier: "UNKNOWN", version: "0" } };
    await render("user_A:3");
    assert.match(probe.host.querySelector("#membership-benefits").textContent, /资格尚未确认/);
    assert.doesNotMatch(probe.host.querySelector("#membership-benefits").textContent, /免租客押金|按账号条件缴纳/);
    body = { membership: { tier: "VIP", version: "14" }, benefitPolicy: { ...policy, validity: "FOREVER" } };
    await render("user_A:4");
    assert.equal(probe.host.querySelector("[data-testid=membership-tier]").textContent, "VIP");
    assert.equal(probe.host.querySelector(".membership-benefits-details"), null);
    assert.match(probe.host.querySelector("#membership-benefits").textContent, /暂未提供/);
  } finally { await probe.dispose(); }
});

test("a membership read failure can retry and does not remove the order summaries", async () => {
  let fail = true;
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("rental-membership")) return fail ? json({ error: { code: "INTERNAL_ERROR" } }, 503) : json({ membership: { tier: "DISCOUNT_USER", version: "1" } });
    if (url.includes("party=owner")) return json({ items: [orderB], nextCursor: null, limit: 100 });
    return json(emptyPage);
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "rentals", scope: "user_A:1", orderId: "order_A", status: "PAID", accountId: "acc_1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    assert.match(probe.host.textContent, /会员等级暂时无法读取/);
    assert.match(probe.host.textContent, /PRIVATE_ORDER_B/);
    assert.equal(probe.host.querySelector(".account-nav a[aria-current=page]").getAttribute("href"), "/account?view=rentals&accountId=acc_1&status=PAID&orderId=order_A");
    fail = false;
    await probe.click("[data-testid=retry-membership]");
    assert.equal(probe.host.querySelector("[data-testid=membership-tier]").textContent, "优惠用户");
    assert.equal(probe.host.querySelector("[data-testid=membership-card]").getAttribute("data-tier"), "DISCOUNT_USER");
    assert.match(probe.host.textContent, /PRIVATE_ORDER_B/);
  } finally {
    await probe.dispose();
  }
});

test("a late response from the previous identity cannot replace the current one", async () => {
  const pendingOrders = deferred();
  const pendingMembership = deferred();
  let phase = "A";
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("rental-membership")) return phase === "A" ? pendingMembership.promise : json({ membership: { tier: "STANDARD", version: "3" } });
    if (url.includes("party=renter")) return phase === "A" ? pendingOrders.promise : json({ items: [orderB], nextCursor: null, limit: 100 });
    return json(emptyPage);
  });
  try {
    const { AccountCenterFrame, AccountOverview } = probe.center;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_A:1" }, React.createElement(AccountOverview, { scope: "user_A:1" })));
    phase = "B";
    probe.session.userId = "user_B";
    probe.session.displayName = "用户乙";
    probe.session.identityVersion = 2;
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_B:2" }, React.createElement(AccountOverview, { scope: "user_B:2" })));
    pendingMembership.resolve(json({ membership: { tier: "SVIP", version: "9" } }));
    pendingOrders.resolve(json({ items: [orderA], nextCursor: null, limit: 100 }));
    await probe.render(React.createElement(AccountCenterFrame, { active: "overview", scope: "user_B:2" }, React.createElement(AccountOverview, { scope: "user_B:2" })));
    assert.match(probe.host.textContent, /用户乙/);
    assert.doesNotMatch(probe.host.textContent, /用户甲|PRIVATE_ORDER_A|SVIP/);
    assert.equal(probe.host.querySelector("[data-testid=membership-tier]").textContent, "标准");
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
    if (url.includes("rental-membership")) return json({ membership: { tier: "VIP", version: "1" } });
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

    // Mobile tabs
    const mobileTabs = probe.host.querySelectorAll(".account-mobile-tab-btn");
    assert.equal(mobileTabs.length, 4);
    assert.equal(mobileTabs[0].getAttribute("aria-current"), "page");

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
    assert.match(moreMenu.textContent, /分销中心/);
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
