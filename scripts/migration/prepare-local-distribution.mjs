import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,readdirSync} from 'node:fs';
import {createRequire,Module} from 'node:module';
import {basename,delimiter,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {validateProfile,writePrivate} from '../local-auth.mjs';
import {assertDistributionCoreReadback,assertDistributionPolicyReceipt,assertDistributionSourceBindings,assertQualificationPlanBinding,assertQualificationPolicy,assertRegisteredDistributionTarget,buildLegacyQualificationPlan,isolatedDistributionBuild,privateDistributionPath,reviewedDistributionActor} from './local-distribution-qualification-plan.mjs';

const privateRoot=resolve('E:/zzsh-local-state/restricted'),root=resolve(fileURLToPath(new URL('../..',import.meta.url))),sha=b=>createHash('sha256').update(b).digest('hex');
const tools=['run-local-distribution-qualification.mjs','local-distribution-qualification-plan.mjs','local-distribution-qualification-runner.mjs','local-distribution-qualification-readback.mjs','local-distribution-policy-approval.mjs','local-distribution-policy-runtime.mjs','local-source-adapter.mjs','../local-auth.mjs'];
function privatePath(value,output=false){const p=privateDistributionPath(privateRoot,value);for(let at=output?dirname(dirname(p)):p;at!==dirname(at);at=dirname(at))assert(!lstatSync(at).isSymbolicLink(),'REPARSE_POINT_REFUSED');return p;}
function read(p){return JSON.parse(readFileSync(p))}
function pinned(p,digest){const b=readFileSync(privatePath(p));assert.equal(sha(b),digest,'INPUT_SHA_CHANGED');return JSON.parse(b)}
function pin(p){const path=privatePath(p);return{path,sha256:sha(readFileSync(path))}}
function secret(name){const path=resolve('E:/zzsh/zzsh/apps/api/.secrets',name);assert(!lstatSync(path).isSymbolicLink(),'REPARSE_POINT_REFUSED');return{path,sha256:sha(readFileSync(path))}}
function buildFiles(value){const api=isolatedDistributionBuild(root,value);assert(!lstatSync(root).isSymbolicLink(),'BUILD_REPARSE_REFUSED');for(let p=api;p.toLowerCase()!==root.toLowerCase();p=dirname(p))assert(p!==dirname(p)&&!lstatSync(p).isSymbolicLink(),'BUILD_REPARSE_REFUSED');function files(dir,prefix=''){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{assert(!e.isSymbolicLink(),'BUILD_REPARSE_REFUSED');const name=prefix+e.name;return e.isDirectory()?files(join(dir,e.name),name+'/'):e.isFile()&&name.endsWith('.js')?[name]:[]})}return{api,files:Object.fromEntries(files(api).sort().map(name=>[name,sha(readFileSync(join(api,name)))]))}}
function targetContext(input){const credentialsPath=resolve(input.credentials);assert.equal(credentialsPath.toLowerCase(),resolve('E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/regression_test/credentials.json').toLowerCase(),'REGISTERED_CREDENTIAL_PATH_REQUIRED');const registry=read(join(dirname(credentialsPath),'resource.json'));assertRegisteredDistributionTarget(input.target,input.dataset.sha256,registry);const credentials=read(credentialsPath);assert(credentials.database===registry.database&&credentials.marker===registry.marker,'REGISTERED_CREDENTIAL_TARGET_CHANGED');for(const role of ['migration','runtime'])assert(credentials[role]?.name===registry.roles?.[role]?.name&&credentials[role]?.oid===registry.roles?.[role]?.oid,'REGISTERED_ROLE_CHANGED');return registry}
function sourceContext(input,candidatePath){const capture=pinned(join(privatePath(input.source.path),'receipt.json'),input.source.sha256),dataset=pinned(join(privatePath(input.dataset.path),'manifest.json'),input.dataset.sha256),candidate=read(privatePath(candidatePath));assertDistributionSourceBindings(input.source.sha256,capture,dataset,candidate);return{capture,dataset,candidate}}
function coreContext(input,evidence){const round=pinned(evidence?.roundReceipt?.path,evidence?.roundReceipt?.sha256),readback=pinned(evidence?.readback?.path,evidence?.readback?.sha256);return assertDistributionCoreReadback(round,readback,{roundInputSha256:evidence.roundInputSha256,readbackSha256:evidence.readback.sha256,datasetSha256:input.dataset.sha256,sourceSha256:input.source.sha256,target:input.target})}
function output(value,receipt,out,name){out=privatePath(out,true);assert.equal(basename(out),name);assert(!existsSync(dirname(out)),'SEALED_OUTPUT_DIRECTORY_EXISTS');writePrivate(out,value);receipt.output=out;receipt.outputSha256=sha(readFileSync(out));writePrivate(join(dirname(out),'seal-receipt.json'),receipt);return receipt}

