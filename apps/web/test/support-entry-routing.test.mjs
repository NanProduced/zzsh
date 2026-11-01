import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountAuthComponent } from './react-auth-harness.mjs';

// 页面内的客服入口（帮助中心文章页/搜索空态/帮助 404/403 页）都走同一条路：发
// zzsh:open-support 窗口事件，由右侧常驻工具列的 SupportRail 接住——先过登录门，再开窗。
// 客服只有一个容器，没有独立 /support 路由。
const coordinator = 'apps/web/src/components/auth/auth-overlay-provider.tsx';
const rail = { path: 'apps/web/src/components/support/support-rail.tsx', name: 'SupportRail' };
const SUPPORT_ENTRY = '/help/rental-getting-started';

const supportWindow = p => p.host.querySelector('.support-dialog-content');
const authWindow = p => p.host.querySelector('[data-auth-dialog]');

async function settleSession(p, status) {
  await p.React.act(async () => { p.identity.status = status; p.identity.userId = status === 'authenticated' ? 'user_A' : null; });
  await p.render();
}

async function usePageEntry(p, type = 'SERVICE') {
  await p.React.act(async () => {
    p.window.dispatchEvent(new p.window.CustomEvent('zzsh:open-support', { detail: { type } }));
  });
  await p.settle();
}

test('a page-level 联系客服 entry opens the one support window once the shared session has settled', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {}, {
    url: 'http://127.0.0.1:4200' + SUPPORT_ENTRY,
    pathname: SUPPORT_ENTRY,
    child: rail,
    initialStatus: 'loading',
  });
  try {
    // 会话先像真实加载一样停在 loading，再落到 authenticated。监听器必须用当次渲染的触发链；
    // 沿用首帧的那份会把意图挂在“等会话”上，而会话状态此后不再变化，窗口就永远开不出来。
    await settleSession(p, 'authenticated');
    assert.equal(supportWindow(p), null, 'nothing is open before the entry is used');
    await usePageEntry(p);
    assert.ok(supportWindow(p), 'the page entry opens the rail support window');
    assert.equal(authWindow(p), null, 'a confirmed session is not asked to sign in again');
  } finally { await p.close(); }
});

test('a complaint entry reaches the same window and a guest still passes the login gate first', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {}, {
    url: 'http://127.0.0.1:4200/access-denied',
    pathname: '/access-denied',
    child: rail,
    initialStatus: 'loading',
  });
  try {
    await settleSession(p, 'guest');
    await usePageEntry(p, 'COMPLAINT');
    assert.ok(authWindow(p), 'a guest is taken through the shared login gate, not straight into the window');
    assert.equal(supportWindow(p), null, 'no support window before the gate is passed');

    // 过门之后的开窗由“表单内确认成功”触发（AuthForm 的 onSuccess -> finish -> 意图回调），
    // 这条路径在 auth-entry-behavior.test.mjs 里直接调用回调覆盖；跨标签页代登录则按认证协调器
    // 现有设计只对 leaveOnCancel 意图生效，公共页面上的意图仍旧等本页表单确认，这里不断言那一条。
    await settleSession(p, 'authenticated');
    assert.equal(supportWindow(p), null, 'an out-of-band sign-in does not silently finish a public-page intent');
    assert.ok(authWindow(p), 'the gate stays open for the visitor to confirm in this tab');
  } finally { await p.close(); }
});

// W4：入口未读。客服窗口要用户点开才挂载，未读如果只活在窗口里，用户不点开就永远看不见
// 客服回复和订单群消息。角标挂在常驻入口上，数据只从服务端事实来。
function railFetch(consultations = [], orders = []) {
  return (url) => {
    const path = String(url);
    if (path.startsWith('/api/im/consultations')) return Response.json({ consultations });
    if (path.startsWith('/api/orders/')) return Response.json({ items: orders, nextCursor: null });
    return Response.json({ status: true });
  };
}

