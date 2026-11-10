import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';
import { assertRoundDependencyProof, inspectRoundDependencyLayout } from './local-round-dependencies.mjs';
import { assertDisplayCaptureCoverage, readVerifiedSourceRows } from './local-source-adapter.mjs';
import { auditSameCaptureListedInputs, buildSameCaptureListedPolicyBatches, readBoundListedAccounts } from './legacy-listed-round-source.mjs';
import { verifyLegacyListedPolicyDump } from './verify-legacy-listed-policy-dump.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=value=>createHash('sha256').update(value).digest('hex'),hex=value=>/^[a-f0-9]{64}$/.test(value??'');
function privatePath(value,output=false){
 assert(typeof value==='string'&&isAbsolute(value),'LISTED_CAPTURE_PRIVATE_PATH_REQUIRED');
 const path=resolve(value),rel=relative(restricted,path);
 assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'LISTED_CAPTURE_PRIVATE_PATH_REQUIRED');
 for(let current=output?dirname(path):path;;current=dirname(current)){
  assert(!lstatSync(current).isSymbolicLink(),'LISTED_CAPTURE_LINK_REFUSED');
  if(current.toLowerCase()===restricted.toLowerCase())break;
 }
 return path;
}
function jsonBound(path,digest){const bytes=readFileSync(privatePath(path));assert(hex(digest)&&sha(bytes)===digest,'LISTED_CAPTURE_INPUT_CHANGED');return JSON.parse(bytes);}
async function fileSha(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
async function sourceFile(directory,entry){
 assert(entry&&entry.file===basename(entry.file)&&hex(entry.sha256)&&Number.isSafeInteger(entry.rows)&&entry.rows>=0,'LISTED_CAPTURE_FILE_INVALID');
 return privatePath(join(directory,entry.file));
}
async function main(){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]};
 if(!args.includes('--prepare')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--prepare','--round-input','--round-input-sha','--source-binding','--source-binding-sha','--out'],audits:['--with-audits','--test-authority-template','--test-authority-template-sha'],connections:0,targetWrites:0,credentialReads:0}));return;}
 assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
 const tools=['./prepare-listed-same-capture-policy.mjs','./legacy-listed-round-source.mjs','./local-source-adapter.mjs','./local-distribution-qualification-plan.mjs','./local-round-dependencies.mjs','./verify-legacy-listed-policy-dump.mjs','../local-auth.mjs'];
 const toolFiles=Object.fromEntries(tools.map(name=>[name,sha(readFileSync(new URL(name,import.meta.url)))]));
 const verifyTools=()=>{for(const name of tools)assert.equal(sha(readFileSync(new URL(name,import.meta.url))),toolFiles[name],'LISTED_CAPTURE_TOOL_CHANGED');};
 const inputPath=privatePath(option('--round-input')),inputSha=option('--round-input-sha'),round=jsonBound(inputPath,inputSha);
 const bindingPath=resolve(option('--source-binding')??''),bindingSha=option('--source-binding-sha');
 assert(isAbsolute(option('--source-binding')??'')&&hex(bindingSha),'LISTED_CAPTURE_SOURCE_BINDING_REQUIRED');
 for(let current=bindingPath;current!==dirname(current);current=dirname(current))assert(!lstatSync(current).isSymbolicLink(),'LISTED_CAPTURE_LINK_REFUSED');
 const bindingBytes=readFileSync(bindingPath);assert.equal(sha(bindingBytes),bindingSha,'LISTED_CAPTURE_SOURCE_BINDING_CHANGED');const binding=JSON.parse(bindingBytes);
 const out=privatePath(option('--out'),true);assert(!existsSync(out)&&round.schema==='zzsh.local-round.v1','LISTED_CAPTURE_OUTPUT_INVALID');
 const source=privatePath(round.source?.path),receipt=jsonBound(join(source,'receipt.json'),round.source?.sha256);
 const datasetDir=privatePath(round.dataset?.path),dataset=jsonBound(join(datasetDir,'manifest.json'),round.dataset?.sha256);
 assert(dataset.sourceReceiptSha256===round.source.sha256&&dataset.sourceOrigin?.bindingSha256===bindingSha
  &&dataset.sourceOrigin?.dumpSha256===binding.restoreRecord?.dumpSha256&&binding.container?.id===receipt.containerId
  &&binding.source?.database===receipt.database&&binding.restoreRecord?.cutoff===dataset.sourceCutoff,'LISTED_CAPTURE_SOURCE_BINDING_CHANGED');
 const api=isolatedDistributionBuild(root,round.apiDist),dep=round.dependencyBinding;
 assert(dep?.proof&&dep.buildManifest&&dep.sourceManifest&&round.bootstrapEvidence?.bundle,'LISTED_CAPTURE_DEPENDENCY_PROOF_REQUIRED');
 const proof=jsonBound(dep.proof.path,dep.proof.sha256);
 const layout=inspectRoundDependencyLayout({apiDist:api,bundlePath:round.bootstrapEvidence.bundle.path,bundleSha256:round.bootstrapEvidence.bundle.sha256,
  buildManifestPath:dep.buildManifest.path,buildManifestSha256:dep.buildManifest.sha256,sourceSnapshot:dep.sourceSnapshot,
  sourceManifestPath:dep.sourceManifest.path,sourceManifestSha256:dep.sourceManifest.sha256});
 assertRoundDependencyProof(proof,layout);process.env.NODE_PATH=layout.moduleDirs.join(delimiter);Module._initPaths();
 const require=createRequire(join(root,'apps/api/package.json'));
 assert(round.buildFiles&&typeof round.buildFiles==='object'&&!Array.isArray(round.buildFiles),'LISTED_CAPTURE_BUILD_CHANGED');
 const verifyBuild=()=>{for(const [name,digest] of Object.entries(round.buildFiles)){
  assert(name.endsWith('.js')&&!name.includes('..')&&!isAbsolute(name)&&hex(digest),'LISTED_CAPTURE_BUILD_CHANGED');
  assert.equal(sha(readFileSync(join(api,name))),digest,'LISTED_CAPTURE_BUILD_CHANGED');
 }};verifyBuild();
 const load=name=>{const file=join(api,name+'.js');assert.equal(sha(readFileSync(file)),round.buildFiles?.[name+'.js'],'LISTED_CAPTURE_BUILD_CHANGED');return require(file);};
 const {canonicalize}=load('supply/content-hash'),{legacyPriceInteger}=load('supply/legacy-listed-pricing');load('supply/decimal');
 const accountFile=await sourceFile(source,receipt.files?.accounts),gameFile=await sourceFile(source,receipt.files?.games),settingsFile=await sourceFile(source,receipt.files?.tradePolicy);
 const scan=await readBoundListedAccounts(accountFile,receipt.files.accounts,null,canonicalize),games=[],settings=[];
 await readVerifiedSourceRows(gameFile,receipt.files.games,row=>games.push(row));
 await readVerifiedSourceRows(settingsFile,receipt.files.tradePolicy,row=>settings.push(row));
 const dump=await verifyLegacyListedPolicyDump(binding.restoreRecord,'1');
 const verifierSha256=toolFiles['./verify-legacy-listed-policy-dump.mjs'];
 const built=buildSameCaptureListedPolicyBatches({receipt,sourceReceiptSha256:round.source.sha256,sourceBindingSha256:bindingSha,dumpSha256:binding.restoreRecord.dumpSha256,
  verifierSha256,dump,scan,games,settings,canonicalize,parseInteger:legacyPriceInteger});
 const manifestSha=sha(JSON.stringify(built.manifest,null,2)+'\n');
 let batchAudits=null,authorities=null,templateSha256=null;
 if(args.includes('--with-audits')&&built.policies.length){
  const template=jsonBound(option('--test-authority-template'),option('--test-authority-template-sha'));
  if(template.schema!=='zzsh.listed-test-authority-template.v1'||template.status!=='APPROVED'
    ||template.decision!=='OWNER_APPROVED_MYSQL_SNAPSHOT_TEST_ONLY'||template.scope!=='LOCAL_AND_TEST_SERVER'
    ||template.runtimeCacheKnowledge!=='UNKNOWN'||template.productionCutover!=='REVERIFY_SOURCE_RUNTIME_POLICY'
    ||typeof template.authorityRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(template.authorityRef)
    ||typeof template.instruction!=='string'||!template.instruction.trim()||template.instruction.length>500)throw new Error('LISTED_TEST_AUTHORITY_INVALID');
  templateSha256=option('--test-authority-template-sha');
  const displayDir=privatePath(round.display?.path),pathsDir=privatePath(round.paths?.path);
  const display=jsonBound(join(displayDir,'manifest.json'),round.display?.sha256),paths=jsonBound(join(pathsDir,'receipt.json'),round.paths?.sha256);
  if(display.status!=='DISPLAY_SUPPLEMENT_PREPARED_TARGET_NOT_RUN'||paths.status!=='PREPARED_TARGET_NOT_RUN'
    ||display.datasetSha256!==round.dataset.sha256||paths.datasetSha256!==round.dataset.sha256
    ||display.extractSha256!==receipt.files.accountDisplay?.sha256||display.extractSha256!==receipt.files.accounts.sha256)
   throw new Error('LISTED_BATCH_PREPARED_INPUT_CHANGED');
  assertDisplayCaptureCoverage(display);
  if(round.holdingOverlay)jsonBound(round.holdingOverlay.path,round.holdingOverlay.sha256);
  const dataPath=(dir,entry)=>{if(!entry||entry.file!==basename(entry.file))throw new Error('LISTED_CAPTURE_FILE_INVALID');return privatePath(join(dir,entry.file));};
  const wanted=new Set(scan.accounts.keys()),accountRows=new Map(),displayRows=new Map(),pathRows=new Map(),users=new Map();
  const collect=async(dir,entry,map,key,allowed)=>readVerifiedSourceRows(dataPath(dir,entry),entry,row=>{
   const id=row?.[key];if(allowed.has(id)){if(map.has(id))throw new Error('LISTED_BATCH_PREPARED_DUPLICATE');map.set(id,row);}
  });
  await collect(datasetDir,dataset.files?.accounts,accountRows,'sourceId',wanted);
  await collect(displayDir,{file:display.file,sha256:display.sha256,rows:display.rows},displayRows,'sourceId',wanted);
  await collect(pathsDir,{file:paths.file,sha256:paths.fileSha256,rows:paths.accounts},pathRows,'legacyId',wanted);
  const ownerIds=new Set([...accountRows.values()].map(row=>row.ownerLegacyId));
  await collect(datasetDir,dataset.files?.users,users,'sourceId',ownerIds);
  const {listingSnapshot}=load('legacy-load/user-order-offline-plan'),{legacyDisplayMatchesSource}=load('supply/legacy-display-snapshot'),
   {parseLegacyImagePaths}=load('supply/legacy-path-media');
  const audited=auditSameCaptureListedInputs({scan,policies:built.policies,accounts:accountRows,users,displays:displayRows,paths:pathRows,
   canonicalize,listingSnapshot,legacyDisplayMatchesSource,parseLegacyImagePaths,requireCaptureFacts:true});
  authorities=built.policies.map(policy=>({schema:'legacy-listed-policy-authority-v1',decision:template.decision,scope:template.scope,
   runtimeCacheKnowledge:template.runtimeCacheKnowledge,productionCutover:template.productionCutover,sourceReceiptSha256:round.source.sha256,
   sourceBindingSha256:bindingSha,dumpSha256:binding.restoreRecord.dumpSha256,policyBundleSha256:sha(canonicalize(policy)),
   authorityRef:template.authorityRef,instruction:template.instruction}));
  batchAudits=audited.map((accounts,index)=>({schema:'zzsh.listed-batch-source-audit.v1',status:'SOURCE_FACTS_MATCHED_TARGET_NOT_RUN',
   sourceReceiptSha256:round.source.sha256,sourceBindingSha256:bindingSha,r06DatasetManifestSha256:round.dataset.sha256,
   r06AccountsSha256:dataset.files.accounts.sha256,r06DisplayFileSha256:display.sha256,r06PathsFileSha256:paths.fileSha256,
   ...(round.holdingOverlay?{skinOverlaySha256:round.holdingOverlay.sha256}:{}),policyBundleCanonicalSha256:sha(canonicalize(built.policies[index])),
   policyAuthorityCanonicalSha256:sha(canonicalize(authorities[index])),batchManifestSha256:manifestSha,batchIndex:index+1,
   batchAccountSetSha256:built.manifest.batches[index].accountSetSha256,authorityTemplateSha256:templateSha256,accounts,
   skinTarget:'NOT_ASSESSED',quoteTarget:'NOT_ASSESSED',dbConnections:0,targetWrites:0,ossWrites:0}));
 }
 assert.equal(sha(readFileSync(inputPath)),inputSha,'LISTED_CAPTURE_INPUT_CHANGED');
 assert.equal(sha(readFileSync(bindingPath)),bindingSha,'LISTED_CAPTURE_SOURCE_BINDING_CHANGED');
 assert.equal(sha(readFileSync(join(source,'receipt.json'))),round.source.sha256,'LISTED_CAPTURE_INPUT_CHANGED');
 for(const [file,entry] of [[accountFile,receipt.files.accounts],[gameFile,receipt.files.games],[settingsFile,receipt.files.tradePolicy]])
  assert.equal(await fileSha(file),entry.sha256,'LISTED_CAPTURE_FILE_CHANGED_DURING_PREPARATION');
 verifyBuild();verifyTools();assertRoundDependencyProof(proof,layout);
 const result={schema:'zzsh.listed-same-capture-policy-preparation.v1',status:built.status,roundInputSha256:inputSha,sourceReceiptSha256:round.source.sha256,
  sourceBindingSha256:bindingSha,dumpSha256:binding.restoreRecord.dumpSha256,capturedAccounts:built.manifest.capturedAccounts,listedAccounts:scan.accounts.size,
  toolFiles,dependencyProofSha256:dep.proof.sha256,runtimeRedis:'NOT_CAPTURED',independentAudit:'NOT_RUN',target:'NOT_VERIFIED',targetWrites:0,dbConnections:0,credentialReads:0};
 result.batches=built.policies.map((policy,index)=>{
  const name=built.policies.length===1?'policy.json':`policy-${String(index+1).padStart(4,'0')}.json`,path=join(out,name);
  writePrivate(path,policy);assert.equal(sha(canonicalize(JSON.parse(readFileSync(path,'utf8')))),built.manifest.batches[index].policyCanonicalSha256,'LISTED_CAPTURE_POLICY_WRITE_CHANGED');
  return {file:name,fileSha256:sha(readFileSync(path)),...built.manifest.batches[index]};
 });
 writePrivate(join(out,'batches.json'),built.manifest);result.batchManifestSha256=sha(readFileSync(join(out,'batches.json')));
 assert.equal(result.batchManifestSha256,manifestSha,'LISTED_BATCH_MANIFEST_WRITE_CHANGED');
 if(batchAudits){
  result.audits=batchAudits.map((audit,index)=>{const suffix=batchAudits.length===1?'':`-${String(index+1).padStart(4,'0')}`;
   const authorityFile=`authority${suffix}.json`,auditFile=`audit${suffix}.json`;
   writePrivate(join(out,authorityFile),authorities[index]);writePrivate(join(out,auditFile),audit);
   return {index:index+1,authorityFile,authorityFileSha256:sha(readFileSync(join(out,authorityFile))),auditFile,auditFileSha256:sha(readFileSync(join(out,auditFile)))};
  });
  result.authorityTemplateSha256=templateSha256;
 }
 if(built.policies.length===1){result.policyCanonicalSha256=result.batches[0].policyCanonicalSha256;result.policyFileSha256=result.batches[0].fileSha256;}
 writePrivate(join(out,'receipt.json'),result);
 console.log(JSON.stringify({status:result.status,capturedAccounts:result.capturedAccounts,listedAccounts:result.listedAccounts,policyCanonicalSha256:result.policyCanonicalSha256??null,targetWrites:0,dbConnections:0}));
}
main().catch(error=>{const code=/^([A-Z][A-Z0-9_]+)(?:\r?\n|$)/.exec(error.message??'')?.[1]??error.code??error.name;
 console.error(JSON.stringify({status:'LISTED_CAPTURE_STOPPED',code}));process.exitCode=1;});
