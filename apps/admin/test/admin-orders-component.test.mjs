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
  await act(async () => {
    if(field.tagName === 'SELECT') { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); }
    else { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); }
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
  assert(node.textContent.includes('押 ¥0.00')); assert(!node.textContent.includes('加载更多'));
  assert(node.textContent.includes('当前进度') && node.textContent.includes('费用'));
  assert(!node.textContent.includes('需付金额') && !node.textContent.includes('订单状态 / 已知事实'), 'cancelled rows no longer look like a payment request');
  globalThis.fetch = async () => response({ order:chainOrder });
  await act(async () => root.render(createElement(AdminOrderChainView, {...chainProps('chain-detail'), objectOnly:true, initialOrderId:chainOrder.id})));
  await until(() => node.textContent.includes('关键费用'));
  assert(node.textContent.includes('支付时间待确认')); assert(node.textContent.includes('未知')); assert(node.textContent.includes('¥0.00'));
});

test('numbered lookup, later pages and invalid dates retain the executed query and expose a correct current page', async t => {
  const {browser,root,node,AdminOrderChainView} = await setup(t); const calls=[],changed=[];
  globalThis.fetch = async url => { calls.push(new URL(String(url),browser.location.href)); return response(chainPage([chainOrder],{total:200})); };
  await act(async () => root.render(createElement(AdminOrderChainView,{...chainProps('chain-pages'),onQueryChange:q=>changed.push(q)})));
  await until(() => node.textContent.includes(chainOrder.displayNo));
  await changeField(browser,node,'查找方式','party'); await changeField(browser,node,'查找线索','测试用户线索');
  await act(async () => node.querySelector('.oc-search').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await until(() => calls.at(-1).searchParams.get('qValue')==='测试用户线索' && node.textContent.includes(chainOrder.displayNo));
  assert.equal(calls.at(-1).searchParams.get('qKind'),'party'); assert.deepEqual(changed,[]); assert.equal(browser.location.search,'');
  await changeField(browser,node,'跳至页码','9');
  await act(async () => node.querySelector('.oc-pagination form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await until(() => calls.at(-1).searchParams.get('page')==='9' && node.querySelector('[aria-label="第 9 页"][aria-current="page"]'));
  const count=calls.length;
  await changeField(browser,node,'下单起始','2026-10-02T00:00');await changeField(browser,node,'下单截止','2026-10-01T00:00');
  await act(async () => node.querySelector('.oc-search').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(calls.length,count);assert(node.textContent.includes('请修正后查询'));assert.equal(node.querySelector('[aria-label="下单截止"]').getAttribute('aria-invalid'),'true');
  assert.equal(buttonNamed(node,'重试'),undefined);assert(node.textContent.includes(chainOrder.displayNo));
  await changeField(browser,node,'下单起始','2026-09-30T00:00');
  await act(async () => node.querySelector('.oc-search').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await until(() => calls.length>count&&node.textContent.includes(chainOrder.displayNo));
  assert.equal(calls.at(-1).searchParams.get('page'),'1');assert.equal(node.querySelector('#oc-date-error'),null);
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

test('resource read uses human labels and returns to the exact originating user section and order', async t => {
  const {root,node,AdminResourceReadView}=await setup(t);const opened=[];
  globalThis.fetch=async()=>response({account:{accountId:'account-1',displayNo:'A-001',gameName:'测试游戏',ownerUserId:'current-owner',ownerName:'当前号主',lifecycle:'ACTIVE',legacyHold:'NONE',versionState:'DRAFT',ownerPaused:false,staffRestricted:false}});
  await act(async()=>root.render(createElement(AdminResourceReadView,{snapshot:snapshotFor('chain-resource'),accountId:'account-1',fromUserId:'source-user',fromUserSection:'resources',fromOrderId:'source-order',onOpenPath:(p)=>opened.push(p),refreshNonce:0})));
  await until(()=>node.textContent.includes('资源核对'));assert(node.textContent.includes('有效'));assert(node.textContent.includes('未发布'));assert(!node.textContent.includes('ACTIVE'));assert(!node.textContent.includes('DRAFT'));
  await act(async()=>buttonNamed(node,'返回来源用户').click());assert.equal(opened.at(-1),'/users/source-user?section=resources&fromOrderId=source-order');
  await act(async()=>buttonNamed(node,'返回来源订单').click());assert.equal(opened.at(-1),'/orders/source-order');
});

test('order account labels distinguish legacy source numbers in lists, detail and related resource tabs', async t => {
  const {root,node,AdminOrderChainView,AdminResourceReadView}=await setup(t),opened=[];
  const cases=[
    {value:'0000123',expected:'旧来源号 0000123'},
    {value:'ZZ20261018000001',expected:'账号 ZZ20261018000001',origin:'NATIVE'},
    {value:'AC9000000000002',expected:'账号 AC9000000000002'},
    {value:null,expected:'账号编号待核'},
    {value:'not-a-canonical-number',expected:'账号编号待核'},
  ];
  const items=cases.map((c,i)=>({...chainOrder,id:'number-'+i,displayNo:'ORDER-NUMBER-'+i,accountDisplayNo:c.value,source:{origin:c.origin??'LEGACY'}}));
  const props={...chainProps('number-list'),snapshot:{...snapshotFor('number-list'),permissions:['order.read','user.directory.read','supply.rental_account.read']},onOpenPath:(path,title)=>opened.push({path,title})};
  globalThis.fetch=async()=>response(chainPage(items,{total:items.length}));
  await act(async()=>root.render(createElement(AdminOrderChainView,props)));await until(()=>node.querySelectorAll('.oc-table tbody tr').length===items.length);
  cases.forEach((c,i)=>assert(node.querySelectorAll('.oc-table tbody tr')[i].textContent.includes(c.expected.replace(/^账号 /, '')),c.expected));
  assert.deepEqual([...node.querySelectorAll('.oc-table tbody tr')[0].querySelectorAll('.oc-party-role')].map(e=>e.textContent),['历史租客','历史号主']);
  assert.deepEqual([...node.querySelectorAll('.oc-table tbody tr')[1].querySelectorAll('.oc-party-role')].map(e=>e.textContent),['租客','号主']);
  assert.equal(node.querySelector('.oc-table').textContent.includes('账号 0000123'),false);
  await act(async()=>[...node.querySelectorAll('.oc-table tbody tr button')].find(b=>b.textContent===cases[0].expected).click());
  assert.equal(opened.at(-1).title,cases[0].expected);assert(opened.at(-1).path.includes('/supply/accounts/'));
  globalThis.fetch=async()=>response({order:items[0]});
  await act(async()=>root.render(createElement(AdminOrderChainView,{...props,objectOnly:true,initialOrderId:items[0].id})));await until(()=>node.textContent.includes('本单账号和双方'));
  assert(node.querySelector('.oc-heading p').textContent.includes(cases[0].expected));
  const resourceLink=[...node.querySelectorAll('.oc-related button')].find(b=>b.textContent===cases[0].expected);assert(resourceLink);
  await act(async()=>resourceLink.click());assert.equal(opened.at(-1).title,cases[0].expected);
  globalThis.fetch=async()=>response({account:{accountId:'account-1',displayNo:cases[0].value,ownerName:'当前号主',lifecycle:'ACTIVE',legacyHold:'NONE',versionState:'DRAFT'}});
  await act(async()=>root.render(createElement(AdminResourceReadView,{snapshot:props.snapshot,accountId:'account-1',onOpenPath:()=>{},refreshNonce:0})));await until(()=>node.querySelector('h1')?.textContent===cases[0].expected);
});

test('order party history labels follow order origin for both renter and owner', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  for(const origin of ['LEGACY','NATIVE']){
    const item={...chainOrder,id:'party-'+origin,displayNo:'ORDER-PARTY-'+origin,source:{origin}};
    globalThis.fetch=async url=>String(url).includes('readMode=combined')?response({order:item}):response({error:{code:'NOT_FOUND'}},404);
    await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('party-'+origin),objectOnly:true,initialOrderId:item.id})));await until(()=>node.textContent.includes(item.displayNo)&&node.textContent.includes('本单账号和双方'));
    const labels=[...node.querySelectorAll('.oc-related-person small')].map(e=>e.textContent),prefix=origin==='LEGACY'?'历史':'';
    assert(labels.includes(prefix+'租客 · 编号 U-RENTER'));assert(labels.includes(prefix+'号主 · 编号 U-OWNER'));
    if(origin==='NATIVE')assert(labels.every(label=>!label.includes('历史租客')&&!label.includes('历史号主')));
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
  const fee=node.querySelector('.oc-table td.oc-amount small').textContent;
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
});

test('FLOW02 visual: progress timestamps use the same display formatter as order dates', async t => {
  const {root,node,AdminOrderChainView}=await setup(t);
  const instant='2026-10-25T01:02:03.000000Z';
  const value={...chainOrder,status:'COMPLETED',source:{origin:'NATIVE'},createdAt:instant,progress:{asOfUtc:instant,opening:{state:'CONFIRMED',confirmedAtUtc:instant},ending:{state:'POSTED',currentVersionNo:1,postedAtUtc:instant}}};
  globalThis.fetch=async()=>response({order:value});
  await act(async()=>root.render(createElement(AdminOrderChainView,{...chainProps('visual-dates'),objectOnly:true,initialOrderId:value.id})));
  await until(()=>node.textContent.includes('过账时间'));
  const expected=new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(instant));
  assert(node.querySelector('.oc-stages').textContent.includes('过账时间 '+expected));
  assert(node.querySelector('.oc-stages').textContent.includes('开租时间 '+expected));
  assert(!node.querySelector('.oc-stages').textContent.includes(instant));
});
