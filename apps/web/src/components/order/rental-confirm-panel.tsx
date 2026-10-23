"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Clock3, FileText, RotateCw, ShieldCheck, WalletCards } from "lucide-react";
import { orderApi, orderIntentKey, OrderRequestError, type PersonalRentalQuote, type FullPayoutTerms, type FullPayoutTermsAcceptance } from "@/lib/order-client";
import { clearIntent, isIntentStale, loadIntent, saveIntent } from "@/lib/order-intents";
import { formatMoneyLabel } from "@/lib/listing-view";
import { supplyApi } from "@/lib/supply-client";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import { RentalPriceSummary, type ReferenceFees } from "./rental-price-summary";
import { moneyText,personalMembershipLabel,personalBenefitSources } from "@/lib/order-display";
import { performGuardedWrite, type WriteOutcome } from "@/components/order/order-trade-actions";

type AgreementInfo = { id: string; title: string; body: string; digest: string };
type StoredContext = { payable?: string; tier?: string; deposit?: string; expiresAt?: string; disclosure?: string };

type Stage =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "quoted"; quote: PersonalRentalQuote; agreement: AgreementInfo | null; agreementProblem: string | null }
  | { kind: "creating"; quote: PersonalRentalQuote | null }
  | { kind: "create-unknown"; context: StoredContext; message: string; stale: boolean }
  | { kind: "created"; quote: PersonalRentalQuote; orderId: string }
  | { kind: "paying"; orderId: string }
  | { kind: "pay-unknown"; orderId: string; message: string }
  | { kind: "paid"; orderId: string }
  | { kind: "review"; orderId: string; reason: string | null }
  | { kind: "notice"; message: string; canRequote: boolean; orderId?: string; action?: "orders" | "refresh" | "back" };

const AUTH_MESSAGE = "登录状态已变化。原创建请求与幂等键已保留；正在确认身份，确认后可在本页恢复。";
const BLOCKED_MESSAGE = "浏览器会话存储不可用，无法保存原请求恢复信息；已阻止创建，避免产生不可恢复的订单。";
const STALE_MESSAGE = "该原创建请求已超出自动查询窗口；请先查询权威订单列表核对，不要重新确认或重复下单。";

function errorOf(error: unknown): OrderRequestError {
  return error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
}

function noticeFor(error: OrderRequestError): { message: string; canRequote: boolean; action?: "orders" | "refresh" | "back" } {
  if (error.code === "PREVIEW_READ_ONLY") return { message: "当前预览仅开放浏览，暂未接通个人报价与租用。", canRequote: false, action: "back" };
  if (error.code === "CONFIRMATION_INVALID") return { message: "本次确认凭据无效，请重新获取本人报价后再创建订单。", canRequote: true };
  if (error.code === "CONFIRMATION_EXPIRED" || error.code === "CONFIRMATION_CHANGED") {
    return { message: "报价或资格已变化，原确认已失效；请重新确认后创建。", canRequote: true };
  }
  if (error.code === "CONFIRMATION_USED") {
    return { message: "该确认凭据已被使用。请查询租入订单核对，不要重复付款。", canRequote: false, action: "orders" };
  }
  if (error.status === 403) return { message: "当前身份暂不能租用该账号。", canRequote: false, action: "back" };
  if (error.status === 404) return { message: "账号或发布版本已变化，请刷新页面后重试。", canRequote: false, action: "refresh" };
  return { message: error.message || "操作未完成，请稍后重试。", canRequote: true };
}

