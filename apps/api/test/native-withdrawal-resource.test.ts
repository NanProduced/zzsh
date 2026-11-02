import {test} from 'node:test';import {strict as assert} from 'node:assert';import type {AppConfig} from '../src/config/config';import type {PoolClient} from 'pg';
import {createNativeWithdrawalScope,assertNativeWithdrawalResource,nativeWithdrawalBindings,assertNativeWithdrawalDestination,assertNativeWithdrawalIntent,type NativeWithdrawalScope} from '../src/finance/native-withdrawal-resource';
import {createControlledRegressionResource,assertControlledRegressionResource} from '../src/finance/controlled-regression-resource';
import {createSyntheticChannelRequestCapability,assertSyntheticChannelRequestCapability,assertSyntheticChannelRequestOrder} from '../src/order/channel-payment-store';
import {createControlledRegressionDistributionScope,createPaymentDistributionStore,assertDistributionOrderScopeResource} from '../src/finance/distribution-payment-store';
import {createDistributionEarningStore} from '../src/finance/distribution-earning-store';
function options(){return{config:{profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',host:'127.0.0.1',port:55432,name:'zzsh_test_order_personal_finance',user:'zzsh_order_personal_finance_r'}} as AppConfig,resourceSet:'personal_finance',resourceOid:869754,bindings:[{userId:'user',admissionId:'admission-a',destinationId:'destination-a',intentId:'intent-a',payoutKey:'payout-a'},{userId:'user',admissionId:'admission-b',destinationId:'destination-b',intentId:'intent-b',payoutKey:'payout-b'}]};}
const live={oid:869754,name:'zzsh_test_order_personal_finance',role:'zzsh_order_personal_finance_r',marker:'zzsh:order-reservation-test:v1',rolsuper:false,rolbypassrls:false,complete:true};
const client=(row:unknown)=>({query:async()=>({rows:row?[row]:[]})}) as unknown as PoolClient;
test('token is frozen and copied fields cannot be forged as a capability',()=>{const scope=createNativeWithdrawalScope(options());assert(Object.isFrozen(scope));assert.throws(()=>nativeWithdrawalBindings({...scope},'user'),/not verified/);assert.throws(()=>nativeWithdrawalBindings({kind:'NATIVE_LOCAL_CONTROLLED_WITHDRAWAL'} as NativeWithdrawalScope,'user'),/not verified/);});
test('caller and returned-view mutations cannot expand or replace allowed bindings',async()=>{const input=options(),scope=createNativeWithdrawalScope(input);input.bindings[0]!.userId='other';input.bindings.push({userId:'other',admissionId:'x',destinationId:'x',intentId:'x',payoutKey:'x'});input.config.database.name='wrong';const exposed=nativeWithdrawalBindings(scope,'user') as unknown as Array<{userId:string}>;exposed[0]!.userId='other';assert.equal(nativeWithdrawalBindings(scope,'user').length,2);assert.throws(()=>nativeWithdrawalBindings(scope,'other'));await assertNativeWithdrawalResource(client(live),scope);});
test('wrong config profile, provider, test flag, host, port, database or runtime role cannot construct a scope',()=>{for(const mutate of [(o:ReturnType<typeof options>)=>o.config.profile='provider-test',(o:ReturnType<typeof options>)=>o.config.provider='real',(o:ReturnType<typeof options>)=>o.config.testOperationsEnabled=false,(o:ReturnType<typeof options>)=>o.config.database.host='remote',(o:ReturnType<typeof options>)=>o.config.database.port=5432,(o:ReturnType<typeof options>)=>o.config.database.name='other',(o:ReturnType<typeof options>)=>o.config.database.user='zzsh_order_personal_finance_m']){const o=options();mutate(o);assert.throws(()=>createNativeWithdrawalScope(o));}});
test('ambiguous intent, payout or destination tuples are rejected',()=>{for(const field of ['intentId','payoutKey'] as const){const o=options();o.bindings[1]![field]=o.bindings[0]![field];assert.throws(()=>createNativeWithdrawalScope(o),/ambiguous/);}const o=options();o.bindings[1]!.admissionId='admission-a';o.bindings[1]!.destinationId='destination-a';assert.throws(()=>createNativeWithdrawalScope(o),/ambiguous/);});
test('every live connection must match exact resource, marker and non-super runtime role',async()=>{const scope=createNativeWithdrawalScope(options());await assertNativeWithdrawalResource(client(live),scope);for(const changed of [{oid:833000},{name:'other'},{role:'zzsh_order_personal_finance_m'},{marker:'zzsh:m2-auth-test:v1'},{rolsuper:true},{rolbypassrls:true}])await assert.rejects(assertNativeWithdrawalResource(client({...live,...changed}),scope),/NATIVE_WITHDRAWAL_RESOURCE_NOT_ADMITTED/);await assert.rejects(assertNativeWithdrawalResource(client(null),scope));await assert.rejects(assertNativeWithdrawalResource(client({...live,complete:false}),scope),/SCHEMA_UNAVAILABLE/);});
test('destination and full intent binding cannot be mixed across approved tuples',()=>{const scope=createNativeWithdrawalScope(options());assertNativeWithdrawalDestination(scope,{userId:'user',admissionId:'admission-a',destinationId:'destination-a'});assert.throws(()=>assertNativeWithdrawalDestination(scope,{userId:'user',admissionId:'admission-a',destinationId:'destination-b'}));const row={id:'intent-a',user_id:'user',admission_id:'admission-a',destination_id:'destination-a',payout_key:'payout-a'};assertNativeWithdrawalIntent(scope,row);for(const changed of [{id:'other-intent'},{user_id:'other'},{admission_id:'admission-b'},{destination_id:'destination-b'},{payout_key:'payout-b'}])assert.throws(()=>assertNativeWithdrawalIntent(scope,{...row,...changed}));});
test('forged scope is rejected before any database query',async()=>{let queries=0;const c={query:async()=>{queries++;return{rows:[live]};}} as unknown as PoolClient;await assert.rejects(assertNativeWithdrawalResource(c,{kind:'NATIVE_LOCAL_CONTROLLED_WITHDRAWAL'}),/not verified/);assert.equal(queries,0);});

const regressionBinding={resourceOid:2220718,nonce:'f40e53cdf07375ec93155e99',runtimeRoleOid:1227786};
function regressionConfig(){return{profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',targetProfile:'test',host:'127.0.0.1',port:55432,name:'zzsh_test_regression',user:'zzsh_regression_runtime',runtimeUser:'zzsh_regression_runtime'}} as AppConfig;}
function regressionClient(drift:Record<string,unknown>={},unsafe:Record<string,unknown>={}){
 const row={oid:2220718,name:'zzsh_test_regression',role:'zzsh_regression_runtime',db:'zzsh_test_regression',actor:'zzsh_regression_runtime',role_oid:1227786,nonce:regressionBinding.nonce,marker:'zzsh:regression-test:v1',rolsuper:false,rolbypassrls:false,complete:true,...drift};
 const identity={databaseName:row.name,currentUser:row.role,owner:'zzsh',...Object.fromEntries(['isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase','canCreateIamSchema','canCreateUserSchema','canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema','canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit'].map(k=>[k,false])),...unsafe};
 const seen:string[]=[],c={query:async(sql:string)=>{seen.push(sql);if(sql.includes('AS "databaseName"'))return{rows:[identity]};if(sql.includes('AS "ownsBusinessSchema"'))return{rows:[{ownsBusinessSchema:false,ownsBusinessRelation:false,hasPrivilegedMembership:false,...unsafe}]};return{rows:[row]};}} as unknown as PoolClient;
 return{c,seen};
}
test('controlled regression factories reuse the exact resource and keep independent object brands',async()=>{
 const config=regressionConfig(),p=regressionClient(),resource=createControlledRegressionResource(config,regressionBinding,'CHANNEL_REQUEST');
 await assertControlledRegressionResource(p.c,resource,'CHANNEL_REQUEST');
 await assert.rejects(assertControlledRegressionResource(p.c,resource,'DISTRIBUTION'));
 const before=p.seen.length;await assert.rejects(assertControlledRegressionResource(p.c,{...resource},'CHANNEL_REQUEST'));assert.equal(p.seen.length,before);
 const capability=createSyntheticChannelRequestCapability({config,resourceSet:'regression',regression:regressionBinding,evidenceLevel:'CONTROLLED_TEST',allowedOrderIds:['one']});
 assert.equal(await assertSyntheticChannelRequestCapability(p.c,capability),'CONTROLLED_TEST');assertSyntheticChannelRequestOrder(capability,'one');assert.throws(()=>assertSyntheticChannelRequestOrder(capability,'other'));assert.throws(()=>assertSyntheticChannelRequestOrder({...capability},'one'));
 const withdrawal=createNativeWithdrawalScope({config,resourceSet:'regression',resourceOid:2220718,regression:regressionBinding,bindings:options().bindings});
 assert.equal((await assertNativeWithdrawalResource(p.c,withdrawal)).marker,'zzsh:regression-test:v1');assert.throws(()=>nativeWithdrawalBindings({...withdrawal},'user'));
 const distribution=createControlledRegressionDistributionScope({config,binding:regressionBinding,approvalDigest:'a'.repeat(64),allowedOrderIds:['one']});
 await assertDistributionOrderScopeResource(p.c,distribution);assert.equal(createDistributionEarningStore(distribution).admitsOrder('one'),true);assert.equal(createDistributionEarningStore(distribution).admitsOrder('other'),false);
 assert.throws(()=>createPaymentDistributionStore({...distribution}));assert.throws(()=>createDistributionEarningStore({...distribution}));
});
test('regression resource use rejects OID, nonce, role OID, name, role and marker drift before a money query',async()=>{
 const resource=createControlledRegressionResource(regressionConfig(),regressionBinding,'WITHDRAWAL');
 for(const changed of [{oid:2220719},{name:'zzsh_dev_daily'},{role:'zzsh_regression_migration'},{role_oid:10},{marker:'zzsh:order-reservation-test:v1'},{nonce:'0'.repeat(24)}]){
  const p=regressionClient(changed);await assert.rejects(assertControlledRegressionResource(p.c,resource,'WITHDRAWAL'));assert(!p.seen.some(s=>/INSERT|UPDATE|DELETE|FOR UPDATE/.test(s)));
 }
});
test('regression runtime must pass the full existing safe-role checker',async()=>{
 for(const field of ['isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase','ownsBusinessSchema','ownsBusinessRelation','hasPrivilegedMembership','canUpdateAudit','canDeleteAudit','canTruncateAudit']){
  const p=regressionClient({}, {[field]:true}),resource=createControlledRegressionResource(regressionConfig(),regressionBinding,'DISTRIBUTION');await assert.rejects(assertControlledRegressionResource(p.c,resource,'DISTRIBUTION'));
 }
});
test('regression construction rejects real, production, daily and migration assemblies without any SQL',()=>{
 for(const mutate of [(c:AppConfig)=>c.profile='dev',(c:AppConfig)=>c.provider='real',(c:AppConfig)=>c.testOperationsEnabled=false,(c:AppConfig)=>c.database.targetProfile='dev',(c:AppConfig)=>c.database.name='zzsh_dev_daily',(c:AppConfig)=>c.database.runtimeUser='zzsh_regression_migration',(c:AppConfig)=>c.database.user='zzsh_regression_migration',(c:AppConfig)=>c.database.host='localhost']){
  const c=regressionConfig();mutate(c);assert.throws(()=>createControlledRegressionResource(c,regressionBinding,'WITHDRAWAL'));
 }
 const previous=process.env.NODE_ENV;try{process.env.NODE_ENV='production';assert.throws(()=>createControlledRegressionResource(regressionConfig(),regressionBinding,'DISTRIBUTION'));}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
 for(const changed of [{resourceOid:0},{nonce:'bad'},{runtimeRoleOid:0}])assert.throws(()=>createControlledRegressionResource(regressionConfig(),{...regressionBinding,...changed},'CHANNEL_REQUEST'));
});
test('bounded regression objects cannot be expanded through caller mutation or empty, duplicate and oversized allowlists',()=>{
 const ids=['one'],config=regressionConfig(),cap=createSyntheticChannelRequestCapability({config,resourceSet:'regression',regression:regressionBinding,evidenceLevel:'CONTROLLED_TEST',allowedOrderIds:ids});ids.push('other');assert.throws(()=>assertSyntheticChannelRequestOrder(cap,'other'));
 for(const list of [[],['one','one'],Array.from({length:11},(_,i)=>'order'+i)]){
  assert.throws(()=>createSyntheticChannelRequestCapability({config,resourceSet:'regression',regression:regressionBinding,evidenceLevel:'CONTROLLED_TEST',allowedOrderIds:list}));
  assert.throws(()=>createControlledRegressionDistributionScope({config,binding:regressionBinding,approvalDigest:'a'.repeat(64),allowedOrderIds:list}));
 }
 assert.throws(()=>createSyntheticChannelRequestCapability({config,resourceSet:'regression',regression:regressionBinding,evidenceLevel:'SYNTHETIC_PROTOCOL',allowedOrderIds:['one']}));
 assert.throws(()=>createNativeWithdrawalScope({config,resourceSet:'regression',resourceOid:2220719,regression:regressionBinding,bindings:options().bindings}));
});
