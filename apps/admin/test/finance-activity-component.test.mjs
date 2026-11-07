import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=new Window({url:'http://127.0.0.1:4231/finance/records'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','CustomEvent','MutationObserver','ResizeObserver','CSS','localStorage','sessionStorage'])globalThis[key]=key==='window'?browser:browser[key];
Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const vite=await createServer({root:rootPath,configFile:false,plugins:[react()],resolve:{alias:{'@':path.join(rootPath,'src'),'@brand':path.resolve(rootPath,'../../assets/brand')}},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false,watch:null}});
const {FinanceActivity}=await vite.ssrLoadModule('/src/views/finance-activity.tsx');
after(async()=>{await vite.close();await browser.happyDOM.abort();});
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
async function waitFor(check){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('finance activity timed out');await settle();}}
async function mount(t,kind,items,{permissions=['finance.read','finance.document.read','user.directory.read'],query={},waitForItems=true,total=items.length}={}){
 const prior=globalThis.fetch,requests=[],opened=[],host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);
 const snapshot={authenticated:true,adminUserId:'admin',user:{name:'管理员'},security:{status:'ACTIVE',isBoss:true,passwordChangeRequired:false},session:{id:'session',locked:false},permissions};
 globalThis.fetch=async(url,options)=>{assert.equal(options.method,'GET');requests.push(String(url));const body=String(url).includes('/users/')?{user:{name:'用户一',displayUsername:'U001',accountStatus:'ACTIVE',identityStatus:'UNVERIFIED'}}:{asOf:'2026-11-06T01:00:00.000Z',page:1,pageSize:20,total,hasMore:total>20,items};return new Response(JSON.stringify(body),{status:200});};
 const props={tab:{id:kind,kind,query,path:kind==='finance-balances'?'/finance/balances':'/finance/records'},snapshot,onOpenPath:(...args)=>opened.push(args),onQueryChange(){},onRefresh:async()=>snapshot,refreshNonce:0};
 await act(async()=>root.render(createElement(FinanceActivity,props)));if(waitForItems)await waitFor(()=>requests.length>0&&host.querySelector('tbody'));else await settle();
 t.after(async()=>{globalThis.fetch=prior;await act(async()=>root.unmount());host.remove();});
 return {host,props,opened,requests,render:async()=>{await act(async()=>root.render(createElement(FinanceActivity,props)));}};
}

test('balance page defaults to current movements and offers separate history and opening pages',async t=>{
 const ui=await mount(t,'finance-balances',[
  {id:'new',source:'NATIVE',label:'提现扣除',subjectId:'u1',subjectName:'用户一',documentRef:'JOINPAY_WITHDRAWAL:one',amountCents:'-2000',occurredAt:null},
 ]);
 assert.match(ui.host.textContent,/查看旧平台记录/);assert.match(ui.host.textContent,/查看迁移期初/);assert.match(ui.host.textContent,/提现扣除/);assert.match(ui.host.textContent,/−20\.00 元/);
 assert.ok(ui.host.querySelector('[aria-label="变动类型"]'));assert.ok(ui.host.querySelector('[aria-label="选择发生日期"]'));assert.ok(ui.host.querySelector('[aria-label="预览用户 用户一"]'));assert.doesNotMatch(ui.host.querySelector('tbody tr').textContent,/u1/);
 await act(async()=>ui.host.querySelector('[aria-label="预览用户 用户一"]').click());await waitFor(()=>ui.requests.some(path=>path.includes('/users/u1')));
 assert.match(ui.requests[0],/activity\/balances/);assert.match(ui.requests[0],/view=LIVE/);assert.equal([...ui.host.querySelectorAll('button')].some(button=>button.textContent.trim()==='查看'),false);
 const history=[...ui.host.querySelectorAll('button')].find(button=>button.textContent.trim()==='查看旧平台记录');await act(async()=>history.click());assert.equal(ui.opened[0][0],'/finance/balances/history');
 ui.props.snapshot={...ui.props.snapshot,permissions:[]};await ui.render();assert.match(ui.host.textContent,/没有完整资金读取权限/);assert.doesNotMatch(ui.host.textContent,/提现扣除/);
});

test('history page shows the old recorded balance as trace data',async t=>{
 const history=await mount(t,'finance-balance-history',[{id:'old',source:'LEGACY',label:'号主租赁收入',subjectId:'u1',subjectName:'用户一',documentRef:'HISTORY_EARNINGS:one',amountCents:'1000',occurredAt:null,balanceAfterCents:'9000'}]);
 assert.match(history.requests[0],/view=HISTORY/);assert.match(history.host.textContent,/旧站记录余额/);assert.match(history.host.textContent,/90\.00 元/);assert.match(history.host.textContent,/不重复计入当前余额/);
 assert.ok(history.host.querySelector('[aria-label="变动类型"]'));assert.ok(history.host.querySelector('[aria-label="选择发生日期"]'));
});

test('opening page puts the user first and displays zero as a balance rather than income',async t=>{
 const opening=await mount(t,'finance-balance-opening',[{id:'opening',source:'OPENING',label:'迁移期初',subjectId:'u1',subjectName:'用户一',documentRef:null,amountCents:'0',occurredAt:null}]);
 assert.match(opening.requests[0],/view=OPENING/);assert.equal(opening.host.querySelector('thead th').textContent,'用户');assert.match(opening.host.textContent,/期初余额/);assert.match(opening.host.textContent,/0\.00 元/);assert.doesNotMatch(opening.host.textContent,/\+0\.00/);
 assert.equal(opening.host.querySelector('[aria-label="变动类型"]'),null);assert.equal(opening.host.querySelector('[aria-label="选择发生日期"]'),null);
 const nonzero=[...opening.host.querySelectorAll('button')].find(button=>button.textContent.trim()==='仅看非零余额');assert.equal(nonzero.getAttribute('aria-pressed'),'false');await act(async()=>nonzero.click());await waitFor(()=>opening.requests.length>1);assert.match(opening.requests.at(-1),/nonzero=1/);
});

