import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {createOfflineAdminSource} from './offline-admin-source.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const metric=(id,value='2',state='KNOWN')=>({id,label:id==='confirmedCents'?'确认收款':'已付款订单',value,unit:id==='confirmedCents'?'CNY_CENTS':'COUNT',state,definition:'合成口径，仅组件验证',coverage:state==='PARTIAL'?{knownCount:1,totalCount:2}:null,delta:null,sparkline:[],drilldown:null});
const data=()=>({version:'admin.dashboard.v1',preset:'OPS',observedAt:'2026-11-02T09:00:00Z',period:{range:'30d',from:'2026-10-03T16:00:00Z',to:'2026-11-02T09:00:00Z',paymentConfirmedTo:'2026-11-02T09:00:00.000001Z',timeZone:'Asia/Shanghai'},comparison:{from:'2026-09-03T16:00:00Z',to:'2026-10-03T09:00:00Z'},scope:{mode:'ALL_GAMES',gameIds:[]},metrics:[metric('confirmedCents','12345'),metric('paidOrders')],trend:[{date:'2026-11-01',confirmedCents:'12345',paidOrders:'2',quotedSpreadCents:null,settledContributionCents:null},{date:'2026-11-02',confirmedCents:'100',paidOrders:'1',quotedSpreadCents:null,settledContributionCents:null}],queues:[],recentOrders:[]});
async function mount(t,name,props,{width=719}={}){
  const browser=new Window({url:'http://fixture.invalid/'}),observers=new Set();let plotWidth=width;
  for(const key of ['document','HTMLElement','Element','Node','Event','CustomEvent','MouseEvent','MutationObserver','DOMRect','HTMLInputElement','HTMLButtonElement','DocumentFragment','SVGElement','KeyboardEvent'])if(browser[key])globalThis[key]=browser[key];
  Object.assign(globalThis,{window:browser,IS_REACT_ACT_ENVIRONMENT:true,getComputedStyle:browser.getComputedStyle.bind(browser),requestAnimationFrame:browser.requestAnimationFrame.bind(browser),cancelAnimationFrame:browser.cancelAnimationFrame.bind(browser)});Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const original=browser.HTMLElement.prototype.getBoundingClientRect;
  browser.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('chart-plot')?new browser.DOMRect(0,0,plotWidth,240):original.call(this)};
  class Observer{constructor(callback){this.callback=callback;observers.add(this)}observe(){}unobserve(){}disconnect(){observers.delete(this)}}globalThis.ResizeObserver=Observer;browser.ResizeObserver=Observer;
  const source=await createOfflineAdminSource({root:ROOT}),shared=await source.ssrLoadModule('/apps/admin/src/components/dashboard/dashboard-components.tsx'),chart=await source.ssrLoadModule('/apps/admin/src/components/ui/chart.tsx'),tooltip=await source.ssrLoadModule('/apps/admin/src/components/ui/tooltip.tsx'),{createRoot}=await import('react-dom/client');
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host),component=shared[name]??chart[name]??tooltip[name];
  const render=async value=>{await act(async()=>root.render(createElement(component,value)));await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0))})};
  t.after(async()=>{await act(async()=>root.unmount());host.remove();await source.close();await browser.happyDOM.abort()});await render(props);
  return{host,browser,chart,shared,render,resize:async value=>{plotWidth=value;await act(async()=>{for(const observer of observers)observer.callback([])})}};
}

