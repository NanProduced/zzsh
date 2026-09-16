import { ServiceShell } from "@/components/layout/service-shell";

export default function Page() {
  return <ServiceShell title="联系客服" description="登录后建立独立咨询会话；商品上下文、消息历史与客服状态由平台和云信共同确认。">
    <section className="support-route-handoff" aria-live="polite"><h2>客服窗口已打开</h2><p>当前页面使用全站共享的客服容器。关闭后仍可通过页面右侧“联系客服”重新打开，咨询草稿和云信客户端不会因收起而销毁。</p></section>
  </ServiceShell>;
}
