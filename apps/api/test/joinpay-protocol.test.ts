// PAY-02 离线测试。SYNTHETIC_PROTOCOL：仅用虚构商户号/钥；官方向量 NOT_RUN（U-01）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as jp from "../src/order/joinpay-protocol";
import {
  JOINPAY_PROFILE, JOINPAY_SIGNATURE_ORDER, REQUEST_STATES, assertJoinpayMerchantUsable, buildJoinpayQueryRequest, buildJoinpayUniPayRequest,
  centsToJoinpayYuan, joinpayYuanToCents, evaluateJoinpayNotify, evaluateJoinpayQueryResponse, evaluateJoinpaySyncResponse,
  type JoinpayPersistedRequest, type RequestState,
} from "../src/order/joinpay-protocol";

const KEY = "SYNTHETIC_KEY_NOT_REAL_0001";
const MER = "888000000000001";
const ORD = "ZZPAY02_TEST_0001";
const FRP = "ALIPAY_NATIVE";
const NOTIFY_URL = "https://example.invalid/joinpay/notify";

// 独立签名顺序，按合同 §1 转录（不从模块导入）。
const ORDER = {
  uniPayRequest: ["p0_Version", "p1_MerchantNo", "p2_OrderNo", "p3_Amount", "p4_Cur", "p5_ProductName", "p6_ProductDesc", "p7_Mp", "p8_ReturnUrl", "p9_NotifyUrl", "q1_FrpCode", "q2_MerchantBankCode", "q4_IsShowPic", "q5_OpenId", "q6_AuthCode", "q7_AppId", "q8_TerminalNo", "q9_TransactionModel", "qa_TradeMerchantNo", "qb_buyerId", "qh_HbFqNum", "qi_FqSellerPercen", "qj_DJPlan", "qk_DisablePayModel", "ql_TerminalIp", "qm_ContractId", "qn_SpecialInfo"],
  uniPaySyncResponse: ["r0_Version", "r1_MerchantNo", "r2_OrderNo", "r3_Amount", "r4_Cur", "r5_Mp", "r6_FrpCode", "r7_TrxNo", "r8_MerchantBankCode", "r9_SubMerchantNo", "ra_Code", "rb_CodeMsg", "rc_Result", "rd_Pic"],
  asyncNotify: ["r0_Version", "r1_MerchantNo", "r2_OrderNo", "r3_Amount", "r4_Cur", "r5_Mp", "r6_Status", "r7_TrxNo", "r8_BankOrderNo", "r9_BankTrxNo", "ra_PayTime", "rb_DealTime", "rc_BankCode", "rd_OpenId", "re_DiscountAmount", "rh_cardType", "rj_Fee", "rk_FrpCode", "rl_ContractId", "rm_SpecialInfo", "ro_SettleAmount"],
  queryOrderRequest: ["p0_Version", "p1_MerchantNo", "p2_OrderNo"],
  queryOrderResponse: ["r0_Version", "r1_MerchantNo", "r2_OrderNo", "r3_Amount", "r4_ProductName", "r5_TrxNo", "r6_BankTrxNo", "r7_Fee", "r8_FrpCode", "ra_Status", "rb_Code", "rc_CodeMsg", "rd_OpenId", "re_DiscountAmount", "rf_PayTime", "rh_cardType", "rj_BankCode", "rl_ContractId", "rm_SpecialInfo", "ro_SettleAmount"],
};

// 与模块无关的参考签名器（下方固定向量另用 Python hashlib 独立计算）。
type Vals = Record<string, string | undefined>;
const refSign = (order: readonly string[], v: Vals) => createHash("md5").update(order.map((n) => v[n] ?? "").join("") + KEY, "utf8").digest("hex");

const SYNC: Vals = { r0_Version: "2.6", r1_MerchantNo: MER, r2_OrderNo: ORD, r3_Amount: "123.45", r4_Cur: "1", r6_FrpCode: FRP, r7_TrxNo: "100226102200000001", ra_Code: "100", rb_CodeMsg: "受理成功", rc_Result: "https://qr.example.invalid/pay?id=1" };
const NOTIFY: Vals = { r0_Version: "2.6", r1_MerchantNo: MER, r2_OrderNo: ORD, r3_Amount: "123.45", r4_Cur: "1", r6_Status: "100", r7_TrxNo: "100226102200000001", ra_PayTime: "2026-10-22 10:00:00", rb_DealTime: "2026-10-22 10:00:05", rc_BankCode: "ALIPAY", re_DiscountAmount: "0.00", rk_FrpCode: FRP, ro_SettleAmount: "123.45" };
const QUERY: Vals = { r0_Version: "2.6", r1_MerchantNo: MER, r2_OrderNo: ORD, r3_Amount: "123.45", r5_TrxNo: "100226102200000001", r7_Fee: "0.00", r8_FrpCode: FRP, ra_Status: "100", rb_Code: "100", rc_CodeMsg: "", rd_OpenId: "o_synth", re_DiscountAmount: "0.00", rf_PayTime: "2026-10-22 10:00:00", rj_BankCode: "ALIPAY", ro_SettleAmount: "123.45" };

