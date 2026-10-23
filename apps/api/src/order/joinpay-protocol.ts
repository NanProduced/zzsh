import { createHash } from "node:crypto";

/**
 * 汇聚 JoinPay 2.6 MD5 离线协议（PAY-02，合同 PAY-01 R3）。
 * 纯解析/校验/签名及中性计算；旧build/evaluate API固定SYNTHETIC_PROTOCOL。
 * 不读配置、钥库、环境变量，不连 DB、网络或服务。
 * 这里的任何结果都不是付款事实，不授予正式接纳或 JOINPAY APPLIED。
 */
export const JOINPAY_PROFILE = Object.freeze({
  profileId: "JOINPAY_AGG_2_6_MD5_DRAFT",
  contract: "PAY-01-R3 contract.md ca9a292d / protocol-profile.json 3e6e4fb2",
  evidenceLevel: "SYNTHETIC_PROTOCOL",
  merchantUse: false,
  productionEnabled: false,
  mayProduceVerifiedPaymentFact: false,
  mayProduceJoinpayApplied: false,
  unconfirmed: Object.freeze({
    officialVector: "NOT_OBTAINED_U-01",
    rsa: "NOT_OBTAINED_U-02",
    timezone: "NOT_OBTAINED_U-03",
    tradeMerchantNo: "NOT_OBTAINED_U-04",
    secondUrlDecode: "NOT_OBTAINED_U-05",
    merchantProducts: "NOT_OBTAINED_U-06",
    jsonNumberRendering: "NOT_OBTAINED_U-07",
    unknownFieldSigning: "NOT_OBTAINED_U-08",
    productNameCharset: "NOT_OBTAINED_U-11",
    qrHostAllowlist: "NOT_OBTAINED",
  }),
});

export class JoinpayProtocolError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** 取得官方向量/字段前（U-01/U-04/U-06），真实商户使用保持关闭。 */
export function assertJoinpayMerchantUsable(): never {
  throw new JoinpayProtocolError("PROFILE_NOT_VERIFIED", "synthetic profile cannot be used for a real merchant");
}

// ---------- 状态与事件（合同 §5.1/§5.2；normativeReadback E4/E5/E6/E6X/E9）----------
export const REQUEST_STATES = ["SUBMITTING", "UNKNOWN", "ACTION_READY", "PROCESSING_UNCONFIRMED", "REJECTED_BY_CHANNEL", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "ACCEPTED", "REVIEW_REQUIRED"] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
export type JoinpayEvent = "E1" | "E1P" | "E2" | "E3" | "E4" | "E5" | "E6" | "E6X" | "E9" | "E11";
const CSPA = "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE";
const isTerminal = (s: RequestState) => s === "ACCEPTED" || s === "REVIEW_REQUIRED";

/** 只返回判定；持久化由调用方负责（本模块从不写库）。 */
export function joinpayTransition(event: JoinpayEvent, state: RequestState): { nextState: RequestState; conflict: boolean } {
  const early = state === "SUBMITTING" || state === "UNKNOWN";
  switch (event) {
    case "E1": return { nextState: early ? "ACTION_READY" : state, conflict: false };
    case "E1P": return { nextState: early ? "PROCESSING_UNCONFIRMED" : state, conflict: false };
    case "E2": return { nextState: early ? "REJECTED_BY_CHANNEL" : state, conflict: isTerminal(state) || state === CSPA };
    case "E3": return { nextState: state === "SUBMITTING" ? "UNKNOWN" : state, conflict: false };
    case "E4": return { nextState: early || state === "ACTION_READY" || state === "PROCESSING_UNCONFIRMED" || state === "REJECTED_BY_CHANNEL" ? CSPA : state, conflict: state === "REJECTED_BY_CHANNEL" };
    case "E5": case "E6": return { nextState: state, conflict: isTerminal(state) || state === CSPA };
    default: return { nextState: state, conflict: false };
  }
}

// ---------- 金额：只用整数分字符串 / BigInt ----------
export const JOINPAY_MAX_OUTBOUND_CENTS = 9999999999999999n;
const WIRE_YUAN = /^(0|[1-9]\d{0,13})\.\d{2}$/;

export function centsToJoinpayYuan(cents: string): string {
  if (typeof cents !== "string" || !/^(0|[1-9]\d{0,24})$/.test(cents)) throw new JoinpayProtocolError("AMOUNT_INVALID");
  const value = BigInt(cents);
  if (value < 1n || value > JOINPAY_MAX_OUTBOUND_CENTS) throw new JoinpayProtocolError("AMOUNT_OUT_OF_PROTOCOL_RANGE");
  const padded = cents.padStart(3, "0");
  return `${padded.slice(0, -2).replace(/^0+(?=\d)/, "")}.${padded.slice(-2)}`;
}

