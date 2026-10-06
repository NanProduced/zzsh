import { helpAuxCategories, helpCategories, type AnyHelpCategoryId, type HelpArticle } from "../../content/help/types.ts";

export type HelpNavArticle = { slug: string; title: string };
export type HelpNavCategory = { id: AnyHelpCategoryId; label: string; articles: HelpNavArticle[] };
export type HelpNavData = { categories: HelpNavCategory[]; aux: HelpNavCategory[] };

export function buildHelpNavData(articles: readonly HelpArticle[]): HelpNavData {
  const group = (id: AnyHelpCategoryId, label: string): HelpNavCategory => ({
    id,
    label,
    articles: articles.filter((article) => article.category === id).map((article) => ({ slug: article.slug, title: article.title })),
  });
  return {
    categories: helpCategories.map((c) => group(c.id, c.label)),
    aux: helpAuxCategories.map((c) => group(c.id, c.label)),
  };
}

export type HelpArticleCard = {
  slug: string;
  title: string;
  summary: string;
  category: AnyHelpCategoryId;
  audience: readonly string[];
  game?: string;
};

const audienceText: Record<string, string> = { renter: "租客", owner: "号主", all: "全体用户" };

export function toArticleCard(article: HelpArticle): HelpArticleCard {
  return {
    slug: article.slug,
    title: article.title,
    summary: article.summary,
    category: article.category,
    audience: article.audience.map((a) => audienceText[a] ?? a),
    game: article.game,
  };
}
