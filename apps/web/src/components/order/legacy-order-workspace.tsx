"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useUserSession } from "@/components/session/user-session-provider";
import { orderApi, formatOrderMoney, formatOrderTime, OrderRequestError, type LegacyOrder, type LegacyOrderPage, type OrderParty, type OrderStatusFilter, type OrderSearchFilters } from "@/lib/order-client";
import { orderTermLabel, orderUrl } from "@/components/order/order-presentation";
import "./order.css";
import { LegacyContinuationPanel } from "./legacy-continuation-panel";
import { OrderAccountDossier } from "./order-account-dossier";
import { orderAccountTitle, orderAmountFacts, orderListingSourceLabel, orderResourceLines, orderUsesResourceSummary } from "@/lib/order-display";
import { requestSupportDialog } from "@/components/support/support-dialog-request";

export function legacyOrderHref(party: OrderParty, page = 1, orderId?: string, accountId?: string) {
  const q = new URLSearchParams({ view: party === "owner" ? "leased" : "rentals", source: "legacy", page: String(page) });
  if (orderId) q.set("orderId", orderId);
  if (accountId) q.set("accountId", accountId);
  return `/account?${q}`;
}

export function LegacyOrderWorkspace({ party, orderId, page: pageText, accountId, status = "", filters, onOrderChanged }: { party: OrderParty; orderId?: string; page?: string; accountId?: string; status?: OrderStatusFilter; filters?: OrderSearchFilters; onOrderChanged?: () => void }) {
  const session = useUserSession();
  const page = pageText && /^[1-9]\d{0,6}$/.test(pageText) ? Number(pageText) : 1;
  const scope = `${session.status}:${session.userId}:${session.identityVersion}:${party}:${page}:${orderId ?? ""}:${accountId ?? ""}`;
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ scope: string; loading: boolean; data: LegacyOrderPage | LegacyOrder | null; error: string }>({ scope, loading: true, data: null, error: "" });
  useEffect(() => {
    const abort = new AbortController();
    setState({ scope, loading: true, data: null, error: "" });
    if (session.status !== "authenticated" || !session.userId) return () => abort.abort();
    const request = orderId ? orderApi.legacyDetail(orderId, abort.signal) : orderApi.listLegacy({ party, page, pageSize: 20, ...(accountId ? { accountId } : {}) }, abort.signal);
    request.then(data => {
      if (abort.signal.aborted) return;
      const isList = "items" in data;
      const rows = isList ? data.items : [data];
      if (!Array.isArray(rows) || rows.some(row => row.readOnly !== true || row.source?.origin !== "LEGACY" || typeof row.id !== "string" || !["renter", "owner"].includes(row.party) || (isList ? row.party !== party : row.id !== orderId))) throw new Error("Invalid historical projection");
      setState({ scope, loading: false, data, error: "" });
    }).catch(error => {
      if (abort.signal.aborted) return;
      if (error instanceof OrderRequestError && error.status === 401) session.revalidate();
      setState({ scope, loading: false, data: null, error: error instanceof OrderRequestError && error.status === 404 ? "这笔订单不存在或当前身份无法查看。" : error instanceof OrderRequestError && error.status === 403 ? "当前身份无权查看订单。" : "订单暂时无法读取，请稍后重试。" });
    });
    return () => abort.abort();
  }, [scope, reload, session.status, session.userId, session.revalidate, party, page, orderId, accountId]);
  if (session.status !== "authenticated" || !session.userId) return <p role="status">正在确认订单身份…</p>;
  const current = state.scope === scope ? state : null;
  if (!current || current.loading) return <p role="status" aria-busy="true">正在读取订单…</p>;
  if (current.error || !current.data) return <section role="alert" className="order-error-block"><h2>订单暂不可用</h2><p>{current.error}</p><button className="button secondary" onClick={() => setReload(n => n + 1)}>重试读取</button></section>;
  const data = current.data;
  if (!("items" in data) && data.party !== party) {
    const actualTitle = data.party === "owner" ? "出租订单" : "租入订单";
    return <section className="order-detail-view" data-testid="legacy-order-party-mismatch"><Link href={orderUrl(party, status, accountId, undefined, undefined, filters)} scroll={false}>返回订单列表</Link><section className="order-error-block" role="status"><h2>本单属于你的{actualTitle}</h2><p>请切换到对应订单查看金额和进度。</p><Link className="button primary" href={orderUrl(data.party, "", undefined, data.id, "LEGACY")} scroll={false}>查看我的{actualTitle}</Link></section></section>;
  }
  const recordedIncome = !("items" in data) && data.ownerIncomeSource?.source === "LEGACY_ORDER_SNAPSHOT" ? data.amounts?.ownerRecordedIncome : null;
  const notice = party === "renter" ? <p className="order-muted">退款记录金额仅供查看，实际到账请以收款记录为准。</p> : null;
  if ("items" in data) return <section className="order-detail-view">
    <header className="account-module-heading"><div><h2>{party === "owner" ? "出租" : "租入"}订单</h2><p>查看订单进展与金额记录。</p></div><button className="button secondary" onClick={() => setReload(n => n + 1)}>刷新</button></header>
    {notice}
    <div className="account-module-card">
      {data.items.length ? <ul className="legacy-order-list">{data.items.map(row => {
        const facts = orderAmountFacts(row, party);
        return <li key={row.id}><Link href={legacyOrderHref(party, page, row.id, accountId)}><strong>{row.displayNo || "订单号暂未提供"}<small> · {facts.caption} {facts.main}</small></strong><span>{orderAccountTitle(row)}</span><span>{row.source.statusLabel || "状态未记录"} · {orderTermLabel(row)}</span><time>{formatOrderTime(row.createdAt)}</time></Link></li>;
      })}</ul> : <p>暂无订单记录。</p>}
      <nav className="order-trade-actions" aria-label="订单分页">
        {page > 1 ? <Link className="button secondary" href={legacyOrderHref(party, page - 1, undefined, accountId)}>上一页</Link> : null}
        <span>第 {page} 页 · 共 {data.total} 条</span>
        {page * data.pageSize < data.total ? <Link className="button secondary" href={legacyOrderHref(party, page + 1, undefined, accountId)}>下一页</Link> : null}
      </nav>
    </div>
  </section>;
  const resources = orderResourceLines(data);
  const accountNo = data.account.readable ? data.account.displayNo : null;
  return <section className="order-detail-view order-detail-legacy-modern">
    <Link className="order-detail-back" href={orderUrl(party, status, accountId, undefined, undefined, filters)} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回订单列表</Link>
    <header className="order-legacy-hero-card">
      <div className="order-legacy-hero-row">
        <strong className="order-status" data-state={data.status === "PENDING_PAYMENT" ? "pending" : data.status.toLowerCase()}>{data.source.statusLabel || "状态未记录"}</strong>
        <div className="order-legacy-id-group">
          {data.displayNo ? <span className="order-id-badge">订单号 <strong>{data.displayNo}</strong></span> : null}
          {accountNo ? <span className="order-id-badge">账号编号 <strong>{accountNo}</strong></span> : null}
          <button type="button" className="button secondary" data-support-trigger onClick={event => {
            const valid = /^legacy_order_[a-f0-9]{40}$/.test(data.id) && Boolean(data.displayNo);
            requestSupportDialog("SERVICE", event.currentTarget, valid ? {
              userId: session.userId!, subjectRef: `legacy-order:${data.id}`, recordId: data.id, draftText: `旧订单 ${data.displayNo}`,
              legacyOrder: { id: data.id, displayNo: data.displayNo!, title: orderAccountTitle(data).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240).trim() || "租赁账号", party: data.party },
            } : undefined);
          }}>联系客服</button>
        </div>
      </div>
      <h2 className="order-legacy-hero-title">{orderAccountTitle(data)}</h2>
      <p className="order-legacy-hero-meta">{orderTermLabel(data)}</p>
      {data.listingFacts?.source === "LEGACY_ACCOUNT_SNAPSHOT" ? <p className="order-muted">{orderListingSourceLabel(data)}；原单资源与金额分别保留。</p> : orderUsesResourceSummary(data) ? <p className="order-muted">账号资料来自本单记录。</p> : null}
    </header>
    <section className="account-module-card order-legacy-bill-card"><h3>{party === "owner" ? "出租收益记录" : "金额记录"}</h3>{party === "owner" ? <div className="order-owner-income-block">{recordedIncome ? <><p className="order-amount-total">{formatOrderMoney(recordedIncome)}</p><p className="order-muted">记录金额仅供查看，余额请以钱包为准。</p></> : <p className="order-muted">收益金额未记录。</p>}<Link className="order-wallet-link" href="/account?view=wallet" scroll={false}>查看钱包记录</Link></div> : <dl className="order-facts order-bill-facts">
      <div><dt>应付金额</dt><dd>{formatOrderMoney(data.legacyAmounts?.required)}</dd></div>
      <div><dt>已付金额</dt><dd>{formatOrderMoney(data.legacyAmounts?.paid)}</dd></div>
      <div><dt>押金</dt><dd>{formatOrderMoney(data.legacyAmounts?.deposit)}</dd></div>
      <div><dt>退款记录金额</dt><dd>{formatOrderMoney(data.legacyAmounts?.refund)}</dd></div>
    </dl>}{notice}</section>
    {resources.length ? <section className="account-module-card order-legacy-assets-card">
      <div className="account-module-card-header"><h3>本单资源记录</h3></div>
      <dl className="order-legacy-resources-grid">
        {resources.map(resource => <div className="order-legacy-resource-chip" key={resource.code}><dt className="resource-chip-name">{resource.name}</dt><dd className="resource-chip-val">{resource.value}</dd></div>)}
      </dl>
    </section> : null}
    {data.account.readable && data.account.id ? <OrderAccountDossier accountId={data.account.id} accountDisplayNo={accountNo} party={party} listingFacts={data.listingFacts} /> : null}
    <LegacyContinuationPanel orderId={data.id} party={party} onOrderChanged={() => {
      setState({ scope, loading: true, data: null, error: "" });
      setReload(n => n + 1);
      onOrderChanged?.();
    }}/>
    <section className="account-module-card"><h3>订单信息</h3><dl className="order-facts">
      <div><dt>创建时间</dt><dd>{formatOrderTime(data.createdAt)}</dd></div><div><dt>支付记录时间</dt><dd>{formatOrderTime(data.paidAt)}</dd></div>
      <div><dt>完成时间</dt><dd>{formatOrderTime(data.completedAt)}</dd></div><div><dt>取消时间</dt><dd>{formatOrderTime(data.cancelledAt)}</dd></div>
    </dl>{data.account.readable && data.account.id && party === "owner" ? <Link href={`/account?view=accounts&accountId=${encodeURIComponent(data.account.id)}`}>查看本人账号</Link> : null}</section>
  </section>;
}
