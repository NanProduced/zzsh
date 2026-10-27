import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

const snapshot = {
  authenticated: true,
  adminUserId: "admin-order-read",
  user: { name: "订单客服", username: "ZZ-ORDER", twoFactorEnabled: true },
  security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
  session: { id: "session-order-read", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
  permissions: ["order.read"],
};

const order = {
  id: "order_1",
  displayNo: "ZZ20260930-000001",
  status: "PAID",
  accountId: "account_1",
  versionId: "version_1",
  title: "长标题账号用于检验窄屏换行",
  termOptionCode: "daily-1",
  termSeconds: "86400",
  amounts: {
    rental: { currency: "CNY", unit: "yuan", amount: "10.00", scale: 2 },
    deposit: { currency: "CNY", unit: "yuan", amount: "0.00", scale: 2 },
    totalDue: { currency: "CNY", unit: "yuan", amount: "10.00", scale: 2 },
    currency: "CNY",
  },
  createdAt: "2026-09-30T00:00:00.000000Z",
  holdUntil: "2026-10-01T00:00:00.000000Z",
  expiredAwaitingCancel: false,
  paymentOpen: false,
  cancelOpen: false,
  paidAt: null,
  ownerUserId: "user-owner-1",
  renterUserId: "user-renter-1",
  ownerName: "号主",
  renterName: "租客",
  gameId: "game_delta",
  releaseId: "release_1",
  contentHash: "a".repeat(64),
  revision: "1",
  quote: null,
  fulfillmentAssignment: { state: "ASSIGNED", waitingReason: null, assignedAt: null, teamReady: false, teamState: "PENDING" },
};

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
}

async function setup(t) {
  const browser = new Window({ url: "http://127.0.0.1:4311/orders" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    SVGElement: browser.SVGElement,
    Node: browser.Node,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent,
    PointerEvent: browser.PointerEvent,
    FocusEvent: browser.FocusEvent,
    CSS: browser.CSS,
    FormData: browser.FormData,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const vite = await createOfflineAdminSource({ root: rootPath });
  const { AdminOrdersView } = await vite.ssrLoadModule("/apps/admin/src/views/admin-orders-view.tsx");
  const { AdminOrderChainView, AdminResourceReadView } = await vite.ssrLoadModule("/apps/admin/src/views/admin-order-chain-view.tsx");
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); await vite.close(); browser.happyDOM.abort(); });
  return { browser, root, node, AdminOrdersView, AdminOrderChainView, AdminResourceReadView };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
const until = async (predicate) => { for (let i = 0; i < 120; i += 1) { if (predicate()) return; await settle(); } throw new Error("admin orders component condition timed out"); };
const snapshotFor = (id) => ({ ...snapshot, adminUserId: id, user: { ...snapshot.user, username: `ZZ-${id}` }, session: { ...snapshot.session, id: `session-${id}` } });

test("order read list sends exact filters without persisting sensitive inputs and opens an object tab", async (t) => {
  const { browser, root, node, AdminOrdersView } = await setup(t);
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return response({ items: [order], nextCursor: null, limit: 20 });
  };
  const opened = [];
  await act(async () => root.render(createElement(AdminOrdersView, { snapshot, onOpenPath: (path, title) => opened.push({ path, title }), onQueryChange: () => {}, refreshNonce: 0 })));
  await until(() => node.textContent.includes(order.displayNo));
  assert.equal(new URL(browser.location.href).search, "");

  const inputs = [...node.querySelectorAll("input")];
  const setInput = async (input, value) => act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await setInput(inputs[0], order.displayNo);
  await setInput(inputs[1], order.renterUserId);
  await setInput(inputs[2], order.ownerUserId);
  await setInput(inputs[3], "2026-09-29T00:00");
  await setInput(inputs[4], "2026-10-01T00:00");
  await act(async () => node.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await until(() => calls.some((url) => url.includes("displayNo=")));
  const query = new URL(calls.at(-1), "http://127.0.0.1").searchParams;
  assert.equal(query.get("displayNo"), order.displayNo);
  assert.equal(query.get("renterUserId"), order.renterUserId);
  assert.equal(query.get("ownerUserId"), order.ownerUserId);
  assert.equal(query.get("createdFrom"), "2026-09-29T00:00:00+08:00");
  assert.equal(query.get("createdTo"), "2026-10-01T00:00:00+08:00");
  assert.equal(new URL(browser.location.href).search, "", "sensitive order filters stay out of the URL");

  await act(async () => node.querySelector(`[data-order-id="${order.id}"]`).dispatchEvent(new Event("click", { bubbles: true })));
  assert.deepEqual(opened.at(-1), { path: `/orders/${order.id}`, title: order.displayNo });
});

test("late order detail response cannot overwrite the selected object", async (t) => {
  const { root, node, AdminOrdersView } = await setup(t);
  let resolveA;
  const orderA = { ...order, id: "order_a", displayNo: "ZZ-A" };
  const orderB = { ...order, id: "order_b", displayNo: "ZZ-B" };
  globalThis.fetch = async (url) => {
    if (String(url).includes("/settlement")) return response({}, 404);
    if (String(url).includes("order_a")) return new Promise((resolve) => { resolveA = () => resolve(response({ order: orderA })); });
    return response({ order: orderB });
  };
  const props = { snapshot, objectOnly: true, initialOrderId: "order_a", onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 };
  await act(async () => root.render(createElement(AdminOrdersView, props)));
  await act(async () => root.render(createElement(AdminOrdersView, { ...props, initialOrderId: "order_b" })));
  await until(() => node.textContent.includes("ZZ-B"));
  resolveA();
  await settle();
  assert.equal(node.textContent.includes("ZZ-A"), false);
  assert.equal(node.textContent.includes("ZZ-B"), true);
});

test("StrictMode retries a cancelled first list request and shows the successful result", async (t) => {
  const { root, node, AdminOrdersView } = await setup(t);
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return response({ items: [order], nextCursor: null, limit: 20 });
  };
  await act(async () => root.render(createElement(StrictMode, null, createElement(AdminOrdersView, { snapshot: snapshotFor("strict"), onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 }))));
  await until(() => node.textContent.includes(order.displayNo));
  assert.ok(calls >= 2);
});

test("administrator changes discard the old list projection and failed reads retry on re-entry", async (t) => {
  const { root, node, AdminOrdersView } = await setup(t);
  const orderA = { ...order, id: "order_a", displayNo: "ORDER-A" };
  const orderB = { ...order, id: "order_b", displayNo: "ORDER-B" };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response({ items: [calls === 1 ? orderA : orderB], nextCursor: null, limit: 20 });
  };
  await act(async () => root.render(createElement(AdminOrdersView, { snapshot: snapshotFor("operator-a"), onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 })));
  await until(() => node.textContent.includes("ORDER-A"));
  await act(async () => root.render(createElement(AdminOrdersView, { snapshot: snapshotFor("operator-b"), onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 })));
  await until(() => node.textContent.includes("ORDER-B"));
  assert.equal(node.textContent.includes("ORDER-A"), false);
  assert.equal(calls, 2);

  const failedSnapshot = snapshotFor("operator-failure");
  calls = 0;
  globalThis.fetch = async () => { calls += 1; return response({ error: { code: "INTERNAL_ERROR" } }, 500); };
  await act(async () => root.render(createElement(AdminOrdersView, { snapshot: failedSnapshot, onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 })));
  await until(() => node.textContent.includes("订单列表加载失败"));
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls += 1; return response({ items: [orderB], nextCursor: null, limit: 20 }); };
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(AdminOrdersView, { snapshot: failedSnapshot, onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 })));
  await until(() => node.textContent.includes("ORDER-B"));
  assert.equal(calls, 2);
  assert.equal(node.textContent.includes("当前筛选与您的游戏范围内暂无订单"), false);
});

test("order details render before a pending settlement read and keep paid-without-time semantics", async (t) => {
  const { root, node, AdminOrdersView } = await setup(t);
  let releaseSettlement;
  const paidUnknown = { ...order, id: "order_paid_unknown", displayNo: "PAID-UNKNOWN", paidAt: null };
  globalThis.fetch = async (url) => {
    if (String(url).includes("/settlement")) return new Promise((resolve) => { releaseSettlement = () => resolve(response({}, 403)); });
    return response({ order: paidUnknown });
  };
  await act(async () => root.render(createElement(AdminOrdersView, { snapshot: snapshotFor("detail-pending"), objectOnly: true, initialOrderId: paidUnknown.id, onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 })));
  await until(() => node.textContent.includes("PAID-UNKNOWN"));
  assert.equal(node.textContent.includes("支付时间待确认"), true);
  assert.equal(node.textContent.includes("未形成支付事实"), false);
  releaseSettlement();
  await settle();
  assert.equal(node.textContent.includes("PAID-UNKNOWN"), true);
});

