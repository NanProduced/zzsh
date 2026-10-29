"use client";

import Link from "next/link";

export default function HelpError({ reset }: { reset: () => void }) {
  return <section className="container section-panel" role="alert">
    <h1>帮助内容暂时无法读取</h1>
    <p>当前说明未能加载，请稍后重试。订单的实际金额、状态和适用条款仍以订单页面为准。</p>
    <div className="flex gap-3"><button type="button" className="button secondary" onClick={reset}>重试读取</button><Link href="/">返回首页</Link></div>
  </section>;
}
