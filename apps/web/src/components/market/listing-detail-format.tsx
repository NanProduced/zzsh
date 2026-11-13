import { formatReferenceYuan } from "@zzsh/ui/display-money";
import { canonicalResourceCode } from "@/lib/listing-filters";
import { resourceQuantityLabel, type ListingDetailData, type ResourceLine } from "@/lib/listing-view";
import type { Order } from "@/lib/order-client";

const ITEM_ART_MAP: Record<string, string> = {
  df_billable_level6_helmet: "/art/delta/items/level6-helmet-dich9.png",
  level6_helmet: "/art/delta/items/level6-helmet-dich9.png",
  df_billable_level6_armor: "/art/delta/items/level6-armor-mas2.png",
  level6_armor: "/art/delta/items/level6-armor-mas2.png",
  df_billable_coffee: "/art/delta/items/coffee-beans.png",
  coffee: "/art/delta/items/coffee-beans.png",
  df_billable_awm_bullet: "/art/delta/items/awm-ammo.png",
  awm_round: "/art/delta/items/awm-ammo.png",
  df_billable_barrett_bullet: "/art/delta/items/barrett-ammo.png",
  barrett_round: "/art/delta/items/barrett-ammo.png",
  legacy_barrett_round: "/art/delta/items/barrett-ammo.png",
  df_billable_turtle_backpack_45: "/art/delta/items/turtle-backpack-45.png",
  turtle_backpack_45: "/art/delta/items/turtle-backpack-45.png",
  df_billable_level6_bullet: "/art/delta/items/level6-ammo.png",
  level6_round: "/art/delta/items/level6-ammo.png",
  df_billable_top_insure_card: "/art/delta/items/insurance-experience-card-thumb.png",
  top_insure_card_piece: "/art/delta/items/insurance-experience-card-thumb.png",
  df_billable_top_insure_card_piece: "/art/delta/items/insurance-experience-card-thumb.png",
  legacy_insurance_day: "/art/delta/items/insurance-experience-card-thumb.png",
};

export function conditionValue(data: ListingDetailData, key: string): string | null {
  return data.conditionLines.find((line) => line.key === key)?.value ?? null;
}

export function regionValue(data: ListingDetailData): string {
  const parts = [conditionValue(data, "region_province"), conditionValue(data, "region_city")].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : "未提供";
}

export function displayTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(value))
    .replaceAll("/", "-");
}

export function withheldSkinsNote(count: number | undefined): string | null {
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0
    ? `另有 ${count} 项已申报皮肤当前未公开展示。`
    : null;
}

export function entitlementExpiryLabel(
  item: { expiresAt: string | null; expiryState: "MISSING" | "PERMANENT" | "TIMED" },
  now = Date.now(),
): string {
  if (item.expiryState === "MISSING") return "期限未提供 · 覆盖范围以个人确认时为准";
  if (item.expiryState === "PERMANENT") return "长期权益 · 不保证覆盖全部租期";
  const time = displayTime(item.expiresAt);
  if (!time) return "到期时间未确认 · 覆盖范围以个人确认时为准";
  return `${Date.parse(item.expiresAt!) <= now ? "已到期" : "到期"} ${time} · 不保证覆盖全部租期`;
}

export function formatItemUnitPrice(line: ResourceLine): string {
  const full = unitPriceText(line);
  return full.split(" / ")[0] ?? full;
}

export function unitPriceText(line: ResourceLine): string {
  if (!line.unitPriceLabel) return "未确认";
  const match = line.unitPriceLabel.match(/^(.+?)\s*\/\s*(\d+)\s+(.+)$/);
  if (!match) return "未确认";
  const formatted = formatReferenceYuan(match[1]);
  if (!formatted) return "未确认";
  const amount = formatted.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  const grouped = canonicalResourceCode(line.code) === "df_billable_level6_bullet" && match[2] === "60" && match[3] === "发";
  return `${amount} / ${grouped ? "组" : `${match[2] === "1" ? "" : match[2]}${match[3]}`}`;
}

export function inventoryQuantityText(line: ResourceLine): string {
  return line.quantity == null || line.quantity === "" ? "未提供" : resourceQuantityLabel(line);
}

export function loginMethodText(data: ListingDetailData): { text: string; hint: string } {
  const raw = conditionValue(data, "login_method_code") || "";
  if (raw.includes("QQ") && (raw.includes("扫码") || raw.includes("scan"))) {
    return { text: "QQ扫码上号", hint: "由客服提供二维码" };
  }
  if (raw.includes("微信") || raw.includes("wx")) {
    return { text: "微信扫码上号", hint: "由客服提供二维码" };
  }
  if (raw.includes("账密") || raw.includes("password")) {
    return { text: "QQ账密上号", hint: "客服协助安全上号" };
  }
  return { text: raw || "未提供", hint: "由客服协助上号" };
}

export function linkedOrderTermText(order: Order): string {
  const seconds = Number(order.termSeconds);
  if (!order.termSeconds || !Number.isSafeInteger(seconds) || seconds <= 0) return "以订单页为准";
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  return `${Math.floor(seconds / 60)} 分钟`;
}

export function presentedCondition(data: ListingDetailData, key: string): string {
  const raw = conditionValue(data, key);
  return !raw ? "未提供" : raw.startsWith("未确认（代码") ? "未确认" : raw;
}
