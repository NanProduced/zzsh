import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SupplyWriteLockError, withSupplyWriteLock } from '../src/lib/supply-write-lock.ts';

function setNavigator(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator; });
}

function fakeLockManager() {
  const held = new Set();
  return {
    async request(name, options, task) {
      assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
      assert.ok(name.startsWith('zzsh:supply-write:'));
      if (held.has(name)) return task(null);
      held.add(name);
      try { return await task({ name, mode: 'exclusive' }); }
      finally { held.delete(name); }
    },
  };
}

test('unsupported LockManager blocks before the task starts', async t => {
  setNavigator(t, {});
  let called = false;
  await assert.rejects(withSupplyWriteLock('admin-a', async () => { called = true; }), error => error instanceof SupplyWriteLockError && error.code === 'LOCK_UNAVAILABLE' && error.message.includes('操作未发送'));
  assert.equal(called, false);
});

test('same storage slot is exclusive and a busy caller never runs or waits', async t => {
  setNavigator(t, { locks: fakeLockManager() });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const calls = [];
  const first = withSupplyWriteLock('pending:admin-a', async () => { calls.push('first'); started(); await gate; return 'receipt'; });
  await ready;
  await assert.rejects(withSupplyWriteLock('pending:admin-a', async () => { calls.push('second'); }), error => error instanceof SupplyWriteLockError && error.code === 'LOCK_BUSY');
  assert.deepEqual(calls, ['first']);
  release();
  assert.equal(await first, 'receipt');
  assert.equal(await withSupplyWriteLock('pending:admin-a', async () => { calls.push('after'); return 7; }), 7);
  assert.deepEqual(calls, ['first', 'after']);
});

test('separate administrator slots can proceed independently', async t => {
  setNavigator(t, { locks: fakeLockManager() });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const first = withSupplyWriteLock('pending:admin-a', async () => { started(); await gate; return 'a'; });
  await ready;
  assert.equal(await withSupplyWriteLock('pending:admin-b', async () => 'b'), 'b');
  release();
  assert.equal(await first, 'a');
});

test('task rejection stays intact and releases the lock', async t => {
  setNavigator(t, { locks: fakeLockManager() });
  const failure = new Error('original command outcome unknown');
  await assert.rejects(withSupplyWriteLock('pending:admin-a', async () => { throw failure; }), error => error === failure);
  assert.equal(await withSupplyWriteLock('pending:admin-a', async () => 'recheck'), 'recheck');
});

test('platform refusal is distinct from a task failure and never starts the command', async t => {
  setNavigator(t, { locks: { request: async () => { throw new DOMException('Lock denied', 'SecurityError'); } } });
  let called = false;
  await assert.rejects(withSupplyWriteLock('pending:admin-a', async () => { called = true; }), error => error instanceof SupplyWriteLockError && error.code === 'LOCK_UNAVAILABLE');
  assert.equal(called, false);
});

test('an inaccessible navigator lock property also blocks before the command', async t => {
  setNavigator(t, { get locks() { throw new DOMException('Opaque context', 'SecurityError'); } });
  let called = false;
  await assert.rejects(withSupplyWriteLock('pending:admin-a', async () => { called = true; }), error => error instanceof SupplyWriteLockError && error.code === 'LOCK_UNAVAILABLE');
  assert.equal(called, false);
});
