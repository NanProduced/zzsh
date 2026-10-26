import assert from "node:assert/strict";
import { after, test } from "node:test";
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
let sharedVite;
after(async()=>{await sharedVite?.close();});
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await settle(); } throw Error("Finance component condition timed out"); }
async function setup(t, key, tabPath = "/finance", permissions = ["finance.read", "finance.document.read"]) {
  const browser = new Window({ url: "http://127.0.0.1:4311" + tabPath });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, CSS: browser.CSS, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const vite = sharedVite ??= await createServer({ configFile: false, resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, root: tree, cacheDir: path.resolve(tree, "tmp/admin-test-cache/admin-finance"), plugins: [react()], optimizeDeps:{noDiscovery:true,include:[]}, server: { middlewareMode: true, hmr: false, ws:false, watch:null } });
  const { AdminFinanceView, clearFinanceContexts, registerFinanceOrigin, financeOriginPath, financeContextIdentity } = await vite.ssrLoadModule("/apps/admin/src/views/admin-finance-view.tsx");
  const formats=await vite.ssrLoadModule('/apps/admin/src/views/admin-finance-api.ts');
  const node = browser.document.createElement("div"); browser.document.body.append(node); const root = createRoot(node);
  const opened = [], queries = [], props = { tab: { id: key, path: tabPath, kind: "unknown", title: "资金", query: {}, closable: true }, snapshot: { ...baseSnapshot, adminUserId: key, session: { ...baseSnapshot.session, id: key }, permissions }, onOpenPath: (...args) => opened.push(args), onQueryChange: query => queries.push(query), onRefresh: async () => props.snapshot, refreshNonce: 0 };
  const render = async () => act(async () => root.render(createElement(AdminFinanceView, props)));
  t.after(async () => { clearFinanceContexts(); await act(async () => root.unmount()); browser.happyDOM.abort(); });
  return { props, node, render, opened, queries, browser, formats, registerFinanceOrigin, financeOriginPath, financeContextIdentity, clearFinanceContexts };
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
  const ui = await setup(t, "permission-change", "/finance/documents/WITHDRAWAL%3Aw1"); await ui.render(); await until(() => ui.node.textContent.includes("技术引用与原始字段")); await act(async()=>[...ui.node.querySelectorAll("button")].find(button=>button.textContent.includes("技术引用与原始字段")).click()); await until(()=>ui.node.textContent.includes("PRIVATE_INTENT"));
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

test('historical balance proof stays unknown beside known ledger flow and proved zero stays zero',async t=>{
  const row={bucket:'AVAILABLE',openingBalance:'0',knownInflows:'18000',knownOutflows:'0',migrationMovement:'0',closingBalance:'18000',difference:'0',ledgerOpeningBalance:'0',ledgerClosingBalance:'18000',ledgerDifference:'0',knowledge:'UNKNOWN',balanceBasis:{knowledge:'UNKNOWN',origin:null,sourceCutoff:null,openingPostedAt:null,reasonCodes:['PERIOD_BALANCE_PROOF_NOT_AVAILABLE']},reasonCodes:[],unknownCount:0,unknownTimeCount:0,coveredHistoricalCount:45,uncoveredHistoricalCount:0};
  globalThis.fetch=async url=>response(payload(url,{entries:[],gaps:[],reconciliation:[row,{...row,bucket:'RESERVED',knownInflows:'0',closingBalance:'0',knowledge:'KNOWN',balanceBasis:{...row.balanceBasis,knowledge:'KNOWN',origin:'NATIVE_GENESIS'}}]}));
  const ui=await setup(t,'honest-balances','/finance/period');await ui.render();await until(()=>ui.node.textContent.includes('部分期间余额尚未核定'));
  const rows=[...ui.node.querySelectorAll('tbody tr')];assert.match(rows[0].textContent,/余额未核定/);assert.equal(rows[0].children[1].textContent,'未核定');assert.match(rows[0].children[2].textContent,/180\.00/);assert.equal(rows[0].children[4].textContent,'未核定');assert.equal(rows[0].children[5].textContent,'未核定');
  assert.equal(rows[1].children[1].textContent,'0.00 元');assert.equal(rows[1].children[5].textContent,'0.00 元');assert.match(ui.node.textContent,/单次最多367天/);
});
test('withdrawal document shows only application, fee, payable, target/source and never upgrades local success to bank arrival', async t => {
  const entry = { id: 'w-entry', documentRef: 'WITHDRAWAL:w1', documentNumber: '申请一', subjectId: 'u1', subjectName: '用户一', bucket: 'RESERVED', direction: 'OUT', deltaCents: '-20000', knowledge: 'KNOWN', kind: 'WITHDRAWAL', state: 'SUCCEEDED', classification: 'POSTED', occurredAt: '2026-10-03T01:00:00Z', evidence: {}, reasonCodes: [], sourceType: 'LOCAL_CONTROLLED', sourceSystem: 'zzsh_order', sourceEntity: 'withdrawal_intent', sourceId: 'internal-intent-id' };
  const evidence = { grossCents: '20000', feeCents: '400', netCents: '19600', channelState: 'SUCCEEDED', channelReference: 'LOCAL-REF-1', fundsDisposition: 'PAYOUT_POSTED', acceptedAt: '2026-10-03T01:00:00Z', queriedAt: '2026-10-03T02:00:00Z', refundDueAt: '2026-10-09T00:00:00Z', settlementVersionId: 'internal-settlement-id' };
  globalThis.fetch = async url => response(payload(url, { document: { ...document, state: 'SUCCEEDED' }, entries: [entry], evidence, related: [], reasonCodes: [] }));
  const ui = await setup(t, 'withdrawal-detail', '/finance/documents/WITHDRAWAL%3Aw1'); await ui.render();
  await until(() => ui.node.querySelector('[data-withdrawal-evidence]'));
  const card = ui.node.querySelector('[data-withdrawal-evidence]');
  assert.match(card.textContent, /申请扣减额[\s\S]*200\.00 元/);
  assert.match(card.textContent, /用户政策费[\s\S]*4\.00 元/);
  assert.match(card.textContent, /应出款额[\s\S]*196\.00 元/);
  assert.match(card.textContent, /渠道费[\s\S]*未取得/);
  assert.match(card.textContent, /原出款目标[\s\S]*未取得/);
  assert.match(card.textContent, /渠道结果[\s\S]*本地受控成功（非银行到账）/);
  assert.match(card.textContent, /LOCAL_CONTROLLED\/zzsh_order\/withdrawal_intent/);
  assert.equal(card.textContent.includes('退款责任到期'), false);
  assert.equal(card.textContent.includes('原入账基数'), false);
  assert.equal(card.textContent.includes('internal-settlement-id'), false);
  assert.match(card.textContent, /本地受控成功、SUCCEEDED 或出款已记录都不是银行到账/);
});
test('CHAIN a cancelled unpaid order document is named as an unsettled original, not an order settlement', async t => {
  const cancelled = { ...document, ref: 'ORDER:order_cancelled', number: 'ORDER-CANCELLED', kind: 'SETTLEMENT', state: 'CANCELLED', subjects: [{ id: 'u1', name: '用户一' }] };
  globalThis.fetch = async url => response(payload(url, { document: cancelled, entries: [], evidence: {}, related: [], reasonCodes: [] }));
  const ui = await setup(t, 'cancelled-order', '/finance/documents/ORDER%3Aorder_cancelled'); await ui.render();
  await until(() => ui.node.textContent.includes('订单原单（未结算）'));
  assert.equal(ui.node.textContent.includes('订单结算'), false);
  assert.match(ui.node.textContent, /ORDER-CANCELLED/);
});
test('business candidates show server bucket facts and subject scope without computing a grand total',async t=>{
  globalThis.fetch=async url=>response(payload(url,{documents:[{...document,kind:'SETTLEMENT',state:'POSTED',requestedAmountCents:null,summaryScope:'SUBJECT',subjectEntryCount:1,documentEntryCount:null,amounts:[{bucket:'AVAILABLE',knownNetCents:'9000',unknownCount:0},{bucket:'REFUND_PAYABLE',knownNetCents:'0',unknownCount:1}]}]}));
  const ui=await setup(t,'candidate-facts');await ui.render();await until(()=>ui.node.textContent.includes('本人相关 1 条'));assert.match(ui.node.textContent,/全单条数未读取/);assert.match(ui.node.textContent,/用户可用 90\.00 元/);assert.match(ui.node.textContent,/退款应付 未核定/);assert.doesNotMatch(ui.node.textContent,/总资金|净利润/);
});

async function typeSearch(ui,value){const input=ui.node.querySelector('#finance-lookup');await act(async()=>{Object.getOwnPropertyDescriptor(ui.browser.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});await act(async()=>ui.node.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}
test('phone clue without permission never becomes GET or a recent-business fallback',async t=>{
  const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return response(payload(url));};
  const ui=await setup(t,'phone-denied');await ui.render();await until(()=>ui.node.textContent.includes('申请一'));const before=calls.length;
  await typeSearch(ui,'13812345678');await until(()=>ui.node.textContent.includes('手机号定位需要'));
  assert.equal(calls.length,before);assert.equal(ui.queries.length,0);assert(calls.every(call=>!call.url.includes('13812345678')));
});
test('authorized phone lookup uses existing POST then stable user scope, never phone URL/storage',async t=>{
  const calls=[];globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),method:init.method??'GET',body:init.body});if(String(url).endsWith('/users/lookup'))return response({items:[{userId:'user-phone-match',name:'对应用户',accountStatus:'ACTIVE',source:{kind:'LOCAL'},identityStatus:'UNKNOWN',ageStatus:'UNKNOWN'}],nextCursor:null,limit:20});return response(payload(url));};
  const ui=await setup(t,'phone-allowed','/finance',['finance.read','finance.document.read','user.directory.read','user.phone.lookup']);await ui.render();await until(()=>ui.node.textContent.includes('申请一'));
  await typeSearch(ui,'+86 138-1234-5678');await until(()=>ui.queries.some(query=>query.scope==='user-phone-match'));
  const lookup=calls.filter(call=>call.url.endsWith('/users/lookup'));assert.equal(lookup.length,1);assert.equal(lookup[0].method,'POST');assert.equal(JSON.parse(lookup[0].body).phone,'13812345678');assert(calls.every(call=>!call.url.includes('138')));assert.equal(ui.queries.at(-1).q,'');assert(!JSON.stringify(ui.queries).includes('138'));assert.throws(()=>ui.formats.financeQuery({...ui.formats.defaultFinanceFilters(false),q:'用户13812345678'}));
});
test('mixed phone text is rejected but a long business number remains usable',async t=>{
  const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return response(payload(url));};const ui=await setup(t,'business-query','/finance',['finance.read','finance.document.read','user.directory.read','user.phone.lookup']);await ui.render();await until(()=>ui.node.textContent.includes('申请一'));
  const before=calls.length;await typeSearch(ui,'用户13812345678退款');await until(()=>ui.node.textContent.includes('不与其他线索混用'));assert.equal(calls.length,before);
  await typeSearch(ui,'20260913125844629986');await until(()=>ui.queries.at(-1)?.q==='20260913125844629986');assert(calls.some(url=>url.includes('20260913125844629986')));
});
test('period subject does not leak a phone and an invalid date range does not issue another read',async t=>{
  const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return response(payload(url,{entries:[],reconciliation:[],gaps:[]}));};const ui=await setup(t,'period-input','/finance/period');await ui.render();await until(()=>ui.node.textContent.includes('没有资金分录'));const before=calls.length;
  const input=ui.node.querySelector('input[aria-label="主体"]');await act(async()=>{Object.getOwnPropertyDescriptor(ui.browser.HTMLInputElement.prototype,'value').set.call(input,'13812345678');input.dispatchEvent(new Event('input',{bubbles:true}));});await act(async()=>ui.node.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.match(ui.node.textContent,/主体需使用稳定用户ID/);assert.equal(calls.length,before);assert.throws(()=>ui.formats.financeQuery({...ui.formats.defaultFinanceFilters(true),scope:'13812345678'}));
  ui.props.tab={...ui.props.tab,query:{from:'2026-01-01',to:'2027-01-03'}};await ui.render();await until(()=>calls.length===before+1);const count=calls.length;await act(async()=>ui.node.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.match(ui.node.textContent,/请选择完整有效的日期区间/);assert.equal(calls.length,count);
});
test('distribution event is separate from current state and planned due time, missing frozen evidence stays unknown',async t=>{
  const entry={id:'l1',documentRef:'DISTRIBUTION:e1',documentNumber:'D1',subjectId:'u1',subjectName:'用户一',bucket:'PENDING_EARNINGS',direction:'IN',deltaCents:'95',knowledge:'KNOWN',kind:'DISTRIBUTION',state:'SETTLED',classification:'POSTED',occurredAt:'2026-10-03T01:00:00Z',evidence:{eventAction:'ACCRUE'},reasonCodes:[]};
  globalThis.fetch=async url=>response(payload(url,{document:{...document,ref:'DISTRIBUTION:e1',kind:'DISTRIBUTION',state:'SETTLED'},entries:[entry],evidence:{dueAt:'2026-10-05T01:00:00Z'},related:[],reasonCodes:[]}));
  const ui=await setup(t,'distribution','/finance/documents/DISTRIBUTION%3Ae1');await ui.render();await until(()=>ui.node.textContent.includes('冻结计佣依据未核定'));assert.match(ui.node.textContent,/分销计提/);assert.match(ui.node.textContent,/当前收益状态：已结算/);assert.match(ui.node.textContent,/计划转可用时间/);assert.doesNotMatch(ui.node.textContent,/结算日期/);
  assert.equal(ui.formats.financeEntryEvent({...entry,evidence:{eventAction:'RECOVER'}}),'分销追偿');assert.equal(ui.formats.financeEntryEvent({...entry,evidence:{eventAction:'FUTURE',eventKind:'EARNING_PENDING'}}),'分销事件待核');
});
test('origin context returns original filters and is invalid for another identity',async t=>{
  globalThis.fetch=async url=>response(payload(url));const ui=await setup(t,'origin-scope');await ui.render();const path='/finance?q=20260913125844629986&kind=WITHDRAWAL&page=2';const token=ui.registerFinanceOrigin(path,ui.financeContextIdentity(ui.props.snapshot));assert.equal(ui.financeOriginPath(token,ui.props.snapshot),path);assert.equal(ui.financeOriginPath(token,{...ui.props.snapshot,session:{...ui.props.snapshot.session,id:'another'}}),undefined);
});
test('a full reload fallback preserves public finance filters but cannot navigate outside allowed read routes',async t=>{
  globalThis.fetch=async url=>response(payload(url,{document,entries:[],evidence:{},related:[]}));const ui=await setup(t,'reload-return','/finance/documents/WITHDRAWAL%3Aw1');const path='/finance?q=20260913125844629986&page=2&kind=WITHDRAWAL';ui.props.tab.query={origin:'lost-token',financeReturn:path};ui.clearFinanceContexts();await ui.render();await until(()=>ui.node.textContent.includes('申请一'));await act(async()=>[...ui.node.querySelectorAll('button')].find(button=>button.textContent==='返回来源').click());assert.equal(ui.opened.at(-1)[0],path);
  assert.equal(ui.financeOriginPath(undefined,{...ui.props.snapshot,permissions:[]},path),undefined);assert.equal(ui.financeOriginPath(undefined,ui.props.snapshot,'https://example.com/finance'),undefined);
});
test('wallet unknown remains unknown even when an inconsistent payload includes zero cents',async t=>{
  globalThis.fetch=async url=>response(payload(url,{subject:{id:'u1',name:'用户一'},wallet:{buckets:{available:{amountCents:'0',knowledge:'UNKNOWN',scope:'POSTED_LEDGER_ONLY'}},withdrawable:{amountCents:null,reasonCodes:[]},coverage:{knowledge:'UNKNOWN'},snapshotVersion:'v1'}}));const ui=await setup(t,'wallet-unknown','/finance/users/u1');await ui.render();await until(()=>ui.node.textContent.includes('资金来源覆盖'));assert.equal(ui.node.querySelector('.finance-wallet dd').textContent,'未核定');assert.match(ui.node.textContent,/仅已入账账本/);
});
test('R1 formatted phone API gate and explicit unknown distribution action fail closed',async t=>{
  globalThis.fetch=async url=>response(payload(url));const ui=await setup(t,'r1-pure-gates');await ui.render();
  for(const q of ['+86 (138) 1234-5678','138.1234.5678','＋８６（１３８）１２３４－５６７８','备注 138.1234.5678'])assert.throws(()=>ui.formats.financeQuery({...ui.formats.defaultFinanceFilters(false),q}),q);
  for(const q of ['20260913125844629986','13812345-678a-4abc-8abc-0123456789ab','user_aa13812345678bb0123456789abcdef012345678','ORDER:order_aa13812345678bb0123456789abcdef012345678','http://127.0.0.1:4221/orders/13812345-678a-4abc-8abc-0123456789ab'])assert.doesNotThrow(()=>ui.formats.financeQuery({...ui.formats.defaultFinanceFilters(false),q}),q);
  const base={kind:'DISTRIBUTION',evidence:{eventAction:null,eventKind:'EARNING_REVOKED'}};assert.equal(ui.formats.financeEntryEvent(base),'分销事件待核');assert.equal(ui.formats.financeEntryEvent({...base,evidence:{eventKind:'EARNING_REVOKED'}}),'分销事件待核');assert.equal(ui.formats.financeEntryEvent({...base,evidence:{eventAction:'REVOKE',eventKind:'EARNING_REVOKED'}}),'分销撤销');assert.equal(ui.formats.financeEntryEvent({...base,evidence:{eventAction:'RECOVER',eventKind:'EARNING_REVOKED'}}),'分销追偿');
});
test('R1 late phone POST cannot overwrite an externally replaced business query',async t=>{
  let release;const calls=[];globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),init});if(String(url).endsWith('/users/lookup'))return new Promise(resolve=>{release=()=>resolve(response({items:[{userId:'user_late',name:'迟到用户',accountStatus:'ACTIVE',source:{kind:'LOCAL'},identityStatus:'UNKNOWN',ageStatus:'UNKNOWN'}],nextCursor:null,limit:20}));});return response(payload(url));};
  const ui=await setup(t,'r1-late-phone','/finance',['finance.read','finance.document.read','user.directory.read','user.phone.lookup']);await ui.render();await until(()=>ui.node.textContent.includes('申请一'));await typeSearch(ui,'13812345678');await until(()=>!!release);
  ui.props.tab={...ui.props.tab,query:{q:'20260913125844629986'}};await ui.render();await until(()=>calls.some(call=>call.url.includes('20260913125844629986')));await act(async()=>release());await settle();assert.equal(ui.queries.some(query=>query.scope==='user_late'),false);assert.equal(ui.node.querySelector('#finance-lookup').value,'20260913125844629986');
});
test('R1 authorized formatted and NFKC phone tokens normalize into POST only',async t=>{
  const calls=[];globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),method:init.method??'GET',body:init.body});return String(url).endsWith('/users/lookup')?response({items:[{userId:'user_match',name:'对应用户',accountStatus:'ACTIVE',source:{kind:'LOCAL'},identityStatus:'UNKNOWN',ageStatus:'UNKNOWN'}],nextCursor:null,limit:20}):response(payload(url));};const ui=await setup(t,'r1-phone-formats','/finance',['finance.read','finance.document.read','user.directory.read','user.phone.lookup']);await ui.render();await until(()=>ui.node.textContent.includes('申请一'));
  for(const [index,value] of ['+86 (138) 1234-5678','138.1234.5678','＋８６（１３８）１２３４－５６７８','1 3 8 1 2 3 4 5 6 7 8'].entries()){await typeSearch(ui,value);await until(()=>ui.queries.length===index+1);assert.equal(ui.queries.at(-1).scope,'user_match');}
  const posts=calls.filter(call=>call.method==='POST');assert.equal(posts.length,4);assert(posts.every(call=>JSON.parse(call.body).phone==='13812345678'));assert(calls.every(call=>!call.url.includes('138')&&!call.url.includes('%EF')));
});


