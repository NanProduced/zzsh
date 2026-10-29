import { contentFixtureDependency } from "./content-fixture.mjs";
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(testDirectory, "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const typescript = requireFromTree("typescript");
const React = requireFromTree("react");
const { Window } = requireFromTree("happy-dom");
const intents = requireFromTree(path.join(tree, "apps/web/src/lib/order-intents.ts"));
const heroToast = await import("@heroui/react/toast");

function compile(relativePath) {
  const source = fs.readFileSync(path.join(tree, relativePath), "utf8").replace("function ReadyDetail(", "export function ReadyDetail(");
  return typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
}

function loadComponent(relativePath, session, extra) {
  const module = new Module(path.join(tree, "order-trade-component-probe.cjs"));
  module.filename = path.join(tree, "order-trade-component-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "@heroui/react/toast") return heroToast;
    if (name === "next/link") return function Link({ scroll: _scroll, ...props }) { return React.createElement("a", props); };
    if (name === "@/components/session/user-session-provider") return { useUserSession: () => session };
    if (name === "@/lib/order-client") return requireFromTree(path.join(tree, "apps/web/src/lib/order-client.ts"));
    if (name === "@/lib/order-intents") return requireFromTree(path.join(tree, "apps/web/src/lib/order-intents.ts"));
    if (name === "@/lib/order-display") return requireFromTree(path.join(tree, "apps/web/src/lib/order-display.ts"));
    if (name === "@/components/session/identity-reset") return requireFromTree(path.join(tree, "apps/web/src/components/session/identity-reset.ts"));
    if (name === "@/components/order/order-trade-actions") return loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session);
    if (name === "@/components/order/order-presentation") return loadComponent("apps/web/src/components/order/order-presentation.tsx", session);
    if (name === "@/components/order/order-detail") return loadComponent("apps/web/src/components/order/order-detail.tsx", session);
    if (name === "@/components/order/order-list") return loadComponent("apps/web/src/components/order/order-list.tsx", session);
    if (name === "./rental-price-summary") return loadComponent("apps/web/src/components/order/rental-price-summary.tsx", session);
    if (name === "./legacy-continuation-panel") return {LegacyContinuationPanel:()=>null};
    if (name === './prestart-termination-panel'||name === '@/components/order/prestart-termination-panel') return loadComponent('apps/web/src/components/order/prestart-termination-panel.tsx',session,extra);
    if (name === './order-trade-actions') return loadComponent('apps/web/src/components/order/order-trade-actions.tsx',session,extra);
    if (name === '@/lib/prestart-termination-client') return requireFromTree(path.join(tree,'apps/web/src/lib/prestart-termination-client.ts'));
    if (name === '@/lib/personal-wallet-client') return requireFromTree(path.join(tree,'apps/web/src/lib/personal-wallet-client.ts'));
    if (name === "@/components/ui/tooltip") return { Tooltip: props => React.createElement(React.Fragment, null, props.children), TooltipTrigger: props => React.createElement(React.Fragment, null, props.children), TooltipContent: () => null };
    if (extra && Object.hasOwn(extra, name)) return extra[name];
    if (name === "@/lib/account-title") return loadComponent("apps/web/src/lib/account-title.ts", session);
    if (name === "@/lib/listing-filters" || name === "./listing-filters") return loadComponent("apps/web/src/lib/listing-filters.ts", session);
    if (name === "@/lib/supply-games" || name === "./supply-games.ts") return loadComponent("apps/web/src/lib/supply-games.ts", session);
    if (name.endsWith(".css")) return {};
    return requireFromTree(name);
  };
  module.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(module.require.bind(module));
 module._compile(compile(relativePath), module.filename);
  return module.exports;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((next) => { resolve = next; }); return { promise, resolve }; }

async function withDom(run) {
  const window = new Window({ url: "http://127.0.0.1/accounts" });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Element: window.Element, Node: window.Node,
    NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, CustomEvent: window.CustomEvent, DOMException: window.DOMException,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  try { await run(window); } finally { await window.happyDOM.abort(); }
}

function createProbe(window, Component, props, fetchImpl, { strict = false } = {}) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = requireFromTree("react-dom/client").createRoot(host);
  const render = async (nextProps = props) => {
    const element = React.createElement(Component, nextProps);
    await React.act(async () => { root.render(strict ? React.createElement(React.StrictMode, null, element) : element); });
    await tick();
  };
  const buttons = () => [...host.querySelectorAll("button")].map((button) => button.textContent ?? "");
  const click = async (text) => {
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
    assert.ok(button, `button not found: ${text}; have ${JSON.stringify(buttons())}; text=${host.textContent?.slice(0, 300)}`);
    await React.act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 })); await tick(); });
    await tick();
  };
  const setInput = async (label, value) => {
    const input = host.querySelector(`[aria-label="${label}"]`);
    assert.ok(input, `input not found: ${label}`);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    await React.act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    await tick();
    return input;
  };
  const unmount = async () => { await React.act(async () => root.unmount()); await tick(); };
  const dispose = async (removeIntent) => {
    await unmount();
    globalThis.fetch = previousFetch;
    if (removeIntent) removeIntent();
  };
  return { host, render, click, setInput, unmount, dispose, buttons };
}

const orderClient = requireFromTree(path.join(tree, "apps/web/src/lib/order-client.ts"));
const OrderRequestError = orderClient.OrderRequestError;
const money = (amount) => ({ currency: "CNY", unit: "yuan", scale: 2, amount });
const haffLine = { itemId: "item_haff", name: "哈夫币", unit: "HAFF_BASE", quantity: "1000", buyerAmount: money("150.00") };
const pieceLine = { itemId: "item_piece", name: "测试物品", unit: "PIECE", quantity: "10", buyerAmount: money("20.00") };
const paidOrder = {
  id: "order_A", displayNo: "ZZ-1", title: "交易闭环样本", status: "PAID",
  amounts: { rental: money("170.00"), deposit: money("300.00"), totalDue: money("470.00") },
  quote: { lines: [haffLine, pieceLine] },
};
const opening = {
  id: "opening_1", versionNo: "1", status: "CONFIRMED",
  lines: [
    { itemId: "item_haff", quantity: "1000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO" },
    { itemId: "item_piece", quantity: "10", unit: "PIECE", pricingKind: "FIXED_UNIT" },
  ],
  acks: [{ party: "RENTER" }, { party: "OWNER" }],
};
const settlementBody = { orderId: "order_A", rentalStarted: true, openings: [opening], intakes: [], versions: [], currentRequest: null, settlement: null, posting: null, ready: false, reasons: ["SETTLEMENT_REQUIRED"] };
const previewBody = {
  accepted: false, reasons: [], versionHash: "f".repeat(64),
  amounts: { haffConsumedBuyer: money("150.00"), itemConsumedBuyer: money("4.00"), unusedItemRefund: money("16.00"), unusedHaffRefund: money("0.00"), earlyMakeup: money("0.00"), renterCharge: money("154.00"), renterRefund: money("316.00"), depositRefund: money("300.00"), feeAmount: money("9.84"), feeRate: "0.08", feePayer: "OWNER", haffConsumedOwner: money("120.00"), itemConsumedOwner: money("3.00"), ownerGross: money("123.00"), ownerNet: money("113.16") },
  consumed: { haff: "1000", items: [{ itemId: "item_piece", consumed: "2", remaining: "8" }] },
};

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

function router(routes, log) {
  return async (url, init = {}) => {
    const target = String(url);
    const method = (init.method ?? "GET").toUpperCase();
    const key = init.headers?.get?.("idempotency-key") ?? undefined;
    const entry = { url: target, method, key, body: init.body ? JSON.parse(init.body) : undefined };
    log.push(entry);
    const route = routes.find((candidate) => target.includes(candidate.match) && candidate.method === method);
    assert.ok(route, `unexpected fetch ${method} ${target}`);
    return route.respond(entry);
  };
}

const session = (userId) => ({ status: "authenticated", userId, identityVersion: 1, revalidate() {}, confirm: async () => "authenticated", signOut: async () => undefined });

test('未开租结束组件只读原责任/未知退款，不显示正常结算或银行到账成功',async()=>withDom(async window=>{
 const current=session('user_A'),{PrestartTerminationPanel}=loadComponent('apps/web/src/components/order/prestart-termination-panel.tsx',current),calls=[];
 const at='2026-10-28T00:00:00.000000Z',read={contractVersion:'order-prestart-termination.v1',orderId:'order_A',orderRevision:'2',eligibility:{allowed:false,reason:'ORDER_NOT_PAID',refundCents:null},
  request:{id:'term_1',revision:'2',state:'APPROVED',requestedByParty:'RENTER',reason:'申请未交付结束',reviewReason:'核实无争议',createdAt:at,updatedAt:at,approvedAt:at,
   fullRefundCents:'15908',currency:'CNY',dataOrigin:'JOINPAY_LOCAL_ACCEPTANCE',liabilityRecognized:true,channelSubmission:'NOT_REPORTED',bankArrival:'UNKNOWN'},
  refund:{integration:'INTEGRATED',truncated:false,reason:null,channelRecordsChecked:false,bankArrival:'UNKNOWN',totals:{originalCents:'15908',allocatedCents:'15908',consumedCents:'0',releasedCents:'0',remainingCents:'0',totalsComplete:true},
   intents:[{intentId:'refund_1',refundOrderNo:'RF'+'a'.repeat(28),state:'UNKNOWN',amountCents:'15908',firstSubmit:'DISPATCHED',blockedReason:null,localWriteOff:'NOT_RECORDED',savedChannelEvidence:null,bankArrival:'UNKNOWN'}]},
  coverage:'LOCAL_REGISTERED_ONLY',asOf:at,localAcceptanceObservedAt:at,unknowns:['BANK_ARRIVAL_NOT_VERIFIED'],bankArrival:'UNKNOWN'};
 const probe=createProbe(window,PrestartTerminationPanel,{order:{...paidOrder,status:'CANCELLED'},party:'renter',onChanged(){}},async(url,init)=>{calls.push({url,init});return json(read);});
 try{await probe.render();assert.equal(calls.length,1);assert.match(probe.host.textContent,/159\.08/);assert.match(probe.host.textContent,/按原号恢复/);assert.match(probe.host.textContent,/尚未分配/);assert.match(probe.host.textContent,/银行到账未核定/);assert.equal(probe.host.querySelector('form'),null);assert(calls.every(c=>!c.init?.method||c.init.method==='GET'));}
 finally{await probe.dispose();}
}));
test('未开租申请202未知保留同一原键/body，恢复不按编辑内容重建',async()=>withDom(async window=>{
 const current=session('user_A'),{PrestartTerminationPanel}=loadComponent('apps/web/src/components/order/prestart-termination-panel.tsx',current),posts=[];
 const read={contractVersion:'order-prestart-termination.v1',orderId:'order_A',orderRevision:'1',eligibility:{allowed:true,reason:null,refundCents:'15908'},request:null,refund:null,
  coverage:'LOCAL_REGISTERED_ONLY',asOf:'2026-10-28T00:00:00.000000Z',localAcceptanceObservedAt:null,unknowns:['BANK_ARRIVAL_NOT_VERIFIED'],bankArrival:'UNKNOWN'};
 const probe=createProbe(window,PrestartTerminationPanel,{order:paidOrder,party:'renter',onChanged(){}},async(url,init)=>{
  if(init?.method==='POST'){posts.push(init);return json({contractVersion:'order-prestart-termination.v1',orderId:'order_A',outcome:'UNKNOWN',originalKeyRequired:true},202);}return json(read);});
 try{await probe.render();const field=probe.host.querySelector('textarea');await React.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(field,'未交付申请结束');field.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();});
  await React.act(async()=>{probe.host.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await tick();});
  assert.equal(posts.length,1);const original=intents.loadIntent('user_A','order.prestart.request','order_A');assert.ok(original);assert.equal(original.body.reason,'未交付申请结束');
  await React.act(async()=>{probe.host.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await tick();});
  assert.equal(posts.length,2);assert.equal(posts[0].body,posts[1].body);assert.equal(new Headers(posts[0].headers).get('idempotency-key'),new Headers(posts[1].headers).get('idempotency-key'));
 }finally{await probe.dispose(()=>intents.clearIntent('user_A','order.prestart.request','order_A'));}
}));

// SYNTHETIC_COMPONENT_MODEL：只验证真实组件与本地API替身，不能当渠道付款或浏览器验收。
const channelOrder={...paidOrder,status:"PENDING_PAYMENT",paymentOpen:true,cancelOpen:true,expiredAwaitingCancel:false};
const channelView=(id="order_A",over={})=>({contractVersion:"order-payment-request.v1",dataOrigin:"SYNTHETIC_PROTOCOL",
  capability:{channelEnabled:true,productionPaymentCapability:true,methods:["ALIPAY_NATIVE","WEIXIN_NATIVE"],evidenceProfile:"JOINPAY_AGG_2_6_MD5"},
  order:{id,displayNo:"SYNTHETIC",status:"PENDING_PAYMENT",paidAt:null},request:null,projection:{displayState:"NOT_STARTED",actionBlockedReason:"NO_REQUEST"},paymentAction:null,payment:null,...over});
const channelRequest=(state="ACTION_READY",method="WEIXIN_NATIVE")=>({id:"payreq_component",state,method,amount:{cents:"125",currency:"CNY"},updatedAt:"2026-10-24T10:00:00.000Z",recovery:null});
const channelReceipt=(method,replay=false,state="SUBMITTING")=>({contractVersion:"order-payment-request.v1",dataOrigin:"JOINPAY_CANDIDATE",replay,
  request:{...channelRequest(state,method),orderId:"order_A",createdAt:"2026-10-24T10:00:00.000Z"},paymentAction:null,payment:null});
const refundRead=(orderId="order_A",over={})=>({contractVersion:"personal-native-refunds.v1",subjectId:"user_A",
  order:{orderId,displayNo:"ZZ-1",status:"PAID"},status:"NOT_APPLICABLE",outcome:"RESPONSIBILITY_NOT_POSTED",
  coverage:{scope:"LOCAL_REGISTERED_ONLY",intentLimit:50,intentsComplete:true,channelRecordsChecked:false},asOf:"2026-10-27T02:30:17.490161Z",
  responsibility:{state:"NOT_POSTED",postingId:null,originalCents:null,allocatedCents:null,consumedCents:null,releasedCents:null,remainingCents:null,totalsComplete:false,dueAt:null,dueState:"UNKNOWN"},
  intents:[],returnedIntentCount:0,intentsTruncated:false,
  actualChannelRefund:{amountCents:null,channelRefundTrxNo:null,completedAt:null,destination:null,bankArrival:"UNKNOWN",reasonCodes:[]},
  localFundsEffect:{basis:"LOCAL_REGISTERED_ACCOUNTING",writtenOffCents:null,releasedCents:null,bankArrival:"UNKNOWN"},
  reasonCodes:[],unknowns:["CHANNEL_REFUND_RECORD_NOT_CHECKED","BANK_ARRIVAL_UNKNOWN","REFUND_DESTINATION_NOT_PROJECTED"],...over});
const refundIntent=(over={})=>({intentId:"intent_refund_1",refundOrderNo:"RF"+"a".repeat(28),source:"JOINPAY_FORMAL",evidenceLevel:"JOINPAY_FORMAL",
  amount:{cents:"28000",currency:"CNY"},state:"SUCCEEDED",budgetDisposition:"CONSUMED",requiresReview:false,dueAt:"2026-10-19T04:30:00Z",createdAt:"2026-10-18T04:30:00Z",updatedAt:"2026-10-18T05:30:00Z",
  latestObservation:null,latestFailure:null,
  savedChannelEvidence:{terminal:"SUCCEEDED",evidenceLevel:"JOINPAY_FORMAL",providerRefundTrxNo:"RF-TRX-1",completedAt:"2026-10-18T05:30:00Z",trust:"SAVED_EVIDENCE_NOT_REVALIDATED"},
  localAccounting:{disposition:"CONSUMED",writeOff:{eventId:"event_refund",amountCents:"28000",postedAt:"2026-10-18T05:30:00Z",trust:"LOCAL_LEDGER"},release:null,reasonCodes:[]},
  channelFacts:{actualAmountCents:null,channelRefundTrxNo:null,completedAt:null,destination:null,bankArrival:"UNKNOWN",reasonCodes:[]},reasonCodes:[],...over});
async function chooseChannel(window,probe,value){const select=probe.host.querySelector('select[aria-label="支付方式"]');assert.ok(select);await React.act(async()=>{select.value=value;select.dispatchEvent(new window.Event("change",{bubbles:true}));await tick();});}

test("Native UI selects method, persists a request, reads its action and waits for an actual APPLIED projection",async()=>{
 await withDom(async window=>{
  let phase="NEW",changed=0;const calls=[];
  const view=()=>channelView("order_A",phase==="NEW"?{}:phase==="ACTION"?{dataOrigin:"JOINPAY_CANDIDATE",request:channelRequest(),projection:{displayState:"AWAITING_PAYMENT",actionBlockedReason:null},paymentAction:{kind:"QR_URL",url:"https://example.invalid/synthetic-pay",expiresAt:null,expiryKnown:false}}:
   {dataOrigin:"JOINPAY_PROVIDER",request:channelRequest("ACCEPTED"),order:{id:"order_A",displayNo:"SYNTHETIC",status:"PAID",paidAt:"2026-10-24T10:00:01.000Z"},payment:{confirmationId:"formal_component_fact",disposition:"APPLIED",reasonCode:null,amount:{cents:"125",currency:"CNY"},acceptedAt:"2026-10-24T10:00:01.000Z"}});
  const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){changed++;}},async(url,init={})=>{
   calls.push({url:String(url),method:init.method??"GET",key:new Headers(init.headers).get("idempotency-key"),body:init.body});
   assert.match(String(url),/\/channel-payment-requests$/);
   if(init.method==="POST"){const body=JSON.parse(init.body);assert.deepEqual(body,{method:"WEIXIN_NATIVE"});assert.equal(intents.loadIntent("user_A","order.channel-payment","order_A").key,new Headers(init.headers).get("idempotency-key"));phase="ACTION";return json(channelReceipt(body.method),202);}
   return json(view());
  });
  try{
   await probe.render();await chooseChannel(window,probe,"WEIXIN_NATIVE");await probe.click("获取支付参数");
   assert.equal(calls.filter(c=>c.method==="POST").length,1);assert.equal(changed,0);assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳/);
   const link=probe.host.querySelector('.order-channel-payment a');assert.equal(link?.getAttribute("href"),"https://example.invalid/synthetic-pay");assert.equal(link?.getAttribute("rel"),"noopener noreferrer");assert.match(probe.host.textContent,/1\.25/);assert.ok(probe.host.querySelector('svg[aria-label="本单支付二维码"]'));
   assert.equal(intents.loadIntent("user_A","order.channel-payment","order_A"),null);assert.equal(intents.loadIntent("user_A","order.payment","order_A"),null);
   phase="PAID";await probe.click("刷新支付状态");assert.match(probe.host.textContent,/渠道付款已接纳/);assert.equal(changed,1);assert.equal(calls.filter(c=>c.method==="POST").length,1);assert.equal([...probe.host.querySelectorAll("button")].find(b=>b.textContent==="取消订单")?.disabled,true);
  }finally{await probe.dispose(()=>intents.clearIntent("user_A","order.channel-payment","order_A"));}
 });
});

