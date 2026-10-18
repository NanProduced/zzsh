import type { Order, LegacyOrder, OrderParty, PersonalRentalQuote, SettlementOpening, SettlementPosting, SettlementPreview, SettlementVersion } from "./order-client";

export function personalMembershipLabel(quote:PersonalRentalQuote):string {
  const b=quote.membershipBenefits;
  if(b?.schema==="membership-benefits-v1")return ({STANDARD:"普通会员",SILVER:"银卡会员",GOLD:"金卡会员",PLATINUM:"铂金会员",DIAMOND:"钻石会员",BLACK_GOLD:"黑金会员·终身"} as Record<string,string>)[b.effectiveTier]??"会员权益待核";
  return quote.customerTier ? "既有确认方案" : "会员权益待核";
}
export function personalBenefitSources(quote:PersonalRentalQuote):string|null {
  const b=quote.membershipBenefits;if(!b)return null;
  const names={GROWTH:"成长权益",FRIEND:"挚友礼遇",PRESTIGE:"尊享礼遇"};
  return `价格：${names[b.priceSource]??"待核"}；押金：${names[b.depositSource]??"待核"}`;
}

/**
 * Server-observed entry eligibility for the two payment actions. The projection is authoritative when
 * present; the local status facts are only the equivalent fallback, never a wider client-side guess.
 */
export function paymentEntryOpen(order: Order): boolean {
  return order.paymentOpen ?? (order.status === "PENDING_PAYMENT" && !order.expiredAwaitingCancel);
}

/** Historical participation is not permission to view the account's current private facts. */
export function orderAccountTitle(order: Pick<Order, "source" | "title"> & { account?: LegacyOrder["account"] }): string {
  if (order.source?.origin === "LEGACY" && !order.account?.readable) return "账号资料暂未提供";
  return order.title?.trim() || "账号信息暂不可用";
}

export function cancelEntryOpen(order: Order): boolean {
  return order.cancelOpen ?? order.status === "PENDING_PAYMENT";
}

const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", PIECE: "件", ROUND: "发", DAY: "天" };

export function unitLabel(unit: string | null | undefined): string {
  if (!unit) return "";
  return UNIT_LABELS[unit] ?? unit;
}

/** Unit hint for a table cell; omitted when the resource name already carries it. */
export function unitHint(name: string, unit: string | null | undefined): string {
  const label = unitLabel(unit);
  return label && !name.includes(label) ? label : "";
}

export function groupedInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** HAFF quantities are base units; show the exact integer plus the exact M helper. */
export function quantityText(unit: string | null | undefined, quantity: string): string {
  const label = unitLabel(unit);
  if (!/^\d+$/.test(quantity)) return quantity;
  if (unit === "HAFF_BASE") {
    const value = BigInt(quantity);
    const whole = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    const millions = fraction ? `${whole}.${fraction}` : whole.toString();
    return `${groupedInteger(quantity)} 哈夫币（${millions} M）`;
  }
  return `${groupedInteger(quantity)}${label ? ` ${label}` : ""}`;
}

export function resourceName(order: Order, itemId: string): string {
  const line = order.quote?.lines?.find((candidate) => candidate.itemId === itemId);
  return line?.name && line.name.trim() ? line.name : itemId;
}

/** Settlement projections may deliver exact yuan strings or {currency,amount} objects. */
export function moneyText(value: unknown): string {
  if (typeof value === "string") return /^\d+\.\d{2}$/.test(value) ? `¥${value}` : "—";
  if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
  const amount = value as { currency?: unknown; amount?: unknown };
  if (amount.currency !== "CNY" || typeof amount.amount !== "string" || !/^\d+\.\d{2}$/.test(amount.amount)) return "—";
  return `¥${amount.amount}`;
}

/**
 * Cents-suffixed posting fields are exact integer strings. A missing value stays unknown ("—"):
 * it is never widened to zero, and the sign is kept because a negative net is a real server fact.
 */
export function moneyCents(value: string | null | undefined): string {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return "—";
  const cents = BigInt(value);
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}¥${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")} 元`;
}

function amountAt(amounts: Record<string, unknown>, key: string): string {
  return moneyText(amounts[key]);
}

export type SettlementAmountRow = { label: string; value: string; note?: string };