async function until(p, predicate, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await p.settle();
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

const entryButton = p => p.host.querySelector('.rail-item[data-support-trigger]');
const entryBadge = p => p.host.querySelector('.rail-item .rail-unread');
const unreadCalls = p => p.calls.filter(call => String(call.url).includes('/api/im/consultations')).length;

test('the closed rail badges the entry with combined consultation and order-group unread', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {}, {
    url: 'http://127.0.0.1:4200/',
    pathname: '/',
    child: rail,
    // Dialog.Root 在测试桩里只在 open 时渲染子节点；入口按钮就长在它下面，所以强制挂载。
    forceDialogMount: true,
    initialStatus: 'authenticated',
    fetch: railFetch(
      [{ id: 'round-1', threadId: 'thread-1', hasUnread: true, userUnreadCount: 2 }],
      // 目录只保留真的建过群的订单（readSupportOrders 用 fulfillmentAssignment 判断），草稿/未付款不是会话。
      [{ id: 'order-1', status: 'PAID', unreadCount: 3, fulfillmentAssignment: { state: 'ASSIGNED', teamState: 'READY' } },
       { id: 'draft-1', status: 'DRAFT', unreadCount: 9, fulfillmentAssignment: { state: 'WAITING', teamState: null } }],
    ),
  });
  try {
    await until(p, () => entryBadge(p), 'the entry badge appears without opening the window');
    assert.equal(entryBadge(p).textContent, '5', '2 条客服 + 3 条订单群；草稿订单不是会话');
    assert.equal(entryBadge(p).getAttribute('data-kind'), 'count');
    assert.equal(entryBadge(p).getAttribute('aria-hidden'), 'true', '角标本身是装饰，读屏听可访问名字');
    assert.equal(entryButton(p).getAttribute('aria-label'), '联系客服，5 条未读消息');
    assert.equal(entryButton(p).getAttribute('data-unread'), 'true');
    assert.ok(unreadCalls(p) > 0, 'the closed window still asks the directory');
  } finally { await p.close(); }
});

test('an unread the server cannot count stays a dot and a muted thread never badges the entry', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {}, {
    url: 'http://127.0.0.1:4200/',
    pathname: '/',
    child: rail,
    // Dialog.Root 在测试桩里只在 open 时渲染子节点；入口按钮就长在它下面，所以强制挂载。
    forceDialogMount: true,
    initialStatus: 'authenticated',
    fetch: railFetch([{ id: 'round-1', threadId: 'thread-1', hasUnread: true, userUnreadCount: 0 }], []),
  });
  try {
    await until(p, () => entryBadge(p), 'unknown-count badge appears');
    assert.equal(entryBadge(p).getAttribute('data-kind'), 'dot', '没有条数只给圆点，不编数字');
    assert.equal(entryBadge(p).textContent, '');
    assert.equal(entryButton(p).getAttribute('aria-label'), '联系客服，有新消息');

    // 免打扰是窗口里的既有语义（BellOff）；入口再闪数字会自相矛盾，所以把这条线程标成静音后角标要撤下。
    p.window.localStorage.setItem('zzsh.support.directory-prefs.user_A:1', JSON.stringify({ 'consultation:thread-1': { pinned: false, muted: true } }));
    await p.React.act(async () => { p.window.document.dispatchEvent(new p.window.Event('visibilitychange')); });
    await until(p, () => !entryBadge(p), 'muting the thread clears the entry badge');
    assert.equal(entryButton(p).getAttribute('aria-label'), '联系客服');
  } finally { await p.close(); }
});

test('a guest rail never asks the directory for unread counts', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {}, {
    url: 'http://127.0.0.1:4200/',
    pathname: '/',
    child: rail,
    forceDialogMount: true,
    initialStatus: 'guest',
    fetch: railFetch([{ id: 'round-1', hasUnread: true, userUnreadCount: 4 }], [{ id: 'order-1', status: 'PAID', unreadCount: 2 }]),
  });
  try {
    await p.settle();
    await p.settle();
    assert.equal(unreadCalls(p), 0, 'no session, no read: the rail must not probe another identity');
    assert.equal(entryBadge(p), null);
    assert.equal(entryButton(p).getAttribute('aria-label'), '联系客服');
  } finally { await p.close(); }
});

test('the rail never navigates to a support route of its own', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {}, {
    url: 'http://127.0.0.1:4200/help',
    pathname: '/help',
    child: rail,
    initialStatus: 'authenticated',
  });
  try {
    await usePageEntry(p);
    assert.ok(supportWindow(p), 'the window opens in place');
    assert.deepEqual(p.router.pushes, [], 'opening the window must not push a route');
    assert.deepEqual(p.router.replaces, [], 'opening the window must not replace a route');
  } finally { await p.close(); }
});

test('the rail complaint button preserves its intent while using the shared support window',async()=>{
  const p=await mountAuthComponent(coordinator,'AuthOverlayProvider',{}, {url:'http://127.0.0.1:4200/help',pathname:'/help',child:rail,initialStatus:'authenticated',forceDialogMount:true});
  try{
    const complaint=[...p.host.querySelectorAll('button')].find(button=>button.textContent==='投诉建议');assert.ok(complaint);
    await p.React.act(async()=>complaint.click());await p.settle();
    assert.equal(p.host.querySelector('[data-support-entry-type]')?.getAttribute('data-support-entry-type'),'COMPLAINT');
  }finally{await p.close();}
});
