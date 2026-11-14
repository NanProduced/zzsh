import type { MetadataRoute } from "next";
import { notFound } from "next/navigation";
import { seoOrigin } from "@/lib/seo";
import { loadPublicHelpArticles } from "@/lib/content-server";
import { loadPlatformUpdates } from "@/lib/updates-server";
import { readLegalDocument } from "@/lib/legal-server";
import { listLegalDocuments } from "@/content/legal/documents";

export const dynamic = "force-dynamic";

const STATIC_PATHS = ["/", "/accounts", "/publish", "/help", "/updates", "/login"];

// ponytail: 单个 sitemap 上限 5 万条，接近上限时再改 generateSitemaps 分片。
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = seoOrigin();
  if (!origin) notFound();
  // 任一数据源抛错时整个 sitemap 走 5xx，不输出缺项的 200。
  const [articles, updates] = await Promise.all([loadPublicHelpArticles(), loadAllUpdates()]);
  const legal = [];
  for (const record of listLegalDocuments()) {
    const reading = await readLegalDocument(record.doc);
    if (reading.state === "UNAVAILABLE") throw new Error(`legal document read failed: ${record.doc}`);
    if (reading.state === "PUBLISHED") legal.push({ url: `${origin}/legal/${record.doc}` });
  }
  return [
    ...STATIC_PATHS.map((path) => ({ url: `${origin}${path}` })),
    ...articles.map((article) => ({ url: `${origin}/help/${article.slug}`, lastModified: new Date(article.updatedAt) })),
    ...updates.map((update) => ({ url: `${origin}/updates/${update.id}`, lastModified: new Date(update.publishedAt) })),
    ...legal,
  ];
}

async function loadAllUpdates() {
  const first = await loadPlatformUpdates("ALL", 1);
  const items = [...first.items];
  for (let page = 2; page <= first.totalPages; page += 1) {
    items.push(...(await loadPlatformUpdates("ALL", page)).items);
  }
  return items;
}