export async function main(args=process.argv.slice(2)){
  if(!args.length){console.log(JSON.stringify({status:'PLAN_ONLY',phases:['input','authority'],connections:0,credentialReads:0,financialWrites:0}));return;}
  const [phase,...rest]=args;assert(['input','authority'].includes(phase),'DISTRIBUTION_SEAL_PHASE_REQUIRED');
  const {values:v}=parseArgs({args:rest,options:{'round-input':{type:'string'},'round-sha':{type:'string'},'round-receipt':{type:'string'},'round-receipt-sha':{type:'string'},'core-readback':{type:'string'},'core-readback-sha':{type:'string'},'source-mode':{type:'string'},build:{type:'string'},profile:{type:'string'},'session-one':{type:'string'},'session-two':{type:'string'},actor:{type:'string'},candidate:{type:'string'},input:{type:'string'},'input-sha':{type:'string'},plan:{type:'string'},'plan-sha':{type:'string'},'policy-receipt':{type:'string'},'policy-sha':{type:'string'},'review-ref':{type:'string'},attempt:{type:'string'},'request-id':{type:'string'},out:{type:'string'}}});
  const started=performance.now(),startedAt=new Date().toISOString();let receipt,value;
  if(phase==='input'){
    assert(['reused','captured'].includes(v['source-mode']),'SOURCE_MODE_REQUIRED');
    let at=performance.now();const input=pinned(v['round-input'],v['round-sha']);assert.equal(input.schema,'zzsh.local-round.v1');targetContext(input);
    sourceContext(input,v.candidate);const coreEvidence={roundInputSha256:v['round-sha'],roundReceipt:{path:privatePath(v['round-receipt']),sha256:v['round-receipt-sha']},readback:{path:privatePath(v['core-readback']),sha256:v['core-readback-sha']}};
    const financialObservations=coreContext(input,coreEvidence),sourceValidationMs=Math.round(performance.now()-at);at=performance.now();
    const actor=read(privatePath(v.actor)),profile=validateProfile(read(privatePath(v.profile))),one=profile.actors['boss-one'],two=profile.actors['boss-two'];
    assert(one?.realm==='admin'&&two?.realm==='admin'&&one.userId!==two.userId&&actor.realm==='admin'&&(actor.id??actor.actorId)===one.userId&&actor.sessionId&&actor.resourceOid===input.target.oid&&actor.nonce===input.target.nonce&&one.origin===two.origin,'NEW_TARGET_BOSS_ACTOR_REQUIRED');
    for(const p of [v['session-one'],v['session-two']])assert(Array.isArray(read(privatePath(p)).cookies),'REGISTERED_SESSION_STATE_REQUIRED');
    const actorInputMs=Math.round(performance.now()-at);at=performance.now();const build=buildFiles(v.build);
    for(const name of ['finance/distribution-policy-store.js','finance/controlled-regression-resource.js','finance/legacy-invitation-facts-maintenance.js','auth/auth-runtime.js','auth/auth-security.js','auth/approval-audit.js'])assert(build.files[name],`BUILD_MODULE_MISSING:${name}`);
    const approvalBuild=readFileSync(join(build.api,'auth/approval-audit.js'),'utf8');assert(approvalBuild.includes('expected-version:')&&approvalBuild.includes('approval-template-v1'),'TEMPLATE_CAS_BUILD_REQUIRED');
    const buildSealMs=Math.round(performance.now()-at),now=Date.now(),window={notBefore:new Date(now-3000).toISOString(),expiresAt:new Date(now+25*60*1000).toISOString()};
    value={schema:'zzsh.local-round.v1',target:input.target,source:input.source,dataset:input.dataset,credentials:input.credentials,actor:pin(v.actor),apiDist:build.api,buildFiles:build.files,window,distribution:{scope:'NATIVE',coreEvidence,candidate:pin(v.candidate),lockfileSha256:sha(readFileSync(join(root,'package-lock.json'))),approval:{profile:pin(v.profile),firstActor:'boss-one',secondActor:'boss-two',sessions:{'boss-one':pin(v['session-one']),'boss-two':pin(v['session-two'])},apiOrigin:one.origin,adminOrigin:'http://127.0.0.1:4231',userOrigin:'http://127.0.0.1:4230',adminSecret:secret('auth_admin_secret'),userSecret:secret('auth_user_secret')}}};
    receipt={status:'SEALED_R06_DISTRIBUTION_INPUT',targetOid:input.target.oid,scope:'NATIVE',apiBuildFiles:Object.keys(build.files).length,notBefore:window.notBefore,expiresAt:window.expiresAt,sourceReceiptSha256:input.source.sha256,datasetSha256:input.dataset.sha256,coreReadbackSha256:coreEvidence.readback.sha256,financialObservations,sourceMode:v['source-mode'],timings:{sourceValidationMs,actorInputMs,buildSealMs},connections:0,financialWrites:0};
  }else{
    for(const name of ['review-ref','attempt','request-id'])assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(v[name]??''),'REVIEW_IDENTIFIER_REQUIRED:'+name);
    const input=pinned(v.input,v['input-sha']),plan=pinned(v.plan,v['plan-sha']),policyReceipt=pinned(v['policy-receipt'],v['policy-sha']),registry=targetContext(input),d=input.distribution;assert.equal(d?.scope,'NATIVE','NATIVE_SCOPE_REQUIRED');coreContext(input,d.coreEvidence);
    const manifest=pinned(join(privatePath(input.dataset.path),'manifest.json'),input.dataset.sha256),build=buildFiles(input.apiDist);
    assert.deepEqual(build.files,input.buildFiles,'BUILD_CHANGED');assert.deepEqual(Object.keys(plan.toolFiles).sort(),[...tools].sort(),'TOOL_SET_CHANGED');
    for(const name of tools)assert.equal(sha(readFileSync(join(root,'scripts/migration',name))),plan.toolFiles[name],'TOOL_CHANGED');
    assert.equal(sha(readFileSync(join(root,'package-lock.json'))),d.lockfileSha256,'LOCKFILE_CHANGED');
    process.env.NODE_PATH=[join(root,'apps/api/node_modules'),join(root,'node_modules')].join(delimiter);Module._initPaths();
    const require=createRequire(import.meta.url),{canonicalize}=require(join(build.api,'supply/content-hash.js'));
    const binding={inputSha256:v['input-sha'],datasetSha256:input.dataset.sha256,sourceDigest:input.source.sha256,candidateSha256:d.candidate.sha256,scope:d.scope,target:{oid:input.target.oid,nonce:input.target.nonce,database:registry.database,marker:registry.marker,migrationRoleOid:input.target.migrationRoleOid},expectedParticipants:manifest.domains.users.ready,buildDigest:sha(canonicalize(input.buildFiles)),toolFiles:plan.toolFiles};
    assertQualificationPlanBinding(plan,binding,canonicalize);
    const candidate=pinned(d.candidate.path,d.candidate.sha256),payload=candidate.approvalPayloads.find(p=>p.config.scope===d.scope);
    assertQualificationPolicy(plan,buildLegacyQualificationPlan({participants:[],packets:[],payload,sourceDigest:input.source.sha256,canonicalize,projectQualification:()=>{},expectedParticipants:0}),canonicalize);
    assertDistributionPolicyReceipt(policyReceipt,{...binding,policyId:plan.policyId,historicalFinance:plan.historicalFinance},canonicalize);
    const actorFile=pinned(input.actor.path,input.actor.sha256),actorId=actorFile.id??actorFile.actorId,actor=reviewedDistributionActor(actorFile,input.target,{userId:actorId,sessionId:actorFile.sessionId,requestId:v['request-id']});
    const now=Date.now(),end=Math.min(Date.parse(input.window.expiresAt),now+20*60*1000),begin=Math.max(Date.parse(input.window.notBefore),now-1000);assert(begin<=now&&now<end,'INPUT_WINDOW_EXPIRED');
    value={schema:'root-reviewed-legacy-distribution-qualification.v2',approvedBy:'Root',status:'APPROVED',inputSha256:v['input-sha'],planSha256:v['plan-sha'],target:binding.target,scope:d.scope,policyId:plan.policyId,policyDigest:plan.policyDigest,policyReceipt:{path:privatePath(v['policy-receipt']),sha256:v['policy-sha']},lock:806006,allowFinancialWrites:false,notBefore:new Date(begin).toISOString(),expiresAt:new Date(end).toISOString(),approvalRef:v['review-ref'],attempt:v.attempt,actor};
    receipt={status:'SEALED_R06_QUALIFICATION_AUTHORITY',targetOid:input.target.oid,scope:d.scope,plannedParticipants:plan.accepted.length,batches:plan.batches.length,planSha256:v['plan-sha'],policyReceiptSha256:v['policy-sha'],notBefore:value.notBefore,expiresAt:value.expiresAt,connections:0,financialWrites:0};
  }
  Object.assign(receipt,{toolSha256:sha(readFileSync(fileURLToPath(import.meta.url))),startedAt,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started)});
  console.log(JSON.stringify(output(value,receipt,v.out,phase==='input'?'input.json':'authority.json')));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'STOPPED_BEFORE_SEAL',code:/^[A-Z][A-Z0-9_:.]{1,100}$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
