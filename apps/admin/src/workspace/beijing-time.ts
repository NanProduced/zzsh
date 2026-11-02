export const BEIJING_TIME_ZONE = "Asia/Shanghai";
export const WORKSPACE_TIME_RANGES = ["today", "7d", "30d"] as const;
export type WorkspaceTimeRange = (typeof WORKSPACE_TIME_RANGES)[number];

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BEIJING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Business timestamps use Beijing time even when an operator's browser is elsewhere. */
export function formatBeijingDateTime(value: string | null | undefined, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  if (!value) return "未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: BEIJING_TIME_ZONE }).format(date);
}

export function beijingCalendarDate(now = new Date()): string {
  return formatter.format(now);
}

export function beijingTodayStart(now = new Date()): Date {
  const date = beijingCalendarDate(now);
  return new Date(`${date}T00:00:00+08:00`);
}

export function timeRangeLabel(range: WorkspaceTimeRange, now = new Date()): string {
  const today = beijingCalendarDate(now);
  if (range === "today") return `今天（北京时间 ${today}）`;
  if (range === "7d") return `近 7 天（截至北京时间 ${today}）`;
  return `近 30 天（截至北京时间 ${today}）`;
}

export function persistTimeRange(range: string | null | undefined): WorkspaceTimeRange {
  return range === "7d" || range === "30d" ? range : "today";
}

export function beijingRangeStart(range: WorkspaceTimeRange, now = new Date()): Date {
  const today = beijingTodayStart(now);
  if (range === "today") return today;
  const days = range === "7d" ? 6 : 29;
  return new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
}

export function inBeijingRange(value: string | null | undefined, range: WorkspaceTimeRange, now = new Date()): boolean {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() >= beijingRangeStart(range, now).getTime() && date.getTime() <= now.getTime();
}
