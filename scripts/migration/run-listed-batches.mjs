import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createReadStream,existsSync,lstatSync,readFileSync} from 'node:fs';
import Module,{createRequire} from 'node:module';
import {basename,delimiter,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writePrivate} from '../local-auth.mjs';
import {assertDistributionCoreReadback,assertRegisteredDistributionTarget,isolatedDistributionBuild} from './local-distribution-qualification-plan.mjs';
import {assertListedRunnerScripts,assertRoundDependencyProof,inspectRoundDependencyLayout} from './local-round-dependencies.mjs';
import {readRoundListedBatch,validateRoundAccountSet,validateRoundTrialReceipt} from './legacy-listed-round-source.mjs';
import {validateListedExecutionCheckpoint} from './legacy-listed-execution-plan.mjs';
import {scanEmptyListedSource} from './readback-empty-legacy-listed.mjs';
import {runListedBatchWorkflow} from './listed-batch-workflow.mjs';
import {assertNextMigrationWriteReady,loadRegisteredTarget,NEXT_MIGRATION_PROFILE} from './local-target-registry.mjs';
import {assertDisplayCaptureCoverage} from './local-source-adapter.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex'),hex=value=>/^[a-f0-9]{64}$/.test(value??'');
async function main(){
 const args=process.argv.slice(2);
 if(!args.length){console.log(JSON.stringify({status:'PLAN_ONLY',modes:['--validate','--execute'],required:['--input','--input-sha'],executeAlsoRequires:['--maintenance-password-file','--out'],connections:0,targetWrites:0}));return;}
 const mode=args[0],names=mode==='--execute'?['--input','--input-sha','--maintenance-password-file','--out']:['--input','--input-sha'],options=new Map();
 assert(['--validate','--execute'].includes(mode)&&process.version==='v24.20.0'&&args.length===1+names.length*2,'LISTED_RUN_ARGUMENTS_INVALID');
 for(let i=1;i<args.length;i+=2){assert(names.includes(args[i])&&!options.has(args[i])&&args[i+1]&&!args[i+1].startsWith('--'),'LISTED_RUN_ARGUMENTS_INVALID');options.set(args[i],args[i+1]);}
 const option=name=>options.get(name),root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
 function privatePath(value,output=false){
  assert(typeof value==='string'&&isAbsolute(value),'LISTED_RUN_PRIVATE_PATH_REQUIRED');const path=resolve(value),rel=relative(restricted,path);
  assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'LISTED_RUN_PRIVATE_PATH_REQUIRED');
  for(let current=output?dirname(path):path;;current=dirname(current)){
   if(existsSync(current))assert(!lstatSync(current).isSymbolicLink(),'LISTED_RUN_LINK_REFUSED');
   if(current.toLowerCase()===restricted.toLowerCase())break;
  }
  return path;
 }
 function pinned(ref,allowOutside=false){
  assert(typeof ref?.path==='string'&&isAbsolute(ref.path)&&hex(ref.sha256),'LISTED_RUN_INPUT_INVALID');
  const path=allowOutside?resolve(ref.path):privatePath(ref.path);
  if(allowOutside)for(let current=path;current!==dirname(current);current=dirname(current))assert(!lstatSync(current).isSymbolicLink(),'LISTED_RUN_LINK_REFUSED');
  const bytes=readFileSync(path);assert(sha(bytes)===ref.sha256,'LISTED_RUN_INPUT_CHANGED');return JSON.parse(bytes);
 }
 const inputRef={path:option('--input'),sha256:option('--input-sha')},input=pinned(inputRef);
 assert(input.schema==='zzsh.listed-batch-run-input.v1'&&typeof input.creditGuaranteeEnabled==='boolean','LISTED_RUN_INPUT_INVALID');
 const round=pinned(input.roundInput),core=pinned(input.coreReceipt),coreReadback=pinned(input.coreReadback),sourceBinding=pinned(input.sourceBinding,true),policyReceipt=pinned(input.policyReceipt);
 if(mode==='--execute')assertNextMigrationWriteReady(round.target);
 assert(round.schema==='zzsh.local-round.v1'&&core.inputSha256===input.roundInput.sha256,'LISTED_RUN_ROUND_CHANGED');
 assertDistributionCoreReadback(core,coreReadback,{roundInputSha256:input.roundInput.sha256,readbackSha256:input.coreReadback.sha256,
  datasetSha256:round.dataset?.sha256,sourceSha256:round.source?.sha256,target:round.target});
 const datasetDir=privatePath(round.dataset?.path),displayDir=privatePath(round.display?.path),pathsDir=privatePath(round.paths?.path);
 const dataset=pinned({path:join(datasetDir,'manifest.json'),sha256:round.dataset.sha256}),display=pinned({path:join(displayDir,'manifest.json'),sha256:round.display.sha256}),
  paths=pinned({path:join(pathsDir,'receipt.json'),sha256:round.paths.sha256});
 assert(dataset.sourceReceiptSha256===round.source.sha256&&display.datasetSha256===round.dataset.sha256&&paths.datasetSha256===round.dataset.sha256,'LISTED_RUN_PREPARED_INPUT_CHANGED');
 assertDisplayCaptureCoverage(display);
 if(round.holdingOverlay)pinned(round.holdingOverlay);
 const checkFile=async(dir,entry)=>{
  assert(entry&&typeof entry.file==='string'&&entry.file===basename(entry.file)&&hex(entry.sha256),'LISTED_RUN_PREPARED_INPUT_CHANGED');
  const h=createHash('sha256');for await(const bytes of createReadStream(privatePath(join(dir,entry.file))))h.update(bytes);
  assert.equal(h.digest('hex'),entry.sha256,'LISTED_RUN_PREPARED_INPUT_CHANGED');
 };
 await checkFile(datasetDir,dataset.files?.accounts);await checkFile(datasetDir,dataset.files?.users);
 await checkFile(displayDir,{file:display.file,sha256:display.sha256});await checkFile(pathsDir,{file:paths.file,sha256:paths.fileSha256});
 const start=Date.parse(input.window?.notBefore??''),end=Date.parse(input.window?.expiresAt??'');
 assert(Number.isFinite(start)&&Number.isFinite(end)&&start<end&&end-start<=86400000,'LISTED_RUN_WINDOW_INVALID');
 const withinWindow=()=>assert(Date.now()>=start&&Date.now()<end,'LISTED_RUN_WINDOW_INACTIVE');
 if(mode==='--execute')withinWindow();
 const policyDir=dirname(privatePath(input.policyReceipt.path)),manifestFile=privatePath(join(policyDir,'batches.json'));
 const manifestRef={path:manifestFile,sha256:policyReceipt.batchManifestSha256},manifest=pinned(manifestRef);
 assert(policyReceipt.schema==='zzsh.listed-same-capture-policy-preparation.v1'&&policyReceipt.roundInputSha256===input.roundInput.sha256
  &&policyReceipt.sourceReceiptSha256===round.source?.sha256&&policyReceipt.sourceBindingSha256===input.sourceBinding.sha256
  &&policyReceipt.dumpSha256===sourceBinding.restoreRecord?.dumpSha256&&policyReceipt.targetWrites===0&&policyReceipt.dbConnections===0
  &&policyReceipt.runtimeRedis==='NOT_CAPTURED'&&manifest.sourceReceiptSha256===round.source.sha256
  &&manifest.sourceBindingSha256===input.sourceBinding.sha256&&manifest.listedAccounts===policyReceipt.listedAccounts
  &&Array.isArray(policyReceipt.batches)&&Array.isArray(manifest.batches)&&policyReceipt.batches.length===manifest.batches.length
  &&(manifest.listedAccounts===0?policyReceipt.status==='NO_LISTED_SOURCE_ACCOUNTS':
   ['SAME_CAPTURE_POLICY_PREPARED_NO_TARGET','SAME_CAPTURE_BATCHES_PREPARED_NO_TARGET'].includes(policyReceipt.status)),'LISTED_RUN_POLICY_CHANGED');
 assert(isAbsolute(round.credentials??'')&&!lstatSync(round.credentials).isSymbolicLink(),'LISTED_RUN_CREDENTIALS_REQUIRED');
 const resourcePath=join(dirname(round.credentials),'resource.json');assert(!lstatSync(resourcePath).isSymbolicLink(),'LISTED_RUN_LINK_REFUSED');
 const resource=JSON.parse(readFileSync(resourcePath)),registered=loadRegisteredTarget(round.credentials);
 assertRegisteredDistributionTarget(round.target,round.dataset.sha256,resource);
 assert(registered.database===resource.database&&registered.oid===round.target.oid&&registered.nonce===round.target.nonce
  &&JSON.stringify(registered.instance??null)===JSON.stringify(round.target.instance??null)&&registered.migrationRoleOid===round.target.migrationRoleOid,'LISTED_RUN_TARGET_CHANGED');
 const actor=pinned(round.actor),actorId=actor.id??actor.actorId;
 assert(typeof actorId==='string'&&actorId&&typeof actor.sessionId==='string'&&actor.sessionId&&(!actor.actorId||actor.actorId===actorId),'LISTED_RUN_ACTOR_REQUIRED');
 const api=isolatedDistributionBuild(root,round.apiDist),dep=round.dependencyBinding;
 assert(dep?.proof&&dep.buildManifest&&dep.sourceManifest&&round.bootstrapEvidence?.bundle,'LISTED_RUN_DEPENDENCY_REQUIRED');
 const proof=pinned(dep.proof),layout=inspectRoundDependencyLayout({apiDist:api,bundlePath:round.bootstrapEvidence.bundle.path,bundleSha256:round.bootstrapEvidence.bundle.sha256,
  buildManifestPath:dep.buildManifest.path,buildManifestSha256:dep.buildManifest.sha256,sourceSnapshot:dep.sourceSnapshot,sourceManifestPath:dep.sourceManifest.path,sourceManifestSha256:dep.sourceManifest.sha256});
 const runnerDir=dirname(fileURLToPath(import.meta.url)),checkTools=()=>{assertRoundDependencyProof(proof,layout);assertListedRunnerScripts(runnerDir,layout.scriptFiles);};checkTools();
 process.env.NODE_PATH=layout.moduleDirs.join(delimiter);Module._initPaths();const require=createRequire(join(layout.sourceRoot,'apps/api/package.json'));
 const load=name=>{const key=name+'.js',file=join(api,key);assert(hex(round.buildFiles?.[key])&&sha(readFileSync(file))===round.buildFiles[key],'LISTED_RUN_BUILD_CHANGED');return require(file);};
 const {canonicalize}=load('supply/content-hash'),{legacyPriceInteger}=load('supply/legacy-listed-pricing'),{readLegacyListedPolicy}=load('supply/legacy-listed-policy');
 const policyFiles=policyReceipt.batches.map((batch,index)=>{
  const name=manifest.batches.length===1?'policy.json':`policy-${String(index+1).padStart(4,'0')}.json`;
  assert(batch.file===name&&batch.index===index+1&&batch.policyCanonicalSha256===manifest.batches[index]?.policyCanonicalSha256,'LISTED_RUN_POLICY_CHANGED');
  return {file:name,sha256:batch.fileSha256};
 });
 const batches=[];
 if(manifest.batches.length){
  const template=pinned(input.testAuthorityTemplate);
  assert(template.schema==='zzsh.listed-test-authority-template.v1'&&template.status==='APPROVED'
   &&policyReceipt.authorityTemplateSha256===input.testAuthorityTemplate.sha256,'LISTED_RUN_TEST_AUTHORITY_REQUIRED');
  assert(Array.isArray(policyReceipt.audits)&&policyReceipt.audits.length===manifest.batches.length,'LISTED_RUN_AUDITS_REQUIRED');
  for(let index=0;index<manifest.batches.length;index++){
   const descriptor=policyReceipt.audits[index],suffix=manifest.batches.length===1?'':`-${String(index+1).padStart(4,'0')}`;
   assert(descriptor?.index===index+1&&descriptor.auditFile===`audit${suffix}.json`&&descriptor.authorityFile===`authority${suffix}.json`,'LISTED_RUN_AUDIT_CHANGED');
   const policyRef={path:privatePath(join(policyDir,policyFiles[index].file)),sha256:policyFiles[index].sha256};
   const auditRef={path:privatePath(join(policyDir,descriptor.auditFile)),sha256:descriptor.auditFileSha256};
   const authorityRef={path:privatePath(join(policyDir,descriptor.authorityFile)),sha256:descriptor.authorityFileSha256};
   const policy=pinned(policyRef),audit=pinned(auditRef),authority=pinned(authorityRef);
   assert(audit.schema==='zzsh.listed-batch-source-audit.v1'&&audit.status==='SOURCE_FACTS_MATCHED_TARGET_NOT_RUN'
    &&audit.batchIndex===index+1&&audit.batchManifestSha256===manifestRef.sha256&&audit.batchAccountSetSha256===manifest.batches[index].accountSetSha256
    &&audit.policyBundleCanonicalSha256===sha(canonicalize(policy))&&audit.policyAuthorityCanonicalSha256===sha(canonicalize(authority))
    &&audit.sourceReceiptSha256===round.source.sha256&&audit.sourceBindingSha256===input.sourceBinding.sha256&&audit.authorityTemplateSha256===input.testAuthorityTemplate.sha256
    &&audit.r06DatasetManifestSha256===round.dataset.sha256&&audit.r06AccountsSha256===dataset.files.accounts.sha256
    &&audit.r06DisplayFileSha256===display.sha256&&audit.r06PathsFileSha256===paths.fileSha256&&audit.skinOverlaySha256===round.holdingOverlay?.sha256
    &&['decision','scope','runtimeCacheKnowledge','productionCutover','authorityRef','instruction'].every(key=>authority[key]===template[key])
    &&audit.skinTarget==='NOT_ASSESSED'&&audit.quoteTarget==='NOT_ASSESSED'&&audit.dbConnections===0&&audit.targetWrites===0,'LISTED_RUN_AUDIT_CHANGED');
   validateRoundAccountSet({listings:audit.accounts},audit,policy,manifest.batches[index].count);
   const batchBinding={sourceBindingFile:input.sourceBinding.path,sourceBindingSha256:input.sourceBinding.sha256,expectedAccountCount:manifest.batches[index].count,
    batch:{schema:'zzsh.listed-same-capture-batch-binding.v1',manifestFile,manifestSha256:manifestRef.sha256,index:index+1,policyFiles}};
   const selected=await readRoundListedBatch(batchBinding,round,policy,privatePath(round.source.path),canonicalize,legacyPriceInteger);
   const policyCanonical=canonicalize(policy),authorityCanonical=canonicalize(authority);
   for(const item of policy.supplement.accountSourceDigests){const raw=selected.accounts.get(item.id);
    readLegacyListedPolicy(policyCanonical,{proofSha256:sha(policyCanonical),sourceReceiptSha256:round.source.sha256,
     sourceBindingSha256:input.sourceBinding.sha256,dumpSha256:sourceBinding.restoreRecord.dumpSha256,dumpVerifierSha256:policy.verifierSha256,
     sourceId:item.id,sourceDigest:item.sha256,legacyGameId:raw.game_id,expectedAccountCount:manifest.batches[index].count,
     authorityCanonical,authoritySha256:sha(authorityCanonical)});
   }
   batches.push({index:index+1,count:manifest.batches[index].count,policyRef,auditRef,authorityRef,audit});
  }
 }else{
  assert(policyReceipt.listedAccounts===0&&policyReceipt.status==='NO_LISTED_SOURCE_ACCOUNTS','LISTED_RUN_EMPTY_SOURCE_INVALID');
  const receipt=pinned({path:join(privatePath(round.source.path),'receipt.json'),sha256:round.source.sha256});
  await scanEmptyListedSource(privatePath(join(round.source.path,receipt.files.accounts.file)),receipt.files.accounts);
 }
 const dependencies=new Map(proof.closureFiles);
 for(const file of Object.keys(require.cache))if(file.toLowerCase().includes('node_modules')){const name=relative(layout.sourceRoot,file).replaceAll('\\','/');
  assert(name&&!name.startsWith('../')&&!isAbsolute(name)&&dependencies.get(name)===sha(readFileSync(file)),'LISTED_RUN_DEPENDENCY_CHANGED');}
 if(mode==='--validate'){
  console.log(JSON.stringify({status:'LISTED_INPUTS_VALIDATED_TARGET_NOT_RUN',batches:batches.length,listedAccounts:manifest.listedAccounts,connections:0,targetWrites:0}));return;
 }
 const passwordFile=option('--maintenance-password-file');assert(isAbsolute(passwordFile??'')&&!lstatSync(passwordFile).isSymbolicLink(),'LISTED_RUN_LOCK_CREDENTIAL_REQUIRED');
 const out=privatePath(option('--out'),true);assert(!existsSync(out),'LISTED_RUN_OUTPUT_EXISTS');
 const receipt={schema:'zzsh.listed-batch-run-receipt.v1',status:'STARTED',roundInputSha256:input.roundInput.sha256,policyReceiptSha256:input.policyReceipt.sha256,
  batchManifestSha256:manifestRef.sha256,target:round.target,events:[],pending:null,startedAt:new Date().toISOString()};
 const save=()=>writePrivate(join(out,'receipt.json'),receipt);save();
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|SYSTEMDRIVE)$/i.test(key)));
 env.NODE_PATH=layout.moduleDirs.join(delimiter);
 const nextFence=round.target.migrationProfile===NEXT_MIGRATION_PROFILE;
 const fenceArgs=nextFence?['--maintenance-password-file',passwordFile]:[];
 const assertFenced=output=>{if(nextFence)assert(output.targetFence==='HELD_DURING_OPERATION'&&output.targetFenceReleased===true,'LISTED_RUN_TARGET_FENCE_UNCONFIRMED');};
 const ref=file=>({path:file,sha256:sha(readFileSync(file))}),script=name=>join(runnerDir,name),common=['--actor-file',round.actor.path,'--credentials',round.credentials,'--oid',round.target.oid,'--nonce',round.target.nonce,'--api-dist',api];
 function invoke(stage,index,name,childArgs){
  if(!['batch-readback','all-batch-readback','empty-readback'].includes(stage))withinWindow();checkTools();
  const result=spawnSync(process.execPath,[script(name),...childArgs],{cwd:root,env,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,timeout:3600000});
  const diagnostic={stage,index,exitCode:result.status,signal:result.signal,error:result.error?.code??null,stdout:result.stdout??'',stderr:result.stderr??''};
  writePrivate(join(out,`diagnostic-${String(receipt.events.length).padStart(5,'0')}.json`),diagnostic);
  if(result.status!==0||result.signal!==null||result.error)throw new Error('LISTED_RUN_CHILD_STOPPED');
  const lines=(result.stdout??'').trim().split(/\r?\n/);try{return JSON.parse(lines.at(-1));}catch{throw new Error('LISTED_RUN_CHILD_OUTPUT_INVALID');}
 }
 const steps={
  prepareSource(index){const b=batches[index-1],directory=join(out,`source-${index}`),output=invoke('prepare-source',index,'prepare-legacy-listed-source-plan.mjs',[
   '--prepare','--round-input',input.roundInput.path,'--round-input-sha',input.roundInput.sha256,'--core-receipt',input.coreReceipt.path,'--core-receipt-sha',input.coreReceipt.sha256,
   '--scope-audit',b.auditRef.path,'--scope-audit-sha',b.auditRef.sha256,'--source-binding',input.sourceBinding.path,'--policy-bundle',b.policyRef.path,'--policy-authority',b.authorityRef.path,
   '--batch-manifest',manifestFile,'--batch-manifest-sha',manifestRef.sha256,'--batch-index',String(index),'--oid',round.target.oid,'--expected-count',String(b.count),
   '--not-before',input.window.notBefore,'--expires-at',input.window.expiresAt,'--out',directory,...(input.creditGuaranteeEnabled?['--credit-guarantee']:[])]);
   assert(output.status==='SOURCE_PLAN_PREPARED_NO_DATABASE'&&output.accounts===b.count&&output.targetWrites===0,'LISTED_RUN_SOURCE_UNCONFIRMED');return ref(join(directory,'source-plan.json'));},
  prepareTarget(batch){const b=batches[batch.index-1],directory=join(out,`target-${batch.index}`),output=invoke('prepare-target',batch.index,'load-legacy-listed-accounts.mjs',[
   '--prepare','--input',batch.source.path,'--input-sha',batch.source.sha256,'--out',directory,...common,'--source-dir',round.source.path,'--source-receipt-sha',round.source.sha256,
   '--source-binding',input.sourceBinding.path,'--policy-bundle',b.policyRef.path,'--policy-bundle-sha',b.audit.policyBundleCanonicalSha256,
   '--policy-authority',b.authorityRef.path,'--policy-authority-sha',b.audit.policyAuthorityCanonicalSha256,...(input.creditGuaranteeEnabled?['--credit-guarantee']:[]),...fenceArgs]);
   assertFenced(output);
   assert(output.status==='PREPARED_TARGET_READ_ONLY'&&output.ready===b.count&&Array.isArray(output.blocked)&&output.blocked.length===0,'LISTED_RUN_TARGET_PLAN_BLOCKED');return ref(join(directory,'plan.json'));},
  trial(batch){const directory=join(out,`trial-${batch.index}`),output=invoke('trial',batch.index,'load-legacy-listed-accounts.mjs',[
   '--trial','--input',batch.target.path,'--input-sha',batch.target.sha256,'--out',directory,...common,'--maintenance-password-file',passwordFile]);
   assertFenced(output);
   assert(output.status==='TRIAL_ROLLED_BACK'&&output.rejected===0,'LISTED_RUN_TRIAL_BLOCKED');const trialRef=ref(join(directory,'trial.json'));
   const plan=pinned(batch.target);validateRoundTrialReceipt(pinned(trialRef),batch.target.sha256,plan.target,plan.rows,canonicalize);return trialRef;},
  execute(batch){const directory=join(out,`execute-${batch.index}`),output=invoke('execute',batch.index,'load-legacy-listed-accounts.mjs',[
   '--execute','--input',batch.target.path,'--input-sha',batch.target.sha256,'--out',directory,...common,'--maintenance-password-file',passwordFile,
   '--trial-receipt',batch.trial.path,'--trial-receipt-sha',batch.trial.sha256]);
   assertFenced(output);
   assert(output.status==='COMMIT_ACK_REVIEW_REQUIRED'&&output.completed===batches[batch.index-1].count,'LISTED_RUN_EXECUTION_UNCONFIRMED');
   const checkpoint=ref(join(directory,'checkpoint.json')),plan=pinned(batch.target);validateListedExecutionCheckpoint(pinned(checkpoint),batch.target.sha256,plan.target,plan.rows,canonicalize);return checkpoint;},
  readback(batch){const directory=join(out,`readback-${batch.index}`),output=invoke('batch-readback',batch.index,'load-legacy-listed-accounts.mjs',[
   '--readback','--input',batch.target.path,'--input-sha',batch.target.sha256,'--checkpoint',batch.execution.path,'--checkpoint-sha',batch.execution.sha256,'--out',directory,...common,...fenceArgs]);
   assertFenced(output);
   assert(output.status==='LISTED_BATCH_READBACK_PASS'&&output.expected===batches[batch.index-1].count&&output.rentable===output.expected,'LISTED_RUN_BATCH_READBACK_FAILED');return ref(join(directory,'readback.json'));},
  finalize(done){const combined={schema:'zzsh.listed-all-batch-readback-input.v1',roundInput:input.roundInput,coreReceipt:input.coreReceipt,coreReadback:input.coreReadback,batchManifest:manifestRef,
    batches:done.map(batch=>({sourcePlan:batch.source,audit:batches[batch.index-1].auditRef,executionPlan:batch.target,trial:batch.trial,checkpoint:batch.execution,readback:batch.readback,policy:batches[batch.index-1].policyRef}))};
   const file=join(out,'all-readback-input.json');writePrivate(file,combined);const reference=ref(file),directory=join(out,'all-readback');
   const output=invoke('all-batch-readback',null,'readback-listed-batches.mjs',['--readback','--input',file,'--input-sha',reference.sha256,'--maintenance-password-file',passwordFile,'--out',directory]);
   if(nextFence)assert(output.targetFence==='HELD_UNTIL_ROLLBACK','LISTED_RUN_TARGET_FENCE_UNCONFIRMED');
   assert(output.status==='LISTED_ALL_BATCH_READBACK_PASS','LISTED_RUN_FULL_READBACK_FAILED');return ref(join(directory,'readback.json'));},
  emptyReadback(){const file=join(out,'empty-readback-input.json');writePrivate(file,{schema:'zzsh.empty-legacy-listed-readback-input.v1',roundInput:input.roundInput,coreReceipt:input.coreReceipt,coreReadback:input.coreReadback});
   const reference=ref(file),directory=join(out,'empty-readback'),output=invoke('empty-readback',null,'readback-empty-legacy-listed.mjs',[
    '--readback','--input',file,'--input-sha',reference.sha256,'--maintenance-password-file',passwordFile,'--out',directory]);
   if(nextFence)assert(output.targetFence==='HELD_UNTIL_ROLLBACK','LISTED_RUN_TARGET_FENCE_UNCONFIRMED');
   assert(output.status==='EMPTY_LISTED_TARGET_READBACK_PASSED','LISTED_RUN_EMPTY_READBACK_FAILED');return ref(join(directory,'readback.json'));},
 };
 try{
  receipt.readback=await runListedBatchWorkflow({batchCount:batches.length,steps,record:async event=>{
   receipt.pending=event.status==='INTENT'?{stage:event.stage,index:event.index}:null;receipt.events.push({...event,at:new Date().toISOString()});save();
   console.log(JSON.stringify({stage:event.stage,index:event.index,status:event.status}));
  }});
  for(const ref of [inputRef,input.roundInput,input.coreReceipt,input.coreReadback,input.policyReceipt,round.actor,...(batches.length?[input.testAuthorityTemplate]:[])])pinned(ref);
  pinned(input.sourceBinding,true);checkTools();receipt.status=batches.length?'LISTED_BATCHES_AND_FULL_READBACK_PASS':'NO_LISTED_ACCOUNTS_READBACK_PASS';
 }catch(error){receipt.status='STOPPED_PRESERVE_ORIGINAL_KEYS_AND_CHECKPOINTS';receipt.error={code:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name};process.exitCode=1;}
 receipt.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:receipt.status,batches:batches.length,listedAccounts:manifest.listedAccounts,pending:receipt.pending,error:receipt.error??null}));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
 const code=/^([A-Z][A-Z0-9_]+)(?:[:\r\n]|$)/.exec(error.message??'')?.[1]??error.code??error.name;
 console.error(JSON.stringify({status:'LISTED_RUN_STOPPED',code}));process.exitCode=1;
});
