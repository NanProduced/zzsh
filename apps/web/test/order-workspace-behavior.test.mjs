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
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

const ORDER_COMPONENTS = new Set(["order-detail", "order-list", "order-presentation", "order-trade-actions"]);

/** Resolve the internal order view modules from source, with the trade panel stubbed to a no-op. */
function loadWorkspace(session, router) {
  const cache = new Map();
  const loadOrderComponent = (file) => {
    if (cache.has(file)) return cache.get(file);
    const module = new Module(path.join(tree, "order-component-probe.cjs"));
    module.filename = path.join(tree, "order-component-probe.cjs");
    module.paths = Module._nodeModulePaths(tree);
    module.require = (name) => {
      if (name === "next/link") return function Link({ scroll: _scroll, ...props }) { return React.createElement("a", props); };
      if (name === "next/navigation") return { useRouter: () => router };
      if (name === "@/components/auth/auth-overlay-provider") return { useAuthOverlay: () => ({ open() {} }) };
      if (name === "@/components/session/user-session-provider") return { useUserSession: () => session };
      if (name === "@/components/session/identity-reset") return requireFromTree(path.join(tree, "apps/web/src/components/session/identity-reset.ts"));
      if (name === "@/lib/order-client") return requireFromTree(path.join(tree, "apps/web/src/lib/order-client.ts"));
      if (name === "@/lib/order-display") return requireFromTree(path.join(tree, "apps/web/src/lib/order-display.ts"));
      const local = name.match(/(?:^\.\/|@\/components\/order\/)([a-z-]+)$/)?.[1];
      if (local === "legacy-continuation-panel") return { LegacyContinuationPanel: () => null };
      if (local === "prestart-termination-panel") return { PrestartTerminationPanel: () => null };
      if (local && (ORDER_COMPONENTS.has(local) || local === "legacy-order-workspace")) {
        if (local === "order-trade-actions") return { OrderTradeActions: () => null };
        return loadOrderComponent(`${local}.tsx`);
      }
      if (name.endsWith(".css")) return {};
      return requireFromTree(name);
    };
    const source = fs.readFileSync(path.join(tree, "apps/web/src/components/order", file), "utf8");
    module._compile(typescript.transpileModule(source, {
      compilerOptions: {
        module: typescript.ModuleKind.CommonJS,
        jsx: typescript.JsxEmit.ReactJSX,
        target: typescript.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText, module.filename);
    cache.set(file, module.exports);
    return module.exports;
  };
  return {
    OrderWorkspace: loadOrderComponent("order-workspace.tsx").OrderWorkspace,
    LegacyOrderWorkspace: loadOrderComponent("legacy-order-workspace.tsx").LegacyOrderWorkspace,
  };
}

async function createProbe(fetchImpl, options = {}) {
  const window = new Window({ url: "http://127.0.0.1/account?view=rentals" });
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    CustomEvent: window.CustomEvent,
    DOMException: window.DOMException,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const session = {
    status: "authenticated",
    userId: "user_A",
    identityVersion: 1,
    revalidations: 0,
    revalidate() { this.revalidations += 1; },
    ...options.session,
  };
  const router = { push() {}, replace() {} };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const components = loadWorkspace(session, router);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = requireFromTree("react-dom/client").createRoot(host);
  const commits = [];
  let phase = "";

  async function render(props, nextPhase = "", Workspace = components.OrderWorkspace) {
    phase = nextPhase;
    await React.act(async () => {
      root.render(React.createElement(
        React.Profiler,
        { id: "order", onRender: () => commits.push({ phase, text: host.textContent ?? "", detail: host.querySelector("[data-testid=order-detail]")?.textContent ?? null }) },
        React.createElement(Workspace, { party: "renter", ...props }),
      ));
    });
    await tick();
  }

  async function clickButton(text) {
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
    assert.ok(button, `button not found: ${text}`);
    await React.act(async () => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
      await tick();
    });
    await tick();
  }

  async function dispose() {
    await React.act(async () => root.unmount());
    await window.happyDOM.abort();
    globalThis.fetch = previousFetch;
  }

  async function clickAnchor(text) {
    const anchor = [...host.querySelectorAll("a")].find((candidate) => candidate.textContent?.includes(text));
    assert.ok(anchor, `anchor not found: ${text}`);
    await React.act(async () => {
      anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
      await tick();
    });
    await tick();
    return anchor;
  }

  return { window, host, session, router, commits, components, render, clickButton, clickAnchor, dispose };
}

const money = { amount: "0.00", currency: "CNY", unit: "yuan", scale: 2 };
const orderA = { id: "order_A", displayNo: "A-001", title: "PRIVATE_ORDER_A", status: "PENDING_PAYMENT", amounts: { rental: money, deposit: money, totalDue: money } };
const orderB = { id: "order_B", displayNo: "B-001", title: "PRIVATE_ORDER_B", status: "PAID", amounts: { rental: money, deposit: money, totalDue: money } };

test("integrated order detail opens its exact order in the main support host", async () => {
  const order = { ...orderB, fulfillmentAssignment: { state: "ASSIGNED", teamReady: true } };
  const probe = await createProbe(async url => Response.json(String(url).includes("/order_B") ? { order } : { items: [order], nextCursor: null, limit: 20 }));
  const opened = [];
  probe.window.addEventListener("zzsh:order-groups", event => opened.push(event.detail));
  try {
    await probe.render({ orderId: order.id });
    await probe.clickButton("打开订单群");
    assert.deepEqual(opened, [{ party: "renter", orderId: order.id }]);
  } finally { await probe.dispose(); }
});

test("F3: a successful empty page renders the designed empty state", async () => {
  const probe = await createProbe(async () => Response.json({ items: [], nextCursor: null, limit: 20 }));
  try {
    await probe.render({}, "empty");
    assert.match(probe.host.textContent, /还没有租入订单/);
    assert.doesNotMatch(probe.host.textContent, /已加载 \d+ 条/);
    assert.doesNotMatch(probe.host.textContent, /没有更多订单了/);
    // A genuinely empty full list earns the approved art; the art is decorative and must not carry the copy.
    const art = probe.host.querySelector(".account-empty-art");
    assert.ok(art, "the full empty list shows the approved empty-state art");
    assert.equal(art.getAttribute("alt"), "");
    assert.equal(art.getAttribute("src"), "/art/empty/rental-discover-r1.webp");
    assert.equal(probe.host.querySelector(".order-list-columns"), null);
    assert.equal(probe.host.querySelector(".order-list-footnote"), null);

    await probe.render({ status: "PAID" }, "filtered-empty");
    assert.match(probe.host.textContent, /没有符合筛选条件的订单/);
    assert.doesNotMatch(probe.host.textContent, /没有更多订单了/);
    // A filter miss is not a true empty list, so it stays text-only with a clear-filter action.
    assert.equal(probe.host.querySelector(".account-empty-art"), null);
  } finally {
    await probe.dispose();
  }
});

test("an owner account filter does not claim that the entire account has no orders", async () => {
  const probe = await createProbe(async () => Response.json({ items: [], nextCursor: null, limit: 20 }));
  try {
    await probe.render({ party: "owner", accountId: "account_A" }, "account-empty");
    assert.match(probe.host.textContent, /该账号暂无订单记录/);
    assert.doesNotMatch(probe.host.textContent, /上架账号后即可开始接单/);
    // Scoped to one account, the page cannot claim the whole list is empty, so it earns no art either.
    assert.equal(probe.host.querySelector(".account-empty-art"), null);
    assert.equal(probe.host.querySelector(".account-filter-context a").getAttribute("href"), "/account?view=leased");
  } finally {
    await probe.dispose();
  }
});

test("pending orders show an absolute hold deadline instead of a stale seconds countdown", async () => {
  const probe = await createProbe(async () => Response.json({ items: [{ ...orderA, holdUntil: "2099-10-01T00:30:00Z" }], nextCursor: null, limit: 20 }));
  try {
    await probe.render({}, "deadline");
    assert.match(probe.host.textContent, /占用截止.*2099/);
    assert.match(probe.host.textContent, /08:30/);
    assert.match(probe.host.textContent, /GMT\+08:00/);
    assert.doesNotMatch(probe.host.textContent, /占用还剩|分 \d+ 秒/);
  } finally { await probe.dispose(); }
});

test("F2: switching order or identity renders loading before old detail can commit", async () => {
  const pendingB = deferred();
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.endsWith("/order_A")) return Response.json({ order: orderA });
    if (url.endsWith("/order_B")) return pendingB.promise;
    return Response.json({ items: [orderA], nextCursor: null, limit: 20 });
  });
  try {
    await probe.render({ orderId: "order_A" }, "A");
    assert.match(probe.host.textContent, /A-001/);
    const commitsBeforeB = probe.commits.length;
    await probe.render({ orderId: "order_B" }, "B");
    assert.doesNotMatch(probe.host.textContent, /A-001/);
    assert.equal(probe.commits.slice(commitsBeforeB).some((commit) => commit.phase === "B" && commit.detail?.includes("A-001")), false);

    probe.session.userId = "user_B";
    probe.session.identityVersion = 2;
    await probe.render({ orderId: "order_B" }, "identity-B");
    assert.doesNotMatch(probe.host.textContent, /A-001/);
    await probe.render({ party: "owner", orderId: "order_B" }, "party-owner");
    assert.doesNotMatch(probe.host.textContent, /A-001/);
  } finally {
    pendingB.resolve(Response.json({ order: orderB }));
    await probe.dispose();
  }
});

