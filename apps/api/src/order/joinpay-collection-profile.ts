import { createHash } from "node:crypto";
import { computeJoinpayCollectionDecision, computeJoinpayQueryRequest, computeJoinpayUniPayRequest,
  JOINPAY_SIGNATURE_ORDER, joinpayMd5Sign, centsToJoinpayYuan, validateJoinpayUniPayInput, validateJoinpayQueryInput, type JoinpayCollectionDecision } from "./joinpay-protocol";

export type CollectionOperation = "SUBMIT" | "QUERY";
export type CollectionEvidenceMode = "OFFICIAL" | "SYNTHETIC";
const ENDPOINTS = Object.freeze({ SUBMIT: "https://trade.joinpay.com/tradeRt/uniPay", QUERY: "https://trade.joinpay.com/tradeRt/queryOrder" });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/;
const identifier = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const A2_MERCHANT = "888100000002340";
export const COLLECTION_REQUIRED_RULES = Object.freeze({
  SUBMIT: Object.freeze(["S62_TRADE_RT_2_6_ENDPOINT", "UTF8_FORM_SINGLE_ENCODING", "MD5_DOCUMENT_ORDER_SKIP_EMPTY",
    "JSON_RESPONSE_RAW_NUMERIC_TOKENS", "REJECT_NONEMPTY_UNKNOWN_FIELDS", "REJECT_FIELD_EDGE_WHITESPACE", "MERCHANT_NATIVE_PRODUCTS",
    "TRADE_MERCHANT_NO_SEMANTICS", "PRODUCT_NAME_CHARACTER_SET", "CHANNEL_TIMEZONE"]),
  QUERY: Object.freeze(["S63_TRADE_RT_2_6_ENDPOINT", "UTF8_FORM_SINGLE_ENCODING", "MD5_DOCUMENT_ORDER_SKIP_EMPTY",
    "JSON_RESPONSE_RAW_NUMERIC_TOKENS", "REJECT_NONEMPTY_UNKNOWN_FIELDS", "REJECT_FIELD_EDGE_WHITESPACE", "MERCHANT_NATIVE_PRODUCTS",
    "CHANNEL_TIMEZONE", "QUERY_FREQUENCY_LIMIT"]),
});
export type CollectionRuleEvidence = { source: "JOINPAY_OFFICIAL" | "SYNTHETIC"; reference: string; sha256: string };
export type CollectionKnownAnswer = CollectionRuleEvidence & { values: Readonly<Record<string, string>>; vectorKey: string; expectedHmac: string };
export type CollectionOperationProfile = { keyVersionRef: string; rules: Readonly<Record<string, CollectionRuleEvidence | "NOT_OBTAINED">>;
  requestKnownAnswer: CollectionKnownAnswer | "NOT_OBTAINED"; responseKnownAnswer: CollectionKnownAnswer | "NOT_OBTAINED" };
export type CollectionServerProfile = { profileId: string; merchantIdentityId: string; wireMerchantNo: string; tradeMerchantNo: string; notifyUrl: string;
  purpose: "A2_SIGNATURE_ONLY" | "COLLECTION"; evidenceMode: CollectionEvidenceMode; operations: Partial<Record<CollectionOperation, CollectionOperationProfile>> };
export type CollectionProfileSnapshot = Readonly<{ profileId: string; profileSha256: string; keyVersionRef: string; merchantIdentityId: string;
  wireMerchantNo: string; protocolVersion: "2.6"; evidenceMode: CollectionEvidenceMode }>;
declare const PROFILE: unique symbol;
export type BoundCollectionProfile = Readonly<{ profileId: string; [PROFILE]: true }>;
export type CollectionPersistedBinding = { requestId: string; originalOrderNo: string; amountCents: string; method: "ALIPAY_NATIVE" | "WEIXIN_NATIVE";
  wireMerchantNo: string; tradeMerchantNo: string; productName: string; notifyUrl: string; profileId: string; keyVersionRef: string; merchantIdentityId: string };
