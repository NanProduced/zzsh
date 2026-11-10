import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assertCapturedPopulation, assertFullExecutionAdmitted, assertRoundPopulationBinding, directFullDomains, partitionSourceKeys, retainedFullDomains } from './full-source-scope.mjs';
import { summarizePopulationScope } from './local-source-scenarios.mjs';
import { verifyPopulationFiles } from './verify-full-source-population.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),sourceSha='a'.repeat(64),datasetSha='b'.repeat(64);
function fixture(){
 const data={users:[{id:'1',is_delete:'0',is_disable:'0'},{id:'2',is_delete:'1',is_disable:'0'},{id:'3',is_delete:'0',is_disable:'1'}],
  accounts:[{id:'10',is_delete:'1',status:'3'}],orders:[{id:'20',is_delete:'0'}],earnings:[{id:'30'},{id:'31'}],withdraws:[],distributionOrders:[],pays:[{id:'40'}],
  refunds:[],distribution:[{id:'50'}],moneyLogs:[],orderAfter:[],distributionLevels:[],distributionConfig:[],games:[{id:'100'}]};
 const population=summarizePopulationScope(data,'FULL_CAPTURED_SOURCE',null,sourceSha),files={},rows={};
 for(const [name,value] of Object.entries(data)){files[name]={file:'source-'+name,rows:value.length};rows['source-'+name]=value;}
 const source={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,files};
 const domains=Object.fromEntries(directFullDomains.map(name=>[name,{source:data[name].length,ready:data[name].length,isolated:0}]));
 domains.users={source:3,ready:2,isolated:1};domains.earnings={source:2,ready:1,isolated:1};
 for(const name of retainedFullDomains)domains[name]={source:data[name].length};
 const df={users:{file:'ready-users',rows:2},accounts:{file:'ready-accounts',rows:1},orders:{file:'ready-orders',rows:1},
  'finance-observations':{file:'ready-finance',rows:1},'source-relations':{file:'retained',rows:2},'stored-balances':{file:'balances',rows:1},quarantine:{file:'quarantine',rows:3}};
 const userRow=(sourceId,deleted,disabled)=>({sourceId,sourceStatus:{deleted,disabled},input:{evidence:{status:{deleted,disabled}}}});
 Object.assign(rows,{'ready-users':[userRow('1',false,false),userRow('2',true,false)],'ready-accounts':[{sourceId:'10',sourceDeleted:true,sourceStatus:'3'}],'ready-orders':[{sourceId:'20',sourceDeleted:false}],
  'ready-finance':[{domain:'earnings',sourceId:'30'}],retained:[{domain:'pays',row:{id:'40'}},{domain:'distribution',row:{id:'50'}}],
  balances:[{sourceId:'1'}],quarantine:[{domain:'users',sourceId:'3'},{domain:'earnings',sourceId:'31'},{domain:'balances',sourceId:'2'}]});
 const dataset={sourceReceiptSha256:sourceSha,population,populationSha256:sha(JSON.stringify(population)),domains,files:df,
  storedBalanceCoverage:{readyUsers:2,readyAmounts:1,isolatedAmounts:1,targetOpening:'NOT_ADMITTED'}};
 const readRows=async(_dir,meta,visit)=>{for(const row of rows[meta.file]??[])visit(row)};
 return {data,source,dataset,rows,readRows};
}
test('full captured scope binds every domain but does not equate considered, ready and isolated',()=>{
 const f=fixture(),x=assertCapturedPopulation(f.dataset,f.source);
 assert.equal(x.sourceRows.users,3);assert.equal(x.ready.users,2);assert.equal(x.isolated.users,1);
 const changed=structuredClone(f.dataset);changed.domains.users.isolated=0;assert.throws(()=>assertCapturedPopulation(changed,f.source));
 const scope=structuredClone(f.dataset);scope.population.domains.users.considered=2;scope.populationSha256=sha(JSON.stringify(scope.population));assert.throws(()=>assertCapturedPopulation(scope,f.source));
});
test('partition rejects missing, duplicated, overlapping and foreign source keys',()=>{
 assert.deepEqual(partitionSourceKeys(['1','2'],['1'],['2']),{captured:2,ready:1,isolated:1,differences:0});
 for(const [source,ready,isolated] of [[['1','1'],[],[]],[['1','2'],['1'],[]],[['1'],['1'],['1']],[['1'],['2'],[]]])
  assert.throws(()=>partitionSourceKeys(source,ready,isolated));
});
test('independent source key partition detects an omitted isolated row and retained-record substitution',async()=>{
 const f=fixture(),result=await verifyPopulationFiles({datasetDir:'dataset',sourceDir:'source',dataset:f.dataset,source:f.source,readRows:f.readRows});
 assert.equal(result.partitions.users.captured,3);assert.equal(result.partitions.users.isolated,1);assert.equal(result.differenceCount,0);
 assert.equal(result.statusProof.users.CANCELLED,1);assert.equal(result.statusProof.deletedAccounts,1);assert.equal(result.balanceProof.ready,1);assert.equal(result.balanceProof.isolated,1);
 assert.deepEqual(result.auxiliaryDomainsNotOutcomeChecked,['games']);
 f.rows.quarantine=[{domain:'earnings',sourceId:'31'}];
 await assert.rejects(()=>verifyPopulationFiles({datasetDir:'dataset',sourceDir:'source',dataset:f.dataset,source:f.source,readRows:f.readRows}));
 const g=fixture();g.rows.retained[0].row.id='999';
 await assert.rejects(()=>verifyPopulationFiles({datasetDir:'dataset',sourceDir:'source',dataset:g.dataset,source:g.source,readRows:g.readRows}));
});
test('source statuses cannot be silently activated or rewritten in planned records',async()=>{
 const verify=f=>verifyPopulationFiles({datasetDir:'dataset',sourceDir:'source',dataset:f.dataset,source:f.source,readRows:f.readRows});
 const cancelled=fixture();cancelled.rows['ready-users'][1].input.evidence.status.deleted=false;await assert.rejects(()=>verify(cancelled),/USER_STATUS_DRIFT/);
 const frozen=fixture();frozen.rows['ready-users'][1]={sourceId:'3',sourceStatus:{deleted:false,disabled:true},input:{evidence:{status:{deleted:false,disabled:true}}}};
 frozen.rows.quarantine[0].sourceId='2';frozen.rows.quarantine[2].sourceId='3';
 assert.equal((await verify(frozen)).statusProof.users.FROZEN,1);
 frozen.rows['ready-users'][1].input.evidence.status.disabled=false;await assert.rejects(()=>verify(frozen),/USER_STATUS_DRIFT/);
 const account=fixture();account.rows['ready-accounts'][0].sourceDeleted=false;await assert.rejects(()=>verify(account),/DELETED_STATUS_DRIFT/);
 const extraBalance=fixture();extraBalance.rows.balances.push({sourceId:'2'});await assert.rejects(()=>verify(extraBalance),/PARTITION_KEY_INVALID/);
});
test('full round requires exact source scope, strict batching and independent source-only verification',async()=>{
 const f=fixture(),proof=await verifyPopulationFiles({datasetDir:'dataset',sourceDir:'source',dataset:f.dataset,source:f.source,readRows:f.readRows});
 const input={strictBatch:true,source:{sha256:sourceSha},dataset:{sha256:datasetSha},population:{schema:'zzsh.round-population-binding.v1',mode:'FULL_CAPTURED_SOURCE',scopeSha256:f.dataset.populationSha256,sourceReceiptSha256:sourceSha,verification:{path:'private/receipt.json',sha256:'c'.repeat(64)}}};
 const verification={schema:'zzsh.full-source-scope-readback.v1',status:'DIRECT_DOMAIN_SOURCE_PARTITIONS_VERIFIED_TARGET_NOT_RUN',datasetSha256:datasetSha,sourceReceiptSha256:sourceSha,populationSha256:f.dataset.populationSha256,...proof,sourceConnections:0,targetConnections:0,targetWrites:0};
 assert.equal(assertRoundPopulationBinding(input,f.dataset,f.source,verification).status,'FULL_CAPTURED_INPUT_SCOPE_VERIFIED_TARGET_NOT_YET_PROVED');
 assert.throws(()=>assertRoundPopulationBinding({...input,target:{migrationProfile:'LOCAL_MIGRATION_NEXT_V1'}},f.dataset,{...f.source,sourceOrigin:{schema:'zzsh.local-source-origin.v2'}},verification),/NEXT_SELECTED_BUSINESS_SCOPE_REQUIRED/);
 for(const mutate of [x=>{x.strictBatch=false;},x=>{x.population.mode='SCENARIO_SELECTION';},x=>{x.population.scopeSha256='f'.repeat(64);}]){
  const changed=structuredClone(input);mutate(changed);assert.throws(()=>assertRoundPopulationBinding(changed,f.dataset,f.source,verification));
 }
 assert.throws(()=>assertRoundPopulationBinding(input,f.dataset,f.source,{...verification,targetWrites:1}));
 assert.throws(()=>assertRoundPopulationBinding(input,f.dataset,f.source,null));
 assert.throws(()=>assertRoundPopulationBinding(input,{...f.dataset,population:undefined},f.source,verification));
 assert.equal(assertRoundPopulationBinding({}, {}, null, null).mode,'LEGACY_UNDECLARED');
 assert.equal(assertRoundPopulationBinding({}, {scenarioSelection:{schema:'zzsh.source-scenarios.v1'}}, null, null).mode,'LEGACY_SCENARIO_SELECTION');
 // A full-source population that does not declare the bounded empty-coverage path is still refused,
 // and the declaration alone is not enough: the readiness facts of this build must both be true.
 assert.throws(()=>assertFullExecutionAdmitted({mode:'FULL_CAPTURED_SOURCE'},'execute'),/FULL_CAPTURED_EXECUTION_REQUIRES_BOUNDED_EMPTY_COVERAGE/);
 assert.throws(()=>assertFullExecutionAdmitted({mode:'FULL_CAPTURED_SOURCE'},'resume-growth'),/FULL_CAPTURED_EXECUTION_REQUIRES_BOUNDED_EMPTY_COVERAGE/);
 assert.throws(()=>assertFullExecutionAdmitted({mode:'FULL_CAPTURED_SOURCE',boundedEmptyCoverage:false},'execute'),/FULL_CAPTURED_EXECUTION_REQUIRES_BOUNDED_EMPTY_COVERAGE/);
 assert.doesNotThrow(()=>assertFullExecutionAdmitted({mode:'FULL_CAPTURED_SOURCE',boundedEmptyCoverage:true},'execute'));
 assert.doesNotThrow(()=>assertFullExecutionAdmitted({mode:'FULL_CAPTURED_SOURCE'},'validate'));
 assert.doesNotThrow(()=>assertFullExecutionAdmitted({mode:'SCENARIO_SELECTION'},'execute'));
 assert.doesNotThrow(()=>assertFullExecutionAdmitted({mode:'LEGACY_SCENARIO_SELECTION'},'execute'));
 assert.throws(()=>assertFullExecutionAdmitted({mode:'LEGACY_UNDECLARED'},'execute'),/UNDECLARED_POPULATION_EXECUTION_BLOCKED/);
 assert.throws(()=>assertFullExecutionAdmitted({mode:'UNKNOWN'},'execute'),/UNDECLARED_POPULATION_EXECUTION_BLOCKED/);
});
test('a v2 capture cannot be passed through the historical R07 profile',()=>{
 const next={sourceOrigin:{schema:'zzsh.local-source-origin.v2'}};
 assert.throws(()=>assertRoundPopulationBinding({}, {}, next, null),/TARGET_SOURCE_PROFILE_MISMATCH/);
 assert.throws(()=>assertRoundPopulationBinding({target:{migrationProfile:'LOCAL_MIGRATION_NEXT_V1'}}, {}, {}, null),/TARGET_SOURCE_PROFILE_MISMATCH/);
 assert.equal(assertRoundPopulationBinding({}, {}, {}, null).mode,'LEGACY_UNDECLARED');
 assert.throws(()=>assertRoundPopulationBinding({target:{migrationProfile:'LOCAL_MIGRATION_NEXT_V1'}}, {}, next, null),/NEXT_SELECTED_BUSINESS_SCOPE_REQUIRED/);
});