test('native channel page shows request fields and provides paginated access to historical records',async t=>{
 const ui=await mount(t,'finance-records',[
  {id:'new',source:'NATIVE',kind:'WITHDRAWAL',subjectId:'u1',subjectName:'用户一',documentRef:'JOINPAY_WITHDRAWAL:one',number:'N456',state:'SUCCEEDED',amountCents:'950',grossCents:'1000',feeCents:'50',amountLabel:'渠道出款金额',occurredAt:null},
 ],{total:120});
 assert.match(ui.requests[0],/activity\/channels/);assert.match(ui.requests[0],/source=NATIVE/);assert.match(ui.host.textContent,/提交不代表渠道已收到或到账/);assert.doesNotMatch(ui.host.textContent,/查询尝试/);assert.match(ui.host.textContent,/渠道出款金额/);assert.match(ui.host.textContent,/手续费 0\.50 元/);
 assert.equal(ui.host.querySelector('[aria-label="请求类型"]'),null);const history=[...ui.host.querySelectorAll('button')].find(button=>button.textContent.trim()==='查看旧平台记录');await act(async()=>history.click());assert.equal(ui.opened[0][0],'/finance/records/history');
 assert.ok(ui.host.querySelector('[aria-label="选择发生日期"]'));
 assert.match(ui.host.textContent,/共 120 条记录/);assert.ok(ui.host.querySelector('[aria-label="页码列表"]'));assert.ok(ui.host.querySelector('[aria-label="每页容量"]'));assert.ok(ui.host.querySelector('[aria-label="跳转页码"]'));
 const jump=ui.host.querySelector('[aria-label="跳转页码"]');await act(async()=>{Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype,'value').set.call(jump,'4');jump.dispatchEvent(new browser.Event('input',{bubbles:true}));});
 const jumpButton=[...ui.host.querySelectorAll('button')].find(button=>button.textContent.trim()==='跳转');await act(async()=>jumpButton.click());await waitFor(()=>ui.requests.length>1);
 const request=new URL(ui.requests.at(-1),browser.location.href);assert.equal(request.searchParams.get('page'),'4');assert.equal(request.searchParams.get('asOf'),'2026-11-06T01:00:00.000Z');
});

test('simulated payments are clearly separated from channel facts and offer no fabricated detail',async t=>{
 const ui=await mount(t,'finance-records',[
  {id:'demo',source:'NATIVE',kind:'PAYMENT',dataOrigin:'ECS_TEST_SIMULATED',bankArrival:'UNKNOWN',subjectId:'u1',subjectName:'用户一',documentRef:null,number:'demo-1',relatedNumber:'order-1',relatedNumberLabel:'关联订单',state:'SIMULATED',amountCents:'1250',amountLabel:'模拟金额（未发生汇聚收款）',occurredAt:null},
  {id:'uncertain',source:'NATIVE',kind:'PAYMENT',dataOrigin:'ECS_TEST_SIMULATED',subjectId:'u1',subjectName:'用户一',documentRef:null,number:'demo-2',state:'SIMULATED',amountCents:'100',occurredAt:null},
 ]);
 const rows=ui.host.querySelectorAll('tbody tr');assert.equal(rows.length,2);
 assert.match(rows[0].textContent,/模拟收款/);assert.match(rows[0].textContent,/模拟成功/);assert.match(rows[0].textContent,/模拟金额（未发生汇聚收款）/);
 assert.match(rows[0].textContent,/模拟编号 demo-1/);assert.equal(rows[0].querySelector('button')?.textContent.trim(),'用户一');
 assert.match(rows[1].textContent,/模拟结果待核/);assert.doesNotMatch(rows[1].textContent,/模拟成功|渠道成功|到账/);
 assert.equal(ui.opened.length,0);
});

test('historical channel page uses old fields and keeps original status separate from channel proof',async t=>{
 const ui=await mount(t,'finance-record-history',[{id:'old',source:'LEGACY',kind:'REFUND',subjectId:'u1',subjectName:'用户一',documentRef:'HISTORY_REFUND:one',number:'R123',state:'旧平台记为退款成功',amountCents:'1000',amountLabel:'旧平台记录金额',occurredAt:null}]);
 assert.match(ui.requests[0],/source=LEGACY/);assert.match(ui.host.textContent,/旧平台状态为原系统记录/);assert.match(ui.host.textContent,/旧平台记为退款成功/);assert.equal(ui.host.querySelector('[aria-label="请求类型"]'),null);assert.match(ui.host.textContent,/返回资金记录/);
});

test('document-only users see a prompt before searching and never see the full list by default',async t=>{
 const ui=await mount(t,'finance-records',[],{permissions:['finance.document.read'],waitForItems:false});
 assert.equal(ui.requests.length,0);assert.match(ui.host.textContent,/输入完整资金单号查询/);assert.doesNotMatch(ui.host.textContent,/正在读取记录/);
});

test('document-only users can search a record by its complete number',async t=>{
 const ui=await mount(t,'finance-records',[{id:'one',source:'LEGACY',kind:'REFUND',subjectId:'u1',subjectName:'用户一',documentRef:'HISTORY_REFUND:one',number:'PAY-123',state:'旧平台记录',amountCents:'100',occurredAt:null}],{permissions:['finance.document.read'],query:{q:'PAY-123'}});
 assert.match(ui.requests[0],/q=PAY-123/);assert.match(ui.host.textContent,/PAY-123/);
});
