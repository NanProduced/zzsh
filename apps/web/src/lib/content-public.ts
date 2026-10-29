import { RESOURCE_SCHEMA, resourceMediaIds, validateResource, validateResourceKey, type PublicContentResource } from "@zzsh/content";

export class ContentReadError extends Error {
  constructor(message = "内容暂时无法读取，请稍后重试。") { super(message); this.name = "ContentReadError"; }
}

export function parsePublicContentResource(value: unknown): PublicContentResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContentReadError();
  const entry = value as Record<string, unknown>;
  if (entry.schema !== RESOURCE_SCHEMA || !["BUILTIN", "MANAGED", "LEGACY"].includes(String(entry.source)) || !["available", "withdrawn", "unpublished"].includes(String(entry.state))) throw new ContentReadError();
  try {
    const key = validateResourceKey(entry.key);
    const payload = entry.state === "available" ? validateResource(key, entry.payload) : null;
    if (!Array.isArray(entry.media)) throw new ContentReadError();
    const ids = new Set(payload ? resourceMediaIds(payload) : []), seen = new Set<string>();
    const media = entry.media.map((raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ContentReadError();
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== "string" || !ids.has(row.id) || seen.has(row.id)) throw new ContentReadError();
      seen.add(row.id);
      const path = `/media/${encodeURIComponent(row.id)}/content`;
      if (row.url !== null && row.url !== `/api/v1/content${path}` && row.url !== `/api/content${path}`) throw new ContentReadError();
      return { id: row.id, url: row.url === null ? null : `/api/content${path}` };
    });
    if (seen.size !== ids.size) throw new ContentReadError();
    let version = null;
    if (entry.version !== null && entry.version !== undefined) {
      const value = entry.version as Record<string, unknown>;
      if (typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id)
        || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1
        || !(value.publishedAt === null || typeof value.publishedAt === "string" && Number.isFinite(Date.parse(value.publishedAt)))) throw new ContentReadError();
      version = { id: value.id, sequence: value.sequence, publishedAt: value.publishedAt as string | null };
    }
    return { schema: RESOURCE_SCHEMA, key, source: entry.source as PublicContentResource["source"], state: entry.state as PublicContentResource["state"], payload, media, version };
  } catch { throw new ContentReadError(); }
}

export async function fetchContentResources(kind: "guide" | "placement", options: { base?: string; fetcher?: typeof fetch; signal?: AbortSignal; headers?: HeadersInit } = {}): Promise<PublicContentResource[]> {
  const fetcher = options.fetcher ?? fetch, items: PublicContentResource[] = [], visited = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ kind, limit: "5" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetcher(`${options.base ?? "/api/content"}/resources?${query}`, { cache: "no-store", signal: options.signal, headers: options.headers, redirect: "error" });
    if (!response.ok) throw new ContentReadError();
    const page: unknown = await response.json();
    if (!page || typeof page !== "object" || Array.isArray(page)) throw new ContentReadError();
    const result = page as { items?: unknown; nextCursor?: unknown };
    if (!Array.isArray(result.items) || result.items.length > 5 || !(result.nextCursor === null || typeof result.nextCursor === "string")) throw new ContentReadError();
    for (const raw of result.items) {
      const item = parsePublicContentResource(raw);
      if (!item.key.startsWith(`${kind}:`) || items.some(old => old.key === item.key)) throw new ContentReadError();
      items.push(item);
    }
    cursor = result.nextCursor as string | null;
    if (cursor && (cursor.length > 2048 || visited.has(cursor))) throw new ContentReadError();
    if (cursor) visited.add(cursor);
  } while (cursor);
  return items;
}
