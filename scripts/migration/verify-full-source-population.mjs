import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertContinuationCommissionCoverage, assertContinuationSourceCoverage, assertLegacyLiabilitySourceCoverage, isExactLegacyRefundRelationship, NEXT_CONTINUATION_COMMISSION_POLICY, readVerifiedSourceRows, unsupportedLegacyContinuationStatus } from './local-source-adapter.mjs';
import { assertCapturedPopulation, directFullDomains, partitionSourceKeys, retainedFullDomains } from './full-source-scope.mjs';
import { assertSelectedScopeForWrite } from './selected-business-scope.mjs';
import { writePrivate } from '../local-auth.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const restricted=resolve('E:/zzsh-local-state/restricted');
function privatePath(value,output=false){
 assert(typeof value==='string'&&isAbsolute(value),'FULL_SCOPE_PRIVATE_PATH_REQUIRED');const file=resolve(value);
 assert(file.toLowerCase().startsWith(restricted.toLowerCase()+'\\'),'FULL_SCOPE_PRIVATE_PATH_REQUIRED');
 for(let p=output?dirname(file):file;;p=dirname(p)){assert(!lstatSync(p).isSymbolicLink(),'FULL_SCOPE_REPARSE_POINT_REFUSED');if(p.toLowerCase()===restricted.toLowerCase())break;}
 return file;
}
function boundJson(file,digest){const bytes=readFileSync(privatePath(file));assert(sha(bytes)===digest,'FULL_SCOPE_INPUT_SHA_CHANGED');return JSON.parse(bytes)}
export function readBoundSelectedSourceReceipt(sourceDir,digest){
 assert(typeof sourceDir==='string'&&/^[a-f0-9]{64}$/.test(digest??''),'SELECTED_SCOPE_SOURCE_BINDING_INVALID');
 return boundJson(join(privatePath(sourceDir),'receipt.json'),digest);
}
async function checkedRows(directory,meta,visit){
 assert(meta&&typeof meta.file==='string'&&meta.file===basename(meta.file)&&/^[a-f0-9]{64}$/.test(meta.sha256??'')&&Number.isSafeInteger(meta.rows),'FULL_SCOPE_FILE_META_INVALID');
 const file=privatePath(join(directory,meta.file));
 try{await readVerifiedSourceRows(file,meta,visit);}
 catch(error){if(error?.message==='SOURCE_STREAM_CHANGED')throw new Error('FULL_SCOPE_FILE_SHA_CHANGED');
  if(error?.message==='SOURCE_STREAM_CHANGED_AFTER_READ')throw new Error('FULL_SCOPE_FILE_CHANGED_DURING_READ');throw error;}
}

