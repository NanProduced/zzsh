import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnTo } from '../src/lib/safe-return.ts';
import { accountReturnTarget } from '../src/lib/account-return.ts';
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
});

test('favorite failures map to stable user messages and keys stay request-scoped', () => {
  assert.match(favoriteFailureText(new SupplyRequestError(401, null), true), /登录状态已失效/);
  assert.match(favoriteFailureText(new SupplyRequestError(404, null), true), /当前不可收藏/);
  assert.match(favoriteFailureText(new Error('network'), false), /取消收藏未完成/);
  const key = newFavoriteKey();
  assert.match(key, /^fav_[a-z0-9]+$/);
  assert.notEqual(key, newFavoriteKey());
});
