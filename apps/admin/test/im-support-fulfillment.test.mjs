import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4291/support" });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Element = browser.Element;
globalThis.Node = browser.Node;
globalThis.Event = browser.Event;
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
const heldLocks = new Set();
Object.defineProperty(browser.navigator, "locks", { configurable: true, value: { request: async (name, _options, callback) => {
  if (heldLocks.has(name)) return callback(null);
  heldLocks.add(name); try { return await callback({ name }); } finally { heldLocks.delete(name); }
} } });
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
const { OrderFulfillmentSection, StageCardAttentionNotice, SupportUnpaidCancelCard } = await vite.ssrLoadModule("/src/views/im-support-fulfillment.tsx");
after(async () => { await vite.close(); });
beforeEach(() => { browser.localStorage.clear(); browser.sessionStorage.clear(); heldLocks.clear(); });

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

const frozenInventory = [
  { itemId: "item_haff", quantity: "5000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", name: "哈夫币" },
  { itemId: "item_ammo", quantity: "120", unit: "ROUND", pricingKind: "PER_UNIT", name: "六级弹" },
];

test("待付款客服取消先核付款线索，结果未知时复用原请求", async t => {
  const calls=[]; let posts=0;
  globalThis.fetch=async(input,init={})=>{
    calls.push({url:String(input),method:init.method??"GET",headers:init.headers??{},body:init.body});
    if((init.method??"GET")==="GET") return response({contractVersion:"admin-support-unpaid-cancel.v1",orderId:"order-A",orderRevision:"4",orderStatus:"PENDING_PAYMENT",eligibility:{allowed:true,reason:null}});
    if(++posts===1)return response({contractVersion:"admin-support-unpaid-cancel.v1",orderId:"order-A",outcome:"UNKNOWN",originalKeyRequired:true},202);
    return response({contractVersion:"admin-support-unpaid-cancel.v1",orderId:"order-A",orderRevision:"5",orderStatus:"CANCELLED",cancelReason:"SUPPORT_UNPAID",outcome:"CANCELLED",channelClosed:false});
  };
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await act(async()=>root.render(createElement(SupportUnpaidCancelCard,{orderId:"order-A",displayNo:"TEST-1"})));
  await click(host,"取消待付款订单");
  await waitFor(()=>Boolean(document.body.querySelector('textarea[aria-label="待付款订单取消原因"]:not([disabled])')));
  const input=document.body.querySelector('textarea[aria-label="待付款订单取消原因"]');
  const setter=Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,"value").set;
  await act(async()=>{setter.call(input,"已与租客核实");input.dispatchEvent(new Event("input",{bubbles:true}));});
  await click(host,"确认取消");assert.match(document.body.textContent,/取消结果尚未确认/);
  await click(host,"重试同一请求");assert.match(host.textContent,/订单已取消/);
  const writes=calls.filter(call=>call.method==="POST");assert.equal(writes.length,2);
  assert.equal(writes[0].headers["idempotency-key"],writes[1].headers["idempotency-key"]);
  assert.equal(writes[0].body,writes[1].body);assert.deepEqual(JSON.parse(writes[0].body),{expectedOrderRevision:"4",reason:"已与租客核实"});
});

test("已有付款线索时页面阻止直接取消",async t=>{
  let reviews=0;
  globalThis.fetch=async()=>response({contractVersion:"admin-support-unpaid-cancel.v1",orderId:"order-A",orderRevision:"4",orderStatus:"PENDING_PAYMENT",eligibility:{allowed:false,reason:"PAYMENT_REVIEW_REQUIRED"}});
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await act(async()=>root.render(createElement(SupportUnpaidCancelCard,{orderId:"order-A",displayNo:"TEST-1",onReviewPayment:()=>reviews++})));
  await click(host,"取消待付款订单");await waitFor(()=>document.body.textContent.includes("本单已有付款请求或记录"));
  const confirm=[...document.body.querySelectorAll('button')].find(button=>button.textContent.trim()==="确认取消");assert.ok(confirm?.disabled);
  await click(host,"查看资金与退款");assert.equal(reviews,1);
});
// Real settlement read shape: no frozen inventory (that lives only in the IM slot projection).
const paidNoOpening = { orderId: "order-A", rentalStarted: false, openings: [], settlement: null, ready: false, reasons: ["SETTLEMENT_VERSION_MISSING"] };
const confirmedOpening = { orderId: "order-A", rentalStarted: true, openings: [{ id: "opening_1", versionNo: 1, status: "CONFIRMED", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit, pricingKind: line.pricingKind })) }], settlement: null, ready: false, reasons: ["SETTLEMENT_VERSION_MISSING"] };

function mount() {
  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}
async function render(root, host, props = {}) {
  // 右栏只留任务与入口；用例默认进入专用核对面板再操作数量与版本。
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", frozenInventory, ...props })); });
  await waitFor(() => Boolean(host.querySelector(".im-support-fulfillment")));
  await openPanel(host);
}
function find(host, text) {
  return [...document.body.querySelectorAll("button")].find((button) => button.textContent.includes(text));
}
async function pickOption(doc, trigger, label) {
  await act(async () => trigger.click());
  for (let i = 0; i < 100 && !doc.querySelector('[role="option"]'); i++) await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  const option = [...doc.querySelectorAll('[role="option"]')].find(item => item.textContent.trim() === label);
  assert.ok(option, "missing option " + label);
  await act(async () => option.click());
}
async function click(host, text) {
  const button = find(host, text);
  assert.ok(button, `button available: ${text}`);
  await act(async () => { button.click(); });
  await settle();
  const label = {"提交开租清单":"确认发起开租确认","按原请求重放":"确认重试原请求","确认复核":"确认复核结算方案"}[text];
  if (label) {
    const dialog = document.body.querySelector('[role="alertdialog"]');
    assert.ok(dialog, `${text} requires a confirmation`);
    const confirm = [...dialog.querySelectorAll("button")].find(item => item.textContent.trim() === label);
    assert.ok(confirm && !confirm.disabled, `confirmation available: ${label}`);
    await act(async () => { confirm.click(); });
    await settle();
  }
}
// 数量与版本核对在专用面板里；右栏只留当前任务与入口。
async function openPanel(host) {
  const button = host.querySelector('[data-action="open-fulfillment-panel"]');
  assert.ok(button, "task card offers the check panel entry");
  await act(async () => { button.click(); });
  await waitFor(() => Boolean(document.body.querySelector(".im-order-panel")));
}

