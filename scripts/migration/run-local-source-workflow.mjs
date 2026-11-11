import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { writeLoadCheckpoint } from './local-load-checkpoint.mjs';
import { assertCapturedSourceOrigin } from './local-source-adapter.mjs';
import { assertNextSourceTools, NEXT_SOURCE_SCRIPTS } from './local-round-dependencies.mjs';
import { NEXT_MIGRATION_PROFILE } from './local-target-registry.mjs';
import { verifyBoundMysqlSource } from './prepare-local-mysql-source.mjs';

const root=resolve('E:/zzsh-local-state/restricted'),scripts=dirname(fileURLToPath(import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex'),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function privatePath(value,output=false){
 assert(typeof value==='string'&&isAbsolute(value),'SOURCE_WORKFLOW_PRIVATE_PATH_REQUIRED');const path=resolve(value),r=relative(root,path);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'SOURCE_WORKFLOW_PRIVATE_PATH_REQUIRED');
 for(let p=output?dirname(path):path;p!==dirname(p);p=dirname(p))assert(!lstatSync(p).isSymbolicLink(),'SOURCE_WORKFLOW_LINK_REFUSED');return path;
}
function bound(path,digest){const bytes=readFileSync(privatePath(path));assert(hex(digest)&&sha(bytes)===digest,'SOURCE_WORKFLOW_INPUT_CHANGED');return JSON.parse(bytes);}
const samePath=(a,b)=>resolve(a??'').toLowerCase()===resolve(b??'').toLowerCase();
function toolHashes(){return Object.fromEntries([...NEXT_SOURCE_SCRIPTS,'local-source-adapter.mjs','../local-auth.mjs'].map(name=>[name,sha(readFileSync(join(scripts,name)))]));}

/** Every child is acknowledged before the next; failure never triggers a retry. */
export async function runLocalSourceStages(step,verify){
 assert(typeof step==='function'&&typeof verify==='function','SOURCE_WORKFLOW_CALLBACK_REQUIRED');
 const prepared=await step('prepare'),restored=await step('restore',prepared),source=await step('capture',restored);
 const funds=await step('finance',restored,source),refund=await step('refund',restored,source);
 return verify({prepared,restored,source,funds,refund});
}