export function joinpayYuanToCents(yuan: string): string {
  if (typeof yuan !== "string" || !WIRE_YUAN.test(yuan)) throw new JoinpayProtocolError("AMOUNT_INVALID");
  return BigInt(yuan.replace(".", "")).toString();
}

// ---------- 各操作 schema（字段顺序即签名顺序）----------
type Bound = { kind: "MAX"; n: number } | { kind: "RE"; re: RegExp } | { kind: "FIXED"; value: string } | { kind: "URL"; max: number } | { kind: "TIME" };
export type JoinpayField = { name: string; required: boolean; empty: "REJECT" | "EQUIV" | "ALLOWED"; bound: Bound };
type Field = JoinpayField;
const ORDER_NO = /^[A-Za-z0-9_]{1,50}$/;
const TRX_NO = /^[A-Za-z0-9_-]{1,64}$/;
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const m = (n: number): Bound => ({ kind: "MAX", n });
const re = (r: RegExp): Bound => ({ kind: "RE", re: r });
const V: Bound = { kind: "FIXED", value: "2.6" };
const Y = re(WIRE_YUAN);
const T: Bound = { kind: "TIME" };
const R = (name: string, bound: Bound): Field => ({ name, required: true, empty: "REJECT", bound });
const RA = (name: string, bound: Bound): Field => ({ name, required: true, empty: "ALLOWED", bound });
const O = (name: string, bound: Bound): Field => ({ name, required: false, empty: "EQUIV", bound });
const OA = (name: string, bound: Bound): Field => ({ name, required: false, empty: "ALLOWED", bound });

const UNIPAY_REQUEST: readonly Field[] = [R("p0_Version", V), R("p1_MerchantNo", m(15)), R("p2_OrderNo", re(ORDER_NO)), R("p3_Amount", Y), R("p4_Cur", m(10)), R("p5_ProductName", m(30)), O("p6_ProductDesc", m(300)), O("p7_Mp", m(100)), O("p8_ReturnUrl", m(3000)), R("p9_NotifyUrl", m(300)), R("q1_FrpCode", m(50)), O("q2_MerchantBankCode", m(20)), O("q4_IsShowPic", m(1)), O("q5_OpenId", m(100)), O("q6_AuthCode", m(80)), O("q7_AppId", m(50)), O("q8_TerminalNo", m(50)), O("q9_TransactionModel", m(10)), R("qa_TradeMerchantNo", m(50)), O("qb_buyerId", m(20)), O("qh_HbFqNum", m(5)), O("qi_FqSellerPercen", m(3)), O("qj_DJPlan", m(500)), O("qk_DisablePayModel", m(100)), O("ql_TerminalIp", m(64)), O("qm_ContractId", m(50)), O("qn_SpecialInfo", m(50))];
const SYNC_RESPONSE: readonly Field[] = [R("r0_Version", V), R("r1_MerchantNo", m(15)), R("r2_OrderNo", re(ORDER_NO)), R("r3_Amount", Y), R("r4_Cur", m(10)), OA("r5_Mp", m(100)), R("r6_FrpCode", m(50)), R("r7_TrxNo", re(TRX_NO)), OA("r8_MerchantBankCode", m(20)), O("r9_SubMerchantNo", m(20)), R("ra_Code", m(10)), RA("rb_CodeMsg", m(256)), R("rc_Result", { kind: "URL", max: 2048 }), O("rd_Pic", m(2048))];
const NOTIFY: readonly Field[] = [R("r0_Version", V), R("r1_MerchantNo", m(15)), R("r2_OrderNo", re(ORDER_NO)), R("r3_Amount", Y), R("r4_Cur", m(10)), OA("r5_Mp", m(200)), R("r6_Status", m(10)), R("r7_TrxNo", re(TRX_NO)), O("r8_BankOrderNo", m(20)), O("r9_BankTrxNo", m(30)), R("ra_PayTime", T), R("rb_DealTime", T), R("rc_BankCode", m(10)), O("rd_OpenId", m(128)), R("re_DiscountAmount", Y), O("rh_cardType", m(2)), O("rj_Fee", Y), R("rk_FrpCode", m(50)), O("rl_ContractId", m(32)), O("rm_SpecialInfo", m(256)), R("ro_SettleAmount", Y)];
const QUERY_REQUEST: readonly Field[] = [R("p0_Version", V), R("p1_MerchantNo", m(15)), R("p2_OrderNo", re(ORDER_NO))];
const QUERY_RESPONSE: readonly Field[] = [R("r0_Version", V), R("r1_MerchantNo", m(15)), R("r2_OrderNo", re(ORDER_NO)), O("r3_Amount", Y), O("r4_ProductName", m(10)), O("r5_TrxNo", re(TRX_NO)), O("r6_BankTrxNo", m(30)), R("r7_Fee", Y), O("r8_FrpCode", m(50)), O("ra_Status", m(20)), R("rb_Code", m(20)), RA("rc_CodeMsg", m(256)), R("rd_OpenId", m(10)), R("re_DiscountAmount", m(10)), R("rf_PayTime", T), O("rh_cardType", m(2)), R("rj_BankCode", m(10)), O("rl_ContractId", m(32)), O("rm_SpecialInfo", m(256)), R("ro_SettleAmount", Y)];

