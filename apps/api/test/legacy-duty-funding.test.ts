import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareHistoricalObservation} from '../src/finance/personal-finance-read';
import {prepareObservationCoverage} from '../src/finance/personal-finance-coverage';
import {readLegacyDutyFundingProof} from '../src/finance/legacy-duty-funding';
import type {LegacyFinanceDuty,LegacyDutyFinalBasis} from '../src/finance/legacy-duty-finance';
const duty={id:'legacy_duty_'+'b'.repeat(40),orderId:'legacy_order_'+'a'.repeat(40),counterpartyUserId:'renter',kind:'RENTER_REFUND',sourceRecordId:'confirm-v1',amountCents:'8200'} as LegacyFinanceDuty;
const basis={dutyId:duty.id,amountCents:'8200',parentSourceDigest:'1'.repeat(64),parentSourceId:'101',sourceRecordDigest:'2'.repeat(64),evidenceDigest:'3'.repeat(64),evidenceId:'real-confirm-result'} as LegacyDutyFinalBasis;
function fixture(snapshots:Record<string,unknown>[]=[]){
 const cutoff='2026-09-13T13:31:22.000Z',rows=snapshots.map(snapshot=>{const o=prepareHistoricalObservation(snapshot,{userId:'renter',legacyUserId:'11',sourceSystem:'legacy_mysql_restore',basisId:null});return{source_id:o.sourceId,source_digest:o.sourceDigest,source_canonical:o.sourceCanonical,snapshot};});
 const proof=prepareObservationCoverage({userId:'renter',legacyUserId:'11',sourceSystem:'legacy_mysql_restore',sourceKind:'HISTORICAL_EARNINGS_LOG',cutoff,inputSha256:'a'.repeat(64),identityDigest:'b'.repeat(64),sourceCount:rows.length,imported:rows.map(r=>({sourceId:r.source_id,sourceDigest:r.source_digest})),isolated:[]});
 const state={opening:true,installed:true,covered:false,posted:false,badCount:false,cutoff,rows,summaryInstalled:false,sourceProof:null as any,coveredRoots:[] as Record<string,string>[],queries:[] as {sql:string;args:any[]}[]};
 const c={query:async(sql:string,args:any[]=[])=>{state.queries.push({sql,args});
  if(sql.includes('legacy reviewed source proof contract'))return{rows:[{ready:state.summaryInstalled||state.sourceProof!==null}]};
  if(sql.includes('sealed legacy source bindings only'))return{rows:[{proof:state.sourceProof}]};
  if(sql.includes('legacy funding immutable opening'))return{rows:state.opening?[{id:'basis-fixture',source_system:'legacy_mysql_restore',source_id:'11',source_digest:'9'.repeat(64),covered_set_digest:'8'.repeat(64),cutoff:state.cutoff}]:[]};
  if(sql.includes('finance history coverage installed'))return{rows:[{installed:state.installed}]};
  if(sql.includes('finance history coverage exact target'))return{rows:[{id:proof.id,source_count:rows.length,imported_count:rows.length,isolated_count:0,imported_set_digest:proof.importedSetDigest,actual_count:state.badCount?'99':String(rows.length),actual_digest:proof.importedSetDigest,invalid_count:'0',outside_count:'0',cutoff}]};
  if(sql.includes('legacy funding original order identity'))return{rows:[{legacy_id:'101',original_order_no:'ORIGINAL-ORDER-101'}]};
  if(sql.includes('legacy funding covered responsibility'))return{rows:state.covered?[{}]:[],rowCount:state.covered?1:0};
  if(sql.includes('legacy funding complete earning references'))return{rows:state.rows};
  if(sql.includes('legacy funding immutable credited roots'))return{rows:state.coveredRoots};
  if(sql.includes('legacy funding other final responsibility'))return{rows:state.posted?[{}]:[],rowCount:state.posted?1:0};
  throw Error('Unexpected funding read');}};
 return{state,c:c as any};
}
const credit=(referenceType:string,referenceId='101')=>({kind:'earningsLog',sourceId:501,sourceUserId:11,amount:'82.00',leftAmount:'82.00',action:1,createdAt:1779469800,referenceType,referenceId,referenceSn:'ORIGINAL-ORDER-101'});
test('actual complete immutable opening/history produces a bounded witness, never a DTO-only approval',async()=>{
 const f=fixture(),result=await readLegacyDutyFundingProof(f.c,duty,basis);assert.equal(result.knowledge,'KNOWN');if(result.knowledge!=='KNOWN')return;
 assert.equal(result.proof.originalSourceDigest,basis.parentSourceDigest);assert.equal(result.proof.finalEvidenceDigest,basis.evidenceDigest);assert.equal(result.proof.witness.sourceCount,'0');assert.equal(result.proof.evidenceRef,'real-confirm-result');assert(f.state.queries.every(q=>q.args[0]==='renter'||q.args[0]===duty.orderId||q.args.length===0));assert(!f.state.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
});

test('0108 installed summary returning NULL for an old basis preserves the old witness without initialization',async()=>{
 const f=fixture(),before=await readLegacyDutyFundingProof(f.c,duty,basis);assert.equal(before.knowledge,'KNOWN');
 f.state.summaryInstalled=true;const start=f.state.queries.length,after=await readLegacyDutyFundingProof(f.c,duty,basis);
 assert.deepEqual(after,before);if(after.knowledge!=='KNOWN')return;assert.equal(Object.hasOwn(after.proof.witness,'sourceProofDigest'),false);
 assert(f.state.queries.slice(start).some(q=>q.sql.includes('sealed legacy source bindings only')));
 assert(!f.state.queries.some(q=>/^\s*(INSERT|UPDATE|DELETE)/.test(q.sql)));
});

test('0108 safe summary refuses a foreign basis, user, cutoff or source digest',async()=>{
 for(const patch of [{basisId:'foreign-basis'},{userId:'other-user'},{legacyUserId:'12'},{sourceDigest:'0'.repeat(64)},{coveredDigest:'0'.repeat(64)},{cutoff:'2026-09-14T13:31:22.000Z'}]){
  const f=fixture();f.state.sourceProof={schema:'reviewed-opening-log-bindings.v1',basisId:'basis-fixture',userId:'renter',legacyUserId:'11',sourceDigest:'9'.repeat(64),coveredDigest:'8'.repeat(64),cutoff:f.state.cutoff,digest:'a'.repeat(64),logBindings:[],...patch};
  await assert.rejects(readLegacyDutyFundingProof(f.c,duty,basis),(e:any)=>e.status===503);assert(!f.state.queries.some(q=>/^\s*(INSERT|UPDATE|DELETE)/.test(q.sql)));
 }
});

test('0108 a bound log cannot borrow a different credited root beneficiary role',async()=>{
 const f=fixture([credit('LEGACY_WITHDRAWAL_RETURN','201')]);
 f.state.coveredRoots=[{source_kind:'LEGACY_WITHDRAWAL_RETURN',source_entity:'la_log_earnings',source_id:'501',source_type:'LEGACY_MYSQL',source_digest:'d'.repeat(64),beneficiary_role:'WALLET_HOLDER'}];
 f.state.sourceProof={schema:'reviewed-opening-log-bindings.v1',basisId:'basis-fixture',userId:'renter',legacyUserId:'11',sourceDigest:'9'.repeat(64),coveredDigest:'8'.repeat(64),cutoff:f.state.cutoff,digest:'a'.repeat(64),logBindings:[{observationId:'501',observationDigest:f.state.rows[0]!.source_digest,sourceKind:'LEGACY_WITHDRAWAL_RETURN',sourceEntity:'la_log_earnings',sourceId:'501',beneficiaryRole:'OWNER',sourceDigest:'d'.repeat(64)}]};
 await assert.rejects(readLegacyDutyFundingProof(f.c,duty,basis),(e:any)=>e.status===503);
});
test('source coverage, stored exclusion, unresolved prior credit and other posting each stop finalization instead of inventing absence',async()=>{
 const cases=[['opening',false],['installed',false],['covered',true],['posted',true]] as const;
 for(const [field,value]of cases){const f=fixture();f.state[field]=value;assert.equal((await readLegacyDutyFundingProof(f.c,duty,basis)).knowledge,'UNKNOWN');}
 for(const snapshot of [credit('LEGACY_RENTAL_REFUND'),credit('UNRESOLVED_ECONOMIC_SOURCE')]){const f=fixture([snapshot]);assert.equal((await readLegacyDutyFundingProof(f.c,duty,basis)).knowledge,'UNKNOWN');}
 const f=fixture([credit('LEGACY_ADMIN_LOG')]);assert.equal((await readLegacyDutyFundingProof(f.c,duty,basis)).knowledge,'UNKNOWN');
 f.state.coveredRoots.push({source_kind:'LEGACY_ADMIN_LOG',source_entity:'la_log_earnings',source_id:'501',source_type:'LEGACY_MYSQL',source_digest:'d'.repeat(64)});assert.equal((await readLegacyDutyFundingProof(f.c,duty,basis)).knowledge,'KNOWN');
});
test('bad source digest/schema/count and database errors are not swallowed as ordinary unknown',async()=>{
 const f=fixture([credit('LEGACY_ADMIN_LOG')]);f.state.rows[0]!.source_digest='f'.repeat(64);await assert.rejects(readLegacyDutyFundingProof(f.c,duty,basis),(e:any)=>e.status===503);
 const g=fixture();g.state.badCount=true;await assert.rejects(readLegacyDutyFundingProof(g.c,duty,basis),(e:any)=>e.status===503);
 const failure=Error('SOURCE_DB_UNAVAILABLE');await assert.rejects(readLegacyDutyFundingProof({query:async()=>{throw failure;}} as any,duty,basis),e=>e===failure);
});

test('a withdrawal return uses its original log root and never proves a rental refund or resolves an unrelated unknown credit',async()=>{
 const returned={...credit('LEGACY_WITHDRAWAL_RETURN','201'),referenceSn:'FIXTURE-WITHDRAWAL-201'},f=fixture([returned]);
 assert.equal((await readLegacyDutyFundingProof(f.c,duty,basis)).knowledge,'UNKNOWN');
 f.state.coveredRoots.push({source_kind:'LEGACY_WITHDRAWAL_RETURN',source_entity:'la_log_earnings',source_id:'201',source_type:'LEGACY_MYSQL',source_digest:'d'.repeat(64)});
 assert.equal((await readLegacyDutyFundingProof(f.c,duty,basis)).knowledge,'UNKNOWN');
 f.state.coveredRoots[0]!.source_id='501';assert.equal((await readLegacyDutyFundingProof(f.c,duty,basis)).knowledge,'UNKNOWN');
 f.state.coveredRoots[0]!.beneficiary_role='WALLET_HOLDER';
 f.state.sourceProof={schema:'reviewed-opening-log-bindings.v1',basisId:'basis-fixture',userId:'renter',legacyUserId:'11',sourceDigest:'9'.repeat(64),coveredDigest:'8'.repeat(64),cutoff:f.state.cutoff,digest:'a'.repeat(64),
  logBindings:[{observationId:'501',observationDigest:f.state.rows[0]!.source_digest,sourceKind:'LEGACY_WITHDRAWAL_RETURN',sourceEntity:'la_log_earnings',sourceId:'501',beneficiaryRole:'WALLET_HOLDER',sourceDigest:'d'.repeat(64)}]};
 assert.equal((await readLegacyDutyFundingProof(f.c,duty,basis)).knowledge,'KNOWN');
 const unknown=fixture([{...returned,referenceType:'UNRESOLVED_ECONOMIC_SOURCE'}]);unknown.state.coveredRoots=f.state.coveredRoots;
 assert.equal((await readLegacyDutyFundingProof(unknown.c,duty,basis)).knowledge,'UNKNOWN');
 const priorRefund=fixture([{...credit('LEGACY_RENTAL_REFUND'),sourceId:502}]);priorRefund.state.coveredRoots=f.state.coveredRoots;
 assert.equal((await readLegacyDutyFundingProof(priorRefund.c,duty,basis)).knowledge,'UNKNOWN');
 assert(f.state.queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE)/.test(q.sql)));
});
