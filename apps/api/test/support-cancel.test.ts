// SYNTHETIC_COMPONENT_MODEL：真实eligibility/命令/router；PG、锁、渠道与银行到账均未运行。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { hashApprovalPayload } from "../src/auth/approval-audit";
import * as liability from "../src/finance/prestart-refund-liability";
import * as settlement from "../src/order/settlement-record";
import * as refundStore from "../src/order/prestart-refund-store";
import * as manualClose from "../src/order/manual-close";
import { readSupportCancellation, supportCancelAfterOpening,supportCancelOrder } from "../src/order/support-cancel";
import { assertSupportPoststartCancelInput, supportCancelEligibility, supportPoststartCancellationAllocation, supportPoststartCancellationEligibility, type SupportCancelFacts } from "../src/order/support-cancel-model";

const actor = { userId: "support_1", sessionId: "session_1" };
const source = { orderId: "order_1", renterUserId: "renter", ownerUserId: "owner", paymentConfirmationId: "pc_1", source: "JOINPAY" as const,
  merchantIdentityId: "merchant_1", merchantOrderNo: "ORIGINAL_1", channelTrxNo: "TRX_1", amountCents: "15908", currency: "CNY" as const };
const basis = { ...source, digest: hashApprovalPayload({ schema: "prestart-payment-basis.v1", ...source }).hash };
const excellent: SupportCancelFacts = { orderState: "PAID", paymentSource: "JOINPAY", paymentDisposition: "APPLIED", currency: "CNY",
  paidCents: "15908", orderCents: "15908", paymentBound: true, openingConfirmed: false, hasPosting: false,
  pendingSettlement: false, pendingAdjustment: false, monetaryEarningCount: "0", activeRefundCount: "0", otherTermination: false };

test('已开租特殊取消金额不超原款剩额，未分配部分计平台贡献且分销为零',()=>{
 assert.deepEqual(supportPoststartCancellationAllocation({paidCents:'10000',previouslyAllocatedCents:'0',refundCents:'5000',ownerCents:'3000'}),
  {paidCents:'10000',previouslyAllocatedCents:'0',refundCents:'5000',ownerCents:'3000',platformBeforePayoutFeeCents:'2000',commissionCents:'0'});
 for(const values of [
  {paidCents:'10000',previouslyAllocatedCents:'0',refundCents:'8000',ownerCents:'3000'},
  {paidCents:'10000',previouslyAllocatedCents:'2000',refundCents:'8001',ownerCents:'0'},
  {paidCents:'10000',previouslyAllocatedCents:'2000',refundCents:'8000',ownerCents:'0'},
  {paidCents:'10000',previouslyAllocatedCents:'0',refundCents:'1.50',ownerCents:'0'},
  {paidCents:'10000',previouslyAllocatedCents:'0',refundCents:'-1',ownerCents:'0'},
  {paidCents:'0',previouslyAllocatedCents:'0',refundCents:'0',ownerCents:'0'},
 ])assert.throws(()=>supportPoststartCancellationAllocation(values));
});
test('已开租客服取消不因未过账的结算草稿阻断，但拒绝已过账、原款不明或未清佣金',()=>{
 const opened={...excellent,openingConfirmed:true,pendingSettlement:true,pendingAdjustment:true};
 assert.equal(supportPoststartCancellationEligibility(opened).allowed,true);
 for(const patch of [{hasPosting:true},{paymentDisposition:'REVIEW_REQUIRED'},{monetaryEarningCount:'1'},
  {activeRefundCount:'1'},{otherTermination:true},{openingConfirmed:false}]){
  assert.equal(supportPoststartCancellationEligibility({...opened,...patch}).allowed,false);
 }
 assert.equal(supportPoststartCancellationEligibility({...opened,paymentSource:'CONTROLLED'}).allowed,false);
 assert.equal(supportPoststartCancellationEligibility({...opened,paymentSource:'CONTROLLED'},true).allowed,true);
});
test('客服特殊取消使用整分及明确原因，不接受浮点、负数或无效版本',()=>{
 const input={expectedOrderRevision:'2',reason:'客服协商取消',refundCents:'10000',ownerCents:'0'};
 assert.deepEqual(assertSupportPoststartCancelInput(input),input);
 for(const patch of [{refundCents:100},{ownerCents:'1.2'},{refundCents:'-1'},{expectedOrderRevision:'01'},
  {reason:'不行'},{reason:'原因\n换行'}])assert.throws(()=>assertSupportPoststartCancelInput({...input,...patch}));
});

