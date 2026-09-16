"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, useMotionValueEvent, useScroll } from "motion/react";
import { Search, UserRound, X } from "lucide-react";
import { BrandLogo } from "@/components/brand/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { useUserSession } from "@/components/session/user-session-provider";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { MobileNav } from "./mobile-nav";
import "./header-footer.css";

function SessionEntry() {
  const session = useUserSession();
  const authOverlay = useAuthOverlay();
  if (session.status === "loading" || session.status === "error") {
    return <button type="button" className="site-login" onClick={() => authOverlay.open()} aria-label="账户"><UserRound size={18} aria-hidden="true" /><span>账户</span></button>;
  }
  if (session.status === "guest") {
    return (
      <button type="button" className="site-login" onClick={() => authOverlay.open()} aria-label="登录">
        <UserRound size={18} aria-hidden="true" />
        <span>登录</span>
      </button>
    );
  }
  return (
    <span className="site-session">
      <Link className="site-login" href="/account" title={session.displayName ?? "个人中心"}>
        <UserRound size={18} aria-hidden="true" />
        <span className="site-session-name">{session.displayName ?? "个人中心"}</span>
      </Link>
      <button type="button" className="site-signout" onClick={() => { void session.signOut().catch(() => undefined); }}>
        退出
      </button>
    </span>
  );
}

// Adapted from Aceternity Resizable Navbar; keep the search mounted across states.
export function PortalHeader({ query, onQueryChange, onSearch, home=true, searchLabel = "搜索当前账号", searchInputLabel = "搜索账号编号或名称", searchPlaceholder = "搜索当前展示账号", searchCompactPlaceholder = "搜索账号或关键字..." }: { query: string; onQueryChange: (value: string) => void; onSearch?:(query:string)=>void; home?:boolean; searchLabel?: string; searchInputLabel?: string; searchPlaceholder?: string; searchCompactPlaceholder?: string }) {
  const { scrollY } = useScroll();
  const [reducedMotion,setReducedMotion]=useState(true);
  const [scrollPosition, setScrollPosition] = useState(0);
  const [desktop, setDesktop] = useState(false);
  const [navFocused, setNavFocused] = useState(false);
  useEffect(() => {
    const preference=matchMedia("(prefers-reduced-motion: reduce)");
    const motionChange=()=>setReducedMotion(preference.matches);
    motionChange();preference.addEventListener("change",motionChange);
    const media = matchMedia("(min-width: 1100px) and (hover: hover) and (pointer: fine)");
    const update = () => setDesktop(media.matches);
    update();
    setScrollPosition(window.scrollY > 100 ? 101 : window.scrollY > 0 ? 1 : 0);
    media.addEventListener("change", update);
    return () => {media.removeEventListener("change", update);preference.removeEventListener("change",motionChange);};
  }, []);
  useMotionValueEvent(scrollY, "change", (value) => setScrollPosition(value > 100 ? 101 : value > 0 ? 1 : 0));
  const compact = desktop && scrollPosition > 100 && !navFocused;
  return <header className="site-header" data-compact={compact} data-scrolled={scrollPosition > 0 || !home || navFocused}>
    <motion.div
      className="site-header-bar"
      initial={false}
      animate={{ maxWidth: compact ? 1060 : 1320, y: compact ? 10 : 0, borderRadius: compact ? 20 : 0 }}
      transition={reducedMotion || !desktop ? { duration: 0 } : { type: "spring", stiffness: 200, damping: 50 }}
    >
      <Link className="site-brand" href="/" aria-label="洲洲商行首页"><BrandLogo height={42} /></Link>
      <nav className="site-desktop-nav" aria-label="全局主导航" onFocusCapture={() => setNavFocused(true)} onBlurCapture={() => setNavFocused(false)}>
        {!compact && <Link href="/" aria-current={home ? "page" : undefined}>首页</Link>}
        <Link href="/#delta-section">游戏专区</Link>
        <Link href="/help">帮助中心</Link>
      </nav>

      <form
        className="site-search"
        role="search"
        aria-label={searchLabel}
        onSubmit={(event) => {
          event.preventDefault();
          if (onSearch) { onSearch(query); return; }
          const results = document.getElementById("account-list");
          results?.focus({ preventScroll: true });
          results?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        }}
      >
        <Search size={16} style={{ color: "var(--color-accent-brand)", opacity: 0.9, flexShrink: 0 }} aria-hidden="true" />
        <input
          type="search"
          aria-label={searchInputLabel}
          placeholder={compact ? searchCompactPlaceholder : searchPlaceholder}
          maxLength={120}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query && (
          <button className="site-search-clear" type="button" aria-label="清空搜索" onClick={() => onQueryChange("")}>
            <X size={14} />
          </button>
        )}
        <button className="site-search-submit" type="submit">
          <Search size={13} strokeWidth={2.5} />
          <span>搜索</span>
        </button>
      </form>

      <div className="site-header-actions">
        <SessionEntry />
        <ThemeToggle /><MobileNav />
      </div>
    </motion.div>
  </header>;

}
