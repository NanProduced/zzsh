"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  Crown,
  FileText,
  House,
  LayoutGrid,
} from "lucide-react";
import { useUserSession } from "@/components/session/user-session-provider";
import { MembershipGrowthRequestError, readMyMembershipGrowth, type MembershipGrowthViewState } from "@/lib/membership-growth-client";
import type { OrderSearchFilters } from "@/lib/order-client";
import { MembershipCenterView } from "./membership-center";
import {
  NAV_GROUPS,
  accountSectionHref,
  isAuthenticationFailure,
  type AccountLocation,
  type AccountView,
} from "./account-nav-constants";
import "./account-center.css";

export * from "./account-nav-constants";
export * from "./account-growth-header";
export * from "./account-overview-strip";
export * from "./account-pending-tasks";
export * from "./account-order-cards";
export * from "./account-overview";

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
  source,
  orderFilters,
  scope: _scope,
  breadcrumbs = [],
  children,
}: {
  active: AccountView;
  accountId?: string;
  orderId?: string;
  status?: string;
  source?: string;
  orderFilters?: OrderSearchFilters;
  scope: string;
  breadcrumbs?: readonly AccountBreadcrumbItem[];
  children: ReactNode;
}) {
  const current: AccountLocation = { view: active, accountId, orderId, status, source, orderFilters };
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
      {/* 连续面板规范：面板顶部为横跨整个面板宽度、左右区域共用的面包屑行 */}
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

      <nav className="account-mobile-tabs" aria-label="移动端个人中心导航">
        <div className="account-mobile-tabs-grid">
          <Link
            className="account-mobile-tab-btn"
            href={accountSectionHref("overview", current)}
            scroll={false}
            onClick={() => onTabClick("overview")}
            aria-current={!mobileMoreOpen && !isMoreActive && active === "overview" ? "page" : undefined}
          >
            <House size={18} aria-hidden="true" />
            <span>总览</span>
          </Link>
          <Link
            className="account-mobile-tab-btn"
            href={accountSectionHref("membership", current)}
            scroll={false}
            onClick={() => onTabClick("membership")}
            aria-current={!mobileMoreOpen && active === "membership" ? "page" : undefined}
          >
            <Crown size={18} aria-hidden="true" />
            <span>会员中心</span>
          </Link>
          <Link
            className="account-mobile-tab-btn"
            href={accountSectionHref("rentals", current)}
            scroll={false}
            onClick={() => onTabClick("rentals")}
            aria-current={!mobileMoreOpen && active === "rentals" ? "page" : undefined}
          >
            <FileText size={18} aria-hidden="true" />
            <span>租入订单</span>
          </Link>
          <button
            type="button"
            className={`account-mobile-tab-btn ${isMoreActive || mobileMoreOpen ? "is-active-parent" : ""}`}
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
                            aria-current={active === item.section || active === "rented" && item.section === "accounts" ? "page" : undefined}
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
                        aria-current={active === item.section || active === "rented" && item.section === "accounts" ? "page" : undefined}
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
        {children}
      </div>
    </div>
  );
}