type FactPatch = Partial<Record<string, unknown>>;
function factsRow(patch: FactPatch = {}) {
  return { id: "order_1", status: "PAID", revision: "1", paid_confirmation_id: "pc_1", renter_user_id: "renter", owner_user_id: "owner",
    cancel_reason: null, cancelled_at: null, confirmation_id: "pc_1", payment_source: "JOINPAY", disposition: "APPLIED",
    currency: "CNY", amount_cents: "15908", merchant_identity_id: "merchant_1", merchant_order_no: "ORIGINAL_1",
    channel_trx_no: "TRX_1", order_cents: "15908", opening_confirmed: false, has_posting: false, pending_settlement: false,
    pending_adjustment: false, earning_count: "0", active_refund_count: "0", other_termination: false, fixed_pricing:false, ...patch };
}
function termRow(patch: FactPatch = {}) {
  return { id: "pterm_existing", order_id: "order_1", state: "APPROVED", requested_by_party: "SUPPORT",
    requested_by_admin_user_id: "support_1", reason: "客服取消", last_reason: "客服取消", approved_at: "2026-10-30T00:00:00.000000Z",
    basis_digest: basis.digest, payment_basis: basis, liability_root_id: "prestart_refund_1", liability_event_id: "prestart_liability_1",
    ...patch };
}
function fixture(t: any, options: { facts?: FactPatch; current?: any; failOrderUpdate?: boolean; poststartReady?: boolean; fullPayoutSelected?: boolean | null; fixedFeeRate?:string|null; badFixedReceipt?:boolean } = {}) {
  const calls: { sql: string; values: any[] }[] = [];
  const recognized: { basis: any; policy?: string }[] = [];
  const audits: any[] = [];
  let current = options.current ?? null;
  const facts: any = { ...factsRow(options.facts) };
  const client = { query: async (sql: string, values: any[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith("SELECT o.id,o.status,o.revision")) return { rows: [facts], rowCount: 1 };
    if (sql.includes("to_regprocedure('zzsh_order.prestart_liability_complete")) return { rows: [{ ready: true }], rowCount: 1 };
    if (sql.includes("to_regprocedure('zzsh_order.cancel_order_after_start")) return { rows: [{ ready: options.poststartReady !== false }], rowCount: 1 };
    if (sql.includes("zzsh_order.fixed_fee_poststart_rate") && sql.includes(" AS rate"))
      return {rows:[{selected:options.fullPayoutSelected === undefined ? false : options.fullPayoutSelected,rate:options.fixedFeeRate === undefined ? '0.1' : options.fixedFeeRate}],rowCount:1};
    if (sql.startsWith("SELECT zzsh_order.poststart_full_payout_selected"))
      return {rows:[{selected:options.fullPayoutSelected === undefined ? false : options.fullPayoutSelected}],rowCount:1};
    if (sql.includes("SELECT zzsh_order.cancel_order_after_start")) {
      const refund=BigInt(values[2]),gross=BigInt(values[3]),paid=BigInt(facts.amount_cents);
      const selected=options.fullPayoutSelected === undefined ? false : options.fullPayoutSelected;
      const fee=selected?(gross*8n+50n)/100n:0n,service=sql.includes('cancel_order_after_start_v3')?(gross+5n)/10n:0n,owner=gross-fee-service;
      return {rows:[{value:{caseId:'case_1',orderId:values[0],status:'CANCELLED',paidCents:String(paid),refundCents:String(refund),
       ownerCents:String(owner),ownerGrossCents:String(gross),fullPayoutFeeCents:String(fee),fullPayoutSelected:selected,
       ...(sql.includes('cancel_order_after_start_v3')?{fixedFeeRate:options.fixedFeeRate??'0.1',platformServiceFeeCents:String(options.badFixedReceipt?service+1n:service)}:{}),
       platformContributionCents:String(paid-refund-owner),commissionCents:'0',channelResult:'NOT_SUBMITTED'}}],rowCount:1};
    }
    if (sql.startsWith("SELECT revision::text") && sql.includes("SUPPORT_AFTER_START_CANCELLED"))
      return {rows:[{revision:'2',cancelled_at:'2026-11-10T00:00:00.000000Z'}],rowCount:1};
    if (sql.includes("FROM zzsh_order.prestart_termination WHERE order_id=$1 AND requested_by_party='SUPPORT'")) return { rows: current ? [current] : [], rowCount: current ? 1 : 0 };
    if (sql.startsWith("INSERT INTO zzsh_order.prestart_termination_decision")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("INSERT INTO zzsh_order.prestart_termination")) return { rows: [{ id: values[0] }], rowCount: 1 };
    if (sql.startsWith("UPDATE zzsh_order.prestart_termination SET state='APPROVED'")) return { rows: [{ id: values[0] }], rowCount: 1 };
    if (sql.startsWith("UPDATE zzsh_order.prestart_termination SET liability_root_id")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("UPDATE zzsh_order.rental_order")) {
      if (options.failOrderUpdate) return { rows: [], rowCount: 0 };
      facts.status = "CANCELLED"; facts.cancel_reason = "SUPPORT_CANCELLED_REFUND"; facts.revision = "2"; facts.cancelled_at = "2026-10-30T00:00:00.000000Z";
      return { rows: [{ cancelledAt: facts.cancelled_at, revision: "2" }], rowCount: 1 };
    }
    if (sql.includes("FROM zzsh_order.prestart_termination WHERE id=$1")) return { rows: [termRow({ id: values[0], reason: termReason(values[0]) })], rowCount: 1 };
    if (sql.includes('"zzsh_iam"."audit_event"')) { audits.push(values); return { rows: [], rowCount: 1 }; }
    throw Error("Unexpected synthetic SQL: " + sql.slice(0, 120));
  } } as unknown as PoolClient;
  function termReason(id: string) { return id === "pterm_existing" ? "客服取消" : "客服取消订单并退款"; }
  t.mock.method(settlement, "lockSettlement", async (c: unknown, id: string, a: any, mode: unknown) => {
    assert.equal(c, client); assert.equal(id, "order_1"); assert.equal(mode, "PRESTART_TERMINATION"); assert.equal(a.realm, "admin");
    if (options.current) facts.status = "CANCELLED", facts.cancel_reason = "SUPPORT_CANCELLED_REFUND", facts.revision = "2";
    return facts as any;
  });
  t.mock.method(liability, "recognizePrestartRefundLiability", async (_c: unknown, id: string, b: any, _r: string, policy?: string) => {
    recognized.push({ basis: b, policy }); assert.equal(id.startsWith("pterm_"), true); return { rootId: "prestart_refund_1", eventId: "prestart_liability_1" };
  });
  t.mock.method(liability, "verifyPrestartRefundLiability", async () => ({} as any));
  t.mock.method(refundStore, "readPrestartRefundProgress", async () => ({ integration: "INTEGRATED", intents: [], truncated: false,
    totals: { originalCents: "15908", allocatedCents: "0", consumedCents: "0", releasedCents: "0", remainingCents: "15908", totalsComplete: true },
    completedLocallyAt: null, channelRecordsChecked: false, bankArrival: "UNKNOWN" } as any));
  t.mock.method(manualClose, "assertSupportOrderAccess", async () => {});
  return { client, calls, recognized, audits, facts };
}
const input = { orderId: "order_1", expectedOrderRevision: "1", reason: "客服核实后取消并全额退款", requestId: "req_1" };

