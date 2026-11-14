"use client";

import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, ChevronRight, Clock3, FileText, Headphones, RotateCcw, RotateCw, ShieldCheck, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { formatMoneyLabel } from "@/lib/listing-view";
import { orderApi, type FullPayoutTerms, type FullPayoutTermsAcceptance, type PersonalRentalQuote } from "@/lib/order-client";
import TradeTermsDocument from "@/components/content/trade-terms-document";
import { type UserSessionApi } from "@/components/session/user-session-provider";
import { PaymentDialog } from "@/components/order/payment-dialog";
import { RentalPriceSummary, type ReferenceFees } from "./rental-price-summary";
import { buildRentalPriceState, countdown, RentalCreatedAmount, RentalPersonalQuoteFacts, RentalPriceChangeNotice, type PreviewState, type Stage } from "./rental-confirm-price";

export type PayoutState = { status: "loading" } | { status: "ready"; terms: FullPayoutTerms } | { status: "unavailable"; message: string };

const orderHref = (orderId: string) => `/account?view=rentals&orderId=${encodeURIComponent(orderId)}`;

function PayoutTerms({
  state,
  accepted,
  locked,
  onAccept,
}: {
  state: PayoutState | null;
  accepted: boolean;
  locked: boolean;
  onAccept: (value: boolean) => void;
}) {
  const termsTarget = state?.status === "ready"
    ? JSON.stringify([state.terms.termsVersionId, state.terms.termsDigest, state.terms.disclosureVersion])
    : null;
  const [modal, setModal] = useState<{ target: string; accepted: boolean } | null>(null);
  const [renderedTarget, setRenderedTarget] = useState<string | null>(null);
  const termsReadable = state?.status === "ready" && (!state.terms.bodyDocument || renderedTarget === termsTarget);
  const modalOpen = Boolean(termsTarget && modal?.target === termsTarget);
  useEffect(() => { setModal(null); }, [termsTarget, locked]);
  if (!state) return null;
  return (
    <section className="rental-confirm-payout" aria-label="全额包赔条款">
      <div className="rental-confirm-payout-head">
        <ShieldCheck size={15} aria-hidden="true" />
        <strong>全额包赔 · 需同意条款</strong>
      </div>
      {state.status === "loading" ? (
        <p className="detail-stage-note">正在读取本账号适用的全额包赔条款…</p>
      ) : null}
      {state.status === "unavailable" ? (
        <p className="rental-confirm-error">
          <AlertCircle size={14} aria-hidden="true" />
          {state.message}
        </p>
      ) : null}
      {state.status === "ready" ? (
        <Dialog.Root open={modalOpen} onOpenChange={(open) => setModal(open && termsTarget ? { target: termsTarget, accepted } : null)}>
          <p className="detail-stage-note">
            本账号采用全额包赔方案，请在下单前阅读并确认本次适用条款。
          </p>
          <div className="rental-confirm-terms-trigger-row">
            <Dialog.Trigger asChild>
              <button type="button" id="payout-terms-trigger" className="rental-terms-modal-trigger">
                <span>查看条款详情（{state.terms.title}） &gt;</span>
              </button>
            </Dialog.Trigger>
          </div>
          <label className="rental-confirm-payout-accept">
            <input
              type="checkbox"
              aria-label="我已阅读并同意全额包赔条款"
              checked={accepted}
              disabled={locked || !termsReadable}
              onChange={(event) => { if (!locked && termsReadable) onAccept(event.target.checked); }}
            />
            <span>{accepted ? "已阅读并同意该包赔条款" : "我已阅读并同意该包赔条款"}</span>
          </label>

          <Dialog.Portal>
            <Dialog.Overlay className="modal-overlay" />
            <Dialog.Content className="rental-terms-dialog" aria-describedby={undefined}>
              <div className="rental-terms-dialog-head">
                <Dialog.Title className="rental-terms-dialog-title">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <span>{state.terms.title}</span>
                </Dialog.Title>
                <Dialog.Close asChild>
                  <button type="button" className="rental-terms-dialog-close-btn" aria-label="关闭条款窗口">
                    <X size={18} aria-hidden="true" />
                  </button>
                </Dialog.Close>
              </div>
              <div className="rental-terms-dialog-body" role="region" aria-label="全额包赔条款全文">
                {termsTarget ? <TradeTermsDocument body={state.terms.body} document={state.terms.bodyDocument} target={termsTarget} onReady={setRenderedTarget} /> : null}
              </div>
              <div className="rental-terms-dialog-footer">
                <label className="rental-terms-dialog-accept">
                  <input
                    type="checkbox"
                    checked={Boolean(modalOpen && modal?.accepted)}
                    disabled={locked || !termsReadable}
                    onChange={(event) => {
                      if (!locked && termsReadable && modalOpen && termsTarget) setModal({ target: termsTarget, accepted: event.target.checked });
                    }}
                  />
                  <span>我已阅读并同意该包赔条款</span>
                </label>
                <button
                  type="button"
                  className="button primary rental-terms-dialog-confirm"
                  disabled={locked || !termsReadable || !modalOpen || !modal?.accepted}
                  onClick={() => {
                    if (locked || !termsReadable || !modalOpen || !modal?.accepted) return;
                    onAccept(true);
                    setModal(null);
                  }}
                >
                  同意条款并返回
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </section>
  );
}

export function RentalConfirmBody({
  accountId,
  gameId,
  versionId,
  releaseId,
  reference,
  fullPayoutSelected,
  autoPreview,
  stage,
  setStage,
  session,
  userId,
  previewState,
  retryClock,
  now,
  payout,
  payoutAccepted,
  setPayoutAccepted,
  payoutGateOpen,
  payoutAcceptance,
  priceChangeNotice,
  termsOpen,
  setTermsOpen,
  agreementAccepted,
  setAgreementAccepted,
  readAgreement,
  setReadAgreement,
  paymentAccepted,
  setPaymentAccepted,
  paymentCancelled,
  setPaymentCancelled,
  payOpen,
  setPayOpen,
  requote,
  fetchPreview,
  recoverCreate,
  recoverPayment,
  sendCreate,
}: {
  accountId: string;
  gameId?: string | null;
  versionId?: string;
  releaseId?: string;
  reference?: ReferenceFees;
  fullPayoutSelected: boolean;
  autoPreview: boolean;
  stage: Stage;
  setStage: Dispatch<SetStateAction<Stage>>;
  session: UserSessionApi;
  userId: string | null;
  previewState: PreviewState;
  retryClock: number;
  now: number;
  payout: PayoutState | null;
  payoutAccepted: boolean;
  setPayoutAccepted: Dispatch<SetStateAction<boolean>>;
  payoutGateOpen: boolean;
  payoutAcceptance: FullPayoutTermsAcceptance | undefined;
  priceChangeNotice: string | null;
  termsOpen: boolean;
  setTermsOpen: Dispatch<SetStateAction<boolean>>;
  agreementAccepted: boolean;
  setAgreementAccepted: Dispatch<SetStateAction<boolean>>;
  readAgreement: string | null;
  setReadAgreement: Dispatch<SetStateAction<string | null>>;
  paymentAccepted: boolean;
  setPaymentAccepted: Dispatch<SetStateAction<boolean>>;
  paymentCancelled: boolean;
  setPaymentCancelled: Dispatch<SetStateAction<boolean>>;
  payOpen: boolean;
  setPayOpen: Dispatch<SetStateAction<boolean>>;
  requote: () => void | Promise<void>;
  fetchPreview: (isFocusRefresh?: boolean) => void | Promise<void>;
  recoverCreate: () => void | Promise<void>;
  recoverPayment: (orderId: string) => void | Promise<void>;
  sendCreate: (quote: PersonalRentalQuote) => void | Promise<void>;
}) {
  const { priceQuote, pendingLabel, dockPrice } = buildRentalPriceState({
    userId,
    stage,
    previewState,
    now,
    sessionStatus: session.status,
    autoPreview,
    reference,
  });
  const openPayoutTerms = () => {
    const trigger = document.getElementById("payout-terms-trigger");
    if (trigger instanceof HTMLElement) trigger.click();
  };
  const renderStage = () => {
    if (!versionId || !releaseId || !gameId) {
      return <p className="detail-stage-note">当前缺少可确认的发布依据，暂不能创建订单。</p>;
    }

    if (stage.kind === "idle") {
      const isGuest = session.status === "guest";
      const isError = autoPreview && previewState.status === "error";
      const isLoading = autoPreview && (previewState.status === "loading" || previewState.status === "idle");

      let buttonText: ReactNode = "查看我的报价";
      let buttonDisabled = false;
      let onPrimaryClick: () => void = () => { void requote(); };

      if (session.status === "loading") {
        buttonText = autoPreview ? "正在确认登录状态…" : "查看我的报价";
        buttonDisabled = true;
      } else if (session.status === "error") {
        buttonText = "重新确认登录状态";
        onPrimaryClick = () => { void session.confirm(); };
      } else if (autoPreview) {
        if (isLoading) {
          buttonText = "正在读取报价…";
          buttonDisabled = true;
        } else if (isError) {
          if (previewState.canRetry) {
            buttonText = "重试读取报价";
            buttonDisabled = retryClock < (previewState.retryAfter ?? 0);
            onPrimaryClick = () => void fetchPreview();
          } else if (previewState.action === "refresh") {
            buttonText = "刷新账号信息";
            onPrimaryClick = () => window.location.reload();
          } else {
            buttonText = "暂不支持租用";
            buttonDisabled = true;
          }
        } else {
          const termsReady = payout?.status === "ready";
          buttonText = payoutGateOpen ? "立即租用" : termsReady ? "查看并同意包赔条款" : "包赔条款暂不可用";
          buttonDisabled = !payoutGateOpen && !termsReady;
          onPrimaryClick = payoutGateOpen ? () => void requote() : termsReady ? openPayoutTerms : () => {};
        }
      } else if (!payoutGateOpen) {
        const termsReady = payout?.status === "ready";
        buttonText = termsReady ? "查看并同意包赔条款" : "包赔条款暂不可用";
        buttonDisabled = !termsReady;
        onPrimaryClick = termsReady ? openPayoutTerms : () => {};
      }

      return <div className="rental-confirm" data-stage="idle">
        <PayoutTerms state={payout} accepted={payoutAccepted} locked={false} onAccept={setPayoutAccepted} />
        {isError ? (
          <p className="rental-confirm-error" role="alert" data-error-code={previewState.code} data-http-status={previewState.statusHttp}>
            <AlertCircle size={14} aria-hidden="true" />
            <span>{previewState.message}</span>
            {previewState.requestId ? <small>问题编号：{previewState.requestId}</small> : null}
          </p>
        ) : null}
        <div className="rental-confirm-actions">
          <div className="rental-confirm-primary-action">
            {dockPrice}
            {isGuest ? (
              <Link className="button rental-confirm-primary" href={`/login?next=${encodeURIComponent(`/accounts/${accountId}`)}`}>
                {autoPreview ? (
                  <>
                    <span>登录并租用</span>
                    <span className="sr-only">（登录后显示最终报价）</span>
                  </>
                ) : (
                  "登录后显示最终报价"
                )}
              </Link>
            ) : (
              <button
                type="button"
                className="button rental-confirm-primary"
                onClick={onPrimaryClick}
                disabled={buttonDisabled}
              >
                {buttonText}
              </button>
            )}
          </div>
        </div>
        {isError && previewState.action === "back" ? <Link className="button quiet button--sm" href="/accounts">返回账号列表</Link> : null}
        <p className="detail-stage-note">核对费用和租用条款，再确认下单。</p>
      </div>;
    }

    if (stage.kind === "quoting") return <div className="rental-confirm" data-stage="quoting" aria-busy="true"><div className="rental-confirm-actions"><div className="rental-confirm-primary-action">{dockPrice}<button type="button" className="button rental-confirm-primary" disabled>正在读取个人报价与条款…</button></div></div></div>;

    if (stage.kind === "notice") return <div className="rental-confirm rental-confirm--error" role="alert">
      <p className="rental-confirm-error"><AlertCircle size={15} aria-hidden="true" />{stage.message}</p>
      <div className="rental-confirm-actions">
        {stage.orderId ? <Link className="button secondary button--sm" href={orderHref(stage.orderId)}>查看订单</Link> : null}
        {stage.canRequote ? <button type="button" className="button secondary button--sm" onClick={() => void requote()}><RotateCw size={14} aria-hidden="true" />重新确认</button> : null}
        {!stage.canRequote && !stage.orderId && !userId ? <Link className="button secondary button--sm" href={`/login?next=${encodeURIComponent(`/accounts/${accountId}`)}`}>去登录</Link> : null}
        {!stage.canRequote && !stage.orderId && userId && stage.action === "orders" ? <Link className="button secondary button--sm" href="/account?view=rentals">查看租入订单</Link> : null}
        {stage.action === "orders" ? <Link className="button quiet button--sm" href="/accounts">返回账号列表</Link> : null}
        {!stage.canRequote && !stage.orderId && userId && stage.action === "refresh" ? <button type="button" className="button secondary button--sm" onClick={() => window.location.reload()}>刷新账号资料</button> : null}
        {!stage.canRequote && !stage.orderId && userId && (stage.action === "back" || !stage.action) ? <Link className="button secondary button--sm" href="/accounts">返回账号列表</Link> : null}
      </div>
    </div>;

    if (stage.kind === "create-unknown") return <div className="rental-confirm rental-confirm--unknown" role="status">
      <p className="rental-confirm-heading"><Clock3 size={15} aria-hidden="true" />创建请求结果未知</p>
      <p className="detail-stage-note">本次申请的报价与内容已保留：{stage.context.payable ? `预计合计 ¥${stage.context.payable}、` : ""}{stage.context.tier ? `档位 ${stage.context.tier}` : ""}。请先查询原请求结果，不要重新确认、重复下单或改价。</p>
      <p className="rental-confirm-error"><AlertCircle size={14} aria-hidden="true" />{stage.message}</p>
      <div className="rental-confirm-actions">
        <div className="rental-confirm-primary-action">{dockPrice}<button type="button" className="button rental-confirm-primary" onClick={() => void recoverCreate()}>查询原创建结果</button></div>
        <Link className="button quiet button--sm" href="/account?view=rentals">查看租入订单</Link>
      </div>
    </div>;

    if (stage.kind === "paid") return <div className="rental-confirm rental-confirm--done rental-confirm--paid" role="status">
      <div className="rental-confirm-success-hero">
        <CheckCircle2 size={24} className="rental-confirm-success-icon" aria-hidden="true" />
        <div className="rental-confirm-success-copy">
          <strong>支付已接纳</strong>
          <span>专属客服已就绪，正在为你准备开租交接与专属群</span>
        </div>
      </div>
      <Link className="button rental-confirm-primary button--sm" href={orderHref(stage.orderId)}>
        <span>查看订单与开租进度</span>
        <ChevronRight size={15} aria-hidden="true" />
      </Link>
    </div>;

    if (stage.kind === "review") return <div className="rental-confirm rental-confirm--done" role="status">
      <p className="rental-confirm-error"><AlertCircle size={15} aria-hidden="true" />支付结果需要人工核对{stage.reason ? `（${stage.reason}）` : ""}；未重复扣款。</p>
      <Link className="button secondary button--sm" href={orderHref(stage.orderId)}>查看订单</Link>
    </div>;

    if (stage.kind === "pay-unknown") return <div className="rental-confirm rental-confirm--unknown" role="status">
      <p className="rental-confirm-heading"><Clock3 size={15} aria-hidden="true" />支付请求结果未知</p>
      <p className="detail-stage-note">请查询本次支付申请的原结果，不要重复提交支付。</p>
      <p className="rental-confirm-error"><AlertCircle size={14} aria-hidden="true" />{stage.message}</p>
      <div className="rental-confirm-actions">
        <div className="rental-confirm-primary-action">{dockPrice}<button type="button" className="button rental-confirm-primary" onClick={() => void recoverPayment(stage.orderId)}>查询原支付结果</button></div>
        <Link className="button quiet button--sm" href={orderHref(stage.orderId)}>查看订单</Link>
      </div>
    </div>;

    if (stage.kind === "creating") return <div className="rental-confirm" aria-busy="true">
      <p className="detail-stage-note">{stage.quote ? "正在创建订单并占用账号；若网络中断，本页会保留原请求供你查询。" : "正在查询原创建请求…"}</p>
    </div>;

    if (stage.kind === "created") {
      const created = stage.order;
      const total = formatMoneyLabel(created.amounts?.totalDue ?? stage.quote.quote?.tenantPayableTotal ?? null);
      // 付款弹窗用的是建单时的初始快照；任何状态变化都按原订单号读回服务端单据，
      // 让已支付/已取消立即推进页面并收起过期的待支付弹窗。读回失败不推测结果。
      const readBack = () => {
        if (!userId) return;
        const expectedId = created.id;
        void (async () => {
          try {
            const fresh = await orderApi.detail(userId, expectedId);
            if (!fresh || (fresh.id != null && fresh.id !== expectedId) || typeof fresh.status !== "string") return;
            setStage((current) => current.kind === "created" && current.order.id === expectedId ? { ...current, order: fresh } : current);
            if (fresh.status === "PAID" || fresh.status === "COMPLETED") {
              setPaymentAccepted(true);
              setPayOpen(false);
            } else if (fresh.status === "CANCELLED") {
              setPaymentCancelled(true);
              setPayOpen(false);
            }
          } catch {
            // 读不到最新单据时保留原快照与现有提示，不把未知结果伪装成成功或失败。
          }
        })();
      };
      return <>
        <div className="rental-confirm rental-confirm--quote rental-confirm--created">
          <div className="rental-confirm-head">
            <strong>{paymentCancelled ? "订单已取消" : paymentAccepted ? "支付已接纳" : "订单已创建 · 待支付"}</strong>
            <span className="rental-confirm-tier">{created.displayNo ?? "订单号待确认"}</span>
          </div>
          {!paymentAccepted && !paymentCancelled && created.holdUntil ? (
            <div className="account-pending-countdown-wrap">
              <span className="account-pending-countdown-badge" data-state={created.expiredAwaitingCancel ? "expired" : "active"}>
                <Clock3 size={13} aria-hidden="true" />
                <span>{countdown(created.holdUntil, now) ?? "支付保留中"}</span>
              </span>
            </div>
          ) : null}
          <RentalCreatedAmount total={total} />
          <p className="detail-stage-note">{paymentCancelled ? "订单已取消，账号占用已解除。可查看订单或返回账号列表。" : paymentAccepted ? "订单状态以服务端记录为准；付款后专属客服将在群内协助确认开租。" : "账号已为你保留独占锁定。关闭付款窗口后，可在本页或个人中心“待支付”继续付款。"}</p>
          <div className="rental-confirm-actions">
            {!paymentAccepted && !paymentCancelled ? (
              <div className="rental-confirm-primary-action">
                <button type="button" className="button rental-confirm-primary" onClick={() => setPayOpen(true)}>
                  <ShieldCheck size={17} aria-hidden="true" />
                  <span>继续支付{total ? ` · ${total}` : ""}</span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            <Link className="button quiet button--sm" href={orderHref(created.id)}>查看订单</Link>
          </div>
        </div>
        <PaymentDialog order={created} party="renter" open={payOpen} onOpenChange={setPayOpen} onChanged={readBack} onAccepted={() => setPaymentAccepted(true)} onCancelled={() => { setPaymentCancelled(true); setPayOpen(false); }} />
      </>;
    }

    const quote = stage.quote;
    const payable = formatMoneyLabel(quote.quote.tenantPayableTotal ?? null) ?? "以服务端确认为准";
    const disclosure = quote.compensationDisclosure;
    const expired = ["已过期", null].includes(countdown(quote.expiresAt, now));
    return <div className="rental-confirm rental-confirm--quote">
      <RentalPriceChangeNotice notice={priceChangeNotice} />
      {!reference ? <RentalPersonalQuoteFacts quote={quote} /> : null}
      <div className="rental-confirm-legal-box">
        <div className="rental-confirm-terms-bar">
          <div className="rental-confirm-terms-info">
            <FileText size={14} className="rental-confirm-terms-icon" aria-hidden="true" />
            <span className="rental-confirm-terms-label">服务协议与保障</span>
          </div>
          <button type="button" className="rental-terms-open" onClick={() => setTermsOpen(true)}>
            <span>查看费用与适用条款</span>
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </div>

        {termsOpen ? <Dialog.Root open onOpenChange={setTermsOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="modal-overlay" />
            <Dialog.Content className="rental-terms-dialog rental-terms-dialog--terms" aria-describedby={undefined}>
              <div className="rental-terms-dialog-head">
                <Dialog.Title className="rental-terms-dialog-title"><FileText size={18} aria-hidden="true" /><span>费用与适用条款</span></Dialog.Title>
                <Dialog.Close asChild><button type="button" className="rental-terms-dialog-close-btn" aria-label="关闭条款"><X size={18} aria-hidden="true" /></button></Dialog.Close>
              </div>
              <div className="rental-terms-dialog-body">
                <p className="rental-terms-dialog-copy"><ShieldCheck size={14} aria-hidden="true" />包赔条款：{disclosure ? disclosure.selected ? "已选择" : "未选择" : "本单适用旧版依据（未选择包赔）"}；选择全额包赔时，服务费由号主承担，按结算时号主扣费前收入的 8% 计算。费用不与押金、平台价差、提前补足混算；实际赔付按约定处理。</p>
                {stage.agreement ? <section className="rental-terms-dialog-agreement">
                  <h3>{stage.agreement.title}</h3>
                  <TradeTermsDocument body={stage.agreement.body} document={stage.agreement.bodyDocument} target={stage.agreement.digest} onReady={setReadAgreement} />
                </section> : <p className="detail-stage-note">本单适用协议暂时无法读取。</p>}
                {stage.agreementProblem ? <p className="rental-confirm-error"><AlertCircle size={14} aria-hidden="true" />{stage.agreementProblem}</p> : null}
              </div>
              <div className="rental-terms-dialog-footer">
                <Dialog.Close asChild><button type="button" className="button primary">关闭</button></Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root> : null}

        <PayoutTerms state={payout} accepted={payoutAccepted} locked onAccept={setPayoutAccepted} />

        {stage.agreementProblem ? <p className="rental-confirm-error"><AlertCircle size={14} aria-hidden="true" />{stage.agreementProblem}</p> : null}

        <label className="rental-confirm-consent">
          <input
            type="checkbox"
            checked={agreementAccepted}
            disabled={!stage.agreement || Boolean(stage.agreementProblem) || Boolean(stage.agreement.bodyDocument && readAgreement !== stage.agreement.digest)}
            onChange={(event) => setAgreementAccepted(event.target.checked)}
          />
          <span>我已阅读并同意本单适用协议{stage.agreement ? `《${stage.agreement.title}》` : ""}</span>
        </label>
      </div>

      {expired ? <p className="rental-confirm-error"><AlertCircle size={14} aria-hidden="true" />报价已过期，请重新报价。</p> : null}
      <div className="rental-confirm-actions">
        <div className="rental-confirm-primary-action">
          {dockPrice}
          <button
            type="button"
            className="button rental-confirm-primary"
            onClick={() => void sendCreate(quote)}
            disabled={Boolean(stage.agreementProblem) || !stage.agreement || !agreementAccepted || Boolean(stage.agreement.bodyDocument && readAgreement !== stage.agreement.digest) || expired || (fullPayoutSelected && !payoutAcceptance)}
          >
            <ShieldCheck size={18} className="rental-confirm-primary-shield" aria-hidden="true" />
            <span className="rental-confirm-primary-cta">确认并创建订单</span>
            {payable ? <span className="rental-confirm-primary-amount">· 立即支付 {payable}</span> : null}
            <ChevronRight size={16} className="rental-confirm-primary-arrow" aria-hidden="true" />
          </button>
        </div>
        {expired || priceChangeNotice ? <button type="button" className="button quiet button--sm" onClick={() => void requote()}>重新报价</button> : null}
        <button type="button" className="rental-confirm-cancel-action" onClick={() => setStage({ kind: "idle" })}>取消</button>
      </div>

      <div className="rental-confirm-trust-badges" aria-label="交易安全保障">
        <div className="rental-confirm-trust-item">
          <ShieldCheck size={13} aria-hidden="true" />
          <span>官方资金托管</span>
        </div>
        <div className="rental-confirm-trust-item">
          <Headphones size={13} aria-hidden="true" />
          <span>专属客服1对1协助</span>
        </div>
        <div className="rental-confirm-trust-item">
          <RotateCcw size={13} aria-hidden="true" />
          <span>押金未消耗即退</span>
        </div>
      </div>
    </div>;
  };
  return <div className={reference ? "rental-detail-confirm" : undefined} data-price-state={stage.kind}>
    {reference ? <RentalPriceSummary reference={reference} quote={priceQuote} pendingLabel={pendingLabel} /> : null}
    {renderStage()}
  </div>;
}