declare const OUTBOUND: unique symbol;
export type CollectionOutboundRequest = Readonly<CollectionProfileSnapshot & { operation: CollectionOperation; originalOrderNo: string;
  requestId: string; requestSha256: string; encodedBody: string; [OUTBOUND]: true }>;
const profiles = new WeakMap<object, Readonly<CollectionServerProfile>>();
const requests = new WeakMap<object, Readonly<{ endpoint: string; encodedBody: string; evidenceMode: CollectionEvidenceMode }>>();
export class JoinpayCollectionProfileError extends Error {
  constructor(readonly code: string) { super(code); this.name = "JoinpayCollectionProfileError"; }
}
const reject = (code: string): never => { throw new JoinpayCollectionProfileError(code); };
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || !URL.canParse(value)) return false;
  const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash && value.length <= 300;
}
/** 仅服务端受信装配调用；reference/hash真实性由装配者核实，本程序不认证文档原件。JSON无法复制运行时品牌。 */
export function bindJoinpayCollectionProfile(input: CollectionServerProfile): BoundCollectionProfile {
  if (!input || !identifier(input.profileId) || !identifier(input.merchantIdentityId) || typeof input.wireMerchantNo !== "string" || !/^[0-9]{1,15}$/.test(input.wireMerchantNo)
    || typeof input.tradeMerchantNo !== "string" || !/^[A-Za-z0-9_]{1,50}$/.test(input.tradeMerchantNo) || !httpsUrl(input.notifyUrl)
    || !["COLLECTION", "A2_SIGNATURE_ONLY"].includes(input.purpose) || !["OFFICIAL", "SYNTHETIC"].includes(input.evidenceMode)
    || !input.operations || typeof input.operations !== "object") return reject("COLLECTION_PROFILE_INVALID");
  if (input.evidenceMode === "SYNTHETIC" && (!input.profileId.startsWith("SYNTHETIC_") || !input.merchantIdentityId.startsWith("synthetic_"))) return reject("COLLECTION_SYNTHETIC_LABEL_REQUIRED");
  if (Object.keys(input).some(name => !["profileId", "merchantIdentityId", "wireMerchantNo", "tradeMerchantNo", "notifyUrl", "purpose", "evidenceMode", "operations"].includes(name))
    || Object.keys(input.operations).some(name => name !== "SUBMIT" && name !== "QUERY")) return reject("COLLECTION_PROFILE_INVALID");
  let copy: CollectionServerProfile;
  try { copy = structuredClone(input); } catch { return reject("COLLECTION_PROFILE_INVALID"); }
  const bound = Object.freeze({ profileId: input.profileId }) as BoundCollectionProfile;
  profiles.set(bound, freeze(copy)); return bound;
}
function evidence(value: CollectionRuleEvidence | undefined | "NOT_OBTAINED", mode: CollectionEvidenceMode, vector = false): void {
  if (!value || value === "NOT_OBTAINED" || value.source !== (mode === "OFFICIAL" ? "JOINPAY_OFFICIAL" : "SYNTHETIC")
    || Object.keys(value).some(name => !(vector ? ["source", "reference", "sha256", "values", "vectorKey", "expectedHmac"] : ["source", "reference", "sha256"]).includes(name))
    || typeof value.reference !== "string" || value.reference.length < 1 || value.reference.length > 256 || !SHA.test(value.sha256)) reject("COLLECTION_RULE_NOT_CONFIRMED");
}
function knownAnswer(value: CollectionKnownAnswer | "NOT_OBTAINED", order: readonly string[], mode: CollectionEvidenceMode): void {
  if (!value || value === "NOT_OBTAINED") return reject("COLLECTION_KNOWN_ANSWER_NOT_OBTAINED");
  evidence(value, mode, true);
  if (typeof value.vectorKey !== "string" || !value.vectorKey || !/^[0-9a-fA-F]{32}$/.test(value.expectedHmac)
    || !value.values || Object.values(value.values).some(v => typeof v !== "string")
    || Object.keys(value.values).some(name => !order.includes(name))) return reject("COLLECTION_KNOWN_ANSWER_INVALID");
  if (joinpayMd5Sign(order, value.values, value.vectorKey) !== value.expectedHmac.toLowerCase()) reject("COLLECTION_KNOWN_ANSWER_MISMATCH");
}
export function assertCollectionProfile(profile: BoundCollectionProfile, operation: CollectionOperation): void {
  const descriptor = profiles.get(profile);
  if (!descriptor || !["SUBMIT", "QUERY"].includes(operation)) return reject("COLLECTION_PROFILE_NOT_BOUND");
  if (descriptor.purpose !== "COLLECTION" || descriptor.wireMerchantNo === A2_MERCHANT) return reject("COLLECTION_A2_PURPOSE_FORBIDDEN");
  const op = descriptor.operations[operation];
  if (!op || !identifier(op.keyVersionRef) || !op.rules) return reject("COLLECTION_OPERATION_NOT_CONFIRMED");
  if (Object.keys(op).some(name => !["keyVersionRef", "rules", "requestKnownAnswer", "responseKnownAnswer"].includes(name))
    || Object.keys(op.rules).some(name => !COLLECTION_REQUIRED_RULES[operation].includes(name))) return reject("COLLECTION_PROFILE_INVALID");
  for (const rule of COLLECTION_REQUIRED_RULES[operation]) evidence(op.rules[rule], descriptor.evidenceMode);
  knownAnswer(op.requestKnownAnswer, operation === "SUBMIT" ? JOINPAY_SIGNATURE_ORDER.uniPayRequest : JOINPAY_SIGNATURE_ORDER.queryOrderRequest, descriptor.evidenceMode);
  knownAnswer(op.responseKnownAnswer, operation === "SUBMIT" ? JOINPAY_SIGNATURE_ORDER.uniPaySyncResponse : JOINPAY_SIGNATURE_ORDER.queryOrderResponse, descriptor.evidenceMode);
}
const canonicalEvidence = (descriptor: Readonly<CollectionServerProfile>, operation: CollectionOperation) => {
  const { operations, ...common } = descriptor;
  return JSON.stringify({ ...common, operations: { [operation]: operations[operation] } }, (name, value) => name === "vectorKey" ? undefined : value);
};
/** 证据原件只保留规则/向量字段/预期摘要，验证钥留在私有品牌中，不序列化任何vectorKey。 */
export function readCollectionProfileEvidence(profile: BoundCollectionProfile, operation: CollectionOperation): string {
  assertCollectionProfile(profile, operation); return canonicalEvidence(profiles.get(profile)!, operation);
}
export function describeCollectionProfile(profile: BoundCollectionProfile, operation: CollectionOperation): CollectionProfileSnapshot {
  assertCollectionProfile(profile, operation); const descriptor = profiles.get(profile)!;
  return Object.freeze({ profileId: descriptor.profileId, profileSha256: sha256(canonicalEvidence(descriptor, operation)), keyVersionRef: descriptor.operations[operation]!.keyVersionRef,
    merchantIdentityId: descriptor.merchantIdentityId, wireMerchantNo: descriptor.wireMerchantNo, protocolVersion: "2.6", evidenceMode: descriptor.evidenceMode });
}
function bindingFor(profile: BoundCollectionProfile, operation: CollectionOperation, binding: CollectionPersistedBinding): CollectionProfileSnapshot {
  const snapshot = describeCollectionProfile(profile, operation), descriptor = profiles.get(profile)!;
  if (!binding || !identifier(binding.requestId) || operation === "SUBMIT" && (binding.profileId !== snapshot.profileId || binding.keyVersionRef !== snapshot.keyVersionRef)
    || binding.merchantIdentityId !== snapshot.merchantIdentityId || binding.wireMerchantNo !== snapshot.wireMerchantNo
    || operation === "SUBMIT" && (binding.tradeMerchantNo !== descriptor.tradeMerchantNo || binding.notifyUrl !== descriptor.notifyUrl)
    || typeof binding.productName !== "string" || !["ALIPAY_NATIVE", "WEIXIN_NATIVE"].includes(binding.method)) return reject("COLLECTION_PERSISTED_BINDING_MISMATCH");
  centsToJoinpayYuan(binding.amountCents);
  return snapshot;
}
const uniPayInput = (binding: CollectionPersistedBinding) => ({ merchantNo: binding.wireMerchantNo, orderNo: binding.originalOrderNo,
  amountCents: binding.amountCents, currency: "CNY" as const, productName: binding.productName, notifyUrl: binding.notifyUrl, frpCode: binding.method, tradeMerchantNo: binding.tradeMerchantNo });
