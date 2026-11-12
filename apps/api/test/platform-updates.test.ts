import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareUpdateSettings, checkUpdateRelease, requireUpdatePromotionPermission, updateProjection, listPublicUpdates, readPublicUpdate } from '../src/content/updates';
import { ADMIN_PERMISSION, type EffectiveAdminAccess } from '../src/auth/admin-authorization';
import type { PoolClient } from 'pg';

test('global homepage promotion requires platform publication permission even for game-scoped news', () => {
  const access: EffectiveAdminAccess = { status: 'ACTIVE', isBoss: false, passwordChangeRequired: false, permissions: new Set([ADMIN_PERMISSION.contentPublish]) };
  assert.doesNotThrow(() => requireUpdatePromotionPermission(access, {}));
  assert.throws(() => requireUpdatePromotionPermission(access, { tickerEnabled: true }), error => (error as { status?: number }).status === 403);
  assert.throws(() => requireUpdatePromotionPermission(access, { homePopup: true }), error => (error as { status?: number }).status === 403);
  access.permissions.add(ADMIN_PERMISSION.contentPlatformPublish);
  assert.throws(() => requireUpdatePromotionPermission(access, { tickerEnabled: true }), error => (error as { status?: number }).status === 403, 'a legacy Boss-only publication code does not promote a non-Boss');
  assert.doesNotThrow(() => requireUpdatePromotionPermission({ ...access, isBoss: true }, { tickerEnabled: true }));
});
test('update settings only accept plate and sort the server-supplied media references', () => {
  assert.throws(() => prepareUpdateSettings({ format: 'markdown' }, []), /动态发布设置无效/);
  assert.throws(() => prepareUpdateSettings({ format: 'plain' }, []), /动态发布设置无效/);
  const settings = prepareUpdateSettings({ format: 'plate' }, ['public_b', 'public_a']);
  assert.deepEqual(settings.mediaIds, ['public_a', 'public_b']);
  assert.equal(Object.hasOwn(settings, 'homePopup'), false, 'default false does not alter old admin read shapes');
  assert.equal(prepareUpdateSettings({ homePopup: true }, []).homePopup, true);
});
test('update projection derives the plain-text body and media references from the plate document', () => {
  const document = { format: 'plate', schemaVersion: 1, preset: 'update', value: [
    { type: 'p', children: [{ text: '正文独有词' }] },
    { type: 'img', mediaId: 'public_asset', alt: '插图', children: [{ text: '' }] },
  ] };
  const projection = updateProjection(document as never);
  assert.match(projection.body, /正文独有词/);
  assert.deepEqual(projection.mediaIds, ['public_asset']);
});
test('only validated announcements can reserve one of the three active pin positions', async () => {
  const statements: string[] = [], client = { query: async (sql: string) => { statements.push(sql); return { rows: [{ count: '3' }] }; } } as unknown as PoolClient;
  const settings = { pinned: true, pinnedUntil: new Date(Date.now() + 3600_000).toISOString() };
  await assert.rejects(() => checkUpdateRelease(client, { id: 'new', type: 'NEWS' }, settings), /只有公告可置顶/);
  assert.equal(statements.length, 0);
  await assert.rejects(() => checkUpdateRelease(client, { id: 'new', type: 'ANNOUNCEMENT' }, settings), /最多同时置顶3条/);
  assert.ok(statements[0]!.includes('pg_advisory_xact_lock'));
});


test('homepage popup can only be released for a platform announcement', async () => {
  const client = {} as PoolClient;
  await assert.rejects(() => checkUpdateRelease(client, { id: 'g', type: 'ANNOUNCEMENT', gameId: 'game' }, { homePopup: true }), /只有平台公告/);
  await assert.rejects(() => checkUpdateRelease(client, { id: 'n', type: 'NEWS', gameId: null }, { homePopup: true }), /只有平台公告/);
  await assert.doesNotReject(() => checkUpdateRelease(client, { id: 'p', type: 'ANNOUNCEMENT', gameId: null }, { homePopup: true }));
});


test('legacy public update responses keep their prior settings shape', async () => {
  const row = { id: 'popup', versionId: 'v1', type: 'ANNOUNCEMENT', title: '公告', summary: '', publishedAt: new Date(), gameName: null, coverMediaId: null, settings: { homePopup: true } };
  const client = { query: async (sql: string) => sql.startsWith('SELECT count') ? { rows: [{ total: '1' }] } : { rows: [row] } } as unknown as PoolClient;
  const legacy = await listPublicUpdates(client, { page: 1, limit: 1 });
  const popup = await listPublicUpdates(client, { page: 1, limit: 1, surface: 'home-popup' });
  const detail = await readPublicUpdate(client, 'popup');
  assert.equal(Object.hasOwn(legacy.items[0]!.settings, 'homePopup'), false);
  assert.equal(Object.hasOwn(detail!.settings, 'homePopup'), false);
  assert.equal(popup.items[0]!.settings.homePopup, true);
});
