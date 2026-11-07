import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { normalizeRegisteredTarget } from './local-target-registry.mjs';
import { assertR07BootstrapInputs, assertR07ProvidersClosed, makeR07BootstrapBundle } from './run-round07-bootstrap-api.mjs';

const instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'},nonce='a'.repeat(24),hash='b'.repeat(64);
const registered=normalizeRegisteredTarget({database:'zzsh_test_regression',marker:'zzsh:regression-test:v1',oid:'123',nonce,owner:'zzsh',instance,
 roles:{migration:{name:'zzsh_regression_migration',oid:'790'},runtime:{name:'zzsh_regression_runtime',oid:'789'}}});
const target={oid:'123',nonce,instance,migrationRoleOid:'790',bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED',schemaHashes:[hash]};
const schema={status:'CLEAN_SCHEMA_INSTALLED',oid:'123',nonce,instance,finalOrdinal:160,commitAck:true,migrationAck:true,runtimeAclReadback:true,
 journalSha256:hash,historySha256:hash,hashes:[hash],readbackRollbackAck:true,readbackClientClosed:true,unlockAck:true,maintenanceClosed:true};
const request={schema:'zzsh.round07-bootstrap-runtime-request.v1',target,port:4242,
 origins:{apiOrigin:'http://127.0.0.1:4242',userOrigin:'http://127.0.0.1:4240',adminOrigin:'http://127.0.0.1:4241'}};

test('bootstrap API refuses another instance, live page port or incomplete schema receipt',()=>{
 assert.doesNotThrow(()=>assertR07BootstrapInputs(request,registered,schema));
 assert.throws(()=>assertR07BootstrapInputs({...request,port:4232},registered,schema));
 assert.throws(()=>assertR07BootstrapInputs(request,registered,{...schema,instance:{...instance,systemIdentifier:'999'}}));
 assert.throws(()=>assertR07BootstrapInputs(request,registered,{...schema,runtimeAclReadback:false}));
 assert.throws(()=>assertR07BootstrapInputs(request,registered,{...schema,hashes:['c'.repeat(64)]}));
});
test('bootstrap API defaults to a no-connection plan',()=>{
 const p=spawnSync(process.execPath,[new URL('./run-round07-bootstrap-api.mjs',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')],{encoding:'utf8'});
 assert.equal(p.status,0);const x=JSON.parse(p.stdout);assert.equal(x.status,'PLAN_ONLY');assert.equal(x.connections,0);assert.equal(x.started,false);
});
test('bootstrap bundle pins the exact compiled files and build/source lineage',()=>{
 const files={'app.js':hash},manifest={schema:'zzsh.round07-preview-build.v1',sourceSnapshotManifestSha256:hash,layout:{apiDistDir:'apps/api/dist/src'},components:{api:[{path:'apps/api/dist/src/app.js',sha256:hash}]}};
 const result=makeR07BootstrapBundle(files,manifest,hash,hash);assert.equal(result.finalBuildManifestSha256,hash);assert.equal(result.finalSourceManifestSha256,hash);
 assert.throws(()=>makeR07BootstrapBundle({'app.js':'c'.repeat(64)},manifest,hash,hash),/BOOTSTRAP_BUILD_CONTENT_CHANGED/);
 assert.throws(()=>makeR07BootstrapBundle(files,manifest,hash,'c'.repeat(64)),/BOOTSTRAP_BUILD_LINEAGE_CHANGED/);
});
test('bootstrap refuses a provider or worker if the loader supplies one',()=>{
 assert.doesNotThrow(()=>assertR07ProvidersClosed({yunxin:{enabled:false}},{}));
 for(const [config,auth] of [[{yunxin:{enabled:true}},{}],[{yunxin:{enabled:false},orderTeams:{}},{}],[{yunxin:{enabled:false}},{userSmsSender:{}}],[{yunxin:{enabled:false}},{testOperationsEnabled:true}]])
  assert.throws(()=>assertR07ProvidersClosed(config,auth),/BOOTSTRAP_PROVIDER_OR_WORKER_NOT_CLOSED/);
});
test('actual configuration accepts the isolated port and explicit no-provider profile without connecting',()=>{
 const code=String.raw`
 const fs=require('fs'),ts=require('typescript');require('reflect-metadata');
 require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,f);
 const {loadConfig}=require('./apps/api/src/config/config.ts'),{loadAuthRuntimeConfig}=require('./apps/api/src/auth/auth-runtime.ts');
 const env={APP_PROFILE:'test',PROVIDER_MODE:'fake',NODE_ENV:'development',HOST:'127.0.0.1',PORT:'4242',DB_TARGET:'local-compose',DB_HOST:'127.0.0.1',DB_PORT:'55433',DB_NAME:'zzsh_test_regression',DB_USER:'runtime',DB_PASSWORD:'fixture',REDIS_HOST:'127.0.0.1',REDIS_PORT:'56379',REDIS_PASSWORD:'fixture',AUTH_API_ORIGIN:'http://127.0.0.1:4242',AUTH_USER_ORIGIN:'http://127.0.0.1:4240',AUTH_ADMIN_ORIGIN:'http://127.0.0.1:4241',AUTH_USER_SECRET:'u'.repeat(40),AUTH_ADMIN_SECRET:'a'.repeat(40),AUTH_ADMIN_BOOTSTRAP_SECRET:'b'.repeat(40),USER_IDENTITY_SUBJECT_HMAC_KEY:'i'.repeat(40),LISTING_CURSOR_SECRET:'l'.repeat(40),LISTING_CURSOR_KEY_ID:'r07-bootstrap',AUTH_LOCAL_SMS_MOCK:'true',YUNXIN_ENABLED:'false',USER_SMS_PROVIDER:'disabled',USER_REAL_NAME_PROVIDER:'disabled'};
 const c=loadConfig(env,process.cwd()),a=loadAuthRuntimeConfig(env,process.cwd(),{testOperationsEnabled:false});
 if(c.database.port!==55433||c.yunxin.enabled!==false||a.userSmsSender||a.realNameProvider||a.testOperationsEnabled)process.exit(2);`;
 const result=spawnSync(process.execPath,['-e',code],{cwd:process.cwd(),encoding:'utf8',timeout:30000,windowsHide:true});
 assert.equal(result.status,0,result.stderr);
});
