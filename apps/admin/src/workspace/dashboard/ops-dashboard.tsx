import type { CSSProperties } from "react";

import { ActionQueue, DashboardPageHeader, RecentTable, StatCard, TrendPanel } from "../../components/dashboard/dashboard-components";
import { businessDashboardMetrics, type DashboardPayload, type DashboardRange } from "../../components/dashboard/model";

export function OpsDashboard({
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
      title="运营工作台"
      description="按当前权限核对收款、报价预估价差、已结算贡献和付款订单，再处理运营待办。"
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
    <p className="text-[11px] leading-5 text-muted-foreground">确认收款含押金，未扣退款；报价预估价差不是最终收益，已结算贡献不是净利润。指标与队列均以当前授权范围为准。</p>
  </div>;
}
