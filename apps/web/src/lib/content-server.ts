import { cache } from "react";
import { isHttpOrigin } from "./user-proxy";
import { ContentReadError, fetchContentResources } from "./content-public";
import type { HelpArticle } from "@/content/help/types";
import { publicHelpArticle } from "./help-content";

export function contentServerOptions() {
  const local = process.env.NODE_ENV !== "production";
  const apiOrigin = process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
  const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin)) throw new ContentReadError();
  return { base: `${apiOrigin}/api/v1/content`, headers: { origin: webOrigin, accept: "application/json" }, signal: AbortSignal.timeout(15000) };
}

export const loadPublicHelpArticles = cache(async (): Promise<HelpArticle[]> => {
  const resources = await fetchContentResources("guide", contentServerOptions());
  const articles = await Promise.all(resources.map(publicHelpArticle));
  return articles.filter((article): article is HelpArticle => article !== null);
});

export type PublicUpdate = { id: string; type: "ANNOUNCEMENT" | "NEWS"; title: string; summary: string; body?: string; coverMediaId: string | null; publishedAt: string; gameName: string | null };
function updateRecord(value: unknown, detail: boolean): PublicUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContentReadError();
  const row = value as Record<string, unknown>;
  const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  if (!id(row.id) || !["ANNOUNCEMENT", "NEWS"].includes(String(row.type)) || typeof row.title !== "string" || typeof row.summary !== "string"
    || typeof row.publishedAt !== "string" || !Number.isFinite(Date.parse(row.publishedAt)) || !(row.gameName === null || typeof row.gameName === "string")
    || !(row.coverMediaId === null || id(row.coverMediaId)) || (detail && typeof row.body !== "string")) throw new ContentReadError();
  return { id: row.id as string, type: row.type as PublicUpdate["type"], title: row.title, summary: row.summary, ...(detail ? { body: row.body as string } : {}),
    coverMediaId: row.coverMediaId as string | null, publishedAt: row.publishedAt, gameName: row.gameName as string | null };
}

export async function loadPublicUpdates(type?: "ANNOUNCEMENT" | "NEWS", cursor?: string) {
  const options = contentServerOptions(), query = new URLSearchParams({ limit: "20" });
  if (type) query.set("type", type);
  if (cursor) { if (cursor.length > 2048) throw new ContentReadError(); query.set("cursor", cursor); }
  const response = await fetch(`${options.base}/items?${query}`, { ...options, cache: "no-store", redirect: "error" });
  if (!response.ok) throw new ContentReadError();
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ContentReadError();
  const page = data as { items?: unknown; nextCursor?: unknown };
  if (!Array.isArray(page.items) || page.items.length > 20 || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new ContentReadError();
  return { items: page.items.map(row => updateRecord(row, false)), nextCursor: page.nextCursor as string | null };
}

export const loadPublicUpdate = cache(async (id: string): Promise<PublicUpdate | null> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return null;
  const options = contentServerOptions();
  const response = await fetch(`${options.base}/items/${encodeURIComponent(id)}`, { ...options, cache: "no-store", redirect: "error" });
  if (response.status === 404) return null;
  if (!response.ok) throw new ContentReadError();
  return updateRecord(await response.json(), true);
});
