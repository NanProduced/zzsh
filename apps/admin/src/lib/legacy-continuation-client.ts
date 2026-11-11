import { adminRequest } from "../api";
import { formatExactYuan } from "@zzsh/ui/display-money";
import { withSupplyWriteLock } from "./supply-write-lock";

export type LegacyAdminAction = "propose" | "confirm" | "reject" | "hold" | "release" | "confiscate" | "support_cancel" | "verify-basis" | "mature" | "void" | "owner-credit" | "commission-credit" | "refund-case" | "demo-refund";
export type LegacyEndReason = "NORMAL" | "TENANT_VOLUNTARY_EARLY" | "OWNER_OR_ACCOUNT_EARLY";
export type LegacyDemoScope = "LOCAL_DEMO_SIMULATED" | "ECS_TEST_SIMULATED";
export type LegacyDemoRefund = {contractVersion:'demo-legacy-refund.v1';scope:LegacyDemoScope;orderId:string;dutyId:string;operationId:string;amountCents:string;paidCents:string;assumption:'SIMULATION_ASSUME_NO_PRIOR_REFUND';simulatedAt:string;state:'SIMULATED';bankArrival:'UNKNOWN'};
export type LegacyAdminQuantities = Record<"expendHaff" | "barrett" | "bullet" | "awm" | "armor" | "helmet" | "coffee" | "card", string>;
export type LegacyRecordedQuantities = { [K in keyof LegacyAdminQuantities]: string | null };
export type LegacyAdminProposal = { revision: string | null; inputEvidenceId: string; proposalFingerprint: string; settlementKind: "EARLY" | "NORMAL"; proposalAmounts: Record<string, string | null> };
export type LegacyAdminDuty = { id: string; kind: string; amountCents: string; currency: "CNY"; status: string; maturityAt: string | null; revision: string; settledBy: string | null; sourceStatus: string | null; financeVerified:boolean; beneficiary: {userId:string;name:string|null}|null };
export type LegacyAdminView = { schema: "legacy-continuation.v1"; availability: "KNOWN" | "NOT_IMPORTED" | "ISOLATED"; revision: string | null; evidenceId: string | null; stage: string | null; isSettle: string | null; refundDueAt: string | null; lastBasisId: string | null; amounts: Record<string, { cents: string; yuan: string } | null>; quantities: LegacyRecordedQuantities | null; confirmationAmounts: { ownerNet: { cents: string; yuan: string }; refundNet: { cents: string; yuan: string } } | null; capabilities: string[]; commandFingerprints: Record<string, string>; duties: LegacyAdminDuty[]; reasons: string[]; channelState: "UNKNOWN" };
export type LegacyAdminIntent = { schema: 1; subject: string; orderId: string; command: LegacyAdminAction; dutyId: string | null; key: string; body: Record<string, unknown>; at: string;demoScope?:LegacyDemoScope };
export type LegacyAdminReceipt = { state: "UNKNOWN" } | { state: "KNOWN_SUCCESS" | "KNOWN_REJECTED"; status: number; fingerprint: string; receipt: unknown };
export type LegacyAdminPending = { state: "NONE" | "UNREADABLE"; intent: null } | { state: "VALID"; intent: LegacyAdminIntent };
const PREFIX = "zzsh.admin.legacy-continuation.v1:", TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, DIGEST = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Login renewal must not hide the same actor's unresolved original request.
export function legacyAdminSubject(actorId: string, orderId: string) { return actorId + "|" + orderId; }
function base(orderId: string) { if (!/^legacy_order_[a-f0-9]{40}$/.test(orderId)) throw new Error("订单引用无效"); return "/orders/legacy/" + encodeURIComponent(orderId) + "/continuation"; }
function storage(): Storage | null { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } }
function key(subject: string) { return PREFIX + encodeURIComponent(subject); }
function demoRefundResult(value:unknown,orderId:string,dutyId:string,scope:LegacyDemoScope):LegacyDemoRefund {
  if(!object(value)||value.contractVersion!=='demo-legacy-refund.v1'||value.scope!==scope||value.orderId!==orderId||value.dutyId!==dutyId
    ||typeof value.operationId!=='string'||!TOKEN.test(value.operationId)||typeof value.amountCents!=='string'||!/^[1-9]\d{0,23}$/.test(value.amountCents)
    ||typeof value.paidCents!=='string'||!/^[1-9]\d{0,23}$/.test(value.paidCents)||BigInt(value.amountCents)>BigInt(value.paidCents)
    ||value.assumption!=='SIMULATION_ASSUME_NO_PRIOR_REFUND'||typeof value.simulatedAt!=='string'||!Number.isFinite(Date.parse(value.simulatedAt))
    ||value.state!=='SIMULATED'||value.bankArrival!=='UNKNOWN')throw new Error('模拟退款结果尚待核对');
  return value as LegacyDemoRefund;
}
export async function readLegacyAdminDemoRefund(orderId:string,dutyId:string,signal?:AbortSignal){
  if(!TOKEN.test(dutyId))throw new Error('退款责任资料暂不可用');
  const value=await adminRequest<unknown>(base(orderId)+'/duties/'+encodeURIComponent(dutyId)+'/demo-refund',undefined,'GET',{},signal);
  if(!object(value)||!['LOCAL_DEMO_SIMULATED','ECS_TEST_SIMULATED'].includes(String(value.scope))||value.bankArrival!=='UNKNOWN'||!Object.hasOwn(value,'receipt')
    ||value.headRevision!==null&&(typeof value.headRevision!=='string'||!/^(0|[1-9]\d{0,17})$/.test(value.headRevision))
    ||typeof value.dutyRevision!=='string'||!/^[1-9]\d{0,17}$/.test(value.dutyRevision)||typeof value.canSubmit!=='boolean'
    ||value.reason!==null&&(typeof value.reason!=='string'||value.reason.length>120)||value.canSubmit&&(value.headRevision===null||value.reason!==null||value.receipt!==null))throw new Error('模拟退款资料暂不可用');
  const scope=value.scope as LegacyDemoScope;return {scope,headRevision:value.headRevision as string|null,dutyRevision:value.dutyRevision,canSubmit:value.canSubmit,reason:value.reason as string|null,
    receipt:value.receipt===null?null:demoRefundResult(value.receipt,orderId,dutyId,scope)};
}
function validateResult(intent:LegacyAdminIntent,result:unknown) {
  if(intent.command==='demo-refund')return demoRefundResult(result,intent.orderId,intent.dutyId!,intent.demoScope!);
  if(intent.command==='verify-basis') {
    if(!object(result)||result.orderId!==intent.orderId||typeof result.basisId!=="string"||!TOKEN.test(result.basisId)||typeof result.basisRevision!=="string"||!/^[1-9]\d{0,17}$/.test(result.basisRevision)||result.state!=="VERIFIED")throw new Error("核实结果尚待确认");
    return result;
  }
  if(intent.command==='refund-case'){
    if(!object(result)||result.orderId!==intent.orderId||result.dutyId!==intent.dutyId||typeof result.caseId!=='string'||!TOKEN.test(result.caseId)
      || typeof result.dutyCents!=='string'||!/^(0|[1-9]\d{0,23})$/.test(result.dutyCents)||typeof result.priorAppliedCents!=='string'
      || result.priorAppliedCents!==intent.body.priorAppliedToDutyCents||typeof result.amountCents!=='string'||!/^(0|[1-9]\d{0,23})$/.test(result.amountCents)
      || BigInt(result.amountCents)+BigInt(result.priorAppliedCents)!==BigInt(result.dutyCents)||result.channelResultAtCreation!=='NOT_SUBMITTED'
      || (result.amountCents==='0' ? result.intentId!==null || result.refundOrderNo!==null : typeof result.intentId!=='string'||!TOKEN.test(result.intentId)
        || typeof result.refundOrderNo!=='string'||!/^LR[a-f0-9]{28}$/.test(result.refundOrderNo)))throw new Error('原退款请求结果尚待核对');
    return result;
  }
  if(!object(result) || typeof result.revision!=="string" || !/^[1-9]\d{0,17}$/.test(result.revision))throw new Error("原请求结果尚待核对");
  if(intent.dutyId ? result.dutyId!==intent.dutyId || result.status!==(intent.command==="mature"?"MATURED":["owner-credit","commission-credit"].includes(intent.command)?"SETTLED":"VOID")
    || ["owner-credit","commission-credit"].includes(intent.command) && (result.orderId!==intent.orderId || result.settledBy!=="FINANCE" || result.channelArrival!=="UNKNOWN" || typeof result.amountCents!=="string" || !/^(0|[1-9]\d{0,23})$/.test(result.amountCents)
      || !object(result.reference) || !["LEDGER_ENTRY","FINANCE_EVENT"].includes(String(result.reference.type)) || typeof result.reference.id!=="string" || !TOKEN.test(result.reference.id)
      || typeof result.reference.digest!=="string" || !DIGEST.test(result.reference.digest))
    : result.orderId!==intent.orderId || result.command!==intent.command || result.inputEvidenceId!==intent.body.inputEvidenceId || typeof result.versionId!=="string" || !TOKEN.test(result.versionId) || typeof result.resultEvidenceId!=="string" || !TOKEN.test(result.resultEvidenceId) || !["3","8","9","4","5"].includes(String(result.stage)) || result.channelState!=="UNKNOWN")throw new Error("原请求结果尚待核对");
  if (intent.command === "propose" && result.stage !== (intent.body.onBehalf === "renter" ? "8" : "9") || intent.command === "confirm" && result.stage !== "4" || intent.command === "reject" && result.stage !== "3" || intent.command === "support_cancel" && result.stage !== "5" || intent.command !== "support_cancel" && result.stage === "5") throw new Error("原请求结果尚待核对");
  return result;
}
function validIntent(value: unknown, subject: string, orderId: string): value is LegacyAdminIntent {
  if (!object(value) || value.schema !== 1 || value.subject !== subject || value.orderId !== orderId || !["propose", "confirm", "reject", "hold", "release", "confiscate", "support_cancel", "verify-basis", "mature", "void", "owner-credit", "commission-credit", "refund-case", "demo-refund"].includes(String(value.command)) || typeof value.key !== "string" || !/^legacy_[a-f0-9]{32}$/.test(value.key) || !object(value.body) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) return false;
  if (Object.keys(value).some(x => !["schema", "subject", "orderId", "command", "dutyId", "key", "body", "at", "demoScope"].includes(x))) return false;
  if(value.command==='demo-refund'?!['LOCAL_DEMO_SIMULATED','ECS_TEST_SIMULATED'].includes(String(value.demoScope)):value.demoScope!==undefined)return false;
  const duty = value.command === "mature" || value.command === "void" || value.command === "owner-credit" || value.command === "commission-credit" || value.command==='refund-case'||value.command==='demo-refund', body = value.body;
  if (duty ? typeof value.dutyId !== "string" || !TOKEN.test(value.dutyId) : value.dutyId !== null) return false;
  if(value.command==='demo-refund')return Object.keys(body).sort().join()===['assumption','expectedDutyRevision','expectedHeadRevision','reason'].sort().join()
    &&typeof body.expectedDutyRevision==='string'&&/^[1-9]\d{0,17}$/.test(body.expectedDutyRevision)
    &&typeof body.expectedHeadRevision==='string'&&/^(0|[1-9]\d{0,17})$/.test(body.expectedHeadRevision)
    &&body.assumption==='SIMULATION_ASSUME_NO_PRIOR_REFUND'&&typeof body.reason==='string'&&[...body.reason.trim()].length>=3&&body.reason.length<=500;
  if(value.command==='refund-case'){
    const fields=['expectedDutyRevision','expectedHeadRevision','paymentOrderNo','confirmedMerchantNo','paidCents','previouslyRefundedCents','priorAppliedToDutyCents','noUnresolvedRefunds','evidenceRef'];
    return Object.keys(body).length===fields.length+(body.historicalDueVerified===true?1:0)+(body.historicalReleaseVerified===true?1:0)
      && Object.keys(body).every(field=>fields.includes(field)||field==='historicalDueVerified'||field==='historicalReleaseVerified')
      && typeof body.expectedDutyRevision==='string'&&/^[1-9]\d{0,17}$/.test(body.expectedDutyRevision)
      && typeof body.expectedHeadRevision==='string'&&/^(0|[1-9]\d{0,17})$/.test(body.expectedHeadRevision)
      && typeof body.paymentOrderNo==='string'&&/^[A-Za-z0-9_-]{1,50}$/.test(body.paymentOrderNo)
      && typeof body.confirmedMerchantNo==='string'&&/^\d{1,15}$/.test(body.confirmedMerchantNo)
      && [body.paidCents,body.previouslyRefundedCents,body.priorAppliedToDutyCents].every(item=>typeof item==='string'&&/^(0|[1-9]\d{0,23})$/.test(item))
      && body.noUnresolvedRefunds===true&&typeof body.evidenceRef==='string'&&body.evidenceRef.trim().length>=3&&new TextEncoder().encode(body.evidenceRef).length<=600;
  }
  if(value.command==='verify-basis') {
    const keys=["expectedRevision","inputEvidenceId","expectedBasisId","openingHaffM","baseBot","ownerPrices","openingItems","fullPayout","partiesVerified","reason"];
    const priceKeys=["barrett","bullet","awm","armor","helmet","coffee","card"];
    return Object.keys(body).sort().join()===keys.sort().join() && (body.expectedRevision===null||typeof body.expectedRevision==='string'&&/^[1-9]\d{0,17}$/.test(body.expectedRevision))
      && typeof body.inputEvidenceId==='string'&&TOKEN.test(body.inputEvidenceId) && (body.expectedBasisId===null||typeof body.expectedBasisId==='string'&&TOKEN.test(body.expectedBasisId))
      && typeof body.openingHaffM==='string'&&/^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(body.openingHaffM) && typeof body.baseBot==='string'&&/^[1-9]\d{0,9}$/.test(body.baseBot)
      && object(body.ownerPrices)&&Object.keys(body.ownerPrices).sort().join()===priceKeys.sort().join()&&Object.values(body.ownerPrices).every(x=>x===null||typeof x==='string'&&/^(0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(x))
      && validOptionalQuantities(body.openingItems)&&typeof body.fullPayout==='boolean'
      && body.partiesVerified===true&&typeof body.reason==='string'&&[...body.reason.trim()].length>=3&&new TextEncoder().encode(body.reason).length<=600&&!/[\u0000-\u001f\u007f]/.test(body.reason);
  }
  if (body.expectedRevision !== null && (typeof body.expectedRevision !== "string" || !/^[1-9]\d{0,17}$/.test(body.expectedRevision))) return false;
  if (duty && body.expectedRevision === null) return false;
  const fields = duty ? ["expectedRevision", "sourceFactAuditId", "reason", ...(value.command === "owner-credit" ? ["originalPaymentChecked"] : [])] : value.command === "support_cancel" ? ["expectedRevision","inputEvidenceId","refundCents","ownerCents","ownerAmountBasis","reason","originalPaymentChecked"] : ["expectedRevision", "inputEvidenceId", "planFingerprint", ...(["confirm", "reject"].includes(String(value.command)) ? ["reason"] : []), ...(value.command === "propose" ? ["quantities", "onBehalf", "reason", "endReason"] : [])];
  if (Object.keys(body).some(x => !fields.includes(x))) return false;
  if (!duty && (typeof body.inputEvidenceId !== "string" || !TOKEN.test(body.inputEvidenceId) || value.command !== "support_cancel" && (typeof body.planFingerprint !== "string" || !DIGEST.test(body.planFingerprint)))) return false;
  if (value.command === "support_cancel" && (body.originalPaymentChecked!==true || ![body.refundCents,body.ownerCents].every(v=>typeof v==="string"&&/^(0|[1-9]\d{0,15})$/.test(v)) || typeof body.reason!=="string" || body.reason!==body.reason.trim() || [...body.reason].length<3 || new TextEncoder().encode(body.reason).length>600 || /[\u0000-\u001f\u007f]/.test(body.reason))) return false;
  if (body.ownerAmountBasis !== undefined && body.ownerAmountBasis !== "GROSS_BEFORE_FEE_V1") return false;
  if (body.sourceFactAuditId !== undefined && (typeof body.sourceFactAuditId !== "string" || !TOKEN.test(body.sourceFactAuditId)) || body.reason !== undefined && (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500)) return false;
  if (value.command === "void" && (typeof body.sourceFactAuditId !== "string" || !TOKEN.test(body.sourceFactAuditId) || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500)) return false;
  if (["owner-credit","commission-credit"].includes(String(value.command)) && (body.sourceFactAuditId !== undefined || typeof body.reason !== "string" || [...body.reason.trim()].length < 3 || body.reason.length > 500)) return false;
  if (body.originalPaymentChecked !== undefined && value.command === "owner-credit" && body.originalPaymentChecked !== true) return false;
  if (["confirm", "reject"].includes(String(value.command)) && (typeof body.reason !== "string" || [...body.reason.trim()].length < 3 || body.reason.length > 500)) return false;
  if (value.command === "propose" && (!validQuantities(body.quantities) || !["renter", "owner"].includes(String(body.onBehalf)) || typeof body.reason !== "string" || [...body.reason.trim()].length < 3 || body.reason.length > 500)) return false;
  if (body.endReason !== undefined && !["NORMAL","TENANT_VOLUNTARY_EARLY","OWNER_OR_ACCOUNT_EARLY"].includes(String(body.endReason))) return false;
  return true;
}
const quantityNames = ["expendHaff", "barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"] as const;
function validQuantities(value: unknown): value is LegacyAdminQuantities {
  return object(value) && Object.keys(value).length === quantityNames.length && quantityNames.every(name => typeof value[name] === "string" && /^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value[name] as string));
}
function validOptionalQuantities(value: unknown): boolean {
  return object(value) && Object.keys(value).length === quantityNames.length && quantityNames.every(name => value[name] === null || typeof value[name] === "string" && /^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value[name] as string));
}
export function inspectLegacyAdminIntent(subject: string, orderId: string): LegacyAdminPending {
  try {
    const target = storage(); if (!target) return { state: "UNREADABLE", intent: null };
    const raw = target.getItem(key(subject)); if (raw === null) return { state: "NONE", intent: null };
    const parsed: unknown = JSON.parse(raw);
    return validIntent(parsed, subject, orderId) ? { state: "VALID", intent: parsed } : { state: "UNREADABLE", intent: null };
  } catch { return { state: "UNREADABLE", intent: null }; }
}
export async function retainLegacyAdminIntent(subject: string, orderId: string, command: LegacyAdminAction, body: Record<string, unknown>, dutyId: string | null = null, demoScope?:LegacyDemoScope): Promise<LegacyAdminIntent> {
  return withSupplyWriteLock(key(subject), async () => {
    if (inspectLegacyAdminIntent(subject, orderId).state !== "NONE") throw new Error("原请求尚未核清，不能覆盖");
    const nonce = globalThis.crypto?.randomUUID?.(); if (!nonce) throw new Error("无法保全请求标识，尚未提交");
    const intent: LegacyAdminIntent = { schema: 1, subject, orderId, command, dutyId, key: "legacy_" + nonce.replaceAll("-", ""), body: structuredClone(body), at: new Date().toISOString(),...(demoScope?{demoScope}:{}) };
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
  if (!object(value) || value.schema !== "legacy-continuation.v1" || !["KNOWN", "NOT_IMPORTED", "ISOLATED"].includes(String(value.availability)) || value.channelState !== "UNKNOWN" || !object(value.amounts) || !Array.isArray(value.capabilities) || value.capabilities.some(x => typeof x !== "string" || !["preview", "propose", "confirm", "reject", "hold", "release", "confiscate", "support_cancel"].includes(x)) || !object(value.commandFingerprints) || Object.values(value.commandFingerprints).some(x => typeof x !== "string" || !DIGEST.test(x)) || !Array.isArray(value.duties) || value.duties.length > 200 || !Array.isArray(value.reasons) || value.reasons.some(x => typeof x !== "string" || x.length > 100)) throw new Error("旧单办理资料暂不可用");
  if (value.stage !== null && !["3", "8", "9", "4", "5"].includes(String(value.stage)) || value.isSettle !== null && !["0", "2", "3"].includes(String(value.isSettle)) || value.revision !== null && (typeof value.revision !== "string" || !/^[1-9]\d{0,17}$/.test(value.revision)) || value.evidenceId !== null && (typeof value.evidenceId !== "string" || !TOKEN.test(value.evidenceId))) throw new Error("旧单版本暂不可用");
  if (value.refundDueAt !== undefined && value.refundDueAt !== null && (typeof value.refundDueAt !== "string" || !Number.isFinite(Date.parse(value.refundDueAt)))) throw new Error("退款时间暂不可用");
  if (value.lastBasisId !== undefined && value.lastBasisId !== null && (typeof value.lastBasisId !== "string" || !TOKEN.test(value.lastBasisId))) throw new Error("结算核实资料暂不可用");
  const amounts: LegacyAdminView["amounts"] = {};
  for (const [k, amount] of Object.entries(value.amounts)) {
    if (amount === null) { amounts[k] = null; continue; }
    if (!object(amount) || typeof amount.cents !== "string" || !/^(0|[1-9]\d{0,23})$/.test(amount.cents) || typeof amount.yuan !== "string" || !/^(0|[1-9]\d{0,23})\.\d{2}$/.test(amount.yuan) || BigInt(amount.yuan.replace(".", "")) !== BigInt(amount.cents)) throw new Error("旧单金额暂不可用");
    amounts[k] = { cents: amount.cents, yuan: amount.yuan };
  }
  let confirmationAmounts: LegacyAdminView["confirmationAmounts"] = null;
  if (value.capabilities.includes("confirm")) {
    if (!object(value.confirmationAmounts)) throw new Error("旧单结算金额暂不可用");
    const parsed = [value.confirmationAmounts.ownerNet, value.confirmationAmounts.refundNet];
    if (parsed.some(amount => !object(amount) || typeof amount.cents !== "string" || !/^(0|[1-9]\d{0,23})$/.test(amount.cents)
      || typeof amount.yuan !== "string" || !/^(0|[1-9]\d{0,23})\.\d{2}$/.test(amount.yuan) || BigInt(amount.yuan.replace(".", "")) !== BigInt(amount.cents))) throw new Error("旧单结算金额暂不可用");
    confirmationAmounts = value.confirmationAmounts as LegacyAdminView["confirmationAmounts"];
  }
  const duties = value.duties.map(d => {
    if (!object(d) || typeof d.id !== "string" || !TOKEN.test(d.id) || !["RENTER_REFUND", "OWNER_CREDIT", "COMMISSION", "DEPOSIT_COMPENSATION"].includes(String(d.kind)) || typeof d.amountCents !== "string" || !/^(0|[1-9]\d{0,23})$/.test(d.amountCents) || d.currency !== "CNY" || !["PENDING", "MATURED", "SETTLED", "VOID"].includes(String(d.status)) || typeof d.revision !== "string" || !/^[1-9]\d{0,17}$/.test(d.revision) || d.maturityAt !== null && (typeof d.maturityAt !== "string" || !Number.isFinite(Date.parse(d.maturityAt))) || ![null, "FINANCE", "LEGACY_RECORDS"].includes(d.settledBy as string | null) || d.financeVerified!==undefined && typeof d.financeVerified!=="boolean") throw new Error("经济责任资料暂不可用");
    const beneficiary=d.beneficiary===undefined?null:d.beneficiary;
    if(beneficiary!==null && (d.kind!=="COMMISSION" || !object(beneficiary) || typeof beneficiary.userId!=="string" || !TOKEN.test(beneficiary.userId)
      || beneficiary.name!==null && (typeof beneficiary.name!=="string" || !beneficiary.name.trim() || beneficiary.name.length>200)))throw new Error("收益人资料暂不可用");
    const selected=beneficiary===null?null:{userId:(beneficiary as Record<string,unknown>).userId as string,name:(beneficiary as Record<string,unknown>).name as string|null};
    return { id: d.id, kind: String(d.kind), amountCents: d.amountCents, currency: "CNY" as const, status: String(d.status), maturityAt: d.maturityAt as string | null, revision: d.revision, settledBy: d.settledBy as string | null, sourceStatus: typeof d.sourceStatus === "string" ? d.sourceStatus : null, financeVerified:d.financeVerified===true, beneficiary:selected };
  });
  const quantityFields = ["expendHaff", "barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"] as const;
  const rawQuantities = object(value.quantities) ? value.quantities : null;
  const quantities = rawQuantities ? Object.fromEntries(quantityFields.map(key => {
    const item=rawQuantities[key];return [key,typeof item==="string"&&/^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(item)?item:null];
  })) as LegacyRecordedQuantities : null;
  return { schema: "legacy-continuation.v1", availability: value.availability as LegacyAdminView["availability"], revision: value.revision as string | null, evidenceId: value.evidenceId as string | null, stage: value.stage as string | null, isSettle: value.isSettle as string | null, refundDueAt: typeof value.refundDueAt === "string" ? value.refundDueAt : null, lastBasisId: typeof value.lastBasisId === "string" ? value.lastBasisId : null, amounts, quantities, confirmationAmounts, duties, capabilities: [...value.capabilities] as string[], commandFingerprints: { ...value.commandFingerprints } as Record<string, string>, reasons: [...value.reasons] as string[], channelState: "UNKNOWN" };
}
export async function readLegacyAdminContinuation(orderId: string, signal?: AbortSignal) {
  const response = await adminRequest<{ continuation: unknown }>(base(orderId), undefined, "GET", {}, signal);
  return parseLegacyAdminView(response.continuation);
}
export type LegacyRefundBasis={orderId:string;dutyId:string;headRevision:string|null;dutyRevision:string;dutyCents:string;paidCents:string|null;
  paymentOrderNo:string|null;merchantNo:string|null;refundDueAt:string|null;historicalWaitUncertain?:boolean;historicalHeld?:boolean;
  historicalRefunds?:Array<{number:string|null;amountCents:string|null;at:string|null}>;historicalRefundsMore?:boolean;canStart:boolean;receipt:{caseId:string;intentId:string|null;refundOrderNo:string|null;amountCents:string;dutyCents:string;priorAppliedCents:string}|null;
  current:{intentId:string|null;refundOrderNo:string|null;generation:number|null;amountCents:string;dutyCents:string;priorAppliedCents:string;previouslyRefundedCents:string;chainReview:boolean;blockedBy:{intentId:string;refundOrderNo:string;generation:number}|null}|null;
  progress:{intentId:string;caseId:string;orderId:string;dutyId:string;refundOrderNo:string;amountCents:string;state:string;terminal:string|null;completedAt:string|null;bankArrival:'UNKNOWN'}|null};
export async function readLegacyAdminRefund(orderId:string,dutyId:string,signal?:AbortSignal):Promise<LegacyRefundBasis>{
  if(!TOKEN.test(dutyId))throw new Error('退款责任资料暂不可用');
  const result=await adminRequest<unknown>(base(orderId)+'/duties/'+encodeURIComponent(dutyId)+'/refund-case',undefined,'GET',{},signal);
  const cents=(value:unknown)=>typeof value==='string'&&/^(0|[1-9]\d{0,23})$/.test(value);
  if(!object(result)||result.orderId!==orderId||result.dutyId!==dutyId||!cents(result.dutyCents)||typeof result.dutyRevision!=='string'
    || !/^[1-9]\d{0,17}$/.test(result.dutyRevision)||result.headRevision!==null&&(typeof result.headRevision!=='string'||!/^(0|[1-9]\d{0,17})$/.test(result.headRevision))
    || result.paidCents!==null&&!cents(result.paidCents)||result.paymentOrderNo!==null&&(typeof result.paymentOrderNo!=='string'||!/^[A-Za-z0-9_-]{1,50}$/.test(result.paymentOrderNo))
    || result.merchantNo!==null&&(typeof result.merchantNo!=='string'||!/^\d{1,15}$/.test(result.merchantNo))||typeof result.canStart!=='boolean'
    || result.historicalWaitUncertain!==undefined&&typeof result.historicalWaitUncertain!=='boolean'
    || result.historicalHeld!==undefined&&typeof result.historicalHeld!=='boolean'
    || result.historicalRefundsMore!==undefined&&typeof result.historicalRefundsMore!=='boolean'
    || result.historicalRefunds!==undefined&&(!Array.isArray(result.historicalRefunds)||result.historicalRefunds.length>20||result.historicalRefunds.some(row=>!object(row)
      || row.number!==null&&(typeof row.number!=='string'||row.number.length>128)||row.amountCents!==null&&!cents(row.amountCents)
      || row.at!==null&&(typeof row.at!=='string'||!Number.isFinite(Date.parse(row.at)))))
    || result.refundDueAt!==null&&(typeof result.refundDueAt!=='string'||!Number.isFinite(Date.parse(result.refundDueAt))))throw new Error('退款核对资料暂不可用');
  if(result.receipt!==null&&(!object(result.receipt)||typeof result.receipt.caseId!=='string'||!TOKEN.test(result.receipt.caseId)
    || result.receipt.intentId!==null&&(typeof result.receipt.intentId!=='string'||!TOKEN.test(result.receipt.intentId))||!cents(result.receipt.amountCents)
    || !cents(result.receipt.dutyCents)||!cents(result.receipt.priorAppliedCents)||result.receipt.dutyCents!==result.dutyCents
    || BigInt(result.receipt.amountCents as string)+BigInt(result.receipt.priorAppliedCents as string)!==BigInt(result.receipt.dutyCents as string)
    || (result.receipt.amountCents==='0' ? result.receipt.intentId!==null||result.receipt.refundOrderNo!==null
      : result.receipt.intentId===null||typeof result.receipt.refundOrderNo!=='string'||!/^LR[a-f0-9]{28}$/.test(result.receipt.refundOrderNo))))throw new Error('退款任务资料暂不可用');
  if(result.current!==null&&(!object(result.current)||!object(result.receipt)||!cents(result.current.amountCents)||!cents(result.current.dutyCents)
    || !cents(result.current.priorAppliedCents)||!cents(result.current.previouslyRefundedCents)||typeof result.current.chainReview!=='boolean'
    || result.current.chainReview!==(result.current.blockedBy!==null)
    || result.current.blockedBy!==null&&(!object(result.current.blockedBy)||typeof result.current.blockedBy.intentId!=='string'||!TOKEN.test(result.current.blockedBy.intentId)
      ||typeof result.current.blockedBy.refundOrderNo!=='string'||!/^LR[a-f0-9]{28}$/.test(result.current.blockedBy.refundOrderNo)
      ||!Number.isSafeInteger(result.current.blockedBy.generation)||Number(result.current.blockedBy.generation)<1||Number(result.current.blockedBy.generation)>=Number(result.current.generation))
    || result.current.amountCents!==result.receipt.amountCents||result.current.dutyCents!==result.receipt.dutyCents||result.current.priorAppliedCents!==result.receipt.priorAppliedCents
    || (result.current.amountCents==='0'?result.current.intentId!==null||result.current.refundOrderNo!==null||result.current.generation!==null
      : typeof result.current.intentId!=='string'||!TOKEN.test(result.current.intentId)||typeof result.current.refundOrderNo!=='string'||!/^LR[a-f0-9]{28}$/.test(result.current.refundOrderNo)
        || !Number.isSafeInteger(result.current.generation)||Number(result.current.generation)<1)))throw new Error('退款任务资料暂不可用');
  if((result.receipt===null)!==(result.current===null))throw new Error('退款任务资料暂不可用');
  if(result.progress!==null&&(!object(result.progress)||!['READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED'].includes(String(result.progress.state))
    || !object(result.receipt)||!object(result.current)||result.progress.intentId!==result.current.intentId||result.progress.caseId!==result.receipt.caseId
    || result.progress.orderId!==orderId||result.progress.dutyId!==dutyId||result.progress.refundOrderNo!==result.current.refundOrderNo||result.progress.amountCents!==result.current.amountCents
    || result.current.chainReview===true&&result.progress.state!=='REVIEW_REQUIRED'
    || ![null,'SUCCEEDED','FAILED_NO_EXECUTION'].includes(result.progress.terminal as string|null)||result.progress.bankArrival!=='UNKNOWN'
    || result.progress.state==='SUCCEEDED'&&(result.progress.terminal!=='SUCCEEDED'||typeof result.progress.completedAt!=='string')||result.progress.state==='FAILED'&&result.progress.terminal!=='FAILED_NO_EXECUTION'
    || result.progress.completedAt!==null&&(typeof result.progress.completedAt!=='string'||!Number.isFinite(Date.parse(result.progress.completedAt)))))throw new Error('退款进度暂不可用');
  return result as LegacyRefundBasis;
}
async function legacyRefundChannelRequest(intentId:string,action:'query-only'|'submit'){
  if(!TOKEN.test(intentId))throw new Error('退款任务资料暂不可用');
  const result=await adminRequest<unknown>('/joinpay/legacy-refunds/'+encodeURIComponent(intentId)+'/'+action,{},'POST');
  if(!object(result)||result.contractVersion!=='admin-joinpay-query.v1'||result.operation!==(action==='submit'?'LEGACY_REFUND_SUBMIT':'LEGACY_REFUND_QUERY')||result.objectId!==intentId
    || !object(result.outcome)||!['OBSERVED','SKIPPED','NOT_DISPATCHED','UNKNOWN'].includes(String(result.outcome.kind))||result.channelArrival!=='UNKNOWN')
    throw new Error('退款查询结果暂不可用');
  return {kind:String(result.outcome.kind),reason:typeof result.outcome.reason==='string'?result.outcome.reason:null};
}
export const queryLegacyAdminRefund=(intentId:string)=>legacyRefundChannelRequest(intentId,'query-only');
export const submitLegacyAdminRefund=(intentId:string)=>legacyRefundChannelRequest(intentId,'submit');
export async function resolveLegacyAdminRefund(intentId:string,reason:string){
  if(!TOKEN.test(intentId)||reason.trim().length<3||reason.length>200)throw new Error('请填写核对说明');
  const result=await adminRequest<unknown>('/joinpay/legacy-refunds/'+encodeURIComponent(intentId)+'/resolve',{reason:reason.trim()},'POST');
  if(!object(result)||result.contractVersion!=='admin-joinpay-query.v1'||result.operation!=='LEGACY_REFUND_RESOLVE'||result.objectId!==intentId
    || !object(result.outcome)||!['OBSERVED','SKIPPED','NOT_DISPATCHED','UNKNOWN'].includes(String(result.outcome.kind))||result.channelArrival!=='UNKNOWN')throw new Error('核对结果暂不可用');
  return {kind:String(result.outcome.kind),event:typeof result.outcome.event==='string'?result.outcome.event:null};
}
export async function resumeLegacyAdminRefund(intentId:string,reason:string){
  if(!TOKEN.test(intentId)||reason.trim().length<3||reason.length>200)throw new Error('请填写核对说明');
  const result=await adminRequest<unknown>('/joinpay/legacy-refunds/'+encodeURIComponent(intentId)+'/resume',{reason:reason.trim()},'POST');
  if(!object(result)||result.contractVersion!=='admin-joinpay-query.v1'||result.operation!=='LEGACY_REFUND_RESUME'||result.objectId!==intentId
    || !object(result.outcome)||!['RESUMED','ALREADY_RESUMED','UNKNOWN'].includes(String(result.outcome.kind))||result.channelArrival!=='UNKNOWN')throw new Error('核对结果暂不可用');
  return {kind:String(result.outcome.kind)};
}
export async function retryLegacyAdminRefund(intentId:string,input:{previouslyRefundedCents:string;noUnresolvedRefunds:boolean;reason:string}){
  if(!TOKEN.test(intentId)||! /^(0|[1-9]\d{0,23})$/.test(input.previouslyRefundedCents)||input.noUnresolvedRefunds!==true
    ||input.reason.trim().length<3||input.reason.length>200)throw new Error('请先核对原付款和退款记录');
  const result=await adminRequest<unknown>('/joinpay/legacy-refunds/'+encodeURIComponent(intentId)+'/retry',{...input,reason:input.reason.trim()},'POST');
  if(!object(result)||result.contractVersion!=='admin-joinpay-query.v1'||result.operation!=='LEGACY_REFUND_RETRY'||result.objectId!==intentId
    || !object(result.outcome)||!['RETRY_CREATED','RETRY_EXISTS','UNKNOWN'].includes(String(result.outcome.kind))||result.channelArrival!=='UNKNOWN')throw new Error('退款重试结果暂不可用');
  return {kind:String(result.outcome.kind)};
}
export async function previewLegacyAdminContinuation(orderId: string, quantities: LegacyAdminQuantities, onBehalf: "renter" | "owner", endReason?:LegacyEndReason): Promise<LegacyAdminProposal> {
  if (!validQuantities(quantities) || !["renter", "owner"].includes(onBehalf)) throw new Error("请填写有效的消耗数量并选择发起方");
  const result = await adminRequest<unknown>(base(orderId) + "/preview", { quantities, onBehalf, ...(endReason?{endReason}:{}) }, "POST");
  if (!object(result) || result.revision !== null && (typeof result.revision !== "string" || !/^[1-9]\d{0,17}$/.test(result.revision)) || typeof result.inputEvidenceId !== "string" || !TOKEN.test(result.inputEvidenceId) || typeof result.proposalFingerprint !== "string" || !DIGEST.test(result.proposalFingerprint) || !["EARLY", "NORMAL"].includes(String(result.settlementKind)) || !object(result.proposalAmounts) || Object.values(result.proposalAmounts).some(v => v !== null && formatExactYuan(v) === null)) throw new Error("结算预估暂不可用");
  return { ...result, proposalAmounts: Object.fromEntries(Object.entries(result.proposalAmounts).map(([key, value]) => [key, value === null ? null : formatExactYuan(value)])) } as LegacyAdminProposal;
}
export async function sendLegacyAdminIntent(intent: LegacyAdminIntent) {
  if (!validIntent(intent, intent.subject, intent.orderId)) throw new Error("原请求不完整，禁止提交");
  const path = base(intent.orderId) + (intent.dutyId ? "/duties/" + encodeURIComponent(intent.dutyId) + "/" + intent.command : "/" + (intent.command === "support_cancel" ? "support-cancel" : intent.command));
  const result = await adminRequest<unknown>(path, intent.body, "POST", { "idempotency-key": intent.key });
  return validateResult(intent,result);
}
export async function recoverLegacyAdminIntent(intent: LegacyAdminIntent): Promise<LegacyAdminReceipt> {
  const params = new URLSearchParams({ command: intent.command, key: intent.key }); if (intent.dutyId) params.set("dutyId", intent.dutyId);
  const result = await adminRequest<LegacyAdminReceipt>(base(intent.orderId) + "/receipt?" + params);
  if (!result || !["UNKNOWN", "KNOWN_SUCCESS", "KNOWN_REJECTED"].includes(result.state)) throw new Error("原请求结果尚待核对");
  if (result.state === "UNKNOWN") return result;
  const body = intent.body, operation = intent.dutyId ? "order.legacy.duty." + intent.command : "order.legacy.continuation." + intent.command;
  const input = intent.command==='demo-refund'?{dutyId:intent.dutyId,expectedDutyRevision:body.expectedDutyRevision,expectedHeadRevision:body.expectedHeadRevision,assumption:body.assumption,reason:body.reason}:
    intent.command==='refund-case' ? {orderId:intent.orderId,dutyId:intent.dutyId,expectedDutyRevision:body.expectedDutyRevision,expectedHeadRevision:body.expectedHeadRevision,
    paymentOrderNo:body.paymentOrderNo,confirmedMerchantNo:body.confirmedMerchantNo,paidCents:body.paidCents,previouslyRefundedCents:body.previouslyRefundedCents,
    priorAppliedToDutyCents:body.priorAppliedToDutyCents,noUnresolvedRefunds:body.noUnresolvedRefunds,evidenceRef:body.evidenceRef}
    : intent.command==='verify-basis'?body : intent.dutyId ? { dutyId: intent.dutyId, kind: intent.command, expectedRevision: body.expectedRevision, sourceFactAuditId: body.sourceFactAuditId, reason: body.reason, ...(body.originalPaymentChecked===true?{originalPaymentChecked:true}:{}) } : intent.command === "support_cancel" ? {kind:intent.command,expectedRevision:body.expectedRevision,inputEvidenceId:body.inputEvidenceId,refundCents:body.refundCents,ownerCents:body.ownerCents,originalPaymentChecked:body.originalPaymentChecked,...(body.ownerAmountBasis?{ownerAmountBasis:body.ownerAmountBasis}:{}),reason:body.reason} : { kind: intent.command, expectedRevision: body.expectedRevision, inputEvidenceId: body.inputEvidenceId, planFingerprint: body.planFingerprint, ...(intent.command === "propose" ? { quantities: body.quantities, ...(body.endReason?{endReason:body.endReason}:{}) } : {}), ...(body.reason === undefined ? {} : { reason: body.reason }), ...(body.onBehalf === undefined ? {} : { onBehalf: body.onBehalf }) };
  const bytes = new TextEncoder().encode(JSON.stringify([operation, intent.dutyId ?? intent.orderId, input]));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(x => x.toString(16).padStart(2, "0")).join("");
  if (result.fingerprint !== fingerprint || result.state === "KNOWN_SUCCESS" && !(result.status >= 200 && result.status < 300) || result.state === "KNOWN_REJECTED" && ![400, 409].includes(result.status)) throw new Error("原请求绑定不一致，禁止覆盖");
  if(result.state==="KNOWN_SUCCESS")validateResult(intent,result.receipt);
  if(result.state==="KNOWN_REJECTED" && (!object(result.receipt) || result.receipt.outcome!=="REJECTED"))throw new Error("原请求结果尚待核对");
  return result;
}
