// PLAN_ONLY与拒绝分支；没有正式渠道事实，也不证明PG或真实终态核销通过。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../src/auth/security-core";
import { consumeNativeRentalRefundTerminal, planNativeRentalRefundJournal } from "../src/finance/native-rental-refund-store";

const input = () => ({ intentId: "refund_synthetic_1", postingId: "posting_synthetic_1", paymentConfirmationId: "paid_synthetic_1",
  renterUserId: "renter_synthetic_1", refundOrderNo: "RF0123456789abcdef0123456789ab", amountCents: "15908", factsDigest: "a".repeat(64) });

test("原应退（包括租客押金）计划仅借应退责任、贷现有清算科目", () => {
  const p = planNativeRentalRefundJournal(input());
  assert.equal(p.evidenceLevel, "PLAN_ONLY");
  assert.deepEqual(p.lines.map(l => [l.account, l.debit, l.credit, l.subject]), [
    ["RENTER_REFUND_PAYABLE", "15908", "0", "renter_synthetic_1"], ["PAYOUT_CLEARING", "0", "15908", null],
  ]);
  assert.equal(p.lines.reduce((n, l) => n + BigInt(l.debit) - BigInt(l.credit), 0n), 0n);
  assert.equal(p.lines.some(l => String(l.account) === "WALLET_AVAILABLE"), false);
});

test("最大合法分值用字符串与BigInt精确守恒", () => {
  const p = planNativeRentalRefundJournal({ ...input(), amountCents: "9999999999999999" });
  assert.equal(p.lines[0]!.debit, "9999999999999999");
  assert.equal(p.lines[1]!.credit, p.lines[0]!.debit);
});

test("零负数、小数、浮点、非规范文本和上限之外金额不能形成账务计划", () => {
  for (const amountCents of ["0", "-1", "1.00", "01", " 1", "1e2", "10000000000000000", 1, null]) {
    assert.throws(() => planNativeRentalRefundJournal({ ...input(), amountCents } as any));
  }
});

test("原intent唯一确定root与事件，不按profile或钥版本拆资金身份", () => {
  const p = planNativeRentalRefundJournal(input()), repeated = planNativeRentalRefundJournal(input());
  assert.equal(p.rootId, repeated.rootId); assert.equal(p.eventId, repeated.eventId);
  assert.notEqual(p.rootId, planNativeRentalRefundJournal({ ...input(), intentId: "refund_synthetic_2" }).rootId);
  assert.equal(p.lines[0]!.id, `${p.eventId}_1`); assert.equal(p.lines[1]!.id, `${p.eventId}_2`);
});

test("计划精确绑定原posting、原付款、原退款号与证据摘要，并冻结分录", () => {
  const p = planNativeRentalRefundJournal(input());
  assert.deepEqual(p.lines[0]!.details, { nativeRefundIntentId: input().intentId, postingId: input().postingId,
    paymentConfirmationId: input().paymentConfirmationId, refundOrderNo: input().refundOrderNo, factsDigest: input().factsDigest });
  assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(p.lines)); assert.ok(Object.isFrozen(p.lines[0]));
  assert.ok(Object.isFrozen(p.lines[0]!.details));
  assert.throws(() => planNativeRentalRefundJournal({ ...input(), factsDigest: "not-a-digest" }));
});

test("直接HTTP事实、官方标签、旧CONTROLLED、旧合成结果不能调用财务消费", async () => {
  let queries = 0;
  const client = { query: async () => { queries++; throw new Error("UNEXPECTED_FINANCE_QUERY"); } } as unknown as PoolClient;
  for (const fact of [null, {}, { source: "JOINPAY", terminal: "SUCCEEDED", verified: true, ...input() },
    { evidenceLevel: "OFFICIAL", formalRefund: true }, { evidenceLevel: "CONTROLLED_TEST", terminal: "SUCCEEDED" },
    { evidenceLevel: "SYNTHETIC_PROTOCOL", terminal: "SUCCEEDED" }]) {
    await assert.rejects(consumeNativeRentalRefundTerminal(client, { fact, requestId: "synthetic_req_1" }));
  }
  assert.equal(queries, 0);
});

test("纯计划及JSON克隆均没有同client+xid的终态事实品牌", async () => {
  let queries = 0;
  const client = { query: async () => { queries++; throw new Error("UNEXPECTED_FINANCE_QUERY"); } } as unknown as PoolClient;
  const p = planNativeRentalRefundJournal(input());
  await assert.rejects(consumeNativeRentalRefundTerminal(client, { fact: p, requestId: "synthetic_req_2" }));
  await assert.rejects(consumeNativeRentalRefundTerminal(client, { fact: JSON.parse(JSON.stringify(p)), requestId: "synthetic_req_2" }));
  assert.equal(queries, 0);
});

