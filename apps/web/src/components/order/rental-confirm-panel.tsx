"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { orderApi, orderIntentKey, OrderRequestError, type PersonalRentalQuote, type FullPayoutTermsAcceptance } from "@/lib/order-client";
import { clearIntent, isIntentStale, loadIntent, saveIntent } from "@/lib/order-intents";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import { type ReferenceFees } from "./rental-price-summary";
import { moneyText, paymentObservation, personalMembershipLabel } from "@/lib/order-display";
import { performGuardedWrite, type WriteOutcome } from "@/components/order/order-trade-actions";
import { findQuoteChanges, type PreviewState, type Stage, type StoredContext } from "./rental-confirm-price";
import { RentalConfirmBody, type PayoutState } from "./rental-confirm-submit";

const AUTH_MESSAGE = "登录状态已变化。原下单申请已保留；正在确认身份，确认后可在本页恢复。";
const BLOCKED_MESSAGE = "浏览器会话存储不可用，无法保存原请求恢复信息；已阻止创建，避免产生不可恢复的订单。";
const STALE_MESSAGE = "该原创建请求已超出自动查询窗口；请先查询订单列表中的最新状态核对，不要重新确认或重复下单。";

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


export function RentalConfirmPanel({
  accountId,
  gameId,
  versionId,
  releaseId,
  reference,
  fullPayoutSelected = false,
  autoPreview = false,
  autoStart = false,
}: {
  accountId: string;
  gameId?: string | null;
  versionId?: string;
  releaseId?: string;
  reference?: ReferenceFees;
  fullPayoutSelected?: boolean;
  autoPreview?: boolean;
  autoStart?: boolean;
}) {
  const session = useUserSession();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [payOpen, setPayOpen] = useState(false);
  const [paymentAccepted, setPaymentAccepted] = useState(false);
  const [paymentCancelled, setPaymentCancelled] = useState(false);
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "idle" });
  const [retryClock, setRetryClock] = useState(() => Date.now());
  const [priceChangeNotice, setPriceChangeNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [termsOpen, setTermsOpen] = useState(false);
  const createKey = useRef<string | null>(null);
  const quoteGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const isFetchingPreviewRef = useRef(false);
  const lastPreviewStartRef = useRef(0);
  const [payout, setPayout] = useState<PayoutState | null>(fullPayoutSelected ? { status: "loading" } : null);
  const [payoutAccepted, setPayoutAccepted] = useState(false);
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [readAgreement, setReadAgreement] = useState<string | null>(null);
  const quoteTarget = JSON.stringify([accountId, gameId, versionId, releaseId]);
  const currentQuoteTarget = useRef(quoteTarget);
  currentQuoteTarget.current = quoteTarget;
  const reset = useCallback(() => {
    createKey.current = null;
    quoteGeneration.current += 1;
    previewGeneration.current += 1;
    previewAbortRef.current?.abort();
    isFetchingPreviewRef.current = false;
    lastPreviewStartRef.current = 0;
    setTermsOpen(false);
    setAgreementAccepted(false);
    setPriceChangeNotice(null);
    setPreviewState({ status: "idle" });
    setStage({ kind: "idle" });
  }, []);
  const previousQuoteTarget = useRef(quoteTarget);
  if (previousQuoteTarget.current !== quoteTarget) {
    previousQuoteTarget.current = quoteTarget;
    reset();
  }
  const quotedToken = stage.kind === "quoted" ? stage.quote.confirmationToken : null;
  useEffect(() => { setAgreementAccepted(false); }, [quotedToken]);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  const isCurrentRef = useRef(isCurrent);
  isCurrentRef.current = isCurrent;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const previewStateRef = useRef(previewState);
  previewStateRef.current = previewState;
  const stageKindRef = useRef(stage.kind);
  stageKindRef.current = stage.kind;

  const fetchPreview = useCallback(async (isFocusRefresh = false) => {
    if (stageKindRef.current !== "idle") return;
    if ((!autoPreview && !fullPayoutSelected) || !userId || !versionId || !releaseId) {
      setPreviewState((prev) => (prev.status === "idle" ? prev : { status: "idle" }));
      return;
    }
    const intent = loadIntent(userId, "order.create.v2", accountId);
    if (intent) {
      setPreviewState((prev) => (prev.status === "idle" ? prev : { status: "idle" }));
      return;
    }
    if (isFetchingPreviewRef.current) return;
    const currentPreview = previewStateRef.current;
    if (!isFocusRefresh && currentPreview.status === "error" && Date.now() < (currentPreview.retryAfter ?? 0)) return;

    const controller = new AbortController();
    previewAbortRef.current?.abort();
    previewAbortRef.current = controller;

    const generation = ++previewGeneration.current;
    isFetchingPreviewRef.current = true;
    lastPreviewStartRef.current = Date.now();
    setPreviewState({ status: "loading" });

    const currentUserId = userId;
    const currentAccountId = accountId;
    const currentVersionId = versionId;
    const currentReleaseId = releaseId;

    try {
      const preview = await orderApi.previewRentalPrice(
        { accountId, versionId, releaseId },
        controller.signal
      );
      if (controller.signal.aborted) return;
      if (
        generation !== previewGeneration.current || stageKindRef.current !== "idle" ||
        !isCurrentRef.current(currentUserId) ||
        accountId !== currentAccountId ||
        versionId !== currentVersionId ||
        releaseId !== currentReleaseId
      ) {
        return;
      }

      // Returned binding tuple validation
      const b = preview?.binding;
      if (
        !b ||
        b.accountId !== accountId ||
        b.versionId !== versionId ||
        b.releaseId !== releaseId
      ) {
        setPreviewState({
          status: "error",
          code: "BINDING_MISMATCH",
          message: "账号信息已更新，请刷新后重新查看报价。",
          canRetry: false,
          action: "refresh",
        });
        return;
      }

      if (preview.schema !== "rental-price-preview.v1" || !b.listingHash ||
        [preview.quote?.resourceTotal, preview.quote?.tenantDeposit, preview.quote?.tenantPayableTotal, preview.baseTenantDeposit].some(value => moneyText(value) === "—")) {
        setPreviewState({ status: "error", code: "INVALID_PRICE_PREVIEW", message: "报价信息暂未完整返回，请稍后重新读取。", canRetry: true, retryAfter: lastPreviewStartRef.current + 5000 });
        setRetryClock(Date.now());
        return;
      }

      setPreviewState({ status: "ready", preview });
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      if (generation !== previewGeneration.current || stageKindRef.current !== "idle" || !isCurrentRef.current(currentUserId)) return;

      const typed = errorOf(error);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") {
        void sessionRef.current.confirm();
      }

      let canRetry = typed.status === 0 || typed.status >= 500;
      let action: "refresh" | "back" | "orders" | undefined;
      let friendlyMessage = "报价服务暂时不可用，请稍后重试。";
      if (typed.code === "MEMBERSHIP_UNKNOWN") {
        friendlyMessage = "个人权益暂时无法核对，请稍后重试。";
      } else if (typed.code === "CONFIRMATION_CHANGED" || typed.status === 404 || typed.status === 400) {
        friendlyMessage = "账号发布版本已变化，请刷新页面核对最新信息。";
        canRetry = false;
        action = "refresh";
      } else if (typed.code === "OCCUPIED") {
        friendlyMessage = "账号当前已被占用。如果你刚创建了待支付订单，请到租入订单继续支付；否则可以看看其他账号。";
        canRetry = false;
        action = "orders";
      } else if (typed.status === 403) {
        friendlyMessage = "当前身份暂不具备租用资格。";
        action = "back";
      } else if (typed.code === "CONFIRMATION_DEPENDENCY_UNAVAILABLE") {
        friendlyMessage = "账号的租用条件暂时无法核对，请稍后重试报价。";
      } else if (typed.status === 401) {
        friendlyMessage = "登录状态已变化，请重新确认登录后查看报价。";
      }

      setPreviewState({
        status: "error",
        code: typed.code,
        statusHttp: typed.status,
        message: friendlyMessage,
        requestId: typed.requestId,
        canRetry,
        action,
        retryAfter: canRetry ? lastPreviewStartRef.current + 5000 : undefined,
      });
      setRetryClock(Date.now());
    } finally {
      if (generation === previewGeneration.current) {
        isFetchingPreviewRef.current = false;
      }
    }
  }, [autoPreview, fullPayoutSelected, userId, accountId, versionId, releaseId]);

  useEffect(() => {
    if (stage.kind === "idle") void fetchPreview();
    return () => {
      previewGeneration.current += 1;
      previewAbortRef.current?.abort();
      isFetchingPreviewRef.current = false;
    };
  }, [fetchPreview, stage.kind]);

  useEffect(() => {
    if (previewState.status !== "error" || !previewState.canRetry || !previewState.retryAfter) return;
    const timer = setTimeout(() => setRetryClock(Date.now()), Math.max(0, previewState.retryAfter - Date.now()));
    return () => clearTimeout(timer);
  }, [previewState]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => {
      if (stageKindRef.current !== "idle") return;
      const cur = previewStateRef.current;
      if (cur.status === "ready" && cur.preview?.refreshAfterUtc) {
        const refreshAt = Date.parse(cur.preview.refreshAfterUtc);
        if (Number.isFinite(refreshAt) && Date.now() >= refreshAt) {
          void fetchPreview(true);
        }
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchPreview]);

  const previewTerms = previewState.status === "ready" ? previewState.preview.compensationDisclosure?.terms : undefined;
  const previewTermsKey = previewTerms ? `${previewTerms.termsVersionId}:${previewTerms.termsDigest}:${previewTerms.disclosureVersion}` : null;
  useEffect(() => { setPayoutAccepted(false); }, [quoteTarget, previewTermsKey]);
  useEffect(() => {
    if (!fullPayoutSelected || !userId) { setPayout(null); return; }
    if (previewTerms) setPayout({ status: "ready", terms: previewTerms });
    else if (previewState.status === "error" || previewState.status === "ready") setPayout({ status: "unavailable", message: "本账号适用的全额包赔条款暂不可读，请重试报价。" });
    else setPayout({ status: "loading" });
  }, [fullPayoutSelected, userId, previewState.status, previewTerms]);

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
    if (intent) setStage({ kind: "create-unknown", context: (intent.context ?? {}) as StoredContext, message: isIntentStale(intent) ? STALE_MESSAGE : "检测到一笔结果未知的创建请求；原申请内容已保留，请勿重复下单。", stale: isIntentStale(intent) });
  }, [userId, accountId]);

  useEffect(() => {
    if (stage.kind !== "quoted" && stage.kind !== "creating") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage.kind]);

  const requote = useCallback(async () => {
    if (autoPreview && stageKindRef.current === "idle" && previewStateRef.current.status !== "ready") return;
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
    const baseline = stage.kind === "quoted" ? stage.quote : previewStateRef.current.status === "ready" ? previewStateRef.current.preview : null;
    previewGeneration.current += 1;
    previewAbortRef.current?.abort();
    isFetchingPreviewRef.current = false;
    setStage({ kind: "quoting" });
    try {
      const quote = await orderApi.confirmRental({ accountId, versionId, releaseId, ...(payoutAcceptance ? { fullPayoutTermsAcceptance: payoutAcceptance } : {}) });
      if (!isQuoteCurrent()) return;
      if (autoPreview && [quote.quote?.resourceTotal, quote.quote?.tenantDeposit, quote.quote?.tenantPayableTotal, quote.baseTenantDeposit].some(value => moneyText(value) === "—")) {
        setStage({ kind: "notice", message: "最新报价金额不完整，暂不能下单，请重新核对。", canRequote: true });
        return;
      }
      const changeNotice = findQuoteChanges(baseline, quote);
      setPriceChangeNotice(changeNotice);
      const authoritativeTerms = quote.compensationDisclosure?.terms;
      if (fullPayoutSelected && (!quote.compensationDisclosure?.selected || !payoutAcceptance || !authoritativeTerms
        || authoritativeTerms.termsVersionId !== payoutAcceptance.termsVersionId || authoritativeTerms.termsDigest !== payoutAcceptance.termsDigest
        || authoritativeTerms.disclosureVersion !== payoutAcceptance.disclosureVersion)) {
        setStage({ kind: "notice", message: "包赔条款版本与已同意的版本不一致，请刷新页面后重新确认。", canRequote: false, action: "refresh" });
        return;
      }
      const agreement = quote.agreement && quote.agreement.id === quote.agreementAcceptance?.versionId
        && quote.agreement.digest === quote.agreementAcceptance.digest ? quote.agreement : null;
      const agreementProblem = agreement ? null : "本账号冻结的出租协议暂不可核验，请重新报价。";
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
  }, [accountId, gameId, releaseId, userId, isCurrent, versionId, session, payoutGateOpen, payoutAcceptance, autoPreview, stage, fullPayoutSelected]);

  /**
   * The account detail page opts into a single checkout entry: once the payout gate is open and
   * the read-only preview is ready, fetch the final quote without a second "rent" click. The
   * tests and other callers stay on the explicit idle action because autoStart defaults to false.
   */
  const autoQuoteStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || !autoPreview || !userId || !payoutGateOpen || autoQuoteStarted.current || stage.kind !== "idle") return;
    if (previewState.status !== "ready") return;
    autoQuoteStarted.current = true;
    void requote();
  }, [autoStart, autoPreview, userId, payoutGateOpen, stage.kind, previewState.status, requote]);

  const sendCreate = useCallback(async (quote: PersonalRentalQuote) => {
    if (!userId) return;
    const acting = userId;
    const target = currentQuoteTarget.current;
    if (fullPayoutSelected && !payoutAcceptance) {
      setStage({ kind: "notice", message: "请先阅读并同意本账号的全额包赔条款，再创建订单。", canRequote: false });
      return;
    }
    const agreement = stage.kind === "quoted" ? stage.agreement : null;
    if (!agreement || !agreementAccepted || (agreement.bodyDocument && readAgreement !== agreement.digest)) {
      setStage({ kind: "notice", message: "请先阅读并同意本单适用协议，再创建订单。", canRequote: false });
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
    const saved = saveIntent({ userId: acting, kind: "order.create.v2", resourceId: accountId, key, body: { ...(payoutAcceptance ? { fullPayoutTermsAcceptance: payoutAcceptance } : {}), agreementAcceptance: { versionId: agreement.id, digest: agreement.digest } }, token: quote.confirmationToken, context: context as Record<string, unknown> });
    if (!saved.persisted) {
      createKey.current = null;
      setStage({ kind: "notice", message: BLOCKED_MESSAGE, canRequote: true });
      return;
    }
    setStage({ kind: "creating", quote });
    try {
      const order = await orderApi.createOrder(quote.confirmationToken, key, payoutAcceptance, { versionId: agreement.id, digest: agreement.digest });
      if (!isCurrent(acting) || target !== currentQuoteTarget.current) return;
      clearIntent(acting, "order.create.v2", accountId);
      createKey.current = null;
      setPaymentAccepted(false);
      setPaymentCancelled(false);
      setStage({ kind: "created", quote, order });
      setPayOpen(true);
      // The created order opens the payment dialog; the order page remains authoritative.
    } catch (error) {
      if (!isCurrent(acting)) return;
      const typed = errorOf(error);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") {
        void session.confirm();
        setStage({ kind: "notice", message: AUTH_MESSAGE, canRequote: false });
        return;
      }
      if (typed.status === 0 || typed.status >= 500) {
        setStage({ kind: "create-unknown", context, message: "创建请求的结果未知。原申请内容已保留，请勿重复下单，请查询原结果；不要重新确认或重复下单。", stale: false });
        return;
      }
      // A fresh key with a server 4xx is a definitive non-commit.
      clearIntent(acting, "order.create.v2", accountId);
      createKey.current = null;
      setStage({ kind: "notice", ...noticeFor(typed) });
    }
  }, [accountId, userId, isCurrent, session, fullPayoutSelected, payoutAcceptance, stage, agreementAccepted, readAgreement]);

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
      const frozenAcceptance = (intent.body as { fullPayoutTermsAcceptance?: FullPayoutTermsAcceptance; agreementAcceptance?: { versionId: string; digest: string } } | undefined)?.fullPayoutTermsAcceptance;
      const frozenAgreement = (intent.body as { agreementAcceptance?: { versionId: string; digest: string } } | undefined)?.agreementAcceptance;
      const order = await orderApi.createOrder(intent.token, intent.key, frozenAcceptance, frozenAgreement);
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
        const page = await orderApi.list(acting, { party: "renter", accountId, limit: 5 });
        if (!isCurrent(acting)) return;
        observed = page.items.length
          ? `当前账号最近订单：${page.items.slice(0, 3).map((item) => item.displayNo ?? item.id).join("、")}`
          : "当前账号暂无可读订单";
      } catch {
        observed = "订单列表暂时无法读取";
      }
      if (isCurrent(acting)) {
        setStage({ kind: "create-unknown", context: (intent.context ?? {}) as StoredContext, message: `原创建请求仍未取得确定回执（服务端返回「${typed.message || "拒绝"}」，原申请内容保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。`, stale: false });
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
      const authority = await orderApi.paymentStatus(acting, orderId);
      if (!isCurrent(acting)) return;
      const observed = paymentObservation(authority.payment);
      setStage({ kind: "pay-unknown", orderId, message: `原支付请求仍未取得确定回执（原申请保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。` });
    } catch {
      if (isCurrent(acting)) setStage({ kind: "pay-unknown", orderId, message: "原支付请求仍未取得确定回执；最新付款记录暂时无法读取。原请求保留，请稍后再次查询。" });
    }
  }, [isCurrent]);

  const recoverPayment = useCallback(async (orderId: string) => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "order.payment", orderId)) { void resolvePayment(acting, orderId); return; }
    const outcome = await performGuardedWrite(acting, "order.payment", orderId, {}, undefined, (key, _body, _context, subject) => orderApi.pay(subject, orderId, key), isCurrent);
    if (!isCurrent(acting)) return;
    applyPayment(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, orderId);
  }, [userId, isCurrent, applyPayment, resolvePayment]);

  // Presentation uses the existing controller and identity reset; it owns no request state.
  return (
    <RentalConfirmBody
      accountId={accountId}
      gameId={gameId}
      versionId={versionId}
      releaseId={releaseId}
      reference={reference}
      fullPayoutSelected={fullPayoutSelected}
      autoPreview={autoPreview}
      stage={stage}
      setStage={setStage}
      session={session}
      userId={userId}
      previewState={previewState}
      retryClock={retryClock}
      now={now}
      payout={payout}
      payoutAccepted={payoutAccepted}
      setPayoutAccepted={setPayoutAccepted}
      payoutGateOpen={payoutGateOpen}
      payoutAcceptance={payoutAcceptance}
      priceChangeNotice={priceChangeNotice}
      termsOpen={termsOpen}
      setTermsOpen={setTermsOpen}
      agreementAccepted={agreementAccepted}
      setAgreementAccepted={setAgreementAccepted}
      readAgreement={readAgreement}
      setReadAgreement={setReadAgreement}
      paymentAccepted={paymentAccepted}
      setPaymentAccepted={setPaymentAccepted}
      paymentCancelled={paymentCancelled}
      setPaymentCancelled={setPaymentCancelled}
      payOpen={payOpen}
      setPayOpen={setPayOpen}
      requote={requote}
      fetchPreview={fetchPreview}
      recoverCreate={recoverCreate}
      recoverPayment={recoverPayment}
      sendCreate={sendCreate}
    />
  );
}