test('native payout evidence uses API fee serial and original target names without a controlled label',async t=>{
 const ui=await setup(t,'native-payout','/finance/documents/JOINPAY_WITHDRAWAL%3An1'),entry={id:'native-line',documentRef:'JOINPAY_WITHDRAWAL:n1',documentNumber:'PAYOUT-1',subjectId:'u1',subjectName:'用户一',bucket:'RESERVED',direction:'OUT',deltaCents:'-20000',knowledge:'KNOWN',kind:'WITHDRAWAL',state:'SUCCEEDED',classification:'CURRENT_POSTED',occurredAt:null,evidence:{},reasonCodes:[],sourceType:'NATIVE',sourceSystem:'zzsh',sourceEntity:'joinpay_withdrawal_intent',sourceId:'n1'};
 const evidence={grossCents:'20000',userFeeCents:'400',netCents:'19600',providerFeeCents:'0',originalDestinationMask:'****1234',originalNumber:'PAYOUT-1',channelSerial:'JOINPAY-T-1',fundsDisposition:'PAYOUT_POSTED'};
 globalThis.fetch=async url=>response(payload(url,{document:{...document,ref:'JOINPAY_WITHDRAWAL:n1',number:'PAYOUT-1',state:'SUCCEEDED'},entries:[entry],evidence,related:[],reasonCodes:[]}));
 await ui.render();
 await until(()=>ui.node.querySelector('[data-withdrawal-evidence]'));const card=ui.node.querySelector('[data-withdrawal-evidence]');
 assert.match(card.textContent,/4\.00 元/);assert.match(card.textContent,/0\.00 元/);assert.match(card.textContent,/\*\*\*\*1234/);assert.match(card.textContent,/JOINPAY-T-1/);assert.match(card.textContent,/PAYOUT-1/);assert.match(card.textContent,/汇聚原生记录/);assert.doesNotMatch(ui.node.textContent,/本地受控成功/);
});

