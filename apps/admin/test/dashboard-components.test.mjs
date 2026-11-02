import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

const metric = (id, label, value, unit = "CNY_CENTS", state = "KNOWN") => ({
  id, label, value, unit, state, definition: `${label} definition`, coverage: null,
  delta: { value: value ?? "0", direction: "UP", percent: null }, sparkline: [], drilldown: null,
});
const payload = () => ({
  version: "admin.dashboard.v1", preset: "BOSS", observedAt: "2026-11-02T09:00:00.000Z",
  period: { range: "30d", from: "2026-10-03T16:00:00.000Z", to: "2026-11-02T09:00:00.000Z", timeZone: "Asia/Shanghai", paymentConfirmedTo: "2026-11-02T09:00:00.000001Z" },
  comparison: { from: "2026-09-03T16:00:00.000Z", to: "2026-10-03T15:59:59.999999Z" },
  scope: { mode: "ALL_GAMES", gameIds: [] },
  metrics: [
    metric("confirmedCents", "确认收款（含押金）", "1379935"),
    metric("quotedSpread", "报价预估价差", "321165"),
    metric("settledContribution", "已结算平台贡献", "42118"),
    metric("paidOrders", "已付款订单数", "6", "COUNT"),
  ],
  trend: [{ date: "2026-10-31", confirmedCents: "1379935", paidOrders: "6", quotedSpreadCents: null, settledContributionCents: null }],
  queues: [{ id: "paid-awaiting", label: "已付款待完单", count: 3, oldestAgeSeconds: 3600, severity: "WARN", drilldown: "/orders?origin=NATIVE&status=PAID" }],
  recentOrders: [{ id: "o1", displayNo: "ZZ1", status: "PAID", paidAt: "2026-10-31T00:00:00.000Z", confirmedCents: "715239", contributionCents: "166222", contributionState: "QUOTED", currency: "CNY" }],
  recentOrdersState: 'KNOWN',
});

const snapshot=(patch={})=>({authenticated:true,adminUserId:'admin_A',user:{twoFactorEnabled:true},session:{id:'session_A',locked:false,pinConfigured:true,createdAt:null,expiresAt:null},security:{status:'ACTIVE',isBoss:false,passwordChangeRequired:false},permissions:['order.read','finance.read'],dashboardPreset:'OPS',...patch});

async function mount(t, modulePath, componentName, props, configure=()=>{}, strict=false) {
  const browser = new Window({ url: "http://127.0.0.1:4271/workbench" });
  for (const key of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "MutationObserver", "ResizeObserver", "DOMRect", "HTMLInputElement", "HTMLButtonElement", "DocumentFragment", "SVGElement"]) if (browser[key]) globalThis[key] = browser[key];
  Object.assign(globalThis, { window: browser, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const previousFetch=globalThis.fetch;
  configure(browser);
  const source = await createOfflineAdminSource({ root: fileURLToPath(new URL("../../../", import.meta.url)) });
  const module = await source.ssrLoadModule(modulePath);
  const { createRoot } = await import("react-dom/client");
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  const root = createRoot(container);
  const settle=async()=>{for(let i=0;i<3;i++)await act(async()=>{await new Promise(setImmediate);});};
  let unmounted=false;
  const render=async(next=props)=>{props=next;await act(async()=>root.render(strict?createElement(StrictMode,null,createElement(module[componentName],props)):createElement(module[componentName],props)));await settle();};
  const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>root.unmount());}};
  t.after(async () => { await unmount(); globalThis.fetch=previousFetch;container.remove(); await source.close(); await browser.happyDOM.abort(); });
  await render();
  return {host:container,root,browser,render,unmount,settle};
}
const roleProps=data=>({data,snapshot:snapshot(),range:'30d',onRange:()=>{},onRefresh:()=>{},refreshing:false,onNavigate:()=>{}});

