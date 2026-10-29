"use client";

import { useState } from "react";
import { safeContentLink, type ContentBlock, type ContentSection } from "@zzsh/content";

export function ContentImage({ src, alt, caption, inline = false }: { src: string | null | undefined; alt: string; caption?: string; inline?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const safe = src && /^\/api\/(?:content|v1\/content|bff\/admin\/content)\/media\/[A-Za-z0-9._:-]+\/content$/.test(src) ? src : null;
  const Container = inline ? "span" : "figure";
  return <Container className="content-document-image">
    {safe && failed !== safe
      ? <a href={safe} target="_blank" rel="noopener noreferrer" aria-label={`查看原尺寸：${alt}`}><img src={safe} alt={alt} loading="lazy" onError={() => setFailed(safe)} /></a>
      : <span role="status">图片暂不可用：{alt}</span>}
    {caption ? inline ? <span>{caption}</span> : <figcaption>{caption}</figcaption> : null}
  </Container>;
}

export function ContentBlockView({ block, mediaUrls = {} }: { block: ContentBlock; mediaUrls?: Readonly<Record<string, string | null>> }) {
  switch (block.type) {
    case "paragraph": return <p className="content-document-paragraph">{block.text}</p>;
    case "list": return block.ordered ? <ol>{block.items.map((text, index) => <li key={index}>{text}</li>)}</ol> : <ul>{block.items.map((text, index) => <li key={index}>{text}</li>)}</ul>;
    case "callout": return <div className={`content-document-callout content-document-callout--${block.tone}`} role="note"><strong>{block.tone === "warning" ? "注意" : "说明"}</strong><p>{block.text}</p></div>;
    case "table": return <div className="content-document-table" role="region" tabIndex={0} aria-label={block.caption || "说明表格，可横向滚动"}><table>
      {block.caption ? <caption>{block.caption}</caption> : null}
      <thead><tr>{block.columns.map((text, index) => <th key={index} scope="col">{text}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((text, cell) => <td key={cell}>{text}</td>)}</tr>)}</tbody>
    </table></div>;
    case "image": return <ContentImage src={mediaUrls[block.mediaId]} alt={block.alt} caption={block.caption} />;
    case "link": {
      let href: string;
      try { href = safeContentLink(block.href); } catch { return <p role="status">链接暂不可用：{block.text}</p>; }
      return <p><a href={href}>{block.text}</a></p>;
    }
    default: return <p role="alert">内容格式暂不支持，请联系平台核对。</p>;
  }
}

export function ContentSections({ sections, mediaUrls, anchors = false }: { sections: readonly ContentSection[]; mediaUrls?: Readonly<Record<string, string | null>>; anchors?: boolean }) {
  return <div className="content-document">{sections.map(section => <section key={section.id} id={section.id} className="content-document-section" aria-labelledby={`${section.id}-title`}>
    <h2 id={`${section.id}-title`}>{section.title}{anchors ? <a className="content-document-anchor" href={`#${section.id}`} aria-label={`章节链接：${section.title}`}>#</a> : null}</h2>
    {section.blocks.map((block, index) => <ContentBlockView key={index} block={block} mediaUrls={mediaUrls} />)}
  </section>)}</div>;
}
