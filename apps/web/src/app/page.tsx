export default function Home() {
  return <main className="mx-auto min-h-screen max-w-5xl px-6 py-16 md:py-28">
    <p className="text-sm font-semibold tracking-widest text-primary">洲洲商行 / 开发环境</p>
    <h1 className="mt-6 text-4xl font-semibold tracking-tight md:text-6xl">新的体验，从这里开始。</h1>
    <p className="mt-6 max-w-xl text-lg leading-8 text-muted">用户站框架已就绪。账号目录与交易流程将在业务模型确认后逐步接入。</p>
    <section aria-label="当前开发范围" className="mt-12 rounded-2xl border border-border bg-white p-8">
      <h2 className="text-xl font-semibold">当前范围</h2>
      <p className="mt-4 leading-7 text-muted">这是开发入口，不提供真实商品、登录或支付。后续交付由真人客服完成。</p>
    </section>
  </main>;
}
