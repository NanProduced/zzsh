"use client";

import Link from "next/link";
import { publishUserSessionChange, useUserSession, useUserSessionStore } from "./session/user-session-provider";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Box, Check, ChevronDown, ChevronRight, ClipboardList, Clock3, Copy, CreditCard, Crosshair, Dumbbell, FileText, Gem, HelpCircle, House, ImageOff, Images, Info, LockKeyhole, LogIn, Package, Pause, Pencil, Play, ReceiptText, RefreshCw, Shield, ShieldCheck, Shirt, SlidersHorizontal, Sparkles, Undo2, UserRound, Waves, X } from "lucide-react";
import { ServiceShell } from "./layout/service-shell";
import { SessionLoading } from "./auth/session-loading";
import { RecoveryAlert } from "./ui/information";
import { WebAuthError, webAuthRequest } from "./auth/auth-form";
import { StatusPage } from "@/components/status/status-page";
import { accountStatusLabel, cancellationFailureMessage, identityStatusLabel, type UserIdentitySnapshot } from "@/app/user-account-status";
import { SkinMediaPreview, SkinMetadata, skinCardTitle } from "./supply/skin-media-thumb";
import { FavoritesPanel } from "./favorites/favorites-panel";
import { FavoritesProvider } from "./favorites/favorites-context";
import { LegacyOrderWorkspace } from "./order/legacy-order-workspace";
import { OrderWorkspace } from "./order/order-workspace";
import { orderUrl } from "../lib/order-client";
import { AccountCenterFrame, AccountMembershipCenter, AccountOverview, accountSectionHref, accountViewTitle, isKnownAccountView, resolveAccountView } from "./account/account-center";
import { PersonalWallet } from "./account/personal-wallet";
import { PersonalInvitations } from "./account/personal-invitations";
import { IdentityVerificationForm } from "./account/identity-verification-form";
import { CreditCenter } from "./account/credit-center";
import { AccountSecurityControls, type SecurityNicknameDraft, type SecurityPendingWrite } from "./account/account-security-controls";
import { ConfirmAlertDialog } from "./ui/alert-dialog";
import { LegacyAccountImage } from "@zzsh/ui/legacy-account-image";
import { formatReferenceYuan } from "@zzsh/ui/display-money";
import { AccountMediaPlaceholder } from "@zzsh/ui/account-media-placeholder";
import { CONDITION_LABELS, booleanDeclarationText, conditionLines, haffMillionsLabel, skinTypeLabel, termLabel, unitLabel, toListingDetail, type ResourceLine } from "../lib/listing-view";
import { deriveAccountTitle } from "../lib/account-title";
import { supplyApi, SupplyRequestError, supplyBlockerMessages, uncertainSupplyWriteFailure } from "../lib/supply-client";
import { loadSupplyIntent, prepareSupplyIntent, acceptSupplyIntent, retainUncertainSupplyIntent, clearSupplyIntent, sameSupplyIntent, SupplyIntentStorageError, type SupplyWriteIntent } from "../lib/supply-write-intent";
import { IdentityPauseGate, isCurrentQuery, mergePageById } from "../lib/supply-workspace-guards";
import type { MyAccountRow, MySupply, RentalState } from "../lib/supply-types";
// 出租账号列表的 A2 收敛样式（状态分列 · 已加载筛选 chips · 往返恢复）；详情继续沿用 supply-* 规则。
import "./account/my-rental-accounts.css";