test("Boss dashboard renders four factual KPIs, queue and recent table without admin/security cards", async (t) => {
  const {host}=await mount(t, "/apps/admin/src/workspace/dashboard/boss-dashboard.tsx", "BossDashboard", roleProps(payload())),text=host.textContent;
  for (const label of ["确认收款（含押金）", "报价预估价差", "已结算平台贡献", "已付款订单数"]) assert.match(text, new RegExp(label));
  assert.match(text, /¥13,799\.35/);
  assert.match(text, /待办与异常/);
  assert.match(text, /最近成交/);
  assert.doesNotMatch(text, /管理员目录|账号安全|权限说明|快捷入口/);
});

test("Support dashboard never renders platform contribution or admin-only cards", async (t) => {
  const data = payload();
  data.preset = "SUPPORT";
  data.metrics = [metric("supportWaiting", "待接入咨询", "1", "COUNT"), metric("supportMine", "我的进行中", "2", "COUNT"), metric("ordersPaid", "待完单", "3", "COUNT")];
  const {host}=await mount(t, "/apps/admin/src/workspace/dashboard/support-dashboard.tsx", "SupportDashboard", roleProps(data)),text=host.textContent;
  assert.match(text, /客服工作台/);
  assert.match(text, /待接入咨询/);
  assert.match(text, /我的进行中/);
  assert.doesNotMatch(text, /平台贡献|已结算平台贡献|管理员目录/);
});

const pageModule='/apps/admin/src/workspace/dashboard/dashboard-page.tsx';
function pendingReads(browser){
 const calls=[],timers=new Map();let timerId=1;
 browser.setInterval=(fn,ms)=>{assert.equal(ms,30000);const id=timerId++;timers.set(id,fn);return id;};browser.clearInterval=id=>timers.delete(id);
 globalThis.fetch=(url,options)=>new Promise(resolve=>calls.push({url:String(url),options,resolve:body=>resolve(Response.json(body)),reject:status=>resolve(Response.json({error:{code:'FORBIDDEN',message:'forbidden'}},{status}))}));
 return{calls,async tick(){await act(async()=>{for(const fn of [...timers.values()])fn();await new Promise(setImmediate);});},timers};
}
function opsPayload(amount='1379935',patch={}){const data=payload();data.preset='OPS';data.metrics[0].value=amount;data.metrics[0].delta=null;data.trend[0].confirmedCents=amount;return{...data,...patch};}
async function resolveRead(h,request,body){await act(async()=>request.resolve(body));await h.settle();}
const pageProps=(snap=snapshot(),refreshNonce=0)=>({snapshot:snap,refreshNonce,onNavigate:()=>{}});

