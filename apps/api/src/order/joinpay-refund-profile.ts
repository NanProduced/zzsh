import { createHash } from "node:crypto";
import { computeJoinpayRefundRequest, computeJoinpayRefundQuery, computeJoinpayRefundResponse, validateJoinpayRefundRequestInput, type JoinpayRefundBinding, type RefundNeutralResult } from "./joinpay-refund-protocol";
export type RefundOperation = "SUBMIT" | "QUERY" | "NOTIFY";
export type RefundBinding = JoinpayRefundBinding & Readonly<{ intentId: string; postingId: string | null;
  basisKind?: "POSTING" | "REVIEW_CONFIRMATION" | "PRESTART_TERMINATION"; abnormalConfirmationId?: string | null; orderId: string; paymentConfirmationId: string;
  renterUserId: string; merchantIdentityId: string; originalPaymentTrxNo: string; responsibilityVersionHash: string; notifyUrl: string; reason?: string;
  profileId: string; initialProfileSha256: string; keyVersionRef: string }>;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex"), ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, SHA = /^[0-9a-f]{64}$/;
const isSha=(v:unknown):v is string=>typeof v==="string"&&SHA.test(v);
export class RefundProfileError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code = "REFUND_PROFILE_UNAVAILABLE"): never => { throw new RefundProfileError(code); };
function data(v: unknown): any {
  if (typeof v === "string") { if (/\p{Cs}/u.test(v)) fail(); return v; }
  if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (!v || typeof v !== "object" || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== Array.prototype)) fail();
  const array = Array.isArray(v), descriptors = Object.getOwnPropertyDescriptors(v);
  if (Object.getOwnPropertySymbols(descriptors).length) fail();
  if (array) {
    const indices = Object.keys(descriptors).filter(k => k !== "length");
    if (descriptors.length?.value !== indices.length || indices.length > 256 || indices.some((k, index) => k !== String(index))) fail();
  }
  const out: any = array ? [] : {};
  for (const [key, d] of Object.entries(descriptors)) { if (array && key === "length") continue; if (!("value" in d) || !d.enumerable || key === "__proto__" || /\p{Cs}/u.test(key)) fail(); out[key] = data(d.value); }
  return Object.freeze(out);
}
export type RefundServerProfile = Readonly<{
  operation: RefundOperation; purpose: "MERCHANT_REFUND" | "SYNTHETIC_PROTOCOL"; profileId: string; merchantIdentityId: string; merchantNo: string;
  database: string; runtimeUser: string; keyVersionRef: string; notifyUrl: string; fundsAccount?: "SETTLED" | "ADVANCE";
  reviewRef: string; reviewSha256: string; permission: "REVIEWED_NATIVE_RENTAL_REFUND";
  rules: { reference: string; sha256: string; signing: "MD5_UTF8_RAW_VALUES"; rawQueryDecode: "ONCE"; numberTokens: "RAW_JSON_TOKEN";
    fieldPolicy: "STRICT_TABLE_EMPTY_OPTIONAL"; refundIdentifier: "EXACT_TEXT"; notify102: "REVIEW"; utcOffsetMinutes: number;
    refundWay: "ORIGINAL_REQUIRED" | "ORIGINAL_OR_MISSING_REVIEWED";
    failureNoExecution: { accepted: boolean; codes: readonly string[]; reference: string | null; sha256: string | null } };
  knownAnswer: { reference: string; rawSha256: string; vectorKey: string; binding: JoinpayRefundBinding;
    responseBody: string; expectedResult: RefundNeutralResult["result"]; requestHmac?: string } | "NOT_OBTAINED";
}>;
export type BoundRefundProfile = Readonly<{ kind: "BOUND_JOINPAY_REFUND_PROFILE" }>;
type Profile = RefundServerProfile & { canonical: string; sha256: string };
const profiles = new WeakMap<object, Profile>();
function pget(p: BoundRefundProfile): Profile { return profiles.get(p) ?? fail("REFUND_PROFILE_NOT_BOUND"); }
function op(o: unknown): asserts o is RefundOperation { if (typeof o!=="string" || !["SUBMIT", "QUERY", "NOTIFY"].includes(o)) fail(); }
function safeText(v: unknown, max = 512): v is string { return typeof v === "string" && !!v && v.trim() === v && v.length <= max; }
export function bindRefundProfile(input: RefundServerProfile): BoundRefundProfile {
  const p = data(input) as RefundServerProfile; op(p.operation);
  if (Object.keys(p).some(k => !["operation","purpose","profileId","merchantIdentityId","merchantNo","database","runtimeUser","keyVersionRef","notifyUrl","fundsAccount","reviewRef","reviewSha256","permission","rules","knownAnswer"].includes(k))) fail();
  if (![p.profileId, p.merchantIdentityId, p.keyVersionRef].every(v => typeof v === "string" && ID.test(v)) || typeof p.merchantNo!=="string" || !/^[0-9]{1,15}$/.test(p.merchantNo)
    || p.merchantNo === "888100000002340" || !["MERCHANT_REFUND", "SYNTHETIC_PROTOCOL"].includes(p.purpose) || p.permission !== "REVIEWED_NATIVE_RENTAL_REFUND") fail();
  if (![p.database, p.runtimeUser].every(v => typeof v === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(v)) || !safeText(p.reviewRef) || !isSha(p.reviewSha256)
    || !safeText(p.notifyUrl,300) || p.fundsAccount!==undefined && !["SETTLED","ADVANCE"].includes(p.fundsAccount)) fail();
  const r = p.rules, k = p.knownAnswer;
  if (r && Object.keys(r).some(k => !["reference","sha256","signing","rawQueryDecode","numberTokens","fieldPolicy","refundIdentifier","notify102","utcOffsetMinutes","refundWay","failureNoExecution"].includes(k))) fail();
  if (!r || !safeText(r.reference) || !isSha(r.sha256) || r.signing !== "MD5_UTF8_RAW_VALUES" || r.rawQueryDecode !== "ONCE" || r.numberTokens !== "RAW_JSON_TOKEN"
    || r.fieldPolicy !== "STRICT_TABLE_EMPTY_OPTIONAL" || r.refundIdentifier !== "EXACT_TEXT" || r.notify102 !== "REVIEW" || !Number.isInteger(r.utcOffsetMinutes)
    || r.utcOffsetMinutes < -840 || r.utcOffsetMinutes > 840 || !["ORIGINAL_REQUIRED", "ORIGINAL_OR_MISSING_REVIEWED"].includes(r.refundWay)) fail();
  const f = r.failureNoExecution;
  if (f && Object.keys(f).some(k => !["accepted","codes","reference","sha256"].includes(k))) fail();
  if (!f || typeof f.accepted !== "boolean" || !Array.isArray(f.codes) || f.codes.some(c => !safeText(c, 20))
    || (f.accepted ? !f.codes.length || !safeText(f.reference) || !isSha(f.sha256) : f.codes.length !== 0 || f.reference !== null || f.sha256 !== null)) fail();
  // 样例是附加计算证据；缺失不代替每次真实回包的验签与原款绑定。
  if (k !== "NOT_OBTAINED") {
  if (!k || !safeText(k.reference) || !safeText(k.vectorKey, 4096) || typeof k.responseBody !== "string" || Buffer.byteLength(k.responseBody) > 65536
    || !isSha(k.rawSha256) || sha(k.responseBody) !== k.rawSha256 || k.binding.merchantNo !== p.merchantNo || k.binding.currency !== "CNY") fail("REFUND_KAT_REQUIRED");
  if (p.operation !== "NOTIFY") {
    const form = p.operation === "SUBMIT" ? computeJoinpayRefundRequest({ ...k.binding, notifyUrl: p.notifyUrl }, k.vectorKey) : computeJoinpayRefundQuery(k.binding, k.vectorKey);
    if (form.hmac !== k.requestHmac?.toLowerCase()) fail("REFUND_KAT_MISMATCH");
  }
  const result = computeJoinpayRefundResponse(p.operation === "SUBMIT" ? "REFUND_SYNC" : p.operation === "QUERY" ? "REFUND_QUERY" : "REFUND_NOTIFY", k.responseBody, { key: k.vectorKey, binding: k.binding, leaseCurrent: true });
  if (result.signature !== "MATCH" || result.result !== k.expectedResult) fail("REFUND_KAT_MISMATCH");
  }
  const canonical = JSON.stringify({ kind: "JOINPAY_REFUND_PROFILE_V1", ...p, knownAnswer: k === "NOT_OBTAINED" ? k : { reference: k.reference, rawSha256: k.rawSha256, expectedResult: k.expectedResult } });
  const bound = Object.freeze({ kind: "BOUND_JOINPAY_REFUND_PROFILE" as const }); profiles.set(bound, Object.freeze({ ...p, canonical, sha256: sha(canonical) })); return bound;
}
export function describeRefundProfile(profile: BoundRefundProfile, operation?: RefundOperation) {
  const p = pget(profile); if (operation && p.operation !== operation) fail("REFUND_OPERATION_MISMATCH");
  return Object.freeze({ operation: p.operation, purpose: p.purpose, profileId: p.profileId, profileSha256: p.sha256, keyVersionRef: p.keyVersionRef,
    merchantIdentityId: p.merchantIdentityId, merchantNo: p.merchantNo, database: p.database, runtimeUser: p.runtimeUser,
    notifyUrl: p.notifyUrl, fundsAccount: p.fundsAccount });
}
export const readRefundProfileEvidence = (p: BoundRefundProfile): string => pget(p).canonical;

