import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const requireHere=createRequire(path.join(tree,'package.json'));
const ts=requireHere('typescript'),React=requireHere('react'),{Window}=requireHere('happy-dom');
const {createRoot}=requireHere('react-dom/client');

function loadOrderView(probe){
 const file=path.join(tree,'apps/admin/src/views/admin-order-chain-view.tsx'),m=new Module(file);
 m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
 const box=({children})=>React.createElement('div',null,children),empty=()=>null;
 const button=({children,onClick,...props})=>React.createElement('button',{onClick,disabled:props.disabled},children);
 const ui=new Proxy({}, {get:(_target,key)=>key==='Button'?button:box});
 const modules={
  '../api':{adminRequest:async p=>p.includes('/im?')?(probe.order.source.origin==='LEGACY'?{teamState:null,canRead:false}:{teamState:'READY',canRead:true}):{order:probe.order},friendlyError:e=>String(e),AdminApiError:class extends Error{}},
  './admin-finance-api':{defaultFinanceFilters:()=>({}),financeRead:async p=>({document:{ref:decodeURIComponent(p.slice('documents/'.length))},legacyOrderObservations:[]})},
  './admin-finance-view':{financeContextIdentity:()=>({}),financeOriginPath:()=>null,registerFinanceOrigin:()=> 'origin'},
  '../workspace/tab-model':{sanitizeFinanceReturn:()=>null},
  '../workspace/beijing-time':{BEIJING_TIME_ZONE:'Asia/Shanghai'},
  './supply-review/model':{accountNumberLabel:v=>v??'未记录',formatFundingCents:v=>v??'未知',formatTermDays:()=>'',quantityText:v=>v??'',unitText:()=>''},
  './admin-order-stages':{OrderStages:empty,ORDER_STATUS_LABELS:{PAID:'进行中',COMPLETED:'已完成'}},
  './admin-order-schedule':{AdminOrderSchedule:empty},
  '../components/admin-preview':{EntityPreviewTrigger:({trigger})=>trigger,AccountPreviewCard:empty,UserPreviewCard:empty},
  '@/hooks/use-mobile':{useIsMobile:()=>false},
  './admin-order-settlement-evidence':{AdminOrderSettlementEvidence:empty},
  './order-finance-tab':{OrderFinanceTab:empty},
  './order-compensation-panel':{OrderCompensationPanel:empty},
  './distribution-order-model':{parseDistributionOrder:()=>{throw Error('no distribution fixture')}},
  './admin-order-upper-resources':{orderUpperResources:()=>({rows:[],recordedLabel:'数量',consumedLabel:'消耗'})},
  './admin-order-fulfillment-timeline':{OrderFulfillmentTimeline:empty},
  '../components/ui/alert-dialog':{ConfirmAlertDialog:empty},
  './admin-order-payment-summary':{AdminOrderPaymentSummary:empty},
  './admin-channel-evidence-panel':{OrderChannelEvidence:empty},
  './legacy-continuation-panel':{LegacyAdminContinuationPanel:empty},
  './im-support-fulfillment':{OrderFulfillmentSection:empty,SupportUnpaidCancelCard:empty},
  './admin-joinpay-ops-panel':{AdminCollectionQueryBox:empty,AdminNativeRefundPanel:empty,normalRefundBasis:()=>({})},
  './admin-prestart-termination-panel':{AdminPrestartTerminationPanel:empty},
  './admin-original-refund-panel':{AdminOriginalRefundPanel:empty},
  './supply-listing-review-view':{SupplyListingReviewView:empty},
  '../components/dashboard/domain-summary-block':{DomainSummaryBlock:empty},
  '../components/dashboard/domain-summary-model':{readDomainSummary:async()=>({})},
 };
 m.require=name=>{
  if(name.endsWith('.css'))return {};
  if(name==='react')return React;
  if(name==='react/jsx-runtime')return requireHere('react/jsx-runtime');
  if(name==='lucide-react')return new Proxy({}, {get:()=>empty});
  if(Object.hasOwn(modules,name))return modules[name];
  if(name.startsWith('@/components/')||name==='../components/ui/alert')return ui;
  return requireHere(name);
 };
 m._compile(ts.transpileModule(readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 return m.exports.AdminOrderChainView;
}

test('legacy detail offers a new group without a native channel entry; native detail retains its own entries',async t=>{
 const browser=new Window({url:'http://127.0.0.1:4311'});
 Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Element:browser.Element,Node:browser.Node,Event:browser.Event,
  CustomEvent:browser.CustomEvent,MutationObserver:browser.MutationObserver,ResizeObserver:browser.ResizeObserver,CSS:browser.CSS,
  getComputedStyle:browser.getComputedStyle.bind(browser),requestAnimationFrame:browser.requestAnimationFrame.bind(browser),cancelAnimationFrame:browser.cancelAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
 const probe={order:null},View=loadOrderView(probe),host=browser.document.createElement('div'),root=createRoot(host),opened=[];browser.document.body.append(host);
 t.after(async()=>{await React.act(async()=>root.unmount());host.remove();await browser.happyDOM.abort();});
 const snapshot={authenticated:true,adminUserId:'admin',session:{id:'session'},security:{isBoss:false},permissions:['order.read','finance.read','im.support.read','im.support.accept']};
 const base={id:'order_native',displayNo:'ORDER-1',status:'PAID',title:'账号',accountId:'account',accountDisplayNo:'A1',gameId:'game',ownerUserId:'owner',renterUserId:'renter',ownerName:'号主',renterName:'租客',createdAt:null,paidAt:null,
  payment:{state:'RECORDED_PAID',recordedAt:null,recordedAmount:null},amounts:{totalDue:null,rental:null,deposit:null},source:{origin:'NATIVE'}};
 async function render(order,actor=snapshot){probe.order=order;await React.act(async()=>root.render(React.createElement(View,{snapshot:actor,initialOrderId:order.id,objectOnly:true,initialQuery:{section:'finance'},onOpenPath:(...args)=>opened.push(args),refreshNonce:0})));for(let i=0;i<25&&!host.textContent.includes(order.displayNo);i++)await React.act(async()=>new Promise(resolve=>setTimeout(resolve,5)));}
 async function waitForText(text){for(let i=0;i<25&&!host.textContent.includes(text);i++)await React.act(async()=>new Promise(resolve=>setTimeout(resolve,5)));assert.match(host.textContent,new RegExp(text));}
 const legacy={...base,id:'legacy_order_test',displayNo:'OLD-1',source:{origin:'LEGACY'}};
 await render(legacy,{...snapshot,permissions:snapshot.permissions.filter(p=>p!=='im.support.accept')});
 await waitForText('尚未为这笔旧订单建立新群');
 assert(![...host.querySelectorAll('button')].some(b=>b.textContent.includes('创建订单群')));
 await render(legacy);
 await waitForText('尚未为这笔旧订单建立新群');assert.match(host.textContent,/旧渠道依据尚未接入/);
 assert([...host.querySelectorAll('button')].some(b=>b.textContent.includes('创建订单群')));
 assert(![...host.querySelectorAll('button')].some(b=>b.textContent.includes('在汇聚对账查看本单')));
 await render(base);await waitForText('本单群已就绪');const entry=[...host.querySelectorAll('button')].find(b=>b.textContent.includes('在汇聚对账查看本单'));assert.ok(entry);assert.match(host.querySelector('aside.oc-related').textContent,/订单群/);
 await React.act(async()=>entry.click());const target=new URL(opened.at(-1)[0],'http://example.invalid');assert.equal(target.pathname,'/finance/channels');assert.equal(target.searchParams.get('fromOrderId'),'order_native');
});
