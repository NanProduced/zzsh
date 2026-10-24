// SYNTHETIC_PROTOCOL：虚构商户、目标和钥；官方KAT、私有事实与资金动作均未运行。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JOINPAY_PAYOUT_PROFILE, JOINPAY_PAYOUT_SIGNATURE_ORDER, buildSyntheticJoinpayPayoutRequest, buildSyntheticJoinpayPayoutQuery,
  computeJoinpayPayoutRequest, computeJoinpayPayoutQuery, validateJoinpayPayoutSubmitInput, validateJoinpayPayoutWireTemplate, preflightJoinpayPayoutResponse, computeJoinpayPayoutResponse, evaluateSyntheticJoinpayPayoutResponse, syntheticJoinpayPayoutAck, type PayoutWireRules, type PayoutOperation, type JoinpayPayoutBinding } from "../src/finance/joinpay-payout-protocol";
import { reduceJoinpayPayoutObservation, type PayoutRequestPhase } from "../src/finance/joinpay-payout-state";
const KEY = "SYNTHETIC_PAYOUT_KEY_NOT_REAL_0001";
const ORDER = {
  submitRequest: ["userNo", "tradeMerchantNo", "productCode", "requestTime", "merchantOrderNo", "receiverAccountNoEnc", "receiverNameEnc", "receiverAccountType", "receiverBankChannelNo", "paidAmount", "currency", "isChecked", "paidDesc", "paidUse", "callbackUrl", "firstProductCode"],
  submitResponse: ["statusCode", "message", "errorCode", "errorDesc", "userNo", "merchantOrderNo"],
  queryRequest: ["userNo", "merchantOrderNo"],
  queryResponse: ["statusCode", "message", "status", "errorCode", "errorDesc", "userNo", "tradeMerchantNo", "merchantOrderNo", "platformSerialNo", "receiverAccountNoEnc", "receiverNameEnc", "paidAmount", "fee"],
  notification: ["status", "errorCode", "errorCodeDesc", "userNo", "tradeMerchantNo", "merchantOrderNo", "platformSerialNo", "receiverAccountNoEnc", "receiverNameEnc", "paidAmount", "fee"],
};
const R: PayoutWireRules = { dataEncoding: "OBJECT", statusCodeToken: "STRING", statusToken: "NUMBER", amountToken: "NUMBER", feeToken: "NUMBER", accountTypeToken: "NUMBER",
  optionalSigning: "ABSENT_EMPTY_NULL_EQUIVALENT", numericSigning: "RAW_JSON_TOKEN", unknownFields: "REJECT", notFoundShape: "IDENTITY_ONLY_214", targetBinding: "EXACT_RECORDED_OPAQUE_VALUE", providerFeeUnit: "UNKNOWN" };
const B: JoinpayPayoutBinding = { merchantIdentityId: "merchant_model", userNo: "888000000000001", merchantOrderNo: "PAYOUT202610240001",
  receiverAccountNoEnc: "SYNTHETIC_OPAQUE_ACCOUNT", receiverNameEnc: "SYNTHETIC_OPAQUE_NAME", netCents: "12345" };
type Values = Record<string, string | null | undefined>;
const sign = (order: readonly string[], v: Values) => createHash("md5").update(order.map(n => v[n] ?? "").join("") + KEY).digest("hex");
const transaction = (status = "205"): Values => ({ status, userNo: B.userNo, merchantOrderNo: B.merchantOrderNo, platformSerialNo: "SYNTHETIC_TRX_1",
  receiverAccountNoEnc: B.receiverAccountNoEnc, receiverNameEnc: B.receiverNameEnc, paidAmount: "123.45", fee: "0.50" });
