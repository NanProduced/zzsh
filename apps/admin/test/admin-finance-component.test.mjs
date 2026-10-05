import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const baseSnapshot = { authenticated: true, adminUserId: "finance-test", user: { name: "读取员", username: "FINANCE", twoFactorEnabled: true }, security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false }, session: { id: "finance-session", locked: false, pinConfigured: true, createdAt: null, expiresAt: null }, permissions: ["finance.read", "finance.document.read"] };
const document = { ref: "WITHDRAWAL:w1", number: "申请一", kind: "WITHDRAWAL", state: "UNKNOWN", occurredAt: "2026-10-03T01:00:00Z", requestedAmountCents: "20000", subjects: [{ id: "u1", name: "用户一" }], entryCount: 2, amounts: [] };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body });
function payload(url, extra = {}) {
  const q = new URL(url, "http://localhost").searchParams;
  return { contractVersion: "admin-finance.read.v1", applied: { scope: q.get("scope") ?? "ALL", from: q.get("from"), to: q.get("to"), period: q.get("period") === "1", bucket: q.get("bucket") ?? "ALL", kind: q.get("kind") ?? "ALL", state: q.get("state") ?? "ALL", q: q.get("q") ?? "" }, snapshot: "test-snapshot", asOf: "2026-10-03T10:00:00Z", contextKey: "test-access", snapshotVersion: "test-version", documents: [document], documentCount: 1, entryCount: 2, page: 1, pageSize: 20, hasMore: false, ...extra };
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await settle(); } throw Error("Finance component condition timed out"); }
async function setup(t, key, tabPath = "/finance", permissions = ["finance.read", "finance.document.read"]) {
  const browser = new Window({ url: "http://127.0.0.1:4311" + tabPath });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Node: browser.Node, Event: browser.Event, CSS: browser.CSS, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const vite = await createServer({ configFile: false, root: tree, cacheDir: "E:/zzsh/zzsh/tmp/admin-finance-read-20261003/implementation/component-vite-cache", plugins: [react()], server: { middlewareMode: true, hmr: false } });
  const { AdminFinanceView, clearFinanceContexts } = await vite.ssrLoadModule("/apps/admin/src/views/admin-finance-view.tsx");
  const node = browser.document.createElement("div"); browser.document.body.append(node); const root = createRoot(node);
  const opened = [], queries = [], props = { tab: { id: key, path: tabPath, kind: "unknown", title: "资金", query: {}, closable: true }, snapshot: { ...baseSnapshot, adminUserId: key, session: { ...baseSnapshot.session, id: key }, permissions }, onOpenPath: (...args) => opened.push(args), onQueryChange: query => queries.push(query), onRefresh: async () => props.snapshot, refreshNonce: 0 };
  const render = async () => act(async () => root.render(createElement(AdminFinanceView, props)));
  t.after(async () => { clearFinanceContexts(); await act(async () => root.unmount()); await vite.close(); browser.happyDOM.abort(); });
  return { props, node, render, opened, queries, browser };
}
test("document-only initial view asks for a reference without querying bulk data", async t => {
  let requests = 0; globalThis.fetch = async () => { requests++; throw Error("bulk lookup forbidden"); };
  const ui = await setup(t, "doc-only", "/finance", ["finance.document.read"]); await ui.render(); await settle();
  assert.equal(requests, 0); assert.match(ui.node.textContent, /输入单据编号或用户线索/); assert.doesNotMatch(ui.node.textContent, /正在读取/);
});
test("unapplied text leaves old result scope, apply discards it and late old response cannot repaint", async t => {
  let releaseOld; let count = 0;
  globalThis.fetch = async url => { count++; if (count === 1) return new Promise(resolve => { releaseOld = () => resolve(response(payload(url, { documents: [{ ...document, number: "OLD_PRIVATE" }] }))); }); return response(payload(url, { documents: [{ ...document, number: "新单据" }] })); };
  const ui = await setup(t, "late-response"); await ui.render();
  const input = ui.node.querySelector("#finance-lookup");
  await act(async () => { Object.getOwnPropertyDescriptor(ui.browser.HTMLInputElement.prototype, "value").set.call(input, "w1"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.match(ui.node.textContent, /尚未应用/);
  await act(async () => ui.node.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await until(() => ui.node.textContent.includes("新单据"));
  await act(async () => releaseOld()); await settle();
  assert.doesNotMatch(ui.node.textContent, /OLD_PRIVATE/); assert.equal(ui.queries.at(-1).q, "w1");
});
test("permission change hides private document immediately and clears old summary/context", async t => {
  globalThis.fetch = async url => response(payload(url, { document, entries: [], evidence: { grossCents: "20000", intentId: "PRIVATE_INTENT" }, reasonCodes: [], related: [] }));
  const ui = await setup(t, "permission-change", "/finance/documents/WITHDRAWAL%3Aw1"); await ui.render(); await until(() => ui.node.textContent.includes("PRIVATE_INTENT"));
  ui.props.snapshot = { ...ui.props.snapshot, permissions: [] }; await ui.render();
  assert.doesNotMatch(ui.node.textContent, /PRIVATE_INTENT|申请一|200.00/); assert.match(ui.node.textContent, /没有该项资金读取能力/); assert.equal(ui.node.querySelector("textarea"), null);
});
test("empty and source failure are distinct; snapshot conflict clears old results/export", async t => {
  let mode = "ready";
  globalThis.fetch = async url => mode === "ready" ? response(payload(url, { entries: [], reconciliation: [], gaps: [] })) : response({ error: { code: "CONFLICT", requestId: "r-stale" } }, 409);
  const ui = await setup(t, "stale", "/finance/period"); await ui.render(); await until(() => ui.node.textContent.includes("没有资金分录"));
  mode = "stale"; ui.props.refreshNonce++; await ui.render(); await until(() => ui.node.textContent.includes("本批数据已变化"));
  assert.doesNotMatch(ui.node.textContent, /该生效范围没有资金分录/);
  assert.equal([...ui.node.querySelectorAll("button")].find(button => button.textContent.includes("导出完整明细")).disabled, true);
});
test("candidate enters stable source-typed independent object with original query/entry context", async t => {
  globalThis.fetch = async url => response(payload(url));
  const ui = await setup(t, "navigation"); ui.props.tab.query = { q: "w1" }; await ui.render(); await until(() => ui.node.textContent.includes("申请一"));
  await act(async () => [...ui.node.querySelectorAll("button")].find(button => button.textContent.includes("申请一")).click());
  const link = ui.opened.at(-1)[0]; assert.match(link, /^\/finance\/documents\/WITHDRAWAL%3Aw1\?/); assert.equal(new URL(link, "http://localhost").searchParams.get("q"), "w1"); assert.ok(new URL(link, "http://localhost").searchParams.get("origin"));
});
test("same tab external scope A to B replaces applied/draft/page and never keeps A money", async t => {
  const requested=[];globalThis.fetch=async url=>{const q=new URL(url,"http://localhost").searchParams;requested.push(q.get("scope"));return response(payload(url,{entries:[],reconciliation:[],gaps:[],subject:{id:q.get("scope"),name:q.get("scope")}}));};
  const ui=await setup(t,"external-scope","/finance/period");ui.props.tab.query={scope:"userA"};await ui.render();await until(()=>ui.node.textContent.includes("主体 userA"));
  ui.props.tab={...ui.props.tab,query:{scope:"userB",page:"1"}};await ui.render();await until(()=>ui.node.textContent.includes("主体 userB"));
  assert.equal(requested.at(-1),"userB");assert.equal(ui.node.querySelector('input[aria-label="主体"]').value,"userB");assert.doesNotMatch(ui.node.textContent,/主体 userA/);
});
test("external history A-B-A-B cancels late A and an unapplied draft does not query", async t => {
  const requested=[];let releaseA;globalThis.fetch=async url=>{const q=new URL(url,"http://localhost").searchParams;requested.push({scope:q.get("scope"),snapshot:q.get("snapshot")});if(requested.length===1)return new Promise(resolve=>{releaseA=()=>resolve(response(payload(url,{entries:[],reconciliation:[],gaps:[],document:{...document,number:"LATE_A"}})));});return response(payload(url,{entries:[],reconciliation:[],gaps:[]}));};
  const ui=await setup(t,"history-scope","/finance/period");ui.props.tab.query={scope:"userA"};await ui.render();await until(()=>requested.length===1);
  ui.props.tab={...ui.props.tab,query:{scope:"userB"}};await ui.render();await until(()=>ui.node.textContent.includes("主体 userB"));
  await act(async()=>releaseA());await settle();assert.doesNotMatch(ui.node.textContent,/LATE_A|主体 userA/);assert.equal(requested.at(-1).snapshot,null);
  const before=requested.length,input=ui.node.querySelector('input[aria-label="主体"]');await act(async()=>{Object.getOwnPropertyDescriptor(ui.browser.HTMLInputElement.prototype,"value").set.call(input,"draftC");input.dispatchEvent(new Event("input",{bubbles:true}));});await settle();assert.equal(requested.length,before);assert.match(ui.node.textContent,/尚未应用/);
  for(const scope of ["userA","userB"]){ui.browser.history.pushState(null,"",`/finance/period?scope=${scope}`);ui.browser.dispatchEvent(new ui.browser.PopStateEvent("popstate"));ui.props.tab={...ui.props.tab,query:{scope}};await ui.render();await until(()=>ui.node.textContent.includes("主体 "+scope));assert.equal(ui.node.querySelector('input[aria-label="主体"]').value,scope);}
});
