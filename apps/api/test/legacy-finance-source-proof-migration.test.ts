// 离线源码/迁移登记契约；不执行SQL，不替代新装链或旧数据实库兼容验证。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readMigrationFiles} from 'drizzle-orm/migrator';

const folder=resolve('migrations/business');
const sql=readFileSync(resolve(folder,'0108_legacy_finance_source_proof.sql'),'utf8');
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');

test('0108 is one formal truth and keeps the independently accepted SQL body exactly',()=>{
 assert.equal(existsSync(resolve('test/fixtures/legacy-finance-source-proof-forward.sql')),false);
 assert.equal(sha(sql.slice(sql.indexOf('\n')+1)),'65a8231078f4f8dc6041959ce741154fc1bad0019659e968396aa57ea63ae5eb');
 assert.equal(readMigrationFiles({migrationsFolder:folder})[108]!.hash,sha(sql));
});

test('0108 appends a later journal entry without rewriting the 108-entry prefix',()=>{
 const journal=JSON.parse(readFileSync(resolve(folder,'meta/_journal.json'),'utf8'));
 assert.equal(sha(JSON.stringify(journal.entries.slice(0,108))),'336bb0675cd25e91675fe9e4c55bc33ceeaf5e69fb6dceb1dc10a28df6ce7f77');
 assert.equal(journal.entries[108].idx,108);assert.equal(journal.entries[108].tag,'0108_legacy_finance_source_proof');
 assert(journal.entries[108].when>journal.entries[107].when);
});

test('0108 SQL retains old-input early return, safe NULL summary and immutable original records',()=>{
 assert.match(sql,/IF NOT\(i\?'sourceProof'\) THEN[\s\S]*?RETURN NEW;/);
 assert.match(sql,/IF NOT\(i\?'sourceProof'\) THEN RETURN NULL;END IF;/);
 assert.match(sql,/IF r\.basis_id IS NULL THEN RETURN NULL;END IF;/);
 assert(!/^\s*(UPDATE|DELETE|INSERT INTO|TRUNCATE)\s+(?:zzsh_order|zzsh_iam)\./m.test(sql));
});

test('0108 has complete typed constraints, source guards, readonly helper and the old funding validator replacement',()=>{
 assert.match(sql,/IF n<>2 THEN RAISE EXCEPTION 'covered source constraint inventory differs'/);
 for(const name of ['guard_stored_opening_source_proof','legacy_opening_source_proof','guard_withdrawal_return_covered','assert_legacy_duty_funding'])assert(sql.includes('FUNCTION zzsh_order.'+name+'('));
 assert.match(sql,/CREATE TRIGGER stored_opening_source_proof_guard BEFORE INSERT ON zzsh_order\.finance_stored_opening_review/);
 assert.match(sql,/CREATE TRIGGER withdrawal_return_covered_guard BEFORE INSERT ON zzsh_order\.finance_covered_event/);
 assert.match(sql,/LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog/);
 assert(sql.includes("'LEGACY_DISTRIBUTION_EARNING'"));assert(sql.includes("'LEGACY_WITHDRAWAL_RETURN'"));
 assert(!/GRANT\s+SELECT\s+ON.*finance_stored_opening_review/i.test(sql));
 for(const name of ['guard_stored_opening_source_proof','legacy_opening_source_proof','guard_withdrawal_return_covered'])assert(new RegExp('REVOKE ALL ON FUNCTION[^;]*'+name+'[^;]*FROM PUBLIC').test(sql));
});