test('客服开租后取消复用锁与原款守卫，按填写金额分配，不直接调用渠道',async t=>{
 const h=fixture(t,{facts:{opening_confirmed:true,pending_settlement:true,pending_adjustment:true}});
 const amountBasis='GROSS_BEFORE_FEE_V1' as const;
 await assert.rejects(supportCancelAfterOpening(h.client,actor,{...input,refundCents:'5000',ownerCents:'3000'}),/OWNER_AMOUNT_CONTRACT_REFRESH_REQUIRED/);
 const result=await supportCancelAfterOpening(h.client,actor,{...input,refundCents:'5000',ownerCents:'3000',ownerAmountBasis:amountBasis});
 assert.equal(result.status,200);assert.equal((result.body as any).poststartCancellation.refundCents,'5000');
 assert.equal((result.body as any).poststartCancellation.platformContributionCents,'7908');
 assert.equal((result.body as any).poststartCancellation.commissionCents,'0');
 assert.equal((result.body as any).channel.result,'NOT_SUBMITTED');
 assert(h.calls.some(c=>c.sql.includes('SELECT zzsh_order.cancel_order_after_start')));
 const bad=fixture(t,{facts:{opening_confirmed:true}});
 await assert.rejects(supportCancelAfterOpening(bad.client,actor,{...input,refundCents:'15000',ownerCents:'1000',ownerAmountBasis:amountBasis}),(e:any)=>e.status===409);
 assert.equal(bad.calls.some(c=>c.sql.includes('SELECT zzsh_order.cancel_order_after_start')),false);
 const partial=fixture(t,{facts:{opening_confirmed:true},poststartReady:false});
 await assert.rejects(supportCancelAfterOpening(partial.client,actor,{...input,refundCents:'5000',ownerCents:'3000',ownerAmountBasis:amountBasis}),(e:any)=>e.status===503);
 assert.equal(partial.calls.some(c=>c.sql.includes('SELECT zzsh_order.cancel_order_after_start')),false);
 const insured=fixture(t,{facts:{opening_confirmed:true},fullPayoutSelected:true});
 const withFee=await supportCancelAfterOpening(insured.client,actor,{...input,refundCents:'5000',ownerCents:'2000',ownerAmountBasis:amountBasis});
 assert.deepEqual([(withFee.body as any).poststartCancellation.ownerGrossCents,(withFee.body as any).poststartCancellation.fullPayoutFeeCents,(withFee.body as any).poststartCancellation.ownerCents],['2000','160','1840']);
 const unknown=fixture(t,{facts:{opening_confirmed:true},fullPayoutSelected:null});
 await assert.rejects(supportCancelAfterOpening(unknown.client,actor,{...input,refundCents:'5000',ownerCents:'2000',ownerAmountBasis:amountBasis}),/FULL_PAYOUT_UNKNOWN/);
 assert.equal(unknown.calls.some(c=>c.sql.includes('SELECT zzsh_order.cancel_order_after_start')),false);
});

