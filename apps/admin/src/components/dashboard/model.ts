import { beijingCalendarDate } from "../../workspace/beijing-time.ts";

export class DashboardContractError extends Error {
  readonly status = 502;
  readonly code = "DASHBOARD_CONTRACT_INVALID";
  constructor() { super("工作台数据格式异常"); this.name = "DashboardContractError"; }
}

export type DashboardPreset = "BOSS" | "OPS" | "SUPPORT";
export type DashboardRange = "today" | "7d" | "30d";
export type DashboardState = "KNOWN" | "PARTIAL" | "FORBIDDEN" | "NO_GAME_SCOPE" | "UNAVAILABLE";
export type DashboardMetric = {
  id: string;
  label: string;
  value: string | null;
  unit: "COUNT" | "CNY_CENTS";
  state: DashboardState;
  definition: string;
  coverage: { knownCount: number; totalCount: number } | null;
  delta: { value: string; direction: "UP" | "DOWN" | "FLAT"; percent: string | null } | null;
  sparkline: string[];
  drilldown: string | null;
};
export type DashboardQueue = {
  id: string;
  label: string;
  count: number;
  oldestAgeSeconds: number | null;
  severity: "INFO" | "WARN" | "CRITICAL" | "UNKNOWN";
  drilldown: string | null;
};
export type DashboardRecentOrder = {
  id: string;
  displayNo: string;
  status: "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED" | "UNKNOWN";
  paidAt: string | null;
  confirmedCents: string | null;
  contributionCents: string | null;
  contributionState: "SETTLED" | "QUOTED" | "UNAVAILABLE";
  currency: "CNY";
};
export type DashboardPayload = {
  version: "admin.dashboard.v1";
  preset: DashboardPreset;
  observedAt: string;
  period: { range: DashboardRange; from: string; to: string; timeZone: "Asia/Shanghai"; paymentConfirmedTo?: string | null };
  comparison: { from: string; to: string };
  scope: { mode: "ALL_GAMES" | "SELECTED_GAMES"; gameIds: string[] };
  metrics: DashboardMetric[];
  trend: Array<{ date: string; confirmedCents: string | null; paidOrders: string; quotedSpreadCents: string | null; settledContributionCents: string | null }>;
  queues: DashboardQueue[];
  recentOrders: DashboardRecentOrder[];
  recentOrdersState?: DashboardState;
};

const PRESETS: DashboardPreset[] = ["BOSS", "OPS", "SUPPORT"];
const RANGES: DashboardRange[] = ["today", "7d", "30d"];
const STATES: DashboardState[] = ["KNOWN", "PARTIAL", "FORBIDDEN", "NO_GAME_SCOPE", "UNAVAILABLE"];
const COUNT = /^(0|[1-9]\d*)$/;
const SIGNED = /^-?(0|[1-9]\d*)$/;

function text(value: unknown): value is string { return typeof value === "string"; }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function count(value: unknown): value is string { return text(value) && COUNT.test(value); }
function metric(value: unknown): value is DashboardMetric {
  if (!object(value) || !text(value.id) || !text(value.label) || !text(value.definition) || !Array.isArray(value.sparkline) || !value.sparkline.every((item) => text(item)) || !STATES.includes(value.state as DashboardState)) return false;
  if (value.unit !== "COUNT" && value.unit !== "CNY_CENTS") return false;
  const numeric = value.unit === "CNY_CENTS" ? text(value.value) && SIGNED.test(value.value) : count(value.value);
  if (value.state === "KNOWN" ? !numeric : value.state === "PARTIAL" ? !(value.value === null || numeric) : value.value !== null) return false;
  if (value.state === "PARTIAL" && !object(value.coverage)) return false;
  if (value.coverage !== null && (!object(value.coverage) || !Number.isInteger(value.coverage.knownCount) || !Number.isInteger(value.coverage.totalCount))) return false;
  if (value.delta !== null) {
    if (!object(value.delta) || !SIGNED.test(String(value.delta.value)) || !["UP", "DOWN", "FLAT"].includes(String(value.delta.direction)) || !(value.delta.percent === null || text(value.delta.percent))) return false;
  }
  return value.drilldown === null || text(value.drilldown);
}

export function parseDashboardPayload(value: unknown): DashboardPayload {
  if (!object(value) || value.version !== "admin.dashboard.v1" || !PRESETS.includes(value.preset as DashboardPreset)
    || !text(value.observedAt) || !object(value.period) || !RANGES.includes(value.period.range as DashboardRange)
    || value.period.timeZone !== "Asia/Shanghai" || !text(value.period.from) || !text(value.period.to)
    || ![value.observedAt, value.period.from, value.period.to].every((time) => Number.isFinite(Date.parse(time)))
    || value.period.paymentConfirmedTo !== undefined && value.period.paymentConfirmedTo !== null && (!text(value.period.paymentConfirmedTo) || !Number.isFinite(Date.parse(value.period.paymentConfirmedTo)))
    || !object(value.comparison) || !text(value.comparison.from) || !text(value.comparison.to)
    || !object(value.scope) || !["ALL_GAMES", "SELECTED_GAMES"].includes(String(value.scope.mode)) || !Array.isArray(value.scope.gameIds) || !value.scope.gameIds.every(text)
    || !Array.isArray(value.metrics) || !value.metrics.every(metric)
    || !Array.isArray(value.trend) || !Array.isArray(value.queues) || !Array.isArray(value.recentOrders)
    || value.recentOrdersState !== undefined && !STATES.includes(value.recentOrdersState as DashboardState)) {
    throw new DashboardContractError();
  }
  return value as DashboardPayload;
}

