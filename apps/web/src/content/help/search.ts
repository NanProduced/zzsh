import { allHelpArticles } from "./index.ts";
import type { HelpArticle } from "./types.ts";

/** 查询归一化：常见同音/别名字形收敛，不合并不同业务概念 */
const queryAliases: readonly (readonly [RegExp, string])[] = [
  [/哈弗/g, "哈夫"],
  [/哈夫币/g, "哈夫"],
  [/退押金/g, "押金 退款"],
];

/** 关键词扩展：同一业务概念的不同说法；注意「退款」与「提现」不互为别名 */
const keywordAliases: Readonly<Record<string, readonly string[]>> = {
  "上架": ["出租", "发布"],
  "出租": ["上架", "发布"],
  "发布": ["上架", "出租"],
  "退款": ["退钱", "退回", "原路"],
  "提现": ["出款", "取现"],
  "结算": ["结账", "清算"],
  "押金": ["保证金"], // 仅扩展匹配；正文已区分租客押金与号主保证金
  "客服": ["人工", "售后"],
  "人脸": ["人脸识别", "扫脸"],
  "封号": ["封禁"],
  "包赔": ["赔付", "赔偿", "保障"],
};

export type HelpSearchHit = {
  article: HelpArticle;
  score: number;
};

function normalizeQuery(raw: string): string {
  let text = raw.trim().toLowerCase();
  for (const [pattern, replacement] of queryAliases) text = text.replace(pattern, replacement);
  return text;
}

function expandTerms(terms: readonly string[]): readonly string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    expanded.add(term);
    for (const [word, aliases] of Object.entries(keywordAliases)) {
      if (term.includes(word)) for (const alias of aliases) expanded.add(term.replace(word, alias));
    }
  }
  return [...expanded];
}

function articleBodyText(article: HelpArticle): string {
  return article.sections
    .map((section) => section.title + " " + section.blocks.map((block) => {
      if (block.type === "paragraph" || block.type === "callout") return block.text;
      if (block.type === "list") return block.items.join(" ");
      return block.columns.join(" ") + " " + block.rows.map((row) => row.join(" ")).join(" ");
    }).join(" "))
    .join(" ");
}

function scoreArticle(article: HelpArticle, terms: readonly string[]): number {
  const title = article.title.toLowerCase();
  const summary = article.summary.toLowerCase();
  const keywords = article.keywords.map((k) => k.toLowerCase());
  const body = articleBodyText(article).toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (title.includes(term)) score += 100;
    if (keywords.some((k) => k.includes(term) || term.includes(k))) score += 60;
    if (summary.includes(term)) score += 30;
    if (body.includes(term)) score += 10;
  }
  return score;
}

/** 轻量本地确定性检索：标题 > 关键词 > 摘要 > 正文；不伪造热度与匹配数 */
export function searchHelpArticles(rawQuery: string, articles: readonly HelpArticle[] = allHelpArticles): HelpSearchHit[] {
  const normalized = normalizeQuery(rawQuery);
  if (!normalized) return [];
  const terms = expandTerms(normalized.split(/[\s,，、；;]+/).filter(Boolean));
  return articles
    .map((article) => ({ article, score: scoreArticle(article, terms) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.article.slug.localeCompare(b.article.slug));
}
