import type { Metadata } from "next";
import { HelpPage, type HelpPageView } from "@/components/help/help-page";
import { buildHelpNavData, toArticleCard } from "@/components/help/nav-data";
import { allHelpArticles, listFeaturedArticles, listHelpArticlesByCategory } from "@/content/help";
import { legacyHelpHashMap } from "@/content/help/legacy-links";
import { searchHelpArticles } from "@/content/help/search";
import { helpAuxCategories, helpCategories, type AnyHelpCategoryId } from "@/content/help/types";

export const metadata: Metadata = {
  title: "帮助中心 · 洲洲商行",
  description: "洲洲商行帮助中心：租号与使用、出租与管理、费用与资金、账号与安全、售后与保障等说明。",
};

const knownCategories = new Set<string>([...helpCategories, ...helpAuxCategories].map((c) => c.id));

const MAX_QUERY_LENGTH = 120;

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const rawQuery = typeof params.q === "string" ? params.q : "";
  const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  const categoryParam = typeof params.category === "string" ? params.category : "";
  const navData = buildHelpNavData(allHelpArticles);

  let view: HelpPageView;
  if (query) {
    view = { kind: "search", query, hits: searchHelpArticles(query).map((hit) => toArticleCard(hit.article)) };
  } else if (knownCategories.has(categoryParam)) {
    const category = categoryParam as AnyHelpCategoryId;
    view = { kind: "category", category, articles: listHelpArticlesByCategory(category).map(toArticleCard) };
  } else {
    view = { kind: "home", featured: listFeaturedArticles().map(toArticleCard) };
  }

  return <HelpPage view={view} navData={navData} query={query} legacyHashMap={{ ...legacyHelpHashMap }} />;
}