const FIXED_SYNC_JSON = '{"r0_Version":"2.6","r1_MerchantNo":"888000000000001","r2_OrderNo":"ZZPAY02_TEST_0001","r3_Amount":"123.45","r4_Cur":"1","r6_FrpCode":"ALIPAY_NATIVE","r7_TrxNo":"100226102200000001","ra_Code":100,"rb_CodeMsg":"受理成功","rc_Result":"https://qr.example.invalid/pay?id=1","hmac":"f2e184812684cb7377eea1b1d035cc28"}';
const FIXED_NOTIFY_QUERY = "r0_Version=2.6&r1_MerchantNo=888000000000001&r2_OrderNo=ZZPAY02_TEST_0001&r3_Amount=123.45&r4_Cur=1&r6_Status=100&r7_TrxNo=100226102200000001&ra_PayTime=2026-10-22+10%3A00%3A00&rb_DealTime=2026-10-22+10%3A00%3A05&rc_BankCode=ALIPAY&re_DiscountAmount=0.00&rk_FrpCode=ALIPAY_NATIVE&ro_SettleAmount=123.45&hmac=852cde6b6fef17874ccb7903195ff7d2";
const FIXED_QUERY_JSON = '{"r0_Version":"2.6","r1_MerchantNo":"888000000000001","r2_OrderNo":"ZZPAY02_TEST_0001","r3_Amount":"123.45","r5_TrxNo":"100226102200000001","r7_Fee":"0.00","r8_FrpCode":"ALIPAY_NATIVE","ra_Status":"100","rb_Code":"100","rc_CodeMsg":"","rd_OpenId":"o_synth","re_DiscountAmount":"0.00","rf_PayTime":"2026-10-22 10:00:00","rj_BankCode":"ALIPAY","ro_SettleAmount":"123.45","hmac":"d84d27bb9562087de576afe0e0de4212"}';

const req = (state: RequestState = "SUBMITTING"): JoinpayPersistedRequest => ({ state, merchantNo: MER, orderNo: ORD, amountCents: "12345", frpCode: FRP });
const ctx = (state: RequestState = "SUBMITTING", leaseCurrent = true) => ({ key: KEY, request: req(state), leaseCurrent });

function json(base: Vals, patch: Record<string, string | null | undefined> = {}, opts: { sign?: boolean; order?: readonly string[] } = {}): string {
  const v: Record<string, string | null> = {};
  for (const [k, x] of Object.entries({ ...base, ...patch })) if (x !== undefined) v[k] = x;
  const signVals: Vals = {};
  for (const [k, x] of Object.entries(v)) signVals[k] = x ?? undefined;
  if (opts.sign !== false) v.hmac = refSign(opts.order ?? ORDER.uniPaySyncResponse, signVals);
  return JSON.stringify(v);
}
const syncJson = (patch: Record<string, string | null | undefined> = {}) => json(SYNC, patch, { order: ORDER.uniPaySyncResponse });
const queryJson = (patch: Record<string, string | null | undefined> = {}) => json(QUERY, patch, { order: ORDER.queryOrderResponse });
function notifyQs(patch: Record<string, string | undefined> = {}, hmac?: string): string {
  const v: Vals = { ...NOTIFY, ...patch };
  const pairs = Object.entries(v).filter((e): e is [string, string] => e[1] !== undefined);
  pairs.push(["hmac", hmac ?? refSign(ORDER.asyncNotify, v)]);
  return new URLSearchParams(pairs).toString();
}

test("profile is synthetic and closed for real merchants; no fact/APPLIED capability", () => {
  assert.equal(JOINPAY_PROFILE.evidenceLevel, "SYNTHETIC_PROTOCOL");
  assert.equal(JOINPAY_PROFILE.merchantUse, false);
  assert.equal(JOINPAY_PROFILE.productionEnabled, false);
  assert.equal(JOINPAY_PROFILE.mayProduceVerifiedPaymentFact, false);
  assert.equal(JOINPAY_PROFILE.mayProduceJoinpayApplied, false);
  assert.equal(JOINPAY_PROFILE.unconfirmed.officialVector, "NOT_OBTAINED_U-01");
  assert.throws(() => assertJoinpayMerchantUsable(), { code: "PROFILE_NOT_VERIFIED" });
  const names = Object.keys(jp);
  assert.ok(!names.some((n) => /verifiedpaymentfact|applied|controlled|confirm/i.test(n)), names.join(","));
});

