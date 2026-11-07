import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { INITIAL_SEED_TABLES, assertInitialSingleton, assertInitialMigrationHistory } from './business-initial-seeds.mjs';

test('only static seed tables are allowed, never migrated users, orders or guarantees', () => {
  for (const name of ['zzsh_order.settlement_refund_policy','zzsh_order.legacy_duty_finance_contract']) assert(INITIAL_SEED_TABLES.has(name));
  for (const name of ['zzsh_auth_admin.user','zzsh_auth_user.user','zzsh_order.rental_order','zzsh_order.publisher_bail_requirement']) assert(!INITIAL_SEED_TABLES.has(name));
});

test('fresh refund waiting policy is exactly 0/7 days with no operator', () => {
  const name='zzsh_order.settlement_refund_policy', row={singleton:true,normal_days:0,early_days:7,revision:'1',updated_by_admin_id:null};
  assert.doesNotThrow(()=>assertInitialSingleton(name,[row],true));
  for (const changed of [{...row,normal_days:1},{...row,early_days:0},{...row,revision:'2'},{...row,updated_by_admin_id:'admin_fixture'},null])
    assert.throws(()=>assertInitialSingleton(name,changed?[changed]:[],true),/REFUND_POLICY_MUST_BE_CANONICAL_DEFAULT/);
  assert.throws(()=>assertInitialSingleton(name,[row,row],true),/REFUND_POLICY_MUST_BE_CANONICAL_DEFAULT/);
});

test('runtime legacy finance contract is bound exactly and older canonical chains stay empty', () => {
  const name='zzsh_order.legacy_duty_finance_contract',ref='runtime:legacy-finance-duty:v1';
  const row={singleton:true,contract_version:'legacy-duty-finance.v1',enabled:true,approval_ref:ref,approval_digest:createHash('sha256').update(ref).digest('hex')};
  assert.doesNotThrow(()=>assertInitialSingleton(name,[row],true));
  assert.doesNotThrow(()=>assertInitialSingleton(name,[],false));
  for(const changed of [{...row,enabled:false},{...row,approval_digest:'0'.repeat(64)},{...row,approval_ref:'other'},null])
    assert.throws(()=>assertInitialSingleton(name,changed?[changed]:[],true),/LEGACY_DUTY_CONTRACT_MUST_BE_CANONICAL_DEFAULT/);
  assert.throws(()=>assertInitialSingleton(name,[row],false),/LEGACY_DUTY_CONTRACT_MUST_BE_CANONICAL_DEFAULT/);
});

test('source initial plus canonical tail needs the exact ordered installed history',()=>{
  const expected=[{hash:'a'.repeat(64),createdAt:10},{hash:'b'.repeat(64),createdAt:11}];
  const actual=expected.map(row=>({hash:row.hash,createdAt:String(row.createdAt)}));
  assert.doesNotThrow(()=>assertInitialMigrationHistory(actual,expected));
  for(const changed of [actual.slice(0,1),[...actual].reverse(),[actual[0],{...actual[1],hash:'c'.repeat(64)}],[actual[0],{...actual[1],createdAt:'12'}]])
    assert.throws(()=>assertInitialMigrationHistory(changed,expected),/SOURCE_DATABASE_NOT_EXACT_CANONICAL_CHAIN/);
});
