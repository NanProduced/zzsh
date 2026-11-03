import { adminRequest } from "../../api";

export type DomainSummary = {
  schema: "admin.domain-summary.v1";
  domain: "USERS" | "ORDERS";
  state: "KNOWN" | "PARTIAL" | "UNKNOWN" | "FORBIDDEN" | "NO_GAME_SCOPE";
  reason: string | null;
  asOf: string;
  total: string | null;
  coverage: "FULL_AUTHORIZED_FILTER_SET" | null;
  drilldown: { filters: Record<string, string> } | null;
  statuses: Array<{ status: string; count: string; drilldown: { filters: Record<string, string> } | null }> | null;
  membership: { state: "UNKNOWN" | "FORBIDDEN"; reason: string; counts: null } | null;
};
export const DOMAIN_STATUS_LABELS: Record<DomainSummary["domain"], Record<string, string>> = {
  USERS: { ACTIVE: "正常", RESTRICTED: "受限", FROZEN: "已冻结", CANCELLED: "已注销", UNKNOWN: "状态待核" },
  ORDERS: { PENDING_PAYMENT: "待付款", PAID: "已付款", COMPLETED: "已完成", CANCELLED: "已取消", UNKNOWN: "状态待核" },
};
const exactCount = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d{0,39})$/.test(value);
export const domainCount = (value: string) => BigInt(value).toLocaleString("zh-CN");

export function parseDomainSummary(raw: unknown, domain: DomainSummary["domain"]): DomainSummary {
  const value = raw as DomainSummary;
  if (!value || value.schema !== "admin.domain-summary.v1" || value.domain !== domain
    || !["KNOWN", "PARTIAL", "UNKNOWN", "FORBIDDEN", "NO_GAME_SCOPE"].includes(value.state)
    || typeof value.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.asOf) || !Number.isFinite(Date.parse(value.asOf))) throw new Error("统计响应格式无效");
  if (value.state === "KNOWN") {
    const statuses = Object.keys(DOMAIN_STATUS_LABELS[domain]);
    if (!exactCount(value.total) || value.coverage !== "FULL_AUTHORIZED_FILTER_SET" || !Array.isArray(value.statuses)
      || value.statuses.length !== statuses.length || new Set(value.statuses.map(item => item.status)).size !== statuses.length
      || value.statuses.some(item => !statuses.includes(item.status) || !exactCount(item.count))
      || value.statuses.reduce((sum, item) => sum + BigInt(item.count), 0n) !== BigInt(value.total)) throw new Error("统计响应格式无效");
  } else if (value.total !== null || value.statuses !== null) throw new Error("统计响应格式无效");
  return value;
}

export async function readDomainSummary(domain: DomainSummary["domain"], query: URLSearchParams, signal: AbortSignal): Promise<DomainSummary> {
  const path = domain === "USERS" ? "users" : "orders";
  const raw = await adminRequest<unknown>(`/${path}/overview-stats?${query}`, undefined, "GET", {}, signal);
  return parseDomainSummary(raw, domain);
}

export function domainSummaryReason(summary: DomainSummary): string {
  if (summary.state === "FORBIDDEN") return "当前权限不含这组统计。";
  if (summary.state === "NO_GAME_SCOPE") return "尚未分配可读取的游戏范围。";
  if (summary.reason === "USER_GAME_SCOPE_AGGREGATE_NOT_SUPPORTED") return "当前游戏范围的用户归属尚不能完整核定，人数暂不可用。";
  if (summary.reason === "MEMBERSHIP_TIER_FILTER_AGGREGATE_NOT_SUPPORTED") return "当前会员筛选的全范围统计暂不可用；下方列表可继续查询。";
  return "当前筛选的统计暂不可用，请稍后刷新；未用当前页记录补算。";
}
