import {test} from 'node:test';import {strict as assert} from 'node:assert';import type {Pool} from 'pg';
import {parseEarningsQuery,parseEarningsDetailQuery,decodeEarningDetailId,earningProjection,readMyDistributionEarnings,readEarningCalculation} from '../src/finance/distribution-earning-read';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {freezePaymentDistributionBasis} from '../src/finance/distribution-payment-basis';
import {prepareObservationCoverage} from '../src/finance/personal-finance-coverage';
import {prepareHistoricalObservation} from '../src/finance/personal-finance-read';
const actor={userId:'self',sessionId:'session'},key={keyId:'test',secret:'x'.repeat(40)},at='2026-10-04T00:00:00.000000Z';
const snapshot={kind:'historicalDistribution',sourceId:1,sourceUserId:11,amount:'12.34',sourceStatus:2,sourceUpdatedAt:1791072000,level:2,orderId:71};
const original=prepareHistoricalObservation(snapshot,{userId:'self',legacyUserId:'11',sourceSystem:'legacy_mysql_restore',basisId:null});
const legacy={id:'history:one',origin:'LEGACY_MYSQL',state:'SETTLED',role:'RENTER_REFERRAL',source_amount:'12.34',occurred_at:at,due_at:null,funds_disposition:'HISTORICAL_STATUS_ONLY',recovery_required_cents:null,included:true,version:'0',order_id:'71',user_id:'self',legacy_user_id:'11',source_system:original.sourceSystem,source_entity:original.sourceEntity,source_id:original.sourceId,source_digest:original.sourceDigest,source_canonical:original.sourceCanonical,snapshot};
const native={...legacy,id:'native:two',origin:'NATIVE',state:'RECOVERY_REQUIRED',source_amount:'1234',funds_disposition:'SETTLED',recovery_required_cents:'1234',version:'3',due_at:at,included:false};
function probe(nativeInstalled:boolean,rows:Record<string,any>[],coverage='RECONCILED_OPENING',historyCoverage?:Record<string,unknown>,earningBasisInstalled=false,legacyFinance?:{responsibility?:Record<string,any>[];finance?:Record<string,any>[];responsibilityVersion?:string;financeVersion?:string}){
 const seen:{sql:string;args:any[]}[]=[],pool={connect:async()=>({release(){},query:async(sql:string,args:any[]=[])=>{seen.push({sql,args});
  if(['BEGIN','COMMIT','ROLLBACK','SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'].includes(sql))return{rows:[]};
  if(sql.startsWith('SELECT "suspended"'))return{rows:[{suspended:false}]};
  if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return{rows:[{accountStatus:'ACTIVE'}]};
  if(sql.startsWith('SELECT 1 FROM "zzsh_auth_user"."session"'))return{rows:[{}],rowCount:1};
  if(sql.includes('finance history coverage installed'))return{rows:[{installed:historyCoverage!==undefined}]};
  if(sql.includes('finance history coverage exact target'))return{rows:[historyCoverage]};
  if(sql.startsWith('SELECT EXISTS'))return{rows:[{complete:coverage==='NATIVE_GENESIS'&&!rows.some(r=>r.origin==='LEGACY_MYSQL')}]};
  if(sql.startsWith('SELECT to_regclass'))return{rows:[{history:true,native:nativeInstalled,native_origin:true,earning_basis:earningBasisInstalled,legacy_finance:legacyFinance!==undefined}]};
  if(sql.includes('own legacy commission responsibility version'))return{rows:[{version:legacyFinance?.responsibilityVersion??'a'.repeat(32)}]};
  if(sql.includes('own legacy commission financial version'))return{rows:[{version:legacyFinance?.financeVersion??'f'.repeat(32)}]};
  if(sql.includes('own legacy commission current responsibility'))return{rows:(legacyFinance?.responsibility??[]).filter(r=>r.userId===args[0]&&args[1].includes(r.sourceRecordId))};
  if(sql.includes('own legacy commission complete financial facts'))return{rows:(legacyFinance?.finance??[]).filter(r=>r.actual_duty?.counterparty_user_id===args[0]&&args[1].includes(r.actual_duty?.source_record_id))};
  if(sql.startsWith('SELECT origin'))return{rows:coverage?[{origin:coverage}]:[]};
  if(sql.includes(' AS count,md5')){const selected=rows.filter(r=>args[1]==='ALL'||r.state===args[1]);return{rows:[{count:String(selected.length),digest:'source-digest',native_amount_cents:selected.filter(r=>r.origin==='NATIVE').reduce((s,r)=>s+BigInt(r.source_amount),0n).toString(),historical_amount_cents:selected.filter(r=>r.origin==='LEGACY_MYSQL').reduce((s,r)=>s+BigInt(r.source_amount.replace('.','')),0n).toString()}]};}
  if(sql.startsWith('SELECT to_char'))return{rows:[{at}]};
  if(sql.startsWith('WITH earnings'))return{rows:args.length===2?rows.filter(r=>r.id===args[1]):rows.filter(r=>!args[4]||r.id<args[4]).slice(0,args[5])};
  throw Error('Unexpected read query');}})} as unknown as Pool;return{pool,seen};
}
test('legacy settled observation keeps original cents and cannot become new credit or paid-channel proof',()=>{const r=earningProjection(legacy);assert.equal(r.amount.amountCents,'1234');assert.equal(r.includedInOpening,true);assert.equal(r.accountingEffect,'OBSERVATION_ONLY_NO_NEW_CREDIT');assert.equal(r.dueAt,null);assert.equal(r.dueAtKnowledge,'UNKNOWN');assert.equal(r.channelArrivalKnowledge,'UNKNOWN');for(const patch of [{state:'EXPIRED'},{source_digest:'c'.repeat(64)},{source_amount:'1.00'},{order_id:'foreign'},{role:'OWNER_REFERRAL'},{occurred_at:'2026-10-05T00:00:00.000000Z'},{snapshot:{...snapshot,sourceUserId:12}}])assert.throws(()=>earningProjection({...legacy,...patch}),(e:any)=>e.status===503);});
test('native recovery projects the original settled liability without pretending it has been reversed',()=>{const r=earningProjection(native);assert.equal(r.state,'RECOVERY_REQUIRED');assert.equal(r.fundsDisposition,'SETTLED');assert.equal(r.recoveryRequiredCents,'1234');for(const patch of [{recovery_required_cents:'1233'},{funds_disposition:'REVOKED'},{due_at:null},{role:'TASK_REFERRAL'},{source_amount:'1.2'}])assert.throws(()=>earningProjection({...native,...patch}));});
test('earnings query rejects caller-selected identity, duplicate keys, unknown projection versions and unbounded pages',()=>{assert.deepEqual(parseEarningsQuery(new URLSearchParams()),{state:'ALL',limit:20,cursor:null});assert.deepEqual(parseEarningsQuery(new URLSearchParams('projectionVersion=1')),{state:'ALL',limit:20,cursor:null});assert.equal(parseEarningsDetailQuery(new URLSearchParams('projectionVersion=2')).projectionVersion,2);for(const q of ['userId=other','state=ALL&state=PENDING','limit=51','state=PAID','limit=0','projectionVersion=0','projectionVersion=3','projectionVersion=2&projectionVersion=2'])assert.throws(()=>parseEarningsQuery(new URLSearchParams(q)));assert.throws(()=>parseEarningsDetailQuery(new URLSearchParams('state=ALL')));assert.equal(decodeEarningDetailId('history%3Aone'),'history:one');assert.equal(decodeEarningDetailId('native:one'),'native:one');for(const id of ['history%253Aone','history%3Aone%2Fother','history%3Aone%5Cother','%'])assert.throws(()=>decodeEarningDetailId(id));});
test('missing native schema still returns own historical evidence without fabricating a complete total',async()=>{const p=probe(false,[legacy]),r=await readMyDistributionEarnings(p.pool,actor,{state:'ALL',limit:20,cursor:null},key);assert.equal(r.knowledge,'UNKNOWN');assert.equal(r.count,null);assert.equal(r.mappedRecordCount,'1');assert.equal(r.items?.[0]?.amount.amountCents,'1234');assert(!p.seen.some(q=>q.sql.startsWith('WITH')&&q.sql.includes('rental_referral_earning')));assert(p.seen.filter(q=>q.sql.startsWith('WITH')).every(q=>q.args[0]==='self'));assert(!p.seen.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));});
test('separate exact history coverage closes legacy earnings but wallet origin alone never does',async()=>{
 const proof=prepareObservationCoverage({userId:'self',legacyUserId:'11',sourceSystem:'legacy_mysql_restore',sourceKind:'HISTORICAL_DISTRIBUTION',cutoff:'2026-10-04T00:00:00.000Z',inputSha256:'a'.repeat(64),identityDigest:'b'.repeat(64),sourceCount:1,imported:[{sourceId:original.sourceId,sourceDigest:original.sourceDigest}],isolated:[]});
 const c={id:proof.id,source_count:1,imported_count:1,isolated_count:0,cutoff:proof.cutoff,imported_set_digest:proof.importedSetDigest,actual_count:'1',actual_digest:proof.importedSetDigest,invalid_count:'0',outside_count:'0'};
 const p=probe(true,[legacy],'RECONCILED_OPENING',c),r=await readMyDistributionEarnings(p.pool,actor,{state:'ALL',limit:20,cursor:null},key);
 assert.equal(r.knowledge,'KNOWN');assert.equal(r.count,'1');assert.equal(r.items?.[0]?.accountingEffect,'OBSERVATION_ONLY_NO_NEW_CREDIT');
 assert.equal(r.totalAmountKnowledge,'UNKNOWN');assert.equal(r.amountsByOrigin,undefined);assert.equal('projectionVersion' in r,false);assert.equal('currentFinance' in r.items![0]!,false);
 const v2=await readMyDistributionEarnings(p.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key);assert(v2.amountsByOrigin);assert.equal(v2.totalAmountKnowledge,'KNOWN');assert.equal(v2.amountsByOrigin.historical.amountCents,'1234');assert.equal(v2.amountsByOrigin.native.amountCents,'0');assert.equal(v2.amountsByOrigin.scope,'SOURCE_RECORDS_ONLY');
 assert(p.seen.some(q=>q.sql.includes('finance history coverage exact target')&&q.args[0]==='self'&&q.args[1]==='HISTORICAL_DISTRIBUTION'));
 const forged=probe(true,[legacy],'NATIVE_GENESIS'),unknown=await readMyDistributionEarnings(forged.pool,actor,{state:'ALL',limit:20,cursor:null},key);assert.equal(unknown.knowledge,'UNKNOWN');assert.equal(unknown.count,null);
});
test('source-version cursor permits native paging but rejects another session and foreign detail',async()=>{const row={...native,state:'SETTLED',recovery_required_cents:null},p=probe(true,[{...row,id:'native:z'},{...row,id:'native:a'}],'NATIVE_GENESIS'),q={state:'ALL' as const,limit:1,cursor:null};const first=await readMyDistributionEarnings(p.pool,actor,q,key);assert.equal(first.knowledge,'KNOWN');assert.equal(first.count,'2');assert(first.nextCursor);const second=await readMyDistributionEarnings(p.pool,actor,{...q,cursor:first.nextCursor!},key);assert.equal(second.items?.[0]?.id,'native:a');await assert.rejects(readMyDistributionEarnings(p.pool,{...actor,sessionId:'other'},{...q,cursor:first.nextCursor!},key),e=>(e as {status?:number}).status===409);await assert.rejects(readMyDistributionEarnings(p.pool,actor,q,key,'native:foreign'),e=>(e as {status?:number}).status===404);});
test('source amounts are exact and separate from wallet: proved zero is KNOWN, missing history remains UNKNOWN',async()=>{
 const row={...native,id:'native:large',state:'SETTLED',source_amount:'999999999999999999999999',recovery_required_cents:null},p=probe(true,[row],'NATIVE_GENESIS');
 const r=await readMyDistributionEarnings(p.pool,actor,{state:'ALL',limit:1,cursor:null,projectionVersion:2},key);assert(r.amountsByOrigin);assert.equal(r.amountsByOrigin.native.amountCents,row.source_amount);assert.equal(r.amountsByOrigin.historical.amountCents,'0');assert.equal(r.totalAmountKnowledge,'KNOWN');
 const partial=await readMyDistributionEarnings(probe(true,[legacy,row]).pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key);assert(partial.amountsByOrigin);assert.equal(partial.amountsByOrigin.native.amountCents,row.source_amount);assert.equal(partial.amountsByOrigin.historical.amountCents,null);assert.equal(partial.amountsByOrigin.mappedHistoricalAmountCents,'1234');assert.equal(partial.totalAmountKnowledge,'UNKNOWN');
 assert(p.seen.some(q=>q.sql.includes("FILTER(WHERE origin='NATIVE')")&&q.sql.includes("FILTER(WHERE origin='LEGACY_MYSQL')")));
});
test('v1/v2 earnings cursors cannot cross projections and detail keeps the requested version',async()=>{
 const row={...native,state:'SETTLED',recovery_required_cents:null},p=probe(true,[{...row,id:'native:z'},{...row,id:'native:a'}],'NATIVE_GENESIS'),q={state:'ALL' as const,limit:1,cursor:null};
 const v1=await readMyDistributionEarnings(p.pool,actor,q,key),v2=await readMyDistributionEarnings(p.pool,actor,{...q,projectionVersion:2},key);assert(v1.nextCursor&&v2.nextCursor);
 await assert.rejects(readMyDistributionEarnings(p.pool,actor,{...q,cursor:v1.nextCursor,projectionVersion:2},key),(e:any)=>e.status===409);await assert.rejects(readMyDistributionEarnings(p.pool,actor,{...q,cursor:v2.nextCursor},key),(e:any)=>e.status===409);
 const old=await readMyDistributionEarnings(p.pool,actor,q,key,'native:a'),detail=await readMyDistributionEarnings(p.pool,actor,{...q,projectionVersion:2},key,'native:a');assert.equal(old.projectionVersion,undefined);assert.equal('currentFinance' in old.item!,false);assert.equal(detail.projectionVersion,2);assert.equal(detail.item!.currentFinance,null);
});