test('fixed-fee special cancellation uses frozen gross fee and rejects an incomplete or changed receipt',async t=>{
 const facts={opening_confirmed:true,fixed_pricing:true,amount_cents:'10000',order_cents:'10000'};
 const input={orderId:'order_1',expectedOrderRevision:'1',reason:'双方协商取消',refundCents:'6000',ownerCents:'4000',ownerAmountBasis:'GROSS_BEFORE_FEE_V1' as const,requestId:'req_1'};
 const h=fixture(t,{facts,fullPayoutSelected:true,fixedFeeRate:'0.1'});
 const result=await supportCancelAfterOpening(h.client,actor,input);
 const record=(result.body as any).poststartCancellation;
 assert.deepEqual([record.ownerGrossCents,record.platformServiceFeeCents,record.fullPayoutFeeCents,record.ownerCents,record.platformContributionCents,record.commissionCents],['4000','400','320','3280','720','0']);
 assert(h.calls.some(c=>c.sql.includes('cancel_order_after_start_v3')));
 const bad=fixture(t,{facts,fullPayoutSelected:true,fixedFeeRate:'0.1',badFixedReceipt:true});
 await assert.rejects(supportCancelAfterOpening(bad.client,actor,input),/receipt differs/);
 const missing=fixture(t,{facts,fullPayoutSelected:true,fixedFeeRate:null});
 await assert.rejects(supportCancelAfterOpening(missing.client,actor,input),/basis is unavailable/);
 assert.equal(missing.calls.some(c=>c.sql.includes('SELECT zzsh_order.cancel_order_after_start_v3')),false);
});

