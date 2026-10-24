import { timingSafeEqual } from "node:crypto";
import { centsToJoinpayYuan, decodeJoinpayJson, decodeJoinpayJsonEnvelope, joinpayMd5Sign } from "../order/joinpay-protocol";

export const JOINPAY_PAYOUT_SIGNATURE_ORDER = Object.freeze({
  submitRequest: Object.freeze(["userNo", "tradeMerchantNo", "productCode", "requestTime", "merchantOrderNo", "receiverAccountNoEnc", "receiverNameEnc", "receiverAccountType", "receiverBankChannelNo", "paidAmount", "currency", "isChecked", "paidDesc", "paidUse", "callbackUrl", "firstProductCode"]),
  submitResponse: Object.freeze(["statusCode", "message", "errorCode", "errorDesc", "userNo", "merchantOrderNo"]),
  queryRequest: Object.freeze(["userNo", "merchantOrderNo"]),
  queryResponse: Object.freeze(["statusCode", "message", "status", "errorCode", "errorDesc", "userNo", "tradeMerchantNo", "merchantOrderNo", "platformSerialNo", "receiverAccountNoEnc", "receiverNameEnc", "paidAmount", "fee"]),
  notification: Object.freeze(["status", "errorCode", "errorCodeDesc", "userNo", "tradeMerchantNo", "merchantOrderNo", "platformSerialNo", "receiverAccountNoEnc", "receiverNameEnc", "paidAmount", "fee"]),
});
export const JOINPAY_PAYOUT_PROFILE = Object.freeze({
  evidenceLevel: "SYNTHETIC_PROTOCOL", merchantUse: false, officialVerified: false, mayAffectFunds: false,
  blockers: Object.freeze(["OFFICIAL_KAT", "MERCHANT_PAYOUT_PERMISSION", "TARGET_ENCRYPTION_ENCODING_AND_SIGN_ORDER", "JSON_ENVELOPE_AND_NUMERIC_TYPES", "FAILURE_NO_EXECUTION_AND_PROVIDER_FEE_SEMANTICS", "TIMEZONE_AND_QUERY_RECOVERY_WINDOW"]),
});
export class JoinpayPayoutProtocolError extends Error { constructor(readonly code: string) { super(code); } }
const invalid = (code: string): never => { throw new JoinpayPayoutProtocolError(code); };
const text = (v: unknown, max = 2048): v is string => typeof v === "string" && v.length > 0 && v.trim() === v && !/\p{Cs}/u.test(v) && Buffer.byteLength(v) <= max;
const orderNo = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{12,25}$/.test(v);
const merchant = (v: unknown): v is string => typeof v === "string" && /^[0-9]{1,32}$/.test(v);
const cents = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v) && BigInt(v) <= 9999999999999999n;
export type PayoutWireRules = Readonly<{
  dataEncoding: "OBJECT" | "JSON_STRING"; statusCodeToken: "STRING" | "NUMBER"; statusToken: "STRING" | "NUMBER" | "NUMBER_EXCEPT_QUERY_214_STRING";
  amountToken: "STRING" | "NUMBER"; feeToken: "STRING" | "NUMBER"; accountTypeToken: "STRING" | "NUMBER";
  optionalSigning: "ABSENT_EMPTY_NULL_EQUIVALENT"; numericSigning: "RAW_JSON_TOKEN";
  unknownFields: "REJECT"; notFoundShape: "IDENTITY_ONLY_214"; targetBinding: "EXACT_RECORDED_OPAQUE_VALUE";
  providerFeeUnit: "UNKNOWN" | "CNY_YUAN";
}>;
function snapshot<T extends object>(value: T): T {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return invalid("PAYOUT_INPUT_NOT_DATA");
  const ds = Object.getOwnPropertyDescriptors(value), out: Record<string, string | undefined> = {};
  if (Object.getOwnPropertySymbols(ds).length) invalid("PAYOUT_INPUT_NOT_DATA");
  for (const [k, d] of Object.entries(ds)) { if (!("value" in d) || !d.enumerable || k === "__proto__" || /\p{Cs}/u.test(k) || d.value !== undefined && typeof d.value !== "string") invalid("PAYOUT_INPUT_NOT_DATA"); out[k] = d.value; }
  return Object.freeze(out) as T;
}
function rules(r: PayoutWireRules): PayoutWireRules {
  r = snapshot(r);
  if (!r || !["OBJECT", "JSON_STRING"].includes(r.dataEncoding) || ![r.statusCodeToken, r.amountToken, r.feeToken, r.accountTypeToken].every(v => v === "STRING" || v === "NUMBER")
    || !["STRING", "NUMBER", "NUMBER_EXCEPT_QUERY_214_STRING"].includes(r.statusToken)
    || r.optionalSigning !== "ABSENT_EMPTY_NULL_EQUIVALENT" || r.numericSigning !== "RAW_JSON_TOKEN" || r.unknownFields !== "REJECT"
    || r.notFoundShape !== "IDENTITY_ONLY_214" || r.targetBinding !== "EXACT_RECORDED_OPAQUE_VALUE" || !["UNKNOWN", "CNY_YUAN"].includes(r.providerFeeUnit)) invalid("PAYOUT_RULES_REQUIRED");
  return r;
}
export type JoinpayPayoutBinding = Readonly<{
  merchantIdentityId: string; userNo: string; merchantOrderNo: string; tradeMerchantNo?: string;
  receiverAccountNoEnc: string; receiverNameEnc: string; netCents: string; platformSerialNo?: string;
}>;
function binding(b: JoinpayPayoutBinding): JoinpayPayoutBinding {
  b = snapshot(b);
  if (!b || !text(b.merchantIdentityId, 128) || !merchant(b.userNo) || !orderNo(b.merchantOrderNo)
    || !text(b.receiverAccountNoEnc, 8192) || !text(b.receiverNameEnc, 8192) || !cents(b.netCents)
    || b.tradeMerchantNo !== undefined && !text(b.tradeMerchantNo, 128) || b.platformSerialNo !== undefined && !text(b.platformSerialNo, 128)) invalid("PAYOUT_BINDING_INVALID");
  return b;
}
export type JoinpayPayoutSubmitInput = JoinpayPayoutBinding & Readonly<{ productCode: string; requestTime: string; receiverAccountType: "201" | "204";
  receiverBankChannelNo?: string; isChecked: "201" | "202"; paidDesc: string; paidUse: string; callbackUrl?: string; firstProductCode?: string }>;
