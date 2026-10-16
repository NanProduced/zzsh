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
