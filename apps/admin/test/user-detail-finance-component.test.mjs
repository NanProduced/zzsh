import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

// Reuse the existing user-directory component harness: Happy DOM + real Vite SSR components.
const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const browser=new Window({url:"http://127.0.0.1:4291/users/user-one?section=finance"});
for(const name of ["document","HTMLElement","Element","Node","Event","CustomEvent","MutationObserver","ResizeObserver","localStorage","sessionStorage"])globalThis[name]=browser[name];
globalThis.window=browser;
Object.defineProperty(globalThis,"navigator",{value:browser.navigator,configurable:true});
globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import("react-dom/client");
const vite=await createServer({root:rootPath,configFile:false,plugins:[react()],resolve:{alias:{"@":path.join(rootPath,"src"),"@brand":path.resolve(rootPath,"../../assets/brand")}},server:{middlewareMode:true,hmr:false}});
const {UserDetailFinance}=await vite.ssrLoadModule("/src/views/user-directory/user-detail-finance.tsx");
const {AdminFinanceView,clearFinanceContexts}=await vite.ssrLoadModule("/src/views/admin-finance-view.tsx");
const {tabFromLocation}=await vite.ssrLoadModule("/src/workspace/tab-model.ts");
const {UserDirectoryBff}=await vite.ssrLoadModule("/src/views/user-directory/user-directory-data.ts");
const {beijingCalendarDate}=await vite.ssrLoadModule("/src/workspace/beijing-time.ts");
after(async()=>{await vite.close();await browser.happyDOM.abort();});
const now="2026-10-22T10:00:00.000000Z";
const line={orderId:"order-one",displayNo:"ZZ001",gameId:"game-one",postingId:"posting-one",settlementVersionId:"version-one",versionHash:"a".repeat(64),postedAt:now,documentRef:"ORDER:order-one",knowledge:"KNOWN",reasonCodes:[],haffRentCents:"1000",itemConsumptionCents:"2000",earlyMakeupCents:"3000",renterFeeCents:"4000",amountCents:"10000"};
const consumption={contractVersion:"admin-user-consumption.v1",subjectId:"user-one",currency:"CNY",amountUnit:"CENT",scope:"CURRENT_POSTED_NATIVE_SETTLEMENTS",asOfUtc:now,knowledge:"KNOWN",amountCents:"10000",knownAmountCents:"10000",components:{haffRentCents:"1000",itemConsumptionCents:"2000",earlyMakeupCents:"3000",renterFeeCents:"4000"},total:1,unknownCount:0,page:1,pageSize:20,items:[line],legacyHistory:{knowledge:"UNKNOWN",amountCents:null,reason:"LEGACY_COMPONENT_BREAKDOWN_NOT_AVAILABLE"}};
const document={ref:"ORDER:order-one",number:"ZZ001",kind:"SETTLEMENT",state:"POSTED",occurredAt:now,requestedAmountCents:null,subjects:[{id:"user-one",name:"用户一"}],entryCount:1,amounts:[{bucket:"AVAILABLE",knownNetCents:"500",unknownCount:0}]};
const waitFor=async(condition)=>{for(let i=0;i<80;i++){if(condition())return;await act(async()=>new Promise(setImmediate));}throw Error("User finance condition timed out");};
let serial=0;
async function mount(t,{permissions=["user.finance.read"],consume,finance,wallet,realFinance=false}={}){
  const calls={consumption:[],finance:[]},opened=[];
  const adapter={snapshot:{authenticated:true,adminUserId:`admin-${++serial}`,user:{name:"运营甲",username:"OPERATOR"},session:{id:`session-${serial}`,locked:false},security:{isBoss:false,status:"ACTIVE",passwordChangeRequired:false},permissions},has:permission=>permissions.includes(permission),
    consumption:async(...args)=>{calls.consumption.push(args);return consume?consume(...args):consumption;},
    finance:async(...args)=>{calls.finance.push(args);return finance?finance(...args):{documents:[document]};}};
  if(realFinance){const bff=new UserDirectoryBff(adapter.snapshot);adapter.finance=async(...args)=>{calls.finance.push(args);return bff.finance(...args);};}
  const host=browser.document.createElement("div");browser.document.body.append(host);const root=createRoot(host);
  const props={adapter,user:{id:"user-one",name:"用户一",walletSummary:wallet??{state:"ready",amountCents:"15000",currency:"CNY",asOfUtc:now}},refreshNonce:0,onOpenPath:(...args)=>opened.push(args)};
  await act(async()=>root.render(createElement(UserDetailFinance,props)));
  t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  return{host,calls,opened,props,root,render:async()=>act(async()=>root.render(createElement(UserDetailFinance,props)))};
}

