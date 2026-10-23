import {
  JoinpayProtocolError, centsToJoinpayYuan, decodeJoinpayJson, decodeJoinpayQuery, joinpayMd5Sign,
  validateJoinpaySignedFields, type JoinpayField, type JoinpaySignedForm,
} from "./joinpay-protocol";

/** 官网 S64/S177 2.3；只做协议计算，不把申请受理、合成签名或本地应付当退款到账。 */
export const JOINPAY_REFUND_PROFILE = Object.freeze({
  profileId: "JOINPAY_REFUND_2_3_MD5_DRAFT", evidenceLevel: "SYNTHETIC_PROTOCOL", merchantUse: false,
  productionEnabled: false, mayProduceRefundFact: false,
  blockers: ["RF_OFFICIAL_VECTOR_NOT_OBTAINED", "RF_PRODUCT_NOT_VERIFIED", "RF_TIMEZONE_NOT_OBTAINED",
    "RF_JSON_NUMBER_SIGNING_NOT_OBTAINED", "RF_LEGACY_COMPATIBILITY_NOT_VERIFIED"] as const,
});

type Bound = JoinpayField["bound"];
const max = (n: number): Bound => ({ kind: "MAX", n });
const pattern = (re: RegExp): Bound => ({ kind: "RE", re });
const version: Bound = { kind: "FIXED", value: "2.3" }, time: Bound = { kind: "TIME" };
const yuan = pattern(/^(0|[1-9]\d{0,13})\.\d{2}$/);
const orderNo = pattern(/^[A-Za-z0-9_-]{1,50}$/), refundNo = pattern(/^[A-Za-z0-9_-]{1,30}$/), trxNo = pattern(/^[A-Za-z0-9_-]{1,50}$/);
const account = pattern(/^(SETTLED|ADVANCE)$/);
const required = (name: string, bound: Bound): JoinpayField => ({ name, bound, required: true, empty: "REJECT" });
const emptyAllowed = (name: string, bound: Bound): JoinpayField => ({ name, bound, required: true, empty: "ALLOWED" });
const optional = (name: string, bound: Bound): JoinpayField => ({ name, bound, required: false, empty: "EQUIV" });

const REQUEST = [required("p0_Version", version), required("p1_MerchantNo", max(15)), required("p2_OrderNo", orderNo),
  required("p3_RefundOrderNo", refundNo), required("p4_RefundAmount", yuan), optional("p5_RefundReason", max(400)),
  required("p6_NotifyUrl", { kind: "URL", max: 300 }), optional("pa_FundsAccount", account)];
const SYNC = [required("r0_Version", version), required("r1_MerchantNo", max(15)), required("r2_OrderNo", orderNo),
  required("r3_RefundOrderNo", orderNo), required("r4_RefundAmount", yuan), required("r5_RefundTrxNo", trxNo),
  required("ra_Status", max(20)), required("rb_Code", max(20)), emptyAllowed("rc_CodeMsg", max(10)), optional("re_FundsAccount", account)];
const NOTIFY = [required("r0_Version", version), required("r1_MerchantNo", max(15)), required("r2_OrderNo", orderNo),
  required("r3_RefundOrderNo", orderNo), required("r4_RefundAmount", yuan), required("r5_RefundTrxNo", trxNo),
  optional("r6_RefundCompleteTime", time), optional("r7_RefundWay", max(16)), optional("r8_ReceiveAccountNo", max(64)),
  required("ra_Status", max(20)), required("rb_Code", max(10)), emptyAllowed("rc_CodeMsg", max(20)),
  emptyAllowed("rd_MarketRefAmount", yuan), optional("re_FundsAccount", account)];
const QUERY_REQUEST = [required("p0_Version", version), required("p1_MerchantNo", max(15)), required("p2_RefundOrderNo", refundNo)];
const QUERY = [required("r0_Version", version), required("r1_MerchantNo", max(15)), required("r2_RefundOrderNo", orderNo),
  required("r3_RefundAmount", yuan), optional("r4_RefundTrxNo", trxNo), optional("r5_RefundCompleteTime", time),
  optional("r8_RefundWay", max(16)), optional("r9_ReceiveAccountNo", max(64)), optional("ra_Status", max(20)),
  required("rb_Code", max(10)), emptyAllowed("rc_CodeMsg", max(20)), emptyAllowed("rd_MarketRefAmount", yuan), optional("re_FundsAccount", account)];

export const JOINPAY_REFUND_SIGNATURE_ORDER = Object.freeze({
  refundRequest: REQUEST.map(f => f.name), refundResponse: SYNC.map(f => f.name), refundNotify: NOTIFY.map(f => f.name),
  queryRefundRequest: QUERY_REQUEST.map(f => f.name), queryRefundResponse: QUERY.map(f => f.name),
});

