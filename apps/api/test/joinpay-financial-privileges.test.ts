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
const collectionColumns = new Map<string,string[]>([["zzsh_order.payment_request",["id","order_id","channel","merchant_identity_id","config_profile_id","protocol_version","key_version_ref","platform_order_no","channel_order_no","amount_cents","currency","wire_amount_yuan","method","evidence_level","idempotency_scope_key","idempotency_key","request_fingerprint","state","revision","lease_version","lease_owner","lease_until","created_at","updated_at"]],["zzsh_order.payment_channel_observation",["id","request_id","channel","merchant_identity_id","channel_order_no","channel_trx_no","config_profile_id","protocol_version","key_version_ref","operation","source","evidence_level","event","result","reason","channel_status","provider_paid_at_raw","raw_sha256","raw_ref","verify_outcome","lease_version","state_before","state_after","stale","late","conflict","observed_at"]],["zzsh_order.payment_channel_transaction",["id","channel","merchant_identity_id","channel_trx_no","order_origin","native_order_id","request_id","confirmation_id","evidence_level","created_at"]],["zzsh_order.joinpay_collection_binding",["request_id","wire_merchant_no","trade_merchant_no","product_name","notify_url","initial_profile_sha256","evidence_mode","created_at","formal_admission_ref","formal_admission_sha256","formal_admission_canonical"]],["zzsh_order.joinpay_collection_attempt",["id","request_id","lease_version","lease_owner","operation","profile_id","profile_canonical","profile_sha256","key_version_ref","evidence_mode","request_body","request_sha256","created_at"]],["zzsh_order.joinpay_collection_observation",["id","attempt_id","request_id","raw_body","raw_sha256","http_status","response_complete","received_bytes","transport_failure","event","result","schema_outcome","signature_outcome","binding_outcome","verified","state_before","state_after","channel_status","provider_paid_at_raw","channel_trx_no","created_at"]],["zzsh_order.joinpay_collection_evidence",["id","request_id","operation","origin_observation_id","raw_query","raw_sha256","profile_id","profile_sha256","profile_canonical","key_version_ref","initial_admission_ref","initial_admission_sha256","admission_ref","admission_sha256","admission_canonical","event","result","schema_outcome","signature_outcome","binding_outcome","channel_trx_no","provider_paid_at_raw","provider_paid_at","created_at"]],["zzsh_order.distribution_order_admission",["id","order_id","resource_oid","resource_name","resource_marker","approval_digest","native_creation_audit_id","revision","active","admitted_at","expires_at","created_by_admin_id","reason","mode","source_admission_ref"]]]);
for(const [name,columns]of collectionColumns)allColumns.set(name,columns);
const collection=[...collectionColumns.keys()],collectionEffect='zzsh_order.joinpay_formal_request_effect(text,text)';
const bank='zzsh_order.withdrawal_bank_binding',bankGuard='zzsh_order.withdrawal_bank_binding_guard()';
const bankColumns=columns(sql('withdrawal-bank-binding-schema.sql'),bank);
allColumns.set(bank,bankColumns);
type Rights={table:Set<string>;columns:Map<string,Set<string>>;grantOption:boolean};
const ops=['SELECT','INSERT','UPDATE','REFERENCES'],sorted=(v:Iterable<string>)=>[...v].sort();
function fixture(groups=['REFUND','PAYOUT','ACCOUNT']){
  const present=new Set([intent,oldObservation,...(groups.includes('REFUND')?refund:[]),...(groups.includes('PAYOUT')?payout:[]),...(groups.includes('ACCOUNT')?[account]:[]),...(groups.includes('COLLECTION')?collection:[]),...(groups.includes('BANK')?[bank]:[])]),catalog=new Map([...allColumns].map(([n,c])=>[n,[...c]]));
  if(!groups.includes('REFUND'))catalog.set(intent,columns(old,intent));
  const seen:{sql:string;args:any[]}[]=[],rights=new Map<string,Rights>();for(const principal of ['runtime_role','PUBLIC'])for(const [name,cols]of catalog)rights.set(principal+':'+name,{table:new Set(['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']),columns:new Map(ops.map(op=>[op,new Set(cols)])),grantOption:true});
  const state={present,catalog,functions:new Set([...functions,collectionEffect,bankGuard]),bankGuard:true as unknown,identity:{roleOid:'10001',superuser:false,bypassRls:false,createRole:false,createDb:false,replication:false,memberRights:false,ownerRights:false} as any,badInventory:false,badColumns:false,permissionError:null as Error|null};
  function emitted(sql:string){for(const raw of sql.split(';')){const text=raw.replace(/\s+/g,' ').trim(),m=/^(GRANT|REVOKE) (.+?) ON (?:TABLE )?([a-z_]+\.[a-z_]+) (?:TO|FROM) (.+)$/.exec(text);if(!m)continue;const principals=m[4]!.split(',').map(p=>p.trim().replaceAll('"',''));for(const principal of principals){const r=rights.get(principal+':'+m[3]);if(!r)continue;if(m[2]==='ALL'){assert.equal(m[1],'REVOKE');r.table.clear();r.grantOption=false;continue;}const grants=[...m[2]!.matchAll(/(SELECT|INSERT|UPDATE|REFERENCES)\s*\(([^)]*)\)/g)];if(grants.length){for(const [,op,list]of grants)for(const col of list!.split(',').map(s=>s.trim().replaceAll('"',''))){if(m[1]==='GRANT')r.columns.get(op!)!.add(col);else r.columns.get(op!)!.delete(col);}}else for(const op of m[2]!.split(',').map(s=>s.trim()))if(m[1]==='GRANT')r.table.add(op);else r.table.delete(op);}}}
  const pool={query:async(sql:string,args:any[]=[])=>{seen.push({sql,args});
    if(sql.includes('joinpay financial optional tables')||sql.startsWith('SELECT name,to_regclass')){const rows=args[0].map((name:string)=>({name,present:present.has(name)}));return{rows:state.badInventory?rows.slice(1):rows};}
    if(sql.includes('joinpay financial runtime role'))return{rows:state.identity?[state.identity]:[]};
    if(sql.includes('joinpay financial columns')){const rows=args[0].flatMap((name:string)=>(catalog.get(name)??[]).map(attname=>({name,attname})));return{rows:state.badColumns?[...rows,{name:'zzsh_order.other',attname:'id'}]:rows};}
    if(sql.includes('joinpay financial functions'))return{rows:args[0].map((name:string)=>({name,present:state.functions.has(name)}))};
    if(sql.includes('withdrawal bank binding guard'))return{rows:state.bankGuard===null?[]:[{ready:state.bankGuard}]};
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

test('collection can converge independently of refund and payout schema',async()=>{
 const f=fixture(['COLLECTION']);f.state.present.delete(intent);f.state.present.delete(oldObservation);await configure(f.pool);
 for(const table of collection)assert(f.can(table,'SELECT'));
 assert(!mutations(f).some(row=>row.sql.includes('ON TABLE '+intent+' ')));assert(mutations(f).some(row=>row.sql.includes(collectionEffect)));
});
test('collection bindings, raw observations and metadata retain narrow writes',async()=>{
 const f=fixture(['COLLECTION']);await configure(f.pool);const request=collection[0]!,observation=collection[1]!,anchor=collection[2]!,binding=collection[3]!,attempt=collection[4]!,evidence=collection[6]!,admission=collection[7]!;
 assert(f.can(request,'UPDATE','state'));assert(f.can(request,'UPDATE','lease_until'));for(const column of ['order_id','amount_cents','merchant_identity_id','created_at'])assert(!f.can(request,'UPDATE',column));assert(!f.can(request,'INSERT','revision'));assert(!f.can(request,'INSERT','created_at'));
 for(const table of [observation,anchor,binding,attempt,evidence])for(const column of collectionColumns.get(table)!)assert(!f.can(table,'UPDATE',column));
 assert(!f.can(observation,'INSERT','observed_at'));assert(!f.can(anchor,'INSERT','created_at'));assert(!f.can(binding,'INSERT','created_at'));assert(!f.can(attempt,'INSERT','created_at'));assert(!f.can(evidence,'INSERT','created_at'));
 assert(f.can(binding,'INSERT','formal_admission_canonical'));assert(f.can(evidence,'INSERT','admission_canonical'));assert(f.can(admission,'INSERT','mode'));assert(f.can(admission,'INSERT','source_admission_ref'));
 for(const table of collection){for(const op of ['DELETE','TRUNCATE','TRIGGER','REFERENCES'])assert(!f.can(table,op));for(const op of ops)for(const column of collectionColumns.get(table)!)assert(!f.can(table,op,column,'PUBLIC'));}
});
test('partial collection or absent admission parent stops before ACL mutation',async()=>{
 for(const missing of collection){const f=fixture(['COLLECTION']);f.state.present.delete(missing);await assert.rejects(configure(f.pool),/partially|parent|incomplete/);assert.equal(mutations(f).length,0);}
});
test('unrecognized collection columns and missing effect helper stop before ACL mutation',async()=>{
 for(const table of collection){const f=fixture(['COLLECTION']);f.state.catalog.get(table)!.push('unreviewed_column');await assert.rejects(configure(f.pool),/column inventory/);assert.equal(mutations(f).length,0);}
 const f=fixture(['COLLECTION']);f.state.functions.delete(collectionEffect);await assert.rejects(configure(f.pool),/function inventory/);assert.equal(mutations(f).length,0);
});
test('collection uses the same non-owner runtime identity guard',async()=>{
 for(const field of ['superuser','memberRights','ownerRights']){const f=fixture(['COLLECTION']);f.state.identity[field]=true;await assert.rejects(configure(f.pool),/runtime role/);assert.equal(mutations(f).length,0);}
});
test('all installed groups converge again after stale broad collection grants',async()=>{
 const f=fixture(['COLLECTION','REFUND','PAYOUT','ACCOUNT']);await configure(f.pool);const before=f.snapshot();for(const table of collection)for(const principal of ['runtime_role','PUBLIC']){const r=f.rights.get(principal+':'+table)!;r.table.add('INSERT');r.table.add('UPDATE');r.columns.get('UPDATE')!.add(collectionColumns.get(table)!.at(-1)!);r.grantOption=true;}
 await configure(f.pool);assert.deepEqual(f.snapshot(),before);
});


test('bank binding can narrow independently and grants only eight read, six insert and four update columns',async()=>{
 const f=fixture(['BANK']);f.state.present.delete(intent);f.state.present.delete(oldObservation);await configure(f.pool);
 const r=f.rights.get('runtime_role:'+bank)!,pub=f.rights.get('PUBLIC:'+bank)!;
 assert.equal(r.table.size,0);assert.equal(r.grantOption,false);assert.equal(pub.table.size,0);assert([...pub.columns.values()].every(s=>s.size===0));
 assert.deepEqual(sorted(r.columns.get('SELECT')!),sorted(bankColumns));
 assert.deepEqual(sorted(r.columns.get('INSERT')!),sorted('id user_id revision sealed_details card_mask holder_mask'.split(' ')));
 assert.deepEqual(sorted(r.columns.get('UPDATE')!),sorted('revision sealed_details card_mask holder_mask'.split(' ')));
 for(const col of ['id','user_id','created_at','updated_at'])assert(!f.can(bank,'UPDATE',col),col);
 for(const col of ['created_at','updated_at'])assert(!f.can(bank,'INSERT',col),col);
 for(const op of ['DELETE','TRUNCATE','REFERENCES','TRIGGER'])for(const col of bankColumns)assert(!f.can(bank,op,col));
 const emitted=mutations(f).map(x=>x.sql).join('\n');assert(emitted.includes('REVOKE ALL ON FUNCTION '+bankGuard+' FROM "runtime_role", PUBLIC'));
 assert(emitted.includes('GRANT EXECUTE ON FUNCTION '+bankGuard+' TO "runtime_role"'));assert(!emitted.includes('WITH GRANT OPTION'));
 assert(!mutations(f).some(x=>[intent,...refund,...payout,account,...collection].some(name=>x.sql.includes('ON TABLE '+name+' '))));
});
test('absent bank schema is a no-op without requiring its guard',async()=>{
 const f=fixture([]);f.state.functions.delete(bankGuard);f.state.bankGuard=false;const before=f.snapshot();await configure(f.pool);
 assert.deepEqual(f.snapshot(),before);assert.equal(mutations(f).length,0);assert.equal(f.seen.length,1);
 const other=fixture(['ACCOUNT']);other.state.functions.delete(bankGuard);await configure(other.pool);assert(other.can(account,'SELECT','amounts'));
 assert(!other.seen.some(x=>x.sql.includes('withdrawal bank binding guard')));
});
test('bank metadata rejects each missing, extra or duplicate column before changing privileges',async()=>{
 for(const missing of bankColumns){const f=fixture(['BANK']);f.state.catalog.set(bank,bankColumns.filter(c=>c!==missing));await assert.rejects(configure(f.pool),/column inventory/);assert.equal(mutations(f).length,0);}
 for(const extra of ['unreviewed_column',bankColumns[0]!]){const f=fixture(['BANK']);f.state.catalog.get(bank)!.push(extra);await assert.rejects(configure(f.pool),/column inventory/);assert.equal(mutations(f).length,0);}
});
test('bank guard function and its enabled unconditional row trigger are required before privileges',async()=>{
 const missing=fixture(['BANK']);missing.state.functions.delete(bankGuard);await assert.rejects(configure(missing.pool),/function inventory/);assert.equal(mutations(missing).length,0);
 for(const ready of [false,undefined,null,'true',1]){const f=fixture(['BANK']);f.state.bankGuard=ready;await assert.rejects(configure(f.pool),/guard inventory/);assert.equal(mutations(f).length,0);}
 const f=fixture(['BANK']);await configure(f.pool);const guard=f.seen.find(x=>x.sql.includes('withdrawal bank binding guard'))!.sql;
 for(const clause of ["t.tgenabled='O'",'t.tgtype=23',"t.tgattr::text=''",'t.tgqual IS NULL',"t.tgfoid=to_regprocedure('"+bankGuard+"')",'NOT t.tgisinternal'])assert(guard.includes(clause),clause);
});
test('bank-only schema preserves the exact unprivileged non-owner role boundary',async()=>{
 for(const field of ['superuser','bypassRls','createRole','createDb','replication','memberRights','ownerRights'])for(const value of [true,undefined]){const f=fixture(['BANK']);f.state.identity[field]=value;await assert.rejects(configure(f.pool),/runtime role/);assert.equal(mutations(f).length,0);}
 const missing=fixture(['BANK']);missing.state.identity=null;await assert.rejects(configure(missing.pool),/runtime role/);assert.equal(mutations(missing).length,0);
});
test('bank reapplies after stale table and column grants without restoring metadata writes',async()=>{
 const f=fixture(['BANK']);await configure(f.pool);const expected=f.snapshot();
 for(const principal of ['runtime_role','PUBLIC']){const r=f.rights.get(principal+':'+bank)!;for(const op of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])r.table.add(op);for(const op of ops)for(const col of bankColumns)r.columns.get(op)!.add(col);r.grantOption=true;}
 await configure(f.pool);assert.deepEqual(f.snapshot(),expected);
});
test('bank addition does not change the four existing groups effective privileges',async()=>{
 const original=fixture(['COLLECTION','REFUND','PAYOUT','ACCOUNT']),combined=fixture(['COLLECTION','REFUND','PAYOUT','ACCOUNT','BANK']);await configure(original.pool);await configure(combined.pool);
 const existing=(f:ReturnType<typeof fixture>)=>f.snapshot().filter(r=>!r.name.endsWith(':'+bank));assert.deepEqual(existing(combined),existing(original));
 assert(combined.can(bank,'INSERT','revision'));assert(combined.can(bank,'UPDATE','revision'));
 assert.equal(mutations(combined).filter(r=>r.sql.includes('GRANT EXECUTE')).length,1);
});
test('first bank-only authorization error propagates without retries',async()=>{
 const f=fixture(['BANK']),error=Error('MODEL_BANK_ACL_FAILURE');f.state.permissionError=error;await assert.rejects(configure(f.pool),e=>e===error);assert.equal(mutations(f).length,1);
});

function prestartCatalog(){
 const f=fixture(['REFUND']);const ddl=readFileSync(resolve('migrations/business/0107_prestart_termination.sql'),'utf8');
 f.state.catalog.get(intent)!.push('basis_kind','liability_root_id','liability_event_id');
 for(const name of ['zzsh_order.prestart_termination','zzsh_order.prestart_termination_decision']){
  const cols=columns(ddl,name);f.state.present.add(name);f.state.catalog.set(name,cols);
  for(const principal of ['runtime_role','PUBLIC'])f.rights.set(principal+':'+name,{table:new Set(['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']),
   columns:new Map(ops.map(op=>[op,new Set(cols)])),grantOption:true});
 }
 for(const name of ['prestart_payment_basis_valid(jsonb)','prestart_liability_complete(text)','native_prestart_refund_liability_complete(text)',
  'native_prestart_refund_terminal_complete(text)','native_abnormal_refund_liability_complete(text)','native_abnormal_refund_terminal_complete(text)'])f.state.functions.add('zzsh_order.'+name);
 return f;
}
test('未开租与异常basis扩展保持精确列权；不授予approved_xid或删除/篡改原款的权',async()=>{
 const f=prestartCatalog();await configure(f.pool);
 for(const col of ['basis_kind','liability_root_id','liability_event_id']){assert(f.can(intent,'INSERT',col));assert.equal(f.can(intent,'UPDATE',col),false);}
 const head='zzsh_order.prestart_termination',decision='zzsh_order.prestart_termination_decision';
 assert(f.can(head,'INSERT','payment_basis'));assert.equal(f.can(head,'UPDATE','payment_basis'),false);assert(f.can(head,'UPDATE','state'));
 assert.equal(f.can(head,'INSERT','approved_xid'),false);assert.equal(f.can(head,'UPDATE','approved_xid'),false);
 assert(f.can(decision,'INSERT','decision'));assert.equal(f.can(decision,'UPDATE','decision'),false);
 for(const name of [head,decision]){assert.equal(f.can(name,'DELETE'),false);assert.equal(f.can(name,'TRUNCATE'),false);assert.equal(f.can(name,'INSERT','created_at'),false);}
 assert(f.seen.some(r=>r.sql.includes('GRANT EXECUTE')&&r.sql.includes('native_prestart_refund_terminal_complete')));
});
test('未开租单表/三扩展列缺一/缺完整性函数时在任何GRANT前拒绝',async()=>{
 const partial=prestartCatalog();partial.state.present.delete('zzsh_order.prestart_termination_decision');await assert.rejects(configure(partial.pool),/partially deployed/);assert.equal(mutations(partial).length,0);
 const col=prestartCatalog();col.state.catalog.get(intent)!.splice(col.state.catalog.get(intent)!.indexOf('basis_kind'),1);await assert.rejects(configure(col.pool),/partially deployed/);assert.equal(mutations(col).length,0);
 const fn=prestartCatalog();fn.state.functions.delete('zzsh_order.native_prestart_refund_terminal_complete(text)');await assert.rejects(configure(fn.pool),/function inventory/);assert.equal(mutations(fn).length,0);
});

test('退款前向迁移按0106后0107登记，未验旧来源证明不自动安装',()=>{
 const j=JSON.parse(readFileSync(resolve('migrations/business/meta/_journal.json'),'utf8'));
 const a=j.entries.findIndex((e:any)=>e.tag==='0106_joinpay_abnormal_refund_basis'),b=j.entries.findIndex((e:any)=>e.tag==='0107_prestart_termination');
 assert(a>=0);assert.equal(b,a+1);assert(j.entries[b].when>j.entries[a].when);
 assert(!j.entries.some((e:any)=>e.tag.includes('legacy_finance_source_proof')));
 assert(readFileSync(resolve('migrations/business/0106_joinpay_abnormal_refund_basis.sql'),'utf8').includes('ADD COLUMN basis_kind'));
});
