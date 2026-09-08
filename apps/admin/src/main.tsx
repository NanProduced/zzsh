import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
function App() {
  return <main className="mx-auto min-h-screen max-w-5xl px-6 py-16">
    <p className="text-sm font-semibold text-primary">洲洲商行 / 运营开发环境</p>
    <h1 className="mt-5 text-4xl font-semibold">运营工作台</h1>
    <p className="mt-5 text-muted">后台框架已就绪，业务模块尚未开放。</p>
    <section className="mt-10 rounded-xl border border-border bg-white p-8" aria-label="开发状态">
      <h2 className="text-xl font-semibold">先建立可靠的操作流程</h2>
      <p className="mt-4 leading-7 text-muted">身份、权限、账号审核与订单处理将逐项实现。此页面没有真实数据或管理操作。</p>
    </section>
  </main>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<StrictMode><App /></StrictMode>);
