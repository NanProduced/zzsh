import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { assertJoinpayRefundTerminalFact, readVerifiedRefundTerminalFact, captureRefundTerminalFact, refundTerminalConflicts } from "../src/order/joinpay-refund-source";
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
