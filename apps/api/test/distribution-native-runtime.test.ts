import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import type {Pool} from 'pg';
import {loadNativeDistributionRuntime} from '../src/finance/distribution-native-runtime';
import {createDistributionEarningStore} from '../src/finance/distribution-earning-store';

const config={provider:'real' as const,database:{name:'zzsh_prod',user:'zzsh_runtime',runtimeUser:'zzsh_runtime'} as any};

test('native distribution is off unless explicitly enabled and never derives a policy or ratio',()=>{
 assert.equal(loadNativeDistributionRuntime({config,authEnabled:true,admission:undefined,env:{}}),undefined);
 assert.throws(()=>loadNativeDistributionRuntime({config,authEnabled:true,admission:undefined,env:{DISTRIBUTION_NATIVE_ENABLED:'yes'}}),/DISTRIBUTION_NATIVE_ENABLED_INVALID/);
});

test('native distribution refuses a non-formal runtime or missing collection admission',()=>{
 assert.throws(()=>loadNativeDistributionRuntime({config:{...config,provider:'fake' as any},authEnabled:true,admission:undefined,env:{DISTRIBUTION_NATIVE_ENABLED:'true'}}),/DISTRIBUTION_NATIVE_RUNTIME_CONTEXT_INVALID/);
 assert.throws(()=>loadNativeDistributionRuntime({config,authEnabled:false,admission:undefined,env:{DISTRIBUTION_NATIVE_ENABLED:'true'}}),/DISTRIBUTION_NATIVE_RUNTIME_CONTEXT_INVALID/);
 assert.throws(()=>loadNativeDistributionRuntime({config,authEnabled:true,admission:undefined,env:{DISTRIBUTION_NATIVE_ENABLED:'true'}}),/FORMAL_COLLECTION_ADMISSION/);
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
