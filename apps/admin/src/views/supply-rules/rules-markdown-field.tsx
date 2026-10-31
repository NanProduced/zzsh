import { lazy, Suspense } from "react";
import "./rules-markdown.css";

const MarkdownInput = lazy(() => import("../content-markdown-input"));

/** 规则/条款正文编辑：复用内容管理的 Markdown 编辑器（同一组件、同一工具栏）。 */
export function RulesMarkdownField({ label, value, onChange, disabled, hint, height }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; hint?: string; height?: number }) {
  return <div className="space-y-1.5">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="text-sm font-medium">{label}</span>{hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}</div>
    <div className="rules-markdown overflow-hidden rounded-md border border-border">
      <Suspense fallback={<p role="status" className="p-3 text-xs text-muted-foreground">正在加载编辑器…</p>}>
        <MarkdownInput value={value} onChange={onChange} disabled={disabled} height={height} />
      </Suspense>
    </div>
  </div>;
}