test('real Evil area/bar custom children draw on Recharts3 and expose keyboard surfaces without aria-hidden',async t=>{
  const h=await mount(t,'TrendPanel',{data:data(),onNavigate:()=>{}});assert.ok(h.host.querySelector('.recharts-area-curve'));assert.ok(h.host.querySelector('pattern[id*="evil-area"]'));
  const svg=h.host.querySelector('svg.recharts-surface');assert.equal(svg.getAttribute('width'),'719');assert.equal(svg.getAttribute('tabindex'),'0');assert.equal(svg.getAttribute('role'),'application');assert.equal(Boolean(svg.closest('[aria-hidden="true"]')),false);
  await act(async()=>{svg.dispatchEvent(new h.browser.FocusEvent('focusin',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,0))});assert.match(h.host.querySelector('.chart-tooltip')?.textContent??'',/2026-11-01.*¥123\.45/);
  await act(async()=>{svg.dispatchEvent(new h.browser.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,30))});assert.match(h.host.querySelector('.chart-tooltip')?.textContent??'',/2026-11-02.*¥1\.00/);
  await act(async()=>[...h.host.querySelectorAll('button')].find(el=>el.textContent==='已付款订单').click());assert.ok(h.host.querySelector('.recharts-bar-rectangle'));assert.ok(h.host.querySelector('linearGradient[id*="evil-bar"]'));assert.match(h.host.textContent,/单位：笔/);
});
test('first zero-width frame has no guessed plot, then initial/resize/hidden restoration use real width',async t=>{
  const h=await mount(t,'TrendPanel',{data:data(),onNavigate:()=>{}},{width:0});assert.equal(Boolean(h.host.querySelector('svg.recharts-surface')),false);assert.match(h.host.textContent,/可见时绘制/);
  for(const width of [719,431,358,0,719]){await h.resize(width);const svg=h.host.querySelector('svg.recharts-surface');if(width)assert.equal(svg.getAttribute('width'),String(width));else assert.equal(Boolean(svg),false)}
});
test('Forbidden/Unavailable/NoScope series cannot be selected or exposed as known zero',async t=>{
  for(const state of ['FORBIDDEN','UNAVAILABLE','NO_GAME_SCOPE']){
    const d=data();d.metrics=[metric('confirmedCents',null,state),{...metric('paidOrders',null,state),drilldown:'/orders?paymentConfirmedFrom=2026-10-03T16%3A00%3A00Z&paymentConfirmedTo=2026-11-02T09%3A00%3A00.000001Z'}];d.trend=d.trend.map(day=>({...day,confirmedCents:null,paidOrders:'0'}));
    const h=await mount(t,'TrendPanel',{data:d,onNavigate:()=>{}});assert.equal(Boolean(h.host.querySelector('svg.recharts-surface')),false);assert.doesNotMatch(h.host.textContent,/本期暂无数据/);assert.ok([...h.host.querySelectorAll('.chart-legend button')].every(button=>button.disabled));assert.doesNotMatch(h.host.textContent,/¥0\.00|查看订单/);
  }
});
test('a permission change discards visible financial series and hides residual raw fields',async t=>{
  const d=data(),h=await mount(t,'TrendPanel',{data:d,onNavigate:()=>{}});assert.match(h.host.textContent,/¥123\.45/);d.metrics[0]=metric('confirmedCents',null,'FORBIDDEN');await h.render({data:d,onNavigate:()=>{}});
  assert.equal(Boolean(h.host.querySelector('.recharts-area-curve')),false);assert.ok(h.host.querySelector('.recharts-bar-rectangle'));assert.doesNotMatch(h.host.textContent,/¥123\.45/);
});
test('partial/null dates stay gaps and remain distinct from a known empty period',async t=>{
  const d=data();d.metrics[0]=metric('confirmedCents','0','PARTIAL');d.trend=[{...d.trend[0],confirmedCents:null},{...d.trend[1],confirmedCents:'0'}];
  const h=await mount(t,'TrendPanel',{data:d,onNavigate:()=>{}});assert.match(h.host.textContent,/部分日期未核/);assert.doesNotMatch(h.host.textContent,/本期暂无数据/);assert.ok(h.host.querySelector('svg.recharts-surface'));
  const zero=data();zero.metrics[0]=metric('confirmedCents','0');zero.trend=[];await h.render({data:zero,onNavigate:()=>{}});assert.match(h.host.textContent,/本期暂无数据/);
});
test('unsafe money coordinates fall back to an open exact table, never a clipped/dropped peak',async t=>{
  const d=data(),huge='900719925474099301';d.metrics[0]=metric('confirmedCents',huge);d.trend[0].confirmedCents=huge;
  const h=await mount(t,'TrendPanel',{data:d,onNavigate:()=>{}});assert.equal(Boolean(h.host.querySelector('svg.recharts-surface')),false);assert.match(h.host.textContent,/超过图表安全范围/);assert.equal(h.host.querySelector('details').open,true);assert.match(h.host.textContent,/¥9,007,199,254,740,993\.01/);
});
test('Evil tooltip formatter consumes original point cents instead of the numeric coordinate',async t=>{
  const h=await mount(t,'ChartContainer',{config:{receipts:{label:'确认收款',color:'var(--chart-receipts)'}},label:'合成tooltip',children:null});
  await h.render({config:{receipts:{label:'确认收款',color:'var(--chart-receipts)'}},label:'合成tooltip',children:null,legend:createElement(h.chart.ChartTooltipContent,{active:true,label:'2026-11-02',payload:[{dataKey:'receipts',name:'确认收款',value:123.46,payload:{receiptsCents:'12345'}}],formatValue:(point)=>`原分 ${point.receiptsCents}`})});
  assert.match(h.host.textContent,/原分 12345/);assert.doesNotMatch(h.host.textContent,/123\.46/);assert.equal(h.host.querySelector('[role="status"]').getAttribute('aria-live'),'polite');
});
test('missing series config produces no fabricated area or bar color',async t=>{
  const h=await mount(t,'ChartContainer',{config:{},label:'无配置series',children:null});
  await h.render({config:{},label:'无配置series',children:createElement(h.chart.AreaChart,{data:[{missing:2}]},createElement(h.chart.ChartArea,{dataKey:'missing'}),createElement(h.chart.ChartBar,{dataKey:'missing'}))});
  assert.equal(Boolean(h.host.querySelector('.recharts-area-curve,.recharts-bar-rectangle,defs linearGradient')),false);
});
test('unavailable metric removes delta/sparkline, info is a house keyboard button, long exact text remains',async t=>{
  const m={...metric('confirmedCents',null,'FORBIDDEN'),delta:{value:'2',direction:'UP',percent:null},sparkline:['0','2'],drilldown:'/orders'},h=await mount(t,'StatCard',{metric:m,onNavigate:()=>{}});
  assert.equal(Boolean(h.host.querySelector('svg[viewBox="0 0 100 32"]')),false);assert.doesNotMatch(h.host.textContent,/\+¥|查看明细/);assert.ok([...h.host.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='确认收款口径'));
  // HappyDOM has no keyboard-modality :focus-visible matching; supply only that browser capability.
  const trigger=h.host.querySelector('button'),matches=trigger.matches.bind(trigger);trigger.matches=selector=>selector===':focus-visible'?h.browser.document.activeElement===trigger:matches(selector);
  assert.equal(h.browser.document.getElementById(trigger.getAttribute('aria-describedby'))?.textContent,m.definition);
  await act(async()=>{h.browser.document.dispatchEvent(new h.browser.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));trigger.focus();await new Promise(resolve=>setTimeout(resolve,0))});await act(async()=>{await new Promise(setImmediate)});assert.match(h.browser.document.querySelector('[data-slot="tooltip-content"]')?.textContent??'',/合成口径，仅组件验证/);
  await h.render({metric:metric('confirmedCents','999999999999999999999999'),onNavigate:()=>{}});assert.ok(h.host.querySelector('.dashboard-stat-card--long'));assert.match(h.host.textContent,/¥9,999,999,999,999,999,999,999\.99/);
});
test('recent empty/partial/forbidden knowledge states stay distinct and use CardAction for exact drilldown',async t=>{
  const period=data().period,paths=[],h=await mount(t,'RecentTable',{orders:[],period,ordersState:'FORBIDDEN',onNavigate:path=>paths.push(path)});assert.doesNotMatch(h.host.textContent,/本期暂无成交/);assert.equal([...h.host.querySelectorAll('button')].some(b=>b.textContent==='全部订单'),false);
  await h.render({orders:[],period,ordersState:'PARTIAL',onNavigate:path=>paths.push(path)});assert.match(h.host.textContent,/范围未完整核定/);
  await h.render({orders:[],period,ordersState:'KNOWN',onNavigate:path=>paths.push(path)});assert.match(h.host.textContent,/本期暂无成交/);assert.ok(h.host.querySelector('[data-slot="card-action"]'));await act(async()=>[...h.host.querySelectorAll('button')].find(b=>b.textContent==='全部订单').click());assert.equal(new URL(paths[0],'http://fixture').searchParams.get('paymentConfirmedTo'),period.paymentConfirmedTo);
});
test('selected upstream MIT/source records and scoped width/theme rules ship with the actual primitives',()=>{
  const vendor=fs.readFileSync(new URL('../src/vendor/evilcharts/recharts-core.tsx',import.meta.url),'utf8'),license=fs.readFileSync(new URL('../src/vendor/evilcharts/LICENSE',import.meta.url),'utf8'),copying=fs.readFileSync(new URL('../src/vendor/evilcharts/COPYING.md',import.meta.url),'utf8');assert.match(license,/2026 Gurbinder/);assert.match(copying,/4c2dd7c9bae780703244265c9a4b509d40c055ad/);assert.match(vendor,/getPayloadConfigFromPayload/);assert.doesNotMatch(vendor,/Math\.random|getLoadingData|frosted-glass/);
  const css=fs.readFileSync(new URL('../src/components/dashboard/dashboard.css',import.meta.url),'utf8');assert.match(css,/repeat\(2, minmax\(0, 1fr\)\)/);assert.match(css,/dashboard-stat-card--long/);
});

