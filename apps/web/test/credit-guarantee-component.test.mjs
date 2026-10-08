import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const React = requireFromTree("react");
const typescript = requireFromTree("typescript");

function loadTs(file, overrides = {}) {
  const module = new Module(file);
  module.filename = file;
  module.paths = Module._nodeModulePaths(path.dirname(file));
  const native = module.require.bind(module);
  module.require = (name) => overrides[name] ?? native(name);
  module._compile(typescript.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  return module.exports;
}

const icons = new Proxy({}, { get: () => (props) => React.createElement("span", props) });
const session = { revalidate() {} };
const componentPath = path.join(tree, "apps/web/src/components/account/credit-center.tsx");
const clientPath = path.join(tree, "apps/web/src/lib/credit-guarantee-client.ts");

function setupStorage(throws = false) {
  const values = new Map();
  globalThis.sessionStorage = { getItem: (key) => values.get(key) ?? null, setItem: (_key, _value) => { if (throws) throw Error("STORAGE_DENIED"); values.set(_key, _value); }, removeItem: (key) => values.delete(key), clear: () => values.clear() };
  return values;
}

function overview() { return { credit: { userId: "user-A", score: 70, revision: "1", initializedAt: "2026-01-01", events: [] }, recoveryRequests: [], guarantees: [], transactions: [] }; }
function historyOverview() { return { ...overview(), transactions: [{ requirementId: "req-1", accountId: "account-1", paymentStatus: "CONFIRMED", refundStatus: "UNKNOWN", paymentFinanceEventId: "event-2", refundFinanceEventId: null, paymentHistory: [{ id: "pay-1", requirementId: "req-1", merchantOrderNo: "merchant-1", amountCents: "500", status: "FAILED", providerTransactionId: null, financeEventId: null, ledgerEntryRef: null }, { id: "pay-2", requirementId: "req-1", merchantOrderNo: "merchant-2", amountCents: "500", observedAmountCents: "500", status: "CONFIRMED", providerTransactionId: "provider-2", financeEventId: "event-2", ledgerEntryRef: "line-2" }], refundHistory: [{ id: "refund-1", requirementId: "req-1", paymentId: "pay-2", amountCents: "500", status: "FAILED", providerRefundId: null, financeEventId: null, ledgerEntryRef: null }, { id: "refund-2", requirementId: "req-1", paymentId: "pay-2", amountCents: "500", status: "UNKNOWN", providerRefundId: null, financeEventId: null, ledgerEntryRef: null }] }] }; }

async function mount(fetchImpl) {
  const browser = new Window({ url: "http://127.0.0.1:3100/account" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, DOMException: browser.DOMException, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = fetchImpl;
  const module = loadTs(componentPath, { "lucide-react": icons, "./credit-center.css": {}, "../session/user-session-provider": { useUserSession: () => session }, "../../lib/credit-guarantee-client": loadTs(clientPath) });
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = requireFromTree("react-dom/client").createRoot(host);
  await React.act(async () => root.render(React.createElement(module.CreditCenter, { scope: "scope-A" })));
  await new Promise(setImmediate);
  return { browser, host, root, component: module.CreditCenter, client: loadTs(clientPath) };
}

async function typeReason(host, value) {
  const textarea = host.querySelector("textarea");
  Object.getOwnPropertyDescriptor(host.ownerDocument.defaultView.HTMLTextAreaElement.prototype, "value").set.call(textarea, value);
  await React.act(async () => textarea.dispatchEvent(new host.ownerDocument.defaultView.Event("input", { bubbles: true })));
  await React.act(async () => textarea.dispatchEvent(new host.ownerDocument.defaultView.Event("change", { bubbles: true })));
}

test("CreditCenter storage failure refuses the POST", async () => {
  setupStorage(true); let posts = 0;
  const mounted = await mount(async (_url, init) => { if (init?.method === "POST") posts += 1; return new Response(JSON.stringify(overview()), { status: 200 }); });
  try {
    await typeReason(mounted.host, "申请恢复的实际说明");
    const button = [...mounted.host.querySelectorAll("button")].find((item) => item.textContent.includes("提交恢复申请"));
    await React.act(async () => button.dispatchEvent(new mounted.browser.MouseEvent("click", { bubbles: true })));
    await new Promise(setImmediate);
    assert.equal(posts, 0);
    assert.match(mounted.host.textContent, /无法保存原操作意图/);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("accepted POST persists readback phase across remount and never replays POST", async () => {
  const storage = setupStorage(false); let posts = 0; let reads = 0; let failReadback = true;
  const fetchImpl = async (_url, init) => {
    if (init?.method === "POST") { posts += 1; return new Response(JSON.stringify({ status: "REQUESTED" }), { status: 200 }); }
    reads += 1;
    if (failReadback && reads === 2) throw Error("GET_READBACK_UNKNOWN");
    return new Response(JSON.stringify(overview()), { status: 200 });
  };
  let mounted = await mount(fetchImpl);
  await typeReason(mounted.host, "申请恢复的实际说明");
  const button = [...mounted.host.querySelectorAll("button")].find((item) => item.textContent.includes("提交恢复申请"));
  await React.act(async () => button.dispatchEvent(new mounted.browser.MouseEvent("click", { bubbles: true })));
  await new Promise(setImmediate);
  assert.equal(posts, 1);
  assert.match([...storage.values()][0], /"phase":"readback"/);
  await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort();

  failReadback = false; mounted = await mount(fetchImpl);
  try {
    assert.ok([...mounted.host.querySelectorAll("button")].some((item) => item.textContent.includes("重新读取")));
    const reread = [...mounted.host.querySelectorAll("button")].find((item) => item.textContent.includes("重新读取"));
    await React.act(async () => reread.dispatchEvent(new mounted.browser.MouseEvent("click", { bubbles: true })));
    await new Promise(setImmediate);
    assert.equal(posts, 1);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("late A accepted phase cannot overwrite a newer B component intent", async () => {
  const storage = setupStorage(false); const posts = [];
  const mounted = await mount(async (_url, init) => {
    if (init?.method === "POST") return new Promise((resolve, reject) => posts.push({ resolve, reject }));
    return new Response(JSON.stringify(overview()), { status: 200 });
  });
  const secondHost = mounted.browser.document.createElement("div"); mounted.browser.document.body.append(secondHost); const secondRoot = requireFromTree("react-dom/client").createRoot(secondHost);
  try {
    await React.act(async () => secondRoot.render(React.createElement(mounted.component, { scope: "scope-A" })));
    await new Promise(setImmediate);
    await typeReason(mounted.host, "A申请"); await typeReason(secondHost, "B申请");
    const buttonA = [...mounted.host.querySelectorAll("button")].find((item) => item.textContent.includes("提交恢复申请"));
    const buttonB = [...secondHost.querySelectorAll("button")].find((item) => item.textContent.includes("提交恢复申请"));
    await React.act(async () => buttonA.dispatchEvent(new mounted.browser.MouseEvent("click", { bubbles: true })));
    await React.act(async () => buttonB.dispatchEvent(new mounted.browser.MouseEvent("click", { bubbles: true })));
    assert.equal(posts.length, 2);
    const keyB = JSON.parse([...storage.values()][0]).key;
    await React.act(async () => { posts[0].resolve(new Response(JSON.stringify({ status: "REQUESTED" }), { status: 200 })); posts[1].reject(Error("B_UNKNOWN")); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(JSON.parse([...storage.values()][0]).key, keyB);
  } finally { await React.act(async () => { secondRoot.unmount(); mounted.root.unmount(); }); secondHost.remove(); await mounted.browser.happyDOM.abort(); }
});

test("CreditCenter renders every payment and refund attempt", async () => {
  setupStorage(false);
  const mounted = await mount(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? {} : historyOverview()), { status: 200 }));
  try {
    assert.match(mounted.host.textContent, /支付尝试 2 笔/);
    assert.match(mounted.host.textContent, /退款尝试 2 笔/);
    assert.match(mounted.host.textContent, /merchant-1/);
    assert.match(mounted.host.textContent, /refund-2/);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});
