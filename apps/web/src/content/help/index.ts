import { helpArticles, helpArticlesMore } from "./articles.ts";
import type { AnyHelpCategoryId, HelpArticle } from "./types.ts";

/** 已发布文章的唯一内容源；draft/待审内容不得加入此清单 */
export const allHelpArticles: readonly HelpArticle[] = [...helpArticles, ...helpArticlesMore];

const bySlug = new Map(allHelpArticles.map((article) => [article.slug, article]));

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return bySlug.get(slug);
}

export function listHelpArticlesByCategory(category: AnyHelpCategoryId, articles: readonly HelpArticle[] = allHelpArticles): readonly HelpArticle[] {
  return articles.filter((article) => article.category === category);
}

/** 首页推荐问题：人工挑选，不伪称热门或阅读数 */
export const featuredSlugs = [
  "rental-getting-started",
  "rental-check-before-order",
  "fees-early-end",
  "fees-refund-status",
  "publish-prepare",
  "account-recovery",
] as const;

export function listFeaturedArticles(articles: readonly HelpArticle[] = allHelpArticles): HelpArticle[] {
  return featuredSlugs.map(slug => articles.find(article => article.slug === slug)).filter((a): a is HelpArticle => a !== undefined);
}

export function resolveRelated(article: HelpArticle, articles: readonly HelpArticle[] = allHelpArticles): HelpArticle[] {
  return article.related.map(slug => articles.find(value => value.slug === slug)).filter((a): a is HelpArticle => a !== undefined);
}
