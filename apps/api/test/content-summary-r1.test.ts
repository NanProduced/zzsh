import assert from "node:assert/strict";
import { test } from "node:test";
import { financeScopedVersionSql, financeVersionSql } from "../src/finance/admin-finance-query";

const ready = { refund_intents: true, refund_read_dependencies: true, native_orders: true, payment_requests: true, joinpay_withdrawals: true } as const;
const scopes = [
  { mode: "document", documentRef: "ORDER:order_1" },
  { mode: "subject", subjectId: "user_1" },
  { mode: "document", documentRef: "REFUND_INTENT:rfi_1" },
  { mode: "document", documentRef: "PAYMENT_REQUEST:payreq_1" },
  { mode: "document", documentRef: "JOINPAY_WITHDRAWAL:jwd_1" },
] as const;

test("C04B-02-R1 all supported scopes remain exact with one outer WHERE per relation", () => {
  for (const scope of scopes) {
    const result = financeScopedVersionSql(ready, scope as never);
    assert.notEqual(result, null, JSON.stringify(scope));
    assert.doesNotMatch(result!.text, /WHERE i\.posting_id IS NULL WHERE/);
    assert.doesNotMatch(result!.text, /WHERE a\.action='order\.refund\.abnormal\.first_submit\.blocked' WHERE/);
    assert.match(result!.text, /SELECT \* FROM \(SELECT[\s\S]*?\) rel WHERE /);
  }
});

test("C04B-02-R1 orders without refund readiness version their payment lifecycle without refund dependencies", () => {
  const scoped = financeScopedVersionSql({ native_orders: true }, { mode: "document", documentRef: "ORDER:order_1" })!.text;
  const global = financeVersionSql({ native_orders: true });
  for (const text of [scoped, global]) {
    assert.doesNotMatch(text, /channel_refund_intent/);
    assert.match(text, /SELECT id,order_id,source,disposition,amount_cents::text,currency,accepted_at FROM zzsh_order\.payment_confirmation/);
    assert.doesNotMatch(text, /merchant_scope_id|provider_transaction_id|joinpay_evidence_id/);
    assert.doesNotMatch(text, /joinpay_refund_attempt/);
    assert.doesNotMatch(text, /zzsh_iam\.audit_event/);
  }
  assert.match(scoped,/FROM zzsh_order\.payment_confirmation WHERE order_id IN\(SELECT id FROM zzsh_order\.rental_order WHERE id=\$1\)/);
  assert.doesNotMatch(financeVersionSql({native_orders:false}),/FROM zzsh_order\.payment_confirmation/);
});

test("refund intent scope includes original confirmation and attempts", () => {
  const text = financeScopedVersionSql(ready, { mode: "document", documentRef: "REFUND_INTENT:rfi_1" })!.text;
  assert.match(text, /joinpay_refund_attempt/);
  assert.doesNotMatch(text, /order\.refund\.abnormal\.first_submit\.blocked/);
  assert.match(text, /FROM zzsh_order\.payment_confirmation/);
  assert.match(text, /intent_id=\$1/);
});

test("order scope includes normal refund roots and payment confirmation", () => {
  const text = financeScopedVersionSql(ready, { mode: "document", documentRef: "ORDER:order_1" })!.text;
  assert.match(text, /source_kind<>'NATIVE_ABNORMAL_REFUND'/);
  assert.match(text, /NATIVE_RENTAL_REFUND/);
  assert.match(text, /basis_kind='PRESTART_TERMINATION'/);
  assert.match(text, /FROM zzsh_order\.payment_confirmation/);
  assert.match(text, /joinpay_refund_attempt/);
  assert.doesNotMatch(text, /order\.refund\.abnormal\.first_submit\.blocked/);
});

test("native order finance keeps a scoped version when legacy withdrawal links exist", () => {
  const scope = { mode: "document", documentRef: "ORDER:order_1" } as const;
  const scoped = financeScopedVersionSql({ ...ready, legacy_withdrawal_links: true }, scope);
  assert.ok(scoped);
  assert.match(scoped.text, /legacy_withdrawal_subject_revision WHERE 1=0/);
  assert.match(scoped.text, /legacy_withdrawal_link_evidence WHERE 1=0/);
  assert.match(scoped.text, /settlement_posting WHERE order_id=\$1/);
  assert.deepEqual(scoped.values, ["order_1"]);
});

test("C04B-02-R1 missing attempt/audit/confirmation readiness does not query new sources", () => {
  const safe = financeScopedVersionSql({ ...ready, refund_read_dependencies: false }, { mode: "document", documentRef: "REFUND_INTENT:rfi_1" });
  assert.notEqual(safe, null);
  assert.doesNotMatch(safe!.text, /joinpay_refund_attempt/);
  assert.doesNotMatch(safe!.text, /order\.refund\.abnormal\.first_submit\.blocked/);
  const globalSafe = financeVersionSql({ refund_intents: true, refund_read_dependencies: false });
  assert.doesNotMatch(globalSafe, /joinpay_refund_attempt/);
  const globalReady = financeVersionSql(ready);
  assert.match(globalReady, /joinpay_refund_attempt/);
  assert.doesNotMatch(globalReady, /order\.refund\.abnormal\.first_submit\.blocked/);
});

test("Master R1: absent dependency readiness must stay closed",()=>{
 for(const scope of scopes){
  const result=financeScopedVersionSql({...ready,refund_read_dependencies:undefined},scope as never);
  assert.notEqual(result,null);
  assert.doesNotMatch(result!.text,/joinpay_refund_attempt|order\.refund\.abnormal\.first_submit\.blocked/);
 }
 assert.doesNotMatch(financeVersionSql({refund_intents:true}),/joinpay_refund_attempt/);
});
test("Master R1: single refund and payment request track their no-posting ledger and roots",()=>{
 for(const documentRef of ["REFUND_INTENT:rfi_1","PAYMENT_REQUEST:payreq_1"]){
  const text=financeScopedVersionSql(ready,{mode:"document",documentRef})!.text;
  assert.doesNotMatch(text,/source_digest,policy_version FROM zzsh_order\.finance_economic_root WHERE 1=0/);
  assert.doesNotMatch(text,/created_at FROM zzsh_order\.finance_event WHERE 1=0/);
  const start=text.indexOf("details,created_at FROM zzsh_order.settlement_ledger_entry WHERE");
  assert(start>=0);const ledger=text.slice(start,text.indexOf(") v)",start));
  assert.match(ledger,/finance_event_id IN/);assert.match(ledger,/NATIVE_RENTAL_REFUND/);
 }
});
test("Master R1: order token sees a review receipt before any refund intent exists",()=>{
 const text=financeScopedVersionSql(ready,{mode:"document",documentRef:"ORDER:order_1"})!.text;
 assert.match(text,/rel WHERE order_id=\$1/);
});
