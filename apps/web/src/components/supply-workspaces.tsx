"use client";

import Link from "next/link";
import { publishUserSessionChange, useUserSession, useUserSessionStore } from "./session/user-session-provider";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Box, Check, ChevronDown, ChevronRight, ClipboardList, Clock3, Copy, CreditCard, Crosshair, Dumbbell, FileText, Gem, House, ImageOff, Images, LockKeyhole, LogIn, Package, Pause, Pencil, Play, ReceiptText, RefreshCw, Shield, ShieldCheck, Shirt, SlidersHorizontal, Sparkles, Undo2, UserRound, Waves } from "lucide-react";
import { ServiceShell } from "./layout/service-shell";
import { WebAuthError, webAuthRequest } from "./auth/auth-form";
import { useAuthOverlay } from "./auth/auth-overlay-provider";
import { accountStatusLabel, cancellationFailureMessage, identityStatusLabel, type UserIdentitySnapshot } from "@/app/user-account-status";
import { SkinMediaThumb } from "./supply/skin-media-thumb";
import { FavoritesPanel } from "./favorites/favorites-panel";
import { FavoritesProvider } from "./favorites/favorites-context";
import { LegacyOrderWorkspace } from "./order/legacy-order-workspace";
import { OrderWorkspace } from "./order/order-workspace";
import { AccountCenterFrame, AccountMembershipCenter, AccountOverview, accountSectionHref, accountViewTitle, isKnownAccountView, resolveAccountView } from "./account/account-center";
import { PersonalWallet } from "./account/personal-wallet";
import { PersonalInvitations } from "./account/personal-invitations";
import { CreditCenter } from "./account/credit-center";
import { AccountSecurityControls, type SecurityNicknameDraft, type SecurityPendingWrite } from "./account/account-security-controls";
import { ConfirmAlertDialog } from "./ui/alert-dialog";
import { CONDITION_LABELS, conditionLines, haffMillionsLabel, termLabel, unitLabel } from "../lib/listing-view";
import { supplyApi, SupplyRequestError } from "../lib/supply-client";
import { IdentityPauseGate, isCurrentQuery, mergePageById } from "../lib/supply-workspace-guards";
import type { MySupply } from "../lib/supply-types";
// 出租账号列表的 A2 收敛样式（状态分列 · 已加载筛选 chips · 往返恢复）；详情继续沿用 supply-* 规则。
import "./account/my-rental-accounts.css";

type SessionId = string | null | undefined;
type IdentityState = "checking" | "confirmed" | "failed";
type RequestContext = { epoch: number; identity: SessionId; accountId?: string; gameId: string };
type RetryTask = { context: RequestContext; busy: string; run: () => Promise<void> };

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m3d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function moneyText(money: { amount: string } | null | undefined): string {
  return money ? `${money.amount} 元` : "本报价未提供金额";
}

/** Unit prices arrive at eight decimals; show the readable figure next to the quantity it is quoted per. */
function unitPriceText(money: { amount: string } | null | undefined, unitQuantity: string | undefined, unit: string): string {
  if (!money) return "未返回";
  const rounded = Number(money.amount);
  const price = Number.isFinite(rounded) ? rounded.toFixed(2) : money.amount;
  return `${price} 元 / ${unitQuantity && unitQuantity !== "1" ? `${unitQuantity} ` : ""}${unit}`.trim();
}

function stateLabel(state: string | null | undefined): string {
  return ({ DRAFT: "草稿", SUBMITTED: "审核中", WITHDRAWN: "已撤回", REJECTED: "已退回", APPROVED: "已通过", PUBLISHED: "已上架", IMPORTED_UNVERIFIED: "待复核" } as Record<string, string>)[state ?? ""] ?? "未确认";
}

/** 列表一页的读取条数；短于它即证明服务端已无下一页，可显示「已加载全部」。 */
const LIST_PAGE_SIZE = 50;

/** 已加载记录筛选 chips：只作用于本地已加载行，切换不发请求、不改游标（R1 落地后同一接缝改服务端筛选）。 */
const ACCOUNT_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "ALL", label: "全部" },
  { value: "DRAFT", label: "草稿" },
  { value: "SUBMITTED", label: "审核中" },
  { value: "REJECTED", label: "已退回" },
  { value: "APPROVED", label: "已通过" },
  { value: "PUBLISHED", label: "已上架" },
  { value: "IMPORTED_UNVERIFIED", label: "待复核" },
  { value: "WITHDRAWN", label: "已撤回" },
];

/** 资料状态徽章语义色：未知枚举一律「未确认」灰态，不靠颜色单独表意（徽章始终带文字）。 */
const REVIEW_BADGE_TONE: Record<string, string | undefined> = {
  DRAFT: undefined, SUBMITTED: "info", WITHDRAWN: undefined, REJECTED: "error",
  APPROVED: "success", PUBLISHED: "success", IMPORTED_UNVERIFIED: "unknown",
};

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

type AccountRow = { id: string; title: string | null; game_name: string; review_state: string | null; sequence: string | null; owner_paused: boolean; staff_restricted: boolean; historicalRead?: MySupply["historicalRead"] };
/** 读取失败的归属作用域：决定顶部提示文案，避免把局部详情失败写成「账号不存在」。写动作仍回显服务端原文。 */
type AccountErrorScope = "list" | "detail" | "action";
function AccountActionError({ error, scope, onRetry }: { error: SupplyRequestError | null; scope: AccountErrorScope; onRetry?: () => void }) {
  if (!error) return null;
  // 网络未知结果保留原文与重试；403 如实表达无权；详情读取失败不覆盖成泛化的对象不存在。
  const message = error.status === 0 || scope === "action" ? error.message
    : error.status === 403 ? (scope === "detail" ? "没有权限查看该账号资料" : "没有权限查看")
    : scope === "detail" ? "账号资料读取失败"
    : error.message;
  return <div className="supply-notice is-error" role="alert"><AlertCircle size={17} /><span>{message}</span>{error.status === 0 && onRetry ? <button type="button" className="button quiet" onClick={onRetry}>重试</button> : null}</div>;
}

function AccountUnsupported({ view }: { view: string }) {
  return <section className="account-module" data-account-view="unsupported"><header className="account-module-heading"><div><h2>页面不存在</h2><p>个人中心没有这个页面</p></div></header><div className="account-module-card account-empty-state" role="status"><Sparkles size={30} aria-hidden="true" /><h3>链接中的页面“{view.slice(0, 40)}”不存在或已调整</h3><p>没有为你打开其他页面，可以回到总览重新选择。</p><Link className="button secondary" href={accountSectionHref("overview", { view: "overview" })}>回到个人中心总览</Link></div></section>;
}

