"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Clock3, ReceiptText, ShieldCheck } from "lucide-react";
import { moneyValue } from "@/components/delta/account-card";
import { FavoriteNotice } from "@/components/favorites/favorite-button";
import { RentalConfirmPanel } from "@/components/order/rental-confirm-panel";
import { useUserSession } from "@/components/session/user-session-provider";
import { captureOrderSubject, formatOrderMoney, formatOrderTime, isOrderSubjectCurrent, orderApi, orderUrl, type Order } from "@/lib/order-client";
import { formatPaymentCountdown, orderAccountTitle, orderPaymentUrl, paymentEntryOpen } from "@/lib/order-display";
import type { ListingDetailData } from "@/lib/listing-view";
import { linkedOrderTermText } from "./listing-detail-format";

function PendingOrderCountdown({ until, expired }: { until?: string | null; expired: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);

  if (expired) return <span className="account-pending-countdown-badge" data-state="expired">已到期，取消处理中</span>;
  if (!until) return null;
  const remaining = now === null ? null : Date.parse(until) - now;
  if (remaining !== null && remaining <= 0) {
    return <span className="account-pending-countdown-badge" data-state="expired">已到期，取消处理中</span>;
  }
  const text = remaining === null ? null : formatPaymentCountdown(remaining);
  return (
    <span className="account-pending-countdown-badge" data-state="active">
      <Clock3 size={13} aria-hidden="true" />
      <span>{text ? `支付保留 ${text}` : `支付保留至 ${formatOrderTime(until, { timeZoneName: false })}`}</span>
    </span>
  );
}