test("Native UI unknown POST restores exactly its old key/method even after new collection is closed",async()=>{
 await withDom(async window=>{
  let posts=0;const writes=[];const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async(url,init={})=>{
   assert.match(String(url),/\/channel-payment-requests$/);
   if(init.method==="POST"){posts++;writes.push({key:new Headers(init.headers).get("idempotency-key"),body:init.body});if(posts===1)throw new TypeError("synthetic response lost");return json(channelReceipt("WEIXIN_NATIVE",true,"UNKNOWN"),202);}
   return json(posts?channelView("order_A",{dataOrigin:"JOINPAY_CANDIDATE",capability:{channelEnabled:false,productionPaymentCapability:false,methods:["ALIPAY_NATIVE","WEIXIN_NATIVE"]},request:channelRequest("UNKNOWN"),projection:{displayState:"CONFIRMING",actionBlockedReason:"CHANNEL_RESULT_UNKNOWN"}}):channelView());
  });
  try{
   await probe.render();await chooseChannel(window,probe,"WEIXIN_NATIVE");await probe.click("获取支付参数");
   assert.match(probe.host.textContent,/回执尚未确认/);const original=intents.loadIntent("user_A","order.channel-payment","order_A");assert.equal(original.body.method,"WEIXIN_NATIVE");
   await probe.click("恢复原请求回执");assert.equal(posts,2);assert.equal(writes[0].key,writes[1].key);assert.equal(writes[0].body,writes[1].body);
   assert.equal(intents.loadIntent("user_A","order.channel-payment","order_A"),null);assert.match(probe.host.textContent,/支付结果正在确认/);assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳/);
  }finally{await probe.dispose(()=>intents.clearIntent("user_A","order.channel-payment","order_A"));}
 });
});

test("Native UI drops the old order/identity response instead of showing another subject's payment",async()=>{
 await withDom(async window=>{
  const late=deferred(),identity=session("user_A");let reads=0;
  const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",identity).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async(url)=>{
   reads++;if(String(url).includes("/order_A/"))return late.promise;return json(channelView("order_B"));
  });
  try{
   await probe.render();assert.equal(reads,1);identity.userId="user_B";identity.identityVersion++;
   await probe.render({order:{...channelOrder,id:"order_B"},party:"renter",onChanged(){}});assert.ok(probe.host.querySelector('select[aria-label="支付方式"]'));
   await React.act(async()=>{late.resolve(json(channelView("order_A",{dataOrigin:"JOINPAY_PROVIDER",payment:{disposition:"APPLIED",confirmationId:"old_private_fact",amount:{cents:"125",currency:"CNY"},acceptedAt:"2026-10-24T10:00:01.000Z"}})));await tick();});
   assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳|old_private_fact/);assert.ok(probe.host.querySelector('select[aria-label="支付方式"]'));assert.equal(reads,2);
  }finally{await probe.dispose();}
 });
});

test("Native UI never turns accepted request state, unsafe action URLs or unknown amounts into proof or a payable link",async()=>{
 await withDom(async window=>{
  let current=channelView("order_A",{dataOrigin:"JOINPAY_CANDIDATE",request:channelRequest("ACCEPTED"),projection:{displayState:"PAID",actionBlockedReason:null},paymentAction:{kind:"QR_URL",url:"https://example.invalid/synthetic",expiresAt:null,expiryKnown:false}});
  const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async()=>json(current));
  try{
   await probe.render();assert.match(probe.host.textContent,/付款依据待确认/);assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳/);assert.equal(Boolean(probe.host.querySelector('.order-channel-payment a')),false);
   for(const url of ["http://example.invalid/pay","https://user:password@example.invalid/pay","javascript:alert(1)","https://example.invalid/pay#secret","https://example.invalid/pay\n?request=changed","https://example.invalid/pay path"]){current={...current,request:channelRequest(),paymentAction:{kind:"QR_URL",url,expiresAt:null,expiryKnown:false}};await probe.click("刷新支付状态");assert.equal(Boolean(probe.host.querySelector('.order-channel-payment a')),false);assert.equal(Boolean(probe.host.querySelector('svg[aria-label="本单支付二维码"]')),false);assert.match(probe.host.textContent,/支付参数暂时不可用/);}
   current={...current,request:{...channelRequest(),amount:null},paymentAction:{kind:"QR_URL",url:"https://example.invalid/synthetic-pay",expiresAt:null,expiryKnown:false}};await probe.click("刷新支付状态");assert.equal(Boolean(probe.host.querySelector('.order-channel-payment a')),false);assert.match(probe.host.textContent,/金额：待确认/);assert.match(probe.host.textContent,/支付金额暂时无法确认/);
   current={...current,dataOrigin:"SYNTHETIC_PROTOCOL",request:channelRequest(),paymentAction:{kind:"QR_URL",url:"https://example.invalid/pay",expiresAt:null,expiryKnown:false}};await probe.click("刷新支付状态");assert.equal(Boolean(probe.host.querySelector('.order-channel-payment a')),false);
   current={...current,dataOrigin:"JOINPAY_CANDIDATE",payment:{confirmationId:"review_fact",disposition:"REVIEW_REQUIRED",amount:{cents:"125",currency:"CNY"}}};await probe.click("刷新支付状态");assert.equal(Boolean(probe.host.querySelector('.order-channel-payment a')),false);assert.match(probe.host.textContent,/支付需要人工核对/);
   current={...current,dataOrigin:"JOINPAY_PROVIDER",payment:{confirmationId:"",disposition:"APPLIED",amount:{cents:"125",currency:"CNY"}}};await probe.click("刷新支付状态");assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳/);assert.match(probe.host.textContent,/付款依据待确认/);
  }finally{await probe.dispose();}
 });
});

test("Native UI explains a closed channel capability instead of opening another payable path",async()=>{
 await withDom(async window=>{
  const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async()=>json(channelView("order_A",{dataOrigin:"JOINPAY_CANDIDATE",capability:{channelEnabled:false,productionPaymentCapability:false,methods:["ALIPAY_NATIVE","WEIXIN_NATIVE"]},projection:{displayState:"DISABLED",actionBlockedReason:"CHANNEL_DISABLED"}})));
  try{
    await probe.render();assert.match(probe.host.textContent,/当前环境未开放真实渠道支付/);assert.equal(probe.buttons().some(text=>text.includes("获取支付参数")),false);assert.equal(Boolean(probe.host.querySelector('svg[aria-label="本单支付二维码"]')),false);assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳/);
  }finally{await probe.dispose();}
 });
});

test("Native UI keeps unreadable recovery bytes and blocks new payment/cancel instead of making a replacement key",async()=>{
 await withDom(async window=>{
  const key="zzsh.order-intent.v1:user_A:order.channel-payment:order_A";window.sessionStorage.setItem(key,"{unreadable");let writes=0;
  const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async(_url,init={})=>{if(init.method==="POST")writes++;return json(channelView());});
  try{await probe.render();assert.match(probe.host.textContent,/恢复记录无法读取/);assert.equal(probe.buttons().some(t=>t.includes("获取支付参数")),false);const cancel=[...probe.host.querySelectorAll("button")].find(b=>b.textContent==="取消订单");assert.equal(cancel?.disabled,true);await probe.click("刷新支付状态");assert.equal(writes,0);assert.equal(window.sessionStorage.getItem(key),"{unreadable");}
  finally{await probe.dispose(()=>window.sessionStorage.removeItem(key));}
 });
});

test("Native readiness never relabels an existing controlled payment as provider payment",async()=>{
 await withDom(async window=>{
  let reads=0;const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async()=>{reads++;return json(channelView("order_A",{dataOrigin:"LOCAL_CONTROLLED",payment:{confirmationId:"controlled_fact",disposition:"APPLIED",amount:{cents:"125",currency:"CNY"}}}));});
  try{await probe.render();assert.equal(reads,1);assert.match(probe.host.textContent,/本地受控收款入口/);assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳/);assert.equal(probe.buttons().some(t=>t.includes("获取支付参数")),false);}
  finally{await probe.dispose();}
 });
});

test("Native malformed POST receipt preserves its original intent instead of acknowledging another source or lossy amount",async()=>{
 for(const corrupt of [r=>({...r,dataOrigin:"LOCAL_CONTROLLED"}),r=>({...r,request:{...r.request,id:null}}),r=>({...r,request:{...r.request,amount:{cents:125,currency:"CNY"}}})]){
  await withDom(async window=>{
   let writes=0;const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
   const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async(url,init={})=>{
    assert.match(String(url),/\/channel-payment-requests$/);if(init.method==="POST"){writes++;return json(corrupt(channelReceipt("ALIPAY_NATIVE")),202);}return json(channelView());
   });
   try{await probe.render();await probe.click("获取支付参数");assert.equal(writes,1);assert.match(probe.host.textContent,/回执尚未确认/);assert.equal(intents.loadIntent("user_A","order.channel-payment","order_A").body.method,"ALIPAY_NATIVE");assert.equal(intents.loadIntent("user_A","order.payment","order_A"),null);assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳/);}
   finally{await probe.dispose(()=>intents.clearIntent("user_A","order.channel-payment","order_A"));}
  });
 }
});

test("F3: blank and negative quantities are refused as unknown, never coerced to 0 or positive", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "/settlement", method: "GET", respond: () => json(settlementBody) }], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    assert.ok(probe.host.textContent.includes("发起结束"));
    // The ending input is a local, explicit entry: nothing is filled in and no preview is offered yet.
    assert.equal(probe.buttons().some((text) => text.includes("预览结算金额")), false);
    await probe.click("发起结束租用");
    const input = await probe.setInput("哈夫币 期末剩余数量", "");
    assert.equal(input.value, "");
    await probe.click("预览结算金额");
    assert.ok(probe.host.textContent.includes("留空表示未知"), probe.host.textContent.slice(0, 300));
    assert.equal(log.filter((entry) => entry.url.includes("settlement-preview")).length, 0);
    const negative = await probe.setInput("哈夫币 期末剩余数量", "-5");
    assert.equal(negative.value, "-5");
    await probe.click("预览结算金额");
    assert.ok(probe.host.textContent.includes("必须是 0 或正整数"), probe.host.textContent.slice(0, 300));
    assert.equal(log.filter((entry) => entry.url.includes("settlement-preview")).length, 0);
    await probe.dispose();
  });
});

test("F3: editing after a preview invalidates it and a late preview response is dropped", async () => {
  await withDom(async (window) => {
    const log = [];
    const pending = deferred();
    let previewCalls = 0;
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json(settlementBody) },
      { match: "settlement-preview", method: "POST", respond: () => { previewCalls += 1; return previewCalls === 1 ? pending.promise : json(previewBody); } },
    ], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("发起结束租用");
    await probe.setInput("哈夫币 期末剩余数量", "200");
    await probe.click("预览结算金额");
    await probe.setInput("测试物品 期末剩余数量", "7");
    pending.resolve(json(previewBody));
    await tick(); await tick();
    assert.ok(!probe.host.textContent.includes("提交结算"), "stale preview must not render after an edit");
    await probe.click("预览结算金额");
    await tick();
    assert.ok(probe.host.textContent.includes("¥316.00"), "concrete amounts render after a fresh preview");
    assert.ok(probe.host.textContent.includes("¥154.00"), "the renter charge renders");
    assert.ok(!probe.host.textContent.includes("¥113.16"), "the renter projection must not leak owner-side internals");
    assert.ok(probe.host.textContent.includes("7 件"), "consumed table shows the entered remaining quantity");
    assert.ok(probe.host.textContent.includes("2 件"), "consumed table shows the server-bound consumed quantity");
    await probe.setInput("测试物品 期末剩余数量", "6");
    assert.ok(!probe.host.textContent.includes("提交结算"), "editing clears the accepted preview");
    await probe.dispose();
  });
});

test("F2: an unknown settlement submit retries with the original key and body", async () => {
  await withDom(async (window) => {
    const log = [];
    let submitCalls = 0;
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json(settlementBody) },
      { match: "settlement-preview", method: "POST", respond: () => json(previewBody) },
      { match: "/settlements", method: "POST", respond: () => { submitCalls += 1; if (submitCalls === 1) throw new TypeError("network down"); return json({ ok: true }); } },
    ], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("发起结束租用");
    await probe.setInput("哈夫币 期末剩余数量", "200");
    await probe.setInput("测试物品 期末剩余数量", "7");
    await probe.click("预览结算金额");
    await probe.click("提交结算");
    assert.ok(probe.host.textContent.includes("结果未知"), probe.host.textContent.slice(0, 300));
    await probe.click("查询原请求结果");
    const submits = log.filter((entry) => entry.method === "POST" && /\/settlements$/.test(entry.url));
    assert.equal(submits.length, 2);
    assert.equal(submits[0].key, submits[1].key);
    assert.deepEqual(submits[0].body, submits[1].body);
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.submit", "order_A"));
  });
});

test("F2: an unknown payment retries the original key and never double-charges", async () => {
  await withDom(async (window) => {
    const log = [];
    let payCalls = 0;
    const pendingOrder = { ...paidOrder, status: "PENDING_PAYMENT" };
    const fetchImpl = router([
      { match: "payment-requests", method: "POST", respond: () => { payCalls += 1; if (payCalls === 1) throw new TypeError("network down"); return json({ payment: { confirmationId: "payment_1", disposition: "APPLIED", replay: true } }); } },
    ], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: pendingOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("提交支付");
    assert.ok(probe.host.textContent.includes("支付结果未知"), probe.host.textContent.slice(0, 300));
    await probe.click("查询原请求结果");
    const pays = log.filter((entry) => entry.method === "POST");
    assert.equal(pays.length, 2);
    assert.ok(pays.every(entry => entry.url.endsWith("/payment-requests")));
    assert.equal(pays[0].key, pays[1].key);
    assert.ok(probe.host.textContent.includes("支付已接纳"));
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});

const confirmation = {
  quote: { lines: [haffLine, pieceLine], resourceTotal: money("170.00"), tenantDeposit: money("300.00"), tenantPayableTotal: money("470.00") },
  baseTenantDeposit: money("300.00"), customerTier: "STANDARD", depositWaived: false,
  compensationDisclosure: { selected: true, disclosureVersion: "dual-line-disclosure-v1" },
  confirmationId: "c1", listingHash: "h".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString(), confirmationToken: "token_1",
};
const publishingOptions = { releaseId: "release_1", agreement: { id: "ag_1", title: "三角洲出租协议", body: "协议正文（TEST_ONLY）", digest: "d".repeat(64) } };

function loadPanelForSession(sessionObject, optionsResponder, extraSupplyApi) {
  return loadComponent("apps/web/src/components/order/rental-confirm-panel.tsx", sessionObject, {
    "@/lib/listing-view": { formatMoneyLabel: (value) => (value && typeof value.amount === "string" ? `¥${value.amount}` : null) },
    "@/lib/supply-client": { supplyApi: { publishingOptions: optionsResponder, ...(extraSupplyApi ?? {}) } },
  }).RentalConfirmPanel;
}

test("a partially reduced deposit freezes the actual payable deposit in the unknown-create receipt", async () => {
  await withDom(async window => {
    const accountId = "allowance_account", log = [];
    const partial = { ...confirmation, quote: { ...confirmation.quote, tenantDeposit: money("100.00"), tenantPayableTotal: money("270.00") } };
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(partial) },
      { match: "/api/v2/orders", method: "POST", respond: () => { throw new TypeError("unknown create"); } },
    ], log);
    const Panel = loadPanel("user_A", async () => publishingOptions);
    const probe = createProbe(window, Panel, { accountId, gameId: "game_1", versionId: "listing_1", releaseId: "release_1", reference: referenceFees }, fetchImpl);
    try {
      await probe.render();await probe.click("查看我的报价");await probe.click("确认并创建订单");
      const original = intents.loadIntent("user_A", "order.create.v2", accountId);
      assert.equal(original.context.deposit, "100.00", "never freeze the 300-yuan original deposit after a 200-yuan allowance");
      assert.equal(original.context.payable, "270.00");assert.equal(log.filter(entry => entry.url.endsWith("/api/v2/orders")).length, 1);
    } finally { await probe.dispose(() => intents.clearIntent("user_A", "order.create.v2", accountId)); }
  });
});

function loadPanel(sessionUser, optionsResponder) {
  return loadPanelForSession(session(sessionUser), optionsResponder);
}

const referenceFees = { total: "¥295.91", haff: "¥256.41", items: "¥39.50" };
const detailPanelProps = { accountId: "detail_price", gameId: "game_1", versionId: "listing_1", releaseId: "release_1", reference: referenceFees };

test("R03: invalid confirmation uses actionable Chinese copy and only explicitly requotes", async () => {
  await withDom(async window => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) },
      { match: "/api/v2/orders", method: "POST", respond: () => json({ error: { code: "CONFIRMATION_INVALID", message: "Invalid confirmation credential" } }, 400) },
    ], log);
    const accountId = "account_invalid_confirmation";
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), { ...detailPanelProps, accountId }, fetchImpl);
    try {
      await probe.render();
      await probe.click("查看我的报价");
      await probe.click("确认并创建订单");
      assert.match(probe.host.textContent, /本次确认凭据无效，请重新获取本人报价后再创建订单/);
      assert.doesNotMatch(probe.host.textContent, /Invalid confirmation credential/);
      assert.ok(probe.buttons().includes("重新确认"), "invalid credentials allow a fresh personal quote");
      assert.equal(intents.loadIntent("user_A", "order.create.v2", accountId), null, "definitive initial 400 retains existing non-commit handling");
      await probe.render();
      assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 1, "notice rerender never requotes automatically");
      await probe.click("重新确认");
      assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 2);
      assert.equal(log.filter(entry => entry.url.endsWith("/api/v2/orders")).length, 1, "requote does not create another order");
    } finally { await probe.dispose(() => intents.clearIntent("user_A", "order.create.v2", accountId)); }
  });
});

