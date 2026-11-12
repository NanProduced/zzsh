import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4292/support" });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Element = browser.Element;
globalThis.Node = browser.Node;
globalThis.Event = browser.Event;
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.CustomEvent = browser.CustomEvent;
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { OrderFulfillmentSection } = await vite.ssrLoadModule("/src/views/im-support-fulfillment.tsx");
const { SupportPoststartCancelCard } = await vite.ssrLoadModule("/src/views/support-poststart-cancel.tsx");
after(async () => { await vite.close(); });
beforeEach(() => { browser.localStorage.clear(); });

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}
async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}
const settlement = { orderId: "order-A", rentalStarted: false, openings: [], settlement: null, ready: false, reasons: ["SETTLEMENT_VERSION_MISSING"] };
const preview = {
  contractVersion: "admin-support-cancel.v1", orderId: "order-A", orderRevision: "1", orderStatus: "PAID", cancelReason: null, cancelledAt: null,
  eligibility: { allowed: true, reason: null, refundCents: "15908", openingConfirmed: false }, openingConfirmed: false,
  supportCancellation: null, refund: null, existing: false, channel: null,
};
const success = {
  ...preview, orderRevision: "2", orderStatus: "CANCELLED", cancelReason: "SUPPORT_CANCELLED_REFUND", cancelledAt: "2026-10-30T00:00:00.000000Z",
  eligibility: { allowed: false, reason: "ALREADY_CANCELLED", refundCents: "15908", openingConfirmed: false },
  supportCancellation: { terminationId: "pterm_1", state: "APPROVED", reason: "客服核实后取消", reviewReason: "客服核实后取消",
    approvedAt: "2026-10-30T00:00:00.000000Z", requestedByAdminUserId: "admin-A", refundCents: "15908", currency: "CNY", liabilityRecognized: true },
  refund: { integration: "INTEGRATED", intents: [], totals: { originalCents: "15908", allocatedCents: "0", consumedCents: "0", releasedCents: "0", remainingCents: "15908", totalsComplete: true }, bankArrival: "UNKNOWN" },
  existing: false, channel: { result: "NOT_SUBMITTED", bankArrival: "UNKNOWN" },
};
function mount() {
  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  return { host, root: createRoot(host) };
}
async function render(root, host, props = {}) {
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", orderStatus: "PAID", canManualClose: true, ...props })); });
  await waitFor(() => Boolean(host.querySelector('[data-action="open-fulfillment-panel"]')));
}
function button(host, text) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
}
async function click(node) {
  assert.ok(node, "button available");
  await act(async () => { node.click(); });
  await settle();
}
async function typeReason(value) {
  const textarea = document.body.querySelector('textarea[aria-label="客服取消原因"]');
  assert.ok(textarea, "reason textarea available");
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set;
  setter.call(textarea, value);
  await act(async () => { textarea.dispatchEvent(new browser.Event("input", { bubbles: true })); });
  await settle();
}

