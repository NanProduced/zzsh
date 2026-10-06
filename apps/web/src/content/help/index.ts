import { helpArticles, helpArticlesMore } from "./articles.ts";
import type { AnyHelpCategoryId, HelpArticle } from "./types.ts";

/** 已发布文章的唯一内容源；draft/待审内容不得加入此清单 */
export const allHelpArticles: readonly HelpArticle[] = [...helpArticles, ...helpArticlesMore];

const bySlug = new Map(allHelpArticles.map((article) => [article.slug, article]));

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return bySlug.get(slug);
}

export function listHelpArticlesByCategory(category: AnyHelpCategoryId): readonly HelpArticle[] {
  return allHelpArticles.filter((article) => article.category === category);
}

/** 首页推荐问题：人工挑选，不伪称热门或阅读数 */
export const featuredSlugs = [
  "rental-getting-started",
  "fees-early-end",
  "fees-refund-status",
  "publish-prepare",
  "account-recovery",
  "protection-coverage",
] as const;

export function listFeaturedArticles(): HelpArticle[] {
  return featuredSlugs.map((slug) => bySlug.get(slug)).filter((a): a is HelpArticle => a !== undefined);
}

export function resolveRelated(article: HelpArticle): HelpArticle[] {
  return article.related.map((slug) => bySlug.get(slug)).filter((a): a is HelpArticle => a !== undefined);
}
