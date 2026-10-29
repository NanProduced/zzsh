import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareUpdateSettings, checkUpdateRelease, requireUpdatePromotionPermission } from '../src/content/updates';
import { ADMIN_PERMISSION, type EffectiveAdminAccess } from '../src/auth/admin-authorization';
import type { PoolClient } from 'pg';

test('global homepage promotion requires platform publication permission even for game-scoped news', () => {
  const access: EffectiveAdminAccess = { status: 'ACTIVE', isBoss: false, passwordChangeRequired: false, permissions: new Set([ADMIN_PERMISSION.contentPublish]) };
  assert.doesNotThrow(() => requireUpdatePromotionPermission(access, {}));
  assert.throws(() => requireUpdatePromotionPermission(access, { tickerEnabled: true }), error => (error as { status?: number }).status === 403);
  access.permissions.add(ADMIN_PERMISSION.contentPlatformPublish);
  assert.doesNotThrow(() => requireUpdatePromotionPermission(access, { tickerEnabled: true }));
});
test('update drafts retain unsupported text while the server derives references instead of trusting the supplied list', async () => {
  const body = '<div>未支持原文</div>\n\n![图][x]\n\n[x]: media://public_asset';
  const settings = await prepareUpdateSettings(body, { format: 'markdown', mediaIds: ['forged'] });
  assert.deepEqual(settings.mediaIds, ['public_asset']);
  assert.deepEqual((await prepareUpdateSettings(body, { format: 'plain', mediaIds: ['forged'] })).mediaIds, []);
});
test('only validated announcements can reserve one of the three active pin positions', async () => {
  const statements: string[] = [], client = { query: async (sql: string) => { statements.push(sql); return { rows: [{ count: '3' }] }; } } as unknown as PoolClient;
  const settings = { pinned: true, pinnedUntil: new Date(Date.now() + 3600_000).toISOString() };
  await assert.rejects(() => checkUpdateRelease(client, { id: 'new', type: 'NEWS' }, settings), /只有公告可置顶/);
  assert.equal(statements.length, 0);
  await assert.rejects(() => checkUpdateRelease(client, { id: 'new', type: 'ANNOUNCEMENT' }, settings), /最多同时置顶3条/);
  assert.ok(statements[0]!.includes('pg_advisory_xact_lock'));
});
