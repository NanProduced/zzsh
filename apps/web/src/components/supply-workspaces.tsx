"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CreditCard, LockKeyhole, RefreshCw, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { publishUserSessionChange, useUserSession, useUserSessionStore } from "./session/user-session-provider";
import { ServiceShell } from "./layout/service-shell";
import { SessionLoading } from "./auth/session-loading";
import { RecoveryAlert } from "./ui/information";
import { WebAuthError, webAuthRequest } from "./auth/auth-form";
import { StatusPage } from "@/components/status/status-page";
import { accountStatusLabel, cancellationFailureMessage, identityStatusLabel, type UserIdentitySnapshot } from "@/app/user-account-status";
import { FavoritesPanel } from "./favorites/favorites-panel";
import { FavoritesProvider } from "./favorites/favorites-context";
import { AccountCenterFrame, AccountMembershipCenter, AccountOverview, accountSectionHref, accountViewTitle, isKnownAccountView, resolveAccountView } from "./account/account-center";
import { PersonalWallet } from "./account/personal-wallet";
import { PersonalInvitations } from "./account/personal-invitations";
import { IdentityVerificationForm } from "./account/identity-verification-form";
import { CreditCenter } from "./account/credit-center";
import { AccountSecurityControls, type SecurityNicknameDraft, type SecurityPendingWrite } from "./account/account-security-controls";
import { ConfirmAlertDialog } from "./ui/alert-dialog";
import { MyAccountsPanel } from "./supply-workspace-accounts";
import { AccountOrderPanel } from "./supply-workspace-orders";

function AccountUnsupported({ view }: { view: string }) {
  return <section className="account-module" data-account-view="unsupported"><header className="account-module-heading"><div><h2>页面不存在</h2><p>个人中心没有这个页面</p></div></header><div className="account-module-card account-empty-state" role="status"><Sparkles size={30} aria-hidden="true" /><h3>链接中的页面“{view.slice(0, 40)}”不存在或已调整</h3><p>没有为你打开其他页面，可以回到总览重新选择。</p><Link className="button secondary" href={accountSectionHref("overview", { view: "overview" })}>回到个人中心总览</Link></div></section>;
}

