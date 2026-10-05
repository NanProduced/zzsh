"use client";

import Link from "next/link";
import { publishUserSessionChange, useUserSession, useUserSessionStore } from "./session/user-session-provider";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Check, ChevronRight, CreditCard, House, LockKeyhole, Pause, Play, RefreshCw, ShieldCheck, Sparkles, Undo2 } from "lucide-react";
import { ServiceShell } from "./layout/service-shell";
import { WebAuthError, webAuthRequest } from "./auth/auth-form";
import { accountStatusLabel, ageStatusLabel, cancellationFailureMessage, identityStatusLabel, type UserIdentitySnapshot } from "@/app/user-account-status";
import { FavoritesPanel } from "./favorites/favorites-panel";
import { FavoritesProvider } from "./favorites/favorites-context";
import { OrderWorkspace } from "./order/order-workspace";
import { AccountCenterFrame, AccountOverview, accountSectionLabels, resolveAccountView } from "./account/account-center";
import { AccountSecurityControls, type SecurityNicknameDraft, type SecurityPendingWrite } from "./account/account-security-controls";
import { supplyApi, SupplyRequestError } from "../lib/supply-client";
import { IdentityPauseGate, isCurrentQuery, mergePageById } from "../lib/supply-workspace-guards";
import type { MySupply } from "../lib/supply-types";

type SessionId = string | null | undefined;
type IdentityState = "checking" | "confirmed" | "failed";
type RequestContext = { epoch: number; identity: SessionId; accountId?: string; gameId: string };
type RetryTask = { context: RequestContext; busy: string; run: () => Promise<void> };

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m3d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function moneyText(money: { amount: string } | null | undefined): string {
  return money ? `${money.amount} 元` : "未配置";
}

function stateLabel(state: string | null | undefined): string {
  return ({ DRAFT: "草稿", SUBMITTED: "审核中", WITHDRAWN: "已撤回", REJECTED: "已退回", APPROVED: "已通过", PUBLISHED: "已上架", IMPORTED_UNVERIFIED: "待复核" } as Record<string, string>)[state ?? ""] ?? "未确认";
}

function blockerText(code: string): string {
  return ({
    OWNER_UNAVAILABLE: "号主账号暂不可用",
    IDENTITY_REQUIRED: "请先完成实名验证",
    ADULT_REQUIRED: "需确认成年资格",
    GAME_UNAVAILABLE: "游戏暂不可发布",
    GAME_SERVICE_UNAVAILABLE: "该游戏暂未开放出租服务",
    RULE_CHANGED: "规则已更新，请重新预览并确认",
    ACCOUNT_NOT_PUBLISHABLE: "历史异常或归档资料需先处理",
    PUBLISHER_BAIL_UNCONFIRMED: "发布保证金资格尚未确认",
    FUNDING_UNKNOWN: "押金与赔付依据尚未确认",
    OCCUPIED: "账号当前被占用",
    OCCUPANCY_UNKNOWN: "暂不能确认账号是否空闲",
    REVIEW_REQUIRED: "等待资料审核",
    OWNER_PAUSED: "号主已暂停接单",
    STAFF_RESTRICTED: "客服限制尚未解除",
    CONFIRMATION_OR_MEDIA_REQUIRED: "需完成规则确认或图片技术校验",
    PUBLICATION_REQUIRED: "公开发布事实尚未形成",
    HISTORICAL_VERSION: "这是历史版本",
  } as Record<string, string>)[code] ?? "当前资料暂不能继续，请读取最新状态或稍后重试。";
}