export function ListingDetailConfirm({ data, fromOrder, fromParty = "renter" }: { data: ListingDetailData; fromOrder?: string; fromParty?: "renter" | "owner" }) {
  const session = useUserSession();
  const identityKey = session.status === "authenticated" && session.userId ? session.userId : "guest";
  const [linkedOrder, setLinkedOrder] = useState<Order | null>(null);
  const [linkedOrderRead, setLinkedOrderRead] = useState<"idle" | "loading" | "ready" | "failed">("idle");

  useEffect(() => {
    if (fromParty !== "renter" || session.status !== "authenticated" || !session.userId || (data.canCreateOrder !== false && !fromOrder)) {
      setLinkedOrder(null);
      setLinkedOrderRead("ready");
      return;
    }
    const subject = captureOrderSubject(session.userId, session.identityVersion);
    if (!subject) { setLinkedOrderRead("failed"); return; }
    const controller = new AbortController();
    setLinkedOrderRead("loading");
    void orderApi.listUnified(subject, { party: "renter", status: "IN_PROGRESS", accountId: data.id, limit: 5 }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || !isOrderSubjectCurrent(subject, session)) return;
        const active = page.items.filter((order) => order.status === "PENDING_PAYMENT" || order.status === "PAID");
        setLinkedOrder(active.find((order) => order.id === fromOrder) ?? active.find((order) => order.status === "PENDING_PAYMENT") ?? active.find((order) => order.status === "PAID") ?? null);
        setLinkedOrderRead("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted && isOrderSubjectCurrent(subject, session)) setLinkedOrderRead("failed");
      });
    return () => controller.abort();
  }, [data.canCreateOrder, data.id, fromOrder, fromParty, session]);

  return (
    <aside
      id="account-quote-anchor"
      className="account-quote account-quote-column"
      aria-label="租赁报价"
      data-readonly={data.historicalReadOnly || data.canCreateOrder === false || undefined}
    >
      {data.historicalReadOnly ? (
        <div className="account-quote-panel">
          <div className="account-quote-banner">
            <div className="account-quote-banner-title">
              <ReceiptText size={18} aria-hidden="true" />
              <h2>资源费用记录</h2>
            </div>
            <span className="account-quote-banner-tag">资料暂不可租</span>
          </div>
          <div className="account-quote-content">
            {data.sourceAvailabilityLabel ? (
              <p className="account-source-status">{data.sourceAvailabilityLabel}，不代表当前租态。</p>
            ) : null}
            <p className="account-reference-label">资源费用记录 · 不含押金</p>
            <p className="account-reference-price">{moneyValue(data.resourceTotalLabel)}</p>
            <dl className="account-fee-lines">
              <div>
                <dt>哈夫币租金记录</dt>
                <dd>{moneyValue(data.haffRentLabel)}</dd>
              </div>
              <div>
                <dt>物资预付记录</dt>
                <dd>{moneyValue(data.itemResourceTotalLabel)}</dd>
              </div>
              <div>
                <dt>押金记录</dt>
                <dd>{moneyValue(data.depositLabel)}</dd>
              </div>
            </dl>
            <p className="detail-stage-note account-readonly">
              这些费用来自该账号的资料记录，不是当前报价；当前不能创建新订单。
            </p>
            <Link className="button secondary button--sm account-readonly-action" href="/accounts">
              返回账号市场
            </Link>
          </div>
        </div>
      ) : data.canCreateOrder === false ? (
        linkedOrderRead === "loading" ? (
          <div className="account-quote-panel account-pending-panel" aria-busy="true">
            <div className="account-pending-status" role="status">正在核对订单状态…</div>
          </div>
        ) : linkedOrder ? (
          linkedOrder.status === "PENDING_PAYMENT" ? (
            <div className="account-quote-panel account-pending-panel">
              <div className="account-quote-banner">
                <div className="account-quote-banner-title">
                  <Clock3 size={18} aria-hidden="true" />
                  <h2>{paymentEntryOpen(linkedOrder) ? "你有待支付订单" : "待支付订单已到期"}</h2>
                </div>
                <span className="account-quote-banner-tag">{paymentEntryOpen(linkedOrder) ? "待支付" : "处理中"}</span>
              </div>
              <div className="account-quote-content">
                <p className="account-pending-order-title">{orderAccountTitle(linkedOrder)}</p>
                {paymentEntryOpen(linkedOrder) && linkedOrder.holdUntil ? (
                  <div className="account-pending-countdown-wrap">
                    <PendingOrderCountdown until={linkedOrder.holdUntil} expired={!paymentEntryOpen(linkedOrder)} />
                  </div>
                ) : null}
                <dl className="account-pending-facts">
                  <div><dt>订单号</dt><dd>{linkedOrder.displayNo ?? "暂不可用"}</dd></div>
                  <div><dt>应付金额</dt><dd className="account-pending-amount-highlight">{formatOrderMoney(linkedOrder.amounts?.totalDue)}</dd></div>
                  <div><dt>支付保留至</dt><dd>{linkedOrder.holdUntil ? formatOrderTime(linkedOrder.holdUntil, { timeZoneName: false }) : "以订单页为准"}</dd></div>
                </dl>
                <p className="detail-stage-note account-readonly">
                  {paymentEntryOpen(linkedOrder)
                    ? "账号已为你保留独占锁定，完成支付后客服将即时在专属群协助开租。关闭页面后可从订单或个人中心继续支付。"
                    : "支付入口已关闭，账号占用正在释放。你仍可查看订单记录或联系客服。"}
                </p>
                {paymentEntryOpen(linkedOrder) ? (
                  <Link
                    className="button rental-confirm-primary account-pending-pay"
                    href={orderPaymentUrl("renter", "", data.id, linkedOrder.id)}
                  >
                    <ShieldCheck size={17} aria-hidden="true" />
                    <span>继续支付 · {formatOrderMoney(linkedOrder.amounts?.totalDue)}</span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </Link>
                ) : null}
                <Link className="button quiet button--sm" href={orderUrl("renter", "", data.id, linkedOrder.id)}>
                  查看订单详情
                </Link>
              </div>
            </div>
          ) : (
            <div className="account-quote-panel account-pending-panel account-active-order-panel">
              <div className="account-quote-banner">
                <div className="account-quote-banner-title">
                  <Clock3 size={18} aria-hidden="true" />
                  <h2>此账号正在你的订单中</h2>
                </div>
                <span className="account-quote-banner-tag">{linkedOrder.stage?.label ?? "租用中"}</span>
              </div>
              <div className="account-quote-content">
                <p className="account-pending-order-title">{orderAccountTitle(linkedOrder)}</p>
                <dl className="account-pending-facts">
                  <div><dt>订单号</dt><dd>{linkedOrder.displayNo ?? "暂不可用"}</dd></div>
                  <div><dt>约定租期</dt><dd>{linkedOrderTermText(linkedOrder)}</dd></div>
                  <div><dt>当前状态</dt><dd>{linkedOrder.stage?.label ?? "租用中"}</dd></div>
                </dl>
                <p className="detail-stage-note account-readonly">
                  当前不能重复下单。查看订单可处理开租、结算或联系客服。
                </p>
                <Link className="button rental-confirm-primary account-pending-pay" href={orderUrl("renter", "", data.id, linkedOrder.id)}>
                  查看订单
                </Link>
              </div>
            </div>
          )
        ) : (
          <div className="account-quote-panel">
            <div className="account-quote-banner">
              <div className="account-quote-banner-title">
                <ReceiptText size={18} aria-hidden="true" />
                <h2>公开版本资源费用参考</h2>
              </div>
              <span className="account-quote-banner-tag">暂不可租</span>
            </div>
            <div className="account-quote-content">
              <p className="account-reference-price">{moneyValue(data.resourceTotalLabel)}</p>
              <p className="detail-stage-note account-readonly">
                已获准公开的资料仍可查看，当前不能创建新订单。这里是公开版本的资源费用参考，不是本人最终报价。
              </p>
              <Link className="button secondary button--sm account-readonly-action" href="/accounts">
                返回账号市场
              </Link>
            </div>
          </div>
        )
      ) : (
        <div className="account-quote-panel">
          <div className="account-quote-content">
            <RentalConfirmPanel
              key={`${identityKey}:${data.id}:${data.versionId}:${data.releaseId}`}
              accountId={data.id}
              gameId={data.gameId}
              versionId={data.versionId}
              releaseId={data.releaseId}
              fullPayoutSelected={data.fullPayoutSelected === true}
              {...(data.autoPreview ? { autoPreview: true, autoStart: true } : {})}
              reference={{
                total: moneyValue(data.resourceTotalLabel),
                haff: moneyValue(data.haffRentLabel),
                items: moneyValue(data.itemResourceTotalLabel),
                deposit: data.depositLabel ? moneyValue(data.depositLabel) : null,
                lines: data.resourceLines,
                unitAmountsInformational: data.unitAmountsInformational,
                ...(data.baseRenterHaffRatioWanPerYuan ? { baseRenterHaffRatioWanPerYuan: data.baseRenterHaffRatioWanPerYuan } : {}),
                baseRatioReferenceOnly: data.baseRatioReferenceOnly,
              }}
            />
          </div>
        </div>
      )}
      <FavoriteNotice />
    </aside>
  );
}
