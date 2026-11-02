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
  return <div className="space-y-5">
    <DashboardPageHeader
      title="经营总览"
      description="先看收款、报价预估价差和已结算贡献，再处理真正需要你介入的异常。"
      range={range}
      onRange={onRange}
      onRefresh={onRefresh}
      refreshing={refreshing}
      scopeLabel={scopeLabel}
    />
    <div className="dashboard-kpi-grid" style={{ "--dashboard-kpi-columns": String(Math.min(5, Math.max(1, metrics.length))) } as CSSProperties}>
      {metrics.map((metric) => <StatCard key={metric.id} metric={metric} onNavigate={onNavigate} />)}
    </div>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <TrendPanel data={data} onNavigate={onNavigate} />
      <ActionQueue queues={data.queues} onNavigate={onNavigate} />
    </div>
    <RecentTable orders={data.recentOrders} period={data.period} ordersState={data.recentOrdersState ?? data.metrics.find(metric => metric.id === "paidOrders")?.state ?? "UNAVAILABLE"} ordersDrilldown={data.metrics.find(metric => metric.id === "paidOrders")?.drilldown} onNavigate={onNavigate} />
    <p className="text-[11px] leading-5 text-muted-foreground">
      确认收款含押金，未扣退款；报价预估价差是冻结报价中的资源价差估算，不是最终收益；已结算贡献不是净利润。历史迁移存量不在本页经营趋势中。
    </p>
  </div>;
}
