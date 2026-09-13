import Link from "next/link";
import { UserRound, Package, Upload, Heart, LayoutGrid, ArrowUpRight } from "lucide-react";
export function PersonalTaskPanel() {
  return <aside className="personal-panel personal-workspace" aria-label="个人事务">
    <div className="visitor"><UserRound size={28}/><div><strong>你好，欢迎来到洲洲</strong><small>登录后查看租赁任务</small></div></div>
    <div className="personal-shortcuts">
      {([{label:'租入订单',view:'rentals',Icon:Package},{label:'出租订单',view:'leased',Icon:Upload},{label:'账号管理',view:'accounts',Icon:LayoutGrid},{label:'我的收藏',view:'favorites',Icon:Heart}]).map(({label,view,Icon})=><Link href={`/account?view=${view}`} key={view}><Icon size={19}/><span>{label}</span></Link>)}
    </div>
    <Link className="button primary personal-signin" href="/login">登录 / 注册<ArrowUpRight size={16}/></Link>
    <div className="personal-guides"><Link href="/help#rental-guide">租号指南</Link><Link href="/help#publish-guide">上架指南</Link></div>
  </aside>;
}