function countdown(expiresAt: string, now: number): string | null {
  const until = Date.parse(expiresAt);
  if (!Number.isFinite(until)) return null;
  const seconds = Math.max(0, Math.floor((until - now) / 1000));
  if (seconds <= 0) return "已过期";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 内有效`;
}

const orderHref = (orderId: string) => `/account?view=rentals&orderId=${encodeURIComponent(orderId)}`;

type PayoutState = { status: "loading" } | { status: "ready"; terms: FullPayoutTerms } | { status: "unavailable"; message: string };

function PayoutTerms({ state, accepted, locked, onAccept }: { state: PayoutState | null; accepted: boolean; locked: boolean; onAccept: (value: boolean) => void }) {
  if (!state) return null;
  return <section className="rental-confirm-payout" aria-label="全额包赔条款">
    <div className="rental-confirm-payout-head"><ShieldCheck size={15} aria-hidden="true" /><strong>全额包赔 · 需同意条款</strong></div>
    {state.status === "loading" ? <p className="detail-stage-note">正在读取本账号适用的全额包赔条款…</p> : null}
    {state.status === "unavailable" ? <p className="rental-confirm-error"><AlertCircle size={14} aria-hidden="true" />{state.message}</p> : null}
    {state.status === "ready" ? <>
      <p className="detail-stage-note">号主已选择全额包赔。下单前须阅读并同意本账号本次实际适用的条款；条款与本次报价凭据绑定，版本变化需要重新确认。</p>
      <details className="rental-confirm-terms"><summary>查看全额包赔条款（{state.terms.title}）</summary>
        <div className="rental-confirm-agreement" role="region" aria-label="全额包赔条款全文">
          <p><strong>{state.terms.title}</strong></p>
          <pre>{state.terms.body}</pre>
        </div>
      </details>
      <label className="rental-confirm-payout-accept">
        <input type="checkbox" aria-label="我已阅读并同意全额包赔条款" checked={accepted} disabled={locked} onChange={(event) => onAccept(event.target.checked)} />
        <span>{accepted ? "已阅读并同意该包赔条款" : "我已阅读并同意该包赔条款"}</span>
      </label>
    </> : null}
  </section>;
}

export function RentalConfirmPanel({ accountId, gameId, versionId, releaseId, reference, fullPayoutSelected = false }: { accountId: string; gameId?: string | null; versionId?: string; releaseId?: string; reference?: ReferenceFees; fullPayoutSelected?: boolean }) {
  const session = useUserSession();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const [agreementOpen, setAgreementOpen] = useState(false);
  const createKey = useRef<string | null>(null);
  const quoteGeneration = useRef(0);
  const [payout, setPayout] = useState<PayoutState | null>(fullPayoutSelected ? { status: "loading" } : null);
  const [payoutAccepted, setPayoutAccepted] = useState(false);
  const quoteTarget = JSON.stringify([accountId, gameId, versionId, releaseId]);
  const currentQuoteTarget = useRef(quoteTarget);
  currentQuoteTarget.current = quoteTarget;
  const reset = useCallback(() => {
    createKey.current = null;
    quoteGeneration.current += 1;
    setAgreementOpen(false);
    setStage({ kind: "idle" });
  }, []);
  const previousQuoteTarget = useRef(quoteTarget);
  if (previousQuoteTarget.current !== quoteTarget) {
    previousQuoteTarget.current = quoteTarget;
    reset();
  }
  const { userId, isCurrent } = useIdentityReset(session, reset);

  const payoutTarget = `${gameId ?? ""}:${releaseId ?? ""}`;
  useEffect(() => {
    if (!fullPayoutSelected || !gameId || !releaseId) { setPayout(null); return; }
    setPayoutAccepted(false);
    setPayout({ status: "loading" });
    const controller = new AbortController();
    supplyApi.fullPayoutTerms(gameId, releaseId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.releaseId !== releaseId || !result.fullPayoutTerms) setPayout({ status: "unavailable", message: "当前发布版本没有可读取的全额包赔条款，暂不能创建订单。" });
      else setPayout({ status: "ready", terms: result.fullPayoutTerms });
    }).catch(() => {
      if (!controller.signal.aborted) setPayout({ status: "unavailable", message: "全额包赔条款暂时无法读取；为安全起见暂不能创建订单，请稍后重试。" });
    });
    return () => controller.abort();
  }, [fullPayoutSelected, gameId, releaseId, payoutTarget]);

  // Only an exact acceptance of the terms read for this listing may be sent; a missing
  // acceptance blocks the same calls the API fails closed on (409 terms conflict).
  const payoutAcceptance = useMemo<FullPayoutTermsAcceptance | undefined>(() => (
    fullPayoutSelected && payout?.status === "ready" && payoutAccepted
      ? { termsVersionId: payout.terms.termsVersionId, termsDigest: payout.terms.termsDigest, disclosureVersion: payout.terms.disclosureVersion }
      : undefined
  ), [fullPayoutSelected, payout, payoutAccepted]);
  const payoutGateOpen = !fullPayoutSelected || Boolean(payoutAcceptance);

  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "order.create.v2", accountId);
    if (intent) setStage({ kind: "create-unknown", context: (intent.context ?? {}) as StoredContext, message: isIntentStale(intent) ? STALE_MESSAGE : "检测到一笔结果未知的创建请求；原凭据与幂等键已冻结。", stale: isIntentStale(intent) });
  }, [userId, accountId]);

  useEffect(() => {
    if (stage.kind !== "quoted" && stage.kind !== "creating") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage.kind]);

  const requote = useCallback(async () => {
    if (!userId) {
      setStage({ kind: "notice", message: "请先登录后再确认租赁。", canRequote: false });
      return;
    }
    const acting = userId;
    const generation = ++quoteGeneration.current;
    const target = currentQuoteTarget.current;
    const isQuoteCurrent = () => isCurrent(acting) && generation === quoteGeneration.current && target === currentQuoteTarget.current;
    if (loadIntent(acting, "order.create.v2", accountId)) {
      const intent = loadIntent(acting, "order.create.v2", accountId)!;
      setStage({ kind: "create-unknown", context: (intent.context ?? {}) as StoredContext, message: isIntentStale(intent) ? STALE_MESSAGE : "检测到一笔结果未知的创建请求；请先查询原请求结果。", stale: isIntentStale(intent) });
      return;
    }
    if (!versionId || !releaseId || !gameId) {
      setStage({ kind: "notice", message: "该账号当前缺少可确认的发布依据，暂不支持在线确认租赁。", canRequote: false });
      return;
    }
    if (!payoutGateOpen) {
      setStage({ kind: "notice", message: "请先阅读并同意本账号的全额包赔条款，再读取个人报价。", canRequote: false });
      return;
    }
    setStage({ kind: "quoting" });
    try {
      const quote = await orderApi.confirmRental({ accountId, versionId, releaseId, ...(payoutAcceptance ? { fullPayoutTermsAcceptance: payoutAcceptance } : {}) });
      if (!isQuoteCurrent()) return;
      const authoritativeTerms = quote.compensationDisclosure?.terms;
      if (quote.compensationDisclosure?.selected && payoutAcceptance && authoritativeTerms
        && (authoritativeTerms.termsVersionId !== payoutAcceptance.termsVersionId || authoritativeTerms.termsDigest !== payoutAcceptance.termsDigest
          || authoritativeTerms.disclosureVersion !== payoutAcceptance.disclosureVersion)) {
        setStage({ kind: "notice", message: "包赔条款版本与已同意的版本不一致，请刷新页面后重新确认。", canRequote: false, action: "refresh" });
        return;
      }
      let agreement: AgreementInfo | null = null;
      let agreementProblem: string | null = null;
      try {
        const options = await supplyApi.publishingOptions(gameId);
        if (options.releaseId === releaseId) agreement = options.agreement;
        else agreementProblem = "当前生效的协议版本与你确认的发布版本不一致；为避免绑定错误条款，暂不能创建订单。";
      } catch {
        agreementProblem = "协议与条款依据暂时无法读取；为安全起见暂不能创建订单，请稍后重试。";
      }
      if (!isQuoteCurrent()) return;
      setStage({ kind: "quoted", quote, agreement, agreementProblem });
    } catch (error) {
      if (!isQuoteCurrent()) return;
      const typed = errorOf(error);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") {
        void session.confirm();
        setStage({ kind: "notice", message: "登录状态已变化，请重新登录后查看最终报价。", canRequote: false });
      } else if (typed.status === 0 || typed.status >= 500) setStage({ kind: "notice", message: "最终报价暂时无法读取，请稍后重试。", canRequote: true });
      else setStage({ kind: "notice", ...noticeFor(typed) });
    }
  }, [accountId, gameId, releaseId, userId, isCurrent, versionId, session, payoutGateOpen, payoutAcceptance]);

  const sendCreate = useCallback(async (quote: PersonalRentalQuote) => {
    if (!userId) return;
    const acting = userId;
    const target = currentQuoteTarget.current;
    if (fullPayoutSelected && !payoutAcceptance) {
      setStage({ kind: "notice", message: "请先阅读并同意本账号的全额包赔条款，再创建订单。", canRequote: false });
      return;
    }
    if (loadIntent(acting, "order.create.v2", accountId)) {
      const intent = loadIntent(acting, "order.create.v2", accountId)!;
      setStage({ kind: "create-unknown", context: (intent.context ?? {}) as StoredContext, message: "已有未决的创建请求；只允许查询原结果，不会重新下单。", stale: isIntentStale(intent) });
      return;
    }
    const key = orderIntentKey();
    createKey.current = key;
    const context: StoredContext = {
      payable: quote.quote?.tenantPayableTotal?.amount,
      tier: personalMembershipLabel(quote),
      deposit: quote.depositWaived ? undefined : quote.quote?.tenantDeposit?.amount,
      expiresAt: quote.expiresAt,
      ...(quote.compensationDisclosure ? { disclosure: quote.compensationDisclosure.disclosureVersion } : {}),
    };
    const saved = saveIntent({ userId: acting, kind: "order.create.v2", resourceId: accountId, key, body: payoutAcceptance ? { fullPayoutTermsAcceptance: payoutAcceptance } : {}, token: quote.confirmationToken, context: context as Record<string, unknown> });
    if (!saved.persisted) {
      createKey.current = null;
      setStage({ kind: "notice", message: BLOCKED_MESSAGE, canRequote: true });
      return;
    }
    setStage({ kind: "creating", quote });
    try {
      const order = await orderApi.createOrder(quote.confirmationToken, key, payoutAcceptance);
      if (!isCurrent(acting) || target !== currentQuoteTarget.current) return;
      clearIntent(acting, "order.create.v2", accountId);
      createKey.current = null;
      setStage({ kind: "created", quote, orderId: order.id });
      // Immediate local payment is offered on the created panel; the order page remains authoritative.
    } catch (error) {
      if (!isCurrent(acting)) return;
      const typed = errorOf(error);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") {
        void session.confirm();
        setStage({ kind: "notice", message: AUTH_MESSAGE, canRequote: false });
        return;
      }
      if (typed.status === 0 || typed.status >= 500) {
        setStage({ kind: "create-unknown", context, message: "创建请求的结果未知。原凭据与幂等键已冻结，请查询原结果；不要重新确认或重复下单。", stale: false });
        return;
      }
      // A fresh key with a server 4xx is a definitive non-commit.
      clearIntent(acting, "order.create.v2", accountId);
      createKey.current = null;
      setStage({ kind: "notice", ...noticeFor(typed) });
    }
  }, [accountId, userId, isCurrent, session, fullPayoutSelected, payoutAcceptance]);

  const recoverCreate = useCallback(async () => {
    if (!userId) return;
    const acting = userId;
    const target = currentQuoteTarget.current;
    const intent = loadIntent(acting, "order.create.v2", accountId);
    if (!intent?.token) {
      setStage({ kind: "notice", message: "未找到可恢复的原创建请求，请刷新后重新确认。", canRequote: true });
      return;
    }
    createKey.current = intent.key;
    setStage({ kind: "creating", quote: null });
    try {
      const frozenAcceptance = (intent.body as { fullPayoutTermsAcceptance?: FullPayoutTermsAcceptance } | undefined)?.fullPayoutTermsAcceptance;
      const order = await orderApi.createOrder(intent.token, intent.key, frozenAcceptance);
      if (!isCurrent(acting) || target !== currentQuoteTarget.current) return;
      clearIntent(acting, "order.create.v2", accountId);
      createKey.current = null;
      setStage({ kind: "notice", message: `原创建请求已确认成功（订单 ${order.displayNo ?? order.id}）。`, canRequote: false, orderId: order.id });
    } catch (error) {
      if (!isCurrent(acting)) return;
      const typed = errorOf(error);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") {
        void session.confirm();
        setStage({ kind: "create-unknown", context: (intent.context ?? {}) as StoredContext, message: AUTH_MESSAGE, stale: false });
        return;
      }
      if (typed.status === 0 || typed.status >= 500) {
        setStage({ kind: "create-unknown", context: (intent.context ?? {}) as StoredContext, message: "仍未取得结果；可稍后再次查询原请求。", stale: false });
        return;
      }
      // A 4xx while recovering is not proof: the order list is only observed, never used to
      // claim the original request succeeded or never happened, and the intent stays frozen.
      let observed = "";
      try {
        const page = await orderApi.list({ party: "renter", accountId, limit: 5 });
        if (!isCurrent(acting)) return;
        observed = page.items.length
          ? `当前账号最近订单：${page.items.slice(0, 3).map((item) => item.displayNo ?? item.id).join("、")}`
          : "当前账号暂无可读订单";
      } catch {
        observed = "订单列表暂时无法读取";
      }
      if (isCurrent(acting)) {
        setStage({ kind: "create-unknown", context: (intent.context ?? {}) as StoredContext, message: `原创建请求仍未取得确定回执（服务端返回「${typed.message || "拒绝"}」，原凭据与幂等键保留）。${observed}；读取结果不构成“已生效/未生效”证明，请稍后再次查询或联系客服核对。`, stale: false });
      }
    }
  }, [accountId, userId, isCurrent, session]);

  const applyPayment = useCallback((acting: string, outcome: WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, orderId: string) => {
    if (outcome.status === "ok") {
      if (outcome.value.payment.disposition === "APPLIED") setStage({ kind: "paid", orderId });
      else setStage({ kind: "review", orderId, reason: outcome.value.payment.reasonCode ?? null });
      return;
    }
    if (outcome.status === "unknown") { setStage({ kind: "pay-unknown", orderId, message: outcome.message }); return; }
    if (outcome.status === "blocked") { setStage({ kind: "notice", message: BLOCKED_MESSAGE, canRequote: false, orderId }); return; }
    if (outcome.status === "unauthorized") { void session.confirm(); setStage({ kind: "notice", message: AUTH_MESSAGE, canRequote: false, orderId }); return; }
    if (outcome.status === "recovery-unresolved") { void resolvePayment(acting, orderId); return; }
    setStage({ kind: "notice", ...noticeFor(outcome.error), orderId });
  }, [session]);

  const resolvePayment = useCallback(async (acting: string, orderId: string) => {
    try {
      const authority = await orderApi.paymentStatus(orderId);
      if (!isCurrent(acting)) return;
      const observed = authority.payment
        ? `服务端已有付款记录（${authority.payment.disposition}）`
        : `当前订单状态 ${authority.order.status}，暂未观察到付款记录`;
      setStage({ kind: "pay-unknown", orderId, message: `原支付请求仍未取得确定回执（原幂等键保留）。${observed}；读取结果不构成“已生效/未生效”证明，请稍后再次查询或联系客服核对。` });
    } catch {
      if (isCurrent(acting)) setStage({ kind: "pay-unknown", orderId, message: "原支付请求仍未取得确定回执；权威付款状态暂时无法读取。原请求保留，请稍后再次查询。" });
    }
  }, [isCurrent]);

  const pay = useCallback(async (orderId: string) => {
    if (!userId) return;
    const acting = userId;
    setStage({ kind: "paying", orderId });
    const outcome = await performGuardedWrite(acting, "order.payment", orderId, {}, undefined, (key) => orderApi.pay(orderId, key));
    if (!isCurrent(acting)) return;
    applyPayment(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, orderId);
  }, [userId, isCurrent, applyPayment]);

  const recoverPayment = useCallback(async (orderId: string) => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "order.payment", orderId)) { void resolvePayment(acting, orderId); return; }
    const outcome = await performGuardedWrite(acting, "order.payment", orderId, {}, undefined, (key) => orderApi.pay(orderId, key));
    if (!isCurrent(acting)) return;
    applyPayment(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, orderId);
  }, [userId, isCurrent, applyPayment, resolvePayment]);

  // Presentation uses the existing controller and identity reset; it owns no request state.
  const expiredQuote = stage.kind === "quoted" && ["已过期", null].includes(countdown(stage.quote.expiresAt, now));
  const priceQuote = userId && stage.kind === "quoted" && !expiredQuote ? stage.quote : null;
  const pendingLabel = session.status === "loading" ? "正在确认登录状态" :
    stage.kind === "quoted" && countdown(stage.quote.expiresAt, now) === null ? "报价有效期未确认" :
    expiredQuote ? "报价已过期" : stage.kind === "quoting" ? "正在读取本人报价" :
    stage.kind === "create-unknown" || stage.kind === "pay-unknown" ? "原请求结果待确认" :
    stage.kind === "creating" ? "正在确认订单" : stage.kind === "notice" ? "本人报价待确认" :
    stage.kind !== "idle" && stage.kind !== "quoted" ? "请查看订单金额" : undefined;
  const dockPrice = reference ? <span className="rental-dock-price"><span>{priceQuote ? "本次应付" : pendingLabel ?? "参考费用 · 押金另核"}</span><strong>{priceQuote ? moneyText(priceQuote.quote.tenantPayableTotal) : pendingLabel ? "—" : reference.total}</strong></span> : null;
  const renderStage = () => {
    if (!versionId || !releaseId || !gameId) {
      return <p className="detail-stage-note">当前缺少可确认的发布依据，暂不能创建订单。</p>;
    }

    if (stage.kind === "idle") return <div className="rental-confirm" data-stage="idle">
      <PayoutTerms state={payout} accepted={payoutAccepted} locked={false} onAccept={setPayoutAccepted} />
      <div className="rental-confirm-actions"><div className="rental-confirm-primary-action">{dockPrice}{!userId && session.status !== "loading" ? <Link className="button rental-confirm-primary" href={`/login?next=${encodeURIComponent(`/accounts/${accountId}`)}`}>登录后显示最终报价</Link> : <button type="button" className="button rental-confirm-primary" onClick={() => void requote()} disabled={session.status === "loading" || !payoutGateOpen}>{!payoutGateOpen ? "请先同意包赔条款" : "查看我的报价"}</button>}</div></div>
      <p className="detail-stage-note">先核对本人的会员价格、押金和适用条款，再确认创建订单。</p>
    </div>;

    if (stage.kind === "quoting") return <div className="rental-confirm" data-stage="quoting" aria-busy="true"><div className="rental-confirm-actions"><div className="rental-confirm-primary-action">{dockPrice}<button type="button" className="button rental-confirm-primary" disabled>正在读取个人报价与条款…</button></div></div></div>;

    if (stage.kind === "notice") return <div className="rental-confirm rental-confirm--error" role="alert">
      <p className="rental-confirm-error"><AlertCircle size={15} aria-hidden="true" />{stage.message}</p>
      <div className="rental-confirm-actions">
        {stage.orderId ? <Link className="button secondary button--sm" href={orderHref(stage.orderId)}>查看订单</Link> : null}
        {stage.canRequote ? <button type="button" className="button secondary button--sm" onClick={() => void requote()}><RotateCw size={14} aria-hidden="true" />重新确认</button> : null}
        {!stage.canRequote && !stage.orderId && !userId ? <Link className="button secondary button--sm" href={`/login?next=${encodeURIComponent(`/accounts/${accountId}`)}`}>去登录</Link> : null}
        {!stage.canRequote && !stage.orderId && userId && stage.action === "orders" ? <Link className="button secondary button--sm" href="/account?view=rentals">查看租入订单</Link> : null}
        {!stage.canRequote && !stage.orderId && userId && stage.action === "refresh" ? <button type="button" className="button secondary button--sm" onClick={() => window.location.reload()}>刷新账号资料</button> : null}
        {!stage.canRequote && !stage.orderId && userId && (stage.action === "back" || !stage.action) ? <Link className="button secondary button--sm" href="/accounts">返回账号列表</Link> : null}
      </div>
    </div>;

    if (stage.kind === "create-unknown") return <div className="rental-confirm rental-confirm--unknown" role="status">
      <p className="rental-confirm-heading"><Clock3 size={15} aria-hidden="true" />创建请求结果未知</p>
      <p className="detail-stage-note">原确认凭据与幂等键已冻结：{stage.context.payable ? `预计合计 ¥${stage.context.payable}、` : ""}{stage.context.tier ? `档位 ${stage.context.tier}` : ""}。请先查询原请求结果，不要重新确认、重复下单或改价。</p>
      <p className="rental-confirm-error"><AlertCircle size={14} aria-hidden="true" />{stage.message}</p>
      <div className="rental-confirm-actions">
        <div className="rental-confirm-primary-action">{dockPrice}<button type="button" className="button rental-confirm-primary" onClick={() => void recoverCreate()}>查询原创建结果</button></div>
        <Link className="button quiet button--sm" href="/account?view=rentals">查看租入订单</Link>
      </div>
    </div>;

    if (stage.kind === "paid") return <div className="rental-confirm rental-confirm--done" role="status">
      <p className="rental-confirm-success"><CheckCircle2 size={15} aria-hidden="true" />支付已接纳（本地受控收款依据，不代表真实到账）</p>
      <Link className="button secondary button--sm" href={orderHref(stage.orderId)}>查看订单与开租进度</Link>
    </div>;

    if (stage.kind === "review") return <div className="rental-confirm rental-confirm--done" role="status">
      <p className="rental-confirm-error"><AlertCircle size={15} aria-hidden="true" />支付结果需要人工核对{stage.reason ? `（${stage.reason}）` : ""}；未重复扣款。</p>
      <Link className="button secondary button--sm" href={orderHref(stage.orderId)}>查看订单</Link>
    </div>;

    if (stage.kind === "pay-unknown") return <div className="rental-confirm rental-confirm--unknown" role="status">
      <p className="rental-confirm-heading"><Clock3 size={15} aria-hidden="true" />支付请求结果未知</p>
      <p className="detail-stage-note">请使用同一请求查询原结果（幂等重放），不会重复扣款。</p>
      <p className="rental-confirm-error"><AlertCircle size={14} aria-hidden="true" />{stage.message}</p>
      <div className="rental-confirm-actions">
        <div className="rental-confirm-primary-action">{dockPrice}<button type="button" className="button rental-confirm-primary" onClick={() => void recoverPayment(stage.orderId)}>查询原支付结果</button></div>
        <Link className="button quiet button--sm" href={orderHref(stage.orderId)}>查看订单</Link>
      </div>
    </div>;

    if (stage.kind === "creating") return <div className="rental-confirm" aria-busy="true">
      <p className="detail-stage-note">{stage.quote ? "正在创建订单并占用账号；若网络中断，本页会保留原请求供你查询。" : "正在查询原创建请求…"}</p>
    </div>;

    if (stage.kind === "created" || stage.kind === "paying") {
      const orderId = stage.orderId;
      return <div className="rental-confirm rental-confirm--quote">
        <div className="rental-confirm-head"><strong>订单已创建</strong><span className="rental-confirm-tier">{orderId}</span></div>
        {stage.kind === "created" ? <p className="rental-confirm-total-line">预计合计 {formatMoneyLabel(stage.quote.quote?.tenantPayableTotal ?? null) ?? "以服务端确认为准"}</p> : null}
        <p className="detail-stage-note">本地受控支付只生成本地收款依据，不代表真实渠道到账；付款不等于交付或开租。</p>
        <div className="rental-confirm-actions">
          <div className="rental-confirm-primary-action">{dockPrice}<button type="button" className="button rental-confirm-primary" onClick={() => void pay(orderId)} disabled={stage.kind === "paying"}>
            {stage.kind === "paying" ? "提交支付请求…" : "提交本地受控支付"}
          </button></div>
          <Link className="button quiet button--sm" href={orderHref(orderId)}>稍后支付，查看订单</Link>
        </div>
      </div>;
    }

    const quote = stage.quote;
    const money = quote.quote;
    const payable = formatMoneyLabel(money.tenantPayableTotal ?? null) ?? "以服务端确认为准";
    const disclosure = quote.compensationDisclosure;
    const expired = ["已过期", null].includes(countdown(quote.expiresAt, now));
    return <div className="rental-confirm rental-confirm--quote">
      {!reference ? <><div className="rental-confirm-head"><strong>个人报价确认</strong>
        <span className="rental-confirm-tier">{personalMembershipLabel(quote)}{quote.depositWaived ? " · 已免租客押金" : ""}</span></div>
      {personalBenefitSources(quote)?<p>{personalBenefitSources(quote)}</p>:null}
      <dl className="rental-confirm-facts">
        <div><dt>资源费用</dt><dd>{formatMoneyLabel(money.resourceTotal ?? null) ?? "—"}</dd></div>
        <div><dt>租客押金</dt><dd>{quote.depositWaived ? "已免押" : formatMoneyLabel(money.tenantDeposit ?? quote.baseTenantDeposit) ?? "—"}</dd></div>
        <div className="rental-confirm-total"><dt>预计合计</dt><dd>{payable}</dd></div>
      </dl>
      </> : null}
      <PayoutTerms state={payout} accepted={payoutAccepted} locked onAccept={setPayoutAccepted} />
      <details className="rental-confirm-terms"><summary>费用与适用条款<ChevronDown size={16} aria-hidden="true" /></summary>
        <p className="rental-confirm-disclosure"><ShieldCheck size={14} aria-hidden="true" />包赔条款：{disclosure ? disclosure.selected ? "已选择" : "未选择" : "本单适用旧版依据（未选择包赔）"}；结算按生效规则的号主侧毛额费率 8% 计算，承担方由结束场景决定（正常由号主、租客自愿提前由租客、号主原因原则上仍由号主）。费用不与押金、平台价差、提前补足混算；实际赔付由客服与运营按约定处理。</p>
        {disclosure ? <p className="rental-confirm-terms-meta">披露版本 {disclosure.disclosureVersion} · 与本次确认凭据绑定</p> : null}
        {stage.agreement ? <>
          <button type="button" className="button quiet button--sm" aria-expanded={agreementOpen} onClick={() => setAgreementOpen((open) => !open)}>
            <FileText size={14} aria-hidden="true" />{agreementOpen ? `收起协议全文（${stage.agreement.title}）` : `查看本次适用协议全文（${stage.agreement.title}）`}
          </button>
          {agreementOpen ? <div className="rental-confirm-agreement" role="region" aria-label="适用协议全文">
            <p><strong>{stage.agreement.title}</strong></p>
            <pre>{stage.agreement.body}</pre>
            <p className="rental-confirm-terms-meta">协议摘要 {stage.agreement.digest.slice(0, 16)}… · 版本 {stage.agreement.id}</p>
          </div> : null}
        </> : null}
        {stage.agreementProblem ? <p className="rental-confirm-error"><AlertCircle size={14} aria-hidden="true" />{stage.agreementProblem}</p> : null}
      </details>
      <p className="rental-confirm-expiry"><Clock3 size={14} aria-hidden="true" />确认凭据 {countdown(quote.expiresAt, now) ?? "有效期以服务端为准"}；会员、规则或资格变化后需要重新确认。</p>
      <div className="rental-confirm-actions">
        <div className="rental-confirm-primary-action">{dockPrice}<button type="button" className="button rental-confirm-primary" onClick={() => void sendCreate(quote)} disabled={Boolean(stage.agreementProblem) || expired || (fullPayoutSelected && !payoutAcceptance)}><WalletCards size={15} aria-hidden="true" />确认并创建订单</button></div>
        <button type="button" className="button quiet button--sm" onClick={() => void requote()}>重新报价</button>
        <button type="button" className="button quiet button--sm" onClick={() => setStage({ kind: "idle" })}>取消</button>
      </div>
    </div>;
  };
  return <div className={reference ? "rental-detail-confirm" : undefined} data-price-state={stage.kind}>
    {reference ? <RentalPriceSummary reference={reference} quote={priceQuote} pendingLabel={pendingLabel} /> : null}
    {renderStage()}
  </div>;
}
