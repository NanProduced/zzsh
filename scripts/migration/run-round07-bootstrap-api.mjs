import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { advisoryLockSql, assertLiveTarget, hasVerifiedNextInitialSchema, isRegisteredMigrationInstance, loadRegisteredTarget, maintenanceConnection, NEXT_MIGRATION_PROFILE, targetConnection, targetIdentityQuery } from './local-target-registry.mjs';
import { isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),privateRoot=resolve('E:/zzsh-local-state/restricted'),runtimeRoot=resolve('E:/zzsh-local-state/runtime'),mainApi=resolve('E:/zzsh/zzsh/apps/api');
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const R07_BOOTSTRAP_SECRET_FILES=Object.freeze({user:'AUTH_USER_SECRET_FILE',admin:'AUTH_ADMIN_SECRET_FILE',bootstrap:'AUTH_ADMIN_BOOTSTRAP_SECRET_FILE',redis:'REDIS_PASSWORD_FILE',identity:'USER_IDENTITY_SUBJECT_HMAC_KEY_FILE',identityProfile:'USER_LEGACY_IDENTITY_PROFILE_KEY_FILE',listing:'LISTING_CURSOR_SECRET_FILE'});
function inside(base,value,output=false){
 assert(typeof value==='string'&&isAbsolute(value),'BOOTSTRAP_PATH_REQUIRED');const p=resolve(value),rel=relative(base,p);
 assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'BOOTSTRAP_PATH_REQUIRED');
 for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'BOOTSTRAP_LINK_REFUSED');return p;
}
function pinned(ref,base=privateRoot){const p=inside(base,ref?.path),bytes=readFileSync(p);assert(hex(ref.sha256)&&sha(bytes)===ref.sha256,'BOOTSTRAP_INPUT_CHANGED');return JSON.parse(bytes);}
function pinnedBuild(ref){const p=resolve(ref?.path??''),base=p.toLowerCase().startsWith(resolve(root,'tmp').toLowerCase()+'\\')?resolve(root,'tmp'):privateRoot;return pinned(ref,base);}
function jsFiles(dir,prefix=''){const result={};for(const e of readdirSync(dir,{withFileTypes:true})){
 assert(!e.isSymbolicLink(),'BOOTSTRAP_LINK_REFUSED');const name=prefix+e.name,p=join(dir,e.name);
 if(e.isDirectory())Object.assign(result,jsFiles(p,name+'/'));else if(e.isFile()&&name.endsWith('.js'))result[name]=sha(readFileSync(p));
}return result;}
export function assertR07BootstrapInputs(request,registered,schema){
 const target=request?.target;
 assert(request?.schema==='zzsh.round07-bootstrap-runtime-request.v1'&&isRegisteredMigrationInstance(registered)&&!registered.pendingReset
   &&registered.database==='zzsh_test_regression'&&registered.marker==='zzsh:regression-test:v1'&&registered.migrationRoleOid&&registered.runtimeRoleOid
   &&registered.lockKey==='806006'&&registered.maintenanceDatabase==='postgres'
   &&target?.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'&&target.oid===registered.oid&&target.nonce===registered.nonce
   &&target.migrationRoleOid===registered.migrationRoleOid&&canonical(target.instance)===canonical(registered.instance)
   &&(target.migrationProfile??null)===(registered.migrationProfile??null)
   &&schema?.status==='CLEAN_SCHEMA_INSTALLED'&&schema.oid===target.oid&&schema.nonce===target.nonce&&canonical(schema.instance)===canonical(target.instance)
   &&(target.migrationProfile!==NEXT_MIGRATION_PROFILE||schema.migrationProfile===NEXT_MIGRATION_PROFILE
     &&schema.targetFence==='HELD_ACROSS_SCHEMA_AND_ACL'&&schema.targetFenceReleased===true&&hasVerifiedNextInitialSchema(schema))
   &&Number.isSafeInteger(schema.finalOrdinal)&&schema.finalOrdinal>=160&&schema.commitAck===true&&schema.migrationAck===true&&schema.runtimeAclReadback===true
   &&Array.isArray(target.schemaHashes)&&target.schemaHashes.length>0&&target.schemaHashes.every(hex)&&canonical(schema.hashes)===canonical(target.schemaHashes)&&hex(schema.journalSha256)&&hex(schema.historySha256)
   &&schema.readbackRollbackAck===true&&schema.readbackClientClosed===true&&schema.unlockAck===true&&schema.maintenanceClosed===true
   &&request.port===4242&&request.origins?.apiOrigin==='http://127.0.0.1:4242'&&request.origins?.userOrigin==='http://127.0.0.1:4240'
   &&request.origins?.adminOrigin==='http://127.0.0.1:4241','BOOTSTRAP_TARGET_OR_SCHEMA_CHANGED');
}

