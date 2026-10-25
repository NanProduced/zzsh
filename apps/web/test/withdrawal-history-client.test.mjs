import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseWithdrawalHistory,projectWithdrawalHistory,parseWithdrawalHistoryDetail,parseWithdrawalHistoryRecovery,readWithdrawalHistory,withdrawalHistoryQuery} from '../src/lib/withdrawal-history-client.ts';
import {WithdrawalRequestError} from '../src/lib/withdrawal-client-core.ts';
import {userId,historyRead,joinpayRow,json,withStorage} from './withdrawal-fixtures.mjs';

test('three source history retains separate cursors/count scopes and roundtrips the controlled wire envelope',()=>{
 const raw=historyRead();raw.sections.joinpay.data.nextCursor='native_cursor';raw.sections.joinpay.data.count='10';raw.sections.controlled.data.pagination.nextCursor='controlled_cursor';raw.sections.controlled.data.pagination.mappedRecordCount='2';
 const result=parseWithdrawalHistory(raw,userId);assert.equal(result.sections.historical.data.count,'0');assert.equal(result.sections.controlled.data.pagination.nextCursor,'controlled_cursor');assert.equal(result.sections.joinpay.data.nextCursor,'native_cursor');assert.equal(result.sections.joinpay.data.scope,'LOCAL_NATIVE_INTENTS_ONLY');
 const projected=projectWithdrawalHistory(raw,userId);assert.equal(projected.sections.controlled.data.scope,'LOCAL_CONTROLLED');assert.deepEqual(parseWithdrawalHistory(projected,userId),result);
});
test('a legacy delegated source identity error retains its authorization type',()=>{
 const raw=historyRead();raw.sections.controlled.data.subjectId='different_user';
 assert.throws(()=>parseWithdrawalHistory(raw,userId),e=>e instanceof WithdrawalRequestError&&e.status===401&&e.code==='IDENTITY_CHANGED');
});
test('missing response source/filter metadata is not silently defaulted to ALL',()=>{
 const raw=historyRead();delete raw.source;delete raw.state;
 assert.throws(()=>parseWithdrawalHistory(raw,userId),e=>e.status===502&&e.code==='WITHDRAWAL_CONTRACT_REQUIRED');
});
test('unavailable source is not empty, and authorization failure remains an error',async()=>{
 const raw=historyRead();raw.sections.historical={availability:'UNAVAILABLE',reasonCodes:['HISTORICAL_LOCAL_EVIDENCE_UNAVAILABLE'],data:null};const result=parseWithdrawalHistory(raw,userId);assert.equal(result.sections.historical.data,null);assert.equal(result.sections.joinpay.data.count,'1');
 assert.throws(()=>parseWithdrawalHistory(raw,'other_user'),e=>e.code==='IDENTITY_CHANGED');
 await withStorage(async()=>{globalThis.fetch=async()=>json({error:{code:'FORBIDDEN'}},403);await assert.rejects(()=>readWithdrawalHistory(userId),e=>e.status===403);});
});
test('ALL cannot have combined cursor or state filter and JOINPAY requests only its own page',()=>withStorage(async()=>{
 assert.throws(()=>withdrawalHistoryQuery({source:'ALL',cursor:'x'}));assert.throws(()=>withdrawalHistoryQuery({source:'ALL',state:'SUCCEEDED'}));assert.throws(()=>withdrawalHistoryQuery({source:'JOINPAY',state:'RECONCILIATION_REQUIRED'}));
 const raw=historyRead();raw.source='JOINPAY';raw.sections.historical={availability:'NOT_REQUESTED',reasonCodes:[],data:null};raw.sections.controlled={availability:'NOT_REQUESTED',reasonCodes:[],data:null};let requested;
 globalThis.fetch=async url=>{requested=String(url);return json(raw);};await readWithdrawalHistory(userId,{source:'JOINPAY',cursor:'native_cursor',limit:10});assert.match(requested,/source=JOINPAY/);assert.match(requested,/cursor=native_cursor/);assert(!requested.includes('state=ALL'));
 globalThis.fetch=async()=>json({error:{code:'CONFLICT'}},409);await assert.rejects(()=>readWithdrawalHistory(userId,{source:'JOINPAY',cursor:'stale'}),e=>e.status===409);
}));
test('Native history detail uses data.item and original-key recovery is current local intent, not ACK or arrival',()=>{
 const row=joinpayRow();row.originalDestination.cardMask=null;const detail=parseWithdrawalHistoryDetail({contractVersion:'personal-withdrawals.read.v2',subjectId:userId,source:'JOINPAY',availability:'AVAILABLE',reasonCodes:[],data:{scope:'LOCAL_NATIVE_INTENTS_ONLY',item:row}},userId,row.id);
 assert.equal(detail.data.item.originalDestination.cardMask,null);
 const found=parseWithdrawalHistoryRecovery({contractVersion:'personal-withdrawals.read.v2',subjectId:userId,source:'JOINPAY',knowledge:'KNOWN',item:{...row,state:'SUCCEEDED'},mayResubmit:false,receiptMeaning:'CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK'},userId);
 assert.equal(found.item.bankArrival,'UNKNOWN');assert.equal(found.item.evidenceLevel,'LOCAL_RECORDS_NOT_REVALIDATED');assert.equal(found.mayResubmit,false);
 assert.throws(()=>parseWithdrawalHistoryRecovery({...found,receiptMeaning:'ORIGINAL_ACK'},userId));
});
