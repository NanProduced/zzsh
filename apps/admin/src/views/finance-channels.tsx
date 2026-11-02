import type { SessionSnapshot } from "../api";
import { AdminJoinpayOpsPanel } from "./admin-joinpay-ops-panel";
import { ChannelEvidenceLookup } from "./admin-channel-evidence-panel";
import "./admin-finance.css";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;

/** Existing explicit commands retain their own permissions, original keys and recovery contracts. */
export function FinanceChannels({ snapshot }: { snapshot: Snapshot }) {
  const active = snapshot.security.status === "ACTIVE" && !snapshot.security.passwordChangeRequired && !snapshot.session.locked;
  const canRead = active && snapshot.permissions.includes("finance.read");
  const scope = [snapshot.adminUserId, snapshot.session.id, active, snapshot.permissions.slice().sort().join(",")].join("|");
  return <section className="finance-page finance-channels" aria-labelledby="finance-channels-title">
    <header className="finance-page-header"><div><h1 id="finance-channels-title">渠道工具</h1><p>核对商户、原单号及本站已保存的渠道证据。</p></div></header>
    {!canRead ? <p role="status">当前无权读取渠道资金资料，请联系有权限的财务人员核对。</p> : <div key={scope} className="space-y-6">
      <p className="text-sm text-muted-foreground">普通读取仅查看已保存的记录。主动同步是独立操作，可能更新本站的付款、退款或提现处理结果；渠道状态与银行到账分别核对。</p>
      <AdminJoinpayOpsPanel canRead canWithdrawalQuery={snapshot.security.isBoss || snapshot.permissions.includes("finance.withdrawal.query")} />
      <ChannelEvidenceLookup canRead canSearch />
    </div>}
  </section>;
}
