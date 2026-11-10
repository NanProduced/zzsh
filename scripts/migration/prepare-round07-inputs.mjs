import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile, writePrivate } from '../local-auth.mjs';
import { loadRegisteredTarget, NEXT_MIGRATION_PROFILE } from './local-target-registry.mjs';
import { isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';
import { assertR07BootstrapInputs, makeR07BootstrapBundle, R07_BOOTSTRAP_SECRET_FILES } from './run-round07-bootstrap-api.mjs';
import { assertPolicyRuntimeBinding, validatePolicyContent } from './initialize-local-policy.mjs';
import { validateR07BootstrapProofInputs } from './readback-round07-bootstrap.mjs';
import { makeR07MaintenanceBinding } from './seal-round07-maintenance-binding.mjs';
import { assertRoundBootstrap, assertRoundLegalBootstrap, assertRoundIdentityKeyBinding, assertReviewedGrowthRuleFiles, assertRoundSourceOrigin } from './local-round-contract.mjs';
import { assertRoundPopulationBinding } from './full-source-scope.mjs';
import { LEGACY_REFUND_RELATIONSHIP_POLICY } from './local-source-adapter.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted'),runtime=resolve('E:/zzsh-local-state/runtime'),secretRoot=resolve('E:/zzsh/zzsh/apps/api/.secrets');
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
function inside(base,value,output=false){
 assert(typeof value==='string'&&isAbsolute(value),'R07_ASSEMBLY_PATH_REQUIRED');const p=resolve(value),r=relative(base,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_ASSEMBLY_PATH_REQUIRED');
 for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_ASSEMBLY_LINK_REFUSED');return p;
}
function pathInOneOf(value,bases){for(const base of bases){const r=relative(base,resolve(value??''));if(r&&!r.startsWith('..')&&!isAbsolute(r))return inside(base,value);}throw Error('R07_ASSEMBLY_PATH_REQUIRED');}
function ref(value,bases=[restricted]){const path=pathInOneOf(value,bases),stat=lstatSync(path);assert(stat.isFile()&&!stat.isSymbolicLink(),'R07_ASSEMBLY_FILE_REQUIRED');const bytes=readFileSync(path);return {path,sha256:sha(bytes)};}
function json(r){const bytes=readFileSync(r.path);assert(sha(bytes)===r.sha256,'R07_ASSEMBLY_INPUT_CHANGED');return JSON.parse(bytes);}
function directory(value,base=restricted){const path=inside(base,value),s=lstatSync(path);assert(s.isDirectory()&&!s.isSymbolicLink(),'R07_ASSEMBLY_DIRECTORY_REQUIRED');return path;}
function packageRef(value,file){const path=directory(value),r=ref(join(path,file));return {path,sha256:r.sha256};}
function jsFiles(dir,prefix=''){const result={};for(const item of readdirSync(dir,{withFileTypes:true})){
 assert(!item.isSymbolicLink(),'R07_ASSEMBLY_LINK_REFUSED');const name=prefix+item.name,path=join(dir,item.name);
 if(item.isDirectory())Object.assign(result,jsFiles(path,name+'/'));else if(item.isFile()&&name.endsWith('.js'))result[name]=sha(readFileSync(path));
}return result;}
function exactInstance(a,b){return a?.host===b?.host&&a?.port===b?.port&&a?.systemIdentifier===b?.systemIdentifier;}
export function makeR07Target(registered,schema,{afterRound=false}={}){
 const target={database:registered?.database,oid:registered?.oid,nonce:registered?.nonce,instance:registered?.instance,migrationRoleOid:registered?.migrationRoleOid,
  ...(registered?.migrationProfile?{migrationProfile:registered.migrationProfile}:{}),
  bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED',schemaHashes:schema?.hashes};
 assert((afterRound ? registered?.protectedDataset?.status==='LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED' : registered?.protectedDataset?.status==='ROUND07_BOOTSTRAP_RESERVED')
  &&registered.protectedDataset.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'
  &&registered.protectedDataset.epoch?.oid===target.oid&&registered.protectedDataset.epoch?.nonce===target.nonce,'R07_ASSEMBLY_RESERVATION_CHANGED');
 assertR07BootstrapInputs({schema:'zzsh.round07-bootstrap-runtime-request.v1',target,port:4242,origins:{apiOrigin:'http://127.0.0.1:4242',userOrigin:'http://127.0.0.1:4240',adminOrigin:'http://127.0.0.1:4241'}},registered,schema);
 return target;
}
export function assertR07AssemblyRuntime(binding,target){
 assert(binding?.status==='R07_BOOTSTRAP_API_LISTENING'&&binding.port===4242&&binding.origins?.apiOrigin==='http://127.0.0.1:4242'
  &&binding.origins?.adminOrigin==='http://127.0.0.1:4241'&&binding.NoIM===true&&binding.financialCommandCapabilities===false&&binding.workersEnabled===false
  &&binding.formalAppMounted===true&&binding.maintenanceLockReleased===true&&binding.maintenanceClosed===true
  &&[binding.resource,binding.actualResource].every(r=>r?.database===target.database&&String(r.oid??r.resourceOid)===target.oid&&r.nonce===target.nonce&&exactInstance(r.instance,target.instance)
    &&(r.migrationProfile??null)===(target.migrationProfile??null))
  &&binding.actualResource.read_only==='on'&&String(binding.actualResource.migration_role_oid)===target.migrationRoleOid
  &&binding.initialization?.nonce===target.nonce&&binding.initialization.imProvisioner===false&&binding.initialization.imIdentityRepository===false&&binding.initialization.imAppId===null,
 'R07_ASSEMBLY_RUNTIME_CHANGED');
}
export function makeR07AdminInput({stage,target,bindingRef,credentialRef,bootstrapSecret,names,resource,bossProfile}){
 assert(['bosses','staff'].includes(stage)&&/^[a-z][a-z0-9_-]{0,63}$/.test(resource??'')&&names&&typeof names==='object'
  &&Object.keys(names).sort().join()===['boss-one','boss-two','operations','support'].sort().join()
  &&Object.values(names).every(n=>typeof n==='string'&&n.trim()&&n.length<=120&&!n.startsWith('ROOT_REQUIRED_')),
 'R07_ASSEMBLY_ADMIN_NAMES_REQUIRED');
 assert(hex(bindingRef?.sha256)&&hex(credentialRef?.sha256)&&hex(bootstrapSecret?.sha256),'R07_ASSEMBLY_ADMIN_BINDING_REQUIRED');
 if(stage==='staff')assert(bossProfile&&hex(bossProfile.sha256),'R07_ASSEMBLY_BOSS_PROFILE_REQUIRED');
 return {kind:'FORMAL_LOCAL_ADMIN_INITIALIZATION_V1',stage,numberingDigits:5,target,resource,names,credentialsSha256:credentialRef.sha256,
  serverBinding:{file:bindingRef.path,sha256:bindingRef.sha256},bootstrapSecretFile:bootstrapSecret.path,bootstrapSecretSha256:bootstrapSecret.sha256,
  ...(stage==='staff'?{bossProfileFile:bossProfile.path,bossProfileSha256:bossProfile.sha256}:{})};
}

export function makeR07RoundSecurityBindings({dataset,legalRef,legalInput,business,buildFiles,secrets,runtimeBinding}){
 const identity=dataset?.identityProfiles;
 assert(identity?.schema==='zzsh.legacy-identity-profile-source.v1' && identity.invalid===0
  &&Number.isSafeInteger(identity.ready)&&identity.ready>=0&&identity.verified===identity.ready,'R07_ASSEMBLY_IDENTITY_SOURCE_INCOMPLETE');
 assert(dataset.refundRelationshipPolicy===LEGACY_REFUND_RELATIONSHIP_POLICY,'R07_ASSEMBLY_REFUND_POLICY_REQUIRED');
 assert(business?.catalogModel==='OWNER_KIND_V2','R07_ASSEMBLY_CATALOG_PROFILE_REQUIRED');
 for(const name of ['databaseMaintenance','identitySubjectHmac','identityProfile'])
  assert(typeof secrets?.[name]?.path==='string'&&hex(secrets[name].sha256),'R07_ASSEMBLY_SECRET_REQUIRED:'+name);
 const result={legal:legalRef,secrets};
 assertRoundIdentityKeyBinding(result,runtimeBinding);
 assertRoundLegalBootstrap({...result,buildFiles},legalInput,business?.legal);
 return result;
}

function pinnedApi(spec){
 const api=isolatedDistributionBuild(root,spec.apiDist);for(let x=api;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_ASSEMBLY_LINK_REFUSED');
 const buildFiles=jsFiles(api),buildManifest=ref(spec.buildManifest,[restricted,resolve(root,'tmp')]),sourceManifest=ref(spec.sourceManifest,[restricted,resolve(root,'tmp')]);
 const manifest=json(buildManifest);json(sourceManifest);makeR07BootstrapBundle(buildFiles,manifest,buildManifest.sha256,sourceManifest.sha256);
 return {api,buildFiles,buildManifest,sourceManifest};
}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 if(!args.includes('--prepare')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--prepare','--spec','--spec-sha','--out'],kinds:['runtime','admins-bosses','admins-staff','policy','readback','maintenance','round'],connections:0,targetWrites:0}));return;}
 const specRef=ref(option('--spec'));assert(hex(option('--spec-sha'))&&specRef.sha256===option('--spec-sha'),'R07_ASSEMBLY_SPEC_CHANGED');const spec=json(specRef);
 const out=inside(restricted,option('--out'),true);assert(!existsSync(out)&&spec.schema==='zzsh.round07-assembly-spec.v1','R07_ASSEMBLY_SPEC_INVALID');
 const paths=spec.paths??{},credentials=ref(paths.credentials),registered=loadRegisteredTarget(credentials.path),schemaReceipt=ref(paths.schemaReceipt),schema=json(schemaReceipt),target=makeR07Target(registered,schema,{afterRound:spec.kind==='maintenance'});
 const emit=(name,value)=>{writePrivate(join(out,name),value);const r=ref(join(out,name));console.log(JSON.stringify({status:'R07_INPUT_SEALED_NOT_EXECUTED',kind:spec.kind,input:r.path,sha256:r.sha256,connections:0,targetWrites:0}));};
 if(spec.kind==='runtime'){
  const {api,buildFiles,buildManifest,sourceManifest}=pinnedApi(paths),secrets={};
  for(const key of Object.keys(R07_BOOTSTRAP_SECRET_FILES))secrets[key]=ref(paths.secrets?.[key],[secretRoot]);
  const request={schema:'zzsh.round07-bootstrap-runtime-request.v1',target,credentials,schemaReceipt,apiDist:api,buildFiles,buildManifest,sourceManifest,secrets,
   port:4242,origins:{apiOrigin:'http://127.0.0.1:4242',userOrigin:'http://127.0.0.1:4240',adminOrigin:'http://127.0.0.1:4241'}};
  assertR07BootstrapInputs(request,registered,schema);emit('input.json',request);return;
 }
 const bindingRef=ref(paths.runtimeBinding,[runtime]),binding=json(bindingRef);assertR07AssemblyRuntime(binding,target);
 if(spec.kind==='admins-bosses'||spec.kind==='admins-staff'){
  const runtimeRequestRef=ref(paths.runtimeRequest),runtimeRequest=json(runtimeRequestRef);assertR07BootstrapInputs(runtimeRequest,registered,schema);
  assert(runtimeRequest.credentials.sha256===credentials.sha256&&runtimeRequest.schemaReceipt.sha256===schemaReceipt.sha256
   &&binding.runtimeRequestSha256===runtimeRequestRef.sha256&&binding.bootstrapSecretSha256===runtimeRequest.secrets?.bootstrap?.sha256,'R07_ASSEMBLY_RUNTIME_REQUEST_CHANGED');
  const secret=ref(runtimeRequest.secrets?.bootstrap?.path,[secretRoot]);assert(secret.sha256===runtimeRequest.secrets.bootstrap.sha256,'R07_ASSEMBLY_BOOTSTRAP_SECRET_CHANGED');
  const stage=spec.kind==='admins-bosses'?'bosses':'staff',bossProfile=stage==='staff'?ref(paths.bossProfile):null;
  if(bossProfile){const p=validateProfile(json(bossProfile));assert(Object.keys(p.actors).sort().join()==='boss-one,boss-two'&&p.resource===spec.resource,'R07_ASSEMBLY_BOSS_PROFILE_CHANGED');}
  emit('input.json',makeR07AdminInput({stage,target,bindingRef,credentialRef:credentials,bootstrapSecret:secret,names:spec.names,resource:spec.resource,bossProfile}));return;
 }
 if(spec.kind==='policy'){
  const profile=ref(paths.profile),content=ref(paths.contentManifest),contentValue=json(content),templatePath=join(dirname(content.path),'draft-input-template.json'),template=readFileSync(ref(templatePath).path);
  validateProfile(json(profile));validatePolicyContent(contentValue,template);
  const input={kind:'FORMAL_LOCAL_MEMBERSHIP_POLICY_INITIALIZATION_V1',target,serverBinding:{file:bindingRef.path,sha256:bindingRef.sha256},
   contentManifest:{file:content.path,sha256:content.sha256},profileFile:profile.path,profileSha256:profile.sha256,effectiveAtUtc:spec.effectiveAtUtc,commandKeyPrefix:spec.commandKeyPrefix};
  assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.effectiveAtUtc??'')&&/^[A-Za-z0-9][A-Za-z0-9._:-]{7,88}$/.test(input.commandKeyPrefix??''),'R07_ASSEMBLY_POLICY_INPUT_INVALID');
  assertPolicyRuntimeBinding(input,binding,readFileSync(bindingRef.path));emit('input.json',input);return;
 }
 if(spec.kind==='readback'){
  const profile=ref(paths.profile),bosses=ref(paths.bossesReceipt),staff=ref(paths.staffReceipt),policy=ref(paths.policyReceipt);
  const input={schema:'zzsh.round07-bootstrap-readback-request.v1',target,credentials,profile,bosses,staff,policy,runtimeBinding:bindingRef};
  validateR07BootstrapProofInputs(input,registered,json(profile),{bosses:json(bosses),staff:json(staff),policy:json(policy)});emit('input.json',input);return;
 }
 if(spec.kind==='maintenance'){
  const round=ref(paths.roundInput),receipt=ref(paths.roundReceipt),build=ref(paths.buildManifest,[restricted,resolve(root,'tmp')]);
  const roundValue=json(round);assert(roundValue.dataset?.sha256===registered.protectedDataset.manifestSha256,'R07_ASSEMBLY_DATASET_CHANGED');
  makeR07MaintenanceBinding({round:roundValue,receipt:json(receipt),binding,roundSha:round.sha256,receiptSha:receipt.sha256,buildSha:build.sha256,runtimeSha:bindingRef.sha256});
  writePrivate(join(out,'context.json'),{schema:'zzsh.round07-maintenance-assembly.v1',specSha256:specRef.sha256});const copy=join(out,'build-manifest.json');writeFileSync(copy,readFileSync(build.path),{flag:'wx',mode:0o600});
  const request={schema:'zzsh.round07-maintenance-binding-request.v1',round,receipt,runtime:bindingRef,build:ref(copy)};emit('input.json',request);return;
 }
 if(spec.kind==='round'){
  assertReviewedGrowthRuleFiles(spec.growthRuleFiles);
  const build=pinnedApi(paths),dataset=packageRef(paths.dataset,'manifest.json'),source=packageRef(paths.source,'receipt.json'),display=packageRef(paths.display,'manifest.json'),openings=packageRef(paths.openings,'manifest.json'),
   funds=packageRef(paths.funds,'receipt.json'),refundAttempts=packageRef(paths.refundAttempts,'receipt.json'),pathsRef=packageRef(paths.paths,'receipt.json'),pathSourcePlan=packageRef(paths.pathSourcePlan,'receipt.json'),dictionary=packageRef(paths.dictionary,'receipt.json');
  const actor=ref(paths.actor),bundle=ref(paths.bundle),bosses=ref(paths.bossesReceipt),staff=ref(paths.staffReceipt),business=ref(paths.businessReceipt),readback=ref(paths.bootstrapReadback),policy=ref(paths.policyReceipt),proof=ref(paths.dependencyProof);
  const actorValue=json(actor),policyValue=json(policy),datasetValue=json(ref(join(dataset.path,'manifest.json'))),sourceValue=json(ref(join(source.path,'receipt.json')));
  assert(datasetValue.population?.mode==='SELECTED_BUSINESS_SCOPE'&&registered.protectedDataset.manifestSha256===dataset.sha256&&datasetValue.sourceReceiptSha256===source.sha256,'R07_ASSEMBLY_DATASET_CHANGED');
  for(const [r,key] of [[display,'display'],[openings,'openings'],[pathsRef,'paths']])assert(json(ref(join(r.path,key==='paths'?'receipt.json':'manifest.json'))).datasetSha256===dataset.sha256,'R07_ASSEMBLY_PLAN_CHANGED:'+key);
  const fundsValue=json(ref(join(funds.path,'receipt.json'))),refundValue=json(ref(join(refundAttempts.path,'receipt.json')));
  for(const value of [fundsValue,refundValue])assert(value.sourceSupplement?.baseReceiptSha256===source.sha256,'R07_ASSEMBLY_SUPPLEMENT_CHANGED');
  const sourceBinding=target.migrationProfile===NEXT_MIGRATION_PROFILE?ref(paths.sourceBinding):null;
  const sourceWorkflow=sourceBinding?ref(paths.sourceWorkflow):null;
  if(sourceBinding){const workflow=json(sourceWorkflow),workflowInputRef=ref(workflow.input?.path);
   assert(workflowInputRef.sha256===workflow.input?.sha256,'R07_ASSEMBLY_SOURCE_WORKFLOW_INPUT_CHANGED');
   assertRoundSourceOrigin({target,source,sourceBinding,sourceWorkflow,funds,refundAttempts},sourceValue,datasetValue,json(sourceBinding),fundsValue,refundValue,workflow,json(workflowInputRef));}
  assert(json(ref(join(pathsRef.path,'receipt.json'))).sourcePlanReceiptSha256===pathSourcePlan.sha256,'R07_ASSEMBLY_PATH_SOURCE_CHANGED');
  const legalRef=ref(paths.legal),secretNames=['databaseMaintenance','identitySubjectHmac','identityProfile'];
  const secrets=Object.fromEntries(secretNames.map(name=>[name,ref(paths.secrets?.[name],[secretRoot])]));
  const businessValue=json(business),security=makeR07RoundSecurityBindings({dataset:datasetValue,legalRef,legalInput:json(legalRef),business:businessValue,buildFiles:build.buildFiles,secrets,runtimeBinding:binding});
  assert(spec.window&&[spec.window.notBefore,spec.window.expiresAt].every(v=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v??''))
   &&Date.parse(spec.window.expiresAt)>Date.parse(spec.window.notBefore)&&Date.parse(spec.window.expiresAt)-Date.parse(spec.window.notBefore)<=86400000
   &&/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(spec.approvalRef??''),'R07_ASSEMBLY_WINDOW_OR_REFERENCE_INVALID');
  const targetOut=inside(restricted,paths.roundOutput,true);assert(!existsSync(targetOut),'R07_ASSEMBLY_ROUND_OUTPUT_EXISTS');
  const bootstrapEvidence={runtime:bindingRef,bundle,schema:schemaReceipt,administrators:[bosses,staff],business,readback,policy};
  const input={schema:'zzsh.local-round.v1',window:spec.window,credentials:credentials.path,target,out:targetOut,apiDist:build.api,buildFiles:build.buildFiles,strictBatch:true,
   dataset,source,...(sourceBinding?{sourceBinding,sourceWorkflow}:{}),display,openings,funds,refundAttempts,paths:pathsRef,pathSourcePlan,dictionary,actor,...security,bootstrapEvidence,
   growth:{policyId:policyValue.policyId,policyEffectiveAt:policyValue.effectiveAtUtc,approvedBy:'Root',approvalRef:spec.approvalRef,attempt:1,oldRuleFiles:spec.growthRuleFiles,packageLayout:'PACKED_V2',approvalLayout:'INLINE_INTENT_V1'},
   dependencyBinding:{buildManifest:build.buildManifest,sourceManifest:build.sourceManifest,sourceSnapshot:directory(paths.sourceSnapshot,resolve(root,'tmp')),proof}};
  if(paths.holdingOverlay)input.holdingOverlay=ref(paths.holdingOverlay);
  const evidence={runtime:binding,bundle:json(bundle),schema,administrators:[json(bosses),json(staff)],business:businessValue,readback:json(readback),policy:policyValue};
  assertRoundBootstrap(input,actorValue,evidence);assertRoundPopulationBinding(input,datasetValue,sourceValue,null);emit('input.json',input);return;
 }
 throw Error('R07_ASSEMBLY_KIND_INVALID');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'R07_ASSEMBLY_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
