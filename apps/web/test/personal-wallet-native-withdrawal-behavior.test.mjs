import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire, Module } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadInformation } from "./information-module.mjs";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(`${tree}/package.json`);
const React = require("react");
const { Window } = require("happy-dom");
const ts = require("typescript");
const client = require(`${tree}/apps/web/src/lib/personal-wallet-client.ts`);
const information = loadInformation();
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
  const session = { status: "authenticated", userId: "user_A", identityVersion: 1, revalidations: 0, revalidate() { this.revalidations++; } };
  const store = { getSnapshot: () => session };
  const module = new Module(`${tree}/wallet-withdrawal-probe.cjs`);
  module.filename = `${tree}/wallet-withdrawal-probe.cjs`;
  module.paths = Module._nodeModulePaths(tree);
  module.require = name => {
    if (name === "@/components/session/user-session-provider") return { useUserSession: () => session, useUserSessionStore: () => store };
    if (name === "@/lib/personal-wallet-client") return client;
    if (name === "@/lib/controlled-withdrawal-client") return require(`${tree}/apps/web/src/lib/controlled-withdrawal-client.ts`);
    if (name === "@/components/ui/information") return information;
    if (name === "next/link") return props => React.createElement("a", props);
    return require(name);
  };
  module._compile(compiled, module.filename);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  const settle = async () => { for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise(setImmediate); }); };
  const commits = [];
  function StableProbe({value}) {
    const scope = `${session.userId}:${session.identityVersion}`;
    React.useLayoutEffect(() => { commits.push({scope, detail:host.querySelector('[aria-label="历史提现记录详情"]')?.textContent??''}); });
    return React.createElement(module.exports.ControlledWithdrawal,{wallet:value,scope,onWalletChanged(){}});
  }
  return {
    host,
    session,
    commits,
    settle,
    async render(value) { await React.act(async () => root.render(React.createElement(StableProbe, { value }))); await settle(); },
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

const historyItem={id:'history:obs_A',source:'HISTORICAL_WITHDRAWAL',sourceReference:{type:'LEGACY_MYSQL',system:'restore',entity:'la_withdraw_apply',id:'PRIVATE_HISTORY_A'},sourceStatus:2,amountCents:'10000',netCents:'9900',feeCents:'100',occurredAt:at,importedAt:at,sourceDigest:'a'.repeat(64),includedInOpening:false,accountingEffect:'OBSERVATION_ONLY_NO_NEW_DEBIT',channelArrivalKnowledge:'UNKNOWN'};
const historyRead=(user='user_A',items=[historyItem])=>({contractVersion:'personal-withdrawals.read.v1',subjectId:user,source:'ALL',state:'ALL',historical:{source:'HISTORICAL_WITHDRAWAL',availability:items.length?'AVAILABLE':'NOT_IMPORTED',coverage:{knowledge:'UNKNOWN',reason:'HISTORICAL_WITHDRAWAL_COVERAGE_NOT_CLOSED'},items,mappedRecordCount:String(items.length),count:null,asOf:at,snapshotVersion:'history-v1',nextCursor:null},controlled:{availability:'NOT_ADMITTED',reason:'CONTROLLED_RESOURCE_NOT_ADMITTED',data:null}});
test('history remains readable without a wallet, keeps the raw source status and never enables a withdrawal form',async()=>{
 let posts=0;const p=await probe(async(_url,options)=>{if(options.method==='POST')posts++;return reply(historyRead());});
 try{await p.render(null);assert.match(p.host.querySelector('[data-testid="historical-withdrawals"]').textContent,/旧系统状态码 2|¥100\.00/);assert.doesNotMatch(p.host.textContent,/到账成功/);assert.equal(p.host.querySelector('.wallet-withdraw-form'),null);assert.equal(posts,0);assert.match(p.host.textContent,/渠道到账尚未核验/);}
 finally{await p.close();}
});
test('new identity render cannot expose the old history detail before passive effects clear it',async()=>{
 const late=deferred();let phase='A';const p=await probe(async url=>phase==='B'?late.promise:reply(String(url).includes('history%3A')?{contractVersion:'personal-withdrawals.read.v1',subjectId:'user_A',source:'HISTORICAL_WITHDRAWAL',item:historyItem}:historyRead()));
 try{await p.render(null);await p.click('[data-testid="historical-withdrawals"] .wallet-withdraw-record button');assert.match(p.host.querySelector('[aria-label="历史提现记录详情"]').textContent,/PRIVATE_HISTORY_A/);phase='B';p.session.userId='user_B';p.session.identityVersion=2;const mark=p.commits.length;await p.render(null);const firstB=p.commits.slice(mark).find(commit=>commit.scope==='user_B:2');assert(firstB,'new-scope layout commit was observed');assert.doesNotMatch(firstB.detail,/PRIVATE_HISTORY_A/);late.resolve(reply(historyRead('user_B',[])));await p.settle();assert.doesNotMatch(p.host.textContent,/PRIVATE_HISTORY_A/);}
 finally{late.resolve(reply(historyRead('user_B',[])));await p.close();}
});
test('revoked history detail clears prior private projection and does not retry a business command',async()=>{
 let deny=false,posts=0;const p=await probe(async(url,options)=>{if(options.method==='POST')posts++;if(String(url).includes('history%3A'))return deny?reply({error:{code:'UNAUTHENTICATED'}},401):reply({contractVersion:'personal-withdrawals.read.v1',subjectId:'user_A',source:'HISTORICAL_WITHDRAWAL',item:historyItem});return reply(historyRead());});
 try{await p.render(null);await p.click('[data-testid="historical-withdrawals"] .wallet-withdraw-record button');assert.match(p.host.textContent,/PRIVATE_HISTORY_A/);deny=true;await p.click('[data-testid="historical-withdrawals"] .wallet-withdraw-record button');assert.doesNotMatch(p.host.textContent,/PRIVATE_HISTORY_A/);assert.equal(p.session.revalidations,1);assert.equal(posts,0);}
 finally{await p.close();}
});
test('unreadable original marker blocks new actions without hiding readable history or rewriting the marker',async()=>{let gets=0,posts=0;const p=await probe(async(_url,options)=>{if(options.method==='POST')posts++;else gets++;return reply(historyRead());});try{localStorage.setItem('zzsh.withdrawal.pending.v1:user_A','bad original marker');await p.render(null);assert(gets>0);assert.match(p.host.querySelector('[data-testid="historical-withdrawals"]').textContent,/旧系统状态码 2/);assert.match(p.host.textContent,/原申请结果待确认/);assert.equal(localStorage.getItem('zzsh.withdrawal.pending.v1:user_A'),'bad original marker');assert.equal(posts,0);}finally{await p.close();}});

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

test("R2: the amount field's helper is actually bound to the control it explains", async () => {
  const p = await probe(async () => reply(localScope(nativeDebt("0"))));
  try {
    await p.render(wallet("snapshot_1", nativeDebt("0")));
    const input = p.host.querySelector("#withdraw-amount");
    assert(input, "#withdraw-amount 必须渲染");
    const label = p.host.querySelector('label[for="withdraw-amount"]');
    assert(label, "金额字段必须有 for 指向控件的 label");
    const describedBy = input.getAttribute("aria-describedby");
    assert(describedBy, "金额控件必须有 aria-describedby");
    const ids = describedBy.split(/\s+/).filter(Boolean);
    assert(ids.length >= 1, "aria-describedby 不能为空");
    const targets = ids.map(id => p.host.querySelector(`[id="${id}"]`));
    assert(targets.every(Boolean), "aria-describedby 必须指向真实存在的元素");
    assert(targets.some(node => /当前可用余额/.test(node.textContent || "")), "说明必须包含余额口径");
    assert(targets.some(node => node.textContent.includes("本轮每笔准入")), "说明必须包含每笔准入");
    // 没有说明的目标字段不应留下悬空引用。
    const destination = p.host.querySelector("#withdraw-destination");
    assert(destination, "#withdraw-destination 必须渲染");
    assert.equal(destination.getAttribute("aria-describedby"), null);
  } finally { await p.close(); }
});
