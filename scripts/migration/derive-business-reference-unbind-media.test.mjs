import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveBuffers } from './derive-business-reference-unbind-media.mjs';
const sha = x => createHash('sha256').update(x).digest('hex');
function fixture({ itemId = 'item_test', assetId = 'asset_test', itemCode = 'synthetic_catalog_item', duplicate = false, contentHash = '123', rowMediaId = assetId } = {}) {
  const row = JSON.stringify({ id: itemId, code: itemCode, media_id: rowMediaId }).replaceAll(':', ': ');
  const other = JSON.stringify({ id: 'other', code: 'other', media_id: 'future_asset' });
  const items = Buffer.from(JSON.stringify({ schema: 'zzsh_supply', table: 'billable_item', rows: duplicate ? [row, row, other] : [row, other] }));
  const assetRow = JSON.stringify({ id: assetId, content_hash: contentHash });
  const assets = Buffer.from(JSON.stringify({ schema: 'zzsh_supply', table: 'media_asset', rows: [assetRow] }));
  const m = { kind: 'BUSINESS_REFERENCE_PACKAGE_V1', sourceRawUnchanged: true, tables: [{ schema: 'zzsh_supply', table: 'billable_item', file: 'items.json', sha256: sha(items), rows: duplicate ? 3 : 2 }, { schema: 'zzsh_supply', table: 'media_asset', file: 'assets.json', sha256: sha(assets), rows: 1 }], media: [{ id: assetId, content_hash: contentHash }] };
  const manifest = Buffer.from(JSON.stringify(m, null, 2));
  const media = Buffer.from(JSON.stringify({ sourceManifestSha256: sha(manifest) }));
  return { manifest, items, assets, media, expected: { manifestSha256: sha(manifest), itemFileSha256: sha(items), itemRowSha256: sha(row), assetRowSha256: sha(assetRow), mediaObjectsSha256: sha(media), itemId, itemCode, assetId, assetContentSha256: contentHash } };
}
const run = x => deriveBuffers(x.manifest, x.items, x.assets, x.media, x.expected);
test('changes exactly the specified binding and retains other rows', () => {
  const x = fixture(), result = run(x), old = JSON.parse(x.items), current = JSON.parse(result.derivedItem), m = JSON.parse(result.derivedManifest);
  assert.equal(JSON.parse(current.rows[0]).media_id, null);
  assert.equal(current.rows[1], old.rows[1]);
  assert.equal(m.sourceRawUnchanged, false);
  assert.equal(m.tables[0].sha256, sha(result.derivedItem));
  assert.equal(m.tables[1].sha256, sha(x.assets));
  assert.equal(JSON.parse(x.items).rows[0], old.rows[0]);
  assert.equal(JSON.parse(x.media).sourceManifestSha256, sha(x.manifest));
});
test('refuses tampered manifest, table and media evidence', () => {
  for (const field of ['manifest', 'items', 'media']) {
    const x = fixture(); x[field] = Buffer.concat([x[field], Buffer.from(' ')]);
    assert.throws(() => run(x), /MISMATCH/);
  }
});
test('refuses changed item or asset identity and content', () => {
  for (const key of ['itemId', 'assetId', 'assetContentSha256', 'itemRowSha256', 'assetRowSha256']) {
    const x = fixture(); x.expected[key] = 'unexpected';
    assert.throws(() => run(x), /MISMATCH/);
  }
});
test('refuses duplicate target rows', () => assert.throws(() => run(fixture({ duplicate: true })), /ITEM_ROW_MISMATCH/));
test('refuses a new or absent catalogue image even with a matching source row digest', () => {
  for (const rowMediaId of ['future_asset', null]) assert.throws(() => run(fixture({ rowMediaId })), /TEST_BINDING_MISMATCH/);
});
test('refuses a modified asset table even when row reference remains', () => {
  const x = fixture(); x.assets = Buffer.concat([x.assets, Buffer.from(' ')]);
  assert.throws(() => run(x), /ASSET_DESCRIPTOR_MISMATCH/);
});
