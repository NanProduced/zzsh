import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAccounts } from '../src/lib/account-search.ts';

test('loaded-account search handles names, IDs, normalization and literal input', () => {
  const accounts = [{ id:'DELTA-A', title:'三角洲 资源账号' }, { id:'delta-b', title:'特殊 [账号]' }];
  assert.equal(searchAccounts(accounts, '  '), accounts);
  assert.deepEqual(searchAccounts(accounts, 'ｄｅｌｔａ－Ａ 三角洲'), [accounts[0]]);
  assert.deepEqual(searchAccounts(accounts, '[账号]'), [accounts[1]]);
  assert.deepEqual(searchAccounts(accounts, '三角洲 不存在'), []);
  assert.deepEqual(searchAccounts([], 'DELTA-A'), []);
});
