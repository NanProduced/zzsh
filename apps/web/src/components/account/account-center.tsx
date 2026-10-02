"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  Copy,
  CreditCard,
  Crown,
  FileText,
  House,
  LayoutGrid,
  RefreshCw,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  UserRound,
} from "lucide-react";
import { maskPhone, webAuthRequest, WebAuthError } from "@/components/auth/auth-form";
import { useUserSession } from "@/components/session/user-session-provider";
import { accountStatusLabel, identityStatusLabel, type UserIdentitySnapshot } from "@/app/user-account-status";
import { MembershipRequestError, readMyMembership, type MembershipTier } from "@/lib/membership-client";
import { formatOrderTime, orderApi, OrderRequestError, type Order, type OrderPage, type OrderParty } from "@/lib/order-client";
import "./account-center.css";

export const accountSectionLabels = {
  rentals: "租入订单",
  leased: "出租订单",
  accounts: "出租账号管理",
  identity: "实名认证",
  favorites: "我的收藏",
  security: "账号安全",
  wallet: "我的钱包",
  invite: "分销中心",
} as const;

export type AccountSection = keyof typeof accountSectionLabels;
export type AccountView = "overview" | AccountSection;

const TIER_LABELS: Record<MembershipTier, string> = {
  STANDARD: "标准",
  VIP: "VIP",
  SVIP: "SVIP",
  DISCOUNT_USER: "优惠用户",
  UNKNOWN: "资格未知",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: "待支付",
  PAID: "已支付",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

export type NavItem = {
  section: AccountView;
  label: string;
  icon: typeof FileText;
  badge?: string;
};

const NAV_ITEMS: NavItem[] = [
  { section: "overview", label: "总览", icon: House },
  { section: "rentals", label: "租入订单", icon: FileText },
  { section: "leased", label: "出租订单", icon: House },
  { section: "accounts", label: "出租账号管理", icon: UserRound },
  { section: "favorites", label: "我的收藏", icon: Star },
  { section: "identity", label: "实名认证", icon: ShieldCheck },
  { section: "security", label: "账号安全", icon: Shield },
  { section: "wallet", label: "我的钱包", icon: CreditCard, badge: "待接入" },
  { section: "invite", label: "分销中心", icon: Sparkles, badge: "待接入" },
];

export type AccountLocation = { view: AccountView; accountId?: string; orderId?: string; status?: string };

export function resolveAccountView(view: string): AccountView {
  if (view === "" || view === "overview") return "overview";
  if (Object.hasOwn(accountSectionLabels, view)) return view as AccountSection;
  return "rentals";
}

export function accountSectionHref(section: AccountView, current: AccountLocation): string {
  const query = new URLSearchParams();
  query.set("view", section);
  const sameOrder = (section === "rentals" || section === "leased") && current.view === section;
  if ((section === "accounts" || sameOrder) && current.accountId) query.set("accountId", current.accountId);
  if (sameOrder && current.status) query.set("status", current.status);
  if (sameOrder && current.orderId) query.set("orderId", current.orderId);
  return `/account?${query.toString()}`;
}

function coreStatus(order: Order): string {
  if (order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel) return "已到期 · 取消处理中";
  if (order.status === "CANCELLED" && order.cancelReason === "TIMEOUT") return "已取消 · 到期未支付";
  if (order.status === "CANCELLED" && order.cancelReason === "USER") return "已取消 · 租客取消";
  return STATUS_LABELS[order.status] ?? "状态待确认";
}

function isAuthenticationFailure(error: { status: number; code: string }): boolean {
  return error.status === 401 || error.code === "UNAUTHENTICATED";
}

function MembershipCardArt({ tier }: { tier: MembershipTier | null }) {
  return <div className="membership-card" data-testid="membership-card" data-tier={tier ?? undefined} aria-hidden="true">
    <span className="membership-card-brand">洲洲商行</span>
    <span className="membership-card-level">{tier ? TIER_LABELS[tier] : "会员身份"}</span>
    <span className="membership-card-caption">MEMBER CARD</span>
  </div>;
}

function MembershipIdentity({ scope }: { scope: string }) {
  const session = useUserSession();
  const revalidate = session.revalidate;
  const [reload, setReload] = useState(0);
  const [copyStatus, setCopyStatus] = useState<{ scope: string; value: "copied" | "failed" } | null>(null);
  const [state, setState] = useState<{ scope: string; status: "loading" | "ready" | "error"; tier: MembershipTier | null; error: MembershipRequestError | null }>({
    scope,
    status: "loading",
    tier: null,
    error: null,
  });
  const sequence = useRef(0);
  if (state.scope !== scope) setState({ scope, status: "loading", tier: null, error: null });

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setState({ scope, status: "loading", tier: null, error: null });
    readMyMembership(controller.signal).then(
      (membership) => {
        if (current === sequence.current) setState({ scope, status: "ready", tier: membership.tier, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        const failure = error instanceof MembershipRequestError ? error : new MembershipRequestError(0, null);
        if (isAuthenticationFailure(failure)) revalidate();
        setState({ scope, status: "error", tier: null, error: failure });
      },
    );
    return () => controller.abort();
  }, [scope, reload, revalidate]);

  const name = session.displayName || "洲洲用户";
  const firstWord = session.displayName?.trim().split(/\s+/)[0];
  const monogram = firstWord ? Array.from(firstWord).slice(0, 2).join("").toUpperCase() : null;
  const contractGap = state.error?.code === "MEMBERSHIP_CONTRACT_REQUIRED";
  const visibleCopyStatus = copyStatus?.scope === scope ? copyStatus.value : null;

  const copyUserId = async () => {
    if (!session.userId) return;
    try {
      await navigator.clipboard.writeText(session.userId);
      setCopyStatus({ scope, value: "copied" });
    } catch {
      setCopyStatus({ scope, value: "failed" });
    }
  };

  return (
    <div className="account-profile-card">
      <div className="account-profile-header">
        <div className="account-profile-details">
          <div className="account-profile-user">
            <span className="account-profile-avatar" aria-hidden="true">
              {monogram ?? <UserRound size={26} />}
            </span>
            <div className="account-profile-info">
              <h2 className="account-profile-name" title={name}>{name}</h2>
              <div className="account-profile-tier-row">
                {state.status === "ready" && state.tier ? (
                  <span className="membership-tier" data-testid="membership-tier">
                    <Crown size={12} aria-hidden="true" />
                    <span>{TIER_LABELS[state.tier]}</span>
                  </span>
                ) : (
                  <span
                    className="membership-status"
                    data-gap={contractGap ? "MEMBERSHIP_CONTRACT_REQUIRED" : undefined}
                  >
                    {state.status === "loading"
                      ? "正在读取会员等级"
                      : contractGap
                      ? "会员等级暂未由服务端提供"
                      : "会员等级暂时无法读取"}
                  </span>
                )}
                {state.status === "error" && !contractGap ? (
                  <button
                    type="button"
                    className="button secondary button--xs"
                    data-testid="retry-membership"
                    onClick={() => setReload((value) => value + 1)}
                  >
                    <RefreshCw size={12} aria-hidden="true" />重试
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          {session.userId ? <div className="account-profile-id">
            <span>账号编号</span>
            <code title={session.userId}>{session.userId}</code>
            <button type="button" onClick={() => void copyUserId()} aria-label="复制账号编号"><Copy size={14} aria-hidden="true" /><span>{visibleCopyStatus === "copied" ? "已复制" : visibleCopyStatus === "failed" ? "复制失败" : "复制"}</span></button>
          </div> : null}
          <div className="account-credit-preview">
            <ShieldCheck size={22} strokeWidth={1.6} aria-hidden="true" />
            <span><strong>信用分</strong><small>规则待公布</small></span>
            <em>即将上线</em>
          </div>
          <p id="membership-benefits" className="membership-benefits-note" data-gap="MEMBERSHIP_CONTRACT_REQUIRED">会员权益说明待接入</p>
        </div>
        <div className="account-profile-card-art-col"><MembershipCardArt tier={state.status === "ready" ? state.tier : null} /></div>
      </div>
    </div>
  );
}

function OrderSummaryCard({ party, scope }: { party: OrderParty; scope: string }) {
  const session = useUserSession();
  const revalidate = session.revalidate;
  const rental = party === "renter";
  const title = rental ? "最近租入" : "最近出租";
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ scope: string; status: "loading" | "ready" | "error"; page: OrderPage | null; error: OrderRequestError | null }>({
    scope,
    status: "loading",
    page: null,
    error: null,
  });
  const sequence = useRef(0);
  if (state.scope !== scope) setState({ scope, status: "loading", page: null, error: null });

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setState({ scope, status: "loading", page: null, error: null });
    orderApi.list({ party, limit: 3 }, controller.signal).then(
      (page) => {
        if (current === sequence.current) setState({ scope, status: "ready", page, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        const failure = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
        if (isAuthenticationFailure(failure)) revalidate();
        setState({ scope, status: "error", page: null, error: failure });
      },
    );
    return () => controller.abort();
  }, [party, scope, reload, revalidate]);

  const page = state.page;
  const items = page?.items.slice(0, 3) ?? [];
  const href = accountSectionHref(rental ? "rentals" : "leased", { view: "overview" });

  return (
    <article className={`account-summary-card${state.status === "ready" && items.length === 0 ? " is-empty" : ""}`} data-testid={`order-summary-${party}`} aria-busy={state.status === "loading" ? true : undefined}>
      <header className="account-summary-heading">
        <span className="account-summary-icon" aria-hidden="true">{rental ? <FileText size={23} /> : <House size={23} />}</span>
        <h3>{title}</h3>
      </header>
      <div className="account-summary-body">
        {state.status === "loading" ? (
          <p className="account-summary-feedback" role="status">正在读取订单</p>
        ) : null}
        {state.status === "error" ? (
          <div className="account-summary-feedback" role="alert">
            <strong>{isAuthenticationFailure(state.error!) ? "登录状态已变化" : `${rental ? "租入订单" : "出租订单"}暂时无法读取`}</strong>
            <button
              type="button"
              className="button secondary button--xs"
              data-testid={`retry-${party}`}
              onClick={() => setReload((value) => value + 1)}
            >
              <RefreshCw size={13} aria-hidden="true" />重试
            </button>
          </div>
        ) : null}
        {state.status === "ready" && page && items.length === 0 ? (
          <div className="account-summary-empty">
            <p role="status">{rental ? "暂无租入记录" : "暂无出租记录"}</p>
            <Link href={rental ? "/accounts" : "/publish"}>{rental ? "浏览账号" : "发布账号"}</Link>
          </div>
        ) : null}
        {state.status === "ready" && items.length > 0 ? (
          <div className="account-recent-orders-list">
            {items.map((order) => {
              const orderHref = accountSectionHref(rental ? "rentals" : "leased", { view: rental ? "rentals" : "leased", orderId: order.id });
              return (
                <Link key={order.id} className="account-order-row" href={orderHref} scroll={false}>
                  <div className="account-order-row-main">
                    <strong className="account-order-row-title">{order.title ?? "账号信息暂不可用"}</strong>
                    <div className="account-order-row-meta">
                      {order.displayNo ? <span>单号 {order.displayNo}</span> : null}
                      {order.createdAt ? <span>创建于 {formatOrderTime(order.createdAt)}</span> : null}
                    </div>
                  </div>
                  <span className="account-order-row-status" data-testid={`order-status-${party}`}>
                    {coreStatus(order)}
                  </span>
                </Link>
              );
            })}
            {page?.nextCursor ? (
              <p className="account-order-more-hint">还有更多订单，打开列表查看完整记录。</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {items.length > 0 ? <Link className="account-summary-more" href={href} scroll={false} aria-label={`查看全部${rental ? "租入" : "出租"}订单`}><ChevronRight size={18} aria-hidden="true" /></Link> : null}
    </article>
  );
}

export function AccountOverview({ scope }: { scope: string }) {
  const session = useUserSession();
  const revalidate = session.revalidate;
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState<{ scope: string; phase: "loading" | "ready" | "error"; phone: string | null; identity: UserIdentitySnapshot | null }>({ scope, phase: "loading", phone: null, identity: null });
  const sequence = useRef(0);
  if (status.scope !== scope) setStatus({ scope, phase: "loading", phone: null, identity: null });

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setStatus({ scope, phase: "loading", phone: null, identity: null });
    (async () => {
      try {
        const profile = await webAuthRequest<{ user?: { id: string; phoneNumber?: string | null } } | null>("/get-session", undefined, controller.signal);
        if (controller.signal.aborted || current !== sequence.current) return;
        if (profile?.user?.id !== session.userId) { revalidate(); return; }
        const identity = await webAuthRequest<UserIdentitySnapshot>("/identity/status", undefined, controller.signal);
        if (controller.signal.aborted || current !== sequence.current) return;
        setStatus({ scope, phase: "ready", phone: profile.user.phoneNumber ?? null, identity });
      } catch (error) {
        if (controller.signal.aborted || current !== sequence.current) return;
        if (error instanceof WebAuthError && error.status === 401) revalidate();
        setStatus({ scope, phase: "error", phone: null, identity: null });
      }
    })();
    return () => controller.abort();
  }, [scope, reload, revalidate, session.userId]);

  const visibleStatus = status.scope === scope ? status : { scope, phase: "loading" as const, phone: null, identity: null };
  return (
    <div className="account-overview">
      <MembershipIdentity scope={scope} />
      <div className="account-overview-grid">
        <section className="account-recent-panel" aria-labelledby="account-recent-orders-heading">
          <div className="account-panel-heading">
            <h2 id="account-recent-orders-heading">最近订单</h2>
            <span>分别查看租入与出租的最新记录</span>
          </div>
          <div className="account-order-grid">
            <OrderSummaryCard party="renter" scope={scope} />
            <OrderSummaryCard party="owner" scope={scope} />
          </div>
        </section>
        <div className="account-overview-aside">
          <section className="account-wallet-preview" aria-labelledby="account-wallet-heading">
            <div className="account-wallet-mark" aria-hidden="true"><CreditCard size={25} /></div>
            <div>
              <h2 id="account-wallet-heading">我的钱包</h2>
              <strong>余额待接入</strong>
              <p>资金流水功能正在准备中</p>
            </div>
          </section>
          <section className="account-status-panel" aria-labelledby="account-status-heading" aria-busy={visibleStatus.phase === "loading" ? true : undefined}>
            <h2 id="account-status-heading">账号状态</h2>
            {visibleStatus.phase === "ready" && visibleStatus.identity ? (
              <>
                <dl>
                  <div><dt>账号</dt><dd data-state={visibleStatus.identity.accountStatus === "ACTIVE" ? "ok" : "attention"}>{accountStatusLabel(visibleStatus.identity.accountStatus)}</dd></div>
                  <div><dt>手机号</dt><dd data-state={visibleStatus.phone ? "ok" : "attention"}>{visibleStatus.phone ? maskPhone(visibleStatus.phone) : "未绑定"}</dd></div>
                  <div><dt>实名</dt><dd data-state={visibleStatus.identity.identityStatus === "VERIFIED" ? "ok" : "attention"}>{identityStatusLabel(visibleStatus.identity.identityStatus)}</dd></div>
                </dl>
                {visibleStatus.identity.provider === "fake" ? <p className="account-status-note">实名状态来自本地测试环境</p> : null}
              </>
            ) : visibleStatus.phase === "loading" ? (
              <p className="account-status-note" role="status">正在读取账号状态…</p>
            ) : (
              <div className="account-status-retry" role="alert"><span>账号状态暂无法读取</span><button type="button" className="button secondary button--xs" onClick={() => setReload((value) => value + 1)}>重试</button></div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function AccountCenterFrame({
  active,
  accountId,
  orderId,
  status,
  scope: _scope,
  children,
}: {
  active: AccountView;
  accountId?: string;
  orderId?: string;
  status?: string;
  scope: string;
  children: ReactNode;
}) {
  const current = { view: active, accountId, orderId, status };
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const previousActiveRef = useRef(active);

  useEffect(() => {
    if (previousActiveRef.current !== active) {
      previousActiveRef.current = active;
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [active]);

  const onTabClick = (section: AccountView) => {
    setMobileMoreOpen(false);
    if (active === section) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  };

  const isMoreActive =
    active !== "overview" && active !== "rentals" && active !== "leased";

  return (
    <div className="account-center">
      <nav className="account-mobile-tabs" aria-label="移动端个人中心导航">
        <div className="account-mobile-tabs-grid">
          <Link
            className="account-mobile-tab-btn"
            href={accountSectionHref("overview", current)}
            scroll={false}
            onClick={() => onTabClick("overview")}
            aria-current={active === "overview" ? "page" : undefined}
          >
            <House size={18} aria-hidden="true" />
            <span>总览</span>
          </Link>
          <Link
            className="account-mobile-tab-btn"
            href={accountSectionHref("rentals", current)}
            scroll={false}
            onClick={() => onTabClick("rentals")}
            aria-current={active === "rentals" ? "page" : undefined}
          >
            <FileText size={18} aria-hidden="true" />
            <span>租入订单</span>
          </Link>
          <Link
            className="account-mobile-tab-btn"
            href={accountSectionHref("leased", current)}
            scroll={false}
            onClick={() => onTabClick("leased")}
            aria-current={active === "leased" ? "page" : undefined}
          >
            <House size={18} aria-hidden="true" />
            <span>出租订单</span>
          </Link>
          <button
            type="button"
            className={`account-mobile-tab-btn ${isMoreActive ? "is-active-parent" : ""}`}
            aria-expanded={mobileMoreOpen}
            aria-controls="account-mobile-more-menu"
            onClick={() => setMobileMoreOpen((prev) => !prev)}
          >
            <LayoutGrid size={18} aria-hidden="true" />
            <span>更多</span>
          </button>
        </div>
        {mobileMoreOpen ? (
          <div id="account-mobile-more-menu" className="account-mobile-more-panel">
            <ul>
              {NAV_ITEMS.slice(3).map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.section} className={item.section === "wallet" ? "account-nav-break" : undefined}>
                    <Link
                      className={item.badge ? "is-pending" : undefined}
                      href={accountSectionHref(item.section, current)}
                      scroll={false}
                      aria-label={item.badge ? `${item.label}，${item.badge}说明` : undefined}
                      aria-current={active === item.section ? "page" : undefined}
                      onClick={() => onTabClick(item.section)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{item.label}</span>
                      {item.badge ? <span className="account-nav-badge">{item.badge}</span> : null}
                      {!item.badge ? <ChevronRight size={14} className="account-nav-chevron" aria-hidden="true" /> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </nav>

      <aside className="account-center-side">
        <nav className="account-nav" aria-label="个人中心">
          <ul>
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.section} className={item.section === "wallet" ? "account-nav-break" : undefined}>
                  <Link
                    className={item.badge ? "is-pending" : undefined}
                    href={accountSectionHref(item.section, current)}
                    scroll={false}
                    aria-label={item.badge ? `${item.label}，${item.badge}说明` : undefined}
                    onClick={() => onTabClick(item.section)}
                    aria-current={active === item.section ? "page" : undefined}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.badge ? <span className="account-nav-badge">{item.badge}</span> : null}
                    {!item.badge ? <ChevronRight size={14} className="account-nav-chevron" aria-hidden="true" /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <div className="account-center-main">{children}</div>
    </div>
  );
}