/** Verify all users and the selected account/order scope from frozen source records, not planner counts. */
export async function verifySelectedPopulationFiles({datasetDir,sourceDir,dataset,source,readRows=checkedRows}){
 const population=dataset?.population,scope=dataset?.selectedScope;
 assert(population?.schema==='zzsh.local-population-scope.v1'&&population.mode==='SELECTED_BUSINESS_SCOPE'
  &&population.sourceReceiptSha256===dataset.sourceReceiptSha256&&sha(JSON.stringify(population))===dataset.populationSha256
  &&source?.status==='CAPTURED_READ_ONLY'&&source.rollbackConfirmed===true&&source.clientClosed===true,'SELECTED_SCOPE_SOURCE_BINDING_INVALID');
 assertSelectedScopeForWrite(dataset);
 assert.deepEqual(Object.keys(population.domains??{}).sort(),Object.keys(source.files??{}).sort(),'SELECTED_SCOPE_SOURCE_DOMAIN_SET_CHANGED');
 for(const [name,meta] of Object.entries(source.files)){
  const d=population.domains[name];
  assert(Number.isSafeInteger(meta?.rows)&&meta.rows>=0&&Number.isSafeInteger(d?.captured)&&Number.isSafeInteger(d?.considered)
   &&Number.isSafeInteger(d?.excluded)&&d.captured>=0&&d.considered>=0&&d.excluded>=0&&d.captured===d.considered+d.excluded
   &&/^[a-f0-9]{64}$/.test(d.capturedIdsSha256??'')&&/^[a-f0-9]{64}$/.test(d.consideredIdsSha256??''),'SELECTED_SCOPE_SOURCE_DOMAIN_INVALID');
  assert(d?.captured===meta.rows,'SELECTED_SCOPE_SOURCE_DOMAIN_COUNT_CHANGED');
  if(name!=='accounts'&&name!=='orders')assert(d.considered===d.captured&&d.excluded===0&&d.consideredIdsSha256===d.capturedIdsSha256,'SELECTED_SCOPE_NON_ORDER_DOMAIN_EXCLUDED');
 }
 const selected={accounts:new Set(scope.write.accounts),orders:new Set(scope.write.orders)};
 const verifyContinuationStatus=dataset?.domains?.continuations?.preparedEvidence?.commissionPolicy===NEXT_CONTINUATION_COMMISSION_POLICY;
 const unsupportedStatuses={'2':0,'6':0,'7':0};
 const continuationSources={accounts:[],orders:[],pays:[],tradePolicy:[]},continuationCommissions=[],sourceRefunds=[];
 const users=new Set(),accounts=new Map(),orders=new Map(),paid=new Set();let missingPaidReference=false;
 for(const name of ['users','accounts','orders','pays']){
  assert(source.files?.[name]&&population.domains?.[name],'SELECTED_SCOPE_SOURCE_DOMAIN_MISSING');
  const seen=new Set(),captured=createHash('sha256'),considered=createHash('sha256');let count=0,chosen=0;
  await readRows(sourceDir,source.files[name],row=>{
   assert(typeof row?.id==='string'&&row.id&&!seen.has(row.id),'SELECTED_SCOPE_SOURCE_KEY_INVALID');
   seen.add(row.id);count++;const bytes=JSON.stringify(row.id)+'\n';captured.update(bytes);
   if(name==='users'||name==='pays'||selected[name].has(row.id)){chosen++;considered.update(bytes);}
   if(name==='users')users.add(row.id);
   else if(name==='accounts'){
    assert(['status','is_delete','user_id','no'].every(field=>Object.hasOwn(row,field)),'SELECTED_SCOPE_ACCOUNT_FIELDS_MISSING');
    assert(['0','1','2','3','4','5','6'].includes(row.status)&&['0','1'].includes(row.is_delete),'SELECTED_SCOPE_ACCOUNT_STATE_UNKNOWN');
    const source=selected.accounts.has(row.id)?Object.fromEntries(['user_id','no','status','is_delete','default_consume_type','price_tenant',
     'extra_goods_total_price_tenant','deposit_amount','rental_days'].map(field=>[field,row[field]])):undefined;
    accounts.set(row.id,{listed:row.status==='3'&&row.is_delete==='0',source});
    if(verifyContinuationStatus&&selected.accounts.has(row.id))continuationSources.accounts.push(row);
   }else if(name==='orders'){
    assert(['accounts_id','pay_is','user_id','order_sn'].every(field=>Object.hasOwn(row,field)),'SELECTED_SCOPE_ORDER_FIELDS_MISSING');
    if(verifyContinuationStatus){
     assert(['order_status','is_delete'].every(field=>Object.hasOwn(row,field)),'SELECTED_SCOPE_CONTINUATION_FIELDS_MISSING');
     const status=selected.orders.has(row.id)?unsupportedLegacyContinuationStatus(row):null;if(status)unsupportedStatuses[status]++;
     if(selected.orders.has(row.id))continuationSources.orders.push(row);
    }
    orders.set(row.id,{id:row.id,accountId:row.accounts_id,markedPaid:row.pay_is==='1',user_id:row.user_id,order_sn:row.order_sn});
   }else{
    assert(Object.hasOwn(row,'order_type')&&Object.hasOwn(row,'pay_is')&&Object.hasOwn(row,'order_id'),'SELECTED_SCOPE_PAYMENT_FIELDS_MISSING');
    if(row.order_type==='1')assert(['0','1'].includes(row.pay_is),'SELECTED_SCOPE_RENTAL_PAYMENT_STATE_UNKNOWN');
    if(row.order_type==='1'&&row.pay_is==='1'){
     if(typeof row.order_id!=='string'||!row.order_id)missingPaidReference=true;
     else paid.add(row.order_id);
    }
    if(verifyContinuationStatus&&row.order_type==='1'&&selected.orders.has(row.order_id))continuationSources.pays.push(row);
   }
  });
  const d=population.domains[name];
  assert(count===source.files[name].rows&&d.captured===count&&d.considered===chosen&&d.excluded===count-chosen
   &&d.capturedIdsSha256===captured.digest('hex')&&d.consideredIdsSha256===considered.digest('hex'),'SELECTED_SCOPE_CAPTURE_DIGEST_MISMATCH');
 }
 assert(!missingPaidReference&&[...paid].every(id=>orders.has(id)),'SELECTED_SCOPE_PAID_ORDER_REFERENCE_MISSING');
 for(const [name,records] of [['accounts',accounts],['orders',orders]])
  assert(scope.totals[name]===records.size&&[...selected[name],...scope.excludedKeys[name]].every(id=>records.has(id)),
   'SELECTED_SCOPE_SOURCE_KEY_SET_MISMATCH');
 const paidAccounts=new Set();
 const conflicts=new Set(scope.conflictKeys.orders),paidOrderUnpaid=new Set(scope.conflictKeys.paymentPaidOrderUnpaid),orderPaidUnconfirmed=new Set(scope.conflictKeys.orderPaidPaymentUnconfirmed);
 for(const [id,order] of orders){
  const retained=paid.has(id);
  assert(selected.orders.has(id)===retained,'SELECTED_SCOPE_SOURCE_ORDER_DISPOSITION_MISMATCH');
  assert(conflicts.has(id)===(order.markedPaid!==retained)&&paidOrderUnpaid.has(id)===(retained&&!order.markedPaid)
   &&orderPaidUnconfirmed.has(id)===(order.markedPaid&&!retained),'SELECTED_SCOPE_SOURCE_PAYMENT_CONFLICT_MISMATCH');
  if(retained){assert(typeof order.accountId==='string'&&accounts.has(order.accountId),'SELECTED_SCOPE_PAID_ACCOUNT_REFERENCE_MISSING');paidAccounts.add(order.accountId);}
 }
 for(const [id,account] of accounts)
  assert(selected.accounts.has(id)===(account.listed||paidAccounts.has(id)),'SELECTED_SCOPE_SOURCE_ACCOUNT_DISPOSITION_MISMATCH');
 const ready={users:[],accounts:[],orders:[]},isolated={users:[],accounts:[],orders:[]},accountSnapshots={compared:0,unavailable:0};
 for(const name of ['users','accounts','orders'])if(dataset.files?.[name])await readRows(datasetDir,dataset.files[name],row=>{
  if(name==='accounts'){
   const source=accounts.get(row.sourceId)?.source;
   assert(source&&row.ownerLegacyId===source.user_id&&row.sourceStatus===source.status&&row.sourceDeleted===(source.is_delete==='1')
    &&row.businessNo===(source.no===null||source.no===''?null:source.no)&&Object.hasOwn(row,'snapshot'),'SELECTED_SCOPE_ACCOUNT_SOURCE_MISMATCH');
   if(row.snapshot===null)accountSnapshots.unavailable++;
   else{
    const snapshot=row.snapshot;
    assert(snapshot&&typeof snapshot==='object'&&!Array.isArray(snapshot)&&/^[1-5]$/.test(source.default_consume_type??'')
     &&snapshot.schema==='legacy-listing-read-v1'&&snapshot.resourceNo===row.businessNo
     &&snapshot.haffRentYuan===source.price_tenant&&snapshot.goodsYuan===source.extra_goods_total_price_tenant
     &&snapshot.depositYuan===source.deposit_amount&&snapshot.termDays===source.rental_days
     &&snapshot.dailyHaffBase===(10n*BigInt(source.default_consume_type)*1000000n).toString(),'SELECTED_SCOPE_ACCOUNT_SNAPSHOT_MISMATCH');
    accountSnapshots.compared++;
   }
  }
  ready[name].push(row.sourceId);
 });
 if(dataset.files?.quarantine)await readRows(datasetDir,dataset.files.quarantine,row=>{if(isolated[row.domain])isolated[row.domain].push(row.sourceId);});
 const result={};
 for(const [name,sourceSet] of [['users',users],['accounts',accounts],['orders',orders]]){
  const retained=name==='users'?users:selected[name];
  let partition;
  try{partition=partitionSourceKeys([...retained],ready[name],isolated[name]);}
  catch{throw new Error('SELECTED_SCOPE_INPUT_PARTITION_INCOMPLETE');}
  const expected=dataset.domains?.[name];
  assert(expected?.source===retained.size&&expected.ready===partition.ready&&expected.isolated===partition.isolated,
   'SELECTED_SCOPE_INPUT_COUNTS_MISMATCH');
  result[name]={captured:sourceSet.size,retained:partition.captured,excluded:sourceSet.size-partition.captured,ready:partition.ready,isolated:partition.isolated};
 }
 const readyUsers=new Set(ready.users),readyOrders=new Set(ready.orders),refundParents={captured:0,retainedOrder:0,subjectIsolated:0,relationshipMatched:0,relationshipUnresolved:0},refundIds=new Set(),refundDigest=createHash('sha256');
 assert(source.files?.refunds&&population.domains?.refunds,'SELECTED_SCOPE_SOURCE_DOMAIN_MISSING');
 await readRows(sourceDir,source.files.refunds,row=>{
  assert(typeof row?.id==='string'&&row.id&&!refundIds.has(row.id),'SELECTED_SCOPE_SOURCE_KEY_INVALID');
  assert(['user_id','order_type','order_id','order_sn'].every(field=>Object.hasOwn(row,field)),'SELECTED_SCOPE_REFUND_FIELDS_MISSING');
  refundIds.add(row.id);refundParents.captured++;refundDigest.update(JSON.stringify(row.id)+'\n');
  if(verifyContinuationStatus&&selected.orders.has(row.order_id))sourceRefunds.push(row);
  assert(users.has(row.user_id),'SELECTED_SCOPE_REFUND_USER_NOT_CAPTURED');
  if(!readyUsers.has(row.user_id)){refundParents.subjectIsolated++;return;}
  assert(row.order_type==='order','SELECTED_SCOPE_REFUND_TYPE_NOT_SUPPORTED');
  assert(selected.orders.has(row.order_id),'SELECTED_SCOPE_REFUND_PARENT_NOT_RETAINED');
  assert(readyOrders.has(row.order_id),'SELECTED_SCOPE_REFUND_PARENT_ISOLATED');
  const parent=orders.get(row.order_id);
  if(isExactLegacyRefundRelationship(row,parent))refundParents.relationshipMatched++;else refundParents.relationshipUnresolved++;
  refundParents.retainedOrder++;
 });
 assert(refundParents.captured===source.files.refunds.rows&&population.domains.refunds.capturedIdsSha256===refundDigest.digest('hex'),'SELECTED_SCOPE_CAPTURE_DIGEST_MISMATCH');
 let liabilitySource;
 if(verifyContinuationStatus){
  assert.deepEqual(dataset.domains.continuations.unsupportedStatuses,unsupportedStatuses,'SELECTED_SCOPE_CONTINUATION_STATUS_DRIFT');
  assert(source.files?.tradePolicy&&source.files?.distributionOrders,'SELECTED_SCOPE_CONTINUATION_SOURCES_MISSING');
  await readRows(sourceDir,source.files.tradePolicy,row=>continuationSources.tradePolicy.push(row));
  await readRows(sourceDir,source.files.distributionOrders,row=>{if(selected.orders.has(row.order_id))continuationCommissions.push(row);});
  const continuations=[];
  if(dataset.files?.continuations)await readRows(datasetDir,dataset.files.continuations,row=>continuations.push(row));
  assertContinuationSourceCoverage(continuations,continuationSources);
  assertContinuationCommissionCoverage(continuations,continuationCommissions,dataset.sourceRef);
  const liabilities=[];
  if(dataset.files?.liabilities)await readRows(datasetDir,dataset.files.liabilities,row=>liabilities.push(row));
  liabilitySource=assertLegacyLiabilitySourceCoverage(liabilities,continuationSources.orders,sourceRefunds,readyOrders);
  assert.equal(dataset.domains?.liabilities?.source,liabilitySource.total,'SELECTED_SCOPE_LIABILITY_SOURCE_COUNT_DRIFT');
 }
 return {status:'SELECTED_SCOPE_SOURCE_AND_INPUT_VERIFIED_TARGET_NOT_RUN',...result,accountSnapshots,refundParents,
  ...(verifyContinuationStatus?{liabilitySource,unsupportedContinuations:{...unsupportedStatuses,total:Object.values(unsupportedStatuses).reduce((a,b)=>a+b,0)}}:{}),sourceConnections:0,targetConnections:0,targetWrites:0};
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
