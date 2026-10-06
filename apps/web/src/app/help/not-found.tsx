import Link from "next/link";
import { HelpShell } from "@/components/help/help-shell";
import "@/components/help/help.css";

export default function NotFound() {
  return (
    <HelpShell
      title="帮助中心"
      breadcrumbs={[{ label: "首页", href: "/" }, { label: "帮助中心", href: "/help" }, { label: "页面不存在" }]}
    >
      <div className="help-not-found">
        <div className="help-empty">
          <h2>没有找到这篇帮助文档</h2>
          <p>链接可能已失效或文章已更新。你可以返回帮助中心按分类浏览，或搜索相关说明。</p>
          <div className="help-empty-actions">
            <Link className="help-contact-cta" href="/help">返回帮助中心</Link>
            <Link className="help-contact-cta" href="/support">联系平台客服</Link>
          </div>
        </div>
      </div>
    </HelpShell>
  );
}