test('static action tooltips are keyboard reachable without overriding explicit or hidden triggers',async t=>{
  const props={content:'完整账号名称',delay:0,children:createElement('span',{'data-probe':'text'},'截断名称')},h=await mount(t,'ActionTooltip',props);
  const text=h.host.querySelector('[data-probe="text"]');assert.equal(text.tabIndex,0);
  // HappyDOM does not implement keyboard-modality :focus-visible matching.
  const matches=text.matches.bind(text);text.matches=selector=>selector===':focus-visible'?h.browser.document.activeElement===text:matches(selector);
  await act(async()=>{h.browser.document.dispatchEvent(new h.browser.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));text.focus();await new Promise(resolve=>setTimeout(resolve,0))});
  await act(async()=>new Promise(setImmediate));assert.equal(h.browser.document.activeElement,text);assert.match(h.browser.document.querySelector('[data-slot="tooltip-content"]')?.textContent??'',/完整账号名称/);
  await h.render({...props,children:createElement('span',{'data-probe':'explicit',tabIndex:-1},'显式排除')});assert.equal(h.host.querySelector('[data-probe="explicit"]').tabIndex,-1);
  await h.render({...props,children:createElement('span',{'data-probe':'hidden','aria-hidden':true},'装饰')});assert.equal(h.host.querySelector('[data-probe="hidden"]').tabIndex,-1);
  let clicks=0;await h.render({...props,children:createElement('button',{type:'button',onClick:()=>clicks++},'动作')});await act(async()=>h.host.querySelector('button').click());assert.equal(clicks,1);assert.equal(h.host.querySelectorAll('button').length,1);assert.equal(h.host.querySelectorAll('button button').length,0);
});