type AccountRow = { id: string; title: string | null; game_name: string; review_state: string | null; sequence: string | null; owner_paused: boolean; staff_restricted: boolean };
function AccountActionError({ error, onRetry }: { error: SupplyRequestError | null; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="supply-notice is-error" role="alert"><AlertCircle size={17} /><span>{error.message}</span>{error.status === 0 && onRetry ? <button type="button" className="button quiet" onClick={onRetry}>重试</button> : null}</div>;
}

function AccountUnavailable({ label }: { label: string }) {
  const detail =
    label === "我的钱包"
      ? "余额与流水功能正在准备中，目前无法查询余额、充值或提现。"
      : label === "分销中心"
      ? "邀请关系与分销收益功能正在准备中，目前尚未开放。"
      : "这项功能正在准备中。";
  const Icon = label === "我的钱包" ? CreditCard : Sparkles;
  return <section className="account-module"><header className="account-module-heading"><div><h2>{label}</h2><p>功能接入中</p></div><span className="account-state-badge">待接入</span></header><div className="account-module-card account-empty-state"><Icon size={30} aria-hidden="true" /><h3>{label}暂未开放</h3><p>{detail}</p></div></section>;
}

export function AccountWorkspace({ view, accountId, orderId, status }: { view: string; accountId?: string; orderId?: string; status?: string }) {
  const router = useRouter();
  const session = useUserSession();
  const nicknameDraft = useRef<SecurityNicknameDraft["current"]>(null);
  const pendingSecurityWrite = useRef<SecurityPendingWrite["current"]>(null);
  if (session.status === "guest" || session.status === "authenticated" && nicknameDraft.current?.userId !== session.userId) nicknameDraft.current = null;
  if (session.status === "guest" || session.status === "authenticated" && pendingSecurityWrite.current?.userId !== session.userId) pendingSecurityWrite.current = null;
  const active = resolveAccountView(view);
  const accountShell = {
    surface: "account" as const,
    contextLabel: null,
    showBack: false,
    showPageHeading: false,
    breadcrumbs: [{ label: "首页", href: "/" }, { label: "个人中心" }],
    searchLabel: "在公开账号目录中搜索",
    searchPlaceholder: "搜索账号编号或名称",
  };
  const title = "个人中心";
  useEffect(() => {
    if (session.status !== "guest") return;
    const target = window.location.pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(target)}`);
  }, [router, session.status]);
  if (session.status === "loading") return <ServiceShell {...accountShell} title={title}><section className="account-guest" aria-busy="true"><h2>正在准备个人中心…</h2><p>请稍候。</p></section></ServiceShell>;
  if (session.status === "error") return <ServiceShell {...accountShell} title={title}><section className="account-guest" role="alert"><LockKeyhole size={30} /><h2>登录状态暂未确认</h2><p>暂未确认登录结果，请重试后继续。</p><button type="button" className="button secondary" onClick={session.revalidate}>重试</button></section></ServiceShell>;
  if (session.status === "guest") return <ServiceShell {...accountShell} title={title}><section className="account-guest" aria-busy="true"><LockKeyhole size={30} /><h2>正在转到登录</h2></section></ServiceShell>;
  const identityScope = `${session.userId}:${session.identityVersion}`;
  return <ServiceShell {...accountShell} title={title}>
    <AccountCenterFrame active={active} accountId={accountId} orderId={orderId} status={status} scope={identityScope}>
      {active === "overview" ? <AccountOverview scope={identityScope} /> : active === "accounts" ? <MyAccountsPanel accountId={accountId} /> : active === "security" ? <AccountSecurityPanel nicknameDraft={nicknameDraft} pendingWrite={pendingSecurityWrite} /> : active === "identity" ? <AccountIdentityPanel /> : active === "favorites" ? <FavoritesProvider><FavoritesPanel /></FavoritesProvider> : active === "rentals" || active === "leased" ? <OrderWorkspace party={active === "rentals" ? "renter" : "owner"} orderId={orderId} status={status} accountId={accountId} /> : <AccountUnavailable label={accountSectionLabels[active]} />}
    </AccountCenterFrame>
  </ServiceShell>;
}

type AccountProfile = { id: string; name?: string | null; username?: string | null; phoneNumber?: string | null };
type AccountSessionResponse = { user?: AccountProfile } | null;
type AccountReadProof = { scope: string; userId: string };
type AccountReadState = { scope: string; profile: AccountProfile | null; identity: UserIdentitySnapshot | null; proof: AccountReadProof | null; loading: boolean; error: string };

function useAccountIdentityRead(errorMessage: string) {
  const session = useUserSession();
  const sharedSession = useUserSessionStore();
  const scope = `${session.userId ?? ""}:${session.identityVersion}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const approvedRead = useRef<AccountReadProof | null>(null);
  if (approvedRead.current?.scope !== scope) approvedRead.current = null;
  const [state, setState] = useState<AccountReadState>({ scope, profile: null, identity: null, proof: null, loading: true, error: "" });
  const requestRef = useRef<AbortController | null>(null);

  const invalidate = useCallback((error: string) => {
    approvedRead.current = null;
    requestRef.current?.abort();
    requestRef.current = null;
    setState({ scope, profile: null, identity: null, proof: null, loading: false, error });
  }, [scope]);

  const isAuthorized = useCallback((proof: AccountReadProof | null) => {
    const latest = sharedSession.getSnapshot();
    return Boolean(proof && approvedRead.current === proof && scopeRef.current === proof.scope && latest.status === "authenticated" && latest.userId === proof.userId && `${latest.userId}:${latest.identityVersion}` === proof.scope);
  }, [sharedSession]);

  const load = useCallback(async () => {
    const actingUserId = session.userId;
    approvedRead.current = null;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ scope, profile: null, identity: null, proof: null, loading: true, error: "" });
    const isCurrent = () => {
      const latest = sharedSession.getSnapshot();
      return !controller.signal.aborted && requestRef.current === controller && scopeRef.current === scope && latest.status === "authenticated" && `${latest.userId}:${latest.identityVersion}` === scope;
    };
    try {
      if (session.status !== "authenticated" || !actingUserId) { invalidate("登录身份尚未确认，请稍后重试。"); return; }
      const current = await webAuthRequest<AccountSessionResponse>("/get-session", undefined, controller.signal);
      if (!isCurrent()) return;
      if (current?.user?.id !== actingUserId) {
        invalidate("登录身份已变化，请重新确认后再试。");
        session.revalidate();
        return;
      }
      const currentIdentity = await webAuthRequest<UserIdentitySnapshot>("/identity/status", undefined, controller.signal);
      if (!isCurrent()) return;
      if (!currentIdentity) throw new Error("Identity status was not returned");
      const proof = { scope, userId: actingUserId };
      approvedRead.current = proof;
      setState({ scope, profile: current.user, identity: currentIdentity, proof, loading: false, error: "" });
    } catch (failure) {
      if (!isCurrent()) return;
      invalidate(errorMessage);
      if (failure instanceof WebAuthError && failure.status === 401) session.revalidate();
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [scope, session.status, session.userId, session.revalidate, sharedSession, errorMessage, invalidate]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
      approvedRead.current = null;
    };
  }, [load]);

  const visible = state.scope === scope ? state : { scope, profile: null, identity: null, proof: null, loading: true, error: "" };
  const proof = isAuthorized(visible.proof) ? visible.proof : null;
  return { proof, isAuthorized, invalidate, load, profile: proof ? visible.profile : null, identity: proof ? visible.identity : null, loading: visible.loading || Boolean(visible.proof && !proof), error: visible.error };
}

