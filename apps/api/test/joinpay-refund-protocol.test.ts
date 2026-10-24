// SYNTHETIC_PROTOCOL；固定期望摘要另用 .NET MD5/UTF-8 计算，非官方验签向量。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JOINPAY_REFUND_PROFILE, JOINPAY_REFUND_SIGNATURE_ORDER, buildJoinpayRefundQuery, buildJoinpayRefundRequest,
  evaluateJoinpayRefundResponse, computeJoinpayRefundResponse, computeJoinpayRefundRequest, validateJoinpayRefundRequestInput, type JoinpayRefundBinding } from "../src/order/joinpay-refund-protocol";

const KEY = "SYNTHETIC_REFUND_KEY_0001", MER = "888000000000005", ORIGINAL = "ZZ20261019-000002", REFUND = "RF_SYNTH_0001", TRX = "SYNTH_RTX_0001";
const binding: JoinpayRefundBinding = { merchantNo: MER, originalPaymentOrderNo: ORIGINAL, refundOrderNo: REFUND, amountCents: "125", currency: "CNY", fundsAccount: "SETTLED" };
const expected = {
  refundRequest: ["p0_Version", "p1_MerchantNo", "p2_OrderNo", "p3_RefundOrderNo", "p4_RefundAmount", "p5_RefundReason", "p6_NotifyUrl", "pa_FundsAccount"],
  refundResponse: ["r0_Version", "r1_MerchantNo", "r2_OrderNo", "r3_RefundOrderNo", "r4_RefundAmount", "r5_RefundTrxNo", "ra_Status", "rb_Code", "rc_CodeMsg", "re_FundsAccount"],
  refundNotify: ["r0_Version", "r1_MerchantNo", "r2_OrderNo", "r3_RefundOrderNo", "r4_RefundAmount", "r5_RefundTrxNo", "r6_RefundCompleteTime", "r7_RefundWay", "r8_ReceiveAccountNo", "ra_Status", "rb_Code", "rc_CodeMsg", "rd_MarketRefAmount", "re_FundsAccount"],
  queryRefundRequest: ["p0_Version", "p1_MerchantNo", "p2_RefundOrderNo"],
  queryRefundResponse: ["r0_Version", "r1_MerchantNo", "r2_RefundOrderNo", "r3_RefundAmount", "r4_RefundTrxNo", "r5_RefundCompleteTime", "r8_RefundWay", "r9_ReceiveAccountNo", "ra_Status", "rb_Code", "rc_CodeMsg", "rd_MarketRefAmount", "re_FundsAccount"],
};
type Values = Record<string, string | undefined>;
const sign = (order: readonly string[], v: Values) => createHash("md5").update(order.map(k => v[k] ?? "").join("") + KEY).digest("hex");
const sync: Values = { r0_Version: "2.3", r1_MerchantNo: MER, r2_OrderNo: ORIGINAL, r3_RefundOrderNo: REFUND, r4_RefundAmount: "1.25", r5_RefundTrxNo: TRX, ra_Status: "100", rb_Code: "100", rc_CodeMsg: "", re_FundsAccount: "SETTLED" };
const notify: Values = { ...sync, r6_RefundCompleteTime: "2026-10-23 08:00:00", r7_RefundWay: "ORIGINAL", r8_ReceiveAccountNo: "尾号0000", rd_MarketRefAmount: "0.00" };
const query: Values = { r0_Version: "2.3", r1_MerchantNo: MER, r2_RefundOrderNo: REFUND, r3_RefundAmount: "1.25", r4_RefundTrxNo: TRX,
  r5_RefundCompleteTime: "2026-10-23 08:00:00", r8_RefundWay: "ORIGINAL", r9_ReceiveAccountNo: "尾号0000", ra_Status: "100", rb_Code: "100", rc_CodeMsg: "", rd_MarketRefAmount: "0.00", re_FundsAccount: "SETTLED" };
function body(operation: "REFUND_SYNC" | "REFUND_QUERY" | "REFUND_NOTIFY", patch: Values = {}, fixed?: string): string {
  const v = { ...(operation === "REFUND_SYNC" ? sync : operation === "REFUND_QUERY" ? query : notify), ...patch };
  const order = operation === "REFUND_SYNC" ? expected.refundResponse : operation === "REFUND_QUERY" ? expected.queryRefundResponse : expected.refundNotify;
  const entries = Object.entries(v).filter((e): e is [string, string] => e[1] !== undefined);
  return operation === "REFUND_NOTIFY" ? new URLSearchParams([...entries, ["hmac", fixed ?? sign(order, v)]]).toString() : JSON.stringify({ ...v, hmac: fixed ?? sign(order, v) });
}
const evaluate = (operation: "REFUND_SYNC" | "REFUND_QUERY" | "REFUND_NOTIFY", patch: Values = {}, bound: JoinpayRefundBinding | null = binding) =>
  evaluateJoinpayRefundResponse(operation, body(operation, patch), { binding: bound, key: KEY, leaseCurrent: true });