test("未开租允许全额原款应退；已开租/结算/草稿/佣金/退款/终止阻断", () => {
  assert.deepEqual(supportCancelEligibility(excellent), { allowed: true, reason: null, refundCents: "15908", openingConfirmed: false });
  assert.equal(supportCancelEligibility({ ...excellent, openingConfirmed: true }).reason, "OPENING_ALREADY_CONFIRMED");
  const cases: Array<[Partial<SupportCancelFacts>, string]> = [
    [{ orderState: "COMPLETED" }, "ORDER_COMPLETED"], [{ orderState: "CANCELLED" }, "ORDER_NOT_PAID"],
    [{ hasPosting: true }, "SETTLEMENT_ALREADY_POSTED"], [{ pendingSettlement: true }, "SETTLEMENT_DRAFT_EXISTS"],
    [{ pendingAdjustment: true }, "MANUAL_ADJUSTMENT_REVIEW"], [{ monetaryEarningCount: "1" }, "DISTRIBUTION_RECONCILIATION_REQUIRED"],
    [{ activeRefundCount: "1" }, "REFUND_PENDING"], [{ otherTermination: true }, "TERMINATION_PENDING"],
    [{ paymentSource: "CONTROLLED" }, "PAYMENT_BASIS_UNAVAILABLE"], [{ paidCents: "15907" }, "PAYMENT_BASIS_UNAVAILABLE"],
  ];
  for (const [patch, reason] of cases) assert.equal(supportCancelEligibility({ ...excellent, ...patch }).reason, reason);
});

test("CONTROLLED 仅在服务端已确认演示准入时通过纯资格判断，金额和其他门禁不变",()=>{
  const demo={...excellent,paymentSource:'CONTROLLED'};
  assert.equal(supportCancelEligibility(demo).reason,'PAYMENT_BASIS_UNAVAILABLE');
  assert.equal(supportCancelEligibility(demo,true).allowed,true);
  assert.equal(supportCancelEligibility({...demo,paidCents:'1'},true).reason,'PAYMENT_BASIS_UNAVAILABLE');
  assert.equal(supportCancelEligibility({...demo,openingConfirmed:true},true).reason,'OPENING_ALREADY_CONFIRMED');
  assert.equal(supportCancelEligibility({...demo,activeRefundCount:'1'},true).reason,'REFUND_PENDING');
});