/** 各操作签名顺序（合同 §1；不含 hmac）。 */
export const JOINPAY_SIGNATURE_ORDER = Object.freeze({
  uniPayRequest: UNIPAY_REQUEST.map((f) => f.name),
  uniPaySyncResponse: SYNC_RESPONSE.map((f) => f.name),
  asyncNotify: NOTIFY.map((f) => f.name),
  queryOrderRequest: QUERY_REQUEST.map((f) => f.name),
  queryOrderResponse: QUERY_RESPONSE.map((f) => f.name),
});

// ---------- 签名（MD5，S56）----------
/** md5Hex(按签名顺序拼接非空值 + 钥)，小写；U-01 取得前仅为合成。不可无损编码为 UTF-8 的值/钥直接拒绝（R1-02）。 */
export function joinpayMd5Sign(order: readonly string[], values: Readonly<Record<string, string | undefined>>, key: string): string {
  if (typeof key !== "string" || key.length === 0) throw new JoinpayProtocolError("KEY_REQUIRED");
  const parts = order.map((n) => {
    const value = values[n];
    if (value !== undefined && typeof value !== "string") throw new JoinpayProtocolError("SIGNATURE_VALUE_NOT_STRING");
    return value ?? "";
  });
  // 逐字段检查，避免相邻孤立代理在拼接后互相补成合法字符。
  if (!parts.every(wellFormed) || !wellFormed(key)) throw new JoinpayProtocolError("PROTOCOL_NOT_WELL_FORMED_UTF16");
  return createHash("md5").update(parts.join("") + key, "utf8").digest("hex");
}

// ---------- 解码 ----------
type RawValue = { value: string | null; numberToken: boolean };
type Decoded = { ok: true; raw: Map<string, RawValue> } | { ok: false; reason: string };
// R1-01：ignoreBOM 保留字段内 U+FEFF，不当作字节流头删除；随后由空白/字段名规则拒绝。
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// R1-02：含孤立代理（高或低）的字符串无法无损编码为 UTF-8，统一拒绝，避免静默替换为 U+FFFD。
const LONE_SURROGATE = /\p{Cs}/u;
const wellFormed = (s: string) => !LONE_SURROGATE.test(s);
const codePoints = (s: string) => [...s].length;

function utf8(bytes: Uint8Array): string | null {
  try { return UTF8.decode(bytes); } catch { return null; }
}

/** 表单值只解码一次（'+' 为空格、%XX），不做第二次解码（U-05）。 */
function formDecodeOnce(s: string): string | null {
  // R1-03：按片段收集 Buffer 再 concat，不对不可信长度做参数展开，长度校验前不会抛 RangeError。
  const parts: Buffer[] = [];
  for (const tok of s.match(/%[0-9A-Fa-f]{2}|%|[^%]+/g) ?? []) {
    if (tok === "%") return null;
    parts.push(tok.startsWith("%") ? Buffer.of(parseInt(tok.slice(1), 16)) : Buffer.from(tok.replace(/\+/g, " "), "utf8"));
  }
  return utf8(Buffer.concat(parts));
}

/** GET 通知原始查询串（不含 '?'）。重复参数、畸形转义、非法 UTF-8、孤立代理均拒绝。 */
export function decodeJoinpayQuery(rawQuery: string): Decoded {
  if (typeof rawQuery !== "string" || rawQuery.length === 0 || !wellFormed(rawQuery)) return { ok: false, reason: "PROTOCOL_DECODE_REJECTED" };
  const raw = new Map<string, RawValue>();
  for (const part of rawQuery.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return { ok: false, reason: "PROTOCOL_DECODE_REJECTED" };
    const k = formDecodeOnce(part.slice(0, eq));
    const v = formDecodeOnce(part.slice(eq + 1));
    if (k === null || v === null) return { ok: false, reason: "PROTOCOL_DECODE_REJECTED" };
    if (raw.has(k)) return { ok: false, reason: "PROTOCOL_DUPLICATE_PARAM" };
    raw.set(k, { value: v, numberToken: false });
  }
  return { ok: true, raw };
}

