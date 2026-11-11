import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync} from 'node:fs';
import Module,{createRequire} from 'node:module';
import {delimiter,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writePrivate} from '../local-auth.mjs';
import {assertDistributionCoreReadback,assertRegisteredDistributionTarget,isolatedDistributionBuild} from './local-distribution-qualification-plan.mjs';
import {assertRoundDependencyProof,inspectRoundDependencyLayout} from './local-round-dependencies.mjs';
import {assertSealedTools} from './readback-empty-legacy-listed.mjs';
import {readListedCompiledProof,readListedExecutionProof,readUnexpectedListedTarget,validateListedBatchReadbackSet} from './legacy-listed-execution-plan.mjs';
import {verifyRoundBoundSourcePlan} from './legacy-listed-round-source.mjs';
import {acquireMigrationTransactionFence,advisoryLockSql,assertLiveTarget,assertMigrationFenceHeld,captureMaintenanceLockEpoch,loadRegisteredTarget,maintenanceConnection,NEXT_MIGRATION_PROFILE,targetConnection,targetIdentityQuery} from './local-target-registry.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex'),hex=value=>/^[a-f0-9]{64}$/.test(value??'');

async function main(){
 const args=process.argv.slice(2);
 if(!args.length){console.log(JSON.stringify({status:'PLAN_ONLY',modes:['--validate','--readback'],required:['--input','--input-sha'],readbackAlsoRequires:['--maintenance-password-file','--out'],connections:0,targetWrites:0}));return;}
 const mode=args[0],names=mode==='--readback'?['--input','--input-sha','--maintenance-password-file','--out']:['--input','--input-sha'],options=new Map();
 assert(['--validate','--readback'].includes(mode)&&process.version==='v24.20.0'&&args.length===1+names.length*2,'LISTED_ALL_ARGUMENTS_INVALID');
 for(let i=1;i<args.length;i+=2){assert(names.includes(args[i])&&!options.has(args[i])&&args[i+1]&&!args[i+1].startsWith('--'),'LISTED_ALL_ARGUMENTS_INVALID');options.set(args[i],args[i+1]);}
 const option=name=>options.get(name),root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
 function privatePath(value,output=false){
  assert(typeof value==='string'&&isAbsolute(value),'LISTED_ALL_PRIVATE_PATH_REQUIRED');const path=resolve(value),rel=relative(restricted,path);
  assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'LISTED_ALL_PRIVATE_PATH_REQUIRED');
  for(let current=output?dirname(path):path;;current=dirname(current)){
   if(existsSync(current))assert(!lstatSync(current).isSymbolicLink(),'LISTED_ALL_LINK_REFUSED');
   if(current.toLowerCase()===restricted.toLowerCase())break;
  }
  return path;
 }
 function pinned(ref){const path=privatePath(ref?.path),bytes=readFileSync(path);assert(hex(ref.sha256)&&sha(bytes)===ref.sha256,'LISTED_ALL_INPUT_CHANGED');return JSON.parse(bytes);}
 const started=performance.now(),startedAt=new Date().toISOString(),inputRef={path:option('--input'),sha256:option('--input-sha')},input=pinned(inputRef);
 assert(input.schema==='zzsh.listed-all-batch-readback-input.v1'&&Array.isArray(input.batches)&&input.batches.length>0,'LISTED_ALL_INPUT_INVALID');
 const round=pinned(input.roundInput),core=pinned(input.coreReceipt),coreReadback=pinned(input.coreReadback),manifest=pinned(input.batchManifest);
 assert(round.schema==='zzsh.local-round.v1'&&core.inputSha256===input.roundInput.sha256,'LISTED_ALL_ROUND_CHANGED');
 assertDistributionCoreReadback(core,coreReadback,{roundInputSha256:input.roundInput.sha256,readbackSha256:input.coreReadback.sha256,
  datasetSha256:round.dataset?.sha256,sourceSha256:round.source?.sha256,target:round.target});
 const actor=pinned(round.actor),actorId=actor.id??actor.actorId;
 assert(typeof actorId==='string'&&actorId&&typeof actor.sessionId==='string'&&actor.sessionId&&(!actor.actorId||actor.actorId===actorId),'LISTED_ALL_ACTOR_REQUIRED');
 const credentialsPath=resolve(round.credentials??''),resourcePath=join(dirname(credentialsPath),'resource.json');
 assert(isAbsolute(round.credentials??'')&&!lstatSync(credentialsPath).isSymbolicLink()&&!lstatSync(resourcePath).isSymbolicLink(),'LISTED_ALL_CREDENTIALS_REQUIRED');
 const resource=JSON.parse(readFileSync(resourcePath)),registered=loadRegisteredTarget(credentialsPath),credentials=JSON.parse(readFileSync(credentialsPath));
 assertRegisteredDistributionTarget(round.target,round.dataset.sha256,resource);
 assert(credentials.runtime?.name===registered.runtimeRole&&credentials.runtime?.oid===registered.runtimeRoleOid&&credentials.database===registered.database,'LISTED_ALL_TARGET_CHANGED');
 const target={database:registered.database,oid:registered.oid,nonce:registered.nonce,actorId,instance:registered.instance,lockKey:registered.lockKey,
  migrationRoleOid:registered.migrationRoleOid,runtimeRoleOid:registered.runtimeRoleOid,...(registered.migrationProfile?{migrationProfile:registered.migrationProfile}:{})};
 const api=isolatedDistributionBuild(root,round.apiDist),dep=round.dependencyBinding;
 assert(dep?.proof&&dep.buildManifest&&dep.sourceManifest&&round.bootstrapEvidence?.bundle,'LISTED_ALL_BUILD_PROOF_REQUIRED');
 const dependencyProof=pinned(dep.proof),layout=inspectRoundDependencyLayout({apiDist:api,bundlePath:round.bootstrapEvidence.bundle.path,
  bundleSha256:round.bootstrapEvidence.bundle.sha256,buildManifestPath:dep.buildManifest.path,buildManifestSha256:dep.buildManifest.sha256,
  sourceSnapshot:dep.sourceSnapshot,sourceManifestPath:dep.sourceManifest.path,sourceManifestSha256:dep.sourceManifest.sha256});
 assertRoundDependencyProof(dependencyProof,layout);
 const toolNames=['readback-listed-batches.mjs','readback-empty-legacy-listed.mjs','legacy-listed-execution-plan.mjs','legacy-listed-round-source.mjs',
  'load-legacy-listed-accounts.mjs','legacy-listed-provisional-credit.mjs','verify-legacy-listed-policy-dump.mjs','local-source-adapter.mjs',
  'local-distribution-qualification-plan.mjs','local-round-dependencies.mjs','local-target-registry.mjs','../local-auth.mjs'];
 const toolFiles=Object.fromEntries(toolNames.map(name=>[name,sha(readFileSync(new URL(name,import.meta.url)))]));
 const sealedTools=Object.fromEntries(toolNames.map(name=>[relative(root,fileURLToPath(new URL(name,import.meta.url))).replaceAll('\\','/'),toolFiles[name]]));
 const checkTools=()=>{
  const bytes=readFileSync(dep.sourceManifest.path);assert(sha(bytes)===dep.sourceManifest.sha256,'LISTED_ALL_SOURCE_MANIFEST_CHANGED');assertSealedTools(JSON.parse(bytes),sealedTools);
  for(const name of toolNames)for(const file of [fileURLToPath(new URL(name,import.meta.url)),join(layout.scriptDir,name),join(dep.sourceSnapshot,'scripts/migration',name)]){
   for(let path=resolve(file);path!==dirname(path);path=dirname(path))assert(!lstatSync(path).isSymbolicLink(),'LISTED_ALL_LINK_REFUSED');
   assert(sha(readFileSync(file))===toolFiles[name],'LISTED_ALL_TOOL_CHANGED');
  }
 };
 checkTools();process.env.NODE_PATH=layout.moduleDirs.join(delimiter);Module._initPaths();
 const require=createRequire(join(layout.sourceRoot,'apps/api/package.json')),{Client}=require('pg');
 const load=name=>{const key=name+'.js',file=join(api,key);assert(hex(round.buildFiles?.[key])&&sha(readFileSync(file))===round.buildFiles[key],'LISTED_ALL_BUILD_CHANGED');return require(file);};
 const {canonicalize}=load('supply/content-hash'),{legacyPriceInteger}=load('supply/legacy-listed-pricing'),{fingerprintRequest}=load('supply/supply-util');
 const {assertAdminContextInTransaction}=load('auth/auth-security'),{readPublishingAccount,listingDetail}=load('supply/publishing');
 const {createProductionSupplyGateReader}=load('supply/funding-authority'),{composeSupplyGateWithOrderOccupancy}=load('order/order');
 const {compiled}=readListedCompiledProof(api,{roundBound:true,sameCapture:true});
 for(const [key,value] of Object.entries(compiled))if(key.includes('/'))assert(round.buildFiles?.[key+'.js']===value,'LISTED_ALL_BUILD_CHANGED');
 const loaded=()=>{
  const dependencies=new Map(dependencyProof.closureFiles),used={};
  for(const file of Object.keys(require.cache)){
   const apiRelative=relative(api,file).replaceAll('\\','/');
   if(apiRelative&&!apiRelative.startsWith('../')&&!isAbsolute(apiRelative)){assert(sha(readFileSync(file))===round.buildFiles?.[apiRelative],'LISTED_ALL_BUILD_CHANGED');used[apiRelative]=round.buildFiles[apiRelative];}
   if(file.toLowerCase().includes('node_modules')){const name=relative(layout.sourceRoot,file).replaceAll('\\','/');
    assert(name&&!name.startsWith('../')&&!isAbsolute(name)&&dependencies.get(name)===sha(readFileSync(file)),'LISTED_ALL_DEPENDENCY_CHANGED');}
  }
  return used;
 };
 loaded();
 const batches=[],policies=[];let creditGuaranteeEnabled;
 for(const [index,refs] of input.batches.entries()){
  const sourcePlan=pinned(refs.sourcePlan),audit=pinned(refs.audit),executionPlan=pinned(refs.executionPlan),trial=pinned(refs.trial),checkpoint=pinned(refs.checkpoint),readback=pinned(refs.readback),policy=pinned(refs.policy);
  assert(sourcePlan.roundBinding?.scopeAuditSha256===refs.audit.sha256&&sourcePlan.roundBinding?.batch?.index===index+1
    &&sourcePlan.roundBinding?.policyBundleSha256===sha(canonicalize(policy)),'LISTED_ALL_SOURCE_BINDING_CHANGED');
  if(creditGuaranteeEnabled===undefined)creditGuaranteeEnabled=executionPlan.creditGuaranteeEnabled===true;
  assert(creditGuaranteeEnabled===(executionPlan.creditGuaranteeEnabled===true),'LISTED_ALL_POLICY_MODE_CHANGED');
  await verifyRoundBoundSourcePlan(executionPlan,{oid:registered.oid,nonce:registered.nonce,instance:registered.instance,migrationProfile:registered.migrationProfile,credentials:credentialsPath,
   actorFile:round.actor.path,apiDist:api,creditGuaranteeEnabled,allowExpiredReadOnly:true,compiled,parseInteger:legacyPriceInteger},canonicalize);
  policies.push(policy);batches.push({sourcePlan,sourcePlanSha256:refs.sourcePlan.sha256,audit,auditSha256:refs.audit.sha256,
   executionPlan,executionPlanSha256:refs.executionPlan.sha256,trial,checkpoint,checkpointSha256:refs.checkpoint.sha256,readback});
 }
 const operation='supply.legacy.trade_takeover',binding=body=>({scope:JSON.stringify(['admin',actorId,operation,body.intake.accountId]),
  key:sha(JSON.stringify([body.intake.accountId,body.intake.source.expectedObservationVersionId,sha(canonicalize(body.intake))])),
  fingerprint:fingerprintRequest(operation,body.intake.accountId,body)});
 const entries=validateListedBatchReadbackSet({manifest,manifestSha256:input.batchManifest.sha256,roundInputSha256:input.roundInput.sha256,
  policies,batches,target,compiled,canonicalize,binding});
 if(mode==='--validate'){
  for(const ref of [inputRef,input.roundInput,input.coreReceipt,input.coreReadback,input.batchManifest,round.actor,dep.proof,...input.batches.flatMap(x=>Object.values(x))])pinned(ref);
  assertRoundDependencyProof(dependencyProof,layout);checkTools();loaded();
  console.log(JSON.stringify({status:'LISTED_BATCH_EVIDENCE_VALIDATED_TARGET_NOT_RUN',batches:batches.length,accounts:entries.length,connections:0,targetWrites:0}));return;
 }
 const gate=composeSupplyGateWithOrderOccupancy(createProductionSupplyGateReader({creditGuaranteeEnabled}));
 const passwordFile=option('--maintenance-password-file');assert(isAbsolute(passwordFile??'')&&!lstatSync(passwordFile).isSymbolicLink(),'LISTED_ALL_LOCK_CREDENTIAL_REQUIRED');
 const out=privatePath(option('--out'),true);assert(!existsSync(out),'LISTED_ALL_OUTPUT_EXISTS');
 const lock=new Client(maintenanceConnection(registered,{user:'zzsh',password:readFileSync(passwordFile,'utf8').trim(),connectionTimeoutMillis:3000,applicationName:'listed-all-readback-lock'}));
 const client=new Client(targetConnection(registered,{user:credentials.runtime.name,password:credentials.runtime.password,connectionTimeoutMillis:3000,
  statement_timeout:30000,lock_timeout:1000,applicationName:'listed-all-readback'}));
 let locked=false,transaction=false,rollbackConfirmed=false,lockReleased=false,clientClosed=false,lockClosed=false,observedAt,proof,unexpected,fenceEpoch;
 try{
  await lock.connect();locked=(await lock.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;assert(locked,'LISTED_ALL_LOCK_BUSY');
  if(registered.migrationProfile===NEXT_MIGRATION_PROFILE)fenceEpoch=await captureMaintenanceLockEpoch(lock,registered);
  await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;await client.query('SET LOCAL row_security=off');
  const live=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,live,'runtime');assert(live.read_only==='on','LISTED_ALL_READ_ONLY_REQUIRED');
  if(fenceEpoch)await acquireMigrationTransactionFence(client,registered,fenceEpoch);
  const at=(await client.query('SELECT transaction_timestamp() AS at')).rows[0]?.at;assert(at instanceof Date&&Number.isFinite(at.getTime()),'LISTED_ALL_TIME_UNAVAILABLE');observedAt=at.toISOString();
  await assertAdminContextInTransaction(client,{userId:actorId,sessionId:actor.sessionId});
  proof={expected:entries.length,committed:0,rentable:0,differences:[]};
  for(let i=0;i<entries.length;i+=200){const part=await readListedExecutionProof(client,entries.slice(i,i+200),{readPublishingAccount,listingDetail,gate});
   proof.committed+=part.committed;proof.rentable+=part.rentable;proof.differences.push(...part.differences);}
  unexpected=await readUnexpectedListedTarget(client,entries);
  if(fenceEpoch)await assertMigrationFenceHeld(client,registered,fenceEpoch);
  rollbackConfirmed=(await client.query('ROLLBACK')).command==='ROLLBACK';transaction=false;assert(rollbackConfirmed,'LISTED_ALL_ROLLBACK_UNCONFIRMED');
 }finally{
  if(transaction)try{rollbackConfirmed=(await client.query('ROLLBACK')).command==='ROLLBACK';}catch{}
  try{await client.end();clientClosed=true;}catch{}
  if(locked)try{lockReleased=(await lock.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}catch{}
  try{await lock.end();lockClosed=true;}catch{}
 }
 assert(rollbackConfirmed&&lockReleased&&clientClosed&&lockClosed,'LISTED_ALL_CLEANUP_UNCONFIRMED');
 for(const ref of [inputRef,input.roundInput,input.coreReceipt,input.coreReadback,input.batchManifest,round.actor,dep.proof,...input.batches.flatMap(x=>Object.values(x))])pinned(ref);
 assertRegisteredDistributionTarget(round.target,round.dataset.sha256,JSON.parse(readFileSync(resourcePath)));assertRoundDependencyProof(dependencyProof,layout);checkTools();const usedBuildModules=loaded();
 const passed=proof.differences.length===0&&proof.committed===entries.length&&proof.rentable===entries.length&&unexpected.status==='NO_UNEXPECTED_LISTED_FACTS';
 const report={schema:'zzsh.listed-all-batch-readback.v1',status:passed?'LISTED_ALL_BATCH_READBACK_PASS':'LISTED_ALL_BATCH_READBACK_REVIEW_REQUIRED',
  roundInputSha256:input.roundInput.sha256,sourceReceiptSha256:round.source.sha256,batchManifestSha256:input.batchManifest.sha256,
  coreReadbackSha256:input.coreReadback.sha256,target,startedAt,observedAt,finishedAt:new Date().toISOString(),wallMs:Math.round(performance.now()-started),
  batches:input.batches.length,...proof,unexpectedStatus:unexpected.status,unexpectedObservations:unexpected.unexpectedObservations,
  unexpectedPublications:unexpected.unexpectedPublications,rollbackConfirmed,lockReleased,clientClosed,lockClosed,toolFiles,usedBuildModules,targetWrites:0,...(fenceEpoch?{targetFence:'HELD_UNTIL_ROLLBACK'}:{}),
  limitations:['POINT_IN_TIME_ONLY','OTHER_DOMAINS_NOT_ASSESSED','RESTORE_AND_BROWSER_NOT_ASSESSED']};
 mkdirSync(out,{mode:0o700});writePrivate(join(out,'readback.json'),report);
 console.log(JSON.stringify({status:report.status,batches:report.batches,expected:proof.expected,committed:proof.committed,rentable:proof.rentable,
  differences:proof.differences.length,unexpectedObservations:unexpected.unexpectedObservations,unexpectedPublications:unexpected.unexpectedPublications,targetWrites:0,...(fenceEpoch?{targetFence:report.targetFence}:{})}));
 if(!passed)process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
 const code=/^([A-Z][A-Z0-9_]+)(?:[:\r\n]|$)/.exec(error.message??'')?.[1]??error.code??error.name;
 console.error(JSON.stringify({status:'LISTED_ALL_READBACK_STOPPED',code}));process.exitCode=1;
});