function sign(fields: readonly JoinpayField[], values: Record<string, string | undefined>, key: string): JoinpaySignedForm {
  const order = fields.map(f => f.name), hmac = joinpayMd5Sign(order, values, key);
  const raw = new Map(Object.entries(values).filter((e): e is [string, string] => e[1] !== undefined).map(([k, value]) => [k, { value, numberToken: false }]));
  raw.set("hmac", { value: hmac, numberToken: false });
  const checked = validateJoinpaySignedFields(fields, raw);
  if (!checked.ok) throw new JoinpayProtocolError(checked.reason, checked.field);
  return { fields: [...fields.filter(f => checked.values[f.name] !== undefined).map(f => [f.name, checked.values[f.name]!] as const), ["hmac", hmac]],
    hmac, evidenceLevel: "SYNTHETIC_PROTOCOL", sendable: false, blockers: JOINPAY_REFUND_PROFILE.blockers };
}

export type JoinpayRefundBinding = Readonly<{
  merchantNo: string; originalPaymentOrderNo: string; refundOrderNo: string; amountCents: string; currency: "CNY";
  fundsAccount?: "SETTLED" | "ADVANCE"; providerRefundTrxNo?: string;
}>;

export function buildJoinpayRefundRequest(input: JoinpayRefundBinding & { notifyUrl: string; reason?: string }, key: string): JoinpaySignedForm {
  if (input.currency !== "CNY") throw new JoinpayProtocolError("REFUND_CURRENCY_NOT_SUPPORTED");
  const url = typeof input.notifyUrl === "string" && URL.canParse(input.notifyUrl) ? new URL(input.notifyUrl) : null;
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash || Buffer.byteLength(input.notifyUrl, "utf8") > 300) throw new JoinpayProtocolError("REFUND_NOTIFY_URL_INVALID");
  if (input.reason !== undefined && typeof input.reason !== "string") throw new JoinpayProtocolError("REFUND_REASON_NOT_STRING");
  if (input.reason !== undefined && Buffer.byteLength(input.reason, "utf8") > 400) throw new JoinpayProtocolError("REFUND_REASON_UTF8_TOO_LONG");
  return sign(REQUEST, { p0_Version: "2.3", p1_MerchantNo: input.merchantNo, p2_OrderNo: input.originalPaymentOrderNo,
    p3_RefundOrderNo: input.refundOrderNo, p4_RefundAmount: centsToJoinpayYuan(input.amountCents), p5_RefundReason: input.reason,
    p6_NotifyUrl: input.notifyUrl, pa_FundsAccount: input.fundsAccount }, key);
}

export function buildJoinpayRefundQuery(input: Pick<JoinpayRefundBinding, "merchantNo" | "refundOrderNo">, key: string): JoinpaySignedForm {
  return sign(QUERY_REQUEST, { p0_Version: "2.3", p1_MerchantNo: input.merchantNo, p2_RefundOrderNo: input.refundOrderNo }, key);
}

export type RefundProtocolResult = {
  operation: "REFUND_SYNC" | "REFUND_QUERY" | "REFUND_NOTIFY";
  result: "APPLICATION_ACCEPTED" | "APPLICATION_REJECTED" | "ORIGINAL_REFUND_QUERY_REQUIRED" | "CHANNEL_REPORTED_SUCCEEDED"
    | "CHANNEL_REPORTED_FAILED" | "PROCESSING" | "UNVERIFIED" | "STALE" | "REVIEW_REQUIRED";
  reason?: string; field?: string; channelCode?: string; channelStatus?: string;
  signature: "NOT_CHECKED" | "MISMATCH" | "SYNTHETIC_SELF_CONSISTENT";
  providerRefundTrxNo?: string; completedAtRaw?: string; refundWay?: string; numberTokens?: readonly string[];
  ack?: "success" | "fail"; evidenceLevel: "SYNTHETIC_PROTOCOL"; officialVerified: false; formalRefund: false;
};
function result(operation: RefundProtocolResult["operation"], value: RefundProtocolResult["result"], detail: Partial<RefundProtocolResult> = {}): RefundProtocolResult {
  return { operation, result: value, signature: "NOT_CHECKED", ...(operation === "REFUND_NOTIFY" ? { ack: "fail" as const } : {}),
    ...detail, evidenceLevel: "SYNTHETIC_PROTOCOL", officialVerified: false, formalRefund: false };
}
const MUST_QUERY = new Set(["0", "4", "102", "110", "10080000", "10080002", "20090004", "20090012", "CR000007"]);
const APPLICATION_REJECT = new Set(["10080015", "10080016", "20090001", "20090002", "20090020", "JS002012"]);
const REFUND_WAYS = new Set(["ORIGINAL", "BALANCE", "OTHER_BALANCE", "OTHER_BANKCARD"]);