function frozenCalculationRow(){
 const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
 const basis=freezePaymentDistributionBasis({orderId:'order-1',gameId:'game-1',currency:'CNY',confirmationId:'payment-1',acceptedAt:at,paymentDigest:'a'.repeat(64),admissionId:'admission-1',admissionRevision:'1',origin:'NATIVE',accountMode:'ordinary',estimate:{baseCents:'1908',sourceDigest:'e'.repeat(64)},
  policy:{versionId:'policy-frozen',digest:sha(canonicalize({schema:'distribution-policy.v1',scope:'LOCAL_CONTROLLED',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary'],minimumAccrualCents:'1',settlementDelayDays:0,levels:[{code:'LEVEL_FROZEN',rank:1,default:true,renterPercent:'5',ownerPercent:'5',upgrade:null}]})),config:{schema:'distribution-policy.v1',scope:'LOCAL_CONTROLLED',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary'],minimumAccrualCents:'1',settlementDelayDays:0,levels:[{code:'LEVEL_FROZEN',rank:1,default:true,renterPercent:'5',ownerPercent:'5',upgrade:null}]}},
  facts:[{role:'RENTER_REFERRAL',partyUserId:'PRIVATE_RENTER',relation:{knowledge:'KNOWN_NONE',id:null,childUserId:'PRIVATE_RENTER',parentUserId:null,sourceDigest:null},beneficiary:null},
   {role:'OWNER_REFERRAL',partyUserId:'PRIVATE_OWNER',relation:{knowledge:'KNOWN_PARENT',id:'relation-1',childUserId:'PRIVATE_OWNER',parentUserId:'self',sourceDigest:'c'.repeat(64)},beneficiary:{userId:'self',active:true,eligibility:'ELIGIBLE',commissionFrozen:false,levelCode:'LEVEL_FROZEN'}}]});
 const {digest,...body}=basis,seed={id:'earning-1',beneficiaryUserId:'self',role:'OWNER_REFERRAL',source:{id:'order-1',digest:'b'.repeat(64)},amountCents:'95',policyVersion:'policy-frozen',policyDigest:basis.policyDigest,relationDigest:'c'.repeat(64)};
 const canonical_seed=canonicalize(seed);
 return{id:'earning-1',order_id:'order-1',payment_confirmation_id:'payment-1',beneficiary_user_id:'self',beneficiary_role:'OWNER_REFERRAL',amount_cents:'95',canonical_seed,seed_digest:sha(canonical_seed),basis_digest:digest,posting_digest:'b'.repeat(64),canonical_basis:canonicalize(body),payment_basis_digest:digest,order_number:null};
}

test('U04 detail projects only the beneficiary frozen terms, never internal base or other parties',async()=>{
 const frozen=frozenCalculationRow(),row={...native,id:'native:earning-1',order_id:'order-1',role:'OWNER_REFERRAL',source_amount:'95'};
 for(const number of [null,'ZZ261019-000002']){
  let queries=0;const client={query:async(sql:string,args:unknown[])=>{queries++;assert.deepEqual(args,['self','earning-1']);assert(sql.includes('WHERE e.beneficiary_user_id=$1 AND e.id=$2'));assert(sql.includes('CASE WHEN o.renter_user_id=$1 OR o.owner_user_id=$1 THEN o.display_no ELSE NULL END'));assert(!/platform_contribution_cents|compensation_fee_cents|owner_net_cents|\b(INSERT|UPDATE|DELETE)\b/.test(sql));return{rows:[{...frozen,order_number:number}]};}} as never;
  const result=await readEarningCalculation(client,actor,row,true);assert.equal(queries,1);assert.equal(result.knowledge,'KNOWN');
  if(result.knowledge!=='KNOWN')throw Error('frozen source must be readable');assert.equal(result.percent,'5');assert.equal(result.policyVersion,'policy-frozen');assert.equal(result.beneficiaryLevelCode,'LEVEL_FROZEN');assert.equal(result.orderNumber,number);
  assert(!/PRIVATE_RENTER|PRIVATE_OWNER|1908|canonical_basis|payment_digest|posting_digest|estimateBaseCents/.test(JSON.stringify(result)));
 }
 const noQuery={query:async()=>{throw Error('history or missing schema must not read native basis');}} as never;
 assert.deepEqual(await readEarningCalculation(noQuery,actor,legacy,true),{knowledge:'NOT_RECORDED',reason:'HISTORICAL_CALCULATION_NOT_RECORDED'});
 assert.deepEqual(await readEarningCalculation(noQuery,actor,row,false),{knowledge:'UNKNOWN',reason:'ORIGINAL_BASIS_UNAVAILABLE'});
 for(const source of [null,{...frozen,canonical_basis:null},{...frozen,payment_basis_digest:'f'.repeat(64)},{...frozen,beneficiary_user_id:'other'},{...frozen,seed_digest:'f'.repeat(64)}]){
  const result=await readEarningCalculation({query:async()=>({rows:source?[source]:[]})} as never,actor,row,true);assert.equal(result.knowledge,'UNKNOWN');assert(!('percent' in result));
 }
 const incomplete=JSON.parse(frozen.canonical_basis);incomplete.roles.find((r:any)=>r.role==='OWNER_REFERRAL').levelCode=null;
 const canonical_basis=canonicalize(incomplete),digest=createHash('sha256').update(canonical_basis).digest('hex');
 const missingLevel=await readEarningCalculation({query:async()=>({rows:[{...frozen,canonical_basis,basis_digest:digest,payment_basis_digest:digest}]})} as never,actor,row,true);
 assert.equal(missingLevel.knowledge,'UNKNOWN');assert(!('percent' in missingLevel),'a missing original level never defaults to current 5%');
});

test('U04 lists never query frozen calculations per row, even when native basis is installed',async()=>{
 const p=probe(true,[{...native,state:'SETTLED',recovery_required_cents:null}],'NATIVE_GENESIS',undefined,true);
 await readMyDistributionEarnings(p.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key);
 assert(!p.seen.some(q=>q.sql.includes('WHERE e.beneficiary_user_id=$1 AND e.id=$2')));
});

const duty=(patch:Record<string,any>={})=>({userId:'self',sourceRecordId:original.sourceId,dutyId:'legacy_duty_'+'a'.repeat(40),orderId:'legacy_order_'+'b'.repeat(40),status:'MATURED',amountCents:'900',currency:'CNY',revision:'2',revised:true,maturityAt:'2026-10-05T00:00:00.000000Z',settledBy:null,...patch});
test('current responsibility projects VOID/MATURED/revised duty beside the unchanged original amount and unfinalized finance',async()=>{
 const p=probe(true,[legacy],'RECONCILED_OPENING',undefined,false,{responsibility:[duty()]});
 const r=await readMyDistributionEarnings(p.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key),item=r.items![0] as any;
 assert.equal(item.amount.amountCents,'1234');assert.equal(item.state,'SETTLED');
 assert.equal(item.currentFinance.knowledge,'UNKNOWN');
 assert.equal(item.currentResponsibility.knowledge,'KNOWN');assert.equal(item.currentResponsibility.state,'MATURED');assert.equal(item.currentResponsibility.amountCents,'900');assert.equal(item.currentResponsibility.revised,true);assert.equal(item.currentResponsibility.revision,'2');assert.equal(item.currentResponsibility.maturityAt,'2026-10-05T00:00:00.000000Z');assert.equal(item.currentResponsibility.settledBy,null);
 assert.equal(p.seen.filter(q=>q.sql.includes('own legacy commission current responsibility')).length,1,'one bounded batch read for the page');
 assert(!p.seen.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
 const voided=probe(true,[legacy],'RECONCILED_OPENING',undefined,false,{responsibility:[duty({status:'VOID'})]}),vr=await readMyDistributionEarnings(voided.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key);
 assert.equal((vr.items![0] as any).currentResponsibility.state,'VOID');assert.equal((vr.items![0] as any).currentFinance.knowledge,'UNKNOWN');
 const pending=probe(true,[legacy],'RECONCILED_OPENING',undefined,false,{responsibility:[duty({status:'PENDING',maturityAt:'2020-01-01T00:00:00.000000Z',revised:false,revision:'1'})]}),pr=await readMyDistributionEarnings(pending.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key);
 assert.equal((pr.items![0] as any).currentResponsibility.state,'PENDING');
 const missing=probe(true,[legacy],'RECONCILED_OPENING',undefined,false,{responsibility:[]}),mr=await readMyDistributionEarnings(missing.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key);
 assert.deepEqual((mr.items![0] as any).currentResponsibility,{knowledge:'UNKNOWN',reason:'LEGACY_RESPONSIBILITY_NOT_ASSOCIATED'});
 const foreign=probe(true,[legacy],'RECONCILED_OPENING',undefined,false,{responsibility:[duty({userId:'other'})]}),fr=await readMyDistributionEarnings(foreign.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key);
 assert.equal((fr.items![0] as any).currentResponsibility.knowledge,'UNKNOWN');
 const zero=probe(true,[legacy],'RECONCILED_OPENING',undefined,false,{responsibility:[duty({amountCents:'0'})]}),zr=await readMyDistributionEarnings(zero.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key);
 assert.equal((zr.items![0] as any).currentResponsibility.amountCents,'0');
});
test('detail and list share the same current responsibility while v1 keeps its original payload',async()=>{
 const p=probe(true,[legacy],'RECONCILED_OPENING',undefined,false,{responsibility:[duty()]});
 const list=await readMyDistributionEarnings(p.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key);
 const detail=await readMyDistributionEarnings(p.pool,actor,{state:'ALL',limit:20,cursor:null,projectionVersion:2},key,'history:one');
 assert.deepEqual((detail as any).item.currentResponsibility,(list.items![0] as any).currentResponsibility);
 assert.equal((detail as any).snapshotVersion,list.snapshotVersion);
 assert(p.seen.filter(q=>q.sql.includes('own legacy commission current responsibility')).every(q=>q.args[0]==='self'));
 const v1Before=p.seen.length,v1=await readMyDistributionEarnings(p.pool,actor,{state:'ALL',limit:20,cursor:null},key);
 assert.equal('currentResponsibility' in v1.items![0]!,false);assert.equal('currentFinance' in v1.items![0]!,false);
 assert(!p.seen.slice(v1Before).some(q=>q.sql.includes('own legacy commission current responsibility')),'v1 never reads the v2 responsibility projection');
});
test('a current responsibility version change rejects the old page cursor',async()=>{
 const row={...native,state:'SETTLED',recovery_required_cents:null},rows=[{...row,id:'native:z'},{...row,id:'native:a'}];
 const before=probe(true,rows,'NATIVE_GENESIS',undefined,false,{responsibilityVersion:'a'.repeat(32)});
 const first=await readMyDistributionEarnings(before.pool,actor,{state:'ALL',limit:1,cursor:null,projectionVersion:2},key);assert(first.nextCursor);
 const after=probe(true,rows,'NATIVE_GENESIS',undefined,false,{responsibilityVersion:'b'.repeat(32)});
 await assert.rejects(readMyDistributionEarnings(after.pool,actor,{state:'ALL',limit:1,cursor:first.nextCursor!,projectionVersion:2},key),(e:any)=>e.status===409);
 const same=await readMyDistributionEarnings(before.pool,actor,{state:'ALL',limit:1,cursor:first.nextCursor!,projectionVersion:2},key);assert.equal(same.items![0]?.id,'native:a');
});