/**
 * Party-facing breakdown of the frozen settlement amounts; internal profit fields are not included.
 *
 * `mode` only renames what the same server numbers mean: a preview is still an estimate, while a
 * posting is the effective result. It never recalculates money in the browser.
 */
export function settlementAmountRows(
  party: OrderParty,
  amounts: Record<string, unknown> | null | undefined,
  mode: "estimate" | "effective" = "estimate",
): SettlementAmountRow[] {
  if (!amounts) return [];
  const effective = mode === "effective";
  const rows: SettlementAmountRow[] = [];
  const feePayer = typeof amounts.feePayer === "string" ? amounts.feePayer : "NONE";
  const rate = typeof amounts.feeRate === "string" ? amounts.feeRate : null;
  if (party === "renter") {
    rows.push({ label: "哈夫币消耗（租客侧）", value: amountAt(amounts, "haffConsumedBuyer") });
    rows.push({ label: "物品消耗（租客侧）", value: amountAt(amounts, "itemConsumedBuyer") });
    rows.push({ label: "未耗物品退回", value: amountAt(amounts, "unusedItemRefund") });
    rows.push({ label: "未耗哈夫退回", value: amountAt(amounts, "unusedHaffRefund") });
    rows.push({ label: effective ? "本次结算扣费" : "本次消耗合计", value: amountAt(amounts, "renterCharge") });
    const makeup = amountAt(amounts, "earlyMakeup");
    if (makeup !== "—" && makeup !== "¥0.00") rows.push({ label: "提前结束补足", value: makeup });
    if (feePayer === "RENTER") rows.push({ label: `包赔费用（租客承担${rate ? ` · 费率 ${rate}` : ""}）`, value: amountAt(amounts, "feeAmount") });
    rows.push({ label: effective ? "最终应退" : "预计应退", value: amountAt(amounts, "renterRefund"), note: effective ? "已生效金额；不等于渠道退款到账" : "含押金应退，不等于渠道到账" });
    rows.push({ label: "其中押金应退", value: amountAt(amounts, "depositRefund") });
  } else {
    rows.push({ label: "哈夫币消耗（号主侧）", value: amountAt(amounts, "haffConsumedOwner") });
    rows.push({ label: "物品消耗（号主侧）", value: amountAt(amounts, "itemConsumedOwner") });
    rows.push({ label: "号主毛收入", value: amountAt(amounts, "ownerGross") });
    if (feePayer === "OWNER") rows.push({ label: `包赔费用（号主承担${rate ? ` · 费率 ${rate}` : ""}）`, value: amountAt(amounts, "feeAmount") });
    else if (feePayer === "RENTER") rows.push({ label: "包赔费用", value: "由租客承担", note: "不在号主净额中扣除" });
    rows.push({ label: effective ? "本单净入账" : "号主净入账", value: amountAt(amounts, "ownerNet"), note: effective ? "本单净入账，不是钱包全部余额或提现结果" : "结算生效后进入可用余额" });
  }
  return rows;
}

export function previewAmounts(preview: SettlementPreview | null): Record<string, unknown> | null {
  return preview?.amounts ?? null;
}

export function versionAmounts(version: SettlementVersion | null | undefined): Record<string, unknown> | null {
  return version?.computation?.amounts ?? null;
}

/** Whether this version is a human adjustment, i.e. its net/refund are not the system computation. */
export function isAdjustedVersion(version: SettlementVersion | null | undefined): boolean {
  if (!version) return false;
  return version.kind === "MANUAL_ADJUSTMENT" || version.proposedOwnerNet != null || version.proposedRenterRefund != null;
}

function netLabel(party: OrderParty, mode: "estimate" | "effective"): string {
  if (party === "owner") return mode === "effective" ? "本单净入账" : "号主净入账";
  return mode === "effective" ? "最终应退" : "预计应退";
}

/** The charge row is the system computation, and says so once an adjustment moved the final figures. */
export function chargeRowLabel(adjusted: boolean): string {
  return adjusted ? "系统计算扣费（调整前）" : "本次结算扣费";
}

/**
 * The cents value this party would settle by confirming now. A missing or malformed value is not
 * readable evidence, so it stays null instead of falling back to the system computation.
 */