test("取消订单入口用 alert dialog 二次确认：金额/原因必填/幂等提交/成功后展示真实退款状态", async (t) => {
  const requests = [];
  let posted = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", key: new Headers(init.headers).get("idempotency-key"), body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response(settlement);
    if (url.endsWith("/orders/order-A/support-cancel") && (init.method ?? "GET") === "GET") return response(posted ? success : preview);
    if (url.endsWith("/orders/order-A/support-cancel") && init.method === "POST") { posted = true; return response(success); }
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  const card = host.querySelector('[data-support-cancel="true"]');
  assert.ok(card, "support cancellation card is visible for paid orders with support write permission");
  assert.match(card.textContent, /取消未开租订单/);
  assert.match(card.textContent, /仅限尚未确认开租/);
  assert.match(card.textContent, /已开租订单请使用正常或提前结算/);
  assert.doesNotMatch(card.textContent, /开租前和开租后都|不按已用时间扣费/);
  await click(button(host, "取消订单"));
  await waitFor(() => document.body.querySelector('[aria-label="取消订单确认"]'));
  assert.match(document.body.textContent, /退款金额：¥159\.08/);
  assert.match(document.body.textContent, /原支付金额/);
  assert.match(document.body.textContent, /银行到账状态未知/);
  const confirm = [...document.body.querySelectorAll("button")].find((item) => item.textContent.includes("确认取消并退款"));
  assert.ok(confirm);
  assert.equal(confirm.disabled, true, "an empty reason cannot submit");
  await typeReason("客服核实后取消并退款");
  assert.equal(confirm.disabled, false);
  await click(confirm);
  await waitFor(() => host.querySelector('[data-support-cancel="true"]').textContent.includes("已取消并登记全额退款"));
  const post = requests.find((item) => item.method === "POST");
  assert.ok(post);
  assert.match(post.url, /\/orders\/order-A\/support-cancel$/);
  assert.match(post.key, /^support_cancel_order-A_/);
  assert.deepEqual(JSON.parse(post.body), { expectedOrderRevision: "1", reason: "客服核实后取消并退款" });
  assert.match(host.textContent, /退款金额 ¥159\.08/);
  assert.match(host.textContent, /退款责任已登记/);
  assert.match(host.textContent, /银行到账未知/);
});

test("模拟付款的客服取消在提交前后都不冒充真实退款", async (t) => {
  const demoPreview={...preview,simulationScope:'ECS_TEST_SIMULATED'};
  const demoSuccess={...success,simulationScope:'ECS_TEST_SIMULATED',refund:{...success.refund,intents:[{state:'SUCCEEDED',requiresReview:false}]}};
  let posted=false;
  globalThis.fetch=async(input,init={})=>{
    const url=String(input);
    if(url.endsWith('/orders/order-A/settlement'))return response(settlement);
    if(url.endsWith('/orders/order-A/support-cancel')&&(init.method??'GET')==='GET')return response(posted?demoSuccess:demoPreview);
    if(url.endsWith('/orders/order-A/support-cancel')&&init.method==='POST'){posted=true;return response(demoSuccess);}
    throw new Error(`unexpected request ${url}`);
  };
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await render(root,host);await click(button(host,'取消订单'));
  await waitFor(()=>document.body.querySelector('[aria-label="取消订单确认"]'));
  assert.match(document.body.textContent,/模拟退款/);assert.match(document.body.textContent,/不会实际退回款项/);
  await typeReason('客服核实后取消');await click([...document.body.querySelectorAll('button')].find(item=>item.textContent.includes('确认取消并模拟退款')));
  await waitFor(()=>host.textContent.includes('模拟退款已完成'));
  assert.match(host.textContent,/不会实际退回款项/);assert.doesNotMatch(host.textContent,/渠道退款成功|真实到账/);
});

test("未知模拟范围不会被当成客服取消结果", async (t) => {
  let posts=0;
  globalThis.fetch=async(input,init={})=>{
    const url=String(input);
    if(url.endsWith('/orders/order-A/settlement'))return response(settlement);
    if(url.endsWith('/orders/order-A/support-cancel')&&(init.method??'GET')==='GET')return response({...preview,simulationScope:'OTHER'});
    if(init.method==='POST'){posts++;return response(success);}
    throw new Error(`unexpected request ${url}`);
  };
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await render(root,host);await click(button(host,'取消订单'));
  await waitFor(()=>document.body.querySelector('[aria-label="取消订单确认"]'));
  assert.equal(posts,0);assert.doesNotMatch(document.body.textContent,/模拟退款已完成/);
});

