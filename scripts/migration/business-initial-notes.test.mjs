import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { annotateDump, commentForTable, navigationMarkdown } from './business-initial-notes.mjs';

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

test('annotation leaves dollar-quoted function bodies byte-for-byte unchanged', () => {
  const body = ['    AS $body$', 'CREATE TABLE zzsh_order.rental_order (id text);', 'CREATE TRIGGER guard_row BEFORE UPDATE ON zzsh_order.rental_order EXECUTE FUNCTION zzsh_order.guard_wallet();', '$body$;'].join('\n');
  const definition = 'CREATE FUNCTION zzsh_order.guard_wallet() RETURNS trigger\n' + body;
  const annotated = annotateDump(definition, notes);
  assert.equal(annotated.slice(annotated.indexOf('CREATE FUNCTION')), definition);
});

test('multiline catalog CHECK text remains line comments', () => {
  const table = { ...notes.tables[0], checks:[{name:'multiline',def:"CHECK (status <> 'a\nb')"}] };
  const comments = commentForTable(table).join('\n');
  assert.match(comments,/CHECK multiline：CHECK \(status <> 'a\n-- b'\)/);
  assert.ok(comments.split('\n').every(line=>line.startsWith('--')));
});

test('every canonical table has its own Chinese purpose rather than only a schema fallback', () => {
  const folder = new URL('../../apps/api/migrations/business/', import.meta.url);
  for (const file of readdirSync(folder).filter(file => file.endsWith('.sql'))) {
    const sql = readFileSync(new URL(file, folder), 'utf8');
    for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([^\s(]+)/ig)) {
      const [schema, name] = match[1].replaceAll('"', '').split('.');
      const comment = commentForTable({ schema, name, columns: [], primaryKey: [], foreignKeys: [] })[0];
      assert.doesNotMatch(comment, /当前业务行|身份、权限或审批对象|供给目录或出租账号对象|订单、履约或资金相邻对象|旧平台来源事实或只读快照/, `${schema}.${name}`);
    }
  }
});

test('navigation matches the complete table name and quoted auth names', () => {
  const tables = ['rental_order', 'rental_order_extra'].map(name => ({ ...notes.tables[0], name }));
  const navigation = navigationMarkdown('release_0151', { ...notes, tables }, 'CREATE TABLE zzsh_order.rental_order_extra (\n);\nCREATE TABLE zzsh_order.rental_order (');
  assert.match(navigation, /### zzsh_order.rental_order\n[\s\S]*?最终定义：01-structure.sql:3/);
});

test('generation requires a fresh nonce before reading any secret or connecting', () => {
  const env = { ...process.env, DB_PASSWORD_FILE: 'must-not-be-read' }; delete env.ZZSH_REGRESSION_RUN;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./build-business-initial.mjs', import.meta.url)), '--execute', '--oid', '1', '--baseline', 'release_nonce_negative', '--source-count', '152'], { env, encoding:'utf8', timeout:5000 });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /REGRESSION_NONCE_REQUIRED/); assert.doesNotMatch(result.stderr, /ENOENT|ECONN/);
});

test('production export rejects the protected regression database and any unregistered name shape before reading credentials', () => {
  const env = { ...process.env, DB_PASSWORD_FILE: 'must-not-be-read', ZZSH_REGRESSION_RUN: 'shape_fixture_nonce' };
  for (const database of ['zzsh_test_regression', 'zzsh_dev_daily']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./build-business-initial.mjs', import.meta.url)), '--execute', '--production', '--source-db', database, '--oid', '1', '--baseline', 'release_scratch_negative', '--source-count', '154'], { env, encoding:'utf8', timeout:5000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /PRODUCTION_INITIAL_SCRATCH_REQUIRED/); assert.doesNotMatch(result.stderr, /ENOENT|ECONN/);
  }
});
