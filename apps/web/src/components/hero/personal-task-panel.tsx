"use client";
import { useUserSession } from "../session/user-session-provider";
import Link from "next/link";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { UserRound, Package, Upload, Heart, LayoutGrid, ArrowUpRight, ChevronRight, BookOpen, FileText } from "lucide-react";

export function PersonalTaskPanel() {
  const session = useUserSession();
  const authOverlay = useAuthOverlay();
  const authenticated = session.status === "authenticated";
  return (
    <aside className="personal-panel personal-workspace b1-panel" aria-label="个人事务">
      <div className="b1-visitor">
        <div className="b1-avatar-wrap" aria-hidden="true"><UserRound size={20} /><img src="/art/zhouzhou/avatar.webp" alt="" width={40} height={40} onError={event => { event.currentTarget.style.display = "none"; }} /></div>
        <strong className="b1-visitor-title">{authenticated ? `你好，${session.displayName ?? "洲洲用户"}` : "Hi~欢迎来到洲洲"}</strong>
        {authenticated ? <Link className="b1-account-link" href="/account?view=accounts">账户<ArrowUpRight size={14} aria-hidden="true" /></Link> : <button type="button" className="b1-account-link" onClick={() => authOverlay.open()}>登录/注册<ArrowUpRight size={14} aria-hidden="true" /></button>}
      </div>
      <div className="b1-actions">
        <Link href="/accounts" className="b1-action">
          <img src="/images/service-icons/rent-pass.webp" width={48} height={48} alt="" draggable={false} />
          <span>我要租<ChevronRight size={14} aria-hidden="true" /></span>
        </Link>
        <Link href="/publish" className="b1-action">
          <img src="/images/service-icons/publish-stand.webp" width={48} height={48} alt="" draggable={false} />
          <span>我要上架<ChevronRight size={14} aria-hidden="true" /></span>
        </Link>
      </div>
      <div className="b1-shortcuts">
        <Link href="/account?view=rentals" className="b1-shortcut"><Package size={18} aria-hidden="true" /><span>租入订单</span></Link>
        <Link href="/account?view=leased" className="b1-shortcut"><Upload size={18} aria-hidden="true" /><span>出租订单</span></Link>
        <Link href="/account?view=accounts" className="b1-shortcut"><LayoutGrid size={18} aria-hidden="true" /><span>账号管理</span></Link>
        <Link href="/account?view=favorites" className="b1-shortcut"><Heart size={18} aria-hidden="true" /><span>我的收藏</span></Link>
      </div>
      <div className="b1-guides">
        <Link href="/help#rental-guide" className="b1-guide-link"><BookOpen size={14} aria-hidden="true" />租号指南</Link>
        <Link href="/help#publish-guide" className="b1-guide-link"><FileText size={14} aria-hidden="true" />上架指南</Link>
      </div>
    </aside>
  );
}

