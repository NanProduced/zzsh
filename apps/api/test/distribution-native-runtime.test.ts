import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {loadNativeDistributionRuntime} from '../src/finance/distribution-native-runtime';
import {loadDistributionDueRuntime} from '../src/finance/distribution-due.module';
import {createNativeDistributionEarningStore,createDistributionEarningStore} from '../src/finance/distribution-earning-store';
import {assertLocalDistributionAssembly, distributionPolicyScopeOf} from '../src/finance/distribution-policy-store';
import {bindJoinpayCollectionProfile,bindFormalJoinpayCollectionAdmission,readFormalCollectionAdmission,COLLECTION_REQUIRED_RULES,type CollectionProfileOperation,type CollectionServerProfile} from '../src/order/joinpay-collection-profile';
import {JOINPAY_SIGNATURE_ORDER} from '../src/order/joinpay-protocol';
import {assertSettlementDatabase,assertSettlementReadDatabase,settlementReadIdentity,lockSettlement,settlementSurfaceOpen} from '../src/order/settlement-record';
import {createNativeWalletOriginResource,createControlledNativeWalletOriginResource,createProvisionedNativeWalletOriginResource,assertNativeWalletOriginAssembly,initializeNativeWalletOrigin} from '../src/finance/native-wallet-origin';

const config={provider:'real' as const,database:{name:'zzsh_prod',user:'zzsh_runtime',runtimeUser:'zzsh_runtime'} as any};
const KEY='SYNTHETIC_PUBLIC_VECTOR_ONLY',MERCHANT='888000000000001';
const sign=(names:readonly string[],values:Record<string,string>)=>createHash('md5').update(names.map(n=>values[n]??'').join('')+KEY).digest('hex');
function descriptor():CollectionServerProfile{
 const evidence={source:'JOINPAY_OFFICIAL' as const,reference:'fixture_document_reference',sha256:'1'.repeat(64)};
 const answer=(names:readonly string[])=>{const values=Object.fromEntries(names.map((n,i)=>[n,'value'+i]));return{...evidence,values,vectorKey:KEY,expectedHmac:sign(names,values)};};
 return{profileId:'fixture_profile',merchantIdentityId:'fixture_merchant',wireMerchantNo:MERCHANT,tradeMerchantNo:'fixture_trade',notifyUrl:'https://merchant.fixture.test/notify',purpose:'COLLECTION',evidenceMode:'OFFICIAL',
  operations:Object.fromEntries((['SUBMIT','QUERY','NOTIFY'] as CollectionProfileOperation[]).map(op=>[op,{keyVersionRef:'fixture_key',rules:Object.fromEntries(COLLECTION_REQUIRED_RULES[op].map(r=>[r,evidence])),
   requestKnownAnswer:op==='NOTIFY'?'NOT_OBTAINED':answer(JOINPAY_SIGNATURE_ORDER[op==='SUBMIT'?'uniPayRequest':'queryOrderRequest']),
   responseKnownAnswer:answer(JOINPAY_SIGNATURE_ORDER[op==='SUBMIT'?'uniPaySyncResponse':op==='QUERY'?'queryOrderResponse':'asyncNotify']),
   ...(op==='SUBMIT'?{}:{timeOffsetMinutes:480}),...(op==='NOTIFY'?{notificationDecoding:{ra_PayTime:0,rb_DealTime:0}}:{})}]))};
}
function admission(overrides:Partial<Parameters<typeof bindFormalJoinpayCollectionAdmission>[0]>={}){const input=descriptor(),profile=bindJoinpayCollectionProfile(input);
 return bindFormalJoinpayCollectionAdmission({kind:'JOINPAY_FORMAL_SERVER_REVIEW',reference:'fixture_review',reviewSha256:'2'.repeat(64),appId:'fixture_app',
  database:'zzsh_prod',runtimeUser:'zzsh_runtime',merchantIdentityId:input.merchantIdentityId,wireMerchantNo:MERCHANT,profiles:[profile],...overrides});}