function loadReadyDetail(current) {
  return loadComponent("apps/web/src/components/market/listing-detail.tsx", current, {
    "@/components/layout/service-shell": {},
    "@/components/favorites/favorite-button": { FavoriteButton: () => null, FavoriteNotice: () => null },
    "@/components/favorites/favorites-context": {},
    "@/components/delta/account-card": { composeGridTitle: () => ({ haff: "", rest: "真实详情组件测试" }), isHaff: () => false, moneyValue: value => value, orderedQuoteResources: () => [] },
    "@/lib/account-return": {}, "@/lib/listing-filters": {}, "@/lib/supply-games": {}, "@/lib/listing-view": {}, "@/lib/supply-client": {},
    "@/components/order/rental-confirm-panel": { RentalConfirmPanel: loadPanelForSession(current, async () => publishingOptions) },
    "@/components/supply/skin-media-thumb": {},
  }).ReadyDetail;
}
const fullPayoutTerms = {
  termsVersionId: "terms_1", termsDigest: "e".repeat(64), disclosureVersion: "disclosure_1",
  policyRef: "g0-full-payout", policyVersion: "1", title: "全额包赔条款", body: "包赔条款正文（TEST_ONLY）",
};
const payoutConfirmation = { ...confirmation, compensationDisclosure: { selected: true, disclosureVersion: "disclosure_1", terms: fullPayoutTerms } };
const payoutAcceptance = { termsVersionId: "terms_1", termsDigest: "e".repeat(64), disclosureVersion: "disclosure_1" };
const payoutSupply = { fullPayoutTerms: async (gameId, releaseId) => { assert.equal(gameId, "game_1"); assert.equal(releaseId, "release_1"); return { releaseId, fullPayoutTerms }; } };
async function acceptPayout(window, probe) {
  const checkbox = probe.host.querySelector('[aria-label="我已阅读并同意全额包赔条款"]');
  assert.ok(checkbox, `payout acceptance checkbox missing; text=${probe.host.textContent?.slice(0, 300)}`);
  await React.act(async () => { checkbox.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await tick(); });
  await tick();
  assert.equal(checkbox.checked, true);
}

async function clickPayoutControl(control) {
  assert.ok(control, "payout dialog control exists");
  await React.act(async () => { control.click(); await tick(); });
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function openPayoutDialog(probe) {
  const trigger = probe.host.querySelector(".rental-terms-modal-trigger");
  assert.ok(trigger);
  trigger.focus();
  await clickPayoutControl(trigger);
  const dialog = probe.host.ownerDocument.querySelector(".rental-terms-dialog");
  assert.ok(dialog, "the visible trigger opens the real Radix portal");
  return { trigger, dialog };
}

test("detail fees display API buyer amounts with exact cents; missing/mismatched lines never use public fees", () => {
  const { personalFeeLines } = loadComponent("apps/web/src/components/order/rental-price-summary.tsx", session("user_A"));
  assert.deepEqual(personalFeeLines(confirmation), { haff: "¥150.00", items: "¥20.00" });
  const changedName = { ...confirmation, quote: { ...confirmation.quote, lines: [{ ...haffLine, name: "not a name heuristic" }, pieceLine] } };
  assert.deepEqual(personalFeeLines(changedName), { haff: "¥150.00", items: "¥20.00" });
  for (const lines of [undefined, [], [{ ...haffLine, buyerAmount: null }], [{ ...haffLine, unit: "FUTURE_UNIT" }], [{ ...haffLine, buyerAmount: money("-1.00") }], [{ ...haffLine, buyerAmount: money("150.000") }]]) {
    assert.equal(personalFeeLines({ ...confirmation, quote: { ...confirmation.quote, lines } }), null);
  }
  assert.equal(personalFeeLines({ ...confirmation, quote: { ...confirmation.quote, resourceTotal: money("171.00") } }), null);
  const cents = { ...confirmation, quote: { ...confirmation.quote, lines: [{ ...haffLine, buyerAmount: money("0.10") }, { ...pieceLine, buyerAmount: money("0.20") }], resourceTotal: money("0.30") } };
  assert.deepEqual(personalFeeLines(cents), { haff: "¥0.10", items: "¥0.20" });
});

test("detail card and dock replace the reference with the SAME personal payable; no guessed discount", async () => {
  await withDom(async window => {
    const log = [];
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) }], log));
    try {
      await probe.render();
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥295.91");
      assert.match(probe.host.querySelector(".rental-dock-price").textContent, /押金另核/);
      await probe.click("查看我的报价");
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥470.00");
      assert.equal(probe.host.querySelector(".rental-dock-price strong").textContent, "¥470.00");
      assert.match(probe.host.querySelector(".account-fee-lines").textContent, /¥150.00.*¥20.00.*¥300.00/);
      assert.ok(!probe.host.textContent.includes("¥256.41"));
      assert.equal(probe.host.querySelectorAll(".rental-confirm-primary").length, 1);
      assert.equal(probe.host.querySelector("del"), null);
      assert.ok(!probe.host.textContent.includes("已优惠"));
    } finally { await probe.dispose(); }
  });
});

test("detail deposit waiver strikes only the authoritative base deposit, never the resource price", async () => {
  await withDom(async window => {
    const waived = { ...confirmation, customerTier: "VIP", depositWaived: true, quote: { ...confirmation.quote, tenantDeposit: money("0.00"), tenantPayableTotal: money("170.00") } };
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(waived) }], []));
    try {
      await probe.render(); await probe.click("查看我的报价");
      assert.equal(probe.host.querySelector("del").textContent, "¥300.00");
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥170.00");
      assert.match(probe.host.querySelector(".rental-deposit").textContent, /¥0.00.*本次免押/);
      assert.ok(!probe.host.textContent.includes("金卡"), "never map VIP to a new tier");
    } finally { await probe.dispose(); }
  });
});

test("detail unknown deposit is not zero even with a tier or inconsistent waiver flag", async () => {
  await withDom(async window => {
    const incomplete = { ...confirmation, customerTier: "SVIP", depositWaived: true, quote: { ...confirmation.quote, tenantDeposit: null, tenantPayableTotal: null } };
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(incomplete) }], []));
    try {
      await probe.render(); await probe.click("查看我的报价");
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "—");
      assert.equal(probe.host.querySelector("del"), null);
      assert.ok(!probe.host.querySelector(".rental-price-summary").textContent.includes("免押"));
    } finally { await probe.dispose(); }
  });
});

test("detail expiry and 503 clear the payable while preserving a user-initiated requote", async () => {
  await withDom(async window => {
    const old = { ...confirmation, expiresAt: new Date(Date.now() - 10000).toISOString() };
    let calls = 0;
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => ++calls === 1 ? json(old) : json({ error: { code: "DEPENDENCY_UNAVAILABLE" } }, 503) }], []));
    try {
      await probe.render(); await probe.click("查看我的报价");
      assert.match(probe.host.querySelector(".rental-price-summary").textContent, /报价已过期/);
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "—");
      assert.ok([...probe.host.querySelectorAll("button")].find(x => x.textContent.includes("确认并创建订单")).disabled);
      await probe.click("重新报价");
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "—");
      assert.ok(!probe.host.textContent.includes("¥470.00"));
      assert.equal(calls, 2);
    } finally { await probe.dispose(); }
  });
});

test("detail identity loading/B and late A quote never reveal A payable or waiver", async () => {
  await withDom(async window => {
    const current = session("user_A"), pending = deferred();
    const probe = createProbe(window, loadPanelForSession(current, async () => publishingOptions), detailPanelProps, router([{ match: "/api/order-confirmations", method: "POST", respond: () => pending.promise }], []));
    try {
      await probe.render(); await probe.click("查看我的报价");
      current.status = "loading"; current.userId = null; await probe.render();
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "—");
      current.status = "authenticated"; current.userId = "user_B"; current.identityVersion++; await probe.render();
      pending.resolve(json({ ...confirmation, customerTier: "VIP", depositWaived: true, quote: { ...confirmation.quote, tenantDeposit: money("0.00") } }));
      await React.act(async () => { await tick(); await tick(); });
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥295.91");
      assert.ok(!probe.host.textContent.includes("¥470.00"));
      assert.equal(probe.host.querySelector("del"), null);
    } finally { await probe.dispose(); }
  });
});

test("I04: the real public detail requires an explicit quote action and consumes only its returned token", async () => {
  await withDom(async window => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) },
      { match: "/api/v2/orders", method: "POST", respond: () => json({ order: { id: "order_auto", displayNo: "ZZ-AUTO", status: "PENDING_PAYMENT" } }) },
    ], log);
    const data = { id: "detail_price", gameId: "game_1", versionId: "listing_1", releaseId: "release_1", canCreateOrder: true,
      resourceTotalLabel: referenceFees.total, haffRentLabel: referenceFees.haff, itemResourceTotalLabel: referenceFees.items,
      conditionLines: [], resourceLines: [], skinTags: [], media: [], entitlementNames: [] };
    const probe = createProbe(window, loadReadyDetail(session("user_A")), { data }, fetchImpl, { strict: true });
    try {
      await probe.render();
      await tick(); await tick();
      assert.equal(log.length, 0, "opening a rentable public detail is read-only");
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥295.91");
      await probe.render();
      window.document.documentElement.dataset.theme = "dark";
      window.innerWidth = 390;
      window.dispatchEvent(new window.Event("resize"));
      await probe.render();
      assert.equal(log.length, 0, "rerender, theme and viewport changes do not request a quote");
      await probe.click("查看我的报价");
      assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 1);
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥470.00");
      assert.ok(probe.host.textContent.includes("确认并创建订单"));
      assert.ok(!probe.host.textContent.includes("查看我的报价"));
      await probe.render(); await tick();
      assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 1);
      await probe.click("确认并创建订单");
      const creates = log.filter(entry => entry.url.endsWith("/api/v2/orders"));
      assert.equal(creates.length, 1);
      assert.deepEqual(creates[0].body, { confirmationToken: "token_1" });
    } finally { await probe.dispose(() => intents.clearIntent("user_A", "order.create.v2", "detail_price")); }
  });
});

test("guest detail links directly to login without a quote request", async () => {
  await withDom(async window => {
    const guest = { status: "guest", userId: null, identityVersion: 1, revalidate() {}, confirm: async () => "guest", signOut: async () => undefined };
    const log = [];
    const fetchImpl = router([], log);
    const probe = createProbe(window, loadPanelForSession(guest, async () => publishingOptions), detailPanelProps, fetchImpl);
    try {
      await probe.render();
      const link = probe.host.querySelector('a[href*="/login?next="]');
      assert.ok(link);
      assert.match(link.textContent, /登录后显示最终报价/);
      assert.equal(log.length, 0);
      assert.ok(!probe.host.textContent.includes("查看我的报价"));
    } finally { await probe.dispose(); }
  });
});

test("I04: identity and listing version changes never initiate a public-detail quote", async () => {
  await withDom(async window => {
    const current = session("user_A"), log = [];
    const data = { id: "detail_price", gameId: "game_1", versionId: "listing_1", releaseId: "release_1", canCreateOrder: true,
      resourceTotalLabel: referenceFees.total, haffRentLabel: referenceFees.haff, itemResourceTotalLabel: referenceFees.items,
      conditionLines: [], resourceLines: [], skinTags: [], media: [], entitlementNames: [] };
    const probe = createProbe(window, loadReadyDetail(current), { data }, router([], log), { strict: true });
    try {
      await probe.render();
      for (const [versionId, releaseId] of [["listing_2", "release_1"], ["listing_2", "release_2"], ["listing_1", "release_1"]]) {
        await probe.render({ data: { ...data, versionId, releaseId } });
        assert.equal(log.length, 0);
      }
      current.status = "loading"; current.userId = null; await probe.render();
      assert.ok([...probe.host.querySelectorAll("button")].find(button => button.textContent === "查看我的报价")?.disabled);
      current.status = "authenticated"; current.userId = "user_B"; current.identityVersion++;
      await probe.render();
      assert.equal(log.length, 0);
      assert.ok([...probe.host.querySelectorAll("button")].find(button => button.textContent === "查看我的报价"));
    } finally { await probe.dispose(); }
  });
});

test("explicit quote does not retry itself after 401 or 503", async () => {
  for (const failure of [
    { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "登录已失效" } }, message: "登录状态已变化" },
    { status: 503, body: { error: { code: "DEPENDENCY_UNAVAILABLE", message: "依赖暂不可用" } }, message: "最终报价暂时无法读取" },
  ]) {
    await withDom(async window => {
      const current = session("user_A");
      let confirms = 0;
      current.confirm = async () => { confirms += 1; return "authenticated"; };
      const log = [];
      const fetchImpl = router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(failure.body, failure.status) }], log);
      const probe = createProbe(window, loadPanelForSession(current, async () => publishingOptions), detailPanelProps, fetchImpl, { strict: true });
      try {
        await probe.render(); await tick(); await tick();
        assert.equal(log.length, 0);
        await probe.click("查看我的报价");
        assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 1);
        assert.equal(confirms, failure.status === 401 ? 1 : 0);
        assert.match(probe.host.textContent, new RegExp(failure.message));
        await probe.render(); await tick();
        assert.equal(log.filter(entry => entry.url.endsWith("/api/order-confirmations")).length, 1);
      } finally { await probe.dispose(); }
    });
  }
});

test("detail honors a frozen create intent without requesting a new quote", async () => {
  await withDom(async window => {
    intents.saveIntent({ userId: "user_A", kind: "order.create.v2", resourceId: "detail_intent", key: "op_frozen", body: {}, token: "token_frozen", context: { payable: "470.00" } });
    const log = [];
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), { ...detailPanelProps, accountId: "detail_intent" }, router([], log), { strict: true });
    try {
      await probe.render(); await tick();
      assert.ok(probe.host.textContent.includes("创建请求结果未知"));
      assert.equal(log.length, 0);
    } finally { await probe.dispose(() => intents.clearIntent("user_A", "order.create.v2", "detail_intent")); }
  });
});

test("late explicit quotes are dropped across an A to B to A object switch without auto requests", async () => {
  await withDom(async window => {
    const pending = [deferred(), deferred(), deferred()];
    let call = 0;
    const fetchImpl = router([{ match: "/api/order-confirmations", method: "POST", respond: () => pending[call++].promise }], []);
    const probe = createProbe(window, loadPanel("user_A", async () => publishingOptions), detailPanelProps, fetchImpl);
    const props = accountId => ({ ...detailPanelProps, accountId });
    try {
      await probe.render(); await tick();
      assert.equal(call, 0);
      await probe.click("查看我的报价");
      assert.equal(call, 1);
      await probe.render(props("detail_other")); await tick();
      assert.equal(call, 1);
      await probe.click("查看我的报价");
      assert.equal(call, 2);
      await React.act(async () => { pending[0].resolve(json(confirmation)); await tick(); await tick(); });
      assert.ok(!probe.host.textContent.includes("¥470.00"));
      await probe.render(props("detail_price")); await tick();
      assert.equal(call, 2);
      await probe.click("查看我的报价");
      assert.equal(call, 3);
      await React.act(async () => { pending[1].resolve(json(confirmation)); await tick(); await tick(); });
      assert.ok(!probe.host.textContent.includes("¥470.00"));
      await React.act(async () => { pending[2].resolve(json(confirmation)); await tick(); await tick(); });
      assert.equal(probe.host.querySelector(".account-reference-price").textContent, "¥470.00");
      assert.ok(probe.host.textContent.includes("确认并创建订单"));
    } finally { await probe.dispose(); }
  });
});

test("F2: an unknown create keeps the original token and key and recovers after remount", async () => {
  await withDom(async (window) => {
    const log = [];
    let createCalls = 0;
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) },
      { match: "/api/v2/orders", method: "POST", respond: () => { createCalls += 1; if (createCalls === 1) throw new TypeError("network down"); return json({ order: { id: "order_B", displayNo: "ZZ-2", status: "PENDING_PAYMENT" } }); } },
    ], log);
    const Panel = loadPanel("user_A", async () => publishingOptions);
    const props = { accountId: "account_1", gameId: "game_1", versionId: "listing_1", releaseId: "release_1", reference: referenceFees };
    const first = createProbe(window, Panel, props, fetchImpl);
    await first.render();
    await first.click("查看我的报价");
    assert.ok(first.host.textContent.includes("¥470.00"));
    assert.ok(first.host.textContent.includes("三角洲出租协议"));
    await first.click("确认并创建订单");
    assert.ok(first.host.textContent.includes("创建请求结果未知"), first.host.textContent.slice(0, 300));
    assert.equal(first.host.querySelector(".account-reference-price").textContent, "—");
    assert.ok(!first.host.querySelector(".rental-price-summary").textContent.includes("¥470.00"));
    const firstCreate = log.find((entry) => entry.url.endsWith("/api/v2/orders"));
    assert.deepEqual(firstCreate.body, { confirmationToken: "token_1" });
    await first.unmount();
    // Remount in the same window/session: the frozen intent is offered for query.
    const second = createProbe(window, Panel, props, fetchImpl);
    await second.render();
    assert.ok(second.host.textContent.includes("创建请求结果未知"), "remount must restore the unknown create");
    assert.equal(second.host.querySelector(".account-reference-price").textContent, "—");
    await second.click("查询原创建结果");
    const creates = log.filter((entry) => entry.url.endsWith("/api/v2/orders"));
    assert.equal(creates.length, 2);
    assert.equal(creates[0].key, creates[1].key, "same idempotency key");
    assert.deepEqual(creates[0].body, creates[1].body, "same original body/token");
    assert.ok(second.host.textContent.includes("原创建请求已确认成功"), second.host.textContent.slice(0, 300));
    await second.dispose(() => intents.clearIntent("user_A", "order.create.v2", "account_1"));
  });
});

test("F2: another identity cannot see or reuse the frozen create intent; 401 keeps it for the owner", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) },
      { match: "/api/v2/orders", method: "POST", respond: () => json({ error: { code: "UNAUTHENTICATED", message: "登录已失效" } }, 401) },
    ], log);
    const props = { accountId: "account_2", gameId: "game_1", versionId: "listing_1", releaseId: "release_1" };
    const ownerView = createProbe(window, loadPanel("user_A", async () => publishingOptions), props, fetchImpl);
    await ownerView.render();
    await ownerView.click("查看我的报价");
    await ownerView.click("确认并创建订单");
    assert.ok(ownerView.host.textContent.includes("登录状态已变化"), ownerView.host.textContent.slice(0, 300));
    assert.ok(intents.loadIntent("user_A", "order.create.v2", "account_2"), "the owner's intent is retained");
    const stranger = createProbe(window, loadPanel("user_B", async () => publishingOptions), props, fetchImpl);
    await stranger.render();
    assert.ok(stranger.host.textContent.includes("查看我的报价"), "another identity starts idle");
    assert.ok(!stranger.host.textContent.includes("创建请求结果未知"), "another identity must not see the frozen intent");
    await stranger.dispose();
    await ownerView.dispose(() => intents.clearIntent("user_A", "order.create.v2", "account_2"));
  });
});

