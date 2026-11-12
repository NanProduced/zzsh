// 离线帮助测试夹具：P2 取消了运行时代码默认，唯一内容源是已确认的 defaults。
// 这里把 packages/content/defaults/help 下的 Plate 文档投影成 HelpArticle，
// 供搜索/目录/旧链接等用户端用例在没有数据库时复用真实默认内容。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicHelpArticle } from "../src/lib/help-content.ts";
import { helpAuxCategories, helpCategories } from "../src/content/help/types.ts";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const helpDir = path.join(tree, "packages/content/defaults/help");

const articles = [];
for (const file of readdirSync(helpDir).filter((name) => name.endsWith(".json")).sort()) {
  const entry = JSON.parse(readFileSync(path.join(helpDir, file), "utf8"));
  const meta = entry.meta;
  const payload = {
    kind: "guide", ...meta, format: "plate", schemaVersion: 1, document: entry.document,
    mediaIds: meta.mediaIds ?? [], ...(entry.anchorAliases ? { anchorAliases: entry.anchorAliases } : {}),
  };
  const resource = {
    schema: "content-resource.v1", key: `guide:${meta.slug}`, source: "MANAGED", state: "available", payload,
    version: { id: `default-${meta.slug}`, sequence: 1, publishedAt: "2026-10-28T00:00:00Z" }, media: [],
  };
  const article = await publicHelpArticle(resource);
  if (article) articles.push(article);
}

export const defaultHelpArticles = articles;
export const defaultHelpBySlug = new Map(articles.map((article) => [article.slug, article]));
export const getDefaultHelpArticle = (slug) => defaultHelpBySlug.get(slug);

export function defaultHelpTree(articles = defaultHelpArticles) {
  const sortKey = index => String(index).padStart(4, "0");
  const folders = [...helpCategories, ...helpAuxCategories].map((group, index) => ({
    id: group.id, title: group.label, description: group.description, parentId: null, kind: "FOLDER", slug: null, depth: 1,
    sortKey: sortKey(index), iconKey: null,
  }));
  const leaves = articles.map((article, index) => ({
    id: `article-${article.slug}`, parentId: article.category, kind: "ARTICLE", slug: article.slug, title: article.title, depth: 2,
    sortKey: sortKey(index), description: null, iconKey: null,
  }));
  return [...folders, ...leaves];
}