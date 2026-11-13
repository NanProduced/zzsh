"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Crown, WalletCards } from "lucide-react";
import { captureOrderSubject, formatOrderMoney, isOrderSubjectCurrent, orderApi, OrderRequestError, type Order, type OrderParty, type OrderSettlement, type SettlementOpening } from "@/lib/order-client";
import { useUserSession } from "@/components/session/user-session-provider";
import { haffMillionsText, matchingResourceDiscount, formatYuanFromCents, orderMembershipText, orderLineQuantityText, orderLinesTotalLabel, orderUnitPriceText, quantityText, unitLabel } from "@/lib/order-display";
import { formatReferenceYuan } from "@zzsh/ui/display-money";
import { activeOpening, stageFacts, type OrderStageFacts } from "@/components/order/order-trade-actions";

type PriceReferenceLine = { itemId?: string; quantity?: string; costAmount?: string; unitPriceLabel?: string };

function OrderLines({ order, party, opening, referenceLines, showTotal = true, originalAmounts = false }: { order: Order; party: OrderParty; opening?: SettlementOpening | null; referenceLines?: readonly PriceReferenceLine[] | null; showTotal?: boolean; originalAmounts?: boolean }) {
  const lines = order.quote?.lines ?? [];
  if (lines.length === 0) return <p className="order-muted">暂无可展示的费用明细，可稍后查看或联系客服。</p>;
  const total = party === "owner" ? order.quote?.ownerTotal : order.amounts?.rental;
  const hasOpening = Boolean(opening?.lines.length);
  const openingFor = (itemId?: string | null) => itemId ? opening?.lines.find((line) => line.itemId === itemId) : undefined;
  const referenceFor = (itemId?: string | null) => itemId ? referenceLines?.find((line) => line.itemId === itemId) : undefined;
  return <>
    <div className="order-table-wrap">
      <table><thead><tr><th scope="col">资源</th><th scope="col">{hasOpening ? "开租数量" : "数量"}</th><th scope="col">{party === "owner" ? "号主报价" : "金额"}</th></tr></thead>
        <tbody>{lines.map((line, index) => {
          // Renter line amounts are the final allocated price. The public listing can supply the
          // base unit price for comparison, but it is not used for any arithmetic here.
          const referenceLine = originalAmounts ? referenceFor(line.itemId) : undefined;
          const unitPrice = party === "owner"
            ? orderUnitPriceText(line.ownerUnitAmount, line.unitQuantity, line.unit)
            : line.unit === "HAFF_BASE" ? null : referenceLine?.unitPriceLabel ? `参考 ${referenceLine.unitPriceLabel}` : null;
          const amount = party === "renter" && referenceLine?.costAmount ? formatReferenceYuan(referenceLine.costAmount) : null;
          const openingQuantity = openingFor(line.itemId)?.quantity;
          const quantity = openingQuantity !== undefined && openingQuantity !== null && openingQuantity !== ""
            ? line.unit === "HAFF_BASE" ? haffMillionsText(openingQuantity) : quantityText(line.unit, openingQuantity)
            : orderLineQuantityText(line);
          return <tr key={`${line.itemId ?? line.name ?? line.unit ?? "line"}-${index}`}>
            <td data-label="资源"><span>{line.name ?? unitLabel(line.unit) ?? "资源未记录"}</span>{unitPrice ? <small className="order-line-unit">{unitPrice}</small> : null}</td>
            <td data-label={hasOpening ? "开租数量" : "数量"}>{quantity}</td>
            <td data-label={party === "owner" ? "号主报价" : "金额"}>{amount ?? formatOrderMoney(party === "owner" ? line.ownerAmount : line.buyerAmount)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {showTotal ? <p className="order-lines-total">{orderLinesTotalLabel(party)} <strong>{formatOrderMoney(total)}</strong></p> : null}
    {party === "renter" ? <p className="order-lines-note">{originalAmounts ? "资源行金额为下单时原价；会员优惠在合计中一次性扣除。" : "资源行金额为下单时最终报价；如享会员优惠，已一次性计入合计，不逐项分摊。"}</p> : null}
    {!originalAmounts && order.quote?.unitAmountsInformational ? <p className="order-lines-note">明细为下单时的费用记录，最终金额请查看结算明细。</p> : null}
  </>;
}

/** One money section: party-owned summary plus the resource lines and confirmed opening quantities. */
export function OrderAmountDetails({ order, party, refreshVersion = 0, onFacts }: { order: Order; party: OrderParty; refreshVersion?: number; onFacts?: (facts: OrderStageFacts | null, failed: boolean) => void }) {
  const session = useUserSession();
  const report = useRef(onFacts);
  useEffect(() => { report.current = onFacts; }, [onFacts]);
  const [state, setState] = useState<{ scope: string; status: "idle" | "loading" | "ready" | "unavailable" | "error"; data: OrderSettlement | null }>({ scope: "", status: "idle", data: null });
  const [referenceLines, setReferenceLines] = useState<PriceReferenceLine[] | null>(null);
  const scope = `${session.userId ?? ""}:${session.identityVersion}:${order.id}:${order.status}:${refreshVersion}`;
  useEffect(() => {
    if (order.source?.origin === "LEGACY" || (order.status !== "PAID" && order.status !== "COMPLETED")) {
      setState({ scope, status: "idle", data: null });
      report.current?.(null, false);
      return;
    }
    const subject = captureOrderSubject(session.userId, session.identityVersion);
    if (!subject) {
      setState({ scope, status: "error", data: null });
      report.current?.(null, true);
      return;
    }
    const controller = new AbortController();
    setState({ scope, status: "loading", data: null });
    orderApi.settlement(subject, order.id, controller.signal).then((data) => {
      if (controller.signal.aborted || !isOrderSubjectCurrent(subject, session)) return;
      setState({ scope, status: "ready", data });
      report.current?.(stageFacts(data, activeOpening(data.openings), party), false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isOrderSubjectCurrent(subject, session)) return;
      setState({ scope, status: error instanceof OrderRequestError && error.status === 404 ? "unavailable" : "error", data: null });
      report.current?.(null, true);
    });
    return () => controller.abort();
  }, [order.id, order.status, order.source?.origin, party, refreshVersion, scope, session, session.userId, session.identityVersion]);
  useEffect(() => {
    const expectedVersion = order.listingFacts?.versionId ?? null;
    if (party !== "renter" || !order.accountId || !expectedVersion || order.source?.origin === "LEGACY") { setReferenceLines(null); return; }
    const controller = new AbortController();
    void fetch(`/api/supply/listings/${encodeURIComponent(order.accountId)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((listing: { versionId?: unknown; quote?: { lines?: unknown } | null } | null) => {
        if (controller.signal.aborted) return;
        if (!listing || listing.versionId !== expectedVersion || !Array.isArray(listing.quote?.lines)) { setReferenceLines(null); return; }
        setReferenceLines(listing.quote.lines.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const line = raw as { itemId?: unknown; quantity?: unknown; unit?: unknown; unitQuantity?: unknown; buyerUnitAmount?: { amount?: unknown }; buyerAmount?: { amount?: unknown } };
          if (typeof line.itemId !== "string" || typeof line.quantity !== "string" || typeof line.buyerAmount?.amount !== "string") return [];
          const unitPrice = formatReferenceYuan(line.buyerUnitAmount?.amount);
          const unitLabel = typeof line.unitQuantity === "string" && typeof line.unit === "string" ? quantityText(line.unit, line.unitQuantity) : null;
          return [{
            itemId: line.itemId,
            quantity: line.quantity,
            costAmount: line.buyerAmount.amount,
            ...(unitPrice ? { unitPriceLabel: unitLabel ? `${unitPrice} / ${unitLabel}` : unitPrice } : {}),
          }];
        }));
      })
      .catch(() => { if (!controller.signal.aborted) setReferenceLines(null); });
    return () => controller.abort();
  }, [order.accountId, order.listingFacts?.versionId, order.source?.origin, party]);
  const visible = state.scope === scope ? state : { scope, status: "loading" as const, data: null };
  const facts = visible.status === "ready" && visible.data ? stageFacts(visible.data, activeOpening(visible.data.openings), party) : null;
  const opening = visible.status === "ready" && visible.data ? activeOpening(visible.data.openings) : null;
  const priceDiscount = party === "renter" && referenceLines && (order.status !== "CANCELLED" || Boolean(order.paidAt)) && order.quote?.lines?.length
    ? matchingResourceDiscount(order.quote.lines, order.quote.resourceTotal ?? order.amounts?.rental, referenceLines)
    : null;
  const membershipText = orderMembershipText(order.membership);
  return <section className="order-detail-section order-amount-details" aria-label="订单金额明细">
    <div className="order-amount-details-head">
      <div className="order-amount-details-heading">
        <h2 className="order-section-title">订单金额明细</h2>
        {membershipText ? <span className="order-member-badge"><Crown size={13} aria-hidden="true" />{membershipText}</span> : null}
      </div>
      <span>{party === "owner" ? (facts?.phase === "POSTED" ? "结算净入账" : "预估收益") : order.status === "PENDING_PAYMENT" ? "本次应付" : order.status === "CANCELLED" && !order.paidAt ? "下单金额" : "实付金额"}</span>
    </div>
    <p className="order-amount-details-note">{party === "owner" ? (facts?.phase === "POSTED" ? "包赔费已按结算规则扣除。" : "预估收益，包赔费按结算规则扣除。") : order.status === "PENDING_PAYMENT" ? "含租金与租客押金，支付后金额以订单记录为准。" : order.status === "CANCELLED" && !order.paidAt ? "订单未支付，以下为下单时的金额记录。" : "退款到账以实际进度为准。"}</p>
    <div className="order-amount-details-grid">
      <AmountCard order={order} party={party} facts={facts} readFailed={visible.status === "error" || visible.status === "unavailable"} />
      <div className="order-amount-lines order-lines">
        <h3 className="order-amount-lines-title">{order.status === "PENDING_PAYMENT" ? "资源与费用" : "资源与开租数量"}</h3>
        <OrderLines order={order} party={party} opening={opening} referenceLines={referenceLines} showTotal={!priceDiscount} originalAmounts={Boolean(priceDiscount)} />
        {priceDiscount ? <dl className="order-price-calc" aria-label="价格计算">
          <div><dt>资源原价小计</dt><dd><del>{priceDiscount.original}</del></dd></div>
          <div className="is-discount"><dt>会员优惠</dt><dd>-{formatYuanFromCents(priceDiscount.reduction)}</dd></div>
          <div className="is-final"><dt>折后资源合计</dt><dd>{priceDiscount.final}</dd></div>
        </dl> : null}
        {visible.status === "loading" ? <p className="order-muted" role="status">正在读取开租确认数量…</p> : null}
        {visible.status === "error" || visible.status === "unavailable" ? <p className="order-inline-notice" role="status">开租确认数量暂时无法读取，资源费用仍可查看。</p> : null}
      </div>
    </div>
  </section>;
}

/**
 * The rail answers "what is this transaction worth to me", and it only ever shows the reading party's
 * own money. The two sides are different numbers — a renter may pay less through a discount, and an
 * owner is quoted at listing time — so stacking both in one card manufactures a contradiction that
 * was never in the data. Owner sees the listing quote and the owner settlement; renter sees what they
 * paid and the renter settlement.
 */
/** The renter-side figure's name for the reading party, never implying a charge that did not happen. */
function renterFigureLabel(order: Order): string {
  return order.status === "PENDING_PAYMENT" ? "待支付金额" : "下单金额";
}

function AmountCard({ order, party, facts, readFailed }: { order: Order; party: OrderParty; facts: OrderStageFacts | null; readFailed: boolean }) {
  const amounts = order.amounts;
  const closed = order.status === "CANCELLED";
  const paid = Boolean(order.paidAt);
  const posted = facts?.phase === "POSTED" && facts.settled && facts.settled.text !== "—" ? facts.settled : null;
  const settledUnread = order.status === "COMPLETED" && !posted;

  if (party === "owner") {
    return <section className="order-side-card order-amount-block">
      <h2 className="order-section-title">{posted || settledUnread ? "本单结算" : "下单时的出租报价"}</h2>
      {posted
        ? <><strong className="order-amount-total">{posted.text}</strong><p className="order-amount-label">{posted.label}</p></>
        : settledUnread
          ? <><strong className="order-amount-total is-unknown">{readFailed ? "结算金额暂时无法读取" : facts ? "暂无可用结算金额" : "正在读取结算金额"}</strong><p className="order-amount-label">下单时的费用记录仍可查看</p></>
          : <strong className="order-amount-total">{formatOrderMoney(order.amounts?.ownerExpectedIncome ?? order.quote?.ownerTotal)}</strong>}
      {posted || settledUnread ? <dl className="order-facts order-amount-rows">
        <div><dt>下单时的出租报价</dt><dd>{formatOrderMoney(order.amounts?.ownerExpectedIncome ?? order.quote?.ownerTotal)}</dd></div>
      </dl> : null}
      {!posted ? <p className="order-muted">实际收入以结算结果为准。</p> : null}
      {posted ? <p className="order-side-link"><WalletCards size={14} aria-hidden="true" /><Link href="/account?view=wallet" scroll={false}>查看钱包</Link></p> : null}
    </section>;
  }

  const lead = settledUnread ? null : posted ?? {
    label: order.status === "PENDING_PAYMENT" ? "待支付" : "下单金额",
    text: formatOrderMoney(amounts?.totalDue),
  };
  return <section className="order-side-card order-amount-block">
    {lead ? <><strong className="order-amount-total">{lead.text}</strong><p className="order-amount-label">{lead.label}</p></>
      : <><strong className="order-amount-total is-unknown">{readFailed ? "结算金额暂时无法读取" : facts ? "暂无可用结算金额" : "正在读取结算金额"}</strong><p className="order-amount-label">下单时的费用记录仍可查看</p></>}
    {posted || settledUnread ? <dl className="order-facts order-amount-rows">
      <div><dt>{renterFigureLabel(order)}</dt><dd>{formatOrderMoney(amounts?.totalDue)}</dd></div>
    </dl> : null}
    <dl className="order-facts order-amount-parts">
      <div><dt>{paid && !closed ? "租赁预付" : "租赁费用"}</dt><dd>{formatOrderMoney(amounts?.rental)}</dd></div>
      <div><dt>租客押金</dt><dd>{formatOrderMoney(amounts?.deposit)}</dd></div>
    </dl>
    {closed ? <p className="order-muted">{!paid ? "订单未支付，这是下单时的金额。"
      : order.cancelReason === "PRESTART_TERMINATED" ? "退款进度请查看本页。"
      : order.cancelReason === "MANUAL_CLOSE" ? "退款进度请联系客服核对。"
      : "这是下单时的金额，实际扣费和退款请查看订单进度。"}</p> : null}
  </section>;
}