export function AccountWorkspace({ view, accountId, orderId, status, source, page }: { view: string; accountId?: string; orderId?: string; status?: string; source?: string; page?: string }) {
  const auth = useAuthOverlay();
  const session = useUserSession();
  const nicknameDraft = useRef<SecurityNicknameDraft["current"]>(null);
  const pendingSecurityWrite = useRef<SecurityPendingWrite["current"]>(null);
  if (session.status === "guest" || session.status === "authenticated" && nicknameDraft.current?.userId !== session.userId) nicknameDraft.current = null;
  if (session.status === "guest" || session.status === "authenticated" && pendingSecurityWrite.current?.userId !== session.userId) pendingSecurityWrite.current = null;
  const active = resolveAccountView(view);
  // F6 面包屑：首页 / 个人中心 / 当前页面（详情视图用详情页名，不暴露内部参数）。
  // 由 AccountCenterFrame 渲染在右侧内容列顶部；loading/error/guest 分支仍走 shell 级面包屑。
  const currentTrail = (active === "accounts" && accountId) ? "账号详情"
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
  // Only ever read on the client: the error branch renders after the probe fails, never during SSR.

  // One bounded retry: a restarting API or a single gateway timeout should not hand the visitor a dead
  // end. Beyond that the card below offers both ways forward.
  const retried = useRef(false);
  useEffect(() => {
    if (session.status !== "error" || retried.current) return;
    retried.current = true;
    const timer = window.setTimeout(() => session.revalidate(), 700);
    return () => window.clearTimeout(timer);
  }, [session.status, session.revalidate]);
  if (session.status === "loading") return <ServiceShell {...accountShell} title={title}><section className="account-guest" aria-busy="true"><h2>正在准备个人中心…</h2><p>请稍候。</p></section></ServiceShell>;
  if (session.status === "error") return <ServiceShell {...accountShell} title={title}><section className="account-guest" role="alert"><LockKeyhole size={30} /><h2>登录状态暂未确认</h2><p>暂时没能确认这次的登录状态（网络或服务短暂不可用）。可以重新确认；还没登录的话，直接去登录。</p><div className="account-guest-actions"><button type="button" className="button secondary" onClick={session.revalidate}>重新确认</button><button type="button" className="button primary" onClick={() => auth.open()}>打开登录窗口</button></div></section></ServiceShell>;
  if (session.status === "guest") return <ServiceShell {...accountShell} title={title}><section className="account-guest" aria-busy="true"><LockKeyhole size={30} /><h2>正在打开登录窗口</h2></section></ServiceShell>;
  const identityScope = `${session.userId}:${session.identityVersion}`;
  // The two detail views render the account or order name as the page's own h1; the shell must not add
  // a second, unrelated one above it.
  const detailOpen = (active === "accounts" && Boolean(accountId)) || ((active === "rentals" || active === "leased") && Boolean(orderId));
  return <ServiceShell {...accountShell} breadcrumbs={[]} title={title} headingInContent={detailOpen}>
    <AccountCenterFrame active={active} accountId={accountId} orderId={orderId} status={status} scope={identityScope} breadcrumbs={accountTrail}>
      {!isKnownAccountView(view) ? <AccountUnsupported view={view} /> : active === "overview" ? <AccountOverview scope={identityScope} userId={session.userId ?? undefined} nicknameDraft={nicknameDraft} pendingWrite={pendingSecurityWrite} /> : active === "membership" ? <AccountMembershipCenter scope={identityScope} /> : active === "credit" ? <CreditCenter scope={identityScope} /> : active === "wallet" ? <PersonalWallet scope={identityScope} /> : active === "invite" ? <PersonalInvitations scope={identityScope} /> : active === "accounts" ? <MyAccountsPanel accountId={accountId} /> : active === "security" ? <AccountSecurityPanel pendingWrite={pendingSecurityWrite} /> : active === "identity" ? <AccountIdentityPanel /> : active === "favorites" ? <FavoritesProvider><FavoritesPanel /></FavoritesProvider> : active === "rentals" || active === "leased" ? <OrderWorkspace party={active === "rentals" ? "renter" : "owner"} orderId={orderId} status={status} accountId={accountId} source={source} /> : null}
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
  const { profile, identity, loading, error, load } = useAccountIdentityRead("实名认证信息暂时无法读取，请重试。");
  const isVerified = identity?.identityStatus === "VERIFIED";
  const summary = identity ? { UNVERIFIED: "尚未完成实名认证", VERIFIED: "实名认证已验证", REJECTED: "实名认证未通过", UNKNOWN: "实名状态暂无法确认" }[identity.identityStatus] : "实名状态暂无法确认";
  return <section className="account-module" aria-labelledby="account-identity-heading">
    <header className="account-module-heading">
      <div>
        <h2 id="account-identity-heading">实名认证</h2>
        <p>查看已有实名认证结果。</p>
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
          <p className="sec-identity-summary-desc">{identity?.provider === "none" ? "线上实名服务暂未开放，当前无法提交新的认证。" : "认证结果会影响部分受保护交易操作。"}</p>
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

        {/* shortcut: 已核验姓名/证件号两行依赖 /identity/status 返回 realNameMasked/idCardMasked；当前 API 未提供时该两行不渲染，API 补齐后自动生效。 */}
        {identity?.realNameMasked ? (
          <div className="sec-row">
            <div className="sec-row-icon-cell">
              <UserRound className="sec-row-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
            </div>
            <div className="sec-row-main">
              <strong className="sec-row-title">真实姓名</strong>
              <span className="sec-row-desc">已核验的实名信息。</span>
            </div>
            <div className="sec-row-state-col">
              <strong className="sec-row-value">{identity.realNameMasked}</strong>
              <span className="sec-badge sec-badge--success">已核验</span>
            </div>
            <div className="sec-row-side" />
          </div>
        ) : null}

        {identity?.idCardMasked ? (
          <div className="sec-row">
            <div className="sec-row-icon-cell">
              <CreditCard className="sec-row-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
            </div>
            <div className="sec-row-main">
              <strong className="sec-row-title">证件号码</strong>
              <span className="sec-row-desc">二代居民身份证。</span>
            </div>
            <div className="sec-row-state-col">
              <strong className="sec-row-value">{identity.idCardMasked}</strong>
              <span className="sec-badge sec-badge--success">已核验</span>
            </div>
            <div className="sec-row-side" />
          </div>
        ) : null}
      </div>
      <div className="sec-identity-notes">
        <p className="account-module-note">本页展示已有状态，暂不提供证件提交或认证资料修改。</p>
        {identity?.provider === "fake" ? <p className="account-module-note">当前为本地测试结果，不代表真实身份核验。</p> : null}
      </div>
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
  const [lastPageSize, setLastPageSize] = useState<number | null>(null);
  const [filter, setFilter] = useState("ALL");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<SupplyRequestError | null>(null);
  const [errorScope, setErrorScope] = useState<AccountErrorScope>("list");
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
  // F2：列表与详情生命周期分离。列表首页是否已读、详情往返的来源位置都独立于详情状态。
  const listReadyRef = useRef(false);
  const listPositionRef = useRef<{ accountId: string; scrollY: number } | null>(null);
  // 列表可见期间持续记录滚动位置：开详情不清它，返回时按来源行还原。
  const listScrollRef = useRef(0);
  const previousAccountRef = useRef(accountIdProp);

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
    listReadyRef.current = false;
    listPositionRef.current = null;
    listScrollRef.current = 0;
    setRows([]);
    setDetail(null);
    setLatest(null);
    setNextCursor(null);
    nextCursorRef.current = null;
    setLastPageSize(null);
    setFilter("ALL");
    setLoading(false);
    setLoadingMore(false);
    setBusy("");
    setError(null);
    setErrorScope("list");
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
  // 撤销私有事实：身份变化走 invalidateContext（整体清空）；详情读取 401/403/404 只撤详情，
  // 已加载列表、游标与筛选按 F2 保留，避免「开/换详情」把列表一起打掉。
  const revokeDetail = useCallback(() => { setDetail(null); setLatest(null); }, []);
  // Preserve list position and pagination, but never restore facts superseded by a confirmed detail.
  const updateListFromDetail = useCallback((next: MySupply) => {
    if (!next.account || next.account.id !== accountRef.current) return;
    setRows((previous) => previous.map((row) => row.id === next.account.id ? {
      ...row,
      title: next.version ? next.version.declaration?.title ?? row.title : null,
      sequence: next.version ? next.version.sequence ?? row.sequence : null,
      review_state: next.version?.reviewState ?? null,
      owner_paused: next.account.owner_paused,
      staff_restricted: next.account.staff_restricted,
      historicalRead: next.historicalRead === undefined ? row.historicalRead : next.historicalRead,
    } : row));
  }, []);
  const revokeList = useCallback(() => {
    setRows([]);
    setNextCursor(null);
    nextCursorRef.current = null;
    listReadyRef.current = false;
    setLastPageSize(null);
    setFilter("ALL");
  }, []);
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
    // F2：列表与详情生命周期分离——详情往返不重拉已加载列表；只有首页未读或显式翻页才请求列表。
    const needListPage = append || !listReadyRef.current;
    // 失败归属：顶部提示按读取作用域措辞，详情读取失败不写成账号不存在。
    let phase: AccountErrorScope = "list";
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      if (!(await waitForIdentity(context))) return;
      if (needListPage) {
        phase = "list";
        const params = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
        // `/me/accounts` pages by `after` (the previous page's last id); a wrong name silently
        // repeats the first page. The shared client keeps the same normalization for other callers.
        if (requestCursor) params.set("after", requestCursor);
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
        // 短页是「已加载全部」的唯一依据：服务端本页未给满条数即无下一页。
        setLastPageSize(page.items.length);
        listReadyRef.current = true;
        setAuthRequired(false);
      }
      if (id && !append) {
        phase = "detail";
        if (!(await waitForIdentity(context))) return;
        const next = await supplyApi.mine(id, controller.signal);
        if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
        setDetail(next);
        updateListFromDetail(next);
      }
    } catch (failure) {
      if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
      const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
      setError(nextError);
      setErrorScope(phase);
      // 身份失效撤全部旧私有事实；403/404：详情读取只撤详情，列表读取才撤列表（F2 往返不清列表）。
      if (nextError.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
      else if (nextError.status === 403 || nextError.status === 404) { if (phase === "detail") revokeDetail(); else revokeList(); }
      if (nextError.status === 0) lastRetry.current = { context, busy: append ? "accounts-more" : "accounts", run: () => load(id, append, requestCursor) };
    } finally {
      if (currentContext({ ...context, epoch: requestEpoch }, controller.signal) && isCurrent()) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
      finishRequest(controller);
    }
  }, [currentContext, waitForIdentity, revokeList, revokeDetail, updateListFromDetail]);
  useEffect(() => {
    mounted.current = true;
    // F2：列表 ↔ 详情生命周期分离。详情路由（?accountId= 增删，含点击与前进/后退）只切换详情作用域：
    // 列表行、游标、筛选与 listReady 原样保留；切账号即撤旧详情，返回时按来源行恢复滚动与焦点。
    // 身份变化/401 等仍走 invalidateContext 整体作废。
    if (routeAccountRef.current !== accountIdProp) {
      routeAccountRef.current = accountIdProp;
      accountRef.current = accountIdProp;
      revokeDetail();
      // 只在“进入详情”时记录来源行与滚动；返回时由恢复效果消费后再清，避免先手清掉待恢复位置。
      if (accountIdProp) listPositionRef.current = { accountId: accountIdProp, scrollY: listScrollRef.current };
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
  }, [accountIdProp, load, syncIdentity, sharedSession, revokeDetail]);

  // 列表可见期间持续记录滚动位置（开详情即停止更新，避免被详情页高度钳制覆盖）。
  useEffect(() => {
    if (accountIdProp) return;
    const onScroll = () => { listScrollRef.current = window.scrollY; };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [accountIdProp]);

  // 返回列表：还原记录的滚动位置，并把焦点交回来源行的标题链（Tab 序与视觉顺序一致）。
  useEffect(() => {
    if (accountIdProp) return;
    const position = listPositionRef.current;
    if (!position) return;
    listPositionRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo(0, position.scrollY);
      document.getElementById(`account-row-title-${position.accountId}`)?.focus?.({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [accountIdProp]);

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
      updateListFromDetail(next);
      setError(null);
      lastRetry.current = null;
      lastActionRetry.current = null;
    } catch (failure) {
      if (currentContext(context, controller.signal)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        setErrorScope("detail");
        // 详情重读 401/403/404：撤旧私有详情（不显示上一次缓存），列表与游标按 F2 保留。
        if (nextError.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
        else if (nextError.status === 403 || nextError.status === 404) revokeDetail();
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
      updateListFromDetail(next);
       setNotice(action === "withdraw" ? "已撤回当前审核版本；修改请创建新草稿。" : action === "pause" ? "已暂停接单。" : "已恢复接单，资格检查已完成。");
      lastActionRetry.current = null;
      lastRetry.current = null;
    } catch (failure) {
      if (currentContext(context, controller.signal)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        // 写动作保留服务端原文（409 冲突块与字段错误都要读懂）；仅 401 视为身份失效并撤旧私有事实。
        setErrorScope("action");
        if (nextError.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
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
        setErrorScope(task.busy === "detail" ? "detail" : task.busy === "accounts" || task.busy === "accounts-more" ? "list" : "action");
        if (nextError.status === 0) lastRetry.current = task;
      }
    } finally {
      if (currentContext(task.context)) setBusy("");
    }
  };

  // DTO 缺 account 子对象或路由已切走时，一律不成立：宁可「账号资料暂不可用」，也不显示上一次缓存的私有详情。
  const visibleDetail = detail && detail.account && (!accountIdProp || detail.account.id === accountIdProp) ? detail : null;
  const heading = <header className="account-module-heading"><div><h2>出租账号管理</h2><p>管理账号资料、审核进度与接单状态。租客交易记录在出租订单中查看。</p></div>{rows.length > 0 && !accountIdProp ? <Link href="/publish" className="button primary">发布新账号</Link> : null}</header>;
  if (identityState === "checking") return <section className="account-module">{heading}<div className="account-module-card account-empty-state" aria-busy="true" role="status"><LockKeyhole size={28} aria-hidden="true" /><h3>正在确认登录身份</h3><p>请稍候，确认后读取出租账号。</p></div></section>;
  if (identityState === "failed") return <section className="account-module">{heading}<div className="account-module-card account-empty-state" role="alert"><LockKeyhole size={28} aria-hidden="true" /><h3>登录身份暂时无法确认</h3><p>重新确认后可以继续查看账号资料。</p><button type="button" className="button secondary" onClick={() => void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); })}>重试</button></div></section>;
  // 已加载记录筛选：只过滤本地行，不发请求、不动游标（R1 落地后同一接缝改服务端筛选）。
  const visibleRows = filter === "ALL" ? rows : rows.filter((row) => row.review_state === filter);
  // 短页（< limit 且无游标）才敢说「已加载全部」；无 total 合同，绝不写「共 N 个」。
  const allLoaded = nextCursor === null && lastPageSize !== null && lastPageSize < LIST_PAGE_SIZE;
  return <section className="my-accounts-panel account-module">
    {accountIdProp ? null : heading}
    <AccountActionError error={error} scope={errorScope} onRetry={error?.status === 0 ? () => void retryLast() : undefined} />
    {notice ? <div className="supply-notice" role="status"><Check size={17} />{notice}</div> : null}
    {authRequired ? <div className="supply-auth-block"><LockKeyhole size={18} /><span>登录后才能查看你的出租账号。</span><Link className="button secondary" href={`/login?next=${encodeURIComponent("/account?view=accounts")}`}>登录 / 注册</Link></div> : accountIdProp ? <>
      <Link className="account-detail-back" href="/account?view=accounts" scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回出租账号</Link>
      {visibleDetail ? <AccountDetail detail={visibleDetail} gameName={rows.find((row) => row.id === visibleDetail.account.id)?.game_name ?? null} latest={latest} busy={busy} identityReady={identityState === "confirmed" && Boolean(identity.current)} onAction={runAction} onRefresh={() => void reloadDetail(false)} onAdopt={() => void reloadDetail(true)} /> : <div className="account-module-card account-empty-state" aria-busy={loading ? true : undefined} role="status"><House size={28} aria-hidden="true" /><h3>{loading ? "正在读取账号资料" : "账号资料暂不可用"}</h3><p>{loading ? "请稍候。" : "请返回账号列表，或重试读取当前账号。"}</p></div>}
    </> : rows.length === 0 ? (!loading && !error
      ? <div className="account-module-card account-empty-art-state" role="status">
        <img className="account-empty-art" src="/art/empty/account-prepare-r1.webp" alt="" width={240} height={180} loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />
        <h3>还没有发布出租账号</h3>
        <p>填写账号资料即可发布，发布与上架进度都会显示在这里。</p>
        <div className="account-empty-actions"><Link href="/publish" className="button primary">发布出租账号</Link></div>
      </div>
      : <div className="account-module-card account-empty-state" aria-busy={loading ? true : undefined} role={loading ? "status" : "alert"}>
        <House size={30} aria-hidden="true" />
        <h3>{loading ? "正在读取出租账号" : "出租账号暂时无法读取"}</h3>
        <p>{loading ? "请稍候。" : "请查看上方提示并重试。"}</p>
      </div>) : <div className="supply-account-list account-module-card" aria-busy={loading || loadingMore}>
      {/* 工具条：已加载计数 + 已加载记录筛选 chips + 作用域小字（无 total 合同，不显示全站总数）。 */}
      <div className="mra-toolbar">
        <span className="mra-count">已加载 {rows.length} 个</span>
        <div className="mra-chips" role="group" aria-label="按资料状态筛选已加载记录">
          {ACCOUNT_FILTERS.map((chip) => <button key={chip.value} type="button" className="mra-chip" aria-pressed={filter === chip.value} onClick={() => setFilter(chip.value)}>{chip.label}</button>)}
        </div>
        <span className="mra-scope-hint">仅筛选已加载的 {rows.length} 个账号</span>
      </div>
      {/* 行 DOM：div 行容器 ＋ 唯一主导航标题链（标题＋副行整体）＋（仅 REJECTED）独立锚链，互不嵌套。 */}
      <div className="mra-rows" role="list" aria-label="出租账号列表">
        {visibleRows.map((row) => <div className="mra-row" role="listitem" key={row.id} data-account-row={row.id}>
          <Link className="mra-row-main" id={`account-row-title-${row.id}`} href={`/account?view=accounts&accountId=${encodeURIComponent(row.id)}`} scroll={false}>
            <strong className="mra-row-title">{row.title ?? "未命名草稿"}</strong>
            {row.historicalRead ? <span className="mra-row-sub">历史编号 {row.historicalRead.resourceNo} · {row.historicalRead.display?.state === "KNOWN" ? "历史资料已读取" : "扩展资料尚待接入"}</span> : null}
            <span className="mra-row-sub">{row.game_name} · {row.sequence ? `版本 ${row.sequence}` : "尚无版本"}</span>
          </Link>
          <div className="mra-row-state">
            <span className="mra-badge" data-tone={row.review_state ? REVIEW_BADGE_TONE[row.review_state] ?? "unknown" : undefined}>{row.review_state ? stateLabel(row.review_state) : "未创建草稿"}</span>
            {row.review_state === "REJECTED" ? <Link className="mra-row-anchor" href={`/account?view=accounts&accountId=${encodeURIComponent(row.id)}#blockers`} scroll={false}>查看退回原因</Link> : null}
          </div>
          {/* 接单提示只显示服务端给出的确定异常；正常行留空，不声称可接单。 */}
          <div className="mra-row-avail">
            {row.owner_paused ? <span className="mra-badge" data-tone="warning">已暂停接单</span> : null}
            {row.staff_restricted ? <span className="mra-badge" data-tone="warning">客服限制</span> : null}
          </div>
          <span className="mra-row-hint" aria-hidden="true">查看详情 ›</span>
        </div>)}
      </div>
      {visibleRows.length === 0 ? <div className="mra-empty" role="status"><p>当前筛选没有匹配的已加载账号</p><button type="button" className="button quiet" onClick={() => setFilter("ALL")}>清除筛选</button></div> : null}
      <div className="mra-list-foot">
        {nextCursor ? <button type="button" className="button secondary" disabled={loadingMore || identityState !== "confirmed"} onClick={() => void load(undefined, true, nextCursor)}>{loadingMore ? "正在读取更多…" : "加载更多账号"}</button> : null}
        {allLoaded ? <span className="mra-meta">已加载全部 {rows.length} 个</span> : null}
      </div>
    </div>}
  </section>;
}

const mediaAccessUrl = (assetId: string) => `/api/supply/media/${encodeURIComponent(assetId)}/access`;

const CONDITION_LEVELS = new Set(["vit_level", "bear_level", "dive_level", "character_level"]);

const CONDITION_ICONS: Record<string, typeof Box> = {
  safe_box_code: Box, vit_level: Dumbbell, bear_level: Package, dive_level: Waves,
  character_level: UserRound, grading_code: Gem, secret_kd: Crosshair, login_method_code: LogIn,
  service_window: Clock3,
};

const REVIEW_TONE: Record<string, string> = {
  PUBLISHED: "completed", APPROVED: "completed", SUBMITTED: "pending",
  REJECTED: "expired", DRAFT: "cancelled", WITHDRAWN: "cancelled", IMPORTED_UNVERIFIED: "unknown",
};

const AVAILABILITY_TONE = { open: "completed", uncertain: "pending", blocked: "expired" } as const;

function displayTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(value)).replaceAll("/", "-");
}

