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
const AdminApiError = class extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } };
const Button = ({ children, ...props }) => React.createElement("button", props, children);
const Input = (props) => React.createElement("input", props);
const Badge = ({ children }) => React.createElement("span", null, children);
const data = { credit: { userId: "user-A", score: 70, revision: "1", events: [] }, recoveryRequests: [], guarantees: [], transactions: [{ requirementId: "req-1", accountId: "account-1", paymentStatus: "CONFIRMED", refundStatus: "UNKNOWN", merchantOrderNo: "merchant-2", paymentFinanceEventId: "event-2", refundFinanceEventId: null, paymentHistory: [{ id: "pay-1", status: "FAILED", amountCents: "500", merchantOrderNo: "merchant-1", providerTransactionId: null, financeEventId: null, ledgerEntryRef: null }, { id: "pay-2", status: "CONFIRMED", amountCents: "500", merchantOrderNo: "merchant-2", providerTransactionId: "provider-2", financeEventId: "event-2", ledgerEntryRef: "line-2" }], refundHistory: [{ id: "refund-1", paymentId: "pay-2", status: "FAILED", amountCents: "500", providerRefundId: null, financeEventId: null, ledgerEntryRef: null }, { id: "refund-2", paymentId: "pay-2", status: "UNKNOWN", amountCents: "500", providerRefundId: null, financeEventId: null, ledgerEntryRef: null }] }] };
const permissions = ["credit.read", "credit.decide", "credit.guarantee.read", "credit.guarantee.manage"];

function loadComponent() {
  const file = path.join(tree, "apps/admin/src/views/user-directory/credit-panel.tsx");
  const module = new Module(file); module.filename = file; module.paths = Module._nodeModulePaths(path.dirname(file));
  const native = module.require.bind(module);
  module.require = (name) => {
    if (name === "@/components/ui/button") return { Button };
    if (name === "@/components/ui/input") return { Input };
    if (name === "@/components/ui/badge") return { Badge };
    if (name === "@/api") return { AdminApiError };
    if (name === "./user-directory-data") return { CREDIT_GUARANTEE_PERMISSION: { read: "credit.guarantee.read", manage: "credit.guarantee.manage" }, PERMISSION: { credit: "credit.read", creditDecide: "credit.decide" } };
    if (name === "./user-directory-shared") return { Message: ({ children, title }) => React.createElement("div", { role: "status" }, title, children), errorText: (error) => error?.message ?? "error", time: (value) => value, useDirectoryRequest: () => ({ result: { state: "ready", data }, retry: () => {} }) };
    return native(name);
  };
  module._compile(typescript.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  return module.exports.CreditPanel;
}

function storage(throws = false) { const values = new Map(); globalThis.sessionStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { if (throws) throw Error("STORAGE_DENIED"); values.set(key, value); }, removeItem: (key) => values.delete(key) }; return values; }
async function render(adapter, user) {
  const browser = new Window({ url: "http://127.0.0.1:4291/users/user-A" }); Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const host = browser.document.createElement("div"); browser.document.body.append(host); const root = requireFromTree("react-dom/client").createRoot(host); const CreditPanel = loadComponent();
  await React.act(async () => root.render(React.createElement(CreditPanel, { adapter, user, refreshNonce: 0 }))); await new Promise(setImmediate); return { browser, host, root, component: CreditPanel };
}
async function fill(element, value) { Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? element.ownerDocument.defaultView.HTMLTextAreaElement.prototype : element.ownerDocument.defaultView.HTMLInputElement.prototype, "value").set.call(element, value); await React.act(async () => element.dispatchEvent(new element.ownerDocument.defaultView.Event("input", { bubbles: true }))); }
function adapter({ readbackFails = false } = {}) { let readback = readbackFails; const calls = { decide: 0, read: 0 }; return { calls, snapshot: { adminUserId: "admin-A", session: { id: "session-A" } }, has: (permission) => permissions.includes(permission), hasCreditGuaranteeRead: () => true, hasCreditGuaranteeManage: () => true, credit: async () => { calls.read += 1; if (readback) { readback = false; throw new Error("READBACK_UNKNOWN"); } return data; }, creditDecide: async () => { calls.decide += 1; return {}; } }; }