/** Bind runtime bytes to the same final build and source manifests as the migration loader. */
export function makeR07BootstrapBundle(buildFiles,manifest,buildSha,sourceSha){
 assert(hex(buildSha)&&hex(sourceSha)&&['zzsh.round06-preview-build.v1','zzsh.round07-preview-build.v1'].includes(manifest?.schema)
   &&manifest.sourceSnapshotManifestSha256===sourceSha&&typeof manifest.layout?.apiDistDir==='string'&&Array.isArray(manifest.components?.api),
 'BOOTSTRAP_BUILD_LINEAGE_CHANGED');
 const prefix=manifest.layout.apiDistDir.replaceAll('\\','/')+'/',rows=manifest.components.api.filter(x=>x.path?.startsWith(prefix)&&x.path.endsWith('.js'));
 const indexed=Object.fromEntries(rows.map(x=>[x.path.slice(prefix.length),x.sha256]));
 assert(rows.length===Object.keys(indexed).length&&rows.length>0&&Object.values(indexed).every(hex)&&canonical(indexed)===canonical(buildFiles),'BOOTSTRAP_BUILD_CONTENT_CHANGED');
 return {schema:'zzsh.round07-bootstrap-bundle.v1',moduleSha256:sha(canonical(buildFiles)),finalBuildManifestSha256:buildSha,finalSourceManifestSha256:sourceSha,
  entries:Object.entries(buildFiles).map(([name,digest])=>({path:'api-build/src/'+name,sha256:digest}))};
}

export function assertR07ProvidersClosed(config,auth){
 assert(config.yunxin?.enabled===false&&!config.orderTeams&&!config.supportDispatch&&!auth.yunxin&&!auth.orderImEvents
   &&!auth.userSmsSender&&!auth.realNameProvider&&!auth.testOperationsEnabled,'BOOTSTRAP_PROVIDER_OR_WORKER_NOT_CLOSED');
}