export function proposedConfirmationCents(party: OrderParty, version: SettlementVersion | null | undefined): string | null {
  if (!version) return null;
  const raw = party === "owner" ? version.proposedOwnerNet : version.proposedRenterRefund;
  return typeof raw === "string" && /^\d+$/.test(raw) ? raw : null;
}

/**
 * Rows for the version the user is about to decide on. A manual version must disclose the amount that
 * confirmation would actually settle: the system computation and the proposed adjustment are two
 * different figures, and a missing proposed value stays unknown instead of falling back to the system one.
 */
export function decisionAmountRows(party: OrderParty, version: SettlementVersion | null | undefined): SettlementAmountRow[] {
  const rows = settlementAmountRows(party, versionAmounts(version));
  if (!isAdjustedVersion(version)) return rows;
  const target = netLabel(party, "estimate");
  const system = party === "owner" ? version?.systemOwnerNet : version?.systemRenterRefund;
  const proposed = proposedConfirmationCents(party, version);
  const subject = party === "owner" ? "净额" : "应退";
  return rows
    .filter((row) => row.label !== target)
    .concat([
      { label: `系统计算${subject}`, value: moneyCents(system), note: "按已确认期初与本次期末计算的系统值" },
      { label: `本次将确认的${subject}`, value: moneyCents(proposed), note: proposed === null ? "没有可读的拟调整金额，不能按系统值确认，也暂不能确认这一版" : "确认后按此金额生效" },
    ]);
}

/**
 * The effective breakdown of one posting. The final net/refund are the posting's own columns; the
 * snapshot rows keep their system values and say so, because a manual adjustment only moves the
 * net and the payable refund.
 */
export function postingAmountRows(party: OrderParty, posting: SettlementPosting): SettlementAmountRow[] {
  const rows = settlementAmountRows(party, posting.amounts ?? null, "effective");
  const adjusted = Boolean(posting.manualAdjustment);
  const target = netLabel(party, "effective");
  const chargeLabel = chargeRowLabel(adjusted);
  const finalValue = party === "owner" ? moneyCents(posting.owner?.availableCents) : moneyCents(posting.refund?.payableCents);
  return rows.map((row) => {
    if (row.label === target) return { ...row, value: finalValue };
    if (adjusted && row.label === "本次结算扣费") return { ...row, label: chargeLabel, note: "按系统计算；人工调整只改变最终净额与应退" };
    return adjusted ? { ...row, note: row.note ?? "系统计算快照" } : row;
  });
}

export type ConsumptionRow = {
  itemId: string;
  name: string;
  unit: string | null | undefined;
  /** Opening quantity of the version this settlement was computed against. */
  opening: string | null;
  /** Remaining quantity the initiator submitted; null when this version carries no such line. */
  remaining: string | null;
  /** Server consumption when the projection carries it; otherwise the exact difference. */
  consumed: string | null;
};

/**
 * Opening/remaining/consumed per resource for one settlement version. Everything is taken from the
 * server projection (opening lines, the version's input snapshot, the computed consumption); the
 * difference is only a display fallback for a line the server did not compute.
 */
export function consumptionRows(order: Order, opening: SettlementOpening | null, version: SettlementVersion | null | undefined): ConsumptionRow[] {
  const openingLines = opening?.lines ?? [];
  if (openingLines.length === 0) return [];
  const submitted = new Map((version?.inputSnapshot?.lines ?? []).map((line) => [line.itemId, line.remainingQuantity]));
  const consumed = version?.computation?.consumed;
  return openingLines.map((line) => {
    const open = line.quantity ?? null;
    const rest = submitted.get(line.itemId) ?? null;
    const serverLine = consumed?.items?.find((item) => item.itemId === line.itemId);
    const derived = open !== null && rest !== null && /^\d+$/.test(open) && /^\d+$/.test(rest) && BigInt(rest) <= BigInt(open)
      ? (BigInt(open) - BigInt(rest)).toString()
      : null;
    const used = line.pricingKind === "HAFF_RATIO" && consumed?.haff !== undefined && consumed.haff !== null
      ? String(consumed.haff)
      : serverLine?.consumed ?? derived;
    return { itemId: line.itemId, name: resourceName(order, line.itemId), unit: line.unit, opening: open, remaining: rest, consumed: used ?? null };
  });
}
