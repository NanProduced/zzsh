import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSearchHref, exactAccountLookupQuery } from '../src/lib/account-search.ts';

test('number-shaped searches stay on exact lookup while ordinary text remains a keyword query', () => {
  for (const value of ['AC0000000001', 'ＡＣ0000000001', 'AC123', '0000123', 'account_c6c6a7af', 'ac0000000001']) {
    assert.equal(exactAccountLookupQuery(value), value.normalize('NFKC'));
  }
  for (const value of ['三角洲账号', '60M 哈夫币', 'AC 0000000001', '[账号]', '咖啡']) {
    assert.equal(exactAccountLookupQuery(value), null);
  }
  assert.equal(exactAccountLookupQuery('  '), null);
});

test('all header entries navigate to the same normalized market URL', () => {
  assert.equal(accountSearchHref('  ＡＣ0000000001  '), '/accounts?q=AC0000000001');
  assert.equal(accountSearchHref('  60M   哈夫币  '), `/accounts?q=${encodeURIComponent('60M 哈夫币')}`);
  assert.equal(accountSearchHref('  '), '/accounts');
});
