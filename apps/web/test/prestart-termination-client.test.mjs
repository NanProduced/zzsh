// SYNTHETIC_READER_COMPONENT；读取合成DTO与内存HTTP，不是PG/渠道验收。
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePrestartView,parsePrestartRefund,prestartApi} from '../src/lib/prestart-termination-client.ts';
const at='2026-10-28T00:00:00.000000Z';
const request={id:'term_1',revision:'2',state:'APPROVED',requestedByParty:'RENTER',reason:'申请未开租结束',reviewReason:'核实无争议',createdAt:at,updatedAt:at,approvedAt:at,
 fullRefundCents:'15908',currency:'CNY',dataOrigin:'JOINPAY_LOCAL_ACCEPTANCE',liabilityRecognized:true,channelSubmission:'NOT_REPORTED',bankArrival:'UNKNOWN'};
const refund={integration:'INTEGRATED',truncated:false,reason:null,channelRecordsChecked:false,bankArrival:'UNKNOWN',
 totals:{originalCents:'15908',allocatedCents:'15908',consumedCents:'0',releasedCents:'0',remainingCents:'0',totalsComplete:true},
 intents:[{intentId:'refund_1',refundOrderNo:'RF'+'a'.repeat(28),state:'UNKNOWN',amountCents:'15908',firstSubmit:'DISPATCHED',blockedReason:null,
  localWriteOff:'NOT_RECORDED',savedChannelEvidence:null,bankArrival:'UNKNOWN'}]};
const view=()=>({contractVersion:'order-prestart-termination.v1',orderId:'order_1',orderRevision:'2',eligibility:{allowed:false,reason:'ORDER_NOT_PAID',refundCents:null},
 request:{...request},refund:structuredClone(refund),coverage:'LOCAL_REGISTERED_ONLY',asOf:at,localAcceptanceObservedAt:at,unknowns:['BANK_ARRIVAL_NOT_VERIFIED'],bankArrival:'UNKNOWN'});
test('原责任、分配、核销、尚未分配与渠道/银行未知分开',()=>{
 const p=parsePrestartView(view(),'order_1');assert.equal(p.refund.totals.remainingCents,'0');assert.equal(p.refund.totals.consumedCents,'0');assert.equal(p.request.fullRefundCents,'15908');assert.equal(p.refund.intents[0].state,'UNKNOWN');assert.equal(p.bankArrival,'UNKNOWN');
 const cropped=view();cropped.request.fullRefundCents=null;cropped.refund.totals=null;cropped.refund.intents[0].amountCents=null;cropped.refund.intents[0].refundOrderNo=null;
 assert.equal(parsePrestartView(cropped,'order_1').request.fullRefundCents,null);
});
test('坏版本/对象/枚举/金额/时间、未认责任的APPROVED直接拒绝',()=>{
 for(const patch of [{contractVersion:'other'},{orderId:'other'},{bankArrival:'ARRIVED'},
  {request:{...request,state:['APPROVED']}},{request:{...request,liabilityRecognized:false}},
  {request:{...request,fullRefundCents:15908}},{request:{...request,approvedAt:null}}])assert.throws(()=>parsePrestartView({...view(),...patch},'order_1'));
});
test('截断、冲突或未接入不能提供完整合计；分配含核销、remaining不是未到账',()=>{
 for(const patch of [{truncated:true},{integration:'UNAVAILABLE'},{totals:{...refund.totals,remainingCents:'15908'}},
  {totals:{...refund.totals,consumedCents:'15909'}},{intents:[{...refund.intents[0],firstSubmit:['DISPATCHED']}]}])assert.throws(()=>parsePrestartRefund({...refund,...patch}));
 const truncated=parsePrestartRefund({...refund,truncated:true,totals:null});assert.equal(truncated.totals,null);assert.equal(truncated.truncated,true);
});
test('保存的渠道成功仍保留未重验标签与银行UNKNOWN',()=>{
 const p=parsePrestartRefund({...refund,intents:[{...refund.intents[0],savedChannelEvidence:{terminal:'SUCCEEDED',channelRefundTrxNo:'trx_1',completedAt:at,observedAt:at,trust:'SAVED_EVIDENCE_NOT_REVALIDATED'}}]});
 assert.equal(p.intents[0].savedChannelEvidence.trust,'SAVED_EVIDENCE_NOT_REVALIDATED');assert.equal(p.bankArrival,'UNKNOWN');
 assert.throws(()=>parsePrestartRefund({...refund,intents:[{...refund.intents[0],savedChannelEvidence:{terminal:'SUCCEEDED',trust:'OFFICIAL_REVERIFIED'}}]}));
});
test('提交回执未知/无有效对象不能当成功；原key/body由调用方恢复',async()=>{
 const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({outcome:'UNKNOWN',originalKeyRequired:true},{status:202});};
 try{const body={expectedOrderRevision:'1',reason:'申请无交付结束'};
  await assert.rejects(prestartApi.request('renter_1','order_1','original_key',body));
  await assert.rejects(prestartApi.request('renter_1','order_1','original_key',body));
  assert.equal(calls[0].init.body,calls[1].init.body);assert.equal(new Headers(calls[0].init.headers).get('idempotency-key'),'original_key');
  assert.equal(new Headers(calls[0].init.headers).get('x-zzsh-expected-user-id'),'renter_1');
 }finally{globalThis.fetch=old;}
});