/** 仅平面 JSON 对象；保留原始数字 token，重复键拒绝；键/值须可无损编码为 UTF-8（R1-02，本包安全拒绝策略，不声称是 JSON 语法错误）。shortcut: 嵌套值直接拒绝，协议确有嵌套时再升级。 */
export function decodeJoinpayJson(body: string | Uint8Array): Decoded {
  const text = typeof body === "string" ? body : utf8(body);
  if (text === null || !wellFormed(text)) return { ok: false, reason: "PROTOCOL_DECODE_REJECTED" };
  const raw = new Map<string, RawValue>();
  const STR = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const WS = /[ \t\n\r]*/y;
  let i = 0;
  const ws = () => { WS.lastIndex = i; WS.exec(text); i = WS.lastIndex; };
  const take = (r: RegExp) => { r.lastIndex = i; const hit = r.exec(text); if (!hit) return null; i = r.lastIndex; return hit[0]; };
  const fail = { ok: false as const, reason: "PROTOCOL_DECODE_REJECTED" };
  ws();
  if (text[i++] !== "{") return fail;
  ws();
  if (text[i] === "}") { i++; } else {
    for (;;) {
      ws();
      const keyTok = take(STR);
      if (keyTok === null) return fail;
      const key = JSON.parse(keyTok) as string;
      if (!wellFormed(key)) return fail;
      ws();
      if (text[i++] !== ":") return fail;
      ws();
      let value: RawValue;
      const s = take(STR);
      if (s !== null) { const str = JSON.parse(s) as string; if (!wellFormed(str)) return fail; value = { value: str, numberToken: false }; }
      else if (text.startsWith("null", i)) { i += 4; value = { value: null, numberToken: false }; }
      else { const n = take(NUM); if (n === null) return fail; value = { value: n, numberToken: true }; }
      if (raw.has(key)) return { ok: false, reason: "PROTOCOL_DUPLICATE_KEY" };
      raw.set(key, value);
      ws();
      const c = text[i++];
      if (c === "}") break;
      if (c !== ",") return fail;
    }
  }
  ws();
  return i === text.length ? { ok: true, raw } : fail;
}

// ---------- schema（validationOrder 第 2–4 步，再查 hmac 与未知字段）----------
type Schema = { ok: true; values: Record<string, string | undefined>; hmac: string; numberTokens: string[] } | { ok: false; reason: string; field?: string };

function boundOk(b: Bound, v: string): string | null {
  switch (b.kind) {
    case "MAX": return codePoints(v) <= b.n ? null : "PROTOCOL_FIELD_TOO_LONG";
    case "RE": return b.re.test(v) ? null : "PROTOCOL_FIELD_PATTERN";
    case "FIXED": return v === b.value ? null : "PROTOCOL_FIELD_PATTERN";
    case "URL": return v.startsWith("https://") && codePoints(v) <= b.max && URL.canParse(v) ? null : "ACTION_REJECTED_LOCAL";
    case "TIME": {
      if (codePoints(v) > 64) return "PROTOCOL_FIELD_TOO_LONG";
      if (!TIME.test(v)) return "PROTOCOL_FIELD_PATTERN";
      // UTC 只用于校验日历往返，不推定渠道时区或输出正式时间。
      const t = Date.parse(v.replace(" ", "T") + "Z");
      return Number.isFinite(t) && new Date(t).toISOString().slice(0, 19).replace("T", " ") === v ? null : "PROTOCOL_FIELD_PATTERN";
    }
  }
}

