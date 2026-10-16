"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronRight,
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
import { MembershipGrowthRequestError, readMyMembershipGrowth, type GrowthTier, type MembershipGrowthViewState } from "@/lib/membership-growth-client";
import { readMyCredit, CreditRequestError, type CreditOverview, type CreditGuarantee } from "@/lib/credit-guarantee-client";
import { readMyWallet, walletMoney, WalletRequestError, type WalletRead } from "@/lib/personal-wallet-client";
import { formatOrderTime, orderApi, orderItemKey, OrderRequestError, type Order, type OrderPage, type OrderParty } from "@/lib/order-client";
import { orderUrl } from "@/components/order/order-presentation";
import { EntitlementBadge, formatScopeName, GrowthMemberCardArt, GROWTH_TIER_LABELS, MembershipCenterView } from "./membership-center";
import { NicknameEditEntry } from "./nickname-edit";
import type { SecurityNicknameDraft, SecurityPendingWrite } from "./account-security-controls";
import "./account-center.css";

export const accountSectionLabels = {
  membership: "会员中心",
  rentals: "租入订单",
  leased: "出租订单",
  accounts: "出租账号",
  credit: "信用与保证金",
  identity: "实名认证",
  favorites: "我的收藏",
  security: "账号安全",
  wallet: "我的钱包",
  invite: "邀请与佣金",
} as const;

export type AccountSection = keyof typeof accountSectionLabels;
export type AccountView = "overview" | AccountSection;

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

export type NavGroup = { title?: string; items: NavItem[] };

