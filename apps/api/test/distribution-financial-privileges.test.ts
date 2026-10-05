import {test} from 'node:test';import {strict as assert} from 'node:assert';import type {Pool} from 'pg';
import {applyRuntimePrivileges,configureDistributionFinancialPrivileges} from '../src/database/business-migrations';
function probe(present:boolean|boolean[]=true){const seen:string[]=[],pool={query:async(sql:string,args:any[]=[])=>{seen.push(sql);
 if(sql.startsWith('SELECT name,to_regclass'))return{rows:args[0].map((name:string,i:number)=>({name,present:Array.isArray(present)?present[i]:present}))};
 if(sql.startsWith('SELECT attname FROM pg_attribute'))return{rows:['id','state','canonical_seed','unlisted_column'].map(attname=>({attname}))};
 if(sql.includes('native_user_insert_proof')&&sql.startsWith('SELECT'))return{rows:[{proof:false,initializer:false}]};
 if(sql.includes('count(*)'))return{rows:[{count:0,ready:false}]};
 return{rows:[{relation:null,present:false,ready:false}]};
 }} as unknown as Pick<Pool,'query'>;return{pool,seen};}
test('older prefixes without all financial tables remain a no-op, while a partial schema refuses finalization',async()=>{
 const absent=probe(false);await configureDistributionFinancialPrivileges(absent.pool,'runtime_role');assert.equal(absent.seen.length,1);
 const partial=probe([true,false,false,false,false,false]);await assert.rejects(configureDistributionFinancialPrivileges(partial.pool,'runtime_role'),/incomplete/);assert.equal(partial.seen.length,1);
});
test('unsafe roles are rejected before any SQL',async()=>{const p=probe();await assert.rejects(configureDistributionFinancialPrivileges(p.pool,'role;drop'),/safe identifier/);assert.equal(p.seen.length,0);});
test('convergence clears every discovered column privilege before granting only explicit writable columns',async()=>{
 const p=probe();await configureDistributionFinancialPrivileges(p.pool,'runtime_role');const revokes=p.seen.filter(s=>s.startsWith('REVOKE ALL ON TABLE'));assert.equal(revokes.length,6);
 for(const sql of revokes){assert(sql.includes('"unlisted_column"'));for(const op of ['SELECT','INSERT','UPDATE','REFERENCES'])assert(sql.includes(op+' ('));assert(sql.includes('FROM "runtime_role"'));}
 const grants=p.seen.at(-1)!;assert(!grants.includes('GRANT INSERT(id) ON zzsh_order.distribution_order_admission'));assert(!grants.includes('GRANT INSERT(id) ON zzsh_order.controlled_payment_declaration'));assert(!grants.includes('unlisted_column'));assert(grants.includes('GRANT UPDATE(state,funds_disposition,recovery_required_cents,version)'));assert(!grants.includes('zzsh_order_personal_finance_r'));
});
test('the real common authorization entry converges after broad order grants on every invocation',async()=>{
 const p=probe();await applyRuntimePrivileges(p.pool,'runtime_role');const first=[...p.seen];p.seen.length=0;await applyRuntimePrivileges(p.pool,'runtime_role');assert.deepEqual(p.seen,first);
 const broad=p.seen.findIndex(s=>s.includes('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "zzsh_order"'));
 const narrow=p.seen.findIndex(s=>s.startsWith('REVOKE ALL ON TABLE zzsh_order.distribution_order_admission'));assert(broad>=0&&narrow>broad);assert(p.seen.at(-1)!.includes('GRANT EXECUTE ON FUNCTION zzsh_order.canonical_finance_json'));
 // This checks dispatch/order and emitted grants, not PostgreSQL effective privileges.
});
