import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { decodeJoinpayJson, joinpayMd5Sign } from "../order/joinpay-protocol";

export type JoinpayAccountOperation = "AVAILABLE" | "COLLECTION";
export const JOINPAY_ACCOUNT_LIMITS = Object.freeze({ timeoutMs: 8000, maxBytes: 65536 });
const ENDPOINTS = Object.freeze({ AVAILABLE: "https://www.joinpay.com/payment/pay/accountBalanceQuery", COLLECTION: "https://www.joinpay.com/payment/pay/advanceAccountBalanceResultQuery" });
const AMOUNTS = Object.freeze({ AVAILABLE: ["useAbleSettAmount", "availableSettAmountFrozen"], COLLECTION: ["useAbleAdvanceAmount", "currentAdvanceAmount", "usedAdvanceAmount", "advanceFrozenAmount"] });
export const JOINPAY_ACCOUNT_SIGNATURE_ORDER = Object.freeze({
  AVAILABLE: Object.freeze(["statusCode", "message", "userNo", "userName", "currency", ...AMOUNTS.AVAILABLE, "errorCode", "errorDesc"]),
  COLLECTION: Object.freeze(["statusCode", "message", "userNo", "userName", "currency", ...AMOUNTS.COLLECTION, "errorCode", "errorDesc"]),
});
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
export class JoinpayAccountError extends Error { constructor(readonly code: string) { super(code); } }
function reject(code = "ACCOUNT_PROFILE_INVALID"): never { throw new JoinpayAccountError(code); }
function operation(v: unknown): asserts v is JoinpayAccountOperation { if (v !== "AVAILABLE" && v !== "COLLECTION") reject(); }

export type AccountAmountRules = Readonly<{ unit: "UNKNOWN" } | { unit: "CNY_YUAN"; maximumScale: 0 | 1 | 2; allowNegative: boolean; maximumAbsoluteCents: string }>;
export type AccountRules = Readonly<{
  dataEncoding: "OBJECT" | "JSON_STRING"; statusCodeToken: "STRING" | "NUMBER"; amountToken: "STRING" | "NUMBER";
  currencyToken: "NUMBER"; numericSigning: "RAW_JSON_TOKEN"; optionalSigning: "ABSENT_EMPTY_NULL_EQUIVALENT";
  unknownFields: "REJECT"; amount: AccountAmountRules;
}>;
export type JoinpayAccountServerProfile = Readonly<{
  purpose: "MERCHANT_READ" | "SYNTHETIC_PROTOCOL";
  resourceDatabase: string; resourceRuntimeUser: string;
  operation: JoinpayAccountOperation; profileId: string; merchantIdentityId: string; userNo: string; keyVersionRef: string;
  reviewRef: string; reviewSha256: string; permission: "REVIEWED_MERCHANT_BALANCE_READ"; rules: AccountRules;
  knownAnswer: "NOT_OBTAINED" | { reference: string; sha256: string; vectorKey: string; requestHmac: string; responseBody: string };
}>;
export type BoundJoinpayAccountProfile = Readonly<{ kind: "BOUND_JOINPAY_ACCOUNT_PROFILE" }>;
type Profile = JoinpayAccountServerProfile & { profileSha256: string; rulesSha256: string };
const profiles = new WeakMap<object, Profile>();

