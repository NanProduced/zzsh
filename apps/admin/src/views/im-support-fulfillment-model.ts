/**
 * 履约核对的纯数据层：数量/金额展示与提交解析、阶段与取消原因文案、本地持久化键。
 * 不含 React 状态，也不计算资金真值；金额一律以服务端结果为准。
 */
import { formatReferenceYuan } from "@zzsh/ui/display-money";
import type { FulfillmentIntent, SupportCancelView } from "../lib/order-fulfillment-client";

export type InventoryLine = { itemId: string; quantity: string; unit: string; pricingKind: string; name: string | null };
export type LineDraft = { itemId: string; name: string | null; unit: string; value: string };
export type PreviewState = {
  amounts: Record<string, unknown> | null;
  versionHash: string | null;
  early: boolean | null;
  adjustArmed: boolean;
};
export type IntentPhase = "IDLE" | "SENDING" | "UNKNOWN" | "AUTH" | "ACCEPTED_READBACK_PENDING";
export type FulfillmentReadState = "idle" | "ok" | "unavailable" | "forbidden" | "auth" | "unknown";
export type PersistedIntent = { subject: string; intent: FulfillmentIntent; accepted?: boolean };
export const ACCEPTED_STORAGE_WARNING = "操作已受理，但本地无法保存恢复状态；不会重复提交。请勿刷新或离开页面，先查看当前状态或联系维护处理。";
export const SETTLEMENT_REASON_LABELS:Record<string,string>={
  DISCOUNT_OWNER_FUNDING_INSUFFICIENT:"折后实际消耗不足以覆盖号主应得，暂不能结算；请联系双方线下协调并记录处理情况。",
  SETTLEMENT_FEE_RECONFIRM_REQUIRED:"包赔费计算规则已更正，请重新生成方案并由双方确认。",
  OWNER_AMOUNT_CONTRACT_REFRESH_REQUIRED:"金额口径已更新，请刷新并重新填写号主扣费前收入。",
  INSUFFICIENT_PREPAYMENT:"本单实付不足以覆盖结算费用，请核对数量并与双方沟通。",
  SETTLEMENT_PRICING_INVALID:"本单冻结价格资料无法核实，请联系维护人员。",
  ORDER_PARTY_UNAVAILABLE:"订单一方账号当前不可用，请核实身份和资金状态后处理。",
};
/** 自动开租资料不足时只解释原因，不提供伪造清单的入口。 */
export const OPENING_REVIEW_REASONS:Record<string,string>={
  PAYMENT_BASIS_MISSING:"付款接纳依据缺失，不能据此生成开租清单。",
  ORDER_NOT_PAID:"订单当前不是已付款可开租状态。",
  QUOTE_BASIS_INVALID:"本单冻结报价或资源清单不完整。",
  LEGACY_V1_QUOTE_REVIEW:"旧版建单缺少个性化资金/包赔依据，不能自动生成开租清单；请按未开租取消退款或使用新版下单。",
  GENERATION_FAILED:"自动生成开租清单时发生数据库错误，付款已保留，请核对后重试或按未开租处理。",
  GENERATION_RECORD_MISSING:"自动开租记录写入失败，付款已保留；请重新核对开租依据，或按未开租取消退款。",
  "42P01":"自动开租表未安装，付款已保留；请完成迁移后重新核对。",
  "42501":"自动开租权限不足，付款已保留；请核对运行角色权限后重新核对。",
  "55P03":"自动开租遇到锁冲突，付款已保留；请稍后重新核对。",
  FULL_PAYOUT_UNKNOWN:"全额包赔或资金依据不完整。",
  SETTLEMENT_PRICING_INVALID:"冻结价格资料无法核实。",
  OPENING_QUANTITY_MISMATCH:"开租数量与冻结报价不一致。",
  AUTO_CONFIRM_POLICY_UNAVAILABLE:"自动确认配置暂不可用。",
};
export function openingReviewText(reason:string|null|undefined):string{
  return reason&&OPENING_REVIEW_REASONS[reason]?OPENING_REVIEW_REASONS[reason]!:"开租资料待人工核对，暂不能生成清单。";
}
export const REMINDER_REASON_TEXT:Record<string,string>={
  ORDER_NOT_ACTIVE:"订单已结束或不在可提醒阶段，未发送消息。",
  OPENING_MISSING:"本单尚无开租清单，请先核对付款与开租资料。",
  OPENING_REVIEW_REQUIRED:"本单开租资料待核对，暂不能发送开租提醒。",
  INTAKE_PENDING:"本单已有结算申请待客服处理，暂不需要提醒双方。",
  PARTIES_CONFIRMED:"双方已完成当前阶段的确认，暂不需要提醒。",
  DECISION_REJECTED:"结算方案已被一方拒绝，请先协调或重新发起，不再提醒另一方确认原方案。",
  SETTLEMENT_FEE_RECONFIRM_REQUIRED:"原方案的包赔费计算口径需要更正，请先重新生成方案。",
  STAGE_CHANGED:"原提醒对应的阶段已变化，已结束旧请求；请按当前订单状态重新发起提醒。",
  SETTLEMENT_POSTED:"本单结算已生效，不再发送阶段提醒。",
  TEAM_NOT_READY:"订单群尚未就绪，暂不能发送提醒；订单页不受影响。",
  REMINDER_IN_PROGRESS:"上一条提醒仍在发送中，请稍后查看本单状态。",
  REMINDER_UNKNOWN:"上一条提醒结果未知；请先在订单群核对是否已发送，确认未发送后再新建提醒。",
};

