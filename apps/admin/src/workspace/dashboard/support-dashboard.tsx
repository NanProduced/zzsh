import type { CSSProperties } from "react";
import type { SessionSnapshot } from "../../api";
import { Headphones, MessagesSquare, UserRoundSearch } from "lucide-react";

import { ActionQueue, DashboardPageHeader, RecentTable, StatCard } from "../../components/dashboard/dashboard-components";
import type { DashboardPayload, DashboardRange } from "../../components/dashboard/model";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

export function SupportDashboard({
  data,
  snapshot,
  range,
  onRange,
  onRefresh,
  refreshing,
  onNavigate,
}: {
  data: DashboardPayload;
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  range: DashboardRange;
  onRange: (range: DashboardRange) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onNavigate: (path: string) => void;
}) {
  const has = (permission: string) => snapshot.security.isBoss || snapshot.permissions.includes(permission);
  const scopeLabel = data.scope.mode === "ALL_GAMES" ? "全部游戏" : `授权 ${data.scope.gameIds.length} 个游戏`;
  return <div className="space-y-5">
    <DashboardPageHeader
      title="客服工作台"
      range={range}
      onRange={onRange}
      onRefresh={onRefresh}
      refreshing={refreshing}
      scopeLabel={scopeLabel}
    />
    <div className="dashboard-kpi-grid" style={{ "--dashboard-kpi-columns": String(Math.min(5, Math.max(1, data.metrics.length))) } as CSSProperties}>
      {data.metrics.map((metric) => <StatCard key={metric.id} metric={metric} onNavigate={onNavigate} />)}
    </div>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <ActionQueue queues={data.queues} onNavigate={onNavigate} />
      <Card>
        <CardHeader><CardTitle>客服入口</CardTitle></CardHeader>
        <CardContent className="grid gap-2">
          {has("im.support.read") ? <><Button type="button" variant="outline" className="justify-start" onClick={() => onNavigate("/support")}><MessagesSquare aria-hidden="true" />客服工作台</Button>
          <Button type="button" variant="outline" className="justify-start" onClick={() => onNavigate("/support/mine")}><Headphones aria-hidden="true" />我的接待</Button></> : null}
          {has("im.support.management.read") ? <Button type="button" variant="outline" className="justify-start" onClick={() => onNavigate("/support/overview")}><UserRoundSearch aria-hidden="true" />客服统计</Button> : null}
          {has("order.read") ? <Button type="button" variant="outline" className="justify-start" onClick={() => onNavigate("/orders?origin=NATIVE")}>订单查询</Button> : null}
        </CardContent>
      </Card>
    </div>
    <RecentTable orders={data.recentOrders} period={data.period} ordersState={data.recentOrdersState ?? "UNAVAILABLE"} ordersDrilldown={data.metrics.find(metric => metric.id === "paidOrders")?.drilldown} onNavigate={onNavigate} allowContribution={false} />
  </div>;
}