type SessionId = string | null | undefined;
type IdentityState = "checking" | "confirmed" | "failed";
type RequestContext = { epoch: number; identity: SessionId; accountId?: string; gameId: string };
type RetryTask = { context: RequestContext; busy: string; run: () => Promise<void> };

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m3d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function AccountCopyInline({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mra-copy-btn"
      title="复制账号编号"
      aria-label={copied ? "已复制账号编号" : "复制账号编号"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
    </button>
  );
}
function moneyText(money: { amount: string } | null | undefined): string {
  return money ? `${money.amount} 元` : "待确认";
}

/** Unit prices arrive at eight decimals; show the readable figure next to the quantity it is quoted per. */
function unitPriceText(money: { amount: string } | null | undefined, unitQuantity: string | undefined, unit: string): string {
  if (!money) return "未返回";
  const price = formatReferenceYuan(money.amount);
  return price ? `${price} / ${unitQuantity && unitQuantity !== "1" ? `${unitQuantity} ` : ""}${unit}`.trim() : "未返回";
}

function stateLabel(state: string | null | undefined): string {
  return ({ DRAFT: "草稿", SUBMITTED: "审核中", WITHDRAWN: "已撤回", REJECTED: "已退回", APPROVED: "已通过", PUBLISHED: "已上架", IMPORTED_UNVERIFIED: "待复核" } as Record<string, string>)[state ?? ""] ?? "未确认";
}

/** 列表一页的读取条数；短于它即证明服务端已无下一页，可显示「已加载全部」。 */
const LIST_PAGE_SIZE = 50;

type AccountStateFilter = RentalState | "ALL";
/** 每个状态使用服务端筛选和独立游标；全部不传状态。 */
const ACCOUNT_STATE_FILTERS: ReadonlyArray<{ value: AccountStateFilter; label: string }> = [
  { value: "ALL", label: "全部" },
  { value: "LISTED", label: "可出租" },
  { value: "PENDING_PAYMENT", label: "待付款占用" },
  { value: "RENTED", label: "租赁中" },
  { value: "PAUSED", label: "已暂停" },
  { value: "COMPLETED", label: "已完成" },
  { value: "REVIEWING", label: "审核中" },
  { value: "DRAFT", label: "待完善" },
  { value: "REJECTED", label: "已退回" },
  { value: "RESTRICTED", label: "已限制" },
  { value: "UNKNOWN", label: "待核实" },
];
const RENTAL_STATE_LABELS: Record<RentalState, string> = {
  RENTED: "已有订单",
  PENDING_PAYMENT: "待付款占用",
  LISTED: "可出租",
  PAUSED: "已暂停",
  REVIEWING: "审核中",
  DRAFT: "待完善",
  REJECTED: "已退回",
  RESTRICTED: "已限制",
  COMPLETED: "已完成",
  UNKNOWN: "待核实",
};
const ACCOUNT_MODE_LABELS: Record<string, string> = { ordinary: "普通出租", custom: "自定义出租", fast: "极速出租" };
const RENTAL_STATE_TONE: Record<RentalState, string> = {
  RENTED: "success",
  PENDING_PAYMENT: "warning",
  LISTED: "info",
  PAUSED: "warning",
  REVIEWING: "info",
  DRAFT: "unknown",
  REJECTED: "error",
  RESTRICTED: "error",
  COMPLETED: "unknown",
  UNKNOWN: "unknown",
};

/** 资料状态徽章语义色：未知枚举一律「未确认」灰态，不靠颜色单独表意（徽章始终带文字）。 */
const REVIEW_BADGE_TONE: Record<string, string | undefined> = {
  DRAFT: undefined, SUBMITTED: "info", WITHDRAWN: undefined, REJECTED: "error",
  APPROVED: "success", PUBLISHED: "success", IMPORTED_UNVERIFIED: "unknown",
};

function blockerText(code: string): string {
  return supplyBlockerMessages[code] ?? "当前资料暂不能继续，请读取最新状态或稍后重试。";
}

type AccountRow = MyAccountRow;
function haffArchiveLabel(raw: string | null | undefined): string | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value === 0n) return null;
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${fraction ? `${whole}.${fraction}` : whole.toString()} M 哈夫币`;
}
/** Only historical display facts become this read-only summary; title/price/availability are never inferred from it. */
function accountTitleFromFacts(row: AccountRow): string | null {
  const facts = row.accountDisplay?.titleFacts;
  if (!facts) return null;
  const resourceLines: ResourceLine[] = facts.haffBase ? [{
    itemId: "haff", code: "df_billable_haff", name: "哈夫币", quantity: facts.haffBase, quantityLabel: facts.haffBase, unitLabel: "哈夫币", costAmount: null, costLabel: null, unitPriceLabel: null,
  }] : [];
  const conditionLines = [
    facts.safeBox?.displayName ? { key: "safe_box_code", label: "安全箱", value: facts.safeBox.displayName } : null,
    facts.rank?.displayName ? { key: "grading_code", label: "段位", value: facts.rank.displayName } : null,
    facts.level !== null ? { key: "character_level", label: "角色等级", value: `${facts.level} 级` } : null,
    facts.vitLevel !== null ? { key: "vit_level", label: "体力", value: `${facts.vitLevel} 级` } : null,
    facts.bearLevel !== null ? { key: "bear_level", label: "负重", value: `${facts.bearLevel} 级` } : null,
  ].filter((line): line is { key: string; label: string; value: string } => Boolean(line));
  const derived = deriveAccountTitle({ resourceLines, conditionLines });
  return derived.primary && derived.primary !== "游戏账号" ? derived.primary : null;
}

function accountActiveOrderText(row: AccountRow): string | null {
  const order = row.activeOrder;
  if (!order) return null;
  if (order.status === "PENDING_PAYMENT") return "待付款";
  if (order.origin === "LEGACY") return "查看订单进度和租期";
  // shortcut: older readers project payment as opening; show a deadline after confirmed-opening provenance is versioned.
  const amount = order.ownerAmount ? `下单时的出租报价 ${moneyText(order.ownerAmount)}` : "出租报价待确认";
  return [`租客 ${order.renterName ?? "待确认"}`, "开租时间请查看订单", amount].join(" · ");
}

function accountFilter(mode: "listed" | "rented", value?: string): AccountStateFilter {
  return ACCOUNT_STATE_FILTERS.find(item => item.value === value)?.value ?? (mode === "rented" ? "RENTED" : "ALL");
}

function accountListHref(mode: "listed" | "rented", filter: AccountStateFilter, accountId?: string): string {
  const query = new URLSearchParams({ view: mode === "rented" ? "rented" : "accounts" });
  if (filter !== (mode === "rented" ? "RENTED" : "ALL")) query.set("status", filter);
  if (accountId) query.set("accountId", accountId);
  return `/account?${query}`;
}

function historicalAccountSummary(row: AccountRow): { title: string; sub: string } | null {
  const display = row.historicalRead?.display;
  if (display?.state !== "KNOWN") return null;
  const facts = display.facts;
  const haff = facts.resources?.find((resource) => resource.unit === "HAFF_BASE");
  const headline = [haffArchiveLabel(haff?.quantity), facts.attributeDisplay?.grading?.displayName, facts.attributeDisplay?.safeBox?.displayName].filter((part): part is string => Boolean(part));
  const meta = [row.display_no ? `账号 ${row.display_no}` : null, facts.attributeDisplay?.serviceWindow?.displayName, facts.attributeDisplay?.loginMethod?.displayName].filter((part): part is string => Boolean(part));
  return { title: headline.length ? headline.join(" · ") : "出租账号", sub: meta.join(" · ") };
}
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

export function AccountWorkspace({ view, accountId, orderId, status, source, page, orderNo, createdFrom, createdTo, stage }: { view: string; accountId?: string; orderId?: string; status?: string; source?: string; page?: string; orderNo?: string; createdFrom?: string; createdTo?: string; stage?: string }) {
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
      {!isKnownAccountView(view) ? <AccountUnsupported view={view} /> : active === "overview" ? <AccountOverview scope={identityScope} userId={session.userId ?? undefined} nicknameDraft={nicknameDraft} pendingWrite={pendingSecurityWrite} /> : active === "membership" ? <AccountMembershipCenter scope={identityScope} /> : active === "credit" ? <CreditCenter scope={identityScope} /> : active === "wallet" ? <PersonalWallet scope={identityScope} /> : active === "invite" ? <PersonalInvitations scope={identityScope} /> : active === "accounts" ? <MyAccountsPanel key="listed" mode="listed" accountId={accountId} filterParam={status} /> : active === "rented" ? <MyAccountsPanel key="rented" mode="rented" accountId={accountId} filterParam={status} /> : active === "security" ? <AccountSecurityPanel pendingWrite={pendingSecurityWrite} /> : active === "identity" ? <AccountIdentityPanel /> : active === "favorites" ? <FavoritesProvider><FavoritesPanel /></FavoritesProvider> : active === "rentals" || active === "leased" ? <OrderWorkspace party={active === "rentals" ? "renter" : "owner"} orderId={orderId} status={status} accountId={accountId} source={source} filters={{orderNo,createdFrom,createdTo,stage}} /> : null}
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

function MyAccountsPanel({ mode, accountId: accountIdProp, filterParam }: { mode: "listed" | "rented"; accountId?: string; filterParam?: string }) {
  const router = useRouter();
  const sharedSession = useUserSessionStore();
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [detail, setDetail] = useState<MySupply | null>(null);
  const [latest, setLatest] = useState<MySupply | null>(null);
  const [identityState, setIdentityState] = useState<IdentityState>("checking");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [nextPageCursor, setNextPageCursor] = useState<string | null>(null);
  const [lastPageSize, setLastPageSize] = useState<number | null>(null);
  const defaultState = accountFilter(mode, filterParam);
  const [stateFilter, setStateFilter] = useState<AccountStateFilter>(defaultState);
  const [moreFilters, setMoreFilters] = useState(false);
  const stateFilterRef = useRef(stateFilter), defaultStateRef = useRef(defaultState);
  stateFilterRef.current = stateFilter; defaultStateRef.current = defaultState;
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
  const storedIntentRef = useRef<SupplyWriteIntent | null>(null);
  const [storedIntent, setStoredIntent] = useState<SupplyWriteIntent | null>(null);
  const [intentStorageIssue, setIntentStorageIssue] = useState("");
  const lastRetry = useRef<RetryTask | null>(null);
  const accountRef = useRef(accountIdProp);
  const routeAccountRef = useRef(accountIdProp);
  const listRequestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const nextPageCursorRef = useRef<string | null>(null);
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

  const restoreStoredIntent = useCallback((userId: string) => {
    try {
      const record = loadSupplyIntent(userId);
      storedIntentRef.current = record; setStoredIntent(record); setIntentStorageIssue("");
    } catch {
      setIntentStorageIssue("原操作记录暂时无法读取，已阻止新操作；请保持本页并重试。");
    }
  }, []);
  const invalidateContext = useCallback((message: string, requireAuth: boolean) => {
    epoch.current += 1;
    identityPauseGate.current.cancelWaiters();
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    storedIntentRef.current = null; setStoredIntent(null); setIntentStorageIssue("");
    lastRetry.current = null;
    accountRef.current = undefined;
    listReadyRef.current = false;
    listPositionRef.current = null;
    listScrollRef.current = 0;
    setRows([]);
    setDetail(null);
    setLatest(null);
    setNextCursor(null);
    nextCursorRef.current = null;
    setNextPageCursor(null);
    nextPageCursorRef.current = null;
    setLastPageSize(null);
    stateFilterRef.current = defaultStateRef.current; setStateFilter(defaultStateRef.current);
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
      if (accountIdProp) router.replace(mode === "rented" ? "/account?view=rented" : "/account?view=accounts");
    }
    identityPauseGate.current.markConfirmed();
    if (next) restoreStoredIntent(next);
    setAuthRequired(!next);
    setIdentityPhase("confirmed");
    return !(previous !== undefined && previous !== next && accountIdProp);
  }, [sharedSession, invalidateContext, router, accountIdProp, restoreStoredIntent]);
  // 撤销私有事实：身份变化走 invalidateContext（整体清空）；详情读取 401/403/404 只撤详情，
  // 已加载列表、游标与筛选按 F2 保留，避免「开/换详情」把列表一起打掉。
  const revokeDetail = useCallback(() => { setDetail(null); setLatest(null); }, []);
  // Preserve list position and pagination, but never restore facts superseded by a confirmed detail.
  const updateListFromDetail = useCallback((next: MySupply) => {
    // Recovery can refresh another loaded row after its identity and original target were checked.
    if (!next.account) return;
    setRows((previous) => previous.map((row) => row.id === next.account.id ? {
      ...row,
      title: next.version ? next.version.declaration?.title ?? row.title : null,
      sequence: next.version ? next.version.sequence ?? row.sequence : null,
      review_state: next.version?.reviewState ?? null,
      owner_paused: next.account.owner_paused,
      staff_restricted: next.account.staff_restricted,
      historicalRead: next.historicalRead === undefined ? row.historicalRead : next.historicalRead,
      display_no: next.account.display_no ?? null,
    } : row));
  }, []);
  const revokeList = useCallback(() => {
    setRows([]);
    setNextCursor(null);
    nextCursorRef.current = null;
    setNextPageCursor(null);
    nextPageCursorRef.current = null;
    listReadyRef.current = false;
    setLastPageSize(null);
    stateFilterRef.current = defaultStateRef.current; setStateFilter(defaultStateRef.current);
  }, []);
  const load = useCallback(async (requestedId?: string, append = false, page?: { cursor?: string; after?: string }, stateOverride?: AccountStateFilter) => {
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
    const requestState = stateOverride ?? stateFilterRef.current;
    const pageToken = append ? (page?.cursor ? { cursor: page.cursor } : page?.after ? { after: page.after } : nextPageCursorRef.current ? { cursor: nextPageCursorRef.current } : nextCursorRef.current ? { after: nextCursorRef.current } : undefined) : undefined;
    const request = { id: requestId, key: JSON.stringify({ accountId: id ?? "", append, state: requestState, cursor: pageToken?.cursor ?? pageToken?.after ?? "" }) };
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
        if (requestState !== "ALL") params.set("rentalState", requestState);
        if (pageToken?.cursor) params.set("cursor", pageToken.cursor);
        else if (pageToken?.after) params.set("after", pageToken.after);
        const page = await supplyApi.myAccounts(params, controller.signal);
        if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
        lastRetry.current = null;
        setRows((previous) => {
          if (!append) return page.items;
          return mergePageById(previous, page.items);
        });
        setNextCursor(page.nextCursor);
        nextCursorRef.current = page.nextCursor;
        setNextPageCursor(page.nextPageCursor ?? null);
        nextPageCursorRef.current = page.nextPageCursor ?? null;
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
      if (append && nextError.status === 409) {
        listReadyRef.current = false;
        lastRetry.current = null;
        void load(id, false, undefined, requestState);
        return;
      }
      setError(nextError);
      setErrorScope(phase);
      // 身份失效撤全部旧私有事实；403/404：详情读取只撤详情，列表读取才撤列表（F2 往返不清列表）。
      if (nextError.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
      else if (nextError.status === 403 || nextError.status === 404) { if (phase === "detail") revokeDetail(); else revokeList(); }
      if (nextError.status === 0) lastRetry.current = { context, busy: append ? "accounts-more" : "accounts", run: () => load(id, append, page, requestState) };
    } finally {
      if (currentContext({ ...context, epoch: requestEpoch }, controller.signal) && isCurrent()) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
      finishRequest(controller);
    }
  }, [currentContext, waitForIdentity, revokeList, revokeDetail, updateListFromDetail]);
  useEffect(() => {
    const next = accountFilter(mode, filterParam);
    if (next === stateFilterRef.current) return;
    listReadyRef.current = false;
    setRows([]);
    setNextCursor(null);
    nextCursorRef.current = null;
    setNextPageCursor(null);
    nextPageCursorRef.current = null;
    setLastPageSize(null);
    setError(null);
    stateFilterRef.current = next; setStateFilter(next);
    void load(accountIdProp, false, undefined, next);
  // The URL is the source for browser back/forward and detail reloads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, filterParam]);
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
      lastRetry.current = null;
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
  const finishActionResult = (record: SupplyWriteIntent, next: MySupply, context: RequestContext, message: string) => {
    if (next.account?.id !== record.accountId || next.account.game_id !== record.gameId) throw new SupplyRequestError(502, null, record.key);
    if (record.receipt?.revision && (!/^[1-9]\d*$/.test(next.account.revision) || BigInt(next.account.revision) < BigInt(record.receipt.revision))) throw new SupplyRequestError(502, null, record.key);
    if (!currentContext(context) || !sameSupplyIntent(storedIntentRef.current, record)) return;
    if (!clearSupplyIntent(record)) throw new SupplyIntentStorageError();
    storedIntentRef.current = null; setStoredIntent(null); setIntentStorageIssue("");
    if (accountRef.current === record.accountId) { setDetail(next); setLatest(null); }
    updateListFromDetail(next);
    setNotice(message); lastRetry.current = null;
  };
  const executeAction = async (record: SupplyWriteIntent, context: RequestContext): Promise<void> => {
    if (!(await waitForIdentity(context))) return;
    const controller = beginRequest();
    try {
      const { action, body, key } = record;
      const next = action === "withdraw"
        ? await supplyApi.withdraw(record.accountId!, String(body.expectedRevision), String(body.versionId), key, undefined, controller.signal)
        : await supplyApi.setPaused(record.accountId!, action === "pause", String(body.expectedRevision), key, undefined, controller.signal);
      if (next.account?.id !== record.accountId || next.account.game_id !== record.gameId || typeof next.account.revision !== "string") throw new SupplyRequestError(502, null, key);
      // A late successful response still updates its original durable responsibility.
      const accepted = acceptSupplyIntent(record, { accountId: next.account.id, revision: next.account.revision, ...(next.version ? { versionId: next.version.id } : {}) });
      if (!currentContext(context, controller.signal) || !sameSupplyIntent(storedIntentRef.current, record)) return;
      storedIntentRef.current = accepted; setStoredIntent(accepted);
      finishActionResult(accepted, next, context, action === "withdraw" ? "已撤回当前审核版本；修改请创建新草稿。" : action === "pause" ? "已下架并停止接单，已获准公开的详情仍可查看。" : "已恢复接单，资格检查已完成。");
    } catch (failure) {
      try {
        const persisted = loadSupplyIntent(record.userId);
        if (sameSupplyIntent(persisted, record) && persisted?.phase === "pending") {
          if (uncertainSupplyWriteFailure(failure) || persisted.uncertain) {
            const retained = retainUncertainSupplyIntent(record);
            if (currentContext(context)) { storedIntentRef.current = retained; setStoredIntent(retained); }
          } else if (clearSupplyIntent(record) && currentContext(context)) { storedIntentRef.current = null; setStoredIntent(null); }
        }
      } catch {
        if (currentContext(context)) setIntentStorageIssue("原操作记录暂不可更新，已阻止新操作；请保持本页并重试恢复。");
      }
      if (currentContext(context, controller.signal)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        setErrorScope("action");
        if (nextError.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
        if (nextError.status === 409) void reloadDetail(false);
      }
    } finally {
      if (currentContext(context, controller.signal)) setBusy("");
      finishRequest(controller);
    }
  };
  const runAction = async (action: "withdraw" | "pause" | "resume") => {
    if (identityStatusRef.current !== "confirmed" || !identity.current || !detail?.version || busy || intentStorageIssue) return;
    const id = detail.account.id;
    const context = captureContext(id);
    try {
      const previous = loadSupplyIntent(identity.current);
      if (previous) { storedIntentRef.current = previous; setStoredIntent(previous); return; }
      if (!detail.account.game_id) throw new SupplyIntentStorageError();
      const body = { expectedRevision: detail.account.revision, ...(action === "withdraw" ? { versionId: detail.version.id } : {}) };
      const record = prepareSupplyIntent({ userId: identity.current, gameId: detail.account.game_id, accountId: id, action, body, key: newKey() });
      storedIntentRef.current = record; setStoredIntent(record);
      setBusy(action); setError(null);
      await executeAction(record, context);
    } catch {
      setIntentStorageIssue("无法保留原操作记录，暂不能提交；请保持本页并重试。");
    }
  };
  const recoverAction = async () => {
    const original = storedIntentRef.current;
    if (!original || !original.accountId || identity.current !== original.userId || identityStatusRef.current !== "confirmed" || busy
      || !["pause", "resume", "withdraw"].includes(original.action)) return;
    const context = captureContext(), controller = beginRequest();
    setBusy("recover"); setError(null);
    try {
      const record = loadSupplyIntent(original.userId);
      if (!record || !sameSupplyIntent(record, original)) throw new SupplyIntentStorageError();
      if (!(await waitForIdentity(context))) return;
      const receipt = await supplyApi.operationResult(record.action as "pause" | "resume" | "withdraw", record.accountId!, record.body, record.key, controller.signal);
      if (!currentContext(context, controller.signal) || !sameSupplyIntent(storedIntentRef.current, record)) return;
      if (receipt.receipt === "UNRESOLVED") { setNotice("尚未查到原操作回执；结果仍待确认，不会重新发送或据当前状态推断成功。"); return; }
      if (receipt.operation !== `supply.publication.${record.action}` || receipt.resourceId !== record.accountId || receipt.responseStatus !== 200
        || receipt.result?.accountId !== record.accountId || !/^[1-9]\d*$/.test(receipt.result.revision)) throw new SupplyRequestError(502, null, record.key);
      const accepted = acceptSupplyIntent(record, receipt.result);
      storedIntentRef.current = accepted; setStoredIntent(accepted);
      const next = await supplyApi.mine(record.accountId!, controller.signal);
      if (!currentContext(context, controller.signal) || !(await waitForIdentity(context))) return;
      finishActionResult(accepted, next, context, "已核实原操作成功，并读取当前账号资料；可以继续操作。");
    } catch (failure) {
      if (!currentContext(context, controller.signal)) return;
      if (failure instanceof SupplyIntentStorageError) setIntentStorageIssue("原操作记录暂不可读取或更新；请保持本页并重试恢复。");
      setError(failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null));
      setErrorScope("action");
      // A recovery failure or fingerprint conflict never resolves the original write.
      if (failure instanceof SupplyRequestError && failure.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
    } finally {
      if (currentContext(context, controller.signal)) setBusy("");
      finishRequest(controller);
    }
  };
  const retryLast = async () => {
    const task = lastRetry.current;
    if (!task || !currentContext(task.context)) {
      lastRetry.current = null;
      return;
    }
    lastRetry.current = null;
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
  const pageTitle = "我的账号";
  const pageDescription = "查看账号资料、订单占用与上架进度。";
  const pageHref = accountListHref(mode, stateFilter);
  const heading = <header className="account-module-heading"><div><h2>{pageTitle}</h2><p>{pageDescription}</p></div><div className="mra-heading-actions"><button type="button" className="button quiet" disabled={loading || busy !== ""} onClick={() => { listReadyRef.current = false; void load(accountIdProp); }}><RefreshCw size={15} aria-hidden="true" />{loading ? "刷新中…" : "刷新"}</button>{rows.length > 0 && !accountIdProp ? <Link href="/publish" className="button primary">发布新账号</Link> : null}</div></header>;
  if (identityState === "checking") return <section className="account-module">{heading}<div className="account-module-card account-empty-state" aria-busy="true" role="status"><LockKeyhole size={28} aria-hidden="true" /><h3>正在确认登录身份</h3><p>请稍候，确认后读取出租账号。</p></div></section>;
  if (identityState === "failed") return <section className="account-module">{heading}<div className="account-module-card account-empty-state" role="alert"><LockKeyhole size={28} aria-hidden="true" /><h3>登录身份暂时无法确认</h3><p>重新确认后可以继续查看账号资料。</p><button type="button" className="button secondary" onClick={() => void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); })}>重试</button></div></section>;
  const visibleRows = rows;
  const hasMore = Boolean(nextPageCursor ?? nextCursor);
  // 短页且两种游标都为空才敢说「已加载全部」；无 total 合同，绝不写「共 N 个」。
  const allLoaded = !hasMore && lastPageSize !== null && lastPageSize < LIST_PAGE_SIZE;
  const changeStateFilter = (next: AccountStateFilter) => {
    if (next === stateFilter) return;
    listReadyRef.current = false;
    lastRetry.current = null;
    stateFilterRef.current = next; setStateFilter(next);
    setRows([]);
    setNextCursor(null);
    nextCursorRef.current = null;
    setNextPageCursor(null);
    nextPageCursorRef.current = null;
    setLastPageSize(null);
    setError(null);
    router.replace(accountListHref(mode, next), { scroll: false });
    void load(accountIdProp, false, undefined, next);
  };
  return <section className="my-accounts-panel account-module">
    {accountIdProp ? null : heading}
    <AccountActionError error={error} scope={errorScope} onRetry={error?.status === 0 && !storedIntent ? () => void retryLast() : undefined} />
    {intentStorageIssue ? <div className="supply-notice is-error" role="alert"><AlertCircle size={17} /><span>{intentStorageIssue}</span><button type="button" className="button quiet" disabled={Boolean(busy)} onClick={() => { if (identity.current) restoreStoredIntent(identity.current); }}>重试读取操作记录</button></div> : null}
    {storedIntent ? <div className="supply-notice" role="status"><Clock3 size={17} /><span>有一笔原操作结果待恢复，请先核对后继续，当前账号状态不能证明原操作结果。</span>{["pause", "resume", "withdraw"].includes(storedIntent.action)
      ? <button type="button" className="button secondary button--sm" disabled={Boolean(busy)} onClick={() => void recoverAction()}>{busy === "recover" ? "查询中…" : "查询原操作结果"}</button>
      : <Link className="button secondary button--sm" href="/publish">前往上架页面恢复</Link>}</div> : null}
    {notice ? <div className="supply-notice" role="status"><Check size={17} />{notice}</div> : null}
    {authRequired ? <div className="supply-auth-block"><LockKeyhole size={18} /><span>登录后才能查看账号。</span><Link className="button secondary" href={`/login?next=${encodeURIComponent(pageHref)}`}>登录 / 注册</Link></div> : accountIdProp ? <>
      <Link className="account-detail-back" href={pageHref} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回{pageTitle}</Link>
      {visibleDetail ? <AccountDetail detail={visibleDetail} gameName={rows.find((row) => row.id === visibleDetail.account.id)?.game_name ?? null} latest={latest} busy={busy} identityReady={identityState === "confirmed" && Boolean(identity.current) && !storedIntent && !intentStorageIssue} onAction={runAction} onRefresh={() => void reloadDetail(false)} onAdopt={() => void reloadDetail(true)} /> : <div className="account-module-card account-empty-state" aria-busy={loading ? true : undefined} role="status"><House size={28} aria-hidden="true" /><h3>{loading ? "正在读取账号资料" : "账号资料暂不可用"}</h3><p>{loading ? "请稍候。" : "请返回账号列表，或重试读取当前账号。"}</p></div>}
    </> : <>
      <div className="mra-toolbar">
        <span className="mra-count">已显示 {rows.length} 个</span>
        <div className="mra-filter-rail" role="group" aria-label="按账号状态筛选">
          {ACCOUNT_STATE_FILTERS.filter(chip => ["ALL", "LISTED", "RENTED", "REVIEWING"].includes(chip.value)).map(chip => <button key={chip.value} type="button" className="mra-chip" aria-pressed={stateFilter === chip.value} onClick={() => changeStateFilter(chip.value)}>{chip.label}</button>)}
          <button type="button" className="mra-chip mra-more-toggle" aria-expanded={moreFilters} aria-controls="account-more-filters" onClick={() => setMoreFilters(open => !open)}>更多状态{!["ALL", "LISTED", "RENTED", "REVIEWING"].includes(stateFilter) ? ` · ${RENTAL_STATE_LABELS[stateFilter as RentalState]}` : ""}<ChevronDown size={14} aria-hidden="true" /></button>
        </div>
        <div id="account-more-filters" className="mra-more-filters" role="group" aria-label="更多账号状态" hidden={!moreFilters}>{ACCOUNT_STATE_FILTERS.filter(chip => !["ALL", "LISTED", "RENTED", "REVIEWING"].includes(chip.value)).map(chip => <button key={chip.value} type="button" className="mra-chip" aria-pressed={stateFilter === chip.value} onClick={() => changeStateFilter(chip.value)}>{chip.label}</button>)}</div>
      </div>
      {loading && rows.length === 0 ? <div className="account-module-card account-empty-state" aria-busy="true" role="status"><House size={28} aria-hidden="true" /><h3>正在读取{pageTitle}</h3><p>请稍候。</p></div> : error && rows.length === 0 ? <div className="account-module-card account-empty-state" role="alert"><House size={28} aria-hidden="true" /><h3>{pageTitle}暂时无法读取</h3><p>{error.message || "请稍后重试。"}</p><button type="button" className="button secondary" onClick={() => void load(accountIdProp, false, undefined, stateFilter)}>重试读取</button></div> : rows.length === 0 ? (!loading && !error
        ? <div className="account-module-card account-empty-art-state" role="status">
          <img className="account-empty-art" src="/art/empty/account-prepare-r1.webp" alt="" width={240} height={180} loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />
          <h3>{stateFilter === "ALL" ? "还没有账号" : `当前没有${RENTAL_STATE_LABELS[stateFilter]}账号`}</h3>
          <p>{stateFilter === "ALL" ? "发布账号后，可以在这里查看资料和进度。" : "可以切换其他状态，查看你的账号。"}</p>
          <div className="account-empty-actions">{stateFilter === "ALL" ? <Link href="/publish" className="button primary">发布出租账号</Link> : <button type="button" className="button primary" onClick={() => changeStateFilter("ALL")}>查看全部账号</button>}</div>
        </div>
        : <div className="account-module-card account-empty-state" aria-busy="true" role="status"><House size={30} aria-hidden="true" /><h3>正在读取{pageTitle}</h3><p>请稍候。</p></div>) : <>
        <div className="supply-account-list account-module-card" aria-busy={loading || loadingMore}>
          <div className="mra-rows" role="list" aria-label={`${pageTitle}列表`}>
            {visibleRows.map((row) => {
              const historical = historicalAccountSummary(row);
              const factsTitle = accountTitleFromFacts(row);
              const displayNo = row.accountDisplay?.displayNo ?? row.display_no ?? null;
              const title = factsTitle ?? historical?.title ?? (displayNo ? `账号 ${displayNo}` : pageTitle);
              const activeText = accountActiveOrderText(row);
              const state = row.rentalState;
              const loginMethod = row.historicalRead?.display?.facts?.attributeDisplay?.loginMethod?.displayName;
              const serviceWindow = row.historicalRead?.display?.facts?.attributeDisplay?.serviceWindow?.displayName;
              return <div className="mra-row" role="listitem" key={row.id} data-account-row={row.id}>
                <Link className="mra-row-main" id={`account-row-title-${row.id}`} href={accountListHref(mode, stateFilter, row.id)} scroll={false}>
                  <div className="mra-row-top">
                    <span className="mra-game-tag">{row.game_name || "三角洲行动"}</span>
                    <strong className="mra-row-title">{title}</strong>
                  </div>
                  <div className="mra-row-meta">
                    {displayNo ? (
                      <span className="mra-meta-pill mra-no-pill">
                        <span>账号 {displayNo}</span>
                        <AccountCopyInline text={displayNo} />
                      </span>
                    ) : null}
                    {loginMethod ? (
                      <span className="mra-meta-pill">
                        <LogIn size={11} aria-hidden="true" />
                        <span>{loginMethod}</span>
                      </span>
                    ) : null}
                    {serviceWindow ? (
                      <span className="mra-meta-pill">
                        <Clock3 size={11} aria-hidden="true" />
                        <span>上号 {serviceWindow}</span>
                      </span>
                    ) : null}
                    {row.accountDisplay?.titleFacts && mode === "listed" ? <span className="mra-meta-pill">{[
                      row.accountDisplay.titleFacts.rentalMode ? ACCOUNT_MODE_LABELS[row.accountDisplay.titleFacts.rentalMode] ?? "出租模式待确认" : null,
                      row.accountDisplay.titleFacts.ownerQuoteTotal ? `发布报价 ${moneyText(row.accountDisplay.titleFacts.ownerQuoteTotal)}` : "发布报价待确认",
                    ].filter(Boolean).join(" · ")}</span> : null}
                    {activeText ? <span className="mra-meta-pill mra-row-order">{activeText}</span> : null}
                  </div>
                </Link>
                <div className="mra-row-state">
                  {row.activeOrder ? <Link className="mra-row-anchor" href={orderUrl("owner", "", row.id, row.activeOrder.id, row.activeOrder.origin)} scroll={false}>订单 {row.activeOrder.displayNo}</Link> : null}
                  {row.historicalReadOnly ? <span className="mra-badge" data-tone="unknown"><span className="mra-badge-dot" aria-hidden="true" />历史只读</span> : null}
                  {state ? <span className="mra-badge" data-tone={RENTAL_STATE_TONE[state]}><span className="mra-badge-dot" aria-hidden="true" />{state === "DRAFT" ? row.review_state === "WITHDRAWN" ? "已撤回" : row.review_state === "IMPORTED_UNVERIFIED" ? "历史资料待核" : row.review_state === "DRAFT" ? "草稿" : "资料待确认" : RENTAL_STATE_LABELS[state]}</span> : <span className="mra-badge" data-tone={row.review_state ? REVIEW_BADGE_TONE[row.review_state] ?? "unknown" : undefined}><span className="mra-badge-dot" aria-hidden="true" />{row.review_state ? stateLabel(row.review_state) : "资料待确认"}</span>}
                  {!row.historicalReadOnly && row.owner_paused && state !== "PAUSED" ? <span className="mra-badge" data-tone="warning"><span className="mra-badge-dot" aria-hidden="true" />已暂停接单</span> : null}
                  {row.staff_restricted && state !== "RESTRICTED" ? <span className="mra-badge" data-tone="warning"><span className="mra-badge-dot" aria-hidden="true" />账号受限</span> : null}
                  {!row.historicalReadOnly && state === "LISTED" && row.available === false ? <span className="mra-badge" data-tone="warning"><span className="mra-badge-dot" aria-hidden="true" />暂不可接单</span> : null}
                  {row.accountDisplay?.titleFacts === null && row.accountDisplay?.unknownReason ? <span className="mra-badge" data-tone="unknown">资料待核实</span> : null}
                  {row.review_state === "REJECTED" ? <Link className="mra-row-anchor" href={`${accountListHref(mode, stateFilter, row.id)}#blockers`} scroll={false}>查看退回原因</Link> : null}
                </div>
                <Link className="mra-row-action" href={accountListHref(mode, stateFilter, row.id)} scroll={false} aria-label={`查看账号 ${title}`}>
                  <span>查看账号</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </Link>
              </div>;
            })}
          </div>
          <div className="mra-list-foot">
            {hasMore ? <button type="button" className="button secondary" disabled={loadingMore || identityState !== "confirmed"} onClick={() => void load(undefined, true, nextPageCursor ? { cursor: nextPageCursor } : nextCursor ? { after: nextCursor } : undefined, stateFilter)}>{loadingMore ? "正在读取更多…" : "加载更多账号"}</button> : null}
            {allLoaded ? <span className="mra-meta">没有更多账号了</span> : null}
          </div>
        </div>
      </>}
    </>}
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
    else if (key === "next_season_pass" || key === "demulan_unlocked") rows.push({ key, label, value: booleanDeclarationText(key, raw) });
    else if (CONDITION_LEVELS.has(key)) rows.push({ key, label, value: `${raw} 级` });
    else rows.push({ key, label, value: String(raw) });
  }
  if (display?.serviceWindow) rows.push({ key: "service_window", label: "上号时间", value: display.serviceWindow.displayName });
  if (typeof attributes.info_source === "string" && attributes.info_source.trim()) rows.push({ key: "info_source", label: "信息来源", value: attributes.info_source });
  return rows;
}