export function validateJoinpaySignedFields(fields: readonly JoinpayField[], raw: Map<string, RawValue>): Schema {
  for (const [k, r] of raw) if (r.value !== null && r.value !== r.value.trim()) return { ok: false, reason: "PROTOCOL_DECODE_REJECTED", field: k };
  for (const f of fields) if (f.required && !raw.has(f.name)) return { ok: false, reason: "PROTOCOL_FIELD_MISSING", field: f.name };
  if (!raw.has("hmac")) return { ok: false, reason: "PROTOCOL_FIELD_MISSING", field: "hmac" };
  const values: Record<string, string | undefined> = {};
  for (const f of fields) {
    const r = raw.get(f.name);
    const empty = r === undefined || r.value === null || r.value === "";
    if (empty && r !== undefined && f.empty === "REJECT") return { ok: false, reason: "PROTOCOL_REQUIRED_EMPTY", field: f.name };
    values[f.name] = empty ? undefined : (r.value as string);
  }
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined) continue;
    const bad = boundOk(f.bound, v);
    if (bad) return { ok: false, reason: bad, field: f.name };
  }
  const hmac = raw.get("hmac")?.value ?? "";
  if (!/^[0-9a-fA-F]{32}$/.test(hmac)) return { ok: false, reason: hmac === "" ? "PROTOCOL_REQUIRED_EMPTY" : "PROTOCOL_FIELD_PATTERN", field: "hmac" };
  const known = new Set(fields.map((f) => f.name).concat("hmac"));
  for (const [k, r] of raw) if (!known.has(k) && r.value !== null && r.value !== "") return { ok: false, reason: "UNKNOWN_FIELD_REVIEW", field: k };
  const numberTokens = [...raw].filter(([, r]) => r.numberToken).map(([k]) => k);
  return { ok: true, values, hmac, numberTokens };
}

function checkSchema(fields: readonly Field[], raw: Map<string, RawValue>): Schema {
  const result = validateJoinpaySignedFields(fields, raw);
  return result.ok && result.values.r5_Mp !== undefined ? { ok: false, reason: "MP_REVIEW", field: "r5_Mp" } : result;
}

// ---------- 判定结果 ----------
export type JoinpayOutcome = {
  operation: "uniPaySyncResponse" | "asyncNotify" | "queryOrder";
  result: string;
  reason?: string;
  field?: string;
  rawStatus?: string;
  event: JoinpayEvent;
  fromState: RequestState | "NONE";
  nextState: RequestState | "NONE";
  conflict: boolean;
  observation: "UNVERIFIED" | "STALE" | "SYNTHETIC_SIGNED";
  values?: Readonly<Record<string, string | undefined>>;
  numberTokens?: readonly string[];
  paymentParam?: { url: string; usableNow: false; reason: "QR_HOST_ALLOWLIST_NOT_OBTAINED" };
  providerPaidAtRaw?: string;
  ack?: "success" | "fail";
  evidenceLevel: "SYNTHETIC_PROTOCOL";
  signature: "SYNTHETIC_SELF_CONSISTENT" | "NOT_CHECKED" | "MISMATCH";
  officialVerified: false;
  formalAcceptance: false;
  blockers: readonly string[];
};

const BLOCKERS = {
  uniPaySyncResponse: ["U-01", "U-07"],
  asyncNotify: ["U-01", "U-03", "U-05"],
  queryOrder: ["U-01", "U-03", "U-07"],
} as const;

function outcome(op: JoinpayOutcome["operation"], event: JoinpayEvent, state: RequestState | "NONE", part: Partial<JoinpayOutcome> & { result: string }): JoinpayOutcome {
  const t = state === "NONE" ? { nextState: "NONE" as const, conflict: false } : joinpayTransition(event, state);
  const trusted = event === "E1" || event === "E1P" || event === "E2" || event === "E4" || event === "E5" || event === "E6";
  return {
    operation: op, event, fromState: state, nextState: t.nextState, conflict: t.conflict,
    observation: event === "E9" ? "STALE" : trusted ? "SYNTHETIC_SIGNED" : "UNVERIFIED",
    signature: trusted ? "SYNTHETIC_SELF_CONSISTENT" : "NOT_CHECKED",
    ...part,
    evidenceLevel: "SYNTHETIC_PROTOCOL", officialVerified: false, formalAcceptance: false, blockers: BLOCKERS[op],
  };
}

export type JoinpayPersistedRequest = { state: RequestState; merchantNo: string; orderNo: string; amountCents: string; frpCode: string };
export type JoinpayInboundContext = { key: string; request: JoinpayPersistedRequest; leaseCurrent: boolean };

export type JoinpayTransportFailure = "TIMEOUT" | "NETWORK_ERROR" | "HTTP_STATUS" | "BODY_TOO_LARGE";

/** 没有可用响应时只记录未知；不伪造响应、验签或渠道失败。 */
export function evaluateJoinpayTransportFailure(operation: "SYNC_RESPONSE" | "QUERY_RESPONSE", state: RequestState,
  leaseCurrent: boolean, reason: JoinpayTransportFailure): JoinpayOutcome {
  if ((operation !== "SYNC_RESPONSE" && operation !== "QUERY_RESPONSE")
    || !["TIMEOUT", "NETWORK_ERROR", "HTTP_STATUS", "BODY_TOO_LARGE"].includes(reason)) {
    throw new JoinpayProtocolError("PROTOCOL_TRANSPORT_FAILURE_INVALID");
  }
  const op = operation === "SYNC_RESPONSE" ? "uniPaySyncResponse" : "queryOrder";
  if (!leaseCurrent) return outcome(op, "E9", state, { result: "STALE_LEASE" });
  return outcome(op, operation === "SYNC_RESPONSE" ? "E3" : "E6X", state, { result: "TRANSPORT_UNKNOWN", reason });
}

