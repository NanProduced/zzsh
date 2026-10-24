import { createHash } from "node:crypto";
import { computeJoinpayCollectionDecision, computeJoinpayQueryRequest, computeJoinpayUniPayRequest,
  JOINPAY_SIGNATURE_ORDER, joinpayMd5Sign, centsToJoinpayYuan, validateJoinpayUniPayInput, validateJoinpayQueryInput,
  computeJoinpayNotificationDecision, type JoinpayNotificationDecoding, type JoinpayCollectionDecision } from "./joinpay-protocol";

export type CollectionOperation = "SUBMIT" | "QUERY";
export type CollectionProfileOperation = CollectionOperation | "NOTIFY";
export type CollectionEvidenceMode = "OFFICIAL" | "SYNTHETIC";
const ENDPOINTS = Object.freeze({ SUBMIT: "https://trade.joinpay.com/tradeRt/uniPay", QUERY: "https://trade.joinpay.com/tradeRt/queryOrder" });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/;
const identifier = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const A2_MERCHANT = "888100000002340";
export const COLLECTION_REQUIRED_RULES = Object.freeze({
  SUBMIT: Object.freeze(["S62_TRADE_RT_2_6_ENDPOINT", "UTF8_FORM_SINGLE_ENCODING", "MD5_DOCUMENT_ORDER_SKIP_EMPTY",
    "JSON_RESPONSE_RAW_NUMERIC_TOKENS", "MERCHANT_NATIVE_PRODUCTS",
    "TRADE_MERCHANT_NO_SEMANTICS", "PRODUCT_NAME_CHARACTER_SET"]),
  QUERY: Object.freeze(["S63_TRADE_RT_2_6_ENDPOINT", "UTF8_FORM_SINGLE_ENCODING", "MD5_DOCUMENT_ORDER_SKIP_EMPTY",
    "JSON_RESPONSE_RAW_NUMERIC_TOKENS", "MERCHANT_NATIVE_PRODUCTS",
    "CHANNEL_TIMEZONE", "QUERY_FREQUENCY_LIMIT"]),
  NOTIFY: Object.freeze(["S62_TRADE_RT_2_6_GET_NOTIFY", "RAW_URI_FRAMEWORK_DECODE_BOUNDARY", "FIELD_TIME_DECODE_COUNTS",
    "MD5_DOCUMENT_ORDER_SKIP_EMPTY", "MERCHANT_NATIVE_PRODUCTS",
    "CHANNEL_TIMEZONE", "NOTIFY_KEY_ROTATION_SELECTION"]),
});
// 本地拒绝策略不需供应商背书；旧证据字段仍可保留，下单也不使用渠道时间。
const LOCAL_POLICY_RULES = ["REJECT_NONEMPTY_UNKNOWN_FIELDS", "REJECT_FIELD_EDGE_WHITESPACE"];
export type CollectionRuleEvidence = { source: "JOINPAY_OFFICIAL" | "SYNTHETIC"; reference: string; sha256: string };
export type CollectionKnownAnswer = CollectionRuleEvidence & { values: Readonly<Record<string, string>>; vectorKey: string; expectedHmac: string };
export type CollectionOperationProfile = { keyVersionRef: string; rules: Readonly<Record<string, CollectionRuleEvidence | "NOT_OBTAINED">>;
  requestKnownAnswer: CollectionKnownAnswer | "NOT_OBTAINED"; responseKnownAnswer: CollectionKnownAnswer | "NOT_OBTAINED";
  timeOffsetMinutes?: number; notificationDecoding?: JoinpayNotificationDecoding };