test('formal settlement needs both explicit enablement and a branded admission, including production',()=>{
 const previous=process.env.NODE_ENV;
 process.env.NODE_ENV='production';
 try{
  const bound=admission();
  assert.equal(settlementSurfaceOpen(false,bound),false);
  assert.equal(settlementSurfaceOpen(undefined,bound),false);
  assert.equal(settlementSurfaceOpen(true,bound),true);
  assert.equal(settlementSurfaceOpen(true),false,'old local flags do not enable production');
  assert.throws(()=>settlementSurfaceOpen(true,{kind:'FORMAL_JOINPAY_COLLECTION'} as never),{code:'COLLECTION_FORMAL_ADMISSION_NOT_BOUND'});
 }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});

test('formal settlement keeps exact database and non-owner runtime privileges',async()=>{
 const bound=admission(),role={databaseName:'zzsh_prod',currentUser:'zzsh_runtime',owner:'zzsh_migration',...Object.fromEntries([
  'isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase','canCreateIamSchema','canCreateUserSchema',
  'canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema','canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit',
 ].map(key=>[key,false]))},ownership={ownsBusinessSchema:false,ownsBusinessRelation:false,hasPrivilegedMembership:false};
 const client=(changes:Record<string,unknown>={},ownershipChanges:Record<string,unknown>={},functions:Record<string,unknown>={ownsBusinessFunctions:false})=>({query:async(sql:string)=>{
  if(sql.includes('AS "databaseName"'))return{rows:[{...role,...changes}]};
  if(sql.includes('AS "ownsBusinessSchema"'))return{rows:[{...ownership,...ownershipChanges}]};
  assert.match(sql,/ownsBusinessFunctions/);return{rows:[functions]};
 }} as unknown as PoolClient);
 await assertSettlementDatabase(client(),bound);
 for(const mismatch of [{databaseName:'other'},{currentUser:'other'},{owner:'zzsh_runtime'},...Object.keys(role).filter(k=>typeof role[k as keyof typeof role]==='boolean').map(k=>({[k]:true}))]){
  await assert.rejects(assertSettlementDatabase(client(mismatch),bound),(error:unknown)=>(error as{status?:number}).status===503);
 }
 for(const key of Object.keys(ownership))await assert.rejects(assertSettlementDatabase(client({},{[key]:true}),bound));
 for(const value of [{ownsBusinessFunctions:true},{ownsBusinessFunctions:null},{}])await assert.rejects(assertSettlementDatabase(client({}, {},value),bound));
 let queries=0;
 await assert.rejects(assertSettlementDatabase({query:async()=>{queries++;return{rows:[role]};}} as unknown as PoolClient,{kind:'FORMAL_JOINPAY_COLLECTION'} as never));
 assert.equal(queries,0,'forged admission is rejected before touching a database');
});

test('no formal settlement admission keeps the original controlled resource guard',async()=>{
 const client=(db:string,actor:string)=>({query:async()=>({rows:[{db,actor}]})} as unknown as PoolClient);
 await assertSettlementDatabase(client('zzsh_test_order_fixture','zzsh_order_fixture_r'));
 await assert.rejects(assertSettlementDatabase(client('zzsh_test_regression','zzsh_regression_runtime')));
 await assert.rejects(assertSettlementDatabase(client('zzsh_prod','zzsh_runtime')));
});

test('settlement reads bind the server pool identity without merchant evidence and never authorize writes',async()=>{
 const pool={options:{database:'zzsh_test_regression',user:'zzsh_regression_runtime'}},identity=settlementReadIdentity(pool)!;
 assert.deepEqual(identity,{database:'zzsh_test_regression',runtimeUser:'zzsh_regression_runtime'});
 pool.options.user='changed';assert.equal(identity.runtimeUser,'zzsh_regression_runtime');assert.equal(settlementReadIdentity({}),undefined);
 const safe={databaseName:identity.database,currentUser:identity.runtimeUser,owner:'zzsh',...Object.fromEntries([
  'isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase','canCreateIamSchema','canCreateUserSchema',
  'canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema','canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit',
 ].map(key=>[key,false]))};
 const make=(changes:Record<string,unknown>={})=>({query:async(sql:string)=>({rows:sql.includes('AS "databaseName"')?[{...safe,...changes}]:[{ownsBusinessSchema:false,ownsBusinessRelation:false,hasPrivilegedMembership:false}]})} as unknown as PoolClient);
 await assertSettlementReadDatabase(make(),identity);
 for(const change of [{databaseName:'other'},{currentUser:'other'},{isSuperuser:true},{canUpdateAudit:true}])await assert.rejects(assertSettlementReadDatabase(make(change),identity));
 let writes=0;const c={query:async(sql:string)=>{if(/^(UPDATE|INSERT|DELETE)/.test(sql))writes++;return{rows:[{db:identity.database,actor:identity.runtimeUser}]};}} as unknown as PoolClient;
 await assert.rejects(lockSettlement(c,'order',{realm:'user',userId:'user',sessionId:'session',settlementReadIdentity:identity},true));assert.equal(writes,0);
});

