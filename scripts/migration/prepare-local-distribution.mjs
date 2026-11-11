import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,readdirSync} from 'node:fs';
import {createRequire,Module} from 'node:module';
import {basename,delimiter,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {validateProfile,writePrivate} from '../local-auth.mjs';
import {assertDistributionCoreReadback,assertDistributionPolicyReceipt,assertDistributionSourceBindings,assertQualificationPlanBinding,assertQualificationPolicy,assertQualificationRecoveryEvidence,assertQualificationRenewalEvidence,assertQualificationConstraintRetryEvidence,assertRegisteredDistributionTarget,buildLegacyQualificationPlan,isolatedDistributionBuild,normalizedDistributionPolicyFormat,privateDistributionPath,reviewedDistributionActor,validatedLegacyDistributionPayload} from './local-distribution-qualification-plan.mjs';
import {loadRegisteredTarget} from './local-target-registry.mjs';
import {inspectRoundDependencyLayout,assertRoundDependencyProof} from './local-round-dependencies.mjs';

const privateRoot=resolve('E:/zzsh-local-state/restricted'),root=resolve(fileURLToPath(new URL('../..',import.meta.url))),sha=b=>createHash('sha256').update(b).digest('hex');
const tools=['run-local-distribution-qualification.mjs','local-distribution-qualification-plan.mjs','local-distribution-qualification-runner.mjs','local-distribution-qualification-readback.mjs','local-distribution-policy-approval.mjs','local-distribution-policy-runtime.mjs','local-source-adapter.mjs','local-target-registry.mjs','local-round-dependencies.mjs','../local-auth.mjs'];
function privatePath(value,output=false){const p=privateDistributionPath(privateRoot,value);for(let at=output?dirname(dirname(p)):p;at!==dirname(at);at=dirname(at))assert(!lstatSync(at).isSymbolicLink(),'REPARSE_POINT_REFUSED');return p;}
function read(p){return JSON.parse(readFileSync(p))}
function pinned(p,digest){const b=readFileSync(privatePath(p));assert.equal(sha(b),digest,'INPUT_SHA_CHANGED');return JSON.parse(b)}
function pin(p){const path=privatePath(p);return{path,sha256:sha(readFileSync(path))}}
function secret(name){const path=resolve('E:/zzsh/zzsh/apps/api/.secrets',name);assert(!lstatSync(path).isSymbolicLink(),'REPARSE_POINT_REFUSED');return{path,sha256:sha(readFileSync(path))}}
function buildFiles(value){const api=isolatedDistributionBuild(root,value);assert(!lstatSync(root).isSymbolicLink(),'BUILD_REPARSE_REFUSED');for(let p=api;p.toLowerCase()!==root.toLowerCase();p=dirname(p))assert(p!==dirname(p)&&!lstatSync(p).isSymbolicLink(),'BUILD_REPARSE_REFUSED');function files(dir,prefix=''){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{assert(!e.isSymbolicLink(),'BUILD_REPARSE_REFUSED');const name=prefix+e.name;return e.isDirectory()?files(join(dir,e.name),name+'/'):e.isFile()&&name.endsWith('.js')?[name]:[]})}return{api,files:Object.fromEntries(files(api).sort().map(name=>[name,sha(readFileSync(join(api,name)))]))}}
function targetContext(input){const credentialsPath=resolve(input.credentials),legacy=resolve('E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/regression_test/credentials.json');if(credentialsPath.toLowerCase()!==legacy.toLowerCase())privatePath(credentialsPath);for(let p=credentialsPath;p!==dirname(p);p=dirname(p))assert(!lstatSync(p).isSymbolicLink(),'REPARSE_POINT_REFUSED');const registry=read(join(dirname(credentialsPath),'resource.json')),registered=loadRegisteredTarget(credentialsPath);registry.instance=registered.instance;assert.equal(registered.lockKey,'806006','DISTRIBUTION_LOCK_BINDING_CHANGED');assert.equal(registered.maintenanceDatabase,'postgres','DISTRIBUTION_MAINTENANCE_DATABASE_CHANGED');assertRegisteredDistributionTarget(input.target,input.dataset.sha256,registry);const credentials=read(credentialsPath);assert(credentials.database===registry.database&&credentials.marker===registry.marker,'REGISTERED_CREDENTIAL_TARGET_CHANGED');for(const role of ['migration','runtime'])assert(credentials[role]?.name===registry.roles?.[role]?.name&&credentials[role]?.oid===registry.roles?.[role]?.oid,'REGISTERED_ROLE_CHANGED');return registry}
function sourceContext(input,candidatePath){const capture=pinned(join(privatePath(input.source.path),'receipt.json'),input.source.sha256),dataset=pinned(join(privatePath(input.dataset.path),'manifest.json'),input.dataset.sha256),candidate=read(privatePath(candidatePath));assertDistributionSourceBindings(input.source.sha256,capture,dataset,candidate);return{capture,dataset,candidate}}
function coreContext(input,evidence){const round=pinned(evidence?.roundReceipt?.path,evidence?.roundReceipt?.sha256),readback=pinned(evidence?.readback?.path,evidence?.readback?.sha256);return assertDistributionCoreReadback(round,readback,{roundInputSha256:evidence.roundInputSha256,readbackSha256:evidence.readback.sha256,datasetSha256:input.dataset.sha256,sourceSha256:input.source.sha256,target:input.target})}
function output(value,receipt,out,name){out=privatePath(out,true);assert.equal(basename(out),name);assert(!existsSync(dirname(out)),'SEALED_OUTPUT_DIRECTORY_EXISTS');writePrivate(out,value);receipt.output=out;receipt.outputSha256=sha(readFileSync(out));writePrivate(join(dirname(out),'seal-receipt.json'),receipt);return receipt}

