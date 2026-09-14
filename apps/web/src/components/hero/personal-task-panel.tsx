import Link from "next/link";
import { UserRound, Package, Upload, Heart, LayoutGrid, ArrowUpRight } from "lucide-react";

export function PersonalTaskPanel() {
  return (
    <aside className="personal-panel personal-workspace b1-panel" aria-label="个人事务">
      <div className="b1-visitor">
        <div className="b1-avatar-wrap">
          <UserRound size={20} />
          
        </div>
        <div className="b1-visitor-text">
          <strong className="b1-visitor-title">你好，欢迎来到洲洲</strong>
          <small className="b1-visitor-desc">登录后查看租赁任务</small>
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
      <Link className="b1-signin" href="/login">
        <span>登录 / 注册</span>
        <ArrowUpRight size={16} />
      </Link>
      <div className="b1-guides">
        <Link href="/help#rental-guide" className="b1-guide-link">租号指南</Link>
        <Link href="/help#publish-guide" className="b1-guide-link">上架指南</Link>
      </div>
    </aside>
  );
}
