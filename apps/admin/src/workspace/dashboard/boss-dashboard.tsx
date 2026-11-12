import type { CSSProperties } from "react";

import { ActionQueue, DashboardPageHeader, RecentTable, StatCard, TrendPanel } from "../../components/dashboard/dashboard-components";
import { businessDashboardMetrics, type DashboardPayload, type DashboardRange } from "../../components/dashboard/model";

export function BossDashboard({
  data,
  range,
  onRange,
  onRefresh,
  refreshing,
  onNavigate,
}: {
  data: DashboardPayload;
  range: DashboardRange;
  onRange: (range: DashboardRange) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onNavigate: (path: string) => void;
}) {
  const metrics = businessDashboardMetrics(data);
  const scopeLabel = data.scope.mode === "ALL_GAMES" ? "全部游戏" : `授权 ${data.scope.gameIds.length} 个游戏`;
  // 先呈现能处理的事，再呈现指标：与 apps/admin/PRODUCT.md 的工作台原则一致。
  return <div className="space-y-5">
    <DashboardPageHeader
      title="经营总览"
      range={range}
      onRange={onRange}
      onRefresh={onRefresh}
      refreshing={refreshing}
      scopeLabel={scopeLabel}
    />
    <ActionQueue queues={data.queues} onNavigate={onNavigate} layout="grid" />
    <div className="dashboard-kpi-grid" style={{ "--dashboard-kpi-columns": String(Math.min(5, Math.max(1, metrics.length))) } as CSSProperties}>
      {metrics.map((metric) => <StatCard key={metric.id} metric={metric} onNavigate={onNavigate} />)}
    </div>
    <TrendPanel data={data} onNavigate={onNavigate} />
    <RecentTable orders={data.recentOrders} period={data.period} ordersState={data.recentOrdersState ?? data.metrics.find(metric => metric.id === "paidOrders")?.state ?? "UNAVAILABLE"} ordersDrilldown={data.metrics.find(metric => metric.id === "paidOrders")?.drilldown} onNavigate={onNavigate} />
  </div>;
}