test("settlement 404 leaves the order body visible", async (t) => {
  const { root, node, AdminOrdersView } = await setup(t);
  let releaseSettlement;
  const completedUnknown = { ...order, id: "order_completed_unknown", displayNo: "COMPLETED-UNKNOWN", status: "COMPLETED", paidAt: null };
  globalThis.fetch = async (url) => {
    if (String(url).includes("/settlement")) return new Promise((resolve) => { releaseSettlement = () => resolve(response({}, 404)); });
    return response({ order: completedUnknown });
  };
  await act(async () => root.render(createElement(AdminOrdersView, { snapshot: snapshotFor("detail-404"), objectOnly: true, initialOrderId: completedUnknown.id, onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 })));
  await until(() => node.textContent.includes("COMPLETED-UNKNOWN"));
  assert.equal(node.textContent.includes("支付时间待确认"), true);
  assert.equal(node.textContent.includes("未形成支付事实"), false);
  releaseSettlement();
  await settle();
  assert.equal(node.textContent.includes("COMPLETED-UNKNOWN"), true);
});

test("lifecycle payment copy follows status and paidAt facts", async (t) => {
  const { root, node, AdminOrdersView } = await setup(t);
  const cases = [
    { status: "PAID", paidAt: null, displayNo: "LIFE-PAID", expect: "支付时间待确认", forbid: "未形成支付事实" },
    { status: "COMPLETED", paidAt: null, displayNo: "LIFE-COMPLETED", expect: "支付时间待确认", forbid: "未形成支付事实" },
    { status: "PENDING_PAYMENT", paidAt: null, displayNo: "LIFE-PENDING", expect: "等待支付", forbid: "支付时间待确认" },
    { status: "CANCELLED", paidAt: null, displayNo: "LIFE-CANCELLED", expect: "未形成支付事实", forbid: "支付时间待确认" },
  ];
  for (const item of cases) {
    const current = { ...order, id: `order_${item.displayNo}`, displayNo: item.displayNo, status: item.status, paidAt: item.paidAt };
    globalThis.fetch = async (url) => {
      if (String(url).includes("/settlement")) return response({}, 404);
      return response({ order: current });
    };
    await act(async () => root.render(createElement(AdminOrdersView, { snapshot: snapshotFor(`life-${item.status}`), objectOnly: true, initialOrderId: current.id, onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 })));
    await until(() => node.textContent.includes(item.displayNo));
    assert.equal(node.textContent.includes(item.expect), true, `${item.status} should show ${item.expect}`);
    assert.equal(node.textContent.includes(item.forbid), false, `${item.status} should not show ${item.forbid}`);
  }
});

// Numbered-page chain: these assertions exercise the new product view, not the frozen cursor view.
const chainOrder = { ...order, accountDisplayNo: 'A-001', ownerBusinessNo: 'U-OWNER', renterBusinessNo: 'U-RENTER',
  source: { origin: 'LEGACY', statusLabel: '已取消' }, status: 'CANCELLED',
  payment: { state: 'RECORDED_PAID', recordedAt: null, recordedAmount: order.amounts.totalDue },
  legacyAmounts: { refund: null, refundChannelState: 'UNKNOWN' } };
