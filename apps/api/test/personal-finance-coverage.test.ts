import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {hasProvedNativeHistoryAbsence,prepareObservationCoverage,readObservationCoverage,type ObservationCoverageInput} from '../src/finance/personal-finance-coverage';

const input=(patch:Partial<ObservationCoverageInput>={}):ObservationCoverageInput=>({
 userId:'fixture_user',legacyUserId:'101',sourceSystem:'legacy_mysql_restore',sourceKind:'HISTORICAL_WITHDRAWAL',
 cutoff:'2026-10-01T00:00:00.000Z',inputSha256:'a'.repeat(64),identityDigest:'b'.repeat(64),
 sourceCount:2,imported:[{sourceId:'2',sourceDigest:'c'.repeat(64)},{sourceId:'11',sourceDigest:'d'.repeat(64)}],isolated:[],...patch,
});
function client(row:Record<string,unknown>|null,installed=true){
 const queries:{sql:string;args:unknown[]}[]=[];
 return{queries,c:{query:async(sql:string,args:unknown[]=[])=>{queries.push({sql,args});if(sql.includes('coverage installed'))return{rows:[{installed}]};return{rows:row?[row]:[]};}} as unknown as PoolClient};
}
function stored(patch:Record<string,unknown>={}){
 const proof=prepareObservationCoverage(input());
 return{id:proof.id,source_count:2,imported_count:2,isolated_count:0,imported_set_digest:proof.importedSetDigest,
  cutoff:proof.cutoff,actual_count:'2',actual_digest:proof.importedSetDigest,invalid_count:'0',outside_count:'0',...patch};
}
test('coverage closes exact source/imported/isolated sets and preserves C-order digest',()=>{
 const a=prepareObservationCoverage(input()),b=prepareObservationCoverage(input({imported:[...input().imported].reverse()}));
 assert.equal(a.importedSetDigest,b.importedSetDigest);assert.equal(a.sourceCount,a.importedCount+a.isolatedCount);
 assert.throws(()=>prepareObservationCoverage(input({sourceCount:3})),/source set/);
 assert.throws(()=>prepareObservationCoverage(input({isolated:[{...input().imported[0]!,reason:'identity_conflict'}],sourceCount:3})),/source set/);
 assert.throws(()=>prepareObservationCoverage(input({sourceSystem:'other'})),/proof/);
});
test('zero history is KNOWN only with an exact independent zero coverage fact',async()=>{
 const proof=prepareObservationCoverage(input({sourceCount:0,imported:[]}));
 const f=client(stored({id:proof.id,source_count:0,imported_count:0,actual_count:'0',imported_set_digest:proof.importedSetDigest,actual_digest:proof.importedSetDigest}));
 const known=await readObservationCoverage(f.c,'fixture_user','HISTORICAL_WITHDRAWAL');assert.equal(known.knowledge,'KNOWN');assert.equal(known.count,'0');
 assert.equal((await readObservationCoverage(client(null).c,'fixture_user','HISTORICAL_WITHDRAWAL')).knowledge,'UNKNOWN');
 assert.equal((await readObservationCoverage(client(null,false).c,'fixture_user','HISTORICAL_WITHDRAWAL')).reason,'HISTORICAL_COVERAGE_NOT_INSTALLED');
 assert(f.queries.every(q=>/^\s*(\/\*[^]*?\*\/\s*)?SELECT\b/i.test(q.sql)));
});
test('real records become complete, isolation and later facts remain explicit unknown',async()=>{
 assert.equal((await readObservationCoverage(client(stored()).c,'fixture_user','HISTORICAL_WITHDRAWAL')).count,'2');
 assert.equal((await readObservationCoverage(client(stored({source_count:3,isolated_count:1})).c,'fixture_user','HISTORICAL_WITHDRAWAL')).reason,'HISTORICAL_SOURCE_ISOLATED');
 assert.equal((await readObservationCoverage(client(stored({outside_count:'1'})).c,'fixture_user','HISTORICAL_WITHDRAWAL')).reason,'HISTORICAL_COVERAGE_OUTDATED');
});
test('bad target binding/digest/schema error is not downgraded to an ordinary unknown',async()=>{
 for(const patch of [{actual_count:'1'},{actual_digest:'e'.repeat(64)},{source_count:1},{outside_count:'bad'},{invalid_count:'1'}]){
  await assert.rejects(()=>readObservationCoverage(client(stored(patch)).c,'fixture_user','HISTORICAL_WITHDRAWAL'),/coverage is inconsistent/);
 }
 const boom=new Error('fixture_database_error');
 await assert.rejects(()=>readObservationCoverage({query:async()=>{throw boom;}} as unknown as PoolClient,'fixture_user','HISTORICAL_WITHDRAWAL'),e=>e===boom);
 await assert.rejects(()=>readObservationCoverage({query:async()=>({rows:[{}]})} as unknown as PoolClient,'fixture_user','HISTORICAL_WITHDRAWAL'),/coverage is inconsistent/);
 const f=client(stored());await readObservationCoverage(f.c,'fixture_user','HISTORICAL_DISTRIBUTION');
 assert.deepEqual(f.queries[1]?.args,['fixture_user','HISTORICAL_DISTRIBUTION']);
});
test('native absence reuses birth, identity, no migration audit and exact history domain proof',async()=>{
 const seen:{sql:string;args:unknown[]}[]=[];
 const c={query:async(sql:string,args:unknown[])=>{seen.push({sql,args});return{rows:[{complete:true}]};}} as unknown as PoolClient;
 assert.equal(await hasProvedNativeHistoryAbsence(c,'fixture_user','HISTORICAL_DISTRIBUTION'),true);
 assert.deepEqual(seen[0]?.args,['fixture_user','HISTORICAL_DISTRIBUTION']);assert.match(seen[0]!.sql,/native_user_insert_proof/);assert.match(seen[0]!.sql,/s.provider='none'/);assert.match(seen[0]!.sql,/NOT EXISTS[^]*user.legacy_owner.migrated/);assert.match(seen[0]!.sql,/h.source_kind=\$2/);
 await assert.rejects(()=>hasProvedNativeHistoryAbsence({query:async()=>({rows:[{}]})} as unknown as PoolClient,'fixture_user','HISTORICAL_DISTRIBUTION'),/coverage is inconsistent/);
});
