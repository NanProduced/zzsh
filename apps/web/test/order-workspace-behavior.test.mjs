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
const workspaceSource = fs.readFileSync(path.join(tree, "apps/web/src/components/order/order-workspace.tsx"), "utf8");
const compiledWorkspace = typescript.transpileModule(workspaceSource, {
  compilerOptions: {
    module: typescript.ModuleKind.CommonJS,
    jsx: typescript.JsxEmit.ReactJSX,
    target: typescript.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function loadWorkspace(session, router) {
  const module = new Module(path.join(tree, "order-workspace-component-probe.cjs"));
  module.filename = path.join(tree, "order-workspace-component-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "next/link") return function Link({ scroll: _scroll, ...props }) { return React.createElement("a", props); };
    if (name === "next/navigation") return { useRouter: () => router };
    if (name === "@/components/session/user-session-provider") return { useUserSession: () => session };
    if (name === "@/lib/order-client") return requireFromTree(path.join(tree, "apps/web/src/lib/order-client.ts"));
    if (name === "@/components/order/order-trade-actions") return { OrderTradeActions: () => null };
    if (name.endsWith(".css")) return {};
    return requireFromTree(name);
  };
  module._compile(compiledWorkspace, module.filename);
  return module.exports.OrderWorkspace;
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
  const OrderWorkspace = loadWorkspace(session, router);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = requireFromTree("react-dom/client").createRoot(host);
  const commits = [];
  let phase = "";

  async function render(props, nextPhase = "") {
    phase = nextPhase;
    await React.act(async () => {
      root.render(React.createElement(
        React.Profiler,
        { id: "order", onRender: () => commits.push({ phase, text: host.textContent ?? "", detail: host.querySelector("[data-testid=order-detail]")?.textContent ?? null }) },
        React.createElement(OrderWorkspace, { party: "renter", ...props }),
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

  return { window, host, session, router, commits, render, clickButton, dispose };
}

const money = { amount: "0.00", currency: "CNY", unit: "yuan", scale: 2 };
const orderA = { id: "order_A", displayNo: "A-001", title: "PRIVATE_ORDER_A", status: "PENDING_PAYMENT", amounts: { rental: money, deposit: money, totalDue: money } };
const orderB = { id: "order_B", displayNo: "B-001", title: "PRIVATE_ORDER_B", status: "PAID", amounts: { rental: money, deposit: money, totalDue: money } };

test("F3: a successful empty page renders the designed empty state", async () => {
  const probe = await createProbe(async () => Response.json({ items: [], nextCursor: null, limit: 20 }));
  try {
    await probe.render({}, "empty");
    assert.match(probe.host.textContent, /当前显示 0 条/);
    assert.match(probe.host.textContent, /还没有租入记录/);
    assert.doesNotMatch(probe.host.textContent, /没有更多订单了/);
    await probe.render({ status: "PAID" }, "filtered-empty");
    assert.match(probe.host.textContent, /没有符合筛选条件的订单/);
    assert.doesNotMatch(probe.host.textContent, /没有更多订单了/);
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
    assert.match(probe.host.textContent, /PRIVATE_ORDER_A/);
    const commitsBeforeB = probe.commits.length;
    await probe.render({ orderId: "order_B" }, "B");
    assert.doesNotMatch(probe.host.textContent, /PRIVATE_ORDER_A/);
    assert.equal(probe.commits.slice(commitsBeforeB).some((commit) => commit.phase === "B" && commit.detail?.includes("PRIVATE_ORDER_A")), false);

    probe.session.userId = "user_B";
    probe.session.identityVersion = 2;
    await probe.render({ orderId: "order_B" }, "identity-B");
    assert.doesNotMatch(probe.host.textContent, /PRIVATE_ORDER_A/);
    await probe.render({ party: "owner", orderId: "order_B" }, "party-owner");
    assert.doesNotMatch(probe.host.textContent, /PRIVATE_ORDER_A/);
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
    assert.match(probe.host.textContent, /PRIVATE_ORDER_A/);
    await probe.render({ orderId: "order_A" }, "401");
    assert.match(probe.host.textContent, /登录状态已变化/);
    assert.equal(probe.session.revalidations, 1);
    await probe.render({}, "back");
    assert.doesNotMatch(probe.host.textContent, /PRIVATE_ORDER_A/);
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
    assert.match(probe.host.textContent, /PRIVATE_ORDER_A/);
    await probe.clickButton("加载更多订单");
    assert.match(probe.host.textContent, /重试加载/);
    assert.match(probe.host.textContent, /PRIVATE_ORDER_A/);
    await probe.clickButton("重试加载");
    assert.match(probe.host.textContent, /PRIVATE_ORDER_B/);
  } finally {
    await probe.dispose();
  }
});