test("F4: missing agreement evidence blocks creation instead of accepting a version code only", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) },
    ], log);
    const Panel = loadPanel("user_A", async () => { throw new Error("options unavailable"); });
    const probe = createProbe(window, Panel, { accountId: "account_3", gameId: "game_1", versionId: "listing_1", releaseId: "release_1" }, fetchImpl);
    await probe.render();
    await probe.click("查看我的报价");
    assert.ok(probe.host.textContent.includes("条款依据暂时无法读取"), probe.host.textContent.slice(0, 300));
    const create = probe.buttons().find((text) => text.includes("确认并创建订单"));
    const button = [...probe.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("确认并创建订单"));
    assert.ok(button.disabled, "create must be disabled while agreement evidence is unavailable");
    assert.ok(create);
    await probe.dispose();
  });
});

test("D8-R1: StrictMode replaces an aborted terms read without accepting or posting", async () => {
  await withDom(async (window) => {
    const reads = [], log = [];
    const Panel = loadPanelForSession(session("user_A"), async () => publishingOptions, {
      fullPayoutTerms: (gameId, releaseId, signal) => {
        const result = deferred();
        reads.push({ gameId, releaseId, signal, result });
        return result.promise;
      },
    });
    const probe = createProbe(window, Panel, { ...detailPanelProps, fullPayoutSelected: true }, router([], log), { strict: true });
    try {
      await probe.render();
      assert.equal(reads.length, 2, "StrictMode's replacement effect starts a fresh read");
      assert.equal(reads[0].signal.aborted, true);
      assert.equal(reads[1].signal.aborted, false);
      await React.act(async () => {
        reads[0].result.resolve({ releaseId: "release_1", fullPayoutTerms: { ...fullPayoutTerms, termsDigest: "f".repeat(64) } });
        await tick();
      });
      assert.equal(probe.host.querySelector('[aria-label="我已阅读并同意全额包赔条款"]'), null, "the cancelled response stays ignored");
      await React.act(async () => {
        reads[1].result.resolve({ releaseId: "release_1", fullPayoutTerms });
        await tick();
      });
      const checkbox = probe.host.querySelector('[aria-label="我已阅读并同意全额包赔条款"]');
      assert.ok(checkbox);
      assert.equal(checkbox.checked, false, "reading the replacement terms never accepts them");
      const terms = probe.host.querySelector('[aria-label="全额包赔条款"]');
      assert.doesNotMatch(terms.textContent, /包赔条款正文/, "the body is not retained in hidden test-only DOM");
      const { dialog } = await openPayoutDialog(probe);
      assert.match(dialog.textContent, /包赔条款正文/);
      await clickPayoutControl(dialog.querySelector('[aria-label="关闭条款窗口"]'));
      assert.doesNotMatch(terms.textContent, /条款版本|摘要/);
      assert.ok(![...probe.host.querySelectorAll("button")].find((button) => button.textContent.includes("查看并同意包赔条款"))?.disabled);
      assert.equal(log.length, 0, "no confirmation or order is posted before consent");
    } finally { await probe.dispose(); }
  });
});

test("D1: a declared full-payout listing reads the sealed terms and binds the same acceptance to quote, order and recovery", async () => {
  await withDom(async (window) => {
    const log = [];
    let createCalls = 0;
    const fetchImpl = router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(payoutConfirmation) },
      { match: "/api/v2/orders", method: "POST", respond: () => { createCalls += 1; if (createCalls === 1) throw new TypeError("network down"); return json({ order: { id: "order_P", displayNo: "ZZ-9", status: "PENDING_PAYMENT" } }); } },
    ], log);
    const Panel = loadPanelForSession(session("user_A"), async () => publishingOptions, payoutSupply);
    const props = { ...detailPanelProps, accountId: "account_payout", fullPayoutSelected: true };
    const first = createProbe(window, Panel, props, fetchImpl);
    await first.render();
    await tick();
    assert.ok(first.host.textContent.includes("全额包赔条款"), first.host.textContent.slice(0, 400));
    const payoutSection = first.host.querySelector('[aria-label="全额包赔条款"]');
    assert.equal(payoutSection.querySelector("details"), null, "no hidden compatibility details remains");
    assert.doesNotMatch(payoutSection.textContent, /包赔条款正文/);
    const { dialog } = await openPayoutDialog(first);
    assert.match(dialog.textContent, /包赔条款正文/);
    await clickPayoutControl(dialog.querySelector('[aria-label="关闭条款窗口"]'));
    const gated = [...first.host.querySelectorAll("button")].find((button) => button.textContent.includes("查看并同意包赔条款"));
    assert.ok(gated && !gated.disabled, "blocked CTA opens the terms dialog instead of staying disabled");
    assert.equal(log.filter((entry) => entry.url.includes("order-confirmations")).length, 0);
    await acceptPayout(window, first);
    assert.equal(log.length, 0, "agreeing to terms does not implicitly request a quote");
    await first.click("查看我的报价");
    const quote = log.find((entry) => entry.url.includes("order-confirmations"));
    assert.deepEqual(quote.body, { accountId: "account_payout", versionId: "listing_1", releaseId: "release_1", fullPayoutTermsAcceptance: payoutAcceptance });
    await first.click("确认并创建订单");
    assert.ok(first.host.textContent.includes("创建请求结果未知"), first.host.textContent.slice(0, 300));
    const firstCreate = log.find((entry) => entry.url.endsWith("/api/v2/orders"));
    assert.deepEqual(firstCreate.body, { confirmationToken: "token_1", fullPayoutTermsAcceptance: payoutAcceptance });
    await first.unmount();
    // Recovery replays the frozen acceptance from the intent, not whatever the UI shows now.
    const second = createProbe(window, Panel, props, fetchImpl);
    await second.render();
    await tick();
    assert.ok(second.host.textContent.includes("创建请求结果未知"), "remount must restore the unknown create");
    await second.click("查询原创建结果");
    const creates = log.filter((entry) => entry.url.endsWith("/api/v2/orders"));
    assert.equal(creates.length, 2);
    assert.equal(creates[0].key, creates[1].key, "same idempotency key");
    assert.deepEqual(creates[0].body, creates[1].body, "same frozen acceptance on recovery");
    assert.ok(second.host.textContent.includes("原创建请求已确认成功"), second.host.textContent.slice(0, 300));
    await second.dispose(() => intents.clearIntent("user_A", "order.create.v2", "account_payout"));
  });
});

test("D1: unreadable full-payout terms block ordering instead of confirming blind", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(payoutConfirmation) }], log);
    const Panel = loadPanelForSession(session("user_A"), async () => publishingOptions, { fullPayoutTerms: async () => { throw new Error("terms down"); } });
    const probe = createProbe(window, Panel, { ...detailPanelProps, accountId: "account_payout_unreadable", fullPayoutSelected: true }, fetchImpl);
    try {
      await probe.render();
      await tick();
      assert.ok(probe.host.textContent.includes("全额包赔条款暂时无法读取"), probe.host.textContent.slice(0, 300));
      assert.equal(log.filter((entry) => entry.url.includes("order-confirmations")).length, 0);
      const gated = [...probe.host.querySelectorAll("button")].find((button) => button.textContent.includes("包赔条款暂不可用"));
      assert.ok(gated?.disabled);
    } finally { await probe.dispose(); }
  });
});

test("D1: authoritative terms that differ from the accepted version stop creation", async () => {
  await withDom(async (window) => {
    const log = [];
    const drifted = { ...payoutConfirmation, compensationDisclosure: { selected: true, disclosureVersion: "disclosure_1", terms: { ...fullPayoutTerms, termsDigest: "f".repeat(64) } } };
    const fetchImpl = router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(drifted) }], log);
    const Panel = loadPanelForSession(session("user_A"), async () => publishingOptions, payoutSupply);
    const probe = createProbe(window, Panel, { ...detailPanelProps, accountId: "account_payout_drift", fullPayoutSelected: true }, fetchImpl);
    try {
      await probe.render();
      await tick();
      await acceptPayout(window, probe);
      await probe.click("查看我的报价");
      assert.ok(probe.host.textContent.includes("包赔条款版本与已同意的版本不一致"), probe.host.textContent.slice(0, 300));
      assert.equal(log.filter((entry) => entry.url.endsWith("/api/v2/orders")).length, 0);
    } finally { await probe.dispose(); }
  });
});

test("D-terms: only explicit modal confirmation commits its draft; dismissal restores parent consent and focus", async () => {
  await withDom(async window => {
    const log = [];
    const Panel = loadPanelForSession(session("user_A"), async () => publishingOptions, payoutSupply);
    const probe = createProbe(window, Panel, { ...detailPanelProps, accountId: "payout_modal_draft", fullPayoutSelected: true }, router([], log));
    const outside = () => probe.host.querySelector('[aria-label="我已阅读并同意全额包赔条款"]');
    try {
      await probe.render();
      assert.equal(outside().checked, false);
      assert.match(probe.host.textContent, /本账号采用全额包赔方案/);
      assert.doesNotMatch(probe.host.textContent, /已投保/);
      let { trigger, dialog } = await openPayoutDialog(probe);
      let draft = dialog.querySelector(".rental-terms-dialog-accept input");
      let confirm = dialog.querySelector(".rental-terms-dialog-confirm");
      assert.equal(draft.checked, false);
      assert.equal(confirm.disabled, true, "unchecked draft cannot be confirmed");
      await clickPayoutControl(confirm);
      assert.equal(outside().checked, false);
      assert.ok(window.document.querySelector(".rental-terms-dialog"));
      await clickPayoutControl(draft);
      assert.equal(draft.checked, true);
      assert.equal(outside().checked, false, "editing a draft does not accept the terms");
      await clickPayoutControl(dialog.querySelector('[aria-label="关闭条款窗口"]'));
      assert.equal(outside().checked, false);
      assert.ok(window.document.activeElement === trigger, "X returns focus to the visible trigger");

      ({ trigger, dialog } = await openPayoutDialog(probe));
      draft = dialog.querySelector(".rental-terms-dialog-accept input");
      assert.equal(draft.checked, false, "reopening discards the unconfirmed draft");
      await clickPayoutControl(draft);
      confirm = dialog.querySelector(".rental-terms-dialog-confirm");
      assert.equal(confirm.disabled, false);
      assert.equal(confirm.textContent.trim(), "同意条款并返回");
      await clickPayoutControl(confirm);
      assert.equal(outside().checked, true);
      assert.equal(window.document.querySelector(".rental-terms-dialog"), null);
      assert.ok(window.document.activeElement === trigger, "confirmation also returns focus");

      ({ trigger, dialog } = await openPayoutDialog(probe));
      draft = dialog.querySelector(".rental-terms-dialog-accept input");
      assert.equal(draft.checked, true, "the next draft reflects the accepted parent value");
      await clickPayoutControl(draft);
      assert.equal(dialog.querySelector(".rental-terms-dialog-confirm").disabled, true);
      await React.act(async () => { window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick(); });
      await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      assert.equal(window.document.querySelector(".rental-terms-dialog"), null);
      assert.equal(outside().checked, true, "Escape does not revoke existing acceptance");
      assert.ok(window.document.activeElement === trigger);
      ({ dialog } = await openPayoutDialog(probe));
      assert.equal(dialog.querySelector(".rental-terms-dialog-accept input").checked, true);
      await clickPayoutControl(dialog.querySelector('[aria-label="关闭条款窗口"]'));
      await clickPayoutControl(outside());
      assert.equal(outside().checked, false, "the external checkbox still supports direct withdrawal");
      await clickPayoutControl(outside());
      assert.equal(outside().checked, true, "the external checkbox still supports direct acceptance");
      assert.equal(log.length, 0, "reading and editing consent never requests a quote or order");
    } finally { await probe.dispose(); }
  });
});

test("D-terms: a quoted locked panel permits reading and closing without changing consent", async () => {
  await withDom(async window => {
    const log = [];
    const Panel = loadPanelForSession(session("user_A"), async () => publishingOptions, payoutSupply);
    const probe = createProbe(window, Panel, { ...detailPanelProps, accountId: "payout_modal_locked", fullPayoutSelected: true }, router([
      { match: "/api/order-confirmations", method: "POST", respond: () => json(payoutConfirmation) },
    ], log));
    try {
      await probe.render();
      await acceptPayout(window, probe);
      await probe.click("查看我的报价");
      const outside = probe.host.querySelector('[aria-label="我已阅读并同意全额包赔条款"]');
      assert.equal(outside.checked, true);
      assert.equal(outside.disabled, true);
      const { dialog } = await openPayoutDialog(probe);
      const draft = dialog.querySelector(".rental-terms-dialog-accept input");
      const confirm = dialog.querySelector(".rental-terms-dialog-confirm");
      assert.equal(draft.checked, true);
      assert.equal(draft.disabled, true);
      assert.equal(confirm.disabled, true);
      await clickPayoutControl(draft);
      await clickPayoutControl(confirm);
      assert.equal(draft.checked, true);
      assert.equal(outside.checked, true);
      assert.ok(window.document.querySelector(".rental-terms-dialog"), "locked confirmation cannot close by committing");
      await clickPayoutControl(dialog.querySelector('[aria-label="关闭条款窗口"]'));
      assert.equal(outside.checked, true);
      assert.equal(log.length, 1, "locked reading creates no additional request");
      assert.equal(log[0].url, "/api/order-confirmations");
    } finally { await probe.dispose(); }
  });
});

test("D-terms: a changed terms tuple or unavailable state clears an open draft", async () => {
  await withDom(async window => {
    const log = [];
    const nextTerms = { ...fullPayoutTerms, termsVersionId: "terms_2", termsDigest: "f".repeat(64), disclosureVersion: "disclosure_2", title: "新版包赔条款", body: "新版条款正文（TEST_ONLY）" };
    const Panel = loadPanelForSession(session("user_A"), async () => publishingOptions, {
      fullPayoutTerms: async (_gameId, releaseId) => ({ releaseId, fullPayoutTerms: releaseId === "release_1" ? fullPayoutTerms : nextTerms }),
    });
    const props = { ...detailPanelProps, accountId: "payout_modal_scope", fullPayoutSelected: true };
    const nextProps = { ...props, versionId: "listing_2", releaseId: "release_2" };
    const probe = createProbe(window, Panel, props, router([], log));
    const outside = () => probe.host.querySelector('[aria-label="我已阅读并同意全额包赔条款"]');
    try {
      await probe.render();
      let { dialog } = await openPayoutDialog(probe);
      await clickPayoutControl(dialog.querySelector(".rental-terms-dialog-accept input"));
      await probe.render(nextProps);
      assert.equal(window.document.querySelector(".rental-terms-dialog"), null);
      assert.equal(outside().checked, false);
      ({ dialog } = await openPayoutDialog(probe));
      assert.match(dialog.textContent, /新版条款正文/);
      assert.equal(dialog.querySelector(".rental-terms-dialog-accept input").checked, false);
      await clickPayoutControl(dialog.querySelector(".rental-terms-dialog-accept input"));
      await probe.render({ ...nextProps, fullPayoutSelected: false });
      assert.equal(window.document.querySelector(".rental-terms-dialog"), null);
      assert.equal(outside(), null);
      await probe.render(nextProps);
      assert.equal(window.document.querySelector(".rental-terms-dialog"), null, "making terms readable again never reopens an old draft");
      assert.equal(outside().checked, false);
      ({ dialog } = await openPayoutDialog(probe));
      assert.equal(dialog.querySelector(".rental-terms-dialog-accept input").checked, false);
      await clickPayoutControl(dialog.querySelector('[aria-label="关闭条款窗口"]'));
      assert.equal(log.length, 0);
    } finally { await probe.dispose(); }
  });
});


test("R2: an existing intent is consumed with its frozen body and key, never overwritten", async () => {
  await withDom(async () => {
    const actions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A"));
    const sent = [];
    const first = await actions.performGuardedWrite("user_A", "order.payment", "order_frozen", { amount: "first" }, { ctx: "first" }, async (key, body) => { sent.push({ key, body }); throw new TypeError("network down"); });
    assert.equal(first.status, "unknown");
    const second = await actions.performGuardedWrite("user_A", "order.payment", "order_frozen", { amount: "second" }, { ctx: "second" }, async (key, body) => { sent.push({ key, body }); return { ok: true }; });
    assert.equal(second.status, "ok");
    assert.equal(sent[0].key, sent[1].key);
    assert.deepEqual(sent[1].body, { amount: "first" }, "recovery must send the frozen body");
    intents.clearIntent("user_A", "order.payment", "order_frozen");
  });
});

test("R1: 401 keeps the intent and asks the shared session to confirm the identity", async () => {
  await withDom(async () => {
    const actions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A"));
    const outcome = await actions.performGuardedWrite("user_A", "order.cancel", "order_401", {}, undefined, async () => { throw new OrderRequestError(401, null); });
    assert.equal(outcome.status, "unauthorized");
    assert.ok(intents.loadIntent("user_A", "order.cancel", "order_401"), "401 must not release the intent");
    intents.clearIntent("user_A", "order.cancel", "order_401");
  });
});

test("R2/R3: storage failure blocks a new write instead of creating an unrecoverable one", async () => {
  await withDom(async (window) => {
    const actions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A"));
    const realWindow = globalThis.window;
    globalThis.window = { sessionStorage: { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} } };
    try {
      let called = 0;
      const outcome = await actions.performGuardedWrite("user_A", "order.payment", "order_quota", {}, undefined, async () => { called += 1; return {}; });
      assert.equal(outcome.status, "blocked");
      assert.equal(called, 0, "no request may be sent without a persisted recovery record");
    } finally {
      globalThis.window = realWindow;
    }
  });
});

test("R3: an aged intent is not auto-replayed and stays available for an explicit authoritative query", async () => {
  await withDom(async (window) => {
    const log = [];
    intents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_A", key: "key_aged", body: {} });
    const storageKey = "zzsh.order-intent.v1:user_A:order.payment:order_A";
    const stored = JSON.parse(window.sessionStorage.getItem(storageKey));
    stored.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    window.sessionStorage.setItem(storageKey, JSON.stringify(stored));
    const fetchImpl = router([{ match: "payment-requests", method: "POST", respond: () => json({ payment: { confirmationId: "p1", disposition: "APPLIED", replay: true } }) }], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "PENDING_PAYMENT" }, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    assert.ok(probe.host.textContent.includes("超出自动查询窗口"), probe.host.textContent.slice(0, 300));
    assert.equal(log.filter(entry => entry.method === "POST").length, 0, "an aged intent must not be replayed automatically");
    await probe.click("查询原请求结果");
    const writes = log.filter(entry => entry.method === "POST");
    assert.equal(writes.length, 1, "explicit query still uses the frozen key");
    assert.equal(writes[0].key, "key_aged");
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});

test("R2: settlement unknown locks the form; payment and cancel lock each other", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json(settlementBody) },
      { match: "settlement-preview", method: "POST", respond: () => json(previewBody) },
      { match: "/settlements", method: "POST", respond: () => { throw new TypeError("network down"); } },
    ], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("发起结束租用");
    await probe.setInput("哈夫币 期末剩余数量", "200");
    await probe.setInput("测试物品 期末剩余数量", "7");
    await probe.click("预览结算金额");
    await probe.click("提交结算");
    assert.ok(probe.host.textContent.includes("结果未知"), probe.host.textContent.slice(0, 300));
    const inputs = [...probe.host.querySelectorAll("input")];
    assert.ok(inputs.length > 0 && inputs.every((input) => input.disabled), "inputs must be locked while the submit outcome is unknown");
    assert.ok(!probe.buttons().some((text) => text.includes("提交结算")), "no resubmit while unknown");
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.submit", "order_A"));
  });
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "payment-requests", method: "POST", respond: () => { throw new TypeError("network down"); } }], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "PENDING_PAYMENT" }, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("提交支付");
    assert.ok(probe.host.textContent.includes("支付结果未知"), probe.host.textContent.slice(0, 300));
    const cancelButton = [...probe.host.querySelectorAll("button")].find((button) => button.textContent?.includes("取消订单"));
    assert.ok(cancelButton?.disabled, "cancel must be locked while payment is unknown");
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});