/**
 * Account conditions, reusing the account-listing label tables. A code the catalog cannot map is
 * reported as "{label}规格待确认" — the raw code is never guessed into a display name.
 */
function conditionRows(version: MySupply["version"]): Array<{ key: string; label: string; value: string }> {
  const attributes = version?.declaration?.attributes as Record<string, unknown> | undefined;
  if (!attributes) return [];
  const display = version?.attributeDisplay ?? null;
  const rows: Array<{ key: string; label: string; value: string }> = [];
  const codeValue = (code: { displayName: string | null; mappingStatus: string } | null | undefined, label: string) =>
    code?.mappingStatus === "CONFIRMED" && code.displayName ? code.displayName : `${label}规格待确认`;
  for (const [key, label] of Object.entries(CONDITION_LABELS)) {
    const raw = attributes[key];
    if (raw === null || raw === undefined || raw === "") continue;
    if (key === "safe_box_code") rows.push({ key, label, value: codeValue(display?.safeBox, label) });
    else if (key === "grading_code") rows.push({ key, label, value: codeValue(display?.grading, label) });
    else if (key === "login_method_code") rows.push({ key, label, value: codeValue(display?.loginMethod, label) });
    else if (CONDITION_LEVELS.has(key)) rows.push({ key, label, value: `${raw} 级` });
    else rows.push({ key, label, value: String(raw) });
  }
  if (display?.serviceWindow) rows.push({ key: "service_window", label: "上号时间", value: display.serviceWindow.displayName });
  return rows;
}