/** 持久请求创建提交前使用；不读商户钥、不签名、不mint出站请求，字段规则与实际produce完全相同。 */
export function assertCollectionRequestBinding(profile: BoundCollectionProfile, operation: CollectionOperation, binding: CollectionPersistedBinding): void {
  bindingFor(profile, operation, binding);
  if (operation === "SUBMIT") validateJoinpayUniPayInput(uniPayInput(binding));
  else validateJoinpayQueryInput({ merchantNo: binding.wireMerchantNo, orderNo: binding.originalOrderNo });
}
export function produceJoinpayCollectionRequest(profile: BoundCollectionProfile, operation: CollectionOperation,
  binding: CollectionPersistedBinding, key: string): CollectionOutboundRequest {
  assertCollectionRequestBinding(profile, operation, binding); const snapshot = describeCollectionProfile(profile, operation);
  const form = operation === "SUBMIT" ? computeJoinpayUniPayRequest(uniPayInput(binding), key)
    : computeJoinpayQueryRequest({ merchantNo: binding.wireMerchantNo, orderNo: binding.originalOrderNo }, key);
  const encodedBody = new URLSearchParams(form.fields.map(([name, value]) => [name, value])).toString();
  const request = Object.freeze({ ...snapshot, operation, originalOrderNo: binding.originalOrderNo, requestId: binding.requestId,
    encodedBody, requestSha256: sha256(encodedBody) }) as CollectionOutboundRequest;
  requests.set(request, Object.freeze({ endpoint: ENDPOINTS[operation], encodedBody, evidenceMode: snapshot.evidenceMode })); return request;
}
/** transport只消费私有品牌保存的原字节；复制对象、改写字段或旧synthetic form均不产生发送权限。 */
export function readCollectionOutboundRequest(request: CollectionOutboundRequest): Readonly<{ endpoint: string; encodedBody: string; evidenceMode: CollectionEvidenceMode }> {
  const value = requests.get(request); if (!value) return reject("COLLECTION_OUTBOUND_NOT_BOUND"); return value;
}
export type CollectionResponseInspection = Readonly<Omit<JoinpayCollectionDecision, "values" | "numberTokens" | "paymentParamUrl"> & {
  verified: boolean; values?: Readonly<Record<string, string>> }>;
export function inspectJoinpayCollectionResponse(profile: BoundCollectionProfile, operation: CollectionOperation, body: string | Uint8Array,
  binding: CollectionPersistedBinding, key: string): CollectionResponseInspection {
  bindingFor(profile, operation, binding);
  const { values, numberTokens: _numbers, paymentParamUrl: _url, ...decision } = computeJoinpayCollectionDecision(operation, body,
    { state: "SUBMITTING", merchantNo: binding.wireMerchantNo, orderNo: binding.originalOrderNo, amountCents: binding.amountCents, frpCode: binding.method }, key);
  const present = values && Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return freeze({ ...decision, verified: decision.schema === "VALID" && decision.signature === "MATCH" && decision.binding === "MATCH", ...(present ? { values: present } : {}) });
}
