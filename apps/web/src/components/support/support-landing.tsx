"use client";
import Link from "next/link";
import { Headphones, MessageSquare, ShieldCheck } from "lucide-react";
import type { SupportType } from "@/lib/support-intent";

const ENTRIES: readonly { type: SupportType; title: string; description: string; icon: typeof Headphones }[] = [
  { type: "SERVICE", title: "在线客服", description: "商品、使用和平台服务咨询", icon: Headphones },
  { type: "COMPLAINT", title: "投诉反馈", description: "问题反馈与服务体验处理", icon: MessageSquare },
];

function requestSupport(type: SupportType) {
  // 由全局 SupportRail 监听：先过登录门再开窗，关闭后焦点回到本按钮。
  window.dispatchEvent(new CustomEvent("zzsh:open-support", { detail: { type } }));
}

export function SupportLanding() {
  return (
    <section className="support-landing" aria-labelledby="support-landing-heading">
      <h2 id="support-landing-heading">选择咨询类型</h2>
      <p>新咨询会新建独立会话；已有咨询在打开后继续。聊天记录不代替平台的确认结果。</p>
      <div className="support-landing-entries">
        {ENTRIES.map(({ type, title, description, icon: Icon }) => (
          <button key={type} type="button" className="support-landing-entry" data-support-entry={type} onClick={() => requestSupport(type)}>
            <span className="support-landing-entry-icon" aria-hidden="true"><Icon size={22} /></span>
            <span className="support-landing-entry-copy">
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
          </button>
        ))}
      </div>
      <p className="support-landing-hint">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>平台不会通过站内客服索要密码、验证码或要求线下转账。</span>
      </p>
      <p className="support-landing-links">
        先自行查看 <Link href="/help">帮助中心</Link> 中的租号流程、费用与规则说明。
      </p>
    </section>
  );
}
