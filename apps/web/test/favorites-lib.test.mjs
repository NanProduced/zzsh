import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnTo } from '../src/lib/safe-return.ts';
import { accountReturnTarget, consumeAccountReturnSnapshot, readAccountReturn, rememberAccountReturn } from '../src/lib/account-return.ts';
import { favoriteFailureText, newFavoriteKey } from '../src/lib/favorites.ts';
import { SupplyRequestError } from '../src/lib/supply-client.ts';

test('return targets only accept same-site absolute paths', () => {
  assert.equal(safeReturnTo('/accounts?skinId=a'), '/accounts?skinId=a');
  assert.equal(safeReturnTo('  /account?view=favorites '), '/account?view=favorites');
  for (const value of ['//evil.invalid', '/\\evil', 'https://evil.invalid', 'javascript:alert(1)', 'accounts', '', null, 'a'.repeat(513)]) {
    assert.equal(safeReturnTo(value), undefined, String(value));
  }
  assert.deepEqual(accountReturnTarget('/accounts?game=g1'), { href: '/accounts?game=g1', label: '返回账号列表' });
  assert.deepEqual(accountReturnTarget('/'), { href: '/', label: '返回首页' });
  assert.deepEqual(accountReturnTarget('//evil.invalid'), { href: '/accounts', label: '返回账号列表' });
  assert.deepEqual(accountReturnTarget(null), { href: '/accounts', label: '返回账号列表' });
  assert.deepEqual(accountReturnTarget('/publish?mode=fast'), { href: '/accounts', label: '返回账号列表' });
  assert.deepEqual(accountReturnTarget('/accounts?unknown=value'), { href: '/accounts', label: '返回账号列表' });
});

test('account return targets are isolated by account within a browser tab', () => {
  const entries = new Map();
  const storage = {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
    removeItem(key) { entries.delete(key); },
  };
  const hadStorage = Object.hasOwn(globalThis, 'sessionStorage');
  const previous = globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  try {
    const targetA = '/accounts?game=delta&filters=%7B%22skinGroups%22%3A%5B%5D%7D&sort=latest&view=grid';
    const targetB = '/accounts?game=other&q=bravo';
    const snapshotA = { scrollY: 1240, pageCursors: [null, 'cursor_a', 'cursor_b'], filterKey: 'digest-a', viewMode: 'list' };
    rememberAccountReturn('account-a', { pathname: '/accounts', search: '?game=delta&filters=%7B%22skinGroups%22%3A%5B%5D%7D&sort=latest&view=grid' }, snapshotA);
    assert.equal(readAccountReturn('account-a'), targetA);
    assert.deepEqual(consumeAccountReturnSnapshot(targetA, 'digest-a'), snapshotA);
    rememberAccountReturn('account-b', { pathname: '/accounts', search: '?game=other&q=bravo' });
    assert.equal(readAccountReturn('account-b'), targetB);
    assert.equal(readAccountReturn('account-c'), null);
    rememberAccountReturn('account-a', { pathname: '/', search: '' });
    assert.equal(readAccountReturn('account-a'), '/');
    assert.deepEqual(accountReturnTarget(readAccountReturn('account-a')), { href: '/', label: '返回首页' });
    rememberAccountReturn('account-a', { pathname: '/help', search: '' });
    assert.equal(readAccountReturn('account-a'), null);
  } finally {
    if (hadStorage) Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: previous });
    else delete globalThis.sessionStorage;
  }
});

test('account return supports long v2 filter URLs while rejecting unknown routes and queries', () => {
  const entries = new Map();
  const storage = {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
    removeItem(key) { entries.delete(key); },
  };
  const hadStorage = Object.hasOwn(globalThis, 'sessionStorage');
  const previous = globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  try {
    const longFilters = encodeURIComponent(JSON.stringify({ skinGroups: [{ categoryId: 'category_skin', ids: Array.from({ length: 45 }, (_, index) => `skin_${index}`), match: 'ANY' }] }));
    const search = `?game=game_delta&filters=${longFilters}`;
    const snapshotLong = { scrollY: 12, pageCursors: [null], filterKey: 'digest-long', viewMode: 'list' };
    rememberAccountReturn('account-long', { pathname: '/accounts', search }, snapshotLong);
    assert.equal(readAccountReturn('account-long'), '/accounts' + search);
    assert.equal(accountReturnTarget(readAccountReturn('account-long')).href, '/accounts' + search);
    assert.equal(consumeAccountReturnSnapshot('/accounts?game=wrong', 'digest-long'), null);
    assert.deepEqual(consumeAccountReturnSnapshot('/accounts' + search, 'digest-long'), snapshotLong);
    assert.equal(accountReturnTarget('/accounts?unexpected=1').href, '/accounts');
  } finally {
    if (hadStorage) Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: previous });
    else delete globalThis.sessionStorage;
  }
});

test('favorite failures map to stable user messages and keys stay request-scoped', () => {
  assert.match(favoriteFailureText(new SupplyRequestError(401, null), true), /登录状态已失效/);
  assert.match(favoriteFailureText(new SupplyRequestError(404, null), true), /当前不可收藏/);
  assert.match(favoriteFailureText(new Error('network'), false), /取消收藏未完成/);
  const key = newFavoriteKey();
  assert.match(key, /^fav_[a-z0-9]+$/);
  assert.notEqual(key, newFavoriteKey());
});