test("module source has no env/network/DB/fs access and imports only node:crypto", () => {
  const src = readFileSync(join(__dirname, "../src/order/joinpay-protocol.js"), "utf8");
  for (const bad of ["process.env", "fetch(", "require(\"http", "require(\"https", "require(\"pg", "require(\"redis", "require(\"fs", "require(\"node:fs", "require(\"node:http", "require(\"node:net", "XMLHttpRequest"]) assert.ok(!src.includes(bad), bad);
  const requires = [...src.matchAll(/require\("([^"]+)"\)/g)].map((x) => x[1]);
  assert.deepEqual(requires, ["node:crypto"]);
});

test("four operations have distinct fixed signature orders matching contract §1", () => {
  assert.deepEqual(JOINPAY_SIGNATURE_ORDER, ORDER);
  assert.ok(ORDER.asyncNotify.includes("r6_Status") && !ORDER.queryOrderResponse.includes("r6_Status"));
  assert.ok(ORDER.queryOrderResponse.includes("ra_Status") && ORDER.uniPaySyncResponse.includes("ra_Code"));
});

test("fixed synthetic vectors (expected values computed independently, not self-signed)", () => {
  const uni = buildJoinpayUniPayRequest({ merchantNo: MER, orderNo: ORD, amountCents: "12345", currency: "CNY", productName: "洲洲测试商品", notifyUrl: NOTIFY_URL, frpCode: FRP, tradeMerchantNo: "SYNTH_TRADE_MER_01" }, KEY);
  assert.equal(uni.hmac, "5e500f6d56b7637b130c346836915aa7");
  assert.equal(uni.sendable, false);
  assert.deepEqual(uni.fields.map((f) => f[0]), ["p0_Version", "p1_MerchantNo", "p2_OrderNo", "p3_Amount", "p4_Cur", "p5_ProductName", "p9_NotifyUrl", "q1_FrpCode", "qa_TradeMerchantNo", "hmac"]);
  assert.equal(uni.fields[5]?.[1], "洲洲测试商品");
  assert.equal(buildJoinpayQueryRequest({ merchantNo: MER, orderNo: ORD }, KEY).hmac, "995277d1481d83c458f88c7e357c08c1");
  const s = evaluateJoinpaySyncResponse(FIXED_SYNC_JSON, ctx());
  assert.equal(s.result, "ACTION_READY");
  assert.equal(s.signature, "SYNTHETIC_SELF_CONSISTENT");
  const n = evaluateJoinpayNotify(FIXED_NOTIFY_QUERY, { key: KEY, request: req("ACTION_READY") });
  assert.equal(n.result, "CHANNEL_SIGNED_SYNTHETIC");
  const q = evaluateJoinpayQueryResponse(FIXED_QUERY_JSON, ctx("UNKNOWN"));
  assert.equal(q.result, "QUERY_SUCCEEDED");
  assert.equal(evaluateJoinpaySyncResponse(FIXED_SYNC_JSON, { ...ctx(), key: "OTHER_FAKE_KEY" }).result, "SIGNATURE_INVALID");
});

test("sync 100 is parameter acceptance only; raw JSON number token kept; QR unusable", () => {
  const s = evaluateJoinpaySyncResponse(FIXED_SYNC_JSON, ctx());
  assert.equal(s.event, "E1");
  assert.equal(s.nextState, "ACTION_READY");
  assert.deepEqual(s.numberTokens, ["ra_Code"]);
  assert.equal(s.values?.ra_Code, "100");
  assert.deepEqual(s.paymentParam, { url: "https://qr.example.invalid/pay?id=1", usableNow: false, reason: "QR_HOST_ALLOWLIST_NOT_OBTAINED" });
  assert.equal(s.formalAcceptance, false);
  assert.equal(s.officialVerified, false);
  assert.ok(s.blockers.includes("U-07"));
  const e = evaluateJoinpaySyncResponse(FIXED_SYNC_JSON.replace('"ra_Code":100', '"ra_Code":1e2'), ctx());
  assert.equal(e.result, "SIGNATURE_INVALID"); // 数字 token "1e2" 不会被规范化成 100
});

test("R3-01: sync schema failure SUBMITTING→UNKNOWN only; query/notify unchanged in every state", () => {
  for (const st of REQUEST_STATES) {
    const s = evaluateJoinpaySyncResponse(syncJson({ r7_TrxNo: undefined }), ctx(st));
    assert.equal(s.result, "SYNC_SCHEMA_REJECTED");
    assert.equal(s.reason, "PROTOCOL_FIELD_MISSING");
    assert.equal(s.event, "E3");
    assert.equal(s.nextState, st === "SUBMITTING" ? "UNKNOWN" : st, st);
    assert.equal(s.observation, "UNVERIFIED");
    const q = evaluateJoinpayQueryResponse(queryJson({ r7_Fee: undefined }), ctx(st));
    assert.equal(q.result, "QUERY_SCHEMA_REJECTED");
    assert.equal(q.event, "E6X");
    assert.equal(q.nextState, st);
    const n = evaluateJoinpayNotify(notifyQs({ r7_TrxNo: undefined }), { key: KEY, request: req(st) });
    assert.equal(n.result, "NOTIFY_SCHEMA_REJECTED");
    assert.equal(n.event, "E11");
    assert.equal(n.nextState, st);
    assert.equal(n.ack, "fail");
  }
});

test("R3-01: sync 102 missing rc_Result is schema-rejected (E3), not E1P", () => {
  const miss = evaluateJoinpaySyncResponse(syncJson({ ra_Code: "102", rc_Result: undefined }), ctx());
  assert.equal(miss.result, "SYNC_SCHEMA_REJECTED");
  assert.equal(miss.field, "rc_Result");
  assert.equal(miss.event, "E3");
  assert.equal(miss.nextState, "UNKNOWN");
  const ok = evaluateJoinpaySyncResponse(syncJson({ ra_Code: "102" }), ctx());
  assert.equal(ok.event, "E1P");
  assert.equal(ok.nextState, "PROCESSING_UNCONFIRMED");
  assert.equal(evaluateJoinpaySyncResponse(syncJson({ ra_Code: "10080003" }), ctx()).nextState, "REJECTED_BY_CHANNEL");
  assert.equal(evaluateJoinpaySyncResponse(syncJson({ ra_Code: "10080000" }), ctx()).nextState, "UNKNOWN");
  assert.equal(evaluateJoinpaySyncResponse(syncJson({ ra_Code: "77777" }), ctx()).result, "SYNC_UNMAPPED_CODE");
});

test("R3-02: query branches A–F", () => {
  const cases: Array<[Record<string, string | null | undefined>, string, string | undefined, string]> = [
    [{ rb_Code: undefined }, "QUERY_SCHEMA_REJECTED", "PROTOCOL_FIELD_MISSING", "E6X"],
    [{ rb_Code: "200" }, "QUERY_FAILED", undefined, "E6X"],
    [{ ra_Status: undefined }, "QUERY_EVIDENCE_INCOMPLETE", "STATUS_MISSING", "E6X"],
    [{ ra_Status: "" }, "QUERY_EVIDENCE_INCOMPLETE", "STATUS_MISSING", "E6X"],
    [{ ra_Status: null }, "QUERY_EVIDENCE_INCOMPLETE", "STATUS_MISSING", "E6X"],
    [{ ra_Status: "999" }, "QUERY_EVIDENCE_INCOMPLETE", "STATUS_UNKNOWN", "E6X"],
    [{ r3_Amount: undefined }, "QUERY_EVIDENCE_INCOMPLETE", "SUCCESS_FIELD_MISSING", "E6X"],
    [{ r5_TrxNo: undefined }, "QUERY_EVIDENCE_INCOMPLETE", "SUCCESS_FIELD_MISSING", "E6X"],
    [{ r8_FrpCode: "" }, "QUERY_EVIDENCE_INCOMPLETE", "SUCCESS_FIELD_MISSING", "E6X"],
    [{ ra_Status: "101", r3_Amount: undefined, r5_TrxNo: undefined, r8_FrpCode: undefined }, "CHANNEL_REPORTED_FAILED", undefined, "E5"],
    [{ ra_Status: "102", r3_Amount: undefined, r5_TrxNo: undefined, r8_FrpCode: undefined }, "CHANNEL_CREATED_UNPAID", undefined, "E6"],
    [{ ra_Status: "101", rf_PayTime: undefined }, "QUERY_SCHEMA_REJECTED", "PROTOCOL_FIELD_MISSING", "E6X"],
    [{ ra_Status: "102", rf_PayTime: undefined }, "QUERY_SCHEMA_REJECTED", "PROTOCOL_FIELD_MISSING", "E6X"],
    [{ rf_PayTime: undefined }, "QUERY_SCHEMA_REJECTED", "PROTOCOL_FIELD_MISSING", "E6X"],
    [{ r3_Amount: "123.46" }, "BINDING_MISMATCH", undefined, "E6X"],
  ];
  for (const [patch, result, reason, event] of cases) {
    const o = evaluateJoinpayQueryResponse(queryJson(patch), ctx("ACTION_READY"));
    assert.equal(o.result, result, JSON.stringify(patch));
    assert.equal(o.reason, reason, JSON.stringify(patch));
    assert.equal(o.event, event, JSON.stringify(patch));
    if (event !== "E4") assert.equal(o.nextState, "ACTION_READY");
  }
  assert.equal(evaluateJoinpayQueryResponse(queryJson({ ra_Status: "999" }), ctx()).rawStatus, "999");
  assert.equal(evaluateJoinpayQueryResponse(queryJson({ rb_Code: "200" }), ctx()).rawStatus, "200");
  const ok = evaluateJoinpayQueryResponse(queryJson(), ctx("PROCESSING_UNCONFIRMED"));
  assert.equal(ok.event, "E4");
  assert.equal(ok.nextState, "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE");
  assert.equal(ok.formalAcceptance, false);
  const signedNum = json({ ...QUERY }, {}, { order: ORDER.queryOrderResponse }).replace('"rb_Code":"100"', '"rb_Code":100');
  assert.equal(evaluateJoinpayQueryResponse(signedNum, ctx()).result, "QUERY_SUCCEEDED");
  assert.deepEqual(evaluateJoinpayQueryResponse(signedNum, ctx()).numberTokens, ["rb_Code"]);
});

test("terminal guard and stale lease precedence (E9)", () => {
  for (const st of ["ACCEPTED", "REVIEW_REQUIRED"] as const) {
    assert.equal(evaluateJoinpayNotify(notifyQs(), { key: KEY, request: req(st) }).nextState, st);
    const q101 = evaluateJoinpayQueryResponse(queryJson({ ra_Status: "101" }), ctx(st));
    assert.equal(q101.nextState, st);
    assert.equal(q101.conflict, true);
    assert.equal(evaluateJoinpaySyncResponse(syncJson({ ra_Code: "102" }), ctx(st)).nextState, st);
    assert.equal(evaluateJoinpayQueryResponse(queryJson(), ctx(st)).nextState, st);
  }
  assert.equal(evaluateJoinpayNotify(notifyQs(), { key: KEY, request: req("REJECTED_BY_CHANNEL") }).conflict, true);
  for (const body of [FIXED_SYNC_JSON, "not json"]) {
    const s = evaluateJoinpaySyncResponse(body, ctx("SUBMITTING", false));
    assert.equal(s.event, "E9");
    assert.equal(s.nextState, "SUBMITTING");
    assert.equal(s.observation, "STALE");
  }
  assert.equal(evaluateJoinpayQueryResponse(FIXED_QUERY_JSON, ctx("UNKNOWN", false)).event, "E9");
});

test("notify: binding, signature, tamper, currency and unknown request", () => {
  assert.equal(evaluateJoinpayNotify(notifyQs({ r6_Status: "101" }), { key: KEY, request: req() }).event, "E5");
  assert.equal(evaluateJoinpayNotify(notifyQs(), { key: KEY, request: null }).result, "BINDING_NOT_FOUND");
  assert.equal(evaluateJoinpayNotify(notifyQs(), { key: KEY, request: null }).nextState, "NONE");
  assert.equal(evaluateJoinpayNotify(notifyQs({}, "0".repeat(32)), { key: KEY, request: req() }).result, "SIGNATURE_INVALID");
  assert.equal(evaluateJoinpayNotify(FIXED_NOTIFY_QUERY.replace("r3_Amount=123.45", "r3_Amount=123.46"), { key: KEY, request: req() }).result, "SIGNATURE_INVALID");
  assert.equal(evaluateJoinpayNotify(FIXED_NOTIFY_QUERY.replace("852cde6b6fef17874ccb7903195ff7d2", "852CDE6B6FEF17874CCB7903195FF7D2"), { key: KEY, request: req() }).result, "CHANNEL_SIGNED_SYNTHETIC");
  for (const patch of [{ r1_MerchantNo: "888000000000002" }, { r2_OrderNo: "ZZPAY02_TEST_0002" }, { r4_Cur: "2" }, { rk_FrpCode: "WEIXIN_NATIVE" }, { r3_Amount: "1.00" }])
    assert.equal(evaluateJoinpayNotify(notifyQs(patch), { key: KEY, request: req() }).result, "BINDING_MISMATCH", JSON.stringify(patch));
  assert.equal(evaluateJoinpayNotify(notifyQs({ re_DiscountAmount: "1.00" }), { key: KEY, request: req() }).result, "DISCOUNT_REVIEW_U-12");
  assert.equal(evaluateJoinpayNotify(notifyQs({ r6_Status: "103" }), { key: KEY, request: req() }).result, "NOTIFY_STATUS_UNKNOWN");
  for (const patch of [{ r1_MerchantNo: "888000000000002" }, { r4_Cur: "2" }, { r6_FrpCode: "WEIXIN_NATIVE" }])
    assert.equal(evaluateJoinpaySyncResponse(syncJson(patch), ctx()).result, "BINDING_MISMATCH");
  const n = evaluateJoinpayNotify(notifyQs(), { key: KEY, request: req() });
  assert.equal(n.ack, "success");
  assert.equal(n.providerPaidAtRaw, "2026-10-22 10:00:00");
  assert.equal(n.formalAcceptance, false);
});

test("decode: '+', %2B, %25, double-encoded time not auto-decoded, malformed escapes, invalid UTF-8, duplicates, whitespace", () => {
  const ok = (qs: string) => evaluateJoinpayNotify(qs, { key: KEY, request: req() });
  assert.equal(ok(notifyQs()).result, "CHANNEL_SIGNED_SYNTHETIC");
  assert.equal(ok(notifyQs().replace("ra_PayTime=2026-10-22+10%3A00%3A00", "ra_PayTime=2026-10-22%2010:00:00")).result, "CHANNEL_SIGNED_SYNTHETIC");
  const dbl = ok(notifyQs().replace("ra_PayTime=2026-10-22+10%3A00%3A00", "ra_PayTime=2026-10-22%252010%253A00%253A00"));
  assert.equal(dbl.reason, "PROTOCOL_FIELD_PATTERN");
  assert.equal(dbl.field, "ra_PayTime");
  const plus = ok(notifyQs({ rd_OpenId: "a+b%c" }));
  assert.equal(plus.values?.rd_OpenId, "a+b%c");
  assert.equal(ok(notifyQs() + "&r1_MerchantNo=" + MER).reason, "PROTOCOL_DUPLICATE_PARAM");
  assert.equal(ok(notifyQs() + "&x=%E4%B8").reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(ok(notifyQs() + "&x=%FF").reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(ok(notifyQs() + "&x=%").reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(ok(notifyQs() + "&&").reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(ok(notifyQs({ rc_BankCode: " ALIPAY" })).reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(ok(notifyQs() + "&zz_New=1").reason, "UNKNOWN_FIELD_REVIEW");
  assert.equal(ok(notifyQs() + "&zz_New=").result, "CHANNEL_SIGNED_SYNTHETIC");
  assert.equal(ok(notifyQs({ r7_TrxNo: "" })).reason, "PROTOCOL_REQUIRED_EMPTY");
  assert.equal(ok(notifyQs({ r5_Mp: "x" })).reason, "MP_REVIEW");
  assert.equal(ok(notifyQs({ r8_BankOrderNo: "" })).result, "CHANNEL_SIGNED_SYNTHETIC");
});

test("JSON: duplicate key, invalid UTF-8, null, nesting, trailing data, unknown fields", () => {
  const sync = (b: string | Uint8Array) => evaluateJoinpaySyncResponse(b, ctx());
  assert.equal(sync(FIXED_SYNC_JSON.replace('"r4_Cur":"1",', '"r4_Cur":"1","r4_Cur":"1",')).reason, "PROTOCOL_DUPLICATE_KEY");
  const bytes = Buffer.from(FIXED_SYNC_JSON.replace("受理成功", "@@"), "utf8");
  bytes[bytes.indexOf(0x40)] = 0xff;
  assert.equal(sync(bytes).reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(sync(Buffer.from(FIXED_SYNC_JSON, "utf8")).result, "ACTION_READY");
  assert.equal(sync(syncJson({ r9_SubMerchantNo: null })).result, "ACTION_READY");
  assert.equal(sync(syncJson({ r7_TrxNo: null })).reason, "PROTOCOL_REQUIRED_EMPTY");
  assert.equal(sync(syncJson({ rb_CodeMsg: "" })).result, "ACTION_READY");
  assert.equal(sync(FIXED_SYNC_JSON.replace('"r4_Cur":"1"', '"r4_Cur":{"a":1}')).reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(sync(FIXED_SYNC_JSON + "x").reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(sync(syncJson({ zz_Extra: "1" })).reason, "UNKNOWN_FIELD_REVIEW");
  assert.equal(sync(syncJson({ rc_Result: "http://qr.example.invalid/x" })).reason, "ACTION_REJECTED_LOCAL");
  assert.equal(sync(syncJson({ hmac: undefined }).replace(/,"hmac":"[0-9a-f]+"/, "")).field, "hmac");
});

test("rm_SpecialInfo 256/257 Unicode code points (notify and query)", () => {
  const astral = "\u{20000}";
  for (const ch of ["汇", astral]) {
    assert.equal(evaluateJoinpayNotify(notifyQs({ rm_SpecialInfo: ch.repeat(256) }), { key: KEY, request: req() }).result, "CHANNEL_SIGNED_SYNTHETIC");
    assert.equal(evaluateJoinpayNotify(notifyQs({ rm_SpecialInfo: ch.repeat(257) }), { key: KEY, request: req() }).reason, "PROTOCOL_FIELD_TOO_LONG");
    assert.equal(evaluateJoinpayQueryResponse(queryJson({ rm_SpecialInfo: ch.repeat(256) }), ctx()).result, "QUERY_SUCCEEDED");
    assert.equal(evaluateJoinpayQueryResponse(queryJson({ rm_SpecialInfo: ch.repeat(257) }), ctx()).reason, "PROTOCOL_FIELD_TOO_LONG");
  }
});

test("amounts: exact string/BigInt conversion, max and over-range, invalid forms, no Number precision loss", () => {
  assert.equal(centsToJoinpayYuan("12345"), "123.45");
  assert.equal(centsToJoinpayYuan("5"), "0.05");
  assert.equal(centsToJoinpayYuan("100"), "1.00");
  assert.equal(centsToJoinpayYuan("9999999999999999"), "99999999999999.99");
  assert.throws(() => centsToJoinpayYuan("10000000000000000"), { code: "AMOUNT_OUT_OF_PROTOCOL_RANGE" });
  assert.throws(() => centsToJoinpayYuan("1".repeat(25)), { code: "AMOUNT_OUT_OF_PROTOCOL_RANGE" });
  assert.throws(() => centsToJoinpayYuan("1".repeat(26)), { code: "AMOUNT_INVALID" });
  assert.throws(() => centsToJoinpayYuan("0"), { code: "AMOUNT_OUT_OF_PROTOCOL_RANGE" });
  for (const bad of ["-1", "1e2", "1.5", " 1", "01", ""]) assert.throws(() => centsToJoinpayYuan(bad), { code: "AMOUNT_INVALID" }, bad);
  assert.equal(joinpayYuanToCents("0.05"), "5");
  assert.equal(joinpayYuanToCents("99999999999999.99"), "9999999999999999");
  for (const bad of ["10", "10.5", "010.00", "1e2", "-1.00", " 1.00", "1.000"]) assert.throws(() => joinpayYuanToCents(bad), { code: "AMOUNT_INVALID" }, bad);
  const big = "9007199254740993";
  assert.notEqual(String(Number(big)), big); // Number 会丢失该值精度
  assert.equal(centsToJoinpayYuan(big), "90071992547409.93");
  assert.equal(joinpayYuanToCents("90071992547409.93"), big);
  const base = { merchantNo: MER, orderNo: ORD, productName: "测试", notifyUrl: NOTIFY_URL, frpCode: FRP, tradeMerchantNo: "T" } as const;
  assert.throws(() => buildJoinpayUniPayRequest({ ...base, amountCents: "10000000000000000", currency: "CNY" }, KEY), { code: "AMOUNT_OUT_OF_PROTOCOL_RANGE" });
  assert.throws(() => buildJoinpayUniPayRequest({ ...base, amountCents: "1", currency: "USD" as "CNY" }, KEY), { code: "CURRENCY_NOT_SUPPORTED" });
  assert.throws(() => buildJoinpayUniPayRequest({ ...base, amountCents: "1", currency: "CNY", orderNo: "bad-no" }, KEY), { code: "PROTOCOL_FIELD_PATTERN" });
  assert.throws(() => buildJoinpayUniPayRequest({ ...base, amountCents: "1", currency: "CNY", productName: "名".repeat(31) }, KEY), { code: "PROTOCOL_FIELD_TOO_LONG" });
  assert.throws(() => buildJoinpayUniPayRequest({ ...base, amountCents: "1", currency: "CNY", frpCode: "UNIONPAY" as "ALIPAY_NATIVE" }, KEY), { code: "FRP_CODE_NOT_ALLOWED" });
  assert.throws(() => buildJoinpayQueryRequest({ merchantNo: MER, orderNo: ORD }, ""), { code: "KEY_REQUIRED" });
});

// ---------- PAY-02-R1 返修反例（不重签名；hmac 保持原值）----------
test("R1-01: 字段值、字段名、hmac 值前的 BOM 保留并拒绝，基线仍通过", () => {
  const n = (qs: string) => evaluateJoinpayNotify(qs, { key: KEY, request: req("ACTION_READY") });
  assert.equal(n(FIXED_NOTIFY_QUERY).event, "E4");
  for (const qs of [
    FIXED_NOTIFY_QUERY.replace("r1_MerchantNo=888", "r1_MerchantNo=%EF%BB%BF888"),
    FIXED_NOTIFY_QUERY.replace("r1_MerchantNo=888", "%EF%BB%BFr1_MerchantNo=888"),
    FIXED_NOTIFY_QUERY.replace("hmac=852", "hmac=%EF%BB%BF852"),
  ]) {
    const o = n(qs);
    assert.notEqual(o.event, "E4", qs);
    assert.notEqual(o.signature, "SYNTHETIC_SELF_CONSISTENT", qs);
    assert.equal(o.result, "NOTIFY_SCHEMA_REJECTED", qs);
  }
  assert.equal(n(FIXED_NOTIFY_QUERY.replace("r1_MerchantNo=888", "r1_MerchantNo=%EF%BB%BF888")).reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(n(FIXED_NOTIFY_QUERY.replace("r1_MerchantNo=888", "%EF%BB%BFr1_MerchantNo=888")).field, "r1_MerchantNo");
});

test("R1-02: 孤立代理拒绝（JSON 转义、原始字符串、签名入口），合法 Unicode 保留", () => {
  const vals: Vals = { ...SYNC, rb_CodeMsg: "\ufffd" };
  const hmac = refSign(ORDER.uniPaySyncResponse, vals);
  const baseline = JSON.stringify({ ...vals, hmac });
  assert.equal(evaluateJoinpaySyncResponse(baseline, ctx()).event, "E1");
  for (const esc of ["\\ud800", "\\udc00", "\\udc00\\ud800"]) {
    const o = evaluateJoinpaySyncResponse(baseline.replace("\ufffd", esc), ctx());
    assert.equal(o.result, "SYNC_SCHEMA_REJECTED", esc);
    assert.equal(o.reason, "PROTOCOL_DECODE_REJECTED", esc);
    assert.notEqual(o.signature, "SYNTHETIC_SELF_CONSISTENT");
  }
  assert.equal(evaluateJoinpaySyncResponse(baseline.replace('"r4_Cur"', '"r4_Cur\\ud800"'), ctx()).reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(evaluateJoinpaySyncResponse(baseline.replace("\ufffd", "\ud800"), ctx()).reason, "PROTOCOL_DECODE_REJECTED"); // 原始字符串入口
  assert.equal(evaluateJoinpayQueryResponse(queryJson({ rc_CodeMsg: "\udfff" }), ctx()).reason, "PROTOCOL_DECODE_REJECTED");
  assert.equal(evaluateJoinpayNotify(FIXED_NOTIFY_QUERY + "&rd_OpenId=\ud800", { key: KEY, request: req() }).reason, "PROTOCOL_DECODE_REJECTED");
  assert.throws(() => jp.joinpayMd5Sign(["a"], { a: "\ud800" }, KEY), { code: "PROTOCOL_NOT_WELL_FORMED_UTF16" });
  assert.throws(() => jp.joinpayMd5Sign(["a"], { a: "x" }, "K\udc00"), { code: "PROTOCOL_NOT_WELL_FORMED_UTF16" });
  for (const ok of ["\u{20000}", "洲洲", "\ud83d\ude00"]) {
    const v: Vals = { ...SYNC, rb_CodeMsg: ok };
    const o = evaluateJoinpaySyncResponse(JSON.stringify({ ...v, hmac: refSign(ORDER.uniPaySyncResponse, v) }), ctx());
    assert.equal(o.event, "E1", ok);
    assert.equal(o.values?.rb_CodeMsg, ok);
  }
  const pairEsc = JSON.stringify({ ...SYNC, rb_CodeMsg: "\u{1F600}", hmac: refSign(ORDER.uniPaySyncResponse, { ...SYNC, rb_CodeMsg: "\u{1F600}" }) }).replace("\u{1F600}", "\\ud83d\\ude00");
  assert.equal(evaluateJoinpaySyncResponse(pairEsc, ctx()).event, "E1"); // 成对代理转义合法
});

test("R2: 跨字段的孤立代理必须分别拒绝，字段内成对代理保留", () => {
  const high = "\ud83d";
  const low = "\ude00";
  const order = ["a", "empty", "b"];
  for (const empty of [undefined, ""]) {
    assert.throws(() => jp.joinpayMd5Sign(order, { a: "x" + high, empty, b: low + "y" }, KEY), { code: "PROTOCOL_NOT_WELL_FORMED_UTF16" });
  }
  assert.throws(() => buildJoinpayUniPayRequest({
    merchantNo: MER, orderNo: ORD, amountCents: "1", currency: "CNY",
    productName: "x" + high, notifyUrl: low + NOTIFY_URL, frpCode: FRP, tradeMerchantNo: "SYNTH_ONLY",
  }, KEY), { code: "PROTOCOL_NOT_WELL_FORMED_UTF16" });
  const valid = { a: "x" + high + low, empty: "", b: "y" };
  assert.equal(jp.joinpayMd5Sign(order, valid, KEY), refSign(order, valid));
});

test("R1-03: 200000 字符 rm_SpecialInfo 返回过长拒绝，不抛引擎异常", () => {
  let o: ReturnType<typeof evaluateJoinpayNotify> | undefined;
  assert.doesNotThrow(() => { o = evaluateJoinpayNotify(FIXED_NOTIFY_QUERY + "&rm_SpecialInfo=" + "x".repeat(200000), { key: KEY, request: req() }); });
  assert.equal(o?.result, "NOTIFY_SCHEMA_REJECTED");
  assert.equal(o?.reason, "PROTOCOL_FIELD_TOO_LONG");
  assert.equal(o?.field, "rm_SpecialInfo");
});