function AccountIdentityPanel() {
  const { profile, identity, loading, error, load } = useAccountIdentityRead("实名认证信息暂时无法读取，请重试。");
  const summary = identity ? { UNVERIFIED: "尚未完成实名认证", VERIFIED: "实名认证已验证", REJECTED: "实名认证未通过", UNKNOWN: "实名状态暂无法确认" }[identity.identityStatus] : "实名状态暂无法确认";
  return <section className="account-module" aria-labelledby="account-identity-heading">
    <header className="account-module-heading"><div><h2 id="account-identity-heading">实名认证</h2><p>查看已有认证结果与年龄状态。</p></div><button type="button" className="button quiet" disabled={loading} onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />刷新</button></header>
    {loading ? <div className="account-module-card account-empty-state" aria-busy="true" role="status"><ShieldCheck size={28} aria-hidden="true" /><h3>正在读取认证状态</h3><p>请稍候。</p></div> : error && !profile ? <div className="account-module-card account-empty-state" role="alert"><AlertCircle size={28} aria-hidden="true" /><h3>认证信息暂时无法读取</h3><p>{error}</p><button type="button" className="button secondary" onClick={() => void load()}>重试</button></div> : <section className="account-module-card account-verification-card">
      {error ? <p className="account-module-note is-error" role="alert">{error}</p> : null}
      <div className="account-verification-summary" data-state={identity?.identityStatus === "VERIFIED" && identity.provider !== "fake" ? "verified" : "pending"}>
        <span className="account-state-icon" aria-hidden="true"><ShieldCheck size={30} strokeWidth={1.5} /></span>
        <div><h3>{summary}</h3><p>{identity?.provider === "none" ? "线上实名服务暂未开放，当前无法提交新的认证。" : "认证结果与年龄信息会影响部分交易操作。"}</p></div>
      </div>
      <dl className="account-fact-list">
        <div><dt>实名认证</dt><dd>{identity ? identityStatusLabel(identity.identityStatus) : "暂无法确认"}</dd></div>
        <div><dt>年龄状态</dt><dd>{identity ? ageStatusLabel(identity.ageStatus) : "暂无法确认"}</dd></div>
      </dl>
      <p className="account-module-note">本页展示已有状态，暂不提供证件提交或认证资料修改。</p>
      {identity?.provider === "fake" ? <p className="account-module-note">当前为本地测试结果，不代表真实身份核验。</p> : null}
    </section>}
  </section>;
}