test("wallet permission grants balance only and never requests consumption or full finance",async t=>{
  const ui=await mount(t,{permissions:["user.wallet.read"]});await act(async()=>new Promise(setImmediate));
  assert.match(ui.host.textContent,/150\.00 元/);assert.equal(ui.calls.consumption.length,0);assert.equal(ui.calls.finance.length,0);
  assert.doesNotMatch(ui.host.textContent,/租赁消费|新平台已结算|完整资金核对|资金单据|ZZ001/);
});

test("narrow user-finance permission reads consumption without platform finance and losing it clears data immediately",async t=>{
  const ui=await mount(t);await waitFor(()=>ui.host.querySelector('[aria-label="用户租赁消费明细"]'));
  assert.match(ui.host.textContent,/150\.00 元/);assert.match(ui.host.textContent,/新平台已结算/);assert.match(ui.host.textContent,/旧平台消费暂不能汇总/);
  assert.equal(ui.calls.consumption.length,1);assert.equal(ui.calls.finance.length,0);assert.doesNotMatch(ui.host.textContent,/完整资金核对|资金单据/);
  assert.equal([...ui.host.querySelectorAll("button")].find(button=>button.textContent.includes("ZZ001")),undefined,"order link requires order.read");
  ui.props.adapter={...ui.props.adapter,snapshot:{...ui.props.adapter.snapshot,permissions:["user.wallet.read"]},has:permission=>permission==="user.wallet.read"};await ui.render();
  assert.match(ui.host.textContent,/150\.00 元/);assert.doesNotMatch(ui.host.textContent,/ZZ001|租赁消费|100\.00 元/);assert.equal(ui.calls.consumption.length,1);
});

test("full reader requests today's real period and preserves origin in document drilldown",async t=>{
  const ui=await mount(t,{permissions:["finance.read","finance.document.read","order.read"]});
  await waitFor(()=>ui.host.querySelector('[aria-label="查看资金单据 ZZ001"]'));
  const filters=ui.calls.finance[0][2],today=beijingCalendarDate();
  assert.equal(filters.period,true);assert.equal(filters.from,today);assert.equal(filters.to,today);assert.equal(filters.scope,"user-one");
  assert.match(ui.host.textContent,/北京时间/);assert.match(ui.host.textContent,/本地受控结果均不代表渠道到账/);
  await act(async()=>ui.host.querySelector('[aria-label="查看资金单据 ZZ001"]').click());
  assert.match(ui.opened[0][0],/^\/finance\/documents\/ORDER%3Aorder-one\?origin=/);
  await act(async()=>[...ui.host.querySelectorAll("button")].find(button=>button.textContent.includes("ZZ001")).click());
  assert.equal(ui.opened.at(-1)[0],"/orders/order-one");
  await act(async()=>ui.host.querySelector("form").dispatchEvent(new browser.Event("submit",{bubbles:true,cancelable:true})));
  await waitFor(()=>ui.calls.finance.length===2);
  assert.equal(ui.calls.consumption.length,1,"refreshing today's documents does not recalculate all-time consumption");
});