const UNCERTAIN_BLOCKERS = new Set(["PUBLISHER_BAIL_UNCONFIRMED", "FUNDING_UNKNOWN", "OCCUPANCY_UNKNOWN"]);

/**
 * Whether this account can take a new order comes from the server's aggregated `available` verdict.
 * The client never recombines pause flags, restrictions and coverage into its own boolean.
 */
function availabilityView(detail: MySupply): { tone: "open" | "blocked" | "uncertain"; label: string } {
  const reasons = [...new Set([...(detail.blockers ?? []), ...(detail.account.staff_restricted ? ["STAFF_RESTRICTED"] : [])])];
  if (detail.available === true) return { tone: "open", label: "当前可接新单" };
  if (detail.available === false) {
    return reasons.some((code) => UNCERTAIN_BLOCKERS.has(code)) || reasons.length === 0
      ? { tone: "uncertain", label: "资格待确认" }
      : { tone: "blocked", label: "暂不可接新单" };
  }
  return { tone: "uncertain", label: "资格待确认" };
}

type ResourceRow = { name: string; unit: string; quantity: string | null; ownerUnit: string | null; ownerAmount: string | null };

function resourceRows(version: MySupply["version"]): ResourceRow[] {
  const lines = version?.quote?.lines ?? [];
  const catalog = version?.catalogItems ?? [];
  const items = version?.presentation?.items ?? [];
  return lines.map((line) => {
    const known = catalog.find((entry) => entry.id === line.itemId) ?? items.find((entry) => entry.id === line.itemId);
    return {
      name: known?.name || "资源",
      unit: unitLabel(line.unit ?? known?.unit ?? ""),
      quantity: line.quantity ?? line.unitQuantity ?? null,
      ownerUnit: unitPriceText(line.ownerUnitAmount, line.unitQuantity, unitLabel(line.unit ?? known?.unit ?? "")),
      ownerAmount: moneyText(line.ownerAmount),
    };
  });
}