test("F1: detail 401 clears the cached list and revalidates before returning", async () => {
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.endsWith("/order_A")) return Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
    return Response.json({ items: [orderA], nextCursor: null, limit: 20 });
  });
  try {
    await probe.render({}, "list");
    assert.match(probe.host.textContent, /A-001/);
    await probe.render({ orderId: "order_A" }, "401");
    assert.match(probe.host.textContent, /登录状态已变化/);
    assert.equal(probe.session.revalidations, 1);
    await probe.render({}, "back");
    assert.doesNotMatch(probe.host.textContent, /A-001/);
  } finally {
    await probe.dispose();
  }
});

test("refresh failure keeps rows and more failure keeps the cursor for an in-place retry", async () => {
  let firstCalls = 0;
  let moreCalls = 0;
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.includes("cursor=cursor_1")) {
      moreCalls += 1;
      if (moreCalls === 1) return Response.json({ error: { code: "TEMPORARY" } }, { status: 503 });
      return Response.json({ items: [orderB], nextCursor: null, limit: 20 });
    }
    firstCalls += 1;
    if (firstCalls === 2) return Response.json({ error: { code: "TEMPORARY" } }, { status: 503 });
    return Response.json({ items: [orderA], nextCursor: "cursor_1", limit: 20 });
  });
  try {
    await probe.render({}, "ready");
    await probe.clickButton("刷新");
    assert.match(probe.host.textContent, /刷新失败/);
    assert.match(probe.host.textContent, /A-001/);
    await probe.clickButton("加载更多订单");
    assert.match(probe.host.textContent, /重试加载/);
    assert.match(probe.host.textContent, /A-001/);
    await probe.clickButton("重试加载");
    assert.match(probe.host.textContent, /B-001/);
  } finally {
    await probe.dispose();
  }
});