const chainPage = (items = [chainOrder], overrides = {}) => ({ items, page: 1, pageSize: 20, total: 1, contextKey: 'a'.repeat(64), ...overrides });
const chainProps = id => ({ snapshot: snapshotFor(id), onOpenPath: () => {}, onQueryChange: () => {}, refreshNonce: 0 });
async function changeField(browser, node, label, value) {
  const field = node.querySelector(`[aria-label="${label}"]`);
  if (field.tagName === 'BUTTON' || field.getAttribute('role') === 'combobox') {
    await act(async () => field.click());
    await until(() => browser.document.querySelector('[role="option"]'));
    const option = [...browser.document.querySelectorAll('[role="option"]')].find(item => item.textContent.trim() === value);
    assert(option, `missing option ${value} for ${label}`);
    await act(async () => option.click());
    return;
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const buttonNamed = (node, name) => [...node.querySelectorAll('button')].find(b => b.textContent === name);

test('numbered chain survives StrictMode cancellation and separates paid cancellation, zero and unknown facts', async t => {
  const {root,node,AdminOrderChainView} = await setup(t); const signals = [];
  globalThis.fetch = async (_url, options) => { signals.push(options.signal); return response(chainPage()); };
  await act(async () => root.render(createElement(StrictMode, null, createElement(AdminOrderChainView, chainProps('chain-strict')))));
  await until(() => node.textContent.includes(chainOrder.displayNo));
  assert(signals.length >= 2); assert.equal(signals[0].aborted, true);
  assert(node.textContent.includes('已取消')); assert(node.textContent.includes('支付已记录')); assert(node.textContent.includes('退款待核'));
  assert(node.textContent.includes('押金 ¥0.00')); assert(!node.textContent.includes('加载更多'));
  assert(node.textContent.includes('当前进度') && node.textContent.includes('费用'));
  assert(!node.textContent.includes('需付金额') && !node.textContent.includes('订单状态 / 已知事实'), 'cancelled rows no longer look like a payment request');
  globalThis.fetch = async () => response({ order:chainOrder });
  await act(async () => root.render(createElement(AdminOrderChainView, {...chainProps('chain-detail'), objectOnly:true, initialOrderId:chainOrder.id})));
  await until(() => node.textContent.includes('关键费用'));
  assert(node.textContent.includes('支付时间待确认')); assert(node.textContent.includes('未知')); assert(node.textContent.includes('¥0.00'));
});


test('U1 order filters use shared controls, send exact server predicates and reset without native fields', async t => {
  const {browser,root,node,AdminOrderChainView}=await setup(t); const calls=[];
  globalThis.fetch=async url=>{calls.push(new URL(String(url),'http://localhost'));return response(chainPage([chainOrder],{total:45}));};
  await act(async()=>root.render(createElement(AdminOrderChainView,chainProps('order-filters'))));
  await until(()=>node.textContent.includes(chainOrder.displayNo));
  assert.equal(node.querySelectorAll('.oc-search select').length,0,'filters use the project Select, not native selects');
  assert.equal(node.querySelectorAll('.oc-search input[type="datetime-local"]').length,0,'dates use the shared DateSelector');
  assert.equal(node.textContent.includes('共 45 条'),true,'count and page share the server result');

  // CLARITY-02：状态/来源选择即生效，无需点击“查询”；关键字草稿不随之提交
  await act(async()=>{const input=node.querySelector('[aria-label="查找线索"]');const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value').set;setter.call(input,'草稿线索');input.dispatchEvent(new browser.Event('input',{bubbles:true}));});
  await changeField(browser,node,'主状态','已取消');
  await until(()=>calls.at(-1).searchParams.get('status')==='CANCELLED');
  await changeField(browser,node,'来源','旧平台订单');
  await until(()=>calls.at(-1).searchParams.get('origin')==='LEGACY');
  assert.equal(calls.at(-1).searchParams.get('qValue'),null,'未提交的关键字不随筛选生效');
  assert(node.querySelector('.oc-search-group [aria-label="查找方式"]')&&node.querySelector('.oc-search-group [aria-label="查找线索"]'),'字段选择与输入框为一个输入组');
  assert.equal(calls.at(-1).searchParams.get('status'),'CANCELLED');
  assert.equal(calls.at(-1).searchParams.get('page'),'1');

  const dateTrigger=node.querySelector('[aria-label="下单日期"]');
  await act(async()=>dateTrigger.click());
  await until(()=>browser.document.querySelector('[aria-label="快捷日期范围"]'));
  const preset=[...browser.document.querySelectorAll('button')].find(button=>button.textContent.includes('近 7 天'));
  await act(async()=>preset.click());
  await act(async()=>buttonNamed(node,'查询').click());
  await until(()=>calls.at(-1).searchParams.has('createdFrom'));
  assert.match(calls.at(-1).searchParams.get('createdFrom'),/T00:00:00\+08:00$/);
  assert.match(calls.at(-1).searchParams.get('createdTo'),/T00:00:00\+08:00$/);
  assert.equal(calls.at(-1).searchParams.get('status'),'CANCELLED');
  assert.equal(calls.at(-1).searchParams.get('origin'),'LEGACY');

  await changeField(browser,node,'查找方式','交易双方');
  await changeField(browser,node,'查找线索','20260913125844629986');
  await act(async()=>buttonNamed(node,'查询').click());
  await until(()=>calls.at(-1).searchParams.get('qValue')==='20260913125844629986');
  assert.equal(calls.at(-1).searchParams.get('qKind'),'party','a 20-digit order number is allowed as a party clue');

  await act(async()=>buttonNamed(node,'重置').click());
  await until(()=>!calls.at(-1).searchParams.has('status')&&!calls.at(-1).searchParams.has('origin')&&!calls.at(-1).searchParams.has('createdFrom'));
  assert.equal(calls.at(-1).searchParams.has('qValue'),false);
  assert.equal(node.textContent.includes('共 45 条'),true);
});
test('numbered lookup, later pages and invalid dates retain the executed query and expose a correct current page', async t => {
  const {browser,root,node,AdminOrderChainView} = await setup(t); const calls=[],changed=[];
  globalThis.fetch = async url => { calls.push(new URL(String(url),browser.location.href)); return response(chainPage([chainOrder],{total:200})); };
  await act(async () => root.render(createElement(AdminOrderChainView,{...chainProps('chain-pages'),onQueryChange:q=>changed.push(q)})));
  await until(() => node.textContent.includes(chainOrder.displayNo));
  await changeField(browser,node,'查找方式','交易双方'); await changeField(browser,node,'查找线索','测试用户线索');
  await act(async () => node.querySelector('.oc-search').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await until(() => calls.at(-1).searchParams.get('qValue')==='测试用户线索' && node.textContent.includes(chainOrder.displayNo));
  assert.equal(calls.at(-1).searchParams.get('qKind'),'party'); assert.deepEqual(changed,[]); assert.equal(browser.location.search,'');
  await changeField(browser,node,'跳转页码','9');
  await act(async () => node.querySelector('.admin-list-pagination-jump-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await until(() => calls.at(-1).searchParams.get('page')==='9');
  const count=calls.length;
  const dateTrigger = node.querySelector('[aria-label="下单日期"]');
  await act(async () => dateTrigger.click());
  await until(() => browser.document.querySelector('[aria-label="快捷日期范围"]'));
  const preset = [...browser.document.querySelectorAll('button')].find(button => button.textContent.includes('近 7 天'));
  await act(async () => preset.click());
  await act(async () => node.querySelector('.oc-search').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await until(() => calls.length>count&&node.textContent.includes(chainOrder.displayNo));
  assert.equal(calls.at(-1).searchParams.get('page'),'1');
  assert(calls.at(-1).searchParams.get('createdFrom').endsWith('T00:00:00+08:00'));
  assert(calls.at(-1).searchParams.get('createdTo').endsWith('T00:00:00+08:00'));
  assert.equal(node.querySelector('#oc-date-error'),null);
});


test('U3 order fee label follows the stage while the split stays visible and payment stays separate', async t => {
  const {root,node,AdminOrderChainView}=await setup(t); let current;
  globalThis.fetch=async()=>response({items:[current],page:1,pageSize:20,total:1,contextKey:'fee-root'});
  const cases=[
    {status:'PENDING_PAYMENT',label:'本次预付',payment:'RECORDED_UNPAID',breakdown:{basis:'NATIVE_FROZEN_ORDER_QUOTE',completeness:'COMPLETE',haffRental:{amount:'98.08'},materialsPrepay:{amount:'11.00'}},expect:['哈夫租金 ¥98.08','物资预付 ¥11.00','押金 ¥50.00']},
    {status:'COMPLETED',label:'原预付',payment:'RECORDED_PAID',breakdown:{basis:'NATIVE_FROZEN_ORDER_QUOTE',completeness:'PARTIAL',haffRental:{amount:'98.08'},materialsPrepay:null},expect:['哈夫租金 ¥98.08','物资预付 分项待核','押金 ¥50.00']},
    {status:'CANCELLED',label:'原单金额',payment:'UNKNOWN',breakdown:null,expect:['哈夫租金/物资预付分项待核','押金 ¥50.00','支付事实待核']},
  ];
  for(const [index,item] of cases.entries()){
    current={...order,id:'fee-'+index,displayNo:'FEE-'+index,status:item.status,payment:{state:item.payment,recordedAt:null,recordedAmount:null},prepaymentBreakdown:item.breakdown,amounts:{...order.amounts,deposit:{currency:'CNY',unit:'yuan',amount:'50.00',scale:2},totalDue:{currency:'CNY',unit:'yuan',amount:'159.08',scale:2}},source:{origin:'NATIVE'}};
    await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('fee-'+index),refreshNonce:index})));
    await until(()=>node.textContent.includes(current.displayNo));
    const fee=node.querySelector('.oc-table td.oc-amount').textContent;
    assert.match(fee,new RegExp(item.label));
    for(const text of item.expect) assert.ok(fee.includes(text),`${item.status}: ${text} from ${fee}`);
    assert.match(fee,/¥159\.08/,'the original amount stays exact');
    if(item.status!=='CANCELLED')assert.equal(fee.includes('未形成支付')||fee.includes('支付事实待核'),false,'payment state is not folded into a normal fee cell');
  }
});

test('master: list requests the bounded projection and keeps the true material count', async t => {
  const {root,node,AdminOrderChainView}=await setup(t),calls=[];
  const item={...chainOrder,id:'bounded-materials',displayNo:'BOUNDED-MATERIALS',frozenAccount:{source:'ORDER_VERSION',haff:null,materials:[{code:'one',name:'物资甲',quantity:'1',unit:'PIECE'},{code:'two',name:'物资乙',quantity:'2',unit:'PIECE'},{code:'three',name:'物资丙',quantity:'3',unit:'PIECE'}],materialsTotal:6,materialsTruncated:true,termDays:null,termSeconds:null,loginMethodText:null}};
  globalThis.fetch=async url=>{calls.push(new URL(String(url),'http://localhost'));return response(chainPage([item]));};
  await act(async()=>root.render(createElement(AdminOrderChainView,chainProps('bounded-materials'))));await until(()=>node.textContent.includes('BOUNDED-MATERIALS'));
  assert.equal(calls[0].searchParams.get('view'),'list');assert.match(node.textContent,/等 6 项/);assert.equal(calls.length,1);
});

test('master: order detail separates lack of permission, unknown parts and verified legacy arithmetic', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);let value={...chainOrder,id:'clarity-native',displayNo:'CLARITY-NATIVE',status:'PAID',payment:{state:'RECORDED_PAID',recordedAt:null,recordedAmount:null},prepaymentBreakdown:{basis:'NATIVE_FROZEN_ORDER_QUOTE',completeness:'UNKNOWN',haffRental:null,materialsPrepay:null},source:{origin:'NATIVE'}};
  globalThis.fetch=async url=>String(url).includes('readMode=combined')?response({order:value}):response({error:{code:'NOT_FOUND'}},404);
  const props={...chainProps('clarity-native'),objectOnly:true,initialOrderId:value.id};
  await act(async()=>root.render(createElement(AdminOrderChainView,props)));await until(()=>node.textContent.includes('CLARITY-NATIVE'));
  assert.match(node.textContent,/无权查看/);assert.match(node.textContent,/哈夫租金未知（依据未提供）/);assert.match(node.textContent,/物资预付未知（依据未提供）/);
  value={...value,id:'clarity-legacy',displayNo:'CLARITY-LEGACY',source:{origin:'LEGACY',statusLabel:'已取消'},payment:{state:'RECORDED_UNPAID',recordedAt:null,recordedAmount:null},prepaymentReconciliation:{state:'MISMATCH',arithmetic:'MISMATCH',closed:false},legacyResources:{state:'KNOWN',source:'LEGACY_ORIGINAL_ORDER',items:[{code:'x',name:'原单物资',quantity:'4',unit:null,zero:false}]},frozenAccount:{source:'ACCOUNT_PUBLIC_VERSION',haff:null,materials:[],termDays:null,termSeconds:null,loginMethodText:null}};
  await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('clarity-legacy'),objectOnly:true,initialOrderId:value.id})));await until(()=>node.textContent.includes('CLARITY-LEGACY'));
  assert.match(node.textContent,/账号资料（与账号页一致）/);assert.doesNotMatch(node.textContent,/历史账号|旧单资源数量/);
  assert.match(node.textContent,/原单记录，合计尚未核对/);assert.match(node.textContent,/完整构成仍待核对/);assert.match(node.textContent,/未记录付款/);assert.doesNotMatch(node.textContent,/本单冻结账号摘要 · 历史/);
});
test('first, refresh and page read errors remain failures; expired restore context rereads page one', async t => {
  const {root,node,AdminOrderChainView} = await setup(t);const calls=[];let mode='first-failure';
  globalThis.fetch = async url => {const parsed=new URL(String(url),'http://localhost');calls.push(parsed);return mode.endsWith('failure')?response({error:{code:'INTERNAL_ERROR'}},500):mode==='conflict'&&parsed.searchParams.has('restoreKey')?response({error:{code:'CONFLICT'}},409):response(chainPage([chainOrder],{total:50}));};
  const props=chainProps('chain-failures');await act(async () => root.render(createElement(AdminOrderChainView,props)));
  await until(() => node.textContent.includes('读取暂不可用'));assert(!node.textContent.includes('暂无订单'));
  mode='ready';await act(async () => buttonNamed(node,'重试').click());await until(() => node.textContent.includes(chainOrder.displayNo));
  mode='page-failure';await act(async () => node.querySelector('[aria-label="下一页"]').click());await until(() => node.textContent.includes('读取暂不可用'));assert.equal(calls.at(-1).searchParams.get('page'),'2');
  mode='ready';await act(async () => buttonNamed(node,'重试').click());await until(() => node.textContent.includes(chainOrder.displayNo));assert.equal(calls.at(-1).searchParams.get('page'),'2');
  mode='refresh-failure';await act(async () => root.render(createElement(AdminOrderChainView,{...props,refreshNonce:1})));await until(() => node.textContent.includes('读取暂不可用'));assert(!node.textContent.includes('暂无订单'));
  mode='conflict';await act(async () => buttonNamed(node,'重试').click());await until(() => node.textContent.includes('可见范围已变化')&&node.textContent.includes(chainOrder.displayNo));
  assert.equal(calls.at(-1).searchParams.get('page'),'1');assert.equal(calls.at(-1).searchParams.has('restoreKey'),false);
});