// 仅服务端装配者承诺依据真实性与商户开通；本函数验证结构和计算，不能认证文档来源。
function snapshot(v: unknown): unknown {
  if (typeof v === "string") { if (/\p{Cs}/u.test(v)) reject(); return v; }
  if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) reject();
  const out: Record<string, unknown> = {};
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
    if (!("value" in d) || !d.enumerable || name === "__proto__") reject();
    out[name] = snapshot(d.value);
  }
  return Object.freeze(out);
}
function getProfile(p: BoundJoinpayAccountProfile): Profile { const v = profiles.get(p); return v ?? reject("ACCOUNT_PROFILE_NOT_BOUND"); }
export function describeJoinpayAccountProfile(p: BoundJoinpayAccountProfile) {
  const v = getProfile(p);
  return Object.freeze({ operation: v.operation, merchantIdentityId: v.merchantIdentityId, profileId: v.profileId, profileSha256: v.profileSha256,
    rulesSha256: v.rulesSha256, keyVersionRef: v.keyVersionRef, reviewRef: v.reviewRef, reviewSha256: v.reviewSha256,
    resourceDatabase: v.resourceDatabase, resourceRuntimeUser: v.resourceRuntimeUser });
}
export function bindJoinpayAccountProfile(input: JoinpayAccountServerProfile): BoundJoinpayAccountProfile {
  const p = snapshot(input) as JoinpayAccountServerProfile;
  operation(p.operation);
  if (p.purpose !== "MERCHANT_READ" && p.purpose !== "SYNTHETIC_PROTOCOL") reject();
  for (const name of [p.resourceDatabase, p.resourceRuntimeUser]) if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(name)) reject();
  for (const id of [p.profileId, p.merchantIdentityId, p.keyVersionRef]) if (typeof id !== "string" || !ID.test(id)) reject();
  if (typeof p.userNo !== "string" || !/^[0-9]{1,32}$/.test(p.userNo) || p.userNo === "888100000002340") reject("ACCOUNT_MERCHANT_NOT_AUTHORIZED");
  if (p.permission !== "REVIEWED_MERCHANT_BALANCE_READ" || typeof p.reviewRef !== "string" || !p.reviewRef.trim() || p.reviewRef.length > 512 || !SHA.test(p.reviewSha256)) reject();
  const r = p.rules, k = p.knownAnswer;
  if (!r || !["OBJECT", "JSON_STRING"].includes(r.dataEncoding) || !["STRING", "NUMBER"].includes(r.statusCodeToken) || !["STRING", "NUMBER"].includes(r.amountToken)
    || r.currencyToken !== "NUMBER" || r.numericSigning !== "RAW_JSON_TOKEN" || r.optionalSigning !== "ABSENT_EMPTY_NULL_EQUIVALENT" || r.unknownFields !== "REJECT") reject();
  if (!r.amount || (r.amount.unit !== "UNKNOWN" && r.amount.unit !== "CNY_YUAN")) reject();
  if (r.amount.unit === "CNY_YUAN" && (![0, 1, 2].includes(r.amount.maximumScale) || typeof r.amount.allowNegative !== "boolean"
    || typeof r.amount.maximumAbsoluteCents !== "string" || !/^(0|[1-9][0-9]{0,39})$/.test(r.amount.maximumAbsoluteCents))) reject();
  if (k !== "NOT_OBTAINED") {
    if (!k || typeof k.reference !== "string" || !k.reference.trim() || k.reference.length > 512 || typeof k.vectorKey !== "string" || !k.vectorKey
      || typeof k.responseBody !== "string" || Buffer.byteLength(k.responseBody) > JOINPAY_ACCOUNT_LIMITS.maxBytes || !SHA.test(k.sha256) || sha(k.responseBody) !== k.sha256
      || typeof k.requestHmac !== "string" || !/^[a-fA-F0-9]{32}$/.test(k.requestHmac)) reject("ACCOUNT_KAT_REQUIRED");
    if (joinpayMd5Sign(["userNo"], { userNo: p.userNo }, k.vectorKey) !== k.requestHmac.toLowerCase()) reject("ACCOUNT_KAT_MISMATCH");
    const kat = inspect(p, Buffer.from(k.responseBody), k.vectorKey);
    if (kat.decision !== "SUCCESS") reject("ACCOUNT_KAT_MISMATCH");
  }
  // 不持久化向量钥、商户钥或hmac；hash只绑定可公开评审的配置元数据。
  const canonical = JSON.stringify({ purpose: p.purpose, resourceDatabase: p.resourceDatabase, resourceRuntimeUser: p.resourceRuntimeUser,
    operation: p.operation, profileId: p.profileId, merchantIdentityId: p.merchantIdentityId, userNo: p.userNo,
    keyVersionRef: p.keyVersionRef, reviewRef: p.reviewRef, reviewSha256: p.reviewSha256, permission: p.permission, rules: p.rules,
    knownAnswer: k === "NOT_OBTAINED" ? k : { reference: k.reference, sha256: k.sha256 } });
  const bound = Object.freeze({ kind: "BOUND_JOINPAY_ACCOUNT_PROFILE" as const });
  profiles.set(bound, Object.freeze({ ...p, profileSha256: sha(canonical), rulesSha256: sha(JSON.stringify(p.rules)) }));
  return bound;
}