// 分组按 Owner 裁定：顶部三项（总览/会员中心/我的收藏）不再加“常用”标题；“资产与收益”取代旧的“资产与信用”。
export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { section: "overview", label: "总览", icon: House },
      { section: "membership", label: "会员中心", icon: Crown },
      { section: "favorites", label: "我的收藏", icon: Star },
    ],
  },
  {
    title: "租赁管理",
    items: [
      { section: "rentals", label: "租入订单", icon: FileText },
      { section: "leased", label: "出租订单", icon: House },
      { section: "accounts", label: "出租账号", icon: UserRound },
    ],
  },
  {
    title: "资产与收益",
    items: [
      { section: "wallet", label: "我的钱包", icon: CreditCard },
      { section: "credit", label: "信用与保证金", icon: ShieldCheck },
      { section: "invite", label: "邀请与佣金", icon: Sparkles },
    ],
  },
  {
    title: "账号设置",
    items: [
      { section: "identity", label: "实名认证", icon: ShieldCheck },
      { section: "security", label: "账号安全", icon: Shield },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** 面包屑第三段用的当前页面名称：以导航项标签为准，未知回落“总览”。 */
export function accountViewTitle(view: AccountView): string {
  return NAV_ITEMS.find((item) => item.section === view)?.label ?? "总览";
}

export type AccountLocation = { view: AccountView; accountId?: string; orderId?: string; status?: string };

/** web.account.unsupported: a view outside the known sections is reported, never silently mapped to another business page. */
export function isKnownAccountView(view: string): boolean {
  return view === "" || view === "overview" || Object.hasOwn(accountSectionLabels, view);
}

export function resolveAccountView(view: string): AccountView {
  if (Object.hasOwn(accountSectionLabels, view)) return view as AccountSection;
  return "overview";
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
  if (order.source?.origin === "LEGACY") return order.source.statusLabel ?? "历史状态待确认";
  if (order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel) return "已到期 · 取消处理中";
  if (order.status === "CANCELLED" && order.cancelReason === "TIMEOUT") return "已取消 · 到期未支付";
  if (order.status === "CANCELLED" && order.cancelReason === "USER") return "已取消 · 租客取消";
  return STATUS_LABELS[order.status] ?? "状态待确认";
}

function isAuthenticationFailure(error: { status: number; code?: string }): boolean {
  return error.status === 401 || error.code === "UNAUTHENTICATED";
}

function formatBeijingDate(dateString: string | null | undefined): string {
  if (!dateString) return "待确认";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date).replace(/\//g, ".");
}

export function AccountGrowthHeader({
  scope: _scope,
  growthState,
  onRetry,
  isDetailsOpen: _isDetailsOpen,
  onToggleDetails: _onToggleDetails,
  userId,
  nicknameDraft,
  pendingWrite,
}: {
  scope: string;
  growthState: MembershipGrowthViewState;
  onRetry: () => void;
  isDetailsOpen?: boolean;
  onToggleDetails?: () => void;
  userId?: string;
  nicknameDraft?: SecurityNicknameDraft;
  pendingWrite?: SecurityPendingWrite;
}) {
  const session = useUserSession();
  const name = session.displayName || "洲洲玩家";
  const firstWord = session.displayName?.trim().split(/\s+/)[0];
  const monogram = firstWord ? Array.from(firstWord).slice(0, 2).join("").toUpperCase() : null;

  const data = growthState.status === "ready" ? growthState.data : null;
  const tier: GrowthTier | null = data ? data.tier : growthState.status === "unknown" ? "UNKNOWN" : null;
  const safeTier = tier ?? "UNKNOWN";
  const tierClass = `tier-${safeTier.toLowerCase().replace("_", "-")}`;

  const activeEntitlement = data?.entitlements?.find((e) => e.state === "ACTIVE");

  return (
    <div className={`account-growth-header-wrap ${tierClass}`}>
      <div className="account-growth-header">
        <div className="account-growth-user-col">
          <span className="account-growth-avatar" aria-hidden="true">
            {monogram ?? <UserRound size={32} />}
          </span>
          <div className="account-growth-user-info">
            <span className="account-growth-welcome">欢迎回来</span>
            <div className="account-growth-name-row">
            <h2 className="account-growth-name" title={name}>{name}</h2>
            {/* 昵称编辑已从账号安全页迁到此处（Owner 裁定）：头像/昵称旁的轻量“编辑资料”入口。 */}
            {userId ? <NicknameEditEntry userId={userId} nicknameDraft={nicknameDraft} pendingWrite={pendingWrite} /> : null}
            <div className="account-growth-tier-row">
              {growthState.status === "ready" && tier ? (
                <span className="account-growth-tier-badge" data-testid="membership-tier">
                  <Crown size={12} aria-hidden="true" />
                  <span>{GROWTH_TIER_LABELS[tier]}</span>
                </span>
              ) : growthState.status === "loading" ? (
                <span className="membership-status" data-testid="membership-tier-status">正在读取会员等级…</span>
              ) : growthState.status === "unknown" ? (
                <span className="account-growth-tier-badge is-unknown" data-testid="membership-tier">
                  <Crown size={12} aria-hidden="true" />
                  <span>{GROWTH_TIER_LABELS.UNKNOWN}</span>
                </span>
              ) : (
                <div className="account-growth-error-row">
                  <span className="membership-status">会员成长暂时无法读取</span>
                  <button
                    type="button"
                    className="button secondary button--xs"
                    data-testid="retry-membership"
                    onClick={onRetry}
                  >
                    <RefreshCw size={12} aria-hidden="true" />重试
                  </button>
                </div>
              )}
            </div>
            </div>
            {activeEntitlement ? (
              <div className="account-growth-entitlement" data-testid="active-entitlement">
                <EntitlementBadge kind={activeEntitlement.kind} label={activeEntitlement.label} />
                <div className="account-entitlement-info">
                  <span className="account-entitlement-title">{activeEntitlement.label}</span>
                  <span className="account-entitlement-meta">
                    {formatScopeName(activeEntitlement.scope)} · 有效至 {formatBeijingDate(activeEntitlement.endsAt)}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="account-growth-summary-col">
          {growthState.status === "ready" && data ? (
            <div className="account-growth-summary-body">
              {data.tier === "BLACK_GOLD" ? (
                <div className="account-growth-points-block">
                  <div className="account-growth-points-label">累计成长</div>
                  <div className="account-growth-points-value">
                    <strong>{data.lifetimePoints}</strong>
                    <span>积分</span>
                  </div>
                  <div className="account-growth-subnote">终身资格已获得</div>
                </div>
              ) : data.grace.state === "ACTIVE" ? (
                <div className="account-growth-points-block">
                  <div className="account-growth-points-label">近90天成长</div>
                  <div className="account-growth-points-value">
                    <strong>{data.rollingPoints}</strong>
                    <span>积分</span>
                  </div>
                  <div className="account-growth-subnote">
                    保级中 · 需 {data.grace.gapPoints ?? "待确认"} 积分 · 截止 {formatBeijingDate(data.grace.until)}
                  </div>
                </div>
              ) : data.tier === "DIAMOND" ? (
                <div className="account-growth-points-block">
                  <div className="account-growth-points-label">近90天成长</div>
                  <div className="account-growth-points-value">
                    <strong>{data.rollingPoints}</strong>
                    <span>积分</span>
                  </div>
                  <div className="account-growth-subnote">当前成长档位已确认</div>
                </div>
              ) : (
                <div className="account-growth-points-block">
                  <div className="account-growth-points-label">近90天成长</div>
                  <div className="account-growth-points-value">
                    <strong>{data.rollingPoints}</strong>
                    <span>积分</span>
                  </div>
                  <div className="account-growth-subnote">
                    {data.nextTier
                      ? `距${GROWTH_TIER_LABELS[data.nextTier.tier]} ${data.nextTier.remaining} 积分`
                      : "成长正常推进中"}
                  </div>
                </div>
              )}
              <Link
                className="account-growth-action-link"
                href="/account?view=membership"
                scroll={false}
              >
                <span>查看成长与权益</span>
                <ChevronRight size={14} aria-hidden="true" />
              </Link>
            </div>
          ) : growthState.status === "loading" ? (
            <div className="account-growth-summary-feedback">正在读取成长数据…</div>
          ) : growthState.status === "unknown" ? (
            <div className="account-growth-summary-feedback">{growthState.message}</div>
          ) : (
            <div className="account-growth-summary-feedback">
              {growthState.status === "permission" ? growthState.message : "成长档案暂时无法读取"}
            </div>
          )}
        </div>

        <div className="account-growth-card-col">
          <GrowthMemberCardArt tier={growthState.status === "ready" ? tier : null} />
        </div>
      </div>
    </div>
  );
}

function formatGuaranteeSummary(guarantees: CreditGuarantee[]): string {
  if (guarantees.length === 0) return "按出租账号查看保证金要求";
  if (guarantees.some((g) => g.state === "REQUIRED")) return "待补号主保证金";
  if (guarantees.some((g) => g.state === "PAYMENT_PENDING")) return "保证金支付结果待确认";
  if (guarantees.some((g) => g.state === "REFUND_REQUESTED" || g.state === "REFUND_PROCESSING")) return "保证金退还处理中";
  if (guarantees.some((g) => g.state === "FAILED")) return "保证金状态待核";
  if (guarantees.some((g) => g.state === "UNKNOWN")) return "按出租账号查看保证金要求";
  if (guarantees.every((g) => g.state === "REFUNDED")) return "号主保证金已原路退还";
  if (guarantees.every((g) => g.state === "SATISFIED")) return "号主保证金已覆盖";
  if (guarantees.every((g) => g.state === "NOT_REQUIRED")) return "当前无需缴纳号主保证金";
  return "按出租账号查看保证金要求";
}

export function AccountOverviewStrip({
  scope,
  phone,
  identity,
  identityPhase,
  onRetry,
}: {
  scope: string;
  phone: string | null;
  identity: UserIdentitySnapshot | null;
  identityPhase: "loading" | "ready" | "error";
  onRetry?: () => void;
}) {
  const session = useUserSession();
  const [walletState, setWalletState] = useState<{
    scope: string;
    loading: boolean;
    wallet: WalletRead | null;
    error: WalletRequestError | null;
  }>({
    scope,
    loading: true,
    wallet: null,
    error: null,
  });
  const [creditState, setCreditState] = useState<{
    scope: string;
    loading: boolean;
    data: CreditOverview | null;
    error: string;
  }>({
    scope,
    loading: true,
    data: null,
    error: "",
  });
  const sequence = useRef(0);

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setWalletState({ scope, loading: true, wallet: null, error: null });
    setCreditState({ scope, loading: true, data: null, error: "" });

    if (session.userId) {
      readMyWallet(session.userId, controller.signal).then(
        (wallet) => {
          if (current === sequence.current) setWalletState({ scope, loading: false, wallet, error: null });
        },
        (error: unknown) => {
          if (controller.signal.aborted || current !== sequence.current) return;
          const e = error instanceof WalletRequestError ? error : new WalletRequestError(0, "NETWORK_ERROR");
          if (isAuthenticationFailure(e)) session.revalidate();
          setWalletState({ scope, loading: false, wallet: null, error: e });
        }
      );
    } else {
      setWalletState({ scope, loading: false, wallet: null, error: null });
    }

    readMyCredit(controller.signal).then(
      (data) => {
        if (current === sequence.current) setCreditState({ scope, loading: false, data, error: "" });
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        if (error instanceof CreditRequestError && isAuthenticationFailure(error)) {
          session.revalidate();
        }
        const msg = error instanceof CreditRequestError && error.status === 401
          ? "登录状态已变化"
          : "信用与保证金暂时无法读取";
        setCreditState({ scope, loading: false, data: null, error: msg });
      }
    );

    return () => controller.abort();
  }, [scope, session.userId]);

  const isWalletCurrent = walletState.scope === scope;
  const isCreditCurrent = creditState.scope === scope;

  const walletDisplay = !isWalletCurrent || walletState.loading
    ? "正在读取余额"
    : walletState.wallet
    ? walletMoney(walletState.wallet.buckets.available.amountCents)
    : "钱包暂时无法读取";

  const walletNote = isWalletCurrent && walletState.wallet
    ? walletState.wallet.buckets.available.knowledge === "UNKNOWN"
      ? "可用金额尚未确认"
      : "可用余额"
    : "余额以钱包记录为准";

  const creditScore = !isCreditCurrent || creditState.loading
    ? "--"
    : typeof creditState.data?.credit?.score === "number"
    ? String(creditState.data.credit.score)
    : "--";

  const creditNote = !isCreditCurrent || creditState.loading
    ? "正在读取信用分…"
    : creditState.error
    ? creditState.error === "登录状态已变化" ? creditState.error : "请前往详情重新读取"
    : creditState.data?.creditState === "NOT_INITIALIZED"
    ? "信用档案尚未初始化"
    : formatGuaranteeSummary(creditState.data?.guarantees ?? []);

  const isVerified = identityPhase === "ready" && identity?.identityStatus === "VERIFIED";
  const hasPhone = Boolean(phone);
  const walletIsAmount = isWalletCurrent && !walletState.loading && walletState.wallet?.buckets.available.knowledge === "KNOWN";
  const creditIsLoading = !isCreditCurrent || creditState.loading;
  const score = creditState.data?.credit?.score;
  const creditIsKnown = !creditIsLoading && typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= 100;

  return (
    <div className="account-overview-strip">
      <div className="overview-strip-col wallet-col account-wallet-preview">
        <div className="strip-col-icon" aria-hidden="true"><CreditCard size={22} /></div>
        <div className="strip-col-main">
          <div className="strip-col-header">
            <h3>我的钱包</h3>
          </div>
          <div className="strip-col-body">
            <strong className={`strip-col-value${walletIsAmount ? "" : " is-status"}`} data-testid="wallet-summary-amount">{walletDisplay}</strong>
            <p className="strip-col-note">{walletNote}</p>
          </div>
          <Link className="strip-col-link" href="/account?view=wallet" scroll={false}>
            <span>查看钱包</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="overview-strip-col credit-col account-credit-preview">
        <div className="strip-col-icon" aria-hidden="true"><ShieldCheck size={22} /></div>
        <div className="strip-col-main">
          <div className="strip-col-header">
            <h3>信用与号主保证金</h3>
          </div>
          <div className="strip-col-body">
            {creditIsKnown ? (
              <div className="credit-gauge" data-state={score === 100 ? "full" : "known"} role="meter" aria-label="信用分" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-valuetext={`${creditScore}分，满分100分`}>
                <svg viewBox="0 0 148 82" aria-hidden="true">
                  <path className="credit-gauge-track" d="M14 66 A60 60 0 0 1 134 66" pathLength="100" />
                  <path className="credit-gauge-fill" d="M14 66 A60 60 0 0 1 134 66" pathLength="100" strokeDasharray={`${score} 100`} />
                  <text x="14" y="80">0</text><text x="134" y="80">100</text>
                </svg>
                <strong className="strip-credit-number">{creditScore}<small>分</small></strong>
              </div>
            ) : (
              <p className="strip-value-status" role="status">
                <span className="account-status-dot" aria-hidden="true" />
                {creditIsLoading ? "正在读取信用分…" : creditState.error ? "暂时无法读取" : "信用分待确认"}
              </p>
            )}
            <p className="strip-col-note">{creditNote}</p>
          </div>
          <Link className="strip-col-link" href="/account?view=credit" scroll={false}>
            <span>查看详情</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="overview-strip-col security-col account-status-panel">
        <div className="strip-col-icon" aria-hidden="true"><Shield size={22} /></div>
        <div className="strip-col-main">
          <div className="strip-col-header">
            <h3>实名与安全</h3>
          </div>
          <div className="strip-col-body">
          {identityPhase === "error" ? (
            <div className="account-status-retry" role="alert">
              <span>账号状态暂无法读取</span>
              {onRetry ? (
                <button type="button" className="button secondary button--xs" onClick={onRetry}>
                  重试
                </button>
              ) : null}
            </div>
          ) : identityPhase === "loading" ? (
            <div className="strip-security-status-row" role="status">
              <span className="strip-status-pill is-loading">正在读取账号状态…</span>
            </div>
          ) : (
            <div className="strip-security-status-row">
              {identity && identity.accountStatus !== "ACTIVE" ? (
                <>
                  <span className="strip-status-pill is-attention">
                    {accountStatusLabel(identity.accountStatus)}
                  </span>
                </>
              ) : null}
              <span className={`strip-status-pill ${isVerified ? "is-ok" : "is-attention"}`}>
                {identity ? identityStatusLabel(identity.identityStatus) : "尚未验证"}
              </span>
              <span className={`strip-status-pill ${hasPhone ? "is-ok" : "is-attention"}`}>
                {hasPhone ? "手机已绑定" : "未绑定手机"}
              </span>
            </div>
          )}
          <p className="strip-col-note">
            {identityPhase === "loading"
              ? "正在读取手机绑定信息…"
              : phone
              ? `绑定手机 ${maskPhone(phone)}`
              : identityPhase === "error" ? "信息尚未确认，请重新读取" : "绑定手机可提高账号安全等级"}
          </p>
          {identityPhase === "ready" && identity?.provider === "fake" ? (
            <p className="account-status-note">实名状态来自本地测试环境</p>
          ) : null}
          </div>
          <Link className="strip-col-link" href="/account?view=security" scroll={false}>
            <span>查看账号安全</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </div>
  );
}

export type PendingTaskItem = {
  id: string;
  type: "renter" | "owner" | "supply";
  tagLabel: string;
  title: string;
  description: string;
  buttonText: string;
  href: string;
};

export function AccountPendingTasks({
  scope: _scope,
  renterStatus = "ready",
  ownerStatus = "ready",
  renterOrders,
  ownerOrders: _ownerOrders,
  hasMore = false,
  onRetry,
}: {
  scope?: string;
  renterStatus?: "loading" | "ready" | "error";
  ownerStatus?: "loading" | "ready" | "error";
  renterOrders: Order[];
  ownerOrders: Order[];
  hasMore?: boolean;
  onRetry?: () => void;
}) {
  const items: PendingTaskItem[] = [];

  for (const order of renterStatus === "ready" ? renterOrders : []) {
    if (!order.readOnly && order.source?.origin !== "LEGACY" && order.status === "PENDING_PAYMENT" && !order.expiredAwaitingCancel) {
      items.push({
        id: `renter-${order.id}`,
        type: "renter",
        tagLabel: "租入",
        title: `订单待付款${order.displayNo ? ` · ${order.displayNo}` : ""}`,
        description: `完成付款后继续订单 · ${order.title ?? "账号租赁"}`,
        buttonText: "去付款",
        href: accountSectionHref("rentals", { view: "rentals", orderId: order.id, status: order.status }),
      });
    }
  }

  // Owner PAID orders are not added as delivery confirmation tasks because list DTO does not provide delivery verification facts.

  const isLoading = renterStatus === "loading" || ownerStatus === "loading";
  const hasError = renterStatus === "error" || ownerStatus === "error";
  const errorMessage = renterStatus === "error" && ownerStatus === "error"
    ? "待处理事项暂时无法读取。"
    : `${renterStatus === "error" ? "租入" : "出租"}订单暂时无法读取，待处理事项尚未完整确认。`;

  if (!isLoading && !hasError && items.length === 0) return null;

  return (
    <section className={`account-pending-card${!isLoading && !hasError && items.length === 0 ? " is-empty" : ""}`} aria-labelledby="pending-tasks-heading">
      <div className="account-pending-header">
        <div className="account-pending-title-group">
          <h3 id="pending-tasks-heading">近期订单提醒</h3>
        </div>
        <div className="account-pending-header-links">
          <Link className="account-pending-more-link" href="/account?view=rentals" scroll={false}>
            <span>租入订单</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
          <span className="account-pending-divider">·</span>
          <Link className="account-pending-more-link" href="/account?view=leased" scroll={false}>
            <span>出租订单</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="account-pending-empty" role="status">
          <p>正在读取待处理事项…</p>
        </div>
      ) : null}
      {hasError ? (
        <div className="account-pending-empty" role="alert">
          <p>{errorMessage}</p>
          {onRetry ? (
            <button type="button" className="button secondary button--xs" onClick={onRetry}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {items.length > 0 ? (
        <div className="account-pending-list">
          {items.map((item) => (
            <div key={item.id} className="account-pending-row">
              <span className="account-pending-icon" aria-hidden="true">
                {item.type === "renter" ? <FileText size={18} /> : <House size={18} />}
              </span>
              <span className={`account-pending-tag tag-${item.type}`}>{item.tagLabel}</span>
              <div className="account-pending-info">
                <strong className="account-pending-item-title">{item.title}</strong>
                <span className="account-pending-item-desc">{item.description}</span>
              </div>
              <Link
                className={`button ${item.type === "renter" ? "primary" : "secondary"} button--xs account-pending-btn`}
                href={item.href}
                scroll={false}
              >
                {item.buttonText}
              </Link>
            </div>
          ))}
        </div>
      ) : !isLoading && !hasError ? (
        <div className="account-pending-empty account-pending-clear">
          <CheckCircle2 size={18} aria-hidden="true" /><p>已读取的近期订单暂无待处理事项。</p>
        </div>
      ) : null}
      {hasMore ? (
        <p className="account-order-more-hint">仅汇总每类最近 3 笔订单，更多事项请查看订单列表。</p>
      ) : null}
    </section>
  );
}

function summaryOrderTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间暂不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Shanghai", hourCycle: "h23",
  }).format(date);
}

export function OrderSummaryCard({
  party,
  scope,
  refreshVersion = 0,
  onStatusChange,
}: {
  party: OrderParty;
  scope: string;
  refreshVersion?: number;
  onStatusChange?: (status: "loading" | "ready" | "error", items: Order[], hasMore: boolean) => void;
}) {
  const session = useUserSession();
  const revalidate = session.revalidate;
  const rental = party === "renter";
  const title = rental ? "我的租入" : "我的出租";
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{
    scope: string;
    status: "loading" | "ready" | "error";
    page: OrderPage | null;
    error: OrderRequestError | null;
  }>({
    scope,
    status: "loading",
    page: null,
    error: null,
  });
  const sequence = useRef(0);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  if (state.scope !== scope) setState({ scope, status: "loading", page: null, error: null });

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setState({ scope, status: "loading", page: null, error: null });
    onStatusChangeRef.current?.("loading", [], false);
    orderApi.listUnified({ party, limit: 3 }, controller.signal).then(
      (page) => {
        if (!controller.signal.aborted && current === sequence.current) {
          setState({ scope, status: "ready", page, error: null });
          onStatusChangeRef.current?.("ready", page.items, Boolean(page.nextCursor));
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        const failure = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
        if (isAuthenticationFailure(failure)) revalidate();
        setState({ scope, status: "error", page: null, error: failure });
        onStatusChangeRef.current?.("error", [], false);
      }
    );
    return () => controller.abort();
  }, [party, scope, reload, refreshVersion, revalidate]);

  const page = state.page;
  const items = page?.items.slice(0, 3) ?? [];
  const href = accountSectionHref(rental ? "rentals" : "leased", { view: "overview" });
  const headerActionText = rental ? "全部租入订单" : "全部出租订单";

  return (
    <article
      className={`account-summary-card${state.status === "ready" && items.length === 0 ? " is-empty" : ""}`}
      data-testid={`order-summary-${party}`}
      aria-busy={state.status === "loading" ? true : undefined}
    >
      <header className="account-summary-heading">
        <div className="account-summary-heading-left">
          <span className="account-summary-icon" aria-hidden="true">
            {rental ? <FileText size={20} /> : <House size={20} />}
          </span>
          <h3>{title}</h3>
        </div>
        <Link className="account-summary-header-link" href={href} scroll={false}>
          {headerActionText}<ChevronRight size={14} aria-hidden="true" />
        </Link>
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
          <div className="account-summary-empty" role="status">
            {/* Approved empty-state art, one per party. Decorative only: the copy and the action below
                carry the meaning, and the block still reads if the picture cannot load. */}
            <img
              className="account-summary-empty-art"
              src={rental ? "/art/empty/rental-discover-r1.webp" : "/art/empty/owner-orders-r1.webp"}
              alt=""
              width={132}
              height={99}
              loading="lazy"
              onError={(event) => { event.currentTarget.style.display = "none"; }}
            />
            <p className="account-summary-empty-title">{rental ? "暂无租入记录" : "暂无出租记录"}</p>
            <span className="account-summary-empty-desc">
              {rental
                ? "租入后，可在这里查看订单进度。"
                : "发布账号，在这里查看后续出租订单。"}
            </span>
            <Link
              className="account-summary-empty-cta"
              href={rental ? "/accounts" : "/publish"}
            >
              {rental ? "浏览账号" : "发布账号"}<ChevronRight size={14} aria-hidden="true" />
            </Link>
          </div>
        ) : null}
        {state.status === "ready" && items.length > 0 ? (
          <div className="account-recent-orders-list">
            {items.map((order) => {
              const orderHref = orderUrl(party, "", undefined, order.id, order.source?.origin);
              return (
                <Link key={orderItemKey(order)} className="account-order-row" href={orderHref} scroll={false}>
                  <div className="account-order-row-main">
                    <strong className="account-order-row-title">{order.title ?? "账号信息暂不可用"}</strong>
                    <div className="account-order-row-meta">
                      {order.displayNo ? <span>单号 {order.displayNo}</span> : null}
                      {order.createdAt ? <time dateTime={order.createdAt} title={formatOrderTime(order.createdAt)} aria-label={formatOrderTime(order.createdAt)}>{summaryOrderTime(order.createdAt)}</time> : null}
                    </div>
                  </div>
                  <div className="account-order-row-end">
                    <span className="account-order-row-status" data-status={order.expiredAwaitingCancel ? "EXPIRING" : order.status} data-testid={`order-status-${party}`}>{coreStatus(order)}</span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </div>
                </Link>
              );
            })}
            {page?.nextCursor ? (
              <p className="account-order-more-hint">还有更多订单，打开列表查看完整记录。</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function AccountOverview({
  scope,
  userId,
  nicknameDraft,
  pendingWrite,
}: {
  scope: string;
  userId?: string;
  nicknameDraft?: SecurityNicknameDraft;
  pendingWrite?: SecurityPendingWrite;
}) {
  const session = useUserSession();
  const revalidate = session.revalidate;
  const [reload, setReload] = useState(0);
  const [orderRefresh, setOrderRefresh] = useState({ renter: 0, owner: 0 });
  const [growthState, setGrowthState] = useState<{ scope: string; value: MembershipGrowthViewState }>({
    scope,
    value: { status: "loading" },
  });
  const [status, setStatus] = useState<{
    scope: string;
    phase: "loading" | "ready" | "error";
    phone: string | null;
    identity: UserIdentitySnapshot | null;
  }>({ scope, phase: "loading", phone: null, identity: null });

  const [renterOrderSummary, setRenterOrderSummary] = useState<{
    scope: string;
    status: "loading" | "ready" | "error";
    items: Order[];
    hasMore: boolean;
  }>({ scope, status: "loading", items: [], hasMore: false });

  const [ownerOrderSummary, setOwnerOrderSummary] = useState<{
    scope: string;
    status: "loading" | "ready" | "error";
    items: Order[];
    hasMore: boolean;
  }>({ scope, status: "loading", items: [], hasMore: false });

  const sequence = useRef(0);
  if (growthState.scope !== scope) {
    setGrowthState({ scope, value: { status: "loading" } });
  }
  if (status.scope !== scope) {
    setStatus({ scope, phase: "loading", phone: null, identity: null });
  }

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setGrowthState({ scope, value: { status: "loading" } });
    setStatus({ scope, phase: "loading", phone: null, identity: null });

    readMyMembershipGrowth(controller.signal).then(
      (value) => {
        if (current === sequence.current) setGrowthState({ scope, value });
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        const failure = error instanceof MembershipGrowthRequestError ? error : new MembershipGrowthRequestError(0, null);
        if (isAuthenticationFailure(failure)) revalidate();
        setGrowthState({
          scope,
          value: { status: "error", message: failure.message, retryable: failure.status === 0 || failure.status >= 500 },
        });
      }
    );

    (async () => {
      try {
        const profile = await webAuthRequest<{ user?: { id: string; phoneNumber?: string | null } } | null>(
          "/get-session",
          undefined,
          controller.signal
        );
        if (controller.signal.aborted || current !== sequence.current) return;
        if (profile?.user?.id !== session.userId) {
          revalidate();
          return;
        }
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

  const visibleGrowth = growthState.scope === scope ? growthState.value : { status: "loading" as const };
  const visibleStatus = status.scope === scope ? status : { scope, phase: "loading" as const, phone: null, identity: null };

  const currentRenterStatus = renterOrderSummary.scope === scope ? renterOrderSummary.status : "loading";
  const currentOwnerStatus = ownerOrderSummary.scope === scope ? ownerOrderSummary.status : "loading";
  const currentRenterOrders = renterOrderSummary.scope === scope ? renterOrderSummary.items : [];
  const currentOwnerOrders = ownerOrderSummary.scope === scope ? ownerOrderSummary.items : [];

  return (
    <div className="account-overview">
      <AccountGrowthHeader
        scope={scope}
        growthState={visibleGrowth}
        onRetry={() => setReload((v) => v + 1)}
        userId={userId}
        nicknameDraft={nicknameDraft}
        pendingWrite={pendingWrite}
      />

      <AccountOverviewStrip
        key={scope}
        scope={scope}
        phone={visibleStatus.phone}
        identity={visibleStatus.identity}
        identityPhase={visibleStatus.phase}
        onRetry={() => setReload((v) => v + 1)}
      />

      <AccountPendingTasks
        scope={scope}
        renterStatus={currentRenterStatus}
        ownerStatus={currentOwnerStatus}
        renterOrders={currentRenterOrders}
        ownerOrders={currentOwnerOrders}
        hasMore={(renterOrderSummary.scope === scope && renterOrderSummary.hasMore) || (ownerOrderSummary.scope === scope && ownerOrderSummary.hasMore)}
        onRetry={() => setOrderRefresh((v) => ({
          renter: v.renter + (currentRenterStatus === "error" ? 1 : 0),
          owner: v.owner + (currentOwnerStatus === "error" ? 1 : 0),
        }))}
      />

      <div className="account-overview-orders-row">
        <OrderSummaryCard
          party="renter"
          scope={scope}
          refreshVersion={orderRefresh.renter}
          onStatusChange={(status, items, hasMore) =>
            setRenterOrderSummary({ scope, status, items, hasMore })
          }
        />
        <OrderSummaryCard
          party="owner"
          scope={scope}
          refreshVersion={orderRefresh.owner}
          onStatusChange={(status, items, hasMore) =>
            setOwnerOrderSummary({ scope, status, items, hasMore })
          }
        />
      </div>
    </div>
  );
}

export function AccountMembershipCenter({ scope }: { scope: string }) {
  const session = useUserSession();
  const revalidate = session.revalidate;
  const [reload, setReload] = useState(0);
  const [viewState, setViewState] = useState<{ scope: string; value: MembershipGrowthViewState }>({ scope, value: { status: "loading" } });
  const sequence = useRef(0);

  if (viewState.scope !== scope) {
    setViewState({ scope, value: { status: "loading" } });
  }

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setViewState({ scope, value: { status: "loading" } });

    readMyMembershipGrowth(controller.signal).then(
      (value) => {
        if (current === sequence.current) {
          setViewState({ scope, value });
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        const failure = error instanceof MembershipGrowthRequestError ? error : new MembershipGrowthRequestError(0, null);
        if (isAuthenticationFailure(failure)) revalidate();
        setViewState({
          scope,
          value: { status: "error", message: failure.message, retryable: failure.status === 0 || failure.status >= 500 },
        });
      }
    );

    return () => controller.abort();
  }, [scope, reload, revalidate]);

  const visible = viewState.scope === scope ? viewState.value : { status: "loading" as const };

  return (
    <div className="account-membership-view">
      <MembershipCenterView key={scope} state={visible} onRetry={() => setReload((v) => v + 1)} />
    </div>
  );
}

/** F6 批准结构：面包屑由内容列自己渲染（首页 / 个人中心 / 当前页面），不再停在双栏之上。 */
export type AccountBreadcrumbItem = { label: string; href?: string };

export function AccountCenterFrame({
  active,
  accountId,
  orderId,
  status,
  scope: _scope,
  breadcrumbs = [],
  children,
}: {
  active: AccountView;
  accountId?: string;
  orderId?: string;
  status?: string;
  scope: string;
  breadcrumbs?: readonly AccountBreadcrumbItem[];
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
    active !== "overview" && active !== "membership" && active !== "rentals";

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
            href={accountSectionHref("membership", current)}
            scroll={false}
            onClick={() => onTabClick("membership")}
            aria-current={active === "membership" ? "page" : undefined}
          >
            <Crown size={18} aria-hidden="true" />
            <span>会员中心</span>
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
            {NAV_GROUPS.map((group) => {
              const moreItems = group.items.filter(
                (item) => item.section !== "overview" && item.section !== "membership" && item.section !== "rentals"
              );
              if (moreItems.length === 0) return null;
              return (
                <div key={group.title ?? "top"} className="account-nav-group">
                  {group.title ? <div className="account-nav-group-title">{group.title}</div> : null}
                  <ul>
                    {moreItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <li key={item.section}>
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
              );
            })}
          </div>
        ) : null}
      </nav>

      <aside className="account-center-side">
        <nav className="account-nav" aria-label="个人中心">
          {NAV_GROUPS.map((group) => (
            <div key={group.title ?? "top"} className="account-nav-group">
              {group.title ? <div className="account-nav-group-title">{group.title}</div> : null}
              <ul>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.section}>
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
            </div>
          ))}
        </nav>
      </aside>

      <div className="account-center-main">
        {/* F6：面包屑位于右侧内容列顶部，其下是各模块统一的“标题/说明＋右侧操作”页头。 */}
        {breadcrumbs.length > 0 ? (
          <nav className="account-breadcrumb" aria-label="当前位置">
            <ol>
              {breadcrumbs.map((item, index) => {
                const isCurrent = index === breadcrumbs.length - 1;
                return (
                  <li key={`${item.label}-${index}`} aria-current={isCurrent ? "page" : undefined}>
                    {index > 0 ? <span className="account-breadcrumb-separator" aria-hidden="true">/</span> : null}
                    {item.href && !isCurrent ? (
                      <Link href={item.href} scroll={false}>{item.label}</Link>
                    ) : (
                      <span>{item.label}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : null}
        {children}
      </div>
    </div>
  );
}