test('session change and permission revocation discard private lookup state and ignore late results', async t => {
  const {browser,root,node,AdminOrderChainView} = await setup(t);let finish;const calls=[];
  globalThis.fetch = async url => {calls.push(String(url));return calls.length===1?new Promise(resolve=>{finish=resolve;}):response(chainPage([{...chainOrder,displayNo:'CURRENT-IDENTITY'}]));};
  const old=chainProps('chain-old');await act(async () => root.render(createElement(AdminOrderChainView,old)));
  const current=chainProps('chain-current');await act(async () => root.render(createElement(AdminOrderChainView,current)));await until(()=>node.textContent.includes('CURRENT-IDENTITY'));
  await act(async () => finish(response(chainPage([{...chainOrder,displayNo:'STALE-IDENTITY'}]))));assert(!node.textContent.includes('STALE-IDENTITY'));
  await changeField(browser,node,'查找线索','private clue');await act(async () => node.querySelector('.oc-search').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await until(()=>node.textContent.includes('CURRENT-IDENTITY'));
  const before=calls.length;await act(async () => root.render(createElement(AdminOrderChainView,{...current,snapshot:{...current.snapshot,permissions:[]}})));
  assert(node.textContent.includes('当前没有订单查询权限'));assert(!node.textContent.includes('CURRENT-IDENTITY'));assert.equal(calls.length,before);
  await act(async () => root.render(createElement(AdminOrderChainView,current)));await until(()=>node.textContent.includes('CURRENT-IDENTITY'));
  assert.equal(node.querySelector('[aria-label="查找线索"]').value,'');assert(!new URL(calls.at(-1),'http://localhost').searchParams.has('qValue'));
});


test('CHAIN refund intents keep their own coverage, budget and review facts apart from bank arrival', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  const value={...chainOrder,id:'refund-intents',displayNo:'REFUND-INTENTS',status:'PAID',source:{origin:'NATIVE'}};
  const refundSummary={contractVersion:'admin-order-refund-summary.v1',integration:'INTEGRATED',bankArrival:'UNKNOWN',reasonCodes:[],intents:[
    {intentId:'i1',refundOrderNo:'RF-1',amount:{cents:'1000',currency:'CNY'},localState:'SUCCEEDED',budgetDisposition:'CONSUMED',requiresReview:false,mayResubmit:false,bankArrival:'UNKNOWN'},
    {intentId:'i2',refundOrderNo:'RF-2',amount:{cents:'2500',currency:'CNY'},localState:'REVIEW_REQUIRED',budgetDisposition:'RELEASED',requiresReview:true,mayResubmit:false,bankArrival:'UNKNOWN'},
  ]};
  globalThis.fetch=async url=>String(url).includes('readMode=combined')?response({order:value,refundSummary}):response({error:{code:'NOT_FOUND'}},404);
  await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('refund-intents'),objectOnly:true,initialOrderId:value.id})));
  await until(()=>node.textContent.includes('REFUND-INTENTS'));
  const text=node.textContent;
  assert.match(text,/RF-1[\s\S]*10\.00/);assert.match(text,/RF-2[\s\S]*25\.00/);
  assert.match(text,/本地退款成功记录/);assert.doesNotMatch(text,/本地受控成功/);assert.match(text,/需人工复核/);
  assert.match(text,/预算已用/);assert.match(text,/预算释放/);
  assert.match(text,/渠道到账未核定/);assert.equal(text.includes('银行已到账'),false);
});
test('optional finance/group reads are independent and never call controlled settlement or infer rental start', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);const calls=[];let finishFinance,mode='slow';
  const native={...chainOrder,id:'native-old',displayNo:'NATIVE-OLD',status:'PAID',source:{origin:'NATIVE'}};
  const proof=p=>({document:{ref:'ORDER:'+decodeURIComponent(p).match(/ORDER:([^?]+)/)[1]},orderSettlement:undefined});
  globalThis.fetch=async url=>{const p=String(url);calls.push(p);if(p.includes('/finance/'))return mode==='slow'?new Promise(resolve=>{finishFinance=resolve;}):response(proof(p));if(p.includes('/im?'))return response({error:{code:'FORBIDDEN'}},403);return response({order:p.includes('native-current')?{...native,id:'native-current',displayNo:'NATIVE-CURRENT'}:native});};
  const props={...chainProps('chain-optional'),snapshot:{...snapshotFor('chain-optional'),permissions:['order.read','finance.document.read','im.support.read']},objectOnly:true,initialOrderId:native.id};
  await act(async () => root.render(createElement(AdminOrderChainView,props)));await until(()=>node.textContent.includes('关键费用')&&node.textContent.includes('当前身份无权读取本单群'));
  assert(node.textContent.includes(native.displayNo));assert.equal(node.querySelectorAll('[aria-busy="true"]').length,1);
  await act(async () => finishFinance(response({error:{code:'NOT_FOUND'}},404)));await until(()=>node.textContent.includes('未找到当前范围内可读的资金单据'));
  const bodyReads=calls.filter(p=>p.includes('readMode')).length;mode='ready';await act(async () => buttonNamed(node,'重新读取资金依据').click());await until(()=>node.textContent.includes('尚未提供受权订单资金依据'));
  assert.equal(calls.filter(p=>p.includes('readMode')).length,bodyReads);assert(node.textContent.includes('开租待核'));
  mode='slow';await act(async () => root.render(createElement(AdminOrderChainView,{...props,refreshNonce:1})));await until(()=>node.textContent.includes('关键费用'));const stale=finishFinance;
  mode='ready';await act(async () => root.render(createElement(AdminOrderChainView,{...props,initialOrderId:'native-current'})));await until(()=>node.textContent.includes('NATIVE-CURRENT'));
  await act(async () => stale(response(proof('/finance/documents/ORDER:native-old'))));assert(node.textContent.includes('NATIVE-CURRENT'));assert(!node.textContent.includes('NATIVE-OLD'));assert(node.textContent.includes('开租待核'));assert(!calls.some(p=>p.includes('/settlement')));
});

