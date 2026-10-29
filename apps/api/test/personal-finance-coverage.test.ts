import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {hasProvedNativeHistoryAbsence,prepareObservationCoverage,readObservationCoverage,assertFinanceSingleCutoff,type ObservationCoverageInput} from '../src/finance/personal-finance-coverage';

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
function gate(answer:unknown){const seen:{sql:string;args:unknown[]}[]=[];return{seen,c:{query:async(sql:string,args:unknown[]=[])=>{seen.push({sql,args});return{rows:answer===undefined?[]:[answer]};}} as unknown as PoolClient};}
test('single cutoff admission rejects divergent funding inputs in either write direction, scoped to one wallet and never writing',async()=>{
 const input={userId:'fixture_user',cutoff:'2026-10-01T00:00:00.000Z'} as const;
 const same=gate({openingDiffers:false,coverageDiffers:false});
 await assertFinanceSingleCutoff(same.c,{...input,write:'OPENING'});await assertFinanceSingleCutoff(same.c,{...input,write:'OBSERVATION'});
 assert(same.seen.every(q=>/^\s*\/\*[^]*?\*\/\s*SELECT\b/i.test(q.sql)&&!/(INSERT|UPDATE|DELETE)/.test(q.sql)));
 assert.match(same.seen[0]!.sql,/source_kind='LEGACY_OPENING'/);assert.match(same.seen[0]!.sql,/b\.source_system='legacy_mysql_restore'/);assert.match(same.seen[0]!.sql,/c\.source_system='legacy_mysql_restore'/);
 assert.match(same.seen[0]!.sql,/c\.source_kind='HISTORICAL_EARNINGS_LOG'/);assert.match(same.seen[0]!.sql,/c\.source_entity='la_log_earnings'/);
 assert.deepEqual(same.seen[0]!.args,['fixture_user',input.cutoff]);
 const coverage=gate({openingDiffers:false,coverageDiffers:true});
 await assert.rejects(()=>assertFinanceSingleCutoff(coverage.c,{...input,write:'OPENING'}),(e:any)=>e.status===409);
 await assert.rejects(()=>assertFinanceSingleCutoff(coverage.c,{...input,write:'OBSERVATION'}),(e:any)=>e.status===409);
 const opening=gate({openingDiffers:true,coverageDiffers:false});
 await assert.rejects(()=>assertFinanceSingleCutoff(opening.c,{...input,write:'OBSERVATION'}),(e:any)=>e.status===409);
 await assert.rejects(()=>assertFinanceSingleCutoff(opening.c,{...input,write:'OPENING'}),(e:any)=>e.status===409);
});
test('single cutoff admission fails closed on unreadable answers and malformed bindings',async()=>{
 for(const answer of [undefined,{openingDiffers:'no',coverageDiffers:false},{openingDiffers:false}])await assert.rejects(()=>assertFinanceSingleCutoff(gate(answer).c,{userId:'fixture_user',cutoff:'2026-10-01T00:00:00.000Z',write:'OPENING'}),/coverage is inconsistent/);
 for(const patch of [{userId:'bad user'},{cutoff:'2026-10-01T00:00:00Z'},{cutoff:'not-a-time'},{write:'OTHER'}])await assert.rejects(()=>assertFinanceSingleCutoff(gate({openingDiffers:false,coverageDiffers:false}).c,{userId:'fixture_user',cutoff:'2026-10-01T00:00:00.000Z',write:'OPENING',...patch} as any));
});
test('Root single cutoff refuses new writes that would hide an existing incompatible coverage or opening',async()=>{
 const input={userId:'fixture_user',cutoff:'2026-10-01T00:00:00.000Z'} as const;
 await assert.rejects(()=>assertFinanceSingleCutoff(gate({openingDiffers:false,coverageDiffers:true}).c,{...input,write:'OBSERVATION'}),(e:any)=>e.status===409);
 await assert.rejects(()=>assertFinanceSingleCutoff(gate({openingDiffers:true,coverageDiffers:false}).c,{...input,write:'OPENING'}),(e:any)=>e.status===409);
});
test('Root a missing required funding table is unavailable, never a compatible empty history',async()=>{
 const c={query:async()=>{throw Object.assign(Error('missing funding table'),{code:'42P01'});}} as unknown as PoolClient;
 await assert.rejects(()=>assertFinanceSingleCutoff(c,{userId:'fixture_user',cutoff:'2026-10-01T00:00:00.000Z',write:'OPENING'}),(e:any)=>e.status===503);
});
