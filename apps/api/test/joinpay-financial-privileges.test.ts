import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Pool} from 'pg';
import * as migrations from '../src/database/business-migrations';

const sql=(name:string)=>readFileSync(resolve('test/fixtures',name),'utf8');
const g3=sql('joinpay-native-refund-schema.sql'),g4=sql('joinpay-native-withdrawal-schema.sql'),g5=sql('joinpay-account-schema.sql'),old=sql('channel-refund-schema.sql');
const intent='zzsh_order.channel_refund_intent',oldObservation='zzsh_order.channel_refund_observation';
const refund=['joinpay_refund_attempt','joinpay_refund_observation','joinpay_refund_evidence'].map(n=>'zzsh_order.'+n),payout=['joinpay_withdrawal_intent','joinpay_payout_attempt','joinpay_payout_observation','joinpay_payout_evidence'].map(n=>'zzsh_order.'+n),account='zzsh_order.joinpay_account_observation';
const functions=['assert_joinpay_refund_profile(text,text,text,text,zzsh_order.channel_refund_intent)','native_refund_terminal_complete(text)','assert_joinpay_payout_scope(text,text,text,text,text,text,zzsh_order.joinpay_withdrawal_intent)','assert_joinpay_payout_profile(text,text,text,text,zzsh_order.joinpay_withdrawal_intent)','assert_joinpay_withdrawal_admission(zzsh_order.joinpay_withdrawal_intent,boolean)','joinpay_payout_raw_data(zzsh_order.joinpay_payout_observation)','joinpay_withdrawal_expected_lines(text)','joinpay_withdrawal_complete(text)'].map(n=>'zzsh_order.'+n);
function parts(text:string){const rows:string[]=[];let start=0,depth=0,quote=false;for(let i=0;i<text.length;i++){if(text[i]==="'"){if(quote&&text[i+1]==="'"){i++;continue;}quote=!quote;}else if(!quote){if(text[i]==='(')depth++;else if(text[i]===')')depth--;else if(text[i]===','&&depth===0){rows.push(text.slice(start,i).trim());start=i+1;}}}rows.push(text.slice(start).trim());return rows;}
function columns(text:string,name:string){const found=new RegExp('CREATE TABLE\\s+'+name.replaceAll('.','\\.')+'\\s*\\(').exec(text);assert(found,name);const start=found.index+found[0].length;let i=start,depth=1,quote=false;for(;i<text.length;i++){if(text[i]==="'"){if(quote&&text[i+1]==="'"){i++;continue;}quote=!quote;}else if(!quote){if(text[i]==='(')depth++;else if(text[i]===')'&&--depth===0)break;}}assert.equal(depth,0);return parts(text.slice(start,i)).filter(s=>!/^(CONSTRAINT|CHECK|UNIQUE|PRIMARY|FOREIGN)\b/.test(s)).map(s=>{const name=/^([a-z_][a-z0-9_]*)\s/.exec(s)?.[1];assert(name,s);return name;});}
const allColumns=new Map<string,string[]>([[intent,[...columns(old,intent),...[...g3.matchAll(/ADD COLUMN ([a-z_][a-z0-9_]*)/g)].map(m=>m[1]!)]],[oldObservation,columns(old,oldObservation)],...refund.map(n=>[n,columns(g3,n)] as [string,string[]]),...payout.map(n=>[n,columns(g4,n)] as [string,string[]]),[account,columns(g5,account)]]);
type Rights={table:Set<string>;columns:Map<string,Set<string>>;grantOption:boolean};
const ops=['SELECT','INSERT','UPDATE','REFERENCES'],sorted=(v:Iterable<string>)=>[...v].sort();
function fixture(groups=['REFUND','PAYOUT','ACCOUNT']){
  const present=new Set([intent,oldObservation,...(groups.includes('REFUND')?refund:[]),...(groups.includes('PAYOUT')?payout:[]),...(groups.includes('ACCOUNT')?[account]:[])]),catalog=new Map([...allColumns].map(([n,c])=>[n,[...c]]));
  if(!groups.includes('REFUND'))catalog.set(intent,columns(old,intent));
  const seen:{sql:string;args:any[]}[]=[],rights=new Map<string,Rights>();for(const principal of ['runtime_role','PUBLIC'])for(const [name,cols]of catalog)rights.set(principal+':'+name,{table:new Set(['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']),columns:new Map(ops.map(op=>[op,new Set(cols)])),grantOption:true});
  const state={present,catalog,functions:new Set(functions),identity:{roleOid:'10001',superuser:false,bypassRls:false,createRole:false,createDb:false,replication:false,memberRights:false,ownerRights:false} as any,badInventory:false,badColumns:false,permissionError:null as Error|null};
  function emitted(sql:string){for(const raw of sql.split(';')){const text=raw.replace(/\s+/g,' ').trim(),m=/^(GRANT|REVOKE) (.+?) ON (?:TABLE )?([a-z_]+\.[a-z_]+) (?:TO|FROM) (.+)$/.exec(text);if(!m)continue;const principals=m[4]!.split(',').map(p=>p.trim().replaceAll('"',''));for(const principal of principals){const r=rights.get(principal+':'+m[3]);if(!r)continue;if(m[2]==='ALL'){assert.equal(m[1],'REVOKE');r.table.clear();r.grantOption=false;continue;}const grants=[...m[2]!.matchAll(/(SELECT|INSERT|UPDATE|REFERENCES)\s*\(([^)]*)\)/g)];if(grants.length){for(const [,op,list]of grants)for(const col of list!.split(',').map(s=>s.trim().replaceAll('"',''))){if(m[1]==='GRANT')r.columns.get(op!)!.add(col);else r.columns.get(op!)!.delete(col);}}else for(const op of m[2]!.split(',').map(s=>s.trim()))if(m[1]==='GRANT')r.table.add(op);else r.table.delete(op);}}}
  const pool={query:async(sql:string,args:any[]=[])=>{seen.push({sql,args});
    if(sql.includes('joinpay financial optional tables')||sql.startsWith('SELECT name,to_regclass')){const rows=args[0].map((name:string)=>({name,present:present.has(name)}));return{rows:state.badInventory?rows.slice(1):rows};}
    if(sql.includes('joinpay financial runtime role'))return{rows:state.identity?[state.identity]:[]};
    if(sql.includes('joinpay financial columns')){const rows=args[0].flatMap((name:string)=>(catalog.get(name)??[]).map(attname=>({name,attname})));return{rows:state.badColumns?[...rows,{name:'zzsh_order.other',attname:'id'}]:rows};}
    if(sql.includes('joinpay financial functions'))return{rows:args[0].map((name:string)=>({name,present:state.functions.has(name)}))};
    if(sql.startsWith('SELECT attname FROM pg_attribute'))return{rows:(catalog.get(args[0])??[]).map(attname=>({attname}))};
    if(/^\s*(REVOKE|GRANT)/.test(sql)){if(state.permissionError)throw state.permissionError;emitted(sql);return{rows:[]};}
    throw Error('UNEXPECTED_OFFLINE_CATALOG_SQL');
  }} as unknown as Pick<Pool,'query'>;
  const can=(name:string,op:string,col?:string,principal='runtime_role')=>{const r=rights.get(principal+':'+name)!;return r.table.has(op)||Boolean(col&&r.columns.get(op)?.has(col));};
  const snapshot=()=>[...rights].map(([name,r])=>({name,table:sorted(r.table),columns:[...r.columns].map(([op,c])=>[op,sorted(c)]),grantOption:r.grantOption}));
  return{pool,state,seen,rights,can,snapshot};
}
const configure=(pool:Pick<Pool,'query'>,role='runtime_role')=>(migrations as unknown as {configureJoinpayFinancialPrivileges:(p:Pick<Pool,'query'>,r:string)=>Promise<void>}).configureJoinpayFinancialPrivileges(pool,role);
const mutations=(f:ReturnType<typeof fixture>)=>f.seen.filter(r=>/^\s*(REVOKE|GRANT)/.test(r.sql));

