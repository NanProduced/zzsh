import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {loadNativeDistributionRuntime} from '../src/finance/distribution-native-runtime';
import {createDistributionEarningStore} from '../src/finance/distribution-earning-store';
import {assertLocalDistributionAssembly, distributionPolicyScopeOf} from '../src/finance/distribution-policy-store';
import {bindJoinpayCollectionProfile,bindFormalJoinpayCollectionAdmission,COLLECTION_REQUIRED_RULES,type CollectionProfileOperation,type CollectionServerProfile} from '../src/order/joinpay-collection-profile';
import {JOINPAY_SIGNATURE_ORDER} from '../src/order/joinpay-protocol';

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
function admission(){const input=descriptor(),profile=bindJoinpayCollectionProfile(input);
 return bindFormalJoinpayCollectionAdmission({kind:'JOINPAY_FORMAL_SERVER_REVIEW',reference:'fixture_review',reviewSha256:'2'.repeat(64),appId:'fixture_app',
  database:'zzsh_prod',runtimeUser:'zzsh_runtime',merchantIdentityId:input.merchantIdentityId,wireMerchantNo:MERCHANT,profiles:[profile]});}

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