test("first opening reads the slot's frozen inventory, not the settlement response", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    if (url.endsWith("/orders/order-A/openings")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);

  const inputs = [...document.body.querySelectorAll(".im-support-fulfillment-lines input")];
  assert.equal(inputs.length, 2, "frozen inventory slot projection seeds the first opening");
  assert.equal(inputs[0].value, "0.005");
  assert.match(document.body.textContent, /哈夫币/);
  await act(async () => { find(host, "提交开租清单").click(); });
  assert.equal(requests.filter(request => request.method === "POST").length, 0, "opening confirmation has not written");
  await click(host, "返回核对");
  assert.equal(requests.filter(request => request.method === "POST").length, 0, "dismissing confirmation does not write");
  assert.equal(inputs[0].value, "0.005", "dismissing confirmation keeps the draft");
  await act(async () => { find(host, "提交开租清单").click(); });
  await click(host, "确认发起开租确认");
  const write = requests.find((request) => request.method === "POST");
  assert.ok(write, "opening write submitted");
  assert.deepEqual(JSON.parse(write.body), { lines: [{ itemId: "item_haff", quantity: "5000" }, { itemId: "item_ammo", quantity: "120" }] });
  assert.ok(String(write.headers["idempotency-key"] ?? "").startsWith("im_ful_record-opening_order-A_"), "stable intent key attached");
  assert.match(document.body.textContent, /期初已提交/);
});

test("Haff amounts display in M and round-trip to exact base units",async t=>{
 const writes=[];globalThis.fetch=async(input,init={})=>{if(init.method==='POST')writes.push(JSON.parse(init.body));return response(paidNoOpening);};
 const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 await render(root,host,{frozenInventory:[{...frozenInventory[0],quantity:'394000001'}]});
 const input=document.body.querySelector('.im-support-fulfillment-lines input');assert.equal(input.value,'394.000001');
 const setter=Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype,'value').set;
 await act(async()=>{setter.call(input,'394.0000001');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await click(host,'提交开租清单');assert.equal(writes.length,0);assert.match(document.body.textContent,/请核对资源数量/);
 await act(async()=>{setter.call(input,'394.000001');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await click(host,'提交开租清单');assert.deepEqual(writes[0].lines,[{itemId:'item_haff',quantity:'394000001'}]);
});

test("without the slot projection the section refuses to fake an opening", async (t) => {
  globalThis.fetch = async () => response(paidNoOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host, { frozenInventory: undefined });
  assert.equal(document.body.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
  assert.match(document.body.textContent, /未取得本单冻结资源清单/);
  assert.equal(find(host, "提交开租清单").disabled, true);
});

test("a stale second page preserves an existing order intent instead of overwriting it", async t => {
  let writes=0;
  globalThis.fetch=async(_input,init={})=>{ if(init.method==="POST")writes++;return response(paidNoOpening); };
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await render(root,host);
  const key="zzsh.im-support.fulfillment.admin-A.order-A", original={subject:"admin-A",intent:{id:"prior-intent",orderId:"order-A",kind:"record-opening"}};
  browser.localStorage.setItem(key,JSON.stringify(original));
  await click(host,"提交开租清单");
  assert.equal(writes,0);assert.deepEqual(JSON.parse(browser.localStorage.getItem(key)),original);
  assert.match(document.body.textContent,/另一页面已有本单操作/);
});

test("a concurrently held order lock refuses another submit", async t => {
  let writes=0;
  globalThis.fetch=async(_input,init={})=>{if(init.method==="POST")writes++;return response(paidNoOpening);};
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await render(root,host);
  heldLocks.add("zzsh:supply-write:zzsh.im-support.fulfillment.admin-A.order-A");
  await click(host,"提交开租清单");assert.equal(writes,0);assert.match(document.body.textContent,/另一页面正在处理本单/);
});

test("staff can confirm a missing opening acknowledgement with a recorded reason", async t => {
  let confirmed=false;const writes=[];
  const opening={id:"opening_1",versionNo:1,status:"DRAFT",lines:frozenInventory.map(line=>({itemId:line.itemId,quantity:line.quantity,unit:line.unit,pricingKind:line.pricingKind})),acks:[]};
  globalThis.fetch=async (input,init={})=>{
    const path=String(input);
    if(init.method==="POST"){writes.push({path,body:JSON.parse(init.body),headers:init.headers});confirmed=true;}
    return response({...paidNoOpening,openings:[{...opening,acks:confirmed?[{party:"RENTER",source:"ON_BEHALF"}]:[]}]});
  };
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await render(root,host,{canManualClose:true});
  await click(host,"协助租客确认");
  assert.match(document.body.textContent,/不会显示为当事人本人确认/);
  const reason=document.body.querySelector('textarea[aria-label="协助确认期初原因"]');assert.ok(reason);
  await act(async()=>{Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,"value").set.call(reason,"已与租客核实");reason.dispatchEvent(new Event("input",{bubbles:true}));});
  await click(host,"核对并继续");assert.equal(writes.length,0);await click(host,"确认协助确认开租");
  assert.equal(writes.length,1);assert.match(writes[0].path,/\/orders\/order-A\/openings\/opening_1\/confirm$/);
  assert.deepEqual(writes[0].body,{party:"RENTER",versionNo:1,reason:"已与租客核实"});assert.ok(writes[0].headers["idempotency-key"]);
  assert.match(document.body.textContent,/客服协助确认/);
});

test("an unknown write keeps the intent; an old identical opening and another version's review never unlock it", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    if (url.endsWith("/orders/order-A/openings")) return response({ error: { code: "INTERNAL_ERROR" } }, 500);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "提交开租清单");
  assert.match(document.body.textContent, /操作结果未确认/);
  const firstKey = requests.find((request) => request.method === "POST").headers["idempotency-key"];
  assert.equal(find(host, "提交开租清单").disabled, true, "primary write stays locked while the result is unknown");

  // A plain GET is observation only: even a historical identical opening must not confirm the request.
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response({ ...confirmedOpening, openings: [{ ...confirmedOpening.openings[0], id: "opening_OLD", status: "DRAFT" }] });
    throw new Error(`unexpected request ${url}`);
  };
  await click(host, "查看当前状态");
  assert.doesNotMatch(document.body.textContent, /已在服务端确认完成/);
  assert.ok(find(host, "按原请求重放"), "identical historical projection does not resolve the unknown intent");

  // Another version's SUPPORT REVIEW is equally not a receipt for this key.
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response({ ...confirmedOpening, settlement: { id: "settle_other", versionNo: 3, early: true, versionHash: "hash_other", decisions: [{ party: "SUPPORT", action: "REVIEW" }] } });
    throw new Error(`unexpected request ${url}`);
  };
  await click(host, "查看当前状态");
  assert.ok(find(host, "按原请求重放"), "another version's review does not resolve the unknown intent");

  await click(host, "按原请求重放");
  const writes = requests.filter((request) => request.method === "POST");
  assert.equal(writes.length, 2);
  assert.equal(writes[1].headers["idempotency-key"], firstKey, "replay reuses the original key");
  assert.deepEqual(JSON.parse(writes[1].body), JSON.parse(writes[0].body), "replay reuses the original body");
});