const legacyOrder = {
  id: "legacy_A", displayNo: "OLD-1", title: "旧单记录", status: "PAID", party: "renter",
  source: { origin: "LEGACY", statusLabel: "旧单进行中" },
  readOnly: true, paymentOpen: false, cancelOpen: false, continuationCount: 0, actions: [],
  account: { id: "acct_9", displayNo: "OLD-9", readable: false },
  legacyAmounts: { required: money, paid: money, deposit: money, refund: money },
};

const pricedOrder = {
  id: "order_priced",
  displayNo: "ZZ-9",
  title: "计价样本",
  status: "COMPLETED",
  createdAt: "2026-10-12T00:20:00Z",
  termSeconds: "259200",
  paidAt: "2026-10-12T00:21:00Z",
  amounts: { rental: { amount: "328.00", currency: "CNY" }, deposit: { amount: "200.00", currency: "CNY" }, totalDue: { amount: "528.00", currency: "CNY" } },
  quote: { ownerTotal: { amount: "240.00", currency: "CNY" }, lines: [] },
};

test("each party's list states its own money basis and never substitutes the other side", async () => {
  const probe = await createProbe(async () => Response.json({ items: [pricedOrder], nextCursor: null, limit: 20 }));
  try {
    await probe.render({ party: "renter" }, "renter");
    assert.equal(probe.host.querySelector(".order-row-amount strong").textContent, "528.00 元");
    // A settled order is labelled by what the figure is, never as an amount still owed.
    assert.match(probe.host.querySelector(".order-row-amount-label").textContent, /实付/);
    assert.doesNotMatch(probe.host.querySelector(".order-row-amount-label").textContent, /应付/);
    const breakdown = [...probe.host.querySelectorAll(".order-row-amount-sub > span")].map((node) => node.textContent);
    assert.deepEqual(breakdown, ["租赁 328.00 元", "押金 200.00 元"]);
    assert.doesNotMatch(probe.host.textContent, /号主报价/);
    assert.match(probe.host.textContent, /已加载 1 条/);

    await probe.render({ party: "owner" }, "owner");
    assert.equal(probe.host.querySelector(".order-row-amount strong").textContent, "240.00 元");
    assert.match(probe.host.querySelector(".order-row-amount-label").textContent, /号主报价/);
    // The renter's actual payment is a different number (rental discounts apply), so the owner's row
    // states only the owner's own figure and never borrows the renter's.
    assert.ok(!probe.host.querySelector(".order-row-amount-sub"), "the owner row states only its own figure");
    assert.doesNotMatch(probe.host.querySelector(".order-row-amount").textContent, /租客/);
    assert.doesNotMatch(probe.host.textContent, /已赚取|已到账/);
  } finally {
    await probe.dispose();
  }
});