test('OPS retains the same four real business metrics and original queues without rendering task counts as more KPIs',async t=>{
 const data=opsPayload();data.metrics.unshift(metric('ordersPaid','OLD_TASK_KPI','91','COUNT'));const {host}=await mount(t,'/apps/admin/src/workspace/dashboard/ops-dashboard.tsx','OpsDashboard',roleProps(data));
 const kpis=host.querySelector('.dashboard-kpi-grid');for(const label of ['确认收款（含押金）','报价预估价差','已结算平台贡献','已付款订单数'])assert.match(kpis.textContent,new RegExp(label));assert.equal(kpis.children.length,4);assert.doesNotMatch(kpis.textContent,/OLD_TASK_KPI/);assert.match(host.textContent,/已付款待完单/);assert.equal(data.preset,'OPS');
});
test('OPS keeps forbidden business fields unavailable rather than replacing them with zero or a known empty period',async t=>{
 const data=opsPayload();data.metrics[1]={...data.metrics[1],state:'FORBIDDEN',value:null,delta:null,coverage:{knownCount:0,totalCount:0}};
 const {host}=await mount(t,'/apps/admin/src/workspace/dashboard/ops-dashboard.tsx','OpsDashboard',roleProps(data)),kpis=host.querySelector('.dashboard-kpi-grid');assert.equal(kpis.children.length,4);const unavailable=kpis.children[1];assert.match(unavailable.textContent,/报价预估价差|无读取权限/);assert.doesNotMatch(unavailable.textContent,/¥0\.00|本期暂无数据/);
});
test('support links follow effective permissions instead of the SUPPORT preset name',async t=>{
 const data={...payload(),preset:'SUPPORT',metrics:[]},h=await mount(t,'/apps/admin/src/workspace/dashboard/support-dashboard.tsx','SupportDashboard',{...roleProps(data),snapshot:snapshot({permissions:['im.support.read']})});
 assert.match(h.host.textContent,/我的接待/);assert.doesNotMatch(h.host.textContent,/客服统计|订单查询/);
 await h.render({...roleProps(data),snapshot:snapshot({permissions:['im.support.management.read','order.read']})});assert.match(h.host.textContent,/客服统计|订单查询/);assert.doesNotMatch(h.host.textContent,/我的接待/);
});
test('dashboard polling has one active read, skips hidden documents and aborts its pending read on unmount',async t=>{
 let probe;const h=await mount(t,pageModule,'DashboardPage',pageProps(),browser=>{probe=pendingReads(browser);});assert.equal(probe.calls.length,1);
 await resolveRead(h,probe.calls[0],opsPayload());Object.defineProperty(h.browser.document,'visibilityState',{value:'hidden',configurable:true});await probe.tick();assert.equal(probe.calls.length,1);
 Object.defineProperty(h.browser.document,'visibilityState',{value:'visible',configurable:true});await probe.tick();await probe.tick();assert.equal(probe.calls.length,2);assert.equal(probe.calls[1].options.signal.aborted,false);
 await h.unmount();assert.equal(probe.calls[1].options.signal.aborted,true);assert.equal(probe.timers.size,0);assert(probe.calls.every(call=>call.options.method==='GET'));
});
test('a range change aborts polling and a late prior response cannot overwrite the new range',async t=>{
 let probe;const h=await mount(t,pageModule,'DashboardPage',pageProps(),browser=>{probe=pendingReads(browser);});await resolveRead(h,probe.calls[0],opsPayload());await probe.tick();const old=probe.calls[1];
 await act(async()=>[...h.host.querySelectorAll('button')].find(b=>b.textContent==='近7天').click());await h.settle();assert.equal(old.options.signal.aborted,true);assert.equal(probe.calls.length,3);assert.match(probe.calls[2].url,/range=7d/);assert.doesNotMatch(h.host.textContent,/13,799\.35/);
 await resolveRead(h,probe.calls[2],opsPayload('900',{period:{...payload().period,range:'7d'}}));await resolveRead(h,old,opsPayload('100'));assert.match(h.host.querySelector('.dashboard-kpi-grid').textContent,/¥9\.00/);assert.doesNotMatch(h.host.querySelector('.dashboard-kpi-grid').textContent,/¥1\.00/);
});
test('StrictMode cancels its first read and only the current generation can deliver a result',async t=>{
 let probe;const h=await mount(t,pageModule,'DashboardPage',pageProps(),browser=>{probe=pendingReads(browser);},true);assert.equal(probe.calls.length,2);assert.equal(probe.calls[0].options.signal.aborted,true);assert.equal(probe.calls[1].options.signal.aborted,false);
 await resolveRead(h,probe.calls[1],opsPayload('900'));await resolveRead(h,probe.calls[0],opsPayload('100'));assert.match(h.host.querySelector('.dashboard-kpi-grid').textContent,/¥9\.00/);assert.doesNotMatch(h.host.querySelector('.dashboard-kpi-grid').textContent,/¥1\.00/);
});
test('an authenticated active session reads with either login two-factor policy, including a TOTP-enabled Boss',async t=>{
 for(const preset of ['BOSS','OPS'])for(const required of [false,true])await t.test(`${preset} policy=${required}`,async child=>{
  let probe;const snap=snapshot({dashboardPreset:preset,security:{...snapshot().security,isBoss:preset==='BOSS',loginTwoFactorRequired:required}}),h=await mount(child,pageModule,'DashboardPage',pageProps(snap),browser=>{probe=pendingReads(browser);});
  assert.equal(probe.calls.length,1,'an authenticated session is not a pending TOTP challenge');await resolveRead(h,probe.calls[0],{...payload(),preset});assert.equal(h.host.querySelector('.dashboard-kpi-grid')?.children.length,4);assert.doesNotMatch(h.host.textContent,/当前会话无法读取工作台/);
 });
});
test('identity, session, permissions, preset and security changes clear old data before accepting another read',async t=>{
 for(const [name,patch] of [['identity',{adminUserId:'admin_B'}],['session',{session:{...snapshot().session,id:'session_B'}}],['permissions',{permissions:['order.read']}],['scope',{gameScope:{mode:'SELECTED_GAMES',gameIds:['game_B']}}],['preset',{dashboardPreset:'SUPPORT'}],['lock',{session:{...snapshot().session,locked:true}}],['pending',{security:{...snapshot().security,status:'PENDING_ENROLLMENT'}}],['frozen',{security:{...snapshot().security,status:'FROZEN'}}],['password',{security:{...snapshot().security,passwordChangeRequired:true}}],['two-factor-policy',{security:{...snapshot().security,loginTwoFactorRequired:true}}]])await t.test(name,async child=>{
  let probe;const h=await mount(child,pageModule,'DashboardPage',pageProps(),browser=>{probe=pendingReads(browser);});await resolveRead(h,probe.calls[0],opsPayload());await probe.tick();const old=probe.calls[1];await h.render(pageProps(snapshot(patch)));assert.equal(old.options.signal.aborted,true);assert.doesNotMatch(h.host.textContent,/13,799\.35/);
  const blocked=['lock','pending','frozen','password'].includes(name);assert.equal(probe.calls.length,blocked?2:3);await resolveRead(h,old,opsPayload('100'));assert.doesNotMatch(h.host.textContent,/¥1\.00/);if(blocked)assert.match(h.host.textContent,/当前会话无法读取/);if(name==='two-factor-policy'){await resolveRead(h,probe.calls[2],opsPayload('900'));assert.match(h.host.querySelector('.dashboard-kpi-grid').textContent,/¥9\.00/);}
 });
});
test('A-B-A identity transitions cannot revive a cancelled A request, and denied refresh clears private results',async t=>{
 let probe;const h=await mount(t,pageModule,'DashboardPage',pageProps(),browser=>{probe=pendingReads(browser);});const first=probe.calls[0];await h.render(pageProps(snapshot({adminUserId:'admin_B'})));await h.render(pageProps());assert.equal(probe.calls.length,3);
 await resolveRead(h,probe.calls[2],opsPayload('900'));await resolveRead(h,first,opsPayload('100'));assert.match(h.host.querySelector('.dashboard-kpi-grid').textContent,/¥9\.00/);
 await probe.tick();await act(async()=>probe.calls[3].reject(403));await h.settle();assert.equal(Boolean(h.host.querySelector('.dashboard-kpi-grid')),false);assert.match(h.host.textContent,/工作台暂时无法读取/);
});
test('business trend and recent-order links keep the exact same payment period and display Beijing dates',async t=>{
 const data=opsPayload(),paths=[],exclusive='2026-11-02T09:00:00.000001Z';delete data.period.paymentConfirmedTo;data.metrics.find(metric=>metric.id==='paidOrders').drilldown='/orders?'+new URLSearchParams({origin:'NATIVE',paymentConfirmedFrom:data.period.from,paymentConfirmedTo:exclusive});
 const h=await mount(t,'/apps/admin/src/workspace/dashboard/ops-dashboard.tsx','OpsDashboard',{...roleProps(data),onNavigate:path=>paths.push(path)});
 assert.match(h.host.textContent,/2026-10-04 至 2026-11-02 · 北京时间/);
 for(const label of ['查看订单','全部订单']){const button=[...h.host.querySelectorAll('button')].find(b=>b.textContent.trim()===label);assert.ok(button,label);await act(async()=>button.click());}
 assert.equal(paths.length,2);for(const path of paths){const query=new URL(path,'http://fixture').searchParams;assert.equal(query.get('origin'),'NATIVE');assert.equal(query.get('paymentConfirmedFrom'),data.period.from);assert.equal(query.get('paymentConfirmedTo'),exclusive);}
});