test('frozen account summary is displayed from the existing order payload without another business request', async t => {
  const {root,node,AdminOrderChainView}=await setup(t); let calls=0;
  const frozen={source:'ORDER_VERSION',haff:{code:'haff',name:'哈夫币',quantity:'98080000',unit:'HAFF_BASE'},materials:[{code:'barrett',name:'巴雷特子弹',quantity:'2',unit:'ROUND'}],termDays:'1',termSeconds:'86400',loginMethodText:'QQ扫码'};
  const item={...chainOrder,id:'frozen-order',displayNo:'FROZEN-ORDER',source:{origin:'NATIVE'},frozenAccount:frozen};
  globalThis.fetch=async()=>{calls++;return response(chainPage([item]));};
  await act(async()=>root.render(createElement(AdminOrderChainView,chainProps('frozen'))));
  await until(()=>node.textContent.includes('FROZEN-ORDER'));
  assert(node.textContent.includes('本单冻结'));
  assert(node.textContent.includes('98.08 M 哈夫币'));
  assert(node.textContent.includes('巴雷特子弹'));
  assert(node.textContent.includes('1 天'));
  assert(node.textContent.includes('QQ扫码'));
  assert.equal(calls,1,'the frozen summary reuses the list payload');
});


test('legacy frozen account is a historical reference, not an order-frozen inventory or actual term', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  const value={...chainOrder,haffRatio:{source:'ACCOUNT_PUBLIC_VERSION',state:'KNOWN',wanPerYuan:'52',customerTier:null},frozenAccount:{source:'ACCOUNT_PUBLIC_VERSION',haff:{code:'haff',name:'哈夫币',quantity:'51000000',unit:'HAFF_BASE'},materials:[],termDays:'6',termSeconds:'518400',loginMethodText:'QQ账密',safeBoxText:'基础安全箱(1*2)',gradingText:'黄金'}};
  globalThis.fetch=async()=>response(chainPage([value]));
  await act(async()=>root.render(createElement(AdminOrderChainView,chainProps('legacy-frozen'))));
  await until(()=>node.textContent.includes(value.displayNo));
  // 迁入单：账号即账号，标题由基础信息拼接，比例标明来自账号，不出现历史/草稿字样
  assert.match(node.textContent,/51 M 哈夫币 · 基础安全箱\(1\*2\) · 黄金/);
  assert.match(node.textContent,/账号资料：/);assert.match(node.textContent,/6 天/);
  assert.match(node.textContent,/账号比例 1元=52万哈夫币/);
  assert.doesNotMatch(node.textContent,/历史账号|旧单未记录比例|草稿|不是本单原标题|未留名用户/);
  assert.equal(node.textContent.includes('本单冻结：'),false,'legacy account facts are not called the order-frozen inventory');
  globalThis.fetch=async()=>response({order:value});
  await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('legacy-frozen-detail'),objectOnly:true,initialOrderId:value.id})));
  await until(()=>node.textContent.includes('关键费用'));
  assert.match(node.textContent,/账号资料（与账号页一致）/);
  assert.match(node.textContent,/6 天/);
});

test('CHAIN order detail orders identity, frozen parties, prepay/channel, fulfillment, settlement and funds evidence once', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  const value={...chainOrder,id:'chain-order-detail',displayNo:'CHAIN-DETAIL',source:{origin:'NATIVE'}};
  const paymentSummary={contractVersion:'admin-order-payment-summary.v1',integration:'CONTROLLED_LOCAL',productionPaymentCapability:false,originalRequest:{id:'req',channelOrderNo:'MERCHANT-1',method:'ALIPAY_NATIVE',amount:{cents:'15908',currency:'CNY'},merchantIdentityId:'m',protocolVersion:'1',keyVersionRef:'k',createdAt:value.createdAt},latestTrustedObservation:null,acceptance:{state:'APPLIED',confirmationId:'c',reasonCode:null},conflicts:null,recovery:null,settlement:'NOT_INTEGRATED',unknowns:null,updatedAt:null};
  globalThis.fetch=async url=>String(url).includes('readMode=combined')?response({order:value,paymentSummary}):String(url).includes('/finance/')?response({error:{code:'NOT_FOUND'}},404):response({items:[value],page:1,pageSize:20,total:1,contextKey:'c'});
  await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('chain-order-detail'),objectOnly:true,initialOrderId:value.id})));await until(()=>node.textContent.includes('本单账号和双方'));
  const text=node.textContent;
  const headings=[...node.querySelectorAll('main h2')].map(item=>item.textContent);
  assert(headings.indexOf('当前情况')<headings.indexOf('本单账号和双方'));
  assert(headings.indexOf('本单账号和双方')<headings.indexOf('关键费用'));
  assert(headings.indexOf('关键费用')<headings.indexOf('履约与处理记录'));
  assert(headings.indexOf('履约与处理记录')<headings.indexOf('结算与退款'));
  assert(headings.indexOf('结算与退款')<headings.indexOf('资金凭证与来源记录'));
  assert.equal((text.match(/本单账号和双方/g)??[]).length,1,'account/parties are not duplicated in the aside');
  const toggle=[...node.querySelectorAll('button')].find(button=>button.textContent.includes('查看付款依据'));
  await act(async()=>toggle.click());await settle();
  const payment=node.textContent;
  assert.match(payment,/渠道观察/);assert.match(payment,/本站接纳/);assert.match(payment,/商户订单号/);assert.match(payment,/MERCHANT-1/);
  assert.match(payment,/本站已接纳/);assert.equal(payment.includes('已到账'),false);
});
test('server progress drives opening/ending without inferring them from PAID or a cancelled status', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  const base={...chainOrder,id:'progress-order',displayNo:'PROGRESS-ORDER',source:{origin:'NATIVE'},payment:{state:'RECORDED_PAID',recordedAt:null,recordedAmount:null}};
  const cases=[
    {status:'PAID',progress:undefined,expect:['开租待核'],forbid:['已开租']},
    {status:'PAID',progress:{asOfUtc:'2026-10-25T00:00:00.000000Z',opening:{state:'CONFIRMED',confirmedAtUtc:'2026-10-25T01:00:00.000000Z'},ending:{state:'PENDING_PARTIES',currentVersionNo:2,postedAtUtc:null}},expect:['已开租','待双方确认'],forbid:['开租待核']},
    {status:'CANCELLED',paidAt:null,payment:{state:'RECORDED_UNPAID',recordedAt:null,recordedAmount:null},progress:{asOfUtc:'2026-10-25T00:00:00.000000Z',opening:{state:'NOT_APPLICABLE',confirmedAtUtc:null},ending:{state:'NOT_APPLICABLE',currentVersionNo:null,postedAtUtc:null}},expect:['开租不适用','结算不适用'],forbid:['开租待核','退款待核']},
  ];
  for(const [index,item] of cases.entries()){
    const order={...base,...item};
    globalThis.fetch=async()=>response({order});
    await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('progress-'+index),objectOnly:true,initialOrderId:order.id})));
    await until(()=>node.textContent.includes(order.displayNo));
    for(const text of item.expect)assert(node.textContent.includes(text),`${item.status} should show ${text}`);
    for(const text of item.forbid)assert(!node.textContent.includes(text),`${item.status} should not show ${text}`);
  }
});

test('legacy resource export reuses the canonical detail and preserves exact user and order returns', async t => {
  const {AdminResourceReadView}=await setup(t),opened=[];
  const actor={...snapshotFor('chain-resource'),permissions:['order.read','user.directory.read','supply.rental_account.read']};
  const surface=AdminResourceReadView({snapshot:actor,accountId:'account-1',fromUserId:'source-user',fromUserSection:'resources',fromUserPublication:'published',fromOrderId:'source-order',onOpenPath:path=>opened.push(path),refreshNonce:0});
  const [returns,detail]=surface.props.children;
  assert.equal(detail.type.name,'SupplyListingReviewView');
  assert.equal(detail.props.initialAccountId,'account-1');
  assert.equal(detail.props.snapshot,actor,'resource permission is never replaced by review permission');
  returns.props.children[0].props.onClick();
  assert.equal(opened.at(-1),'/users/source-user?section=resources&publication=published&fromOrderId=source-order');
  returns.props.children[1].props.onClick();
  assert.equal(opened.at(-1),'/orders/source-order?fromUserId=source-user&fromUserSection=resources&fromUserPublication=published');
  const denied=AdminResourceReadView({snapshot:snapshotFor('resource-denied'),accountId:'account-1',fromUserId:'source-user',fromUserSection:'resources',onOpenPath:()=>{},refreshNonce:0});
  assert.equal(denied.props.children[0],null,'return links obey their independent user and order permissions');
});

