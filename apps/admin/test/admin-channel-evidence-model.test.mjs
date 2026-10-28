import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelEvidenceErrorDisplay, channelEvidenceStatusDisplay, evidenceCents, sourceFamilyText } from '../src/views/admin-channel-evidence-model.ts';

test('channel evidence errors keep unauthorized, not-integrated, not-found and unknown distinct', () => {
  assert.deepEqual([403, 503, 404, 500, undefined].map(s => channelEvidenceErrorDisplay(s).kind), ['unauthorized', 'not-integrated', 'not-found', 'unknown', 'unknown']);
});
test('section status maps truncation and not-integrated before ready', () => {
  assert.equal(channelEvidenceStatusDisplay({ status: 'INTEGRATED', coverage: 'TRUNCATED' }).kind, 'truncated');
  assert.equal(channelEvidenceStatusDisplay({ status: 'FOUND', truncated: true }).kind, 'truncated');
  assert.equal(channelEvidenceStatusDisplay({ status: 'NOT_APPLICABLE' }).kind, 'not-integrated');
  assert.equal(channelEvidenceStatusDisplay({ status: 'FORBIDDEN' }).kind, 'unauthorized');
  assert.equal(channelEvidenceStatusDisplay({ status: 'UNAVAILABLE' }).kind, 'unknown');
  assert.equal(channelEvidenceStatusDisplay(null).kind, 'unknown');
  assert.equal(channelEvidenceStatusDisplay({ status: 'NOT_FOUND_LOCAL' }).kind, 'not-found');
  assert.equal(channelEvidenceStatusDisplay({ status: 'FUTURE_STATE' }).kind, 'unknown');
});
test('missing money is never zero-filled', () => {
  assert.equal(evidenceCents(null), null); assert.equal(evidenceCents(undefined), null); assert.equal(evidenceCents({ cents: null }), null);
  assert.equal(evidenceCents(0), null); assert.equal(evidenceCents({ cents: '0' }), '0'); assert.equal(evidenceCents('1200'), '1200');
});
test('source family labels legacy sources and keeps raw tags as trace only', () => {
  assert.equal(sourceFamilyText({ sourceType: 'WITHDRAWAL', sourceSystem: 'LEGACY_MYSQL', sourceEntity: 'cash' }), '旧平台迁移来源（原标识 WITHDRAWAL/LEGACY_MYSQL/cash）');
  assert.match(sourceFamilyText({ sourceType: 'WITHDRAWAL', sourceSystem: 'ZZSH', sourceEntity: 'intent' }), /^本平台来源/);
  assert.equal(sourceFamilyText(null), '未取得');
  assert.equal(sourceFamilyText({}), '未取得');
  assert.match(sourceFamilyText({ sourceType: 'FUTURE_SOURCE' }), /^来源未核定/);
});
