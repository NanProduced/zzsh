import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import * as refundStore from "../src/order/channel-refund-store";
import * as profile from "../src/order/joinpay-refund-profile";
import { assertJoinpayRefundTerminalFact, readVerifiedRefundTerminalFact, captureRefundTerminalFact, refundTerminalConflicts, nativeTerminalReviewsConsistent } from "../src/order/joinpay-refund-source";
import { readNativeRefundRecovery } from "../src/order/joinpay-refund-attempt";
test("HTTP/CONTROLLED/SYNTHETIC/JSON克隆终态都无private品牌，拒绝发生在SQL前", async () => {
  let reads = 0; const c = { async query() { reads++; throw Error("unexpected"); } } as unknown as PoolClient;
  for (const fact of [null, {}, { source: "JOINPAY", officialVerified: true, terminal: "SUCCEEDED" }, { evidenceLevel: "SYNTHETIC_PROTOCOL" }, { source: "CONTROLLED" }, JSON.parse('{"kind":"FORMAL_REFUND","amountCents":"100"}')]) await assert.rejects(assertJoinpayRefundTerminalFact(c, fact), /not verified/);
  assert.equal(reads, 0);
});
test("旧NULL/伪准入不能重验正式终态，0SQL/0key；未知退款不会补成功", async () => {
  let reads = 0, keys = 0; const c = { async query() { reads++; return { rows: [] }; } } as unknown as PoolClient;
  const options = { admission: {} as any, profileFor: () => { throw Error("unreachable"); }, keyFor: () => { keys++; return "SYNTHETIC"; } };
  await assert.rejects(readVerifiedRefundTerminalFact(c, options, "evidence_1")); await assert.rejects(captureRefundTerminalFact(c, options, "refund_1", "obs_1"));
  assert.equal(reads, 0); assert.equal(keys, 0);
});
test("原退款号恢复仅本地SELECT，不返raw/钥/到账且不发SUBMIT", async () => {
  const queries: string[] = [], c = { async query(sql: string, values: string[]) { queries.push(sql); return { rows: values[0] === "known" ? [{ id: "known", refund_order_no: "RF_ORIGINAL", state: "UNKNOWN", budget_disposition: "ALLOCATED", requires_review: false, terminal_evidence_id: null, terminal_root_id: null, terminal_event_id: null }] : [] }; } } as unknown as PoolClient;
  const value = await readNativeRefundRecovery(c, "known"); assert.equal(value?.originalRefundOrderNo, "RF_ORIGINAL"); assert.equal(value?.mayResubmit, false); assert.equal(value?.state, "UNKNOWN");
  assert.equal(await readNativeRefundRecovery(c, "missing"), null); assert.equal(queries.every(sql => sql.startsWith("SELECT")), true); assert.equal(JSON.stringify(value).includes("raw"), false);
});
test("纯组件比较：同trx但完成UTC不同是冲突，不产正式fact",()=>{
  const original={terminal:"SUCCEEDED",refundTransactionNo:"SYNTHETIC_TRX",completedAt:"2026-10-23T04:00:00.000Z"};
  assert.equal(refundTerminalConflicts(original,{...original}),false);
  assert.equal(refundTerminalConflicts(original,{...original,completedAt:"2026-10-23T04:00:01.000Z"}),true);
  assert.equal(refundTerminalConflicts(original,{...original,terminal:"FAILED_NO_EXECUTION"}),true);
});