test('object header names the business type and localizes the raw original order status', async t => {
  const known = cents => ({ knowledge: 'KNOWN', cents, reasonCodes: [] });
  const unknown = () => ({ knowledge: 'UNKNOWN', cents: null, reasonCodes: ['ORIGINAL_BASIS_UNAVAILABLE'] });
  const settlement = { schema: 'admin-order-settlement-evidence.v1', documentRef: 'ORDER:o1', readiness: 'READY', posting: { state: 'POSTED', ref: 'posting-1', postedAt: '2026-10-19T19:51:09Z' }, captured: known('15908'), ownerNet: known('9000'), refundPayable: known('5000'), refunded: unknown(), historicalRefund: unknown(), refundDueAt: null, channel: { state: 'UNKNOWN', reference: null }, platformContribution: known('1908'), dutyRefs: [], reasonCodes: [] };
  const entry = { id: 'e1', documentRef: 'ORDER:o1', documentNumber: 'ORDER-1', subjectId: 'u1', subjectName: '用户一', bucket: 'AVAILABLE', direction: 'IN', deltaCents: '9000', knowledge: 'KNOWN', kind: 'SETTLEMENT', state: 'POSTED', classification: 'POSTED', occurredAt: '2026-10-19T19:51:09Z', evidence: {}, reasonCodes: [], sourceType: 'NATIVE', sourceSystem: 'zzsh', sourceEntity: 'ledger_entry', sourceId: 'e1' };
  const documentValue = { ...document, ref: 'ORDER:o1', number: 'ORDER-1', kind: 'SETTLEMENT', state: 'POSTED', entryCount: 1, subjects: [{ id: 'u1', name: '用户一' }] };
  globalThis.fetch = async url => response(payload(url, { document: documentValue, entries: [entry], evidence: { originalOrderStatus: 'COMPLETED', postedPlatformContributionCents: '1908' }, orderSettlement: settlement, related: [], reasonCodes: [] }));
  const ui = await setup(t, 'object-header', '/finance/documents/ORDER%3Ao1'); await ui.render();
  await until(() => ui.node.textContent.includes('本单已记平台结算贡献'));
  const applied = ui.node.querySelector('.finance-applied').textContent;
  assert.match(applied, /订单结算/);
  assert.match(applied, /已入账/);
  assert.match(applied, /1 条分录/);
  assert.match(applied, /用户一/);
  assert.equal(applied.includes('当前对象'), false);
  const facts = ui.node.querySelector('.finance-fact-list');
  assert.match(facts.textContent, /已完成/);
  assert.equal(facts.textContent.includes('COMPLETED'), false);
  assert.equal(facts.textContent.includes('原账平台分项'), false, 'settlement evidence already owns the platform contribution row');
});

test('unposted cancelled original is named as an original and its order state is localized', async t => {
  const cancelled = { ...document, ref: 'ORDER:order_cancelled', number: 'ORDER-CANCELLED', kind: 'SETTLEMENT', state: 'CANCELLED', subjects: [{ id: 'u1', name: '用户一' }], entryCount: 0, amounts: [] };
  globalThis.fetch = async url => response(payload(url, { documents: [cancelled], documentCount: 1, entryCount: 0 }));
  const ui = await setup(t, 'cancelled-original'); await ui.render();
  await until(() => ui.node.textContent.includes('订单原单（未结算）'));
  assert.match(ui.node.textContent, /已取消/);
  assert.equal(ui.node.textContent.includes('订单结算'), false);
});
