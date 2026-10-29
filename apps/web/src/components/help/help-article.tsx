import Link from "next/link";
import { ChevronRight, Headphones } from "lucide-react";
import { ContentSections } from "@zzsh/ui/content-document";
import { MarkdownDocument } from "@zzsh/ui/content-markdown";
import "@zzsh/ui/content-markdown.css";
import { resolveRelated } from "@/content/help";
import { audienceLabels, type HelpArticle } from "@/content/help/types";
import { HelpCopyLink, HelpLegacyAnchors, HelpToc } from "./help-article-extras";
import { articleToc, isLongArticle } from "./nav-data";
import { SupportContactButton } from "@/components/support/support-contact-button";
import "./help.css";

function audienceText(article: HelpArticle): string {
  if (article.audience.includes("all")) return audienceLabels.all;
  return article.audience.map((a) => audienceLabels[a]).join(" · ");
}

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
  return <HelpToc variant="inline" sections={articleToc(article)} />;
}

export function HelpArticleAsideToc({ article }: { article: HelpArticle }) {
  if (!isLongArticle(article)) return null;
  return <HelpToc variant="aside" sections={articleToc(article)} />;
}

export function HelpArticleBody({ article, articles }: { article: HelpArticle; articles?: readonly HelpArticle[] }) {
  const related = resolveRelated(article, articles);
  const isLong = isLongArticle(article);
  return (
    <article className={`help-article${isLong ? "" : " help-article--short"}`} data-content-version={article.version?.id}>
      <h1 className="help-article-title">{article.title}</h1>
      <HelpArticleMeta article={article} />
      {article.summary ? <p className="help-article-summary">{article.summary}</p> : null}
      {isLong ? <HelpArticleInlineToc article={article} /> : null}
      {article.format === "markdown" && typeof article.markdown === "string" ? <>
        <HelpLegacyAnchors aliases={article.anchorAliases ?? {}} />
        <MarkdownDocument markdown={article.markdown} mediaUrls={article.mediaUrls} />
      </> : <ContentSections sections={article.sections ?? []} mediaUrls={article.mediaUrls} anchors />}
      {article.contactCta ? (
        <div className="help-article-footer">
          <div className="help-article-support-box">
            <div className="help-article-support-info">
              <h3 className="help-article-support-title">还有疑问？联系平台客服</h3>
              <p className="help-article-support-desc">真人客服将在服务时间内协助核实订单与账号情况。</p>
            </div>
            <SupportContactButton className="help-article-contact-btn">
              <Headphones size={16} aria-hidden="true" />
              <span>联系平台客服</span>
            </SupportContactButton>
          </div>
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
