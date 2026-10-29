import { cache } from 'react';
import { contentServerOptions } from './content-server';
import { ContentReadError } from './content-public';
import { parseUpdate, parseUpdatesPage, type UpdateFilter } from './platform-updates';
export async function loadPlatformUpdates(type: UpdateFilter, page: number) {
  const options = contentServerOptions(), query = new URLSearchParams({ page: String(page), limit: '12' });
  if (type !== 'ALL') query.set('type', type);
  const response = await fetch(`${options.base}/updates?${query}`, { ...options, cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new ContentReadError();
  return parseUpdatesPage(await response.json());
}
export const loadPlatformUpdate = cache(async (id: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return null;
  const options = contentServerOptions(), response = await fetch(`${options.base}/updates/${encodeURIComponent(id)}`, { ...options, cache: 'no-store', redirect: 'error' });
  if (response.status === 404) return null;
  if (!response.ok) throw new ContentReadError();
  return parseUpdate(await response.json(), true);
});
