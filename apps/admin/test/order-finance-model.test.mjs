import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeOrderRefunds, refundSummaryScope } from '../src/views/order-finance-model.ts';

const source=(id,extra={})=>({documentRef:`REFUND_INTENT:${id}`,number:`RF-${id}`,kind:'REFUND',source:'NATIVE',state:'SUCCEEDED',amountCents:'1000',occurredAt:null,channelArrival:'UNKNOWN',payWay:null,payWayLabel:null,...extra});
const intent=(id,extra={})=>({intentId:id,refundOrderNo:`RF-${id}`,amount:{cents:'1000',currency:'CNY'},localState:'SUCCEEDED',budgetDisposition:'CONSUMED',requiresReview:false,bankArrival:'UNKNOWN',...extra});
const summary=(intents=[])=>({contractVersion:'admin-order-refund-summary.v1',integration:'INTEGRATED',intents,bankArrival:'UNKNOWN',coverageScope:'JOINPAY_ONLY',coverage:'COMPLETE_WITHIN_LIMIT'});

test('controlled refund remains visible when the Joinpay-only summary is empty',()=>{
 const rows=mergeOrderRefunds([source('a',{paymentSource:'CONTROLLED'})],summary());
 assert.equal(rows.length,1);assert.equal(rows[0].source,'CONTROLLED');assert.match(refundSummaryScope(summary()),/仅覆盖汇聚来源/);
});
test('same refund intent and exact amount combine once; conflicts remain unresolved',()=>{
 const rows=mergeOrderRefunds([source('a',{paymentSource:'JOINPAY'})],summary([intent('a')]));
 assert.equal(rows.length,1);assert.equal(rows[0].amountCents,'1000');assert.equal(rows[0].source,'JOINPAY');
 const mismatch=mergeOrderRefunds([source('a',{paymentSource:'JOINPAY'})],summary([intent('a',{amount:{cents:'900',currency:'CNY'}})]));
 assert.equal(mismatch.length,1);assert.equal(mismatch[0].conflict,true);assert.equal(mismatch[0].amountCents,null);
 assert.equal(mergeOrderRefunds([source('a',{paymentSource:'CONTROLLED'})],summary([intent('a')]))[0].conflict,true);
 assert.equal(mergeOrderRefunds([source('a',{paymentSource:'JOINPAY'})],summary([intent('a',{refundOrderNo:'other'})]))[0].conflict,true);
 assert.equal(mergeOrderRefunds([],summary([intent('a',{amount:{cents:'1.1',currency:'CNY'}})]))[0].conflict,true);
});
test('separate old refunds with equal values stay separate; an unavailable or truncated summary is not empty proof',()=>{
 const legacy=id=>source(id,{documentRef:`HISTORY_REFUND:${id}`,source:'LEGACY_MYSQL',state:'RECORDED_SUCCESS'});
 assert.equal(mergeOrderRefunds([legacy('a'),legacy('b')],summary()).length,2);
 assert.match(refundSummaryScope({...summary(),truncated:true}),/未读全/);
 assert.match(refundSummaryScope({...summary(),integration:'FORBIDDEN',intents:null}),/无权/);
});
test('retired refund types from an older API are not rendered as normal refunds',()=>{
 const rows=mergeOrderRefunds([],summary([intent('old',{basisKind:'REVIEW_CONFIRMATION'}),intent('new',{basisKind:'POSTING'})]));
 assert.deepEqual(rows.map(row=>row.key),['REFUND_INTENT:new']);
});

test('support cancellation refund remains visible without duplicating its channel record',()=>{
 const rows=mergeOrderRefunds([source('cancel')],summary([intent('cancel',{basisKind:'SUPPORT_CANCELLATION'})]));
 assert.equal(rows.length,1);assert.equal(rows[0].amountCents,'1000');assert.equal(rows[0].source,'JOINPAY');assert.equal(rows[0].conflict,false);
});