function verify(fields: readonly Field[], s: Extract<Schema, { ok: true }>, key: string): boolean {
  return joinpayMd5Sign(fields.map((f) => f.name), s.values, key) === s.hmac.toLowerCase();
}

const SYNC_UNKNOWN_CODES = new Set(["0", "4", "10080000", "10080002"]);
// 合同 §1.2 显式列出的拒绝码；其余为本 profile 未映射 → E3（完整清单未核）。
const SYNC_REJECT_CODES = new Set(["10080003", "10080004", "10080005", "10080007", "10080013", "10080014", "10080017", "10080018", "10080042", "10080059", "10080064"]);

/** 中性协议计算不授予商户准入、官方验签或任何资金状态。旧合成包装与正式服务端profile共用。 */
export type JoinpayCollectionDecision = {
  schema: "VALID" | "INVALID"; signature: "MATCH" | "MISMATCH" | "NOT_CHECKED"; binding: "MATCH" | "MISMATCH" | "NOT_CHECKED";
  event: JoinpayEvent; result: string; reason?: string; field?: string; rawStatus?: string;
  values?: Readonly<Record<string, string | undefined>>; numberTokens?: readonly string[]; providerPaidAtRaw?: string; paymentParamUrl?: string;
};
export function computeJoinpayCollectionDecision(operation: "SUBMIT" | "QUERY", body: string | Uint8Array,
  request: JoinpayPersistedRequest, key: string): JoinpayCollectionDecision {
  if (operation !== "SUBMIT" && operation !== "QUERY") throw new JoinpayProtocolError("PROTOCOL_OPERATION_INVALID");
  const sync = operation === "SUBMIT", unknown = sync ? "E3" as const : "E6X" as const;
  const base = { schema: "INVALID" as const, signature: "NOT_CHECKED" as const, binding: "NOT_CHECKED" as const, event: unknown };
  const decoded = decodeJoinpayJson(body);
  if (!decoded.ok) return { ...base, result: sync ? "SYNC_SCHEMA_REJECTED" : "QUERY_SCHEMA_REJECTED", reason: decoded.reason };
  const fields = sync ? SYNC_RESPONSE : QUERY_RESPONSE, checked = checkSchema(fields, decoded.raw);
  if (!checked.ok) return { ...base, result: sync ? "SYNC_SCHEMA_REJECTED" : "QUERY_SCHEMA_REJECTED", reason: checked.reason, field: checked.field };
  if (!verify(fields, checked, key)) return { ...base, schema: "VALID", signature: "MISMATCH", result: "SIGNATURE_INVALID" };
  const signed = { ...base, schema: "VALID" as const, signature: "MATCH" as const };
  const v = checked.values, common = { values: v, numberTokens: checked.numberTokens };
  if (sync) {
    if (v.r1_MerchantNo !== request.merchantNo || v.r2_OrderNo !== request.orderNo || v.r3_Amount !== centsToJoinpayYuan(request.amountCents)
      || v.r4_Cur !== "1" || v.r6_FrpCode !== request.frpCode) return { ...signed, binding: "MISMATCH", result: "BINDING_MISMATCH" };
    const bound = { ...signed, binding: "MATCH" as const }, code = v.ra_Code as string;
    if (code === "100") return { ...bound, ...common, event: "E1", result: "ACTION_READY", paymentParamUrl: v.rc_Result };
    if (code === "102" || code === "10083001") return { ...bound, ...common, event: "E1P", result: "PROCESSING_UNCONFIRMED" };
    if (SYNC_REJECT_CODES.has(code)) return { ...bound, ...common, event: "E2", result: "REJECTED_BY_CHANNEL", rawStatus: code };
    return { ...bound, ...common, result: SYNC_UNKNOWN_CODES.has(code) ? "SYNC_UNKNOWN" : "SYNC_UNMAPPED_CODE", rawStatus: code };
  }
  if (v.rb_Code !== "100") return { ...signed, ...common, result: "QUERY_FAILED", rawStatus: v.rb_Code };
  const status = v.ra_Status;
  if (status === undefined) return { ...signed, ...common, result: "QUERY_EVIDENCE_INCOMPLETE", reason: "STATUS_MISSING" };
  if (!["100", "101", "102"].includes(status)) return { ...signed, ...common, result: "QUERY_EVIDENCE_INCOMPLETE", reason: "STATUS_UNKNOWN", rawStatus: status };
  if (v.r1_MerchantNo !== request.merchantNo || v.r2_OrderNo !== request.orderNo) return { ...signed, ...common, binding: "MISMATCH", result: "BINDING_MISMATCH" };
  const bound = { ...signed, binding: "MATCH" as const };
  if (status === "101") return { ...bound, ...common, event: "E5", result: "CHANNEL_REPORTED_FAILED" };
  if (status === "102") return { ...bound, ...common, event: "E6", result: "CHANNEL_CREATED_UNPAID" };
  const missing = ["r3_Amount", "r5_TrxNo", "r8_FrpCode"].find(name => v[name] === undefined);
  if (missing) return { ...signed, ...common, result: "QUERY_EVIDENCE_INCOMPLETE", reason: "SUCCESS_FIELD_MISSING", field: missing };
  if (v.r3_Amount !== centsToJoinpayYuan(request.amountCents) || v.r8_FrpCode !== request.frpCode) return { ...signed, ...common, binding: "MISMATCH", result: "BINDING_MISMATCH" };
  return { ...bound, ...common, event: "E4", result: "QUERY_SUCCEEDED", providerPaidAtRaw: v.rf_PayTime };
}
function syntheticCollectionOutcome(operation: "SUBMIT" | "QUERY", body: string | Uint8Array, ctx: JoinpayInboundContext): JoinpayOutcome {
  const op = operation === "SUBMIT" ? "uniPaySyncResponse" : "queryOrder";
  if (!ctx.leaseCurrent) return outcome(op, "E9", ctx.request.state, { result: "STALE_LEASE" });
  const { schema: _schema, binding: _binding, signature, event, paymentParamUrl, ...part } = computeJoinpayCollectionDecision(operation, body, ctx.request, ctx.key);
  return outcome(op, event, ctx.request.state, { ...part, signature: signature === "MATCH" ? operation === "QUERY" && event === "E6X" ? "NOT_CHECKED" : "SYNTHETIC_SELF_CONSISTENT" : signature,
    ...(paymentParamUrl === undefined ? {} : { paymentParam: { url: paymentParamUrl, usableNow: false as const, reason: "QR_HOST_ALLOWLIST_NOT_OBTAINED" as const } }) });
}
/** uniPay 同步 JSON 响应。100 仅表示参数受理，绝不是付款。 */
export function evaluateJoinpaySyncResponse(body: string | Uint8Array, ctx: JoinpayInboundContext): JoinpayOutcome {
  return syntheticCollectionOutcome("SUBMIT", body, ctx);
}