function AccountSecurityPanel({ nicknameDraft, pendingWrite }: { nicknameDraft?: SecurityNicknameDraft; pendingWrite?: SecurityPendingWrite } = {}) {
  const session = useUserSession();
  const { profile, identity, loading, error: readError, load, proof, isAuthorized, invalidate } = useAccountIdentityRead("账号安全信息暂时无法读取，请重试。");
  const [actionState, setActionState] = useState<{ proof: AccountReadProof; busy: boolean; error: string; notice: string } | null>(null);
  const actionRef = useRef<AccountReadProof | null>(null);
  if (actionRef.current && !isAuthorized(actionRef.current)) actionRef.current = null;
  const action = actionState?.proof === proof ? actionState : null;
  const busy = action?.busy ? "cancel" : "";
  const error = readError || action?.error || "";
  const notice = action?.notice || "";

  const cancelAccount = async () => {
    if (!proof || !isAuthorized(proof) || actionRef.current === proof) return;
    if (!window.confirm("注销会撤销当前会话，并匿名化普通资料。请先处理未完成订单等事项，再继续。确认注销吗？")) return;
    if (!isAuthorized(proof)) return;
    actionRef.current = proof;
    setActionState({ proof, busy: true, error: "", notice: "" });
    try {
      await webAuthRequest<{ status: UserIdentitySnapshot["accountStatus"] }>("/account/cancel", { reason: "用户在账户安全页提交注销" });
      if (!isAuthorized(proof)) return;
      setActionState({ proof, busy: false, error: "", notice: "账号已注销，必要历史关联保留；当前会话已撤销。" });
      session.revalidate();
      publishUserSessionChange();
    } catch (failure) {
      if (!isAuthorized(proof)) return;
      if (failure instanceof WebAuthError && failure.status === 401) {
        invalidate("登录身份已变化，请重新确认后再试。");
        session.revalidate();
        return;
      }
      setActionState({ proof, busy: false, notice: "", error: failure instanceof WebAuthError ? cancellationFailureMessage(failure.status, failure.code) : "注销未完成，请稍后重试。" });
    } finally {
      if (actionRef.current === proof) actionRef.current = null;
    }
  };

  return <section className="account-module" aria-labelledby="account-security-heading">
    <header className="account-module-heading"><div><h2 id="account-security-heading">账号安全</h2><p>查看登录资料与账号状态，管理账号注销。</p></div><button type="button" className="button quiet" disabled={loading || Boolean(busy)} onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />刷新</button></header>
    {loading ? <div className="account-module-card account-empty-state" aria-busy="true" role="status"><LockKeyhole size={28} aria-hidden="true" /><h3>正在读取账号资料</h3><p>请稍候。</p></div> : error && !profile ? <div className="account-module-card account-empty-state" role="alert"><AlertCircle size={28} aria-hidden="true" /><h3>账号资料暂时无法读取</h3><p>{error}</p><button type="button" className="button secondary" onClick={() => void load()}>重试</button></div> : <>
      {error ? <p className="account-module-note is-error" role="alert">{error}</p> : null}
      {notice ? <p className="account-module-note" role="status">{notice}</p> : null}
      <section className="account-module-card">
        <dl className="account-fact-list">
          <div><dt>账号状态</dt><dd>{identity ? accountStatusLabel(identity.accountStatus) : "暂无法确认"}</dd></div>
        </dl>
      </section>
      {proof ? <AccountSecurityControls key={proof.scope} userId={proof.userId} canAct={() => isAuthorized(proof)} nicknameDraft={nicknameDraft} pendingWrite={pendingWrite} /> : null}
      <section className="account-module-card account-danger-zone"><div><h3>注销账号</h3><p>注销会退出当前登录并匿名化普通资料。请先处理未完成订单等事项。</p></div><button type="button" className="button secondary" disabled={Boolean(busy) || !proof || !profile} onClick={() => void cancelAccount()}>{busy === "cancel" ? "处理中…" : "注销账号"}</button></section>
    </>}
  </section>;
}