test("客服取消复用全额责任链：SUPPORT申请方、独立取消原因、不提交渠道、不伪造到账", async (t) => {
  const h = fixture(t);
  const result = await supportCancelOrder(h.client, actor, input);
  assert.equal(result.status, 200);
  assert.equal((result.body as any).orderStatus, "CANCELLED");
  assert.equal((result.body as any).cancelReason, "SUPPORT_CANCELLED_REFUND");
  assert.equal((result.body as any).channel.result, "NOT_SUBMITTED");
  assert.equal((result.body as any).channel.bankArrival, "UNKNOWN");
  assert.equal((result.body as any).supportCancellation.refundCents, "15908");
  const insert = h.calls.find(c => c.sql.startsWith("INSERT INTO zzsh_order.prestart_termination"))!;
  assert.match(insert.sql, /'SUPPORT'/);
  assert.deepEqual(insert.values.slice(0, 4), [insert.values[0], "order_1", "support_1", input.reason]);
  const decision = h.calls.find(c => c.sql.startsWith("INSERT INTO zzsh_order.prestart_termination_decision"))!;
  assert.match(decision.sql, /'SUPPORT_FULL_REFUND'/);
  assert.equal(decision.values[2], input.reason);
  assert.equal(h.recognized[0]!.policy, "support-full-refund.v1");
  assert.equal(h.recognized[0]!.basis.amountCents, "15908");
  const cancel = h.calls.find(c => c.sql.startsWith("UPDATE zzsh_order.rental_order"))!;
  assert.match(cancel.sql, /status='CANCELLED'/);
  assert.match(cancel.sql, /cancel_reason='SUPPORT_CANCELLED_REFUND'/);
  assert.equal(h.calls.some(c => /INSERT INTO zzsh_order\.(settlement_posting|rental_referral_earning|channel_refund_intent|joinpay_refund_attempt)/.test(c.sql)), false);
  assert.equal(h.calls.some(c => c.sql.includes("SET paid_confirmation_id") || c.sql.includes("SET paid_at")), false);
  assert.equal(h.audits.length, 1);
  assert.match(String(h.audits[0]![4]), /order\.support_cancel/);
  assert.match(String(h.audits[0]![10]), /SUPPORT_CANCELLED_REFUND/);
});

test("开租已确认不能生成全额应退；订单revision变化不产生新申请", async (t) => {
  const h = fixture(t, { facts: { opening_confirmed: true } });
  const result = await supportCancelOrder(h.client, actor, input);
  assert.equal(result.status, 409);
  assert.equal((result.body as any).reasons[0], "OPENING_ALREADY_CONFIRMED");
  assert.equal(h.recognized.length, 0);
  assert.equal(h.calls.some(c => /^(INSERT|UPDATE)/.test(c.sql)), false);
  const stale = fixture(t);
  const changed = await supportCancelOrder(stale.client, actor, { ...input, expectedOrderRevision: "9" });
  assert.equal(changed.status, 409);
  assert.equal((changed.body as any).reasons[0], "ORDER_CHANGED");
  assert.equal(stale.calls.some(c => c.sql.startsWith("INSERT INTO zzsh_order.prestart_termination")), false);
});

test("结算已生成、佣金/退款/终止未处理时返回原因并保持订单/责任不变", async (t) => {
  const cases: Array<[FactPatch, string]> = [
    [{ status: "COMPLETED" }, "ORDER_COMPLETED"],
    [{ has_posting: true }, "SETTLEMENT_ALREADY_POSTED"],
    [{ pending_settlement: true }, "SETTLEMENT_DRAFT_EXISTS"],
    [{ pending_adjustment: true }, "MANUAL_ADJUSTMENT_REVIEW"],
    [{ earning_count: "1" }, "DISTRIBUTION_RECONCILIATION_REQUIRED"],
    [{ active_refund_count: "1" }, "REFUND_PENDING"],
    [{ other_termination: true }, "TERMINATION_PENDING"],
    [{ payment_source: "CONTROLLED" }, "PAYMENT_BASIS_UNAVAILABLE"],
  ];
  for (const [patch, reason] of cases) {
    const h = fixture(t, { facts: patch });
    const result = await supportCancelOrder(h.client, actor, input);
    assert.equal(result.status, 409, reason);
    assert.equal((result.body as any).reasons[0], reason);
    assert.equal(h.calls.some(c => c.sql.startsWith("INSERT INTO zzsh_order.prestart_termination") || c.sql.startsWith("UPDATE zzsh_order.rental_order")), false);
    assert.equal(h.recognized.length, 0);
  }
});

