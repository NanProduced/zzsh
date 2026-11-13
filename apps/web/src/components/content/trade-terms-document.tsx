"use client";

import { Component, Suspense, lazy, useEffect, type ReactNode } from "react";
import type { PlateDocumentEnvelope } from "@zzsh/content/plate";
import "@zzsh/ui/plate-document.css";

const Document = lazy(async () => ({ default: (await import("@zzsh/ui/plate-document")).PlateDocument }));

class TermsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p role="alert">条款正文暂时无法显示。请刷新页面后重新阅读。</p>
      : this.props.children;
  }
}

function TermsReady({ target, onReady }: { target: string; onReady?: (target: string) => void }) {
  useEffect(() => { onReady?.(target); }, [target, onReady]);
  return null;
}

export default function TradeTermsDocument({ body, document, target, onReady }: {
  body: string; document?: PlateDocumentEnvelope | null; target: string; onReady?: (target: string) => void;
}) {
  if (!document) return <><pre>{body}</pre><TermsReady target={target} onReady={onReady} /></>;
  return <TermsBoundary key={target}>
    <Suspense fallback={<p role="status">正在读取条款正文…</p>}>
      <Document document={document} showTableOfContents={false} />
      <TermsReady target={target} onReady={onReady} />
    </Suspense>
  </TermsBoundary>;
}