test("提交回执的模拟范围格式错误时保留原请求，不显示成功", async (t) => {
  let posts=0;
  globalThis.fetch=async(input,init={})=>{
    const url=String(input);
    if(url.endsWith('/orders/order-A/settlement'))return response(settlement);
    if(url.endsWith('/orders/order-A/support-cancel')&&(init.method??'GET')==='GET')return response({...preview,simulationScope:'ECS_TEST_SIMULATED'});
    if(url.endsWith('/orders/order-A/support-cancel')&&init.method==='POST'){posts++;return response({...success,simulationScope:['ECS_TEST_SIMULATED']});}
    throw new Error(`unexpected request ${url}`);
  };
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await render(root,host);await click(button(host,'取消订单'));await waitFor(()=>document.body.querySelector('[aria-label="取消订单确认"]'));
  await typeReason('客服核实后取消');await click([...document.body.querySelectorAll('button')].find(item=>item.textContent.includes('确认取消并模拟退款')));
  await waitFor(()=>document.body.textContent.includes('取消结果未确认'));
  assert.equal(posts,1);assert.doesNotMatch(host.textContent,/已取消并登记全额退款/);
});

test("提交回执来自另一演示环境时保留原请求", async (t) => {
  const keys=[];
  globalThis.fetch=async(input,init={})=>{
    const url=String(input);
    if(url.endsWith('/orders/order-A/settlement'))return response(settlement);
    if(url.endsWith('/orders/order-A/support-cancel')&&(init.method??'GET')==='GET')return response({...preview,simulationScope:'ECS_TEST_SIMULATED'});
    if(url.endsWith('/orders/order-A/support-cancel')&&init.method==='POST'){keys.push(new Headers(init.headers).get('idempotency-key'));return response({...success,simulationScope:'LOCAL_DEMO_SIMULATED'});}
    throw new Error(`unexpected request ${url}`);
  };
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await render(root,host);await click(button(host,'取消订单'));await waitFor(()=>document.body.querySelector('[aria-label="取消订单确认"]'));
  await typeReason('客服核实后取消');await click([...document.body.querySelectorAll('button')].find(item=>item.textContent.includes('确认取消并模拟退款')));
  await waitFor(()=>document.body.textContent.includes('取消结果未确认'));
  await click([...document.body.querySelectorAll('button')].find(item=>item.textContent.includes('重试同一请求')));
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.doesNotMatch(host.textContent,/已取消并登记全额退款/);
});

test("结算已落账的409显示真实原因并保持弹窗，不出现成功文案", async (t) => {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/orders/order-A/settlement")) return response(settlement);
    if (url.endsWith("/orders/order-A/support-cancel") && (init.method ?? "GET") === "GET") return response(preview);
    if (url.endsWith("/orders/order-A/support-cancel") && init.method === "POST") return response({ error: { code: "CONFLICT" }, reasons: ["SETTLEMENT_ALREADY_POSTED"] }, 409);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(button(host, "取消订单"));
  await waitFor(() => document.body.querySelector('[aria-label="取消订单确认"]'));
  await typeReason("客服核实后取消");
  await click([...document.body.querySelectorAll("button")].find((item) => item.textContent.includes("确认取消并退款")));
  await waitFor(() => document.body.textContent.includes("结算已落账"));
  assert.match(document.body.textContent, /请走财务\/售后退款/);
  assert.doesNotMatch(host.textContent, /已取消并登记全额退款/);
  assert.ok(document.body.querySelector('[aria-label="取消订单确认"]'), "blocked cancellation keeps the dialog open");
});

test("无权限时入口读取返回明确拒绝，不暗示已取消", async (t) => {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/orders/order-A/settlement")) return response(settlement);
    if (url.endsWith("/orders/order-A/support-cancel")) return response({ error: { code: "FORBIDDEN" } }, 403);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(button(host, "取消订单"));
  await waitFor(() => document.body.textContent.includes("没有订单结算写权限"));
  assert.doesNotMatch(host.textContent, /已取消并登记全额退款/);
});

test("没有客服写权限时不渲染取消订单入口", async (t) => {
  globalThis.fetch = async () => response(settlement);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host, { canManualClose: false });
  assert.equal(host.querySelector('[data-support-cancel="true"]'), null);
  assert.equal(button(host, "取消订单"), undefined);
});

