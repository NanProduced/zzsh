"use client";

import { useEffect, useState } from "react";
import { ContentBlockView } from "@zzsh/ui/content-document";
import { MarkdownDocument } from "@zzsh/ui/content-markdown";
import { inspectMarkdown } from "@zzsh/content/markdown";
import "@zzsh/ui/content-markdown.css";
import { usePublicContent } from "./public-content-provider";

export function ManagedNoticeSections({ contentKey, compact = false }: { contentKey: string; compact?: boolean }) {
  const { status, resource, retry } = usePublicContent(contentKey);
  if (status === "loading") return <p role="status">正在读取说明…</p>;
  if (status === "error") return <div role="status"><p>说明暂时无法读取，请以本次报价、条款和订单记录为准。</p><button type="button" className="button quiet" onClick={retry}>重试读取说明</button></div>;
  if (!resource?.payload || resource.payload.kind !== "notice") return <p role="status">当前说明未公布，请通过站内客服核对。</p>;
  const payload = resource.payload;
  const mediaUrls = Object.fromEntries(resource.media.map(row => [row.id, row.url]));
  return <div className={compact ? "content-document managed-notice managed-notice--compact" : "content-document managed-notice"}>{payload.format === "markdown" ? <MarkdownDocument markdown={payload.markdown} mediaUrls={mediaUrls} compact={compact} /> : payload.sections.map(section => <section key={section.id}>
    {!compact ? <h3>{section.title}</h3> : null}
    {section.blocks.map((block, index) => <ContentBlockView key={index} block={block} />)}
  </section>)}</div>;
}

export function ManagedNoticeText({ contentKey }: { contentKey: string }) {
  const { status, resource } = usePublicContent(contentKey);
  const payload = resource?.payload?.kind === "notice" ? resource.payload : null;
  const markdown = payload?.format === "markdown" ? payload.markdown : null;
  const [parsed, setParsed] = useState<{ source: string; text: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (markdown !== null) inspectMarkdown(markdown, { compact: true }).then(document => { if (active) setParsed({ source: markdown, text: document.plainText }); }).catch(() => { if (active) setParsed({ source: markdown, text: "说明暂时无法读取，请查看当前报价与条款。" }); });
    return () => { active = false; };
  }, [markdown]);
  if (status === "loading") return <span>正在读取说明…</span>;
  if (status === "error") return <span>说明暂时无法读取，具体条件以本次有效报价与条款为准。</span>;
  if (!payload || payload.kind !== "notice") return <span>当前说明尚未公布。</span>;
  if (markdown !== null) return <span>{parsed && parsed.source === markdown ? parsed.text : "正在读取说明…"}</span>;
  return <span>{(payload.sections ?? []).flatMap(section => section.blocks.map(block => block.type === "list" ? block.items.join("；") : block.type === "paragraph" || block.type === "callout" ? block.text : "")).filter(Boolean).join("\n")}</span>;
}
