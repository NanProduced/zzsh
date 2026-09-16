import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnTo } from '../src/lib/safe-return.ts';
import { accountReturnTarget, readAccountReturn, rememberAccountReturn } from '../src/lib/account-return.ts';
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
    rememberAccountReturn('account-a', { pathname: '/accounts', search: '?game=delta&q=alpha' });
    rememberAccountReturn('account-b', { pathname: '/accounts', search: '?game=other&q=bravo' });
    assert.equal(readAccountReturn('account-a'), '/accounts?game=delta&q=alpha');
    assert.equal(readAccountReturn('account-b'), '/accounts?game=other&q=bravo');
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

test('favorite failures map to stable user messages and keys stay request-scoped', () => {
  assert.match(favoriteFailureText(new SupplyRequestError(401, null), true), /登录状态已失效/);
  assert.match(favoriteFailureText(new SupplyRequestError(404, null), true), /当前不可收藏/);
  assert.match(favoriteFailureText(new Error('network'), false), /取消收藏未完成/);
  const key = newFavoriteKey();
  assert.match(key, /^fav_[a-z0-9]+$/);
  assert.notEqual(key, newFavoriteKey());
});
