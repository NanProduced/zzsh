import type { Metadata } from "next";
import { HelpPage, type HelpPageView } from "@/components/help/help-page";
import { buildHelpNavData, findHelpGroup, flattenHelpNavArticles, toArticleCard } from "@/components/help/nav-data";
import { listFeaturedArticles } from "@/content/help";
import { loadPublicHelpArticles, loadPublicHelpTree } from "@/lib/content-server";
import { legacyHelpHashMap } from "@/content/help/legacy-links";
import { searchHelpArticles } from "@/content/help/search";

export const metadata: Metadata = {
  title: "帮助中心 · 洲洲商行",
  description: "洲洲商行帮助中心：租号与使用、出租与管理、费用与资金、账号与安全、售后与保障等说明。",
};

const MAX_QUERY_LENGTH = 120;
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const [allHelpArticles, helpTree] = await Promise.all([loadPublicHelpArticles(), loadPublicHelpTree()]);
  const rawQuery = typeof params.q === "string" ? params.q : "";
  const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  const categoryParam = typeof params.category === "string" ? params.category : "";
  const navData = buildHelpNavData(helpTree);

  if (query) {
    const view: HelpPageView = { kind: "search", query, hits: searchHelpArticles(query, allHelpArticles).map((hit) => toArticleCard(hit.article, navData)) };
    return <HelpPage view={view} navData={navData} query={query} legacyHashMap={{ ...legacyHelpHashMap }} />;
  }

  const group = findHelpGroup(navData, categoryParam);
  if (group) {
    const published = new Map(allHelpArticles.map(article => [article.slug, article]));
    const hits = flattenHelpNavArticles({ entries: group.children }).flatMap(({ slug }) => {
      const article = published.get(slug);
      return article ? [toArticleCard(article, navData)] : [];
    });
    return <HelpPage view={{ kind: "category", title: group.title, description: group.description, hits }} navData={navData} query="" legacyHashMap={{ ...legacyHelpHashMap }} />;
  }

  const view: HelpPageView = { kind: "home", featured: listFeaturedArticles(allHelpArticles).map(article => toArticleCard(article, navData)) };
  return <HelpPage view={view} navData={navData} query={query} legacyHashMap={{ ...legacyHelpHashMap }} />;
}
