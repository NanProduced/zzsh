import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(tree, "package.json"));
const ts = require("typescript");
const React = require("react");
const { Window } = require("happy-dom");

function loadTrade(session) {
  const file = path.join(tree, "apps/web/src/components/order/order-trade-actions.tsx");
  const module = new Module(path.join(tree, "order-a-payment-deadline-probe.cjs"));
  module.filename = path.join(tree, "order-a-payment-deadline-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "next/link") return ({ scroll: _scroll, ...props }) => React.createElement("a", props);
    if (name === "qrcode.react") return { QRCodeSVG: () => null };
    if (name === "@/components/session/user-session-provider") return { useUserSession: () => session };
    if (name === "@/components/session/identity-reset") return require(path.join(tree, "apps/web/src/components/session/identity-reset.ts"));
    if (name === "@/lib/order-client") return require(path.join(tree, "apps/web/src/lib/order-client.ts"));
    if (name === "@/lib/order-intents") return require(path.join(tree, "apps/web/src/lib/order-intents.ts"));
    if (name === "@/lib/order-display") return require(path.join(tree, "apps/web/src/lib/order-display.ts"));
    if (name.endsWith(".css")) return {};
    return require(name);
  };
  module._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, module.filename);
  return module.exports.OrderTradeActions;
}

async function renderDeadline(order) {
  const window = new Window({ url: "http://127.0.0.1/account?view=rentals" });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    Event: window.Event, MouseEvent: window.MouseEvent, CustomEvent: window.CustomEvent, DOMException: window.DOMException,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "synthetic" } }), { status: 404, headers: { "content-type": "application/json" } });
  const session = { status: "authenticated", userId: "user_A", identityVersion: 1, confirm() {}, revalidate() {} };
  const Component = loadTrade(session);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  try {
    await React.act(async () => { root.render(React.createElement(Component, { order, party: "renter", onChanged() {} })); });
    await new Promise(setImmediate);
    const deadline = host.querySelector(".order-trade-deadline");
    return { text: host.textContent ?? "", deadlineText: deadline?.textContent ?? "", deadline: Boolean(deadline) };
  } finally {
    await React.act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    await window.happyDOM.abort();
  }
}

const base = {
  id: "order_deadline", displayNo: "ZZ-D", title: "截止时间样本", status: "PENDING_PAYMENT",
  amounts: { rental: { amount: "10.00", currency: "CNY" }, deposit: { amount: "0.00", currency: "CNY" }, totalDue: { amount: "10.00", currency: "CNY" } },
  quote: { lines: [] }, paymentOpen: true, cancelOpen: true,
};

test("ORDER-A: pending detail states the server hold deadline without faking cancellation", async () => {
  const result = await renderDeadline({ ...base, holdUntil: "2026-10-12T00:30:00Z", expiredAwaitingCancel: false });
  assert.match(result.deadlineText, /支付保留至/);
  assert.match(result.deadlineText, /2026\/10\/12/);
  assert.match(result.deadlineText, /到期后是否取消以服务端订单状态为准/);
  assert.doesNotMatch(result.deadlineText, /已取消|倒计时/);
});

test("ORDER-A: an expired hold is labelled as the original deadline and an absent hold stays absent", async () => {
  const expired = await renderDeadline({ ...base, holdUntil: "2026-10-12T00:30:00Z", expiredAwaitingCancel: true });
  assert.match(expired.deadlineText, /原支付保留截止/);
  const missing = await renderDeadline({ ...base, holdUntil: null, expiredAwaitingCancel: false });
  assert.equal(missing.deadline, false);
});
