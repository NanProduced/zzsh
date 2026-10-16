import { adminRequest } from "../api";
import { withSupplyWriteLock } from "./supply-write-lock";

export type LegacyAdminAction = "hold" | "release" | "confiscate" | "mature" | "void";
export type LegacyAdminDuty = { id: string; kind: string; amountCents: string; currency: "CNY"; status: string; maturityAt: string | null; revision: string; settledBy: string | null; sourceStatus: string | null };
export type LegacyAdminView = { schema: "legacy-continuation.v1"; availability: "KNOWN" | "NOT_IMPORTED" | "ISOLATED"; revision: string | null; evidenceId: string | null; stage: string | null; isSettle: string | null; amounts: Record<string, { cents: string; yuan: string } | null>; capabilities: string[]; commandFingerprints: Record<string, string>; duties: LegacyAdminDuty[]; reasons: string[]; channelState: "UNKNOWN" };
export type LegacyAdminIntent = { schema: 1; subject: string; orderId: string; command: LegacyAdminAction; dutyId: string | null; key: string; body: Record<string, unknown>; at: string };
export type LegacyAdminReceipt = { state: "UNKNOWN" } | { state: "KNOWN_SUCCESS" | "KNOWN_REJECTED"; status: number; fingerprint: string; receipt: unknown };
export type LegacyAdminPending = { state: "NONE" | "UNREADABLE"; intent: null } | { state: "VALID"; intent: LegacyAdminIntent };
const PREFIX = "zzsh.admin.legacy-continuation.v1:", TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, DIGEST = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Login renewal must not hide the same actor's unresolved original request.
export function legacyAdminSubject(actorId: string, orderId: string) { return actorId + "|" + orderId; }
function base(orderId: string) { if (!/^legacy_order_[a-f0-9]{40}$/.test(orderId)) throw new Error("订单引用无效"); return "/orders/legacy/" + encodeURIComponent(orderId) + "/continuation"; }
function storage(): Storage | null { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } }
function key(subject: string) { return PREFIX + encodeURIComponent(subject); }
function validateResult(intent:LegacyAdminIntent,result:unknown) {
  if(!object(result) || typeof result.revision!=="string" || !/^[1-9]\d{0,17}$/.test(result.revision))throw new Error("原请求结果尚待核对");
  if(intent.dutyId ? result.dutyId!==intent.dutyId || result.status!==(intent.command==="mature"?"MATURED":"VOID")
    : result.orderId!==intent.orderId || result.command!==intent.command || result.inputEvidenceId!==intent.body.inputEvidenceId || typeof result.versionId!=="string" || !TOKEN.test(result.versionId) || typeof result.resultEvidenceId!=="string" || !TOKEN.test(result.resultEvidenceId) || !["3","8","9","4"].includes(String(result.stage)) || result.channelState!=="UNKNOWN")throw new Error("原请求结果尚待核对");
  return result;
}
function validIntent(value: unknown, subject: string, orderId: string): value is LegacyAdminIntent {
  if (!object(value) || value.schema !== 1 || value.subject !== subject || value.orderId !== orderId || !["hold", "release", "confiscate", "mature", "void"].includes(String(value.command)) || typeof value.key !== "string" || !/^legacy_[a-f0-9]{32}$/.test(value.key) || !object(value.body) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) return false;
  if (Object.keys(value).some(x => !["schema", "subject", "orderId", "command", "dutyId", "key", "body", "at"].includes(x))) return false;
  const duty = value.command === "mature" || value.command === "void", body = value.body;
  if (duty ? typeof value.dutyId !== "string" || !TOKEN.test(value.dutyId) : value.dutyId !== null) return false;
  if (body.expectedRevision !== null && (typeof body.expectedRevision !== "string" || !/^[1-9]\d{0,17}$/.test(body.expectedRevision))) return false;
  if (duty && body.expectedRevision === null) return false;
  const fields = duty ? ["expectedRevision", "sourceFactAuditId", "reason"] : ["expectedRevision", "inputEvidenceId", "planFingerprint"];
  if (Object.keys(body).some(x => !fields.includes(x))) return false;
  if (!duty && (typeof body.inputEvidenceId !== "string" || !TOKEN.test(body.inputEvidenceId) || typeof body.planFingerprint !== "string" || !DIGEST.test(body.planFingerprint))) return false;
  if (body.sourceFactAuditId !== undefined && (typeof body.sourceFactAuditId !== "string" || !TOKEN.test(body.sourceFactAuditId)) || body.reason !== undefined && (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500)) return false;
  if (value.command === "void" && (typeof body.sourceFactAuditId !== "string" || !TOKEN.test(body.sourceFactAuditId) || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500)) return false;
  return true;
}
export function inspectLegacyAdminIntent(subject: string, orderId: string): LegacyAdminPending {
  try {
    const target = storage(); if (!target) return { state: "UNREADABLE", intent: null };
    const raw = target.getItem(key(subject)); if (raw === null) return { state: "NONE", intent: null };
    const parsed: unknown = JSON.parse(raw);
    return validIntent(parsed, subject, orderId) ? { state: "VALID", intent: parsed } : { state: "UNREADABLE", intent: null };
  } catch { return { state: "UNREADABLE", intent: null }; }
}
export async function retainLegacyAdminIntent(subject: string, orderId: string, command: LegacyAdminAction, body: Record<string, unknown>, dutyId: string | null = null): Promise<LegacyAdminIntent> {
  return withSupplyWriteLock(key(subject), async () => {
    if (inspectLegacyAdminIntent(subject, orderId).state !== "NONE") throw new Error("原请求尚未核清，不能覆盖");
    const nonce = globalThis.crypto?.randomUUID?.(); if (!nonce) throw new Error("无法保全请求标识，尚未提交");
    const intent: LegacyAdminIntent = { schema: 1, subject, orderId, command, dutyId, key: "legacy_" + nonce.replaceAll("-", ""), body: structuredClone(body), at: new Date().toISOString() };
    if (!validIntent(intent, subject, orderId)) throw new Error("办理请求信息不完整");
    const target = storage(); if (!target) throw new Error("无法保全原请求，尚未提交");
    target.setItem(key(subject), JSON.stringify(intent));
    const reread = inspectLegacyAdminIntent(subject, orderId);
    if (reread.state !== "VALID" || reread.intent.key !== intent.key) throw new Error("无法保全原请求，尚未提交");
    return intent;
  });
}
export function clearLegacyAdminIntent(intent: LegacyAdminIntent) {
  const current = inspectLegacyAdminIntent(intent.subject, intent.orderId);
  if (current.state !== "VALID" || current.intent.key !== intent.key) return;
  storage()?.removeItem(key(intent.subject));
}
export function parseLegacyAdminView(value: unknown): LegacyAdminView {
  if (!object(value) || value.schema !== "legacy-continuation.v1" || !["KNOWN", "NOT_IMPORTED", "ISOLATED"].includes(String(value.availability)) || value.channelState !== "UNKNOWN" || !object(value.amounts) || !Array.isArray(value.capabilities) || value.capabilities.some(x => typeof x !== "string" || !["hold", "release", "confiscate"].includes(x)) || !object(value.commandFingerprints) || Object.values(value.commandFingerprints).some(x => typeof x !== "string" || !DIGEST.test(x)) || !Array.isArray(value.duties) || value.duties.length > 200 || !Array.isArray(value.reasons) || value.reasons.some(x => typeof x !== "string" || x.length > 100)) throw new Error("旧单办理资料暂不可用");
  if (value.stage !== null && !["3", "8", "9", "4"].includes(String(value.stage)) || value.isSettle !== null && !["0", "2", "3"].includes(String(value.isSettle)) || value.revision !== null && (typeof value.revision !== "string" || !/^[1-9]\d{0,17}$/.test(value.revision)) || value.evidenceId !== null && (typeof value.evidenceId !== "string" || !TOKEN.test(value.evidenceId))) throw new Error("旧单版本暂不可用");
  const amounts: LegacyAdminView["amounts"] = {};
  for (const [k, amount] of Object.entries(value.amounts)) {
    if (amount === null) { amounts[k] = null; continue; }
    if (!object(amount) || typeof amount.cents !== "string" || !/^(0|[1-9]\d{0,23})$/.test(amount.cents) || typeof amount.yuan !== "string" || !/^(0|[1-9]\d{0,23})\.\d{2}$/.test(amount.yuan) || BigInt(amount.yuan.replace(".", "")) !== BigInt(amount.cents)) throw new Error("旧单金额暂不可用");
    amounts[k] = { cents: amount.cents, yuan: amount.yuan };
  }
  const duties = value.duties.map(d => {
    if (!object(d) || typeof d.id !== "string" || !TOKEN.test(d.id) || !["RENTER_REFUND", "OWNER_CREDIT", "COMMISSION", "DEPOSIT_COMPENSATION"].includes(String(d.kind)) || typeof d.amountCents !== "string" || !/^(0|[1-9]\d{0,23})$/.test(d.amountCents) || d.currency !== "CNY" || !["PENDING", "MATURED", "SETTLED", "VOID"].includes(String(d.status)) || typeof d.revision !== "string" || !/^[1-9]\d{0,17}$/.test(d.revision) || d.maturityAt !== null && (typeof d.maturityAt !== "string" || !Number.isFinite(Date.parse(d.maturityAt))) || ![null, "FINANCE", "LEGACY_RECORDS"].includes(d.settledBy as string | null)) throw new Error("经济责任资料暂不可用");
    return { id: d.id, kind: String(d.kind), amountCents: d.amountCents, currency: "CNY" as const, status: String(d.status), maturityAt: d.maturityAt as string | null, revision: d.revision, settledBy: d.settledBy as string | null, sourceStatus: typeof d.sourceStatus === "string" ? d.sourceStatus : null };
  });
  return { schema: "legacy-continuation.v1", availability: value.availability as LegacyAdminView["availability"], revision: value.revision as string | null, evidenceId: value.evidenceId as string | null, stage: value.stage as string | null, isSettle: value.isSettle as string | null, amounts, duties, capabilities: [...value.capabilities] as string[], commandFingerprints: { ...value.commandFingerprints } as Record<string, string>, reasons: [...value.reasons] as string[], channelState: "UNKNOWN" };
}
export async function readLegacyAdminContinuation(orderId: string, signal?: AbortSignal) {
  const response = await adminRequest<{ continuation: unknown }>(base(orderId), undefined, "GET", {}, signal);
  return parseLegacyAdminView(response.continuation);
}
export async function sendLegacyAdminIntent(intent: LegacyAdminIntent) {
  if (!validIntent(intent, intent.subject, intent.orderId)) throw new Error("原请求不完整，禁止提交");
  const path = base(intent.orderId) + (intent.dutyId ? "/duties/" + encodeURIComponent(intent.dutyId) + "/" + intent.command : "/" + intent.command);
  const result = await adminRequest<unknown>(path, intent.body, "POST", { "idempotency-key": intent.key });
  return validateResult(intent,result);
}
export async function recoverLegacyAdminIntent(intent: LegacyAdminIntent): Promise<LegacyAdminReceipt> {
  const params = new URLSearchParams({ command: intent.command, key: intent.key }); if (intent.dutyId) params.set("dutyId", intent.dutyId);
  const result = await adminRequest<LegacyAdminReceipt>(base(intent.orderId) + "/receipt?" + params);
  if (!result || !["UNKNOWN", "KNOWN_SUCCESS", "KNOWN_REJECTED"].includes(result.state)) throw new Error("原请求结果尚待核对");
  if (result.state === "UNKNOWN") return result;
  const body = intent.body, operation = intent.dutyId ? "order.legacy.duty." + intent.command : "order.legacy.continuation." + intent.command;
  const input = intent.dutyId ? { dutyId: intent.dutyId, kind: intent.command, expectedRevision: body.expectedRevision, sourceFactAuditId: body.sourceFactAuditId, reason: body.reason } : { kind: intent.command, expectedRevision: body.expectedRevision, inputEvidenceId: body.inputEvidenceId, planFingerprint: body.planFingerprint };
  const bytes = new TextEncoder().encode(JSON.stringify([operation, intent.dutyId ?? intent.orderId, input]));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(x => x.toString(16).padStart(2, "0")).join("");
  if (result.fingerprint !== fingerprint || result.state === "KNOWN_SUCCESS" && !(result.status >= 200 && result.status < 300) || result.state === "KNOWN_REJECTED" && ![400, 409].includes(result.status)) throw new Error("原请求绑定不一致，禁止覆盖");
  if(result.state==="KNOWN_SUCCESS")validateResult(intent,result.receipt);
  if(result.state==="KNOWN_REJECTED" && (!object(result.receipt) || result.receipt.outcome!=="REJECTED"))throw new Error("原请求结果尚待核对");
  return result;
}