test("real BFF adapter sends today's Beijing range and applies a changed date only on query",async t=>{
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  const today=beijingCalendarDate(),shift=days=>{const value=new Date(`${today}T00:00:00Z`);value.setUTCDate(value.getUTCDate()-days);return value.toISOString().slice(0,10);};
  const source=[{...document,ref:"ORDER:today",number:"TODAY-DOCUMENT",occurredAt:`${today}T01:00:00+08:00`},
    {...document,ref:"ORDER:week",number:"WEEK-DOCUMENT",occurredAt:`${shift(2)}T12:00:00+08:00`},
    {...document,ref:"ORDER:old",number:"OLD-DOCUMENT",occurredAt:`${shift(30)}T12:00:00+08:00`}],requests=[];
  globalThis.fetch=async address=>{
    const url=new URL(address,"http://127.0.0.1:4291"),q=url.searchParams;requests.push(url);
    assert.equal(url.pathname,"/api/bff/admin/finance/subjects/user-one");assert.equal(q.get("scope"),"user-one");assert.equal(q.get("period"),"1");
    const from=Date.parse(`${q.get("from")}T00:00:00+08:00`),before=Date.parse(`${q.get("to")}T00:00:00+08:00`)+86400000;
    return{ok:true,status:200,headers:new Headers(),json:async()=>({contractVersion:"admin-finance.read.v1",documents:source.filter(item=>Date.parse(item.occurredAt)>=from&&Date.parse(item.occurredAt)<before)})};
  };
  const ui=await mount(t,{permissions:["finance.read","finance.document.read"],realFinance:true});
  await waitFor(()=>ui.host.textContent.includes("TODAY-DOCUMENT"));assert.equal(requests.length,1);
  assert.equal(requests[0].searchParams.get("from"),today);assert.equal(requests[0].searchParams.get("to"),today);
  assert.doesNotMatch(ui.host.textContent,/WEEK-DOCUMENT|OLD-DOCUMENT/);
  await act(async()=>ui.host.querySelector('[aria-label="选择单据日期"]').click());
  await waitFor(()=>[...browser.document.querySelectorAll("button")].some(button=>button.textContent==="近7天"));
  await act(async()=>[...browser.document.querySelectorAll("button")].find(button=>button.textContent==="近7天").click());
  assert.equal(requests.length,1,"choosing a range updates only the draft");
  await act(async()=>ui.host.querySelector("form").dispatchEvent(new browser.Event("submit",{bubbles:true,cancelable:true})));
  await waitFor(()=>ui.host.textContent.includes("WEEK-DOCUMENT"));assert.equal(requests.length,2);
  assert.equal(requests[1].searchParams.get("from"),shift(6));assert.equal(requests[1].searchParams.get("to"),today);
  assert.match(ui.host.textContent,new RegExp(`${shift(6)} 至 ${today}`));assert.doesNotMatch(ui.host.textContent,/OLD-DOCUMENT/);
});

test("real finance target retains the source-user return link for operator and Boss identities",async t=>{
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;clearFinanceContexts();});
  for(const isBoss of [false,true]){
    clearFinanceContexts();
    const ui=await mount(t,{permissions:["finance.read","finance.document.read"]});
    ui.props.adapter.snapshot.security.isBoss=isBoss;await ui.render();
    await waitFor(()=>ui.host.querySelector('[aria-label="查看资金单据 ZZ001"]'));
    await act(async()=>ui.host.querySelector('[aria-label="查看资金单据 ZZ001"]').click());
    const path=ui.opened.at(-1)[0],url=new URL(path,"http://127.0.0.1:4291"),back=[];let fetched=0;
    globalThis.fetch=async address=>{
      fetched++;const q=new URL(address,"http://127.0.0.1:4291").searchParams;
      return{ok:true,status:200,headers:new Headers(),json:async()=>({contractVersion:"admin-finance.read.v1",applied:{scope:q.get("scope")??"ALL",from:q.get("from"),to:q.get("to"),period:q.get("period")==="1",bucket:"ALL",kind:"ALL",state:"ALL",q:""},snapshot:"test-snapshot",asOf:now,contextKey:"test-access",snapshotVersion:"test-version",document,entries:[],evidence:{},related:[]})};
    };
    await act(async()=>ui.root.render(createElement(AdminFinanceView,{tab:tabFromLocation(url.pathname,url.search),snapshot:ui.props.adapter.snapshot,onOpenPath:(...args)=>back.push(args),onQueryChange:()=>{},onRefresh:async()=>ui.props.adapter.snapshot,refreshNonce:0})));
    await waitFor(()=>fetched>0&&ui.host.textContent.includes("ZZ001"));
    const returnButton=[...ui.host.querySelectorAll("button")].find(button=>button.textContent==="返回来源");assert(returnButton);
    await act(async()=>returnButton.click());assert.equal(back.at(-1)[0],"/users/user-one?section=finance");
    await act(async()=>ui.root.render(null));
  }
});

