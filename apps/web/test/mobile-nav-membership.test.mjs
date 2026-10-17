import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferred, mountAuthComponent } from './react-auth-harness.mjs';

const known = (tier = 'GOLD', points = '12000') => ({
  subjectId: 'fixture-user',
  growth: {
    schema: 'membership-growth-v1', knowledge: 'KNOWN', sourceState: 'COMPLETE', benefitsState: 'NOT_CONFIGURED',
    asOfUtc: '2026-10-17T00:00:00.000Z', windowStartUtc: '2026-07-19T00:00:00.000Z',
    rollingPoints: points, lifetimePoints: points, normalTier: tier, effectiveTier: tier,
    grace: { state: 'NONE', fromTier: null, until: null, gapPoints: null }, nextExpiryAtUtc: null,
    nextTier: null, benefits: [], comparison: [], contributions: [], pendingCount: 0,
  },
  entitlements: [],
});
const unknown = () => Response.json({ growth: { schema: 'membership-growth-v1', knowledge: 'UNKNOWN' } });
const mount = fetch => mountAuthComponent('apps/web/src/components/layout/mobile-nav.tsx', 'MobileNav', {}, {
  initialStatus: 'authenticated', forceDialogMount: true, authOverlay: { useAuthOverlay: () => ({ open() {} }) }, fetch,
});

test('mobile membership keeps source unknown, forbidden and failed reads separate from an ordinary member', async () => {
  for (const [response, label] of [
    [unknown, '资格待确认'],
    [() => Response.json({}, { status: 403 }), '资格读取受限'],
    [() => Response.json({}, { status: 500 }), '资格暂时无法读取'],
  ]) {
    const view = await mount(response);
    try {
      await view.settle();
      assert.equal(view.host.querySelector('.sheet-user-tier-badge').textContent, label);
      assert.equal(view.host.querySelector('.sheet-user-points'), null);
      assert.doesNotMatch(view.host.querySelector('.sheet-user-card').textContent, /普通会员/);
    } finally { await view.close(); }
  }
});

test('mobile membership hides prior points immediately when the subject or identity version changes', async () => {
  for (const changeSubject of [true, false]) {
    const pending = deferred(); let calls = 0;
    const view = await mount(() => ++calls === 1 ? Response.json(known()) : pending.promise);
    try {
      await view.settle();
      assert.match(view.host.querySelector('.sheet-user-card').textContent, /金卡会员.*12000 积分/s);
      if (changeSubject) view.identity.userId = 'user_B';
      view.identity.identityVersion++;
      await view.render();
      assert.equal(view.host.querySelector('.sheet-user-tier-badge').textContent, '会员读取中…');
      assert.equal(view.host.querySelector('.sheet-user-points'), null);
      pending.resolve(unknown()); await view.settle();
      assert.equal(view.host.querySelector('.sheet-user-tier-badge').textContent, '资格待确认');
    } finally { pending.resolve(unknown()); await view.close(); }
  }
});

test('an aborted old mobile membership response cannot replace the new subject result', async () => {
  const old = deferred(); let calls = 0;
  const view = await mount(() => ++calls === 1 ? old.promise : Response.json(known('SILVER', '1000')));
  try {
    view.identity.userId = 'user_B'; view.identity.identityVersion++;
    await view.render(); await view.settle();
    assert.equal(view.host.querySelector('.sheet-user-tier-badge').textContent, '银卡会员');
    old.resolve(Response.json(known())); await view.settle();
    assert.equal(view.host.querySelector('.sheet-user-tier-badge').textContent, '银卡会员');
    assert.equal(view.host.querySelector('.sheet-user-points').textContent, '1000 积分');
  } finally { old.resolve(unknown()); await view.close(); }
});

test('known ordinary membership with genuine zero points stays visible', async () => {
  const view = await mount(() => Response.json(known('STANDARD', '0')));
  try {
    await view.settle();
    assert.equal(view.host.querySelector('.sheet-user-tier-badge').textContent, '普通会员');
    assert.equal(view.host.querySelector('.sheet-user-points').textContent, '0 积分');
  } finally { await view.close(); }
});
