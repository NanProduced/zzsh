import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supplyApi, uploadSupplyMedia } from '../src/lib/supply-client.ts';
import { freezeRequest, IdentityPauseGate, isCurrentQuery, mergePageById } from '../src/lib/supply-workspace-guards.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('temporary identity failure pauses a same-user queue without losing its context', async () => {
  let identity = 'user-a';
  let epoch = 7;
  let sends = 0;
  const gate = new IdentityPauseGate();
  gate.markConfirmed();
  gate.startCheck();

  const queued = (async () => {
    if (await gate.wait(() => identity === 'user-a' && epoch === 7)) sends += 1;
  })();
  await tick();
  assert.equal(sends, 0);
  gate.markFailed();
  await tick();
  assert.equal(sends, 0);

  gate.markConfirmed();
  assert.equal(await queued, undefined);
  assert.equal(sends, 1);
});

test('an identity/object change cancels the old queued operation', async () => {
  let identity = 'user-a';
  let epoch = 3;
  let sends = 0;
  const gate = new IdentityPauseGate();
  gate.markConfirmed();
  gate.startCheck();
  const queued = (async () => {
    if (await gate.wait(() => identity === 'user-a' && epoch === 3)) sends += 1;
  })();

  identity = 'user-b';
  epoch += 1;
  gate.cancel();
  await queued;
  assert.equal(sends, 0);
});

test('canceling an object transition leaves a confirmed gate open without focus confirmation', async () => {
  const gate = new IdentityPauseGate();
  gate.markConfirmed();
  gate.cancelWaiters();
  assert.equal(await gate.wait(() => true), true);
});

test('replay uses the frozen request body and idempotency key', async () => {
  const source = { expectedRevision: '4', inventory: [{ itemId: 'haff', quantity: '10000000' }] };
  const request = freezeRequest(source, 'save-key-a');
  source.inventory[0].quantity = '9';
  assert.equal(request.body.inventory[0].quantity, '10000000');
  assert.equal(request.key, 'save-key-a');
  assert.throws(() => { request.body.inventory[0].quantity = '8'; }, TypeError);
});

test('a retried save request sends the same body and key exactly once per attempt', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const body = { title: 'retry', expectedRevision: '4', inventory: [{ itemId: 'haff', quantity: '10000000' }] };
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      if (calls.length === 1) throw new Error('connection closed after request');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await assert.rejects(() => supplyApi.saveDraft('account-a', body, 'save-key-a'), (error) => error.status === 0);
    await supplyApi.saveDraft('account-a', body, 'save-key-a');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.body, calls[1].init.body);
    assert.equal(new Headers(calls[0].init.headers).get('idempotency-key'), 'save-key-a');
    assert.equal(new Headers(calls[1].init.headers).get('idempotency-key'), 'save-key-a');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('media bytes wait for identity recovery after an upload intent', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const gate = new IdentityPauseGate();
  let identity = 'user-a';
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      if (String(input).endsWith('/media/upload-intents')) {
        gate.startCheck();
        return new Response(JSON.stringify({ intentId: 'intent-a', uploadToken: 'token-a' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ assetId: 'asset-a', purpose: 'ACCOUNT_DISPLAY', reviewState: 'PENDING' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const upload = uploadSupplyMedia({ gameId: 'game-a', accountId: 'account-a', purpose: 'ACCOUNT_DISPLAY', file: new Blob(['pixels'], { type: 'image/png' }), intentKey: 'intent-key-a', uploadKey: 'upload-key-a', beforeBytesUpload: () => gate.wait(() => identity === 'user-a') });
    await tick();
    assert.equal(calls.length, 1);
    gate.markConfirmed();
    assert.equal((await upload)?.assetId, 'asset-a');
    assert.equal(calls.length, 2);
    assert.match(calls[1].input, /\/media\/uploads\/intent-a$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('media bytes are not sent after the identity/object context is canceled', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const gate = new IdentityPauseGate();
  let current = true;
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      gate.startCheck();
      current = false;
      gate.cancelWaiters();
      return new Response(JSON.stringify({ intentId: 'intent-canceled', uploadToken: 'token-canceled' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await uploadSupplyMedia({ gameId: 'game-a', accountId: 'account-a', purpose: 'ACCOUNT_DISPLAY', file: new Blob(['pixels'], { type: 'image/png' }), intentKey: 'intent-key-canceled', uploadKey: 'upload-key-canceled', beforeBytesUpload: () => gate.wait(() => current) });
    assert.equal(result, null);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reverse query results are rejected and cursor pages merge without duplicates', () => {
  const first = { id: 1, key: 'game-a:category-a' };
  const second = { id: 2, key: 'game-a:category-b' };
  assert.equal(isCurrentQuery(first, second.id, second.key), false);
  assert.equal(isCurrentQuery(second, second.id, second.key), true);

  const firstPage = Array.from({ length: 50 }, (_, id) => ({ id: String(id), title: `row-${id}` }));
  const merged = mergePageById(firstPage, [{ id: '49', title: 'updated-row-49' }, { id: '50', title: 'row-50' }]);
  assert.equal(merged.length, 51);
  assert.equal(merged.find((row) => row.id === '49')?.title, 'updated-row-49');
});