test("R1: identity switch clears the private quote and resets order actions", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "/api/order-confirmations", method: "POST", respond: () => json(confirmation) }], log);
    const mutable = session("user_A");
    const Panel = loadPanelForSession(mutable, async () => publishingOptions);
    const probe = createProbe(window, Panel, { accountId: "account_switch", gameId: "game_1", versionId: "listing_1", releaseId: "release_1" }, fetchImpl);
    await probe.render();
    await probe.click("查看我的报价");
    assert.ok(probe.host.textContent.includes("¥470.00"));
    mutable.userId = "user_B";
    mutable.identityVersion = 2;
    await probe.render();
    assert.ok(!probe.host.textContent.includes("¥470.00"), "B must not see A's quote");
    assert.ok(probe.host.textContent.includes("查看我的报价"));
    await probe.dispose();
  });
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "payment-requests", method: "POST", respond: () => { throw new TypeError("network down"); } }], log);
    const mutable = session("user_A");
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", mutable).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "PENDING_PAYMENT" }, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("提交支付");
    assert.ok(probe.host.textContent.includes("支付结果未知"));
    mutable.userId = "user_B";
    mutable.identityVersion = 2;
    await probe.render();
    assert.ok(!probe.host.textContent.includes("支付结果未知"), "B must not inherit A's unknown state");
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});


test("P1-A: opening recovery consumes the frozen target object and version, never the current page opening", async () => {
  await withDom(async (window) => {
    const log = [];
    const openingNew = { ...opening, id: "opening_NEW", versionNo: "2", status: "DRAFT", acks: [] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json({ ...settlementBody, openings: [openingNew] }) },
      { match: "/openings/opening_OLD/confirm", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "状态已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "opening.confirm", resourceId: "order_A", key: "old_key", body: { versionNo: 1 }, context: { openingId: "opening_OLD", orderId: "order_A" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    const confirms = log.filter((entry) => entry.url.includes("/openings/"));
    assert.equal(confirms.length, 1, "recovery must send exactly one confirm request");
    assert.ok(confirms[0].url.includes("opening_OLD"), `recovery must use the frozen opening id: ${confirms[0].url}`);
    assert.ok(!confirms[0].url.includes("opening_NEW"), "recovery must never fall back to the current page opening");
    assert.equal(confirms[0].key, "old_key");
    assert.ok(intents.loadIntent("user_A", "opening.confirm", "order_A"), "the unresolved intent must stay frozen");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 300));
    assert.ok(!probe.host.textContent.includes("本次确认未生效"), "a read must not claim the request failed");
    await probe.dispose(() => intents.clearIntent("user_A", "opening.confirm", "order_A"));
  });
});

test("P1-B: an existing acknowledgement on the original opening is matched and releases the lock correctly", async () => {
  await withDom(async (window) => {
    const log = [];
    const openingOldAcked = { ...opening, id: "opening_OLD", status: "DRAFT", acks: [{ party: "RENTER" }] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json({ ...settlementBody, openings: [openingOldAcked] }) },
      { match: "/openings/opening_OLD/confirm", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "状态已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "opening.confirm", resourceId: "order_A", key: "old_key", body: { versionNo: 1 }, context: { openingId: "opening_OLD", orderId: "order_A" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    for (let i = 0; i < 25 && !probe.host.textContent.includes("服务端已记录你的期初确认"); i += 1) await React.act(async () => { await tick(); });
    assert.equal(intents.loadIntent("user_A", "opening.confirm", "order_A"), null, "a matched acknowledgement releases the lock");
    for (let i = 0; i < 25 && !probe.host.textContent.includes("已提交确认"); i += 1) await React.act(async () => { await tick(); });
    assert.ok(probe.host.textContent.includes("已提交确认"), "the authoritative acked state is shown");
    assert.ok(!probe.host.textContent.includes("未生效"), "the read must not be presented as a failure");
    await probe.dispose();
  });
});

test("P1-B: a payment read without a record never releases the intent or reopens payment", async () => {
  await withDom(async (window) => {
    const log = [];
    const pendingOrder = { ...paidOrder, status: "PENDING_PAYMENT" };
    const fetchImpl = router([
      { match: "payment-requests", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "订单当前不可支付" } }, 409) },
      { match: "payment-requests", method: "GET", respond: () => json({ order: { id: "order_A", status: "PENDING_PAYMENT", paidAt: null }, payment: null }) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_A", key: "pay_key", body: {} });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: pendingOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    assert.ok(intents.loadIntent("user_A", "order.payment", "order_A"), "the payment intent must stay frozen");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 300));
    assert.ok(!probe.host.textContent.includes("原请求未生效"), "a missing record is not proof of non-occurrence");
    const payButton = [...probe.host.querySelectorAll("button")].find((button) => button.textContent?.includes("提交支付"));
    assert.ok(payButton?.disabled, "payment must stay locked while the original request is unresolved");
    await probe.dispose(() => intents.clearIntent("user_A", "order.payment", "order_A"));
  });
});

test("P1-B: a decision on another version does not release the original decision intent", async () => {
  await withDom(async (window) => {
    const log = [];
    const versionNew = { id: "v_NEW", versionNo: "2", kind: "SYSTEM", early: false, versionHash: "h_new", decisions: [{ party: "OWNER", action: "CONFIRM" }] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json({ ...settlementBody, openings: [opening], settlement: versionNew, versions: [versionNew] }) },
      { match: "/settlements/v_OLD/decision", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "版本已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "settlement.decision", resourceId: "order_A", key: "old_key", body: { action: "CONFIRM", versionHash: "h_old" }, context: { versionId: "v_OLD", orderId: "order_A" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    const decisions = log.filter((entry) => entry.url.includes("/decision"));
    assert.equal(decisions.length, 1);
    assert.ok(decisions[0].url.includes("v_OLD"), "recovery must target the original version");
    assert.ok(intents.loadIntent("user_A", "settlement.decision", "order_A"), "another version's decision must not release the intent");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 300));
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.decision", "order_A"));
  });
});

test("P1-B: an unrelated recent order never proves the original create succeeded", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/api/v2/orders", method: "POST", respond: () => json({ error: { code: "CONFIRMATION_USED", message: "凭据已使用" } }, 409) },
      { match: "/api/orders?", method: "GET", respond: () => json({ items: [{ id: "order_other", displayNo: "ZZ-OTHER", createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }], nextCursor: null, limit: 5 }) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "order.create.v2", resourceId: "account_1", key: "old_key", body: {}, token: "token_1", context: { payable: "470.00" } });
    const Panel = loadPanel("user_A", async () => publishingOptions);
    const probe = createProbe(window, Panel, { accountId: "account_1", gameId: "game_1", versionId: "listing_1", releaseId: "release_1" }, fetchImpl);
    await probe.render();
    await probe.click("查询原创建结果");
    assert.ok(intents.loadIntent("user_A", "order.create.v2", "account_1"), "an unrelated order must not release the create intent");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 300));
    assert.ok(probe.host.textContent.includes("ZZ-OTHER"), "the observed list may be shown as current state only");
    assert.ok(!probe.host.textContent.includes("已确认成功"), "a list entry is not proof the original request succeeded");
    await probe.dispose(() => intents.clearIntent("user_A", "order.create.v2", "account_1"));
  });
});

test("P1-B: a failing authoritative read keeps the intent frozen", async () => {
  await withDom(async (window) => {
    const log = [];
    let reads = 0;
    const openingOld = { ...opening, id: "opening_OLD", status: "DRAFT", acks: [] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => { reads += 1; if (reads === 1) return json({ ...settlementBody, openings: [openingOld] }); throw new TypeError("network down"); } },
      { match: "/openings/opening_OLD/confirm", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "状态已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "opening.confirm", resourceId: "order_A", key: "old_key", body: { versionNo: 1 }, context: { openingId: "opening_OLD", orderId: "order_A" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    assert.ok(intents.loadIntent("user_A", "opening.confirm", "order_A"), "a failed read must keep the intent");
    assert.ok(probe.host.textContent.includes("原请求保留"), probe.host.textContent.slice(0, 300));
    await probe.dispose(() => intents.clearIntent("user_A", "opening.confirm", "order_A"));
  });
});


test("P1: a historical same-content intake never releases the submit intent", async () => {
  await withDom(async (window) => {
    const log = [];
    const historical = {
      orderId: "order_A", rentalStarted: true, openings: [opening],
      intakes: [{ id: "intake_old", versionNo: "1", status: "REJECTED", initiatorParty: "RENTER", lines: [{ itemId: "item_haff", remainingQuantity: "0" }, { itemId: "item_piece", remainingQuantity: "8" }] }],
      versions: [], currentRequest: { kind: "INTAKE", id: "intake_old", versionNo: "1", status: "REJECTED" },
      settlement: null, posting: null, ready: false, reasons: ["SETTLEMENT_INTAKE_PENDING"],
    };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json(historical) },
      { match: "/settlements", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "状态已变化" } }, 409) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "settlement.submit", resourceId: "order_A", key: "old_key", body: { lines: [{ itemId: "item_haff", remainingQuantity: "0" }, { itemId: "item_piece", remainingQuantity: "8" }], acceptedHash: "h_old" }, context: { openingId: "opening_1", openingVersion: "1" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    assert.ok(intents.loadIntent("user_A", "settlement.submit", "order_A"), "equal content is not proof the original request succeeded");
    assert.ok(probe.host.textContent.includes("仍未取得确定回执"), probe.host.textContent.slice(0, 400));
    assert.ok(!probe.host.textContent.includes("已记录本次结束提交"), "a historical intake must not be claimed as this submission");
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.submit", "order_A"));
  });
});

test("P1: decision recovery without a frozen version target blocks instead of using the current page version", async () => {
  await withDom(async (window) => {
    const log = [];
    const versionNew = { id: "v_NEW", versionNo: "2", kind: "SYSTEM", early: false, versionHash: "h_new", decisions: [{ party: "OWNER", action: "CONFIRM" }] };
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json({ ...settlementBody, openings: [opening], settlement: versionNew, versions: [versionNew] }) },
    ], log);
    intents.saveIntent({ userId: "user_A", kind: "settlement.decision", resourceId: "order_A", key: "old_key", body: { action: "CONFIRM", versionHash: "h_old" } });
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("查询原请求结果");
    assert.equal(log.filter((entry) => entry.method === "POST").length, 0, "no decision may be sent without the frozen target version");
    assert.ok(intents.loadIntent("user_A", "settlement.decision", "order_A"), "the intent stays frozen");
    assert.ok(probe.host.textContent.includes("缺少目标版本"), probe.host.textContent.slice(0, 400));
    await probe.dispose(() => intents.clearIntent("user_A", "settlement.decision", "order_A"));
  });
});

const postedVersion = {
  id: "v_posted", versionNo: "1", kind: "SYSTEM", early: false, versionHash: "h_posted", supersededAt: null,
  inputSnapshot: { lines: [{ itemId: "item_haff", openingQuantity: "1000", remainingQuantity: "200" }, { itemId: "item_piece", openingQuantity: "10", remainingQuantity: "8" }] },
  computation: { consumed: { haff: "800", items: [{ itemId: "item_piece", consumed: "2", remaining: "8" }] } },
  decisions: [{ party: "RENTER", action: "CONFIRM", createdAt: "2026-10-12T04:29:00Z" }, { party: "OWNER", action: "CONFIRM", createdAt: "2026-10-12T04:30:00Z" }],
};
const postingAmounts = {
  haffConsumedBuyer: money("224.00"), itemConsumedBuyer: money("24.00"), unusedHaffRefund: money("56.00"), unusedItemRefund: money("24.00"),
  renterCharge: money("248.00"), renterRefund: money("280.00"), depositRefund: money("200.00"), feePayer: "OWNER", feeAmount: money("14.64"), feeRate: "0.08",
  haffConsumedOwner: money("168.00"), itemConsumedOwner: money("15.00"), ownerGross: money("183.00"), ownerNet: money("168.36"),
};
const postedSettlement = {
  orderId: "order_A", rentalStarted: true, openings: [opening], intakes: [], versions: [postedVersion],
  currentRequest: { kind: "SETTLEMENT_VERSION", id: "v_posted", versionNo: "1" },
  settlement: postedVersion,
  posting: {
    id: "posting_1", settlementVersionId: "v_posted", early: false, postedAt: "2026-10-12T04:30:00Z", refundDueAt: "2026-10-19T04:30:00Z",
    capturedCents: "47000", compensationFeeCents: "1464", amounts: postingAmounts,
    owner: { gross: money("183.00"), systemNetCents: "16836", availableCents: "16836" },
    refund: { systemCents: "28000", payableCents: "28000", includesDeposit: money("200.00") },
    manualAdjustment: null,
  },
  ready: true, reasons: [],
};

test("F5: a settled order shows the effective result, its records and no owner-side leak", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "/settlement", method: "GET", respond: () => json(postedSettlement) }], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const renter = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "COMPLETED" }, party: "renter", onChanged() {} }, fetchImpl);
    await renter.render();
    assert.ok(renter.host.textContent.includes("结算已生效"), renter.host.textContent.slice(0, 300));
    assert.ok(renter.host.textContent.includes("¥248.00"), "the settled charge renders");
    assert.ok(renter.host.textContent.includes("¥280.00"), "the payable refund renders");
    assert.ok(renter.host.textContent.includes("¥470.00 元"), "the captured amount is the reconciliation figure");
    assert.ok(!renter.host.textContent.includes("预计应退"), "an effective posting is never shown as an estimate");
    assert.ok(!renter.host.textContent.includes("¥168.36"), "the renter view must not carry owner-side internals");
    assert.ok(renter.host.textContent.includes("800 哈夫币"), "consumption comes from the server computation");
    assert.ok(renter.host.textContent.includes("租客已确认") && renter.host.textContent.includes("号主已确认"), "settlement records list both decisions");
    assert.ok(renter.host.textContent.includes("退款到账结果待确认"), "the channel result stays unknown");
    await renter.dispose();

    const owner = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "COMPLETED" }, party: "owner", onChanged() {} }, fetchImpl);
    await owner.render();
    assert.ok(owner.host.textContent.includes("本单净入账"), owner.host.textContent.slice(0, 300));
    assert.ok(owner.host.textContent.includes("¥168.36"), "the owner net renders");
    assert.ok(owner.host.textContent.includes("包赔费（号主承担）"), "the fee payer comes from the server");
    assert.ok(owner.host.textContent.includes("¥14.64"), "the server fee amount renders");
    assert.ok(!owner.host.textContent.includes("最终应退"), "the owner view must not carry the renter's payable");
    assert.ok(owner.host.textContent.includes("不代表钱包全部余额"), "the owner net is not presented as a wallet balance");
    await owner.dispose();
  });
});

test("F5: an effective manual adjustment shows the system-to-final pair with its reason", async () => {
  await withDom(async (window) => {
    const adjusted = {
      ...postedSettlement,
      posting: { ...postedSettlement.posting, manualAdjustment: { reason: "客服按复核结果调整", systemOwnerNetCents: "16836", postedOwnerNetCents: "16000", systemRenterRefundCents: "28000", postedRenterRefundCents: "28836" } },
    };
    const fetchImpl = router([{ match: "/settlement", method: "GET", respond: () => json(adjusted) }], []);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "COMPLETED" }, party: "owner", onChanged() {} }, fetchImpl);
    await probe.render();
    assert.ok(probe.host.textContent.includes("人工调整"), probe.host.textContent.slice(0, 300));
    assert.ok(probe.host.textContent.includes("¥168.36 元 → ¥160.00 元"), "the adjustment shows the pair, not one overwritten figure");
    assert.ok(probe.host.textContent.includes("客服按复核结果调整"), "the human-readable reason is shown");
    assert.ok(!probe.host.textContent.includes("approvalPayloadHash"), "internal approval material is never exposed");
    await probe.dispose();
  });
});

test("a failed settlement read surfaces one recovery cluster, and nothing while it is still reading", async () => {
  await withDom(async (window) => {
    const OrderDetail = loadComponent("apps/web/src/components/order/order-detail.tsx", session("user_A")).OrderDetail;
    const pending = { resolve: () => {} };
    let answerSettlement;
    const held = new Promise((resolve) => { answerSettlement = resolve; });
    const probe = createProbe(window, OrderDetail, { orderId: "order_paid", party: "renter", status: "", accountId: undefined, state: { status: "ready", order: { ...paidOrder, status: "COMPLETED" }, error: null }, onRetry() {}, onLogin() {}, onChanged() {} },
      (input) => String(input).includes("/settlement") ? held.then(() => json({ error: { code: "NOT_FOUND", message: "Resource not found" } }, 404))
        : String(input).includes("/refunds") ? json(refundRead("order_paid")) : json({ order: paidOrder }));
    await probe.render();
    // Nothing is missing until the read has actually failed.
    assert.equal(probe.host.querySelector(".order-attention"), null, "no gap is claimed while the read is still in flight");
    await React.act(async () => { answerSettlement(); await new Promise(setImmediate); });
    await new Promise(setImmediate);
    const band = probe.host.querySelector(".order-attention");
    assert.ok(band, "the failed read surfaces a recovery block");
    assert.equal(probe.host.querySelector(".order-trade-panel"), null, "the parent recovery block replaces the failed panel");
    assert.match(probe.host.querySelector(".order-amount-block").textContent, /结算金额暂时无法读取/);
    assert.doesNotMatch(probe.host.textContent, /结算未确认/);
    assert.match(band.querySelector(".order-attention-copy h2").textContent, /结算明细暂时读不到/);
    // One cluster: talking to the person who fulfils the order leads, retrying is a link.
    const actions = band.querySelector(".order-attention-actions");
    assert.match(actions.textContent, /打开订单群列表/);
    assert.match(actions.querySelector(".order-attention-link").textContent, /重试读取/);
    assert.equal(actions.querySelectorAll("button.button, a.button").length, 1, "only one button competes for the primary action");
    await probe.dispose();
  });
});