/** Explicit workflow windows may only narrow the already approved round window. */
export function distributionInputWindow(parent, requested, now = Date.now()) {
  if (requested?.notBefore === undefined && requested?.expiresAt === undefined)
    return { notBefore: new Date(now-3000).toISOString(), expiresAt: new Date(now+25*60*1000).toISOString() };
  const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0,19) === value.slice(0,19);
  assert([parent?.notBefore,parent?.expiresAt,requested?.notBefore,requested?.expiresAt].every(utc), 'DISTRIBUTION_WORKFLOW_WINDOW_INVALID');
  const start=Date.parse(requested.notBefore),end=Date.parse(requested.expiresAt);
  assert(start>=Date.parse(parent.notBefore)&&end<=Date.parse(parent.expiresAt)&&start<=now&&now<end&&end-start<=30*60000,
    'DISTRIBUTION_WORKFLOW_WINDOW_INVALID');
  return {notBefore:new Date(start).toISOString(),expiresAt:new Date(end).toISOString()};
}

export async function main(args=process.argv.slice(2)){
  if(!args.length){console.log(JSON.stringify({status:'PLAN_ONLY',phases:['input','authority'],connections:0,credentialReads:0,financialWrites:0}));return;}
  const [phase,...rest]=args;assert(['input','authority'].includes(phase),'DISTRIBUTION_SEAL_PHASE_REQUIRED');
  const qualificationArgs=['qualification-failure','qualification-inspection','qualification-guard','qualification-previous-plan','qualification-previous-input','qualification-previous-authority'];
  const renewalArgs=['renewal-failure','renewal-inspection','renewal-previous-plan','renewal-previous-input','renewal-previous-authority','renewal-build-manifest'];
  const retryArgs=['retry-failure','retry-inspection','retry-previous-plan','retry-previous-input','retry-previous-authority','retry-prior-recovery-input','retry-upgrade-plan','retry-upgrade-execution','retry-upgrade-readback','retry-build-manifest'];
  const {values:v}=parseArgs({args:rest,options:{'round-input':{type:'string'},'round-sha':{type:'string'},'round-receipt':{type:'string'},'round-receipt-sha':{type:'string'},'core-readback':{type:'string'},'core-readback-sha':{type:'string'},'source-mode':{type:'string'},build:{type:'string'},profile:{type:'string'},'session-one':{type:'string'},'session-two':{type:'string'},actor:{type:'string'},candidate:{type:'string'},'recover-failure':{type:'string'},'recover-failure-sha':{type:'string'},'recover-plan':{type:'string'},'recover-plan-sha':{type:'string'},'recover-guard':{type:'string'},'recover-guard-sha':{type:'string'},'recover-repair-guard':{type:'string'},'recover-repair-guard-sha':{type:'string'},...Object.fromEntries([...qualificationArgs,...renewalArgs,...retryArgs].flatMap(name=>[[name,{type:'string'}],[name+'-sha',{type:'string'}]])),input:{type:'string'},'input-sha':{type:'string'},plan:{type:'string'},'plan-sha':{type:'string'},'policy-receipt':{type:'string'},'policy-sha':{type:'string'},'review-ref':{type:'string'},attempt:{type:'string'},'request-id':{type:'string'},'not-before':{type:'string'},'expires-at':{type:'string'},'dry-run':{type:'boolean'},out:{type:'string'}}});
  assert(!v['dry-run']||phase==='authority','DRY_RUN_AUTHORITY_ONLY');
  const started=performance.now(),startedAt=new Date().toISOString();let receipt,value;
  if(phase==='input'){
    assert(['reused','captured'].includes(v['source-mode']),'SOURCE_MODE_REQUIRED');
    let at=performance.now();const input=pinned(v['round-input'],v['round-sha']);assert.equal(input.schema,'zzsh.local-round.v1');targetContext(input);
    sourceContext(input,v.candidate);const coreEvidence={roundInputSha256:v['round-sha'],roundReceipt:{path:privatePath(v['round-receipt']),sha256:v['round-receipt-sha']},readback:{path:privatePath(v['core-readback']),sha256:v['core-readback-sha']}};
    const financialObservations=coreContext(input,coreEvidence),originalRound=pinned(coreEvidence.roundReceipt.path,coreEvidence.roundReceipt.sha256),
      policyFormat=input.growth?.packageLayout==='PACKED_V2'?'SOURCE_API_NORMALIZED_V1':undefined;
    normalizedDistributionPolicyFormat(policyFormat,originalRound);
    const sourceValidationMs=Math.round(performance.now()-at);at=performance.now();
    const actor=read(privatePath(v.actor)),profile=validateProfile(read(privatePath(v.profile))),one=profile.actors['boss-one'],two=profile.actors['boss-two'];
    assert(one?.realm==='admin'&&two?.realm==='admin'&&one.userId!==two.userId&&actor.realm==='admin'&&(actor.id??actor.actorId)===one.userId&&actor.sessionId&&actor.resourceOid===input.target.oid&&actor.nonce===input.target.nonce&&one.origin===two.origin,'NEW_TARGET_BOSS_ACTOR_REQUIRED');
    for(const p of [v['session-one'],v['session-two']])assert(Array.isArray(read(privatePath(p)).cookies),'REGISTERED_SESSION_STATE_REQUIRED');
    const actorInputMs=Math.round(performance.now()-at);at=performance.now();const build=buildFiles(v.build);
    for(const name of ['finance/distribution-policy-store.js','finance/controlled-regression-resource.js','finance/legacy-invitation-facts-maintenance.js','auth/auth-runtime.js','auth/auth-security.js','auth/approval-audit.js'])assert(build.files[name],`BUILD_MODULE_MISSING:${name}`);
    const approvalBuild=readFileSync(join(build.api,'auth/approval-audit.js'),'utf8');assert(approvalBuild.includes('expected-version:')&&approvalBuild.includes('approval-template-v1'),'TEMPLATE_CAS_BUILD_REQUIRED');
    const buildSealMs=Math.round(performance.now()-at),now=Date.now(),window=distributionInputWindow(input.window,{notBefore:v['not-before'],expiresAt:v['expires-at']},now);
    const recoveryArgs=['recover-failure','recover-failure-sha','recover-plan','recover-plan-sha','recover-guard','recover-guard-sha','recover-repair-guard','recover-repair-guard-sha'],hasRecovery=recoveryArgs.some(name=>v[name]!==undefined);
    let recovery;if(hasRecovery){assert(recoveryArgs.every(name=>typeof v[name]==='string'&&v[name].length>0),'DISTRIBUTION_RECOVERY_REFS_REQUIRED');
      const checked=(path,expected)=>{const value=pin(path);assert.equal(value.sha256,expected,'DISTRIBUTION_RECOVERY_REF_CHANGED');return value;};
      recovery={failure:checked(v['recover-failure'],v['recover-failure-sha']),plan:checked(v['recover-plan'],v['recover-plan-sha']),guardProbe:checked(v['recover-guard'],v['recover-guard-sha']),repairGuard:checked(v['recover-repair-guard'],v['recover-repair-guard-sha']),round:checked(v['round-input'],v['round-sha'])};}
    const hasQualificationRecovery=qualificationArgs.some(name=>v[name]!==undefined||v[name+'-sha']!==undefined);let qualificationRecovery;
    if(hasQualificationRecovery){assert(recovery&&qualificationArgs.every(name=>typeof v[name]==='string'&&typeof v[name+'-sha']==='string'),'DISTRIBUTION_QUALIFICATION_RECOVERY_REFS_REQUIRED');
      const checked=(name)=>{const value=pin(v[name]);assert.equal(value.sha256,v[name+'-sha'],'DISTRIBUTION_QUALIFICATION_RECOVERY_REF_CHANGED');return value;};
      qualificationRecovery={failure:checked('qualification-failure'),inspection:checked('qualification-inspection'),guard:checked('qualification-guard'),previousPlan:checked('qualification-previous-plan'),previousInput:checked('qualification-previous-input'),previousAuthority:checked('qualification-previous-authority')};
      const prior=read(qualificationRecovery.previousAuthority.path),start=Date.parse(prior.notBefore),end=Date.parse(prior.expiresAt);
      assert(Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end,'DISTRIBUTION_QUALIFICATION_ORIGINAL_WINDOW_EXPIRED');
      window.notBefore=new Date(Math.max(Date.parse(window.notBefore),start)).toISOString();window.expiresAt=new Date(Math.min(Date.parse(window.expiresAt),end)).toISOString();}
    const hasRenewal=renewalArgs.some(name=>v[name]!==undefined||v[name+'-sha']!==undefined);let qualificationRenewal;
    if(hasRenewal){assert(recovery&&!qualificationRecovery&&renewalArgs.every(name=>typeof v[name]==='string'&&typeof v[name+'-sha']==='string'),'DISTRIBUTION_QUALIFICATION_RENEWAL_REFS_REQUIRED');
      const checked=name=>{const value=pin(v[name]);assert.equal(value.sha256,v[name+'-sha'],'DISTRIBUTION_RENEWAL_REF_CHANGED');return value;};
      qualificationRenewal={failure:checked('renewal-failure'),inspection:checked('renewal-inspection'),previousPlan:checked('renewal-previous-plan'),previousInput:checked('renewal-previous-input'),previousAuthority:checked('renewal-previous-authority'),buildManifest:checked('renewal-build-manifest')};
      const prior=read(qualificationRenewal.previousAuthority.path);assert(Date.parse(prior.expiresAt)<=now,'DISTRIBUTION_RENEWAL_REQUIRES_EXPIRED_WINDOW');}
    const hasRetry=retryArgs.some(name=>v[name]!==undefined||v[name+'-sha']!==undefined);let qualificationConstraintRetry;
    if(hasRetry){assert(recovery&&!qualificationRecovery&&!qualificationRenewal&&retryArgs.every(name=>typeof v[name]==='string'&&typeof v[name+'-sha']==='string'),'DISTRIBUTION_CONSTRAINT_RETRY_REFS_REQUIRED');
      const checked=name=>{const value=pin(v[name]);assert.equal(value.sha256,v[name+'-sha'],'DISTRIBUTION_CONSTRAINT_RETRY_REF_CHANGED');return value;};
      qualificationConstraintRetry={failure:checked('retry-failure'),inspection:checked('retry-inspection'),previousPlan:checked('retry-previous-plan'),previousInput:checked('retry-previous-input'),previousAuthority:checked('retry-previous-authority'),priorRecoveryInput:checked('retry-prior-recovery-input'),upgradePlan:checked('retry-upgrade-plan'),upgradeExecution:checked('retry-upgrade-execution'),upgradeReadback:checked('retry-upgrade-readback'),buildManifest:checked('retry-build-manifest')};
      const prior=read(qualificationConstraintRetry.previousAuthority.path);assert(Date.parse(prior.expiresAt)<=now,'DISTRIBUTION_RETRY_REQUIRES_EXPIRED_WINDOW');}
    value={schema:'zzsh.local-round.v1',target:input.target,source:input.source,dataset:input.dataset,credentials:input.credentials,actor:pin(v.actor),apiDist:build.api,buildFiles:build.files,window,distribution:{scope:'NATIVE',...(policyFormat?{policyFormat}:{}),coreEvidence,candidate:pin(v.candidate),...(recovery?{recovery}:{}),...(qualificationRecovery?{qualificationRecovery}:{}),...(qualificationRenewal?{qualificationRenewal}:{}),...(qualificationConstraintRetry?{qualificationConstraintRetry}:{}),lockfileSha256:sha(readFileSync(join(root,'package-lock.json'))),approval:{profile:pin(v.profile),firstActor:'boss-one',secondActor:'boss-two',sessions:{'boss-one':pin(v['session-one']),'boss-two':pin(v['session-two'])},apiOrigin:one.origin,adminOrigin:'http://127.0.0.1:4231',userOrigin:'http://127.0.0.1:4230',adminSecret:secret('auth_admin_secret'),userSecret:secret('auth_user_secret')}}};
    receipt={status:input.target.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'?'SEALED_R07_DISTRIBUTION_INPUT':'SEALED_R06_DISTRIBUTION_INPUT',targetOid:input.target.oid,scope:'NATIVE',apiBuildFiles:Object.keys(build.files).length,notBefore:window.notBefore,expiresAt:window.expiresAt,sourceReceiptSha256:input.source.sha256,datasetSha256:input.dataset.sha256,coreReadbackSha256:coreEvidence.readback.sha256,financialObservations,sourceMode:v['source-mode'],timings:{sourceValidationMs,actorInputMs,buildSealMs},connections:0,financialWrites:0};
  }else{
    for(const name of ['review-ref','attempt','request-id'])assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(v[name]??''),'REVIEW_IDENTIFIER_REQUIRED:'+name);
    const input=pinned(v.input,v['input-sha']),plan=pinned(v.plan,v['plan-sha']),policyReceipt=pinned(v['policy-receipt'],v['policy-sha']),registry=targetContext(input),d=input.distribution;assert.equal(d?.scope,'NATIVE','NATIVE_SCOPE_REQUIRED');coreContext(input,d.coreEvidence);
    const manifest=pinned(join(privatePath(input.dataset.path),'manifest.json'),input.dataset.sha256),build=buildFiles(input.apiDist);
    assert.deepEqual(build.files,input.buildFiles,'BUILD_CHANGED');assert.deepEqual(Object.keys(plan.toolFiles).sort(),[...tools].sort(),'TOOL_SET_CHANGED');
    for(const name of tools)assert.equal(sha(readFileSync(join(root,'scripts/migration',name))),plan.toolFiles[name],'TOOL_CHANGED');
    assert.equal(sha(readFileSync(join(root,'package-lock.json'))),d.lockfileSha256,'LOCKFILE_CHANGED');
    let moduleDirs=[join(root,'apps/api/node_modules'),join(root,'node_modules')];
    if(d.recovery){const round=pinned(d.recovery.round?.path,d.recovery.round?.sha256),b=round.dependencyBinding,proof=pinned(b?.proof?.path,b?.proof?.sha256);
      const layout=inspectRoundDependencyLayout({apiDist:round.apiDist,bundlePath:round.bootstrapEvidence.bundle.path,bundleSha256:round.bootstrapEvidence.bundle.sha256,buildManifestPath:b.buildManifest.path,buildManifestSha256:b.buildManifest.sha256,sourceSnapshot:b.sourceSnapshot,sourceManifestPath:b.sourceManifest.path,sourceManifestSha256:b.sourceManifest.sha256});assertRoundDependencyProof(proof,layout);moduleDirs=layout.moduleDirs;}
    process.env.NODE_PATH=moduleDirs.join(delimiter);Module._initPaths();
    const require=createRequire(import.meta.url),{canonicalize}=require(join(build.api,'supply/content-hash.js'));
    const binding={inputSha256:v['input-sha'],datasetSha256:input.dataset.sha256,sourceDigest:input.source.sha256,candidateSha256:d.candidate.sha256,scope:d.scope,target:{oid:input.target.oid,nonce:input.target.nonce,database:registry.database,marker:registry.marker,migrationRoleOid:input.target.migrationRoleOid,instance:registry.instance,...(input.target.migrationProfile?{migrationProfile:input.target.migrationProfile}:{})},expectedParticipants:manifest.domains.users.ready,buildDigest:sha(canonicalize(input.buildFiles)),toolFiles:plan.toolFiles};
    assertQualificationPlanBinding(plan,binding,canonicalize);
    const candidate=pinned(d.candidate.path,d.candidate.sha256),sourcePayload=candidate.approvalPayloads.find(p=>p.config.scope===d.scope),
      originalRound=pinned(d.coreEvidence.roundReceipt.path,d.coreEvidence.roundReceipt.sha256),fresh=normalizedDistributionPolicyFormat(d.policyFormat,originalRound),
      payload=validatedLegacyDistributionPayload(sourcePayload,require(join(build.api,'finance/distribution-policy-change.js')).parseDistributionPolicyChange,canonicalize,fresh);
    assertQualificationPolicy(plan,buildLegacyQualificationPlan({participants:[],packets:[],payload,sourceDigest:input.source.sha256,canonicalize,projectQualification:()=>{},expectedParticipants:0}),canonicalize);
    const q=d.qualificationRecovery;
    if(q){const evidence=Object.fromEntries(['failure','inspection','guard','previousPlan','previousInput','previousAuthority'].map(name=>[name,pinned(q[name]?.path,q[name]?.sha256)]));
      assertQualificationRecoveryEvidence({...evidence,plan,input,refs:q,canonicalize});
      assert(v['review-ref']===evidence.previousAuthority.approvalRef&&v.attempt===evidence.previousAuthority.attempt&&v['request-id']===evidence.previousAuthority.actor?.requestId,'DISTRIBUTION_QUALIFICATION_RECOVERY_AUTHORITY_CHANGED');}
    const r=d.qualificationRenewal;let renewalEvidence;
    if(r){renewalEvidence=Object.fromEntries(['failure','inspection','previousPlan','previousInput','previousAuthority','buildManifest'].map(name=>[name,pinned(r[name]?.path,r[name]?.sha256)]));
      assertQualificationRenewalEvidence({...renewalEvidence,plan,input,refs:r,canonicalize});
      assert(v['review-ref']!==renewalEvidence.previousAuthority.approvalRef&&v.attempt!==renewalEvidence.previousAuthority.attempt,'DISTRIBUTION_RENEWAL_NEW_AUTHORITY_REQUIRED');}
    const r2=d.qualificationConstraintRetry;let retryEvidence;
    if(r2){retryEvidence=Object.fromEntries(['failure','inspection','previousPlan','previousInput','previousAuthority','priorRecoveryInput','upgradePlan','upgradeExecution','upgradeReadback','buildManifest'].map(name=>[name,pinned(r2[name]?.path,r2[name]?.sha256)]));
      assertQualificationConstraintRetryEvidence({...retryEvidence,plan,input,refs:r2,canonicalize});
      assert(v['review-ref']!==retryEvidence.previousAuthority.approvalRef&&v.attempt!==retryEvidence.previousAuthority.attempt,'DISTRIBUTION_RETRY_NEW_AUTHORITY_REQUIRED');}
    const policyInputSha=r2?retryEvidence.priorRecoveryInput.distribution.qualificationRecovery.previousInput.sha256:r?renewalEvidence.previousInput.distribution.qualificationRecovery.previousInput.sha256:q?q.previousInput.sha256:undefined;
    assertDistributionPolicyReceipt(policyReceipt,{...binding,...(policyInputSha?{inputSha256:policyInputSha}:{}),policyId:plan.policyId,historicalFinance:plan.historicalFinance},canonicalize);
    const actorFile=pinned(input.actor.path,input.actor.sha256),actorId=actorFile.id??actorFile.actorId,actor=reviewedDistributionActor(actorFile,input.target,{userId:actorId,sessionId:actorFile.sessionId,requestId:v['request-id']});
    const now=Date.now(),renewed=r||r2,begin=renewed?Date.parse(v['not-before']):Math.max(Date.parse(input.window.notBefore),now-1000),end=renewed?Date.parse(v['expires-at']):Math.min(Date.parse(input.window.expiresAt),now+20*60*1000);
    assert(Number.isFinite(begin)&&Number.isFinite(end)&&begin>=Date.parse(input.window.notBefore)&&end<=Date.parse(input.window.expiresAt)&&end>begin&&(!renewed||end-begin<=20*60*1000)&&begin<=now&&now<end,'INPUT_WINDOW_EXPIRED_OR_INVALID');
    if(renewed){const prior=(r?renewalEvidence:retryEvidence).previousAuthority;assert(actor.userId===prior.actor.userId&&actor.sessionId===prior.actor.sessionId,'DISTRIBUTION_RENEWAL_ACTOR_CHANGED');}
    value={schema:'root-reviewed-legacy-distribution-qualification.v2',approvedBy:'Root',status:'APPROVED',inputSha256:v['input-sha'],planSha256:v['plan-sha'],target:binding.target,scope:d.scope,policyId:plan.policyId,policyDigest:plan.policyDigest,policyReceipt:{path:privatePath(v['policy-receipt']),sha256:v['policy-sha']},lock:806006,allowFinancialWrites:false,notBefore:new Date(begin).toISOString(),expiresAt:new Date(end).toISOString(),approvalRef:v['review-ref'],attempt:v.attempt,actor,...(renewed?{maxBatches:plan.batches.length,maxSubjectsPerBatch:1000,sourceLock:'TRANSACTION_SHARE_AUDIT_AND_INVITATION_GRAPH'}:{})};
    receipt={status:input.target.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'?'SEALED_R07_QUALIFICATION_AUTHORITY':'SEALED_R06_QUALIFICATION_AUTHORITY',targetOid:input.target.oid,scope:d.scope,plannedParticipants:plan.accepted.length,batches:plan.batches.length,planSha256:v['plan-sha'],policyReceiptSha256:v['policy-sha'],notBefore:value.notBefore,expiresAt:value.expiresAt,connections:0,financialWrites:0};
  }
  if(v['dry-run']){console.log(JSON.stringify({status:'READY_FOR_SIGNED_WINDOW',inputSha256:value.inputSha256,planSha256:value.planSha256,notBefore:value.notBefore,expiresAt:value.expiresAt,approvalRef:value.approvalRef,attempt:value.attempt,lock:value.lock,maxBatches:value.maxBatches,maxSubjectsPerBatch:value.maxSubjectsPerBatch,sourceLock:value.sourceLock,allowFinancialWrites:value.allowFinancialWrites,actorBound:true,authorityCreated:false,connections:0}));return;}
  Object.assign(receipt,{toolSha256:sha(readFileSync(fileURLToPath(import.meta.url))),startedAt,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started)});
  console.log(JSON.stringify(output(value,receipt,v.out,phase==='input'?'input.json':'authority.json')));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'STOPPED_BEFORE_SEAL',code:/^[A-Z][A-Z0-9_:.]{1,100}$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