/** 原退款号绑定；查单应答不含原支付号，只能通过持久退款意图找回原付款，不推造缺失字段。 */
export function evaluateJoinpayRefundResponse(operation: RefundProtocolResult["operation"], body: string | Uint8Array,
  context: { binding: JoinpayRefundBinding | null; key: string; leaseCurrent?: boolean }): RefundProtocolResult {
  if (!["REFUND_SYNC", "REFUND_QUERY", "REFUND_NOTIFY"].includes(operation)) throw new JoinpayProtocolError("REFUND_OPERATION_INVALID");
  if (operation !== "REFUND_NOTIFY" && context.leaseCurrent !== true) return result(operation, "STALE", { reason: "STALE_LEASE" });
  const decoded = operation === "REFUND_NOTIFY" ? (typeof body === "string" ? decodeJoinpayQuery(body) : { ok: false as const, reason: "RAW_QUERY_REQUIRED" }) : decodeJoinpayJson(body);
  if (!decoded.ok) return result(operation, "UNVERIFIED", { reason: decoded.reason });
  const schema = operation === "REFUND_SYNC" ? SYNC : operation === "REFUND_NOTIFY" ? NOTIFY : QUERY;
  const checked = validateJoinpaySignedFields(schema, decoded.raw);
  if (!checked.ok) return result(operation, "UNVERIFIED", { reason: checked.reason, field: checked.field });
  const expected = context.binding;
  if (!expected) return result(operation, "UNVERIFIED", { reason: "BINDING_NOT_FOUND" });
  if (expected.currency !== "CNY") return result(operation, "REVIEW_REQUIRED", { reason: "REFUND_CURRENCY_NOT_SUPPORTED" });
  if (joinpayMd5Sign(schema.map(f => f.name), checked.values, context.key) !== checked.hmac.toLowerCase()) return result(operation, "UNVERIFIED", { reason: "SIGNATURE_INVALID", signature: "MISMATCH" });
  const v = checked.values, query = operation === "REFUND_QUERY";
  const way = query ? v.r8_RefundWay : v.r7_RefundWay;
  const signed = { signature: "SYNTHETIC_SELF_CONSISTENT" as const, numberTokens: checked.numberTokens, channelCode: v.rb_Code, channelStatus: v.ra_Status, refundWay: way };
  if (v.r1_MerchantNo !== expected.merchantNo || (query ? v.r2_RefundOrderNo : v.r3_RefundOrderNo) !== expected.refundOrderNo
    || (!query && v.r2_OrderNo !== expected.originalPaymentOrderNo) || (query ? v.r3_RefundAmount : v.r4_RefundAmount) !== centsToJoinpayYuan(expected.amountCents)
    || v.re_FundsAccount !== expected.fundsAccount) return result(operation, "REVIEW_REQUIRED", { ...signed, reason: "BINDING_MISMATCH" });
  const trx = query ? v.r4_RefundTrxNo : v.r5_RefundTrxNo;
  if (expected.providerRefundTrxNo !== undefined && trx !== undefined && trx !== expected.providerRefundTrxNo) return result(operation, "REVIEW_REQUIRED", { ...signed, reason: "REFUND_TRANSACTION_MISMATCH" });
  if (way !== undefined && !REFUND_WAYS.has(way)) return result(operation, "REVIEW_REQUIRED", { ...signed, reason: "REFUND_WAY_UNKNOWN" });
  if (v.rd_MarketRefAmount !== undefined && v.rd_MarketRefAmount !== "0.00") return result(operation, "REVIEW_REQUIRED", { ...signed, reason: "MARKET_REFUND_AMOUNT_REVIEW" });
  const status = v.ra_Status, code = v.rb_Code!;
  if (MUST_QUERY.has(code)) return result(operation, "ORIGINAL_REFUND_QUERY_REQUIRED", { ...signed, reason: "ORIGINAL_NUMBER_ONLY" });
  if (operation === "REFUND_SYNC") {
    if (code === "100" && status === "100") return result(operation, "APPLICATION_ACCEPTED", { ...signed, providerRefundTrxNo: trx });
    if (status === "101" && APPLICATION_REJECT.has(code)) return result(operation, "APPLICATION_REJECTED", signed);
    return result(operation, "ORIGINAL_REFUND_QUERY_REQUIRED", { ...signed, reason: "SYNC_RESULT_UNKNOWN" });
  }
  if (!status) return result(operation, "UNVERIFIED", { ...signed, reason: "STATUS_MISSING" });
  if (status === "102") return operation === "REFUND_QUERY" && code === "100"
    ? result(operation, "PROCESSING", signed) : result(operation, "REVIEW_REQUIRED", { ...signed,
      reason: operation === "REFUND_NOTIFY" ? "NOTIFY_STATUS_102_CONFLICT" : "STATUS_CODE_CONFLICT" });
  if (status !== "100" && status !== "101") return result(operation, "UNVERIFIED", { ...signed, reason: "STATUS_UNKNOWN" });
  if ((status === "100") !== (code === "100")) return result(operation, "REVIEW_REQUIRED", { ...signed, reason: "STATUS_CODE_CONFLICT" });
  if (!trx) return result(operation, "UNVERIFIED", { ...signed, reason: "REFUND_TRANSACTION_MISSING" });
  const completed = query ? v.r5_RefundCompleteTime : v.r6_RefundCompleteTime;
  if (status === "100" && !completed) return result(operation, "UNVERIFIED", { ...signed, reason: "COMPLETION_TIME_MISSING" });
  return result(operation, status === "100" ? "CHANNEL_REPORTED_SUCCEEDED" : "CHANNEL_REPORTED_FAILED", { ...signed,
    providerRefundTrxNo: trx, completedAtRaw: completed, ...(operation === "REFUND_NOTIFY" ? { ack: "success" as const } : {}) });
}