export const AMOUNT_LABELS: Record<string, string> = {
  haffConsumedBuyer: "哈夫币消耗（租客侧）",
  haffConsumedOwner: "哈夫币消耗（号主侧）",
  itemConsumedBuyer: "物品消耗（租客侧）",
  itemConsumedOwner: "物品消耗（号主侧）",
  unusedItemRefund: "未消耗物资预付款（按下单时分配）",
  unusedHaffRefund: "未消耗哈夫币预付款（按下单时分配）",
  earlyMakeup: "提前结束补足",
  feeBase: "包赔费基数",
  feeRate: "包赔费率",
  feeAmount: "包赔费",
  platformServiceFee: "平台手续费",
  membershipDiscount: "平台承担会员优惠",
  feePayer: "包赔费承担方",
  ownerGross: "号主毛额",
  ownerNet: "号主净额",
  renterCharge: "租客应收",
  renterRefund: "租客应退",
  depositRefund: "押金退款",
};
export const AMOUNT_ORDER = Object.keys(AMOUNT_LABELS);
export const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件", DAY: "天" };

export function quantityForDisplay(value:string,unit:string):string {
  if(unit!=="HAFF_BASE"||!/^(0|[1-9]\d{0,18})$/.test(value))return value;
  const n=BigInt(value),whole=n/1000000n,fraction=(n%1000000n).toString().padStart(6,"0").replace(/0+$/,"");
  return fraction?`${whole}.${fraction}`:String(whole);
}
export function quantityForSubmit(value:string,unit:string):string|null {
  if(unit!=="HAFF_BASE")return /^(0|[1-9]\d{0,18})$/.test(value)?value:null;
  const match=/^(0|[1-9]\d{0,12})(?:\.(\d{1,6}))?$/.exec(value);
  if(!match)return null;
  const n=BigInt(match[1]!)*1000000n+BigInt((match[2]??"").padEnd(6,"0"));
  return n<=9999999999999999999n?n.toString():null;
}