test('order account labels distinguish legacy source numbers in lists, detail and related resource tabs', async t => {
  const {root,node,AdminOrderChainView,AdminResourceReadView}=await setup(t),opened=[];
  const cases=[
    {value:'ZZ20261018000116',expected:'账号 ZZ20261018000116'},
    {value:'ZZ20261018000001',expected:'账号 ZZ20261018000001',origin:'NATIVE'},
    {value:'AC9000000000002',expected:'账号 AC9000000000002'},
    {value:null,expected:'账号编号待核'},
    {value:'not-a-canonical-number',expected:'账号编号待核'},
  ];
  const items=cases.map((c,i)=>({...chainOrder,id:'number-'+i,displayNo:'ORDER-NUMBER-'+i,accountDisplayNo:c.value,source:{origin:c.origin??'LEGACY'}}));
  const props={...chainProps('number-list'),snapshot:{...snapshotFor('number-list'),permissions:['order.read','user.directory.read','supply.rental_account.read']},onOpenPath:(path,title)=>opened.push({path,title})};
  globalThis.fetch=async()=>response(chainPage(items,{total:items.length}));
  await act(async()=>root.render(createElement(AdminOrderChainView,props)));await until(()=>node.querySelectorAll('.oc-table tbody tr').length===items.length);
  // 迁入账号即新平台账号：列表展示 ZZ 编号 +“旧平台迁入”小标记
  const listText=c=>c.expected.replace(/^账号 /, '');
  cases.forEach((c,i)=>assert(node.querySelectorAll('.oc-table tbody tr')[i].textContent.includes(listText(c)),c.expected));
  assert.equal(node.querySelector('.oc-table tbody tr').textContent.includes('0000123'),false,'列表行不出现旧编号');
  assert.equal(node.querySelector('.oc-table tbody tr .oc-badge-legacy').textContent,'旧平台迁入');
  assert.deepEqual([...node.querySelectorAll('.oc-table tbody tr')[0].querySelectorAll('.oc-party-role')].map(e=>e.textContent),['租客','号主']);
  assert.deepEqual([...node.querySelectorAll('.oc-table tbody tr')[1].querySelectorAll('.oc-party-role')].map(e=>e.textContent),['租客','号主']);
  assert.equal(node.querySelector('.oc-table').textContent.includes('账号 0000123'),false);
  await act(async()=>[...node.querySelectorAll('.oc-table tbody tr button')].find(b=>b.textContent==='ZZ20261018000116').click());
  assert.equal(opened.at(-1).title,cases[0].expected);assert.equal(opened.at(-1).path,`/supply/reviews/${items[0].accountId}?fromOrderId=${items[0].id}`);
  globalThis.fetch=async()=>response({order:items[0]});
  await act(async()=>root.render(createElement(AdminOrderChainView,{...props,objectOnly:true,initialOrderId:items[0].id})));await until(()=>node.textContent.includes('本单账号和双方'));
  assert(node.querySelector('.oc-heading p').textContent.includes(cases[0].expected));
  const resourceLink=[...node.querySelectorAll('.oc-related button')].find(b=>b.textContent===cases[0].expected);assert(resourceLink);
  await act(async()=>resourceLink.click());assert.equal(opened.at(-1).title,cases[0].expected);
  assert.match(node.querySelector('.oc-related').textContent,/查看当前账号/);
  const resource=AdminResourceReadView({snapshot:props.snapshot,accountId:'account-1',onOpenPath:()=>{},refreshNonce:0});
  assert.equal(resource.props.children[1].props.initialAccountId,'account-1');
});

test('current account links require supply reading and keep the order frozen version separate', async t => {
  const {root,node,AdminOrderChainView}=await setup(t),opened=[],requests=[];
  const frozen={source:'ORDER_VERSION',haff:{code:'haff',quantity:'98080000',unit:'HAFF_BASE'},materials:[],termDays:'1',termSeconds:'86400',loginMethodText:'QQ扫码'};
  const value={...chainOrder,id:'frozen-canonical',accountId:'account-current',versionId:'order-frozen-version',contentHash:'f'.repeat(64),frozenAccount:frozen};
  globalThis.fetch=async url=>{requests.push(String(url));return response({order:value});};
  const props={...chainProps('canonical-only-order'),objectOnly:true,initialOrderId:value.id,onOpenPath:(path,title)=>opened.push({path,title})};
  await act(async()=>root.render(createElement(AdminOrderChainView,props)));await until(()=>node.textContent.includes('本单账号和双方'));
  assert.equal([...node.querySelectorAll('.oc-related button')].some(button=>button.textContent.includes('账号')),false);
  await act(async()=>root.render(createElement(AdminOrderChainView,{...props,snapshot:{...props.snapshot,permissions:['order.read','supply.rental_account.read']}})));await until(()=>node.querySelector('.oc-related button'));
  await act(async()=>node.querySelector('.oc-related button').click());
  assert.equal(opened.at(-1).path,'/supply/reviews/account-current?fromOrderId=frozen-canonical');
  assert.match(node.querySelector('.oc-related').textContent,/本单冻结账号摘要/);
  assert.match(node.querySelector('.oc-related').textContent,/98\.08 M 哈夫币/);
  assert.equal(value.versionId,'order-frozen-version');assert.equal(value.contentHash,'f'.repeat(64));
  assert.equal(requests.every(url=>!url.includes('/supply/')),true,'opening a current account never rereads or replaces frozen order facts');
});

test('order party labels and real names are identical for migrated and native orders', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  for(const origin of ['LEGACY','NATIVE']){
    const item={...chainOrder,id:'party-'+origin,displayNo:'ORDER-PARTY-'+origin,source:{origin}};
    globalThis.fetch=async url=>String(url).includes('readMode=combined')?response({order:item}):response({error:{code:'NOT_FOUND'}},404);
    await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('party-'+origin),objectOnly:true,initialOrderId:item.id})));await until(()=>node.textContent.includes(item.displayNo)&&node.textContent.includes('本单账号和双方'));
    const labels=[...node.querySelectorAll('.oc-related-person small')].map(e=>e.textContent),prefix='';
    assert(labels.includes(prefix+'租客 · 编号 U-RENTER'));assert(labels.includes(prefix+'号主 · 编号 U-OWNER'));
    assert(labels.every(label=>!label.includes('历史租客')&&!label.includes('历史号主')));
    assert.doesNotMatch(node.querySelector('.oc-related').textContent,/未留名用户/);
  }
});