test("a row names the account and its resources so two orders are told apart by more than digits", async () => {
  const withLines = {
    ...pricedOrder,
    id: "order_identity",
    title: "三角洲 · 60 级账号",
    displayNo: "ZZ-9",
    quote: {
      lines: [
        { itemId: "haff", unit: "HAFF_BASE", quantity: "1500000" },
        { itemId: "ins", name: "保险卡", unit: "PIECE", quantity: "10" },
      ],
    },
  };
  const probe = await createProbe(async () => Response.json({ items: [withLines], nextCursor: null, limit: 20 }));
  try {
    await probe.render({ party: "renter" }, "identity");
    const row = probe.host.querySelector(".order-row");
    assert.match(row.querySelector(".order-row-title").textContent, /1\.5 M 哈夫币/);
    // The resource signature does the work the account list's structured title does: it is built from
    // the fields the order read returned, never from an opaque item id.
    assert.match(row.querySelector(".order-row-title").textContent, /1\.5 M 哈夫币/);
    assert.equal(row.querySelector(".order-row-resources").textContent, "保险卡 ×10");
    // The order number is labelled, so it is not read as the account's own number.
    assert.equal(row.querySelector(".order-row-no").textContent, "订单 ZZ-9");
  } finally {
    await probe.dispose();
  }
});

test("an unnamed list projection stays readable and never repeats zero-unit fragments", async () => {
  const unnamed = {
    ...pricedOrder,
    id: "order_unnamed",
    quote: {
      lines: [
        { itemId: "barrett", unit: "ROUND", quantity: "0" },
        { itemId: "awm", unit: "ROUND", quantity: "600" },
        { itemId: "haff", unit: "HAFF_BASE", quantity: "90000000" },
        { itemId: "insurance", unit: "DAY", quantity: "0" },
      ],
    },
  };
  const probe = await createProbe(async () => Response.json({ items: [unnamed], nextCursor: null, limit: 20 }));
  try {
    await probe.render({ party: "renter" }, "unnamed");
    const summary = probe.host.querySelector(".order-row-resources").textContent;
    assert.equal(summary, "物资 1 项");
    assert.doesNotMatch(summary, /发 ×0|件 ×0|天 ×0/);
    const named = { ...unnamed, id: "order_named", quote: { lines: [
      { itemId: "awm", name: "AWM子弹", unit: "ROUND", quantity: "600" },
      { itemId: "insurance", name: "九格保险体验卡", unit: "DAY", quantity: "0" },
    ] } };
    const next = await createProbe(async () => Response.json({ items: [named], nextCursor: null, limit: 20 }));
    try {
      await next.render({ party: "renter" }, "named");
      const text = next.host.querySelector(".order-row-resources").textContent;
      assert.equal(text, "AWM子弹 ×600");
      assert.doesNotMatch(text, /保险|×0/);
    } finally {
      await next.dispose();
    }
  } finally {
    await probe.dispose();
  }
});

