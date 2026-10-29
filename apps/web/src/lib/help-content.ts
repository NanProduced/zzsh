import { inspectMarkdown } from "@zzsh/content/markdown";
import type { PublicContentResource } from "@zzsh/content";
import type { HelpArticle } from "../content/help/types.ts";

/** 一份公开发布快照同时派生正文、目录与搜索文本，不回退到内置旧稿。 */
export async function publicHelpArticle(resource: PublicContentResource): Promise<HelpArticle | null> {
  const payload = resource.payload;
  if (resource.state !== "available" || payload?.kind !== "guide") return null;
  const publishedAt = resource.version?.publishedAt;
  const updatedAt = publishedAt ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(publishedAt)) : payload.updatedAt;
  const article: HelpArticle = { ...payload, updatedAt, mediaUrls: Object.fromEntries(resource.media.map(row => [row.id, row.url])), version: resource.version ?? null };
  if (payload.format !== "markdown") return article;
  const document = await inspectMarkdown(payload.markdown);
  return { ...article, toc: document.toc, plainText: document.plainText };
}
