import Link from "next/link";
import { ChevronRight, Hash, Headphones } from "lucide-react";
import { resolveRelated } from "@/content/help";
import { audienceLabels, helpCategoryLabel, type HelpArticle, type HelpBlock } from "@/content/help/types";
import { HelpCalloutIcon, HelpCopyLink, HelpToc } from "./help-article-extras";
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

export function HelpArticleMeta({ article }: { article: HelpArticle }) {
  return (
    <p className="help-article-meta">
      <span>{audienceText(article)}</span>
      <span className="help-meta-dot" aria-hidden="true">·</span>
      <span>更新于 {article.updatedAt}</span>
      {article.game ? (<>
        <span className="help-meta-dot" aria-hidden="true">·</span>
        <span className="help-tag help-tag--accent">适用：{article.game}</span>
      </>) : null}
    </p>
  );
}

export function HelpArticleInlineToc({ article }: { article: HelpArticle }) {
  if (article.sections.length < 2) return null;
  return <HelpToc variant="inline" sections={article.sections.map(({ id, title }) => ({ id, title }))} />;
}

export function HelpArticleAsideToc({ article }: { article: HelpArticle }) {
  if (article.sections.length < 2) return null;
  return <HelpToc variant="aside" sections={article.sections.map(({ id, title }) => ({ id, title }))} />;
}

export function HelpArticleBody({ article }: { article: HelpArticle }) {
  const related = resolveRelated(article);
  return (
    <article className="help-article">
      <HelpArticleMeta article={article} />
      <div className="help-article-share"><HelpCopyLink /></div>
      <HelpArticleInlineToc article={article} />
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
          <Link className="help-contact-cta" href="/support">
            <Headphones size={16} aria-hidden="true" />
            <span>联系平台客服</span>
          </Link>
        </div>
      ) : null}
      {related.length > 0 ? (
        <nav className="help-related" aria-label="相关说明">
          <h2>相关说明</h2>
          <ul>
            {related.map((item) => (
              <li key={item.slug}>
                <Link href={`/help/${item.slug}`}><ChevronRight size={14} aria-hidden="true" /><span>{item.title}</span></Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </article>
  );
}

export function articleBreadcrumb(article: HelpArticle) {
  return [
    { label: "首页", href: "/" },
    { label: "帮助中心", href: "/help" },
    { label: helpCategoryLabel(article.category), href: `/help?category=${article.category}` },
    { label: article.title },
  ] as const;
}
