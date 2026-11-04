import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readMyWalletEntry,parseWalletSourceDetails,parseWalletEntrySourceDetails,financeEntryLabel,walletSourceStatus} from '../src/lib/personal-wallet-client.ts';

const sourceDetails={associationState:null,associationReason:null,recordedAmountCents:'1234',originalStatus:'1',originalNumber:'ORIGINAL-REFUND',originalOrderType:'order',originalRatio:null,originalLevel:null,sourcePaidAt:null,channelArrival:'UNKNOWN',affectsCurrentWallet:false};
test('wallet source detail keeps original amount/status but rejects an invented channel or wallet effect and strips private fields',async()=>{
 const previous=globalThis.fetch,at='2026-11-03T07:47:05.000Z';
 globalThis.fetch=async()=>Response.json({contractVersion:'personal-finance.read.v1',projectionVersion:2,subjectId:'u1',asOf:at,snapshotVersion:'1',coverage:{knowledge:'UNKNOWN'},entry:{schemaVersion:1,id:'history:old-refund',occurredAt:at,importedAt:at,postedAt:null,recordedAt:at,bucket:'AVAILABLE',deltaCents:'0',kind:'HISTORICAL',includedInOpening:false,sourceKind:'HISTORICAL_REFUND',source:{type:'LEGACY_MYSQL',system:'legacy_mysql_restore',entity:'la_refund_record',id:'11'},businessReference:{type:'LEGACY_UNRESOLVED',id:null,number:null},balanceAfterCents:null,sourceDetails:{...sourceDetails,remark:'PRIVATE',extra:'PRIVATE'},rawSource:'PRIVATE'}});
 try{const result=await readMyWalletEntry('u1','history:old-refund');assert.deepEqual(result.entry.sourceDetails,sourceDetails);assert.equal(result.entry.deltaCents,'0');assert.equal(financeEntryLabel(result.entry),'退款记录');assert.equal(walletSourceStatus(result.entry),'退款处理完成');assert(!JSON.stringify(result).includes('PRIVATE'));}finally{globalThis.fetch=previous;}
 for(const changed of [{channelArrival:'PAID'},{affectsCurrentWallet:true},{recordedAmountCents:'1.23'}])assert.throws(()=>parseWalletSourceDetails({...sourceDetails,...changed}));
});

test('source-only records without their original amount contract never fall back to a displayed zero wallet movement',()=>{for(const value of [{sourceKind:'HISTORICAL_PAYMENT',deltaCents:'0',kind:'HISTORICAL',includedInOpening:false},{sourceKind:'HISTORICAL_REFUND',sourceDetails,deltaCents:'1234',kind:'HISTORICAL',includedInOpening:false},{sourceKind:'OPENING',sourceDetails,deltaCents:'0',kind:'POSTED',includedInOpening:false}])assert.throws(()=>parseWalletEntrySourceDetails(value));});


test('the actual wallet client reads typed refund attempts and only the allowed public fields',async()=>{
 const attempt={source:{type:'LEGACY_MYSQL',entity:'la_refund_log',id:'7'},originalNumber:'TRY-1',originalStatus:'0',recordedAmountCents:'200',occurredAt:'2026-05-22T17:10:00.000Z',updatedAt:null,channelArrival:'UNKNOWN',reasonCodes:[]};
 const parsed=parseWalletSourceDetails({...sourceDetails,attempts:[{...attempt,refund_msg:'PRIVATE',legacyOperatorId:'PRIVATE'}],reasonCodes:['MULTIPLE_REFUND_RECORDS_FOR_TYPED_ORDER']});assert.deepEqual(parsed.attempts,[attempt]);assert(!JSON.stringify(parsed).includes('PRIVATE'));assert.equal(parsed.recordedAmountCents,'1234');
 assert.throws(()=>parseWalletSourceDetails({...sourceDetails,attempts:[{...attempt,source:{...attempt.source,entity:'la_refund_record'}}]}));
});