test('last optional JoinPay narrowing is wired after broad/default grants and the unchanged CONTROLLED helper',()=>{
 const text=readFileSync(resolve('src/database/business-migrations.ts'),'utf8'),start=text.indexOf('export async function applyRuntimePrivileges'),end=text.indexOf('export async function configureAdminSecurityCommandPrivileges',start),body=text.slice(start,end),at=body.indexOf('await configureJoinpayFinancialPrivileges(pool, runtimeRole)');
 assert(at>body.indexOf('await configureChannelRefundPrivileges(pool, runtimeRole)'));assert(at>body.lastIndexOf('ALTER DEFAULT PRIVILEGES'));assert(at>body.lastIndexOf('ON ALL TABLES'));assert.equal(typeof (migrations as any).configureJoinpayFinancialPrivileges,'function');
});
test('optional absent groups do not change the existing two-table CONTROLLED contract',async()=>{
 const f=fixture([]);await migrations.configureChannelRefundPrivileges(f.pool,'runtime_role');const before=f.snapshot();f.seen.length=0;await configure(f.pool);assert.deepEqual(f.snapshot(),before);assert.equal(mutations(f).length,0);assert.equal(f.seen.length,1);
 const onlyAccount=fixture(['ACCOUNT']);await configure(onlyAccount.pool);assert(onlyAccount.can(account,'SELECT','amounts'));assert.equal(mutations(onlyAccount).some(r=>r.sql.includes(intent)),false);
});
test('all present groups clear runtime and PUBLIC table/column grants then preserve only exact necessary rights',async()=>{
 const f=fixture();await configure(f.pool);for(const name of [intent,...refund,...payout,account]){const r=f.rights.get('runtime_role:'+name)!,pub=f.rights.get('PUBLIC:'+name)!;assert.equal(r.grantOption,false);assert.equal(pub.table.size,0);assert([...pub.columns.values()].every(s=>s.size===0));for(const op of ['DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert(!f.can(name,op,'id'));}
 for(const name of [...refund,...payout.slice(1),account])assert(!f.can(name,'UPDATE','id'));
 for(const name of [intent,...refund,...payout,account])for(const col of ['created_at','created_xid','recorded_at','accepted_at','updated_at'])if(allColumns.get(name)!.includes(col)){assert(!f.can(name,'INSERT',col),name+':'+col);if(!(name===intent&&col==='updated_at'))assert(!f.can(name,'UPDATE',col));}
 assert(!f.can(payout[0]!,'INSERT','state'));assert(!f.can(payout[0]!,'UPDATE','receiver_account_no_enc'));assert(!f.can(intent,'UPDATE','initial_admission_canonical'));assert(f.can(intent,'UPDATE','budget_disposition'));assert(f.can(intent,'INSERT','initial_admission_canonical'));
 const safe='attempt_id merchant_identity_id operation evidence_level decision reason requested_at received_at recorded_at response_complete http_status status_code error_code amounts'.split(' ');assert.deepEqual(sorted(f.rights.get('runtime_role:'+account)!.columns.get('SELECT')!),sorted(safe));assert.equal(f.rights.get('runtime_role:'+account)!.table.has('SELECT'),false);for(const col of ['raw_body','raw_sha256','key_version_ref','profile_id','profile_sha256'])assert(!f.can(account,'SELECT',col));assert(f.can(account,'INSERT','raw_body'));
 const grants=mutations(f).map(r=>r.sql).join('\n');assert(!/WITH GRANT OPTION/.test(grants));assert(!/GRANT\s+(?:INSERT|UPDATE|DELETE)\s+ON/.test(grants));for(const signature of functions)assert(grants.includes(signature));assert.equal((grants.match(/GRANT EXECUTE/g)??[]).length,1);
});
test('partial groups, malformed inventories and missing formal intent stop before new ACL changes',async()=>{
 for(const names of [refund,payout])for(const missing of names){const f=fixture();f.state.present.delete(missing);await assert.rejects(configure(f.pool),/incomplete|partially|parent/);assert.equal(mutations(f).length,0);}
 const noIntent=fixture();noIntent.state.present.delete(intent);await assert.rejects(configure(noIntent.pool),/intent|incomplete|parent/);assert.equal(mutations(noIntent).length,0);
 const bad=fixture();bad.state.badInventory=true;await assert.rejects(configure(bad.pool),/inventory/);assert.equal(mutations(bad).length,0);
 const orphanPayout=fixture(['PAYOUT']);await assert.rejects(configure(orphanPayout.pool),/parent/);assert.equal(mutations(orphanPayout).length,0);
});
test('unknown or privileged runtime identity stops before any REVOKE or GRANT',async()=>{
 for(const role of ['UPPER','role;drop','', 'a'.repeat(64)]){const f=fixture();await assert.rejects(configure(f.pool,role),/safe identifier/);assert.equal(f.seen.length,0);}
 for(const field of ['superuser','bypassRls','createRole','createDb','replication','memberRights','ownerRights'])for(const value of [true,undefined]){const f=fixture();f.state.identity[field]=value;await assert.rejects(configure(f.pool),/runtime role/);assert.equal(mutations(f).length,0);}
 for(const identity of [null,{roleOid:10001},{roleOid:''}]){const f=fixture();f.state.identity=identity;await assert.rejects(configure(f.pool),/runtime role/);assert.equal(mutations(f).length,0);}
});
test('complete column and function inventory is required for every group before the first authorization mutation',async()=>{
 for(const name of [intent,refund[0]!,payout[0]!,account])for(const mode of ['missing','extra','duplicate']){const f=fixture(),cols=f.state.catalog.get(name)!;if(mode==='missing')cols.pop();else cols.push(mode==='extra'?'unreviewed_extra_column':cols[0]!);await assert.rejects(configure(f.pool),/column inventory/);assert.equal(mutations(f).length,0);}
 const bad=fixture();bad.state.badColumns=true;await assert.rejects(configure(bad.pool),/column inventory/);assert.equal(mutations(bad).length,0);
 for(const signature of [functions[0]!,functions.at(-1)!]){const f=fixture();f.state.functions.delete(signature);await assert.rejects(configure(f.pool),/function inventory/);assert.equal(mutations(f).length,0);}
});
test('reapplying converges after broad/stale grants and never grants metadata or table-wide G5 SELECT',async()=>{
 const f=fixture();await configure(f.pool);const expected=f.snapshot();for(const name of [intent,...refund,...payout,account])for(const principal of ['runtime_role','PUBLIC']){const r=f.rights.get(principal+':'+name)!;r.table.add('INSERT');r.table.add('UPDATE');r.columns.get('SELECT')!.add(allColumns.get(name)![0]!);r.grantOption=true;}
 await configure(f.pool);assert.deepEqual(f.snapshot(),expected);
 assert(!mutations(f).some(r=>new RegExp('GRANT SELECT ON TABLE '+account.replaceAll('.','\\.')).test(r.sql)));
});
test('first authorization failure propagates for the caller transaction without retrying the helper',async()=>{
 const f=fixture(),error=Error('MODEL_ACL_FAILURE');f.state.permissionError=error;await assert.rejects(configure(f.pool),e=>e===error);assert.equal(mutations(f).length,1);
});