async function main(){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 if(!args.includes('--start')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--start','--request','--request-sha','--runtime-out','--bundle-out'],connections:0,started:false,channelCalls:0}));return;}
 assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
 const request=pinned({path:option('--request'),sha256:option('--request-sha')}),runtimeOut=inside(runtimeRoot,option('--runtime-out'),true),bundleOut=inside(privateRoot,option('--bundle-out'),true);
 assert(!existsSync(runtimeOut)&&!existsSync(bundleOut),'BOOTSTRAP_OUTPUT_EXISTS');
 const credentialsPath=inside(privateRoot,request.credentials?.path),credentialBytes=readFileSync(credentialsPath);
 assert(hex(request.credentials.sha256)&&sha(credentialBytes)===request.credentials.sha256,'BOOTSTRAP_CREDENTIALS_CHANGED');
 const registered=loadRegisteredTarget(credentialsPath),registrySha=sha(readFileSync(registered.sourceFile)),credentials=JSON.parse(credentialBytes),schema=pinned(request.schemaReceipt);
 assertR07BootstrapInputs(request,registered,schema);
 for(const kind of ['migration','runtime'])assert(credentials[kind]?.name===registered[kind+'Role']&&credentials[kind]?.oid===registered[kind+'RoleOid'],'BOOTSTRAP_ROLE_CHANGED');
 const api=isolatedDistributionBuild(root,request.apiDist);for(let x=api;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'BOOTSTRAP_LINK_REFUSED');
 const buildFiles=jsFiles(api);assert(Object.keys(buildFiles).length>0&&canonical(buildFiles)===canonical(request.buildFiles),'BOOTSTRAP_BUILD_CHANGED');
 const secretEnv={},secretPaths={};for(const [key,env] of Object.entries(R07_BOOTSTRAP_SECRET_FILES)){
  const ref=request.secrets?.[key],path=inside(join(mainApi,'.secrets'),ref?.path),bytes=readFileSync(path);
  assert(hex(ref.sha256)&&sha(bytes)===ref.sha256,'BOOTSTRAP_SECRET_CHANGED');secretEnv[env]=relative(mainApi,path).replaceAll('\\','/');secretPaths[key]=path;
 }
 const buildManifest=pinnedBuild(request.buildManifest);pinnedBuild(request.sourceManifest);
 const bundle=makeR07BootstrapBundle(buildFiles,buildManifest,request.buildManifest.sha256,request.sourceManifest.sha256),moduleSha=bundle.moduleSha256;
 writePrivate(join(bundleOut,'bundle.json'),bundle);const bundleSha=sha(readFileSync(join(bundleOut,'bundle.json')));
 const system=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_.+)$/i.test(key)));
 const env={...system,...secretEnv,NODE_PATH:[join(root,'apps/api/node_modules'),join(root,'node_modules')].join(';'),APP_PROFILE:'test',PROVIDER_MODE:'fake',NODE_ENV:'development',HOST:'127.0.0.1',PORT:'4242',
  DB_TARGET:'local-compose',DB_HOST:registered.host,DB_PORT:String(registered.port),DB_NAME:registered.database,DB_USER:registered.runtimeRole,DB_PASSWORD:credentials.runtime.password,
  ...(registered.migrationProfile?{LOCAL_MIGRATION_BOOTSTRAP_ENABLED:'true'}:{}),
  REDIS_HOST:'127.0.0.1',REDIS_PORT:'56379',AUTH_ENABLED:'true',AUTH_API_ORIGIN:request.origins.apiOrigin,AUTH_USER_ORIGIN:request.origins.userOrigin,AUTH_ADMIN_ORIGIN:request.origins.adminOrigin,
  AUTH_SECURE_COOKIES:'false',AUTH_LOCAL_SMS_MOCK:'true',USER_SMS_PROVIDER:'disabled',USER_REAL_NAME_PROVIDER:'disabled',LISTING_CURSOR_KEY_ID:'r07-bootstrap',
  YUNXIN_ENABLED:'false',ORDER_TEAMS_ENABLED:'false',SUPPORT_DISPATCH_ENABLED:'false',ORDER_IM_EVENTS_ENABLED:'false',ORDER_SWEEP_ENABLED:'false',DISTRIBUTION_DUE_WORKER_ENABLED:'false',
  DISTRIBUTION_NATIVE_ENABLED:'false',ORDER_SETTLEMENT_RECORDING_ENABLED:'false',ENABLE_TEST_OPERATIONS:'false',CREDIT_GUARANTEE_ENABLED:'true',ZZSH_MEMBERSHIP_GROWTH_ENABLED:'true',
  READINESS_MODE:'fake',JOINPAY_COLLECTION_ENABLED:'false',JOINPAY_REFUND_ENABLED:'false',JOINPAY_PAYOUT_ENABLED:'false',JOINPAY_ACCOUNTS_ENABLED:'false'};
 process.env=env;Module._initPaths();const require=createRequire(join(root,'apps/api/package.json')),{Client}=require('pg'),load=name=>require(join(api,name+'.js'));
 const {loadConfig}=load('config/config'),{loadAuthRuntimeConfig}=load('auth/auth-runtime'),{createBusinessPool,assertBusinessRuntimeIdentity}=load('database/business'),
  {createFakeHealthDependencies}=load('health/readiness'),{createApp}=load('app');
 let app,pool;const connection={connectionTimeoutMillis:3000,statement_timeout:15000,lock_timeout:1000};let actual,unlockAck=false,maintenanceClosed=false;
 const closeRuntime=async()=>{try{if(app)await app.close();}finally{app=undefined;if(pool&&!pool.ended&&!pool.ending)await pool.end();pool=undefined;}};
 try{
  const maintenance=new Client(maintenanceConnection(registered,{...connection,user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-bootstrap-lock'}));let held=false;
  try{
   await maintenance.connect();held=(await maintenance.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;assert(held,'BOOTSTRAP_RESOURCE_BUSY');
   for(const kind of ['migration','runtime']){
    const c=new Client(targetConnection(registered,{...connection,user:credentials[kind].name,password:credentials[kind].password,applicationName:'r07-bootstrap-preflight'}));
    try{await c.connect();await c.query('BEGIN READ ONLY');const row=(await c.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,row,kind);assert.equal(row.read_only,'on','BOOTSTRAP_READONLY_REQUIRED');
     if(kind==='migration')actual=row;assert.equal((await c.query('ROLLBACK')).command,'ROLLBACK');}finally{await c.end();}
   }
  }finally{
   try{if(held)unlockAck=(await maintenance.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}finally{await maintenance.end();maintenanceClosed=true;}
  }
  assert(unlockAck&&maintenanceClosed,'BOOTSTRAP_MAINTENANCE_CLEANUP_UNCONFIRMED');
  const config=loadConfig(env,mainApi),auth=loadAuthRuntimeConfig(env,mainApi,{testOperationsEnabled:false});
  assertR07ProvidersClosed(config,auth);
   assert(Buffer.isBuffer(auth.userIdentitySubjectKey)&&Buffer.isBuffer(auth.userLegacyIdentityProfileKey),'BOOTSTRAP_IDENTITY_KEYS_NOT_LOADED');
  pool=createBusinessPool(config,{max:4});
  await assertBusinessRuntimeIdentity(pool,config);app=await createApp({health:{dependencies:createFakeHealthDependencies()},database:{pool},auth:{...auth,pool}});
  await app.init();await app.listen(4242,'127.0.0.1');
  const response=await fetch('http://127.0.0.1:4242/api/health');assert.equal(response.status,200,'BOOTSTRAP_HEALTH_FAILED');
  assert(canonical(jsFiles(api))===canonical(buildFiles)&&sha(readFileSync(credentialsPath))===request.credentials.sha256
   &&sha(readFileSync(registered.sourceFile))===registrySha&&sha(readFileSync(request.schemaReceipt.path))===request.schemaReceipt.sha256
   &&Object.entries(secretPaths).every(([key,path])=>sha(readFileSync(path))===request.secrets[key].sha256),'BOOTSTRAP_FILES_CHANGED');
  pinnedBuild(request.buildManifest);pinnedBuild(request.sourceManifest);
  const resource={database:registered.database,oid:registered.oid,resourceOid:registered.oid,nonce:registered.nonce,marker:registered.marker,instance:registered.instance,migrationRoleOid:registered.migrationRoleOid,
   ...(registered.migrationProfile?{migrationProfile:registered.migrationProfile}:{})};
  const binding={status:'R07_BOOTSTRAP_API_LISTENING',at:new Date().toISOString(),pid:process.pid,port:4242,stopFile:join(runtimeOut,'api.stop'),resource,
   actualResource:{database:registered.database,oid:registered.oid,nonce:registered.nonce,marker:registered.marker,instance:registered.instance,owner:actual.owner,owner_oid:actual.owner_oid,
    ...(registered.migrationProfile?{migrationProfile:registered.migrationProfile}:{}),
    migration_role_oid:registered.migrationRoleOid,runtime_role:registered.runtimeRole,runtime_role_oid:registered.runtimeRoleOid,read_only:actual.read_only},
   initialization:{nonce:registered.nonce,imProvisioner:false,imIdentityRepository:false,imAppId:null},origins:request.origins,formalAppMounted:true,
   NoIM:true,imProvisioner:false,imIdentityRepository:false,imAppId:false,financialCommandCapabilities:false,workersEnabled:false,maintenanceLockReleased:unlockAck,maintenanceClosed,
    runtimeRequestSha256:option('--request-sha'),bootstrapSecretSha256:request.secrets.bootstrap.sha256,identitySubjectKeySha256:request.secrets.identity.sha256,
    legacyIdentityProfileKeySha256:request.secrets.identityProfile.sha256,compiledRoot:api,moduleSha256:moduleSha,copyManifestSha256:bundleSha};
  writePrivate(join(runtimeOut,'binding.json'),binding);console.log(JSON.stringify({status:binding.status,pid:process.pid,port:binding.port,binding:join(runtimeOut,'binding.json'),bundle:join(bundleOut,'bundle.json'),bundleSha256:bundleSha,channelCalls:0}));
  const timer=setInterval(()=>{if(!existsSync(binding.stopFile))return;clearInterval(timer);void closeRuntime().then(()=>{
   writePrivate(join(runtimeOut,'stopped.json'),{status:'R07_BOOTSTRAP_API_STOPPED',pid:process.pid,at:new Date().toISOString()});
  }).catch(()=>{process.exitCode=1;});},500);
 }catch(error){await closeRuntime().catch(()=>{});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'BOOTSTRAP_API_FAILED',code:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