function wire(op: PayoutOperation, input: Values, r = R): string {
  const v = { ...(op === "NOTIFY" ? {} : { statusCode: "2001", message: "synthetic" }), ...input },
    names = op === "SYNC" ? ORDER.submitResponse : op === "QUERY" ? ORDER.queryResponse : ORDER.notification;
  const hmac = sign(names, v), numeric = (n: string) => n === "status" && r.statusToken === "NUMBER" || n === "statusCode" && r.statusCodeToken === "NUMBER" || n === "paidAmount" && r.amountToken === "NUMBER" || n === "fee" && r.feeToken === "NUMBER";
  const encode = (entries: [string, string | null | undefined][]) => "{" + entries.filter(([, value]) => value !== undefined).map(([name, value]) => JSON.stringify(name) + ":" + (value === null ? "null" : value !== "" && numeric(name) ? value : JSON.stringify(value))).join(",") + "}";
  const data = encode([...Object.entries(v).filter(([name]) => op === "NOTIFY" || !["statusCode", "message"].includes(name)), ["hmac", hmac]]);
  return op === "NOTIFY" ? data : "{" + '"statusCode":' + (r.statusCodeToken === "NUMBER" ? v.statusCode : JSON.stringify(v.statusCode)) + ',"message":' + JSON.stringify(v.message) + ',"data":' + (r.dataEncoding === "OBJECT" ? data : JSON.stringify(data)) + "}";
}
const inspect = (op: PayoutOperation, v: Values, b = B, r = R) => computeJoinpayPayoutResponse(op, wire(op, v, r), { key: KEY, binding: b, rules: r, leaseCurrent: true });
const submit = () => ({ ...B, productCode: "BANK_PAY_DAILY_ORDER", requestTime: "2026-10-24 12:34:56", receiverAccountType: "201" as const,
  isChecked: "201" as const, paidDesc: "合成佣金", paidUse: "201", callbackUrl: "https://example.invalid/payout/notify" });
test("中性计算/无钥校验共用原协议，旧Synthetic包装旗标和字节不变",()=>{
 validateJoinpayPayoutSubmitInput(submit(),R);const neutral=computeJoinpayPayoutRequest(submit(),KEY,R),old=buildSyntheticJoinpayPayoutRequest(submit(),KEY,R);assert.equal(neutral.body,old.body);assert.equal(neutral.hmac,old.hmac);assert.equal("sendable" in neutral,false);assert.equal(old.sendable,false);assert.equal(old.evidenceLevel,"SYNTHETIC_PROTOCOL");
 const query=computeJoinpayPayoutQuery(B,KEY,R);assert.equal(query.body,buildSyntheticJoinpayPayoutQuery(B,KEY,R).body);assert.throws(()=>validateJoinpayPayoutSubmitInput({...submit(),isChecked:undefined} as any,R));
});

test("wire模板在取钥前拒空对象、非对象、缺必填、未知项及错误组合",()=>{
 const template={productCode:"BANK_PAY_DAILY_ORDER",isChecked:"201",paidDesc:"合成佣金",paidUse:"201",callbackUrl:"https://example.invalid/payout/notify"};
 validateJoinpayPayoutWireTemplate(template as any);
 validateJoinpayPayoutWireTemplate({...template,callbackUrl:undefined} as any);
 for(const v of [{},true,{...template,paidUse:undefined},{...template,extra:"x"},{...template,firstProductCode:"BANK_PAY_ORDINARY_ORDER"},{...template,callbackUrl:"http://example.invalid"}])assert.throws(()=>validateJoinpayPayoutWireTemplate(v as any));
});

test("通知无钥前检共用完整schema；未知枚举和签名冲突仍留给验签而不自证MATCH",()=>{
 const pre=(v:Values)=>preflightJoinpayPayoutResponse("NOTIFY",wire("NOTIFY",v),{rules:R});
 for(const name of ["status","userNo","merchantOrderNo","platformSerialNo","receiverAccountNoEnc","receiverNameEnc","paidAmount","fee"])assert.equal(pre({...transaction(),[name]:undefined}).ok,false,name);
 const good=wire("NOTIFY",transaction());
 for(const body of [good.replace(/,"hmac":"[a-f0-9]+"/,""),good.replace(/"hmac":"[a-f0-9]+"/,'"hmac":"bad"'),good.replace('"userNo":','"userNo":"duplicate","userNo":'),good.replace('"status":205','"status":"205"'),"\ufeff"+good])assert.equal(preflightJoinpayPayoutResponse("NOTIFY",body,{rules:R}).ok,false);
 assert.deepEqual(pre(transaction()),{ok:true,reason:"SCHEMA_VALID"});
 assert.equal(pre(transaction("999")).ok,true);assert.equal(pre({...transaction(),paidAmount:"123.46"}).ok,true);
 assert.equal(preflightJoinpayPayoutResponse("NOTIFY",good.replace(/"hmac":"[a-f0-9]+"/,'"hmac":"00000000000000000000000000000000"'),{rules:R}).ok,true);
 assert.equal("signature" in pre(transaction()),false);
});

