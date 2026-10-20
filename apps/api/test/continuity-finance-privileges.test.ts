import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Pool} from 'pg';
import {applyRuntimePrivileges,configureContinuityFinancePrivileges} from '../src/database/business-migrations';

const migrationFolder=resolve('migrations/business');
const migrationText=['0074_legacy_trade_continuation','0075_finance_history_coverage','0076_finance_stored_opening','0077_legacy_duty_finance','0078_personal_quote_v4','0079_owner_guarantee_history'].map(n=>readFileSync(resolve(migrationFolder,n+'.sql'),'utf8'));
// Fixture columns come from the real new table declarations; no PostgreSQL or SQL execution occurs here.
function parts(text:string){const result:string[]=[];let start=0,depth=0,quoted=false;for(let i=0;i<text.length;i++){if(text[i]==="'"){if(quoted&&text[i+1]==="'"){i++;continue;}quoted=!quoted;}else if(!quoted){if(text[i]==='(')depth++;else if(text[i]===')')depth--;else if(text[i]===','&&depth===0){result.push(text.slice(start,i).trim());start=i+1;}}}result.push(text.slice(start).trim());return result;}
function tableColumns(){const result=new Map<string,string[]>();for(const sql of migrationText)for(const m of sql.matchAll(/CREATE TABLE\s+([\w.]+)\s*\(/g)){const start=m.index!+m[0].length;let i=start,depth=1,quoted=false;for(;i<sql.length;i++){if(sql[i]==="'"){if(quoted&&sql[i+1]==="'"){i++;continue;}quoted=!quoted;}else if(!quoted){if(sql[i]==='(')depth++;else if(sql[i]===')'&&--depth===0)break;}}assert.equal(depth,0);const columns=parts(sql.slice(start,i)).filter(s=>!/^(CONSTRAINT|CHECK|UNIQUE|PRIMARY|FOREIGN)\b/.test(s)).map(s=>/^([a-z_][a-z0-9_]*)\s/.exec(s)?.[1]);assert(columns.every(Boolean));result.set(m[1]!,[...columns as string[],'unlisted_column']);}assert.equal(result.size,12);return result;}
type Rights={table:Set<string>;columns:Map<string,Set<string>>};
function fixture(){
 const columns=tableColumns(),rights=new Map<string,Rights>([...columns].map(([name,cols])=>[name,{table:new Set(['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']),columns:new Map(['SELECT','INSERT','UPDATE','REFERENCES'].map(op=>[op,new Set(cols)]))}])),seen:{sql:string;args:any[]}[]=[];
 const state={oldPrefix:false,v4:true,identity:{roleOid:'20001',superuser:false,ownerRights:false} as any,badInventory:false,badHelper:false,queryError:null as Error|null};
 function emitted(sql:string){for(const raw of sql.split(';')){const s=raw.replace(/\s+/g,' ').trim(),broad=/^GRANT (.+) ON ALL TABLES IN SCHEMA "zzsh_order" TO/.exec(s);if(broad){for(const r of rights.values())for(const op of broad[1]!.split(',').map(x=>x.trim()))r.table.add(op);continue;}const m=/^(GRANT|REVOKE) (.+?) ON TABLE ([\w."]+) (?:TO|FROM) /.exec(s);if(!m)continue;const r=rights.get(m[3]!.replaceAll('"',''));if(!r)continue;if(m[2]==='ALL'){assert.equal(m[1],'REVOKE');r.table.clear();continue;}const all=/^ALL \(([^)]*)\)$/.exec(m[2]!);if(all){assert.equal(m[1],'REVOKE');for(const c of all[1]!.split(',').map(x=>x.replaceAll('"','').trim()))for(const set of r.columns.values())set.delete(c);continue;}const column=/^(INSERT|UPDATE) \(([^)]*)\)$/.exec(m[2]!);if(column){assert.equal(m[1],'GRANT');for(const c of column[2]!.split(',').map(x=>x.replaceAll('"','').trim()))r.columns.get(column[1]!)!.add(c);continue;}if(m[1]==='GRANT')for(const op of m[2]!.split(',').map(x=>x.trim()))r.table.add(op);}}
 const pool={query:async(sql:string,args:any[]=[])=>{seen.push({sql,args});if(state.queryError)throw state.queryError;
  if(sql.startsWith('SELECT name,to_regprocedure(name)'))return{rows:args[0].map((name:string)=>({name,present:false}))};
  if(sql.startsWith('SELECT name,to_regclass')){const names:string[]=args[0],isContinuity=names.includes('zzsh_order.legacy_duty_finance_fact');let rows=names.map(name=>({name,present:isContinuity&&!state.oldPrefix&&columns.has(name)}));if(state.badInventory&&isContinuity)rows=rows.slice(1);return{rows};}
  if(sql.includes("to_regprocedure('zzsh_order.assert_personal_growth_order_v4" )&&!sql.includes('continuity runtime role ownership'))return{rows:state.badHelper?[]:[{present:state.v4}]};
  if(sql.includes('continuity runtime role ownership'))return{rows:state.identity?[state.identity]:[]};
  if(sql.startsWith('SELECT attname AS name FROM pg_attribute'))return{rows:(columns.get(args[0])??[]).map(name=>({name}))};
  if(sql.includes('native_user_insert_proof')&&sql.startsWith('SELECT'))return{rows:[{proof:false,initializer:false}]};
  if(sql.includes('count(*)'))return{rows:[{count:0,ready:false}]};
  if(/^\s*(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)/.test(sql)){emitted(sql);return{rows:[]};}
  return{rows:[{relation:null,present:false,ready:false}]};
 }} as unknown as Pick<Pool,'query'>;
 const can=(table:string,operation:string,column?:string)=>{const r=rights.get('zzsh_order.'+table)!;return r.table.has(operation)||Boolean(column&&r.columns.get(operation)?.has(column));};
 const snapshot=()=>[...rights].map(([name,r])=>({name,table:[...r.table].sort(),columns:[...r.columns].map(([op,set])=>[op,[...set].sort()])}));
 return{pool,state,columns,rights,seen,can,snapshot};
}
const dml=(seen:{sql:string}[])=>seen.filter(s=>/^\s*(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)/.test(s.sql));

test('last common ACL convergence survives broad/default grants and clears both table and stale column privileges on repeated apply',async()=>{
 const p=fixture();await applyRuntimePrivileges(p.pool,'runtime_role');const first=p.snapshot(),firstSql=p.seen.map(q=>q.sql),broad=p.seen.findIndex(q=>q.sql.includes('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "zzsh_order"')),defaults=p.seen.findIndex(q=>q.sql.includes('ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_order"')),narrow=p.seen.findIndex(q=>q.sql.startsWith('REVOKE ALL ON TABLE "zzsh_order"."legacy_continuation_evidence"'));assert(broad>=0&&defaults>=0&&narrow>broad&&narrow>defaults);
 assert(!p.seen.slice(narrow+1).some(q=>q.sql.includes('ON ALL TABLES IN SCHEMA "zzsh_order"')||q.sql.includes('ALTER DEFAULT PRIVILEGES')));
 const resets=p.seen.filter(q=>q.sql.startsWith('REVOKE ALL ON TABLE "zzsh_order".'));assert.equal(resets.length,12);assert(resets.every(q=>q.sql.includes('REVOKE ALL (')&&q.sql.includes('"unlisted_column"')));
 for(const [name]of p.columns){const table=name.split('.')[1]!;assert(!p.can(table,'DELETE'));assert(!p.can(table,'TRUNCATE'));for(const op of ['INSERT','UPDATE','REFERENCES'])assert(!p.can(table,op,'unlisted_column'));}
 assert(p.can('legacy_duty_finance_fact','SELECT'));for(const [name,column] of [['legacy_duty_finance_fact','amount_cents'],['legacy_order_duty_admission','amount_cents'],['legacy_inflight_register','source_digest'],['personal_finance_observation_coverage','source_count'],['legacy_owner_guarantee_observation','source_digest'],['legacy_owner_guarantee_coverage','source_count']]){assert(!p.can(name!,'INSERT',column));assert(!p.can(name!,'UPDATE',column));}
 for(const [name,column] of [['legacy_duty_finance_contract','enabled'],['finance_stored_opening_review','review_canonical']])for(const op of ['SELECT','INSERT','UPDATE'])assert(!p.can(name!,op,column));
 p.seen.length=0;await applyRuntimePrivileges(p.pool,'runtime_role');assert.deepEqual(p.snapshot(),first);assert.deepEqual(p.seen.map(q=>q.sql),firstSql);assert(p.seen.at(-1)!.sql.includes('GRANT EXECUTE ON FUNCTION zzsh_order.assert_personal_growth_order_v4'));
});
test('normal O CAS columns and derived inserts remain available, while source identities and financial settlement columns cannot be rewritten',async()=>{
 const p=fixture();await configureContinuityFinancePrivileges(p.pool,'runtime_role');for(const column of ['amount_cents','maturity_at','revision','status','revised_at','revised_by','decision_evidence_ref'])assert(p.can('legacy_order_duty','UPDATE',column));
 for(const column of ['source','source_status','source_digest','counterparty_user_id','continuation_version_id','admission_id','settled_by','settled_ref_type','settled_ref_id','settled_ref_digest'])assert(!p.can('legacy_order_duty','UPDATE',column));
 assert(p.can('legacy_continuation_version','UPDATE','superseded_at'));assert(!p.can('legacy_continuation_version','UPDATE','amounts'));assert(p.can('legacy_continuation_evidence','INSERT','source_kind'));assert(p.can('legacy_order_duty','INSERT','source'));assert(!p.can('legacy_continuation_evidence','UPDATE','source_kind'));
 // INSERT column permission does not authorize the source value; actual PG owner gates remain a required probe.
 const sql=migrationText[0]!,gates=[...sql.matchAll(/CREATE TRIGGER (a_legacy_\w+_source_owner) ([\s\S]*?) EXECUTE FUNCTION zzsh_order\.guard_legacy_source_owner\(\);/g)];assert.equal(gates.length,4);assert(gates.every(m=>m[2]!.startsWith('BEFORE INSERT ON ')&&!m[2]!.includes('UPDATE')));assert(sql.includes("needs_owner:=(to_jsonb(NEW)->>'source_kind')='SOURCE_IMPORT'"));assert(sql.includes("needs_owner:=(to_jsonb(NEW)->>'source')='LEGACY_IMPORT'"));assert(sql.includes('current_user IS DISTINCT FROM owner_name'));
});
test('unsafe or privileged runtime roles and unknown role metadata fail before this helper emits permission changes',async()=>{
 const unsafe=fixture();await assert.rejects(configureContinuityFinancePrivileges(unsafe.pool,'role;drop'),/safe identifier/);assert.equal(unsafe.seen.length,0);
 for(const patch of [{superuser:true},{ownerRights:true},{superuser:undefined},{ownerRights:null},{roleOid:20001},{roleOid:''}]){const p=fixture();Object.assign(p.state.identity,patch);await assert.rejects(configureContinuityFinancePrivileges(p.pool,'runtime_role'),/known non-owner non-superuser/);assert.equal(dml(p.seen).length,0);}
 const absent=fixture();absent.state.identity=null;await assert.rejects(configureContinuityFinancePrivileges(absent.pool,'runtime_role'),/known non-owner non-superuser/);assert.equal(dml(absent.seen).length,0);
});
test('old prefix is a no-op, while bad schema/column metadata and DB failures remain errors',async()=>{
 const old=fixture();old.state.oldPrefix=true;old.state.v4=false;await configureContinuityFinancePrivileges(old.pool,'runtime_role');assert.equal(dml(old.seen).length,0);assert(!old.seen.some(q=>q.sql.includes('runtime role ownership')));
 for(const mode of ['inventory','helper','columns'] as const){const p=fixture();if(mode==='inventory')p.state.badInventory=true;else if(mode==='helper')p.state.badHelper=true;else p.columns.set('zzsh_order.legacy_continuation_evidence',[]);await assert.rejects(configureContinuityFinancePrivileges(p.pool,'runtime_role'),/inventory/);assert.equal(dml(p.seen).length,0);}
 const p=fixture(),error=Error('OFFLINE_DB_FAILURE');p.state.queryError=error;await assert.rejects(configureContinuityFinancePrivileges(p.pool,'runtime_role'),e=>e===error);assert.equal(dml(p.seen).length,0);
});