export function amountText(value: unknown, monetary: boolean): string | null {
  if (monetary) {
    const raw = typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value)
      ? (value as { amount?: unknown }).amount : null;
    const text = formatReferenceYuan(raw);
    return text ? `${text.replace("¥", "")} 元` : null;
  }
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { amount?: unknown; unit?: unknown };
    if (typeof record.amount === "string" && record.amount.trim()) return `${record.amount} ${typeof record.unit === "string" && record.unit === "yuan" ? "元" : record.unit ?? ""}`.trim();
  }
  return null;
}
export function amountRows(amounts: Record<string, unknown> | null | undefined): Array<{ key: string; label: string; text: string }> {
  if (!amounts) return [];
  return AMOUNT_ORDER.flatMap(key => {
    const text = amountText(amounts[key], key !== "feeRate" && key !== "feePayer");
    return text === null ? [] : [{ key, label: AMOUNT_LABELS[key]!, text }];
  });
}
export function isSettlementMoney(value:unknown):boolean{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const money=value as {currency?:unknown;unit?:unknown;scale?:unknown;amount?:unknown};
  return money.currency==="CNY"&&money.unit==="yuan"&&money.scale===2&&typeof money.amount==="string"&&/^(0|[1-9]\d*)\.\d{2}$/.test(money.amount);
}
export function partyLabel(party: string | undefined): string {
  if (party === "RENTER") return "租客";
  if (party === "OWNER") return "号主";
  if (party === "SUPPORT") return "客服";
  return "相关方";
}
export function decisionLabel(decision: { party?: string; action?: string }): string {
  const action = decision.action === "CONFIRM" ? "已确认" : decision.action === "REJECT" ? "已拒绝" : decision.action === "REVIEW" ? "已复核" : decision.action === "FINALIZE" ? "已确认结算" : "状态待核";
  return `${partyLabel(decision.party)}${action}`;
}
export function storageKeyFor(viewerId: string, orderId: string): string {
  return `zzsh.im-support.fulfillment.${viewerId}.${orderId}`;
}
export function reminderKeyFor(viewerId: string, orderId: string): string {
  return `zzsh.im-support.reminder.${viewerId}.${orderId}`;
}

export const SUPPORT_CANCEL_REASON_TEXT: Record<string, string> = {
  ORDER_COMPLETED: "结算已生成或订单已完成，不能在这里取消；请走财务/售后退款。",
  ORDER_NOT_PAID: "订单当前不是已付款可取消状态；请刷新后核对。",
  PAYMENT_BASIS_UNAVAILABLE: "原支付单不可用，不能安全发起原路退款。",
  OPENING_ALREADY_CONFIRMED: "订单已确认开租，请使用现有结算与退款流程；不能按未开租全额取消。",
  SETTLEMENT_ALREADY_POSTED: "结算已落账，不能在这里取消；请走财务/售后退款。",
  SETTLEMENT_DRAFT_EXISTS: "存在结算草稿或受理单，请先处理或关闭结算后再取消。",
  MANUAL_ADJUSTMENT_REVIEW: "存在待处理金额调整，请先处理后再取消。",
  DISTRIBUTION_RECONCILIATION_REQUIRED: "存在待核对的佣金/分销收益，请先转财务核对。",
  REFUND_PENDING: "本单已有未完成的退款申请，请先处理退款。",
  TERMINATION_PENDING: "本单已有未处理的终止申请，请先处理。",
  ALREADY_CANCELLED: "订单已取消。",
  ORDER_CHANGED: "订单已变化，请刷新后重新核对退款资格。",
};
export const SUPPORT_CANCEL_UNKNOWN = "取消结果未确认。请先刷新订单核对；不要用新原因重复提交，可在本页按原请求重试。";

export function supportCancelReasonText(reason: string | null | undefined): string {
  return reason && SUPPORT_CANCEL_REASON_TEXT[reason] ? SUPPORT_CANCEL_REASON_TEXT[reason]! : "当前状态不满足客服取消条件，请刷新后核对。";
}

export function supportCancelRefundText(view: SupportCancelView | null): string {
  if (view?.simulationScope) {
    const latest = view.refund?.intents?.at(-1);
    if (latest?.requiresReview || latest?.state === "REVIEW_REQUIRED") return "模拟退款需要核对，不会实际退回款项。";
    if (latest?.state === "SUCCEEDED") return "模拟退款已完成，不会实际退回款项。";
    if (latest?.state === "FAILED") return "模拟退款未完成，不会实际退回款项。";
    return "模拟退款待处理，不会实际退回款项。";
  }
  if (!view?.refund || view.refund.integration !== "INTEGRATED" || !view.refund.intents?.length) {
    return "退款责任已登记，退款进度尚未记录；银行到账未知。";
  }
  const latest = view.refund.intents[view.refund.intents.length - 1]!;
  if (latest.requiresReview || latest.state === "REVIEW_REQUIRED") return "退款需人工复核；银行到账未知。";
  if (latest.state === "SUCCEEDED") return "本站已记录退款处理结果，银行到账未知。";
  if (latest.state === "FAILED") return "退款处理未完成，请核对记录。";
  if (latest.state === "SUBMITTING" || latest.state === "PROCESSING") return "退款处理中，结果未确认。";
  if (latest.state === "UNKNOWN") return "退款结果未确认，不能视为已退款。";
  return "退款待处理；银行到账未知。";
}