test("结果未确认保留同一幂等键，重试不会换键或伪造成功", async (t) => {
  const keys = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/orders/order-A/settlement")) return response(settlement);
    if (url.endsWith("/orders/order-A/support-cancel") && (init.method ?? "GET") === "GET") return response(preview);
    if (url.endsWith("/orders/order-A/support-cancel") && init.method === "POST") {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      return response({ error: { code: "INTERNAL_ERROR" } }, 500);
    }
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(button(host, "取消订单"));
  await waitFor(() => document.body.querySelector('[aria-label="取消订单确认"]'));
  await typeReason("客服核实后取消");
  await click([...document.body.querySelectorAll("button")].find((item) => item.textContent.includes("确认取消并退款")));
  await waitFor(() => document.body.textContent.includes("取消结果未确认"));
  assert.doesNotMatch(host.textContent, /已取消并登记全额退款/);
  const retry = [...document.body.querySelectorAll("button")].find((item) => item.textContent.includes("重试同一请求"));
  assert.ok(retry);
  await click(retry);
  await waitFor(() => keys.length === 2);
  assert.equal(keys[0], keys[1], "an unknown result keeps the original idempotency key");
});

test("固定手续费取消按原键恢复，同时核对手续费、包赔费和入账",async t=>{
 Object.defineProperty(browser.navigator,"locks",{configurable:true,value:{request:async(_name,_options,run)=>run({})}});
 const requests=[];
 const initial={...preview,openingConfirmed:true,poststartEligibility:{allowed:true,reason:null,refundCents:"10000",openingConfirmed:true,fullPayoutSelected:true,fixedFeeRate:"0.105"}};
 const accepted={...initial,orderRevision:"2",orderStatus:"CANCELLED",cancelReason:"SUPPORT_AFTER_START_CANCELLED",
  eligibility:{allowed:false,reason:"ALREADY_CANCELLED",refundCents:"5000",openingConfirmed:true},
  poststartCancellation:{caseId:"sc_1",refundCents:"5000",ownerCents:"2445",ownerGrossCents:"3000",fullPayoutFeeCents:"240",fullPayoutSelected:true,fixedFeeRate:"0.105",platformServiceFeeCents:"315",platformContributionCents:"2555",commissionCents:"0",reason:"双方协商取消"},
  channel:{result:"NOT_SUBMITTED",bankArrival:"UNKNOWN"}};
 globalThis.fetch=async(input,init={})=>{
  if((init.method??"GET")==="GET")return response(initial);
  requests.push({key:new Headers(init.headers).get("idempotency-key"),body:JSON.parse(init.body)});
  return requests.length===1?response({error:{code:"INTERNAL_ERROR"}},500):response(accepted);
 };
 const first=mount();let second;
 t.after(async()=>{if(second)await act(async()=>second.root.unmount());first.host.remove();second?.host.remove();});
 const props={orderId:"order-A",displayNo:"ZZ-TEST-0001",viewerId:"admin-A"};
 await act(async()=>first.root.render(createElement(SupportPoststartCancelCard,props)));
 await waitFor(()=>button(first.host,"取消订单并退款")&&!button(first.host,"取消订单并退款").disabled);
 await click(button(first.host,"取消订单并退款"));
 await waitFor(()=>document.body.querySelector('[aria-label="退还租客金额"]'));
 const input=async(label,value)=>{const node=document.body.querySelector(`[aria-label="${label}"]`);const setter=Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype,"value").set;setter.call(node,value);await act(async()=>node.dispatchEvent(new browser.Event("input",{bubbles:true})));await settle();};
 await input("退还租客金额","50");await input("号主收益金额","30");await input("取消原因","双方协商取消");
 await click(button(document.body,"核对并取消"));
 assert.equal(requests.length,0,"opening confirmation never submits");
 assert.match(document.body.textContent,/包赔费 ¥2\.40/);assert.match(document.body.textContent,/手续费 ¥3\.15/);assert.match(document.body.textContent,/号主入账 ¥24\.45/);
 await click(button(document.body,"确认取消并退款"));
 await waitFor(()=>document.body.textContent.includes("取消结果未确认"));
 assert.equal(requests.length,1);
 await act(async()=>first.root.unmount());
 second=mount();await act(async()=>second.root.render(createElement(SupportPoststartCancelCard,props)));
 await waitFor(()=>button(second.host,"核对原取消请求"));await click(button(second.host,"核对原取消请求"));
 await waitFor(()=>document.body.textContent.includes("上次请求结果未确认"));
 await click(button(document.body,"核对原请求"));await click(button(document.body,"按原请求核对"));
 await waitFor(()=>second.host.textContent.includes("订单已取消"));
 assert.deepEqual(requests[1],requests[0]);
 assert.deepEqual(requests[0].body,{expectedOrderRevision:"1",reason:"双方协商取消",refundCents:"5000",ownerCents:"3000",expectedAdminId:"admin-A",ownerAmountBasis:"GROSS_BEFORE_FEE_V1"});
 assert.equal(browser.localStorage.getItem("zzsh.support.poststart-cancel.admin-A.order-A"),null);
});

