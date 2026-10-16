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
