"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { serviceLinks } from "../../lib/service-navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Crown, Menu, UserRound, X } from "lucide-react";
import { BrandLogo } from "@/components/brand/brand-logo";
import { useUserSession } from "@/components/session/user-session-provider";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { readMyMembershipGrowth, type GrowthTier, type MembershipGrowthViewState } from "../../lib/membership-growth-client";

// Sheet composition using the same modal primitive as shadcn's Radix Sheet.
const navigationLinks: readonly (readonly [string, string])[] = [
  ["首页", "/"],
  ["游戏专区", "/#delta-section"],
  ...serviceLinks.map((s) => [s.title, s.href] as const),
  ["帮助中心", "/help"],
];

const TIER_LABELS: Record<string, string> = {
  STANDARD: "普通会员",
  SILVER: "银卡会员",
  GOLD: "金卡会员",
  PLATINUM: "铂金会员",
  DIAMOND: "钻石会员",
  BLACK_GOLD: "黑金会员 · 终身",
  UNKNOWN: "普通会员",
};

function MobileSessionEntry({ onSignIn }: { onSignIn: () => void }) {
  const session = useUserSession();
  const [growth, setGrowth] = useState<MembershipGrowthViewState>({ status: "loading" });

  useEffect(() => {
    if (session.status !== "authenticated") return;
    const controller = new AbortController();
    readMyMembershipGrowth(controller.signal).then(
      (res) => {
        if (!controller.signal.aborted) setGrowth(res);
      },
      () => {
        if (!controller.signal.aborted) setGrowth({ status: "unknown", message: "" });
      }
    );
    return () => controller.abort();
  }, [session.status, session.userId, session.identityVersion]);

  if (session.status === "loading" || session.status === "error") {
    return (
      <Dialog.Close asChild>
        <button type="button" className="button secondary sheet-session" onClick={onSignIn}>
          账户
        </button>
      </Dialog.Close>
    );
  }

  if (session.status === "guest") {
    return (
      <Dialog.Close asChild>
        <button type="button" className="button primary site-menu-login" onClick={onSignIn}>
          登录 / 注册
        </button>
      </Dialog.Close>
    );
  }

  const displayName = session.displayName || "洲洲玩家";
  const firstWord = session.displayName?.trim().split(/\s+/)[0];
  const monogram = firstWord ? Array.from(firstWord).slice(0, 2).join("").toUpperCase() : null;

  const tier: GrowthTier = growth.status === "ready" ? growth.data.tier : "UNKNOWN";
  const tierLabel = growth.status === "ready" ? (TIER_LABELS[growth.data.tier] ?? "普通会员") : growth.status === "loading" ? "会员读取中…" : "普通会员";
  const rollingPoints = growth.status === "ready" ? growth.data.rollingPoints : null;

  return (
    <div className="sheet-user-card" data-testid="sheet-user-card">
      <div className="sheet-user-hero">
        <div className="sheet-user-avatar" aria-hidden="true">
          {monogram ?? <UserRound size={22} />}
        </div>
        <div className="sheet-user-info">
          <div className="sheet-user-name-row">
            <strong className="sheet-user-name" title={displayName}>
              {displayName}
            </strong>
          </div>
          <div className="sheet-user-meta-row">
            <span className="sheet-user-tier-badge" data-tier={tier.toLowerCase().replace("_", "-")}>
              <Crown size={12} aria-hidden="true" />
              <span>{tierLabel}</span>
            </span>
            {session.userId ? (
              <span className="sheet-user-uid">ID: {session.userId.replace(/^user_/, "").slice(0, 8)}</span>
            ) : null}
            {rollingPoints ? (
              <span className="sheet-user-points">
                {growth.status === "ready" && growth.data.tier === "BLACK_GOLD"
                  ? "终身资格"
                  : `${rollingPoints} 积分`}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="sheet-user-actions">
        <Dialog.Close asChild>
          <Link className="button outline sheet-action-btn sheet-action-primary" href="/account">
            个人中心
          </Link>
        </Dialog.Close>
        <button
          className="button outline sheet-action-btn sheet-action-signout"
          type="button"
          onClick={() => {
            void session.signOut().catch(() => undefined);
          }}
        >
          退出登录
        </button>
      </div>
    </div>
  );
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const authOverlay = useAuthOverlay();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const signInPending = useRef(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button ref={triggerRef} className="icon-button mobile-menu" aria-label="打开导航菜单">
          <Menu size={22} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="nav-sheet site-nav-sheet"
          onCloseAutoFocus={(event) => {
            if (!signInPending.current) return;
            // Finish the sheet focus scope before handing focus to the authentication dialog.
            event.preventDefault();
            signInPending.current = false;
            triggerRef.current?.focus();
            authOverlay.open();
          }}
        >
          <div className="sheet-heading">
            <BrandLogo height={38} />
            <Dialog.Close className="icon-button" aria-label="关闭菜单">
              <X size={22} />
            </Dialog.Close>
          </div>
          <Dialog.Title className="sr-only">移动端菜单</Dialog.Title>
          <Dialog.Description className="sr-only">移动端导航与用户个人中心入口</Dialog.Description>
          <MobileSessionEntry
            onSignIn={() => {
              signInPending.current = true;
            }}
          />
          <nav aria-label="移动端主导航">
            {navigationLinks.map(([label, href]) => (
              <Dialog.Close key={label} asChild>
                <Link href={href}>{label}</Link>
              </Dialog.Close>
            ))}
          </nav>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