test("consumption failure does not hide balance or successful finance documents",async t=>{
  const ui=await mount(t,{permissions:["finance.read","finance.document.read"],consume:async()=>{throw Error("consume unavailable");}});
  await waitFor(()=>ui.host.textContent.includes("消费记录读取失败")&&ui.host.querySelector('[aria-label="查看资金单据 ZZ001"]'));
  assert.match(ui.host.textContent,/150\.00 元/);assert(ui.host.querySelector('[role="alert"]'));
});

test("finance failure does not hide consumption or open unauthorized document targets",async t=>{
  const ui=await mount(t,{permissions:["finance.read","order.read"],finance:async()=>{throw Error("finance unavailable");}});
  await waitFor(()=>ui.host.textContent.includes("资金单据读取失败")&&ui.host.querySelector('[aria-label="用户租赁消费明细"]'));
  assert.match(ui.host.textContent,/100\.00 元/);assert.equal(ui.host.querySelector('[aria-label="查看资金单据 ZZ001"]'),null);
});

test("unknown adjustment is never rendered as zero or a complete total",async t=>{
  const ui=await mount(t,{wallet:{state:"unknown",reason:"SOURCE_COVERAGE_NOT_ADMITTED"},consume:async()=>({...consumption,knowledge:"UNKNOWN",amountCents:null,knownAmountCents:"0",unknownCount:1,components:{haffRentCents:null,itemConsumptionCents:null,earlyMakeupCents:null,renterFeeCents:null},items:[{...line,knowledge:"UNKNOWN",amountCents:null,haffRentCents:null,itemConsumptionCents:null,earlyMakeupCents:null,renterFeeCents:null,reasonCodes:["MANUAL_RENTER_ADJUSTMENT_UNALLOCATED"]}]})});
  await waitFor(()=>ui.host.textContent.includes("调整待核"));
  assert.match(ui.host.textContent,/1 笔待核/);assert.match(ui.host.textContent,/已核部分 0\.00 元/);
  assert.doesNotMatch(ui.host.textContent,/100\.00 元/);assert.match(ui.host.textContent,/可用余额待核/);
});

test("independent requests show skeletons and permission loss immediately unmounts private data",async t=>{
  const ui=await mount(t,{permissions:["finance.read"],consume:()=>new Promise(()=>{}),finance:()=>new Promise(()=>{})});
  assert(ui.host.querySelector('[aria-label="正在读取消费记录"]'));assert(ui.host.querySelector('[aria-label="正在读取资金单据"]'));
  ui.props.adapter={...ui.props.adapter,snapshot:{...ui.props.adapter.snapshot,permissions:[]},has:()=>false};await ui.render();
  assert.match(ui.host.textContent,/没有用户资金查看权限/);assert.doesNotMatch(ui.host.textContent,/150\.00|正在读取消费记录/);
});

test("numbered consumption pagination requests the real next page",async t=>{
  const ui=await mount(t,{consume:async(_id,_signal,page)=>({...consumption,total:21,page})});
  await waitFor(()=>ui.host.querySelector('[aria-label="下一页"]'));
  await act(async()=>ui.host.querySelector('[aria-label="下一页"]').click());
  await waitFor(()=>ui.calls.consumption.some(args=>args[2]===2));
  assert.match(ui.host.textContent,/21/);assert.equal(ui.calls.finance.length,0);
});

test("no subject financial permission performs neither query",async t=>{
  const ui=await mount(t,{permissions:["user.directory.read"]});await act(async()=>new Promise(setImmediate));
  assert.match(ui.host.textContent,/没有用户资金查看权限/);assert.equal(ui.calls.consumption.length,0);assert.equal(ui.calls.finance.length,0);
});
