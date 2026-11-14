import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadHelpSlugStatus, loadPublicHelpArticles, loadPublicHelpTree } from "@/lib/content-server";
import { ServiceShell } from "@/components/layout/service-shell";
import { buildHelpNavData, articleBreadcrumb, hasArticleToc, getHelpArticleNeighbors } from "@/components/help/nav-data";
import { HelpShell } from "@/components/help/help-shell";
import { HelpNavAside, HelpNavDrawer } from "@/components/help/help-nav";
import { HelpArticleAsideToc, HelpArticleBody } from "@/components/help/help-article";
import { HelpArticlePager } from "@/components/help/help-article-pager";
import { seoPageMetadata } from "@/lib/seo";
import "@/components/help/help.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = (await loadPublicHelpArticles().catch(() => [])).find(value => value.slug === slug);
  if (article) return seoPageMetadata({ title: `${article.title} - 帮助中心`, description: article.summary, path: `/help/${slug}` });
  const status = await loadHelpSlugStatus(slug).catch(() => null);
  if (status?.state === "RETIRED") return { title: "该文档已下线", robots: "noindex" };
  return {};
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const allHelpArticles = await loadPublicHelpArticles();
  const article = allHelpArticles.find(value => value.slug === slug);
  if (!article) {
    const status = await loadHelpSlugStatus(slug);
    if (status?.state === "RETIRED") {
      return (
        <ServiceShell
          title="该文档已下线"
          showBack={false}
          showPageHeading={false}
          headingInContent
          contextLabel={null}
          breadcrumbs={[{ label: "首页", href: "/" }, { label: "帮助中心", href: "/help" }, { label: "已下线" }]}
        >
          <div className="help-offline" role="status">
            <h1 className="help-offline-title">该文档已下线</h1>
            <p className="help-offline-desc">{status.title ? `「${status.title}」` : "该文档"}已不再提供帮助。你可以返回帮助中心查看其他说明。</p>
            <Link className="help-offline-link" href="/help">返回帮助中心</Link>
          </div>
        </ServiceShell>
      );
    }
    notFound();
  }
  const navData = buildHelpNavData(await loadPublicHelpTree());
  const { prev, next } = getHelpArticleNeighbors(navData, article.slug);
  const hasToc = hasArticleToc(article);
  return (
    <HelpShell
      title={article.title}
      description={article.summary}
      breadcrumbs={[...articleBreadcrumb(article, navData).slice(1), { label: article.title }]}
      showPageHeading={false}
      headingInContent={true}
    >
      <div className={`help-layout ${hasToc ? "help-layout--article-long" : "help-layout--article-short"}`}>
        <HelpNavAside data={navData} activeSlug={article.slug} />
        <div className="help-main">
          <HelpNavDrawer data={navData} activeSlug={article.slug} />
          <HelpArticleBody article={article} articles={allHelpArticles} />
          <HelpArticlePager prev={prev} next={next} />
        </div>
        {hasToc ? <HelpArticleAsideToc article={article} /> : null}
      </div>
    </HelpShell>
  );
}
