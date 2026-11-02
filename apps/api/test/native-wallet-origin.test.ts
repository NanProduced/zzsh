import {test} from 'node:test';import {strict as assert} from 'node:assert';import type {PoolClient} from 'pg';import {initializeNativeWalletOrigin,createProvisionedNativeWalletOriginResource,assertNativeWalletOriginAssembly} from '../src/finance/native-wallet-origin';
const resource={resourceSet:'personal_finance',resourceOid:869754};
function probe(installed:boolean,proof:any=null,result:any=null,templateError:any=null){
 const seen:{sql:string;args:any[]}[]=[],c={query:async(sql:string,args:any[]=[])=>{seen.push({sql,args});
  if(sql.startsWith('SELECT to_regprocedure'))return{rows:[{installed,oid:869754,name:"zzsh_test_order_personal_finance",role:"zzsh_order_personal_finance_r",marker:"zzsh:order-reservation-test:v1"}]};
  if(sql.startsWith('SELECT u.id'))return{rows:proof?[proof]:[]};
  if(sql.startsWith('SELECT zzsh_order.initialize')){if(templateError)throw templateError;return{rows:[{result}]};}
  return{rows:[]};
 }} as PoolClient;
 return{c,seen};
}
const admittedProof={id:'new_user',insertion_xid:'4294967301',identity_version:'1'};
const knownResult={knowledge:'KNOWN',origin:'NATIVE_GENESIS',availableCents:'0'};
test('missing origin template stays UNKNOWN instead of reporting a fabricated zero',async()=>{const p=probe(false);assert.equal((await initializeNativeWalletOrigin(p.c,'new_user','request',resource)).knowledge,'UNKNOWN');assert(!p.seen.some(q=>q.sql.startsWith('SELECT zzsh_order.initialize')));});
test('missing protected INSERT proof cannot be replaced by an account-created audit or row version',async()=>{const p=probe(true);await assert.rejects(initializeNativeWalletOrigin(p.c,'old_user','request',resource));assert(!p.seen.some(q=>q.sql.startsWith('SELECT zzsh_order.initialize')));});
test('protected insertion proof delegates to atomic template and validates explicit native zero result',async()=>{const p=probe(true,admittedProof,knownResult);const result=await initializeNativeWalletOrigin(p.c,'new_user','request',resource);assert.equal(result.availableCents,'0');const call=p.seen.find(q=>q.sql.startsWith('SELECT zzsh_order.initialize'));assert.equal(call?.args[0],'new_user');assert.match(call?.args[2],/^[0-9a-f]{64}$/);assert.deepEqual(JSON.parse(call?.args[1]),{schema:'native-wallet-origin.v2',userId:'new_user',insertionXid:'4294967301',identityVersion:'1'});assert(!p.seen.some(q=>/SAVEPOINT|ROLLBACK TO/.test(q.sql)),'no savepoint downgrade may wrap the template');});
test('nonzero or incomplete template result is never accepted as native zero',async()=>{for(const result of [{knowledge:'KNOWN',origin:'NATIVE_GENESIS',availableCents:'1'},{knowledge:'UNKNOWN'},null]){const p=probe(true,admittedProof,result);await assert.rejects(initializeNativeWalletOrigin(p.c,'new_user','request',resource));}});
test('unadmitted or absent assembly resource stays UNKNOWN and never calls the template',async()=>{for(const candidate of [undefined,{resourceSet:'trade_loop_ui',resourceOid:878001},{resourceSet:'personal_finance',resourceOid:833000}]){const p=probe(true,admittedProof,knownResult);const result=await initializeNativeWalletOrigin(p.c,'new_user','request',candidate as never);assert.equal(result.knowledge,'UNKNOWN');assert(!p.seen.some(q=>q.sql.startsWith('SELECT zzsh_order.initialize')));}});
test('same name with a different OID, wrong role or wrong marker all stay UNKNOWN',async()=>{
 for(const mutate of [
  (row:any)=>{row.oid=833000;},
  (row:any)=>{row.role='zzsh_order_personal_finance_m';},
  (row:any)=>{row.marker='zzsh:m2-auth-test:v1';},
  (row:any)=>{row.name='zzsh_test_order_other';},
 ]){
  const seen:{sql:string}[]=[],c={query:async(sql:string)=>{seen.push({sql});
   if(sql.startsWith('SELECT to_regprocedure')){const row:any={installed:true,oid:869754,name:'zzsh_test_order_personal_finance',role:'zzsh_order_personal_finance_r',marker:'zzsh:order-reservation-test:v1'};mutate(row);return{rows:[row]};}
   if(sql.startsWith('SELECT u.id'))return{rows:[admittedProof]};
   return{rows:[{result:knownResult}]};
  }} as PoolClient;
  const result=await initializeNativeWalletOrigin(c,'new_user','request',resource);
  assert.equal(result.knowledge,'UNKNOWN');
  assert(!seen.some(q=>q.sql.startsWith('SELECT zzsh_order.initialize')));
 }
});
test('the defined structured admission UNKNOWN is accepted without aborting registration',async()=>{
 const p=probe(true,admittedProof,{knowledge:'UNKNOWN',reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'});
 const result=await initializeNativeWalletOrigin(p.c,'new_user','request',resource);
 assert.equal(result.knowledge,'UNKNOWN');
 assert.equal(result.reason,'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED');
});
test('any other non-KNOWN template result is rejected instead of being guessed as admission',async()=>{
 for(const result of [{knowledge:'UNKNOWN'},{knowledge:'UNKNOWN',reason:'OTHER'},{knowledge:'UNKNOWN',reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED',origin:'NATIVE_GENESIS'},{knowledge:'KNOWN',origin:'NATIVE_GENESIS',availableCents:'0',reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'}]){
  const p=probe(true,admittedProof,result);
  await assert.rejects(initializeNativeWalletOrigin(p.c,'new_user','request',resource));
 }
});
test('every database-side template failure propagates and aborts the registration transaction',async()=>{
 // The reviewed template reports admission, digest, subject and privilege failures with the
 // same SQLSTATE/message; none of them may be downgraded to UNKNOWN by the caller.
 for(const failure of [
  Object.assign(new Error('native origin caller/resource/digest not admitted'),{code:'23514'}),
  Object.assign(new Error('native subject missing'),{code:'23514'}),
  Object.assign(new Error('permission denied for function initialize_native_wallet_origin'),{code:'42501'}),
  Object.assign(new Error('connection lost'),{code:'08006'}),
 ]){
  const p=probe(true,admittedProof,knownResult,failure);
  await assert.rejects(initializeNativeWalletOrigin(p.c,'new_user','request',resource));
 }
});

test('provisioned native genesis is independent of merchants and cannot promote a test or migration resource',async()=>{
 const config={profile:'dev',provider:'fake',database:{name:'zzsh_dev_daily',user:'zzsh_daily_r',runtimeUser:'zzsh_daily_r',targetProfile:'dev'}} as any;
 const provisioned=createProvisionedNativeWalletOriginResource(config);assert.equal(assertNativeWalletOriginAssembly(provisioned,undefined),false);
 config.database.name='changed_after_construction';
 const role={databaseName:'zzsh_dev_daily',currentUser:'zzsh_daily_r',owner:'zzsh',...Object.fromEntries([
  'isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase','canCreateIamSchema','canCreateUserSchema',
  'canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema','canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit',
 ].map(key=>[key,false]))};
 const make=(changes:Record<string,unknown>={},proof=true,ownerRow=true,error?:Error)=>{let calls=0;
  const c={query:async(sql:string)=>{
   if(sql.startsWith('SELECT to_regprocedure'))return{rows:[{installed:true,oid:42,name:'zzsh_dev_daily',role:'zzsh_daily_r',marker:'actual-owner-marker',...changes}]};
   if(sql.includes('AS "databaseName"'))return{rows:[role]};
   if(sql.includes('AS "ownsBusinessSchema"'))return{rows:[{ownsBusinessSchema:false,ownsBusinessRelation:false,hasPrivilegedMembership:false}]};
   if(sql.startsWith('SELECT u.id'))return{rows:proof?[admittedProof]:[]};
   if(sql.startsWith('SELECT zzsh_order.initialize')){calls++;if(error)throw error;return{rows:[{result:ownerRow?knownResult:{knowledge:'UNKNOWN',reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'}}]};}
   throw Error('Unexpected resource-only origin query');
  }} as unknown as PoolClient;return{c,calls:()=>calls};
 };
 const good=make();assert.equal((await initializeNativeWalletOrigin(good.c,'new_user','request',provisioned)).knowledge,'KNOWN');assert.equal(good.calls(),1);
 for(const changes of [{name:'zzsh_dev_other'},{role:'zzsh_daily_m'}]){const bad=make(changes);assert.equal((await initializeNativeWalletOrigin(bad.c,'new_user','request',provisioned)).knowledge,'UNKNOWN');assert.equal(bad.calls(),0);}
 const absent=make({},true,false);assert.equal((await initializeNativeWalletOrigin(absent.c,'new_user','request',provisioned)).knowledge,'UNKNOWN');
 const old=make({},false);await assert.rejects(initializeNativeWalletOrigin(old.c,'old_user','request',provisioned));assert.equal(old.calls(),0);
 const copied=make();assert.equal((await initializeNativeWalletOrigin(copied.c,'new_user','request',{...provisioned})).knowledge,'UNKNOWN');assert.equal(copied.calls(),0);
 const fault=make({},true,true,Object.assign(new Error('synthetic transaction failure'),{code:'40001'}));await assert.rejects(initializeNativeWalletOrigin(fault.c,'new_user','request',provisioned));
 for(const profile of ['test','provider-test','migration'])assert.throws(()=>createProvisionedNativeWalletOriginResource({...config,profile,database:{...config.database,targetProfile:profile}}));
 assert.throws(()=>createProvisionedNativeWalletOriginResource({...config,database:{...config.database,name:'zzsh_test_regression'}}));
 assert.throws(()=>createProvisionedNativeWalletOriginResource({...config,database:{...config.database,user:'migration'}}));
});
