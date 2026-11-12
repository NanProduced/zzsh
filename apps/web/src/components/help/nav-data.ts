import type { AnyHelpCategoryId, HelpArticle, PublicHelpTreeNode } from "../../content/help/types.ts";

export type HelpNavArticle = { slug: string; title: string };
export type HelpNavGroup = { kind: "FOLDER"; id: string; title: string; iconKey: string | null; description: string | null; children: HelpNavEntry[] };
export type HelpNavEntry = HelpNavGroup | (HelpNavArticle & { kind: "ARTICLE"; id: string });
export type HelpNavData = { entries: HelpNavEntry[] };

export function buildHelpNavData(nodes: readonly PublicHelpTreeNode[]): HelpNavData {
  const byParent = new Map<string | null, PublicHelpTreeNode[]>();
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  const branch = (parent: string | null): HelpNavEntry[] =>
    (byParent.get(parent) ?? []).sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0).flatMap((node): HelpNavEntry[] => {
      if (node.kind === "ARTICLE") return node.slug ? [{ kind: node.kind, id: node.id, slug: node.slug, title: node.title }] : [];
      const children = branch(node.id);
      return children.length ? [{ kind: node.kind, id: node.id, title: node.title, iconKey: node.iconKey, description: node.description, children }] : [];
    });
  return { entries: branch(null) };
}

export function flattenHelpNavArticles(data: HelpNavData): HelpNavArticle[] {
  return data.entries.flatMap(entry => entry.kind === "ARTICLE"
    ? [{ slug: entry.slug, title: entry.title }]
    : flattenHelpNavArticles({ entries: entry.children }));
}

export function findHelpGroup(data: HelpNavData, id: string): HelpNavGroup | undefined {
  for (const entry of data.entries) {
    if (entry.kind !== "FOLDER") continue;
    if (entry.id === id) return entry;
    const nested = findHelpGroup({ entries: entry.children }, id);
    if (nested) return nested;
  }
}

function articleGroups(data: HelpNavData, slug: string): HelpNavGroup[] | undefined {
  for (const entry of data.entries) {
    if (entry.kind === "ARTICLE") {
      if (entry.slug === slug) return [];
    } else {
      const children = articleGroups({ entries: entry.children }, slug);
      if (children) return [entry, ...children];
    }
  }
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
  categoryLabel?: string;
  audience: readonly string[];
  game?: string;
};

const audienceText: Record<string, string> = { renter: "租客", owner: "号主", all: "全体用户" };

export function toArticleCard(article: HelpArticle, navData?: HelpNavData): HelpArticleCard {
  const group = navData && articleGroups(navData, article.slug)?.at(-1);
  return {
    slug: article.slug,
    title: article.title,
    summary: article.summary,
    category: article.category,
    ...(group ? { categoryLabel: group.title } : {}),
    audience: article.audience.map((a) => audienceText[a] ?? a),
    game: article.game,
  };
}

export function isLongArticle(article: HelpArticle): boolean {
  return (article.toc?.length ?? 0) >= 3 || (article.plainText ?? "").length >= 1600;
}

export function articleToc(article: HelpArticle) {
  return article.toc ?? [];
}

export function hasArticleToc(article: HelpArticle): boolean {
  return isLongArticle(article) && articleToc(article).length > 0;
}

export function articleBreadcrumb(article: HelpArticle, navData: HelpNavData) {
  const groups = articleGroups(navData, article.slug) ?? [];
  return [
    { label: "首页", href: "/" },
    { label: "帮助中心", href: "/help" },
    ...groups.map(group => ({ label: group.title, href: `/help?category=${encodeURIComponent(group.id)}` })),
  ];
}

