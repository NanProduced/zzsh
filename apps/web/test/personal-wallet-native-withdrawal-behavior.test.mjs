import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire, Module } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(`${tree}/package.json`);
const React = require("react");
const { Window } = require("happy-dom");
const ts = require("typescript");
const client = require(`${tree}/apps/web/src/lib/personal-wallet-client.ts`);
const at = "2026-10-03T02:31:22.516000Z";
const money = amountCents => ({ currency: "CNY", unit: "cent", knowledge: amountCents === null ? "UNKNOWN" : "KNOWN", amountCents });
const wallet = (snapshotVersion = "snapshot_1", nativeWithdrawal) => ({ subjectId: "user_A", contractVersion: "personal-finance.read.v1", asOf: at, snapshotVersion, coverage: { knowledge: "KNOWN", origin: "RECONCILED_OPENING", coverageVersion: "1" }, ledgerRevision: "1", readRevision: snapshotVersion === "snapshot_1" ? "1" : "2", buckets: { available: money("123456"), reserved: money(null), restricted: money(null), pendingEarnings: money(null), refundPayable: money(null) }, withdrawable: { ...money(null), reasonCodes: ["POLICY_NOT_CONFIRMED"] }, nativeWithdrawal });
const nativeDebt = (amount = "312") => ({ scope: "NATIVE_REFERRAL_OBLIGATIONS_ONLY", subjectInScope: true, globalWithdrawable: "UNKNOWN", reservationState: amount === "0" ? "REQUIRES_CURRENT_QUOTE" : "BLOCKED_BY_RECOVERY", recovery: { knowledge: "KNOWN", outstandingCents: amount, earningCount: amount === "0" ? "0" : "1", scope: "NATIVE_REFERRAL_OBLIGATIONS_ONLY" } });
const localScope = nativeWithdrawal => ({ scope: "LOCAL_CONTROLLED", subjectId: "user_A", coverage: { knowledge: "KNOWN", meaning: "EXPLICIT_LOCAL_INTENTS_ONLY_NOT_TOTAL_HISTORICAL_WALLET", cohorts: [{ id: "cohort", revision: "1", start: at, end: "2026-10-05T00:00:00Z" }] }, nativeWithdrawal, items: [], destinations: [{ id: "bank", kind: "BANK_CARD", mask: "local bank", policyVersion: "server_policy", perIntentCents: "200", canQuote: true }], totals: { reservedCents: "0", payoutCents: "0", feeCents: "0" }, globalReserved: "UNKNOWN" });
const reply = (body, status = 200) => Response.json(body, { status });
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };
const compiled = ts.transpileModule(readFileSync(`${tree}/apps/web/src/components/account/controlled-withdrawal.tsx`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

async function probe(fetcher) {
  const window = new Window({ url: "http://127.0.0.1:4200/account?view=wallet" });
  Object.assign(globalThis, { window, localStorage: window.localStorage, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent, DOMException: window.DOMException, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  const session = { status: "authenticated", userId: "user_A", identityVersion: 1, revalidate() {} };
  const store = { getSnapshot: () => session };
  const module = new Module(`${tree}/wallet-withdrawal-probe.cjs`);
  module.filename = `${tree}/wallet-withdrawal-probe.cjs`;
  module.paths = Module._nodeModulePaths(tree);
  module.require = name => {
    if (name === "@/components/session/user-session-provider") return { useUserSession: () => session, useUserSessionStore: () => store };
    if (name === "@/lib/personal-wallet-client") return client;
    if (name === "@/lib/controlled-withdrawal-client") return require(`${tree}/apps/web/src/lib/controlled-withdrawal-client.ts`);
    if (name === "next/link") return props => React.createElement("a", props);
    return require(name);
  };
  module._compile(compiled, module.filename);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  const settle = async () => { for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise(setImmediate); }); };
  return {
    host,
    settle,
    async render(value) { await React.act(async () => root.render(React.createElement(module.exports.ControlledWithdrawal, { wallet: value, scope: "user_A:1", onWalletChanged() {} }))); await settle(); },
    async fill(selector, value) { const target = host.querySelector(selector); assert(target); const proto = target.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await React.act(async () => { Object.getOwnPropertyDescriptor(proto, "value").set.call(target, value); target.dispatchEvent(new window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); await settle(); },
    async click(selector) { const target = host.querySelector(selector); assert(target); await React.act(async () => { target.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise(setImmediate); }); await settle(); },
    async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); globalThis.fetch = previousFetch; }
  };
}

test("read-only wallet revision change reloads eligibility and invalidates a late old quote", async () => {
  let debt = false, scopeReads = 0;
  const late = deferred();
  const p = await probe(async url => { if (String(url).endsWith("/quote")) return late.promise; scopeReads++; return reply(localScope(debt ? nativeDebt() : nativeDebt("0"))); });
  try {
    await p.render(wallet("snapshot_1", nativeDebt("0")));
    await p.fill("#withdraw-destination", "bank"); await p.fill("#withdraw-amount", "2"); await p.click("button[type=submit]");
    debt = true;
    await p.render(wallet("snapshot_2", nativeDebt()));
    late.resolve(reply({ quote: { scope: "LOCAL_CONTROLLED", userId: "user_A", destinationId: "bank", destination: { id: "bank", mask: "local bank" }, policyVersion: "server_policy", ledgerRevision: "1", acceptedAt: at, grossCents: "200", netCents: "100", feeCents: "100", requestKey: "old-key", globalWithdrawable: "UNKNOWN", identityMeaning: "EXPLICIT_LOCAL_TEST_ADMISSION_NOT_REAL_KYC" } }));
    await p.settle();
    assert(scopeReads >= 2); assert.match(p.host.textContent, /邀请收益待追回/); assert.equal(p.host.querySelector(".wallet-withdraw-quote"), null); assert(p.host.querySelector("button[type=submit]").disabled);
  } finally { late.resolve(reply({})); await p.close(); }
});

test("native debt parser rejects contradictory eligibility and unknown zero", () => {
  assert.equal(client.parseNativeReservation(undefined), undefined);
  assert.equal(client.parseNativeReservation(nativeDebt()).recovery.outstandingCents, "312");
  assert.throws(() => client.parseNativeReservation({ ...nativeDebt(), reservationState: "REQUIRES_CURRENT_QUOTE" }));
  assert.throws(() => client.parseNativeReservation({ ...nativeDebt(), recovery: { knowledge: "UNKNOWN", outstandingCents: "0", earningCount: "0", reason: "missing" } }));
});

test("debt blocks new actions but preserves original receipt recovery and available balance", async () => {
  const methods = [];
  const p = await probe(async (url, options) => { methods.push(options?.method ?? "GET"); return reply(String(url).includes("/withdrawals") ? localScope(nativeDebt()) : { wallet: wallet("snapshot_1", nativeDebt()) }); });
  try {
    localStorage.setItem("zzsh.withdrawal.pending.v1:user_A", JSON.stringify({ version: 1, userId: "user_A", key: "original", body: { amountCents: "200", destinationId: "bank", policyVersion: "policy", expectedWalletVersion: "1" } }));
    await p.render(wallet("snapshot_1", nativeDebt()));
    assert.match(p.host.textContent, /¥3\.12.*邀请收益待追回/); assert.match(p.host.textContent, /¥1,234\.56/); assert(p.host.querySelector("button[type=submit]").disabled);
    const recover = [...p.host.querySelectorAll("button")].find(button => button.textContent === "查询原申请"); assert(recover); assert.equal(recover.disabled, false); assert(methods.every(method => method === "GET"));
  } finally { await p.close(); }
});
