import type { Money } from "./supply-types";
import type { Order, OrderParty, SettlementPreview, SettlementVersion } from "./order-client";

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

function amountAt(amounts: Record<string, unknown>, key: string): string {
  return moneyText(amounts[key]);
}

export type SettlementAmountRow = { label: string; value: string; note?: string };

/** Party-facing breakdown of the frozen settlement amounts; internal profit fields are not included. */
export function settlementAmountRows(party: OrderParty, amounts: Record<string, unknown> | null | undefined): SettlementAmountRow[] {
  if (!amounts) return [];
  const rows: SettlementAmountRow[] = [];
  const feePayer = typeof amounts.feePayer === "string" ? amounts.feePayer : "NONE";
  const rate = typeof amounts.feeRate === "string" ? amounts.feeRate : null;
  if (party === "renter") {
    rows.push({ label: "哈夫币消耗（租客侧）", value: amountAt(amounts, "haffConsumedBuyer") });
    rows.push({ label: "物品消耗（租客侧）", value: amountAt(amounts, "itemConsumedBuyer") });
    const unusedItems = amountAt(amounts, "unusedItemRefund");
    const unusedHaff = amountAt(amounts, "unusedHaffRefund");
    rows.push({ label: "未耗物品退回", value: unusedItems });
    rows.push({ label: "未耗哈夫退回", value: unusedHaff });
    rows.push({ label: "本次消耗合计", value: amountAt(amounts, "renterCharge") });
    const makeup = amountAt(amounts, "earlyMakeup");
    if (makeup !== "—" && makeup !== "¥0.00") rows.push({ label: "提前结束补足", value: makeup });
    if (feePayer === "RENTER") rows.push({ label: `包赔费用（租客承担${rate ? ` · 费率 ${rate}` : ""}）`, value: amountAt(amounts, "feeAmount") });
    rows.push({ label: "预计应退", value: amountAt(amounts, "renterRefund"), note: "含押金应退，不等于渠道到账" });
    rows.push({ label: "其中押金应退", value: amountAt(amounts, "depositRefund") });
  } else {
    rows.push({ label: "哈夫币消耗（号主侧）", value: amountAt(amounts, "haffConsumedOwner") });
    rows.push({ label: "物品消耗（号主侧）", value: amountAt(amounts, "itemConsumedOwner") });
    rows.push({ label: "号主毛收入", value: amountAt(amounts, "ownerGross") });
    if (feePayer === "OWNER") rows.push({ label: `包赔费用（号主承担${rate ? ` · 费率 ${rate}` : ""}）`, value: amountAt(amounts, "feeAmount") });
    else if (feePayer === "RENTER") rows.push({ label: "包赔费用", value: "由租客承担", note: "不在号主净额中扣除" });
    rows.push({ label: "号主净入账", value: amountAt(amounts, "ownerNet"), note: "结算生效后进入可用余额" });
  }
  return rows;
}

export function previewAmounts(preview: SettlementPreview | null): Record<string, unknown> | null {
  return preview?.amounts ?? null;
}

export function versionAmounts(version: SettlementVersion | null | undefined): Record<string, unknown> | null {
  return version?.computation?.amounts ?? null;
}