test("a replay precondition rejection never pretends the original request did not run", async (t) => {
  let posts = 0;
  let replayStatus = 403;
  let replayBody = { error: { code: "FORBIDDEN", message: "Order Team access denied" } };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") {
      posts += 1;
      if (posts === 1) return response({ error: { code: "INTERNAL_ERROR" } }, 500);
      return response(replayBody, replayStatus);
    }
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "提交开租清单");
  assert.match(document.body.textContent, /操作结果未确认/);
  // 403 and a bare 409 CONFLICT come from the replay's own recheck: they say nothing about the original write.
  for (const [status, body] of [[403, { error: { code: "FORBIDDEN" } }], [409, { error: { code: "CONFLICT", message: "ORDER_NOT_SETTLEABLE" } }]]) {
    replayStatus = status; replayBody = body;
    await click(host, "按原请求重放");
    assert.match(document.body.textContent, /不能证明原请求未执行/, `${status} keeps the unknown responsibility`);
    assert.ok(find(host, "按原请求重放"), `${status} does not release the intent`);
  }
  // The recorded receipt for the original key resolves it: a 409 carrying the original business reasons.
  replayStatus = 409;
  replayBody = { error: { code: "CONFLICT", message: "PAYMENT_BASIS_MISSING" }, reasons: ["PAYMENT_BASIS_MISSING"] };
  await click(host, "按原请求重放");
  assert.match(document.body.textContent, /PAYMENT_BASIS_MISSING/);
  assert.equal(find(host, "按原请求重放"), undefined, "the recorded receipt releases the intent");
});

test("a business rejection is shown as blocked, not as success", async (t) => {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    if (url.endsWith("/orders/order-A/openings")) return response({ error: { code: "CONFLICT", message: "ORDER_NOT_PAID" }, reasons: ["ORDER_NOT_PAID"] }, 409);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "提交开租清单");
  assert.match(document.body.textContent, /ORDER_NOT_PAID/);
  assert.doesNotMatch(document.body.textContent, /期初已提交/);
  assert.equal(find(host, "提交开租清单").disabled, false, "a definitive rejection releases the intent");
});

test("an accepted write with a failed readback locks writes until the authoritative state is read", async (t) => {
  const requests = [];
  let settlementReads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) {
      settlementReads += 1;
      if (settlementReads === 1) return response(paidNoOpening);
      if (settlementReads === 2) return response({ error: { code: "INTERNAL_ERROR" } }, 500);
      return response(paidNoOpening);
    }
    if (url.endsWith("/orders/order-A/openings")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "提交开租清单");
  assert.match(document.body.textContent, /期初已提交/);
  assert.match(document.body.textContent, /读取最新状态失败/);
  assert.equal(find(host, "提交开租清单").disabled, true, "no fresh write while readback is pending");
  assert.equal(find(host, "按原请求重放"), undefined, "accepted writes are never replayed");
  assert.equal(requests.filter((request) => request.method === "POST").length, 1, "no second write after an accepted receipt");
  await click(host, "查看当前状态");
  assert.equal(requests.filter((request) => request.method === "POST").length, 1, "observation still never posts");
  assert.equal(find(host, "提交开租清单").disabled, false, "authoritative state observed, work resumes");
});