test("中性协议计算去掉合成/正式标签，旧evaluate固定保留SYNTHETIC形状",()=>{
  const raw=body("REFUND_QUERY"),neutral=computeJoinpayRefundResponse("REFUND_QUERY",raw,{binding,key:KEY,leaseCurrent:true}),old=evaluateJoinpayRefundResponse("REFUND_QUERY",raw,{binding,key:KEY,leaseCurrent:true});
  assert.equal(neutral.signature,"MATCH");assert.equal(neutral.result,old.result);assert.equal("formalRefund" in neutral,false);assert.equal("officialVerified" in neutral,false);
  assert.equal(old.signature,"SYNTHETIC_SELF_CONSISTENT");assert.equal(old.evidenceLevel,"SYNTHETIC_PROTOCOL");assert.equal(old.formalRefund,false);
  const input={...binding,notifyUrl:"https://example.invalid/refund"};validateJoinpayRefundRequestInput(input);
  assert.equal(computeJoinpayRefundRequest(input,KEY).hmac,buildJoinpayRefundRequest(input,KEY).hmac);assert.throws(()=>validateJoinpayRefundRequestInput({...input,notifyUrl:"http://invalid"}));
});

test("五个操作独立签名表来自 S64/S177，不混用收款2.6字段", () => {
  assert.deepEqual(JOINPAY_REFUND_SIGNATURE_ORDER, expected);
  const request = buildJoinpayRefundRequest({ ...binding, reason: "synthetic", notifyUrl: "https://example.invalid/refund" }, KEY);
  assert.equal(request.hmac, "860ade45fc8bcb00ab09992a83ad6722"); assert.equal(request.sendable, false);
  assert.equal(new Map(request.fields).get("p0_Version"), "2.3"); assert.equal(new Map(request.fields).get("p2_OrderNo"), ORIGINAL);
  assert.equal(new Map(request.fields).has("p0_version"), false);
  assert.equal(buildJoinpayRefundQuery(binding, KEY).hmac, "d103fdf51f5ac2b359728415940cd0da");
});

test("独立.NET固定合成摘要：同步受理与查询/通知终态不混淆", () => {
  for (const [op, hmac, status] of [["REFUND_SYNC", "9cd1184f290af00bf305b54075533839", "APPLICATION_ACCEPTED"],
    ["REFUND_NOTIFY", "a09d1830f1a5f93b52c0dfbeca2d7e85", "CHANNEL_REPORTED_SUCCEEDED"],
    ["REFUND_QUERY", "9b4bbd6a2cb37a2c254d846e91e94fb5", "CHANNEL_REPORTED_SUCCEEDED"]] as const) {
    const r = evaluateJoinpayRefundResponse(op, body(op, {}, hmac), { binding, key: KEY, leaseCurrent: true });
    assert.equal(r.result, status); assert.equal(r.signature, "SYNTHETIC_SELF_CONSISTENT"); assert.equal(r.formalRefund, false); assert.equal(r.officialVerified, false);
  }
});

test("110、重复号、记录不存在与已退款均沿原退款号查询，不换号或补成功", () => {
  for (const op of ["REFUND_SYNC", "REFUND_QUERY", "REFUND_NOTIFY"] as const) for (const code of ["0", "4", "110", "20090012", "20090004", "CR000007"]) {
    const r = evaluate(op, { rb_Code: code }); assert.equal(r.result, "ORIGINAL_REFUND_QUERY_REQUIRED"); assert.equal(r.formalRefund, false);
    if (op === "REFUND_NOTIFY") assert.equal(r.ack, "fail");
  }
  assert.equal(evaluate("REFUND_SYNC", { ra_Status: "101", rb_Code: "20090002" }).result, "APPLICATION_REJECTED");
  assert.equal(evaluate("REFUND_SYNC", { ra_Status: "101", rb_Code: "UNKNOWN_CODE" }).result, "ORIGINAL_REFUND_QUERY_REQUIRED");
});

