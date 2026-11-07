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