export type FormalRefundAdmission = Readonly<{ kind: "FORMAL_NATIVE_REFUND_ADMISSION" }>;
type AdmissionView = Readonly<{ reference: string; sha256: string; canonical: string; database: string; runtimeUser: string;
  merchantIdentityId: string; merchantNo: string; acceptedProfiles: readonly { operation: RefundOperation; profileId: string; profileSha256: string; keyVersionRef: string }[];
  historicalInitialAdmissions: readonly { reference: string; sha256: string }[] }>;
const admissions = new WeakMap<object, AdmissionView>();
/** 真实性/开通/操作权限由受信服务端审核；公开OFFICIAL字段或KAT计算不自证正式准入。 */
export function createFormalRefundAdmission(input: { reference: string; reviewSha256: string; profiles: readonly BoundRefundProfile[]; historicalInitialAdmissions?: readonly { reference: string; sha256: string }[] }): FormalRefundAdmission {
  const ds = Object.getOwnPropertyDescriptors(input); for (const d of Object.values(ds)) if (!("value" in d)) fail();
  const meta = data({ reference: ds.reference?.value, reviewSha256: ds.reviewSha256?.value, history: ds.historicalInitialAdmissions?.value ?? [] });
  if (!safeText(meta.reference,128) || !isSha(meta.reviewSha256) || /SYNTHETIC|MODEL/i.test(meta.reference)) fail("REFUND_FORMAL_SOURCE_NOT_ACCEPTED");
  const supplied = ds.profiles?.value; if (!Array.isArray(supplied) || Object.getPrototypeOf(supplied) !== Array.prototype || supplied.length < 1 || supplied.length > 32) return fail();
  const accepted: AdmissionView["acceptedProfiles"][number][] = []; let first: ReturnType<typeof describeRefundProfile> | undefined;
  for (let i = 0; i < supplied.length; i++) {
    const item = Object.getOwnPropertyDescriptor(supplied, String(i)); if (!item || !("value" in item)) return fail(); const profile = item.value as BoundRefundProfile, p = pget(profile), v = describeRefundProfile(profile);
    if (v.purpose !== "MERCHANT_REFUND" || /SYNTHETIC|MODEL/i.test([p.profileId, p.reviewRef, p.rules.reference, ...(p.knownAnswer === "NOT_OBTAINED" ? [] : [p.knownAnswer.reference])].join("|"))) fail("REFUND_FORMAL_SOURCE_NOT_ACCEPTED");
    first ??= v; if (v.database !== first.database || v.runtimeUser !== first.runtimeUser || v.merchantIdentityId !== first.merchantIdentityId || v.merchantNo !== first.merchantNo) fail();
    accepted.push(Object.freeze({ operation: p.operation, profileId: p.profileId, profileSha256: p.sha256, keyVersionRef: p.keyVersionRef }));
  }
  const history = Object.freeze(meta.history.map((h:any) => {
    if (!h || Object.keys(h).some(k => k!=="reference" && k!=="sha256") || !safeText(h.reference,128) || !isSha(h.sha256) || /SYNTHETIC|MODEL/i.test(h.reference)) return fail();
    return Object.freeze({reference:h.reference as string,sha256:h.sha256 as string});
  }));
  const canonical = JSON.stringify({ kind: "FORMAL_NATIVE_REFUND_SERVER_REVIEW", reference: meta.reference, reviewSha256: meta.reviewSha256,
    database: first!.database, runtimeUser: first!.runtimeUser, merchantIdentityId: first!.merchantIdentityId, merchantNo: first!.merchantNo,
    acceptedProfiles: accepted, historicalInitialAdmissions: history });
  const cap = Object.freeze({ kind: "FORMAL_NATIVE_REFUND_ADMISSION" as const }); admissions.set(cap, Object.freeze({ reference: meta.reference, sha256: sha(canonical), canonical,
    database: first!.database, runtimeUser: first!.runtimeUser, merchantIdentityId: first!.merchantIdentityId, merchantNo: first!.merchantNo,
    acceptedProfiles: Object.freeze(accepted), historicalInitialAdmissions: history })); return cap;
}
export function readFormalRefundAdmission(cap: FormalRefundAdmission): AdmissionView { return admissions.get(cap) ?? fail("REFUND_FORMAL_ADMISSION_UNAVAILABLE"); }
export function assertFormalRefundProfile(cap: FormalRefundAdmission, profile: BoundRefundProfile, operation: RefundOperation): AdmissionView {
  const a = readFormalRefundAdmission(cap), p = describeRefundProfile(profile, operation);
  if (p.purpose !== "MERCHANT_REFUND" || p.database !== a.database || p.runtimeUser !== a.runtimeUser || p.merchantIdentityId !== a.merchantIdentityId || p.merchantNo !== a.merchantNo
    || !a.acceptedProfiles.some(v => v.operation === operation && v.profileId === p.profileId && v.profileSha256 === p.profileSha256 && v.keyVersionRef === p.keyVersionRef)) fail("REFUND_PROFILE_NOT_ADMITTED"); return a;
}
export function assertRefundStart(cap: FormalRefundAdmission) { const a = readFormalRefundAdmission(cap); for (const o of ["SUBMIT", "QUERY", "NOTIFY"]) if (!a.acceptedProfiles.some(v => v.operation === o)) fail("REFUND_OPERATION_NOT_ACCEPTED"); }
export function assertInitialRefundAdmission(cap: FormalRefundAdmission, reference: string, hash: string) {
  const a = readFormalRefundAdmission(cap); if (!(reference === a.reference && hash === a.sha256) && !a.historicalInitialAdmissions.some(v => v.reference === reference && v.sha256 === hash)) fail("REFUND_INITIAL_ADMISSION_MISMATCH");
}
function checkBinding(p: Profile, operation: RefundOperation, b: RefundBinding) {
  if (p.operation !== operation || b.merchantNo !== p.merchantNo || b.merchantIdentityId !== p.merchantIdentityId || b.currency !== "CNY") fail("REFUND_BINDING_MISMATCH");
  if (operation === "SUBMIT" && (b.profileId !== p.profileId || b.initialProfileSha256 !== p.sha256 || b.keyVersionRef !== p.keyVersionRef || b.notifyUrl !== p.notifyUrl || b.fundsAccount !== p.fundsAccount)) fail("REFUND_INITIAL_PROFILE_MISMATCH");
}
export function assertRefundBinding(profile:BoundRefundProfile,operation:RefundOperation,binding:RefundBinding):void {
  checkBinding(pget(profile),operation,binding); validateJoinpayRefundRequestInput(binding);
}
export type RefundOutbound = Readonly<{ operation: "SUBMIT" | "QUERY"; requestSha256: string }>;
type Outbound = { endpoint: string; body: string; purpose: RefundServerProfile["purpose"] };
const outbound = new WeakMap<object, Outbound>();
export function produceRefundRequest(profile: BoundRefundProfile, operation: "SUBMIT" | "QUERY", binding: RefundBinding, key: string): RefundOutbound {
  if (operation !== "SUBMIT" && operation !== "QUERY") fail("REFUND_OUTBOUND_OPERATION_INVALID"); const p = pget(profile); assertRefundBinding(profile, operation, binding);
  const form = operation === "SUBMIT" ? computeJoinpayRefundRequest({ ...binding, notifyUrl: binding.notifyUrl, reason: binding.reason }, key) : computeJoinpayRefundQuery(binding, key);
  const body = new URLSearchParams(form.fields.map(([name, value]) => [name, value])).toString();
  const request = Object.freeze({ operation, requestSha256: sha(body) }); outbound.set(request, Object.freeze({ endpoint: operation === "SUBMIT" ? "https://trade.joinpay.com/tradeRt/refund" : "https://trade.joinpay.com/tradeRt/queryRefund", body, purpose: p.purpose })); return request;
}
export function readRefundOutbound(request: RefundOutbound): Readonly<Outbound> { return outbound.get(request) ?? fail("REFUND_OUTBOUND_NOT_BOUND"); }
export function inspectRefundProfile(profile: BoundRefundProfile, operation: RefundOperation, body: string | Uint8Array, binding: RefundBinding, key: string): RefundNeutralResult {
  const p = pget(profile); checkBinding(p, operation, binding);
  return computeJoinpayRefundResponse(operation === "SUBMIT" ? "REFUND_SYNC" : operation === "QUERY" ? "REFUND_QUERY" : "REFUND_NOTIFY", body, { binding, key, leaseCurrent: true });
}
export function refundFailureMayRelease(profile: BoundRefundProfile, result: RefundNeutralResult): boolean {
  const f = pget(profile).rules.failureNoExecution; return result.result === "CHANNEL_REPORTED_FAILED" && result.signature === "MATCH" && f.accepted && f.codes.includes(result.channelCode ?? "");
}
export function refundWayAccepted(profile: BoundRefundProfile, value?: string): boolean { return value === "ORIGINAL" || value === undefined && pget(profile).rules.refundWay === "ORIGINAL_OR_MISSING_REVIEWED"; }
export function refundCompleteTimeToUtc(profile: BoundRefundProfile, raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return fail("REFUND_TIME_UNAVAILABLE");
  const [year, month, day, hour, minute, second] = raw.match(/\d+/g)!.map(Number), utc = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  if (new Date(utc).toISOString().slice(0, 19) !== raw.replace(" ", "T")) return fail("REFUND_TIME_UNAVAILABLE");
  return new Date(utc - pget(profile).rules.utcOffsetMinutes * 60000).toISOString();
}
