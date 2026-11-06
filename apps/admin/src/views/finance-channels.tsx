import { useEffect, useState } from "react";
import { adminRequest, type SessionSnapshot } from "../api";
import { AdminJoinpayOpsPanel, AdminWithdrawalQueryBox, AdminCollectionQueryBox } from "./admin-joinpay-ops-panel";
import { ChannelEvidenceLookup, OrderChannelEvidence, type ChannelSearchClue } from "./admin-channel-evidence-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ChevronDown } from "lucide-react";
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
  const [availability, setAvailability] = useState<{ scope: string; payout: boolean; collection: boolean } | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [availabilityRetry, setAvailabilityRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setAvailability(null); setAvailabilityError(null);
    if (canRead) void adminRequest<{payout?:{configured?:boolean};collection?:{configured?:boolean}}>("/joinpay/worker-status", undefined, "GET", {}, controller.signal)
      .then(value => { if (controller.signal.aborted) return; if (typeof value.payout?.configured === "boolean" && typeof value.collection?.configured === "boolean") setAvailability({scope,payout:value.payout.configured,collection:value.collection.configured}); else setAvailabilityError(scope); })
      .catch(() => { if (!controller.signal.aborted) setAvailabilityError(scope); });
    return () => controller.abort();
  }, [canRead, scope, availabilityRetry]);
  const currentAvailability = availability?.scope === scope ? availability : null;

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
        <p>先查本站保存的记录，需要时再向汇聚核实交易状态。</p>
      </div>
      <div className="flex flex-wrap gap-2">{canRead && returnPath && (!returnPath.startsWith('/orders/') || canOrderRead) ? <Button variant="outline" onClick={() => onOpenPath(returnPath)}>返回来源</Button> : null}
        <Dialog><DialogTrigger render={<Button variant="outline" size="sm"/>}>如何核对</DialogTrigger><DialogContent size="md"><DialogHeader><DialogTitle>如何核对一笔交易</DialogTitle><DialogDescription>例如用户反馈提现处理中，可以按下面的顺序查找。</DialogDescription></DialogHeader>
          <div className="space-y-4 text-sm leading-6 text-muted-foreground"><p><strong className="text-foreground">1. 找到编号：</strong>先在资金记录或订单详情中找到商户标识、原单号或渠道流水号。</p><p><strong className="text-foreground">2. 查看本站记录：</strong>在本页上方选择交易类型并查询。这里读取的是平台已保存的记录，不会请求汇聚。</p><p><strong className="text-foreground">3. 状态仍不明确时：</strong>对新平台已发起的收款或提现，可在下方按平台请求 ID 向汇聚补查。补查可能更新本站状态和账务，但不会新发起一笔交易。</p><p>旧平台记录请在资金记录的历史入口查看；渠道查询结果不代表银行最终到账。</p></div>
        </DialogContent></Dialog></div>
    </header>
    {!canRead ? <p role="status">当前无权读取渠道资金资料，请联系有权限的财务人员核对。</p> : <div key={scope} className="space-y-6">
      {/* 分组一：查看已保存证据（只读） */}
      <Card className="finance-channel-group-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">查找本站记录</CardTitle>
            <Badge variant="secondary" className="text-xs">只读 · 不请求汇聚</Badge>
          </div>
          <CardDescription className="text-xs text-muted-foreground">
            查询新平台已保存的渠道交易与凭证；旧平台记录请在资金记录的历史入口查看。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {orderId ? <section className="space-y-2"><h3 className="font-semibold text-sm">关联订单的渠道证据</h3><OrderChannelEvidence key={orderId} orderId={orderId} canRead autoLoad/></section> : null}
          <div>
            <ChannelEvidenceLookup key={tab.query.evidenceOrigin ?? ""} canRead canSearch initialSearch={initialSearch} onOpenOrder={canOrderRead ? openOrder : undefined} />
          </div>
          <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm"/>}>商户账户与补查任务状态<ChevronDown size={14} aria-hidden/></CollapsibleTrigger><CollapsibleContent className="pt-3"><AdminJoinpayOpsPanel canRead canWithdrawalQuery={false} /></CollapsibleContent></Collapsible>
        </CardContent>
      </Card>

      {/* 分组二：主动向渠道补查并更新处理结果（独立操作） */}
      <Card className="finance-channel-group-card border-amber-500/25 bg-amber-500/[0.02]">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold text-amber-600 dark:text-amber-400">向汇聚核实状态</CardTitle>
            <Badge variant="outline" className="text-xs border-amber-500/40 text-amber-600 dark:text-amber-400">会请求汇聚</Badge>
          </div>
          <CardDescription className="text-xs text-muted-foreground">
            仅查询已发起的新平台交易，可复制上方记录中的“平台请求 ID”。查询可能更新本站状态和账务；退款请在订单详情中补查。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!currentAvailability ? <p role="status" className="text-xs text-muted-foreground">{availabilityError === scope ? <>渠道查询状态暂不可读取。<Button type="button" variant="link" size="sm" onClick={()=>setAvailabilityRetry(value=>value+1)}>重试</Button></> : "正在确认渠道查询状态…"}</p> : null}
          <div>
            <h3 className="font-semibold text-sm mb-1.5">核实提现结果</h3>
            {canWithdrawalQuery ? (
              <>{currentAvailability?.payout === false ? <p className="mb-2 text-xs text-muted-foreground" role="status">当前环境未接入提现查询。</p> : null}<AdminWithdrawalQueryBox unavailable={currentAvailability?.payout !== true} /></>
            ) : (
              <p className="oc-fact-note text-xs text-muted-foreground">需要提现补查权限（finance.withdrawal.query 或主管身份）以同步渠道提现结果。</p>
            )}
          </div>
          <div className="pt-4 border-t border-border/50">
            <h3 className="font-semibold text-sm mb-1.5">核实收款结果</h3>
            {canCollectionWrite ? (
              <>{currentAvailability?.collection === false ? <p className="mb-2 text-xs text-muted-foreground" role="status">当前环境未接入收款查询。</p> : null}<AdminCollectionQueryBox canWrite unavailable={currentAvailability?.collection !== true} /></>
            ) : (
              <p className="oc-fact-note text-xs text-muted-foreground">需要订单结算写权限（order.settlement.write 或主管身份）以补查渠道收款结果。</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>}
  </section>;
}
