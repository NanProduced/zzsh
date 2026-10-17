import Link from "next/link";
import { ChevronRight, Hash, Headphones } from "lucide-react";
import { resolveRelated } from "@/content/help";
import { audienceLabels, helpCategoryLabel, type HelpArticle, type HelpBlock } from "@/content/help/types";
import { HelpCalloutIcon, HelpCopyLink, HelpToc } from "./help-article-extras";
import { SupportContactButton } from "@/components/support/support-contact-button";
import "./help.css";

function HelpBlockView({ block }: { block: HelpBlock }) {
  switch (block.type) {
    case "paragraph":
      return <p>{block.text}</p>;
    case "list":
      return block.ordered
        ? <ol>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ol>
        : <ul>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
    case "callout":
      return <div className={`help-callout${block.tone === "warning" ? " help-callout--warning" : ""}`} role="note"><HelpCalloutIcon tone={block.tone} /><span>{block.text}</span></div>;
    case "table":
      return (
        <div className="help-table-wrap">
          <table className="help-table">
            {block.caption ? <caption>{block.caption}</caption> : null}
            <thead><tr>{block.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function audienceText(article: HelpArticle): string {
  if (article.audience.includes("all")) return audienceLabels.all;
  return article.audience.map((a) => audienceLabels[a]).join(" · ");
}

import { articleBreadcrumb, isLongArticle } from "./nav-data.ts";
export { articleBreadcrumb, isLongArticle };

export function HelpArticleMeta({ article }: { article: HelpArticle }) {
  return (
    <div className="help-article-meta-row">
      <div className="help-article-meta">
        <span className="help-audience-badge">{audienceText(article)}</span>
        <span className="help-meta-dot" aria-hidden="true">·</span>
        <span className="help-article-date">更新于 {article.updatedAt}</span>
        {article.game ? (
          <>
            <span className="help-meta-dot" aria-hidden="true">·</span>
            <span className="help-tag help-tag--accent">适用：{article.game}</span>
          </>
        ) : null}
      </div>
      <div className="help-article-actions">
        <HelpCopyLink />
      </div>
    </div>
  );
}

export function HelpArticleInlineToc({ article }: { article: HelpArticle }) {
  if (!isLongArticle(article)) return null;
  return <HelpToc variant="inline" sections={article.sections.map(({ id, title }) => ({ id, title }))} />;
}

export function HelpArticleAsideToc({ article }: { article: HelpArticle }) {
  if (!isLongArticle(article)) return null;
  return <HelpToc variant="aside" sections={article.sections.map(({ id, title }) => ({ id, title }))} />;
}

export function HelpArticleBody({ article }: { article: HelpArticle }) {
  const related = resolveRelated(article);
  const isLong = isLongArticle(article);
  return (
    <article className="help-article">
      <h1 className="help-article-title">{article.title}</h1>
      <HelpArticleMeta article={article} />
      {article.summary ? <p className="help-article-summary">{article.summary}</p> : null}
      {isLong ? <HelpArticleInlineToc article={article} /> : null}
      {article.sections.map((section) => (
        <section key={section.id} id={section.id} className="help-article-section" aria-labelledby={`${section.id}-title`}>
          <h2 id={`${section.id}-title`}>
            {section.title}
            <a className="help-section-anchor" href={`#${section.id}`} aria-label={`章节链接：${section.title}`}><Hash size={15} aria-hidden="true" /></a>
          </h2>
          {section.blocks.map((block, index) => <HelpBlockView key={index} block={block} />)}
        </section>
      ))}
      {article.contactCta ? (
        <div className="help-article-footer">
          <SupportContactButton className="help-article-contact-btn">
            <Headphones size={16} aria-hidden="true" />
            <span>联系平台客服</span>
          </SupportContactButton>
        </div>
      ) : null}
      {related.length > 0 ? (
        <nav className="help-related" aria-label="相关说明">
          <h2 className="help-related-title">相关说明</h2>
          <div className="help-related-grid">
            {related.map((item) => (
              <Link key={item.slug} className="help-related-card" href={`/help/${item.slug}`}>
                <span>{item.title}</span>
                <ChevronRight size={14} className="help-related-arrow" aria-hidden="true" />
              </Link>
            ))}
          </div>
        </nav>
      ) : null}
    </article>
  );
}
