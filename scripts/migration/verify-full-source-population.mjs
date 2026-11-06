import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readSourceRows } from './local-source-adapter.mjs';
import { assertCapturedPopulation, directFullDomains, partitionSourceKeys, retainedFullDomains } from './full-source-scope.mjs';
import { writePrivate } from '../local-auth.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
async function fileSha(file){const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex')}
const restricted=resolve('E:/zzsh-local-state/restricted');
function privatePath(value,output=false){
 assert(typeof value==='string'&&isAbsolute(value),'FULL_SCOPE_PRIVATE_PATH_REQUIRED');const file=resolve(value);
 assert(file.toLowerCase().startsWith(restricted.toLowerCase()+'\\'),'FULL_SCOPE_PRIVATE_PATH_REQUIRED');
 for(let p=output?dirname(file):file;;p=dirname(p)){assert(!lstatSync(p).isSymbolicLink(),'FULL_SCOPE_REPARSE_POINT_REFUSED');if(p.toLowerCase()===restricted.toLowerCase())break;}
 return file;
}
function boundJson(file,digest){const bytes=readFileSync(privatePath(file));assert(sha(bytes)===digest,'FULL_SCOPE_INPUT_SHA_CHANGED');return JSON.parse(bytes)}
async function checkedRows(directory,meta,visit){
 assert(meta&&typeof meta.file==='string'&&meta.file===basename(meta.file)&&/^[a-f0-9]{64}$/.test(meta.sha256??'')&&Number.isSafeInteger(meta.rows),'FULL_SCOPE_FILE_META_INVALID');
 const file=privatePath(join(directory,meta.file));assert(await fileSha(file)===meta.sha256,'FULL_SCOPE_FILE_SHA_CHANGED');let count=0;
 for await(const row of readSourceRows(file)){visit(row);count++;}assert(count===meta.rows&&await fileSha(file)===meta.sha256,'FULL_SCOPE_FILE_CHANGED_DURING_READ');
}
export async function verifyPopulationFiles({datasetDir,sourceDir,dataset,source,readRows=checkedRows}){
 const expected=assertCapturedPopulation(dataset,source),keys={},ready={},isolated={},retained={};
 const flags={users:new Map(),accounts:new Map(),orders:new Map()},balanceIsolated=[];
 const statusProof={status:'SOURCE_VS_PLANNED_VERIFIED_TARGET_NOT_RUN',users:{ACTIVE:0,FROZEN:0,CANCELLED:0},deletedAccounts:0,deletedOrders:0};
 for(const name of directFullDomains){keys[name]=[];ready[name]=[];isolated[name]=[];}
 for(const name of retainedFullDomains)if(Object.hasOwn(source.files,name))retained[name]=[];
 for(const name of Object.keys(source.files).sort()){
  const digest=createHash('sha256'),seen=new Set();let count=0;
  await readRows(sourceDir,source.files[name],row=>{assert(typeof row?.id==='string'&&row.id&&!seen.has(row.id),'FULL_SOURCE_CAPTURE_KEY_INVALID');seen.add(row.id);digest.update(JSON.stringify(row.id)+'\n');count++;if(keys[name])keys[name].push(row.id);
   if(name==='users')flags.users.set(row.id,{deleted:row.is_delete,disabled:row.is_disable});
   else if(name==='accounts')flags.accounts.set(row.id,{deleted:row.is_delete,status:row.status});
   else if(name==='orders')flags.orders.set(row.id,{deleted:row.is_delete});});
  assert(count===dataset.population.domains[name].captured&&digest.digest('hex')===dataset.population.domains[name].capturedIdsSha256,'FULL_SOURCE_CAPTURE_DIGEST_CHANGED');
 }
 for(const name of ['users','accounts','orders'])if(dataset.files?.[name])await readRows(datasetDir,dataset.files[name],row=>{
  const sourceFlags=flags[name].get(row.sourceId);assert(sourceFlags&&['0','1'].includes(sourceFlags.deleted),'FULL_SOURCE_PLANNED_STATUS_SOURCE_INVALID:'+name);
  if(name==='users'){
   assert(['0','1'].includes(sourceFlags.disabled),'FULL_SOURCE_PLANNED_STATUS_SOURCE_INVALID:users');
   const deleted=sourceFlags.deleted==='1',disabled=sourceFlags.disabled==='1';
   for(const status of [row.sourceStatus,row.input?.evidence?.status])assert(status?.deleted===deleted&&status?.disabled===disabled,'FULL_SOURCE_PLANNED_USER_STATUS_DRIFT');
   statusProof.users[deleted?'CANCELLED':disabled?'FROZEN':'ACTIVE']++;
  }else{
   assert(row.sourceDeleted===(sourceFlags.deleted==='1'),'FULL_SOURCE_PLANNED_DELETED_STATUS_DRIFT:'+name);
   if(name==='accounts'){assert(row.sourceStatus===sourceFlags.status,'FULL_SOURCE_PLANNED_ACCOUNT_STATUS_DRIFT');if(row.sourceDeleted)statusProof.deletedAccounts++;}
   else if(row.sourceDeleted)statusProof.deletedOrders++;
  }
  ready[name].push(row.sourceId);
 });
 if(dataset.files?.['finance-observations'])await readRows(datasetDir,dataset.files['finance-observations'],row=>{
  assert(['earnings','withdraws','distributionOrders'].includes(row.domain),'FULL_SOURCE_FINANCE_DOMAIN_INVALID');ready[row.domain].push(row.sourceId);
 });
 if(dataset.files?.quarantine)await readRows(datasetDir,dataset.files.quarantine,row=>{if(isolated[row.domain])isolated[row.domain].push(row.sourceId);if(row.domain==='balances')balanceIsolated.push(row.sourceId)});
 const partitions={};for(const name of directFullDomains){partitions[name]=partitionSourceKeys(keys[name],ready[name],isolated[name]);
  assert(partitions[name].ready===expected.ready[name]&&partitions[name].isolated===expected.isolated[name],'FULL_SOURCE_PARTITION_COUNTS_CHANGED');}
 if(dataset.files?.['source-relations'])await readRows(datasetDir,dataset.files['source-relations'],item=>{
  assert(Object.hasOwn(retained,item.domain)&&typeof item.row?.id==='string','FULL_SOURCE_RETAINED_DOMAIN_INVALID');retained[item.domain].push(item.row.id);
 });
 for(const [name,ids] of Object.entries(retained)){
  const digest=createHash('sha256'),seen=new Set();for(const id of ids){assert(!seen.has(id),'FULL_SOURCE_RETAINED_KEY_DUPLICATE');seen.add(id);digest.update(JSON.stringify(id)+'\n');}
  assert(ids.length===source.files[name].rows&&digest.digest('hex')===dataset.population.domains[name].capturedIdsSha256,'FULL_SOURCE_RETAINED_SET_CHANGED');
 }
 const balanceIds=[];if(dataset.files?.['stored-balances'])await readRows(datasetDir,dataset.files['stored-balances'],row=>balanceIds.push(row.sourceId));
 const readyUsers=new Set(ready.users),readyBalanceIsolated=balanceIsolated.filter(id=>readyUsers.has(id));
 assert(balanceIsolated.every(id=>flags.users.has(id)),'FULL_SOURCE_BALANCE_ISOLATED_FOREIGN_USER');
 const balancePartition=partitionSourceKeys(ready.users,balanceIds,readyBalanceIsolated);
 assert(balancePartition.ready===dataset.storedBalanceCoverage.readyAmounts&&balancePartition.isolated===dataset.storedBalanceCoverage.isolatedAmounts,'FULL_SOURCE_BALANCE_COVERAGE_CHANGED');
 const direct=new Set(directFullDomains),retainedNames=new Set(retainedFullDomains);
 const auxiliaryDomainsNotOutcomeChecked=Object.keys(source.files).filter(name=>!direct.has(name)&&!retainedNames.has(name)).sort();
 return {partitions,retained:Object.fromEntries(Object.entries(retained).map(([name,ids])=>[name,ids.length])),statusProof,
  balanceProof:{status:'READY_SUBJECT_PARTITION_VERIFIED_TARGET_NOT_RUN',...balancePartition},auxiliaryDomainsNotOutcomeChecked,differenceCount:0};
}
async function main(){
 const {values:v}=parseArgs({args:process.argv.slice(2),options:{verify:{type:'boolean'},dataset:{type:'string'},'dataset-sha':{type:'string'},source:{type:'string'},'source-sha':{type:'string'},out:{type:'string'}}});
 if(!v.verify){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--verify','--dataset','--dataset-sha','--source','--source-sha','--out'],sourceConnections:0,targetConnections:0,targetWrites:0}));return;}
 assert(process.version==='v24.20.0','NODE_BASELINE_MISMATCH');
 const datasetDir=privatePath(v.dataset),sourceDir=privatePath(v.source),out=privatePath(v.out,true);assert(!existsSync(out),'FULL_SCOPE_OUTPUT_EXISTS');
 const dataset=boundJson(join(datasetDir,'manifest.json'),v['dataset-sha']),source=boundJson(join(sourceDir,'receipt.json'),v['source-sha']);
 assert(dataset.sourceReceiptSha256===v['source-sha']&&resolve(dataset.source).toLowerCase()===sourceDir.toLowerCase(),'FULL_SCOPE_SOURCE_BINDING_CHANGED');
 const startedAt=new Date().toISOString(),begin=performance.now(),result=await verifyPopulationFiles({datasetDir,sourceDir,dataset,source});
 const receipt={schema:'zzsh.full-source-scope-readback.v1',status:'DIRECT_DOMAIN_SOURCE_PARTITIONS_VERIFIED_TARGET_NOT_RUN',datasetSha256:v['dataset-sha'],
  sourceReceiptSha256:v['source-sha'],populationSha256:dataset.populationSha256,...result,sourceConnections:0,targetConnections:0,targetWrites:0,
  startedAt,finishedAt:new Date().toISOString(),elapsedMs:performance.now()-begin};
 writePrivate(join(out,'receipt.json'),receipt);
 console.log(JSON.stringify({status:receipt.status,receipt:join(out,'receipt.json'),sha256:sha(readFileSync(join(out,'receipt.json'))),sourceConnections:0,targetConnections:0,targetWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error(JSON.stringify({status:'STOPPED',reason:'FULL_SCOPE_VERIFICATION_FAILED'}));process.exitCode=1;});
