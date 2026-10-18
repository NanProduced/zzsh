"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useUserSession } from "@/components/session/user-session-provider";
import { orderApi, formatOrderMoney, formatOrderTime, OrderRequestError, type LegacyOrder, type LegacyOrderPage, type OrderParty, type OrderStatusFilter } from "@/lib/order-client";
import { orderUrl } from "@/components/order/order-presentation";
import "./order.css";
import { LegacyContinuationPanel } from "./legacy-continuation-panel";
import { orderAccountTitle } from "@/lib/order-display";

export function legacyOrderHref(party: OrderParty, page = 1, orderId?: string, accountId?: string) {
  const q = new URLSearchParams({ view: party === "owner" ? "leased" : "rentals", source: "legacy", page: String(page) });
  if (orderId) q.set("orderId", orderId);
  if (accountId) q.set("accountId", accountId);
  return `/account?${q}`;
}

export function LegacyOrderWorkspace({ party, orderId, page: pageText, accountId, status = "" }: { party: OrderParty; orderId?: string; page?: string; accountId?: string; status?: OrderStatusFilter }) {
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
      const rows = "items" in data ? data.items : [data];
      if (!Array.isArray(rows) || rows.some(row => row.readOnly !== true || row.source?.origin !== "LEGACY" || typeof row.id !== "string" || row.party !== party)) throw new Error("Invalid historical projection");
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
  const notice = <p className="order-muted">原付款与金额记录保留；可办理事项以本单核定结果为准。应退金额不代表已到账。</p>;
  if ("items" in data) return <section className="order-detail-view">
    <header className="account-module-heading"><div><h2>{party === "owner" ? "出租" : "租入"}订单</h2><p>只读记录</p></div><button className="button secondary" onClick={() => setReload(n => n + 1)}>刷新</button></header>
    {notice}
    <div className="account-module-card">
      {data.items.length ? <ul className="legacy-order-list">{data.items.map(row => <li key={row.id}><Link href={legacyOrderHref(party, page, row.id, accountId)}><strong>{row.displayNo || "订单号暂未提供"}</strong><span>{orderAccountTitle(row)}</span><span>{row.source.statusLabel || "状态待确认"}</span><time>{formatOrderTime(row.createdAt)}</time></Link></li>)}</ul> : <p>暂无订单记录。</p>}
      <nav className="order-trade-actions" aria-label="订单分页">
        {page > 1 ? <Link className="button secondary" href={legacyOrderHref(party, page - 1, undefined, accountId)}>上一页</Link> : null}
        <span>第 {page} 页 · 共 {data.total} 条</span>
        {page * data.pageSize < data.total ? <Link className="button secondary" href={legacyOrderHref(party, page + 1, undefined, accountId)}>下一页</Link> : null}
      </nav>
    </div>
  </section>;
  return <section className="order-detail-view">
    <Link href={orderUrl(party, status, accountId)} scroll={false}>返回订单列表</Link>
    <header><h2>{data.displayNo || "订单"}</h2><p>{orderAccountTitle(data)}</p><strong>{data.source.statusLabel || "状态待确认"}</strong></header>
    {notice}
    <section className="account-module-card"><h3>金额记录</h3>{party === "owner" ? <p className="order-muted">以下是订单记载金额，不代表号主结算收入。</p> : null}<dl className="order-facts">
      <div><dt>应付金额</dt><dd>{formatOrderMoney(data.legacyAmounts.required)}</dd></div>
      <div><dt>已付金额</dt><dd>{formatOrderMoney(data.legacyAmounts.paid)}</dd></div>
      <div><dt>押金</dt><dd>{formatOrderMoney(data.legacyAmounts.deposit)}</dd></div>
      <div><dt>应退金额（到账待确认）</dt><dd>{formatOrderMoney(data.legacyAmounts.refund)}</dd></div>
    </dl></section>
    <LegacyContinuationPanel orderId={data.id} party={party}/>
    <section className="account-module-card"><h3>订单信息</h3><dl className="order-facts">
      <div><dt>创建时间</dt><dd>{formatOrderTime(data.createdAt)}</dd></div><div><dt>支付记录时间</dt><dd>{formatOrderTime(data.paidAt)}</dd></div>
      <div><dt>完成时间</dt><dd>{formatOrderTime(data.completedAt)}</dd></div><div><dt>取消时间</dt><dd>{formatOrderTime(data.cancelledAt)}</dd></div>
      {data.account.readable ? <div><dt>账号编号</dt><dd>{data.account.displayNo ?? "编号待分配"}</dd></div> : null}
    </dl>{data.account.readable && data.account.id && party === "owner" ? <Link href={`/account?view=accounts&accountId=${encodeURIComponent(data.account.id)}`}>查看本人账号</Link> : null}</section>
  </section>;
}
