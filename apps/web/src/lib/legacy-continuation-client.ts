import { requestOrderJson, requestOrderWrite } from "./order-client.ts";

export type LegacyCommandName = "propose" | "confirm" | "reject" | "hold" | "release" | "confiscate";
export type LegacyQuantitiesInput = Record<"expendHaff" | "barrett" | "bullet" | "awm" | "armor" | "helmet" | "coffee" | "card", string | null>;
export type LegacyContinuation = {
  schema: "legacy-continuation.v1"; availability: "KNOWN" | "NOT_IMPORTED" | "ISOLATED";
  revision: string | null; evidenceId: string | null; stage: string | null; isSettle: string | null;
  amounts: Record<string, { cents: string; yuan: string } | null>; quantities: LegacyQuantitiesInput | null;
  capabilities: string[]; commandFingerprints: Record<string, string>; reasons: string[];
  duties: Array<{ id: string; kind: string; amountCents: string; currency: "CNY"; status: string; maturityAt: string | null; sourceStatus: string | null; revision: string; settledBy: string | null }>;
  channelState: "UNKNOWN";
};
export type LegacyProposal = { revision: string | null; inputEvidenceId: string; proposalFingerprint: string; previewAmounts: Record<string, string | null>; proposalAmounts: Record<string, string | null> };
export type LegacyReceipt = { state: "UNKNOWN" } | { state: "KNOWN_SUCCESS" | "KNOWN_REJECTED"; status: number; fingerprint: string; receipt: unknown };
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, cents = /^(0|[1-9]\d{0,23})$/, digest = /^[a-f0-9]{64}$/;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function base(orderId: string) { if (!/^legacy_order_[a-f0-9]{40}$/.test(orderId)) throw new Error("订单标识无效"); return "/api/orders/legacy/" + encodeURIComponent(orderId) + "/continuation"; }
function validateResult(orderId:string,kind:LegacyCommandName,input:Record<string,unknown>,result:unknown) {
  if (!record(result) || result.orderId!==orderId || result.command!==kind || result.inputEvidenceId!==input.inputEvidenceId || typeof result.revision!=="string" || !/^[1-9]\d{0,17}$/.test(result.revision) || typeof result.versionId!=="string" || !id.test(result.versionId) || typeof result.resultEvidenceId!=="string" || !id.test(result.resultEvidenceId) || !["3","8","9","4"].includes(String(result.stage)) || result.channelState!=="UNKNOWN") throw new Error("请求可能已受理，请保留原请求核对结果");
  return result;
}
export function parseLegacyContinuation(value: unknown): LegacyContinuation {
  if (!record(value) || value.schema !== "legacy-continuation.v1" || !["KNOWN", "NOT_IMPORTED", "ISOLATED"].includes(String(value.availability)) || value.channelState !== "UNKNOWN"
    || value.revision !== null && (typeof value.revision !== "string" || !/^[1-9]\d{0,17}$/.test(value.revision)) || value.evidenceId !== null && (typeof value.evidenceId !== "string" || !id.test(value.evidenceId))
    || !Array.isArray(value.capabilities) || value.capabilities.some(c => typeof c !== "string" || !["preview", "propose", "confirm", "reject", "hold", "release", "confiscate"].includes(c))
    || !Array.isArray(value.reasons) || value.reasons.some(r => typeof r !== "string" || r.length > 100) || !record(value.commandFingerprints) || Object.values(value.commandFingerprints).some(v => typeof v !== "string" || !digest.test(v))
    || !record(value.amounts) || !Array.isArray(value.duties) || value.duties.length > 200) throw new Error("订单续办信息暂不可用");
  if (value.stage !== null && !["3", "8", "9", "4"].includes(String(value.stage)) || value.isSettle !== null && !["0", "2", "3"].includes(String(value.isSettle))) throw new Error("订单状态暂不可用");
  const amounts: LegacyContinuation["amounts"] = {};
  for (const [key, amount] of Object.entries(value.amounts)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) throw new Error("订单金额暂不可用");
    if (amount === null) { amounts[key] = null; continue; }
    if (!record(amount) || typeof amount.cents !== "string" || !cents.test(amount.cents) || typeof amount.yuan !== "string" || !/^(0|[1-9]\d{0,23})\.\d{2}$/.test(amount.yuan)) throw new Error("订单金额暂不可用");
    if (BigInt(amount.yuan.replace(".", "")) !== BigInt(amount.cents)) throw new Error("订单金额暂不可用");
    amounts[key] = { cents: amount.cents, yuan: amount.yuan };
  }
  const duties = value.duties.map(d => {
    if (!record(d) || typeof d.id !== "string" || !id.test(d.id) || !["RENTER_REFUND", "OWNER_CREDIT", "COMMISSION", "DEPOSIT_COMPENSATION"].includes(String(d.kind)) || typeof d.amountCents !== "string" || !cents.test(d.amountCents) || d.currency !== "CNY" || !["PENDING", "MATURED", "SETTLED", "VOID"].includes(String(d.status)) || typeof d.revision !== "string" || !/^[1-9]\d{0,17}$/.test(d.revision)
      || d.maturityAt !== null && (typeof d.maturityAt !== "string" || !Number.isFinite(Date.parse(d.maturityAt))) || d.sourceStatus !== null && typeof d.sourceStatus !== "string" || ![null, "FINANCE", "LEGACY_RECORDS"].includes(d.settledBy as string | null)) throw new Error("结算责任暂不可用");
    return { id: d.id, kind: String(d.kind), amountCents: d.amountCents, currency: "CNY" as const, status: String(d.status), maturityAt: d.maturityAt as string | null, sourceStatus: d.sourceStatus as string | null, revision: d.revision, settledBy: d.settledBy as string | null };
  });
  const quantities = value.quantities === null ? null : parseLegacyQuantitiesInput(value.quantities);
  return { schema: "legacy-continuation.v1", availability: value.availability as LegacyContinuation["availability"], revision: value.revision as string | null, evidenceId: value.evidenceId as string | null, stage: value.stage as string | null, isSettle: value.isSettle as string | null,
    amounts, quantities, capabilities: [...value.capabilities] as string[], commandFingerprints: { ...value.commandFingerprints } as Record<string, string>, reasons: [...value.reasons] as string[], duties, channelState: "UNKNOWN" };
}
export function parseLegacyQuantitiesInput(value: unknown): LegacyQuantitiesInput {
  if (!record(value)) throw new Error("消耗数量不完整");
  if (Object.keys(value).some(key => !["expendHaff", "barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"].includes(key))) throw new Error("消耗数量包含未知字段");
  const result: Record<string, string | null> = {};
  for (const key of ["expendHaff", "barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"]) {
    const v = value[key];
    if (v !== null && (typeof v !== "string" || !/^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(v))) throw new Error("请填写有效的消耗数量");
    result[key] = v as string | null;
  }
  return result as LegacyQuantitiesInput;
}
export async function legacyIntentFingerprint(orderId: string, kind: LegacyCommandName, body: Record<string, unknown>): Promise<string> {
  const input = { kind, expectedRevision: body.expectedRevision, inputEvidenceId: body.inputEvidenceId, planFingerprint: body.planFingerprint, ...(kind === "propose" ? { quantities: parseLegacyQuantitiesInput(body.quantities) } : {}) };
  const bytes = new TextEncoder().encode(JSON.stringify(["order.legacy.continuation." + kind, orderId, input]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(x => x.toString(16).padStart(2, "0")).join("");
}
export const legacyContinuationApi = {
  async read(orderId: string, signal?: AbortSignal) { const body = await requestOrderJson<{ continuation: unknown }>(base(orderId), { signal }); return parseLegacyContinuation(body.continuation); },
  async preview(orderId: string, quantities: LegacyQuantitiesInput, signal?: AbortSignal): Promise<LegacyProposal> {
    const body = await requestOrderWrite<LegacyProposal>(base(orderId) + "/preview", { body: { quantities }, signal });
    if (!body || typeof body.inputEvidenceId !== "string" || !id.test(body.inputEvidenceId) || !digest.test(body.proposalFingerprint) || !record(body.proposalAmounts) || !record(body.previewAmounts)
      || body.revision !== null && (typeof body.revision !== "string" || !/^[1-9]\d{0,17}$/.test(body.revision))
      || [...Object.values(body.proposalAmounts), ...Object.values(body.previewAmounts)].some(v => v !== null && (typeof v !== "string" || !/^(0|[1-9]\d{0,23})(?:\.\d{1,8})?$/.test(v)))) throw new Error("预估结果暂不可用");
    return body;
  },
  async write(orderId: string, kind: LegacyCommandName, body: Record<string, unknown>, key: string, signal?: AbortSignal) {
    const result = await requestOrderWrite<unknown>(base(orderId) + "/" + kind, { body, key, signal });
    return validateResult(orderId,kind,body,result);
  },
  async receipt(orderId: string, kind: LegacyCommandName, key: string, originalBody: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyReceipt> {
    const body = await requestOrderJson<LegacyReceipt>(base(orderId) + "/receipt?" + new URLSearchParams({ command: kind, key }), { signal });
    if (!body || !["UNKNOWN", "KNOWN_SUCCESS", "KNOWN_REJECTED"].includes(body.state)) throw new Error("原请求结果暂不可用");
    if (body.state !== "UNKNOWN" && (body.fingerprint !== await legacyIntentFingerprint(orderId, kind, originalBody) || !Number.isInteger(body.status) || body.state === "KNOWN_SUCCESS" && (body.status < 200 || body.status >= 300) || body.state === "KNOWN_REJECTED" && ![400, 409].includes(body.status))) throw new Error("原请求信息不一致，请保留并联系受权客服核对");
    if(body.state==="KNOWN_SUCCESS")validateResult(orderId,kind,originalBody,body.receipt);
    if(body.state==="KNOWN_REJECTED" && (!record(body.receipt) || body.receipt.outcome!=="REJECTED"))throw new Error("原请求结果暂不可用");
    return body;
  },
};