test("F6: a settlement read that is not assembled states the gap instead of a result", async () => {
  await withDom(async (window) => {
    const fetchImpl = router([{ match: "/settlement", method: "GET", respond: () => json({ error: { code: "NOT_FOUND", message: "Resource not found" } }, 404) }], []);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: "COMPLETED" }, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    assert.ok(probe.host.textContent.includes("结算明细暂时无法读取"), probe.host.textContent.slice(0, 300));
    // The retry belongs to the one recovery cluster the page owns; the panel states the gap without
    // adding a second, near-identical button next to it.
    assert.ok(!probe.host.textContent.includes("重试"), "the panel does not duplicate the retry the page already offers");
    assert.ok(!/¥248\.00|¥280\.00|¥168\.36/.test(probe.host.textContent), "no mock settlement numbers may fill the gap");
    assert.ok(!probe.host.textContent.includes("预计应退"), "no estimate stands in for the missing settlement");
    await probe.dispose();
  });
});

test("F5: a rejected version is not a confirmation and cannot be confirmed again", async () => {
  await withDom(async (window) => {
    const rejectedDecisions = [{ party: "RENTER", action: "REJECT", reason: "数量不符", createdAt: "2026-10-12T05:00:00Z" }, { party: "OWNER", action: "CONFIRM", createdAt: "2026-10-12T05:01:00Z" }];
    const rejectedVersion = { ...postedVersion, id: "v_rejected", versionNo: "2", decisions: rejectedDecisions };
    const rejected = {
      ...postedSettlement,
      versions: [rejectedVersion],
      settlement: rejectedVersion,
      currentRequest: { kind: "SETTLEMENT_VERSION", id: "v_rejected", versionNo: "2" },
      posting: null, ready: false, reasons: ["SETTLEMENT_REJECTED"],
    };
    const fetchImpl = router([{ match: "/settlement", method: "GET", respond: () => json(rejected) }], []);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    assert.ok(probe.host.textContent.includes("你已拒绝第2版"), probe.host.textContent.slice(0, 400));
    assert.ok(!probe.buttons().some((text) => text.includes("确认结算")), "a rejected version offers no new confirmation");
    assert.ok(!probe.buttons().some((text) => text.includes("拒绝并说明")), "the same version cannot be rejected twice");
    await probe.dispose();
  });
});

test("F5: a settlement-version request without a status still opens the decision step", async () => {
  await withDom(async (window) => {
    const currentVersion = { ...postedVersion, id: "v_current", versionNo: "3", decisions: [] };
    const pending = {
      ...postedSettlement,
      versions: [currentVersion],
      settlement: currentVersion,
      currentRequest: { kind: "SETTLEMENT_VERSION", id: "v_current", versionNo: "3" },
      posting: null, ready: false, reasons: ["SETTLEMENT_REQUIRED"],
    };
    const fetchImpl = router([{ match: "/settlement", method: "GET", respond: () => json(pending) }], []);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    assert.ok(probe.host.textContent.includes("结算确认"), probe.host.textContent.slice(0, 400));
    assert.ok(probe.host.textContent.includes("第3版"), "the version number is the user-facing identity");
    assert.ok(probe.buttons().some((text) => text.includes("确认结算")), "a missing status must not be read as a failure");
    assert.ok(!probe.buttons().some((text) => text.includes("确认提前结算")), "a normal version is not an early one");
    await probe.dispose();
  });
});

test("F3: an ending quantity above the opening quantity is refused before any preview request", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([{ match: "/settlement", method: "GET", respond: () => json(settlementBody) }], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("发起结束租用");
    await probe.setInput("哈夫币 期末剩余数量", "1001");
    await probe.setInput("测试物品 期末剩余数量", "10");
    await probe.click("预览结算金额");
    assert.ok(probe.host.textContent.includes("不能大于期初数量"), probe.host.textContent.slice(0, 400));
    assert.equal(log.filter((entry) => entry.url.includes("settlement-preview")).length, 0, "an out-of-range quantity never reaches the server");
    await probe.dispose();
  });
});

test("F6: the ending input starts empty and a blank line is never read as no consumption", async () => {
  await withDom(async (window) => {
    const log = [];
    const fetchImpl = router([
      { match: "/settlement", method: "GET", respond: () => json(settlementBody) },
      { match: "settlement-preview", method: "POST", respond: () => json(previewBody) },
    ], log);
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "renter", onChanged() {} }, fetchImpl);
    await probe.render();
    await probe.click("发起结束租用");
    const haff = probe.host.querySelector('[aria-label="哈夫币 期末剩余数量"]');
    assert.equal(haff.value, "", "the ending input starts empty instead of assuming no consumption");
    await probe.setInput("哈夫币 期末剩余数量", "200");
    await probe.click("预览结算金额");
    assert.ok(probe.host.textContent.includes("留空表示未知"), "the blank line is refused as unknown");
    assert.equal(log.filter((entry) => entry.url.includes("settlement-preview")).length, 0, "an incomplete quantity never reaches the server");
    await probe.dispose();
  });
});

// --- M3 review regressions: money disclosure, party facts and full-detail consistency ---

const reviewAmounts = {
  haffConsumedBuyer: money("224.00"), itemConsumedBuyer: money("24.00"), unusedHaffRefund: money("56.00"), unusedItemRefund: money("24.00"), earlyMakeup: money("0.00"),
  ownerGross: money("183.00"), ownerNet: money("168.36"), renterRefund: money("280.00"), depositRefund: money("200.00"), renterCharge: money("248.00"),
  haffConsumedOwner: money("168.00"), itemConsumedOwner: money("15.00"), feePayer: "OWNER", feeAmount: money("14.64"), feeRate: "0.08",
};
const manualVersion = {
  id: "manual_v", versionNo: "2", kind: "MANUAL_ADJUSTMENT", early: false, versionHash: "h2", supersededAt: null,
  systemOwnerNet: "16836", proposedOwnerNet: "16000", systemRenterRefund: "28000", proposedRenterRefund: "28836",
  inputSnapshot: { reason: "复核调整", lines: [{ itemId: "item_haff", openingQuantity: "1000", remainingQuantity: "200" }] },
  computation: { amounts: reviewAmounts }, decisions: [],
};
const manualPosting = {
  id: "post", settlementVersionId: "manual_v", early: false, postedAt: "2026-10-12T02:00:00Z", capturedCents: "52800", compensationFeeCents: "1464",
  amounts: reviewAmounts, owner: { gross: money("183.00"), systemNetCents: "16836", availableCents: "16000" },
  refund: { systemCents: "28000", payableCents: "28836" },
  manualAdjustment: { reason: "复核调整", systemOwnerNetCents: "16836", postedOwnerNetCents: "16000", systemRenterRefundCents: "28000", postedRenterRefundCents: "28836" },
};
const manualSettlement = { ...settlementBody, versions: [manualVersion], settlement: manualVersion, currentRequest: { kind: "SETTLEMENT_VERSION", id: "manual_v", versionNo: "2" } };

async function tradeProbe(window, data, party = "owner") {
  const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
  const probe = createProbe(window, OrderTradeActions, { order: { ...paidOrder, status: data.posting ? "COMPLETED" : "PAID" }, party, onChanged() {} }, router([{ match: "/settlement", method: "GET", respond: () => json(data) }], []));
  await probe.render();
  return probe;
}

async function detailProbe(window, order, party, data = settlementBody, refund = refundRead(order.id)) {
  const OrderDetail = loadComponent("apps/web/src/components/order/order-detail.tsx", session("user_A")).OrderDetail;
  const probe = createProbe(window, OrderDetail, { orderId: order.id, party, status: "", accountId: undefined, state: { status: "ready", order, error: null }, onRetry() {}, onLogin() {}, onChanged() {} }, router([
    { match: "/settlement", method: "GET", respond: () => json(data) },
    { match: "/refunds", method: "GET", respond: () => json(refund) },
  ], []));
  await probe.render();
  return probe;
}

const tableRow = (host, label) => [...host.querySelectorAll("tr")].find((row) => row.querySelector("th")?.textContent === label);

test("M3-F1: a manual version discloses the amount confirmation would settle", async () => {
  await withDom(async (window) => {
    const probe = await tradeProbe(window, manualSettlement, "owner");
    const text = probe.host.textContent;
    assert.ok(text.includes("本次将确认的净额"), text.slice(0, 400));
    assert.match(tableRow(probe.host, "本次将确认的净额").textContent, /¥160\.00/, "the proposed net must be disclosed");
    assert.match(tableRow(probe.host, "系统计算净额").textContent, /¥168\.36/, "the system value stays visible as the system value");
    assert.ok(text.includes("复核调整"), "the adjustment reason is shown before confirmation");
    assert.ok(text.includes("这一版含人工调整"), "the adjustment is called out before deciding");
    await probe.dispose();
  });
});

test("M3-F1: a manual version without a proposed value never presents the system value as what will be settled", async () => {
  await withDom(async (window) => {
    const probe = await tradeProbe(window, { ...manualSettlement, versions: [{ ...manualVersion, proposedOwnerNet: null }], settlement: { ...manualVersion, proposedOwnerNet: null } }, "owner");
    const row = tableRow(probe.host, "本次将确认的净额");
    assert.ok(row, "the proposed row still appears when the server omits the value");
    assert.doesNotMatch(row.textContent, /¥168\.36/, "a missing proposal must not fall back to the system value");
    assert.match(row.textContent, /—/);
    assert.ok(row.textContent.includes("不能按系统值确认"), row.textContent);
    await probe.dispose();
  });
});

test("M3-F2: the posted breakdown uses the posting's final net and refund, not the system snapshot", async () => {
  await withDom(async (window) => {
    const owner = await tradeProbe(window, { ...manualSettlement, posting: manualPosting }, "owner");
    const ownerRow = tableRow(owner.host, "本单净入账");
    assert.match(ownerRow.textContent, /¥160\.00/, ownerRow.textContent);
    assert.doesNotMatch(ownerRow.textContent, /¥168\.36/, "the system snapshot is not the final net");
    await owner.dispose();

    const renter = await tradeProbe(window, { ...manualSettlement, posting: manualPosting }, "renter");
    const renterRow = tableRow(renter.host, "最终应退");
    assert.match(renterRow.textContent, /¥288\.36/, renterRow.textContent);
    assert.doesNotMatch(renterRow.textContent, /¥280\.00/);
    assert.match(renterRow.textContent, /¥288\.36/, "the payable refund is the final column");
    await renter.dispose();
  });
});

test("M3-F2: the whole detail shows one final amount and labels the system snapshot as such", async () => {
  await withDom(async (window) => {
    const probe = await detailProbe(window, { ...paidOrder, status: "COMPLETED" }, "owner", { ...manualSettlement, posting: manualPosting });
    const summary = probe.host.querySelector(".order-trade-facts").textContent;
    assert.match(summary, /本单净入账¥160\.00 元/, summary.slice(0, 200));
    const row = tableRow(probe.host, "本单净入账");
    assert.match(row.textContent, /¥160\.00/, "the summary and the breakdown must state the same final amount");
    assert.doesNotMatch(row.textContent, /¥168\.36/);
    const adjustment = probe.host.querySelector(".order-trade-sub").textContent;
    assert.match(adjustment, /系统净额 → 最终净额/);
    assert.match(adjustment, /¥168\.36 元 → ¥160\.00 元/, adjustment);
    const postingBlock = probe.host.querySelector(".order-trade-facts").closest(".order-trade-block").textContent;
    assert.ok(postingBlock.includes("不代表钱包全部余额"), "the owner net is not a wallet balance");
    await probe.dispose();
  });
});

test("M3-F3: the owner gross uses the Money object the API returns", async () => {
  await withDom(async (window) => {
    const probe = await tradeProbe(window, { ...manualSettlement, posting: manualPosting }, "owner");
    const gross = [...probe.host.querySelectorAll("dt")].find((node) => node.textContent === "本次毛收入");
    assert.ok(gross, "the gross row exists");
    assert.match(gross.nextElementSibling.textContent, /¥183\.00/, "a Money object is formatted as yuan, never as cents");
    assert.doesNotMatch(gross.nextElementSibling.textContent, /—/);
    await probe.dispose();
  });
});

test("M3-F4: each side reads only its own money, and an unpaid figure never claims a capture", async () => {
  await withDom(async (window) => {
    // The owner is quoted at listing time; what the renter actually pays is a different number (rental
    // discounts apply), so the owner's card must not carry the renter's figure at all.
    const ownerUnpaid = await detailProbe(window, { ...paidOrder, status: "PENDING_PAYMENT", paidAt: null }, "owner");
    const ownerCard = ownerUnpaid.host.querySelector(".order-amount-block").textContent;
    assert.match(ownerCard, /下单时号主报价/, "the owner reads their own listing quote");
    assert.doesNotMatch(ownerCard, /租客已付|租客应付/, "the owner never sees the renter's payable or captured amount");
    await ownerUnpaid.dispose();

    // The renter's own card must separate "still owed" from "already captured".
    const renterUnpaid = await detailProbe(window, { ...paidOrder, status: "PENDING_PAYMENT", paidAt: null }, "renter");
    assert.match(renterUnpaid.host.querySelector(".order-amount-label").textContent, /待支付/, "an unpaid renter order reads as still payable");
    assert.doesNotMatch(renterUnpaid.host.querySelector(".order-amount-block").textContent, /已付/, "an unpaid order never claims a capture");
    await renterUnpaid.dispose();

    const renterPaid = await detailProbe(window, { ...paidOrder, status: "COMPLETED", paidAt: "2026-10-12T01:00:00Z" }, "renter");
    assert.ok([...renterPaid.host.querySelectorAll("dt")].some((node) => node.textContent === "租客已付"), "a captured payment is still named as paid");
    await renterPaid.dispose();
  });
});

test("M3-F4: only a renter with an open payment entry is invited to pay", async () => {
  await withDom(async (window) => {
    const OrderListPanel = loadComponent("apps/web/src/components/order/order-list.tsx", session("user_A")).OrderListPanel;
    const listState = (order) => ({ page: { items: [order], nextCursor: null, limit: 20 }, loading: false, refreshing: false, loadingMore: false, error: null, moreError: null, notice: "" });
    const props = (party, order) => ({ party, status: "", accountId: undefined, state: listState(order), onRefresh() {}, onRetryList() {}, onLoadMore() {}, onLogin() {}, onReauthorize() {}, onOpen() {} });
    const noFetch = async () => { throw new Error("the list must not fetch while rendering"); };
    const pending = { ...paidOrder, status: "PENDING_PAYMENT", expiredAwaitingCancel: false };

    const owner = createProbe(window, OrderListPanel, props("owner", pending), noFetch);
    await owner.render();
    assert.ok(!owner.host.textContent.includes("查看并付款"), "the owner cannot pay for the renter");
    assert.ok(owner.host.textContent.includes("查看订单"));
    await owner.dispose();

    const renter = createProbe(window, OrderListPanel, props("renter", pending), noFetch);
    await renter.render();
    assert.ok(renter.host.textContent.includes("查看并付款"), "the renter with an open entry is invited to pay");
    await renter.dispose();

    const expired = createProbe(window, OrderListPanel, props("renter", { ...pending, expiredAwaitingCancel: true, paymentOpen: false }), noFetch);
    await expired.render();
    assert.ok(!expired.host.textContent.includes("查看并付款"), "an expired payment entry is no longer offered");
    await expired.dispose();
  });
});

test("M3-F5: a rejected settlement never falls back to the renting stage", async () => {
  await withDom(async (window) => {
    const rejected = { ...manualVersion, decisions: [{ party: "RENTER", action: "REJECT", reason: "数量不符" }] };
    const probe = await detailProbe(window, paidOrder, "renter", { ...settlementBody, versions: [rejected], settlement: rejected, currentRequest: { kind: "SETTLEMENT_VERSION", id: rejected.id, versionNo: rejected.versionNo } });
    const headline = probe.host.querySelector(".order-attention-copy h2").textContent;
    assert.match(headline, /拒绝/, `a rejected version must not read as 租用中: ${headline}`);
    assert.match(headline, /第2版/);
    // Nothing on the page may present the order as still renting or as settled while the rejection stands.
    assert.doesNotMatch(probe.host.textContent, /租用中|结算已生效/);
    assert.ok(probe.host.querySelector(".order-trade-panel").textContent.includes("你已拒绝第2版"), "the panel agrees with the attention block");
    await probe.dispose();
  });
});

test("M3-F6: a missing owner total stays unknown in the fee summary", async () => {
  await withDom(async (window) => {
    const probe = await detailProbe(window, { ...paidOrder, status: "CANCELLED" }, "owner");
    const summary = probe.host.querySelector(".order-lines-summary").textContent;
    assert.ok(!summary.includes("合计 170.00 元"), `the owner summary must not borrow the renter rental: ${summary}`);
    assert.match(summary, /合计待确认/);
    const renter = await detailProbe(window, { ...paidOrder, status: "CANCELLED" }, "renter");
    assert.match(renter.host.querySelector(".order-lines-summary").textContent, /资源合计（不含押金） 170\.00 元/, "the renter keeps its own total");
    await probe.dispose();
    await renter.dispose();
  });
});

test("M3-F7: a named resource keeps its unit and never repeats it", async () => {
  await withDom(async (window) => {
    const probe = await detailProbe(window, { ...paidOrder, status: "CANCELLED", quote: { lines: [{ itemId: "insurance", name: "保险卡", unit: "DAY", quantity: "10", buyerAmount: money("20.00") }] } }, "renter");
    const quantity = probe.host.querySelector(".order-lines tbody tr td:nth-child(2)").textContent;
    assert.match(quantity, /天/, `a DAY quantity must keep its unit: ${quantity}`);
    assert.match(quantity, /10/);
    const mixed = await detailProbe(window, { ...paidOrder, status: "CANCELLED" }, "renter");
    const cells = [...mixed.host.querySelectorAll(".order-lines tbody tr td:nth-child(2)")].map((node) => node.textContent);
    assert.equal(cells[0], "1000", "a name that already carries the unit is not repeated");
    assert.equal(cells[1], "10 件", "PIECE keeps its existing label");
    await probe.dispose();
    await mixed.dispose();
  });
});

test("a closed order offers its next step instead of a payment prompt", async () => {
  await withDom(async (window) => {
    const renter = await detailProbe(window, { ...paidOrder, status: "CANCELLED", paidAt: null }, "renter");
    const next = renter.host.querySelector(".order-attention-actions a");
    assert.ok(next, "a closed renter order points at the next step");
    assert.equal(next.getAttribute("href"), "/accounts");
    assert.doesNotMatch(renter.host.textContent, /提交支付前请核对金额|支付不等于交付或开租/);
    await renter.dispose();

    const owner = await detailProbe(window, { ...paidOrder, status: "CANCELLED", paidAt: null }, "owner");
    assert.equal(owner.host.querySelector(".order-attention-actions a").getAttribute("href"), "/account?view=accounts");
    await owner.dispose();
  });
});

