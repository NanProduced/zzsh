import { helpAuxCategories, helpCategories, helpCategoryLabel, type AnyHelpCategoryId, type HelpArticle } from "../../content/help/types.ts";

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

/** 按帮助目录展示顺序（主分类在前、协议与规则在后）拍平全部文章 */
export function flattenHelpNavArticles(data: HelpNavData): HelpNavArticle[] {
  return [...data.categories, ...data.aux].flatMap((group) => group.articles.map((article) => ({ ...article })));
}

/** 上一篇/下一篇：以上下篇导航的目录顺序为准；边界处为 null */
export function getHelpArticleNeighbors(data: HelpNavData, slug: string): { prev: HelpNavArticle | null; next: HelpNavArticle | null } {
  const articles = flattenHelpNavArticles(data);
  const index = articles.findIndex((article) => article.slug === slug);
  return {
    prev: index > 0 ? articles[index - 1]! : null,
    next: index >= 0 && index < articles.length - 1 ? articles[index + 1]! : null,
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

export function isLongArticle(article: HelpArticle): boolean {
  return article.sections.length >= 3;
}

export function articleBreadcrumb(article: HelpArticle) {
  return [
    { label: "首页", href: "/" },
    { label: "帮助中心", href: "/help" },
    { label: helpCategoryLabel(article.category), href: `/help?category=${article.category}` },
  ] as const;
}