test("五组官方表序逐项独立转录，16/6/2/13/11且不混聚合收款字段", () => {
  for (const key of Object.keys(ORDER) as (keyof typeof ORDER)[]) assert.deepEqual(JOINPAY_PAYOUT_SIGNATURE_ORDER[key], ORDER[key]);
  assert.equal(JOINPAY_PAYOUT_PROFILE.merchantUse, false); assert.equal(JOINPAY_PAYOUT_PROFILE.mayAffectFunds, false);
});
test("申请与查单仅合成：明确复核策略、原单号、数字原文和opaque目标，不外发", () => {
  const form = buildSyntheticJoinpayPayoutRequest(submit(), KEY, R), values = Object.fromEntries(form.fields);
  assert.equal(form.hmac, sign(ORDER.submitRequest, values)); assert.match(form.body, /"paidAmount":123\.45/); assert.match(form.body, /"receiverAccountType":201/);
  assert.equal(form.hmac, "56f9232cc98b7a617e3233c8c423f6a6"); // 独立.NET向量，非官方向量。
  assert.equal(values.isChecked, "201"); assert.equal(form.sendable, false); assert.equal(form.evidenceLevel, "SYNTHETIC_PROTOCOL");
  const query = buildSyntheticJoinpayPayoutQuery(B, KEY, R); assert.equal(query.hmac, sign(ORDER.queryRequest, B)); assert.equal(query.sendable, false);
  assert.equal(query.hmac, "cec840f8f1e51bc46ef62ea1e72f9519");
  assert.equal(JSON.stringify(form).includes("BANK_PAY_DAILY_ORDER"), true);
});
test("出站边界：全局12到25位字母数字、正精确分、公账联行、日历与HTTPS", () => {
  for (const change of [{ merchantOrderNo: "bad-order-123" }, { merchantOrderNo: "short" }, { merchantOrderNo: "A".repeat(26) }, { netCents: "0" }, { netCents: "123.45" },
    { netCents: "10000000000000000" }, { receiverAccountType: "204" }, { isChecked: undefined }, { requestTime: "2026-02-30 12:00:00" },
    { callbackUrl: "http://example.invalid" }, { callbackUrl: "https://u:p@example.invalid" }, { callbackUrl: "https://example.invalid/#x" }, { paidDesc: "字".repeat(31) },
    { productCode: "BANK_PAY_COMPOSE_ORDER" }, { firstProductCode: "BANK_PAY_ORDINARY_ORDER" }, { productCode: "BANK_PAY_FAKE_ORDER" }, { paidUse: "BOGUS" }]) {
    assert.throws(() => buildSyntheticJoinpayPayoutRequest({ ...submit(), ...change } as any, KEY, R));
  }
  let reads = 0; const getter = { ...submit(), get receiverNameEnc() { reads++; return B.receiverNameEnc; } };
  assert.throws(() => buildSyntheticJoinpayPayoutRequest(getter, KEY, R), /INPUT_NOT_DATA/); assert.equal(reads, 0);
});
test("2001仅受理、2002申请拒绝、2003和未知码仅原号查询", () => {
  const v = { userNo: B.userNo, merchantOrderNo: B.merchantOrderNo };
  for (const [code, decision] of [["2001", "APPLICATION_ACCEPTED"], ["2002", "APPLICATION_REJECTED"], ["2003", "QUERY_ORIGINAL_REQUIRED"], ["2999", "QUERY_ORIGINAL_REQUIRED"]]) {
    const result = inspect("SYNC", { ...v, statusCode: code }); assert.equal(result.decision, decision); assert.equal(result.signature, "MATCH");
    assert.equal(reduceJoinpayPayoutObservation({ phase: "SUBMITTING", requiresReview: false, platformSerialNo: null }, result).reservationEffect, "UNCHANGED");
  }
  assert.equal(inspect("SYNC", { ...v, errorCode: "contradiction" }).decision, "REVIEW_REQUIRED");
});
test("205须原目标/净额/流水一致；查询fee缺失/未知单位保持null，不等同用户费", () => {
  const query = inspect("QUERY", transaction()); assert.equal(query.decision, "CHANNEL_REPORTED_SUCCEEDED"); assert.equal(query.paidCents, "12345");
  assert.equal(query.providerFeeRaw, "0.50"); assert.equal(query.providerFeeCents, null);
  assert.equal(inspect("QUERY", { ...transaction(), fee: "0.000123" }).providerFeeRaw, "0.000123");
  assert.equal(inspect("QUERY", { ...transaction(), fee: "0.000123" }, B, { ...R, providerFeeUnit: "CNY_YUAN" }).decision, "EVIDENCE_INCOMPLETE");
  const explicit = inspect("QUERY", transaction(), B, { ...R, providerFeeUnit: "CNY_YUAN" }); assert.equal(explicit.providerFeeCents, "50");
  const absent = inspect("QUERY", { ...transaction(), fee: undefined }); assert.equal(absent.decision, "CHANNEL_REPORTED_SUCCEEDED"); assert.equal(absent.providerFeeCents, null);
  assert.equal(inspect("QUERY", { ...transaction(), errorCode: "bad" }).decision, "REVIEW_REQUIRED");
});
test("所有原绑定错位均拒绝为真实终态候选，结果不泄露目标或hmac", () => {
  for (const change of [{ userNo: "888000000000002" }, { merchantOrderNo: "OTHER202610240001" }, { receiverAccountNoEnc: "OTHER_ACCOUNT" },
    { receiverNameEnc: "OTHER_NAME" }, { paidAmount: "123.46" }, { tradeMerchantNo: "other" }]) assert.equal(inspect("QUERY", { ...transaction(), ...change }).decision, "REVIEW_REQUIRED");
  assert.equal(inspect("QUERY", transaction(), { ...B, platformSerialNo: "OTHER_TRX" }).decision, "REVIEW_REQUIRED");
  const result = JSON.stringify(inspect("QUERY", transaction())); assert.equal(result.includes(B.receiverAccountNoEnc), false); assert.equal(result.includes(B.receiverNameEnc), false); assert.equal(result.includes("hmac"), false);
});
test("214字段空/null/缺失是签名查无单观察，保持原号与预留；不能推断卡号错", () => {
  for (const empty of [undefined, "", null]) {
    const result = inspect("QUERY", { ...transaction("214"), platformSerialNo: empty, receiverAccountNoEnc: empty, receiverNameEnc: empty, paidAmount: empty, fee: empty });
    assert.equal(result.decision, "PROVIDER_REPORTED_NOT_FOUND"); const state = reduceJoinpayPayoutObservation({ phase: "UNKNOWN", requiresReview: false, platformSerialNo: null }, result);
    assert.equal(state.phase, "UNKNOWN"); assert.equal(state.reservationEffect, "UNCHANGED"); assert.equal(state.nextOperation, "QUERY_ORIGINAL"); assert.equal(state.requiresNoExecutionProof, true);
  }
  assert.equal(inspect("NOTIFY", { ...transaction("214"), fee: undefined }).decision, "EVIDENCE_INCOMPLETE");
  for (const changed of [{ paidAmount: "999.99" }, { receiverAccountNoEnc: "another" }, { receiverNameEnc: "another" }]) assert.equal(inspect("QUERY", { ...transaction("214"), ...changed }).decision, "REVIEW_REQUIRED");
  assert.equal(inspect("QUERY", { ...transaction("214"), paidAmount: "1e2" }).decision, "EVIDENCE_INCOMPLETE");
  assert.equal(inspect("QUERY", { ...transaction("214"), platformSerialNo: "other" }, { ...B, platformSerialNo: "original" }).decision, "REVIEW_REQUIRED");
});
test("204/208与处理中/未知枚举分别记录，任何协议判定都不释放或付款", () => {
  for (const status of ["204", "208", "201", "202", "203", "210", "211", "212", "213", "999"]) {
    const result = inspect("QUERY", transaction(status)), next = reduceJoinpayPayoutObservation({ phase: "PROCESSING", requiresReview: false, platformSerialNo: null }, result);
    assert.equal(result.decision, ["204", "208"].includes(status) ? "CHANNEL_REPORTED_FAILED" : status === "999" ? "EVIDENCE_INCOMPLETE" : "PROCESSING");
    assert.equal(next.reservationEffect, "UNCHANGED"); assert.equal(next.mayAffectFunds, false); assert.notEqual(next.phase, "SUCCEEDED"); assert.notEqual(next.phase, "FAILED");
  }
});
test("QUERY失败与NOTIFY字段名不互猜；通知需要完整fee，ACK为独立合成JSON", () => {
  assert.equal(inspect("QUERY", { ...transaction(), statusCode: "2002" }).decision, "QUERY_FAILED");
  assert.equal(inspect("NOTIFY", { ...transaction("204"), errorCodeDesc: "synthetic failure" }).signature, "MATCH");
  assert.equal(inspect("NOTIFY", { ...transaction(), errorDesc: "wrong field" }).reason, "UNKNOWN_FIELD");
  assert.equal(inspect("NOTIFY", { ...transaction(), fee: undefined }).decision, "EVIDENCE_INCOMPLETE");
  assert.deepEqual(JSON.parse(syntheticJoinpayPayoutAck(true).body), { statusCode: "2001" }); assert.equal(syntheticJoinpayPayoutAck(true).sendable, false);
});
test("schema先拒重复键、UTF8/BOM、孤立代理、未知字段与错误number token", () => {
  const good = wire("QUERY", transaction());
  const ctx = { key: KEY, binding: B, rules: R, leaseCurrent: true };
  for (const body of [good.replace('"userNo":', '"userNo":"duplicate","userNo":'), "\ufeff" + good, good.replace('"synthetic"', '"\\ud800"'), good.replace('"status":205', '"status":"205"'), good.replace('"data":{', '"data":{"extra":"x",')]) {
    assert.equal(computeJoinpayPayoutResponse("QUERY", body, ctx).decision, "UNVERIFIED");
  }
  assert.equal(computeJoinpayPayoutResponse("QUERY", new Uint8Array([0xff]), ctx).decision, "UNVERIFIED");
  const bad = good.replace(/"hmac":"./, '"hmac":"z'); assert.equal(computeJoinpayPayoutResponse("QUERY", bad, ctx).decision, "UNVERIFIED");
  assert.equal(inspect("QUERY", { ...transaction(), fee: "1e2" }).decision, "EVIDENCE_INCOMPLETE");
});
test("成功白名单逐项缺失拒绝；金额最大值和unsafe integer保持整数分", () => {
  for (const name of ["platformSerialNo", "receiverAccountNoEnc", "receiverNameEnc", "paidAmount"]) assert.equal(inspect("QUERY", { ...transaction(), [name]: undefined }).decision, "EVIDENCE_INCOMPLETE");
  for (const [yuan, value] of [["99999999999999.99", "9999999999999999"], ["90071992547409.91", "9007199254740991"]] as const) {
    assert.equal(inspect("QUERY", { ...transaction(), paidAmount: yuan }, { ...B, netCents: value }).paidCents, value);
  }
  assert.equal(inspect("QUERY", { ...transaction(), paidAmount: "100000000000000.00" }).decision, "EVIDENCE_INCOMPLETE");
});
test("对象/JSON字符串与数字类型必须显式选定，不自动兼容官方矛盾示例", () => {
  const r: PayoutWireRules = { ...R, dataEncoding: "JSON_STRING", statusCodeToken: "NUMBER", statusToken: "STRING", amountToken: "STRING", feeToken: "STRING" };
  assert.equal(inspect("QUERY", transaction(), B, r).decision, "CHANNEL_REPORTED_SUCCEEDED");
  assert.equal(computeJoinpayPayoutResponse("QUERY", wire("QUERY", transaction(), r), { key: KEY, binding: B, rules: R, leaseCurrent: true }).decision, "UNVERIFIED");
});
test("已获成功候选不被旧同步受理或坏响应降级，已接纳终态只增review", () => {
  const success = inspect("QUERY", transaction()), accepted = inspect("SYNC", { userNo: B.userNo, merchantOrderNo: B.merchantOrderNo });
  const first = reduceJoinpayPayoutObservation({ phase: "UNKNOWN", requiresReview: false, platformSerialNo: null }, success);
  assert.equal(first.platformSerialNo, "SYNTHETIC_TRX_1");
  const changed = reduceJoinpayPayoutObservation(first, inspect("QUERY", { ...transaction(), platformSerialNo: "SYNTHETIC_TRX_2" }));
  assert.equal(changed.requiresReview, true); assert.equal(changed.platformSerialNo, first.platformSerialNo); assert.equal(changed.phase, first.phase);
  const quarantined = reduceJoinpayPayoutObservation({ phase: "UNKNOWN", requiresReview: true, platformSerialNo: null }, success);
  assert.equal(quarantined.phase, "UNKNOWN"); assert.equal(quarantined.platformSerialNo, null);
  const pending = { phase: "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE" as const, requiresReview: false, platformSerialNo: null };
  assert.equal(reduceJoinpayPayoutObservation(pending, accepted).phase, pending.phase);
  assert.equal(reduceJoinpayPayoutObservation(pending, inspect("QUERY", transaction("204"))).requiresReview, true);
  const terminal = { phase: "SUCCEEDED" as const, requiresReview: false, platformSerialNo: success.platformSerialNo };
  const conflict = reduceJoinpayPayoutObservation(terminal, inspect("QUERY", transaction("204"))); assert.equal(conflict.phase, "SUCCEEDED"); assert.equal(conflict.requiresReview, true);
  assert.equal(reduceJoinpayPayoutObservation({ ...terminal, platformSerialNo: "other" }, success).requiresReview, true);
});
test("旧lease仅STALE；合成包装永不获得正式证据/释放能力", () => {
  const body = wire("QUERY", transaction()), ctx = { key: KEY, binding: B, rules: R, leaseCurrent: false };
  const stale = computeJoinpayPayoutResponse("QUERY", body, ctx); assert.equal(stale.decision, "STALE");
  for (const phase of ["SUBMITTING", "PROCESSING", "UNKNOWN", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "SUCCEEDED", "FAILED"] as PayoutRequestPhase[]) {
    assert.equal(reduceJoinpayPayoutObservation({ phase, requiresReview: false, platformSerialNo: null }, stale).phase, phase);
  }
  const result = evaluateSyntheticJoinpayPayoutResponse("QUERY", body, { ...ctx, leaseCurrent: true }); assert.equal(result.evidenceLevel, "SYNTHETIC_PROTOCOL"); assert.equal(result.officialVerified, false); assert.equal(result.mayAffectFunds, false);
});

// S105的正常示例为数字状态，查无单示例为字符串214；只有显式选择该规则才按分支固定类型。
const documentedStatusRules = { ...R, statusToken: "NUMBER_EXCEPT_QUERY_214_STRING" } as unknown as PayoutWireRules;
const missing214 = () => ({ status: "214", userNo: B.userNo, merchantOrderNo: B.merchantOrderNo,
  platformSerialNo: "", receiverAccountNoEnc: "", receiverNameEnc: "", paidAmount: "", fee: "" });
const documentedContext = () => ({ key: KEY, binding: B, rules: documentedStatusRules, leaseCurrent: true });

test("S105显式状态规则同时处理数字处理中和字符串214，不把查无单变成资金释放", () => {
  const pending = wire("QUERY", transaction("203")), absent = wire("QUERY", missing214(), { ...R, statusToken: "STRING" });
  assert.deepEqual(preflightJoinpayPayoutResponse("QUERY", pending, { rules: documentedStatusRules }), { ok: true, reason: "SCHEMA_VALID" });
  assert.equal(computeJoinpayPayoutResponse("QUERY", pending, documentedContext()).decision, "PROCESSING");
  assert.deepEqual(preflightJoinpayPayoutResponse("QUERY", absent, { rules: documentedStatusRules }), { ok: true, reason: "SCHEMA_VALID" });
  const result = computeJoinpayPayoutResponse("QUERY", absent, documentedContext());
  assert.equal(result.decision, "PROVIDER_REPORTED_NOT_FOUND"); assert.equal(result.signature, "MATCH");
  assert.equal(result.paidCents, null); assert.equal(result.providerFeeCents, null);
  const next = reduceJoinpayPayoutObservation({ phase: "UNKNOWN", requiresReview: false, platformSerialNo: null }, result);
  assert.equal(next.phase, "UNKNOWN"); assert.equal(next.reservationEffect, "UNCHANGED"); assert.equal(next.nextOperation, "QUERY_ORIGINAL");
});

test("显式分支固定类型，不猜数字214、字符串成功或通知字符串214，旧规则保持原行为", () => {
  const numeric214 = wire("QUERY", missing214()), string205 = wire("QUERY", transaction(), { ...R, statusToken: "STRING" });
  const notify214 = wire("NOTIFY", transaction("214"), { ...R, statusToken: "STRING" });
  for (const [op, body] of [["QUERY", numeric214], ["QUERY", string205], ["NOTIFY", notify214]] as const) {
    assert.equal(preflightJoinpayPayoutResponse(op, body, { rules: documentedStatusRules }).reason, "FIELD_INVALID");
    assert.equal(computeJoinpayPayoutResponse(op, body, documentedContext()).decision, "UNVERIFIED");
  }
  assert.equal(computeJoinpayPayoutResponse("QUERY", numeric214, { ...documentedContext(), rules: R }).decision, "PROVIDER_REPORTED_NOT_FOUND");
  assert.equal(computeJoinpayPayoutResponse("QUERY", string205, { ...documentedContext(), rules: { ...R, statusToken: "STRING" } }).decision, "CHANNEL_REPORTED_SUCCEEDED");
  assert.equal(computeJoinpayPayoutResponse("QUERY", wire("QUERY", transaction()), documentedContext()).decision, "CHANNEL_REPORTED_SUCCEEDED");
});

test("字符串214仍逐字验签并绑定原商户原号，篡改、异单和非空金额冲突不能借分支放过", () => {
  const make = (v: Values) => wire("QUERY", v, { ...R, statusToken: "STRING" });
  for (const change of [{ userNo: "888000000000002" }, { merchantOrderNo: "OTHER202610240001" }, { paidAmount: "123.46" }]) {
    const result = computeJoinpayPayoutResponse("QUERY", make({ ...missing214(), ...change }), documentedContext());
    assert.equal(result.decision, "REVIEW_REQUIRED"); assert.equal(result.signature, "MATCH"); assert.equal(result.binding, "MISMATCH");
  }
  const tampered = make(missing214()).replace('"status":"214"', '"status":"205"');
  assert.equal(computeJoinpayPayoutResponse("QUERY", tampered, documentedContext()).decision, "UNVERIFIED");
  const badHmac = make(missing214()).replace(/"hmac":"[a-f0-9]{32}"/, '"hmac":"00000000000000000000000000000000"');
  assert.equal(computeJoinpayPayoutResponse("QUERY", badHmac, documentedContext()).reason, "SIGNATURE_MISMATCH");
});