const confirmLabel = (version) => (version.early ? "确认提前结算（待客服复核）" : "确认结算");

/** Renders a manual version whose proposed value for the deciding party is whatever the code under test must judge. */
async function decisionProbe(window, party, proposed) {
  const version = party === "owner" ? { ...manualVersion, proposedOwnerNet: proposed } : { ...manualVersion, proposedRenterRefund: proposed };
  const data = { ...settlementBody, versions: [version], settlement: version, currentRequest: { kind: "SETTLEMENT_VERSION", id: version.id, versionNo: version.versionNo } };
  const log = [];
  const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
  const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party, onChanged() {} },
    router([{ match: "/settlement", method: "GET", respond: () => json(data) }, { match: "/decision", method: "POST", respond: () => json(settlementBody) }], log));
  await probe.render();
  return { probe, log, version };
}

const decisionPosts = (log) => log.filter((entry) => entry.method === "POST" && entry.url.includes("/decision"));

test("R2-F1: an unreadable proposed amount disables a new confirmation and sends nothing", async () => {
  await withDom(async (window) => {
    for (const missing of [null, undefined, "invalid", "160.00", "", "-1", "1e3"]) {
      const { probe, log, version } = await decisionProbe(window, "owner", missing);
      try {
        const button = [...probe.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(confirmLabel(version)));
        assert.ok(button, "the confirmation control stays visible with a stated reason");
        assert.ok(button.disabled, `confirmation must be disabled while the proposed amount is ${JSON.stringify(missing)}`);
        assert.ok(probe.host.textContent.includes("确认已暂时停用"), "the page states why confirmation is unavailable");
        await probe.click(confirmLabel(version)).catch(() => undefined);
        assert.equal(decisionPosts(log).length, 0, `no confirmation may be sent while the proposed amount is ${JSON.stringify(missing)}`);
        assert.equal(intents.loadIntent("user_A", "settlement.decision", "order_A"), null, "nothing was frozen for a request that never should be sent");
      } finally {
        await probe.dispose(() => intents.clearIntent("user_A", "settlement.decision", "order_A"));
      }
    }
  });
});

test("R2-F1: a readable proposed amount — including a legitimate zero — still confirms", async () => {
  await withDom(async (window) => {
    for (const [proposed, party] of [["16000", "owner"], ["0", "owner"], ["28836", "renter"], ["0", "renter"]]) {
      const { probe, log, version } = await decisionProbe(window, party, proposed);
      try {
        const button = [...probe.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(confirmLabel(version)));
        assert.ok(!button.disabled, `a readable amount (${proposed}) must stay confirmable`);
        assert.doesNotMatch(probe.host.textContent, /确认已暂时停用/);
        await probe.click(confirmLabel(version));
        const posts = decisionPosts(log);
        assert.equal(posts.length, 1, `a readable amount (${proposed}) must reach the server`);
        assert.equal(posts[0].body.action, "CONFIRM");
        assert.ok(posts[0].key, "the frozen idempotency key is still used");
      } finally {
        await probe.dispose(() => intents.clearIntent("user_A", "settlement.decision", "order_A"));
      }
    }
  });
});

test("R2-F1: rejecting and querying the frozen request stay available while confirmation is unavailable", async () => {
  await withDom(async (window) => {
    const frozenKey = "op_frozen_decision";
    intents.saveIntent({ userId: "user_A", kind: "settlement.decision", resourceId: "order_A", key: frozenKey, body: { action: "CONFIRM", versionHash: "h_old" }, context: { versionId: "v_old", orderId: "order_A" } });
    const version = { ...manualVersion, proposedOwnerNet: null };
    const data = { ...settlementBody, versions: [version], settlement: version, currentRequest: { kind: "SETTLEMENT_VERSION", id: version.id, versionNo: version.versionNo } };
    const log = [];
    const OrderTradeActions = loadComponent("apps/web/src/components/order/order-trade-actions.tsx", session("user_A")).OrderTradeActions;
    const probe = createProbe(window, OrderTradeActions, { order: paidOrder, party: "owner", onChanged() {} },
      router([
        { match: "/settlement", method: "GET", respond: () => json(data) },
        { match: "/decision", method: "POST", respond: () => json({ error: { code: "CONFLICT", message: "版本已变化" } }, 409) },
      ], log));
    await probe.render();
    try {
      assert.ok(probe.host.textContent.includes("结算决定结果未知"), "the frozen request is still surfaced");
      await probe.click("查询原请求结果");
      const posts = decisionPosts(log);
      assert.equal(posts.length, 1, "the recovery query still consumes the original frozen request");
      assert.equal(posts[0].key, frozenKey, "recovery keeps the frozen key");
      assert.ok(intents.loadIntent("user_A", "settlement.decision", "order_A"), "an unresolved request keeps its responsibility");
      // Hand the panel a clean slate so the reject path is exercised without an unresolved lock.
      intents.clearIntent("user_A", "settlement.decision", "order_A");

      const rejectAfter = await decisionProbe(window, "owner", null);
      await rejectAfter.probe.click("拒绝并说明");
      await rejectAfter.probe.click("提交拒绝");
      const rejected = decisionPosts(rejectAfter.log);
      assert.equal(rejected.length, 1, "rejecting is not blocked by an unreadable proposed amount");
      assert.equal(rejected[0].body.action, "REJECT");
      await rejectAfter.probe.dispose(() => intents.clearIntent("user_A", "settlement.decision", "order_A"));
    } finally {
      await probe.dispose(() => intents.clearIntent("user_A", "settlement.decision", "order_A"));
    }
  });
});

test("R2-F2: an adjusted posting names the charge as the pre-adjustment system computation in both places", async () => {
  await withDom(async (window) => {
    const probe = await detailProbe(window, { ...paidOrder, status: "COMPLETED" }, "renter", { ...manualSettlement, posting: manualPosting });
    const summary = [...probe.host.querySelectorAll(".order-trade-facts dt")].map((node) => node.textContent);
    assert.ok(summary.includes("系统计算扣费（调整前）"), `the summary must qualify the system charge: ${JSON.stringify(summary)}`);
    assert.ok(!summary.includes("本次结算扣费"), "an adjusted posting must not present the system charge as the final one");
    const charge = [...probe.host.querySelectorAll(".order-trade-facts dd")][summary.indexOf("系统计算扣费（调整前）")].textContent;
    assert.match(charge, /¥248\.00/, charge);
    const row = tableRow(probe.host, "系统计算扣费（调整前）");
    assert.ok(row, "the breakdown uses the same label");
    assert.match(row.textContent, /¥248\.00/);
    const finalRow = tableRow(probe.host, "最终应退");
    assert.match(finalRow.textContent, /¥288\.36/, "the final refund is still the posting column");
    assert.doesNotMatch(summaryText(probe.host), /本次结算扣费¥248/, "no unqualified final charge is shown anywhere");

    const plain = await detailProbe(window, { ...paidOrder, status: "COMPLETED" }, "renter", { ...manualSettlement, posting: { ...manualPosting, manualAdjustment: null, owner: { gross: money("183.00"), systemNetCents: "16836", availableCents: "16836" }, refund: { systemCents: "28000", payableCents: "28000" } } });
    assert.ok([...plain.host.querySelectorAll(".order-trade-facts dt")].some((node) => node.textContent === "本次结算扣费"), "a normal posting keeps the plain wording");
    await probe.dispose();
    await plain.dispose();
  });
});

const summaryText = (host) => [...host.querySelectorAll(".order-trade-facts dt")].map((node, index) => `${node.textContent}${[...host.querySelectorAll(".order-trade-facts dd")][index]?.textContent ?? ""}`).join(" | ");


test("polish: expanded quote shows only own amounts and cancellation has one next step", async () => {
  await withDom(async (window) => {
    const OrderDetail = loadComponent("apps/web/src/components/order/order-detail.tsx", session("user_A")).OrderDetail;
    for (const party of ["owner", "renter"]) {
      const money = (amount) => ({ amount, currency: "CNY" });
      const order = { ...paidOrder, status: "CANCELLED", quote: { lines: [{ name: "保险卡", quantity: "10", unit: "DAY", buyerAmount: money("257.53"), ownerAmount: money("134.65") }], ownerTotal: money("134.65"), unitAmountsInformational: true } };
      const probe = createProbe(window, OrderDetail, { orderId: order.id, party, status: "", state: { status: "ready", order, error: null }, onRetry() {}, onLogin() {}, onChanged() {} }, async (input) => {
        if (String(input).includes("/refunds")) return json(refundRead(order.id));
        throw new Error("cancelled detail must not fetch settlement");
      });
      try {
        await probe.render();
        const table = probe.host.querySelector(".order-lines table");
        assert.equal(table.querySelectorAll("th").length, 3);
        assert.ok(table.textContent.includes(party === "owner" ? "134.65 元" : "257.53 元"));
        assert.ok(!table.textContent.includes(party === "owner" ? "257.53 元" : "134.65 元"));
        assert.equal(probe.host.querySelectorAll(".order-trade-panel").length, 0);
        assert.doesNotMatch(probe.host.textContent, /继续租用|服务端派生/);
        assert.equal([...probe.host.querySelectorAll("a")].filter(a => a.textContent === (party === "owner" ? "管理上架账号" : "浏览可租账号")).length, 1);
      } finally { await probe.dispose(); }
    }
  });
});


test("legacy orders remain read-only and only owners get authorized account navigation", async () => {
  await withDom(async (window) => {
    for (const party of ["owner", "renter"]) {
      const row = { id: "legacy_1", displayNo: "OLD-1", title: "历史记录", party, status: "PAID", source: { origin: "LEGACY", statusLabel: "历史进行中" }, readOnly: true, actions: [], account: { id: "account_1", displayNo: "OLD-A", readable: party === "owner" }, legacyAmounts: { required: money("10.00"), paid: money("10.00"), deposit: null, refund: money("2.00") } };
      const Legacy = loadComponent("apps/web/src/components/order/legacy-order-workspace.tsx", session("user_A")).LegacyOrderWorkspace;
      const log=[]; const fetchImpl=async (url,init={}) => {log.push(init.method??"GET");return json({order:row});};
      const probe=createProbe(window,Legacy,{party,orderId:"legacy_1"},fetchImpl);
      try { await probe.render();assert.match(probe.host.textContent,/原退款金额记录/);assert.doesNotMatch(probe.host.textContent,/应退金额（到账待确认）|应退责任 /);assert.equal(probe.host.querySelectorAll("button").length,0);assert.equal(Boolean(probe.host.querySelector('a[href*="view=accounts"]')),party==="owner");assert.ok(log.every(m=>m==="GET")); } finally {await probe.dispose();}
    }
  });
});

test("legacy unauthorized detail is an error rather than an empty successful list", async () => {
  await withDom(async window=>{
    const Legacy=loadComponent("apps/web/src/components/order/legacy-order-workspace.tsx",session("user_A")).LegacyOrderWorkspace;
    const probe=createProbe(window,Legacy,{party:"renter",orderId:"other"},async()=>json({error:{code:"NOT_FOUND"}},404));
    try {await probe.render();assert.match(probe.host.textContent,/不存在或当前身份无法查看/);assert.doesNotMatch(probe.host.textContent,/暂无历史订单记录/);}finally{await probe.dispose();}
  });
});

test("legacy detail exposes the complete frozen resource record after the short summary", async () => {
  await withDom(async window=>{
    const row={id:'legacy_resources',displayNo:'OLD-R',title:null,party:'renter',status:'COMPLETED',source:{origin:'LEGACY',statusLabel:'已完成'},readOnly:true,account:{id:null,displayNo:null,readable:false},legacyAmounts:{required:money('1.00'),paid:money('1.00'),deposit:null,refund:null},orderFacts:{resources:[
      {code:'df_billable_haff',quantity:'64.00',unit:null},{code:'df_billable_awm_bullet',quantity:'46',unit:null},{code:'df_billable_level6_helmet',quantity:'4',unit:null},{code:'df_billable_level6_armor',quantity:'7',unit:null},{code:'df_billable_top_insure_card',quantity:'0',unit:'DAY'},
    ],rentalDeadlineAt:null}};
    const Legacy=loadComponent('apps/web/src/components/order/legacy-order-workspace.tsx',session('user_A')).LegacyOrderWorkspace;
    const methods=[];const probe=createProbe(window,Legacy,{party:'renter',orderId:row.id},async(url,init={})=>{methods.push(init.method??'GET');return json({order:row});});
    try{await probe.render();const section=[...probe.host.querySelectorAll('section')].find(node=>node.querySelector(':scope > h3')?.textContent==='本单资源记录');assert.ok(section,'the detail has a full resource section');assert.deepEqual([...section.querySelectorAll('dt')].map(node=>node.textContent),['哈夫币','AWM子弹','6级头盔','6级护甲','顶级保险卡']);assert.deepEqual([...section.querySelectorAll('dd')].map(node=>node.textContent),['64.00','46','4','7','0 天']);assert.match(probe.host.textContent,/\+1项/);assert.ok(methods.every(method=>method==='GET'));}finally{await probe.dispose();}
  });
});

test("Native UI queries the original channel number without creating a new request",async()=>{
 await withDom(async window=>{
  let reads=0,queries=0;
  const view=()=>channelView("order_A",{dataOrigin:"JOINPAY_CANDIDATE",request:channelRequest("UNKNOWN"),
    projection:{displayState:"CONFIRMING",actionBlockedReason:"CHANNEL_RESULT_UNKNOWN"}});
  const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async(url,init={})=>{
    const method=(init.method??"GET").toUpperCase();
    if(method==="POST"){
      assert.match(String(url),/\/channel-payment-requests\/query$/);
      queries++;assert.equal(new Headers(init.headers).get("idempotency-key"),null);
      return json({contractVersion:"order-payment-request.v1",request:{id:"payreq_component",orderId:"order_A",state:"UNKNOWN"},query:{kind:"OBSERVED",event:"E4",result:"QUERY_SUCCEEDED"}});
    }
    reads++;return json(view());
  });
  try{
    await probe.render();
    assert.ok(probe.buttons().some(t=>t.includes("查询渠道结果")));
    await probe.click("查询渠道结果");await tick();
    assert.equal(queries,1);assert.equal(reads,2);
    assert.match(probe.host.textContent,/已按原商户号查询渠道结果/);
    assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳/);
    assert.ok(probe.host.querySelector('a.order-channel-payment')===null);
  }finally{await probe.dispose(()=>{});}
 });
});

test("Native UI shows unknown query commit as unresolved without claiming a channel result",async()=>{
 await withDom(async window=>{
  const view=()=>channelView("order_A",{dataOrigin:"JOINPAY_CANDIDATE",request:channelRequest("UNKNOWN"),
    projection:{displayState:"CONFIRMING",actionBlockedReason:"CHANNEL_RESULT_UNKNOWN"}});
  const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async(url,init={})=>{
    if((init.method??"GET").toUpperCase()==="POST")return json({contractVersion:"order-payment-request.v1",request:{id:"payreq_component",orderId:"order_A",state:"UNKNOWN"},query:{kind:"UNKNOWN_COMMIT"}},202);
    assert.match(String(url),/channel-payment-requests$/);return json(view());
  });
  try{
    await probe.render();await probe.click("查询渠道结果");await tick();
    assert.match(probe.host.textContent,/查询结果提交尚未确认/);
    assert.doesNotMatch(probe.host.textContent,/已按原商户号查询渠道结果|渠道付款已接纳/);
  }finally{await probe.dispose(()=>{});}
 });
});

test("Native UI leaves an already-successful observation to acceptance recovery",async()=>{
 await withDom(async window=>{
  const view=()=>channelView("order_A",{dataOrigin:"JOINPAY_CANDIDATE",request:channelRequest("UNKNOWN"),
    projection:{displayState:"CONFIRMING",actionBlockedReason:"CHANNEL_RESULT_UNKNOWN"}});
  const Component=loadComponent("apps/web/src/components/order/order-trade-actions.tsx",session("user_A")).OrderTradeActions;
  const probe=createProbe(window,Component,{order:channelOrder,party:"renter",onChanged(){}},async(url,init={})=>{
    if((init.method??"GET").toUpperCase()==="POST")return json({contractVersion:"order-payment-request.v1",request:{id:"payreq_component",orderId:"order_A",state:"CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE"},query:{kind:"PENDING_ACCEPTANCE"}});
    assert.match(String(url),/channel-payment-requests$/);return json(view());
  });
  try{
    await probe.render();await probe.click("查询渠道结果");await tick();
    assert.match(probe.host.textContent,/正在走既有接纳\/恢复/);
    assert.doesNotMatch(probe.host.textContent,/渠道付款已接纳/);
  }finally{await probe.dispose(()=>{});}
 });
});

test("C02: renter refund section separates frozen responsibility, local write-off, saved evidence and arrival", async () => {
  await withDom(async (window) => {
    const read = refundRead("order_A", {
      status: "AVAILABLE", outcome: "FULLY_CONSUMED",
      responsibility: { state: "POSTED", postingId: "posting_1", originalCents: "28000", allocatedCents: "28000", consumedCents: "28000", releasedCents: "0", remainingCents: "0", totalsComplete: true, dueAt: "2026-10-19T04:30:00Z", dueState: "DUE" },
      intents: [refundIntent()], returnedIntentCount: 1,
    });
    const probe = await detailProbe(window, { ...paidOrder, status: "COMPLETED" }, "renter", postedSettlement, read);
    try {
      const section = probe.host.querySelector(".order-refund-block");
      assert.ok(section, "the refund section renders for a renter native order");
      assert.match(section.textContent, /本地已全部核销/);
      assert.match(section.textContent, /过账退款责任/);
      assert.match(section.textContent, /¥280\.00/);
      assert.match(section.textContent, /本地核销/);
      assert.match(section.textContent, /本地保存的渠道回执（未重验）/);
      assert.match(section.textContent, /渠道成功/);
      assert.match(section.textContent, /实际渠道退款、退款去向与银行到账均未核验/);
      assert.doesNotMatch(section.textContent, /退款成功|退款已到账|银行已到账/);
      assert.deepEqual([...section.querySelectorAll("button")].map((button) => button.textContent.trim()), ["重新读取"], "refund area is read-only");
    } finally { await probe.dispose(); }
  });
});