export const JOINPAY_PAYOUT_WIRE_TEMPLATE_FIELDS = Object.freeze(["productCode", "isChecked", "paidDesc", "paidUse", "callbackUrl", "firstProductCode"] as const);
export type JoinpayPayoutWireTemplate = Pick<JoinpayPayoutSubmitInput, (typeof JOINPAY_PAYOUT_WIRE_TEMPLATE_FIELDS)[number]>;
/** 配置模板与实际请求共用同一校验，避免缺项模板借完整KAT绕过。 */
export function validateJoinpayPayoutWireTemplate(input: JoinpayPayoutWireTemplate): void {
  input = snapshot(input);
  const products = ["BANK_PAY_ORDINARY_ORDER", "BANK_PAY_DAILY_ORDER", "BANK_PAY_MAT_ENDOWMENT_ORDER", "BANK_PAY_COMPOSE_ORDER"];
  if (Object.keys(input).some(k => !(JOINPAY_PAYOUT_WIRE_TEMPLATE_FIELDS as readonly string[]).includes(k)) || !products.includes(input.productCode)
    || !["201", "202"].includes(input.isChecked) || !text(input.paidDesc, 120) || [...input.paidDesc].length > 30
    || typeof input.paidUse !== "string" || !/^(?:20[1-9]|21[01])$/.test(input.paidUse)) invalid("PAYOUT_WIRE_TEMPLATE_INVALID");
  if (input.firstProductCode !== undefined && !text(input.firstProductCode, 128)) invalid("PAYOUT_FIRST_PRODUCT_INVALID");
  if (input.productCode === "BANK_PAY_COMPOSE_ORDER" ? !products.slice(0, 3).includes(input.firstProductCode ?? "") : input.firstProductCode !== undefined) invalid("PAYOUT_FIRST_PRODUCT_INVALID");
  if (input.callbackUrl !== undefined) {
    if (!text(input.callbackUrl, 2048) || !URL.canParse(input.callbackUrl)) invalid("PAYOUT_CALLBACK_INVALID");
    const url = new URL(input.callbackUrl); if (url.protocol !== "https:" || url.username || url.password || url.hash) invalid("PAYOUT_CALLBACK_INVALID");
  }
}
function calendar(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) return false;
  const [y, m, d, h, n, s] = value.split(/[- :]/).map(Number), date = new Date(Date.UTC(y!, m! - 1, d, h, n, s));
  return y! >= 1000 && date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d && date.getUTCHours() === h && date.getUTCMinutes() === n && date.getUTCSeconds() === s;
}
function computeForm(operation: "SUBMIT" | "QUERY", values: Record<string, string | undefined>, key: string, r: PayoutWireRules) {
  const order = operation === "SUBMIT" ? JOINPAY_PAYOUT_SIGNATURE_ORDER.submitRequest : JOINPAY_PAYOUT_SIGNATURE_ORDER.queryRequest;
  const hmac = joinpayMd5Sign(order, values, key), fields = Object.freeze([...order.filter(n => values[n] !== undefined).map(n => Object.freeze([n, values[n]!] as const)), Object.freeze(["hmac", hmac] as const)]);
  const numeric = (n: string) => n === "paidAmount" && r.amountToken === "NUMBER" || n === "receiverAccountType" && r.accountTypeToken === "NUMBER";
  const body = "{" + fields.map(([n, v]) => JSON.stringify(n) + ":" + (numeric(n) ? v : JSON.stringify(v))).join(",") + "}";
  return Object.freeze({ operation, fields, body, hmac });
}
/** Enc值仅作不透明协议夹具；不猜加密、编码或密钥，不产生可外发请求品牌。 */
function submitValues(input: JoinpayPayoutSubmitInput, r: PayoutWireRules):Record<string,string|undefined> {
  input = snapshot(input); r = rules(r); binding(input);
  validateJoinpayPayoutWireTemplate(Object.fromEntries(JOINPAY_PAYOUT_WIRE_TEMPLATE_FIELDS.map(k => [k, input[k]])) as JoinpayPayoutWireTemplate);
  if (!calendar(input.requestTime) || !["201", "204"].includes(input.receiverAccountType) || input.receiverAccountType === "204" && !text(input.receiverBankChannelNo, 128)
    || input.receiverBankChannelNo !== undefined && !text(input.receiverBankChannelNo, 128)) invalid("PAYOUT_REQUEST_INVALID");
  const values = { userNo: input.userNo, tradeMerchantNo: input.tradeMerchantNo, productCode: input.productCode, requestTime: input.requestTime,
    merchantOrderNo: input.merchantOrderNo, receiverAccountNoEnc: input.receiverAccountNoEnc, receiverNameEnc: input.receiverNameEnc,
    receiverAccountType: input.receiverAccountType, receiverBankChannelNo: input.receiverBankChannelNo, paidAmount: centsToJoinpayYuan(input.netCents),
    currency: "201", isChecked: input.isChecked, paidDesc: input.paidDesc, paidUse: input.paidUse, callbackUrl: input.callbackUrl, firstProductCode: input.firstProductCode };
  return values;
}
export function computeJoinpayPayoutQuery(input: Pick<JoinpayPayoutBinding, "userNo" | "merchantOrderNo">, key: string, r: PayoutWireRules) {
  input = snapshot(input); r = rules(r); if (!merchant(input?.userNo) || !orderNo(input?.merchantOrderNo)) invalid("PAYOUT_BINDING_INVALID");
  return computeForm("QUERY", { userNo: input.userNo, merchantOrderNo: input.merchantOrderNo }, key, r);
}
export type PayoutOperation = "SYNC" | "QUERY" | "NOTIFY";
export type PayoutDecision = "APPLICATION_ACCEPTED" | "APPLICATION_REJECTED" | "QUERY_ORIGINAL_REQUIRED" | "QUERY_FAILED" | "PROCESSING"
  | "CHANNEL_REPORTED_SUCCEEDED" | "CHANNEL_REPORTED_FAILED" | "PROVIDER_REPORTED_NOT_FOUND" | "EVIDENCE_INCOMPLETE" | "REVIEW_REQUIRED" | "UNVERIFIED" | "STALE";