type Flat = Map<string, { value: string | null; numberToken: boolean }>;
function envelope(body: Uint8Array, encoding: AccountRules["dataEncoding"]): { top: Flat; data: Flat } | null {
  let text: string; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); } catch { return null; }
  let dataText: string | undefined, masked = text;
  if (encoding === "OBJECT") {
    let quoted = false, escape = false, depth = 0, start = -1, end = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === "[" || c === "]") return null;
      else if (c === "{") { depth++; if (depth > 2 || (depth === 2 && start !== -1)) return null; if (depth === 2) start = i; }
      else if (c === "}") { if (depth === 2) end = i + 1; if (--depth < 0) return null; }
    }
    if (depth !== 0 || start === -1 || end < start) return null;
    dataText = text.slice(start, end); masked = text.slice(0, start) + '"__JOINPAY_ACCOUNT_DATA__"' + text.slice(end);
  }
  const top = decodeJoinpayJson(masked); if (!top.ok) return null;
  const data = top.raw.get("data");
  if (!data || data.numberToken || typeof data.value !== "string") return null;
  if (encoding === "OBJECT") {
    if (data.value !== "__JOINPAY_ACCOUNT_DATA__" || [...top.raw.values()].filter(v => v.value === data.value).length !== 1) return null;
  } else dataText = data.value;
  const inner = decodeJoinpayJson(dataText!); return inner.ok ? { top: top.raw, data: inner.raw } : null;
}
export type AccountAmount = Readonly<{ rawDecimal: string; unitKnowledge: "UNKNOWN" | "CNY_YUAN"; cents: string | null }>;
function amount(raw: string, rules: AccountAmountRules): AccountAmount | null {
  if (raw.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return null;
  if (rules.unit === "UNKNOWN") return Object.freeze({ rawDecimal: raw, unitKnowledge: "UNKNOWN", cents: null });
  const [whole = "", fraction = ""] = raw.replace(/^-/, "").split(".");
  if (fraction.length > rules.maximumScale || (raw.startsWith("-") && !rules.allowNegative)) return null;
  let cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(rules.maximumAbsoluteCents)) return null;
  if (raw.startsWith("-")) cents = -cents;
  return Object.freeze({ rawDecimal: raw, unitKnowledge: "CNY_YUAN", cents: cents.toString() });
}
export type AccountInspection = Readonly<{ decision: "SUCCESS" | "SIGNED_PROVIDER_ERROR" | "UNKNOWN"; schema: "VALID" | "INVALID";
  signature: "MATCH" | "MISMATCH" | "NOT_CHECKED"; binding: "MATCH" | "MISMATCH" | "NOT_CHECKED";
  reason: string; statusCode: string | null; errorCode: string | null; amounts: Readonly<Record<string, AccountAmount>> | null }>;