test("C02: cancelled and pending renter orders still read local responsibility, while owners are excluded", async () => {
  await withDom(async (window) => {
    for (const status of ["CANCELLED", "PENDING_PAYMENT"]) {
      const probe = await detailProbe(window, { ...paidOrder, status, paidAt: null }, "renter");
      try {
        const section = probe.host.querySelector(".order-refund-block");
        assert.ok(section, `refund section renders for ${status}`);
        assert.match(section.textContent, /本地尚无过账退款责任/);
        assert.match(section.textContent, /不代表渠道未收款/);
        assert.doesNotMatch(section.textContent, /没有退款记录/);
      } finally { await probe.dispose(); }
    }
    const owner = await detailProbe(window, { ...paidOrder, status: "CANCELLED" }, "owner");
    try { assert.equal(owner.host.querySelector(".order-refund-block"), null, "owner detail never shows the renter refund projection"); } finally { await owner.dispose(); }
  });
});

test("C02: a legitimate renter's unexpected 404/503 is unavailable with its request ID, never 'no refund'", async () => {
  await withDom(async (window) => {
    for (const [status, code, requestId] of [[404, "NOT_FOUND", "req_refund_404"], [503, "EVIDENCE_UNAVAILABLE", "req_refund_503"]]) {
      const OrderDetail = loadComponent("apps/web/src/components/order/order-detail.tsx", session("user_A")).OrderDetail;
      const probe = createProbe(window, OrderDetail, { orderId: "order_A", party: "renter", status: "", state: { status: "ready", order: { ...paidOrder, status: "COMPLETED" }, error: null }, onRetry() {}, onLogin() {}, onChanged() {} }, async (input) => {
        if (String(input).includes("/refunds")) return json({ error: { code, message: "synthetic unavailable", requestId } }, status);
        if (String(input).includes("/settlement")) return json(settlementBody);
        return json({ order: paidOrder });
      });
      try {
        await probe.render();
        const section = probe.host.querySelector(".order-refund-block");
        assert.ok(section);
        assert.match(section.textContent, /暂时无法读取|暂时不可用/);
        assert.match(section.textContent, new RegExp(`查询编号：${requestId}`));
        assert.match(section.textContent, /不代表没有退款/);
        assert.doesNotMatch(section.textContent, /本地尚无过账退款责任|没有退款记录/);
      } finally { await probe.dispose(); }
    }
  });
});

test("C02: truncated or conflicting refund reads never present a complete total", async () => {
  await withDom(async (window) => {
    for (const [outcome, reason] of [["TRUNCATED", "INTENT_LIMIT_EXCEEDED"], ["CONFLICT", "LEDGER_BINDING_MISMATCH"]]) {
      const intents = outcome === "TRUNCATED" ? Array.from({ length: 50 }, (_, index) => refundIntent({ intentId: `intent_refund_${index}` })) : [refundIntent()];
      const read = refundRead("order_A", {
        status: "AVAILABLE", outcome,
        coverage: { scope: "LOCAL_REGISTERED_ONLY", intentLimit: 50, intentsComplete: false, channelRecordsChecked: false },
        responsibility: { state: "POSTED", postingId: "posting_1", originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, dueAt: null, dueState: "UNKNOWN" },
        intents, returnedIntentCount: intents.length, intentsTruncated: outcome === "TRUNCATED", reasonCodes: [reason],
      });
      const probe = await detailProbe(window, { ...paidOrder, status: "COMPLETED" }, "renter", postedSettlement, read);
      try {
        const section = probe.host.querySelector(".order-refund-block");
        assert.match(section.textContent, /不完整/);
        assert.match(section.textContent, /缺失项不会按 0 计算/);
        assert.match(section.textContent, outcome === "TRUNCATED" ? /仅列出已返回的部分/ : /存在冲突/);
        assert.doesNotMatch(section.querySelector(".order-refund-amounts").textContent, /¥280\.00/, "intent amounts never become a responsibility total");
        assert.match(section.querySelector(".order-refund-amounts").textContent, /待确认/);
      } finally { await probe.dispose(); }
    }
  });
});

test("C02: switching users discards a late refund response from the previous subject", async () => {
  await withDom(async (window) => {
    const mutable = session("user_A");
    const first = deferred(), second = deferred();
    const OrderDetail = loadComponent("apps/web/src/components/order/order-detail.tsx", mutable).OrderDetail;
    const props = { orderId: "order_A", party: "renter", status: "", state: { status: "ready", order: { ...paidOrder, status: "COMPLETED" }, error: null }, onRetry() {}, onLogin() {}, onChanged() {} };
    const probe = createProbe(window, OrderDetail, props, async (input, init = {}) => {
      if (String(input).includes("/refunds")) {
        const who = new Headers(init.headers).get("x-zzsh-expected-user-id");
        return who === "user_A" ? first.promise : second.promise;
      }
      if (String(input).includes("/settlement")) return json(settlementBody);
      return json({ order: paidOrder });
    });
    try {
      await probe.render();
      mutable.userId = "user_B"; mutable.identityVersion = 2;
      await probe.render(props);
      const oldBody = refundRead("order_A", { subjectId: "user_A", status: "AVAILABLE", outcome: "FULLY_CONSUMED", responsibility: { state: "POSTED", postingId: "posting_1", originalCents: "99900", allocatedCents: "99900", consumedCents: "99900", releasedCents: "0", remainingCents: "0", totalsComplete: true, dueAt: "2026-10-19T04:30:00Z", dueState: "DUE" }, intents: [refundIntent({ amount: { cents: "99900", currency: "CNY" } })], returnedIntentCount: 1 });
      const newBody = refundRead("order_A", { subjectId: "user_B", status: "AVAILABLE", outcome: "FULLY_ALLOCATED", responsibility: { state: "POSTED", postingId: "posting_2", originalCents: "22200", allocatedCents: "22200", consumedCents: "0", releasedCents: "0", remainingCents: "0", totalsComplete: true, dueAt: "2026-10-19T04:30:00Z", dueState: "DUE" }, intents: [refundIntent({ amount: { cents: "22200", currency: "CNY" } })], returnedIntentCount: 1 });
      await React.act(async () => {
        first.resolve(json(oldBody));
        second.resolve(json(newBody));
        await new Promise(setImmediate);
      });
      await new Promise(setImmediate);
      const section = probe.host.querySelector(".order-refund-block");
      assert.match(section.textContent, /¥222\.00/);
      assert.doesNotMatch(section.textContent, /¥999\.00/);
      assert.doesNotMatch(section.textContent, /本地已全部核销/);
    } finally { await probe.dispose(() => {}); }
  });
});

// SYNTHETIC_READER_COMPONENT: accepted C04B DTO shape only; no real PG, channel or bank fact.
const abnormalFirstSubmit=(over={})=>({dispatch:"NEVER_DISPATCHED",blockedReason:"ABNORMAL_BASIS_REVIEW",blockedAt:"2026-10-27T02:00:00Z",blockedAuditCount:1,trust:"LOCAL_AUDIT_AND_ATTEMPT",...over});
const abnormalResponsibility=(over={})=>({confirmationId:"confirm_1",reasonCode:"LATE_PAYMENT",originalCents:"5000",currency:"CNY",liabilityRootId:"root_1",liabilityEventId:"event_1",intentIds:["intent_refund_1"],allocatedCents:"5000",consumedCents:"0",releasedCents:"0",remainingCents:"0",totalsComplete:true,state:"REVIEW_REQUIRED",firstSubmit:abnormalFirstSubmit(),reasonCodes:[],...over});
const responsibilityTotals=(over={})=>({originalCents:"5000",allocatedCents:"5000",consumedCents:"0",releasedCents:"0",remainingCents:"0",totalsComplete:true,postingOriginalCents:null,abnormalOriginalCents:"5000",abnormalConfirmationCount:1,...over});

test("C04B: a cancelled order with no posting still shows abnormal responsibility without a payment claim", async () => {
  await withDom(async (window) => {
    const read = refundRead("order_A", {
      status: "AVAILABLE", outcome: "REVIEW_REQUIRED",
      responsibility: { state: "NOT_POSTED", postingId: null, originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, dueAt: null, dueState: "UNKNOWN" },
      abnormalResponsibilities: [abnormalResponsibility()], responsibilitiesTruncated: false,
      responsibilityTotals: responsibilityTotals(),
      intents: [refundIntent({ intentId: "intent_refund_1", basisKind: "REVIEW_CONFIRMATION", paymentConfirmationId: "confirm_1", firstSubmit: abnormalFirstSubmit(), amount: { cents: "5000", currency: "CNY" }, state: "READY", budgetDisposition: "ALLOCATED", savedChannelEvidence: null, localAccounting: { disposition: "ALLOCATED", writeOff: null, release: null, reasonCodes: [] } })],
      returnedIntentCount: 1,
    });
    const probe = await detailProbe(window, { ...paidOrder, status: "CANCELLED", paidAt: null }, "renter", settlementBody, read);
    try {
      const section = probe.host.querySelector(".order-refund-block");
      assert.match(section.textContent, /异常收款责任/);
      assert.match(section.textContent, /迟到的支付/);
      assert.match(section.textContent, /原款责任/);
      assert.match(section.textContent, /¥50\.00/);
      assert.match(section.textContent, /尚未分配/);
      assert.match(section.textContent, /本地复核：异常原款复核，从未派发/);
      assert.match(section.textContent, /唯一责任合计/);
      assert.match(section.textContent, /正常过账责任/);
      assert.doesNotMatch(section.textContent, /没有退款记录|渠道已收到|银行已到账|退款已到账/);
      assert.deepEqual([...section.querySelectorAll("button")].map((button) => button.textContent.trim()), ["重新读取"]);
    } finally { await probe.dispose(); }
  });
});

test("C04B: one conflicting original does not hide the valid posting or the other abnormal original", async () => {
  await withDom(async (window) => {
    const read = refundRead("order_A", {
      status: "AVAILABLE", outcome: "CONFLICT",
      responsibility: { state: "POSTED", postingId: "posting_1", originalCents: "28000", allocatedCents: "28000", consumedCents: "28000", releasedCents: "0", remainingCents: "0", totalsComplete: true, dueAt: "2026-10-19T04:30:00Z", dueState: "DUE" },
      abnormalResponsibilities: [
        abnormalResponsibility(),
        abnormalResponsibility({ confirmationId: "confirm_bad", reasonCode: "DUPLICATE_PAYMENT", originalCents: null, currency: null, liabilityRootId: null, liabilityEventId: null, intentIds: [], allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, state: "CONFLICT", firstSubmit: null }),
      ],
      responsibilitiesTruncated: false,
      responsibilityTotals: responsibilityTotals({ originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, postingOriginalCents: "28000", abnormalOriginalCents: null, abnormalConfirmationCount: 2 }),
      intents: [refundIntent({ intentId: "intent_refund_1", basisKind: "REVIEW_CONFIRMATION", paymentConfirmationId: "confirm_1", firstSubmit: abnormalFirstSubmit(), amount: { cents: "5000", currency: "CNY" }, state: "READY", budgetDisposition: "ALLOCATED", savedChannelEvidence: null, localAccounting: { disposition: "ALLOCATED", writeOff: null, release: null, reasonCodes: [] } })],
      returnedIntentCount: 1,
    });
    const probe = await detailProbe(window, { ...paidOrder, status: "COMPLETED" }, "renter", settlementBody, read);
    try {
      const section = probe.host.querySelector(".order-refund-block");
      assert.equal(section.querySelectorAll(".order-refund-abnormal-item").length, 2);
      assert.match(section.textContent, /该原款关联异常或合计不完整，金额\/合计不可用/);
      assert.match(section.textContent, /唯一责任合计不完整/);
      assert.match(section.querySelector(".order-refund-amounts").textContent, /¥280\.00/, "the valid posting responsibility remains readable");
      assert.match(section.textContent, /异常原款复核|本地复核/);
    } finally { await probe.dispose(); }
  });
});

test("C04B: released retries keep one original responsibility and never sum intent amounts", async () => {
  await withDom(async (window) => {
    const read = refundRead("order_A", {
      status: "AVAILABLE", outcome: "RELEASED",
      responsibility: { state: "NOT_POSTED", postingId: null, originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, dueAt: null, dueState: "UNKNOWN" },
      abnormalResponsibilities: [abnormalResponsibility({ state: "RELEASED", allocatedCents: "5000", consumedCents: "0", releasedCents: "5000", remainingCents: "0", totalsComplete: true, intentIds: ["intent_refund_1", "intent_refund_2"] })],
      responsibilitiesTruncated: false,
      responsibilityTotals: responsibilityTotals({ allocatedCents: "5000", consumedCents: "0", releasedCents: "5000", remainingCents: "0", totalsComplete: true }),
      intents: [
        refundIntent({ intentId: "intent_refund_1", basisKind: "REVIEW_CONFIRMATION", paymentConfirmationId: "confirm_1", amount: { cents: "5000", currency: "CNY" }, state: "FAILED", budgetDisposition: "RELEASED", savedChannelEvidence: null, localAccounting: { disposition: "RELEASED", writeOff: null, release: { intentUpdatedAt: "2026-10-27T02:00:00Z", ledgerEventId: null, trust: "LOCAL_INTENT_ONLY" }, reasonCodes: [] } }),
        refundIntent({ intentId: "intent_refund_2", basisKind: "REVIEW_CONFIRMATION", paymentConfirmationId: "confirm_1", amount: { cents: "5000", currency: "CNY" }, state: "READY", budgetDisposition: "ALLOCATED", savedChannelEvidence: null, localAccounting: { disposition: "ALLOCATED", writeOff: null, release: null, reasonCodes: [] } }),
      ],
      returnedIntentCount: 2,
    });
    const probe = await detailProbe(window, { ...paidOrder, status: "CANCELLED", paidAt: null }, "renter", settlementBody, read);
    try {
      const section = probe.host.querySelector(".order-refund-block");
      assert.equal(section.querySelectorAll(".order-refund-abnormal-item").length, 1, "one original responsibility, not one per retry");
      assert.equal(section.querySelectorAll(".order-refund-intent").length, 3, "one abnormal responsibility plus two intent records");
      assert.match(section.querySelector(".order-refund-abnormal-item").textContent, /原款责任/);
      assert.doesNotMatch(section.textContent, /¥100\.00|100\.00/, "intent amounts are not summed into a responsibility");
      assert.match(section.textContent, /本地已释放/);
    } finally { await probe.dispose(); }
  });
});

test("C04B: merged truncation marks both lists incomplete but leaves valid posting responsibility readable", async () => {
  await withDom(async (window) => {
    const read = refundRead("order_A", {
      status: "AVAILABLE", outcome: "TRUNCATED",
      responsibility: { state: "POSTED", postingId: "posting_1", originalCents: "28000", allocatedCents: "28000", consumedCents: "28000", releasedCents: "0", remainingCents: "0", totalsComplete: true, dueAt: "2026-10-19T04:30:00Z", dueState: "DUE" },
      abnormalResponsibilities: [abnormalResponsibility(), abnormalResponsibility({ confirmationId: "confirm_2", reasonCode: "DUPLICATE_PAYMENT" })],
      responsibilitiesTruncated: true,
      responsibilityTotals: responsibilityTotals({ originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, postingOriginalCents: "28000", abnormalOriginalCents: null, abnormalConfirmationCount: 2 }),
      coverage: { scope: "LOCAL_REGISTERED_ONLY", intentLimit: 50, intentsComplete: false, channelRecordsChecked: false },
      intents: [refundIntent({ basisKind: "REVIEW_CONFIRMATION", paymentConfirmationId: "confirm_1", firstSubmit: abnormalFirstSubmit() })],
      returnedIntentCount: 1, intentsTruncated: true,
    });
    const probe = await detailProbe(window, { ...paidOrder, status: "COMPLETED" }, "renter", settlementBody, read);
    try {
      const section = probe.host.querySelector(".order-refund-block");
      assert.match(section.textContent, /异常原款记录不完整/);
      assert.match(section.textContent, /唯一责任合计不完整/);
      assert.match(section.textContent, /退款申请记录范围不完整/);
      assert.match(section.querySelector(".order-refund-amounts").textContent, /¥280\.00/, "the posting basis can remain complete");
      assert.equal(section.querySelectorAll(".order-refund-abnormal-item").length, 2);
    } finally { await probe.dispose(); }
  });
});

test("C04B: dispatched and unknown first-submit facts are stated without claiming delivery", async () => {
  await withDom(async (window) => {
    const read = refundRead("order_A", {
      status: "AVAILABLE", outcome: "UNKNOWN",
      responsibility: { state: "NOT_POSTED", postingId: null, originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, dueAt: null, dueState: "UNKNOWN" },
      abnormalResponsibilities: [
        abnormalResponsibility({ confirmationId: "confirm_dispatched", state: "UNKNOWN", firstSubmit: abnormalFirstSubmit({ dispatch: "DISPATCHED", blockedReason: null, blockedAt: null, blockedAuditCount: null }) }),
        abnormalResponsibility({ confirmationId: "confirm_unknown", state: "UNKNOWN", firstSubmit: abnormalFirstSubmit({ dispatch: "UNKNOWN", blockedReason: null, blockedAt: null, blockedAuditCount: null }) }),
      ],
      responsibilitiesTruncated: false,
      responsibilityTotals: responsibilityTotals({ originalCents: "10000", allocatedCents: "10000", consumedCents: "0", releasedCents: "0", remainingCents: "0", totalsComplete: true, abnormalOriginalCents: "10000", abnormalConfirmationCount: 2 }),
      intents: [], returnedIntentCount: 0,
    });
    const probe = await detailProbe(window, { ...paidOrder, status: "COMPLETED" }, "renter", settlementBody, read);
    try {
      const section = probe.host.querySelector(".order-refund-block");
      assert.match(section.textContent, /已有提交尝试，是否送达\/到账未核实/);
      assert.match(section.textContent, /提交状态未知/);
      assert.doesNotMatch(section.textContent, /渠道已收到|渠道处理中|银行已到账|退款已到账/);
    } finally { await probe.dispose(); }
  });
});

test('paid prestart termination keeps payment wording and time; unpaid cancellation keeps snapshot wording',async()=>{
 await withDom(async window=>{
  const paid=await detailProbe(window,{...paidOrder,status:'CANCELLED',cancelReason:'PRESTART_TERMINATED',paidAt:'2026-10-28T09:00:00.000000Z',cancelledAt:'2026-10-28T09:10:00.000000Z'},'renter');
  const text=paid.host.textContent??'';
  assert.match(text,/租客已付/);assert.match(text,/未开租订单已终止/);
  assert.doesNotMatch(text,/本金额为下单时的订单快照，不代表已扣款或应退款/);
  await paid.dispose();
  const unpaid=await detailProbe(window,{...paidOrder,status:'CANCELLED',cancelReason:'TIMEOUT',paidAt:null},'renter');
  assert.match(unpaid.host.textContent??'',/下单金额/);assert.doesNotMatch(unpaid.host.textContent??'',/租客已付/);
  await unpaid.dispose();
 });
});