test("查询处理中/失败是不同分支；同步100不等于退款完成", () => {
  const failed = { r4_RefundTrxNo: TRX, r5_RefundCompleteTime: undefined, r8_RefundWay: undefined, r9_ReceiveAccountNo: undefined, ra_Status: "101", rb_Code: "CR000009" };
  const processing = { ...failed, r4_RefundTrxNo: undefined, ra_Status: "102", rb_Code: "100" };
  assert.equal(evaluateJoinpayRefundResponse("REFUND_QUERY", body("REFUND_QUERY", failed, "872513bb6b772a338f6be05843fe0c33"), { binding, key: KEY, leaseCurrent: true }).result, "CHANNEL_REPORTED_FAILED");
  assert.equal(evaluateJoinpayRefundResponse("REFUND_QUERY", body("REFUND_QUERY", processing, "71781baf283a1444e7f103320ab21693"), { binding: { ...binding, providerRefundTrxNo: TRX }, key: KEY, leaseCurrent: true }).result, "PROCESSING");
  assert.equal(evaluate("REFUND_NOTIFY", { ra_Status: "102" }).reason, "NOTIFY_STATUS_102_CONFLICT");
  assert.equal(evaluate("REFUND_QUERY", { ra_Status: "102", rb_Code: "CR000009" }).reason, "STATUS_CODE_CONFLICT");
  assert.equal(evaluate("REFUND_SYNC").result, "APPLICATION_ACCEPTED");
});

test("未知/缺状态、缺成功流水或完成时间，均不成为退款成功", () => {
  assert.equal(evaluate("REFUND_QUERY", { ra_Status: undefined }).reason, "STATUS_MISSING");
  assert.equal(evaluate("REFUND_QUERY", { ra_Status: "" }).reason, "STATUS_MISSING");
  assert.equal(evaluate("REFUND_QUERY", { ra_Status: "999" }).reason, "STATUS_UNKNOWN");
  assert.equal(evaluate("REFUND_QUERY", { r4_RefundTrxNo: undefined }).reason, "REFUND_TRANSACTION_MISSING");
  assert.equal(evaluate("REFUND_QUERY", { r5_RefundCompleteTime: undefined }).reason, "COMPLETION_TIME_MISSING");
  assert.equal(evaluate("REFUND_NOTIFY", { r6_RefundCompleteTime: undefined }).ack, "fail");
});

test("签名、商户/原付款/原退款/金额/资金账户/已知退款流水逐项绑定", () => {
  for (const patch of [{ r1_MerchantNo: "888000000000099" }, { r2_OrderNo: "other" }, { r3_RefundOrderNo: "other" }, { r4_RefundAmount: "1.26" }, { re_FundsAccount: "ADVANCE" }]) {
    assert.equal(evaluate("REFUND_NOTIFY", patch).reason, "BINDING_MISMATCH");
  }
  assert.equal(evaluate("REFUND_QUERY", { r4_RefundTrxNo: "OTHER" }, { ...binding, providerRefundTrxNo: TRX }).reason, "REFUND_TRANSACTION_MISMATCH");
  assert.equal(evaluateJoinpayRefundResponse("REFUND_NOTIFY", body("REFUND_NOTIFY", {}, "0".repeat(32)), { binding, key: KEY }).signature, "MISMATCH");
  assert.equal(evaluate("REFUND_NOTIFY", {}, null).reason, "BINDING_NOT_FOUND");
  assert.equal(evaluate("REFUND_QUERY", {}, { ...binding, currency: "USD" as never }).reason, "REFUND_CURRENCY_NOT_SUPPORTED");
});

test("缺必填字段、不支持的营销退款和状态/响应码矛盾拒绝", () => {
  assert.equal(evaluate("REFUND_NOTIFY", { rd_MarketRefAmount: undefined }).reason, "PROTOCOL_FIELD_MISSING");
  assert.equal(evaluate("REFUND_NOTIFY", { rd_MarketRefAmount: "1.00" }).reason, "MARKET_REFUND_AMOUNT_REVIEW");
  assert.equal(evaluate("REFUND_QUERY", { ra_Status: "100", rb_Code: "CR000009" }).reason, "STATUS_CODE_CONFLICT");
  assert.equal(evaluate("REFUND_QUERY", { ra_Status: "101", rb_Code: "100" }).reason, "STATUS_CODE_CONFLICT");
  assert.equal(evaluate("REFUND_QUERY", { rd_MarketRefAmount: "" }).result, "CHANNEL_REPORTED_SUCCEEDED");
  assert.equal(evaluate("REFUND_NOTIFY", { r7_RefundWay: "UNKNOWN_ROUTE" }).reason, "REFUND_WAY_UNKNOWN");
  const redirected = evaluate("REFUND_NOTIFY", { r7_RefundWay: "OTHER_BANKCARD" });
  assert.equal(redirected.result, "CHANNEL_REPORTED_SUCCEEDED"); assert.equal(redirected.refundWay, "OTHER_BANKCARD"); assert.equal(redirected.formalRefund, false);
});

