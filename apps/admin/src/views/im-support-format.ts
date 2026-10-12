/** Shared read-only formatting for both the consultation and order workbenches. */
const DISPLAY_TIME_ZONE = "Asia/Shanghai";
type DateParts = { year: number; month: number; day: number };

function partsOf(value: string | number): DateParts | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en", { timeZone: DISPLAY_TIME_ZONE, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const result = { year: get("year"), month: get("month") - 1, day: get("day") };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function keyOf(parts: DateParts): string { return `${parts.year}-${parts.month}-${parts.day}`; }

export function formatTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { timeZone: DISPLAY_TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(date) : "—";
}
export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "时间暂不可用";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { timeZone: DISPLAY_TIME_ZONE, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date) : "时间暂不可用";
}
export function dayKeyOf(createTime?: number): string | null {
  if (createTime === undefined) return null;
  const parts = partsOf(createTime);
  return parts ? keyOf(parts) : null;
}
export function dayLabelOf(key: string): string {
  const parts = key.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return "日期暂不可用";
  const today = partsOf(Date.now());
  if (today && key === keyOf(today)) return "今天";
  if (today) {
    const yesterday = new Date(Date.UTC(today.year, today.month, today.day) - 86_400_000);
    if (key === keyOf({ year: yesterday.getUTCFullYear(), month: yesterday.getUTCMonth(), day: yesterday.getUTCDate() })) return "昨天";
  }
  return `${parts[1]! + 1}月${parts[2]}日`;
}
export function initialOf(name: string): string {
  const trimmed = (name || "").trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}
export function formatBytes(value: number): string { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(value / 1024))} KiB`; }
