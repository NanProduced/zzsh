import type { OwnerQuote, RentalMode } from "./supply-types.ts";

export function centsOfMoney(money: { amount: string } | null | undefined): bigint | null {
  if (!money || !/^\d+(\.\d{1,2})?$/.test(money.amount)) return null;
  const [yuan, fraction = ""] = money.amount.split(".");
  return BigInt(yuan!) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
}

export function centsText(cents: bigint): string {
  const negative = cents < 0n;
  const value = negative ? -cents : cents;
  return `${negative ? "-" : ""}${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

export function yuanFromCents(cents: string): string | null {
  if (!/^\d+$/.test(cents)) return null;
  return centsText(BigInt(cents));
}

export function yuanToCents(text: string): string | null {
  const value = text.trim();
  if (!/^\d{1,18}(\.\d{1,2})?$/.test(value)) return null;
  return centsOfMoney({ amount: value })!.toString();
}

export type OwnerQuoteBreakdown = {
  haffCents: bigint;
  itemCents: bigint;
  totalCents: bigint;
};

export function ownerQuoteBreakdown(
  quote: Pick<OwnerQuote, "lines" | "ownerTotal"> | null | undefined,
): OwnerQuoteBreakdown | null {
  if (!quote) return null;
  let haffCents = 0n;
  let itemCents = 0n;
  for (const line of quote.lines) {
    const cents = centsOfMoney(line.ownerAmount);
    if (cents === null) return null;
    if (line.unit === "HAFF_BASE") haffCents += cents;
    else itemCents += cents;
  }
  const totalCents = centsOfMoney(quote.ownerTotal);
  if (totalCents === null) return null;
  // A quote whose line sum disagrees with its total is not a complete owner
  // quote; refuse to present it instead of repairing the amount client-side.
  if (totalCents !== haffCents + itemCents) return null;
  return { haffCents, itemCents, totalCents };
}

export function haffMText(quantity: string | null | undefined): string | null {
  if (quantity === null || quantity === undefined || !/^\d+$/.test(quantity)) return null;
  const value = BigInt(quantity);
  if (value % 1_000_000n === 0n) return `${(value / 1_000_000n).toString()} M`;
  if (value >= 1_000_000n) {
    return `${(value / 1_000_000n).toString()} M ${(value % 1_000_000n).toString()}`;
  }
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Exact M <-> base conversion; no floating point and no silent remainder loss.
export function haffMInputFromBase(quantity: string | null | undefined): string {
  if (quantity === null || quantity === undefined || !/^\d+$/.test(quantity)) return "";
  const value = BigInt(quantity);
  const whole = value / 1_000_000n;
  const fraction = value % 1_000_000n;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${String(fraction).padStart(6, "0").replace(/0+$/, "")}`;
}

export function baseFromHaffM(text: string): string | null {
  const value = text.trim();
  if (value === "") return null;
  if (!/^\d{1,18}(\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const digits = `${whole}${fraction.padEnd(6, "0")}`.replace(/^0+(?=\d)/, "");
  return BigInt(digits).toString();
}

export function baseQuantityText(quantity: string | null | undefined): string | null {
  if (quantity === null || quantity === undefined || !/^\d+$/.test(quantity)) return null;
  return quantity.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function roundGroupText(quantity: string | null | undefined, perGroup = 60): string | null {
  if (quantity === null || quantity === undefined || !/^\d+$/.test(quantity)) return null;
  const value = BigInt(quantity);
  const groups = value / BigInt(perGroup);
  const rest = value % BigInt(perGroup);
  if (groups === 0n && rest === 0n) return "0 发";
  return `${groups.toString()} 组${rest === 0n ? "" : ` ${rest.toString()} 发`}`;
}

export function minutesToTimeValue(minute: number | string | null | undefined): string {
  const value = typeof minute === "string" ? Number(minute) : minute;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1440) return "";
  if (value === 1440) return "24:00";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

export function timeValueToMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "24:00") return 1440;
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// Beijing (UTC+8, no DST) <-> instant conversion for datetime-local controls.
export function beijingInputFromIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const hour = part("hour") === "24" ? "00" : part("hour");
  return `${part("year")}-${part("month")}-${part("day")}T${hour}:${part("minute")}`;
}

export function isoFromBeijingInput(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month! < 1 || month! > 12 || day! < 1 || day! > 31 || hour! > 23 || minute! > 59) return null;
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour! - 8, minute!));
  if (Number.isNaN(date.getTime())) return null;
  if (beijingInputFromIso(date.toISOString()) !== trimmed) return null;
  return date.toISOString();
}

export function rentalModeLabel(mode: RentalMode | null | undefined): string {
  return ({ ordinary: "普通比例", custom: "自定义比例", fast: "极速比例" } as const)[mode ?? "ordinary"] ?? "普通比例";
}

export function ratioBoundText(bound: { base: "C" | "ABSOLUTE"; value: string } | null | undefined): string {
  if (!bound) return "未配置";
  if (bound.base === "ABSOLUTE") return bound.value;
  return Number(bound.value) < 0 ? `C${bound.value}` : `C+${bound.value}`;
}

export function ratioRangeText(
  mode: { min?: { base: "C" | "ABSOLUTE"; value: string }; max?: { base: "C" | "ABSOLUTE"; value: string } } | null | undefined,
): string | null {
  if (!mode?.min || !mode?.max) return null;
  return `${ratioBoundText(mode.min)} ~ ${ratioBoundText(mode.max)}`;
}

export function normalizeRatioInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,25}(\.\d{1,8})?$/.test(trimmed)) return null;
  const [whole, fraction] = trimmed.split(".");
  const normalized = `${whole!.replace(/^0+(?=\d)/, "")}${fraction ? `.${fraction.replace(/0+$/, "")}` : ""}`;
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

export function buildRentalPricing(
  mode: RentalMode,
  ownerRatioB: string,
): { rentalMode: RentalMode; ownerRatioB?: string } | null {
  if (mode === "ordinary") return { rentalMode: mode };
  const normalized = normalizeRatioInput(ownerRatioB);
  if (!normalized || Number(normalized) <= 0) return null;
  return { rentalMode: mode, ownerRatioB: normalized };
}

export function rentalPricingOf(
  attributes: Record<string, unknown>,
): { rentalMode: RentalMode; ownerRatioB?: string } | null {
  const value = attributes.rentalPricing;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as { rentalMode?: unknown; ownerRatioB?: unknown };
  if (!["ordinary", "custom", "fast"].includes(String(entry.rentalMode))) return null;
  const selection: { rentalMode: RentalMode; ownerRatioB?: string } = { rentalMode: entry.rentalMode as RentalMode };
  if (typeof entry.ownerRatioB === "string" && entry.ownerRatioB.trim() !== "") selection.ownerRatioB = entry.ownerRatioB.trim();
  return selection;
}

export function depositDeclarationCents(attributes: Record<string, unknown>): string | null {
  const value = attributes.owner_deposit_declaration;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amount = (value as { amountCents?: unknown }).amountCents;
  return typeof amount === "string" && /^\d+$/.test(amount) ? amount : null;
}

export function fullPayoutSelected(attributes: Record<string, unknown>): boolean | null {
  const value = attributes.full_payout_declaration;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const selected = (value as { selected?: unknown }).selected;
  return typeof selected === "boolean" ? selected : null;
}
