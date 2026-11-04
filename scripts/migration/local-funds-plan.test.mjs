import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertFundsWriterCoverage,safeLegacyWithdrawalEvidence} from './local-funds-plan.mjs';

test('legacy withdrawal destinations become non-reusable masks and immutable restricted refs, never full identities, payout credentials or URLs',()=>{
 const raw={id:'1',real_name:'张三',bank_card_no:'6222021234567890123',bank_name:'工商银行',mobile:'13812345678',account:'13812345678',money_qr_code:'https://private.example/secret',apply_remark:'PRIVATE-REMARK',pay_search_result:'PRIVATE-CHANNEL-RESPONSE',admin_id:'77'};
 const safe=safeLegacyWithdrawalEvidence(raw,'restricted-fixture:withdraw:1',JSON.stringify),encoded=JSON.stringify(safe);
 assert.deepEqual(safe.legacyDestination,{bankName:'工商银行',cardLast4:'0123',nameMasked:'张**',phoneMasked:'138****5678',accountMasked:'****5678'});assert.equal(safe.legacyOperatorId,'77');assert.equal(safe.restrictedSourceRef,'restricted-fixture:withdraw:1');assert.match(safe.restrictedSourceDigest,/^[a-f0-9]{64}$/);
 for(const value of [raw.bank_card_no,raw.real_name,raw.mobile,raw.account,raw.money_qr_code,raw.apply_remark,raw.pay_search_result])assert(!encoded.includes(value));
 assert.equal(safe.restrictedFields.transfer_voucher,undefined);assert.equal(raw.bank_card_no,'6222021234567890123');
});

test('writer admission rejects a missing row or changed source tuple even when aggregate counts still match',()=>{
 const history=[{domain:'pays',sourceId:'11:HISTORICAL_PAYMENT',input:{observations:[{sourceId:'7',kind:'paymentObservation',amount:'1.00'}]}}],guarantees=[{sourceId:'11',input:{rows:[{source:{id:'8'}}]}}];
 const plan={summary:{pays:{selected:1,planned:1,writer:0},guarantees:{selected:1,planned:1,writer:0}},history,guaranteeHistory:guarantees};
 assert.equal(assertFundsWriterCoverage(plan,history,guarantees).pays.writer,1);assert.equal(plan.summary.pays.writer,0);
 assert.throws(()=>assertFundsWriterCoverage(plan,[],guarantees),/SOURCE_SET_CHANGED/);
 const changed=structuredClone(history);changed[0].input.observations[0].sourceId='9';assert.throws(()=>assertFundsWriterCoverage(plan,changed,guarantees),/SOURCE_SET_CHANGED/);
 assert.throws(()=>assertFundsWriterCoverage({...plan,summary:{...plan.summary,pays:{selected:2,planned:1,writer:0}}},history,guarantees),/COVERAGE_MISMATCH/);
});
