import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import Module,{createRequire} from 'node:module';
import {basename,delimiter,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {defaultStore,writePrivate} from '../local-auth.mjs';
import {writeLoadCheckpoint} from './local-load-checkpoint.mjs';
import {readSourceRows} from './local-source-adapter.mjs';
import {assertCreditAuthority,assertCreditCohort,assertCreditPlanReady,creditCategoryCounts,creditRetainedDigest,creditRowsDigest,executeCreditBatchSequence} from './local-credit-initialization-plan.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=value=>createHash('sha256').update(value).digest('hex'),hex=/^[a-f0-9]{64}$/;
const database='zzsh_test_regression',owner='zzsh',runtimeRole='zzsh_regression_runtime',marker='zzsh:regression-test:v1';
function noLink(value){const p=resolve(value);for(let x=p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'CREDIT_REPARSE_REFUSED');return p;}
let distributionGuards;
function privatePath(value,output=false){const p=distributionGuards.privateDistributionPath(restricted,value);for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'CREDIT_REPARSE_REFUSED');return p;}
function pinned(file,digest){assert(hex.test(digest??''),'CREDIT_SHA_REQUIRED');const bytes=readFileSync(file);assert.equal(sha(bytes),digest,'CREDIT_INPUT_SHA_CHANGED');return JSON.parse(bytes);}
function fileList(dir,prefix=''){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{assert(!e.isSymbolicLink(),'CREDIT_BUILD_REPARSE_REFUSED');const n=prefix+e.name;return e.isDirectory()?fileList(join(dir,e.name),n+'/'):e.isFile()&&n.endsWith('.js')?[n]:[];});}
function buildBinding(api,manifest,manifestSha){
 api=distributionGuards.isolatedDistributionBuild(root,api);for(let p=api;p.toLowerCase()!==root.toLowerCase();p=dirname(p))assert(p!==dirname(p)&&!lstatSync(p).isSymbolicLink(),'CREDIT_BUILD_REPARSE_REFUSED');
 const prefix=manifest.layout?.apiDistDir+'/';assert(prefix==='apps/api/dist-r06-v3/src/','CREDIT_FINAL_BUILD_REQUIRED');
 const entries=manifest.components?.api?.filter(x=>x.path.startsWith(prefix)&&x.path.endsWith('.js'))??[],files={};
 for(const entry of entries){const name=entry.path.slice(prefix.length);assert(name&&!name.includes('\\')&&!name.split('/').includes('..')&&hex.test(entry.sha256)&&!files[name],'CREDIT_BUILD_MANIFEST_INVALID');files[name]=entry.sha256;}
 assert(Object.keys(files).length>0&&JSON.stringify(Object.keys(files).sort())===JSON.stringify(fileList(api).sort()),'CREDIT_BUILD_FILE_SET_CHANGED');
 const digest=sha(JSON.stringify(Object.entries(files).sort())+'\n');
 return {api,files,digest,manifestSha};
}