test("重复/已存在的客服取消返回原事实，不重建责任；订单更新失败不写责任", async (t) => {
  const existing = fixture(t, { current: termRow(), facts: { status: "CANCELLED", cancel_reason: "SUPPORT_CANCELLED_REFUND", revision: "2", cancelled_at: "2026-10-30T00:00:00.000000Z" } });
  const replay = await supportCancelOrder(existing.client, actor, input);
  assert.equal(replay.status, 200);
  assert.equal((replay.body as any).existing, true);
  assert.equal(existing.calls.some(c => c.sql.startsWith("INSERT INTO zzsh_order.prestart_termination") || c.sql.startsWith("UPDATE zzsh_order.rental_order")), false);
  const failed = fixture(t, { failOrderUpdate: true });
  await assert.rejects(supportCancelOrder(failed.client, actor, input), (e: any) => e.status === 409);
  assert.equal(failed.calls.some(c => c.sql.startsWith("INSERT INTO zzsh_order.settlement_ledger_entry")), false);
});

test("只读预检返回原支付金额与退款进度；已有记录不暴露为可重复取消", async (t) => {
  const h = fixture(t, { facts: { opening_confirmed: true } });
  const preview = await readSupportCancellation(h.client, actor, "order_1");
  assert.equal(preview.eligibility.allowed, false);
  assert.equal(preview.eligibility.reason, "OPENING_ALREADY_CONFIRMED");
  assert.equal(preview.eligibility.refundCents, "15908");
  assert.equal(preview.openingConfirmed, true);
  assert.equal(preview.supportCancellation, null);
  const fixed = fixture(t, { facts: { opening_confirmed:true, fixed_pricing:true }, fullPayoutSelected:true, fixedFeeRate:'0.1' });
  const fixedPreview = await readSupportCancellation(fixed.client,actor,'order_1');
  assert.deepEqual([fixedPreview.poststartEligibility.allowed,fixedPreview.poststartEligibility.fullPayoutSelected,fixedPreview.poststartEligibility.fixedFeeRate],[true,true,'0.1']);
  const unavailable = fixture(t, { facts: { opening_confirmed:true, fixed_pricing:true },poststartReady:false });
  assert.equal((await readSupportCancellation(unavailable.client,actor,'order_1')).poststartEligibility.reason,'PAYMENT_BASIS_UNAVAILABLE');
  const existing = fixture(t, { current: termRow(), facts: { status: "CANCELLED", cancel_reason: "SUPPORT_CANCELLED_REFUND", revision: "2", cancelled_at: "2026-10-30T00:00:00.000000Z" } });
  const already = await readSupportCancellation(existing.client, actor, "order_1");
  assert.equal(already.eligibility.allowed, false);
  assert.equal(already.eligibility.reason, "ALREADY_CANCELLED");
  assert.equal(already.supportCancellation?.refundCents, "15908");
  assert.equal(existing.calls.some(c => /\b(INSERT|UPDATE|DELETE)\b/.test(c.sql)), false);
});

test("0134迁移与journal登记：独立原因、SUPPORT申请方、可重复执行", () => {
  const sql = readFileSync(resolve("migrations/business/0134_support_cancel.sql"), "utf8");
  assert.match(sql, /SUPPORT_CANCELLED_REFUND/);
  assert.match(sql, /requested_by_party IN\('RENTER','OWNER','SUPPORT'\)/);
  assert.match(sql, /SUPPORT_FULL_REFUND/);
  assert.match(sql, /support_cancel_payment_basis_valid\(jsonb\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS requested_by_admin_user_id/);
  assert.match(sql, /DROP TRIGGER IF EXISTS prestart_order_closure/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 134 && entry.tag === "0134_support_cancel"));
});
