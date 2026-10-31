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

/**
 * 会话列表时间：刚刚/分钟前 → 今天 HH:mm → 昨天 → 最近一周星期 → 月日 → 年月日。
 * 列表只显示时间会让昨天的消息看起来像今天，必须带出日期层级。
 */
export function formatListTime(value: string | number | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return "";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const diff = now - ms;
  if (diff >= 0 && diff < 60_000) return "刚刚";
  if (diff >= 0 && diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  const parts = partsOf(ms);
  const today = partsOf(now);
  if (!parts || !today) return formatTime(ms);
  const date = new Date(ms);
  if (keyOf(parts) === keyOf(today)) return formatTime(ms);
  const dayNumber = Date.UTC(parts.year, parts.month, parts.day) / 86_400_000;
  const todayNumber = Date.UTC(today.year, today.month, today.day) / 86_400_000;
  const daysAgo = todayNumber - dayNumber;
  if (daysAgo === 1) return "昨天";
  if (daysAgo > 1 && daysAgo < 7) return new Intl.DateTimeFormat("zh-CN", { timeZone: DISPLAY_TIME_ZONE, weekday: "short" }).format(date);
  if (parts.year === today.year) return `${parts.month + 1}月${parts.day}日`;
  return `${parts.year}年${parts.month + 1}月${parts.day}日`;
}
export function formatMonthDay(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { timeZone: DISPLAY_TIME_ZONE, month: "numeric", day: "numeric" }).format(date) : "";
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