test("a closed order never reads as a bill still payable", async () => {
  const closed = { ...pricedOrder, id: "order_closed", status: "CANCELLED", paidAt: null, cancelReason: "USER" };
  const probe = await createProbe(async () => Response.json({ items: [closed], nextCursor: null, limit: 20 }));
  try {
    await probe.render({ party: "renter" }, "cancelled");
    assert.match(probe.host.querySelector(".order-row-amount-label").textContent, /下单金额/);
    assert.doesNotMatch(probe.host.querySelector(".order-row-amount-label").textContent, /应付|已付/);
    // The closed row states the closure once, without repeating the list-wide settlement rule per row.
    assert.match(probe.host.querySelector(".order-row-hint").textContent, /订单已关闭/);
    assert.doesNotMatch(probe.host.textContent, /结算与确认记录见订单详情/);
  } finally {
    await probe.dispose();
  }
});

test("a missing owner quote stays unknown instead of borrowing the renter's payable", async () => {
  const noQuote = { ...pricedOrder, quote: { lines: [] } };
  const probe = await createProbe(async () => Response.json({ items: [noQuote], nextCursor: null, limit: 20 }));
  try {
    await probe.render({ party: "owner" }, "owner-no-quote");
    assert.equal(probe.host.querySelector(".order-row-amount strong").textContent, "待确认");
    assert.match(probe.host.querySelector(".order-row-amount-label").textContent, /号主报价暂不可用/);
  } finally {
    await probe.dispose();
  }
});

test("an expired pending order stops offering payment while a live one still does", async () => {
  const expired = { ...pricedOrder, id: "order_expired", status: "PENDING_PAYMENT", paidAt: null, expiredAwaitingCancel: true };
  const live = { ...pricedOrder, id: "order_live", status: "PENDING_PAYMENT", paidAt: null, expiredAwaitingCancel: false, holdUntil: "2099-10-01T00:30:00Z" };
  const probe = await createProbe(async () => Response.json({ items: [expired, live], nextCursor: null, limit: 20 }));
  try {
    await probe.render({}, "pending");
    const actions = [...probe.host.querySelectorAll(".order-row-action")].map((node) => node.textContent);
    assert.deepEqual(actions, ["查看订单", "查看并付款"]);
    assert.match(probe.host.textContent, /已到期，取消处理中/);
    assert.match(probe.host.textContent, /占用截止 · 2099/);
    // Both rows link to their own detail; neither can pay from the list.
    const links = [...probe.host.querySelectorAll("a[data-order-id]")].map((node) => node.getAttribute("href"));
    assert.deepEqual(links, ["/account?view=rentals&orderId=order_expired", "/account?view=rentals&orderId=order_live"]);
  } finally {
    await probe.dispose();
  }
});

test("the detail keeps the base order visible when the settlement read is not assembled", async () => {
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.endsWith("/order_priced")) return Response.json({ order: pricedOrder });
    // The settlement read is the thing under test: it must fail for real, not answer with list-shaped
    // data, or the page would be reporting a gap it never observed.
    if (url.includes("/settlement")) return Response.json({ error: { code: "NOT_FOUND", message: "Resource not found" } }, 404);
    return Response.json({ items: [pricedOrder], nextCursor: null, limit: 20 });
  });
  try {
    await probe.render({ status: "COMPLETED", accountId: "account_9", orderId: "order_priced" }, "detail");
    // The gap is only reported once the read has actually failed; during the read nothing is missing.
    await tick();
    await tick();
    const detail = probe.host.querySelector("[data-testid=order-detail]");
    assert.ok(detail, "the detail view renders");
    assert.match(detail.textContent, /租赁账号/);
    assert.match(detail.textContent, /ZZ-9/);
    // The order's own outcome is stated once, in the identity band.
    assert.match(detail.querySelector(".order-detail-status").textContent, /已完成/);
    assert.match(detail.textContent, /528.00 元/);
    // This harness stubs the trade panel, so the recovery cluster it drives is asserted in
    // order-trade-components-behavior instead.
    assert.equal(detail.querySelector(".order-attention"), null);
    // Unknown opening and settlement are never invented: no progress is claimed for steps that were
    // not read, and the order is not re-labelled as still renting.
    assert.equal(detail.querySelector(".order-stage-track"), null);
    assert.doesNotMatch(detail.textContent, /已开租|租用中|结算已生效/);
    // No mock settlement numbers and no fabricated refund/delivery claim may appear.
    assert.doesNotMatch(detail.textContent, /168\.36|248\.00|退款成功|退款已到账/);
    const back = probe.host.querySelector(".order-detail-back");
    assert.equal(back.getAttribute("href"), "/account?view=rentals&status=COMPLETED&accountId=account_9");
  } finally {
    await probe.dispose();
  }
});

