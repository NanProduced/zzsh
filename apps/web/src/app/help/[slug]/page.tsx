import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { allHelpArticles, getHelpArticle } from "@/content/help";
import { buildHelpNavData } from "@/components/help/nav-data";
import { HelpShell } from "@/components/help/help-shell";
import { HelpNavAside, HelpNavDrawer } from "@/components/help/help-nav";
import { HelpArticleAsideToc, HelpArticleBody, articleBreadcrumb } from "@/components/help/help-article";

export function generateStaticParams() {
  return allHelpArticles.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) return {};
  return { title: `${article.title} · 帮助中心 · 洲洲商行`, description: article.summary };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) notFound();
  const navData = buildHelpNavData(allHelpArticles);
  return (
    <HelpShell title={article.title} description={article.summary} breadcrumbs={articleBreadcrumb(article)}>
      <div className="help-layout help-layout--article">
        <HelpNavAside data={navData} activeCategory={article.category} activeSlug={article.slug} />
        <div className="help-main">
          <HelpNavDrawer data={navData} activeCategory={article.category} activeSlug={article.slug} />
          <HelpArticleBody article={article} />
        </div>
        <HelpArticleAsideToc article={article} />
      </div>
    </HelpShell>
  );
}