test("旧取消请求只有收到原键确定未执行的回执后才允许重新填写",async t=>{
 Object.defineProperty(browser.navigator,"locks",{configurable:true,value:{request:async(_name,_options,run)=>run({})}});
 const key="zzsh.support.poststart-cancel.admin-A.order-A";
 browser.localStorage.setItem(key,JSON.stringify({subject:"admin-A",orderId:"order-A",key:"support_cancel_old",revision:"1",
  paidCents:"10000",refundCents:"5000",ownerCents:"3000",reason:"双方协商取消"}));
 globalThis.fetch=async()=>response({error:{code:"CONFLICT"},reasons:["OWNER_AMOUNT_CONTRACT_REFRESH_REQUIRED"]},409);
 const mounted=mount();t.after(async()=>{await act(async()=>mounted.root.unmount());mounted.host.remove();});
 await act(async()=>mounted.root.render(createElement(SupportPoststartCancelCard,{orderId:"order-A",displayNo:"ZZ-TEST-0001",viewerId:"admin-A"})));
 await waitFor(()=>button(mounted.host,"核对原取消请求"));await click(button(mounted.host,"核对原取消请求"));
 await click(button(document.body,"核对原请求"));await click(button(document.body,"按原请求核对"));
 await waitFor(()=>document.body.textContent.includes("原请求已确认未执行"));
 assert.equal(browser.localStorage.getItem(key),null);
});

test("包赔选择未知时禁止正额号主分配，仍允许全额退款",async t=>{
 Object.defineProperty(browser.navigator,"locks",{configurable:true,value:{request:async(_name,_options,run)=>run({})}});
 const initial={...preview,openingConfirmed:true,poststartEligibility:{allowed:true,reason:null,refundCents:"10000",openingConfirmed:true,fullPayoutSelected:null}};
 globalThis.fetch=async()=>response(initial);
 const mounted=mount();t.after(async()=>{await act(async()=>mounted.root.unmount());mounted.host.remove();});
 await act(async()=>mounted.root.render(createElement(SupportPoststartCancelCard,{orderId:"order-A",displayNo:"ZZ-TEST-0001",viewerId:"admin-A"})));
 await waitFor(()=>button(mounted.host,"取消订单并退款"));await click(button(mounted.host,"取消订单并退款"));
 const input=async(label,value)=>{const node=document.body.querySelector(`[aria-label="${label}"]`);const setter=Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype,"value").set;setter.call(node,value);await act(async()=>node.dispatchEvent(new browser.Event("input",{bubbles:true})));await settle();};
 await input("退还租客金额","99");await input("号主收益金额","1");await input("取消原因","双方协商取消");
 assert.match(document.body.textContent,/包赔选择尚未核实/);assert.equal(button(document.body,"核对并取消").disabled,true);
 await input("退还租客金额","100");await input("号主收益金额","0");
 assert.equal(button(document.body,"核对并取消").disabled,false);
});
