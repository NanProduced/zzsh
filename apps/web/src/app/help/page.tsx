import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HelpPage, type HelpPageView } from "@/components/help/help-page";
import { buildHelpNavData, toArticleCard } from "@/components/help/nav-data";
import { listFeaturedArticles, listHelpArticlesByCategory } from "@/content/help";
import { loadPublicHelpArticles } from "@/lib/content-server";
import { legacyHelpHashMap } from "@/content/help/legacy-links";
import { searchHelpArticles } from "@/content/help/search";
import { helpAuxCategories, helpCategories, type AnyHelpCategoryId } from "@/content/help/types";

export const metadata: Metadata = {
  title: "帮助中心 · 洲洲商行",
  description: "洲洲商行帮助中心：租号与使用、出租与管理、费用与资金、账号与安全、售后与保障等说明。",
};

const knownCategories = new Set<string>([...helpCategories, ...helpAuxCategories].map((c) => c.id));

const MAX_QUERY_LENGTH = 120;
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const allHelpArticles = await loadPublicHelpArticles();
  const rawQuery = typeof params.q === "string" ? params.q : "";
  const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  const categoryParam = typeof params.category === "string" ? params.category : "";
  const navData = buildHelpNavData(allHelpArticles);

  if (query) {
    const view: HelpPageView = { kind: "search", query, hits: searchHelpArticles(query, allHelpArticles).map((hit) => toArticleCard(hit.article)) };
    return <HelpPage view={view} navData={navData} query={query} legacyHashMap={{ ...legacyHelpHashMap }} />;
  }

  if (knownCategories.has(categoryParam)) {
    const category = categoryParam as AnyHelpCategoryId;
    const categoryArticles = listHelpArticlesByCategory(category, allHelpArticles);
    if (categoryArticles[0]) {
      redirect(`/help/${categoryArticles[0].slug}`);
    }
  }

  const view: HelpPageView = { kind: "home", featured: listFeaturedArticles(allHelpArticles).map(toArticleCard) };
  return <HelpPage view={view} navData={navData} query={query} legacyHashMap={{ ...legacyHelpHashMap }} />;
}