test("one list includes both sources and old deep links return to the same filtered list", async () => {
  const calls = [];
  const old = { ...legacyOrder, id: orderA.id, orderFacts: { resources: [{ code: "df_billable_level6_bullet", quantity: "60", unit: null }, { code: "df_billable_top_insure_card", quantity: "7", unit: "DAY" }], rentalDeadlineAt: "2025-10-09T08:53:20.000Z" } };
  const probe = await createProbe(async (input, init) => {
    const url=String(input);calls.push({url,init});
    if(url.includes("/api/orders/legacy/"+orderA.id))return Response.json({order:old});
    if(url.endsWith("/"+orderA.id))return Response.json({order:orderA});
    assert.ok(url.startsWith("/api/orders/unified?"));
    return Response.json({items:[{...orderA,source:{origin:"NATIVE"}},old],nextCursor:null,limit:20});
  });
  try {
    await probe.render({status:"PAID",accountId:"acct_9"});
    assert.equal(probe.host.querySelectorAll(".order-row").length,2);
    assert.doesNotMatch(probe.host.textContent,/历史订单|当前订单|旧平台|新平台|统一入口尚未完成/);
    assert.match(probe.host.textContent,/6级子弹 60 · 顶级保险卡 7 天/);
    assert.match(probe.host.textContent,/租赁截止/);
    // U5-R1-02: the historical refund figure is labelled as the original record in the list row.
    assert.match(probe.host.textContent,/原退款金额记录/);
    assert.doesNotMatch(probe.host.textContent,/应退金额（到账待确认）|应退责任 /);
    const links=[...probe.host.querySelectorAll("a[data-order-id]")];
    assert.equal(new Set(links.map(a=>a.dataset.orderKey)).size,2);
    assert.ok(links.some(a=>a.href.includes("source=legacy")));
    await probe.render({status:"PAID",accountId:"acct_9",orderId:orderA.id,source:"legacy"});
    assert.match(probe.host.textContent,/可办理事项以本单核定结果为准/);
    assert.match(probe.host.textContent,/不是原账号标题/);
    assert.match(probe.host.textContent,/保险按天/);
    assert.match(probe.host.textContent,/租赁截止/);
    // U5-R1-02: the detail keeps the original refund record wording and never calls it the current duty.
    assert.match(probe.host.textContent,/原退款金额记录/);
    assert.doesNotMatch(probe.host.textContent,/应退金额（到账待确认）|应退责任 /);
    assert.doesNotMatch(probe.host.textContent,/历史|旧平台|新平台|旧单记录/);
    const back=[...probe.host.querySelectorAll("a")].find(a=>a.textContent==="返回订单列表");
    assert.equal(back.getAttribute("href"),"/account?view=rentals&status=PAID&accountId=acct_9");
    assert.equal(calls.filter(c=>c.url.endsWith("/api/orders/"+orderA.id)).length,0);
    await probe.render({status:"PAID",accountId:"acct_9"});
    assert.equal(probe.host.querySelectorAll(".order-row").length,2);
    assert.equal(calls.filter(c=>c.url.startsWith("/api/orders/unified?")).length,1);
  }finally{await probe.dispose();}
});

