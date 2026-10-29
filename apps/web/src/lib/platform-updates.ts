import { updateSettings, type PublicUpdate, type UpdatesPage } from '@zzsh/content/updates';
import { ContentReadError } from './content-public';
export type UpdateFilter = 'ALL' | 'ANNOUNCEMENT' | 'NEWS';
export const updateTypeLabel = (type: string) => type === 'ANNOUNCEMENT' ? '公告' : '资讯';
export function updateListHref(type: UpdateFilter = 'ALL', page = 1) {
  const query = new URLSearchParams();
  if (type !== 'ALL') query.set('type', type);
  if (page > 1) query.set('page', String(page));
  return `/updates${query.size ? `?${query}` : ''}`;
}
export function updateReturnHref(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300) return '/updates?restore=1';
  try {
    const url = new URL(value, 'https://zzsh.invalid');
    if (url.origin !== 'https://zzsh.invalid' || url.pathname !== '/updates' || [...url.searchParams.keys()].some(k => !['type', 'page'].includes(k))) throw Error();
    const type = url.searchParams.get('type'), rawPage = url.searchParams.get('page');
    if (type && !['ANNOUNCEMENT', 'NEWS'].includes(type) || rawPage && !/^[1-9]\d{0,3}$/.test(rawPage)) throw Error();
    const canonical = updateListHref((type || 'ALL') as UpdateFilter, Number(rawPage || 1));
    return `${canonical}${canonical.includes('?') ? '&' : '?'}restore=1`;
  } catch { return '/updates?restore=1'; }
}
export function parseUpdate(value: unknown, detail = false): PublicUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContentReadError();
  const row = value as PublicUpdate, id = (x: unknown) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
  if (!id(row.id) || !id(row.versionId) || !['ANNOUNCEMENT', 'NEWS'].includes(row.type) || typeof row.title !== 'string' || typeof row.summary !== 'string' || typeof row.publishedAt !== 'string' || !Number.isFinite(Date.parse(row.publishedAt)) || !(row.coverMediaId === null || id(row.coverMediaId)) || typeof row.expired !== 'boolean' || typeof row.pinned !== 'boolean' || !(row.gameName === null || typeof row.gameName === 'string') || detail && typeof row.body !== 'string') throw new ContentReadError();
  let settings; try { settings = updateSettings(row.settings); } catch { throw new ContentReadError(); }
  if (!row.mediaUrls || typeof row.mediaUrls !== 'object' || Array.isArray(row.mediaUrls)) throw new ContentReadError();
  const mediaUrls: Record<string, string | null> = {};
  for (const [key, url] of Object.entries(row.mediaUrls)) {
    if (!settings.mediaIds.includes(key) || url !== null && url !== `/api/v1/content/media/${encodeURIComponent(key)}/content` && url !== `/api/content/media/${encodeURIComponent(key)}/content`) throw new ContentReadError();
    mediaUrls[key] = url === null ? null : `/api/content/media/${encodeURIComponent(key)}/content`;
  }
  if (detail && Object.keys(mediaUrls).length !== settings.mediaIds.length) throw new ContentReadError();
  return { ...row, settings, mediaUrls };
}
export function parseUpdatesPage(value: unknown): UpdatesPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContentReadError();
  const row = value as UpdatesPage;
  if (!Array.isArray(row.items) || !Number.isInteger(row.page) || row.page < 1 || !Number.isInteger(row.limit) || row.limit < 1 || row.limit > 20 || row.items.length > row.limit || !Number.isSafeInteger(row.total) || row.total < 0 || row.totalPages !== Math.ceil(row.total / row.limit) || typeof row.asOf !== 'string' || !Number.isFinite(Date.parse(row.asOf))) throw new ContentReadError();
  const items = row.items.map(x => parseUpdate(x)); if (new Set(items.map(x => x.id)).size !== items.length) throw new ContentReadError();
  return { ...row, items };
}
export const updateDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)).replaceAll('/', '-');