/**
 * Public account media, with the three states the page has to distinguish: loading, failed (with a
 * retry), and genuinely absent. The frame keeps its shape while loading so nothing jumps.
 */
function AccountMedia({ assetId, alt, className }: { assetId: string; alt: string; className?: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  return <div className={`supply-media-frame${className ? ` ${className}` : ""}`} data-state={state}>
    {state === "loading" ? <span className="supply-media-skeleton" aria-hidden="true" /> : null}
    {state === "error" ? <div className="supply-media-error" role="status"><ImageOff size={18} aria-hidden="true" /><span>图片加载失败</span><button type="button" className="button secondary button--sm" onClick={() => { setState("loading"); setAttempt((value) => value + 1); }}>重试</button></div> : null}
    <img key={attempt} style={state === "error" ? { display: "none" } : undefined} src={mediaAccessUrl(assetId)} alt={alt} loading="lazy" onLoad={() => setState("ready")} onError={() => setState("error")} />
  </div>;
}

function historicalQuantityText(quantity: string | null, unit: string): string {
  if (quantity === null || !/^[0-9]{1,24}$/.test(quantity)) return "数量待核";
  return unit === "HAFF_BASE" ? haffMillionsLabel(quantity) + " M 哈夫币" : BigInt(quantity).toLocaleString("zh-CN") + " " + unitLabel(unit);
}

function AccountDetail({ detail, gameName, latest, busy, identityReady, onAction, onRefresh, onAdopt }: { detail: MySupply; gameName?: string | null; latest: MySupply | null; busy: string; identityReady: boolean; onAction: (action: "withdraw" | "pause" | "resume") => Promise<void>; onRefresh: () => void; onAdopt: () => void }) {
  const account = detail.account;
  const version = detail.version;
  // DTO 降级（S16）：historicalRead 缺子对象按「不渲染该块」处理，不整页崩。
  const historical = detail.historicalRead?.historicalQuote ? detail.historicalRead : null;
  const savedDisplay = historical?.display?.state === "KNOWN" ? historical.display.facts : null;
  const historicalDisplay = savedDisplay?.attributes && Array.isArray(savedDisplay.resources) ? savedDisplay : null;
  const historicalConditions = historicalDisplay ? conditionLines(historicalDisplay.attributes, { attributeDisplay: historicalDisplay.attributeDisplay }) : [];
  const history = Array.isArray(detail.history) ? detail.history : [];
  // 列表「查看退回原因」锚链：详情异步插入后自行把 #blockers 滚入视野并接管焦点。
  const blockersRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#blockers") return;
    const target = blockersRef.current;
    if (!target) return;
    target.scrollIntoView?.();
    target.focus?.({ preventScroll: true });
  }, [detail.account.id]);
  const declaration = version?.declaration;
  const quote = version?.quote ?? null;
  const publication = version?.publication ?? null;
  const publishedAt = displayTime(publication?.publishedAt);
  const reasons = detail.decisions?.filter((decision) => decision.decision === "REJECT") ?? [];
  const blockers = [...new Set([...(detail.blockers ?? []), ...(account.staff_restricted ? ["STAFF_RESTRICTED"] : [])])];
  const availability = availabilityView(detail);
  const conditions = conditionRows(version);
  const resources = resourceRows(version);
  const displayMedia = (declaration?.mediaBindings ?? []).filter((item) => item.purpose === "ACCOUNT_DISPLAY" && item.publicDisplayEligible !== false);
  const evidenceMedia = (declaration?.mediaBindings ?? []).filter((item) => item.purpose === "ACCOUNT_EVIDENCE");
  const penaltyMedia = displayMedia.filter((item) => item.category === "PENALTY");
  const galleryMedia = displayMedia.filter((item) => item.category !== "PENALTY");
  const cover = galleryMedia.find((item) => item.publiclyReadable !== false) ?? null;
  const skins = version?.presentation?.skins ?? [];
  const entitlementNames = new Map((version?.presentation?.entitlements ?? []).map((entry) => [entry.id, entry.name]));
  const entitlements = (declaration?.entitlements ?? []).map((entry) => {
    const disclosure = quote?.expiryDisclosures?.find((item) => item.entitlementId === entry.entitlementId);
    return {
      name: entitlementNames.get(entry.entitlementId) ?? "权益",
      term: !disclosure ? "期限未提供" : disclosure.expiresAt === null ? "长期权益" : `到期 ${displayTime(disclosure.expiresAt) ?? "时间未确认"}`,
    };
  });
  const editHref = `/publish?accountId=${encodeURIComponent(account.id)}&edit=1`;
  const editLabel = !version ? "填写账号资料" : version.reviewState === "DRAFT" ? "继续编辑资料" : "修改账号资料";

  return <div className="supply-account-detail account-module-card">
    {/* One identity band: the account name is the page's single title, the meta line carries identity,
        the status line carries state and the control that changes it. */}
    <div className="supply-detail-hero">
      {cover ? <img className="supply-detail-cover" src={mediaAccessUrl(cover.assetId)} alt="" width={176} height={99} onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
      <div className="supply-detail-hero-copy">
        <h1 className="supply-detail-title">{declaration?.title || "未命名出租账号"}</h1>
        <p className="supply-detail-meta">
          {account.display_no ? <span className="supply-detail-no">账号 {account.display_no}<button type="button" className="account-copy" onClick={() => void navigator.clipboard.writeText(account.display_no ?? "")} aria-label="复制账号编号"><Copy size={13} aria-hidden="true" />复制</button></span> : null}
          {gameName ? <span>{gameName}</span> : null}
          {publishedAt ? <span>发布于 {publishedAt}</span> : null}
          {publication?.source === "OWNER_DIRECT" ? <span>号主直接发布</span> : null}
        </p>
        <div className="supply-detail-status">
          <span className="order-status" data-state={REVIEW_TONE[version?.reviewState ?? ""] ?? "unknown"}>{version ? stateLabel(version.reviewState) : "尚未创建发布版本"}</span>
          <span className="order-status" data-state={AVAILABILITY_TONE[availability.tone]}>{availability.label}</span>
          {account.owner_paused
            ? <button type="button" className="button secondary button--sm" disabled={!identityReady || busy !== ""} onClick={() => void onAction("resume")}><Play size={15} aria-hidden="true" />{busy === "resume" ? "恢复中…" : "恢复接单"}</button>
            : version ? <button type="button" className="button secondary button--sm" disabled={!identityReady || busy !== ""} onClick={() => void onAction("pause")}><Pause size={15} aria-hidden="true" />{busy === "pause" ? "暂停中…" : "暂停接单"}</button> : null}
          <button type="button" className="button quiet button--sm" disabled={!identityReady || busy !== ""} onClick={onRefresh}><RefreshCw size={14} aria-hidden="true" />刷新状态</button>
        </div>
      </div>
      <div className="supply-detail-actions">
        {version?.reviewState === "SUBMITTED" ? (
          <button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={() => void onAction("withdraw")}><Undo2 size={16} aria-hidden="true" />{busy === "withdraw" ? "撤回中…" : "撤回审核"}</button>
        ) : (
          <Link href={editHref} className="button primary"><Pencil size={16} aria-hidden="true" />{editLabel}</Link>
        )}
        <p className="supply-detail-actions-hint">保存后生成新版本，当前生效资料不变。</p>
      </div>
    </div>

    {historical ? <section className="supply-block account-module-card"><h2>历史账号资料</h2><p>历史记录仅供查阅，不表示当前可接新单。</p><dl className="order-facts"><div><dt>历史账号编号</dt><dd>{historical.resourceNo}</dd></div><div><dt>历史租期</dt><dd>{historical.historicalQuote.termDays} 天</dd></div><div><dt>历史哈夫币租金</dt><dd>{historical.historicalQuote.haffRentYuan} 元</dd></div><div><dt>历史物资金额</dt><dd>{historical.historicalQuote.goodsYuan} 元</dd></div><div><dt>历史押金</dt><dd>{historical.historicalQuote.depositYuan} 元</dd></div></dl><Link href={`/account?view=leased&source=legacy&accountId=${encodeURIComponent(account.id)}`}>查看该账号的历史出租订单</Link></section> : null}
    {historical ? <section className="supply-block"><h2>历史属性与资源</h2>
      {historicalDisplay ? <>
        <p>来源记录更新于 {displayTime(historicalDisplay.sourceUpdatedAt) ?? "时间待核"} · 租赁模式：{({ ordinary: "普通", custom: "定制", fast: "极速" } as Record<string, string>)[historicalDisplay.rentalMode ?? ""] ?? "待核"}</p>
        <dl className="order-facts">{historicalConditions.map(item => <div key={item.key}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
        {Object.values(historicalDisplay.attributes).some(value => value === null) ? <p role="status">部分历史属性未提供或尚待核实。</p> : null}
        <ul>{historicalDisplay.resources.map(item => <li key={item.code}>{item.name}：{historicalQuantityText(item.quantity, item.unit)}</li>)}</ul>
        <p>以上为历史显示记录，不替代当前资料申报、报价或可租资格。</p>
      </> : <p role={historical.display?.state === "KNOWN" ? "alert" : "status"}>{historical.display?.state === "KNOWN" ? "历史扩展资料返回不完整，请重试读取。" : "历史扩展资料尚未接入，不能据此认定资源数量为零。"}</p>}
    </section> : null}
    {/* 冲突/阻塞/退回：有则显示，无则不占位；#blockers 是列表「查看退回原因」的唯一锚点。 */}
    {latest || blockers.length || reasons.length ? <div className="supply-blockers-group" id="blockers" tabIndex={-1} ref={blockersRef}>
      {latest ? <div className="supply-conflict"><strong>资料状态已变化</strong><p>当前状态：{latest.version ? stateLabel(latest.version.reviewState) : "未创建草稿"}。</p><div className="supply-inline-actions"><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onRefresh}>重新读取</button><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onAdopt}>采用最新状态</button></div></div> : null}
      {blockers.length ? <div className="supply-blockers" role="alert"><strong>当前限制</strong>{blockers.map((code) => <p key={code}>{blockerText(code)}{code === "STAFF_RESTRICTED" && account.restriction_reason ? <span className="supply-blocker-reason">{account.restriction_reason}</span> : null}</p>)}</div> : null}
      {reasons.length ? <div className="supply-decisions"><h3>退回原因</h3>{reasons.map((decision) => <p key={decision.id}>{decision.reason}</p>)}</div> : null}
    </div> : null}

    <div className="supply-detail-body">
      <div className="supply-detail-main">
        {/* Spec block: one region of label-over-value rows, no per-item boxes. */}
        {conditions.length ? <section className="supply-block">
          <h2 className="supply-block-title">账号配置</h2>
          <dl className="supply-spec-list">{conditions.map((row) => {
            const Icon = CONDITION_ICONS[row.key] ?? null;
            return <div key={row.key}><dt>{Icon ? <Icon size={17} aria-hidden="true" /> : null}{row.label}</dt><dd>{row.value}</dd></div>;
          })}</dl>
        </section> : null}

        <section className="supply-block">
          <div className="supply-block-head">
            <h2 className="supply-block-title">公开图片</h2>
            <span className="supply-block-note">{galleryMedia.length ? `号主提供 ${galleryMedia.length} 张` : ""}</span>
          </div>
          {galleryMedia.length ? <>
            {galleryMedia.slice(0, 1).map((item) => <AccountMedia key={item.assetId} assetId={item.assetId} alt="公开展示图" className="supply-media-hero" />)}
            {galleryMedia.length > 1 ? <ul className="supply-media-thumbs">{galleryMedia.slice(1).map((item) => <li key={item.assetId}><AccountMedia assetId={item.assetId} alt="" className="supply-media-thumb" /></li>)}</ul> : null}
          </> : <p className="supply-block-empty">还没有公开展示图。</p>}
        </section>

        {/* Resources first, pricing second: what the account has is not the same question as how it is
            quoted. The detail table stays behind one disclosure. */}
        <section className="supply-block">
          <div className="supply-block-head">
            <h2 className="supply-block-title">账号资源</h2>
            <span className="supply-block-note">号主申报数量</span>
          </div>
          {resources.length ? <ul className="supply-resource-list">{resources.map((row, index) => <li key={`${row.name}-${index}`}><span>{row.name}</span><strong>{row.quantity ?? "未返回"} {row.unit}</strong></li>)}</ul> : <p className="supply-block-empty">尚未申报可展示的资源。</p>}
          {resources.length ? <details className="supply-inline-fold">
            <summary>查看报价明细</summary>
            <table className="supply-stock-table">
              <thead><tr><th scope="col">物资</th><th scope="col">数量</th><th scope="col">号主侧单价</th><th scope="col">号主侧费用</th></tr></thead>
              <tbody>{resources.map((row, index) => <tr key={`${row.name}-${index}`}>
                <th scope="row">{row.name}{row.unit ? <small>{row.unit}</small> : null}</th>
                <td>{row.quantity ?? "未返回"}</td>
                <td className={row.ownerUnit ? undefined : "supply-value-unknown"}>{row.ownerUnit ?? "未返回"}</td>
                <td className={row.ownerAmount ? undefined : "supply-value-unknown"}>{row.ownerAmount ?? "未返回"}</td>
              </tr>)}</tbody>
              {quote?.ownerTotal ? <tfoot><tr><th scope="row" colSpan={3}>发布报价合计</th><td>{moneyText(quote.ownerTotal)}</td></tr></tfoot> : null}
            </table>
          </details> : null}
        </section>

        {declaration?.description ? <section className="supply-block">
          <h2 className="supply-block-title">公开说明</h2>
          <p className="supply-block-text">{declaration.description}</p>
        </section> : null}

        <details className="supply-block supply-block--fold">
          <summary><strong>皮肤与权益</strong><span>{skins.length} 项皮肤 · {entitlements.length} 项权益</span><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="supply-fold-body">
            {skins.length ? <ul className="supply-skin-list">{skins.map((skin, index) => <li key={`${skin.id}-${index}`}><SkinMediaThumb mediaId={skin.mediaId ?? null} className="supply-skin-thumb" fallbackClassName="supply-skin-thumb is-empty" iconSize={16} /><span>{skin.ownerName || skin.name}</span>{skin.categoryName ? <small>{skin.categoryName}</small> : null}</li>)}</ul> : null}
            {entitlements.length ? <ul className="supply-entitlement-list">{entitlements.map((entry, index) => <li key={`${entry.name}-${index}`}><strong>{entry.name}</strong><span>{entry.term}</span></li>)}</ul> : null}
            {!skins.length && !entitlements.length ? <p className="supply-block-empty">还没有申报皮肤或权益。</p> : null}
          </div>
        </details>

        {penaltyMedia.length ? <details className="supply-block supply-block--fold">
          <summary><strong>处罚公示资料</strong><span>{penaltyMedia.length} 张</span><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="supply-fold-body"><ul className="supply-media-thumbs">{penaltyMedia.map((item) => <li key={item.assetId}><AccountMedia assetId={item.assetId} alt="" className="supply-media-thumb" /></li>)}</ul></div>
        </details> : null}

        {evidenceMedia.length ? <details className="supply-block supply-block--fold">
          <summary><strong>审核资料</strong><span>{evidenceMedia.length} 张 · 仅本人及审核人员可见</span><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="supply-fold-body"><ul className="supply-media-thumbs">{evidenceMedia.map((item) => <li key={item.assetId}><AccountMedia assetId={item.assetId} alt="" className="supply-media-thumb" /></li>)}</ul></div>
        </details> : null}

        {/* 资料修改记录（D-d）：只读折叠，仅版本序号/审核状态/北京时间/标题，不输出内部 ID、不提供回滚或切换。 */}
        {history.length ? <details className="supply-block supply-block--fold">
          <summary><strong>资料修改记录</strong><span>{history.length} 条 · 只读</span><ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="supply-fold-body">
            <ul className="supply-history-list">{history.map((entry, index) => {
              const editedAt = displayTime(entry.created_at);
              return <li key={`${entry.sequence ?? "x"}-${index}`}>
                {entry.sequence ? <span className="supply-history-seq">版本 {entry.sequence}</span> : null}
                <span className="order-status" data-state={REVIEW_TONE[entry.review_state ?? ""] ?? "unknown"}>{stateLabel(entry.review_state)}</span>
                <span className="supply-history-title">{entry.title ?? "未命名草稿"}</span>
                {editedAt ? <time dateTime={entry.created_at ?? undefined}>{editedAt}</time> : null}
              </li>;
            })}</ul>
            <p className="supply-block-empty">仅显示版本号、审核状态、标题与修改时间；修改资料请使用上方「修改账号资料」。</p>
          </div>
        </details> : null}
      </div>

      {/* The rail owns one job: the current publish terms, and the way back into this account's orders. */}
      <aside className="supply-detail-rail">
        <section className="supply-block">
          <h2 className="supply-block-title">当前发布条件</h2>
          <dl className="supply-fee-list">
            <div><dt>当前发布报价（号主侧）</dt><dd className="supply-fee-main">{moneyText(quote?.ownerTotal)}</dd></div>
            <div><dt>计费方式</dt><dd>{quote?.termSeconds ? termLabel(quote.termSeconds) : "未提供"}{quote?.rentalMode ? ` · ${({ ordinary: "普通出租", custom: "自定义出租", fast: "极速出租" } as Record<string, string>)[quote.rentalMode] ?? quote.rentalMode}` : ""}</dd></div>
            {/* 保证金两个时点：本行只报报价记录，当前责任另起一块，不合并成一个金额。 */}
            <div><dt>号主发布保证金（报价记录）</dt><dd className={quote?.publisherBailRequirement ? undefined : "is-unavailable"}>{quote?.publisherBailRequirement ? `¥${quote.publisherBailRequirement.amount} 元` : "本报报价未提供保证金金额"}<small>报价为发布时点记录，不代表当前责任</small></dd></div>
          </dl>
          {/* 详情不新增信用接口读取（同一页面两份口径）：只做静态说明与跳转。 */}
          <div className="supply-current-duty">
            <strong>当前保证金责任</strong>
            <p>当前应缴与实缴状态以「信用与保证金」中的本账号上下文为准。</p>
            <Link href={`/account?view=credit&accountId=${encodeURIComponent(account.id)}`} className="account-inline-link supply-duty-link" scroll={false}>查看当前责任<ChevronRight size={15} aria-hidden="true" /></Link>
          </div>
          <p className="account-module-note">报价与保证金是账号资料，不代表订单收入或资金到账。</p>
          <div className="account-record-links"><Link href={`/account?view=leased&accountId=${encodeURIComponent(account.id)}`} className="account-inline-link supply-rail-link" scroll={false}>查看该账号的出租订单<ChevronRight size={15} aria-hidden="true" /></Link></div>
        </section>
      </aside>
    </div>
  </div>;
}