test("accepted-marker storage failure keeps its warning through failed reads without suggesting refresh", async (t) => {
  const originalSetItem = browser.localStorage.setItem;
  let acceptedStorageAttempts = 0;
  Object.defineProperty(browser.localStorage, "setItem", { configurable: true, value: (key, value) => {
    if (JSON.parse(value).accepted === true) {
      acceptedStorageAttempts += 1;
      throw new Error("accepted marker storage unavailable");
    }
    return originalSetItem(key, value);
  } });
  t.after(() => { Object.defineProperty(browser.localStorage, "setItem", { configurable: true, value: originalSetItem }); });
  let posts = 0;
  let reads = 0;
  let readFailureStatus = 500;
  globalThis.fetch = async (input, init = {}) => {
    if (init.method === "POST") { posts += 1; return response(paidNoOpening); }
    if (String(input).endsWith("/orders/order-A/settlement")) {
      reads += 1;
      return reads === 1 ? response(paidNoOpening) : response({ error: { code: "READBACK_FAILED" } }, readFailureStatus);
    }
    throw new Error(`unexpected request ${input}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await click(host, "提交开租清单");
  assert.equal(acceptedStorageAttempts, 1, "the original intent persisted, only its accepted marker failed");
  const warning = () => {
    assert.match(document.body.textContent, /请勿刷新或离开页面，先查看当前状态或联系维护处理/);
    assert.doesNotMatch(document.body.textContent, /刷新后重试/);
    assert.equal(find(host, "按原请求重放"), undefined, "an accepted request remains GET-only");
    assert.equal(posts, 1);
  };
  warning();
  assert.equal(find(host, "提交开租清单").disabled, true, "the accepted responsibility keeps new writes locked");
  for (const status of [500, 401, 423]) {
    readFailureStatus = status;
    await click(host, "查看当前状态");
    warning();
    if (status !== 500) assert.equal(document.body.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
  }
});

test("an accepted receipt survives unmount and only a GET clears it", async (t) => {
  let posts = 0;
  let reads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") { posts += 1; return response(paidNoOpening); }
    if (url.endsWith("/orders/order-A/settlement")) {
      reads += 1;
      return reads === 2 ? response({ error: { code: "INTERNAL_ERROR" } }, 500) : response(paidNoOpening);
    }
    throw new Error(`unexpected request ${url}`);
  };
  let { host, root } = mount();
  await render(root, host);
  await click(host, "提交开租清单");
  assert.match(document.body.textContent, /期初已提交/);
  assert.match(document.body.textContent, /读取最新状态失败/);
  assert.equal(find(host, "按原请求重放"), undefined);
  await act(async () => root.unmount());
  host.remove();

  // Remount: the accepted fact must not degrade into UNKNOWN/replay.
  ({ host, root } = mount());
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(document.body.textContent, /上次操作已受理/);
  assert.equal(find(host, "按原请求重放"), undefined, "accepted never offers replay after remount");
  assert.equal(find(host, "提交开租清单").disabled, true, "accepted keeps the write lock");
  assert.equal(posts, 1, "remount issues no second POST");
  await click(host, "查看当前状态");
  assert.equal(posts, 1, "observation still never posts");
  assert.equal(find(host, "提交开租清单").disabled, false, "the authoritative GET releases the accepted lock");
});

test("a 401/423 readback hides private projections and keeps the accepted receipt", async (t) => {
  for (const status of [401, 423]) {
    let posts = 0;
    let reads = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (init.method === "POST") { posts += 1; return response(paidNoOpening); }
      if (url.endsWith("/orders/order-A/settlement")) {
        reads += 1;
        return reads === 2 ? response({ error: { code: status === 401 ? "UNAUTHENTICATED" : "SESSION_LOCKED" } }, status) : response(paidNoOpening);
      }
      throw new Error(`unexpected request ${url}`);
    };
    let { host, root } = mount();
    await render(root, host);
    await click(host, "提交开租清单");
    assert.doesNotMatch(document.body.textContent, /哈夫币/, `${status} hides the private projection immediately`);
    assert.equal(document.body.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
    assert.ok(find(host, "查看当前状态"), `${status} keeps the accepted responsibility`);
    assert.equal(find(host, "按原请求重放"), undefined);
    await act(async () => root.unmount());
    host.remove();

    // Another administrator cannot see or consume this subject's accepted receipt.
    ({ host, root } = mount());
    await render(root, host, { viewerId: "admin-B" });
    assert.equal(find(host, "查看当前状态"), undefined, `${status} other subject sees no receipt`);
    assert.equal(find(host, "按原请求重放"), undefined);
    assert.equal(find(host, "提交开租清单").disabled, false, "the other subject starts from their own fresh state");
    assert.equal(posts, 1);
    await act(async () => root.unmount());
    host.remove();

    ({ host, root } = mount());
    await render(root, host);
    assert.equal(find(host, "按原请求重放"), undefined, `${status} remount stays accepted, never UNKNOWN`);
    assert.ok(find(host, "查看当前状态"));
    assert.equal(find(host, "提交开租清单").disabled, true);
    await click(host, "查看当前状态");
    assert.equal(posts, 1, `${status} recovery is GET-only`);
    assert.equal(find(host, "提交开租清单").disabled, false);
    await act(async () => root.unmount());
    host.remove();
  }
});

test("plain and observational reads also hide private projections on 401/423", async (t) => {
  let posts = 0;
  let reads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") { posts += 1; return response({ error: { code: "INTERNAL_ERROR" } }, 500); }
    if (url.endsWith("/orders/order-A/settlement")) {
      reads += 1;
      if (reads === 3) return response({ error: { code: "UNAUTHENTICATED" } }, 401);
      return response(paidNoOpening);
    }
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(document.body.textContent, /哈夫币/, "initial read shows the private projection");
  await click(host, "提交开租清单");
  assert.match(document.body.textContent, /操作结果未确认/);
  await click(host, "查看当前状态");
  assert.match(document.body.textContent, /哈夫币/, "a successful observation may show current facts");
  await click(host, "查看当前状态");
  assert.doesNotMatch(document.body.textContent, /哈夫币/, "an observational 401 hides the private projection");
  assert.ok(find(host, "按原请求重放"), "the unknown responsibility survives the auth failure");
  assert.equal(posts, 1);
});

test("a late settlement read never refills private data across an order switch", async (t) => {
  let resolveA;
  const orderB = { orderId: "order-B", rentalStarted: true, openings: [{ id: "opening_B", versionNo: 1, status: "CONFIRMED", lines: [{ itemId: "item_haff", quantity: "5000", unit: "HAFF_BASE" }] }], settlement: null };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("order-A")) return new Promise((resolve) => { resolveA = resolve; });
    if (url.includes("order-B")) return response(orderB);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "A", viewerId: "admin-A", frozenInventory })); });
  await settle();
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-B", displayNo: "B", viewerId: "admin-A", frozenInventory })); });
  const action = () => document.body.querySelector('[data-action="open-fulfillment-panel"]')?.textContent ?? "";
  await waitFor(() => action().includes("打开核对面板"));
  await act(async () => { document.body.querySelector('[data-action="open-fulfillment-panel"]').click(); });
  await waitFor(() => Boolean(document.body.querySelector(".im-order-panel")));
  const panel = () => document.body.querySelector(".im-order-panel");
  assert.match(panel().textContent, /履约中 · 等待结算/, "order-B's stage is in the check panel");
  await act(async () => { resolveA(response(paidNoOpening)); await settle(); });
  assert.match(panel().textContent, /履约中 · 等待结算/, "the late order-A response cannot replace order-B facts");
  assert.doesNotMatch(panel().textContent, /待发起开租确认/, "a superseded order's stage never refills the current panel");
});

test("editing while the write is in flight cannot lose the original responsibility", async (t) => {
  let finish;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") return new Promise((resolve) => { finish = resolve; });
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  await act(async () => { find(host, "提交开租清单").click(); });
  await act(async () => { find(host, "确认发起开租确认").click(); });
  await settle();
  const input = document.body.querySelector(".im-support-fulfillment-lines input");
  assert.equal(input.disabled, true, "edits are locked while sending");
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    finish(response({ error: { code: "INTERNAL_ERROR" } }, 500));
  });
  await settle();
  assert.match(document.body.textContent, /操作结果未确认/);
  assert.ok(find(host, "按原请求重放"), "late response still leaves the original responsibility");
  assert.equal(find(host, "提交开租清单").disabled, true);
});

test("an unknown intent survives unmount and remounts under the same key", async (t) => {
  const writes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") { writes.push(init.headers["idempotency-key"]); return response({ error: { code: "INTERNAL_ERROR" } }, 500); }
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  let { host, root } = mount();
  await render(root, host);
  await click(host, "提交开租清单");
  await act(async () => root.unmount());
  host.remove();

  ({ host, root } = mount());
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(document.body.textContent, /未确认/);
  assert.equal(find(host, "提交开租清单").disabled, true, "remount cannot start a fresh write");
  await click(host, "按原请求重放");
  assert.equal(writes.length, 2);
  assert.equal(writes[1], writes[0], "remount replay keeps the original idempotency key");
});

test("auth failure keeps the intent for the same subject and is never consumed by another admin", async (t) => {
  const writes = [];
  let mode = "auth";
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") {
      writes.push(init.headers["idempotency-key"]);
      if (mode === "auth") return response({ error: { code: "UNAUTHORIZED" } }, 401);
      return response(paidNoOpening);
    }
    if (url.endsWith("/orders/order-A/settlement")) return response(paidNoOpening);
    throw new Error(`unexpected request ${url}`);
  };
  let { host, root } = mount();
  await render(root, host);
  await click(host, "提交开租清单");
  assert.match(document.body.textContent, /登录状态已变化/);
  assert.doesNotMatch(document.body.textContent, /哈夫币/, "401/423 hides private projections immediately");
  assert.ok(find(host, "按原请求重放"), "401/423 keeps the original responsibility");
  await act(async () => root.unmount());
  host.remove();

  // Another administrator must not see, replay or clear this subject's responsibility.
  ({ host, root } = mount());
  await render(root, host, { viewerId: "admin-B" });
  assert.equal(find(host, "按原请求重放"), undefined, "cross-identity replay is forbidden");
  assert.equal(find(host, "提交开租清单").disabled, false, "the other admin keeps their own fresh write");
  assert.equal(writes.length, 1);
  await act(async () => root.unmount());
  host.remove();

  // The original subject recovers the same intent after re-authentication.
  ({ host, root } = mount());
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.ok(find(host, "按原请求重放"), "same subject recovers the unresolved intent");
  mode = "ok";
  await click(host, "按原请求重放");
  assert.equal(writes.length, 2);
  assert.equal(writes[1], writes[0], "auth recovery replays the original key, never a new one");
});

test("preview shows named server amounts and editing invalidates the accepted hash", async (t) => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response(confirmedOpening);
    if (url.endsWith("/orders/order-A/settlement-preview")) {
      return response({ accepted: false, early: true, amounts: { ownerNet: { currency: "CNY", unit: "yuan", scale: 2, amount: "123.45" }, renterRefund: { currency: "CNY", unit: "yuan", scale: 8, amount: "12.345678" } }, versionHash: "hash_preview", baseVersionId: "settle_base" });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  const trigger = document.body.querySelector('.im-support-fulfillment-controls [aria-label="提前原因"]');
  assert.ok(trigger);
  await pickOption(document, trigger, "租客自愿提前");
  await settle();
  await click(host, "预览结算方案");
  assert.match(document.body.textContent, /号主净额/);
  assert.match(document.body.textContent, /123\.45 元/);
  assert.match(document.body.textContent, /租客应退/);
  assert.match(document.body.textContent, /约\s*12\.35 元/);
  assert.doesNotMatch(document.body.textContent, /12\.345678/);
  const classify = find(host, "生成结算方案");
  assert.ok(classify && !classify.disabled, "classify enabled after a preview");
  const input = document.body.querySelector(".im-support-fulfillment-lines input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
    setter.call(input, "10");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  assert.equal(find(host, "生成结算方案"), undefined, "editing invalidates the preview hash");
});

test("staff preview keeps the customer's actual consumption and includes a zero-opening resource", async (t) => {
  const requests=[];
  const pending={...confirmedOpening,consumptionMode:"ACTUAL",currentRequest:{kind:"INTAKE",id:"intake_1"},
    extraResources:[{itemId:"item_coffee",name:"咖啡豆",unit:"PIECE",pricingKind:"FIXED_UNIT"}],
    intakes:[{status:"OPEN",lines:[{itemId:"item_haff",consumedQuantity:"6000"},{itemId:"item_ammo",consumedQuantity:"180"},{itemId:"item_coffee",consumedQuantity:"2"}]}]};
  globalThis.fetch=async(input,init={})=>{
    const url=String(input);requests.push({url,method:init.method??"GET",body:init.body});
    if(url.endsWith("/orders/order-A/settlement"))return response(pending);
    if(url.endsWith("/orders/order-A/settlement-preview"))return response({accepted:false,early:true,amounts:{},versionHash:"hash_preview"});
    throw new Error(`unexpected request ${url}`);
  };
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await render(root,host);
  const inputs=[...document.body.querySelectorAll(".im-support-fulfillment-lines input")];
  assert.deepEqual(inputs.map(input=>input.value),["0.006","180","2"]);
  assert.match(document.body.textContent,/核对实际消耗/);
  await pickOption(document,document.body.querySelector('.im-support-fulfillment-controls [aria-label="提前原因"]'),"租客自愿提前");
  await click(host,"预览结算方案");
  const request=requests.find(row=>row.method==="POST");assert.ok(request);
  assert.deepEqual(JSON.parse(request.body).lines,[{itemId:"item_haff",consumedQuantity:"6000"},{itemId:"item_ammo",consumedQuantity:"180"},{itemId:"item_coffee",consumedQuantity:"2"}]);
});

test("support finalization records the exact version, reason, and original intent key",async(t)=>{
  const requests=[],hash="a".repeat(64);
  const current={...confirmedOpening,settlement:{id:"settle-current",versionNo:3,kind:"SYSTEM",early:true,versionHash:hash,
    computation:{ok:true,amounts:{ownerNet:{currency:"CNY",unit:"yuan",scale:2,amount:"30.00"},renterRefund:{currency:"CNY",unit:"yuan",scale:2,amount:"5.00"},earlyMakeup:{currency:"CNY",unit:"yuan",scale:2,amount:"2.00"}}},
    decisions:[{party:"RENTER",action:"REJECT",versionHash:hash}]}};
  globalThis.fetch=async(input,init={})=>{const url=String(input);requests.push({url,method:init.method??"GET",headers:init.headers??{},body:init.body});
    if(url.endsWith("/orders/order-A/settlement"))return response(current);
    if(url.endsWith("/orders/order-A/settlements/settle-current/finalize"))return response(current);
    throw new Error(`unexpected request ${url}`);
  };
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});await render(root,host,{canManualClose:true});
  await click(host,"客服确认结算");assert.match(document.body.textContent,/第 3 版金额/);
  assert.match(document.body.textContent,/租客已拒绝 · 号主未确认 · 提前结算/);
  assert.match(document.body.textContent,/提前结束补足2\.00 元/);
  const reason=document.body.querySelector('textarea[placeholder="说明与双方核实的情况"]');assert.ok(reason);
  const setter=Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,"value").set;
  await act(async()=>{setter.call(reason,"双方已沟通确认");reason.dispatchEvent(new Event("input",{bubbles:true}));});
  const button=[...document.body.querySelectorAll("button")].find(item=>item.textContent.trim()==="核对并继续");assert.ok(button&&!button.disabled);
  await act(async()=>button.click());await settle();assert.equal(requests.filter(row=>row.method==="POST").length,0);
  await click(host,"确认按当前方案结算");
  const request=requests.find(row=>row.method==="POST");assert.ok(request);assert.deepEqual(JSON.parse(request.body),{versionHash:hash,reason:"双方已沟通确认"});
  assert.ok(String(request.headers["idempotency-key"]??"").startsWith("im_ful_finalize_order-A_"));
});

test("提前结算缺少费用时客服不能确认",async t=>{
  const current={...confirmedOpening,settlement:{id:"settle-current",versionNo:3,kind:"SYSTEM",early:true,versionHash:"a".repeat(64),
    computation:{ok:true,amounts:{ownerNet:{currency:"CNY",unit:"yuan",scale:2,amount:"30.00"},renterRefund:{currency:"CNY",unit:"yuan",scale:2,amount:"5.00"}}},decisions:[]}};
  globalThis.fetch=async()=>response(current);
  const {host,root}=mount();t.after(async()=>{await act(async()=>root.unmount());host.remove();});await render(root,host,{canManualClose:true});
  assert.match(document.body.textContent,/结算信息尚未完整读取/);
  assert.ok([...document.body.querySelectorAll("button")].find(item=>item.textContent.trim()==="客服确认结算")?.disabled);
});

test("review binds the landed current version id and hash", async (t) => {
  const requests = [];
  const confirmedEarly = { orderId: "order-A", rentalStarted: true, openings: [{ id: "opening_1", versionNo: 1, status: "CONFIRMED", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit })) }], settlement: { id: "settle_current", versionNo: 2, early: true, versionHash: "hash_current", supersededAt: null, decisions: [{ party: "RENTER", action: "CONFIRM" }, { party: "OWNER", action: "CONFIRM" }] }, frozenInventory, posting: null };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.endsWith("/orders/order-A/settlement")) return response(confirmedEarly);
    if (url.endsWith("/orders/order-A/settlements/settle_current/review")) return response(confirmedEarly);
    throw new Error(`unexpected request ${url}`);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(document.body.textContent, /待客服复核/);
  await click(host, "确认复核");
  const write = requests.find((request) => request.method === "POST");
  assert.ok(write.url.endsWith("/settlements/settle_current/review"));
  assert.deepEqual(JSON.parse(write.body), { versionHash: "hash_current" });
});

test("review stage exposes the current version quantities and amounts for cross-checking", async (t) => {
  const confirmedEarly = { orderId: "order-A", rentalStarted: true, openings: [{ id: "opening_1", versionNo: 1, status: "CONFIRMED", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit })) }], settlement: { id: "settle_current", versionNo: 2, early: true, versionHash: "hash_current", supersededAt: null, inputSnapshot: { lines: [{ itemId: "item_ammo", openingQuantity: "120", remainingQuantity: "40" }] }, computation: { ok: true, early: true, amounts: { ownerNet: { currency: "CNY", unit: "yuan", scale: 2, amount: "123.45" }, renterRefund: { currency: "CNY", unit: "yuan", scale: 2, amount: "12.00" } } }, decisions: [{ party: "RENTER", action: "CONFIRM" }, { party: "OWNER", action: "CONFIRM" }] }, posting: null };
  globalThis.fetch = async () => response(confirmedEarly);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(document.body.textContent, /待客服复核/);
  const labels = [...document.body.querySelectorAll('[aria-label="当前版本数量"] label span')].map((node) => node.textContent);
  assert.deepEqual(labels, ["六级弹 · 发 · 期末剩余"], "current version lines show their quantity meaning");
  assert.match(document.body.textContent, /123\.45 元/);
  assert.match(document.body.textContent, /12\.00 元/);
  assert.doesNotMatch(document.body.textContent, /物资 · 件/);
});

test("confirmed opening lines borrow names from the frozen projection instead of a placeholder", async (t) => {
  globalThis.fetch = async () => response(confirmedOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  const labels = [...document.body.querySelectorAll(".im-support-fulfillment-lines tbody tr td:first-child")].map((node) => node.textContent);
  assert.deepEqual(labels, ["哈夫币", "六级弹"]);
  assert.doesNotMatch(document.body.textContent, /物资 · 件/);
});

test("a 404 settlement read is a neutral unavailable state, not a permission claim", async (t) => {
  globalThis.fetch = async () => response({ error: { code: "NOT_FOUND" } }, 404);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", frozenInventory })); });
  await waitFor(() => host.querySelector('[data-read-state="unavailable"]'));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /本单结算记录不可用/);
  assert.match(card.textContent, /本环境未启用结算记录/);
  assert.match(card.textContent, /不影响本单沟通/);
  assert.doesNotMatch(card.textContent, /未找到此内容|无权/, "404 must not be dressed up as a permission problem");
  assert.equal(card.querySelector('[role="alert"]'), null, "an unavailable surface is neutral, not a red error");
  assert.ok(host.querySelector('[data-action="fulfillment-reload"]'), "a read-only retry stays available");
  assert.equal(host.querySelector('[data-action="open-fulfillment-panel"]'), null, "an unreadable settlement never opens a write panel");
});

test("a 403 settlement read still names the missing permission", async (t) => {
  globalThis.fetch = async () => response({ error: { code: "FORBIDDEN" } }, 403);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", frozenInventory })); });
  await waitFor(() => host.querySelector('[data-read-state="forbidden"]'));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /当前账号无权查看本单结算记录/);
  assert.doesNotMatch(card.textContent, /本环境未启用结算记录/, "403 keeps its own permission meaning");
  assert.ok(card.querySelector('[role="alert"]'), "a permission failure remains an alert");
  assert.ok(host.querySelector('[data-action="fulfillment-reload"]'));
  assert.equal(host.querySelector('[data-action="open-fulfillment-panel"]'), null);
});

test("a completed order shows read-only ended facts and no write commands", async (t) => {
  const posted = {
    orderId: "order-A", rentalStarted: true,
    openings: [{ id: "opening_1", versionNo: 1, status: "CONFIRMED", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit })) }],
    settlement: { id: "settle_v3", versionNo: 3, early: true, versionHash: "hash_v3", decisions: [{ party: "RENTER", action: "CONFIRM" }, { party: "OWNER", action: "CONFIRM" }, { party: "SUPPORT", action: "REVIEW" }] },
    posting: { id: "posting_1", versionHash: "hash_v3", early: true, postedAt: "2026-10-11T08:00:00.000Z", refundDueAt: "2026-10-14T08:00:00.000Z", amounts: { renterRefund: { amount: "320.00", unit: "yuan" } } },
  };
  globalThis.fetch = async () => response(posted);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", orderStatus: "COMPLETED", frozenInventory })); });
  await waitFor(() => host.querySelector('.im-support-fulfillment[data-ended="true"]'));
  await waitFor(() => host.querySelector(".im-support-fulfillment").textContent.includes("已结算"));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /本单已结束/);
  assert.match(card.textContent, /已完成/);
  assert.match(card.textContent, /已结算/);
  assert.match(card.textContent, /退款应付时间：10\/14 16:00/);
  assert.equal(host.querySelector('[data-action="open-fulfillment-panel"]'), null, "ended orders offer no write entry");
  assert.equal(document.body.querySelector(".im-order-panel"), null, "no check panel is mounted");
  assert.equal(host.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
  assert.doesNotMatch(card.textContent, /提交开租清单|预览结算方案|确认复核|人工调整/);
});

test("a cancelled order stays neutral even when settlement recording is unavailable", async (t) => {
  globalThis.fetch = async () => response({ error: { code: "NOT_FOUND" } }, 404);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", orderStatus: "CANCELLED", frozenInventory })); });
  await waitFor(() => host.querySelector('.im-support-fulfillment[data-ended="true"]'));
  await waitFor(() => host.querySelector(".im-support-fulfillment").textContent.includes("本环境未启用结算记录"));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /已结束/);
  assert.match(card.textContent, /已取消/);
  assert.doesNotMatch(card.textContent, /无权|未找到此内容/, "a 404 on an ended order is not a permission verdict");
  assert.equal(card.querySelector('[role="alert"]'), null, "ended reads stay neutral, never red");
  assert.ok(host.querySelector('[data-action="fulfillment-reload"]'), "only another read is offered");
  assert.equal(host.querySelector('[data-action="open-fulfillment-panel"]'), null);
});

test("an active order keeps its existing fulfillment entry", async (t) => {
  globalThis.fetch = async () => response(paidNoOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.ok(host.querySelector('[data-action="open-fulfillment-panel"]'), "the active order keeps its write entry");
  assert.equal(host.querySelector('[data-ended="true"]'), null, "an active order is never labelled ended");
  assert.equal(host.querySelector('[data-read-state]'), null, "the loaded active card has no read-failure state");
});

test("the rail card keeps the action and leaves stage and status facts to the header and check panel", async (t) => {
  globalThis.fetch = async () => response(paidNoOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(createElement(OrderFulfillmentSection, { orderId: "order-A", displayNo: "ZZ-TEST-0001", viewerId: "admin-A", frozenInventory })); });
  await waitFor(() => Boolean(host.querySelector('[data-action="open-fulfillment-panel"]')));
  const card = host.querySelector(".im-support-fulfillment");
  assert.match(card.textContent, /履约核对/, "the rail card speaks about the action, not the stage");
  assert.doesNotMatch(card.textContent, /待核对期初|未开租|已开租|有结算申请待处理|已过账/, "the rail card does not repeat stage or status facts");
  assert.match(card.querySelector('[data-action="open-fulfillment-panel"]').textContent, /发起开租确认/, "the stage-specific action stays available");
  await act(async () => { card.querySelector('[data-action="open-fulfillment-panel"]').click(); });
  await waitFor(() => Boolean(document.body.querySelector(".im-order-panel")));
  assert.match(document.body.querySelector(".im-order-panel").textContent, /待发起开租确认/, "the check panel owns the stage facts");
});

test("the support workbench no longer offers the routine manual-close entry but keeps the unopened cancel", async (t) => {
  globalThis.fetch = async () => response(paidNoOpening);
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host, { orderStatus: "PAID", canManualClose: true });
  assert.equal(host.querySelector('[data-action="manual-close-open"]'), null, "anomaly handling is not a routine support entry");
  assert.equal(host.querySelector('[data-manual-close="true"]'), null);
  assert.ok(host.querySelector('[data-support-cancel="true"]'), "the legitimate unopened cancellation remains available");
  assert.doesNotMatch(host.textContent, /核对结束方式|异常处理/);
});

test("a progress reminder is stage-derived, sends one idempotent request, and never writes an opening", async (t) => {
  const writes = [];
  const openingPending = {
    ...paidNoOpening,
    openingGeneration: { state: "CREATED", reason: null },
    openings: [{ id: "opening_1", versionNo: 1, status: "DRAFT", autoConfirmDueAt: "2026-11-09T08:40:00.000Z", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit, pricingKind: line.pricingKind })), acks: [] }],
  };
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      writes.push({ url: String(url), key: new Headers(init.headers).get("idempotency-key"), body: JSON.parse(String(init.body)) });
      return response({ reminderId: "reminder_1", orderId: "order-A", stage: "OPENING_PENDING", targets: ["RENTER", "OWNER"], state: "SENT", messageClientId: "reminder_1" });
    }
    return response(openingPending);
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host);
  assert.match(document.body.textContent, /等待双方确认开租/);
  await click(host, "发送进度提醒");
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /\/orders\/order-A\/progress-reminders$/);
  assert.ok(writes[0].key, "the request keeps its own idempotency key");
  assert.deepEqual(writes[0].body, {});
  assert.match(document.body.textContent, /已发送进度提醒（OPENING_PENDING）/);
  assert.equal(writes.some(write => /openings$/.test(write.url)), false, "a reminder never creates an opening");
});

test("an unknown reminder keeps its request key across remount", async (t) => {
  const openingPending = {
    ...paidNoOpening,
    openingGeneration: { state: "CREATED", reason: null },
    openings: [{ id: "opening_1", versionNo: 1, status: "DRAFT", autoConfirmDueAt: "2026-11-09T08:40:00.000Z", lines: frozenInventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit, pricingKind: line.pricingKind })), acks: [] }],
  };
  const keys = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      return response({ error: { code: "IM_UNAVAILABLE", message: "unknown" }, state: "UNKNOWN" }, 502);
    }
    return response(openingPending);
  };
  const first = mount();
  await render(first.root, first.host);
  await click(first.host, "发送进度提醒");
  await waitFor(() => Boolean(browser.sessionStorage.getItem(`zzsh.im-support.reminder.admin-A.order-A`)));
  const saved = browser.sessionStorage.getItem(`zzsh.im-support.reminder.admin-A.order-A`);
  assert.ok(saved && /^support_reminder_/.test(saved));
  await act(async () => first.root.unmount());
  first.host.remove();

  const second = mount();
  t.after(async () => { await act(async () => second.root.unmount()); second.host.remove(); });
  await render(second.root, second.host);
  assert.equal(find(second.host, "核对原提醒")?.textContent, "核对原提醒", "the remount reuses the pending request");
  await click(second.host, "核对原提醒");
  assert.deepEqual(keys, [saved, saved], "the same original key is retried");
});

test("a missing generation record with the recovery marker still exposes the retry path", async (t) => {
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      writes.push(String(url));
      return response({ orderId: "order-A", state: "REVIEW_REQUIRED", reason: "42P01" });
    }
    return response({ ...paidNoOpening, openingGeneration: null, openingGenerationRecoveryRequired: true });
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host, { orderStatus: "PAID", canManualClose: true });
  assert.equal(find(host, "提交开租清单"), undefined, "a marked new order cannot fall back to legacy manual creation without the marker");
  assert.match(document.body.textContent, /自动开租记录写入失败/);
  await click(host, "重新核对开租依据");
  await click(host, "确认重新核对");
  assert.deepEqual(writes, ["/api/bff/admin/orders/order-A/opening-generation/retry"]);
});

test("a new-order review state explains the missing opening and never offers a fake manual list", async (t) => {
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      writes.push(String(url));
      return response({ orderId: "order-A", state: "REVIEW_REQUIRED", reason: "FULL_PAYOUT_UNKNOWN" });
    }
    return response({
      ...paidNoOpening,
      openingGeneration: { state: "REVIEW_REQUIRED", reason: "QUOTE_BASIS_INVALID" },
    });
  };
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(root, host, { orderStatus: "PAID", canManualClose: true });
  assert.match(document.body.textContent, /开租资料待客服核对/);
  assert.match(document.body.textContent, /冻结报价或资源清单不完整/);
  assert.equal(find(host, "提交开租清单"), undefined, "a reviewed order cannot fabricate a list");
  await click(host, "重新核对开租依据");
  assert.equal(writes.length, 0, "active retry requires explicit confirmation");
  await click(host, "确认重新核对");
  assert.deepEqual(writes, ["/api/bff/admin/orders/order-A/opening-generation/retry"]);
  assert.match(document.body.textContent, /仍不能生成开租清单/);
});

test("an UNKNOWN automatic stage card notice is independent of settlement and terminal actions", async (t) => {
  const { host, root } = mount();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const stageCards = [{ kind: "ORDER_OPENING", kindLabel: "开租确认", state: "UNKNOWN" }];
  await act(async () => { root.render(createElement(StageCardAttentionNotice, { stageCards })); });
  assert.match(host.textContent, /自动卡发送结果待核对/);
  assert.match(host.textContent, /开租确认可能已发出/);
  assert.match(host.textContent, /先在订单群核对/);
  assert.match(host.textContent, /再按当前阶段使用“发送进度提醒”/);
  assert.equal(find(host, "查询云信"), undefined, "no channel query contract is implied");
  await act(async () => { root.render(createElement(StageCardAttentionNotice, { stageCards, terminal: true })); });
  assert.match(host.textContent, /订单已结束/);
  assert.match(host.textContent, /本页不开放补发或写操作/);
  assert.equal(find(host, "发送进度提醒"), undefined, "a terminal order never reopens a write entry");
});