export async function main(args=process.argv.slice(2)){
 const {values:v}=parseArgs({args,options:{validate:{type:'boolean'},prepare:{type:'boolean'},authorize:{type:'boolean'},execute:{type:'boolean'},'round-input':{type:'string'},'round-input-sha':{type:'string'},'round-receipt':{type:'string'},'round-receipt-sha':{type:'string'},'core-readback':{type:'string'},'core-readback-sha':{type:'string'},build:{type:'string'},'build-manifest':{type:'string'},'build-manifest-sha':{type:'string'},plan:{type:'string'},'plan-sha':{type:'string'},authority:{type:'string'},'authority-sha':{type:'string'},'approval-ref':{type:'string'},'window-minutes':{type:'string'},out:{type:'string'}}});
 const modes=['validate','prepare','authorize','execute'].filter(name=>v[name]);
 if(!modes.length){console.log(JSON.stringify({status:'PLAN_ONLY',modes:['validate','prepare','authorize','execute'],connections:0,credentialReads:0,financialWrites:0}));return;}
 assert.equal(modes.length,1,'ONE_CREDIT_MODE_REQUIRED');assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
 distributionGuards=await import('./local-distribution-qualification-plan.mjs');
 for(const name of ['assertNewDistributionTarget','assertDistributionCoreReadback','assertRegisteredDistributionTarget','isolatedDistributionBuild','privateDistributionPath'])assert.equal(typeof distributionGuards[name],'function','CREDIT_DISTRIBUTION_GUARD_UNAVAILABLE');
 const started=performance.now(),startedAt=new Date().toISOString(),mode=modes[0],out=privatePath(v.out,true);
 assert(!existsSync(out),'PRESERVE_CREDIT_OUTPUT');
 const round=pinned(privatePath(v['round-input']),v['round-input-sha']);assert.equal(round.schema,'zzsh.local-round.v1');distributionGuards.assertNewDistributionTarget(round.target);
 const receipt=pinned(privatePath(v['round-receipt']),v['round-receipt-sha']),readback=pinned(privatePath(v['core-readback']),v['core-readback-sha']);
 distributionGuards.assertDistributionCoreReadback(receipt,readback,{roundInputSha256:v['round-input-sha'],readbackSha256:v['core-readback-sha'],datasetSha256:round.dataset.sha256,sourceSha256:round.source.sha256,target:round.target});
 assert(round.strictBatch===true&&receipt.strictBatch===true&&receipt.completion?.growth==='PASS','CREDIT_STRICT_CORE_AND_GROWTH_REQUIRED');
 const dataset=pinned(privatePath(join(privatePath(round.dataset.path),'manifest.json')),round.dataset.sha256),capture=pinned(privatePath(join(privatePath(round.source.path),'receipt.json')),round.source.sha256),ready=dataset.domains?.users?.ready;
 assert(dataset.sourceReceiptSha256===round.source.sha256&&capture.status==='CAPTURED_READ_ONLY'&&capture.rollbackConfirmed===true&&capture.clientClosed===true,'CREDIT_SOURCE_CAPTURE_REQUIRED');
 assert(Number.isSafeInteger(ready)&&ready>=0,'CREDIT_SOURCE_DENOMINATOR_REQUIRED');
 const core=receipt.stages.findLast(row=>row.name==='core-and-funds');assert(core?.status==='ACK'&&core.metrics?.users?.nextIndex===ready,'CREDIT_CORE_USERS_NOT_ACKNOWLEDGED');
 const actorFile=pinned(privatePath(round.actor.path),round.actor.sha256),actor={actorId:actorFile.actorId??actorFile.id,sessionId:actorFile.sessionId};
 assert(actor.actorId&&actor.sessionId&&(!actorFile.id||!actorFile.actorId||actorFile.id===actorFile.actorId)&&actorFile.realm==='admin'&&actorFile.resourceOid===round.target.oid&&actorFile.nonce===round.target.nonce,'CREDIT_ACTOR_TARGET_CHANGED');
 const secretRoot=dirname(defaultStore()),credentialsPath=resolve(round.credentials);assert.equal(credentialsPath.toLowerCase(),resolve(secretRoot,'local-postgresql/regression_test/credentials.json').toLowerCase(),'CREDIT_CREDENTIAL_RESOURCE_CHANGED');
 const registryPath=join(dirname(credentialsPath),'resource.json');
 function registry(){const r=JSON.parse(readFileSync(noLink(registryPath)));distributionGuards.assertRegisteredDistributionTarget(round.target,round.dataset.sha256,r);assert(r.protectedDataset.status==='LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED'&&r.roles.runtime.name===runtimeRole,'CREDIT_REGISTRY_CHANGED');return r;}
 const registered=registry(),epoch={oid:round.target.oid,nonce:round.target.nonce};
 const resource={databaseName:database,databaseOid:epoch.oid,owner,runtimeRole,bindingKind:'DATABASE_COMMENT',databaseComment:marker};
 const manifestFile=noLink(v['build-manifest']),manifest=pinned(manifestFile,v['build-manifest-sha']),build=buildBinding(v.build,manifest,v['build-manifest-sha']);
 assert.deepEqual(Object.entries(round.buildFiles??{}).sort(),Object.entries(build.files).sort(),'CREDIT_BUILD_DIFFERS_FROM_CORE');
 const tools=['run-local-credit-initialization.mjs','local-credit-initialization-plan.mjs','local-distribution-qualification-plan.mjs','local-load-checkpoint.mjs','local-source-adapter.mjs','../local-auth.mjs'];
 const toolFiles=Object.fromEntries(tools.map(name=>[name,sha(readFileSync(join(root,'scripts/migration',name)))]));
 function verifyBuild(){assert.equal(sha(readFileSync(noLink(manifestFile))),build.manifestSha,'CREDIT_BUILD_MANIFEST_CHANGED');assert.deepEqual(fileList(build.api).sort(),Object.keys(build.files).sort(),'CREDIT_BUILD_FILE_SET_CHANGED');for(const [name,digest] of Object.entries(build.files))assert.equal(sha(readFileSync(join(build.api,name))),digest,'CREDIT_BUILD_CHANGED');for(const [name,digest] of Object.entries(toolFiles))assert.equal(sha(readFileSync(join(root,'scripts/migration',name))),digest,'CREDIT_TOOL_CHANGED');}
 verifyBuild();
 const binding={roundInputSha256:v['round-input-sha'],roundReceiptSha256:v['round-receipt-sha'],coreReadbackSha256:v['core-readback-sha'],datasetSha256:round.dataset.sha256,sourceSha256:round.source.sha256,epoch,resource,actorAdminId:actor.actorId,actorFileSha256:round.actor.sha256,buildManifestSha256:build.manifestSha,buildDigest:build.digest,toolFiles};
 process.env.NODE_PATH=[join(root,'apps/api/node_modules'),join(root,'node_modules')].join(delimiter);Module._initPaths();
 const require=createRequire(join(root,'apps/api/package.json'));
 const compiled=name=>{assert(build.files[name+'.js'],'CREDIT_BUILD_MODULE_UNPINNED');return require(join(build.api,name+'.js'));};
 const {buildCreditInitializationBatches}=compiled('credit/credit-initialization-batches'),{readCreditInitializationRun}=compiled('credit/credit-initialization-cli');
 const {CREDIT_INITIALIZATION_POLICY,creditInitializationFingerprint,previewCreditInitialization,runCreditInitializationBatch,readCreditInitializationReceipt,withReadOnlyTransaction}=compiled('credit/credit-initialization');
 const {assertBusinessRuntimeIdentity}=compiled('database/business');
 const {legacyOwnerUserId}=compiled('supply/legacy-user-migration'),users=dataset.files?.users;
 assert(users&&users.file===basename(users.file)&&hex.test(users.sha256??'')&&users.rows===ready,'CREDIT_SOURCE_USERS_REQUIRED');
 const userFile=privatePath(join(round.dataset.path,users.file));assert.equal(sha(readFileSync(userFile)),users.sha256,'CREDIT_SOURCE_USERS_CHANGED');
 const expectedIds=[];for await(const row of readSourceRows(userFile)){
  const e=row?.input?.evidence;assert(e?.sourceSystem==='legacy_mysql_restore'&&e.sourceEntity==='la_user'&&row.userId===legacyOwnerUserId(e.sourceSystem,e.sourceEntity,e.legacyId),'CREDIT_SOURCE_USER_ID_CHANGED');expectedIds.push(row.userId);
 }
 expectedIds.sort();assert(expectedIds.length===ready&&new Set(expectedIds).size===ready,'CREDIT_SOURCE_USER_SET_INVALID');
 binding.datasetUsersSha256=users.sha256;binding.sourceUserSetSha256=sha(expectedIds.join('\n')+'\n');
 if(mode==='validate'){
  const checked={schema:'zzsh.local-credit-input-validation.v1',status:'CREDIT_SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN',target:epoch,datasetSha256:round.dataset.sha256,buildDigest:build.digest,startedAt,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),connections:0,credentialReads:0,financialWrites:0};
  writePrivate(join(out,'receipt.json'),checked);console.log(JSON.stringify(checked));return;
 }
 const plan=mode==='prepare'?null:pinned(privatePath(v.plan),v['plan-sha']);
 if(plan){assert.deepEqual(plan.binding,binding,'CREDIT_PLAN_BINDING_CHANGED');assertCreditPlanReady(plan);}
 if(mode==='authorize'){
  const minutes=Number(v['window-minutes']);assert(Number.isInteger(minutes)&&minutes>0&&minutes<=180,'CREDIT_WINDOW_INVALID');
  const now=Date.now(),authority={schema:'zzsh.local-credit-authority.v1',status:'APPROVED',approvedBy:'Root',approvalRef:v['approval-ref'],attempt:1,windowStartUtc:new Date(now-3000).toISOString(),windowEndUtc:new Date(now+minutes*60000).toISOString(),planManifestSha256:v['plan-sha'],binding,actor:{adminId:actor.actorId,sessionId:actor.sessionId},eligibleCount:plan.reconciliation.batched,batchCount:plan.batches.length,modes:['PREVIEW','APPLY']};
  assertCreditAuthority(authority,plan,v['plan-sha'],actor,now);writePrivate(join(out,'authorization.json'),authority);
  const sealed={schema:'zzsh.local-credit-authority-receipt.v1',status:'CREDIT_AUTHORITY_SEALED',sha256:sha(readFileSync(join(out,'authorization.json'))),planSha256:v['plan-sha'],target:epoch,eligibleCount:authority.eligibleCount,batchCount:authority.batchCount,startedAt,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),connections:0,financialWrites:0};
  writePrivate(join(out,'receipt.json'),sealed);console.log(JSON.stringify(sealed));return;
 }
 const authority=mode==='execute'?pinned(privatePath(v.authority),v['authority-sha']):null;
 if(authority)assertCreditAuthority(authority,plan,v['plan-sha'],actor);
 const credentials=JSON.parse(readFileSync(noLink(credentialsPath)));assert(credentials.database===database&&credentials.marker===marker&&credentials.runtime?.name===runtimeRole&&credentials.runtime.oid===registered.roles.runtime.oid,'CREDIT_RUNTIME_CREDENTIAL_CHANGED');
 const maintenance=round.secrets?.databaseMaintenance;assert(maintenance&&hex.test(maintenance.sha256),'CREDIT_MAINTENANCE_SECRET_REQUIRED');
 assert.equal(resolve(maintenance.path).toLowerCase(),resolve(secretRoot,'postgres_password').toLowerCase(),'CREDIT_MAINTENANCE_RESOURCE_CHANGED');
 const secret=readFileSync(noLink(maintenance.path));assert.equal(sha(secret),maintenance.sha256,'CREDIT_MAINTENANCE_SECRET_CHANGED');
 const {Client,Pool}=require('pg'),base={host:'127.0.0.1',port:55432,connectionTimeoutMillis:3000,statement_timeout:120000,lock_timeout:1000};
 const timings={inputValidationMs:Math.round(performance.now()-started)};
 let lock,pool,held=false,lockError,transportError,summary={schema:'zzsh.local-credit-initialization-receipt.v1',status:'STARTED',mode,binding,batches:[],timings,financialWrites:0,channelCalls:0},unlockAck=false,poolClosed=false,lockClosed=false;
 writePrivate(join(out,'summary.json'),summary);
 async function identity(client,readOnly){
  const r=(await client.query(`SELECT current_database() database,d.oid::text,pg_get_userbyid(d.datdba) owner,shobj_description(d.oid,'pg_database') marker,current_setting('zzsh.regression_run',true) nonce,current_user role,r.oid::text role_oid,r.rolsuper,r.rolbypassrls,current_setting('transaction_read_only') read_only FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  assert(r&&r.database===database&&r.oid===epoch.oid&&r.nonce===epoch.nonce&&r.owner===owner&&r.marker===marker&&r.role===runtimeRole&&r.role_oid===registered.roles.runtime.oid&&!r.rolsuper&&!r.rolbypassrls&&r.read_only===(readOnly?'on':'off'),'CREDIT_LIVE_TARGET_CHANGED');
 }
 async function lockStillHeld(){assert(!lockError&&!transportError,'CREDIT_CONNECTION_ERROR');const r=await lock.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=0::oid AND objid=806006::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS held");assert.equal(r.rows[0].held,true,'CREDIT_MAINTENANCE_LOCK_LOST');}
 function guardedPool(application_name){
  const p=new Pool({...base,database,user:runtimeRole,password:credentials.runtime.password,max:1,application_name});
  p.on('connect',client=>{client.on('error',e=>{transportError??=e;});const query=client.query.bind(client);client.query=(sql,...params)=>{
   if(sql==='BEGIN'||sql==='BEGIN READ ONLY')return query(sql,...params).then(async result=>{registry();await identity(client,sql==='BEGIN READ ONLY');return result;});
   if(sql==='COMMIT')return lockStillHeld().then(()=>{registry();verifyBuild();return query(sql,...params);}).then(result=>{assert.equal(result.command,'COMMIT','CREDIT_COMMIT_ACK_UNCONFIRMED');return result;});
   if(sql==='ROLLBACK')return query(sql,...params).then(result=>{assert.equal(result.command,'ROLLBACK','CREDIT_ROLLBACK_ACK_UNCONFIRMED');return result;});
   return query(sql,...params);
  };});p.on('error',e=>{transportError??=e;});return p;
 }
 async function currentUsers(client){
  const rows=(await client.query(`SELECT u.id AS "userId",CASE WHEN s.account_status='CANCELLED' THEN 'CANCELLED' WHEN s.account_status='FROZEN' THEN 'FROZEN' WHEN u.suspended THEN 'RESTRICTED' WHEN s.account_status='ACTIVE' THEN 'ACTIVE' ELSE 'UNKNOWN' END category,c.user_id IS NOT NULL AS "hasCreditState",EXISTS(SELECT 1 FROM zzsh_credit.credit_event e WHERE e.user_id=u.id AND e.event_type='INITIALIZED') AS "hasInitializedEvent",EXISTS(SELECT 1 FROM zzsh_credit.credit_event e WHERE e.user_id=u.id AND e.event_type<>'INITIALIZED') AS "hasOtherCreditEvent" FROM zzsh_iam.user_identity_state s JOIN zzsh_auth_user."user" u ON u.id=s.user_id LEFT JOIN zzsh_credit.user_credit_state c ON c.user_id=u.id WHERE s.provider='legacy_mysql_restore' ORDER BY u.id COLLATE "C"`)).rows;
  assertCreditCohort(rows,expectedIds);return rows;
 }
 try{
  let at=performance.now();lock=new Client({...base,database:'postgres',user:owner,password:secret.toString('utf8').trim(),application_name:'r06-credit-maintenance-lock'});lock.on('error',e=>{lockError??=e;});await lock.connect();held=(await lock.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok;assert(held,'CREDIT_RESOURCE_BUSY');registry();await lockStillHeld();timings.lockAcquisitionMs=Math.round(performance.now()-at);
  pool=guardedPool('r06-credit-runtime');
  await assertBusinessRuntimeIdentity(pool,{database:{name:database,user:runtimeRole,runtimeUser:runtimeRole}});
  at=performance.now();const rows=await withReadOnlyTransaction(pool,currentUsers),sourceRowsSha256=creditRowsDigest(rows),otherEventWithoutState=rows.filter(row=>row.hasOtherCreditEvent&&!row.hasCreditState).length;timings.cohortReadMs=Math.round(performance.now()-at);
  if(mode==='prepare'){
   const preview=buildCreditInitializationBatches(rows,{batchKeyPrefix:`r06-${epoch.oid}-${sourceRowsSha256.slice(0,12)}`,reason:'承接本轮旧主体，按新平台政策补齐缺失的初始信用档案，保留已有档案与历史事件。',denominator:ready,maxBatch:500});
   assert(preview.reconciliation.balanced,'CREDIT_DENOMINATOR_UNBALANCED');writePrivate(join(out,'preview-rows.json'),rows);writePrivate(join(out,'retained-by-reason.json'),preview.retainedByReason);
   const batches=preview.batches.map(batch=>{const file=`batch-${String(batch.order).padStart(4,'0')}.json`;writeFileSync(join(out,file),batch.bytes,{flag:'wx'});return{file,sha256:batch.sha256,batchKey:batch.package.batchKey,userCount:batch.package.userIds.length};});
   summary={...summary,status:'PREPARED_NOT_APPROVED',sourceRowsSha256,policy:CREDIT_INITIALIZATION_POLICY,categoryCounts:creditCategoryCounts(rows),reconciliation:preview.reconciliation,otherEventWithoutState,batches};
  }else{
   assert.equal(sourceRowsSha256,plan.sourceRowsSha256,'CREDIT_PLAN_SNAPSHOT_DRIFT');assert.equal(otherEventWithoutState,0,'CREDIT_ORPHAN_EVENT_REQUIRES_REVIEW');
   const planDir=dirname(privatePath(v.plan)),packages=plan.batches.map(item=>{assert.equal(basename(item.file),item.file);const file=privatePath(join(planDir,item.file)),body=pinned(file,item.sha256);assert.equal(body.batchKey,item.batchKey);assert.equal(body.userIds.length,item.userCount);return{item,file,body};});
   const ids=packages.flatMap(p=>p.body.userIds);assert.equal(ids.length,authority.eligibleCount);assert.equal(new Set(ids).size,ids.length);assert.deepEqual(ids,rows.filter(r=>r.category==='ACTIVE'&&!r.hasCreditState&&!r.hasInitializedEvent&&!r.hasOtherCreditEvent).map(r=>r.userId));
   let writerBackendPid;at=performance.now();const before=await withReadOnlyTransaction(pool,async c=>{writerBackendPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return{states:creditRetainedDigest((await c.query('SELECT to_jsonb(c)::text AS row FROM zzsh_credit.user_credit_state c ORDER BY c.user_id COLLATE "C"')).rows),events:creditRetainedDigest((await c.query('SELECT to_jsonb(e)::text AS row FROM zzsh_credit.credit_event e ORDER BY e.id COLLATE "C"')).rows)};});timings.retainedBaselineMs=Math.round(performance.now()-at);
   summary={...summary,approvalSha256:v['authority-sha'],planManifestSha256:v['plan-sha'],categoryCounts:plan.categoryCounts,reconciliation:plan.reconciliation,otherEventWithoutState:plan.otherEventWithoutState,retainedBefore:before};writeLoadCheckpoint(join(out,'summary.json'),summary);
   const runs=await executeCreditBatchSequence(packages,{
    approvalRef:authority.approvalRef,attempt:authority.attempt,
    beforeBatch:async()=>{registry();verifyBuild();await lockStillHeld();},beforeMode:async()=>lockStillHeld(),
    createRun:async({item,file},leafMode)=>{
     const leafFile=join(out,item.file.replace('.json',`.${leafMode.toLowerCase()}.approval.json`));
     writePrivate(leafFile,{schema:'credit-init-approval-v2',status:'APPROVED',approvalRef:authority.approvalRef,attempt:authority.attempt,actor:authority.actor,windowStartUtc:authority.windowStartUtc,windowEndUtc:authority.windowEndUtc,resource,mode:leafMode,businessPackageSha256:item.sha256});
     const run=readCreditInitializationRun({CREDIT_INIT_ENABLED:'true',CREDIT_INIT_PACKAGE_FILE:file,CREDIT_INIT_PACKAGE_SHA256:item.sha256,CREDIT_INIT_APPROVAL_FILE:leafFile,CREDIT_INIT_APPROVAL_SHA256:sha(readFileSync(leafFile)),CREDIT_INIT_MODE:leafMode},undefined,Date.now(),{databaseName:database,databaseUser:runtimeRole});
     return{input:run.input,fingerprint:creditInitializationFingerprint(run.input)};
    },
    saveSummary:async value=>writeLoadCheckpoint(join(out,'summary.json'),value),
    preview:async input=>withReadOnlyTransaction(pool,c=>previewCreditInitialization(c,input)),
    apply:async input=>runCreditInitializationBatch(pool,input),
    saveResult:async({item},result)=>writePrivate(join(out,item.file.replace('.json','.result.json')),result),
   },summary);
   await lockStillHeld();verifyBuild();await pool.end();poolClosed=true;summary.writePoolClosed=true;writeLoadCheckpoint(join(out,'summary.json'),summary);
   pool=guardedPool('r06-credit-independent-readback');poolClosed=false;await assertBusinessRuntimeIdentity(pool,{database:{name:database,user:runtimeRole,runtimeUser:runtimeRole}});
   at=performance.now();summary.readback=await withReadOnlyTransaction(pool,async c=>{
    const readbackPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;assert(readbackPid!==writerBackendPid,'CREDIT_INDEPENDENT_CONNECTION_REQUIRED');
    const after={states:creditRetainedDigest((await c.query('SELECT to_jsonb(c)::text AS row FROM zzsh_credit.user_credit_state c WHERE NOT (c.user_id=ANY($1::text[])) ORDER BY c.user_id COLLATE "C"',[ids])).rows),events:creditRetainedDigest((await c.query('SELECT to_jsonb(e)::text AS row FROM zzsh_credit.credit_event e WHERE NOT (e.user_id=ANY($1::text[])) ORDER BY e.id COLLATE "C"',[ids])).rows)};
    assert.deepEqual(after,before,'CREDIT_EXISTING_STATE_OR_EVENT_DRIFT');
    const exact=(await c.query(`SELECT count(*)::int AS n FROM zzsh_credit.user_credit_state c WHERE c.user_id=ANY($1::text[]) AND c.score=100 AND c.revision=1 AND (SELECT count(*) FROM zzsh_credit.credit_event e WHERE e.user_id=c.user_id)=1 AND EXISTS(SELECT 1 FROM zzsh_credit.credit_event e WHERE e.user_id=c.user_id AND e.event_key='initial:'||c.user_id AND e.event_type='INITIALIZED' AND e.source_type='SYSTEM' AND e.source_id=c.user_id AND e.delta_score=0 AND e.applied_delta_score=0 AND e.score_before=100 AND e.score_after=100 AND e.internal_basis=$2)`,[ids,CREDIT_INITIALIZATION_POLICY])).rows[0].n;assert.equal(exact,ids.length,'CREDIT_INDEPENDENT_READBACK_CHANGED');
    for(const run of runs){const r=await readCreditInitializationReceipt(c,run);assert(r.state==='FOUND'&&r.receipt.fingerprint===creditInitializationFingerprint(run)&&r.receipt.alreadyInitialized.length===0&&JSON.stringify([...r.receipt.applied].sort())===JSON.stringify([...run.userIds].sort()),'CREDIT_BATCH_RECEIPT_NOT_FOUND');}
    const keys=packages.map(p=>p.body.batchKey),audits=(await c.query("SELECT object_id,count(*)::int n FROM zzsh_iam.audit_event WHERE actor_id=$1 AND action='credit.initialization.batch' AND outcome='SUCCESS' AND object_id=ANY($2::text[]) GROUP BY object_id",[actor.actorId,keys])).rows;
    assert(audits.length===keys.length&&audits.every(r=>r.n===1),'CREDIT_AUDIT_READBACK_CHANGED');return{exact,retained:after,receiptBatches:runs.length,auditBatches:audits.length,independentConnection:true};
   });timings.independentReadbackMs=Math.round(performance.now()-at);
   summary.status='CREDIT_INITIALIZATION_READBACK_PASS';
  }
 }catch(error){
  const code=/^[A-Z][A-Z0-9_:.]{1,100}$/.test(error.message??'')?error.message:error.cause?.code??error.code??error.name;
  summary.status=error.outcome==='COMMIT_UNKNOWN'?'COMMIT_UNKNOWN_STOPPED':summary.pending?.commitAck?'COMMIT_ACK_RECEIPT_FAILED_STOPPED':mode==='execute'&&summary.batches.length?(summary.batches.length===plan.batches.length?'COMMITTED_ACK_READBACK_REQUIRED':'PARTIAL_COMMITTED_STOPPED'):'STOPPED';summary.error={code,outcome:error.outcome??null,preserved:error.preserved??summary.pending??null};
  console.error(JSON.stringify({status:summary.status,code}));process.exitCode=1;
 }finally{
  try{if(pool){await pool.end();poolClosed=true;}}catch{process.exitCode=1;}
  try{if(held)unlockAck=(await lock.query('SELECT pg_advisory_unlock(806006::bigint) AS ok')).rows[0].ok;}catch{process.exitCode=1;}
  try{if(lock){await lock.end();lockClosed=true;}}catch{process.exitCode=1;}
  if(summary){if(!unlockAck||!poolClosed||!lockClosed||lockError||transportError){process.exitCode=1;if(['PREPARED_NOT_APPROVED','CREDIT_INITIALIZATION_READBACK_PASS'].includes(summary.status))summary.status='CREDIT_CLEANUP_UNCONFIRMED_STOPPED';}
   Object.assign(summary,{unlockAck,poolClosed,lockClosed,startedAt,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started)});
   const file=join(out,mode==='prepare'?'manifest.json':'summary.json');writeLoadCheckpoint(file,summary);if(mode==='prepare')writeLoadCheckpoint(join(out,'summary.json'),summary);console.log(JSON.stringify({status:summary.status,sha256:sha(readFileSync(file)),batches:summary.batches.length,categoryCounts:summary.categoryCounts,reconciliation:summary.reconciliation,otherEventWithoutState:summary.otherEventWithoutState,readback:summary.readback,unlockAck,poolClosed,lockClosed,elapsedMs:summary.elapsedMs}));}
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'CREDIT_INPUT_STOPPED',code:/^[A-Z][A-Z0-9_:.]{1,100}$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