test("a closed order detail drops the payment prompt and names the figure as a snapshot", async () => {
  const closed = { ...pricedOrder, id: "order_closed", status: "CANCELLED", paidAt: null, cancelledAt: "2026-10-12T01:00:00Z", cancelReason: "USER" };
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.endsWith("/order_closed")) return Response.json({ order: closed });
    return Response.json({ items: [closed], nextCursor: null, limit: 20 });
  });
  try {
    await probe.render({ status: "CANCELLED", orderId: "order_closed" }, "detail-cancelled");
    const detail = probe.host.querySelector("[data-testid=order-detail]");
    assert.ok(detail, "the detail view renders");
    // A closed order is closed, not failed and not still awaiting payment.
    assert.match(detail.querySelector(".order-detail-status").textContent, /已取消/);
    assert.match(detail.querySelector(".order-attention-copy h2").textContent, /账号占用已解除/);
    assert.doesNotMatch(detail.textContent, /提交支付前请核对金额/);
    assert.doesNotMatch(detail.textContent, /支付不等于交付/);
    assert.match(detail.querySelector(".order-amount-block .order-section-title").textContent, /租客侧金额/);
    assert.match(detail.querySelector(".order-amount-label").textContent, /下单金额/);
    assert.doesNotMatch(detail.querySelector(".order-amount-block").textContent, /应付/);
    // The consequence of closure is stated once, and the state itself lives only in the status pill.
    assert.equal((detail.textContent.match(/账号占用已解除/g) ?? []).length, 1);
    assert.equal((detail.textContent.match(/已取消 · 租客取消/g) ?? []).length, 1);
  } finally {
    await probe.dispose();
  }
});

test("ORDER-A: list shows the frozen mode and never asks the reader to distinguish platform origin", async () => {
  const fast = { ...pricedOrder, id: "fast_order", title: "极速快照账号", quote: { rentalMode: "fast", lines: [] } };
  const v1 = { ...pricedOrder, id: "v1_order", title: "旧版快照账号", quote: { lines: [] } };
  const legacy = { ...legacyOrder, id: "legacy_order" };
  const probe = await createProbe(async () => Response.json({ items: [fast, v1, legacy], nextCursor: null, limit: 20 }));
  try {
    await probe.render({ party: "renter" }, "order-a-tags");
    const row = (id) => probe.host.querySelector(`[data-order-id="${id}"]`)?.closest(".order-row");
    assert.match(row("fast_order").querySelector(".order-row-tag[data-mode=fast]").textContent, /极速出租/);
    assert.equal(row("v1_order").querySelector(".order-row-tag"), null, "a missing v1 mode is not guessed as ordinary");
    assert.equal(row("legacy_order").querySelector(".order-row-tag"), null, "legacy rows carry no platform-origin label");
    assert.doesNotMatch(probe.host.textContent, /历史订单|旧平台|新平台/);
    assert.ok(row("legacy_order").querySelector("a[data-order-id='legacy_order']"), "the record remains openable for supported continuation");
  } finally {
    await probe.dispose();
  }
});

