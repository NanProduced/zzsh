import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertSelectedScopeForWrite } from './selected-business-scope.mjs';
import { assertCaptureTargetProfile, NEXT_MIGRATION_PROFILE } from './local-target-registry.mjs';
import { assertNextBusinessPopulation } from './local-source-adapter.mjs';

const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sha=value=>createHash('sha256').update(value).digest('hex');
export const directFullDomains=['users','accounts','orders','earnings','withdraws','distributionOrders'];
export const retainedFullDomains=['pays','refunds','distribution','moneyLogs','orderAfter','distributionLevels','distributionConfig'];

/** Input was considered by the converter; this alone never means it was imported. */
export function assertCapturedPopulation(dataset,source) {
  const p=dataset?.population;
  assert(p?.schema==='zzsh.local-population-scope.v1'&&p.mode==='FULL_CAPTURED_SOURCE'
    &&p.meaning==='CAPTURED_DOMAINS_ONLY_NOT_ALL_LEGACY_TABLES'&&p.digestOrder==='CAPTURE_ORDER_JSON_ID_PER_LINE'
    &&p.consideredMeans==='INPUT_LOADED_NOT_CONVERTED_OR_IMPORTED'&&p.sourceStatusPolicy==='PRESERVE_SOURCE_FLAGS_VERIFY_SEPARATELY'&&p.targetStatus==='NOT_VERIFIED'
    &&hex(dataset.populationSha256)&&sha(JSON.stringify(p))===dataset.populationSha256
    &&p.sourceReceiptSha256===dataset.sourceReceiptSha256&&hex(p.sourceReceiptSha256)
    &&source?.status==='CAPTURED_READ_ONLY'&&source.rollbackConfirmed===true&&source.clientClosed===true&&source.files,
    'FULL_CAPTURED_SCOPE_INVALID');
  const names=Object.keys(source.files).sort();
  assert.deepEqual(Object.keys(p.domains??{}).sort(),names,'FULL_CAPTURED_DOMAIN_SET_CHANGED');
  for(const name of names){const d=p.domains[name],file=source.files[name];
    assert(Number.isSafeInteger(file.rows)&&file.rows>=0&&d?.captured===file.rows&&d.considered===file.rows&&d.excluded===0
      &&hex(d.capturedIdsSha256)&&d.consideredIdsSha256===d.capturedIdsSha256,'FULL_CAPTURED_DENOMINATOR_CHANGED:'+name);
  }
  for(const domain of directFullDomains){const d=dataset.domains?.[domain],n=source.files[domain]?.rows;
    assert(Number.isSafeInteger(n)&&d?.source===n&&Number.isSafeInteger(d.ready)&&Number.isSafeInteger(d.isolated)
      &&d.ready>=0&&d.isolated>=0&&d.ready+d.isolated===n,'FULL_CAPTURED_DIRECT_COUNTS_CHANGED:'+domain);
    if(['users','accounts','orders'].includes(domain))assert((dataset.files?.[domain]?.rows??0)===d.ready,'FULL_CAPTURED_READY_FILE_CHANGED:'+domain);
  }
  const retained=retainedFullDomains.filter(name=>Object.hasOwn(source.files,name));
  assert(retained.every(name=>dataset.domains?.[name]?.source===source.files[name].rows)
    &&(dataset.files?.['source-relations']?.rows??0)===retained.reduce((n,name)=>n+source.files[name].rows,0)
    &&(dataset.files?.['finance-observations']?.rows??0)===['earnings','withdraws','distributionOrders'].reduce((n,name)=>n+dataset.domains[name].ready,0),'FULL_CAPTURED_OUTPUT_COUNTS_CHANGED');
  const b=dataset.storedBalanceCoverage;
  assert(b?.readyUsers===dataset.domains.users.ready&&Number.isSafeInteger(b.readyAmounts)&&Number.isSafeInteger(b.isolatedAmounts)
    &&b.readyAmounts>=0&&b.isolatedAmounts>=0&&b.readyAmounts+b.isolatedAmounts===b.readyUsers
    &&b.readyAmounts===(dataset.files?.['stored-balances']?.rows??0)&&b.targetOpening==='NOT_ADMITTED','FULL_CAPTURED_BALANCE_COVERAGE_CHANGED');
  return {mode:p.mode,scopeSha256:dataset.populationSha256,sourceRows:Object.fromEntries(directFullDomains.map(k=>[k,p.domains[k].captured])),
    ready:Object.fromEntries(directFullDomains.map(k=>[k,dataset.domains[k].ready])),isolated:Object.fromEntries(directFullDomains.map(k=>[k,dataset.domains[k].isolated]))};
}

/** Source IDs must be partitioned exactly once into ready or explicitly isolated. */
export function partitionSourceKeys(sourceIds,readyIds,isolatedIds) {
  const pending=new Set(sourceIds),seen=new Set();assert(pending.size===sourceIds.length,'FULL_SOURCE_DUPLICATE_CAPTURE_KEY');
  for(const [kind,ids] of [['ready',readyIds],['isolated',isolatedIds]])for(const id of ids){
    assert(typeof id==='string'&&pending.has(id)&&!seen.has(id),'FULL_SOURCE_PARTITION_KEY_INVALID:'+kind);
    pending.delete(id);seen.add(id);
  }
  assert.equal(pending.size,0,'FULL_SOURCE_PARTITION_INCOMPLETE');
  return {captured:sourceIds.length,ready:readyIds.length,isolated:isolatedIds.length,differences:0};
}

