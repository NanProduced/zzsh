import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { setup, snap, context, json, settle, manager, input, operations } from './distribution-ops-fixture.mjs';

const initialRead = { knowledge: 'UNKNOWN', policy: null, reason: 'POLICY_NOT_CONFIGURED', scope: 'NATIVE', changeContext: context, semanticsVersion: 'distribution-policy.lifecycle.v2' };
const draft = { enabled: true, renter: '3.50', owner: '2', minimumAccrualCents: '1', settlementDelayDays: '7', accountModes: ['ordinary', 'custom'], reason: '正式分销首版配置' };
const rateField = "[aria-label='首版推荐租客奖励比例']";
const fill = async (h, host) => {
  for (const [label, value] of [['首版推荐租客奖励比例', draft.renter], ['首版推荐号主奖励比例', draft.owner], ['首版最低计提分', draft.minimumAccrualCents], ['首版结算等待天数', draft.settlementDelayDays], ['首版政策原因', draft.reason]]) {
    await input(h.browser, host.querySelector(`[aria-label='${label}']`), value);
  }
};
const raiseSubmit = async (h, host) => { await act(async () => { host.querySelector('form').dispatchEvent(new h.browser.Event('submit', { bubbles: true, cancelable: true })); }); await settle(); };

test('initial policy model has no default rates and normalizes the exact first version', async () => {
  const h = await setup();
  try {
    const m = await h.loader.ssrLoadModule('/src/views/distribution-policy-model.ts');
    assert.throws(() => m.buildInitialDistributionPolicyPayload({ ...draft, renter: '', owner: '' }), /请输入0至100之间的精确百分比/);
    assert.throws(() => m.buildInitialDistributionPolicyPayload({ ...draft, minimumAccrualCents: '' }), /请完整填写首版政策的金额、方式、期限和原因/);
    assert.throws(() => m.buildInitialDistributionPolicyPayload({ ...draft, accountModes: [] }), /请完整填写首版政策的金额、方式、期限和原因/);
    assert.throws(() => m.buildInitialDistributionPolicyPayload({ ...draft, renter: '60', owner: '60' }), /合计不能超过100%/);
    assert.throws(() => m.buildInitialDistributionPolicyPayload({ ...draft, reason: '短' }), /请完整填写首版政策的金额、方式、期限和原因/);
    assert.deepEqual(m.buildInitialDistributionPolicyPayload(draft), { schema: 'distribution-policy-initialize.v1', config: { enabled: true, accountModes: ['ordinary', 'custom'], minimumAccrualCents: '1', settlementDelayDays: 7, renterPercent: '3.5', ownerPercent: '2' }, reason: '正式分销首版配置' });
    const payload = m.buildInitialDistributionPolicyPayload(draft);
    assert.equal(m.sameDistributionProposal(payload, JSON.parse(JSON.stringify(payload))), true);
    assert.equal(m.sameDistributionProposal(payload, { ...payload, config: { ...payload.config, renterPercent: '4' } }), false);
    assert.equal(m.sameDistributionProposal(payload, { schema: 'distribution-policy-change.v1', reason: payload.reason }), false);
    assert.equal(m.parseDistributionPolicyRead(initialRead).scope, 'NATIVE');
  } finally { await h.close(); }
});

test('first-version form blocks submission until every economic field is explicit', async () => {
  const h = await setup(); const submitted = [];
  try {
    const m = await h.loader.ssrLoadModule('/src/views/distribution-initial-policy-form.tsx');
    const v = await h.mount((p) => createElement(m.DistributionInitialPolicyForm, p), { canSubmit: true, busy: false, onSubmit: (p) => submitted.push(p) });
    assert.equal(v.host.querySelector(rateField).value, '');
    assert.match(v.host.textContent, /不从旧等级|不采用默认比例/);
    const submit = [...v.host.querySelectorAll('button')].find(b => b.textContent.includes('提交首版审批'));
    assert.equal(submit.disabled, true);
    await raiseSubmit(h, v.host);
    assert.equal(submitted.length, 0);
    await fill(h, v.host);
    assert.equal(submit.disabled, false);
    await raiseSubmit(h, v.host);
    assert.deepEqual(submitted.map(p => p.schema), ['distribution-policy-initialize.v1']);
    assert.equal(submitted[0].config.renterPercent, '3.5');
  } finally { await h.close(); }
});

test('no-head policy offers the first-version form only to a manager and stays GET-only', async () => {
  const h = await setup(); const calls = [];
  try {
    const m = await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx');
    globalThis.fetch = h.browser.fetch = async (url, init = {}) => {
      const path = String(url); calls.push({ path, method: init.method ?? 'GET' });
      return json(path.endsWith('/operations') ? operations : initialRead);
    };
    let v = await h.mount((p) => createElement(m.DistributionPolicyPanel, p), { snapshot: snap(['personal.distribution.policy.read']) });
    assert.equal(v.host.querySelector(rateField), null);
    assert.match(v.host.textContent, /不能发起首版政策/);
    await act(async () => v.root.unmount());
    v = await h.mount((p) => createElement(m.DistributionPolicyPanel, p), { snapshot: snap(manager) });
    assert.ok(v.host.querySelector(rateField));
    assert.deepEqual([...new Set(calls.map(c => c.method))], ['GET']);
  } finally { await h.close(); }
});

test('first-version submission uses the approval envelope and never writes the policy head directly', async () => {
  const h = await setup(); const posts = []; const reads = [];
  try {
    const m = await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx');
    globalThis.fetch = h.browser.fetch = async (url, init = {}) => {
      const path = String(url), method = init.method ?? 'GET';
      if (method === 'POST') { posts.push({ path, key: init.headers?.['idempotency-key'], body: JSON.parse(String(init.body)) }); return json({ approvalRequestId: 'approval_1' }); }
      reads.push({ path, method });
      if (path.endsWith('/operations')) return json(operations);
      if (path.includes('/requests/detail')) return json({ requestId: 'approval_1', operation: { code: 'distribution.policy.publish', payload: posts[0]?.payload ?? {} } });
      return json(initialRead);
    };
    const v = await h.mount((p) => createElement(m.DistributionPolicyPanel, p), { snapshot: snap(manager) });
    await fill(h, v.host);
    assert.equal([...v.host.querySelectorAll('button')].find(b => b.textContent.includes('提交首版审批')).disabled, false);
    await raiseSubmit(h, v.host);
    assert.equal(posts.length, 1);
    assert.match(posts[0].path, /\/security\/approvals\/requests$/);
    assert.equal(posts[0].body.operationCode, 'distribution.policy.publish');
    assert.equal(posts[0].body.summary, '初始化全站分销政策');
    assert.equal(posts[0].body.payload.schema, 'distribution-policy-initialize.v1');
    assert.equal(posts[0].body.payload.config.ownerPercent, '2');
    assert.match(posts[0].key, /^idem_/);
    assert.deepEqual([...new Set(reads.map(r => r.method))], ['GET']);
  } finally { await h.close(); }
});