export type CollectionServerProfile = { profileId: string; merchantIdentityId: string; wireMerchantNo: string; tradeMerchantNo: string; notifyUrl: string;
  purpose: "A2_SIGNATURE_ONLY" | "COLLECTION"; evidenceMode: CollectionEvidenceMode; operations: Partial<Record<CollectionProfileOperation, CollectionOperationProfile>> };
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
    || Object.keys(input.operations).some(name => name !== "SUBMIT" && name !== "QUERY" && name !== "NOTIFY")) return reject("COLLECTION_PROFILE_INVALID");
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
  // 供应商样例是附加验证证据；缺样例不代替真实回包的验签，也不阻止按正式文档联调。
  if (value === "NOT_OBTAINED") return;
  if (!value) return reject("COLLECTION_KNOWN_ANSWER_NOT_OBTAINED");
  evidence(value, mode, true);
  if (typeof value.vectorKey !== "string" || !value.vectorKey || !/^[0-9a-fA-F]{32}$/.test(value.expectedHmac)
    || !value.values || Object.values(value.values).some(v => typeof v !== "string")
    || Object.keys(value.values).some(name => !order.includes(name))) return reject("COLLECTION_KNOWN_ANSWER_INVALID");
  if (joinpayMd5Sign(order, value.values, value.vectorKey) !== value.expectedHmac.toLowerCase()) reject("COLLECTION_KNOWN_ANSWER_MISMATCH");
}
export function assertCollectionProfile(profile: BoundCollectionProfile, operation: CollectionProfileOperation): void {
  const descriptor = profiles.get(profile);
  if (!descriptor || !["SUBMIT", "QUERY", "NOTIFY"].includes(operation)) return reject("COLLECTION_PROFILE_NOT_BOUND");
  if (descriptor.purpose !== "COLLECTION" || descriptor.wireMerchantNo === A2_MERCHANT) return reject("COLLECTION_A2_PURPOSE_FORBIDDEN");
  const op = descriptor.operations[operation];
  if (!op || !identifier(op.keyVersionRef) || !op.rules) return reject("COLLECTION_OPERATION_NOT_CONFIRMED");
  const optionalRules = operation === "SUBMIT" ? [...LOCAL_POLICY_RULES, "CHANNEL_TIMEZONE"] : LOCAL_POLICY_RULES;
  if (Object.keys(op).some(name => !["keyVersionRef", "rules", "requestKnownAnswer", "responseKnownAnswer", "timeOffsetMinutes", "notificationDecoding"].includes(name))
    || Object.keys(op.rules).some(name => !COLLECTION_REQUIRED_RULES[operation].includes(name) && !optionalRules.includes(name))) return reject("COLLECTION_PROFILE_INVALID");
  for (const rule of COLLECTION_REQUIRED_RULES[operation]) evidence(op.rules[rule], descriptor.evidenceMode);
  for (const rule of optionalRules) if (op.rules[rule] !== undefined && op.rules[rule] !== "NOT_OBTAINED") evidence(op.rules[rule], descriptor.evidenceMode);
  if (operation !== "NOTIFY") knownAnswer(op.requestKnownAnswer, operation === "SUBMIT" ? JOINPAY_SIGNATURE_ORDER.uniPayRequest : JOINPAY_SIGNATURE_ORDER.queryOrderRequest, descriptor.evidenceMode);
  knownAnswer(op.responseKnownAnswer, operation === "SUBMIT" ? JOINPAY_SIGNATURE_ORDER.uniPaySyncResponse : operation === "QUERY" ? JOINPAY_SIGNATURE_ORDER.queryOrderResponse : JOINPAY_SIGNATURE_ORDER.asyncNotify, descriptor.evidenceMode);
  if (operation === "NOTIFY" && (!op.notificationDecoding || Object.keys(op.notificationDecoding).some(n => n !== "ra_PayTime" && n !== "rb_DealTime")
    || ![0, 1].includes(op.notificationDecoding.ra_PayTime) || ![0, 1].includes(op.notificationDecoding.rb_DealTime))) reject("COLLECTION_NOTIFY_DECODE_NOT_CONFIRMED");
}
const canonicalEvidence = (descriptor: Readonly<CollectionServerProfile>, operation: CollectionProfileOperation) => {
  const { operations, ...common } = descriptor;
  return JSON.stringify({ ...common, operations: { [operation]: operations[operation] } }, (name, value) => name === "vectorKey" ? undefined : value);
};
/** 证据原件只保留规则/向量字段/预期摘要，验证钥留在私有品牌中，不序列化任何vectorKey。 */
export function readCollectionProfileEvidence(profile: BoundCollectionProfile, operation: CollectionProfileOperation): string {
  assertCollectionProfile(profile, operation); return canonicalEvidence(profiles.get(profile)!, operation);
}
export function describeCollectionProfile(profile: BoundCollectionProfile, operation: CollectionProfileOperation): CollectionProfileSnapshot {
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
  if (operation !== "SUBMIT" && operation !== "QUERY") return reject("COLLECTION_OUTBOUND_OPERATION_INVALID");
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

export function inspectJoinpayCollectionNotification(profile: BoundCollectionProfile, rawQuery: string,
  binding: CollectionPersistedBinding, key: string): CollectionResponseInspection & { ack: "success" | "fail" } {
  const snapshot = describeCollectionProfile(profile, "NOTIFY");
  if (binding.merchantIdentityId !== snapshot.merchantIdentityId || binding.wireMerchantNo !== snapshot.wireMerchantNo) return reject("COLLECTION_PERSISTED_BINDING_MISMATCH");
  const decision = computeJoinpayNotificationDecision(rawQuery, { state: "SUBMITTING", merchantNo: binding.wireMerchantNo,
    orderNo: binding.originalOrderNo, amountCents: binding.amountCents, frpCode: binding.method }, key, profiles.get(profile)!.operations.NOTIFY!.notificationDecoding);
  const { values, numberTokens: _numbers, ...rest } = decision;
  const present = values && Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return freeze({ ...rest, verified: decision.schema === "VALID" && decision.signature === "MATCH" && decision.binding === "MATCH", ...(present ? { values: present } : {}) });
}

declare const FORMAL_ADMISSION: unique symbol;
export type FormalCollectionAdmission = Readonly<{ kind: "FORMAL_JOINPAY_COLLECTION"; [FORMAL_ADMISSION]: true }>;
export type FormalCollectionAdmissionView = Readonly<{ reference: string; sha256: string; canonical: string; appId: string; database: string;
  runtimeUser: string; merchantIdentityId: string; wireMerchantNo: string }>;
type AcceptedInitial = { reference: string; sha256: string };
const admissions = new WeakMap<object, { view: FormalCollectionAdmissionView; profileKeys: Set<string>; initialKeys: Set<string> }>();
const profileKey = (op: CollectionProfileOperation, s: CollectionProfileSnapshot) => JSON.stringify([op, s.profileId, s.profileSha256, s.keyVersionRef]);
const modelReference = (value: string) => /SYNTHETIC|MODEL|NOT_REAL|NOT_OBTAINED|example\.invalid/i.test(value);

// 装配元数据只读数据描述符一次；不克隆BoundProfile身份，也不执行getter或自定义迭代器。
function formalDataSnapshot<T extends object>(value: T): T {
  try {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return reject("COLLECTION_FORMAL_ADMISSION_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value), copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !("value" in descriptors[key]!)) return reject("COLLECTION_FORMAL_ADMISSION_INVALID");
      copy[key] = descriptors[key]!.value;
    }
    return copy as T;
  } catch { return reject("COLLECTION_FORMAL_ADMISSION_INVALID"); }
}
function formalArraySnapshot<T>(value: readonly T[], maximum: number): T[] {
  try {
    if (!Array.isArray(value)) return reject("COLLECTION_FORMAL_ADMISSION_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>, length = descriptors.length?.value;
    if (!Number.isInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(descriptors).length !== length + 1) return reject("COLLECTION_FORMAL_ADMISSION_INVALID");
    const copy: T[] = [];
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || !("value" in descriptor)) return reject("COLLECTION_FORMAL_ADMISSION_INVALID");
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return reject("COLLECTION_FORMAL_ADMISSION_INVALID"); }
}

/** 受信后端在核对商户和官方原件后显式装配；本函数不认证文档出处，也不读环境或钥。 */
export function bindFormalJoinpayCollectionAdmission(input: {
  kind: "JOINPAY_FORMAL_SERVER_REVIEW"; reference: string; reviewSha256: string; appId: string; database: string; runtimeUser: string;
  merchantIdentityId: string; wireMerchantNo: string; profiles: readonly BoundCollectionProfile[]; acceptedInitialAdmissions?: readonly AcceptedInitial[];
}): FormalCollectionAdmission {
  input = formalDataSnapshot(input);
  input = { ...input, profiles: formalArraySnapshot(input.profiles, 32),
    acceptedInitialAdmissions: formalArraySnapshot(input.acceptedInitialAdmissions ?? [], 64).map(p => formalDataSnapshot(p)) };
  if (!input || input.kind !== "JOINPAY_FORMAL_SERVER_REVIEW" || !identifier(input.reference) || modelReference(input.reference)
    || typeof input.reviewSha256 !== "string" || !SHA.test(input.reviewSha256) || !identifier(input.appId) || !identifier(input.merchantIdentityId) || modelReference(input.merchantIdentityId)
    || typeof input.database !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(input.database)
    || typeof input.runtimeUser !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(input.runtimeUser)
    || typeof input.wireMerchantNo !== "string" || !/^[0-9]{1,15}$/.test(input.wireMerchantNo) || input.wireMerchantNo === A2_MERCHANT
    || !Array.isArray(input.profiles) || input.profiles.length < 1 || input.profiles.length > 32
    || Object.keys(input).some(n => !["kind", "reference", "reviewSha256", "appId", "database", "runtimeUser", "merchantIdentityId", "wireMerchantNo", "profiles", "acceptedInitialAdmissions"].includes(n))) return reject("COLLECTION_FORMAL_ADMISSION_INVALID");
  const accepted: (CollectionProfileSnapshot & { operation: CollectionProfileOperation })[] = [];
  for (const profile of input.profiles) {
    const descriptor = profiles.get(profile);
    if (!descriptor || descriptor.evidenceMode !== "OFFICIAL" || descriptor.purpose !== "COLLECTION"
      || descriptor.merchantIdentityId !== input.merchantIdentityId || descriptor.wireMerchantNo !== input.wireMerchantNo) return reject("COLLECTION_FORMAL_PROFILE_NOT_ACCEPTED");
    for (const operation of ["SUBMIT", "QUERY", "NOTIFY"] as const) {
      const op = descriptor.operations[operation]; if (!op) continue;
      const snapshot = describeCollectionProfile(profile, operation);
      const references = [descriptor.profileId, ...Object.values(op.rules).filter((v): v is CollectionRuleEvidence => v !== "NOT_OBTAINED").map(v => v.reference),
        ...(operation !== "NOTIFY" && op.requestKnownAnswer && op.requestKnownAnswer !== "NOT_OBTAINED" ? [op.requestKnownAnswer.reference] : []),
        ...(op.responseKnownAnswer && op.responseKnownAnswer !== "NOT_OBTAINED" ? [op.responseKnownAnswer.reference] : [])];
      // 只检查原件来源元数据；合法协议字段q9_TransactionModel和业务值不代表合成来源。
      if (references.some(modelReference)) return reject("COLLECTION_FORMAL_PROFILE_NOT_ACCEPTED");
      if (operation !== "SUBMIT" && (!Number.isInteger(op.timeOffsetMinutes) || Math.abs(op.timeOffsetMinutes!) > 840)) return reject("COLLECTION_TIMEZONE_NOT_CONFIRMED");
      accepted.push({ ...snapshot, operation });
    }
  }
  if (!accepted.length) return reject("COLLECTION_FORMAL_PROFILE_NOT_ACCEPTED");
  accepted.sort((a, b) => profileKey(a.operation, a).localeCompare(profileKey(b.operation, b)));
  const previous = input.acceptedInitialAdmissions ?? [];
  if (!Array.isArray(previous) || previous.length > 64 || previous.some(p => !p || !identifier(p.reference) || modelReference(p.reference) || typeof p.sha256 !== "string" || !SHA.test(p.sha256)
    || Object.keys(p).some(k => k !== "reference" && k !== "sha256"))) return reject("COLLECTION_FORMAL_HISTORY_INVALID");
  const canonical = JSON.stringify({ kind: input.kind, reference: input.reference, reviewSha256: input.reviewSha256, appId: input.appId,
    database: input.database, runtimeUser: input.runtimeUser, merchantIdentityId: input.merchantIdentityId, wireMerchantNo: input.wireMerchantNo,
    acceptedProfiles: accepted, acceptedInitialAdmissions: [...previous].sort((a, b) => a.sha256.localeCompare(b.sha256)) });
  const view = freeze({ reference: input.reference, sha256: sha256(canonical), canonical, appId: input.appId, database: input.database,
    runtimeUser: input.runtimeUser, merchantIdentityId: input.merchantIdentityId, wireMerchantNo: input.wireMerchantNo });
  const value = Object.freeze({ kind: "FORMAL_JOINPAY_COLLECTION" as const }) as FormalCollectionAdmission;
  admissions.set(value, { view, profileKeys: new Set(accepted.map(s => profileKey(s.operation, s))),
    initialKeys: new Set([...previous.map(p => JSON.stringify([p.reference, p.sha256])), JSON.stringify([view.reference, view.sha256])]) });
  return value;
}
export function readFormalCollectionAdmission(admission: FormalCollectionAdmission): FormalCollectionAdmissionView {
  const bound = admissions.get(admission); if (!bound) return reject("COLLECTION_FORMAL_ADMISSION_NOT_BOUND"); return bound.view;
}
/** 新收款须同时有收款、原号查询和通知准入；历史单可使用单操作的明确历史profile。 */
export function assertFormalCollectionStart(admission: FormalCollectionAdmission): FormalCollectionAdmissionView {
  const view = readFormalCollectionAdmission(admission), operations = new Set([...admissions.get(admission)!.profileKeys].map(p => JSON.parse(p)[0]));
  if (!["SUBMIT", "QUERY", "NOTIFY"].every(op => operations.has(op))) return reject("COLLECTION_FORMAL_START_INCOMPLETE");
  return view;
}
export function assertFormalCollectionProfile(admission: FormalCollectionAdmission, profile: BoundCollectionProfile,
  operation: CollectionProfileOperation): FormalCollectionAdmissionView {
  const view = readFormalCollectionAdmission(admission), snapshot = describeCollectionProfile(profile, operation);
  if (!admissions.get(admission)!.profileKeys.has(profileKey(operation, snapshot)) || snapshot.evidenceMode !== "OFFICIAL"
    || snapshot.merchantIdentityId !== view.merchantIdentityId || snapshot.wireMerchantNo !== view.wireMerchantNo) return reject("COLLECTION_FORMAL_PROFILE_NOT_ACCEPTED");
  return view;
}
export function assertFormalInitialAdmission(admission: FormalCollectionAdmission, reference: string, sha256: string): void {
  readFormalCollectionAdmission(admission);
  if (!admissions.get(admission)!.initialKeys.has(JSON.stringify([reference, sha256]))) reject("COLLECTION_INITIAL_ADMISSION_NOT_ACCEPTED");
}
/** 只使用该操作受信固定offset；拒未知时区、非法日期及自动本机时区推断。 */
export function joinpayProviderTimeToUtc(profile: BoundCollectionProfile, operation: "QUERY" | "NOTIFY", value: string): string {
  assertCollectionProfile(profile, operation); const offset = profiles.get(profile)!.operations[operation]!.timeOffsetMinutes;
  if (!Number.isInteger(offset) || Math.abs(offset!) > 840) return reject("COLLECTION_TIMEZONE_NOT_CONFIRMED");
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!m) return reject("COLLECTION_PROVIDER_TIME_INVALID");
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number), date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!); date.setUTCHours(hour!, minute!, second!, 0);
  if (year! < 1970 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return reject("COLLECTION_PROVIDER_TIME_INVALID");
  return new Date(date.getTime() - offset! * 60000).toISOString();
}
