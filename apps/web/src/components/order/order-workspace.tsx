"use client";

import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { useUserSession } from "@/components/session/user-session-provider";
import { mergeOrderItems, orderApi, type Order, type OrderPage, type OrderParty, type OrderRequestError, type OrderStatusFilter, type OrderSearchFilters } from "@/lib/order-client";
import { LegacyOrderWorkspace } from "@/components/order/legacy-order-workspace";
import { OrderDetail } from "@/components/order/order-detail";
import { OrderListPanel, type OrderListState } from "@/components/order/order-list";
import { errorFrom, isAbortError, isAuthenticationFailure, isOrderStatus, isPrivateBoundary, orderUrl } from "@/components/order/order-presentation";
import "./order.css";

type DetailState = { scope: string; orderId: string | null; status: "loading" | "ready" | "error"; order: Order | null; error: OrderRequestError | null };
type ListState = OrderListState & { scope: string };

function emptyListState(scope: string): ListState {
  return { scope, page: null, loading: true, refreshing: false, loadingMore: false, error: null, moreError: null, notice: "" };
}

/**
 * Owns every read of the two order surfaces: one list scope and one detail scope, each bound to the
 * current identity, party, filter and account context. Rendering is delegated to the list and
 * detail views so that neither can grow its own read state.
 */