function inspect(p: JoinpayAccountServerProfile, body: Uint8Array, key: string): AccountInspection {
  const fail = (reason: string, schema: "VALID" | "INVALID" = "INVALID", signature: AccountInspection["signature"] = "NOT_CHECKED", binding: AccountInspection["binding"] = "NOT_CHECKED"): AccountInspection =>
    Object.freeze({ decision: "UNKNOWN", schema, signature, binding, reason, statusCode: null, errorCode: null, amounts: null });
  if (body.byteLength > JOINPAY_ACCOUNT_LIMITS.maxBytes) return fail("BODY_TOO_LARGE");
  const e = envelope(body, p.rules.dataEncoding); if (!e) return fail("ENVELOPE_INVALID");
  const order = JOINPAY_ACCOUNT_SIGNATURE_ORDER[p.operation], values: Record<string, string | undefined> = {};
  if ([...e.top.keys()].some(k => !["statusCode", "message", "data"].includes(k)) || [...e.data.keys()].some(k => k !== "hmac" && (!order.includes(k) || ["statusCode", "message"].includes(k)))) return fail("UNKNOWN_FIELD");
  for (const name of order) {
    const value = (name === "statusCode" || name === "message" ? e.top : e.data).get(name);
    const optional = name === "errorCode" || name === "errorDesc";
    if (!value || value.value === null || value.value === "") { if (!optional) return fail("FIELD_MISSING"); values[name] = ""; continue; }
    const numeric = name === "currency" || (name === "statusCode" && p.rules.statusCodeToken === "NUMBER") || (AMOUNTS[p.operation].includes(name) && p.rules.amountToken === "NUMBER");
    if (value.numberToken !== numeric || value.value.trim() !== value.value || value.value.length > (AMOUNTS[p.operation].includes(name) ? 128 : 2048)) return fail("FIELD_INVALID");
    values[name] = value.value;
  }
  const hmac = e.data.get("hmac");
  if (!hmac || hmac.numberToken || typeof hmac.value !== "string" || !/^[0-9a-fA-F]{32}$/.test(hmac.value)) return fail("HMAC_INVALID");
  const computed = joinpayMd5Sign(order, values, key);
  if (!timingSafeEqual(Buffer.from(computed), Buffer.from(hmac.value.toLowerCase()))) return fail("SIGNATURE_MISMATCH", "VALID", "MISMATCH");
  if (values.userNo !== p.userNo || values.currency !== "201") return fail("BINDING_MISMATCH", "VALID", "MATCH", "MISMATCH");
  const amounts: Record<string, AccountAmount> = {};
  for (const field of AMOUNTS[p.operation]) { const parsed = amount(values[field]!, p.rules.amount); if (!parsed) return fail("AMOUNT_RULE_REJECTED", "VALID", "MATCH", "MATCH"); amounts[field] = parsed; }
  const decision = values.statusCode === "2001" && !values.errorCode ? "SUCCESS" : ["2001", "2002"].includes(values.statusCode!) ? "SIGNED_PROVIDER_ERROR" : "UNKNOWN";
  return Object.freeze({ decision, schema: "VALID", signature: "MATCH", binding: "MATCH", reason: decision === "SUCCESS" ? "VERIFIED_BALANCE_RESPONSE" : "PROVIDER_CODE",
    statusCode: values.statusCode!, errorCode: values.errorCode || null, amounts: decision === "SUCCESS" ? Object.freeze(amounts) : null });
}

export type AccountQueryResult = Readonly<{ attemptId: string; operation: JoinpayAccountOperation; decision: AccountInspection["decision"]; evidenceLevel: "SYNTHETIC_PROTOCOL" | "PROVIDER_RESPONSE" }>;
export type AccountObservedResult = Readonly<{ result: AccountQueryResult; profile: ReturnType<typeof describeJoinpayAccountProfile>; inspection: AccountInspection;
  requestSha256: string; requestedAt: string; receivedAt: string; responseComplete: boolean; receivedBytes: number;
  httpStatus: number | null; transportFailure: string | null; body: Uint8Array | null; rawSha256: string | null }>;