test('channel payment summary keeps local acceptance and simulated evidence distinct from receipt',async t=>{
  const {root,node,AdminOrderChainView}=await setup(t);
  const base={contractVersion:'admin-order-payment-summary.v1',productionPaymentCapability:false,originalRequest:null,latestTrustedObservation:null,acceptance:null,conflicts:null,recovery:null,settlement:'NOT_INTEGRATED',unknowns:null,updatedAt:null};
  const cases=[{integration:'NOT_INTEGRATED',text:'渠道付款摘要尚未接入'},{integration:'CONTROLLED_LOCAL',acceptance:{state:'APPLIED'},text:'本地已接纳'},
    {integration:'JOINPAY',acceptance:{state:'APPLIED'},unknowns:['PAYMENT_SOURCE_DIFFERS_FROM_REQUEST'],text:'本地受控接纳，付款来源与渠道请求不同'},
    {integration:'JOINPAY',dataOrigin:'JOINPAY_PROVIDER',productionPaymentCapability:true,acceptance:{state:'APPLIED'},text:'汇聚原确认 · 本地已接纳'},
    {integration:'JOINPAY',dataOrigin:'JOINPAY_PROVIDER',productionPaymentCapability:false,acceptance:{state:'APPLIED'},text:'汇聚原确认 · 本地已接纳'},
    {integration:'JOINPAY',dataOrigin:'JOINPAY_PROVIDER',productionPaymentCapability:false,acceptance:{state:'APPLIED'},unknowns:['PAYMENT_SOURCE_DIFFERS_FROM_REQUEST'],text:'汇聚原确认，付款来源与渠道请求不同'},
    {integration:'JOINPAY',dataOrigin:'JOINPAY_PROVIDER',productionPaymentCapability:false,acceptance:{state:'APPLIED'},text:'汇聚原确认 · 本地已接纳',
      latestTrustedObservation:{source:'QUERY',evidenceLevel:'JOINPAY_VERIFIED',providerTimeZone:'EXPLICIT_OFFSET',providerTimeOffsetMinutes:480,providerPaidAt:'2026-10-23T02:00:00Z'}},
    {integration:'JOINPAY',dataOrigin:'JOINPAY_CANDIDATE',productionPaymentCapability:true,acceptance:{state:'NONE'},text:'汇聚请求候选不构成已付款'},
    {integration:'JOINPAY',dataOrigin:'FUTURE_SOURCE',productionPaymentCapability:true,text:'摘要版本待核对'},
    {integration:'JOINPAY',dataOrigin:'UNKNOWN',unknowns:['UNKNOWN_PAYMENT_SOURCE'],acceptance:{state:'APPLIED'},text:'付款来源待核'}];
  for(const [index,item] of cases.entries()){
    const current={...chainOrder,id:'channel-'+index,displayNo:'CHANNEL-'+index,source:{origin:'NATIVE'}};
    globalThis.fetch=async url=>String(url).includes('readMode=combined')?response({order:current,paymentSummary:{...base,...item}}):response({error:{code:'NOT_FOUND'}},404);
    await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('channel-'+index),objectOnly:true,initialOrderId:current.id})));
    await until(()=>node.textContent.includes(item.text));
    assert.equal(node.textContent.includes('汇聚已收款'),false);assert.equal(node.textContent.includes('渠道已到账'),false);
    assert.equal([...node.querySelectorAll('button')].some(button=>button.textContent.includes('人工补查')),false);
    if(item.dataOrigin==='JOINPAY_PROVIDER'||item.dataOrigin==='JOINPAY_CANDIDATE')assert.equal(node.textContent.includes('当前为本地协议验证环境'),false);
    if(item.dataOrigin==='JOINPAY_PROVIDER')assert.equal(node.textContent.includes('摘要版本待核对'),false);
    if(item.dataOrigin==='JOINPAY_PROVIDER'&&item.unknowns?.includes('PAYMENT_SOURCE_DIFFERS_FROM_REQUEST'))assert.equal(node.textContent.includes('本地受控接纳'),false);
    if(item.latestTrustedObservation){
      const toggle=[...node.querySelectorAll('button')].find(button=>button.textContent.includes('查看付款依据'));
      await act(async()=>toggle.click()); await until(()=>node.textContent.includes('已存汇聚查询签名与绑定证据'));
      assert(node.textContent.includes('按已核时区换算')); assert.equal(node.textContent.includes('协议模拟观察'),false);
    }
  }
});

test('FLOW02 Root F1: cancelled payment remains paid, known unpaid, or unknown', async t => {
 const {root,node,AdminOrderChainView}=await setup(t);let current;
 globalThis.fetch=async()=>response({items:[current],page:1,pageSize:20,total:1,contextKey:'root-f1'});
 for(const [index,state]of ['RECORDED_PAID','RECORDED_UNPAID','UNKNOWN'].entries()){
  current={...order,id:'cancel-'+state,displayNo:'CANCEL-'+state,status:'CANCELLED',source:{origin:'LEGACY',statusLabel:'已取消'},payment:{state,recordedAt:null,recordedAmount:null}};
  await act(async()=>root.render(createElement(AdminOrderChainView,{snapshot:snapshotFor('root-f1-'+state),onOpenPath:()=>{},onQueryChange:()=>{},refreshNonce:index})));await until(()=>node.textContent.includes(current.displayNo));
  const fee=node.querySelector('.oc-table td.oc-amount').textContent;
  assert.match(fee,/原单金额/,'a cancelled order keeps the original amount label, not the advance label');
  assert.match(fee,/哈夫租金/);assert.match(fee,/物资预付/);assert.match(fee,/押金/);
  if(state==='RECORDED_PAID')assert.match(fee,/退款待核/);
  else if(state==='RECORDED_UNPAID')assert.match(fee,/未形成支付/);
  else{assert.match(fee,/支付.*待核|支付.*未知/);assert.doesNotMatch(fee,/未形成支付/);}
 }
});

test('FLOW02 visual: cancelled compact progress omits inapplicable stages and keeps payment uncertainty', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  const value={...chainOrder,payment:{state:'UNKNOWN',recordedAt:null,recordedAmount:null},progress:{asOfUtc:null,opening:{state:'NOT_APPLICABLE',confirmedAtUtc:null},ending:{state:'NOT_APPLICABLE',currentVersionNo:null,postedAtUtc:null}}};
  globalThis.fetch=async()=>response(chainPage([value]));
  await act(async()=>root.render(createElement(AdminOrderChainView,chainProps('visual-cancelled'))));
  await until(()=>node.querySelector('.oc-stages-compact'));
  const text=node.querySelector('.oc-stages-compact').textContent;
  assert(text.includes('已取消')&&text.includes('支付事实待核'));
  assert(!text.includes('开租不适用')&&!text.includes('结算不适用'));
  const timeline=node.querySelector('.oc-stages-compact ol[aria-label="订单进度"]');
  assert.ok(timeline,'compact mode is an icon timeline, not two text lines');
  assert.deepEqual([...timeline.querySelectorAll('li .oc-stage-name')].map(item=>item.textContent),['创建','支付待核','取消']);
  assert.equal(timeline.querySelectorAll('li svg').length,3,'each stage keeps its icon');
  assert.equal(timeline.querySelectorAll('li .oc-stage-line').length,2,'connectors are rendered between stages');
  assert.ok(timeline.querySelector('li.cancel'),'the cancelled stage is named and not color-only');
});

test('FLOW02 hover: account and party links preserve Base UI trigger properties on their real buttons', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  globalThis.fetch=async()=>response(chainPage());
  const props={...chainProps('hover-props'),snapshot:{...snapshotFor('hover-props'),permissions:['order.read','user.directory.read','supply.rental_account.read']}};
  await act(async()=>root.render(createElement(AdminOrderChainView,props)));
  await until(()=>node.querySelector('.oc-table tbody tr'));
  const links=[...node.querySelector('.oc-table tbody tr').querySelectorAll('button.oc-link')];
  assert.equal(links.length,3);
  for(const link of links) assert.equal(link.getAttribute('data-slot'),'hover-card-trigger','the rendered navigation button must receive the hover trigger props');
});

test('FLOW02 visual: progress timestamps use the same display formatter as order dates', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  const instant='2026-10-25T01:02:03.000000Z';
  const value={...chainOrder,status:'COMPLETED',source:{origin:'NATIVE'},createdAt:instant,progress:{asOfUtc:instant,opening:{state:'CONFIRMED',confirmedAtUtc:instant},ending:{state:'POSTED',currentVersionNo:1,postedAtUtc:instant}}};
  globalThis.fetch=async()=>response({order:value});
  await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('visual-dates'),objectOnly:true,initialOrderId:value.id})));
  await until(()=>node.textContent.includes('过账时间'));
  const expected=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(new Date(instant));
  assert(node.querySelector('.oc-stages').textContent.includes('过账时间 '+expected));
  assert(node.querySelector('.oc-stages').textContent.includes('开租时间 '+expected));
  assert(!node.querySelector('.oc-stages').textContent.includes(instant));
});