test("原始GET只解码一次，重复/畸形/未知字段/空白/非标日历拒绝", () => {
  const base = body("REFUND_NOTIFY");
  for (const bad of [base + "&r1_MerchantNo=dup", base + "&x=%ZZ", base + "&x=%C0%AF", base + "&extra=nonempty"]) {
    assert.equal(evaluateJoinpayRefundResponse("REFUND_NOTIFY", bad, { binding, key: KEY }).ack, "fail");
  }
  assert.equal(evaluate("REFUND_NOTIFY", { r1_MerchantNo: " " + MER }).reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(evaluate("REFUND_NOTIFY", { r6_RefundCompleteTime: "2026-02-30 08:00:00" }).reason, "PROTOCOL_FIELD_PATTERN");
  assert.equal(evaluate("REFUND_NOTIFY", { r6_RefundCompleteTime: "2026-10-23%2008:00:00" }).reason, "PROTOCOL_FIELD_PATTERN");
});

test("JSON重复键/嵌套、孤立代理和非MD5格式不能验签；数字token按原文保留", () => {
  const valid = body("REFUND_QUERY");
  const bad = ['{"r0_Version":"2.3","r0_Version":"2.3"}', '{"x":{}}', '{"x":"\\ud800"}'];
  for (const b of bad) assert.equal(evaluateJoinpayRefundResponse("REFUND_QUERY", b, { binding, key: KEY, leaseCurrent: true }).result, "UNVERIFIED");
  const numeric = valid.replace('"1.25"', '1.25');
  const r = evaluateJoinpayRefundResponse("REFUND_QUERY", numeric, { binding, key: KEY, leaseCurrent: true });
  assert.equal(r.result, "CHANNEL_REPORTED_SUCCEEDED"); assert.deepEqual(r.numberTokens, ["r3_RefundAmount"]); assert.equal(r.officialVerified, false);
  assert.equal(evaluateJoinpayRefundResponse("REFUND_QUERY", valid.replace(/"hmac":"[^"]+"/, '"hmac":"RSA_DATA"'), { binding, key: KEY, leaseCurrent: true }).result, "UNVERIFIED");
});

test("陈旧同步/查询优先返回，不解析响应或读钥；通知不受lease影响", () => {
  for (const op of ["REFUND_SYNC", "REFUND_QUERY"] as const) {
    const r = evaluateJoinpayRefundResponse(op, "bad body", { binding, key: "", leaseCurrent: false });
    assert.equal(r.result, "STALE"); assert.equal(r.signature, "NOT_CHECKED");
  }
  assert.equal(evaluateJoinpayRefundResponse("REFUND_NOTIFY", body("REFUND_NOTIFY"), { binding, key: KEY, leaseCurrent: false }).ack, "success");
});

test("金额使用整数分与严格两位小数，出站上限和原支付号不重算", () => {
  const base = { ...binding, notifyUrl: "https://example.invalid/refund" };
  assert.equal(new Map(buildJoinpayRefundRequest({ ...base, amountCents: "9999999999999999" }, KEY).fields).get("p4_RefundAmount"), "99999999999999.99");
  for (const amountCents of ["0", "-1", "1.5", "10000000000000000", "1e2"]) assert.throws(() => buildJoinpayRefundRequest({ ...base, amountCents }, KEY));
  for (const wire of ["1.2", "1.250", "01.25", "1e2", "-1.25"]) assert.equal(evaluate("REFUND_NOTIFY", { r4_RefundAmount: wire }).result, "UNVERIFIED");
  assert.equal(new Map(buildJoinpayRefundRequest(base, KEY).fields).get("p2_OrderNo"), ORIGINAL);
});

test("新退款号/URL/备注有界，原号过长不截断、不换号", () => {
  const base = { ...binding, notifyUrl: "https://example.invalid/refund" };
  assert.throws(() => buildJoinpayRefundQuery({ ...binding, refundOrderNo: "A".repeat(31) }, KEY));
  for (const notifyUrl of ["http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/#fragment", "https://example.invalid/" + "a".repeat(300)]) assert.throws(() => buildJoinpayRefundRequest({ ...base, notifyUrl }, KEY));
  assert.doesNotThrow(() => buildJoinpayRefundRequest({ ...base, reason: "退".repeat(133) }, KEY));
  assert.throws(() => buildJoinpayRefundRequest({ ...base, reason: "退".repeat(134) }, KEY), { code: "REFUND_REASON_UTF8_TOO_LONG" });
  assert.throws(() => buildJoinpayRefundRequest({ ...base, merchantNo: 123 as never }, KEY), { code: "SIGNATURE_VALUE_NOT_STRING" });
});

test("当前profile严格合成，模块无网络、DB、配置/钥库读取或退款到账能力", () => {
  assert.equal(JOINPAY_REFUND_PROFILE.merchantUse, false); assert.equal(JOINPAY_REFUND_PROFILE.mayProduceRefundFact, false);
  const source = readFileSync(join(__dirname, "../src/order/joinpay-refund-protocol.js"), "utf8");
  for (const term of ["process.env", "fetch(", 'require("pg', 'require("node:fs', 'require("node:http', "confirmOrderPayment", "withTransaction"]) assert(!source.includes(term), term);
});