test("CreditPanel storage failure refuses the POST", async () => {
  storage(true); const a = adapter(); const mounted = await render(a, { id: "user-A", name: "用户" });
  try { await fill(mounted.host.querySelector('input[placeholder="订单或账号 ID"]'), "account-A"); await fill(mounted.host.querySelectorAll("textarea")[0], "用户可见原因"); await fill(mounted.host.querySelectorAll("textarea")[1], "内部依据"); const button = [...mounted.host.querySelectorAll("button")].find((item) => item.textContent.includes("确认扣 10 分")); await React.act(async () => button.click()); await new Promise(setImmediate); assert.equal(a.calls.decide, 0); assert.match(mounted.host.textContent, /无法保存原操作意图/); } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("CreditPanel keeps accepted readback phase across remount without replaying POST", async () => {
  storage(false); const a = adapter({ readbackFails: true }); let mounted = await render(a, { id: "user-A", name: "用户" });
  await fill(mounted.host.querySelector('input[placeholder="订单或账号 ID"]'), "account-A"); await fill(mounted.host.querySelectorAll("textarea")[0], "用户可见原因"); await fill(mounted.host.querySelectorAll("textarea")[1], "内部依据"); const button = [...mounted.host.querySelectorAll("button")].find((item) => item.textContent.includes("确认扣 10 分")); await React.act(async () => button.click()); await new Promise(setImmediate); assert.equal(a.calls.decide, 1); await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort();
  mounted = await render(a, { id: "user-A", name: "用户" }); try { const reread = [...mounted.host.querySelectorAll("button")].find((item) => item.textContent.includes("重新读取")); assert.ok(reread); await React.act(async () => reread.click()); await new Promise(setImmediate); assert.equal(a.calls.decide, 1); } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("CreditPanel late A accepted phase cannot overwrite newer B intent", async () => {
  const values = storage(false); const a = adapter(); const queue = []; a.creditDecide = () => new Promise((resolve, reject) => queue.push({ resolve, reject })); const mounted = await render(a, { id: "user-A", name: "用户" });
  const secondHost = mounted.browser.document.createElement("div"); mounted.browser.document.body.append(secondHost); const secondRoot = requireFromTree("react-dom/client").createRoot(secondHost);
  try {
    await React.act(async () => secondRoot.render(React.createElement(mounted.component, { adapter: a, user: { id: "user-A", name: "用户" }, refreshNonce: 0 })));
    const fillPanel = async (host, prefix) => { await fill(host.querySelector('input[placeholder="订单或账号 ID"]'), prefix); await fill(host.querySelectorAll("textarea")[0], `${prefix} visible`); await fill(host.querySelectorAll("textarea")[1], `${prefix} internal`); };
    await fillPanel(mounted.host, "A"); await fillPanel(secondHost, "B");
    const buttonA = [...mounted.host.querySelectorAll("button")].find((item) => item.textContent.includes("确认扣 10 分")); const buttonB = [...secondHost.querySelectorAll("button")].find((item) => item.textContent.includes("确认扣 10 分"));
    await React.act(async () => buttonA.click()); await React.act(async () => buttonB.click()); assert.equal(queue.length, 2); const keyB = JSON.parse([...values.values()][0]).key;
    await React.act(async () => { queue[0].resolve({}); queue[1].reject(new AdminApiError(0, "B_UNKNOWN")); await new Promise((resolve) => setTimeout(resolve, 20)); }); assert.equal(JSON.parse([...values.values()][0]).key, keyB);
  } finally { await React.act(async () => { secondRoot.unmount(); mounted.root.unmount(); }); secondHost.remove(); await mounted.browser.happyDOM.abort(); }
});

test("CreditPanel renders every payment and refund attempt", async () => {
  storage(false); const mounted = await render(adapter(), { id: "user-A", name: "用户" });
  try {
    assert.match(mounted.host.textContent, /支付尝试 2 笔/);
    assert.match(mounted.host.textContent, /退款尝试 2 笔/);
    assert.match(mounted.host.textContent, /merchant-1/);
    assert.match(mounted.host.textContent, /refund-2/);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});