export function formatCents(value: string | null): string {
  if (typeof value !== "string" || !SIGNED.test(value)) return "—";
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const cents = BigInt(digits);
  const yuan = (cents / 100n).toLocaleString("zh-CN");
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}¥${yuan}.${fraction}`;
}

export function formatCount(value: string | number | null): string {
  if (value === null) return "—";
  const textValue = String(value);
  return COUNT.test(textValue) && (typeof value !== "number" || Number.isSafeInteger(value)) ? BigInt(textValue).toLocaleString("zh-CN") : "—";
}

export function formatDashboardPeriod(period: DashboardPayload["period"]): string {
  if (![period.from, period.to].every((value) => Number.isFinite(Date.parse(value)))) return "期间尚未核定";
  return `${beijingCalendarDate(new Date(period.from))} 至 ${beijingCalendarDate(new Date(period.to))} · 北京时间`;
}

export function dashboardOrdersPath(period: DashboardPayload["period"], serverDrilldown?: string | null): string | null {
  let to = period.paymentConfirmedTo;
  if (serverDrilldown) {
    if (!serverDrilldown.startsWith("/orders?") || /[#\\]/.test(serverDrilldown)) return null;
    const query = new URLSearchParams(serverDrilldown.slice("/orders?".length));
    if (query.has("paidFrom") || query.has("paidTo")) {
      const paidTo = query.get("paidTo");
      if (query.size !== 2 || query.get("paidFrom") !== period.from || !paidTo || to && paidTo !== to
        || ![period.from, paidTo].every(value => Number.isFinite(Date.parse(value)))) return null;
      return `/orders?${new URLSearchParams({ paidFrom: period.from, paidTo })}`;
    }
    if ([...query.keys()].some(key => !["origin", "paymentConfirmedFrom", "paymentConfirmedTo"].includes(key)) || ["origin", "paymentConfirmedFrom", "paymentConfirmedTo"].some(key => query.getAll(key).length !== 1) || query.get("origin") !== "NATIVE" || query.get("paymentConfirmedFrom") !== period.from) return null;
    const suppliedTo = query.get("paymentConfirmedTo");
    if (to && suppliedTo !== to) return null;
    to = suppliedTo;
  }
  if (!to || ![period.from, to].every((value) => Number.isFinite(Date.parse(value)))) return null;
  return `/orders?${new URLSearchParams({ origin: "NATIVE", paymentConfirmedFrom: period.from, paymentConfirmedTo: to })}`;
}

export function businessDashboardMetrics(data: DashboardPayload): DashboardMetric[] {
  return ["confirmedCents", "quotedSpread", "settledContribution", "paidOrders"]
    .map((id) => data.metrics.find((metric) => metric.id === id))
    .filter((metric): metric is DashboardMetric => Boolean(metric));
}

export function formatAge(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

export function formatDelta(metric: DashboardMetric): string {
  if (!metric.delta) return "—";
  if (metric.delta.direction === "FLAT") return "持平";
  const sign = metric.delta.direction === "UP" ? "+" : "";
  if (metric.unit === "CNY_CENTS") return `${sign}${formatCents(metric.delta.value)}`;
  const negative = metric.delta.value.startsWith("-");
  return `${negative ? "-" : sign}${formatCount(negative ? metric.delta.value.slice(1) : metric.delta.value)}`;
}

export function metricValue(metric: DashboardMetric): string {
  if (metric.state !== "KNOWN" && metric.state !== "PARTIAL") return "—";
  if (metric.value === null) return "—";
  return metric.unit === "CNY_CENTS" ? formatCents(metric.value) : formatCount(metric.value);
}

const SHORT_NOTES: Record<string, string> = {
  confirmedCents: "含押金 · 未扣退款",
  quotedSpread: "冻结报价估算 · 非最终收益",
  settledContribution: "过账分量 · 非净利润",
  paidOrders: "本期已付款订单",
  ordersPendingPayment: "未过期待付款",
  ordersPaid: "已付款，待完成订单处理",
  listingsPendingReview: "等待审核",
  supportWaiting: "当前排队咨询",
  supportMine: "分配给我的咨询",
  pendingApprovals: "待你审批",
};

export function metricNote(metric: DashboardMetric): string {
  if (metric.state === "FORBIDDEN") return "无读取权限";
  if (metric.state === "NO_GAME_SCOPE") return "不在当前游戏范围";
  if (metric.state === "UNAVAILABLE") return "暂不可用";
  if (metric.state === "PARTIAL") {
    return metric.coverage ? `已覆盖 ${metric.coverage.knownCount}/${metric.coverage.totalCount} 单` : "覆盖不完整";
  }
  if (metric.coverage?.totalCount === 0) return "本期暂无数据";
  return SHORT_NOTES[metric.id] ?? metric.definition;
}
