import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {bindReviewedLegacyDutyFinance,finalizeReviewedLegacyDuty,recoverReviewedLegacyDuty,readLegacyDutyFinalization,type LegacyDutyTradeReader,type LegacyDutyFinanceReview} from '../src/finance/legacy-duty-finance-store';
import type {LegacyFinanceDuty,LegacyDutyFinalBasis,LegacyDutyFundingProof} from '../src/finance/legacy-duty-finance';
const sha=(v:unknown)=>createHash('sha256').update(canonicalize(v)).digest('hex'),actor={userId:'fixture-boss',sessionId:'fixture-session',requestId:'fixture-request'},orderId='legacy_order_'+'a'.repeat(40),dutyId='legacy_duty_'+'b'.repeat(40);
const resource={host:'127.0.0.1' as const,port:55432 as const,database:'zzsh_test_order_duty_fixture',oid:42,owner:'fixture_owner',marker:'zzsh:order-reservation-test:v1',role:'fixture_owner',roleOid:43};
function fixture(amount='8200'){
 const duty:LegacyFinanceDuty={id:dutyId,orderId,kind:'RENTER_REFUND',sourceRecordId:'confirm-v1',counterpartyUserId:'renter',amountCents:amount,currency:'CNY',revision:'2',status:'PENDING',source:'CONTINUATION',sourceStatus:null,continuationVersionId:'confirm-v1',admissionId:null,maturityAt:null,settledBy:null,settledRefType:null,settledRefId:null,settledRefDigest:null};
 const basis:LegacyDutyFinalBasis={kind:'CONFIRMED_CONTINUATION',dutyId,orderId,dutyKind:duty.kind,sourceRecordId:duty.sourceRecordId,subjectId:'renter',amountCents:amount,currency:'CNY',dutyRevision:'2',parentSourceDigest:'1'.repeat(64),parentSourceId:'101',sourceRecordEntity:'legacy_continuation_version',sourceRecordDigest:'2'.repeat(64),basisFactsDigest:'3'.repeat(64),evidenceId:'result-1',evidenceDigest:'4'.repeat(64),continuationVersionId:'confirm-v1',admissionId:null,effectiveHeadId:'release-v2',effectiveHeadRevision:'2',sourceTimeKind:'CONFIRMED_AT',sourceTime:'2026-10-01T00:00:00.000000Z',maturityAt:null,finalAmountKnown:true,netRefundKnown:true,currentNetRefundCents:amount,fundsDisposition:'AVAILABLE'};
 const emptyDigest=createHash('sha256').update('').digest('hex'),witness={openingBasisId:'basis-fixture',openingSourceDigest:'9'.repeat(64),coveredSetDigest:'0'.repeat(64),historyCoverageVersion:'history_fixture:'+emptyDigest,historyReferenceDigest:emptyDigest,historyCutoff:'2026-09-13T13:31:22.000Z',sourceCount:'0'};
 const funding:LegacyDutyFundingProof={contractVersion:'legacy-duty-finance.v1',dutyId,orderId,kind:duty.kind,subjectId:'renter',amountCents:amount,currency:'CNY',originalSourceSystem:'legacy_mysql_restore',originalSourceEntity:'la_order',originalSourceId:'101',originalSourceDigest:basis.parentSourceDigest,originalOrderNumber:'FIXTURE',finalEvidenceDigest:basis.evidenceDigest,coverageDecision:'NOT_PREVIOUSLY_CREDITED',coverageEvidenceDigest:sha(witness),sourceStatus:'CONFIRMED_UNPAID_LIABILITY',evidenceRef:basis.evidenceId,witness};
 const input={dutyId,expectedRevision:'2',expectedEvidenceDigest:basis.evidenceDigest,expectedAmountCents:amount},review:LegacyDutyFinanceReview={ref:'FIXTURE-NOT-APPROVAL',attempt:'fixture-1',actor:{userId:actor.userId,sessionId:actor.sessionId},resource:{...resource},notBefore:'2026-10-15T08:00:00.000Z',expiresAt:'2026-10-15T09:00:00.000Z',contractVersion:'legacy-duty-finance.v1',orderId,inputDigest:sha(input),funding};
 const state={duty,queries:[] as {sql:string;args:any[]}[],fact:null as any,lines:[] as any[],receipts:new Map<string,any>(),audit:false,covered:false,enabled:true,known:true,identity:true,now:'2026-10-15T08:30:00.000Z',extraSubject:false};
 const query=async(sql:string,args:any[]=[])=>{
  state.queries.push({sql,args});
  if(sql.includes('finance-opening resource'))return{rows:[{...resource,now:state.now,tableOwner:resource.role}],rowCount:1};
  if(sql.includes('legacy duty finance schema'))return{rows:[{ready:true}],rowCount:1};
  if(sql.includes('legacy duty finance contract'))return{rows:[{contract_version:'legacy-duty-finance.v1',enabled:state.enabled}],rowCount:1};
  if(sql.includes('legacy funding immutable opening'))return{rows:[{id:witness.openingBasisId,source_system:'legacy_mysql_restore',source_id:'11',source_digest:witness.openingSourceDigest,covered_set_digest:witness.coveredSetDigest,cutoff:witness.historyCutoff}],rowCount:1};
  if(sql.includes('legacy reviewed source proof contract'))return{rows:[{ready:false}],rowCount:1};
  if(sql.includes('finance history coverage installed'))return{rows:[{installed:true}],rowCount:1};
  if(sql.includes('finance history coverage exact target'))return{rows:[{id:'history_fixture',source_count:0,imported_count:0,isolated_count:0,imported_set_digest:emptyDigest,actual_count:'0',actual_digest:emptyDigest,invalid_count:'0',outside_count:'0',cutoff:witness.historyCutoff}],rowCount:1};
  if(sql.includes('legacy funding original order identity'))return{rows:[{legacy_id:'101',original_order_no:'FIXTURE'}],rowCount:1};
  if(sql.includes('legacy funding covered responsibility'))return{rows:state.covered?[{}]:[],rowCount:state.covered?1:0};
  if(sql.includes('legacy funding complete earning references')||sql.includes('legacy funding other final responsibility'))return{rows:[],rowCount:0};
  if(sql.includes('s."locked",u."twoFactorEnabled"'))return{rows:state.identity?[{locked:false,twoFactorEnabled:true}]:[],rowCount:state.identity?1:0};
  if(sql.includes('admin_security'))return{rows:[{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}],rowCount:1};
  if(sql.includes('SELECT suspended'))return{rows:[{suspended:false}],rowCount:1};
  if(sql.includes('legacy duty subject prefix'))return{rows:[{id:dutyId,counterparty_user_id:state.duty.counterpartyUserId}],rowCount:1};
  if(sql.startsWith('SELECT id FROM zzsh_auth_user'))return{rows:(args[0] as string[]).map(id=>({id})),rowCount:args[0].length};
  if(sql.includes('legacy duty opening exclusion'))return{rows:state.covered?[{}]:[],rowCount:state.covered?1:0};
  if(sql.includes('clock_timestamp() AT TIME ZONE'))return{rows:[{now:'2026-10-15T08:30:00.000000Z'}],rowCount:1};
  if(sql.includes('"requestFingerprint"')){const r=state.receipts.get(args[1]);return{rows:r?[{requestFingerprint:r.fingerprint,responseStatus:r.status,responseBody:r.body,publishRequired:false}]:[],rowCount:r?1:0};}
  if(sql.includes('request_fingerprint AS fingerprint')){const r=state.receipts.get(args[1]);return{rows:r?[r]:[],rowCount:r?1:0};}
  if(sql.includes('INSERT INTO zzsh_order.legacy_duty_finance_fact'))state.fact={duty_id:args[0],root_id:args[2],event_id:args[3],event_kind:'LEGACY_DUTY_SETTLED',ref_type:args[15],ref_id:args[16],facts_canonical:args[17],facts_digest:args[18]};
  if(sql.includes('INSERT INTO zzsh_order.finance_economic_root'))Object.assign(state.fact,{root_kind:'LEGACY_CONTINUATION_DUTY',root_type:'LEGACY_CONTINUATION',root_system:'zzsh',root_entity:'legacy_order_duty',root_source:args[1],root_subject:args[2],root_role:args[3],root_digest:args[4],root_policy:null,basis_id:null});
  if(sql.includes('INSERT INTO zzsh_order.finance_event'))state.fact.event_subject=args[2];
  if(sql.includes('INSERT INTO zzsh_order.settlement_ledger_entry'))state.lines.push({id:args[0],line:args[2],account:args[3],debit:args[4],credit:args[5],subject:args[6],details:JSON.parse(args[7])});
  if(sql.startsWith('UPDATE zzsh_order.legacy_order_duty')){Object.assign(state.duty,{status:'SETTLED',settledBy:'FINANCE',settledRefType:args[1],settledRefId:args[2],settledRefDigest:args[3],revision:(BigInt(state.duty.revision)+1n).toString()});return{rows:[],rowCount:1};}
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"'))state.audit=true;
  if(sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"'))state.receipts.set(args[1],{fingerprint:args[2],status:args[3],body:JSON.parse(args[4])});
  if(sql.includes('legacy duty original final facts'))return{rows:state.fact?[state.fact]:[],rowCount:state.fact?1:0};
  if(sql.startsWith('SELECT id,line_no AS line'))return{rows:state.lines,rowCount:state.lines.length};
  if(sql.startsWith('SELECT 1 FROM zzsh_iam.audit_event'))return{rows:state.audit?[{}]:[],rowCount:state.audit?1:0};
  return{rows:sql.includes('wallet_revision')?[{ledger_revision:'0'}]:[],rowCount:1};
 };
 const client={query,connectionParameters:{host:resource.host,port:resource.port,database:resource.database,user:resource.role}} as any;
 const trade:LegacyDutyTradeReader={readBinding:async()=>({id:orderId,legacyId:'101',gameId:'game',accountId:'account',ownerUserId:'owner',renterUserId:'renter',sourceDigest:basis.parentSourceDigest}),lockOrder:async()=>{await query('/* T common advisory -> head -> duty lock */');return{head:{id:basis.effectiveHeadId},duties:[{...state.duty,...(state.extraSubject?{counterpartyUserId:'new-third-party'}:{})}]};},readFinalBasis:async()=>state.known?{knowledge:'KNOWN',basis}:{knowledge:'UNKNOWN',reason:'FINAL_AMOUNT_MISSING'}};
 return{state,client,trade,input,review};
}
test('actual finance writer uses all-party prefix then T common lock, exact positive ledger and original idempotent receipt',async()=>{
 const f=fixture(),s=await bindReviewedLegacyDutyFinance(f.client,actor,f.review),result=await finalizeReviewedLegacyDuty(f.client,actor,f.input,s,f.trade);
 assert.equal(result.status,200);assert.equal(f.state.lines[1].credit,'8200');assert.equal(f.state.lines[1].account,'RENTER_REFUND_PAYABLE');
 const users=f.state.queries.findIndex(q=>q.sql.includes('ORDER BY id FOR UPDATE')),account=f.state.queries.findIndex(q=>q.sql.includes('rental_account WHERE')),shared=f.state.queries.findIndex(q=>q.sql.includes('T common advisory'));assert(users>=0&&users<account&&account<shared);assert.deepEqual(f.state.queries[users]!.args[0],['owner','renter']);
 const count=f.state.queries.filter(q=>q.sql.startsWith('INSERT INTO zzsh_order.')).length;await finalizeReviewedLegacyDuty(f.client,actor,f.input,s,f.trade);assert.equal(f.state.queries.filter(q=>q.sql.startsWith('INSERT INTO zzsh_order.')).length,count);
 assert.equal(await readLegacyDutyFinalization(f.client,orderId,[f.state.duty]),'POSTED_POSITIVE_REFUND');
 const recovered=await recoverReviewedLegacyDuty(f.client,actor,f.input,s,f.trade);assert.equal(recovered.knowledge,'KNOWN');
});
test('zero finalization actually writes an event and no ledger, and original ref tampering is rejected on replay',async()=>{
 const f=fixture('0'),s=await bindReviewedLegacyDutyFinance(f.client,actor,f.review);await finalizeReviewedLegacyDuty(f.client,actor,f.input,s,f.trade);assert.equal(f.state.lines.length,0);assert.equal(f.state.duty.settledRefType,'FINANCE_EVENT');assert.equal(await readLegacyDutyFinalization(f.client,orderId,[f.state.duty]),'FINALIZED_ZERO');
 f.state.duty.settledRefDigest='f'.repeat(64);await assert.rejects(finalizeReviewedLegacyDuty(f.client,actor,f.input,s,f.trade),(e:any)=>e.status===409);
});
test('changed subject set, existing opening coverage, UNKNOWN final basis and cloned authority reject before economic inserts',async()=>{
 for(const key of ['extraSubject','covered','known'] as const){const f=fixture();f.state[key]=key==='known'?false:true;const s=await bindReviewedLegacyDutyFinance(f.client,actor,f.review);await assert.rejects(finalizeReviewedLegacyDuty(f.client,actor,f.input,s,f.trade));assert(!f.state.queries.some(q=>q.sql.startsWith('INSERT INTO zzsh_order.')));}
 const f=fixture(),s=await bindReviewedLegacyDutyFinance(f.client,actor,f.review);await assert.rejects(finalizeReviewedLegacyDuty(f.client,actor,f.input,{...s},f.trade));assert.equal(f.state.fact,null);
});
test('current authority/resource/window remain required for original receipt and missing receipt never replays',async()=>{
 const f=fixture(),s=await bindReviewedLegacyDutyFinance(f.client,actor,f.review,'recover'),result=await recoverReviewedLegacyDuty(f.client,actor,f.input,s,f.trade);assert.equal(result.knowledge,'UNKNOWN');assert.equal(result.receipt,null);assert(!f.state.queries.some(q=>q.sql.startsWith('INSERT')));await assert.rejects(finalizeReviewedLegacyDuty(f.client,actor,f.input,s,f.trade),(e:any)=>e.status===403);
 f.state.identity=false;await assert.rejects(recoverReviewedLegacyDuty(f.client,actor,f.input,s,f.trade),(e:any)=>e.status===401);
 const g=fixture();g.state.enabled=false;await assert.rejects(bindReviewedLegacyDutyFinance(g.client,actor,g.review),(e:any)=>e.status===503);
});