test('formal native wallet origin reuses the full runtime privilege guard and never initializes an old subject',async()=>{
 const bound=admission(),resource=createNativeWalletOriginResource(bound);
 assert.equal(assertNativeWalletOriginAssembly(resource,bound),true);
 assert.throws(()=>assertNativeWalletOriginAssembly(resource,admission()));
 const role={databaseName:'zzsh_prod',currentUser:'zzsh_runtime',owner:'zzsh_migration',...Object.fromEntries([
  'isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase','canCreateIamSchema','canCreateUserSchema',
  'canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema','canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit',
 ].map(key=>[key,false]))};
 const ownership={ownsBusinessSchema:false,ownsBusinessRelation:false,hasPrivilegedMembership:false};
 const make=(changes:Record<string,unknown>={},ownershipChanges:Record<string,unknown>={},proof=true)=>{
  let initialized=0;
  const client={query:async(sql:string)=>{
   if(sql.startsWith('SELECT to_regprocedure'))return{rows:[{installed:true,oid:42,name:'zzsh_prod',role:'zzsh_runtime',marker:'production-reviewed'}]};
   if(sql.includes('AS "databaseName"'))return{rows:[{...role,...changes}]};
   if(sql.includes('AS "ownsBusinessSchema"'))return{rows:[{...ownership,...ownershipChanges}]};
   if(sql.startsWith('SELECT u.id'))return{rows:proof?[{id:'new',identity_version:'1',insertion_xid:'123'}]:[]};
   if(sql.startsWith('SELECT zzsh_order.initialize')){initialized++;return{rows:[{result:{knowledge:'KNOWN',origin:'NATIVE_GENESIS',availableCents:'0'}}]};}
   throw Error('Unexpected native origin query');
  }} as unknown as PoolClient;
  return{client,initialized:()=>initialized};
 };
 const good=make();assert.equal((await initializeNativeWalletOrigin(good.client,'new','request',resource)).knowledge,'KNOWN');assert.equal(good.initialized(),1);
 for(const key of ['canCreateRole','canCreateDb','canReplicate','canBypassRls','canUpdateAudit','canDeleteAudit','canTruncateAudit']){
  const unsafe=make({[key]:true});await assert.rejects(initializeNativeWalletOrigin(unsafe.client,'new','request',resource));assert.equal(unsafe.initialized(),0);
 }
 for(const key of ['ownsBusinessSchema','ownsBusinessRelation','hasPrivilegedMembership']){
  const unsafe=make({},{[key]:true});await assert.rejects(initializeNativeWalletOrigin(unsafe.client,'new','request',resource));assert.equal(unsafe.initialized(),0);
 }
 const old=make({},{},false);await assert.rejects(initializeNativeWalletOrigin(old.client,'old','request',resource));assert.equal(old.initialized(),0);
 const forged=make();assert.equal((await initializeNativeWalletOrigin(forged.client,'new','request',{kind:'NATIVE_WALLET_ORIGIN'})).knowledge,'UNKNOWN');assert.equal(forged.initialized(),0);
});

