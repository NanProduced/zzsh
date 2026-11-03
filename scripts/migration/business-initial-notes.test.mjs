import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateDump, navigationMarkdown } from './business-initial-notes.mjs';

const notes = {
  tables: [{ schema: 'zzsh_order', name: 'rental_order', columns: [{ name: 'amount_cents', type: 'bigint' }, { name: 'status', type: 'text' }, { name: 'ratio', type: 'numeric' }], primaryKey: ['id'], foreignKeys: ['FOREIGN KEY (account_id) REFERENCES zzsh_supply.rental_account(id)'] }],
  functions: [{ schema: 'zzsh_order', name: 'guard_wallet', args: '', volatile: 'v', definer: false }],
  triggers: [{ schema: 'zzsh_order', table: 'rental_order', name: 'guard_row', functionSchema: 'zzsh_order', functionName: 'guard_wallet' }],
  indexes: [{ schema: 'zzsh_order', table: 'rental_order', name: 'rental_order_pkey' }],
};
const sql = [
  'CREATE TABLE zzsh_order.rental_order (',
  '    id text',
  ');',
  'CREATE FUNCTION zzsh_order.guard_wallet() RETURNS trigger',
  '    LANGUAGE plpgsql',
  'AS $fn$ BEGIN END $fn$;',
  'CREATE TRIGGER guard_row BEFORE UPDATE ON zzsh_order.rental_order FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_wallet();',
  '',
].join('\n');

test('notes describe money, keys and guards without changing statements', () => {
  const annotated = annotateDump(sql, notes);
  assert.equal(annotated.split('\n').filter(line => !line.startsWith('--')).join('\n'), sql);
  assert.match(annotated, /金额列，单位CNY整数分：amount_cents\(bigint\)/);
  assert.match(annotated, /外键：FOREIGN KEY \(account_id\) REFERENCES zzsh_supply\.rental_account\(id\)/);
  assert.match(annotated, /函数 zzsh_order\.guard_wallet\(\)：写入守卫/);
  assert.match(annotated, /触发器 guard_row ON zzsh_order\.rental_order/);
  const navigation = navigationMarkdown('release_0151', notes, annotated);
  assert.match(navigation, /01-structure\.sql:\d+/);
  assert.match(navigation, /rental_order_pkey/);
});