export function AccountWorkspace({ view, accountId, orderId, status, source, page, pay, orderNo, createdFrom, createdTo, stage }: { view: string; accountId?: string; orderId?: string; status?: string; source?: string; page?: string; pay?: string; orderNo?: string; createdFrom?: string; createdTo?: string; stage?: string }) {
  const session = useUserSession();
  const nicknameDraft = useRef<SecurityNicknameDraft["current"]>(null);
  const pendingSecurityWrite = useRef<SecurityPendingWrite["current"]>(null);
  if (session.status === "guest" || session.status === "authenticated" && nicknameDraft.current?.userId !== session.userId) nicknameDraft.current = null;
  if (session.status === "guest" || session.status === "authenticated" && pendingSecurityWrite.current?.userId !== session.userId) pendingSecurityWrite.current = null;
  const active = resolveAccountView(view);
  // F6 面包屑：首页 / 个人中心 / 当前页面（详情视图用详情页名，不暴露内部参数）。
  // 由 AccountCenterFrame 渲染在右侧内容列顶部；loading/error/guest 分支仍走 shell 级面包屑。
  const currentTrail = ((active === "accounts" || active === "rented") && accountId) ? "账号详情"
    : ((active === "rentals" || active === "leased") && orderId) ? "订单详情"
    : accountViewTitle(active);
  const accountTrail = [{ label: "首页", href: "/" }, { label: "个人中心", href: "/account" }, { label: currentTrail }];
  const accountShell = {
    surface: "account" as const,
    contextLabel: null,
    showBack: false,
    showPageHeading: false,
    breadcrumbs: accountTrail,
    searchLabel: "在公开账号目录中搜索",
    searchPlaceholder: "搜索账号编号或名称",
  };
  const title = "个人中心";
  // One bounded retry: a restarting API or a single gateway timeout should not hand the visitor a dead
  // end. A failed read stays UNKNOWN; the shared unavailable page offers retry/public recovery.
  const retried = useRef(false);
  useEffect(() => {
    if (session.status !== "error" || retried.current) return;
    retried.current = true;
    const timer = window.setTimeout(() => session.revalidate(), 700);
    return () => window.clearTimeout(timer);
  }, [session.status, session.revalidate]);
  if (session.status === "loading") return <ServiceShell {...accountShell} title={title}><SessionLoading label="正在加载个人中心…" /></ServiceShell>;
  if (session.status === "error") return <StatusPage kind="unavailable" onRetry={session.revalidate} />;
  if (session.status === "guest") return <ServiceShell {...accountShell} title={title}><RecoveryAlert className="session-recovery" tone="info" title="登录后查看个人中心" problem="登录后继续查看账号、订单和个人资料。" action={<Link className="button primary" href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? "/account" : window.location.pathname + window.location.search)}`}>登录并继续</Link>} /></ServiceShell>;
  const identityScope = `${session.userId}:${session.identityVersion}`;
  // The two detail views render the account or order name as the page's own h1; the shell must not add
  // a second, unrelated one above it.
  const detailOpen = ((active === "accounts" || active === "rented") && Boolean(accountId)) || ((active === "rentals" || active === "leased") && Boolean(orderId));
  return <ServiceShell {...accountShell} breadcrumbs={[]} title={title} headingInContent={detailOpen}>
    <AccountCenterFrame active={active} accountId={accountId} orderId={orderId} status={status} source={source} orderFilters={{orderNo,createdFrom,createdTo,stage}} scope={identityScope} breadcrumbs={accountTrail}>
      {!isKnownAccountView(view) ? <AccountUnsupported view={view} /> : active === "overview" ? <AccountOverview scope={identityScope} userId={session.userId ?? undefined} nicknameDraft={nicknameDraft} pendingWrite={pendingSecurityWrite} /> : active === "membership" ? <AccountMembershipCenter scope={identityScope} /> : active === "credit" ? <CreditCenter scope={identityScope} /> : active === "wallet" ? <PersonalWallet scope={identityScope} /> : active === "invite" ? <PersonalInvitations scope={identityScope} /> : active === "accounts" ? <MyAccountsPanel key="listed" mode="listed" accountId={accountId} filterParam={status} /> : active === "rented" ? <MyAccountsPanel key="rented" mode="rented" accountId={accountId} filterParam={status} /> : active === "security" ? <AccountSecurityPanel pendingWrite={pendingSecurityWrite} /> : active === "identity" ? <AccountIdentityPanel /> : active === "favorites" ? <FavoritesProvider><FavoritesPanel /></FavoritesProvider> : active === "rentals" || active === "leased" ? <AccountOrderPanel active={active} orderId={orderId} status={status} accountId={accountId} source={source} pay={pay} orderNo={orderNo} createdFrom={createdFrom} createdTo={createdTo} stage={stage} /> : null}
    </AccountCenterFrame>
  </ServiceShell>;
}

type AccountProfile = { id: string; name?: string | null; username?: string | null; phoneNumber?: string | null };
type AccountSessionResponse = { user?: AccountProfile } | null;
type AccountReadProof = { scope: string; userId: string };
type AccountReadState = { scope: string; profile: AccountProfile | null; identity: UserIdentitySnapshot | null; proof: AccountReadProof | null; loading: boolean; error: string };

/** 共享未决写互斥判定：同主体存在任何未决写（昵称或安全设置）时为 true。只读，不覆盖/不清除/不重新生成共享槽。 */
export function hasPendingSubjectWrite(pendingWrite: SecurityPendingWrite | undefined, userId: string | null | undefined): boolean {
  return Boolean(pendingWrite?.current && userId && pendingWrite.current.userId === userId);
}

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
  const { profile, identity, loading, error, load, proof, isAuthorized } = useAccountIdentityRead("实名认证信息暂时无法读取，请重试。");
  const session = useUserSession(), noticeScope = `${session.userId}:${session.identityVersion}`;
  const [verificationNotice, setVerificationNotice] = useState<{ scope: string; message: string } | null>(null);
  const isVerified = identity?.identityStatus === "VERIFIED";
  const summary = identity ? { UNVERIFIED: "尚未完成实名认证", VERIFIED: "实名认证已验证", REJECTED: "实名认证未通过", UNKNOWN: "实名状态暂无法确认" }[identity.identityStatus] ?? "实名状态暂无法确认" : "实名状态暂无法确认";
  return <section className="account-module" aria-labelledby="account-identity-heading">
    <header className="account-module-heading">
      <div>
        <h2 id="account-identity-heading">实名认证</h2>
        <p>查看已有结果，按当前可用服务完成本人核验。</p>
      </div>
      <button
        type="button"
        className="button outline sec-tool-btn"
        disabled={loading}
        onClick={() => void load()}
        aria-label="刷新实名认证状态"
      >
        <RefreshCw size={13} className={loading ? "animate-spin" : ""} aria-hidden="true" />
        <span>刷新</span>
      </button>
    </header>
    {verificationNotice?.scope === noticeScope ? <p className="account-module-note" role="status">{verificationNotice.message}</p> : null}
    {loading ? <div className="account-module-card account-empty-state" aria-busy="true" role="status"><ShieldCheck size={28} aria-hidden="true" /><h3>正在读取认证状态</h3><p>请稍候。</p></div> : error && !profile ? <div className="account-module-card account-empty-state" role="alert"><AlertCircle size={28} aria-hidden="true" /><h3>认证信息暂时无法读取</h3><p>{error}</p><button type="button" className="button secondary" onClick={() => void load()}>重试</button></div> : <section className="account-module-card sec-card sec-identity-card">
      {error ? <p className="account-module-note is-error" role="alert">{error}</p> : null}
      <div className="sec-identity-summary" data-state={isVerified ? "verified" : "pending"}>
        <div className="sec-identity-summary-icon" aria-hidden="true"><ShieldCheck size={28} strokeWidth={1.5} /></div>
        <div className="sec-identity-summary-body">
          <div className="sec-identity-summary-title-row">
            <h3 className="sec-identity-summary-title">{summary}</h3>
            {isVerified ? (
              <span className="sec-badge sec-badge--success">已验证</span>
            ) : identity?.identityStatus === "UNVERIFIED" ? (
              <span className="sec-badge sec-badge--neutral">待认证</span>
            ) : identity?.identityStatus === "REJECTED" ? (
              <span className="sec-badge sec-badge--danger">未通过</span>
            ) : (
              <span className="sec-badge sec-badge--neutral">待确认</span>
            )}
          </div>
          <p className="sec-identity-summary-desc">{identity?.ageStatus === "MINOR" ? "实名资料已核验，但当前未满足交易年龄要求，不能上架或下单；如有疑问请联系客服。" : identity?.verificationCapability?.available === true ? identity.verificationCapability.real ? "可提交本人信息进行本次核验，原请求结果未确认时不会重复核验。" : "当前只提供本地模拟校验，请勿填写真实身份资料。" : "线上实名服务暂未开放，当前仅展示已有状态。"}</p>
        </div>
      </div>
      <div className="sec-rows sec-identity-rows">
        <div className="sec-row">
          <div className="sec-row-icon-cell">
            <ShieldCheck className="sec-row-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="sec-row-main">
            <strong className="sec-row-title">实名认证</strong>
            <span className="sec-row-desc">用于确认账号主体身份与受保护交易资格。</span>
          </div>
          <div className="sec-row-state-col">
            <strong className="sec-row-value">{identity ? identityStatusLabel(identity.identityStatus) : "暂无法确认"}</strong>
            {isVerified ? (
              <span className="sec-badge sec-badge--success">已验证</span>
            ) : (
              <span className="sec-badge sec-badge--neutral">未完成</span>
            )}
          </div>
          <div className="sec-row-side" />
        </div>

        {(() => { const display = identity?.identityDisplay; return <>
          {display?.realNameMasked ? (
          <div className="sec-row">
            <div className="sec-row-icon-cell">
              <UserRound className="sec-row-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
            </div>
            <div className="sec-row-main">
              <strong className="sec-row-title">真实姓名</strong>
              <span className="sec-row-desc">{identity?.identityDisplaySource === "NATIVE_PROVIDER" ? "当前实名服务核验后的脱敏资料。" : identity?.identityDisplaySource === "RECORDED_SOURCE" ? "原有核验留存的脱敏资料，并非本次重新核验。" : "已留存的脱敏资料。"}</span>
            </div>
            <div className="sec-row-state-col">
              <strong className="sec-row-value">{display.realNameMasked}</strong>
              <span className="sec-badge sec-badge--success">已核验</span>
            </div>
            <div className="sec-row-side" />
          </div>
        ) : null}

        {display?.idCardMasked ? (
          <div className="sec-row">
            <div className="sec-row-icon-cell">
              <CreditCard className="sec-row-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
            </div>
            <div className="sec-row-main">
              <strong className="sec-row-title">证件号码</strong>
              <span className="sec-row-desc">二代居民身份证。</span>
            </div>
            <div className="sec-row-state-col">
              <strong className="sec-row-value">{display.idCardMasked}</strong>
              <span className="sec-badge sec-badge--success">已核验</span>
            </div>
            <div className="sec-row-side" />
          </div>
        ) : null}
        </>; })()}
      </div>
      <div className="sec-identity-notes">
        {identity?.verificationCapability?.available !== true ? <p className="account-module-note">本页保留已有认证状态；新的核验入口仅在服务与必要文书就绪后开放。</p> : null}
        {isVerified && !identity?.identityDisplay && identity?.identityDisplayReason === "NOT_RECORDED" ? <p className="account-module-note">实名已验证；证件信息暂未记录。</p> : null}
        {isVerified && !identity?.identityDisplay && identity?.identityDisplayReason === "STORE_UNAVAILABLE" ? <p className="account-module-note">实名已验证；证件信息暂不可用。</p> : null}
        {isVerified && !identity?.identityDisplay && !identity?.identityDisplayReason ? <p className="account-module-note">实名已验证；证件信息暂未记录。</p> : null}
        {identity?.provider === "fake" ? <p className="account-module-note">当前为本地测试结果，不代表真实身份核验。</p> : null}
      </div>
      {profile && identity ? <IdentityVerificationForm key={noticeScope} userId={profile.id} identityStatus={identity.identityStatus} capability={identity.verificationCapability} canAct={() => isAuthorized(proof)} onCompleted={message => { setVerificationNotice({ scope: noticeScope, message }); void load(); }} /> : null}
    </section>}
  </section>;
}

function AccountSecurityPanel({ pendingWrite }: { pendingWrite?: SecurityPendingWrite } = {}) {
  const session = useUserSession();
  const { profile, identity, loading, error: readError, load, proof, isAuthorized, invalidate } = useAccountIdentityRead("账号安全信息暂时无法读取，请重试。");
  const [actionState, setActionState] = useState<{ proof: AccountReadProof; busy: boolean; error: string; notice: string } | null>(null);
  // §3.4：注销确认走 Alert Dialog（无原生窗口确认）；未知结果保留恢复责任并阻止盲重发。
  const [cancelOpen, setCancelOpen] = useState(false);
  const localPendingWrite = useRef<SecurityPendingWrite["current"]>(null);
  const pendingSlot = pendingWrite ?? localPendingWrite;
  const cancelUnknown = pendingSlot.current?.userId === session.userId && pendingSlot.current.intent.action === "account-cancel";
  const actionRef = useRef<AccountReadProof | null>(null);
  if (actionRef.current && !isAuthorized(actionRef.current)) actionRef.current = null;
  const action = actionState?.proof === proof ? actionState : null;
  const busy = action?.busy ? "cancel" : "";
  const error = readError || action?.error || "";
  const notice = action?.notice || "";
  // 共享容器存在同主体未决写（昵称或安全设置）时，注销在调用时同步互斥：不覆盖、不清除、不重新生成对方意图。
  const cancelBlockedByPendingWrite = () => hasPendingSubjectWrite(pendingSlot, proof?.userId);
  const cancelEntryLocked = Boolean(busy) || cancelUnknown || cancelBlockedByPendingWrite();

  const cancelAccount = async () => {
    if (!proof || actionRef.current === proof) { setCancelOpen(false); return; }
    // 提交前重新核主体与资格（弹窗打开期间共享会话可能已变化），并同步复核未决写互斥。
    if (!isAuthorized(proof) || cancelBlockedByPendingWrite()) { setCancelOpen(false); return; }
    actionRef.current = proof;
    const intent: NonNullable<SecurityPendingWrite["current"]> = { userId: proof.userId, intent: { action: "account-cancel" }, accepted: false, target: "" };
    pendingSlot.current = intent;
    const clearOwnIntent = () => { if (pendingSlot.current === intent) pendingSlot.current = null; };
    setActionState({ proof, busy: true, error: "", notice: "" });
    try {
      const result = await webAuthRequest<{ status: UserIdentitySnapshot["accountStatus"] }>("/account/cancel", { reason: "用户在账户安全页提交注销" });
      if (result.status !== "CANCELLED") throw new Error("Cancellation result unconfirmed");
      setCancelOpen(false);
      if (!isAuthorized(proof)) return;
      clearOwnIntent();
      setActionState({ proof, busy: false, error: "", notice: "账号已注销，必要历史关联保留；当前会话已撤销。" });
      session.revalidate();
      publishUserSessionChange();
    } catch (failure) {
      setCancelOpen(false);
      if (!isAuthorized(proof)) return;
      if (failure instanceof WebAuthError && failure.status === 401 && !failure.accepted) {
        clearOwnIntent();
        invalidate("登录身份已变化，请重新确认后再试。");
        session.revalidate();
        return;
      }
      // 未知结果（网络中断/网关失败等）：不显示成功、不盲重发；页面保留待确认说明，先刷新读取账号状态。
      if (!(failure instanceof WebAuthError) || failure.accepted || failure.status === 0 || failure.status >= 500) {
        // The shared intent remains locked until an authoritative result is available.
        setActionState({ proof, busy: false, notice: "", error: "" });
        return;
      }
      clearOwnIntent();
      setActionState({ proof, busy: false, notice: "", error: cancellationFailureMessage(failure.status, failure.code) });
    } finally {
      if (actionRef.current === proof) actionRef.current = null;
    }
  };

  return <section className="account-module" aria-labelledby="account-security-heading">
    <header className="account-module-heading">
      <div><h2 id="account-security-heading">账号安全</h2><p>管理登录方式与有效会话。</p></div>
      <button type="button" className="button quiet sec-hidden-desktop" aria-label="刷新账号资料" disabled={loading || Boolean(busy)} onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />刷新</button>
    </header>
    {loading ? <div className="account-module-card account-empty-state" aria-busy="true" role="status"><LockKeyhole size={28} aria-hidden="true" /><h3>正在读取账号资料</h3><p>请稍候。</p></div> : error && !profile ? <div className="account-module-card account-empty-state" role="alert"><AlertCircle size={28} aria-hidden="true" /><h3>账号资料暂时无法读取</h3><p>{error}</p><button type="button" className="button secondary" onClick={() => void load()}>重试</button></div> : <>
      {error ? <p className="account-module-note is-error" role="alert">{error}</p> : null}
      {notice ? <p className="account-module-note" role="status">{notice}</p> : null}
      {/* 顺序：登录与找回 → 会话与设备（含当前会话、当前网络、其他有效会话）→ 账号注销 */}
      {proof ? <AccountSecurityControls key={proof.scope} userId={proof.userId} canAct={() => isAuthorized(proof)} pendingWrite={pendingSlot} /> : null}
      {!identity || identity.accountStatus !== "ACTIVE" ? (
        <section className="account-module-card account-status-card" data-testid="security-account-status" data-state={!identity ? "unknown" : "abnormal"}>
          <dl className="account-fact-list">
            <div><dt>账号状态</dt><dd>{identity ? accountStatusLabel(identity.accountStatus) : "暂无法确认"}</dd></div>
          </dl>
          {!identity ? <p className="account-module-note">读取到的身份信息不完整，暂不能确认账号状态。</p> : null}
        </section>
      ) : null}
      <section id="account-cancellation" className="account-module-card account-danger-zone sec-card sec-cancellation-card">
        <div className="sec-cancellation-main">
          <h3 className="sec-cancellation-title">账号注销</h3>
          <p className="sec-card-note">查看注销账号条件与处理说明。</p>
          {cancelUnknown ? <p className="account-module-note is-error" role="alert">注销结果尚未确认，可能已生效。可刷新账号状态；状态未变不代表原操作失败，请勿重复提交。</p> : null}
        </div>
        <div className="sec-cancellation-side">
          {cancelUnknown
            ? <button type="button" className="button outline sec-action-btn" data-testid="cancel-refresh" disabled={Boolean(busy)} onClick={() => { void load(); }}>{busy === "cancel" ? "处理中…" : "刷新确认结果"}</button>
            : <button type="button" className="button outline sec-action-btn" data-testid="cancel-account" disabled={cancelEntryLocked || !proof || !profile} onClick={() => { if (!proof || !isAuthorized(proof) || cancelEntryLocked) return; setCancelOpen(true); }}>查看</button>}
        </div>
      </section>
      {/* §3.4：注销确认为正式 Alert Dialog；默认焦点与危险色由 ui/alert-dialog 保证，结果确定前弹窗不自行关闭。 */}
      <ConfirmAlertDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="确认注销账号？"
        description="注销会撤销当前登录会话，并匿名化普通资料。这与“退出登录”不同：退出登录不会注销账号，之后仍可登录。"
        consequences={<ul><li>当前登录会话会退出，之后需要重新登录。</li><li>普通资料被匿名化；必要的历史关联按合同保留。</li><li>未完成订单等待办事项请先处理。</li></ul>}
        cancelLabel="暂不注销"
        confirmLabel="确认注销"
        busy={busy === "cancel"}
        confirmDisabled={!proof || !profile || cancelBlockedByPendingWrite()}
        onConfirm={() => { void cancelAccount(); }}
      />
    </>}
  </section>;
}