test('controlled regression native genesis binds exact live identity and still requires a fresh birth proof plus owner row',async()=>{
 const config={profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',targetProfile:'test',host:'127.0.0.1',port:55432,name:'zzsh_test_regression',user:'zzsh_regression_runtime',runtimeUser:'zzsh_regression_runtime'}} as any;
 const input={config,resourceOid:42,nonce:'a'.repeat(24),runtimeRoleOid:99},resource=createControlledNativeWalletOriginResource(input);
 assert.equal(assertNativeWalletOriginAssembly(resource,undefined),false);assert.throws(()=>assertNativeWalletOriginAssembly(resource,admission()));
 const role={databaseName:config.database.name,currentUser:config.database.user,owner:'zzsh',...Object.fromEntries([
  'isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase','canCreateIamSchema','canCreateUserSchema',
  'canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema','canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit',
 ].map(key=>[key,false]))};
 const make=(changes:Record<string,unknown>={},fresh=true,ownerRow=true)=>{let writes=0;
  const client={query:async(sql:string)=>{
   if(sql.startsWith('SELECT to_regprocedure'))return{rows:[{installed:true,oid:42,name:config.database.name,role:config.database.user,role_oid:99,nonce:input.nonce,marker:'zzsh:regression-test:v1',...changes}]};
   if(sql.includes('AS "databaseName"'))return{rows:[role]};
   if(sql.includes('AS "ownsBusinessSchema"'))return{rows:[{ownsBusinessSchema:false,ownsBusinessRelation:false,hasPrivilegedMembership:false}]};
   if(sql.startsWith('SELECT u.id'))return{rows:fresh?[{id:'new',identity_version:'1',insertion_xid:'123'}]:[]};
   if(sql.startsWith('SELECT zzsh_order.initialize')){writes++;return{rows:[{result:ownerRow?{knowledge:'KNOWN',origin:'NATIVE_GENESIS',availableCents:'0'}:{knowledge:'UNKNOWN',reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'}}]};}
   throw Error('Unexpected native-origin boundary');
  }} as unknown as PoolClient;return{client,writes:()=>writes};
 };
 const good=make();assert.equal((await initializeNativeWalletOrigin(good.client,'new','request',resource)).knowledge,'KNOWN');assert.equal(good.writes(),1);
 for(const mismatch of [{oid:43},{name:'other'},{role:'other'},{role_oid:100},{marker:'other'},{nonce:'b'.repeat(24)}]){
  const bad=make(mismatch);assert.equal((await initializeNativeWalletOrigin(bad.client,'new','request',resource)).knowledge,'UNKNOWN');assert.equal(bad.writes(),0);
 }
 const old=make({},false);await assert.rejects(initializeNativeWalletOrigin(old.client,'old','request',resource));assert.equal(old.writes(),0);
 const missing=make({},true,false);assert.deepEqual(await initializeNativeWalletOrigin(missing.client,'new','request',resource),{knowledge:'UNKNOWN',reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'});
 for(const changed of [{...config,provider:'real'},{...config,profile:'production'},{...config,testOperationsEnabled:false},{...config,database:{...config.database,host:'remote'}}])assert.throws(()=>createControlledNativeWalletOriginResource({...input,config:changed}));
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';try{
  assert.throws(()=>createControlledNativeWalletOriginResource(input));assert.throws(()=>assertNativeWalletOriginAssembly(resource,undefined));
  const prod=make();assert.equal((await initializeNativeWalletOrigin(prod.client,'new','request',resource)).knowledge,'UNKNOWN');assert.equal(prod.writes(),0);
 }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});

test('merchant-independent provisioned genesis rejects a cross-database formal assembly',()=>{
 const resource=createProvisionedNativeWalletOriginResource({profile:'production',database:{targetProfile:'production',name:'zzsh_prod',user:'zzsh_runtime',runtimeUser:'zzsh_runtime'}} as any);
 assert.equal(assertNativeWalletOriginAssembly(resource,undefined),false);
 assert.equal(assertNativeWalletOriginAssembly(resource,admission()),false,'same resource does not turn the origin into a financial channel capability');
 assert.throws(()=>assertNativeWalletOriginAssembly(resource,admission({database:'zzsh_prod_other'})));
 assert.throws(()=>assertNativeWalletOriginAssembly(resource,admission({runtimeUser:'zzsh_other_r'})));
});

test('native distribution is off unless explicitly enabled and never derives a policy or ratio',()=>{
 assert.equal(loadNativeDistributionRuntime({config,authEnabled:true,admission:undefined,env:{}}),undefined);
 assert.throws(()=>loadNativeDistributionRuntime({config,authEnabled:true,admission:undefined,env:{DISTRIBUTION_NATIVE_ENABLED:'yes'}}),/DISTRIBUTION_NATIVE_ENABLED_INVALID/);
});

test('native distribution refuses a non-formal runtime or missing collection admission',()=>{
 assert.throws(()=>loadNativeDistributionRuntime({config:{...config,provider:'fake' as any},authEnabled:true,admission:undefined,env:{DISTRIBUTION_NATIVE_ENABLED:'true'}}),/DISTRIBUTION_NATIVE_RUNTIME_CONTEXT_INVALID/);
 assert.throws(()=>loadNativeDistributionRuntime({config,authEnabled:false,admission:undefined,env:{DISTRIBUTION_NATIVE_ENABLED:'true'}}),/DISTRIBUTION_NATIVE_RUNTIME_CONTEXT_INVALID/);
 assert.throws(()=>loadNativeDistributionRuntime({config,authEnabled:true,admission:undefined,env:{DISTRIBUTION_NATIVE_ENABLED:'true'}}),/FORMAL_COLLECTION_ADMISSION/);
});

test('a bound formal admission yields NATIVE policy and earning capabilities without creating policy or ratios',()=>{
 const runtime=loadNativeDistributionRuntime({config,authEnabled:true,admission:admission(),env:{DISTRIBUTION_NATIVE_ENABLED:'true'}});
 assert(runtime);
 assert.equal(distributionPolicyScopeOf(runtime.auth.distributionScope),'NATIVE');
 assert.equal(runtime.auth.distributionReadScope,runtime.auth.distributionScope);
 assert.equal(typeof runtime.auth.distributionEarnings.discover,'function');
 assert.equal(typeof runtime.auth.distributionEarnings.replay,'function');
 assertLocalDistributionAssembly(runtime.auth.distributionScope,{testOperationsEnabled:false,secureCookies:true,apiOrigin:'https://api.example.test',userOrigin:'https://www.example.test',adminOrigin:'https://admin.example.test'});
 assert.throws(()=>assertLocalDistributionAssembly(runtime.auth.distributionScope,{testOperationsEnabled:true,secureCookies:false,apiOrigin:'http://127.0.0.1:4232',userOrigin:'http://127.0.0.1:4230',adminOrigin:'http://127.0.0.1:4231'}),/secure non-local/);
 assert.throws(()=>loadNativeDistributionRuntime({config:{...config,database:{...config.database,name:'other_database'}},authEnabled:true,admission:admission(),env:{DISTRIBUTION_NATIVE_ENABLED:'true'}}),/RESOURCE_MISMATCH/);
});

test('bounded maintenance rejects oversized, duplicate or malformed cohorts before any database work',async()=>{
 const store=createDistributionEarningStore({resourceSet:'credit_admin_batch2',resourceOid:1,approvalDigest:'a'.repeat(64),allowedOrderIds:['order']});
 const pool={} as Pool;
 await assert.rejects(store.discover(pool,{limit:0}),/Bounded accrual discovery/);
 await assert.rejects(store.discover(pool,{limit:101}),/Bounded accrual discovery/);
 await assert.rejects(store.replay(pool,['order','order'],'req'),/bounded unique order cohort/);
 await assert.rejects(store.replay(pool,[],'req'),/bounded unique order cohort/);
 await assert.rejects(store.replay(pool,['order'],'bad id'),/bounded unique order cohort/);
 await assert.rejects(store.settleDue(pool,1,'req',['bad id']),/Bounded game scope/);
 await assert.rejects(store.settleDue(pool,0,'req'),/Bounded due batch/);
});

test('real auth assembly accepts the exact native capabilities and rejects cross-wired admission before database work',async()=>{
 const {mountAuthHandlers}=require('../src/auth/auth-runtime');
 const bound=admission(),runtime=loadNativeDistributionRuntime({config,authEnabled:true,admission:bound,env:{DISTRIBUTION_NATIVE_ENABLED:'true'}})!;
 let calls=0;
 const options:any={...runtime.auth,joinpayCollection:{admission:bound},testOperationsEnabled:false,secureCookies:true,
  apiOrigin:'https://api.example.test',userOrigin:'https://www.example.test',adminOrigin:'https://admin.example.test',
  pool:{query:async()=>{calls++;throw new Error('PG_BOUNDARY');},connect:async()=>{calls++;throw new Error('PG_BOUNDARY');}}};
 await assert.rejects(mountAuthHandlers({},options),/Credit\/guarantee reads require reviewed schema or runtime privileges/);assert.equal(calls,1);
 calls=0;await assert.rejects(mountAuthHandlers({},{...options,joinpayCollection:{admission:admission()}}),/ASSEMBLY_MISMATCH/);assert.equal(calls,0);
 await assert.rejects(mountAuthHandlers({},{...options,distributionScope:undefined}),/ASSEMBLY_MISMATCH/);assert.equal(calls,0);
 await assert.rejects(mountAuthHandlers({},{...options,localControlledPayments:{}}),/exclusive/);assert.equal(calls,0);
});

test('native reversal uses an explicitly accepted original admission after rotation, never the current hash',async()=>{
 const {canonicalize}=require('../src/supply/content-hash'),{earningEconomicKey}=require('../src/finance/distribution-mechanism');
 const a=admission(),view=readFormalCollectionAdmission(a),b=admission({reference:'fixture_next',reviewSha256:'3'.repeat(64),acceptedInitialAdmissions:[{reference:view.reference,sha256:view.sha256}]}),unaccepted=admission({reference:'fixture_unaccepted',reviewSha256:'4'.repeat(64)});
 const h='a'.repeat(64),at='2026-10-04T00:00:00.000123Z',hash=(x:string)=>createHash('sha256').update(x).digest('hex');
 const source={kind:'NATIVE_RENTAL_REFERRAL',type:'NATIVE',system:'zzsh',entity:'rental_order',id:'order',digest:h,eventAt:at};
 const seed:any={id:'earning',economicKey:earningEconomicKey(source,'beneficiary','RENTER_REFERRAL'),source,beneficiaryUserId:'beneficiary',role:'RENTER_REFERRAL',policyVersion:'policy',policyDigest:h,baseDigest:h,relationDigest:h,amountCents:'100',dueAt:at,fingerprint:h,state:'PENDING',fundsDisposition:'PENDING',recoveryRequiredCents:null,version:'1'};
 for(const action of ['REVOKE','RECOVER'] as const){
  const make=(wrongDigest=false)=>{let writes=0;
   const row={id:seed.id,economic_root_id:seed.id,economic_key:seed.economicKey,beneficiary_role:seed.role,posting_digest:h,order_id:'order',payment_confirmation_id:'payment',beneficiary_user_id:'beneficiary',amount_cents:'100',due_exact:at,canonical_seed:canonicalize(seed),seed_digest:hash(canonicalize(seed)),basis_digest:h,state:action==='RECOVER'?'RECOVERY_REQUIRED':'SETTLED',funds_disposition:'SETTLED',version:action==='RECOVER'?'3':'2',recovery_required_cents:action==='RECOVER'?'100':null};
   const original=canonicalize({schema:'rental-referral-reversal.v1',scope:'NATIVE',earningId:'earning',basisDigest:h,amountCents:'100'});
   const pool:any={connect:async()=>({release(){},query:async(sql:string)=>{
    if(/^(INSERT|UPDATE)/.test(sql))writes++;
    if(sql.startsWith('SELECT current_database() AS name'))return{rows:[{name:'zzsh_prod',role:'zzsh_runtime',complete:true}]};
    if(sql.startsWith('SELECT order_id'))return{rows:[{order_id:'order',beneficiary_user_id:'beneficiary'}]};
    if(sql.startsWith('SELECT e.*'))return{rows:[row]};
    if(sql.startsWith('SELECT * FROM zzsh_order.rental_referral_transition'))return{rows:[]};
    if(sql.startsWith('SELECT * FROM zzsh_order.rental_referral_reversal_source'))return{rows:[{id:'original',scope:'NATIVE',basis_digest:h,amount_cents:'100',canonical_source:original,source_digest:hash(original),approval_digest:wrongDigest?'f'.repeat(64):view.sha256}]};
    if(sql.startsWith('SELECT a.source_admission_ref'))return{rows:[{source_admission_ref:view.reference,approval_digest:view.sha256}]};
    if(sql.startsWith('SELECT reversal_source_id'))return{rows:[{reversal_source_id:'original',finance_event_id:null}]};
    if(sql.startsWith('SELECT date_trunc'))return{rows:[{now:new Date('2026-10-31T00:00:00.000Z'),due:true}]};
    if(sql.startsWith('SELECT 1 FROM zzsh_order.wallet_coverage'))return{rows:[{}],rowCount:1};
    if(sql.startsWith('SELECT ledger_revision'))return{rows:[{revision:'5',available:'150'}]};
    if(sql.startsWith('UPDATE zzsh_order.rental_referral_earning'))return{rows:[],rowCount:1};
    return{rows:[]};
   }})};return{pool,version:row.version,writes:()=>writes};};
  for(const capability of [a,b]){const f=make();assert.equal((await createNativeDistributionEarningStore(capability).transition(f.pool,'earning',action,f.version,'request','original')).root.state,'REVOKED');assert(f.writes()>0);}
  const denied=make();await assert.rejects(createNativeDistributionEarningStore(unaccepted).transition(denied.pool,'earning',action,denied.version,'request','original'));assert.equal(denied.writes(),0);
  const wrong=make(true);await assert.rejects(createNativeDistributionEarningStore(b).transition(wrong.pool,'earning',action,wrong.version,'request','original'));assert.equal(wrong.writes(),0);
 }
});

test('native policy submission validates the bound native head rather than the local policy head',async()=>{
 const {validateDistributionPolicySubmission}=require('../src/finance/distribution-policy-approval'),{canonicalize}=require('../src/supply/content-hash');
 const runtime=loadNativeDistributionRuntime({config,authEnabled:true,admission:admission(),env:{DISTRIBUTION_NATIVE_ENABLED:'true'}})!;
 const policy={schema:'distribution-policy.v2',scope:'NATIVE',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary','custom'],minimumAccrualCents:'0',settlementDelayDays:7,rateMode:'UNIFORM',renterPercent:'5',ownerPercent:'5',levels:[]};
 const text=canonicalize(policy),digest=createHash('sha256').update(text).digest('hex');let nativeHeadReads=0;
 const client:any={query:async(sql:string,args:any[]=[])=>{
  if(sql.includes('current_database() AS name'))return{rows:[{name:'zzsh_prod',role:'zzsh_runtime',complete:true}]};
  if(sql.includes('pg_get_userbyid(d.datdba) AS owner'))return{rows:[{rolsuper:false,rolbypassrls:false,complete:true}]};
  if(sql.includes("to_regprocedure('zzsh_order.distribution_policy_contract_version()')"))return{rows:[{ready:true}]};
  if(sql.includes('distribution_policy_contract_version() AS version'))return{rows:[{version:2}]};
  if(sql.includes('FROM zzsh_order.distribution_policy_head h')){assert.equal(args[0],'NATIVE');nativeHeadReads++;return{rows:[{id:'native_policy',revision:'1',scope:'NATIVE',canonical_config:text,config_digest:digest,created_at:'2026-10-31T00:00:00Z'}]};}
  return{rows:[]};
 }};
 await validateDistributionPolicySubmission(client,{schema:'distribution-policy-change.v1',expectedPolicyId:'native_policy',expectedRevision:'1',expectedPolicyDigest:digest,changes:{renterPercent:'6'},reason:'synthetic policy change'},runtime.auth.distributionScope);
 assert.equal(nativeHeadReads,1);
});


test('due worker is opt-in, bounded and requires the explicit NATIVE assembly',()=>{
 const store={runDueBatch:async()=>({})} as any, pool={} as any;
 assert.equal(loadDistributionDueRuntime(pool,store,{}),undefined);
 assert.throws(()=>loadDistributionDueRuntime(undefined,store,{DISTRIBUTION_DUE_WORKER_ENABLED:'true'}),/explicit NATIVE/);
 assert.throws(()=>loadDistributionDueRuntime(pool,store,{DISTRIBUTION_DUE_WORKER_ENABLED:'true',DISTRIBUTION_DUE_INTERVAL_MS:'1000'}),/60000-3600000/);
 assert.throws(()=>loadDistributionDueRuntime(pool,store,{DISTRIBUTION_DUE_WORKER_ENABLED:'true',DISTRIBUTION_DUE_BATCH_LIMIT:'101'}),/1-100/);
 const runtime=loadDistributionDueRuntime(pool,store,{DISTRIBUTION_DUE_WORKER_ENABLED:'true'});assert.equal(runtime?.intervalMs,300000);assert.equal(runtime?.batchLimit,20);
});