export function OrderWorkspace({ party, orderId, status: statusParam, accountId, source, pay, filters = {} }: { party: OrderParty; orderId?: string; status?: string; accountId?: string; source?: string; pay?: string; filters?: OrderSearchFilters }) {
  const auth = useAuthOverlay();
  const router = useRouter();
  const session = useUserSession();
  const { orderNo, createdFrom, createdTo, stage } = filters;
  const status: OrderStatusFilter = statusParam === "IN_PROGRESS" || statusParam == null || statusParam === ""
    ? "IN_PROGRESS"
    : statusParam === "ALL" ? "ALL"
    : isOrderStatus(statusParam) ? statusParam : "IN_PROGRESS";
  const identityScope = session.status === "authenticated" && session.userId ? `${session.userId}:${session.identityVersion}` : "unauthenticated";
  const listScope = JSON.stringify([identityScope,party,status,accountId ?? "",orderNo ?? "",createdFrom ?? "",createdTo ?? "",stage ?? ""]);
  const detailScope = `${identityScope}:${party}:${source ?? ""}:${orderId ?? ""}`;
  const [listState, setListState] = useState<ListState>(() => emptyListState(listScope));
  const [detailState, setDetailState] = useState<DetailState>(() => ({ scope: detailScope, orderId: orderId ?? null, status: orderId ? "loading" : "ready", order: null, error: null }));
  const [detailReload, setDetailReload] = useState(0);
  const listController = useRef<AbortController | null>(null);
  const moreController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const listSequence = useRef(0);
  const moreSequence = useRef(0);
  const detailSequence = useRef(0);
  const positionRef = useRef<{ orderId: string; scrollY: number } | null>(null);
  const previousOrderId = useRef(orderId);

  const invalidateListReads = useCallback(() => {
    listSequence.current += 1;
    moreSequence.current += 1;
    listController.current?.abort();
    moreController.current?.abort();
    listController.current = null;
    moreController.current = null;
  }, []);

  const loadFirst = useCallback(async (preserve: boolean, notice = "") => {
    listController.current?.abort();
    moreController.current?.abort();
    const sequence = ++listSequence.current;
    moreSequence.current += 1;
    const controller = new AbortController();
    listController.current = controller;
    setListState((previous) => preserve && previous.scope === listScope && previous.page
      ? { ...previous, refreshing: true, loadingMore: false, error: null, moreError: null, notice }
      : { ...emptyListState(listScope), notice });
    if (session.status !== "authenticated" || !session.userId) {
      if (sequence === listSequence.current) setListState({ ...emptyListState(listScope), loading: false, notice });
      if (listController.current === controller) listController.current = null;
      return;
    }
    try {
      const page = await orderApi.listUnified(session.userId, { party, ...(status && status !== "ALL" ? { status: status === "IN_PROGRESS" ? "IN_PROGRESS" : status } : {}), ...(accountId ? { accountId } : {}), orderNo, createdFrom, createdTo, stage }, controller.signal);
      if (controller.signal.aborted || sequence !== listSequence.current) return;
      setListState({ scope: listScope, page, loading: false, refreshing: false, loadingMore: false, error: null, moreError: null, notice });
    } catch (error) {
      if (controller.signal.aborted || sequence !== listSequence.current || isAbortError(error)) return;
      const typed = errorFrom(error);
      if (isPrivateBoundary(typed)) {
        invalidateListReads();
        if (isAuthenticationFailure(typed)) session.revalidate();
      }
      setListState((previous) => {
        const discard = isPrivateBoundary(typed);
        return discard || !preserve || !previous.page
          ? { scope: listScope, page: null, loading: false, refreshing: false, loadingMore: false, error: typed, moreError: null, notice }
          : { ...previous, loading: false, refreshing: false, loadingMore: false, error: typed, moreError: null, notice };
      });
    } finally {
      if (listController.current === controller) listController.current = null;
    }
  }, [accountId, invalidateListReads, listScope, party, session.revalidate, session.status, session.userId, status, orderNo, createdFrom, createdTo, stage]);

  useEffect(() => {
    void loadFirst(false);
    return () => {
      listSequence.current += 1;
      moreSequence.current += 1;
      listController.current?.abort();
      moreController.current?.abort();
    };
  }, [loadFirst]);

  useEffect(() => {
    detailController.current?.abort();
    const sequence = ++detailSequence.current;
    if (!orderId || source === "legacy" || session.status !== "authenticated" || !session.userId) {
      setDetailState({ scope: detailScope, orderId: null, status: "ready", order: null, error: null });
      return () => undefined;
    }
    const controller = new AbortController();
    detailController.current = controller;
    setDetailState({ scope: detailScope, orderId, status: "loading", order: null, error: null });
    void orderApi.detail(session.userId, orderId, controller.signal).then((order) => {
      if (!controller.signal.aborted && sequence === detailSequence.current) setDetailState({ scope: detailScope, orderId, status: "ready", order, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || sequence !== detailSequence.current || isAbortError(error)) return;
      const typed = errorFrom(error);
      if (isAuthenticationFailure(typed)) {
        invalidateListReads();
        setListState({ ...emptyListState(listScope), notice: "登录状态已变化，正在重新确认身份。" });
        session.revalidate();
      }
      setDetailState({ scope: detailScope, orderId, status: "error", order: null, error: typed });
    });
    return () => {
      controller.abort();
      if (detailController.current === controller) detailController.current = null;
    };
  }, [detailReload, detailScope, invalidateListReads, listScope, orderId, session.revalidate, session.status, session.userId, source]);

  useEffect(() => {
    const previous = previousOrderId.current;
    if (orderId && !previous) requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
    if (!orderId && previous) {
      const position = positionRef.current;
      requestAnimationFrame(() => {
        if (position) window.scrollTo({ top: position.scrollY, behavior: "auto" });
        if (!position) return;
        const link = [...document.querySelectorAll<HTMLAnchorElement>("a[data-order-id]")].find((candidate) => candidate.dataset.orderKey === position.orderId);
        link?.focus({ preventScroll: true });
      });
    }
    previousOrderId.current = orderId;
  }, [orderId]);

  const loadMore = useCallback(async () => {
    const page = listState.scope === listScope ? listState.page : null;
    if (!page?.nextCursor || session.status !== "authenticated" || !session.userId || moreController.current) return;
    const sequence = listSequence.current;
    const more = ++moreSequence.current;
    const controller = new AbortController();
    moreController.current = controller;
    setListState((previous) => previous.scope === listScope ? { ...previous, loadingMore: true, moreError: null } : previous);
    try {
      const next = await orderApi.listUnified(session.userId, { party, ...(status && status !== "ALL" ? { status: status === "IN_PROGRESS" ? "IN_PROGRESS" : status } : {}), ...(accountId ? { accountId } : {}), orderNo, createdFrom, createdTo, stage, cursor: page.nextCursor }, controller.signal);
      if (controller.signal.aborted || sequence !== listSequence.current || more !== moreSequence.current) return;
      setListState((previous) => previous.scope !== listScope || !previous.page ? previous : { ...previous, page: { ...next, stageUnknownObserved: Boolean(previous.page.stageUnknownObserved || next.stageUnknownObserved), items: mergeOrderItems(previous.page.items, next.items) }, loadingMore: false, moreError: null });
    } catch (error) {
      if (controller.signal.aborted || sequence !== listSequence.current || more !== moreSequence.current || isAbortError(error)) return;
      const typed = errorFrom(error);
      if (typed.status === 409) {
        await loadFirst(true, "筛选或分页状态已变化，已重新读取。");
      } else if (isPrivateBoundary(typed)) {
        invalidateListReads();
        if (isAuthenticationFailure(typed)) session.revalidate();
        setListState({ scope: listScope, page: null, loading: false, refreshing: false, loadingMore: false, error: typed, moreError: null, notice: "" });
      } else {
        setListState((previous) => previous.scope === listScope ? { ...previous, loadingMore: false, moreError: typed } : previous);
      }
    } finally {
      if (moreController.current === controller) moreController.current = null;
    }
  }, [accountId, invalidateListReads, listScope, listState, loadFirst, party, session.revalidate, session.status, session.userId, status, orderNo, createdFrom, createdTo, stage]);

  /** Remember where the reader clicked from so returning restores the same scroll position and focus. */
  const onOpen = (nextOrderId: string, event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) positionRef.current = { orderId: nextOrderId, scrollY: window.scrollY };
  };
  const visibleListState = listState.scope === listScope ? listState : emptyListState(listScope);
  const retryList = () => void loadFirst(Boolean(visibleListState.page));
  const login = () => auth.open();
  const detail = orderId
    ? detailState.scope === detailScope && detailState.orderId === orderId
      ? detailState
      : { scope: detailScope, orderId, status: "loading" as const, order: null, error: null }
    : null;

  if (session.status !== "authenticated" || !session.userId) return <section className="order-session-guard" role="status"><LockKeyhole size={22} aria-hidden="true" /><h2>正在确认订单身份</h2><p>确认期间不会展示上一位用户的订单数据。</p></section>;
  if (orderId && source === "legacy") return <LegacyOrderWorkspace party={party} orderId={orderId} accountId={accountId} status={status} filters={filters} onOrderChanged={() => void loadFirst(false)} />;
  if (orderId && detail) return <OrderDetail party={party} status={status} accountId={accountId} orderId={orderId} filters={filters} payRequested={pay === "1"} state={detail} onRetry={() => setDetailReload((value) => value + 1)} onLogin={login} onChanged={() => setDetailReload((value) => value + 1)} />;
  return <OrderListPanel party={party} status={status} accountId={accountId} filters={filters} onApplyFilters={next=>router.push(orderUrl(party,status,accountId,undefined,undefined,next),{scroll:false})} state={visibleListState} onRefresh={retryList} onRetryList={retryList} onLoadMore={() => void loadMore()} onLogin={login} onReauthorize={() => session.revalidate()} onOpen={onOpen} />;
}