/** GET 异步通知。request 为 null 即绑定不到（E11）。ack 只能在持久化成功后发送。 */
export function evaluateJoinpayNotify(rawQuery: string, ctx: { key: string; request: JoinpayPersistedRequest | null }): JoinpayOutcome {
  const op = "asyncNotify";
  const st = ctx.request?.state ?? "NONE";
  const reject = (result: string, extra: Partial<JoinpayOutcome> = {}) => outcome(op, "E11", st, { result, ack: "fail", ...extra });
  const d = decodeJoinpayQuery(rawQuery);
  if (!d.ok) return reject("NOTIFY_SCHEMA_REJECTED", { reason: d.reason });
  const s = checkSchema(NOTIFY, d.raw);
  if (!s.ok) return reject("NOTIFY_SCHEMA_REJECTED", { reason: s.reason, field: s.field });
  const r = ctx.request;
  if (!r) return reject("BINDING_NOT_FOUND");
  if (!verify(NOTIFY, s, ctx.key)) return reject("SIGNATURE_INVALID", { signature: "MISMATCH" });
  const v = s.values;
  if (v.r1_MerchantNo !== r.merchantNo || v.r2_OrderNo !== r.orderNo || v.r3_Amount !== centsToJoinpayYuan(r.amountCents) || v.r4_Cur !== "1" || v.rk_FrpCode !== r.frpCode)
    return reject("BINDING_MISMATCH");
  if (v.re_DiscountAmount !== "0.00") return reject("DISCOUNT_REVIEW_U-12");
  const common = { values: v, providerPaidAtRaw: v.ra_PayTime, ack: "success" as const };
  if (v.r6_Status === "100") return outcome(op, "E4", st, { ...common, result: "CHANNEL_SIGNED_SYNTHETIC" });
  if (v.r6_Status === "101") return outcome(op, "E5", st, { ...common, result: "CHANNEL_REPORTED_FAILED" });
  return reject("NOTIFY_STATUS_UNKNOWN", { rawStatus: v.r6_Status });
}

