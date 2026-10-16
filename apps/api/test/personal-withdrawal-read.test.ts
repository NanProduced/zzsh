import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import type {Pool} from 'pg';
import {historicalWithdrawalProjection,parsePersonalWithdrawalQuery,parsePersonalWithdrawalDetailPath,readPersonalWithdrawals} from '../src/finance/personal-withdrawal-read';
import {prepareHistoricalObservation} from '../src/finance/personal-finance-read';
import {encodeFinanceCursor} from '../src/finance/personal-finance-read';
import {readControlledWithdrawalsInTransaction} from '../src/finance/controlled-withdrawal-store';
import {createNativeWithdrawalScope} from '../src/finance/native-withdrawal-resource';
import {createHash} from 'node:crypto';
const at='2026-10-04T00:00:00.000000Z',actor={userId:'self',sessionId:'session',requestId:'req_read'},key={keyId:'read-test',secret:'x'.repeat(40)};
const query={source:'ALL' as const,state:'ALL',limit:20,cursor:null};
function observation(id='obs_z',status=2,user='self'){
 const snapshot={kind:'withdrawObservation',sourceId:id==='obs_z'?42:43,sourceUserId:'11',sourceStatus:status,amount:'100.00',net:'99.00',fee:'1.00',createdAt:Date.parse(at)/1000,payee:'PRIVATE_ACCOUNT'};
 const prepared=prepareHistoricalObservation(snapshot,{userId:user,legacyUserId:'11',sourceSystem:'restore',basisId:null});
 return{id,user_id:user,basis_id:null,legacy_user_id:'11',source_kind:'HISTORICAL_WITHDRAWAL',source_type:'LEGACY_MYSQL',source_system:'restore',source_entity:'la_withdraw_apply',source_id:String(snapshot.sourceId),source_digest:prepared.sourceDigest,source_canonical:prepared.sourceCanonical,snapshot,occurred_at:at,imported_at:at,included_in_opening:false};
}
function probe(options:{rows?:ReturnType<typeof observation>[];native?:boolean;resource?:Record<string,unknown>;databaseError?:boolean;active?:boolean}={}){
 const seen:{sql:string;args:any[]}[]=[],rows=options.rows??[],resource={name:'zzsh_test_read_unadmitted',oid:99999,role:'reader',marker:'not-admitted',complete:true,...options.resource};
 const client={release(){},async query(sql:string,args:any[]=[]){seen.push({sql,args});
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]};
  if(sql.startsWith('SELECT "suspended"'))return{rows:[{suspended:options.active===false}]};
  if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return{rows:[{accountStatus:'ACTIVE'}]};
  if(sql.startsWith('SELECT 1 FROM "zzsh_auth_user"."session"'))return{rows:[{}],rowCount:1};
  if(sql.startsWith('SELECT to_regclass'))return{rows:[{history:true,native:true}]};
  if(sql.startsWith('SELECT EXISTS'))return{rows:[{complete:options.native===true}]};
  if(sql.startsWith('SELECT current_database()'))return{rows:[resource]};
  if(sql.startsWith('SELECT to_char'))return{rows:[{at}]};
  if(sql.includes('FROM zzsh_order.personal_finance_observation o')){
   if(options.databaseError)throw new Error('database read failed');
   const own=rows.filter(row=>row.user_id===args[0]);
   if(sql.includes(' AS count,md5')){const selected=own.filter(row=>args[1]==='ALL'||String(row.snapshot.sourceStatus)===args[1]);return{rows:[{count:String(selected.length),digest:selected.map(r=>r.id+':'+r.source_digest).join(',')}]};}
   if(sql.includes('AND o.id=$2'))return{rows:own.filter(row=>row.id===args[1])};
   return{rows:own.filter(row=>(args[2]==='ALL'||String(row.snapshot.sourceStatus)===args[2])&&(!args[4]||row.id<args[4])).sort((a,b)=>a.id>b.id?-1:1).slice(0,args[5])};
  }
  if(sql.includes('FROM zzsh_order.withdrawal_admission'))return{rows:[]};
  throw Error('Unexpected withdrawal read SQL: '+sql);
 }};
 return{pool:{connect:async()=>client} as unknown as Pool,seen};
}
test('historical statuses and exact source evidence stay observations, never arrival or a fresh debit',()=>{
 for(let status=1;status<=5;status++){const value=historicalWithdrawalProjection(observation('obs_z',status));assert.equal(value.sourceStatus,status);assert.equal(value.amountCents,'10000');assert.equal(value.netCents,'9900');assert.equal(value.feeCents,'100');assert.equal(value.channelArrivalKnowledge,'UNKNOWN');assert.equal(value.accountingEffect,'OBSERVATION_ONLY_NO_NEW_DEBIT');assert(!JSON.stringify(value).includes('PRIVATE_ACCOUNT'));}
 for(const patch of [{source_digest:'0'.repeat(64)},{source_entity:'la_log_earnings'},{snapshot:{...observation().snapshot,amount:'100.001'}},{included_in_opening:true}])assert.throws(()=>historicalWithdrawalProjection({...observation(),...patch}),(e:any)=>e.status===503);
});
test('withdrawal query and encoded detail contracts reject ignored filters and cross-source cursor combinations',()=>{
 assert.deepEqual(parsePersonalWithdrawalQuery(new URLSearchParams()),query);
 for(const raw of ['source=HISTORICAL&state=SUCCEEDED','source=LOCAL_CONTROLLED&state=2','source=ALL&state=2','source=ALL&cursor=anything','limit=101','limit=0','limit=2&limit=3','userId=other','cursor='])assert.throws(()=>parsePersonalWithdrawalQuery(new URLSearchParams(raw)));
 for(const prefix of ['history','controlled'])for(const colon of [':','%3A','%3a'])assert.equal(parsePersonalWithdrawalDetailPath('/'+prefix+colon+'same_id'),prefix+':same_id');
 for(const raw of ['/history%253Aobs_x','/history%3Aobs%2Fx','/controlled%3Ai%252Fx','/history:obs/x','/history%3A'])assert.throws(()=>parsePersonalWithdrawalDetailPath(raw));
 assert.equal(parsePersonalWithdrawalDetailPath('/wd_1'),null);
});
test('known historical rows remain readable with unknown wallet/total coverage and unavailable controlled resource',async()=>{
 const p=probe({rows:[observation()]}),read=await readPersonalWithdrawals(p.pool,actor,query,key);
 assert(read.historical?.items);assert(read.historical.coverage);assert(read.controlled);assert.equal(read.historical.items[0]?.amountCents,'10000');assert.equal(read.historical.coverage.knowledge,'UNKNOWN');assert.equal(read.historical.count,null);assert.equal(read.historical.mappedRecordCount,'1');assert.equal(read.controlled.availability,'NOT_ADMITTED');assert.equal(read.controlled.data,null);
 assert(p.seen.filter(row=>row.sql.includes('FROM zzsh_order.personal_finance_observation o')).every(row=>row.args[0]==='self'));
 assert(!p.seen.some(row=>/^(INSERT|UPDATE|DELETE|CREATE)/.test(row.sql)));assert(!p.seen.some(row=>row.sql.includes('settlement_ledger_entry')));
});
test('zero rows without full origin evidence stay unimported; only a proved nonlegacy native birth is known empty',async()=>{
 for(const native of [false,true]){const p=probe({native}),read=await readPersonalWithdrawals(p.pool,actor,{...query,source:'HISTORICAL'},key);assert(read.historical?.coverage);assert.equal(read.historical.coverage.knowledge,native?'KNOWN':'UNKNOWN');assert.equal(read.historical.availability,native?'AVAILABLE':'NOT_IMPORTED');assert.equal(read.historical.count,native?'0':null);}
});
test('signed history/source snapshot cursors reject session and source changes; details never switch source or subject',async()=>{
 const p=probe({rows:[observation('obs_z'),observation('obs_a'),observation('foreign',2,'other')]}),first=await readPersonalWithdrawals(p.pool,actor,{...query,source:'HISTORICAL',limit:1},key);assert('historical' in first);const cursor=first.historical?.nextCursor;assert(cursor);
 const second=await readPersonalWithdrawals(p.pool,actor,{...query,source:'HISTORICAL',limit:1,cursor},key);assert(second.historical?.items);assert.equal(second.historical.items[0]?.id,'history:obs_a');
 await assert.rejects(readPersonalWithdrawals(p.pool,{...actor,sessionId:'changed'},{...query,source:'HISTORICAL',cursor},key),(e:any)=>e.status===409);
 await assert.rejects(readPersonalWithdrawals(p.pool,actor,{...query,source:'LOCAL_CONTROLLED',cursor},key),(e:any)=>e.status===409);
 const detail=await readPersonalWithdrawals(p.pool,actor,query,key,undefined,'history:obs_z');assert('item' in detail);assert.equal(detail.item?.id,'history:obs_z');
 await assert.rejects(readPersonalWithdrawals(p.pool,actor,query,key,undefined,'history:foreign'),(e:any)=>e.status===404);
});
test('known tuple with broken role/marker, bad explicit scope and SQL errors propagate rather than become availability',async()=>{
 for(const patch of [{role:'zzsh',marker:'zzsh:m2-auth-test:v1'},{role:'zzsh_m2_auth_compat_r',marker:'wrong'}]){const p=probe({resource:{name:'zzsh_test_m2_auth_auth_compat',oid:820148,...patch}});await assert.rejects(readPersonalWithdrawals(p.pool,actor,query,key),(e:any)=>e.status===503);assert(p.seen.some(row=>row.sql==='ROLLBACK'));}
 const badScope=probe();await assert.rejects(readPersonalWithdrawals(badScope.pool,actor,query,key,{kind:'NATIVE_LOCAL_CONTROLLED_WITHDRAWAL'} as any),(e:any)=>e.status===409);
 const failed=probe({databaseError:true});await assert.rejects(readPersonalWithdrawals(failed.pool,actor,query,key),/database read failed/);
 const frozen=probe({active:false});await assert.rejects(readPersonalWithdrawals(frozen.pool,actor,query,key),(e:any)=>e.status===401);assert(!frozen.seen.some(row=>row.sql.includes('personal_finance_observation o')));
});
test('real controlled page branch keeps equal-time ordering, exact bound intent set and session/state/source/version cursor checks',async t=>{
 const projection=require('../src/finance/native-wallet-projection'),oldProjection=projection.readNativeReservationStatus;
 t.after(()=>{projection.readNativeReservationStatus=oldProjection;});projection.readNativeReservationStatus=async()=>({scope:'NATIVE_REFERRAL_OBLIGATIONS_ONLY',subjectInScope:true,globalWithdrawable:'UNKNOWN',reservationState:'REQUIRES_CURRENT_QUOTE',recovery:{knowledge:'KNOWN',outstandingCents:'0',earningCount:'0',scope:'NATIVE_REFERRAL_OBLIGATIONS_ONLY'}});
 const scope=createNativeWithdrawalScope({config:{profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',host:'127.0.0.1',port:55432,name:'zzsh_test_order_read_paging',user:'zzsh_order_read_paging_r'}} as any,resourceSet:'read_paging',resourceOid:999999,bindings:['wd_z','wd_a'].map(id=>({userId:'self',admissionId:'admission',destinationId:'destination_'+id,intentId:id,payoutKey:'payout_'+id}))});
 const make=(id:string,user='self')=>({id,user_id:user,admission_id:'admission',destination_id:'destination_'+id,mode:'LOCAL_CONTROLLED',policy_version:'policy',expected_ledger_revision:'1',accepted_at:new Date(at),sort_at:at,gross_cents:'200',net_cents:'196',fee_cents:'4',payout_key:'payout_'+id,state:'UNKNOWN',operation_version:'1',funds_disposition:'RESERVED',terminal:null,lease_token_hash:null,lease_until:null});
 const rows=[make('wd_z'),make('wd_a'),make('wd_outside'),make('wd_foreign','other')],seen:{sql:string;args:any[]}[]=[];
 const client={query:async(sql:string,args:any[]=[])=>{seen.push({sql,args});
  if(sql.startsWith('SELECT d.oid::int'))return{rows:[{name:'zzsh_test_order_read_paging',role:'zzsh_order_read_paging_r',oid:999999,marker:'zzsh:order-reservation-test:v1',rolsuper:false,rolbypassrls:false,complete:true}]};
  if(sql.startsWith('SELECT "suspended"'))return{rows:[{suspended:false}]};if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return{rows:[{accountStatus:'ACTIVE'}]};if(sql.startsWith('SELECT 1 FROM "zzsh_auth_user"."session"'))return{rows:[{}],rowCount:1};
  if(sql.includes('FROM zzsh_order.withdrawal_admission'))return{rows:[{id:'admission',revision:'1',admitted_at:new Date(at),expires_at:new Date('2026-10-05T00:00:00Z')}]};
  if(sql.includes('FROM zzsh_order.withdrawal_destination'))return{rows:[]};
  if(sql.includes('FROM zzsh_order.withdrawal_intent i JOIN'))return{rows:[{reserved:'0',paid:'0',fee:'0'}]};
  if(sql.startsWith('SELECT to_char'))return{rows:[{at}]};
  if(sql.includes('FROM zzsh_order.withdrawal_intent WHERE')){const own=rows.filter(row=>row.user_id===args[0]&&(!args[1]||args[1].includes(row.id))&&(args[2]==='ALL'||row.state===args[2]));if(sql.includes(' AS count,md5'))return{rows:[{count:String(own.length),digest:own.map(row=>row.id+':'+row.operation_version).join(',')}]};return{rows:own.filter(row=>!args[5]||row.id<args[5]).sort((a,b)=>a.id>b.id?-1:1).slice(0,args[6])};}
  throw Error('Unexpected controlled page SQL: '+sql);
 }} as any;
 const page={limit:1,state:'ALL',cursor:null,key},first=await readControlledWithdrawalsInTransaction(client,actor,undefined,scope,page);assert('items' in first);assert(first.items?.[0]);assert(first.pagination);assert.equal(first.items[0].id,'wd_z');const cursor=first.pagination.nextCursor;assert(cursor);
 const second=await readControlledWithdrawalsInTransaction(client,actor,undefined,scope,{...page,cursor});assert('items' in second);assert(second.items?.[0]);assert.equal(second.items[0].id,'wd_a');assert.equal(second.pagination?.nextCursor,null);
 const pageQueries=seen.filter(row=>row.sql.startsWith('SELECT *,to_char'));assert(pageQueries.every(row=>row.args[0]==='self'&&JSON.stringify(row.args[1])===JSON.stringify(['wd_z','wd_a'])&&row.sql.includes('id=ANY($2)')&&row.sql.includes('LIMIT $7')));
 await assert.rejects(readControlledWithdrawalsInTransaction(client,{...actor,sessionId:'other'},undefined,scope,{...page,cursor}),(e:any)=>e.status===409);
 await assert.rejects(readControlledWithdrawalsInTransaction(client,actor,undefined,scope,{...page,state:'SUCCEEDED',cursor}),(e:any)=>e.status===409);
 const foreignCursor=encodeFinanceCursor({at,id:'wd_z'},at,{userId:'self',sessionHash:createHash('sha256').update(actor.sessionId).digest('hex'),snapshotVersion:first.pagination!.snapshotVersion,bucket:'PERSONAL_WITHDRAWALS:HISTORICAL:ALL'},key);
 await assert.rejects(readControlledWithdrawalsInTransaction(client,actor,undefined,scope,{...page,cursor:foreignCursor}),(e:any)=>e.status===409);
 rows[0]!.operation_version='2';await assert.rejects(readControlledWithdrawalsInTransaction(client,actor,undefined,scope,{...page,cursor}),(e:any)=>e.status===409);
 assert(!seen.some(row=>/^(INSERT|UPDATE|DELETE)/.test(row.sql)));
});
test('actual mounted GET handler decodes qualified IDs exactly once and preserves legacy commands and receipts',async t=>{
 const identity=require('../src/auth/user-identity'),read=require('../src/finance/personal-withdrawal-read'),store=require('../src/finance/controlled-withdrawal-store');
 const oldIdentity=identity.readUserContext,oldRead=read.readPersonalWithdrawals,names=['readControlledWithdrawals','readControlledWithdrawalQuote','recoverControlledWithdrawal','createControlledWithdrawal'],old=Object.fromEntries(names.map(name=>[name,store[name]])),seen:any[]=[];
 t.after(()=>{identity.readUserContext=oldIdentity;read.readPersonalWithdrawals=oldRead;Object.assign(store,old);});
 identity.readUserContext=async()=>actor;read.readPersonalWithdrawals=async(...args:any[])=>{seen.push({name:'personal',args});return{};};for(const name of names)store[name]=async(...args:any[])=>{seen.push({name,args});return name==='createControlledWithdrawal'?{status:200,body:{}}:{};};
 let handler:any;const app={getHttpAdapter:()=>({getInstance:()=>({use:(_prefix:string,callback:any)=>{handler=callback;}})})},scope={kind:'SERVER_SCOPE'};
 require('../src/finance/controlled-withdrawal-routes').mountControlledWithdrawalRoutes(app,{pool:{},apiOrigin:'http://api',userOrigin:'http://user',nativeWithdrawalScope:scope,listingCursorKey:key});
 const invoke=async(suffix:string,method='GET')=>{const response={headersSent:false,statusCode:0,status(n:number){this.statusCode=n;return this;},setHeader(){return this;},json(){this.headersSent=true;return this;}};await handler({method,url:suffix,originalUrl:'/api/v1/users/me/withdrawals'+suffix,headers:{origin:'http://user','x-request-id':'req_path','idempotency-key':'original'},body:{amountCents:'200',destinationId:'d',policyVersion:'p',expectedWalletVersion:'1'}},response);return response.statusCode;};
 for(const suffix of ['/history%3Aobs_x','/controlled%3Aintent_x','/history:obs_x']){assert.equal(await invoke(suffix),200);assert.equal(seen.at(-1).name,'personal');assert.equal(seen.at(-1).args[3],key);assert.equal(seen.at(-1).args[4],scope);assert.equal(seen.at(-1).args[5],decodeURIComponent(suffix.slice(1)));}
 assert.equal(await invoke('/?source=HISTORICAL&state=2&limit=20'),200);assert.equal(seen.at(-1).args[2].source,'HISTORICAL');
 for(const suffix of ['/history%253Aobs_x','/history%3Aobs%2Fx','/controlled%3Aintent%252Fx','/?source=ALL&cursor=x','/?source=HISTORICAL&state=SUCCEEDED']){const count=seen.length;assert([400,404].includes(await invoke(suffix)));assert.equal(seen.length,count);}
 for(const [suffix,method,name] of [['/intent_x','GET','readControlledWithdrawals'],['/receipt?key=original','GET','recoverControlledWithdrawal'],['/quote','POST','readControlledWithdrawalQuote'],['/','POST','createControlledWithdrawal']] as const){assert.equal(await invoke(suffix,method),200);assert.equal(seen.at(-1).name,name);assert.equal(seen.at(-1).args.at(-1),scope);}
});