async function main(){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 if(!args.includes('--execute')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--execute','--input','--input-sha'],stages:['prepare','restore','capture','finance','refund','verify'],targetWrites:0,automaticCleanup:false}));return;}
 assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
 assert(args[0]==='--execute'&&args.length===5&&['--input','--input-sha'].every(name=>args.filter(x=>x===name).length===1),'SOURCE_WORKFLOW_ARGUMENTS_INVALID');
 const inputPath=privatePath(option('--input')),inputSha=option('--input-sha'),input=bound(inputPath,inputSha);
 assert(input?.schema==='zzsh.local-source-workflow.v1'&&Object.keys(input).sort().join()===['cutoff','dump','exportStartedAt','imageId','out','schema','suffix'].sort().join()
  &&/^[a-z0-9][a-z0-9-]{2,40}$/.test(input.suffix??'')&&/^sha256:[a-f0-9]{64}$/.test(input.imageId??'')
  &&typeof input.dump==='string'&&typeof input.exportStartedAt==='string'&&typeof input.cutoff==='string','SOURCE_WORKFLOW_INPUT_INVALID');
 const out=privatePath(input.out,true);assert(!existsSync(out),'SOURCE_WORKFLOW_OUTPUT_EXISTS');mkdirSync(out);
 const hashes=toolHashes();let receipt={schema:'zzsh.local-source-workflow-receipt.v1',status:'STARTED',input:{path:inputPath,sha256:inputSha},inputSha256:inputSha,toolFiles:hashes,stages:[],targetWrites:0,automaticCleanup:false,startedAt:new Date().toISOString()};
 const receiptPath=join(out,'receipt.json');writePrivate(receiptPath,receipt);const save=()=>writeLoadCheckpoint(receiptPath,receipt);save();
 const planPath=join(root,'migration-mysql-source-'+input.suffix,'plan.json'),execution=join(dirname(planPath),'execution'),bindingPath=join(execution,'source-binding.json');
 const directories={capture:join(out,'source'),finance:join(out,'finance'),refund:join(out,'refund')};
 const assertTools=()=>{assert.deepEqual(toolHashes(),hashes,'SOURCE_WORKFLOW_TOOL_CHANGED');assert.equal(sha(readFileSync(inputPath)),inputSha,'SOURCE_WORKFLOW_INPUT_CHANGED');};
 async function childStep(name,script,flags,verifyResult){
  assertTools();const stage={name,status:'INTENT',startedAt:new Date().toISOString()};receipt.stages.push(stage);save();
  console.log(JSON.stringify({stage:name,status:'STARTED'}));
  const started=performance.now(),stdoutPath=join(out,name+'.stdout.log'),stderrPath=join(out,name+'.stderr.log');let stdout,stderr;
  try{
   stdout=openSync(stdoutPath,'wx',0o600);stderr=openSync(stderrPath,'wx',0o600);stage.logs={stdout:stdoutPath,stderr:stderrPath};save();
   const child=spawn(process.execPath,[join(scripts,script),...flags],{cwd:resolve(scripts,'../..'),windowsHide:true,stdio:['ignore',stdout,stderr]});
   const result=await new Promise((ok,fail)=>{child.once('error',fail);child.once('close',(code,signal)=>ok({code,signal}));});
   Object.assign(stage,result);assert(result.code===0&&result.signal===null,'SOURCE_WORKFLOW_STAGE_FAILED');
   const bytes=readFileSync(stdoutPath);assert(bytes.length<=65536,'SOURCE_WORKFLOW_OUTPUT_INVALID');const lines=bytes.toString('utf8').trim().split(/\r?\n/);
   const value=JSON.parse(lines.at(-1));const verified=await verifyResult(value);stage.status='ACK';return verified;
  }finally{if(stdout!==undefined)closeSync(stdout);if(stderr!==undefined)closeSync(stderr);stage.finishedAt=new Date().toISOString();stage.wallMs=Math.round(performance.now()-started);save();}
 }
 const step=async(name,restored,source)=>{
  if(name==='prepare'){
   return childStep(name,'prepare-local-mysql-source.mjs',['--prepare','--suffix',input.suffix,'--image-id',input.imageId,'--dump',input.dump,'--export-start',input.exportStartedAt,'--cutoff',input.cutoff],result=>{
    assert(result.status==='MYSQL_SOURCE_PLAN_SEALED_NOT_CREATED'&&samePath(result.plan,planPath)&&hex(result.sha256),'SOURCE_WORKFLOW_PREPARE_UNCONFIRMED');return result;});
  }
  if(name==='restore'){
   return childStep(name,'prepare-local-mysql-source.mjs',['--execute','--plan',planPath,'--plan-sha',restored.sha256],async result=>{
    assert(result.status==='MYSQL_SOURCE_RESTORED_READ_ONLY'&&samePath(result.binding,bindingPath),'SOURCE_WORKFLOW_RESTORE_UNCONFIRMED');
    const value=JSON.parse(readFileSync(join(execution,'receipt.json'))),bindingSha=sha(readFileSync(bindingPath));
    assert(value.status===result.status&&value.bindingSha256===bindingSha&&/^[a-f0-9]{64}$/.test(value.containerId??''),'SOURCE_WORKFLOW_RESTORE_UNCONFIRMED');
    await verifyBoundMysqlSource(bindingPath,bindingSha,value.containerId);return {bindingPath,bindingSha,containerId:value.containerId};});
  }
  assert(['capture','finance','refund'].includes(name),'SOURCE_WORKFLOW_STAGE_INVALID');
  const mode=name==='finance'?'--finance-supplement-only':name==='refund'?'--refund-attempts-only':null,
   flags=['--capture','--container-id',restored.containerId,'--source-origin-v2',bindingPath,'--source-origin-sha',restored.bindingSha,'--out',directories[name],
    ...(mode?[mode,'--base-source',directories.capture,'--base-sha',source.sha256]:[])];
  return childStep(name,'capture-local-source.mjs',flags,result=>{
   const path=join(directories[name],'receipt.json'),bytes=readFileSync(path),digest=sha(bytes),value=JSON.parse(bytes);
   assert(result.status==='CAPTURED_READ_ONLY'&&samePath(result.output,directories[name])&&value.status===result.status,'SOURCE_WORKFLOW_CAPTURE_UNCONFIRMED');
   return {path:directories[name],sha256:digest,receipt:value};});
 };
 try{
  const result=await runLocalSourceStages(step,async({restored,source,funds,refund})=>{
   const stage={name:'verify',status:'INTENT',startedAt:new Date().toISOString()};receipt.stages.push(stage);save();const started=performance.now();
   try{
   assertTools();const binding=bound(bindingPath,restored.bindingSha);for(const item of [source,funds,refund])assertCapturedSourceOrigin(item.receipt,binding,restored.bindingSha);
   for(const item of [funds,refund])assert(item.receipt.sourceSupplement?.baseReceiptSha256===source.sha256,'SOURCE_WORKFLOW_SUPPLEMENT_CHANGED');
   assertNextSourceTools({target:{migrationProfile:NEXT_MIGRATION_PROFILE}},binding,[source.receipt,funds.receipt,refund.receipt],hashes,{toolFiles:hashes});
   stage.status='ACK';
   return {source:{path:source.path,sha256:source.sha256},funds:{path:funds.path,sha256:funds.sha256},refundAttempts:{path:refund.path,sha256:refund.sha256},
    sourceBinding:{path:bindingPath,sha256:restored.bindingSha},containerId:restored.containerId};
   }finally{stage.finishedAt=new Date().toISOString();stage.wallMs=Math.round(performance.now()-started);save();}
  });
  receipt={...receipt,status:'SOURCE_CAPTURED_DATASET_NOT_PREPARED',result,finishedAt:new Date().toISOString()};save();
 }catch(error){receipt={...receipt,status:'STOPPED_PRESERVE_ORIGINAL_RESOURCES',failure:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name,finishedAt:new Date().toISOString()};save();process.exitCode=1;}
 console.log(JSON.stringify({status:receipt.status,receipt:join(out,'receipt.json'),targetWrites:0,automaticCleanup:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'SOURCE_WORKFLOW_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