export function assertRoundPopulationBinding(input,dataset,source,verification) {
  assertCaptureTargetProfile(source,input.target?.migrationProfile ?? null);
  assertNextBusinessPopulation(dataset?.population, input?.target?.migrationProfile === NEXT_MIGRATION_PROFILE);
  if(!dataset.population){assert(!input.population,'UNDECLARED_POPULATION_CANNOT_BE_PROMOTED');return {mode:dataset.scenarioSelection?.schema==='zzsh.source-scenarios.v1'?'LEGACY_SCENARIO_SELECTION':'LEGACY_UNDECLARED'};}
  if(dataset.population.mode!=='FULL_CAPTURED_SOURCE'){
    const p=dataset.population;
  assert((p.mode==="SCENARIO_SELECTION"||p.mode==="SELECTED_BUSINESS_SCOPE")&&input.population?.mode!=="FULL_CAPTURED_SOURCE"&&p.schema==="zzsh.local-population-scope.v1"
      &&p.sourceReceiptSha256===dataset.sourceReceiptSha256&&source?.status==='CAPTURED_READ_ONLY'&&source.rollbackConfirmed===true&&source.clientClosed===true
      &&hex(dataset.populationSha256)&&sha(JSON.stringify(p))===dataset.populationSha256,'POPULATION_MODE_MISMATCH');
    assert.deepEqual(Object.keys(p.domains??{}).sort(),Object.keys(source.files??{}).sort(),'SCENARIO_CAPTURED_DOMAIN_SET_CHANGED');
    for(const [name,d] of Object.entries(p.domains))assert(d.captured===source.files[name].rows&&Number.isSafeInteger(d.considered)
      &&d.considered>=0&&d.excluded===d.captured-d.considered&&hex(d.capturedIdsSha256)&&hex(d.consideredIdsSha256),'SCENARIO_SCOPE_INVALID');
  return {mode:p.mode,...(p.mode==='SELECTED_BUSINESS_SCOPE'?assertSelectedScopeForWrite(dataset):{})};
  }
  const result=assertCapturedPopulation(dataset,source),p=input.population;
  assert(p?.schema==='zzsh.round-population-binding.v1'&&p.mode==='FULL_CAPTURED_SOURCE'
    &&p.scopeSha256===dataset.populationSha256&&p.sourceReceiptSha256===input.source?.sha256
    &&p.sourceReceiptSha256===dataset.sourceReceiptSha256&&typeof p.verification?.path==='string'
    &&hex(p.verification.sha256)&&input.strictBatch===true,'FULL_ROUND_SCOPE_BINDING_REQUIRED');
  assert(verification?.schema==='zzsh.full-source-scope-readback.v1'&&verification.status==='DIRECT_DOMAIN_SOURCE_PARTITIONS_VERIFIED_TARGET_NOT_RUN'
    &&verification.datasetSha256===input.dataset?.sha256&&verification.sourceReceiptSha256===input.source.sha256
    &&verification.populationSha256===dataset.populationSha256&&verification.differenceCount===0
    &&verification.sourceConnections===0&&verification.targetConnections===0&&verification.targetWrites===0
    &&verification.statusProof?.status==='SOURCE_VS_PLANNED_VERIFIED_TARGET_NOT_RUN'
    &&verification.balanceProof?.status==='READY_SUBJECT_PARTITION_VERIFIED_TARGET_NOT_RUN'
    &&directFullDomains.every(name=>verification.partitions?.[name]?.captured===result.sourceRows[name]
      &&verification.partitions[name].ready===result.ready[name]&&verification.partitions[name].isolated===result.isolated[name]
      &&verification.partitions[name].differences===0),'FULL_SCOPE_INDEPENDENT_READBACK_REQUIRED');
  return {...result,status:'FULL_CAPTURED_INPUT_SCOPE_VERIFIED_TARGET_NOT_YET_PROVED'};
}

/**
 * A full-source round stays closed until the two facts that make it survivable are both true in this
 * build: empty finance coverage is produced in bounded chunks, and the core readback proves the target
 * key set rather than only per-row facts. The population must also declare that it was prepared under
 * the bounded path, so a dataset built by an older planner cannot ride the new admission.
 */
export const FULL_EXECUTION_READINESS=Object.freeze({boundedEmptyCoverage:true,targetKeySetReadback:true});
export function assertFullExecutionAdmitted(population,action) {
  if(!['execute','resume-growth'].includes(action))return;
  if(population?.mode==='FULL_CAPTURED_SOURCE'){
    if(!FULL_EXECUTION_READINESS.boundedEmptyCoverage||!FULL_EXECUTION_READINESS.targetKeySetReadback)
      throw new Error('FULL_CAPTURED_EXECUTION_BLOCKED_PENDING_BOUNDED_COVERAGE_AND_TARGET_SET_READBACK');
    if(population.boundedEmptyCoverage!==true)
      throw new Error('FULL_CAPTURED_EXECUTION_REQUIRES_BOUNDED_EMPTY_COVERAGE');
    return;
  }
  // The seventh round runs a business-selected subset: it must never be confused with the full capture,
  // and its own scope module proves the retained, excluded and isolated keys.
  if(population?.mode==='SELECTED_BUSINESS_SCOPE')return;
  if(!['SCENARIO_SELECTION','LEGACY_SCENARIO_SELECTION'].includes(population?.mode))throw new Error('UNDECLARED_POPULATION_EXECUTION_BLOCKED');
}
