import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {ModuleKind,ScriptTarget,transpileModule} from 'typescript';
import {createHash} from 'node:crypto';

test('0087 fixes the legacy-duty audit alias and preserves the full admission and transition guards',()=>{
 const prior=readFileSync(resolve('migrations/business/0074_legacy_trade_continuation.sql'),'utf8');
 assert.equal(createHash('sha256').update(prior).digest('hex'),'0afd676ab9f0fd3b9be88718a6202ce38d6ffcc8a966d5605437c1baf41d7dbd');
 const block=prior.match(/CREATE FUNCTION zzsh_order\.guard_legacy_duty\(\)[\s\S]*?END \$\$;/)![0].replaceAll('\r\n','\n');
 const predicate=block.slice(block.indexOf("IF NEW.status='VOID'"),block.indexOf("  THEN RAISE EXCEPTION 'Commission void"));
 assert.match(predicate,/FROM zzsh_iam\.audit_event a WHERE a\.id=/);
 const expected=block.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION').replace(predicate,predicate.replace('audit_event a WHERE','audit_event audit_evt WHERE').replaceAll(/\ba\./g,'audit_evt.'));
 const repair=readFileSync(resolve('migrations/business/0087_legacy_duty_audit_alias.sql'),'utf8').replaceAll('\r\n','\n');
 assert.equal(repair.match(/CREATE OR REPLACE FUNCTION[\s\S]*?END \$\$;/)![0],expected);
 assert.match(repair,/DECLARE l zzsh_order\.legacy_order_read_snapshot;a zzsh_order\.legacy_order_duty_admission;/);
 assert.equal(repair.match(/CREATE OR REPLACE FUNCTION/g)?.length,1);
 const journal=JSON.parse(readFileSync(resolve('migrations/business/meta/_journal.json'),'utf8'));
 assert.deepEqual(journal.entries.slice(85,88).map((x:{idx:number;tag:string})=>[x.idx,x.tag]),[[85,'0085_membership_total_discount'],[86,'0086_legacy_skin_holding'],[87,'0087_legacy_duty_audit_alias']]);
});

const runnerPath=resolve('src/database/business-migrations.ts');
test('0090 adds only the two PG-measured subject indexes and retains the journal prefix',()=>{
 const sql=readFileSync(resolve('migrations/business/0090_personal_finance_read_indexes.sql'),'utf8');
 assert.equal(sql.match(/CREATE INDEX/g)?.length,2);assert.equal(sql.match(/id COLLATE "C"/g)?.length,2);
 assert.match(sql,/settlement_ledger_entry \(counterparty_user_id, created_at, id COLLATE "C"\)/);
 assert.match(sql,/personal_finance_observation \(user_id, source_kind, source_event_at, id COLLATE "C"\)/);
 assert.doesNotMatch(sql,/\b(DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE)\b/);
 const journal=JSON.parse(readFileSync(resolve('migrations/business/meta/_journal.json'),'utf8'));
 assert.deepEqual(journal.entries.slice(88,91).map((entry:{idx:number;tag:string})=>[entry.idx,entry.tag]),[[88,'0088_skin_catalog_metadata'],[89,'0089_skin_deposit_recommendation'],[90,'0090_personal_finance_read_indexes']]);
});

test('0091 appends the directory migration and the runtime risk table receives only its required rights',()=>{
 const journal=JSON.parse(readFileSync(resolve('migrations/business/meta/_journal.json'),'utf8'));
 assert.deepEqual(journal.entries[91].tag,'0091_admin_user_directory_list');
 const source=readFileSync(resolve('src/database/business-migrations.ts'),'utf8');
 assert.match(source,/GRANT SELECT, INSERT, UPDATE ON TABLE "zzsh_iam"\."user_risk_flag"/);
 assert.doesNotMatch(source,/GRANT[^;\n]*DELETE[^;\n]*"user_risk_flag"/);
});

