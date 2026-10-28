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

test("C04B-02-R1 orders without refund readiness never reference refund relations", () => {
  const scoped = financeScopedVersionSql({ native_orders: true }, { mode: "document", documentRef: "ORDER:order_1" })!.text;
  const global = financeVersionSql({ native_orders: true });
  for (const text of [scoped, global]) {
    assert.doesNotMatch(text, /channel_refund_intent/);
    assert.doesNotMatch(text, /FROM zzsh_order\.payment_confirmation/);
    assert.doesNotMatch(text, /joinpay_refund_attempt/);
    assert.doesNotMatch(text, /zzsh_iam\.audit_event/);
  }
});

test("C04B-02-R1 refund intent scope includes original confirmation, attempts and blocked audit", () => {
  const text = financeScopedVersionSql(ready, { mode: "document", documentRef: "REFUND_INTENT:rfi_1" })!.text;
  assert.match(text, /joinpay_refund_attempt/);
  assert.match(text, /order\.refund\.abnormal\.first_submit\.blocked/);
  assert.match(text, /FROM zzsh_order\.payment_confirmation/);
  assert.match(text, /intent_id=\$1/);
});

test("C04B-02-R1 order scope includes abnormal roots/events/confirmation without posting", () => {
  const text = financeScopedVersionSql(ready, { mode: "document", documentRef: "ORDER:order_1" })!.text;
  assert.match(text, /NATIVE_ABNORMAL_REFUND/);
  assert.match(text, /NATIVE_RENTAL_REFUND/);
  assert.match(text, /FROM zzsh_order\.payment_confirmation/);
  assert.match(text, /joinpay_refund_attempt/);
  assert.match(text, /order\.refund\.abnormal\.first_submit\.blocked/);
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
  assert.match(globalReady, /order\.refund\.abnormal\.first_submit\.blocked/);
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
  assert.match(ledger,/finance_event_id IN/);assert.match(ledger,/NATIVE_ABNORMAL_REFUND/);
 }
});
test("Master R1: order token sees a review receipt before any refund intent exists",()=>{
 const text=financeScopedVersionSql(ready,{mode:"document",documentRef:"ORDER:order_1"})!.text;
 assert.match(text,/rel WHERE order_id=\$1/);
});