/** queryOrder 的旧合成API保持固定证据标签及租约优先级。 */
export function evaluateJoinpayQueryResponse(body: string | Uint8Array, ctx: JoinpayInboundContext): JoinpayOutcome {
  return syntheticCollectionOutcome("QUERY", body, ctx);
}

// ---------- 出站请求（只构造；本模块从不发送）----------
export type JoinpaySignedForm = { fields: ReadonlyArray<readonly [string, string]>; hmac: string; evidenceLevel: "SYNTHETIC_PROTOCOL"; sendable: false; blockers: readonly string[] };

export type JoinpayComputedForm = { fields: ReadonlyArray<readonly [string, string]>; hmac: string };
function validateFormValues(fields: readonly Field[], values: Record<string, string | undefined>): void {
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined || v === "") { if (f.required) throw new JoinpayProtocolError("PROTOCOL_FIELD_MISSING", f.name); continue; }
    if (typeof v !== "string" || v !== v.trim()) throw new JoinpayProtocolError("PROTOCOL_FIELD_PATTERN", f.name);
    const bad = boundOk(f.bound, v);
    if (bad) throw new JoinpayProtocolError(bad, f.name);
    if (!wellFormed(v)) throw new JoinpayProtocolError("PROTOCOL_NOT_WELL_FORMED_UTF16");
  }
}
function computeForm(fields: readonly Field[], values: Record<string, string | undefined>, key: string): JoinpayComputedForm {
  validateFormValues(fields, values);
  const hmac = joinpayMd5Sign(fields.map((f) => f.name), values, key);
  const out = fields.filter((f) => values[f.name]).map((f) => [f.name, values[f.name] as string] as const);
  return { fields: [...out, ["hmac", hmac] as const], hmac };
}

export type JoinpayUniPayInput = { merchantNo: string; orderNo: string; amountCents: string; currency: "CNY"; productName: string; notifyUrl: string; frpCode: "ALIPAY_NATIVE" | "WEIXIN_NATIVE"; tradeMerchantNo: string };

function uniPayValues(input: JoinpayUniPayInput): Record<string, string> {
  if (input.currency !== "CNY") throw new JoinpayProtocolError("CURRENCY_NOT_SUPPORTED");
  if (input.frpCode !== "ALIPAY_NATIVE" && input.frpCode !== "WEIXIN_NATIVE") throw new JoinpayProtocolError("FRP_CODE_NOT_ALLOWED");
  return { p0_Version: "2.6", p1_MerchantNo: input.merchantNo, p2_OrderNo: input.orderNo, p3_Amount: centsToJoinpayYuan(input.amountCents), p4_Cur: "1",
    p5_ProductName: input.productName, p9_NotifyUrl: input.notifyUrl, q1_FrpCode: input.frpCode, qa_TradeMerchantNo: input.tradeMerchantNo };
}
const queryValues = (input: { merchantNo: string; orderNo: string }) => ({ p0_Version: "2.6", p1_MerchantNo: input.merchantNo, p2_OrderNo: input.orderNo });
/** 与签名构造共用同一字段规则，不需要钥且不生成任何发送能力。 */
export function validateJoinpayUniPayInput(input: JoinpayUniPayInput): void { validateFormValues(UNIPAY_REQUEST, uniPayValues(input)); }
export function validateJoinpayQueryInput(input: { merchantNo: string; orderNo: string }): void { validateFormValues(QUERY_REQUEST, queryValues(input)); }
/** 首期 native uniPay 表单；可选字段一律不送（合同 §1.1）。 */
export function computeJoinpayUniPayRequest(input: JoinpayUniPayInput, key: string): JoinpayComputedForm { return computeForm(UNIPAY_REQUEST, uniPayValues(input), key); }
export function computeJoinpayQueryRequest(input: { merchantNo: string; orderNo: string }, key: string): JoinpayComputedForm { return computeForm(QUERY_REQUEST, queryValues(input), key); }
export function buildJoinpayUniPayRequest(input: JoinpayUniPayInput, key: string): JoinpaySignedForm {
  return { ...computeJoinpayUniPayRequest(input, key), evidenceLevel: "SYNTHETIC_PROTOCOL", sendable: false, blockers: ["U-01", "U-04", "U-06", "U-11"] };
}
export function buildJoinpayQueryRequest(input: { merchantNo: string; orderNo: string }, key: string): JoinpaySignedForm {
  return { ...computeJoinpayQueryRequest(input, key), evidenceLevel: "SYNTHETIC_PROTOCOL", sendable: false, blockers: ["U-01", "U-06", "U-14"] };
}