const results = new WeakMap<object, AccountObservedResult>();
export function readJoinpayAccountObservation(result: AccountQueryResult): AccountObservedResult {
  const v = results.get(result); if (!v) return reject("ACCOUNT_RESULT_NOT_BOUND");
  return Object.freeze({ ...v, body: v.body === null ? null : new Uint8Array(v.body) });
}
export type AccountQueryDependencies = { keyFor: (ref: string) => string | Promise<string>; fetch?: typeof globalThis.fetch; signal?: AbortSignal };
/** 一次查询；默认真实fetch只供已审核服务端装配使用。注入fetch的结果始终为合成证据。 */
export async function queryJoinpayAccount(profile: BoundJoinpayAccountProfile, deps: AccountQueryDependencies, attemptId = `jba_${randomUUID().replaceAll("-", "")}`): Promise<AccountQueryResult> {
  const p = getProfile(profile); if (!ID.test(attemptId)) reject("ACCOUNT_ATTEMPT_INVALID");
  if (p.purpose === "SYNTHETIC_PROTOCOL") reject("ACCOUNT_SYNTHETIC_NETWORK_FORBIDDEN");
  // 同一次捕获决定执行与证据等级，避免getter在发送后把合成transport换成正式标签。
  const suppliedFetch = deps.fetch, callerSignal = deps.signal, keyFor = deps.keyFor;
  if (typeof keyFor !== "function" || (suppliedFetch !== undefined && typeof suppliedFetch !== "function")) reject("ACCOUNT_DEPENDENCIES_INVALID");
  const fetcher = suppliedFetch ?? globalThis.fetch;
  let key: string; try { key = await keyFor.call(deps, p.keyVersionRef); if (typeof key !== "string" || !key) reject(); } catch { return reject("ACCOUNT_KEY_UNAVAILABLE"); }
  let body: string; try { body = JSON.stringify({ userNo: p.userNo, hmac: joinpayMd5Sign(["userNo"], { userNo: p.userNo }, key) }); } catch { return reject("ACCOUNT_KEY_UNAVAILABLE"); }
  const requestedAt = new Date().toISOString(), requestSha256 = sha(body), controller = new AbortController(), chunks: Uint8Array[] = [];
  const deadline = performance.now() + JOINPAY_ACCOUNT_LIMITS.timeoutMs;
  let bytes = 0, retained = 0, status: number | null = null, complete = false, failure: string | null = null, timedOut = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => controller.abort(); if (callerSignal?.aborted) abort(); else callerSignal?.addEventListener("abort", abort, { once: true });
  const expired = () => { if (performance.now() >= deadline) { timedOut = true; controller.abort(); } return controller.signal.aborted; };
  const cancel = () => { if (reader) void reader.cancel().catch(() => {}); }; controller.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, JOINPAY_ACCOUNT_LIMITS.timeoutMs);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<void>(resolve => { abortListener = () => { failure = timedOut ? "TIMEOUT" : "ABORTED"; resolve(); }; if (controller.signal.aborted) abortListener(); else controller.signal.addEventListener("abort", abortListener, { once: true }); });
  async function once() {
    if (controller.signal.aborted) return;
    try {
      const response = await fetcher(ENDPOINTS[p.operation], { method: "POST", body,
        headers: { "content-type": "application/json; charset=UTF-8", accept: "application/json" }, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
      if (expired()) { void response.body?.cancel().catch(() => {}); return; }
      status = response.status;
      const size = response.headers.get("content-length");
      if (size && /^\d+$/.test(size) && BigInt(size) > BigInt(JOINPAY_ACCOUNT_LIMITS.maxBytes)) { failure = "BODY_TOO_LARGE"; void response.body?.cancel().catch(() => {}); return; }
      if (response.body) { reader = response.body.getReader(); for (;;) {
        const next = await reader.read(); if (expired()) return; if (next.done) break;
        if (!(next.value instanceof Uint8Array)) { failure = "NETWORK_ERROR"; cancel(); return; }
        bytes += next.value.byteLength; const copy = new Uint8Array(next.value.subarray(0, JOINPAY_ACCOUNT_LIMITS.maxBytes - retained));
        if (copy.byteLength) { chunks.push(copy); retained += copy.byteLength; }
        if (bytes > JOINPAY_ACCOUNT_LIMITS.maxBytes) { failure = "BODY_TOO_LARGE"; cancel(); return; }
      } }
      complete = true; if (status !== 200) failure = "HTTP_STATUS";
    } catch { if (!controller.signal.aborted) failure = "NETWORK_ERROR"; }
  }
  try { await Promise.race([once(), aborted]); expired(); } finally { clearTimeout(timer); callerSignal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", cancel); if (abortListener) controller.signal.removeEventListener("abort", abortListener); }
  const raw = complete || retained > 0 ? Buffer.concat(chunks) : null;
  const inspection: AccountInspection = complete && !failure ? inspect(p, raw!, key) : Object.freeze({ decision: "UNKNOWN", schema: "INVALID", signature: "NOT_CHECKED", binding: "NOT_CHECKED", reason: failure ?? "NETWORK_ERROR", statusCode: null, errorCode: null, amounts: null });
  const result = Object.freeze({ attemptId, operation: p.operation, decision: inspection.decision, evidenceLevel: suppliedFetch !== undefined ? "SYNTHETIC_PROTOCOL" as const : "PROVIDER_RESPONSE" as const });
  results.set(result, Object.freeze({ result, profile: describeJoinpayAccountProfile(profile), inspection, requestSha256, requestedAt, receivedAt: new Date().toISOString(),
    responseComplete: complete, receivedBytes: bytes, httpStatus: status, transportFailure: failure, body: raw, rawSha256: raw === null ? null : sha(raw) }));
  return result;
}