test('order user hover receives real row business summary with zero added fetch',async t=>{
 const {root,node,AdminOrderChainView}=await setup(t);const calls=[];
 const row={...chainOrder,renterSummary:{name:'当前昵称',image:null,maskedPhone:'138****8000',riskFlag:true,membershipSummary:{state:'ready',growth:{knowledge:'KNOWN',effectiveTier:'BLACK_GOLD'}},creditSummary:{state:'ready',knowledge:'KNOWN',score:0,revision:'1'}}};
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),method:init?.method??'GET'});return response(chainPage([row]));};
 const props={...chainProps('hover-summary'),snapshot:{...snapshotFor('hover-summary'),permissions:['order.read','user.directory.read']}};
 await act(async()=>root.render(createElement(AdminOrderChainView,props)));await until(()=>node.textContent.includes(row.displayNo));
 const initial=calls.length,button=node.querySelector('button[aria-label="预览租客 租客"]');assert(button);await act(async()=>button.click());
 await until(()=>document.querySelector('[aria-label="用户预览：租客"]'));const card=document.querySelector('[aria-label="用户预览：租客"]');
 assert.match(card.textContent,/黑金（永久）/);assert.match(card.textContent,/信用分：0/);assert.match(card.textContent,/内部高危/);assert.match(card.textContent,/U-RENTER/);assert.match(card.textContent,/当前昵称/);assert.doesNotMatch(card.textContent,/最后登录/);assert.equal(calls.length,initial);
});

test('order account hover includes frozen quantities term and correctly labelled zero deposit',async t=>{
 const {root,node,AdminOrderChainView}=await setup(t);const calls=[];
 const row={...chainOrder,source:{origin:'NATIVE'},frozenAccount:{source:'ORDER_VERSION',haff:{code:'haff',quantity:'9000000',unit:'HAFF_BASE'},materials:[{code:'awm',name:'AWM子弹',quantity:'61',unit:'ROUND'},{code:'armor',name:'六级甲',quantity:'0',unit:'PIECE'}],termDays:null,termSeconds:'172800',loginMethodText:'微信扫码'}};
 globalThis.fetch=async url=>{calls.push(String(url));return response(chainPage([row]));};const props={...chainProps('hover-account'),snapshot:{...snapshotFor('hover-account'),permissions:['order.read','user.directory.read','supply.rental_account.read']}};
 await act(async()=>root.render(createElement(AdminOrderChainView,props)));await until(()=>node.textContent.includes(row.displayNo));const initial=calls.length;
 const button=node.querySelector('button[aria-label^="预览账号"]');assert(button);await act(async()=>button.click());await until(()=>document.querySelector('[aria-label="账号预览：A-001"]'));const card=document.querySelector('[aria-label="账号预览：A-001"]');
 assert.match(card.textContent,/AWM子弹 61 发/);assert.match(card.textContent,/六级甲 0 件/);assert.match(card.textContent,/2\s*天/);assert.match(card.textContent,/微信扫码/);assert.match(card.textContent,/本单租客押金/);assert.match(card.textContent,/¥0\.00/);assert.match(card.textContent,/本单冻结版本/);assert.equal(calls.length,initial);
});

test('order list renders the frozen source label once and keeps missing party numbers explicit', async t => {
 const {root,node,AdminOrderChainView}=await setup(t);
 const frozen={source:'ORDER_VERSION',haff:{code:'haff',quantity:'98080000',unit:'HAFF_BASE'},materials:[{code:'barrett',name:'巴雷特子弹',quantity:'2',unit:'ROUND'}],termDays:'1',termSeconds:'86400',loginMethodText:'QQ扫码'};
 const item={...chainOrder,id:'render-order',displayNo:'RENDER-ORDER',source:{origin:'NATIVE'},frozenAccount:frozen,ownerBusinessNo:null,renterBusinessNo:'RENTER-BIZ'};
 globalThis.fetch=async()=>response(chainPage([item]));
 await act(async()=>root.render(createElement(AdminOrderChainView,chainProps('render-order'))));
 await until(()=>node.textContent.includes('RENDER-ORDER'));
 const row=node.querySelector('.oc-table tbody tr');
 assert.equal(row.textContent.includes('本单冻结：本单冻结：'),false);
 assert.match(row.textContent,/本单冻结：98\.08 M/);
 assert.doesNotMatch(row.textContent,/编号未提供/);
 assert.match(row.textContent,/编号 RENTER-BIZ/);
});

test('order detail separates unformed payment from missing time and sums refund duty from evidence', async t => {
 const {root,node,AdminOrderChainView}=await setup(t);
 const value={...chainOrder,id:'refund-duty',displayNo:'REFUND-DUTY',status:'CANCELLED',source:{origin:'NATIVE'},payment:{state:'RECORDED_UNPAID',recordedAt:null,recordedAmount:null}};
 const money=cents=>({knowledge:'KNOWN',cents,reasonCodes:[]}),unknown=()=>({knowledge:'UNKNOWN',cents:null,reasonCodes:['ORIGINAL_BASIS_UNAVAILABLE']});
 const evidence={schema:'admin-order-settlement-evidence.v1',documentRef:'ORDER:refund-duty',readiness:'READY',posting:{state:'NOT_POSTED',ref:null,postedAt:null},captured:unknown(),ownerNet:unknown(),refundPayable:money('5000'),refunded:unknown(),historicalRefund:unknown(),refundDueAt:null,channel:{state:'UNKNOWN',reference:null},dutyRefs:[],reasonCodes:[]};
 const refundSummary={contractVersion:'admin-order-refund-summary.v1',integration:'INTEGRATED',intents:[],bankArrival:'UNKNOWN',reasonCodes:[]};
 globalThis.fetch=async url=>String(url).includes('readMode=combined')?response({order:value,refundSummary}):String(url).includes('/finance/')?response({document:{ref:'ORDER:refund-duty'},orderSettlement:evidence}):response({});
 await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('refund-duty'),snapshot:{...snapshotFor('refund-duty'),permissions:['order.read','finance.document.read']},objectOnly:true,initialOrderId:value.id})));
 await until(()=>node.textContent.includes('退款记录')&&node.textContent.includes('本单应退责任'));
 const text=node.textContent;
 assert.match(text,/本单应退责任：¥50\.00/);
 assert.match(text,/逐笔退款申请：0 笔/);
 assert.match(text,/银行到账：未核定/);
 const record=node.querySelector('.oc-records').textContent;
 assert.match(record,/未支付/);
 assert.match(record,/未形成支付/);
 assert.equal(record.includes('未支付未支付'),false);
});

test('compact order progress keeps only the furthest key stage while detail keeps the full sequence', async t => {
 const {root,node,AdminOrderChainView}=await setup(t);
 const value={...chainOrder,id:'compact-progress',displayNo:'COMPACT-PROGRESS',status:'COMPLETED',source:{origin:'NATIVE'},payment:{state:'RECORDED_PAID',recordedAt:null,recordedAmount:null},progress:{asOfUtc:'2026-10-25T00:00:00.000000Z',opening:{state:'CONFIRMED',confirmedAtUtc:'2026-10-25T01:00:00.000000Z'},ending:{state:'POSTED',currentVersionNo:1,postedAtUtc:'2026-10-25T02:00:00.000000Z'}}};
 globalThis.fetch=async url=>String(url).includes('readMode=combined')?response({order:value}):response(chainPage([value]));
 await act(async()=>root.render(createElement(AdminOrderChainView,chainProps('compact-progress'))));await until(()=>node.querySelector('.oc-stages-compact'));
 const compact=[...node.querySelectorAll('.oc-table .oc-stages-compact li .oc-stage-name')].map(item=>item.textContent);
 assert.deepEqual(compact,['创建','支付','已过账']);
 assert.match(node.querySelector('.oc-compact-meta').textContent,/已开租 · 已过账/);
 await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('compact-progress-detail'),objectOnly:true,initialOrderId:value.id})));await until(()=>node.textContent.includes('关键费用'));
 const detail=[...node.querySelectorAll('.oc-main-facts>.oc-section:first-child .oc-stage-name')].map(item=>item.textContent);
 assert.deepEqual(detail,['创建','支付','已开租','已过账']);
});


test('unknown payment time does not imply an observed payment occurred', async t => {
 const {root,node,AdminOrderChainView}=await setup(t);
 const value={...chainOrder,id:'unknown-payment-time',displayNo:'UNKNOWN-PAYMENT-TIME',status:'PAID',source:{origin:'NATIVE'},payment:{state:'UNKNOWN',recordedAt:null,recordedAmount:null}};
 globalThis.fetch=async url=>String(url).includes('readMode=combined')?response({order:value}):response({});
 await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('unknown-payment-time'),objectOnly:true,initialOrderId:value.id})));
 await until(()=>node.querySelector('.oc-records'));
 const record=node.querySelector('.oc-records').textContent;
 assert.match(record,/支付事实与时间待核/);assert.equal(record.includes('支付发生时间未记录'),false);
});
