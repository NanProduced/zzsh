import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { delimiter, join, resolve } from 'node:path';

const root=resolve('.'),api=resolve(process.env.ZZSH_DISTRIBUTION_SECURITY_BUILD??'tmp/r05-local-review-20261105/api/dist/src');
const available=existsSync(join(api,'auth/auth-runtime.js'))&&existsSync(join(api,'finance/distribution-policy-store.js'));
process.env.NODE_PATH=[join(root,'apps/api/node_modules'),join(root,'node_modules')].join(delimiter);Module._initPaths();
const require=createRequire(import.meta.url);

test('inert runtime reuses Better Auth without listener or providers and refuses HTTP mounting of the NATIVE scope', {skip:!available&&'isolated compiled API unavailable'}, async()=>{
  const {mountAuthHandlers}=require(join(api,'auth/auth-runtime.js'));
  const {createControlledRegressionResource}=require(join(api,'finance/controlled-regression-resource.js'));
  const store=require(join(api,'finance/distribution-policy-store.js'));
  let queries=0,connections=0;const pool={query:async(sql,args)=>{queries++;if(sql.includes('FROM unnest'))return{rows:args[0].map(name=>({name,present:true,readable:true}))};if(sql.includes('runtime_contract_version()'))return{rows:[{version:1,schemaCreate:false}]};throw Error('UNEXPECTED_DB_QUERY')},connect:async()=>{connections++;throw Error('NO_DATABASE_CONNECTION')}};
  const sink=new Proxy({}, {get:()=>()=>sink}),app={getHttpAdapter:()=>({getInstance:()=>sink}),get:()=>{throw Error('LIFECYCLE_FORBIDDEN')}};
  const previous=process.env.NODE_ENV;process.env.NODE_ENV='test';
  try{
    const security=await mountAuthHandlers(app,{pool,apiOrigin:'http://127.0.0.1:4241',adminOrigin:'http://127.0.0.1:4231',userOrigin:'http://127.0.0.1:4230',userSecret:'fixture-user-secret-000000000000000000000',adminSecret:'fixture-admin-secret-00000000000000000000',secureCookies:false,testOperationsEnabled:false,localSmsMock:false});
    for(const fn of ['getSession','verifyPassword','verifyTOTP'])assert.equal(typeof security.adminAuth.api[fn],'function');
    const config={profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',targetProfile:'test',host:'127.0.0.1',port:55432,name:'zzsh_test_regression',user:'zzsh_regression_runtime',runtimeUser:'zzsh_regression_runtime'}};
    const proof=createControlledRegressionResource(config,{resourceOid:123,nonce:'a'.repeat(24),runtimeRoleOid:456},'DISTRIBUTION');
    const scope=store.createReviewedLocalNativeDistributionScope(proof,{owner:'zzsh',ownerOid:10});
    assert.equal(store.distributionPolicyScopeOf(scope),'NATIVE');assert.throws(()=>store.assertLocalDistributionAssembly(scope,{}),/OFFLINE_ONLY/);
    assert.equal(queries,2);assert.equal(connections,0);
  }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});