function MyAccountsPanel({ accountId: accountIdProp }: { accountId?: string }) {
  const router = useRouter();
  const sharedSession = useUserSessionStore();
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [detail, setDetail] = useState<MySupply | null>(null);
  const [latest, setLatest] = useState<MySupply | null>(null);
  const [identityState, setIdentityState] = useState<IdentityState>("checking");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<SupplyRequestError | null>(null);
  const [notice, setNotice] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const identity = useRef<SessionId>(undefined);
  const identityStatusRef = useRef<IdentityState>("checking");
  const identityPauseGate = useRef(new IdentityPauseGate());
  const controllers = useRef(new Set<AbortController>());
  const pendingKeys = useRef(new Map<string, { fingerprint: string; key: string }>());
  const lastRetry = useRef<RetryTask | null>(null);
  const lastActionRetry = useRef<RetryTask | null>(null);
  const accountRef = useRef(accountIdProp);
  const routeAccountRef = useRef(accountIdProp);
  const listRequestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);

  const beginRequest = () => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  };
  const finishRequest = (controller: AbortController) => controllers.current.delete(controller);
  const currentContext = useCallback((context: RequestContext, signal?: AbortSignal) =>
    mounted.current && context.gameId === "accounts" && context.epoch === epoch.current && identity.current === context.identity &&
    (context.accountId === undefined || accountRef.current === context.accountId) && !signal?.aborted, []);
  const waitForIdentity = useCallback((context: RequestContext) =>
    identityPauseGate.current.wait(() => currentContext(context)), [currentContext]);
  const captureContext = (accountId = accountRef.current): RequestContext => ({ epoch: epoch.current, identity: identity.current, accountId, gameId: "accounts" });
  const setIdentityPhase = (next: IdentityState) => {
    identityStatusRef.current = next;
    setIdentityState(next);
  };

  const actionKey = (operation: string, body: unknown) => {
    const fingerprint = JSON.stringify(body);
    const previous = pendingKeys.current.get(operation);
    if (previous?.fingerprint === fingerprint) return previous.key;
    const key = newKey();
    pendingKeys.current.set(operation, { fingerprint, key });
    return key;
  };
  const finishKey = (operation: string, body: unknown) => {
    if (pendingKeys.current.get(operation)?.fingerprint === JSON.stringify(body)) pendingKeys.current.delete(operation);
  };
  const invalidateContext = useCallback((message: string, requireAuth: boolean) => {
    epoch.current += 1;
    identityPauseGate.current.cancelWaiters();
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    pendingKeys.current.clear();
    lastRetry.current = null;
    lastActionRetry.current = null;
    accountRef.current = undefined;
    setRows([]);
    setDetail(null);
    setLatest(null);
    setNextCursor(null);
    nextCursorRef.current = null;
    setLoading(false);
    setLoadingMore(false);
    setBusy("");
    setError(null);
    setNotice(message);
    setAuthRequired(requireAuth);
  }, []);
  const syncIdentity = useCallback(async (): Promise<boolean> => {
    const snapshot = sharedSession.getSnapshot();
    if (snapshot.status === "loading" || snapshot.status === "error") {
      if (snapshot.status === "error") identityPauseGate.current.markFailed();
      else identityPauseGate.current.startCheck();
      setIdentityPhase(snapshot.status === "loading" ? "checking" : "failed");
      return false;
    }
    const next = snapshot.userId;
    const previous = identity.current;
    identity.current = next;
    if (previous !== undefined && previous !== next) {
      invalidateContext("登录身份已变化，旧账号资料已清除。", !next);
      if (accountIdProp) router.replace("/account?view=accounts");
    }
    identityPauseGate.current.markConfirmed();
    setAuthRequired(!next);
    setIdentityPhase("confirmed");
    return !(previous !== undefined && previous !== next && accountIdProp);
  }, [sharedSession, invalidateContext, router, accountIdProp]);
  const load = useCallback(async (requestedId?: string, append = false, cursor?: string) => {
    if (identityStatusRef.current !== "confirmed") return;
    if (!identity.current) {
      setAuthRequired(true);
      setLoading(false);
      return;
    }
    const id = requestedId ?? accountRef.current;
    if (!append && id !== accountRef.current) {
      accountRef.current = id;
      setDetail(null);
      setLatest(null);
    }
    const requestEpoch = epoch.current;
    const requestId = ++listRequestRef.current;
    const requestCursor = append ? cursor ?? nextCursorRef.current ?? undefined : undefined;
    const request = { id: requestId, key: JSON.stringify({ accountId: id ?? "", append, cursor: requestCursor ?? "" }) };
    const isCurrent = () => isCurrentQuery(request, listRequestRef.current, request.key);
    const context = captureContext(id);
    const controller = beginRequest();
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      if (!(await waitForIdentity(context))) return;
      const params = new URLSearchParams({ limit: "50" });
      if (requestCursor) params.set("cursor", requestCursor);
      const page = await supplyApi.myAccounts(params, controller.signal);
      if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
      lastRetry.current = null;
      if (!append) lastActionRetry.current = null;
      setRows((previous) => {
        if (!append) return page.items;
        return mergePageById(previous, page.items);
      });
      setNextCursor(page.nextCursor);
      nextCursorRef.current = page.nextCursor;
      setAuthRequired(false);
      if (id && !append) {
        if (!(await waitForIdentity(context))) return;
        const next = await supplyApi.mine(id, controller.signal);
        if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
        setDetail(next);
      }
    } catch (failure) {
      if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
      const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
      setError(nextError);
      if (nextError.status === 401) setAuthRequired(true);
      if (nextError.status === 0) lastRetry.current = { context, busy: append ? "accounts-more" : "accounts", run: () => load(id, append, requestCursor) };
    } finally {
      if (currentContext({ ...context, epoch: requestEpoch }, controller.signal) && isCurrent()) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
      finishRequest(controller);
    }
  }, [currentContext, waitForIdentity]);
  useEffect(() => {
    mounted.current = true;
    if (routeAccountRef.current !== accountIdProp) {
      routeAccountRef.current = accountIdProp;
      invalidateContext("", false);
      accountRef.current = accountIdProp;
    }
    const onFocus = () => { void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); }); };
    const unsubscribeIdentity = sharedSession.subscribe(onFocus);
    void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); });
    return () => {
      mounted.current = false;
      epoch.current += 1;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      pendingKeys.current.clear();
      lastRetry.current = null;
      lastActionRetry.current = null;
      identityPauseGate.current.cancel();
      unsubscribeIdentity();
    };
  }, [accountIdProp, invalidateContext, load, syncIdentity, sharedSession]);

  const reloadDetail = async (replace = false) => {
    const id = accountRef.current;
    if (!id || identityStatusRef.current !== "confirmed" || !identity.current) return;
    const context = captureContext(id);
    if (!(await waitForIdentity(context))) return;
    const controller = beginRequest();
    try {
      const next = await supplyApi.mine(id, controller.signal);
      if (!currentContext(context, controller.signal)) return;
       if (replace) { setDetail(next); setLatest(null); setNotice("已采用最新状态。"); }
      else setLatest(next);
      setError(null);
      lastRetry.current = null;
      lastActionRetry.current = null;
    } catch (failure) {
      if (currentContext(context, controller.signal)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        if (nextError.status === 0) lastRetry.current = { context, busy: "detail", run: () => reloadDetail(replace) };
      }
    } finally {
      finishRequest(controller);
    }
  };
  const executeAction = async (action: "withdraw" | "pause" | "resume", context: RequestContext, body: { accountId: string; expectedRevision: string; versionId: string; action: string }, key: string): Promise<void> => {
    if (!(await waitForIdentity(context))) return;
    const controller = beginRequest();
    try {
      const next = action === "withdraw"
        ? await supplyApi.withdraw(context.accountId!, body.expectedRevision, body.versionId, key, undefined, controller.signal)
        : await supplyApi.setPaused(context.accountId!, action === "pause", body.expectedRevision, key, undefined, controller.signal);
      if (!currentContext(context, controller.signal)) return;
      finishKey(action, body);
      setDetail(next);
      setLatest(null);
      setRows((previous) => previous.map((row) => row.id === context.accountId ? { ...row, review_state: next.version?.reviewState ?? null, owner_paused: next.account.owner_paused, staff_restricted: next.account.staff_restricted } : row));
       setNotice(action === "withdraw" ? "已撤回当前审核版本；修改请创建新草稿。" : action === "pause" ? "已暂停接单。" : "已恢复接单，资格检查已完成。");
      lastActionRetry.current = null;
      lastRetry.current = null;
    } catch (failure) {
      if (currentContext(context, controller.signal)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        if (nextError.status === 0) lastActionRetry.current = { context, busy: action, run: () => executeAction(action, context, body, key) };
        if (nextError.status === 409) void reloadDetail(false);
      }
    } finally {
      if (currentContext(context, controller.signal)) setBusy("");
      finishRequest(controller);
    }
  };
  const runAction = async (action: "withdraw" | "pause" | "resume") => {
    if (identityStatusRef.current !== "confirmed" || !identity.current || !detail?.version) return;
    const id = detail.account.id;
    const context = captureContext(id);
    const body = { accountId: id, expectedRevision: detail.account.revision, versionId: detail.version.id, action };
    const key = actionKey(action, body);
    setBusy(action);
    setError(null);
    await executeAction(action, context, body, key);
  };
  const retryLast = async () => {
    const task = lastActionRetry.current ?? lastRetry.current;
    if (!task || !currentContext(task.context)) {
      lastActionRetry.current = null;
      lastRetry.current = null;
      return;
    }
    if (lastActionRetry.current === task) lastActionRetry.current = null;
    else lastRetry.current = null;
    setBusy(task.busy);
    setError(null);
    try {
      await task.run();
    } catch (failure) {
      if (currentContext(task.context)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        if (nextError.status === 0) lastRetry.current = task;
      }
    } finally {
      if (currentContext(task.context)) setBusy("");
    }
  };

  const visibleDetail = detail && (!accountIdProp || detail.account.id === accountIdProp) ? detail : null;
  const heading = <header className="account-module-heading"><div><h2>出租账号管理</h2><p>管理账号资料、审核进度与接单状态。租客交易记录在出租订单中查看。</p></div>{rows.length > 0 && !accountIdProp ? <Link href="/publish" className="button primary">发布新账号</Link> : null}</header>;
  if (identityState === "checking") return <section className="account-module">{heading}<div className="account-module-card account-empty-state" aria-busy="true" role="status"><LockKeyhole size={28} aria-hidden="true" /><h3>正在确认登录身份</h3><p>请稍候，确认后读取出租账号。</p></div></section>;
  if (identityState === "failed") return <section className="account-module">{heading}<div className="account-module-card account-empty-state" role="alert"><LockKeyhole size={28} aria-hidden="true" /><h3>登录身份暂时无法确认</h3><p>重新确认后可以继续查看账号资料。</p><button type="button" className="button secondary" onClick={() => void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); })}>重试</button></div></section>;
  return <section className="my-accounts-panel account-module">
    {heading}
    <AccountActionError error={error} onRetry={error?.status === 0 ? () => void retryLast() : undefined} />
    {notice ? <div className="supply-notice" role="status"><Check size={17} />{notice}</div> : null}
    {authRequired ? <div className="supply-auth-block"><LockKeyhole size={18} /><span>登录后才能查看你的出租账号。</span><Link className="button secondary" href={`/login?next=${encodeURIComponent("/account?view=accounts")}`}>登录 / 注册</Link></div> : accountIdProp ? <>
      <Link className="account-detail-back" href="/account?view=accounts" scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回账号列表</Link>
      {visibleDetail ? <AccountDetail detail={visibleDetail} latest={latest} busy={busy} identityReady={identityState === "confirmed" && Boolean(identity.current)} onAction={runAction} onRefresh={() => void reloadDetail(false)} onAdopt={() => void reloadDetail(true)} /> : <div className="account-module-card account-empty-state" aria-busy={loading ? true : undefined} role="status"><House size={28} aria-hidden="true" /><h3>{loading ? "正在读取账号资料" : "账号资料暂不可用"}</h3><p>{loading ? "请稍候。" : "请返回账号列表，或重试读取当前账号。"}</p></div>}
    </> : rows.length === 0 ? <div className="account-module-card account-empty-state" aria-busy={loading ? true : undefined} role="status">
      <House size={30} aria-hidden="true" /><h3>{loading ? "正在读取出租账号" : error ? "出租账号暂时无法读取" : "还没有发布出租账号"}</h3><p>{loading ? "请稍候。" : error ? "请查看上方提示并重试。" : "填写账号资料并提交审核后，可在这里跟进审核与上架状态。"}</p>{!loading && !error ? <Link href="/publish" className="button primary">发布出租账号</Link> : null}
    </div> : <div className="supply-account-list account-module-card" aria-busy={loading || loadingMore}>
      <div className="account-card-heading"><h3>账号资料</h3><span>当前显示 {rows.length} 个</span></div>
      {rows.map((row) => <Link className="supply-account-row" key={row.id} href={`/account?view=accounts&accountId=${encodeURIComponent(row.id)}`} scroll={false}><span className="account-list-mark" aria-hidden="true"><House size={22} /></span><span className="account-list-copy"><strong>{row.title ?? "未命名草稿"}</strong><small>{row.game_name} · {row.sequence ? `版本 ${row.sequence}` : "尚无版本"}</small></span><span className="supply-account-state">{row.review_state ? stateLabel(row.review_state as never) : "未创建草稿"}{row.owner_paused ? " · 已暂停" : ""}{row.staff_restricted ? " · 已受限" : ""}</span><ChevronRight size={16} aria-hidden="true" /></Link>)}
      {nextCursor ? <button type="button" className="button secondary" disabled={loadingMore || identityState !== "confirmed"} onClick={() => void load(undefined, true, nextCursor)}>{loadingMore ? "正在读取更多…" : "加载更多账号"}</button> : null}
    </div>}
  </section>;
}