const UNCERTAIN_BLOCKERS = new Set(["PUBLISHER_BAIL_UNCONFIRMED", "FUNDING_UNKNOWN", "OCCUPANCY_UNKNOWN"]);

/**
 * Whether this account can take a new order comes from the server's aggregated `available` verdict.
 * The client never recombines pause flags, restrictions and coverage into its own boolean.
 */
function availabilityView(detail: MySupply): { tone: "open" | "blocked" | "uncertain"; label: string } {
  if (detail.version?.origin === "LEGACY_OBSERVATION") return { tone: "uncertain", label: "历史只读，不接新单" };
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
  const historicalReadOnly = version?.origin === "LEGACY_OBSERVATION";
  // DTO 降级（S16）：historicalRead 缺子对象按「不渲染该块」处理，不整页崩。
  const historical = detail.historicalRead?.historicalQuote ? detail.historicalRead : null;
  const savedDisplay = historical?.display?.state === "KNOWN" ? historical.display.facts : null;
  const historicalDisplay = savedDisplay?.attributes && Array.isArray(savedDisplay.resources) ? savedDisplay : null;
  const historicalRatio = historicalDisplay?.sourceAccountBaseRatioWanPerYuan ? formatReferenceYuan(historicalDisplay.sourceAccountBaseRatioWanPerYuan)?.replace("¥", "") : null;
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
  const reasons = historicalReadOnly ? [] : detail.decisions?.filter((decision) => decision.decision === "REJECT") ?? [];
  const blockers = [...new Set([...(detail.blockers ?? []), ...(account.staff_restricted ? ["STAFF_RESTRICTED"] : [])])].filter(code => !historicalReadOnly || code === "STAFF_RESTRICTED");
  const availability = availabilityView(detail);
  const conditions = conditionRows(version);
  const resources = resourceRows(version);
  const titleResources: ResourceLine[] = version
    ? (version.quote?.lines ?? []).map((line, index) => {
        const known = version.catalogItems?.find((entry) => entry.id === line.itemId) ?? version.presentation?.items?.find((entry) => entry.id === line.itemId);
        const quantity = line.quantity ?? line.unitQuantity ?? "";
        return { itemId: line.itemId || `account_line_${index}`, code: known?.code ?? null, name: known?.name ?? "资源", quantity, quantityLabel: quantity, unitLabel: unitLabel(line.unit ?? known?.unit ?? ""), costAmount: null, costLabel: null, unitPriceLabel: null };
      })
    : (historicalDisplay?.resources ?? []).map((resource, index) => ({
        itemId: resource.code || `historical_line_${index}`, code: resource.code, name: resource.name || "资源", quantity: resource.quantity ?? "", quantityLabel: resource.quantity ?? "", unitLabel: unitLabel(resource.unit), costAmount: null, costLabel: null, unitPriceLabel: null,
      }));
  const titleConditions = version ? conditions : historicalConditions;
  const accountTitle = deriveAccountTitle({ resourceLines: titleResources, conditionLines: titleConditions });
  const displayTitle = accountTitle.primary && accountTitle.primary !== "游戏账号" ? accountTitle.primary : "出租账号";
  const displayMedia = (declaration?.mediaBindings ?? []).filter((item) => item.purpose === "ACCOUNT_DISPLAY" && item.publicDisplayEligible !== false);
  const evidenceMedia = (declaration?.mediaBindings ?? []).filter((item) => item.purpose === "ACCOUNT_EVIDENCE");
  const penaltyMedia = displayMedia.filter((item) => item.category === "PENALTY");
  const galleryMedia = displayMedia.filter((item) => item.category !== "PENALTY");
  const cover = galleryMedia.find((item) => item.publiclyReadable !== false) ?? null;
  const unconfirmedNativeDraft = version?.origin === "NATIVE" && version.reviewState === "DRAFT" && version.contentHash === null;
  const draftSkinSummary = unconfirmedNativeDraft && version.draftSkinSummary?.source === "CURRENT_DRAFT_SELECTION" ? version.draftSkinSummary : null;
  const legacyHolding = version?.legacySkinHolding;
  const legacySkinVersion = version?.origin === "LEGACY_OBSERVATION" || Boolean(legacyHolding);
  const legacySkinAdmitted = legacyHolding?.state === "ADMITTED" && Number.isSafeInteger(legacyHolding.admittedCount) && legacyHolding.admittedCount! >= 0
    && Array.isArray(legacyHolding.items) && legacyHolding.items.every(skin => skin && typeof skin.id === "string" && typeof skin.name === "string")
    && Number.isSafeInteger(legacyHolding.withheldCount) && legacyHolding.withheldCount! >= 0
    && legacyHolding.items.length + legacyHolding.withheldCount! === legacyHolding.admittedCount;
  const skins = legacySkinVersion ? legacySkinAdmitted ? legacyHolding!.items! : [] : draftSkinSummary ? draftSkinSummary.items : version?.presentation?.skins ?? [];
  const withheldSkins = legacySkinVersion ? legacySkinAdmitted ? legacyHolding!.withheldCount! : 0 : draftSkinSummary?.withheld ?? 0;
  const skinCountKnown = legacySkinVersion ? legacySkinAdmitted : Boolean(draftSkinSummary) || (!unconfirmedNativeDraft && Array.isArray(version?.presentation?.skins));
  const entitlementCountKnown = Array.isArray(declaration?.entitlements);
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
  const galleryKey = galleryMedia.map(item => item.assetId).join("|");
  const [imageState, setImageState] = useState<{ accountId: string; key: string; status: "loading" | "ready" | "unknown"; urls: string[] }>({ accountId: account.id, key: galleryKey, status: "loading", urls: [] });
  const images = imageState.accountId === account.id && imageState.key === galleryKey ? imageState : { status: "loading" as const, urls: [] };
  const publicImages = images.urls;
  const [activeImgIndex, setActiveImgIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copiedNo, setCopiedNo] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setImageState({ accountId: account.id, key: galleryKey, status: galleryMedia.length ? "ready" : "loading", urls: galleryMedia.map(item => mediaAccessUrl(item.assetId)) });
    setActiveImgIndex(0);
    setLightboxOpen(false);
    void supplyApi.listing(account.id, controller.signal).then(listing => {
      if (listing.id !== account.id) throw new Error("Listing identity mismatch");
      const urls = toListingDetail(listing).media.map(item => item.url);
      if (!controller.signal.aborted && (urls.length || !galleryMedia.length)) setImageState({ accountId: account.id, key: galleryKey, status: "ready", urls });
    }).catch(() => { if (!controller.signal.aborted && !galleryMedia.length) setImageState({ accountId: account.id, key: galleryKey, status: "unknown", urls: [] }); });
    return () => controller.abort();
  // The fallback contains only this account's display bindings.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, galleryKey]);


  return <div className="supply-account-detail account-module-card">
    {/* 1. 顶部 Hero 控制条：单一行精简有质感 */}
    <div className="supply-detail-hero">
      {cover ? <img className="supply-detail-cover" src={mediaAccessUrl(cover.assetId)} alt="" width={176} height={99} onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
      <div className="supply-detail-hero-copy">
        <div className="supply-detail-hero-title-row">
          {gameName ? <span className="mra-game-tag">{gameName}</span> : null}
          <h1 className="supply-detail-title">{displayTitle}</h1>
          {account.display_no ? <span className="mra-meta-pill mra-no-pill"><span>账号 {account.display_no}</span><AccountCopyInline text={account.display_no} /></span> : <span className="mra-meta-pill">编号待分配</span>}
        </div>
        <div className="supply-detail-status">
          <span className="order-status" data-state={REVIEW_TONE[version?.reviewState ?? ""] ?? "unknown"}>{version ? stateLabel(version.reviewState) : "尚未提交上架资料"}</span>
          <span className="order-status" data-state={AVAILABILITY_TONE[availability.tone]}>{availability.label}</span>
          {publishedAt ? <span className="supply-detail-pub-time">发布于 {publishedAt}</span> : null}
          <button type="button" className="button quiet button--sm" disabled={!identityReady || busy !== ""} onClick={onRefresh}><RefreshCw size={13} aria-hidden="true" />刷新状态</button>
        </div>
      </div>
      <div className="supply-detail-actions">
        {historicalReadOnly ? <p className="supply-detail-actions-hint">历史只读记录，不参与当前接单或编辑；如需处理请联系客服。</p> : <>
          {account.owner_paused
            ? <button type="button" className="button secondary button--sm" disabled={!identityReady || busy !== ""} onClick={() => void onAction("resume")}><Play size={15} aria-hidden="true" />{busy === "resume" ? "恢复中…" : "恢复接单"}</button>
            : version ? <button type="button" className="button secondary button--sm" disabled={!identityReady || busy !== ""} onClick={() => void onAction("pause")}><Pause size={15} aria-hidden="true" />{busy === "pause" ? "暂停中…" : "暂停接单"}</button> : null}
          {version?.reviewState === "SUBMITTED" ? (
            <button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={() => void onAction("withdraw")}><Undo2 size={16} aria-hidden="true" />{busy === "withdraw" ? "撤回中…" : "撤回审核"}</button>
          ) : (
            <Link href={editHref} className="button primary"><Pencil size={15} aria-hidden="true" />{editLabel}</Link>
          )}
        </>}
      </div>
    </div>

    {/* 冲突/阻塞/退回原因提示 */}
    {latest || blockers.length || reasons.length ? <div className="supply-blockers-group" id="blockers" tabIndex={-1} ref={blockersRef}>
      {latest ? <div className="supply-conflict"><strong>资料状态已变化</strong><p>当前状态：{latest.version ? stateLabel(latest.version.reviewState) : "未创建草稿"}。</p><div className="supply-inline-actions"><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onRefresh}>重新读取</button><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onAdopt}>采用最新状态</button></div></div> : null}
      {blockers.length ? (
        <div className="supply-blockers supply-blockers--compact" role="alert">
          <div className="supply-blockers-lead">
            <AlertCircle size={15} aria-hidden="true" />
            <strong>当前限制</strong>
            <span className="supply-blockers-count">{blockers.length}项</span>
          </div>
          <div className="supply-blockers-chips">
            {blockers.map((code) => (
              <span key={code} className="supply-blocker-chip">
                {blockerText(code)}
                {code === "STAFF_RESTRICTED" && account.restriction_reason ? (
                  <span className="supply-blocker-reason">{account.restriction_reason}</span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {reasons.length ? <div className="supply-decisions"><h3>退回原因</h3>{reasons.map((decision) => <p key={decision.id}>{decision.reason}</p>)}</div> : null}
    </div> : null}

    {/* 2. 控制台双列布局：左栏 64% 核心资产与画廊，右栏 36% 收益经营与操作履约 */}
    <div className="supply-console-grid">
      {/* ===== 左主栏 ===== */}
      <div className="supply-console-main">
        {/* 实机截图画廊 */}
        <section className="supply-block account-module-card supply-gallery-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <Images size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">账号展示图</h2>
            </div>
            <span className="supply-section-note">{publicImages.length ? `共 ${publicImages.length} 张展示图 · 点击放大` : images.status === "loading" ? "正在读取" : images.status === "unknown" ? "展示图暂未确认" : "暂无展示图"}</span>
          </div>
          {publicImages.length ? (
            <div className="supply-gallery-body">
              <div className="supply-gallery-main" onClick={() => setLightboxOpen(true)} title="点击全屏查看大图">
                <LegacyAccountImage src={publicImages[activeImgIndex] ?? publicImages[0] ?? null} alt="游戏公开截图" className="supply-gallery-hero-img" />
                <span className="supply-gallery-zoom-pill"><Sparkles size={13} aria-hidden="true" />点击放大预览</span>
              </div>
              {publicImages.length > 1 ? (
                <div className="supply-gallery-thumbs-rail" role="tablist" aria-label="截图缩略图滑轨">
                  {publicImages.map((img, idx) => (
                    <button
                      type="button"
                      key={idx}
                      className={`supply-gallery-thumb-btn${idx === activeImgIndex ? " is-active" : ""}`}
                      onClick={() => setActiveImgIndex(idx)}
                      aria-label={`查看第 ${idx + 1} 张截图`}
                    >
                      <LegacyAccountImage src={img} alt="" />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="supply-gallery-empty-art-wrap">
              <AccountMediaPlaceholder state="UNAVAILABLE" className="supply-gallery-placeholder-art" />
              <span className="supply-gallery-placeholder-note">
                {images.status === "loading" ? "正在读取展示图…" : images.status === "unknown" ? "展示图暂未确认" : "暂无公开展示图"}
              </span>
            </div>
          )}
        </section>

        {/* 核心战力与参数矩阵 */}
        {historical ? <section className="supply-block account-module-card supply-specs-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <SlidersHorizontal size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">历史属性与资源</h2>
            </div>
            <div className="supply-specs-header-meta">
              <span className="supply-section-note">{historicalDisplay ? `更新于 ${displayTime(historicalDisplay.sourceUpdatedAt) ?? "时间待核"}` : "历史记录"}</span>
              <span className="supply-hint-capsule" title="部分属性未提供或尚待核实。历史资料，请以当前上架信息和状态为准。">
                <Info size={13} aria-hidden="true" />
                <span>历史资料说明</span>
                <span className="sr-only">
                  {historicalDisplay && Object.values(historicalDisplay.attributes).some(value => value === null) ? "部分属性未提供或尚待核实。" : ""}
                  历史资料，请以当前上架信息和状态为准。
                </span>
              </span>
            </div>
          </div>
          {historicalDisplay ? (() => {
            const provinceCond = historicalConditions.find(c => c.key === "region_province");
            const cityCond = historicalConditions.find(c => c.key === "region_city");
            const regionVal = provinceCond && cityCond
              ? (provinceCond.value === cityCond.value ? provinceCond.value : `${provinceCond.value} · ${cityCond.value}`)
              : provinceCond?.value || cityCond?.value || null;

            const nonRegionConditions = historicalConditions.filter(c => c.key !== "region_province" && c.key !== "region_city");

            const orderedKeys = [
              "safe_box_code", "grading_code", "character_level", "secret_kd",
              "vit_level", "bear_level", "dive_level", "login_method_code"
            ];
            const primaryList = orderedKeys
              .map(k => nonRegionConditions.find(c => c.key === k))
              .filter((c): c is (typeof historicalConditions)[number] => Boolean(c));

            const remainingList = nonRegionConditions.filter(c => !orderedKeys.includes(c.key) && c.key !== "service_window");
            const serviceWindowCond = nonRegionConditions.find(c => c.key === "service_window");

            return (
              <div className="supply-unified-specs-grid">
                {primaryList.map(item => (
                  <div key={item.key} className={`supply-spec-pill${item.key === "safe_box_code" ? " highlight" : ""}`} data-key={item.key}>
                    <span className="supply-spec-pill-k">{item.label}</span>
                    <strong className="supply-spec-pill-v">{item.value}</strong>
                  </div>
                ))}
                {regionVal ? (
                  <div className="supply-spec-pill" data-key="region">
                    <span className="supply-spec-pill-k">游戏地区</span>
                    <strong className="supply-spec-pill-v">{regionVal}</strong>
                  </div>
                ) : null}
                {serviceWindowCond ? (
                  <div className="supply-spec-pill" data-key="service_window">
                    <span className="supply-spec-pill-k">{serviceWindowCond.label}</span>
                    <strong className="supply-spec-pill-v">{serviceWindowCond.value}</strong>
                  </div>
                ) : null}
                <div className="supply-spec-pill" data-key="face_declaration">
                  <span className="supply-spec-pill-k">人脸声明</span>
                  <strong className="supply-spec-pill-v">{historicalDisplay.attributes.face_is_self === true ? "号主声明本人脸" : historicalDisplay.attributes.face_is_self === false ? "号主声明非本人脸" : "未提供"}</strong>
                </div>
                <div className="supply-spec-pill" data-key="ban_declaration">
                  <span className="supply-spec-pill-k">封禁记录声明</span>
                  <strong className="supply-spec-pill-v">{historicalDisplay.attributes.ban_record === true ? "号主声明有封禁记录" : historicalDisplay.attributes.ban_record === false ? "号主声明无封禁记录" : "未提供"}</strong>
                </div>
                {remainingList.map(item => (
                  <div key={item.key} className="supply-spec-pill" data-key={item.key}>
                    <span className="supply-spec-pill-k">{item.label}</span>
                    <strong className="supply-spec-pill-v">{item.value}</strong>
                  </div>
                ))}
              </div>
            );
          })() : <p role="status">部分账号资料暂未确认。</p>}
        </section> : (!historical && conditions.length ? <section className="supply-block account-module-card supply-specs-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <SlidersHorizontal size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">账号配置</h2>
            </div>
          </div>
          <dl className="supply-spec-list">{conditions.map((row) => {
            const Icon = CONDITION_ICONS[row.key] ?? null;
            return <div key={row.key}><dt>{Icon ? <Icon size={16} aria-hidden="true" /> : null}{row.label}</dt><dd>{row.value}</dd></div>;
          })}</dl>
        </section> : null)}

        {/* 在架物资清单 */}
        {historical && historicalDisplay ? (
          <section className="supply-block account-module-card supply-resources-card">
            <div className="account-module-card-header">
              <div className="supply-section-title-wrap">
                <Package size={17} className="supply-section-icon" aria-hidden="true" />
                <h2 className="supply-section-title">历史账号资源</h2>
              </div>
              <span className="supply-section-note">按历史资料展示</span>
            </div>
            {historicalDisplay.resources.length ? (
              <div className="supply-resources-chips">
                {historicalDisplay.resources.map(item => {
                  const isHaff = item.code === "haff_base" || item.name?.includes("哈夫币");
                  return (
                    <div key={item.code} className={`supply-resource-chip${isHaff ? " is-haff" : ""}`}>
                      <span className="supply-resource-name">{item.name}：</span>
                      <strong className="supply-resource-qty">{historicalQuantityText(item.quantity, item.unit)}</strong>
                      {isHaff && historical.historicalQuote?.haffRentYuan ? (
                        <span className="supply-resource-chip-price">租金 ¥{historical.historicalQuote.haffRentYuan}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="supply-block-empty">本账号暂无在架物资申报。</p>
            )}
          </section>
        ) : (!historical && resources.length ? <section className="supply-block account-module-card supply-resources-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <Package size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">账号资源</h2>
            </div>
          </div>
          <ul className="supply-resource-list">{resources.map((row, index) => <li key={`${row.name}-${index}`}><span>{row.name}</span><strong>{row.quantity ?? "未返回"} {row.unit}</strong></li>)}</ul>
          <details className="supply-inline-fold"><summary>查看报价明细</summary><table className="supply-stock-table"><thead><tr><th scope="col">物资</th><th scope="col">数量</th><th scope="col">号主侧单价</th><th scope="col">号主侧费用</th></tr></thead><tbody>{resources.map((row, index) => <tr key={`${row.name}-${index}`}><th scope="row">{row.name}{row.unit ? <small>{row.unit}</small> : null}</th><td>{row.quantity ?? "未返回"}</td><td>{row.ownerUnit ?? "未返回"}</td><td>{row.ownerAmount ?? "未返回"}</td></tr>)}</tbody>{quote?.ownerTotal ? <tfoot><tr><th scope="row" colSpan={3}>发布报价合计</th><td>{moneyText(quote.ownerTotal)}</td></tr></tfoot> : null}</table></details>
        </section> : null)}

        {/* 补充折叠区域：皮肤与权益、审核资料、修改记录 */}
        <div className="supply-console-folds">
          <details className="supply-block supply-block--fold" data-skin-summary-source={legacySkinVersion ? legacySkinAdmitted ? "LEGACY_ADMITTED" : "LEGACY_UNKNOWN" : draftSkinSummary?.source}>
            <summary><strong>{draftSkinSummary ? "草稿已选皮肤" : "皮肤与权益"}</strong><span>{!skinCountKnown ? "皮肤数量待确认" : legacySkinVersion ? `${legacyHolding!.admittedCount} 项皮肤` : draftSkinSummary ? `${skins.length + withheldSkins} 项已选皮肤` : `${skins.length} 项皮肤`}{entitlementCountKnown ? ` · ${entitlements.length} 项权益` : ""}</span><ChevronDown size={16} aria-hidden="true" /></summary>
            <div className="supply-fold-body">
              {legacySkinVersion ? (legacySkinAdmitted ? null : <p className="supply-block-empty">皮肤资料暂未确认。</p>) : null}
              {draftSkinSummary ? <p className="supply-block-empty">这是草稿中选择的皮肤，尚未公开上架。</p> : unconfirmedNativeDraft ? <p className="supply-block-empty">草稿的皮肤资料暂不可用，请进入编辑查看。</p> : null}
              {withheldSkins > 0 ? <p className="supply-block-empty">{legacySkinVersion ? `另有 ${withheldSkins} 项皮肤暂时无法显示。` : `另有 ${withheldSkins} 项已选皮肤暂时无法显示，请进入编辑查看。`}</p> : null}
              {skins.length ? <ul className="supply-skin-list">{skins.map((skin, index) => <li key={`${skin.id}-${index}`} data-skin-id={skin.id}>
                <SkinMediaPreview skin={skin} triggerClassName="skin-media-preview-trigger supply-skin-preview" mediaClassName="supply-skin-thumb" fallbackClassName="supply-skin-thumb-empty" iconSize={22} />
                <span>{skinCardTitle(skin)}</span>
                {skinTypeLabel(skin.ownerKind) ? <small>{skinTypeLabel(skin.ownerKind)}</small> : null}
                <SkinMetadata skin={skin} />
              </li>)}</ul> : null}
              {entitlements.length ? <ul className="supply-entitlement-list">{entitlements.map((entry, index) => <li key={`${entry.name}-${index}`}><strong>{entry.name}</strong><span>{entry.term}</span></li>)}</ul> : null}
              {!skins.length && !entitlements.length && !withheldSkins && skinCountKnown ? <p className="supply-block-empty">{legacySkinVersion ? "账号记录中没有皮肤。" : draftSkinSummary ? "草稿尚未选择皮肤。" : entitlementCountKnown ? "还没有申报皮肤或权益。" : "还没有申报皮肤。"}</p> : null}
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

          {history.length ? <details className="supply-block supply-block--fold">
            <summary><strong>资料修改记录</strong><span>{history.length} 条</span><ChevronDown size={16} aria-hidden="true" /></summary>
            <div className="supply-fold-body">
              <ul className="supply-history-list">{history.map((entry, index) => {
                const editedAt = displayTime(entry.created_at);
                return <li key={`${entry.sequence ?? "x"}-${index}`}>
                  <span className="order-status" data-state={REVIEW_TONE[entry.review_state ?? ""] ?? "unknown"}>{stateLabel(entry.review_state)}</span>
                  <span className="supply-history-title">{entry.title ?? "未命名草稿"}</span>
                  {editedAt ? <time dateTime={entry.created_at ?? undefined}>{editedAt}</time> : null}
                </li>;
              })}</ul>
            </div>
          </details> : null}
        </div>
      </div>

      {/* ===== 右侧栏（38%）：经营驾驶舱与履约操作 ===== */}
      <aside className="supply-console-sidebar">
        {/* 出租经营收益卡片（大字号金墨高光） */}
        <section className="supply-block account-module-card supply-side-revenue-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <ReceiptText size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">出租设置与收益</h2>
            </div>
            <span className="supply-mode-badge">
              {({ ordinary: "普通租赁", custom: "定制租赁", fast: "极速租赁" } as Record<string, string>)[quote?.rentalMode ?? historicalDisplay?.rentalMode ?? ""] ?? "出租方式待确认"}
            </span>
          </div>

          {quote || !historical ? <>
            <div className="supply-revenue-stat"><span className="supply-revenue-label">上架报价</span><strong className="supply-revenue-num">{moneyText(quote?.ownerTotal)}</strong></div>
            <div className="supply-revenue-sub-grid">
              <div className="supply-revenue-sub-cell">
                <span className="supply-rev-sub-k">约定租期</span>
                <strong className="supply-rev-sub-v">{quote?.termSeconds ? termLabel(quote.termSeconds) : "未提供"}</strong>
              </div>
              <div className="supply-revenue-sub-cell">
                <span className="supply-rev-sub-k">哈夫币出租比例</span>
                <strong className="supply-rev-sub-v">{quote?.ownerHaffRatio ? `1 元 = ${quote.ownerHaffRatio} 万哈夫币` : "待确认"}</strong>
              </div>
            </div>
          </> : null}
          {historical ? <><div className="supply-revenue-hero">
            <div className="supply-revenue-stat">
              <span className="supply-revenue-label">哈夫币租金记录</span>
              <div className="supply-revenue-num-wrap">
                <span className="supply-revenue-symbol">¥</span>
                <strong className="supply-revenue-num">{historical.historicalQuote.haffRentYuan}</strong>
              </div>
            </div>
            <div className="supply-revenue-stat">
              <span className="supply-revenue-label">押金记录</span>
              <div className="supply-revenue-num-wrap">
                <span className="supply-revenue-symbol">¥</span>
                <strong className="supply-revenue-num">{historical.historicalQuote.depositYuan}</strong>
              </div>
            </div>
          </div>

          <div className="supply-revenue-sub-grid">
            <div className="supply-revenue-sub-cell">
              <span className="supply-rev-sub-k">约定租期</span>
              <strong className="supply-rev-sub-v">{historical.historicalQuote.termDays} 天</strong>
            </div>
            <div className="supply-revenue-sub-cell">
              <span className="supply-rev-sub-k">物资金额</span>
              <strong className="supply-rev-sub-v">{historical.historicalQuote.goodsYuan} 元</strong>
            </div>
            <div className="supply-revenue-sub-cell">
              <span className="supply-rev-sub-k">迁入时账号比例</span>
              <strong className="supply-rev-sub-v">{historicalRatio ? `1 元 = ${historicalRatio} 万哈夫币` : "未记录"}</strong>
            </div>
            <div className="supply-revenue-sub-cell">
              <span className="supply-rev-sub-k">迁入时包赔选择</span>
              <strong className="supply-rev-sub-v">{historicalDisplay?.sourceAccountFullPayoutSelected === true ? "已选择" : historicalDisplay?.sourceAccountFullPayoutSelected === false ? "未选择" : "未记录"}</strong>
            </div>
          </div></> : null}

          <div className="supply-revenue-foot">
            <Link href={`/account?view=leased&accountId=${encodeURIComponent(account.id)}`} className="supply-side-order-btn">
              <span>查看该账号的出租订单</span>
              <ChevronRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </section>

        {/* 履约责任与保证金卡片 */}
        <section className="supply-block account-module-card supply-side-duty-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <ShieldCheck size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">履约责任与保证金</h2>
            </div>
          </div>
          <div className="supply-duty-content">
            <div className="supply-duty-row">
              <span className="supply-duty-k">上架时保证金要求</span>
              <strong className="supply-duty-v">{quote?.publisherBailRequirement ? `${quote.publisherBailRequirement.amount} 元` : "待确认"}</strong>
            </div>
            <div className="supply-duty-note">
              <p>查看本账号当前应缴保证金状态与信用分值。</p>
            </div>
            <div className="supply-duty-link-wrap">
              <Link href={`/account?view=credit&accountId=${encodeURIComponent(account.id)}`} className="supply-duty-nav-link" scroll={false}>
                <span>进入信用与保证金中心</span>
                <ChevronRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </aside>
    </div>

    {/* 全屏 Lightbox 大图预览 */}
    {lightboxOpen && publicImages.length ? (
      <div className="supply-lightbox-overlay" role="dialog" aria-modal="true" aria-label="全屏查看账号展示图" onClick={() => setLightboxOpen(false)}>
        <div className="supply-lightbox-modal" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="supply-lightbox-close" onClick={() => setLightboxOpen(false)} aria-label="关闭预览"><X size={20} /></button>
          <LegacyAccountImage src={publicImages[activeImgIndex] ?? null} alt={`截图 ${activeImgIndex + 1}`} className="supply-lightbox-img" />
          {publicImages.length > 1 ? (
            <div className="supply-lightbox-nav">
              <button type="button" className="supply-lightbox-arrow" disabled={activeImgIndex === 0} onClick={() => setActiveImgIndex(i => Math.max(0, i - 1))} aria-label="上一张">‹</button>
              <span className="supply-lightbox-counter">{activeImgIndex + 1} / {publicImages.length}</span>
              <button type="button" className="supply-lightbox-arrow" disabled={activeImgIndex === publicImages.length - 1} onClick={() => setActiveImgIndex(i => Math.min(publicImages.length - 1, i + 1))} aria-label="下一张">›</button>
            </div>
          ) : null}
        </div>
      </div>
    ) : null}
  </div>;
}
