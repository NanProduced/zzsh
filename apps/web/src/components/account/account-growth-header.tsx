"use client";

import Link from "next/link";
import { ChevronRight, Crown, RefreshCw, UserRound } from "lucide-react";
import { useUserSession } from "@/components/session/user-session-provider";
import type { GrowthTier, MembershipGrowthViewState } from "@/lib/membership-growth-client";
import { EntitlementBadge, formatScopeName, GrowthMemberCardArt, GROWTH_TIER_LABELS } from "./membership-center";
import { NicknameEditEntry } from "./nickname-edit";
import { AvatarEditEntry } from "./avatar-edit";
import type { SecurityNicknameDraft, SecurityPendingWrite } from "./account-security-controls";

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

  const activeEntitlement = (data?.entitlements ?? (growthState.status === "unknown" ? growthState.entitlements ?? [] : [])).find((e) => e.state === "ACTIVE");
  const avatar = <span className="account-growth-avatar" aria-hidden="true">{session.avatarUrl ? <img src={session.avatarUrl} alt="" /> : monogram ?? <UserRound size={32} />}</span>;

  return (
    <div className={`account-growth-header-wrap ${tierClass}`}>
      <div className="account-growth-header">
        <div className="account-growth-user-col">
          {userId ? <AvatarEditEntry userId={userId}>{avatar}</AvatarEditEntry> : avatar}
          <div className="account-growth-user-info">
            <span className="account-growth-welcome">欢迎回来</span>
            <div className="account-growth-name-row">
            <h2 className="account-growth-name" title={name}>{name}</h2>
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
                    {formatScopeName(activeEntitlement.scope, activeEntitlement.gameId, activeEntitlement.gameName)} · 有效至 {formatBeijingDate(activeEntitlement.endsAt)}
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