export type PayoutCalculation = Readonly<{ operation: PayoutOperation; decision: PayoutDecision; signature: "MATCH" | "MISMATCH" | "NOT_CHECKED";
  binding: "MATCH" | "MISMATCH" | "NOT_CHECKED"; reason: string; responseCode: string | null; providerStatus: string | null;
  platformSerialNo: string | null; paidCents: string | null; providerFeeRaw: string | null; providerFeeCents: string | null }>;
function amount(value: string): string | null {
  if (!/^(0|[1-9][0-9]{0,13})(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split("."), result = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return result <= 9999999999999999n ? result.toString() : null;
}
type ResponseFailure = { ok: false; decision: "UNVERIFIED" | "EVIDENCE_INCOMPLETE"; reason: string };
const responseFailure = (decision: ResponseFailure["decision"], reason: string): ResponseFailure => ({ ok: false, decision, reason });
function readPayoutResponse(operation: PayoutOperation, body: string | Uint8Array, r: PayoutWireRules): ResponseFailure | { ok: true; values: Record<string, string | undefined>; hmac: string } {
  if (typeof body !== "string" && !(body instanceof Uint8Array) || Buffer.byteLength(body) > 65536) return responseFailure("UNVERIFIED", "BODY_REJECTED");
  const decoded = operation === "NOTIFY" ? decodeJoinpayJson(body) : decodeJoinpayJsonEnvelope(body, r.dataEncoding);
  if (!decoded.ok) return responseFailure("UNVERIFIED", decoded.reason);
  const outer = "top" in decoded ? decoded.top : decoded.raw, inner = "data" in decoded ? decoded.data : decoded.raw;
  const order = operation === "SYNC" ? JOINPAY_PAYOUT_SIGNATURE_ORDER.submitResponse : operation === "QUERY" ? JOINPAY_PAYOUT_SIGNATURE_ORDER.queryResponse : JOINPAY_PAYOUT_SIGNATURE_ORDER.notification;
  if (operation !== "NOTIFY" && [...outer.keys()].some(n => !["statusCode", "message", "data"].includes(n))
    || [...inner.keys()].some(n => n !== "hmac" && (!order.includes(n) || operation !== "NOTIFY" && ["statusCode", "message"].includes(n)))) return responseFailure("UNVERIFIED", "UNKNOWN_FIELD");
  const values: Record<string, string | undefined> = {};
  for (const name of order) {
    const field = (operation !== "NOTIFY" && ["statusCode", "message"].includes(name) ? outer : inner).get(name);
    if (!field || field.value === null || field.value === "") { values[name] = ""; continue; }
    // S105的214示例为字符串；显式规则固定该分支类型，其余状态仍要求数字。
    const statusToken = r.statusToken === "NUMBER_EXCEPT_QUERY_214_STRING" ? operation === "QUERY" && field.value === "214" ? "STRING" : "NUMBER" : r.statusToken;
    const token = name === "statusCode" ? r.statusCodeToken : name === "status" ? statusToken : name === "paidAmount" ? r.amountToken : name === "fee" ? r.feeToken : "STRING";
    if (!text(field.value, name.startsWith("receiver") ? 8192 : name === "platformSerialNo" ? 128 : 2048) || field.numberToken !== (token === "NUMBER")
      || ["status", "statusCode"].includes(name) && !/^[0-9]{3,8}$/.test(field.value)) return responseFailure("UNVERIFIED", "FIELD_INVALID"); values[name] = field.value;
  }
  const required = operation === "SYNC" ? ["statusCode", "message", "userNo", "merchantOrderNo"] : operation === "QUERY" ? ["statusCode", "message", "status", "userNo", "merchantOrderNo"] : ["status", "userNo", "merchantOrderNo"];
  if (required.some(n => !values[n])) return responseFailure("EVIDENCE_INCOMPLETE", "IDENTITY_OR_STATUS_MISSING");
  const hmac = inner.get("hmac");
  if (!hmac || hmac.numberToken || typeof hmac.value !== "string" || !/^[a-fA-F0-9]{32}$/.test(hmac.value)) return responseFailure("UNVERIFIED", "HMAC_INVALID");
  return { ok: true, values, hmac: hmac.value };
}
function readPayoutTransactionBasis(operation: PayoutOperation, values: Record<string, string | undefined>, r: PayoutWireRules): ResponseFailure | {
  ok: true; paidCents: string | null; feeRaw: string | null; feeCents: string | null;
} {
  const paidCents = values.paidAmount ? amount(values.paidAmount) : null, feeRaw = values.fee || null,
    feeValid = feeRaw !== null && feeRaw.length <= 128 && /^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(feeRaw), feeCents = feeRaw !== null && r.providerFeeUnit === "CNY_YUAN" ? amount(feeRaw) : null;
  if (operation !== "SYNC" && !(operation === "QUERY" && values.statusCode !== "2001")) {
    if (operation === "QUERY" && values.status === "214") {
      if (values.paidAmount && paidCents === null || feeRaw !== null && (!feeValid || r.providerFeeUnit === "CNY_YUAN" && feeCents === null)) return responseFailure("EVIDENCE_INCOMPLETE", "NOT_FOUND_NONEMPTY_VALUE_INVALID");
    } else if (!values.platformSerialNo || !values.receiverAccountNoEnc || !values.receiverNameEnc || paidCents === null || operation === "NOTIFY" && !feeValid || feeRaw !== null && (!feeValid || r.providerFeeUnit === "CNY_YUAN" && feeCents === null)) {
      return responseFailure("EVIDENCE_INCOMPLETE", "TRANSACTION_BASIS_MISSING");
    }
  }
  return { ok: true, paidCents, feeRaw, feeCents };
}
/** 无钥schema前检与正式计算共用解析器；通过仅代表结构完整。 */
export function preflightJoinpayPayoutResponse(operation: PayoutOperation, body: string | Uint8Array, context: { rules: PayoutWireRules }): Readonly<{ ok: boolean; reason: string }> {
  if (!["SYNC", "QUERY", "NOTIFY"].includes(operation)) invalid("PAYOUT_OPERATION_INVALID");
  const r = rules(context.rules), fields = readPayoutResponse(operation, body, r);
  if (!fields.ok) return Object.freeze({ ok: false, reason: fields.reason });
  const basis = readPayoutTransactionBasis(operation, fields.values, r);
  return Object.freeze({ ok: basis.ok, reason: basis.ok ? "SCHEMA_VALID" : basis.reason });
}
/** 只计算协议结论；MATCH没有官方验签/来源品牌或账务接纳能力。 */
export function computeJoinpayPayoutResponse(operation: PayoutOperation, body: string | Uint8Array,
  context: { rules: PayoutWireRules; key: string; binding: JoinpayPayoutBinding; leaseCurrent?: boolean }): PayoutCalculation {
  if (!["SYNC", "QUERY", "NOTIFY"].includes(operation)) invalid("PAYOUT_OPERATION_INVALID");
  const r = rules(context.rules), b = binding(context.binding), key = context.key, leaseCurrent = context.leaseCurrent;
  const answer = (decision: PayoutDecision, reason: string, extra: Partial<PayoutCalculation> = {}): PayoutCalculation => Object.freeze({ operation, decision,
    signature: "NOT_CHECKED", binding: "NOT_CHECKED", reason, responseCode: null, providerStatus: null, platformSerialNo: null, paidCents: null, providerFeeRaw: null, providerFeeCents: null, ...extra });
  if (operation !== "NOTIFY" && leaseCurrent !== true) return answer("STALE", "STALE_LEASE");
  const decoded = readPayoutResponse(operation, body, r);
  if (!decoded.ok) return answer(decoded.decision, decoded.reason);
  const { values, hmac } = decoded, order = operation === "SYNC" ? JOINPAY_PAYOUT_SIGNATURE_ORDER.submitResponse : operation === "QUERY" ? JOINPAY_PAYOUT_SIGNATURE_ORDER.queryResponse : JOINPAY_PAYOUT_SIGNATURE_ORDER.notification;
  if (!timingSafeEqual(Buffer.from(joinpayMd5Sign(order, values, key)), Buffer.from(hmac.toLowerCase()))) return answer("UNVERIFIED", "SIGNATURE_MISMATCH", { signature: "MISMATCH" });
  const matched = { signature: "MATCH" as const, responseCode: values.statusCode || null, providerStatus: values.status || null };
  if (values.userNo !== b.userNo || values.merchantOrderNo !== b.merchantOrderNo || operation !== "SYNC" && (values.tradeMerchantNo || undefined) !== b.tradeMerchantNo)
    return answer("REVIEW_REQUIRED", "ORIGINAL_REQUEST_MISMATCH", { ...matched, binding: "MISMATCH" });
  const bound = { ...matched, binding: "MATCH" as const };
  if (operation === "SYNC") {
    if (values.statusCode === "2001" && values.errorCode) return answer("REVIEW_REQUIRED", "SUCCESS_WITH_ERROR_CODE", bound);
    return answer(values.statusCode === "2001" ? "APPLICATION_ACCEPTED" : values.statusCode === "2002" ? "APPLICATION_REJECTED" : "QUERY_ORIGINAL_REQUIRED", "SUBMISSION_CODE_ONLY", bound);
  }
  if (operation === "QUERY" && values.statusCode !== "2001") return answer("QUERY_FAILED", "QUERY_RESPONSE_CODE", bound);
  if (values.status === "205" && values.errorCode) return answer("REVIEW_REQUIRED", "SUCCESS_WITH_ERROR_CODE", bound);
  const basis = readPayoutTransactionBasis(operation, values, r);
  if (!basis.ok) return answer(basis.decision, basis.reason, bound);
  const { paidCents, feeRaw, feeCents } = basis;
  if (operation === "QUERY" && values.status === "214") {
    if (values.receiverAccountNoEnc && values.receiverAccountNoEnc !== b.receiverAccountNoEnc || values.receiverNameEnc && values.receiverNameEnc !== b.receiverNameEnc
      || values.paidAmount && paidCents !== b.netCents || values.platformSerialNo && b.platformSerialNo !== undefined && values.platformSerialNo !== b.platformSerialNo)
      return answer("REVIEW_REQUIRED", "NOT_FOUND_WITH_CONFLICTING_BASIS", { ...bound, binding: "MISMATCH" });
    return answer("PROVIDER_REPORTED_NOT_FOUND", "NOT_FOUND_IS_NOT_NO_EXECUTION", { ...bound, platformSerialNo: values.platformSerialNo || null, paidCents, providerFeeRaw: feeRaw, providerFeeCents: feeCents });
  }
  if (values.receiverAccountNoEnc !== b.receiverAccountNoEnc || values.receiverNameEnc !== b.receiverNameEnc || paidCents !== b.netCents
    || b.platformSerialNo !== undefined && values.platformSerialNo !== b.platformSerialNo) return answer("REVIEW_REQUIRED", "TARGET_AMOUNT_OR_TRANSACTION_MISMATCH", { ...bound, binding: "MISMATCH" });
  const result = { ...bound, platformSerialNo: values.platformSerialNo!, paidCents, providerFeeRaw: feeRaw, providerFeeCents: feeCents };
  if (values.status === "205") return answer("CHANNEL_REPORTED_SUCCEEDED", "PAYOUT_SUCCESS_CANDIDATE_ONLY", result);
  if (values.status === "204" || values.status === "208") return answer("CHANNEL_REPORTED_FAILED", "FAILURE_REQUIRES_NO_EXECUTION_PROOF", result);
  if (values.status === "214") return answer("PROVIDER_REPORTED_NOT_FOUND", "NOT_FOUND_IS_NOT_NO_EXECUTION", result);
  if (["201", "202", "203", "210", "211", "212", "213"].includes(values.status!)) return answer("PROCESSING", "NONTERMINAL_PROVIDER_STATUS", result);
  return answer("EVIDENCE_INCOMPLETE", "STATUS_UNKNOWN", result);
}
export function evaluateSyntheticJoinpayPayoutResponse(...args: Parameters<typeof computeJoinpayPayoutResponse>) {
  return Object.freeze({ ...computeJoinpayPayoutResponse(...args), evidenceLevel: "SYNTHETIC_PROTOCOL" as const, officialVerified: false as const, mayAffectFunds: false as const });
}
/** 仅演示ACK形状；通知宿主须在同事务持久化/接纳COMMIT确认后决定回包。 */
export function syntheticJoinpayPayoutAck(applied: boolean) {
  return Object.freeze({ body: applied ? '{"statusCode":"2001"}' : '{"statusCode":"2002","message":"not accepted"}', evidenceLevel: "SYNTHETIC_PROTOCOL" as const, sendable: false as const });
}

/** 只校验/计算协议，不携带正式出站或资金能力。旧合成包装保留原旗标。 */
export function validateJoinpayPayoutSubmitInput(input:JoinpayPayoutSubmitInput,r:PayoutWireRules):void {submitValues(input,r);}
export function computeJoinpayPayoutRequest(input:JoinpayPayoutSubmitInput,key:string,r:PayoutWireRules){r=rules(r);return computeForm("SUBMIT",submitValues(input,r),key,r);}
export function buildSyntheticJoinpayPayoutRequest(input:JoinpayPayoutSubmitInput,key:string,r:PayoutWireRules){return Object.freeze({...computeJoinpayPayoutRequest(input,key,r),evidenceLevel:"SYNTHETIC_PROTOCOL" as const,sendable:false as const,blockers:JOINPAY_PAYOUT_PROFILE.blockers});}
export function buildSyntheticJoinpayPayoutQuery(input:Pick<JoinpayPayoutBinding,"userNo"|"merchantOrderNo">,key:string,r:PayoutWireRules){return Object.freeze({...computeJoinpayPayoutQuery(input,key,r),evidenceLevel:"SYNTHETIC_PROTOCOL" as const,sendable:false as const,blockers:JOINPAY_PAYOUT_PROFILE.blockers});}
