import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAX_MEDIA_BYTES, compressListingScreenshot, mediaUploadFailureHint } from '../src/lib/media-upload.ts';
import { uploadSupplyMedia } from '../src/lib/supply-client.ts';

test('normal business images pass the client mirror check', () => {
  assert.equal(mediaUploadFailureHint({ type: 'image/png', size: 2_885_976 }), null);
  assert.equal(mediaUploadFailureHint({ type: 'image/jpeg', size: MAX_MEDIA_BYTES }), null);
});

test('oversize images get an explicit size hint and stay removable', () => {
  const hint = mediaUploadFailureHint({ type: 'image/png', size: 14_547_995 });
  assert.match(hint, /13\.9 MiB/);
  assert.match(hint, /10 MiB/);
});

test('unsupported formats and empty files are rejected before upload', () => {
  assert.match(mediaUploadFailureHint({ type: 'image/gif', size: 1024 }), /PNG、JPEG 或 WebP/);
  assert.match(mediaUploadFailureHint({ type: '', size: 1024 }), /PNG、JPEG 或 WebP/);
  assert.match(mediaUploadFailureHint({ type: 'image/png', size: 0 }), /为空或无法读取/);
});

test('account screenshot compression preserves aspect ratio and requests WebP at 0.86', async t => {
  const old = { createImageBitmap: globalThis.createImageBitmap, document: globalThis.document };
  t.after(() => Object.assign(globalThis, old));
  let closed = false;
  globalThis.createImageBitmap = async () => ({ width: 2400, height: 1200, close() { closed = true; } });
  const canvas = {
    getContext() { return { drawImage: (_bitmap, _left, _top, width, height) => assert.deepEqual([width, height], [1920, 960]) }; },
    toBlob(resolve, mime, quality) {
      assert.equal(mime, 'image/webp'); assert.equal(quality, 0.86);
      resolve(new Blob(['compressed'], { type: mime }));
    },
  };
  globalThis.document = { createElement: () => canvas };
  const result = await compressListingScreenshot(new File(['input screenshot'], 'show.png', { type: 'image/png' }));
  assert.equal(result.type, 'image/webp');
  assert.equal(await result.text(), 'compressed');
  assert.equal(closed, true);
});

test('account direct upload posts actual file bytes to OSS and completes with only SHA-256 and its intent token', async t => {
  const before = globalThis.fetch;
  t.after(() => { globalThis.fetch = before; });
  const file = new File(['sample bytes'], 'evidence.png', { type: 'image/png' });
  const target = 'https://images.example.com/';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init]);
    if (calls.length === 1) return Response.json({ intentId: 'upload_sample', uploadToken: 'fixture-intent-token', transport: 'OSS_POST', ossUpload: { method: 'POST', url: target, fields: { key: 'private/account-upload/upload_sample', policy: 'fixture' } } });
    if (calls.length === 2) throw new TypeError('connection failed after upload');
    return Response.json({ assetId: 'asset_sample' });
  };
  let identityChecks = 0;
  const asset = await uploadSupplyMedia({ gameId: 'delta', accountId: 'account_1', purpose: 'ACCOUNT_EVIDENCE', file,
    intentKey: 'intent_key', uploadKey: 'upload_key', transport: 'OSS_POST', beforeBytesUpload: async () => { identityChecks++; return true; } });
  assert.deepEqual(calls.map(([url]) => url), ['/api/supply/media/upload-intents', target, '/api/supply/media/uploads/upload_sample/complete']);
  assert.deepEqual(JSON.parse(calls[0][1].body), { gameId: 'delta', accountId: 'account_1', purpose: 'ACCOUNT_EVIDENCE', mime: 'image/png', size: file.size, transport: 'OSS_POST' });
  assert.equal(calls[1][1].credentials, 'omit');
  assert.equal(calls[1][1].redirect, 'error');
  assert.equal(calls[1][1].headers, undefined);
  assert.deepEqual([...calls[1][1].body.keys()], ['key', 'policy', 'file']);
  assert.equal(await calls[1][1].body.get('file').text(), await file.text());
  assert.deepEqual(JSON.parse(calls[2][1].body), { uploadToken: 'fixture-intent-token', contentHash: createHash('sha256').update(await file.text()).digest('hex') });
  assert.equal(identityChecks, 2);
  assert.equal(asset.assetId, 'asset_sample');
});