test("ORDER-A: detail names the frozen mode, both parties' unit prices and the real fee-total basis", async () => {
  const detailOrder = {
    ...pricedOrder,
    id: "order_a_detail",
    status: "PAID",
    paidAt: "2026-10-12T00:21:00Z",
    quote: {
      rentalMode: "fast",
      ownerTotal: { amount: "100.00", currency: "CNY" },
      lines: [
        { itemId: "haff", name: "哈夫币", unit: "HAFF_BASE", quantity: "3000000", unitQuantity: "1000000",
          buyerUnitAmount: { amount: "0.12345678", currency: "CNY", scale: 8 }, buyerAmount: { amount: "0.37", currency: "CNY" },
          ownerUnitAmount: { amount: "0.10000000", currency: "CNY", scale: 8 }, ownerAmount: { amount: "0.30", currency: "CNY" } },
        { itemId: "ammo", name: "AWM子弹", unit: "ROUND", quantity: "120", unitQuantity: "60",
          buyerUnitAmount: { amount: "0.00000012", currency: "CNY", scale: 8 }, buyerAmount: { amount: "0.00", currency: "CNY" },
          ownerUnitAmount: { amount: "0.00000010", currency: "CNY", scale: 8 }, ownerAmount: { amount: "0.00", currency: "CNY" } },
      ],
    },
    fulfillmentAssignment: { state: "ASSIGNED", teamReady: true, teamState: "READY", assignedAt: "2026-10-12T00:22:00Z" },
  };
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.endsWith("/order_a_detail")) return Response.json({ order: detailOrder });
    if (url.includes("/refunds")) return Response.json({ error: { code: "NOT_FOUND", message: "Resource not found" } }, 404);
    return Response.json({ items: [detailOrder], nextCursor: null, limit: 20 });
  });
  try {
    await probe.render({ party: "renter", status: "PAID", orderId: "order_a_detail" }, "order-a-detail-renter");
    await tick(); await tick();
    const renter = probe.host.querySelector("[data-testid=order-detail]");
    assert.ok(renter, "detail renders");
    assert.match(renter.querySelector(".order-detail-mode").textContent, /极速出租/);
    assert.ok([...renter.querySelectorAll(".order-table-wrap td")].every((td) => td.hasAttribute("data-label")), "mobile stacking keeps a label for every cell");
    assert.match(renter.querySelector(".order-line-unit").textContent, /¥0\.12345678 \/ 1,000,000 哈夫币（1 M）/);
    assert.match(renter.textContent, /¥0\.00000012 \/ 60 发/);
    assert.match(renter.querySelector(".order-lines-total").textContent, /资源合计（不含押金） 328\.00 元/);
    assert.match(renter.querySelector(".order-contact-facts").textContent, /客服分配/);
    assert.match(renter.querySelector(".order-contact-facts").textContent, /已就绪/);
    await probe.render({ party: "owner", status: "PAID", orderId: "order_a_detail" }, "order-a-detail-owner");
    await tick(); await tick();
    const owner = probe.host.querySelector("[data-testid=order-detail]");
    assert.match(owner.textContent, /¥0\.10000000 \/ 1,000,000 哈夫币（1 M）/);
    assert.doesNotMatch(owner.textContent, /¥0\.12345678/);
    assert.match(owner.querySelector(".order-lines-total").textContent, /号主报价合计 100\.00 元/);
  } finally {
    await probe.dispose();
  }
});

test("API facts feed the order title, account number, stage and entitlements", async () => {
  const factsOrder = {
    ...pricedOrder,
    id: "order_facts",
    status: "PAID",
    paidAt: "2026-10-12T00:21:00Z",
    accountDisplayNo: "A20261028001",
    listingFacts: {
      source: "ORDER_VERSION", versionId: "ver_1", rentalMode: "ordinary", termSeconds: "86400",
      attributeDisplay: { safeBox: "6格", grading: "钻石", loginMethod: "QQ" },
      resourceLines: [{ itemId: "haff", code: "HAFF", name: "哈夫币", quantity: "1200000", unit: "HAFF_BASE" }],
    },
    stage: { code: "DECISION_PENDING", label: "待你确认结算", viewerActionRequired: true, settlementVersionNo: 2 },
    entitlements: [{ id: "ent_1", name: "九格保险体验卡", nameSource: "ORDER_VERSION", expiresAt: "2026-11-01T00:00:00.000Z", expiryKind: "TIMED", fullTermGuaranteed: false }],
  };
  const probe = await createProbe(async (input) => {
    const url = String(input);
    if (url.endsWith("/order_facts")) return Response.json({ order: factsOrder });
    return Response.json({ items: [factsOrder], nextCursor: null, limit: 20 });
  });
  try {
    await probe.render({ party: "renter" }, "facts-list");
    const row = probe.host.querySelector('[data-order-id="order_facts"]').closest(".order-row");
    assert.match(row.querySelector(".order-row-title").textContent, /1\.2 M 哈夫币 · 6格 · 钻石/);
    assert.match(row.querySelector(".order-row-meta").textContent, /账号 A20261028001/);
    assert.match(row.querySelector(".order-row-hint").textContent, /待你确认结算 · 需要你处理/);
    assert.doesNotMatch(row.querySelector(".order-row-resources")?.textContent ?? "", /哈夫币/);
    await probe.render({ party: "renter", status: "PAID", orderId: "order_facts" }, "facts-detail");
    await tick(); await tick();
    const detail = probe.host.querySelector("[data-testid=order-detail]");
    assert.match(detail.textContent, /账号 A20261028001/);
    assert.match(detail.textContent, /待你确认结算/);
    assert.match(detail.textContent, /九格保险体验卡/);
    assert.match(detail.textContent, /不保证覆盖完整租期/);
  } finally { await probe.dispose(); }
});
