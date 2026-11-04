import type { SessionSnapshot } from "../api";
import { AdminJoinpayOpsPanel, AdminWithdrawalQueryBox, AdminCollectionQueryBox } from "./admin-joinpay-ops-panel";
import { ChannelEvidenceLookup, OrderChannelEvidence, type ChannelSearchClue } from "./admin-channel-evidence-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WorkspaceTab } from "../workspace/tab-model";
import { financeChannelSearch, financeContextIdentity, financeOriginPath, registerFinanceOrigin } from "./admin-finance-view";
import "./admin-finance.css";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;

/** Existing explicit commands retain their own permissions, original keys and recovery contracts. */
export function FinanceChannels({ snapshot, tab, onOpenPath }: { snapshot: Snapshot; tab: WorkspaceTab; onOpenPath: (path: string, title?: string) => void }) {
  const active = snapshot.security.status === "ACTIVE" && !snapshot.security.passwordChangeRequired && !snapshot.session.locked;
  const canRead = active && snapshot.permissions.includes("finance.read");
  const canWithdrawalQuery = active && (snapshot.security.isBoss || snapshot.permissions.includes("finance.withdrawal.query"));
  const canCollectionWrite = active && (snapshot.security.isBoss || snapshot.permissions.includes("order.settlement.write"));
  const scope = [snapshot.adminUserId, snapshot.session.id, active, snapshot.security.isBoss, snapshot.permissions.slice().sort().join(",")].join("|");

  const canOrderRead = canRead && (snapshot.security.isBoss || snapshot.permissions.includes('order.read'));
  const orderId = canOrderRead && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tab.query.fromOrderId ?? '') ? tab.query.fromOrderId : undefined;
  const returnPath = financeOriginPath(tab.query.origin, snapshot, tab.query.financeReturn);
  const initialSearch = financeChannelSearch(tab.query.evidenceOrigin, snapshot);
  function openOrder(id: string, clue: ChannelSearchClue) {
    const source = '/finance/channels' + (orderId ? '?' + new URLSearchParams({fromOrderId:orderId}) : '');
    const origin = registerFinanceOrigin(source, financeContextIdentity(snapshot), clue);
    onOpenPath('/orders/' + encodeURIComponent(id) + '?' + new URLSearchParams({section:'finance', financeOrigin:origin, financeReturn:source}));
  }

  return <section className="finance-page finance-channels" aria-labelledby="finance-channels-title">
    <header className="finance-page-header">
      <div>
        <h1 id="finance-channels-title">汇聚对账</h1>
        <p>核对商户原单号、渠道流水及本站已保存的收款、退款和出款证据；支持按原单主动向渠道核实状态。</p>
      </div>
      {canRead && returnPath && (!returnPath.startsWith('/orders/') || canOrderRead) ? <Button variant="outline" onClick={() => onOpenPath(returnPath)}>返回来源</Button> : null}
    </header>
    {!canRead ? <p role="status">当前无权读取渠道资金资料，请联系有权限的财务人员核对。</p> : <div key={scope} className="space-y-6">
      {/* 分组一：查看已保存证据（只读） */}
      <Card className="finance-channel-group-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">查看已保存证据（只读）</CardTitle>
            <Badge variant="secondary" className="text-xs">只读 · 不调用渠道接口</Badge>
          </div>
          <CardDescription className="text-xs text-muted-foreground">
            仅查看本站已登记保存的渠道运行状态、商户账户快照以及原单凭证。不向第三方渠道发起调用，不改变本站数据状态。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {orderId ? <section className="space-y-2"><h3 className="font-semibold text-sm">关联订单的渠道证据</h3><OrderChannelEvidence key={orderId} orderId={orderId} canRead autoLoad/></section> : null}
          <div>
            <h3 className="font-semibold text-sm mb-2">检索已登记渠道交易</h3>
            <ChannelEvidenceLookup key={tab.query.evidenceOrigin ?? ""} canRead canSearch initialSearch={initialSearch} onOpenOrder={canOrderRead ? openOrder : undefined} />
          </div>
          <AdminJoinpayOpsPanel canRead canWithdrawalQuery={false} />
        </CardContent>
      </Card>

      {/* 分组二：主动向渠道补查并更新处理结果（独立操作） */}
      <Card className="finance-channel-group-card border-amber-500/25 bg-amber-500/[0.02]">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold text-amber-600 dark:text-amber-400">主动向渠道补查并更新处理结果（独立操作）</CardTitle>
            <Badge variant="outline" className="text-xs border-amber-500/40 text-amber-600 dark:text-amber-400">独立操作 · 产生渠道请求</Badge>
          </div>
          <CardDescription className="text-xs text-muted-foreground">
            按原单号主动调用第三方渠道接口核实最新状态。该操作可能推进本站付款确认、退款或提现的处理状态并触发记账。渠道成功不等于银行到账；切换原号时自动清理历史回执。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <h3 className="font-semibold text-sm mb-1.5">提现结果主动同步</h3>
            {canWithdrawalQuery ? (
              <AdminWithdrawalQueryBox />
            ) : (
              <p className="oc-fact-note text-xs text-muted-foreground">需要提现补查权限（finance.withdrawal.query 或主管身份）以同步渠道提现结果。</p>
            )}
          </div>
          <div className="pt-4 border-t border-border/50">
            <h3 className="font-semibold text-sm mb-1.5">收款结果主动补查</h3>
            {canCollectionWrite ? (
              <AdminCollectionQueryBox canWrite />
            ) : (
              <p className="oc-fact-note text-xs text-muted-foreground">需要订单结算写权限（order.settlement.write 或主管身份）以补查渠道收款结果。</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>}
  </section>;
}