test('native terminal review rechecks all signed observations without clearing conflicting evidence',async t=>{
  const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex'),rawProfile='{}';
  const row={id:'intent_1',posting_id:'posting_1',order_id:'order_1',payment_confirmation_id:'payment_1',renter_user_id:'renter_1',
    merchant_identity_id:'merchant_1',original_payment_trx_no:'trx_1',original_payment_order_no:'ORDER1',responsibility_version_hash:'a'.repeat(64),
    refund_order_no:'REFUND1',amount_cents:'100',state:'SUCCEEDED',requires_review:true,terminal_evidence_id:'proof_1'} as any;
  const fact={evidenceId:'rfe_'+sha(JSON.stringify([row.id,'original','SUCCEEDED'])).slice(0,40),intentId:row.id,postingId:row.posting_id,orderId:row.order_id,
    paymentConfirmationId:row.payment_confirmation_id,renterUserId:row.renter_user_id,merchantIdentityId:row.merchant_identity_id,
    originalPaymentTrxNo:row.original_payment_trx_no,originalPaymentOrderNo:row.original_payment_order_no,responsibilityVersionHash:row.responsibility_version_hash,
    refundOrderNo:row.refund_order_no,amountCents:row.amount_cents,currency:'CNY',terminal:'SUCCEEDED',refundTransactionNo:'CHANNEL1',completedAt:'2026-11-07T01:00:00.000Z',sourceObservationId:'original'};
  row.terminal_evidence_id=fact.evidenceId;const canonical=JSON.stringify(fact);
  let reviews=['processing'];
  const observation=(id:string)=>{const body=Buffer.from(id==='original'?'good':id);return {id,intent_id:row.id,operation:id==='processing'?'QUERY':'NOTIFY',
    raw_body:body,raw_sha256:sha(body),response_complete:true,http_status:id==='processing'?200:null,transport_failure:null,evidence_level:'PROVIDER_RESPONSE',event:id==='original'?'PENDING_TERMINAL':'REVIEW',
    profile_id:'profile_1',profile_canonical:rawProfile,profile_sha256:sha(rawProfile),key_version_ref:'key_1'};};
  const client={async query(sql:string,values:unknown[]){
    if(sql.includes('FROM zzsh_order.joinpay_refund_evidence'))return {rows:[{id:fact.evidenceId,intent_id:row.id,observation_id:'original',terminal:'SUCCEEDED',refund_transaction_no:'CHANNEL1',completed_at:fact.completedAt,facts_canonical:canonical,facts_digest:sha(canonical)}]};
    if(sql.includes("event='REVIEW'"))return {rows:reviews.map(id=>({id,signature_status:'MATCH',evidence_level:'PROVIDER_RESPONSE'}))};
    if(sql.includes('FROM zzsh_order.joinpay_refund_observation'))return {rows:[observation(String(values[0]))]};
    throw Error('unexpected query');
  }} as unknown as PoolClient;
  t.mock.method(refundStore,'assertRefundResource',async()=> '1');t.mock.method(refundStore,'lockFormalRefundContext',async()=>row);
  t.mock.method(refundStore,'formalRefundBinding',()=>({}) as any);t.mock.method(profile,'readFormalRefundAdmission',()=>({database:'synthetic',runtimeUser:'runtime'}) as any);
  t.mock.method(profile,'describeRefundProfile',()=>({profileId:'profile_1',profileSha256:sha(rawProfile),keyVersionRef:'key_1'}) as any);
  t.mock.method(profile,'assertFormalRefundProfile',()=>({}) as any);t.mock.method(profile,'readRefundProfileEvidence',()=>rawProfile);
  t.mock.method(profile,'refundCompleteTimeToUtc',()=>fact.completedAt);t.mock.method(profile,'refundWayAccepted',()=>true);
  t.mock.method(profile,'inspectRefundProfile',(...[_p,_op,body]:Parameters<typeof profile.inspectRefundProfile>)=>String(body)==='processing'?{signature:'MATCH',result:'PROCESSING'} as any:
    String(body)==='bad'?{signature:'MATCH',result:'UNVERIFIED'} as any:{signature:'MATCH',result:'CHANNEL_REPORTED_SUCCEEDED',
      providerRefundTrxNo:String(body)==='contradiction'?'OTHER':'CHANNEL1',completedAtRaw:'2026-11-07 09:00:00',refundWay:'ORIGINAL'} as any);
  const options={admission:{} as any,profileFor:()=>({} as any),keyFor:()=> 'synthetic'};
  assert.equal(await nativeTerminalReviewsConsistent(client,options,row),true);
  reviews=['good'];assert.equal(await nativeTerminalReviewsConsistent(client,options,row),true);
  reviews=['contradiction'];assert.equal(await nativeTerminalReviewsConsistent(client,options,row),false);
  reviews=['bad'];assert.equal(await nativeTerminalReviewsConsistent(client,options,row),false);
  reviews=[];assert.equal(await nativeTerminalReviewsConsistent(client,options,row),false);
});