function AccountDetail({ detail, latest, busy, identityReady, onAction, onRefresh, onAdopt }: { detail: MySupply; latest: MySupply | null; busy: string; identityReady: boolean; onAction: (action: "withdraw" | "pause" | "resume") => Promise<void>; onRefresh: () => void; onAdopt: () => void }) {
  const version = detail.version;
  const reasons = detail.decisions?.filter((decision) => decision.decision === "REJECT") ?? [];
  const blockers = [...(detail.blockers ?? []), ...(detail.account.staff_restricted ? ["STAFF_RESTRICTED"] : [])];
  const canPause = Boolean(version?.reviewState === "PUBLISHED" && !detail.account.owner_paused);
  const canResume = Boolean(detail.account.owner_paused);
  return <div className="supply-account-detail account-module-card">
    <div className="supply-detail-heading"><div><h2>{version?.declaration.title || "未命名出租账号"}</h2><p>{version ? stateLabel(version.reviewState) : "尚未创建发布版本"}</p></div>{version?.reviewState !== "SUBMITTED" ? <Link href={`/publish?accountId=${encodeURIComponent(detail.account.id)}&edit=1`} className="button secondary">{!version ? "填写账号资料" : version.reviewState === "DRAFT" ? "继续编辑" : "创建修改草稿"}</Link> : null}</div>
    <div className="account-record-links"><Link href={`/account?view=leased&accountId=${encodeURIComponent(detail.account.id)}`} className="account-inline-link" scroll={false}>查看该账号的出租订单<ChevronRight size={15} aria-hidden="true" /></Link></div>
    {latest ? <div className="supply-conflict"><strong>资料状态已变化</strong><p>当前状态：{latest.version ? stateLabel(latest.version.reviewState) : "未创建草稿"}。</p><div className="supply-inline-actions"><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onRefresh}>重新读取</button><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onAdopt}>采用最新状态</button></div></div> : null}
    {blockers.length ? <div className="supply-blockers" role="alert"><strong>当前限制</strong>{[...new Set(blockers)].map((code) => <p key={code}>{blockerText(code)}</p>)}</div> : null}
    {reasons.length ? <div className="supply-decisions"><h3>退回原因</h3>{reasons.map((decision) => <p key={decision.id}>{decision.reason}</p>)}</div> : null}
    <dl className="supply-detail-facts"><div><dt>发布报价（号主侧）</dt><dd>{moneyText(version?.quote?.ownerTotal)}</dd></div><div><dt>发布保证金要求</dt><dd>{moneyText(version?.quote?.publisherBailRequirement)}</dd></div><div><dt>公开展示图</dt><dd>{version?.declaration.mediaBindings.filter((item) => item.purpose === "ACCOUNT_DISPLAY").length ?? 0} 张</dd></div><div><dt>私有审核凭证</dt><dd>{version?.declaration.mediaBindings.filter((item) => item.purpose === "ACCOUNT_EVIDENCE").length ?? 0} 张，仅审核可见</dd></div></dl>
    <p className="account-module-note">发布报价与保证金要求不代表订单收入或资金到账。</p>
    {version?.declaration.description ? <div className="supply-detail-copy"><h3>公开说明</h3><p>{version.declaration.description}</p></div> : null}
    <div className="supply-inline-actions">
      {version?.reviewState === "SUBMITTED" ? <button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={() => void onAction("withdraw")}><Undo2 size={16} />{busy === "withdraw" ? "撤回中…" : "撤回审核"}</button> : null}
      {canPause ? <button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={() => void onAction("pause")}><Pause size={16} />{busy === "pause" ? "暂停中…" : "暂停接单"}</button> : null}
      {canResume ? <button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={() => void onAction("resume")}><Play size={16} />{busy === "resume" ? "恢复中…" : "恢复接单"}</button> : null}
      <button type="button" className="button quiet" disabled={!identityReady || busy !== ""} onClick={onRefresh}><RefreshCw size={15} />刷新状态</button>
    </div>
    <p className="account-module-note">暂停接单不会取消已有订单；订单进展请在出租订单中查看。</p>
  </div>;
}