test('0092 keeps the newest success even when its date is invalid and exposes only projection SELECT',()=>{
 const sql=readFileSync(resolve('migrations/business/0092_user_registration_read_projection.sql'),'utf8');
 assert.match(sql,/ORDER BY object_id,occurred_at DESC,id DESC/);
 assert.match(sql,/THEN \(details->>'sourceCreatedAt'\)::timestamptz ELSE NULL END/);
 assert.match(sql,/pg_input_is_valid/);
 assert.match(sql,/NEW\.outcome='SUCCESS'/);
 assert.match(sql,/SECURITY DEFINER SET search_path = pg_catalog/);
 assert.match(sql,/REVOKE ALL ON FUNCTION/);
 const source=readFileSync(resolve('src/database/business-migrations.ts'),'utf8');
 assert.match(source,/GRANT SELECT ON TABLE "zzsh_iam"\."user_registration_fact"/);
 assert.match(source,/REVOKE ALL ON TABLE "zzsh_iam"\."user_registration_fact"/);
 assert.doesNotMatch(source,/GRANT[^;\n]*(INSERT|UPDATE|DELETE)[^;\n]*"user_registration_fact"/);
});
const runnerSource=readFileSync(runnerPath,'utf8');
const lastMigration=readFileSync(resolve('migrations/business/0079_owner_guarantee_history.sql'),'utf8');
const names=['legacy_continuation_evidence','legacy_continuation_version','legacy_order_duty','legacy_order_duty_revision','legacy_order_duty_admission','legacy_inflight_register','personal_finance_observation_coverage','finance_stored_opening_review','legacy_duty_finance_contract','legacy_duty_finance_fact','legacy_owner_guarantee_observation','legacy_owner_guarantee_coverage'].map(n=>'zzsh_order.'+n);
const profiles=[...runnerSource.matchAll(/^\s+(\{"name":"zzsh_order\.[^\n]+\}),?\r?$/gm)].map(m=>JSON.parse(m[1]!));
assert.deepEqual(profiles.map(p=>p.name).sort(),[...names].sort());
const columns=new Map<string,string[]>(profiles.map(p=>[p.name,[...new Set<string>(['id','unlisted_column',...(p.insert??[]),...(p.update??[])])]]));
const runtime='runtime_role',owner='migration_owner';
type Rights={table:Set<string>;columns:Set<string>};
type Acl=Map<string,Map<string,Rights>>;
const copy=(acl:Acl):Acl=>new Map([...acl].map(([table,roles])=>[table,new Map([...roles].map(([role,r])=>[role,{table:new Set(r.table),columns:new Set(r.columns)}]))]));

// Run the actual entry and ACL body; only the external Drizzle migration seam is simulated.
// This ACL model and the SQL text checks are offline evidence, never PostgreSQL execution.
function fixture(options:{failAcl?:boolean;rollbackFails?:boolean;commitFailure?:'before'|'after';migrationFails?:boolean;connectFails?:boolean;datedNumbers?:boolean}={}){
 const fault=Error('OFFLINE_ACL_METADATA_FAILURE'),rollbackFault=Error('OFFLINE_ROLLBACK_FAILURE'),commitFault=Error('OFFLINE_COMMIT_CONNECTION_LOSS'),migrationFault=Error('OFFLINE_MIGRATION_FAILURE'),connectFault=Error('OFFLINE_ACL_POOL_UNAVAILABLE');
 let durable:Acl=new Map(),pending:Acl|null=null,migrated=false,connects=0;
 const seen:{via:string;sql:string}[]=[],releases:unknown[]=[],migrationVisibility:Acl[]=[];
 const can=(table:string,operation:string,acl:Acl=durable)=>[runtime,'PUBLIC','inherited_reader'].some(role=>{const rights=acl.get('zzsh_order.'+table)?.get(role);return rights?.table.has(operation)||rights?.columns.has(operation);});
 function seed(){
  for(const name of names)durable.set(name,new Map([
   [owner,{table:new Set(['SELECT','INSERT','UPDATE']),columns:new Set(['SELECT','UPDATE'])}],
   [runtime,{table:new Set(['SELECT','INSERT','UPDATE']),columns:new Set(['SELECT','INSERT','UPDATE','REFERENCES'])}],
   ['PUBLIC',{table:new Set(['SELECT']),columns:new Set(['INSERT'])}],
   ['inherited_reader',{table:new Set<string>(),columns:new Set(['SELECT'])}],
  ]));
  durable.set('zzsh_order.old_table_untouched',new Map([[runtime,{table:new Set(['SELECT','INSERT']),columns:new Set(['UPDATE'])}]]));
  // Existing runtime column grants survive a table-only REVOKE during a later ACL repair.
  if(options.datedNumbers)durable.set('zzsh_supply.account_display_no_counter',new Map([[runtime,{table:new Set(['SELECT','INSERT','UPDATE']),columns:new Set(['SELECT','INSERT','UPDATE'])}]]));
 }
 function modelInitialCleanup(){
  const block=/DO \$continuity_initial_acl\$([\s\S]*?)\$continuity_initial_acl\$;\s*$/.exec(lastMigration)?.[1];
  if(!block)return;
  const list=/FOREACH relation_name IN ARRAY ARRAY\[([\s\S]*?)\]::text\[\]/.exec(block)?.[1];assert(list);
  const targets=[...list.matchAll(/'([^']+)'/g)].map(m=>m[1]!);assert.deepEqual(targets.sort(),[...names].sort());
  for(const text of ['aclexplode(c.relacl)','aclexplode(a.attacl)','grantee <> owner_oid','0::oid','grantee_sql := \'PUBLIC\'','REVOKE ALL PRIVILEGES ON TABLE %s FROM %s','REVOKE ALL PRIVILEGES (%s) ON TABLE %s FROM %s'])assert(block.includes(text),text);
  assert(!/\bCASCADE\b/.test(block));assert(block.includes('INTO STRICT relation_oid, owner_oid, table_sql'));
  for(const target of targets)for(const role of [...durable.get(target)!.keys()])if(role!==owner)durable.get(target)!.delete(role);
 }
 async function query(via:string,sql:string,args:any[]=[]){
  seen.push({via,sql});
  if(sql==='BEGIN'){assert.equal(pending,null);pending=copy(durable);return{rows:[]};}
  if(sql==='ROLLBACK'){if(options.rollbackFails)throw rollbackFault;pending=null;return{rows:[]};}
  if(sql==='COMMIT'){assert(pending);if(options.commitFailure==='before')throw commitFault;durable=pending;pending=null;if(options.commitFailure==='after')throw commitFault;return{rows:[]};}
  if(sql.includes('continuity runtime role ownership')){if(options.failAcl)throw fault;return{rows:[{roleOid:'20001',superuser:false,ownerRights:false}]};}
  if(sql.startsWith('SELECT name,to_regprocedure(name)'))return{rows:(args[0] as string[]).map(name=>({name,present:false}))};
  if(sql.startsWith('SELECT name,to_regclass'))return{rows:(args[0] as string[]).map(name=>({name,present:names.includes(name)}))};
  if(sql.includes("to_regprocedure('zzsh_order.assert_personal_growth_order_v4"))return{rows:[{present:true}]};
  if(sql.startsWith('SELECT attname AS name FROM pg_attribute'))return{rows:(columns.get(args[0])??[]).map(name=>({name}))};
  if(sql.includes('native_user_insert_proof')&&sql.startsWith('SELECT'))return{rows:[{proof:false,initializer:false}]};
  if(sql.includes('count(*)'))return{rows:[{count:0,ready:false}]};
  if(sql.includes("to_regprocedure('zzsh_supply.next_dated_account_display_no()')"))return{rows:[{allocator:options.datedNumbers?'zzsh_supply.next_dated_account_display_no()':null}]};
  const acl=pending??durable;
  for(const raw of sql.split(';')){
   const text=raw.replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim();
   if(/^GRANT .+ ON ALL TABLES IN SCHEMA "zzsh_order" TO/.test(text)){for(const name of names){const roles=acl.get(name)!;const r=roles.get(runtime)??{table:new Set<string>(),columns:new Set<string>()};for(const op of ['SELECT','INSERT','UPDATE'])r.table.add(op);roles.set(runtime,r);}continue;}
   const m=/^(GRANT|REVOKE) (.+?) ON TABLE ([\w."]+) (?:TO|FROM) /.exec(text);if(!m)continue;
   const name=m[3]!.replaceAll('"',''),roles=acl.get(name);if(!roles)continue;const r=roles.get(runtime)??{table:new Set<string>(),columns:new Set<string>()};roles.set(runtime,r);
   if(m[2]==='ALL'){r.table.clear();continue;}if(m[2]!.startsWith('ALL (')){r.columns.clear();continue;}
   const column=/^(INSERT|UPDATE) \(/.exec(m[2]!);if(column){r.columns.add(column[1]!);continue;}
   for(const op of m[2]!.split(',').map(s=>s.trim()))if(m[1]==='GRANT')r.table.add(op);else r.table.delete(op);
  }
  return{rows:[{relation:null,present:false,ready:false}]};
 }
 const client={query:(sql:string,args:any[])=>query('client',sql,args),release:(discard?:unknown)=>releases.push(discard)};
 const pool={query:(sql:string,args:any[])=>query('pool',sql,args),connect:async()=>{connects++;if(options.connectFails)throw connectFault;return client;}};
 const exports:Record<string,any>={},nativeRequire=createRequire(runnerPath);
 const require=(id:string)=>id==='drizzle-orm/node-postgres'?{drizzle:(input:unknown)=>{assert.equal(input,pool);return input;}}:id==='drizzle-orm/node-postgres/migrator'?{migrate:async(input:unknown)=>{assert.equal(input,pool);if(options.migrationFails)throw migrationFault;if(!migrated){seed();modelInitialCleanup();migrated=true;}migrationVisibility.push(copy(durable));}}:nativeRequire(id);
 runInNewContext(transpileModule(runnerSource,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{exports,require,__dirname:resolve('src/database')});
 const run=()=>exports.runBusinessMigrations(pool,{runtimeUser:runtime,migrationsFolder:resolve('migrations/business')}) as Promise<void>;
 return{run,apply:()=>exports.applyRuntimePrivileges(client,runtime) as Promise<void>,fault,rollbackFault,commitFault,migrationFault,connectFault,can,seen,releases,migrationVisibility,get durable(){return durable;},get connects(){return connects;}};
}

test('new DDL commits with exactly twelve tables closed to nonowners, including PUBLIC and column grants',async()=>{
 const f=fixture();await f.run();assert.equal(f.migrationVisibility.length,1);
 const atCommit=f.migrationVisibility[0]!;for(const name of names){assert.deepEqual([...atCommit.get(name)!.keys()],[owner]);assert(atCommit.get(name)!.get(owner)!.table.has('INSERT'));}
 assert(atCommit.get('zzsh_order.old_table_untouched')!.get(runtime)!.table.has('INSERT'));
});
test('real migration entry rolls back a mid-ACL failure; fake contract INSERT and forbidden review SELECT stay denied',async()=>{
 const f=fixture({failAcl:true});let caught:any;try{await f.run();}catch(error){caught=error;}
 assert.deepEqual({fakeContractInsert:f.can('legacy_duty_finance_contract','INSERT'),privateReviewSelect:f.can('finance_stored_opening_review','SELECT')},{fakeContractInsert:false,privateReviewSelect:false},'mid-ACL failure must not retain either forbidden privilege');
 assert.equal(caught?.outcome,'ACL_NOT_COMMITTED');assert.equal(caught.cause,f.fault);assert.equal(caught.rollbackAcknowledged,true);
 assert.deepEqual(f.seen.filter(q=>/^(BEGIN|COMMIT|ROLLBACK)$/.test(q.sql)).map(q=>q.sql),['BEGIN','ROLLBACK']);assert.equal(f.connects,1);assert.deepEqual(f.releases,[undefined]);
});
test('successful and repeated entry use one bound ACL client and commit only the final narrow policy',async()=>{
 const f=fixture();await f.run();assert(f.can('legacy_order_duty','UPDATE'));assert(f.can('legacy_duty_finance_fact','SELECT'));assert(!f.can('legacy_duty_finance_fact','INSERT'));assert(!f.can('legacy_duty_finance_contract','INSERT'));assert(!f.can('finance_stored_opening_review','SELECT'));
 assert.equal(f.connects,1);assert(f.seen.every(q=>q.via==='client'));assert.deepEqual(f.seen.filter(q=>/^(BEGIN|COMMIT|ROLLBACK)$/.test(q.sql)).map(q=>q.sql),['BEGIN','COMMIT']);assert.deepEqual(f.releases,[undefined]);
 const before=JSON.stringify([...f.durable].map(([name,roles])=>[name,[...roles].map(([role,r])=>[role,[...r.table],[...r.columns]])]));await f.run();assert.equal(f.connects,2);assert.equal(JSON.stringify([...f.durable].map(([name,roles])=>[name,[...roles].map(([role,r])=>[role,[...r.table],[...r.columns]])])),before);
});
test('rollback failure preserves the original ACL error and discards the connection without a success claim',async()=>{
 const f=fixture({failAcl:true,rollbackFails:true});await assert.rejects(f.run(),(error:any)=>error.outcome==='ACL_NOT_COMMITTED'&&error.cause===f.fault&&error.rollbackAcknowledged===false&&error.rollbackError===f.rollbackFault);assert.deepEqual(f.releases,[true]);assert(!f.can('legacy_duty_finance_contract','INSERT'));
});
test('both possible COMMIT-loss outcomes stay UNKNOWN, with no rollback, replay or reusable connection',async()=>{
 for(const commitFailure of ['before','after'] as const){const f=fixture({commitFailure});await assert.rejects(f.run(),(error:any)=>error.outcome==='ACL_COMMIT_UNKNOWN'&&error.cause===f.commitFault&&error.rollbackAcknowledged===false);assert.deepEqual(f.seen.filter(q=>/^(BEGIN|COMMIT|ROLLBACK)$/.test(q.sql)).map(q=>q.sql),['BEGIN','COMMIT']);assert.deepEqual(f.releases,[true]);assert.equal(f.connects,1);assert(!f.can('legacy_duty_finance_contract','INSERT'));assert(!f.can('finance_stored_opening_review','SELECT'));}
});
test('migration failure never starts post-ACL, and direct apply leaves the rollback harness transaction owned by its caller',async()=>{
 const failed=fixture({migrationFails:true});await assert.rejects(failed.run(),(error:unknown)=>error===failed.migrationFault);assert.equal(failed.connects,0);assert.equal(failed.seen.length,0);assert.equal(failed.releases.length,0);
 const direct=fixture();await direct.run();direct.seen.length=0;await direct.apply();assert(!direct.seen.some(q=>/^(BEGIN|COMMIT|ROLLBACK)$/.test(q.sql)));assert.equal(direct.connects,1);assert.equal(direct.releases.length,1);
});
test('post-migration connection failure keeps the committed-schema stage and original cause, without a false rollback or release',async()=>{
 const f=fixture({connectFails:true});await assert.rejects(f.run(),(error:any)=>error.outcome==='ACL_NOT_COMMITTED'&&error.cause===f.connectFault&&error.rollbackAcknowledged===false&&/schema migrations committed/.test(error.message));assert.equal(f.migrationVisibility.length,1);assert.equal(f.connects,1);assert.equal(f.seen.length,0);assert.equal(f.releases.length,0);assert(!f.can('legacy_duty_finance_contract','INSERT'));assert(!f.can('finance_stored_opening_review','SELECT'));
});

test('dated numbering ACL repair removes stale runtime table and column rights and remains narrow when repeated',async()=>{
 const f=fixture({datedNumbers:true});await f.run();
 const rights=()=>f.durable.get('zzsh_supply.account_display_no_counter')!.get(runtime)!;
 assert.equal(rights().table.size,0);assert.equal(rights().columns.size,0);
 await f.apply();assert.equal(rights().table.size,0);assert.equal(rights().columns.size,0);
 assert(f.seen.some(q=>q.sql.includes('GRANT EXECUTE ON FUNCTION zzsh_supply.next_dated_account_display_no()')));
 assert(!f.seen.some(q=>q.sql.includes('GRANT USAGE, SELECT ON SEQUENCE zzsh_supply.account_display_no_seq')));
});
