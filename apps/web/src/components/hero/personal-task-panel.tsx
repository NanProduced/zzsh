"use client";
import { useUserSession } from "../session/user-session-provider";
import Link from "next/link";
import { UserRound, Package, Upload, Heart, LayoutGrid, ArrowUpRight } from "lucide-react";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";

export function PersonalTaskPanel() {
  const session = useUserSession();
  const authOverlay = useAuthOverlay();
  const authenticated = session.status === "authenticated";
  return (
    <aside className="personal-panel personal-workspace b1-panel" aria-label="个人事务">
      <div className="b1-visitor">
        <div className="b1-avatar-wrap">
          <UserRound size={20} />
          
        </div>
        <div className="b1-visitor-text">
          <strong className="b1-visitor-title">{authenticated ? `你好，${session.displayName ?? "洲洲用户"}` : "你好，欢迎来到洲洲"}</strong>
          <small className="b1-visitor-desc">{authenticated ? "查看你的账号与收藏" : "查看租赁任务与账号收藏"}</small>
        </div>
      </div>
      <div className="b1-shortcuts">
        <Link href="/account?view=rentals" className="b1-shortcut">
          <Package size={20} />
          <span>租入订单</span>
        </Link>
        <Link href="/account?view=leased" className="b1-shortcut">
          <Upload size={20} />
          <span>出租订单</span>
        </Link>
        <Link href="/account?view=accounts" className="b1-shortcut">
          <LayoutGrid size={20} />
          <span>账号管理</span>
        </Link>
        <Link href="/account?view=favorites" className="b1-shortcut">
          <Heart size={20} />
          <span>我的收藏</span>
        </Link>
      </div>
      {authenticated ? <Link className="b1-signin" href="/account?view=accounts">
        <span>{authenticated ? "进入个人中心" : session.status === "guest" ? "登录 / 注册" : "账户"}</span>
        <ArrowUpRight size={16} />
      </Link> : <button type="button" className="b1-signin" onClick={() => authOverlay.open()}><span>{session.status === "guest" ? "登录 / 注册" : "账户"}</span><ArrowUpRight size={16} /></button>}
      <div className="b1-guides">
        <Link href="/help#rental-guide" className="b1-guide-link">租号指南</Link>
        <Link href="/help#publish-guide" className="b1-guide-link">上架指南</Link>
      </div>
    </aside>
  );
}
