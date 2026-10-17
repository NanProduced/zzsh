import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {prepareFrozenFinanceObservation,previewFrozenFinanceObservation,prepareFrozenFinanceHistory,prepareStoredOpeningCandidate} from '../src/finance/legacy-finance-source-preparation';
import {planFinanceObservations} from '../src/finance/personal-finance-observation-maintenance';
const subject={userId:'fixture-user',legacyUserId:'11',identityDigest:'a'.repeat(64)},cutoff='2026-09-13T13:31:22.000Z',inputSha256='b'.repeat(64);
const log={id:101,sn:'FIXTURE-LOG-NOT-BUSINESS-NUMBER',action:1,amount:'1.10',userId:11,sourceId:501,createdAt:1779469800,changeType:1001,leftAmount:'1.10'};
const withdrawal={id:201,sn:'FIXTURE-WITHDRAWAL',type:1,money:'5.00',status:2,userId:11,batch_no:'FIXTURE',is_delete:0,left_money:'4.50',create_time:1779469800,handling_fee:'0.50',payment_time:1779469900};
test('raw frozen earnings retain their own log number and unknown economic source; typed ID or 1001 alone never proves an order',()=>{
 const p=prepareFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',log,subject);assert.equal(p.row.sourceId,101);assert.equal(p.row.referenceId,'501');assert.equal(p.row.referenceSn,null);assert.equal(p.row.referenceType,'UNRESOLVED_ECONOMIC_SOURCE');assert.equal(p.financialSource,'UNKNOWN');assert.equal(p.row.legacyLogNumber,log.sn);assert.equal((p.row.rawSource as any).digest,createHash('sha256').update(canonicalize(log)).digest('hex'));
 for(const raw of [{...log,userId:12},{...log,amount:'1.001'},{...log,id:9007199254740992},{...log,action:3},{...log,createdAt:0},{...log,phone:'not-a-finance-input'}])assert.throws(()=>prepareFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',raw,subject));
});
test('original withdrawal gross, fee and net are separate source values; mismatches and historical paid marks never become a new debit or arrival',()=>{
 const p=prepareFrozenFinanceObservation('HISTORICAL_WITHDRAWAL',withdrawal,subject);assert.equal(p.row.amount,'5.00');assert.equal(p.row.fee,'0.50');assert.equal(p.row.net,'4.50');assert.equal(p.row.sourceStatus,2);assert.equal(p.financialSource,'OBSERVATION_ONLY');
 const mismatch=prepareFrozenFinanceObservation('HISTORICAL_WITHDRAWAL',{...withdrawal,left_money:'4.00'},subject);assert.equal(mismatch.row.net,'4.00');assert.deepEqual(mismatch.row.sourceAnomalies,['SOURCE_GROSS_FEE_NET_MISMATCH']);
 const negative=prepareFrozenFinanceObservation('HISTORICAL_WITHDRAWAL',{...withdrawal,left_money:'-1.00',handling_fee:'6.00'},subject);assert.equal(negative.row.net,'-1.00');assert.deepEqual(negative.row.sourceAnomalies,['NEGATIVE_SOURCE_NET']);assert.throws(()=>prepareFrozenFinanceObservation('HISTORICAL_WITHDRAWAL',{...withdrawal,status:6},subject));
});
test('full source set prepares the existing importer unchanged; complete zero and isolated sources have distinct proofs',()=>{
 const body=prepareFrozenFinanceHistory({subject,sourceKind:'HISTORICAL_WITHDRAWAL',inputSha256,cutoff,sourceCount:1,rows:[withdrawal],isolated:[]}),p=planFinanceObservations(body);assert.equal(p.coverage.importedCount,1);assert.equal(p.observations[0]!.includedInOpening,false);
 const zero=prepareFrozenFinanceHistory({subject,sourceKind:'HISTORICAL_EARNINGS_LOG',inputSha256,cutoff,sourceCount:0,rows:[],isolated:[]});assert.equal(planFinanceObservations(zero).coverage.sourceCount,0);
 const isolated=prepareFrozenFinanceHistory({subject,sourceKind:'HISTORICAL_EARNINGS_LOG',inputSha256,cutoff,sourceCount:1,rows:[],isolated:[{sourceId:'501',sourceDigest:'c'.repeat(64),reason:'SOURCE_RELATION_UNRESOLVED'}]});assert.equal(planFinanceObservations(isolated).coverage.isolatedCount,1);
 assert.throws(()=>prepareFrozenFinanceHistory({subject,sourceKind:'HISTORICAL_WITHDRAWAL',inputSha256,cutoff,sourceCount:2,rows:[withdrawal],isolated:[]}));
});
test('stored candidate uses original earnings and ordered old digest; money, duplicate-selected identity and unresolved logs never silently become wallet credit',()=>{
 const source={id:'11',earnings:'1.10',money:'-2.00'},candidate={legacyId:'11',targetUserId:subject.userId,storedEarningsCents:'110',storedMoneyCents:'-200',sourceDigest:createHash('sha256').update(JSON.stringify(source)).digest('hex'),admission:'MAPPED_PENDING_BATCH_APPROVAL' as const};
 const input={subject,source,candidate,inputSha256,cutoff,covered:[],observations:[],included:[]},p=prepareStoredOpeningCandidate(input);assert.equal(p.state,'CANDIDATE');if(p.state==='CANDIDATE'){assert.equal(p.executable,false);assert.equal(p.input.proof.availableCents,'110');assert.equal(p.input.proof.coveredCount,0);assert.equal(p.input.sourceCanonical,canonicalize(source));}
 for(const admission of ['IDENTITY_ISOLATED','DUPLICATE_SELECTED_SEPARATE_REVIEW'] as const)assert.equal(prepareStoredOpeningCandidate({...input,candidate:{...candidate,admission}}).state,'REVIEW_REQUIRED');
 const unresolved=prepareFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',log,subject);assert.equal(prepareStoredOpeningCandidate({...input,observations:[unresolved.row]}).state,'REVIEW_REQUIRED');
 assert.throws(()=>prepareStoredOpeningCandidate({...input,source:{...source,earnings:'2.00'}}));assert.throws(()=>prepareStoredOpeningCandidate({...input,subject:{...subject,userId:'another-subject'}}));
});
test('completed distribution keeps original order type/level/status and never uses the pending subset as full coverage',()=>{
 const raw={id:'501',sn:'FIXTURE-DIST',user_id:'11',order_type:'1',order_id:'71',earnings:'1.10',level:'2',level_id:'1',ratio:'5.00',status:'2',settle_time:'1779469800',is_delete:'0',create_time:'1779460000',update_time:'1779469800'};
 const p=prepareFrozenFinanceObservation('HISTORICAL_DISTRIBUTION',raw,subject);assert.equal(p.row.sourceStatus,2);assert.equal(p.row.level,2);assert.equal(p.row.orderId,71);assert.equal(p.row.sourceNumber,raw.sn);assert.equal(p.financialSource,'OBSERVATION_ONLY');assert.throws(()=>prepareFrozenFinanceObservation('HISTORICAL_DISTRIBUTION',{...raw,level:'4'},subject));
});

test('source-only preview retains the exact numeric frozen distribution and missing ratio without inventing identity audit or import authority',()=>{
 const mapped={userId:subject.userId,legacyUserId:subject.legacyUserId},raw={id:501,sn:'FIXTURE-DIST',user_id:11,order_type:1,order_id:71,earnings:'1.10',level:2,level_id:1,status:2,settle_time:1779469800,is_delete:0,create_time:1779460000,update_time:1779469800};
 const p=previewFrozenFinanceObservation('HISTORICAL_DISTRIBUTION',raw,mapped);assert.equal(p.row.sourceRatio,null);assert.equal(p.row.sourceStatus,2);assert.equal(p.row.amount,'1.10');assert.equal(p.executable,false);assert.equal(p.identityAudit,'UNBOUND');assert.equal((p.row.rawSource as any).canonical,canonicalize(raw));assert.equal((p.row.rawSource as any).digest,createHash('sha256').update(canonicalize(raw)).digest('hex'));
 assert.throws(()=>planFinanceObservations(p as any));
 const noAudit=mapped as typeof subject;assert.throws(()=>prepareFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',log,noAudit),/identity binding/);assert.throws(()=>prepareFrozenFinanceHistory({subject:noAudit,sourceKind:'HISTORICAL_EARNINGS_LOG',inputSha256,cutoff,sourceCount:1,rows:[log],isolated:[]}),/identity binding/);
 for(const changed of [{...raw,user_id:12},{...raw,id:9007199254740992},{...raw,password:'forbidden'},{...raw,earnings:'1.001'}])assert.throws(()=>previewFrozenFinanceObservation('HISTORICAL_DISTRIBUTION',changed,mapped));
});
test('source preview reuses original earnings and withdrawal conversion without guessing a credited economic root',()=>{
 const mapped={userId:subject.userId,legacyUserId:subject.legacyUserId},p=previewFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',log,mapped),w=previewFrozenFinanceObservation('HISTORICAL_WITHDRAWAL',withdrawal,mapped);
 assert.equal(p.row.referenceType,'UNRESOLVED_ECONOMIC_SOURCE');assert.equal(p.financialSource,'UNKNOWN');assert.equal(p.executable,false);assert.equal(w.row.amount,'5.00');assert.equal(w.row.net,'4.50');assert.equal(w.executable,false);assert.equal(w.identityAudit,'UNBOUND');
});

function openingLogFixture(){
 const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
 const original={id:'501',sn:'DIST-ORIGINAL',user_id:'11',order_type:'1',order_id:'71',earnings:'1.10',level:'2',level_id:'2',ratio:'10',status:'2',settle_time:String(log.createdAt),is_delete:'0',create_time:'1779460000',update_time:String(log.createdAt)};
 const economic={sourceKind:'LEGACY_DISTRIBUTION_EARNING',sourceEntity:'la_distribution_order',sourceId:'501',beneficiaryRole:'RENTER_REFERRAL',sourceEventAt:String(log.createdAt),sourceCanonical:canonicalize(original),sourceDigest:sha(canonicalize(original))};
 const observed=prepareFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',log,subject),source={id:'11',earnings:'1.10',money:'0.00'};
 const binding={observationId:observed.sourceId,observationDigest:observed.sourceDigest,sourceKind:economic.sourceKind,sourceEntity:economic.sourceEntity,sourceId:economic.sourceId,beneficiaryRole:economic.beneficiaryRole,sourceDigest:economic.sourceDigest};
 return{subject,source,candidate:{legacyId:'11',targetUserId:subject.userId,storedEarningsCents:'110',storedMoneyCents:'0',sourceDigest:sha(JSON.stringify(source)),admission:'MAPPED_PENDING_BATCH_APPROVAL' as const},inputSha256,cutoff,covered:[economic],observations:[observed.row],included:['la_log_earnings:101'],logBindings:[binding]};
}

test('an exact separate economic binding closes the stored candidate without rewriting an already imported log',()=>{
 const x=openingLogFixture(),original=canonicalize(x.observations[0]),p=prepareStoredOpeningCandidate(x);assert.equal(p.state,'CANDIDATE');
 if(p.state==='CANDIDATE'){assert.equal(p.input.proof.availableCents,'110');assert.equal(p.input.proof.coveredCount,1);assert.equal(p.input.admissions[0]!.included,true);assert.equal(canonicalize(p.input.observations[0]),original);assert.equal(p.input.observations[0]!.referenceType,'UNRESOLVED_ECONOMIC_SOURCE');}
 assert.equal(canonicalize(x.observations[0]),original);assert.equal(prepareStoredOpeningCandidate({...x,logBindings:[]}).state,'REVIEW_REQUIRED');
});

test('opening bindings reject changed original observation bytes, direction, source tuple, or duplicated proof',()=>{
 for(const change of [
  (x:ReturnType<typeof openingLogFixture>)=>x.logBindings[0]!.observationDigest='0'.repeat(64),
  (x:ReturnType<typeof openingLogFixture>)=>x.logBindings[0]!.sourceDigest='0'.repeat(64),
  (x:ReturnType<typeof openingLogFixture>)=>x.logBindings[0]!.sourceKind='LEGACY_ADMIN_LOG',
  (x:ReturnType<typeof openingLogFixture>)=>x.observations[0]!.action=2,
  (x:ReturnType<typeof openingLogFixture>)=>x.observations[0]!.sourceUserId=12,
  (x:ReturnType<typeof openingLogFixture>)=>x.logBindings.push({...x.logBindings[0]!}),
 ]){const x=openingLogFixture();change(x);assert.throws(()=>prepareStoredOpeningCandidate(x));}
 assert.throws(()=>prepareStoredOpeningCandidate({...openingLogFixture(),logBindings:{} as never}));
});

test('rehashing a foreign, pending, wrongly valued or wrongly classified source cannot prove a stored credit',()=>{
 for(const change of [
  (r:Record<string,unknown>)=>r.user_id='12',
  (r:Record<string,unknown>)=>r.earnings='2.20',
  (r:Record<string,unknown>)=>r.status='1',
  (r:Record<string,unknown>)=>r.level='3',
  (r:Record<string,unknown>)=>r.settle_time='0',
 ]){const x=openingLogFixture(),r=JSON.parse(x.covered[0]!.sourceCanonical);change(r);x.covered[0]!.sourceCanonical=canonicalize(r);x.covered[0]!.sourceDigest=createHash('sha256').update(canonicalize(r)).digest('hex');x.logBindings[0]!.sourceDigest=x.covered[0]!.sourceDigest;assert.throws(()=>prepareStoredOpeningCandidate(x));}
 const admin=openingLogFixture();admin.covered[0]!.sourceKind='LEGACY_ADMIN_LOG';admin.covered[0]!.sourceEntity='la_log_earnings';admin.covered[0]!.beneficiaryRole='WALLET_HOLDER';Object.assign(admin.logBindings[0]!,{sourceKind:'LEGACY_ADMIN_LOG',sourceEntity:'la_log_earnings',beneficiaryRole:'WALLET_HOLDER'});assert.throws(()=>prepareStoredOpeningCandidate(admin));
});

test('multiple plausible roots and two original logs for one economic root remain rejected',()=>{
 const ambiguous=openingLogFixture(),order={id:'501',sale_user_id:'11',order_status:'4',pay_is:'1',sale_earnings:'1.10',full_payout_money:'0.00',confirm_time:String(log.createdAt)};
 ambiguous.covered.push({sourceKind:'LEGACY_RENTAL_OWNER_INCOME',sourceEntity:'la_order',sourceId:'501',beneficiaryRole:'OWNER',sourceEventAt:String(log.createdAt),sourceCanonical:canonicalize(order),sourceDigest:createHash('sha256').update(canonicalize(order)).digest('hex')});assert.throws(()=>prepareStoredOpeningCandidate(ambiguous),/missing or ambiguous/);
 const duplicate=openingLogFixture(),second=prepareFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',{...log,id:102},subject);duplicate.observations.push(second.row);duplicate.included.push('la_log_earnings:102');duplicate.logBindings.push({...duplicate.logBindings[0]!,observationId:second.sourceId,observationDigest:second.sourceDigest});assert.throws(()=>prepareStoredOpeningCandidate(duplicate),/more than one log/);
 const repeated=openingLogFixture();repeated.covered.push({...repeated.covered[0]!});assert.throws(()=>prepareStoredOpeningCandidate(repeated),/Duplicate economic root/);
});

test('a zero stored balance can cover original owner income and an already deducted withdrawal without a new debit',()=>{
 const sha=(x:string)=>createHash('sha256').update(x).digest('hex'),base=openingLogFixture(),source={id:'11',earnings:'0.00',money:'0.00'};
 const order={id:'501',sale_user_id:'11',order_status:'4',pay_is:'1',sale_earnings:'1.10',full_payout_money:'0.00',confirm_time:String(log.createdAt)};
 const paidWithdrawal={...withdrawal,money:'1.10',status:3,left_money:'1.00',handling_fee:'0.10'},debit=prepareFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',{...log,id:102,sourceId:paidWithdrawal.id,action:2,changeType:1002,leftAmount:'0.00'},subject);
 const covered=[{sourceKind:'LEGACY_RENTAL_OWNER_INCOME',sourceEntity:'la_order',sourceId:'501',beneficiaryRole:'OWNER',sourceEventAt:String(log.createdAt),sourceCanonical:canonicalize(order),sourceDigest:sha(canonicalize(order))},{sourceKind:'LEGACY_WITHDRAWAL',sourceEntity:'la_withdraw_apply',sourceId:String(paidWithdrawal.id),beneficiaryRole:'WALLET_HOLDER',sourceEventAt:String(paidWithdrawal.create_time),sourceCanonical:canonicalize(paidWithdrawal),sourceDigest:sha(canonicalize(paidWithdrawal))}];
 const observations=[base.observations[0]!,debit.row],logBindings=covered.map((r,i)=>({observationId:String(observations[i]!.sourceId),observationDigest:sha(canonicalize(observations[i])),sourceKind:r.sourceKind,sourceEntity:r.sourceEntity,sourceId:r.sourceId,beneficiaryRole:r.beneficiaryRole,sourceDigest:r.sourceDigest}));
 const p=prepareStoredOpeningCandidate({...base,source,candidate:{...base.candidate,storedEarningsCents:'0',sourceDigest:sha(JSON.stringify(source))},covered,observations,logBindings,included:['la_log_earnings:101','la_log_earnings:102']});assert.equal(p.state,'CANDIDATE');if(p.state==='CANDIDATE'){assert.equal(p.input.proof.availableCents,'0');assert.equal(p.input.proof.coveredCount,2);assert(p.input.admissions.every(a=>a.included));}
});

/* ---- FIN-ORDER-2: formal batch assembly + preflight, consumed only by the existing order commands ---- */
import type {PoolClient as FoPoolClient} from 'pg';
import {assembleLegacyLiabilityBatch as foLiability,assembleLegacyCompletedCommissionBatch as foCommission,type LegacyParentTargetFact as FoParent,type LegacyLiabilitySourceRow as FoLiabilityRow,type LegacyCommissionSourceRow as FoCommissionRow,type LegacyCurrentTargetFact as FoCurrent} from '../src/finance/legacy-finance-source-preparation';
import {importLegacyHistoricalLiability as foImportLiability} from '../src/order/legacy-liability-intake';
import {importLegacyCompletedCommission as foImportCommission} from '../src/order/legacy-continuation-evidence';
import {legacyOwnerUserId as foOwner} from '../src/supply/legacy-user-migration';
import {legacyBinding as foBinding} from './legacy-continuation-fixture';
const foSha=(s:string)=>createHash('sha256').update(s).digest('hex'),foMapped=(id:string)=>'legacy_order_'+foSha(JSON.stringify(['legacy_mysql_restore','la_order',id])).slice(0,40);
const foActor={realm:'admin' as const,userId:'fixture_admin',sessionId:'fixture_session',requestId:'req_fixture'};
const foCompletedAt='2026-10-01T01:02:03.000000Z',foCutoff='2026-10-16T00:00:00.000000Z',foConfirm=String(Date.parse(foCompletedAt)/1000);
function foParent(id:string,snap:Record<string,string|null>,completedAt:string|null=null):FoParent{const s={id,...snap};return{legacyId:id,parentOrderId:foMapped(id),sourceDigest:foSha(canonicalize(s)),bindingDigest:'d'.repeat(64),sourceSnapshot:s,sourceCompletedAt:completedAt,ownerUserId:foOwner('legacy_mysql_restore','la_user','22'),renterUserId:foOwner('legacy_mysql_restore','la_user','11'),accountId:'fixture_account'};}
const foSnap={'COMPLETED_UNREFUNDED':{order_status:'4',pay_is:'1',is_settle:'0',return_order_money:'87.00',deposit_amount:'57.00'},'DETAINED':{order_status:'4',pay_is:'1',is_settle:'2',return_order_money:'87.00',deposit_amount:'57.00'},'POSTED_CONFISCATION':{order_status:'4',pay_is:'1',is_settle:'3',return_order_money:'87.00',deposit_amount:'57.00'},'REFUND_RECORD_EXISTS':{order_status:'5',pay_is:'1',is_settle:'0',return_order_money:'87.00',deposit_amount:'57.00'}} as const;
function foRow(id:string,classification:FoLiabilityRow['classification'],patch:Record<string,string|null>={}):FoLiabilityRow{return{classification,legacyOrderId:id,mappedOrderId:foMapped(id),originalOrder:{id,...foSnap[classification],detain_money:'5.00',unrelated_column:'x',...patch},refundRecord:classification==='REFUND_RECORD_EXISTS'?{id:'9'+id,order_id:id,status:'SOURCE_UNKNOWN'}:null,evidenceRef:'FIXTURE_A_LIABILITY'};}
function foMocks(t:import('node:test').TestContext,permissions=['supply.catalog.manage','order.read'],isBoss=true){
 const auth:typeof import('../src/auth/auth-security')=require('../src/auth/auth-security'),access:typeof import('../src/auth/admin-authorization')=require('../src/auth/admin-authorization');
 t.mock.method(auth,'assertAdminContextInTransaction',async()=>{});t.mock.method(access,'loadEffectiveAdminAccess',async()=>({status:'ACTIVE',isBoss,passwordChangeRequired:false,permissions:new Set(permissions)}));
}
function foLiabilityClient(t:import('node:test').TestContext,p:FoParent,stage:number,idem:{fingerprint:string;body:unknown}|null=null){
 const e:typeof import('../src/order/legacy-continuation-evidence')=require('../src/order/legacy-continuation-evidence');
 t.mock.method(e,'readLegacyContinuationBinding',async()=>({...foBinding,id:p.parentOrderId,legacyId:p.legacyId,sourceOrderStatus:stage,sourceDigest:p.sourceDigest}));t.mock.method(e,'lockLegacyContinuationOrder',async()=>({head:null,duties:[]}));
 const calls:Array<{sql:string;v:unknown[]}>=[];const client={query:async(sql:string,v:unknown[]=[])=>{calls.push({sql,v});
  if(sql.includes('"idempotency_record" WHERE'))return{rows:idem?[{requestFingerprint:idem.fingerprint,responseStatus:200,responseBody:idem.body,publishRequired:false}]:[],rowCount:idem?1:0};
  return{rows:sql.includes('source_snapshot AS source')?[{source:p.sourceSnapshot,deposit:'5700'}]:[],rowCount:0};}} as unknown as FoPoolClient;
 return{calls,client};
}
const foDutyInsert=(calls:Array<{sql:string;v:unknown[]}>)=>calls.filter(c=>c.sql.includes('INSERT INTO zzsh_order.legacy_order_duty('));

test('FIN-ORDER-2 86 assembly: 18/1 net refund duty, 6 LEGACY_RECORDS terminal, 61 record-only; never admitted or writable without the current target read; amounts conserved',()=>{
 const groups:[FoLiabilityRow['classification'],string[]][]=[['COMPLETED_UNREFUNDED',['101','102']],['DETAINED',['201']],['POSTED_CONFISCATION',['301']],['REFUND_RECORD_EXISTS',['401','402']]];
 const rows=groups.flatMap(([c,ids])=>ids.map(id=>foRow(id,c))),parents=groups.flatMap(([c,ids])=>ids.map(id=>foParent(id,foSnap[c])));
 const a=foLiability({batchId:'fixture-86',parents,current:null,rows});
 assert.equal(a.writeAllowed,false);assert.equal(a.conserved,true);assert.deepEqual(a.counts,{ADMISSION_CANDIDATE:3,ALREADY_APPLIED:0,MISSING_FACT:0,CONFLICT:0,LEGACY_TERMINAL:1,OBSERVE_ONLY:2});
 assert(a.rows.every(r=>!r.admitted));assert.equal(a.byGroup.COMPLETED_UNREFUNDED!.effectCents,'16400');assert.equal(a.byGroup.DETAINED!.effectCents,'8200');assert.equal(a.byGroup.REFUND_RECORD_EXISTS!.effectCents,'0');
 const terminal=a.rows.find(r=>r.group==='POSTED_CONFISCATION')!;assert.equal(terminal.effect!.status,'SETTLED');assert.equal(terminal.effect!.settledBy,'LEGACY_RECORDS');assert(terminal.reasons.includes('TARGET_DEPOSIT_CENTS_UNREAD'));
 for(const r of a.rows.filter(r=>r.group==='REFUND_RECORD_EXISTS')){assert.equal(r.effect,null);assert.deepEqual(r.reasons,['REFUND_SOURCE_RECORD_ONLY','CHANNEL_ARRIVAL_UNKNOWN','CURRENT_TARGET_UNREAD']);}
 const current:FoCurrent[]=parents.map(p=>({orderId:p.parentOrderId,readRef:'fixture-read',headRevision:null,depositAmountCents:'5700',duties:[],idempotency:{principalId:foActor.userId,records:[]}}));
 const b=foLiability({batchId:'fixture-86',parents,current,rows});assert.equal(b.writeAllowed,false);assert.equal(b.rows.filter(r=>r.admitted).length,6);assert.equal(b.pendingFacts.CURRENT_TARGET_UNREAD,undefined);
});

test('FIN-ORDER-2 86 counterexamples: duplicate, drift, missing column/parent, zero return, processed and conflicting duty are isolated without hiding other rows',()=>{
 const ok=foRow('101','COMPLETED_UNREFUNDED'),parents=[foParent('101',foSnap.COMPLETED_UNREFUNDED),foParent('102',foSnap.COMPLETED_UNREFUNDED),foParent('103',foSnap.COMPLETED_UNREFUNDED),foParent('401',foSnap.REFUND_RECORD_EXISTS)];
 const missingDetain=foRow('103','COMPLETED_UNREFUNDED');delete missingDetain.originalOrder!.detain_money;
 const rows=[ok,foRow('102','COMPLETED_UNREFUNDED'),foRow('102','COMPLETED_UNREFUNDED'),missingDetain,foRow('104','COMPLETED_UNREFUNDED'),foRow('401','REFUND_RECORD_EXISTS',{return_order_money:'0.00'})];
 const a=foLiability({batchId:'x',parents:parents.map(p=>p.legacyId==='401'?foParent('401',{...foSnap.REFUND_RECORD_EXISTS,return_order_money:'0.00'}):p),current:null,rows});
 assert.deepEqual(a.rows.map(r=>[r.state,r.reasons[0]]),[['ADMISSION_CANDIDATE','CURRENT_TARGET_UNREAD'],['CONFLICT','DUPLICATE_SOURCE_ROW'],['CONFLICT','DUPLICATE_SOURCE_ROW'],['MISSING_FACT','ORIGINAL_DETAIN_COLUMN_MISSING'],['MISSING_FACT','CURRENT_PARENT_TARGET_MISSING'],['CONFLICT','CANCELLED_POSITIVE_RETURN_REQUIRED']]);assert.equal(a.conserved,true);
 assert.equal(foLiability({batchId:'x',parents,current:null,rows:[foRow('101','COMPLETED_UNREFUNDED',{return_order_money:'88.00'})]}).rows[0]!.reasons[0],'LIABILITY_SOURCE_EVIDENCE_MISMATCH');
 assert.equal(foLiability({batchId:'x',parents,current:null,rows:[foRow('101','DETAINED',{is_settle:'0'})]}).rows[0]!.state,'CONFLICT');
 assert.equal(foLiability({batchId:'x',parents,current:null,rows:[{...ok,nominated:{amountCents:'8700'}}]}).rows[0]!.reasons[0],'NOMINATED_AMOUNT_DRIFT');assert.equal(foLiability({batchId:'x',parents,current:null,rows:[{...ok,nominated:{amountCents:'8200'}}]}).rows[0]!.state,'ADMISSION_CANDIDATE');
 const narrow=foRow('101','COMPLETED_UNREFUNDED');delete narrow.originalOrder!.unrelated_column;assert.equal(foLiability({batchId:'x',parents,current:null,rows:[narrow]}).rows[0]!.state,'ADMISSION_CANDIDATE');delete narrow.originalOrder!.is_settle;assert.equal(foLiability({batchId:'x',parents,current:null,rows:[narrow]}).rows[0]!.reasons[0],'ORIGINAL_SELECTED_FIELDS_MISSING');
 const original=foLiability({batchId:'x',parents,current:null,rows:[ok]}).rows[0]!,dutyId=original.effect!.dutyId,renter=parents[0]!.renterUserId,command=original.command!;
 const cur=(d:Partial<FoCurrent['duties'][number]>):FoCurrent[]=>[{orderId:foMapped('101'),readRef:'r',headRevision:'3',depositAmountCents:'5700',duties:[{id:dutyId,kind:'RENTER_REFUND',sourceRecordId:'101',amountCents:'8200',status:'PENDING',counterpartyUserId:renter,settledBy:null,...d}],idempotency:{principalId:foActor.userId,records:[{principalId:foActor.userId,operation:command.operation,resourceId:command.resourceId,key:command.idempotencyKey,fingerprint:command.fingerprint,responseStatus:200}]}}];
 assert.deepEqual(foLiability({batchId:'x',parents,current:cur({}),rows:[ok]}).rows[0]!.reasons,['ORIGINAL_KEY_REPLAY_ONLY']);
 const done=foLiability({batchId:'x',parents,current:cur({status:'SETTLED'}),rows:[ok]}).rows[0]!;assert.equal(done.state,'ALREADY_APPLIED');assert(done.reasons.includes('DUTY_ALREADY_SETTLED'));
 for(const drift of [{amountCents:'8100'},{counterpartyUserId:parents[0]!.ownerUserId},{id:'other_duty'}])assert.equal(foLiability({batchId:'x',parents,current:cur(drift),rows:[ok]}).rows[0]!.reasons[0],'LIABILITY_ECONOMIC_KEY_CONFLICT');
});

test('FIN-ORDER-2 86 consumption: assembled bodies pass the real liability command with the same duty/amount/key/fingerprint; denial, replay, 409 and UNKNOWN recovery stay in the existing idempotency',async t=>{
 for(const c of ['COMPLETED_UNREFUNDED','DETAINED','POSTED_CONFISCATION','REFUND_RECORD_EXISTS'] as const){
  const p=foParent('7',foSnap[c]),row=foLiability({batchId:'x',parents:[p],current:null,rows:[foRow('7',c)]}).rows[0]!;assert(row.command);foMocks(t);
  const k=foLiabilityClient(t,p,c==='REFUND_RECORD_EXISTS'?5:4);await foImportLiability(k.client,foActor,row.command.body);const duty=foDutyInsert(k.calls);
  if(row.effect){assert.equal(duty.length,1);assert.equal(duty[0]!.v[0],row.effect.dutyId);assert.equal(duty[0]!.v[5],row.effect.amountCents);assert.equal(duty[0]!.v[6],row.effect.status);}else assert.equal(duty.length,0);
  const idem=k.calls.find(q=>q.sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"'))!;assert.equal(idem.v[1],row.command.idempotencyKey);assert.equal(idem.v[2],row.command.fingerprint);t.mock.restoreAll();
 }
 const p=foParent('7',foSnap.COMPLETED_UNREFUNDED),row=foLiability({batchId:'x',parents:[p],current:null,rows:[foRow('7','COMPLETED_UNREFUNDED')]}).rows[0]!;
 foMocks(t,[],false);let k=foLiabilityClient(t,p,4);await assert.rejects(()=>foImportLiability(k.client,foActor,row.command!.body));assert.equal(foDutyInsert(k.calls).length,0);t.mock.restoreAll();
 foMocks(t);k=foLiabilityClient(t,p,4,{fingerprint:row.command!.fingerprint,body:{receipt:'original'}});const replay=await foImportLiability(k.client,foActor,row.command!.body);assert.equal((replay as {replayed:boolean}).replayed,true);assert.deepEqual((replay as {body:unknown}).body,{receipt:'original'});assert.equal(foDutyInsert(k.calls).length,0);t.mock.restoreAll();
 foMocks(t);k=foLiabilityClient(t,p,4,{fingerprint:'0'.repeat(64),body:{}});await assert.rejects(()=>foImportLiability(k.client,foActor,row.command!.body),(e:{status?:number})=>e.status===409);assert.equal(foDutyInsert(k.calls).length,0);t.mock.restoreAll();
 // UNKNOWN (commit outcome lost): the same actor+key+body is the only recovery; rolled back => one execution, committed => replay
 foMocks(t);k=foLiabilityClient(t,p,4);await foImportLiability(k.client,foActor,row.command!.body);assert.equal(foDutyInsert(k.calls).length,1);t.mock.restoreAll();
});

function foCommissionRow(id:string,parent:string,bucket:FoCommissionRow['bucket'],patch:Record<string,unknown>={}):FoCommissionRow{return{sourceRecord:{id,order_id:parent,user_id:'44',ratio:'20.00',level:'2',status:'1',earnings:'10.00',...patch},parentLegacyOrderId:parent,mappedOrderId:foMapped(parent),bucket,evidenceRef:'FIXTURE_A_COMMISSION'};}
const foDone={order_status:'4',pay_is:'1',is_settle:'0',confirm_time:foConfirm};
test('FIN-ORDER-2 370 assembly: 208 use original amount + completion+7d against real cutoff; 162 in-flight and status 2/3 stay source facts; missing facts isolated and conserved',()=>{
 const parents=[foParent('7',foDone,foCompletedAt),foParent('8',{...foDone},null),foParent('9',{...foDone,confirm_time:String(Number(foConfirm)+1)},foCompletedAt),foParent('6',{order_status:'3',pay_is:'1',is_settle:'0',confirm_time:null})];
 const rows=[foCommissionRow('91','7','COMPLETED_PARENT'),foCommissionRow('92','8','COMPLETED_PARENT'),foCommissionRow('93','9','COMPLETED_PARENT'),foCommissionRow('94','6','INFLIGHT_PARENT'),foCommissionRow('95','7','COMPLETED_PARENT',{status:'2'}),foCommissionRow('96','7','COMPLETED_PARENT',{status:'3'}),foCommissionRow('97','5','COMPLETED_PARENT'),foCommissionRow('91','7','COMPLETED_PARENT')];
 let a=foCommission({batchId:'x',cutoff:foCutoff,parents,current:null,verifiedBeneficiaries:null,rows});
 assert.deepEqual(a.rows.map(r=>[r.state,r.reasons[0]]),[['CONFLICT','DUPLICATE_SOURCE_ROW'],['MISSING_FACT','TARGET_COMPLETED_AT_UNBOUND'],['CONFLICT','COMPLETED_TIME_SOURCE_MISMATCH'],['OBSERVE_ONLY','T_CONFIRM_RUNTIME'],['OBSERVE_ONLY','ALREADY_SETTLED_SOURCE'],['OBSERVE_ONLY','ALREADY_VOID_SOURCE'],['MISSING_FACT','CURRENT_PARENT_TARGET_MISSING'],['CONFLICT','DUPLICATE_SOURCE_ROW']]);assert.equal(a.conserved,true);assert.equal(a.writeAllowed,false);
 a=foCommission({batchId:'x',cutoff:foCutoff,parents,current:null,verifiedBeneficiaries:null,rows:[rows[0]!]});const r=a.rows[0]!;
 assert.equal(r.state,'MISSING_FACT');assert.deepEqual(r.reasons,['BENEFICIARY_IDENTITY_UNVERIFIED','CURRENT_TARGET_UNREAD']);assert.equal(r.effect!.amountCents,'1000');assert.equal(r.effect!.maturityAt,'2026-10-08T01:02:03.000000Z');assert.equal(r.effect!.maturedByCutoff,true);
 const command=r.command!,admissionId='legacy_admission_'+foSha(r.effect!.dutyId).slice(0,40),admissionDigest=foSha(canonicalize({schema:'legacy-completed-commission-admission.v1',...command.body,beneficiaryUserId:r.effect!.beneficiaryUserId,amountCents:r.effect!.amountCents,maturityAt:r.effect!.maturityAt}));
 const cur=(d:Record<string,string|null>):FoCurrent[]=>[{orderId:foMapped('7'),readRef:'r',headRevision:null,depositAmountCents:null,duties:[{id:r.effect!.dutyId,kind:'COMMISSION',sourceRecordId:'91',amountCents:'1000',status:'PENDING',counterpartyUserId:r.effect!.beneficiaryUserId,settledBy:null,admissionId,...d}],admissions:[{id:admissionId,dutyId:r.effect!.dutyId,admissionDigest}],idempotency:{principalId:foActor.userId,records:[{principalId:foActor.userId,operation:command.operation,resourceId:command.resourceId,key:command.idempotencyKey,fingerprint:command.fingerprint,responseStatus:200}]}}];
 const ok=foCommission({batchId:'x',cutoff:foCutoff,parents,current:[{orderId:foMapped('7'),readRef:'r',headRevision:null,depositAmountCents:null,duties:[],admissions:[],idempotency:{principalId:foActor.userId,records:[]}}],verifiedBeneficiaries:['44'],rows:[rows[0]!]}).rows[0]!;assert.equal(ok.state,'ADMISSION_CANDIDATE');assert.equal(ok.admitted,true);
 assert.equal(foCommission({batchId:'x',cutoff:foCutoff,parents,current:cur({}),verifiedBeneficiaries:['44'],rows:[rows[0]!]}).rows[0]!.state,'ALREADY_APPLIED');
 for(const drift of [{amountCents:'999'},{counterpartyUserId:'other'},{admissionId:null}] as Record<string,string|null>[])assert.equal(foCommission({batchId:'x',cutoff:foCutoff,parents,current:cur(drift),verifiedBeneficiaries:['44'],rows:[rows[0]!]}).rows[0]!.reasons[0],'COMMISSION_ADMISSION_CONFLICT');
 assert.equal(foCommission({batchId:'x',cutoff:foCutoff,parents,current:null,verifiedBeneficiaries:['44'],rows:[foCommissionRow('91','7','COMPLETED_PARENT',{earnings:'10.001'})]}).rows[0]!.state,'CONFLICT');
 for(const nominated of [{beneficiaryLegacyId:'45',amountCents:'1000'},{beneficiaryLegacyId:'44',amountCents:'1001'}])assert.equal(foCommission({batchId:'x',cutoff:foCutoff,parents,current:null,verifiedBeneficiaries:['44'],rows:[{...rows[0]!,nominated}]}).rows[0]!.reasons[0],'NOMINATED_BENEFICIARY_OR_AMOUNT_DRIFT');
 assert.equal(foCommission({batchId:'x',cutoff:foCutoff,parents,current:null,verifiedBeneficiaries:['44'],rows:[foCommissionRow('91','7','COMPLETED_PARENT',{is_delete:'1'})]}).rows[0]!.reasons[0],'COMMISSION_SOURCE_DELETED');
 assert.throws(()=>foCommission({batchId:'x',cutoff:'2026-09-13T13:31:22.000Z',parents,current:null,verifiedBeneficiaries:null,rows:[]}));
});

test('FIN-ORDER-2 208 consumption: the assembled body passes the real completed-commission command with the same duty, maturity, key and fingerprint; denial and replay stay in existing gates',async t=>{
 const p=foParent('7',foDone,foCompletedAt),row=foCommission({batchId:'x',cutoff:foCutoff,parents:[p],current:null,verifiedBeneficiaries:['44'],rows:[foCommissionRow('91','7','COMPLETED_PARENT')]}).rows[0]!;assert(row.command);
 const client=(idem:{fingerprint:string}|null=null)=>{const calls:Array<{sql:string;v:unknown[]}>=[];return{calls,client:{query:async(sql:string,v:unknown[]=[])=>{calls.push({sql,v});
  if(sql.includes('"idempotency_record" WHERE'))return{rows:idem?[{requestFingerprint:idem.fingerprint,responseStatus:200,responseBody:{receipt:'original'},publishRequired:false}]:[],rowCount:idem?1:0};
  return sql.includes('FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1')?{rows:[{...foBinding,sourceDigest:p.sourceDigest,sourceOrderStatus:4,completedAt:foCompletedAt}],rowCount:1}:sql.includes('SELECT 1 FROM zzsh_iam.user_identity_state')?{rows:[{}],rowCount:1}:{rows:[],rowCount:0};}} as unknown as FoPoolClient};};
 foMocks(t);let k=client();const result=await foImportCommission(k.client,foActor,row.command.body);assert('body' in result);assert.equal((result.body as {dutyId:string}).dutyId,row.effect!.dutyId);assert.equal((result.body as {maturityAt:string}).maturityAt,row.effect!.maturityAt);
 const duty=foDutyInsert(k.calls)[0]!;assert.equal(duty.v[0],row.effect!.dutyId);assert.equal(duty.v[3],row.effect!.beneficiaryUserId);assert.equal(duty.v[4],'1000');
 const idem=k.calls.find(q=>q.sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"'))!;assert.equal(idem.v[1],row.command.idempotencyKey);assert.equal(idem.v[2],row.command.fingerprint);t.mock.restoreAll();
 foMocks(t,[],false);k=client();await assert.rejects(()=>foImportCommission(k.client,foActor,row.command!.body));assert.equal(foDutyInsert(k.calls).length,0);t.mock.restoreAll();
 foMocks(t);k=client({fingerprint:row.command.fingerprint});const replay=await foImportCommission(k.client,foActor,row.command.body);assert.equal((replay as {replayed:boolean}).replayed,true);assert.equal(foDutyInsert(k.calls).length,0);t.mock.restoreAll();
 foMocks(t);k=client({fingerprint:'0'.repeat(64)});await assert.rejects(()=>foImportCommission(k.client,foActor,row.command!.body),(e:{status?:number})=>e.status===409);t.mock.restoreAll();
});

test('FIN-ORDER-2 root preflight binds economic tuple, admission digest and the exact actor original receipt',()=>{
 const p=foParent('7',foDone,foCompletedAt),source=foCommissionRow('91','7','COMPLETED_PARENT');
 const run=(current:FoCurrent[],verifiedBeneficiaries:string[]|null=['44'])=>foCommission({batchId:'root',cutoff:foCutoff,parents:[p],current,verifiedBeneficiaries,rows:[source]}).rows[0]!;
 const row=foCommission({batchId:'root',cutoff:foCutoff,parents:[p],current:null,verifiedBeneficiaries:['44'],rows:[source]}).rows[0]!,effect=row.effect!,command=row.command!;
 const admissionId='legacy_admission_'+foSha(effect.dutyId).slice(0,40),admissionDigest=foSha(canonicalize({schema:'legacy-completed-commission-admission.v1',...command.body,beneficiaryUserId:effect.beneficiaryUserId,amountCents:effect.amountCents,maturityAt:effect.maturityAt}));
 const receipt={principalId:foActor.userId,operation:command.operation,resourceId:command.resourceId,key:command.idempotencyKey,fingerprint:command.fingerprint,responseStatus:200};
 const complete:FoCurrent={orderId:p.parentOrderId,readRef:'root-fixture',headRevision:null,depositAmountCents:null,duties:[{id:effect.dutyId,kind:'COMMISSION',sourceRecordId:'91',amountCents:effect.amountCents,status:'PENDING',counterpartyUserId:effect.beneficiaryUserId,settledBy:null,admissionId}],admissions:[{id:admissionId,dutyId:effect.dutyId,admissionDigest}],idempotency:{principalId:foActor.userId,records:[receipt]}};
 assert.equal(run([complete]).state,'ALREADY_APPLIED');assert.equal(run([complete]).command!.recoveryPrincipalId,foActor.userId);
 const change=(edit:(target:FoCurrent)=>void)=>{const target=structuredClone(complete);edit(target);return run([target]);};
 assert.equal(change(t=>{t.duties[0]!.id='legacy_duty_other';}).state,'CONFLICT');
 assert.equal(change(t=>{t.admissions=[{id:admissionId,dutyId:effect.dutyId,admissionDigest:'0'.repeat(64)}];}).reasons[0],'COMMISSION_ADMISSION_CONFLICT');
 assert.equal(change(t=>{t.idempotency!.records=[{...receipt,fingerprint:'0'.repeat(64)}];}).reasons[0],'IDEMPOTENCY_BODY_CONFLICT');
 assert.equal(change(t=>{t.idempotency!.records=[{...receipt,principalId:'other_admin'}];}).reasons[0],'IDEMPOTENCY_SCOPE_MISMATCH');
 assert.equal(change(t=>{t.idempotency!.records=[{...receipt,responseStatus:500}];}).reasons[0],'IDEMPOTENCY_RESULT_NOT_SUCCESS');
 const noReceipt=change(t=>{t.idempotency!.records=[];});assert.equal(noReceipt.state,'MISSING_FACT');assert(noReceipt.reasons.includes('ORIGINAL_KEY_RECEIPT_MISSING'));
 assert.equal(change(t=>{delete t.idempotency;}).state,'MISSING_FACT');
 assert.equal(change(t=>{delete t.admissions;}).state,'MISSING_FACT');
 assert.equal(change(t=>{t.duties=[];t.admissions=[];}).reasons[0],'RECEIPT_TARGET_MISSING');
 const noIdentity=run([complete],null);assert.equal(noIdentity.state,'MISSING_FACT');assert(noIdentity.reasons.includes('BENEFICIARY_IDENTITY_UNVERIFIED'));
 const empty:FoCurrent={...complete,duties:[],admissions:[],idempotency:{principalId:foActor.userId,records:[]}};
 assert.equal(run([empty]).admitted,true);const unread={...empty,idempotency:null};assert.equal(run([unread]).admitted,false);
 const terminalParent=foParent('8',foSnap.POSTED_CONFISCATION),terminalSource=foRow('8','POSTED_CONFISCATION');
 const terminal=foLiability({batchId:'root',parents:[terminalParent],current:null,rows:[terminalSource]}).rows[0]!;
 const wrongTerminal:FoCurrent={orderId:terminalParent.parentOrderId,readRef:'root-fixture',headRevision:null,depositAmountCents:'5700',duties:[{id:terminal.effect!.dutyId,kind:'DEPOSIT_COMPENSATION',sourceRecordId:'8',amountCents:'5700',status:'PENDING',counterpartyUserId:terminal.effect!.beneficiaryUserId,settledBy:null}]};
 assert.equal(foLiability({batchId:'root',parents:[terminalParent],current:[wrongTerminal],rows:[terminalSource]}).rows[0]!.reasons[0],'LEGACY_TERMINAL_SOURCE_CONFLICT');
});

test('FIN-ORDER-2 root assembly isolates null/scalar/array rows and preserves the valid row and changing input digest',()=>{
 const p=foParent('7',foSnap.COMPLETED_UNREFUNDED),source=foRow('7','COMPLETED_UNREFUNDED');
 const liability={batchId:'root',parents:[p],current:null,rows:[source,null,42,[]] as unknown as FoLiabilityRow[]};
 const result=foLiability(liability);assert.equal(result.rows.length,4);assert.equal(result.rows[0]!.state,'ADMISSION_CANDIDATE');assert(result.rows.slice(1).every(r=>r.state==='CONFLICT'&&r.reasons[0]==='SOURCE_SCHEMA_INVALID'));assert.equal(result.conserved,true);
 assert.notEqual(foLiability({...liability,rows:[source,null,43,[]] as unknown as FoLiabilityRow[]}).inputDigest,result.inputDigest);
 const commissions=foCommission({batchId:'root',cutoff:foCutoff,parents:[foParent('7',foDone,foCompletedAt)],current:null,verifiedBeneficiaries:null,rows:[foCommissionRow('91','7','COMPLETED_PARENT'),null,42,[]] as unknown as FoCommissionRow[]});
 assert.equal(commissions.rows.length,4);assert.equal(commissions.rows[0]!.state,'MISSING_FACT');assert(commissions.rows.slice(1).every(r=>r.state==='CONFLICT'));assert.equal(commissions.conserved,true);
});