test("请求ID先校验，不因无效入参读库或取得新事实", async () => {
  let queries = 0;
  const client = { query: async () => { queries++; throw new Error("UNEXPECTED_FINANCE_QUERY"); } } as unknown as PoolClient;
  await assert.rejects(consumeNativeRentalRefundTerminal(client, { fact: {}, requestId: "\n" }));
  assert.equal(queries, 0);
});
test("SYNTHETIC_COMPONENT_MODEL：假设fact-reader成立，ledger/audit错误均回滚；不是正式来源或PG通过",async t=>{
  const source=require("../src/order/joinpay-refund-source");
  const fact={...input(),evidenceId:"evidence_model",orderId:"order_model",merchantIdentityId:"merchant_model",originalPaymentTrxNo:"paid_trx_model",originalPaymentOrderNo:"ORDER_MODEL",
    responsibilityVersionHash:"b".repeat(64),currency:"CNY",terminal:"SUCCEEDED",refundTransactionNo:"refund_trx_model",completedAt:"2026-10-23T04:00:00.000Z",sourceObservationId:"obs_model"};
  t.mock.method(source,"assertJoinpayRefundTerminalFact",async()=>fact);
  for(const fault of ["NONE","LEDGER","AUDIT","FAILED_NO_EXECUTION"]){
    fact.terminal=fault==="FAILED_NO_EXECUTION"?"FAILED_NO_EXECUTION":"SUCCEEDED";
    const row:any={id:fact.intentId,posting_id:fact.postingId,order_id:fact.orderId,payment_confirmation_id:fact.paymentConfirmationId,renter_user_id:fact.renterUserId,
      merchant_identity_id:fact.merchantIdentityId,original_payment_trx_no:fact.originalPaymentTrxNo,original_payment_order_no:fact.originalPaymentOrderNo,responsibility_version_hash:fact.responsibilityVersionHash,
      refund_order_no:fact.refundOrderNo,amount_cents:fact.amountCents,currency:"CNY",payment_source:"JOINPAY",evidence_level:"JOINPAY_FORMAL",state:"UNKNOWN",budget_disposition:"ALLOCATED",requires_review:false,
      terminal_evidence_id:null,terminal_root_id:null,terminal_event_id:null,provider_refund_trx_no:null,completed_at:null,revision:"1"};
    const state={row,roots:[] as any[],events:[] as any[],entries:[] as any[],audits:[] as any[],revision:"2"};let before:any;
    const client={release(){},async query(sql:string,p:any[]=[]):Promise<any>{
      if(sql==="BEGIN"){before=structuredClone(state);return{rows:[]};}if(sql==="COMMIT")return{rows:[]};if(sql==="ROLLBACK"){Object.assign(state,before);return{rows:[]};}
      if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};if(sql.includes('SELECT id FROM zzsh_auth_user.'))return{rows:[{id:fact.renterUserId}],rowCount:1};
      if(sql.includes("SELECT ledger_revision"))return{rows:[{ledger_revision:state.revision}]};if(sql.includes("FROM zzsh_order.channel_refund_intent WHERE id=$1 FOR UPDATE"))return{rows:[structuredClone(state.row)]};
      if(sql.includes("native refund original immutable liability"))return{rows:[{valid:true}]};
      if(sql.includes("INSERT INTO zzsh_order.finance_economic_root")){state.roots.push(p);return{rows:[]};}
      if(sql.includes("INSERT INTO zzsh_order.finance_event")){state.events.push(p);state.revision=String(BigInt(state.revision)+1n);return{rows:[]};}
      if(sql.includes("INSERT INTO zzsh_order.settlement_ledger_entry")){if(fault==="LEDGER"&&state.entries.length===1)throw Error("MODEL_LEDGER_FAILED");state.entries.push(p);return{rows:[]};}
      if(sql.startsWith("UPDATE zzsh_order.channel_refund_intent")){Object.assign(state.row,{state:p[1],budget_disposition:p[2],terminal_evidence_id:p[3]});return{rows:[],rowCount:1};}
      if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')){if(fault==="AUDIT")throw Error("MODEL_AUDIT_FAILED");state.audits.push(p);return{rows:[]};}
      throw Error("UNEXPECTED_FINANCE_COMPONENT_SQL");
    }} as unknown as PoolClient;
    const run=()=>withTransaction({connect:async()=>client} as Pool,c=>consumeNativeRentalRefundTerminal(c,{fact:{ASSUMED_COMPONENT_READER:true},requestId:"component_1"}));
    if(fault==="LEDGER"||fault==="AUDIT"){
      await assert.rejects(run(),/MODEL_.*_FAILED/);assert.equal(state.entries.length,0);assert.equal(state.events.length,0);assert.equal(state.roots.length,0);assert.equal(state.audits.length,0);
      assert.equal(state.revision,"2");assert.equal(state.row.budget_disposition,"ALLOCATED");
    }else{
      const result=await run();assert.equal(result.event,fault==="NONE"?"CONSUMED":"RELEASED");assert.equal(state.entries.length,fault==="NONE"?2:0);
      assert.equal(state.revision,fault==="NONE"?"3":"2");assert.equal(state.audits.length,1);
      if(fault==="NONE")assert.deepEqual(state.entries.map(p=>p[3]),["RENTER_REFUND_PAYABLE","PAYOUT_CLEARING"]);
    }
  }
});
